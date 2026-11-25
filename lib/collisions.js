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
// ONE ORDER FOR A PAIR. `a` is always the side whose tree IDENTITY sorts first - the six-hex tag the panel's own
// rename keeps (lib/tree-names.js), the normalised path for a tree that carries none - so the same two trees produce
// the same record with the same sides whichever order the rows arrive in, across a rename, a rescan, a restart or a
// pair detected from the other side. A ruling stored as `pick: "a"` therefore keeps naming the same tree even when
// the directory under it has been renamed.
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
// a reported collision and goes through the same resolution as a detected one.
//
// RESOLVED BY ABSENCE. A note whose target resolves to NO row and to NO live agent is not a question: there is no
// second side to order, so no ruling exists that the reader could give, and holding it on the Human button asks for a
// ruling nobody can make. It is recorded as `absent` - a VERDICT, kept with the words the worker wrote and the answer
// the board gave, drawn as settled and counted resolved by the chip. Only a target that names something ALIVE (a live
// run's tree, even one whose row is not written yet) still reaches the reader, because that is the one case where a
// person can see what the board cannot.
//
// This file is pure of git, jobs and HTTP: the only thing it reads off the disk is a directory listing, when an
// untracked path is a directory and the files beneath it are the evidence (`filesUnder`) - never a repository.
// `lib/collision-flow.js` owns the sweep that files queue rows and escalates, server.js owns the store instance and the
// snapshot overlay, and public/core/review-lane.js owns the Human rotation's arithmetic - each reads this module's one
// answer rather than re-deriving it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { isTurnoverBranchName } from "./turnover-base.js";
import { tagOf } from "./tree-names.js";

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
// The four states a record can be in, in the order a reader meets them. `assistants` is not "nothing happened": it is
// the panel's own rows sitting in the two queues, waiting on the pass that decides. `superseded` is HISTORY: a landing
// carried one side into main after the report was stamped, so the pair is over and the card is kept for the record
// rather than asked again. `absent` is the other verdict: a note whose target named no row and no live agent, kept so
// the report is still readable and counted resolved, never held on the Human button.
export const COLLISION_STATES = ["assistants", "reader", "ruled", "superseded", "absent"];
// How often a record's landing question may be re-asked: a branch tip that is in main stays in main, and a tip that is
// not needs a new commit before the answer can change, so a sweep every ten seconds must not spawn git for it.
export const COLLISION_LAND_RECHECK_MS = 30 * 1000;
// How many records ONE sweep may measure with git or ask about a landing. The pair probe has its own cap
// (`lib/collision-flow.js` COLLISION_PROBE_CAP); these are the two facts a reported note needs and neither is free.
export const COLLISION_FACT_CAP = 6;
// How many pairs ONE sweep may read the manifest content of, to answer the version-line question. One pair costs a
// handful of small file reads and no git at all when the bump is on disk, so the cap is a ceiling on a burst.
export const COLLISION_VERSION_CAP = 6;

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

// A record's two normalised paths, computed once per record object. `viewsFor` runs once per row (155 of them per
// snapshot build) and re-normalised BOTH sides of EVERY record on each of those calls - measured 2026-11-24, ~130ms
// of a 1.3s build. Records are replaced rather than mutated, so a WeakMap keyed by the record cannot go stale.
const normSides = new WeakMap();
function normSidesOf(rec) {
  let hit = normSides.get(rec);
  if (hit) return hit;
  hit = { a: rec.a ? normCollisionPath(rec.a.path) : "", b: rec.b ? normCollisionPath(rec.b.path) : "" };
  normSides.set(rec, hit);
  return hit;
}

/**
 * THE TREE'S IDENTITY, not the name it is wearing today. A worktree's directory AND branch are renamed by this panel
 * once its run settles on a title (lib/worktree-naming.js), and the one part of either name a rename keeps is the
 * six-hex tag at the end of it (lib/tree-names.js `tagOf`, whose `treeKey` is the naming ledger's own identity for a
 * tree). A collision keyed on that tag is therefore the same record when the directory moves under it: the ruling, the
 * filed notices, the passes and the escalation stamp all stay on one record instead of a rename minting a second key
 * for one physical pair. A tree with no tag - one the panel did not cut - falls back to its normalised path, which is
 * exactly what every key was before.
 */
export function treeIdentityOf({ path: treePath = "", branch = null } = {}) {
  const tag = tagOf(treePath) || tagOf(branch);
  return tag ? `tag:${tag}` : `path:${normCollisionPath(treePath)}`;
}

/** The key of one pair: both tree identities, sorted, so A->B and B->A are one record and a rename is not a key. */
export function pairKey(one, two) {
  const idOf = (value) => {
    const id = value && typeof value === "object" ? treeIdentityOf(value) : treeIdentityOf({ path: value });
    return id === "path:" ? "" : id;
  };
  const a = idOf(one);
  const b = idOf(two);
  if (!a || !b) return a || b || null;
  return [a, b].sort().join("|");
}

/**
 * THE SIDES IN IDENTITY ORDER, with every letter-keyed answer moved with the tree it names.
 *
 * `a` is the side whose tree identity sorts first (`detectCollisions`), which a rename cannot change - but a record
 * written before that rule existed was ordered by PATH, and for two tagged trees the two orders can disagree. A
 * ruling, a stand-down and a supersession all say "this SIDE", so they are carried across the swap: a ruling that
 * silently came to name the tree nobody picked is worse than no ruling at all.
 */
