// COLLISION DETECTION: what a collision is recorded as, why a pair settled the way it did, and the detection itself.
//
// Split out of `lib/collisions.js`, which keeps the store (`CollisionBook`) and its views. This half is pure: rows,
// notes and file contents in, records and an order out. It reads the disk in exactly one place, when an untracked path
// is a directory and the files beneath it are the evidence (`filesUnder`) - never a repository, never the store.
//
// Re-exported by `lib/collisions.js` under the names importers have always read them by, so no import site moved when
// the detection moved. `lib/collision-flow.js` owns the sweep that files queue rows and escalates,
// `lib/collision-merge.js` owns the git probe, and server.js owns the store instance and the snapshot overlay.
import { readdirSync, statSync } from "node:fs";
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

// ---- THE REASON, AS A FIELD --------------------------------------------------------------------------------------
// A record used to answer "who settled this" and "why" in prose: a ruling carried a sentence, and a pair still waiting
// carried none at all. A reader asking "why did the panel put THAT one first?" could not tell git's own answer from the
// reader's standing order from a person's written ruling, and a page could only re-word the sentence and hope.
//
// So every settlement, and every pair still waiting, carries a REASON object with the rule as an ID. The ids are a
// closed vocabulary - the branch of `settleCollision` that produced the pick, the tie-break `deterministicPick` used,
// the version line, or a person - and the label is the one wording the page and a report print.
//
//   git-one-direction   git's probe found exactly one direction that merges cleanly; that direction names the order.
//   older-cut           both directions clean; the reader's own first tie-break, the older cut, goes first.
//   fewer-commits       both clean and the cuts tie; the side with fewer commits goes first.
//   branch-name         both clean, cuts and commit counts tie; the branch name decides.
//   pair-order          no comparable fact at all; the pair's own stable order decides.
//   nothing-committed   both directions "clean" because the two tips are the same commit: git compared nothing.
//   merge-unknown       git could not answer in either direction.
//   both-conflict       both directions conflict: the one shape that is a person's question.
//   version-line        the only shared path is a manifest version line, settled by the land step.
//   reader              a person ruled, with their own words as the note.
//   none               nothing can pick (a reported note with no counterpart, or no evidence at all).
export const COLLISION_RULES = {
  "git-one-direction": "git: one merge direction is clean",
  "older-cut": "older cut first",
  "fewer-commits": "fewer commits first",
  "branch-name": "branch name breaks the tie",
  "pair-order": "the pair's own order",
  "nothing-committed": "git had nothing to compare",
  "merge-unknown": "git could not answer",
  "both-conflict": "both merge directions conflict",
  "version-line": "the version line is the land order",
  reader: "your ruling",
  none: "no rule can pick",
};

/** The one wording a rule id is printed by; an unknown id is said as it is rather than silently relabelled. */
export const ruleLabelOf = (rule) => COLLISION_RULES[String(rule || "").trim()] || String(rule || "").trim() || "no rule on record";

/** The rule a `deterministicPick` basis names, for a caller that has only the basis. */
const ruleForBasis = (basis) =>
  basis === "older cut"
    ? "older-cut"
    : basis === "fewer commits"
      ? "fewer-commits"
      : basis === "branch name"
        ? "branch-name"
        : "pair-order";

/**
 * The rule an EXISTING ruling names. A record written before the field existed carries only `auto`/`basis`; this reads
 * that shape so an old ruling still says which rule settled it on the page and in the history, without a rewrite.
 */
export function ruleOfRuling(ruling = {}) {
  if (!ruling || typeof ruling !== "object") return "none";
  if (ruling.rule && COLLISION_RULES[String(ruling.rule)]) return String(ruling.rule);
  if (!ruling.auto) return "reader";
  if (String(ruling.basis || "") === "version") return "version-line";
  if (String(ruling.basis || "") === "merge") return "git-one-direction";
  return ruleForBasis(String(ruling.basis || ""));
}

