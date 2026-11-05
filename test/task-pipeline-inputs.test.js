// The input MANIFEST: what a stage was handed, STORED on the stage run and readable back afterwards.
//
// The INPUTS block (lib/task-pipeline-drive.js) has always printed the handoff's artifact, its path and its hash — and
// then the prompt went to an agent and the panel kept nothing. A reader could not answer "what did S2 start with" once
// the run was gone, and neither could a test. This file pins the record:
//
//   1. a stage start writes one entry per artifact instance the document says the stage reads — the handoff it arrived
//      by (with that edge's id), each `inputs.read[]`, and the writer the document names — with the resolved path and
//      the sha256 of the bytes in the tree at that moment;
//   2. reading the manifest back re-resolves `present` from the tree and KEEPS the stored hash, so a file deleted
//      after the stage started reads `present: false` beside the sha256 the stage was given. That pair is the fact a
//      reader needs after the tree has moved, and it is why `present` is not simply re-hashed on read;
//   3. an input the document gives no path for (an external input) is recorded `present: null` — unknown, never
//      "missing" and never a zero-length file;
//   4. the manifest is per VISIT: a second entry into a stage carries its own, and the earlier visit's artifact is
//      named with the hash that visit recorded rather than a fresh reading of the file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { settleStageRun } from "../lib/task-pipeline.js";
import { driveTaskPipelines, inputManifest, stageInputsOf } from "../lib/task-pipeline-drive.js";

const CLOCK = "2026-11-06T09:00:00.000Z";
const LATER = "2026-11-06T09:40:00.000Z";

const CHARTER_BODY = "# charter\n\nThe decision this POC exists to make.\n";
const CHARTER_SHA = createHash("sha256").update(CHARTER_BODY).digest("hex");

// A two-stage document: S0 writes the charter, and S1 reads it BY HANDOFF and also reads an input the document
// declares as external. Both shapes are in one fixture because the manifest has to name both and say which is which.
const DOC = {
  bundleVersion: 1,
  name: "inputs",
  pipelines: [
    {
      id: "poc",
      title: "Poc",
      stages: [
        {
          id: "S0",
          title: "Charter",
          prompt: "Write the charter.",
          artifact: { id: "charter", path: "ledger/charter.md", schema: "charter/1", writer: "steward" },
        },
        {
          id: "S1",
          title: "Read it",
          prompt: "Read the charter.",
          artifact: { id: "plan", path: "out/plan.md", schema: "plan/1", writer: "architect" },
          inputs: { read: [{ artifact: "charter", location: "ledger#C-0001" }, { artifact: "poc-snapshot", location: "checkpoint#POC-0007" }] },
        },
      ],
      gates: [],
      handoffs: [{ id: "H-01", from: "S0", to: "S1", artifact: "charter", kind: "sequence" }],
      external_inputs: [{ artifact: "poc-snapshot", source: "the POC builder's running checkpoint" }],
    },
  ],
};

const parsed = parseBundle(DOC, { file: "inputs.json" });
assert.equal(parsed.ok, true, parsed.reason || "the fixture bundle must parse");
const BUNDLE = parsed.bundle;
const PIPELINE = BUNDLE.pipelines[0];

