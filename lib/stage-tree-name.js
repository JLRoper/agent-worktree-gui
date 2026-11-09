// ONE name for every tree a round cuts: the round's parent tree and each stage child of it.
//
// A round used to name its trees three different ways. The first cut took a random six-hex tag from `makeWorktree`,
// the stage after it took another, and the assembly tree a third, so one round's trees read as three unrelated jobs
// in the one list that shows them, and a re-run of the same visit asked for a directory `makeWorktree` had already
// used - landing a `-2` suffix on the name that was supposed to identify the attempt. The tag is a fact about the
// ROUND, not about a cut: pick it once, store it on the round, and derive every directory and branch from it.
//
// This module is that derivation and nothing else. It is PURE: same round, same stage, same visit, same three
// strings, in every process, on every restart, with no clock, no random tag and no counter. That is what makes a
// re-run at the same visit reuse its name instead of inventing `-2`, and it is why the cut takes a NAME from here
// rather than generating one.
//
// The family, for round `{ slug: "carry-the-form", tag: "a1b2c3" }`:
//
//   parent   .worktrees/carry-the-form-a1b2c3                        branch wtgui/carry-the-form-a1b2c3
//   child    .worktrees/carry-the-form-stage-2-implement-9d41f0      branch wtgui/carry-the-form-stage-2-implement-9d41f0
//            display "Stage 2: implement"
//
// `<n>` is the stage's POSITION in the pipeline document (1-based), not a count of cuts: a document re-export that
// inserts a stage renumbers the children, which is honest - the directory says which column of the document it ran.
//
// A child's six-hex tag is DERIVED from the round's tag, the stage id, its position and the visit, never drawn at
// random: the tag is a tree's identity in the panel's naming ledger and in its parent book (both key on the last six
// hex of a name), so two trees must never share one, and a re-run of one visit must land on the SAME one.
import { createHash } from "node:crypto";
import { treeSlug } from "./tree-slug.js";

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const STAGE_SLUG_MAX = 24;

const whole = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// The child's own six hex, from the four facts that say WHICH tree this is. Lower-case hex is what `tagOf` reads
// (lib/tree-names.js), so the name stays a name the rest of the panel can place.
export function stageTagOf({ tag, stage = "", position = 0, visit = 1 } = {}) {
  const seed = `${text(tag)}:${text(stage)}:${Number(position) || 0}:${Number(visit) || 1}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 6);
}

// The words a stage child shows: "Stage <n>: <name>". The ONE place the format lives, so the record written at the
// cut and a row read back from that record cannot disagree. Null when either half is missing: the panel does not
// invent a stage's number (the document's column) and does not invent its name.
export function stageDisplayName({ position = 0, name = "" } = {}) {
  const n = whole(position);
  const label = text(name);
  return n && label ? `Stage ${n}: ${label}` : null;
}

// A name this module will hand a cut, or null when the round cannot name anything (a record from before rounds
// carried a slug and a tag). Null is the caller's answer, not a fallback: inventing a tag here is how two names for
// one tree come back.
export function stageTreeName(round, stage = null, visit = 1) {
  const record = isObject(round) ? round : {};
  const slug = text(record.slug);
  const tag = text(record.tag);
  if (!slug || !tag) return null;
  const parentDir = `${slug}-${tag}`;
  const branchOf = (dir) => `wtgui/${dir}`;
  // The parent tree: one per round, cut from origin/main, and the branch every stage child is cut from.
  if (!stage) {
    return {
      display: text(record.title) || slug,
      dir: parentDir,
      branch: branchOf(parentDir),
      tag,
      stage: null,
      position: null,
      visit: null,
      parent: true,
    };
  }
  const id = text(stage.id) || text(stage.stage);
  const name = text(stage.name) || text(stage.title) || id;
  const position = whole(stage.position);
  const turn = whole(visit) || 1;
  if (!name || !position) return null;
  const stageSlug = treeSlug(name, { max: STAGE_SLUG_MAX });
  const childTag = stageTagOf({ tag, stage: id || name, position, visit: turn });
  const dir = `${slug}-stage-${position}-${stageSlug}-${childTag}`;
  return {
    display: stageDisplayName({ position, name }),
    dir,
    branch: branchOf(dir),
    tag: childTag,
    stage: id || name,
    // The stage's own words, beside the id: a row read back from the record can render "Stage 2: implement"
    // without the pipeline document, and the id it names may not be the words a reader sees.
    stageName: name,
    position,
    visit: turn,
    parent: false,
  };
}

// The two halves a caller must know before it can name a child: the task's own slug and the round's one tag. The tag
// is written on the round at its first cut and never re-drawn.
export function roundNameOf(record, { title = "", tag = null } = {}) {
  const source = isObject(record) ? record : {};
  const slug = text(source.slug) || treeSlug(text(title) || text(source.title) || "");
  const mark = text(tag) || text(source.tag);
  return { slug, tag: mark, title: text(title) || text(source.title) || null };
}
