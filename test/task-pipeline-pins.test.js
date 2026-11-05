// A stage's handoff is PINNED to a commit and a blob — never to a branch.
//
// The INPUTS block used to name the artifact, its path and the sha256 of whatever bytes were checked out at the
// moment the next stage asked. That is a reading of a BRANCH wearing a file's name: resolve it again tomorrow and it
// can be a different tree, and no record survives to say which one the stage was handed. This file pins the record:
//
//   1. a stage that settles records its tree's COMMIT, full-length, on the stage run, and its artifact records the
//      commit, the blob's object id and the sha256 of the BLOB's own bytes;
//   2. the next stage's INPUTS block names that SHA (and where to read it) instead of a branch;
//   3. a branch that moves AFTER the settle does not change the recorded input — the entry still names the commit the
//      writer settled at, and a fresh start is handed that commit, not the new tip;
//   4. a recorded commit this tree cannot resolve PARKS (`pipeline-refuse-input`) rather than reading a different
//      tree — the moved branch that is not a fast-forward is a refusal, not a silent substitution.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { DRIVE_FAULTS, driveTaskPipelines, stagePrompt } from "../lib/task-pipeline-drive.js";

const CLOCK = "2026-11-06T12:00:00.000Z";
const LATER = "2026-11-06T12:20:00.000Z";

const ARTIFACT_BODY = JSON.stringify({ stage: 1 });

const DOC = {
  bundleVersion: 1,
  name: "pins",
  pipelines: [
    {
      id: "pin",
      title: "Pin",
      stages: [
        { id: "S1", title: "Write", prompt: "Write the artifact.", artifact: { id: "artifact-1", path: "out/1.json", schema: "out/1", writer: "worker-1" } },
        { id: "S2", title: "Read", prompt: "Read the artifact.", artifact: { id: "artifact-2", path: "out/2.json", schema: "out/2", writer: "worker-2" } },
      ],
      gates: [],
      handoffs: [{ id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" }],
    },
  ],
};

const parsed = parseBundle(DOC, { file: "pins.json" });
assert.equal(parsed.ok, true, parsed.reason || "the fixture bundle must parse");
const BUNDLE = parsed.bundle;
const PIPELINE = BUNDLE.pipelines[0];

// A real repository, because the pin is a git reading and a fixture that fakes it proves nothing. `out/1.json` is
// committed, so S1's artifact is in the commit the stage settled at.
function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-pin-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const write = (rel, body) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  git("init", "-q");
  git("config", "user.email", "pin@example.test");
  git("config", "user.name", "Pin Fixture");
  git("config", "core.autocrlf", "false");
  write("out/1.json", ARTIFACT_BODY);
  git("add", "-A");
  git("commit", "-qm", "S1 writes its artifact");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, git, write };
}

const row = (dir, over = {}) => ({
  id: 1,
  title: "pin the handoff",
  detail: "",
  state: "running",
  thread: "T1",
  threads: ["T1"],
  worktree: dir,
  project: "agent-worktree-gui",
  files: [],
  attempts: 0,
  reason: "",
  hold: null,
  pipelineRun: { pipeline: "pin", stage: "S1", enteredAt: "2026-11-06T11:00:00.000Z", tree: { path: dir, branch: "wtgui/pin-the-handoff-abc123" } },
  ...over,
});

const done = [{ id: "j1", thread: "T1", status: "done", startedAt: "2026-11-06T11:00:00.000Z", endedAt: "2026-11-06T11:30:00.000Z" }];

const drive = (tasks, over = {}) =>
  driveTaskPipelines(tasks, { bundle: BUNDLE, jobs: [], isLive: () => false, at: CLOCK, unattended: true, ...over });

test("a settled stage records its commit, and its artifact records the commit, the blob and the blob's sha256", (t) => {
  const { dir, git } = repo(t);
  const head = git("rev-parse", "HEAD");
  const blob = git("rev-parse", "HEAD:out/1.json");
  const blobSha = createHash("sha256").update(ARTIFACT_BODY).digest("hex");

  const out = drive([row(dir)], { jobs: done });
  assert.equal(out.changed[0].stage, "S2", "the stage advanced");

  const settled = out.tasks[0].pipelineRun.stageRuns.find((entry) => entry.stage === "S1");
  assert.equal(settled.commit, head, "the stage run records the FULL commit it settled at, not a short sha");
  assert.equal(settled.artifact.commit, head);
  assert.equal(settled.artifact.blob, blob, "the artifact records the blob's object id");
  assert.equal(settled.artifact.blobSha256, blobSha, "and the sha256 of the BLOB's bytes, not of the checkout");
  assert.equal(settled.artifact.sha256, blobSha, "with a clean checkout the working hash agrees — this fixture is clean");
  assert.equal(settled.artifact.uncommitted, undefined);
});

