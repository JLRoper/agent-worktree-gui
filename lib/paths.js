// ---- where the panel keeps things, in one place ------------------------------------------------
// Two directories, and every durable file the panel writes is derived from one of them.
//
//   dataDir     the panel's own user data: the job store, the assistant's scratchpad and charter, the
//               TODOs, the naming ledger, the descriptions, the labels, the model prices, the push
//               guard record, the restart record, stored attachments and the panel's own server log.
//               Defaults to `~/.wag`, so a checkout can be replaced, re-cloned, moved or made
//               read-only without taking the board's history with it.
//   scratchDir  throwaway files: comparisons, exported branches, a probe's output. Defaults to
//               `<os tmpdir>/wag`, so the OS may clean it whenever it likes. Nothing the panel needs
//               to keep is ever put there.
//
// Before this module every one of those paths was built from `path.dirname(CONFIG_PATH)` — i.e. from
// inside the repository — which is why a fresh clone opened on an empty board and a deleted checkout
// took the job store with it. Nothing outside this module derives a data path any more: server.js
// fills `config.dataDir` / `config.scratchDir` / the state files from here and everything else reads
// those values.
//
// Resolution, in order, for each path:
//   dataDir     config.dataDir, then WAG_HOME, then path.join(os.homedir(), ".wag")
//   scratchDir  config.scratchDir, then WAG_SCRATCH, then path.join(os.tmpdir(), "wag")
//
// A SECOND INSTANCE is the one exception, and it is what keeps a sandbox off the reader's board. An instance
// started with PANEL_CONFIG is by definition not the default install, so when its config file names no
// `dataDir` it keeps its state exactly where it always did — in `<dir of that config>/logs`, flat, with its own
// scratch folder inside — and WAG_HOME / WAG_SCRATCH are NOT consulted. Without that rule every verify tool,
// every `startPanel()` test and every `PANEL_CONFIG=... node server.js` that names only its own store would
// resolve to `~/.wag` and read, rewrite and journal the live board's files. Naming `dataDir` in the config opts
// a second instance into the new layout.
//
// This module imports nothing from the panel and has no side effect at import time, so a test (or a
// tool) can resolve the same paths the server will, without booting one.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DATA_ENV = "WAG_HOME";
export const SCRATCH_ENV = "WAG_SCRATCH";
export const DATA_DIR_NAME = ".wag";
export const SCRATCH_DIR_NAME = "wag";
// An empty file the panel puts in a scratch folder IT made (or adopted while empty). "Clean scratch" deletes
// everything under a directory, so it refuses a directory that does not carry this: a `scratchDir` typo that points
// at a folder somebody else filled is then a refusal, not a deletion.
export const SCRATCH_MARKER = ".wag-scratch";
// The durable half of "journal it": one entry per migration, in the state folder it migrated into.
export const MIGRATION_JOURNAL = "migrations.json";

// The state files the panel owns. Everything that used to be built as `dirname(CONFIG_PATH)/logs/<name>`
// is on this list; `projects.json` and the two thread files are here for the same reason (they were the
// only ones built against the process cwd, which a sandbox then shared with the live board). The migration
// copies `jobs.json` LAST, because a store in the data directory is what says "already migrated": a copy that
// died half way must be retried at the next boot, not mistaken for a finished one.
export const STATE_FILE_NAMES = [
  "jobs.json",
  "assistant.json",
  "assistant-charter.md",
  "todos.json",
  "tree-names.json",
  "descriptions.json",
  "labels.json",
  "model-prices.json",
  "push-guard.json",
  "thread-models.json",
  "thread-context.json",
  "projects.json",
  "restart.json",
  "gateway-restart.log",
  // Added by the steward / locks / hosts / parent-book work that landed on main after this module was first written.
  "locks.json",
  "parents.json",
  "branch-parents.json",
  "hosts.json",
  "steward-questions.json",
  // Added with the row's own ⟳: what each row's last reconcile found, one journal line per action.
  "refresh.json",
];
// Folders that sit beside the store and are state, not output: the assistant's own working directory, and the
// steward's plans (`<stewardDir>/steward/<project>.plan.md|json`, which the board reads back after a restart).
export const STATE_DIR_NAMES = ["assistant-cwd", "steward"];

