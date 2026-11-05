// The task pipeline WINDOW's one answer: given a task record and the bundle the panel read, every stage of the task's
// pipeline in order, which one is current, what ended the one before it, and how long the task has been in it.
//
// This is a READING of the contract, not a second one. The two modules it stands on already answer every question the
// window asks, and neither is changed here:
//
//   lib/pipeline-bundle.js  — what a bundle holds: `pipeline.stages` in order (each with `position`), `pipeline.gates`
//                             (each `after` a stage, deciding an artifact), `pipeline.handoffs` (from -> to), and the
//                             refusal a bad bundle gets, with the file's own locator.
//   lib/task-pipeline.js    — which mode a record is in (assistant-decides / pipeline / unresolved), and `elapsedInStage`
//                             from the STORED `enteredAt` against a `now` the caller passes.
//
// So this module adds exactly two things those two cannot: the SEQUENCE with the current stage marked, and the gate that
// ended the stage before it. Four rules decide the shape:
//
//   1. Evidence, never an index. Every stage row carries its name, its `position` of `count`, the artifact it produces
//      and the gate that ends it; `previous` names the stage before the current one, the gate that ended it (or null,
//      with the handoff that joined them, when the bundle draws no gate there) and the stamp the current stage began.
//   2. Unresolved is its own answer. A record the bundle cannot resolve keeps the contract's mode and sentence, and
//      `unresolved.kind` names WHY (`bundle`, `record`, `pipeline`, `stage`, `enteredAt`) rather than leaving a page to
//      re-read the sentence. It never falls back to assistant-decides.
//   3. A stage the pipeline no longer holds still gets its sequence — drawn `unplaced` — because "the record points at
//      a stage this pipeline dropped" is only readable beside the stages it still has.
//   4. Time is STORED. `computedAt` is the one instant this answer was computed at, so a page can advance the number
//      while the window is open (and must re-ask on open, not remember a number from an hour ago).
//
// The route at the bottom is the HTTP adapter for exactly this model: one read, no writes, and a refusal carried as a
// value so the dialog can draw the reason instead of a 500.
import { readBundle } from "./pipeline-bundle.js";
import { ASSISTANT_DECIDES, TASK_PIPELINE_FIELD, resolveTaskPipeline } from "./task-pipeline.js";

