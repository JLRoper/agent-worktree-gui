// A git child-process spawn holds this event loop for 0.6-4.7s under the endpoint filter
// (lib/project.js:89, test/meta-off-loop.test.js:3). The four remote answers a full pass
// needs used to be started inside one Promise.all, so their spawns landed back-to-back and
// a poll for /api/state or /api/thinking could not be answered for the whole burst.
// staggeredReads must give the poll phase a MACROTASK turn between the starts while
// still keeping the reads in flight together and preserving their order.
import test from "node:test";
import assert from "node:assert/strict";
import { staggeredReads, yieldToLoop } from "../lib/scheduler.js";

test("staggeredReads keeps the four values in their original order", async () => {
  const out = await staggeredReads([
    () => Promise.resolve("heads"),
    () => Promise.resolve("prs"),
    () => Promise.resolve("upstreams"),
    () => Promise.resolve("remoteRefs"),
  ]);
  assert.deepEqual(out, ["heads", "prs", "upstreams", "remoteRefs"]);
});

test("staggeredReads gives the loop a macrotask turn between the reads", async () => {
  // Scheduled before the call: this runs in the same check phase as the first
  // yield, but BEFORE it (setImmediate is FIFO within the phase). A microtask-only
  // yield would let the second reader run without ever seeing it.
  let turn = false;
  setImmediate(() => { turn = true; });
  const seen = [];
  const out = await staggeredReads([
    () => { seen.push(`first:${turn}`); return "a"; },
    () => { seen.push(`second:${turn}`); return "b"; },
  ]);
  assert.deepEqual(out, ["a", "b"]);
  assert.deepEqual(seen, ["first:false", "second:true"], "a setImmediate callback ran between the two reads");
});

test("yieldToLoop is a macrotask, not a microtask", async () => {
  const order = [];
  Promise.resolve().then(() => order.push("microtask"));
  setImmediate(() => order.push("setImmediate-before"));
  await yieldToLoop();
  assert.equal(order[0], "microtask");
  assert.ok(order.includes("setImmediate-before"), "the check phase ran before the yield resolved");
});

test("staggeredReads propagates a rejection and handles an empty list", async () => {
  await assert.rejects(
    staggeredReads([() => Promise.resolve(1), () => Promise.reject(new Error("boom"))]),
    /boom/,
  );
  assert.deepEqual(await staggeredReads([]), []);
});

test("staggeredReads starts every reader before awaiting any result", async () => {
  // All four are in flight together: a reader that resolves later must not hold up
  // the next reader's START (only a macrotask turn separates them).
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const promise = staggeredReads([
    () => { started.push("a"); return gate.then(() => "a"); },
    () => { started.push("b"); return "b"; },
    () => { started.push("c"); return "c"; },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b", "c"], "each reader started even though the first is still pending");
  release();
  assert.deepEqual(await promise, ["a", "b", "c"]);
});
