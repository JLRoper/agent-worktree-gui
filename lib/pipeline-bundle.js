// The pipeline import contract: what a bundle from the pipeline studio carries, what this panel reads out of it,
// and the ways a bundle is refused before any of it reaches a card.
//
// A bundle is the studio's semantic layer (`tools/pipeline-studio/core.js` `exportBundle`): `{pipeline, roles,
// artifacts, yaml}`, whose `pipeline` is `{version, project, stages, handoffs, gates, roles}` with the canvas
// position stripped. The panel's own form — `{bundleVersion, name, pipelines: [...]}` — is the same records under a
// wrapper, so one install can hold more than one studio project without inventing a second format.
//
// Five rules decide the shape of this module:
//
//   1. An import is WHOLE or not at all. lib/pipelines.js drops a bad definition by id and keeps the rest, because a
//      reader edits that file by hand and one typo must not empty the board. A bundle is different: it is one
//      authored artefact, and half of it is a pipeline whose stage order disagrees with its own gates. So the loader
//      is fail-fast, names the rule the bundle broke, and says WHERE it broke, and the caller holds no catalogue.
//   2. The panel reads six things per pipeline — its stages IN ORDER, each stage's prompt, the artifact each stage
//      produces, the artifacts each stage READS (`inputs.read[]`, and the document's `external_inputs`), the gates
//      (with the artifact a gate's decision is written to, and its `routes` when the document maps an outcome to an
//      edge), and the handoffs that join stages. `reads` is carried
//      but never RESOLVED: a read names an artifact and a ledger locator, and a locator is not a path, so the panel
//      says what the document says the stage reads and leaves the file to the tree. Everything else the studio
//      carries (owner, binds, method, done, stops, forbidden) is deliberately not normalised: the panel has no
//      evaluator for it yet, and a field it cannot act on is a promise it cannot keep. The bundle stays the
//      studio's record; this module is the panel's reading of it.
//   3. A stage's prompt may come from the stage or from the role that owns it. The studio has no `stage.prompt`: a
//      roster role's `instructions` are the instruction, and `owner.role` is the link. A stage with neither is
//      refused, because a chip with no instruction behind it is a stage the panel cannot start, and a blank prompt
//      rendered at a run is the brief that produces a branch called `_`.
//   4. `kind` (local / investigation / turnover) is NOT part of a bundle. That ladder is the TREE record's
//      (docs/pipelines.md §1.2, lib/pipelines.js) and says what a tree may do with a branch; a bundle says what a
//      PIPELINE does. Reading one as the other would let an imported studio pipeline push a tree the ladder says
//      may not.
//   5. Refusals are VALUES, never throws. A settings page, a route and a test all get the same `{ok, code, reason,
//      where}`; a loader that throws is a loader whose refusal the page renders as a 500.
import { readFileSync } from "node:fs";
import path from "node:path";

import { ISOLATIONS, ISOLATION_SHARED } from "./pipeline-fanout.js";

// What this code reads. A bundle declares its own number; a newer one is refused rather than half-read, because a
// later studio may put meaning in a field this loader would silently drop.
export const BUNDLE_VERSION = 1;

// The named reasons. A test and a settings page both name one of these rather than matching a sentence, and the
// sentence is free to get better without the name moving.
export const BUNDLE_FAULTS = Object.freeze({
  MISSING: "missing", // there is no file at the path — absence, not a bad bundle
  SHAPE: "not-a-bundle", // not JSON, not an object, or no pipelines/stages list in it
  VERSION: "unsupported-version", // no version, or one this panel does not read
  STAGE: "incomplete-stage", // a pipeline with no stage, or a stage without a name, a prompt or an artifact
  GATE: "incomplete-gate", // a gate whose decision artifact is not one the panel could read back
  HANDOFF: "bad-handoff", // an edge of a kind the studio has no drawing for
  REFERENCE: "dangling-reference", // a handoff or gate naming a stage or artifact the pipeline does not hold
  ISOLATION: "bad-isolation", // an isolation model this panel does not run — refused, never guessed
});

