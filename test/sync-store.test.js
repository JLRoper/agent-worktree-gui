// The store derives `row.sync` on EVERY put, fast scans included: the raw facts arrive fresh with each scan, while
// `remoteBranch` is carried from the last full pass and the project's fetch note changes on its own clock.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../lib/store.js";

function setup() {
  const store = new Store();
  store.ensureProject({ name: "p", remote: "origin", mainBranch: "main" });
  return store;
}
const fresh = (over = {}) => ({
  path: "C:/wt/one",
  name: "one",
  branch: "wtgui/one",
  ahead: 3,
  behind: 1,
  upstream: "origin/wtgui/one",
  upstreamAhead: 0,
  upstreamBehind: 0,
  remoteBranch: "exists",
  verdict: "UNMERGED (3 commits)",
  dirty: 0,
  untracked: 0,
  ...over,
});

test("a row put by the store carries sync, and the verdict's counts against main are untouched", () => {
  const store = setup();
  const row = store.putRow("p", fresh(), "full");
  assert.equal(row.sync.state, "level");
  assert.equal(row.sync.ref, "origin/wtgui/one");
  assert.deepEqual([row.ahead, row.behind], [3, 1]);
});

test("a fast scan re-derives it from the new raw numbers while remoteBranch is carried from the full pass", () => {
  const store = setup();
  store.putRow("p", fresh(), "full");
  // a commit lands in the tree: the next FAST scan has no remoteBranch (that is decorated on full passes only)
  const { remoteBranch, ...fast } = fresh({ upstreamAhead: 1, ahead: 4 });
  const row = store.putRow("p", fast, "fast");
  assert.equal(remoteBranch, "exists");
  assert.equal(row.remoteBranch, "exists", "carried from the last full pass");
  assert.equal(row.sync.state, "ahead");
  assert.equal(row.sync.ahead, 1);
});

test("the project's fetch note marks a counted row stale on its next put, and clearing it clears the mark", () => {
  const store = setup();
  store.putRow("p", fresh({ upstreamAhead: 2 }), "full");
  store.patchProject("p", { fetchNote: "Connection reset by peer" });
  let row = store.putRow("p", fresh({ upstreamAhead: 2 }), "fast");
  assert.equal(row.sync.stale, true);
  assert.match(row.sync.why, /Connection reset by peer/);
  store.patchProject("p", { fetchNote: "" });
  row = store.putRow("p", fresh({ upstreamAhead: 2 }), "fast");
  assert.equal(row.sync.stale, false);
});

test("a project with no remote has nothing to compare with", () => {
  const store = new Store();
  store.ensureProject({ name: "local", remote: "", mainBranch: "main" });
  const row = store.putRow("local", fresh(), "full");
  assert.equal(row.sync.state, "none");
  assert.match(row.sync.why, /no remote/);
});

test("an error row still carries sync, so the page never sees a row without one", () => {
  const store = setup();
  store.putRow("p", fresh(), "full");
  store.markError("p", "C:/wt/one", new Error("boom"));
  const row = [...store.rows.values()].find((r) => r.path === "C:/wt/one");
  assert.equal(row.verdict, "ERROR");
  assert.ok(row.sync && typeof row.sync.state === "string");
});
