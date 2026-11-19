// The one rule the cached tree list exists to keep, as the page draws it (public/app.js, "tree list row rule"):
//
//   a card may fall to the unattached list ONLY after a scan has completed, and a tree that has vanished from disk
//   renders stale-with-reason under its own row instead of silently joining that list.
//
// Read out of the page and run with no browser, like test/ahead-behind-cell.test.js. The three answers are the point:
// before a completed scan an owner the list does not carry is PENDING (its own group, counted apart), after one it is
// unattached, and a card whose owner IS a row is never either - cached rows included, which is the paint this replaces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const code = sliceRegion(src, "tree list row rule");
const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

function harness({ rows = [], treeList = null, assistantThread = null } = {}) {
  const state = { rows: new Map(rows.map((r) => [`${r.project}::${normPath(r.path)}`, r])), treeList };
  const load = new Function(
    "state",
    "normPath",
    "conversations",
    "assistantSessionFor",
    `${code}; return { treeListComplete, rowForOwner, isPendingScanConv, isHomelessConv, homelessConversations, pendingScanConversations };`,
  );
  const conversations = () => load.convs || [];
  load.convs = [];
  const api = load(state, normPath, conversations, (thread) => Boolean(assistantThread) && thread === assistantThread);
  return { state, api, convs: (list) => (load.convs = list) };
}

const conv = (thread, ownerPath) => ({ thread, latest: { id: `${thread}-1`, ownerPath }, first: { ownerPath } });

test("before any scan completes, an owner the list does not carry is PENDING, not unattached", () => {
  const { api } = harness({ treeList: { cached: false, completedAt: null } });
  const c = conv("t1", "demo/repo/.worktrees/new-999999");
  assert.equal(api.isHomelessConv(c), false, "a slow scan is not a statement about the work");
  assert.equal(api.isPendingScanConv(c), true);
});

test("after a completed scan the same card is unattached - the scan earned the right to say so", () => {
  const { api } = harness({ treeList: { cached: false, completedAt: "2026-11-19T09:00:00.000Z" } });
  const c = conv("t1", "demo/repo/.worktrees/new-999999");
  assert.equal(api.isHomelessConv(c), true);
  assert.equal(api.isPendingScanConv(c), false);
});

test("a card whose owner IS a row is attached, cached first paint included", () => {
  const { api } = harness({
    rows: [{ project: "demo", path: "demo/repo/.worktrees/a-111111", cached: true, verdict: "…" }],
    treeList: { cached: true, completedAt: null },
  });
  // The owner spells the same tree the Windows way, in another case, with a trailing slash; the row key normalises
  // all three, so a card on a cached row is attached even though its owner string is not byte-identical to the row.
  const c = conv("t1", "demo\\repo\\.worktrees\\A-111111\\");
  assert.equal(api.isHomelessConv(c), false);
  assert.equal(api.isPendingScanConv(c), false, "a cached row is a row: this is the jump the cache removes");
  assert.equal(api.rowForOwner(c.latest.ownerPath)?.cached, true);
});

test("a card with NO owner is unattached whatever the scan has done", () => {
  const { api } = harness({ treeList: { cached: true, completedAt: null } });
  const c = { thread: "t0", latest: { id: "t0-1", ownerPath: null }, first: { ownerPath: null } };
  assert.equal(api.isHomelessConv(c), true, "a project-root run has no tree to wait for");
  assert.equal(api.isPendingScanConv(c), false);
});

test("the assistant's own thread is never in either list", () => {
  const { api } = harness({ treeList: { cached: false, completedAt: null }, assistantThread: "assistant-1" });
  const c = conv("assistant-1", "demo/repo/.worktrees/a-111111");
  assert.equal(api.isHomelessConv(c), false);
  assert.equal(api.isPendingScanConv(c), false);
});

test("no tree list at all is not a completed scan: nothing may be called unattached", () => {
  const { api } = harness({ treeList: null });
  const c = conv("t1", "demo/repo/.worktrees/new-999999");
  assert.equal(api.treeListComplete(), false);
  assert.equal(api.isHomelessConv(c), false);
  assert.equal(api.isPendingScanConv(c), true);
});

test("the two lists never overlap and never lose a card", () => {
  const { api, convs } = harness({
    rows: [{ project: "demo", path: "demo/repo/.worktrees/a-111111", cached: true }],
    treeList: { cached: true, completedAt: null },
  });
  convs([
    conv("attached", "demo/repo/.worktrees/a-111111"),
    conv("unknown", "demo/repo/.worktrees/new-999999"),
    { thread: "root", latest: { id: "root-1", ownerPath: null }, first: { ownerPath: null } },
  ]);
  const homeless = api.homelessConversations().map((c) => c.thread);
  const pending = api.pendingScanConversations().map((c) => c.thread);
  assert.deepEqual(homeless, ["root"]);
  assert.deepEqual(pending, ["unknown"]);
  assert.equal(homeless.length + pending.length + 1, 3, "the attached card is under its row and nowhere else");
});