/** The pair's own relation that produced it, as the record keeps it: the first relation and the files it named. */
export function relationOfRecord(rec = {}) {
  const relations = Array.isArray(rec.relations) ? rec.relations.filter(Boolean) : [];
  if (!relations.length) return null;
  const first = relations[0];
  return {
    kind: first.kind || null,
    ...(first.parent ? { parent: String(first.parent) } : {}),
    ...(first.branch ? { branch: String(first.branch) } : {}),
    ...(first.target ? { target: String(first.target) } : {}),
    files: (Array.isArray(first.files) ? first.files : []).map(normCollisionPath).filter(Boolean).slice(0, COLLISION_FILES_CAP),
  };
}

/**
 * THE REASON, one object, for every record - settled or not. This is what the popup prints and what the history route
 * hands a report; it is derived from the record (never a second store), and every field is either the record's own or
 * the store's own answer through `settleCollision`.
 *
 * A pair NOBODY has ruled says what the panel WOULD do: `would` names the side, the rule that picked it and the
 * sentence why. A pair git cannot order says that instead (`pick: null`, rule `both-conflict`), which is the honest
 * answer to "what would happen if nobody ruled" - nothing would, and that is why it is a card.
 *
 * `outcome` is the record's state at the moment of reading: a ruling that a later landing ended reports `superseded`,
 * because the outcome a reader is looking at is the landing, not the ruling it started from.
 */
export function reasonOf(rec = {}) {
  const state = stateOf(rec);
  const ruling = rec.ruling && typeof rec.ruling === "object" ? rec.ruling : null;
  const relation = relationOfRecord(rec);
  const files = (Array.isArray(rec.files) ? rec.files : []).map(normCollisionPath).filter(Boolean).slice(0, COLLISION_FILES_CAP);
  const pair = {
    a: rec.a?.path ? { path: rec.a.path, name: rec.a.name || null, branch: rec.a.branch || null, taskId: rec.a.taskId ?? null } : null,
    b: rec.b?.path ? { path: rec.b.path, name: rec.b.name || null, branch: rec.b.branch || null, taskId: rec.b.taskId ?? null } : null,
    bTarget: rec.bTarget || null,
  };
  const relationSay = relationSentence(rec.relations || [], rec.b?.name || rec.bTarget || "the other tree");
  if (ruling) {
    const rule = ruleOfRuling(ruling);
    const pick = ruling.pick === "a" || ruling.pick === "b" ? ruling.pick : null;
    const side = pick ? rec[pick] : null;
    return {
      rule,
      label: ruleLabelOf(rule),
      settled: true,
      by: ruling.by || (ruling.auto ? "auto" : "reader"),
      auto: Boolean(ruling.auto),
      at: ruling.at || null,
      pick,
      pickName: side?.name || ruling.name || null,
      pickPath: side?.path || ruling.path || null,
      taskId: side?.taskId ?? ruling.taskId ?? null,
      outcome: state,
      why: ruling.why || null,
      reason: ruling.reason || null,
      note: ruling.note || null,
      relation,
      relationSentence: relationSay,
      files,
      pair,
    };
  }
  // NOTHING HAS RULED. Ask the same two functions the sweep asks, so the page cannot promise an order the sweep would
  // not take.
  // A REPORTED NOTE WITH NO COUNTERPART is not a pair: there is no second side for an order to put first, so the reason
  // says exactly that rather than inventing an order between one tree and nothing.
  if (!rec.b?.path) {
    return {
      rule: "none",
      label: ruleLabelOf("none"),
      settled: false,
      by: null,
      auto: false,
      at: null,
      pick: null,
      pickName: null,
      pickPath: null,
      taskId: null,
      outcome: state,
      why: rec.bTarget ? "no-counterpart" : null,
      reason: null,
      note: null,
      would: null,
      relation,
      relationSentence: relationSay,
      files,
      pair,
    };
  }
  const settled = settleCollision(rec);
  let would;
  if (settled.pick) {
    const side = settled.pick === "a" ? rec.a : rec.b;
    would = {
      pick: settled.pick,
      name: side?.name || side?.branch || null,
      path: side?.path || null,
      rule: settled.rule || ruleForBasis(String(settled.basis || "")),
      label: ruleLabelOf(settled.rule || ruleForBasis(String(settled.basis || ""))),
      why: settled.why || null,
      reason: settled.reason || null,
      fromGit: Boolean(rec.merge),
    };
  } else if (rec.merge && typeof rec.merge === "object") {
    // git was asked and could not name an order: that IS the answer, and it is why the pair is the reader's.
    const rule = settled.why === "both-conflict" ? "both-conflict" : settled.why === "nothing-committed" ? "nothing-committed" : "merge-unknown";
    would = { pick: null, name: null, path: null, rule, label: ruleLabelOf(rule), why: settled.why || null, reason: settled.reason || null, fromGit: true };
  } else {
    // git has NOT been asked yet. The standing order is still worth naming - it is what the panel does with a pair that
    // never reaches a person - but it is labelled as the standing order rather than as git's judgement.
    const chosen = deterministicPick(rec.a || {}, rec.b || {}, {});
    const side = chosen.pick === "a" ? rec.a : rec.b;
    const rule = chosen.rule || ruleForBasis(chosen.basis);
    would = {
      pick: chosen.pick,
      name: side?.name || side?.branch || null,
      path: side?.path || null,
      rule,
      label: ruleLabelOf(rule),
      why: "no-merge-check",
      reason: `${side?.name || "that side"} would go first by the standing order (${chosen.basis}); git has not been asked about this pair yet`,
      fromGit: false,
    };
  }
  return {
    rule: would.rule,
    label: would.label,
    settled: false,
    by: null,
    auto: false,
    at: null,
    pick: null,
    pickName: null,
    pickPath: null,
    taskId: null,
    outcome: state,
    why: would.why,
    reason: null,
    note: null,
    would,
    relation,
    relationSentence: relationSay,
    files,
    pair,
  };
}
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

