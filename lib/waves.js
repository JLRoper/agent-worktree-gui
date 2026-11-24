// WAVES OF WORK: an ordered, gated group of TASKS inside one initiative.
//
// A wave is the fourth container beside the initiative, the task row and the two pipelines, and it is deliberately
// the smallest one. The design is docs/reports/waves-of-work.html; this module is its section 3 and its section 4,
// and the five rules below are the ones that decide its shape:
//
//   1. A WAVE NEVER OWNS A TREE. A task does. Membership is membership of TASKS, and the link is the task's own
//      `waveId`. There is no `trees[]`, no wave branch and no wave worktree here: a second map of a fact a scan
//      already owns is stale after the first scan that moves a tree.
//   2. A WAVE NEVER STORES ITS OWN STATE. The record has no `state`, `done`, `doneAt`, `percent` or `blockedBy`;
//      its state is a FOLD over its members plus one live read of its gates, computed on every read. A stored
//      snapshot would be believed after the rows moved.
//   3. MEMBERSHIP IS EXPLICIT. A task is in a wave because it names the wave id - never because its path, branch or
//      lane looks like one. That is what lets one wave span projects, which an initiative already does.
//   4. GATES REUSE THE CLOSED EXIT-CHECK VOCABULARY. An entry or exit gate is `{check, ...params}` where `check` is
//      one of the 14 names lib/pipelines.js validates and the parameters are the ones EXIT_PARAM_SPEC already
//      describes. A check outside that list refuses the record at load; a check with no evaluator yet reads
//      `unknown` rather than passing.
//   5. A GATE OPENS ONLY ON A LIVE READ-BACK. `readWaveGate` answers met / unmet / cannot tell, and "cannot tell"
//      blocks: a gate never passes because a member said so or because a status word was written once. The evidence
//      behind a member's closure is lib/wave-evidence.js: the pull request read through the host's API, and the
//      landing judged by CONTENT on origin/main (this repo squashes, so a landed sha is not an ancestor). A task
//      row's own `pr.state` is drawn, never believed; an evidence read that throws is cannot tell.
//   6. A WAVE'S LANES ARE DERIVED, AND ITS CLOSE IS ONE JOIN. A wave may hold LANES: disjoint sets of its members that
//      run side by side, and its close joins them in ONE commit. Neither half is reinvented here. A lane cannot see
//      another lane's files because a lane runs in its own trees (lib/pipeline-fanout.js rule 2), and the close is one
//      commit because it is the aggregate's own merge (lib/pipeline-aggregate.js rule 2), called through
//      `joinWaveLanes`, with the aggregate's own message builder naming every lane. A pin is a commit AND a blob
//      (lib/stage-pin.js), which is what still identifies what landed after this repo's squash rewrites the sha.
//      What is added here is only what those three modules cannot know: WHICH members are in which lane, read from
//      the members' OWN records so a lane is never stored on the wave (a wave record has no `lanes` field, and one
//      written by hand is not read); that a lane set which shares a tree is refused rather than isolated; and that
//      the join's message names the lane set. Nothing here schedules, advances or switches anything: a lane set is
//      READ on every read, and a join happens only when a caller asks for one.
//   7. THE AUTO SWITCH OPENS THE NEXT WAVE ON A READ, AND NOWHERE ELSE. `auto` is authored per wave and defaults
//      false. When it is true and the wave's exit gate reads met from live evidence - the same read every gate makes -
//      the NEXT wave in position order is derived OPEN on that read. Nothing is written and nothing runs between
//      reads: `waveLane` is the one place that evaluates it, and it is what GET /api/waves and the board's
//      GET /api/initiatives both call. A read nobody makes opens nothing. An auto-opened wave inherits no switch, so
//      a chain cannot run away by inheritance. `waveAutoOpens` below is the whole rule, and its comment says where
//      the read happens.
//
// THE STORE IS A SIBLING OF initiatives.json, keyed by initiative id, so an initiative write never rewrites a wave
// and a wave write never rewrites the initiative document. Its writer keeps the initiative store's three rules: the
// document is re-read before every write (`load({ fresh: true })`), a file that exists and cannot be read is REFUSED
// with its sentence and its path (`readable: false`), never overwritten, so the reader can salvage it, and the write
// is one temp file renamed over the target, so a reader never sees half a list. A missing file is the ordinary first
// run - zero waves, not an error.
//
// A WRITER CHANGES THE RECORD AND NOTHING ELSE. The fields `pickWave` validates are the whole of what this module
// writes, plus the provenance (`at`, `by`, `history`); everything else the tab draws - the state, the lanes, the
// members, the current wave, the auto open - is folded on the read and has no field to disagree with it. A posted
// `state`, `done`, `lanes` or member list is REFUSED by name rather than ignored: a stored state is believed after
// the rows move, which is the defect rule 2 exists to prevent.
//
// ONE BAD WAVE IS ONE WAVE THE TAB DOES NOT DRAW, WITH ITS SENTENCE (`skipped`), never the whole file refused: waves
// are a list a reader edits one record at a time, unlike the bundle's whole-or-nothing import.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { EXIT_PARAM_SPEC, EXIT_CHECKS } from "./pipelines.js";
import { TASK_CAP, TASK_FILES_MAX, TASK_LANE_MAX, TASK_STATES, intersectingFiles } from "./assistant/queue.js";
// A lane set is a fan-out (one lane, one tree, joined once), so its vocabulary and its join come from the modules that
// already own them: the aggregate's one-commit merge, its message, its record, and the isolation model a lane runs
// under. Nothing in this file restates those rules.
import { aggregateBranches } from "./pipeline-aggregate.js";
import { aggregateMessage, aggregateRecord, ISOLATION_PER_STAGE } from "./pipeline-fanout.js";
// The read's phase clock (lib/read-profile.js), off unless a route opened one with `?profile=1`.
import { timeSync } from "./read-profile.js";

// The document version this module WRITES. A version 1 file still loads: a missing `at`/`by`/`history` is not an
// error, and the first write stamps the whole document version 2. The read contract never depended on the number.
export const WAVES_VERSION = 2;
// One line a reader reads, so it is required and clipped at the initiative title's cap.
export const WAVE_TITLE_MAX = 120;
// A template is a bundle pipeline id: a name, never a copy. Clipped like an identifier, not like prose.
export const WAVE_TEMPLATE_MAX = 120;
// The bound the design names: 50 waves per initiative is generous, and it stops one hand-edited file from making
// every read of the Initiatives tab walk a list nobody authored.
export const WAVES_MAX = 50;
// Members are queue rows, so the queue's own cap is the ceiling: a wave read must not become a second scan of every
// queue. The route flattens the assistants' queues and this bound is applied per wave.
export const WAVE_MEMBERS_MAX = TASK_CAP;
export const WAVE_ID_MAX = 120;
// Who made a wave, clipped like an actor id. A record with no `by` is treated as somebody else's by the `own` tier,
// which is the reason the field is written at all.
export const WAVE_ACTOR_MAX = 80;
// A wave is a smaller object than an initiative and its story is shorter: newest last on disk, oldest dropped.
export const WAVE_HISTORY_MAX = 20;
// The closed vocabulary of a wave's own history. `remove` is kept although the record is deleted with it, so a file
// written by a later slice that archives a removal still round-trips through this door.
export const WAVE_HISTORY_ACTIONS = Object.freeze(["create", "edit", "move", "remove"]);
// THE WHOLE SHAPE OF A STORED WAVE, closed. `pickWave` refuses a field outside this list by name: a `state`, a
// `lanes`, a member list or a tree list is a second copy of a fact the read owns, and a second copy is believed after
// the first one moves.
export const WAVE_FIELDS = Object.freeze(["id", "initiativeId", "position", "title", "entryGate", "exitGate", "template", "auto", "at", "by", "history"]);
// What a CHANGE may name, which is narrower than what a record holds: `at`, `by` and `history` are provenance the
// store stamps, so a caller naming them is refused like any other field a wave does not author.
export const WAVE_WRITE_FIELDS = Object.freeze(["initiativeId", "id", "title", "entryGate", "exitGate", "template", "auto", "position", "by"]);
// The checks the tab's own picker can offer: the closed vocabulary's parameter-free names. A gate WITH parameters
// (a branch, an argv) is still postable to the route and is validated by `pickWaveGate`; the picker draws only the
// ones a one-line form can name without inventing an argument, and an existing gate with parameters is kept as-is.
export const WAVE_GATE_CHOICES = Object.freeze(EXIT_CHECKS.filter((check) => Object.keys(EXIT_PARAM_SPEC[check] || {}).length === 0));

// How many artefact paths one evidence read will carry. `file-exists` is the only gate that names a path, and a wave
// names one or two; the cap exists because the read runs on every request and each member whose tree is gone costs a
// few git calls per path. A gate past the cap reads cannot tell rather than being skipped silently.
export const WAVE_ARTEFACT_PATHS_MAX = 8;

// The derived states. Never stored: `state` on a wave view is this fold's answer for that read, and the record on
// disk has no field to disagree with it. `abandoned` is a CLOSED wave too: a member a person abandoned for a named
// reason is a decision, not work that landed, and the lane says which member and which reason rather than counting
// it as done.
export const WAVE_STATES = ["empty", "unentered", "unknown", "ready", "running", "blocked", "done", "abandoned"];
// What the lane says. "cannot tell" is a first-class answer: one is a fact about the work, the other a fact about
// the reader, and the design keeps the two words apart on purpose.
export const WAVE_STATE_WORDS = Object.freeze({
  empty: "no members",
  unentered: "not entered",
  unknown: "cannot tell",
  ready: "ready",
  running: "running",
  blocked: "blocked",
  done: "done",
  abandoned: "abandoned",
});

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) : t;
};
const nowIso = (now = Date.now()) => new Date(now).toISOString();
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// ---- the gate vocabulary ------------------------------------------------------------------------------------------
// A gate is validated against the SAME closed list and parameter spec the pipeline definitions use. This function is
// the single door: the loader calls it, and a later write route would call the same one, so a hand-edited file and a
// posted record cannot be validated two different ways.
const PARAM_PROBLEMS = {
  positiveInteger: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "must be a positive whole number"),
  text: (v) => (typeof v === "string" && v.trim() ? null : "must be a non-empty string"),
  regex: (v) => {
    if (typeof v !== "string" || !v.trim()) return "must be a non-empty pattern";
    try {
      new RegExp(v);
      return null;
    } catch {
      return "must compile as a regular expression";
    }
  },
  textList: (v) =>
    Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x.trim()) ? null : "must be a non-empty list of names",
  argv: (v) => (Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? null : "must be one argv list of strings"),
};

/**
 * Normalise one gate, or refuse it with the sentence a reader can act on. `null` is a valid gate: "no gate" is a
 * state the design keeps (the first wave, or a wave a person opens or closes by hand), not a missing value.
 */
export function pickWaveGate(raw) {
  if (raw == null) return { gate: null };
  if (!isObject(raw)) return { error: "a gate is {check, ...params} or null" };
  const check = String(raw.check ?? "").trim();
  if (!EXIT_CHECKS.includes(check)) {
    return {
      error: `${JSON.stringify(check || null)} is not one of the panel's exit checks (${EXIT_CHECKS.join(", ")}) - a check outside the list is refused, never rendered empty`,
    };
  }
  const spec = EXIT_PARAM_SPEC[check] || {};
  const gate = { check };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "check") continue;
    const rule = spec[key];
    if (!rule) return { error: `${check} takes no parameter ${JSON.stringify(key)}` };
    const problem = PARAM_PROBLEMS[rule.type] ? PARAM_PROBLEMS[rule.type](value) : null;
    if (problem) return { error: `${check}'s ${JSON.stringify(key)} ${problem}` };
    gate[key] =
      rule.type === "positiveInteger"
        ? Number(value)
        : rule.type === "textList"
          ? value.map((x) => String(x).trim())
          : rule.type === "argv"
            ? value.map((x) => String(x))
            : String(value).trim();
  }
  for (const [key, rule] of Object.entries(spec)) {
    if (rule.required && gate[key] === undefined) return { error: `${check} needs ${JSON.stringify(key)}` };
  }
  return { gate };
}

