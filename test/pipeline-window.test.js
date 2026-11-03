// The task pipeline WINDOW's data — lib/pipeline-window.js's pure half.
//
// The contract in lib/pipeline-bundle.js says what a bundle holds and lib/task-pipeline.js says where one task sits in
// it. This module answers the one question the window asks: given the task and the bundle as they are, what does the
// reader see, in order, and on what evidence? Six things are driven here, each against a FIXED clock:
//
//   1. a task on stage 3 of 5 lists all five stages, in the bundle's order, with the first two marked `before`, the
//      current one `current` and the rest `after`. The current stage's name, its `position of count`, and the timestamp
//      it began are the evidence — never "stage 3" alone;
//   2. the gate that ENDED the previous stage is named on the previous stage (a gate follows the stage it ends), and
//      `previous.gate` is that same record — including the artifact the decision is written to and its outcomes. Where
//      the bundle has no gate between them, `previous.gate` is null and the handoff that joined them is named instead:
//      "no gate" is a fact about the bundle, not a blank;
//   3. a task with no `pipelineRun` reads assistant-decides, and the window carries no stages at all — not the default
//      pipeline's;
//   4. a record naming a pipeline the bundle does not hold, or a stage its pipeline does not hold, reads `unresolved`
//      with the reason, and NEVER falls back to assistant-decides. A stage that is gone still gets the pipeline's
//      sequence, drawn unplaced, so the reader can see what the record was pointing at;
//   5. elapsed time is computed from the stored `enteredAt` and the `now` it was asked with: an hour later the same
//      record reads an hour more, with the same `enteredAt` — that is what makes the window right after the panel was
//      closed for an hour, and it is proved here rather than by waiting;
//   6. a bundle that is absent or refused reaches the window as a refusal with its own code and sentence, so the
//      dialog can say why it has nothing to draw instead of reporting the task as unresolved for the wrong reason.
import assert from "node:assert/strict";
import test from "node:test";

import { parseBundle, readBundle } from "../lib/pipeline-bundle.js";
import { TASK_PIPELINE_FIELD } from "../lib/task-pipeline.js";
import { buildTaskPipelineWindow } from "../lib/pipeline-window.js";

const stage = (n) => ({
  id: `S${n}`,
  title: ["Gather the ask", "Scope it", "Shape the contract", "Build it", "Hand it over"][n - 1] || `Stage ${n}`,
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
      stages: [stage(1), stage(2), stage(3), stage(4), stage(5)],
      gates: [
        {
          id: "g1",
          name: "scope agreed",
          after: "S1",
          artifact: "artifact-1",
          decider: "reader",
          decision: { id: "d1", path: "decisions/1.json", schema: "decision/1", writer: "gate-1", outcomes: ["go", "no-go"] },
        },
        {
          id: "g2",
          name: "contract signed",
          after: "S2",
          artifact: "artifact-2",
          decider: "reader",
          decision: { id: "d2", path: "decisions/2.json", schema: "decision/1", writer: "gate-2", outcomes: ["go", "no-go"] },
        },
      ],
      handoffs: [
        { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
        { id: "h3", from: "S3", to: "S4", artifact: "artifact-3", kind: "sequence" },
        { id: "h4", from: "S4", to: "S5", artifact: "artifact-4", kind: "sequence" },
      ],
    },
  ],
});

const source = () => parseBundle(doc());

// 15:00Z on the day the task entered S3, so every elapsed number below is a subtraction, not a sleep.
const NOW = new Date("2026-11-03T15:00:00.000Z");
const ENTERED = "2026-11-03T12:30:00.000Z";
const task = (extra = {}) => ({ id: 7, title: "carry the contract", state: "running", [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: ENTERED }, ...extra });
const build = (t = task(), opts = {}) => buildTaskPipelineWindow(t, { source: source(), now: NOW, ...opts });

