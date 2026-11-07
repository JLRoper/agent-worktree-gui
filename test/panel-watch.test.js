// The board's watchdog sweep, driven directly: no panel, no HTTP, no clock of its own.
//
// What this file is the contract for:
//
//   1. A FAILED RUN THE JOB STORE NO LONGER HOLDS is reported once and then never again. The panel resurrects
//      runs from the gateway that its own store has let go; nothing on the board can act on one, and the same
//      two ids being named every ten minutes for hours is the defect this sweep is fixing.
//   2. A FAILED RECORD THAT ALREADY CARRIES `endedAt` is reported once and then never again, while the store
//      still holds it. An ended run is a fact about the past, not a condition that becomes true again.
//   3. A LIVE FAILED RUN STILL ALERTS. The store holds it and nothing has stamped its end: it is failing now,
//      so every pass says so. This is the half a "dedupe everything" fix would have silenced.
//   4. THE REPORTED SET IS NOT PRUNED BY ID ORDER. The old watch sorted its ids and cut the list to the newest
//      200 by that order, so an id that sorts low (0359dfb2, 08cca297) was dropped on every save and reported
//      again on every pass. Here a reported id the feed still names survives any number of neighbours.
//   5. A RUN THAT LEAVES THE FEED AND COMES BACK is still remembered inside the retention window.
//   6. NO STORE, NO "GONE" CLAIM. A caller that cannot read the job store must not have real failures silenced.
//   7. A RUN STILL MARKED RUNNING past the window is news while it is true, and stops when it ends.
//
// The lines themselves are pinned for shape too: the panel's assistant has been reading `FAILED <id> -
// <title> [<why>]` for weeks, and no line may carry an em or en dash.
import assert from "node:assert/strict";
import test from "node:test";
import {
  FAILED_STATUS,
  announceText,
  failedLine,
  jobStoreIds,
  normalizeWatchState,
  pruneReported,
  sweepBoard,
} from "../lib/panel-watch.js";

const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const MINUTE = 60_000;
const DASHES = /[\u2013\u2014]/;

// The two runs the reader was being told about: failed at 05:4x, ended, and gone from the job store.
const GONE_RUN = {
  id: "0359dfb2",
  status: "failed",
  title: "Read assistant-2 queue and manage agent board",
  thread: "panel-assistant-2",
  startedAt: "2026-11-07T05:38:52.629Z",
  endedAt: "2026-11-07T05:40:40.873Z",
  outcome: { word: "failed", reason: "cannot reach the Hermes gateway at http://127.0.0.1:8642: the gateway did not answer within 20s" },
};
const HELD_RUN = {
  id: "08cca297",
  status: "failed",
  title: "Agent board assistant setup",
  thread: "panel-assistant",
  startedAt: "2026-11-07T05:37:55.938Z",
  endedAt: "2026-11-07T05:39:20.954Z",
  outcome: { word: "failed", reason: "cannot reach the Hermes gateway at http://127.0.0.1:8642: the gateway did not answer within 20s" },
};
const storeOf = (...ids) => ({ jobs: ids.map((id) => ({ id })) });