// ---- the record ---------------------------------------------------------------------------------------------------
// The one shape a stored wave has. `key` is the map key it was found under; the field and the key must agree, and a
// record that disagrees is REFUSED rather than moved - the key is the lookup, the field is the record's identity if a
// reader opens it on its own, and quietly rewriting one is how a wave ends up under an initiative nobody chose.
//
// THIS IS THE WRITE DOOR TOO. The loader calls it, and the four routes call the same one (through the store's
// mutators), so a hand-edited file and a posted record cannot be validated two different ways. A field outside
// `WAVE_FIELDS` is refused BY NAME rather than ignored: `state` and `lanes` are the two the invariant calls out, and
// a posted `state` that was silently dropped would let a client believe it had set one.
//
// `at`/`by`/`history` are PROVENANCE, not state. They answer who authored this wave - the question the `own` tier
// reads for a delete - and they are written on create and on every edit. A version 1 record has none of them and is
// not an error: absent reads as null and an empty history.
const cleanActor = (raw) => clip(String(raw ?? "").replace(/\s+/g, " ").trim(), WAVE_ACTOR_MAX);

// One history event, or null. The action vocabulary is closed so the page can draw a sentence without guessing at an
// unknown verb; an entry that does not fit is dropped rather than rendered as "undefined did something", which is the
// initiative store's own rule at a smaller cap.
function pickWaveEvent(raw) {
  if (!isObject(raw)) return null;
  const action = String(raw.action ?? "").trim().toLowerCase();
  if (!WAVE_HISTORY_ACTIONS.includes(action)) return null;
  const at = typeof raw.at === "string" && raw.at.trim() ? raw.at.trim() : null;
  if (!at) return null;
  return {
    at,
    by: cleanActor(raw.by) || "reader",
    action,
    detail: clip(String(raw.detail ?? "").replace(/\s+/g, " ").trim(), WAVE_TITLE_MAX),
  };
}

export function pickWave(raw, key, { strict = false } = {}) {
  if (!isObject(raw)) return { error: "a wave is an object" };
  const id = String(raw.id ?? "").trim();
  if (!id) return { error: "a wave needs an id" };
  if (id.length > WAVE_ID_MAX) return { error: `the id is longer than ${WAVE_ID_MAX} characters` };
  // TWO DOORS, ONE FIELD LIST. A record being WRITTEN is refused by name when it carries a field the store does not
  // hold, because a caller who posted it would otherwise believe it was kept. A record being READ is tolerant: a file
  // written before this shape existed may carry a `state` or a `lanes`, and the loader drops it rather than refusing
  // the whole record - the read slice's own rule, pinned by test/waves-derive.test.js, was that a hand-written state is
  // never believed. A refusal on LOAD would turn one stale field into a store nobody can add to.
  if (strict) {
    for (const field of Object.keys(raw)) {
      if (WAVE_FIELDS.includes(field)) continue;
      return {
        error: `${id} carries ${JSON.stringify(field)}, and a wave record has no such field - a state, a lane, a member list and a tree list are folded from the members on every read, never stored`,
      };
    }
  }
  const initiativeId = String(raw.initiativeId ?? "").trim();
  if (!initiativeId) return { error: `${id} carries no initiativeId` };
  if (initiativeId !== key) {
    return { error: `${id} says it belongs to ${initiativeId} but sits under ${key} - the key and the field must agree` };
  }
  const position = Number(raw.position);
  if (!Number.isInteger(position) || position < 1) return { error: `${id}'s position must be a whole number from 1` };
  const title = clip(String(raw.title ?? "").replace(/\s+/g, " ").trim(), WAVE_TITLE_MAX);
  if (!title) return { error: `${id} needs a title - one line saying what this wave is` };
  const entry = pickWaveGate(raw.entryGate);
  if (entry.error) return { error: `${id}'s entryGate: ${entry.error}` };
  const exit = pickWaveGate(raw.exitGate);
  if (exit.error) return { error: `${id}'s exitGate: ${exit.error}` };
  let template = null;
  if (raw.template != null && String(raw.template).trim()) template = clip(String(raw.template).trim(), WAVE_TEMPLATE_MAX);
  const history = [];
  for (const ev of Array.isArray(raw.history) ? raw.history : []) {
    const picked = pickWaveEvent(ev);
    if (picked) history.push(picked);
  }
  return {
    wave: {
      id,
      initiativeId,
      position,
      title,
      entryGate: entry.gate,
      exitGate: exit.gate,
      // A NAME, not a copy. A template the bundle no longer holds stays here and reads unresolved on the lane; it is
      // never silently nulled, because the next bundle may bring the id back.
      template,
      // Defaults false, and only a real boolean is true: a hand-edited "yes" is not an unattended start.
      auto: raw.auto === true,
      // Provenance: who authored the record and when, newest last in `history`.
      at: typeof raw.at === "string" && raw.at.trim() ? raw.at.trim() : null,
      by: cleanActor(raw.by) || null,
      history: history.slice(-WAVE_HISTORY_MAX),
    },
  };
}

/**
 * The id a title derives on create: lowercased, hyphenated, clipped to `WAVE_ID_MAX`, and suffixed `-2`, `-3` when
 * the store already holds it. The loader's duplicate check is on ids across the whole document, so this looks at
 * every id the store holds, not only this initiative's; a create refused for an id nobody can see would be a refusal
 * a person cannot act on.
 */
export function waveIdFrom(title, taken = new Set()) {
  const clean = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  const base = clip(clean(title), WAVE_ID_MAX) || "wave";
  let id = base;
  let n = 2;
  while (typeof taken.has === "function" && taken.has(id)) {
    const suffix = `-${n}`;
    id = `${clip(base, Math.max(1, WAVE_ID_MAX - suffix.length)).replace(/-+$/, "")}${suffix}`;
    n += 1;
    if (n > 999) return `wave-${Date.now().toString(36)}`;
  }
  return id;
}

// ---- the store ----------------------------------------------------------------------------------------------------
export class Waves {
  constructor({ file = null, log = () => {}, now = () => Date.now() } = {}) {
    this.file = file ? String(file) : null;
    this.log = log;
    this.now = now;
    this.doc = { byInitiative: {} };
    this.status = { found: false, readable: true, error: null, at: null };
    // `mtimeMs:size`, the initiative store's stamp: a hand-edited file (or the other panel instance a reader runs) is
    // noticed on the next read without re-parsing the document on every row of every snapshot.
    this.stamp = null;
    this.skipped = [];
  }

