// What a worktree is FOR, written down: a catalogue of named pipeline definitions, the closed vocabulary of exit
// checks a stage may end on, and the ladder a tree climbs (docs/pipelines.md).
//
// Three rules decide the shape of this module, and they are the document's:
//
//   1. A definition is DATA. The code knows only the three kinds (local → investigation → turnover) and the exit
//      checks in §1.3; every stage, prompt and ordering lives in pipelines.json (reader-edited, in the panel's state
//      folder) over pipelines.seed.json (shipped with the code). A new host's landing style is a record, not a patch.
//   2. A bad definition is dropped BY ID, never whole-file: one pipeline with a typo is one pipeline the board does
//      not offer, not a switching surface that disappears. The panel names it and why (`dropped`, plus a warning per
//      error line). The ONE whole-file refusal is a file whose `version` is newer than this code's: it is not parsed
//      at all, the seed is loaded read-only, and the log says so — half-parsing it would look complete and not be.
//   3. The record is a PATH, not a position. `history[]` is append-only and records the transition (`from`/`to` kinds)
//      as well as the stage entered, because a loop (wait → address → wait) is a path and the kinds are what decide
//      what the tree may do. The ladder only climbs: a downgrade is refused with a sentence, never applied quietly.
//
// This module owns no git and no UI. It validates, it loads, it resolves a project's default, and it keeps the
// tree-keyed record the panel reads back before it changes anything.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Stamped into pipelines.json, the way ROLES_VERSION is stamped into roles.json. A file newer than this number was
// written by a later panel and is refused WHOLE (see readPipelinesFile) rather than read optimistically.
export const PIPELINES_VERSION = 1;

export const DEFAULT_SEED_FILE = "pipelines.seed.json";

// The ladder, lowest first. `kind` is a rung, not a category label: each rung changes exactly one thing — whether a
// remote branch exists, and whether a human has to answer before main moves.
export const PIPELINE_KINDS = ["local", "investigation", "turnover"];
export const KIND_RANK = { local: 0, investigation: 1, turnover: 2 };

// The definition of each kind that ships in the seed and is the closed default when nothing names one (docs §2).
export const BUILTIN_IDS = { local: "local", investigation: "investigate", turnover: "turnover" };

// The keys on a project record (and on config.json) that name a project's own defaults. Siblings of
// `remoteBranchPolicy`, resolved by `defaultForProject` the way `policyForProject` resolves the policy.
export const DEFAULT_KEYS = { investigation: "defaultInvestigation", turnover: "defaultTurnover" };

// §1.3, the whole vocabulary. A `check` outside this list is refused at load/save time; nothing here evaluates one
// yet (the evaluator is a later task), but the name and its parameters have to be right NOW or the catalogue is a
// promise the panel cannot keep.
export const EXIT_CHECKS = [
  "clean",
  "commits",
  "branch-exists",
  "branch-name",
  "pushed",
  "main-moved",
  "pr-open",
  "pr-head",
  "reviewers-exact",
  "pr-comments",
  "pr-approved",
  "pr-merged",
  "file-exists",
  "command",
];

// What each check's parameters may be, and which are required. `text` is a non-empty string (a `{{placeholder}}` is
// allowed and validated against the closed list); `regex` must compile; `positiveInteger` is a `min`; `textList` is
// a non-empty list of names (the reviewers); `argv` is one argv list (the command's words, never a shell line).
const P = (type, required = false) => ({ type, required });
export const EXIT_PARAM_SPEC = {
  clean: {},
  commits: { min: P("positiveInteger"), base: P("text") },
  "branch-exists": { branch: P("text", true) },
  "branch-name": { pattern: P("regex", true), branch: P("text") },
  pushed: { remote: P("text"), branch: P("text") },
  "main-moved": { remote: P("text"), main: P("text") },
  "pr-open": {},
  "pr-head": {},
  "reviewers-exact": { who: P("textList", true) },
  "pr-comments": { lastSeen: P("text") },
  "pr-approved": {},
  "pr-merged": {},
  "file-exists": { path: P("text", true) },
  command: { argv: P("argv", true) },
};

