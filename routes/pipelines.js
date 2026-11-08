// The pipelines prefix: the catalogue read and the one save that replaces it, lifted out of server.js's if-chain.
//
// Step 8 of docs/reports/module-map-2026-11-08.html moves one route prefix at a time into routes/, mounted from the
// PREFIX_MOUNTS table. routes/assistant-queue.js and routes/assistant-delete.js were the two rows cut out of lib/
// modules; routes/state.js was the first lifted out of server.js's own chain, routes/jobs.js the second, and this is
// the third: the two blocks below stood in that chain, and they stand here in the same order, with the same literals,
// the same status codes and the same body sentences.
//
//   GET  /api/pipelines   the merged catalogue - the reader's pipelines.json over the shipped seed - with its
//                         provenance (both file paths), the version it was written with, the closed vocabularies the
//                         tab draws its controls from, every refusal the loader made, and the PDL bundle a task is
//                         put on. READ-ONLY, not token-gated.
//   PUT  /api/pipelines   {version?, note?, pipelines} - one document in, validatePipeline's findings out UNALTERED,
//                         and nothing written when any definition is refused.
//
// The seam is the store and the composition root's own logger: `pipelines` owns the live file and its read-modify-write
// and `log` records the save, so both travel in. The version, the vocabularies and the loader's two functions come
// straight from lib/pipelines.js, and the PDL catalogue from lib/pipeline-source.js, exactly as this file's source
// imported them; the transport helpers travel in beside them, imported from lib/http/respond.js by the composition
// root rather than redefined here: this module imports no HTTP layer and defines none of sendJson or readBody, so a
// test can drive a route with a recorder and the wire bytes are the ones lib/http/respond.js writes.
//
// Every path is an exact compare - the mount table's prefix test is only what decides whether this file is asked at
// all - and a path or method this file does not answer falls through (`return false`) to the rest of server.js's
// chain, which is where the unmatched method answered before the cut, so `POST /api/pipelines` is still the chain's
// own 404 rather than a 405 invented here.

import { PIPELINES_VERSION, PIPELINE_KINDS, EXIT_CHECKS, readPipelinesFile, validatePipelinesDocument } from "../lib/pipelines.js";
import { pipelineSourceCatalogue } from "../lib/pipeline-source.js";

/** The prefix both blocks below sit under, and the row the mount table in server.js matches on. */
export const PIPELINES_PATH = "/api/pipelines";