  stampOf() {
    if (!this.file) return "no-file";
    try {
      const st = statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  // Read the document, from disk when it changed (or when the caller insists). A missing file is the ordinary first
  // run: zero waves. A file that exists and cannot be read is the one answer that is NOT "empty".
  load({ fresh = false } = {}) {
    if (!this.file) {
      this.status = { found: false, readable: true, error: null, at: null };
      this.doc = { byInitiative: {} };
      this.skipped = [];
      return this;
    }
    const stamp = this.stampOf();
    if (!fresh && stamp && stamp === this.stamp) return this;
    this.stamp = stamp;
    const empty = (status) => {
      this.status = status;
      this.doc = { byInitiative: {} };
      this.skipped = [];
    };
    if (!existsSync(this.file)) {
      empty({ found: false, readable: true, error: null, at: null });
      return this;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      empty({ found: true, readable: false, error: String((err && err.message) || err), at: null });
      return this;
    }
    if (!isObject(raw)) {
      empty({ found: true, readable: false, error: "the file does not hold an object", at: null });
      return this;
    }
    const source = isObject(raw.byInitiative) ? raw.byInitiative : {};
    const byInitiative = {};
    const skipped = [];
    const seenIds = new Set();
    for (const [keyRaw, list] of Object.entries(source)) {
      const key = String(keyRaw || "").trim();
      if (!key) {
        skipped.push({ initiativeId: null, id: null, error: "a wave list sits under an empty initiative key" });
        continue;
      }
      if (!Array.isArray(list)) {
        skipped.push({ initiativeId: key, id: null, error: `the waves under ${key} are not a list` });
        continue;
      }
      const out = [];
      const positions = new Set();
      for (const rec of list) {
        if (out.length >= WAVES_MAX) {
          skipped.push({ initiativeId: key, id: null, error: `more than ${WAVES_MAX} waves under ${key} - the rest were not read` });
          break;
        }
        const picked = pickWave(rec, key);
        if (picked.error) {
          skipped.push({ initiativeId: key, id: isObject(rec) && rec.id != null ? String(rec.id) : null, error: picked.error });
          continue;
        }
        const wave = picked.wave;
        if (seenIds.has(wave.id)) {
          skipped.push({ initiativeId: key, id: wave.id, error: `${wave.id} appears twice in the file - the second record was not read` });
          continue;
        }
        if (positions.has(wave.position)) {
          skipped.push({ initiativeId: key, id: wave.id, error: `${wave.id} repeats position ${wave.position} within ${key} - positions are unique, and a hand-edited duplicate is refused rather than renumbered` });
          continue;
        }
        seenIds.add(wave.id);
        positions.add(wave.position);
        out.push(wave);
      }
      if (!out.length) continue;
      // Position order, then id, so a hand-edited gap is visible as a gap rather than silently renumbered.
      out.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      byInitiative[key] = out;
    }
    this.status = {
      found: true,
      readable: true,
      error: null,
      at: typeof raw.savedAt === "string" ? raw.savedAt : null,
    };
    this.doc = { byInitiative };
    this.skipped = skipped;
    for (const row of skipped) this.log(`waves: did not read ${row.id || "a record"}${row.initiativeId ? ` under ${row.initiativeId}` : ""}: ${row.error}`);
    return this;
  }

  // What a caller sees of the store itself: the file, whether it exists, whether it could be read, and the sentence a
  // reader can act on. `readable: true` with `found: false` is an empty board, not a problem.
  statusOf() {
    this.load();
    return {
      file: this.file,
      found: this.status.found,
      readable: this.status.readable,
      error: this.status.error,
      at: this.status.at,
    };
  }

  // One initiative's waves, in position order, as copies: a caller cannot mutate the document through this.
  wavesFor(initiativeId) {
    this.load();
    const id = String(initiativeId || "");
    const list = this.doc.byInitiative[id] || [];
    return list.map((wave) => copyWave(wave));
  }

  waveById(id) {
    this.load();
    const wanted = String(id || "");
    for (const list of Object.values(this.doc.byInitiative)) {
      const found = list.find((wave) => wave.id === wanted);
      if (found) return copyWave(found);
    }
    return null;
  }

  // The records the loader refused, one sentence each, for the initiative the tab is drawing.
  skippedFor(initiativeId) {
    this.load();
    const id = String(initiativeId || "");
    return this.skipped.filter((row) => row.initiativeId === id || row.initiativeId === null);
  }

  // ---- writes ------------------------------------------------------------------------------------------------------

  // The one gate every write goes through, BEFORE it validates a body: an unreadable store is a refusal with the file
  // and the reason in the sentence, and a store holding a record the loader skipped is a refusal too. The second rule
  // is decision 3 of the design, and the reason is mechanical: a write serialises the document it loaded, so a record
  // the loader could not read would be dropped by the write rather than repaired. The bytes stay where they are, the
  // sentences are named, and the reader repairs the file.
  refuse() {
    this.load();
    return this.refusal();
  }

  // The refusal for the document ALREADY IN MEMORY. `save()` uses this one and never `refuse()`, because a reload
  // between the mutator's change and the write would discard the change it is about to persist: a store whose file
  // does not exist yet has no stamp, so `load()` treats every call as "changed" and empties the document.
  refusal() {
    const status = { file: this.file, found: this.status.found, readable: this.status.readable, error: this.status.error };
    if (!status.readable) {
      return {
        ok: false,
        refused: "unreadable",
        file: status.file,
        error: `${status.file || "the wave store"} could not be read (${status.error || "unknown error"}) - it was NOT overwritten. Fix or move that file, then try again: every wave on the board lives in it.`,
      };
    }
    if (this.skipped.length) {
      const first = this.skipped[0];
      const name = `${first.id || "a record"}${first.initiativeId ? ` under ${first.initiativeId}` : ""}`;
      return {
        ok: false,
        refused: "skipped",
        file: status.file,
        skipped: this.skipped.slice(),
        error: `${status.file || "the wave store"} holds ${this.skipped.length} record${this.skipped.length === 1 ? "" : "s"} the loader refused, starting with ${name}: ${first.error} - a write would serialise the document and drop it, so nothing was written. Repair the file, then try again.`,
      };
    }
    return null;
  }

  // One atomic save: temp file + rename, like the initiative store, so a reader never sees half a list and a crash
  // mid-write leaves the previous document in place. `version` is this module's WRITE version; a version 1 document
  // is written back as version 2 here, which is the whole migration.
  save() {
    if (!this.file) return { ok: false, error: "no wave store file is configured" };
    // The in-memory status, not a re-read: the mutator has already loaded fresh and changed `this.doc`, and reloading
    // here would throw that change away (see `refusal`).
    const refused = this.refusal();
    if (refused) return refused;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const byInitiative = {};
      for (const [key, list] of Object.entries(this.doc.byInitiative)) {
        if (!Array.isArray(list) || !list.length) continue;
        byInitiative[key] = list.map((wave) => {
          const out = {
            id: wave.id,
            initiativeId: wave.initiativeId,
            position: wave.position,
            title: wave.title,
            entryGate: wave.entryGate ? { ...wave.entryGate } : null,
            exitGate: wave.exitGate ? { ...wave.exitGate } : null,
            template: wave.template ?? null,
            auto: wave.auto === true,
            at: wave.at || null,
            by: wave.by || null,
          };
          // A version 1 record has no history; writing an empty list would add a field a reader never authored, so
          // the pair is written only when there is a story to keep.
          if (Array.isArray(wave.history) && wave.history.length) out.history = wave.history.map((ev) => ({ ...ev }));
          return out;
        });
      }
      const body = {
        version: WAVES_VERSION,
        savedAt: nowIso(this.now()),
        byInitiative,
      };
      // A UNIQUE TEMP NAME, because two stores over one path in one process would otherwise write the same temp file.
      const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      // THE RENAME IS THE ATOMIC STEP, and it is retried for a moment on a Windows lock. An antivirus scanner or a
      // reader holding the target can answer EPERM/EBUSY for a few milliseconds after the temp file appears, and a save
      // is not a lost write because a scanner was looking at it: the same rename is attempted again before the caller is
      // told it failed. The target is never left half-written either way - the temp file is complete before the rename.
      let renameError = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          renameSync(tmp, this.file);
          renameError = null;
          break;
        } catch (err) {
          renameError = err;
          if (!["EPERM", "EBUSY", "EACCES"].includes(String(err && err.code))) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
      if (renameError) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* a temp file that will not go is a leftover, not a failed write */
        }
        throw renameError;
      }
      // The stamp has to move with the write, or the next read re-parses a document this process already holds.
      this.stamp = this.stampOf();
      this.status = { found: true, readable: true, error: null, at: body.savedAt };
      this.skipped = [];
      return { ok: true, file: this.file, at: body.savedAt };
    } catch (err) {
      const error = String((err && err.message) || err);
      this.log(`waves: could not write ${this.file} (${error})`);
      return { ok: false, error };
    }
  }

  // CREATE one wave. The id is derived from the title unless the caller posted one, the position lands last unless
  // the caller posted one, and a posted id or position that is already taken is REFUSED BY NAME rather than
  // renumbered: the loader refuses a duplicate with a sentence, and a writer that silently renumbered would make the
  // file and the reader disagree.
  create(opts = {}) {
    // THE SAME CLOSED DOOR THE LOADER HAS, for a caller that is not the route: a `state`, a `lane`, a member list or
    // a tree list handed to `create` is refused by name rather than dropped, because a writer that quietly ignored it
    // would leave a caller believing the record holds something it never will.
    const extra = Object.keys(opts).find((key) => !WAVE_WRITE_FIELDS.includes(key));
    if (extra) return { ok: false, error: `a wave change carries no ${JSON.stringify(extra)} field - a state, a lane, a member list and a tree list are folded from the members on every read, never written` };
    const { initiativeId = "", id = undefined, title = "", entryGate = undefined, exitGate = undefined, template = undefined, auto = undefined, position = undefined, by = "reader" } = opts;
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const initId = String(initiativeId || "").trim();
    if (!initId) return { ok: false, error: "a wave lives inside one initiative - send initiativeId" };
    const list = this.doc.byInitiative[initId] || [];
    if (list.length >= WAVES_MAX) {
      return { ok: false, error: `${initId} already holds ${WAVES_MAX} waves, which is the cap - remove one before adding another` };
    }
    const taken = new Set();
    for (const rows of Object.values(this.doc.byInitiative)) for (const wave of rows) taken.add(wave.id);
    const posted = id === undefined || id === null ? "" : String(id).trim();
    const waveId = posted || waveIdFrom(title, taken);
    if (taken.has(waveId)) {
      return { ok: false, error: `a wave already uses the id ${JSON.stringify(waveId)} - ids are unique across the whole wave store, so nothing was created` };
    }
    const at = nowIso(this.now());
    const actor = cleanActor(by) || "reader";
    const last = list.reduce((max, wave) => Math.max(max, Number(wave.position) || 0), 0);
    const rawPosition = position === undefined || position === null ? last + 1 : position;
    const picked = pickWave(
      {
        id: waveId,
        initiativeId: initId,
        position: rawPosition,
        title,
        entryGate: entryGate === undefined ? null : entryGate,
        exitGate: exitGate === undefined ? null : exitGate,
        template: template === undefined ? null : template,
        auto: auto === true,
        at,
        by: actor,
        history: [{ at, by: actor, action: "create", detail: `W${rawPosition}, position ${rawPosition}` }],
      },
      initId,
      { strict: true },
    );
    if (picked.error) return { ok: false, error: picked.error };
    const wave = picked.wave;
    if (list.some((row) => row.position === wave.position)) {
      return {
        ok: false,
        error: `${initId} already has a wave at position ${wave.position} - positions are unique inside one initiative, and a taken one is refused rather than renumbered`,
      };
    }
    this.doc.byInitiative = {
      ...this.doc.byInitiative,
      [initId]: [...list, wave].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    };
    const wrote = this.save();
    if (!wrote.ok) {
      // Memory-first would let this process draw a wave the next boot forgets. The document is re-read from disk so
      // what the page paints is what a restart will read.
      this.load({ fresh: true });
      return { ok: false, error: `the wave was not saved: ${wrote.error}` };
    }
    this.log(`waves: created "${wave.title}" (${wave.id}) at position ${wave.position} of ${initId} by ${wave.by}`);
    return { ok: true, changed: true, wave: copyWave(wave), file: this.file };
  }

  // EDIT the words, the gates, the template and the switch. Position is not one of them: a reorder is `move`, so one
  // write cannot be a bit of both. Every field is optional and `undefined` means "leave it"; an explicit `null` on a
  // gate or the template clears it.
  update({ initiativeId = "", id = "", title = undefined, entryGate = undefined, exitGate = undefined, template = undefined, auto = undefined, by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const initId = String(initiativeId || "").trim();
    const waveId = String(id || "").trim();
    if (!waveId) return { ok: false, error: "an edit needs the wave id" };
    const list = this.doc.byInitiative[initId] || [];
    const cur = list.find((wave) => wave.id === waveId) || null;
    if (!cur) {
      const elsewhere = this.waveById(waveId);
      return {
        ok: false,
        notFound: true,
        error: elsewhere ? `${waveId} belongs to ${elsewhere.initiativeId}, not ${initId || "(none)"}` : `no such wave in ${initId || "(none)"}: ${waveId}`,
      };
    }
    if ([title, entryGate, exitGate, template, auto].every((value) => value === undefined)) {
      return { ok: false, error: "nothing to change: send a title, an entry gate, an exit gate, a template or the switch" };
    }
    const at = nowIso(this.now());
    const actor = cleanActor(by) || "reader";
    const raw = { ...cur, at, by: actor };
    if (title !== undefined) raw.title = title;
    if (entryGate !== undefined) raw.entryGate = entryGate;
    if (exitGate !== undefined) raw.exitGate = exitGate;
    if (template !== undefined) raw.template = template;
    if (auto !== undefined) raw.auto = auto === true;
    const picked = pickWave(raw, initId, { strict: true });
    if (picked.error) return { ok: false, error: picked.error };
    const next = picked.wave;
    const fields = [];
    if (next.title !== cur.title) fields.push("the title");
    if (JSON.stringify(next.entryGate) !== JSON.stringify(cur.entryGate)) fields.push("the entry gate");
    if (JSON.stringify(next.exitGate) !== JSON.stringify(cur.exitGate)) fields.push("the exit gate");
    if (next.template !== cur.template) fields.push("the template");
    if (next.auto !== cur.auto) fields.push("the switch");
    // An edit that changes nothing is not an event: a history that recorded every press would be a list of presses
    // rather than a list of changes, which is the initiative store's own rule.
    if (!fields.length) return { ok: true, changed: false, wave: copyWave(cur), file: this.file };
    next.history = [...(Array.isArray(cur.history) ? cur.history : []), { at, by: actor, action: "edit", detail: fields.join(", ") }].slice(-WAVE_HISTORY_MAX);
    this.doc.byInitiative = {
      ...this.doc.byInitiative,
      [initId]: list.map((wave) => (wave.id === cur.id ? next : wave)),
    };
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the change was not saved: ${wrote.error}` };
    }
    this.log(`waves: edited ${next.id} (${fields.join(", ")}) by ${actor}`);
    return { ok: true, changed: true, wave: copyWave(next), file: this.file };
  }

  // MOVE one wave to a 1-based position and renumber the list 1..n inside ONE write. A duplicate position is
  // impossible by construction here, which is why the loader's duplicate refusal never has to fight the writer; a gap
  // a reader made by hand is closed by the first reorder, and that is the one normalisation a write may perform. A
  // `to` past either end is CLAMPED and the answer carries where it landed, because the intent is "put it last", not
  // an index error.
  move({ initiativeId = "", id = "", to = undefined, by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const initId = String(initiativeId || "").trim();
    const waveId = String(id || "").trim();
    if (!waveId) return { ok: false, error: "a move needs the wave id" };
    const current = this.doc.byInitiative[initId] || [];
    const index = current.findIndex((wave) => wave.id === waveId);
    if (index < 0) {
      const elsewhere = this.waveById(waveId);
      return {
        ok: false,
        notFound: true,
        error: elsewhere ? `${waveId} belongs to ${elsewhere.initiativeId}, not ${initId || "(none)"}` : `no such wave in ${initId || "(none)"}: ${waveId}`,
      };
    }
    const wanted = Number(to);
    if (!Number.isInteger(wanted)) return { ok: false, error: "a move needs `to`, the 1-based position the wave should end at" };
    const list = current.slice();
    const target = Math.min(Math.max(wanted, 1), list.length);
    const moved = list.splice(index, 1)[0];
    const from = moved.position;
    list.splice(target - 1, 0, moved);
    const contiguous = current.every((wave, at) => wave.position === at + 1);
    if (index === target - 1 && contiguous) {
      return { ok: true, changed: false, to: target, waves: this.wavesFor(initId), file: this.file };
    }
    const at = nowIso(this.now());
    const actor = cleanActor(by) || "reader";
    const renumbered = list.map((wave, at2) => ({ ...wave, position: at2 + 1 }));
    const next = renumbered.map((wave) => {
      if (wave.id !== moved.id) return wave;
      const detail = index === target - 1 ? `positions renumbered 1..${list.length}` : `position ${from} to ${wave.position}`;
      return {
        ...wave,
        at,
        by: actor,
        history: [...(Array.isArray(wave.history) ? wave.history : []), { at, by: actor, action: "move", detail }].slice(-WAVE_HISTORY_MAX),
      };
    });
    this.doc.byInitiative = { ...this.doc.byInitiative, [initId]: next };
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the move was not saved: ${wrote.error}` };
    }
    this.log(`waves: moved ${waveId} from position ${from} to ${target} of ${initId} by ${actor}`);
    return { ok: true, changed: true, to: target, waves: this.wavesFor(initId), file: this.file };
  }

  // REMOVE one record. It does not touch a task: membership is the task's own `waveId`, so a member row keeps its
  // field and simply reads as a member of no wave on the next read. Rewriting queue rows would be a second writer on
  // another store; the route counts the rows that still name the id and says so in its answer. The record's own field
  // set is the only thing that changes: the remaining positions are renumbered 1..n so the route has no hole in it.
  remove({ initiativeId = "", id = "", by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const initId = String(initiativeId || "").trim();
    const waveId = String(id || "").trim();
    if (!waveId) return { ok: false, error: "a delete needs the wave id" };
    const list = this.doc.byInitiative[initId] || [];
    const found = list.find((wave) => wave.id === waveId) || null;
    if (!found) {
      const elsewhere = this.waveById(waveId);
      return {
        ok: false,
        notFound: true,
        error: elsewhere ? `${waveId} belongs to ${elsewhere.initiativeId}, not ${initId || "(none)"}` : `no such wave in ${initId || "(none)"}: ${waveId}`,
      };
    }
    const byInitiative = { ...this.doc.byInitiative };
    // THE GAP IS CLOSED IN THE SAME WRITE. A delete at the end needs nothing, but a delete in the middle would leave
    // the survivors labelled 1, 3, 4 - a route whose first station reads W1 and whose third reads W4 is a lie about how
    // many waves the initiative holds, and the station marks are the only place that count is drawn. The survivors are
    // renumbered 1..n and nothing else about them changes: their words, gates and provenance are untouched, because a
    // position shift is bookkeeping rather than an edit of the wave.
    const rest = list.filter((wave) => wave.id !== waveId).map((wave, at2) => (wave.position === at2 + 1 ? wave : { ...wave, position: at2 + 1 }));
    if (rest.length) byInitiative[initId] = rest;
    else delete byInitiative[initId];
    this.doc.byInitiative = byInitiative;
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the delete was not saved: ${wrote.error}` };
    }
    this.log(`waves: removed "${found.title}" (${found.id}) from ${initId} by ${cleanActor(by) || "reader"}`);
    return { ok: true, changed: true, wave: copyWave(found), file: this.file };
  }
}

// A record as a caller's own copy: the two gates and the history are objects, and a caller that held the document's
// own would be one `push` away from changing a wave without a write.
function copyWave(wave) {
  return {
    ...wave,
    entryGate: wave.entryGate ? { ...wave.entryGate } : null,
    exitGate: wave.exitGate ? { ...wave.exitGate } : null,
    history: Array.isArray(wave.history) ? wave.history.map((ev) => ({ ...ev })) : [],
  };
}

// ---- the gate read ------------------------------------------------------------------------------------------------
// The checks this slice can READ today, and the evidence each one asks. `clean` and `commits` are row facts the scan
// already measured; `pr-open`, `pr-merged` and `main-moved` are EVIDENCE reads (lib/wave-evidence.js) made on this
// request: the pull request's state through the host's API and the member's content on origin/main; `file-exists` is
// read from the member's own tree, else from a commit on the wave's main, by the same module (`readMemberPath`).
// Everything else in the vocabulary reads `unknown`: the panel validates those names (lib/pipelines.js) and has no
// evaluator for them yet, and a slice that claimed otherwise would be a gate that passes because nothing looked.
//
// A MEMBER'S STORED WORD IS NEVER A GATE'S EVIDENCE. `member.pr` is what the last scan wrote and the lane draws it;
// `readWaveGate` does not read it. When no evidence reader is supplied, or the reader throws, or the read it made
// says it could not answer, the gate answers cannot tell - which blocks.
//
// Where the evidence is a MEMBER, every member must have something to say. One member with no board row and no PR
// makes the answer "cannot tell" rather than "not met": the work's state and the reader's ability to see it are
// different facts, and the design keeps different words for them.
const PR_MERGED = /^MERGED/i;
const PR_OPEN = /^OPEN$/i;

const unmet = (check, why) => ({ check, state: "unmet", met: false, cannotTell: false, closed: false, why });
const met = (check, why) => ({ check, state: "met", met: true, cannotTell: false, closed: true, why });
const cannotTell = (check, why) => ({ check, state: "unknown", met: false, cannotTell: true, closed: false, why });
const abandonedGate = (check, why, abandoned) => ({ check, state: "abandoned", met: false, cannotTell: false, closed: true, abandoned, why });
// `check` is kept when the gate NAMES one but has nothing to read it against. The state is still `none` - there is no
// answer - but "no gate" and "a gate with no member yet" are different facts, and a wave authored from the tab is the
// first case where the difference is visible: a just-created wave has its gates and no member to check them against.
const noneGate = (why, check = null) => ({ check: check || null, state: "none", met: false, cannotTell: false, closed: false, why });

const idsOf = (list) => list.map((m) => `#${m.id}`).join(", ");

// A member abandoned for a NAMED reason, or null. `abandoned` without a reason is a status word, and a status word
// cannot close a gate: namedAbandon answers null for it and the caller answers cannot tell.
const namedAbandon = (m) => {
  const raw = m && m.abandoned;
  const reason = typeof raw === "string" ? raw : String(raw && raw.reason ? raw.reason : "");
  const cleaned = reason.replace(/\s+/g, " ").trim();
  return cleaned ? { reason: clip(cleaned, 240), at: raw && typeof raw === "object" ? raw.at || null : null, by: raw && typeof raw === "object" ? raw.by || null : null } : null;
};
const bareAbandon = (m) => Boolean(m && m.abandoned) && !namedAbandon(m);

/**
 * A MEMBER IS CLOSED when its row reads done, or when a person abandoned it for a named reason - the fold's own
 * definition of finished work (`deriveWaveState` below closes a wave on exactly this test). Exported because the
 * initiatives tab asks the same question of a whole initiative before it archives one: two ideas of "open" in one
 * panel would archive work somebody is still doing, so the archive refusal below reads THIS function, never its own
 * copy of the rule.
 */
export const waveMemberClosed = (member) => Boolean(member) && (member.state === "done" || Boolean(namedAbandon(member)));
export const waveMemberOpen = (member) => Boolean(member) && !waveMemberClosed(member);

/**
 * A WAVE IS OPEN unless its own fold says the work is over: done, abandoned, or empty (no card names it). `state` is
 * the derived word on every wave view, folded by `deriveWaveState` from the members and the gates - so this reads the
 * same answer the lane draws and the wave drive closes a wave on, not a stored field.
 */
export const waveIsOpen = (view) => Boolean(view) && !(view.state === "done" || view.state === "abandoned" || view.state === "empty");

// The ref a main-moved gate names, from its own params. The evidence is read against the project's main; a gate that
// names another ref is not silently judged against this one (see the mismatch check below).
const mainRefOf = (gate) => `${String(gate.remote || "origin").trim() || "origin"}/${String(gate.main || "main").trim() || "main"}`;

/**
 * Every path the given wave records' gates read for `file-exists`, unique and in the order the gates name them. The
 * routes hand this to the evidence read, because only the request knows which waves it is about to fold: the read is
 * one per path, and a `file-exists` gate whose path is not in the set answers cannot tell rather than passing on a
 * read nobody made. Capped by `WAVE_ARTEFACT_PATHS_MAX` - the same cap the evidence read applies, so a path dropped
 * here is a path the gate reports as unread, never one silently read as absent.
 */
export function waveFileExistsPaths(records = []) {
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") continue;
    for (const gate of [record.entryGate, record.exitGate]) {
      if (!gate || gate.check !== "file-exists") continue;
      const rel = String(gate.path ?? "").trim();
      if (!rel || out.includes(rel)) continue;
      out.push(rel);
      if (out.length >= WAVE_ARTEFACT_PATHS_MAX) return out;
    }
  }
  return out;
}

/**
 * WHICH GATE CHECKS READ EVIDENCE AT ALL, and which half of it each one consumes. This table is the reason a read does
 * not have to guess: `clean` and `commits` judge the board row and never touch the evidence map, so a wave gated on
 * either owes no live read; `pr-open` reads the pull request only, `pr-merged` the pull request and the landing,
 * `main-moved` the landing only, and `file-exists` the artefact path only. `readWaveGate` is the other half of this
 * contract - if a case is added there that calls `evidenceFor`, it belongs here too.
 *
 * A CHECK NOT IN THIS TABLE NEEDS NO EVIDENCE. The gate's default case answers cannot tell without reading one, so a
 * name this table does not know is a name that never wanted a read.
 */
export const WAVE_EVIDENCE_READS = Object.freeze({
  "pr-open": Object.freeze({ pr: true, landing: false, files: false }),
  "pr-merged": Object.freeze({ pr: true, landing: true, files: false }),
  "main-moved": Object.freeze({ pr: false, landing: true, files: false }),
  "file-exists": Object.freeze({ pr: false, landing: false, files: true }),
});

/**
 * What a set of wave records asks the evidence read for: the check names, the wave ids whose gates read anything, and
 * the three halves to read. An empty answer is the common case and it is a fact, not an error: a lane of waves with no
 * gates (or gates that judge the row) owes no host read and no git spawn, so the read that folds it costs the fold.
 *
 * The member scope is the wave ids, not the initiative's trees: a wave's members are the tasks that NAME it, and a task
 * that names no wave is in no wave's gate.
 */
export function waveEvidenceNeeds(records = []) {
  const checks = [];
  const waveIds = [];
  const reads = { pr: false, landing: false, files: false };
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") continue;
    for (const gate of [record.entryGate, record.exitGate]) {
      const check = String(gate?.check ?? "").trim();
      const want = WAVE_EVIDENCE_READS[check];
      if (!want) continue;
      if (!checks.includes(check)) checks.push(check);
      const id = String(record.id ?? "");
      if (id && !waveIds.includes(id)) waveIds.push(id);
      reads.pr = reads.pr || want.pr;
      reads.landing = reads.landing || want.landing;
      reads.files = reads.files || want.files;
    }
  }
  return { checks, waveIds, reads };
}