// §1.4, the closed set. An unknown placeholder is refused when the definition is saved, not rendered empty at run
// time: a prompt with a silently missing {{ticket}} is the brief that produces a branch called `_`.
export const PROMPT_PLACEHOLDERS = ["tree", "branch", "main", "project", "remote", "host", "ticket", "desc", "pr", "sha", "lastSeen"];

// Whitespace inside the braces is the way a person writes a hole (`{{ ticket }}`), so it is part of the expression:
// a scanner that cannot see the padding validates the hole as prose, and `{{ nope }}` is saved. The capture is the
// bare name, with or without padding, so `promptPlaceholders`, `unknownPlaceholders` and the error sentences all
// agree about which hole is on the page (P0-6, docs/pipelines-audit.md).
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const clean = (value) => String(value ?? "").trim();
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function promptPlaceholders(text) {
  const out = [];
  for (const m of String(text || "").matchAll(PLACEHOLDER_RE)) out.push(m[1]);
  return out;
}

export function unknownPlaceholders(text) {
  return promptPlaceholders(text).filter((name) => !PROMPT_PLACEHOLDERS.includes(name));
}

// ---- validation -------------------------------------------------------------------------------------------------
// Every error is a sentence a reader can act on and names the definition and the stage BY POSITION ("pipeline "x":
// stage 1: …"), because a stage that is missing an id has no id to name. They are reported per definition and the
// definition is dropped as a whole — a half-valid pipeline is not a pipeline.
function checkTextParam(where, key, value, errors, { placeholder = true } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${where}: ${key} must be a non-empty string (got ${JSON.stringify(value)})`);
    return;
  }
  if (placeholder) {
    for (const name of unknownPlaceholders(value)) errors.push(`${where}: ${key} uses unknown placeholder {{${name}}} (the closed list is ${PROMPT_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")})`);
  }
}

function checkExit(where, exit, errors) {
  if (!isObject(exit)) {
    errors.push(`${where}: no exit — a stage that ends when a model says it is done cannot be resumed, re-checked or audited`);
    return;
  }
  const check = clean(exit.check);
  if (!EXIT_CHECKS.includes(check)) {
    errors.push(`${where}: exit.check ${JSON.stringify(exit.check)} is not one of the closed vocabulary (${EXIT_CHECKS.join(", ")})`);
    return;
  }
  const spec = EXIT_PARAM_SPEC[check] || {};
  const described = Object.keys(spec).length ? Object.keys(spec).join(", ") : "none";
  for (const [key, value] of Object.entries(exit)) {
    if (key === "check") continue;
    if (!spec[key]) {
      errors.push(`${where}: exit.${key} is not a parameter of the ${check} check (it takes ${described})`);
      continue;
    }
    const type = spec[key].type;
    if (type === "text") checkTextParam(where, `exit.${key}`, value, errors);
    else if (type === "regex") {
      if (typeof value !== "string" || !value.trim()) errors.push(`${where}: exit.${key} must be a non-empty regex`);
      else {
        try {
          new RegExp(value);
        } catch (e) {
          errors.push(`${where}: exit.${key} does not compile as a regex (${String((e && e.message) || e)})`);
        }
      }
    } else if (type === "positiveInteger") {
      if (!Number.isInteger(value) || value < 1) errors.push(`${where}: exit.${key} must be a positive integer (got ${JSON.stringify(value)})`);
    } else if (type === "textList") {
      if (!Array.isArray(value) || !value.length || value.some((v) => typeof v !== "string" || !v.trim())) {
        errors.push(`${where}: exit.${key} must be a non-empty list of names (got ${JSON.stringify(value)})`);
      }
    } else if (type === "argv") {
      if (!Array.isArray(value) || !value.length || value.some((v) => typeof v !== "string" || !v.trim())) {
        errors.push(`${where}: exit.${key} must be a single argv list of words — an array of non-empty strings, never a shell line (got ${JSON.stringify(value)})`);
      }
    }
  }
  for (const [key, rule] of Object.entries(spec)) {
    if (!rule.required) continue;
    if (!(key in exit)) errors.push(`${where}: exit.${key} is required by the ${check} check`);
  }
}

// Validate ONE definition, with the id the catalogue will file it under. `catalogue` (optional) is the loaded map of
// already-valid definitions: with it, `next` is checked too — it must name a definition, and a chain may not go
// backwards (§5). Without it (a single-definition save on its own) the cross-reference is the caller's business.
export function validatePipeline(id, def, { catalogue = null } = {}) {
  const errors = [];
  const name = clean(id);
  if (!name) errors.push("a pipeline definition needs an id");
  else if (!SLUG_RE.test(name)) errors.push(`pipeline "${name}": the id must be a slug (lowercase letters, digits, dot, dash, underscore) — a chip and a config key name it, never a title`);
  if (!isObject(def)) return [`pipeline "${name || "(no id)"}": not an object`];
  const declared = def.id == null ? "" : clean(def.id);
  if (declared && name && declared !== name) errors.push(`pipeline "${name}": its own id is ${JSON.stringify(def.id)} — the definition must be filed under the id it carries`);
  const kind = clean(def.kind);
  if (!PIPELINE_KINDS.includes(kind)) errors.push(`pipeline "${name}": kind must be one of ${PIPELINE_KINDS.join(", ")} (got ${JSON.stringify(def.kind)})`);
  if (!clean(def.title)) errors.push(`pipeline "${name}": title is required (the chip shows it)`);
  if (def.description != null && typeof def.description !== "string") errors.push(`pipeline "${name}": description must be a string`);
  const stages = def.stages;
  if (!Array.isArray(stages) || !stages.length) {
    errors.push(`pipeline "${name}": stages must be a non-empty list — a definition with no stage does nothing`);
  } else {
    const seen = new Set();
    stages.forEach((stage, index) => {
      const where = `pipeline "${name}": stage ${index + 1}`;
      if (!isObject(stage)) {
        errors.push(`${where}: not an object`);
        return;
      }
      const sid = clean(stage.id);
      if (!sid) errors.push(`${where}: id is required (the record names the stage it is in)`);
      else if (!SLUG_RE.test(sid)) errors.push(`${where}: id must be a slug (got ${JSON.stringify(stage.id)})`);
      else if (seen.has(sid)) errors.push(`${where}: duplicate stage id "${sid}" — a loop names its stage, so the ids must differ`);
      else seen.add(sid);
      if (!clean(stage.title)) errors.push(`${where}: title is required`);
      if (typeof stage.prompt !== "string" || !stage.prompt.trim()) errors.push(`${where}: prompt is required — the stage's whole instruction to the worker`);
      else {
        for (const hole of unknownPlaceholders(stage.prompt)) {
          errors.push(`${where}: prompt uses unknown placeholder {{${hole}}} (the closed list is ${PROMPT_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")})`);
        }
      }
      checkExit(where, stage.exit, errors);
    });
  }
  const next = def.next == null || def.next === "" ? null : clean(def.next);
  if (def.next != null && def.next !== "" && typeof def.next !== "string") errors.push(`pipeline "${name}": next must be a pipeline id or null`);
  else if (next && !SLUG_RE.test(next)) errors.push(`pipeline "${name}": next must be a slug (got ${JSON.stringify(def.next)})`);
  else if (next && catalogue) {
    const target = catalogue[next];
    if (!target) errors.push(`pipeline "${name}": next names "${next}", which is not in the catalogue`);
    else if ((KIND_RANK[target.kind] ?? -1) < (KIND_RANK[kind] ?? -1)) {
      errors.push(`pipeline "${name}": next names "${next}", a ${target.kind} pipeline — a chain may not go backwards (${kind} → ${target.kind})`);
    }
  }
  return errors;
}

export function rankOf(kind) {
  const k = clean(kind);
  return Object.prototype.hasOwnProperty.call(KIND_RANK, k) ? KIND_RANK[k] : null;
}

// ---- the file --------------------------------------------------------------------------------------------------
function emptyDoc(extra = {}) {
  return { version: null, pipelines: {}, dropped: [], warnings: [], refused: null, readOnly: false, file: null, seedFile: null, ...extra };
}

// Read one file. A file whose version is NEWER than this code's is refused whole — no definition in it is read, and
// the caller is expected to fall back to the seed read-only. Everything else is validated per definition and a bad
// one is dropped by id (named in `dropped` and in `warnings`); the rest of the catalogue still loads.
export function readPipelinesFile(file) {
  const doc = emptyDoc({ file: file ? path.resolve(file) : null });
  if (!file) return doc;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    if (e && e.code === "ENOENT") return doc;
    doc.warnings.push(`${file}: ${String((e && e.message) || e)} — no pipeline catalogue is in force from it`);
    return doc;
  }
  if (!isObject(raw)) {
    doc.warnings.push(`${file}: not a JSON object — no pipeline catalogue is in force from it`);
    return doc;
  }
  const version = Number(raw.version);
  if (Number.isFinite(version) && version > PIPELINES_VERSION) {
    doc.refused = {
      version,
      supported: PIPELINES_VERSION,
      why: `${path.basename(file)} is version ${version}, newer than this panel's ${PIPELINES_VERSION} — the catalogue in it is refused whole, not half-parsed`,
    };
    doc.warnings.push(`${file}: ${doc.refused.why}; the seed is in force read-only`);
    return doc;
  }
  doc.version = Number.isFinite(version) ? version : null;

  const records = [];
  if (Array.isArray(raw.pipelines)) {
    raw.pipelines.forEach((rec, index) => records.push([clean(isObject(rec) ? rec.id : ""), rec, index]));
  } else if (isObject(raw.pipelines)) {
    for (const [id, rec] of Object.entries(raw.pipelines)) records.push([clean(id), rec, null]);
  } else {
    doc.warnings.push(`${file}: no pipelines list — nothing to load`);
    return doc;
  }

  for (const [id, rec, index] of records) {
    const name = id || `#${(index ?? 0) + 1}`;
    if (Object.prototype.hasOwnProperty.call(doc.pipelines, name)) {
      const why = `a second definition with the id "${name}" — the first one is in force`;
      doc.dropped.push({ id: name, why });
      doc.warnings.push(`pipeline "${name}": ${why}`);
      continue;
    }
    const errors = validatePipeline(id, rec);
    if (errors.length) {
      doc.dropped.push({ id: name, why: errors.join("; ") });
      doc.warnings.push(...errors);
      continue;
    }
    doc.pipelines[name] = { ...rec, id: name, kind: clean(rec.kind), stages: rec.stages.map((s) => ({ ...s, id: clean(s.id) })), next: rec.next == null || rec.next === "" ? null : clean(rec.next) };
  }

  return doc;
}

