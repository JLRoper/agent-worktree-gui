import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Scheduler } from "../lib/scheduler.js";
import { SIGNAL_KEYS, TierBook, statSignal, statSignalSync } from "../lib/tiers.js";
import { TierSignalWorkers } from "../lib/tier-signal-workers.js";

const synthetic = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wag-tier-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const signature = (value) => Object.fromEntries(SIGNAL_KEYS.map((key) => [key, value]));

test("a large synthetic tier walk does not block the panel timer", async (t) => {
  const repo = synthetic(t);
  for (let d = 0; d < 30; d += 1) {
    const dir = path.join(repo, `dir-${d}`);
    mkdirSync(dir);
    for (let f = 0; f < 100; f += 1) writeFileSync(path.join(dir, `file-${f}`), "x");
  }
  let timerRan = false;
  let finished = false;
  const started = Date.now();
  const timer = new Promise((resolve) => setTimeout(() => {
    timerRan = true;
    resolve({ elapsed: Date.now() - started, finished });
  }, 10));
  const scan = statSignal(repo).then((result) => {
    finished = true;
    return result;
  });
  const observation = await timer;
  const result = await scan;
  t.diagnostic(`timer: ${observation.elapsed}ms; worker scan: ${Date.now() - started}ms`);
  assert.equal(timerRan, true);
  assert.equal(observation.finished, false, "the timer fires while the worker still scans");
  assert.ok(observation.elapsed < 1500, `timer was delayed ${observation.elapsed}ms`);
  assert.deepEqual(result, statSignalSync(repo), "the worker returns the original signature");
});

