// THE TICKET WATCH: a per-assistant list of Jira keys, the three things a poll can see move on one, and the one
// door that asks an assistant to look at a ticket that moved.
//
// THE POLLER REPORTS MOVEMENT. IT DOES NOT JUDGE IT.
//
// That split is the whole design, and it was arrived at twice: the first build decided for itself whether a comment
// was "addressed to the reader" (a mention of `[~Roper]`, the reader's display name in the body, a non-reader author
// on a Waiting for Customer ticket, a ticket assigned to the reader) and quietly dropped the ones it judged
// irrelevant before the assistant ever saw them. That made the poller a second, worse judge of a ticket it had not
// read: relevance depends on what the comment asks, what the thread has already settled and what the reader is doing
// this week — none of which is in a REST payload. So the addressed test is GONE. Every movement is reported, in the
// same neutral words, and the assistant that owns the list reads the ticket and decides whether the reader has a
// decision to make. The procedure it follows is `docs/ticket-watch.md`; the worked example of a movement that
// correctly produced no card is in that document too.
//
// What the poller owes the assistant is therefore: WHICH ticket moved and WHAT moved on it, in the reader's terms,
// plus the one command that reads the ticket. Nothing else. No queue row, no card, no `addressed: true/false`, no
// options list, no opinion.
//
// The list is one JSON file per assistant, BESIDE ITS QUEUE — `state/assistants/<id>/tickets.json`, the same
// directory its charter, its settings and its `queue.json` live in, so a reader who opens `assistant-3/` sees
// everything that assistant watches in one place. Each entry is exactly `{key, note, addedAt, lastSeen}` and
// `lastSeen` is exactly `{commentId, status, assignee, updated}`: the four facts the next poll diffs against. A
// `lastSeen` that is all nulls is the BASELINE — a ticket `add`ed a minute ago and never checked — and a baseline
// raises nothing. The first `check` writes the baseline and says nothing, which is why adding a ticket is never a
// burst of wakes about history the reader has already read.
//
// THREE EVENT CLASSES, and no fourth:
//
//   comment   a comment with an id greater than the last one seen (Jira ids are increasing). One event per new
//             comment, each carrying its id, author, time, length and an excerpt — the assistant can see there is a
//             question without a round trip, and still reads the ticket before deciding.
//   status    `status.name` differs from the one last seen.
//   assignee  `assignee.displayName` differs from the one last seen. "Unassigned" is a value, not an absence: a
//             ticket that loses its assignee is a change the reader needs to know about.
//
// NOTHING HERE WRITES TO JIRA. No comment, no transition, no link, no worklog: this module reads the REST payload
// the caller hands it (tools/ticket-watch.mjs owns the GET) and produces text. The wake is the only output.
//
// THE WAKE is the panel's OWN, not a second one: `createTicketWatchRoutes` exports one route,
// `POST /api/ticket-watch/wake`, and it calls `assistant.wake(text, null, "ticket", {assistantId})` — the function
// the sentry's `fired()`, the COMPLETE chip and the reader's own alert hand-over all go through (the ladder
// `tools/verify-wake-ladder.mjs` drives). There is no queue of pending wakes in this module, no turn starter, no
// timer and no second journal: a cron process cannot call an object inside another process, so the route is the
// DOOR onto that one mechanism, and `"ticket"` is an event rule (it is not in `SWEEP_WAKE_RULES`), which is what
// keeps a busy hour from silently dropping the wake.
//
// The split is deliberate: this module owns the FILE, the DIFF and the WAKE'S WORDS (all pure or file-only, so the
// test drives them with no server and no network); tools/ticket-watch.mjs owns the Jira GETs, the HTTP call and the
// CLI. The panel imports only `createTicketWatchRoutes`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findAssistant } from "./assistants.js";

export const WATCH_VERSION = 1;
// The ticket key this watch accepts: a project key, a dash, a number. Anything else is refused at `add` rather
// than polled into a 404 every fifteen minutes.
export const TICKET_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const TICKET_NOTE_MAX = 400;
export const TICKET_WAKE_TEXT_MAX = 4000;
export const TICKET_EXCERPT_MAX = 240;
// The three classes a poll can raise, and the only three. A fourth would need a name here and a paragraph in
// docs/ticket-watch.md saying what the assistant is expected to do with it.
export const MOVEMENT_KINDS = Object.freeze(["comment", "status", "assignee"]);
// The rule the wake travels under. An EVENT rule (see lib/assistant/config.js `SWEEP_WAKE_RULES`): a ticket that
// moved is news with no second chance, so it must not share the sentry's hourly sweep budget.
export const TICKET_WAKE_RULE = "ticket";

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const nowIso = (at) => new Date(at || Date.now()).toISOString();
const normKey = (key) => String(key ?? "").trim().toUpperCase();
const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Where one assistant's ticket list lives, relative to its state directory (beside its queue). */
export const ticketsRelFor = (id) => path.join("assistants", String(id || ""), "tickets.json");
/** The absolute file for one assistant's ticket list. */
export const ticketsPathFor = (stateDir, id) => path.join(String(stateDir || ""), ticketsRelFor(id));

