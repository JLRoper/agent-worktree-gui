#!/usr/bin/env node
// tools/pipeline-state.mjs - one queue row's state, read out of its `pipelineRun`.
//
// WHY. A pipeline row is the one row on the board whose condition lives in a record rather than in a job: which
// stage it stands on, which trees it owns, what each stage settled with, what a gate is waiting for, and whether
// the round still owes its assembly. Reading that by eye out of `state/assistants/<id>/queue.json` is how a stage
// gets worked in the wrong tree (task #260: `implement` was started in another row's directory, on the round's
// branch, and parked on an artifact that was never in the tree the panel was reading). This tool prints the record
// the panel reads, in the order a reader needs it, and names the one step the row is owed.
//
// WHAT IT DOES NOT DO. It writes nothing: no queue, no journal, no tree, no start. It reads the queue, the bundle
// and the job store, and answers. The cut, the start, the advance and the assembly are the panel's
// (`lib/task-pipeline-drive.js`, `lib/pipeline-assembly.js`); this is the read that tells a reader which of them is
// owed.
//
//   node tools/pipeline-state.mjs 260
//   node tools/pipeline-state.mjs 260 --assistant assistant-1
//   node tools/pipeline-state.mjs 260 --json
//   node tools/pipeline-state.mjs 260 --state-dir <dir> --bundle <file>
//
// Exit: 0 the row was found and printed (a row with no pipelineRun prints assistant-decides and still exits 0) ·
// 1 no row with that id, or a queue/bundle that could not be read · 2 a usage error.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { queuePathOf, readQueueFile } from "../lib/assistant/queue.js";
import { readBundle } from "../lib/pipeline-bundle.js";
import { resolveDirs, resolveLayout, statePaths } from "../lib/paths.js";
import { stageTreeName } from "../lib/stage-tree-name.js";
import {
  ASSISTANT_DECIDES,
  TASK_PIPELINE_FIELD,
  elapsedInStage,
  resolveTaskPipeline,
  stageRunFor,
  stageRunsOf,
} from "../lib/task-pipeline.js";
import {
  STARTING_AT,
  WAITING_FOR,
  artifactOf,
  artifactValues,
  assemblyPlanOf,
  gateAfter,
  roundOf,
  stageTreeLookup,
  verdictOf,
} from "../lib/task-pipeline-drive.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const USAGE = `pipeline-state - one queue row's state, read from its pipelineRun

  node tools/pipeline-state.mjs <task id> [options]

Options
  --assistant <id>   read that assistant's queue only (default: every queue under the state directory)
  --state-dir <dir>  the panel's state directory (default: lib/paths.js resolves it - WAG_HOME, else the data dir)
  --bundle <file>    the PDL bundle to resolve the row against (default: config.pipelineBundleFile)
  --now <iso>        the clock the elapsed spans are measured at (default: now)
  --json             print the state as one JSON object instead of the report
  --help             this text

Reads the queue, the bundle and the job store; writes nothing. Exit 0 found, 1 not found or unreadable, 2 usage.`;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clip = (value, max = 220) => {
  const t = text(value);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}...` : t;
};

