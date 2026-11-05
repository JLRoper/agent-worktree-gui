// The bundle the panel ships as a seed: the studio's own 13-stage POC-to-UAT export, in the panel's multi-pipeline
// wrapper, beside three small pipelines that are complete enough to work.
//
// This file exists because "the window works" is not the same claim as "the window has something true to show". The
// seed is not a fixture written to suit the loader: its `poc-to-uat` entry is `exportBundle(pipeline.seed.json).files
// .pipeline` from tools/pipeline-studio in ai-development-factory, carried verbatim inside `pipelines[0]`, and the
// panel's loader must read it as it is — 13 stages in order, 5 gates, 15 handoffs, each stage's prompt coming from the
// roster role the studio joins it to.
//
// The other three are the reader's own small shapes, and they are what makes the dropdown prove it can hold a large
// pipeline and a small one at once: a two-stage ping-pong on a capped loop, a two-stage probe-then-fix, and a
// three-stage author-review-revise with a capped reject edge. Their counts, their caps and the one gate that carries a
// decision are pinned here, so a seed edited down to a stub cannot pass as "several pipelines".
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

test("the shipped seed holds the studio's 13-stage POC-to-UAT export as its first pipeline, read as it is", () => {
  const source = readBundle(SEED);
  assert.equal(source.ok, true, `the seed must load: ${source.code} ${source.reason}`);
  const bundle = source.bundle;
  assert.equal(bundle.name, "SEFL pipelines");
  assert.deepEqual(bundle.pipelines.map((p) => p.id), ["poc-to-uat", "ping-pong", "probe-fix", "author-review-revise"]);
  const pipeline = bundle.pipelines[0];
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

test("the seed's three small pipelines are complete: 2-3 stages each, with the capped loops their names promise", () => {
  const source = readBundle(SEED);
  assert.equal(source.ok, true, `the seed must load: ${source.code} ${source.reason}`);
  const byId = new Map(source.bundle.pipelines.map((p) => [p.id, p]));

  const pingPong = byId.get("ping-pong");
  assert.ok(pingPong, "the ping-pong pipeline is shipped");
  assert.deepEqual(pingPong.order, ["draft", "critique"]);
  assert.ok(pingPong.stages.every((s) => s.prompt && s.prompt.length > 0), "each stage has its own instruction");
  assert.ok(pingPong.stages.every((s) => s.artifact.id && s.artifact.path && s.artifact.writer), "each stage writes a named artifact");
  const returnEdge = pingPong.handoffs.find((h) => h.kind === "loop");
  assert.ok(returnEdge, "the hand-back is a loop handoff, not a second sequence");
  assert.deepEqual([returnEdge.from, returnEdge.to, returnEdge.artifact, returnEdge.cap], ["critique", "draft", "critique-notes", "3 rounds"]);
  assert.equal(pingPong.handoffs.filter((h) => h.kind === "sequence").length, 1, "one sequence edge into the critique");

  const probeFix = byId.get("probe-fix");
  assert.ok(probeFix, "the probe-then-fix pipeline is shipped");
  assert.deepEqual(probeFix.order, ["probe", "fix"]);
  assert.equal(probeFix.handoffs.length, 1);
  assert.deepEqual([probeFix.handoffs[0].from, probeFix.handoffs[0].to, probeFix.handoffs[0].kind], ["probe", "fix", "sequence"]);

  const author = byId.get("author-review-revise");
  assert.ok(author, "the author-review-revise pipeline is shipped");
  assert.deepEqual(author.order, ["author", "review", "revise"]);
  const reject = author.handoffs.find((h) => h.kind === "loop");
  assert.ok(reject, "the reject edge is a loop handoff");
  assert.deepEqual([reject.from, reject.to, reject.cap], ["review", "author", "2 rejects"]);
  assert.equal(author.handoffs.filter((h) => h.kind === "sequence").length, 2, "author -> review and review -> revise are sequences");
  const gate = author.gates[0];
  assert.ok(gate && gate.decision, "the review gate carries a decision artifact rather than being an unstated pause");
  assert.deepEqual(gate.decision.outcomes, ["accept", "reject"]);
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
  assert.deepEqual(assigned.task.pipelineRun, { pipeline: "poc-to-uat", stage: "S7", enteredAt: "2026-11-03T15:00:00.000Z", visits: { S7: 1 } });

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

test("a two-stage seed pipeline assigns a task on its own stage, not on the large one's", () => {
  const source = readBundle(SEED);
  const assigned = assignTaskPipeline([{ id: 4, title: "draft and critique" }], 4, {
    pipeline: "ping-pong",
    stage: "critique",
    source,
    at: AT,
  });
  assert.deepEqual(assigned.task.pipelineRun, { pipeline: "ping-pong", stage: "critique", enteredAt: AT.toISOString(), visits: { critique: 1 } });
  const view = resolveTaskPipeline(assigned.task, { bundle: source.bundle, now: AT });
  assert.equal(view.count, 2, "the window counts the chosen pipeline's stages, not the bundle's largest");
  assert.equal(view.position, 2);
  assert.equal(view.stageTitle, "Critique");
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
    assert.match(out, /4 pipelines/);
    assert.match(out, /poc-to-uat: 13 stages S0\.\.S12/);
    const read = readBundle(target);
    assert.equal(read.ok, true, `the seeded file is readable: ${read.code} ${read.reason}`);
    assert.equal(read.bundle.pipelines.length, 4);
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