/** The empty document for one assistant. Written on the first `add`, never at boot. */
export const emptyWatch = (assistantId = null) => ({ version: WATCH_VERSION, assistantId: assistantId || null, tickets: [] });

// `lastSeen` is the shape the diff reads, so an entry written by hand (or by an older build) is NORMALISED into
// it rather than trusted: a missing key reads as "never seen", which is the baseline, and a baseline raises
// nothing. Four keys, always, in this order — the file a reader opens is the same shape the code reads.
export function normSeen(seen) {
  const s = seen && typeof seen === "object" ? seen : {};
  const str = (v) => (isBlank(v) ? null : String(v));
  const commentId = str(s.commentId);
  return {
    commentId: commentId && Number.isFinite(Number(commentId)) ? String(Number(commentId)) : commentId,
    status: str(s.status),
    assignee: str(s.assignee),
    updated: str(s.updated),
  };
}

/** One entry, exactly `{key, note, addedAt, lastSeen}`. */
export function normTicket(entry = {}, { at = new Date() } = {}) {
  return {
    key: normKey(entry.key),
    note: clip(String(entry.note ?? ""), TICKET_NOTE_MAX),
    addedAt: entry.addedAt ? String(entry.addedAt) : nowIso(at),
    lastSeen: normSeen(entry.lastSeen),
  };
}

/**
 * Read one assistant's list. A missing file is an EMPTY list (the assistant watches nothing yet); a file that
 * cannot be parsed is an ERROR carried as a value, because the caller must refuse to write over it — treating a
 * corrupt list as empty and saving would delete every watch the assistant had.
 * @returns {{doc: object, exists: boolean, error: string|null}}
 */
export function readTicketFile(file) {
  const doc = emptyWatch();
  if (!file || !existsSync(file)) return { doc, exists: false, error: null };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { doc, exists: true, error: `could not read ${file}: ${String((err && err.message) || err)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch (err) {
    return { doc, exists: true, error: `${file} is not valid JSON: ${String((err && err.message) || err)}` };
  }
  // Two shapes are accepted: the versioned document this module writes, and a bare array (a hand-written list).
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tickets) ? parsed.tickets : null;
  if (!list) return { doc, exists: true, error: `${file} has no tickets list` };
  const seen = new Set();
  const tickets = [];
  for (const entry of list) {
    const t = normTicket(entry);
    if (!t.key || seen.has(t.key)) continue;
    seen.add(t.key);
    tickets.push(t);
  }
  return { doc: { version: WATCH_VERSION, assistantId: parsed?.assistantId ?? null, tickets }, exists: true, error: null };
}

/** Write one assistant's list atomically (temp file + rename, the same shape ./assistant/queue.js uses). */
export function writeTicketFile(file, doc) {
  if (!file) throw new Error("a ticket list needs a file");
  const out = {
    version: WATCH_VERSION,
    assistantId: doc?.assistantId ?? null,
    tickets: (Array.isArray(doc?.tickets) ? doc.tickets : []).map((t) => normTicket(t)),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 1)}\n`, "utf8");
  renameSync(tmp, file);
  return out;
}

/**
 * Watch one key. A key already on the list keeps its `addedAt` and its `lastSeen` — re-adding is how a reader
 * changes the note, and it must not throw away the baseline (or re-raise history the reader already saw).
 * @returns {{doc: object, entry: object, added: boolean, changed: boolean}}
 */
