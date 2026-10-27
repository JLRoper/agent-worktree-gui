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
export class Locks {
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
    const deadline = Date.now() + Math.max(0, waitMs);
    const ahead = await Promise.race([
      tail.then(() => true).catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), Math.max(0, waitMs))),
    ]);
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
export const locks = new Locks();

// The keys, in one place, because a second spelling of the same key is a second lock and no lock at all.
export const rollKey = (repoDir, parentBranch) =>
  `rollup:${String(repoDir || "").replace(/\\/g, "/").toLowerCase()}::${String(parentBranch || "").trim()}`;
export const stewardKey = (repoDir) => `steward:${String(repoDir || "").replace(/\\/g, "/").toLowerCase()}`;
