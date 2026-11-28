// Settings -> General -> Storage & cleanup, the backend half: the three targets, the bounded clean, the refusal
// rules, and the READ-ONLY process census. Driven with temp directories and stubbed transport helpers; one test then
// boots a real sandbox panel to prove the mount and the two verb shapes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOG_ARCHIVES_KEEP,
  STATE_TEMP_MIN_AGE_MS,
  cleanMaintenanceTarget,
  defaultScratchDir,
  isDefaultScratchDir,
  readMaintenanceTargets,
} from "../lib/maintenance.js";
import { censusFromRows, isTestRunnerCommandLine } from "../lib/process-census.js";
import { MAINTENANCE_CLEAN_PATH, MAINTENANCE_PATH, createMaintenanceRoutes } from "../routes/maintenance.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

async function sandbox(t, prefix = "wtgui-maint-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(dir, names, { bytes = 4, mtime = null } = {}) {
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "x".repeat(bytes), "utf8");
    if (mtime) await utimes(file, mtime, mtime);
  }
}

const configOf = (dir) => ({
  dataDir: path.join(dir, "data"),
  dataLayout: "split",
  jobsFile: path.join(dir, "data", "state", "jobs.json"),
  logsDir: path.join(dir, "data", "logs"),
  stateDir: path.join(dir, "data", "state"),
  attachmentsDir: path.join(dir, "data", "attachments"),
});

// ---- the marker gap ------------------------------------------------------------------------------------------------
test("the panel's DEFAULT scratch folder is recognised without a marker; another unmarked folder is not", () => {
  const defaultDir = defaultScratchDir({ tmpdir: "C:/tmp" });
  assert.equal(isDefaultScratchDir({ config: { scratchDir: defaultDir }, tmpdir: "C:/tmp" }), true);
  assert.equal(isDefaultScratchDir({ config: { scratchDir: defaultDir, scratchDirSource: "default" } }), true);
  assert.equal(isDefaultScratchDir({ config: { scratchDir: defaultDir.replace(/\\/g, "/").toUpperCase() }, tmpdir: "C:/tmp" }), true);
  assert.equal(isDefaultScratchDir({ config: { scratchDir: "C:/somewhere/else" }, tmpdir: "C:/tmp" }), false);
  assert.equal(isDefaultScratchDir({ config: {} }), false);
});

test("the scratch target is removable only when the folder is the panel's own", async (t) => {
  const dir = await sandbox(t);
  const tmp = path.join(dir, "tmp");
  const defaultScratch = defaultScratchDir({ tmpdir: tmp });
  await writeFiles(defaultScratch, ["a.txt"]);

  const okTargets = await readMaintenanceTargets({
    config: { ...configOf(dir), scratchDir: defaultScratch, scratchDirSource: "default" },
    now: Date.now(),
    tmpdir: tmp,
  });
  const scratch = okTargets.find((target) => target.id === "scratch");
  assert.equal(scratch.removable, true, "the default scratch folder needs no marker");
  assert.equal(scratch.blockedReason, undefined);
  assert.ok(scratch.bytes >= 4);

  const other = path.join(dir, "somebody-elses-folder");
  await writeFiles(other, ["b.txt"]);
  const targets = await readMaintenanceTargets({
    config: { ...configOf(dir), scratchDir: other },
    now: Date.now(),
    tmpdir: tmp,
  });
  const blocked = targets.find((target) => target.id === "scratch");
  assert.equal(blocked.removable, false);
  assert.match(blocked.blockedReason, /was not made by the panel \(no \.wag-scratch file inside it\)/);
});

