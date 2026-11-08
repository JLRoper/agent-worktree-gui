// The pipeline bench — tools/bench-pipeline.mjs and the four definitions under tools/pipeline-bench/.
//
// Six facts, each driven rather than read off the source:
//
//   1. the fixture bundle LOADS through the panel's own loader and holds the four documents the bench advertises,
//      with the gate the scenario file routes (accept → H-02, reject → H-03) and the two capped loops of the
//      ping-pong;
//   2. a scenario that claims a stage, edge, gate or route the document does not hold is REFUSED before a task is
//      filed, naming the claim — a bench whose expectation is not the document's would walk a graph nobody can see;
//   3. all five scenarios walk through `Assistant.sweepQueues`, attached to real queue rows, and every check passes;
//   4. the walk's own record is the document's: the handoff stages twice in order, the gate PARKS and crosses only on
//      its record, the reject BOUNCES to a second draft, the queued row WAITS three sweeps behind #1 and starts
//      nothing, and the two-way ping-pong stops at its cap instead of running past it;
//   5. a scenario whose expectation the walk does not meet FAILS, and the failure names the row, the run and the
//      step — the bench is a test, not a transcript;
//   6. the bench is re-runnable: a second run over the same files agrees with the first, writes nothing when asked
//      not to, and leaves no sandbox path in its ledger.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { loadBench, runBench, validateScenarios } from "../tools/bench-pipeline.mjs";

