// What a task is doing, pipeline-wise: nothing yet (the assistant decides), or a named pipeline from an imported
// bundle at a named stage, since a moment the record stored.
//
// This is the read side of a task record. The panel's job record already carries a `pipeline` key, and it means
// something else: the TREE's rung on the local → investigation → turnover ladder, `{id, stage, since, history[]}`
// (lib/pipelines.js §3). A bundle pipeline is a different object — a studio-authored sequence of stages with artifacts
// and gates — so its assignment is a different field. Two meanings on one key is how a card says "turnover" and a
// chip says "stage 4 of 13" about the same record, so this module fixes the new field as `pipelineRun`:
//
//   { pipelineRun: null }                                                            → the assistant decides
//   { pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-…Z" } }    → where it is, and since when
//
// Four rules decide the shape:
//
//   1. Absence and breakage are different answers. No record at all is `assistant-decides`; a record that names a
//      pipeline the bundle does not hold, or a stage the pipeline does not hold, is `unresolved` and says why. Falling
//      back to "the assistant decides" on a broken assignment would silently drop the pipeline a reader chose, and the
//      card would look normal while the work was not on the pipeline at all.
//   2. Time is STORED, never timed. `enteredAt` is the only clock and `now` is an argument, so the elapsed time is a
//      function of two timestamps and a test can fix one of them. A running timer in a page is a display of this
//      number; it is never the number.
//   3. A stamp is a UTC instant (`Date#toISOString()`, e.g. `2026-11-03T14:05:09.123Z`). A local-time string has no
//      zone, and subtracting one from a clock is a guess that is wrong twice a year — so it is refused, not guessed.
//   4. Nothing here writes lib/jobs.js. The record's read and the two transitions that maintain `enteredAt` live
//      here, so the store's write (a later task) and the window's display (#55) are built against one definition
//      instead of two that disagree about the field's name.
import { pipelineById, stageById } from "./pipeline-bundle.js";

// The field on a task/job record. Not `pipeline`: see the header.
export const TASK_PIPELINE_FIELD = "pipelineRun";

// The mode a task with no assignment reports. A string, not a boolean, because the card says it in words.
export const ASSISTANT_DECIDES = "assistant-decides";

