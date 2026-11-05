// Driving a FAN-OUT through the driver — lib/task-pipeline-drive.js with lib/pipeline-fanout.js.
//
// The shared model (test/task-pipeline-drive.test.js) pins one tree per row. This file pins the other one, and the
// three answers that decide it:
//
//   1. `isolation: "shared"` — the same graph runs in ONE tree, exactly as it did before this field existed. The
//      contrast case is asserted first so a per-stage row can never be confused with a shared one.
//   2. `isolation: "per-stage"` — every LANE is cut its OWN tree from the block's base, and the row's `tree` is never
//      a lane's: the row's tree is the aggregate's, the branch that lands.
//   3. the JOIN is entered by ONE merge: the driver asks for the aggregate with every lane pinned by COMMIT, refuses
//      to start the aggregator's worker before that merge is recorded, and its prompt names each lane by pin.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { DRIVE_FAULTS, driveTaskPipelines, renderDecision, stageTreeLookup } from "../lib/task-pipeline-drive.js";

const CLOCK = "2026-11-05T16:00:00.000Z";
const LATER = "2026-11-05T16:20:00.000Z";
const BASE = "b".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const MERGE = "3".repeat(40);

const stage = (n, over = {}) => ({
  id: `S${n}`,
  title: `Write report ${n}`,
  prompt: `Write reports/S${n}.md and nothing else.`,
  artifact: { id: `report-${n}`, path: `reports/S${n}.md`, schema: "report/1", writer: `writer-${n}` },
  ...over,
});

// Two roots (S1, S2) and one aggregator (S3): the pipeline's START is the fork, which is the 3-stage proof the brief
// asks for — a stage count, one tree per stage, and one aggregate commit.
const pipeline = (over = {}) => ({
  id: "reports",
  title: "Reports",
  isolation: "per-stage",
  stages: [stage(1), stage(2), stage(3, { artifact: { id: "report-3", path: "reports/aggregate.md", schema: "report/1", writer: "writer-3" } })],
  gates: [],
  handoffs: [
    { id: "h1", from: "S1", to: "S3", artifact: "report-1", kind: "sequence" },
    { id: "h2", from: "S2", to: "S3", artifact: "report-2", kind: "sequence" },
  ],
  ...over,
});

const bundleOf = (record) => {
  const parsed = parseBundle({ bundleVersion: 1, name: "test", pipelines: [record] }, { file: "pipeline-bundle.json" });
  assert.equal(parsed.ok, true, parsed.reason || "the fixture bundle must parse");
  return parsed.bundle;
};

const row = (over = {}) => ({
  id: 7,
  title: "write the two reports",
  detail: "",
  state: "queued",
  thread: null,
  threads: [],
  worktree: null,
  project: "agent-worktree-gui",
  files: [],
  attempts: 0,
  reason: "",
  hold: null,
  pipelineRun: { pipeline: "reports", stage: "S1", enteredAt: CLOCK },
  ...over,
});

const dirs = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wag-drive-fanout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const make = (name, reports = []) => {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, "reports"), { recursive: true });
    // The artifact a stage declares must be IN ITS TREE at settle: the design's one hard gate, and a lane that wrote
    // its own report is the normal case this fixture stands in for.
    for (const report of reports) writeFileSync(path.join(dir, "reports", `${report}.md`), `# ${report} in ${name}\n`);
    return dir;
  };
  return { root, a: make("lane-a", ["S1"]), b: make("lane-b", ["S2"]), agg: make("aggregate", ["aggregate"]) };
};

// A lane's settled stage run: the tree it ran in, its branch, the commit it settled at, and the artifact's pin. The
// aggregate takes the COMMIT and never the branch, so every field here is one the merge actually consumes.
const laneRun = (n, { dir, branch, commit, sha }) => ({
  id: `reports/S${n}#1`,
  stage: `S${n}`,
  visit: 1,
  at: CLOCK,
  thread: `T${n}`,
  job: `j${n}`,
  status: "done",
  settledAt: LATER,
  commit,
  tree: { path: dir, branch, head: "abc1234", commit, dirty: 0 },
  artifact: { id: `report-${n}`, path: `reports/S${n}.md`, present: true, sha256: sha.repeat(32), commit, blob: "f".repeat(40), blobSha256: sha.repeat(32) },
});

