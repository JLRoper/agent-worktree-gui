import { Worker } from "node:worker_threads";

const READS = new Set(["commitOf", "pinOf", "pinCheck", "workingBlobOf"]);

// A running read is never terminated on a timer: its synchronous Git child
// could outlive the worker. Slots remain occupied until exit, including on error.
export class PipelineGitWorkers {
  constructor({ concurrency = 1, queueMax = 32, timeoutMs = 30000, createWorker = null } = {}) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.queueMax = Math.max(0, Math.floor(queueMax));
    this.timeoutMs = timeoutMs;
    this.createWorker = createWorker || ((operation, args) => new Worker(new URL("./pipeline-git-worker.js", import.meta.url), { workerData: { operation, args } }));
    this.active = 0;
    this.queue = [];
  }

  run(operation, args) {
    if (!READS.has(operation) || !Array.isArray(args)) return Promise.reject(new Error("invalid pipeline git operation"));
    if (this.active >= this.concurrency && this.queue.length >= this.queueMax) return Promise.reject(new Error("pipeline git queue full"));
    return new Promise((resolve, reject) => {
      const job = { operation, args, resolve, reject, timer: null, worker: null, settled: false };
      job.timer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        job.settled = true;
        reject(new Error(index >= 0 ? "pipeline git queue timed out before starting" : "pipeline git read timed out and is still running"));
        // A blocked native call can outlive the request, but cannot hold process
        // shutdown or free a slot for an unbounded replacement worker fleet.
        job.worker?.unref();
      }, Math.max(1, this.timeoutMs));
      this.queue.push(job);
      this.drain();
    });
  }

  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      let worker;
      try {
        worker = this.createWorker(job.operation, job.args);
        job.worker = worker;
      } catch (error) {
        clearTimeout(job.timer);
        this.active -= 1;
        job.reject(error);
        continue;
      }
      let message = null;
      let failure = null;
      worker.once("message", (value) => { message = value; });
      worker.once("error", (error) => { failure = error; });
      worker.once("exit", (code) => {
        clearTimeout(job.timer);
        this.active -= 1;
        if (!job.settled) {
          if (failure) job.reject(failure);
          else if (code !== 0) job.reject(new Error(`pipeline git worker exited (${code})`));
          else if (!message || typeof message !== "object") job.reject(new Error("pipeline git worker exited without a result"));
          else if (message.error) job.reject(new Error(`pipeline git worker: ${message.error}`));
          else if (!Object.hasOwn(message, "result")) job.reject(new Error("pipeline git worker returned no result"));
          else job.resolve(message.result);
        }
        this.drain();
      });
    }
  }
}

const readers = new PipelineGitWorkers({ concurrency: 2 });

export function readStagePin(operation, args) {
  if (!READS.has(operation)) return Promise.reject(new Error("invalid stage pin read"));
  return readers.run(operation, args);
}
