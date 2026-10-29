// A reader's lock on a worktree or on a branch — the one thing in this panel that is the reader's and not git's.
//
// WHY IT EXISTS: every delete path in the panel is an agent-facing one. The row's ✕ is pressed by the reader, but a
// merge agent finishes its landing and tidies up, an agent in a tree can run `git worktree remove` in its own shell,
// and the panel's own cleanup runs on the ✕'s route. A lock is the reader saying "not this tree, not this branch" in
// a way that outlives the process: it is persisted beside the job store (logs/locks.json) and consulted by the delete
// route, the merge agent's script, and the row itself.
//
// TWO SCOPES, deliberately:
//   - a WORKTREE lock names one directory. It survives a restart and dies with the row it names.
//   - a BRANCH lock names one branch. It protects every worktree on that branch NOW and every one cut from it later,
//     which is what keeps a turnover branch safe while trees come and go. A branch that is renamed while locked is
//     no longer covered by the name-based record — the tree lock is the durable half, and the panel says so when a
//     rename moves a locked tree.
//
// Default is UNLOCKED, and absence is the whole representation of that: a map with no entry answers "not locked", so
// a store that cannot be read can never make a tree look protected (the safe direction for a reader who has not asked
// for a lock), and a lock that cannot be written is reported rather than silently forgotten.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LOCKS_VERSION = 1;

// Rows are keyed with forward slashes and no trailing slash (lib/scan.js), and Windows paths are case-insensitive, so
// the lock's key is normalised the same way. `treeNames.normTreePath` is deliberately not reused: this module must
// not gain a dependency on the naming ledger for one string function.
export const normLockPath = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