// The studio's three edge kinds. `loop` is drawn with a cap by the studio's own validator; the panel does not judge
// the graph's shape (order is the reading order, edges are drawn as given) but it does refuse an edge it cannot draw.
const HANDOFF_KINDS = ["sequence", "loop", "return"];

// The panel's existing slug rule (lib/pipelines.js): a config key, a task record and a chip all name a pipeline id.
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// A locator is the path a reader would type to find the record in the file they exported, not a path in this module's
// own objects: `pipelines[0].stages[2]` for the panel's wrapper, `pipeline.stages[2]` for a studio bundle.json, and
// `stages[2]` for a bare studio document, whose pipeline root IS the document.
const join = (base, rest) => (base ? `${base}.${rest}` : rest);

// Internal, thrown only inside this module and caught by the two entry points below. A bug in the normaliser is a
// different kind of failure and must not be reported as a bad bundle, so only `Fail` is caught.
class Fail extends Error {
  constructor(code, reason, where = null) {
    super(reason);
    this.code = code;
    this.reason = reason;
    this.where = where;
  }
}

const fail = (code, reason, where = null) => {
  throw new Fail(code, reason, where);
};

function refusal(code, reason, where = null, file = null) {
  return { ok: false, code, reason, where: where || null, file, bundle: null };
}

function accepted(bundle) {
  return { ok: true, code: null, reason: null, where: null, file: bundle.file || null, bundle };
}

// ---- the input forms -----------------------------------------------------------------------------------------------
// One doc, three shapes: the panel's multi-pipeline wrapper; the studio's bundle.json (one semantic pipeline plus its
// roles and the derived artifact inventory); and a bare studio pipeline document (what the studio's own export button
// calls pipeline.json). Detection is by the key that carries the stages, never by the file's name.
function partsOf(doc) {
  if (Array.isArray(doc.pipelines)) return { list: doc.pipelines, roles: doc.roles, form: "panel" };
  if (isObject(doc.pipeline) && Array.isArray(doc.pipeline.stages)) return { list: [doc.pipeline], roles: doc.pipeline.roles, form: "studio-bundle" };
  if (Array.isArray(doc.stages)) return { list: [doc], roles: doc.roles, form: "studio" };
  return null;
}

// A bundle's number may sit on the wrapper, on the doc, or on the one pipeline inside a studio bundle.json. All three
// are the same format version; a wrapper that carries none of them is an import the panel cannot date.
function versionOf(doc, parts) {
  if (has(doc, "bundleVersion")) return doc.bundleVersion;
  if (has(doc, "version")) return doc.version;
  const first = parts.list[0];
  return isObject(first) ? first.version : null;
}

// ---- normalising one pipeline ---------------------------------------------------------------------------------------
function rolesFor(rec, fallback) {
  const list = Array.isArray(rec.roles) ? rec.roles : Array.isArray(fallback) ? fallback : [];
  return list.filter(isObject);
}

// A stage's artifact is the thing it produces (the studio's "one artifact, one schema, one writer"). The sha256 is
// carried when the studio has one, but not required: a studio's seed write is a placeholder hash, and refusing on it
// would refuse every freshly authored pipeline the first time it is imported.
//
// `kind` is what the artifact IS, when the document says so. The driver acts on exactly one word, `pr`: the work
// lands as a pull request, so the row that ends on that stage is finished only when the PR reads MERGED. Any other
// word — or none at all, which is every bundle written before this field — is a stage with no PR to land, and its
// row is settled on the stage's own verdict (lib/task-pipeline-drive.js rule 3). It is lower-cased because it is a
// word a person typed in another file, and null (not a guessed default) says the document never named one.
function normaliseArtifact(raw, where, code) {
  if (!isObject(raw)) fail(code, "it produces no artifact — a stage whose output nobody can name cannot be handed on", where);
  const artifact = { id: text(raw.id), path: text(raw.path), schema: text(raw.schema), writer: text(raw.writer), sha256: text(raw.sha256) || null, kind: text(raw.kind).toLowerCase() || null };
  const missing = ["id", "path", "schema", "writer"].filter((key) => !artifact[key]);
  if (missing.length) fail(code, `its artifact is missing ${missing.join(", ")} (an artifact needs an id, a path, a schema and exactly one writer)`, where);
  return artifact;
}

