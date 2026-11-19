// THE COLLISION SWEEP: assistants first, the reader only when the assistants cannot settle it.
//
// `lib/collisions.js` answers "are these two live trees touching the same work, and what is the evidence". This file
// turns that answer into the two things the panel does about it, on every pass:
//
//   1. FILE IT. A pair the panel has just seen, or one nobody has filed yet, becomes one row in each owning
//      assistant's queue (lib/assistant/queue.js), naming the other tree, the other assistant and the shared evidence.
//      Nothing is started: the row is a notice with the files on it, so the queue's own single-writer rule and the
//      assistant both see the overlap without the panel deciding who yields. Two trees owned by ONE assistant get one
//      row (that assistant cannot coordinate with itself, and two copies of one notice is noise).
//   2. HAND IT OVER, on exactly the three conditions the brief names:
//        both-claim       both sides have their OWN open queue row claiming a shared file. The panel cannot say which
//                         of the two is the one to stop, and neither could the queue's single-writer rule;
//        no-stand-down    the pair survived a full PASS - one sweep at least `COLLISION_PASS_MS` after the one that
//                         filed it - without either side closing or parking its filed row;
//        asked            the reader pressed "bring this to me" (POST /api/collisions {op:"ask"}), or a WORKER reported
//                         it with a COLLISION line that names no row (nothing else can act on that one).
//
// A RULED PAIR STAYS RULED. The ruling lives on the record in the book, so a pair that is detected again after the
// reader ruled on it renders as already ruled - not as a fresh question - and the priority is broadcast to both
// assistants as a row once, when the ruling is made (server.js).
//
// The sweep is pure about its dependencies: rows and tasks arrive as data, and the two side effects (file a row, read a
// queue) travel in as callbacks. That is what lets a unit test drive filing, stand-down and escalation without a panel,
// an assistant or a filesystem.
import { detectCollisions, normCollisionPath, pairKey, relationSentence } from "./collisions.js";

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const normFiles = (list) => new Set((Array.isArray(list) ? list : []).map(normCollisionPath).filter(Boolean));
const shares = (files, want) => {
  if (!files.size || !want.size) return false;
  for (const f of files) if (want.has(f)) return true;
  return false;
};

/** Is this queue row still open? A done or parked row is closed, and a closed filed row is a STAND-DOWN. */
const openTask = (t) => t && (t.state === "queued" || t.state === "running");

/**
 * The rows the panel files for one record, as payloads: one per distinct owner, each naming the other tree, the other
 * assistant and the evidence. Exported so a test reads the exact words a queue row carries.
 */
export function queueRowsFor(record = {}, { ownerOf = () => null, nameOf = (id) => id, project = null } = {}) {
  if (!record.a || !record.b) return [];
  const ownerA = ownerOf(record.a);
  const ownerB = ownerOf(record.b);
  const files = (record.files || []).slice(0, 24);
  const both = relationSentence(record.relations || [], record.b.name);
  const evidence = files.length ? files.join(", ") : both || "the two trees' branches overlap";
  const build = (mine, other, ownerMine, ownerOther) => {
    const otherName = nameOf(ownerOther) || "another assistant";
    const mineName = nameOf(ownerMine) || "an assistant";
    const shared = files.length ? `${files.length} shared file${files.length === 1 ? "" : "s"}` : "an overlapping branch";
    return {
      assistantId: ownerMine,
      side: mine.path === record.a.path ? "a" : "b",
      title: clip(`Collision with ${other.name}: ${shared} with ${otherName}`, 200),
      detail: clip(
        [
          `The panel saw two live runs in ${project || record.project || "this project"} touching the same work.`,
          `Your side: ${mine.path} (branch ${mine.branch || "none"}).`,
          `The other side: ${other.path || record.bTarget || "an unnamed tree"} (branch ${other.branch || "none"}), owned by ${otherName} - you are ${mineName}.`,
          `Evidence: ${evidence}.`,
          both ? `Relation: ${both}.` : "",
          "If your work should yield, close or park this row: that is standing down, and the pair does not come to the reader. If you keep it, the reader rules when neither side stands down within a pass, or when both queues claim the same files.",
        ]
          .filter(Boolean)
          .join(" "),
        4000,
      ),
      files,
      project: project || record.project || null,
      worktree: mine.path,
      other: other.path || record.bTarget || null,
      pairKey: record.key,
    };
  };
  if (ownerA && ownerB && ownerA === ownerB) {
    // One assistant owns both trees: one row, naming BOTH sides, because a second copy of one notice is noise and this
    // assistant can never "stand down" against itself.
    const one = build(record.a, record.b, ownerA, ownerB);
    one.title = clip(`Collision inside your own trees: ${record.a.name} and ${record.b.name} overlap on ${files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "a branch"}`, 200);
    one.detail = clip(
      `Both trees are yours: ${record.a.path} (branch ${record.a.branch || "none"}) and ${record.b.path} (branch ${record.b.branch || "none"}). Evidence: ${evidence}. ${
        both ? `Relation: ${both}. ` : ""
      }Decide which of the two yields - the panel does not rule between one assistant's own trees unless you ask it to.`,
      4000,
    );
    return [one];
  }
  const out = [];
  if (ownerA) out.push(build(record.a, record.b, ownerA, ownerB));
  if (ownerB) out.push(build(record.b, record.a, ownerB, ownerA));
  return out;
}

