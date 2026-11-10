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

// Validate a WHOLE document — the shape pipelines.json carries. Every definition is validated by validatePipeline,
// and the cross-reference rule (`next`) runs against the definitions that are themselves valid, so one bad
// definition cannot make a good one look broken. The errors are validatePipeline's own sentences, unaltered, in
// document order: the route hands them back exactly as they are so the tab can show each one beside its field.
export function validatePipelinesDocument(doc) {
  if (!isObject(doc)) return { errors: ["a pipeline document must be a JSON object"] };
  const errors = [];
  const seen = new Set();
  const built = {};
  const records = [];
  if (Array.isArray(doc.pipelines)) {
    doc.pipelines.forEach((rec, index) => records.push([clean(isObject(rec) ? rec.id : ""), rec, index]));
  } else if (isObject(doc.pipelines)) {
    for (const [id, rec] of Object.entries(doc.pipelines)) records.push([clean(id), rec, null]);
  } else {
    errors.push("a pipelines document needs a `pipelines` list or object");
    return { errors };
  }
  for (const [id, rec, index] of records) {
    const name = id || `#${(index ?? 0) + 1}`;
    if (seen.has(name)) {
      errors.push(`pipeline "${name}": a second definition with the id "${name}" — the first one is in force`);
      continue;
    }
    seen.add(name);
    const found = validatePipeline(id, rec);
    if (found.length) {
      errors.push(...found);
      continue;
    }
    built[name] = { ...rec, id: name };
  }
  for (const [id, def] of Object.entries(built)) {
    const found = validatePipeline(id, def, { catalogue: built });
    if (found.length) errors.push(...found);
  }
  return { errors };
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

// ---- §6: the wait mechanic that must not be a sleeping worker ---------------------------------------------------
// A stage whose exit is the REVIEWER's answer cannot end when its turn ends: the answer may take a day, and the run's
// hard cap (`jobMaxRuntimeSeconds`) would turn a healthy wait into a failed card. So the turn ends and the PANEL
// waits: a record on the tree (`pipelineWait`), one ticker that asks which records are due, one host read per due
// record, and a wake on the same thread when there is something to answer. Nothing here sleeps, polls in a loop or
// holds a run slot — every function below is pure and takes `now`, so a test drives an hour of waiting in no time.

// The three exits that are the reviewer's to answer. `pr-comments` is the wait stage's own (an activity newer than
// `lastSeen`), `pr-approved` is the approval at the head, and `reviewers-exact` is the reviewer set the PR must
// carry. A stage exiting on anything else is the worker's own progress and never registers a wait: `pr-merged` on a
// merge stage is not a reviewer's answer, and a wait on it would wake a thread to do what the worker already did.
export const REVIEW_WAIT_CHECKS = ["pr-comments", "pr-approved", "reviewers-exact"];

// 1h → 2h → 4h, capped. hosts.seed.json's own advice (poll a Bitbucket PR hourly, not more often) is the floor.
export const WAIT_FIRST_MS = 60 * 60 * 1000;
export const WAIT_MAX_MS = 4 * 60 * 60 * 1000;
// A silence this long gets ONE status wake, so a quiet card does not read as dead and the reader can decide.
export const QUIET_WAKE_AFTER_MS = 6 * 60 * 60 * 1000;
// A claim older than this, with no run behind it, is reclaimed: a crash between the claim and the wake is the one
// failure this has to survive, and the alternative is a tree nobody ever wakes again.
export const WAIT_CLAIM_GRACE_MS = 10 * 60 * 1000;

// ---- the SECOND kind of wait: the stage's own RUN ----------------------------------------------------------------
// The reviewer's wait above is one thing a stage can be waiting on; the other is the stage's own worker. A pipeline row
// whose stage has a live run is held in the same book, keyed to that run (`{kind: "run", stage, job, thread}`), so the
// row's condition is a durable fact instead of an inference, and the panel — not a parked row and not a helpful
// assistant — reads the settle and advances the stage. The wait's clock is the run's own status: a run wait is due
// whenever the sweep asks, and the answer is one job-store read, not a host call.
export const RUN_WAIT_KIND = "run";
export const REVIEW_WAIT_KIND = "review";

// How long the book keeps FIRST REFUSAL on the advance once the run it holds has settled. The panel's ticker is a
// minute; three of them is enough for a live timer to be the owner, and after that the driver's own pass advances the
// row — a ticker that died must not leave a settled row waiting for a clock nobody restarts.
export const HOLD_OWNER_MS = 3 * 60 * 1000;

// `run`, `review`, or null. A wait written before the kinds existed is the reviewer's: every wait the panel could
// write then was one, and reading it as anything else would change a record's meaning by re-reading it.
export function waitKind(wait) {
  const kind = clean(wait && wait.kind);
  if (kind === RUN_WAIT_KIND || kind === REVIEW_WAIT_KIND) return kind;
  if (!isObject(wait)) return null;
  return clean(wait.check) || clean(wait.stage) ? REVIEW_WAIT_KIND : null;
}

export function isRunWait(wait) {
  return waitKind(wait) === RUN_WAIT_KIND;
}

// The hold a pipeline stage's CUT writes: the row's stage, and the run that is working it. `job` and `thread` are both
// kept because the panel can be restarted between the cut and the sweep: the card is the live answer, the thread is
// the one the row's current turn is on, and a hold that names neither is not a hold (there is nothing to wait on).
export function stageRunWaitFor(stage, { pipeline = null, visit = null, thread = null, job = null, branch = null, at = new Date().toISOString() } = {}) {
  const id = clean(stage);
  if (!id) return null;
  const heldJob = clean(job) || null;
  const heldThread = clean(thread) || null;
  if (!heldJob && !heldThread) return null;
  const n = Number(visit);
  return {
    kind: RUN_WAIT_KIND,
    stage: id,
    pipeline: clean(pipeline) || null,
    visit: Number.isInteger(n) && n > 0 ? n : null,
    job: heldJob,
    thread: heldThread,
    branch: clean(branch) || null,
    at,
    since: at,
    // Stamped by the settle, not by the cut: the driver's fallback measures "the book has first refusal" from the
    // moment the run ended, and a stage that ran for two hours would otherwise be an ownerless row before it settled.
    settledAt: null,
    claimedAt: null,
  };
}

// The stamp the book's first refusal runs from: the settle when the run has ended, the cut when it has not.
export function holdOwnerFrom(wait) {
  const stamp = msOfStamp(wait && (wait.settledAt || wait.at));
  return stamp == null ? null : stamp + HOLD_OWNER_MS;
}

const stampOfMs = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const msOfStamp = (value) => {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
};

// Is this stage's exit the reviewer's answer? The seed of a `pipelineWait`, or null for a stage that ends on its own
// work. `thread` is stored WITH the wait because the wake is a turn on the same thread, and the job store keeps only
// 80 conversations — a review loop outlives the card that started it, and a wait that cannot name its thread is a
// wait whose wake has nowhere to go.
//
// TWO DOCUMENTS, ONE FACT. A ladder definition states the review exit on the STAGE (`stage.exit.check`); a PDL document
// states it on the GATE after the stage (`verified_by`), because a PDL stage declares an artifact, not an exit. Both
// name the same closed vocabulary, and both are read through `reviewExitOf`, so a tree record's rung and a queue
// row's PDL document register the SAME wait, take the SAME rail edge (lib/task-pipeline-drive.js `edgeOutOf`) and pay
// the SAME cap. A stage whose document names neither registers nothing: the panel does not infer a reviewer from the
// stage's title.
export function reviewWaitFor(stage, { at = new Date().toISOString(), lastSeen = null, thread = null, branch = null, pipeline = null, gate = null } = {}) {
  const exit = reviewExitOf(stage, gate);
  const check = clean(exit && exit.check);
  if (!REVIEW_WAIT_CHECKS.includes(check)) return null;
  const pipelineId = clean(isObject(pipeline) ? pipeline.id : pipeline);
  const gateId = clean(gate && gate.id);
  return {
    stage: clean(stage.id) || null,
    check,
    who: check === "reviewers-exact" && Array.isArray(exit.who) ? exit.who.map((w) => clean(w)).filter(Boolean) : [],
    // The document the stage was read from, when it is not the tree record's own rung. A PDL row's tree is cut
    // `local` and never moves, so the wait is the durable place that names the document its stage belongs to; a
    // ladder row leaves this absent and the record's `id` answers.
    ...(pipelineId ? { pipeline: pipelineId } : {}),
    ...(gateId ? { gate: gateId } : {}),
    thread: clean(thread) || null,
    // The branch the PR was opened from, stored with the wait: the host read an hour from now has no job record left
    // to ask (the ring keeps 80 conversations) and no git call to pay for, and a PR found by the wrong name is worse
    // than no PR at all.
    branch: clean(branch) || null,
    // `since` is when the wait BEGAN (the quiet-wake clock); `at` is the last check, and every past one moves it.
    since: at,
    at,
    every: WAIT_FIRST_MS,
    attempts: 0,
    lastSeen: clean(lastSeen) || null,
    quietWakeSent: false,
    claimedAt: null,
  };
}

// The gate that ends a PDL stage: `after` names the stage, and `verified_by` names the check that closes it. Only a
// gate naming one of the reviewer's three checks is the stage's review fact; a gate the document ROUTES
// (`decision.routes`) is the document's own two-outcome decision and is left to the verdict block, the same rule
// `reviewEdgeOutOf` applies on the rail.
export function reviewGateFor(pipeline, stageId) {
  const at = clean(stageId);
  if (!at) return null;
  const gates = pipeline && Array.isArray(pipeline.gates) ? pipeline.gates : [];
  return (
    gates.find(
      (gate) =>
        clean(gate && gate.after) === at &&
        REVIEW_WAIT_CHECKS.includes(clean(gate && (gate.verifiedBy || gate.verified_by))) &&
        !isObject(gate.decision && gate.decision.routes),
    ) || null
  );
}

// The review fact itself: the stage's own `exit` where the definition carries one, else the gate after it. One reader,
// so the wait's registration (`lib/jobs.js` `registerPipelineWait`) and its re-check (`readReviewExit`) cannot read two
// different checks out of one stage.
export function reviewExitOf(stage, gate = null) {
  const exit = isObject(stage) ? stage.exit : null;
  if (isObject(exit) && REVIEW_WAIT_CHECKS.includes(clean(exit.check))) return exit;
  const check = clean(gate && (gate.verifiedBy || gate.verified_by));
  if (REVIEW_WAIT_CHECKS.includes(check)) return { check, who: Array.isArray(gate.who) ? gate.who.map((w) => clean(w)).filter(Boolean) : [] };
  return null;
}

// When the record is next due: its last check plus its own interval. A record that cannot answer is due now rather
// than never — a wait nobody re-checks is the sleeping worker this whole section replaces.
export function waitDueAt(wait) {
  const at = msOfStamp(wait?.at);
  const every = Number(wait?.every);
  if (at == null) return null;
  return at + (Number.isFinite(every) && every > 0 ? every : WAIT_FIRST_MS);
}

export function waitIsDue(wait, { now = Date.now() } = {}) {
  // A run hold's clock is the run, not the calendar: the sweep asks the job store, and a hold is always worth that one
  // read. A tick that finds the card still live is a sentence in the summary, not a wake and not a host call.
  if (isRunWait(wait)) return true;
  const due = waitDueAt(wait);
  return due == null ? false : now >= due;
}

// Claim a due record before a wake is started, the way `terminalClaim` stops a second settle wake. Two panels, two
// ticks in the same second and a restart between the read and the run all meet here: the second claim is refused
// with the sentence the card would show, and a claim nobody acted on expires on its own.
export function claimWait(wait, { now = Date.now() } = {}) {
  if (!isObject(wait)) return { ok: false, why: "there is no wait record to claim", wait: null };
  const claimed = msOfStamp(wait.claimedAt);
  if (claimed != null && now - claimed < WAIT_CLAIM_GRACE_MS) {
    return {
      ok: false,
      why: `this wait was claimed at ${new Date(claimed).toISOString()} and that claim is under ${Math.round(WAIT_CLAIM_GRACE_MS / 60000)} minutes old — a second tick, a second panel or a restart cannot wake the same thread twice`,
      wait,
    };
  }
  return { ok: true, why: "", wait: { ...wait, claimedAt: stampOfMs(now) } };
}

// What the PR says, against one exit check. Fail-closed in the document's own rule: a host that is down, a token that
// is missing and a PR that cannot be found all answer "cannot tell", and the stage STAYS where it is. `advanced` is
// the exit; `closed` is the PR ending without answering (merged or closed), which ends the wait quietly rather than
// backing off forever against a PR nobody will comment on again.
export function readReviewExit(exit, observation, { lastSeen = null } = {}) {
  const check = clean(exit && exit.check);
  if (!REVIEW_WAIT_CHECKS.includes(check)) {
    return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: `${JSON.stringify(exit?.check)} is not a review exit` };
  }
  if (!isObject(observation) || observation.ok !== true || !isObject(observation.pr)) {
    const why = clean(observation?.why) || "the pull request could not be read";
    return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: `${why} — a check that cannot be read does not exit the stage` };
  }
  const pr = observation.pr;
  const state = clean(pr.state).toUpperCase();
  if (state === "MERGED") return { ok: true, advanced: false, closed: "merged", cannotTell: false, seen: null, why: "the pull request is MERGED — there is nothing left for a reviewer to answer" };
  if (state === "DECLINED" || state === "CLOSED") {
    return { ok: true, advanced: false, closed: "declined", cannotTell: false, seen: null, why: `the pull request is ${state} — a reviewer's answer cannot arrive on it` };
  }

  if (check === "pr-comments") {
    if (!Array.isArray(pr.comments)) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the host answered without a comments list, so nothing can be newer than lastSeen" };
    // The `lastSeen` the check reads is the WAIT record's (the moment the stage last read the PR), and the exit's own
    // parameter only when the record carries none: the seed's wait stage states `pr-comments` and nothing else, and a
    // stage that must restate its own clock in the definition would be a second place to keep it wrong.
    const seenFrom = msOfStamp(lastSeen != null && String(lastSeen).trim() ? lastSeen : exit.lastSeen);
    let newest = null;
    let at = null;
    for (const c of pr.comments) {
      const ms = msOfStamp(c && c.at);
      if (ms == null) continue;
      if (newest == null || ms > newest) {
        newest = ms;
        at = c.at;
      }
    }
    if (newest == null) return { ok: true, advanced: false, closed: null, cannotTell: false, seen: null, why: "no comment carries a timestamp yet" };
    // A `lastSeen` that is absent or unreadable is not a licence to call every comment new: the stage's own entry
    // stamp is the fallback, and with neither the answer is "cannot tell".
    if (seenFrom == null) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: at, why: "the stage has no readable lastSeen, so \"newer than lastSeen\" cannot be answered" };
    if (newest > seenFrom) return { ok: true, advanced: true, closed: null, cannotTell: false, seen: at, why: `a comment arrived at ${at}, after ${new Date(seenFrom).toISOString()}` };
    return { ok: true, advanced: false, closed: null, cannotTell: false, seen: at, why: `nothing newer than ${new Date(seenFrom).toISOString()}` };
  }

  if (check === "pr-approved") {
    const head = clean(pr.headRefOid);
    if (!head) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the host answered without the PR's head commit, so \"approved at this head\" cannot be answered" };
    if (!Array.isArray(pr.approvals)) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the host answered without an approvals list" };
    for (const a of pr.approvals) {
      if (clean(a && a.commit) !== head) continue;
      return { ok: true, advanced: true, closed: null, cannotTell: false, seen: clean(a.at) || null, why: `${clean(a.by) || "a reviewer"} approved ${head.slice(0, 8)}` };
    }
    return { ok: true, advanced: false, closed: null, cannotTell: false, seen: null, why: `no approval of the head ${head.slice(0, 8)} yet` };
  }

  // reviewers-exact: the reviewer set equals `who`, no more and no fewer (§1.3).
  if (!Array.isArray(pr.reviewers)) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the host answered without a reviewer list" };
  const who = Array.isArray(exit.who) ? exit.who.map((w) => clean(w).toLowerCase()).filter(Boolean).sort() : [];
  const got = pr.reviewers.map((r) => clean(r && typeof r === "object" ? r.name || r.displayName : r).toLowerCase()).filter(Boolean).sort();
  if (!who.length) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the stage's exit names no reviewers, so a set cannot be compared" };
  const advanced = who.length === got.length && who.every((w, i) => w === got[i]);
  return {
    ok: true,
    advanced,
    closed: null,
    cannotTell: false,
    seen: null,
    why: advanced ? `the reviewer set is exactly [${who.join(", ")}]` : `the reviewer set is [${got.join(", ")}], not exactly [${who.join(", ")}]`,
  };
}

