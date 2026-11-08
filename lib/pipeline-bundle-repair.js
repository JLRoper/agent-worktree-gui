// Repairing a live pipeline bundle whose gates are AMBIGUOUS, without weakening the loader that refuses them.
//
// WHY THIS EXISTS. `lib/pipeline-bundle.js` refuses a bundle WHOLE when a gate declares outcomes, carries no `routes`
// map and follows a stage with more than one way out: the driver would fall back to its edge kind order, so a
// `reject` would read as a push forward. That rule is right, and it is not the file's job to relax it. But a live
// bundle written BEFORE the rule existed is now a file the panel cannot read at all, and the two repairs on offer are
// both wrong for a reader's own document: editing the JSON by hand is a guess about which outcome takes which edge,
// and the Settings tab's repair replaces the whole file with the shipped seed (a different bundle: its name, its
// roles, eleven pipelines instead of the reader's four).
//
// This module is the third answer: take the routes the SHIPPED SEED declares for the same pipeline and the same gate,
// check them against the LIVE document's own handoffs, and write them into the reader's file - nothing invented, and
// only where the loader needs an answer. A gate that declares no decision at all is made explicit as `null` (the
// loader's own word for a pause) rather than left to be read as an omission.
//
// Four rules decide the shape:
//   1. NOTHING IS GUESSED. A route comes from the seed's gate with the same pipeline id and the same gate id, and only
//      when it points at a handoff the live pipeline actually holds AND that handoff leaves the gate's own stage. An
//      outcome the seed does not route is a refusal for the whole plan, never a null.
//   2. ONLY WHAT THE LOADER NEEDS. A gate whose stage has one way out (or none) has no choice to get wrong: the row
//      takes that road whatever the record says, so it is left alone even when the seed happens to route it.
//   3. THE RESULT MUST LOAD. The planned document goes through `parseBundle` before anything is written, so "repaired"
//      means the panel's own loader accepts it - not that this module's idea of the file is tidy.
//   4. A REFUSAL IS A VALUE. `{ok, code, reason, where, changes}` for the tool, the test and a future route alike.
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseBundle } from "./pipeline-bundle.js";

// The named reasons. A test names one of these rather than matching a sentence.
export const REPAIR_FAULTS = Object.freeze({
  SHAPE: "not-a-bundle", // not JSON, not an object, or no pipelines list in it
  MODEL: "no-model", // the shipped seed is missing or one the loader refuses
  OUTCOME: "unroutable-outcome", // the gate declares an outcome the seed does not route
  TARGET: "bad-route", // the seed's route names a handoff the live pipeline does not hold, or one leaving another stage
  LOADS: "still-refused", // the repaired document still does not load, for a fault this repair does not answer
});

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const outcomeKey = (value) => text(value).toLowerCase();
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// One pipeline id, the way the loader reads it: the record's own id, else the studio project's.
const idOf = (rec) => text(rec && rec.id) || text(rec && rec.project && rec.project.id);

// The pipelines of a document, in the same three forms lib/pipeline-bundle.js reads (`partsOf`): the panel's wrapper,
// a studio bundle.json, and a bare studio pipeline document. The records are returned BY REFERENCE so a plan mutates
// the document the caller holds; `locator` is the file's own path to the record, so a sentence names a path a reader
// can find.
function recordsOf(doc) {
  if (!isObject(doc)) return null;
  if (Array.isArray(doc.pipelines)) return doc.pipelines.map((rec, index) => ({ rec, locator: `pipelines[${index}]` }));
  if (isObject(doc.pipelines)) return Object.entries(doc.pipelines).map(([id, rec]) => ({ rec, locator: `pipelines.${id}` }));
  if (isObject(doc.pipeline) && Array.isArray(doc.pipeline.stages)) return [{ rec: doc.pipeline, locator: "pipeline" }];
  if (Array.isArray(doc.stages)) return [{ rec: doc, locator: "" }];
  return null;
}

function refusal(code, reason, where = null) {
  return { ok: false, code, reason, where, changes: [], doc: null };
}

// Read a model (the shipped seed) once: the loader's own reading, so a seed this module repairs against is one the
// panel can read. The raw document is carried too, because the routes live on the RECORD the loader normalises.
export function readRepairModel(file) {
  if (!file) return { ok: false, code: REPAIR_FAULTS.MODEL, reason: "no model file was named", where: null, file: null, raw: null };
  const target = path.resolve(file);
  let body;
  try {
    body = readFileSync(target, "utf8");
  } catch (error) {
    const why = error && error.code === "ENOENT" ? "there is no file at that path" : `it could not be read (${String((error && error.message) || error)})`;
    return { ok: false, code: REPAIR_FAULTS.MODEL, reason: `${target}: ${why}`, where: null, file: target, raw: null };
  }
  const parsed = parseBundle(body, { file: target });
  if (parsed.ok !== true) {
    return { ok: false, code: REPAIR_FAULTS.MODEL, reason: `${target} is not a bundle this panel can read — ${parsed.code}${parsed.where ? ` at ${parsed.where}` : ""}: ${parsed.reason}`, where: parsed.where, file: target, raw: null };
  }
  let raw = null;
  try {
    raw = JSON.parse(body.replace(/^\uFEFF/, ""));
  } catch {
    /* the loader already parsed it; a raw read that fails cannot happen here */
  }
  return { ok: true, code: null, reason: null, where: null, file: target, raw };
}

