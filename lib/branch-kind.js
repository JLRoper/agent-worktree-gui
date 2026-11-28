// WHAT KIND OF TREE A CUT MADE - the one fact a cut knows and a later run cannot reconstruct.
//
// THREE KINDS OF TREE, and the first one is not a child of anything:
//
//   turnover        THE FEATURE CONTAINER. The tree standing ON a turnover branch (YYYYMMDD_HHMM_<TICKET>_<desc>),
//                   cut from the project's base under the project's turnover policy (lib/project-turnover.js). It is
//                   where one feature's work is collected: research and implementation trees are cut from it, and an
//                   implementation tree's work merges back into it locally.
//   research        a tree cut to answer a question. It is LOCAL ONLY: it never merges, never pushes and never opens
//                   a pull request. Its work is the answer, copied out of the tree and released.
//   implementation  a tree cut to change code. It is LOCAL ONLY too, but it LANDS: its work merges locally into the
//                   turnover branch it was cut from. It is ALWAYS a child of a turnover branch - a cut asked for with
//                   a main parent first cuts the feature's turnover tree and then cuts the child from it
//                   (lib/jobs.js `makeWorktree`, POST /api/worktree/child), never a child of main.
//
// THERE IS NO "TURNOVER CHILD" ANY MORE. A branch cut from a turnover branch is research or implementation by its
// brief, never turnover: `turnover` names the container itself, not a relationship to one. So `planCut` never answers
// turnover - a stated turnover is not a child's kind and falls through to the brief - and the only way a tree is
// recorded turnover is `planTurnoverContainer`, which is the container's OWN cut. A NESTED child (a child of a
// research or implementation tree) classifies by its own brief too: the parent's kind is a picture, not an answer.
//
// The brief decides between research and implementation: a brief that names code is implementation, anything else is
// research (`inferKindFromBrief`). A cut is never blocked on the question - a cut that stopped to ask was a tree
// nobody got - so `planCut` always answers one of the two child kinds. The reader's own stated kind wins over the
// inference.
//
// The kind is written BESIDE the parent, in the tree's own branch-parents.json entry (lib/jobs.js `rememberParent`),
// keyed by the tree's tag - one record, read by the same lookup that answers "what was this tree cut from".
import { BASE_BRANCHES, LOCAL_ONLY_TREE_KINDS } from "./push-permissions.js";
import { isMainName } from "./parents.js";
import { isTurnoverBranchName } from "./turnover-base.js";

// The three kinds, in the order the legend and the settings glossary explain them. Exported so the record, the row
// and the tests read ONE list.
export const BRANCH_KINDS = ["turnover", "research", "implementation"];

// The kinds a CUT of a tree can be. Turnover is absent on purpose: a cut makes a child, and a child is never the
// feature container. This is what the cut dialog offers and what `planCut` accepts as a stated answer.
export const CHILD_KINDS = ["research", "implementation"];

// What each kind is called, in the reader's words.
export const KIND_LABELS = {
  turnover: "turnover tree",
  research: "research tree",
  implementation: "implementation tree",
};

// One line per kind, for the cut dialog and a row's tooltip: what it means, not just its name.
export const KIND_NOTES = {
  turnover:
    "the feature container - the tree on a turnover branch; research and implementation trees are cut from it, and an implementation tree's work merges back into it locally",
  research: "cut to answer a question - local only: it commits, is copied out and released, never merges and never pushes",
  implementation:
    "cut to change code - always a child of its feature's turnover branch, local only: it merges into that branch, and never pushes without your per-tree grant",
};

// The letters the row draws in the Kind column. One letter per kind, read by public/render-projects.js from the
// row's `branchKindLabel`; the letter itself is a client concern, so it travels with the label map here.
export const KIND_MARKS = {
  turnover: "T",
  research: "R",
  implementation: "I",
};

