// The ONE sentence a worktree row prints about where the tree was cut from - and the only place its five sayings are
// decided. Pure: no git, no fs, no clock. The caller hands in what it already read; every fact has one source.
//
// WHY A LINE OF ITS OWN. A row's Merge state block describes the branch and never said who its parent is, although the
// UNMERGED chip and the kind mark both depend on that answer. It now draws one line, and the line must never lie about
// how sure the answer is - "cut from X" reads as a record whether X came from the panel's own cut book or from a
// reconstruction of a branch nobody watched. So the sentence carries the provenance, and the five shapes are separate
// kinds rather than one sentence with a suffix:
//
//   recorded        `cut from <branch>` - the cut book (`branch-parents.json`) has a record for the tree, read through
//                   lib/worktrees.js `recordedParentFor` (tag:<six hex> first, then tree:<path>). The title names the
//                   record and its key, so a reader can find the entry.
//   reconstructed   `cut from <branch> - reconstructed from its reflog, not recorded` - lib/parents.js found the parent
//                   and nothing in the cut book records it. The title carries the reason. A guess from the shared-ticket
//                   heuristic is still labelled reconstructed (its title says which reconstruction), because a guess
//                   must never read as a cut.
//   unknown         `unknown - no cut record and its reflog names no local branch` - neither source answers. The title
//                   carries the reason, including the tie case: two equally near candidates are unknown, never a
//                   coin flip between siblings.
//   base            `cut from the project base <branch> - <branch> is the turnover destination, never a child's parent`
//                   - the record (or the reflog) names main, master, trunk or develop. Named as the base it is, and
//                   never handed on as a parent a roll-up could write into.
//   turnover        `turnover container - nothing above it` - this row IS the project's turnover branch: children are
//                   cut from it, and there is nothing above it to name.
//
// WHAT IT MAY NEVER DO. Print a reconstructed branch as recorded (that is the `kind`, not a wording choice); print a
// sibling as a parent (a record that names this tree's own branch is not a parent, and lib/parents.js refuses the
// descendant and equal-tip shapes before a parent is ever returned here); or print a main branch as a parent (the
// `base` saying exists so main can be named as the destination without being offered as a roll-up target).
import { isMainName } from "./parents.js";
import { recordedParentFor } from "./worktrees.js";

// Stable ids, so a renderer, a test and a report can name the same case instead of matching on prose.
export const PARENT_LINE_KINDS = ["recorded", "reconstructed", "unknown", "base", "turnover"];

export const UNKNOWN_PARENT_LINE = "unknown - no cut record and its reflog names no local branch";

// The label every row draws beside the sentence, in the block's own dim class. One word, because the Merge state block
// is a list of facts and the sentence is what says the rest.
export const PARENT_LINE_LABEL = "parent";

const text = (v) => String(v ?? "").trim();
const oneLine = (v, cap = 240) => {
  const flat = String(v ?? "").replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}\u2026` : flat;
};

// The sentence for the case the book records: main-names get the `base` saying, anything else the `recorded` one.
function recordedLine(rec, { mainBranch }) {
  const parent = text(rec.parent);
  const from = `branch-parents.json ${rec.key}`;
  if (isMainName(parent, mainBranch)) {
    return {
      kind: "base",
      parent,
      text: `cut from the project base ${parent} - ${parent} is the turnover destination, never a child's parent`,
      title: `recorded in the cut book (${from}): this tree was cut from ${parent}, which is the project base and the turnover's destination - never a child's parent`,
    };
  }
  return {
    kind: "recorded",
    parent,
    text: `cut from ${parent}`,
    title: `recorded in the cut book (${from}) when the panel cut this tree - not reconstructed and not guessed`,
  };
}

/**
 * The row's parent line, from the facts the caller already holds.
 *
 * `book` is the cut book itself (`branch-parents.json`, `{ "tag:<six hex>": { parent, branch, tree, at } }`), so the
 * RECORDED answer always goes through lib/worktrees.js `recordedParentFor` and never through a second lookup.
 * `parent` / `parentSource` / `why` are the parent book's answer (lib/parents.js), which is the ONLY reconstruction
 * path: `cut` is exact, `backfilled` is reconstructed, and `unknown` says why.
 * `refused` is the ref lib/parents.js refused to name, when it refused one (a reflog that says `Created from master`).
 * `turnover` says this row is the project's turnover branch, checked by the caller from the project's own record.
 */
export function parentLineFor({
  book = null,
  tree = "",
  branch = "",
  parent = null,
  parentSource = "unknown",
  why = "",
  refused = "",
  mainBranch = null,
  turnover = false,
} = {}) {
  const name = text(branch);
  const reason = oneLine(why);
  // (5) The feature container. Its children are cut from it; nothing sits above it, and saying so is the whole answer.
  if (turnover) {
    return {
      kind: "turnover",
      parent: null,
      text: "turnover container - nothing above it",
      title: `${name || "this tree"} is the project's turnover branch: children are cut from it, and nothing sits above it to name`,
    };
  }

  // (1) and (4) The cut book, through recordedParentFor. A record that names this tree's own branch is not a parent.
  const rec = recordedParentFor(book, { tree, branch: name });
  if (rec && text(rec.parent) && text(rec.parent) !== name) return recordedLine(rec, { mainBranch });

  const answer = text(parent);
  const source = text(parentSource) || "unknown";
  // The parent book's own exact record (a pinned cut writes here even when the durable book has no entry).
  if (answer && answer !== name && source === "cut") {
    return recordedLine({ parent: answer, key: "the panel's parent book" }, { mainBranch });
  }

  // (4) A reconstruction that refused a main name. The reason names it; the ref is the fact behind that, so it is
  // reported as the project base and never handed on as a parent.
  const refusedRef = text(refused);
  if (refusedRef && isMainName(refusedRef, mainBranch)) {
    return {
      kind: "base",
      parent: refusedRef,
      text: `cut from the project base ${refusedRef} - ${refusedRef} is the turnover destination, never a child's parent`,
      title: `reconstructed: ${reason || `its reflog says it was created from ${refusedRef}`}`,
    };
  }

  // (2) A reconstruction. The branch is named, and the sentence says it was not recorded.
  if (answer && answer !== name && source === "backfilled" && !isMainName(answer, mainBranch)) {
    const fromReflog = /reflog/i.test(reason);
    return {
      kind: "reconstructed",
      parent: answer,
      text: fromReflog
        ? `cut from ${answer} - reconstructed from its reflog, not recorded`
        : `cut from ${answer} - reconstructed, not recorded`,
      title: `reconstructed by lib/parents.js, not recorded: ${reason || "the cut book has no entry for this tree"}`,
    };
  }

  // (3) Neither source answers. The generic sentence is the one the reader asked for; the reason is the title, so a
  // tie between two equally near candidates reads as unknown instead of as a pick.
  return {
    kind: "unknown",
    parent: null,
    text: UNKNOWN_PARENT_LINE,
    title: reason || "no cut record in branch-parents.json, and its reflog names no local branch to roll into",
  };
}

// The row's Merge state block is a <ul> of facts; this is the item the page draws for the line. It lives here so the
// proof tool and the page cannot disagree about the markup: test/parent-line.test.js pins public/board-scaffold.js's
// template to this exact string. The dim label and the mono value are the block's own classes - no stylesheet rule.
const escHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function parentLineItemHtml(line) {
  if (!line || !text(line.text)) return "";
  return `<li class="git-parent" title="${escHtml(line.title || line.text)}"><span class="dim">${PARENT_LINE_LABEL}</span> <span class="mono">${escHtml(line.text)}</span></li>`;
}