// A CLIPPED STRING, the one shape both halves write: the store clips a record's note and target to the same caps, so
// the one copy lives here and the store imports it.
export const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
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

/**
 * IS THIS PAIR WAITING ON A PERSON? The one predicate the header badge, the history's top group and the route's own
 * `waiting` count all read. A record in the reader state whose side's OWN task is done or parked is not waiting: the
 * work the collision was about has been laid down, which is what `finishedSides` answers. Derived on every read, never
 * stored, so a tree that picks the work up again comes back as a waiting pair.
 */
export function waitingOf(rec = {}) {
  if (stateOf(rec) !== "reader") return false;
  return finishedSides(rec).length === 0;
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
  if (cutA !== null && cutB !== null && cutA !== cutB) return { pick: cutA < cutB ? "a" : "b", basis: "older cut", rule: "older-cut" };
  const nA = countOf(one.commits);
  const nB = countOf(two.commits);
  if (nA !== null && nB !== null && nA !== nB) return { pick: nA < nB ? "a" : "b", basis: "fewer commits", rule: "fewer-commits" };
  const branchA = String(a?.branch || "").replace(/^refs\/heads\//, "").toLowerCase();
  const branchB = String(b?.branch || "").replace(/^refs\/heads\//, "").toLowerCase();
  if (branchA && branchB && branchA !== branchB) return { pick: branchA < branchB ? "a" : "b", basis: "branch name", rule: "branch-name" };
  // No comparable fact at all: `a` is the side whose path sorts first (`detectCollisions`), so answering `a` is still
  // the same answer every time this pair is seen.
  return { pick: "a", basis: "the pair's own order", rule: "pair-order" };
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
    return { pick: "a", why: "one-direction", basis: "merge", rule: "git-one-direction", reason: `${bName} merges onto ${aName} without a conflict, so ${aName} goes first` };
  }
  if (cleanB && !cleanA) {
    return { pick: "b", why: "one-direction", basis: "merge", rule: "git-one-direction", reason: `${aName} merges onto ${bName} without a conflict, so ${bName} goes first` };
  }
  if (cleanA && cleanB) {
    if (mergeComparedNothing(rec)) {
      return {
        pick: null,
        why: "nothing-committed",
        basis: "merge",
        rule: "nothing-committed",
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
    return { pick: chosen.pick, why: "both-clean", basis: chosen.basis, rule: chosen.rule, reason: why };
  }
  if (aFirst === false && bFirst === false) {
    return { pick: null, why: "both-conflict", basis: "merge", rule: "both-conflict", reason: "both directions conflict, so the order is the reader's to choose" };
  }
  return { pick: null, why: "unknown", basis: "merge", rule: null, reason: "git could not answer the merge question in either direction" };
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