export function addTicket(doc, { key, note = "", at = new Date() } = {}) {
  const wanted = normKey(key);
  if (!TICKET_KEY_RE.test(wanted)) {
    throw Object.assign(new Error(`not a ticket key: ${JSON.stringify(String(key ?? ""))} — expected e.g. SR-242996`), { code: "ticket-key" });
  }
  const tickets = (Array.isArray(doc?.tickets) ? doc.tickets : []).map((t) => normTicket(t));
  const i = tickets.findIndex((t) => t.key === wanted);
  if (i >= 0) {
    const entry = { ...tickets[i], note: clip(String(note ?? tickets[i].note), TICKET_NOTE_MAX) };
    const changed = entry.note !== tickets[i].note;
    tickets[i] = entry;
    return { doc: { ...doc, tickets }, entry, added: false, changed };
  }
  const entry = { key: wanted, note: clip(String(note ?? ""), TICKET_NOTE_MAX), addedAt: nowIso(at), lastSeen: normSeen(null) };
  tickets.push(entry);
  return { doc: { ...doc, tickets }, entry, added: true, changed: true };
}

/** Stop watching one key. */
export function removeTicket(doc, key) {
  const wanted = normKey(key);
  const tickets = Array.isArray(doc?.tickets) ? doc.tickets : [];
  const next = tickets.filter((t) => normKey(t.key) !== wanted);
  return { doc: { ...doc, tickets: next }, removed: next.length !== tickets.length };
}

// ---- the diff -------------------------------------------------------------------------------------------------
const commentsOf = (issue) => {
  const list = issue?.fields?.comment?.comments;
  return Array.isArray(list) ? list.slice().sort((a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0)) : [];
};

/** The four facts the next poll diffs against. */
export function snapshotOf(issue) {
  const f = issue?.fields || {};
  const comments = commentsOf(issue);
  const maxId = comments.reduce((m, c) => Math.max(m, Number(c?.id) || 0), 0);
  return {
    commentId: maxId ? String(maxId) : null,
    status: isBlank(f.status?.name) ? null : String(f.status.name),
    assignee: isBlank(f.assignee?.displayName) ? null : String(f.assignee.displayName),
    updated: isBlank(f.updated) ? null : String(f.updated),
  };
}

/** No snapshot yet: a key that was added and never checked. A baseline raises nothing. */
export const isBaseline = (entry) => {
  const s = normSeen(entry?.lastSeen);
  return s.commentId === null && s.status === null && s.assignee === null;
};

/**
 * Diff one issue against one entry. Pure: the entry in, the entry out, and every movement between them.
 *
 * The event carries FACTS only — no `addressed`, no severity, no options. `changed` is the write decision and it
 * watches exactly the three tracked facts, so a second poll of an unchanged ticket writes nothing; Jira's own
 * `updated` stamp can move for an edit this watch does not track (a description, a link), and that alone is not a
 * write and never a wake.
 *
 * @returns {{key: string, summary: string, baseline: boolean, events: object[], entry: object, changed: boolean, snapshotMoved: boolean}}
 */
export function classifyTicket(entry, issue) {
  const key = normKey(entry?.key || issue?.key);
  const summary = oneLine(issue?.fields?.summary || "");
  const before = normSeen(entry?.lastSeen);
  const after = snapshotOf(issue);
  const baseline = isBaseline(entry);
  const events = [];
  if (!baseline) {
    const lastId = Number(before.commentId) || 0;
    for (const c of commentsOf(issue)) {
      if (!(Number(c?.id) > lastId)) continue;
      events.push({
        key,
        kind: "comment",
        id: String(c.id),
        summary,
        at: c.created || after.updated || null,
        author: oneLine(c?.author?.displayName || c?.author?.name || "someone"),
        length: String(c.body ?? "").length,
        excerpt: clip(oneLine(c.body), TICKET_EXCERPT_MAX),
        status: after.status,
        assignee: after.assignee,
      });
    }
    if (before.status !== after.status) {
      events.push({ key, kind: "status", id: `${before.status || "none"}->${after.status || "none"}`, summary, at: after.updated, from: before.status, to: after.status });
    }
    if (before.assignee !== after.assignee) {
      events.push({ key, kind: "assignee", id: `${before.assignee || "none"}->${after.assignee || "none"}`, summary, at: after.updated, from: before.assignee, to: after.assignee });
    }
  }
  return {
    key,
    summary,
    baseline,
    events,
    changed: baseline || before.commentId !== after.commentId || before.status !== after.status || before.assignee !== after.assignee,
    snapshotMoved: JSON.stringify(before) !== JSON.stringify(after),
    entry: { ...normTicket(entry || { key }), key, note: String(entry?.note ?? ""), lastSeen: after },
  };
}

// ---- the wake's words ----------------------------------------------------------------------------------------
const when = (at) => (at ? String(at).replace("T", " ").slice(0, 19) : "");

