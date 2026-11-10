// The pipeline driver THROUGH the panel: `Assistant.sweepQueues` is the clock that drives a queue task from one stage
// to the next without anybody pressing anything.
//
// The policy has its own file (test/task-pipeline-drive.test.js). This one proves the wiring, because a driver that
// nothing calls is a library nobody uses:
//
//   - a task put on a two-stage pipeline gets its tree CUT first (`ensureTree`), the path written on the row, and only
//     then is its stage started — inside that tree, on the `existing: true` path every later stage uses;
//   - the stage's run settling writes the row forward to the next stage and starts THAT stage in the same sweep;
//   - the row stays OPEN until the last stage settles, and only then does the queue's own settle finish it;
//   - a row with no pipeline is never started by the driver, and is still finished by the settle exactly as before.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { readQueueFile } from "../lib/assistant/queue.js";

const T0 = Date.parse("2026-11-03T16:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const PROJECT = { name: "agent-worktree-gui", path: "C:/ProjectDevelopment/agent-worktree-gui" };
const THREAD = "wtgui-pipeline-4ab3c1";
// The commit the round's parent resolved to at the first cut. Every stage tree of the round is cut at THIS, which is
// what the second cut's `from` is asserted against.
const ROUND_SHA = "9f3c1a2d4e5f60718293a4b5c6d7e8f901234567";

const stage = (n) => ({
  id: `S${n}`,
  title: `Stage ${n}`,
  prompt: `Do stage ${n}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

const bundleDoc = {
  bundleVersion: 1,
  name: "two",
  pipelines: [
    {
      id: "two",
      title: "Two stages",
      // The SECOND stage's artifact is the pull request this pipeline lands (artifact kind `pr`), so the end of this
      // walk is the settle's landing rule: the row is finished when that PR reads MERGED. A stage declaring any other
      // artifact is settled by the driver on its own verdict instead — that half is pinned in
      // test/task-pipeline-drive.test.js, and this file stays about the sweep that performs the landing read.
      stages: [stage(1), { ...stage(2), artifact: { ...stage(2).artifact, kind: "pr" } }],
      gates: [],
      handoffs: [{ id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" }],
    },
  ],
};

// A run that has not linked a thread yet would be a different failure; every start here comes back settled, so the
// row reads running with a thread the moment the spawner returns.
function harness(t, { spawn = "auto" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipeline-sweep-"));
  const bundleFile = path.join(dir, "pipeline-bundle.json");
  writeFileSync(bundleFile, JSON.stringify(bundleDoc));
  // `tree` is the ROUND'S PARENT TREE, written by the first cut of a round; `stageTrees` are its children.
  const state = { board: [], started: [], rows: [], cuts: [], tree: null, stageTrees: [] };
  const jobs = {
    list: () => state.board,
    firstOfThread: (thread) => state.board.find((j) => j.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    create: async (opts) => ({ id: "job-created", ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    get: () => null,
    clarify: { state: () => null },
    // The cut the design makes its own step: a directory and a branch, and the artifacts both stages will settle
    // with (a stage that ends `done` without its artifact parks, by design). A ROUND cuts a PARENT tree first (the
    // call with `round: true` and a `remote`), then one child per stage, all named by `stageTreeName` on the row, so
    // the name the caller passed is the directory and branch this answers.
    makeWorktree: async (repoDir, prompt, opts = {}) => {
      const n = state.cuts.length + 1;
      const named = opts.name && opts.name.dir ? { dir: opts.name.dir, branch: opts.name.branch } : null;
      const dirName = named ? named.dir : `carry-the-contract-s${n}-b${n}`;
      const branch = named ? named.branch : `wtgui/${dirName}`;
      const tree = path.join(dir, "trees", dirName);
      state.cuts.push({ repoDir, prompt, from: opts.from || null, parent: opts.parent || null, remote: opts.remote || null, round: opts.round === true, tree, branch, dir: dirName });
      if (!state.tree) state.tree = tree; // the first cut of a round IS its parent tree
      else state.stageTrees.push(tree);
      mkdirSync(path.join(tree, "out"), { recursive: true });
      writeFileSync(path.join(tree, "out", "1.json"), JSON.stringify({ stage: 1 }));
      writeFileSync(path.join(tree, "out", "2.json"), JSON.stringify({ stage: 2 }));
      return {
        path: tree,
        branch,
        startSha: ROUND_SHA,
        startRef: opts.round === true ? "origin/main" : opts.from || null,
        parentName: opts.round === true ? null : opts.parent || "main",
      };
    },
  };
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir, pipelineBundleFile: bundleFile },
    jobs,
    getProjects: () => [PROJECT],
    // The board the settle reads a tree's landing verdict from: empty until a test says the work landed.
    getRows: () => state.rows,
    // A stage that runs in the tree the cut made. It keeps this test about the pipeline rather than about git.
    spawner: async (spec) => {
      const job = { id: `job-${state.started.length + 1}`, thread: THREAD, cwd: spec.target, worktreePath: spec.target, status: "running", startedAt: iso(T0) };
      state.started.push(spec);
      state.board.push(job);
      return job;
    },
    now: () => T0,
  });
  assistant.settings.spawn = spawn;
  t.after(() => {
    clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    rmSync(dir, { recursive: true, force: true });
  });
  const rowOf = (id, who = "assistant-1") => readQueueFile(assistant.queuePathOf(assistant.assistantRecord(who))).tasks.find((x) => x.id === id) || null;
  const settleStarts = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { assistant, state, dir, bundleFile, rowOf, settleStarts };
}

const putOnPipeline = (assistant, id, stageId = "S1") =>
  assistant.queueMutate("assistant-1", "pipeline", { id, pipeline: "two", stage: stageId });

test("a pipeline task's tree is cut first, then its stage is started, advanced on settle, and finished by the last settle", async (t) => {
  const { assistant, state, rowOf, settleStarts } = harness(t);

  const added = assistant.queueMutate("assistant-1", "add", { title: "carry the contract", project: "agent-worktree-gui" }).task;
  const assigned = putOnPipeline(assistant, added.id, "S1");
  assert.equal(assigned.ok, true, assigned.error || "");
  assert.equal(rowOf(added.id).pipelineRun.stage, "S1");

  // 1. The first sweep ASKS for the tree, and the CUT'S OWN END asks for the stage: the tree is written on the row
  //    first, and the same handoff then starts the worker in it. Round 7's first stage waited 3 m 04.5 s after its tree
  //    because nothing fired at the cut's end — the row sat until the next queue tick, and a restart in between.
  assistant.sweepQueues();
  await settleStarts();
  // TWO cuts for one round's start: the round's PARENT tree from origin/main, then the first stage's own child of it.
  assert.equal(state.cuts.length, 2, "the round's parent tree, then the stage's own tree");
  assert.equal(state.cuts[0].round, true, "the first cut IS the round's parent tree");
  assert.equal(state.cuts[0].remote, "main", "cut from origin/main, never from the checkout's tip");
  assert.equal(state.cuts[0].from, null, "the parent tree names no start ref: the remote decides it");
  assert.equal(state.cuts[0].parent, null, "and names NO local parent, so the chart draws the round beside main");
  assert.equal(state.cuts[1].round, false, "the stage's tree is a child, not a second round");
  assert.equal(state.cuts[1].from, state.cuts[0].branch, "cut from the round's parent branch tip");
  assert.equal(state.cuts[1].parent, state.cuts[0].branch, "and recorded under it, so the chart nests one round together");
  assert.match(state.cuts[1].dir, /^carry-the-contract-stage-1-stage-1-[0-9a-f]{6}$/, "the child is named Stage 1 of the document");
  assert.match(state.cuts[0].prompt, /carry the contract/i);
  let row = rowOf(added.id);
  assert.equal(row.pipelineRun.round.parentPath, state.cuts[0].tree, "the round records its parent tree's path");
  assert.equal(row.pipelineRun.round.parent, state.cuts[0].branch, "and the branch that lands");
  assert.equal(row.pipelineRun.round.sha, ROUND_SHA);
  assert.equal(row.pipelineRun.round.base, "origin/main", "the record says which ref the round was cut from");
  assert.equal(row.pipelineRun.tree.path, state.cuts[0].tree, "the PARENT TREE is the row's landing tree from the first cut");
  assert.equal(row.pipelineRun.tree.branch, state.cuts[0].branch);
  assert.equal(row.pipelineRun.trees.S1.path, state.cuts[1].tree, "the stage's own child is on the record too");
  assert.equal(state.started.length, 1, "the cut's end asks for the start — no second sweep, no timer");

  // 2. A second sweep is a no-op: the trees are not cut again and the stage is not started twice.
  assistant.sweepQueues();
  await settleStarts();
  assert.equal(state.cuts.length, 2, "the tree step is not called twice");
  assert.equal(state.started.length, 1, "the stage is started once");
  assert.equal(state.started[0].taskId, added.id, "the spawn names the queue row it serves");
  assert.equal(state.started[0].target, state.cuts[1].tree, "the stage runs in its OWN tree, never the parent's");
  assert.equal(state.started[0].existing, true);
  assert.match(state.started[0].prompt, /Do stage 1\./);
  assert.match(state.started[0].prompt, new RegExp(`Queue task #${added.id}: carry the contract`));
  assert.match(state.started[0].prompt, /INPUTS\n/);
  assert.match(state.started[0].prompt, /tree {8}.*carry-the-contract-stage-1-stage-1-/, "the prompt quotes the tree the stage inherits");

  row = rowOf(added.id);
  assert.equal(row.state, "running", "the cut linked the row running with its thread");
  assert.equal(row.thread, THREAD);
  assert.equal(row.pipelineRun.stageRuns.at(-1).id, "two/S1#1");
  assert.equal(row.pipelineRun.stageRuns.at(-1).thread, THREAD, "the entry learned its thread at the link");

  // 3. The stage's run settles. The sweep writes the row forward and CUTS THE NEXT STAGE ITS OWN TREE, from the
  //    round's frozen parent: the row's one shared tree is the model this replaced.
  state.board[0].status = "done";
  assistant.sweepQueues();
  await settleStarts();

  row = rowOf(added.id);
  assert.equal(row.state, "running", "the row stays open: the pipeline has another stage");
  assert.equal(row.pipelineRun.stage, "S2", "the row was written forward a stage");
  assert.equal(row.pipelineRun.crossings.h1, 1);
  assert.equal(row.pipelineRun.visits.S2, 1);
  assert.equal(state.started.length, 2, "the second stage was started by the panel, not left for the assistant");
  assert.match(state.started[1].prompt, /Do stage 2\./);
  assert.equal(state.started[1].taskId, added.id);
  assert.equal(state.started[1].target, state.cuts[2].tree, "the second stage runs in ITS OWN tree");
  assert.notEqual(state.started[1].target, state.cuts[1].tree, "and never in the first stage's tree");
  assert.equal(state.cuts.length, 3, "the parent tree, then one child per stage of the round");
  assert.equal(state.cuts[2].from, state.cuts[0].branch, "cut from the round's parent tree's branch, never from origin/main as it stands now");
  assert.equal(state.cuts[2].parent, state.cuts[0].branch, "and recorded as a child of the round's parent tree, so the chart nests every stage of one round");
  assert.notEqual(state.cuts[2].from, "main", "the parent branch is the round's own, not the project's main");
  assert.match(state.cuts[2].dir, /^carry-the-contract-stage-2-stage-2-[0-9a-f]{6}$/, "named Stage 2 of the document");
  assert.equal(row.pipelineRun.round.sha, ROUND_SHA, "the round's parent commit is on the record, once");
  assert.equal(row.pipelineRun.round.parentPath, state.cuts[0].tree, "and it is still the parent tree the round began in");
  assert.equal(row.pipelineRun.trees.S1.path, state.cuts[1].tree);
  assert.equal(row.pipelineRun.trees.S2.path, state.cuts[2].tree);

  // 4. The last stage settles. The driver has nothing after it, so the queue's own settle finishes the row — the
  //    same transition it has always made, on the row that is now done. The landing rule is unchanged: a row with a
  //    tree is done when that tree's PR reads MERGED, and the tree it reads is the one the LAST stage ran in.
  state.board[1].status = "done";
  // The landing read finds MERGED for the tree the work is on: the last stage's child, and the round's parent tree
  // the assembly would land on (the stub's runs record no commit, so this round has nothing to assemble).
  for (const where of [state.cuts[1].tree, rowOf(added.id).worktree, state.tree].filter(Boolean)) state.rows.push({ path: where, verdict: "MERGED" });
  assistant.sweepQueues();
  await settleStarts();

  row = rowOf(added.id);
  assert.equal(row.state, "done");
  assert.match(row.reason, /PR reads MERGED/, "the last stage is finished by the settle's landing rule, not by the driver");
  assert.equal(row.pipelineRun.stage, "S2", "the record still says which stage finished it");
  assert.equal(state.started.length, 2, "no third stage is invented at the end of the pipeline");
  assert.equal(row.pipelineRun.stageRuns.at(-1).status, "done", "the last stage's run is recorded even though it moved nothing");

  const kinds = assistant.journal.map((line) => line.kind);
  assert.ok(kinds.includes("pipeline"), "each stage start is journalled as a pipeline act");
  assert.equal(kinds.filter((k) => k === "queue").length >= 2, true, "every row write is journalled once");
});

test("a queue row with no pipeline is not started by the driver, and settles as it always did", async (t) => {
  const { assistant, state, rowOf, settleStarts } = harness(t);

  const added = assistant.queueMutate("assistant-1", "add", { title: "the ordinary row", project: "agent-worktree-gui" }).task;
  assistant.sweepQueues();
  await settleStarts();
  assert.equal(state.started.length, 0, "no pipeline, no stage to invent: the assistant starts this row, as before");
  assert.equal(state.cuts.length, 0, "and no tree is cut for it");
  assert.equal(rowOf(added.id).state, "queued");

  // The same row, worked by a SPAWN: the settle finishes it exactly as it did before the driver existed.
  state.board.push({ id: "job-plain", thread: THREAD, status: "done", startedAt: iso(T0), worktreePath: null });
  const linked = assistant.queueMutate("assistant-1", "state", { id: added.id, state: "running" });
  assert.equal(linked.ok, true);
  assistant.queueMutate("assistant-1", "edit", { id: added.id, thread: THREAD });

  assistant.sweepQueues();
  await settleStarts();
  assert.equal(rowOf(added.id).state, "done");
});

test("with the spawn switch on ask the panel does not start the stage, and does not cut a tree", async (t) => {
  const { assistant, state, rowOf, settleStarts } = harness(t, { spawn: "ask" });

  const added = assistant.queueMutate("assistant-1", "add", { title: "the asked row", project: "agent-worktree-gui" }).task;
  putOnPipeline(assistant, added.id, "S1");
  assistant.sweepQueues();
  await settleStarts();

  assert.equal(state.started.length, 0, "the reader told the panel to ask first");
  assert.equal(state.cuts.length, 0, "a tree is not cut for a stage nobody may start");
  assert.equal(rowOf(added.id).state, "queued");
  assert.equal(rowOf(added.id).pipelineRun.stage, "S1", "the row is still where the reader put it");
});

test("a cap park is released by the reader's action, and the row starts again", async (t) => {
  const { assistant, state, rowOf, bundleFile, settleStarts } = harness(t);
  // A capped loop instead of the rail: one stage back to itself through an edge with a cap of one.
  writeFileSync(
    bundleFile,
    JSON.stringify({
      bundleVersion: 1,
      name: "loop",
      pipelines: [
        {
          id: "two",
          title: "Loop",
          stages: [stage(1), stage(2)],
          gates: [],
          handoffs: [{ id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "1 round" }],
        },
      ],
    }),
  );

  const added = assistant.queueMutate("assistant-1", "add", { title: "the looping row", project: "agent-worktree-gui" }).task;
  putOnPipeline(assistant, added.id, "S2");
  // The cut, then the first stage's start.
  assistant.sweepQueues();
  await settleStarts();
  assistant.sweepQueues();
  await settleStarts();
  assert.equal(state.started.length, 1);

  // Settle whatever the panel started last, then let the sweep act on it. The loop's first crossing is allowed
  // (S2 → S1), the rail brings the row back to S2, and the second crossing is past a cap of one.
  const runStage = async () => {
    state.board[state.board.length - 1].status = "done";
    assistant.sweepQueues();
    await settleStarts();
  };
  await runStage(); // S2 settles → S1, crossing 1
  assert.equal(rowOf(added.id).pipelineRun.stage, "S1");
  assert.equal(rowOf(added.id).pipelineRun.crossings["h-back"], 1);
  await runStage(); // S1 settles → S2 (the rail)
  assert.equal(rowOf(added.id).pipelineRun.stage, "S2");
  await runStage(); // S2 settles → the cap is hit
  let row = rowOf(added.id);
  assert.equal(row.state, "parked");
  assert.equal(row.pipelineRun.waitingFor.kind, "cap");

  // THE READER IS WOKEN. A cap park is the one wait a row cannot leave on its own, so the panel hands the reader's own
  // assistant ONE line naming the cap, the visits and the last verdict — instead of the row sitting silent until a
  // person sends pipeline-release {release: "cap"}. This loop has no gate, so the verdict half is honestly absent.
  const capWakes = assistant.pendingWake.filter((w) => w.rule === "pipelinecap");
  assert.equal(capWakes.length, 1, "one cap park, one wake — a parked row is not re-parked on the next pass");
  assert.equal(capWakes[0].assistantId, "assistant-1", "the wake goes to the row's own assistant");
  assert.match(capWakes[0].reason, /stopped at loop h-back/);
  assert.match(capWakes[0].reason, /a cap of 1 round/);
  assert.match(capWakes[0].reason, /visits S\d+ \d+/, "the line names what each stage's visit count was");
  assert.doesNotMatch(capWakes[0].reason, /last verdict/, "no gate here, so no verdict to name");
  assert.match(capWakes[0].reason, /pipeline-release \{release: "cap"\}/, "the line says what the reader's answer would be");

  // A requeue alone is not a release: the count is still at the cap, so the re-run parks again. (The start marker
  // from the parked stage is moved past its grace the way a real reader's requeue minutes later would be.)
  assistant.clock = () => T0 + 4 * 60 * 1000;
  assistant.queueMutate("assistant-1", "state", { id: added.id, state: "queued" });
  assistant.sweepQueues();
  await settleStarts();
  const restarted = state.started.length;
  state.board[state.board.length - 1].status = "done";
  assistant.sweepQueues();
  await settleStarts();
  assert.equal(state.started.length, restarted, "the requeue's re-run settles and is not started again");
  assert.equal(rowOf(added.id).state, "parked", "the count did not move, so the cap parks it again");

  // The reader's release resets the edge, and the next settle crosses it.
  const released = assistant.queueMutate("assistant-1", "pipeline-release", { id: added.id, release: "cap" });
  assert.equal(released.ok, true, released.error || "");
  row = rowOf(added.id);
  assert.equal(row.pipelineRun.crossings["h-back"], 0);
  assert.equal(row.pipelineRun.stageRuns.at(-1).decision.by, "reader");
  assert.equal(row.pipelineRun.stageRuns.at(-1).decision.fact.kind, "cap-release");
});

// The remote write a STAGE earns, decided by its declared artifact and carried to the spawner. The sweep is where the
// round's defect lived: `startSpawn` was handed no flag, so `lib/jobs.js` rendered the PARENT's LANDING paragraph for
// every stage and a document stage pushed its branch and opened PR #607 (docs/reviews/ping-pong-round-6-2026-11-08.html).
// Here the DRIVER's own answers are pinned: a stage that writes a document says `local`, a stage whose artifact is the
// pull request says `pr`. The paragraph those two words render is asserted in test/branch-policy.test.js and, end to
// end through the real spawner, in test/spawn-stage-landing.test.js.
test("a stage's artifact decides its remote write: a document stage is local, a pr stage is not", async (t) => {
  const { assistant, state, rowOf, settleStarts } = harness(t);

  const added = assistant.queueMutate("assistant-1", "add", { title: "carry the contract", project: "agent-worktree-gui" }).task;
  putOnPipeline(assistant, added.id, "S1");
  assistant.sweepQueues(); // the cut
  await settleStarts();
  assistant.sweepQueues(); // the first stage's start
  await settleStarts();
  assert.equal(state.started.length, 1);
  assert.equal(state.started[0].remoteWrite, "local", "S1 writes a document, so its worker is told to commit and report");

  state.board[0].status = "done";
  assistant.sweepQueues();
  await settleStarts();
  assert.equal(state.started.length, 2, "the next stage was started by the same sweep");
  // Even the stage whose artifact IS the pull request runs local-only: its branch is one of the round's stage
  // branches, and the branch that lands is the round's parent tree, which the assembly carries every stage onto
  // (docs/task-pipeline.md, "Stage branches are local only"). A stage that pushed here would open a PR holding one
  // stage of the round and leave the rest unlanded.
  assert.equal(state.started[1].remoteWrite, "local", "a stage tree is local-only, whatever its artifact declares");
  assert.equal(rowOf(added.id).pipelineRun.stage, "S2");
});

// The 38 m 38 s: the round-7 row was ADDED at 23:18:31 and put on its pipeline much later, and a crash between the two
// writes would have left a queued row naming no stage. The queue now files a row ONTO a stage in one write, and this
// proves the panel's add path performs it — one row, its stage already on it, and one journal line saying both.
test("a row filed onto a stage by the queue is written once, and its stage is there before the first sweep", async (t) => {
  const { assistant, state, rowOf, settleStarts } = harness(t);

  const added = assistant.queueMutate("assistant-1", "add", { title: "filed on the first stage", project: "agent-worktree-gui", pipeline: "two", stage: "S1" });
  assert.equal(added.ok, true, added.error || "");
  const row = rowOf(added.task.id);
  assert.equal(row.state, "queued");
  assert.equal(row.pipelineRun.stage, "S1", "the row carries its stage from the moment it exists");
  assert.equal(row.pipelineRun.enteredAt, row.createdAt, "one clock: the row's stamp and the stage's are the same instant");
  assert.equal(row.pipelineRun.visits.S1, 1);
  const lines = assistant.journal.filter((line) => line.kind === "queue").map((line) => String(line.text || ""));
  assert.equal(lines.filter((text) => /added #/.test(text)).length, 1, "one add, one journal line");
  assert.match(lines.find((text) => /added #/.test(text)) || "", /on two · S1/, "the line names the stage the row was filed on");

  // And it is driven like any other pipeline row: the first sweep asks for the tree.
  assistant.sweepQueues();
  await settleStarts();
  assert.equal(state.cuts.length, 2, "the round's parent tree, then the stage's own child");
  assert.equal(rowOf(added.task.id).pipelineRun.tree.path, state.cuts[0].tree, "the row's landing tree is the round's parent tree");
});

// The cut's end is the handoff (round 7's item 6): the tree write is followed, in the same turn, by the pass that asks
// for the stage's worker. It must also not LOOP — the handoff's own pass finds `startingAt` on the row and asks nothing
// further, so one cut costs exactly two passes.
test("a cut asks for its stage at once, and the handoff does not loop", async (t) => {
  const { assistant, state, settleStarts } = harness(t);
  const added = assistant.queueMutate("assistant-1", "add", { title: "hand off at the cut", project: "agent-worktree-gui" }).task;
  putOnPipeline(assistant, added.id, "S1");

  let passes = 0;
  const real = assistant.sweepQueues.bind(assistant);
  assistant.sweepQueues = () => {
    passes += 1;
    return real();
  };
  assistant.sweepQueues();
  await settleStarts();

  assert.equal(state.cuts.length, 2, "the round's parent tree and the stage's child, cut once each");
  assert.equal(state.started.length, 1, "and the stage started without a second pass from a timer");
  assert.equal(passes, 2, "the outer pass, then the handoff's own — which asks for nothing further");
});
