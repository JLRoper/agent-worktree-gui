// What a task is doing, pipeline-wise — lib/task-pipeline.js.
//
// Five facts, each driven rather than read off the source:
//
//   1. a task with no `pipelineRun` (absent or null) reads assistant-decides, and every field a card would draw is
//      null — the mode is a word, not a truthiness, so the page never has to guess why it has no stage;
//   2. a task on a pipeline reports the pipeline, the stage it is in, that stage's 1-based position in the sequence,
//      how many stages the sequence holds, and the elapsed time computed from the stored `enteredAt` and a FIXED
//      clock — nothing is read from a running timer;
//   3. a record that names a pipeline or a stage the bundle does not hold is `unresolved` and says why. It never falls
//      back to assistant-decides: that would silently drop the pipeline a reader chose and leave a normal-looking card;
//   4. `elapsedInStage` is a pure function of two instants: it answers milliseconds, refuses a missing or local-time
//      stamp, and clamps a stamp ahead of the clock to zero while saying it is ahead;
//   5. `enterStage` writes the ENTRY's clock, so time in stage restarts on the transition, and the record it was given
//      is untouched (the panel may still be holding it).
import assert from "node:assert/strict";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { ASSISTANT_DECIDES, STAGE_RUNS_MAX, TASK_PIPELINE_FIELD, assignPipeline, beginStageRun, elapsedInStage, elapsedSince, enterStage, resolveTaskPipeline, settleStageRun, stageRunId, stageRunsOf, visitsOf } from "../lib/task-pipeline.js";

