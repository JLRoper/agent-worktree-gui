// COLLISION BOOK: the store of detected and reported collisions - one JSON document beside the other per-row stores,
// the class that folds, orders and upgrades its records, and the counts the chip and a test read.
//
// Split out of `lib/collisions.js`, which stays the entry point its callers import and re-exports every name below.
// The detection half is `lib/collision-detect.js`: what a pair is recorded as, why it settled the way it did, and the
// detection itself. This half is the book - `CollisionBook`, its load-and-normalise pass, the ruling, absence and
// land-order answers it stores, and `countStates`. It writes the disk only for its own file; a record a sweep hands it
// has already been decided, and the views it returns are the ones every surface reads.
//
// `lib/collision-flow.js` owns the sweep that files queue rows and escalates, `lib/collision-merge.js` owns the git
// probe, and server.js owns the store instance and the snapshot overlay - each reads the store's one answer rather
// than re-deriving it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// THE DETECTION HALF is `lib/collision-detect.js`. These are the names the book reads a record with: the vocabulary it
// stores, the reason it prints, and the readers it folds and orders a pair by.
import {
  COLLISION_FILES_CAP,
  COLLISION_KEEP,
  COLLISION_NOTE_CAP,
  COLLISION_PASS_MS,
  COLLISION_RELATION_CAP,
  COLLISION_RESOLVED_KEEP_MS,
  COLLISION_RULES,
  COLLISION_TARGET_CAP,
  COLLISION_VERSION,
  finishedSides,
  normCollisionPath,
  owningTaskFor,
  pairKey,
  reasonOf,
  relationOfRecord,
  reorderSides,
  reportAtOf,
  resolveCounterpart,
  ruleLabelOf,
  ruleOfRuling,
  sideOf,
  stateOf,
  stoodDownOf,
  targetNamesLiveAgent,
  treeIdentityOf,
  waitingOf,
} from "./collision-detect.js";
// The one detection shape the book also writes with - a clipped string. It was never exported from this module's
// surface, so it is imported here and not re-exported.
import { clip } from "./collision-detect.js";

// THE READER'S HALF OF A RECORD is pure and lives with the page (public/core/collision-history.js), imported here the
// way lib/jobs.js imports public/core/steerable.js: the store hands it a record view and it answers the one question
// every surface has to agree on - which records are WAITING on a person, in what order, and does this one answer a
// search. A second copy in lib/ is a second answer that drifts on the first change.
import "../public/core/collision-history.js";

const historyCore = () => globalThis.wtCollisionHistory;

// TWO RECORD-SHAPE READERS the store writes with and the detection never reads: an ISO stamp, and a record's two
// normalised paths. Both were declared on the detection side of the file before the cut and moved here with the store,
// which is their only caller; exporting them from the detection instead would have put two names on that file's
// surface for a reader that is not a detector.

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
const nowIso = (now = Date.now()) => new Date(now).toISOString();