/**
 * Judge every member's answer into the gate's one answer. Not-met outranks cannot-tell because it is the stronger
 * truth: one member's PR is definitely OPEN, so the gate is definitely not closed, whatever another read could not
 * see. With no not-met, any blindness is cannot tell. With everything met and at least one named abandonment, the
 * gate is CLOSED AS ABANDONED and names the member and its reason - never counted as done.
 */
function judgeAnswers(check, answers, metWhy) {
  const missed = answers.filter((a) => a.state === "unmet");
  if (missed.length) return unmet(check, missed.map((a) => a.why).join("; "));
  const blind = answers.filter((a) => a.state === "unknown");
  if (blind.length) return cannotTell(check, blind.map((a) => a.why).join("; "));
  const gone = answers.filter((a) => a.state === "abandoned");
  if (gone.length) return abandonedGate(check, gone.map((a) => a.why).join("; "), gone.map((a) => a.abandoned));
  return met(check, metWhy);
}

/**
 * One live read of a gate against the wave's members. Answers met / unmet / abandoned / cannot tell, never throws,
 * and never reads a stored word: `evidenceFor(member)` is the live read lib/wave-evidence.js made on this request.
 *
 * `evidenceFor` is called once per member and may throw; a throw is cannot tell for that member, and the gate never
 * becomes met because a reader failed.
 */