// The forms each code word takes, so "implements", "fixed", "renaming", "built" and "testing" all read as the word.
// The list is deliberately explicit rather than a stem: a bare stem would make "addendum" an "add", "testament" a
// "test", and "Chang" a "change".
const CODE_WORDS = [
  "implement", "implements", "implemented", "implementing",
  "fix", "fixes", "fixed", "fixing",
  "add", "adds", "added", "adding",
  "change", "changes", "changed", "changing",
  "refactor", "refactors", "refactored", "refactoring",
  "patch", "patches", "patched", "patching",
  "rename", "renames", "renamed", "renaming",
  "upgrade", "upgrades", "upgraded", "upgrading",
  "wire", "wires", "wired", "wiring",
  "build", "builds", "built", "building",
  "test", "tests", "tested", "testing",
];
const CODE_WORD_RE = new RegExp(`\\b(?:${CODE_WORDS.join("|")})\\b`, "i");

// THE LANDING VERBS. The reader settled the rule on 2026-11-28: any brief containing a landing verb - land, push, a
// PR, a merge, a version bump, a release - is a LANDING brief, whatever its first sentence says. A brief that opens
// with "row 402 is the complete brief" and only later says "push and open the PR" used to read as research, so the cut
// took the research shape and the implementation landed at the repo root. The verb list is explicit for the same
// reason CODE_WORDS is: a stem would make "pristine" a PR and "mergeable" a merge.
const LANDING_WORDS = [
  "land", "lands", "landed", "landing",
  "push", "pushes", "pushed", "pushing",
  "pr", "prs", "pull request", "pull requests",
  "merge", "merges", "merged", "merging",
  "ship", "ships", "shipped", "shipping",
  "release", "releases", "released", "releasing",
  "version bump", "bump", "bumps", "bumped", "bumping",
];
// A LANDING VERB THAT IS QUALIFYING THE MACHINERY IS A DESCRIPTION, NOT AN ORDER. "the push guard decided wrong"
// and "the merge status reads stale" name the panel's own parts; "push the branch", "merge it locally" and "open the
// PR" are the orders this rule is about. The word right after the verb decides: a machinery noun means the verb was
// describing that noun, and the search continues to the next occurrence.
const MACHINERY_NOUNS = new Set([
  "guard", "gate", "policy", "permission", "permissions", "route", "routes", "status", "state",
  "commit", "commits", "history", "control", "controls", "setting", "settings", "test", "tests",
  "code", "button", "card", "flow", "check", "rule", "rules", "registry", "list", "notes",
  // "a landing tree", "the landing branch": the panel's own objects, described rather than ordered.
  "tree", "trees", "branch", "branches",
]);
const LANDING_WORD_RE = new RegExp(`\\b(?:${LANDING_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");

/** The landing verb a brief carries, lowercased, or "" when it carries none. Exported so a record can say WHY. */
export function landingSignal(text) {
  const said = String(text ?? "");
  const re = new RegExp(LANDING_WORD_RE.source, "gi");
  let found;
  while ((found = re.exec(said))) {
    const after = said.slice(found.index + found[0].length).match(/^\s+([A-Za-z][A-Za-z-]*)/);
    if (after && MACHINERY_NOUNS.has(after[1].toLowerCase())) continue;
    return found[0].toLowerCase().replace(/\s+/g, " ");
  }
  return "";
}

// A file path with an extension, and the extensions this fleet's briefs actually name. A bare `x.y` is not enough:
// "e.g", "i.e" and a version number all look like one, and a brief that says "v1.2" is not a code brief. The path
// may carry separators, and the extension is matched case-insensitively.
const FILE_EXTENSIONS = [
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "css", "html", "htm", "md", "py", "java", "kt", "vue", "sh",
  "bash", "yml", "yaml", "xml", "txt", "sql", "gradle", "properties", "toml", "ini", "cfg", "conf", "go", "rs",
  "rb", "php", "cs", "scala", "drawio", "svg", "png", "jpg", "jpeg", "gif", "webp", "pdf", "docx", "xlsx",
];
const FILE_PATH_RE = new RegExp(`(?:[\\w.\\-]+[\\\\/])*[\\w.\\-]+\\.(?:${FILE_EXTENSIONS.join("|")})\\b`, "i");

// A commit: the word itself, or a short/long sha written beside it. The word alone is the signal the reader named;
// a bare hex string would catch a uuid fragment and turn a research brief into an implementation one.
const COMMIT_RE = /\bcommits?\b|\b[0-9a-f]{7,40}\b(?=[^\n]{0,40}\bcommit)/i;

// THE INFERENCE, pure and documented. Answers `implementation` when the brief NAMES CODE OR NAMES A LANDING - one of
// the verbs above, a landing verb, a file path with a known extension, or a commit - and `research` otherwise.
// "Research the seam" and "answer a question about the code" are research even though they mention code: the verb is
// what decides, and the file/commit/landing evidence is the other half of "this brief is about changing something that
// exists". A landing verb wins over everything: the reader's rule is that a brief which says land, push, PR, merge or
// version bump is a LANDING brief whatever its first sentence says, because the opposite (a landing task read as
// research) is what put implementations at the repo root.
export function inferKindFromBrief(text) {
  const said = String(text ?? "");
  if (!said.trim()) return "research";
  if (landingSignal(said)) return "implementation";
  if (CODE_WORD_RE.test(said)) return "implementation";
  if (FILE_PATH_RE.test(said)) return "implementation";
  if (COMMIT_RE.test(said)) return "implementation";
  return "research";
}

const shortName = (name) =>
  String(name ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");

// Is this branch a turnover branch? The shape is lib/turnover-base.js `isTurnoverBranchName`, the SAME predicate the
// turnover base-ref resolver offers candidates from - read from there rather than typed again, so a branch the cut
// would offer as a turnover parent is a branch this rule calls a turnover branch, and the two halves cannot drift.
// That predicate is deliberately a shade wider than the push gate's (it allows the camelCase slug a real turnover
// branch on this fleet carries); a main branch never matches its date pattern, and is excluded explicitly anyway:
// main is a base parent, never a turnover one.
export function isTurnoverBranch(name) {
  const branch = shortName(name);
  if (!branch) return false;
  if (BASE_BRANCHES.includes(branch.toLowerCase())) return false;
  return isTurnoverBranchName(branch);
}

// The kind a parent names BY ITSELF, or null when the parent alone names none. NO parent names a CHILD's kind: a
// turnover branch is the feature container (its children are research or implementation by their brief), main is the
// project's base, and anything else is a parent tree whose children classify by their own brief. `container` says the
// parent is a turnover branch, which is what the chart and the dialog show; it never becomes the child's kind.
export function branchKindFor({ parent = "", mainBranch = null } = {}) {
  const p = shortName(parent);
  if (!p) return { kind: null, container: false, localOnly: false, why: "no parent branch is named, so the brief decides the kind" };
  if (isTurnoverBranch(p)) {
    return {
      kind: null,
      container: true,
      localOnly: false,
      why: `cut from ${p}, the feature's turnover branch - its children are research or implementation by their brief, never turnover`,
    };
  }
  if (isMainName(p, mainBranch)) {
    return { kind: null, container: false, localOnly: false, why: `cut from ${p}, the project's main parent - the brief decides research or implementation` };
  }
  return { kind: null, container: false, localOnly: false, why: `${p} is another tree's branch - the child classifies by its own brief` };
}