// What the next wait is, or the advance. The document's clock: nothing arrived → `attempts` climbs and `every`
// doubles (capped at 4h); a long silence → one status wake, THEN the same backoff (not a heartbeat); the PR ended →
// the wait is closed; the exit matched → the wait is gone and the stage advances.
export function settleWait(wait, { now = Date.now(), outcome = null } = {}) {
  const at = stampOfMs(now);
  if (!isObject(wait) || !isObject(outcome)) return { ok: false, advance: false, quiet: false, wait: null, why: "settleWait needs a wait record and the read's outcome" };
  if (outcome.closed) return { ok: true, advance: false, quiet: false, wait: null, why: clean(outcome.why) || `the wait is closed (${outcome.closed})` };
  if (outcome.advanced) return { ok: true, advance: true, quiet: false, wait: null, why: clean(outcome.why) || "the exit matched" };
  const every = Math.min(WAIT_MAX_MS, Math.max(WAIT_FIRST_MS, Number(wait.every) || WAIT_FIRST_MS) * 2);
  const since = msOfStamp(wait.since) ?? msOfStamp(wait.at) ?? now;
  const quiet = !wait.quietWakeSent && now - since >= QUIET_WAKE_AFTER_MS;
  return {
    ok: true,
    advance: false,
    quiet,
    wait: {
      ...wait,
      at,
      every,
      attempts: (Number(wait.attempts) || 0) + 1,
      lastSeen: clean(outcome.seen) || clean(wait.lastSeen) || null,
      claimedAt: null,
      quietWakeSent: Boolean(wait.quietWakeSent) || quiet,
    },
    why: clean(outcome.why),
  };
}

