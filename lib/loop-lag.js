// Why the panel ever stops answering: event-loop lag, measured and attributed.
//
// The panel serves every request from ONE event loop, so a page that stops updating is the loop
// not running — a synchronous stretch anywhere (a scan's readdir burst, a snapshot stringify, a GC
// pause) delays every handler behind it. This module samples its own timer against the wall clock:
// a tick that arrives later than scheduled measures exactly how long the loop was held.
//
// A sample at or above `warnMs` is ONE stall, reported once — the next sample re-bases on the
// actual time, so a long hold does not spam the log every tick. The report carries an activity
// breadcrumb, which is a coarse label the passes set at their entry (`withActivity("discovery",
// fn)` or markActivity/markActivity("idle")). It identifies one overlapping active pass, not
// necessarily the cause of the stall. A stall between passes reads "idle".
//
// Wall clock vs monotonic clock: a tick can be late for two very different reasons. A real
// event-loop pause holds BOTH clocks together and usually has an active pass. A wall-clock jump
// (an NTP correction, a laptop clock reset) moves the wall clock far ahead while the monotonic
// clock barely advances.
//
// BUT BOTH CLOCKS AGREEING DOES NOT MEAN THE MACHINE SLEPT. The loop can be held by synchronous work
// (JSON, a big regex, a GC pause) with no activity breadcrumb, and it can also be starved of CPU while the
// machine is busy. The old rule - "both clocks advanced and the activity says idle, so it was a system
// sleep" - labelled 3,839 real stalls as sleeps in one day (measured 2026-11-21), and a sleep counted as a
// stall inflated the stall count and the rolling max after every resume. So the process's OWN CPU is the
// third clock: `cpuUsage()` is sampled at each tick and its delta over the gap says whether the loop was
// working. `maxMs` stays the raw worst wall delay (a suspend is included); the windows and `stalls` are not.
//
//   loop-pause    the loop consumed real CPU (>= 25% of the gap, floor 100ms): sync JS or GC.
//   gc-pause      a GC observer's own time covers at least half the gap (when `gcMs` is wired).
//   descheduled   no CPU, a pass was active, or the gap is short: the process did not run.
//   system-sleep  no CPU, activity idle, and a LONG gap (>= 15s): a suspend, not a held loop.
//   clock-jump    the wall clock leapt ahead of the monotonic one.
//
// `stalls` counts loop-pause, gc-pause and descheduled - the panel was late. A system sleep is counted
// separately and is NOT a stall; `onStall` is not called for it (only `onPause`, which carries the
// evidence). Every report carries `cpuMs` and `cpuPct` so a reader can judge the label.
//
// stats() answers what /api/diagnostics exposes: the current delay, the worst of the last minute
// and of the last ten, the last stall (with its activity) and the total count. Memory is bounded:
// samples older than the ten-minute window are dropped as new ones arrive.

import { performance } from "node:perf_hooks";

// A zero-CPU gap shorter than this is not called a sleep: the process was descheduled, which is a stall.
export const LOOP_SUSPEND_MIN_MS = 15_000;

let activity = "idle";
const active = [];

export function markActivity(label) {
  activity = label ? String(label) : "idle";
}

export function currentActivity() {
  return active.length ? active[active.length - 1].label : activity;
}

// Asynchronous passes can finish out of order. Remove the particular pass that settled rather
// than restoring a snapshot that might name a different pass which has already completed.
export async function withActivity(label, fn) {
  const token = { label: label ? String(label) : "idle" };
  active.push(token);
  try {
    return await fn();
  } finally {
    const index = active.indexOf(token);
    if (index !== -1) active.splice(index, 1);
  }
}