test("a task on stage 3 of 5 lists every stage in order, marking what is before, now and after", () => {
  const w = build();
  assert.equal(w.mode, "pipeline");
  assert.equal(w.ok, true);
  assert.equal(w.pipeline.id, "poc-to-uat");
  assert.equal(w.pipeline.title, "POC to UAT");
  assert.equal(w.count, 5);
  assert.equal(w.current.id, "S3");
  assert.equal(w.current.title, "Shape the contract");
  assert.equal(w.current.position, 3);
  assert.deepEqual(w.stages.map((s) => s.id), ["S1", "S2", "S3", "S4", "S5"]);
  assert.deepEqual(w.stages.map((s) => s.position), [1, 2, 3, 4, 5]);
  assert.deepEqual(w.stages.map((s) => s.phase), ["before", "before", "current", "after", "after"]);
  // The evidence a reader needs instead of an index: the name, the position of N, the stamp.
  assert.equal(w.enteredAt, ENTERED);
  assert.equal(w.stages[2].title, "Shape the contract");
  assert.equal(w.stages[0].title, "Gather the ask");
  assert.equal(w.stages[4].title, "Hand it over");
  assert.equal(w.stages[0].artifact.path, "out/1.json");
  assert.equal(w.stages[4].artifact.writer, "worker-5");
});

test("the gate that ended the previous stage is named, with the artifact its decision is written to", () => {
  const w = build();
  assert.equal(w.previous.stage.id, "S2");
  assert.equal(w.previous.stage.position, 2);
  assert.equal(w.previous.gate.id, "g2");
  assert.equal(w.previous.gate.name, "contract signed");
  assert.equal(w.previous.gate.artifact, "artifact-2");
  assert.equal(w.previous.gate.decision.path, "decisions/2.json");
  assert.deepEqual(w.previous.gate.decision.outcomes, ["go", "no-go"]);
  // The same record on the stage itself, so every row can draw the gate that ends IT.
  assert.equal(w.stages[1].gateEnding.id, "g2");
  assert.equal(w.stages[0].gateEnding.id, "g1");
  assert.equal(w.stages[0].gateEnding.name, "scope agreed");
  // The current stage has not ended, and neither have the later ones.
  assert.equal(w.stages[2].gateEnding, null);
  assert.equal(w.stages[3].gateEnding, null);
  assert.equal(w.stages[4].gateEnding, null);
});

test("where the bundle has no gate between two stages, the window says so and names the handoff", () => {
  const bare = doc();
  bare.pipelines[0].gates = [];
  const w = buildTaskPipelineWindow(task(), { source: parseBundle(bare), now: NOW });
  assert.equal(w.mode, "pipeline");
  assert.equal(w.previous.gate, null, "no gate follows S2 in this bundle");
  assert.equal(w.previous.handoff.id, "h2");
  assert.equal(w.previous.handoff.from, "S2");
  assert.equal(w.previous.handoff.to, "S3");
  assert.equal(w.previous.handoff.artifact, "artifact-2");
  assert.equal(w.stages[1].gateEnding, null);
});

test("a task with no pipeline reads assistant-decides and carries no stages", () => {
  for (const record of [{ id: 8, title: "unassigned" }, { id: 9, title: "null run", [TASK_PIPELINE_FIELD]: null }]) {
    const w = buildTaskPipelineWindow(record, { source: source(), now: NOW });
    assert.equal(w.mode, "assistant-decides");
    assert.equal(w.ok, true);
    assert.deepEqual(w.stages, []);
    assert.equal(w.current, null);
    assert.equal(w.previous, null);
    assert.equal(w.pipeline, null);
    assert.equal(w.enteredAt, null);
    assert.equal(w.elapsed, null);
    assert.match(w.reason, /assistant decides/);
  }
});

test("a pipeline the bundle no longer holds is unresolved with the reason, never assistant-decides", () => {
  const w = build(task({ [TASK_PIPELINE_FIELD]: { pipeline: "gone-to-uat", stage: "S3", enteredAt: ENTERED } }));
  assert.equal(w.mode, "unresolved");
  assert.equal(w.ok, false);
  assert.equal(w.current, null);
  assert.deepEqual(w.stages, []);
  assert.equal(w.unresolved.kind, "pipeline");
  assert.match(w.reason, /"gone-to-uat"/);
  assert.match(w.reason, /poc-to-uat/, "the reason says what the bundle does hold");
});