// The gate's decision, and — when the document routes one — the OUTCOME-TO-EDGE map. `routes` is a bundle mapping
// from an outcome name to a handoff id, or to `null` for "no edge: the pipeline ends here". It is what lets a verdict
// END a loop the graph would otherwise take: the seat writes `{"outcome": "pass"}`, the graph says `pass` goes
// nowhere, and the driver stops instead of spending a crossing. The panel still never judges the decision — it obeys
// a route the DOCUMENT declared, which is the one middle path the design left open (§6.1, Q11).
//
// Validated whole, not partly: every key must be an outcome the decision declares, every declared outcome must have
// a route, and every non-null target must be a handoff that leaves the gate's own stage. An outcome with no route
// would leave the driver at a verdict it cannot act on, which is the state this field exists to remove.
//
// The map is REQUIRED wherever it decides something. A gate whose stage draws two or more ways out is a choice, and
// without `routes` the driver takes it by kind order — `sequence` before `loop` — so a `reject` is read as a push
// forward and reads on the board as progress. That is the ambiguity this field exists to remove, so such a bundle is
// refused at LOAD, naming the gate and the pipeline, rather than meeting the ignored verdict under a live row. A
// stage with one way out (or none) has no choice to get wrong: the row takes that road whatever the record says, and
// a decision there is a pause with a verdict on it, so it stays loadable without a map.
function normaliseDecision(raw, where) {
  if (raw == null) return null;
  if (!isObject(raw)) fail(BUNDLE_FAULTS.GATE, "its decision is not an object", where);
  const decision = {
    id: text(raw.id),
    path: text(raw.path),
    schema: text(raw.schema),
    writer: text(raw.writer),
    sha256: text(raw.sha256) || null,
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.map(text).filter(Boolean) : [],
  };
  const missing = ["id", "path", "schema", "writer"].filter((key) => !decision[key]);
  if (missing.length) fail(BUNDLE_FAULTS.GATE, `its decision is missing ${missing.join(", ")}`, join(where, "decision"));
  if (!decision.outcomes.length) {
    fail(BUNDLE_FAULTS.GATE, "its decision declares no outcomes — the stage that waits on this gate reads the decision by name, so a gate with no value cannot be waited on", join(where, "decision.outcomes"));
  }
  if (raw.routes != null) {
    if (!isObject(raw.routes)) fail(BUNDLE_FAULTS.GATE, "its decision's `routes` is not an object — the map is outcome → handoff id (or null)", join(where, "decision.routes"));
    decision.routes = {};
    for (const [outcome, target] of Object.entries(raw.routes)) {
      if (target !== null && !text(target)) {
        fail(BUNDLE_FAULTS.GATE, `its decision routes ${JSON.stringify(outcome)} to ${JSON.stringify(target)} — a route is a handoff id, or null for \"the pipeline ends here\"`, join(where, "decision.routes"));
      }
      decision.routes[text(outcome)] = target === null ? null : text(target);
    }
  }
  return decision;
}

// Case-folded lookup, because an outcome is a word a person typed in two files. Two keys that fold to the same word
// make the verdict ambiguous, and an ambiguous route is refused rather than picked.
const outcomeKey = (value) => text(value).toLowerCase();

function routesOf(decision) {
  return isObject(decision && decision.routes) ? decision.routes : null;
}

