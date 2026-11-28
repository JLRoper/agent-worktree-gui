import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryWatch, HIGH_WATER_BYTES } from "../lib/memory-watch.js";

test("crossing the high-water mark warns exactly once and names the largest retained structure", () => {
  const MB = 1024 * 1024;
  const lines = [];
  const watch = createMemoryWatch({
    thresholdBytes: 100 * MB,
    memory: () => ({ heapUsed: 150 * MB, heapTotal: 200 * MB, rss: 300 * MB }),
    retained: () => ({ "small.map": 2, "big.map": 900, "not.a.number": "ignored" }),
    warn: (line) => lines.push(line),
  });
  assert.equal(watch.check(), true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /heapUsed 150 MB crossed the 100 MB mark/);
  assert.match(lines[0], /big\.map \(900\)/);
  // A later sample above the mark does not repeat the line.
  assert.equal(watch.check(), false);
  assert.equal(lines.length, 1);
  assert.equal(watch.stats().warned, true);
  assert.equal(watch.stats().heapUsed, 150 * MB);
});

test("below the mark stays quiet", () => {
  const lines = [];
  const watch = createMemoryWatch({
    thresholdBytes: HIGH_WATER_BYTES,
    memory: () => ({ heapUsed: HIGH_WATER_BYTES - 1, heapTotal: HIGH_WATER_BYTES, rss: HIGH_WATER_BYTES }),
    warn: (line) => lines.push(line),
  });
  assert.equal(watch.check(), false);
  assert.equal(lines.length, 0);
  assert.equal(watch.stats().warned, false);
  assert.equal(watch.stats().thresholdBytes, HIGH_WATER_BYTES);
});

test("a second crossing after the heap falls back down does not warn again", () => {
  const lines = [];
  let heapUsed = 200;
  const watch = createMemoryWatch({
    thresholdBytes: 100,
    memory: () => ({ heapUsed, heapTotal: 400, rss: 500 }),
    warn: (line) => lines.push(line),
  });
  assert.equal(watch.check(), true);
  heapUsed = 50;
  assert.equal(watch.check(), false);
  heapUsed = 250;
  assert.equal(watch.check(), false);
  assert.equal(lines.length, 1);
});
