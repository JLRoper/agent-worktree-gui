#!/usr/bin/env node
// HARNESS: LIVE GATE
// Prove the FORK on the four-stage POC's document, on real trees, driven by the real `driveTaskPipelines`: S220 forks
// into two lanes (S221 the data records, S222 the access records) and S223 joins them. The document declares NO
// `isolation`, which is how it was written, and which used to decide the walk.
//
// Two claims, and each one is about DIRECTORIES and COMMITS, not about a reading of the record:
//
//   1. the block the document DRAWS is walked. The drive yields S220, S221 and S222 - each in a tree of its own, the two
//      lanes cut from the same base - and then S223, whose aggregate is ONE commit with a parent per lane and whose
//      stored manifest names BOTH lane artifacts at the commits they settled. Before this rule the ledger read
//      S220#1, S221#1, S223#1: S222 was never entered, no tree was cut for it, and the join ran on half its inputs.
//   2. a row whose terminal stage REFUSES its input reads refused, not done. The same document on a record written
//      before rounds (one tree, so the block cannot be walked): S223 is handed the data records and not the access
//      records, is refused `pipeline-refuse-input`, its stage run settles `refused`, and the row parks. Before this rule
//      the stage started anyway and the row settled `done`.
//
// Nothing here pushes: every branch is local, and this harness never names a remote.
//
//   node tools/verify-pipeline-fork.mjs                     quiet when green except the summary
//   VERIFY_KEEP=1 node tools/verify-pipeline-fork.mjs       keep the sandbox (the repo, the trees, the artifacts)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Jobs } from "../lib/jobs.js";
import { aggregateBranches, preflightMerge } from "../lib/pipeline-aggregate.js";
import { assembleStages, assemblyMessage, assemblyRecord } from "../lib/pipeline-assembly.js";
import { parseBundle } from "../lib/pipeline-bundle.js";
import { aggregateMessage, aggregateRecord } from "../lib/pipeline-fanout.js";
import { DRIVE_FAULTS, driveTaskPipelines } from "../lib/task-pipeline-drive.js";
import { settleStageRun } from "../lib/task-pipeline.js";

const CLOCK = "2026-11-10T09:00:00.000Z";
const step = (n) => new Date(Date.parse(CLOCK) + n * 10 * 60 * 1000).toISOString();
const EMAIL = ["fork", "example.invalid"].join(String.fromCharCode(64));

