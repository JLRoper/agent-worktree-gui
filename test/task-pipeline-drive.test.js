// Driving a task THROUGH its pipeline — lib/task-pipeline-drive.js.
//
// The record (lib/task-pipeline.js) says where a row is; the assignment (lib/task-pipeline-assign.js) says how it got
// there. This file pins the third thing: what happens NEXT, and only for a row that is actually on a pipeline.
//
// What it drives, and why each one is a rule rather than a detail:
//
//   1. a two-stage pipeline advances on settle — the row is written forward to the next stage in ONE pass, stamped
//      with that pass's clock, and the stage's worker is asked for by name;
//   2. the same pass does not ask twice: the request is written on the row (`startingAt`), so a sweep that runs again
//      before the spawner has linked a thread cannot start the same stage a second time;
//   3. a capped loop stops at its cap, and the crossings are counted ON THE RECORD, so the number the cap is compared
//      against survives a restart between two passes;
//   4. a loop that names no readable cap is not crossed at all — fail-closed, never "unlimited";
//   5. a gate that declares a decision record is a barrier: the code parks the row and never decides it, and the
//      record's arrival is the only thing that moves the row;
//   6. a failed run parks the row instead of re-running the stage;
//   7. a task with NO pipeline comes back untouched, and the settle that finishes it is exactly the one it had before
//      this module existed — no stage is invented for a row that never named one;
//   8. the row at the FRONT of the queue is the one started: a pipeline row behind a running row waits its turn.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { settleTasks } from "../lib/assistant/queue.js";
import { parseBundle } from "../lib/pipeline-bundle.js";
import { STARTING_AT, START_GRACE_MS, driveTaskPipelines, nextStageOf, stagePrompt } from "../lib/task-pipeline-drive.js";

const CLOCK = "2026-11-03T16:00:00.000Z";
const LATER = "2026-11-03T16:10:00.000Z";