const nameOf = (treePath) => String(treePath ?? "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).pop() || String(treePath ?? "");

export function treeLockKey(project, treePath) {
  const name = String(project ?? "").trim();
  const p = normLockPath(treePath);
  return name && p ? `${name}::${p}` : null;
}

export function branchLockKey(project, branch) {
  const name = String(project ?? "").trim();
  const b = String(branch ?? "").trim();
  return name && b ? `${name}::${b}` : null;
}

// The one sentence every refusal uses, so the row, the route and the merge agent cannot disagree about why a delete
// was refused. It names the lock — which scope, and on what — because "refused" with no reason reads as a bug.
export function lockReason(lock) {
  if (!lock || !lock.locked) return "";
  if (lock.by === "branch") {
    return `🔒 locked branch: ${lock.branch} is locked by ${lock.branchBy || "the reader"} — every worktree on it is protected, this one included. Unlock the branch in the row before anything may delete it.`;
  }
  return `🔒 locked worktree: ${nameOf(lock.path)} is locked by ${lock.treeBy || "the reader"} — nothing may delete this worktree until the lock is removed in the row.`;
}

// What a stored entry says in one line, for a tooltip.
export function describeLock(entry, label) {
  if (!entry) return "";
  const when = entry.at ? String(entry.at).replace("T", " ").slice(0, 19) : "";
  const who = entry.by || "the reader";
  return [`🔒 ${label} locked by ${who}`, when ? `on ${when}` : null].filter(Boolean).join(" ");
}

export class Locks {
  constructor({ file = null, log = () => {} } = {}) {
    this.file = file || null;
    this.log = log;
    this.trees = new Map(); // `${project}::${normalised path}` -> entry
    this.branches = new Map(); // `${project}::${branch}` -> entry
    this.loaded = false;
  }

  // A missing file is the normal first-run answer (everything unlocked). A file that does not parse is reported and
  // read as "nothing locked": a broken lock store must not make a worktree undeletable with no way to say why.
  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const trees = raw && typeof raw === "object" && raw.trees && typeof raw.trees === "object" ? raw.trees : {};
      const branches = raw && typeof raw === "object" && raw.branches && typeof raw.branches === "object" ? raw.branches : {};
      for (const [key, rec] of Object.entries(trees)) if (rec && typeof rec === "object") this.trees.set(key, rec);
      for (const [key, rec] of Object.entries(branches)) if (rec && typeof rec === "object") this.branches.set(key, rec);
    } catch (err) {
      if (existsSync(this.file)) this.log(`locks: could not read ${this.file} (${String((err && err.message) || err)}) — starting unlocked`);
    }
    return this;
  }

  get size() {
    this.load();
    return this.trees.size + this.branches.size;
  }

  treeEntry(project, treePath) {
    this.load();
    const key = treeLockKey(project, treePath);
    return (key && this.trees.get(key)) || null;
  }

  branchEntry(project, branch) {
    this.load();
    const key = branchLockKey(project, branch);
    return (key && this.branches.get(key)) || null;
  }

  treeLocked(project, treePath) {
    return Boolean(this.treeEntry(project, treePath));
  }

  branchLocked(project, branch) {
    return Boolean(this.branchEntry(project, branch));
  }

  // The question every delete path asks: is this tree, or the branch it is on, locked? `locked` is the answer and
  // `by` says which scope refused, because a reader who unlocks the tree and is still refused must be told to unlock
  // the branch. `tree`/`branch` are the two independent bits, for the row's two toggles.
  check({ project, path: treePath, branch } = {}) {
    const treeEntry_ = this.treeEntry(project, treePath);
    const branchEntry_ = branch ? this.branchEntry(project, branch) : null;
    const lock = {
      tree: Boolean(treeEntry_),
      // `branch` is the branch's NAME, and `branchLocked` is the boolean — they are different questions and a row
      // with a branch but no lock must not read as locked. `by` names whichever lock actually refused.
      branch: branch ? String(branch) : null,
      branchLocked: Boolean(branchEntry_),
      locked: Boolean(treeEntry_ || branchEntry_),
      by: treeEntry_ ? "tree" : branchEntry_ ? "branch" : null,
      path: treePath ? String(treePath).replace(/\\/g, "/") : null,
      at: (treeEntry_ || branchEntry_)?.at || null,
      treeBy: treeEntry_?.by || null,
      branchBy: branchEntry_?.by || null,
      reason: "",
    };
    lock.reason = lockReason(lock);
    return lock;
  }

  // Set (or clear) one scope. `locked: false` forgets the entry rather than storing a false one: absence is the
  // representation of "unlocked", so a file with a stale `locked:false` record can never disagree with the default.
  setTree(project, treePath, locked, { by = "the reader", branch = null, files = null } = {}) {
    this.load();
    const key = treeLockKey(project, treePath);
    if (!key) return null;
    if (!locked) {
      const had = this.trees.delete(key);
      if (had) this.save();
      return { ok: true, key, locked: false, removed: had };
    }
    const entry = {
      project: String(project ?? "").trim(),
      path: String(treePath).replace(/\\/g, "/"),
      branch: branch ? String(branch) : null,
      by,
      at: new Date().toISOString(),
      files: files ? String(files) : null,
    };
    this.trees.set(key, entry);
    this.save();
    return { ok: true, key, locked: true, entry };
  }

  setBranch(project, branch, locked, { by = "the reader", path: treePath = null } = {}) {
    this.load();
    const key = branchLockKey(project, branch);
    if (!key) return null;
    if (!locked) {
      const had = this.branches.delete(key);
      if (had) this.save();
      return { ok: true, key, locked: false, removed: had };
    }
    const entry = {
      project: String(project ?? "").trim(),
      branch: String(branch),
      path: treePath ? String(treePath).replace(/\\/g, "/") : null,
      by,
      at: new Date().toISOString(),
    };
    this.branches.set(key, entry);
    this.save();
    return { ok: true, key, locked: true, entry };
  }

  // One toggle, the shape the route and the row use. `scope` is "tree" or "branch"; `locked` omitted means flip.
  // A tree with no path and a branch with no name are refused by name rather than silently doing nothing.
  toggle({ project, path: treePath = null, branch = null, scope = "tree", locked = null } = {}) {
    this.load();
    if (scope === "branch") {
      if (!String(branch ?? "").trim()) return { ok: false, error: "this row has no branch to lock" };
      const now = this.branchLocked(project, branch);
      const want = locked === null || locked === undefined ? !now : Boolean(locked);
      return { ...this.setBranch(project, branch, want, { path: treePath }), scope: "branch", branch: String(branch) };
    }
    if (!String(treePath ?? "").trim()) return { ok: false, error: "a worktree path is required to lock a worktree" };
    const now = this.treeLocked(project, treePath);
    const want = locked === null || locked === undefined ? !now : Boolean(locked);
    return { ...this.setTree(project, treePath, want, { branch }), scope: "tree", path: String(treePath).replace(/\\/g, "/") };
  }

  // Everything currently locked, for /api/state and for a reader who wants the list without the board.
  list() {
    this.load();
    return {
      trees: [...this.trees.values()].map((e) => ({ project: e.project, path: e.path, branch: e.branch || null, by: e.by || null, at: e.at || null })),
      branches: [...this.branches.values()].map((e) => ({ project: e.project, branch: e.branch, path: e.path || null, by: e.by || null, at: e.at || null })),
    };
  }

  save() {
    if (!this.file) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = {
        version: LOCKS_VERSION,
        savedAt: new Date().toISOString(),
        trees: Object.fromEntries(this.trees),
        branches: Object.fromEntries(this.branches),
      };
      // Written beside the target and renamed over it: a reader (or a crash) never sees half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // A lock that cannot be written is a lock that would not survive the restart the reader asked it for: say so
      // instead of reporting a success the file does not hold.
      this.log(`locks: could not write ${this.file} (${String((err && err.message) || err)})`);
      return false;
    }
  }
}