// Cross-references are a property of the MERGED catalogue, not of one file: a live definition may chain into a
// definition the seed ships, and a seed definition is validated without knowing what the live file overrides. So the
// `next` rules (§5: a chain may not go backwards) run here, once, over what the panel actually holds.
//   - `next` names nothing anywhere            → the definition is dropped by id (a typo, not a chain)
//   - `next` names a valid LOWER kind          → dropped by id (a chain may not go backwards)
//   - `next` names an id that was dropped      → kept, with a warning: the definition is still usable, its chain is not
function pruneChains(doc) {
  const known = new Set([...Object.keys(doc.pipelines), ...(doc.dropped || []).map((d) => d.id)]);
  for (const [id, def] of [...Object.entries(doc.pipelines)]) {
    const next = clean(def.next);
    if (!next) continue;
    if (!known.has(next)) {
      const why = `next names "${next}", which is not in the catalogue`;
      delete doc.pipelines[id];
      doc.dropped.push({ id, why });
      doc.warnings.push(`pipeline "${id}": ${why}`);
      continue;
    }
    const target = doc.pipelines[next];
    if (!target) {
      doc.warnings.push(`pipeline "${id}": next names "${next}", which was dropped — this definition is in force and its chain will not happen`);
      continue;
    }
    if ((KIND_RANK[clean(target.kind)] ?? -1) < (KIND_RANK[clean(def.kind)] ?? -1)) {
      const why = `next names "${next}", a ${clean(target.kind)} pipeline — a chain may not go backwards (${clean(def.kind)} → ${clean(target.kind)})`;
      delete doc.pipelines[id];
      doc.dropped.push({ id, why });
      doc.warnings.push(`pipeline "${id}": ${why}`);
    }
  }
  return doc;
}

