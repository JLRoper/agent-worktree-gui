// Fixed-size worker_threads pool. Each worker handles one scan at a time; the pool keeps
// N scans in flight and queues the rest, so a burst of worktrees never spawns an
// unbounded number of processes.
//
// Two guarantees the scheduler relies on:
//   * the same (worktree, depth) scan is never queued twice — a duplicate request gets the
//     in-flight promise back instead of forking another git;
//   * two scans of the SAME worktree never run at the same time — they queue behind each
//     other, so a cheap scan and an expensive one cannot race into the same row.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The panel's registry. A worker's git children are real processes this panel owns, so the pool adopts each
// pid the worker reports and kills it when that scan settles, when the scan's deadline fires, and when the
// pool closes. Terminating a worker thread does NOT touch the child it started.
import { panelChildren, scopeForScan } from "./child-tree.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "scan-worker.js");
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export class Pool {
  constructor(size = 4, { timeoutMs = 90000 } = {}) {
    this.size = Math.max(1, size);
    this.timeoutMs = timeoutMs;
    this.workers = [];
    this.queue = [];
    this.active = new Map(); // "path::depth" -> promise
    this.chains = new Map(); // "path" -> tail of that worktree's scan queue
    this.nextId = 1;
    this.closed = false;
    this.completed = 0;
    // Pids the pool refused to signal because the registry no longer owned them — a stale number is not ours to
    // kill. Counted rather than logged one by one: a retiring pool can carry a dozen per worker.
    this.skipped = 0;
    for (let i = 0; i < this.size; i++) this.spawn();
  }

  spawn() {
    if (this.closed) return;
    const w = new Worker(WORKER);
    w.busy = false;
    w.pending = null;
    // The pids this worker reported and the panel adopted, so a worker that dies takes its git with it.
    w.children = new Set();
    w.on("message", (m) => {
      // A worker's child report is not a scan answer: register it and keep waiting for the result frame.
      if (m && m.type === "child") {
        if (panelChildren.adopt(scopeForScan(m.scanId), m.pid, { kind: "git", label: m.label })) w.children.add(m.pid);
        return;
      }
      if (m && m.type === "child-done") {
        w.children.delete(m.pid);
        panelChildren.release(m.pid);
        return;
      }
      const p = w.pending;
      w.pending = null;
      w.busy = false;
      if (p && p.id === m.id) {
        clearTimeout(p.timer);
        this.completed += 1;
        // The scan settled: nothing it started may outlive it. Its own worker already swept the scope; this
        // is the panel's side of the same decision, and the place a straggler is caught. Fire-and-forget:
        // the kill is async so it runs beside the loop rather than inside it (lib/child-tree.js `killTree`).
        void panelChildren.killScope(scopeForScan(m.id), "the scan settled");
        for (const pid of [...w.children]) if (!panelChildren.has(pid)) w.children.delete(pid);
        if (m.ok) p.resolve(m.result !== undefined ? m.result : m.row);
        else p.reject(new Error(m.error || "scan failed"));
      }
      this.pump();
    });
    w.on("error", (e) => {
      const p = w.pending;
      w.pending = null;
      w.busy = false;
      if (p) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.killWorkerChildren(w, "the worker errored");
      this.pump();
    });
    w.on("exit", () => {
      this.killWorkerChildren(w, "the worker exited");
      this.workers = this.workers.filter((x) => x !== w);
      if (!this.closed) {
        this.spawn();
        this.pump();
      }
    });
    this.workers.push(w);
  }

  // Everything this worker started, killed with its tree. Called when the worker exits, errors, times out,
  // or the pool retires. ONLY A PID THIS PANEL STILL OWNS IS SIGNALLED: `w.children` is a set the worker feeds and
  // a pid that has already been released is a number the OS is free to hand to another process — including this
  // one. `taskkill /T /F` takes the number on trust, so a stale entry here was a way to kill an unrelated process:
  // the live panel died on the first pool rebuild for exactly that reason (a child that had already finished was
  // signalled again by number, and the number had been reused).
  killWorkerChildren(w, reason) {
    if (!w || !w.children) return 0;
    let n = 0;
    for (const pid of [...w.children]) {
      if (!panelChildren.has(pid)) {
        this.skipped += 1;
        continue;
      }
      n += 1;
      void panelChildren.killPid(pid, reason);
      panelChildren.release(pid);
    }
    w.children.clear();
    return n;
  }

  run(task, key = `${norm(task.wtPath)}::${task.depth || "fast"}`) {
    // A retired pool must not accept work: the promise would be queued behind `pump()` returning early and never
    // settle, which is how a scheduler pass waits forever. The caller has the new pool by then; this is the guard
    // for the one that slips through the swap.
    if (this.closed) return Promise.reject(new Error("the pool is retired"));
    const existing = this.active.get(key);
    if (existing) return existing; // already queued or scanning: do not fork git again
    const pathKey = norm(task.wtPath);
    const tail = this.chains.get(pathKey) || Promise.resolve();
    const p = tail
      .catch(() => {})
      .then(
        () =>
          new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.pump();
          }),
      );
    this.chains.set(pathKey, p.catch(() => {})); // keep the chain alive past a failure
    this.active.set(key, p);
    const done = () => this.active.delete(key);
    p.then(done, done);
    return p;
  }

  // A project's own git reads - its meta and its `worktree list` - run in a worker thread too. They are the two
  // spawn-heavy calls on the panel's refresh path, and a `CreateProcess` under this machine's endpoint filter blocks
  // whichever event loop starts it, so leaving them on the main thread is what made `/api/state` answer in seconds
  // while the fleet was being mapped. Both answers ride back in one job: the reconcile that consumes the tree list
  // costs no second git call.
  meta(project) {
    if (!project?.name || !project?.path) return Promise.reject(new Error("meta: a project needs a name and a path"));
    return this.run({ kind: "meta", wtPath: project.path, project }, `meta::${project.name}`);
  }

  // true while this worktree has a scan queued or running (either depth)
  isBusy(wtPath) {
    const k = norm(wtPath);
    for (const key of this.active.keys()) if (key.startsWith(`${k}::`)) return true;
    return false;
  }

  pump() {
    if (this.closed) return;
    for (const w of this.workers) {
      if (w.busy || this.queue.length === 0) continue;
      const job = this.queue.shift();
      const id = this.nextId++;
      w.busy = true;
      const timer = setTimeout(() => {
        // The deadline belongs to the scan, not only to this promise: the git it started dies with its tree,
        // and the worker is retired so a half-finished scan cannot hand its leftovers to the next job.
        void panelChildren.killScope(scopeForScan(id), "the scan timed out");
        this.killWorkerChildren(w, "the scan timed out");
        try {
          w.terminate();
        } catch {
          /* a worker that already exited is the same outcome */
        }
        w.pending = null;
        w.busy = false;
        job.reject(new Error("scan timed out"));
        this.pump();
      }, this.timeoutMs);
      w.pending = { id, resolve: job.resolve, reject: job.reject, timer };
      w.postMessage({ id, ...job.task });
    }
  }

  get inFlight() {
    return this.workers.filter((w) => w.busy).length;
  }

  get queued() {
    return this.queue.length;
  }

  // The shutdown path: a scan in flight is already doomed (the panel is going away), so every pending job is
  // rejected and every worker's tree is killed. `settle` is what keeps a promise from being stranded — a rejected
  // job is a scheduler that can log and move on, a dropped one is a pass that waits forever.
  close() {
    this.closed = true;
    for (const w of this.workers) {
      const p = w.pending;
      if (p) {
        clearTimeout(p.timer);
        w.pending = null;
        w.busy = false;
        p.reject(new Error("the pool closed"));
      }
      this.killWorkerChildren(w, "the pool closed");
    }
    for (const w of this.workers) w.terminate();
    for (const job of this.queue.splice(0)) job.reject(new Error("the pool closed"));
    this.workers = [];
    this.active.clear();
    this.chains.clear();
  }

  // The REPLACEMENT path, and the one the settings route uses when `threads` moves: no scan is cut in half. The
  // queue is refused (the scheduler re-requests those rows on its next pass, so nothing is lost), the workers in
  // flight finish the scan they hold, and each thread is terminated once the pool has nothing left running.
  //
  // `close()` used to be called from that route, on a pool with a full queue: it terminated three workers mid-scan,
  // stranded their promises, and signalled pids it no longer owned — the panel died on the first save.
  retire() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("the pool retired — the row is re-read on the next pass"));
    const finish = () => {
      if (this.inFlight > 0) {
        setTimeout(finish, 250).unref?.();
        return;
      }
      for (const w of this.workers) this.killWorkerChildren(w, "the pool retired");
      for (const w of this.workers) {
        try {
          w.terminate();
        } catch {
          /* a worker that already exited is the same outcome */
        }
      }
      this.workers = [];
      this.active.clear();
      this.chains.clear();
    };
    finish();
  }
}
