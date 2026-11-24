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
//   reask        the READER's own re-ask of a question they missed: `{ at, by, jobId, thread, sha256, chars }`, written
//                the moment the panel accepted the send and not before. It is the item's one-send record: a second
//                press finds it and sends nothing, and it names the turn the re-asked card will be asked in.
//
// THE FILE is `clarify-history.json` beside `jobs.json` (lib/paths.js owns that spelling), never inside a checkout:
// it is state, not source. One Node process writes it, so the store is its own lock, and every write goes through a
// temp file + rename so a reader never sees half a list.
//
// A CAP IS THE ONLY BOUND. `CLARIFY_HISTORY_KEEP` rows are kept, newest first, and the oldest are forgotten on write.
// The page's own render cap (50 of the kept rows, with an honest "showing 50 of N") is a separate thing: this file
// only bounds the store, it never silent-truncates a total it reports.
import { createHash } from "node:crypto";
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

// ---- the READER's re-ask: the one text a missed question is sent back with -------------------------------------
//
// The popup draws a question through `oneLine(question, 400)` (public/core/clarify-history.js `questionLine`, and the
// store's own collapseKey), so a quote built from the RENDERED line is a mutilated question: cut at 400 characters and
// with every newline collapsed to a space. A re-ask that quoted that would silently ask the agent to re-ask something
// the reader never saw. So the text is built from the STORED record (`entry.question`, `entry.choices`), and
// `reaskQuoteCheck` is the guard that refuses to send a body which does not carry the original byte for byte.
//
// The question sits inside a fenced block, NOT prefixed per line: a per-line quote marker would break the byte-for-byte
// containment this whole feature is judged on. The fence is one backtick longer than the longest run inside the
// question, so a question that itself carries a fence cannot close the block early.
export const REASK_LINE = "Can you please re-ask this clarify question if it is still valid?";

