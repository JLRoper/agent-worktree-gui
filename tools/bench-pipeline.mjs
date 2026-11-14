#!/usr/bin/env node
// THE PIPELINE BENCH. Four tiny documents, each attached to a real queue task and walked on the panel's own clock.
//
// `tools/verify-pipeline-walk.mjs` proves a walk on the SHIPPED documents; this bench proves the four SHAPES a walk
// can take, one per document, with a definition small enough that a reader can hold the whole graph in their head:
//
//   bench-handoff     two stages, one sequence edge. Did the assistant STAGE the work and hand it on?
//   bench-gate        draft → review → publish, with G1 routing accept to publish and reject back to draft. Did it
//                     PARK on the gate, cross only on the record, and BOUNDCE the reject?
//   bench-queue       two stages filed BEHIND a row that is already running. Did it wait its turn (no stage started
//                     over the live row), then start when the front settled?
//   bench-ping-pong   two stages whose only ways out are capped loops in each direction. Did it stop at the cap, or
//                     did the two-way loop keep starting stages?
//
// The four definitions are checked in under `tools/pipeline-bench/` as ONE panel bundle, so the panel could import
// them; `scenarios.json` beside it is the bench's own answer to "what should this document do" (stage order, visits,
// crossings, the end state, the parks and the bounce). Neither file is rebuilt by the tool: the bench is a walk over
// them, and every run reads them again, so a document edited by hand is the document the next run walks.
//
// WHAT IS REAL HERE
//   - `Assistant.sweepQueues()` is the clock. It reads the bundle, drives the row (`driveTaskPipelines`), settles it,
//     writes the queue file and cuts the tree through `jobs.makeWorktree` — the same path the live panel runs.
//   - the queue file on disk is the record: every row, stage run, decision and reason this report prints was read
//     back through `readQueueFile`, never out of the harness's memory.
//   - the document is `bundle.json` through `parseBundle`, so a definition the loader would refuse is refused here
//     before a task is filed.
//
// WHAT IS A SEAT: the model. The spawner is a scripted worker with a stated remit. It learns the stage from the
// provenance line the DRIVER wrote into its prompt, writes that stage's declared artifact into the tree, and returns
// the job record a gateway would return. The gate's DECIDER is the bench, not the seat: the record is written only
// AFTER the row has parked on the gate, which is what makes the park observable. A seat that wrote the record at
// spawn time would cross the gate without ever waiting, and the barrier would prove nothing.
//
//   node tools/bench-pipeline.mjs                  walk all five scenarios, write the ledger + report
//   node tools/bench-pipeline.mjs --only gate-reject,ping-pong
//   node tools/bench-pipeline.mjs --bundle <path>  the document to walk (default: tools/pipeline-bench/bundle.json)
//   node tools/bench-pipeline.mjs --out <dir>      where the ledger and the report go
//   node tools/bench-pipeline.mjs --no-write       walk and print, write nothing
//   node tools/bench-pipeline.mjs --keep           keep the sandbox trees
//
// Exit: 0 every scenario matched its document; 1 a scenario did not; 2 the bench could not run (a fixture the loader
// refuses, a scenario naming a pipeline or edge the document does not hold, a bad argument).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Assistant } from "../lib/assistant.js";
import { readQueueFile } from "../lib/assistant/queue.js";
import { parseBundle, pipelineById, stageById } from "../lib/pipeline-bundle.js";
import { REPORT_FOOTER_CSS, reportFooter, resolveReportProvenance } from "../lib/report-footer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const FIXTURES = path.join(HERE, "pipeline-bench");
const DEFAULT_BUNDLE = path.join(FIXTURES, "bundle.json");
const DEFAULT_SCENARIOS = path.join(FIXTURES, "scenarios.json");
const DEFAULT_OUT = path.join(REPO, "docs", "reviews", "pipeline-bench");
// The clock every walk starts on. A fixed instant makes two runs of the same document agree byte for byte on every
// stamp except `generatedAt`, which is the re-runnability this bench is for.
const T0 = Date.parse("2026-11-08T12:00:00.000Z");
const STEP_MS = 1000;
const DEFAULT_BUDGET = 30;
// A queued row that has not started in this many sweeps is a stall the report names. The cut and the start are two
// passes on purpose (the assistant cuts the tree, the next pass starts the worker), so two is normal and three is not.
const STALL_SWEEPS = 3;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => (typeof value === "string" ? value.trim() : "");
const iso = (ms) => new Date(ms).toISOString();
const PROJECT = { name: "agent-worktree-gui", path: REPO };

function benchFault(code, reason) {
  const error = new Error(reason);
  error.code = code;
  return error;
}