/**
 * The priority row a ruling broadcasts to both assistants: which side goes first, on which files. Filed once per
 * distinct owner, and only by the route that records the ruling.
 */
export function rulingRowsFor(record = {}, { ownerOf = () => null, nameOf = (id) => id, project = null } = {}) {
  if (!record.ruling || !record.a || !record.b) return [];
  const first = record.ruling.pick === "a" ? record.a : record.b;
  const second = record.ruling.pick === "a" ? record.b : record.a;
  const files = (record.files || []).slice(0, 24);
  const owners = [...new Set([ownerOf(record.a), ownerOf(record.b)].filter(Boolean))];
  return owners.map((ownerId) => ({
    assistantId: ownerId,
    side: ownerId === ownerOf(record.a) ? "a" : "b",
    title: clip(`Ruled: ${first.name} goes first over ${second.name}`, 200),
    detail: clip(
      `The reader ruled on the collision between ${record.a.path} (branch ${record.a.branch || "none"}) and ${record.b.path} (branch ${record.b.branch || "none"}): ${first.name} goes first${
        record.ruling.note ? ` - "${record.ruling.note}"` : ""
      }. ${files.length ? `The shared files: ${files.join(", ")}.` : ""} ${second.name} waits, or changes a different path, until ${first.name} has landed its work. This decision is stored against the pair: it will not be asked again.`,
      4000,
    ),
    files,
    project: project || record.project || null,
    worktree: ownerId === ownerOf(record.a) ? record.a.path : record.b.path,
    other: ownerId === ownerOf(record.a) ? record.b.path : record.a.path,
    pairKey: record.key,
  }));
}

/**
 * One sweep. Returns a small report - the pairs seen, the rows filed, the pairs handed over - which the route and the
 * tests read; nothing in it is a second source of truth.
 *
 * `rows` must carry `project` (server.js `rowsWithProject`). `ownerOf(side)` answers the assistant id that owns a tree
 * (server.js: locks.owner, defaulting to #1). `tasksFor(assistantId)` answers that assistant's queue rows as plain
 * objects (`{id, state, files, title}`). `fileQueue(payload)` writes one row and answers `{taskId}` or null.
 */
