// Driving a task THROUGH its pipeline — lib/task-pipeline-drive.js.
//
// The record (lib/task-pipeline.js) says where a row is; the assignment (lib/task-pipeline-assign.js) says how it got
// there. This file pins the third thing: what happens NEXT, and only for a row that is actually on a pipeline.
//
// What it drives, and why each one is a rule rather than a detail:
//
//   1. a two-stage pipeline advances on settle — the row is written forward to the next stage in ONE pass, stamped
//      with that pass's clock, and the stage's worker is asked for in the SAME tree;
//   2. the same pass does not ask twice: the request is written on the row (`startingAt`) and a stage run entry is
//      created beside it, so a sweep that runs again before the spawner has linked a thread cannot start the same
//      stage a second time — and a retry reuses the entry rather than minting a second visit;
//   3. a capped loop stops at its cap, counts crossings ON THE RECORD, and records the edge on the park so the
//      reader's release can reset it (a requeue alone cannot: `used + 1 > limit` never moves);
//   4. a loop that names no readable cap is not crossed at all — fail-closed, never "unlimited";
//   5. a gate that declares a decision record is a barrier: the code parks the row and never decides it, and the
//      record's arrival is the only thing that moves the row;
//   6. a failed run parks the row instead of re-running the stage;
//   7. a task with NO pipeline comes back untouched, and the settle that finishes it is exactly the one it had before
//      this module existed — no stage is invented for a row that never named one;
//   8. the row at the FRONT of the queue is the one started: a pipeline row behind a running row waits its turn.
//
// The design (docs/design/pipeline-stage-execution.md) adds four facts this file also pins: a stage run is an entry
// with an id (`<pipeline>/<stage>#<visit>`), the row's tree is cut once and every stage reuses it, a decision is a
// structured fact rendered once, and `unresolved` PARKS rather than sitting still.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { setTaskState, settleTasks } from "../lib/assistant/queue.js";
import { HOLD_OWNER_MS } from "../lib/pipelines.js";
import { parseBundle } from "../lib/pipeline-bundle.js";
import {
  DRIVE_FAULTS,
  STARTING_AT,
  WAITING_FOR,
  capWakeLine,
  START_GRACE_MS,
  artifactOf,
  driveTaskPipelines,
  nextStageOf,
  releaseCapPark,
  renderDecision,
  routingFingerprint,
  stagePrompt,
  treeLookup,
} from "../lib/task-pipeline-drive.js";

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

// A tree with the artifacts a stage declares. The design's one new hard gate is that a settled stage's artifact is
// in the tree; every test that advances a stage therefore has to have produced one, exactly as a real stage would.
function tree(t, { artifacts = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-drive-"));
  if (artifacts.length) mkdirSync(path.join(dir, "out"), { recursive: true });
  for (const n of artifacts) writeFileSync(path.join(dir, "out", `${n}.json`), JSON.stringify({ stage: n }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A tree holding one ROUND's artifact per entry — `out/run-1/r1/round-brief.json`, r2, r3 — each COMMITTED, because
// the pin this file tests is a blob at a commit, not a hash of the checkout. It is the shape the 24-stage document
// declares: the path carries `{{run_id}}` and `{{round}}`, and the stage writes a different file every round.
function roundTree(t, rounds) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-rounds-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", ["round", "example.invalid"].join(String.fromCharCode(64)));
  git("config", "user.name", "Round");
  for (const n of rounds) {
    const rel = `out/run-1/r${n}/round-brief.json`;
    mkdirSync(path.dirname(path.join(dir, ...rel.split("/"))), { recursive: true });
    writeFileSync(path.join(dir, ...rel.split("/")), `${JSON.stringify({ stage: "S1", round: n, visit: n }, null, 2)}\n`);
    git("add", "--", rel);
    git("commit", "-q", "-m", `S1 visit ${n} (round ${n}): ${rel}`);
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a two-stage pipeline advances the row on settle, and asks for the next stage in the same tree", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const out = drive([row({ worktree: dir })]);

  assert.equal(out.changed.length, 1);
  assert.equal(out.changed[0].from, "running");
  assert.equal(out.changed[0].to, "queued");
  assert.equal(out.changed[0].stage, "S2");

  const task = out.tasks[0];
  assert.equal(task.state, "queued", "the row stays open: the pipeline is not finished, only this stage is");
  assert.equal(task.pipelineRun.stage, "S2");
  assert.equal(task.pipelineRun.enteredAt, CLOCK, "the entry is stamped from THIS pass's clock, not the previous stage's");
  assert.equal(task.pipelineRun.crossings.h1, 1, "the edge the row took is counted on the record");
  assert.deepEqual(task.pipelineRun.visits, { S1: 1, S2: 1 }, "entering a stage increments its visit");

  assert.equal(out.starts.length, 1);
  const start = out.starts[0];
  assert.equal(start.taskId, 1);
  assert.equal(start.stage, "S2");
  assert.equal(start.position, 2);
  assert.equal(start.count, 2);
  assert.equal(start.visit, 1);
  assert.equal(start.target, dir, "a stage after the first runs in the tree the pipeline already has");
  assert.equal(start.existing, true, "every stage start is the existing-tree path");
  assert.equal(out.ensureTree.length, 0, "a row that has a tree is not cut a second one");
  assert.match(start.prompt, /Work stage 2\./);
  assert.match(start.prompt, /Queue task #1: carry the contract/);
  assert.match(start.prompt, /visit 1/);
  assert.equal(task.pipelineRun[STARTING_AT], CLOCK, "the start request is written on the row in the same pass");

  // The ledger: the stage that settled names its run, its artifact and the decision; the stage being entered has an
  // entry created by the start request, with no thread yet.
  const runs = task.pipelineRun.stageRuns;
  assert.equal(runs.length, 2);
  const first = runs.find((r) => r.stage === "S1");
  assert.equal(first.id, "two/S1#1");
  assert.equal(first.thread, "T1");
  assert.equal(first.status, "done");
  assert.equal(first.artifact.present, true);
  assert.match(first.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.decision.by, "panel");
  assert.equal(first.decision.trigger, "stage-settled");
  assert.equal(first.decision.code, null);
  const nextEntry = runs.find((r) => r.stage === "S2");
  assert.equal(nextEntry.id, "two/S2#1");
  assert.equal(nextEntry.thread, null, "the thread is filled at the link, which has not happened yet");
});

test("a stage that was just asked for is not asked for again until its run links", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const first = drive([row({ worktree: dir })]);
  const second = drive(first.tasks, { jobs: [] });

  assert.equal(second.starts.length, 0, "the request is on the row, so the next pass can see it");
  assert.ok(second.notes.some((note) => note.code === "pipeline-starting"));

  // Past the grace the request is taken as lost and the stage is asked for again — a start that never linked is not
  // a reason to leave the row waiting for ever. The retry is the SAME visit, so the ledger does not grow a second entry.
  const late = new Date(Date.parse(CLOCK) + START_GRACE_MS + 1000).toISOString();
  const retried = drive(second.tasks, { jobs: [], at: late });
  assert.equal(retried.starts.length, 1);
  assert.equal(retried.starts[0].stage, "S2");
  assert.equal(retried.starts[0].visit, 1, "a retry is an attempt, not a new visit");
  assert.equal(retried.tasks[0].pipelineRun[STARTING_AT], late, "the retry restamps the request");
  assert.equal(retried.tasks[0].pipelineRun.stageRuns.filter((r) => r.stage === "S2").length, 1, "one entry per visit");
});

// A row can stand in `queued` OVER a stage whose run has already settled: the reader requeued it, a restart lost the
// link, or a settle was written on a pass that could not move the row. The settle is a fact on the row's own ledger,
// and re-running the stage is the one move that never advances the graph — so the driver reads it exactly as it reads
// a `running` row whose run has just ended.
test("a row left queued over a settled stage advances on the next pass instead of running that stage again", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const settled = row({
    worktree: dir,
    state: "queued",
    reason: "back in the queue",
    pipelineRun: {
      pipeline: "two",
      stage: "S1",
      enteredAt: "2026-11-03T15:00:00.000Z",
      visits: { S1: 1 },
      stageRuns: [
        { id: "two/S1#1", stage: "S1", visit: 1, at: "2026-11-03T15:00:00.000Z", thread: "T1", job: "j1", status: "done", decision: null },
      ],
    },
  });

  const out = drive([settled]);
  assert.equal(out.changed.length, 1);
  assert.equal(out.changed[0].from, "queued", "the row was already in the queue; the move is forward, not out of it");
  assert.equal(out.changed[0].to, "queued");
  assert.equal(out.changed[0].stage, "S2");

  const task = out.tasks[0];
  assert.equal(task.pipelineRun.stage, "S2", "the graph's next stage, not the one that already ran");
  assert.equal(task.pipelineRun.crossings.h1, 1);
  assert.deepEqual(task.pipelineRun.visits, { S1: 1, S2: 1 }, "no second visit to the stage that settled");
  assert.equal(out.starts.length, 1);
  assert.equal(out.starts[0].stage, "S2", "the next stage is started, and the settled one is not asked for again");
  const firstRun = task.pipelineRun.stageRuns.find((r) => r.stage === "S1");
  assert.equal(firstRun.decision.trigger, "stage-settled", "the settle was READ: the entry now carries its decision");
  assert.equal(firstRun.status, "done");
});

test("a queued row whose current stage never started is not advanced: it is started in place", (t) => {
  const dir = tree(t, { artifacts: [] });
  const fresh = row({
    worktree: dir,
    state: "queued",
    pipelineRun: {
      pipeline: "two",
      stage: "S2",
      enteredAt: "2026-11-03T15:00:00.000Z",
      visits: { S1: 1, S2: 1 },
      stageRuns: [
        { id: "two/S1#1", stage: "S1", visit: 1, at: "2026-11-03T15:00:00.000Z", thread: "T1", job: "j1", status: "done", decision: { by: "panel", trigger: "stage-settled", code: null, at: CLOCK, fact: {}, reason: "already read" } },
      ],
    },
  });

  const out = drive([fresh]);
  assert.equal(out.tasks[0].pipelineRun.stage, "S2", "there is no settle at S2 to read, so the row does not move");
  assert.equal(out.starts.length, 1);
  assert.equal(out.starts[0].stage, "S2");
});

test("the wait book owns the advance while it holds the row, and the driver is the fallback", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const at = (ms) => new Date(Date.parse(CLOCK) + ms);
  const hold = (over = {}) => ({ kind: "run", stage: "S1", visit: 1, pipeline: "two", thread: "T1", job: "j1", at: CLOCK, settledAt: CLOCK, ...over });

  // Held, inside the first-refusal window: the timer's to move, so this pass does nothing at all.
  const held = drive([row({ worktree: dir })], { waitFor: () => hold(), at: at(60_000) });
  assert.equal(held.changed.length, 0, "a held row is not this pass's to advance");
  assert.equal(held.tasks[0].pipelineRun.stage, "S1", "and it is not moved either");
  assert.equal(held.starts.length, 0);

  // The SAME hold past the window — a panel whose ticker died — and the driver takes the row back: a hold is a clock,
  // not a lock.
  const late = drive([row({ worktree: dir })], { waitFor: () => hold(), at: at(HOLD_OWNER_MS + 60_000) });
  assert.equal(late.changed.length, 1, "past the window the fallback advances the row");
  assert.equal(late.tasks[0].pipelineRun.stage, "S2");
  assert.equal(late.starts.length, 1);

  // A hold for another stage or another visit is the next stage's cut, not this row's: it does not hold this settle.
  const otherStage = drive([row({ worktree: dir })], { waitFor: () => hold({ stage: "S2" }), at: at(60_000) });
  assert.equal(otherStage.tasks[0].pipelineRun.stage, "S2", "a hold naming S2 does not hold the settle of S1");
  const otherVisit = drive([row({ worktree: dir })], { waitFor: () => hold({ visit: 2 }), at: at(60_000) });
  assert.equal(otherVisit.tasks[0].pipelineRun.stage, "S2", "and neither does one naming a later visit of the same stage");
});

test("a review wait holds the row with no window, and a DECLINED read ends the walk on it", (t) => {
  // The shipped review loop, driven at its `wait` stage - the stage whose exit is the reviewer's answer. Row 67 walked
  // from here to approve and then merge on a pull request that read DECLINED, because nothing told the driver the read
  // had happened at all. These are the two facts that stop it: a review wait is the book's for as long as it exists,
  // and a read that ENDED the pull request is the end of the walk.
  const doc = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));
  const parsed = parseBundle(doc, { file: "pipeline-bundle.seed.json" });
  assert.equal(parsed.ok, true, parsed.reason || "the shipped seed must parse");
  const loop = parsed.bundle.pipelines.find((p) => p.id === "sefl-review-loop");
  assert.ok(loop, "the review loop ships in the PDL bundle");

  const dir = mkdtempSync(path.join(tmpdir(), "wag-declined-"));
  mkdirSync(path.join(dir, "ledger", "sefl-review-loop"), { recursive: true });
  writeFileSync(path.join(dir, "ledger", "sefl-review-loop", "wait.md"), "wait\n");
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const waiting = (over = {}) =>
    row({
      worktree: dir,
      pipelineRun: {
        pipeline: "sefl-review-loop",
        stage: "wait",
        enteredAt: "2026-11-03T15:00:00.000Z",
        visits: { branch: 1, push: 1, pr: 1, wait: 1 },
        stageRuns: [{ id: "sefl-review-loop/wait#1", stage: "wait", visit: 1, at: "2026-11-03T15:00:00.000Z", thread: "T1", job: "j1", status: null, decision: null }],
      },
      ...over,
    });
  const drive = (over = {}) =>
    driveTaskPipelines([waiting()], { bundle: parsed.bundle, jobs: done, isLive: () => false, at: CLOCK, unattended: true, ...over });
  const live = { kind: "review", stage: "wait", check: "pr-comments", pipeline: "sefl-review-loop", thread: "T1", at: CLOCK, every: 3_600_000 };
  const declined = { stage: "wait", check: "pr-comments", pipeline: "sefl-review-loop", state: "DECLINED", closed: "declined", advanced: false, cannotTell: false, why: "the pull request is DECLINED", at: CLOCK };

  // 1. The wait is live and no read exists yet: the timer owns the stage, so nothing moves and nothing is dispatched.
  //    Without this the driver advances on the run's `done` seconds after the stage ends, long before the first read.
  const held = drive({ waitFor: () => live });
  assert.equal(held.changed.length, 0, "a review wait is the book's to read, not this pass's to settle");
  assert.equal(held.tasks[0].state, "running");
  assert.equal(held.tasks[0].pipelineRun.stage, "wait");
  assert.equal(held.tasks[0].pipelineRun.stageRuns.length, 1, "no later stageRun is created under a live wait");
  assert.equal(held.starts.length, 0, "and nothing is dispatched");

  // ...and there is no first-refusal window to outlast: the wait is not a clock, it is the only reader of the exit.
  const late = drive({ waitFor: () => live, at: new Date(Date.parse(CLOCK) + HOLD_OWNER_MS + 60_000) });
  assert.equal(late.changed.length, 0, "a review wait holds past the hold owner's window");
  assert.equal(late.starts.length, 0);

  // 2. The timer has read the pull request and stamped DECLINED. The wait is gone, the read is not: the walk ends on
  //    this stage, with the host's word in the reason and no stage after it.
  const ended = drive({ waitFor: () => null, reviewOf: () => declined });
  const task = ended.tasks[0];
  assert.equal(task.state, "parked");
  assert.equal(task.pipelineRun.stage, "wait", "the row stays on the stage that read the decline");
  assert.deepEqual(task.pipelineRun.stageRuns.map((r) => `${r.stage}#${r.visit}`), ["wait#1"], "no later stageRun is created");
  assert.equal(ended.starts.length, 0, "and no stage is dispatched");
  assert.equal(ended.changed.length, 1);
  assert.equal(ended.changed[0].to, "parked");
  assert.equal(ended.changed[0].code, DRIVE_FAULTS.DECLINED);
  assert.match(task.reason, /DECLINED/, "the row's reason names the declined read");
  assert.match(task.reason, /pr-comments/, "and the check the stage was waiting on");
  assert.match(task.reason, /no later stage is entered and nothing is dispatched/);
  assert.equal(task[WAITING_FOR], undefined, "nothing the panel can watch releases a declined pull request");
  const entry = task.pipelineRun.stageRuns.find((r) => r.stage === "wait");
  assert.equal(entry.status, "done", "the run that settled is still recorded as the one that ended the walk");
  assert.equal(entry.decision.code, DRIVE_FAULTS.DECLINED);
  assert.equal(entry.decision.trigger, "declined");
  assert.equal(entry.decision.fact.kind, "review");
  assert.equal(entry.decision.fact.state, "DECLINED");
  assert.equal(entry.decision.fact.closed, "declined");
});

