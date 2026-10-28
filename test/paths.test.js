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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanScratch,
  dirSize,
  ensureDirs,
  expandHome,
  humanBytes,
  insideDir,
  LIVE_STATUSES,
  markScratch,
  measureSize,
  migrateState,
  MIGRATION_JOURNAL,
  readMigrationJournal,
  resolveConfigPath,
  resolveDirs,
  resolveLayout,
  SCRATCH_MARKER,
  scratchLine,
  scratchProblem,
  sizeOf,
  statePaths,
  STATE_DIR_NAMES,
  STATE_FILE_NAMES,
  walkSize,
} from "../lib/paths.js";
import { Jobs, LIVE_JOB_STATUS } from "../lib/jobs.js";

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

// ---- a second instance must never resolve to the reader's board -----------------------------------
// This is the regression the first version of this change carried: 31 verify tools and every startPanel() test run a
// PANEL_CONFIG instance that names only its own store, and with the plain precedence they all resolved to ~/.wag —
// the live job store, the live naming ledger, the live log folder.
test("a PANEL_CONFIG instance with no dataDir keeps its own folder, flat, and ignores WAG_HOME and WAG_SCRATCH", () => {
  const home = path.join(os.tmpdir(), "wtgui-fake-home");
  const cfgDir = path.join(os.tmpdir(), "wtgui-sandbox-config");
  const env = { WAG_HOME: "D:/the-readers-board", WAG_SCRATCH: "D:/the-readers-scratch" };
  const got = resolveDirs({ config: {}, env, home, tmpdir: home, configSource: "PANEL_CONFIG", configDir: cfgDir });
  assert.equal(got.dataDir, path.join(cfgDir, "logs"), "where every sandbox has always kept its files");
  assert.equal(got.dataSource, "PANEL_CONFIG");
  assert.equal(got.dataLayout, "flat");
  assert.equal(got.scratchDir, path.join(cfgDir, "logs", "scratch"), "and its throwaway folder is its own, not <tmp>/wag shared with the live panel");
  assert.equal(got.scratchSource, "PANEL_CONFIG");

  const p = statePaths({ dataDir: got.dataDir, dataLayout: got.dataLayout });
  assert.equal(p.jobsFile, path.join(cfgDir, "logs", "jobs.json"), "no state/ folder inside the flat layout");
  assert.equal(p.todosFile, path.join(cfgDir, "logs", "todos.json"));
  assert.equal(p.logsDir, path.join(cfgDir, "logs"));
  assert.equal(p.attachmentsDir, path.join(cfgDir, "logs", "attachments"), "the same place the old code put pasted files");
});

test("naming dataDir in the config is how a second instance opts into the new layout", () => {
  const cfgDir = path.join(os.tmpdir(), "wtgui-sandbox-config");
  const got = resolveDirs({ config: { dataDir: "E:/own-data" }, env: { WAG_HOME: "D:/ignored" }, home: cfgDir, tmpdir: cfgDir, configSource: "PANEL_CONFIG", configDir: cfgDir });
  assert.deepEqual([got.dataDir, got.dataSource, got.dataLayout], [path.resolve("E:/own-data"), "config", "split"]);
  // Its scratch folder is still its own: a second instance never shares <tmp>/wag with the one the reader is using.
  assert.equal(got.scratchDir, path.join(path.resolve("E:/own-data"), "scratch"));
});

test("the default install is unchanged by all of that: no PANEL_CONFIG, the environment and then the defaults apply", () => {
  const home = path.join(os.tmpdir(), "wtgui-fake-home");
  const checkout = resolveDirs({ config: {}, env: { WAG_HOME: "D:/data" }, home, tmpdir: home, configSource: "checkout", configDir: path.join(home, "repo") });
  assert.deepEqual([checkout.dataDir, checkout.dataSource, checkout.dataLayout], [path.resolve("D:/data"), "env", "split"]);
  const plain = resolveDirs({ config: {}, env: {}, home, tmpdir: home, configSource: "checkout", configDir: path.join(home, "repo") });
  assert.deepEqual([plain.dataDir, plain.dataSource], [path.join(home, ".wag"), "default"]);
});

