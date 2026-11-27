// WHICH TREE EACH AGENT RAN IN: recorded at the link, read back per thread, drawn on that agent's own line.
//
// A task keeps ONE `worktree`, and a later link moves it: a pipeline stage's run is cut in its own tree, and the
// moment the row moves, the tree before it is gone. The card could not say where an earlier agent worked, and the
// only other link (the job store) keeps 80 conversations, so a stage run from last week was untraceable. This file
// pins the model half of the fix:
//
//   1. `linkTaskRun` writes `threadTrees[thread] = { path, project }` for the agent it is linking, and a later link
//      for another thread leaves the earlier entry alone;
//   2. `taskThreadTrees` keeps only threads the record still carries, and drops an entry with no path - "nothing was
//      written" is an answer, and a guessed tree is not;
//   3. `decorateTasks` attaches `agentRows` in the order of `threads`: the project and the landed verdict read from
//      that thread's tree through `rowFor`, a project still named when the board no longer scans the tree (the link
//      wrote it), and null for a thread nobody recorded;
//   4. a task with no recorded tree carries NO `agentRows` at all, so a queue of six hundred rows does not ship six
//      hundred arrays of nulls and the card draws exactly what it drew before.
import assert from "node:assert/strict";
import test from "node:test";
import { decorateTasks, linkTaskRun, taskThreadTrees } from "../lib/assistant/queue.js";

const A = "wtgui-first-cut-aaaaaa";
const B = "wtgui-stage-two-bbbbbb";
const C = "wtgui-hand-linked-cccccc";
const TREE_A = "agent-worktree-gui/.worktrees/first-cut-aaaaaa";
const TREE_B = "poc-guidelines/.worktrees/stage-two-bbbbbb";

const task = (extra = {}) => ({ id: 7, title: "a row carried by three agents", state: "running", thread: A, threads: [A, B, C], files: [], ...extra });

test("a link records the tree of the thread it links, and a second link keeps the first", () => {
  const first = linkTaskRun([task({ threads: [A], thread: A })], 7, { thread: A, worktree: TREE_A, project: "agent-worktree-gui" }).tasks;
  assert.deepEqual(first[0].threadTrees, { [A]: { path: TREE_A, project: "agent-worktree-gui" } });
  const second = linkTaskRun(first, 7, { thread: B, worktree: TREE_B, project: "poc-guidelines" }).tasks;
  assert.deepEqual(second[0].threadTrees, {
    [A]: { path: TREE_A, project: "agent-worktree-gui" },
    [B]: { path: TREE_B, project: "poc-guidelines" },
  });
  assert.equal(second[0].worktree, TREE_B, "the task's own worktree follows the newest link, which is why the map exists");
});

test("a link with no tree to give leaves what was recorded alone", () => {
  const seeded = [task({ threads: [A], thread: A, threadTrees: { [A]: { path: TREE_A, project: "agent-worktree-gui" } } })];
  const linked = linkTaskRun(seeded, 7, { thread: A, runId: "run_1" }).tasks;
  assert.deepEqual(linked[0].threadTrees, { [A]: { path: TREE_A, project: "agent-worktree-gui" } });
});

test("the map cannot outlive the thread list, and an entry with no path is dropped", () => {
  assert.deepEqual(taskThreadTrees({ threads: [A], threadTrees: { [A]: { path: TREE_A }, [B]: { path: TREE_B } } }), { [A]: { path: TREE_A } });
  assert.deepEqual(taskThreadTrees({ threads: [A], threadTrees: { [A]: { path: "" } } }), undefined);
  assert.deepEqual(taskThreadTrees({ threads: [A] }), undefined);
});

test("decorateTasks puts each agent's project and landing on its own entry", () => {
  const rows = new Map([
    [TREE_A, { path: TREE_A, project: "agent-worktree-gui", verdict: "UNMERGED (2 commits)", branchKind: "research", branchKindLabel: "research tree" }],
    [TREE_B, { path: TREE_B, project: "poc-guidelines", verdict: "MERGED (3 commits)", pr: { number: 373, state: "OPEN" }, branchKind: "turnover", branchKindLabel: "turnover branch" }],
  ]);
  const rowFor = (t) => rows.get(String(t?.worktree || "")) || null;
  const [out] = decorateTasks([task({ threadTrees: { [A]: { path: TREE_A }, [B]: { path: TREE_B } } })], { rowFor, isLive: () => true });
  assert.equal(out.agentRows.length, 3, "one entry per thread, in the order of threads");
  assert.deepEqual(
    { thread: out.agentRows[0].thread, project: out.agentRows[0].project, verdict: out.agentRows[0].verdict, pr: out.agentRows[0].pr },
    { thread: A, project: "agent-worktree-gui", verdict: "UNMERGED (2 commits)", pr: null },
  );
  assert.deepEqual(
    { project: out.agentRows[1].project, verdict: out.agentRows[1].verdict, pr: out.agentRows[1].pr },
    { project: "poc-guidelines", verdict: "MERGED (3 commits)", pr: { number: 373, state: "OPEN" } },
  );
  assert.equal(out.agentRows[2], null, "the hand-linked thread recorded no tree, so it says nothing");
});

test("a tree the board no longer scans keeps the project the link wrote and no landing", () => {
  const [out] = decorateTasks([task({ threadTrees: { [A]: { path: TREE_A, project: "agent-worktree-gui" } } })], { rowFor: () => null, isLive: () => true });
  assert.deepEqual(
    { project: out.agentRows[0].project, verdict: out.agentRows[0].verdict, path: out.agentRows[0].path },
    { project: "agent-worktree-gui", verdict: null, path: TREE_A },
  );
});

test("a task with nothing recorded carries no agentRows at all", () => {
  const [out] = decorateTasks([task()], { rowFor: () => null, isLive: () => true });
  assert.equal("agentRows" in out, false);
});