// The two options a CUT offers. Exactly two entries, always: a child is research or implementation, and a third
// ("turnover") would offer the reader a kind a child can never have.
export function kindChoices() {
  return CHILD_KINDS.map((value) => ({ value, label: `${KIND_LABELS[value]} - ${KIND_NOTES[value]}` }));
}

// The parent options a cut dialog offers, in the order it draws them, with the one to preselect. PURE: the caller
// passes the row's branch, the project's main name and the feature's turnover branch (when it has one).
//
//   the row is on a turnover branch -> that branch, alone: the child belongs to the container.
//   the row is on main              -> the feature's turnover branch FIRST and preselected, main offered as the
//                                      top-level alternative (a research tree may stand beside main).
//   the row is on any other tree    -> that branch, alone: the cut is a nested child and classifies by its own brief.
export function cutParentChoices({ parent = "", mainBranch = null, turnoverBranch = "" } = {}) {
  const p = shortName(parent);
  const turn = shortName(turnoverBranch);
  if (!p) {
    return turn ? [{ branch: turn, role: "turnover", preselected: true, label: `${turn} - the feature's turnover branch` }] : [];
  }
  if (isTurnoverBranch(p) || (turn && p === turn)) {
    return [{ branch: p, role: "turnover", preselected: true, label: `${p} - the feature's turnover branch` }];
  }
  if (isMainName(p, mainBranch)) {
    const rows = [];
    if (turn && turn !== p) {
      rows.push({ branch: turn, role: "turnover", preselected: true, label: `${turn} - the feature's turnover branch` });
    }
    rows.push({ branch: p, role: "main", preselected: rows.length === 0, label: `${p} - top level, beside the project's main` });
    return rows;
  }
  return [{ branch: p, role: "nested", preselected: true, label: `${p} - this tree's own branch (a nested child)` }];
}