// A span a person reads: 4s, 12m 08s, 1h 19m 44s, 2d 03h 11m. Empty for a record whose stamp cannot be read -
// every caller prints the reason beside it rather than inventing a zero.
export function spanText(ms) {
  if (!Number.isFinite(ms)) return "";
  let rest = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(rest / 86400);
  rest -= days * 86400;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  const seconds = rest - minutes * 60;
  if (days) return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function parseArgs(argv) {
  const out = { id: null, assistantId: null, stateDir: null, bundle: null, now: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--assistant") out.assistantId = text(argv[(i += 1)]) || null;
    else if (arg === "--state-dir") out.stateDir = text(argv[(i += 1)]) || null;
    else if (arg === "--bundle") out.bundle = text(argv[(i += 1)]) || null;
    else if (arg === "--now") out.now = text(argv[(i += 1)]) || null;
    else if (/^\d+$/.test(arg)) out.id = Number(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

// The state directory without booting a server: `resolveLayout` reads the same config a booted panel reads, so
// WAG_HOME, a moved config.json and an explicit --state-dir all answer the way the panel itself would.
export function resolveStateDir({ stateDir = null, here = ROOT } = {}) {
  if (stateDir) return path.resolve(stateDir);
  const layout = resolveLayout({ here });
  return layout.paths.stateDir || resolveDirs({}).dataDir;
}

export function resolveBundleFile({ bundle = null, stateDir, here = ROOT } = {}) {
  if (bundle) return path.resolve(bundle);
  const layout = resolveLayout({ here });
  // A --state-dir names a DIFFERENT install's state: the bundle beside it is that install's, not the one the
  // checkout's own config points at. Only the resolved layout's state directory keeps the config's custom name.
  if (path.resolve(stateDir) !== path.resolve(layout.paths.stateDir)) return path.join(path.resolve(stateDir), "pipeline-bundle.json");
  return layout.paths.pipelineBundleFile || statePaths({ dataDir: path.dirname(stateDir) }).pipelineBundleFile;
}

// Every row with this id, and where it was found. A queue that cannot be read is named rather than skipped: an id
// "not found" because a file was corrupt is the wrong answer.
export function findRows({ stateDir, id, assistantId = null }) {
  const rows = [];
  const problems = [];
  const dirs = assistantId
    ? [{ id: assistantId, file: queuePathOf(stateDir, assistantId) }]
    : (() => {
        const base = path.join(stateDir, "assistants");
        let names = [];
        try {
          names = readdirSync(base, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        } catch {
          return [];
        }
        return names.map((name) => ({ id: name, file: queuePathOf(stateDir, name) }));
      })();
  for (const entry of dirs) {
    const queue = readQueueFile(entry.file);
    if (queue.error) {
      problems.push({ queue: entry.file, reason: queue.error });
      continue;
    }
    const task = queue.tasks.find((candidate) => candidate.id === id) || null;
    if (task) rows.push({ assistantId: entry.id, queue: entry.file, task });
  }
  return { rows, problems };
}

// The job store, read only for one fact: is the thread carrying this stage live? A row whose worker is running has
// not settled its stage, whatever the ledger's last attempt says.
function readJobs(jobsFile) {
  try {
    const doc = JSON.parse(readFileSync(jobsFile, "utf8"));
    const list = Array.isArray(doc) ? doc : Array.isArray(doc && doc.jobs) ? doc.jobs : [];
    return { ok: true, jobs: list };
  } catch (error) {
    return { ok: false, jobs: [], reason: String((error && error.message) || error) };
  }
}

const LIVE = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);

// The set of facts that makes the settle's artifact fact say "not there" while the file is there now. It is the
// difference between a park a reader can release and one they re-run.
function decisionPresentFalse(entry) {
  const fact = isObject(entry && entry.decision && entry.decision.fact) ? entry.decision.fact : null;
  return Boolean(fact && fact.kind === "artifact" && fact.present === false);
}

function liveJobFor(jobs, { thread = null, job = null }) {
  const id = text(job);
  const byId = id ? jobs.find((entry) => text(entry && entry.id) === id) : null;
  if (byId) return byId;
  const name = text(thread);
  if (!name) return null;
  const hits = jobs.filter((entry) => text(entry && entry.thread) === name);
  return hits.length ? hits[hits.length - 1] : null;
}

// The one thing the row is owed, in the reader's terms. Every line names an OWNER (the panel, the seat, the reader)
// so a reader never starts a step the panel owns and never waits for one it must do itself.
export function owedLines(state) {
  const lines = [];
  const { row, record, resolution, tree, stage, gate, artifact, artifactCheck, verdict, current, jobs } = state;
  if (!record) {
    lines.push(`nothing to drive: this row carries no pipelineRun, so it is on ${ASSISTANT_DECIDES} and the assistant decides its next turn.`);
    return lines;
  }
  if (String(row.state || "") === "done") {
    lines.push(`the row is done${row.doneAt ? ` at ${row.doneAt}` : ""}${row.reason ? `: ${clip(row.reason, 240)}` : ""}. The record is history; nothing is owed.`);
    return lines;
  }
  if (resolution && resolution.mode === "unresolved") {
    lines.push(`fix the record first: ${resolution.reason}`);
    lines.push("the panel does not guess a stage from an unresolved record; a written record that is not an assignment is not the default path either.");
    return lines;
  }
  const waiting = isObject(record[WAITING_FOR]) ? record[WAITING_FOR] : null;
  const parked = String(row.state || "") === "parked" || (isObject(row.hold) && row.hold.kind === "manual");
  if (parked) {
    lines.push(`the row is parked: ${clip(row.reason || (current && current.decision && current.decision.reason) || "no reason on the record", 400)}`);
    const code = text(current && current.decision && current.decision.code);
    if (code === "pipeline-cap") {
      lines.push('release a cap park with POST /api/assistant/queue {action: "pipeline-release", id, release: "cap"} - a requeue alone re-parks on the next settle.');
    } else if (code === "pipeline-changed") {
      lines.push('release a routing-change park with POST /api/assistant/queue {action: "pipeline-release", id, release: "route"} - it re-stamps the fingerprint and moves nothing else.');
    } else {
      lines.push("every other park is released by fixing the fact (write the artifact or verdict, repair the tree, fix the record) and then requeueing the row; the panel never releases a manual hold itself.");
    }
    if (artifact && artifact.path && artifactCheck && artifactCheck.present === false) {
      lines.push(`this stage owns the artifact ${artifact.id || "(unnamed)"} at ${artifact.path}${artifact.writer ? ` (writer ${artifact.writer})` : ""}: write it, commit it in the stage's own tree, then requeue.`);
    }
    if (artifact && artifact.path && artifactCheck && artifactCheck.present === true && decisionPresentFalse(current)) {
      lines.push("the artifact is in the tree NOW although the settle recorded it missing: commit it and requeue the row, and the next pass re-reads the artifact.");
    }
    if (state.uncut) {
      lines.push(`this stage advanced with no tree of its own: its entry names ${state.uncut.path || "(no path)"} but pipelineRun.trees["${state.uncut.stage}"] was never written. That is the #260 stall - do not keep working there; re-enter the stage so the panel cuts ${state.uncut.name || "its own child tree"} from the round's parent and records it.`);
    }
    if (gate && isObject(gate.decision) && gate.decision.path) {
      lines.push(`the gate after ${stage ? stage.id : record.stage} reads ${gate.decision.path}${gate.decision.writer ? ` (writer ${gate.decision.writer})` : ""}; the panel never writes it.`);
    }
    return lines;
  }
  if (waiting) {
    const where = text(waiting.path) || text(waiting.edge) || text(waiting.stage) || "a record";
    lines.push(`waiting on ${text(waiting.kind) || "a record"}: ${where}. The panel's next pass reads it; no press starts the row.`);
  }
  if (tree && tree.needed) {
    lines.push(`the stage has NO TREE yet: its cut is owed (the panel's ensureTree/cutPipelineTree), from the round's parent branch, and the next pass starts it in that tree.`);
    lines.push("do not start this stage in pipelineRun.tree (the round's landing branch), in the previous stage's tree, or in the project checkout - that is the #260 stall.");
    return lines;
  }
  if (tree && tree.lost) {
    lines.push(`the stage's recorded tree is gone: ${tree.lost.path} (last stage ${tree.lost.stage || "?"}). restore it or re-enter the stage; the panel never cuts a replacement for a recorded tree.`);
    return lines;
  }
  if (jobs && jobs.live) {
    lines.push(`the stage's worker is ${text(jobs.live.status) || "live"} on thread ${text(jobs.live.thread) || "(none)"} (job ${text(jobs.live.id) || "(none)"}): the panel advances the row when that run settles.`);
  } else if (current && text(current.status) === "done" && !current.decision) {
    lines.push("the stage's run reads done and its settle is unread: the panel's next pass writes the decision and moves the row. Do not start the stage again.");
  } else if (current && !text(current.status)) {
    lines.push("the stage's entry is open: the panel asks for its worker on the next pass (spawn: auto); a start it cannot make parks the row with the refusal.");
  }
  if (gate && isObject(gate.decision) && gate.decision.path) {
    const outcomes = Array.isArray(gate.decision.outcomes) && gate.decision.outcomes.length ? `outcomes ${gate.decision.outcomes.join(" | ")}` : "no declared outcomes";
    lines.push(`this stage owes the gate's verdict at ${gate.decision.path} (${outcomes}${gate.decision.writer ? `, writer ${gate.decision.writer}` : ""})${verdict && verdict.outcome ? ` - it reads "${verdict.outcome}" now` : ""}.`);
  }
  if (state.assembly) {
    lines.push(`the round is assembled at ${String(state.assembly.commit || "").slice(0, 8)} on ${state.assembly.branch}: land THAT branch (pipelineRun.tree), never a stage branch.`);
  } else if (state.over && state.assemblyPlan) {
    if (state.assemblyPlan.offered) {
      lines.push(`the pipeline is over and the assembly is owed: ${state.assemblyPlan.stages.length} stage commit(s) onto ${state.assemblyPlan.parentPath || state.assemblyPlan.parent} (the panel's assembly), then land the assembly branch.`);
    } else if (state.assemblyPlan.done) {
      lines.push(state.assemblyPlan.why);
    } else {
      lines.push(`the pipeline is over: ${state.assemblyPlan.why}`);
    }
  }
  if (!lines.length) lines.push("the panel owns the next step: its queue tick (driveTaskPipelines) reads the settle and advances, parks or finishes the row.");
  return lines;
}

// The whole state of one row, as a value. Pure except for the two tree reads (`stageTreeLookup` stats the recorded
// paths) and the verdict/artifact reads (they read files in that tree) - the record itself is not written.
export function pipelineStateOf(task, { bundle = null, bundleFile = null, bundleOk = null, bundleReason = null, queue = null, assistantId = null, now = Date.now(), jobs = [] } = {}) {
  const record = isObject(task && task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  const resolution = resolveTaskPipeline(task, { bundle, now });
  const pipeline = bundle && resolution && resolution.ok ? (bundle.pipelines || []).find((entry) => entry.id === resolution.pipeline) || null : null;
  const stage = pipeline && resolution.ok ? (pipeline.stages || []).find((entry) => entry.id === resolution.stage) || null : null;
  const gate = pipeline && stage ? gateAfter(pipeline, stage.id) : null;
  const tree = pipeline && record ? stageTreeLookup(task, pipeline, record) : null;
  const worktree = tree && tree.path ? tree.path : null;
  const values = record && stage ? artifactValues(record, stage.id) : null;
  const artifact = stage && isObject(stage.artifact) ? stage.artifact : null;
  const artifactCheck = artifact && worktree ? artifactOf(artifact, { worktree, values }) : null;
  const verdict = gate && worktree ? verdictOf(gate, { worktree, values }) : null;
  const ledger = record ? stageRunsOf(record) : [];
  const current = record ? stageRunFor(record, { stage: text(record.stage) }) : null;
  const live = liveJobFor(jobs, { thread: current && current.thread, job: current && current.job });
  const stageIndex = pipeline ? (pipeline.stages || []).findIndex((entry) => entry.id === (resolution && resolution.stage)) : -1;
  const last = pipeline && stageIndex === (pipeline.stages || []).length - 1;
  const over = Boolean(pipeline && stage && last && current && text(current.status) === "done");
  // THE #260 STALL, AS A VALUE. A row with a round gives every stage its own child tree, and that cut writes
  // `trees[stage]`. A stage whose entry names a tree while `trees[stage]` is missing was STARTED without its cut -
  // it is standing in a directory the round never gave it (another row's tree, the round's landing tree, or a path
  // that was hand-made). The tree lookup still answers that path, which is exactly why a reader must be told: the
  // record's own ledger is the only place the missing cut shows.
  const currentTree = current && isObject(current.tree) ? current.tree : null;
  const recordedTrees = isObject(record && record.trees) ? record.trees : {};
  const round = record ? roundOf(record) : null;
  const named = round && stage ? stageTreeName(round, { id: stage.id, name: stage.title || stage.id, position: stage.position ?? null }, current && current.visit ? current.visit : 1) : null;
  const uncut = round && current && currentTree && text(currentTree.path) && !(isObject(recordedTrees[text(record.stage)]) && text(recordedTrees[text(record.stage)].path))
    ? { stage: text(record.stage), path: text(currentTree.path), name: named ? named.dir : null }
    : null;
  return {
    assistantId: assistantId || null,
    queue: queue || null,
    readAt: new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString(),
    bundle: { file: bundleFile || null, ok: bundleOk === true, reason: bundleReason || null },
    row: task
      ? {
          id: task.id,
          title: task.title || null,
          state: task.state || null,
          project: task.project || null,
          worktree: task.worktree || null,
          createdAt: task.createdAt || null,
          startedAt: task.startedAt || null,
          doneAt: task.doneAt || null,
          hold: isObject(task.hold) ? task.hold : null,
          reason: task.reason || null,
        }
      : null,
    record,
    resolution,
    pipeline: pipeline ? { id: pipeline.id, title: pipeline.title, isolation: pipeline.isolation || "shared", stageCount: (pipeline.stages || []).length } : null,
    stage: stage ? { id: stage.id, title: stage.title, position: stage.position, artifact } : null,
    gate: gate ? { id: gate.id, name: gate.name, after: gate.after, decision: gate.decision || null } : null,
    artifact,
    artifactCheck,
    verdict,
    tree,
    round,
    uncut,
    recordedTree: isObject(record && record.tree) ? record.tree : null,
    trees: isObject(record && record.trees) ? record.trees : {},
    ledger,
    current,
    startingAt: text(record && record[STARTING_AT]) || null,
    waitingFor: isObject(record && record[WAITING_FOR]) ? record[WAITING_FOR] : null,
    crossings: isObject(record && record.crossings) ? record.crossings : {},
    route: text(record && record.route) || null,
    via: text(record && record.via) || null,
    assembly: isObject(record && record.assembly) ? record.assembly : null,
    over,
    assemblyPlan: over && pipeline && record ? assemblyPlanOf(task, pipeline, record) : null,
    jobs: {
      read: Array.isArray(jobs),
      live: live && LIVE.has(String(live.status || "")) ? { id: live.id || null, thread: live.thread || null, status: live.status || null } : null,
      last: live ? { id: live.id || null, thread: live.thread || null, status: live.status || null } : null,
    },
    elapsedStage: record ? elapsedInStage(record.enteredAt, { now }) : null,
  };
}

function shortHash(value, length = 10) {
  const t = text(value);
  return t ? t.slice(0, length) : "";
}

// The report a reader scans: row, run, trees, ledger, what the stage owes, assembly, and the one owed step. No em
// or en dashes anywhere, because the panel's own journal and cards are read through tools that treat them as noise.
export function renderPipelineState(state) {
  const lines = [];
  const row = state.row || {};
  const run = state.record;
  const head = `row ${row.id ?? "?"}${state.assistantId ? ` · ${state.assistantId}` : ""}${row.state ? ` · ${row.state}` : ""}`;
  lines.push(head);
  if (row.title) lines.push(`title   ${clip(row.title, 160)}`);
  if (row.project || row.worktree) lines.push(`where   project ${row.project || "(none)"}${row.worktree ? ` · worktree ${row.worktree}` : ""}`);
  if (row.hold) lines.push(`hold    ${text(row.hold.kind) || "?"}${text(row.hold.value) ? ` ${clip(row.hold.value, 120)}` : ""}${text(row.hold.since) ? ` since ${row.hold.since}` : ""}`);
  if (row.reason) lines.push(`reason  ${clip(row.reason, 400)}`);
  lines.push(`bundle  ${state.bundle.file || "(none)"}${state.bundle.ok ? "" : ` - NOT READABLE: ${state.bundle.reason || "unknown"}`}`);

  if (!run) {
    lines.push("");
    lines.push(`stage   ${ASSISTANT_DECIDES} - no pipelineRun, so there is no stage, tree, artifact or gate to read.`);
    lines.push("");
    lines.push("next step");
    for (const line of owedLines(state)) lines.push(`  ${line}`);
    return lines.join("\n");
  }

  const resolution = state.resolution || {};
  const elapsed = state.elapsedStage;
  const elapsedText = elapsed && elapsed.ok ? `${spanText(elapsed.ms)} in stage` : "time in stage not computable";
  lines.push("");
  lines.push(`run     ${text(run.pipeline) || "(no pipeline)"} · ${text(run.stage) || "(no stage)"}${resolution.ok ? ` (${resolution.position} of ${resolution.count})` : ""} · ${elapsedText}`);
  if (resolution.ok) lines.push(`stage   ${clip(resolution.stageTitle || "", 120)} · visit ${resolution.visit} · entered ${resolution.enteredAt}`);
  if (!resolution.ok) lines.push(`record  UNRESOLVED: ${resolution.reason}`);
  const facts = [];
  if (state.via) facts.push(`via ${state.via}`);
  if (state.route) facts.push(`route ${clip(state.route, 24)}`);
  const crossings = Object.entries(state.crossings || {});
  if (crossings.length) facts.push(`crossings ${crossings.map(([edge, count]) => `${edge}=${count}`).join(" ")}`);
  if (state.startingAt) facts.push(`start asked ${state.startingAt}`);
  if (facts.length) lines.push(`facts   ${facts.join(" · ")}`);

  lines.push("");
  const round = state.round;
  if (round) {
    const parts = [`parent ${round.parent || "(none)"}`, `sha ${shortHash(round.sha, 12) || "(none)"}`];
    if (round.parentPath) parts.push(`tree ${round.parentPath}`);
    else parts.push("no parent tree (a record from before the model, or a block)");
    lines.push(`round   ${parts.join(" · ")}`);
  } else {
    lines.push("round   none - this record predates rounds and keeps the one tree it was cut under");
  }
  const tree = state.tree;
  if (tree) {
    if (tree.path) lines.push(`tree    ${tree.path}${tree.source ? ` (${tree.source})` : ""}${tree.tree && tree.tree.branch ? ` on ${tree.tree.branch}` : ""}`);
    else if (tree.needed) lines.push("tree    NOT CUT - this stage has no tree yet; the cut is owed");
    else if (tree.lost) lines.push(`tree    GONE - ${tree.lost.path} (recorded for ${tree.lost.stage || "another stage"})`);
  }
  if (state.recordedTree && (!tree || tree.path !== state.recordedTree.path)) {
    lines.push(`landing pipelineRun.tree ${state.recordedTree.path || "(none)"}${state.recordedTree.branch ? ` on ${state.recordedTree.branch}` : ""}`);
  }
  if (state.uncut) {
    lines.push(`uncut   ${state.uncut.stage} runs in ${state.uncut.path} but pipelineRun.trees["${state.uncut.stage}"] is absent - the stage advanced with no tree of its own (the #260 stall)`);
  }
  const otherTrees = Object.entries(state.trees || {}).filter(([, entry]) => isObject(entry));
  if (otherTrees.length) {
    lines.push("trees");
    for (const [stageId, entry] of otherTrees) {
      const cut = text(entry.cutAt) ? ` cut ${entry.cutAt}` : "";
      lines.push(`  ${stageId.padEnd(14)} ${entry.path || "(none)"}${entry.branch ? ` on ${entry.branch}` : ""}${cut}`);
    }
  }

  lines.push("");
  lines.push("stages");
  if (!state.ledger.length) lines.push("  (no stage run recorded - the row has not asked for a start yet)");
  for (const entry of state.ledger) {
    const id = text(entry.id) || `${text(entry.stage)}#${entry.visit ?? "?"}`;
    const span = [text(entry.at), text(entry.settledAt) ? `-> ${entry.settledAt}` : ""].filter(Boolean).join(" ");
    const bits = [text(entry.status) || "open", span];
    if (entry.commit) bits.push(`commit ${shortHash(entry.commit, 12)}`);
    if (entry.artifact) {
      const present = entry.artifact.present === true ? "present" : entry.artifact.present === false ? "MISSING" : "unknown";
      bits.push(`artifact ${entry.artifact.id || "?"} ${entry.artifact.path || "?"} ${present}`);
    }
    if (entry.merge && entry.merge.commit) bits.push(`merge ${shortHash(entry.merge.commit, 12)}`);
    lines.push(`  ${id}`);
    lines.push(`    ${bits.join(" · ")}`);
    if (entry.thread || entry.job) lines.push(`    thread ${entry.thread || "(none)"} · job ${entry.job || "(none)"}`);
    if (entry.decision && entry.decision.reason) {
      lines.push(`    decision ${entry.decision.code || "moved"} ${entry.decision.reason}`);
    }
  }

  const artifact = state.artifact;
  if (artifact) {
    lines.push("");
    lines.push("stage owes");
    const present = state.artifactCheck ? (state.artifactCheck.present ? "present" : "NOT IN THE TREE") : "not checked (no tree)";
    lines.push(`  artifact ${artifact.id || "(unnamed)"} at ${artifact.path || "(no path)"}${artifact.kind ? ` · kind ${artifact.kind}` : ""}${artifact.writer ? ` · writer ${artifact.writer}` : ""} - ${present}`);
  }
  const gate = state.gate;
  if (gate) {
    if (!artifact) lines.push("");
    if (!artifact) lines.push("stage owes");
    const decision = isObject(gate.decision) ? gate.decision : {};
    const outcomes = Array.isArray(decision.outcomes) && decision.outcomes.length ? decision.outcomes.join(" | ") : "none declared";
    const routes = isObject(decision.routes) ? Object.entries(decision.routes).map(([outcome, edge]) => `${outcome} -> ${edge === null ? "end" : edge}`).join(", ") : "not routed";
    lines.push(`  gate ${gate.id || "(unnamed)"}${gate.name ? ` (${gate.name})` : ""} after ${gate.after || "?"} reads ${decision.path || "(no path)"} · outcomes ${outcomes} · ${routes}${decision.writer ? ` · writer ${decision.writer}` : ""}`);
    if (state.verdict) lines.push(`  verdict ${state.verdict.outcome ? `"${state.verdict.outcome}"` : "none"}${state.verdict.reason ? ` - ${state.verdict.reason}` : ""}`);
  }

  if (state.assembly) {
    lines.push("");
    const a = state.assembly;
    const stages = Array.isArray(a.stages) ? a.stages.length : 0;
    const skipped = Array.isArray(a.skipped) ? a.skipped.length : 0;
    lines.push(`assembly ${a.branch || a.path || "(no branch)"} at ${shortHash(a.commit, 12) || "(no commit)"} · base ${shortHash(a.base, 12)} · ${stages} stage(s)${skipped ? ` · ${skipped} skipped` : ""}${a.verified ? ` · verified ${a.verified}` : ""}`);
  }

  lines.push("");
  lines.push("next step");
  for (const line of owedLines(state)) lines.push(`  ${line}`);
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`pipeline-state: ${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!opts.id) {
    process.stderr.write(`pipeline-state: name one task id\n\n${USAGE}\n`);
    return 2;
  }
  let now = Date.now();
  if (opts.now) {
    const parsed = Date.parse(opts.now);
    if (!Number.isFinite(parsed)) {
      process.stderr.write(`pipeline-state: --now ${JSON.stringify(opts.now)} is not an instant\n`);
      return 2;
    }
    now = parsed;
  }
  const stateDir = resolveStateDir({ stateDir: opts.stateDir });
  const bundleFile = resolveBundleFile({ bundle: opts.bundle, stateDir });
  const found = findRows({ stateDir, id: opts.id, assistantId: opts.assistantId });
  for (const problem of found.problems) process.stderr.write(`pipeline-state: cannot read ${problem.queue}: ${problem.reason}\n`);
  if (!found.rows.length) {
    const where = opts.assistantId ? `${stateDir} for ${opts.assistantId}` : stateDir;
    process.stderr.write(`pipeline-state: no task ${opts.id} in the queues under ${where}\n`);
    return 1;
  }
  if (found.rows.length > 1) {
    process.stderr.write(`pipeline-state: task ${opts.id} is in ${found.rows.length} queues (${found.rows.map((entry) => entry.assistantId).join(", ")}); printing each\n`);
  }
  const source = existsSync(bundleFile) ? readBundle(bundleFile) : { ok: false, reason: `there is no bundle at ${bundleFile}`, file: bundleFile };
  const jobsFile = path.join(stateDir, "jobs.json");
  const store = readJobs(jobsFile);
  for (const found1 of found.rows) {
    const state = pipelineStateOf(found1.task, {
      bundle: source && source.ok === true ? source.bundle : null,
      bundleFile,
      bundleOk: source && source.ok === true,
      bundleReason: source && source.ok === true ? null : source && source.reason,
      queue: found1.queue,
      assistantId: found1.assistantId,
      now,
      jobs: store.jobs,
    });
    if (opts.json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    else process.stdout.write(`${renderPipelineState(state)}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
