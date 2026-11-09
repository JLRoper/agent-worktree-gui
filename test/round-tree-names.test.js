// A round's own names for its trees, read from the queue task that cut them.
//
// The chart's row title came from the reader's browser (`state.treeNames`, localStorage `wtgui.treenames`) and then
// from the agent's own title. A round's parent tree has no worker in it when it is cut, and a stage child's agent names
// itself from the work it did, so a fresh profile drew the directory name. The queue record knows better:
// `pipelineRun.round` names the parent cut and `pipelineRun.trees` names every stage child, both written at the cut.
//
// These tests pin the READ and the two properties the chart depends on:
//   1. a tree the record names gets the record's own words - the task's name for the parent, and "Stage <n>: <stage>"
//      for a child, derived from its stage and position;
//   2. a tree the record does not name (or names with no display at all) gets nothing, so the page falls back to the
//      directory - a fact about the disk, never a name somebody typed into one browser.
import test from "node:test";
import assert from "node:assert/strict";

import { roundTreeKey, roundTreeNames } from "../lib/round-tree-names.js";

const Q = "C:/repo/.worktrees";
const PARENT = `${Q}/round-a-052254`;
const STAGE1 = `${Q}/round-a-stage-1-probe-6632b6`;
const STAGE2 = `${Q}/round-a-stage-2-implement-9d41f0`;

const round = (extra = {}) => ({
  parentPath: PARENT,
  parent: "wtgui/round-a-052254",
  slug: "round-a",
  tag: "052254",
  ...extra,
});
const task = (id, pipelineRun, extra = {}) => ({
  id,
  title: `274: the row's own name, #${id}`,
  pipelineRun,
  ...extra,
});
const only = (names, path) => names.get(roundTreeKey(path)) || null;

test("the parent row reads the queue task's name - not the round's slug, not the directory", () => {
  const names = roundTreeNames([
    task(7, { round: round({ display: "the record's own title", slug: "round-a" }) }),
  ]);
  const parent = only(names, PARENT);
  assert.ok(parent, "the parent tree is named");
  assert.equal(parent.display, "274: the row's own name, #7", "the TASK is the parent's name");
  assert.equal(parent.role, "parent");
  assert.equal(parent.stage, null);
  assert.equal(parent.position, null);
  assert.equal(parent.taskId, 7);
});

test("a stage child reads Stage <n>: <stage> from its own stage and position", () => {
  const names = roundTreeNames([
    task(7, {
      round: round(),
      trees: {
        S2: { path: STAGE2, position: 2, stageName: "implement", stage: "S2" },
        S1: { path: STAGE1, position: 1, stageName: "probe", stage: "S1" },
      },
    }),
  ]);
  assert.equal(only(names, STAGE2).display, "Stage 2: implement");
  assert.equal(only(names, STAGE1).display, "Stage 1: probe");
  assert.equal(only(names, STAGE2).role, "stage");
  assert.equal(only(names, STAGE2).stage, "S2", "the id is the key the record filed the tree under");
  assert.equal(only(names, STAGE2).position, 2);
});

test("the derived words win over a stale display stored beside them", () => {
  // A stage that was renamed or renumbered after its first cut: the record's display is the old sentence, and the
  // stage and position are what the reader must see now.
  const names = roundTreeNames([
    task(7, {
      round: round(),
      trees: { S2: { path: STAGE2, position: 2, stageName: "implement", display: "Stage 9: something else" } },
    }),
  ]);
  assert.equal(only(names, STAGE2).display, "Stage 2: implement");
});

test("a record written before the stage's words were stored names its child from the display it carries", () => {
  const names = roundTreeNames([
    task(7, { round: round(), trees: { S2: { path: STAGE2, display: "Stage 2: implement" } } }),
  ]);
  assert.equal(only(names, STAGE2).display, "Stage 2: implement");
  assert.equal(only(names, STAGE2).position, null, "the position is honestly absent, never guessed from the words");
});

test("a tree named with no display at all answers null, so the page paints the directory", () => {
  const names = roundTreeNames([task(7, { round: round(), trees: { S1: { path: STAGE1 } } })]);
  const child = only(names, STAGE1);
  assert.ok(child, "the record still names the tree, which is what suppresses a name from one browser");
  assert.equal(child.display, null);
});

test("a task with a pipeline but no round names nothing at all", () => {
  // The default path's tree is named by the row it stands on. Stamping the task title there would rename a tree
  // nobody asked about - and every task with a pipeline would start painting its title over the chart.
  const names = roundTreeNames([
    task(4, { pipeline: "p", stage: "S1", tree: { path: STAGE1 }, trees: { S1: { path: STAGE1, display: "Stage 1: x" } } }),
  ]);
  assert.equal(names.size, 0);
});

test("a tree is keyed the way the panel keys one: separators, a trailing slash and case do not matter", () => {
  const names = roundTreeNames([
    task(7, {
      round: round({ parentPath: "C:\\repo\\.worktrees\\ROUND-A-052254\\" }),
      trees: { S2: { path: `${STAGE2}/`, position: 2, stageName: "implement" } },
    }),
  ]);
  assert.equal(only(names, PARENT).display, "274: the row's own name, #7");
  assert.equal(only(names, STAGE2).display, "Stage 2: implement");
});

test("the newest task wins one tree, and an undated record never displaces a dated one", () => {
  const older = task(9, { round: round({ parentPath: PARENT }) }, { title: "the older row" });
  const newer = task(12, { round: round({ parentPath: PARENT }) }, { title: "the newer row" });
  const undated = { title: "a hand-written record", pipelineRun: { round: round({ parentPath: PARENT }) } };
  assert.equal(only(roundTreeNames([older, newer]), PARENT).display, "the newer row");
  assert.equal(only(roundTreeNames([newer, older]), PARENT).display, "the newer row");
  assert.equal(only(roundTreeNames([older, undated]), PARENT).display, "the older row", "an undated record names nothing over a dated one");
});

test("a round with no parentPath still names the tree it began in", () => {
  // Records written before parent trees existed: `pipelineRun.tree` (or the task's own worktree) is the one tree the
  // round started in, and a round that began in it is the fact that makes its task name the row's name.
  const viaTree = roundTreeNames([task(7, { round: { parent: "main", sha: "abc123" }, tree: { path: PARENT } })]);
  assert.equal(only(viaTree, PARENT).display, "274: the row's own name, #7");
  const viaWorktree = roundTreeNames([task(7, { round: { parent: "main", sha: "abc123" } }, { worktree: PARENT })]);
  assert.equal(only(viaWorktree, PARENT).display, "274: the row's own name, #7");
});

test("a record with no task title still names its parent from the round it holds", () => {
  // `pickTask` drops an untitled task, so this is a hand-edited record; the fallback is still honest: the round's own
  // display, then its slug, and never a name invented from the path.
  const noTitle = { id: 7, pipelineRun: { round: round({ display: "the round's display" }) } };
  assert.equal(only(roundTreeNames([noTitle]), PARENT).display, "the round's display");
  const noDisplay = { id: 7, pipelineRun: { round: round({ display: "" }) } };
  assert.equal(only(roundTreeNames([noDisplay]), PARENT).display, "round-a");
});
