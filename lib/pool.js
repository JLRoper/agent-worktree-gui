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
    for (let i = 0; i < this.size; i++) this.spawn();
  }

  spawn() {
    if (this.closed) return;
    const w = new Worker(WORKER);
    w.busy = false;
    w.pending = null;
    w.on("message", (m) => {
      const p = w.pending;
      w.pending = null;
      w.busy = false;
      if (p && p.id === m.id) {
        clearTimeout(p.timer);
        this.completed += 1;
        if (m.ok) p.resolve(m.row);
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
      this.pump();
    });
    w.on("exit", () => {
      this.workers = this.workers.filter((x) => x !== w);
      if (!this.closed) {
        this.spawn();
        this.pump();
      }
    });
    this.workers.push(w);
  }

  run(task, key = `${norm(task.wtPath)}::${task.depth || "fast"}`) {
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

  close() {
    this.closed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.queue = [];
    this.active.clear();
    this.chains.clear();
  }
}