// A tree that already holds the charter: the row is at S1, so S0's artifact is the input it starts with.
function tree(t, { charter = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-inputs-"));
  if (charter) {
    mkdirSync(path.join(dir, "ledger"), { recursive: true });
    writeFileSync(path.join(dir, "ledger", "charter.md"), CHARTER_BODY);
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const row = (dir, over = {}) => ({
  id: 7,
  title: "carry the inputs",
  detail: "",
  state: "queued",
  thread: null,
  threads: [],
  worktree: dir,
  project: "agent-worktree-gui",
  files: [],
  attempts: 0,
  reason: "",
  hold: null,
  pipelineRun: {
    pipeline: "poc",
    stage: "S1",
    enteredAt: "2026-11-06T08:50:00.000Z",
    visits: { S0: 1, S1: 1 },
    via: "H-01",
    crossings: { "H-01": 1 },
    tree: { path: dir, branch: "wtgui/carry-the-inputs-abc123" },
  },
  ...over,
});

const drive = (tasks, over = {}) =>
  driveTaskPipelines(tasks, { bundle: BUNDLE, jobs: [], isLive: () => false, at: CLOCK, unattended: true, ...over });

test("a stage start stores every input instance it was handed, with path, hash, writer and the edge it arrived by", (t) => {
  const dir = tree(t);
  const out = drive([row(dir)]);
  assert.equal(out.starts.length, 1, "the queued row's stage is the one asked for");

  const task = out.tasks[0];
  const entry = task.pipelineRun.stageRuns.find((run) => run.stage === "S1" && run.visit === 1);
  assert.ok(entry, "the stage run exists");
  assert.ok(Array.isArray(entry.inputs), "the stage run carries a manifest");

  const charter = entry.inputs.find((item) => item.artifact === "charter");
  assert.ok(charter, "the handoff's artifact is one of the instances");
  assert.equal(charter.edge, "H-01", "and the edge it arrived by is the handoff the row crossed");
  assert.equal(charter.via, "handoff");
  assert.equal(charter.path, "ledger/charter.md", "the path is the document's, not a machine path");
  assert.equal(charter.present, true);
  assert.equal(charter.sha256, CHARTER_SHA, "the hash is of the bytes in the tree at the moment the stage started");
  assert.equal(charter.writer, "steward", "the writer is the one the document names");
  // The read of the SAME artifact is the handoff, not a second instance: one file, one edge.
  assert.equal(entry.inputs.filter((item) => item.artifact === "charter").length, 1);

  const snapshot = entry.inputs.find((item) => item.artifact === "poc-snapshot");
  assert.ok(snapshot, "the external input is recorded too");
  assert.equal(snapshot.path, null, "the document gives an external input no path");
  assert.equal(snapshot.present, null, "unknown is not missing: nothing was resolved, so nothing is claimed");
  assert.equal(snapshot.sha256, null);
});

test("a settled stage's manifest reads back with the right sha256 and present:false once the file is gone", (t) => {
  const dir = tree(t);
  const driven = drive([row(dir)]).tasks[0];
  // The run settles — the entry keeps the manifest it was handed, which is the whole point of storing it at the start.
  const settled = settleStageRun(driven, { stage: "S1", status: "done", at: LATER });
  const before = stageInputsOf(settled, { stage: "S1", visit: 1, worktree: dir });
  assert.equal(before.stageRun, "poc/S1#1");
  assert.equal(before.missing.length, 0, "nothing is missing while the tree still holds the file");
  const charterBefore = before.entries.find((item) => item.artifact === "charter");
  assert.equal(charterBefore.present, true);
  assert.equal(charterBefore.sha256, CHARTER_SHA);

  // The tree moves after the stage ran. `present` is a fact about the filesystem and is re-resolved; the hash is what
  // the stage was handed and stays, or a reader could never say WHAT it started with, only that it is gone now.
  unlinkSync(path.join(dir, "ledger", "charter.md"));
  const after = stageInputsOf(settled, { stage: "S1", visit: 1, worktree: dir });
  const charterAfter = after.entries.find((item) => item.artifact === "charter");
  assert.equal(charterAfter.present, false, "the file is gone, and the manifest says so");
  assert.equal(charterAfter.sha256, CHARTER_SHA, "the hash the stage was given is not lost with the file");
  assert.deepEqual(after.missing, ["charter"]);
  // The external input is still unknown, never swept into `missing`.
  assert.equal(after.entries.find((item) => item.artifact === "poc-snapshot").present, null);

  // An entry written before this record existed answers "nothing recorded", never "the stage read nothing" — and a
  // record with no entry at all is no manifest rather than an empty one.
  const bare = {
    id: 9,
    pipelineRun: { pipeline: "poc", stage: "S1", enteredAt: CLOCK, visits: { S1: 1 }, tree: { path: dir }, stageRuns: [{ id: "poc/S1#1", stage: "S1", visit: 1, at: CLOCK, status: "done" }] },
  };
  assert.deepEqual(stageInputsOf(bare, { stage: "S1", worktree: dir }).entries, []);
  assert.equal(stageInputsOf({ id: 10, pipelineRun: { pipeline: "poc", stage: "S1", enteredAt: CLOCK, visits: { S1: 1 } } }, { stage: "S1" }), null);
});

test("a second visit names the earlier visit's artifact with the hash that visit recorded", (t) => {
  const dir = tree(t);
  const run = {
    pipeline: "poc",
    stage: "S1",
    enteredAt: CLOCK,
    visits: { S0: 1, S1: 2 },
    via: "H-01",
    tree: { path: dir },
    stageRuns: [
      {
        id: "poc/S1#1",
        stage: "S1",
        visit: 1,
        at: "2026-11-06T08:00:00.000Z",
        artifact: { id: "plan", path: "out/plan.md", present: true, sha256: "9".repeat(64) },
      },
    ],
  };
  const manifest = inputManifest({ pipeline: PIPELINE, stage: PIPELINE.stages[1], run, worktree: dir, visit: 2 });
  const earlier = manifest.entries.find((item) => item.via === "earlier");
  assert.ok(earlier, "the earlier visit's artifact is named");
  assert.equal(earlier.artifact, "plan");
  assert.equal(earlier.sha256, "9".repeat(64), "the hash is the earlier visit's record, not a new reading of a file that is gone");
  assert.equal(manifest.dropped, 0);
});
