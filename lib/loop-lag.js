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
// clock barely advances. A system sleep / suspend moves both clocks but leaves NO active pass —
// nothing was running to hold the loop. Both non-loop cases are recorded separately (never counted
// as an event-loop stall) and carry `process.uptime()` evidence captured at detection, so the
// unexplained 18-minute gap can be told apart from a genuine block.
//
// stats() answers what /api/diagnostics exposes: the current delay, the worst of the last minute
// and of the last ten, the last stall (with its activity) and the total count. Memory is bounded:
// samples older than the ten-minute window are dropped as new ones arrive.

import { performance } from "node:perf_hooks";

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
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  getActivity = currentActivity,
} = {}) {
  const monotonic = mono || now;
  const samples = []; // { at, ms } inside the last windowMs
  let timer = null;
  let expected = 0;
  let monoExpected = 0;
  let lastUptime = uptime();
  let currentMs = 0;
  let maxMs = 0;
  let stalls = 0;
  let count = 0;
  let lastStall = null;
  let clockJumps = 0;
  let systemSleeps = 0;
  let lastPause = null;

  function tick() {
    const at = now();
    const monoAt = monotonic();
    const upAt = uptime();
    const delay = Math.max(0, at - expected);
    const monoMs = Math.max(0, monoAt - monoExpected);
    const uptimeMs = Math.max(0, upAt - lastUptime);
    currentMs = delay;
    count += 1;
    if (delay > maxMs) maxMs = delay;
    samples.push({ at, ms: delay });
    const cut = at - windowMs;
    while (samples.length && samples[0].at < cut) samples.shift();

    if (delay >= warnMs) {
      // A wall clock that leapt far ahead of the monotonic clock is a clock adjustment, not a
      // held loop. A late tick with no active pass is a suspend, not our own synchronous work.
      const clockJumped = delay - monoMs >= warnMs;
      const idle = getActivity() === "idle";
      const kind = clockJumped ? "clock-jump" : idle ? "system-sleep" : "loop-pause";
      const evidence = {
        ms: delay,
        wallMs: delay,
        monoMs,
        uptimeMs,
        uptimeSeconds: Math.round(upAt / 1000),
        at,
        activity: getActivity(),
        kind,
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
        systemSleeps += 1;
        lastPause = evidence;
        stalls += 1;
        lastStall = evidence;
        try {
          onStall(lastStall);
        } catch {
          /* a broken reporter must not take the sampler down */
        }
        try {
          onPause(evidence);
        } catch {
          /* a broken reporter must not take the sampler down */
        }
      } else {
        stalls += 1;
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
        lastStall,
        clockJumps,
        systemSleeps,
        lastPause,
      };
    },
  };
}

export const realMonotonicMs = () => performance.now();