// ---- the bounded scratch clean -------------------------------------------------------------------------------------
test("one scratch press removes at most the entry cap and reports how many remain", async (t) => {
  const dir = await sandbox(t);
  const scratch = path.join(dir, "scratch");
  const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
  await writeFiles(scratch, names);

  const config = { ...configOf(dir), scratchDir: scratch, scratchDirSource: "config" };
  // An explicit marker means this folder is the panel's own even though it is not the default path.
  await writeFile(path.join(scratch, ".wag-scratch"), "", "utf8");

  const first = await cleanMaintenanceTarget({ target: "scratch", config, dryRun: false, limits: { maxEntries: 25 } });
  assert.equal(first.ok, true);
  assert.equal(first.removedFiles, 25);
  assert.equal(first.remaining, 15);
  const left = (await readdir(scratch)).filter((n) => n !== ".wag-scratch");
  assert.equal(left.length, 15);

  const second = await cleanMaintenanceTarget({ target: "scratch", config, dryRun: false, limits: { maxEntries: 25 } });
  assert.equal(second.removedFiles, 15);
  assert.equal(second.remaining, 0);
  assert.deepEqual((await readdir(scratch)).filter((n) => n !== ".wag-scratch"), []);
});

test("a scratch dry run reports the would-remove numbers and deletes nothing", async (t) => {
  const dir = await sandbox(t);
  const scratch = path.join(dir, "scratch");
  await writeFiles(scratch, ["one.txt", "two/three.txt"], { bytes: 5 });
  await writeFile(path.join(scratch, ".wag-scratch"), "", "utf8");
  const config = { ...configOf(dir), scratchDir: scratch };

  const out = await cleanMaintenanceTarget({ target: "scratch", config, dryRun: true });
  assert.equal(out.dryRun, true);
  assert.equal(out.removedFiles, 2);
  assert.equal(out.removedBytes, 10);
  assert.equal(out.remaining, 0);
  assert.ok((await readdir(scratch)).includes("one.txt"), "a dry run leaves the files in place");
});

test("a live run holding the scratch folder is a refusal, not a deletion", async (t) => {
  const dir = await sandbox(t);
  const scratch = path.join(dir, "scratch");
  await writeFiles(scratch, ["held.txt"]);
  await writeFile(path.join(scratch, ".wag-scratch"), "", "utf8");
  const config = { ...configOf(dir), scratchDir: scratch };

  const out = await cleanMaintenanceTarget({
    target: "scratch",
    config,
    jobs: [{ id: "job-7", status: "running", cwd: path.join(scratch, "job-7") }],
    dryRun: false,
  });
  assert.match(out.refused, /scratch is in use: a live run is working/);
  assert.equal(out.removedFiles, 0);
  assert.ok((await readdir(scratch)).includes("held.txt"));
});

// ---- the job-store temp files -------------------------------------------------------------------------------------
test("state-temp removes only abandoned atomic-write leftovers, older than an hour", async (t) => {
  const dir = await sandbox(t);
  const config = configOf(dir);
  const store = config.stateDir;
  const old = new Date(Date.now() - STATE_TEMP_MIN_AGE_MS - 60_000);
  await writeFiles(store, ["jobs.json.1234-1.tmp", "jobs.json.1234-2.tmp", "jobs.json"], { bytes: 7 });
  await utimes(path.join(store, "jobs.json.1234-1.tmp"), old, old);
  // jobs.json.1234-2.tmp keeps "now": an in-flight write.

  const targets = await readMaintenanceTargets({ config, now: Date.now() });
  const temp = targets.find((target) => target.id === "state-temp");
  assert.equal(temp.files, 1);
  assert.equal(temp.bytes, 7);
  assert.equal(temp.removable, true);

  const out = await cleanMaintenanceTarget({ target: "state-temp", config, dryRun: false });
  assert.equal(out.removedFiles, 1);
  assert.equal(out.remaining, 1, "the fresh temp file is left for the writer that owns it");
  const left = await readdir(store);
  assert.ok(!left.includes("jobs.json.1234-1.tmp"));
  assert.ok(left.includes("jobs.json.1234-2.tmp"));
  assert.ok(left.includes("jobs.json"), "the store itself is never a candidate");
});

