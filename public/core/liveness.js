// core/liveness.js — "is the board's live path still delivering?" asked once, so the answer is testable.
//
// The console is appended to from the run's own stream; the 30 s safety net in app.js exists only for a stream that
// has gone quiet or died. That net read `state.lastEventAt`, and every frame kind stamped it EXCEPT `jobline` — so a
// card writing seven lines a second read 33 s stale, the net decided the board was dead, and `resync()` →
// `applySnapshot` rebuilt every card (29 then 43 rows at once) on a card that was provably alive. That is mechanism
// #3 in docs/jitter-synthesis.md.
//
// Two rules, kept pure so test/liveness.test.js can drive them without a browser:
//
//   1. a frame arriving now is liveness now, whatever kind of frame it is. A line of output is the freshest proof
//      that a run is working there is.
//   2. silence past the window, or a closed stream, is the only reason to resync. A closed socket counts even when
//      the clock looks fresh, because the clock only advances on frames and a dead socket publishes none — and that
//      is what keeps the rebuild for a card that is genuinely dead.
(function (root) {
  // Long enough that a model between two events is not read as a dead stream (a tool call's own output can pause for
  // tens of seconds), short enough that a stream which really died is repaired inside the net's first few ticks.
  const QUIET_MS = 20000;

  // Is the board quiet enough that the safety net should re-read it? `streamOpen` false means the EventSource is not
  // in OPEN state (0 connecting, 2 closed); `undefined` is "not known yet", which the clock alone decides.
  function quiet({ lastEventAt, streamOpen, paused } = {}, now = Date.now(), quietMs = QUIET_MS) {
    // The reader asked the page to hold still: nothing is resynced under them.
    if (paused) return false;
    if (streamOpen === false) return true;
    return !lastEventAt || now - lastEventAt > quietMs;
  }

  // One run's own clock: `live.lastEventAt` off a jobline or job frame (lib/jobs.js liveOf). A card is alive when its
  // run said something inside the window; a card whose run has said nothing for longer is the one a resync is for.
  function fresh(stamp, now = Date.now(), quietMs = QUIET_MS) {
    return Boolean(stamp) && now - stamp <= quietMs;
  }

  root.wtLive = { QUIET_MS, quiet, fresh };
})(globalThis);