const jobsDone = (n) => [{ id: `j${n}`, thread: `T${n}`, status: "done", startedAt: CLOCK, endedAt: LATER }];

const drive = (tasks, bundle, over = {}) =>
  driveTaskPipelines(tasks, { bundle, jobs: [], isLive: () => false, at: CLOCK, unattended: true, ...over });

test("shared is the contrast: the same graph is ONE tree, cut as the row's, with no block to aggregate", (t) => {
  const d = dirs(t);
  const out = drive([row({ state: "queued" })], bundleOf(pipeline({ isolation: "shared" })));

  assert.equal(out.ensureTree.length, 1);
  assert.equal(out.ensureTree[0].role, "row", "a shared pipeline cuts the row's one tree");
  assert.equal(out.ensureTree[0].base, null);
  assert.equal(out.ensureTree[0].plans, null, "no block: there is nothing to aggregate");
  assert.equal(out.aggregates.length, 0);
});

test("a chain on a per-stage pipeline still keeps today's single tree: only the concurrent part fans out", (t) => {
  const d = dirs(t);
  const chain = pipeline({
    isolation: "per-stage",
    stages: [stage(1), stage(2), stage(3)],
    handoffs: [
      { id: "c1", from: "S1", to: "S2", artifact: "report-1", kind: "sequence" },
      { id: "c2", from: "S2", to: "S3", artifact: "report-2", kind: "sequence" },
    ],
  });
  const bundle = bundleOf(chain);
  const first = drive([row()], bundle);
  assert.equal(first.ensureTree[0].role, "row", "no fan-out block → the row's own tree");
  assert.equal(first.ensureTree[0].plans, null);

  const s1Done = row({
    state: "running",
    thread: "T1",
    threads: ["T1"],
    worktree: d.a,
    pipelineRun: {
      pipeline: "reports",
      stage: "S1",
      enteredAt: CLOCK,
      visits: { S1: 1 },
      tree: { path: d.a, branch: "wtgui/s1-aaa" },
      stageRuns: [laneRun(1, { dir: d.a, branch: "wtgui/s1-aaa", commit: C1, sha: "a" })],
    },
  });
  const next = drive([s1Done], bundle, { jobs: jobsDone(1) });
  assert.equal(next.tasks[0].pipelineRun.stage, "S2");
  assert.equal(next.ensureTree.length, 0, "S2 runs in the tree S1 ran in: no second cut");
  assert.equal(next.starts.length, 1);
  assert.equal(next.starts[0].target, d.a, "the chain keeps ONE tree");
  assert.equal(next.starts[0].isolation, undefined, "no fan-out marker: this is the shared workspace model");
});

test("per-stage cuts each lane its OWN tree from the same base, and the row's tree is never a lane's", (t) => {
  const d = dirs(t);
  const bundle = bundleOf(pipeline());

  // 1. The first lane has no tree and no base: the cut supplies both.
  const first = drive([row()], bundle);
  assert.equal(first.ensureTree.length, 1);
  assert.deepEqual(
    { stage: first.ensureTree[0].stage, role: first.ensureTree[0].role, base: first.ensureTree[0].base, plans: first.ensureTree[0].plans },
    { stage: "S1", role: "lane", base: null, plans: { fork: null, lanes: ["S1", "S2"], join: "S3" } },
    "a pipeline-start fan-out: the lanes are the roots and the fork is the start",
  );
  assert.equal(first.starts.length, 0, "nothing starts before its tree exists");

  // 2. The cut is written on the row's `pipelineRun`; the start targets THAT tree.
  const trees = { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE } };
  const fanout = { base: BASE, fork: null, lanes: ["S1", "S2"], join: "S3" };
  const cut = row({ pipelineRun: { pipeline: "reports", stage: "S1", enteredAt: CLOCK, visits: { S1: 1 }, trees, fanout } });
  const started = drive([cut], bundle);
  assert.equal(started.starts.length, 1);
  assert.equal(started.starts[0].stage, "S1");
  assert.equal(started.starts[0].target, d.a);
  assert.equal(started.starts[0].role, "lane");
  assert.equal(started.ensureTree.length, 0, "a lane with a tree is not cut twice");

  // 3. S1 settles: the row moves to S2 and asks for a cut at the SAME base — one tree per stage, one shared base.
  const s1Done = row({
    state: "running",
    thread: "T1",
    threads: ["T1"],
    worktree: d.a,
    trees: { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE } },
    fanout: { base: BASE, fork: null, lanes: ["S1", "S2"], join: "S3" },
    pipelineRun: {
      pipeline: "reports",
      stage: "S1",
      enteredAt: CLOCK,
      visits: { S1: 1 },
      trees: { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE } },
      fanout: { base: BASE, fork: null, lanes: ["S1", "S2"], join: "S3" },
      stageRuns: [laneRun(1, { dir: d.a, branch: "wtgui/s1-aaa", commit: C1, sha: "a" })],
    },
  });
  const next = drive([s1Done], bundle, { jobs: jobsDone(1) });
  assert.equal(next.changed.length, 1);
  assert.equal(next.changed[0].to, "queued");
  assert.equal(next.changed[0].stage, "S2");
  assert.equal(next.tasks[0].pipelineRun.stage, "S2");
  assert.equal(next.tasks[0].pipelineRun.tree, undefined, "a lane's tree is never promoted to the row's — the aggregate's will be");
  assert.deepEqual(next.tasks[0].pipelineRun.crossings || {}, {}, "a lane switch is not a handoff and spends no cap");
  assert.equal(next.ensureTree.length, 1);
  assert.equal(next.ensureTree[0].stage, "S2");
  assert.equal(next.ensureTree[0].role, "lane");
  assert.equal(next.ensureTree[0].base, BASE, "every lane is cut from the block's ONE base");
  assert.equal(next.starts.length, 0);
});