// The outcome → edge check, run once the handoffs exist. `at` is the gate's own location, so a refusal names it;
// `pipeline` is the pipeline's id, so the one refusal that can stop a whole import names what it is stopping.
function validateRoutes(gate, decision, handoffs, at, pipeline = null) {
  const routes = routesOf(decision);
  if (!routes) {
    // No map: legal only while the gate decides nothing the graph could route two ways. See normaliseDecision.
    const leaving = handoffs.filter((handoff) => handoff.from === gate.after);
    if (leaving.length > 1) {
      fail(
        BUNDLE_FAULTS.GATE,
        `gate ${gate.id} of pipeline ${pipeline || "(unnamed)"} declares outcome${decision.outcomes.length === 1 ? "" : "s"} ${decision.outcomes.join(", ")} and no "routes" map, and the stage it follows (${gate.after}) has ${leaving.length} ways out (${leaving.map((handoff) => handoff.id).join(", ")}) — the driver would fall back to its edge kind order and take the sequence edge, ignoring the verdict. Route each outcome to the handoff it should take, or to null for \"the pipeline ends here\"`,
        join(at, "decision.routes"),
      );
    }
    return;
  }
  const declared = new Map();
  for (const outcome of decision.outcomes) {
    const key = outcomeKey(outcome);
    if (declared.has(key)) fail(BUNDLE_FAULTS.GATE, `its decision declares two outcomes that read the same (${JSON.stringify(declared.get(key))} and ${JSON.stringify(outcome)}) — a verdict cannot be routed to two edges`, join(at, "decision.outcomes"));
    declared.set(key, outcome);
  }
  for (const [outcome, target] of Object.entries(routes)) {
    if (!declared.has(outcomeKey(outcome))) {
      fail(
        BUNDLE_FAULTS.GATE,
        `its decision routes outcome ${JSON.stringify(outcome)}, which it does not declare (it declares ${decision.outcomes.join(", ")})`,
        join(at, "decision.routes"),
      );
    }
    if (target === null) continue;
    const handoff = handoffs.find((entry) => entry.id === target);
    if (!handoff) {
      fail(BUNDLE_FAULTS.REFERENCE, `its decision routes ${JSON.stringify(outcome)} to handoff ${JSON.stringify(target)}, which this pipeline does not hold`, join(at, "decision.routes"));
    }
    if (handoff.from !== gate.after) {
      fail(
        BUNDLE_FAULTS.HANDOFF,
        `its decision routes ${JSON.stringify(outcome)} to handoff ${target}, which leaves stage ${handoff.from} — a gate routes the edges out of the stage it follows (${gate.after})`,
        join(at, "decision.routes"),
      );
    }
  }
  const unrouted = decision.outcomes.filter((outcome) => !Object.keys(routes).some((key) => outcomeKey(key) === outcomeKey(outcome)));
  if (unrouted.length) {
    fail(
      BUNDLE_FAULTS.GATE,
      `its decision declares outcome${unrouted.length === 1 ? "" : "s"} ${unrouted.join(", ")} and routes ${unrouted.length === 1 ? "it" : "them"} nowhere — a verdict the driver cannot route is the ambiguity \`routes\` exists to remove (name a handoff, or null)`,
      join(at, "decision.routes"),
    );
  }
}

// What a stage READS, as the document writes it: `inputs.read[]`, one entry per artifact the stage is handed. The
// entry carries a ledger locator (`ledger#C-0001`) rather than a path, so nothing here is resolved against a tree —
// the drawing names the artifact and the tree supplies the file. A read with no artifact id names nothing a drawing
// can place, so it is skipped rather than refused: this field was never part of the contract, and a bundle that
// loaded before this read arrived must not stop loading because its author wrote a looser list.
function normaliseReads(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => isObject(entry) && text(entry.artifact))
    .map((entry) => ({
      artifact: text(entry.artifact),
      location: text(entry.location) || null,
      mutability: text(entry.mutability) || null,
      sha256: text(entry.sha256) || null,
    }));
}

