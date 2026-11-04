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
    reason: null,
  };
}

// ---- the two transitions that maintain `enteredAt` -----------------------------------------------------------------
// Returned tasks are new objects; a caller's record is never mutated under it. A blank id here is a programming error
// (the route validated it, or the bundle was checked before the write), so it throws rather than returning a refusal
// the way a READ of a bad stored record does.
export function assignPipeline(task, { pipeline, stage, enteredAt = new Date().toISOString() } = {}) {
  const pipelineId = text(pipeline);
  const stageId = text(stage);
  if (!pipelineId || !stageId) throw new TypeError("assignPipeline needs a pipeline id and a stage id");
  return { ...(isObject(task) ? task : {}), [TASK_PIPELINE_FIELD]: { pipeline: pipelineId, stage: stageId, enteredAt } };
}

// Enter another stage of the same pipeline. The clock is the ENTRY's, not the previous stage's: that is the whole
// point of the field, and copying `enteredAt` forward is how "3 days in stage" appears on work that started a minute
// ago.
//
// `via` names the handoff the row crossed to get here, if an edge was taken. The count of crossings is part of the
// SAME record and the SAME write: a loop's cap (lib/task-pipeline-drive.js rule 4) is only meaningful when the number
// it is compared against survived the restart that separated two passes, and a count kept anywhere else would.
export function enterStage(task, { stage, enteredAt = new Date().toISOString(), via = null } = {}) {
  const run = isObject(task) ? task[TASK_PIPELINE_FIELD] : null;
  if (!isObject(run)) throw new TypeError("enterStage needs a task that is already on a pipeline");
  const stageId = text(stage);
  if (!stageId) throw new TypeError("enterStage needs a stage id");
  const next = { ...run, stage: stageId, enteredAt };
  const edge = text(via);
  if (edge) {
    const crossings = isObject(run.crossings) ? run.crossings : {};
    next.crossings = { ...crossings, [edge]: (Number(crossings[edge]) || 0) + 1 };
  }
  return { ...task, [TASK_PIPELINE_FIELD]: next };
}