export function reorderSides(rec = null) {
  if (!rec) return rec;
  const idA = rec.a?.path ? treeIdentityOf(rec.a) : null;
  const idB = rec.b?.path ? treeIdentityOf(rec.b) : null;
  if (!idA || !idB || idA === idB || idA <= idB) return rec;
  const flip = (letter) => (letter === "a" ? "b" : "a");
  [rec.a, rec.b] = [rec.b, rec.a];
  if (rec.ruling && (rec.ruling.pick === "a" || rec.ruling.pick === "b")) rec.ruling.pick = flip(rec.ruling.pick);
  if (rec.superseded && (rec.superseded.side === "a" || rec.superseded.side === "b")) rec.superseded.side = flip(rec.superseded.side);
  const stood = {};
  if (rec.stoodDown?.b) stood.a = rec.stoodDown.b;
  if (rec.stoodDown?.a) stood.b = rec.stoodDown.a;
  rec.stoodDown = stood;
  // A filing is keyed by the assistant it went to, so only its informational side letter moves.
  for (const entry of Object.values(rec.filed || {})) {
    if (entry && (entry.side === "a" || entry.side === "b")) entry.side = flip(entry.side);
  }
  return rec;
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

export const TOUCHED_DIR_CAP = 500;

/**
 * The REAL files under an untracked directory, bounded and fail-closed.
 *
 * `git status --porcelain=v2` collapses an untracked tree to ONE line ending in "/" (measured on a repo holding
 * `docs/assets/initiatives-redesign/a/`: the line is `? docs/`), so an untracked entry is sometimes a directory
 * where the evidence needs files. A directory is not a file and two trees that each wrote a different subtree
 * under it touch nothing in common - the pair the reader was shown had `docs/assets/initiatives-redesign` as its
 * only "shared file" while one tree wrote 39 files under a/ and the other 18 under b/.
 *
 * Empty when the directory cannot be read: a listing the panel does not have is not evidence, and inventing a
 * shared path from a failed read is the false positive this exists to remove. `.git` is never walked, a symlink is
 * one path (never followed), and the walk stops at `cap` entries so one enormous untracked tree cannot turn a
 * ten-second sweep into a filesystem crawl.
 */
// KEPT UNTIL THE DIRECTORY ITSELF CHANGES. `touchedOf` asks this for every live row on every ten-second sweep, and an
// untracked directory is walked with readdirSync - measured 2026-11-25 at 1.8s of every 25s on an idle board. The key
// includes the directory's own mtime, so adding or removing an entry at that level invalidates it; a change deeper in
// the tree is caught by the next sweep that sees it, which is the same evidence a fresh walk would have given a minute
// earlier. The value is copied out so a caller cannot mutate what the next caller gets.
const underCache = new Map(); // key -> { mtimeMs, value }
const UNDER_CACHE_CAP = 256;

export function filesUnder(root, rel, { cap = TOUCHED_DIR_CAP } = {}) {
  if (!root || !rel) return [];
  const dir = path.join(String(root || ""), String(rel).split(String.fromCharCode(92)).join("/"));
  let stamp = null;
  try {
    stamp = statSync(dir).mtimeMs;
  } catch {
    stamp = null;
  }
  const key = `${root}|${rel}|${cap}`;
  const hit = underCache.get(key);
  if (stamp !== null && hit && hit.mtimeMs === stamp) return hit.value.slice();
  const out = [];
  const walk = (sub) => {
    if (out.length >= cap) return;
    let entries;
    try {
      entries = readdirSync(path.join(String(root || ""), sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= cap) return;
      if (entry.name === ".git") continue;
      const next = `${sub.replace(/\/+$/, "")}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(next);
    }
  };
  if (root && rel) walk(String(rel).replace(/\\/g, "/"));
  if (stamp !== null) {
    if (underCache.size >= UNDER_CACHE_CAP) underCache.delete(underCache.keys().next().value);
    underCache.set(key, { mtimeMs: stamp, value: out });
  }
  return out.slice();
}

/**
 * What this row is touching: its dirty files, its untracked files, and the files its own commits change since the
 * parent it was cut from. Three sets, kept apart so the evidence can say which one produced the shared path - a
 * shared COMMIT file is the one that conflicts in the parent branch, a shared dirty file is the one being written now.
 * An untracked DIRECTORY (git's trailing "/") is expanded to the real files under it (`filesUnder`), so only a file
 * both sides actually touch can be evidence.
 */
export function touchedOf(row = {}, { listFiles = filesUnder } = {}) {
  const root = String(row?.path || "");
  const dirty = new Set();
  for (const f of row?.dirtyFiles || []) {
    const p = normCollisionPath(f && typeof f === "object" ? f.path : f);
    if (p) dirty.add(p);
  }
  for (const f of row?.untrackedFiles || []) {
    const raw = String(f && typeof f === "object" ? f.path : f ?? "").trim();
    if (!raw) continue;
    if (/[\\/]$/.test(raw)) {
      for (const file of listFiles(root, raw)) {
        const p = normCollisionPath(file);
        if (p) dirty.add(p);
      }
      continue;
    }
    const p = normCollisionPath(raw);
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

// ---- THE VERSION LINE ---------------------------------------------------------------------------------------------
// A SHARED MANIFEST VERSION IS NOT A FILE FIGHT. Every landing here claims the next patch above main (package.json's
// version line, written by `tools/version.mjs apply`), so three live trees can hold 1.155.5, 1.155.6 and 1.156.0 at
// once and every pair of them "shares" package.json. The only differing hunk is the version line, and that is settled
// at LAND time: the land step rebases onto the then-current origin/main and keeps the higher version. The order is
// therefore already decided, and the pair is a LAND ORDER - real, named, recorded (`landOrder`, read as "ruled" by
// `stateOf`) - rather than a reader question. This is EVIDENCE QUALITY, not accounting: the pair still exists, it is
// still one record, and it still names its file.
//
// WHAT IS STILL A COLLISION. A shared source file, test or doc that both sides edited; a manifest that differs in any
// line other than its version (a dependency added on one side is not a version bump); a pair whose version lines are
// unreadable, equal, or cannot be ordered. `classifyVersionOnly` answers yes only when EVERY shared path is a manifest
// version carrier AND every one of them differs in its version line alone.
//
// THE CARRIER LIST IS NAMED BY PATH, never by content: a `version: "1"` inside a source file is not a manifest
// version field, and a content-only rule would read one as such. Each carrier names the ONE line its version lives on
// (pom.xml's FIRST `<version>` is the project's own, not a dependency's).
export const VERSION_CARRIERS = [
  // `"version": "1.155.6"` - the one place this repo keeps its number.
  { test: /(^|\/)package\.json$/i, line: /("version"\s*:\s*")([^"]*)(")/ },
  // A Maven POM's project version: the first element, so a changed dependency version stays a collision.
  { test: /(^|\/)pom\.xml$/i, line: /(<version>\s*)([^<]*)(\s*<\/version>)/ },
  // A plain version file: the whole line is the number, with or without a leading `v`.
  { test: /(^|\/)(version|version\.txt)$/i, line: /^([ \t]*)(v?[0-9][0-9A-Za-z.+_-]*)([ \t]*)$/m },
  // A code constant: `export const VERSION = "1.2.3"`.
  { test: /(^|\/)lib\/version\.(js|mjs|cjs|ts)$/i, line: /\b(VERSION\s*[:=]\s*["'`])([^"'`]*)(["'`])/ },
];

const carrierOf = (file) => VERSION_CARRIERS.find((carrier) => carrier.test.test(normCollisionPath(file))) || null;

/** Is this path a manifest whose version lives on a line this module can read? */
export const isVersionCarrier = (file) => Boolean(carrierOf(file));

/** The version one manifest declares, or null when the path is no carrier or carries no readable line. */
export function versionInText(file, text) {
  const carrier = carrierOf(file);
  if (!carrier || typeof text !== "string") return null;
  const found = carrier.line.exec(text);
  if (!found) return null;
  const value = String(found[2] || "").trim().replace(/^v(?=[0-9])/i, "");
  return value || null;
}

/**
 * The same manifest with its version VALUE blanked, so two copies can be compared for "the version line is the only
 * difference" with no diff algorithm and no false positive: anything else that differs anywhere in the file survives
 * the blanking and makes the two texts unequal.
 */
export function textWithoutVersion(file, text) {
  const carrier = carrierOf(file);
  if (!carrier || typeof text !== "string") return null;
  return text.replace(carrier.line, (whole, before, value, after) => `${before}__VERSION__${after}`);
}

/** Compare two version strings the only way an order can be taken from them: numerically by segment, then as text. */
export function compareVersionText(one, two) {
  const parts = (value) => String(value ?? "").trim().split(/[.+-]/).filter((piece) => piece !== "");
  const left = parts(one);
  const right = parts(two);
  if (!left.length || !right.length) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (/^[0-9]+$/.test(a) && /^[0-9]+$/.test(b)) {
      const delta = Number(a) - Number(b);
      if (delta) return delta < 0 ? -1 : 1;
      continue;
    }
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

const eol = (text) => String(text ?? "").replace(/\r?\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");

/**
 * IS THIS PAIR'S OVERLAP THE VERSION LINE AND NOTHING ELSE? `files` are the shared paths the pair already names, and
 * `contents` is one text per side per path (`{ [file]: { a, b } }`), read by the caller from each tree. Answers
 * `{ok, versionOnly, files, versions: {a, b}, pick, why}`: `pick` is the side with the LOWER version, because the higher
 * number lands last (the land step keeps it when it rebases), and `why` is the sentence a card can print as-is.
 *
 * `ok` is false only when a file the pair needs could not be read: "could not read it" and "it is not a version line"
 * are different answers, and only the second one sends the pair back to the ordinary collision path.
 */
export function classifyVersionOnly({ files = [], contents = {} } = {}) {
  const list = [...new Set((files || []).map(normCollisionPath).filter(Boolean))].slice(0, COLLISION_FILES_CAP);
  if (!list.length) return { ok: false, versionOnly: false, files: [], versions: null, pick: null, why: "the pair names no shared file" };
  const versions = { a: null, b: null };
  for (const file of list) {
    if (!isVersionCarrier(file)) {
      return { ok: true, versionOnly: false, files: list, versions: null, pick: null, why: `${file} is not a manifest version field` };
    }
    const one = contents?.[file]?.a;
    const two = contents?.[file]?.b;
    if (typeof one !== "string" || typeof two !== "string") {
      return { ok: false, versionOnly: false, files: list, versions: null, pick: null, why: `the ${file} both sides carry could not be read` };
    }
    const left = versionInText(file, one);
    const right = versionInText(file, two);
    if (!left || !right) {
      return { ok: true, versionOnly: false, files: list, versions: null, pick: null, why: `${file} declares no readable version line` };
    }
    if (textWithoutVersion(file, eol(one)) !== textWithoutVersion(file, eol(two))) {
      return { ok: true, versionOnly: false, files: list, versions: null, pick: null, why: `${file} differs in more than its version line` };
    }
    if (versions.a === null) {
      versions.a = left;
      versions.b = right;
    }
  }
  if (versions.a === versions.b) {
    return { ok: true, versionOnly: false, files: list, versions, pick: null, why: `both sides read version ${versions.a}` };
  }
  const order = compareVersionText(versions.a, versions.b);
  if (order === null) {
    return { ok: true, versionOnly: false, files: list, versions, pick: null, why: `the version lines cannot be ordered (${versions.a} vs ${versions.b})` };
  }
  return {
    ok: true,
    versionOnly: true,
    files: list,
    versions,
    pick: order < 0 ? "a" : "b",
    why: `${list.join(", ")} is the only shared path and its version line is the only difference (${versions.a} vs ${versions.b})`,
  };
}

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
      // a tree and a rescan that swapped the sides would silently rule on the other one. The order is the tree
      // IDENTITY, not the path - a renamed directory must not swap the sides under a stored ruling either.
      const idOne = treeIdentityOf(one.side);
      const idTwo = treeIdentityOf(two.side);
      const first =
        idOne === idTwo
          ? normCollisionPath(one.side.path) <= normCollisionPath(two.side.path)
            ? one
            : two
          : idOne < idTwo
            ? one
            : two;
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
        key: pairKey(first.side, second.side),
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

/**
 * A worker's target may name a QUEUE ROW as well as a worktree: "#12", "12", "task 12", "queue #12", "row 12". The
 * id is only honoured when a queue row actually carries it, so a tree whose slug happens to be digits still resolves
 * as a tree. Null means "not a queue-row id", not "no row".
 */
export function targetTaskId(target = "") {
  const t = String(target ?? "").trim();
  // A bare number counts too ("12"): the id is only honoured when a queue row actually carries it, so a tree whose
  // slug is digits still resolves as a tree and nothing is guessed.
  const m = /^(?:#\s*(\d{1,9})|(?:task|queue|row|ticket)\s*#?\s*(\d{1,9})|(\d{1,9}))$/i.exec(t);
  if (!m) return null;
  const id = Number(m[1] || m[2] || m[3]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const threadOfTask = (task = {}) =>
  [...new Set([task.thread, ...(Array.isArray(task.threads) ? task.threads : [])].map((t) => String(t ?? "").trim()).filter(Boolean))];

/**
 * THE COUNTERPART A NOTE NAMES, resolved against the board as it is: the queue rows first (their id and the thread
 * they were carried on), then the worktrees (path, slug and branch). Answers
 * `{kind, how, target, row, task, said}` where `kind` is
 *
 *   tree        another tree on this board - the pair can be filed and, with evidence, ruled;
 *   same-tree   the tree the card is drawn on - not a collision at all, so nothing is offered;
 *   none        nothing on this board answers to it - the card says so and offers no ruling either.
 *
 * Resolution here rather than in the page is the point: the card prints the record, and the record is assembled once.
 * A target that resolves to nothing is never guessed into a tree, and a target that resolves to the reporting tree is
 * never turned into a pair with itself (which would offer a ruling between one tree and itself).
 */
export function resolveCounterpart({ target = "", rows = [], queues = [], project = null, selfPath = "", other = null } = {}) {
  const typed = String(target ?? "").trim();
  const self = normCollisionPath(selfPath);
  const list = [...(rows || [])].filter((r) => r && r.path && (!project || !r.project || String(r.project) === String(project)));
  const found = (row, how, task = null) => {
    const same = Boolean(self) && normCollisionPath(row.path) === self;
    return {
      kind: same ? "same-tree" : "tree",
      how,
      target: typed,
      row,
      task: task ? { id: Number(task.id) || null, thread: task.thread || null, state: task.state || null } : null,
      said: same ? "the tree this card is drawn on" : `${row.name || row.path}`,
    };
  };
  const nothing = (how = null, said = "", task = null) => ({ kind: "none", how, target: typed, row: null, task, said });
  if (!typed) return nothing(null, "no counterpart is named");
  const rowForWorktree = (worktree) => {
    const want = normCollisionPath(worktree);
    if (!want) return null;
    return list.find((r) => normCollisionPath(r.path) === want) || list.find((r) => normCollisionPath(r.path).endsWith(`/${want}`)) || null;
  };
  const queueTasks = [];
  for (const queue of Array.isArray(queues) ? queues : []) {
    for (const task of queue?.tasks || []) if (task) queueTasks.push({ task, queue });
  }
  // 1. A QUEUE ROW BY ID. Newest id first, and the one whose `worktree` is a tree on this board wins: a queue can hold
  //    an older row naming a tree that has since been removed, and that row is not what the worker meant.
  const id = targetTaskId(typed);
  if (id !== null) {
    const hits = queueTasks.filter((h) => Number(h.task.id) === id).sort((x, y) => Number(y.task.id) - Number(x.task.id));
    if (hits.length) {
      const withTree = hits.find((h) => h.task.worktree && rowForWorktree(h.task.worktree)) || hits[0];
      const row = withTree.task.worktree ? rowForWorktree(withTree.task.worktree) : null;
      if (row) return found(row, "task-id", withTree.task);
      return nothing("task-id", `queue row #${id} names no tree on this board`, withTree.task);
    }
  }
  // 2. A QUEUE ROW BY THREAD. A thread can carry several rows (a round's stages); the newest that resolves to a tree
  //    on this board is the one the worker named.
  const wantThread = normCollisionPath(typed);
  const byThread = wantThread
    ? queueTasks
        .filter((h) => threadOfTask(h.task).some((t) => normCollisionPath(t) === wantThread))
        .sort((x, y) => Number(y.task.id) - Number(x.task.id))
    : [];
  if (byThread.length) {
    const withTree = byThread.find((h) => h.task.worktree && rowForWorktree(h.task.worktree)) || byThread[0];
    const row = withTree.task.worktree ? rowForWorktree(withTree.task.worktree) : null;
    if (row) return found(row, "thread", withTree.task);
    return nothing("thread", `thread ${typed} names no tree on this board`, withTree.task);
  }
  // 3. A WORKTREE: its path (full or a suffix), its directory slug, or its branch. The same resolution the harvester
  //    always used, kept here so both halves answer alike.
  const want = normCollisionPath(typed);
  if (want) {
    const exact = list.find((r) => normCollisionPath(r.path) === want);
    if (exact) return found(exact, "path");
    const bySuffix = list.find((r) => normCollisionPath(r.path).endsWith(`/${want}`));
    if (bySuffix) return found(bySuffix, "path");
    // The BRANCH before the slug: a branch's last segment is its tree's name ("wtgui/card-b" and "card-b"), so a slug
    // check first would answer "slug" for a branch and make the card's own account of how it resolved wrong.
    const byBranch = list.find((r) => String(r.branch || "").toLowerCase().replace(/^refs\/heads\//, "") === want.replace(/^refs\/heads\//, ""));
    if (byBranch) return found(byBranch, "branch");
    const byName = list.find((r) => String(r.name || "").toLowerCase() === want.replace(/^.*\//, ""));
    if (byName) return found(byName, "slug");
  }
  // 4. A row the caller already resolved (the older seam): still checked against this tree, so a caller that hands
  //    back the reporting row gets "same tree" rather than a pair with itself.
  if (other && other.path) return found(other, "row");
  return nothing(null, `no tree on this board answers to "${typed}"`);
}

/**
 * Does a worker's target name a tree a LIVE AGENT is standing in? The board's rows are what a counterpart normally
 * resolves to, but a tree can be live before its row is written (a cut made by hand, a scan that has not run yet, a
 * row the reader archived while the run kept going). The matching is the worktree half of `resolveCounterpart` -
 * full path, path suffix, branch, directory slug - so "the target names a live agent" means the same thing for both
 * halves of the absence question.
 *
 * Answers the matching entry (`{path, branch, name}`) or null. `liveAgents` is the list `lib/jobs.js`
 * `liveAgentTrees()` builds; a caller that could not read its own job store passes null instead of [], because "I
 * did not look" and "there was nobody there" are different answers and only the second one settles a note.
 */
export function targetNamesLiveAgent(target = "", liveAgents = [], { project = null } = {}) {
  const want = normCollisionPath(target);
  if (!want) return null;
  const list = (Array.isArray(liveAgents) ? liveAgents : []).filter(
    (a) => a && a.path && (!project || !a.project || String(a.project) === String(project)),
  );
  const exact = list.find((a) => normCollisionPath(a.path) === want);
  if (exact) return exact;
  const bySuffix = list.find((a) => normCollisionPath(a.path).endsWith(`/${want}`));
  if (bySuffix) return bySuffix;
  const byBranch = list.find(
    (a) => String(a.branch || "").toLowerCase().replace(/^refs\/heads\//, "") === want.replace(/^refs\/heads\//, ""),
  );
  if (byBranch) return byBranch;
  return list.find((a) => String(a.name || "").toLowerCase() === want.replace(/^.*\//, "")) || null;
}

/** The stamp a record's report carries: the note's own moment, or the detection's first sight for a detected pair. */
export function reportAtOf(rec = {}) {
  return rec?.reportedAt || rec?.firstAt || rec?.notes?.[0]?.at || null;
}

/**
 * The state a record reads as: superseded is history and wins over everything, then a ruling, then a VERDICT (an
 * absence), then an escalation. A verdict is checked before `readerAt` because `absent` and `readerAt` are the two
 * halves of one answer: a record is either a question for the reader or settled without one, never both.
 */
export function stateOf(rec = {}) {
  if (rec.superseded) return "superseded";
  if (rec.ruling) return "ruled";
  if (rec.absent) return "absent";
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
 * Did git actually compare anything? `merge-tree` merges COMMITS, and two trees cut from the same commit with their
 * work still uncommitted have no commit of their own to compare: both directions come back clean because the two tips
 * are the same commit, not because the work agrees. That answer is vacuous, and an automatic order built on it would be
 * the branch name dressed as git's judgement - so it is not an answer, and the pair stays the reader's.
 */
export function mergeComparedNothing(rec = {}) {
  const merge = rec?.merge;
  if (merge?.aFirst?.clean !== true || merge?.bFirst?.clean !== true) return false;
  return countOf(merge?.a?.commits) === 0 && countOf(merge?.b?.commits) === 0;
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
    if (mergeComparedNothing(rec)) {
      return {
        pick: null,
        why: "nothing-committed",
        basis: "merge",
        reason: "both trees stand on the same commit and neither has committed its work, so git had nothing to compare - the order is yours",
      };
    }
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
  // A pair a landing has already consumed is history, not a question: nothing about it waits on the reader.
  if (rec?.superseded) return false;
  if (rec?.autoWithheld) return true;
  // Both directions clean, but about two identical commits: git compared nothing, so there is no answer to settle on.
  if (mergeComparedNothing(rec)) return true;
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

/**
 * An OLDER RECORD'S ABSENCE, read off what the previous code wrote. Before the verdict existed, a note whose target
 * named nothing was handed over the moment it was filed: `readerAt` equals the report's own stamp, no ruling follows,
 * and the resolution says `none`. That shape is an absence, so it is upgraded on read - a board that already carries
 * one of these stops asking the reader about work that has no second side, without anybody editing the file.
 *
 * Deliberately narrow: a note escalated LATER (a live agent was named, or the reader pressed "bring it to me") has a
 * `readerAt` after its `reportedAt` and is left exactly as it is.
 */
function oldAbsence(rec = {}) {
  if (!rec || rec.source !== "reported" || rec.ruling) return null;
  if (rec.resolve?.kind !== "none" || rec.b?.path) return null;
  const readerAt = String(rec.readerAt || "");
  const reportedAt = String(rec.reportedAt || "");
  if (!readerAt || !reportedAt || readerAt !== reportedAt) return null;
  return {
    at: readerAt,
    target: rec.bTarget || rec.resolve?.target || null,
    how: rec.resolve?.how || null,
    why: "the target names no row on this board and no live agent stands in a tree it names",
    upgraded: true,
  };
}

// ---- the store -------------------------------------------------------------------------------------------------
// One JSON document, beside the other per-row stores (lib/paths.js `collisionsFile`). Written temp+rename like every
// store here: a crash mid-write leaves the previous list, never half of one.
/**
 * WHICH OF TWO RECORDS FOR ONE PAIR SPEAKS TODAY. A RULING is an answer and outlives a later sighting of the same
 * pair - the reader ruled once and the panel must not ask again - so a ruled record always wins. Without a ruling the
 * record last seen is the one that speaks, because that is the one the sweeps have been writing.
 */
function speaksToday(one, two) {
  const ruled = (rec) => Boolean(rec?.ruling);
  if (ruled(one) !== ruled(two)) return ruled(one) ? [one, two] : [two, one];
  const at = (rec) => Date.parse(rec?.lastAt || rec?.firstAt || 0) || 0;
  return at(one) >= at(two) ? [one, two] : [two, one];
}

/**
 * Fold the loser of `speaksToday` into the winner, so a merge loses history rather than dropping it: both sides' notes,
 * both sides' filings, the earliest first sight, the latest last sight and the most passes. The answer fields (the
 * ruling, the absence verdict, the withdrawal of an automatic pick) are taken from whichever record has one.
 */
function foldRecord(keep, drop) {
  // Both sides of the fold are put in identity order first, so the letters in the answers they carry are the letters
  // the folded record will use.
  reorderSides(keep);
  reorderSides(drop);
  const seenNote = new Set();
  keep.notes = [...(keep.notes || []), ...(drop.notes || [])]
    .filter((n) => {
      const k = `${n?.at || ""}|${n?.target || ""}|${n?.text || ""}`;
      if (seenNote.has(k)) return false;
      seenNote.add(k);
      return true;
    })
    .sort((x, y) => String(x?.at || "").localeCompare(String(y?.at || "")))
    .slice(-20);
  keep.filed = { ...(drop.filed || {}), ...(keep.filed || {}) };
  keep.firstAt = [keep.firstAt, drop.firstAt].filter(Boolean).sort()[0] || keep.firstAt;
  keep.lastAt = [keep.lastAt, drop.lastAt].filter(Boolean).sort().pop() || keep.lastAt;
  keep.passAt = [keep.passAt, drop.passAt].filter(Boolean).sort().pop() || keep.passAt;
  keep.reportedAt = [keep.reportedAt, drop.reportedAt].filter(Boolean).sort()[0] || keep.reportedAt;
  keep.passes = Math.max(keep.passes || 0, drop.passes || 0);
  keep.ruling = keep.ruling || drop.ruling || null;
  keep.absent = keep.absent || drop.absent || null;
  keep.superseded = keep.superseded || drop.superseded || null;
  keep.autoWithheld = keep.autoWithheld || drop.autoWithheld || null;
  keep.versionCheck = keep.versionCheck || drop.versionCheck || null;
  keep.landOrder = keep.landOrder || drop.landOrder || null;
  keep.merge = keep.merge || drop.merge || null;
  keep.evidence = keep.evidence || drop.evidence || null;
  keep.land = keep.land || drop.land || null;
  keep.resolve = keep.resolve || drop.resolve || null;
  // The two halves of one answer: a record is a question or a verdict, never both. A RULED record is answered too, so
  // a phantom reader hand-over on the record being folded away is not carried onto it.
  if (keep.absent) {
    keep.readerAt = null;
    keep.readerWhy = null;
  } else if (!keep.ruling) {
    keep.readerAt = keep.readerAt || drop.readerAt || null;
    keep.readerWhy = keep.readerWhy || drop.readerWhy || null;
  }
  keep.source = keep.source === "reported" && drop.source === "detected" ? "detected" : keep.source;
  keep.project = keep.project || drop.project || null;
  keep.bTarget = keep.bTarget || drop.bTarget || null;
  keep.a = keep.a || drop.a || null;
  keep.b = keep.b || drop.b || null;
  return keep;
}

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
        // The verdict, from the record as written or from the shape the previous code wrote for the same case. An
        // absent record carries no reader hand-over: the two are one answer, and the verdict is the one that stands.
        // Read through the same four fields the view writes, so a stored record cannot smuggle extra state (the
        // read-time `upgraded` marker included) back into the book.
        const absent =
          rec.absent && typeof rec.absent === "object"
            ? { at: rec.absent.at || null, target: rec.absent.target || null, how: rec.absent.how || null, why: rec.absent.why || null }
            : oldAbsence(rec);
        this.records.set(key, {
          key,
          project: rec.project ? String(rec.project) : null,
          source: rec.source === "reported" ? "reported" : "detected",
          a: rec.a && rec.a.path ? sideOf(rec.a) : null,
          b: rec.b && rec.b.path ? sideOf(rec.b) : null,
          // A target the worker wrote that named no row: kept as written, so the note still says what it saw.
          bTarget: rec.bTarget ? clip(rec.bTarget, COLLISION_TARGET_CAP) : null,
          // How the worker's target resolved when the note was filed: a tree, this tree itself, or nothing.
          sameTree: rec.sameTree === true,
          resolve: rec.resolve && typeof rec.resolve === "object" ? rec.resolve : null,
          // The report's own stamp, and the two facts the card can measure later: the shared files and the landing.
          reportedAt: rec.reportedAt || null,
          evidence: rec.evidence && typeof rec.evidence === "object" ? rec.evidence : null,
          land: rec.land && typeof rec.land === "object" ? rec.land : null,
          // History: a landing carried one side into main after the report was stamped.
          superseded: rec.superseded && typeof rec.superseded === "object" ? rec.superseded : null,
          files: (Array.isArray(rec.files) ? rec.files : []).map(normCollisionPath).filter(Boolean).slice(0, COLLISION_FILES_CAP),
          relations: Array.isArray(rec.relations) ? rec.relations.slice(0, COLLISION_RELATION_CAP) : [],
          notes: (Array.isArray(rec.notes) ? rec.notes : []).filter((n) => n && String(n.text || "").trim()).slice(-20),
          firstAt: rec.firstAt || null,
          lastAt: rec.lastAt || null,
          passAt: rec.passAt || null,
          passes: Math.max(0, Number(rec.passes) || 0),
          filed: rec.filed && typeof rec.filed === "object" ? rec.filed : {},
          stoodDown: stoodDownOf(rec.stoodDown),
          // The verdict: a note whose target named no row and no live agent. Kept through a restart so an old board
          // does not start asking about it again.
          absent,
          readerAt: absent ? null : rec.readerAt || null,
          readerWhy: absent ? null : rec.readerWhy || null,
          ruling: rec.ruling && typeof rec.ruling === "object" ? rec.ruling : null,
          // git's own answer about this pair (`lib/collision-merge.js`), kept with the record so the card can say WHY
          // a pair is the reader's instead of only that it is. Null on a record detected before this answer existed.
          merge: rec.merge && typeof rec.merge === "object" ? rec.merge : null,
          // Set when the reader withdrew an AUTOMATIC pick: the sweep must not put the same order straight back, and
          // the pair is the reader's from then on.
          autoWithheld: rec.autoWithheld && typeof rec.autoWithheld === "object" ? rec.autoWithheld : null,
          // A VERSION-ONLY overlap: the measurement (with the tips it was read at, so the sweep does not re-read the
          // same files every ten seconds) and the LAND ORDER it became. Both are kept through a restart like a ruling,
          // because the land step they describe has not changed.
          versionCheck: rec.versionCheck && typeof rec.versionCheck === "object" ? rec.versionCheck : null,
          landOrder: rec.landOrder && typeof rec.landOrder === "object" ? rec.landOrder : null,
        });
      }
    } catch (err) {
      if (existsSync(this.file)) this.log(`collisions: could not read ${this.file} (${String((err && err.message) || err)}) - starting empty`);
    }
    // THE BOOK IS RE-KEYED ON THE WAY IN. A record written by an older build is filed under the two worktree DIRECTORY
    // names of the day, and the panel renames those under it (lib/worktree-naming.js); the pair detected after a
    // rename is the SAME pair, so folding the older key into today's is what carries the reader's ruling across the
    // rename instead of minting a second record for one physical pair.
    this.normalizeKeys();
    return this;
  }

  /**
   * THE KEY THIS RECORD ANSWERS TO TODAY, or null when its key is not a pair or a note key the panel can rebuild.
   *
   * A pair is rebuilt from its two tree IDENTITIES (`pairKey`), which a rename cannot change. A reported note's key is
   * `note:<the reporting tree>:<the words>`; only the tree's own part is rebuilt, and the words are kept byte for byte,
   * because they are what the worker wrote.
   */
  keyTodayFor(rec = {}) {
    const mine = rec.a?.path ? rec.a : null;
    if (!mine) return null;
    if (rec.b?.path) return pairKey(mine, rec.b);
    const key = String(rec.key || "");
    const legacy = `note:${normCollisionPath(mine.path)}:`;
    if (key.startsWith(legacy)) return `note:${treeIdentityOf(mine)}:${key.slice(legacy.length)}`;
    return null;
  }

  /**
   * ONE TREE PAIR, ONE KEY, whatever the directories were called when the record was written.
   *
   * Idempotent and run on every load: a record whose key already is its identity is left alone, one filed under an
   * older spelling is moved to today's key, and when both spellings are in the book they are folded into ONE record
   * (`speaksToday` picks the one whose answer binds, `foldRecord` keeps what the other saw). This is the reader's
   * measured case: a ruling made before the panel renamed the two trees, beside a second record minted under the
   * renamed names for the same two trees.
   */
  normalizeKeys() {
    for (const rec of [...this.records.values()]) {
      // A record already folded into another one is out of the book: the snapshot this loop walks may still hold it,
      // and folding it twice would double its history.
      if (this.records.get(rec.key) !== rec) continue;
      // A record written when the sides were ordered by PATH may letter them the other way round than the identity
      // order does; its answers move with their trees before the key is rebuilt, so the ruling still names its tree.
      reorderSides(rec);
      const key = this.keyTodayFor(rec);
      if (!key || key === rec.key) continue;
      const holder = this.records.get(key);
      if (!holder) {
        this.records.delete(rec.key);
        rec.key = key;
        this.records.set(key, rec);
        continue;
      }
      const [keep, drop] = speaksToday(holder, rec);
      if (drop === holder) this.records.delete(key);
      else this.records.delete(drop.key);
      foldRecord(keep, drop);
      keep.key = key;
      this.records.set(key, keep);
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
        // A version-only overlap measured on this pair, and the LAND ORDER it became: both filled by the sweep that
        // can read the shared manifests (`lib/collision-flow.js` step 0a).
        versionCheck: null,
        landOrder: null,
        // A detected pair resolves to a tree by construction; the report stamp is its first sight, and the measured /
        // landing facts start empty and are filled by the sweep that can ask git.
        sameTree: false,
        resolve: null,
        reportedAt: now,
        evidence: null,
        land: null,
        superseded: null,
      };
      this.records.set(rec.key, rec);
      return { record: rec, isNew: true, passTicked: true };
    }
    // The fresh sides win - they are what the sweeps just resolved - except that a side whose resolver was not
    // consulted (no `taskFor` in this sweep) keeps the task the record already names, rather than blanking the card.
    // The record's OWN sides are put in identity order first, so the letters its answers use are the letters the fresh
    // sides use: the ruling below renames the tree it names, not the one the path order happened to put first.
    reorderSides(existing);
    existing.a = { ...pair.a, task: pair.a?.task ?? existing.a?.task ?? null, taskId: pair.a?.taskId ?? existing.a?.taskId ?? null };
    existing.b = { ...pair.b, task: pair.b?.task ?? existing.b?.task ?? null, taskId: pair.b?.taskId ?? existing.b?.taskId ?? null };
    // A RULING NAMES A TREE, so a renamed tree renames the sentence with it. The side order is the identity order
    // (lib/collisions.js `detectCollisions`), which a rename cannot change, so `pick` still names the same tree and only
    // its path, name and task need the fresh spelling - otherwise the card would say "goes first" about a directory that
    // no longer exists.
    if (existing.ruling && (existing.ruling.pick === "a" || existing.ruling.pick === "b")) {
      const picked = existing[existing.ruling.pick];
      if (picked?.path) {
        existing.ruling.path = picked.path;
        existing.ruling.name = picked.name;
        existing.ruling.taskId = picked.taskId ?? existing.ruling.taskId ?? null;
      }
    }
    existing.project = pair.project || existing.project;
    existing.files = (pair.files || []).slice(0, COLLISION_FILES_CAP);
    existing.relations = (pair.relations || []).slice(0, COLLISION_RELATION_CAP);
    // A fresh merge answer replaces the old one, so a record whose first probe failed is repaired by the next sweep
    // that can answer; a sweep that did not probe at all (no `probeMerge` wired) leaves the evidence alone.
    if (pair.merge && typeof pair.merge === "object") existing.merge = pair.merge;
    existing.lastAt = now;
    // A pair DETECTED AGAIN has its trees back (they are live rows), so an absence verdict written while they were
    // gone is not the answer any more: the record returns to the ordinary pass and can be filed or escalated again.
    if (existing.absent) existing.absent = null;
    const due = !existing.passAt || at - Date.parse(existing.passAt) >= COLLISION_PASS_MS;
    if (due) {
      existing.passes += 1;
      existing.passAt = now;
    }
    return { record: existing, isNew: false, passTicked: due };
  }

  /**
   * A worker's COLLISION line, filed against the reporting worker's tree.
   *
   * THE TARGET IS RESOLVED HERE, against the queue rows (their id and the thread they were carried on) and the
   * worktrees (path, slug and branch), and the ANSWER is stored with the record: a target that resolves to another
   * tree is a pair, a target that resolves to this same tree is not a collision at all, and a target that resolves to
   * nothing keeps the words it was written with. The card prints the record's own answer, so it never invents a
   * counterpart and never offers a ruling between one tree and itself. `other` is the older seam a caller may pass
   * already resolved; it is checked against this tree the same way.
   *
   * NO ROW AND NO LIVE AGENT IS A VERDICT, NOT A QUESTION. `liveAgents` is the list of trees a live run is standing in
   * (`lib/jobs.js` `liveAgentTrees()`, or null when the harvester could not read its store). A note whose target
   * resolves to no row AND to no live agent is recorded as `absent` (`stateOf` -> "absent"), NOT handed to the reader:
   * there is no second side, no ruling exists, and a count on the Human button for it sends the reader to a card with
   * nothing to press. A note that names a live agent's tree keeps the reader hand-over it always had, because that is
   * exactly the tree the board has not scanned yet and a person can still see.
   *
   * The report's own stamp is kept as `reportedAt`: a landing later than that stamp is what makes the card history.
   *
   * The same run reporting the same target twice updates the sentence instead of appending a second note.
   */
  recordNote({ project = null, treePath = null, branch = null, head = null, target = "", text = "", runId = null, thread = null, other = null, rows = [], queues = [], liveAgents = null, at = null } = {}) {
    this.load();
    // Each side names the queue row actually standing in it, resolved from every assistant's queue by that row's own
    // `worktree` field - the same resolver the detected pairs use, so a note and a detection print the same task.
    const taskIn = (path) => {
      try {
        return owningTaskFor(path, queues);
      } catch {
        return null;
      }
    };
    const mine = sideOf({ path: treePath, branch, head, task: taskIn(treePath) });
    if (!mine.path) return { saved: false, error: "a COLLISION note needs the reporting tree's path" };
    const said = clip(text, COLLISION_NOTE_CAP);
    const named = clip(target, COLLISION_TARGET_CAP);
    if (!said) return { saved: false, error: "a COLLISION note needs a sentence after the pipe" };
    const stamp = at || nowIso(this.now());
    const resolved = resolveCounterpart({ target: named, rows, queues, project, selfPath: mine.path, other });
    const paired = resolved.kind === "tree" && resolved.row?.path ? resolved.row : null;
    // The counterpart is the SAME record a detection writes, so the two must not disagree about which tree is `a`:
    // the sides are ordered by tree identity here exactly as `detectCollisions` orders them.
    const counterpart = paired ? sideOf({ ...paired, task: taskIn(paired.path) }) : null;
    const mineFirst = !counterpart || treeIdentityOf(mine) <= treeIdentityOf(counterpart);
    const sideA = mineFirst ? mine : counterpart;
    const sideB = mineFirst ? counterpart : mine;
    // THE ABSENCE QUESTION, asked once: an unmatched target is settled only when the caller actually looked for a live
    // agent (an array) and found none. `null` means the store could not be read, and then the note keeps the reader
    // hand-over rather than claiming an absence nobody checked for.
    const lookedForAgents = Array.isArray(liveAgents);
    const liveAgent = lookedForAgents && resolved.kind === "none" ? targetNamesLiveAgent(named, liveAgents, { project }) : null;
    const absent = resolved.kind === "none" && lookedForAgents && !liveAgent;
    // The note's own key names the REPORTING TREE by its identity, not its directory name: a tree the panel renames
    // must not file the same note again under a second key (the pair key has the same property - `pairKey`).
    const noteKey = `note:${treeIdentityOf(mine)}:${clip(named, 80).toLowerCase()}`;
    const key = paired ? pairKey(mine, paired) : noteKey;
    const resolveRecord = {
      kind: resolved.kind,
      how: resolved.how || null,
      target: named,
      taskId: resolved.task?.id ?? null,
      thread: resolved.task?.thread || null,
      said: resolved.said || null,
    };
    const absentRecord = () => ({
      at: stamp,
      target: named,
      how: resolved.how || null,
      why: "the target names no row on this board and no live agent stands in a tree it names",
    });
    let rec = this.records.get(key) || null;
    // A note filed while its counterpart named no row, re-reported now that a queue row names it: the SAME note moves
    // to the pair key rather than leaving a stale history entry beside the live pair.
    if (!rec && paired) {
      const old = this.records.get(noteKey);
      if (old) {
        this.records.delete(noteKey);
        old.key = key;
        this.records.set(key, old);
        rec = old;
      }
    }
    if (!rec) {
      rec = {
        key,
        project: project ? String(project) : null,
        source: "reported",
        a: sideA,
        b: sideB,
        bTarget: sideB ? null : named,
        sameTree: resolved.kind === "same-tree",
        resolve: resolveRecord,
        reportedAt: stamp,
        evidence: null,
        land: null,
        superseded: null,
        files: [],
        relations: [],
        notes: [],
        firstAt: stamp,
        lastAt: stamp,
        passAt: stamp,
        passes: 1,
        filed: {},
        stoodDown: {},
        // A note with NO counterpart goes to the reader UNLESS its absence is the whole answer: an unmatched target
        // that names no live agent is a verdict, and a verdict asks nobody.
        absent: absent ? absentRecord() : null,
        readerAt: paired || absent ? null : stamp,
        readerWhy: paired
          ? null
          : absent
            ? null
            : resolved.kind === "same-tree"
              ? "reported against its own tree - not a collision"
              : "reported - the target names no row on this board",
        ruling: null,
      };
      this.records.set(key, rec);
    }
    rec.lastAt = stamp;
    rec.source = "reported";
    rec.reportedAt = stamp;
    rec.resolve = resolveRecord;
    rec.sameTree = resolved.kind === "same-tree";
    if (paired) {
      rec.a = sideA;
      rec.b = sideB;
      rec.bTarget = null;
    } else {
      rec.a = sideA;
      rec.b = null;
      rec.bTarget = named;
    }
    // THE VERDICT IS RECOMPUTED ON EVERY REPORT. A note whose target has since gained a live agent is the reader's
    // again (the board may simply not have scanned it yet), and one whose agent has gone is settled again; a RULED
    // record is never reopened, because a ruling is an answer and this question has no second side.
    if (!rec.ruling) {
      if (absent) {
        rec.absent = rec.absent || absentRecord();
        rec.readerAt = null;
        rec.readerWhy = null;
      } else if (rec.absent) {
        rec.absent = null;
        rec.readerAt = rec.readerAt || stamp;
        rec.readerWhy = rec.readerWhy || (resolved.kind === "same-tree" ? "reported against its own tree - not a collision" : "reported - the target names no row on this board");
      }
    }
    const same = rec.notes.find((n) => n.runId && runId && String(n.runId) === String(runId) && normCollisionPath(n.target) === normCollisionPath(named));
    if (same) {
      same.text = said;
      same.at = stamp;
    } else {
      rec.notes.push({ at: stamp, text: said, target: named, runId: runId ? String(runId) : null, thread: thread ? String(thread) : null });
      rec.notes = rec.notes.slice(-20);
      // A new sentence is a new claim: the measurement it would replace is dropped so the next sweep re-asks git
      // rather than printing paths from the branch as it was when the first note was filed.
      rec.evidence = null;
    }
    const where = paired
      ? `the tree ${paired.name || paired.path}`
      : absent
        ? `no row and no live agent answers to "${named}" - recorded as resolved by absence, nothing to rule on`
        : resolved.kind === "same-tree"
          ? "the tree this run is in - not a collision"
          : `no tree named "${named}"`;
    const wrote = this.save();
    return { saved: wrote.ok, record: rec, resolved: resolveRecord, line: `⇢ COLLISION noted against ${mine.name}: ${said} (${where})`, error: wrote.ok ? null : wrote.error };
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

  /**
   * Hand the pair to the reader: the collision now counts on the Human button and H steps into it. A record already
   * settled by an ABSENCE is not a pair and is not reopened: there is nothing to bring in front of anybody.
   */
  escalate(key, { why = "no-stand-down", at = this.now() } = {}) {
    const rec = this.records.get(String(key));
    if (!rec || rec.ruling || rec.readerAt || rec.absent) return rec || null;
    rec.readerAt = nowIso(at);
    rec.readerWhy = String(why || "no-stand-down");
    return rec;
  }

  /** The reader asking for it now, before the pass would have handed it over (the "or when he asks" case). */
  ask(key, { at = this.now(), by = "reader" } = {}) {
    const rec = this.escalate(key, { why: `asked by ${by}`, at });
    // Only a record that was actually handed over carries the reader's reason: an absent one comes back unchanged.
    if (rec && rec.readerAt) rec.readerWhy = `asked by ${by}`;
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
      // A withdrawn land order stops being one: the card must not go on naming a version order nobody stands behind.
      rec.landOrder = null;
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
    // Any answer that is not the version reading replaces the land order: the order the card names must be the one
    // that stands, and a reader's own pick is not a version order.
    if (String(rec.ruling.basis || "") !== "version") rec.landOrder = null;
    const wrote = this.save();
    return {
      ok: true,
      changed: true,
      record: rec,
      say: `${side.name} goes first on ${rec.files.length ? `${rec.files.length} shared file${rec.files.length === 1 ? "" : "s"}` : "this overlap"}`,
      error: wrote.ok ? null : wrote.error,
    };
  }

  /**
   * The record is OVER because its TREES are. A record that was waiting on the reader, every one of whose sides
   * stands in a tree that is no longer on disk, is not a question: there is no second side to order and no ruling a
   * person could give, so holding it on the Human button asks for a decision about work that has already ended. It
   * becomes a verdict (`stateOf` -> "absent") with the words that explain it, leaves the reader count, and is kept for
   * reading - no `forget` press is needed to stop the badge.
   *
   * A RULED record is left alone: a ruling is an answer, and `stateOf` reads it as `ruled` either way. The caller
   * decides WHICH records qualify (`lib/collision-flow.js` asks the disk, once per sweep, and only about records still
   * in the reader count); this method only writes the verdict.
   */
  markAbsent(key, { at = this.now(), target = null, how = "trees-gone", why = "" } = {}) {
    this.load();
    const rec = this.records.get(String(key));
    if (!rec || rec.ruling) return rec || null;
    const names = ["a", "b"].map((side) => rec[side]?.name).filter(Boolean);
    rec.absent = {
      at: nowIso(at),
      target: clip(target || rec.bTarget || names.join(" and "), COLLISION_TARGET_CAP) || null,
      how: how ? String(how) : null,
      why: clip(why, COLLISION_NOTE_CAP) || null,
    };
    // The two halves of one answer: a record is either a question for the reader or settled without one, never both.
    rec.readerAt = null;
    rec.readerWhy = null;
    return rec;
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
      // A VERDICT is a resolution too: a record whose trees are gone was settled as `absent` so it leaves the reader
      // count, and dropping it on the next sweep would throw away the reason nobody is being asked about it.
      if (rec.absent) continue;
      // A superseded record is HISTORY: the landing that consumed it is the reason it is kept, and dropping it on the
      // next sweep is exactly the record nobody could read afterwards.
      if (rec.superseded) continue;
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
   * A side's tip has been carried into main by a landing LATER than the report. The pair is over: the record becomes
   * history (`superseded`), names the commit that landed it, and is never asked again. It is not dropped - the reason
   * the card existed is still worth reading - but `forTree` stops drawing it in the live lane and `historyFor` returns
   * it marked. A commit that is not a full sha is refused rather than stored as an uncheckable claim.
   */
  supersede(key, { side = null, commit = null, landedAt = null, main = null, tip = null, reportAt = null, at = this.now() } = {}) {
    this.load();
    const rec = this.records.get(String(key));
    if (!rec || rec.superseded) return rec || null;
    const sha = String(commit || "").trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) return rec;
    rec.superseded = {
      at: nowIso(at),
      side: side === "b" ? "b" : "a",
      commit: sha,
      short: sha.slice(0, 12),
      landedAt: landedAt || null,
      reportAt: reportAt || reportAtOf(rec),
      main: main ? String(main) : null,
      tip: tip ? String(tip).toLowerCase() : null,
    };
    return rec;
  }

  /**
   * The MEASURED overlap between the pair's two branches: what git said each side changed against its merge base, and
   * what both changed. Stored on the record so the card prints paths instead of the worker's prose, and so a sweep that
   * has already measured does not spawn git again. An empty set is stored as an answer (`ok: true, files: []`), which
   * is what lets the card say "no shared file" rather than showing nothing.
   */
  rememberEvidence(key, evidence = {}, at = this.now()) {
    this.load();
    const rec = this.records.get(String(key));
    if (!rec) return null;
    const files = [...new Set((evidence.files || []).map(normCollisionPath).filter(Boolean))].slice(0, COLLISION_FILES_CAP);
    rec.evidence = {
      at: evidence.at || nowIso(at),
      ok: evidence.ok === true,
      base: evidence.base || null,
      files,
      error: evidence.error ? clip(evidence.error, 300) : null,
    };
    if (evidence.ok === true) {
      rec.files = files;
      rec.relations = files.length ? [{ kind: "shared-file", files, measured: true }] : [];
    }
    return rec;
  }

  /**
   * THE VERSION-ONLY READING, kept on the record so the card and the report can name what was measured.
   *
   * Written only when the reading CHANGES: the sweep re-reads the manifests every tick (cheap - a few small file reads,
   * no git), and a record whose answer is the same one it already had must not make the book look moved. `at` is
   * therefore "when this reading last changed", not "when it was last confirmed".
   */
  rememberVersionCheck(key, check = {}, at = this.now()) {
    this.load();
    const rec = this.records.get(String(key));
    if (!rec) return null;
    const next = {
      tips: check.tips && typeof check.tips === "object" ? check.tips : null,
      ok: check.ok === true,
      versionOnly: check.versionOnly === true,
      files: (Array.isArray(check.files) ? check.files : []).map(normCollisionPath).filter(Boolean).slice(0, COLLISION_FILES_CAP),
      versions: check.versions && typeof check.versions === "object" ? { a: check.versions.a || null, b: check.versions.b || null } : null,
      pick: check.pick === "a" || check.pick === "b" ? check.pick : null,
      why: check.why ? clip(check.why, COLLISION_NOTE_CAP) : null,
    };
    const was = rec.versionCheck;
    const same =
      was &&
      Boolean(was.ok) === next.ok &&
      Boolean(was.versionOnly) === next.versionOnly &&
      was.pick === next.pick &&
      was.why === next.why &&
      JSON.stringify(was.files || []) === JSON.stringify(next.files) &&
      JSON.stringify(was.versions || null) === JSON.stringify(next.versions) &&
      JSON.stringify(was.tips || null) === JSON.stringify(next.tips);
    if (same) return rec;
    rec.versionCheck = { at: check.at || nowIso(at), ...next };
    return rec;
  }

  /**
   * A VERSION-ONLY OVERLAP IS A LAND ORDER, NOT A QUESTION FOR THE READER.
   *
   * The pair is real and it is kept - one record, naming both trees and the manifest they share - but the order is
   * already decided by the standing landing rule (rebase onto the then-current origin/main and keep the higher
   * version), so no person is asked and no notice is filed into either queue. The answer is a normal ruling with
   * `basis: "version"`, which is what keeps it out of the reader count, lets the card name it as a land order, and
   * lets the reader overrule it in one press if they disagree.
   *
   * `pick` is the side with the LOWER version: the higher number is the one that lands on top of it.
   */
  markLandOrder(key, { pick = null, files = [], versions = null, why = "", at = this.now() } = {}) {
    this.load();
    const rec = this.records.get(String(key));
    if (!rec || !rec.a?.path || !rec.b?.path) return null;
    if (pick !== "a" && pick !== "b") return null;
    const side = rec[pick];
    if (!side?.path) return null;
    const stamp = nowIso(at);
    rec.landOrder = {
      at: stamp,
      pick,
      files: (Array.isArray(files) ? files : []).map(normCollisionPath).filter(Boolean).slice(0, COLLISION_FILES_CAP),
      versions: versions && typeof versions === "object" ? { a: versions.a || null, b: versions.b || null } : null,
      why: clip(why, COLLISION_NOTE_CAP) || null,
    };
    rec.ruling = {
      at: stamp,
      pick,
      path: side.path,
      name: side.name,
      taskId: side.taskId ?? null,
      by: "auto",
      auto: true,
      basis: "version",
      reason: clip(why, COLLISION_NOTE_CAP) || null,
      note: "",
    };
    // The two halves of one answer: a record is the reader's question or the panel's answer, never both. A pair that
    // was already asking therefore leaves the count the moment the reading names it a land order.
    rec.readerAt = null;
    rec.readerWhy = null;
    return rec;
  }

  /**
   * A LAND ORDER THAT IS NO LONGER ONE. A pair can be version-only at one sweep and a real file fight at the next: one
   * side edits a source file the other also edits, or a dependency line appears in the manifest. The answer is
   * withdrawn - the ruling with it - so the ordinary path (filing, the pass, git's merge question) takes over and the
   * pair reaches the reader if it still cannot be settled. Deliberately NOT `autoWithheld`: that flag means the reader
   * overruled a pick, and nothing here was overruled by anybody.
   */
  withdrawLandOrder(key, { at = this.now(), reason = "" } = {}) {
    this.load();
    const rec = this.records.get(String(key));
    if (!rec || rec.ruling?.basis !== "version") return rec || null;
    rec.landOrder = null;
    rec.ruling = null;
    rec.readerAt = null;
    rec.readerWhy = null;
    rec.versionCheck = {
      at: nowIso(at),
      tips: rec.versionCheck?.tips || null,
      ok: true,
      versionOnly: false,
      files: [],
      versions: null,
      pick: null,
      why: clip(reason, COLLISION_NOTE_CAP) || "the overlap is no longer a version line alone",
    };
    return rec;
  }

  /** The last landing answer for a record, cached so the ten-second sweep does not ask git the same question twice. */
  rememberLand(key, land = {}) {
    this.load();
    const rec = this.records.get(String(key));
    if (!rec) return null;
    rec.land = {
      at: land.at || nowIso(this.now()),
      tips: land.tips && typeof land.tips === "object" ? land.tips : null,
      main: land.main || null,
      landed: land.landed === true,
      commit: land.commit || null,
      landedAt: land.landedAt || null,
      error: land.error ? clip(land.error, 300) : null,
    };
    return rec;
  }

  /**
   * One tree's row view of every LIVE collision it is part of, most urgent first - and `historyFor` the same view of
   * the records a landing has superseded. The live lane is what the chip counts, what the Human rotation steps into
   * and what the card asks about; history is kept, marked `superseded`, naming the commit that landed it, and offers
   * nothing. `role` says which side of the record this tree is and `other` names the counterpart, while `a` and `b`
   * carry BOTH sides so the card can draw the pair once and name both trees on both rows.
   */
  forTree(treePath = "") {
    return this.viewsFor(treePath).sort((x, y) => {
      const rank = { reader: 0, assistants: 1, ruled: 2 };
      return (rank[x.state] ?? 3) - (rank[y.state] ?? 3) || String(x.firstAt || "").localeCompare(String(y.firstAt || ""));
    });
  }

  historyFor(treePath = "") {
    return this.viewsFor(treePath, { history: true }).sort((x, y) =>
      String(y.superseded?.at || y.lastAt || "").localeCompare(String(x.superseded?.at || x.lastAt || "")),
    );
  }

  viewsFor(treePath = "", { history = false } = {}) {
    this.load();
    const want = normCollisionPath(treePath);
    if (!want) return [];
    const out = [];
    for (const rec of this.records.values()) {
      const superseded = Boolean(rec.superseded);
      if (superseded !== history) continue;
      const sides = normSidesOf(rec);
      const a = Boolean(sides.a) && sides.a === want;
      const b = Boolean(sides.b) && sides.b === want;
      if (!a && !b) continue;
      const other = a ? rec.b : rec.a;
      // The sides whose own task is finished, derived on every read: the card names them as already stood down and the
      // reader's rotation skips the pair, because a collision with finished work is not a decision waiting on anybody.
      const stoodByTask = finishedSides(rec);
      const resolution = rec.resolve && typeof rec.resolve === "object"
        ? { ...rec.resolve }
        : { kind: rec.b ? "tree" : rec.sameTree ? "same-tree" : "none", how: null, target: rec.bTarget || null, taskId: null, thread: null, said: null };
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
        resolution,
        // A press is only offered when there are two trees and measured paths between them: the card's own rule, kept
        // in the record so a test and the page agree instead of each deciding what "evidence enough" means.
        canRule: !superseded && resolution.kind === "tree" && Array.isArray(rec.files) && rec.files.length > 0,
        files: [...rec.files],
        relations: rec.relations,
        notes: rec.notes.slice(-5),
        firstAt: rec.firstAt,
        lastAt: rec.lastAt,
        reportedAt: reportAtOf(rec),
        passes: rec.passes,
        // THE VERDICT, for the card: a note whose target named no row and no live agent. Not a question, so `waiting`
        // below is false and the Human rotation never holds it; the card still prints it, so the report stays readable.
        // Written out without the read-time `upgraded` marker: a saved verdict is a verdict, not a migration note.
        absent: rec.absent
          ? { at: rec.absent.at || null, target: rec.absent.target || null, how: rec.absent.how || null, why: rec.absent.why || null }
          : null,
        readerAt: rec.readerAt,
        readerWhy: rec.readerWhy,
        stoodDown: ["a", "b"].filter((side) => rec.stoodDown[side]).map((side) => ({ side, name: rec[side]?.name || null, ...rec.stoodDown[side] })),
        filed: Object.entries(rec.filed || {}).map(([assistantId, f]) => ({ assistantId, ...f })),
        ruling: rec.ruling ? { ...rec.ruling } : null,
        // git's own answer, so the card can say why a pair is the reader's; and whether the reader has already
        // overruled an automatic pick, so the card can say that instead of showing the same pick again.
        merge: rec.merge ? { ...rec.merge } : null,
        autoWithheld: rec.autoWithheld ? { ...rec.autoWithheld } : null,
        // A version-only overlap: `landOrder` is the named order the card prints, `versionCheck` is the reading it came
        // from (with the tips), so a reader can see what was measured and when.
        landOrder: rec.landOrder ? { ...rec.landOrder } : null,
        versionCheck: rec.versionCheck ? { ...rec.versionCheck } : null,
        // The measured overlap and the landing check, as the store read them: the card prints paths from the first and
        // the superseding commit from the second.
        evidence: rec.evidence ? { ...rec.evidence } : null,
        land: rec.land ? { ...rec.land } : null,
        superseded: rec.superseded ? { ...rec.superseded } : null,
        // The reader's own way out of a pair that has not been handed over yet. A verdict offers nothing: there is no
        // second side for a press to order, so no "bring it to me" either.
        canAsk: !rec.ruling && !rec.readerAt && !rec.absent && !superseded,
      });
    }
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
  const out = { assistants: 0, reader: 0, ruled: 0, superseded: 0, absent: 0 };
  for (const rec of records || []) out[stateOf(rec)] += 1;
  return out;
}