// The seed supplies defaults; the live file wins per id. Merging (rather than copying the seed into the live file on
// first boot) is what lets a new definition ship in the seed and reach an install whose pipelines.json already exists.
// A REFUSED live file contributes nothing but its refusal: the seed is the catalogue, read-only.
export function mergeDocs(seed, live) {
  const doc = emptyDoc({ file: live?.file || null, seedFile: seed?.file || null });
  doc.dropped = [...(seed?.dropped || []), ...(live?.dropped || [])];
  doc.warnings = [...(seed?.warnings || []), ...(live?.warnings || [])];
  if (live?.refused) {
    doc.pipelines = { ...(seed?.pipelines || {}) };
    doc.version = seed?.version ?? null;
    doc.refused = live.refused;
    doc.readOnly = true;
    return pruneChains(doc);
  }
  doc.pipelines = { ...(seed?.pipelines || {}), ...(live?.pipelines || {}) };
  doc.version = live?.version ?? seed?.version ?? null;
  doc.refused = null;
  doc.readOnly = false;
  return pruneChains(doc);
}

// Read the pair and merge them. Cached on (mtime,size) of both files, so a reader's edit to either is live on the
// next pass rather than the next restart, and a board asking for a definition per row does not stat-storm.
const cache = new Map();
export function pipelinesDoc({ file = null, seedFile = DEFAULT_SEED_FILE, ttlMs = 1500, now = Date.now() } = {}) {
  const livePath = file ? path.resolve(file) : null;
  const seedPath = seedFile ? path.resolve(seedFile) : null;
  const stamp = (p) => {
    if (!p) return "-";
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "missing";
    }
  };
  const key = `${stamp(livePath)}|${stamp(seedPath)}`;
  const slot = livePath || "-";
  const hit = cache.get(slot);
  if (hit && hit.key === key && now - hit.at < ttlMs) return hit.doc;
  const doc = mergeDocs(readPipelinesFile(seedPath), readPipelinesFile(livePath));
  cache.set(slot, { key, at: now, doc });
  return doc;
}

