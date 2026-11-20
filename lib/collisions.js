// COLLISIONS: two live runs in one project stepping on the same work, detected two-sided and carried as evidence.
//
// WHY THIS EXISTS. The board already knows, per row, what each tree is touching: its dirty files, its untracked
// files, and (on a live row) the files its own commits change since the branch it was cut from. What it never did was
// put two rows side by side. Two workers in one project can therefore write the same file, or one can be landing into
// the branch the other is still working on top of, and the first sign of it is a merge conflict or a lost edit - long
// after the reader could have ruled on it. This module answers ONE question, for every pair of live rows in a
// project: are these two touching the same work, and what is the evidence?
//
// THE EVIDENCE IS THE ANSWER, never a bare flag. Every pair names the shared paths it found, because "two workers are
// colliding" with no paths is a claim a reader cannot check and an assistant cannot act on. Two relations can produce
// a pair, and a third may only add context to one:
//
//   shared-file       both trees are touching a path the other is touching (dirty, untracked, or in a commit of its
//                     own since its parent). This is the ordinary two-workers-one-file case.
//   sibling           both trees were cut from the SAME parent branch and each has COMMITTED a change to the same
//                     path. Two children of one parent land into that parent, so the file is a conflict waiting in
//                     the drop zone both of them write to. This holds for ANY shared parent, not only a turnover
//                     branch: two branches cut from main that both change one file are one pair, not two unrelated
//                     collisions with main.
//   merge-target      one tree's BRANCH is the branch the other tree merges into (the other row's `parent`). This is
//                     CONTEXT and is never a reason on its own: a tree cut from main always has the primary checkout
//                     on main as its merge target, and filing on that alone is noise - four rows were filed that way
//                     in one night and every one was the reader's own checkout. The relation is added only to a pair
//                     that already names a shared file, so the sentence can say which way the work flows.
//
// ONE ORDER FOR A PAIR. `a` is always the side whose tree path sorts first, so the same two trees produce the same
// record with the same sides whichever order the rows arrive in - and a ruling stored as `pick: "a"` keeps naming the
// same tree after a rescan, a restart or a pair detected from the other side.
//
// MOST PAIRS SETTLE THEMSELVES. The order that makes the merge harder is git's question, not the reader's: the probe
// in `lib/collision-merge.js` asks `merge-tree` in both directions against the pair's two tips, `settleCollision` below
// turns the two answers into an order (exactly one clean direction names it; both clean is decided by the reader's own
// tie-break), and the sweep stores that as an automatic ruling through the same record a reader's ruling uses. Only a
// pair whose TWO directions conflict is still a card.
//
// WHO IS LIVE. A run's own activity is the scan's `live` flag (lib/scan.js: the newest of its last commit and its
// dirty files' mtimes, inside `liveMinutes`). A row that is not live is not a candidate: a dormant tree holding a
// file is not a worker stepping on anybody. This is deliberately the same flag the row draws, so a row that reads
// "quiet" can never be part of a collision the reader is told is live.
//
// THE COLLISION LINE. A worker can also see one coming before any scan does: it is about to run a migration another
// tree just changed, it is rewriting a fixture a sibling is rewriting. One line in its FINAL message says so -
//
//   COLLISION <the other tree: its path, directory name or branch> | <what you see coming, and the files>
//
// - parsed like QUEUE and MESSAGE (a leading marker, the pipe as the field break, so the text may contain anything),
// and filed against the REPORTING worker's tree. A note whose target resolves to another row of the same project is
// a reported collision and goes through the same resolution as a detected one; a note whose target resolves to
// nothing is the reader's, because no assistant owns the other side.
//
// This file is pure: no git, no jobs, no HTTP. `lib/collision-flow.js` owns the sweep that files queue rows and
// escalates, server.js owns the store instance and the snapshot overlay, and public/core/review-lane.js owns the
// Human rotation's arithmetic - each reads this module's one answer rather than re-deriving it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { isTurnoverBranchName } from "./turnover-base.js";

export const COLLISION_VERSION = 1;
// One record per PAIR (or per reported note), so the list is bounded by the overlap between live trees rather than by
// the fleet. A cap is still there: a board that cannot write the file must not grow it forever.
export const COLLISION_KEEP = 300;
export const COLLISION_FILES_CAP = 24;
export const COLLISION_NOTE_CAP = 600;
export const COLLISION_TARGET_CAP = 200;
export const COLLISION_RELATION_CAP = 6;
// A pair is escalated to the reader only after it has survived a PASS without either side standing down. A pass is
// one sweep of `lib/collision-flow.js` that actually looked at the rows, at least `COLLISION_PASS_MS` apart: the first
// sweep files the rows into the two assistants' queues, and the second (with nothing stood down) is the one that hands
// the pair over. That is the whole of "assistants first".
export const COLLISION_PASSES = 1;
export const COLLISION_PASS_MS = 2000;
// A pair that has been RESOLVED by a stand-down is kept after the detector stops seeing it, because the reason one
// side yielded is what the other side reads on its row - a record dropped on the very next sweep is a resolution
// nobody sees. It is history after this window; a reader's RULING is kept indefinitely, because it is the answer to a
// question the panel asked.
export const COLLISION_RESOLVED_KEEP_MS = 12 * 60 * 60 * 1000;
// The three states a record can be in, in the order a reader meets them. `assistants` is not "nothing happened": it is
// the panel's own rows sitting in the two queues, waiting on the pass that decides.
export const COLLISION_STATES = ["assistants", "reader", "ruled"];

