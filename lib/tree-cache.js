// The tree list the board had at its last successful scan, kept on disk so a boot or a hard refresh paints the board
// it had instead of a wall of unattached agents.
//
// THE DEFECT THIS EXISTS FOR. The tree list is built by a scan, not by the page: at boot the store is empty, the
// first `/api/state` answers with no rows, and every agent whose `ownerPath` is not a row on the page is drawn in the
// unattached workspace. Ten or more agents therefore painted in that bucket for 15-20 seconds and then jumped to
// their real worktrees - an agent that was never unattached, made to look like one because a scan was slow.
//
// THE SHAPE. One entry per tree, exactly what the row knew when it was last read:
//
//   { path, branch, project, parentBranch, sha, readAt, name }
//
// `path` and `project` are the row's identity (`<project>::<path>`, the store's own key and the page's own key), so a
// cached row and the fresh row that replaces it are the SAME row to everything downstream - nothing is re-created,
// nothing re-animates, no open card closes. `sha` is the commit the tree was read at and `readAt` the moment it was
// read, which is what makes a stale row say "last seen ... at ..." instead of guessing.
//
// THE FILE lives in the panel's own state directory beside `jobs.json`, `tree-names.json` and the rest
// (`lib/paths.js` `stateDir`): the cache is state, never a checkout file, and no worktree carries a copy.
//
// THE CAPS are the reason a dead tree does not live here forever: an entry older than `maxAgeMs` is dropped on read
// AND on write, and the file keeps at most `maxTierTrees` entries, newest first. The store's rows are the running
// truth; the file is only ever a tail of them.
//
// WHAT IS NOT CACHED: a row whose read FAILED (its `error`), a path that is not a tree of its own any more
// (`RELEASED`, `lib/own-tree.js`) and a row already known to be stale. Caching any of those would preserve a claim
// the scan has withdrawn.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TREE_CACHE_VERSION = 1;
// A week is long enough that a weekend's shutdown still opens on the board it had, and short enough that a fleet cut
// down since does not read as the current board. Entries are also capped by count, so a board that doubles is bounded
// by the newest rows rather than by the older half.
export const TREE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const TREE_CACHE_MAX_TREES = 400;
// A row whose tree has vanished from disk is kept as STALE for a day: long enough for its agent's card to stay under
// it with the reason, short enough that a deleted tree is not a permanent fixture of the board.
export const TREE_CACHE_STALE_KEEP_MS = 24 * 60 * 60 * 1000;

export const normTreePath = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

// The one identity a row has, server and client alike: the store's own key, `${project}::${path}`, with the separators
// normalised and no trailing slash. Case is PRESERVED because the store preserves it - the cached row and the scanned
// row must be the SAME key, or the replacement would create a second row instead of replacing the first.
export function treeCacheKey(project, treePath) {
  return `${String(project ?? "").trim()}::${String(treePath ?? "").replace(/\\/g, "/").replace(/\/+$/, "")}`;
}

// The spelling-blind form, for the two places a cache may meet its own path spelled differently (a file written by a
// hand edit, a listing that answered in another case): dedupe on read and the kept/gone/new reconciliation.
const cacheKey = (project, treePath) => treeCacheKey(project, treePath).toLowerCase();

const isoOrNull = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// One row -> one cache entry, or null when the row is not a fact worth remembering (see "WHAT IS NOT CACHED").
// `cachedAt` is read for a row that CAME from this file: `scannedAt` is stamped by every store write, including the
// boot seed, so using it would rewrite the read time of every entry on the first flush after a boot.
export function entryFromRow(project, row = {}) {
  const name = String(row.name || String(row.path || "").split("/").filter(Boolean).pop() || "").trim();
  const treePath = String(row.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!project || !treePath) return null;
  if (row.error) return null;
  if (row.stale) return null;
  if (String(row.verdict || "") === "RELEASED") return null;
  const readAt = isoOrNull(row.cached ? row.cachedAt : row.scannedAt);
  return {
    path: treePath,
    branch: row.branch ? String(row.branch) : null,
    project: String(project),
    parentBranch: row.parent ? String(row.parent) : row.baseBranch ? String(row.baseBranch) : null,
    sha: row.head ? String(row.head) : null,
    readAt,
    name: name || null,
  };
}

// One entry, kept only if it still says something: a path, a project and a readable readAt. A hand-edited file cannot
// smuggle a row onto the board that the store would not have written.
function normaliseEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const treePath = String(raw.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const project = String(raw.project || "").trim();
  const readAt = isoOrNull(raw.readAt);
  if (!treePath || !project || !readAt) return null;
  return {
    path: treePath,
    branch: raw.branch ? String(raw.branch) : null,
    project,
    parentBranch: raw.parentBranch ? String(raw.parentBranch) : null,
    sha: raw.sha ? String(raw.sha) : null,
    readAt,
    name: raw.name ? String(raw.name) : treePath.split("/").filter(Boolean).pop() || null,
  };
}