export function resetPipelinesCache() {
  cache.clear();
}

// Create the live file when it is not there, so the file the panel reads is one the reader can find and edit. It
// starts EMPTY on purpose (the seed holds the defaults, and a copy here would freeze them) and carries the version
// stamp the loader refuses a newer one against.
export function ensurePipelinesFile({ file = null, seedFile = DEFAULT_SEED_FILE, log = () => {} } = {}) {
  if (!file) return { created: false, file: null };
  const target = path.resolve(file);
  try {
    statSync(target);
    return { created: false, file: target };
  } catch {
    /* not there yet: write the skeleton */
  }
  const body = {
    version: PIPELINES_VERSION,
    note: "Reader-edited pipeline definitions: what a worktree is for, stage by stage. Records here override pipelines.seed.json per id; docs/pipelines.md is the design. An invalid definition is dropped by id and named in the log; a file whose version is newer than this panel's is refused whole.",
    pipelines: [],
  };
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    log(`pipelines: created ${target} (defaults come from ${seedFile ? path.resolve(seedFile) : "no seed"})`);
    resetPipelinesCache();
    return { created: true, file: target };
  } catch (e) {
    log(`pipelines: could not create ${target}: ${String((e && e.message) || e)}`);
    return { created: false, file: target, error: String((e && e.message) || e) };
  }
}

// ---- per-project defaults, beside remoteBranchPolicy -----------------------------------------------------------
// The sibling of `policyForProject` (lib/remote-writes.js), resolved the same way and for the same reason: two
// resolvers that disagree is how a tree ends up on one project's pipeline and another project's policy. Project's
// own key → config.json's global key → the built-in definition of that kind. An id that names nothing, or names a
// definition of the wrong kind, falls back to the built-in AND says so — never a guessed pipeline.
export function defaultForProject(project, kind, { catalogue = null, config = {} } = {}) {
  const wanted = clean(kind).toLowerCase();
  const defs = catalogue && typeof catalogue.doc === "function" ? catalogue.doc().pipelines : catalogue?.pipelines || catalogue || {};
  const key = DEFAULT_KEYS[wanted];
  if (!key) {
    return { id: null, kind: wanted, title: null, source: "builtin", fallback: true, definition: null, why: `${JSON.stringify(kind)} is not a pipeline kind (${PIPELINE_KINDS.join(", ")})` };
  }
  const complaints = [];
  const candidates = [
    ["project", project?.[key]],
    ["global", config?.[key]],
  ];
  for (const [source, raw] of candidates) {
    const id = clean(raw);
    if (!id) continue;
    const def = defs[id];
    const who = source === "project" ? `this project's ${key}` : `config.json's ${key}`;
    if (def && clean(def.kind) === wanted) {
      return { id, kind: wanted, title: clean(def.title), source, fallback: false, definition: def, why: "" };
    }
    if (def) complaints.push(`${who} names "${id}", which is a pipeline of kind ${clean(def.kind)}, not ${wanted}`);
    else complaints.push(`${who} names "${id}", which is not in the catalogue`);
  }
  const builtinId = BUILTIN_IDS[wanted];
  const builtin = defs[builtinId] || null;
  if (builtin && clean(builtin.kind) === wanted) {
    return {
      id: builtinId,
      kind: wanted,
      title: clean(builtin.title),
      source: "builtin",
      fallback: complaints.length > 0,
      definition: builtin,
      why: complaints.length ? `${complaints.join("; ")} — the built-in "${builtinId}" is in force` : "",
    };
  }
  return {
    id: builtinId,
    kind: wanted,
    title: null,
    source: "builtin",
    fallback: true,
    definition: null,
    why: `${complaints.length ? `${complaints.join("; ")}; ` : ""}the built-in "${builtinId}" is missing from the catalogue — no ${wanted} pipeline is in force`,
  };
}

