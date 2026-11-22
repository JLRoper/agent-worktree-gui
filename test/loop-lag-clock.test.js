// Wall-clock jumps and system sleeps must be told apart from genuine event-loop pauses.
// Synthetic clocks: `wall` is what Date.now() would read, `mono` a monotonic clock, `up`
// process uptime. The sampler's timer is driven by hand so a "late tick" is exact.
import assert from "node:assert/strict";
import test from "node:test";
import { createLoopLag } from "../lib/loop-lag.js";

function rig({ warnMs = 1000, activity = () => "idle" } = {}) {
  let wall = 0;
  let mono = 0;
  let up = 0;
  let cpuUs = 0;
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
    cpuUsage: () => ({ user: cpuUs, system: 0 }),
    setTimer: (fn, ms) => { timer = { fn, at: wall + ms }; return timer; },
    clearTimer: () => { timer = null; },
    getActivity: activity,
  });
  return {
    lag, stalls, pauses,
    // advance wall + mono + uptime together: a normal, on-time tick
    tick(ms) { wall += ms; mono += ms; up += ms; if (timer && timer.at <= wall) { const fn = timer.fn; timer = null; fn(); } },
    // the loop did `ms` of CPU work during the gap the next tick will measure
    burn(ms) { cpuUs += ms * 1000; },
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

test("a genuine loop block (both clocks advance, the loop burned CPU) is still a stall", () => {
  const r = rig({ activity: () => "discovery" });
  r.start();
  r.burn(2750); // the loop was working for the whole hold
  r.tick(3000); // the timer due at 250 fires at 3000
  assert.equal(r.stalls.length, 1);
  assert.equal(r.stalls[0].kind, "loop-pause");
  assert.equal(r.stalls[0].ms, 2750);
  assert.equal(r.stats().clockJumps, 0);
  assert.equal(r.stats().stalls, 1);
});

test("a LONG idle late tick with no CPU is a system sleep: reported as a pause, not a stall", () => {
  const r = rig();
  r.start();
  r.tick(20_000); // no CPU was consumed: the machine was suspended, not the loop held
  assert.equal(r.stalls.length, 0, "onStall is not called for a suspend");
  assert.equal(r.pauses.length, 1);
  assert.equal(r.pauses[0].kind, "system-sleep");
  assert.equal(r.stats().systemSleeps, 1);
  assert.equal(r.stats().stalls, 0);
});

test("a SHORT idle late tick with no CPU is descheduled: a stall, but never called a sleep", () => {
  const r = rig();
  r.start();
  r.tick(3000);
  assert.equal(r.stalls.length, 1);
  assert.equal(r.stalls[0].kind, "descheduled");
  assert.equal(r.stats().systemSleeps, 0);
  assert.equal(r.stats().descheduled, 1);
});
