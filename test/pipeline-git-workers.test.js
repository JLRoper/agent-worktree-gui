import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { PipelineGitWorkers, readStagePin } from "../lib/pipeline-git-workers.js";
import { commitOf, pinCheck, pinOf, workingBlobOf, withStagePinReader } from "../lib/stage-pin.js";
import { driveTaskPipelines, DRIVE_FAULTS } from "../lib/task-pipeline-drive.js";

const CLOCK = "2026-11-11T08:00:00.000Z";
const document = {
  bundleVersion: 1, name: "pins", pipelines: [{
    id: "pin", title: "Pin", stages: [
      { id: "S1", title: "Write", prompt: "Write.", artifact: { id: "a", path: "out/1.json", schema: "out/1", writer: "writer" } },
      { id: "S2", title: "Read", prompt: "Read.", artifact: { id: "b", path: "out/2.json", schema: "out/2", writer: "reader" } },
    ], gates: [], handoffs: [{ id: "h1", from: "S1", to: "S2", artifact: "a", kind: "sequence" }],
  }],
};
const parsed = parseBundle(document, { file: "pins.json" });
assert.equal(parsed.ok, true, parsed.reason);

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-pipeline-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  git("init", "-q");
  git("config", "user.email", ["fixture", "example.invalid"].join("@"));
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  mkdirSync(path.join(dir, "out"));
  writeFileSync(path.join(dir, "out", "1.json"), '{"stage":1}\n');
  writeFileSync(path.join(dir, "large"), Buffer.alloc(1024 * 1024 + 1, 65));
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return { dir, git };
}

async function replay(tasks, options) {
  const cache = new Map();
  const seen = [];
  for (;;) {
    try {
      const result = driveTaskPipelines(tasks, { ...options, pinReader(operation, args) {
        const key = JSON.stringify([operation, args]);
        seen.push(operation);
        if (cache.has(key)) return cache.get(key);
        throw { pending: readStagePin(operation, args).then((value) => cache.set(key, value)) };
      } });
      return { result, seen };
    } catch (error) {
      if (!error?.pending) throw error;
      await error.pending;
    }
  }
}

test("worker reads exactly match synchronous pin semantics", async (t) => {
  const { dir } = repo(t);
  const head = commitOf(dir);
  const pin = pinOf(dir, "out/1.json", { commit: head });
  const cases = [
    ["commitOf", [dir], head],
    ["commitOf", [path.join(dir, "missing")], null],
    ["pinOf", [dir, "out/1.json", { commit: head }], pin],
    ["pinOf", [dir, "large", { commit: head }], pinOf(dir, "large", { commit: head })],
    ["pinOf", [dir, "missing", { commit: head }], pinOf(dir, "missing", { commit: head })],
    ["pinCheck", [dir, { commit: head, path: "out/1.json", blob: pin.blob }], pinCheck(dir, { commit: head, path: "out/1.json", blob: pin.blob })],
    ["pinCheck", [dir, { commit: "f".repeat(40) }], pinCheck(dir, { commit: "f".repeat(40) })],
    ["workingBlobOf", [dir, "out/1.json"], workingBlobOf(dir, "out/1.json")],
  ];
  for (const [operation, args, expected] of cases) assert.deepEqual(await readStagePin(operation, args), expected, operation);
  assert.equal(cases[3][2].tooLarge, true);
  await assert.rejects(readStagePin("assembleStages", []), /invalid/);
});