test("worker preserves linked gitdir, pruning, .worktrees and symlink behavior", async (t) => {
  const root = synthetic(t);
  const repo = path.join(root, "repo");
  const gitdir = path.join(root, "gitdir");
  const common = path.join(root, "common");
  mkdirSync(path.join(common, "refs", "heads"), { recursive: true });
  mkdirSync(path.join(gitdir, "logs"), { recursive: true });
  mkdirSync(path.join(repo, "deep"), { recursive: true });
  mkdirSync(path.join(repo, "node_modules"));
  mkdirSync(path.join(repo, ".worktrees", "other"), { recursive: true });
  writeFileSync(path.join(repo, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(path.join(gitdir, "commondir"), path.relative(gitdir, common));
  for (const file of [path.join(gitdir, "index"), path.join(gitdir, "HEAD"), path.join(gitdir, "logs", "HEAD"), path.join(common, "refs", "heads", "main"), path.join(repo, "deep", "file")]) writeFileSync(file, "x");
  const pruned = path.join(repo, "node_modules", "dependency");
  const nested = path.join(repo, ".worktrees", "other", "nested");
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  const outsideFile = path.join(outside, "hidden");
  for (const file of [pruned, nested, outsideFile]) writeFileSync(file, "x");
  try {
    symlinkSync(outside, path.join(repo, "link"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
    t.diagnostic(`symlink unavailable: ${error.code}`);
  }
  const base = await statSignal(repo);
  assert.deepEqual(base, statSignalSync(repo));
  assert.ok(base.index && base.head && base.logs && base.refs, "linked and common git paths resolve");
  const future = new Date("2100-01-01T00:00:00Z");
  for (const file of [pruned, nested, outsideFile]) utimesSync(file, future, future);
  assert.deepEqual(await statSignal(repo), base, "pruned and linked targets do not influence the worktree signal");
  const watched = path.join(repo, "deep", "file");
  utimesSync(watched, future, future);
  assert.notEqual((await statSignal(repo)).worktree, base.worktree, "deep working-tree changes remain visible");
  assert.deepEqual(await statSignal(path.join(root, "missing")), signature(0));
});

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.terminations = 0;
  }
  unref() {}
  terminate() {
    this.terminations += 1;
    return Promise.resolve();
  }
  exit(code = 0) { this.emit("exit", code); }
}

test("supervisor bounds workers and queue, and holds terminating slots until exit", async () => {
  const workers = [];
  const pool = new TierSignalWorkers({ concurrency: 2, queueMax: 1, timeoutMs: 5000, createWorker: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const first = pool.run("first");
  const second = pool.run("second");
  const controller = new AbortController();
  const queued = pool.run("queued", { signal: controller.signal });
  const cancelled = assert.rejects(queued, /cancelled/);
  await assert.rejects(pool.run("overflow"), /queue full/);
  assert.equal(pool.active, 2);
  assert.equal(pool.queue.length, 1);
  controller.abort();
  await cancelled;
  assert.equal(pool.queue.length, 0);
  const replacement = pool.run("replacement");
  workers[0].emit("message", { signal: signature(1) });
  assert.deepEqual(await first, signature(1));
  assert.equal(workers.length, 2, "a terminating worker still occupies its slot");
  assert.equal(workers[0].terminations, 1);
  workers[0].exit();
  assert.equal(workers.length, 3);
  workers[1].emit("message", { signal: signature(2) });
  workers[2].emit("message", { signal: signature(3) });
  assert.deepEqual(await second, signature(2));
  assert.deepEqual(await replacement, signature(3));
  workers[1].exit();
  workers[2].exit();
  assert.equal(pool.active, 0);
  assert.equal(pool.queue.length, 0);
});

test("timeouts and aborts reject without leaking queue entries or exceeding the worker limit", async () => {
  const workers = [];
  const pool = new TierSignalWorkers({ concurrency: 1, queueMax: 1, timeoutMs: 30, createWorker: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const active = assert.rejects(pool.run("active"), /timed out/);
  const waiting = assert.rejects(pool.run("waiting"), /timed out/);
  await Promise.all([active, waiting]);
  assert.equal(pool.active, 1, "timeout cannot free a worker stuck in a native call");
  assert.equal(pool.queue.length, 0);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminations, 1);
  workers[0].exit();
  assert.equal(pool.active, 0);
  const controller = new AbortController();
  const cancelled = assert.rejects(pool.run("cancelled", { signal: controller.signal }), /cancelled/);
  controller.abort();
  await cancelled;
  assert.equal(workers[1].terminations, 1);
  workers[1].exit();
  assert.equal(pool.active, 0);
  await assert.rejects(pool.run("already-cancelled", { signal: controller.signal }), /cancelled/);
});

test("real non-cooperating workers exit after timeout and cancellation", async (t) => {
  const workers = [];
  const pool = new TierSignalWorkers({ concurrency: 1, timeoutMs: 1000, createWorker: () => {
    const worker = new Worker(new URL("data:text/javascript,while(true)%7B%7D"));
    workers.push(worker);
    return worker;
  } });
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  const timed = assert.rejects(pool.run("timed"), /timed out/);
  const timedExit = new Promise((resolve) => workers[0].once("exit", resolve));
  assert.equal(await Promise.race([new Promise((resolve) => workers[0].once("online", () => resolve(true))), timedExit.then(() => false)]), true);
  await timed;
  await timedExit;
  assert.equal(pool.active, 0);
  const controller = new AbortController();
  const cancelled = assert.rejects(pool.run("cancelled", { signal: controller.signal }), /cancelled/);
  const cancelledExit = new Promise((resolve) => workers[1].once("exit", resolve));
  assert.equal(await Promise.race([new Promise((resolve) => workers[1].once("online", () => resolve(true))), cancelledExit.then(() => false)]), true);
  controller.abort();
  await cancelled;
  await cancelledExit;
  assert.equal(pool.active, 0);
  assert.equal(pool.queue.length, 0);
});

test("worker errors, abnormal exit and launch errors reject without holding slots", async () => {
  const workers = [];
  const pool = new TierSignalWorkers({ concurrency: 1, timeoutMs: 5000, createWorker: (repo) => {
    if (repo === "launch") throw new Error("launch failed");
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  await assert.rejects(pool.run("launch"), /launch failed/);
  assert.equal(pool.active, 0);
  const errored = assert.rejects(pool.run("error"), /worker failed/);
  workers[0].emit("error", new Error("worker failed"));
  await errored;
  workers[0].exit(1);
  const exited = assert.rejects(pool.run("exit"), /exited without a result/);
  workers[1].exit(1);
  await exited;
  assert.equal(pool.active, 0);
});

test("scheduler rejects stale, failed and cancelled reads without changing tier baselines", async () => {
  const project = { name: "old", path: "/synthetic/old", tier: "old" };
  const scheduler = new Scheduler({ config: { tierBuckets: 1, tierCheckSeconds: 1 }, store: {}, pool: {}, getProjects: () => [project] });
  const original = signature(1);
  const updated = signature(2);
  scheduler.tiers.seed(project.path, original, "old", 1);
  let release;
  scheduler.tierSignal = () => new Promise((resolve) => { release = resolve; });
  const first = scheduler.tierPass(10_000);
  assert.equal((await scheduler.tierPass(12_000)).checked, 0, "a second pass cannot pile up behind the first");
  scheduler.tiers.seed(project.path, updated, "old", 2);
  release(original);
  assert.equal((await first).checked, 0);
  assert.deepEqual(scheduler.tiers.baselineFor(project.path), updated, "a stale read cannot overwrite a promotion baseline");
  scheduler.tierSignal = async () => { throw new Error("unavailable"); };
  assert.equal((await scheduler.tierPass(14_000)).checked, 0);
  assert.deepEqual(scheduler.tiers.baselineFor(project.path), updated, "a worker failure does not fabricate a baseline");
  scheduler.tierSignal = () => new Promise((resolve) => { release = resolve; });
  const stopped = scheduler.tierPass(16_000);
  scheduler.stop();
  release(original);
  assert.equal((await stopped).checked, 0);
  assert.deepEqual(scheduler.tiers.baselineFor(project.path), updated, "a late result after stop is ignored");
  assert.equal(scheduler.tierCheckAbort, null);
});
