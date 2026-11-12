// Wall-clock jumps and system sleeps must be told apart from genuine event-loop pauses.
// Synthetic clocks: `wall` is what Date.now() would read, `mono` a monotonic clock, `up`
// process uptime. The sampler's timer is driven by hand so a "late tick" is exact.
import assert from "node:assert/strict";
import test from "node:test";
import { createLoopLag } from "../lib/loop-lag.js";

function rig({ warnMs = 1000 } = {}) {
  let wall = 0;
  let mono = 0;
  let up = 0;
  let timer = null;
  const stalls = [];
  const pauses = [];
  const lag = createLoopLag({
    warnMs,
    sampleMs: 250,
    onStall: (s) => stalls.push(s),
    onPause: (s) => pauses.push(s),
    now: () => wall,
    mono: () => mono,
    uptime: () => up,
    setTimer: (fn, ms) => { timer = { fn, at: wall + ms }; return timer; },
    clearTimer: () => { timer = null; },
    getActivity: () => "idle",
  });
  return {
    lag, stalls, pauses,
    // advance wall + mono + uptime together: a normal, on-time tick
    tick(ms) { wall += ms; mono += ms; up += ms; if (timer && timer.at <= wall) { const fn = timer.fn; timer = null; fn(); } },
    // wall clock leaps forward (NTP correction / suspend where monotonic excludes sleep),
    // while the loop was NOT held: mono and uptime barely move.
    clockJump(ms) { wall += ms; if (timer) { const fn = timer.fn; timer = null; fn(); } },
    start: () => lag.start(),
    stats: () => lag.stats(),
  };
}

test("an on-time tick is no stall, with no clock jump or sleep recorded", () => {
  const r = rig();
  r.start();
  r.tick(250);
  assert.equal(r.stats().stalls, 0);
  assert.equal(r.stats().clockJumps, 0);
  assert.equal(r.stats().systemSleeps, 0);
});

test("a wall-clock jump is NOT counted as an event-loop stall; uptime is captured", () => {
  const r = rig();
  r.start();
  r.tick(250); // one on-time sample
  // The wall clock leaps 18 minutes; monotonic and uptime barely advance: the loop was never held.
  r.clockJump(18 * 60_000);
  const s = r.stats();
  assert.equal(s.clockJumps, 1, "classified as a clock jump");
  assert.equal(s.stalls, 0, "a clock jump is not an event-loop pause");
  assert.equal(r.pauses.length, 1);
  assert.equal(r.pauses[0].kind, "clock-jump");
  assert.ok(r.pauses[0].wallMs > 1_000_000, "the full wall-clock leap is recorded");
  assert.equal(r.pauses[0].monoMs, 0, "monotonic barely moved relative to the wall clock");
  assert.ok(Number.isFinite(r.pauses[0].uptimeSeconds), "process.uptime captured at detection");
});

test("a genuine loop block (both clocks advance, a pass was active) is still a stall", () => {
  let wall = 0;
  let timer = null;
  const stalls = [];
  const lag = createLoopLag({
    warnMs: 1000,
    sampleMs: 250,
    onStall: (s) => stalls.push(s),
    now: () => wall,
    // mono defaults to now; uptime tracks wall; an active pass is named.
    uptime: () => wall,
    getActivity: () => "discovery",
    setTimer: (fn, ms) => { timer = { fn, at: wall + ms }; return timer; },
    clearTimer: () => { timer = null; },
  });
  lag.start();
  wall = 3000; // the loop was held 2750ms past the due point; both clocks advance together
  const fn = timer.fn;
  timer = null;
  fn();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].kind, "loop-pause");
  assert.equal(stalls[0].ms, 2750);
  assert.equal(lag.stats().clockJumps, 0);
  assert.equal(lag.stats().stalls, 1);
});

test("an idle late tick with both clocks agreeing is a system-sleep suspicion, still reported", () => {
  let wall = 0;
  let timer = null;
  const stalls = [];
  const pauses = [];
  const lag = createLoopLag({
    warnMs: 1000,
    sampleMs: 250,
    onStall: (s) => stalls.push(s),
    onPause: (s) => pauses.push(s),
    now: () => wall,
    uptime: () => wall,
    getActivity: () => "idle",
    setTimer: (fn, ms) => { timer = { fn, at: wall + ms }; return timer; },
    clearTimer: () => { timer = null; },
  });
  lag.start();
  wall = 5000;
  const fn = timer.fn;
  timer = null;
  fn();
  assert.equal(stalls.length, 1, "still reported to onStall for backward compatibility");
  assert.equal(stalls[0].kind, "system-sleep");
  assert.equal(pauses.length, 1);
  assert.equal(lag.stats().systemSleeps, 1);
});