test("a stage the pipeline no longer holds is unresolved, and the sequence is still drawn unplaced", () => {
  const w = build(task({ [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S9", enteredAt: ENTERED } }));
  assert.equal(w.mode, "unresolved");
  assert.equal(w.ok, false);
  assert.equal(w.unresolved.kind, "stage");
  assert.equal(w.pipeline.id, "poc-to-uat", "the pipeline itself is still named");
  assert.equal(w.current, null);
  assert.deepEqual(w.stages.map((s) => s.id), ["S1", "S2", "S3", "S4", "S5"]);
  assert.deepEqual(w.stages.map((s) => s.phase), ["unplaced", "unplaced", "unplaced", "unplaced", "unplaced"]);
  assert.match(w.reason, /"S9"/);
  assert.match(w.reason, /S1, S2, S3, S4, S5/, "the reason names the order the pipeline does hold");
});

test("a written record that is not an assignment is unresolved, not assistant-decides", () => {
  for (const run of ["poc-to-uat", 7, { stage: "S3" }, {}]) {
    const w = build(task({ [TASK_PIPELINE_FIELD]: run }));
    assert.equal(w.mode, "unresolved", JSON.stringify(run));
    assert.equal(w.unresolved.kind, "record", JSON.stringify(run));
    assert.match(w.reason, /pipelineRun/);
  }
});

test("a local-time stamp is refused by the contract's own reason, and the window keeps it", () => {
  const w = build(task({ [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03 12:30:00" } }));
  assert.equal(w.mode, "unresolved");
  assert.equal(w.unresolved.kind, "enteredAt");
  assert.match(w.reason, /not a UTC instant/);
  assert.equal(w.enteredAt, "2026-11-03 12:30:00");
});

test("elapsed time is the stored stamp against the clock it is asked with — an hour later is an hour more", () => {
  const open = build();
  assert.equal(open.elapsed.ok, true);
  assert.equal(open.elapsed.ms, 9_000_000, "12:30Z to 15:00Z");
  assert.equal(open.elapsed.future, false);
  assert.equal(open.computedAt, NOW.toISOString());

  // The panel was closed for an hour: same record, same enteredAt, one hour later on the clock.
  const later = buildTaskPipelineWindow(task(), { source: source(), now: new Date(NOW.getTime() + 3_600_000) });
  assert.equal(later.enteredAt, open.enteredAt);
  assert.equal(later.elapsed.ms, 12_600_000, "and the display moves by exactly the hour the panel spent closed");
  assert.equal(later.stages[2].phase, "current", "a closed panel moves no stage");
});

test("a stamp ahead of the clock reads zero and says it is ahead", () => {
  const w = buildTaskPipelineWindow(task({ [TASK_PIPELINE_FIELD]: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T15:00:04.000Z" } }), { source: source(), now: NOW });
  assert.equal(w.mode, "pipeline");
  assert.equal(w.elapsed.ms, 0);
  assert.equal(w.elapsed.future, true);
});

test("an absent bundle is a refusal the window can name", () => {
  const w = buildTaskPipelineWindow(task(), { source: readBundle(`${process.cwd()}/no-such-bundle-anywhere.json`), now: NOW });
  assert.equal(w.mode, "unresolved");
  assert.equal(w.unresolved.kind, "bundle");
  assert.equal(w.bundle.ok, false);
  assert.equal(w.bundle.code, "missing");
  assert.match(w.reason, /no-such-bundle-anywhere\.json/);
});

test("a bundle that was refused reaches the window with its own code, sentence and locator", () => {
  const broken = parseBundle('{"bundleVersion": 1, "pipelines": [');
  const w = buildTaskPipelineWindow(task(), { source: broken, now: NOW });
  assert.equal(w.bundle.ok, false);
  assert.equal(w.bundle.code, "not-a-bundle");
  assert.equal(w.mode, "unresolved");
  assert.equal(w.unresolved.kind, "bundle");
  assert.match(w.reason, /not JSON/);

  const badStage = doc();
  badStage.pipelines[0].stages[3] = { id: "S4", title: "Build it" }; // no prompt, no artifact
  const refused = parseBundle(badStage);
  const w2 = buildTaskPipelineWindow(task(), { source: refused, now: NOW });
  assert.equal(w2.bundle.code, "incomplete-stage");
  assert.match(w2.bundle.where, /stages\[3\]/, "the locator is the file's own path");
});

test("no bundle read at all is said plainly, not blamed on the task", () => {
  const w = buildTaskPipelineWindow(task(), { source: null, now: NOW });
  assert.equal(w.mode, "unresolved");
  assert.equal(w.unresolved.kind, "bundle");
  assert.equal(w.bundle.ok, false);
  assert.match(w.reason, /no bundle/);
});

test("the window is a value: the task record it was given is untouched and the model is JSON-safe", () => {
  const record = task();
  const before = JSON.stringify(record);
  const w = buildTaskPipelineWindow(record, { source: source(), now: NOW });
  assert.equal(JSON.stringify(record), before, "the record the panel is holding is not mutated");
  assert.deepEqual(JSON.parse(JSON.stringify(w)), w, "the model crosses the route as it was built");
});
