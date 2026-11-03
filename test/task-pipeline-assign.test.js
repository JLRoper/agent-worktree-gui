// Putting a task ON a pipeline, and taking it back off: the write side of the contract lib/task-pipeline.js defines.
//
// The read side already answers "where is this task". This module answers "put it here", "move it to this stage" and
// "clear it back to assistant-decides", against the SAME bundle the window reads — so a press that says it assigned a
// stage is a press whose window can resolve that stage, and not a second opinion about what the ids mean.
//
// What this pins:
//
//   - the catalogue a control draws: every pipeline in the bundle, its stages IN ORDER with their 1-based position,
//     and the loader's own refusal (with its code and locator) when the bundle is missing or bad — never an empty
//     list that reads like "the bundle holds nothing";
//   - an assignment is one write: a named pipeline and a named stage, stamped with the clock it was given, and the
//     task array is not mutated under the caller;
//   - the SAME pipeline and stage assigned twice is a no-op: the stored `enteredAt` is not rewritten by a second
//     press, because that would silently restart the clock on work that did not move;
//   - a different stage IS a new entry and gets the new stamp;
//   - clearing writes `pipelineRun: null` — the default path — and clearing nothing changes nothing;
//   - every refusal is named (`pipeline-bundle`, `pipeline-id`, `pipeline-stage`) and says what the bundle does
//     hold, so the control can print it rather than guessing;
//   - the stored stamp is what the window reads: after an assignment, `resolveTaskPipeline` reports the stage, its
//     position of N, and the elapsed span against a FIXED later clock — no timer anywhere in this file.
import assert from "node:assert/strict";
import test from "node:test";

import { parseBundle, readBundle } from "../lib/pipeline-bundle.js";
import { resolveTaskPipeline } from "../lib/task-pipeline.js";
import { ASSIGN_FAULTS, assignTaskPipeline, clearTaskPipeline, pipelineCatalogue } from "../lib/task-pipeline-assign.js";

