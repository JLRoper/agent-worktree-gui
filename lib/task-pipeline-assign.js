// Putting a task ON a pipeline — the write side of the contract lib/task-pipeline.js defines.
//
// The read side answers "where is this task". This module answers the three questions a control asks:
//
//   what may I offer?   `pipelineCatalogue(source)` — every pipeline the bundle holds, its stages IN ORDER with their
//                       1-based position, and the loader's own refusal when the bundle is missing or bad.
//   put it here         `assignTaskPipeline(tasks, id, {pipeline, stage, source, at})` — one record, one stamp.
//   take it back off    `clearTaskPipeline(tasks, id)` — `pipelineRun: null`, which IS the default path.
//
// Four rules decide the shape:
//
//   1. The same bundle the window reads decides what may be assigned. Nothing here re-implements "which stages exist":
//      `pipelineById`/`stageById` are the loader's own lookups, so a stage the control offers is a stage the window can
//      resolve, and a refusal names exactly what the bundle does hold.
//   2. Time is STORED, and only MOVEMENT stamps it. Assigning a pipeline + stage writes `enteredAt` from the clock the
//      caller passes. Assigning the SAME pipeline and stage again changes nothing — including the stamp — because a
//      second press on an unchanged row would otherwise restart the clock on work that never moved, which is the one
//      historical fact this field exists to keep. A different stage (or pipeline) is a new entry and gets the new
//      stamp.
//   3. Refusals are NAMED for the write, thrown from here and caught by the queue route (the queue's own operations
//      already refuse with `queue-*` codes). A read of a bad STORED record still returns a value, in
//      lib/task-pipeline.js — absence, breakage and a refused write are three different answers.
//   4. Nothing is written to lib/jobs.js. The queue owns the record; this module owns the transition; the Assistant's
//      `queueMutate` owns the file, the journal and the repaint. The catalogue route at the bottom is a READ, and its
//      refusal is a value so the window can draw the reason instead of a 500.
import { pipelineById, stageById } from "./pipeline-bundle.js";
import { bundleRefusal, pdlCatalogue, readPipelineSource } from "./pipeline-source.js";
import { assignPipeline, elapsedInStage } from "./task-pipeline.js";