// A thirteen-stage pipeline, because "stage 4 of 13" is the shape a card has to be able to say and a one-stage fixture
// would pass while the position maths is wrong.
const stage = (n) => ({
  id: `S${n}`,
  title: `Stage ${n}`,
  prompt: `Work stage ${n}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

const bundle = parseBundle({
  bundleVersion: 1,
  name: "poc-to-uat",
  pipelines: [
    {
      id: "poc-to-uat",
      title: "POC to UAT",
      stages: Array.from({ length: 13 }, (_, i) => stage(i)),
      gates: [],
      handoffs: [],
    },
  ],
}).bundle;

// The fixed clock every elapsed assertion is made against: 15:00Z on the same day the task entered S3.
const NOW = new Date("2026-11-03T15:00:00.000Z");
const task = () => ({ id: "job-1", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } });

// The round-7 row's own numbers: created 2026-11-08T23:18:31.249Z, its LAST stage started 00:32:43.749Z, done
// 00:38:15.977Z. The stage clock read 5 m 32 s while the row had existed for 1 h 19 m 44 s, because `startedAt` is the
// current run's and every stage move clears it (`setTaskState("queued")`). The row's age is `createdAt`'s, and this is
// the pin that keeps the two clocks apart.
test("a row's own clock is read from createdAt, never from the stage's startedAt", () => {
  const created = "2026-11-03T12:00:00.000Z";
  const row = { ...task(), id: "job-9", createdAt: created, startedAt: "2026-11-03T14:59:00.000Z" };
  const view = resolveTaskPipeline(row, { bundle, now: NOW });
  assert.equal(view.sinceCreated.ok, true);
  assert.equal(view.sinceCreated.at, created, "the stamp the number came from travels with it");
  assert.equal(view.sinceCreated.ms, 3 * 3_600_000, "three hours from createdAt to the clock");
  assert.equal(view.elapsed.ms, 9_000_000, "the stage's clock is still its own: 2h30 from enteredAt");
  assert.notEqual(view.sinceCreated.ms, view.elapsed.ms, "the row's age and the stage's span are two facts");

  // `startedAt` does not move it: the same row with a later start reads the same age.
  const laterStart = resolveTaskPipeline({ ...row, startedAt: "2026-11-03T14:00:00.000Z" }, { bundle, now: NOW });
  assert.equal(laterStart.sinceCreated.ms, view.sinceCreated.ms);

  // Every mode carries it, because it is the ROW's clock and not the pipeline's: the default path has one too.
  const plain = resolveTaskPipeline({ id: 5, createdAt: created }, { bundle, now: NOW });
  assert.equal(plain.mode, ASSISTANT_DECIDES);
  assert.equal(plain.sinceCreated.ms, 3 * 3_600_000, "a row with no pipeline still has an age");

  // A record with no createdAt answers a refusal and a null — never a zero that would read as "just filed".
  const none = resolveTaskPipeline({ ...task(), id: "job-10" }, { bundle, now: NOW });
  assert.equal(none.sinceCreated.ok, false);
  assert.equal(none.sinceCreated.ms, null);
  assert.equal(none.sinceCreated.at, null);
  assert.match(none.sinceCreated.reason, /no createdAt/);
  assert.equal(elapsedSince(created, { now: NOW }).ms, 3 * 3_600_000);
});

test("a task with no pipeline reads assistant-decides", () => {
  for (const record of [{}, { id: "job-2" }, { id: "job-3", [TASK_PIPELINE_FIELD]: null }]) {
    const view = resolveTaskPipeline(record, { bundle, now: NOW });
    assert.equal(view.mode, ASSISTANT_DECIDES);
    assert.equal(view.ok, true);
    assert.equal(view.pipeline, null);
    assert.equal(view.stage, null);
    assert.equal(view.stageTitle, null);
    assert.equal(view.position, null);
    assert.equal(view.count, null);
    assert.equal(view.enteredAt, null);
    assert.equal(view.elapsed, null);
    assert.match(view.reason, /the assistant decides/);
  }
});

test("a task on a pipeline reports its stage, position in the sequence and elapsed time", () => {
  const view = resolveTaskPipeline(task(), { bundle, now: NOW });
  assert.equal(view.mode, "pipeline");
  assert.equal(view.ok, true);
  assert.equal(view.pipeline, "poc-to-uat");
  assert.equal(view.title, "POC to UAT");
  assert.equal(view.stage, "S3");
  assert.equal(view.stageTitle, "Stage 3");
  // Array position 3 in a zero-based world is "stage 4" to a reader, which is the number the card says.
  assert.equal(view.position, 4);
  assert.equal(view.count, 13);
  assert.equal(view.enteredAt, "2026-11-03T12:30:00.000Z");
  // 12:30Z to 15:00Z is two and a half hours, from the stored stamp and `now` alone.
  assert.deepEqual(view.elapsed, { ok: true, ms: 9_000_000, future: false, reason: null });
  assert.equal(view.reason, null);

  // The clock is an argument, not a reading: the same record a minute later is a minute longer.
  const later = resolveTaskPipeline(task(), { bundle, now: "2026-11-03T15:01:00.000Z" });
  assert.equal(later.elapsed.ms, 9_060_000);
});

test("a record naming a pipeline or stage the bundle does not hold is unresolved, not assistant-decides", () => {
  const unknownPipeline = resolveTaskPipeline({ [TASK_PIPELINE_FIELD]: { pipeline: "nope", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } }, { bundle, now: NOW });
  assert.equal(unknownPipeline.mode, "unresolved");
  assert.equal(unknownPipeline.ok, false);
  assert.equal(unknownPipeline.pipeline, "nope");
  assert.match(unknownPipeline.reason, /does not hold \(it holds poc-to-uat\)/);

  const unknownStage = resolveTaskPipeline({ [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S99", enteredAt: "2026-11-03T12:30:00.000Z" } }, { bundle, now: NOW });
  assert.equal(unknownStage.mode, "unresolved");
  assert.equal(unknownStage.stage, "S99");
  assert.match(unknownStage.reason, /holds no stage "S99"/);
  assert.match(unknownStage.reason, /S0, S1, S2, S3/);

  // An empty record is a record that says nothing, not the absence that means "the assistant decides".
  const empty = resolveTaskPipeline({ [TASK_PIPELINE_FIELD]: {} }, { bundle, now: NOW });
  assert.equal(empty.mode, "unresolved");
  assert.match(empty.reason, /names no pipeline/);

  // A named pipeline with no stage has no position to report; a named stage with no stamp has no elapsed time.
  const noStage = resolveTaskPipeline({ [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat" } }, { bundle, now: NOW });
  assert.equal(noStage.mode, "unresolved");
  assert.match(noStage.reason, /names no stage/);

  const noStamp = resolveTaskPipeline({ [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3" } }, { bundle, now: NOW });
  assert.equal(noStamp.mode, "unresolved");
  assert.match(noStamp.reason, /no enteredAt/);

  // No bundle at all is a different refusal from a bundle that lacks the id, and both say which they are.
  const noBundle = resolveTaskPipeline(task(), { now: NOW });
  assert.equal(noBundle.mode, "unresolved");
  assert.match(noBundle.reason, /no bundle is loaded/);
});

test("elapsedInStage is a pure function of two instants", () => {
  assert.equal(elapsedInStage("2026-11-03T12:30:00.000Z", { now: NOW }).ms, 9_000_000);
  // The boundary is an instant, not a rounding: the moment of entry is zero, not one tick.
  assert.equal(elapsedInStage("2026-11-03T15:00:00.000Z", { now: NOW }).ms, 0);

  // A stamp ahead of the clock is clamped AND flagged: "-4s in stage" is worse than "0, and the stamp is ahead".
  const future = elapsedInStage("2026-11-03T15:00:04.000Z", { now: NOW });
  assert.equal(future.ok, true);
  assert.equal(future.ms, 0);
  assert.equal(future.future, true);

  // A local-time string has no zone; subtracting it from a clock is a guess that is wrong twice a year.
  const local = elapsedInStage("2026-11-03 12:30:00", { now: NOW });
  assert.equal(local.ok, false);
  assert.equal(local.ms, null);
  assert.match(local.reason, /not a UTC instant/);

  assert.equal(elapsedInStage("", { now: NOW }).ok, false);
  assert.match(elapsedInStage(null, { now: NOW }).reason, /no enteredAt/);

  // A clock that is not a clock is refused rather than producing NaN.
  assert.equal(elapsedInStage("2026-11-03T12:30:00.000Z", { now: "not a clock" }).ok, false);
});

test("a fraction of any length is a UTC instant, and only the fraction's refusal is about the fraction", () => {
  // A hand-off from another tool can carry microseconds. The stamp IS a UTC instant, and the fraction's length is
  // not a reason to refuse it: this is the stage-2 hand-off that read as "no zone" while its zone was right there.
  const sub = elapsedInStage("2026-11-06T19:28:20.426123Z", { now: "2026-11-06T19:30:20.426123Z" });
  assert.equal(sub.ok, true, sub.reason || "a six-digit fraction must parse");
  assert.equal(sub.ms, 120_000);
  assert.equal(sub.future, false);

  // Short and long: the pattern bounds the digits' shape, not their count.
  assert.equal(elapsedInStage("2026-11-06T19:28:20.4Z", { now: "2026-11-06T19:28:21.4Z" }).ms, 1_000);

  // No Z: the refusal is still the zone's, and still says so.
  const zoneless = elapsedInStage("2026-11-06 19:28:20.426123", { now: NOW });
  assert.equal(zoneless.ok, false);
  assert.match(zoneless.reason, /no zone/);

  // With its Z, the zone is not the fault: the fraction is, and that is a DIFFERENT sentence.
  const badFraction = elapsedInStage("2026-11-06T19:28:20.4x6123Z", { now: NOW });
  assert.equal(badFraction.ok, false);
  assert.match(badFraction.reason, /fraction after the seconds cannot be read/);
  assert.doesNotMatch(badFraction.reason, /no zone/);
});

test("enterStage restarts the clock and leaves the record it was given alone", () => {
  const before = task();
  const after = enterStage(before, { stage: "S4", enteredAt: "2026-11-03T15:00:00.000Z" });
  assert.notEqual(after, before);
  assert.deepEqual(after.pipelineRun, { pipeline: "poc-to-uat", stage: "S4", enteredAt: "2026-11-03T15:00:00.000Z", visits: { S3: 1, S4: 1 } });
  assert.equal(before[TASK_PIPELINE_FIELD].stage, "S3");
  assert.equal(before[TASK_PIPELINE_FIELD].enteredAt, "2026-11-03T12:30:00.000Z");

  const view = resolveTaskPipeline(after, { bundle, now: NOW });
  assert.equal(view.position, 5);
  assert.equal(view.elapsed.ms, 0);

  // Starting a task on a pipeline is the same record shape, and the id it was cut with survives.
  const assigned = assignPipeline({ id: "job-9" }, { pipeline: "poc-to-uat", stage: "S0", enteredAt: "2026-11-03T12:00:00.000Z" });
  assert.equal(assigned.id, "job-9");
  const first = resolveTaskPipeline(assigned, { bundle, now: NOW });
  assert.equal(first.mode, "pipeline");
  assert.equal(first.position, 1);
  assert.equal(first.count, 13);

  // A blank id is a programming error at the write, not a stored record the read has to explain.
  assert.throws(() => assignPipeline({}, { pipeline: "", stage: "S0" }), TypeError);
  assert.throws(() => enterStage({}, { stage: "S1" }), TypeError);
});

// ---- the stage run: identity, the counter and the ledger -----------------------------------------------------------
// A stage run is ONE entry into one stage by one agent. Its id is a string so a journal line, a park's sentence, a
// test and a person naming the attempt all name the same thing, and a bundle that inserts a stage does not renumber it.

test("a stage run's id is <pipeline>/<stage>#<visit>, and it is stable across a re-ordered bundle", () => {
  assert.equal(stageRunId("poc-to-uat", "S8", 2), "poc-to-uat/S8#2");
  assert.equal(stageRunId(" poc-to-uat ", " S8 ", "3"), "poc-to-uat/S8#3");
  assert.equal(stageRunId("", "S8", 1), null);
  assert.equal(stageRunId("poc-to-uat", "", 1), null);
  // A visit the record cannot have meant reads as the first entry rather than as "#0" or "#NaN".
  assert.equal(stageRunId("poc-to-uat", "S8", 0), "poc-to-uat/S8#1");
  assert.equal(stageRunId("poc-to-uat", "S8", null), "poc-to-uat/S8#1");
});

test("a record written before the ledger reads as one visit of the stage it is in, and nothing is written back", () => {
  const legacy = { id: "job-7", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } };
  const before = JSON.stringify(legacy);
  const view = resolveTaskPipeline(legacy, { bundle, now: NOW });
  assert.equal(view.mode, "pipeline");
  assert.equal(view.visit, 1);
  assert.equal(view.stageRunId, "poc-to-uat/S3#1");
  assert.deepEqual(view.stageRuns, [], "an absent ledger is an EMPTY list — nothing was recorded, not nothing ran");
  assert.equal(view.decision, null);
  assert.deepEqual(visitsOf(legacy[TASK_PIPELINE_FIELD]), { S3: 1 });
  assert.equal(JSON.stringify(legacy), before, "a read never writes: the migration is a reading, not a rewrite");
});

test("entering a stage bumps that stage's visit and keeps every other count", () => {
  const first = assignPipeline({ id: "job-1" }, { pipeline: "poc-to-uat", stage: "S0", enteredAt: "2026-11-03T12:00:00.000Z" });
  assert.deepEqual(visitsOf(first[TASK_PIPELINE_FIELD]), { S0: 1 });
  const second = enterStage(first, { stage: "S1", enteredAt: "2026-11-03T12:10:00.000Z" });
  assert.deepEqual(visitsOf(second[TASK_PIPELINE_FIELD]), { S0: 1, S1: 1 });
  // A loop back into S0 is a SECOND visit of S0, and S1's first entry is still #1.
  const back = enterStage(second, { stage: "S0", enteredAt: "2026-11-03T12:20:00.000Z", via: "h-back" });
  assert.deepEqual(visitsOf(back[TASK_PIPELINE_FIELD]), { S0: 2, S1: 1 });
  assert.equal(resolveTaskPipeline(back, { bundle, now: NOW }).stageRunId, "poc-to-uat/S0#2");
  // The edge is counted in the SAME write, so the cap and the visit cannot disagree after a restart.
  assert.deepEqual(back[TASK_PIPELINE_FIELD].crossings, { "h-back": 1 });
});

test("a start creates the ledger entry, and a retry of the same visit reuses it rather than minting a second", () => {
  const task = { id: "job-1", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } };
  const started = beginStageRun(task, { at: "2026-11-03T12:31:00.000Z" });
  const runs = stageRunsOf(started[TASK_PIPELINE_FIELD]);
  assert.equal(runs.length, 1, "an entry is created when the START is asked for, not when it settles");
  assert.deepEqual(runs[0], {
    id: "poc-to-uat/S3#1",
    stage: "S3",
    visit: 1,
    at: "2026-11-03T12:31:00.000Z",
    thread: null,
    job: null,
    status: null,
    decision: null,
  });
  assert.equal(task[TASK_PIPELINE_FIELD].stageRuns, undefined, "the record it was given is not mutated");

  // The spawner hung; three minutes later the driver retries the same visit. One entry, a fresh `at`.
  const retried = beginStageRun(started, { at: "2026-11-03T12:34:00.000Z" });
  const again = stageRunsOf(retried[TASK_PIPELINE_FIELD]);
  assert.equal(again.length, 1, "a retry is an attempt, not a visit");
  assert.equal(again[0].at, "2026-11-03T12:34:00.000Z");
});

// The round-4 defect: a start that had already LINKED a thread failed the dedupe (`thread` is set), so a retry or a
// second start minted a second entry under the SAME `poc-to-uat/S3#1`, and the next settle - which matched stage and
// visit alone - stamped its thread onto that entry. The critic's thread and job landed on the drafter's record.
test("two starts in one visit on different threads are two runs, two ids, and a settle stamps only its own", () => {
  const base = { id: "job-1", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } };
  const first = beginStageRun(base, { stage: "S3", thread: "thread-A", at: "2026-11-03T12:31:00.000Z" });
  const second = beginStageRun(first, { stage: "S3", thread: "thread-B", at: "2026-11-03T12:33:00.000Z" });
  const runs = stageRunsOf(second[TASK_PIPELINE_FIELD]);
  assert.equal(runs.length, 2, "a start whose thread is already on the entry is a SECOND attempt, not a retry of the first");
  assert.deepEqual(runs.map((entry) => entry.thread), ["thread-A", "thread-B"]);
  assert.deepEqual(runs.map((entry) => entry.id), ["poc-to-uat/S3#1", "poc-to-uat/S3#1.2"], "the first attempt keeps its id; the next is suffixed");
  assert.equal(new Set(runs.map((entry) => entry.id)).size, 2, "no two entries in one ledger may share an id");

  // The settle names thread A: only A's entry is touched. B's run is still B's, and still open.
  const settled = settleStageRun(second, { stage: "S3", visit: 1, thread: "thread-A", status: "done", at: "2026-11-03T13:00:00.000Z" });
  const after = stageRunsOf(settled[TASK_PIPELINE_FIELD]);
  const a = after.find((entry) => entry.thread === "thread-A");
  const b = after.find((entry) => entry.thread === "thread-B");
  assert.equal(a.id, "poc-to-uat/S3#1");
  assert.equal(a.status, "done");
  assert.equal(b.id, "poc-to-uat/S3#1.2");
  assert.equal(b.status, null, "the other thread's run is not settled by A's settle");
  assert.equal(after.filter((entry) => entry.thread === "thread-A").length, 1);
  assert.equal(after.filter((entry) => entry.thread === "thread-B").length, 1);

  // A settle for a thread the ledger has never seen creates ITS entry rather than stamping the nearest one.
  const stranger = settleStageRun(settled, { stage: "S3", visit: 1, thread: "thread-C", job: "job-c", status: "failed", at: "2026-11-03T13:05:00.000Z" });
  const withC = stageRunsOf(stranger[TASK_PIPELINE_FIELD]);
  const c = withC.find((entry) => entry.thread === "thread-C");
  assert.ok(c, "a settle for an unrecorded thread records that thread");
  assert.equal(c.id, "poc-to-uat/S3#1.3");
  assert.equal(c.job, "job-c");
  assert.equal(c.status, "failed");
  assert.equal(withC.find((entry) => entry.thread === "thread-B").status, null, "and B is still untouched");
  assert.equal(new Set(withC.map((entry) => entry.id)).size, 3);

  // The view names the run the row is IN - the newest attempt - and still answers the first-attempt id for a record
  // written before the ledger existed.
  assert.equal(resolveTaskPipeline(stranger, { bundle, now: NOW }).stageRunId, "poc-to-uat/S3#1.3");
  assert.equal(resolveTaskPipeline({ id: "job-2", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } }, { bundle, now: NOW }).stageRunId, "poc-to-uat/S3#1");
});