// A stage's prompt, with the closed set of holes filled — or a refusal naming the hole that was empty. §1.4: a
// placeholder that resolves to nothing refuses to START the stage, because a prompt handed over with `{{desc}}` still
// in it is the brief that produces a branch called `_`. The unknown-hole case is refused too, even though a saved
// definition cannot carry one: this is also the renderer a hand-written file goes through.
export function renderPrompt(prompt, values = {}) {
  const text = String(prompt ?? "");
  const empty = [];
  const unknown = [];
  const out = text.replace(PLACEHOLDER_RE, (whole, name) => {
    if (!PROMPT_PLACEHOLDERS.includes(name)) {
      unknown.push(name);
      return whole;
    }
    const raw = values[name];
    const filled = typeof raw === "number" ? String(raw) : clean(raw);
    if (!filled) {
      empty.push(name);
      return whole;
    }
    return filled;
  });
  if (unknown.length) {
    return { ok: false, text: out, missing: [...new Set(unknown)], why: `the prompt uses {{${unknown[0]}}}, which is not one of the closed placeholders` };
  }
  if (empty.length) {
    return { ok: false, text: out, missing: [...new Set(empty)], why: `{{${empty[0]}}} resolved to nothing, so the stage cannot start` };
  }
  return { ok: true, text: out, missing: [], why: "" };
}