/** The one line naming WHAT MOVED, in the reader's terms. Used by the wake and by the CLI's report. */
export function movementLine(event) {
  if (event.kind === "status") return `status ${event.from || "none"} → ${event.to || "none"}`;
  if (event.kind === "assignee") return `assignee ${event.from || "unassigned"} → ${event.to || "unassigned"}`;
  const at = when(event.at);
  const size = Number.isFinite(Number(event.length)) ? `, ${event.length} characters` : "";
  return `new comment #${event.id} from ${event.author}${at ? ` at ${at}` : ""}${size}`;
}

/**
 * What the assistant is woken with: the ticket key, every movement in the same neutral words, the command that
 * reads the ticket, and the reminder that judging it is the assistant's job. It deliberately carries NO verdict:
 * `movementLine` says "new comment #4225070 from Greene, Ernest", never "addressed to you", and the text names the
 * procedure rather than anticipating its answer.
 */
export function wakeTextFor({ key, summary = "", events = [], browse = null } = {}) {
  const lines = [`Ticket watch: ${key} moved${summary ? ` - ${summary}` : ""}.`];
  lines.push("What moved:");
  for (const e of events) lines.push(`- ${movementLine(e)}`);
  lines.push(`Read the ticket: node tools/ticket-watch.mjs show ${key}   (${browse || `https://jira.sefl.com/browse/${key}`})`);
  lines.push("Reported as movement only - this poller has no opinion on whether it matters, and it has put nothing in front of the reader.");
  lines.push("Judge it yourself: read the ticket, then raise a clarify card only if the movement leaves the reader a decision to make. The procedure is docs/ticket-watch.md.");
  lines.push("Nothing has been written to Jira and nothing should be - reading is all this watch does.");
  return clip(lines.join("\n"), TICKET_WAKE_TEXT_MAX);
}

// ---- the door onto the panel's own wake ----------------------------------------------------------------------
//
// ONE route, `POST /api/ticket-watch/wake`, and its whole body is `assistant.wake(...)`. It is a door, not a
// mechanism: no queue, no timer, no turn starter, no journal of its own. The panel's ladder decides which
// assistant actually hears it (`wakeTarget`), whether that assistant is switched on, and what its budget allows —
// and the answer carries that verdict back to the caller so a refused wake is reported, not swallowed.
//
// The route is narrow on purpose: a generic "wake assistant X with any text" endpoint would be a remote code
// path into the board's own turn, so the text is capped, the assistant id must be one this panel HAS (no fallback
// to #1), and the rule is fixed to the ticket watch's own event class.
export function createTicketWatchRoutes({ assistant, config = {}, sendJson, readBody, authorised } = {}) {
  if (!assistant) throw new Error("createTicketWatchRoutes needs the Assistant instance");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createTicketWatchRoutes needs sendJson, readBody and authorised from the server's transport");
  }
  return async function ticketWatchRoutes(req, res, route) {
    if (route !== "/api/ticket-watch/wake") return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on /api/ticket-watch/wake` });
      return true;
    }
    if (!authorised(req, config.token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
      return true;
    }
    const payload = body && typeof body === "object" ? body : {};
    const text = String(payload.text ?? "").trim();
    if (!text) {
      sendJson(res, 400, { error: "a wake needs text" });
      return true;
    }
    const who = String(payload.assistantId || "").trim();
    if (!who) {
      sendJson(res, 400, { error: "a wake needs an assistantId — the ticket list belongs to one assistant" });
      return true;
    }
    const rec = findAssistant(assistant.assistants || [], who);
    if (!rec) {
      sendJson(res, 404, { error: `no such assistant: ${who}` });
      return true;
    }
    let out;
    try {
      out = assistant.wake(clip(text, TICKET_WAKE_TEXT_MAX), null, TICKET_WAKE_RULE, { assistantId: rec.id });
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
      return true;
    }
    // What the panel's own queue decided: `queued` (coalesced or not), or a refusal with the reason the assistant's
    // settings gave (switched off) or its budget gave. 409, because the request was understood and the answer is
    // "not now" — the same code a busy thread gets from /api/assistant/answer.
    if (out && out.queued === false) {
      sendJson(res, 409, { ok: false, ...out, error: out.refused === "disabled" ? "that assistant is switched off in Settings" : `the assistant's wake budget is spent (${out.limit ?? "?"}/hour)` });
      return true;
    }
    sendJson(res, 200, { ok: true, ...out, assistantId: rec.id });
    return true;
  };
}
