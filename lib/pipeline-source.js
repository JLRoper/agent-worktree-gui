// The panel's ONE reading of the PDL bundle, and the one catalogue every control quotes.
//
// WHY THIS EXISTS. `config.pipelineBundleFile` was read in three places - the task pipeline window
// (`lib/pipeline-window.js`), the queue's assign catalogue (`lib/task-pipeline-assign.js`) and the import
// (`lib/pipeline-bundle-import.js`) - and the Settings pipeline tab read a different file entirely. Two answers to
// "which pipelines does this panel hold" is one answer too many: a PDL document imported from the factory showed in
// one list and not the other, and a refused bundle was described in two sentences.
//
// Four rules decide the shape:
//
//   1. One path to the file. Every caller asks `readPipelineSource`, which names `config.pipelineBundleFile` and calls
//      `readBundle` (lib/pipeline-bundle.js) exactly once per request. No route resolves the config key itself.
//   2. One validator. `readBundle`/`parseBundle` IS the validation: the loader refuses a bad bundle whole, with its
//      own code and locator, and nothing here re-checks a shape it would have to agree with.
//   3. One catalogue. `pdlCatalogue` is the list a control may offer - ids, titles, stage counts, stages in order,
//      gates and handoffs - and it is the SAME list the queue picker offers and the Settings tab draws. It is a
//      reading of the loader's answer, never a second document.
//   4. PDL unchanged. The documents on disk are not rewritten, renamed or re-versioned here: this module reads the
//      file the factory's export was saved into, as it is.
import { readBundle } from "./pipeline-bundle.js";

// The code a catalogue carries when there was no source at all. A refused source carries the LOADER's own code
// (`missing`, `not-a-bundle`, `incomplete-stage`, ...) instead, so a page prints the reason that is actually true.
export const SOURCE_FAULT = "pipeline-bundle";

const text = (value) => (typeof value === "string" ? value.trim() : "");

// The one read. `config` is the resolved panel config (lib/paths.js fills `pipelineBundleFile`); a caller with a
// file of its own passes `{ pipelineBundleFile: <path> }`.
export function readPipelineSource(config = {}) {
  return readBundle(config && config.pipelineBundleFile);
}

// The bundle's own sentence for "I cannot be read": the loader's locator and code, never a generic "no bundle" - a
// page that sends the reader looking for a missing file when the file is there and broken is worse than one that says
// nothing. Shared by the catalogue and the assign write so the two cannot word one refusal differently.
export function bundleRefusal(source) {
  if (!source) return { code: SOURCE_FAULT, reason: "no bundle was read - there is nothing to assign a stage from" };
  const code = text(source.code) || SOURCE_FAULT;
  const reason = text(source.reason) || "the bundle was refused";
  const where = text(source.where);
  return { code, reason: where ? `${reason} (at ${where})` : reason };
}

// What a control may offer. `pipelines` is [] only when there is nothing readable to offer, and then `reason` says so:
// an empty list beside ok:false is honest; an empty list beside ok:true would read as "this bundle holds no pipelines".
export function pdlCatalogue(source) {
  if (!source || source.ok !== true) {
    const refusal = bundleRefusal(source);
    return {
      ok: false,
      code: refusal.code,
      reason: refusal.reason,
      where: source ? source.where || null : null,
      file: source ? source.file || null : null,
      name: null,
      pipelines: [],
    };
  }
  const bundle = source.bundle || {};
  return {
    ok: true,
    code: null,
    reason: null,
    where: null,
    file: source.file || bundle.file || null,
    name: text(bundle.name) || null,
    pipelines: (bundle.pipelines || []).map((pipeline) => ({
      id: pipeline.id,
      title: pipeline.title,
      // The count is the STAGES list's own length, carried beside it so a reader (or the settings tab's summary) does
      // not have to count nodes to say "2 stages". It cannot disagree with `stages` - it is computed from it here.
      stageCount: (pipeline.stages || []).length,
      // `shared` or `per-stage`: a reader of the catalogue is told WHICH workspace model the pipeline runs, because the
      // consequence is one tree per row or one per lane plus an aggregate (lib/pipeline-fanout.js).
      isolation: pipeline.isolation || "shared",
      stages: (pipeline.stages || []).map((stage) => ({
        id: stage.id,
        title: stage.title,
        position: stage.position,
        // The artifact the stage writes, and what it is handed. The flow draws both - a stage's `writes ...` line and
        // the artifact nodes between the columns - and a catalogue without them would draw every artifact as one
        // nothing writes, which is a claim about the document rather than a gap in this answer.
        artifact: stage.artifact || null,
        reads: Array.isArray(stage.reads) ? stage.reads : [],
      })),
      // The rest of the pipeline's own shape travels with it: a gate is what ends a stage and a handoff is how the
      // next one is joined (a `loop` even carries its cap), so a reader drawing the sequence - the pipeline modal's
      // flow - reads it from the same answer the assignment control uses, instead of a second route or a guess.
      gates: (pipeline.gates || []).map((gate) => ({ id: gate.id, name: gate.name, after: gate.after, artifact: gate.artifact, decider: gate.decider, decision: gate.decision })),
      handoffs: (pipeline.handoffs || []).map((handoff) => ({ id: handoff.id, from: handoff.from, to: handoff.to, artifact: handoff.artifact, kind: handoff.kind, cap: handoff.cap })),
      // The document boundary: the artifacts it reads from outside itself, drawn dashed so a reader can tell
      // "this document does not write it" from "a stage here does".
      externalInputs: Array.isArray(pipeline.externalInputs) ? pipeline.externalInputs : [],
    })),
  };
}

// Read AND catalogue, for the two routes that only want the answer: GET /api/assistant/pipeline-catalogue and the
// `pdl` block of GET /api/pipelines. One read per request, so a reader who re-imports sees both move on the next open.
export function pipelineSourceCatalogue(config = {}) {
  return pdlCatalogue(readPipelineSource(config));
}