test("resolveLayout answers what a booted server will, from the config file alone (this is what the .cmd scripts ask)", () => {
  const root = tmp();
  try {
    const checkout = path.join(root, "checkout");
    const home = path.join(root, "home");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(home, { recursive: true });
    // No config at all: the defaults.
    const bare = resolveLayout({ here: checkout, env: {}, home, tmpdir: root });
    assert.equal(bare.paths.logsDir, path.join(home, ".wag", "logs"));
    assert.equal(bare.configFile.source, "checkout");
    // A dataDir written in config.json wins over the environment — the case a launcher script cannot see from %WAG_HOME%.
    writeFileSync(path.join(checkout, "config.json"), JSON.stringify({ dataDir: path.join(root, "elsewhere") }));
    const named = resolveLayout({ here: checkout, env: { WAG_HOME: path.join(root, "ignored") }, home, tmpdir: root });
    assert.equal(named.paths.logsDir, path.join(root, "elsewhere", "logs"));
    assert.equal(named.dirs.dataSource, "config");
    // A BOM and a PANEL_CONFIG instance both resolve the way the server does.
    const sandbox = path.join(root, "sandbox");
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(path.join(sandbox, "config.json"), `\uFEFF${JSON.stringify({ port: 1 })}`);
    const second = resolveLayout({ here: checkout, env: { PANEL_CONFIG: path.join(sandbox, "config.json"), WAG_HOME: path.join(root, "ignored") }, home, tmpdir: root });
    assert.equal(second.paths.logsDir, path.join(sandbox, "logs"));
    assert.equal(second.dirs.dataLayout, "flat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    // The records main added while this module was waiting to land.
    locksFile: "locks.json",
    parentsFile: "parents.json",
    branchParentsFile: "branch-parents.json",
    hostsFile: "hosts.json",
    stewardQuestionsFile: "steward-questions.json",
  };
  for (const [key, name] of Object.entries(expected)) {
    assert.equal(p[key], path.join(stateDir, name), `${key} belongs in <dataDir>/state`);
  }
  assert.equal(p.stewardDir, stateDir, "the steward's plans/ folder sits beside the store, as it did beside logs/jobs.json");
  assert.equal(p.attachmentsDir, path.join(dataDir, "attachments"));
  assert.equal(p.logsDir, path.join(dataDir, "logs"));
  // The list the migration copies and the files the panel resolves have to be the same list, or a state file is
  // silently left behind in the checkout by every install that upgrades.
  for (const name of Object.values(expected)) assert.ok(STATE_FILE_NAMES.includes(name), `${name} is on the migration list`);
  for (const name of ["assistant-cwd", "steward"]) assert.ok(STATE_DIR_NAMES.includes(name), `${name}/ is on the migration list`);
});

// ---- drift guards: how this change broke the first time main moved under it ----------------------------------------
// While this work waited to land, main grew six more `if (!cfg.xFile) cfg.xFile = path.join(path.dirname(cfg.jobsFile), ...)`
// defaults. Nothing noticed, because nothing looked: a panel that merged the two would have kept those six files in the
// checkout and reported a data directory that did not hold them. These two tests are the thing that looks.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function sourceFiles() {
  const out = [path.join(REPO, "server.js")];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(c|m)?js$/.test(entry) && !/\.test\.js$/.test(entry)) out.push(full);
    }
  };
  walk(path.join(REPO, "lib"));
  return out.filter((f) => path.basename(f) !== "paths.js");
}
const codeLines = (file) =>
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((text, i) => ({ text, n: i + 1 }))
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text));

test("every *File / *Dir / *Log config key the panel reads is derived by lib/paths.js, or is source rather than state", () => {
  const derived = new Set(Object.keys(statePaths({ dataDir: "X" })));
  // Read from config but not a state file: the scratch directory is resolved beside the data directory (resolveDirs), and
  // the host SEED ships with the code, next to server.js, by design.
  const notState = new Set(["scratchDir", "hostsSeedFile", "dataDirSource", "scratchDirSource"]);
  const missing = new Map();
  for (const file of sourceFiles()) {
    for (const { text, n } of codeLines(file)) {
      for (const m of text.matchAll(/\b(?:config|cfg)\.(\w+(?:File|Dir|Log))\b/g)) {
        const key = m[1];
        if (derived.has(key) || notState.has(key)) continue;
        missing.set(key, `${path.relative(REPO, file)}:${n}`);
      }
    }
  }
  assert.deepEqual([...missing], [], "a config path nothing derives: add it to statePaths() and, if it is a file the panel writes, to STATE_FILE_NAMES");
});

