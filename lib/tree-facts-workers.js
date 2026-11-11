import { Worker } from "node:worker_threads";
import { panelChildren } from "./child-tree.js";

// A timeout cancels the child, but does not free a slot until the worker really exits. This keeps a stuck native
// CreateProcess from creating an unbounded replacement fleet, and keeps its late child reports under supervision.
export class TreeFactsWorkers {
  constructor({ concurrency = 2, queueMax = 32, timeoutMs = 30_000, createWorker = null } = {}) {
    this.concurrency = concurrency;
    this.queueMax = queueMax;
    this.timeoutMs = timeoutMs;
    this.createWorker = createWorker || ((treePath) => new Worker(new URL("./tree-facts-worker.js", import.meta.url), { workerData: { treePath } }));
    this.active = new Set();
    this.queue = [];
    this.nextId = 1;
    this.closed = false;
  }

  run(treePath) {
    if (this.closed) return Promise.reject(new Error("tree facts workers are closed"));
    if (this.active.size >= this.concurrency && this.queue.length >= this.queueMax) return Promise.reject(new Error("tree facts queue full"));
    return new Promise((resolve, reject) => {
      const job = { treePath, resolve, reject, worker: null, settled: false, scope: `tree-facts:${this.nextId++}` };
      job.timer = setTimeout(() => this.finish(job, new Error("tree facts timed out")), this.timeoutMs);
      this.queue.push(job);
      this.drain();
    });
  }

  finish(job, error, facts) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    if (error) job.reject(error); else job.resolve(facts);
    if (error && job.worker) {
      job.worker.unref();
      try { job.worker.postMessage({ type: "cancel" }); } catch { /* exit already in progress */ }
      void panelChildren.killScope(job.scope, "tree facts cancelled").catch(() => {});
    } else if (!job.worker) {
      const at = this.queue.indexOf(job);
      if (at !== -1) this.queue.splice(at, 1);
      this.drain();
    }
  }

  drain() {
    while (!this.closed && this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active.add(job);
      try {
        const worker = this.createWorker(job.treePath);
        job.worker = worker;
        let gotResult = false;
        let result = null;
        worker.on("message", (message) => {
          if (message?.type === "child") {
            const adopted = panelChildren.adopt(job.scope, message.pid, { kind: "git", label: message.label });
            if (job.settled && adopted) void panelChildren.killPid(message.pid, "tree facts cancelled").catch(() => {});
          } else if (message?.type === "child-done") {
            if (panelChildren.entries.get(message.pid)?.scope === job.scope) panelChildren.release(message.pid);
          }
          else if (message?.type === "result") { gotResult = true; result = message.facts; }
        });
        worker.once("error", (error) => this.finish(job, error));
        worker.once("exit", (code) => {
          void panelChildren.killScope(job.scope, "tree facts worker exited").catch(() => {}).finally(() => {
            if (!job.settled) this.finish(job, gotResult && code === 0 ? null : new Error(`tree facts worker exited (${code})`), result);
            this.active.delete(job);
            this.drain();
          });
        });
      } catch (error) {
        this.active.delete(job);
        this.finish(job, error);
      }
    }
  }

  close() {
    this.closed = true;
    for (const job of [...this.queue, ...this.active]) this.finish(job, new Error("tree facts workers are closed"));
  }
}

export const treeFactsWorkers = new TreeFactsWorkers();