// Both defaults for one project, in the shape a chip's menu and a settings header read.
export function defaultsForProject(project, { catalogue = null, config = {} } = {}) {
  return {
    turnover: defaultForProject(project, "turnover", { catalogue, config }),
    investigation: defaultForProject(project, "investigation", { catalogue, config }),
  };
}

// ---- the record ------------------------------------------------------------------------------------------------
// Always `local` at cut: a tree is cut before anybody knows whether the work is a probe or a turnover, so a pipeline
// chosen at cut would be a promise about work nobody has done yet (§3). The project's defaultTurnover is applied
// when the reader says the work is a turnover, or when an investigation's last stage chains into it.
export function cutPipeline({ at = new Date().toISOString() } = {}) {
  return {
    id: BUILTIN_IDS.local,
    stage: "work",
    since: at,
    history: [{ from: "local", to: "local", stage: "work", at, by: "cut", why: "every tree is cut local" }],
  };
}

// A tree that predates pipelines has no record. It is local — that is the panel's behaviour today — so the route
// reads it as local rather than refusing every existing tree. The synthesized record is only used for its KIND: the
// moment it changes, `since` is the change's own clock and the history starts with the real transition.
export function presumedPipeline({ at = null } = {}) {
  return { id: BUILTIN_IDS.local, stage: "work", since: at, history: [] };
}

// The one sentence a downgrade is refused with, per kind pair. The turnover → investigation pair is the document's
// own: a turnover branch reported as an investigation would be reported as not landing.
export function ladderRefusal(fromKind, toKind) {
  const from = clean(fromKind);
  const to = clean(toKind);
  if (!PIPELINE_KINDS.includes(from) || !PIPELINE_KINDS.includes(to)) {
    return `${JSON.stringify(fromKind)} → ${JSON.stringify(toKind)} is not a change on the ladder (${PIPELINE_KINDS.join(", ")})`;
  }
  const a = KIND_RANK[from];
  const b = KIND_RANK[to];
  if (b === a) return `this tree is already on a ${from} pipeline; a pipeline change only ever climbs the ladder (local → investigation → turnover)`;
  if (b > a) return null;
  if (from === "turnover" && to === "investigation") {
    return "this tree is already a turnover; a turnover branch reported as an investigation would be reported as not landing";
  }
  if (from === "turnover") return "this tree is already a turnover; a turnover branch reported as local would be reported as not landing";
  return "this tree is already an investigation; an investigation may not become local — local may not push, and this tree already may";
}

