// Queue wait and scan-phase timing, recorded with a synthetic clock.
import assert from "node:assert/strict";
import test from "node:test";
import { createScanTiming } from "../lib/scan-timing.js";

test("queue wait and scan phase are accumulated separately with last/max/avg", () => {
  let t = 1000;
  const timing = createScanTiming({ now: () => t });
  timing.recordWait(120);
  timing.recordWait(80);
  t = 1500;
  timing.recordScan(1400, { depth: "fast", project: "alpha", waitedMs: 120 });
  t = 1650;
  timing.recordScan(1600, { depth: "full", project: "beta", waitedMs: 80 });

  const s = timing.stats();
  assert.equal(s.queueWait.count, 2);
  assert.equal(s.queueWait.lastMs, 80);
  assert.equal(s.queueWait.maxMs, 120);
  assert.equal(s.queueWait.avgMs, 100);
  assert.equal(s.scanPhase.count, 2);
  assert.equal(s.scanPhase.lastMs, 50);
  assert.equal(s.scanPhase.maxMs, 100);
  assert.equal(s.scanPhase.avgMs, 75);
  assert.equal(s.recent.length, 2);
  assert.equal(s.recent[0].project, "alpha");
  assert.equal(s.recent[1].depth, "full");
});

test("recent entries are bounded and negative/NaN durations are clamped to zero", () => {
  let t = 0;
  const timing = createScanTiming({ now: () => t, recentSize: 2 });
  timing.recordWait(-5);
  timing.recordWait(Number.NaN);
  t = 10;
  timing.recordScan(5);
  t = 20;
  timing.recordScan(10);
  t = 30;
  timing.recordScan(20);
  const s = timing.stats();
  assert.equal(s.queueWait.maxMs, 0, "clamped");
  assert.equal(s.recent.length, 2, "bounded to recentSize");
  assert.deepEqual(s.recent.map((r) => r.ms), [10, 10]);
});

test("an empty timing reports zeroed stats", () => {
  const s = createScanTiming().stats();
  assert.equal(s.queueWait.count, 0);
  assert.equal(s.scanPhase.count, 0);
  assert.equal(s.queueWait.avgMs, 0);
  assert.deepEqual(s.recent, []);
});
