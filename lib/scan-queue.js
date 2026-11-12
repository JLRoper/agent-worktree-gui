// Bounded, per-project-coalesced, visibility-prioritised pending scan set.
//
// The pool used to keep an unbounded FIFO: with two workers busy, a burst of due
// rows from a fleet of ~100 projects could leave 87 scans queued. One project with
// dozens of rows could occupy every slot, so work the reader was actually looking
// at waited behind work nobody could see. This class is the PENDING set only (a
// running scan is not pending) and knows nothing about git, the store or workers,
// so it can be driven by a synthetic clock in tests.
//
// Three rules:
//   1. bounded  - at most `maxSize` pending scans; a full queue defers new work.
//   2. coalesce - at most `maxPerProject` pending scans from any one project, so
//                 one project cannot monopolise every slot.
//   3. priority - visible-project scans (priority 0) go first; hidden work is
//                 promoted after `starvationMs` and interleaved by a fairness
//                 window so an unseen project is never starved.
//
// `enqueue` never silently drops a scan: a refused request returns a reason, and
// the caller re-requests it on its next pass (the scheduler already does exactly
// that when a pool retires). Cancellation, deletion and tombstone handling stay in
// the scheduler/pool - this class only orders and bounds.

export const QUEUE_FULL = "queue-full";
export const PROJECT_COALESCED = "project-coalesced";

export class ScanQueue {
  constructor({
    maxSize = 64,
    maxPerProject = 2,
    starvationMs = 30000,
    fairnessWindow = 3,
    now = () => Date.now(),
  } = {}) {
    this.maxSize = Math.max(1, Math.floor(maxSize) || 64);
    this.maxPerProject = Math.max(1, Math.floor(maxPerProject) || 2);
    this.starvationMs = Math.max(1, Number(starvationMs) || 30000);
    this.fairnessWindow = Math.max(1, Math.floor(fairnessWindow) || 3);
    this.now = now;
    this.jobs = [];
    this.visibleTaken = 0;
    this.refused = { full: 0, coalesced: 0 };
  }

  get size() {
    return this.jobs.length;
  }

  pendingFor(project) {
    let n = 0;
    for (const job of this.jobs) if (job.project === project) n += 1;
    return n;
  }

  has(key) {
    return this.jobs.some((job) => job.key === key);
  }

  // Returns { ok: true } or { ok: false, reason }. A refused job is NOT queued.
  enqueue({ key, project = "", priority = 1, task, resolve, reject }) {
    if (this.jobs.length >= this.maxSize) {
      this.refused.full += 1;
      return { ok: false, reason: QUEUE_FULL };
    }
    if (this.pendingFor(project) >= this.maxPerProject) {
      this.refused.coalesced += 1;
      return { ok: false, reason: PROJECT_COALESCED };
    }
    this.jobs.push({
      key,
      project,
      priority: priority === 0 ? 0 : 1,
      enqueuedAt: this.now(),
      task,
      resolve,
      reject,
    });
    return { ok: true };
  }

  // Effective priority: visible (0) or a hidden scan that has waited long enough
  // is promoted to 0. Unseen work therefore cannot starve behind a steady stream
  // of visible scans. Among equals, the oldest request wins.
  effective(job) {
    return job.priority === 0 || this.now() - job.enqueuedAt >= this.starvationMs ? 0 : 1;
  }

  // Pick the next scan to dispatch. Visible first, but after `fairnessWindow`
  // consecutive visible dispatches force the oldest hidden scan through.
  take() {
    if (!this.jobs.length) return null;
    const ranked = this.jobs
      .map((job, index) => ({ job, index, eff: this.effective(job) }))
      .sort((a, b) => a.eff - b.eff || a.job.enqueuedAt - b.job.enqueuedAt || a.index - b.index);

    let chosen = ranked[0];
    if (this.visibleTaken >= this.fairnessWindow) {
      const hidden = ranked.find((entry) => entry.eff === 1);
      if (hidden) chosen = hidden;
    }
    this.visibleTaken = chosen.eff === 0 ? this.visibleTaken + 1 : 0;
    this.jobs.splice(chosen.index, 1);
    return chosen.job;
  }

  // Everything still waiting, for the retire/close paths. Empties the queue.
  drain() {
    return this.jobs.splice(0);
  }

  stats() {
    return {
      size: this.size,
      maxSize: this.maxSize,
      maxPerProject: this.maxPerProject,
      refusedFull: this.refused.full,
      refusedCoalesced: this.refused.coalesced,
      visibleTaken: this.visibleTaken,
    };
  }
}