test("the settle fills the entry: thread, job, status, artifact, tree facts and the decision", () => {
  const started = beginStageRun({ id: "job-1", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } }, { at: "2026-11-03T12:31:00.000Z" });
  const decision = { by: "panel", trigger: "stage-settled", code: null, at: "2026-11-03T13:00:00.000Z", fact: { kind: "run-status" }, reason: "stage S3 settled — the run finished" };
  const settled = settleStageRun(started, {
    thread: "carry the form",
    job: "job-4f2a",
    status: "done",
    at: "2026-11-03T13:00:00.000Z",
    artifact: { id: "finding", path: "ledger/G58.json", present: true, sha256: "3d0e91" },
    tree: { path: "/trees/carry-the-form-a1b2c3", branch: "wtgui/carry-the-form-a1b2c3", head: "1c9f0aa", dirty: 0 },
    decision,
  });
  const entry = stageRunsOf(settled[TASK_PIPELINE_FIELD])[0];
  assert.equal(entry.thread, "carry the form");
  assert.equal(entry.job, "job-4f2a");
  assert.equal(entry.status, "done");
  assert.equal(entry.settledAt, "2026-11-03T13:00:00.000Z");
  assert.equal(entry.artifact.sha256, "3d0e91");
  assert.equal(entry.tree.head, "1c9f0aa");
  assert.equal(entry.decision.reason, decision.reason);
});

