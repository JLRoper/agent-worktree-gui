// A project's turnover branch: the branch its work rolls up into before anybody lands it.
//
// WHERE IT LIVES. On the project's entry in `config.json` (`projects[].turnoverBranch`), beside `mainBranch` and the
// push controls. A project's entry is already the reader's record of what that project IS, and this is the same kind
// of fact: a branch name one reader typed about one project, which has to survive a restart and travel with the file.
// lib/projects.js merges those entries onto the scanned repository by NAME, so the name written here is on the board
// record every reader downstream sees (the settings bar, the cut, the landing paragraph) without a second lookup.
//
// WHY IT EXISTS. A tree's parent used to be whichever branch the project's checkout happened to be standing on
// (`lib/jobs.js` startRefOf). For a repo whose checkout sits on master that is master, so every tree was briefed
// "push the branch and open a pull request" - which is how child branches of an unpublished turnover branch reached
// the shared remote. A project that names its turnover branch here is cut FROM that branch instead, and the worker is
// told to merge back into it locally.
//
// THE SHAPE. `turnoverBranch` is OPTIONAL and defaults to EMPTY: absent, null, a number, an object, or a string of
// spaces all read as "". Reading is FORGIVING (the panel must still boot on a hand-edited file); writing is STRICT
// (`validateTurnoverBranch` refuses a name git cannot carry, and refuses a landing branch), because a save that
// silently changes what the reader typed is a lie about what was stored.
//
// This file is pure: no git, no config write, no server. The write itself is `setProjectTurnover` in the composition
// root, and the wire shape is routes/project-turnover.js.

/** How long a branch name may be, after whitespace collapses. Git's own limit is far higher; this is a settings field. */
export const TURNOVER_MAX_CHARS = 120;

/** Names that are a project's destination, never its turnover branch. The same set lib/parents.js refuses. */
export const LANDING_NAMES = ["main", "master", "trunk", "develop"];

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

/** The project record's answer, whichever shape the record has. Absence reads as "". */
export function turnoverBranchOf(project) {
  return turnoverBranchFrom(project?.turnoverBranch);
}

/** True when this project has declared a turnover branch. */
export function hasTurnoverBranch(project) {
  return Boolean(turnoverBranchOf(project));
}

// The lookup a CUT asks: "which branch does a tree for this project start from?" Read from the live registry first
// (that is the record the settings save updates, so the very next SPAWN sees the new name without a restart) and from
// the config row second (a project the scan has not merged yet still answers). "" for an unknown project or a blank
// name, which is what makes a cut fall back to the checkout's own ref exactly as it did before this setting existed.
//
// It is a function rather than a copied value because a copy taken at boot would go stale on the first save; and it is
// here rather than inline in the composition root so the rule "registry, then config, then nothing" is testable.
export function turnoverLookup({ registry = null, config = null } = {}) {
  return (name) => {
    const wanted = String(name ?? "").trim();
    if (!wanted) return "";
    const registered = (registry?.projects || []).find((p) => p && p.name === wanted) || null;
    const configured = registered || (config?.projects || []).find((p) => p && p.name === wanted) || null;
    return turnoverBranchFrom(configured?.turnoverBranch);
  };
}

// The `projects[]` ROW, as the settings writer leaves it: the SAME row with only `turnoverBranch` moved, or - for a
// project config.json does not name yet - `{ name }` plus the branch.
//
// A new row carries NO PATH, for the reason lib/push-permissions.js `projectPushRow` states: the board keys a
// project by NAME and discovery merges this row onto the repository it scanned by that name, so a path written here
// is a second copy of a fact the scan already owns.
//
// An EMPTY name REMOVES the key rather than storing "": the field is optional, absence is its empty value, and a
// file that has never held a turnover branch should not grow a key per project the reader opened once.
export function projectTurnoverRow(existing, name, branch) {
  const row = existing && typeof existing === "object" ? { ...existing } : { name: String(name ?? "").trim() };
  const named = turnoverBranchFrom(branch);
  if (named) row.turnoverBranch = named;
  else delete row.turnoverBranch;
  return row;
}