test("the last lane enters the join, whose tree is cut at the base and whose aggregate names every lane by commit", (t) => {
  const d = dirs(t);
  const bundle = bundleOf(pipeline());
  const fanout = { base: BASE, fork: null, lanes: ["S1", "S2"], join: "S3" };
  const s2Done = row({
    state: "running",
    // `thread` is the row's FIRST thread and `threads` accumulates the later ones; `currentThread` is the last of the
    // merged list, so this row's current run is T2 (the lane S2 stage run's thread).
    thread: "T1",
    threads: ["T2"],
    worktree: d.b,
    trees: { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE }, S2: { path: d.b, branch: "wtgui/s2-bbb", startSha: BASE } },
    fanout,
    pipelineRun: {
      pipeline: "reports",
      stage: "S2",
      enteredAt: CLOCK,
      visits: { S1: 1, S2: 1 },
      trees: { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE }, S2: { path: d.b, branch: "wtgui/s2-bbb", startSha: BASE } },
      fanout,
      stageRuns: [laneRun(1, { dir: d.a, branch: "wtgui/s1-aaa", commit: C1, sha: "a" }), laneRun(2, { dir: d.b, branch: "wtgui/s2-bbb", commit: C2, sha: "c" })],
    },
  });
  const next = drive([s2Done], bundle, { jobs: jobsDone(2) });
  assert.equal(next.tasks[0].pipelineRun.stage, "S3");
  assert.equal(next.ensureTree.length, 1);
  const request = next.ensureTree[0];
  assert.equal(request.stage, "S3");
  assert.equal(request.role, "join");
  assert.equal(request.base, BASE, "the aggregate is cut from the same base as the lanes");
  assert.deepEqual(
    request.branches.map((branch) => [branch.stage, branch.branch, branch.commit]),
    [
      ["S1", "wtgui/s1-aaa", C1],
      ["S2", "wtgui/s2-bbb", C2],
    ],
    "the merge takes each lane's COMMIT — a branch resolves differently tomorrow",
  );
  assert.equal(next.starts.length, 0, "the aggregator's worker does not start before the merge exists");
});