test("the next stage's INPUTS block names that SHA and where to read it, never a branch", (t) => {
  const { dir, git } = repo(t);
  const head = git("rev-parse", "HEAD");
  const blob = git("rev-parse", "HEAD:out/1.json");

  const out = drive([row(dir)], { jobs: done });
  assert.equal(out.starts.length, 1, "S2 is started in the same pass");
  const prompt = out.starts[0].prompt;
  assert.match(prompt, new RegExp(`handed on {3}artifact-1 {3}out/1\\.json {3}commit ${head.slice(0, 12)} {3}blob ${blob.slice(0, 12)} {3}sha256 `));
  assert.match(prompt, new RegExp(`read it at ${head.slice(0, 12)}:out/1\\.json`), "the worker is told the commit and the path to read");
  assert.doesNotMatch(prompt, /handed on[^\n]*wtgui\//, "the handoff is not identified by the branch it happens to sit on");

  // The manifest written with the start is the same fact STORED, so a reader after the run sees what the worker did.
  const entry = out.tasks[0].pipelineRun.stageRuns.find((run) => run.stage === "S2");
  const charter = entry.inputs.find((item) => item.artifact === "artifact-1");
  assert.equal(charter.commit, head);
  assert.equal(charter.blob, blob);
  assert.equal(charter.via, "handoff");
});

test("a branch that moves after the settle does not change the recorded input, or what the next stage is handed", (t) => {
  const { dir, git, write } = repo(t);
  const head = git("rev-parse", "HEAD");
  const first = drive([row(dir)], { jobs: done });
  const recorded = first.tasks[0].pipelineRun.stageRuns.find((entry) => entry.stage === "S1").artifact;
  assert.equal(recorded.commit, head);

  // The branch moves: a new commit changes the same file. A row that read "the branch" would now be handed other
  // bytes; the pin still names the commit the writer settled at.
  write("out/1.json", JSON.stringify({ stage: 1, revised: true }));
  git("add", "-A");
  git("commit", "-qm", "a later commit on the branch");
  const moved = git("rev-parse", "HEAD");
  assert.notEqual(moved, head);

  const second = drive([first.tasks[0]], { jobs: [], at: LATER });
  assert.equal(second.tasks[0].state, "queued", "the row is not parked by a branch that moved forward");
  assert.equal(second.starts.length, 1, "and the stage starts");
  assert.match(second.starts[0].prompt, new RegExp(`commit ${head.slice(0, 12)}`), "the prompt still names the writer's commit");
  assert.match(second.starts[0].prompt, /the working file has moved off the pin — read the blob, not the checkout/);

  const again = second.tasks[0].pipelineRun.stageRuns.find((entry) => entry.stage === "S1").artifact;
  assert.equal(again.commit, head, "the record is not rewritten by a later commit");
  assert.equal(again.blob, recorded.blob);
});

test("a recorded commit this tree cannot resolve parks pipeline-refuse-input, naming the commit and the branch", (t) => {
  const { dir } = repo(t);
  const missing = "f".repeat(40);
  const run = {
    pipeline: "pin",
    stage: "S2",
    enteredAt: CLOCK,
    visits: { S1: 1, S2: 1 },
    via: "h1",
    tree: { path: dir, branch: "wtgui/pin-the-handoff-abc123" },
    stageRuns: [
      {
        id: "pin/S1#1",
        stage: "S1",
        visit: 1,
        at: CLOCK,
        status: "done",
        commit: missing,
        artifact: { id: "artifact-1", path: "out/1.json", present: true, sha256: "a".repeat(64), commit: missing, blob: "b".repeat(40), blobSha256: "a".repeat(64) },
      },
      { id: "pin/S2#1", stage: "S2", visit: 1, at: CLOCK, status: null, decision: null },
    ],
  };

  const out = drive([row(dir, { state: "queued", thread: null, threads: [], pipelineRun: run })], { jobs: [] });
  assert.equal(out.tasks[0].state, "parked", "the row stops instead of reading a different tree");
  assert.equal(out.changed[0].code, DRIVE_FAULTS.REFUSE_INPUT);
  assert.equal(out.starts.length, 0, "nothing is started");
  const decision = out.tasks[0].pipelineRun.stageRuns.at(-1).decision;
  assert.equal(decision.fact.kind, "input");
  assert.equal(decision.fact.commit, missing);
  assert.match(decision.reason, /pinned to commit f{12}/);
  assert.match(decision.reason, /not in this tree/);
  assert.match(decision.reason, /refuses the input rather than reading a different tree/);
});

test("a stage run with no commit (a record from before the pin) is not parked, and says so", (t) => {
  const { dir } = repo(t);
  const run = {
    pipeline: "pin",
    stage: "S2",
    enteredAt: CLOCK,
    visits: { S1: 1, S2: 1 },
    via: "h1",
    tree: { path: dir },
    stageRuns: [{ id: "pin/S1#1", stage: "S1", visit: 1, at: CLOCK, status: "done", artifact: { id: "artifact-1", path: "out/1.json", present: true, sha256: "a".repeat(64) } }],
  };
  const out = drive([row(dir, { state: "queued", thread: null, threads: [], pipelineRun: run })], { jobs: [] });
  assert.equal(out.tasks[0].state, "queued", "a record that could not have carried the fact is not a refusal");
  assert.equal(out.starts.length, 1);
  const prompt = stagePrompt(out.tasks[0], PIPELINE, PIPELINE.stages[1], { run: out.tasks[0].pipelineRun, facts: null });
  assert.match(prompt, /commit \(none recorded\)/);
});
