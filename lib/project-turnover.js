// A project's turnover branches: the branches its work rolls up into before anybody lands it, the policy that governs
// adding a new one, and the one key a feature may be filed under.
//
// WHERE IT LIVES. On the project's entry in `config.json`, beside `mainBranch` and the push controls. A project's
// entry is already the reader's record of what that project IS, and this is the same kind of fact: branch names one
// reader typed about one project, which have to survive a restart and travel with the file. lib/projects.js merges
// those entries onto the scanned repository by NAME, so the names written here are on the board record every reader
// downstream sees (the settings bar, the cut, the landing paragraph) without a second lookup.
//
// WHY IT EXISTS. A tree's parent used to be whichever branch the project's checkout happened to be standing on
// (`lib/jobs.js` startRefOf). For a repo whose checkout sits on master that is master, so every tree was briefed
// "push the branch and open a pull request" - which is how child branches of an unpublished turnover branch reached
// the shared remote. A project that names its turnover branch here is cut FROM that branch instead, and the worker is
// told to merge back into it locally.
//
// THE SHAPE, and both halves of it are deliberate:
//
//   turnoverBranches[]  the list, in the order the project uses it. Each entry is a branch name, or
//                       `{ branch, key }` when it belongs to one feature. `turnoverBranch`, the OLD single key, is
//                       read as one entry, so every config written before this list existed keeps working.
//   turnoverPolicy      free | ask | one-per-feature, default ask.
//                         free              a new turnover branch is added at once.
//                         ask               adding one parks on the panel's permission card.
//                         one-per-feature   the same, PLUS one branch per key: a second branch for a key that already
//                                           has one is refused by name and the existing branch is offered instead.
//
// READING IS FORGIVING (the panel must still boot on a hand-edited file: a number, an object, a duplicate, a bare
// `refs/heads/` prefix and a trailing slash all read as the name they mean, or are dropped); WRITING IS STRICT
// (`validateTurnoverBranches` refuses a name git cannot carry, a duplicate, and a key that cannot be a key), because a
// save that silently changes what the reader typed is a lie about what was stored.
//
// THE KEY is the task or initiative id a cut names (`turnoverKey`). It is the one-per-feature join: a cut for
// `task 186` asks `turnoverLookup` for that key's branch first, so two cuts for one feature cannot quietly start from
// two different turnover branches.
//
// This file is pure: no git, no config write, no server. The write itself is `setProjectTurnover` in the composition
// root, and the wire shape is routes/project-turnover.js.

import { BASE_REF_KINDS, baseRefKindFrom, validateBaseRefKind } from "./base-ref-kind.js";

/** How long a branch name may be, after whitespace collapses. Git's own limit is far higher; this is a settings field. */
export const TURNOVER_MAX_CHARS = 120;

/** How long a feature key may be. A task id, an initiative id, or a short human key - not a paragraph. */
export const TURNOVER_KEY_MAX_CHARS = 120;

/** Names that are a project's destination, never its turnover branch. The same set lib/parents.js refuses. */
export const LANDING_NAMES = ["main", "master", "trunk", "develop"];

// The three policies, in the order the settings field draws them, and the words the page uses for each.
export const TURNOVER_POLICIES = ["free", "ask", "one-per-feature"];
export const DEFAULT_TURNOVER_POLICY = "ask";

export const TURNOVER_POLICY_INFO = [
  { id: "free", label: "free - add a turnover branch without asking" },
  { id: "ask", label: "ask - a new turnover branch waits for your answer" },
  { id: "one-per-feature", label: "one per feature - ask, and refuse a second branch for the same key" },
];

const collapse = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();