test("state-temp's dry run counts the same set and unlinks nothing", async (t) => {
  const dir = await sandbox(t);
  const config = configOf(dir);
  const old = new Date(Date.now() - STATE_TEMP_MIN_AGE_MS - 60_000);
  await writeFiles(config.stateDir, ["jobs.json.9-1.tmp"], { bytes: 3 });
  await utimes(path.join(config.stateDir, "jobs.json.9-1.tmp"), old, old);
  const out = await cleanMaintenanceTarget({ target: "state-temp", config, dryRun: true });
  assert.equal(out.removedFiles, 1);
  assert.equal(out.removedBytes, 3);
  assert.ok((await readdir(config.stateDir)).includes("jobs.json.9-1.tmp"));
});

// ---- the rotated logs ----------------------------------------------------------------------------------------------
test("log-archives keeps the newest twenty and removes older archives; the live log is never touched", async (t) => {
  const dir = await sandbox(t);
  const config = configOf(dir);
  const names = Array.from({ length: LOG_ARCHIVES_KEEP + 5 }, (_, i) => `server.out.log.2026010${i}T000000000Z-abcdef0${i}`);
  await writeFiles(config.logsDir, [...names, "server.out.log", "server.err.log.20260101T000000000Z-aaaaaaaa"]);
  // Distinct, increasing mtimes so "newest 20" is unambiguous.
  const base = Date.now() - 100 * 60 * 60 * 1000;
  for (let i = 0; i < names.length; i += 1) {
    const at = new Date(base + i * 60 * 60 * 1000);
    await utimes(path.join(config.logsDir, names[i]), at, at);
  }

  const targets = await readMaintenanceTargets({ config, now: Date.now() });
  const logs = targets.find((target) => target.id === "log-archives");
  assert.equal(logs.files, 5);
  assert.equal(logs.bytes, 20);

  const out = await cleanMaintenanceTarget({ target: "log-archives", config, dryRun: false });
  assert.equal(out.removedFiles, 5);
  assert.equal(out.remaining, LOG_ARCHIVES_KEEP);
  const left = await readdir(config.logsDir);
  assert.equal(left.filter((n) => /^server\.out\.log\./.test(n)).length, LOG_ARCHIVES_KEEP);
  assert.ok(left.includes("server.out.log"), "the live log is never an archive");
  assert.ok(left.includes("server.err.log.20260101T000000000Z-aaaaaaaa"), "err rotation is out of scope");
});

// ---- the process census: pure classifier --------------------------------------------------------------------------
test("the census classifies panels and test runners from a snapshot and never returns a pid to kill", () => {
  const now = Date.parse("2026-11-28T12:00:00Z");
  const created = "2026-11-28T11:59:30Z";
  const rows = [
    { pid: 10, ppid: 1, name: "explorer.exe", created: null, cpuSeconds: 0, commandLine: "" },
    { pid: 20, ppid: 10, name: "node.exe", created, cpuSeconds: 1.5, commandLine: '"C:/node/node.exe" server.js' },
    { pid: 21, ppid: 999, name: "node.exe", created, cpuSeconds: 2, commandLine: '"C:/node/node.exe" server.js' },
    { pid: 30, ppid: 10, name: "node.exe", created, cpuSeconds: 3, commandLine: "node --test test/maintenance.test.js" },
    { pid: 31, ppid: 30, name: "node.exe", created, cpuSeconds: 4, commandLine: "node C:/repo/test/other.test.js" },
    { pid: 40, ppid: 10, name: "node.exe", created, cpuSeconds: 5, commandLine: "node tools/build.js --test-reporter" },
    { pid: 50, ppid: 10, name: "node.exe", created, cpuSeconds: 6, commandLine: "node server.js" },
  ];
  const out = censusFromRows(rows, { ownPid: 50, now });
  assert.deepEqual(out.sandboxPanels.map((p) => p.pid), [20, 21], "own pid and test runners are excluded");
  assert.equal(out.sandboxPanels[0].parentAlive, true);
  assert.equal(out.sandboxPanels[1].parentAlive, false);
  assert.equal(out.sandboxPanels[0].startedAt, new Date(created).toISOString());
  assert.equal(out.sandboxPanels[0].ageSeconds, 30);
  assert.equal(out.sandboxPanels[0].cpuSeconds, 1.5);
  assert.deepEqual(out.testRunners.map((p) => p.pid), [30, 31, 40]);
  assert.equal(out.testRunners[0].parentAlive, undefined, "test runners carry no parentAlive in the contract");
  assert.deepEqual(out.orphanPids, [21]);
  assert.equal(typeof out.orphanPids[0], "number", "an orphan is a fact to read, never a command");
});