// The document's own boundary: artifacts the pipeline reads that no stage in it writes (`external_inputs`). The
// studio gives each one a reason and a source in prose; the panel carries them for the drawing and for the stage's
// reader, and resolves nothing — there is no path here to resolve.
function normaliseExternalInputs(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => isObject(entry) && text(entry.artifact))
    .map((entry) => ({
      artifact: text(entry.artifact),
      source: text(entry.source) || null,
      reason: text(entry.reason) || null,
    }));
}

function normaliseStages(raw, roles, where) {
  if (!Array.isArray(raw) || !raw.length) {
    fail(BUNDLE_FAULTS.STAGE, "the pipeline has no stages — a definition with no stage draws nothing and starts nowhere", join(where, "stages"));
  }
  const seen = new Set();
  return raw.map((stage, index) => {
    const at = join(where, `stages[${index}]`);
    if (!isObject(stage)) fail(BUNDLE_FAULTS.STAGE, "the stage is not an object", at);
    const id = text(stage.id);
    if (!id) fail(BUNDLE_FAULTS.STAGE, "the stage has no id — the task record names the stage it is in, and a stage with no id is one no record can be in", at);
    if (seen.has(id)) fail(BUNDLE_FAULTS.STAGE, `two stages share the id "${id}" — a loop names its stage, so the ids must differ`, at);
    seen.add(id);

    const title = text(stage.title) || text(stage.name);
    if (!title) fail(BUNDLE_FAULTS.STAGE, "the stage has no name — a card with an unnamed stage cannot say where the work is", at);

    // The prompt is the stage's whole instruction to whoever works it. The studio keeps that text on the roster role
    // and joins it with `owner.role` (or, for a role that names its stage, with `role.stage`); this contract accepts
    // either home and records which one answered, so a later reader can tell an authored prompt from a borrowed one.
    const roleId = text(stage.owner && stage.owner.role);
    // Only a NAMED owner matches by id: `roles.find((r) => text(r.id) === "")` would hand the first id-less role in
    // the file to a stage that names no owner, which is a prompt from a role nobody said was its own.
    const role = (roleId ? roles.find((r) => text(r.id) === roleId) : null) || roles.find((r) => text(r.stage) === id) || null;
    const prompt = text(stage.prompt) || text(role && role.instructions);
    if (!prompt) {
      fail(
        BUNDLE_FAULTS.STAGE,
        roleId
          ? `the stage has no prompt and its role "${roleId}" has no instructions — set stage.prompt or write the role's instructions`
          : "the stage has no prompt and no role that could supply one — set stage.prompt or give the stage an owner.role",
        at,
      );
    }

    return {
      id,
      title,
      position: index + 1,
      prompt,
      promptFrom: text(stage.prompt) ? "stage" : `role:${text(role.id)}`,
      role: roleId || text(role && role.id) || null,
      artifact: normaliseArtifact(stage.artifact, at, BUNDLE_FAULTS.STAGE),
      // The stage's declared inputs. An empty list is the honest answer for a stage that declares none, and it is
      // distinguishable from an absent `inputs` because the value is always an array (`[]`).
      reads: normaliseReads(isObject(stage.inputs) ? stage.inputs.read : null),
    };
  });
}