// ---- the host observations, normalised here so the decision above is testable without a network -------------------
// The PR's own state, its reviewers and what has arrived on it, in the one shape `readReviewExit` reads. Two hosts,
// two payloads, one observation: `{ok, pr: {number, state, headRefOid, reviewers, comments, approvals}}`. A payload
// this module does not recognise is a REFUSAL (`ok:false`), never an empty PR — an empty PR reads as "nothing has
// arrived" and would back a quiet reviewer off for hours on a response the panel simply could not parse.
export function observePullRequest({ number = null, state = null, headRefOid = null, reviewers = null, comments = null, approvals = null } = {}) {
  if (!clean(state)) return { ok: false, pr: null, why: "the host answered without the pull request's state" };
  return {
    ok: true,
    pr: {
      number: number == null ? null : number,
      state: clean(state).toUpperCase(),
      headRefOid: clean(headRefOid) || null,
      reviewers: Array.isArray(reviewers) ? reviewers : [],
      comments: Array.isArray(comments) ? comments : [],
      approvals: Array.isArray(approvals) ? approvals : [],
    },
    why: "",
  };
}

// `gh pr view <n> --json state,headRefOid,reviewRequests,reviews,comments`. A review counts as an approval only when
// its state says so AND it names the commit it reviewed — an approval at an older commit is not an approval of the
// head, which is the rule the wait stage exists for.
export function observeGithubPr(json, { number = null } = {}) {
  if (!isObject(json)) return { ok: false, pr: null, why: "the gh answer is not a JSON object" };
  const reviews = Array.isArray(json.reviews) ? json.reviews : [];
  const comments = [
    ...(Array.isArray(json.comments) ? json.comments : []).map((c) => ({ id: c?.id ?? null, at: c?.createdAt ?? null, author: c?.author?.login ?? null, kind: "comment" })),
    ...reviews.map((r) => ({ id: r?.id ?? null, at: r?.submittedAt ?? null, author: r?.author?.login ?? null, kind: "review" })),
  ].filter((c) => clean(c.at));
  const approvals = reviews
    .filter((r) => clean(r?.state).toUpperCase() === "APPROVED")
    .map((r) => ({ commit: clean(r?.commit?.oid) || null, at: clean(r?.submittedAt) || null, by: clean(r?.author?.login) || null }));
  // Who the PR was ASKED of: a requested reviewer who has not answered yet is still a reviewer the PR carries. A team
  // request is named by `slug`; the exit's `who` names the group, so both are carried.
  const reviewers = (Array.isArray(json.reviewRequests) ? json.reviewRequests : [])
    .map((r) => clean(r?.login) || clean(r?.slug) || clean(r?.name))
    .filter(Boolean);
  for (const r of reviews) {
    const name = clean(r?.author?.login);
    if (name && !reviewers.includes(name)) reviewers.push(name);
  }
  return observePullRequest({ number: json.number ?? number, state: json.state, headRefOid: json.headRefOid, reviewers, comments, approvals });
}