// `~/x` and `~\x` are the two spellings a person types; neither is a legal Windows path and neither is
// what `path.resolve` would do with it, so expand it before resolving.
export function expandHome(value, home = os.homedir()) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
  return raw;
}

const pick = (explicit, envValue, home) => {
  const fromConfig = expandHome(explicit, home);
  if (fromConfig) return { value: path.resolve(fromConfig), source: "config" };
  const fromEnv = expandHome(envValue, home);
  if (fromEnv) return { value: path.resolve(fromEnv), source: "env" };
  return null;
};

// Both paths, and where each came from — `source` is `config`, `env`, `PANEL_CONFIG` or `default`, and the
// Settings row says which, because "why is my board empty" has to be answerable from the page. `dataLayout` is
// `split` (state/, attachments/, logs/ inside the data directory) or `flat` (the second-instance layout: one
// folder holding everything, which is where every sandbox has always kept its files).
export function resolveDirs({
  config = {},
  env = process.env,
  home = os.homedir(),
  tmpdir = os.tmpdir(),
  configSource = null,
  configDir = null,
} = {}) {
  const secondInstance = configSource === "PANEL_CONFIG" && Boolean(configDir);
  // A second instance answers to its own config file only: the environment belongs to the default install.
  const data = pick(config.dataDir, secondInstance ? "" : env[DATA_ENV], home);
  const scratch = pick(config.scratchDir, secondInstance ? "" : env[SCRATCH_ENV], home);
  let dataDir;
  let dataSource;
  let dataLayout = "split";
  if (data) {
    dataDir = data.value;
    dataSource = data.source;
  } else if (secondInstance) {
    dataDir = path.join(path.resolve(String(configDir)), "logs");
    dataSource = "PANEL_CONFIG";
    dataLayout = "flat";
  } else {
    dataDir = path.join(home, DATA_DIR_NAME);
    dataSource = "default";
  }
  let scratchDir;
  let scratchSource;
  if (scratch) {
    scratchDir = scratch.value;
    scratchSource = scratch.source;
  } else if (secondInstance) {
    scratchDir = path.join(dataDir, "scratch");
    scratchSource = "PANEL_CONFIG";
  } else {
    scratchDir = path.join(tmpdir, SCRATCH_DIR_NAME);
    scratchSource = "default";
  }
  return { dataDir, dataSource, dataLayout, scratchDir, scratchSource };
}

// Which config file the panel reads. `PANEL_CONFIG` still wins outright (a sandbox names its own), then
// a config that has been moved into the data directory, then the one beside the checkout — an existing
// install keeps working exactly as it did, and moving the file is what opts into the new home.
export function resolveConfigPath({ here, env = process.env, home = os.homedir() } = {}) {
  const explicit = String(env.PANEL_CONFIG || "").trim();
  if (explicit) return { path: path.resolve(explicit), source: "PANEL_CONFIG" };
  const moved = path.join(resolveDirs({ env, home }).dataDir, "config.json");
  if (existsSync(moved)) return { path: moved, source: "dataDir" };
  return { path: path.join(here, "config.json"), source: "checkout" };
}

