// The bounded, per-project-coalesced, visibility-prioritised pending scan set.
// These are synthetic jobs: no workers, no git, no store - only the queue's own rules,
// driven by a clock the test controls.
import assert from "node:assert/strict";
import test from "node:test";
import { ScanQueue, QUEUE_FULL, PROJECT_COALESCED } from "../lib/scan-queue.js";

function job(key, project, priority = 1) {
  return { key, project, priority, task: { key }, resolve: () => {}, reject: () => {} };
}

test("a bounded queue refuses (defers) once it is full, and never drops a queued job", () => {
  const q = new ScanQueue({ maxSize: 2 });
  assert.equal(q.enqueue(job("a", "p1")).ok, true);
  assert.equal(q.enqueue(job("b", "p2")).ok, true);
  const refused = q.enqueue(job("c", "p3"));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, QUEUE_FULL);
  assert.equal(q.size, 2, "the full queue keeps the two it already accepted");
  assert.deepEqual(q.drain().map((j) => j.key), ["a", "b"]);
  assert.equal(q.stats().refusedFull, 1);
});

test("per-project coalescing keeps at most maxPerProject pending from any one project", () => {
  const q = new ScanQueue({ maxSize: 10, maxPerProject: 2 });
  assert.equal(q.enqueue(job("r1", "alpha")).ok, true);
  assert.equal(q.enqueue(job("r2", "alpha")).ok, true);
  const refused = q.enqueue(job("r3", "alpha"));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, PROJECT_COALESCED, "the third row of one project is deferred, not lost");
  assert.equal(q.enqueue(job("r4", "beta")).ok, true, "another project still has room");
  assert.equal(q.size, 3);
  assert.equal(q.pendingFor("alpha"), 2);
  assert.equal(q.stats().refusedCoalesced, 1);
});

test("visible projects (priority 0) dispatch before hidden ones", () => {
  let t = 0;
  const q = new ScanQueue({ maxSize: 10, maxPerProject: 10, now: () => t });
  q.enqueue(job("hidden", "h", 1));
  q.enqueue(job("visible", "v", 0));
  assert.equal(q.take().key, "visible");
  assert.equal(q.take().key, "hidden");
  assert.equal(q.take(), null);
});

test("an unseen project cannot starve: aging promotes a long-waiting hidden scan", () => {
  let t = 0;
  // visible always available from v; fairnessWindow forces a hidden one through every 3 visible dispatches.
  const q = new ScanQueue({ maxSize: 10, maxPerProject: 10, starvationMs: 1000, fairnessWindow: 2, now: () => t });
  q.enqueue(job("hidden-old", "h", 1));
  t = 2000; // the hidden scan has now waited past starvationMs
  q.enqueue(job("visible-fresh", "v", 0));
  // aged hidden is now effective priority 0 and older, so it wins on the age tiebreak
  assert.equal(q.take().key, "hidden-old", "a starved project is promoted ahead of fresh visible work");
});

test("fairness window interleaves hidden work even while visible work keeps arriving", () => {
  let t = 0;
  const q = new ScanQueue({ maxSize: 20, maxPerProject: 20, starvationMs: 100000, fairnessWindow: 2, now: () => t });
  const keys = [];
  for (const key of ["h1", "v1", "v2", "v3", "v4", "h2"]) {
    q.enqueue(job(key, key.startsWith("v") ? "v" : "h", key.startsWith("v") ? 0 : 1));
  }
  while (q.size) keys.push(q.take().key);
  // At least one hidden job appears within the first fairnessWindow+1 dispatches.
  assert.ok(keys.indexOf("h1") >= 0, "hidden work is dispatched at all");
  assert.ok(keys.indexOf("h1") <= 3, `hidden work must not starve behind visible work; order was ${keys.join(",")}`);
});

test("drain empties the queue and has() reflects membership", () => {
  const q = new ScanQueue({ maxSize: 5 });
  q.enqueue(job("a", "p1"));
  q.enqueue(job("b", "p2"));
  assert.equal(q.has("a"), true);
  assert.equal(q.has("z"), false);
  const all = q.drain();
  assert.equal(all.length, 2);
  assert.equal(q.size, 0);
  assert.equal(q.take(), null);
});

test("stats report the configuration and refusal counters for diagnostics", () => {
  const q = new ScanQueue({ maxSize: 3, maxPerProject: 1 });
  q.enqueue(job("a", "p1"));
  q.enqueue(job("b", "p1")); // coalesced (p1 already pending)
  q.enqueue(job("c", "p2"));
  q.enqueue(job("d", "p3")); // fills the queue (3 pending)
  q.enqueue(job("e", "p4")); // full
  const s = q.stats();
  assert.equal(s.maxSize, 3);
  assert.equal(s.maxPerProject, 1);
  assert.equal(s.refusedCoalesced, 1);
  assert.equal(s.refusedFull, 1);
  assert.equal(s.size, 3);
});
