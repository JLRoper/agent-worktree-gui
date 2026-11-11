import { Worker } from "node:worker_threads";

// One-shot workers isolate synchronous filesystem calls. Slots remain occupied until exit, even
// after a timeout, so a stalled native filesystem call cannot spawn an unlimited replacement fleet.
export class TierSignalWorkers {
  constructor({ concurrency = 2, queueMax = 32, timeoutMs = 30000, createWorker = null } = {}) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.queueMax = Math.max(0, Math.floor(queueMax));
    this.timeoutMs = timeoutMs;
    this.createWorker = createWorker || ((repoPath) => new Worker(new URL("./tier-signal-worker.js", import.meta.url), { workerData: { repoPath } }));
    this.active = 0;
    this.queue = [];
  }

  run(repoPath, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(new Error("tier signal cancelled"));
    if (this.active >= this.concurrency && this.queue.length >= this.queueMax) {
      return Promise.reject(new Error("tier signal queue full"));
    }
    return new Promise((resolve, reject) => {
      const job = { repoPath, resolve, reject, signal, worker: null, settled: false, timer: null, onAbort: null };
      job.onAbort = () => this.finish(job, new Error("tier signal cancelled"));
      signal?.addEventListener("abort", job.onAbort, { once: true });
      job.timer = setTimeout(() => this.finish(job, new Error("tier signal timed out")), Math.max(1, timeoutMs));
      this.queue.push(job);
      this.drain();
    });
  }

  finish(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.onAbort);
    if (error) job.reject(error);
    else job.resolve(result);
    if (job.worker) {
      // Do not free the slot until the worker actually exits.
      job.worker.unref();
      void job.worker.terminate().catch(() => {});
    } else {
      const index = this.queue.indexOf(job);
      if (index !== -1) this.queue.splice(index, 1);
      this.drain();
    }
  }

  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      try {
        const worker = this.createWorker(job.repoPath);
        job.worker = worker;
        worker.once("message", (message) => {
          if (message?.error) this.finish(job, new Error(`tier signal worker: ${message.error}`));
          else if (!message?.signal || typeof message.signal !== "object") this.finish(job, new Error("tier signal worker returned no signal"));
          else this.finish(job, null, message.signal);
        });
        worker.once("error", (error) => this.finish(job, error));
        worker.once("exit", (code) => {
          if (!job.settled) this.finish(job, new Error(`tier signal worker exited without a result (${code})`));
          this.active -= 1;
          this.drain();
        });
      } catch (error) {
        this.active -= 1;
        this.finish(job, error);
      }
    }
  }
}
