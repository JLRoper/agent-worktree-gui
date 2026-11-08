// A pipeline WALKS: every stage boundary is crossed by the panel's own clock, with nobody starting anything by hand.
//
// `Assistant.sweepQueues` is the only clock a pipeline has. This file drives the three small SHIPPED documents
// (`ping-pong`, `probe-fix`, `author-review-revise` — read from pipeline-bundle.seed.json, so a document whose graph
// moves fails this file too) through it, with a scripted seat:
//
//   - ping-pong: draft ⇄ critique, capped at 3 rounds. Eight stage runs, three crossings of H-02, then the cap park.
//     Nothing is started by hand: the sweep that settles a stage is the sweep that starts the next one.
//   - a row the reader REQUEUES over a stage that has already settled is advanced by the next sweep, not run again.
//     That is the leftover state a panel restart or a manual requeue leaves behind, and starting the same stage
//     again is the stall this driver must not have.
//   - probe-fix: probe → fix, once each, then the last stage's own verdict finishes the row — its artifact is a patch,
//     not a PR, so there is no landing for the settle to read.
//   - author-review-revise: author → review ⇄ author (a gate's verdict decides) → revise, so a sequence, a routed
//     loop and a finish are all crossed without a person pressing start.
//
// The seat writes the stage's declared artifact into the tree (a stage that ends `done` without one parks by design)
// and returns the job record a gateway would have returned; the harness flips that job to `done` before the next
// sweep, which is exactly what a worker finishing between two ticks looks like.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { currentThread, readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";