export function readWaveGate(gate, members = [], evidenceFor = null) {
  if (!gate || !gate.check) return noneGate("no gate is named");
  const check = gate.check;
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return noneGate(`${check} has no member to read`, check);
  const blind = list.filter((m) => !m.hasRow);
  const evidenceOf = (m) => {
    if (typeof evidenceFor !== "function") return { evidence: null, why: `no evidence read was made for #${m.id}` };
    try {
      const evidence = evidenceFor(m);
      if (!evidence) return { evidence: null, why: `no evidence was read for #${m.id}` };
      if (evidence.error) return { evidence: null, why: `the evidence read for #${m.id} failed: ${String(evidence.error)}` };
      return { evidence, why: null };
    } catch (error) {
      return { evidence: null, why: `the evidence read for #${m.id} threw: ${String((error && error.message) || error)}` };
    }
  };
  // The three answers that need a live read. Every one of them treats a named abandonment as a closed member and an
  // unnamed one as a status word, and none of them looks at `m.pr`.
  const judgeEvidence = (member, read) => {
    const closed = abandonedAnswer(member);
    if (closed) return closed;
    const { evidence, why } = evidenceOf(member);
    if (!evidence) return { state: "unknown", why };
    return read(evidence, member.id);
  };
  // A member a person abandoned for a named reason is a CLOSED member for every check: it is not judged on its row
  // facts or its PR any more, and the gate closes as abandoned rather than met. An unnamed one is a status word and
  // answers cannot tell. This sits above the switch so no check can quietly count an abandoned member as done.
  const abandonedAnswer = (member) => {
    const named = namedAbandon(member);
    if (named) return { state: "abandoned", why: `#${member.id} was abandoned: ${named.reason}`, abandoned: { id: member.id, reason: named.reason } };
    if (bareAbandon(member)) return { state: "unknown", why: `#${member.id} is marked abandoned with no reason, and an unnamed abandonment is a status word that cannot close a gate` };
    return null;
  };
  switch (check) {
    case "clean": {
      const answers = list.map((m) =>
        abandonedAnswer(m) || (!m.hasRow
          ? { state: "unknown", why: `no board row for #${m.id}, so the dirty count cannot be read` }
          : Number(m.dirty) > 0
            ? { state: "unmet", why: `#${m.id} holds dirty work` }
            : { state: "met", why: `#${m.id} is clean` }),
      );
      return judgeAnswers(check, answers, "every member's tree is clean");
    }
    case "commits": {
      const min = Number(gate.min) > 0 ? Number(gate.min) : 1;
      const answers = list.map((m) =>
        abandonedAnswer(m) || (!m.hasRow
          ? { state: "unknown", why: `no board row for #${m.id}, so the commits ahead cannot be read` }
          : Number(m.ahead) >= min
            ? { state: "met", why: `#${m.id} is ${Number(m.ahead)} ahead` }
            : { state: "unmet", why: `#${m.id} is ${Number(m.ahead) || 0} ahead, not ${min}` }),
      );
      return judgeAnswers(check, answers, `every member is at least ${min} commit${min === 1 ? "" : "s"} ahead`);
    }
    case "pr-open": {
      const answers = list.map((m) =>
        judgeEvidence(m, (evidence, id) => {
          if (!evidence.pr) return { state: "unknown", why: `#${id} ${evidence.why || "names no pull request"}, so there is nothing to read` };
          const word = String(evidence.pr.state || "");
          if (PR_OPEN.test(word)) return { state: "met", why: `#${id}'s pull request #${evidence.pr.number} reads OPEN` };
          return { state: "unmet", why: `#${id}'s pull request #${evidence.pr.number} reads ${word || "no state"}, not OPEN` };
        }),
      );
      return judgeAnswers(check, answers, "every member's pull request reads OPEN through the API");
    }
    case "pr-merged": {
      const answers = list.map((m) =>
        judgeEvidence(m, (evidence, id) => {
          if (!evidence.pr) return { state: "unknown", why: `#${id} ${evidence.why || "names no pull request"}, so merging cannot be confirmed` };
          const word = String(evidence.pr.state || "");
          if (!PR_MERGED.test(word)) return { state: "unmet", why: `#${id}'s pull request #${evidence.pr.number} reads ${word || "no state"}, not MERGED` };
          const landed = evidence.landing || null;
          if (!landed || landed.state === "unknown") {
            return { state: "unknown", why: `#${id}'s pull request #${evidence.pr.number} reads MERGED, but its landing cannot be read: ${(landed && landed.why) || "no landing read was made"}` };
          }
          if (landed.state !== "landed") {
            return { state: "unmet", why: `#${id}'s pull request #${evidence.pr.number} reads MERGED, but ${landed.why}` };
          }
          return { state: "met", why: `#${id}'s pull request #${evidence.pr.number} reads MERGED and ${landed.why}` };
        }),
      );
      return judgeAnswers(check, answers, answers.map((x) => x.why).join("; "));
    }
    case "main-moved": {
      const wanted = mainRefOf(gate);
      const answers = list.map((m) =>
        judgeEvidence(m, (evidence, id) => {
          const landed = evidence.landing || null;
          if (!landed || landed.state === "unknown") return { state: "unknown", why: `#${id}'s content on main cannot be read: ${(landed && landed.why) || "no landing read was made"}` };
          const read = String(landed.main || "");
          if (read && read !== wanted) return { state: "unknown", why: `#${id}'s content was read against ${read}, but the gate names ${wanted}, so the two cannot be compared` };
          if (landed.state !== "landed") return { state: "unmet", why: `#${id}'s content is not on ${wanted}: ${landed.why}` };
          return { state: "met", why: `#${id}: ${landed.why}` };
        }),
      );
      return judgeAnswers(check, answers, answers.map((x) => x.why).join("; "));
    }
    case "file-exists": {
      const rel = text(gate.path);
      // NO BOARD ROW IS REQUIRED, and that is the point of this check: `clean` and `commits` read the row because the row
      // IS the fact, but an artefact's fact is the read, and a landed local-only wave whose tree the scan has dropped
      // (its own cleanup) must still close on its landing commit. The row is the tree's display, not this check's
      // evidence; a member with nothing read for the path answers cannot tell below.
      const answers = list.map((m) =>
        abandonedAnswer(m) ||
        judgeEvidence(m, (evidence, id) => {
          // The read the evidence carries is the one made for THIS path on this request. No read is cannot tell,
          // never an absence: the gate must not read unmet because the caller forgot to ask.
          const found = evidence.files && isObject(evidence.files[rel]) ? evidence.files[rel] : null;
          if (!found) return { state: "unknown", why: `no read of ${rel} was made for #${id}, so there is nothing to say it exists` };
          if (found.state === "present") return { state: "met", why: `#${id}'s ${rel}: ${found.why}` };
          if (found.state === "absent") return { state: "unmet", why: `#${id}'s ${rel} is absent: ${found.why}` };
          return { state: "unknown", why: `#${id}'s ${rel} cannot be told: ${found.why}` };
        }),
      );
      return judgeAnswers(check, answers, answers.map((x) => x.why).join("; "));
    }
    default:
      return cannotTell(check, `no evaluator reads "${check}" yet - the name is validated, not run (lib/pipelines.js)`);
  }
}

// ---- lanes inside a wave ------------------------------------------------------------------------------------------
// A LANE is a set of the wave's members that touch a common file, or a set a member names on its own record, and it
// runs beside the wave's other lanes rather than after them. Three rules decide this section:
//
//   1. A LANE IS DERIVED, NEVER STORED ON THE WAVE. The wave record has no `lanes` field (pickWave drops one a reader
//      writes by hand), because a lane list on the wave would be the second copy of a fact the members already carry.
//      A member that names a lane keeps that name; the rows that name none are grouped by the file rule the queue
//      already applies (lib/assistant/queue.js `intersectingFiles`: two rows that claim a common file are one lane,
//      because one of them waits for the other), and the rows that share a file with nobody are the UNLANED lane.
//      When every member lands in that one lane the wave holds ONE IMPLICIT LANE: today's wave, folded and drawn
//      exactly as it was, with nothing new on the record and no join owed.
//   2. A LANE SET THAT SHARES A TREE IS REFUSED. A lane runs in its own trees and never a sibling's
//      (lib/pipeline-fanout.js rule 2: one lane, one tree), so two lanes naming one tree cannot be isolated. This
//      module does not repeat the rule, it reads the members' trees and refuses the set with the lanes and the tree.
//   3. THE JOIN IS ONE COMMIT, AND ITS MESSAGE NAMES THE LANE SET. `joinWaveLanes` hands the lanes' PINNED commits to
//      lib/pipeline-aggregate.js, which pre-flights every lane over the object database and then builds ONE commit
//      with one parent per lane; the message is the aggregate's own builder, with the wave's id where a pipeline
//      names its join stage. A pin is a commit AND a blob (lib/stage-pin.js, through lib/wave-evidence.js): this repo
//      squashes, so the landed sha is rewritten, and the blob is the half of the pin that still names what landed.
//
// NOTHING HERE SCHEDULES. A lane set is read on every read and a join runs only when a caller supplies a tree, a base
// and the lanes it read. There is no timer, no automatic advance and no switch.
//
// The label a lane of members that name none is drawn and merged under. A file path is a lane's own name; this word is
// the one the panel adds, and it says exactly what those members did: none of them named a lane.
export const WAVE_LANE_UNLANED = "unlaned";
// A lane folds to one of the queue's own four states. It is a word about its members, never a stored field.
export const WAVE_LANE_STATES = Object.freeze([...TASK_STATES]);

// A path key: the same normalisation the queue gives a claimed file, so a lane named `lib/X.js` and a member claiming
// `.\lib\x.js` land in one lane rather than two.
const text = (value) => String(value ?? "").trim();
const normPath = (value) =>
  String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
const byMemberId = (a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0) || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));

/**
 * The lane a member's OWN record names, or null. A row written before lanes existed names none, and the derivation
 * below groups it by the files it claims instead - a member is never given a lane the wave invented for it.
 */
export function waveLaneNamed(member) {
  const raw = member && member.lane != null ? String(member.lane) : "";
  const name = raw.replace(/\s+/g, " ").trim();
  return name ? clip(name, TASK_LANE_MAX) : null;
}

// A lane's state, folded from its members: a running member holds the lane, a parked one that nobody abandoned for a
// named reason parks it, every member closed makes it done, and anything else is queued. Never stored.
function waveLaneStateOf(members) {
  const list = Array.isArray(members) ? members : [];
  if (list.some((m) => m && m.state === "running")) return "running";
  if (list.some((m) => m && m.state === "parked" && !namedAbandon(m))) return "parked";
  if (list.length && list.every(waveMemberClosed)) return "done";
  return "queued";
}

// The members that owe the join a pin: one that ran (done or parked), or one already given a tree. A queued member
// that never got a tree owes nothing - the design lets a wave close with a member still queued for a follow-up.
const waveLaneOwes = (member) =>
  Boolean(member) && (Boolean(String(member.worktree || "").trim()) || member.state === "done" || member.state === "parked");

/**
 * One lane's read: can this lane be named as a thing that ran, and in which trees? It never throws, and the answer a
 * caller must not mistake for a pass is `ok: false` - a member that ran and names no tree makes the lane unpinnable,
 * and "cannot tell" is a first-class answer here exactly as it is on a gate.
 */
export function readWaveLane(lane) {
  const record = lane && typeof lane === "object" ? lane : {};
  const members = Array.isArray(record.members) ? record.members : [];
  const label = String(record.label || record.name || WAVE_LANE_UNLANED);
  if (!members.length) return { ok: false, cannotTell: true, trees: [], why: `lane ${label} has no member` };
  const owed = members.filter((m) => waveLaneOwes(m));
  const blind = owed.filter((m) => !String(m.worktree || "").trim());
  if (blind.length) {
    const ids = blind.map((m) => `#${m.id ?? "?"}`).join(", ");
    return {
      ok: false,
      cannotTell: true,
      trees: [],
      why: `${ids} ${blind.length === 1 ? "has" : "have"} run but ${blind.length === 1 ? "names" : "name"} no tree, so lane ${label} cannot be pinned to what it produced`,
    };
  }
  const trees = [...new Set(owed.map((m) => String(m.worktree).trim()).filter(Boolean))];
  return { ok: true, cannotTell: false, trees, why: `lane ${label} names ${trees.length} tree${trees.length === 1 ? "" : "s"}` };
}

/**
 * The groups of members that claim a common file, each named by the lowest path the group shares. The intersection
 * rule is the queue's own (`intersectingFiles`); what is added here is only the GROUPING - a disjoint set per lane -
 * so the wave and the queue cannot end up with two ideas of which rows touch one file. A group of one is not a lane
 * of its own: it comes back with no name and the caller puts it in the unlaned lane.
 */