// Bitbucket Server: one PR record (`fromRef.latestCommit`, `reviewers[]` with `lastReviewedCommit`/`approved`) plus
// its activities page (`values[]` with `action`, `createdDate`, `comment`). The activities carry comment text and the
// review events; the approval's COMMIT comes from the reviewer record, which is the only place the host names it.
export function observeBitbucketPr(prRecord, activities) {
  if (!isObject(prRecord)) return { ok: false, pr: null, why: "the host answered without a pull request record" };
  const values = Array.isArray(activities?.values) ? activities.values : Array.isArray(activities) ? activities : null;
  if (!values) return { ok: false, pr: null, why: "the host answered without an activities page" };
  const reviewers = (Array.isArray(prRecord.reviewers) ? prRecord.reviewers : [])
    .map((r) => clean(r?.name) || clean(r?.displayName) || clean(r?.slug))
    .filter(Boolean);
  const approvals = (Array.isArray(prRecord.reviewers) ? prRecord.reviewers : [])
    .filter((r) => r && r.approved === true)
    .map((r) => ({ commit: clean(r.lastReviewedCommit) || null, at: clean(r.approvedAt) || null, by: clean(r.name) || clean(r.displayName) || null }));
  const comments = values
    .filter((a) => clean(a?.action).toUpperCase() === "COMMENTED" || (a?.comment && clean(a.action).toUpperCase() !== "DELETED"))
    .map((a) => ({ id: a?.comment?.id ?? a?.id ?? null, at: clean(a?.createdDate) || null, author: clean(a?.user?.name) || clean(a?.user?.displayName) || null, kind: "comment" }))
    .filter((c) => clean(c.at));
  return observePullRequest({
    number: prRecord.id ?? null,
    state: prRecord.state,
    headRefOid: prRecord.fromRef?.latestCommit ?? null,
    reviewers,
    comments,
    approvals,
  });
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

  // Write a whole document to the live file. The route validates it first; this is the write. Written through a
  // temporary file and renamed into place, the way the record book is, so a panel killed mid-write leaves the
  // previous catalogue intact rather than a truncated one. The cache is dropped so the next read is the new file.
  // A document's own `note` is kept when it has one; the version is always this code's, because a document naming
  // a newer one was refused whole before this was called.
  save(doc) {
    const target = this.file ? path.resolve(this.file) : null;
    if (!target) return { ok: false, error: "no pipelines.json to save to" };
    const body = {
      version: PIPELINES_VERSION,
      note: "Reader-edited pipeline definitions: what a worktree is for, stage by stage. Records here override pipelines.seed.json per id; docs/pipelines.md is the design. An invalid definition is dropped by id and named in the log; a file whose version is newer than this panel's is refused whole.",
      ...doc,
      version: PIPELINES_VERSION,
    };
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      renameSync(tmp, target);
      resetPipelinesCache();
      this.cached = null;
      this.at = 0;
      return { ok: true, file: target };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
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
