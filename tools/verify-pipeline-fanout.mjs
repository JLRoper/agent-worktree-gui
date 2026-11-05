#!/usr/bin/env node
// HARNESS: LIVE GATE
// Prove the fan-out model on a THREE-STAGE fan-out with a report aggregator — on real trees, cut by the panel's own
// `Jobs.makeWorktree`, driven by the real `driveTaskPipelines`, merged by the real `aggregateBranches`.
//
// The unit tests pin each half (test/pipeline-fanout.test.js, test/task-pipeline-fanout.test.js). This is the whole
// thing in one run, because "one tree per stage" is a claim about DIRECTORIES and "one merge" is a claim about a
// COMMIT, and neither is proved by an argument over a record:
//
//   1. a 3-stage pipeline (`isolation: "per-stage"`: S1 and S2 lanes, S3 the aggregator) is driven from `queued` to
//      the end — the stage count, the ledger, and one tree per stage, every lane cut from the SAME base;
//   2. each lane writes only `reports/<stage>.md` and commits it, and the aggregate is ONE commit with a parent per
//      lane, whose tree is the tree the pre-flight predicted;
//   3. each stage's report is BYTE-IDENTICAL in the aggregate (sha256 of the working file AND the blob object id);
//   4. the aggregator's prompt names every lane by pin, and starts only after the merge is recorded;
//   5. a DELIBERATE CONFLICT — two lanes writing the same path — is refused before any merge starts, names the path,
//      moves no HEAD, writes no working file, and renders the park sentence a reader sees.
//
// Nothing here pushes: a lane branch is local only, and this harness never names a remote.
//
//   node tools/verify-pipeline-fanout.mjs            quiet when green except the summary
//   VERIFY_KEEP=1 node tools/verify-pipeline-fanout.mjs   keep the sandbox (the repo, the trees, the reports)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Jobs } from "../lib/jobs.js";
import { aggregateBranches, preflightMerge, AGGREGATE_FAULTS } from "../lib/pipeline-aggregate.js";
import { parseBundle } from "../lib/pipeline-bundle.js";
import { aggregateMessage, aggregateRecord } from "../lib/pipeline-fanout.js";
import { DRIVE_FAULTS, driveTaskPipelines, renderDecision } from "../lib/task-pipeline-drive.js";
import { settleStageRun } from "../lib/task-pipeline.js";

const CLOCK = "2026-11-05T16:00:00.000Z";
const LATER = "2026-11-05T16:20:00.000Z";

let checks = 0;
let failures = 0;
function ok(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`ok    ${name}`);
    return true;
  }
  failures += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  return false;
}
function is(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(name, same, same ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "wtgui-fanout-e2e-"));
const repo = path.join(tmp, "throwaway");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const write = (file, body) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

// ---- the bundle: two lanes and one aggregator ---------------------------------------------------------------
const stage = (n, file) => ({
  id: `S${n}`,
  title: `Write report ${n}`,
  prompt: `Write ${file} and nothing else.`,
  artifact: { id: `report-${n}`, path: file, schema: "report/1", writer: `writer-${n}` },
});
const bundleOf = (record) => {
  const parsed = parseBundle({ bundleVersion: 1, name: "fanout-proof", pipelines: [record] }, { file: "pipeline-bundle.json" });
  if (!parsed.ok) throw new Error(`the fixture bundle must parse: ${parsed.reason}`);
  return parsed.bundle;
};
const bundle = bundleOf({
  id: "reports",
  title: "Two reports, one aggregate",
  isolation: "per-stage",
  stages: [stage(1, "reports/S1.md"), stage(2, "reports/S2.md"), stage(3, "reports/aggregate.md")],
  gates: [],
  handoffs: [
    { id: "h1", from: "S1", to: "S3", artifact: "report-1", kind: "sequence" },
    { id: "h2", from: "S2", to: "S3", artifact: "report-2", kind: "sequence" },
  ],
});
const pipeline = bundle.pipelines[0];

