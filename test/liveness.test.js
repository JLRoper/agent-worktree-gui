// Is the board's live path still delivering? That is the 30 s safety net's whole question, and it is now one pure
// function in public/core/liveness.js.
//
// Mechanism #3 in docs/jitter-synthesis.md: `jobline` frames never stamped `state.lastEventAt`, so a card writing ~7
// lines a second read 33 s stale, the net called `resync()`, and `applySnapshot` rebuilt every row of a card that was
// provably alive (29 then 43 rows at once, twice a minute). The fix is one rule with two halves, and both are pinned
// here because a fix for one half alone is a bug:
//
//   1. a frame arriving IS liveness, whatever kind of frame it is — a line of output is the freshest proof a run is
//      working there is, so the jobline handler stamps the same clock `job`/`row` frames do;
//   2. silence past the window — or a socket that is not open — still resyncs. That is the rebuild a card that is
//      genuinely dead keeps, and it must not be traded away to stop the first symptom.
import assert from "node:assert/strict";
import test from "node:test";

await import("../public/core/liveness.js");
const { QUIET_MS, quiet, fresh } = globalThis.wtLive;

// One clock for every case: the function under test takes `now`, so nothing here depends on the run's own timing.
const NOW = 1_800_000_000_000;
const ago = (seconds) => NOW - Math.round(seconds * 1000);

test("a card writing lines is not quiet: the clock a jobline stamps holds the net off", () => {
  assert.equal(QUIET_MS, 20000); // the window the old inline test used; a change here is a decision made twice
  assert.equal(quiet({ lastEventAt: ago(0.2), streamOpen: true }, NOW), false);
  assert.equal(quiet({ lastEventAt: ago(19.9), streamOpen: true }, NOW), false);
  assert.equal(quiet({ lastEventAt: ago(QUIET_MS / 1000), streamOpen: true }, NOW), false);
});

test("a board that has said nothing for the window is quiet, and stays quiet", () => {
  assert.equal(quiet({ lastEventAt: ago(QUIET_MS / 1000 + 0.1), streamOpen: true }, NOW), true);
  assert.equal(quiet({ lastEventAt: ago(64), streamOpen: true }, NOW), true);
  // Boot: nothing has arrived yet at all, which is not evidence of a live stream.
  assert.equal(quiet({ lastEventAt: null, streamOpen: true }, NOW), true);
  assert.equal(quiet({ streamOpen: true }, NOW), true);
});

test("a socket that is not open is quiet whatever the clock says", () => {
  // readyState 0 (connecting) and 2 (closed) both arrive as `streamOpen: false`: the clock only advances on frames,
  // so a dead socket cannot publish its own silence.
  assert.equal(quiet({ lastEventAt: ago(0.1), streamOpen: false }, NOW), true);
  // A state object that cannot say (an old boot, a test) is decided by the clock alone.
  assert.equal(quiet({ lastEventAt: ago(0.1) }, NOW), false);
  assert.equal(quiet({ lastEventAt: ago(60) }, NOW), true);
});

test("a paused board is never resynced under the reader", () => {
  assert.equal(quiet({ lastEventAt: ago(600), streamOpen: true, paused: true }, NOW), false);
  assert.equal(quiet({ lastEventAt: null, streamOpen: false, paused: true }, NOW), false);
});

test("one run's own clock: fresh inside the window, stale after it", () => {
  assert.equal(fresh(ago(0.2), NOW), true);
  assert.equal(fresh(ago(QUIET_MS / 1000), NOW), true); // exactly at the edge still counts
  assert.equal(fresh(ago(QUIET_MS / 1000 + 0.001), NOW), false);
  // A run that never stamped is not alive; `0` is the "no stamp" a page hands over after a reload.
  assert.equal(fresh(null, NOW), false);
  assert.equal(fresh(0, NOW), false);
});