// ---- the fixtures ------------------------------------------------------------------------------------------------
// Read once per run, so the document under test is the file on disk and not a copy somebody edited in memory. A
// refusal is thrown with the loader's own code and locator: the bench does not walk half a document.
export function loadBench({ bundleFile = DEFAULT_BUNDLE, scenarioFile = DEFAULT_SCENARIOS } = {}) {
  if (!existsSync(bundleFile)) throw benchFault("bench-fixture", `there is no bundle at ${bundleFile} — the bench has nothing to walk`);
  if (!existsSync(scenarioFile)) throw benchFault("bench-fixture", `there is no scenario file at ${scenarioFile} — the bench has nothing to expect`);
  let body;
  try {
    body = readFileSync(bundleFile, "utf8");
  } catch (error) {
    throw benchFault("bench-fixture", `${bundleFile} could not be read (${String((error && error.message) || error)})`);
  }
  const source = parseBundle(body, { file: bundleFile });
  if (source.ok !== true) {
    throw benchFault(source.code || "bench-fixture", `${bundleFile} is not a bundle this panel can read — ${source.code}${source.where ? ` at ${source.where}` : ""}: ${source.reason}`);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(scenarioFile, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw benchFault("bench-fixture", `${scenarioFile} is not JSON (${String((error && error.message) || error)})`);
  }
  const scenarios = Array.isArray(doc) ? doc : Array.isArray(doc.scenarios) ? doc.scenarios : null;
  if (!scenarios || !scenarios.length) throw benchFault("bench-fixture", `${scenarioFile} holds no scenarios — the bench would walk nothing`);
  validateScenarios(source.bundle, scenarios);
  return { source, bundle: source.bundle, scenarios, bundleFile: path.resolve(bundleFile), scenarioFile: path.resolve(scenarioFile) };
}

// The scenario file is a CLAIM about the document, so it is checked against the document before a single task is
// filed: an expectation naming a stage, an edge, a gate or an outcome the bundle does not hold is a bench that would
// report a passing walk of a graph nobody can see.
export function validateScenarios(bundle, scenarios) {
  const seen = new Set();
  const faults = [];
  const fail = (id, reason) => faults.push(`${id || "(unnamed)"}: ${reason}`);
  for (const scenario of scenarios) {
    const id = text(scenario && scenario.id);
    if (!id) {
      fail(null, "the scenario has no id — a report row and an --only filter both name it");
      continue;
    }
    if (seen.has(id)) fail(id, "two scenarios share this id");
    seen.add(id);
    const pipeline = pipelineById(bundle, scenario.pipeline);
    if (!pipeline) {
      fail(id, `names pipeline ${JSON.stringify(scenario.pipeline)}, which the bundle does not hold (it holds ${(bundle.pipelines || []).map((p) => p.id).join(", ")})`);
      continue;
    }
    const stages = new Set(pipeline.stages.map((stage) => stage.id));
    const handoffs = new Map((pipeline.handoffs || []).map((handoff) => [handoff.id, handoff]));
    const gates = new Map((pipeline.gates || []).map((gate) => [gate.id, gate]));
    const expect = scenario.expect || {};
    for (const stage of Array.isArray(expect.starts) ? expect.starts : []) {
      if (!stages.has(stage)) fail(id, `expects a start at stage ${JSON.stringify(stage)}, which ${pipeline.id} does not hold`);
    }
    for (const stage of Object.keys(expect.visits || {})) {
      if (!stages.has(stage)) fail(id, `expects visits of stage ${JSON.stringify(stage)}, which ${pipeline.id} does not hold`);
    }
    for (const edge of Object.keys(expect.crossings || {})) {
      if (!handoffs.has(edge)) fail(id, `expects crossings of handoff ${JSON.stringify(edge)}, which ${pipeline.id} does not hold`);
    }
    for (const park of Array.isArray(expect.parks) ? expect.parks : []) {
      const gate = gates.get(park.gate);
      if (!gate) {
        fail(id, `expects a park on gate ${JSON.stringify(park.gate)}, which ${pipeline.id} does not hold`);
        continue;
      }
      if (gate.after !== park.stage) fail(id, `expects gate ${park.gate} to follow ${JSON.stringify(park.stage)}, and the document puts it after ${gate.after}`);
      const route = gate.decision && gate.decision.routes ? gate.decision.routes[park.outcome] : null;
      if (!route) fail(id, `expects gate ${park.gate} to route ${JSON.stringify(park.outcome)}, which its decision does not`);
      else if (route !== park.edge) fail(id, `expects gate ${park.gate} to route ${park.outcome} along ${park.edge}, and the document routes it along ${route}`);
      const handoff = handoffs.get(park.edge);
      if (!handoff) fail(id, `expects a park crossing ${JSON.stringify(park.edge)}, which ${pipeline.id} does not hold`);
      else if (handoff.to !== park.to) fail(id, `expects ${park.edge} to enter ${JSON.stringify(park.to)}, and the document enters ${handoff.to}`);
    }
    for (const bounce of Array.isArray(expect.bounces) ? expect.bounces : []) {
      const handoff = handoffs.get(bounce.edge);
      if (!handoff) fail(id, `expects a bounce along ${JSON.stringify(bounce.edge)}, which ${pipeline.id} does not hold`);
      else if (handoff.to !== bounce.to) fail(id, `expects the bounce to enter ${JSON.stringify(bounce.to)}, and ${bounce.edge} enters ${handoff.to}`);
    }
    if (expect.queuedBehind && !stages.has(expect.queuedBehind.stage)) {
      fail(id, `expects the row to wait at stage ${JSON.stringify(expect.queuedBehind.stage)}, which ${pipeline.id} does not hold`);
    }
    if (expect.parkedFor) {
      const handoff = handoffs.get(expect.parkedFor.edge);
      if (!handoff) fail(id, `expects a park on ${JSON.stringify(expect.parkedFor.edge)}, which ${pipeline.id} does not hold`);
      if (expect.parkedFor.kind === "cap" && handoff && text(handoff.cap) !== `${expect.parkedFor.limit} rounds` && !new RegExp(`^${expect.parkedFor.limit}\\b`).test(text(handoff.cap))) {
        fail(id, `expects a cap of ${expect.parkedFor.limit} on ${expect.parkedFor.edge}, and the document says ${JSON.stringify(text(handoff.cap))}`);
      }
    }
    for (const stage of Object.keys(scenario.verdicts || {})) {
      if (!stages.has(stage)) fail(id, `has a verdict policy for stage ${JSON.stringify(stage)}, which ${pipeline.id} does not hold`);
    }
  }
  if (faults.length) throw benchFault("bench-scenario", `${faults.length} scenario fault${faults.length === 1 ? "" : "s"}: ${faults.join("; ")}`);
  return true;
}

// ---- the walk -----------------------------------------------------------------------------------------------------
// One task, one tree, one scripted seat, and the panel's sweep between every stage. The tree is a plain directory
// (not a git repository) on purpose: the bench drives the GRAPH, and a real repository would add pin refusals that
// are another test's subject. That is the same sandbox `tools/verify-pipeline-walk.mjs` walks.
//
// The task is a REAL queue row, filed through `queueMutate`, and every read afterwards is `readQueueFile`: the report
// prints the row's own record, not the objects this process passed around.
async function walkScenario({ bundle, scenario, keep = false }) {
  const pipeline = pipelineById(bundle, scenario.pipeline);
  if (!pipeline) throw benchFault("bench-scenario", `${scenario.id}: the bundle no longer holds ${scenario.pipeline}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), `wag-bench-${scenario.id}-`));
  const docFile = path.join(dir, "pipeline-bundle.json");
  writeFileSync(docFile, JSON.stringify(bundle));
  const state = { board: [], started: [], cuts: [], steps: [], parks: [], decisions: [], tree: path.join(dir, "tree"), clock: T0 };
  let jobNo = 0;

  const jobs = {
    list: () => state.board,
    firstOfThread: (thread) => state.board.find((job) => job.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    create: async (opts) => ({ id: "job-created", ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    get: (id) => state.board.find((job) => String(job.id) === String(id)) || null,
    clarify: { state: () => null },
    makeWorktree: async (repoDir, prompt) => {
      state.cuts.push({ repoDir, prompt, at: iso(state.clock) });
      mkdirSync(state.tree, { recursive: true });
      return { path: state.tree, branch: `bench/${scenario.id}`, startSha: null };
    },
  };

  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir, pipelineBundleFile: docFile },
    jobs,
    getProjects: () => [PROJECT],
    // The landing rule is satisfied up front. Every bench artifact is a file in the tree (`kind` is unstated), so the
    // last stage settles the row on its own verdict and never waits for a pull request.
    getRows: () => [{ path: state.tree, verdict: "MERGED" }],
    spawner: async (spec) => {
      const found = /\(([\w.-]+)\/([\w.-]+)\)(?:, visit (\d+))?/.exec(String(spec.prompt || ""));
      if (!found) throw new Error(`the stage prompt names no stage: ${String(spec.prompt || "").slice(0, 160)}`);
      const [, pipelineId, stageId, visitRaw] = found;
      const doc = pipelineById(bundle, pipelineId);
      const stage = doc && stageById(doc, stageId);
      if (!stage || !stage.artifact) throw new Error(`${pipelineId}/${stageId} declares no artifact`);
      const visit = Number(visitRaw) || 1;
      const body = `${pipelineId}/${stageId} visit ${visit}\nwritten by the bench seat at ${iso(state.clock)}\n`;
      const file = path.join(spec.target, stage.artifact.path);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
      jobNo += 1;
      const job = {
        id: `job-${jobNo}`,
        thread: `bench-${scenario.id}-${jobNo}`,
        cwd: spec.target,
        worktreePath: spec.target,
        status: "running",
        startedAt: iso(state.clock),
      };
      state.started.push({
        step: state.steps.length + 1,
        at: iso(state.clock),
        pipeline: pipelineId,
        stage: stageId,
        visit,
        run: `${pipelineId}/${stageId}#${visit}`,
        job: job.id,
        thread: job.thread,
        artifact: stage.artifact.path,
        sha256: sha256(body),
      });
      state.board.push(job);
      return job;
    },
    now: () => state.clock,
  });
  assistant.settings.spawn = "auto";
  const queueFile = assistant.queuePathOf(assistant.assistantRecord("assistant-1"));
  const rowOf = (id) => readQueueFile(queueFile).tasks.find((task) => Number(task.id) === Number(id)) || null;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // One tick of the panel's clock is ONE COMPLETED PASS. `sweepQueues` answers a promise whenever the pass suspends on
  // a git fact (`lib/assistant.js`: `throw { treeFactsPending }` -> `err.treeFactsPending.then(run)`), and a tree reading
  // costs ~380 ms on this host, so three bare macrotask ticks read the queue long before the pass has written it. The
  // wait is the same quiescence the repo's own harness uses (test/task-pipeline-sweep.test.js, `settleStarts`): the
  // guard idle, no cut in flight, and the board's shape stable across two polls.
  const sweep = async () => {
    state.clock += STEP_MS;
    await assistant.sweepQueues();
    let last = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await tick();
      const pending = assistant.queueSweepNext || assistant.queueSweepPending;
      if (pending) await pending;
      const shape = [state.started.length, state.board.length, state.cuts.length].join("|");
      if (!assistant.queueSweepPending && !assistant.queueSweepNext && !assistant.cuttingTrees?.size && shape === last) return;
      last = shape;
    }
    throw new Error("the pipeline did not settle");
  };
  const finish = () => {
    const job = state.board.filter((entry) => entry.status === "running").at(-1);
    if (job) job.status = "done";
    return job || null;
  };
  const snapshot = (row, { step, before = null, mode = "queue" } = {}) => {
    const run = row && row.pipelineRun ? row.pipelineRun : null;
    const entries = run && Array.isArray(run.stageRuns) ? run.stageRuns : [];
    const last = entries.at(-1) || null;
    return {
      step,
      at: iso(state.clock),
      mode,
      state: row ? row.state : null,
      stage: run ? run.stage : null,
      via: run && run.via ? run.via : null,
      visits: run && run.visits ? run.visits : {},
      crossings: run && run.crossings ? run.crossings : {},
      waitingFor: run && run.waitingFor ? run.waitingFor : null,
      reason: row ? row.reason || null : null,
      starts: state.started.length,
      runs: entries.length,
      run: last ? last.id : null,
      thread: last ? last.thread || null : null,
      job: last ? last.job || null : null,
      decision: last && last.decision ? last.decision.trigger : null,
      from: before ? before.state : null,
    };
  };
  // The decider. It is asked only AFTER a snapshot reads `parked` on a gate, so the park is a fact the walk observed,
  // and it writes the document's own per-round record: `bench/verdict-{{round}}.json` filled with this visit.
  const decidePark = (row, step) => {
    const run = row && row.pipelineRun ? row.pipelineRun : null;
    const wait = run && run.waitingFor ? run.waitingFor : null;
    if (!wait || text(wait.kind) !== "gate") return null;
    const gate = (pipeline.gates || []).find((entry) => entry.id === wait.gate);
    if (!gate || !gate.decision) return null;
    const visit = Number((run.visits || {})[run.stage]) || 1;
    const key = `${gate.id}:${run.stage}#${visit}`;
    if (state.decisions.some((entry) => entry.key === key)) return null;
    const policy = (scenario.verdicts || {})[run.stage];
    const outcome = Array.isArray(policy) ? policy[visit - 1] : null;
    if (!outcome) throw benchFault("bench-scenario", `${scenario.id}: the row parked at ${gate.id} on ${run.stage}#${visit} and the scenario has no verdict for that visit`);
    const rel = String(gate.decision.path || "").replace(/\{\{\s*round\s*\}\}/g, String(visit));
    const file = path.join(state.tree, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ outcome, gate: gate.id, at: iso(state.clock), by: "bench decider" }, null, 1)}\n`);
    // The edge the DOCUMENT routes this outcome along, recorded with the park so the report can say "reject bounced
    // along H-03 to draft" without re-reading the gate. A route of null is the document's "the pipeline ends here".
    const route = gate.decision.routes ? gate.decision.routes[outcome] : null;
    const handoff = route ? (pipeline.handoffs || []).find((entry) => entry.id === route) || null : null;
    const entry = { key, step, at: iso(state.clock), stage: run.stage, visit, gate: gate.id, outcome, path: rel, file, edge: handoff ? handoff.id : null, to: handoff ? handoff.to : null };
    state.decisions.push(entry);
    state.parks.push(entry);
    return entry;
  };

  try {
    // The blocker is a real queue row too: filed first (so it is the queue's front), given a thread, moved to
    // `running`, and carried by a job the store reports live. The pipeline row is filed behind it.
    let blocker = null;
    if (scenario.blocker) {
      const config = { title: String(scenario.blocker.title || "a live row ahead"), project: PROJECT.name };
      const added = assistant.queueMutate("assistant-1", "add", config);
      if (!added.ok) throw new Error(added.error);
      blocker = added.task;
      const thread = String(scenario.blocker.thread || `thread-blocker`);
      const edited = assistant.queueMutate("assistant-1", "edit", { id: blocker.id, thread });
      if (!edited.ok) throw new Error(edited.error);
      const moved = assistant.queueMutate("assistant-1", "state", { id: blocker.id, state: "running" });
      if (!moved.ok) throw new Error(moved.error);
      state.board.push({ id: String(scenario.blocker.job || "job-blocker"), thread, status: "running", startedAt: iso(state.clock) });
    }

    const added = assistant.queueMutate("assistant-1", "add", { title: String(scenario.title || scenario.id), project: PROJECT.name });
    if (!added.ok) throw new Error(added.error);
    const taskId = added.task.id;
    const put = assistant.queueMutate("assistant-1", "pipeline", { id: taskId, pipeline: scenario.pipeline, stage: pipeline.stages[0].id });
    if (!put.ok) throw new Error(put.error);

    // THE QUEUED CASE, before the ordinary walk: sweep the panel's clock while the front row is live. The pipeline
    // must stay queued at its first stage and start nothing. The blocker is settled between two sweeps afterwards.
    let queued = null;
    if (scenario.blocker) {
      const sweeps = Math.max(1, Number(scenario.expect && scenario.expect.queuedBehind && scenario.expect.queuedBehind.sweeps) || 1);
      for (let i = 0; i < sweeps; i += 1) {
        const before = rowOf(taskId);
        await sweep();
        const row = rowOf(taskId);
        state.steps.push(snapshot(row, { step: state.steps.length + 1, before, mode: "blocked" }));
      }
      const row = rowOf(taskId);
      queued = {
        row: taskId,
        behind: { id: blocker.id, title: blocker.title, thread: String(scenario.blocker.thread || "thread-blocker"), state: "running" },
        sweeps,
        stage: row && row.pipelineRun ? row.pipelineRun.stage : null,
        startsDuring: state.started.length,
        stateAtRelease: row ? row.state : null,
        reasonAtRelease: row ? row.reason || null : null,
        releasedAtStep: state.steps.length + 1,
      };
      const live = state.board.find((job) => job.id === String(scenario.blocker.job || "job-blocker"));
      if (live) live.status = "done";
    }

    // THE WALK. The worker finishes between two sweeps; the sweep is the only clock. A gate park is not an end: the
    // decider writes the record and the next sweep crosses it. A cap park IS an end, because no file can release it.
    let parkedStep = null;
    const budget = Math.max(1, Number(scenario.budget) || DEFAULT_BUDGET);
    for (let i = 0; i < budget; i += 1) {
      finish();
      const before = rowOf(taskId);
      await sweep();
      const row = rowOf(taskId);
      const step = snapshot(row, { step: state.steps.length + 1, before });
      state.steps.push(step);
      if (!row) break;
      if (row.state === "parked" && row.pipelineRun && row.pipelineRun.waitingFor && text(row.pipelineRun.waitingFor.kind) === "gate") {
        const decided = decidePark(row, step.step);
        if (decided) {
          step.park = { gate: decided.gate, outcome: decided.outcome, path: decided.path };
          parkedStep = step.step;
          continue;
        }
        // The record is there and the row did not move: that is a stall, and the judge names the step it began on.
        if (parkedStep !== null) break;
      }
      if (row.state === "done" || row.state === "parked") break;
    }

    const row = rowOf(taskId);
    if (!row) throw benchFault("bench-walk", `${scenario.id}: queue row #${taskId} disappeared from ${queueFile}`);
    const ledger = {
      id: scenario.id,
      pipeline: scenario.pipeline,
      title: row.title,
      kind: scenario.kind || "walk",
      about: scenario.about || "",
      document: {
        stages: pipeline.stages.map((stage) => ({ id: stage.id, position: stage.position, artifact: stage.artifact.path, writer: stage.artifact.writer })),
        handoffs: (pipeline.handoffs || []).map((handoff) => ({ id: handoff.id, from: handoff.from, to: handoff.to, kind: handoff.kind, cap: handoff.cap || null })),
        gates: (pipeline.gates || []).map((gate) => ({
          id: gate.id,
          after: gate.after,
          decision: gate.decision ? { path: gate.decision.path, outcomes: gate.decision.outcomes, routes: gate.decision.routes || null } : null,
        })),
      },
      row: {
        id: taskId,
        title: row.title,
        state: row.state,
        stage: row.pipelineRun ? row.pipelineRun.stage : null,
        via: row.pipelineRun && row.pipelineRun.via ? row.pipelineRun.via : null,
        visits: row.pipelineRun ? row.pipelineRun.visits || {} : {},
        crossings: row.pipelineRun ? row.pipelineRun.crossings || {} : {},
        waitingFor: row.pipelineRun ? row.pipelineRun.waitingFor || null : null,
        reason: row.reason || null,
      },
      tree: `<sandbox>/tree`,
      cuts: state.cuts.length,
      blocker: blocker ? { id: blocker.id, title: blocker.title, thread: String(scenario.blocker.thread || "thread-blocker") } : null,
      queued,
      started: state.started.map((start) => ({ ...start })),
      stageRuns: (row.pipelineRun && Array.isArray(row.pipelineRun.stageRuns) ? row.pipelineRun.stageRuns : []).map((entry) => ({
        id: entry.id,
        stage: entry.stage,
        visit: entry.visit,
        status: entry.status || null,
        thread: entry.thread || null,
        job: entry.job || null,
        settledAt: entry.settledAt || null,
        artifact: entry.artifact ? { path: entry.artifact.path, present: entry.artifact.present, sha256: entry.artifact.sha256, unchanged: Boolean(entry.artifact.unchanged) } : null,
        decision: entry.decision ? { trigger: entry.decision.trigger, code: entry.decision.code || null, reason: entry.decision.reason } : null,
      })),
      parks: state.parks.map((park) => ({ step: park.step, stage: park.stage, visit: park.visit, gate: park.gate, outcome: park.outcome, edge: park.edge || null, to: park.to || null, path: park.path, at: park.at })),
      steps: state.steps,
      endedAtStep: state.steps.length,
    };
    // Every string is scrubbed of this run's sandbox: a committed ledger must not name a folder on the machine that
    // wrote it (`tools/absolute-paths.mjs`), and a park's sentence quotes the tree it read.
    const sandbox = dir.replace(/\\/g, "/");
    const scrubText = (value) => String(value).split(dir).join("<sandbox>").split(sandbox).join("<sandbox>");
    const scrub = (value) =>
      typeof value === "string" ? scrubText(value) : Array.isArray(value) ? value.map(scrub) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)])) : value;
    return scrub(ledger);
  } finally {
    clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the judgement ------------------------------------------------------------------------------------------------
// Every expectation is the DOCUMENT's, and every failure names the row, the run and the step where it happened: a
// report that says "2 checks failed" sends the reader back to the tool, and one that says "row #2 started queue-a at
// step 3 while #1 was still running" sends them to the defect.
function judge(run, scenario, { record }) {
  const expect = scenario.expect || {};
  const handoffs = new Map((run.document.handoffs || []).map((handoff) => [handoff.id, handoff]));
  const order = (run.document.stages || []).map((stage) => stage.id);
  const at = (stage) => order.indexOf(stage);
  const row = run.row;
  const detailRow = `row #${row.id} (${run.pipeline})`;

  // 1. The row really is the document's: a typo in the scenario would otherwise walk another pipeline silently.
  record.check(run.pipeline === scenario.pipeline, `${detailRow} is on the document under test`, `scenario ${scenario.id} → ${scenario.pipeline}`);

  // 2. STAGED: the panel started every stage the document says, in the document's order and with its own visit
  //    numbers. A mismatch names the first start that disagrees, with the step, job and thread it ran on.
  const wanted = (expect.starts || []).map((stage, index) => {
    const seen = (expect.starts || []).slice(0, index).filter((entry) => entry === stage).length;
    return `${scenario.pipeline}/${stage}#${seen + 1}`;
  });
  const actual = run.started.map((start) => start.run);
  if (actual.join(",") !== wanted.join(",")) {
    let index = 0;
    while (index < Math.max(actual.length, wanted.length) && actual[index] === wanted[index]) index += 1;
    const bad = run.started[index] || null;
    const expected = wanted[index] || null;
    record.check(
      false,
      `${detailRow} started the document's stages in order`,
      bad
        ? `start #${index + 1} was ${bad.run} at step ${bad.step} (${bad.job}, ${bad.thread}); expected ${expected} — the row is at ${row.stage} and its last run is ${row.stage ? `${run.pipeline}/${row.stage}` : "none"}`
        : `${run.started.length} start(s): ${actual.join(" → ") || "none"}; expected ${wanted.join(" → ")} — the row ended ${row.state} at ${row.stage || "no stage"}`,
    );
  } else {
    record.check(true, `${detailRow} started the document's stages in order`, actual.join(" → "));
  }

  // 3. Each entry is its own stage run, settled `done`, with the artifact the document declares present and hashed
  //    to the bytes the seat wrote. This is the "staged" half of the report, one line per run.
  for (const start of run.started) {
    const entry = run.stageRuns.find((candidate) => candidate.id === start.run) || null;
    const ok = Boolean(entry && entry.status === "done" && entry.artifact && entry.artifact.present === true && entry.artifact.sha256 === start.sha256);
    record.check(
      ok,
      `${detailRow} staged ${start.run}`,
      ok
        ? `${start.job} · ${start.thread} · ${start.artifact} · ${String(start.sha256).slice(0, 12)}…`
        : entry
          ? `the run reads ${entry.status || "no status"} with artifact ${entry.artifact ? `${entry.artifact.path} present=${entry.artifact.present} sha=${String(entry.artifact.sha256 || "none").slice(0, 12)}…` : "none"}; the seat wrote ${start.artifact} sha=${String(start.sha256).slice(0, 12)}… at step ${start.step}`
          : `the ledger holds no entry for ${start.run}; the start at step ${start.step} (${start.job}) is what the row's record lost`,
    );
  }

  // 4. No stage entered that the document does not hold, and every visit count is the document's/walk's own.
  for (const stage of Object.keys(row.visits || {})) {
    if (at(stage) < 0) record.check(false, `${detailRow} stayed inside the document's stages`, `the record names stage ${JSON.stringify(stage)}, which ${run.pipeline} does not hold (${order.join(", ")})`);
  }
  for (const [stage, count] of Object.entries(expect.visits || {})) {
    record.check(Number(row.visits[stage]) === count, `${detailRow} entered ${stage} ${count} time${count === 1 ? "" : "s"}`, `visits ${JSON.stringify(row.visits)}; expected ${stage}=${count}`);
  }
  for (const [edge, count] of Object.entries(expect.crossings || {})) {
    record.check(Number(row.crossings[edge]) === count, `${detailRow} crossed ${edge} ${count} time${count === 1 ? "" : "s"}`, `crossings ${JSON.stringify(row.crossings)}; expected ${edge}=${count}`);
  }

  // 5. The moves are the document's edges. A stage change with no `via`, a `via` that leaves another stage, or a
  //    crossing count that did not move is a MIS-ROUTE, and the sentence names both ends and the step.
  for (let i = 1; i < run.steps.length; i += 1) {
    const previous = run.steps[i - 1];
    const step = run.steps[i];
    if (!step.stage || !previous.stage || step.stage === previous.stage) continue;
    const edge = handoffs.get(step.via) || null;
    const crossed = Number(step.crossings[step.via] || 0) - Number(previous.crossings[step.via] || 0);
    const ok = Boolean(edge && edge.from === previous.stage && edge.to === step.stage && crossed === 1);
    record.check(
      ok,
      `${detailRow} moved ${previous.stage} → ${step.stage} along ${step.via || "(no edge)"} at step ${step.step}`,
      ok
        ? `${edge.kind}${edge.cap ? ` · cap ${edge.cap}` : ""} · crossing ${step.crossings[step.via]}`
        : `move at step ${step.step} from ${previous.stage} to ${step.stage} names ${step.via || "no handoff"}; the document's ${step.via || "missing edge"} is ${edge ? `${edge.from} → ${edge.to} (${edge.kind})` : "not an edge of this pipeline"}, and the crossing count moved ${crossed} time(s)`,
    );
  }

  // 6. QUEUED: the row waited behind the live row, started nothing while it did, and only then started stage one.
  if (expect.queuedBehind) {
    const want = expect.queuedBehind;
    const blocked = run.steps.filter((step) => step.mode === "blocked");
    const quiet = blocked.every((step) => step.state === "queued" && step.stage === want.stage);
    record.check(
      queuedOk(run, want),
      `${detailRow} waited behind #${want.row} for ${want.sweeps} sweep${want.sweeps === 1 ? "" : "s"} at ${want.stage}`,
      run.queued
        ? `waited ${run.queued.sweeps} sweep(s) at ${run.queued.stage || "no stage"}; ${run.queued.startsDuring} start(s) while #${run.queued.behind.id} (${run.queued.behind.thread}) was running; the row read ${run.queued.stateAtRelease} at release; first start ${run.started[0] ? run.started[0].run : "none"}`
        : `the scenario expects a wait and the walk recorded none — the row started ${run.started[0] ? `${run.started[0].run} at step ${run.started[0].step}` : "nothing"}, and a queue that starts behind a live row is the stall this case exists to catch`,
    );
    record.check(quiet, `${detailRow} started nothing while it was blocked`, blocked.map((step) => `step ${step.step}: ${step.state} at ${step.stage} (${step.starts} start(s))`).join("; ") || "no blocked sweep was recorded");
  }

  // 7. GATED: a park on the gate is a step the report can point at, the record was written THERE, and the row left
  //    along the document's routed edge. A park with no crossing is a stall, not a pass.
  for (const park of Array.isArray(expect.parks) ? expect.parks : []) {
    const parked = run.steps.find(
      (step) => step.state === "parked" && step.waitingFor && step.waitingFor.kind === "gate" && step.waitingFor.gate === park.gate && step.stage === park.stage && Number(step.visits[park.stage]) === park.visit,
    );
    const wrote = run.parks.find((entry) => entry.gate === park.gate && entry.stage === park.stage && entry.visit === park.visit && entry.outcome === park.outcome) || null;
    const after = parked ? run.steps.find((step) => step.step === parked.step + 1) || null : null;
    const crossed = Boolean(after && after.stage === park.to && after.via === park.edge);
    record.check(
      Boolean(parked && wrote && crossed),
      `${detailRow} parked on ${park.gate} at ${park.stage}#${park.visit} and crossed ${park.edge} to ${park.to}`,
      parked
        ? `${wrote ? `the decider wrote ${park.outcome} at ${wrote.path} during step ${parked.step}` : "no record was written at the park"}; ${after ? `step ${after.step} reads ${after.state} at ${after.stage} via ${after.via || "no edge"}` : "no step follows the park"}${parked.waitingFor.path ? `; the gate waited at ${parked.waitingFor.path}` : ""}`
        : `no step shows the row parked on ${park.gate} at ${park.stage}#${park.visit}; the walk's parks are ${JSON.stringify(run.parks.map((entry) => `${entry.gate}:${entry.stage}#${entry.visit}:${entry.outcome}`))} — a gate crossed without waiting is a barrier that is not a barrier`,
    );
  }

  // 8. BOUNCED: a verdict whose edge is a loop back to an earlier stage. The check is the edge, the target and the
  //    new visit, so a "reject" that went forward is named as a mis-route rather than counted as a bounce.
  for (const bounce of Array.isArray(expect.bounces) ? expect.bounces : []) {
    const edge = handoffs.get(bounce.edge) || null;
    const crossed = Number(row.crossings[bounce.edge] || 0);
    const step = run.steps.find((entry) => entry.via === bounce.edge && entry.stage === bounce.to && Number(entry.visits[bounce.to]) === bounce.visit) || null;
    const ok = Boolean(crossed >= 1 && step && edge && at(bounce.to) < at(bounce.from));
    record.check(
      ok,
      `${detailRow} bounced ${bounce.from} → ${bounce.to} along ${bounce.edge} on ${JSON.stringify(bounce.outcome)}`,
      ok
        ? `step ${step.step}: ${bounce.from} → ${bounce.to} (visit ${bounce.visit}) along ${edge.kind}; crossings ${JSON.stringify(row.crossings)}`
        : `crossings ${JSON.stringify(row.crossings)}; ${step ? `step ${step.step} enters ${step.stage}#${step.visits[step.stage]} via ${step.via}` : `no step enters ${bounce.to} via ${bounce.edge}`} — the verdict did not take the loop back (${edge ? `${edge.from} → ${edge.to}` : "the edge is not in the document"})`,
    );
  }

  // 9. The END: a done row or a park, and the sentence the document earned. A row still `running`/`queued` at the
  //    budget is a stall, and the step it was last seen on is the point.
  record.check(row.state === expect.end, `${detailRow} ended ${expect.end}`, `state ${row.state} at ${row.stage || "no stage"}; reason: ${row.reason || "(none)"}`);
  if (expect.reason) {
    record.check(new RegExp(expect.reason).test(String(row.reason || "")), `${detailRow} says what ended it`, `reason: ${row.reason || "(none)"} (expected /${expect.reason}/)`);
  }
  if (expect.parkedFor) {
    const wait = row.waitingFor || {};
    const ok = wait.kind === expect.parkedFor.kind && (expect.parkedFor.edge ? wait.edge === expect.parkedFor.edge : true) && (expect.parkedFor.limit ? Number(wait.limit) === Number(expect.parkedFor.limit) : true);
    record.check(ok, `${detailRow} parked on ${expect.parkedFor.kind} ${expect.parkedFor.edge || ""}${expect.parkedFor.limit ? ` at ${expect.parkedFor.limit}` : ""}`.replace(/\s+/g, " "), `waitingFor ${JSON.stringify(wait)}; reason: ${row.reason || "(none)"}`);
  }
  // A loop is BOUNDED: the number of starts may not exceed the document's expectation, and the walk must have stopped
  // by itself. This is the check a two-way ping-pong fails when it keeps going.
  if (expect.maxStarts != null) {
    record.check(
      run.started.length <= expect.maxStarts,
      `${detailRow} stayed inside its bound of ${expect.maxStarts} start${expect.maxStarts === 1 ? "" : "s"}`,
      `${run.started.length} start(s): ${run.started.map((start) => start.run).join(" → ") || "none"}; the walk ended at step ${run.endedAtStep} ${row.state === "done" || row.state === "parked" ? `(${row.state})` : "still moving — a loop, not a walk"}`,
    );
  }

  // 10. No stall: a queued row on one stage for more than STALL_SWEEPS sweeps with nothing explaining it. The blocked
  //     phase of the queue case is exempt because its wait IS the case, and the report says how long it waited.
  const stall = stallOf(run);
  record.check(stall === null, `${detailRow} never stalled`, stall ? `stalled at ${stall.stage} from step ${stall.from} to ${stall.to} (${stall.sweeps} sweeps, ${stall.state}); the run is ${stall.run || "unstarted"}; reason: ${stall.reason || "(none)"}` : "no queued run of more than two sweeps without a start");

  return record.checks;
}

function queuedOk(run, want) {
  if (!run.queued) return false;
  if (Number(run.queued.startsDuring) !== 0) return false;
  if (run.queued.stage !== want.stage) return false;
  if (run.queued.sweeps !== want.sweeps) return false;
  if (run.queued.stateAtRelease !== "queued") return false;
  const blocked = run.steps.filter((step) => step.mode === "blocked");
  if (blocked.length !== want.sweeps) return false;
  if (!blocked.every((step) => step.state === "queued" && step.stage === want.stage)) return false;
  return Number(run.started[0] && run.started[0].step) >= run.queued.releasedAtStep;
}

// The first queued run of the same stage that outlives STALL_SWEEPS, ignoring the deliberate blocked phase.
function stallOf(run) {
  let runStart = null;
  let previous = null;
  for (const step of run.steps) {
    if (step.mode === "blocked") {
      runStart = null;
      previous = step;
      continue;
    }
    const same = previous && previous.stage === step.stage && step.state === "queued" && previous.state === "queued";
    if (!same) {
      runStart = step;
    }
    const sweeps = runStart ? step.step - runStart.step + 1 : 1;
    if (step.state === "queued" && sweeps > STALL_SWEEPS) {
      return { stage: step.stage, from: runStart.step, to: step.step, sweeps, state: step.state, run: step.run, reason: step.reason };
    }
    previous = step;
  }
  return null;
}

// ---- the report ---------------------------------------------------------------------------------------------------
const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (value, n = 12) => {
  const text = String(value ?? "");
  if (!text) return "—";
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

// What the walk DID, counted from its own record: a stage is staged when its run settled done with the declared
// artifact present; a gate is gated when a park was observed; a bounce is a park whose routed edge entered a stage
// EARLIER in the document's reading order than the stage the gate follows.
export function verdictsOf(run) {
  const order = (run.document.stages || []).map((stage) => stage.id);
  const parks = run.parks || [];
  const bounced = parks.filter((park) => park.to && park.edge && order.indexOf(park.to) >= 0 && order.indexOf(park.to) < order.indexOf(park.stage));
  return {
    staged: (run.stageRuns || []).filter((entry) => entry.status === "done" && entry.artifact && entry.artifact.present === true).length,
    gated: parks.length,
    queued: run.queued ? run.queued.sweeps : 0,
    bounced: bounced.length,
  };
}

// The stage runs ENTERED by a bounce: a park whose routed edge goes to an EARLIER stage, and the first start of that
// stage after the park. Naming only the target stage would mark every visit of it as "bounced in" — the first draft
// of a rejecting walk was never a bounce.
function bouncedRuns(run) {
  const order = (run.document.stages || []).map((stage) => stage.id);
  const handoffs = new Map((run.document.handoffs || []).map((handoff) => [handoff.id, handoff]));
  const out = new Set();
  for (const park of run.parks || []) {
    const edge = park.edge ? handoffs.get(park.edge) : null;
    if (!edge || !park.to) continue;
    if (order.indexOf(edge.to) >= order.indexOf(park.stage)) continue;
    const start = run.started.find((entry) => entry.stage === edge.to && entry.step > park.step);
    if (start) out.add(start.run);
  }
  return out;
}

function report(runs, provenance, bundleLabel) {
  const summary = runs
    .map((run) => {
      const v = run.verdicts;
      const stages = run.started.map((start) => `${start.stage}#${start.visit}`).join(" → ") || "—";
      return `<tr><td>${esc(run.id)}</td><td class="nowrap"><b>${esc(run.pipeline)}</b><br><span class="sub">${esc(run.kind)}</span></td><td>#${esc(run.row.id)}</td><td class="mono">${esc(stages)}</td><td><b>${esc(run.row.state)}</b></td><td class="num">${v.staged}</td><td class="num">${v.gated}</td><td class="num">${v.queued}</td><td class="num">${v.bounced}</td><td>${run.checks.every((check) => check.ok) ? `<span class="pass">PASS</span>` : `<span class="fail">FAIL</span>`}</td></tr>`;
    })
    .join("\n");

  const sections = runs
    .map((run) => {
      const v = run.verdicts;
      const checks = run.checks
        .map((check) => `<tr class="${check.ok ? "ok" : "bad"}"><td>${check.ok ? "PASS" : "FAIL"}</td><td>${esc(check.what)}</td><td class="mono">${esc(check.detail)}</td></tr>`)
        .join("");
      const runsTable = run.stageRuns
        .map((entry) => {
          const park = run.parks.find((candidate) => candidate.stage === entry.stage && candidate.visit === entry.visit) || null;
          // The first stage of a queueing case also carries the wait: the row stood there while the live row ahead was
          // the queue's front, so its row in this table says both words the scenario is about.
          const waited = run.queued && run.started[0] && entry.id === run.started[0].run ? `queued ${run.queued.sweeps} sweeps · ` : "";
          const word = park ? `${waited}gated · ${esc(park.outcome)}` : bouncedRuns(run).has(entry.id) ? `${waited}bounced in` : `${waited}staged`;
          return `<tr><td class="mono">${esc(entry.id)}</td><td>${esc(entry.status || "—")}</td><td class="mono">${esc(entry.job || "—")}</td><td class="mono">${esc(entry.thread || "—")}</td><td>${esc(entry.artifact ? entry.artifact.path : "—")}</td><td class="mono">${esc(entry.artifact && entry.artifact.sha256 ? short(entry.artifact.sha256, 10) : "—")}</td><td>${esc(entry.decision ? entry.decision.trigger : "—")}${entry.decision && entry.decision.code ? ` · ${esc(entry.decision.code)}` : ""}</td><td>${word}</td></tr>`;
        })
        .join("");
      const steps = run.steps
        .map(
          (step) => `<tr class="${step.step === run.endedAtStep ? "last" : ""}"><td class="num">${step.step}</td><td>${esc(step.mode)}</td><td><b>${esc(step.state)}</b></td><td>${esc(step.stage || "—")}${step.via ? ` <span class="sub">via ${esc(step.via)}</span>` : ""}</td><td class="mono">${esc(step.waitingFor ? JSON.stringify(step.waitingFor) : "—")}</td><td class="num">${step.starts}</td><td class="mono">${esc(step.reason || "—")}</td></tr>`,
        )
        .join("");
      const doc = [
        `stages ${esc(run.document.stages.map((stage) => stage.id).join(" → "))}`,
        run.document.handoffs.length ? `handoffs ${esc(run.document.handoffs.map((handoff) => `${handoff.id} ${handoff.from}→${handoff.to} (${handoff.kind}${handoff.cap ? `, ${handoff.cap}` : ""})`).join("; "))}` : "no handoffs",
        run.document.gates.length ? `gates ${esc(run.document.gates.map((gate) => `${gate.id} after ${gate.after}${gate.decision ? ` → ${JSON.stringify(gate.decision.routes || {})}` : " (pause)"}`).join("; "))}` : "no gates",
      ].join(" · ");
      return `<section class="pipe">
  <h2>${esc(run.id)} <span class="sub">${esc(run.pipeline)} · ${esc(run.kind)}</span></h2>
  <p class="meta">row #${esc(run.row.id)} “${esc(run.row.title)}” · ${run.cuts} tree cut · ends <b>${esc(run.row.state)}</b> at ${esc(run.row.stage || "no stage")} · <b>${v.staged}</b> staged · <b>${v.gated}</b> gated · <b>${v.queued}</b> queued · <b>${v.bounced}</b> bounced</p>
  <p class="order">${esc(run.about)}</p>
  <p class="order"><b>The document:</b> ${doc}</p>
  <p class="reason">${esc(run.row.reason || "")}</p>
  <table><thead><tr><th>stage run</th><th>status</th><th>job</th><th>thread</th><th>artifact</th><th>sha256</th><th>decision</th><th>verdict</th></tr></thead><tbody>${runsTable}</tbody></table>
  <table class="steps"><thead><tr><th>#</th><th>mode</th><th>state</th><th>stage</th><th>waits on</th><th>starts</th><th>reason</th></tr></thead><tbody>${steps}</tbody></table>
  <table class="checks"><thead><tr><th></th><th>what the walk proves</th><th>the record it read</th></tr></thead><tbody>${checks}</tbody></table>
</section>`;
    })
    .join("\n");

  const failed = runs.reduce((n, run) => n + run.checks.filter((check) => !check.ok).length, 0);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>The pipeline bench — four shapes, one task each</title>
<style>
 body{background:#14161a;color:#e7e9ee;font:15px/1.55 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:32px 28px 64px;max-width:1240px}
 h1{font-size:26px;margin:0 0 6px} h2{font-size:19px;margin:34px 0 6px} .sub{color:#98a2b3;font-weight:400;font-size:13px}
 p{margin:6px 0} .meta{color:#98a2b3} code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;color:#c7ced9}
 .reason{color:#d7c9a8;border-left:2px solid #5b4a2a;padding-left:10px} .order{color:#c7ced9}
 table{border-collapse:collapse;width:100%;margin:10px 0 4px;font-size:13px}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #262a31;vertical-align:top}
 th{color:#98a2b3;font-weight:600;background:#191c21} .num{text-align:right;font-variant-numeric:tabular-nums}
 .nowrap{white-space:nowrap}
 .pass{display:inline-block;background:#12351f;color:#7ee2a8;border:1px solid #1f6b3d;border-radius:4px;padding:2px 8px;font-size:12px}
 .fail{display:inline-block;background:#3a1414;color:#ff9a9a;border:1px solid #7a2020;border-radius:4px;padding:2px 8px;font-size:12px}
 tr.bad td{background:#221315} tr.bad td:first-child{color:#ff9a9a;font-weight:600} tr.ok td:first-child{color:#7ee2a8}
 .steps td{font-size:12px} .steps tr.last td{border-bottom:1px solid #3a404a}
 .note{color:#98a2b3;font-size:13px;margin-top:34px;border-top:1px solid #262a31;padding-top:12px}
${REPORT_FOOTER_CSS}
</style></head><body>
<h1>The pipeline bench</h1>
<p class="meta">Four tiny documents, each attached to a real queue task and walked by <code>Assistant.sweepQueues</code> — the panel's own clock. Generated by <code>node tools/bench-pipeline.mjs</code> reading <code>${esc(bundleLabel)}</code> at ${esc(new Date().toISOString())}.</p>
<p class="order"><b>What it answers, per document and per stage:</b> did the assistant <b>stage</b> the work (a start, a settled run, the declared artifact), <b>gate</b> it (a park on the decision record and a crossing only when the record arrived), <b>queue</b> it (no start over a live row in front, then a start when the front settled), and <b>bounce</b> it (a reject routed back along the document's loop to an earlier stage)? Every row names its queue task; every stage names its stage run, job and thread; every failure names the step where the walk left the document.</p>
<p class="order"><b>${runs.length}</b> scenario${runs.length === 1 ? "" : "s"} · <b>${runs.reduce((n, run) => n + run.checks.length, 0)}</b> checks · <b>${failed}</b> failed. The ledger beside this page holds the same records as JSON.</p>
<table><thead><tr><th>scenario</th><th>pipeline</th><th>row</th><th>started, in order</th><th>end</th><th>staged</th><th>gated</th><th>queued</th><th>bounced</th><th></th></tr></thead><tbody>
${summary}
</tbody></table>
${sections}
<p class="note">A gate is crossed by its RECORD, never by a press: the decider in this bench writes the gate's own file only after the row has parked, and the next sweep reads it. The definitions are checked in under <code>tools/pipeline-bench/</code>; edit one and run the bench again — it reads the file, it does not rebuild it. Sandbox trees are removed unless <code>--keep</code> is given.</p>
${reportFooter(provenance)}
</body></html>
`;
}

// ---- main ---------------------------------------------------------------------------------------------------------
function recorder({ quiet }) {
  const checks = [];
  return {
    checks,
    check(ok, what, detail = "") {
      checks.push({ ok: Boolean(ok), what, detail: String(detail || "") });
      if (!quiet) console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
      return Boolean(ok);
    },
  };
}

const option = (argv, name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? fallback : fallback);

export async function runBench({ bundleFile = DEFAULT_BUNDLE, scenarioFile = DEFAULT_SCENARIOS, outDir = DEFAULT_OUT, only = [], write = true, keep = false, quiet = false } = {}) {
  const bench = loadBench({ bundleFile, scenarioFile });
  const wanted = (Array.isArray(only) ? only : String(only || "").split(","))
    .map((entry) => text(entry))
    .filter(Boolean);
  const chosen = wanted.length
    ? bench.scenarios.filter((scenario) => wanted.includes(scenario.id) || wanted.includes(scenario.pipeline))
    : bench.scenarios;
  if (!chosen.length) throw benchFault("bench-scenario", `no scenario matches --only ${JSON.stringify(wanted.join(","))} — the bench holds ${bench.scenarios.map((scenario) => scenario.id).join(", ")}`);

  const bundleRelative = path.relative(REPO, bench.bundleFile);
  const bundleLabel = bundleRelative.startsWith("..") || path.isAbsolute(bundleRelative) ? `<bundle>/${path.basename(bench.bundleFile)}` : bundleRelative.split(path.sep).join("/");
  const runs = [];
  let checks = 0;
  let failures = 0;
  for (const scenario of chosen) {
    if (!quiet) console.log(`\n== ${scenario.id} · ${scenario.pipeline} · ${scenario.title}`);
    let run;
    try {
      run = await walkScenario({ bundle: bench.bundle, scenario, keep });
    } catch (error) {
      // A walk that could not run is the bench's own failure, named with the scenario: the fixtures are wrong, and a
      // report of half a walk would read as a passing one.
      if (error && error.code === "bench-scenario") throw error;
      throw benchFault("bench-walk", `${scenario.id}: the walk could not run — ${String((error && error.stack) || error)}`);
    }
    const record = recorder({ quiet });
    run.checks = judge(run, scenario, { record });
    run.verdicts = verdictsOf(run);
    run.ok = run.checks.every((check) => check.ok);
    runs.push(run);
    checks += run.checks.length;
    failures += run.checks.filter((check) => !check.ok).length;
  }

  // The summary table, in the order the scenarios were walked. It is the answer a reader wants before the checks:
  // one line per document, the four verdict columns, and the end state.
  if (!quiet) {
    const width = Math.max(...runs.map((run) => run.id.length), 8);
    console.log(`\n${"scenario".padEnd(width)}  ${"row".padEnd(4)}  ${"staged".padEnd(6)} ${"gated".padEnd(5)} ${"queued".padEnd(6)} ${"bounced".padEnd(7)} end      pipeline`);
    for (const run of runs) {
      console.log(
        `${run.id.padEnd(width)}  ${`#${run.row.id}`.padEnd(4)}  ${String(run.verdicts.staged).padEnd(6)} ${String(run.verdicts.gated).padEnd(5)} ${String(run.verdicts.queued).padEnd(6)} ${String(run.verdicts.bounced).padEnd(7)} ${String(run.row.state).padEnd(8)} ${run.pipeline}${run.ok ? "" : "  ← FAILED"}`,
      );
    }
  }

  const wrote = [];
  if (write) {
    mkdirSync(outDir, { recursive: true });
    const ledgerFile = path.join(outDir, "ledger.json");
    const reportFile = path.join(outDir, "report.html");
    const ledger = { generatedAt: new Date().toISOString(), bundle: bundleLabel, fixture: path.basename(bench.scenarioFile), scenarios: chosen.map((scenario) => scenario.id), runs };
    writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 1)}\n`);
    writeFileSync(
      reportFile,
      report(
        runs,
        resolveReportProvenance({ repo: REPO, title: "The pipeline bench", source: `node tools/bench-pipeline.mjs reading ${bundleLabel}` }),
        bundleLabel,
      ),
    );
    wrote.push(ledgerFile, reportFile);
    if (!quiet) {
      console.log(`\nledger  ${ledgerFile}`);
      console.log(`report  ${reportFile}`);
    }
  }
  if (!quiet) console.log(`\n${checks - failures} / ${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  return { ok: failures === 0, runs, checks, failures, wrote, bundle: bundleLabel };
}

const USAGE = [
  "node tools/bench-pipeline.mjs [--only <id,id>] [--bundle <path>] [--scenarios <path>] [--out <dir>] [--no-write] [--keep] [--quiet]",
  "  walk the four bench documents through the panel, one real queue task each, and report per pipeline and per stage",
  "  --only       scenario ids or pipeline ids (default: every scenario in the fixture)",
  "  --bundle     the panel bundle to read (default: tools/pipeline-bench/bundle.json)",
  "  --scenarios  the expectations beside it (default: tools/pipeline-bench/scenarios.json)",
  "  --out        where ledger.json and report.html go (default: docs/reviews/pipeline-bench)",
  "  --no-write   print only; the ledger and the report are not written",
  "  --keep       keep the sandbox trees",
];

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    for (const line of USAGE) console.log(line);
    return 0;
  }
  const only = String(option(argv, "--only", "") || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  try {
    const result = await runBench({
      bundleFile: path.resolve(option(argv, "--bundle", DEFAULT_BUNDLE)),
      scenarioFile: path.resolve(option(argv, "--scenarios", DEFAULT_SCENARIOS)),
      outDir: path.resolve(option(argv, "--out", DEFAULT_OUT)),
      only,
      write: !argv.includes("--no-write"),
      keep: argv.includes("--keep"),
      quiet: argv.includes("--quiet"),
    });
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`bench-pipeline: ${error && error.code ? `${error.code}: ` : ""}${String((error && error.message) || error)}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
