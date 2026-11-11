// Transport health and snapshot freshness are separate: heartbeats prove the socket is alive, not that every
// state change reached this tab. A bounded anti-entropy read is still needed on a busy or quiet healthy stream.
(function (root) {
  // Long enough that a model between two events is not read as a dead stream (a tool call's own output can pause for
  // tens of seconds), short enough that a stream which really died is repaired inside the net's first few ticks.
  const QUIET_MS = 20000;
  const RESYNC_MS = 120000;

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

  function shouldResync({ lastTransportAt, lastSnapshotAt, streamOpen, awaitingStreamSnapshot, paused } = {}, now = Date.now()) {
    if (paused) return false;
    return awaitingStreamSnapshot || quiet({ lastEventAt: lastTransportAt, streamOpen }, now) || !lastSnapshotAt || now - lastSnapshotAt >= RESYNC_MS;
  }

  root.wtLive = { QUIET_MS, RESYNC_MS, quiet, fresh, shouldResync };
})(globalThis);
