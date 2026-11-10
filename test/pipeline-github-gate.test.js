// A gate whose decision is an OBJECT is a barrier and a router; a gate whose decision is null is the studio's pause.
//
// The GitHub ladder (github-force-merge: commit, version, push, pr, merge, main) ships with six gates that carry no
// decision, so the driver walks through them: gateAfter answers nothing and the edge out is taken in kind order.
// This file gives G3 (after push) a decision in a TEMPORARY copy of the seed and walks the ladder from push three
// times, so both halves of the gate's contract are pinned on the pipeline a reader actually runs:
//
//   no record        the walk stops on G3 - nextStageOf answers ok false with code pipeline-gate, names the gate and
//                    the record path expanded onto the tree, and enters nothing
//   outcome refused  the route is null - the pipeline is over at push, pr is never entered, and the row's own
//                    sentence names the refused verdict
//   outcome pushed   the route is H-03 - the walk enters pr once, by that handoff, and carries the verdict with it
//
// The shipped seed is NOT edited. A fourth test pins its six null decisions on this ladder AND proves the pin has
// teeth: the loader refuses the same decision with its path removed, so an edit that adds a decision with no path
// fails here instead of landing.
//
// The driver behaviour this file reads on is pinned in test/task-pipeline-drive.test.js ("a gate that declares a
// decision record is crossed only by that record", "a gate asks for its round's own record") and in
// test/task-pipeline-verdict.test.js ("the routed edge wins over the kind order", "a verdict the document cannot
// route parks pipeline-verdict instead of guessing an edge").
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readBundle } from "../lib/pipeline-bundle.js";
import { decisionOf, DRIVE_FAULTS, nextStageOf } from "../lib/task-pipeline-drive.js";

const SEED = path.resolve(import.meta.dirname, "..", "pipeline-bundle.seed.json");
const AT = "2026-11-09T15:00:00.000Z";
const PIPELINE = "github-force-merge";
const STAGE = "push";
const GATE = "G3";
// The record path the brief gives G3: one file per run. `{{run_id}}` is a hole the driver CANNOT fill, so it stays a
// one-segment match - the same rule test/task-pipeline-drive.test.js pins for a gate's per-run record.
const RECORD = "ledger/gates/G3-{{run_id}}.json";
// The record the seat writes for this run. It has to match the declaration's one segment, which is what a name like
// this is for: the file carries the run it belongs to, and the gate matches it without a second registry.
const RUN_RECORD = "G3-run-1.json";

// The decision the brief hands G3. The driver reads three of these fields (path, outcomes, routes); the bundle
// contract also requires an id, a schema and a writer (lib/pipeline-bundle.js normaliseDecision), and a decision the
// loader refuses is not a document a walk can be proven on, so the copy carries all six.
const DECISION = {
  id: "g3-verdict",
  path: RECORD,
  schema: "gate-verdict/1",
  writer: "worker",
  outcomes: ["pushed", "refused"],
  routes: { pushed: "H-03", refused: null },
};

// A temporary copy of the shipped seed with ONE edit: the GitHub ladder's G3 carries `decision`. Written to disk and
// read back through the loader, because the thing under test is a document the panel would accept, not an object this
// file assembled. `decision` is passed whole, so a copy with a field missing is refused the way a real edit would be.
function copyOfSeed(t, decision) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-github-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = JSON.parse(readFileSync(SEED, "utf8"));
  doc.pipelines.find((entry) => entry.id === PIPELINE).gates.find((entry) => entry.id === GATE).decision = decision;
  const file = path.join(dir, "pipeline-bundle.json");
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return { dir, file };
}

// The ladder the walks start from: the copy, loaded, and a tree with the record folder and no record in it yet.
function gatedLadder(t) {
  const { dir, file } = copyOfSeed(t, DECISION);
  const read = readBundle(file);
  assert.equal(read.ok, true, `the copy must load: ${read.code} ${read.reason}`);
  const pipeline = read.bundle.pipelines.find((entry) => entry.id === PIPELINE);
  // The document's own three fields survive the loader, so the walk below is the one the brief describes.
  const g3 = pipeline.gates.find((entry) => entry.id === GATE);
  assert.equal(g3.decision.path, RECORD);
  assert.deepEqual(g3.decision.outcomes, ["pushed", "refused"]);
  assert.deepEqual(g3.decision.routes, { pushed: "H-03", refused: null });
  const tree = path.join(dir, "tree");
  mkdirSync(path.join(tree, "ledger", "gates"), { recursive: true });
  const record = (outcome) => writeFileSync(path.join(tree, "ledger", "gates", RUN_RECORD), JSON.stringify({ outcome }));
  return { pipeline, tree, record };
}

