// THE COLLISION SWEEP: assistants first, the reader only when the assistants cannot settle it.
//
// `lib/collisions.js` answers "are these two live trees touching the same work, and what is the evidence". This file
// turns that answer into the two things the panel does about it, on every pass:
//
//   0. SETTLE IT, FROM GIT. Most pairs have an order that makes the merge no harder, and finding it is not a judgement:
//      `merge-tree` in both directions (`lib/collision-merge.js`) answers "can this side land first" in milliseconds,
//      in the object database, with no checkout and no model. One clean direction names the order; two clean directions
//      are settled by the reader's own tie-break (lib/collisions.js `deterministicPick`); the pick is written through
//      the SAME pair-scoped store a reader's ruling uses, tagged automatic, and the composition root broadcasts it as a
//      "Ruled (automatic)" row. A settled pair files no notice and is never a card.
//   1. FILE IT. A pair the panel has just seen, or one nobody has filed yet, becomes one row in each owning
//      assistant's queue (lib/assistant/queue.js), naming the other tree, the other assistant and the shared evidence.
//      Nothing is started: the row is a notice with the files on it, so the queue's own single-writer rule and the
//      assistant both see the overlap without the panel deciding who yields. Two trees owned by ONE assistant get one
//      row (that assistant cannot coordinate with itself, and two copies of one notice is noise).
//   2. HAND IT OVER, on exactly the three conditions the brief names, and only for a pair git cannot order (both
//      directions conflict, or the question could not be asked):
//        both-claim       both sides have their OWN open queue row claiming a shared file. The panel cannot say which
//                         of the two is the one to stop, and neither could the queue's single-writer rule;
//        no-stand-down    the pair survived a full PASS - one sweep at least `COLLISION_PASS_MS` after the one that
//                         filed it - without either side closing or parking its filed row;
//        asked            the reader pressed "bring this to me" (POST /api/collisions {op:"ask"}), or a WORKER reported
//                         it with a COLLISION line that names no row (nothing else can act on that one).
//
// A RULED PAIR STAYS RULED. The ruling lives on the record in the book, so a pair that is detected again after the
// reader ruled on it renders as auto-settled (or already ruled) - not as a fresh question - and the priority is
// broadcast to both assistants as a row once, when the ruling is made (server.js).
//
// STEP 0a SITS IN FRONT OF ALL OF IT: THE VERSION LINE. Two landings in one repo both claim the next patch above main,
// so their only shared hunk is package.json's version - settled at LAND time by rebasing onto the current main and
// keeping the higher version, and not a thing a person decides. A pair whose only shared paths are manifest version
// fields, differing in nothing but the number, is recorded as a LAND ORDER (named, kept, `stateOf` -> "ruled") and
// files no notice and asks nobody. Everything else is untouched: a shared source file, test or doc is still a
// collision, and the accounting of `gone`/`absent` records is exactly what it was.
//
// The sweep is pure about its dependencies: rows and tasks arrive as data, and the two side effects (file a row, read a
// queue) travel in as callbacks. That is what lets a unit test drive filing, stand-down and escalation without a panel,
// an assistant or a filesystem.
import {
  COLLISION_FACT_CAP,
  COLLISION_LAND_RECHECK_MS,
  COLLISION_VERSION_CAP,
  detectCollisions,
  finishedSides,
  isVersionCarrier,
  mayAskReader,
  normCollisionPath,
  pairKey,
  relationSentence,
  reportAtOf,
  settleCollision,
} from "./collisions.js";