// Injectable now/mono/uptime/setTimer/clearTimer: tests drive a virtual clock, the panel takes
// the real ones. `mono` defaults to `now` so a test that only injects a virtual wall clock keeps
// the exact behaviour it had before this distinction existed (no false clock jumps).
export function createLoopLag({
  warnMs = 1000,
  sampleMs = 250,
  windowMs = 10 * 60_000,
  onStall = () => {},
  onPause = () => {},
  now = () => Date.now(),
  mono = null,
  uptime = () => process.uptime() * 1000,
  // The process's own CPU, in microseconds (node's process.cpuUsage shape). This is what tells a held
  // loop from a suspended one: a suspend consumes none, a synchronous block consumes about the gap.
  cpuUsage = () => process.cpuUsage(),
  // Cumulative GC milliseconds, when the host can supply one (server.js wires a PerformanceObserver).
  // Null means "not measured" - the label then comes from CPU alone.
  gcMs = null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  getActivity = currentActivity,
} = {}) {
  const monotonic = mono || now;
  const cpuTotal = (u) => (Number(u?.user) || 0) + (Number(u?.system) || 0);
  const samples = []; // { at, ms } inside the last windowMs
  let timer = null;
  let expected = 0;
  let monoExpected = 0;
  let lastUptime = uptime();
  let lastCpu = cpuTotal(cpuUsage());
  let lastGc = gcMs ? Number(gcMs()) || 0 : 0;
  let currentMs = 0;
  let maxMs = 0;
  let stalls = 0;
  let descheduled = 0;
  let gcPauses = 0;
  let count = 0;
  let lastStall = null;
  let clockJumps = 0;
  let systemSleeps = 0;
  let lastPause = null;

  function tick() {
    const at = now();
    const monoAt = monotonic();
    const upAt = uptime();
    const cpuAt = cpuTotal(cpuUsage());
    const gcAt = gcMs ? Number(gcMs()) || 0 : 0;
    const delay = Math.max(0, at - expected);
    const monoMs = Math.max(0, monoAt - monoExpected);
    const uptimeMs = Math.max(0, upAt - lastUptime);
    const cpuMs = Math.max(0, (cpuAt - lastCpu) / 1000);
    const gcDeltaMs = Math.max(0, gcAt - lastGc);
    lastCpu = cpuAt;
    lastGc = gcAt;
    currentMs = delay;
    count += 1;
    if (delay > maxMs) maxMs = delay;
    samples.push({ at, ms: delay });
    const cut = at - windowMs;
    while (samples.length && samples[0].at < cut) samples.shift();

    if (delay >= warnMs) {
      // A wall clock that leapt far ahead of the monotonic clock is a clock adjustment, not a held loop.
      const clockJumped = delay - monoMs >= warnMs;
      const activity = getActivity();
      const worked = cpuMs >= Math.max(100, delay * 0.25);
      let kind;
      if (clockJumped) kind = "clock-jump";
      else if (gcDeltaMs >= Math.max(50, delay * 0.5)) kind = "gc-pause";
      else if (worked) kind = "loop-pause";
      else if (activity !== "idle") kind = "descheduled";
      else if (delay >= LOOP_SUSPEND_MIN_MS) kind = "system-sleep";
      else kind = "descheduled";
      const evidence = {
        ms: delay,
        wallMs: delay,
        monoMs,
        uptimeMs,
        uptimeSeconds: Math.round(upAt / 1000),
        at,
        activity,
        kind,
        cpuMs: Math.round(cpuMs),
        cpuPct: delay > 0 ? Math.round((cpuMs / delay) * 100) : 0,
        gcMs: gcMs ? Math.round(gcDeltaMs) : null,
      };
      if (kind === "clock-jump") {
        clockJumps += 1;
        lastPause = evidence;
        try {
          onPause(evidence);
        } catch {
          /* a broken reporter must not take the sampler down */
        }
      } else if (kind === "system-sleep") {
        // Not a stall: the machine was suspended, the panel's own loop was never held. Recorded, and
        // reported through onPause only, so the stall count means what it says. It is also kept OUT of the
        // rolling window: a three-hour suspend must not become "the worst delay of the last ten minutes"
        // after a resume.
        systemSleeps += 1;
        lastPause = evidence;
        if (samples.length && samples[samples.length - 1].at === at) samples.pop();
        try {
          onPause(evidence);
        } catch {
          /* a broken reporter must not take the sampler down */
        }
      } else {
        stalls += 1;
        if (kind === "descheduled") descheduled += 1;
        if (kind === "gc-pause") gcPauses += 1;
        lastStall = evidence;
        try {
          onStall(lastStall);
        } catch {
          /* a broken reporter must not take the sampler down */
        }
      }
    }
    expected = at + sampleMs;
    monoExpected = monoAt + sampleMs;
    lastUptime = upAt;
    timer = setTimer(tick, sampleMs);
  }

  const maxIn = (since) => samples.reduce((m, s) => (s.at >= since && s.ms > m ? s.ms : m), 0);

  return {
    start() {
      if (timer) return;
      const at = now();
      expected = at + sampleMs;
      monoExpected = monotonic() + sampleMs;
      lastUptime = uptime();
      lastCpu = cpuTotal(cpuUsage());
      lastGc = gcMs ? Number(gcMs()) || 0 : 0;
      timer = setTimer(tick, sampleMs);
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
    stats() {
      const at = now();
      return {
        sampleMs,
        warnMs,
        running: Boolean(timer),
        samples: count,
        currentMs: Math.round(currentMs),
        maxMs: Math.round(maxMs),
        maxMs1m: Math.round(maxIn(at - 60_000)),
        maxMs10m: Math.round(maxIn(at - windowMs)),
        stalls,
        descheduled,
        gcPauses,
        lastStall,
        clockJumps,
        systemSleeps,
        lastPause,
      };
    },
  };
}

export const realMonotonicMs = () => performance.now();
