import assert from "node:assert/strict";
import test from "node:test";
import { Scheduler } from "../lib/scheduler.js";

// A scheduler with just the seams enqueueDue / deferRow / noteVisible touch. The
// clock is passed in explicitly so the backoff is measured in milliseconds, not
// wall time, and no worker, store or git is started.
function harness(retryMs = 5000) {
  const s = Object.create(Scheduler.prototype);
  s.cfg = { scanDeferRetryMs: retryMs };
  s.lastFast = new Map();
  s.deferUntil = new Map();
  s.stats = {};
  s.visible = new Set();
  s.visibleAt = 0;
  s.visibleSeenAt = new Map();
  s.lastProjectPass = new Map();
  s.store = { rowsFor: () => [{ path: "/w/one" }] };
  s.pool = { isBusy: () => false, canEnqueue: () => true };
  s.projectTier = () => "recent";
  s.intervalFor = () => 30;
  let claims = 0;
  s.scanRow = async () => { claims += 1; };
  const project = { name: "p" };
  s.lastFast.set("p::/w/one", -1000000);
  return { s, project, claims: () => claims };
}

test("a deferred row is parked for the backoff instead of being re-requested every tick", () => {
  const { s, project, claims } = harness();
  s.deferRow("p", "/w/one", 1000);
  assert.equal(s.deferUntil.get("p::/w/one"), 6000);
  assert.equal(s.stats.deferred, 1);

  s.enqueueDue(project, 1001);
  assert.equal(claims(), 0, "the next 1s tick must not re-request the row");
  s.enqueueDue(project, 5999);
  assert.equal(claims(), 0, "still parked just before the deadline");

  s.enqueueDue(project, 6000);
  assert.equal(claims(), 1, "the row is due again once the backoff has elapsed");
  assert.equal(s.deferUntil.has("p::/w/one"), false, "a claimed row is no longer parked");
});

test("the backoff is configurable, and a zero/negative config still enforces a floor", () => {
  const { s, project, claims } = harness(50);
  s.deferRow("p", "/w/one", 1000);
  assert.equal(s.deferUntil.get("p::/w/one"), 1050);
  s.enqueueDue(project, 1049);
  assert.equal(claims(), 0);
  s.enqueueDue(project, 1050);
  assert.equal(claims(), 1);

  const floored = harness(0).s;
  floored.deferRow("p", "/w/one", 1000);
  assert.equal(floored.deferUntil.get("p::/w/one"), 1000 + 5000, "0 cannot restore the 1s storm");
});

test("a project coming on screen clears the backoff so it is read at once", () => {
  const { s, project, claims } = harness();
  s.deferRow("p", "/w/one", 1000);
  s.noteVisible(["p"]);
  assert.equal(s.deferUntil.has("p::/w/one"), false, "visibility must override a pending backoff");
  s.enqueueDue(project, 31000);
  assert.equal(claims(), 1);
});