export function createPipelinesRoutes({ pipelines, config = {}, sendJson, readBody, authorised, log } = {}) {
  if (!pipelines) throw new Error("createPipelinesRoutes needs the Pipelines store");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createPipelinesRoutes needs sendJson, readBody and authorised from the server's transport");
  }
  if (typeof log !== "function") throw new Error("createPipelinesRoutes needs log from the composition root");

  return async function pipelinesRoutes(req, res, route) {
    // ---- the pipeline catalogue ------------------------------------------------------------------
    // The Pipeline tab's whole answer: the merged catalogue - the reader's pipelines.json over the shipped seed -
    // with its provenance (both file paths), the version it was written with, and every refusal the loader made.
    // A file whose version is newer than this panel's is refused whole (the seed is in force read-only); a
    // definition that fails validation is dropped by id and named. The FULL definitions travel here, not the
    // summary /api/state carries: the tab edits stages and prompts, and a summary would make it guess.
    if (route === "/api/pipelines" && req.method === "GET") {
      const doc = pipelines.doc({ fresh: true });
      sendJson(res, 200, {
        file: doc.file,
        seedFile: doc.seedFile,
        version: doc.version,
        supported: PIPELINES_VERSION,
        kinds: PIPELINE_KINDS,
        exitChecks: EXIT_CHECKS,
        readOnly: doc.readOnly,
        refused: doc.refused,
        warnings: doc.warnings,
        dropped: doc.dropped,
        pipelines: doc.pipelines,
        // The OTHER pipeline list this panel holds: the PDL bundle a task is put on, read through the one module the
        // queue picker reads (lib/pipeline-source.js). The ladder above says what a TREE may do with a branch and the
        // PDL pipelines below say what a TASK is carried through; the tab draws both and names which is which. A
        // bundle that is missing or refused is carried here as its own value, never blamed on the ladder.
        pdl: pipelineSourceCatalogue(config),
      });
      return true;
    }

    // Replace the live catalogue. The document is the pipelines.json shape: `{version, note, pipelines}`. A version
    // newer than this panel's is refused whole (409), exactly as the loader would refuse it on the next read. Every
    // definition is validated with validatePipeline and its findings come back UNALTERED under `findings`, so the
    // tab can show each sentence beside the field it belongs to. Nothing is written when any definition is
    // refused: a half-saved catalogue is the one state the loader's drop-by-id rule exists to prevent.
    //
    // A document may carry ONE definition (the tab's save sends only the pipeline it edited): the body's pipelines
    // are merged over the live file's own, so an edit to one id never silently deletes the reader's other edits.
    // The seed's definitions are not copied in - the live file holds only the reader's, and the seed still supplies
    // everything it supplies.
    if (route === "/api/pipelines" && req.method === "PUT") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, { error: "a pipeline document is required (a JSON object)" });
        return true;
      }
      const version = Number(body.version);
      if (Number.isFinite(version) && version > PIPELINES_VERSION) {
        sendJson(res, 409, {
          error: `the document is version ${version}, newer than this panel's ${PIPELINES_VERSION} — it is refused whole, not half-parsed`,
          refused: { version, supported: PIPELINES_VERSION, why: `the document names version ${version}, newer than this panel's ${PIPELINES_VERSION}` },
        });
        return true;
      }
      const live = readPipelinesFile(config.pipelinesFile);
      if (live.refused) {
        sendJson(res, 409, {
          error: `the live pipelines.json is refused whole: ${live.refused.why}`,
          refused: live.refused,
        });
        return true;
      }
      const incoming = Array.isArray(body.pipelines)
        ? Object.fromEntries(body.pipelines.filter((rec) => rec && typeof rec === "object").map((rec) => [String(rec.id ?? "").trim(), rec]))
        : body.pipelines && typeof body.pipelines === "object"
          ? body.pipelines
          : {};
      const merged = { ...(live.pipelines || {}), ...incoming };
      // The document the reader is asking to put in force is the WHOLE catalogue - the seed's definitions, the live
      // file's and this edit - so a `next` pointing at a seed definition is not reported as unknown. Only the live
      // file's definitions and the edit are WRITTEN; the seed still supplies its own.
      const inForce = { ...(pipelines.doc({ fresh: true }).pipelines || {}), ...incoming };
      const document = { version: PIPELINES_VERSION, pipelines: inForce };
      if (body.note) document.note = body.note;
      const { errors } = validatePipelinesDocument(document);
      if (errors.length) {
        sendJson(res, 422, {
          error: `the pipeline document was refused: ${errors.length} finding${errors.length === 1 ? "" : "s"}`,
          findings: errors,
        });
        return true;
      }
      const saved = pipelines.save({ version: PIPELINES_VERSION, pipelines: merged, ...(body.note ? { note: body.note } : {}) });
      if (!saved.ok) {
        sendJson(res, 500, { error: saved.error });
        return true;
      }
      log(`pipelines: saved ${saved.file} — ${Object.keys(merged).length} definition(s) in force`);
      const doc = pipelines.doc({ fresh: true });
      sendJson(res, 200, {
        ok: true,
        file: saved.file,
        state: {
          file: doc.file,
          seedFile: doc.seedFile,
          version: doc.version,
          supported: PIPELINES_VERSION,
          kinds: PIPELINE_KINDS,
          exitChecks: EXIT_CHECKS,
          readOnly: doc.readOnly,
          refused: doc.refused,
          warnings: doc.warnings,
          dropped: doc.dropped,
          pipelines: doc.pipelines,
        },
      });
      return true;
    }

    return false;
  };
}