// Every state path, resolved once. A key the config names explicitly wins — that is how a sandbox
// points at its own store — and everything it does not name is derived from this one directory. Note
// that the remaining state files follow an explicit `jobsFile`: a config that names only a store keeps
// its siblings beside it, which is the behaviour PANEL_CONFIG sandboxes have always relied on.
// `config.dataLayout === "flat"` is the second-instance layout: no state/ and no logs/ folder inside, because
// the data directory IS the folder those instances have always kept their files in.
export function statePaths(config = {}) {
  const dataDir = config.dataDir ? String(config.dataDir) : resolveDirs({ config }).dataDir;
  const flat = config.dataLayout === "flat";
  const dir = (name) => path.join(dataDir, name);
  const storeDir = path.dirname(config.jobsFile || (flat ? dir("jobs.json") : path.join(dir("state"), "jobs.json")));
  const file = (name) => path.join(storeDir, name);
  return {
    dataDir,
    stateDir: storeDir,
    attachmentsDir: config.attachmentsDir || dir("attachments"),
    logsDir: config.logsDir || (flat ? dataDir : dir("logs")),
    jobsFile: config.jobsFile || file("jobs.json"),
    assistantFile: config.assistantFile || file("assistant.json"),
    charterFile: config.charterFile || file("assistant-charter.md"),
    todosFile: config.todosFile || file("todos.json"),
    // The release requests a worker's last words produced, and what the panel's executor decided about each one
    // (lib/worktrees.js). State, like the rest: it never lives inside a worktree.
    releasesFile: config.releasesFile || file("releases.json"),
    treeNamesFile: config.treeNamesFile || file("tree-names.json"),
    descriptionsFile: config.descriptionsFile || file("descriptions.json"),
    labelsFile: config.labelsFile || file("labels.json"),
    threadModelsFile: config.threadModelsFile || file("thread-models.json"),
    threadContextFile: config.threadContextFile || file("thread-context.json"),
    modelPricingFile: config.modelPricingFile || file("model-prices.json"),
    pushGuardFile: config.pushGuardFile || file("push-guard.json"),
    restartFile: config.restartFile || file("restart.json"),
    gatewayRestartLog: config.gatewayRestartLog || file("gateway-restart.log"),
    projectsCacheFile: config.projectsCacheFile || file("projects.json"),
    // The records main grew after this module was first written, each one a file the panel owns and rewrites: which
    // trees the reader locked, where each tree was cut from (two ledgers: the tree's and the branch's), the host
    // mappings the reader edits (lib/hosts.js; its SEED, hosts.seed.json, ships with the code and is not state), and the
    // steward's plans (`stewardDir` holds a `steward/` folder of them) with its questions ledger.
    locksFile: config.locksFile || file("locks.json"),
    parentsFile: config.parentsFile || file("parents.json"),
    branchParentsFile: config.branchParentsFile || file("branch-parents.json"),
    hostsFile: config.hostsFile || file("hosts.json"),
    stewardDir: config.stewardDir || storeDir,
    stewardQuestionsFile: config.stewardQuestionsFile || file("steward-questions.json"),
    refreshFile: config.refreshFile || file("refresh.json"),
  };
}

// The whole resolution a booted server performs, without booting one: the config file, both directories, every
// state path. start-background.cmd asks it where the log folder is (tools/where.mjs), so a launcher script and
// the server cannot answer that question differently — a `dataDir` written in config.json, a PANEL_CONFIG
// instance and a moved config all included.
export function resolveLayout({ here, env = process.env, home = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  const file = resolveConfigPath({ here, env, home });
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(file.path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    /* a missing or unreadable config resolves like an empty one: the defaults */
  }
  const dirs = resolveDirs({ config: raw, env, home, tmpdir, configSource: file.source, configDir: path.dirname(file.path) });
  const config = { ...raw, dataDir: dirs.dataDir, dataLayout: dirs.dataLayout, scratchDir: dirs.scratchDir };
  return { configFile: file, dirs, config, paths: statePaths(config) };
}

// Both directories exist before anything writes into them (`mkdir -p`, so a race is a no-op). The state,
// attachments and log directories are created too: a boot that dies between "config loaded" and "store
// written" otherwise leaves a data directory with nothing in it and a second boot that cannot tell
// "fresh install" from "half-created".
export function ensureDirs(config = {}) {
  const own = statePaths(config);
  const scratchDir = config.scratchDir || resolveDirs({ config }).scratchDir;
  const made = [];
  const seen = new Set();
  for (const target of [own.dataDir, own.stateDir, own.attachmentsDir, own.logsDir, scratchDir]) {
    const key = pathKey(target);
    if (!target || seen.has(key)) continue;
    seen.add(key);
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
      made.push(target);
    }
  }
  const marked = markScratch(scratchDir);
  return { dataDir: own.dataDir, scratchDir, made, marked };
}

// The marker goes into a scratch folder the panel made, or one that was empty when it first looked — never into
// a folder that already holds somebody's files, which is exactly the folder "Clean scratch" must not empty.
export function markScratch(dir) {
  if (!dir) return false;
  const marker = path.join(dir, SCRATCH_MARKER);
  if (existsSync(marker)) return true;
  try {
    if (readdirSync(dir).length) return false;
    writeFileSync(marker, "This folder is the panel's scratch directory: Settings > Data > Clean scratch may empty it.\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---- how big is a directory ----------------------------------------------------------------
// A stat-only walk: no file is opened, so a 200 MB attachment costs the same as an empty folder.
// Symlinks are counted and not followed — a link back up the tree would otherwise walk forever. The marker is
// not the reader's data and is not counted: an empty scratch folder reads 0 B, 0 files.
export function dirSize(target) {
  const out = { bytes: 0, files: 0, dirs: 0 };
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (dir === target && entry.name === SCRATCH_MARKER) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        out.files += 1;
        continue;
      }
      if (entry.isDirectory()) {
        out.dirs += 1;
        walk(full);
        continue;
      }
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      out.files += 1;
      out.bytes += Number(st.size) || 0;
    }
  };
  walk(target);
  return out;
}