const stage = (n) => ({
  id: `S${n}`,
  title: `Stage ${n}`,
  prompt: `Work stage ${n}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

const pipeline = (over = {}) => ({
  id: "two",
  title: "Two",
  stages: [stage(1), stage(2)],
  gates: [],
  handoffs: [{ id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" }],
  ...over,
});

const bundleOf = (record) => {
  const parsed = parseBundle({ bundleVersion: 1, name: "test", pipelines: [record] }, { file: "pipeline-bundle.json" });
  assert.equal(parsed.ok, true, parsed.reason || "the fixture bundle must parse");
  return parsed.bundle;
};

// A queue row as the driver reads one: the schema's own shape, and nothing the driver has to guess.
const row = (over = {}) => ({
  id: 1,
  title: "carry the contract",
  detail: "",
  state: "running",
  thread: "T1",
  threads: ["T1"],
  worktree: null,
  project: "agent-worktree-gui",
  files: [],
  attempts: 0,
  reason: "",
  hold: null,
  pipelineRun: { pipeline: "two", stage: "S1", enteredAt: "2026-11-03T15:00:00.000Z" },
  ...over,
});

const done = [{ id: "j1", thread: "T1", status: "done", startedAt: "2026-11-03T15:00:00.000Z", endedAt: "2026-11-03T15:30:00.000Z" }];

const drive = (tasks, over = {}) =>
  driveTaskPipelines(tasks, { bundle: bundleOf(pipeline()), jobs: done, isLive: () => false, at: CLOCK, unattended: true, ...over });

test("a two-stage pipeline advances the row on settle, and asks for the next stage by name", () => {
  const out = drive([row()]);

  assert.equal(out.changed.length, 1);
  assert.equal(out.changed[0].from, "running");
  assert.equal(out.changed[0].to, "queued");
  assert.equal(out.changed[0].stage, "S2");

  const task = out.tasks[0];
  assert.equal(task.state, "queued", "the row stays open: the pipeline is not finished, only this stage is");
  assert.equal(task.pipelineRun.stage, "S2");
  assert.equal(task.pipelineRun.enteredAt, CLOCK, "the entry is stamped from THIS pass's clock, not the previous stage's");
  assert.equal(task.pipelineRun.crossings.h1, 1, "the edge the row took is counted on the record");

  assert.equal(out.starts.length, 1);
  const start = out.starts[0];
  assert.equal(start.taskId, 1);
  assert.equal(start.stage, "S2");
  assert.equal(start.position, 2);
  assert.equal(start.count, 2);
  assert.equal(start.target, "agent-worktree-gui", "a row with no tree starts in its project");
  assert.equal(start.existing, false);
  assert.match(start.prompt, /Work stage 2\./);
  assert.match(start.prompt, /Queue task #1: carry the contract/);
  assert.equal(task.pipelineRun[STARTING_AT], CLOCK, "the start request is written on the row in the same pass");
});

test("a stage that was just asked for is not asked for again until its run links", () => {
  const first = drive([row()]);
  const second = drive(first.tasks, { jobs: [] });

  assert.equal(second.starts.length, 0, "the request is on the row, so the next pass can see it");
  assert.ok(second.notes.some((note) => note.code === "pipeline-starting"));

  // Past the grace the request is taken as lost and the stage is asked for again — a start that never linked is not
  // a reason to leave the row waiting for ever.
  const late = new Date(Date.parse(CLOCK) + START_GRACE_MS + 1000).toISOString();
  const retried = drive(second.tasks, { jobs: [], at: late });
  assert.equal(retried.starts.length, 1);
  assert.equal(retried.starts[0].stage, "S2");
  assert.equal(retried.tasks[0].pipelineRun[STARTING_AT], late, "the retry restamps the request");
});

test("a capped loop advances below its cap and stops AT it", () => {
  const looped = bundleOf(
    pipeline({
      stages: [stage(1), stage(2)],
      handoffs: [{ id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "2 rounds" }],
    }),
  );
  const at = (crossings) =>
    drive([row({ pipelineRun: { pipeline: "two", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z", crossings } })], {
      bundle: looped,
      jobs: done,
      unattended: false,
    });

  const first = at({});
  assert.equal(first.tasks[0].state, "queued");
  assert.equal(first.tasks[0].pipelineRun.stage, "S1");
  assert.equal(first.tasks[0].pipelineRun.crossings["h-back"], 1);

  const second = at({ "h-back": 1 });
  assert.equal(second.tasks[0].state, "queued");
  assert.equal(second.tasks[0].pipelineRun.crossings["h-back"], 2);

  const third = at({ "h-back": 2 });
  assert.equal(third.tasks[0].state, "parked", "the third crossing is past a cap of two rounds");
  assert.equal(third.tasks[0].pipelineRun.stage, "S2", "the row stops where it settled");
  assert.match(third.changed[0].why, /at its cap of 2 rounds/);
  assert.equal(third.changed[0].to, "parked");
  assert.equal(third.tasks[0].hold.kind, "manual", "a cap is a decision; nothing the panel can test releases it");
});

test("a loop with no readable cap is not crossed at all", () => {
  const looped = bundleOf(
    pipeline({
      handoffs: [{ id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop" }],
    }),
  );
  const out = drive([row({ pipelineRun: { pipeline: "two", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z" } })], {
    bundle: looped,
    unattended: false,
  });

  assert.equal(out.tasks[0].state, "parked");
  assert.equal(out.tasks[0].pipelineRun.stage, "S2");
  assert.match(out.changed[0].why, /does not guess a limit/);
});

test("a gate that declares a decision record is crossed only by that record", () => {
  const tree = mkdtempSync(path.join(tmpdir(), "wag-gate-"));
  try {
    const gated = bundleOf(
      pipeline({
        gates: [
          {
            id: "G1",
            name: "The call",
            after: "S1",
            artifact: "artifact-1",
            decider: "seat",
            decision: { id: "d1", path: "gates/G1-{{finding}}.json", schema: "decision/1", writer: "seat", outcomes: ["GO", "NO"] },
          },
        ],
      }),
    );

    // No record: the stage settles, and the row parks ON the path rather than crossing. Nothing in the driver writes
    // that file, and no verdict is inferred from the run having finished.
    const stopped = drive([row({ worktree: tree })], { bundle: gated, unattended: false });
    assert.equal(stopped.tasks[0].state, "parked");
    assert.equal(stopped.tasks[0].pipelineRun.stage, "S1", "the gate is not decided by the code");
    assert.equal(stopped.tasks[0].pipelineRun.waitingFor.gate, "G1");
    assert.match(stopped.changed[0].why, /does not decide it/);

    // The record arrives. The panel reads its PRESENCE, not its value, and the row crosses.
    mkdirSync(path.join(tree, "gates"), { recursive: true });
    writeFileSync(path.join(tree, "gates", "G1-F-77.json"), JSON.stringify({ decision: "GO" }));

    const crossed = drive(stopped.tasks, { bundle: gated, jobs: [], at: LATER, unattended: false });
    assert.equal(crossed.changed.length, 1);
    assert.equal(crossed.changed[0].from, "parked");
    assert.equal(crossed.changed[0].to, "queued");
    assert.equal(crossed.tasks[0].state, "queued");
    assert.equal(crossed.tasks[0].pipelineRun.stage, "S2");
    assert.equal(crossed.tasks[0].pipelineRun.waitingFor, undefined, "the wait belongs to the edge, and the edge is behind it");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("a failed run parks the row instead of re-running the stage", () => {
  const out = drive([row()], { jobs: [{ thread: "T1", status: "failed", finalMessage: "the build broke" }] });

  assert.equal(out.tasks[0].state, "parked");
  assert.equal(out.tasks[0].attempts, 0, "the driver does not spend an attempt by restarting the stage");
  assert.equal(out.tasks[0].pipelineRun.stage, "S1");
  assert.match(out.tasks[0].reason, /ended failed: the build broke/);
  assert.equal(out.starts.length, 0);
});

test("a task with no pipeline comes back untouched, and settles exactly as it did before", () => {
  const plain = [row({ pipelineRun: null })];
  const out = drive(plain);

  assert.equal(out.changed.length, 0, "no stage is invented for a row that never named one");
  assert.equal(out.starts.length, 0);
  assert.deepEqual(out.tasks, plain);

  // The settle that finishes it is the queue's own, unchanged: a done run with no tree is done.
  const settled = settleTasks(out.tasks, { jobs: done, isLive: () => false, at: CLOCK });
  assert.equal(settled.changed.length, 1);
  assert.equal(settled.changed[0].to, "done");
  assert.equal(settled.tasks[0].state, "done");
  assert.match(settled.changed[0].why, /no tree to land/);
});

test("a queued row with no pipeline at the front is not started, and the pipeline row behind it waits", () => {
  const out = drive([
    row({ id: 1, state: "queued", thread: null, threads: [], pipelineRun: null }),
    row({ id: 2, state: "queued", thread: null, threads: [], pipelineRun: { pipeline: "two", stage: "S1", enteredAt: "2026-11-03T15:00:00.000Z" } }),
  ]);

  assert.equal(out.starts.length, 0, "the front row is the assistant's to start; the driver does not jump the queue");
  assert.equal(out.changed.length, 0);
  assert.equal(out.tasks[1].state, "queued");
});

test("the front row that does carry a pipeline is started, in its own project", () => {
  const out = drive([row({ state: "queued", thread: null, threads: [] })]);

  assert.equal(out.starts.length, 1);
  assert.equal(out.starts[0].stage, "S1");
  assert.equal(out.starts[0].existing, false);
  assert.equal(out.tasks[0].state, "queued", "the row is still queued: the spawner is what makes it running");
});

test("a row with a tree starts the next stage IN that tree", () => {
  const tree = "C:/ProjectDevelopment/demo/.worktrees/the-row";
  const out = drive([row({ worktree: tree })]);
  assert.equal(out.starts[0].target, tree);
  assert.equal(out.starts[0].existing, true, "a stage after the first runs in the tree the pipeline already cut");
});

test("with unattended starts off the row still advances, and nothing is started", () => {
  const out = drive([row()], { unattended: false });
  assert.equal(out.tasks[0].state, "queued");
  assert.equal(out.tasks[0].pipelineRun.stage, "S2");
  assert.equal(out.starts.length, 0);
});

test("an assignment the bundle cannot resolve is left unresolved, and nothing is started", () => {
  const out = drive([row({ pipelineRun: { pipeline: "gone", stage: "S1", enteredAt: "2026-11-03T15:00:00.000Z" } })]);

  assert.equal(out.changed.length, 0, "a record naming a pipeline the bundle does not hold is not a stage to run");
  assert.equal(out.starts.length, 0);
  assert.equal(out.tasks[0].pipelineRun.pipeline, "gone");
  assert.ok(out.notes.some((note) => note.code === "pipeline-unresolved"));
});

test("the last stage is left to the settle: the pipeline does not invent a stage after it", () => {
  const out = drive([row({ pipelineRun: { pipeline: "two", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z" } })]);

  assert.equal(out.changed.length, 0);
  assert.equal(out.starts.length, 0);
  assert.equal(out.tasks[0].state, "running", "the row is finished by the settle, on the landing rule it always had");

  const settled = settleTasks(out.tasks, { jobs: done, isLive: () => false, at: CLOCK });
  assert.equal(settled.tasks[0].state, "done");
});

test("nextStageOf answers the graph: handoff first, reading order next, nothing after the last stage", () => {
  const two = bundleOf(pipeline()).pipelines[0];
  assert.equal(nextStageOf(two, { stage: "S1" }).stage.id, "S2");
  assert.equal(nextStageOf(two, { stage: "S1" }).handoff.id, "h1");
  assert.equal(nextStageOf(two, { stage: "S2" }).done, true);

  const ordered = bundleOf(pipeline({ handoffs: [] })).pipelines[0];
  assert.equal(nextStageOf(ordered, { stage: "S1" }).stage.id, "S2", "with no edge drawn, the reading order is the path");

  // A gate after the LAST stage gates no edge the driver would take, so it does not park a finished pipeline on a
  // record that can never change where the row goes.
  const closing = bundleOf(
    pipeline({
      gates: [{ id: "G9", name: "Close the run", after: "S2", artifact: "artifact-2", decider: "seat", decision: { id: "d9", path: "gates/G9.json", schema: "decision/1", writer: "seat", outcomes: ["CLOSED"] } }],
    }),
  ).pipelines[0];
  assert.equal(nextStageOf(closing, { stage: "S2" }).done, true);
});

test("stagePrompt is the stage's instruction plus the row, and nothing else", () => {
  const bundle = bundleOf(pipeline());
  const prompt = stagePrompt({ id: 7, title: "carry it", detail: "the reader's words" }, bundle.pipelines[0], bundle.pipelines[0].stages[1]);
  assert.match(prompt, /^Work stage 2\./);
  assert.match(prompt, /stage 2 of 2, Stage 2 \(two\/S2\)/);
  assert.match(prompt, /Queue task #7: carry it/);
  assert.match(prompt, /the reader's words/);
});
