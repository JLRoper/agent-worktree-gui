// The PERMISSIONS HISTORY: every permission request this panel has held, and how each one ended.
//
// WHY A STORE AND NOT THE PENDING MAP. lib/approvals.js holds `pending` and `decisions` in memory and nothing else:
// an answered request survives there as a choice with a timestamp and no record of WHAT was asked or WHO was blocked,
// a timed-out one survives as a `deny` that no person chose, and a restart empties both maps completely. So a popup
// built from the live maps would forget a decision the moment it was made, and would call every expiry a denial. This
// is the durable record instead, written when the request arrives and settled when it ends.
//
// THE SHAPE OF A RECORD, and why each field is here:
//
//   seq          the identity the page sends back on a press, and the order. One number per request, never reused.
//   key          the request's own id (`request_id` from the host, the id the answer route is addressed by). One
//                record per request: a replay of a settled id cannot erase a decision.
//   requestId    the same id, spelled the way the route reads it, so the page never has to know about `key`.
//   jobId/runId  the turn and the gateway run that parked on it, resolved from the WTGUI_THREAD the plugin echoes
//                back. A permission is a fact about a run, and a reader looking it up later needs the run.
//   thread       the agent that is blocked, by its thread id: the name the reader already sees on the card.
//   agent        that agent's display title, when the panel can still resolve it.
//   tree/treePath/project/assistantId/assistantName
//                where the blocked run was working, and which assistant started it. All four are the row's own
//                names, read the way the Clarify history reads them.
//   command      the exact request text the gateway sent (a redacted command line, or a description when the host
//                sends no command). Never truncated in the store: the popup decides how much of it to show.
//   policy       the gateway's one-line policy note for the request (`description` from the host), which says WHY
//                the command was flagged. Kept as one line, and empty when the host sent none.
//   patternKey   the policy pattern that matched, when the host names one.
//   choices      the choices the host allowed, in the host's order. Anything outside them is refused by the panel,
//                so this list is also the only set of answers the popup may offer.
//   timeoutSeconds / askedAt / deadline
//                the window: when the request reached the panel, how long the host said it would wait, and the
//                instant the panel stops accepting an answer (the window minus the answer grace, see lib/approvals.js).
//   status       open | answered | expired. "expired" is the honest third state: nobody chose, the window closed (or
//                the panel restarted, or the gateway dropped the request), and the host's own fail-closed rule denied
//                the command. It must never be drawn as a `deny` somebody pressed.
//   choice       what the person actually pressed, written by the answer route at the moment the gateway accepted it.
//   answeredBy   who. "reader" through the panel's own answer route.
//   answeredAt   when. Stamped beside the choice, from the same call.
//   closedWhy    for an expired row, why it expired: timed out, the panel restarted, the gateway no longer holds it.
//   closedAt     when that happened. For a timeout it is the deadline itself, not the moment a sweep noticed.
//
// THE FILE is `permissions-history.json` beside `jobs.json` (lib/paths.js owns that spelling), never inside a
// checkout: it is state, not source. One Node process writes it, so the store is its own lock, and every write goes
// through a temp file + rename so a reader never sees half a list.
//
// A CAP IS THE ONLY BOUND. `PERMISSIONS_HISTORY_KEEP` rows are kept, newest first, and the oldest are forgotten on
// write. The page's own render cap (50 rows with an honest "showing 50 of N") is a separate thing: this file only
// bounds the store, it never silent-truncates a total it reports.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PERMISSIONS_HISTORY_VERSION = 1;
export const PERMISSIONS_HISTORY_KEEP = 400;
export const PERMISSIONS_STATES = ["open", "answered", "expired"];

// The words an expired row can say. Kept to the few causes the panel can actually prove, because a row that invents
// a reason is worse than one that says the window closed.
export const EXPIRED_WHYS = ["timed out", "the panel restarted", "the gateway no longer holds it", "the turn ended"];

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
const timeOf = (v) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : 0;
};

/** The id a request is known by: the host's own, and the one the answer route addresses. */
export function requestKeyOf(rec = {}) {
  return String(rec.requestId || rec.id || "").trim();
}