// The same walk, off the event loop: every directory read and every stat is awaited, so the board keeps
// answering while a scratch folder holding a copied `node_modules` is measured. This is the one the server uses;
// `dirSize` stays for the places that want an exact number now (a test, the line after a clean).
export async function walkSize(target) {
  const out = { bytes: 0, files: 0, dirs: 0 };
  const queue = [target];
  while (queue.length) {
    const batch = queue.splice(0, 8);
    await Promise.all(
      batch.map(async (dir) => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          entries.map(async (entry) => {
            if (dir === target && entry.name === SCRATCH_MARKER) return;
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
              out.files += 1;
              return;
            }
            if (entry.isDirectory()) {
              out.dirs += 1;
              queue.push(full);
              return;
            }
            try {
              const st = await stat(full);
              out.files += 1;
              out.bytes += Number(st.size) || 0;
            } catch {
              /* gone between the listing and the stat */
            }
          }),
        );
      }),
    );
  }
  return out;
}

// /api/state is polled every few seconds by every open board, so a size is READ from a cache and REFRESHED in the
// background — a request never waits on a walk, and two requests never start two. The first read of a directory
// answers `at: 0` (nothing measured yet) and the page says "measuring…" rather than "0 B"; `ttlMs` is how stale a
// number may get before the next read starts a new walk.
const sizeCache = new Map();
const walking = new Map();

export function measureSize(dir) {
  if (!dir) return Promise.resolve({ bytes: 0, files: 0, dirs: 0, at: 0 });
  const running = walking.get(dir);
  if (running) return running;
  const job = walkSize(dir)
    .then((found) => {
      const rec = { ...found, at: Date.now() };
      sizeCache.set(dir, rec);
      return rec;
    })
    .finally(() => walking.delete(dir));
  walking.set(dir, job);
  return job;
}

export function sizeOf(dir, { ttlMs = 10_000, now = Date.now(), fresh = false } = {}) {
  if (!dir) return { bytes: 0, files: 0, dirs: 0, at: 0 };
  if (fresh) {
    const rec = { ...dirSize(dir), at: now };
    sizeCache.set(dir, rec);
    return rec;
  }
  const hit = sizeCache.get(dir);
  if (!hit || now - hit.at >= ttlMs) void measureSize(dir).catch(() => {});
  return hit || { bytes: 0, files: 0, dirs: 0, at: 0 };
}

export function forgetSizes() {
  sizeCache.clear();
}

