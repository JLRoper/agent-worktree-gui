#!/usr/bin/env node
// HARNESS: LIVE GATE
// A PIPELINE WALKS BY ITSELF. Every stage boundary is crossed by the panel's own clock — `Assistant.sweepQueues` —
// with no hand-start, no second sweep of a person and no bespoke executor.
//
// The unit tests pin the driver (test/task-pipeline-drive.test.js) and the wiring (test/task-pipeline-walk.test.js).
// This run is the whole thing on the three SHIPPED small documents, read out of `pipeline-bundle.seed.json` so the
// document under test is the one the reader's dropdown offers:
//
//   ping-pong            draft ⇄ critique, H-02 capped at "3 rounds" — four entries into each stage, three crossings,
//                        then the cap park. The loop is the hardest case: every crossing re-enters a stage the row
//                        has already been through.
//   probe-fix            probe → fix, one sequence edge, then the last settle finishes the row on the landing rule.
//   author-review-revise author → review, a gate that ROUTES a verdict (`reject` back to the author, twice, then
//                        `accept` on to the reviser) → revise. A sequence, a capped loop and a gate, in one walk.
//
// WHAT IS REAL HERE:
//   - `Assistant.sweepQueues` — the panel's clock: the bundle read, `driveTaskPipelines`, the `settleTasks` pass, the
//     one `writeQueueFile`, the journal, and the tree cut through `jobs.makeWorktree`.
//   - the queue file on disk: every row this run reads back came through the panel's own writer.
//   - the graph, the caps, the gate routing and the artifact gate: all read from the seed document.
//
// WHAT IS A SEAT: the model. There is no gateway and no token — the spawner is a scripted seat with a stated remit.
// It learns which stage it is in from the provenance line the DRIVER wrote into its prompt (it is handed nothing
// else), writes the stage's declared artifact into that tree, and returns the job record a gateway would return.
// For `author-review-revise` the seat also decides the gate: reject for the first two reviews, accept for the third.
//
//   node tools/verify-pipeline-walk.mjs                     run all three, write the ledger + the report
//   node tools/verify-pipeline-walk.mjs --only ping-pong    one pipeline
//   node tools/verify-pipeline-walk.mjs --out <dir>         where the ledger and the report go
//   WALK_KEEP=1 node tools/verify-pipeline-walk.mjs         keep the sandbox trees
//
// Exit: 0 every walk matched its document; 1 a walk did not; 2 the harness could not run.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Assistant } from "../lib/assistant.js";
import { Jobs } from "../lib/jobs.js";
import { PipelineRecords, cutPipeline } from "../lib/pipelines.js";
import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";
import { REPORT_FOOTER_CSS, reportFooter, resolveReportProvenance } from "../lib/report-footer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? fallback : fallback);
const OUT = path.resolve(opt("--out", path.join(REPO, "docs", "reviews", "pipeline-walk")));
const ONLY = String(opt("--only", "")).trim();
const KEEP = String(process.env.WALK_KEEP || "") === "1";
const SEED = path.join(REPO, "pipeline-bundle.seed.json");
// The registry entry the panel cuts in. The seat below performs the cut itself, so the path is the checkout this
// tool runs from — never a folder on the machine that wrote it (`tools/absolute-paths.mjs`).
const PROJECT = { name: "agent-worktree-gui", path: path.resolve(REPO) };
const CLOCK = Date.parse("2026-11-05T12:00:00.000Z");
const TICK_BUDGET = 40;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

let checks = 0;
let failures = 0;
const check = (ok, what, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
};

const seed = JSON.parse(readFileSync(SEED, "utf8"));
const wanted = (ONLY ? ONLY.split(",").map((s) => s.trim()) : ["ping-pong", "probe-fix", "author-review-revise"]).filter(Boolean);

