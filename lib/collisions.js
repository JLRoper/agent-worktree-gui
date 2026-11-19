// COLLISIONS: two live runs in one project stepping on the same work, detected two-sided and carried as evidence.
//
// WHY THIS EXISTS. The board already knows, per row, what each tree is touching: its dirty files, its untracked
// files, and (on a live row) the files its own commits change since the branch it was cut from. What it never did was
// put two rows side by side. Two workers in one project can therefore write the same file, or one can be landing into
// the branch the other is still working on top of, and the first sign of it is a merge conflict or a lost edit - long
// after the reader could have ruled on it. This module answers ONE question, for every pair of live rows in a
// project: are these two touching the same work, and what is the evidence?
//
// THE EVIDENCE IS THE ANSWER, never a bare flag. Every collision carries the shared paths and/or the branch relation
// that produced it (`relations`), because "two workers are colliding" with no paths is a claim a reader cannot check
// and an assistant cannot act on. The three relations are the three ways this board can see a collision:
//
//   shared-file       both trees are touching a path the other is touching (dirty, untracked, or in a commit of its
//                     own since its parent). This is the ordinary two-workers-one-file case.
//   merge-target      one tree's BRANCH is the branch the other tree merges into (the other row's `parent`). Work
//                     landing into a branch while somebody else commits on top of it is a collision even when the
//                     file sets are disjoint today: the next rebase or merge is the one that resolves it.
//   sibling-turnover  both trees were cut from the same TURNOVER branch, and their own commits change the same
//                     files. Two children of one turnover branch land into the same branch, so a file both of them
//                     changed is a conflict waiting in that branch rather than in either tree.
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

/** One side of a collision, as the record keeps it: enough to name the tree without a lookup. */
export function sideOf(row = {}) {
  const treePath = String(row.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    path: treePath,
    name: treePath.split("/").filter(Boolean).pop() || treePath,
    branch: row.branch ? String(row.branch) : null,
    parent: row.parent ? String(row.parent) : null,
  };
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
 * Returns `[{key, project, a, b, files, relations}]` - `a` and `b` are `sideOf` records, `files` the evidence paths
 * (capped), `relations` the reason(s) this pair is a collision. A pair with no relation is not returned at all.
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
      const shared = intersect(one.touch.all, two.touch.all);
      const committed = intersect(one.touch.commits, two.touch.commits);
      // Two children of one turnover branch whose OWN commits change the same file: the conflict this names waits in
      // the turnover branch they both land into rather than in either tree, so it is one relation and not also the
      // ordinary shared-file one - the same path counted twice would say the same thing twice.
      const siblings =
        one.side.parent && two.side.parent && eqName(one.side.parent, two.side.parent) && isTurnover(one.side.parent) && committed.length
          ? committed.slice(0, COLLISION_FILES_CAP)
          : [];
      const siblingSet = new Set(siblings);
      const working = shared.filter((p) => !siblingSet.has(p));
      const relations = [];
      // 1. the same file, touched by both. The ordinary case, and the one the marker's tooltip names first.
      if (working.length) {
        relations.push({ kind: "shared-file", files: working.slice(0, COLLISION_FILES_CAP) });
      }
      // 2. one tree's branch is the other's merge target. `two` merges into `one`'s branch, or the reverse: both
      //    directions are the same collision seen from the two rows, and each side is named as its own.
      if (eqName(one.side.branch, two.side.parent)) {
        relations.push({ kind: "merge-target", lander: "b", target: one.side.branch });
      } else if (eqName(two.side.branch, one.side.parent)) {
        relations.push({ kind: "merge-target", lander: "a", target: two.side.branch });
      }
      // 3. the turnover siblings, kept last so the sentence reads files first and the branch relation after.
      if (siblings.length) {
        relations.push({ kind: "sibling-turnover", parent: one.side.parent, files: siblings });
      }
      if (!relations.length) continue;
      const files = [...new Set([...working, ...siblings])];
      out.push({
        key: pairKey(one.side.path, two.side.path),
        project: one.project,
        a: one.side,
        b: two.side,
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
    else if (rel.kind === "merge-target") bits.push(`${otherName} ${rel.lander === "b" ? "lands into" : "is the branch"} ${rel.target}`);
    else if (rel.kind === "sibling-turnover") bits.push(`${rel.files.length} file${rel.files.length === 1 ? "" : "s"} both changed under ${rel.parent}`);
  }
  return bits.join("; ");
}

/** The state a record reads as: a ruling wins over an escalation, and an escalation over the assistants' pass. */
export function stateOf(rec = {}) {
  if (rec.ruling) return "ruled";
  if (rec.readerAt) return "reader";
  return "assistants";
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
          stoodDown: rec.stoodDown && typeof rec.stoodDown === "object" ? rec.stoodDown : {},
          readerAt: rec.readerAt || null,
          readerWhy: rec.readerWhy || null,
          ruling: rec.ruling && typeof rec.ruling === "object" ? rec.ruling : null,
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
      };
      this.records.set(rec.key, rec);
      return { record: rec, isNew: true, passTicked: true };
    }
    existing.a = pair.a;
    existing.b = pair.b;
    existing.project = pair.project || existing.project;
    existing.files = (pair.files || []).slice(0, COLLISION_FILES_CAP);
    existing.relations = (pair.relations || []).slice(0, COLLISION_RELATION_CAP);
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

  /** A side's queue row was closed (done or parked): it stood down, and the pair no longer escalates on the pass rule. */
  standDown(key, side, at = this.now()) {
    const rec = this.records.get(String(key));
    if (!rec || (side !== "a" && side !== "b")) return null;
    if (rec.stoodDown[side]) return rec;
    rec.stoodDown[side] = nowIso(at);
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
   */
  rule(key, { pick = "", note = "", by = "reader", at = this.now() } = {}) {
    const rec = this.records.get(String(key));
    if (!rec) return { ok: false, error: `no collision is recorded for ${String(key || "(none)")}` };
    const choice = String(pick || "").trim().toLowerCase();
    if (choice === "clear") {
      rec.ruling = null;
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
      by: String(by || "reader"),
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
      this.records.delete(rec.key);
      dropped.push(rec.key);
    }
    return { dropped, at: nowIso(at) };
  }

  /**
   * What one tree's row draws: every collision it is part of, most urgent first. `role` says which side of the record
   * this tree is, so the marker names the OTHER tree rather than the reader's own.
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
      out.push({
        key: rec.key,
        state: stateOf(rec),
        role: a ? "a" : "b",
        project: rec.project,
        source: rec.source,
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
        stoodDown: [...Object.keys(rec.stoodDown || {})],
        filed: Object.entries(rec.filed || {}).map(([assistantId, f]) => ({ assistantId, ...f })),
        ruling: rec.ruling ? { ...rec.ruling } : null,
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