// A tree with the record folder and no record in it: the shape a gate waits on before the seat has written anything.
function recordTree(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-github-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "ledger", "gates"), { recursive: true });
  return dir;
}

const runAt = (stage) => ({ pipeline: PIPELINE, stage, enteredAt: AT, visits: { [stage]: 1 }, crossings: {} });

// Walk the ladder the way the panel does: ask nextStageOf, and follow the stage it names until the graph answers
// "over" or refuses. `entered` is every stage the walk entered, with the handoff that entered it and the verdict that
// routed it, so "once, by H-03" is read off the walk rather than assumed. `rounds` is a guard, not a cap: a ladder
// that looped would stop the walk here and fail the assertions that expect the walk to finish.
function walkFrom(pipeline, { worktree, stage = STAGE, rounds = 8 } = {}) {
  const run = runAt(stage);
  const entered = [];
  let step = null;
  for (let i = 0; i < rounds; i += 1) {
    step = nextStageOf(pipeline, run, { worktree });
    if (!step.ok || step.done) break;
    entered.push({ stage: step.stage.id, handoff: step.handoff ? step.handoff.id : null, verdict: step.verdict || null });
    run.stage = step.stage.id;
    run.visits[step.stage.id] = (run.visits[step.stage.id] || 0) + 1;
  }
  return { entered, step, reason: endedReason(run, step) };
}

// The sentence the panel writes on the row when the walk stops on a verdict: driveTaskPipelines builds this fact for a
// parked row whose record ends its pipeline (lib/task-pipeline-drive.js, the parked-row release), and decisionOf
// renders it. The reason asserted below is therefore the one a reader would see, not a sentence invented here.
function endedReason(run, step) {
  if (!step || !step.ok || !step.done || !step.verdict) return null;
  return decisionOf({
    code: null,
    trigger: "verdict",
    at: AT,
    fact: {
      kind: "verdict",
      gate: step.verdict.gate,
      path: step.verdict.path,
      outcome: step.verdict.outcome,
      handoff: step.verdict.handoff,
      edge: step.verdict.edge,
      from: step.verdict.from,
      to: step.verdict.to,
      ended: true,
      stage: run.stage,
      pipeline: run.pipeline,
    },
  }).reason;
}

test("a gate whose decision is an object is a BARRIER: with no record, the walk out of push stops on G3", (t) => {
  const { pipeline, tree } = gatedLadder(t);
  const step = nextStageOf(pipeline, runAt(STAGE), { worktree: tree });

  assert.equal(step.ok, false, "the code does not decide the gate, so the walk cannot leave push");
  assert.equal(step.code, DRIVE_FAULTS.GATE);
  assert.equal(step.code, "pipeline-gate", "pipeline-gate is the code this answer carries");
  assert.equal(step.gate.id, GATE);
  assert.equal(step.gate.name, "Pushed");
  // The path the answer carries is the declaration EXPANDED onto the tree: the row is told which file it must read,
  // and `{{run_id}}` - a hole the driver cannot fill - is left as the one segment the matcher will accept.
  assert.equal(step.path, path.join(tree, "ledger", "gates", "G3-{{run_id}}.json"));
  assert.match(step.reason, /gate G3 \(Pushed\) follows push and declares a decision record at/);
  assert.match(step.reason, /the record has not been written/);
  assert.equal(Object.prototype.hasOwnProperty.call(step, "stage"), false, "no stage is named: the walk did not move");
});