const fenceFor = (text) => {
  const runs = String(text ?? "").match(/`+/g) || [];
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
};

/**
 * The whole body of a re-ask: the line the reader's button stands for, then the question VERBATIM, then the choices it
 * carried. Empty when the record holds no question (a row from an old build may), which the caller refuses.
 */
export function reaskText(rec = {}) {
  const question = String(rec.question ?? "");
  if (!question.trim()) return "";
  const fence = fenceFor(question);
  const lines = [REASK_LINE, "", fence, question, fence];
  const choices = (Array.isArray(rec.choices) ? rec.choices : []).map((c) => String(c)).filter((c) => c.trim());
  if (choices.length) {
    lines.push("", rec.multiSelect ? "Choices (choose any):" : "Choices:", ...choices.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

/** What the sent body must contain to be a quote at all: the question's own bytes, every choice, the reader's line. */
export function reaskQuoteCheck(rec = {}, text = "") {
  const body = String(text ?? "");
  const question = String(rec.question ?? "");
  const missing = [];
  if (!question.trim()) missing.push("the question");
  else if (!body.includes(question)) missing.push("the question, byte for byte");
  if (!body.includes(REASK_LINE)) missing.push("the re-ask line");
  for (const c of Array.isArray(rec.choices) ? rec.choices : []) {
    const said = String(c);
    if (said.trim() && !body.includes(said)) missing.push(`the choice ${JSON.stringify(said)}`);
  }
  return { ok: missing.length === 0, missing };
}

/** The digest the record keeps, so what was sent is provable later without storing the question a second time. */
export function reaskDigest(text = "") {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// ---- the ITEMS the popup draws: one per question, however many times it was asked ---------------------------------
//
// A list built from the store's records alone shows every ATTEMPT as its own row, so a question that was asked, closed
// and then asked again arrives as two rows: one ANSWERED and one "closed unanswered". That reads as though the reader
// ignored a question they actually answered, which makes the whole list untrustworthy. The popup therefore draws ITEMS:
// the attempts of one question, collapsed by the question's own words and the agent that asked them.
//
// The rules, in the order they decide a row:
//
//   answered  ANY attempt carries an answer. That wins over every closed word, including an attempt whose own card was
//             cancelled or timed out: the reader did answer, and no later card's outcome can take that back.
//   open      no attempt has an answer and one is still waiting.
//   replied   no attempt has an answer, and a READER'S OWN REPLY turn on that thread started after the question was
//             asked (and before the next question on that thread). The panel cannot prove that reply answered this
//             question, so the row says "answered in a reply" and points at that turn rather than calling it missed.
//   closed    nothing above: no attempt answers it and no reply followed, so the card really did go unanswered and says
//             its own word ("cancelled", "timed out", "closed unanswered", "the turn ended").
export const CLARIFY_ITEM_STATES = ["open", "answered", "replied", "closed"];

/** Two attempts of ONE question share this key: the question's own words and the agent that asked it. */
export function collapseKey(entry = {}) {
  const q = oneLine(entry.question, 400).toLowerCase();
  if (!q) return `seq:${Number(entry.seq) || 0}`;
  const who = oneLine(entry.agent || entry.thread, 120).toLowerCase() || "an agent";
  return `${who}\u0000${q}`;
}

const timeOf = (v) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : 0;
};

/**
 * One item per question. `attempts` is newest first and carries every ask with its own timestamps, so the popup can
 * fold them behind the row; the item itself is the newest attempt's fields with the state resolved across all of them.
 */
export function collapseItems(entries = []) {
  const groups = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== "object") continue;
    const k = collapseKey(e);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  const items = [];
  for (const [group, list] of groups) {
    const attempts = list
      .slice()
      .sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0) || timeOf(b.askedAt) - timeOf(a.askedAt));
    const newest = attempts[0];
    const answering =
      attempts.find((a) => String(a.status) === "answered" && String(a.answer ?? "").trim()) ||
      attempts.find((a) => String(a.status) === "answered") ||
      null;
    const waiting = attempts.find((a) => String(a.status) === "open") || null;
    const askedTimes = attempts.map((a) => timeOf(a.askedAt)).filter(Boolean);
    const firstAsked = askedTimes.length ? Math.min(...askedTimes) : 0;
    const item = {
      ...newest,
      group,
      attempts,
      attemptCount: attempts.length,
      // The item's AGE counts from the first ask: "asked 2h ago" is the question's age, not its latest retry's. Each
      // attempt's own time is in `attempts` and the fold prints it.
      firstAskedAt: firstAsked ? nowIso(firstAsked) : newest.askedAt || null,
      askedAt: firstAsked ? nowIso(firstAsked) : newest.askedAt || null,
      state: "closed",
      // The reader's own re-ask of this question, from ANY attempt (newest record wins). A question asked, missed and
      // re-asked is ONE item, and the record has to travel with the item or a collapsed group would offer the button
      // again the moment a new attempt arrived - which is exactly the second send this record exists to stop.
      reask: attempts.find((a) => a && a.reask && typeof a.reask === "object")?.reask || null,
    };
    if (answering) {
      item.state = "answered";
      item.status = "answered";
      item.answer = String(answering.answer ?? "");
      item.answeredBy = String(answering.answeredBy || "reader");
      item.answeredAt = answering.answeredAt || null;
      item.via = String(answering.via || "");
      item.closedWhy = "";
      item.closedAt = answering.answeredAt || null;
    } else if (waiting) {
      item.state = "open";
      item.status = "open";
      item.answer = "";
      item.answeredBy = "";
      item.answeredAt = null;
      item.closedWhy = "";
      item.closedAt = null;
    } else {
      item.state = "closed";
      item.status = "closed";
      item.answer = "";
      item.answeredBy = "";
      item.answeredAt = null;
      item.closedWhy = String(newest.closedWhy || "closed unanswered");
      item.closedAt = newest.closedAt || null;
      // The closed line counts from the attempt that closed, never from the item's first ask: a question asked twice
      // and cancelled the second time waited for the second card, and "cancelled after 7m" must say that.
      item.closedAskedAt = newest.askedAt || null;
    }
    items.push(item);
  }
  return items.sort(
    (a, b) => Number(b.seq || 0) - Number(a.seq || 0) || timeOf(b.askedAt) - timeOf(a.askedAt),
  );
}

/**
 * The reader's own replies, read off the job store: a reply turn starts with `origin.by` naming who sent it, and only
 * "reader" (the reply box) and "clarify-answer" (the panel delivering a clarify choice as a reply) are the reader's.
 * An assistant's own TO line is a reply too, and it is NOT evidence that a question was answered.
 *
 * A RE-ASK's turn (origin.kind "clarify-reask") is the reader's own, and it is still not an answer: it asks the agent to
 * ask the question again. Counting it would turn the missed row into "answered in a reply" - pointing at the very turn
 * that re-asked it - the moment the reader used the button, and the row's own record would then be the only proof the
 * question was never answered. So that turn is skipped by kind, here rather than at each caller.
 */
export function readerReplies(jobs = []) {
  const out = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || !j.reply) continue;
    const by = String(j.origin?.by || "").trim();
    if (by !== "reader" && by !== "clarify-answer") continue;
    if (String(j.origin?.kind || "").trim() === "clarify-reask") continue;
    const thread = String(j.thread || "").trim();
    const at = timeOf(j.startedAt);
    if (!thread || !at) continue;
    out.push({ jobId: String(j.id || ""), thread, at, atIso: nowIso(at), text: oneLine(j.prompt, 240) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Give a closed item the softer word when a reader's reply followed it. The window is the item's own: from its first
 * ask until the NEXT question on that thread, because a reply after another question was asked is more likely about
 * that one. `jobId`/`thread` move to the reply turn, so pressing the row lands on the turn the reader wrote instead of
 * on a card that never recorded an answer.
 */
export function withReplyEvidence(items = [], replies = []) {
  const list = Array.isArray(replies) ? replies : [];
  const source = Array.isArray(items) ? items : [];
  for (const item of source) {
    if (item.state !== "closed") continue;
    const threads = new Set(item.attempts.map((a) => String(a.thread || "")).filter(Boolean));
    if (!threads.size || !list.length) continue;
    const first = timeOf(item.firstAskedAt || item.askedAt);
    if (!first) continue;
    let next = 0;
    for (const other of source) {
      if (other === item) continue;
      if (!other.attempts.some((a) => threads.has(String(a.thread || "")))) continue;
      const at = timeOf(other.firstAskedAt || other.askedAt);
      if (at > first && (!next || at < next)) next = at;
    }
    const hit = list.find((r) => threads.has(r.thread) && r.at >= first && (!next || r.at < next));
    if (!hit) continue;
    item.state = "replied";
    item.reply = { jobId: hit.jobId, thread: hit.thread, at: hit.atIso, text: hit.text };
    item.jobId = hit.jobId;
    item.thread = hit.thread;
  }
  return source;
}

/** The one entry point the route and the page's tests read: collapse, then let a reply soften what was called missed. */
export function clarifyItems(entries = [], { replies = [] } = {}) {
  return withReplyEvidence(collapseItems(entries), replies);
}

/** How many ITEMS are still waiting on an answer. The header button's count, and never a count of attempts. */
export function outstandingOf(items = []) {
  return (Array.isArray(items) ? items : []).filter((i) => String(i?.state || i?.status || "") === "open").length;
}

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
    reask: null,
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
      const body = JSON.stringify(
        {
          version: CLARIFY_HISTORY_VERSION,
          seq: this.seq,
          // The in-flight claim is memory only: a claim written to disk would survive a restart as a permanent
          // "already being sent" on a question nothing is sending any more.
          entries: this.entries.map((e) => {
            if (!e || !("_reaskClaim" in e)) return e;
            const { _reaskClaim, ...rest } = e;
            return rest;
          }),
        },
        null,
        0,
      );
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
   * The reader pressed Re-ask on a question they MISSED. Two steps, and the split is the double-press guard:
   *
   *   beginReask(entry)   synchronously claims the record, before the first await. Two presses that arrive together
   *                       both resolve the same stored entry; the second finds the claim and is refused HERE, not
   *                       after a round trip has already been started.
   *   finishReask(...)    writes the durable record (when the panel accepted the send) and releases the claim.
   *   abandonReask(entry) releases the claim and records nothing, for a send that was refused.
   *
   * The record is keyed on the ENTRY (the item's newest attempt, the exact row the reader pressed), so a question
   * asked again later is a new attempt and may be re-asked once more - while the attempt the reader already re-asked
   * can never send a second time, and the record survives a restart because it lives in the file.
   */
  beginReask(entry) {
    this.load();
    if (!entry) return { ok: false, why: "no entry" };
    if (entry.reask) return { ok: false, why: "this question was already re-asked", reask: entry.reask };
    if (entry._reaskClaim) return { ok: false, why: "a re-ask of this question is already being sent", pending: true };
    entry._reaskClaim = true;
    return { ok: true };
  }

  finishReask(entry, { at = null, by = "reader", jobId = null, thread = "", text = "" } = {}) {
    this.load();
    if (!entry) return null;
    const when = isoOrNull(at) || nowIso(this.now());
    entry.reask = {
      at: when,
      by: String(by || "reader"),
      jobId: jobId ? String(jobId) : null,
      thread: String(thread || entry.thread || ""),
      key: String(entry.key || ""),
      chars: String(text ?? "").length,
      sha256: reaskDigest(text),
    };
    delete entry._reaskClaim;
    this.save();
    return entry.reask;
  }

  abandonReask(entry) {
    if (entry) delete entry._reaskClaim;
    return entry || null;
  }

  /** The record for a stored entry, or null: the page and the route both ask this one question. */
  reaskFor(entry) {
    this.load();
    return entry && entry.reask && typeof entry.reask === "object" ? entry.reask : null;
  }

  /**
   * A settled job that RECORDED an answer is proof the reader answered, even when the store was closed under it. The
   * gateway's `clarify.settled` can land before the answer is written down (it does: on this board the close and the
   * answer arrived 21ms and 106ms apart), and a store written by a build that read `j.question.key` after that settle
   * holds "closed unanswered" about a question the reader answered. This pass repairs those rows from the job's own
   * `questionDone`, and only where it can PROVE which question it was: the row's own key when the job kept one, or -
   * for a record from a build that kept none - the one question that job asked. A turn that asked twice is left alone
   * rather than given an answer it may not have received.
   */
  repairAnswers(jobs = []) {
    this.load();
    const byJob = new Map();
    for (const j of Array.isArray(jobs) ? jobs : []) {
      if (j && j.id) byJob.set(String(j.id), j);
    }
    const perJob = new Map();
    for (const e of this.entries) {
      const id = String(e.jobId || "");
      perJob.set(id, (perJob.get(id) || 0) + 1);
    }
    let changed = 0;
    for (const e of this.entries) {
      if (e.status === "answered") continue;
      const job = byJob.get(String(e.jobId || ""));
      const done = job && job.questionDone && typeof job.questionDone === "object" ? job.questionDone : null;
      const answer = String(done?.answer || "").trim();
      if (!answer) continue;
      if (done.key && String(done.key) !== String(e.key)) continue;
      if (!done.key && (perJob.get(String(e.jobId || "")) || 0) > 1) continue;
      e.status = "answered";
      e.answer = answer;
      e.answeredBy = String(done.by || "reader");
      e.answeredAt = isoOrNull(done.at) || e.answeredAt || nowIso(this.now());
      e.closedWhy = "";
      e.closedAt = e.answeredAt;
      if (done.via) e.via = String(done.via);
      changed += 1;
    }
    if (changed) this.save();
    return changed;
  }

  /**
   * After a restart the store can hold a row whose question nobody can answer any more. An open row survives only
   * while the job that asked is still on the board with that same prompt open; anything else is closed as cancelled
   * at the moment this pass noticed, never left saying "unanswered" about a turn that is gone. A row that a settle
   * closed under a recorded answer is repaired by `repairAnswers`, so the one list that has to be trusted never calls
   * an answered question missed.
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
    changed += this.repairAnswers(jobs);
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

  /**
   * The list the popup DRAWS: one item per question (collapseItems), with a reader's reply standing in for an answer
   * the card never recorded (readerReplies + withReplyEvidence). `total` is the number of ITEMS, `attempts` the number
   * of stored asks behind them, and `outstanding` the count of items still waiting - never of attempts.
   */
  items({ limit = null, replies = [] } = {}) {
    const all = this.list();
    const items = clarifyItems(all.entries, { replies });
    const n = Number(limit);
    const rows = Number.isFinite(n) && n > 0 ? items.slice(0, Math.floor(n)) : items;
    return {
      items: rows,
      total: items.length,
      attempts: all.total,
      outstanding: outstandingOf(items),
      kept: all.kept,
      cap: all.cap,
    };
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
  out.reask = e.reask && typeof e.reask === "object" ? { ...e.reask } : null;
  return out;
}