let checks = 0;
let failures = 0;
function ok(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`ok    ${name}`);
    return true;
  }
  failures += 1;
  console.log(`FAIL  ${name}${detail ? ` : ${detail}` : ""}`);
  return false;
}
function is(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(name, same, same ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const write = (file, body) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};
const facts = (dir) => {
  try {
    return { head: git(dir, ["rev-parse", "--short", "HEAD"]), commit: git(dir, ["rev-parse", "HEAD"]), dirty: 0 };
  } catch {
    return null;
  }
};

// ---- the document, as the POC wrote it: four stages, two lanes, and no `isolation` ---------------------------
const stage = (n, file, reads = []) => ({
  id: `S${n}`,
  title: `Stage ${n}`,
  prompt: `Work stage ${n} and write ${file}.`,
  artifact: { id: `a${n}`, path: file, schema: "out/1", writer: `w${n}` },
  ...(reads.length ? { inputs: { read: reads.map((artifact) => ({ artifact })) } } : {}),
});
const DOC = {
  bundleVersion: 1,
  name: "four-stage-proof",
  pipelines: [
    {
      id: "poc-fork",
      title: "Four stages, two lanes",
      stages: [
        stage(220, "out/plan.json"),
        stage(221, "out/data-records.json", ["a220"]),
        stage(222, "out/access-records.json", ["a220"]),
        // The terminal stage reads BOTH lanes: the records it merges, and the ones it must not run without.
        stage(223, "out/terminal.json", ["a221", "a222"]),
      ],
      gates: [],
      handoffs: [
        { id: "h220a", from: "S220", to: "S221", artifact: "a220", kind: "sequence" },
        { id: "h220b", from: "S220", to: "S222", artifact: "a220", kind: "sequence" },
        { id: "h221", from: "S221", to: "S223", artifact: "a221", kind: "sequence" },
        { id: "h222", from: "S222", to: "S223", artifact: "a222", kind: "sequence" },
      ],
    },
  ],
};
const parsed = parseBundle(DOC, { file: "poc-fork.json" });
if (!parsed.ok) {
  console.log(`FAIL  the fixture bundle must parse: ${parsed.reason}`);
  process.exit(2);
}
const bundle = parsed.bundle;
const pipeline = bundle.pipelines[0];
const FILES = Object.fromEntries(pipeline.stages.map((entry) => [entry.id, entry.artifact.path]));

const tmp = mkdtempSync(path.join(os.tmpdir(), "wtgui-fork-e2e-"));
const repo = path.join(tmp, "throwaway");
const jobFor = (thread, at) => ({ id: `j-${thread}`, thread, status: "done", startedAt: at, endedAt: at });
const worker = (dir, file, at) => {
  write(path.join(dir, file), `${JSON.stringify({ file, at }, null, 2)}\n`);
  git(dir, ["add", "--", file]);
  git(dir, ["-c", `user.name=proof`, "-c", `user.email=${EMAIL}`, "commit", "-qm", `${file} settled`]);
  return git(dir, ["rev-parse", "HEAD"]);
};

// Drive ONE row to its end on real trees: the cut, the aggregate, the assembly and the start are performed here, in
// the order lib/assistant.js performs them, and the driver decides every one of them.
async function driveRow({ jobs, round }) {
  const trees = new Map();
  const log = { passes: [], cuts: [], starts: [], aggregates: [], assemblies: [], parks: [] };
  let row = {
    id: 42,
    title: "the four-stage POC",
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
    pipelineRun: {
      pipeline: pipeline.id,
      stage: "S220",
      enteredAt: CLOCK,
      visits: { S220: 1 },
      ...(round ? { round } : {}),
    },
  };
  let jobsSeen = [];
  for (let pass = 0; pass < 14; pass += 1) {
    const at = step(pass + 1);
    const out = driveTaskPipelines([row], { bundle, jobs: jobsSeen, isLive: () => false, at, unattended: true, treeOf: facts });
    row = out.tasks[0];
    log.passes.push({ pass, stage: row.pipelineRun.stage, state: row.state, role: out.ensureTree.map((r) => `${r.stage}/${r.role}`) });
    for (const request of out.ensureTree) {
      const cut = await jobs.makeWorktree(repo, request.prompt, { project: "throwaway", from: request.base || null });
      const tree = { path: cut.path, branch: cut.branch, startSha: git(cut.path, ["rev-parse", "HEAD"]) };
      trees.set(request.stage, tree);
      log.cuts.push(`${request.stage}/${request.role}`);
      // `role: "row"` is the legacy model's ONE tree: it is promoted to the row's own, which is where `treeLookup`
      // reads it for every stage of a record that carries no round.
      row = settleStageRun(
        { ...row, pipelineRun: { ...row.pipelineRun, trees: { ...(row.pipelineRun.trees || {}), [request.stage]: tree }, ...(request.role === "row" ? { tree } : {}) } },
        { stage: request.stage },
      );
    }
    for (const request of out.aggregates) {
      const target = trees.get(request.stage) || { path: request.tree };
      const pre = preflightMerge({ tree: target.path, base: request.base, branches: request.branches });
      const merged = aggregateBranches({
        tree: target.path,
        base: request.base,
        branches: request.branches,
        message: aggregateMessage(pipeline, { join: request.stage }, request.branches, request.base),
        at,
      });
      log.aggregates.push({ stage: request.stage, ok: merged.ok, parents: merged.parents, preflight: pre.ok, lanes: request.branches.map((b) => b.stage) });
      row = settleStageRun(row, {
        stage: request.stage,
        merge: aggregateRecord({ commit: merged.commit, base: request.base, branches: request.branches, at, tree: { path: target.path }, verified: merged.verified }),
      });
    }
    for (const request of out.assemblies) {
      const assembled = assembleStages({
        tree: round.parentPath,
        base: request.base,
        stages: request.stages,
        message: assemblyMessage(pipeline, request.stages, request.base),
        at,
      });
      log.assemblies.push({ stages: request.stages.map((s) => s.stage), ok: assembled.ok });
      row = {
        ...row,
        pipelineRun: {
          ...row.pipelineRun,
          assembly: assemblyRecord({
            commit: assembled.commit,
            base: request.base,
            branch: round.parent,
            path: round.parentPath,
            stages: request.stages,
            skipped: assembled.skipped,
            verified: assembled.verified,
            paths: assembled.paths,
            at,
          }),
        },
      };
    }
    for (const start of out.starts) {
      const commit = worker(start.target, FILES[start.stage], at);
      const thread = `T${pass + 1}-${start.stage}`;
      jobsSeen = [...jobsSeen, jobFor(thread, at)];
      log.starts.push({ stage: start.stage, role: start.role, commit });
      row = settleStageRun(row, { stage: start.stage, thread, job: `j-${thread}` });
      row = { ...row, state: "running", thread, threads: [thread], worktree: start.target };
    }
    if (row.state === "parked" || row.state === "done") break;
  }
  return { row, trees, log };
}

try {
  // ---- a throwaway repo with one base commit, and the panel's own job store ------------------------------------
  mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "proof"]);
  git(repo, ["config", "user.email", EMAIL]);
  git(repo, ["config", "core.autocrlf", "false"]);
  write(path.join(repo, "README.md"), "# the checkout\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const jobs = new Jobs({ config: { jobsFile: null, apiServer: { url: "http://127.0.0.1:9" } } });
  const parent = await jobs.makeWorktree(repo, "the round's parent tree", { project: "throwaway", from: base });
  const round = { parent: parent.branch, parentPath: parent.path, slug: "poc", tag: "abc123", base: "main", sha: base, at: CLOCK, by: "panel" };

  // ---- 1. the block is walked: S220, S221 and S222, then S223 --------------------------------------------------
  const walked = await driveRow({ jobs, round });
  const runs = walked.row.pipelineRun.stageRuns || [];
  is(
    "the drive visits S220, S221 and S222 before S223",
    runs.filter((entry) => entry.status === "done").map((entry) => entry.stage),
    ["S220", "S221", "S222", "S223"],
  );
  ok("no lane is dropped", !runs.some((entry) => !entry.status), "a run that never settled would be a dropped stage");
  is("one tree per stage, and four of them", [walked.trees.size, [...walked.trees.keys()]], [4, ["S220", "S221", "S222", "S223"]]);
  ok(
    "no two stages shared a directory",
    new Set([...walked.trees.values()].map((tree) => tree.path)).size === 4,
    [...walked.trees.values()].map((tree) => tree.path).join(", "),
  );
  const laneCuts = [walked.trees.get("S221"), walked.trees.get("S222")];
  const forkCommit = (runs.find((entry) => entry.stage === "S220") || {}).commit;
  is(
    "both lanes were cut from the fork's SETTLED commit, not from each other",
    laneCuts.map((tree) => tree.startSha),
    [forkCommit, forkCommit],
  );
  const aggregate = walked.log.aggregates.find((entry) => entry.stage === "S223");
  ok("the join's aggregate exists", Boolean(aggregate), JSON.stringify(walked.log.aggregates));
  is("it merges BOTH lanes and nothing else", aggregate && aggregate.lanes, ["S221", "S222"]);
  is("the pre-flight was clean and the merge verified", aggregate && [aggregate.preflight, aggregate.ok, aggregate.parents], [true, true, 3]);
  const joinRun = runs.find((entry) => entry.stage === "S223");
  const joinInputs = (joinRun && joinRun.inputs ? joinRun.inputs : []).map((entry) => entry.artifact);
  ok("the terminal stage is handed the access records as well as the data records", joinInputs.includes("a221") && joinInputs.includes("a222"), JSON.stringify(joinInputs));
  ok(
    "and each one is pinned at the commit the lane settled",
    (joinRun.inputs || []).filter((entry) => ["a221", "a222"].includes(entry.artifact)).every((entry) => /^[0-9a-f]{40}$/.test(String(entry.commit || "")) && String(entry.blob || "").length > 0),
    JSON.stringify((joinRun.inputs || []).map((entry) => [entry.artifact, entry.commit, entry.blob])),
  );
  is(
    "the block needs no assembly: the join's tree IS the one merge that lands",
    walked.log.assemblies,
    [],
  );
  is("and the row settles done at the join", [walked.row.state, walked.row.pipelineRun.stage], ["done", "S223"]);
  ok("no pass ever asked for a stage twice", walked.log.cuts.length === 4 && walked.log.starts.length === 4, `cuts ${walked.log.cuts.join(",")} / starts ${walked.log.starts.map((s) => s.stage).join(",")}`);

  // ---- 2. the terminal refusal: the same document, one tree, and the row reads refused --------------------------
  const legacy = await driveRow({ jobs, round: null });
  const legacyRuns = legacy.row.pipelineRun.stageRuns || [];
  const refused = legacyRuns.find((entry) => entry.stage === "S223");
  is("a row with no round keeps ONE tree", [legacy.trees.size, legacy.log.cuts], [1, ["S220/row"]]);
  is("so the second lane is never entered", legacyRuns.filter((entry) => entry.status === "done").map((entry) => entry.stage), ["S220", "S221"]);
  ok("the terminal stage is refused, not started", Boolean(refused) && Boolean(refused.decision) && refused.decision.code === DRIVE_FAULTS.REFUSE_INPUT, JSON.stringify(refused && refused.decision));
  is("and the run reads refused rather than a run that never ended", refused && refused.status, "refused");
  is("the row settles refused, not done", legacy.row.state, "parked");
  ok("the sentence names the missing artifact", /a222/.test(String(legacy.row.reason)) && /refused, not done/.test(String(legacy.row.reason)), String(legacy.row.reason));
  ok("the terminal stage never ran a worker", !legacy.log.starts.some((start) => start.stage === "S223"));
  ok(
    "the lane it never entered is the one nothing settled",
    !legacyRuns.some((entry) => entry.stage === "S222"),
    JSON.stringify(legacyRuns.map((entry) => entry.stage)),
  );
  ok("both drives are there to compare", runs.length === 4 && legacyRuns.length === 3, `${runs.length} / ${legacyRuns.length}`);

  console.log(
    `\n      fork: 4 stages (S220 fork · S221, S222 lanes · S223 join) · 4 trees · 1 aggregate (${aggregate.parents} parents, ${aggregate.lanes.join(" + ")}) · no assembly (the join tree is the one merge) · and a pre-round row refused at S223 rather than settled done`,
  );
} catch (error) {
  failures += 1;
  console.log(`FAIL  the harness threw: ${String((error && error.stack) || error)}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") console.log(`\n      VERIFY_KEEP=1: the sandbox is at ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${checks} checks, ${failures} failed.`);
process.exit(failures ? 1 : 0);