function waveFileLanes(members) {
  const list = Array.isArray(members) ? members : [];
  const claiming = list.filter((m) => Array.isArray(m.files) && m.files.length);
  const alone = list.filter((m) => !(Array.isArray(m.files) && m.files.length)).map((m) => ({ name: null, members: [m] }));
  if (claiming.length < 2) return [...claiming.map((m) => ({ name: null, members: [m] })), ...alone];
  const parent = new Map(claiming.map((m) => [m, m]));
  const label = new Map();
  const rootOf = (m) => {
    let at = m;
    while (parent.get(at) !== at) at = parent.get(at);
    return at;
  };
  const join = (a, b, shared) => {
    const ra = rootOf(a);
    const rb = rootOf(b);
    const best = [...shared, label.get(ra), label.get(rb)].filter(Boolean).sort()[0] || null;
    if (ra === rb) {
      label.set(ra, best);
      return;
    }
    parent.set(rb, ra);
    label.set(ra, best);
  };
  for (let i = 0; i < claiming.length; i += 1) {
    for (let j = i + 1; j < claiming.length; j += 1) {
      const shared = intersectingFiles(claiming[i].files, claiming[j].files).map(normPath).filter(Boolean).sort();
      if (shared.length) join(claiming[i], claiming[j], shared);
    }
  }
  const groups = new Map();
  for (const member of claiming) {
    const root = rootOf(member);
    if (!groups.has(root)) groups.set(root, { name: label.get(root) || null, members: [] });
    groups.get(root).members.push(member);
  }
  return [...groups.values(), ...alone];
}

// The one refusal a lane set can earn: two lanes that name one tree. A definite fact about the record, so a wave
// answers `blocked` on it rather than cannot tell - the reader is not blind, the lane set is wrong.
function waveLaneClash(lanes) {
  const holder = new Map();
  const clashes = [];
  for (const lane of lanes) {
    for (const tree of lane.trees) {
      const key = normPath(tree);
      if (!key) continue;
      const held = holder.get(key);
      if (!held) {
        holder.set(key, lane);
        continue;
      }
      if (held.key === lane.key) continue;
      clashes.push({ tree, lanes: [held.label, lane.label] });
    }
  }
  const unique = [];
  for (const clash of clashes) if (!unique.some((c) => c.tree === clash.tree)) unique.push(clash);
  if (!unique.length) return null;
  const sentence = "two lanes that share a tree can read each other's files, which is the one thing a lane exists to prevent";
  const first = unique[0];
  const why =
    unique.length === 1
      ? `lane ${first.lanes[0]} and lane ${first.lanes[1]} share the tree ${first.tree} - ${sentence}`
      : `${unique.length} trees are held by two lanes (${unique
          .slice(0, 3)
          .map((c) => `${c.tree}: ${c.lanes.join(" + ")}`)
          .join("; ")}${unique.length > 3 ? `, and ${unique.length - 3} more` : ""}) - ${sentence}`;
  return { trees: unique.map((c) => c.tree), lanes: unique.flatMap((c) => c.lanes), why };
}

/**
 * The wave's lanes, DERIVED from its members on every read. `{lanes, count, implicit, joinOwed, isolation, refused}`:
 * `implicit` says the wave holds the one lane the panel made up (today's wave), `joinOwed` says two or more lanes are
 * held so a close is a join, and `refused` is the lane set's own sentence when two lanes share a tree.
 */
export function waveLanes(members = [], { readLane = readWaveLane } = {}) {
  const list = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === "object");
  // A member that NAMES a lane keeps it: the name is its own record's, never the wave's.
  const buckets = new Map();
  const free = [];
  for (const member of list) {
    const name = waveLaneNamed(member);
    if (!name) {
      free.push(member);
      continue;
    }
    const key = normPath(name) || name;
    if (!buckets.has(key)) buckets.set(key, { name, members: [] });
    buckets.get(key).members.push(member);
  }
  // A member that names none is grouped by the queue's file rule; one that shares a file with nobody is unlaned.
  const unlaned = [];
  for (const group of waveFileLanes(free)) {
    if (group.members.length < 2 || !group.name) {
      unlaned.push(...group.members);
      continue;
    }
    const key = normPath(group.name) || group.name;
    if (!buckets.has(key)) buckets.set(key, { name: group.name, members: [] });
    buckets.get(key).members.push(...group.members);
  }
  if (unlaned.length) {
    if (!buckets.has(WAVE_LANE_UNLANED)) buckets.set(WAVE_LANE_UNLANED, { name: null, members: [] });
    buckets.get(WAVE_LANE_UNLANED).members.push(...unlaned);
  }
  // Named lanes in path order, the unlaned lane last: a wave's lane set reads the same on every request.
  const keys = [...buckets.keys()].sort((a, b) => (a === WAVE_LANE_UNLANED ? 1 : b === WAVE_LANE_UNLANED ? -1 : a.localeCompare(b)));
  const lanes = keys.map((key) => {
    const bucket = buckets.get(key);
    const own = bucket.members.slice().sort(byMemberId);
    const lane = {
      key,
      name: bucket.name || null,
      label: bucket.name || WAVE_LANE_UNLANED,
      state: waveLaneStateOf(own),
      memberIds: own.map((m) => (m.id == null ? null : m.id)).filter((id) => id !== null),
      members: own,
      trees: [...new Set(own.map((m) => String(m.worktree || "").trim()).filter(Boolean))],
      files: [...new Set(own.flatMap((m) => (Array.isArray(m.files) ? m.files : [])).map((f) => String(f).trim()).filter(Boolean))],
    };
    return { ...lane, read: readLane(lane) };
  });
  return {
    lanes,
    count: lanes.length,
    implicit: lanes.length === 1 && !lanes[0].name,
    joinOwed: lanes.length >= 2,
    // The model every lane runs under is the fan-out's own word, so a reader of the lane set reads the same isolation
    // a per-stage pipeline names rather than a second dialect for one idea.
    isolation: ISOLATION_PER_STAGE,
    refused: waveLaneClash(lanes),
  };
}

/**
 * CLOSE A WAVE: join its lanes in ONE commit.
 *
 * The caller supplies the tree to merge into and its base, because a wave owns no tree (rule 1); the lanes are the
 * ones a read derived, each carrying what it settles at: either the pins `readWaveLanePins` answered (`pins`, the
 * shape lib/wave-evidence.js returns, so the two compose with no glue) or its members each with a `pin`
 * naming their commit. The merge is lib/pipeline-aggregate.js's own: every lane pre-flighted over the object database
 * first, then ONE commit with one parent per lane, verified against the tree the pre-flight produced. A conflict is a
 * refusal that names the paths, not a half-made merge.
 *
 * `aggregate` is the merge itself, taken as an argument so a test can answer every shape without a repository. The
 * function refuses rather than guessing: a wave with one lane has nothing to join, a lane with no pinned commit
 * cannot be merged by a branch name (lib/stage-pin.js rule 1), and a lane with nothing that ran cannot be named.
 */
export function joinWaveLanes({ wave, lanes = [], tree = null, base = null, aggregate = aggregateBranches, at = null } = {}) {
  const record = wave && typeof wave === "object" ? wave : null;
  const waveId = record ? String(record.id || "").trim() : "";
  const refuse = (code, reason) => ({
    ok: false,
    code,
    merged: false,
    alreadyMerged: false,
    commit: null,
    tree: null,
    written: null,
    verified: false,
    conflicts: [],
    parents: 0,
    checkedOut: false,
    wave: waveId || null,
    lanes: [],
    branches: [],
    message: null,
    record: null,
    reason,
  });
  if (!waveId) return refuse("wave-join-input", "there is no wave to name the join");
  const set = (Array.isArray(lanes) ? lanes : []).filter((lane) => lane && typeof lane === "object");
  if (set.length < 2) {
    return refuse(
      "wave-join-input",
      `wave ${waveId} holds ${set.length || "no"} lane${set.length === 1 ? "" : "s"} - a join is owed by two or more, and a single lane would be a commit that changes nothing`,
    );
  }
  const where = String(tree || "").trim();
  if (!where) return refuse("wave-join-input", `wave ${waveId}'s join needs the tree to merge into: a wave owns no tree, so the caller names one`);
  const perLane = set.map((lane) => {
    const label = String(lane.label || lane.name || WAVE_LANE_UNLANED);
    // Two shapes, one meaning: a lane may carry the pins `readWaveLanePins` answered, or its own members each with a
    // pin. A member with neither is unpinned, and an unpinned lane is a refusal rather than a merge from a branch.
    const pins = lane.pins && Array.isArray(lane.pins.members) ? lane.pins.members : null;
    const rows = pins
      ? pins.map((pin) => ({ id: pin && pin.member, tree: text(pin && pin.tree), commit: text(pin && pin.commit), ok: !pin || pin.ok !== false, why: text(pin && pin.why) }))
      : (Array.isArray(lane.members) ? lane.members : []).map((member) => {
          const pin = member && member.pin && typeof member.pin === "object" ? member.pin : null;
          return {
            id: member && member.id != null ? member.id : "?",
            tree: text(member && (member.worktree || member.tree)),
            commit: text(pin && pin.commit),
            ok: Boolean(pin && text(pin.commit)),
            why: "",
          };
        });
    const items = [];
    const unpinned = [];
    for (const row of rows) {
      // A pin that was READ and answered `ok: false` is not a pin: the commit may resolve while the file it claimed
      // does not, and merging it would land a lane whose content the panel could not name.
      if (!row.ok || !row.commit || !row.tree) {
        unpinned.push({ text: `${label} #${row.id == null ? "?" : row.id}`, why: row.why });
        continue;
      }
      items.push({ stage: `${label} #${row.id}`, branch: row.tree, commit: row.commit });
    }
    return { label, items, unpinned };
  });
  const unpinned = perLane.flatMap((lane) => lane.unpinned);
  if (unpinned.length) {
    const first = unpinned[0];
    return refuse(
      "wave-join-input",
      `${unpinned.map((row) => row.text).join(", ")} ${unpinned.length === 1 ? "has" : "have"} no pin that reads${first.why ? `: ${first.why}` : " - no commit and no tree were named"} - a lane is merged by the commit it settled at, never by the branch it happens to carry (lib/stage-pin.js rule 1)`,
    );
  }
  const empty = perLane.filter((lane) => !lane.items.length).map((lane) => lane.label);
  if (empty.length) {
    return refuse("wave-join-input", `${empty.join(", ")} ${empty.length === 1 ? "names" : "name"} nothing that ran, so ${empty.length === 1 ? "it cannot" : "they cannot"} be named in the join`);
  }
  const branches = perLane.flatMap((lane) => lane.items);
  const message = aggregateMessage({ id: waveId }, { join: waveId }, branches, base);
  let result;
  try {
    result = aggregate({ tree: where, base, branches, message, at });
  } catch (error) {
    return refuse("wave-join", `the aggregate threw: ${String((error && error.message) || error)}`);
  }
  const wrote =
    result && result.ok && result.merged
      ? aggregateRecord({ commit: result.commit, base, branches, at, tree: { path: where }, verified: Boolean(result.verified) })
      : null;
  return {
    ok: Boolean(result && result.ok),
    code: (result && result.code) || null,
    merged: Boolean(result && result.merged),
    alreadyMerged: Boolean(result && result.alreadyMerged),
    commit: (result && result.commit) || null,
    tree: (result && result.tree) || null,
    written: (result && result.written) || null,
    verified: Boolean(result && result.verified),
    conflicts: result && Array.isArray(result.conflicts) ? result.conflicts : [],
    parents: result && Number.isFinite(result.parents) ? result.parents : null,
    checkedOut: Boolean(result && result.checkedOut),
    wave: waveId,
    lanes: perLane.map((lane) => lane.label),
    branches,
    message,
    record: wrote,
    reason: (result && result.reason) || null,
  };
}