test("driver replay preserves settlement, pins, prompts and refused input", async (t) => {
  const { dir } = repo(t);
  const row = {
    id: 1, title: "pin", detail: "", state: "running", thread: "T1", threads: ["T1"], worktree: dir, project: "demo", files: [], attempts: 0, reason: "", hold: null,
    pipelineRun: { pipeline: "pin", stage: "S1", enteredAt: CLOCK, tree: { path: dir, branch: "work" } },
  };
  const options = { bundle: parsed.bundle, jobs: [{ id: "j1", thread: "T1", status: "done", startedAt: CLOCK }], isLive: () => false, at: CLOCK, unattended: true };
  const sync = driveTaskPipelines([row], options);
  const { result, seen } = await replay([row], options);
  assert.deepEqual(result, sync);
  assert.ok(seen.includes("commitOf"));
  assert.ok(seen.includes("pinOf"));
  assert.ok(seen.includes("pinCheck"));
  assert.ok(seen.includes("workingBlobOf"));
  assert.equal(result.starts.length, 1);

  const next = structuredClone(sync.tasks[0]);
  const original = next.pipelineRun.stageRuns.find((run) => run.stage === "S1").artifact;
  original.commit = "f".repeat(40);
  delete next.pipelineRun.startingAt;
  const refusalOptions = { ...options, jobs: [] };
  const expected = driveTaskPipelines([next], refusalOptions);
  const refusal = await replay([next], refusalOptions);
  assert.deepEqual(refusal.result, expected);
  assert.equal(refusal.result.changed[0].code, DRIVE_FAULTS.REFUSE_INPUT);
});

test("reader scope restores even when a pass suspends", () => {
  const marker = {};
  assert.throws(() => withStagePinReader(() => { throw marker; }, () => commitOf("missing")), (error) => error === marker);
  assert.equal(commitOf(""), null);
  const value = withStagePinReader(() => "outer", () => {
    assert.equal(withStagePinReader(() => "inner", () => commitOf("anything")), "inner");
    return commitOf("anything");
  });
  assert.equal(value, "outer");
});

test("a real slow Git clean filter does not delay the panel timer", { timeout: 15000 }, async (t) => {
  const { dir, git } = repo(t);
  const script = path.join(dir, "slow-filter.cjs");
  writeFileSync(script, "setTimeout(() => process.stdin.pipe(process.stdout), 700);\n");
  writeFileSync(path.join(dir, ".gitattributes"), "out/1.json filter=slow\n");
  const quote = (value) => `"${value.replace(/\\/g, "/")}"`;
  git("config", "filter.slow.clean", `${quote(process.execPath)} ${quote(script)}`);
  git("config", "filter.slow.required", "true");
  let finished = false;
  const started = Date.now();
  const pending = readStagePin("workingBlobOf", [dir, "out/1.json"]).then((result) => { finished = true; return result; });
  const timer = await new Promise((resolve) => setTimeout(() => resolve({ elapsed: Date.now() - started, finished }), 20));
  const result = await pending;
  const elapsed = Date.now() - started;
  t.diagnostic(`timer ${timer.elapsed}ms; Git read ${elapsed}ms`);
  assert.equal(timer.finished, false);
  assert.ok(timer.elapsed < 1000, `timer delayed ${timer.elapsed}ms`);
  assert.ok(elapsed >= 600, `slow filter did not run: ${elapsed}ms`);
  assert.match(result, /^[a-f0-9]{40,64}$/);
});

class FakeWorker extends EventEmitter {
  unref() { this.unreferenced = true; }
}

test("worker and queue limits hold through errors and timeouts", async () => {
  const workers = [];
  const pool = new PipelineGitWorkers({ concurrency: 1, queueMax: 1, timeoutMs: 40, createWorker: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const first = assert.rejects(pool.run("commitOf", ["one"]), /timed out and is still running/);
  const queued = assert.rejects(pool.run("commitOf", ["two"]), /timed out before starting/);
  await assert.rejects(pool.run("commitOf", ["three"]), /queue full/);
  await Promise.all([first, queued]);
  assert.equal(workers.length, 1);
  assert.equal(pool.active, 1);
  assert.equal(workers[0].unreferenced, true);
  const next = pool.run("commitOf", ["four"]);
  workers[0].emit("message", { result: null });
  assert.equal(workers.length, 1, "message does not free the active slot");
  workers[0].emit("exit", 0);
  assert.equal(workers.length, 2);
  const failure = assert.rejects(next, /broken/);
  workers[1].emit("error", new Error("broken"));
  assert.equal(pool.active, 1, "an error cannot free a worker that has not exited");
  workers[1].emit("exit", 1);
  await failure;
  assert.equal(pool.active, 0);
  await assert.rejects(pool.run("invalid", []), /invalid/);
});
