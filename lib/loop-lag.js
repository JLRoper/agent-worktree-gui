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
// fn)` or markActivity/markActivity("idle")), so the line says which pass was running, not merely
// that time passed. A stall that fires between passes reads "idle" — which is itself informative.
//
// stats() answers what /api/diagnostics exposes: the current delay, the worst of the last minute
// and of the last ten, the last stall (with its activity) and the total count. Memory is bounded:
// samples older than the ten-minute window are dropped as new ones arrive.

let activity = "idle";

export function markActivity(label) {
  activity = label ? String(label) : "idle";
}

export function currentActivity() {
  return activity;
}

// Run `fn` under a named activity; the previous label is restored after, so nested passes unwind.
export async function withActivity(label, fn) {
  const prev = activity;
  markActivity(label);
  try {
    return await fn();
  } finally {
    activity = prev;
  }
}

// Injectable now/setTimer/clearTimer: tests drive a virtual clock, the panel takes the real one.
export function createLoopLag({
  warnMs = 1000,
  sampleMs = 250,
  windowMs = 10 * 60_000,
  onStall = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  getActivity = currentActivity,
} = {}) {
  const samples = []; // { at, ms } inside the last windowMs
  let timer = null;
  let expected = 0;
  let currentMs = 0;
  let maxMs = 0;
  let stalls = 0;
  let count = 0;
  let lastStall = null;

  function tick() {
    const at = now();
    const delay = Math.max(0, at - expected);
    currentMs = delay;
    count += 1;
    if (delay > maxMs) maxMs = delay;
    samples.push({ at, ms: delay });
    const cut = at - windowMs;
    while (samples.length && samples[0].at < cut) samples.shift();
    if (delay >= warnMs) {
      stalls += 1;
      lastStall = { ms: delay, at, activity: getActivity() };
      try {
        onStall(lastStall);
      } catch {
        /* a broken reporter must not take the sampler down */
      }
    }
    expected = at + sampleMs;
    timer = setTimer(tick, sampleMs);
  }

  const maxIn = (since) => samples.reduce((m, s) => (s.at >= since && s.ms > m ? s.ms : m), 0);

  return {
    start() {
      if (timer) return;
      const at = now();
      expected = at + sampleMs;
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
      };
    },
  };
}
