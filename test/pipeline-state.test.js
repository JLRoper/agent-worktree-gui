// The pipeline state printer: one row's `pipelineRun`, read as the panel reads it.
//
// What this file is the contract for:
//
//   1. THE RECORD IS READ, NOT RE-DERIVED. A row is resolved against the bundle through lib/task-pipeline.js, so the
//      tool and the window cannot disagree about which stage a row is in, how long it has stood there, or why a
//      record is unresolved.
//   2. A STAGE WITH NO TREE IS `needed`, and the report says the cut is owed. The one thing a reader must not do is
//      start that stage in `pipelineRun.tree` (the round's landing branch), in the previous stage's tree, or in the
//      project checkout.
//   3. A STAGE THAT ADVANCED WITH NO TREE CUT IS NAMED. That is the #260 shape: the stage run's entry carries a tree
//      while `pipelineRun.trees[stage]` was never written, so the stage stood in a directory the round never gave it.
//   4. THE STAGE'S ARTIFACT AND ITS GATE'S VERDICT PATH ARE PRINTED with the one step each reader owns: the seat
//      writes them, the panel never does.
//   5. A DONE ROW OWES NOTHING, whatever its ledger's last entry says.
//   6. A FINISHED ROUND OWES ITS ASSEMBLY, and the line names the branch that lands rather than a stage branch.
//   7. NO EM OR EN DASH reaches the text: the panel's journal and cards are read through tools that treat them as
//      noise (the same rule test/land-subject-dashes.test.js polices for a landing subject).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseBundle } from "../lib/pipeline-bundle.js";
import {
  findRows,
  owedLines,
  parseArgs,
  pipelineStateOf,
  renderPipelineState,
  spanText,
} from "../tools/pipeline-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "tools", "pipeline-state.mjs");
const ISO = "2026-11-09T06:00:00.000Z";
const LATER = Date.parse("2026-11-09T06:30:00.000Z");

const DOC = {
  bundleVersion: 1,
  name: "state-fixture",
  pipelines: [
    {
      id: "two-step",
      title: "Two step",
      stages: [
        {
          id: "draft",
          title: "Draft",
          prompt: "write it",
          artifact: { id: "draft", path: "ledger/draft.md", schema: "draft/1", writer: "drafter" },
        },
        {
          id: "critique",
          title: "Critique",
          prompt: "read it",
          artifact: { id: "notes", path: "ledger/notes.md", schema: "notes/1", writer: "critic" },
        },
      ],
      handoffs: [
        { id: "H-01", from: "draft", to: "critique", artifact: "draft", kind: "sequence" },
        { id: "H-02", from: "critique", to: "draft", artifact: "notes", kind: "loop", cap: "3 rounds" },
      ],
      gates: [
        {
          id: "G1",
          name: "Draft verdict",
          after: "draft",
          artifact: "draft",
          decider: "critic",
          decision: {
            id: "draft-verdict",
            path: "ledger/verdict.json",
            schema: "verdict/1",
            writer: "critic",
            outcomes: ["pass", "fail"],
            routes: { pass: "H-01", fail: null },
          },
        },
      ],
    },
  ],
};

const source = parseBundle(JSON.stringify(DOC), { file: "state-fixture.json" });
assert.equal(source.ok, true, source.reason);
const BUNDLE = source.bundle;

const made = [];
function tempDir(prefix = "pipeline-state-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function worktree(files = {}) {
  const dir = tempDir();
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  return dir;
}

function task(over = {}) {
  return { id: 1, title: "a row", state: "running", project: "fixture", pipelineRun: null, ...over };
}

function record(over = {}) {
  return {
    pipeline: "two-step",
    stage: "draft",
    enteredAt: ISO,
    visits: { draft: 1 },
    stageRuns: [],
    ...over,
  };
}

// ---- the report's own vocabulary -------------------------------------------------------------------------------