test("a read that could not be made, or a merged pull request, is not a declined one", (t) => {
  // The refusal is the ENDED pull request and nothing else. A host that could not answer must not end a walk (that is
  // the fail-closed rule the stage exists for), and a MERGED PR is the landing rule's business, not this one's.
  const doc = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));
  const parsed = parseBundle(doc, { file: "pipeline-bundle.seed.json" });
  const loop = parsed.bundle.pipelines.find((p) => p.id === "sefl-review-loop");
  const waitStage = loop.stages.find((s) => s.id === "wait");

  const refused = nextStageOf(loop, { stage: "wait" }, { review: { stamped: { stage: "wait", check: "pr-comments", state: null, closed: null, advanced: false, cannotTell: true, why: "HTTP 503" } } });
  assert.equal(refused.ok, true, "a read that cannot tell leaves the rail alone");
  assert.equal(refused.stage.id, "approve", "the edge it always took");

  const merged = nextStageOf(loop, { stage: "wait" }, { review: { stamped: { stage: "wait", check: "pr-comments", state: "MERGED", closed: "merged", advanced: false } } });
  assert.equal(merged.ok, true, "a MERGED pull request is the landing rule's, not a declined walk's");
  assert.equal(merged.stage.id, "approve");

  const declined = nextStageOf(loop, { stage: "wait" }, { review: { stamped: { stage: "wait", check: "pr-comments", state: "CLOSED", closed: "declined", advanced: false } } });
  assert.equal(declined.ok, false);
  assert.equal(declined.code, DRIVE_FAULTS.DECLINED);
  assert.equal(declined.read.state, "CLOSED", "a PR closed without a merge is the same end: no answer can arrive");
  assert.equal(waitStage.exit, undefined, "the check comes from the gate after the stage");
  assert.match(declined.reason, /pr-comments/);
});

test("a queued row over a settled stage still parks on the cap it has reached", (t) => {
  const looped = bundleOf(
    pipeline({
      stages: [stage(1), stage(2)],
      handoffs: [{ id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "1 round" }],
    }),
  );
  const dir = tree(t, { artifacts: [2] });
  const leftover = row({
    worktree: dir,
    state: "queued",
    pipelineRun: {
      pipeline: "two",
      stage: "S2",
      enteredAt: "2026-11-03T15:00:00.000Z",
      visits: { S1: 1, S2: 1 },
      crossings: { "h-back": 1 },
      stageRuns: [
        { id: "two/S2#1", stage: "S2", visit: 1, at: "2026-11-03T15:00:00.000Z", thread: "T1", job: "j1", status: "done", decision: null },
      ],
    },
  });

  const out = drive([leftover], { bundle: looped });
  assert.equal(out.tasks[0].state, "parked", "the settle is read, and what it reads is a cap");
  assert.equal(out.changed[0].to, "parked");
  assert.equal(out.tasks[0].pipelineRun.waitingFor.kind, "cap");
  assert.equal(out.tasks[0].pipelineRun.waitingFor.edge, "h-back");
  assert.equal(out.starts.length, 0, "a capped loop is not started: the park is the answer");
});

