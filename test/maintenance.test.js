// Settings -> General -> Storage & cleanup, the backend half: the five targets, the bounded clean, the refusal
// rules, the READ-ONLY process census, and the two Hermes targets (whose CLI is stubbed, because a test must never
// prune a real 8 GB session store). Driven with temp directories and stubbed transport helpers; one test then
// boots a real sandbox panel to prove the mount and the two verb shapes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_OLDER_THAN_HOURS,
  MAX_OLDER_THAN_HOURS,
  clampOlderThanHours,
  cleanHermesCheckpoints,
  cleanHermesSessions,
  describeHermesSessions,
  parseCheckpointTotal,
  parsePrunePreview,
} from "../lib/hermes-maintenance.js";
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

// The contract's target list, in paint order: three the panel owns, then the two it prunes through the hermes CLI.
const ALL_TARGET_IDS = ["scratch", "state-temp", "log-archives", "hermes-sessions", "hermes-checkpoints"];

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

// ---- the two Hermes targets: stat-only GET, CLI-delegated clean ---------------------------------------------------
// Every test here stubs the CLI. The real one deletes real sessions; a test that ran it would be a data-loss bug,
// so the runner is the seam (exactly like `census`) and the canned output below is the format verified on this
// machine (hermes_cli/sessions_cmd.py prints the header, the rows, then `Dry run — nothing deleted.`).

async function hermesHomeWithStores(dir, { defaultBytes = [1000, 200], automationBytes = [60, 40] } = {}) {
  const home = path.join(dir, "hermes");
  const files = [
    [path.join(home, "state.db"), defaultBytes[0]],
    [path.join(home, "state.db-wal"), defaultBytes[1]],
    [path.join(home, "profiles", "intelligent-automation", "state.db"), automationBytes[0]],
    [path.join(home, "profiles", "intelligent-automation", "state.db-wal"), automationBytes[1]],
  ];
  for (const [file, bytes] of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "x".repeat(bytes), "utf8");
  }
  return home;
}

// One canned `sessions prune` table: the header is the authority (a non-dry-run prints at most 15 rows), so `rows`
// can be smaller than `header` on purpose.
function pruneTable({ header = 1, rows = header, note = "" } = {}) {
  const lines = [];
  if (note) lines.push(note);
  lines.push(
    `${header} session(s) match (last active before 2026-11-28 00:44; oldest activity 2026-10-30 11:54, newest activity 2026-11-26 13:26):`,
  );
  for (let i = 0; i < rows; i += 1) {
    lines.push(`  local-${String(i).padStart(4, "0")}  2026-11-2${i % 10} 01:04  api_server deepseek-v4.1-flash-1017    2 msgs  title ${i}`);
  }
  return lines.join("\n");
}

