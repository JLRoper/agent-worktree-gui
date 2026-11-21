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
//      blocks: a gate never passes because a member said so or because a status word was written once.
//
// THE STORE IS A SIBLING OF initiatives.json, keyed by initiative id, so an initiative write never rewrites a wave
// and a wave write never rewrites the initiative document. It copies the initiative store's one write rule even
// though this slice ships no write route: a file that exists and cannot be read is REFUSED with its sentence and
// its path (`readable: false`), never overwritten, so the reader can salvage it. A missing file is the ordinary
// first run - zero waves, not an error.
//
// ONE BAD WAVE IS ONE WAVE THE TAB DOES NOT DRAW, WITH ITS SENTENCE (`skipped`), never the whole file refused: waves
// are a list a reader edits one record at a time, unlike the bundle's whole-or-nothing import.
import { existsSync, readFileSync, statSync } from "node:fs";

import { EXIT_PARAM_SPEC, EXIT_CHECKS } from "./pipelines.js";
import { TASK_CAP, TASK_STATES } from "./assistant/queue.js";

export const WAVES_VERSION = 1;
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

// The derived states. Never stored: `state` on a wave view is this fold's answer for that read, and the record on
// disk has no field to disagree with it.
export const WAVE_STATES = ["empty", "unentered", "unknown", "ready", "running", "blocked", "done"];
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
function pickWave(raw, key) {
  if (!isObject(raw)) return { error: "a wave is an object" };
  const id = String(raw.id ?? "").trim();
  if (!id) return { error: "a wave needs an id" };
  if (id.length > WAVE_ID_MAX) return { error: `the id is longer than ${WAVE_ID_MAX} characters` };
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
    },
  };
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
    return list.map((wave) => ({
      ...wave,
      entryGate: wave.entryGate ? { ...wave.entryGate } : null,
      exitGate: wave.exitGate ? { ...wave.exitGate } : null,
    }));
  }

  waveById(id) {
    this.load();
    const wanted = String(id || "");
    for (const list of Object.values(this.doc.byInitiative)) {
      const found = list.find((wave) => wave.id === wanted);
      if (found) return { ...found };
    }
    return null;
  }

  // The records the loader refused, one sentence each, for the initiative the tab is drawing.
  skippedFor(initiativeId) {
    this.load();
    const id = String(initiativeId || "");
    return this.skipped.filter((row) => row.initiativeId === id || row.initiativeId === null);
  }
}

// ---- the gate read ------------------------------------------------------------------------------------------------
// The checks this slice can READ today, and the row fact each one asks. Everything else in the vocabulary reads
// `unknown`: the panel validates those names (lib/pipelines.js) and has no evaluator for them yet, and a slice that
// claimed otherwise would be a gate that passes because nothing looked.
//
// Where the evidence is a MEMBER, every member must have something to say. One member with no board row and no PR
// makes the answer "cannot tell" rather than "not met": the work's state and the reader's ability to see it are
// different facts, and the design keeps different words for them.
const PR_CLOSED = /^(DECLINED|CLOSED)$/i;
const PR_MERGED = /^MERGED/i;

const unmet = (check, why) => ({ check, state: "unmet", met: false, cannotTell: false, why });
const met = (check, why) => ({ check, state: "met", met: true, cannotTell: false, why });
const cannotTell = (check, why) => ({ check, state: "unknown", met: false, cannotTell: true, why });
const noneGate = (why) => ({ check: null, state: "none", met: false, cannotTell: false, why });

const idsOf = (list) => list.map((m) => `#${m.id}`).join(", ");

/**
 * One live read of a gate against the wave's members. Answers met / unmet / cannot tell, never throws, and never
 * reads a stored word: the row facts and the PR state are the arguments.
 */
export function readWaveGate(gate, members = []) {
  if (!gate || !gate.check) return noneGate("no gate is named");
  const check = gate.check;
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return noneGate(`${check} has no member to read`);
  const blind = list.filter((m) => !m.hasRow);
  switch (check) {
    case "clean": {
      if (blind.length) return cannotTell(check, `no board row for ${idsOf(blind)}, so the dirty count cannot be read`);
      const dirty = list.filter((m) => Number(m.dirty) > 0);
      if (dirty.length) return unmet(check, `${idsOf(dirty)} hold dirty work`);
      return met(check, "every member's tree is clean");
    }
    case "commits": {
      if (blind.length) return cannotTell(check, `no board row for ${idsOf(blind)}, so the commits ahead cannot be read`);
      const min = Number(gate.min) > 0 ? Number(gate.min) : 1;
      const short = list.filter((m) => !(Number(m.ahead) >= min));
      if (short.length) return unmet(check, `${idsOf(short)} are not ${min} commit${min === 1 ? "" : "s"} ahead of the base`);
      return met(check, `every member is at least ${min} commit${min === 1 ? "" : "s"} ahead`);
    }
    case "pr-open": {
      const noPr = list.filter((m) => !m.pr || !m.pr.state);
      if (noPr.length) return cannotTell(check, `${idsOf(noPr)} name no pull request, so there is nothing to read`);
      const closed = list.filter((m) => PR_CLOSED.test(String(m.pr.state)));
      if (closed.length) return unmet(check, `${idsOf(closed)} read ${closed.map((m) => m.pr.state).join(", ")}`);
      return met(check, "every member names a pull request");
    }
    case "pr-merged": {
      const noPr = list.filter((m) => !m.pr || !m.pr.state);
      if (noPr.length) return cannotTell(check, `${idsOf(noPr)} name no pull request, so merging cannot be confirmed`);
      const open = list.filter((m) => !PR_MERGED.test(String(m.pr.state)));
      if (open.length) return unmet(check, `${idsOf(open)} read ${open.map((m) => m.pr.state).join(", ")}, not MERGED`);
      return met(check, "every member's pull request is MERGED");
    }
    default:
      return cannotTell(check, `no evaluator reads "${check}" yet - the name is validated, not run (lib/pipelines.js)`);
  }
}