// The named reasons a window can be unresolved for. A page and a test name one of these; the sentence is free to get
// better without the name moving.
export const WINDOW_FAULTS = Object.freeze({
  BUNDLE: "bundle", // there is no bundle, or the one there is was refused whole
  RECORD: "record", // the record's pipelineRun is not an assignment at all
  PIPELINE: "pipeline", // it names a pipeline the bundle does not hold
  STAGE: "stage", // it names a stage the pipeline does not hold (or none at all)
  ENTERED_AT: "enteredAt", // the stage is known, the stored stamp is not a UTC instant
});

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isoOf = (now) => {
  const ms = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(String(now ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// What the loader said, as the page needs it: whether the bundle is readable, and if not, which rule refused it and
// where in the exported file a reader would find it. `null` means nothing was read for this window.
function bundleStateOf(source) {
  if (!source) {
    return { ok: false, code: WINDOW_FAULTS.BUNDLE, reason: "no bundle was read for this window — there is nothing to resolve a pipeline against", where: null, file: null, name: null };
  }
  const bundle = source.ok === true ? source.bundle : null;
  return {
    ok: source.ok === true,
    code: source.ok === true ? null : source.code || WINDOW_FAULTS.BUNDLE,
    reason: source.ok === true ? null : text(source.reason) || "the bundle was refused",
    where: source.ok === true ? null : source.where || null,
    file: source.file || null,
    name: text(bundle && bundle.name) || null,
  };
}

// The gate that ENDS this stage: the bundle's gates follow the stage they close, so a gate's `after` is this id.
function gateEnding(pipeline, stageId) {
  const gate = (pipeline.gates || []).find((g) => g.after === stageId);
  return gate || null;
}

// The handoff out of, and into, a stage. More than one edge can leave a stage (a loop returns to it as well), so the
// joining edge is the one that goes where the sequence goes next; anything else is carried as it is.
function handoffOut(pipeline, stageId, nextId) {
  const edges = (pipeline.handoffs || []).filter((h) => h.from === stageId);
  return edges.find((h) => h.to === nextId) || edges[0] || null;
}

function handoffInto(pipeline, stageId, prevId) {
  const edges = (pipeline.handoffs || []).filter((h) => h.to === stageId);
  return edges.find((h) => h.from === prevId) || edges[0] || null;
}

// One row per stage. `phase` is the window's whole opinion: what came before, what is now, what is still ahead — or
// `unplaced` when the record names a stage this pipeline no longer holds, so nothing can be called current.
function stageRows(pipeline, phaseOf) {
  return (pipeline.stages || []).map((stage) => {
    const next = pipeline.stages[stage.position] || null; // the array is 0-based; position is 1-based
    const prev = pipeline.stages[stage.position - 2] || null;
    return {
      id: stage.id,
      title: stage.title,
      position: stage.position,
      phase: phaseOf(stage),
      artifact: stage.artifact,
      // What the stage is handed, from the document's own `inputs.read[]`. Carried, never resolved: a read names an
      // artifact and a ledger locator, and the drawing says which stage or boundary the artifact comes from.
      reads: Array.isArray(stage.reads) ? stage.reads : [],
      gateEnding: gateEnding(pipeline, stage.id),
      handoffIn: handoffInto(pipeline, stage.id, prev && prev.id),
      handoffOut: handoffOut(pipeline, stage.id, next && next.id),
    };
  });
}

// The stage before the current one, the gate that ended it, and the edge that joined them to here.
function previousOf(rows, index) {
  const prev = index > 0 ? rows[index - 1] : null;
  if (!prev) return null;
  return {
    stage: { id: prev.id, title: prev.title, position: prev.position },
    gate: prev.gateEnding,
    handoff: prev.handoffOut,
  };
}

// Why the contract's answer is unresolved. Read off the RECORD and the bundle, never parsed out of the sentence.
function unresolvedKind({ run, bundle, pipeline, stage }) {
  if (!bundle) return WINDOW_FAULTS.BUNDLE;
  if (!isObject(run)) return WINDOW_FAULTS.RECORD;
  if (!text(run.pipeline)) return WINDOW_FAULTS.RECORD;
  if (!pipeline) return WINDOW_FAULTS.PIPELINE;
  if (!text(run.stage)) return WINDOW_FAULTS.STAGE;
  if (!stage) return WINDOW_FAULTS.STAGE;
  return WINDOW_FAULTS.ENTERED_AT;
}

// The window's model. `task` is the queue record as the panel holds it (never mutated), `source` is the envelope
// `readBundle`/`parseBundle` returns, and `now` is the clock every elapsed number is computed against.
export function buildTaskPipelineWindow(task, { source = null, now = Date.now() } = {}) {
  const record = isObject(task) ? task : {};
  const bundle = source && source.ok === true ? source.bundle : null;
  const view = resolveTaskPipeline(record, { bundle, now });
  const run = record[TASK_PIPELINE_FIELD];
  const pipeline = view.mode !== ASSISTANT_DECIDES && text(run && run.pipeline) && bundle ? (bundle.pipelines || []).find((p) => p.id === text(run.pipeline)) || null : null;
  const stage = pipeline && text(run && run.stage) ? (pipeline.stages || []).find((s) => s.id === text(run.stage)) || null : null;

  const base = {
    ok: view.mode !== "unresolved",
    mode: view.mode,
    task: { id: record.id ?? null, title: text(record.title) || null, state: text(record.state) || null },
    bundle: bundleStateOf(source),
    pipeline: pipeline ? { id: pipeline.id, title: pipeline.title } : null,
    current: null,
    previous: null,
    count: pipeline ? (pipeline.stages || []).length : null,
    // The document's boundary, so a drawing of a live row marks an external artifact exactly as the catalogue's
    // drawing does. Always a list.
    externalInputs: pipeline && Array.isArray(pipeline.externalInputs) ? pipeline.externalInputs : [],
    enteredAt: view.enteredAt ?? null,
    elapsed: view.elapsed ?? null,
    computedAt: isoOf(now),
    stages: [],
    reason: view.reason ?? null,
    unresolved: null,
    // The stage RUN the row is in and the ledger behind it (§2.2). A record from before the ledger answers one visit
    // of its stage and an empty list, so a page draws nothing it cannot support.
    visit: view.visit ?? null,
    stageRun: view.stageRunId ?? null,
    runs: Array.isArray(view.stageRuns) ? view.stageRuns : [],
    decision: view.decision ?? null,
    // The record's own marks, in ONE object, so a drawing can be handed `position` and read the ledger rather than
    // inferring what ran from an index.
    position: null,
  };

  // What the flow's `marksFor` reads: the stage, the stages that actually RAN (from the ledger, never reconstructed
  // from the sequence), the crossings, the edge arrived by, and the gate the row is parked on.
  function positionOf(run, view) {
    if (!isObject(run)) return null;
    const runs = Array.isArray(view.stageRuns) ? view.stageRuns : [];
    let ran = null;
    if (runs.length) {
      const ids = new Set();
      for (const entry of runs) {
        // An entry exists from the moment the start was ASKED for; only a thread, a status or a decision proves the
        // stage ran. A start that was refused names an attempt, not a run.
        if (text(entry.thread) || text(entry.status) || isObject(entry.decision)) ids.add(text(entry.stage));
      }
      if (text(run.stage)) ids.add(text(run.stage));
      ran = [...ids].filter(Boolean);
    }
    return {
      stage: text(run.stage) || null,
      ...(ran ? { ran } : {}),
      ...(isObject(run.crossings) ? { crossings: { ...run.crossings } } : {}),
      ...(text(run.via) ? { via: text(run.via) } : {}),
      ...(isObject(run.waitingFor) ? { waitingFor: { ...run.waitingFor } } : {}),
    };
  }

  base.position = positionOf(run, view);

  if (view.mode === ASSISTANT_DECIDES) return base;

  if (view.mode === "pipeline") {
    const rows = stageRows(pipeline, (s) => (s.id === stage.id ? "current" : s.position < stage.position ? "before" : "after"));
    const index = rows.findIndex((r) => r.phase === "current");
    return {
      ...base,
      current: { id: stage.id, title: stage.title, position: stage.position, visit: view.visit ?? null, stageRun: view.stageRunId ?? null },
      previous: previousOf(rows, index),
      stages: rows,
    };
  }

  // Unresolved. A bundle that was refused, or a record that names no pipeline, has no sequence to draw; a pipeline the
  // bundle does hold still gets its stages, unplaced when the stage itself is what is missing.
  const kind = unresolvedKind({ run, bundle, pipeline, stage });
  // The sentence a page draws: the bundle's OWN refusal when that is what failed (its code, its locator and the loader's
  // words), and the contract's sentence otherwise. "No bundle is loaded" on a bundle that was read and refused would
  // send the reader looking for the wrong thing.
  const reason =
    kind === WINDOW_FAULTS.BUNDLE
      ? !source
        ? base.bundle.reason
        : `the bundle${base.bundle.file ? ` ${base.bundle.file}` : ""} is refused — ${base.bundle.code}${base.bundle.where ? ` (at ${base.bundle.where})` : ""}: ${base.bundle.reason}`
      : view.reason || "this task's pipeline record cannot be read";
  base.reason = reason;
  let rows = [];
  if (pipeline) {
    // The stamp failing is NOT a reason to hide the sequence: the stage is known, so it keeps its mark.
    rows = stageRows(pipeline, (s) => (kind === WINDOW_FAULTS.ENTERED_AT ? (s.id === stage.id ? "current" : s.position < stage.position ? "before" : "after") : "unplaced"));
  }
  const index = rows.findIndex((r) => r.phase === "current");
  return {
    ...base,
    current: stage && kind === WINDOW_FAULTS.ENTERED_AT ? { id: stage.id, title: stage.title, position: stage.position } : null,
    previous: index > 0 ? previousOf(rows, index) : null,
    stages: rows,
    unresolved: {
      kind,
      pipeline: text(run && run.pipeline) || null,
      stage: text(run && run.stage) || null,
      // The one line a page draws under its heading: the sentence composed above — the bundle's own refusal when that is
      // what failed, the contract's otherwise.
      reason,
    },
  };
}

// ---- the HTTP adapter -----------------------------------------------------------------------------------------------
//   GET /api/assistant/task-pipeline?assistantId=<id>&task=<id>
//
// One read: the queue's task record, the bundle at `config.pipelineBundleFile`, and the model above at the request's
// own clock. Nothing is written and nothing is journalled. A refusal is a VALUE at 200 (the dialog draws the reason);
// only a request that names nothing, or a task or assistant that is not there, answers with an error status — each
// carrying a sentence the window can print.
export function createPipelineWindowRoutes({ assistant, config = {}, sendJson } = {}) {
  if (!assistant) throw new Error("createPipelineWindowRoutes needs the Assistant instance");
  if (typeof sendJson !== "function") throw new Error("createPipelineWindowRoutes needs sendJson from the server's transport");

  return async function pipelineWindowRoutes(req, res, route, url) {
    if (route !== "/api/assistant/task-pipeline") return false;
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: `${req.method} is not allowed on /api/assistant/task-pipeline — it is a read` });
      return true;
    }
    const taskId = text(params.get("task"));
    if (!taskId) {
      sendJson(res, 400, { error: "a task is required: /api/assistant/task-pipeline?task=<id>" });
      return true;
    }
    let view;
    const wanted = text(params.get("assistantId"));
    try {
      view = assistant.queueView(wanted || undefined);
    } catch (err) {
      const code = err && err.code === "assistant-unknown" ? 404 : 500;
      sendJson(res, code, { error: String((err && err.message) || err) });
      return true;
    }
    // `queueView` falls back to Assistant #1 for an id it does not know (the panel's own reading of "no id = the
    // primary"), so an explicit id that did not answer for itself is a 404 here: a window that quietly drew another
    // assistant's queue would be wrong in exactly the way the brief forbids.
    if (wanted && String(view.assistantId) !== wanted) {
      sendJson(res, 404, { error: `no such assistant: ${wanted} — its queue cannot be read` });
      return true;
    }
    const task = (view.tasks || []).find((t) => String(t.id) === taskId);
    if (!task) {
      sendJson(res, 404, { error: `no task #${taskId} in ${view.name || view.assistantId}'s queue — it may have been moved or deleted` });
      return true;
    }
    // Read per request: a bundle the reader re-exported while the panel runs is the one they expect to see, and a
    // file this small costs less than a cache that can go stale.
    const source = readBundle(config.pipelineBundleFile);
    sendJson(res, 200, { ...buildTaskPipelineWindow(task, { source, now: Date.now() }), assistantId: view.assistantId, taskFile: view.file || null });
    return true;
  };
}