// A stub runner that records every argv and answers by subcommand. An unhandled call throws, so a test fails loudly
// rather than silently falling through to something real.
function cliStub(handlers) {
  const calls = [];
  const run = async ({ bin, args = [], timeoutMs } = {}) => {
    calls.push({ bin, args, timeoutMs });
    const key = args[0] === "checkpoints" ? `checkpoints ${args[1]}` : args.slice(0, 2).join(" ");
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected hermes call: ${args.join(" ")}`);
    return typeof handler === "function" ? handler({ bin, args, timeoutMs }) : handler;
  };
  run.calls = calls;
  return run;
}

const ok = (stdout) => ({ ok: true, code: 0, stdout, stderr: "" });

test("the session threshold defaults to 24h and clamps into 1..8760", () => {
  assert.equal(clampOlderThanHours(undefined), DEFAULT_OLDER_THAN_HOURS);
  assert.equal(clampOlderThanHours(""), DEFAULT_OLDER_THAN_HOURS);
  assert.equal(clampOlderThanHours("not a number"), DEFAULT_OLDER_THAN_HOURS);
  assert.equal(clampOlderThanHours(0), 1);
  assert.equal(clampOlderThanHours(-5), 1);
  assert.equal(clampOlderThanHours(2.6), 3);
  assert.equal(clampOlderThanHours("48"), 48);
  assert.equal(clampOlderThanHours(999_999), MAX_OLDER_THAN_HOURS);
});

test("the dry-run parser counts the header, cross-checks rows, and refuses to invent a number", () => {
  // Header == rows.
  assert.deepEqual(parsePrunePreview(pruneTable({ header: 3, rows: 3 })), { ok: true, count: 3 });
  // A truncated table (non-dry-run prints 15 rows then "... N more"): the header still says what matched.
  assert.equal(parsePrunePreview(pruneTable({ header: 40, rows: 15 })).count, 40);
  // Rows only, no header.
  assert.equal(parsePrunePreview(pruneTable({ header: 0, rows: 2 }).split("\n").slice(1).join("\n")).count, 2);
  // The zero answer.
  assert.equal(parsePrunePreview("No sessions match (last active before 2025-11-28 01:44).").count, 0);
  // Neither header nor rows: unparsable, with the CLI's last line as the sentence.
  const broken = parsePrunePreview("Traceback (most recent call last):\nboom: the store is unreadable");
  assert.equal(broken.ok, false);
  assert.match(broken.sentence, /boom: the store is unreadable/);
});

test("the checkpoint size parser reads hermes' own `Total size:` line and rejects anything else", () => {
  assert.equal(parseCheckpointTotal("Checkpoint base: C:\\x\nTotal size:      0 B\n  store/         0 B\n"), 0);
  assert.equal(parseCheckpointTotal("Total size:      7.9 GB"), Math.round(7.9 * 1024 ** 3));
  assert.equal(parseCheckpointTotal("Total size:      1.5 MB"), Math.round(1.5 * 1024 ** 2));
  assert.equal(parseCheckpointTotal("no size here"), null);
  assert.equal(parseCheckpointTotal(""), null);
});

test("hermes-sessions GET is a stat of the four store files, and blocked without a CLI", async (t) => {
  const dir = await sandbox(t);
  const home = await hermesHomeWithStores(dir);

  const live = describeHermesSessions({ home, bin: "C:/fake/hermes.exe" });
  assert.equal(live.id, "hermes-sessions");
  assert.equal(live.bytes, 1000 + 200 + 60 + 40);
  assert.equal(live.files, 4, "state.db + state.db-wal for BOTH profiles");
  assert.equal(live.removable, true);
  assert.equal(live.blockedReason, undefined);
  assert.match(live.detail, /sessions unused > 24h/);
  assert.match(live.detail, /pinned and archived sessions are kept/);
  assert.match(live.detail, /a prune is followed by VACUUM/);

  const blocked = describeHermesSessions({ home, bin: null });
  assert.equal(blocked.removable, false);
  assert.match(blocked.blockedReason, /hermes-sessions will not be cleaned: the hermes CLI was not found/);
  assert.equal(blocked.bytes, 1300, "the size is still measured when the CLI is missing");
});

test("hermes-sessions preview counts both profiles and never deletes", async (t) => {
  const dir = await sandbox(t);
  const home = await hermesHomeWithStores(dir);
  const runHermes = cliStub({
    "sessions prune": ({ args }) =>
      ok(args.includes("--profile") ? pruneTable({ header: 2, rows: 2 }) : pruneTable({ header: 3, rows: 3 })),
  });

  const out = await cleanHermesSessions({ home, bin: "C:/fake/hermes.exe", dryRun: true, runHermes, olderThanHours: 36 });
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.refused, undefined);
  assert.equal(out.removedFiles, 5, "3 default + 2 automation");
  assert.equal(out.removedBytes, 0, "a preview measures nothing, so it claims nothing about bytes");
  assert.equal(out.remaining, 5);
  assert.equal(runHermes.calls.length, 2, "one preview per profile");
  assert.ok(runHermes.calls.every((call) => call.args.includes("--dry-run")));
  assert.ok(runHermes.calls.every((call) => call.args.includes("--older-than") && call.args.includes("36h")));
  assert.deepEqual(runHermes.calls[0].args, ["sessions", "prune", "--older-than", "36h", "--dry-run"]);
  assert.deepEqual(runHermes.calls[1].args, [
    "sessions",
    "prune",
    "--older-than",
    "36h",
    "--dry-run",
    "--profile",
    "intelligent-automation",
  ]);
});

test("hermes-sessions and hermes-checkpoints refuse while a live run exists, before any CLI call", async () => {
  const runHermes = async () => {
    throw new Error("the CLI must not be reached while the board is busy");
  };
  const sessions = await cleanHermesSessions({
    dryRun: false,
    jobs: [{ id: "job-1", status: "running" }],
    bin: "C:/fake/hermes.exe",
    runHermes,
  });
  assert.equal(sessions.ok, true);
  assert.equal(
    sessions.refused,
    "1 live run is working — prune the session store when the board is idle",
  );
  assert.equal(sessions.removedFiles, 0);

  const checkpoints = await cleanHermesCheckpoints({
    dryRun: false,
    jobs: [
      { id: "job-1", status: "running" },
      { id: "job-2", status: "waiting" },
    ],
    bin: "C:/fake/hermes.exe",
    runHermes,
  });
  assert.equal(
    checkpoints.refused,
    "2 live runs are working — prune the checkpoint store when the board is idle",
  );
});

test("hermes-sessions clean prunes, VACUUMs, and reports the measured delta; pins are never included", async (t) => {
  const dir = await sandbox(t);
  const home = await hermesHomeWithStores(dir);
  const shrink = (file, bytes) => writeFile(file, "x".repeat(bytes), "utf8");
  const runHermes = cliStub({
    "sessions prune": async ({ args }) => {
      if (args.includes("--profile")) {
        await shrink(path.join(home, "profiles", "intelligent-automation", "state.db"), 20);
        return ok(pruneTable({ header: 2, rows: 2 }).replace("Dry run — nothing deleted.", "Pruned 2 session(s)."));
      }
      await shrink(path.join(home, "state.db"), 400);
      return ok(pruneTable({ header: 3, rows: 3 }).replace("Dry run — nothing deleted.", "Pruned 3 session(s)."));
    },
    "sessions optimize": async ({ args }) => {
      if (args.includes("--profile")) return ok("Optimized 1 FTS index(es).\nDatabase size: 0.1 MB -> 0.1 MB (-0.0 MB)");
      await shrink(path.join(home, "state.db"), 300);
      return ok("Optimized 2 FTS index(es).\nDatabase size: 0.4 MB -> 0.3 MB (-0.1 MB)");
    },
  });

  const out = await cleanHermesSessions({ home, bin: "C:/fake/hermes.exe", dryRun: false, runHermes });
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, false);
  assert.equal(out.refused, undefined);
  assert.equal(out.removedFiles, 5, "the CLI's own `Pruned N session(s).` lines");
  // default: (1000+200) -> (300+200); automation: (60+40) -> (20+40)
  assert.equal(out.removedBytes, 1200 - 500 + 100 - 60);
  assert.equal(out.remaining, 0);

  // Pins and archives are a reader's keep flag: the panel never opts into deleting them.
  for (const call of runHermes.calls) {
    assert.ok(!call.args.includes("--include-pinned"), `argv must never carry --include-pinned: ${call.args.join(" ")}`);
    assert.ok(!call.args.includes("--include-archived"), `argv must never carry --include-archived: ${call.args.join(" ")}`);
  }
  const prunes = runHermes.calls.filter((call) => call.args[1] === "prune");
  assert.equal(prunes.length, 2);
  assert.ok(prunes.every((call) => call.args.includes("--yes") && call.args.includes("24h")), "the default threshold");
  assert.ok(runHermes.calls.every((call) => call.timeoutMs > 0), "every CLI call carries a timeout");
  assert.equal(runHermes.calls.find((call) => call.args[1] === "optimize").args[0], "sessions");
});

test("hermes-sessions clean refuses with the CLI's sentence on a failed prune or unreadable table", async (t) => {
  const dir = await sandbox(t);
  const home = await hermesHomeWithStores(dir);

  const refusedByCli = cliStub({
    "sessions prune": {
      ok: false,
      code: 1,
      stdout: "Refusing `hermes sessions prune`: PID 4242 (hermes gateway) holds state.db — pass --force to rewrite it.",
      stderr: "",
    },
  });
  const refused = await cleanHermesSessions({ home, bin: "C:/fake/hermes.exe", dryRun: false, runHermes: refusedByCli });
  assert.equal(refused.ok, true, "a refusal is an answer, not an exception");
  assert.match(refused.refused, /PID 4242 \(hermes gateway\) holds state\.db/);
  assert.equal(refused.removedFiles, 0);
  assert.equal(refused.removedBytes, 0);

  const garbage = cliStub({ "sessions prune": ok("Traceback (most recent call last):\nboom: the store is unreadable") });
  const unreadable = await cleanHermesSessions({ home, bin: "C:/fake/hermes.exe", dryRun: true, runHermes: garbage });
  assert.match(unreadable.refused, /could not read the prune preview for the default store: boom: the store is unreadable/);
});

test("hermes-checkpoints preview claims nothing, and clean reports the status before/after delta", async (t) => {
  const dir = await sandbox(t);
  const home = await hermesHomeWithStores(dir);
  const base = path.join(home, "checkpoints");
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, "store.bin"), "x".repeat(64), "utf8");

  let statusCalls = 0;
  const runHermes = cliStub({
    "checkpoints status": () => {
      statusCalls += 1;
      return ok(`Checkpoint base: ${base}\nTotal size:      ${statusCalls === 1 ? "2.0 MB" : "1.5 MB"}\n  store/         2.0 MB\nProjects:        3\n`);
    },
    "checkpoints prune": ok(
      "Pruning checkpoint store…\n  retention_days:    7\n\nScanned:         4\nDeleted orphan:  0\nDeleted stale:   1\nErrors:          0\nBytes reclaimed: 512.0 KB\n",
    ),
  });

  const preview = await cleanHermesCheckpoints({ home, bin: "C:/fake/hermes.exe", dryRun: true, runHermes });
  assert.deepEqual(
    { dryRun: preview.dryRun, removedFiles: preview.removedFiles, removedBytes: preview.removedBytes, remaining: preview.remaining },
    { dryRun: true, removedFiles: 0, removedBytes: 0, remaining: 0 },
  );
  assert.equal(statusCalls, 0, "a preview does not run the CLI at all");

  const out = await cleanHermesCheckpoints({ home, bin: "C:/fake/hermes.exe", dryRun: false, runHermes });
  assert.equal(out.refused, undefined);
  assert.equal(out.removedBytes, Math.round(0.5 * 1024 ** 2), "the parsed status total, before minus after");
  assert.equal(out.removedFiles, 1, "Deleted stale: 1");
  const pruneCall = runHermes.calls.find((call) => call.args[1] === "prune");
  assert.deepEqual(pruneCall.args, ["checkpoints", "prune", "--keep-orphans"], "never prompt, never delete an orphan project");
});

test("hermes-checkpoints falls back to a directory walk when `checkpoints status` cannot be parsed", async (t) => {
  const dir = await sandbox(t);
  const home = await hermesHomeWithStores(dir);
  const base = path.join(home, "checkpoints");
  await mkdir(path.join(base, "store"), { recursive: true });
  await writeFile(path.join(base, "store", "blob"), "x".repeat(500), "utf8");
  const runHermes = cliStub({
    "checkpoints status": ok("something unexpected"),
    "checkpoints prune": ok("Deleted orphan: 0\nDeleted stale: 0\n"),
  });
  const before = await cleanHermesCheckpoints({ home, bin: "C:/fake/hermes.exe", dryRun: false, runHermes });
  assert.equal(before.refused, undefined);
  assert.equal(before.removedBytes, 0, "the walk measured the same 500 B before and after");
});

test("the route: the GET paints five targets and the two clean verbs answer the house shape", async (t) => {
  const dir = await sandbox(t);
  const home = await hermesHomeWithStores(dir);
  const config = { ...configOf(dir), token: "tok-test-alpha" };
  const runHermes = cliStub({
    "sessions prune": ok(pruneTable({ header: 4, rows: 4 })),
    "checkpoints prune": ok("Deleted orphan: 0\nDeleted stale: 2\n"),
    "checkpoints status": ok("Total size:      1.0 MB\n"),
  });
  const { call } = harness({ config, runHermes, hermes: { home, bin: "C:/fake/hermes.exe" } });

  const read = await call("GET", MAINTENANCE_PATH);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.targets.map((target) => target.id), ALL_TARGET_IDS);
  const sessions = read.body.targets.find((target) => target.id === "hermes-sessions");
  assert.equal(sessions.files, 4);
  assert.equal(sessions.removable, true);
  assert.equal(runHermes.calls.length, 0, "the GET never runs the CLI");

  const dry = await call("POST", MAINTENANCE_CLEAN_PATH, {
    token: "tok-test-alpha",
    body: { target: "hermes-sessions", dryRun: true, olderThanHours: 12 },
  });
  assert.equal(dry.status, 200);
  assert.deepEqual(Object.keys(dry.body).sort(), ["dryRun", "ms", "ok", "remaining", "removedBytes", "removedFiles", "target"]);
  assert.equal(dry.body.removedFiles, 8, "4 matched per profile");
  assert.ok(runHermes.calls.every((call_) => call_.args.includes("12h")), "the body's threshold reaches the CLI");

  const refused = await call("POST", MAINTENANCE_CLEAN_PATH, {
    token: "tok-test-alpha",
    body: { target: "hermes-checkpoints", dryRun: false },
  });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.ok, true);
  assert.equal(refused.body.removedFiles, 2);
});

test("the route: a Hermes clean refused by a live run answers 200 with the reason in `refused`", async (t) => {
  const dir = await sandbox(t);
  const home = await hermesHomeWithStores(dir);
  const config = { ...configOf(dir), token: "tok-test-alpha" };
  const runHermes = async () => {
    throw new Error("the CLI must not be reached while the board is busy");
  };
  const { call } = harness({
    config,
    jobs: [{ id: "job-9", status: "running" }],
    runHermes,
    hermes: { home, bin: "C:/fake/hermes.exe" },
  });

  const out = await call("POST", MAINTENANCE_CLEAN_PATH, {
    token: "tok-test-alpha",
    body: { target: "hermes-sessions", dryRun: false },
  });
  assert.equal(out.status, 200, "a refusal is an answer, not an error status");
  assert.equal(out.body.ok, true);
  assert.match(String(out.body.refused), /1 live run is working — prune the session store when the board is idle/);
  assert.equal(out.body.removedFiles, 0);
  assert.match(out.log.join("\n"), /refused:/);
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
const silentHermes = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });

function harness({
  config,
  jobs = [],
  registry = { projects: [] },
  census = async () => ({ sandboxPanels: [], testRunners: [], orphanPids: [] }),
  runHermes = silentHermes,
  hermes = { bin: null },
  now = () => Date.now(),
}) {
  const state = { body: {}, token: "tok-test-alpha", log: [] };
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
    now,
    runHermes,
    hermes,
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
  const config = { ...configOf(dir), scratchDir: path.join(dir, "scratch"), scratchDirSource: "config", token: "tok-test-alpha" };
  await writeFiles(config.scratchDir, ["x.txt"]);
  const { call } = harness({ config });

  const read = await call("GET", MAINTENANCE_PATH);
  assert.equal(read.handled, true);
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true);
  assert.deepEqual(read.body.targets.map((target) => target.id), ALL_TARGET_IDS);
  assert.deepEqual(read.body.processes, { sandboxPanels: [], testRunners: [], orphanPids: [] });

  const denied = await call("POST", MAINTENANCE_CLEAN_PATH, { body: { target: "scratch", dryRun: true } });
  assert.equal(denied.status, 403);

  const bogus = await call("POST", MAINTENANCE_CLEAN_PATH, { token: "tok-test-alpha", body: { target: "everything" } });
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
  const config = { ...configOf(dir), scratchDir: scratch, scratchDirSource: "config", token: "tok-test-alpha" };
  // A live run working inside the folder is the refusal a route test can produce without touching a real disk root.
  const { call } = harness({ config, jobs: [{ id: "job-7", status: "running", cwd: path.join(scratch, "job-7") }] });

  const refused = await call("POST", MAINTENANCE_CLEAN_PATH, { token: "tok-test-alpha", body: { target: "scratch", dryRun: false } });
  assert.equal(refused.status, 200, "a refusal is an answer, not an error status");
  assert.equal(refused.body.ok, true);
  assert.match(String(refused.body.refused), /scratch is in use: a live run is working/, "the reason travels in `refused`");
  assert.equal(refused.body.removedFiles, 0, "and nothing was removed");
  assert.ok((await readdir(scratch)).includes("held.txt"), "the held file is still there");
  assert.match(refused.log.join("\n"), /refused:/, "the log says what was refused too");
});

// The census is the slow half of the Settings read (a process-table walk), so it is memoised for its TTL while the
// file sizes are re-measured every time. Two reads inside the window share one walk; past it, the walk runs again.
test("the route: the census is memoised for its TTL, the file sizes are not", async (t) => {
  const dir = await sandbox(t);
  const config = { ...configOf(dir), scratchDir: path.join(dir, "scratch"), scratchDirSource: "config", token: "secret" };
  let clock = 1_000_000;
  let walks = 0;
  const census = async () => {
    walks += 1;
    return { sandboxPanels: [], testRunners: [], orphanPids: [] };
  };
  const { call } = harness({ config, census, now: () => clock });

  const first = await call("GET", MAINTENANCE_PATH);
  const second = await call("GET", MAINTENANCE_PATH);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(walks, 1, "two reads inside the TTL share one process-table walk");

  clock += 30_001;
  await call("GET", MAINTENANCE_PATH);
  assert.equal(walks, 2, "past the TTL the walk runs again");
});

test("the route: a clean dry run returns the contract shape and a real press deletes", async (t) => {
  const dir = await sandbox(t);
  const config = { ...configOf(dir), scratchDir: path.join(dir, "scratch"), scratchDirSource: "config", token: "tok-test-alpha" };
  await mkdir(config.scratchDir, { recursive: true });
  await writeFile(path.join(config.scratchDir, ".wag-scratch"), "", "utf8");
  await writeFiles(config.scratchDir, ["gone.txt"], { bytes: 6 });
  const { call } = harness({ config });

  const dry = await call("POST", MAINTENANCE_CLEAN_PATH, { token: "tok-test-alpha", body: { target: "scratch", dryRun: true } });
  assert.equal(dry.status, 200);
  assert.deepEqual(Object.keys(dry.body).sort(), ["dryRun", "ms", "ok", "remaining", "removedBytes", "removedFiles", "target"]);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.removedFiles, 1);
  assert.ok((await readdir(config.scratchDir)).includes("gone.txt"));

  const real = await call("POST", MAINTENANCE_CLEAN_PATH, { token: "tok-test-alpha", body: { target: "scratch", dryRun: false } });
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
  assert.deepEqual(body.targets.map((target) => target.id), ALL_TARGET_IDS);
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