// The named reasons a write can be refused for. A route maps these to 400; the sentence is free to improve.
export const ASSIGN_FAULTS = Object.freeze({
  TASK: "task", // no such task in this queue
  BUNDLE: "pipeline-bundle", // no bundle file, or the one there is was refused whole
  PIPELINE: "pipeline-id", // the bundle does not hold that pipeline
  STAGE: "pipeline-stage", // it holds no such stage, or no stage was named
  CLOCK: "pipeline-clock", // the caller's clock is not a real instant
});

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function refuse(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The ISO instant a stamp is written from. The contract (lib/task-pipeline.js rule 3) says UTC and nothing else, so a
// caller's clock is normalised here once rather than trusted as whatever string it arrived as.
function isoOf(at) {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(String(at ?? ""));
  if (!Number.isFinite(ms)) throw refuse(ASSIGN_FAULTS.CLOCK, `the clock this assignment was asked against is not a real instant: ${JSON.stringify(at)}`);
  return new Date(ms).toISOString();
}

// What a control may offer. The list itself lives in lib/pipeline-source.js (`pdlCatalogue`): one read of
// `config.pipelineBundleFile`, one validator (`parseBundle`), one list — so the queue picker and the Settings pipeline
// tab cannot show two sets of pipelines. It stays a named export here because the assignment control's route and the
// tests name it, and because this module is the write side's front door.
export const pipelineCatalogue = pdlCatalogue;

// Put one task on one stage of one pipeline, or move it to another. Returns the queue's usual `{task, tasks, changed}`
// and null for an id this queue does not hold (the same answer every other queue operation gives).
export function assignTaskPipeline(tasks, id, { pipeline, stage, source, at = new Date() } = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const i = list.findIndex((t) => Number(t.id) === Number(id));
  if (i < 0) return null;
  const t = list[i];

  if (!source || source.ok !== true) {
    // The loader's own sentence already names the path and, on a bad bundle, the locator: repeating it here would make
    // the refusal say the same file twice.
    const refusal = bundleRefusal(source);
    throw refuse(
      ASSIGN_FAULTS.BUNDLE,
      `#${t.id} cannot be put on a pipeline: ${refusal.reason} — export one from the studio and save it beside the queue, or the window has no stage to resolve`,
    );
  }
  const bundle = source.bundle;

  const pipelineId = text(pipeline);
  if (!pipelineId) {
    const held = (bundle.pipelines || []).map((p) => p.id);
    throw refuse(ASSIGN_FAULTS.PIPELINE, `#${t.id} was given no pipeline to be put on (the bundle holds ${held.length ? held.join(", ") : "none"}) — use clear to send it back to the assistant decides`);
  }
  const found = pipelineById(bundle, pipelineId);
  if (!found) {
    const held = (bundle.pipelines || []).map((p) => p.id);
    throw refuse(ASSIGN_FAULTS.PIPELINE, `the bundle holds no pipeline "${pipelineId}" (it holds ${held.length ? held.join(", ") : "none"})`);
  }

  const stageId = text(stage);
  if (!stageId) {
    throw refuse(
      ASSIGN_FAULTS.STAGE,
      `pipeline "${pipelineId}" was assigned without a starting stage — it starts at ${found.order[0]}, and choosing that for the reader is a guess the record would then carry as fact`,
    );
  }
  const atStage = stageById(found, stageId);
  if (!atStage) {
    throw refuse(ASSIGN_FAULTS.STAGE, `pipeline "${pipelineId}" holds no stage "${stageId}" (it holds ${found.order.join(", ")})`);
  }

  const run = isObject(t.pipelineRun) ? t.pipelineRun : null;
  // The same pipeline and stage on an UNCHANGED row is not a re-entry — UNLESS the stored stamp is what the window
  // could not read. Pressing apply on an `unresolved` record whose pipeline and stage are fine is the repair path, and a
  // no-op there would leave the reader with a button that answers "nothing to do" about a record that is still broken.
  // A stamp that does not compute is rewritten; a stamp that computes is history and survives the second press.
  const stampReads = run ? elapsedInStage(run.enteredAt, { now: at }).ok === true : false;
  const same = run && stampReads && text(run.pipeline) === pipelineId && text(run.stage) === stageId;
  if (same) return { task: t, tasks: list, changed: false };

  const enteredAt = isoOf(at);
  // A repair is the same pipeline AND stage on a record whose stamp does not compute — the reader is fixing a clock,
  // not entering the stage a second time, so the visit counter must not move.
  const repair = Boolean(run) && text(run.pipeline) === pipelineId && text(run.stage) === stageId;
  const next = assignPipeline(t, { pipeline: pipelineId, stage: stageId, enteredAt, enter: !repair });
  list[i] = next;
  return { task: next, tasks: list, changed: true };
}

// Back to the default path. `pipelineRun: null` is the record's own spelling of "the assistant decides"; it is never
// deleted to a missing key, because a reader of the file must be able to see the choice was cleared rather than never
// made. Clearing a task that was not on a pipeline is a no-op that still normalises the field to null.
export function clearTaskPipeline(tasks, id) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const i = list.findIndex((t) => Number(t.id) === Number(id));
  if (i < 0) return null;
  const t = list[i];
  if (t.pipelineRun == null) return { task: t.pipelineRun === null ? t : { ...t, pipelineRun: null }, tasks: list, changed: false };
  const next = { ...t, pipelineRun: null };
  list[i] = next;
  return { task: next, tasks: list, changed: true };
}

// ---- the HTTP adapter -----------------------------------------------------------------------------------------------
//   GET /api/assistant/pipeline-catalogue?assistantId=<id>
//
// One read of the file `config.pipelineBundleFile` names, at request time, through lib/pipeline-source.js — the same
// read GET /api/pipelines quotes as `pdl`, so the picker and the Settings tab list one set and refuse one way. A
// reader who re-exports the bundle while the panel is running sees the new catalogue on the next open, and a bundle
// that is missing or refused is a 200 with `ok: false`, its code and its locator — the control prints it instead of
// offering an empty list.
//
// The assistantId is accepted but not required, and is not used to resolve the file today: the bundle is a panel
// setting, one per install, not a per-assistant store. It is named in the query so a page that already carries an
// assistant id can send it without a second shape to keep straight.
export function createPipelineCatalogueRoutes({ config = {}, sendJson } = {}) {
  if (typeof sendJson !== "function") throw new Error("createPipelineCatalogueRoutes needs sendJson from the server's transport");
  return async function pipelineCatalogueRoutes(req, res, route) {
    if (route !== "/api/assistant/pipeline-catalogue") return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: `${req.method} is not allowed on /api/assistant/pipeline-catalogue — it is a read` });
      return true;
    }
    sendJson(res, 200, pipelineCatalogue(readPipelineSource(config)));
    return true;
  };
}
