import assert from "node:assert/strict";
import test from "node:test";
import { createSyncTiming } from "../lib/sync-timing.js";

test("records only slow phases, bounds the history, and preserves return values", () => {
  let time = 0;
  const warnings = [];
  const timing = createSyncTiming({ thresholdMs: 10, limit: 2, now: () => time, wallNow: () => 0,
    warn: (line) => warnings.push(line) });
  assert.equal(timing.measure("fast", () => { time += 2; return 42; }), 42);
  for (let i = 0; i < 3; i++) timing.measure(`phase-${i}`, () => { time += 11 + i; });
  assert.equal(timing.stats().count, 3);
  assert.equal(timing.stats().maxMs, 13);
  assert.deepEqual(timing.stats().recent.map((r) => r.phase), ["phase-1", "phase-2"]);
  assert.equal(warnings.length, 3);
  const copy = timing.stats();
  copy.recent[0].phase = "changed";
  assert.equal(timing.stats().recent[0].phase, "phase-1");
});

test("exceptions and a failing warning sink never change application behavior", () => {
  let time = 0;
  const timing = createSyncTiming({ thresholdMs: 1, now: () => time, wallNow: () => 0,
    warn: () => { throw new Error("broken reporter"); } });
  const expected = new Error("original");
  assert.throws(() => timing.measure("phase", () => { time += 5; throw expected; }), (err) => err === expected);
  assert.equal(timing.stats().count, 1);
});