test("the runner detector does not mistake a flag that merely starts with --test", () => {
  assert.equal(isTestRunnerCommandLine("node server.js --test-mode"), false);
  assert.equal(isTestRunnerCommandLine("node --test-only x.js"), false);
  assert.equal(isTestRunnerCommandLine("node --test"), true);
  assert.equal(isTestRunnerCommandLine("node test/settings.test.js"), true);
});

// ---- the route module, driven with stubs --------------------------------------------------------------------------
function harness({ config, jobs = [], registry = { projects: [] }, census = async () => ({ sandboxPanels: [], testRunners: [], orphanPids: [] }) }) {
  const state = { body: {}, token: "secret", log: [] };
  const handles = createMaintenanceRoutes({
    getConfig: () => config,
    jobs: { list: () => jobs },
    registry,
    here: "C:/checkout",
    configDir: "C:/checkout",
    sendJson: (res, status, body) => {
      res.status = status;
      res.body = body;
    },
    readBody: async () => state.body,
    authorised: (req, token) => req.headers?.["x-panel-token"] === token,
    log: (line) => state.log.push(line),
    census,
    now: () => Date.now(),
  });
  const call = async (method, route, { body = {}, token = null } = {}) => {
    state.body = body;
    const req = { method, url: route, headers: token ? { "x-panel-token": token } : {} };
    const res = {};
    const handled = await handles(req, res, route, new URL(route, "http://127.0.0.1"));
    return { handled, status: res.status, body: res.body, log: state.log };
  };
  return { call };
}

test("the route: GET answers without a token, POST needs one, and an unknown target is a 400", async (t) => {
  const dir = await sandbox(t);
  const config = { ...configOf(dir), scratchDir: path.join(dir, "scratch"), scratchDirSource: "config", token: "secret" };
  await writeFiles(config.scratchDir, ["x.txt"]);
  const { call } = harness({ config });

  const read = await call("GET", MAINTENANCE_PATH);
  assert.equal(read.handled, true);
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true);
  assert.deepEqual(read.body.targets.map((target) => target.id), ["scratch", "state-temp", "log-archives"]);
  assert.deepEqual(read.body.processes, { sandboxPanels: [], testRunners: [], orphanPids: [] });

  const denied = await call("POST", MAINTENANCE_CLEAN_PATH, { body: { target: "scratch", dryRun: true } });
  assert.equal(denied.status, 403);

  const bogus = await call("POST", MAINTENANCE_CLEAN_PATH, { token: "secret", body: { target: "everything" } });
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /target must be one of: scratch, state-temp, log-archives/);

  const fallthrough = await call("PUT", MAINTENANCE_PATH);
  assert.equal(fallthrough.handled, false, "an unanswered method falls through to the chain's own 404");
});

