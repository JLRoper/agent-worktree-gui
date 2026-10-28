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
// This module imports nothing from the panel and has no side effect at import time, so a test (or a
// tool) can resolve the same paths the server will, without booting one.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_ENV = "WAG_HOME";
export const SCRATCH_ENV = "WAG_SCRATCH";
export const DATA_DIR_NAME = ".wag";
export const SCRATCH_DIR_NAME = "wag";

// The state files the panel owns. Everything that used to be built as `dirname(CONFIG_PATH)/logs/<name>`
// is on this list; `projects.json` and the two thread files are here for the same reason (they were the
// only ones built against the process cwd, which a sandbox then shared with the live board).
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
];

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

// Both paths, and where each came from — `source` is `config`, `env` or `default`, and the Settings row
// says which, because "why is my board empty" has to be answerable from the page.
export function resolveDirs({ config = {}, env = process.env, home = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  const data = pick(config.dataDir, env[DATA_ENV], home);
  const scratch = pick(config.scratchDir, env[SCRATCH_ENV], home);
  return {
    dataDir: data ? data.value : path.join(home, DATA_DIR_NAME),
    dataSource: data ? data.source : "default",
    scratchDir: scratch ? scratch.value : path.join(tmpdir, SCRATCH_DIR_NAME),
    scratchSource: scratch ? scratch.source : "default",
  };
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
export function statePaths(config = {}) {
  const dataDir = config.dataDir ? String(config.dataDir) : resolveDirs({ config }).dataDir;
  const dir = (name) => path.join(dataDir, name);
  const storeDir = path.dirname(config.jobsFile || path.join(dir("state"), "jobs.json"));
  const file = (name) => path.join(storeDir, name);
  return {
    dataDir,
    stateDir: storeDir,
    attachmentsDir: config.attachmentsDir || dir("attachments"),
    logsDir: config.logsDir || dir("logs"),
    jobsFile: config.jobsFile || file("jobs.json"),
    assistantFile: config.assistantFile || file("assistant.json"),
    charterFile: config.charterFile || file("assistant-charter.md"),
    todosFile: config.todosFile || file("todos.json"),
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
  };
}

// Both directories exist before anything writes into them (`mkdir -p`, so a race is a no-op). The state,
// attachments and log directories are created too: a boot that dies between "config loaded" and "store
// written" otherwise leaves a data directory with nothing in it and a second boot that cannot tell
// "fresh install" from "half-created".
export function ensureDirs(config = {}) {
  const dataDir = config.dataDir || resolveDirs({ config }).dataDir;
  const scratchDir = config.scratchDir || resolveDirs({ config }).scratchDir;
  const made = [];
  for (const target of [dataDir, path.join(dataDir, "state"), path.join(dataDir, "attachments"), path.join(dataDir, "logs"), scratchDir]) {
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
      made.push(target);
    }
  }
  return { dataDir, scratchDir, made };
}

// ---- how big is a directory ----------------------------------------------------------------
// A stat-only walk: no file is opened, so a 200 MB attachment costs the same as an empty folder.
// Symlinks are counted and not followed — a link back up the tree would otherwise walk forever.
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

// A cached read, because /api/state is polled every few seconds by every open board and a walk per poll
// is work nobody asked for. `ttlMs` is the whole point: the number on the page may be a few seconds old
// and the row says so rather than the page paying for a fresh walk each time.
const sizeCache = new Map();

export function sizeOf(dir, { ttlMs = 10_000, now = Date.now(), fresh = false } = {}) {
  if (!dir) return { bytes: 0, files: 0, dirs: 0, at: 0 };
  const hit = sizeCache.get(dir);
  if (!fresh && hit && now - hit.at < ttlMs) return hit;
  const rec = { ...dirSize(dir), at: now };
  sizeCache.set(dir, rec);
  return rec;
}

export function forgetSizes() {
  sizeCache.clear();
}

// ---- one-time migration off the checkout -----------------------------------------------------
// An install that has been running from a checkout has its state in `<repo>/logs`. The first boot with a
// data directory that holds no store copies it across: COPY, never move, and never delete — a downgrade,
// a second build or a reader who deliberately runs `PANEL_CONFIG` at the old file must all still find
// what was there. `state-migrated` is journaled with the count and where it came from, because a board
// that suddenly shows last week's cards has to be explainable from the log.
export function migrateState({ dataDir, stateFile = null, legacyDir, onLog = () => {}, files = STATE_FILE_NAMES } = {}) {
  const stateDir = path.join(String(dataDir || ""), "state");
  const target = path.join(stateDir, "jobs.json");
  const key = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const result = { migrated: false, copied: [], from: legacyDir || null, to: stateDir, reason: null };
  // A store the config points somewhere else is not this migration's business: copying into a directory
  // the panel will not read would leave two stores and no way to tell which one is live.
  if (stateFile && key(stateFile) !== key(target)) {
    return { ...result, reason: "the job store is configured outside the data directory" };
  }
  if (existsSync(target)) return { ...result, reason: "the data directory already holds a job store" };
  if (!legacyDir || !existsSync(path.join(legacyDir, "jobs.json"))) return { ...result, reason: "no job store beside the checkout" };
  mkdirSync(stateDir, { recursive: true });
  for (const name of files) {
    const src = path.join(legacyDir, name);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, path.join(stateDir, name));
      result.copied.push(name);
    } catch (e) {
      onLog(`state-migrated: could not copy ${name} from ${legacyDir}: ${String((e && e.message) || e)}`);
    }
  }
  // Attachments are state too, and their paths are recorded in the job store that just moved.
  const attSrc = path.join(legacyDir, "attachments");
  const attDst = path.join(String(dataDir), "attachments");
  if (existsSync(attSrc) && !existsSync(attDst)) {
    try {
      cpSync(attSrc, attDst, { recursive: true });
      result.copied.push("attachments/");
    } catch (e) {
      onLog(`state-migrated: could not copy attachments from ${attSrc}: ${String((e && e.message) || e)}`);
    }
  }
  if (!result.copied.length) return { ...result, reason: "nothing to copy" };
  result.migrated = true;
  onLog(`state-migrated: copied ${result.copied.length} file(s) from ${legacyDir} to ${stateDir} — the originals were left untouched`);
  return result;
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

