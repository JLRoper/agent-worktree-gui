#!/usr/bin/env node
// THE 24-STAGE POC-BREAKING ROUNDS DOCUMENT, ROUTED THROUGH THE PANEL'S OWN STAGE EXECUTOR.
//
//   node tools/pipeline-exec-poc-rounds.mjs                       # both routes, one after the other
//   node tools/pipeline-exec-poc-rounds.mjs --route document      # the starter exactly as it is written
//   node tools/pipeline-exec-poc-rounds.mjs --route loop          # the same document with S200's rail edges removed
//   node tools/pipeline-exec-poc-rounds.mjs --work <dir>          # where the fixture repositories live (default: OS temp)
//   node tools/pipeline-exec-poc-rounds.mjs --out <dir>           # where the ledger and the report's evidence go
//
// WHAT IS REAL HERE, and what is a seat.
//
//   real   `Assistant.sweepQueues` — the panel's clock: the bundle read, `driveTaskPipelines`, `settleTasks`, the one
//          `writeQueueFile`, the journal, the tree cut through `jobs.makeWorktree` (`git worktree add`), the stage
//          prompt the driver builds, the gate barrier's `decisionPathOf` read, and the reader's `pipeline-release`.
//          Nothing in lib/ is stubbed or imported around.
//   real   the document: `ai-development-factory/.../poc-breaking-rounds.yaml`, imported by the STUDIO's own
//          `importDocument`, exported by its own `exportBundle`, and accepted or refused by the PANEL's own
//          `parseBundle` before anything is driven.
//   real   every stage's work: a separate `node tools/pipeline-exec-stage-seat.mjs` PROCESS per stage run, which
//          writes the artifact that stage declares and COMMITS it, so every handoff has a commit and a blob to pin.
//   seat   the model. There is no gateway and no token: the seat is a scripted worker with a stated remit, and the job
//          record it returns is what a gateway would have returned (`thread`, `status`, `finalMessage`).
//   seat   the gate decider. A gate with a decision is a barrier until its record is in the tree; the record is
//          written by the harness AFTER it has observed the park, because the barrier's whole point is that the panel
//          never writes that file. The panel never reads the record's value, only that it is there.
//
// THE TWO ROUTES.
//
//   document  the starter as its author wrote it: S180 forks nine lanes, S181 leads to gate G50, and the rail from
//             S200 goes to S201 (`H-200-201`). The driver takes ONE edge out of a stage, in KIND order (sequence,
//             return, loop) and then document order — so this route measures what the executor does with the graph,
//             not what the graph's author drew.
//   loop      the same 24 stages and 4 gates, with S200's two `sequence` edges (`H-200-201`, `H-200-202`) removed, so
//             the declared `loop` edge `H-200-191` (`cap: "3 rounds, …"`) is the only way out of S200. This is the
//             control that makes the cap and the reader's `pipeline-release` reachable at all.
//
// Exit: 0 both routes ran and their ledgers were written; 1 a route did not reach a terminal state; 2 the harness
// could not run (no studio, no git, a bundle the panel refuses).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Assistant } from "../lib/assistant.js";
import { currentThread, readQueueFile } from "../lib/assistant/queue.js";
import { parseBundle } from "../lib/pipeline-bundle.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? fallback : fallback);
const WORK = path.resolve(opt("--work", path.join(os.tmpdir(), "wag-pipeline-poc-rounds")));
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = path.resolve(opt("--out", path.join(REPO, "docs", "reviews", `poc-rounds-execution-${TODAY}`)));
const ROUTE_ARG = String(opt("--route", "both")).toLowerCase();
const VERBOSE = argv.includes("--verbose");
// Resolved, never written as a literal: the starter is a SIBLING checkout, and a committed absolute path is the one
// thing tools/absolute-paths.mjs refuses (a landing is read on another machine).
const FACTORY = path.resolve(opt("--factory", path.join(REPO, "..", "..", "..", "ai-development-factory")));
const STUDIO_CORE = path.join(FACTORY, "tools", "pipeline-studio", "core.js");
const YAML = path.resolve(opt("--yaml", path.join(FACTORY, "docs", "pipeline", "language", "examples", "starters", "poc-breaking-rounds.yaml")));
const PIPELINE_ID = "poc-breaking-rounds";
const PROJECT = "poc-breaking-fixture";
const TASK_TITLE = "carry the POC-breaking rounds document through the pipeline";
const RUN_ID = "run-1";
const MAX_SWEEPS = Number(opt("--max-sweeps", "400")) || 400;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the document, through the studio's own reader and the panel's own loader -----------------------------------
const require = createRequire(import.meta.url);
function loadPipeline(route) {
  if (!existsSync(STUDIO_CORE)) throw new Error(`no pipeline studio at ${STUDIO_CORE} — pass --factory <dir>`);
  if (!existsSync(YAML)) throw new Error(`no starter at ${YAML} — pass --yaml <file>`);
  const core = require(STUDIO_CORE);
  const raw = readFileSync(YAML, "utf8");
  const doc = core.importDocument(raw);
  const exported = core.exportBundle(doc);
  const bundleDoc = JSON.parse(exported.files.pipeline);
  const removed = [];
  if (route === "loop") {
    // The control: only S200's RAIL edges go. The loop edge, every stage, every gate and the cap stay exactly as the
    // document declares them, so the route differs from `document` by the two edges and nothing else.
    for (const id of ["H-200-201", "H-200-202"]) {
      const at = bundleDoc.handoffs.findIndex((h) => h.id === id);
      if (at >= 0) removed.push(bundleDoc.handoffs.splice(at, 1)[0]);
    }
  }
  const parsed = parseBundle(bundleDoc, { file: YAML });
  if (!parsed.ok) throw new Error(`the panel's loader refused the exported bundle: ${parsed.code} — ${parsed.reason} (${parsed.where})`);
  const pipeline = parsed.bundle.pipelines[0];
  return {
    core,
    doc,
    pipeline,
    removed,
    source: { yaml: YAML, sha256: sha256(raw), lines: raw.split(/\r?\n/).length, bytes: Buffer.byteLength(raw) },
    exportSha256: sha256(exported.files.pipeline),
  };
}