// The contract mismatch this batch reconciled, pinned: a refusal is ANSWERED — 200, ok:true, the reason in
// `refused` — because the General tab paints that sentence in red (maintenanceResultText); a bare non-2xx made it
// show a status code instead. Nothing was deleted, and the body says so.
test("the route: a refused clean answers 200 with the reason in `refused`, never a bare status", async (t) => {
  const dir = await sandbox(t);
  const scratch = path.join(dir, "scratch");
  await writeFiles(scratch, ["held.txt"]);
  await writeFile(path.join(scratch, ".wag-scratch"), "", "utf8");
  const config = { ...configOf(dir), scratchDir: scratch, scratchDirSource: "config", token: "secret" };
  // A live run working inside the folder is the refusal a route test can produce without touching a real disk root.
  const { call } = harness({ config, jobs: [{ id: "job-7", status: "running", cwd: path.join(scratch, "job-7") }] });

  const refused = await call("POST", MAINTENANCE_CLEAN_PATH, { token: "secret", body: { target: "scratch", dryRun: false } });
  assert.equal(refused.status, 200, "a refusal is an answer, not an error status");
  assert.equal(refused.body.ok, true);
  assert.match(String(refused.body.refused), /scratch is in use: a live run is working/, "the reason travels in `refused`");
  assert.equal(refused.body.removedFiles, 0, "and nothing was removed");
  assert.ok((await readdir(scratch)).includes("held.txt"), "the held file is still there");
  assert.match(refused.log.join("\n"), /refused:/, "the log says what was refused too");
});

test("the route: a clean dry run returns the contract shape and a real press deletes", async (t) => {
  const dir = await sandbox(t);
  const config = { ...configOf(dir), scratchDir: path.join(dir, "scratch"), scratchDirSource: "config", token: "secret" };
  await mkdir(config.scratchDir, { recursive: true });
  await writeFile(path.join(config.scratchDir, ".wag-scratch"), "", "utf8");
  await writeFiles(config.scratchDir, ["gone.txt"], { bytes: 6 });
  const { call } = harness({ config });

  const dry = await call("POST", MAINTENANCE_CLEAN_PATH, { token: "secret", body: { target: "scratch", dryRun: true } });
  assert.equal(dry.status, 200);
  assert.deepEqual(Object.keys(dry.body).sort(), ["dryRun", "ms", "ok", "remaining", "removedBytes", "removedFiles", "target"]);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.removedFiles, 1);
  assert.ok((await readdir(config.scratchDir)).includes("gone.txt"));

  const real = await call("POST", MAINTENANCE_CLEAN_PATH, { token: "secret", body: { target: "scratch", dryRun: false } });
  assert.equal(real.status, 200);
  assert.equal(real.body.dryRun, false);
  assert.equal(real.body.removedFiles, 1);
  assert.ok(!(await readdir(config.scratchDir)).includes("gone.txt"));
  assert.match(real.log.at(-1), /maintenance: clean scratch/);
});

// ---- a real sandbox panel: the mount and both verbs ----------------------------------------------------------------
test("a booted panel serves GET /api/maintenance and the token-protected clean", async (t) => {
  const panel = await startPanel({ token: "maint-token" });
  t.after(() => panel.stop());

  const read = await fetch(`${panel.base}${MAINTENANCE_PATH}`);
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.targets.map((target) => target.id), ["scratch", "state-temp", "log-archives"]);
  assert.ok(body.processes && Array.isArray(body.processes.sandboxPanels));
  assert.ok(Array.isArray(body.processes.testRunners));
  assert.ok(Array.isArray(body.processes.orphanPids));

  // A loopback request is the panel's own page, so `authorised` admits it by design (lib/http/transport.js); the 403
  // for a caller without the token is pinned by the stub-driven route test above, where the transport is ours.
  const cleaned = await post(panel.base, MAINTENANCE_CLEAN_PATH, { token: "maint-token", body: { target: "log-archives", dryRun: true } });
  assert.equal(cleaned.status, 200, cleaned.text);
  assert.equal(cleaned.json.target, "log-archives");
  assert.equal(cleaned.json.dryRun, true);
});