const T0 = Date.parse("2026-11-05T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
// The registry entry the panel cuts in. The seat below performs the cut itself, so the path is this test file's own
// checkout — never a folder on the machine that wrote it (`tools/absolute-paths.mjs`).
const PROJECT = { name: "agent-worktree-gui", path: path.resolve(import.meta.dirname, "..") };
const SEED = path.resolve(import.meta.dirname, "..", "pipeline-bundle.seed.json");

function harness(t, { pipelines = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-pipeline-walk-"));
  const bundleFile = path.join(dir, "pipeline-bundle.json");
  const seed = JSON.parse(readFileSync(SEED, "utf8"));
  const doc = pipelines ? { bundleVersion: 1, name: "walk", pipelines: seed.pipelines.filter((p) => pipelines.includes(p.id)) } : seed;
  writeFileSync(bundleFile, JSON.stringify(doc));
  // The seat reads the same document the panel was handed, so a stage's artifact path comes from the document and not
  // from the test's own copy of it.
  const document = { bundle: doc };
  const state = {
    board: [],
    started: [],
    cuts: [],
    rows: [],
    tree: path.join(dir, "trees", "walk-a1b2c3"),
    clock: T0,
  };
  let jobNo = 0;
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
    makeWorktree: async (repoDir, prompt) => {
      state.cuts.push({ repoDir, prompt });
      mkdirSync(state.tree, { recursive: true });
      return { path: state.tree, branch: "wtgui/walk-a1b2c3", startSha: null };
    },
  };
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir, pipelineBundleFile: bundleFile },
    jobs,
    getProjects: () => [PROJECT],
    getRows: () => state.rows,
    // The seat: it learns which stage it is in from the provenance line the DRIVER put in its prompt, writes the
    // stage's declared artifact into that tree, and returns the job record. It is handed nothing else.
    spawner: async (spec) => {
      const found = /\(([\w.-]+)\/([\w.-]+)\)(?:, visit (\d+))?/.exec(spec.prompt);
      assert.ok(found, `the stage prompt names its stage: ${spec.prompt.slice(0, 200)}`);
      const [, pipelineId, stageId, visit] = found;
      const pipeline = (document.bundle.pipelines || []).find((p) => p.id === pipelineId);
      const stage = pipeline && pipeline.stages.find((s) => s.id === stageId);
      assert.ok(stage && stage.artifact, `${pipelineId}/${stageId} declares an artifact`);
      const file = path.join(spec.target, stage.artifact.path);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${pipelineId}/${stageId} visit ${visit} — ${state.started.length + 1}\n`);
      jobNo += 1;
      const job = {
        id: `job-${jobNo}`,
        thread: `walk-thread-${jobNo}`,
        cwd: spec.target,
        worktreePath: spec.target,
        status: "running",
        startedAt: iso(state.clock),
      };
      state.started.push({ pipeline: pipelineId, stage: stageId, visit: Number(visit), job, spec });
      state.board.push(job);
      return job;
    },
    now: () => state.clock,
  });
  assistant.settings.spawn = "auto";
  t.after(() => {
    clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    rmSync(dir, { recursive: true, force: true });
  });
  const queueFile = assistant.queuePathOf(assistant.assistantRecord("assistant-1"));
  const rowOf = (id) => readQueueFile(queueFile).tasks.find((x) => x.id === id) || null;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // One tick of the panel's clock: the sweep, then the starts it asked for are performed.
  const sweep = async () => {
    state.clock += 1000;
    assistant.sweepQueues();
    await tick();
    await tick();
  };
  // The worker finishes between two ticks.
  const finish = () => {
    const job = state.board.filter((j) => j.status === "running").at(-1);
    if (job) job.status = "done";
    return job || null;
  };
  const put = (id, pipeline, stage) => assistant.queueMutate("assistant-1", "pipeline", { id, pipeline, stage });
  const start = (title) => {
    const added = assistant.queueMutate("assistant-1", "add", { title, project: "agent-worktree-gui" }).task;
    return added.id;
  };
  return { assistant, state, dir, bundleFile, rowOf, sweep, finish, put, start };
}

// Walk until the row parks, finishes, or the budget runs out. `until` is checked after every tick.
async function walk(h, id, { until = () => false, budget = 40 } = {}) {
  for (let i = 0; i < budget; i += 1) {
    h.finish();
    await h.sweep();
    if (until(h.rowOf(id))) break;
  }
  return h.rowOf(id);
}

test("ping-pong walks three loop rounds through the sweep with no hand-start, and stops on its cap", async (t) => {
  const h = harness(t, { pipelines: ["ping-pong"] });
  const id = h.start("draft and critique the piece");
  assert.equal(h.put(id, "ping-pong", "draft").ok, true);

  const row = await walk(h, id, { until: (r) => r.state === "parked" || r.state === "done" });

  // Every stage boundary was crossed by the panel: one cut, then one start per visit, in the document's order.
  assert.equal(h.state.cuts.length, 1, "the one tree the row works in was cut once");
  assert.deepEqual(
    h.state.started.map((s) => s.stage),
    ["draft", "critique", "draft", "critique", "draft", "critique", "draft", "critique"],
    "the loop went back and forth with nobody starting a stage by hand",
  );
  assert.equal(row.state, "parked", "a capped loop stops for a decision; it does not run for ever");
  assert.equal(row.pipelineRun.stage, "critique", "the row stops where its last stage settled");
  assert.deepEqual(row.pipelineRun.visits, { draft: 4, critique: 4 }, "three loop rounds, each entering both stages");
  assert.equal(row.pipelineRun.crossings["H-02"], 3, "the cap is three crossings of the back edge");
  assert.equal(row.pipelineRun.waitingFor.kind, "cap");
  assert.equal(row.pipelineRun.waitingFor.edge, "H-02");
  assert.equal(row.pipelineRun.waitingFor.limit, 3);
  assert.match(row.reason, /at its cap of 3 rounds/);
  assert.equal(h.state.started.length, 8, "no stage was started twice, and none was skipped");
  assert.deepEqual(
    h.state.started.map((s) => s.visit),
    [1, 1, 2, 2, 3, 3, 4, 4],
    "each visit is its own stage run, numbered on the record",
  );
  const ids = row.pipelineRun.stageRuns.map((r) => r.id);
  assert.deepEqual(ids, ["ping-pong/draft#1", "ping-pong/critique#1", "ping-pong/draft#2", "ping-pong/critique#2", "ping-pong/draft#3", "ping-pong/critique#3", "ping-pong/draft#4", "ping-pong/critique#4"]);
  assert.ok(row.pipelineRun.stageRuns.every((r) => r.status === "done"), "every run in the ledger settled done");
});

test("a row left queued over a settled stage advances on the next sweep instead of running that stage again", async (t) => {
  const h = harness(t, { pipelines: ["probe-fix"] });
  const id = h.start("probe then fix");
  assert.equal(h.put(id, "probe-fix", "probe").ok, true);

  await h.sweep(); // the cut
  await h.sweep(); // probe#1 starts
  assert.equal(h.state.started.length, 1);
  const probeJob = h.finish();

  // The panel restarts between the settle and the pass that reads it. What is left on disk is the queue file: a row
  // that reads `queued` standing over a stage run whose status is `done` and whose decision was never written. This
  // is written through the queue's own writer, in the queue's own shape, exactly as a page that was killed mid-pass
  // leaves it.
  const file = h.assistant.queuePathOf(h.assistant.assistantRecord("assistant-1"));
  const onDisk = readQueueFile(file);
  const tasks = onDisk.tasks.map((row) =>
    row.id !== id
      ? row
      : {
          ...row,
          state: "queued",
          thread: probeJob.thread,
          hold: null,
          reason: "requeued after the restart",
          pipelineRun: {
            ...row.pipelineRun,
            stageRuns: [
              {
                id: "probe-fix/probe#1",
                stage: "probe",
                visit: 1,
                at: row.pipelineRun.enteredAt,
                thread: probeJob.thread,
                job: probeJob.id,
                status: "done",
                decision: null,
              },
            ],
          },
        },
  );
  writeQueueFile(file, tasks, onDisk.nextId);

  const startsBefore = h.state.started.length;
  await h.sweep();

  const row = h.rowOf(id);
  assert.equal(row.pipelineRun.stage, "fix", "the settle was read from the ledger, and the row moved to fix");
  assert.equal(row.state, "running", "the move asked for fix, and its start linked the row");
  assert.equal(h.state.started.length, startsBefore + 1, "exactly one start was asked for");
  assert.equal(h.state.started.at(-1).stage, "fix", "fix was started; probe was not run a second time");
  assert.equal(h.state.started.filter((s) => s.stage === "probe").length, 1, "probe ran once, and is not re-run");
  assert.equal(row.pipelineRun.visits.probe, 1, "reading the settle is not a second visit");
  assert.equal(row.pipelineRun.crossings["H-01"], 1);
  const probeRun = row.pipelineRun.stageRuns.find((r) => r.stage === "probe");
  assert.equal(probeRun.status, "done");
  assert.equal(probeRun.decision.trigger, "stage-settled", "the order was read: the entry now carries its decision");
});

test("probe-fix walks probe → fix once each, and the last stage settles the row on its own verdict", async (t) => {
  const h = harness(t, { pipelines: ["probe-fix"] });
  const id = h.start("probe then fix");
  assert.equal(h.put(id, "probe-fix", "probe").ok, true);
  // No landing row is planted: the seed's fix stage writes a patch, not a PR, and the defect was that such a row
  // waited for a MERGED that could never arrive.

  const row = await walk(h, id, { until: (r) => r.state === "done" });
  assert.deepEqual(h.state.started.map((s) => s.stage), ["probe", "fix"]);
  assert.equal(row.state, "done", "the pipeline is over and nothing is left to land");
  assert.equal(row.pipelineRun.stage, "fix", "the record still names the stage that finished it");
  assert.deepEqual(row.pipelineRun.visits, { probe: 1, fix: 1 });
  assert.match(row.reason, /pipeline probe-fix is over at fix/, "the row says why it is finished");
  assert.match(row.reason, /not a PR to land/);
  assert.doesNotMatch(row.reason, /PR reads/, "no landing was read, and none was invented");
});

test("author-review-revise crosses a sequence, a gate-routed loop and a finish, with no hand-start", async (t) => {
  const h = harness(t, { pipelines: ["author-review-revise"] });
  const id = h.start("write, review, revise");
  assert.equal(h.put(id, "author-review-revise", "author").ok, true);
  h.state.rows.push({ path: h.state.tree, verdict: "MERGED" });

  // Author writes; the review stage settles onto gate G1, which declares a decision record: the driver parks there
  // and the RECORD is what moves the row (design §6.1). Nothing in this test presses start.
  await h.sweep(); // cut
  await h.sweep(); // author#1
  assert.equal(h.state.started.map((s) => s.stage).join(","), "author");
  h.finish();
  await h.sweep(); // author settles → review#1 starts
  assert.equal(h.rowOf(id).pipelineRun.stage, "review");
  h.finish();
  await h.sweep(); // review#1 settles → the gate has no record yet → park
  let row = h.rowOf(id);
  assert.equal(row.state, "parked", "a gate that declares a decision is a barrier");
  assert.equal(row.pipelineRun.waitingFor.kind, "gate");

  // The reviewer REJECTS: the record routes H-02 back to the author.
  const verdict = path.join(h.state.tree, "ledger/author-review/verdict.json");
  mkdirSync(path.dirname(verdict), { recursive: true });
  writeFileSync(verdict, JSON.stringify({ outcome: "reject" }));
  await h.sweep(); // the record crosses the gate: author#2 starts
  row = h.rowOf(id);
  assert.equal(row.pipelineRun.stage, "author", "the verdict routed the row back to the author");
  assert.deepEqual(row.pipelineRun.visits, { author: 2, review: 1 }, "the back edge is a new visit of the author");
  assert.equal(row.pipelineRun.crossings["H-02"], 1);
  assert.equal(h.state.started.at(-1).stage, "author");

  h.finish();
  await h.sweep(); // author#2 settles → review#2
  assert.equal(h.rowOf(id).pipelineRun.stage, "review");
  h.finish();
  await h.sweep(); // review#2 settles → the record is still "reject" → loops again
  assert.equal(h.rowOf(id).pipelineRun.stage, "author");
  h.finish();
  await h.sweep(); // author#3 settles → review#3
  assert.equal(h.rowOf(id).pipelineRun.stage, "review");
  h.finish();
  // The reviewer ACCEPTS: the record routes H-03 on to the reviser.
  writeFileSync(verdict, JSON.stringify({ outcome: "accept" }));
  await h.sweep();
  row = h.rowOf(id);
  assert.equal(row.pipelineRun.stage, "revise", "the accepted edge goes on to the reviser");
  assert.equal(h.state.started.at(-1).stage, "revise");

  const done = await walk(h, id, { until: (r) => r.state === "done" });
  assert.equal(done.state, "done", "the last stage's settle finishes the row");
  assert.deepEqual(
    h.state.started.map((s) => s.stage),
    ["author", "review", "author", "review", "author", "review", "revise"],
    "each stage was started by the sweep that settled the one before it",
  );
  assert.equal(done.pipelineRun.crossings["H-02"], 2, "two rejects, inside the cap of two");
});