// A ref name git can carry: no spaces, no `~^:?*[\`, no `..`, no leading/trailing slash, no `.lock` tail, no `@{`.
// Deliberately a refusal list rather than a full re-implementation of `git check-ref-format`: the panel asks this
// before a write, and git refuses the rest at the cut with its own sentence.
const BAD_REF = /[\s~^:?*[\]\\]|\.\.|\/\/|^\/|\/$|\.lock$|@\{|^-/;

/** The READ side: whatever the file holds, answered as a branch name or "". */
export function turnoverBranchFrom(value) {
  if (typeof value !== "string") return "";
  const text = collapse(value).replace(/^refs\/heads\//i, "").replace(/\/+$/, "");
  if (!text || text === "HEAD") return "";
  return text.slice(0, TURNOVER_MAX_CHARS);
}

/** The WRITE side: the name a POST asked to store, or the reason it cannot be stored. */
export function validateTurnoverBranch(value) {
  // Clearing is a real answer: a project that has stopped using a turnover branch sends "" (or null) and the key goes.
  if (value === null || value === undefined) return { branch: "" };
  if (typeof value !== "string") return { error: "turnoverBranch must be a branch name, or \"\" to clear it" };
  const text = collapse(value).replace(/^refs\/heads\//i, "");
  if (!text) return { branch: "" };
  if (text.length > TURNOVER_MAX_CHARS) {
    return { error: `the turnover branch name is ${text.length} characters - the cap is ${TURNOVER_MAX_CHARS}` };
  }
  if (text === "HEAD") return { error: "HEAD is not a branch - name the branch its work rolls up into" };
  if (LANDING_NAMES.includes(text.toLowerCase())) {
    return { error: `${text} is a landing branch, not a turnover branch - a turnover branch is where a tree's work rolls up before it lands` };
  }
  if (BAD_REF.test(text) || text.includes(" ")) {
    return { error: `\`${text}\` is not a branch name git can carry (no spaces, no ~^:?*[\\ , no .lock tail)` };
  }
  if (text === "." || text.endsWith(".")) return { error: `\`${text}\` is not a branch name git can carry` };
  return { branch: text };
}

/** A key as the one-per-feature rule reads it: one line, capped, or "". A task id and an initiative id are strings. */
export function turnoverKeyFrom(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  return collapse(value).slice(0, TURNOVER_KEY_MAX_CHARS);
}

// One entry, read forgivingly: a bare string is a branch; an object with a `branch` carries its key when it has one.
function entryFrom(value) {
  if (typeof value === "string") {
    const branch = turnoverBranchFrom(value);
    return branch ? { branch, key: null } : null;
  }
  if (value && typeof value === "object" && typeof value.branch === "string") {
    const branch = turnoverBranchFrom(value.branch);
    if (!branch) return null;
    const key = turnoverKeyFrom(value.key);
    return { branch, key: key || null };
  }
  return null;
}

// A list read forgivingly: anything that is not an array is one entry, duplicates are dropped (the first spelling
// wins), and an entry that cannot be a branch is skipped rather than dropping the whole project record.
function entriesFrom(value) {
  const raw = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const entry = entryFrom(item);
    if (!entry) continue;
    const key = entry.branch.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** The project's branches, in order: the list first, then the old single key when it is not already one of them. */
export function turnoverBranchesOf(project) {
  const list = entriesFrom(project?.turnoverBranches);
  const single = turnoverBranchFrom(project?.turnoverBranch);
  if (single && !list.some((entry) => entry.branch.toLowerCase() === single.toLowerCase())) {
    list.push({ branch: single, key: null });
  }
  return list;
}

/** The project's primary turnover branch: the first entry, or "" when it has none. */
export function turnoverBranchOf(project) {
  return turnoverBranchesOf(project)[0]?.branch || "";
}

/** The branch filed under one feature key, or "" when the project has none for that key. */
export function turnoverBranchForKey(project, key) {
  const wanted = turnoverKeyFrom(key).toLowerCase();
  if (!wanted) return "";
  return turnoverBranchesOf(project).find((entry) => entry.key && entry.key.toLowerCase() === wanted)?.branch || "";
}

// ---- the feature container's own branch: its name, and the policy that decides whether a cut makes one ----
//
// A turnover branch is the name of one FEATURE'S CONTAINER (lib/branch-kind.js). A cut that needs one - an
// implementation asked for with a main parent, and the auto-cut that stands behind it - asks `planTurnoverCut`:
//
//   reuse    the project already files a branch under this task or initiative key. The cut uses it; nothing is
//            created, nothing is asked, and a second cut for one feature cannot start from a second branch.
//   cut      no branch for this key, and `free`: the branch is made at once.
//   ask      no branch for this key, and `ask` or `one-per-feature`: the branch creation is the reader's answer on
//            the panel's permission card. `one-per-feature` with a key that already has a branch was answered above.
//
// The NAME is derived, never typed by the reader: `YYYYMMDD_HHMM_<TICKET>_<slug>`, the shape `isTurnoverBranchName`
// (and the push gate) recognises. The ticket half comes from the key - `task 186` is `TASK-186`, `dmr-44001` is
// `DMR-44001` - and a key with no number of its own gets a stable six-digit one, so the same feature keeps the same
// ticket segment and the name stays legal. Pure: no git, no clock of its own (the caller passes `at`).

/** How long the derived branch name's slug may be. */
export const TURNOVER_SLUG_MAX = 24;

// The ticket half the turnover shape requires: letters, a dash, digits.
const TICKET_SHAPE = /^[A-Z][A-Z0-9]+-[0-9]+$/;

// A stable number for a key that carries none, so a derived branch name is legal and the same feature keeps the same
// ticket segment. FNV-1a, six digits: the value is a label, not a security primitive.
function keyNumber(key) {
  let h = 2166136261;
  for (const ch of String(key)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000000;
}

/** The ticket segment of a derived turnover branch: `TASK-186`, `DMR-44001`, or `KEY-<six digits>` for a key with no number. */
export function turnoverTicketFrom(value) {
  const key = turnoverKeyFrom(value);
  const direct = key.replace(/\s+/g, "-").toUpperCase();
  if (TICKET_SHAPE.test(direct)) return direct;
  const words = key.toUpperCase().match(/[A-Z][A-Z0-9]*/g) || [];
  const digits = key.match(/[0-9]+/g) || [];
  if (words.length && digits.length) {
    const word = words[words.length - 1];
    if (/^[A-Z][A-Z0-9]+$/.test(word)) return `${word}-${Number(digits[digits.length - 1])}`;
  }
  return `KEY-${keyNumber(key || "work")}`;
}

/** The slug half: the cut's own words, lowercased to something the turnover shape carries. */
export function turnoverSlugFrom(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .replace(/[-._]{2,}/g, "-")
    .slice(0, TURNOVER_SLUG_MAX)
    .replace(/[-._]+$/, "");
  return slug || "work";
}

/** The branch a feature's container is created on, from its key, its words and the moment of the cut. */
export function turnoverNameFor({ key = "", name = "", at = new Date() } = {}) {
  const when = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}_${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `${stamp}_${turnoverTicketFrom(key)}_${turnoverSlugFrom(name || key)}`;
}

/**
 * THE DECISION a cut makes about its feature's container. `{ ok, action: reuse | cut | ask, branch, key, policy }`,
 * or `{ ok: false, code, error }` when a LANDING cut names no key at all.
 *
 * `landing` is the reader's decision of 2026-11-28: a landing task - the kind lib/branch-kind.js infers from a brief
 * that names code or a landing verb - gets its own turnover branch automatically, keyed to its task id, with NO ask.
 * A small task must never stall on a permission card, and a landing cut that names no key is refused by name with the
 * remedy rather than falling back to the checkout (which is the implementation-at-root shape the decision removes).
 * The policy still governs a MANUAL add of a branch (routes/project-turnover.js `planTurnoverSave`); it no longer parks
 * the cut itself.
 *
 * Never a silent creation under a policy that asks for a NON-landing caller: the caller cuts on `cut`, cuts on `reuse`,
 * and parks the panel's card on `ask` (the answer runs the creation and the cut it was asked about).
 */
export const LANDING_CUT_NO_KEY = "landing-no-key";

export function planTurnoverCut({ project = null, key = "", name = "", at = new Date(), landing = false } = {}) {
  const wanted = turnoverKeyFrom(key);
  const policy = turnoverPolicyOf(project);
  const existing = wanted ? turnoverBranchForKey(project, wanted) : "";
  if (existing) {
    return {
      ok: true,
      action: "reuse",
      branch: existing,
      key: wanted,
      policy,
      existing: true,
      landing: Boolean(landing),
      why: `${wanted} already has \`${existing}\` - the cut uses that branch`,
    };
  }
  if (landing && !wanted) {
    return {
      ok: false,
      action: "refuse",
      code: LANDING_CUT_NO_KEY,
      branch: null,
      key: null,
      policy,
      existing: false,
      landing: true,
      error:
        "a landing cut names no task id, so the panel cannot name the turnover branch the work rolls up into - " +
        "write the SPAWN against a queue row (`SPAWN #<id> <project>`) or name the feature with `turnoverKey`; " +
        "implementation never stands at the repository root",
    };
  }
  const branch = turnoverNameFor({ key: wanted, name, at });
  if (landing) {
    return {
      ok: true,
      action: "cut",
      branch,
      key: wanted,
      policy,
      existing: false,
      landing: true,
      automatic: true,
      why: `a landing cut creates its own turnover branch under ${wanted} - no ask, so the task never stalls`,
    };
  }
  if (policy === "free") {
    return { ok: true, action: "cut", branch, key: wanted || null, policy, existing: false, why: `free - a turnover branch for this feature is made at once` };
  }
  return {
    ok: true,
    action: "ask",
    branch,
    key: wanted || null,
    policy,
    existing: false,
    why:
      policy === "one-per-feature" && !wanted
        ? "one per feature needs a task or initiative key, so the branch creation waits for your answer"
        : `${policy} - a new turnover branch waits for your answer`,
  };
}

/** True when this project has declared at least one turnover branch. */
export function hasTurnoverBranch(project) {
  return Boolean(turnoverBranchOf(project));
}

/** The project's turnover policy, forgivingly read. An absent or unreadable value is `ask`. */
export function turnoverPolicyFrom(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return TURNOVER_POLICIES.includes(id) ? id : DEFAULT_TURNOVER_POLICY;
}

/** The project record's policy, whichever shape the record has. */
export function turnoverPolicyOf(project) {
  return turnoverPolicyFrom(project?.turnoverPolicy);
}

/** The policy's row for the page: the id, its label, and what the panel then does. */
export function turnoverPolicyInfo(value) {
  const id = turnoverPolicyFrom(value);
  return TURNOVER_POLICY_INFO.find((row) => row.id === id) || TURNOVER_POLICY_INFO[1];
}

/**
 * THE WRITE side of the list. An array of branch names or `{ branch, key }` objects, answered as the entries to store
 * or the reason they cannot be: every branch must be one git can carry (the same rule a single save obeys), two
 * entries must not name the same branch, and a key must be one line. `null` and `[]` clear the list.
 */
export function validateTurnoverBranches(value) {
  if (value === null || value === undefined) return { entries: [] };
  if (!Array.isArray(value)) return { error: "turnoverBranches must be an array of branch names, or [] to clear it" };
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (typeof item.branch !== "string") return { error: "each turnoverBranches entry must be a branch name or { branch, key }" };
      const checked = validateTurnoverBranch(item.branch);
      if (checked.error) return { error: checked.error };
      if (!checked.branch) return { error: "a turnoverBranches entry cannot be empty - remove it to clear a branch" };
      const key = turnoverKeyFrom(item.key);
      if (item.key !== undefined && item.key !== null && !key) return { error: "a turnoverBranches key must be a task or initiative id, one line" };
      const lower = checked.branch.toLowerCase();
      if (seen.has(lower)) return { error: `${checked.branch} is named twice in turnoverBranches - one entry per branch` };
      seen.add(lower);
      out.push(key ? { branch: checked.branch, key } : { branch: checked.branch });
      continue;
    }
    if (typeof item !== "string") return { error: "each turnoverBranches entry must be a branch name or { branch, key }" };
    const checked = validateTurnoverBranch(item);
    if (checked.error) return { error: checked.error };
    if (!checked.branch) return { error: "a turnoverBranches entry cannot be empty - remove it to clear a branch" };
    const lower = checked.branch.toLowerCase();
    if (seen.has(lower)) return { error: `${checked.branch} is named twice in turnoverBranches - one entry per branch` };
    seen.add(lower);
    out.push({ branch: checked.branch });
  }
  return { entries: out };
}

/**
 * THE POLICY DECISION for adding branches to a project. `entries` is the list a save asks for, `key` the task or
 * initiative id the cut named (an entry may carry its own key instead).
 *
 *   { ok: true, ask: false, added: [] }          nothing new: apply the save at once
 *   { ok: true, ask: false, added }              a new branch under `free`
 *   { ok: true, ask: true, added }               a new branch under `ask` or `one-per-feature`: park the card
 *   { ok: false, refused: "one-per-feature", ... }  a second branch for a key that already has one
 *
 * The refusal names the key and OFFERS the existing branch, because the reader's alternative is to use the branch
 * they already have, and a refusal that only says "no" leaves them hunting it. Only ADDED branches are judged: editing
 * the list, removing an entry or changing the policy is not a creation and never asks.
 */
export function planTurnoverSave({ project = null, entries = [], key = "" } = {}) {
  const existing = turnoverBranchesOf(project);
  const next = entriesFrom(entries);
  const policy = turnoverPolicyOf(project);
  const have = new Set(existing.map((entry) => entry.branch.toLowerCase()));
  const added = next.filter((entry) => !have.has(entry.branch.toLowerCase()));
  const wantedKey = turnoverKeyFrom(key);
  if (policy === "one-per-feature") {
    for (const entry of added) {
      const asked = entry.key || wantedKey;
      if (!asked) continue;
      const prior = existing.find((row) => row.key && row.key.toLowerCase() === asked.toLowerCase());
      if (prior && prior.branch.toLowerCase() !== entry.branch.toLowerCase()) {
        return {
          ok: false,
          refused: "one-per-feature",
          policy,
          key: asked,
          existing: prior.branch,
          error: `one turnover branch per feature: "${asked}" already has \`${prior.branch}\` - use that branch, or name a different key`,
        };
      }
    }
  }
  if (!added.length) return { ok: true, ask: false, added: [], policy };
  if (policy === "free") return { ok: true, ask: false, added, policy };
  return { ok: true, ask: true, added, policy };
}

/** The project record's BASE-REF KIND, whichever shape the record has. A project that names a turnover branch and states no
 *  kind reads as `turnover`, so every config written before this key existed keeps its behaviour. */
export function baseRefKindOf(project) {
  return baseRefKindFrom(project?.baseRefKind, { turnoverBranch: turnoverBranchOf(project) });
}

/** The one answer the cut asks for as a kind: the registry's record first, the config row second (a project the scan
 *  has not merged yet still answers), and the named-turnover derivation when neither states a kind. */
export function baseRefKindLookup({ registry = null, config = null } = {}) {
  return (name) => {
    const wanted = String(name ?? "").trim();
    if (!wanted) return "checkout";
    const registered = (registry?.projects || []).find((p) => p && p.name === wanted) || null;
    const configured = registered || (config?.projects || []).find((p) => p && p.name === wanted) || null;
    return baseRefKindOf(configured);
  };
}

export { BASE_REF_KINDS, validateBaseRefKind };

// The lookup a CUT asks: "which branch does a tree for this project start from?" Read from the live registry first
// (that is the record the settings save updates, so the very next SPAWN sees the new name without a restart) and from
// the config row second (a project the scan has not merged yet still answers). "" for an unknown project or a blank
// name, which is what makes a cut fall back to the checkout's own ref exactly as it did before this setting existed.
//
// The optional second argument is the KEY a cut names (a task or initiative id). A key resolves ONLY the entry filed
// under that key: `turnoverBranches` is a per-feature registry, and falling back to the project's primary branch is
// how a cut for row 402 started from TASK-405's branch (the primary entry) while its own key had none. A key with no
// entry answers "" and the cut makes its own container, keyed; it never borrows another feature's branch. A caller
// that passes no key reads the project's primary branch exactly as it always did.
//
// It is a function rather than a copied value because a copy taken at boot would go stale on the first save; and it is
// here rather than inline in the composition root so the rule "registry, then config, then nothing" is testable.
export function turnoverLookup({ registry = null, config = null } = {}) {
  return (name, key = "") => {
    const wanted = String(name ?? "").trim();
    if (!wanted) return "";
    const registered = (registry?.projects || []).find((p) => p && p.name === wanted) || null;
    const configured = registered || (config?.projects || []).find((p) => p && p.name === wanted) || null;
    const wantedKey = turnoverKeyFrom(key);
    if (wantedKey) return turnoverBranchForKey(configured, wantedKey);
    return turnoverBranchOf(configured);
  };
}

// The `projects[]` ROW, as the settings writer leaves it: the SAME row with only the turnover fields moved, or - for a
// project config.json does not name yet - `{ name }` plus those keys.
//
// `branch` may be one name (the old single-key save) or an ARRAY of names / `{ branch, key }` entries (the list save).
// The array writes `turnoverBranches` and removes the old `turnoverBranch`, so the file never carries two answers to
// one question; the single name writes `turnoverBranch` and removes the list, because that save IS the whole list.
//
// A new row carries NO PATH, for the reason lib/push-permissions.js `projectPushRow` states: the board keys a
// project by NAME and discovery merges this row onto the repository it scanned by that name, so a path written here
// is a second copy of a fact the scan already owns.
//
// An EMPTY name REMOVES the key rather than storing "": the field is optional, absence is its empty value, and a
// file that has never held a turnover branch should not grow a key per project the reader opened once. A kind is
// written only when the caller names one, and the derived kind (a named branch, or the checkout) is never written:
// absence already reads as that answer. The policy is written only when it differs from the default `ask`, for the
// same reason.
export function projectTurnoverRow(existing, name, branch, kind = undefined, options = undefined) {
  const row = existing && typeof existing === "object" ? { ...existing } : { name: String(name ?? "").trim() };
  const policy = options && typeof options === "object" && options.policy !== undefined ? turnoverPolicyFrom(options.policy) : undefined;
  if (branch !== undefined) {
    if (Array.isArray(branch)) {
      const entries = entriesFrom(branch);
      if (entries.length) {
        row.turnoverBranches = entries.map((entry) => (entry.key ? { branch: entry.branch, key: entry.key } : entry.branch));
        delete row.turnoverBranch;
      } else {
        delete row.turnoverBranches;
        delete row.turnoverBranch;
      }
    } else {
      const named = turnoverBranchFrom(branch);
      if (named) row.turnoverBranch = named;
      else delete row.turnoverBranch;
      // A single-name save is the whole list, so a stale array from a hand-edited file must not outlive it.
      delete row.turnoverBranches;
    }
  }
  if (policy !== undefined) {
    if (policy !== DEFAULT_TURNOVER_POLICY) row.turnoverPolicy = policy;
    else delete row.turnoverPolicy;
  }
  const namedForKind = branch === undefined ? turnoverBranchOf(row) : Array.isArray(branch) ? turnoverBranchOf({ turnoverBranches: branch }) : turnoverBranchFrom(branch);
  if (kind !== undefined) {
    const chosen = baseRefKindFrom(kind, { turnoverBranch: namedForKind });
    // The third kind is meaningful with NO branch name (it is found, not named), so it must be stored even then.
    if (baseRefKindFrom(undefined, { turnoverBranch: namedForKind }) !== chosen) row.baseRefKind = chosen;
    else delete row.baseRefKind;
  }
  return row;
}