test("no code builds a state path from the checkout or from a literal logs/ folder", () => {
  // The only places the old spelling is allowed: the legacy folder the migration reads FROM, and the documented fallback
  // of a lib that the server always overrides.
  const allowed = [
    /legacyDir:\s*path\.join\(CONFIG_DIR,\s*"logs"\)/,
    /const CONFIG_DIR\s*=\s*path\.dirname\(CONFIG_PATH\)/,
    /DEFAULT_HOSTS_FILE\s*=\s*"logs\/hosts\.json"/,
  ];
  const offenders = [];
  for (const file of sourceFiles()) {
    for (const { text, n } of codeLines(file)) {
      if (allowed.some((re) => re.test(text))) continue;
      // `dirname(CONFIG_PATH)` and `"logs"` / `logs/` as a path segment are how a state file ended up in the repository.
      if (/path\.dirname\(CONFIG_PATH\)/.test(text) && !/legacyDir|configDir/.test(text)) offenders.push(`${path.relative(REPO, file)}:${n}  ${text.trim()}`);
      if (/path\.join\([^)]*["']logs["']/.test(text)) offenders.push(`${path.relative(REPO, file)}:${n}  ${text.trim()}`);
      if (/["'`]logs[\\/]\w/.test(text) && !/^\s*(\/\/)/.test(text) && !/why:|\$\{/.test(text)) offenders.push(`${path.relative(REPO, file)}:${n}  ${text.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "state paths are lib/paths.js's job");
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

test("ensureDirs creates both directories and the folders inside the data one, and marks the scratch folder it made", () => {
  const root = tmp();
  try {
    const dataDir = path.join(root, "data");
    const scratchDir = path.join(root, "scratch");
    const out = ensureDirs({ dataDir, scratchDir });
    assert.deepEqual([out.dataDir, out.scratchDir], [dataDir, scratchDir]);
    for (const dir of [dataDir, scratchDir, path.join(dataDir, "state"), path.join(dataDir, "attachments"), path.join(dataDir, "logs")]) {
      assert.ok(existsSync(dir), `${dir} exists`);
    }
    assert.ok(existsSync(path.join(scratchDir, SCRATCH_MARKER)), "a scratch folder the panel made carries the marker Clean scratch looks for");
    assert.equal(out.marked, true);
    // Idempotent: a second boot (or a second panel on one data directory) is a no-op, not an error.
    assert.deepEqual(ensureDirs({ dataDir, scratchDir }).made, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scratch folder that already holds somebody's files is never marked, so it can never be cleaned", () => {
  const root = tmp();
  try {
    const theirs = path.join(root, "documents");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(path.join(theirs, "thesis.docx"), "precious");
    assert.equal(markScratch(theirs), false);
    assert.equal(existsSync(path.join(theirs, SCRATCH_MARKER)), false);
    // An empty folder the reader made for the purpose is adopted.
    const mine = path.join(root, "mine");
    mkdirSync(mine, { recursive: true });
    assert.equal(markScratch(mine), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sizes: a read never waits on a walk, the walk is async and de-duplicated, and the marker is not counted", async () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(path.join(root, "a.txt"), "12345");
    writeFileSync(path.join(root, "nested", "b.txt"), "123");
    writeFileSync(path.join(root, SCRATCH_MARKER), "marker");
    assert.deepEqual(dirSize(root), { bytes: 8, files: 2, dirs: 1 }, "the sync walk and ...");
    assert.deepEqual(await walkSize(root), { bytes: 8, files: 2, dirs: 1 }, "... the async walk agree, and neither counts the marker");

    // The first read of a directory nobody has measured answers at once with `at: 0` — it does not block on the walk.
    const cold = sizeOf(root, { ttlMs: 60_000 });
    assert.equal(cold.at, 0, "nothing measured yet, and the caller is told so");
    // Two concurrent measurements are one walk.
    const [one, two] = await Promise.all([measureSize(root), measureSize(root)]);
    assert.equal(one, two, "the second call joined the walk already running");
    assert.equal(one.bytes, 8);

    writeFileSync(path.join(root, "c.txt"), "1234567");
    assert.equal(sizeOf(root, { ttlMs: 60_000 }).bytes, 8, "inside the window the cached reading stands");
    assert.equal(sizeOf(root, { ttlMs: 60_000, fresh: true }).bytes, 15, "and `fresh` re-measures, exactly, now");
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

test("the migration also lands the attachments when ensureDirs has already made an empty folder for them", () => {
  // The real boot order: server.js calls ensureDirs() BEFORE migrateState(), so `attachments/` exists and is empty by the
  // time the copy looks at it. The first version skipped any destination that existed, which left every pasted file —
  // whose absolute path is written into the job store that did move — behind in the checkout.
  const root = tmp();
  try {
    const legacy = path.join(root, "checkout", "logs");
    const dataDir = path.join(root, "data");
    mkdirSync(path.join(legacy, "attachments"), { recursive: true });
    mkdirSync(path.join(legacy, "assistant-cwd"), { recursive: true });
    writeFileSync(path.join(legacy, "jobs.json"), "{}");
    writeFileSync(path.join(legacy, "attachments", "shot.png"), "PNG");
    writeFileSync(path.join(legacy, "assistant-cwd", "AGENTS.md"), "notes");
    ensureDirs({ dataDir, scratchDir: path.join(root, "scratch") });
    assert.ok(existsSync(path.join(dataDir, "attachments")), "the precondition: the folder is already there");
    const out = migrateState({ dataDir, legacyDir: legacy });
    assert.equal(out.migrated, true);
    assert.equal(readFileSync(path.join(dataDir, "attachments", "shot.png"), "utf8"), "PNG");
    assert.equal(readFileSync(path.join(dataDir, "state", "assistant-cwd", "AGENTS.md"), "utf8"), "notes", "the assistant's own working folder moves with its scratchpad");
    assert.ok(out.copied.includes("attachments/") && out.copied.includes("assistant-cwd/"), out.copied.join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the migration is journaled durably, and the journal survives a second boot that copies nothing", () => {
  const root = tmp();
  try {
    const legacy = path.join(root, "checkout", "logs");
    const dataDir = path.join(root, "data");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "jobs.json"), "{}");
    writeFileSync(path.join(legacy, "todos.json"), "{}");
    const at = Date.UTC(2026, 9, 27, 12, 0, 0);
    const first = migrateState({ dataDir, legacyDir: legacy, now: at });
    assert.equal(first.migrated, true);
    const entries = readMigrationJournal(path.join(dataDir, "state"));
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0].at, entries[0].from, entries[0].to], ["2026-10-27T12:00:00.000Z", legacy, path.join(dataDir, "state")]);
    assert.deepEqual(entries[0].copied.sort(), ["jobs.json", "todos.json"]);
    assert.ok(existsSync(path.join(dataDir, "state", MIGRATION_JOURNAL)));
    // The second boot copies nothing — and the answer to "where did this board come from" is still there.
    assert.equal(migrateState({ dataDir, legacyDir: legacy }).migrated, false);
    assert.equal(readMigrationJournal(path.join(dataDir, "state")).length, 1, "not a second entry for a boot that moved nothing");
    assert.deepEqual(readMigrationJournal(path.join(root, "never-migrated")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the job store is copied last, so a migration that died half way is retried instead of mistaken for finished", () => {
  const root = tmp();
  try {
    const legacy = path.join(root, "checkout", "logs");
    const dataDir = path.join(root, "data");
    mkdirSync(path.join(legacy, "jobs.json"), { recursive: true });
    writeFileSync(path.join(legacy, "todos.json"), "{}");
    // jobs.json is a DIRECTORY here, which cpSync (non-recursive) refuses: the other files copy, the store does not.
    const lines = [];
    const broken = migrateState({ dataDir, legacyDir: legacy, onLog: (l) => lines.push(l) });
    assert.equal(broken.migrated, false);
    assert.match(broken.reason, /job store could not be copied/);
    assert.equal(existsSync(path.join(dataDir, "state", "jobs.json")), false, "no store in the data directory, so nothing says `done`");
    assert.ok(lines.some((l) => /could not copy jobs\.json/.test(l)), lines.join("\n"));
    // The next boot, with the store readable again, finishes the job.
    rmSync(path.join(legacy, "jobs.json"), { recursive: true });
    writeFileSync(path.join(legacy, "jobs.json"), "{}");
    const retried = migrateState({ dataDir, legacyDir: legacy });
    assert.equal(retried.migrated, true);
    assert.ok(existsSync(path.join(dataDir, "state", "jobs.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second instance's flat layout has nothing to migrate, whatever sits in its logs folder", () => {
  const root = tmp();
  try {
    const own = path.join(root, "sandbox", "logs");
    mkdirSync(own, { recursive: true });
    writeFileSync(path.join(own, "jobs.json"), "{}");
    const out = migrateState({ dataDir: own, legacyDir: own, layout: "flat" });
    assert.equal(out.migrated, false);
    assert.match(out.reason, /beside its own config file/);
    assert.equal(existsSync(path.join(own, "state")), false, "no state/ folder was invented inside the sandbox's own folder");
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

test("cleaning the scratch directory frees the bytes, reports them, and leaves the folder and its marker", async () => {
  const root = tmp();
  try {
    const scratch = path.join(root, "wag");
    ensureDirs({ dataDir: path.join(root, "data"), scratchDir: scratch });
    mkdirSync(path.join(scratch, "job-1"), { recursive: true });
    writeFileSync(path.join(scratch, "job-1", "compare.diff"), "x".repeat(2048));
    writeFileSync(path.join(scratch, "notes.txt"), "1234");
    const out = await cleanScratch({ scratchDir: scratch, jobs: [], home: path.join(root, "home") });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.freedBytes, 2052);
    assert.equal(out.removedFiles, 2);
    assert.equal(out.leftBehind, 0);
    assert.ok(existsSync(scratch), "the directory itself stays");
    assert.ok(existsSync(path.join(scratch, SCRATCH_MARKER)), "and so does its marker, or the next clean would refuse");
    assert.deepEqual(dirSize(scratch), { bytes: 0, files: 0, dirs: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live run standing in the scratch directory refuses the whole clean, and names the run", async () => {
  const root = tmp();
  try {
    const scratch = path.join(root, "wag");
    ensureDirs({ dataDir: path.join(root, "data"), scratchDir: scratch });
    mkdirSync(path.join(scratch, "job-7"), { recursive: true });
    writeFileSync(path.join(scratch, "job-7", "busy.diff"), "x".repeat(64));
    const jobs = [
      { id: "job-7", status: "running", cwd: path.join(scratch, "job-7") },
      { id: "job-6", status: "done", cwd: path.join(scratch, "job-6") },
      { id: "job-5", status: "running", cwd: path.join(root, "elsewhere") },
    ];
    const out = await cleanScratch({ scratchDir: scratch, jobs, home: path.join(root, "home") });
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

test("a run parked on an approval holds the scratch directory too: `waiting` is a live status", async () => {
  const root = tmp();
  try {
    const scratch = path.join(root, "wag");
    ensureDirs({ dataDir: path.join(root, "data"), scratchDir: scratch });
    writeFileSync(path.join(scratch, "keep.txt"), "x");
    const out = await cleanScratch({
      scratchDir: scratch,
      jobs: [{ id: "job-w", status: "waiting", cwd: path.join(scratch, "job-w") }],
      home: path.join(root, "home"),
    });
    assert.equal(out.refused, true, "the first version of this check listed `waiting_for_approval` and `queued` and missed the status the store actually writes");
    assert.ok(existsSync(path.join(scratch, "keep.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every status the job store treats as live is one a clean refuses over", () => {
  for (const status of LIVE_JOB_STATUS) assert.ok(LIVE_STATUSES.has(status), `${status} is live in lib/jobs.js and must hold the scratch directory`);
});

test("a live run whose cwd is elsewhere still holds the scratch folder it was told to write in", async () => {
  const root = tmp();
  try {
    const scratch = path.join(root, "wag");
    ensureDirs({ dataDir: path.join(root, "data"), scratchDir: scratch });
    // The spawn prompt names `<scratch>/<job id>`; the run works in its worktree, and writes its throwaway files there.
    mkdirSync(path.join(scratch, "job-9"), { recursive: true });
    writeFileSync(path.join(scratch, "job-9", "export.tar"), "x".repeat(32));
    const live = [{ id: "job-9", status: "running", cwd: path.join(root, "worktree") }];
    const refused = await cleanScratch({ scratchDir: scratch, jobs: live, home: path.join(root, "home") });
    assert.equal(refused.refused, true);
    assert.match(refused.error, /job-9/);
    assert.ok(existsSync(path.join(scratch, "job-9", "export.tar")));
    // The same run, finished: nothing holds the folder any more.
    const done = await cleanScratch({ scratchDir: scratch, jobs: [{ ...live[0], status: "done" }], home: path.join(root, "home") });
    assert.equal(done.ok, true);
    assert.equal(existsSync(path.join(scratch, "job-9")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a finished run in the scratch directory does not hold it", async () => {
  const root = tmp();
  try {
    const scratch = path.join(root, "wag");
    ensureDirs({ dataDir: path.join(root, "data"), scratchDir: scratch });
    writeFileSync(path.join(scratch, "old.txt"), "1234");
    const out = await cleanScratch({
      scratchDir: scratch,
      jobs: [{ id: "job-1", status: "done", cwd: path.join(scratch, "job-1") }],
      home: path.join(root, "home"),
    });
    assert.equal(out.ok, true);
    assert.equal(out.freedBytes, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Clean scratch is a recursive delete of a configured path: what it must refuse ---------------------------
test("a folder the panel did not make is refused: no marker, no delete", async () => {
  const root = tmp();
  try {
    const theirs = path.join(root, "documents");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(path.join(theirs, "thesis.docx"), "precious");
    const out = await cleanScratch({ scratchDir: theirs, jobs: [], home: path.join(root, "home") });
    assert.equal(out.refused, true);
    assert.match(out.error, /was not made by the panel/);
    assert.match(out.error, new RegExp(SCRATCH_MARKER.replace(".", "\\.")));
    assert.equal(readFileSync(path.join(theirs, "thesis.docx"), "utf8"), "precious", "nothing was deleted");
    // The reader's own opt-in is one empty file.
    writeFileSync(path.join(theirs, SCRATCH_MARKER), "");
    const allowed = await cleanScratch({ scratchDir: theirs, jobs: [], home: path.join(root, "home") });
    assert.equal(allowed.ok, true);
    assert.equal(existsSync(path.join(theirs, "thesis.docx")), false, "once they have said so");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scratchProblem refuses a drive root, the home folder and anything above it, and the panel's own state", () => {
  const root = tmp();
  try {
    const home = path.join(root, "users", "me");
    const dataDir = path.join(home, ".wag");
    const checkout = path.join(root, "projects", "agent-worktree-gui");
    const keep = [checkout, path.join(root, "projects")];
    mkdirSync(home, { recursive: true });
    // Each of these is a typo away from a scratchDir, and each would be a recursive delete of something that matters.
    assert.match(scratchProblem({ scratchDir: path.parse(root).root, home, dataDir, keep }), /drive root/);
    assert.match(scratchProblem({ scratchDir: home, home, dataDir, keep }), /home folder/);
    assert.match(scratchProblem({ scratchDir: path.join(root, "users"), home, dataDir, keep }), /home folder/, "an ancestor of home contains it");
    assert.match(scratchProblem({ scratchDir: dataDir, home: path.join(root, "elsewhere"), dataDir, keep }), /data directory/);
    assert.match(scratchProblem({ scratchDir: checkout, home, dataDir, keep }), /agent-worktree-gui/);
    assert.match(scratchProblem({ scratchDir: path.join(root, "projects"), home, dataDir, keep }), /projects/);
    assert.match(scratchProblem({ scratchDir: "", home, dataDir, keep }), /no scratch directory/);
    // ...and still allows the folders it exists for: the default under tmp, and a folder INSIDE the data directory
    // (the second-instance layout keeps its scratch there).
    assert.equal(scratchProblem({ scratchDir: path.join(root, "tmp", "wag"), home, dataDir, keep }), null);
    assert.equal(scratchProblem({ scratchDir: path.join(dataDir, "scratch"), home, dataDir, keep }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanScratch honours scratchProblem before it looks at a single file", async () => {
  const root = tmp();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "keep.txt"), "mine");
    writeFileSync(path.join(home, SCRATCH_MARKER), "");
    const out = await cleanScratch({ scratchDir: home, jobs: [], home });
    assert.equal(out.refused, true);
    assert.match(out.error, /home folder/, "even a marked folder is refused when it is the home folder");
    assert.equal(readFileSync(path.join(home, "keep.txt"), "utf8"), "mine");
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