// ---- one-time migration off the checkout -----------------------------------------------------
// An install that has been running from a checkout has its state in `<repo>/logs`. The first boot with a
// data directory that holds no store copies it across: COPY, never move, and never delete — a downgrade,
// a second build or a reader who deliberately runs `PANEL_CONFIG` at the old file must all still find
// what was there. `state-migrated` is journaled with the count and where it came from, because a board
// that suddenly shows last week's cards has to be explainable from the log — to the console as a line, and
// durably as an entry in `<stateDir>/migrations.json`, which is what the Settings row reads on every later boot.
export function migrateState({
  dataDir,
  stateFile = null,
  legacyDir,
  onLog = () => {},
  files = STATE_FILE_NAMES,
  dirs = STATE_DIR_NAMES,
  layout = "split",
  now = Date.now(),
} = {}) {
  const stateDir = path.join(String(dataDir || ""), "state");
  const target = path.join(stateDir, "jobs.json");
  const key = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const result = { migrated: false, copied: [], failed: [], from: legacyDir || null, to: stateDir, reason: null };
  // A second instance keeps its files where its config is; there is nothing to move and nowhere to move it.
  if (layout === "flat") return { ...result, reason: "this instance keeps its state beside its own config file" };
  // A store the config points somewhere else is not this migration's business: copying into a directory
  // the panel will not read would leave two stores and no way to tell which one is live.
  if (stateFile && key(stateFile) !== key(target)) {
    return { ...result, reason: "the job store is configured outside the data directory" };
  }
  if (existsSync(target)) return { ...result, reason: "the data directory already holds a job store" };
  if (!legacyDir || !existsSync(path.join(legacyDir, "jobs.json"))) return { ...result, reason: "no job store beside the checkout" };
  mkdirSync(stateDir, { recursive: true });
  const copy = (src, dst, label, recursive = false) => {
    if (!existsSync(src)) return;
    try {
      cpSync(src, dst, { recursive });
      result.copied.push(label);
    } catch (e) {
      result.failed.push(label);
      onLog(`state-migrated: could not copy ${label} from ${legacyDir}: ${String((e && e.message) || e)}`);
    }
  };
  // The store goes last: it is the file whose presence stops the migration running again.
  for (const name of files.filter((n) => n !== "jobs.json")) copy(path.join(legacyDir, name), path.join(stateDir, name), name);
  for (const name of dirs) {
    if (!existsSync(path.join(stateDir, name))) copy(path.join(legacyDir, name), path.join(stateDir, name), `${name}/`, true);
  }
  // Attachments are state too, and their paths are recorded in the job store that is about to move. An EMPTY
  // attachments folder counts as absent: ensureDirs made it a moment ago, and skipping it would leave every pasted
  // file behind in the checkout.
  const attDst = path.join(String(dataDir), "attachments");
  if (!existsSync(attDst) || !readdirSync(attDst).length) copy(path.join(legacyDir, "attachments"), attDst, "attachments/", true);
  copy(path.join(legacyDir, "jobs.json"), target, "jobs.json");
  if (!result.copied.includes("jobs.json")) return { ...result, reason: "the job store could not be copied" };
  result.migrated = true;
  const entry = { at: new Date(now).toISOString(), from: legacyDir, to: stateDir, copied: result.copied, failed: result.failed };
  result.journal = appendMigrationJournal(stateDir, entry);
  onLog(`state-migrated: copied ${result.copied.length} file(s) from ${legacyDir} to ${stateDir} — the originals were left untouched`);
  return result;
}

export function readMigrationJournal(stateDir) {
  try {
    const doc = JSON.parse(readFileSync(path.join(String(stateDir || ""), MIGRATION_JOURNAL), "utf8"));
    return Array.isArray(doc && doc.entries) ? doc.entries : [];
  } catch {
    return [];
  }
}

// A journal that cannot be written must not fail the boot: the copy already happened and the console line says so.
export function appendMigrationJournal(stateDir, entry) {
  try {
    const entries = [...readMigrationJournal(stateDir), entry];
    writeFileSync(path.join(stateDir, MIGRATION_JOURNAL), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
    return entry;
  } catch {
    return null;
  }
}

// ---- the scratch directory ------------------------------------------------------------------
// Is `child` inside `dir` (or the directory itself)? Both are reduced to the panel's one path key
// first: separators to `/`, no trailing slash, lower case, because Windows compares paths that way.
export const pathKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function insideDir(child, dir) {
  const c = pathKey(child);
  const d = pathKey(dir);
  if (!c || !d) return false;
  return c === d || c.startsWith(`${d}/`);
}

// The line every spawn prompt carries. It is deliberately two facts and no lecture: where throwaway
// files go, and the one habit it replaces — cutting a worktree to look at another branch, which leaves
// a branch, a directory and a row on the board behind every comparison.
export function scratchLine(scratchDir, tag = null) {
  const base = String(scratchDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base) return "";
  const where = tag ? `${base}/${String(tag).replace(/^\/+|\/+$/g, "")}` : base;
  return `SCRATCH: put any throwaway or comparison files under ${where} — never create a git worktree to compare or export a branch, use \`git archive\` or \`git show\` instead.`;
}

// A superset of every status a card can be live in: the job store's own (`running`, `starting`, `waiting` — the
// last is a run parked on an approval or a question) and the gateway's spellings the page also treats as live.
// test/paths.test.js pins it against lib/jobs.js's LIVE_JOB_STATUS so a status added there cannot slip past a clean.
export const LIVE_STATUSES = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);