// The panel's own stamps are `Date#toISOString()`: UTC, seconds, optional milliseconds, `Z`. See rule 3.
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// A `now` may arrive from a route (a number), from a test (a Date) or from a record (a string). One reader, so every
// caller's clock is interpreted the same way.
function clockMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  const ms = Date.parse(String(now ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

// How long a task has been in the stage it entered at `enteredAt`. `ms` is null when the record cannot answer, never
// NaN and never a guess. A stamp later than the clock is clamped to zero and flagged: a board that shows "-4s in
// stage" for a clock skew of a few seconds is worse than one that shows 0 and can say the stamp is ahead.
export function elapsedInStage(enteredAt, { now = Date.now() } = {}) {
  const stamp = text(enteredAt);
  if (!stamp) return { ok: false, ms: null, future: false, reason: "the record carries no enteredAt, so the time in this stage is not computable" };
  if (!STAMP_RE.test(stamp)) {
    return {
      ok: false,
      ms: null,
      future: false,
      reason: `enteredAt ${JSON.stringify(stamp)} is not a UTC instant — the panel stores Date#toISOString(), and a local-time stamp has no zone to subtract from`,
    };
  }
  const entered = Date.parse(stamp);
  const clock = clockMs(now);
  if (!Number.isFinite(entered)) return { ok: false, ms: null, future: false, reason: `enteredAt ${JSON.stringify(stamp)} is not a real instant` };
  if (!Number.isFinite(clock)) return { ok: false, ms: null, future: false, reason: "the clock this was asked against is not a real instant" };
  const delta = clock - entered;
  return { ok: true, ms: Math.max(0, Math.round(delta)), future: delta < 0, reason: null };
}

function assistantDecides() {
  return {
    mode: ASSISTANT_DECIDES,
    ok: true,
    pipeline: null,
    title: null,
    stage: null,
    stageTitle: null,
    position: null,
    count: null,
    enteredAt: null,
    elapsed: null,
    reason: "no pipeline is assigned — the assistant decides what this task does",
  };
}

function unresolved({ pipeline = null, stage = null, enteredAt = null, reason }) {
  return {
    mode: "unresolved",
    ok: false,
    pipeline: text(pipeline) || null,
    title: null,
    stage: text(stage) || null,
    stageTitle: null,
    position: null,
    count: null,
    enteredAt: text(enteredAt) || null,
    elapsed: null,
    reason,
  };
}

// What a card reads: which pipeline, which stage, where that stage sits in the sequence, and how long the task has
// been there. `bundle` is the loaded object from lib/pipeline-bundle.js (a refusal is never passed here: a caller with
// a refused bundle has nothing to resolve against and should say so itself).
export function resolveTaskPipeline(task, { bundle = null, now = Date.now() } = {}) {
  const run = isObject(task) ? task[TASK_PIPELINE_FIELD] : null;
  if (run == null) return assistantDecides();
  if (!isObject(run)) {
    return unresolved({ reason: `pipelineRun is ${JSON.stringify(run)}, not a pipeline assignment — a written record that is not an assignment cannot be read as one` });
  }

  const pipelineId = text(run.pipeline);
  if (!pipelineId) {
    return unresolved({
      stage: run.stage,
      enteredAt: run.enteredAt,
      reason: "pipelineRun names no pipeline — leave it null to mean the assistant decides, because an empty record is not that",
    });
  }
  if (!bundle) {
    return unresolved({ pipeline: pipelineId, stage: run.stage, enteredAt: run.enteredAt, reason: `the task names pipeline "${pipelineId}", and no bundle is loaded to read it from` });
  }

  const pipeline = pipelineById(bundle, pipelineId);
  if (!pipeline) {
    const held = (bundle.pipelines || []).map((p) => p.id);
    return unresolved({
      pipeline: pipelineId,
      stage: run.stage,
      enteredAt: run.enteredAt,
      reason: `the task names pipeline "${pipelineId}", which the bundle does not hold (it holds ${held.length ? held.join(", ") : "none"})`,
    });
  }

  const stageId = text(run.stage);
  if (!stageId) {
    return unresolved({ pipeline: pipelineId, enteredAt: run.enteredAt, reason: `pipeline "${pipelineId}" is assigned, but the record names no stage — a position in the sequence cannot be read from a record without one` });
  }
  const stage = stageById(pipeline, stageId);
  if (!stage) {
    return unresolved({
      pipeline: pipelineId,
      stage: stageId,
      enteredAt: run.enteredAt,
      reason: `pipeline "${pipelineId}" holds no stage "${stageId}" (it holds ${pipeline.order.join(", ")})`,
    });
  }

  const enteredAt = text(run.enteredAt);
  const elapsed = elapsedInStage(enteredAt, { now });
  if (!elapsed.ok) {
    return unresolved({ pipeline: pipelineId, stage: stageId, enteredAt, reason: elapsed.reason });
  }

  const visit = visitOf(run, stage.id);
  return {
    mode: "pipeline",
    ok: true,
    pipeline: pipeline.id,
    title: pipeline.title,
    stage: stage.id,
    stageTitle: stage.title,
    position: stage.position,
    count: pipeline.stages.length,
    enteredAt,
    elapsed,
    // The stage run this row is in, and the ledger behind it. Both are READS of the record: a record written before
    // the ledger existed answers one visit of the stage it is in, and an empty list (lib/task-pipeline.js §2.4).
    visit,
    stageRunId: stageRunId(pipeline.id, stage.id, visit),
    stageRuns: stageRunsOf(run),
    decision: (stageRunFor(run, { stage: stage.id, visit }) || {}).decision || null,
    reason: null,
  };
}

// ---- the stage run: identity and the ledger -------------------------------------------------------------------
// One entry into one stage, by one agent. The id is a string — `<pipeline>/<stage>#<visit>` — so a journal line, a
// park's reason, a test's assertion and a person's question name the same thing, and a bundle re-export that inserts
// a stage in the middle does not renumber anything. An INDEX would: it is a position in a list that the bundle owns.
export const STAGE_RUNS_MAX = 30;
export const STAGE_RUNS_DROPPED = "runsDropped";

export function stageRunId(pipeline, stage, visit) {
  const pipelineId = text(pipeline);
  const stageId = text(stage);
  if (!pipelineId || !stageId) return null;
  const n = Number(visit);
  return `${pipelineId}/${stageId}#${Number.isInteger(n) && n > 0 ? n : 1}`;
}

// How many times this record has entered each stage. A record written before this counter existed has no `visits`:
// it is read as ONE visit of the stage it is in, and nothing is written back on a read (§2.4). That answer is why the
// counter can be added to a live queue file at all — every existing row already is where it says it is.
export function visitsOf(run) {
  const out = {};
  const stored = isObject(run) && isObject(run.visits) ? run.visits : null;
  if (stored) {
    for (const [stage, value] of Object.entries(stored)) {
      const n = Number(value);
      if (text(stage) && Number.isInteger(n) && n > 0) out[text(stage)] = n;
    }
  }
  if (!Object.keys(out).length && isObject(run) && text(run.stage)) out[text(run.stage)] = 1;
  return out;
}

export function visitOf(run, stage) {
  const id = text(stage);
  const visits = visitsOf(run);
  return Number.isInteger(visits[id]) && visits[id] > 0 ? visits[id] : 1;
}

// The ledger of stage runs, newest last. Absent on a record from before the ledger, which reads as an EMPTY list —
// "nothing was recorded", never "nothing ran" (the drawing keeps its index fallback for those rows).
export function stageRunsOf(run) {
  const list = isObject(run) && Array.isArray(run.stageRuns) ? run.stageRuns : [];
  return list.filter((entry) => isObject(entry) && text(entry.stage)).map((entry) => ({ ...entry }));
}

// The ledger's cap, applied by the WRITER and nowhere else: `pickTask` carries `pipelineRun` verbatim (§7.8), so a
// trim in the queue's schema would never run. The one number the cap must not lose is `runsDropped`.
function withTrimmedRuns(run, runs) {
  const list = Array.isArray(runs) ? runs.slice() : [];
  const dropped = Math.max(0, Number(run && run[STAGE_RUNS_DROPPED]) || 0);
  if (list.length <= STAGE_RUNS_MAX) return { runs: list, dropped };
  return { runs: list.slice(list.length - STAGE_RUNS_MAX), dropped: dropped + (list.length - STAGE_RUNS_MAX) };
}

function putRuns(run, runs) {
  const { runs: kept, dropped } = withTrimmedRuns(run, runs);
  const next = { ...run, stageRuns: kept };
  if (dropped > 0) next[STAGE_RUNS_DROPPED] = dropped;
  return next;
}

// The newest entry for one stage and visit. `visit` defaults to the one the record is IN, which is what every caller
// that is acting on "the current stage run" wants.
export function stageRunFor(run, { stage = null, visit = null } = {}) {
  const stageId = text(stage) || text(run && run.stage);
  if (!stageId) return null;
  const wantVisit = Number.isInteger(Number(visit)) && Number(visit) > 0 ? Number(visit) : visitOf(run, stageId);
  const list = stageRunsOf(run);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    if (text(entry.stage) === stageId && Number(entry.visit) === wantVisit) return entry;
  }
  return null;
}

// An entry is created when the START IS ASKED FOR, not when it settles: a stage that never started still has to name
// the attempt, and a start that was refused has to leave the refusal somewhere that survives a restart (§2.2). A
// retry of the same visit reuses the entry rather than minting a second one — a retry is an attempt, not a visit.
export function beginStageRun(task, { stage = null, at = new Date().toISOString(), thread = null, job = null } = {}) {
  const run = isObject(task) ? task[TASK_PIPELINE_FIELD] : null;
  if (!isObject(run)) throw new TypeError("beginStageRun needs a task that is already on a pipeline");
  const stageId = text(stage) || text(run.stage);
  if (!stageId) throw new TypeError("beginStageRun needs a stage id");
  const visit = visitOf(run, stageId);
  const list = stageRunsOf(run);
  const open = list.findIndex(
    (entry) => text(entry.stage) === stageId && Number(entry.visit) === visit && !text(entry.thread) && !text(entry.status),
  );
  const entry = {
    id: stageRunId(run.pipeline, stageId, visit),
    stage: stageId,
    visit,
     at,
     thread: text(thread) || null,
    job: text(job) || null,
    status: null,
    decision: null,
  };
  if (open >= 0) list[open] = { ...list[open], ...entry, thread: list[open].thread || entry.thread, job: list[open].job || entry.job };
  else list.push(entry);
  return { ...task, [TASK_PIPELINE_FIELD]: putRuns(run, list) };
}

// Fill in what the panel only learns later: the thread at the link, the run's status at settle, the artifact it
// settled with, the tree facts at the moment it ran, and the decision the driver made about it.
export function settleStageRun(task, { stage = null, visit = null, thread = null, job = null, status = null, at = null, artifact = undefined, tree = undefined, decision = undefined } = {}) {
  const run = isObject(task) ? task[TASK_PIPELINE_FIELD] : null;
  if (!isObject(run)) return task;
  const stageId = text(stage) || text(run.stage);
  const list = stageRunsOf(run);
  const wantVisit = Number.isInteger(Number(visit)) && Number(visit) > 0 ? Number(visit) : visitOf(run, stageId);
  let index = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (text(list[i].stage) === stageId && Number(list[i].visit) === wantVisit) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    // A record from before the ledger, or a stage the panel never started: the entry is created rather than the fact
    // dropped, because the settle IS the moment the panel learned it.
    list.push({ id: stageRunId(run.pipeline, stageId, wantVisit), stage: stageId, visit: wantVisit, at: at || new Date().toISOString(), thread: null, job: null, status: null, decision: null });
    index = list.length - 1;
  }
  const next = { ...list[index] };
  if (thread !== null && thread !== undefined) next.thread = text(thread) || null;
  if (job !== null && job !== undefined) next.job = text(job) || null;
  if (status !== null && status !== undefined) {
    next.status = text(status) || null;
    next.settledAt = at || new Date().toISOString();
  } else if (at && !next.settledAt && next.status) {
    next.settledAt = at;
  }
  if (artifact !== undefined) next.artifact = artifact === null ? null : artifact;
  if (tree !== undefined) next.tree = tree === null ? null : tree;
  if (decision !== undefined) next.decision = decision === null ? null : decision;
  list[index] = next;
  return { ...task, [TASK_PIPELINE_FIELD]: putRuns(run, list) };
}