// One request as the store keeps it. A missing field is null or empty, never invented.
export function permissionsHistoryEntry(rec = {}, { seq = 0, at = nowIso() } = {}) {
  const requestId = requestKeyOf(rec);
  const askedAt = isoOrNull(rec.askedAt) || isoOrNull(rec.receivedAt) || at;
  const deadline = Number(rec.deadline) > 0 ? Number(rec.deadline) : null;
  const timeoutSeconds = Number(rec.timeoutSeconds) > 0 ? Number(rec.timeoutSeconds) : null;
  return {
    seq: Number(seq) || 0,
    key: requestId,
    requestId,
    jobId: rec.jobId ? String(rec.jobId) : null,
    runId: rec.runId ? String(rec.runId) : null,
    thread: rec.thread ? String(rec.thread) : null,
    agent: oneLine(rec.agent, 120) || String(rec.thread || "") || "an agent",
    tree: oneLine(rec.tree, 160) || "",
    treePath: rec.treePath ? String(rec.treePath).replace(/\\/g, "/") : "",
    project: rec.project ? String(rec.project) : "",
    assistantId: rec.assistantId ? String(rec.assistantId) : null,
    assistantName: oneLine(rec.assistantName, 80) || "",
    surface: oneLine(rec.surface, 120) || "",
    patternKey: rec.patternKey ? String(rec.patternKey) : "",
    command: String(rec.command ?? ""),
    policy: oneLine(rec.description || rec.policy || "", 240),
    choices: (Array.isArray(rec.choices) ? rec.choices : Array.isArray(rec.allowed) ? rec.allowed : [])
      .map((c) => String(c).trim())
      .filter(Boolean),
    timeoutSeconds,
    askedAt,
    deadline,
    status: "open",
    choice: "",
    answeredBy: "",
    answeredAt: null,
    closedWhy: "",
    closedAt: null,
  };
}

