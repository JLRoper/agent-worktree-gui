import { Worker } from "node:worker_threads";
import { roundTreeNames } from "./round-tree-names.js";

export const ROUND_NAMES_REFRESH_MS = 5_000;
const WORKER_TIMEOUT_MS = 10_000;

// The worker uses the queue's own reader, including its normalization and caps. Local writes are applied immediately;
// a read already in flight must not replace a newer write with its older snapshot.
export class RoundNameIndex {
  constructor({ files, onChange = () => {}, onError = () => {} }) {
    this.files = files;
    this.onChange = onChange;
    this.onError = onError;
    this.entries = new Map();
    this.revisions = new Map();
    this.index = new Map();
    this.pending = null;
    this.worker = null;
    this.timer = null;
    this.notificationPending = false;
    this.roster = [];
  }

  names() { return this.index; }

  rebuild() {
    const merged = new Map();
    this.roster = this.files();
    for (const file of this.roster) {
      for (const [key, name] of this.entries.get(file) || []) {
        const prev = merged.get(key);
        if (prev && prev.taskId != null && (name.taskId == null || name.taskId <= prev.taskId)) continue;
        merged.set(key, name);
      }
    }
    const changed = JSON.stringify([...this.index]) !== JSON.stringify([...merged]);
    this.index = merged;
    return changed;
  }

  syncRoster() {
    const files = this.files();
    if (files.length === this.roster.length && files.every((file, i) => file === this.roster[i])) return;
    if (this.rebuild()) this.notify();
  }

  write(file, tasks) {
    this.revisions.set(file, (this.revisions.get(file) || 0) + 1);
    this.entries.set(file, [...roundTreeNames(tasks)]);
    if (this.rebuild()) this.notify();
  }

  notify() {
    if (this.notificationPending) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      try { this.onChange(); } catch (err) { this.onError(err); }
    });
  }

  refresh() {
    if (this.pending) return this.pending;
    if (this.worker) return Promise.reject(new Error("previous round-name worker is still stopping"));
    const files = this.files();
    const revisions = new Map(files.map((file) => [file, this.revisions.get(file) || 0]));
    const work = new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./round-name-worker.js", import.meta.url), { workerData: files });
      this.worker = worker;
      let received = false;
      let result;
      const timer = setTimeout(() => {
        worker.unref();
        void worker.terminate().catch(() => {});
        reject(new Error("round-name refresh timed out"));
      }, WORKER_TIMEOUT_MS);
      timer.unref?.();
      worker.once("message", (value) => { received = true; result = value; });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        clearTimeout(timer);
        if (this.worker === worker) this.worker = null;
        if (received && code === 0) resolve(result);
        else reject(new Error(`round-name worker exited without a result (code ${code})`));
      });
    }).then((entries) => {
      const current = new Set(this.files());
      for (const file of this.entries.keys()) if (!current.has(file)) this.entries.delete(file);
      for (const [file, names] of entries) {
        if (current.has(file) && (this.revisions.get(file) || 0) === revisions.get(file)) this.entries.set(file, names);
      }
      if (this.rebuild()) this.notify();
      return this.index;
    });
    this.pending = work.finally(() => { this.pending = null; });
    return this.pending;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh().catch(this.onError); }, ROUND_NAMES_REFRESH_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