const HERE = import.meta.dirname;
const FIXTURES = path.resolve(HERE, "..", "tools", "pipeline-bench");
const BUNDLE = path.join(FIXTURES, "bundle.json");
const SCENARIOS = path.join(FIXTURES, "scenarios.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const byId = (runs) => Object.fromEntries(runs.map((run) => [run.id, run]));
// One walk of all five scenarios serves the two tests that read it. The panel's sweep is the cost (it reads a queue
// file and asks git about the tree on every pass), and walking the same five documents twice to assert the same
// facts would double the file's wall clock for no extra evidence.
let shared = null;
const walkAll = () => (shared ||= runBench({ write: false, quiet: true }));

test("the bench bundle loads whole and holds the four documents the bench advertises", () => {
  const bench = loadBench();
  const source = parseBundle(readFileSync(BUNDLE, "utf8"), { file: BUNDLE });
  assert.equal(source.ok, true, "the panel's own loader accepts the fixture bundle");
  assert.equal(bench.bundle.pipelines.length, 4, "one bundle, four tiny documents");

  const ids = bench.bundle.pipelines.map((pipeline) => pipeline.id);
  assert.deepEqual(ids, ["bench-handoff", "bench-gate", "bench-queue", "bench-ping-pong"]);

  const gate = bench.bundle.pipelines.find((pipeline) => pipeline.id === "bench-gate");
  assert.deepEqual(gate.order, ["draft", "review", "publish"], "the gate document is a sequence, a gate and a finish");
  assert.deepEqual(gate.gates[0].decision.routes, { accept: "H-02", reject: "H-03" }, "the gate routes both outcomes the scenario walks");
  assert.equal(gate.gates[0].decision.path, "bench/verdict-{{round}}.json", "the record is per round, so round 2 is asked its own question");

  const pingPong = bench.bundle.pipelines.find((pipeline) => pipeline.id === "bench-ping-pong");
  assert.deepEqual(pingPong.handoffs.map((handoff) => handoff.kind), ["loop", "loop"], "both ways of the ping-pong are loops");
  assert.deepEqual(pingPong.handoffs.map((handoff) => handoff.cap), ["2 rounds", "2 rounds"], "and both name a bound");

  assert.equal(bench.scenarios.length, 5, "five scenarios: handoff, accept, reject, queue and ping-pong");
  assert.deepEqual(bench.scenarios.map((scenario) => scenario.id), ["handoff", "gate-accept", "gate-reject", "queue-behind-live", "ping-pong"]);
});

test("a scenario that names a stage or edge the document does not hold is refused before a task is filed", () => {
  const bench = loadBench();
  assert.equal(validateScenarios(bench.bundle, bench.scenarios), true, "the checked-in scenarios are the document's own claims");

  const bad = structuredClone(bench.scenarios[0]);
  bad.expect.starts = ["draft", "deploy"];
  assert.throws(
    () => validateScenarios(bench.bundle, [bad]),
    (error) => error.code === "bench-scenario" && /deploy/.test(error.message) && /does not hold/.test(error.message),
    "a start at a stage the bundle does not hold is a refusal that names the stage",
  );

  const badEdge = structuredClone(bench.scenarios[2]);
  badEdge.expect.parks[0].edge = "H-99";
  assert.throws(
    () => validateScenarios(bench.bundle, [badEdge]),
    (error) => error.code === "bench-scenario" && /H-99/.test(error.message),
    "a park routed along an edge the document does not hold is refused, not walked",
  );

  // A bundle the PANEL refuses is refused here too, with the loader's own code and locator: the bench never walks
  // half a document.
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-bench-bad-"));
  try {
    const doc = JSON.parse(readFileSync(BUNDLE, "utf8"));
    doc.pipelines.find((pipeline) => pipeline.id === "bench-gate").gates[0].decision.routes = undefined;
    const file = path.join(dir, "bundle.json");
    writeFileSync(file, JSON.stringify(doc));
    assert.throws(
      () => loadBench({ bundleFile: file }),
      (error) => error.code === "incomplete-gate" && /routes/.test(error.message),
      "an ambiguous gate is the loader's refusal, surfaced by the bench before the first task",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all five scenarios walk through the panel's sweep and every check passes", async () => {
  const result = await walkAll();
  assert.equal(result.ok, true, `every check passed: ${result.failures} failed`);
  assert.equal(result.runs.length, 5);
  assert.ok(result.checks >= 70, `the bench makes a real claim (${result.checks} checks)`);
  for (const run of result.runs) {
    assert.ok(run.checks.every((check) => check.ok), `${run.id}: ${run.checks.filter((check) => !check.ok).map((check) => `${check.what} — ${check.detail}`).join("; ")}`);
    assert.ok(run.started.length >= 2, `${run.id} started at least two stages`);
    for (const start of run.started) {
      const entry = run.stageRuns.find((candidate) => candidate.id === start.run);
      assert.ok(entry, `${run.id}: ${start.run} is in the row's own stage ledger`);
      assert.equal(entry.status, "done", `${run.id}: ${start.run} settled done`);
      assert.equal(entry.artifact.present, true, `${run.id}: ${start.run} left its declared artifact in the tree`);
      assert.equal(entry.artifact.sha256, start.sha256, `${run.id}: ${start.run} records the bytes the seat wrote`);
      assert.ok(entry.job && entry.thread, `${run.id}: ${start.run} names the job and the thread that carried it`);
    }
  }
});

test("the handoff stages twice, the gate parks and accepts, the reject bounces, the queue waits and the ping-pong stops", async () => {
  const result = await walkAll();
  const runs = byId(result.runs);

  const handoff = runs.handoff;
  assert.deepEqual(handoff.started.map((start) => start.stage), ["draft", "stage"]);
  assert.deepEqual(handoff.row.visits, { draft: 1, stage: 1 });
  assert.equal(handoff.row.state, "done");
  assert.deepEqual(handoff.verdicts, { staged: 2, gated: 0, queued: 0, bounced: 0 });

  const accept = runs["gate-accept"];
  assert.deepEqual(accept.parks.map((park) => [park.gate, park.stage, park.visit, park.outcome, park.edge, park.to]), [["G1", "review", 1, "accept", "H-02", "publish"]]);
  assert.deepEqual(accept.started.map((start) => start.stage), ["draft", "review", "publish"]);
  assert.equal(accept.verdicts.gated, 1);
  assert.equal(accept.verdicts.bounced, 0, "an accept is not a bounce");
  // The park is a STEP, not a sentence: the report can point at the sweep the row waited on the record.
  assert.ok(accept.steps.some((step) => step.state === "parked" && step.waitingFor && step.waitingFor.kind === "gate" && step.waitingFor.gate === "G1" && step.stage === "review"));

  const reject = runs["gate-reject"];
  assert.deepEqual(reject.started.map((start) => start.stage), ["draft", "review", "draft", "review", "publish"]);
  assert.deepEqual(reject.parks.map((park) => park.outcome), ["reject", "accept"]);
  assert.equal(reject.verdicts.bounced, 1, "the reject is counted as a bounce");
  assert.equal(reject.row.crossings["H-03"], 1, "the bounce crossed the back edge once");
  assert.equal(reject.row.visits.draft, 2, "and the drafter was entered a second time");
  assert.equal(reject.row.state, "done");

  const queue = runs["queue-behind-live"];
  assert.equal(queue.row.id, 2, "the pipeline row is filed behind the blocker");
  assert.equal(queue.queued.behind.id, 1);
  assert.equal(queue.queued.sweeps, 3);
  assert.equal(queue.queued.startsDuring, 0, "no stage was started over the live row");
  assert.equal(queue.queued.stateAtRelease, "queued");
  assert.deepEqual(queue.started.map((start) => start.stage), ["queue-a", "queue-b"]);
  assert.equal(queue.verdicts.queued, 3);

  const pingPong = runs["ping-pong"];
  assert.deepEqual(pingPong.started.map((start) => start.stage), ["ping", "pong", "ping", "pong", "ping"]);
  assert.equal(pingPong.row.state, "parked", "the two-way ping-pong stops; it does not loop for ever");
  assert.equal(pingPong.row.waitingFor.kind, "cap");
  assert.equal(pingPong.row.waitingFor.edge, "H-01");
  assert.equal(pingPong.row.waitingFor.limit, 2);
  assert.equal(pingPong.verdicts.staged, 5);
  assert.equal(pingPong.started.length, 5, "five starts is the document's bound, not the walk's budget");
});

test("a scenario the walk does not meet fails, and the failure names the row, the run and the step", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-bench-wrong-"));
  try {
    const doc = JSON.parse(readFileSync(SCENARIOS, "utf8"));
    const wrong = doc.scenarios.find((scenario) => scenario.id === "ping-pong");
    wrong.expect.starts = ["ping", "pong"];
    wrong.expect.maxStarts = 2;
    const scenarioFile = path.join(dir, "scenarios.json");
    writeFileSync(scenarioFile, JSON.stringify({ scenarios: [wrong] }));

    const result = await runBench({ scenarioFile, only: ["ping-pong"], write: false, quiet: true });
    assert.equal(result.ok, false, "a walk that outran its claim is a failure");
    assert.equal(result.runs.length, 1);
    const failed = result.runs[0].checks.filter((check) => !check.ok).map((check) => `${check.what} — ${check.detail}`);
    assert.ok(failed.some((line) => /started the document's stages in order/.test(line)), "the start list failure is reported");
    assert.ok(failed.some((line) => /start #3 was bench-ping-pong\/ping#2/.test(line)), "the first disagreement names the run and the step");
    assert.ok(failed.some((line) => /stayed inside its bound of 2 starts/.test(line)), "the loop bound failure is reported");
    assert.match(failed.join("\n"), /row #1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bench is re-runnable: a second run agrees, writes nothing when asked, and leaves no sandbox path", async () => {
  const before = sha256(readFileSync(BUNDLE));
  const first = await runBench({ write: false, quiet: true, only: ["handoff"] });
  const second = await runBench({ write: false, quiet: true, only: ["handoff"] });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.runs, first.runs, "the same documents and the same clock produce the same walk");
  assert.deepEqual(first.wrote, [], "write:false writes no ledger and no report");
  assert.equal(sha256(readFileSync(BUNDLE)), before, "the fixture bundle is read, never rewritten");
  const text = JSON.stringify(first.runs);
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, "no committed record names a drive letter");
  assert.match(text, /<sandbox>/, "the sandbox is named as one, not as this run's temp folder");
});