export class PermissionsHistory {
  constructor({ file = null, log = null, keep = PERMISSIONS_HISTORY_KEEP, now = () => Date.now() } = {}) {
    this.file = file ? String(file) : null;
    this.log = typeof log === "function" ? log : null;
    this.keep = Math.max(1, Number(keep) || PERMISSIONS_HISTORY_KEEP);
    this.now = typeof now === "function" ? now : () => Date.now();
    // Newest first. `seq` is monotonic and never re-sorted except as a defensive read, so a record keeps the place
    // it was asked in even when a later request arrives.
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
      this.log?.(`permissions history: could not read ${this.file} (${String((e && e.message) || e)}); starting empty`);
    }
    return this;
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ version: PERMISSIONS_HISTORY_VERSION, seq: this.seq, entries: this.entries }, null, 0);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, this.file);
    } catch (e) {
      this.log?.(`permissions history: could not write ${this.file} (${String((e && e.message) || e)})`);
    }
  }

  find(key) {
    this.load();
    const k = String(key || "").trim();
    if (!k) return null;
    return this.entries.find((e) => e.key === k) || null;
  }

  /**
   * A request arrived. One record per request id: an open one is updated where it stands (the gateway can resent the
   * same prompt), and a SETTLED one is left exactly as it settled - a replay must not erase a decision somebody made,
   * and the host's ids are unique per request, so a second row for one id would be a lie about what was asked.
   */
  ask(rec = {}) {
    this.load();
    const key = requestKeyOf(rec);
    if (!key) return null;
    const at = nowIso(this.now());
    const existing = this.find(key);
    if (existing) {
      if (existing.status !== "open") return existing;
      existing.command = String(rec.command ?? existing.command ?? "");
      existing.policy = oneLine(rec.description || rec.policy || existing.policy || "", 240);
      if (Array.isArray(rec.choices) && rec.choices.length) existing.choices = rec.choices.map((c) => String(c)).filter((c) => c.trim());
      else if (Array.isArray(rec.allowed) && rec.allowed.length) existing.choices = rec.allowed.map((c) => String(c)).filter((c) => c.trim());
      if (rec.thread) existing.thread = String(rec.thread);
      if (rec.agent) existing.agent = oneLine(rec.agent, 120);
      if (rec.jobId) existing.jobId = String(rec.jobId);
      if (rec.runId) existing.runId = String(rec.runId);
      if (rec.tree) existing.tree = oneLine(rec.tree, 160);
      if (rec.treePath) existing.treePath = String(rec.treePath).replace(/\\/g, "/");
      if (rec.project) existing.project = String(rec.project);
      if (rec.assistantId) existing.assistantId = String(rec.assistantId);
      if (rec.assistantName) existing.assistantName = oneLine(rec.assistantName, 80);
      if (rec.surface) existing.surface = oneLine(rec.surface, 120);
      if (rec.patternKey) existing.patternKey = String(rec.patternKey);
      const deadline = Number(rec.deadline) > 0 ? Number(rec.deadline) : 0;
      if (deadline) existing.deadline = deadline;
      const timeoutSeconds = Number(rec.timeoutSeconds) > 0 ? Number(rec.timeoutSeconds) : 0;
      if (timeoutSeconds) existing.timeoutSeconds = timeoutSeconds;
      this.save();
      return existing;
    }
    this.seq += 1;
    const entry = permissionsHistoryEntry({ ...rec, askedAt: rec.askedAt || rec.receivedAt || at }, { seq: this.seq, at });
    this.entries.unshift(entry);
    if (this.entries.length > this.keep) this.entries.length = this.keep;
    this.save();
    return entry;
  }

  /**
   * A person answered. Written from the call that the host accepted, so it records the choice, who and when rather
   * than a guess. Idempotent: a second press for the same request returns the first record untouched, so one request
   * can never grow two decisions. An answer that arrives after the row expired is refused here - the host's window
   * closed and its own fail-closed rule already denied the command.
   */
  answered(key, { choice = "", by = "reader", at = null, via = "" } = {}) {
    this.load();
    const entry = this.find(key);
    if (!entry) return null;
    if (entry.status !== "open") return entry;
    const said = String(choice ?? "").trim();
    if (!said) return entry;
    entry.status = "answered";
    entry.choice = said;
    entry.answeredBy = String(by || "reader");
    entry.answeredAt = isoOrNull(at) || nowIso(this.now());
    entry.closedWhy = "";
    entry.closedAt = entry.answeredAt;
    if (via) entry.surface = oneLine(via, 120);
    this.save();
    return entry;
  }

  /**
   * The window closed with nobody answering, or the request went away. `why` is one of EXPIRED_WHYS; the row says it
   * instead of looking like a denial somebody chose. A timeout is stamped at the DEADLINE, not at the moment a sweep
   * noticed, so the row reports when the window actually closed.
   */
  expired(key, { why = "", at = null } = {}) {
    this.load();
    const entry = this.find(key);
    if (!entry || entry.status !== "open") return entry || null;
    const when = isoOrNull(at) || nowIso(this.now());
    entry.status = "expired";
    entry.closedWhy = EXPIRED_WHYS.includes(String(why)) ? String(why) : "timed out";
    entry.closedAt = when;
    this.save();
    return entry;
  }

  /**
   * After a restart, or after the host dropped a request, the store can hold a row nobody can answer any more. An open
   * row survives only while `pendingIds` still carries it; anything else is expired at the moment this pass noticed,
   * with the reason the row can prove: a deadline that has passed is a timeout, anything else is the request being
   * gone. An answered row is never touched, so the one list that has to be trusted never calls a decision an expiry.
   */
  reconcile(pendingIds = [], { why = "", at = null } = {}) {
    this.load();
    const live = pendingIds instanceof Set ? pendingIds : new Set((Array.isArray(pendingIds) ? pendingIds : []).map((id) => String(id)));
    const now = Number.isFinite(Number(at)) ? Number(at) : this.now();
    const fallback = EXPIRED_WHYS.includes(String(why)) ? String(why) : "the gateway no longer holds it";
    let changed = 0;
    for (const e of this.entries) {
      if (e.status !== "open") continue;
      if (live.has(String(e.key))) continue;
      const due = Number(e.deadline) || 0;
      e.status = "expired";
      e.closedWhy = due && now >= due ? "timed out" : fallback;
      e.closedAt = nowIso(due && now >= due ? due : now);
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

  /** How many rows are still waiting on a person, off the store's own statuses. Never a page's render cap. */
  outstanding() {
    this.load();
    return this.entries.filter((e) => e.status === "open").length;
  }

  /** How many rows the store holds, for a journal line or a test. Never a page's render cap. */
  count() {
    this.load();
    return this.entries.length;
  }
}

// A file written by another build (or hand-edited) is read into the shape the page expects: an unknown status reads
// as expired with its own word, rather than as an answer nobody gave.
function normalizeLoaded(e) {
  const out = permissionsHistoryEntry(e, { seq: e.seq, at: isoOrNull(e.askedAt) || nowIso() });
  out.seq = Number(e.seq) || 0;
  out.status = PERMISSIONS_STATES.includes(String(e.status)) ? String(e.status) : "expired";
  out.choice = String(e.choice ?? "");
  out.answeredBy = String(e.answeredBy ?? "");
  out.answeredAt = isoOrNull(e.answeredAt);
  out.closedWhy =
    out.status === "expired"
      ? EXPIRED_WHYS.includes(String(e.closedWhy))
        ? String(e.closedWhy)
        : "the gateway no longer holds it"
      : "";
  out.closedAt = isoOrNull(e.closedAt) || (out.status === "answered" ? out.answeredAt : out.status === "expired" ? isoOrNull(e.askedAt) : null);
  out.deadline = Number(e.deadline) > 0 ? Number(e.deadline) : null;
  out.timeoutSeconds = Number(e.timeoutSeconds) > 0 ? Number(e.timeoutSeconds) : null;
  out.choices = Array.isArray(e.choices) ? e.choices.map((c) => String(c)) : [];
  return out;
}

// Kept for a caller that wants the clock arithmetic without the class: the span one row waited, in ms, from its ask
// to the moment it settled. Zero when either end is unknown.
export function waitedMs(entry = {}) {
  const from = timeOf(entry.askedAt);
  const to = timeOf(entry.answeredAt || entry.closedAt);
  if (!from || !to || to < from) return 0;
  return to - from;
}
