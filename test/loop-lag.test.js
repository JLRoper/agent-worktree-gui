// The event-loop lag sampler: a stall is measured, reported once, and attributed to the pass that was running.
// WHY: the panel serves every request from one event loop, so "the page stopped answering" is the loop not
// running — a synchronous stretch anywhere delays every handler behind it. These tests drive a virtual clock,
// so each reading is exact: a schedule that fires on time reports nothing, a tick that fires late reports the
// delay once (not once per tick), and the activity breadcrumb names the pass in flight at that instant.
//
// A late tick is also classified by the process's own CPU (lib/loop-lag.js): a held loop burned CPU, a
// descheduled one did not, and a long zero-CPU gap with nothing running is a suspend. The fake CPU below is
// advanced by the same call that advances the clock, so each label is exact.
import assert from "node:assert/strict";
import test from "node:test";
import { createLoopLag, currentActivity, markActivity, withActivity, LOOP_SUSPEND_MIN_MS } from "../lib/loop-lag.js";

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

function makeLag({ warnMs = 1000, onStall = () => {}, getActivity = null, withGc = false } = {}) {
  const clock = fakeClock();
  const stalls = [];
  const pauses = [];
  let cpuUs = 0;
  let gcTotal = 0;
  const lag = createLoopLag({
    warnMs,
    sampleMs: 250,
    onStall: (s) => {
      stalls.push(s);
      onStall(s);
    },
    onPause: (s) => pauses.push(s),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    cpuUsage: () => ({ user: cpuUs, system: 0 }),
    gcMs: withGc ? () => gcTotal : null,
    ...(getActivity ? { getActivity } : {}),
  });
  return {
    clock,
    lag,
    stalls,
    pauses,
    // The loop did `ms` of CPU work between the previous tick and the next one.
    burn(ms) {
      cpuUs += ms * 1000;
    },
    gc(ms) {
      gcTotal += ms;
    },
  };
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
  const { clock, lag, stalls, burn } = makeLag({ warnMs: 1000 });
  lag.start();
  clock.advance(250);
  clock.runDue(); // on time
  burn(2250); // ...and the loop was working for the whole hold
  clock.advance(2500); // the timer due at 500 fires at 2750
  clock.runDue();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].ms, 2250); // 2750 - the 500 it was due at
  assert.equal(stalls[0].kind, "loop-pause");
  assert.ok(stalls[0].cpuMs >= 2000, "the CPU evidence rides with the report");
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
  const { clock, lag, stalls, burn } = makeLag();
  lag.start();
  markActivity("discovery");
  burn(5000);
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
  const { clock, lag, burn } = makeLag();
  lag.start();
  burn(3000);
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
  const { clock, lag, burn } = makeLag({
    onStall: () => {
      throw new Error("reporter exploded");
    },
  });
  lag.start();
  burn(3000);
  clock.advance(3000);
  clock.runDue();
  assert.equal(lag.stats().stalls, 1);
  lag.stop();
});

// ---- the CPU evidence decides the label ---------------------------------------------------------

test("an idle late tick that BURNED CPU is a loop-pause, not a system sleep", () => {
  // This is the bug the classifier had: the blocking work sets no activity breadcrumb, so an idle label
  // used to be enough to call a 2s hold a sleep. The CPU says otherwise.
  const { clock, lag, stalls, pauses, burn } = makeLag({ getActivity: () => "idle" });
  lag.start();
  burn(2200);
  clock.advance(2500);
  clock.runDue();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].kind, "loop-pause");
  assert.equal(pauses.length, 0);
  assert.equal(lag.stats().systemSleeps, 0);
  assert.equal(lag.stats().stalls, 1);
});

test("a short idle gap with no CPU is descheduled: it is a stall, but not a sleep", () => {
  const { clock, lag, stalls, pauses } = makeLag({ getActivity: () => "idle" });
  lag.start();
  clock.advance(3000);
  clock.runDue();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].kind, "descheduled");
  assert.equal(stalls[0].cpuPct, 0);
  assert.equal(lag.stats().descheduled, 1);
  assert.equal(lag.stats().systemSleeps, 0);
  assert.equal(pauses.length, 0);
});

test("a LONG idle gap with no CPU is a system sleep: recorded, and NOT counted as a stall", () => {
  const { clock, lag, stalls, pauses } = makeLag({ getActivity: () => "idle" });
  lag.start();
  clock.advance(LOOP_SUSPEND_MIN_MS + 5_000);
  clock.runDue();
  assert.equal(stalls.length, 0, "onStall is not called for a suspend");
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].kind, "system-sleep");
  assert.equal(lag.stats().systemSleeps, 1);
  assert.equal(lag.stats().stalls, 0, "a suspend is not an event-loop stall");
  assert.equal(lag.stats().maxMs10m, 0, "and it does not become the worst delay of the rolling window");
});

test("GC time covering the gap is a gc-pause, even when the JS CPU is small", () => {
  const { clock, lag, stalls, gc, burn } = makeLag({ withGc: true });
  lag.start();
  gc(2400); // the collector did the holding
  burn(100);
  clock.advance(3000);
  clock.runDue();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].kind, "gc-pause");
  assert.ok(stalls[0].gcMs >= 2000);
  assert.equal(lag.stats().gcPauses, 1);
});

test("a wall-clock jump is neither a stall nor a sleep, even when CPU is idle", () => {
  const clock = fakeClock();
  let mono = 0;
  const stalls = [];
  const pauses = [];
  const lag = createLoopLag({
    warnMs: 1000,
    sampleMs: 250,
    onStall: (s) => stalls.push(s),
    onPause: (s) => pauses.push(s),
    now: clock.now,
    mono: () => mono,
    uptime: () => clock.now(),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    cpuUsage: () => ({ user: 0, system: 0 }),
    getActivity: () => "idle",
  });
  lag.start();
  clock.advance(250);
  clock.runDue();
  clock.advance(18 * 60_000); // wall leaps; mono does not
  clock.runDue();
  assert.equal(stalls.length, 0);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].kind, "clock-jump");
  assert.equal(lag.stats().clockJumps, 1);
  assert.equal(lag.stats().stalls, 0);
  lag.stop();
});