// One writer per key, in this process.
//
// A roll-up is a merge run INSIDE the parent's worktree: two children rolled into the same parent at the same
// moment would both drive `git merge` there and the second would either die on the locked index or land on top
// of a half-written merge. The panel is the only writer — every route, the steward and the merge chip all run
// in this one Node process — so an in-process queue is the whole lock: no lockfile, no pid to go stale, nothing
// left behind when a run dies.
//
// The key is whatever the caller means by "the same resource", and the two used here are:
//   rollup:<repo>::<parentBranch>   the parent's worktree, and
//   steward:<repo>                  a whole-project act pass (delete + roll), so two confirms cannot interleave.
// A second, different job for this module: one WRITER per key, in this process. The class is deliberately
// separate from the reader's persisted tree/branch locks above — those outlive the process, this one cannot
// and must not: it is a queue inside this Node process, and nothing is left behind when a run dies.
export class WriterLocks {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog;
    this.chains = new Map(); // key -> tail promise
    this.held = new Map(); // key -> {since, holder}
    this.seq = 0;
  }

  isBusy(key) {
    return this.held.has(String(key));
  }

  // Run fn() once the key is free. Never rejects for the lock itself until the wait runs out: a caller that
  // cannot get the lock inside `waitMs` is told, rather than queued forever behind a hung merge.
  async with(key, fn, { waitMs = 120000, holder = "" } = {}) {
    const k = String(key);
    const tail = this.chains.get(k) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const mine = tail.catch(() => {}).then(() => gate);
    this.chains.set(k, mine);
    // The wait timer is cleared the moment the race settles, whatever wins. A timer left running would keep the
    // process (and every node:test) alive for `waitMs` after the lock was long gone — the acquire-path timer is
    // waiting on nothing once `tail` has resolved or timed out.
    let timer = null;
    const ahead = await Promise.race([
      tail.then(() => true).catch(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, waitMs));
      }),
    ]);
    clearTimeout(timer);
    if (!ahead) {
      // The waiter never took the lock: drop its gate so the chain behind it is not held by a call that gave up.
      release();
      throw new Error(`busy: ${k} is held by ${this.held.get(k)?.holder || "another writer"} — waited ${Math.round(waitMs / 1000)}s`);
    }
    const since = Date.now();
    this.held.set(k, { since, holder: holder || "panel", id: ++this.seq });
    try {
      return await fn();
    } finally {
      this.held.delete(k);
      release();
      if (this.chains.get(k) === mine) this.chains.delete(k);
    }
  }

  state() {
    return [...this.held.entries()].map(([key, v]) => ({ key, heldForMs: Date.now() - v.since, holder: v.holder }));
  }
}

// The panel's one lock set. Exported so tests can build their own without touching this one.
export const writerLocks = new WriterLocks();

// The keys, in one place, because a second spelling of the same key is a second lock and no lock at all.
export const rollKey = (repoDir, parentBranch) =>
  `rollup:${String(repoDir || "").replace(/\\/g, "/").toLowerCase()}::${String(parentBranch || "").trim()}`;
export const stewardKey = (repoDir) => `steward:${String(repoDir || "").replace(/\\/g, "/").toLowerCase()}`;
// A rebase writes ONE branch, in the worktree that has it checked out — so the branch is the resource, not a parent
// and not the repo. A second replay in the same checkout would drive the same index while a rebase is half-applied.
export const rebaseKey = (repoDir, branch) =>
  `rebase:${String(repoDir || "").replace(/\\/g, "/").toLowerCase()}::${String(branch || "").trim()}`;