// One answer, from a card or a dialog body, reduced to a CHILD kind or null. A stated `turnover` is not an answer a
// cut can give - turnover is the container, and a cut makes a child - so it reads as no answer and the brief decides.
export function kindFromAnswer(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return CHILD_KINDS.includes(v) ? v : null;
}

// THE CUT DECISION. A reader's cut asks this with the parent it would branch from, the kind it stated (if any), and
// the brief it was written for:
//
//   { cut: true, kind, localOnly, why, stated, containerParent }   always - a cut is never blocked
//
// The order is the reader's rule, and it is fixed here:
//
//   1. a STATED child kind wins (`kind` from the dialog or the reader's answer);
//   2. else the brief is inferred (`inferKindFromBrief`).
//
// There is NO turnover answer and NO clarify case: a child of a turnover branch, of main or of another tree is
// research or implementation by its brief. `stated` says whether the kind came from step 1, so a record can tell the
// reader's own answer from the rule's; `containerParent` says the parent was a turnover branch, for the picture.
export function planCut({ project = "", tree = null, parent = "", mainBranch = null, kind = null, brief = "" } = {}) {
  const p = shortName(parent);
  const stated = kindFromAnswer(kind);
  const containerParent = Boolean(p) && isTurnoverBranch(p);
  if (stated) {
    return {
      cut: true,
      kind: stated,
      localOnly: LOCAL_ONLY_TREE_KINDS.includes(stated),
      why: `the reader chose ${KIND_LABELS[stated]} (${stated})`,
      stated: true,
      containerParent,
    };
  }
  const inferred = inferKindFromBrief(brief);
  const where = p
    ? containerParent
      ? `cut from ${p}, the feature's turnover branch (its children are never turnover)`
      : isMainName(p, mainBranch)
        ? `cut from ${p}, the project's main parent`
        : `${p} is another tree's branch, so the child classifies by its own brief`
    : "no parent branch is named";
  const signal = inferred === "implementation" ? landingSignal(brief) : "";
  return {
    cut: true,
    kind: inferred,
    localOnly: LOCAL_ONLY_TREE_KINDS.includes(inferred),
    why: signal
      ? `${where} - the brief names landing work ("${signal}"), so it reads as ${KIND_LABELS[inferred]} (${inferred})`
      : `${where} - the brief reads as ${KIND_LABELS[inferred]} (${inferred})`,
    stated: false,
    containerParent,
  };
}

// THE CONTAINER'S OWN CUT, and the only answer that records `turnover`. The tree stands ON a turnover branch the
// auto-cut has just made (or found) under the project's turnover policy; its parent is the project's base, and it is
// not a child of anything. Kept here beside `planCut` so the record's vocabulary has one home and no caller types the
// word "turnover" as a kind by hand.
export function planTurnoverContainer({ project = "", key = "", parent = "", mainBranch = null, branch = "" } = {}) {
  const p = shortName(parent);
  const named = shortName(branch);
  const where = p
    ? isMainName(p, mainBranch)
      ? `cut from ${p}, the project's base`
      : `cut from ${p}`
    : "";
  return {
    cut: true,
    kind: "turnover",
    localOnly: false,
    container: true,
    why:
      `the feature container itself${named ? ` (${named})` : ""}${where ? `, ${where}` : ""}` +
      `${key ? ` under key ${key}` : ""} - turnover is the kind the turnover branch's own tree records, never a child's`,
    stated: false,
    key: key || null,
  };
}