test("a capped loop advances below its cap and stops AT it, recording the edge the release needs", (t) => {
  const looped = bundleOf(
    pipeline({
      stages: [stage(1), stage(2)],
      handoffs: [{ id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "2 rounds" }],
    }),
  );
  const dir = tree(t, { artifacts: [2] });
  const at = (crossings) =>
    drive([row({ worktree: dir, pipelineRun: { pipeline: "two", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z", crossings } })], {
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
  // The park names the edge, which is what the reader's release resets (§6.4). Without it the release has nothing to
  // aim at, and a requeue re-parks on the next tick because `used + 1 > limit` is still true.
  assert.equal(third.tasks[0].pipelineRun.waitingFor.kind, "cap");
  assert.equal(third.tasks[0].pipelineRun.waitingFor.edge, "h-back");
  assert.equal(third.tasks[0].pipelineRun.waitingFor.used, 2);
  assert.equal(third.tasks[0].pipelineRun.stageRuns.at(-1).decision.code, DRIVE_FAULTS.CAP);
});

test("a cap park is unreleasable by requeue alone, and the release resets the count", (t) => {
  const looped = bundleOf(
    pipeline({
      stages: [stage(1), stage(2)],
      handoffs: [{ id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "2 rounds" }],
    }),
  );
  const dir = tree(t, { artifacts: [2] });
  const base = row({
    state: "running",
    thread: "T1",
    threads: ["T1"],
    worktree: dir,
    pipelineRun: { pipeline: "two", stage: "S2", enteredAt: CLOCK, crossings: { "h-back": 2 } },
  });
  const parked = driveTaskPipelines([base], { bundle: looped, jobs: done, at: CLOCK, unattended: false });
  assert.equal(parked.tasks[0].state, "parked");

  // The requeue the panel has always offered: the count survives, so the re-run's settle re-parks on the same edge
  // instead of crossing it. A requeue is not a release — it spends a whole agent run to learn the same thing.
  const requeued = setTaskState(parked.tasks, 1, "queued", { by: "reader", at: CLOCK });
  const rerun = { ...requeued.tasks[0], state: "running", thread: "T1", threads: ["T1", "T2"] };
  const again = driveTaskPipelines([rerun], { bundle: looped, jobs: [{ thread: "T2", status: "done", startedAt: LATER }], at: LATER, unattended: false });
  assert.equal(again.tasks[0].state, "parked", "a requeue alone is a one-tick park loop — the count never moved");

  // The release the design adds: the edge's crossings go to zero and the row carries a reader decision.
  const released = releaseCapPark(again.tasks[0], { at: LATER });
  assert.ok(released);
  assert.equal(released.task.pipelineRun.crossings["h-back"], 0);
  assert.equal(released.task.pipelineRun.waitingFor, undefined);
  const decision = released.task.pipelineRun.stageRuns.at(-1).decision;
  assert.equal(decision.by, "reader");
  assert.equal(decision.trigger, "cap");
  assert.equal(decision.fact.kind, "cap-release");
  assert.equal(decision.fact.was, 2);
  const unqueued = setTaskState([released.task], 1, "queued", { by: "reader", at: LATER });
  const rerun2 = { ...unqueued.tasks[0], state: "running", thread: "T1", threads: ["T1", "T2", "T3"] };
  const moved = driveTaskPipelines([rerun2], { bundle: looped, jobs: [{ thread: "T3", status: "done", startedAt: LATER }], at: LATER, unattended: false });
  assert.equal(moved.tasks[0].state, "queued");
  assert.equal(moved.tasks[0].pipelineRun.stage, "S1", "the released row crosses the loop on the next pass");
});

test("a loop with no readable cap is not crossed at all", (t) => {
  const looped = bundleOf(
    pipeline({
      handoffs: [{ id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop" }],
    }),
  );
  const dir = tree(t, { artifacts: [2] });
  const out = drive([row({ worktree: dir, pipelineRun: { pipeline: "two", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z" } })], {
    bundle: looped,
    unattended: false,
  });

  assert.equal(out.tasks[0].state, "parked");
  assert.equal(out.tasks[0].pipelineRun.stage, "S2");
  assert.match(out.changed[0].why, /does not guess a limit/);
});

test("a gate that declares a decision record is crossed only by that record", (t) => {
  const dir = tree(t, { artifacts: [1] });
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
  const stopped = drive([row({ worktree: dir })], { bundle: gated, unattended: false });
  assert.equal(stopped.tasks[0].state, "parked");
  assert.equal(stopped.tasks[0].pipelineRun.stage, "S1", "the gate is not decided by the code");
  assert.equal(stopped.tasks[0].pipelineRun.waitingFor.gate, "G1");
  assert.match(stopped.changed[0].why, /does not decide it/);
  const held = stopped.tasks[0].pipelineRun.stageRuns.at(-1).decision;
  assert.equal(held.code, DRIVE_FAULTS.GATE);
  assert.equal(held.fact.kind, "gate");

  // The record arrives. The panel reads its PRESENCE, not its value, and the row crosses.
  mkdirSync(path.join(dir, "gates"), { recursive: true });
  writeFileSync(path.join(dir, "gates", "G1-F-77.json"), JSON.stringify({ decision: "GO" }));

  const crossed = drive(stopped.tasks, { bundle: gated, jobs: [], at: LATER, unattended: false });
  assert.equal(crossed.changed.length, 1);
  assert.equal(crossed.changed[0].from, "parked");
  assert.equal(crossed.changed[0].to, "queued");
  assert.equal(crossed.tasks[0].state, "queued");
  assert.equal(crossed.tasks[0].pipelineRun.stage, "S2");
  assert.equal(crossed.tasks[0].pipelineRun.waitingFor, undefined, "the wait belongs to the edge, and the edge is behind it");
  assert.equal(crossed.tasks[0].pipelineRun.stageRuns.at(-1).decision.trigger, "gate-record");
});

// The 24-stage run's THIRD defect, in one test. A row that has started more than twenty workers keeps the newest
// twenty threads, and the stage's own ledger entry names the worker it was cut with. The settle must read THAT
// thread: on the old shape `currentThread` had frozen on the twentieth, so a stage whose own worker was still
// running settled against `loop-20`'s finished job and the row advanced under a live agent.
test("a stage run settles on its own thread, never on the twentieth the list kept", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const many = Array.from({ length: 24 }, (_, i) => `loop-${i + 1}`);
  const run = {
    pipeline: "two",
    stage: "S1",
    enteredAt: CLOCK,
    // the entry the LINK writes: the worker this stage was cut with, and no status yet
    stageRuns: [{ id: "two/S1#1", stage: "S1", visit: 1, at: CLOCK, thread: "loop-24", job: "j24", status: null, decision: null }],
  };
  const jobs = [
    { id: "j20", thread: "loop-20", status: "done", startedAt: "2026-11-03T15:00:00.000Z", endedAt: "2026-11-03T15:20:00.000Z" },
    { id: "j24", thread: "loop-24", status: "running", startedAt: "2026-11-03T15:40:00.000Z" },
  ];
  const out = drive([row({ worktree: dir, thread: many[0], threads: many, pipelineRun: run })], {
    jobs,
    isLive: (thr) => thr === "loop-24",
  });

  assert.equal(out.tasks[0].state, "running", "the stage's own worker is live: nothing settles");
  assert.equal(out.tasks[0].pipelineRun.stage, "S1", "and the row does not advance under it");
  assert.equal(out.tasks[0].pipelineRun.stageRuns.at(-1).status, null, "no settle is written against loop-20's finished job");
  assert.equal(out.changed.length, 0);
});

// The 24-stage run's FOURTH defect, in one test. A gate that declares one record per round
// (`G-{{run_id}}-r{{round}}.json`) is a question asked AGAIN each round: the old matcher filled no round, took the
// first name that sorts, and read round 1's file in every later round — G51 was crossed 11 times on round 1's
// decision. Round 2 has no record yet, so the row parks on round 2's own path and round 1's verdict moves nothing.
test("a gate asks for its round's own record: round 1's file never answers round 2", (t) => {
  const dir = tree(t, { artifacts: [2] });
  mkdirSync(path.join(dir, "ledger", "gates"), { recursive: true });
  writeFileSync(path.join(dir, "ledger", "gates", "G-run-1-r1.json"), JSON.stringify({ outcome: "again" }));
  const looped = bundleOf(
    pipeline({
      gates: [
        {
          id: "G",
          name: "The call",
          after: "S2",
          artifact: "artifact-2",
          decider: "seat",
          decision: { id: "d", path: "ledger/gates/G-{{run_id}}-r{{round}}.json", schema: "decision/1", writer: "seat", outcomes: ["again", "done"] },
        },
      ],
      handoffs: [
        { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h2", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "3 rounds" },
      ],
    }),
  );
  const run = { pipeline: "two", stage: "S2", enteredAt: CLOCK, visits: { S1: 2, S2: 2 } };
  const jobs = [{ id: "j2", thread: "T2", status: "done", startedAt: "2026-11-03T15:50:00.000Z" }];

  const stopped = drive([row({ worktree: dir, thread: "T1", threads: ["T1", "T2"], pipelineRun: run })], { bundle: looped, jobs, unattended: false });
  assert.equal(stopped.tasks[0].state, "parked", "round 2's record is not on disk, so the gate is not crossed");
  assert.equal(stopped.tasks[0].pipelineRun.stage, "S2", "round 1's verdict does not move round 2");
  assert.equal(stopped.tasks[0].pipelineRun.waitingFor.gate, "G");
  assert.match(stopped.tasks[0].pipelineRun.waitingFor.path, /\{\{round\}\}/, "the park names the DECLARATION, so every pass fills this round again");
  assert.match(stopped.tasks[0].reason, /G-\{\{run_id\}\}-r2\.json/, "the sentence names THIS round's path");

  // The round's own record arrives: the same gate, asked again, is answered for round 2.
  writeFileSync(path.join(dir, "ledger", "gates", "G-run-1-r2.json"), JSON.stringify({ outcome: "again" }));
  const crossed = drive(stopped.tasks, { bundle: looped, jobs: [], at: LATER, unattended: false });
  assert.equal(crossed.tasks[0].state, "queued");
  assert.equal(crossed.tasks[0].pipelineRun.stage, "S1", "round 2's own record releases it down the loop");
  assert.equal(crossed.tasks[0].pipelineRun.stageRuns.at(-1).decision.trigger, "gate-record");
});

// The round-7 dossier's fifth item, decided by the reader: a cap park still parks the row, but it must not be silent —
// the reader is woken with ONE line naming the cap, the visits and the last verdict, instead of waiting for a person to
// send `pipeline-release {release: "cap"}`. This pins the FACTS the line is built from: the park carries both, the row's
// sentence names both, and the line is one line.
test("a cap park carries the visits and the last verdict, and the reader's line names the cap, the visits and the verdict", (t) => {
  const dir = tree(t, { artifacts: [2] });
  mkdirSync(path.join(dir, "ledger", "gates"), { recursive: true });
  writeFileSync(path.join(dir, "ledger", "gates", "G-r2.json"), JSON.stringify({ outcome: "revise" }));
  const looped = bundleOf(
    pipeline({
      gates: [
        {
          id: "G",
          name: "The call",
          after: "S2",
          artifact: "artifact-2",
          decider: "seat",
          decision: { id: "d", path: "ledger/gates/G-r{{round}}.json", schema: "decision/1", writer: "seat", outcomes: ["revise", "accept"], routes: { revise: "h2", accept: null } },
        },
      ],
      handoffs: [
        { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h2", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "1 round" },
      ],
    }),
  );
  const run = { pipeline: "two", stage: "S2", enteredAt: CLOCK, visits: { S1: 2, S2: 2 }, crossings: { h2: 1 } };
  const jobs = [{ id: "j2", thread: "T2", status: "done", startedAt: "2026-11-03T15:50:00.000Z" }];
  const out = drive([row({ worktree: dir, thread: "T1", threads: ["T1", "T2"], pipelineRun: run })], { bundle: looped, jobs, unattended: false });

  const parked = out.tasks[0];
  assert.equal(parked.state, "parked", "the loop is not converged, so the row stops rather than being moved");
  const wait = parked.pipelineRun.waitingFor;
  assert.equal(wait.kind, "cap");
  assert.equal(wait.limit, 1);
  assert.equal(wait.used, 1);
  assert.deepEqual(wait.visits, { S1: 2, S2: 2 }, "the park carries what every stage's visit count was");
  assert.equal(wait.verdict.outcome, "revise", "and the verdict the gate read on the way in");
  assert.match(wait.verdict.path, /G-r2\.json$/, "the record the gate read travels with the park");
  assert.match(parked.reason, /\(visits S1 2, S2 2; the last verdict was revise at .*G-r2\.json\)/, "the row's sentence names both");

  // The line the reader's assistant is woken with: ONE line, and it names the cap, the visits and the verdict.
  const line = capWakeLine({
    id: parked.id,
    title: parked.title,
    pipeline: parked.pipelineRun.pipeline,
    stage: parked.pipelineRun.stage,
    edge: wait.edge,
    limit: wait.limit,
    used: wait.used,
    visits: wait.visits,
    verdict: wait.verdict,
  });
  assert.equal(/[\r\n]/.test(line), false, "one line, not a paragraph");
  assert.match(line, /#1 carry the contract — two · S2 stopped at loop h2/);
  assert.match(line, /a cap of 1 round, 1 crossing taken/);
  assert.match(line, /visits S1 2, S2 2/);
  assert.match(line, /the last verdict was revise at .*G-r2\.json/);
  assert.match(line, /pipeline-release \{release: "cap"\}/, "the line says what the reader's answer would be");
});

test("a failed run parks the row instead of re-running the stage", () => {
  const out = drive([row()], { jobs: [{ thread: "T1", status: "failed", finalMessage: "the build broke" }] });

  assert.equal(out.tasks[0].state, "parked");
  assert.equal(out.tasks[0].attempts, 0, "the driver does not spend an attempt by restarting the stage");
  assert.equal(out.tasks[0].pipelineRun.stage, "S1");
  assert.match(out.tasks[0].reason, /ended failed: the build broke/);
  assert.equal(out.starts.length, 0);
  assert.equal(out.tasks[0].pipelineRun.stageRuns.at(-1).decision.code, DRIVE_FAULTS.FAILED);
});

test("a failed run's park settles the run it parked on, in the same entry as the decision", () => {
  const job = { id: "j9", thread: "T1", status: "failed", startedAt: "2026-11-03T15:00:00.000Z", endedAt: "2026-11-03T15:30:00.000Z", finalMessage: "the build broke" };
  const out = drive([row()], { jobs: [job] });

  assert.equal(out.tasks[0].state, "parked", "the park itself is unchanged");
  const runs = out.tasks[0].pipelineRun.stageRuns;
  assert.equal(runs.length, 1, "one run, one entry: the settle does not mint a second attempt");
  const entry = runs[0];
  assert.equal(entry.stage, "S1");
  assert.equal(entry.status, "failed", "the entry says what the run ended as");
  assert.equal(entry.settledAt, CLOCK, "and when this pass read it, not the job's own stamp");
  assert.equal(entry.thread, "T1", "which thread ran it");
  assert.equal(entry.job, "j9", "and which job");
  assert.equal(entry.decision.code, DRIVE_FAULTS.FAILED, "the decision about the park rides the SAME entry");
  assert.match(entry.decision.reason, /ended failed: the build broke/);
});

// The three parks a DONE run can end in. Each is a terminal park of a run that finished, so each carries the same
// four facts as the failed park above: the status it ended as, when this pass read it, the thread and the job. On
// the base each of these left `status` null: the row named the run and could not say how it ended.
test("an unresolved park settles the finished run it parked on, in the same entry as the decision", () => {
  const job = { id: "j7", thread: "T1", status: "done", startedAt: "2026-11-03T15:00:00.000Z", endedAt: "2026-11-03T15:30:00.000Z" };
  const out = drive([row({ pipelineRun: { pipeline: "gone", stage: "S1", enteredAt: "2026-11-03T15:00:00.000Z" } })], { jobs: [job] });

  assert.equal(out.tasks[0].state, "parked", "the park itself is unchanged");
  const runs = out.tasks[0].pipelineRun.stageRuns;
  assert.equal(runs.length, 1, "one run, one entry: the settle does not mint a second attempt");
  const entry = runs[0];
  assert.equal(entry.stage, "S1");
  assert.equal(entry.status, "done", "the entry says what the run ended as");
  assert.equal(entry.settledAt, CLOCK, "and when this pass read it, not the job's own stamp");
  assert.equal(entry.thread, "T1", "which thread ran it");
  assert.equal(entry.job, "j7", "and which job");
  assert.equal(entry.decision.code, DRIVE_FAULTS.UNRESOLVED, "the decision about the park rides the SAME entry");
});

test("a tree-gone park settles the finished run it parked on, in the same entry as the decision", () => {
  const gone = path.join(tmpdir(), "wag-tree-that-is-not-there-7d21b4");
  const job = { id: "j8", thread: "T1", status: "done", startedAt: "2026-11-03T15:00:00.000Z", endedAt: "2026-11-03T15:30:00.000Z" };
  const out = drive([row({ pipelineRun: { pipeline: "two", stage: "S1", enteredAt: CLOCK, tree: { path: gone, branch: "wtgui/x-7d21b4" } } })], { jobs: [job] });

  assert.equal(out.tasks[0].state, "parked", "the park itself is unchanged");
  const runs = out.tasks[0].pipelineRun.stageRuns;
  assert.equal(runs.length, 1, "one run, one entry: the settle does not mint a second attempt");
  const entry = runs[0];
  assert.equal(entry.stage, "S1");
  assert.equal(entry.status, "done", "the entry says what the run ended as");
  assert.equal(entry.settledAt, CLOCK, "and when this pass read it, not the job's own stamp");
  assert.equal(entry.thread, "T1", "which thread ran it");
  assert.equal(entry.job, "j8", "and which job");
  assert.equal(entry.decision.code, DRIVE_FAULTS.TREE_GONE, "the decision about the park rides the SAME entry");
});

test("a changed park settles the finished run it parked on, in the same entry as the decision", () => {
  const job = { id: "j6", thread: "T1", status: "done", startedAt: "2026-11-03T15:00:00.000Z", endedAt: "2026-11-03T15:30:00.000Z" };
  const stale = `sha256:${"0".repeat(64)}`;
  const out = drive([row({ pipelineRun: { pipeline: "two", stage: "S1", enteredAt: CLOCK, route: stale } })], { jobs: [job] });

  assert.equal(out.tasks[0].state, "parked", "the park itself is unchanged");
  const runs = out.tasks[0].pipelineRun.stageRuns;
  assert.equal(runs.length, 1, "one run, one entry: the settle does not mint a second attempt");
  const entry = runs[0];
  assert.equal(entry.stage, "S1");
  assert.equal(entry.status, "done", "the entry says what the run ended as");
  assert.equal(entry.settledAt, CLOCK, "and when this pass read it, not the job's own stamp");
  assert.equal(entry.thread, "T1", "which thread ran it");
  assert.equal(entry.job, "j6", "and which job");
  assert.equal(entry.decision.code, DRIVE_FAULTS.CHANGED, "the decision about the park rides the SAME entry");
});

test("a task with no pipeline comes back untouched, and settles exactly as it did before", () => {
  const plain = [row({ pipelineRun: null })];
  const out = drive(plain);

  assert.equal(out.changed.length, 0, "no stage is invented for a row that never named one");
  assert.equal(out.starts.length, 0);
  assert.equal(out.ensureTree.length, 0, "and no tree is cut for it either");
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
  assert.equal(out.ensureTree.length, 0, "and it does not cut a tree for a row it is not starting");
  assert.equal(out.changed.length, 0);
  assert.equal(out.tasks[1].state, "queued");
});

test("the front row that carries a pipeline asks for a tree, and starts in it on the next pass", (t) => {
  const first = drive([row({ state: "queued", thread: null, threads: [] })]);
  assert.equal(first.starts.length, 0, "the tree is cut before the start, not as part of it");
  assert.equal(first.ensureTree.length, 1);
  assert.equal(first.ensureTree[0].taskId, 1);
  assert.equal(first.ensureTree[0].stage, "S1");
  assert.equal(first.ensureTree[0].project, "agent-worktree-gui");

  // The assistant cut it and wrote the path on the row — the fact the next pass reads.
  const dir = tree(t, { artifacts: [1] });
  const cut = { ...first.tasks[0], pipelineRun: { ...first.tasks[0].pipelineRun, tree: { path: dir, branch: "wtgui/x-abc123", startSha: "9f3c1a2", cutAt: CLOCK, by: "panel" } } };
  const started = drive([cut]);
  assert.equal(started.starts.length, 1);
  assert.equal(started.starts[0].stage, "S1");
  assert.equal(started.starts[0].target, dir);
  assert.equal(started.starts[0].existing, true);
  assert.equal(started.ensureTree.length, 0, "the tree step is not called again: the row already names one");
});

test("a landing ladder filed with a work branch runs in that tree instead of cutting a round", (t) => {
  // The 2026-11-10 next-moves report, rung 2: a `shared` ladder (github-force-merge and its siblings) reuses ONE tree
  // for every stage, and a reader who files its row with a real worktree means that tree. The filed path used to be a
  // hint only, so the six-stage GitHub ladder cut a round nobody wanted and ran its stages in a tree no reader named.
  const dir = tree(t, { artifacts: [1] });
  const branch = "wtgui/carry-the-contract-abc123";
  const out = drive([row({ state: "queued", thread: null, threads: [], worktree: dir })], {
    treeOf: () => ({ branch, commit: "9".repeat(40), head: "9999999", dirty: 0 }),
  });

  assert.equal(out.ensureTree.length, 0, "a shared pipeline reuses one tree: there is no round to cut");
  assert.equal(out.starts.length, 1, "the first stage starts on the same pass");
  assert.equal(out.starts[0].target, dir, "and it starts in the tree the row was filed with");
  assert.equal(out.starts[0].existing, true);
  assert.equal(out.tasks[0].pipelineRun.round, undefined, "no round is recorded: the row stays on the shared model");
  assert.equal(out.tasks[0].pipelineRun.tree.path, dir, "the row's own field names the filed tree from the first move");
  assert.equal(out.tasks[0].pipelineRun.tree.branch, branch, "the branch comes from the panel's git read, not a guess");
  assert.equal(out.tasks[0].pipelineRun.stageRuns[0].tree.path, dir, "the ledger entry names the same tree");
  assert.match(out.starts[0].prompt, new RegExp(`branch ${branch}`), "the worker is told the branch it is in");
});

test("a row filed with the project checkout still cuts the round's parent tree", (t) => {
  // The report's row 50: a row FILED with `worktree` naming the project checkout. The lookup took the field at its
  // word, no cut was asked for, and the stage committed into the checkout's main. The filed-tree rule reads the
  // tree's BRANCH for exactly this case: a trunk is never a stage's tree, whatever the filing form said.
  const filed = tree(t); // the checkout the row was filed against: a real directory, and no tree of this round
  const out = drive([row({ state: "queued", thread: null, threads: [], worktree: filed })], {
    treeOf: () => ({ branch: "main", commit: "9".repeat(40), head: "9999999", dirty: 0 }),
  });

  assert.equal(out.starts.length, 0, "the stage is not started in the tree the row was filed against");
  assert.equal(out.ensureTree.length, 1, "the first cut is owed before anything runs");
  assert.equal(out.ensureTree[0].role, "row", "and the first cut is the round's parent tree");
  assert.equal(out.ensureTree[0].base, null, "cut from origin/main, so the cut names no base");
  assert.equal(out.ensureTree[0].parent, null, "and no parent branch: the parent tree is the round's first tree");
  assert.equal(treeLookup(out.tasks[0]).needed, true, "the row has no tree of its own until the panel cuts one");
});

test("a per-stage pipeline filed with a work branch still cuts its own child trees", (t) => {
  const filed = tree(t);
  const perStage = bundleOf(pipeline({ isolation: "per-stage" }));
  const out = drive([row({ state: "queued", thread: null, threads: [], worktree: filed })], {
    bundle: perStage,
    treeOf: () => ({ branch: "wtgui/carry-the-contract-abc123", commit: "9".repeat(40), head: "9999999", dirty: 0 }),
  });

  assert.equal(out.starts.length, 0, "one filed tree cannot stand in for a per-stage round's children");
  assert.equal(out.ensureTree.length, 1, "a per-stage round cuts the tree its first stage runs in");
});

test("a row with a tree starts the next stage IN that tree", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const out = drive([row({ worktree: dir })]);
  assert.equal(out.starts[0].target, dir);
  assert.equal(out.starts[0].existing, true, "a stage after the first runs in the tree the pipeline already cut");
  assert.equal(treeLookup(out.tasks[0]).path, dir);
  // The tree the start resolved from `worktree` was written on the ledger entry, and the row's field took it from
  // there — so the next lookup reads the row's own field, which is the first answer in the design's sequence.
  assert.equal(treeLookup(out.tasks[0]).source, "pipelineRun.tree");
  assert.equal(out.tasks[0].pipelineRun.tree.path, dir);
});

test("a loop back re-enters with visits + 1, the same tree, and no second cut", (t) => {
  const looped = bundleOf(
    pipeline({
      stages: [stage(1), stage(2)],
      handoffs: [{ id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "3 rounds" }],
    }),
  );
  const dir = tree(t, { artifacts: [1, 2] });
  const run = {
    pipeline: "two",
    stage: "S1",
    enteredAt: "2026-11-03T15:00:00.000Z",
    visits: { S1: 1, S2: 1 },
    tree: { path: dir, branch: "wtgui/carry-abc123", startSha: "9f3c1a2", cutAt: CLOCK, by: "panel" },
    crossings: { "h-back": 1 },
    stageRuns: [{ id: "two/S2#1", stage: "S2", visit: 1, at: CLOCK, thread: "T1", status: "done", tree: { path: dir }, artifact: { id: "artifact-2", path: "out/2.json", present: true, sha256: "x" }, decision: null }],
  };
  // The row is back at S1 because the loop was crossed once; S1's agent settled done and its artifact is there.
  const back = row({ worktree: dir, pipelineRun: run });
  const out = drive([back], { bundle: looped, unattended: true, jobs: [{ thread: "T1", status: "done", startedAt: CLOCK }] });

  assert.equal(out.changed.length, 1);
  assert.equal(out.changed[0].stage, "S2");
  assert.equal(out.tasks[0].pipelineRun.visits.S2, 2, "S2's second entry is a second visit");
  assert.equal(out.ensureTree.length, 0, "a loop back reuses the tree; it never cuts a second one");
  assert.equal(out.starts[0].target, dir);
  assert.equal(out.starts[0].existing, true);
  assert.equal(out.starts[0].visit, 2);
  assert.equal(out.tasks[0].pipelineRun.stageRuns.at(-1).id, "two/S2#2");
});

test("with unattended starts off the row still advances, and nothing is started or cut", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const out = drive([row({ worktree: dir })], { unattended: false });
  assert.equal(out.tasks[0].state, "queued");
  assert.equal(out.tasks[0].pipelineRun.stage, "S2");
  assert.equal(out.starts.length, 0);
  assert.equal(out.ensureTree.length, 0);
});

test("an assignment the bundle cannot resolve parks, and nothing is started", () => {
  const out = drive([row({ pipelineRun: { pipeline: "gone", stage: "S1", enteredAt: "2026-11-03T15:00:00.000Z" } })]);

  assert.equal(out.tasks[0].state, "parked", "unresolved is a fact about a written record, and it stops the row");
  assert.equal(out.starts.length, 0);
  assert.equal(out.tasks[0].pipelineRun.pipeline, "gone", "the reader's record is not rewritten");
  const decision = out.tasks[0].pipelineRun.stageRuns.at(-1).decision;
  assert.equal(decision.code, DRIVE_FAULTS.UNRESOLVED);
  assert.equal(decision.trigger, "unresolved");
  assert.match(out.tasks[0].reason, /which the bundle does not hold/);
});

test("a stage whose declared artifact is absent parks pipeline-artifact, naming path and handoff", (t) => {
  const dir = tree(t); // no out/1.json: the stage settled `done` having written nothing
  const out = drive([row({ worktree: dir })], { unattended: false });

  assert.equal(out.tasks[0].state, "parked");
  assert.equal(out.changed[0].code, DRIVE_FAULTS.ARTIFACT);
  assert.match(out.tasks[0].reason, /artifact artifact-1 \(out\/1\.json\) is not in the tree/);
  assert.match(out.tasks[0].reason, /handoff h1 has nothing to pass/);
  assert.equal(out.tasks[0].pipelineRun.stage, "S1", "the row does not advance on a missing artifact");
  assert.equal(out.starts.length, 0, "and the next pass does not ask for the following stage");
  const decision = out.tasks[0].pipelineRun.stageRuns.at(-1).decision;
  assert.equal(decision.fact.kind, "artifact");
  assert.equal(decision.fact.present, false);
  assert.equal(decision.fact.handoff, "h1");
});

test("a stage that settles with its artifact records its presence and hash, and a second visit records unchanged", (t) => {
  const dir = tree(t, { artifacts: [1, 2] });
  const two = bundleOf(pipeline());
  const hash = artifactOf({ id: "artifact-1", path: "out/1.json" }, { worktree: dir }).sha256;
  // S1 settled once already; the row is back in S1 (a second visit) with the same file on disk.
  const run = {
    pipeline: "two",
    stage: "S1",
    enteredAt: CLOCK,
    visits: { S1: 2, S2: 1 },
    tree: { path: dir, branch: "b", startSha: "a" },
    stageRuns: [{ id: "two/S1#1", stage: "S1", visit: 1, at: CLOCK, thread: "T0", status: "done", artifact: { id: "artifact-1", path: "out/1.json", present: true, sha256: hash } }],
  };
  const out = drive([row({ worktree: dir, pipelineRun: run })], { bundle: two, unattended: false });
  const second = out.tasks[0].pipelineRun.stageRuns.find((r) => r.visit === 2);
  assert.equal(second.artifact.present, true);
  assert.equal(second.artifact.unchanged, true, "identical bytes on a loop back are a visible fact, not a park");
  assert.match(second.decision.reason, /unchanged/);
});

// The 24-stage run's defect, in one test. A stage whose declared path carries `{{run_id}}` and `{{round}}` writes a
// different file every round; the matcher used to take the first `r*` that sorted, so every visit recorded r1's hash
// while r1..r7 sat in the tree, and the pin was taken against the declaration — a path git cannot resolve, which
// recorded committed work as `uncommitted`. The assertions below all fail on that shape.
test("a round artifact is the file that visit wrote, never the first r* that sorts", (t) => {
  const dir = roundTree(t, [1, 2, 3]);
  const declared = "out/{{run_id}}/r{{round}}/round-brief.json";
  const at = (rel) => path.join(dir, ...rel.split("/"));
  const hashOf = (n) => createHash("sha256").update(readFileSync(at(`out/run-1/r${n}/round-brief.json`))).digest("hex");
  const blobOf = (rel) => execFileSync("git", ["-C", dir, "rev-parse", `HEAD:./${rel}`], { encoding: "utf8", windowsHide: true }).trim();
  const roundOne = hashOf(1);
  const two = bundleOf(
    pipeline({ stages: [{ ...stage(1), artifact: { id: "artifact-1", path: declared, schema: "out/1", writer: "worker-1" } }, stage(2)] }),
  );
  // S1 has settled twice already, on the record the old shape wrote: the declaration, and r1's hash for both visits.
  const run = {
    pipeline: "two",
    stage: "S1",
    enteredAt: CLOCK,
    visits: { S1: 3, S2: 1 },
    tree: { path: dir, branch: "b", startSha: "a" },
    stageRuns: [1, 2].map((visit) => ({
      id: `two/S1#${visit}`,
      stage: "S1",
      visit,
      at: CLOCK,
      thread: "T0",
      status: "done",
      artifact: { id: "artifact-1", path: declared, present: true, sha256: roundOne },
    })),
  };
  const out = drive([row({ worktree: dir, pipelineRun: run })], { bundle: two });
  const third = out.tasks[0].pipelineRun.stageRuns.find((r) => r.visit === 3);

  assert.equal(third.artifact.path, declared, "the record keeps the document's declaration");
  assert.notEqual(third.artifact.sha256, roundOne, "the old shape recorded round 1's hash against every visit");
  assert.equal(third.artifact.sha256, hashOf(3), "the hash is the bytes of the file this round wrote");
  assert.equal(third.artifact.file, "out/run-1/r3/round-brief.json", "the file is the round's own, not the first r* that sorts");
  assert.equal(third.artifact.unchanged || false, false, "r3 is not r2: a round that wrote new bytes is not 'unchanged'");
  assert.equal(third.artifact.blob, blobOf("out/run-1/r3/round-brief.json"), "the pin names the blob of the file the round wrote");
  assert.equal(third.artifact.uncommitted || false, false, "committed work pinned against its declaration reads as uncommitted");

  // The handoff is the same file: the next stage is told to read r3, and is handed a pin it can resolve.
  assert.equal(out.starts.length, 1);
  assert.match(out.starts[0].prompt, /out\/run-1\/r3\/round-brief\.json/, "the next stage is handed the file this visit wrote");
  assert.doesNotMatch(out.starts[0].prompt, /\{\{round\}\}/, "and never the unsubstituted pattern");
});

test("the artifact matcher fills the round it knows, and keeps the one-segment match for a hole it does not", (t) => {
  const dir = roundTree(t, [1, 2, 3]);
  const declared = "out/{{run_id}}/r{{round}}/round-brief.json";
  const hashOf = (n) => createHash("sha256").update(readFileSync(path.join(dir, "out", "run-1", `r${n}`, "round-brief.json"))).digest("hex");

  assert.equal(
    artifactOf({ id: "artifact-1", path: declared }, { worktree: dir }).sha256,
    hashOf(1),
    "with no round the matcher's own rule stands: one segment, first in sort order",
  );
  assert.equal(
    artifactOf({ id: "artifact-1", path: declared }, { worktree: dir, values: { round: 3 } }).sha256,
    hashOf(3),
    "a round the caller knows is a literal, not a match",
  );
  assert.equal(
    artifactOf({ id: "artifact-1", path: declared }, { worktree: dir, values: { round: 3 } }).file,
    "out/run-1/r3/round-brief.json",
    "and the resolution names the file, so a pin can be taken against it",
  );
});

test("a routing change between two passes parks pipeline-changed, and a prompt-only change does not", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const first = drive([row({ worktree: dir })], { unattended: false });
  const stamped = first.tasks[0];
  assert.match(stamped.pipelineRun.route, /^sha256:[0-9a-f]{64}$/, "the route is stamped at entry");

  // A prompt-only re-export: routing is identical, so the row is driven exactly as before — it starts its stage.
  const promptOnly = bundleOf(pipeline({ stages: [{ ...stage(1), prompt: "Work stage 1 — better words." }, stage(2)] }));
  const quiet = drive([stamped], { bundle: promptOnly, jobs: [], at: LATER, unattended: true });
  assert.equal(quiet.tasks[0].state, "queued", "a better brief is not a routing change");
  assert.equal(quiet.starts.length, 1, "and the stage is started as usual");

  // A stage list change is routing: the row parks naming both fingerprints.
  const changed = bundleOf(
    pipeline({
      stages: [stage(1), stage(2), stage(3)],
      handoffs: [{ id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" }],
    }),
  );
  const stopped = drive([stamped], { bundle: changed, jobs: [], at: LATER, unattended: true });
  assert.equal(stopped.tasks[0].state, "parked");
  assert.equal(stopped.changed[0].code, DRIVE_FAULTS.CHANGED);
  assert.match(stopped.tasks[0].reason, /routing changed/);
  assert.equal(stopped.tasks[0].pipelineRun.waitingFor.kind, "route");
  assert.equal(stopped.tasks[0].pipelineRun.stageRuns.at(-1).decision.fact.stored, stamped.pipelineRun.route);
});

test("a row whose tree is gone parks pipeline-tree-gone instead of starting in the project", (t) => {
  const gone = path.join(tmpdir(), "wag-tree-that-is-not-there-9f3c1a");
  const moved = row({
    state: "queued",
    thread: null,
    threads: [],
    worktree: null,
    pipelineRun: { pipeline: "two", stage: "S1", enteredAt: CLOCK, tree: { path: gone, branch: "wtgui/x-abc123" } },
  });
  const out = drive([moved], { unattended: true });
  assert.equal(out.tasks[0].state, "parked");
  assert.equal(out.changed[0].code, DRIVE_FAULTS.TREE_GONE);
  assert.match(out.tasks[0].reason, /this row ran in is gone/);
  assert.equal(out.starts.length, 0, "the panel does not cut a replacement, and never starts in the project");
  assert.equal(out.ensureTree.length, 0);
});

test("a second open row naming the same tree is refused, compared case-insensitively", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const other = row({ id: 9, title: "the other row", state: "running", pipelineRun: { pipeline: "two", stage: "S2", enteredAt: CLOCK, tree: { path: dir.toUpperCase() } } });
  const mine = row({
    id: 1,
    state: "queued",
    thread: null,
    threads: [],
    pipelineRun: { pipeline: "two", stage: "S1", enteredAt: CLOCK, tree: { path: dir } },
  });
  const out = drive([mine], { claims: [other], unattended: true });
  assert.equal(out.tasks[0].state, "parked");
  assert.equal(out.changed[0].code, DRIVE_FAULTS.TREE_CLAIMED);
  assert.match(out.tasks[0].reason, /claimed by open row #9/);
  assert.match(out.tasks[0].reason, /the other row/);
  assert.equal(out.starts.length, 0);
});

test("a last stage that declares no PR settles its row on the stage's own verdict", (t) => {
  const dir = tree(t, { artifacts: [2] });
  const out = drive([row({ worktree: dir, pipelineRun: { pipeline: "two", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z" } })]);

  // The gated walk's second defect: the pipeline is over, its last stage declares an artifact that is not a PR, and
  // the landing rule (a tree's PR reads MERGED) can never be satisfied. The row must not stay `running` for ever.
  assert.equal(out.tasks[0].state, "done", "the row is settled, not left running for a landing that is not coming");
  assert.equal(out.tasks[0].doneBy, "panel");
  assert.match(out.tasks[0].reason, /pipeline two is over at S2/);
  assert.match(out.tasks[0].reason, /artifact "artifact-2"/);
  assert.match(out.tasks[0].reason, /not a PR to land/);
  // The sentence SAYS the kind is unstated when the document never declared one. That word is the only thing that
  // stops a stage which should have pushed from silently taking the driver's local default (round 7's row read
  // "critique/1, kind unstated" for exactly this reason), so it is pinned rather than smoothed away.
  assert.match(out.tasks[0].reason, /kind unstated/);
  assert.equal(out.tasks[0].pipelineRun.waitingFor, null, "a finished row is waiting on nothing");
  assert.equal(out.tasks[0].pipelineRun.stageRuns.at(-1).status, "done", "the last stage's run is still recorded");
  assert.equal(out.starts.length, 0, "the pipeline does not invent a stage after it");
  assert.equal(out.changed.length, 1);
  assert.equal(out.changed[0].from, "running");
  assert.equal(out.changed[0].to, "done");
  assert.equal(out.changed[0].stage, "S2");

  // Nothing is left for the settle to do, and it cannot undo the end: a done row is not running.
  const settled = settleTasks(out.tasks, { jobs: done, isLive: () => false, at: CLOCK, rowFor: () => null });
  assert.equal(settled.tasks[0].state, "done");
});

test("a stage that STATES its artifact kind is read by that word, and the finished row says which one", (t) => {
  const dir = tree(t, { artifacts: [2] });
  // The same two-stage pipeline, with the last stage's artifact declared instead of left unstated: `file` is a
  // document in the tree, so the stage has no PR to land and the driver finishes the row on its own verdict — the
  // behaviour an unstated kind got by default, now earned by the document's own word.
  const doc = pipeline({ stages: [stage(1), { ...stage(2), artifact: { ...stage(2).artifact, kind: "file" } }] });
  const out = drive([row({ worktree: dir, pipelineRun: { pipeline: "two", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z" } })], { bundle: bundleOf(doc) });

  assert.equal(out.tasks[0].state, "done", "a file stage has no PR to land, so the settle finishes it here");
  assert.match(out.tasks[0].reason, /\(out\/1, kind file\)/, "the sentence names the kind the document declared");
  assert.doesNotMatch(out.tasks[0].reason, /unstated/, "a stated kind is never reported as an omission");
});

test("a last stage whose artifact IS a PR is left to the landing rule", (t) => {
  const dir = tree(t, { artifacts: [2] });
  const pr = { ...stage(2), artifact: { ...stage(2).artifact, kind: "pr" } };
  const landing = bundleOf(pipeline({ stages: [stage(1), pr] }));
  const out = drive([row({ worktree: dir, pipelineRun: { pipeline: "two", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z" } })], { bundle: landing });

  assert.equal(out.tasks[0].state, "running", "this row really is waiting on a landing, and the settle reads it");
  assert.equal(out.changed.length, 0);
  assert.equal(out.tasks[0].pipelineRun.stageRuns.at(-1).status, "done");

  // Unmerged, the row stays open; MERGED is what finishes it.
  const open = settleTasks(out.tasks, { jobs: done, isLive: () => false, at: CLOCK, rowFor: () => ({ path: dir, verdict: "OPEN" }) });
  assert.equal(open.tasks[0].state, "running");
  const merged = settleTasks(out.tasks, { jobs: done, isLive: () => false, at: CLOCK, rowFor: () => ({ path: dir, verdict: "MERGED" }) });
  assert.equal(merged.tasks[0].state, "done");
  assert.match(merged.tasks[0].reason, /PR reads MERGED/);
});

test("a verdict that ends the pipeline settles the row when its stage declares no PR", (t) => {
  const dir = tree(t, { artifacts: [1] });
  const gated = bundleOf(
    pipeline({
      gates: [
        {
          id: "G1",
          name: "Ship or stop",
          after: "S1",
          artifact: "artifact-1",
          decider: "seat",
          decision: { id: "d1", path: "gates/G1.json", schema: "decision/1", writer: "seat", outcomes: ["ship", "stop"], routes: { ship: "h1", stop: null } },
        },
      ],
    }),
  );

  // No record yet: the row parks on the gate, exactly as it always did.
  const stopped = drive([row({ worktree: dir })], { bundle: gated });
  assert.equal(stopped.tasks[0].state, "parked");
  assert.equal(stopped.tasks[0].pipelineRun.waitingFor.gate, "G1");

  // The record routes `stop` nowhere: the pipeline is over at a stage whose artifact is not a PR, so the row is
  // finished in the same pass that reads the verdict, with the verdict recorded on the stage run.
  mkdirSync(path.join(dir, "gates"), { recursive: true });
  writeFileSync(path.join(dir, "gates", "G1.json"), JSON.stringify({ outcome: "stop" }));
  const ended = drive(stopped.tasks, { bundle: gated, jobs: [], at: LATER });
  assert.equal(ended.tasks[0].state, "done");
  assert.equal(ended.changed.length, 1);
  assert.equal(ended.changed[0].from, "parked");
  assert.equal(ended.changed[0].to, "done");
  assert.match(ended.tasks[0].reason, /pipeline two is over at S1/);
  assert.equal(ended.tasks[0].pipelineRun.waitingFor, null, "the park is over with the pipeline");
  assert.equal(ended.tasks[0].pipelineRun.stageRuns.at(-1).decision.trigger, "verdict", "the verdict that ended it is on the run");
  assert.equal(ended.tasks[0].pipelineRun.stageRuns.at(-1).decision.fact.outcome, "stop");
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

test("the routing fingerprint moves with routing and not with prose", () => {
  const base = bundleOf(pipeline()).pipelines[0];
  const reworded = bundleOf(pipeline({ stages: [{ ...stage(1), prompt: "Different words." }, stage(2)], title: "Renamed" })).pipelines[0];
  assert.equal(routingFingerprint(base), routingFingerprint(reworded), "prompts and titles are not routing");
  const recapped = bundleOf(
    pipeline({ handoffs: [{ id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence", cap: "2 rounds" }] }),
  ).pipelines[0];
  assert.notEqual(routingFingerprint(base), routingFingerprint(recapped), "a cap is routing");
});

test("stagePrompt is the stage's instruction plus the row, and the inputs only when the caller holds them", (t) => {
  const bundle = bundleOf(pipeline());
  const dir = tree(t, { artifacts: [1] });
  const prompt = stagePrompt({ id: 7, title: "carry it", detail: "the reader's words" }, bundle.pipelines[0], bundle.pipelines[0].stages[1]);
  assert.match(prompt, /^Work stage 2\./);
  assert.match(prompt, /stage 2 of 2, Stage 2 \(two\/S2\)/);
  assert.match(prompt, /Queue task #7: carry it/);
  assert.match(prompt, /the reader's words/);
  assert.doesNotMatch(prompt, /INPUTS/, "with no record there is nothing resolved to hand on");
  // The ARTIFACT block names the file the panel CHECKS at settle, with this visit's holes filled — the declaration is
  // a pattern, and a loop's second round must write a second file rather than overwrite the first (dossier item 1).
  assert.match(prompt, /\nARTIFACT\n {2}writes {6}artifact-2 {3}out\/2\.json {3}\(out\/1, kind unstated\) {3}writer worker-2 — the file the panel checks/);
  const roundStage = { ...bundle.pipelines[0].stages[1], artifact: { ...bundle.pipelines[0].stages[1].artifact, path: "out/r{{round}}/2.json", kind: "file" } };
  const round1 = stagePrompt({ id: 7, title: "carry it", detail: "" }, bundle.pipelines[0], roundStage, { run: { pipeline: "two", stage: "S2", enteredAt: CLOCK, visits: { S2: 1 } } });
  const round2 = stagePrompt({ id: 7, title: "carry it", detail: "" }, bundle.pipelines[0], roundStage, { run: { pipeline: "two", stage: "S2", enteredAt: CLOCK, visits: { S2: 2 } } });
  assert.match(round1, /out\/r1\/2\.json {3}\(out\/1, kind file\)/, "visit 1 writes its own round's file");
  assert.match(round2, /out\/r2\/2\.json {3}\(out\/1, kind file\)/, "visit 2 writes a DIFFERENT file, not visit 1's again");

  // With the record and the tree facts, the block is paths, hashes and facts — never a summary. The writer's settled
  // run carries the PIN, and the block names it INSTEAD OF a branch: the commit, the blob, and where to read it.
  const writer = {
    id: "two/S1#1",
    stage: "S1",
    visit: 1,
    at: CLOCK,
    status: "done",
    commit: "a".repeat(40),
    artifact: { id: "artifact-1", path: "out/1.json", present: true, sha256: "b".repeat(64), commit: "a".repeat(40), blob: "c".repeat(40), blobSha256: "d".repeat(64) },
  };
  const withInputs = stagePrompt(
    { id: 7, title: "carry it", detail: "" },
    bundle.pipelines[0],
    bundle.pipelines[0].stages[1],
    {
      run: { pipeline: "two", stage: "S2", enteredAt: CLOCK, via: "h1", visits: { S1: 1, S2: 1 }, tree: { path: dir, branch: "wtgui/x-abc123" }, stageRuns: [writer] },
      tree: { path: dir, branch: "wtgui/x-abc123" },
      facts: { head: "1c9f0aa", dirty: 2 },
    },
  );
  assert.match(withInputs, /\nINPUTS\n/);
  assert.match(withInputs, /handed on {3}artifact-1 {3}out\/1\.json {3}commit a{12} {3}blob c{12} {3}sha256 d{12}… {3}writer worker-1/);
  assert.match(withInputs, /\(S1 → S2, handoff h1, sequence; read it at a{12}:out\/1\.json\)/, "the block says where to read the pinned blob");
  assert.doesNotMatch(withInputs, /handed on[^\n]*branch/, "the handoff is never named by a branch");
  assert.match(withInputs, /tree {8}.*wtgui\/x-abc123/);
  assert.match(withInputs, /HEAD 1c9f0aa {3}2 uncommitted files/);
  assert.doesNotMatch(withInputs, /summary/i);
});

// The unattended spawn's toolset (docs/reviews/ping-pong-round-6-2026-11-08.html, "The unattended spawn's toolset
// includes a tool its policy refuses"): the critic's first call was `execute_code`, answered "BLOCKED: this session
// runs on an unattended platform", and the turn was spent learning what the prompt could have said. Every stage start
// is that unattended run, so the sentence rides every stage prompt — and it names the tool that does work.
test("stagePrompt names the tools an unattended stage may use, and the one the platform refuses", () => {
  const bundle = bundleOf(pipeline());
  const prompt = stagePrompt({ id: 7, title: "carry it", detail: "" }, bundle.pipelines[0], bundle.pipelines[0].stages[0]);
  assert.match(prompt, /\nTOOLS — this stage runs unattended/);
  assert.match(prompt, /nobody is at the keyboard/);
  assert.match(prompt, /refuses `execute_code`/, "the refused tool is named, so the run does not spend a turn testing it");
  assert.match(prompt, /Use `terminal` for commands/, "and the tool that works is named beside it");
  assert.match(prompt, /`read_file`, `write_file` and `patch`/);
  assert.equal(prompt.split("TOOLS —").length - 1, 1, "one sentence, once, not a paragraph per section");
});

// The gate a stage OWNS (docs/reviews/ping-pong-round-6-2026-11-08.html, "G1 cannot be asked"): a gate with a decision
// is a barrier, and the panel never writes the record — so the worker standing on that gate has to be told the file
// exists, and which words it may put in it. Without this line the ping-pong's converged round still ran to its cap.
test("stagePrompt tells the stage that owns a gate's verdict to write it, with this round's path", () => {
  const gate = {
    id: "G1",
    after: "S2",
    artifact: "artifact-2",
    name: "Verdict",
    decider: "worker-2",
    decision: {
      id: "verdict",
      path: "out/verdict-r{{round}}.json",
      schema: "verdict/1",
      writer: "worker-2",
      outcomes: ["accept", "revise"],
      routes: { accept: null, revise: "h-back" },
    },
  };
  const loop = bundleOf(
    pipeline({
      gates: [gate],
      handoffs: [
        { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h-back", from: "S2", to: "S1", artifact: "artifact-2", kind: "loop", cap: "3 rounds" },
      ],
    }),
  ).pipelines[0];
  const record = { pipeline: "two", stage: "S2", enteredAt: CLOCK, visits: { S1: 1, S2: 2 }, stageRuns: [] };
  const prompt = stagePrompt({ id: 7, title: "carry it" }, loop, loop.stages[1], { run: record });
  assert.match(prompt, /\nGATE\n/);
  assert.match(prompt, /the gate G1 \(Verdict\) after this stage declares out\/verdict-r2\.json/, "the round is filled, exactly as the driver fills it when it reads the record");
  assert.match(prompt, /write it as \{"outcome": "accept" \| "revise"\}/);
  assert.match(prompt, /accept → the pipeline ends here/, "the seat is told what its word will do");
  assert.match(prompt, /revise → handoff h-back/);
  assert.match(prompt, /never writes the record for you/);

  // The other stage of the same pipeline does not own this verdict, and is not told to write it.
  const first = stagePrompt({ id: 7, title: "carry it" }, loop, loop.stages[0], { run: { ...record, stage: "S1", visits: { S1: 1 } } });
  assert.doesNotMatch(first, /\nGATE\n/);
  assert.doesNotMatch(first, /out\/verdict/);
});

test("the decision record is rendered, not written twice: row reason and stage run carry the same sentence", (t) => {
  const dir = tree(t); // the artifact is missing, so the park and its decision are about that fact
  const out = drive([row({ worktree: dir })], { unattended: false });
  const decision = out.tasks[0].pipelineRun.stageRuns.at(-1).decision;
  assert.equal(decision.reason, out.tasks[0].reason, "the row's reason IS the decision's sentence");
  assert.equal(renderDecision(decision.fact), decision.reason, "and one renderer produces it from the fact");
  assert.equal(out.changed[0].why, decision.reason, "the journal line gets the same sentence");
});

test("a task with no pipeline is untouched by the tree and route checks", () => {
  // The point of the untouched path: the driver never looks for a tree, a route or an artifact on a row that never
  // named a pipeline, so nothing about that row's behaviour moves with this design.
  const plain = row({ pipelineRun: null, worktree: null, state: "running", thread: "T1", threads: ["T1"] });
  const out = drive([plain], { jobs: [{ thread: "T1", status: "done" }] });
  assert.deepEqual(out.tasks, [plain]);
  assert.equal(out.changed.length, 0);
  assert.equal(out.starts.length, 0);
  assert.equal(out.ensureTree.length, 0);
});

// ---- a finished per-stage ROUND owes one assembly ---------------------------------------------------------------
// Every stage of a round runs in its own tree (lib/task-pipeline-drive.js `roundOf`), so a finished round leaves N
// commits on N local branches. The landing step must be handed ONE branch: when the pipeline is over, the driver asks
// for the assembly (lib/pipeline-assembly.js) and does not finish the row on that pass - the next pass reads the
// assembly record and takes the ordinary end.

const CHAIN = {
  id: "round",
  title: "Baseline, implement, compare, correct",
  stages: [stage(1), stage(2), stage(3), stage(4)],
  gates: [],
  handoffs: [
    { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
    { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
    { id: "h3", from: "S3", to: "S4", artifact: "artifact-3", kind: "sequence" },
  ],
};

const ROUND_SHA = "5".repeat(40);
const COMMITS = { S1: "1".repeat(40), S2: "2".repeat(40), S3: "3".repeat(40), S4: "4".repeat(40) };

// The shape sefl-review-loop has, cut to what the REMOTE decision needs: a work stage, then the two stages whose
// artifact IS the pull request (push and pr). Both act on the round's parent tree, so the ref the first pushes is the
// head the second opens its PR from.
const prStage = (n) => ({ ...stage(n), artifact: { ...stage(n).artifact, kind: "pr" } });
const ROUND_BRANCH = "wtgui/carry-the-contract-9f8e7d";
const PR_CHAIN = {
  id: "land",
  title: "Branch, push, open the pull request",
  stages: [stage(1), prStage(2), prStage(3)],
  gates: [],
  handoffs: [
    { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
    { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
  ],
};

// A round of that chain on ONE parent tree: S1 settled in its own stage child at COMMITS.S1, and `at(stage, runs)`
// answers the record standing on a stage. `assembled` says whether the round's one branch has been written yet - the
// driver asks for it before a pr-kind stage starts when it has not (lib/task-pipeline-drive.js `assemblyPlanOf`).
function prChainRig(t) {
  const parent = tree(t, { artifacts: [1, 2, 3] });
  const first = tree(t, { artifacts: [1] });
  const s1 = {
    id: "land/S1#1",
    stage: "S1",
    visit: 1,
    at: CLOCK,
    thread: "T1",
    job: "j1",
    status: "done",
    commit: COMMITS.S1,
    tree: { path: first, branch: "wtgui/s1-abc123" },
    artifact: { id: "artifact-1", path: "out/1.json", present: true, sha256: "a".repeat(64), commit: COMMITS.S1 },
  };
  const s2 = {
    id: "land/S2#1",
    stage: "S2",
    visit: 1,
    at: CLOCK,
    thread: "T2",
    job: "j2",
    status: "done",
    commit: COMMITS.S2,
    tree: { path: parent, branch: ROUND_BRANCH },
    artifact: { id: "artifact-2", path: "out/2.json", present: true, sha256: "b".repeat(64), commit: COMMITS.S2 },
  };
  const at = (where, stageRuns, { assembled = true, over = {} } = {}) =>
    row({
      state: "queued",
      thread: null,
      threads: [],
      worktree: parent,
      pipelineRun: {
        pipeline: "land",
        stage: where,
        enteredAt: CLOCK,
        round: { parentPath: parent, parent: ROUND_BRANCH, sha: ROUND_SHA, base: "origin/main", at: CLOCK, by: "panel" },
        visits: { S1: 1, S2: 1, S3: 1 },
        tree: { path: parent, branch: ROUND_BRANCH },
        trees: { S1: { path: first, branch: "wtgui/s1-abc123" } },
        ...(assembled ? { assembly: { commit: "f".repeat(40), base: ROUND_SHA, branch: ROUND_BRANCH, path: parent, verified: true } } : {}),
        stageRuns,
      },
      ...over,
    });
  return { parent, first, s1, s2, at };
}

// A row at the END of a four-stage round: every stage settled in its own tree at its own commit. The last stage's
// tree is a real directory holding the artifact it declares, because a settle is only 'done' over one.
function finishedRound(t, over = {}) {
  const last = tree(t, { artifacts: [4] });
  const stageRuns = ["S1", "S2", "S3", "S4"].map((id, index) => ({
    id: `round/${id}#1`,
    stage: id,
    visit: 1,
    status: "done",
    thread: `T${index + 1}`,
    job: `j-${index + 1}`,
    commit: COMMITS[id],
    tree: { path: index === 3 ? last : `${last}-${id}`, branch: `wtgui/${id.toLowerCase()}-abc123` },
    artifact: { id: `artifact-${id.slice(1)}`, path: `out/${id.slice(1)}.json`, present: true },
  }));
  return row({
    // The LEGACY field is the FIRST thread of the list (lib/assistant/queue.js `normThreads`), and the run carrying
    // the row now is the LAST: T4, the stage that just settled.
    thread: "T1",
    threads: ["T1", "T2", "T3", "T4"],
    worktree: last,
    pipelineRun: {
      pipeline: "round",
      stage: "S4",
      enteredAt: CLOCK,
      round: { parent: "main", sha: ROUND_SHA, at: CLOCK, by: "panel" },
      visits: { S1: 1, S2: 1, S3: 1, S4: 1 },
      trees: { S4: { path: last, branch: "wtgui/s4-abc123" } },
      stageRuns,
    },
    ...over,
  });
}

test("a finished round asks for ONE assembly, in visit order, and is not finished on that pass", (t) => {
  const task = finishedRound(t);
  const out = driveTaskPipelines([task], { bundle: bundleOf(CHAIN), jobs: [{ id: "j-4", thread: "T4", status: "done", startedAt: CLOCK }], isLive: () => false, at: CLOCK, unattended: true });
  assert.equal(out.assemblies.length, 1, "the round's stages are on their own branches, so one assembly is owed");
  const request = out.assemblies[0];
  assert.equal(request.taskId, task.id);
  assert.equal(request.base, ROUND_SHA, "cut from the round's frozen parent");
  assert.equal(request.parent, "main", "and recorded under the branch it came from");
  assert.deepEqual(request.stages.map((entry) => [entry.stage, entry.commit]), [["S1", COMMITS.S1], ["S2", COMMITS.S2], ["S3", COMMITS.S3], ["S4", COMMITS.S4]], "baseline first, then implement, compare and correct");
  assert.equal(out.tasks[0].state, "running", "the row is NOT finished before its one branch exists");
  assert.equal(out.changed.length, 0, "and it did not move");
});

test("once the assembly is recorded the round finishes, and a second assembly is never asked for", (t) => {
  const task = finishedRound(t);
  const assembled = {
    ...task,
    pipelineRun: {
      ...task.pipelineRun,
      tree: { path: "/trees/assembled", branch: "wtgui/round-9f8e7d" },
      assembly: { commit: "a".repeat(40), base: ROUND_SHA, branch: "wtgui/round-9f8e7d", path: "/trees/assembled", verified: true },
    },
  };
  const out = driveTaskPipelines([assembled], { bundle: bundleOf(CHAIN), jobs: [{ id: "j-4", thread: "T4", status: "done", startedAt: CLOCK }], isLive: () => false, at: CLOCK, unattended: true });
  assert.equal(out.assemblies.length, 0, "the record is the proof it happened");
  assert.equal(out.tasks[0].state, "done", "the round is over and its one branch is on the row");
  assert.match(out.tasks[0].reason, /not a PR to land/, "finished on the last stage's own verdict");
});

test("a work stage in its OWN tree never lands by itself: its branch is assembled, not pushed", (t) => {
  // The PR a mid-round work stage would open holds that stage alone. A stage tree is local only, so the landing
  // paragraph is never handed to it - the assembly's branch is the one that lands (lib/pipeline-assembly.js rule 5).
  // The round here has a PARENT TREE, which is the model every new round is cut under: the rule is the work stage's,
  // not the old record's.
  const parent = tree(t);
  const first = tree(t, { artifacts: [1] });
  const task = row({
    state: "queued",
    thread: null,
    threads: [],
    worktree: parent,
    pipelineRun: {
      pipeline: "round",
      stage: "S1",
      enteredAt: CLOCK,
      round: { parentPath: parent, parent: "wtgui/round-9f8e7d", sha: ROUND_SHA, base: "origin/main", at: CLOCK, by: "panel" },
      visits: { S1: 1 },
      tree: { path: parent, branch: "wtgui/round-9f8e7d" },
      trees: { S1: { path: first, branch: "wtgui/s1-abc123" } },
      stageRuns: [],
    },
  });
  const out = driveTaskPipelines([task], { bundle: bundleOf(CHAIN), jobs: [], isLive: () => false, at: CLOCK, unattended: true });
  assert.equal(out.starts.length, 1);
  assert.equal(out.starts[0].target, first, "the work stage still runs in its own stage child");
  assert.equal(out.starts[0].remoteWrite, "local", "a stage tree is never the branch that lands");
  assert.equal(out.assemblies.length, 0, "and a work stage asks for no assembly to start");
});

test("a pr-kind stage in a chain acts on the round's parent tree, never a fresh stage child", (t) => {
  // THE DEFECT rows 66 and 67 hit: filed with no worktree, the driver cut one tree per stage at the round's base and
  // handed every stage the local-only paragraph, so sefl-review-loop's push (job ffaabbf3) and pr (3733218c) could
  // never act. A stage whose artifact IS the pull request acts on the branch that LANDS: the round's parent tree,
  // assembled from every stage before it. Its own stage child is never cut and never named.
  const rig = prChainRig(t);
  const out = driveTaskPipelines([rig.at("S2", [rig.s1])], { bundle: bundleOf(PR_CHAIN), jobs: [], isLive: () => false, at: CLOCK, unattended: true });
  assert.equal(out.starts.length, 1);
  const start = out.starts[0];
  assert.equal(start.stage, "S2");
  assert.equal(start.remoteWrite, "pr", "a pr stage is told to push the branch it acts on");
  assert.equal(start.target, rig.parent, "its workspace is the round's parent tree, not a stage child");
  assert.equal(start.tree.branch, ROUND_BRANCH, "and the branch it pushes is the round's own");
  assert.match(start.prompt, new RegExp(ROUND_BRANCH), "the worker is told the ref it is about to push");
  assert.equal(out.ensureTree.length, 0, "no fresh stage child is cut for it");
  assert.equal(start.isolation, undefined, "and it is not a fan-out lane");
});

test("a pr-kind stage is not started until the round's settled work is on the branch it pushes", (t) => {
  // The parent tree is still at the round's frozen base until the assembly runs: a push now would publish a branch
  // holding none of the round's work, and the row's one PR would have nothing in it. So the assembly is asked for
  // FIRST, at the stage that is about to push, and that stage is not started on the same pass.
  const rig = prChainRig(t);
  const out = driveTaskPipelines([rig.at("S2", [rig.s1], { assembled: false })], { bundle: bundleOf(PR_CHAIN), jobs: [], isLive: () => false, at: CLOCK, unattended: true });
  assert.equal(out.starts.length, 0, "nothing is started before the branch has the round on it");
  assert.equal(out.assemblies.length, 1, "the round's one branch is asked for instead");
  const request = out.assemblies[0];
  assert.equal(request.stage, "S2", "the request names the stage that will push it");
  assert.equal(request.parentPath, rig.parent, "and picks into the round's parent tree");
  assert.equal(request.parent, ROUND_BRANCH);
  assert.equal(request.base, ROUND_SHA, "cut from the round's frozen parent, never origin/main as it stands now");
  assert.deepEqual(request.stages.map((entry) => entry.stage), ["S1"], "every settled stage's commit is in the plan");

  // Once the assembly is recorded, the same row starts the pr stage on that one branch.
  const after = driveTaskPipelines([rig.at("S2", [rig.s1], { assembled: true })], { bundle: bundleOf(PR_CHAIN), jobs: [], isLive: () => false, at: CLOCK, unattended: true });
  assert.equal(after.assemblies.length, 0, "a recorded assembly is never asked for twice");
  assert.equal(after.starts[0].target, rig.parent);
  assert.equal(after.starts[0].remoteWrite, "pr");
});

test("the push and the pr stage of one round are one head: the row opens exactly ONE PR", (t) => {
  // Two stages of sefl-review-loop declare `kind: "pr"` (push and pr). Both act on the round's parent tree, on the
  // round's own branch, so the ref the first pushes IS the head the second opens a PR from: one branch, one PR. Two
  // stage branches would have been two PRs, each holding one stage of the round.
  const rig = prChainRig(t);
  const push = driveTaskPipelines([rig.at("S2", [rig.s1])], { bundle: bundleOf(PR_CHAIN), jobs: [], isLive: () => false, at: CLOCK, unattended: true }).starts[0];
  const pr = driveTaskPipelines([rig.at("S3", [rig.s1, rig.s2])], { bundle: bundleOf(PR_CHAIN), jobs: [], isLive: () => false, at: CLOCK, unattended: true }).starts[0];
  assert.equal(push.stage, "S2");
  assert.equal(pr.stage, "S3");
  assert.equal(push.remoteWrite, "pr");
  assert.equal(pr.remoteWrite, "pr", "the pr stage is told to open one, not to stay local");
  const heads = new Set([`${push.target} ${push.tree.branch}`, `${pr.target} ${pr.tree.branch}`]);
  assert.equal(heads.size, 1, "one branch, so one PR head - the head the push stage pushed");
  assert.deepEqual([...heads], [`${rig.parent} ${ROUND_BRANCH}`], "and it is the branch the round's assembly writes");
});

test("a fan-out lane is local-only whatever its artifact declares", (t) => {
  // rule 5 of lib/pipeline-fanout.js is the invariant the round's fix must not move: a lane branch exists to be
  // merged into the aggregate, never pushed. Its artifact kind cannot change that, because the lane is not the
  // branch that lands - the aggregate is.
  const lane = tree(t, { artifacts: [1] });
  const bundle = bundleOf({
    id: "reports",
    title: "Reports",
    isolation: "per-stage",
    stages: [prStage(1), prStage(2), stage(3)],
    gates: [],
    handoffs: [
      { id: "h1", from: "S1", to: "S3", artifact: "artifact-1", kind: "sequence" },
      { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
    ],
  });
  const task = row({
    state: "queued",
    thread: null,
    threads: [],
    pipelineRun: {
      pipeline: "reports",
      stage: "S1",
      enteredAt: CLOCK,
      visits: { S1: 1 },
      fanout: { base: "b".repeat(40), fork: null, lanes: ["S1", "S2"], join: "S3" },
      trees: { S1: { path: lane, branch: "wtgui/lane-a-abc123" } },
    },
  });
  const out = driveTaskPipelines([task], { bundle, jobs: [], isLive: () => false, at: CLOCK, unattended: true });
  assert.equal(out.starts.length, 1);
  assert.equal(out.starts[0].target, lane, "the lane runs in its own tree");
  assert.equal(out.starts[0].remoteWrite, "local", "and a lane branch is never pushed, whatever it declares");
  assert.equal(out.starts[0].isolation, "per-stage");
  assert.equal(out.assemblies.length, 0, "a fan-out has one merge, not a round's assembly");
});