// Apply a change, or refuse it. The record's schema is §3's: `{id, stage, since, history[]}`, with one history entry
// per change carrying the transition (`from`/`to` kinds), the stage entered, who did it and why.
export function changePipeline(current, { fromKind, toKind, id, stage = null, by = "reader", why = "", at = new Date().toISOString() } = {}) {
  const refusal = ladderRefusal(fromKind, toKind);
  if (refusal) return { ok: false, code: KIND_RANK[clean(toKind)] < KIND_RANK[clean(fromKind)] ? "downgrade" : "same-kind", error: refusal, pipeline: current || null };
  const nextId = clean(id);
  if (!nextId) return { ok: false, code: "no-id", error: "a pipeline id is required", pipeline: current || null };
  const before = current || presumedPipeline();
  const record = {
    id: nextId,
    stage: stage == null || stage === "" ? null : clean(stage),
    since: at,
    history: [
      ...(Array.isArray(before.history) ? before.history : []),
      { from: clean(fromKind), to: clean(toKind), stage: stage == null || stage === "" ? null : clean(stage), at, by: clean(by) || "reader", why: clean(why) },
    ],
  };
  return { ok: true, error: null, code: null, pipeline: record };
}

// A hop from one stage to the next INSIDE one definition — `wait → address → wait` is two hops of the same kind. This
// is not a pipeline change, so it is not on the ladder and the ladder does not refuse it: the definition keeps its
// id, and the history gains one entry per hop, because §3's history is a path and not a set. The exit-check evaluator
// (#38) is what calls this when a stage exits.
export function advanceStage(current, { kind, stage = null, by = "stage", why = "", at = new Date().toISOString() } = {}) {
  if (!current) return null;
  const k = clean(kind);
  if (!PIPELINE_KINDS.includes(k)) return null;
  const entered = stage == null || stage === "" ? null : clean(stage);
  return {
    ...current,
    stage: entered,
    since: at,
    history: [...(Array.isArray(current.history) ? current.history : []), { from: k, to: k, stage: entered, at, by: clean(by) || "stage", why: clean(why) }],
  };
}