// A path the way a row spells it: forward slashes, no trailing slash, no leading `./`, case folded. The same shape
// lib/review-inbox.js and lib/locks.js use, because a Windows path arrives in whatever case and separator the tool
// that wrote it liked.
export const normCollisionPath = (p) =>
  String(p ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    // `.` and empty segments are how a hand-typed path or a queue row can spell the same file two ways; git never
    // writes them, but a task's `files` can, and two spellings of one path must be one path or the evidence lies.
    .filter((seg) => seg && seg !== ".")
    .join("/")
    .toLowerCase();

/** The key of one pair: both tree paths, normalised and sorted, so A->B and B->A are one record. */
export function pairKey(one, two) {
  const a = normCollisionPath(one);
  const b = normCollisionPath(two);
  if (!a || !b) return a || b || null;
  return [a, b].sort().join("|");
}

/** A short, stable key for a queue row the panel filed: the pair hash plus the assistant it went to. */
export function filingKey(kind, key, assistantId) {
  const hash = createHash("sha1").update(String(key || "")).digest("hex").slice(0, 10);
  return `${kind}:${hash}:${String(assistantId || "").trim()}`.slice(0, 120);
}

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const nowIso = (now = Date.now()) => new Date(now).toISOString();
const eqName = (a, b) => {
  const one = String(a ?? "").trim().replace(/^refs\/heads\//, "");
  const two = String(b ?? "").trim().replace(/^refs\/heads\//, "");
  return Boolean(one) && Boolean(two) && one === two;
};
const isTurnover = (name) => {
  const branch = String(name ?? "").trim().replace(/^refs\/heads\//, "");
  return Boolean(branch) && isTurnoverBranchName(branch);
};

// THE TASK A SIDE IS WORKING. A collision is filed between two TREES, but a reader asking "is this the same work or
// two landings into main" is asking about TASKS: two trees that are both landing into main are one thing, two trees
// whose queue rows are two different pieces of work are another. So each side names the queue row that OWNS its tree,
// and the association is the queue row's OWN `worktree` field - the field the panel writes from a run's own directory
// at the cut (lib/job-trees.js `jobTreePath`, through lib/assistant/queue.js `linkTaskRun`). It is never derived from
// the branch name: a branch is what a tree happens to be called, two trees can spell one branch, a renamed branch
// would name the wrong row, and a row whose worktree moved would be missed entirely.
//
// A row that is done or parked still NAMES the side, with its state: a collision with finished work is not a
// collision the reader has to arbitrate, and the card says so instead of showing a task that reads like a live one.
// A tree with no owning row is said out loud ("no task row on this tree"); a blank line there is the ambiguity this
// whole surface exists to remove.
export const TASK_OPEN_STATES = ["queued", "running"];
export const taskOpen = (state) => TASK_OPEN_STATES.includes(String(state || ""));
// The panel's OWN queue rows for a collision - the notice it files into each side's queue and the priority row a
// ruling files. They name the same worktree as the tree they are about, so without this they would be the newest row
// in that tree and the card would answer "the task here is the collision notice" - a sentence that says nothing about
// what either side is WORKING. `lib/collisions.js` `filingKey` writes both prefixes.
const PANEL_NOTICE = /^collision(-rule)?:/i;

/** One queue row as a collision side names it: id, its own title, the state and the assistant whose queue holds it. */
export function sideTaskOf(task = null, queue = {}) {
  if (!task) return null;
  const id = Number(task.id ?? task.taskId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const state = task.state ? String(task.state).trim() || null : null;
  return {
    id,
    name: clip(task.title ?? task.name, COLLISION_NOTE_CAP) || null,
    state,
    // `null` is "the board does not know", never false: an older record carries an id with no state, and a card that
    // read that as done would call live work finished.
    open: state ? taskOpen(state) : null,
    assistantId: task.assistantId || queue.assistantId ? String(task.assistantId || queue.assistantId) : null,
    assistant: task.assistant || queue.assistant ? String(task.assistant || queue.assistant) : null,
  };
}

/**
 * The queue row that owns one tree, out of every assistant's queue.
 *
 * `queues` is `[{assistantId, assistant, tasks}]`. A row matches when its OWN `worktree` field normalises to the
 * tree's path, and the answer is the newest OPEN row - a tree can carry the history of its earlier tasks and one live
 * row, and the live one is what the side is working. With no open row the newest finished row is named, because
 * "this side's task is done" is the second thing the reader needs to know. Null means no row on any queue names the
 * tree: the card says exactly that rather than leaving the line blank.
 */
export function owningTaskFor(tree = "", queues = []) {
  const want = normCollisionPath(tree);
  if (!want) return null;
  let best = null;
  for (const queue of Array.isArray(queues) ? queues : []) {
    for (const task of queue?.tasks || []) {
      if (!task || !task.worktree) continue;
      if (PANEL_NOTICE.test(String(task.carriedKey || ""))) continue;
      if (normCollisionPath(task.worktree) !== want) continue;
      const row = sideTaskOf(task, queue);
      if (!row) continue;
      if (!best) {
        best = row;
        continue;
      }
      // An open row beats a finished one; inside a class the newest id wins.
      if (row.open && !best.open) best = row;
      else if (row.open === best.open && Number(row.id) > Number(best.id)) best = row;
    }
  }
  return best;
}

/** One side of a collision, as the record keeps it: enough to name the tree without a lookup, and the queue task
 * driving it when the board knows one. */
export function sideOf(row = {}) {
  const treePath = String(row.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const taskId = Number(row.taskId);
  // A side carries the RESOLVED queue row (`row.task` from `owningTaskFor`) when the sweep had a resolver, and the
  // bare id when it only had one: the number is what a ruling row and the queue's own "task #12" sentence read, and
  // the name, state and assistant are what the card prints beside the tree.
  const task =
    sideTaskOf(row.task || null) ||
    (Number.isInteger(taskId) && taskId > 0 ? sideTaskOf({ id: taskId }) : null);
  return {
    path: treePath,
    name: treePath.split("/").filter(Boolean).pop() || treePath,
    branch: row.branch ? String(row.branch) : null,
    // The commit the tree stands on, when the scan read one: it is the TIP the merge question is asked of
    // (`lib/collision-merge.js`), so a pair is probed at the sha it was detected at rather than at a branch name that
    // may have moved since.
    head: row.head ? String(row.head).trim().toLowerCase() : null,
    parent: row.parent ? String(row.parent) : null,
    // The task standing in this tree, never guessed: a side with no open queue task answers null and the card
    // simply does not name a number.
    taskId: task ? task.id : null,
    task,
  };
}

/**
 * The sides of a pair whose OWN task is finished (done or parked). A collision that is half finished work is not a
 * question for the reader: the work it was about has been laid down. Derived on every read, never written to the
 * record, so a tree that picks the work up again comes back as a live side instead of staying "stood down" forever.
 */
export function finishedSides(rec = {}) {
  const out = [];
  for (const side of ["a", "b"]) {
    const task = rec?.[side]?.task || null;
    if (!task || task.open !== false) continue;
    out.push({
      side,
      tree: rec[side]?.name || null,
      path: rec[side]?.path || null,
      taskId: task.id,
      name: task.name || null,
      state: task.state || null,
      assistant: task.assistant || null,
    });
  }
  return out;
}

/**
 * What this row is touching: its dirty files, its untracked files, and the files its own commits change since the
 * parent it was cut from. Three sets, kept apart so the evidence can say which one produced the shared path - a
 * shared COMMIT file is the one that conflicts in the parent branch, a shared dirty file is the one being written now.
 */
export function touchedOf(row = {}) {
  const dirty = new Set();
  for (const f of row?.dirtyFiles || []) {
    const p = normCollisionPath(f && typeof f === "object" ? f.path : f);
    if (p) dirty.add(p);
  }
  for (const f of row?.untrackedFiles || []) {
    const p = normCollisionPath(f);
    if (p) dirty.add(p);
  }
  const commits = new Set();
  for (const f of row?.commitFiles || []) {
    const p = normCollisionPath(f);
    if (p) commits.add(p);
  }
  const all = new Set([...dirty, ...commits]);
  return { dirty: [...dirty].sort(), commits: [...commits].sort(), all: [...all].sort() };
}

/** Is this row a live run the detector should look at? The scan's own `live`, and a tree that really has a branch. */
export function isLiveRow(row = {}) {
  if (!row || !row.path) return false;
  if (row.released) return false;
  if (row.live !== true) return false;
  const branch = String(row.branch || "").trim();
  return Boolean(branch) && branch !== "HEAD";
}

const intersect = (a = [], b = []) => {
  const set = new Set(b);
  return a.filter((p) => set.has(p));
};

/**
 * Every collision between the live rows of one project, in one pass.
 *
 * `rows` is any iterable of scanned rows carrying `project` (server.js `rowsWithProject`). Rows of different projects
 * are never compared: two projects are two repositories, and the same relative path in both is not a shared file.
 *
 * Returns `[{key, project, a, b, files, relations}]` - `a` and `b` are `sideOf` records in PATH ORDER (so the pair is
 * the same record whichever side it is detected from), `files` the evidence paths (capped), `relations` the reason(s)
 * this pair is a collision. A pair with no shared path is not returned at all: `merge-target` on its own is not
 * evidence, it is a fact about every tree cut from the branch it lands into.
 */
export function detectCollisions(rows = []) {
  const live = [];
  for (const row of rows || []) {
    if (!isLiveRow(row)) continue;
    live.push({ row, project: String(row.project || ""), side: sideOf(row), touch: touchedOf(row) });
  }
  const out = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const one = live[i];
      const two = live[j];
      if (!one.project || one.project !== two.project) continue;
      if (normCollisionPath(one.side.path) === normCollisionPath(two.side.path)) continue;
      // ONE ORDER, always: the pair must read the same from either side, because a ruling stored as a side names
      // a tree and a rescan that swapped the sides would silently rule on the other one.
      const first = normCollisionPath(one.side.path) <= normCollisionPath(two.side.path) ? one : two;
      const second = first === one ? two : one;
      const shared = intersect(first.touch.all, second.touch.all);
      // Two children of one parent branch whose OWN commits change the same file: the conflict this names waits in
      // the parent they both land into rather than in either tree, so it is one relation and not also the ordinary
      // shared-file one - the same path counted twice would say the same thing twice.
      const siblings =
        first.side.parent && second.side.parent && eqName(first.side.parent, second.side.parent)
          ? intersect(first.touch.commits, second.touch.commits).slice(0, COLLISION_FILES_CAP)
          : [];
      const siblingSet = new Set(siblings);
      const working = shared.filter((p) => !siblingSet.has(p));
      const relations = [];
      // 1. the same file, touched by both. The ordinary case, and the one the marker's tooltip names first.
      if (working.length) {
        relations.push({ kind: "shared-file", files: working.slice(0, COLLISION_FILES_CAP) });
      }
      // 2. two children of one parent that each committed a change to the same path. Any parent counts: a turnover
      //    branch is the drop zone this relation was first written for, and main is the one every tree lands into.
      if (siblings.length) {
        relations.push({ kind: "sibling", parent: first.side.parent, files: siblings, turnover: isTurnover(first.side.parent) });
      }
      // 3. the branch relation, as CONTEXT on a pair that already has a shared path - never the reason for one. The
      //    landing side's own branch travels with it, so the sentence reads the same from either row.
      if (relations.length) {
        if (eqName(first.side.branch, second.side.parent)) {
          relations.push({ kind: "merge-target", lander: "b", branch: second.side.branch, target: first.side.branch });
        } else if (eqName(second.side.branch, first.side.parent)) {
          relations.push({ kind: "merge-target", lander: "a", branch: first.side.branch, target: second.side.branch });
        }
      }
      if (!relations.length) continue;
      const files = [...new Set([...working, ...siblings])];
      out.push({
        key: pairKey(first.side.path, second.side.path),
        project: first.project,
        a: first.side,
        b: second.side,
        files: files.slice(0, COLLISION_FILES_CAP),
        relations: relations.slice(0, COLLISION_RELATION_CAP),
      });
    }
  }
  return out;
}

/** The COLLISION grammar: a leading marker and ONE pipe. Anything after the pipe is the worker's own sentence. */
export function parseCollisionLines(text = "") {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*COLLISION\s+(.+?)\s*\|\s*(.+)$/i.exec(line);
    if (!m) continue;
    const target = clip(m[1], COLLISION_TARGET_CAP);
    const said = clip(m[2], COLLISION_NOTE_CAP);
    if (!target || !said) continue;
    out.push({ target, text: said });
  }
  return out;
}

/** The lines that LOOK like a COLLISION marker and could not be read, so the harvest can say so instead of dropping them. */
export function brokenCollisionLines(text = "") {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!/^\s*COLLISION\b/i.test(line)) continue;
    if (/^\s*COLLISION\s+(.+?)\s*\|\s*(.+)$/i.test(line)) continue;
    out.push(clip(line, COLLISION_NOTE_CAP));
  }
  return out;
}

/**
 * A target as a worker wrote it, resolved against the rows of one project: the tree's full path, a path suffix, its
 * directory name, or its branch. A target that names nothing comes back null, and the caller keeps the sentence the
 * worker wrote rather than inventing a tree.
 */
export function resolveCollisionTarget(rows = [], target = "", project = null) {
  const want = normCollisionPath(target);
  if (!want) return null;
  const list = [...(rows || [])].filter((r) => r && r.path && (!project || String(r.project || "") === String(project)));
  const exact = list.find((r) => normCollisionPath(r.path) === want);
  if (exact) return exact;
  const bySuffix = list.find((r) => normCollisionPath(r.path).endsWith(`/${want}`));
  if (bySuffix) return bySuffix;
  const byName = list.find((r) => String(r.name || "").toLowerCase() === want.replace(/^.*\//, ""));
  if (byName) return byName;
  const byBranch = list.find((r) => String(r.branch || "").toLowerCase() === want);
  return byBranch || null;
}

/** The one relation sentence a reader is told, in the order the marker reads. Pure, so a test and the page agree. */
export function relationSentence(relations = [], otherName = "the other tree") {
  const bits = [];
  for (const rel of relations || []) {
    if (rel.kind === "shared-file") bits.push(`${rel.files.length} shared file${rel.files.length === 1 ? "" : "s"} with ${otherName}`);
    else if (rel.kind === "merge-target") bits.push(`${rel.branch || otherName} lands into ${rel.target}`);
    else if (rel.kind === "sibling" || rel.kind === "sibling-turnover") bits.push(`${rel.files.length} file${rel.files.length === 1 ? "" : "s"} both changed under ${rel.parent}`);
  }
  return bits.join("; ");
}

/** The state a record reads as: a ruling wins over an escalation, and an escalation over the assistants' pass. */
export function stateOf(rec = {}) {
  if (rec.ruling) return "ruled";
  if (rec.readerAt) return "reader";
  return "assistants";
}

// ---- THE MERGE QUESTION -----------------------------------------------------------------------------------------
// A pair used to become a card the reader had to rule on, one at a time, for work that mostly settles itself: two
// trees touching one file rarely disagree about the CONTENT, and the order between them is then a matter of judgement
// a rule can make instead of a person. git already answers the question that matters - can this side's work be merged
// onto the other's - in the object database, in milliseconds, with no checkout, no model and no worker turn
// (`lib/collision-merge.js` runs it; this module decides what the answer MEANS).
//
// Two directions are asked, in the reader's own terms: `aFirst` is clean when B's tip merges onto A's tip without a
// conflict, so A can land first and B still merges onto it, and `bFirst` is the same question the other way round.
// Exactly one clean direction names the order. Both clean is the ordinary case and the reader's own tie-break settles
// it: older cut first, then fewer commits, then the branch name, so one pair always settles the same way however
// often it is seen. Both conflicting is the ONE case that is still the reader's.
//
// These functions are pure: the probe's answer arrives as data, which is what lets the three fixtures be a table
// instead of a temporary repository.
const msOf = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
};
const countOf = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const sideName = (side, fallback) => String(side?.name || side?.branch || fallback || "a tree");

/**
 * The deterministic pick for a pair git can merge either way: the older cut first, then fewer commits, then the
 * branch name. `pick` is `a` or `b` and is never null, because two sides always compare; `basis` is the fact that
 * decided it, which is the reason the reader is shown.
 */
export function deterministicPick(a = {}, b = {}, facts = {}) {
  const one = facts.a && typeof facts.a === "object" ? facts.a : {};
  const two = facts.b && typeof facts.b === "object" ? facts.b : {};
  const cutA = msOf(one.cutAt);
  const cutB = msOf(two.cutAt);
  // An older cut goes first. Only two KNOWN cuts compare: a missing one is not "infinitely old".
  if (cutA !== null && cutB !== null && cutA !== cutB) return { pick: cutA < cutB ? "a" : "b", basis: "older cut" };
  const nA = countOf(one.commits);
  const nB = countOf(two.commits);
  if (nA !== null && nB !== null && nA !== nB) return { pick: nA < nB ? "a" : "b", basis: "fewer commits" };
  const branchA = String(a?.branch || "").replace(/^refs\/heads\//, "").toLowerCase();
  const branchB = String(b?.branch || "").replace(/^refs\/heads\//, "").toLowerCase();
  if (branchA && branchB && branchA !== branchB) return { pick: branchA < branchB ? "a" : "b", basis: "branch name" };
  // No comparable fact at all: `a` is the side whose path sorts first (`detectCollisions`), so answering `a` is still
  // the same answer every time this pair is seen.
  return { pick: "a", basis: "the pair's own order" };
}

/**
 * What the panel does with a pair, from git's two answers. `rec` is a pair record (or a detected pair): its two sides
 * and its `merge` evidence. Answers `{pick, why, basis, reason}` - `pick` null means the order cannot be settled
 * without the reader, and `why` says which of the four situations produced that.
 */
export function settleCollision(rec = {}) {
  const a = rec?.a || {};
  const b = rec?.b || {};
  const aName = sideName(a, "the first side");
  const bName = sideName(b, "the second side");
  const aFirst = rec?.merge?.aFirst?.clean ?? null;
  const bFirst = rec?.merge?.bFirst?.clean ?? null;
  const cleanA = aFirst === true;
  const cleanB = bFirst === true;
  if (cleanA && !cleanB) {
    return { pick: "a", why: "one-direction", basis: "merge", reason: `${bName} merges onto ${aName} without a conflict, so ${aName} goes first` };
  }
  if (cleanB && !cleanA) {
    return { pick: "b", why: "one-direction", basis: "merge", reason: `${aName} merges onto ${bName} without a conflict, so ${bName} goes first` };
  }
  if (cleanA && cleanB) {
    const chosen = deterministicPick(a, b, { a: rec.merge.a, b: rec.merge.b });
    const why =
      chosen.basis === "older cut"
        ? "no merge risk either way, and the older cut goes first"
        : chosen.basis === "fewer commits"
          ? "no merge risk either way, and the side with fewer commits goes first"
          : chosen.basis === "branch name"
            ? "no merge risk either way, and the branch name breaks the tie"
            : "no merge risk either way, and the pair's own order breaks the tie";
    return { pick: chosen.pick, why: "both-clean", basis: chosen.basis, reason: why };
  }
  if (aFirst === false && bFirst === false) {
    return { pick: null, why: "both-conflict", basis: "merge", reason: "both directions conflict, so the order is the reader's to choose" };
  }
  return { pick: null, why: "unknown", basis: "merge", reason: "git could not answer the merge question in either direction" };
}

/**
 * Is this pair allowed to reach the reader? Only a pair git cannot order does: both directions conflict, the question
 * could not be answered at all, or the reader withdrew an automatic pick (which is the reader saying "this one is
 * mine"). A pair with one clean direction, or two, is settled by `settleCollision` instead.
 */
export function mayAskReader(rec = {}) {
  if (rec?.autoWithheld) return true;
  return rec?.merge?.aFirst?.clean !== true && rec?.merge?.bFirst?.clean !== true;
}

/**
 * A side's stand-down, in one shape wherever it is read. Older records stored the bare timestamp, and a card that
 * cannot say WHY a side yielded is the "somebody reconciled this by hand" state this surface exists to remove, so the
 * reason (the notice task and its state) is kept with it. `{at, taskId, state, name}` for each side that stood down.
 */
export function stoodDownOf(value) {
  const raw = value && typeof value === "object" ? value : {};
  const out = {};
  for (const side of ["a", "b"]) {
    const entry = raw[side];
    if (!entry) continue;
    if (typeof entry === "string") {
      out[side] = { at: entry, taskId: null, state: null, name: null };
      continue;
    }
    const taskId = Number(entry.taskId);
    out[side] = {
      at: entry.at || null,
      taskId: Number.isInteger(taskId) && taskId > 0 ? taskId : null,
      state: entry.state ? String(entry.state) : null,
      name: entry.name ? String(entry.name) : null,
    };
  }
  return out;
}

// ---- the store -------------------------------------------------------------------------------------------------
// One JSON document, beside the other per-row stores (lib/paths.js `collisionsFile`). Written temp+rename like every
// store here: a crash mid-write leaves the previous list, never half of one.
export class CollisionBook {
  constructor({ file = null, log = () => {}, now = () => Date.now() } = {}) {
    this.file = file;
    this.log = log;
    this.now = now;
    this.records = new Map();
    this.loaded = false;
    this.onChange = null;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const rows = raw && typeof raw === "object" && Array.isArray(raw.records) ? raw.records : [];
      for (const rec of rows) {
        if (!rec || typeof rec !== "object") continue;
        const key = String(rec.key || "").trim();
        if (!key) continue;
        this.records.set(key, {
          key,
          project: rec.project ? String(rec.project) : null,
          source: rec.source === "reported" ? "reported" : "detected",
          a: rec.a && rec.a.path ? sideOf(rec.a) : null,
          b: rec.b && rec.b.path ? sideOf(rec.b) : null,
          // A target the worker wrote that named no row: kept as written, so the note still says what it saw.
          bTarget: rec.bTarget ? clip(rec.bTarget, COLLISION_TARGET_CAP) : null,
          files: (Array.isArray(rec.files) ? rec.files : []).map(normCollisionPath).filter(Boolean).slice(0, COLLISION_FILES_CAP),
          relations: Array.isArray(rec.relations) ? rec.relations.slice(0, COLLISION_RELATION_CAP) : [],
          notes: (Array.isArray(rec.notes) ? rec.notes : []).filter((n) => n && String(n.text || "").trim()).slice(-20),
          firstAt: rec.firstAt || null,
          lastAt: rec.lastAt || null,
          passAt: rec.passAt || null,
          passes: Math.max(0, Number(rec.passes) || 0),
          filed: rec.filed && typeof rec.filed === "object" ? rec.filed : {},
          stoodDown: stoodDownOf(rec.stoodDown),
          readerAt: rec.readerAt || null,
          readerWhy: rec.readerWhy || null,
          ruling: rec.ruling && typeof rec.ruling === "object" ? rec.ruling : null,
          // git's own answer about this pair (`lib/collision-merge.js`), kept with the record so the card can say WHY
          // a pair is the reader's instead of only that it is. Null on a record detected before this answer existed.
          merge: rec.merge && typeof rec.merge === "object" ? rec.merge : null,
          // Set when the reader withdrew an AUTOMATIC pick: the sweep must not put the same order straight back, and
          // the pair is the reader's from then on.
          autoWithheld: rec.autoWithheld && typeof rec.autoWithheld === "object" ? rec.autoWithheld : null,
        });
      }
    } catch (err) {
      if (existsSync(this.file)) this.log(`collisions: could not read ${this.file} (${String((err && err.message) || err)}) - starting empty`);
    }
    return this;
  }

  save() {
    if (!this.file) return { ok: false, error: "no collisions file is configured" };
    this.load();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      // Newest last, so the cap drops the oldest history rather than a live pair: a ruling is worth keeping even when
      // the pair has not been seen for a day.
      const records = [...this.records.values()].sort((x, y) => String(x.firstAt || "").localeCompare(String(y.firstAt || ""))).slice(-COLLISION_KEEP);
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ version: COLLISION_VERSION, savedAt: nowIso(this.now()), records }, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      return { ok: true, file: this.file, records: records.length };
    } catch (err) {
      const error = String((err && err.message) || err);
      this.log(`collisions: could not write ${this.file} (${error})`);
      return { ok: false, error };
    }
  }

  changed() {
    try {
      this.onChange?.();
    } catch {
      /* a listener's error is never the store's failure */
    }
  }

  get(key) {
    this.load();
    return key ? this.records.get(String(key)) || null : null;
  }

  all() {
    this.load();
    return [...this.records.values()];
  }

  /**
   * One detected pair, folded into the store. A NEW pair starts its first pass; a pair seen again keeps its firstAt,
   * its ruling and its filings, takes the fresh evidence, and ticks exactly one PASS (a sweep that arrives inside
   * `COLLISION_PASS_MS` of the last one is the same look, not a second one).
   */
  upsertDetected(pair, at = this.now()) {
    this.load();
    const now = nowIso(at);
    const existing = this.records.get(pair.key);
    if (!existing) {
      const rec = {
        key: pair.key,
        project: pair.project || null,
        source: "detected",
        a: pair.a,
        b: pair.b,
        bTarget: null,
        files: (pair.files || []).slice(0, COLLISION_FILES_CAP),
        relations: (pair.relations || []).slice(0, COLLISION_RELATION_CAP),
        notes: [],
        firstAt: now,
        lastAt: now,
        passAt: now,
        passes: 1,
        filed: {},
        stoodDown: {},
        readerAt: null,
        readerWhy: null,
        ruling: null,
        merge: pair.merge && typeof pair.merge === "object" ? pair.merge : null,
        autoWithheld: null,
      };
      this.records.set(rec.key, rec);
      return { record: rec, isNew: true, passTicked: true };
    }
    // The fresh sides win - they are what the sweeps just resolved - except that a side whose resolver was not
    // consulted (no `taskFor` in this sweep) keeps the task the record already names, rather than blanking the card.
    existing.a = { ...pair.a, task: pair.a?.task ?? existing.a?.task ?? null, taskId: pair.a?.taskId ?? existing.a?.taskId ?? null };
    existing.b = { ...pair.b, task: pair.b?.task ?? existing.b?.task ?? null, taskId: pair.b?.taskId ?? existing.b?.taskId ?? null };
    existing.project = pair.project || existing.project;
    existing.files = (pair.files || []).slice(0, COLLISION_FILES_CAP);
    existing.relations = (pair.relations || []).slice(0, COLLISION_RELATION_CAP);
    // A fresh merge answer replaces the old one, so a record whose first probe failed is repaired by the next sweep
    // that can answer; a sweep that did not probe at all (no `probeMerge` wired) leaves the evidence alone.
    if (pair.merge && typeof pair.merge === "object") existing.merge = pair.merge;
    existing.lastAt = now;
    const due = !existing.passAt || at - Date.parse(existing.passAt) >= COLLISION_PASS_MS;
    if (due) {
      existing.passes += 1;
      existing.passAt = now;
    }
    return { record: existing, isNew: false, passTicked: due };
  }

  /**
   * A worker's COLLISION line, filed against the reporting worker's tree. `other` is the resolved row when the target
   * named one; without it the record keeps the target as written and is the reader's, because no assistant owns the
   * side the worker could not name.
   *
   * The same run reporting the same target twice updates the sentence instead of appending a second note.
   */
  recordNote({ project = null, treePath = null, branch = null, target = "", text = "", runId = null, thread = null, other = null, at = null } = {}) {
    this.load();
    const mine = sideOf({ path: treePath, branch });
    if (!mine.path) return { saved: false, error: "a COLLISION note needs the reporting tree's path" };
    const said = clip(text, COLLISION_NOTE_CAP);
    const named = clip(target, COLLISION_TARGET_CAP);
    if (!said) return { saved: false, error: "a COLLISION note needs a sentence after the pipe" };
    const stamp = at || nowIso(this.now());
    const key = other && other.path ? pairKey(mine.path, other.path) : `note:${normCollisionPath(mine.path)}:${clip(target, 80).toLowerCase()}`;
    let rec = this.records.get(key);
    if (!rec) {
      rec = {
        key,
        project: project ? String(project) : null,
        source: "reported",
        a: mine,
        b: other && other.path ? sideOf(other) : null,
        bTarget: other && other.path ? null : named,
        files: [],
        relations: [],
        notes: [],
        firstAt: stamp,
        lastAt: stamp,
        passAt: stamp,
        passes: 1,
        filed: {},
        stoodDown: {},
        // A note with NO counterpart goes straight to the reader: there is no other assistant to file a row into.
        readerAt: other && other.path ? null : stamp,
        readerWhy: other && other.path ? null : "reported - the target names no row on this board",
        ruling: null,
      };
      this.records.set(key, rec);
    }
    rec.lastAt = stamp;
    rec.source = "reported";
    if (other && other.path) {
      rec.b = sideOf(other);
      rec.bTarget = null;
    }
    const same = rec.notes.find((n) => n.runId && runId && String(n.runId) === String(runId) && normCollisionPath(n.target) === normCollisionPath(named));
    if (same) {
      same.text = said;
      same.at = stamp;
    } else {
      rec.notes.push({ at: stamp, text: said, target: named, runId: runId ? String(runId) : null, thread: thread ? String(thread) : null });
      rec.notes = rec.notes.slice(-20);
    }
    // The worker's own words are evidence too: a note that names files puts them on the record when the scan had none.
    const wrote = this.save();
    return { saved: wrote.ok, record: rec, line: `⇢ COLLISION noted against ${mine.name}: ${said}${rec.bTarget ? ` (no row named "${rec.bTarget}")` : ""}`, error: wrote.ok ? null : wrote.error };
  }

  /**
   * A side's queue row was closed (done or parked): it stood down, and the pair no longer escalates on the pass rule.
   * The REASON travels with it (`taskId` and the task's own state), because the card has to say why one side yielded
   * rather than only that it did - on both rows.
   */
  standDown(key, side, detail = {}, at = this.now()) {
    const rec = this.records.get(String(key));
    if (!rec || (side !== "a" && side !== "b")) return null;
    if (rec.stoodDown[side]) return rec;
    const info = typeof detail === "string" ? { at: detail } : detail || {};
    const taskId = Number(info.taskId);
    rec.stoodDown[side] = {
      at: nowIso(at),
      taskId: Number.isInteger(taskId) && taskId > 0 ? taskId : null,
      state: info.state ? String(info.state) : null,
      name: rec[side]?.name || null,
    };
    return rec;
  }

  /** Hand the pair to the reader: the collision now counts on the Human button and H steps into it. */
  escalate(key, { why = "no-stand-down", at = this.now() } = {}) {
    const rec = this.records.get(String(key));
    if (!rec || rec.ruling || rec.readerAt) return rec || null;
    rec.readerAt = nowIso(at);
    rec.readerWhy = String(why || "no-stand-down");
    return rec;
  }

  /** The reader asking for it now, before the pass would have handed it over (the "or when he asks" case). */
  ask(key, { at = this.now(), by = "reader" } = {}) {
    const rec = this.escalate(key, { why: `asked by ${by}`, at });
    if (rec) rec.readerWhy = `asked by ${by}`;
    return rec;
  }

  /**
   * The reader's ruling: which side goes first. Stored AGAINST THE PAIR, so a collision that is detected again after
   * this renders as already ruled instead of coming back as a fresh question. `pick` is `a` or `b`; `clear` withdraws
   * the ruling and puts the pair back where it was.
   *
   * `auto` marks a pick the PANEL made from git's two answers rather than one the reader made (`lib/collision-merge.js`
   * plus `settleCollision`), and `reason` is the sentence that pick is explained with. It is the same store, the same
   * record and the same withdraw path: an automatic pick is a normal ruling that says who made it, which is what lets
   * the reader overrule it with one press. Withdrawing an AUTOMATIC pick also sets `autoWithheld`, so the very next
   * sweep does not put the same order straight back: from then on the pair is the reader's.
   */
  rule(key, { pick = "", note = "", by = "reader", at = this.now(), auto = false, reason = "", basis = null } = {}) {
    const rec = this.records.get(String(key));
    if (!rec) return { ok: false, error: `no collision is recorded for ${String(key || "(none)")}` };
    const choice = String(pick || "").trim().toLowerCase();
    if (choice === "clear") {
      const was = rec.ruling;
      rec.ruling = null;
      if (was && was.auto) {
        rec.autoWithheld = { at: nowIso(at), pick: was.pick || null, name: was.name || null, reason: was.reason || null };
      }
      const wrote = this.save();
      return { ok: true, changed: true, record: rec, say: "the ruling is withdrawn", error: wrote.ok ? null : wrote.error };
    }
    if (choice !== "a" && choice !== "b") return { ok: false, error: "a ruling is `a`, `b` or `clear` - the side that goes first" };
    const side = choice === "a" ? rec.a : rec.b;
    if (!side || !side.path) return { ok: false, error: "that side of the collision no longer names a tree, so nothing can go first" };
    rec.ruling = {
      at: nowIso(at),
      pick: choice,
      path: side.path,
      name: side.name,
      // The task the rule is about, when the board knows one: the card and the queue rows both say "#12 goes first".
      taskId: side.taskId ?? null,
      by: auto ? "auto" : String(by || "reader"),
      // Both owning assistants have to be able to tell an automatic order from the reader's own: this pair of fields
      // is what the Ruled row, the card and the review lane read.
      auto: Boolean(auto),
      reason: clip(reason, COLLISION_NOTE_CAP) || null,
      basis: basis ? String(basis) : null,
      note: clip(note, COLLISION_NOTE_CAP),
    };
    const wrote = this.save();
    return {
      ok: true,
      changed: true,
      record: rec,
      say: `${side.name} goes first on ${rec.files.length ? `${rec.files.length} shared file${rec.files.length === 1 ? "" : "s"}` : "this overlap"}`,
      error: wrote.ok ? null : wrote.error,
    };
  }

  /** Drop a reported note the reader has read. A detected pair is never dropped this way: the next sweep sees it again. */
  forget(key) {
    this.load();
    const rec = this.records.get(String(key));
    if (!rec) return { ok: false, error: `no collision is recorded for ${String(key || "(none)")}` };
    if (rec.source !== "reported") return { ok: false, error: "that collision is detected, not reported" };
    this.records.delete(rec.key);
    const wrote = this.save();
    return { ok: true, say: "the note is gone", error: wrote.ok ? null : wrote.error };
  }

  /** A pair no longer detected. Its record stays while it has a ruling or the reader is reading it; the rest is history. */
  closeUndetected(seenKeys, at = this.now()) {
    this.load();
    const keep = new Set(seenKeys || []);
    const dropped = [];
    for (const rec of [...this.records.values()]) {
      if (keep.has(rec.key)) continue;
      if (rec.ruling || rec.readerAt || rec.source === "reported") continue;
      // A stand-down is a decision too: the pair is kept while its reason can still be read on both rows.
      const stood = rec.stoodDown?.a || rec.stoodDown?.b || null;
      if (stood) {
        const when = Date.parse(stood.at || rec.lastAt || "");
        if (Number.isFinite(when) && at - when < COLLISION_RESOLVED_KEEP_MS) continue;
      }
      this.records.delete(rec.key);
      dropped.push(rec.key);
    }
    return { dropped, at: nowIso(at) };
  }

  /**
   * What one tree's row draws: every collision it is part of, most urgent first. `role` says which side of the record
   * this tree is and `other` names the counterpart, while `a` and `b` carry BOTH sides so the card can draw the pair
   * once and name both trees on both rows - a card that only knew its own side is the one each side had to reconcile
   * by hand.
   */
  forTree(treePath = "") {
    this.load();
    const want = normCollisionPath(treePath);
    if (!want) return [];
    const out = [];
    for (const rec of this.records.values()) {
      const a = rec.a && normCollisionPath(rec.a.path) === want;
      const b = rec.b && normCollisionPath(rec.b.path) === want;
      if (!a && !b) continue;
      const other = a ? rec.b : rec.a;
      // The sides whose own task is finished, derived on every read: the card names them as already stood down and the
      // reader's rotation skips the pair, because a collision with finished work is not a decision waiting on anybody.
      const stoodByTask = finishedSides(rec);
      out.push({
        key: rec.key,
        state: stateOf(rec),
        stoodByTask,
        waiting: stateOf(rec) === "reader" && stoodByTask.length === 0,
        role: a ? "a" : "b",
        project: rec.project,
        source: rec.source,
        a: rec.a ? { ...rec.a } : null,
        b: rec.b ? { ...rec.b } : null,
        other: other ? { ...other } : null,
        otherTarget: !other ? rec.bTarget : null,
        files: [...rec.files],
        relations: rec.relations,
        notes: rec.notes.slice(-5),
        firstAt: rec.firstAt,
        lastAt: rec.lastAt,
        passes: rec.passes,
        readerAt: rec.readerAt,
        readerWhy: rec.readerWhy,
        stoodDown: ["a", "b"].filter((side) => rec.stoodDown[side]).map((side) => ({ side, name: rec[side]?.name || null, ...rec.stoodDown[side] })),
        filed: Object.entries(rec.filed || {}).map(([assistantId, f]) => ({ assistantId, ...f })),
        ruling: rec.ruling ? { ...rec.ruling } : null,
        // git's own answer, so the card can say why a pair is the reader's; and whether the reader has already
        // overruled an automatic pick, so the card can say that instead of showing the same pick again.
        merge: rec.merge ? { ...rec.merge } : null,
        autoWithheld: rec.autoWithheld ? { ...rec.autoWithheld } : null,
        // The reader's own way out of a pair that has not been handed over yet.
        canAsk: !rec.ruling && !rec.readerAt,
      });
    }
    const rank = { reader: 0, assistants: 1, ruled: 2 };
    out.sort((x, y) => (rank[x.state] ?? 3) - (rank[y.state] ?? 3) || String(x.firstAt || "").localeCompare(String(y.firstAt || "")));
    return out;
  }

  /** What GET /api/collisions answers and what a test reads. */
  state() {
    this.load();
    const records = [...this.records.values()]
      .map((rec) => ({
        ...rec,
        state: stateOf(rec),
        a: rec.a ? { ...rec.a } : null,
        b: rec.b ? { ...rec.b } : null,
        notes: rec.notes.slice(-20),
      }))
      .sort((x, y) => String(y.lastAt || "").localeCompare(String(x.lastAt || "")));
    return { count: records.filter((r) => r.state === "reader").length, total: records.length, byState: countStates(records), records };
  }
}

export function countStates(records = []) {
  const out = { assistants: 0, reader: 0, ruled: 0 };
  for (const rec of records || []) out[stateOf(rec)] += 1;
  return out;
}