// ---- the fold -----------------------------------------------------------------------------------------------------
/**
 * A wave's state, DERIVED on every read: no wave record carries one, and storing this answer would be the snapshot
 * the design forbids.
 *
 * The order is the design's, with one clause the reader's acceptance adds: a RUNNING member outranks a met exit
 * gate. A wave must never read done or closed while a member is still running, so `running` and `blocked` are
 * settled first; the design's own table already says blocked means "a member is parked and none is running".
 *
 * THE LANES ADD EXACTLY TWO CLAUSES, both about whether a close can be named: a lane set two of whose lanes hold one
 * tree cannot be isolated, so the wave is blocked on a fact about the record (not on a reader's blindness); and a
 * wave that holds two or more lanes and has met its exit gate still cannot close when a lane cannot be named, so it
 * answers cannot tell. A wave of one implicit lane takes neither clause and folds exactly as it did before lanes.
 */
export function deriveWaveState({ wave, members = [], readGate = readWaveGate, evidenceFor = null, lanes = null, readLane = readWaveLane } = {}) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return { state: "empty", why: "no task names this wave" };
  // A RUNNING member holds the wave whatever the gate says, and an abandoned member cannot dodge that: a task that
  // is still running has not stopped, and the reader's acceptance is that a wave never closes under a live run.
  const running = list.filter((m) => m.state === "running");
  if (running.length) return { state: "running", why: `${idsOf(running)} ${running.length === 1 ? "is" : "are"} running` };
  // A parked member blocks UNLESS a person abandoned it for a named reason: that park is over by decision, and the
  // exit gate below is the read that says whether the wave may close.
  const parked = list.filter((m) => m.state === "parked" && !namedAbandon(m));
  if (parked.length) return { state: "blocked", why: `${idsOf(parked)} ${parked.length === 1 ? "is" : "are"} parked` };
  // The lane set is the caller's when it already read one, and derived here otherwise: one fold, one lane set, so a
  // state and the lanes drawn beside it are never two different answers.
  const set = lanes && Array.isArray(lanes.lanes) ? lanes : waveLanes(list, { readLane });
  if (set.refused) return { state: "blocked", why: set.refused.why };
  // A WAVE THAT NAMES NO EXIT GATE CLOSES ON ITS MEMBERSHIP. A gate nobody authored must never be required: when
  // every member is closed - `done`, or `abandoned` for a reason a person wrote - the wave's work is finished, and
  // reading it `ready` forever is what left a finished wave waiting for a press while the next one never came (the
  // reader's own report). A BARE abandonment closes nothing (it is a status word, not a decision). The lane set is read
  // first, deliberately: a wave whose commits cannot be told apart is still the reader's to repair, and closing it here
  // would hide a defect that reopening it would show again.
  if (!wave || !wave.exitGate) {
    const open = list.filter(waveMemberOpen);
    if (!open.length) {
      const closed = list.filter((m) => m.state === "done").length;
      const abandoned = list.length - closed;
      const tail = abandoned ? `, ${abandoned} abandoned for a named reason` : "";
      return {
        state: "done",
        why: `no exit gate is named, and every member is closed: ${closed} done${tail} - the wave closes on its membership`,
      };
    }
  }
  if (wave && wave.exitGate) {
    const exit = readGate(wave.exitGate, list, evidenceFor);
    // A CLOSED EXIT CLOSES THE WAVE even with a member still queued: the design says a wave can exit on a merged PR
    // while one member is queued for a follow-up (docs/reports/waves-of-work.html, the derived state table). What it
    // can never do is close while a member is RUNNING - that clause is settled above, and it is the reader's own
    // acceptance for this slice. An exit closed by a named abandonment says so, and says which member and why.
    if (exit.closed && exit.state === "abandoned") return { state: "abandoned", why: `the exit gate closed as abandoned: ${exit.why}` };
    if (exit.met) {
      // A wave that holds lanes closes by joining them, so a lane it cannot name is a close it cannot make. This is
      // cannot tell, not blocked: nothing on the record says the lane failed, the panel just cannot read what it ran in.
      const blind = set.joinOwed ? set.lanes.filter((lane) => !lane.read || !lane.read.ok) : [];
      if (blind.length) {
        return {
          state: "unknown",
          why: `the exit gate reads met, but ${blind
            .map((lane) => (lane.read && lane.read.why) || `lane ${lane.label} cannot be read`)
            .join("; ")} - a wave that holds lanes joins them in one commit, so it cannot close on a lane set it cannot name`,
        };
      }
      const joined = set.joinOwed ? `; its ${set.count} lanes can each be named, so the close is one join` : "";
      return { state: "done", why: `the exit gate reads met: ${exit.why}${joined}` };
    }
  }
  if (!wave || !wave.entryGate) return { state: "ready", why: "there is no entry gate, so the wave opens by hand" };
  const entry = readGate(wave.entryGate, list, evidenceFor);
  if (entry.met) return { state: "ready", why: `the entry gate reads met: ${entry.why}` };
  if (entry.cannotTell) return { state: "unknown", why: `the entry gate cannot be read: ${entry.why}` };
  return { state: "unentered", why: `the entry gate reads not met: ${entry.why}` };
}

// ---- the auto switch ----------------------------------------------------------------------------------------------
// ONE SWITCH PER WAVE, DEFAULT OFF, EVALUATED ON A READ AND NOWHERE ELSE.
//
// `auto` is authored on the wave record and `pickWave` keeps only a real boolean `true`. When it is ON, this wave
// may open the NEXT wave in the initiative's position order - not a member, not a tree, and never itself. The
// question it answers is narrow: has THIS wave closed on evidence a reader can go and look at? So the read below
// consults the PREVIOUS wave's own exit gate answer, which `waveView` already made against the live evidence for
// this read (lib/wave-evidence.js through `evidenceFor`). There is no second read and no status word: the record's
// `auto` says only "may I", and the gate's met says "may I now".
//
// A CANNOT-TELL GATE BLOCKS. So does a gate that reads not met, an exit closed as abandoned (a decision about the
// work, not a landing), and a wave that still reads running, blocked or unknown: a successor never opens under a wave
// that has not closed, however green its gate is. That last clause is the fold's own - deriveWaveState holds a wave
// open while a member runs - and this read applies it rather than going around it.
//
// A WAVE WITH NO EXIT GATE IS NOT A WAVE THAT CAN NEVER OPEN THE NEXT ONE. It closes on its membership (every member
// done, or abandoned for a named reason - deriveWaveState), and once it reads done its switch opens the next wave
// exactly like a gated close. The gate nobody authored is never required; the membership is the evidence.
//
// WHAT A PERSON IS TOLD. Every record carries `surface`: the one sentence the lane draws when there is something for
// the reader to do and no switch will do it. Auto off under a closed wave says "W1 done, W2 ready - press to open";
// a next wave with no cards says "W2 has no members - file its tasks"; an entry gate that has not opened says so in
// its own words. `surface` is null when there is nothing to press.
//
// WHERE THE READ HAPPENS, EXACTLY: `waveLane` calls `waveAutoOpens` once per initiative, and `waveLane` is what
// GET /api/waves (routes/waves.js) and the board's GET /api/initiatives (routes/initiatives.js) both call. Those are
// the only two callers in the panel. If nobody is looking, NOTHING OPENS: there is no scheduler, no cron and no
// timer here, and this row adds none. The next read is the next evaluation, and its answer is that read's answer - an
// open is a fact about the read, not a row written somewhere that a later read would believe.
//
// NOTHING IS STORED. The answer rides on the wave VIEW as `autoOpen`, and `pickWave` has no field to hold it: a reader
// who writes `openedBy` or `openedAt` into waves.json is not read, exactly like a hand-written `state`.
//
// AN AUTO-OPENED WAVE INHERITS NOTHING. Its own `auto` is whatever its record says - absent is false - so opening
// wave 2 does not open wave 3, and switching wave 1's auto back off shuts wave 2 on the very next read. The record
// `autoOpen` carries is the answer for that read: `open` (did a switch open this wave), `by` ("auto" or "hand"),
// `from` (the wave whose switch was read, null for the first), `switchOn` (was that switch on), `gate` (that wave's
// exit gate answer, the one the lane draws beside it) and `why` (the sentence a reader acts on).
export const WAVE_AUTO_BY = Object.freeze(["auto", "hand"]);

const handOpened = (why, { from = null, switchOn = false, gate = null, surface = null } = {}) => ({ open: false, by: "hand", from, switchOn, gate, surface, why });

// The lane's name for a wave in a sentence: its position in the sequence, which is what the reader counts by, and the
// id only as a fallback for a view a caller built without one.
const waveLabel = (view) => {
  const position = Number(view && view.position);
  if (Number.isFinite(position) && position > 0) return `W${position}`;
  return String((view && view.id) || "") || "this wave";
};

/**
 * The one sentence a person is owed when a closed wave's successor will not open by itself. Read off the same views
 * the lane draws, so it cannot disagree with the state beside it, and null when there is nothing to press.
 */
function autoSurface(view, previous) {
  if (!previous || previous.state !== "done") return null;
  const before = waveLabel(previous);
  const here = waveLabel(view);
  const state = String((view && view.state) || "");
  if (state === "empty") return `${before} done, ${here} has no members - file its tasks`;
  if (state === "running" || state === "done" || state === "abandoned") return null;
  if (previous.auto === true) return null;
  if (state === "ready") return `${before} done, ${here} ready - press to open`;
  if (state === "unentered") return `${before} done, ${here} waits on its entry gate - ${view.stateWhy || "the entry gate reads not met"}`;
  if (state === "unknown") return `${before} done, ${here}'s entry gate cannot be read - ${view.stateWhy || "no reason was given"}`;
  if (state === "blocked") return `${before} done, ${here} is blocked - ${view.stateWhy || "a member is parked"}`;
  return null;
}

/**
 * Derive, for every wave in position order, whether a switch opened it. Pure: it reads the views a caller already
 * folded (`state`, `stateWhy`, `auto`, `gates.exit`), so the gate answer it judges is the SAME answer drawn on the
 * lane - one live read, never a second opinion.
 *
 * The first wave has no predecessor, so nothing can open it but a person. Every later wave reads the wave before it:
 * switch off means the gate is not consulted at all, and a switch on is answered by that wave's exit gate, which must
 * read met, and by that wave's own state, which must read done. A wave with no exit gate answers that second question
 * with its membership instead - done is done, and the close is what the switch reads.
 *
 * Every record carries `surface` as well: the sentence a reader acts on when nothing will open the next wave, or null.
 */
export function waveAutoOpens(views = []) {
  const list = Array.isArray(views) ? views.filter((view) => view && typeof view === "object") : [];
  return list.map((view, index) => {
    const id = String(view.id || "");
    const previous = index > 0 ? list[index - 1] : null;
    if (!previous) {
      return handOpened(`${id || "the first wave"} is first in this initiative's sequence, and no earlier wave's switch can open it: a person opens it`);
    }
    const from = String(previous.id || "");
    const exit = previous.gates && previous.gates.exit && typeof previous.gates.exit === "object" ? previous.gates.exit : null;
    const surface = autoSurface(view, previous);
    if (previous.auto !== true) {
      // The default, and it is not a lesser case: a wave with no switch never opens the next one, even when its exit
      // gate reads met, and the sentence says so rather than leaving the reader to infer it.
      return handOpened(`${from} has auto off, so it never opens ${id} whatever its exit gate reads: a person opens it`, { from, gate: exit, surface });
    }
    if (!exit || exit.state === "none") {
      // NO GATE NOBODY AUTHORED. The wave closes on its membership, so a done wave is a closed wave and the switch is
      // answered by that close; a wave that has not closed yet still never opens its successor.
      if (previous.state === "done") {
        return {
          open: true,
          by: "auto",
          from,
          switchOn: true,
          gate: exit,
          surface,
          why: `${from} names no exit gate, and every member is closed, so it reads done on membership; its switch is on, so ${id} opened by itself on this read - nothing was started, and its own gates are read and drawn beside it`,
        };
      }
      return handOpened(
        `${from} has auto on, but it names no exit gate and still reads ${previous.state || "no state"}: ${id} stays shut - a successor never opens under a wave that has not closed`,
        { from, switchOn: true, gate: exit, surface },
      );
    }
    if (exit.met !== true) {
      const answer = exit.cannotTell
        ? "cannot be read"
        : exit.state === "abandoned"
          ? "closed as abandoned, which is a decision about the work and not a landing"
          : "reads not met";
      // A cannot-tell gate is named as blindness, with the evidence reader's own sentence: "nothing opened" and "the
      // panel could not see" are different facts, and the reader is told which one this was.
      return handOpened(`${from} has auto on, but its exit gate ${answer}: ${id} stays shut - ${exit.why || "no reason was given"}`, { from, switchOn: true, gate: exit, surface });
    }
    if (previous.state !== "done") {
      // A met exit is necessary and not enough. The fold keeps a wave open while a member runs (or a park holds it),
      // and a successor must not overtake a run the previous wave still holds.
      return handOpened(
        `${from} has auto on and its exit gate reads met, but ${from} still reads ${previous.state || "no state"}: ${previous.stateWhy || "no reason was given"} - a successor never opens under a wave that has not closed`,
        { from, switchOn: true, gate: exit, surface },
      );
    }
    return {
      open: true,
      by: "auto",
      from,
      switchOn: true,
      gate: exit,
      surface,
      why: `${from} has auto on and its exit gate reads met (${exit.why || "no reason was given"}), so ${id} opened by itself on this read - nothing was started, and its own gates are read and drawn beside it`,
    };
  });
}