const jobFor = (thread, status = "done") => ({ id: `j-${thread}`, thread, status, startedAt: CLOCK, endedAt: LATER });
const facts = (dir) => {
  try {
    return { head: git(dir, ["rev-parse", "--short", "HEAD"]), commit: git(dir, ["rev-parse", "HEAD"]), dirty: 0 };
  } catch {
    return null;
  }
};
const drive = (tasks, jobs = []) => driveTaskPipelines(tasks, { bundle, jobs, isLive: () => false, at: CLOCK, unattended: true, treeOf: facts });
const worker = (dir, file, body) => {
  write(path.join(dir, file), body);
  git(dir, ["add", "--", file]);
  git(dir, ["-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "commit", "-qm", `${file} from ${path.basename(dir)}`]);
  return git(dir, ["rev-parse", "HEAD"]);
};

let laneA = null;
let laneB = null;
let aggregate = null;
let base = null;
let row = null;

try {
  // ---- a throwaway repo with one base commit, and the panel's own job store -------------------------------
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "proof"]);
  git(repo, ["config", "user.email", "proof@example.invalid"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  write(path.join(repo, "README.md"), "# base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  base = git(repo, ["rev-parse", "HEAD"]);

  const jobs = new Jobs({ config: { jobsFile: null, apiServer: { url: "http://127.0.0.1:9" } } });

  row = {
    id: 7,
    title: "write the two reports",
    detail: "",
    state: "queued",
    thread: null,
    threads: [],
    worktree: null,
    project: "throwaway",
    files: [],
    attempts: 0,
    reason: "",
    hold: null,
    pipelineRun: { pipeline: "reports", stage: "S1", enteredAt: CLOCK, visits: { S1: 1 } },
  };

  // ---- 1. S1 asks for ITS OWN tree, and the cut supplies the block's base -----------------------------------
  const first = drive([row]);
  is("stage 1 is asked for a lane tree", first.ensureTree.map((r) => [r.stage, r.role, r.base]), [["S1", "lane", null]]);
  ok("nothing starts before its tree exists", first.starts.length === 0);

  const cutA = await jobs.makeWorktree(repo, first.ensureTree[0].prompt, { project: "throwaway", from: first.ensureTree[0].base });
  laneA = cutA.path;
  base = cutA.startSha || base;
  ok("lane S1 is a worktree of its own, apart from the checkout", laneA !== repo && existsSync(laneA), laneA);
  is("its branch is a wtgui branch, not the row's checkout", /^wtgui\//.test(cutA.branch), true);

  const fanout = { base, fork: null, lanes: ["S1", "S2"], join: "S3" };
  row = { ...row, pipelineRun: { ...row.pipelineRun, trees: { S1: { path: laneA, branch: cutA.branch, startSha: base } }, fanout } };

  const startA = drive([row]);
  is("S1 starts in lane A", startA.starts.map((s) => [s.stage, s.target, s.role]), [["S1", laneA, "lane"]]);

  // ---- 2. S1 works, commits its report, and settles --------------------------------------------------------
  const commitA = worker(laneA, "reports/S1.md", "# report one\n");
  row = { ...row, state: "running", thread: "T1", threads: [], worktree: laneA };
  const settledA = drive([row], [jobFor("T1")]);
  is("S1 settled done and the row moved to the second lane", [settledA.tasks[0].pipelineRun.stage, settledA.changed[0].to], ["S2", "queued"]);
  const runA = settledA.tasks[0].pipelineRun.stageRuns.find((entry) => entry.stage === "S1");
  is("the lane run pins the commit it settled at", [runA.status, runA.commit], ["done", commitA]);
  is("and the branch it ran on", runA.tree.branch, cutA.branch);
  is("a lane's tree is never promoted to the row's", settledA.tasks[0].pipelineRun.tree, undefined);

  // ---- 3. S2 is cut from the SAME base, not from lane A -----------------------------------------------------
  const second = settledA.tasks[0];
  is("stage 2 is asked for its own tree at the block's base", second.pipelineRun.stage, "S2");
  const askedB = drive([second]).ensureTree;
  is("the request carries the ONE base", askedB.map((r) => [r.stage, r.role, r.base]), [["S2", "lane", base]]);

  const cutB = await jobs.makeWorktree(repo, askedB[0].prompt, { project: "throwaway", from: askedB[0].base });
  laneB = cutB.path;
  ok("lane S2 is a third directory, not the checkout and not lane A", ![repo, laneA].includes(laneB) && existsSync(laneB), laneB);
  is("lane S2's tree starts at the block's base", cutB.startSha || git(laneB, ["rev-parse", "HEAD"]), base);
  is("which is the commit lane A was cut from too", git(laneA, ["rev-parse", "HEAD~1"]), base);

  row = { ...second, pipelineRun: { ...second.pipelineRun, trees: { ...second.pipelineRun.trees, S2: { path: laneB, branch: cutB.branch, startSha: base } } } };
  const startB = drive([row]);
  is("S2 starts in lane B", startB.starts.map((s) => [s.stage, s.target]), [["S2", laneB]]);

  const commitB = worker(laneB, "reports/S2.md", "# report two\n");
  row = { ...row, state: "running", thread: "T2", threads: [], worktree: laneB };
  const settledB = drive([row], [jobFor("T2")]);
  is("the last lane enters the join, and it is not started yet", [settledB.tasks[0].pipelineRun.stage, settledB.ensureTree[0]?.role, settledB.starts.length], ["S3", "join", 0]);
  is(
    "the aggregate request names each lane's COMMIT",
    settledB.ensureTree[0].branches.map((b) => [b.stage, b.commit]),
    [
      ["S1", commitA],
      ["S2", commitB],
    ],
  );
  is("and is cut at the same base", settledB.ensureTree[0].base, base);

  // ---- 4. the aggregate: one tree, ONE commit, byte-identical reports --------------------------------------
  const cutJoin = await jobs.makeWorktree(repo, settledB.ensureTree[0].prompt, { project: "throwaway", from: settledB.ensureTree[0].base });
  aggregate = cutJoin.path;
  const branches = settledB.ensureTree[0].branches;
  const message = aggregateMessage({ id: pipeline.id }, { join: "S3" }, branches, base);
  const pre = preflightMerge({ tree: aggregate, base, branches });
  is("the pre-flight is clean and writes no working file", [pre.ok, pre.conflicts], [true, []]);

  const merged = aggregateBranches({ tree: aggregate, base, branches, message, at: LATER });
  is("one merge, and it is verified against the pre-flight tree", [merged.ok, merged.merged, merged.verified], [true, true, true]);
  is("ONE commit with a parent per lane plus the base", merged.parents, 3);
  is("and exactly ONE merge commit above the base (the two lane commits and their merge)", [
    git(aggregate, ["rev-list", "--count", "--min-parents=2", `${base}..HEAD`]),
    git(aggregate, ["rev-list", "--count", "--max-parents=1", `${base}..HEAD`]),
  ], ["1", "2"]);
  is("the merge's subject names the stage and the lanes", git(aggregate, ["log", "-1", "--format=%s"]), message);

  // The assistant's join cut writes the aggregate on the row's `tree` (it is the branch that lands) and each stage's
  // tree in `trees`; the merge is written on the join's stage run before its worker exists.
  const joinTree = { path: aggregate, branch: cutJoin.branch, startSha: base, by: "panel" };
  row = settleStageRun(
    {
      ...settledB.tasks[0],
      pipelineRun: {
        ...settledB.tasks[0].pipelineRun,
        tree: joinTree,
        trees: { ...settledB.tasks[0].pipelineRun.trees, S3: joinTree },
      },
    },
    { stage: "S3", merge: aggregateRecord({ commit: merged.commit, base, branches, at: LATER, tree: { path: aggregate }, verified: merged.verified }) },
  );

  // The row now carries the aggregate; the driver starts the aggregator and hands it every lane by pin.
  const startJoin = drive([row]);
  is("the aggregator starts in the aggregate tree", startJoin.starts.map((s) => [s.stage, s.target, s.role]), [["S3", aggregate, "join"]]);
  ok(
    "its INPUTS block names both lanes at their commits",
    new RegExp(`lane\\s+S1\\s+report-1\\s+reports/S1\\.md\\s+commit ${commitA.slice(0, 12)}`).test(startJoin.starts[0].prompt) &&
      new RegExp(`lane\\s+S2\\s+report-2\\s+reports/S2\\.md\\s+commit ${commitB.slice(0, 12)}`).test(startJoin.starts[0].prompt),
    startJoin.starts[0].prompt,
  );
  ok("and names the ONE merge", new RegExp(`aggregate\\s+ONE merge of 2 stage branches — commit ${merged.commit.slice(0, 12)}`).test(startJoin.starts[0].prompt));

  // ---- 5. byte comparison: each lane's report arrived intact ----------------------------------------------
  for (const [file, lane] of [
    ["reports/S1.md", laneA],
    ["reports/S2.md", laneB],
  ]) {
    is(`${file} is in the aggregate`, existsSync(path.join(aggregate, file)), true);
    is(`${file} is byte-identical (sha256)`, sha256(path.join(aggregate, file)), sha256(path.join(lane, file)));
    is(`${file}'s blob is the lane's own blob`, git(aggregate, ["rev-parse", `HEAD:${file}`]), git(lane, ["rev-parse", `HEAD:${file}`]));
  }

  // ---- 6. the aggregator writes its own report; the row ends with three trees and one merge --------------
  const commitAgg = worker(aggregate, "reports/aggregate.md", "# the two reports, combined\n");
  row = { ...row, state: "running", thread: "T3", threads: [], worktree: aggregate };
  const done = drive([row], [jobFor("T3")]);
  const finish = done.tasks[0];
  const finishRun = finish.pipelineRun;
  is("the pipeline is over after the aggregator settles", [finishRun.stage, done.changed.length, done.starts.length], ["S3", 0, 0]);
  is("the aggregator's own report is in the aggregate commit", git(aggregate, ["rev-parse", "HEAD:reports/aggregate.md"]), git(aggregate, ["rev-parse", "HEAD:reports/aggregate.md"]));
  is("its commit sits on the ONE merge", git(aggregate, ["rev-parse", "HEAD^"]), merged.commit);
  is("the row's tree is the aggregate's — the branch that lands", finishRun.tree.path, aggregate);
  is(
    "three stages, three trees — the aggregate's included",
    ["S1", "S2", "S3"].map((s) => row.pipelineRun.trees[s].path),
    [laneA, laneB, aggregate],
  );
  ok("no two stages share a tree", new Set([laneA, laneB, aggregate]).size === 3);

  // ---- 7. a DELIBERATE conflict: two lanes wrote the same path -------------------------------------------
  const conflictRepo = path.join(tmp, "conflict");
  mkdirSync(path.join(conflictRepo, ".worktrees"), { recursive: true });
  git(conflictRepo, ["init", "-q", "-b", "main"]);
  git(conflictRepo, ["config", "user.name", "proof"]);
  git(conflictRepo, ["config", "user.email", "proof@example.invalid"]);
  git(conflictRepo, ["config", "core.autocrlf", "false"]);
  write(path.join(conflictRepo, "README.md"), "# base\n");
  git(conflictRepo, ["add", "."]);
  git(conflictRepo, ["commit", "-qm", "base"]);
  const cbase = git(conflictRepo, ["rev-parse", "HEAD"]);
  const one = await jobs.makeWorktree(conflictRepo, "write the shared report from A", { project: "throwaway", from: cbase });
  const two = await jobs.makeWorktree(conflictRepo, "write the shared report from B", { project: "throwaway", from: cbase });
  const cone = worker(one.path, "reports/shared.md", "# one\n");
  const ctwo = worker(two.path, "reports/shared.md", "# two\n");
  const cagg = await jobs.makeWorktree(conflictRepo, "aggregate the shared reports", { project: "throwaway", from: cbase });
  const head = git(cagg.path, ["rev-parse", "HEAD"]);
  const clash = aggregateBranches({
    tree: cagg.path,
    base: cbase,
    branches: [
      { stage: "S1", branch: one.branch, commit: cone },
      { stage: "S2", branch: two.branch, commit: ctwo },
    ],
    message: "aggregate",
    at: LATER,
  });
  is("the merge is refused before it starts", [clash.ok, clash.code], [false, AGGREGATE_FAULTS.CONFLICT]);
  is("with the path both lanes wrote", clash.conflicts, ["reports/shared.md"]);
  is("HEAD did not move and nothing is half-merged", [git(cagg.path, ["rev-parse", "HEAD"]), git(cagg.path, ["status", "--porcelain"])], [head, ""]);
  is("the refused merge wrote no working file", existsSync(path.join(cagg.path, "reports/shared.md")), false);

  const parkNote = renderDecision({ kind: "aggregate", stage: "S3", pipeline: "reports", branches: [{ stage: "S1" }, { stage: "S2" }], conflicts: clash.conflicts, base: cbase });
  ok("the park sentence names the path and the lanes", /was refused before it started/.test(parkNote) && parkNote.includes("reports/shared.md") && /S1, S2/.test(parkNote), parkNote);
  is("and it is the code the row parks on", DRIVE_FAULTS.CONFLICT, "pipeline-conflict");

  console.log(`\n      fan-out: 3 stages (S1, S2 lanes · S3 aggregate) · 3 trees · 1 aggregate commit (${merged.commit.slice(0, 12)}, 3 parents) · 2 byte-identical reports · 1 deliberate conflict refused at ${clash.conflicts.join(", ")}`);
} catch (error) {
  failures += 1;
  console.log(`FAIL  the harness threw: ${String((error && error.stack) || error)}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") console.log(`\n      VERIFY_KEEP=1 — the sandbox is at ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${checks} checks, ${failures} failed.`);
process.exit(failures ? 1 : 0);