test("a failed run the job store no longer holds is reported once and then never again", () => {
  const store = storeOf(); // the store let it go: the run exists only in the panel's feed
  const first = sweepBoard({ jobs: [GONE_RUN], store, state: null, now: T0 });
  assert.equal(first.alerts.length, 1, "the first pass names the run");
  assert.match(first.alerts[0], /^FAILED 0359dfb2 - Read assistant-2 queue and manage agent board \[cannot reach the Hermes gateway/);
  assert.match(first.alerts[0], /the job store no longer holds this run/, "the line says why it is history");
  assert.equal(first.counts.history, 1);
  assert.equal(first.counts.live, 0);
  assert.ok(first.state.reported["0359dfb2"], "the report is recorded by id");

  // The next pass, ten minutes later, with the same feed and the same store: nothing.
  const second = sweepBoard({ jobs: [GONE_RUN], store, state: first.state, now: T0 + 11 * MINUTE });
  assert.equal(second.alerts.length, 0, "one alert at most, and this pass is silent");
  assert.deepEqual(second.state.reported, first.state.reported, "the record survives the second pass");
});

test("a failed record that already carries endedAt is reported once while the store still holds it", () => {
  const store = storeOf(HELD_RUN.id);
  const first = sweepBoard({ jobs: [HELD_RUN], store, state: null, now: T0 });
  assert.equal(first.alerts.length, 1);
  assert.match(first.alerts[0], /^FAILED 08cca297 - /);
  assert.match(first.alerts[0], /already ended/);
  assert.doesNotMatch(first.alerts[0], /no longer holds/, "the store holds this one; the ended stamp is the reason");

  const second = sweepBoard({ jobs: [HELD_RUN], store, state: first.state, now: T0 + 11 * MINUTE });
  assert.equal(second.alerts.length, 0, "an ended run does not become news a second time");
});

test("a live failed run still alerts, on every pass", () => {
  // No endedAt and still in the store: this run is failing NOW.
  const live = { id: "aa11bb22", status: "failed", title: "the live one", thread: "wtgui-live", startedAt: "2026-11-07T09:55:00.000Z" };
  const store = storeOf(live.id);
  const first = sweepBoard({ jobs: [live], store, state: null, now: T0 });
  assert.equal(first.alerts.length, 1, "the live failure is named");
  assert.equal(first.counts.live, 1);
  assert.equal(first.counts.history, 0);
  assert.equal(first.state.reported[live.id], undefined, "a live failure is not put on the one-shot list");

  const second = sweepBoard({ jobs: [live], store, state: first.state, now: T0 + 11 * MINUTE });
  assert.equal(second.alerts.length, 1, "and it is named again while it is still failing");
  assert.match(second.alerts[0], /^FAILED aa11bb22 - the live one$/);
});

test("a reported id the feed still names is never dropped by id order", () => {
  // The regression: 300 reported ids, and the one that sorts LOWEST is the one that must survive.
  const reported = { [GONE_RUN.id]: new Date(T0 - MINUTE).toISOString() };
  for (let i = 0; i < 299; i += 1) {
    const id = `ff${String(i).padStart(6, "0")}`;
    reported[id] = new Date(T0 - 2 * MINUTE).toISOString();
  }
  const feed = [GONE_RUN, ...Object.keys(reported).filter((id) => id !== GONE_RUN.id).map((id) => ({ id, status: "done" }))];
  const out = sweepBoard({ jobs: feed, store: storeOf(), state: { reported }, now: T0 });
  assert.equal(out.alerts.length, 0, "the low-sorting id is still remembered after 300 neighbours were saved");
  assert.ok(out.state.reported[GONE_RUN.id], "and it is still in the saved state");
  assert.equal(Object.keys(out.state.reported).length, 300, "no neighbour was dropped either");

  // A prune keeps every visible id even when the retention window would have expired it.
  const old = pruneReported({ [GONE_RUN.id]: new Date(0).toISOString() }, new Set([GONE_RUN.id]), T0);
  assert.ok(old[GONE_RUN.id], "visible ids are kept regardless of age");
});

test("a run that leaves the feed and comes back is not reported again", () => {
  const first = sweepBoard({ jobs: [GONE_RUN], store: storeOf(), state: null, now: T0 });
  assert.equal(first.alerts.length, 1);

  const empty = sweepBoard({ jobs: [], store: storeOf(), state: first.state, now: T0 + MINUTE });
  assert.equal(empty.alerts.length, 0);
  assert.ok(empty.state.reported[GONE_RUN.id], "a run merely absent from one pass keeps its record");

  // A gateway restart puts it back on the feed an hour later. Still not news.
  const back = sweepBoard({ jobs: [GONE_RUN], store: storeOf(), state: empty.state, now: T0 + 60 * MINUTE });
  assert.equal(back.alerts.length, 0, "and it stays silent when the feed names it again");
});

test("with no store handed in, a live failure is not called gone and not silenced", () => {
  const live = { id: "cc33dd44", status: "failed", title: "unjudged", startedAt: "2026-11-07T09:55:00.000Z" };
  const first = sweepBoard({ jobs: [live], store: null, state: null, now: T0 });
  assert.equal(first.alerts.length, 1);
  assert.doesNotMatch(first.alerts[0], /no longer holds/, "no store means no claim about the store");
  const second = sweepBoard({ jobs: [live], store: null, state: first.state, now: T0 + MINUTE });
  assert.equal(second.alerts.length, 1, "and it keeps alerting while it has no end stamp");
});

test("a run still marked running past the window is news while it is true", () => {
  const stuck = { id: "ee55ff66", status: "running", title: "a long build", startedAt: "2026-11-07T08:50:00.000Z" };
  const out = sweepBoard({ jobs: [stuck], store: storeOf(stuck.id), state: null, now: T0 });
  assert.equal(out.alerts.length, 1);
  assert.match(out.alerts[0], /^LONG RUN ee55ff66 - a long build has been running 70 min$/);

  const young = { ...stuck, startedAt: "2026-11-07T09:56:00.000Z" };
  assert.equal(sweepBoard({ jobs: [young], store: storeOf(young.id), state: null, now: T0 }).alerts.length, 0);

  // A record whose end is stamped is not "still running" whatever its status field says.
  const ended = { ...stuck, endedAt: "2026-11-07T09:30:00.000Z" };
  assert.equal(sweepBoard({ jobs: [ended], store: storeOf(ended.id), state: null, now: T0 }).alerts.length, 0);
});

test("the announce keeps the panel's shape and never carries an em or en dash", () => {
  const a = failedLine(GONE_RUN, { gone: true });
  const b = failedLine(HELD_RUN, { ended: true });
  const text = announceText([a, b]);
  assert.match(text, /^Watchdog: FAILED 0359dfb2 - /);
  assert.equal(text, `Watchdog: ${a} | ${b}`);
  assert.doesNotMatch(text, DASHES);
  assert.ok(announceText(["x".repeat(4000)]).length <= 1200, "the block is capped");
});

test("the state document reads whatever the file held", () => {
  assert.deepEqual(normalizeWatchState(null).reported, {});
  assert.deepEqual(normalizeWatchState({ reported: { abc: "nonsense", "": T0 } }).reported, { abc: new Date(0).toISOString() });
  assert.deepEqual([...FAILED_STATUS], ["failed", "rejected", "error"]);
  assert.deepEqual([...jobStoreIds({ jobs: [{ id: "a" }, { id: " b " }, {}, null] })], ["a", "b"]);
});