const stage = (n, title) => ({
  id: `S${n}`,
  title: title || `Stage ${n}`,
  prompt: `Do stage ${n}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

const doc = () => ({
  bundleVersion: 1,
  name: "poc-to-uat",
  pipelines: [
    {
      id: "poc-to-uat",
      title: "POC to UAT",
      stages: [stage(1, "Gather the ask"), stage(2, "Scope it"), stage(3, "Shape the contract")],
      gates: [{ id: "g2", name: "contract signed", after: "S2", artifact: "artifact-2", decider: "reader", decision: { id: "d2", path: "decisions/2.json", schema: "decision/1", writer: "gate-2", outcomes: ["go", "no-go"] } }],
      handoffs: [
        { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
      ],
    },
    {
      id: "triage",
      title: "Triage",
      stages: [stage(1, "Read it"), stage(2, "Place it")],
      gates: [],
      handoffs: [{ id: "t1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" }],
    },
  ],
});

const source = () => parseBundle(doc(), { file: "pipeline-bundle.json" });
const AT = new Date("2026-11-03T15:00:00.000Z");

test("the catalogue a control draws: every pipeline, its stages in order, each with its position", () => {
  const c = pipelineCatalogue(source());
  assert.equal(c.ok, true);
  assert.equal(c.name, "poc-to-uat");
  assert.deepEqual(c.pipelines.map((p) => p.id), ["poc-to-uat", "triage"]);
  assert.deepEqual(
    c.pipelines[0].stages.map((s) => [s.id, s.title, s.position]),
    [
      ["S1", "Gather the ask", 1],
      ["S2", "Scope it", 2],
      ["S3", "Shape the contract", 3],
    ],
  );
  assert.deepEqual(c.pipelines[1].stages.map((s) => s.position), [1, 2], "each pipeline's positions start at 1");
  assert.equal(c.pipelines[0].stages[0].prompt, undefined, "the picker is ids and names, not the prompts");
});

test("a bundle that is missing or refused is an ANSWER with the loader's code, not an empty catalogue", () => {
  const missing = pipelineCatalogue(readBundle("C:/nowhere/pipeline-bundle.json"));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "missing");
  assert.match(missing.reason, /no bundle at that path/);
  assert.deepEqual(missing.pipelines, []);

  const bad = pipelineCatalogue(parseBundle("{"));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "not-a-bundle");
  assert.match(bad.reason, /not JSON/);

  const none = pipelineCatalogue(null);
  assert.equal(none.ok, false);
  assert.equal(none.code, ASSIGN_FAULTS.BUNDLE);
  assert.match(none.reason, /no bundle/i);
});

test("assigning writes one record with the clock it was given, and leaves the caller's array alone", () => {
  const tasks = [
    { id: 7, title: "carry the contract", pipelineRun: null },
    { id: 8, title: "unassigned work" },
  ];
  const out = assignTaskPipeline(tasks, 7, { pipeline: "poc-to-uat", stage: "S2", source: source(), at: AT });
  assert.ok(out);
  assert.equal(out.changed, true);
  assert.deepEqual(out.task.pipelineRun, { pipeline: "poc-to-uat", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z" });
  assert.equal(tasks[0].pipelineRun, null, "the caller's record is not mutated");
  assert.deepEqual(tasks[1], { id: 8, title: "unassigned work" }, "another task is untouched");
  assert.equal(out.tasks.length, 2);
  assert.equal(out.tasks[1].pipelineRun, undefined, "no task is retro-assigned by another task's press");
});

test("the same pipeline and stage twice does not rewrite the stored stamp", () => {
  const first = assignTaskPipeline([{ id: 7, title: "t", pipelineRun: null }], 7, { pipeline: "poc-to-uat", stage: "S2", source: source(), at: AT });
  const later = new Date("2026-11-03T18:00:00.000Z");
  const again = assignTaskPipeline(first.tasks, 7, { pipeline: "poc-to-uat", stage: "S2", source: source(), at: later });
  assert.equal(again.changed, false);
  assert.equal(again.task.pipelineRun.enteredAt, "2026-11-03T15:00:00.000Z", "a second press is not a re-entry");
});

test("a different stage is a new entry and gets the new stamp", () => {
  const first = assignTaskPipeline([{ id: 7, title: "t", pipelineRun: null }], 7, { pipeline: "poc-to-uat", stage: "S2", source: source(), at: AT });
  const later = new Date("2026-11-03T18:00:00.000Z");
  const moved = assignTaskPipeline(first.tasks, 7, { pipeline: "poc-to-uat", stage: "S3", source: source(), at: later });
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.task.pipelineRun, { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T18:00:00.000Z" });
  // A move to another pipeline is the same transition, not a special case.
  const other = assignTaskPipeline(moved.tasks, 7, { pipeline: "triage", stage: "S1", source: source(), at: later });
  assert.deepEqual(other.task.pipelineRun, { pipeline: "triage", stage: "S1", enteredAt: "2026-11-03T18:00:00.000Z" });
});

test("re-pressing the same stage on a stamp the window cannot read REPAIRS it, rather than doing nothing", () => {
  // pipeline + stage are held by the bundle, but `enteredAt` is local-time: the window must read unresolved, and the
  // control's apply is the repair. A no-op here would leave a button that says "nothing to do" about a broken record.
  for (const stamp of ["2026-11-03 12:30:00", "", null]) {
    const broken = { id: 7, title: "t", pipelineRun: { pipeline: "poc-to-uat", stage: "S2", enteredAt: stamp } };
    const out = assignTaskPipeline([broken], 7, { pipeline: "poc-to-uat", stage: "S2", source: source(), at: AT });
    assert.equal(out.changed, true, `stamp ${JSON.stringify(stamp)} is rewritten`);
    assert.deepEqual(out.task.pipelineRun, { pipeline: "poc-to-uat", stage: "S2", enteredAt: "2026-11-03T15:00:00.000Z" });
  }
});
test("clearing is the default path: pipelineRun null, and clearing nothing changes nothing", () => {
  const set = assignTaskPipeline([{ id: 7, title: "t", pipelineRun: null }], 7, { pipeline: "poc-to-uat", stage: "S2", source: source(), at: AT });
  const cleared = clearTaskPipeline(set.tasks, 7);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.task.pipelineRun, null);
  assert.equal(cleared.task.title, "t", "nothing else about the record moves");
  const again = clearTaskPipeline(cleared.tasks, 7);
  assert.equal(again.changed, false);
  const never = clearTaskPipeline([{ id: 8, title: "never assigned" }], 8);
  assert.equal(never.changed, false);
  assert.equal(never.task.pipelineRun, null, "clear writes the field's absence as null, the default path");
});

test("an unknown id returns null, the way every queue operation does", () => {
  assert.equal(assignTaskPipeline([{ id: 7, title: "t" }], 99, { pipeline: "poc-to-uat", stage: "S1", source: source(), at: AT }), null);
  assert.equal(clearTaskPipeline([{ id: 7, title: "t" }], 99), null);
});

test("a refused assignment is NAMED and says what the bundle holds", () => {
  const tasks = [{ id: 7, title: "t" }];
  const codeOf = (fn) => {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return null;
  };
  assert.equal(
    codeOf(() => assignTaskPipeline(tasks, 7, { pipeline: "gone-to-uat", stage: "S1", source: source(), at: AT })),
    "pipeline-id",
  );
  try {
    assignTaskPipeline(tasks, 7, { pipeline: "gone-to-uat", stage: "S1", source: source(), at: AT });
  } catch (err) {
    assert.match(err.message, /gone-to-uat/);
    assert.match(err.message, /poc-to-uat, triage/, "the sentence names what the bundle does hold");
  }
  assert.equal(codeOf(() => assignTaskPipeline(tasks, 7, { pipeline: "poc-to-uat", stage: "S99", source: source(), at: AT })), "pipeline-stage");
  try {
    assignTaskPipeline(tasks, 7, { pipeline: "poc-to-uat", stage: "S99", source: source(), at: AT });
  } catch (err) {
    assert.match(err.message, /S1, S2, S3/, "the sentence names the order the pipeline holds");
  }
  assert.equal(codeOf(() => assignTaskPipeline(tasks, 7, { pipeline: "poc-to-uat", stage: "  ", source: source(), at: AT })), "pipeline-stage");
  // No bundle is a refusal, never a silent assignment with nothing behind it.
  assert.equal(codeOf(() => assignTaskPipeline(tasks, 7, { pipeline: "poc-to-uat", stage: "S1", source: readBundle("C:/nowhere/b.json"), at: AT })), "pipeline-bundle");
  assert.equal(codeOf(() => assignTaskPipeline(tasks, 7, { pipeline: "poc-to-uat", stage: "S1", source: null, at: AT })), "pipeline-bundle");
  try {
    assignTaskPipeline(tasks, 7, { pipeline: "poc-to-uat", stage: "S1", source: readBundle("C:/nowhere/b.json"), at: AT });
  } catch (err) {
    assert.match(err.message, /no bundle/i);
  }
});

test("what was written is what the window reads: stage, position of N, elapsed from the stored stamp", () => {
  const out = assignTaskPipeline([{ id: 7, title: "t" }], 7, { pipeline: "poc-to-uat", stage: "S2", source: source(), at: AT });
  const view = resolveTaskPipeline(out.task, { bundle: source().bundle, now: new Date("2026-11-03T16:30:00.000Z") });
  assert.equal(view.mode, "pipeline");
  assert.equal(view.stage, "S2");
  assert.equal(view.stageTitle, "Scope it");
  assert.equal(view.position, 2);
  assert.equal(view.count, 3);
  assert.equal(view.elapsed.ms, 90 * 60 * 1000, "ninety minutes after the stored stamp; the file has no timer");
});
