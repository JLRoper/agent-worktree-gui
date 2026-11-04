// The pipeline driver THROUGH the panel: `Assistant.sweepQueues` is the clock that drives a queue task from one stage
// to the next without anybody pressing anything.
//
// The policy has its own file (test/task-pipeline-drive.test.js). This one proves the wiring, because a driver that
// nothing calls is a library nobody uses:
//
//   - a task put on a two-stage pipeline is STARTED unattended at its stage when it reaches the front of the queue,
//     with the stage's own prompt and the row's id on the spawn spec;
//   - the stage's run settling writes the row forward to the next stage and starts THAT stage in the same sweep;
//   - the row stays OPEN until the last stage settles, and only then does the queue's own settle finish it;
//   - a row with no pipeline is never started by the driver, and is still finished by the settle exactly as before.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { readQueueFile } from "../lib/assistant/queue.js";

const T0 = Date.parse("2026-11-03T16:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const PROJECT = { name: "agent-worktree-gui", path: "C:/ProjectDevelopment/agent-worktree-gui" };
const THREAD = "wtgui-pipeline-4ab3c1";

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
      stages: [stage(1), stage(2)],
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
  const state = { board: [], started: [], rows: [] };
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
  };
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir, pipelineBundleFile: bundleFile },
    jobs,
    getProjects: () => [PROJECT],
    // The board the settle reads a tree's landing verdict from: empty until a test says the work landed.
    getRows: () => state.rows,
    // No tree is cut: a stage that runs in the project's own checkout. It keeps this test about the pipeline, and it
    // is the shape a stage whose work is a decision (rather than an edit) actually has.
    spawner: async (spec) => {
      const job = { id: `job-${state.started.length + 1}`, thread: THREAD, cwd: PROJECT.path, worktreePath: null, status: "running", startedAt: iso(T0) };
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

test("a pipeline task is started at its stage, advanced on settle, and finished by the last stage's settle", async (t) => {
  const { assistant, state, rowOf, settleStarts } = harness(t);

  const added = assistant.queueMutate("assistant-1", "add", { title: "carry the contract", project: "agent-worktree-gui" }).task;
  const assigned = putOnPipeline(assistant, added.id, "S1");
  assert.equal(assigned.ok, true, assigned.error || "");
  assert.equal(rowOf(added.id).pipelineRun.stage, "S1");

  // 1. The first sweep starts the stage that the reader put the row on, with no card and no press.
  assistant.sweepQueues();
  await settleStarts();
  assert.equal(state.started.length, 1, "the stage's worker was started");
  assert.equal(state.started[0].taskId, added.id, "the spawn names the queue row it serves");
  assert.match(state.started[0].prompt, /Do stage 1\./);
  assert.match(state.started[0].prompt, new RegExp(`Queue task #${added.id}: carry the contract`));

  let row = rowOf(added.id);
  assert.equal(row.state, "running", "the cut linked the row running with its thread");
  assert.equal(row.thread, THREAD);

  // 2. The stage's run settles. The sweep writes the row forward and starts the NEXT stage in the same pass.
  state.board[0].status = "done";
  assistant.sweepQueues();
  await settleStarts();

  row = rowOf(added.id);
  assert.equal(row.state, "running", "the row stays open: the pipeline has another stage");
  assert.equal(row.pipelineRun.stage, "S2", "the row was written forward a stage");
  assert.equal(row.pipelineRun.crossings.h1, 1);
  assert.equal(state.started.length, 2, "the second stage was started by the panel, not left for the assistant");
  assert.match(state.started[1].prompt, /Do stage 2\./);
  assert.equal(state.started[1].taskId, added.id);

  // 3. The last stage settles. The driver has nothing after it, so the queue's own settle finishes the row — the
  //    same transition it has always made, on the row that is now done. The landing rule is unchanged: a row with a
  //    tree is done when that tree's PR reads MERGED.
  state.board[1].status = "done";
  state.rows.push({ path: PROJECT.path, verdict: "MERGED" });
  assistant.sweepQueues();
  await settleStarts();

  row = rowOf(added.id);
  assert.equal(row.state, "done");
  assert.match(row.reason, /PR reads MERGED/, "the last stage is finished by the settle's landing rule, not by the driver");
  assert.equal(row.pipelineRun.stage, "S2", "the record still says which stage finished it");
  assert.equal(state.started.length, 2, "no third stage is invented at the end of the pipeline");

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

test("with the spawn switch on ask the panel does not start the stage", async (t) => {
  const { assistant, state, rowOf, settleStarts } = harness(t, { spawn: "ask" });

  const added = assistant.queueMutate("assistant-1", "add", { title: "the asked row", project: "agent-worktree-gui" }).task;
  putOnPipeline(assistant, added.id, "S1");
  assistant.sweepQueues();
  await settleStarts();

  assert.equal(state.started.length, 0, "the reader told the panel to ask first");
  assert.equal(rowOf(added.id).state, "queued");
  assert.equal(rowOf(added.id).pipelineRun.stage, "S1", "the row is still where the reader put it");
});
