// Row lifetimes when a tree is gone: the rule the tree cache exists for (lib/scheduler.js reconcile, lib/store.js
// markStale, lib/tree-cache.js).
//
// Three answers, and only three, and each one is a different sentence:
//
//   * the row is in the listing and on disk        -> read again, replaced in place by its own key
//   * the row is NOT in the listing but on disk    -> a git hiccup: kept, two-pass rule, never dropped on one listing
//   * the row's folder is GONE                     -> STALE, kept, "last seen <when> at <path> - <reason>" while its
//                                                     card needs it, then dropped after the keep window
//
// The defect this pins: a hard refresh painted ten or more agents in the unattached bucket for 15-20 seconds because
// the first state response carried no tree list at all, so every owner path resolved to nothing. The rows now arrive
// with the first response (cached), and a tree that has really vanished is the ONLY way a row may leave the board
// without its own read - never because a listing was late.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Scheduler } from "../lib/scheduler.js";
import { Store } from "../lib/store.js";
import { TREE_CACHE_STALE_KEEP_MS } from "../lib/tree-cache.js";

const root = mkdtempSync(path.join(os.tmpdir(), "wag-tree-stale-"));
const PROJECT = { name: "demo", path: path.join(root, "demo").replace(/\\/g, "/"), mainBranch: "main" };
const A = `${PROJECT.path}/.worktrees/a-111111`;
const B = `${PROJECT.path}/.worktrees/b-222222`;

function tree(dir) {
  mkdirSync(dir, { recursive: true });
  // Enough to look like a worktree to `stat(<dir>/.git)`: the scan's own test, no git needed.
  writeFileSync(path.join(dir, ".git"), "gitdir: C:/repos/demo/.git/worktrees/x\n");
}

const LISTED = [{ path: PROJECT.path, branch: PROJECT.mainBranch }];

function harness({ listing = LISTED, agents = new Map() } = {}) {
  tree(PROJECT.path);
  const store = new Store();
  store.ensureProject(PROJECT);
  const scheduler = new Scheduler({
    config: { projects: [PROJECT] },
    store,
    pool: { inFlight: 0, isBusy: () => false },
    getProjects: () => [PROJECT],
    listWorktrees: async () => listing,
    panelAgents: () => agents,
  });
  return { store, scheduler };
}

test("a CACHED row the listing omits is kept, still cached: one listing is not evidence its tree is gone", async () => {
  tree(A);
  const { store, scheduler } = harness();
  store.seedCached({ project: PROJECT.name, path: A, name: "a-111111", branch: "wtgui/a-111111", head: "abc1234", readAt: new Date().toISOString() });
  await scheduler.reconcile(PROJECT);
  const row = store.rowsFor(PROJECT.name).find((r) => r.path === A);
  assert.ok(row, "the cached row is still on the board");
  assert.equal(row.cached, true, "it has not been read, so it is still the cached row");
  assert.equal(row.stale, null, "nothing about its disk state was withdrawn");
});

test("a CACHED row whose folder is gone renders stale with last seen and the path, never unattached", async () => {
  tree(A);
  const readAt = new Date(Date.now() - 30 * 60_000).toISOString();
  const { store, scheduler } = harness();
  store.seedCached({ project: PROJECT.name, path: A, name: "a-111111", branch: "wtgui/a-111111", head: "abc1234", readAt });
  rmSync(A, { recursive: true, force: true });
  await scheduler.reconcile(PROJECT);
  const row = store.rowsFor(PROJECT.name).find((r) => r.path === A);
  assert.ok(row, "the row is kept, not dropped into the unattached list");
  assert.equal(row.verdict, "STALE");
  assert.equal(row.branch, "wtgui/a-111111", "its branch is still its own, so its card still knows where it was");
  assert.match(row.stale.line, /^last seen /);
  assert.match(row.stale.line, /at C:\/repos|at C:\/Users|at .*a-111111/, "the reason line carries the path it was read at");
  assert.match(row.stale.reason, /gone from disk/);
  // ...and the summary counts it apart from the outstanding work, so a project header does not call it unmerged.
  const summary = store.summaryFor(PROJECT.name);
  assert.equal(summary.staleTrees, 1);
  assert.equal(summary.total, 2, "the stale tree plus the checkout the listing added");
});

test("a LIVE row whose folder is gone and whose tree holds an agent is kept stale, not dropped", async () => {
  tree(A);
  const agents = new Map([[A.toLowerCase(), { total: 2 }]]);
  const { store, scheduler } = harness({ agents });
  store.putRow(PROJECT.name, { path: A, name: "a-111111", branch: "wtgui/a-111111", verdict: "UNMERGED (1 commit)", dirty: 0, untracked: 0 }, "full");
  rmSync(A, { recursive: true, force: true });
  await scheduler.reconcile(PROJECT);
  const row = store.rowsFor(PROJECT.name).find((r) => r.path === A);
  assert.ok(row, "an agent is never unattached because its folder moved");
  assert.equal(row.verdict, "STALE");
  assert.match(row.stale.line, /2 agent|a-111111/);
  assert.equal(store.summaryFor(PROJECT.name).staleTrees, 1);
});