test("an aggregate that is owed is asked for once, and the aggregator starts in its tree only after the merge is recorded", (t) => {
  const d = dirs(t);
  const bundle = bundleOf(pipeline());
  const fanout = { base: BASE, fork: null, lanes: ["S1", "S2"], join: "S3" };
  const trees = { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE }, S2: { path: d.b, branch: "wtgui/s2-bbb", startSha: BASE }, S3: { path: d.agg, branch: "wtgui/aggregate-ccc", startSha: BASE } };
  const runs = [laneRun(1, { dir: d.a, branch: "wtgui/s1-aaa", commit: C1, sha: "a" }), laneRun(2, { dir: d.b, branch: "wtgui/s2-bbb", commit: C2, sha: "c" })];
  const atJoin = row({
    worktree: d.agg,
    trees,
    fanout,
    pipelineRun: {
      pipeline: "reports",
      stage: "S3",
      enteredAt: CLOCK,
      visits: { S1: 1, S2: 1, S3: 1 },
      trees,
      fanout,
      stageRuns: [...runs, { id: "reports/S3#1", stage: "S3", visit: 1, at: CLOCK, thread: null, job: null, status: null, decision: null }],
    },
  });

  // The tree exists and the merge does not: the driver asks for the merge and starts nobody.
  const owed = drive([atJoin], bundle);
  assert.equal(owed.aggregates.length, 1);
  assert.equal(owed.aggregates[0].stage, "S3");
  assert.equal(owed.aggregates[0].tree, d.agg);
  assert.equal(owed.aggregates[0].base, BASE);
  assert.deepEqual(owed.aggregates[0].branches.map((branch) => branch.commit), [C1, C2]);
  assert.equal(owed.starts.length, 0, "no worker before the merge — the stage would read a tree without its inputs");

  // The merge is recorded: now the aggregator starts in the aggregate tree, and its INPUTS block names every lane.
  const merged = {
    ...atJoin,
    pipelineRun: {
      ...atJoin.pipelineRun,
      stageRuns: [...runs, { id: "reports/S3#1", stage: "S3", visit: 1, at: CLOCK, thread: null, job: null, status: null, decision: null, merge: { commit: MERGE, base: BASE, branches: [{ stage: "S1", branch: "wtgui/s1-aaa", commit: C1 }, { stage: "S2", branch: "wtgui/s2-bbb", commit: C2 }] } }],
    },
  };
  const started = drive([merged], bundle);
  assert.equal(started.aggregates.length, 0, "a recorded merge is not made twice");
  assert.equal(started.starts.length, 1);
  assert.equal(started.starts[0].stage, "S3");
  assert.equal(started.starts[0].target, d.agg);
  assert.equal(started.starts[0].role, "join");
  const prompt = started.starts[0].prompt;
  assert.match(prompt, /lane\s+S1\s+report-1\s+reports\/S1\.md\s+commit 111111111111/, "the first lane, by its pinned commit");
  assert.match(prompt, /lane\s+S2\s+report-2\s+reports\/S2\.md\s+commit 222222222222/, "and the second");
  assert.match(prompt, /aggregate\s+ONE merge of 2 stage branches — commit 333333333333/, "the ONE merge, named");
  assert.match(prompt, /only this stage reads across lanes/, "the rule the aggregator is working under");
});

test("a stage's own tree is what the driver resolves, and a lane with no tree is a cut rather than the row's tree", (t) => {
  const d = dirs(t);
  const bundle = bundleOf(pipeline());
  const fanout = { base: BASE, fork: null, lanes: ["S1", "S2"], join: "S3" };
  // A row whose stage run used lane A's tree, while the ROW's tree is the aggregate's: the stage's own wins.
  const task = row({
    trees: { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE }, S3: { path: d.agg, branch: "wtgui/aggregate-ccc", startSha: BASE } },
    fanout,
    pipelineRun: {
      pipeline: "reports",
      stage: "S1",
      enteredAt: CLOCK,
      visits: { S1: 1 },
      tree: { path: d.agg, branch: "wtgui/aggregate-ccc" },
      trees: { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE }, S3: { path: d.agg, branch: "wtgui/aggregate-ccc", startSha: BASE } },
      fanout,
    },
  });
  const found = stageTreeLookup(task, bundle.pipelines[0]);
  assert.equal(found.path, d.a);
  assert.equal(found.role, "lane");
  assert.equal(found.source, "pipelineRun.trees");

  // A lane whose tree is gone is a PARK at settle/start (`lost`), never a quiet fallback to the aggregate.
  const gone = row({
    fanout,
    pipelineRun: {
      pipeline: "reports",
      stage: "S2",
      enteredAt: CLOCK,
      visits: { S1: 1, S2: 1 },
      tree: { path: d.agg },
      trees: { S2: { path: path.join(d.root, "deleted-lane"), branch: "wtgui/s2-bbb", startSha: BASE } },
      fanout,
    },
  });
  const lost = stageTreeLookup(gone, bundle.pipelines[0]);
  assert.equal(lost.path, null);
  assert.equal(lost.lost.path, path.join(d.root, "deleted-lane"));
  assert.equal(lost.needed, false, "a tree that was recorded and is gone is a park, not a second cut");
});