// The plan: what would change, and the document that carries it. `doc` is mutated in place (the caller parsed it for
// this), `changes` says each act in the reader's own words.
export function planBundleRepair(doc, { model = null, file = null } = {}) {
  const records = recordsOf(doc);
  if (!records) return refusal(REPAIR_FAULTS.SHAPE, "the document has no pipelines list — expected the panel's wrapper (`pipelines[]`), a studio bundle (`pipeline` with `stages[]`) or a studio pipeline document (`stages[]`)", null);
  if (!records.length) return refusal(REPAIR_FAULTS.SHAPE, "the document holds no pipeline", null);

  // The seed, indexed by the same id the live record answers to. A pipeline the seed does not ship has no routes to
  // copy, and a gate on it that needs one is a refusal below.
  const modelRecords = model && model.ok ? recordsOf(model.raw) : null;
  const modelById = new Map();
  for (const entry of modelRecords || []) {
    const id = idOf(entry.rec);
    if (id) modelById.set(id, entry.rec);
  }

  const changes = [];
  for (const { rec, locator } of records) {
    if (!isObject(rec)) continue;
    const pipelineId = idOf(rec) || "(unnamed)";
    const handoffs = Array.isArray(rec.handoffs) ? rec.handoffs.filter(isObject) : [];
    const gates = Array.isArray(rec.gates) ? rec.gates : [];
    for (let index = 0; index < gates.length; index += 1) {
      const gate = gates[index];
      if (!isObject(gate)) continue;
      const at = `${locator ? `${locator}.` : ""}gates[${index}]`;
      const decision = gate.decision;

      // A gate that declares no decision is a PAUSE (the loader's own rule). Writing the null says so in the file a
      // reader opens, instead of leaving an absent key to be read as something nobody got round to.
      if (decision === undefined) {
        gate.decision = null;
        changes.push({ pipeline: pipelineId, gate: text(gate.id) || `#${index + 1}`, kind: "pause", routes: null, where: at });
        continue;
      }
      if (!isObject(decision)) continue;

      // `routes` present is the document having answered; a map with a hole in it is the loader's refusal, not this
      // tool's to fill.
      if (has(decision, "routes") && decision.routes != null) continue;

      const leaving = handoffs.filter((handoff) => text(handoff.from) === text(gate.after));
      // One way out (or none) is not a choice: the row takes that road whatever the record says. The loader accepts it
      // and so does this tool - rule 2.
      if (leaving.length <= 1) {
        changes.push({ pipeline: pipelineId, gate: text(gate.id) || `#${index + 1}`, kind: "not-required", routes: null, where: at });
        continue;
      }

      const outcomes = Array.isArray(decision.outcomes) ? decision.outcomes.map(text).filter(Boolean) : [];
      const modelRec = modelById.get(pipelineId) || null;
      const modelGate = modelRec && Array.isArray(modelRec.gates) ? modelRec.gates.find((entry) => isObject(entry) && text(entry.id) === text(gate.id)) : null;
      const modelRoutes = isObject(modelGate) && isObject(modelGate.decision) && isObject(modelGate.decision.routes) ? modelGate.decision.routes : null;
      if (!modelRoutes) {
        return refusal(
          REPAIR_FAULTS.OUTCOME,
          `gate ${text(gate.id) || `#${index + 1}`} of pipeline ${pipelineId} declares outcome${outcomes.length === 1 ? "" : "s"} ${outcomes.join(", ")} and no "routes" map, the stage it follows (${text(gate.after)}) has ${leaving.length} ways out (${leaving.map((handoff) => text(handoff.id)).join(", ")}), and the model${model ? ` (${model.file})` : ""} declares no routes for that gate — there is nothing to copy, and this tool does not guess an edge`,
          `${at}.decision.routes`,
        );
      }

      const routes = {};
      for (const outcome of outcomes) {
        const key = Object.keys(modelRoutes).find((entry) => outcomeKey(entry) === outcomeKey(outcome));
        if (key === undefined) {
          return refusal(
            REPAIR_FAULTS.OUTCOME,
            `gate ${text(gate.id) || `#${index + 1}`} of pipeline ${pipelineId} declares outcome ${JSON.stringify(outcome)}, which the model's routes do not answer (they hold ${Object.keys(modelRoutes).join(", ") || "nothing"}) — a repair that left it unrouted would be the ambiguity this map exists to remove`,
            `${at}.decision.routes`,
          );
        }
        const target = modelRoutes[key];
        if (target === null) {
          // A real answer: the pipeline ends here. Kept, because null is a route.
          routes[outcome] = null;
          continue;
        }
        const id = text(target);
        const handoff = leaving.find((entry) => text(entry.id) === id);
        if (!handoff) {
          return refusal(
            REPAIR_FAULTS.TARGET,
            `gate ${text(gate.id) || `#${index + 1}`} of pipeline ${pipelineId}: the model routes ${JSON.stringify(outcome)} to handoff ${JSON.stringify(id)}, which this pipeline does not hold leaving ${text(gate.after)} (it holds ${leaving.map((entry) => text(entry.id)).join(", ")}) — the two documents disagree and this tool will not write a route the live graph cannot take`,
            `${at}.decision.routes`,
          );
        }
        routes[outcome] = id;
      }
      decision.routes = routes;
      changes.push({ pipeline: pipelineId, gate: text(gate.id) || `#${index + 1}`, kind: "routes", routes, where: `${at}.decision.routes` });
    }
  }

  // Rule 3: the loader is the judge of the result, not this module.
  const parsed = parseBundle(doc, { file });
  if (parsed.ok !== true) {
    return refusal(REPAIR_FAULTS.LOADS, `the repaired document still does not load — ${parsed.code}${parsed.where ? ` at ${parsed.where}` : ""}: ${parsed.reason}`, parsed.where);
  }
  return { ok: true, code: null, reason: null, where: null, changes, doc, pipelines: parsed.bundle.pipelines.map((pipeline) => ({ id: pipeline.id, title: pipeline.title, stages: pipeline.stages.length })) };
}