// A decision that is about the stage run the row is IN (a park, a start that was refused, a cap release).
export function recordStageDecision(task, decision, { stage = null } = {}) {
  return settleStageRun(task, { stage, decision });
}

// ---- the two transitions that maintain `enteredAt` -----------------------------------------------------------------
// Returned tasks are new objects; a caller's record is never mutated under it. A blank id here is a programming error
// (the route validated it, or the bundle was checked before the write), so it throws rather than returning a refusal
// the way a READ of a bad stored record does.
export function assignPipeline(task, { pipeline, stage, enteredAt = new Date().toISOString(), route = null, enter = true } = {}) {
  const pipelineId = text(pipeline);
  const stageId = text(stage);
  if (!pipelineId || !stageId) throw new TypeError("assignPipeline needs a pipeline id and a stage id");
  const run = isObject(task) && isObject(task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  // The same pipeline, moved by hand, is a new VISIT of the new stage — the ledger and the counts travel with the
  // record. A different pipeline is a new record: its visits and crossings describe a graph this one does not hold,
  // and carrying them across is how a cap from one pipeline would bound a loop in another.
  //
  // `enter: false` is the REPAIR path: the same pipeline and stage were pressed again because the stored stamp does
  // not compute. That is not an entry, so the visit count must not grow — a broken clock is not a second visit.
  const samePipeline = Boolean(run) && text(run.pipeline) === pipelineId;
  const visits = samePipeline ? { ...visitsOf(run) } : {};
  if (enter) visits[stageId] = (Number(visits[stageId]) || 0) + 1;
  else if (!Number.isInteger(visits[stageId]) || visits[stageId] < 1) visits[stageId] = 1;
  const next = { pipeline: pipelineId, stage: stageId, enteredAt, visits };
  if (samePipeline) {
    if (isObject(run.crossings)) next.crossings = { ...run.crossings };
    if (Array.isArray(run.stageRuns)) next.stageRuns = stageRunsOf(run);
    if (isObject(run.tree)) next.tree = { ...run.tree };
    if (Number(run[STAGE_RUNS_DROPPED]) > 0) next[STAGE_RUNS_DROPPED] = Number(run[STAGE_RUNS_DROPPED]);
  }
  if (text(route)) next.route = text(route);
  return { ...(isObject(task) ? task : {}), [TASK_PIPELINE_FIELD]: next };
}

// Enter another stage of the same pipeline. The clock is the ENTRY's, not the previous stage's: that is the whole
// point of the field, and copying `enteredAt` forward is how "3 days in stage" appears on work that started a minute
// ago.
//
// `via` names the handoff the row crossed to get here, if an edge was taken. The count of crossings is part of the
// SAME record and the SAME write: a loop's cap (lib/task-pipeline-drive.js rule 4) is only meaningful when the number
// it is compared against survived the restart that separated two passes, and a count kept anywhere else would.
export function enterStage(task, { stage, enteredAt = new Date().toISOString(), via = null, route = null } = {}) {
  const run = isObject(task) ? task[TASK_PIPELINE_FIELD] : null;
  if (!isObject(run)) throw new TypeError("enterStage needs a task that is already on a pipeline");
  const stageId = text(stage);
  if (!stageId) throw new TypeError("enterStage needs a stage id");
  const visits = { ...visitsOf(run) };
  visits[stageId] = (Number(visits[stageId]) || 0) + 1;
  const next = { ...run, stage: stageId, enteredAt, visits };
  const edge = text(via);
  if (edge) {
    const crossings = isObject(run.crossings) ? run.crossings : {};
    next.crossings = { ...crossings, [edge]: (Number(crossings[edge]) || 0) + 1 };
  }
  // The routing fingerprint is stamped on the ENTRY, beside the stamp that dates it (§7.5). A caller with nothing to
  // say about it leaves the stored one alone; a route of null means "entered before the fingerprint existed", which
  // the driver never treats as a mismatch.
  if (text(route)) next.route = text(route);
  return { ...task, [TASK_PIPELINE_FIELD]: next };
}