function normaliseGates(raw, stageIds, artifactIds, where, handoffs = [], pipeline = null) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) fail(BUNDLE_FAULTS.GATE, "the gates list is not a list", join(where, "gates"));
  const seen = new Set();
  return raw.map((gate, index) => {
    const at = join(where, `gates[${index}]`);
    if (!isObject(gate)) fail(BUNDLE_FAULTS.GATE, "the gate is not an object", at);
    const id = text(gate.id);
    if (!id) fail(BUNDLE_FAULTS.GATE, "the gate has no id", at);
    if (seen.has(id)) fail(BUNDLE_FAULTS.GATE, `two gates share the id "${id}"`, at);
    seen.add(id);

    const after = text(gate.after);
    if (!after) fail(BUNDLE_FAULTS.GATE, "the gate does not say which stage it follows (`after`)", at);
    if (!stageIds.has(after)) {
      fail(BUNDLE_FAULTS.REFERENCE, `the gate follows stage "${after}", which this pipeline does not hold (it holds ${[...stageIds].join(", ")})`, at);
    }
    const artifact = text(gate.artifact);
    if (!artifact) fail(BUNDLE_FAULTS.GATE, "the gate names no artifact to decide on", at);
    if (!artifactIds.has(artifact)) {
      fail(BUNDLE_FAULTS.REFERENCE, `the gate decides on artifact "${artifact}", which no stage in this pipeline produces (they produce ${[...artifactIds].join(", ")})`, at);
    }

    const decision = normaliseDecision(gate.decision, at);
    // The routes are checked against the edges that actually exist, so a mapping to a handoff this pipeline does not
    // hold is refused at LOAD rather than met as a dead route under a live row.
    if (decision) validateRoutes({ id, after }, decision, handoffs, at, pipeline);
    return {
      id,
      name: text(gate.name) || id,
      after,
      artifact,
      decider: text(gate.decider) || null,
      verifiedBy: text(gate.verified_by) || text(gate.verifiedBy) || null,
      // A gate with no decision is a PAUSE, not a broken gate (the studio's own description): nothing can wait on
      // it and no refusal can be read, and null says exactly that rather than inventing an artifact.
      decision,
    };
  });
}

function normaliseHandoffs(raw, stageIds, artifactIds, where) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) fail(BUNDLE_FAULTS.HANDOFF, "the handoffs list is not a list", join(where, "handoffs"));
  const seen = new Set();
  return raw.map((handoff, index) => {
    const at = join(where, `handoffs[${index}]`);
    if (!isObject(handoff)) fail(BUNDLE_FAULTS.HANDOFF, "the handoff is not an object", at);
    const id = text(handoff.id);
    if (!id) fail(BUNDLE_FAULTS.HANDOFF, "the handoff has no id", at);
    if (seen.has(id)) fail(BUNDLE_FAULTS.HANDOFF, `two handoffs share the id "${id}"`, at);
    seen.add(id);

    const from = text(handoff.from);
    const to = text(handoff.to);
    for (const [field, value] of [["from", from], ["to", to]]) {
      if (!value) fail(BUNDLE_FAULTS.HANDOFF, `the handoff names no ${field} stage`, at);
      if (!stageIds.has(value)) {
        fail(BUNDLE_FAULTS.REFERENCE, `the handoff's ${field} is stage "${value}", which this pipeline does not hold (it holds ${[...stageIds].join(", ")})`, at);
      }
    }
    const artifact = text(handoff.artifact);
    if (!artifact) fail(BUNDLE_FAULTS.HANDOFF, "the handoff passes no artifact — a stage handed on nothing is two stages in a list", at);
    if (!artifactIds.has(artifact)) {
      fail(BUNDLE_FAULTS.REFERENCE, `the handoff passes artifact "${artifact}", which no stage in this pipeline produces (they produce ${[...artifactIds].join(", ")})`, at);
    }
    const kind = text(handoff.kind);
    if (!HANDOFF_KINDS.includes(kind)) {
      fail(BUNDLE_FAULTS.HANDOFF, `the handoff is kind ${JSON.stringify(handoff.kind)} — the studio draws ${HANDOFF_KINDS.join(", ")}`, at);
    }

    return { id, from, to, artifact, kind, cap: text(handoff.cap) || null };
  });
}