test("spanText reads seconds, minutes and hours without inventing a field", () => {
  assert.equal(spanText(4200), "4s");
  assert.equal(spanText(728000), "12m 08s");
  assert.equal(spanText(4784000), "1h 19m 44s");
  assert.equal(spanText(NaN), "");
});

test("parseArgs takes one id, the four options and nothing else", () => {
  const opts = parseArgs(["260", "--assistant", "assistant-1", "--json", "--now", ISO, "--state-dir", "x", "--bundle", "y"]);
  assert.equal(opts.id, 260);
  assert.equal(opts.assistantId, "assistant-1");
  assert.equal(opts.json, true);
  assert.equal(opts.now, ISO);
  assert.equal(opts.stateDir, "x");
  assert.equal(opts.bundle, "y");
  assert.throws(() => parseArgs(["260", "--nope"]), /unknown argument/);
});

// ---- no record, and a closed row -------------------------------------------------------------------------------

test("a row with no pipelineRun reads assistant-decides and owes nothing to the pipeline", () => {
  const state = pipelineStateOf(task(), { bundle: BUNDLE, now: LATER });
  assert.equal(state.resolution.mode, "assistant-decides");
  const lines = owedLines(state).join("\n");
  assert.match(lines, /nothing to drive/);
  assert.doesNotMatch(lines, /#260/);
});

test("a done row owes nothing, whatever its ledger's last entry says", () => {
  const state = pipelineStateOf(
    task({
      state: "done",
      doneAt: ISO,
      reason: "landed",
      pipelineRun: record({
        stageRuns: [{ id: "two-step/draft#1", stage: "draft", visit: 1, at: ISO, status: "done" }],
      }),
    }),
    { bundle: BUNDLE, now: LATER },
  );
  const lines = owedLines(state).join("\n");
  assert.match(lines, /the row is done/);
  assert.match(lines, /nothing is owed/);
});

// ---- the tree the stage stands in ------------------------------------------------------------------------------

test("a stage with no tree is needed, and the report says the cut is owed", () => {
  const state = pipelineStateOf(
    task({
      state: "queued",
      pipelineRun: record({
        stage: "critique",
        visits: { critique: 1 },
        round: { parent: "wtgui/a-row-a1b2c3", sha: "9f3c1a2d4e5f", slug: "a-row", tag: "a1b2c3" },
      }),
    }),
    { bundle: BUNDLE, now: LATER },
  );
  assert.equal(state.tree.needed, true);
  assert.equal(state.uncut, null);
  const lines = owedLines(state).join("\n");
  assert.match(lines, /NO TREE yet/);
  assert.match(lines, /#260 stall/);
  const report = renderPipelineState(state);
  assert.match(report, /NOT CUT/);
});

test("a stage that advanced with no tree cut is named, and its artifact park is readable", () => {
  const wrong = worktree({ "ledger/change-set.patch": "diff --git a/x b/x\n" });
  const state = pipelineStateOf(
    task({
      state: "parked",
      hold: { kind: "manual", value: "", since: ISO },
      reason: "stage critique settled - its artifact notes (ledger/notes.md) is not in the tree",
      pipelineRun: record({
        stage: "critique",
        visits: { critique: 1 },
        round: { parent: "main", sha: "f0b80c7d7448" },
        stageRuns: [
          {
            id: "two-step/critique#1",
            stage: "critique",
            visit: 1,
            at: ISO,
            status: "done",
            thread: "wtgui-wrong-tree",
            job: "2d10dc35",
            tree: { path: wrong, branch: "wtgui/a-row-a1b2c3" },
            artifact: { id: "notes", path: "ledger/notes.md", present: false },
            decision: {
              by: "panel",
              trigger: "artifact-missing",
              code: "pipeline-artifact",
              at: ISO,
              fact: { kind: "artifact", id: "notes", path: "ledger/notes.md", present: false, handoff: "H-01" },
              reason: "stage critique settled - its artifact notes (ledger/notes.md) is not in the tree",
            },
          },
        ],
      }),
    }),
    { bundle: BUNDLE, now: LATER },
  );
  assert.ok(state.uncut, "the missing cut is a value, not a sentence a reader has to reconstruct");
  assert.equal(state.uncut.stage, "critique");
  assert.equal(state.uncut.path, wrong);
  const lines = owedLines(state).join("\n");
  assert.match(lines, /advanced with no tree of its own/);
  assert.match(lines, /#260 stall/);
  assert.match(lines, /write it, commit it in the stage's own tree/);
  const report = renderPipelineState(state);
  assert.match(report, /pipelineRun\.trees\["critique"\] is absent/);
  assert.doesNotMatch(report, /[\u2013\u2014]/, "no em or en dash in the report");
});

// ---- what the stage owes: its artifact and its gate's verdict ---------------------------------------------------

test("the stage's artifact and the gate's verdict path are printed, and the verdict is read", () => {
  const dir = worktree({
    "ledger/draft.md": "# draft\n",
    "ledger/verdict.json": JSON.stringify({ outcome: "pass" }),
  });
  const state = pipelineStateOf(
    task({
      pipelineRun: record({
        round: { parent: "wtgui/a-row-a1b2c3", sha: "9f3c1a2d4e5f", slug: "a-row", tag: "a1b2c3" },
        trees: { draft: { path: dir, branch: "wtgui/a-row-a1b2c3", cutAt: ISO, by: "panel" } },
        stageRuns: [{ id: "two-step/draft#1", stage: "draft", visit: 1, at: ISO, thread: "wtgui-draft", job: "abc123" }],
      }),
    }),
    { bundle: BUNDLE, now: LATER },
  );
  assert.equal(state.artifactCheck.present, true);
  assert.equal(state.verdict.outcome, "pass");
  assert.equal(state.verdict.found, true);
  const lines = owedLines(state).join("\n");
  assert.match(lines, /owes the gate's verdict at ledger\/verdict\.json/);
  assert.match(lines, /pass \| fail/);
  const report = renderPipelineState(state);
  assert.match(report, /artifact draft at ledger\/draft\.md/);
  assert.match(report, /gate G1 \(Draft verdict\) after draft reads ledger\/verdict\.json/);
  assert.match(report, /pass -> H-01, fail -> end/);
  assert.match(report, /verdict "pass"/);
});

// ---- the round's end: the assembly is the branch that lands -----------------------------------------------------

test("a finished round owes its assembly, not a hand-rolled merge", () => {
  const dir = worktree();
  const state = pipelineStateOf(
    task({
      state: "running",
      pipelineRun: record({
        stage: "critique",
        visits: { draft: 1, critique: 1 },
        round: { parentPath: dir, parent: "wtgui/a-row-a1b2c3", slug: "a-row", tag: "a1b2c3", base: "origin/main", sha: "9f3c1a2d4e5f" },
        trees: {
          draft: { path: dir, branch: "wtgui/a-row-stage-1-draft-111111", cutAt: ISO, by: "panel" },
          critique: { path: dir, branch: "wtgui/a-row-stage-2-critique-222222", cutAt: ISO, by: "panel" },
        },
        stageRuns: [
          { id: "two-step/draft#1", stage: "draft", visit: 1, at: ISO, status: "done", settledAt: ISO, commit: "a".repeat(40), tree: { path: dir } },
          { id: "two-step/critique#1", stage: "critique", visit: 1, at: ISO, status: "done", settledAt: ISO, commit: "b".repeat(40), tree: { path: dir } },
        ],
      }),
    }),
    { bundle: BUNDLE, now: LATER },
  );
  assert.equal(state.over, true);
  assert.equal(state.assemblyPlan.offered, true);
  assert.equal(state.assemblyPlan.stages.length, 2);
  const lines = owedLines(state).join("\n");
  assert.match(lines, /the assembly is owed/);
  assert.match(lines, /land the assembly branch/);
});

test("an assembled round names the assembly's branch", () => {
  const dir = worktree();
  const state = pipelineStateOf(
    task({
      state: "running",
      pipelineRun: record({
        stage: "critique",
        visits: { draft: 1, critique: 1 },
        round: { parentPath: dir, parent: "wtgui/a-row-a1b2c3", slug: "a-row", tag: "a1b2c3", sha: "9f3c1a2d4e5f" },
        trees: { critique: { path: dir, branch: "wtgui/a-row-stage-2-critique-222222", cutAt: ISO } },
        assembly: { commit: "c".repeat(40), base: "9f3c1a2d4e5f", branch: "wtgui/a-row-a1b2c3", path: dir, verified: 3, stages: ["draft#1", "critique#1"], skipped: [] },
        stageRuns: [
          { id: "two-step/draft#1", stage: "draft", visit: 1, at: ISO, status: "done", settledAt: ISO, commit: "a".repeat(40) },
          { id: "two-step/critique#1", stage: "critique", visit: 1, at: ISO, status: "done", settledAt: ISO, commit: "b".repeat(40) },
        ],
      }),
    }),
    { bundle: BUNDLE, now: LATER },
  );
  assert.match(owedLines(state).join("\n"), /the round is assembled at cccccccc on wtgui\/a-row-a1b2c3: land THAT branch/);
  assert.match(renderPipelineState(state), /assembly wtgui\/a-row-a1b2c3 at cccccccccc/);
});

// ---- the CLI: the record is found, resolved and printed ----------------------------------------------------------

test("the command prints one row from a state directory, and refuses an id it does not hold", () => {
  const stateDir = tempDir("pipeline-state-state-");
  const queueDir = path.join(stateDir, "assistants", "assistant-1");
  mkdirSync(queueDir, { recursive: true });
  const row = task({
    id: 7,
    state: "queued",
    pipelineRun: record({ stage: "critique", visits: { critique: 1 }, round: { parent: "main", sha: "9f3c1a2d4e5f" } }),
  });
  writeFileSync(
    path.join(queueDir, "queue.json"),
    JSON.stringify({ version: 1, nextId: 8, tasks: [row] }),
    "utf8",
  );
  writeFileSync(path.join(stateDir, "pipeline-bundle.json"), JSON.stringify(DOC), "utf8");

  const found = findRows({ stateDir, id: 7 });
  assert.equal(found.rows.length, 1);
  assert.equal(found.rows[0].assistantId, "assistant-1");

  const run = spawnSync(process.execPath, [TOOL, "7", "--state-dir", stateDir], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /row 7 · assistant-1 · queued/);
  assert.match(run.stdout, /next step/);
  assert.match(run.stdout, /NO TREE yet/);

  const json = spawnSync(process.execPath, [TOOL, "7", "--state-dir", stateDir, "--json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.row.id, 7);
  assert.equal(parsed.resolution.mode, "pipeline");

  const missing = spawnSync(process.execPath, [TOOL, "99", "--state-dir", stateDir], { cwd: ROOT, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no task 99/);

  const usage = spawnSync(process.execPath, [TOOL, "--nope"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(usage.status, 2);
});

test("main writes nothing: the queue file is byte-identical after a read", () => {
  const stateDir = tempDir("pipeline-state-readonly-");
  const queueDir = path.join(stateDir, "assistants", "assistant-1");
  mkdirSync(queueDir, { recursive: true });
  const file = path.join(queueDir, "queue.json");
  const body = JSON.stringify({ version: 1, nextId: 2, tasks: [task({ id: 1 })] });
  writeFileSync(file, body, "utf8");
  const out = spawnSync(process.execPath, [TOOL, "1", "--state-dir", stateDir], { cwd: ROOT, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readFileSync(file, "utf8"), body);
});