// The project half of the cache: enough to draw the section the rows hang under before discovery has answered. It is
// the same three-or-four fields the store's own discovery writes, never a second project record.
function normaliseProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim();
  if (!name) return null;
  return {
    name,
    path: raw.path ? String(raw.path).replace(/\\/g, "/") : undefined,
    mainBranch: raw.mainBranch ? String(raw.mainBranch) : undefined,
    remote: raw.remote === null || raw.remote === undefined ? undefined : String(raw.remote),
  };
}

// The pure read: parse, drop everything aged out, cap the count, and report what was dropped so a boot can say why the
// first paint is smaller than the file. A missing file is the normal first-run answer (null, not an error); a file
// that does not parse is logged by the caller and treated the same way - a cache is not worth failing a boot over.
export function readTreeCache(file, { now = Date.now(), maxAgeMs = TREE_CACHE_MAX_AGE_MS, maxTrees = TREE_CACHE_MAX_TREES, log = () => {} } = {}) {
  if (!file || !existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    log(`tree-cache: could not read ${file} (${String((err && err.message) || err)}) - the first paint will wait for the scan`);
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const version = Number(raw.version) || 0;
  if (version > TREE_CACHE_VERSION) {
    log(`tree-cache: ${file} was written by a newer panel (version ${version}) - ignoring it`);
    return null;
  }
  const entries = Array.isArray(raw.trees) ? raw.trees : [];
  const seen = new Set();
  const kept = [];
  let aged = 0;
  let duplicate = 0;
  for (const item of entries) {
    const entry = normaliseEntry(item);
    if (!entry) continue;
    const key = cacheKey(entry.project, entry.path);
    if (seen.has(key)) {
      duplicate += 1;
      continue;
    }
    const at = Date.parse(entry.readAt);
    if (!Number.isFinite(at) || now - at > maxAgeMs) {
      aged += 1;
      continue;
    }
    seen.add(key);
    kept.push(entry);
  }
  kept.sort((a, b) => Date.parse(b.readAt) - Date.parse(a.readAt));
  const capped = kept.slice(0, Math.max(0, maxTrees));
  const dropped = kept.length - capped.length;
  const projects = (Array.isArray(raw.projects) ? raw.projects : []).map(normaliseProject).filter(Boolean);
  const at = capped.reduce((newest, e) => Math.max(newest, Date.parse(e.readAt) || 0), 0);
  if (aged || dropped || duplicate) {
    log(`tree-cache: ${aged} entr${aged === 1 ? "y" : "ies"} past ${Math.round(maxAgeMs / 3600000)}h, ${dropped} over the ${maxTrees} cap, ${duplicate} duplicated - dropped on read`);
  }
  return {
    version: TREE_CACHE_VERSION,
    at: at ? new Date(at).toISOString() : null,
    trees: capped,
    projects,
    dropped: { aged, capped: dropped, duplicate },
  };
}

// Write the cache from the store's live rows. Every entry is derived from the row as it stands, so a row that was
// dropped from the board disappears from the file on the next write and nothing has to remember to forget it.
//
// `at` is the NEWEST entry's readAt, never the write time: a boot that seeds the store from this file and then
// flushes before any scan would otherwise stamp a read that did not happen.
export function writeTreeCache(file, { rows = [], projects = [], now = Date.now(), maxAgeMs = TREE_CACHE_MAX_AGE_MS, maxTrees = TREE_CACHE_MAX_TREES, log = () => {} } = {}) {
  if (!file) return { written: 0, at: null };
  const seen = new Set();
  const trees = [];
  for (const { project, row } of rows) {
    const entry = entryFromRow(project, row);
    if (!entry) continue;
    const at = Date.parse(entry.readAt || "");
    if (!Number.isFinite(at) || now - at > maxAgeMs) continue;
    const key = cacheKey(entry.project, entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    trees.push(entry);
  }
  trees.sort((a, b) => Date.parse(b.readAt) - Date.parse(a.readAt));
  const capped = trees.slice(0, Math.max(0, maxTrees));
  const wanted = new Set(capped.map((e) => e.project));
  const projectRows = projects
    .map(normaliseProject)
    .filter((p) => p && wanted.has(p.name));
  const at = capped.reduce((newest, e) => Math.max(newest, Date.parse(e.readAt) || 0), 0);
  const doc = {
    version: TREE_CACHE_VERSION,
    // What this file IS, said in the file: a later reader (a human, a route, a debug probe) must not read it as
    // current state.
    note: "the tree list the panel last read successfully - the first paint after a boot serves this until the scan lands",
    at: at ? new Date(at).toISOString() : null,
    trees: capped,
    projects: projectRows,
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    log(`tree-cache: could not write ${file} (${String((err && err.message) || err)}) - the next successful scan retries`);
    return { written: 0, at: doc.at };
  }
  return { written: capped.length, at: doc.at, trees: capped, projects: projectRows };
}

// The reconciliation, as a pure classification, so the three answers the brief names can be tested without a store:
//
//   kept  - the path the cache listed AND the fresh scan listed. The fresh row replaces the cached one in place; the
//           key is the same, so nothing is re-created.
//   gone  - the path the cache listed and the fresh scan did not. The caller decides: a tree still on disk is a git
//           hiccup and waits for the second pass, a tree gone from disk renders stale-with-reason. Never dropped into
//           the unattached list on the strength of one listing.
//   added - the path the fresh scan listed and the cache did not: a tree cut since the last scan, and the only kind of
//           row that is genuinely new.
export function reconcileCached({ cached = [], fresh = [], now = Date.now() } = {}) {
  const keyOf = (t) => cacheKey(t?.project, t?.path);
  const freshByKey = new Map();
  for (const t of Array.isArray(fresh) ? fresh : []) {
    if (t && t.project && t.path) freshByKey.set(keyOf(t), t);
  }
  const cachedByKey = new Map();
  for (const t of Array.isArray(cached) ? cached : []) {
    if (t && t.project && t.path) cachedByKey.set(keyOf(t), t);
  }
  const kept = [];
  const gone = [];
  const added = [];
  for (const [key, entry] of cachedByKey) {
    const freshEntry = freshByKey.get(key);
    if (freshEntry) kept.push({ key, cached: entry, fresh: freshEntry, at: new Date(now).toISOString() });
    else gone.push({ key, cached: entry, at: new Date(now).toISOString() });
  }
  for (const [key, entry] of freshByKey) {
    if (!cachedByKey.has(key)) added.push({ key, fresh: entry });
  }
  return { kept, gone, added };
}

// The store, on disk. `schedule()` is the debounce every row read calls: a scan writes its row into the store at once,
// and the file catches up once per burst instead of once per row.
export class TreeCache {
  constructor({ file = null, log = () => {}, maxAgeMs = TREE_CACHE_MAX_AGE_MS, maxTrees = TREE_CACHE_MAX_TREES, debounceMs = 2000 } = {}) {
    this.file = file || null;
    this.log = log;
    this.maxAgeMs = maxAgeMs;
    this.maxTrees = maxTrees;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.loaded = null;
    this.lastWrittenAt = null;
    this.lastWrittenCount = 0;
  }

  // Read once at boot. The result is kept for `/api/state` (`treeList.at`), so the flag and the rows cannot disagree.
  read({ now = Date.now() } = {}) {
    this.loaded = readTreeCache(this.file, { now, maxAgeMs: this.maxAgeMs, maxTrees: this.maxTrees, log: this.log });
    return this.loaded;
  }

  get at() {
    return this.loaded?.at || null;
  }

  get count() {
    return this.loaded?.trees?.length || 0;
  }

  // The rows the store holds, in the shape `writeTreeCache` wants. A store is the only caller; a Map is the only
  // thing this asks of it, which is why the module can stay free of the store's own class.
  static rowsOf(store) {
    const rows = [];
    // The store keys a row as `<project>::<path>` and the row object itself does not carry `project` (the client's
    // `placeRow` is what adds it there). The key is the pair this module keys on everywhere, so it is read here.
    for (const [key, row] of store?.rows?.entries?.() || []) {
      const project = String(row?.project || String(key).split("::")[0] || "");
      rows.push({ project, row });
    }
    return rows;
  }

  writeFrom(store, { now = Date.now() } = {}) {
    if (!this.file || !store) return { written: 0, at: null };
    const rows = TreeCache.rowsOf(store);
    const projects = [...(store?.projects?.values?.() || [])];
    const out = writeTreeCache(this.file, { rows, projects, now, maxAgeMs: this.maxAgeMs, maxTrees: this.maxTrees, log: this.log });
    this.lastWrittenAt = new Date(now).toISOString();
    this.lastWrittenCount = out.written;
    return out;
  }

  schedule(store) {
    if (!this.file) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeFrom(store);
    }, this.debounceMs);
    this.timer.unref?.();
  }

  // The synchronous flush a shutdown, a test or a landing proof can ask for.
  flush(store) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.writeFrom(store);
  }

  state() {
    return {
      file: this.file,
      at: this.at,
      count: this.count,
      maxAgeSeconds: Math.round(this.maxAgeMs / 1000),
      lastWrittenAt: this.lastWrittenAt,
      lastWrittenCount: this.lastWrittenCount,
    };
  }
}