// ---- one walk ----------------------------------------------------------------------------------------------------
// One Assistant, one queue row, one scripted seat, and the panel's own sweep between every stage. The seat's own
// decisions (which band of `author-review-revise` to write) are recorded in the ledger beside the row's, so the report
// can say who decided what.
async function walk(pipelineId, { leftover = false, timer = false, restartAt = 0 } = {}) {
  const doc = { bundleVersion: 1, name: pipelineId, pipelines: seed.pipelines.filter((p) => p.id === pipelineId) };
  if (!doc.pipelines.length) throw new Error(`the seed holds no pipeline "${pipelineId}"`);
  const tree = doc.pipelines[0];
  const dir = mkdtempSync(path.join(os.tmpdir(), `wag-walk-${pipelineId}-`));
  const bundleFile = path.join(dir, "pipeline-bundle.json");
  writeFileSync(bundleFile, JSON.stringify(doc));
  const state = { board: [], started: [], cuts: [], prompts: [], verdicts: [], tree: path.join(dir, "trees", `walk-${pipelineId}`), clock: CLOCK };
  let jobNo = 0;
  // THE WAIT BOOK, for the timer walk. It is the panel's own book, on a real file: `holdPipelineStageRun` is what the
  // cut writes and `sweepPipelineWaits` is what the panel's ticker runs. The driver walk above needs none of it.
  const recordsFile = path.join(dir, "pipeline-records.json");
  let records = timer ? new PipelineRecords({ file: recordsFile }) : null;
  let book = null;
  let holds = [];
  const newBook = () => {
    const made = new Jobs({ config: { jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir }, onLog: () => {} });
    made.pipelineRecords = records;
    // The card's own answer, from the seat's board: the panel's store would hold the same objects after a restart.
    made.get = (id) => state.board.find((j) => String(j.id) === String(id)) || null;
    const write = made.holdPipelineStageRun.bind(made);
    made.holdPipelineStageRun = (args) => {
      holds.push({ stage: args.stage, visit: args.visit, job: args.job, pipeline: args.pipeline });
      return write(args);
    };
    return made;
  };
  if (timer) book = newBook();
  const jobs = {
    list: () => state.board,
    firstOfThread: (thread) => state.board.find((j) => j.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    create: async (opts) => ({ id: "job-created", ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    get: (id) => state.board.find((j) => String(j.id) === String(id)) || null,
    clarify: { state: () => null },
    // The book, seen through the store the Assistant holds: the hold is written where the sweep will read it, and the
    // driver is told which rows the book owns.
    ...(timer ? { pipelineRecordFor: (t) => records.get(t, { fresh: true }), holdPipelineStageRun: (args) => book.holdPipelineStageRun(args) } : {}),
    makeWorktree: async (repoDir, prompt) => {
      state.cuts.push({ repoDir, prompt });
      mkdirSync(state.tree, { recursive: true });
      // A cut writes the tree's LOCAL rung before the first turn exists (lib/jobs.js `recordCutPipeline`); the hold then
      // rides on that record. The stub makes the same write, because the book is the point of this walk.
      if (timer && !records.get(state.tree, { fresh: true })) records.set(state.tree, cutPipeline({ at: new Date(state.clock).toISOString() }));
      return { path: state.tree, branch: `wtgui/walk-${pipelineId}`, startSha: null };
    },
  };
  const makeAssistant = () =>
    new Assistant({
      config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir, pipelineBundleFile: bundleFile },
      jobs,
      getProjects: () => [PROJECT],
      // The landing rule, satisfied up front: this walk is about the graph, not about the merge a real tree would earn.
      getRows: () => [{ path: state.tree, verdict: "MERGED" }],
      spawner: async (spec) => {
        const found = /\(([\w.-]+)\/([\w.-]+)\)(?:, visit (\d+))?/.exec(spec.prompt);
        if (!found) throw new Error(`the stage prompt names no stage: ${spec.prompt.slice(0, 160)}`);
        const [, pipeline, id, visit] = found;
        const stage = tree.stages.find((s) => s.id === id);
        if (!stage || !stage.artifact) throw new Error(`${pipeline}/${id} declares no artifact`);
        const file = path.join(spec.target, stage.artifact.path);
        mkdirSync(path.dirname(file), { recursive: true });
        const body = `${pipeline}/${id} visit ${visit}\nwritten by the seat at ${new Date(state.clock).toISOString()}\n`;
        writeFileSync(file, body);
        // The seat's gate decision: the reviewer rejects twice, then accepts. Written where the gate's document says
        // the record lives, because that file — not a press — is what crosses a gate (§6.1).
        const gate = (tree.gates || []).find((g) => g.after === id && g.decision);
        if (gate) {
          const outcome = Number(visit) >= 3 ? "accept" : "reject";
          const record = path.join(spec.target, gate.decision.path);
          mkdirSync(path.dirname(record), { recursive: true });
          writeFileSync(record, `${JSON.stringify({ outcome, gate: gate.id, at: new Date(state.clock).toISOString() }, null, 1)}\n`);
          state.verdicts.push({ stage: id, visit: Number(visit), gate: gate.id, outcome, file: gate.decision.path });
        }
        jobNo += 1;
        const job = { id: `job-${jobNo}`, thread: `walk-${pipelineId}-${jobNo}`, cwd: spec.target, worktreePath: spec.target, status: "running", startedAt: new Date(state.clock).toISOString() };
        state.started.push({ pipeline, stage: id, visit: Number(visit), job: job.id, thread: job.thread, artifact: stage.artifact.path, sha256: sha256(body) });
        state.prompts.push(spec.prompt);
        state.board.push(job);
        return job;
      },
      now: () => state.clock,
    });
  let assistant = makeAssistant();
  assistant.settings.spawn = "auto";

  const added = assistant.queueMutate("assistant-1", "add", { title: `walk ${pipelineId}`, project: PROJECT.name });
  if (!added.ok) throw new Error(added.error);
  const id = added.task.id;
  const put = assistant.queueMutate("assistant-1", "pipeline", { id, pipeline: pipelineId, stage: tree.stages[0].id });
  if (!put.ok) throw new Error(put.error);
  const queueFile = assistant.queuePathOf(assistant.assistantRecord("assistant-1"));
  const rowOf = () => readQueueFile(queueFile).tasks.find((t) => t.id === id) || null;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // The leftover: the panel was killed between the first stage's settle and the pass that reads it, so the queue file
  // is left with a row that reads `queued` over a stage run that settled `done` and carries no decision. Written
  // through the queue's own writer, in the queue's own shape — no test-only field, no in-process shortcut.
  const leaveLeftover = () => {
    const out = readQueueFile(queueFile);
    const task = out.tasks.find((t) => t.id === id);
    const run = task.pipelineRun.stageRuns.at(-1);
    const tasks = out.tasks.map((t) =>
      t.id !== id
        ? t
        : {
            ...t,
            state: "queued",
            thread: run.thread,
            hold: null,
            reason: "left queued: the panel restarted between the settle and the read",
            pipelineRun: { ...t.pipelineRun, stageRuns: t.pipelineRun.stageRuns.map((r) => (r.id === run.id ? { ...r, status: "done", settledAt: new Date(state.clock).toISOString(), decision: null } : r)) },
          },
    );
    writeQueueFile(queueFile, tasks, out.nextId);
    return run;
  };

  // The seat works between two ticks: the sweep that judges a stage always sees a settled job and a linked row.
  const steps = [];
  for (let step = 1; step <= TICK_BUDGET; step += 1) {
    const live = state.board.filter((j) => j.status === "running").at(-1);
    if (live) live.status = "done";
    // The leftover is written once, after the first stage settled and before the pass that would read it.
    if (leftover && step === 3) {
      const run = leaveLeftover();
      state.leftover = { stage: run.stage, thread: run.thread, at: new Date(state.clock).toISOString() };
    }
    const before = rowOf();
    state.clock += 1000;
    // THE RESTART, mid-wait: a fresh book and a fresh Assistant over the same FILES, between the settle and the pass that
    // reads it. Nothing of the first process is in memory afterwards, so the hold the next tick acts on can only have
    // come out of the book — and the stage is started once, not twice.
    if (timer && restartAt && step === restartAt) {
      state.restart = {
        at: step,
        stage: before && before.pipelineRun ? before.pipelineRun.stage : null,
        visit: before && before.pipelineRun ? (before.pipelineRun.visits || {})[before.pipelineRun.stage] : null,
        started: state.started.length,
        holds: holds.length,
      };
      records = new PipelineRecords({ file: recordsFile });
      book = newBook();
      assistant = makeAssistant();
      assistant.settings.spawn = "auto";
    }
    let out = null;
    if (timer) {
      if (state.started.length === 0) {
        // Nothing has been cut yet, so there is no run to hold: this is the panel's ordinary queue tick — the tree is cut
        // on one pass and its first stage started on the next — and it is the only one this walk takes.
        assistant.sweepQueues();
      } else {
        out = await book.sweepPipelineWaits({
          now: state.clock,
          readReview: () => ({ ok: false, why: "a hold reads the job store, not the host" }),
          wake: () => ({ ok: true }),
          advance: () => assistant.advancePipelineTree(state.tree),
        });
      }
    } else {
      assistant.sweepQueues();
    }
    await tick();
    await tick();
    await tick();
    const row = rowOf();
    steps.push({
      step,
      mode: timer ? (state.started.length === 0 ? "queue" : "timer") : "queue",
      state: row.state,
      stage: row.pipelineRun ? row.pipelineRun.stage : null,
      stageRun: row.pipelineRun && (row.pipelineRun.stageRuns || []).length ? row.pipelineRun.stageRuns.at(-1).id : null,
      visits: row.pipelineRun ? row.pipelineRun.visits || {} : {},
      crossings: row.pipelineRun ? row.pipelineRun.crossings || {} : {},
      started: state.started.length,
      from: before ? before.state : null,
      held: out ? out.held : null,
      advanced: out ? out.advanced : null,
      checked: out ? out.checked : null,
    });
    if (row.state === "parked" || row.state === "done") break;
  }
  const row = rowOf();
  const ledger = {
    pipeline: leftover ? `${pipelineId}:leftover` : timer ? `${pipelineId}:timer` : pipelineId,
    // The clock the row walked on. `queue` is the panel's ordinary dispatch; `timer` is the wait book's own tick, with the
    // assistant's queue untouched between boundaries — the point of the timer walk.
    mode: timer ? "timer" : "queue",
    // Every hold the CUT wrote: the row's stage and the run it named. A timer walk must write one per boundary, and the
    // restart's hold must be the one the fresh book acted on.
    holds: timer ? holds : [],
    restart: timer && restartAt ? state.restart || null : null,
    document: pipelineId,
    title: tree.title,
    stages: tree.stages.map((s) => s.id),
    handoffs: (tree.handoffs || []).map((h) => ({ id: h.id, from: h.from, to: h.to, kind: h.kind || "sequence", cap: h.cap || null })),
    gates: (tree.gates || []).map((g) => ({ id: g.id, after: g.after, decision: g.decision ? { path: g.decision.path, routes: g.decision.routes } : null })),
    // Normalised the way a committed ledger has to be: the sandbox belongs to this run, and a reader on another machine
    // must not be handed a directory that does not exist for them (`tools/absolute-paths.mjs`).
    tree: `<sandbox>/trees/${path.basename(state.tree)}`,
    cuts: state.cuts.length,
    starts: state.started,
    seatVerdicts: state.verdicts,
    row: {
      id,
      state: row.state,
      stage: row.pipelineRun ? row.pipelineRun.stage : null,
      visits: row.pipelineRun ? row.pipelineRun.visits || {} : {},
      crossings: row.pipelineRun ? row.pipelineRun.crossings || {} : {},
      waitingFor: row.pipelineRun ? row.pipelineRun.waitingFor || null : null,
      reason: row.reason || null,
    },
    stageRuns: (row.pipelineRun.stageRuns || []).map((s) => ({
      id: s.id,
      stage: s.stage,
      visit: s.visit,
      thread: s.thread || null,
      job: s.job || null,
      status: s.status || null,
      settledAt: s.settledAt || null,
      artifact: s.artifact ? { path: s.artifact.path, present: s.artifact.present, sha256: s.artifact.sha256 } : null,
      decision: s.decision ? { trigger: s.decision.trigger, code: s.decision.code || null, by: s.decision.by, reason: s.decision.reason } : null,
    })),
    journal: assistant.journal.filter((line) => line.kind === "queue" || line.kind === "pipeline").map((line) => ({ at: line.at, kind: line.kind, text: line.text })),
    steps,
  };
  clearTimeout(assistant.persistTimer);
  if (assistant.timer) clearInterval(assistant.timer);
  if (book) clearTimeout(book.persistTimer);
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
  // Every string in the ledger is scrubbed of this run's sandbox: the journal lines quote the tree, and a committed
  // file must not name a folder on the machine that wrote it (`tools/absolute-paths.mjs`).
  const sandbox = dir.replace(/\\/g, "/");
  const scrubText = (value) => String(value).split(dir).join("<sandbox>").split(sandbox).join("<sandbox>");
  const scrub = (value) =>
    typeof value === "string" ? scrubText(value) : Array.isArray(value) ? value.map(scrub) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) : value;
  return scrub(ledger);
}

// ---- what each document is supposed to do ------------------------------------------------------------------------
// The expectation is the DOCUMENT's, not the code's: stage order, visits, crossings and the end state, read off the
// seed graph. A walk that only matches itself would prove nothing.
function expectWalk(ledger) {
  const stages = ledger.starts.map((s) => s.stage);
  if (ledger.pipeline === "ping-pong:timer") {
    // THE TIMER WALK: after the panel's ordinary dispatch cut the tree and started the first stage, every boundary was
    // crossed by `sweepPipelineWaits` alone — no `Assistant.sweepQueues()` between them, and the assistant's queue file
    // was written only by the advance the wait book asked for.
    const timerSteps = (ledger.steps || []).filter((s) => s.mode === "timer");
    check(ledger.cuts === 1, "the timer walk cuts one tree and every stage runs in it", `${ledger.cuts} cut(s)`);
    check(stages.join(",") === "draft,critique,draft,critique,draft,critique,draft,critique", "the panel's TIMER alone walks draft ⇄ critique through three visits, with the queue untouched", stages.join(","));
    check(timerSteps.filter((s) => s.advanced).length === 8, "every boundary after the first start — seven stage moves and the cap park — was an advance the wait book made", `${timerSteps.filter((s) => s.advanced).length} timer advance(s)`);
    check(ledger.holds.length === 8, "the cut wrote a hold for every run, and each one names its run", `${ledger.holds.length} hold(s)`);
    check(ledger.holds.every((h) => h.stage && h.job), "every hold names a stage AND the job that works it", JSON.stringify(ledger.holds[0] || null));
    check(JSON.stringify(ledger.starts.map((s) => s.visit)) === JSON.stringify([1, 1, 2, 2, 3, 3, 4, 4]), "each entry is its own numbered visit", JSON.stringify(ledger.starts.map((s) => s.visit)));
    check(JSON.stringify(ledger.row.visits) === JSON.stringify({ draft: 4, critique: 4 }), "three loop rounds enter each stage four times", JSON.stringify(ledger.row.visits));
    check(Number(ledger.row.crossings["H-02"]) === 3, "the back edge was crossed its cap's three times", JSON.stringify(ledger.row.crossings));
    check(ledger.row.state === "parked" && ledger.row.waitingFor && ledger.row.waitingFor.kind === "cap", "a cap still stops the timer's walk", ledger.row.state);
    check(/at its cap of 3 rounds/.test(String(ledger.row.reason)), "and the park names the cap and the edge", ledger.row.reason);
    // The restart: a fresh book and a fresh Assistant over the same files, mid-wait.
    const restart = ledger.restart;
    check(Boolean(restart) && restart.at > 1, "the walk restarted mid-wait, from the files alone", restart ? `at step ${restart.at}, stage ${restart.stage}` : "no restart");
    if (restart) {
      const after = ledger.starts.slice(restart.started);
      check(after.length === ledger.starts.length - restart.started, "the restarted panel started every remaining stage once", `${after.length} start(s) after the restart`);
      check(new Set(after.map((s) => `${s.stage}#${s.visit}`)).size === after.length, "and no stage was started twice across the restart", after.map((s) => `${s.stage}#${s.visit}`).join(","));
      check(ledger.holds.length - restart.holds === after.length, "every start after the restart wrote its own hold", `${ledger.holds.length - restart.holds} hold(s) after, ${after.length} start(s)`);
    }
    return;
  }
  if (ledger.pipeline.endsWith(":leftover")) {
    // The row was left `queued` over a stage whose run had settled. Re-running that stage is the stall; reading the
    // settle off the ledger and moving to the graph's next stage is the fix.
    check(stages.join(",") === "probe,fix", "a row left queued over a settled stage advances, and does not run that stage again", stages.join(","));
    check(ledger.starts.filter((s) => s.stage === "probe").length === 1, "probe was not started a second time", `${ledger.starts.filter((s) => s.stage === "probe").length} probe start(s)`);
    check(Number(ledger.row.visits.probe) === 1, "reading the settle is not a second visit", JSON.stringify(ledger.row.visits));
    const probeRun = (ledger.stageRuns || []).find((r) => r.stage === "probe");
    check(Boolean(probeRun && probeRun.decision && probeRun.decision.trigger === "stage-settled"), "the settle was READ: the entry now carries its decision", probeRun && probeRun.decision ? probeRun.decision.trigger : "no decision");
    check(ledger.row.state !== "queued" || stages.includes("fix"), "the row is not left waiting for a person", ledger.row.state);
    return;
  }
  if (ledger.pipeline === "ping-pong") {
    check(ledger.cuts === 1, "ping-pong is cut one tree and every stage runs in it", `${ledger.cuts} cut(s)`);
    check(stages.join(",") === "draft,critique,draft,critique,draft,critique,draft,critique", "ping-pong walks draft ⇄ critique with no hand-start", stages.join(","));
    check(JSON.stringify(ledger.starts.map((s) => s.visit)) === JSON.stringify([1, 1, 2, 2, 3, 3, 4, 4]), "each entry is its own numbered visit", JSON.stringify(ledger.starts.map((s) => s.visit)));
    check(JSON.stringify(ledger.row.visits) === JSON.stringify({ draft: 4, critique: 4 }), "three loop rounds enter each stage four times", JSON.stringify(ledger.row.visits));
    check(Number(ledger.row.crossings["H-02"]) === 3, "the back edge was crossed its cap's three times", JSON.stringify(ledger.row.crossings));
    check(ledger.row.state === "parked" && ledger.row.waitingFor && ledger.row.waitingFor.kind === "cap", "the cap stops the loop for a decision", ledger.row.state);
    check(/at its cap of 3 rounds/.test(String(ledger.row.reason)), "the park names the cap and the edge", ledger.row.reason);
    check(ledger.stageRuns.length === 8 && ledger.stageRuns.every((r) => r.status === "done"), "eight stage runs, every one settled done", `${ledger.stageRuns.length} run(s)`);
    return;
  }
  if (ledger.pipeline === "probe-fix") {
    check(stages.join(",") === "probe,fix", "probe-fix walks probe → fix with no hand-start", stages.join(","));
    check(ledger.row.state === "done", "the last stage's settle finishes the row", ledger.row.state);
    check(/PR reads MERGED/.test(String(ledger.row.reason)), "the row ends on the settle's own landing rule", ledger.row.reason);
    return;
  }
  if (ledger.pipeline === "author-review-revise") {
    check(stages.join(",") === "author,review,author,review,author,review,revise", "author → review, two rejects, then revise, with no hand-start", stages.join(","));
    check(Number(ledger.row.crossings["H-02"]) === 2, "the two rejects are the two crossings the cap allows", JSON.stringify(ledger.row.crossings));
    check(ledger.seatVerdicts.map((v) => v.outcome).join(",") === "reject,reject,accept", "the seat's verdict is what routed each crossing", ledger.seatVerdicts.map((v) => v.outcome).join(","));
    check(ledger.row.state === "done", "the accepted manuscript reaches the reviser and finishes", ledger.row.state);
    return;
  }
  check(false, `no expectation is written for "${ledger.pipeline}"`);
}

// ---- the report --------------------------------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (s, n = 12) => (s ? `${String(s).slice(0, n)}…` : "—");

function report(ledgers, provenance) {
  const rows = ledgers
    .map((l) => {
      const runs = l.stageRuns
        .map(
          (r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.status || "—")}</td><td class="mono">${esc(short(r.thread))}</td><td>${esc(r.artifact ? r.artifact.path : "—")}</td><td class="mono">${esc(r.artifact && r.artifact.sha256 ? short(r.artifact.sha256, 10) : "—")}</td><td>${esc(r.decision ? r.decision.trigger : "—")}</td></tr>`,
        )
        .join("");
      const waits = l.row.waitingFor ? `<code>${esc(JSON.stringify(l.row.waitingFor))}</code>` : "—";
      // The leftover walk says what it left on disk and what the next sweep did with it, from the ledger's own starts.
      const first = l.starts[0];
      const second = l.starts[1];
      const timerLine = l.mode === "timer"
        ? `<p class="order"><b>The timer:</b> after the panel's ordinary dispatch cut the tree and started <code>${esc(first ? first.stage : "?")}</code>, every later boundary was crossed by <code>sweepPipelineWaits</code> alone — each stage held in the book, keyed to its run (${l.holds.length} holds). The walk restarted mid-wait at step ${esc(String(l.restart ? l.restart.at : "—"))} (stage <code>${esc(l.restart ? l.restart.stage : "—")}</code>) with a fresh book and a fresh Assistant over the same files: ${esc(String((l.starts || []).length - (l.restart ? l.restart.started : 0)))} stage start(s) after it, and none of them twice.</p>`
        : "";
      const leftoverLine = l.pipeline.endsWith(":leftover")
        ? `<p class="order"><b>Leftover:</b> the row was written <code>queued</code> over <code>${esc(first ? first.stage : "?")}</code> after its run settled; the next sweep read the settle off the ledger and started <code>${esc(second ? second.stage : "?")}</code>. <code>${esc(first ? first.stage : "")}</code> was started once.</p>`
        : "";
      return `<section class="pipe">
  <h2>${esc(l.pipeline)} <span class="sub">${esc(l.title)}</span></h2>
  <p class="meta">${l.starts.length} stage start${l.starts.length === 1 ? "" : "s"} · ${l.cuts} tree cut · ${l.stageRuns.length} stage run${l.stageRuns.length === 1 ? "" : "s"} · ends <b>${esc(l.row.state)}</b></p>
  <p class="order"><b>Started, in order:</b> ${l.starts.map((s) => `${esc(s.stage)}#${s.visit}`).join(" → ")}</p>
  <p class="order"><b>Visits:</b> <code>${esc(JSON.stringify(l.row.visits))}</code> &nbsp; <b>Crossings:</b> <code>${esc(JSON.stringify(l.row.crossings))}</code> &nbsp; <b>Waits on:</b> ${waits}</p>
  ${leftoverLine}
  ${timerLine}
  <p class="reason">${esc(l.row.reason || "")}</p>
  <table><thead><tr><th>stage run</th><th>status</th><th>thread</th><th>artifact</th><th>sha256</th><th>decision</th></tr></thead><tbody>${runs}</tbody></table>
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>A pipeline walks by itself — three small documents, no hand-start</title>
<style>
 body{background:#14161a;color:#e7e9ee;font:15px/1.55 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:32px 28px 64px;max-width:1120px}
 h1{font-size:26px;margin:0 0 6px} h2{font-size:19px;margin:34px 0 6px} .sub{color:#98a2b3;font-weight:400;font-size:15px}
 p{margin:6px 0} .meta{color:#98a2b3} code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;color:#c7ced9}
 .reason{color:#d7c9a8;border-left:2px solid #5b4a2a;padding-left:10px} .order{color:#c7ced9}
 table{border-collapse:collapse;width:100%;margin:10px 0 4px;font-size:13px}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #262a31;vertical-align:top}
 th{color:#98a2b3;font-weight:600;background:#191c21}
 .pass{display:inline-block;background:#12351f;color:#7ee2a8;border:1px solid #1f6b3d;border-radius:4px;padding:2px 8px;font-size:12px}
 .note{color:#98a2b3;font-size:13px;margin-top:34px;border-top:1px solid #262a31;padding-top:12px}
${REPORT_FOOTER_CSS}
</style></head><body>
<h1>A pipeline walks by itself</h1>
<p class="meta">Shipped documents driven through <code>Assistant.sweepQueues</code> — the panel's own clock — with a scripted seat and <b>no hand-start</b>. Generated by <code>node tools/verify-pipeline-walk.mjs</code> at ${esc(new Date().toISOString())}.</p>
<p class="order"><b>The case this change is about</b> is the fourth walk. A row can be left <code>queued</code> over a stage whose run has already settled — a restart between the settle and the pass that reads it, a requeue, a killed pass. On the driver before this change that row stayed <code>queued</code> on <code>probe</code> with no decision on its stage run and never advanced (measured: 17 / 20 checks, all three red ones in that walk). The driver now reads the settle off the row's own ledger and moves to the graph's next stage.</p>
<p class="order"><b>The fifth walk is the same document on the panel's other clock.</b> The cut writes a HOLD on the tree's pipeline record (<code>pipelineWait.kind: "run"</code>), keyed to the run; <code>sweepPipelineWaits</code> reads that run's status and, when it has settled, hands the row to the one advance seam. The assistant's queue is not swept between boundaries — and the walk is restarted mid-wait, from the files alone.</p>
${rows}
<p class="note">Each start above was asked for by <code>driveTaskPipelines</code> on the sweep that settled the stage before it: the seat is handed the stage prompt and its tree, writes the stage's declared artifact, and returns the job a gateway would return. The cap, the gate's routed verdict, the artifact gate and the landing rule are read from <code>pipeline-bundle.seed.json</code>, not restated here. Ledger: <code>ledger.json</code> beside this page.</p>
${reportFooter(provenance)}
</body></html>
`;
}

// ---- main --------------------------------------------------------------------------------------------------------
const SCENARIOS = [
  { id: "ping-pong" },
  { id: "probe-fix" },
  { id: "author-review-revise" },
  { id: "probe-fix", leftover: true },
  // The wait book's own clock: the same ping-pong document, walked by `sweepPipelineWaits` after the panel's ordinary
  // dispatch started the first stage — and restarted mid-wait, from the files.
  { id: "ping-pong", timer: true, restartAt: 6 },
];
const ledgers = [];
try {
  const chosen = ONLY ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;
  if (!chosen.length) throw new Error(`no scenario matches --only ${JSON.stringify(ONLY)}`);
  for (const scenario of chosen) {
    const ledger = await walk(scenario.id, { leftover: Boolean(scenario.leftover), timer: Boolean(scenario.timer), restartAt: Number(scenario.restartAt) || 0 });
    ledgers.push(ledger);
    expectWalk(ledger);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "ledger.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), seed: "pipeline-bundle.seed.json", walks: ledgers }, null, 1)}\n`);
  writeFileSync(path.join(OUT, "report.html"), report(ledgers, resolveReportProvenance({
    repo: REPO,
    title: "A pipeline walks by itself",
    source: "node tools/verify-pipeline-walk.mjs reading pipeline-bundle.seed.json",
  })));
  console.log(`\nledger  ${path.join(OUT, "ledger.json")}`);
  console.log(`report  ${path.join(OUT, "report.html")}`);
} catch (err) {
  failures += 1;
  console.error(`FAIL  the walk could not run — ${String((err && err.stack) || err)}`);
}
console.log(`\n${checks - failures} / ${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
