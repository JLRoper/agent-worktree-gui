// Importing a studio export into the bundle the panel already reads — the write side of lib/pipeline-bundle.js.
//
// WHAT WAS WRONG. The live `state/pipeline-bundle.json` used to be ONE studio document. A studio document is one
// pipeline, so importing a second export could only REPLACE the first: the panel's dropdown showed one entry, and the
// second import silently deleted the pipeline the reader had been using. The bundle format already holds a list
// (`{bundleVersion, name, pipelines: [...]}`), so the honest import is an APPEND: read what is there, add the incoming
// pipelines by id, refuse any id that is already taken (a duplicate id would make a task record ambiguous).
//
// Six rules decide the shape of this module:
//
//   1. An import is WHOLE or not at all. If any incoming pipeline's id is already in the bundle, nothing is written and
//      every duplicate is named (its id and its title). Adding the rest and reporting a partial success would leave the
//      reader with half a bundle and no way to tell which half.
//   2. The LIVE file is lifted, not rewritten by guesswork. A live studio document (one pipeline) becomes
//      `pipelines[0]` of the panel wrapper with its own record carried VERBATIM — its roles, gates, handoffs, method
//      and every studio field this panel does not yet read survive the lift. Only the wrapper around it is new.
//   3. Validation is the loader's. Every document is parsed by `parseBundle` before anything is merged, and the merged
//      document is parsed AGAIN before it is written: a write that the panel would read as refused is not a successful
//      import, whatever the merge thought.
//   4. Refusals are VALUES (`{ok, code, reason, where, duplicates}`), the same shape the loader uses, so a route and a
//      settings tab print the same sentence and a test names the code rather than matching prose.
//   5. The write is atomic: a temporary file beside the target, then a rename. A crash mid-write leaves the bundle the
//      panel reads untouched, instead of a truncated JSON document that reads as one refused pipeline.
//   6. A live file this panel cannot read is a REPAIR, not a dead end. That file only ever holds a bundle, and the
//      replacement is already a shipped, validated artefact (`pipeline-bundle.seed.json`, written by
//      `node tools/seed-pipeline-bundle.mjs --force`). Refusing the import there made the Settings import useless for
//      the one case it exists for: a bundle the panel reads as unresolved. So when the live document does not load and
//      the incoming document does, the plan REPLACES the file with the incoming document and says it is a repair and
//      what was wrong with the file it replaces. Nothing readable is replaced — a live bundle that loads is still
//      appended to, by id — and nothing unreadable replaces anything: a document the loader refuses is still refused,
//      because swapping one refused bundle for another repairs nothing.
//   7. The shipped seed is a DOOR, not a document to carry. `{seed: true}` names it instead of sending it: the route
//      reads `pipeline-bundle.seed.json` from this checkout and runs it through the same plan above, so the repair
//      control on Settings > Pipeline is one press rather than a file-picker the reader has to point at a path.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BUNDLE_VERSION, parseBundle } from "./pipeline-bundle.js";

// The named reasons an import can be refused for. A route maps these to its status; the sentence is free to improve.
export const IMPORT_FAULTS = Object.freeze({
  DOCUMENT: "not-a-document", // the body names no document, or names one that is not JSON
  LIVE: "live-bundle-unreadable", // the file already there could not be READ — a file that reads and does not parse is repaired
  EMPTY: "no-pipeline", // the incoming document holds no pipeline
  DUPLICATE: "duplicate-id", // an incoming pipeline id is already in the bundle
  MERGED: "merged-bundle-refused", // the merged document would not load — nothing is written
  WRITE: "write-failed", // the file could not be replaced
});

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function refusal(code, reason, { where = null, file = null, duplicates = [] } = {}) {
  return { ok: false, code, reason, where: where || null, file: file || null, repair: null, duplicates, added: [], pipelines: [], doc: null, text: null };
}

// The raw records a document carries, and the roles that belong to the document rather than to one pipeline. This
// mirrors lib/pipeline-bundle.js's `partsOf` deliberately: the loader normalises, this module CARRIES, and the two must
// agree about which key holds the stages or a live studio document would be lifted with its stages left behind.
function rawOf(doc) {
  if (Array.isArray(doc.pipelines)) return { list: doc.pipelines.filter(isObject), roles: Array.isArray(doc.roles) ? doc.roles.filter(isObject) : [] };
  if (isObject(doc.pipeline) && Array.isArray(doc.pipeline.stages)) {
    return { list: [doc.pipeline], roles: Array.isArray(doc.pipeline.roles) ? doc.pipeline.roles.filter(isObject) : [] };
  }
  if (Array.isArray(doc.stages)) return { list: [doc], roles: Array.isArray(doc.roles) ? doc.roles.filter(isObject) : [] };
  return null;
}

