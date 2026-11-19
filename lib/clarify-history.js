// The CLARIFY HISTORY: every question the panel has asked the reader, kept after it settles.
//
// The job record holds ONE question and only while it is open: `clarify.settled`, a stop or the turn's own end
// nulls `j.question` and leaves `questionDone` as one line with no question text, no choices and no tree. So a
// popup that listed "every clarify question this panel has asked" from the live job store would forget a question
// the moment it was answered, and a restart would empty the list completely. This is the durable record instead.
//
// THE SHAPE OF A RECORD, and why each field is here:
//
//   seq          the identity the page sends back on a click, and the order. One number per ask, never reused.
//   key          the question's own key from lib/jobs.js (`clarify:<job>:<prompt id>`): a re-ask of the same prompt
//                updates THIS record in place, so the list cannot grow a second row for one question.
//   jobId        the turn that asked. The page reveals it with wtTurnFold.reveal, so a question from an hour ago
//                lands the reader on the turn it was asked in rather than only on the agent.
//   thread       the agent that asked; agent/tree/assistant are the three names a row carries.
//   status       open | answered | closed. "closed" is the honest third state: no answer exists because the card was
//                cancelled, timed out or withdrawn, and it must not be greyed as though it had been answered.
//   askedAt      when the prompt reached the panel. The row's age and the "cancelled after 16m" span count from here.
//   answer       what the reader actually chose, written by Jobs.noteAnswered (or the reply path) at the moment the
//                gateway accepted it, never inferred later from a repaint.
//   answeredBy   who answered. "reader" through the panel; the reply path names the surface it came through.
//   answeredAt   when. Stamped beside the answer, from the same call that closed the box.
//   closedWhy    for a closed row, why: cancelled, timed out, closed unanswered, the turn ended. The row says it.
//
// THE FILE is `clarify-history.json` beside `jobs.json` (lib/paths.js owns that spelling), never inside a checkout:
// it is state, not source. One Node process writes it, so the store is its own lock, and every write goes through a
// temp file + rename so a reader never sees half a list.
//
// A CAP IS THE ONLY BOUND. `CLARIFY_HISTORY_KEEP` rows are kept, newest first, and the oldest are forgotten on write.
// The page's own render cap (50 of the kept rows, with an honest "showing 50 of N") is a separate thing: this file
// only bounds the store, it never silent-truncates a total it reports.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CLARIFY_HISTORY_VERSION = 1;
export const CLARIFY_HISTORY_KEEP = 400;
export const CLARIFY_HISTORY_STATES = ["open", "answered", "closed"];

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const oneLine = (s, n = 400) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const isoOrNull = (v) => {
  const t = String(v || "").trim();
  if (!t) return null;
  const at = Date.parse(t);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

// The word a closed row says. Kept to the four the reader can act on, because the gateway does not tell the panel
// which of them happened: a deadline that passed is a timeout, a stopped run is a cancellation, a turn that ended
// took the waiter with it, and anything else was closed somewhere the panel cannot see.
export const CLOSED_WHYS = ["cancelled", "timed out", "closed unanswered", "the turn ended"];

export function closedWhyFor({ deadline = null, status = "", at = Date.now() } = {}) {
  const stop = new Set(["cancelled", "canceled", "stopped", "killed"]);
  const when = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const due = Number(deadline) > 0 ? Number(deadline) : 0;
  if (due && when >= due) return "timed out";
  if (stop.has(String(status || "").trim().toLowerCase())) return "cancelled";
  if (String(status || "").trim()) return "the turn ended";
  return "closed unanswered";
}

// One ask as the store keeps it. `rec` is the job record's own facts, read by Jobs when the prompt arrives; a
// missing field is null or empty, never invented.
export function clarifyHistoryEntry(rec = {}, { seq = 0, at = nowIso() } = {}) {
  const askedAt = isoOrNull(rec.askedAt) || at;
  return {
    seq: Number(seq) || 0,
    key: String(rec.key || ""),
    requestId: rec.requestId ? String(rec.requestId) : null,
    jobId: rec.jobId ? String(rec.jobId) : null,
    thread: rec.thread ? String(rec.thread) : null,
    agent: oneLine(rec.agent, 120) || String(rec.thread || "") || "an agent",
    tree: oneLine(rec.tree, 120) || "",
    treePath: rec.treePath ? String(rec.treePath).replace(/\\/g, "/") : "",
    project: rec.project ? String(rec.project) : "",
    assistantId: rec.assistantId ? String(rec.assistantId) : null,
    assistantName: oneLine(rec.assistantName, 80) || "",
    question: String(rec.question ?? ""),
    choices: (Array.isArray(rec.choices) ? rec.choices : []).map((c) => String(c)).filter((c) => c.trim()),
    multiSelect: Boolean(rec.multiSelect),
    links: Array.isArray(rec.links) ? rec.links : [],
    base: rec.base ? String(rec.base) : "",
    askedAt,
    deadline: Number(rec.deadline) > 0 ? Number(rec.deadline) : null,
    timeoutSeconds: Number(rec.timeoutSeconds) > 0 ? Number(rec.timeoutSeconds) : null,
    reasks: Math.max(0, Number(rec.reasks) || 0),
    status: "open",
    answer: "",
    answeredBy: "",
    answeredAt: null,
    closedWhy: "",
    closedAt: null,
  };
}

export class ClarifyHistory {
  constructor({ file = null, log = null, keep = CLARIFY_HISTORY_KEEP, now = () => Date.now() } = {}) {
    this.file = file ? String(file) : null;
    this.log = typeof log === "function" ? log : null;
    this.keep = Math.max(1, Number(keep) || CLARIFY_HISTORY_KEEP);
    this.now = typeof now === "function" ? now : () => Date.now();
    // Newest first. `seq` is monotonic and never re-sorted except as a defensive read, so an entry keeps the place
    // it was asked in even while a re-ask updates its text.
    this.entries = [];
    this.seq = 0;
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file || !existsSync(this.file)) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
      const list = Array.isArray(raw?.entries) ? raw.entries : [];
      this.entries = list
        .filter((e) => e && typeof e === "object" && e.key)
        .map((e) => normalizeLoaded(e))
        .sort((a, b) => Number(b.seq) - Number(a.seq))
        .slice(0, this.keep);
      this.seq = Number(raw?.seq) > 0 ? Number(raw.seq) : this.entries.reduce((n, e) => Math.max(n, Number(e.seq) || 0), 0);
    } catch (e) {
      this.entries = [];
      this.seq = 0;
      this.log?.(`clarify history: could not read ${this.file} (${String((e && e.message) || e)}); starting empty`);
    }
    return this;
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ version: CLARIFY_HISTORY_VERSION, seq: this.seq, entries: this.entries }, null, 0);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, this.file);
    } catch (e) {
      this.log?.(`clarify history: could not write ${this.file} (${String((e && e.message) || e)})`);
    }
  }

  find(key) {
    this.load();
    const k = String(key || "");
    if (!k) return null;
    return this.entries.find((e) => e.key === k) || null;
  }

  /**
   * A prompt arrived (or was re-asked). One record per key: an open question is updated where it stands, a closed
   * one that a gateway asks again is reopened at the top, and a missing one is a new row.
   */
  ask(rec = {}) {
    this.load();
    const key = String(rec.key || "").trim();
    if (!key) return null;
    const at = nowIso(this.now());
    const existing = this.find(key);
    if (existing) {
      if (existing.status === "open") {
        existing.question = String(rec.question ?? existing.question ?? "");
        if (Array.isArray(rec.choices) && rec.choices.length) existing.choices = rec.choices.map((c) => String(c)).filter((c) => c.trim());
        existing.multiSelect = rec.multiSelect == null ? existing.multiSelect : Boolean(rec.multiSelect);
        existing.links = Array.isArray(rec.links) ? rec.links : existing.links;
        existing.base = rec.base ? String(rec.base) : existing.base;
        existing.deadline = Number(rec.deadline) > 0 ? Number(rec.deadline) : existing.deadline;
        existing.timeoutSeconds = Number(rec.timeoutSeconds) > 0 ? Number(rec.timeoutSeconds) : existing.timeoutSeconds;
        existing.reasks = Math.max(existing.reasks || 0, Number(rec.reasks) || 0);
        if (rec.agent) existing.agent = oneLine(rec.agent, 120);
        if (rec.tree) existing.tree = oneLine(rec.tree, 120);
        if (rec.treePath) existing.treePath = String(rec.treePath).replace(/\\/g, "/");
        if (rec.assistantId) existing.assistantId = String(rec.assistantId);
        if (rec.assistantName) existing.assistantName = oneLine(rec.assistantName, 80);
        this.save();
        return existing;
      }
      // A settled prompt asked again with the same key: the old row cannot keep an answer this ask has not received.
      this.entries = this.entries.filter((e) => e.key !== key);
    }
    this.seq += 1;
    const entry = clarifyHistoryEntry({ ...rec, askedAt: rec.askedAt || at }, { seq: this.seq, at });
    this.entries.unshift(entry);
    if (this.entries.length > this.keep) this.entries.length = this.keep;
    this.save();
    return entry;
  }

  /** The reader answered. Written from the call that accepted the answer, so it records who and when, not a guess. */
  answered(key, { answer = "", by = "reader", at = null, via = "" } = {}) {
    this.load();
    const entry = this.find(key);
    if (!entry) return null;
    if (entry.status === "answered") return entry;
    entry.status = "answered";
    entry.answer = String(answer ?? "");
    entry.answeredBy = String(by || "reader");
    entry.answeredAt = isoOrNull(at) || nowIso(this.now());
    entry.closedWhy = "";
    entry.closedAt = entry.answeredAt;
    if (via) entry.via = String(via);
    this.save();
    return entry;
  }

  /** The prompt went away with no answer. `why` is one of CLOSED_WHYS; the row says it instead of greying. */
  closed(key, { why = "", at = null } = {}) {
    this.load();
    const entry = this.find(key);
    if (!entry || entry.status === "answered") return entry || null;
    const when = isoOrNull(at) || nowIso(this.now());
    entry.status = "closed";
    entry.closedWhy = CLOSED_WHYS.includes(String(why)) ? String(why) : "closed unanswered";
    entry.closedAt = when;
    this.save();
    return entry;
  }

  /**
   * After a restart the store can hold a row whose question nobody can answer any more. An open row survives only
   * while the job that asked is still on the board with that same prompt open; anything else is closed as cancelled
   * at the moment this pass noticed, never left saying "unanswered" about a turn that is gone.
   */
  reconcile(jobs = []) {
    this.load();
    const byJob = new Map();
    for (const j of Array.isArray(jobs) ? jobs : []) {
      if (j && j.id) byJob.set(String(j.id), j);
    }
    let changed = 0;
    const at = nowIso(this.now());
    for (const e of this.entries) {
      if (e.status !== "open") continue;
      const j = byJob.get(String(e.jobId || ""));
      const q = j && j.question && typeof j.question === "object" ? j.question : null;
      const same = q && (!e.key || String(q.key || "") === e.key);
      if (same) continue;
      e.status = "closed";
      e.closedWhy = closedWhyFor({ deadline: e.deadline, status: j?.status || "", at: this.now() });
      e.closedAt = at;
      changed += 1;
    }
    if (changed) this.save();
    return changed;
  }

  /** Newest first, with the honest total beside a page of rows. `limit` never changes what `total` reports. */
  list({ limit = null } = {}) {
    this.load();
    const all = [...this.entries].sort((a, b) => Number(b.seq) - Number(a.seq));
    const n = Number(limit);
    const rows = Number.isFinite(n) && n > 0 ? all.slice(0, Math.floor(n)) : all;
    return { entries: rows, total: all.length, kept: this.entries.length, cap: this.keep };
  }

  /** How many rows the store holds, for a journal line or a test. Never a page's render cap. */
  count() {
    this.load();
    return this.entries.length;
  }
}

// A file written by another build (or hand-edited) is read into the shape the page expects: an unknown state reads
// as closed with its own word, rather than as an answer nobody gave.
function normalizeLoaded(e) {
  const out = clarifyHistoryEntry(e, { seq: e.seq, at: isoOrNull(e.askedAt) || nowIso() });
  out.seq = Number(e.seq) || 0;
  out.status = CLARIFY_HISTORY_STATES.includes(String(e.status)) ? String(e.status) : "closed";
  out.answer = String(e.answer ?? "");
  out.answeredBy = String(e.answeredBy ?? "");
  out.answeredAt = isoOrNull(e.answeredAt);
  out.closedWhy = CLOSED_WHYS.includes(String(e.closedWhy)) ? String(e.closedWhy) : out.status === "closed" ? "closed unanswered" : "";
  out.closedAt = isoOrNull(e.closedAt) || (out.status === "closed" ? out.answeredAt : null);
  out.reasks = Math.max(0, Number(e.reasks) || 0);
  out.links = Array.isArray(e.links) ? e.links : [];
  return out;
}
