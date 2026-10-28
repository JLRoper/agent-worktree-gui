// The panel's two directories, and everything derived from them.
//
// This is the proof for the half of the change a diff cannot carry: which path WINS when a config, an environment
// and a default all say something different; that every state file the panel owns lands under the data directory
// and none of them lands in the checkout; that an existing install's `logs/` is COPIED once and never moved; and
// that emptying the scratch directory refuses while a live run is standing in it.
//
// The spawn prompt is here too, because the promise "every spawn states the scratch path" is only worth anything if
// it is read off the request the gateway actually receives — so the last case runs one against a stub Runs API and
// reads the body's `input`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanScratch,
  dirSize,
  ensureDirs,
  expandHome,
  humanBytes,
  insideDir,
  migrateState,
  resolveConfigPath,
  resolveDirs,
  scratchLine,
  sizeOf,
  statePaths,
  STATE_FILE_NAMES,
} from "../lib/paths.js";
import { Jobs } from "../lib/jobs.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wtgui-paths-"));

// ---- resolution ---------------------------------------------------------------------------------
test("both paths fall back to the OS defaults", () => {
  const home = path.join("C:", "Users", "someone");
  const scratchRoot = path.join("C:", "Users", "someone", "AppData", "Local", "Temp");
  const got = resolveDirs({ config: {}, env: {}, home, tmpdir: scratchRoot });
  assert.equal(got.dataDir, path.join(home, ".wag"));
  assert.equal(got.dataSource, "default");
  assert.equal(got.scratchDir, path.join(scratchRoot, "wag"));
  assert.equal(got.scratchSource, "default");
});

test("the environment overrides the default, and the config overrides the environment", () => {
  const home = path.join("C:", "Users", "someone");
  const scratchRoot = path.join(home, "Temp");
  const env = { WAG_HOME: "D:/panel-data", WAG_SCRATCH: "D:/panel-scratch" };

  const fromEnv = resolveDirs({ config: {}, env, home, tmpdir: scratchRoot });
  assert.deepEqual([fromEnv.dataDir, fromEnv.dataSource], [path.resolve("D:/panel-data"), "env"]);
  assert.deepEqual([fromEnv.scratchDir, fromEnv.scratchSource], [path.resolve("D:/panel-scratch"), "env"]);

  const fromConfig = resolveDirs({
    config: { dataDir: "E:/explicit-data", scratchDir: "E:/explicit-scratch" },
    env,
    home,
    tmpdir: scratchRoot,
  });
  assert.deepEqual([fromConfig.dataDir, fromConfig.dataSource], [path.resolve("E:/explicit-data"), "config"]);
  assert.deepEqual([fromConfig.scratchDir, fromConfig.scratchSource], [path.resolve("E:/explicit-scratch"), "config"]);
});

test("each path resolves on its own — a config naming one does not move the other", () => {
  const home = path.join("C:", "Users", "someone");
  const got = resolveDirs({ config: { dataDir: "D:/only-data" }, env: { WAG_SCRATCH: "D:/only-scratch" }, home, tmpdir: home });
  assert.deepEqual([got.dataDir, got.dataSource], [path.resolve("D:/only-data"), "config"]);
  assert.deepEqual([got.scratchDir, got.scratchSource], [path.resolve("D:/only-scratch"), "env"]);
});

test("a ~ path in the config or the environment is expanded, not resolved into a folder called ~", () => {
  const home = path.join(os.tmpdir(), "wtgui-fake-home");
  assert.equal(expandHome("~/wag", home), path.join(home, "wag"));
  assert.equal(expandHome("~", home), home);
  const got = resolveDirs({ config: {}, env: { WAG_HOME: "~/mine" }, home, tmpdir: home });
  assert.equal(got.dataDir, path.join(home, "mine"));
});

// ---- derivation ---------------------------------------------------------------------------------
test("every state file lands under the data directory", () => {
  const dataDir = path.join(os.tmpdir(), "wtgui-data-derivation");
  const p = statePaths({ dataDir });
  const stateDir = path.join(dataDir, "state");
  const expected = {
    jobsFile: "jobs.json",
    assistantFile: "assistant.json",
    charterFile: "assistant-charter.md",
    todosFile: "todos.json",
    treeNamesFile: "tree-names.json",
    descriptionsFile: "descriptions.json",
    labelsFile: "labels.json",
    modelPricingFile: "model-prices.json",
    pushGuardFile: "push-guard.json",
    restartFile: "restart.json",
    gatewayRestartLog: "gateway-restart.log",
    threadModelsFile: "thread-models.json",
    threadContextFile: "thread-context.json",
    projectsCacheFile: "projects.json",
  };
  for (const [key, name] of Object.entries(expected)) {
    assert.equal(p[key], path.join(stateDir, name), `${key} belongs in <dataDir>/state`);
  }
  assert.equal(p.attachmentsDir, path.join(dataDir, "attachments"));
  assert.equal(p.logsDir, path.join(dataDir, "logs"));
  // The list the migration copies and the files the panel resolves have to be the same list, or a state file is
  // silently left behind in the checkout by every install that upgrades.
  for (const name of Object.values(expected)) assert.ok(STATE_FILE_NAMES.includes(name), `${name} is on the migration list`);
});

