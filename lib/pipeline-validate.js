// PIPELINE VALIDATION: the closed vocabularies a definition is checked against, and the two validators that check it.
//
// Split out of `lib/pipelines.js`, which keeps the catalogue, the live file and the tree-keyed record. This half is
// pure: a definition or a whole document in, a list of sentences out - it reads no file, no git and no UI. Every name
// it publishes is re-exported by `lib/pipelines.js` under the name importers have always read it by, so no import site
// moved when validation did. `clean`, `isObject` and `PLACEHOLDER_RE` are exported here because the parent's own
// readers still call them; they were private before the cut and are NOT re-exported from the parent.

// The ladder, lowest first. `kind` is a rung, not a category label: each rung changes exactly one thing — whether a
// remote branch exists, and whether a human has to answer before main moves.
export const PIPELINE_KINDS = ["local", "investigation", "turnover"];
export const KIND_RANK = { local: 0, investigation: 1, turnover: 2 };

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
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const clean = (value) => String(value ?? "").trim();
export const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

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
