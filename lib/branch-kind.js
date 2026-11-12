// WHAT KIND OF TREE A CUT MADE - the one fact a cut knows and a later run cannot reconstruct.
//
// A tree is cut for one of two reasons, and the reason decides whether it may reach a remote:
//
//   turnover  a CHILD of a turnover branch (YYYYMMDD_HHMM_<TICKET>_<desc>) that the reader already asked for. It has
//             a destination on the remote - the turnover branch it was cut from - so it is not local only by its
//             kind; its push meets the ordinary controls.
//   research  a tree cut from the project's MAIN parent (main/master/trunk/develop, or whatever the project calls
//             its main branch). It is the probe: it exists to answer a question and never to land, so its kind is
//             LOCAL ONLY, and lib/push-permissions.js refuses a push from it until the reader lifts it.
//
// The vocabulary is CLOSED at those two. A parent that is neither - a feature branch, a sibling's wtgui branch, a
// detached sha with no name - is not quietly filed under a default: `planCut` returns `cut: false` with a clarify
// card that offers exactly these two kinds and nothing else. Falling back silently is the failure this rule exists
// to prevent: a tree filed as "research" that was really a child, or the reverse, is a push decision nobody made.
//
// The kind is written BESIDE the parent, in the tree's own branch-parents.json entry (lib/jobs.js `rememberParent`),
// keyed by the tree's tag - one record, read by the same lookup that answers "what was this tree cut from".
import { BASE_BRANCHES, LOCAL_ONLY_TREE_KINDS } from "./push-permissions.js";
import { isMainName } from "./parents.js";
import { isTurnoverBranchName } from "./turnover-base.js";

// The two kinds, in the order the card offers them. Exported so the dialog, the record and the tests read ONE list.
export const BRANCH_KINDS = ["turnover", "research"];

// What each kind is called, in the reader's words. The label is the option on the card and the word in a refusal.
export const KIND_LABELS = {
  turnover: "turnover child",
  research: "research tree",
};

// One line per kind, for the cut dialog and the clarify card: what it means, not just its name.
export const KIND_NOTES = {
  turnover: "cut from a turnover branch the reader asked for - it has a destination on the remote",
  research: "cut from the project's main parent - local only, and it never lands until the reader lifts it",
};

// Is this branch a turnover branch? The shape is lib/turnover-base.js `isTurnoverBranchName`, the SAME predicate the
// turnover base-ref resolver offers candidates from - read from there rather than typed again, so a branch the cut
// would offer as a turnover parent is a branch this rule calls a turnover parent, and the two halves cannot drift.
// That predicate is deliberately a shade wider than the push gate's (it allows the camelCase slug a real turnover
// branch on this fleet carries); a main branch never matches its date pattern, and is excluded explicitly anyway:
// main is the research parent, never a turnover one.
export function isTurnoverBranch(name) {
  const branch = String(name ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
  if (!branch) return false;
  if (BASE_BRANCHES.includes(branch.toLowerCase())) return false;
  return isTurnoverBranchName(branch);
}

// The kind a parent names, or null when it names neither. Pure: no git, no store, so the cut, the route and a test
// all ask the same question.
export function branchKindFor({ parent = "", mainBranch = null } = {}) {
  const p = String(parent ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
  if (!p) return { kind: null, localOnly: false, why: "no parent branch is named, so neither kind applies" };
  if (isTurnoverBranch(p)) {
    return { kind: "turnover", localOnly: LOCAL_ONLY_TREE_KINDS.includes("turnover"), why: `cut from the turnover branch ${p} the reader asked for` };
  }
  if (isMainName(p, mainBranch)) {
    return { kind: "research", localOnly: LOCAL_ONLY_TREE_KINDS.includes("research"), why: `cut from ${p}, the project's main parent - local only` };
  }
  return { kind: null, localOnly: false, why: `${p} is neither a turnover branch nor the project's main parent` };
}

// The two options the cut dialog offers. Exactly two entries, always - a third would be a kind nobody defined.
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

// THE CUT DECISION. A reader's cut asks this with the parent it would branch from:
//
//   { cut: true, kind, localOnly, why }                    the parent names a kind, the cut may happen
//   { cut: false, kind: null, why, clarify: {...} }        neither kind applies: ask, and cut nothing
//
// `clarify` is the panel's card shape - a question, the two kinds as its choices, one answer - so the page draws it
// as a card rather than inventing a third kind or picking one of the two on the reader's behalf.
export function planCut({ project = "", tree = null, parent = "", mainBranch = null } = {}) {
  const verdict = branchKindFor({ parent, mainBranch });
  if (verdict.kind) return { cut: true, kind: verdict.kind, localOnly: verdict.localOnly, why: verdict.why };
  const p = String(parent ?? "").trim();
  const main = String(mainBranch ?? "").trim();
  return {
    cut: false,
    kind: null,
    localOnly: false,
    why: verdict.why,
    clarify: {
      kind: "clarify",
      question: `Which kind of tree is this cut? ${p || "The parent"} is neither a turnover branch nor ${main || "the project's main parent"}, so the panel will not guess: choose one, and nothing is cut until you do.`,
      choices: kindChoices(),
      multiSelect: false,
      project: String(project ?? ""),
      tree: tree || null,
      parent: p || null,
    },
  };
}