test("the ledger is capped by its writer, newest last, and the number dropped is kept", () => {
  let task = { id: "job-1", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } };
  // A visit per stage id, so every entry is distinguishable: 31 entries into a ledger capped at 30.
  for (let n = 0; n <= STAGE_RUNS_MAX; n += 1) {
    task = { id: "job-1", [TASK_PIPELINE_FIELD]: { ...task[TASK_PIPELINE_FIELD], stage: `S${n}` } };
    task = beginStageRun(task, { at: `2026-11-03T12:${String(n).padStart(2, "0")}:00.000Z` });
  }
  const run = task[TASK_PIPELINE_FIELD];
  const runs = stageRunsOf(run);
  assert.equal(runs.length, STAGE_RUNS_MAX, "the cap is the writer's, because pickTask carries the record verbatim");
  assert.equal(run.runsDropped, 1, "the one number the cap must not lose");
  assert.equal(runs.at(-1).stage, `S${STAGE_RUNS_MAX}`, "newest last");
  assert.equal(runs[0].stage, "S1", "the oldest entry is the one dropped");
});

test("a hand move on the same pipeline keeps the ledger and the crossings; another pipeline starts a new record", () => {
  let task = { id: "job-1", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S0", enteredAt: "2026-11-03T12:00:00.000Z", crossings: { h1: 2 } } };
  task = beginStageRun(task, { at: "2026-11-03T12:01:00.000Z" });
  const moved = assignPipeline(task, { pipeline: "poc-to-uat", stage: "S1", enteredAt: "2026-11-03T12:05:00.000Z" });
  assert.equal(moved[TASK_PIPELINE_FIELD].crossings.h1, 2, "the counts describe this graph, and this graph did not change");
  assert.equal(stageRunsOf(moved[TASK_PIPELINE_FIELD]).length, 1, "the ledger travels with the record");
  assert.deepEqual(visitsOf(moved[TASK_PIPELINE_FIELD]), { S0: 1, S1: 1 });

  const other = assignPipeline(moved, { pipeline: "poc-to-uat-2", stage: "S1", enteredAt: "2026-11-03T12:06:00.000Z" });
  assert.equal(other[TASK_PIPELINE_FIELD].crossings, undefined, "a cap from one pipeline must not bound a loop in another");
  assert.equal(other[TASK_PIPELINE_FIELD].stageRuns, undefined);
  assert.deepEqual(visitsOf(other[TASK_PIPELINE_FIELD]), { S1: 1 });
});
