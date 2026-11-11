// The event-loop lag sampler: a stall is measured, reported once, and attributed to the pass that was running.
//
// WHY: the panel serves every request from one event loop, so "the page stopped answering" is the loop not
// running — a synchronous stretch anywhere delays every handler behind it. These tests drive a virtual clock,
// so each reading is exact: a schedule that fires on time reports nothing, a tick that fires late reports the
// delay once (not once per tick), and the activity breadcrumb names the pass in flight at that instant.
import assert from "node:assert/strict";
import test from "node:test";
import { createLoopLag, currentActivity, markActivity, withActivity } from "../lib/loop-lag.js";

// A virtual clock with the same shape the real one has: timers fire only when runDue() is called, so a test
// simulates "the loop was held" by advancing time past a timer's due point before running it.
function fakeClock() {
  let t = 0;
  const queue = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = { fn, at: t + ms, cancelled: false };
      queue.push(id);
      return id;
    },
    clearTimer: (id) => {
      id.cancelled = true;
    },
    advance(ms) {
      t += ms;
    },
    runDue() {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const id of [...queue]) {
          if (!id.cancelled && id.at <= t) {
            id.cancelled = true;
            id.fn();
            progressed = true;
          }
        }
      }
    },
  };
}

function makeLag({ warnMs = 1000, onStall = () => {} } = {}) {
  const clock = fakeClock();
  const stalls = [];
  const lag = createLoopLag({
    warnMs,
    sampleMs: 250,
    onStall: (s) => {
      stalls.push(s);
      onStall(s);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, lag, stalls };
}

test("a schedule that fires on time reports no stall", () => {
  const { clock, lag, stalls } = makeLag();
  lag.start();
  for (let i = 0; i < 10; i += 1) {
    clock.advance(250);
    clock.runDue();
  }
  const s = lag.stats();
  assert.equal(stalls.length, 0);
  assert.equal(s.stalls, 0);
  assert.equal(s.maxMs, 0);
  assert.equal(s.currentMs, 0);
  assert.equal(s.samples, 10);
  assert.equal(s.running, true);
  lag.stop();
});

test("one late tick is one stall: the delay is measured, reported once, and re-based", () => {
  const { clock, lag, stalls } = makeLag({ warnMs: 1000 });
  lag.start();
  clock.advance(250);
  clock.runDue(); // on time
  clock.advance(2500); // the loop was held: the timer due at 500 fires at 2750
  clock.runDue();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].ms, 2250); // 2750 - the 500 it was due at
  clock.advance(250);
  clock.runDue(); // the next tick re-bases on the actual time: no second report for the same hold
  assert.equal(stalls.length, 1);
  const s = lag.stats();
  assert.equal(s.stalls, 1);
  assert.equal(s.maxMs, 2250);
  assert.equal(s.maxMs1m, 2250);
  assert.equal(s.lastStall.ms, 2250);
  lag.stop();
});

test("a stall carries the activity breadcrumb of the pass that was running", async () => {
  const { clock, lag, stalls } = makeLag();
  lag.start();
  markActivity("discovery");
  clock.advance(5000);
  clock.runDue();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].activity, "discovery");
  // withActivity restores the previous label, so nested passes unwind honestly
  await withActivity("fetch pass", async () => {
    assert.equal(currentActivity(), "fetch pass");
  });
  assert.equal(currentActivity(), "discovery");
  markActivity();
  assert.equal(currentActivity(), "idle");
  lag.stop();
});

test("overlapping activities that finish out of order never leave a stale label", async () => {
  let finishA, finishB;
  const a = withActivity("a", () => new Promise((resolve) => { finishA = resolve; }));
  const b = withActivity("b", () => new Promise((resolve) => { finishB = resolve; }));
  assert.equal(currentActivity(), "b");
  finishA();
  await a;
  assert.equal(currentActivity(), "b");
  finishB();
  await b;
  assert.equal(currentActivity(), "idle");
});

test("stats window the worst delay: out of the rolling window, out of the reading", () => {
  const { clock, lag } = makeLag();
  lag.start();
  clock.advance(3000);
  clock.runDue(); // one 2750ms stall
  assert.equal(lag.stats().maxMs10m, 2750);
  // Walk 11 minutes of on-time ticks: the stall falls out of both windows, maxMs stays all-time.
  for (let i = 0; i < Math.ceil((11 * 60_000) / 250); i += 1) {
    clock.advance(250);
    clock.runDue();
  }
  const s = lag.stats();
  assert.equal(s.maxMs1m, 0);
  assert.equal(s.maxMs10m, 0);
  assert.equal(s.maxMs, 2750);
  assert.equal(s.stalls, 1);
  lag.stop();
});

test("stop() clears the timer: nothing fires and nothing is counted after it", () => {
  const { clock, lag, stalls } = makeLag();
  lag.start();
  lag.stop();
  clock.advance(5000);
  clock.runDue();
  assert.equal(stalls.length, 0);
  assert.equal(lag.stats().samples, 0);
  assert.equal(lag.stats().running, false);
});

test("a reporter that throws does not take the sampler down", () => {
  const { clock, lag } = makeLag({
    onStall: () => {
      throw new Error("reporter exploded");
    },
  });
  lag.start();
  clock.advance(3000);
  clock.runDue();
  assert.equal(lag.stats().stalls, 1);
  lag.stop();
});