const LIVE = new Set(["running", "starting", "waiting_for_approval", "queued"]);

// Empty the scratch directory, unless a live run is working in it. A run whose cwd is under scratch has
// its files open, and on Windows the delete would half-fail and leave the folder in a state neither the
// reader nor the run can use — so the refusal comes first and it names the runs holding it.
export function cleanScratch({ scratchDir, jobs = [], now = Date.now() } = {}) {
  const dir = String(scratchDir || "");
  if (!dir) return { ok: false, refused: true, error: "this panel has no scratch directory configured" };
  if (!existsSync(dir)) return { ok: true, freedBytes: 0, removedFiles: 0, removedDirs: 0, leftBehind: 0, at: new Date(now).toISOString() };
  const holders = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || !LIVE.has(String(j.status || ""))) return false;
    return [j.cwd, j.ownerPath, j.worktreePath].some((p) => insideDir(p, dir));
  });
  if (holders.length) {
    const named = holders.map((j) => `${j.id || j.thread || "?"}${j.cwd ? ` in ${String(j.cwd).replace(/\\/g, "/")}` : ""}`);
    return {
      ok: false,
      refused: true,
      holders: holders.map((j) => ({ id: j.id || null, thread: j.thread || null, cwd: j.cwd || j.ownerPath || j.worktreePath || null })),
      error: `scratch is in use: ${holders.length === 1 ? "a live run is working" : `${holders.length} live runs are working`} inside it (${named.join(" · ")}) — stop ${holders.length === 1 ? "it" : "them"} first, or clean it by hand`,
    };
  }
  const before = dirSize(dir);
  const failed = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, refused: false, error: `could not read ${dir}: ${String((e && e.message) || e)}` };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      failed.push(entry.name);
    }
  }
  const after = dirSize(dir);
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