test("a LIVE row with no agent and its folder gone still goes on the first pass", async () => {
  tree(A);
  const { store, scheduler } = harness();
  store.putRow(PROJECT.name, { path: A, name: "a-111111", branch: "wtgui/a-111111", verdict: "MERGED", dirty: 0, untracked: 0 }, "full");
  rmSync(A, { recursive: true, force: true });
  await scheduler.reconcile(PROJECT);
  assert.equal(store.rowsFor(PROJECT.name).some((r) => r.path === A), false, "a tree nobody is standing on may leave");
});

test("a row absent from a listing but still on disk waits for the second pass", async () => {
  tree(A);
  const { store, scheduler } = harness();
  store.putRow(PROJECT.name, { path: A, name: "a-111111", branch: "wtgui/a-111111", verdict: "UNMERGED (1 commit)", dirty: 0, untracked: 0 }, "full");
  await scheduler.reconcile(PROJECT);
  assert.ok(store.rowsFor(PROJECT.name).some((r) => r.path === A), "one listing is a hiccup, not a deletion");
  await scheduler.reconcile(PROJECT);
  assert.equal(store.rowsFor(PROJECT.name).some((r) => r.path === A), false, "two listings is the answer");
});

test("a stale row past its keep window is dropped, and one inside it is left alone", async () => {
  tree(A);
  const { store, scheduler } = harness();
  store.putRow(PROJECT.name, { path: A, name: "a-111111", branch: "wtgui/a-111111", verdict: "MERGED", dirty: 0, untracked: 0 }, "full");
  store.markStale(PROJECT.name, A, { reason: "the folder is gone from disk", lastSeenAt: new Date(Date.now() - 1000).toISOString() });
  rmSync(A, { recursive: true, force: true });
  await scheduler.reconcile(PROJECT);
  assert.equal(store.rowsFor(PROJECT.name).some((r) => r.path === A), true, "inside the window the reason is still the answer");
  // A day later the same row is a fixture nobody needs: move its last-seen back by hand rather than wait.
  store.markStale(PROJECT.name, A, { reason: "the folder is gone from disk", lastSeenAt: new Date(Date.now() - TREE_CACHE_STALE_KEEP_MS - 60_000).toISOString() });
  await scheduler.reconcile(PROJECT);
  assert.equal(store.rowsFor(PROJECT.name).some((r) => r.path === A), false, "past the window it leaves");
});

test("a stale row whose tree is back loses STALE on its own next read and is not ranked as unmerged", () => {
  const store = new Store();
  store.ensureProject(PROJECT);
  store.putRow(PROJECT.name, { path: A, name: "a-111111", branch: "wtgui/a-111111", verdict: "MERGED", dirty: 0, untracked: 0 }, "full");
  store.markStale(PROJECT.name, A, { reason: "the folder is gone from disk", lastSeenAt: new Date().toISOString() });
  assert.equal(store.summaryFor(PROJECT.name).staleTrees, 1);
  // The tree is cut again at the same path: the fast pass answers, and the row must not keep the word its absence earned.
  const row = store.putRow(PROJECT.name, { path: A, name: "a-111111", branch: "wtgui/a-111111", ahead: 1, dirty: 0, untracked: 0 }, "fast");
  assert.equal(row.stale, null);
  assert.notEqual(row.verdict, "STALE");
  assert.equal(store.summaryFor(PROJECT.name).staleTrees, 0);
});

test("a listing that FAILED marks nothing stale: an unanswered listing is not evidence", async () => {
  tree(A);
  const store = new Store();
  store.ensureProject(PROJECT);
  const scheduler = new Scheduler({
    config: { projects: [PROJECT] },
    store,
    pool: { inFlight: 0, isBusy: () => false },
    getProjects: () => [PROJECT],
    listWorktrees: async () => {
      throw new Error("git: not a repository");
    },
  });
  store.putRow(PROJECT.name, { path: A, name: "a-111111", branch: "wtgui/a-111111", verdict: "MERGED", dirty: 0, untracked: 0 }, "full");
  const out = await scheduler.reconcile(PROJECT);
  assert.equal(out.ok, false);
  const row = store.rowsFor(PROJECT.name).find((r) => r.path === A);
  assert.equal(row.stale, null, "no reason was invented from a failure");
  assert.match(String(store.projects.get(PROJECT.name).discoveryNote), /keeping rows/);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