const idOf = (rec) => text(rec.id) || text(rec.project && rec.project.id);
const titleOf = (rec) => text(rec.title) || text(rec.name) || text(rec.project && rec.project.name) || idOf(rec);

// Roles are a document-level list; the merged wrapper keeps the live document's roles and adds the incoming ones by id.
// A role that already exists is kept as the live file has it — an import must not quietly re-word a role the reader is
// already using. A pipeline's OWN `roles` array stays on the record, untouched, because that is what the studio wrote.
function mergeRoles(liveRoles, incomingRoles) {
  const out = [];
  const seen = new Set();
  for (const role of [...liveRoles, ...incomingRoles]) {
    const id = text(role && role.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(role);
  }
  return out;
}

// The panel wrapper around a list of raw pipeline records. A bundle is named once, so the live document's own name is
// kept when it has one: re-importing must not rename the file's identity.
function wrapperOf({ name, liveRoles, records, incomingRoles }) {
  return {
    bundleVersion: BUNDLE_VERSION,
    name: text(name) || "pipelines",
    roles: mergeRoles(liveRoles, incomingRoles),
    pipelines: records,
  };
}

// Parse one document for VALIDATION without losing its raw records: the error is the loader's, carried as a value.
function loadDoc(doc, { file, what }) {
  const parsed = parseBundle(doc, { file });
  if (parsed.ok !== true) {
    return {
      ok: false,
      code: parsed.code,
      // The locator travels INSIDE the sentence as well: a settings tab prints the reason and nothing else, and "a stage
      // produces no artifact" without "at pipelines[1].stages[0]" sends the reader looking through the whole file.
      reason: `${what} cannot be read${parsed.where ? ` at ${parsed.where}` : ""} — ${parsed.reason}`,
      where: parsed.where || null,
      // The loader's own sentence, kept beside the one that names the DOCUMENT: a repair prints both — "the file it
      // replaces cannot be read" is the act, this is the fault — so the route does not have to re-parse to find it.
      detail: parsed.reason,
    };
  }
  // `parseBundle` accepts JSON text as well as an object; the raw records have to be read from the parsed object.
  let held = doc;
  if (typeof held === "string") {
    try {
      held = JSON.parse(held.replace(/^\uFEFF/, ""));
    } catch {
      held = null;
    }
  }
  const raw = isObject(held) ? rawOf(held) : null;
  if (!raw) {
    const nothing = "it has no pipelines, no pipeline and no stages — there is nothing to import";
    return { ok: false, code: IMPORT_FAULTS.DOCUMENT, reason: `${what}: ${nothing}`, where: null, detail: nothing };
  }
  return { ok: true, parsed, raw };
}

// The plan, pure: what the merged document would be, and what stops it. No file is read or written here, so a test can
// pin every refusal without a sandbox.
export function planImport(existingDoc, incomingDoc, { file = null } = {}) {
  // A live document that is ABSENT is not an error: the first import creates the wrapper. One that is present but does
  // not load is carried as a FAULT rather than refused here — that is the repair below — because MERGING into it would
  // launder a broken file into a valid-looking one, while replacing it is not a merge.
  const live = existingDoc != null && existingDoc !== "" ? loadDoc(existingDoc, { file, what: "the bundle already on disk" }) : null;

  const incoming = loadDoc(incomingDoc, { file, what: "the document being imported" });
  if (!incoming.ok) return refusal(incoming.code, incoming.reason, { where: incoming.where, file });
  if (!incoming.raw.list.length) return refusal(IMPORT_FAULTS.EMPTY, "the document being imported holds no pipeline", { file });

  // A repair REPLACES the file, so it is offered only on an incoming document that loads: a refused document would
  // trade one unreadable bundle for another, and `incoming` has already passed the same loader just above.
  const repair = live && !live.ok
    ? {
        code: live.code,
        where: live.where,
        reason: `the file it replaces cannot be read${live.where ? ` at ${live.where}` : ""} (${live.code}): ${live.detail}`,
      }
    : null;
  // What the file HOLDS: a live document that loads, or nothing when there is no file and nothing when it is a repair
  // (a document the loader refused is not a source of records to carry, or of a name).
  const held = live && live.ok ? live : null;

  const liveRecords = held ? held.raw.list : [];
  const liveIds = new Map(liveRecords.map((rec) => [idOf(rec), rec]));
  const incomingIds = new Set();
  const duplicates = [];
  for (const rec of incoming.raw.list) {
    const id = idOf(rec);
    if (liveIds.has(id) || incomingIds.has(id)) {
      const prior = liveIds.get(id);
      duplicates.push({ id, title: titleOf(rec), existingTitle: prior ? titleOf(prior) : null });
    }
    incomingIds.add(id);
  }
  if (duplicates.length) {
    const named = duplicates
      .map((d) => `"${d.id}" (${d.title}${d.existingTitle && d.existingTitle !== d.title ? ` — already held as ${d.existingTitle}` : ""})`)
      .join(", ");
    return refusal(
      IMPORT_FAULTS.DUPLICATE,
      `an import appends, so a pipeline id that is already in the bundle is refused rather than replaced: ${named}. Nothing was written — give the incoming pipeline another id, or remove the one it collides with first.`,
      { file, duplicates },
    );
  }

  // The wrapper's name: the live file's own when it has one AND could be read, else the live studio document's project
  // name, else the incoming bundle's name (the loader defaults that to its first pipeline's id) — never an empty string.
  const liveFirst = liveRecords[0] || null;
  const liveName = held ? (isObject(existingDoc) && text(existingDoc.name)) || text(liveFirst && liveFirst.project && liveFirst.project.name) : "";
  const wrapper = wrapperOf({
    name: liveName || text(incoming.parsed.bundle.name),
    liveRoles: held ? held.raw.roles : [],
    records: [...liveRecords, ...incoming.raw.list],
    incomingRoles: incoming.raw.roles,
  });

  // The merged document is parsed by the same loader the panel reads with. This is the guard that makes "the import
  // succeeded" mean "the panel can read the result", not "the merge did not throw".
  const merged = parseBundle(wrapper, { file });
  if (merged.ok !== true) {
    return refusal(
      IMPORT_FAULTS.MERGED,
      `the merged bundle would not load, so nothing was written — ${merged.code}${merged.where ? ` at ${merged.where}` : ""}: ${merged.reason}`,
      { where: merged.where, file },
    );
  }

  const added = incoming.raw.list.map((rec) => {
    const id = idOf(rec);
    const pipeline = merged.bundle.pipelines.find((p) => p.id === id);
    return { id, title: pipeline ? pipeline.title : titleOf(rec), stages: pipeline ? pipeline.stages.length : 0 };
  });

  return {
    ok: true,
    code: null,
    // A repair says so. The settings tab prints the route's sentence and nothing else, so the act (replaced, not
    // merged) and the fault of the file it replaces both have to be here, or a replacement reads as an append and the
    // reader assumes the pipelines that file used to hold are still in it.
    reason: repair ? `a repair: ${repair.reason}; the import replaces that file instead of merging into it` : null,
    where: null,
    file,
    repair,
    duplicates: [],
    added,
    pipelines: merged.bundle.pipelines.map((p) => ({ id: p.id, title: p.title, stages: p.stages.length })),
    doc: wrapper,
    text: `${JSON.stringify(wrapper, null, 2)}\n`,
  };
}

// Write the file atomically. A temporary beside the target, then a rename: on Windows a rename over an existing file is
// allowed for files (unlike directories), and a failure before the rename leaves the reader's bundle as it was.
export function writeBundleFile(file, body) {
  const target = path.resolve(file);
  const tmp = `${target}.importing-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, target);
    return { ok: true, file: target };
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temporary is already gone, or never existed */
    }
    return { ok: false, code: IMPORT_FAULTS.WRITE, reason: `${target}: the bundle could not be replaced (${String((error && error.message) || error)})` };
  }
}

// The whole import: read the live file, plan against it, write the merged wrapper when the plan holds.
export function importBundleFile({ file, document = null, textBody = null, at = new Date() } = {}) {
  if (!file) return refusal(IMPORT_FAULTS.DOCUMENT, "no bundle file was named — an import needs the file the panel reads", {});
  let incoming = document;
  if (incoming == null && typeof textBody === "string") {
    try {
      incoming = JSON.parse(textBody.replace(/^\uFEFF/, ""));
    } catch (error) {
      return refusal(IMPORT_FAULTS.DOCUMENT, `the document being imported is not JSON (${String((error && error.message) || error)})`, { file });
    }
  }
  if (incoming == null) return refusal(IMPORT_FAULTS.DOCUMENT, "no document was named — send the studio export as `document`, or its JSON text as `text`", { file });

  let existing = null;
  try {
    existing = readFileSync(path.resolve(file), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") existing = null; // the first import creates the bundle
    else return refusal(IMPORT_FAULTS.LIVE, `${path.resolve(file)} could not be read (${String((error && error.message) || error)})`, { file });
  }

  const plan = planImport(existing, incoming, { file });
  if (!plan.ok) return plan;
  const written = writeBundleFile(file, plan.text);
  if (!written.ok) return refusal(written.code, written.reason, { file });
  return { ...plan, at: at instanceof Date ? at.toISOString() : String(at ?? ""), file: written.file };
}

// ---- the HTTP adapter -----------------------------------------------------------------------------------------------
//   POST /api/assistant/pipeline-bundle/import
//   body: {document: <studio export | panel bundle>}  or  {text: "<its JSON>"}  or  {file: "<a path to it>"}
//         or  {seed: true}, which imports the bundle this checkout ships (pipeline-bundle.seed.json) — the repair
//         control on Settings > Pipeline posts exactly that when the live file is refused.
//
// A WRITE, so a refusal is a 4xx and a success is a 200 carrying what was added. The statuses are distinct because the
// settings tab prints them: 400 for a body that names no document, 409 for a duplicate id (the bundle is fine, the
// request collides with it), 422 for a document or a merge the loader refuses, 500 for a file that could not be written.
const STATUS_OF = {
  [IMPORT_FAULTS.DOCUMENT]: 400,
  [IMPORT_FAULTS.EMPTY]: 422,
  [IMPORT_FAULTS.DUPLICATE]: 409,
  [IMPORT_FAULTS.LIVE]: 422,
  [IMPORT_FAULTS.MERGED]: 422,
  [IMPORT_FAULTS.WRITE]: 500,
};

export function createPipelineBundleImportRoutes({ config = {}, sendJson, readBody, seedFile = null } = {}) {
  if (typeof sendJson !== "function") throw new Error("createPipelineBundleImportRoutes needs sendJson from the server's transport");
  if (typeof readBody !== "function") throw new Error("createPipelineBundleImportRoutes needs readBody from the server's transport");

  return async function pipelineBundleImportRoutes(req, res, route) {
    if (route !== "/api/assistant/pipeline-bundle/import") return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on /api/assistant/pipeline-bundle/import — it is a POST` });
      return true;
    }
    let body;
    try {
      body = await readBody(req, 8 * 1024 * 1024);
    } catch (error) {
      sendJson(res, error && error.status ? error.status : 400, { error: String((error && error.message) || error) });
      return true;
    }
    if (!isObject(body)) {
      sendJson(res, 400, { error: "the body is not a JSON object — send {document}, {text} or {file}" });
      return true;
    }

    let document = isObject(body.document) ? body.document : null;
    let textBody = typeof body.text === "string" ? body.text : null;
    const named = text(body.file);
    // `{seed: true}` is the repair door: the bundle this checkout ships (pipeline-bundle.seed.json) is the incoming
    // document, read here rather than posted by the page — 127 KB of JSON the browser would otherwise have to fetch
    // and carry, and a path it would otherwise have to know. It is only consulted when the body names no document of
    // its own, and it goes through `planImport` like every other import, so a seed that does not load is still refused
    // and a live bundle that DOES load is still appended to rather than replaced.
    if (!document && !textBody && body.seed === true) {
      const seed = seedFile || config.pipelineBundleSeedFile || "pipeline-bundle.seed.json";
      try {
        textBody = readFileSync(path.resolve(seed), "utf8");
      } catch (error) {
        sendJson(res, 400, { error: `${seed}: the seed this checkout ships could not be read (${String((error && error.message) || error)})`, code: IMPORT_FAULTS.DOCUMENT, file: null });
        return true;
      }
    }
    if (!document && !textBody && named) {
      try {
        textBody = readFileSync(path.resolve(named), "utf8");
      } catch (error) {
        sendJson(res, 400, { error: `${named}: the document could not be read (${String((error && error.message) || error)})` });
        return true;
      }
    }

    const result = importBundleFile({ file: config.pipelineBundleFile, document, textBody });
    if (!result.ok) {
      sendJson(res, STATUS_OF[result.code] || 422, {
        error: result.reason,
        code: result.code,
        where: result.where,
        duplicates: result.duplicates,
        file: result.file,
      });
      return true;
    }
    const added = result.added.map((p) => `"${p.id}" (${p.stages} stage${p.stages === 1 ? "" : "s"})`).join(", ");
    const holds = `the bundle now holds ${result.pipelines.length} pipeline${result.pipelines.length === 1 ? "" : "s"}`;
    sendJson(res, 200, {
      ok: true,
      file: result.file,
      // The machine-readable half of the same fact: a caller that wants to say "repaired" in its own words reads this,
      // and a test asserts it instead of matching the sentence.
      repair: result.repair || null,
      added: result.added,
      pipelines: result.pipelines,
      // A repair leads with the fault of the file it replaced: that sentence is the only record the reader gets that
      // what the file used to hold is gone.
      reason: `${result.repair ? `repaired the bundle: ${result.repair.reason}; ` : ""}imported ${added} — ${holds}`,
    });
    return true;
  };
}
