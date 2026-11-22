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
import { TASK_CAP, TASK_FILES_MAX, TASK_LANE_MAX, TASK_STATES, intersectingFiles } from "./assistant/queue.js";
// A lane set is a fan-out (one lane, one tree, joined once), so its vocabulary and its join come from the modules that
// already own them: the aggregate's one-commit merge, its message, its record, and the isolation model a lane runs
// under. Nothing in this file restates those rules.
import { aggregateBranches } from "./pipeline-aggregate.js";
import { aggregateMessage, aggregateRecord, ISOLATION_PER_STAGE } from "./pipeline-fanout.js";

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
// The checks this slice can READ today, and the evidence each one asks. `clean` and `commits` are row facts the scan
// already measured; `pr-open`, `pr-merged` and `main-moved` are EVIDENCE reads (lib/wave-evidence.js) made on this
// request: the pull request's state through the host's API and the member's content on origin/main. Everything else
// in the vocabulary reads `unknown`: the panel validates those names (lib/pipelines.js) and has no evaluator for
// them yet, and a slice that claimed otherwise would be a gate that passes because nothing looked.
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
const noneGate = (why) => ({ check: null, state: "none", met: false, cannotTell: false, closed: false, why });

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

// The ref a main-moved gate names, from its own params. The evidence is read against the project's main; a gate that
// names another ref is not silently judged against this one (see the mismatch check below).
const mainRefOf = (gate) => `${String(gate.remote || "origin").trim() || "origin"}/${String(gate.main || "main").trim() || "main"}`;

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
  if (!list.length) return noneGate(`${check} has no member to read`);
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
  if (list.length && list.every((m) => m && (m.state === "done" || namedAbandon(m)))) return "done";
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

export function waveMember(task, row = null) {
  const taskRow = isObject(task?.row) ? task.row : null;
  const pr = isObject(taskRow?.pr) ? taskRow.pr : isObject(row?.pr) ? row.pr : null;
  const state = String(task?.state || "");
  return {
    id: Number.isFinite(Number(task?.id)) && Number(task.id) > 0 ? Number(task.id) : null,
    key: waveMemberKey(task),
    title: clip(String(task?.title ?? "").replace(/\s+/g, " ").trim(), WAVE_TITLE_MAX),
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
  const lanes = waveLanes(withTemplate);
  const derived = deriveWaveState({ wave: record, members: withTemplate, readGate, evidenceFor, lanes });
  // Both chips read the SAME evidence a gate decision reads: the entry chip and the fold cannot disagree about a
  // gate, because they are one call to the same reader with the same argument.
  const entry = record.entryGate ? readGate(record.entryGate, withTemplate, evidenceFor) : noneGate("no entry gate - this wave opens by hand");
  const exit = record.exitGate ? readGate(record.exitGate, withTemplate, evidenceFor) : noneGate("no exit gate - a person closes this wave");
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
  return {
    waves: list,
    skipped: typeof waves.skippedFor === "function" ? waves.skippedFor(id) : [],
    currentId: currentWaveId(list),
  };
}
