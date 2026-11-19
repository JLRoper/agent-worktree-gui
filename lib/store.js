// In-memory state for every project + worktree, with change events the server
// forwards over SSE. Nothing here touches git.
import { syncState } from "./sync-state.js";

export class Store {
  constructor() {
    this.projects = new Map();
    this.rows = new Map();
    this.listeners = new Set();
    this.stats = { rowEvents: 0, startedAt: new Date().toISOString() };
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(evt) {
    for (const fn of this.listeners) {
      try {
        fn(evt);
      } catch {
        /* a slow client must never break the scanner */
      }
    }
  }

  ensureProject(project) {
    const existing = this.projects.get(project.name) || {};
    // Keep everything discovery learned (activityAt, empty, lastCommit, prRepo, ...): the
    // panel orders projects by recency and needs those. Only the checked-out branch is noise.
    const meta = { ...existing, ...project, name: project.name };
    delete meta.head;
    this.projects.set(project.name, meta);
    return meta;
  }

  // A project that disappeared from the discovery roots stops being monitored, rows and all.
  dropProject(name) {
    for (const [key, row] of [...this.rows]) {
      if (key.startsWith(`${name}::`)) {
        this.rows.delete(key);
        this.emit({ type: "drop", project: name, path: row.path });
      }
    }
    return this.projects.delete(name);
  }

  patchProject(name, fields) {
    const cur = this.projects.get(name) || { name };
    const next = { ...cur, ...fields };
    this.projects.set(name, next);
    this.emit({ type: "project", project: this.publicProject(name) });
    return next;
  }

  rowKey(projectName, rowPath) {
    return `${projectName}::${rowPath}`;
  }

  rowsFor(projectName) {
    const out = [];
    for (const [key, row] of this.rows) {
      if (key.startsWith(`${projectName}::`)) out.push(row);
    }
    return out;
  }

  // Forget one row: a worktree removed on purpose. Emits the same "drop" the UI already handles when
  // a tree disappears between scans, so the row goes away without a full re-read.
  dropRow(projectName, rowPath) {
    const key = this.rowKey(projectName, rowPath);
    if (this.rows.delete(key)) this.emit({ type: "drop", project: projectName, path: rowPath });
  }

  markError(projectName, rowPath, err) {
    const key = this.rowKey(projectName, rowPath);
    // A read that failed BECAUSE the worktree was deleted must not create a row for it: the ✕ drops the
    // row, then the in-flight scan errors on the missing folder and this used to put it back as ERROR.
    const prev = this.rows.get(key);
    if (!prev) return;
    this.putRow(projectName, { ...prev, verdict: "ERROR", error: String((err && err.message) || err) }, "full", { force: true });
  }

  // A row the panel has not read yet, placed from the tree list its last successful scan wrote down (lib/tree-cache.js).
  // It is a real row in every way the page cares about - the same key, the same path, the same branch, the same agents
  // filed under it - and it is marked `cached` so the page can say the list is the cached one and the scan that
  // replaces it can be told from a genuinely new tree. Its verdict is the unknown one: a cached row has not been read
  // in this process, and claiming MERGED (or ON MAIN) from a week-old list is exactly the kind of guess the board
  // exists to avoid.
  seedCached(entry = {}) {
    const project = String(entry.project || "").trim();
    const treePath = String(entry.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!project || !treePath) return null;
    return this.putRow(
      project,
      {
        path: treePath,
        name: entry.name || treePath.split("/").filter(Boolean).pop() || treePath,
        branch: entry.branch || null,
        parent: entry.parentBranch || null,
        head: entry.sha || null,
        verdict: "…",
        cached: true,
        cachedAt: entry.readAt || null,
      },
      "fast",
      { force: true },
    );
  }

  // The tree this row names is gone from disk. Its row is KEPT - with the moment it was last read and the path it was
  // read at - so the agents filed under it stay under it and read as stale-with-reason, rather than falling into the
  // unattached list because a scan could not find their tree. The next successful read of the path clears it (putRow).
  markStale(projectName, rowPath, { reason = "the tree is gone from disk", lastSeenAt = null } = {}) {
    const key = this.rowKey(projectName, rowPath);
    const prev = this.rows.get(key);
    if (!prev) return null;
    // Re-marking the same row with the same last-seen is what every pass after the first does: no write, no event.
    if (prev.stale && String(prev.stale.lastSeenAt || "") === String(lastSeenAt || "")) return prev;
    const seen = String(lastSeenAt || prev.scannedAt || prev.cachedAt || "").trim();
    const when = seen && Number.isFinite(Date.parse(seen)) ? new Date(seen).toISOString().replace("T", " ").slice(0, 19) : "an earlier scan";
    const line = `last seen ${when} at ${rowPath} - ${reason}`;
    // FULL, not fast: the fast branch inherits the previous VERDICT by design (a cheap read cannot classify), and that
    // would immediately overwrite the one word this method is here to write.
    return this.putRow(projectName, { ...prev, verdict: "STALE", stale: { reason, lastSeenAt: seen || null, path: rowPath, line } }, "full", { force: true });
  }

  // mode "fast" merges cheap fields over the last full scan; "full" replaces the
  // expensive ones (cherry patch-ids, verdict, commit list, diffstat).
  putRow(projectName, incoming, mode = "fast", { force = false } = {}) {
    const key = this.rowKey(projectName, incoming.path);
    const prev = this.rows.get(key) || {};
    const project = this.projects.get(projectName) || {};
    let row;

    if (mode === "full") {
      row = { ...prev, ...incoming };
      row.fullAhead = incoming.ahead;
      row.fullVerdict = incoming.verdict;
      row.verdictStale = false;
    } else {
      row = { ...prev, ...incoming };
      if (incoming.verdict === "RELEASED") {
        // The path is not a tree of its own any more (lib/own-tree.js): the row says so and KEEPS saying so, with the
        // no-counts row the scan returned, instead of falling back to the verdict it held while the tree was there —
        // a released row used to keep "MERGED" (or the primary checkout's "branch main, 2 modified") for as long as
        // the leftover folder existed.
        row.verdict = "RELEASED";
        row.verdictStale = false;
      } else if (incoming.verdict === "EMPTY REPO") {
        // A repo with no commits at all: never relabel this as ON MAIN / MERGED just because
        // its branch name happens to match the main branch and its commit count is zero.
        row.verdict = "EMPTY REPO";
        row.verdictStale = false;
      } else if (incoming.ahead === 0 && incoming.baseBranch && incoming.branch === incoming.baseBranch) {
        // The row stands on ITS base - the project's main, or an environment branch (dev/qa/uat/prod) in a project
        // whose base list names one. lib/scan.js resolved which; the word keeps `ON MAIN` for the main branch because
        // the removal and reuse readers already key on it, and says `ON BASE` for any other base branch.
        row.verdict = project.mainBranch && incoming.branch === project.mainBranch ? "ON MAIN" : "ON BASE";
        row.verdictStale = false;
      } else if (prev.verdict === "RELEASED") {
        // The path is a tree again — a re-cut at the same path, or a folder somebody filled back in. The released
        // verdict described a path that was NOT a tree, so it is not inherited by one that is: the row goes back to
        // the unknown verdict a full scan classifies, instead of claiming RELEASED over a live tree's dirt.
        row.verdict = "…";
        row.verdictStale = true;
      } else if (prev.verdict === "STALE") {
        // The tree the row described was gone from disk and is being read again — a tree re-cut at the same path, or a
        // folder put back. STALE was a claim about a path that was not there, so it is not inherited: the row says
        // the verdict a full scan will classify it with, not the one its absence earned.
        row.verdict = "…";
        row.verdictStale = true;
      } else if (prev.fullAhead !== undefined && incoming.ahead === prev.fullAhead && prev.verdict) {
        row.verdict = prev.verdict; // unchanged commit count: last full verdict still holds
        row.verdictStale = false;
      } else {
        row.verdict = prev.verdict || "…";
        row.verdictStale = true; // commit count moved: a full scan will classify it
      }
    }

    row.scannedAt = new Date().toISOString();
    // A row seeded from the tree cache (lib/tree-cache.js) is a PLACEHOLDER: its path, branch and last sha are what
    // the last successful read saw, its verdict is not known yet. The first fresh scan of that path clears the flag in
    // the same put, which is how the page tells a cached first paint from a read one; `cachedAt` is when that read was.
    row.cached = Boolean(incoming.cached);
    row.cachedAt = row.cached ? incoming.cachedAt || incoming.readAt || null : null;
    // A tree that has vanished from disk keeps its row with the reason (see markStale) instead of dropping to the
    // unattached list. A scan never carries `stale`, so any successful read of the path clears it - a tree re-cut at
    // the same path is not stale for a moment longer than it takes to read it.
    row.stale = incoming.stale || null;
    // "Safe to remove" is a claim about the WORK, not about the commit graph:
    //   * MERGED…     the work is on main — by ancestry, by squash/rebase patch-id, or by identical content
    //   * NO COMMITS  the branch has nothing off main at all, so there is nothing on it to lose
    // NOT "NO COMMITS?" — the reflog could not be read, so nothing is known — and not UNMERGED, "…" or ERROR.
    // A dirty or untracked file disqualifies either verdict: it is the only copy of something, whatever the
    // branch says. So does a live run, because a worker mid-turn has often not written its first file yet.
    // Keying this on the word MERGED alone left every squashed-and-therefore-unmatched branch and every
    // zero-commit tree out of the count, which is why merged work kept sitting on the board unremarked.
    const verdict = String(row.verdict || "");
    row.mergeable =
      (verdict.startsWith("MERGED") || verdict === "NO COMMITS") &&
      row.dirty === 0 && row.untracked === 0 && !row.live;

    // The branch against its OWN copy on the remote (lib/sync-state.js) — what the Ahead / Behind column draws. It is
    // derived HERE, on every put, because its raw facts (`upstream`, `upstreamAhead`, `upstreamBehind`) arrive with
    // every scan, fast ones included, while `remoteBranch` is carried from the last full pass: a commit or a push
    // shows on the next scan instead of waiting for the next full one. `row.ahead` / `row.behind` stay the count
    // against the project's main, which the verdict is built from.
    row.sync = syncState({ row, remote: project.remote, fetchNote: project.fetchNote });

    const before = JSON.stringify({ ...prev, scannedAt: null });
    const after = JSON.stringify({ ...row, scannedAt: null });
    const changed = before !== after;
    this.rows.set(key, row);
    this.stats.rowEvents += 1;
    if (changed || force) this.emit({ type: "row", project: projectName, row, changed });
    return row;
  }

  // Liveness-only update: the cheap pass refreshes evidence without touching git fields.
  // Emits like putRow but flags it so the UI can repaint without flashing the row.
  touch(projectName, rowPath, fields) {
    const key = this.rowKey(projectName, rowPath);
    const prev = this.rows.get(key);
    if (!prev) return null;
    const row = { ...prev, ...fields };
    const before = JSON.stringify({ ...prev, scannedAt: null });
    const after = JSON.stringify({ ...row, scannedAt: null });
    if (before === after) return prev;
    this.rows.set(key, row);
    this.stats.rowEvents += 1;
    this.emit({ type: "row", project: projectName, row, changed: true, livenessOnly: true });
    return row;
  }

  summaryFor(projectName) {
    const s = { total: 0, merged: 0, unmerged: 0, noCommits: 0, onMain: 0, released: 0, staleTrees: 0, dirty: 0, live: 0, removable: 0, stale: 0 };
    for (const w of this.rowsFor(projectName)) {
      s.total += 1;
      const v = String(w.verdict || "");
      if (v.startsWith("MERGED")) s.merged += 1;
      else if (v === "ON MAIN" || v === "ON BASE") s.onMain += 1;
      else if (v.startsWith("NO COMMITS")) s.noCommits += 1;
      // A path that is not its own tree holds no work to merge: counting it as unmerged made a row whose folder was
      // left behind read as outstanding work on the project's header (lib/own-tree.js answers it, lib/scan.js reports it).
      else if (v === "RELEASED") s.released += 1;
      // A tree that vanished from disk is not outstanding work either: it is a row kept so its agents stay under it
      // with the reason, and counting it under UNMERGED would put a claim on the project header that nothing read.
      else if (v === "STALE") s.staleTrees += 1;
      else s.unmerged += 1;
      if (w.dirty || w.untracked) s.dirty += 1;
      if (w.live) s.live += 1;
      if (w.mergeable) s.removable += 1;
      if (w.verdictStale) s.stale += 1;
    }
    return s;
  }

  publicProject(name) {
    const p = this.projects.get(name) || { name };
    return { ...p, summary: this.summaryFor(name) };
  }

  // Why the project's last fetch failed, as `Scheduler.maybeFetch` recorded it (null once a fetch succeeds). A row
  // quotes it, so the reader learns *why* the remote could not be asked without leaving the branch cell.
  fetchNoteFor(name) {
    return String(this.projects.get(name)?.fetchNote || "");
  }

  snapshot({ tookMs = null, settings = {} } = {}) {
    return {
      generatedAt: new Date().toISOString(),
      tookMs,
      settings,
      stats: this.stats,
      projects: [...this.projects.keys()].map((name) => ({
        ...this.publicProject(name),
        worktrees: this.rowsFor(name).sort((a, b) => String(a.path).localeCompare(String(b.path))),
      })),
    };
  }
}