test("a conflict is rendered once, from the fact, with the paths two lanes both wrote", () => {
  const reason = renderDecision({
    kind: "aggregate",
    stage: "S3",
    pipeline: "reports",
    branches: [{ stage: "S1" }, { stage: "S2" }],
    conflicts: ["reports/shared.md"],
    base: BASE,
  });
  assert.match(reason, /was refused before it started/);
  assert.match(reason, /reports\/shared\.md/, "the path is in the sentence, not only in a log");
  assert.match(reason, /S1, S2/, "and which lanes produced it");
  assert.equal(DRIVE_FAULTS.CONFLICT, "pipeline-conflict", "the park code a reader and a test name");
});

test("a SHARED pipeline that draws a fork still has one tree per row: no stage is treated as a lane", (t) => {
  // The default is the contrast this model must never leak into: the SAME graph runs per-stage in one bundle and
  // shared in another, and under `shared` a stage that is a lane in the picture is an ordinary row stage. Reading the
  // block before the isolation would send this row looking for a lane tree it never cut and ask for a second one.
  const d = dirs(t);
  const bundle = bundleOf(pipeline({ isolation: "shared" }));
  const task = row({
    state: "queued",
    worktree: d.a,
    pipelineRun: {
      pipeline: "reports",
      stage: "S2",
      enteredAt: CLOCK,
      visits: { S1: 1, S2: 1 },
      tree: { path: d.a, branch: "wtgui/row-aaa" },
      stageRuns: [laneRun(1, { dir: d.a, branch: "wtgui/row-aaa", commit: C1, sha: "a" })],
    },
  });

  const found = stageTreeLookup(task, bundle.pipelines[0]);
  assert.equal(found.path, d.a, "the row's own tree answers a shared stage, lane-shaped or not");
  assert.equal(found.role, undefined, "there is no role under shared: this stage is not in a block");
  assert.equal(found.needed, false);

  const out = drive([task], bundle);
  assert.equal(out.ensureTree.length, 0, "shared never cuts a second tree");
  assert.equal(out.starts.length, 1);
  assert.equal(out.starts[0].target, d.a);
  assert.equal(out.starts[0].isolation, undefined, "and the start carries no fan-out marker");
});

test("a row entering the JOIN with no tree is asked for the aggregate tree — it does not park on a lane's pin", (t) => {
  // The join arrives by no single edge. Checking the last lane's pin against a tree that does not exist yet would
  // park the row on the one stage whose aggregate is the thing that puts every lane in its tree. The ledger here keeps
  // the pins a real settle records (the lane's commit on its run), which is what makes the check run at all.
  const d = dirs(t);
  const bundle = bundleOf(pipeline());
  const fanout = { base: BASE, fork: null, lanes: ["S1", "S2"], join: "S3" };
  const trees = { S1: { path: d.a, branch: "wtgui/s1-aaa", startSha: BASE }, S2: { path: d.b, branch: "wtgui/s2-bbb", startSha: BASE } };
  const atJoin = row({
    state: "queued",
    worktree: d.b,
    trees,
    fanout,
    pipelineRun: {
      pipeline: "reports",
      stage: "S3",
      enteredAt: CLOCK,
      visits: { S1: 1, S2: 1, S3: 1 },
      trees,
      fanout,
      stageRuns: [laneRun(1, { dir: d.a, branch: "wtgui/s1-aaa", commit: C1, sha: "a" }), laneRun(2, { dir: d.b, branch: "wtgui/s2-bbb", commit: C2, sha: "c" })],
    },
  });
  const next = drive([atJoin], bundle);
  assert.equal(next.tasks[0].state, "queued", "the row waits for its aggregate tree, it does not park");
  assert.equal(next.changed.filter((entry) => entry.to === "parked").length, 0);
  assert.equal(next.ensureTree.length, 1, "the cut is requested in the same pass");
  assert.equal(next.ensureTree[0].role, "join");
  assert.equal(next.ensureTree[0].base, BASE);
  assert.deepEqual(next.ensureTree[0].branches.map((branch) => branch.commit), [C1, C2]);
});