test("the record's refused verdict is a ROUTE to nowhere: the walk ends at push and pr is never entered", (t) => {
  const { pipeline, tree, record } = gatedLadder(t);
  record("refused");

  const walk = walkFrom(pipeline, { worktree: tree });
  assert.deepEqual(walk.entered, [], "refused routes to null, and the ladder out of push is that one edge");
  assert.equal(walk.entered.filter((entry) => entry.stage === "pr").length, 0, "pr is never entered");
  assert.equal(walk.step.ok, true);
  assert.equal(walk.step.done, true, "the pipeline is over at push");
  assert.equal(walk.step.closing, null, "nothing closes a pipeline that ended on its own verdict");
  assert.equal(walk.step.verdict.gate, GATE);
  assert.equal(walk.step.verdict.outcome, "refused");
  assert.equal(walk.step.verdict.ended, true);
  assert.equal(walk.step.verdict.handoff, null, "the route names no handoff: this outcome ends the pipeline");
  // The row's own sentence names the verdict, the gate and the fact that the pipeline is over.
  assert.match(walk.reason, /gate G3 placed its verdict at .*G3-\{\{run_id\}\}\.json/);
  assert.match(walk.reason, /"refused"/, "the reason names the refused verdict");
  assert.match(walk.reason, /the pipeline is over and the settle finishes the row/);
});

test("the record's pushed verdict is a ROUTE by H-03: the walk enters pr once, and carries the verdict", (t) => {
  const { pipeline, tree, record } = gatedLadder(t);
  record("pushed");

  const walk = walkFrom(pipeline, { worktree: tree });
  assert.equal(walk.step.ok, true, walk.step.reason || "");
  assert.equal(walk.entered.length > 0, true, "the walk entered a stage");
  assert.equal(walk.entered[0].stage, "pr");
  assert.equal(walk.entered[0].handoff, "H-03", "pr is entered BY H-03, the edge the document routed");
  assert.equal(walk.entered[0].verdict.gate, GATE);
  assert.equal(walk.entered[0].verdict.outcome, "pushed");
  assert.equal(walk.entered[0].verdict.ended, false);
  assert.equal(walk.entered.filter((entry) => entry.stage === "pr").length, 1, "pr is entered exactly once");
  // The rest of the ladder is the straight rail the seed ships, so the walk reaches the end and nothing loops.
  assert.deepEqual(walk.entered.map((entry) => entry.stage), ["pr", "merge", "main"]);
  assert.deepEqual(walk.entered.map((entry) => entry.handoff), ["H-03", "H-04", "H-05"]);
  assert.equal(walk.step.done, true, "the walk finishes: the verdict routed forward, it did not end the pipeline");
});

test("the shipped seed is untouched: six null decisions on the GitHub ladder, and a decision with no path is refused", (t) => {
  const read = readBundle(SEED);
  assert.equal(read.ok, true, `the shipped seed must load: ${read.code} ${read.reason}`);
  const github = read.bundle.pipelines.find((entry) => entry.id === PIPELINE);
  assert.deepEqual(github.gates.map((entry) => entry.id), ["G1", "G2", "G3", "G4", "G5", "G6"]);
  assert.deepEqual(github.gates.map((entry) => entry.decision), [null, null, null, null, null, null], "six pauses, not one decision");

  // A null decision is a PAUSE, not a barrier: the same walk crosses G3 without stopping, which is what the panel has
  // always done on this ladder and what the temporary copy's one edit changes.
  const crossed = nextStageOf(github, runAt(STAGE), { worktree: recordTree(t) });
  assert.equal(crossed.ok, true, "a gate with no decision does not hold the walk");
  assert.equal(crossed.stage.id, "pr");
  assert.equal(crossed.handoff.id, "H-03");
  assert.equal(crossed.gate, undefined, "no gate is named in the answer: there was nothing to wait on");

  // ...and the pin has teeth. The SAME decision with its path removed is refused at load, so a seed edited to add a
  // decision with no path cannot reach a walk: readBundle answers ok false here and this test fails.
  const { file } = copyOfSeed(t, {
    id: DECISION.id,
    schema: DECISION.schema,
    writer: DECISION.writer,
    outcomes: DECISION.outcomes,
    routes: DECISION.routes,
  });
  const refused = readBundle(file);
  assert.equal(refused.ok, false, "a decision with no path is not loadable");
  assert.equal(refused.code, "incomplete-gate");
  assert.match(refused.reason, /missing path/);
});