export function sweepCollisions({ rows = [], book, now = Date.now(), ownerOf = () => null, nameOf = (id) => id, tasksFor = () => [], fileQueue = null, project = null } = {}) {
  if (!book) throw new Error("sweepCollisions needs the collision book");
  const pairs = detectCollisions(rows);
  const seen = new Set(pairs.map((p) => p.key));
  const report = { at: new Date(now).toISOString(), pairs: pairs.length, filed: [], escalated: [], stoodDown: [] };
  // Every pair the detector still sees gets its record, its filing, its stand-down check and its escalation test - in
  // that order, because the reading of a queue row is what the last two ask about.
  for (const pair of pairs) {
    const { record, passTicked } = book.upsertDetected(pair, now);
    seen.add(record.key);
    // ---- 1. file it, once per owner, if the book has not already done so
    const wanted = queueRowsFor(record, { ownerOf, nameOf, project });
    for (const payload of wanted) {
      if (record.filed[payload.assistantId]) continue;
      if (typeof fileQueue !== "function") continue;
      let filed = null;
      try {
        filed = fileQueue(payload);
      } catch (err) {
        filed = null;
        report.filed.push({ pairKey: record.key, assistantId: payload.assistantId, error: String((err && err.message) || err) });
      }
      if (filed && filed.taskId) {
        record.filed[payload.assistantId] = { taskId: filed.taskId, at: new Date(now).toISOString(), side: payload.side, tree: payload.worktree };
        report.filed.push({ pairKey: record.key, assistantId: payload.assistantId, taskId: filed.taskId, side: payload.side });
      }
    }
    // ---- 2. did a side stand down? A filed row that is no longer open is the assistants' own answer.
    const wantedFiles = normFiles(record.files);
    const tasksByOwner = new Map();
    const tasksOf = (id) => {
      if (!id) return [];
      if (!tasksByOwner.has(id)) tasksByOwner.set(id, tasksFor(id) || []);
      return tasksByOwner.get(id);
    };
    for (const side of ["a", "b"]) {
      const who = ownerOf(record[side]);
      const entry = record.filed[who];
      if (!who || !entry || record.stoodDown[side]) continue;
      const task = tasksOf(who).find((t) => Number(t.id) === Number(entry.taskId));
      if (task && !openTask(task)) {
        book.standDown(record.key, side, now);
        report.stoodDown.push({ pairKey: record.key, side, taskId: entry.taskId, state: task.state });
      }
    }
    if (record.ruling || record.readerAt) continue;
    // ---- 3. the reader's turn: both sides claiming, or a full pass with nobody standing down
    const filedIds = new Set(Object.values(record.filed).map((f) => Number(f.taskId)));
    const claimsOf = (side) => {
      const who = ownerOf(record[side]);
      if (!who) return false;
      return tasksOf(who).some((t) => openTask(t) && !filedIds.has(Number(t.id)) && shares(normFiles(t.files), wantedFiles));
    };
    const bothClaim = Boolean(wantedFiles.size) && claimsOf("a") && claimsOf("b");
    const stoodDown = Boolean(record.stoodDown.a || record.stoodDown.b);
    let why = null;
    if (bothClaim) why = "both-claim";
    else if (passTicked && record.passes > 1 && !stoodDown) why = "no-stand-down";
    if (why) {
      book.escalate(record.key, { why, at: now });
      report.escalated.push({ pairKey: record.key, why });
    }
  }
  // A reported note has no detection of its own: it is still a collision record, and it still needs its filing and its
  // pass (a note with no counterpart was already handed over by the book).
  for (const record of book.all()) {
    if (record.source !== "reported" || seen.has(record.key)) continue;
    const wanted = queueRowsFor(record, { ownerOf, nameOf, project });
    for (const payload of wanted) {
      if (record.filed[payload.assistantId] || typeof fileQueue !== "function") continue;
      const filed = fileQueue(payload);
      if (filed && filed.taskId) {
        record.filed[payload.assistantId] = { taskId: filed.taskId, at: new Date(now).toISOString(), side: payload.side, tree: payload.worktree };
        report.filed.push({ pairKey: record.key, assistantId: payload.assistantId, taskId: filed.taskId, side: payload.side });
      }
    }
  }
  book.closeUndetected(seen, now);
  return report;
}

/** The pair key for two trees, re-exported so a caller does not have to import two modules to ask one question. */
export { pairKey };