// How many un-settled pairs ONE sweep may put to git. A pair is probed only until it is settled, and a settled pair is
// never probed again, so this is a ceiling on a burst (a board opening with ten new overlaps), not a per-tick cost.
export const COLLISION_PROBE_CAP = 6;

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
    const shared = files.length ? `${files.length} shared file${files.length === 1 ? "" : "s"}` : "a reported overlap";
    // The task each side is working, as the record resolved it: its id, and its own title when the board read one -
    // a queue row that only knows "#12" is the notice this feature replaces with "#12 Land the card on both rows".
    const task = (side) =>
      side.taskId ? `, task #${side.taskId}${side.task?.name ? ` (${clip(side.task.name, 90)}${side.task.state ? `, ${side.task.state}` : ""})` : ""}` : "";
    return {
      assistantId: ownerMine,
      side: mine.path === record.a.path ? "a" : "b",
      title: clip(`Collision with ${other.name}: ${shared} with ${otherName}`, 200),
      detail: clip(
        [
          `The panel saw two live runs in ${project || record.project || "this project"} touching the same work.`,
          `Your side: ${mine.path} (branch ${mine.branch || "none"}${task(mine)}).`,
          `The other side: ${other.path || record.bTarget || "an unnamed tree"} (branch ${other.branch || "none"}${task(other)}), owned by ${otherName} - you are ${mineName}.`,
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
 *
 * AN AUTOMATIC RULING IS STILL A RULED ROW, because the row is what makes the order take effect - an assistant reads
 * its queue, not the panel's store. It is TAGGED as automatic in the title and in the sentence, so both owning
 * assistants can tell a pick the panel made from git's answer ("Ruled (automatic): ...") from the reader's own
 * ("Ruled: ..."), and the sentence says the reader can overrule it with one press.
 */
export function rulingRowsFor(record = {}, { ownerOf = () => null, nameOf = (id) => id, project = null } = {}) {
  if (!record.ruling || !record.a || !record.b) return [];
  const first = record.ruling.pick === "a" ? record.a : record.b;
  const second = record.ruling.pick === "a" ? record.b : record.a;
  const files = (record.files || []).slice(0, 24);
  const owners = [...new Set([ownerOf(record.a), ownerOf(record.b)].filter(Boolean))];
  const auto = Boolean(record.ruling.auto);
  const reason = record.ruling.reason ? String(record.ruling.reason) : "";
  return owners.map((ownerId) => ({
    assistantId: ownerId,
    side: ownerId === ownerOf(record.a) ? "a" : "b",
    automatic: auto,
    title: clip(`${auto ? "Ruled (automatic)" : "Ruled"}: ${first.name} goes first over ${second.name}`, 200),
    detail: clip(
      `${
        auto
          ? `The PANEL settled this pair automatically, not the reader: git's own merge check on the two tips found ${
              reason || "no conflict in either direction"
            }. `
          : "The reader ruled on the collision between "
      }${record.a.path} (branch ${record.a.branch || "none"}${record.a.taskId ? `, task #${record.a.taskId}` : ""}) and ${record.b.path} (branch ${
        record.b.branch || "none"
      }${record.b.taskId ? `, task #${record.b.taskId}` : ""}): ${first.name}${first.taskId ? ` (#${first.taskId})` : ""} goes first${
        !auto && record.ruling.note ? ` - "${record.ruling.note}"` : ""
      }. ${files.length ? `The shared files: ${files.join(", ")}.` : ""} ${second.name} waits, or changes a different path, until ${first.name} has landed its work. This decision is stored against the pair: it will not be asked again.${
        auto ? " If your work should go first instead, say so - the reader can overrule this automatic pick with one press." : ""
      }`,
      4000,
    ),
    files,
    project: project || record.project || null,
    worktree: ownerId === ownerOf(record.a) ? record.a.path : record.b.path,
    other: ownerId === ownerOf(record.a) ? record.b.path : record.a.path,
    pairKey: record.key,
  }));
}

// Is git's stored answer still about the tips this pair stands on? The probe is reused while it is, so a conflicting
// pair does not spawn two merge-trees every tick; a new commit on either side is a new question and is asked again.
const headOf = (side) => String(side?.head || "").trim().toLowerCase();
const sameTips = (merge, pair) => {
  const a = headOf(pair?.a);
  const b = headOf(pair?.b);
  return Boolean(a && b && merge?.tips?.a && merge?.tips?.b && merge.tips.a === a && merge.tips.b === b);
};

/**
 * The sentence a LAND ORDER says: which tree carries which number, and why that already is an order. One helper so the
 * card, the record and the sweep report print the same words.
 */
function landOrderWhy(record = {}, check = {}) {
  const versions = check.versions || {};
  const pick = check.pick === "b" ? "b" : "a";
  const first = record[pick] || {};
  const second = record[pick === "a" ? "b" : "a"] || {};
  const firstName = first.name || first.path || "the first tree";
  const secondName = second.name || second.path || "the second tree";
  const firstVersion = pick === "a" ? versions.a : versions.b;
  const secondVersion = pick === "a" ? versions.b : versions.a;
  const files = (check.files || []).join(", ") || "the manifest";
  return `${files} is the only shared path and the version line is the only difference: ${firstName} carries ${firstVersion}, ${secondName} carries ${secondVersion}, and the land step rebases onto the current main keeping the higher version - so ${firstName} goes first and ${secondName} lands on top. That is a land order, not a file fight.`;
}

/**
 * One sweep. Returns a small report - the pairs seen, the rows filed, the pairs handed over - which the route and the
 * tests read; nothing in it is a second source of truth.
 *
 * `rows` must carry `project` (server.js `rowsWithProject`). `ownerOf(side)` answers the assistant id that owns a tree
 * (server.js: locks.owner, defaulting to #1). `taskFor(row)` answers the queue row that owns that tree, as
 * `lib/collisions.js` `owningTaskFor` returns it (`{id, name, state, open, assistantId, assistant}`), or null -
 * `taskIdFor(row)` is the older id-only seam and is still read when no `taskFor` is given. `tasksFor(assistantId)`
 * answers that assistant's queue rows as plain objects (`{id, state, files, title}`). `fileQueue(payload)` writes one
 * row and answers `{taskId}` or null. `probeMerge(pair)` asks git which direction (if either) is clean, as
 * `lib/collision-merge.js` `probePairMerge` answers it; with no probe wired the sweep behaves exactly as it did before
 * automatic settling existed, because a panel that cannot ask git must not pretend it did.
 *
 * TWO MORE FACTS, for a worker's own note: `probeShared(pair)` measures the files both branches changed against their
 * merge base (`probeSharedFiles`), and `probeLanded(side, {main})` says whether that side's tip is already in main and
 * which commit landed it (`probeLanded`). `mainFor(project)` names the project's main branch. All three are optional:
 * a sweep without them files notes exactly as before and simply does not claim the evidence or the landing.
 *
 * `treeExists(path)` is the fourth probe, and it answers the absence question: a record waiting on the reader whose
 * EVERY side is gone from disk leaves the count with no ruling. Optional for the same reason the others are - a sweep
 * that did not look must not claim an absence - and only records already in the reader state are asked about.
 *
 * THE FIFTH PROBE IS THE VERSION LINE. `probeVersionOnly(pair)` reads both sides' copies of the paths a pair shares and
 * answers `classifyVersionOnly`'s verdict (`lib/collision-merge.js`). A pair whose only shared paths are manifest version
 * fields, differing in nothing but the number, is a LAND ORDER: kept, named, answered by the standing landing rule, and
 * never handed to the reader. `treeRegistered(path)` is the sixth: `true`/`false` from `git worktree list`, or null
 * when the question was not asked. A pair with a side git no longer registers is ABSENT - a leftover directory cannot
 * be a second side - and the sweep marks it so instead of leaving it in the reader count.
 */
// ASYNC because the landing probe inside it is: `probeLanded` asks git up to seven times per pair and used to do it
// with `execFileSync`, holding the panel's only thread for 1.5-2.5s on every ten-second sweep (measured 2026-11-25).
// The sweep's own work is unchanged - it awaits the same answers, in the same order.
export async function sweepCollisions({
  rows = [],
  book,
  now = Date.now(),
  ownerOf = () => null,
  nameOf = (id) => id,
  taskFor = null,
  taskIdFor = null,
  tasksFor = () => [],
  fileQueue = null,
  probeMerge = null,
  probeShared = null,
  probeLanded = null,
  probeVersionOnly = null,
  mainFor = () => null,
  treeExists = null,
  treeRegistered = null,
  project = null,
} = {}) {
  if (!book) throw new Error("sweepCollisions needs the collision book");
  // THE TASK EACH SIDE IS ABOUT. The pair record names the queue row standing in each tree - its id, its own title,
  // its state and whose queue holds it - so a reader can tell two agents on the SAME work from two agents merely both
  // landing into main. The resolver is the composition root's (server.js reads every assistant's queue and matches on
  // the row's own `worktree` field), and a row with no owning task is a side with no task row - never a guess.
  const withTasks = (list) =>
    taskFor || taskIdFor
      ? [...list].map((row) => {
          const resolved = taskFor ? taskFor(row) : null;
          const task = resolved && typeof resolved === "object" ? resolved : null;
          const raw = Number(task ? task.id : taskIdFor ? taskIdFor(row) : null);
          const taskId = Number.isInteger(raw) && raw > 0 ? raw : null;
          const next = { ...row };
          if (task) next.task = task;
          if (taskId) next.taskId = taskId;
          return next;
        })
      : [...list];
  const pairs = detectCollisions(withTasks(rows));
  // ---- 0a. THE VERSION LINE, read before git is asked anything ---------------------------------------------------
  // A pair whose only shared paths are manifest version fields, differing in nothing but the number, is not a file
  // fight: every landing here claims the next patch above main, so three live trees holding 1.155.5, 1.155.6 and
  // 1.156.0 are three pairs that all "share" package.json and disagree about nothing a person could arbitrate. The land
  // step settles them already (rebase onto the current origin/main and keep the higher version), so the pair becomes a
  // LAND ORDER - named, kept, counted as answered - and asks nobody. Only a pair EVERY shared path of which is a
  // version carrier is worth reading: one that also shares a source file, a test or a doc is an ordinary collision by
  // inspection, and reaches the reader exactly as it did before this classification existed.
  const versionChecks = new Map();
  if (typeof probeVersionOnly === "function") {
    let asked = 0;
    for (const pair of pairs) {
      if (asked >= COLLISION_VERSION_CAP) break;
      const known = book.get(pair.key);
      if (known?.superseded) continue;
      // A ruling that is not this reading (the reader's own, or git's merge order) outranks it: an answer already given
      // is not re-opened by a measurement.
      if (known?.ruling && known.ruling.basis !== "version") continue;
      if (known?.autoWithheld) continue;
      const files = pair.files || [];
      if (!files.length || !files.every(isVersionCarrier)) {
        // A pair that WAS a land order and now shares something that is not a manifest version field is not one any
        // more. The reading is stated here so the pair loop below withdraws the order and the ordinary path takes over.
        if (known?.ruling?.basis === "version" && files.length) {
          versionChecks.set(pair.key, {
            ok: true,
            at: new Date(now).toISOString(),
            versionOnly: false,
            files,
            versions: null,
            pick: null,
            why: `${files.find((file) => !isVersionCarrier(file))} is not a manifest version field`,
          });
        }
        continue;
      }
      // THE READING IS TAKEN EVERY SWEEP, and it is cheap by construction: a few small file reads and no git process,
      // unlike the merge probe (which is cached because it costs two `merge-tree` runs). A bump is committed by the land
      // step but a worker can also be holding one dirty, and a dependency line can appear under a tip that has not
      // moved - so the answer is re-read rather than inferred from the tips. The book is only rewritten when the
      // reading CHANGES (`CollisionBook.rememberVersionCheck`), so an unchanged board stays an unchanged file.
      asked += 1;
      let got = null;
      try {
        got = probeVersionOnly(pair);
      } catch (err) {
        got = { ok: false, versionOnly: false, why: String((err && err.message) || err) };
      }
      versionChecks.set(pair.key, got || { ok: false, versionOnly: false, why: "the probe answered nothing" });
    }
  }
  // ---- 0. THE MERGE QUESTION, asked BEFORE anything is filed. git decides whether this pair is the reader's at all:
  // one clean direction, or two, is an order the panel can take; only two conflicting directions are a card. A record
  // that already carries a ruling, has been handed to the reader, whose automatic pick the reader withdrew, or that is
  // already quiet (a stand-down, a finished side) is never probed - that is what makes a re-detected pair ask nothing
  // the second time. A probe that cannot answer is stored as it answered, so the card can say git could not decide.
  const merges = new Map();
  if (typeof probeMerge === "function") {
    let asked = 0;
    for (const pair of pairs) {
      if (asked >= COLLISION_PROBE_CAP) break;
      const known = book.get(pair.key);
      if (known && (known.ruling || known.readerAt || known.autoWithheld || known.superseded)) continue;
      if (known && (known.stoodDown.a || known.stoodDown.b || finishedSides(known).length)) continue;
      // A pair the version reading already answered is not a merge question: git would only report the version line it
      // always reports, and the order is the land step's, not git's.
      if (versionChecks.get(pair.key)?.versionOnly === true) continue;
      // The last answer is reused while the two tips it was read at are the tips the pair still stands on.
      if (known && sameTips(known.merge, pair)) continue;
      asked += 1;
      try {
        merges.set(pair.key, probeMerge(pair));
      } catch (err) {
        merges.set(pair.key, { ok: false, at: new Date(now).toISOString(), error: String((err && err.message) || err) });
      }
    }
  }
  const seen = new Set(pairs.map((p) => p.key));
  // One row per tree path, built once: the absence question and the two measured facts both ask it, and a tree with no
  // row at all is exactly what "gone" looks like from here.
  const rowByPath = new Map();
  for (const row of rows || []) {
    if (!row?.path) continue;
    const key = normCollisionPath(row.path);
    if (key && !rowByPath.has(key)) rowByPath.set(key, row);
  }
  const report = {
    at: new Date(now).toISOString(),
    pairs: pairs.length,
    filed: [],
    settled: [],
    escalated: [],
    stoodDown: [],
    finished: [],
    measured: [],
    superseded: [],
    gone: [],
    // The version line: pairs named as LAND ORDERS this sweep, and orders withdrawn because the overlap stopped being
    // a version line alone. Both are read by the route and by the tests; neither is a second source of truth.
    landOrder: [],
    landOrderWithdrawn: [],
  };
  // Every pair the detector still sees gets its record, its automatic ruling when git can make one, its filing, its
  // stand-down check and its escalation test - in that order, because the reading of a queue row is what the last two
  // ask about.
  for (const pair of pairs) {
    // A PAIR A LANDING HAS ALREADY CONSUMED IS HISTORY. It is still detected (both trees are live and touch the same
    // path until one is released), but it is not a notice, not a pass and not a question: the record keeps the commit
    // that ended it and the row draws it as history. Re-filing it would put a settled pair back in both queues.
    const knownPair = book.get(pair.key);
    if (knownPair?.superseded) {
      seen.add(pair.key);
      continue;
    }
    const { record, passTicked } = book.upsertDetected({ ...pair, merge: merges.get(pair.key) || null }, now);
    seen.add(record.key);
    // ---- 0a. THE LAND ORDER, on top of the settling git does. A version-only overlap is named and kept - one record,
    // both trees, the manifest they share - and answered by the standing landing rule rather than by a person. A pair
    // that WAS a land order and no longer is (a source file joined the overlap, a dependency line appeared) has the
    // order withdrawn here, and everything below runs exactly as it would have without the classification.
    const versionCheck = versionChecks.get(pair.key);
    if (versionCheck) {
      book.rememberVersionCheck(record.key, { ...versionCheck, tips: { a: headOf(record.a), b: headOf(record.b) } }, now);
      if (versionCheck.ok === true && versionCheck.versionOnly === true) {
        if (record.ruling?.basis !== "version") {
          const ordered = book.markLandOrder(record.key, {
            pick: versionCheck.pick,
            files: versionCheck.files,
            versions: versionCheck.versions,
            why: landOrderWhy(record, versionCheck),
            at: now,
          });
          if (ordered) {
            const first = ordered[versionCheck.pick === "b" ? "b" : "a"];
            report.landOrder.push({
              pairKey: record.key,
              pick: versionCheck.pick,
              name: first?.name || null,
              versions: versionCheck.versions || null,
              files: versionCheck.files || [],
            });
            continue;
          }
        } else {
          // Already answered as a land order: the record keeps the order and this sweep has nothing to add to it.
          continue;
        }
      } else if (record.ruling?.basis === "version") {
        book.withdrawLandOrder(record.key, { at: now, reason: versionCheck.why });
        report.landOrderWithdrawn.push({ pairKey: record.key, why: versionCheck.why || null });
      }
    }
    // ---- 0b. SETTLE IT. git's two answers become an order through the SAME pair-scoped store a reader's ruling
    // uses, tagged automatic; a settled pair files no notice and asks nobody, because the Ruled row the composition
    // root broadcasts is what makes the order take effect.
    if (!record.ruling && !record.readerAt && !record.autoWithheld && !record.stoodDown.a && !record.stoodDown.b && !finishedSides(record).length) {
      const settled = settleCollision(record);
      if (settled.pick) {
        const ruled = book.rule(record.key, { pick: settled.pick, by: "auto", auto: true, reason: settled.reason, basis: settled.basis, rule: settled.rule, why: settled.why, at: now });
        if (ruled.ok) {
          const first = settled.pick === "a" ? record.a : record.b;
          report.settled.push({ pairKey: record.key, pick: settled.pick, name: first?.name || null, why: settled.why, basis: settled.basis, rule: settled.rule, reason: settled.reason });
          continue;
        }
      }
    }
    // ---- 1. file it, once per owner, if the book has not already done so. A pair that is already RULED files no
    // notice: the ruling row is what makes the order take effect, and a notice saying "the reader rules when nobody
    // stands down" beside a settled pair would be a second, contradictory row.
    const wanted = record.ruling ? [] : queueRowsFor(record, { ownerOf, nameOf, project });
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
        book.standDown(record.key, side, { taskId: entry.taskId, state: task.state }, now);
        report.stoodDown.push({ pairKey: record.key, side, taskId: entry.taskId, state: task.state });
      }
    }
    if (record.ruling || record.readerAt) continue;
    // A SIDE WHOSE OWN TASK IS FINISHED has stood down in substance: the work the collision was about has been laid
    // down, so the pair is not a question for the reader even when nobody closed a filed notice. Derived from the side
    // tasks on every sweep and never written, so work that starts again in that tree comes back as a live pair.
    const finished = finishedSides(record);
    if (finished.length) {
      report.finished.push({ pairKey: record.key, sides: finished.map((f) => f.side), tasks: finished.map((f) => f.taskId), states: finished.map((f) => f.state) });
      continue;
    }
    // ---- 3. the reader's turn: both sides claiming, or a full pass with nobody standing down
    const filedIds = new Set(Object.values(record.filed).map((f) => Number(f.taskId)));
    const claimsOf = (side) => {
      const who = ownerOf(record[side]);
      if (!who) return false;
      return tasksOf(who).some((t) => openTask(t) && !filedIds.has(Number(t.id)) && shares(normFiles(t.files), wantedFiles));
    };
    const bothClaim = Boolean(wantedFiles.size) && claimsOf("a") && claimsOf("b");
    const stoodDown = Boolean(record.stoodDown.a || record.stoodDown.b);
    // ONLY A PAIR GIT CANNOT ORDER REACHES THE READER. A pair with a clean direction was settled above, so what is
    // left here is both-directions-conflicting (`mayAskReader`), a probe that could not answer, or a pick the reader
    // withdrew - and a card for any of those is the reader asking to be shown the one he is about to decide.
    const mayAsk = mayAskReader(record);
    let why = null;
    if (mayAsk && bothClaim) why = "both-claim";
    else if (mayAsk && passTicked && record.passes > 1 && !stoodDown) why = "no-stand-down";
    if (why) {
      book.escalate(record.key, { why, at: now });
      report.escalated.push({ pairKey: record.key, why });
    }
  }
  // A reported note has no detection of its own: it is still a collision record, and it still needs its filing and its
  // pass (a note with no counterpart was already handed over by the book).
  for (const record of book.all()) {
    if (record.source !== "reported" || seen.has(record.key)) continue;
    if (record.superseded) continue;
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
  // ---- 3b. A RECORD WHOSE EVERY SIDE IS GONE IS OVER ------------------------------------------------------------
  // THE BADGE MUST NOT OUTLIVE THE WORK. A record can sit in the reader state after both of its trees have been
  // removed: nothing detects the pair any more, so nothing re-files it, and `closeUndetected` keeps it precisely
  // because it is waiting on the reader - which is the reading it will never get, because there is no second side left
  // to order. The same goes for a worker's reported note whose own tree was removed. No ruling is needed to stop a
  // badge for work that is over: every side is absent, so the record becomes a verdict and leaves the count by itself.
  //
  // Asked only through a probe, like the merge and landing questions: a sweep that cannot read the disk must not claim
  // an absence, and the unit fixtures use paths that are not on it. `rows` answers it too - a row the scan marked
  // RELEASED is a path that is not this project's tree any more, whatever is left in the folder.
  //
  // A SECOND KIND OF ABSENT, WHICH THE DISK CANNOT SEE: A LEFTOVER DIRECTORY. A tree git no longer registers cannot
  // stand down, land or answer a ruling - its branch can be deleted and its folder can be held by a dead run's child, so
  // `git worktree remove` refuses with "Permission denied" and the directory survives with nothing behind it. The
  // folder IS on disk, so `treeExists` says it is there, and the old rule (EVERY side gone) could never fire while such
  // a leftover stood on one side of a pair. The registration is therefore asked separately (`git worktree list`,
  // `lib/collision-merge.js` `registeredWorktrees`), and ONE such side is enough: there is no second worker, and no
  // order a person gave would be acted on. Nothing is deleted here; the folder is left exactly as it is, and only the
  // record is marked.
  if (typeof treeExists === "function" || typeof treeRegistered === "function") {
    const gone = (side) => {
      const row = side?.path ? rowByPath.get(normCollisionPath(side.path)) : null;
      if (row && row.released) return true;
      if (typeof treeExists !== "function") return false;
      try {
        return !treeExists(side.path);
      } catch {
        // A probe that failed proves nothing: leave the badge where it is rather than dropping a live question.
        return false;
      }
    };
    const unregistered = (side) => {
      if (typeof treeRegistered !== "function" || !side?.path) return false;
      try {
        // Only an explicit `false` counts: `null` is "the question was not asked", and a failed read is not an absence.
        return treeRegistered(side.path) === false;
      } catch {
        return false;
      }
    };
    for (const rec of book.all()) {
      if (rec.superseded || rec.ruling || rec.absent || !rec.readerAt) continue;
      const sides = ["a", "b"].map((side) => rec[side]).filter((side) => side && side.path);
      if (!sides.length) continue;
      const dropped = sides.filter(unregistered);
      if (dropped.length) {
        const named = dropped.map((side) => side.name || side.path).join(" and ");
        book.markAbsent(rec.key, {
          at: now,
          how: "tree-unregistered",
          target: named,
          why: `${named} ${dropped.length === 1 ? "is" : "are"} not a registered worktree of this project any more - a leftover directory is not a second worker, so there is no order for a person to give`,
        });
        report.gone.push({ pairKey: rec.key, how: "tree-unregistered", sides: dropped.map((side) => side.path) });
        continue;
      }
      if (!sides.every(gone)) continue;
      book.markAbsent(rec.key, {
        at: now,
        how: "trees-gone",
        target: sides.map((side) => side.name || side.path).join(" and "),
        why: "every tree this record names is gone, so there is nothing left for a person to rule on",
      });
      report.gone.push({ pairKey: rec.key, how: "trees-gone", sides: sides.map((side) => side.path) });
    }
  }
  // ---- 4. THE FACTS A REPORT OWES ITS READER, measured rather than asserted --------------------------------------
  // A worker's sentence ("we both touch lib/x.js") is a claim. The card is only worth the space when it prints what
  // git says: the paths both branches changed against their merge base, and whether one side's tip has already been
  // carried into main by a landing later than the report. Both answers are cached on the record with the tips they were
  // read at; a ten-second sweep must not spawn git for a question whose answer cannot change in ten seconds.
  // The row's OWN tip is fresher than the record's, which was stamped when the side was first seen: a branch that has
  // moved since is the branch the card is about.
  const tipOf = (side = {}) => {
    const row = side?.path ? rowByPath.get(normCollisionPath(side.path)) : null;
    return {
      row,
      tip: String(row?.head || side?.head || "").trim().toLowerCase() || null,
      branch: row?.branch || side?.branch || null,
    };
  };
  if (typeof probeShared === "function") {
    let asked = 0;
    for (const rec of book.all()) {
      if (asked >= COLLISION_FACT_CAP) break;
      if (rec.superseded || rec.evidence || !rec.b?.path) continue;
      const a = tipOf(rec.a);
      const b = tipOf(rec.b);
      if (!a.tip || !b.tip) {
        book.rememberEvidence(rec.key, { ok: false, error: "a side's branch tip is not known, so the files cannot be measured" }, now);
        continue;
      }
      asked += 1;
      let got = null;
      try {
        got = probeShared({ key: rec.key, project: rec.project, a: { ...rec.a, head: a.tip, branch: a.branch }, b: { ...rec.b, head: b.tip, branch: b.branch } });
      } catch (err) {
        got = { ok: false, error: String(err?.message || err) };
      }
      book.rememberEvidence(rec.key, got || { ok: false, error: "the probe answered nothing" }, now);
      report.measured.push({ pairKey: rec.key, ok: got?.ok === true, files: Array.isArray(got?.files) ? got.files.length : 0, error: got?.error || null });
    }
  }
  if (typeof probeLanded === "function") {
    let asked = 0;
    for (const rec of book.all()) {
      if (asked >= COLLISION_FACT_CAP) break;
      if (rec.superseded) continue;
      const sides = ["a", "b"].filter((side) => rec[side]?.path && tipOf(rec[side]).tip);
      if (!sides.length) continue;
      // The branch this tree's work would LAND on: the base the row itself was measured against (a project whose
      // environments are long-lived branches has no single main), then the project's own main, then `main`.
      const main = String(
        tipOf(rec.a).row?.baseBranch || tipOf(rec.b).row?.baseBranch || mainFor(rec.project) || "main",
      );
      const tips = Object.fromEntries(sides.map((side) => [side, tipOf(rec[side]).tip]));
      const cached = rec.land;
      const fresh =
        cached &&
        cached.main === main &&
        JSON.stringify(cached.tips || null) === JSON.stringify(tips) &&
        now - Date.parse(cached.at || 0) < COLLISION_LAND_RECHECK_MS;
      if (fresh && !cached.landed) continue;
      let landed = null;
      let landedSide = null;
      for (const side of sides) {
        if (asked >= COLLISION_FACT_CAP) break;
        const sideTips = tipOf(rec[side]);
        asked += 1;
        let got = null;
        try {
          got = await probeLanded({ path: rec[side].path, head: sideTips.tip, branch: sideTips.branch }, { main });
        } catch (err) {
          got = { ok: false, landed: false, error: String(err?.message || err) };
        }
        if (got?.landed && got.commit) {
          landed = got;
          landedSide = side;
          break;
        }
        if (!landed) landed = got || landed;
      }
      const reportAt = reportAtOf(rec);
      const landedMs = landed?.landedAt ? Date.parse(landed.landedAt) : NaN;
      const reportMs = reportAt ? Date.parse(reportAt) : NaN;
      if (landed?.landed && landedSide && Number.isFinite(landedMs) && Number.isFinite(reportMs) && landedMs > reportMs) {
        book.supersede(rec.key, {
          side: landedSide,
          commit: landed.commit,
          landedAt: landed.landedAt,
          main: landed.main || main,
          tip: landed.tip || null,
          reportAt,
          at: now,
        });
        report.superseded.push({ pairKey: rec.key, side: landedSide, commit: landed.commit, landedAt: landed.landedAt, reportAt });
        continue;
      }
      book.rememberLand(rec.key, {
        at: new Date(now).toISOString(),
        tips,
        main,
        landed: Boolean(landed?.landed),
        commit: landed?.commit || null,
        landedAt: landed?.landedAt || null,
        error: landed?.error || null,
      });
    }
  }

  book.closeUndetected(seen, now);
  return report;
}

/** The pair key for two trees, re-exported so a caller does not have to import two modules to ask one question. */
export { pairKey };