function normalisePipeline(rec, fallbackRoles, where) {
  if (!isObject(rec)) fail(BUNDLE_FAULTS.SHAPE, "the pipeline is not an object", where);
  const project = isObject(rec.project) ? rec.project : {};
  const id = text(rec.id) || text(project.id);
  if (!id) fail(BUNDLE_FAULTS.SHAPE, "the pipeline has no id — a task record and a config default both name it, always by id and never by title", where);
  if (!SLUG_RE.test(id)) fail(BUNDLE_FAULTS.SHAPE, `the pipeline id "${id}" must be a slug (lowercase letters, digits, dot, dash, underscore)`, where);

  const title = text(rec.title) || text(rec.name) || text(project.name);
  if (!title) fail(BUNDLE_FAULTS.SHAPE, `pipeline "${id}" has no title`, where);

  // How the pipeline's stages share a workspace. `shared` (the default, and what every bundle written before this
  // field existed means) is one tree per row; `per-stage` gives a fan-out's lanes one tree each and the aggregator
  // one merge (lib/pipeline-fanout.js). Any other word is REFUSED rather than defaulted: the consequence of
  // "per-stage" is directories on the disk, and a panel that guessed would cut trees nobody asked for.
  const isolationRaw = text(rec.isolation).toLowerCase();
  const isolation = isolationRaw || ISOLATION_SHARED;
  if (!ISOLATIONS.includes(isolation)) {
    fail(BUNDLE_FAULTS.ISOLATION, `pipeline "${id}" declares isolation ${JSON.stringify(rec.isolation)} — this panel runs ${ISOLATIONS.join(" or ")}, and a word it does not know is not a model it can guess`, where);
  }

  const roles = rolesFor(rec, fallbackRoles);
  const stages = normaliseStages(rec.stages, roles, where);
  const stageIds = new Set(stages.map((s) => s.id));
  const artifactIds = new Set(stages.map((s) => s.artifact.id));
  // Handoffs before gates: a gate's `routes` names the edges out of its own stage, so the edges must exist before the
  // map that points at them is judged.
  const handoffs = normaliseHandoffs(rec.handoffs, stageIds, artifactIds, where);
  const gates = normaliseGates(rec.gates, stageIds, artifactIds, where, handoffs, id);
  const budget = isObject(project.budget)
    ? {
        stageTokens: Number.isInteger(project.budget.stage_tokens) ? project.budget.stage_tokens : null,
        episodeRounds: Number.isInteger(project.budget.episode_rounds) ? project.budget.episode_rounds : null,
        wallMinutes: Number.isInteger(project.budget.wall_minutes) ? project.budget.wall_minutes : null,
      }
    : null;

  return {
    id,
    title,
    description: text(rec.description) || text(project.description),
    // `shared` or `per-stage`, always answered: a reader of a pipeline never has to ask whether the field was there.
    isolation,
    budget,
    // Order is the array's own order (the studio calls it "the default reading order"), and `position` on each stage
    // is 1-based for the same reason: "stage 4 of 13" is what a card says, and an index of 3 is what a reader has to
    // convert before it means anything.
    order: stages.map((s) => s.id),
    stages,
    gates,
    handoffs,
    // The document's boundary: what the pipeline reads from outside itself. Always a list, so a drawing can ask
    // "which artifacts come from outside" without a second read of the file.
    externalInputs: normaliseExternalInputs(rec.external_inputs),
  };
}