// ---- one member, as the lane draws it ------------------------------------------------------------------------------
// A member is a TASK, so every field here is the row's own: its state, the project and tree it names, the thread it
// is on, the pipeline it carries, and the abandonment a person recorded. The board row is the display beside it
// (dirty count, commits ahead, verdict, PR); `hasRow` is what makes "cannot tell" possible for a gate that needs
// one. The stored PR word is passed through so the lane can draw it - the GATE never reads it (readWaveGate takes
// the live evidence from lib/wave-evidence.js instead).
//
// `key` is how the caller's evidence map finds this member: the task id plus its tree, normalised the same way on
// both sides (lib/wave-evidence.js `collectWaveEvidence` uses this function, never its own copy of the rule).
export function waveMemberKey(task) {
  const id = Number(task?.id);
  const tree = String(task?.worktree || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return `${Number.isFinite(id) && id > 0 ? id : "?"}@${tree}`;
}

function abandonedOf(task) {
  const raw = task?.abandoned;
  const reason = typeof raw === "string" ? raw : String(raw && raw.reason ? raw.reason : "");
  const cleaned = reason.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return { reason: clip(cleaned, 600), at: raw && typeof raw === "object" ? raw.at || null : null, by: raw && typeof raw === "object" ? raw.by || null : null };
}

/**
 * Stamp the assistant a queue row came from onto the row itself.
 *
 * EVERY ASSISTANT NUMBERS ITS OWN QUEUE FROM ONE, so a task id alone cannot name the list it lives in - `#309` is a
 * different piece of work in Assistant #1's file and in Assistant #3's. The queue file is per assistant (the directory
 * names the owner), so the owner is only known where the queues are flattened for a wave read; this stamps it before
 * the fold, and `waveMember` carries it on. Three fields, because the lane needs to name the owner (chip), open its
 * queue (the id) and draw the same tag the worktree column draws (the role label).
 *
 * Pure and idempotent: a row that already names its owner is kept as it is, so a caller that hands the view rows it
 * has already stamped (`boardTasks`) cannot rewrite them with a second opinion.
 */
export function taskWithOwner(task, rec, label = "") {
  if (!isObject(task)) return task;
  const id = String(rec?.id || "").trim();
  if (!id || String(task.assistantId || "").trim()) return task;
  return {
    ...task,
    assistantId: id,
    assistantName: String(rec?.name || id).trim(),
    assistantLabel: String(label || "").replace(/\s+/g, " ").trim(),
  };
}

export function waveMember(task, row = null) {
  const taskRow = isObject(task?.row) ? task.row : null;
  const pr = isObject(taskRow?.pr) ? taskRow.pr : isObject(row?.pr) ? row.pr : null;
  const state = String(task?.state || "");
  return {
    id: Number.isFinite(Number(task?.id)) && Number(task.id) > 0 ? Number(task.id) : null,
    key: waveMemberKey(task),
    title: clip(String(task?.title ?? "").replace(/\s+/g, " ").trim(), WAVE_TITLE_MAX),
    // WHO OWNS THE ROW, carried from the queue it was read out of (taskWithOwner above). A member whose row names no
    // owner still draws - the bar keeps its title and its state - it just cannot open a queue it cannot name.
    assistantId: String(task?.assistantId || "").trim() || null,
    assistantName: clip(String(task?.assistantName || "").replace(/\s+/g, " ").trim(), 80) || null,
    assistantLabel: clip(String(task?.assistantLabel || "").replace(/\s+/g, " ").trim(), 80) || null,
    state: TASK_STATES.includes(state) ? state : "queued",
    // A NAMED abandonment is a decision, not one of the queue's four states: the lane draws it in place of the state
    // word (the state the row happens to be in no longer describes the work), and the exit gate closes as abandoned.
    abandoned: abandonedOf(task),
    project: String(task?.project || row?.project || "").trim() || null,
    worktree: String(task?.worktree || "").trim() || null,
    thread: String(task?.thread || "").trim() || null,
    // THE LANE IS THE MEMBER'S OWN WORD, when it has one: a wave never stores a lane list, so the only place a lane can
    // be named is the row that runs in it. A member that names none is grouped by the files it claims (waveLanes), and
    // `files` is carried here because that grouping and the stage pin both read it.
    lane: waveLaneNamed(task),
    files: (Array.isArray(task?.files) ? task.files : []).map((f) => String(f).trim()).filter(Boolean).slice(0, TASK_FILES_MAX),
    // The pipeline the TASK names, if any. A wave template is inherited only when this is null; see waveView.
    pipeline: String(task?.pipelineRun?.pipeline || "").trim() || null,
    pr: pr
      ? {
          number: Number(pr.number) > 0 ? Number(pr.number) : null,
          state: String(pr.state || "").trim() || null,
        }
      : null,
    hasRow: Boolean(row),
    dirty: Number.isFinite(Number(row?.dirty)) ? Number(row.dirty) : null,
    ahead: Number.isFinite(Number(row?.ahead)) ? Number(row.ahead) : null,
    verdict: row?.verdict ? String(row.verdict) : null,
  };
}

// ---- one wave, as the lane draws it --------------------------------------------------------------------------------
/**
 * Fold one wave with its members. Pure: the members and the gate read are arguments, so a test can answer every state
 * without a server, a queue file or a clock.
 */
export function waveView({ wave, members = [], readGate = readWaveGate, evidenceFor = null, templateExists = null } = {}) {
  const record = wave && typeof wave === "object" ? wave : null;
  if (!record) return null;
  const list = (Array.isArray(members) ? members : []).slice(0, WAVE_MEMBERS_MAX);
  // A task that names no pipeline of its own INHERITS the wave's template. A task that names one keeps it: the
  // reader's first decision is that a wave names a template its tasks inherit and a task may name its own.
  const withTemplate = list.map((m) => ({
    ...m,
    pipeline: m.pipeline || record.template || null,
    pipelineFrom: m.pipeline ? "task" : record.template ? "wave" : null,
  }));
  // The lane set is read ONCE here and handed to the fold, so the lanes drawn beside a state are the lanes that state
  // was folded from. A wave record never carries this: it is derived from the members on every read.
  const lanes = timeSync("wave.lanes", () => waveLanes(withTemplate));
  const derived = timeSync("wave.state", () => deriveWaveState({ wave: record, members: withTemplate, readGate, evidenceFor, lanes }));
  // Both chips read the SAME evidence a gate decision reads: the entry chip and the fold cannot disagree about a
  // gate, because they are one call to the same reader with the same argument.
  const entry = record.entryGate ? readGate(record.entryGate, withTemplate, evidenceFor) : noneGate("no entry gate - this wave opens by hand");
  const exit = record.exitGate ? readGate(record.exitGate, withTemplate, evidenceFor) : noneGate("no exit gate - this wave closes when every member is closed");
  return {
    id: record.id,
    initiativeId: record.initiativeId,
    position: record.position,
    title: record.title,
    template: record.template,
    // A name the bundle no longer holds reads unresolved, never null. A caller that has no bundle read to give
    // passes no templateExists and the lane says it could not check, rather than claiming either answer.
    templateResolved: record.template
      ? timeSync("wave.template", () => (typeof templateExists === "function" ? Boolean(templateExists(record.template)) : null))
      : null,
    auto: record.auto === true,
    entryGate: record.entryGate ? { ...record.entryGate } : null,
    exitGate: record.exitGate ? { ...record.exitGate } : null,
    gates: { entry, exit },
    state: derived.state,
    stateWord: WAVE_STATE_WORDS[derived.state] || derived.state,
    stateWhy: derived.why,
    // The lanes, derived: `implicit` is the one lane a wave with no lane of its own holds (today's wave), `joinOwed`
    // says a close is a join, and `laneRefused` is the sentence when two lanes hold one tree.
    lanes: lanes.lanes,
    laneCount: lanes.count,
    laneImplicit: lanes.implicit,
    laneJoinOwed: lanes.joinOwed,
    laneIsolation: lanes.isolation,
    laneRefused: lanes.refused ? lanes.refused.why : null,
    members: withTemplate,
  };
}

// Which wave is CURRENT is derived too - the lowest-position running wave, else the lowest-position ready one, else
// the lowest-position unentered one. A display rule with a stated order, not a field anybody can forget to update.
export function currentWaveId(waves = []) {
  const list = Array.isArray(waves) ? waves : [];
  for (const state of ["running", "ready", "unentered"]) {
    const found = list
      .filter((w) => w && w.state === state)
      .sort((a, b) => Number(a.position) - Number(b.position) || String(a.id).localeCompare(String(b.id)))[0];
    if (found) return found.id;
  }
  return null;
}

/**
 * One initiative's lane: its waves in position order, each with its members, its derived state and its gate reads.
 * `tasks` is every assistant's queue rows, not only the ones on this initiative's trees: membership is the task's
 * own waveId, and that is exactly what lets a wave span projects. A task with no waveId is in no wave at all - it is
 * never defaulted into the first one.
 *
 * The AUTO SWITCH is evaluated here and nowhere else (see `waveAutoOpens` above): every wave carries `autoOpen` for
 * this read, which names the predecessor whose exit gate was read and says whether a switch opened it. An auto-opened
 * wave keeps the switch its own record carries - absent is false - so nothing cascades.
 */
export function waveLane({ waves, initiativeId, tasks = [], rowFor = () => null, templateExists = null, evidenceFor = null } = {}) {
  const id = String(initiativeId || "");
  if (!waves || typeof waves.wavesFor !== "function") return { waves: [], skipped: [], currentId: null };
  const buckets = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const waveId = String(task?.waveId ?? "");
    if (!waveId) continue;
    const bucket = buckets.get(waveId) || [];
    if (bucket.length >= WAVE_MEMBERS_MAX) continue;
    const row = task?.worktree ? rowFor(String(task.project || ""), task.worktree) : null;
    bucket.push(waveMember(task, row));
    buckets.set(waveId, bucket);
  }
  const list = waves
    .wavesFor(id)
    .slice(0, WAVES_MAX)
    .map((wave) => waveView({ wave, members: buckets.get(wave.id) || [], templateExists, evidenceFor }))
    .filter(Boolean);
  // THE ONE PLACE THE AUTO SWITCH IS EVALUATED. Each view already carries its own exit gate answer, made above
  // against the live evidence for this read, so the predecessor's answer is judged here rather than read again. No
  // store write, no timer, no advance: these are the two routes' answers for this request, and the next request asks
  // again. See the section above for the four rules and for what happens when nobody reads.
  const opens = waveAutoOpens(list);
  const drawn = list.map((view, index) => ({ ...view, autoOpen: opens[index] }));
  return {
    waves: drawn,
    skipped: typeof waves.skippedFor === "function" ? waves.skippedFor(id) : [],
    currentId: currentWaveId(drawn),
  };
}