// `oldAbsence` is the store's own read-upgrade of a record, not a detection rule: `CollisionBook.load` is its only
// caller, so it stays with the store rather than moving with the detection and widening that file's exports for a
// reader that is not a detector. The module-separation card's 78-1,251 range crossed it; the measured boundary on this
// base stops before it, at `stoodDownOf`, the last of the detection's own exports.
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
          // THE REASON, kept through a restart exactly as it was written: the rule id, who ruled, when, the relation
          // and the outcome. A build that predates it reads as null here and `reasonOf` derives the same answer from
          // the ruling's own `auto`/`basis`, so an older file is not rewritten to say what it always meant.
          settlement: rec.settlement && typeof rec.settlement === "object" ? rec.settlement : null,
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
        settlement: null,
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
        settlement: null,
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
  rule(key, { pick = "", note = "", by = "reader", at = this.now(), auto = false, reason = "", basis = null, rule = null, why = null } = {}) {
    const rec = this.records.get(String(key));
    if (!rec) return { ok: false, error: `no collision is recorded for ${String(key || "(none)")}` };
    const choice = String(pick || "").trim().toLowerCase();
    if (choice === "clear") {
      const was = rec.ruling;
      rec.ruling = null;
      // A withdrawn settlement is no settlement: the record's reason field goes back to "what the panel would do".
      rec.settlement = null;
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
    // THE RULE THAT SETTLED IT, as an id rather than a sentence. An automatic pick names its own rule (git's one clean
    // direction, or the tie-break that broke a tie); a person's ruling is `reader`, and its `note` is the why a later
    // reader can check. This is the field the record used to lack entirely.
    const ruleId = auto
      ? rule && COLLISION_RULES[String(rule)]
        ? String(rule)
        : basis
          ? ruleOfRuling({ auto: true, basis })
          : "merge-unknown"
      : "reader";
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
      // WHICH RULE SETTLED IT, and git's own word for the situation, kept beside the sentence so no surface has to
      // parse prose to know what happened.
      rule: ruleId,
      why: why ? String(why) : null,
      reason: clip(reason, COLLISION_NOTE_CAP) || null,
      basis: basis ? String(basis) : null,
      note: clip(note, COLLISION_NOTE_CAP),
    };
    // The SETTLEMENT: the same answer in the shape the history and the popup read - rule, pair, relation, who, when,
    // outcome. Written once, at the moment of the ruling, and never re-derived: a later rename moves the sides, not
    // the answer that was given.
    rec.settlement = {
      at: rec.ruling.at,
      rule: ruleId,
      label: ruleLabelOf(ruleId),
      by: rec.ruling.by,
      auto: Boolean(auto),
      pick: choice,
      pickPath: side.path,
      pickName: side.name,
      taskId: rec.ruling.taskId,
      outcome: "ruled",
      why: rec.ruling.why,
      reason: rec.ruling.reason,
      note: rec.ruling.note,
      relation: relationOfRecord(rec),
      files: (Array.isArray(rec.files) ? rec.files : []).slice(0, COLLISION_FILES_CAP),
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
      rule: "version-line",
      why: "version-only",
      basis: "version",
      reason: clip(why, COLLISION_NOTE_CAP) || null,
      note: "",
    };
    rec.settlement = {
      at: stamp,
      rule: "version-line",
      label: ruleLabelOf("version-line"),
      by: "auto",
      auto: true,
      pick,
      pickPath: side.path,
      pickName: side.name,
      taskId: side.taskId ?? null,
      outcome: "ruled",
      why: "version-only",
      reason: rec.ruling.reason,
      note: "",
      relation: relationOfRecord(rec),
      files: (Array.isArray(files) ? files : []).map(normCollisionPath).filter(Boolean).slice(0, COLLISION_FILES_CAP),
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
    rec.settlement = null;
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

  /**
   * THE DURABLE HISTORY: every collision this panel has recorded, in the reader's order, filtered by row, branch or
   * file. The book is already the store - one JSON document beside the other per-row stores - so "survives a restart"
   * is the file this method loads, and "every collision" is every record the book kept, auto-ruled ones included.
   *
   * Each entry is the record as a READER sees it: both sides, the evidence, and the `reason` object (which rule
   * settled it or would settle it, who ruled, when, the relation and the outcome). The popup draws these directly, so
   * there is one place a reason is worded and one place the order is decided.
   *
   * `q` filters by the three things a reader names: a row (its path, its directory name, its task number), a branch,
   * or a file. Every token typed must appear in the record's own text (`public/core/collision-history.js` `matches`).
   * `limit` is a RENDER cap and never a filter: `total` always counts the records the book holds.
   */
  history({ q = "", limit = null } = {}) {
    this.load();
    const records = [];
    for (const rec of this.records.values()) {
      const stood = finishedSides(rec);
      records.push({
        key: rec.key,
        project: rec.project,
        source: rec.source,
        // The store's own state and the reader's own predicate: the badge counts `waiting`, the row draws `state`.
        state: stateOf(rec),
        waiting: waitingOf(rec),
        a: rec.a ? { ...rec.a } : null,
        b: rec.b ? { ...rec.b } : null,
        bTarget: rec.bTarget || null,
        files: [...(rec.files || [])],
        relations: Array.isArray(rec.relations) ? rec.relations.map((rel) => ({ ...rel })) : [],
        // THE REASON, first-class: the rule, who, when, the relation that caused the pair and the outcome.
        reason: reasonOf(rec),
        settlement: rec.settlement ? { ...rec.settlement } : null,
        ruling: rec.ruling ? { ...rec.ruling } : null,
        firstAt: rec.firstAt || null,
        lastAt: rec.lastAt || null,
        reportedAt: reportAtOf(rec),
        passes: rec.passes || 0,
        // The reader's own hand-over for a note with no counterpart: the popup says why it is waiting instead of
        // pretending a rule declined an order between one tree and nothing.
        readerAt: rec.readerAt || null,
        readerWhy: rec.readerWhy || null,
        stoodByTask: stood,
        superseded: rec.superseded ? { ...rec.superseded } : null,
        absent: rec.absent ? { ...rec.absent } : null,
        landOrder: rec.landOrder ? { ...rec.landOrder } : null,
        merge: rec.merge ? { ...rec.merge } : null,
        autoWithheld: rec.autoWithheld ? { ...rec.autoWithheld } : null,
        // The queue rows the panel filed, so the popup can name the notice the assistants hold instead of leaving two
        // surfaces looking at the same pair without saying so.
        filed: Object.entries(rec.filed || {}).map(([assistantId, entry]) => ({ assistantId, ...entry })),
        canRule: waitingOf(rec) && Boolean(rec.a?.path && rec.b?.path) && (rec.files || []).length > 0,
      });
    }
    const core = historyCore();
    const all = core ? core.order(records) : records;
    const filtered = core ? all.filter((rec) => core.matches(rec, q)) : all;
    const waiting = core ? core.countWaiting(all) : all.filter((rec) => rec.waiting).length;
    const n = Number(limit);
    const rows = Number.isFinite(n) && n > 0 ? filtered.slice(0, Math.floor(n)) : filtered;
    return {
      records: rows,
      total: filtered.length,
      waiting,
      held: all.length,
      shown: rows.length,
      more: filtered.length > rows.length,
      foot: core ? core.footText(rows.length, filtered.length) : `${rows.length} of ${filtered.length}`,
      q: String(q || ""),
      cap: COLLISION_KEEP,
    };
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
    return { count: records.filter((r) => r.state === "reader").length, waiting: records.filter((r) => r.state === "reader" && !finishedSides(r).length).length, total: records.length, byState: countStates(records), records };
  }
}

export function countStates(records = []) {
  const out = { assistants: 0, reader: 0, ruled: 0, superseded: 0, absent: 0 };
  for (const rec of records || []) out[stateOf(rec)] += 1;
  return out;
}
