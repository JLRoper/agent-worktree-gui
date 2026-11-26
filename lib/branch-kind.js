// WHAT KIND OF TREE A CUT MADE - the one fact a cut knows and a later run cannot reconstruct.
//
// A tree is cut for one of three reasons, and the reason decides where its work goes:
//
//   turnover        a CHILD of a turnover branch (YYYYMMDD_HHMM_<TICKET>_<desc>) that the reader already asked for.
//                    It has a destination on the remote - the turnover branch it was cut from - so it is not local
//                    only by its kind; its push meets the ordinary controls, and its work merges back into that
//                    branch locally.
//   research        a tree cut to answer a question. It is LOCAL ONLY: it never merges, never pushes and never opens
//                    a pull request. Its work is the answer, copied out of the tree and released.
//   implementation  a tree cut to change code. It is LOCAL ONLY too, but it LANDS: its work merges locally into the
//                    turnover branch it was cut from, or the project's configured turnover branch when its parent is
//                    not one, else into main locally only on the reader's explicit grant. It never pushes as part of
//                    that landing.
//
// A parent alone names only the turnover kind. A cut from the project's main parent (main/master/trunk/develop, or
// whatever the project calls its main branch) is either research or implementation, and the BRIEF decides which: a
// brief that names code is implementation, anything else is research (`inferKindFromBrief`). A parent that is neither
// a turnover branch nor main names no kind by itself either; the brief still decides, because a cut is never blocked
// on a question. `planCut` therefore always answers a kind - a stated kind wins, else a turnover-shaped parent makes
// a turnover child, else the brief is inferred - and never returns a clarify card. A cut that stopped to ask was a
// tree nobody got; the inference is the reader's own rule, written down here once so the cut, the record and a test
// all read the same answer.
//
// The kind is written BESIDE the parent, in the tree's own branch-parents.json entry (lib/jobs.js `rememberParent`),
// keyed by the tree's tag - one record, read by the same lookup that answers "what was this tree cut from".
import { BASE_BRANCHES, LOCAL_ONLY_TREE_KINDS } from "./push-permissions.js";
import { isMainName } from "./parents.js";
import { isTurnoverBranchName } from "./turnover-base.js";

// The three kinds, in the order the dialog and the card offer them. Exported so the dialog, the record and the tests
// read ONE list.
export const BRANCH_KINDS = ["turnover", "research", "implementation"];

// What each kind is called, in the reader's words. The label is the option on the card and the word in a refusal.
export const KIND_LABELS = {
  turnover: "turnover child",
  research: "research tree",
  implementation: "implementation tree",
};

// One line per kind, for the cut dialog and a row's tooltip: what it means, not just its name.
export const KIND_NOTES = {
  turnover: "cut from a turnover branch the reader asked for - its work rolls up into that branch locally",
  research: "cut to answer a question - local only: it never merges, never pushes and never opens a pull request",
  implementation: "cut to change code - local only: it merges into its turnover branch, or into main on your grant",
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

// THE INFERENCE, pure and documented. Answers `implementation` when the brief NAMES CODE - one of the verbs above, a
// file path with a known extension, or a commit - and `research` otherwise. "Research the seam" and "answer a
// question about the code" are research even though they mention code: the verb is what decides, and the file/commit
// evidence is the other half of "this brief is about changing something that exists".
export function inferKindFromBrief(text) {
  const said = String(text ?? "");
  if (!said.trim()) return "research";
  if (CODE_WORD_RE.test(said)) return "implementation";
  if (FILE_PATH_RE.test(said)) return "implementation";
  if (COMMIT_RE.test(said)) return "implementation";
  return "research";
}

// Is this branch a turnover branch? The shape is lib/turnover-base.js `isTurnoverBranchName`, the SAME predicate the
// turnover base-ref resolver offers candidates from - read from there rather than typed again, so a branch the cut
// would offer as a turnover parent is a branch this rule calls a turnover parent, and the two halves cannot drift.
// That predicate is deliberately a shade wider than the push gate's (it allows the camelCase slug a real turnover
// branch on this fleet carries); a main branch never matches its date pattern, and is excluded explicitly anyway:
// main is a base parent, never a turnover one.
export function isTurnoverBranch(name) {
  const branch = String(name ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
  if (!branch) return false;
  if (BASE_BRANCHES.includes(branch.toLowerCase())) return false;
  return isTurnoverBranchName(branch);
}

// The kind a parent names BY ITSELF, or null when the parent alone names none. A turnover branch names `turnover`;
// the project's main parent (and every other parent) names none, because research and implementation are separated by
// the brief, not by where the cut started. Pure: no git, no store.
export function branchKindFor({ parent = "", mainBranch = null } = {}) {
  const p = String(parent ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
  if (!p) return { kind: null, localOnly: false, why: "no parent branch is named, so the brief decides the kind" };
  if (isTurnoverBranch(p)) {
    return { kind: "turnover", localOnly: LOCAL_ONLY_TREE_KINDS.includes("turnover"), why: `cut from the turnover branch ${p} the reader asked for` };
  }
  if (isMainName(p, mainBranch)) {
    return { kind: null, localOnly: false, why: `cut from ${p}, the project's main parent - the brief decides research or implementation` };
  }
  return { kind: null, localOnly: false, why: `${p} names no kind by itself - the brief decides research or implementation` };
}

// The three options a cut dialog offers. Exactly three entries, always - a fourth would be a kind nobody defined.
export function kindChoices() {
  return BRANCH_KINDS.map((value) => ({ value, label: `${KIND_LABELS[value]} - ${KIND_NOTES[value]}` }));
}

// One answer, from a card or a dialog body, reduced to a kind or null. Anything else a caller sends is not an answer.
export function kindFromAnswer(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return BRANCH_KINDS.includes(v) ? v : null;
}

// THE CUT DECISION. A reader's cut asks this with the parent it would branch from, the kind it stated (if any), and
// the brief it was written for:
//
//   { cut: true, kind, localOnly, why, stated }   always - a cut is never blocked
//
// The order is the reader's rule, and it is fixed here:
//
//   1. a STATED kind wins (`kind` from the dialog or the reader's answer);
//   2. else a turnover-shaped parent makes a turnover child;
//   3. else the brief is inferred (`inferKindFromBrief`).
//
// `stated` says whether the kind came from step 1, so a record can tell the reader's own answer from the rule's.
// There is NO clarify case: a cut that stops to ask is a tree nobody got, and the brief already carries the answer.
export function planCut({ project = "", tree = null, parent = "", mainBranch = null, kind = null, brief = "" } = {}) {
  const stated = kindFromAnswer(kind);
  if (stated) {
    return {
      cut: true,
      kind: stated,
      localOnly: LOCAL_ONLY_TREE_KINDS.includes(stated),
      why: `the reader chose ${KIND_LABELS[stated]} (${stated})`,
      stated: true,
    };
  }
  const p = String(parent ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
  if (isTurnoverBranch(p)) {
    return {
      cut: true,
      kind: "turnover",
      localOnly: false,
      why: `cut from the turnover branch ${p} the reader asked for`,
      stated: false,
    };
  }
  const inferred = inferKindFromBrief(brief);
  const where = p
    ? isMainName(p, mainBranch)
      ? `cut from ${p}, the project's main parent`
      : `${p} names no kind by itself`
    : "no parent branch is named";
  return {
    cut: true,
    kind: inferred,
    localOnly: LOCAL_ONLY_TREE_KINDS.includes(inferred),
    why: `${where} - the brief reads as ${KIND_LABELS[inferred]} (${inferred})`,
    stated: false,
  };
}
