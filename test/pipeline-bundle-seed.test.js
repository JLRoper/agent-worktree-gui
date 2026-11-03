// The bundle the panel ships as a seed: the pipeline studio's OWN export of its 13-stage POC-to-UAT project.
//
// This file exists because "the window works" is not the same claim as "the window has something true to show". The
// seed is not a fixture written to suit the loader: it is `exportBundle(pipeline.seed.json).files.pipeline` from
// tools/pipeline-studio in ai-development-factory, copied verbatim, and the panel's loader must read it as it is — 13
// stages in order, 5 gates with their decision artifacts, 15 handoffs, each stage's prompt coming from the roster role
// the studio joins it to.
//
// It also proves the tool that INSTALLS the seed: tools/seed-pipeline-bundle.mjs is run against a temp file and its
// output is read back through the loader, so "seeded" means a file the window can resolve, not a byte count.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readBundle } from "../lib/pipeline-bundle.js";
import { assignTaskPipeline } from "../lib/task-pipeline-assign.js";
import { resolveTaskPipeline } from "../lib/task-pipeline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = path.join(ROOT, "pipeline-bundle.seed.json");
const AT = new Date("2026-11-03T15:00:00.000Z");

test("the shipped seed is the studio's 13-stage POC-to-UAT export, read by the panel's loader as it is", () => {
  const source = readBundle(SEED);
  assert.equal(source.ok, true, `the seed must load: ${source.code} ${source.reason}`);
  const bundle = source.bundle;
  assert.equal(bundle.name, "poc-to-uat");
  assert.equal(bundle.pipelines.length, 1);
  const pipeline = bundle.pipelines[0];
  assert.equal(pipeline.id, "poc-to-uat");
  assert.equal(pipeline.title, "POC to UAT");
  assert.deepEqual(pipeline.order, ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12"]);
  assert.deepEqual(pipeline.stages.map((s) => s.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(pipeline.gates.length, 5, "the studio's five gates G0-G4 survive the import");
  assert.equal(pipeline.handoffs.length, 15);
  assert.deepEqual(pipeline.gates.map((g) => g.id), ["G0", "G1", "G2", "G3", "G4"]);
  for (const gate of pipeline.gates) {
    assert.ok(gate.after && gate.artifact, `gate ${gate.id} closes a stage and decides an artifact`);
    // A gate with no decision is a PAUSE (the loader's own rule), and this studio seed's five gates are all pauses: they
    // carry no decision artifact, so the window says "a pause" instead of inventing one. Pinned here because it is the
    // real shape the panel must draw, not a fixture's convenience.
    assert.equal(gate.decision, null, `gate ${gate.id} is a pause in the studio's own export`);
  }
  // A stage's prompt comes from the roster role the studio joins with owner.role; the loader records which home answered.
  assert.ok(pipeline.stages.every((s) => s.prompt && s.prompt.length > 0), "every stage carries an instruction");
  assert.ok(pipeline.stages.every((s) => s.promptFrom.startsWith("role:")), "the studio keeps prompts on the roster, not the stage");
  // Spot-check the titles a reader will see, so a seed that loads but is a different pipeline cannot pass.
  assert.equal(pipeline.stages[0].title, "Intake and charter");
  assert.equal(pipeline.stages[7].title, "DAL review and SQL verify");
  assert.equal(pipeline.stages[12].title, "UAT sign-off");
});

test("a task assigned from the seed reads its stage, its position of 13 and its elapsed span from the stored stamp", () => {
  const source = readBundle(SEED);
  const assigned = assignTaskPipeline([{ id: 12, title: "carry it through DAL review" }], 12, {
    pipeline: "poc-to-uat",
    stage: "S7",
    source,
    at: AT,
  });
  assert.equal(assigned.changed, true);
  assert.deepEqual(assigned.task.pipelineRun, { pipeline: "poc-to-uat", stage: "S7", enteredAt: "2026-11-03T15:00:00.000Z" });

  const view = resolveTaskPipeline(assigned.task, { bundle: source.bundle, now: new Date("2026-11-03T17:15:00.000Z") });
  assert.equal(view.mode, "pipeline");
  assert.equal(view.pipeline, "poc-to-uat");
  assert.equal(view.stage, "S7");
  assert.equal(view.stageTitle, "DAL review and SQL verify");
  assert.equal(view.position, 8);
  assert.equal(view.count, 13);
  assert.equal(view.elapsed.ms, 2 * 3_600_000 + 15 * 60_000, "two hours and fifteen minutes from the stored instant, no timer");
  assert.match(view.title, /POC to UAT/);
});

test("the seed tool writes a bundle the panel reads back, and refuses to clobber one without --force", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-seed-"));
  const target = path.join(dir, "pipeline-bundle.json");
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "seed-pipeline-bundle.mjs"), "--file", target], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.match(out, /wrote .*pipeline-bundle\.json/);
    assert.match(out, /13 stages S0\.\.S12/);
    const read = readBundle(target);
    assert.equal(read.ok, true, `the seeded file is readable: ${read.code} ${read.reason}`);
    assert.equal(read.bundle.pipelines[0].stages.length, 13);
    assert.equal(readFileSync(target, "utf8"), readFileSync(SEED, "utf8"), "the tool copies the seed verbatim");

    // A second run over the SAME bytes is a no-op that says so — it does not refuse its own seed.
    const again = execFileSync(process.execPath, [path.join(ROOT, "tools", "seed-pipeline-bundle.mjs"), "--file", target], { cwd: ROOT, encoding: "utf8" });
    assert.match(again, /already seeded/);
    assert.equal(readFileSync(target, "utf8"), readFileSync(SEED, "utf8"));

    // A DIFFERENT bundle already at the path is left alone unless --force: a reader's own re-export is not boot state.
    const mine = JSON.stringify({ bundleVersion: 1, name: "mine", pipelines: [{ id: "mine", title: "Mine", stages: [{ id: "S1", title: "One", prompt: "do it", artifact: { id: "a1", path: "a/1", schema: "a/1", writer: "w" } }] }] }, null, 1);
    writeFileSync(target, mine, "utf8");
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "tools", "seed-pipeline-bundle.mjs"), "--file", target], { cwd: ROOT, encoding: "utf8" }), /already exists/);
    assert.equal(readFileSync(target, "utf8"), mine, "the reader's bundle was not clobbered");
    execFileSync(process.execPath, [path.join(ROOT, "tools", "seed-pipeline-bundle.mjs"), "--file", target, "--force"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(readFileSync(target, "utf8"), readFileSync(SEED, "utf8"), "--force replaces it with the shipped seed");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