// ---- the fold -----------------------------------------------------------------------------------------------------
/**
 * A wave's state, DERIVED on every read: no wave record carries one, and storing this answer would be the snapshot
 * the design forbids.
 *
 * The order is the design's, with one clause the reader's acceptance adds: a RUNNING member outranks a met exit
 * gate. A wave must never read done or closed while a member is still running, so `running` and `blocked` are
 * settled first; the design's own table already says blocked means "a member is parked and none is running".
 */
export function deriveWaveState({ wave, members = [], readGate = readWaveGate } = {}) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return { state: "empty", why: "no task names this wave" };
  const running = list.filter((m) => m.state === "running");
  if (running.length) return { state: "running", why: `${idsOf(running)} ${running.length === 1 ? "is" : "are"} running` };
  const parked = list.filter((m) => m.state === "parked");
  if (parked.length) return { state: "blocked", why: `${idsOf(parked)} ${parked.length === 1 ? "is" : "are"} parked` };
  if (wave && wave.exitGate) {
    const exit = readGate(wave.exitGate, list);
    // A MET EXIT CLOSES THE WAVE even with a member still queued: the design says a wave can exit on a merged PR
    // while one member is queued for a follow-up (docs/reports/waves-of-work.html, the derived state table). What it
    // can never do is close while a member is RUNNING - that clause is settled above, and it is the reader's own
    // acceptance for this slice.
    if (exit.met) return { state: "done", why: `the exit gate reads met: ${exit.why}` };
  }
  if (!wave || !wave.entryGate) return { state: "ready", why: "there is no entry gate, so the wave opens by hand" };
  const entry = readGate(wave.entryGate, list);
  if (entry.met) return { state: "ready", why: `the entry gate reads met: ${entry.why}` };
  if (entry.cannotTell) return { state: "unknown", why: `the entry gate cannot be read: ${entry.why}` };
  return { state: "unentered", why: `the entry gate reads not met: ${entry.why}` };
}

// ---- one member, as the lane draws it ------------------------------------------------------------------------------
// A member is a TASK, so every field here is the row's own: its state, the project and tree it names, the thread it
// is on, the pipeline it carries. The board row is the evidence beside it (dirty count, commits ahead, verdict, PR),
// passed in by the caller; `hasRow` is what makes "cannot tell" possible for a gate that needs one.
export function waveMember(task, row = null) {
  const taskRow = isObject(task?.row) ? task.row : null;
  const pr = isObject(taskRow?.pr) ? taskRow.pr : isObject(row?.pr) ? row.pr : null;
  const state = String(task?.state || "");
  return {
    id: Number.isFinite(Number(task?.id)) && Number(task?.id) > 0 ? Number(task.id) : null,
    title: clip(String(task?.title ?? "").replace(/\s+/g, " ").trim(), WAVE_TITLE_MAX),
    state: TASK_STATES.includes(state) ? state : "queued",
    project: String(task?.project || row?.project || "").trim() || null,
    worktree: String(task?.worktree || "").trim() || null,
    thread: String(task?.thread || "").trim() || null,
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
export function waveView({ wave, members = [], readGate = readWaveGate, templateExists = null } = {}) {
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
  const derived = deriveWaveState({ wave: record, members: withTemplate, readGate });
  const entry = record.entryGate ? readGate(record.entryGate, withTemplate) : noneGate("no entry gate - this wave opens by hand");
  const exit = record.exitGate ? readGate(record.exitGate, withTemplate) : noneGate("no exit gate - a person closes this wave");
  return {
    id: record.id,
    initiativeId: record.initiativeId,
    position: record.position,
    title: record.title,
    template: record.template,
    // A name the bundle no longer holds reads unresolved, never null. A caller that has no bundle read to give
    // passes no templateExists and the lane says it could not check, rather than claiming either answer.
    templateResolved: record.template ? (typeof templateExists === "function" ? Boolean(templateExists(record.template)) : null) : null,
    auto: record.auto === true,
    entryGate: record.entryGate ? { ...record.entryGate } : null,
    exitGate: record.exitGate ? { ...record.exitGate } : null,
    gates: { entry, exit },
    state: derived.state,
    stateWord: WAVE_STATE_WORDS[derived.state] || derived.state,
    stateWhy: derived.why,
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
 */
export function waveLane({ waves, initiativeId, tasks = [], rowFor = () => null, templateExists = null } = {}) {
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
    .map((wave) => waveView({ wave, members: buckets.get(wave.id) || [], templateExists }))
    .filter(Boolean);
  return {
    waves: list,
    skipped: typeof waves.skippedFor === "function" ? waves.skippedFor(id) : [],
    currentId: currentWaveId(list),
  };
}
