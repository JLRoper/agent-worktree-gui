// In-memory state for every project + worktree, with change events the server
// forwards over SSE. Nothing here touches git.
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

  // Forget one row: a worktree removed on purpose. Emits the same "drop" the UI already handles when
  // a tree disappears between scans, so the row goes away without a full re-read.
  dropRow(projectName, rowPath) {
    const key = this.rowKey(projectName, rowPath);
    const row = this.rows.get(key);
    if (!row) return false;
    this.rows.delete(key);
    this.emit({ type: "drop", project: projectName, path: rowPath });
    return true;
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
      if (incoming.verdict === "EMPTY REPO") {
        // A repo with no commits at all: never relabel this as ON MAIN / MERGED just because
        // its branch name happens to match the main branch and its commit count is zero.
        row.verdict = "EMPTY REPO";
        row.verdictStale = false;
      } else if (incoming.ahead === 0 && incoming.branch === project.mainBranch) {
        row.verdict = "ON MAIN";
        row.verdictStale = false;
      } else if (prev.fullAhead !== undefined && incoming.ahead === prev.fullAhead && prev.verdict) {
        row.verdict = prev.verdict; // unchanged commit count: last full verdict still holds
        row.verdictStale = false;
      } else {
        row.verdict = prev.verdict || "…";
        row.verdictStale = true; // commit count moved: a full scan will classify it
      }
    }

    row.scannedAt = new Date().toISOString();
    row.mergeable = String(row.verdict || "").startsWith("MERGED") && row.dirty === 0 && row.untracked === 0;

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
    const s = { total: 0, merged: 0, unmerged: 0, noCommits: 0, onMain: 0, dirty: 0, live: 0, removable: 0, stale: 0 };
    for (const w of this.rowsFor(projectName)) {
      s.total += 1;
      const v = String(w.verdict || "");
      if (v.startsWith("MERGED")) s.merged += 1;
      else if (v === "ON MAIN") s.onMain += 1;
      else if (v.startsWith("NO COMMITS")) s.noCommits += 1;
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