// ---- the two entry points -------------------------------------------------------------------------------------------
// Parse a bundle already in hand: an object, or the JSON text of one. Never throws (rule 5).
export function parseBundle(raw, { file = null } = {}) {
  let doc = raw;
  if (typeof raw === "string") {
    try {
      doc = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch (error) {
      return refusal(BUNDLE_FAULTS.SHAPE, `the bundle is not JSON (${String((error && error.message) || error)})`, null, file);
    }
  }
  if (!isObject(doc)) return refusal(BUNDLE_FAULTS.SHAPE, "the bundle is not a JSON object", null, file);

  const parts = partsOf(doc);
  if (!parts) {
    return refusal(
      BUNDLE_FAULTS.SHAPE,
      "the bundle has no pipelines list — expected a panel bundle (`pipelines[]`), a studio bundle (`pipeline` with `stages[]`) or a studio pipeline document (`stages[]`)",
      null,
      file,
    );
  }
  if (!parts.list.length) return refusal(BUNDLE_FAULTS.SHAPE, "the bundle holds no pipeline", null, file);

  const version = versionOf(doc, parts);
  if (version == null || version === "") {
    return refusal(BUNDLE_FAULTS.VERSION, `this panel reads bundle version ${BUNDLE_VERSION}, and the bundle declares no version — an import the panel cannot date is one it cannot promise to read the same way twice`, null, file);
  }
  if (!Number.isInteger(version) || version < 1) {
    return refusal(BUNDLE_FAULTS.VERSION, `${JSON.stringify(version)} is not a bundle version — it must be a whole number of 1 or more`, null, file);
  }
  if (version > BUNDLE_VERSION) {
    return refusal(BUNDLE_FAULTS.VERSION, `the bundle is version ${version}, newer than this panel's ${BUNDLE_VERSION} — it is refused whole rather than half-read, because a later studio may put meaning in a field this loader would drop`, null, file);
  }

  try {
    const pipelines = [];
    const seen = new Set();
    parts.list.forEach((rec, index) => {
      // The locator is the file's own path, not this module's: see `join`.
      const where = parts.form === "panel" ? `pipelines[${index}]` : parts.form === "studio-bundle" ? "pipeline" : "";
      const pipeline = normalisePipeline(rec, parts.roles, where);
      if (seen.has(pipeline.id)) fail(BUNDLE_FAULTS.SHAPE, `a second pipeline with the id "${pipeline.id}" — a config default could not say which one it meant`, `pipelines[${index}]`);
      seen.add(pipeline.id);
      pipelines.push(pipeline);
    });
    return accepted({
      version: BUNDLE_VERSION,
      name: text(doc.name) || pipelines[0].id,
      file,
      pipelines,
    });
  } catch (error) {
    if (!(error instanceof Fail)) throw error; // a bug is not a bad bundle
    return refusal(error.code, error.reason, error.where, file);
  }
}

// Read one file and parse it. A missing file is ABSENCE (`missing`), not a bad bundle: a settings page that has not
// chosen one yet and a bundle that cannot be read are different answers, and the panel must be able to tell them.
export function readBundle(file) {
  if (!file) return refusal(BUNDLE_FAULTS.MISSING, "no bundle file was named", null, null);
  const target = path.resolve(file);
  let body;
  try {
    body = readFileSync(target, "utf8");
  } catch (error) {
    const code = error && error.code === "ENOENT" ? BUNDLE_FAULTS.MISSING : BUNDLE_FAULTS.SHAPE;
    const why = error && error.code === "ENOENT" ? "there is no bundle at that path" : `it could not be read (${String((error && error.message) || error)})`;
    return refusal(code, `${target}: ${why}`, null, target);
  }
  return parseBundle(body, { file: target });
}

// ---- reading the result -------------------------------------------------------------------------------------------
// The lookups a reader wants, so no caller re-implements "find by id and pretend not to care about case". Ids are
// exact: a pipeline id is a config key and a task record's value, and a near-match is a typo the panel must not hide.
export function pipelineById(bundle, id) {
  const wanted = text(id);
  if (!bundle || !wanted) return null;
  return (bundle.pipelines || []).find((pipeline) => pipeline.id === wanted) || null;
}

export function stageById(pipeline, id) {
  const wanted = text(id);
  if (!pipeline || !wanted) return null;
  return (pipeline.stages || []).find((stage) => stage.id === wanted) || null;
}

// The position a stage sits at, 1-based, or null when the pipeline does not hold it.
export function positionOf(pipeline, id) {
  const stage = stageById(pipeline, id);
  return stage ? stage.position : null;
}