// Why this directory must not be emptied, or null when it may. A clean deletes everything under it and cannot be
// undone, so the checks are about what the path IS, not about whether the reader meant it: a drive root, the home
// folder or any folder above it, and anything that holds the panel's own state, its checkout, a project or a scan
// root. `keep` is that second list, passed by the caller because only the server knows the projects.
export function scratchProblem({ scratchDir, home = os.homedir(), dataDir = null, keep = [] } = {}) {
  if (!scratchDir) return "this panel has no scratch directory configured";
  const dir = path.resolve(String(scratchDir));
  if (path.parse(dir).root === dir) return `${dir} is a drive root`;
  if (insideDir(home, dir)) return `${dir} is, or contains, your home folder`;
  if (dataDir && insideDir(dataDir, dir)) return `${dir} is, or contains, the panel's data directory (${dataDir})`;
  for (const held of keep) {
    if (held && insideDir(path.resolve(String(held)), dir)) return `${dir} is, or contains, ${path.resolve(String(held))}`;
  }
  return null;
}

// Empty the scratch directory, unless it is not safe to or a live run is using it. A run holds it when its cwd is
// under scratch (its files are open, and on Windows the delete would half-fail and leave a folder neither the reader
// nor the run can use) OR when the folder the spawn prompt named for it — `<scratch>/<job id>` — exists, because that
// is where it was told to write and a clean would delete files from under it. The refusal comes first and it names
// the runs. Async on purpose: this runs inside the server's one event loop, and a scratch folder holding a copied
// checkout is thousands of files to remove.
export async function cleanScratch({
  scratchDir,
  jobs = [],
  now = Date.now(),
  dataDir = null,
  keep = [],
  home = os.homedir(),
  requireMarker = true,
} = {}) {
  const dir = String(scratchDir || "");
  const refuse = (error, extra = {}) => ({ ok: false, refused: true, error, ...extra });
  if (!dir) return refuse("this panel has no scratch directory configured");
  const problem = scratchProblem({ scratchDir: dir, home, dataDir, keep });
  if (problem) return refuse(`scratch will not be cleaned: ${problem}`);
  if (!existsSync(dir)) return { ok: true, refused: false, freedBytes: 0, removedFiles: 0, removedDirs: 0, leftBehind: 0, at: new Date(now).toISOString() };
  if (requireMarker && !existsSync(path.join(dir, SCRATCH_MARKER))) {
    return refuse(
      `scratch will not be cleaned: ${dir} was not made by the panel (no ${SCRATCH_MARKER} file inside it), and the panel does not delete in a folder it did not make — add an empty file named ${SCRATCH_MARKER} to it if it really is yours to empty`,
    );
  }
  const holders = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || !LIVE_STATUSES.has(String(j.status || ""))) return false;
    if ([j.cwd, j.ownerPath, j.worktreePath].some((p) => insideDir(p, dir))) return true;
    return Boolean(j.id) && existsSync(path.join(dir, String(j.id)));
  });
  if (holders.length) {
    const named = holders.map((j) => `${j.id || j.thread || "?"}${j.cwd ? ` in ${String(j.cwd).replace(/\\/g, "/")}` : ""}`);
    return refuse(
      `scratch is in use: ${holders.length === 1 ? "a live run is working" : `${holders.length} live runs are working`} in or writing to it (${named.join(" · ")}) — stop ${holders.length === 1 ? "it" : "them"} first, or clean it by hand`,
      { holders: holders.map((j) => ({ id: j.id || null, thread: j.thread || null, cwd: j.cwd || j.ownerPath || j.worktreePath || null })) },
    );
  }
  const before = await walkSize(dir);
  const failed = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, refused: false, error: `could not read ${dir}: ${String((e && e.message) || e)}` };
  }
  for (const entry of entries) {
    if (entry.name === SCRATCH_MARKER) continue;
    try {
      await rm(path.join(dir, entry.name), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      failed.push(entry.name);
    }
  }
  const after = await walkSize(dir);
  return {
    ok: true,
    refused: false,
    freedBytes: Math.max(0, before.bytes - after.bytes),
    removedFiles: Math.max(0, before.files - after.files),
    removedDirs: Math.max(0, before.dirs - after.dirs),
    leftBehind: failed.length,
    failed,
    at: new Date(now).toISOString(),
  };
}

// A short human size for the page and the log line: 0 B, 964 B, 12.4 KB, 3.1 MB, 1.2 GB.
export function humanBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const shown = i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${shown} ${units[i]}`;
}