// ---- one route --------------------------------------------------------------------------------------------------
async function runRoute(route) {
  const dir = path.join(WORK, `route-${route}`);
  const repo = path.join(dir, "repo");
  const state = { board: [], cuts: [], starts: [], live: new Map(), runs: [], exits: new Map(), prompts: [], seq: 0 };

  const loaded = loadPipeline(route);
  const pipeline = loaded.pipeline;

  // 1. The fixture: the document under test, committed, so the panel cuts a real branch off a real HEAD.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(repo, "docs", "pipeline"), { recursive: true });
  cpSync(YAML, path.join(repo, "docs", "pipeline", "poc-breaking-rounds.yaml"));
  // Only the worktrees directory is ignored: the artifacts the stages write (out/, ledger/, docs/reports/) are
  // COMMITTED, because a handoff is pinned to a commit and a blob, and an uncommitted artifact has neither.
  writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
  const GIT_ID = ["-c", "user.name=Round", "-c", `user.email=${["round", "example.invalid"].join(String.fromCharCode(64))}`];
  git("init", "-b", "main");
  git(...GIT_ID, "add", "-A");
  git(...GIT_ID, "commit", "-m", "fixture: the POC-breaking rounds document as the route finds it");
  const head = git("rev-parse", "--short", "HEAD");

  // 2. The bundle the panel drives. Validated by `parseBundle` above, before a single sweep.
  const bundleFile = path.join(dir, "pipeline-bundle.json");
  writeFileSync(bundleFile, `${JSON.stringify({ bundleVersion: 1, name: "poc-breaking-rounds", pipelines: [pipeline] }, null, 2)}\n`);

  // 3. The panel's own clock, with a spawner that runs a real process per stage.
  const jobs = {
    list: () => state.board,
    firstOfThread: (thread) => state.board.find((j) => j.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    get: (id) => state.board.find((j) => j.id === id) || null,
    create: async (opts) => ({ id: `job-${opts.thread || "x"}`, ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    clarify: { state: () => null },
    makeWorktree: async (repoDir, prompt, opts2 = {}) => {
      const slug = String(prompt || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24)
        .replace(/-+$/, "") || "agent";
      const tag = sha256(`${route}:${state.cuts.length}:${slug}`).slice(0, 6);
      const branch = `wtgui/${slug}-${tag}`;
      const treePath = path.join(repoDir, ".worktrees", `${slug}-${tag}`).replace(/\\/g, "/");
      const from = opts2.from || "HEAD";
      execFileSync("git", ["-C", repoDir, "worktree", "add", "-b", branch, treePath, from], { encoding: "utf8", windowsHide: true });
      state.cuts.push({ repoDir, prompt: String(prompt || "").slice(0, 200), branch, path: treePath, from, at: iso(Date.now()) });
      return { path: treePath, branch, startSha: head, startRef: from };
    },
  };

  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir, pipelineBundleFile: bundleFile },
    jobs,
    getProjects: () => [{ name: PROJECT, path: repo }],
    getRows: () => [],
    spawner: async (spec) => {
      const found = /\(([\w-]+)\/(S\d+)\), visit (\d+)/.exec(String(spec.prompt || ""));
      if (!found) throw new Error("the stage prompt carries no provenance line — nothing can tell this seat which stage it is in");
      const [, pipelineId, stageId, visit] = found;
      const stage = pipeline.stages.find((s) => s.id === stageId);
      if (!stage) throw new Error(`the prompt names stage ${stageId}, which the bundle does not hold`);
      state.seq += 1;
      const thread = `${route}-${String(state.seq).padStart(2, "0")}`;
      // The seat's round: a loop-body stage's visit IS its round (S191 writes `r{{round}}`, and the round brief is the
      // one artifact the loop re-enters on). Stages before the loop are round 1 on their only visit.
      const round = Number(visit) || 1;
      state.prompts.push({ stage: stageId, visit: Number(visit), round, prompt: String(spec.prompt || ""), target: spec.target });
      const job = {
        id: `job-${thread}`,
        thread,
        cwd: spec.target,
        worktreePath: spec.target,
        status: "running",
        startedAt: iso(Date.now()),
        assistantId: spec.assistantId || null,
        stage: stageId,
        visit: Number(visit),
      };
      state.board.push(job);
      state.live.set(thread, true);
      state.starts.push({ thread, stage: stageId, visit: Number(visit), round, at: iso(Date.now()) });
      const startedAt = Date.now();
      const child = spawn(
        process.execPath,
        [path.join(HERE, "pipeline-exec-stage-seat.mjs"), "--stage", stageId, "--artifact", stage.artifact.path, "--visit", String(visit), "--round", String(round), "--run", RUN_ID, "--pipeline", pipelineId, "--tree", spec.target],
        { cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (b) => (out += String(b)));
      child.stderr.on("data", (b) => (err += String(b)));
      const exited = new Promise((resolve) => {
        child.on("exit", (code) => {
          job.status = code === 0 ? "done" : "failed";
          job.finalMessage = code === 0 ? (out.trim().split("\n").at(-1) || "the stage finished") : `seat exited ${code}: ${err.trim().split("\n").at(-1) || ""}`;
          job.finishedAt = iso(Date.now());
          state.live.set(thread, false);
          state.runs.push({ route, thread, stage: stageId, visit: Number(visit), round, exit: code, ms: Date.now() - startedAt, line: out.trim().split("\n").at(-1) || "", stderr: err.trim().slice(0, 400) });
          resolve(code);
        });
      });
      state.exits.set(thread, exited);
      return job;
    },
    now: () => Date.now(),
  });
  assistant.settings.spawn = "auto";

  // 4. One row, on the document's first stage.
  const first = pipeline.stages[0].id;
  const added = assistant.queueMutate("assistant-1", "add", { title: TASK_TITLE, project: PROJECT, detail: "one tree, the document's own graph" });
  if (!added.ok) throw new Error(`the row was refused: ${added.error}`);
  const id = added.task.id;
  const assigned = assistant.queueMutate("assistant-1", "pipeline", { id, pipeline: PIPELINE_ID, stage: first });
  if (!assigned.ok) throw new Error(`the pipeline assignment was refused: ${assigned.error}`);

  const queueFile = assistant.queuePathOf(assistant.assistantRecord("assistant-1"));
  const rowOf = () => readQueueFile(queueFile).tasks.find((t) => Number(t.id) === Number(id)) || null;

  // 5. The gate decider's own seat: it writes the record only AFTER a park has been observed, into the tree the row
  //    is working in, and commits it. The panel never writes this file.
  const gateRecords = [];
  const writeGateRecord = (row, wait, step) => {
    const tree = (row.pipelineRun && row.pipelineRun.tree && row.pipelineRun.tree.path) || row.worktree;
    const run = row.pipelineRun || {};
    const round = (run.visits && run.visits[run.stage]) || 1;
    const rel = String(wait.path || "").replace(/\{\{run_id\}\}/g, RUN_ID).replace(/\{\{round\}\}/g, String(round));
    if (!tree || !rel) return null;
    const target = path.join(tree, ...rel.replace(/\\/g, "/").split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    const body = { gate: wait.gate, outcome: "APPROVED", decided_by: "pipeline-owner", pipeline: run.pipeline, stage: run.stage, round, reason: "the gate's own seat accepted the artifact the stage settled with" };
    const bytes = `${JSON.stringify(body, null, 2)}\n`;
    writeFileSync(target, bytes);
    execFileSync("git", ["-C", tree, "-c", "user.name=Gate Seat", "-c", `user.email=${["gate", "example.invalid"].join(String.fromCharCode(64))}`, "add", "--", rel], { windowsHide: true });
    execFileSync("git", ["-C", tree, "-c", "user.name=Gate Seat", "-c", `user.email=${["gate", "example.invalid"].join(String.fromCharCode(64))}`, "commit", "-m", `gate ${wait.gate}: APPROVED at round ${round}`], { windowsHide: true, encoding: "utf8" });
    const record = { gate: wait.gate, path: rel, at: iso(Date.now()), step, sha256: sha256(bytes), round };
    gateRecords.push(record);
    return record;
  };

  // 6. Sweep until the row parks somewhere no record can release, or walks off the end of the document.
  const steps = [];
  const parks = [];
  const releases = [];
  let terminal = null;
  let startedThisPass = 0;
  let unsettledLast = 0;
  const lastStage = pipeline.stages[pipeline.stages.length - 1].id;
  for (let step = 1; step <= MAX_SWEEPS; step += 1) {
    const before = rowOf();
    const beforeThread = before ? currentThread(before) : null;
    const beforeRuns = state.prompts.length;
    assistant.sweepQueues();
    await sleep(70);
    if (state.prompts.length > beforeRuns) {
      const startedThread = state.starts[state.starts.length - 1].thread;
      if (state.exits.has(startedThread)) await state.exits.get(startedThread);
      await sleep(40);
    }
    const row = rowOf();
    const thread = row ? currentThread(row) : null;
    const run = row && row.pipelineRun ? row.pipelineRun : null;
    const stageRuns = run && Array.isArray(run.stageRuns) ? run.stageRuns : [];
    const current = run && run.stage ? stageRuns.filter((s) => s.stage === run.stage && s.status === "done").at(-1) : null;
    steps.push({
      step,
      state: row ? row.state : null,
      stage: run ? run.stage : null,
      visit: run && run.visits && run.stage ? run.visits[run.stage] ?? null : null,
      crossings: run ? run.crossings || {} : null,
      thread: thread !== beforeThread ? thread : null,
      live: Boolean(thread && state.live.get(thread)),
      gate: current && current.decision && current.decision.code ? current.decision.code : null,
      reason: row ? row.reason || null : null,
    });
    if (VERBOSE) { const mine = state.board.filter((j) => String(j.thread || "") === String(thread || "")); console.error(`[${route}] step ${step}: ${row ? row.state : "gone"} ${run ? run.stage : ""} visit ${run && run.visits && run.stage ? run.visits[run.stage] : ""} ${thread !== beforeThread ? `+${thread}` : ""} board=${mine.map((j) => `${j.id}:${j.status}`).join(",") || "none"} ${row && row.reason ? `— ${row.reason.slice(0, 110)}` : ""}`); }
    startedThisPass = state.prompts.length;

    if (row && row.state === "parked") {
      const wait = run && run.waitingFor ? run.waitingFor : null;
      const code = (stageRuns.filter((s) => s.decision && s.decision.code).at(-1) || {}).decision || null;
      const parkCode = code ? code.code : null;
      const record = { step, stage: run ? run.stage : null, visit: run && run.visits && run.stage ? run.visits[run.stage] : null, code: parkCode, reason: row.reason || null, waitingFor: wait, crossings: run ? run.crossings || {} : null };
      if (!parks.some((p) => p.step === step && p.reason === record.reason)) parks.push(record);
      if (wait && wait.kind === "gate") {
        if (!gateRecords.some((g) => g.path === wait.path)) {
          writeGateRecord(row, wait, step);
          continue;
        }
        // The record is there and the row is still parked on the gate: the barrier did not release. That is a
        // finding, so it is recorded and the sweep loop moves on rather than spinning.
        record.unreleased = true;
        terminal = { kind: "parked", code: parkCode || "pipeline-gate", reason: row.reason || "", stage: run ? run.stage : null };
        break;
      }
      if (wait && wait.kind === "cap" && route === "loop" && !releases.some((r) => r.edge === wait.edge)) {
        const at = new Date(Date.now());
        const released = assistant.queueMutate("assistant-1", "pipeline-release", { id, release: "cap" });
        releases.push({
          edge: wait.edge,
          from: wait.from,
          to: wait.to,
          limit: wait.limit,
          used: wait.used,
          at: at.toISOString(),
          ok: Boolean(released && released.ok),
          error: released && released.ok ? null : String(released && released.error || "no answer"),
          crossingsAfter: released && released.ok && released.task && released.task.pipelineRun ? released.task.pipelineRun.crossings : null,
          stageAfter: released && released.ok && released.task && released.task.pipelineRun ? released.task.pipelineRun.stage : null,
          stateAfter: released && released.ok && released.task ? released.task.state : null,
        });
        continue;
      }
      terminal = { kind: "parked", code: parkCode || (wait && wait.kind) || null, reason: row.reason || "", stage: run ? run.stage : null };
      break;
    }

    // The document's own end: the last stage's run has settled and the settle has nothing to advance to. The row stays
    // `running` because a pipeline row with a tree is done when that tree's PR reads MERGED — there is no PR here.
    //
    // A SECOND answer is possible and it is the one this route actually gets: the settle happened IN MEMORY and was
    // dropped, because `sweepQueues` only writes the queue file when something moved or a start was asked for, and at
    // the last stage neither happens. Three consecutive passes with the thread's job `done` and the stage run still
    // unsettled is that defect observed, not a slow settle.
    if (run && run.stage === lastStage) {
      const settledLast = stageRuns.some((s) => s.stage === lastStage && s.status === "done");
      const job = thread ? state.board.filter((j) => String(j.thread || "") === String(thread || "")).at(-1) : null;
      const jobDone = Boolean(job) && String(job.status || "").toLowerCase() === "done" && !state.live.get(thread);
      if (settledLast && jobDone) {
        terminal = { kind: "end-of-document", code: null, reason: row.reason || null, stage: run.stage, after: state.prompts.length };
        break;
      }
      if (!settledLast && jobDone) {
        unsettledLast += 1;
        if (unsettledLast >= 3) {
          terminal = {
            kind: "settle-dropped",
            code: "pipeline-settle-unwritten",
            reason: `the last stage ${lastStage} ran (job ${job.id} reads done) and the driver settled it in memory, but the row is still ${row.state} and ${lastStage}'s stage run still reads status ${JSON.stringify((stageRuns.find((s) => s.stage === lastStage) || {}).status ?? null)} after ${unsettledLast} consecutive passes — the settle was never written`,
            stage: run.stage,
            after: state.prompts.length,
            job: job.id,
          };
          break;
        }
      }
    }
    if (!row) {
      terminal = { kind: "gone", code: null, reason: null, stage: null };
      break;
    }
  }
  if (!terminal) terminal = { kind: "sweep-budget", code: null, reason: `stopped after ${MAX_SWEEPS} sweeps`, stage: rowOf()?.pipelineRun?.stage || null };

  // 7. The ledger: what the record holds, what the tree holds, and whether the two agree.
  const row = rowOf();
  const run = row && row.pipelineRun ? row.pipelineRun : null;
  const stageRuns = (run && Array.isArray(run.stageRuns) ? run.stageRuns : []).map((s) => ({
    id: s.id,
    stage: s.stage,
    visit: s.visit,
    enteredAt: s.at || null,
    settledAt: s.settledAt || null,
    thread: s.thread || null,
    job: s.job || null,
    status: s.status || null,
    via: s.via || null,
    commit: s.commit || null,
    tree: s.tree ? { path: s.tree.path, branch: s.tree.branch, head: s.tree.head, dirty: s.tree.dirty } : null,
    artifact: s.artifact ? { id: s.artifact.id, path: s.artifact.path, present: s.artifact.present, sha256: s.artifact.sha256, bytes: s.artifact.bytes || null, commit: s.artifact.commit || null, blob: s.artifact.blob || null, blobSha256: s.artifact.blobSha256 || null, unchanged: s.artifact.unchanged || false, uncommitted: s.artifact.uncommitted || false } : null,
    inputs: Array.isArray(s.inputs) ? s.inputs.map((i) => ({ artifact: i.artifact, path: i.path, present: i.present, sha256: i.sha256, edge: i.edge, via: i.via, commit: i.commit, blob: i.blob })) : [],
    inputsDropped: s.inputsDropped || 0,
    decision: s.decision ? { code: s.decision.code || null, by: s.decision.by, trigger: s.decision.trigger, reason: s.decision.reason, fact: s.decision.fact || null } : null,
  }));

  // The byte comparison between visits of ONE stage: the ledger's own two hashes, plus the file on disk today. A stage
  // visited once has nothing to compare with, and that absence is a fact about the route, not a missing measurement.
  const treePath = run && run.tree ? run.tree.path : null;
  const visitsOf = {};
  for (const entry of stageRuns) {
    visitsOf[entry.stage] = visitsOf[entry.stage] || [];
    visitsOf[entry.stage].push({ visit: entry.visit, sha256: entry.artifact ? entry.artifact.sha256 : null, blobSha256: entry.artifact ? entry.artifact.blobSha256 : null, present: entry.artifact ? entry.artifact.present : null, commit: entry.commit, path: entry.artifact ? entry.artifact.path : null });
  }
  const comparisons = Object.entries(visitsOf)
    .filter(([, list]) => list.length > 1)
    .map(([stage, list]) => {
      const ordered = [...list].sort((a, b) => a.visit - b.visit);
      const out = [];
      for (let i = 1; i < ordered.length; i += 1) {
        const prev = ordered[i - 1];
        const now = ordered[i];
        out.push({ stage, from: prev.visit, to: now.visit, same_sha256: Boolean(prev.sha256 && now.sha256 && prev.sha256 === now.sha256), before: prev.sha256, after: now.sha256, same_blob: Boolean(prev.blobSha256 && now.blobSha256 && prev.blobSha256 === now.blobSha256) });
      }
      return out;
    })
    .flat();

  let worktrees = [];
  try {
    worktrees = git("worktree", "list", "--porcelain").split(/\r?\n\r?\n/).filter(Boolean).map((block) => (/^worktree (.+)$/m.exec(block) || [])[1]).filter(Boolean);
  } catch { /* a fixture git that will not answer is recorded as empty, never invented */ }

  const ledger = {
    route,
    generatedAt: iso(Date.now()),
    source: loaded.source,
    document: { stages: pipeline.stages.length, handoffs: pipeline.handoffs.length, gates: pipeline.gates.length, loop_edges: pipeline.handoffs.filter((h) => h.kind === "loop").map((h) => ({ id: h.id, from: h.from, to: h.to, cap: h.cap })) },
    bundle: { export_sha256: loaded.exportSha256, pipeline: PIPELINE_ID, removed_edges: loaded.removed.map((h) => h.id) },
    fixture: { repo: repo.replace(/\\/g, "/"), head, worktrees: worktrees.length },
    row: {
      id,
      title: row?.title || null,
      state: row?.state || null,
      reason: row?.reason || null,
      stage: run ? run.stage : null,
      via: run ? run.via || null : null,
      visits: run ? run.visits || null : null,
      crossings: run ? run.crossings || {} : null,
      tree: run ? run.tree || null : null,
      waitingFor: run ? run.waitingFor || null : null,
      stageRuns: stageRuns.length,
    },
    cuts: state.cuts,
    starts: state.starts,
    stageRuns,
    parks,
    gateRecords,
    releases,
    comparisons,
    worktrees,
    terminal,
    steps,
    prompts: state.prompts,
    journal: assistant.journal.filter((line) => ["queue", "pipeline", "pipeline-failed"].includes(line.kind)).map((line) => ({ at: line.at, kind: line.kind, text: line.text })),
  };
  return { ledger, dir, repo };
}

// ---- main -------------------------------------------------------------------------------------------------------
const portable = (value, dirs) => {
  let text = JSON.stringify(value, null, 2);
  for (const [from, to] of dirs) {
    if (!from) continue;
    const B = String.fromCharCode(92);
    const forms = [from.split(B).join(B + B), from.split(B).join("/"), from.split("/").join(B)];
    for (const form of forms) text = text.split(form).join(to);
  }
  return text;
};

async function main() {
  // `--compare-only` writes the summary from two ledgers already on disk. The routes are separate processes on
  // purpose (a second route shares nothing with the first but the document), so the comparison is a read, not a run.
  if (ROUTE_ARG === "both" && !argv.includes("--compare-only")) {
    for (const route of ["document", "loop"]) {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--route", route, "--work", WORK, "--out", OUT, ...(VERBOSE ? ["--verbose"] : [])], { stdio: "inherit", cwd: REPO });
    }
  }
  if (ROUTE_ARG === "both") {
    const read = (r) => JSON.parse(readFileSync(path.join(OUT, "routes", `route-${r}.json`), "utf8"));
    const doc = read("document");
    const loop = read("loop");
    const oneTree = (l) => l.cuts.length === 1 && l.stageRuns.every((s) => (s.tree && s.tree.path) === (l.row.tree && l.row.tree.path));
    const summary = {
      generatedAt: iso(Date.now()),
      document: {
        route: doc.route,
        source: doc.source,
        document: doc.document,
        terminal: doc.terminal,
        row: { state: doc.row.state, stage: doc.row.stage, visits: doc.row.visits, crossings: doc.row.crossings, tree: doc.row.tree, stageRuns: doc.row.stageRuns },
        stageRuns: doc.stageRuns,
        cuts: doc.cuts,
        parks: doc.parks,
        gates: doc.gateRecords,
        releases: doc.releases,
        comparisons: doc.comparisons,
        steps: doc.steps,
        stages_visited: Object.keys(doc.row.visits || {}).length,
        stages_declared: doc.document.stages,
        one_tree: oneTree(doc),
        worktrees: doc.worktrees,
      },
      loop: {
        route: loop.route,
        source: loop.source,
        document: loop.document,
        terminal: loop.terminal,
        row: { state: loop.row.state, stage: loop.row.stage, visits: loop.row.visits, crossings: loop.row.crossings, tree: loop.row.tree, stageRuns: loop.row.stageRuns },
        stageRuns: loop.stageRuns,
        cuts: loop.cuts,
        parks: loop.parks,
        gates: loop.gateRecords,
        releases: loop.releases,
        comparisons: loop.comparisons,
        steps: loop.steps,
        stages_visited: Object.keys(loop.row.visits || {}).length,
        stages_declared: loop.document.stages,
        one_tree: oneTree(loop),
        worktrees: loop.worktrees,
      },
      same_document: doc.source.sha256 === loop.source.sha256 && doc.document.stages === loop.document.stages && doc.document.gates === loop.document.gates && doc.bundle.removed_edges.length === 0,
      checks: {
        document_one_tree: oneTree(doc),
        loop_one_tree: oneTree(loop),
        document_stages_visited: Object.keys(doc.row.visits || {}).length,
        document_stages_declared: doc.document.stages,
        document_cap_crossings: (doc.row.crossings || {})["H-200-191"] || 0,
        loop_cap_crossings: (loop.row.crossings || {})["H-200-191"] || 0,
        loop_cap_park: loop.parks.some((p) => p.code === "pipeline-cap"),
        loop_cap_released: loop.releases.some((r) => r.ok),
        loop_gate_parks: loop.parks.filter((p) => p.code === "pipeline-gate").length,
        loop_artifact_visits_differ: loop.comparisons.length > 0 && loop.comparisons.every((c) => !c.same_sha256),
        document_last_stage_settled: doc.stageRuns.some((s) => s.stage === doc.row.stage && s.status === "done"),
      },
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ summary: { document: summary.document.terminal, loop: summary.loop.terminal, documentStages: summary.document.stages_visited, loopStages: summary.loop.stages_visited } }));
    return;
  }
  if (!["document", "loop"].includes(ROUTE_ARG)) throw new Error(`unknown route ${JSON.stringify(ROUTE_ARG)} — document, loop or both`);
  const { ledger, dir } = await runRoute(ROUTE_ARG);
  mkdirSync(path.join(OUT, "routes"), { recursive: true });
  writeFileSync(path.join(OUT, "routes", `route-${ROUTE_ARG}.json`), `${portable(ledger, [[path.join(dir, "repo"), "<repo>"], [dir, "<route>"], [WORK, "<work>"], [FACTORY, "<factory>"], [REPO, "<panel>"]])}\n`);
  console.log(JSON.stringify({ route: ROUTE_ARG, state: ledger.row.state, stage: ledger.row.stage, visits: ledger.row.visits, crossings: ledger.row.crossings, runs: ledger.row.stageRuns, cuts: ledger.cuts.length, parks: ledger.parks.length, gates: ledger.gateRecords.length, terminal: ledger.terminal }));
  if (!ledger.terminal || ledger.terminal.kind === "sweep-budget") process.exit(1);
}

await main().catch((err) => {
  console.error(`pipeline-exec-poc-rounds: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