// ---- the durable record, on the TREE ---------------------------------------------------------------------------
// The job store keeps 80 conversations and marks in-flight runs interrupted on restart; a review loop runs for days.
// So the durable record is keyed by the TREE's path, in the panel's state folder beside push-guard.json, and each
// job carries a copy at start for the card to draw. A wake, a restart or a second panel reads the tree record.
const normKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export class PipelineRecords {
  constructor({ file = null, log = () => {}, ttlMs = 500 } = {}) {
    this.file = file;
    this.log = log;
    this.ttlMs = ttlMs;
    this.cached = null;
    this.stamp = null;
    this.at = 0;
  }

  stampOf() {
    if (!this.file) return "-";
    try {
      const s = statSync(this.file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "missing";
    }
  }

  // The whole book: `{version, trees}`. Cached on the file's stamp for a moment, and re-read outright when `fresh`
  // is asked for — the switching route treats its own read as the authority, because a chip's menu is a claim.
  //
  // `loaded` says whether the book that is there was actually read. A missing file is an empty book and a loadable
  // one — the first cut has to be able to create it. A file that exists but throws is NOT: the empty book this
  // function then holds is a guess, and `set` must refuse to write that guess back over every other tree's record.
  doc({ fresh = false } = {}) {
    const now = Date.now();
    const stamp = this.stampOf();
    if (!fresh && this.cached && this.stamp === stamp && now - this.at < this.ttlMs) return this.cached;
    const doc = { version: 1, trees: {}, file: this.file ? path.resolve(this.file) : null, loaded: true };
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
        for (const [key, rec] of Object.entries((raw && raw.trees) || {})) {
          if (!rec || typeof rec !== "object") {
            this.log(`pipelines: ${this.file} holds a record for ${key} that is not an object — ignored`);
            continue;
          }
          doc.trees[key] = rec;
        }
      } catch (e) {
        doc.loaded = false;
        this.log(`pipelines: could not read ${this.file}: ${String((e && e.message) || e)} — no tree record is in force, and the book will not be rewritten from it`);
      }
    }
    this.cached = doc;
    this.stamp = stamp;
    this.at = now;
    return doc;
  }

  get(tree, { fresh = false } = {}) {
    const key = normKey(tree);
    if (!key) return null;
    const rec = this.doc({ fresh }).trees[key] || null;
    return rec ? { ...rec } : null;
  }

  // Write one tree's record, and return it ONLY when the write happened. `trees` is rewritten whole from the
  // loaded document, so a book that could not be read is the one book this must never write: the empty book `doc()`
  // produced is a guess, and writing it back would delete every other tree's record and silently reset every live
  // tree to `local`. A failed read, a failed write and a full disk all return `null`; the caller (the switching
  // route) turns that into a refusal instead of telling a card the change was stored.
  //
  // Written through `<file>.tmp` and renamed into place: `writeFileSync` truncates before it writes, so a panel
  // killed mid-write used to leave a truncated book for the next `set` to replace with a single record.
  set(tree, pipeline) {
    const key = normKey(tree);
    if (!key || !pipeline) return null;
    const doc = this.doc({ fresh: true });
    if (!doc.loaded) {
      this.log(`pipelines: refusing to write ${this.file} for ${tree} — the book could not be read, and rewriting it now would replace every other tree's record with an empty one`);
      return null;
    }
    const next = { ...doc, trees: { ...doc.trees, [key]: pipeline } };
    if (this.file) {
      const tmp = `${this.file}.tmp`;
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify({ version: 1, trees: next.trees }, null, 2)}\n`, "utf8");
        renameSync(tmp, this.file);
      } catch (e) {
        try {
          unlinkSync(tmp);
        } catch {
          /* the failed write's own leftovers, if any; the real error is the one reported */
        }
        this.log(`pipelines: could not write ${this.file}: ${String((e && e.message) || e)} — the record for ${tree} is not durable and nothing was changed`);
        return null;
      }
    }
    this.cached = next;
    this.stamp = this.stampOf();
    this.at = Date.now();
    return pipeline;
  }

  state() {
    return { file: this.file ? path.resolve(this.file) : null, trees: this.doc().trees };
  }
}

// The switching route's whole write, in one place: a ladder-approved change is stored, or the answer says why it was
// not. `turnStart` is the route's gate and is false until §4.1's turn start exists — the ladder only climbs, so a rung
// written with no run behind it is spent forever. A failed write is a 500 and no record: a 200 here would tell the
// board a tree is a turnover while a restart reads it back as local. Kept beside the record it writes so a test can
// drive the exact step the route takes, including the write that fails.
export function storeSwitch(records, tree, pipeline, { turnStart = false } = {}) {
  if (!turnStart) return { status: 501, code: "no-turn-start", pipeline: null };
  let stored = null;
  try {
    stored = records && typeof records.set === "function" ? records.set(tree, pipeline) : null;
  } catch {
    stored = null; // `set` reports a failed write by returning null; a throw is the same answer, never a record
  }
  return stored ? { status: 200, code: null, pipeline: stored } : { status: 500, code: "not-durable", pipeline: null };
}

// ---- the catalogue, as the server hands it around ---------------------------------------------------------------
export class Pipelines {
  constructor({ file = null, seedFile = DEFAULT_SEED_FILE, ttlMs = 1500, log = () => {} } = {}) {
    this.file = file;
    this.seedFile = seedFile;
    this.ttlMs = ttlMs;
    this.log = log;
    this.cached = null;
    this.at = 0;
  }

  doc({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.cached && now - this.at < this.ttlMs) return this.cached;
    this.cached = pipelinesDoc({ file: this.file, seedFile: this.seedFile, now, ttlMs: this.ttlMs });
    this.at = now;
    return this.cached;
  }

  get(id) {
    return this.doc().pipelines[clean(id)] || null;
  }

  list() {
    return Object.values(this.doc().pipelines);
  }

  // What a project's two defaults resolve to, with the reasons the card would show.
  defaultsFor(project, config = {}) {
    return defaultsForProject(project, { catalogue: this, config });
  }

  ensure() {
    return ensurePipelinesFile({ file: this.file, seedFile: this.seedFile, log: this.log });
  }

  // What /api/state (or a settings header) carries: the ids and their titles, where the files are, and every reason
  // a definition is missing. The stage details are not here — the tab reads the whole definition from `pipelines[id]`.
  state() {
    const doc = this.doc();
    return {
      file: doc.file,
      seedFile: doc.seedFile,
      version: doc.version,
      supported: PIPELINES_VERSION,
      readOnly: doc.readOnly,
      refused: doc.refused,
      warnings: doc.warnings,
      dropped: doc.dropped,
      pipelines: Object.fromEntries(
        Object.entries(doc.pipelines).map(([id, def]) => [id, { id, kind: clean(def.kind), title: clean(def.title), description: clean(def.description), stages: (def.stages || []).map((s) => clean(s.id)), next: def.next || null }]),
      ),
    };
  }
}