test("no derived path is inside the checkout it was resolved from", () => {
  const dataDir = path.join(os.tmpdir(), "wtgui-not-in-checkout");
  const p = statePaths({ dataDir });
  for (const [key, value] of Object.entries(p)) {
    assert.ok(String(value).startsWith(dataDir), `${key} (${value}) starts with the data directory`);
  }
});

test("an explicit dataDir moves everything with it, and an explicit jobsFile keeps its siblings beside it", () => {
  const dataDir = path.join(os.tmpdir(), "wtgui-explicit-data");
  const p = statePaths({ dataDir, jobsFile: path.join(dataDir, "elsewhere", "store.json") });
  assert.equal(p.jobsFile, path.join(dataDir, "elsewhere", "store.json"));
  // The documented sandbox behaviour: a config that names one store keeps the rest of its state beside it.
  assert.equal(p.assistantFile, path.join(dataDir, "elsewhere", "assistant.json"));
  assert.equal(p.restartFile, path.join(dataDir, "elsewhere", "restart.json"));
  assert.equal(p.attachmentsDir, path.join(dataDir, "attachments"));
});

test("ensureDirs creates both directories and the folders inside the data one", () => {
  const root = tmp();
  try {
    const dataDir = path.join(root, "data");
    const scratchDir = path.join(root, "scratch");
    const out = ensureDirs({ dataDir, scratchDir });
    assert.deepEqual([out.dataDir, out.scratchDir], [dataDir, scratchDir]);
    for (const dir of [dataDir, scratchDir, path.join(dataDir, "state"), path.join(dataDir, "attachments"), path.join(dataDir, "logs")]) {
      assert.ok(existsSync(dir), `${dir} exists`);
    }
    // Idempotent: a second boot (or a second panel on one data directory) is a no-op, not an error.
    assert.deepEqual(ensureDirs({ dataDir, scratchDir }).made, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sizes are stat-only walks with a cache, and the label is the one the page shows", () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(path.join(root, "a.txt"), "12345");
    writeFileSync(path.join(root, "nested", "b.txt"), "123");
    assert.deepEqual(dirSize(root), { bytes: 8, files: 2, dirs: 1 });
    const first = sizeOf(root, { ttlMs: 60_000 });
    writeFileSync(path.join(root, "c.txt"), "1234567");
    assert.equal(sizeOf(root, { ttlMs: 60_000 }).bytes, 8, "inside the window the cached reading stands");
    assert.equal(sizeOf(root, { ttlMs: 60_000, fresh: true }).bytes, 15, "and `fresh` re-measures");
    assert.equal(first.files, 2);
    assert.deepEqual([humanBytes(0), humanBytes(999), humanBytes(1024), humanBytes(1536), humanBytes(5 * 1024 * 1024)], ["0 B", "999 B", "1 KB", "1.5 KB", "5 MB"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the config file's own two homes ------------------------------------------------------------
test("config.json is read from PANEL_CONFIG, else a moved copy in the data directory, else the checkout", () => {
  const root = tmp();
  try {
    const checkout = path.join(root, "checkout");
    const home = path.join(root, "home");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(home, { recursive: true });

    const plain = resolveConfigPath({ here: checkout, env: {}, home });
    assert.deepEqual([plain.path, plain.source], [path.join(checkout, "config.json"), "checkout"]);

    // An install that moved its file: the copy in <dataDir> is the one that boots.
    mkdirSync(path.join(home, ".wag"), { recursive: true });
    writeFileSync(path.join(home, ".wag", "config.json"), "{}");
    const moved = resolveConfigPath({ here: checkout, env: {}, home });
    assert.deepEqual([moved.path, moved.source], [path.join(home, ".wag", "config.json"), "dataDir"]);

    const pinned = resolveConfigPath({ here: checkout, env: { PANEL_CONFIG: path.join(root, "sandbox.json") }, home });
    assert.deepEqual([pinned.path, pinned.source], [path.join(root, "sandbox.json"), "PANEL_CONFIG"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the one-time migration ---------------------------------------------------------------------
test("an existing install's logs/ is COPIED into the data directory, journaled, and left where it was", () => {
  const root = tmp();
  try {
    const checkout = path.join(root, "checkout");
    const dataDir = path.join(root, "data");
    const legacy = path.join(checkout, "logs");
    mkdirSync(path.join(legacy, "attachments"), { recursive: true });
    writeFileSync(path.join(legacy, "jobs.json"), JSON.stringify({ jobs: [{ id: "old-1" }] }));
    writeFileSync(path.join(legacy, "todos.json"), JSON.stringify({ lists: {} }));
    writeFileSync(path.join(legacy, "tree-names.json"), "{}");
    writeFileSync(path.join(legacy, "attachments", "shot.png"), "PNG");

    const journal = [];
    const out = migrateState({ dataDir, legacyDir: legacy, onLog: (line) => journal.push(line) });

    assert.equal(out.migrated, true);
    assert.deepEqual(out.copied.sort(), ["attachments/", "jobs.json", "todos.json", "tree-names.json"]);
    assert.equal(readFileSync(path.join(dataDir, "state", "jobs.json"), "utf8"), JSON.stringify({ jobs: [{ id: "old-1" }] }));
    assert.equal(readFileSync(path.join(dataDir, "attachments", "shot.png"), "utf8"), "PNG");
    // Never moved, never deleted: the originals are all still there.
    for (const name of ["jobs.json", "todos.json", "tree-names.json", path.join("attachments", "shot.png")]) {
      assert.ok(existsSync(path.join(legacy, name)), `${name} is still in the checkout`);
    }
    // The journal line names the count and where it came from — that is what explains a board that comes up full.
    const line = journal.join("\n");
    assert.match(line, /state-migrated/);
    assert.match(line, /copied 4 file\(s\)/);
    assert.ok(line.includes(legacy) && line.includes(path.join(dataDir, "state")), line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the migration runs once: a data directory that already holds a store is never overwritten", () => {
  const root = tmp();
  try {
    const legacy = path.join(root, "checkout", "logs");
    const dataDir = path.join(root, "data");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "jobs.json"), "first");
    const first = migrateState({ dataDir, legacyDir: legacy });
    assert.equal(first.migrated, true);

    // Something wrote since (the panel itself, all day). A second boot must not put the old file back.
    writeFileSync(path.join(dataDir, "state", "jobs.json"), "second");
    writeFileSync(path.join(legacy, "jobs.json"), "changed in the checkout");
    const again = migrateState({ dataDir, legacyDir: legacy });
    assert.equal(again.migrated, false);
    assert.match(again.reason, /already holds a job store/);
    assert.equal(readFileSync(path.join(dataDir, "state", "jobs.json"), "utf8"), "second");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh install has nothing to migrate, and a store configured elsewhere is left alone", () => {
  const root = tmp();
  try {
    const empty = migrateState({ dataDir: path.join(root, "data"), legacyDir: path.join(root, "nothing-here") });
    assert.deepEqual([empty.migrated, empty.reason], [false, "no job store beside the checkout"]);

    const legacy = path.join(root, "checkout", "logs");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "jobs.json"), "{}");
    const elsewhere = migrateState({
      dataDir: path.join(root, "data"),
      stateFile: path.join(root, "sandbox", "jobs.json"),
      legacyDir: legacy,
    });
    assert.equal(elsewhere.migrated, false);
    assert.match(elsewhere.reason, /outside the data directory/);
    assert.equal(existsSync(path.join(root, "data", "state", "jobs.json")), false, "nothing was copied into a store this panel will not read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the scratch directory ----------------------------------------------------------------------
test("insideDir compares the way Windows does: separators, case and a trailing slash are not a difference", () => {
  const base = path.join("C:", "Temp", "wag");
  assert.equal(insideDir(path.join(base, "job-1", "a.txt"), base), true);
  assert.equal(insideDir(base, base), true);
  assert.equal(insideDir(`${base}${path.sep}`, base), true);
  assert.equal(insideDir(base.toUpperCase(), base), true);
  assert.equal(insideDir(path.join("C:", "Temp", "wag-other"), base), false, "a sibling whose name starts the same is not inside it");
  assert.equal(insideDir("", base), false);
});

test("cleaning the scratch directory frees the bytes and reports them", () => {
  const root = tmp();
  try {
    const scratch = path.join(root, "wag");
    mkdirSync(path.join(scratch, "job-1"), { recursive: true });
    writeFileSync(path.join(scratch, "job-1", "compare.diff"), "x".repeat(2048));
    writeFileSync(path.join(scratch, "notes.txt"), "1234");
    const out = cleanScratch({ scratchDir: scratch, jobs: [] });
    assert.equal(out.ok, true);
    assert.equal(out.freedBytes, 2052);
    assert.equal(out.removedFiles, 2);
    assert.equal(out.leftBehind, 0);
    assert.ok(existsSync(scratch), "the directory itself stays");
    assert.deepEqual(dirSize(scratch), { bytes: 0, files: 0, dirs: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live run standing in the scratch directory refuses the whole clean, and names the run", () => {
  const root = tmp();
  try {
    const scratch = path.join(root, "wag");
    mkdirSync(path.join(scratch, "job-7"), { recursive: true });
    writeFileSync(path.join(scratch, "job-7", "busy.diff"), "x".repeat(64));
    const jobs = [
      { id: "job-7", status: "running", cwd: path.join(scratch, "job-7") },
      { id: "job-6", status: "done", cwd: path.join(scratch, "job-6") },
      { id: "job-5", status: "running", cwd: path.join(root, "elsewhere") },
    ];
    const out = cleanScratch({ scratchDir: scratch, jobs });
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.match(out.error, /scratch is in use/);
    assert.match(out.error, /job-7/);
    assert.equal(out.holders.length, 1);
    assert.ok(existsSync(path.join(scratch, "job-7", "busy.diff")), "nothing was deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a finished run in the scratch directory does not hold it", () => {
  const root = tmp();
  try {
    const scratch = path.join(root, "wag");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, "old.txt"), "1234");
    const out = cleanScratch({ scratchDir: scratch, jobs: [{ id: "job-1", status: "done", cwd: path.join(scratch, "job-1") }] });
    assert.equal(out.ok, true);
    assert.equal(out.freedBytes, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scratch line names the tag folder and forbids the comparison worktree", () => {
  const line = scratchLine("C:\\Users\\x\\AppData\\Local\\Temp\\wag", "ab12cd34");
  assert.ok(line.includes("C:/Users/x/AppData/Local/Temp/wag/ab12cd34"), line);
  assert.match(line, /never create a git worktree to compare or export a branch/);
  assert.match(line, /git archive/);
  assert.match(line, /git show/);
  // No tag is still a usable line, and no scratch directory is no line at all (a panel that has none says nothing
  // rather than telling an agent to write to "undefined").
  assert.ok(scratchLine("D:/scratch", null).includes("D:/scratch —"));
  assert.equal(scratchLine(""), "");
});

// ---- the prompt the gateway actually receives ---------------------------------------------------
test("every spawn prompt states the scratch path, and the card still shows only what the reader wrote", async () => {
  const bodies = [];
  const stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = String(req.url || "");
      if (url === "/v1/runs" && req.method === "POST") {
        bodies.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: `stub-${bodies.length}`, status: "running" }));
        return;
      }
      // The run ends at once: a live card keeps a hard-cap timer of up to an hour and a 15 s poller, and a test
      // that leaves them armed makes the runner wait for timers nobody is watching. Settling it is also the honest
      // thing to assert — the prompt was read off a real run through the real lifecycle.
      if (/^\/v1\/runs\/[^/]+\/events$/.test(url)) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
        res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "compared", exit_code: 0 })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const root = tmp();
  try {
    const scratchDir = path.join(root, "wag");
    const work = path.join(root, "tree");
    mkdirSync(work, { recursive: true });
    // A run works in a git tree; `existing: true` is the spawn-in-a-tree path, so no worktree is cut for this one.
    execFileSync("git", ["-C", work, "init", "-q", "-b", "main"], { windowsHide: true });
    writeFileSync(path.join(work, "README.md"), "# probe\n");
    const jobs = new Jobs({
      config: {
        jobsFile: path.join(root, "state", "jobs.json"),
        scratchDir,
        apiServer: { url: `http://127.0.0.1:${stub.address().port}` },
      },
      onEvent: () => {},
      onLog: () => {},
    });
    const summary = await jobs.create({ prompt: "compare the two branches", cwd: work, existing: true, ownerPath: work });
    assert.equal(bodies.length, 1);
    const input = String(bodies[0].input || "");
    assert.ok(input.includes("compare the two branches"), `the reader's own words are in the input: ${input.slice(0, 200)}`);
    assert.ok(input.includes(`SCRATCH: put any throwaway or comparison files under ${scratchDir.replace(/\\/g, "/")}/${summary.id} —`), input);
    assert.match(input, /never create a git worktree to compare or export a branch/);
    // The card keeps the reader's brief: the scratch line and the cwd sentence ride in the input only.
    assert.equal(summary.prompt, "compare the two branches");
    // …and the run settles, which is what clears the card's own timers.
    for (let i = 0; i < 80 && ["running", "starting"].includes(String(jobs.jobs.get(summary.id)?.status)); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(jobs.jobs.get(summary.id)?.status, "done");
  } finally {
    // The POST keeps a pooled connection open, and a keep-alive socket outlives `close()` — the runner would then
    // wait for a test that has already finished.
    await new Promise((r) => {
      stub.closeAllConnections?.();
      stub.close(r);
    });
    rmSync(root, { recursive: true, force: true });
  }
});
