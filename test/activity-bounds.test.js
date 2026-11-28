import assert from "node:assert/strict";
import test from "node:test";
import {
  activityStats,
  boundTouchedMap,
  clearActivityCaches,
  declaredPorts,
  MEMO_CACHE_MAX,
  narrowTouched,
  placeSessions,
  TOUCHED_MAX_SESSIONS,
} from "../lib/activity.js";

// The touched map the attribution reads is built from a SQL read that is already capped to the newest tool-call
// rows, but the MAP itself had no documented ceiling: a store shape with many sessions could make one build hold
// an arbitrary number of them. These pin the two bounds and the no-change-for-open-sessions rule.

test("the touched map never exceeds its documented session bound and keeps the newest sessions", () => {
  const map = new Map();
  for (let i = 0; i < TOUCHED_MAX_SESSIONS + 50; i += 1) {
    map.set(`s${i}`, [{ at: i, paths: [`c:/w/${i}`] }]);
  }
  const bound = boundTouchedMap(map, { maxSessions: 10 });
  assert.equal(bound.size, 10);
  const newest = Array.from({ length: 10 }, (_, k) => `s${TOUCHED_MAX_SESSIONS + 49 - k}`);
  assert.deepEqual([...bound.keys()], newest, "the kept sessions are the newest by their newest call");
});

test("the touched map is returned unchanged when it is already inside both bounds", () => {
  const small = new Map([["a", [{ at: 1, paths: ["c:/w/a"] }]]]);
  assert.strictEqual(boundTouchedMap(small), small, "no copy for the common small case");
});

test("the call cap trims across sessions, newest first", () => {
  const map = new Map([
    ["a", [{ at: 3, paths: [] }, { at: 2, paths: [] }]],
    ["b", [{ at: 1, paths: [] }]],
  ]);
  const bound = boundTouchedMap(map, { maxSessions: 10, maxCalls: 2 });
  const kept = [...bound.values()].reduce((n, list) => n + list.length, 0);
  assert.equal(kept, 2);
  assert.equal(bound.get("a").length, 2);
  assert.equal(bound.has("b"), false);
});

test("narrowing to the sessions in scope drops closed ones and leaves an open session's attribution identical", () => {
  // `pathsIn` lowercases and normalises separators before the map is built; an entry's paths are already in that
  // form here.
  const sessions = [
    { id: "open", open: true, cwd: "c:/work/a", title: "A", running: false, lastActivityAt: 1 },
    { id: "closed", open: false, cwd: "c:/work/b", title: "B", running: false, lastActivityAt: 1 },
  ];
  const touched = new Map([
    ["open", [{ at: 2, paths: ["c:/work/a/src/x.js"] }]],
    ["closed", [{ at: 3, paths: ["c:/work/b/src/y.js"] }]],
  ]);
  const roots = ["c:/work/a", "c:/work/b"];

  const narrowed = narrowTouched(touched, new Set(["open"]));
  assert.deepEqual([...narrowed.keys()], ["open"], "the closed session's entries are not retained");

  const fromNarrowed = placeSessions(sessions, narrowed, roots);
  const fromFull = placeSessions(sessions, touched, roots);
  assert.equal(fromNarrowed.get("c:/work/a")?.[0]?.id, "open");
  assert.deepEqual(
    fromNarrowed.get("c:/work/a"),
    fromFull.get("c:/work/a"),
    "an open session lands on the same worktree either way",
  );
  // A closed session is never attributed, so dropping it changes no chip.
  assert.equal(fromFull.has("c:/work/b"), false);
});

test("a closed session still falls back to its cwd when its touched entry is dropped — but it is not drawn", () => {
  // Guards the quoted contract: narrowing only removes entries `placeSessions` already ignored.
  const sessions = [{ id: "closed", open: false, cwd: "c:/work/b", title: "B", running: false, lastActivityAt: 1 }];
  const touched = new Map([["closed", [{ at: 1, paths: ["c:/work/b/src/y.js"] }]]]);
  assert.equal(placeSessions(sessions, touched, ["c:/work/b"]).size, 0);
  assert.equal(placeSessions(sessions, narrowTouched(touched, new Set()), ["c:/work/b"]).size, 0);
});

test("the activity memo cache is bounded, so per-worktree keys cannot accumulate forever", async () => {
  clearActivityCaches();
  for (let i = 0; i < MEMO_CACHE_MAX + 40; i += 1) {
    await declaredPorts(`C:/no/such/worktree/${i}`);
  }
  const stats = activityStats();
  assert.ok(stats.memoKeys <= MEMO_CACHE_MAX, `memo keys ${stats.memoKeys} exceed the ${MEMO_CACHE_MAX} cap`);
  assert.equal(stats.memoCap, MEMO_CACHE_MAX);
  assert.ok(stats.memoKeysByKind.env > 0, "the per-worktree env keys are what the cache is holding");
  clearActivityCaches();
  assert.equal(activityStats().memoKeys, 0);
});

test("activityStats reports the documented touched-map caps", () => {
  const stats = activityStats();
  assert.equal(typeof stats.memoKeys, "number");
  assert.equal(stats.touched.sessionCap, TOUCHED_MAX_SESSIONS);
  assert.equal(typeof stats.touched.callCap, "number");
  assert.equal(typeof stats.sessions, "number");
  assert.equal(typeof stats.openSessions, "number");
});
