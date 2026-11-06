// The ticket watch, driven directly: no server, no Jira, no network. `lib/ticket-watch.js` owns the list, the diff
// and the card's words, and every one of those is a function this file can hand an argument to — which is the whole
// reason the Jira GET and the two HTTP calls live in tools/ticket-watch.mjs instead.
//
// What this pins, in the order the brief lists it:
//   1. the LIST: one file per assistant beside its queue, entries exactly `{key, note, addedAt, lastSeen}`, a
//      re-add keeping the baseline, a corrupt file reported as an error rather than read as empty;
//   2. the BASELINE: a key whose `lastSeen` is all nulls raises nothing, so adding a ticket is never a burst of
//      cards about history the reader has already read;
//   3. the three EVENT CLASSES: a new comment (and only a NEW one), a status change, an assignee change — with
//      "unassigned" a value rather than an absence;
//   4. the ADDRESSED TEST, all four ways it can fire and the one way it cannot (the reader's own comment), each
//      saying WHICH test fired rather than "new comment";
//   5. the CARD: the key, what changed, the comment's author and time, and the four options in the row's `detail`;
//   6. the WAKE DOOR: `POST /api/ticket-watch/wake` calls `assistant.wake(text, null, "ticket", {assistantId})` —
//      the panel's own ladder, no second path — and carries a refusal (switched off) back as a value.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OPTIONS,
  addTicket,
  addressedTo,
  classifyTicket,
  createTicketWatchRoutes,
  eventMarker,
  readTicketFile,
  removeTicket,
  ticketRowFor,
  ticketsPathFor,
  wakeTextFor,
  writeTicketFile,
} from "../lib/ticket-watch.js";

const READER = { displayName: "Roper, Jacob", mention: "Roper" };
const AT = "2026-11-02T13:18:26.927-0500";

const comment = (id, author, body, created = AT) => ({ id: String(id), author: { displayName: author }, body, created });

function issue({ key = "SR-242996", summary = "Firewall outgoing - k3s DEV nodes to Optym Azure Event Hubs", status = "Waiting for Customer", assignee = "Greene, Ernest", updated = AT, comments = [] } = {}) {
  return {
    key,
    fields: {
      summary,
      status: { name: status },
      assignee: assignee ? { displayName: assignee } : null,
      updated,
      comment: { comments, total: comments.length },
    },
  };
}

const seeded = (over = {}) => ({ key: "SR-242996", note: "DEV rule", addedAt: "2026-11-01T00:00:00.000Z", lastSeen: { commentId: null, status: null, assignee: null, updated: null }, ...over });
const seen = (over = {}) => ({ commentId: "4212127", status: "Waiting for Customer", assignee: "Greene, Ernest", updated: AT, ...over });

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wag-ticket-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---- 1. the list ----------------------------------------------------------------------------------------------

test("addTicket writes exactly {key, note, addedAt, lastSeen}, and a re-add keeps the baseline", () => {
  const at = new Date("2026-11-05T12:00:00Z");
  const first = addTicket({ version: 1, tickets: [] }, { key: " sr-242996 ", note: "DEV firewall", at });
  assert.deepEqual(Object.keys(first.entry), ["key", "note", "addedAt", "lastSeen"]);
  assert.equal(first.entry.key, "SR-242996");
  assert.equal(first.added, true);
  assert.deepEqual(first.entry.lastSeen, { commentId: null, status: null, assignee: null, updated: null });
  assert.equal(first.entry.addedAt, at.toISOString());

  // The baseline is a fact about the ticket, not about the note: re-adding is how a note is edited, and it must
  // not re-raise every comment the reader has already seen.
  const withSeen = { ...first.doc, tickets: [{ ...first.entry, lastSeen: seen() }] };
  const again = addTicket(withSeen, { key: "SR-242996", note: "renamed note", at });
  assert.equal(again.added, false);
  assert.equal(again.entry.note, "renamed note");
  assert.deepEqual(again.entry.lastSeen, seen());
  assert.equal(again.entry.addedAt, first.entry.addedAt);

  assert.throws(() => addTicket({ tickets: [] }, { key: "not-a-key" }), (e) => e.code === "ticket-key");
});

test("the list is one JSON document beside the queue, and a corrupt one is an error rather than an empty list", async (t) => {
  const dir = await tmp(t);
  assert.equal(ticketsPathFor(dir, "assistant-3"), path.join(dir, "assistants", "assistant-3", "tickets.json"));
  const file = ticketsPathFor(dir, "assistant-3");

  const empty = readTicketFile(file);
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.doc.tickets, []);
  assert.equal(empty.error, null);

  writeTicketFile(file, { assistantId: "assistant-3", tickets: [seeded()] });
  const back = readTicketFile(file);
  assert.equal(back.error, null);
  assert.equal(back.doc.assistantId, "assistant-3");
  assert.deepEqual(back.doc.tickets, [seeded()]);

  await writeFile(file, "{not json", "utf8");
  const broken = readTicketFile(file);
  assert.match(broken.error, /not valid JSON/);
  assert.deepEqual(broken.doc.tickets, [], "a caller that ignored the error must not see watches it could save over");
});

test("removeTicket takes one key and leaves the rest", () => {
  const doc = { tickets: [seeded(), seeded({ key: "SR-243582" })] };
  const out = removeTicket(doc, "sr-242996");
  assert.equal(out.removed, true);
  assert.deepEqual(out.doc.tickets.map((t) => t.key), ["SR-243582"]);
  assert.equal(removeTicket(out.doc, "SR-242996").removed, false);
});

// ---- 2/3. the baseline and the three event classes ------------------------------------------------------------

test("a key whose lastSeen is all nulls is a BASELINE: it raises nothing, even with comments on the ticket", () => {
  const out = classifyTicket(seeded(), issue({ comments: [comment(4212127, "Greene, Ernest", "[~Roper] are you good to go?")] }), { reader: READER });
  assert.equal(out.baseline, true);
  assert.deepEqual(out.events, []);
  assert.equal(out.changed, true, "the baseline snapshot is written, so the NEXT check has something to diff against");
  assert.deepEqual(out.entry.lastSeen, { commentId: "4212127", status: "Waiting for Customer", assignee: "Greene, Ernest", updated: AT });
});

test("only a NEW comment is an event: the ones at or below lastSeen.commentId are history", () => {
  const old = comment(4212127, "Greene, Ernest", "[~Roper] are you good to go?");
  const fresh = comment(4217187, "Roper, Jacob", "[~GREENE] the 5671 rule is working");
  const none = classifyTicket(seeded({ lastSeen: seen() }), issue({ comments: [old] }), { reader: READER });
  assert.deepEqual(none.events, []);
  assert.equal(none.changed, false);

  const one = classifyTicket(seeded({ lastSeen: seen() }), issue({ comments: [old, fresh] }), { reader: READER });
  assert.equal(one.events.length, 1);
  assert.equal(one.events[0].kind, "comment");
  assert.equal(one.events[0].id, "4217187");
  assert.equal(one.events[0].author, "Roper, Jacob");
  assert.equal(one.entry.lastSeen.commentId, "4217187");
});

test("a status change and an assignee change are events, and losing the assignee is a value", () => {
  const moved = classifyTicket(seeded({ lastSeen: seen() }), issue({ status: "In Progress", assignee: "Roth, Chris" }), { reader: READER });
  assert.deepEqual(moved.events.map((e) => [e.kind, e.from, e.to]), [
    ["status", "Waiting for Customer", "In Progress"],
    ["assignee", "Greene, Ernest", "Roth, Chris"],
  ]);

  const dropped = classifyTicket(seeded({ lastSeen: seen() }), issue({ assignee: null }), { reader: READER });
  assert.deepEqual(dropped.events.map((e) => [e.kind, e.from, e.to]), [["assignee", "Greene, Ernest", null]]);
  assert.equal(dropped.entry.lastSeen.assignee, null);
});

test("classifying the same issue twice raises the events once", () => {
  const withComment = issue({ comments: [comment(4217187, "Greene, Ernest", "[~Roper] ping")] });
  const first = classifyTicket(seeded({ lastSeen: seen() }), withComment, { reader: READER });
  assert.equal(first.events.length, 1);
  const second = classifyTicket(first.entry, withComment, { reader: READER });
  assert.deepEqual(second.events, []);
  assert.equal(second.changed, false, "nothing moved, so nothing is written and the file keeps its bytes");
});

// ---- 4. the addressed-to-the-reader test ----------------------------------------------------------------------

test("a mention of [~Roper] is addressed, and the card says the mention is why", () => {
  const out = addressedTo(comment(1, "Greene, Ernest", "[~Roper] give it a try now"), { reader: READER, status: "Waiting for Customer", assignee: "Greene, Ernest" });
  assert.equal(out.addressed, true);
  assert.match(out.why, /mentions \[~Roper\]/);
});

test("the reader's display name in the body is addressed", () => {
  const out = addressedTo(comment(1, "Greene, Ernest", "Roper, Jacob — can you check the DEV namespace?"), { reader: READER, status: "In Progress", assignee: "Greene, Ernest" });
  assert.equal(out.addressed, true);
  assert.deepEqual(out.tests, ["names Roper, Jacob"]);
});

test("a non-reader author on a Waiting for Customer ticket is addressed, and the test says so", () => {
  const out = addressedTo(comment(1, "Roth, Chris", "any update?"), { reader: READER, status: "Waiting for Customer", assignee: "Roth, Chris" });
  assert.equal(out.addressed, true);
  assert.match(out.why, /Roth, Chris is not you and the ticket is Waiting for Customer/);
});

test("a non-reader author on a ticket ASSIGNED to the reader is addressed", () => {
  const out = addressedTo(comment(1, "Roth, Chris", "any update?"), { reader: READER, status: "Product Specialist", assignee: "Roper, Jacob" });
  assert.equal(out.addressed, true);
  assert.match(out.why, /Roth, Chris is not you and the ticket is assigned to you/);
});

test("the reader's OWN comment is not addressed, and the card says which tests did not fire", () => {
  const out = addressedTo(comment(1, "Roper, Jacob", "[~GREENE] the rule works, thanks"), { reader: READER, status: "Waiting for Customer", assignee: "Greene, Ernest" });
  assert.equal(out.addressed, false);
  assert.deepEqual(out.tests, []);
  assert.match(out.why, /does not mention \[~Roper\]/);
  assert.match(out.why, /is you/);
});

test("a stranger's comment on a ticket neither Waiting for Customer nor assigned to the reader is not addressed", () => {
  const out = addressedTo(comment(1, "Roth, Chris", "moving this to the queue"), { reader: READER, status: "In Progress", assignee: "Roth, Chris" });
  assert.equal(out.addressed, false);
  assert.match(out.why, /is not you while the ticket is In Progress and assigned to Roth, Chris/);
});

// ---- 5. the card ----------------------------------------------------------------------------------------------

test("the row carries the key, what changed, the author and time, and the four options", () => {
  const event = classifyTicket(seeded({ lastSeen: seen() }), issue({ comments: [comment(4217187, "Greene, Ernest", "[~Roper] are you good to go?")] }), { reader: READER }).events[0];
  const row = ticketRowFor(event, { note: "DEV firewall rule" });
  assert.equal(row.title, "SR-242996 — new comment from Greene, Ernest");
  assert.match(row.detail, /Ticket SR-242996 — Firewall outgoing/);
  assert.match(row.detail, /Watch note: DEV firewall rule/);
  assert.match(row.detail, /comment #4217187 by Greene, Ernest at 2026-11-02 13:18:26/);
  assert.match(row.detail, /Addressed to you: yes — mentions \[~Roper\]/);
  assert.match(row.detail, /Ticket now: Waiting for Customer · assigned to Greene, Ernest/);
  assert.match(row.detail, new RegExp(`Options: ${OPTIONS.join(" · ")}`));
  assert.ok(row.detail.includes(eventMarker(event)), "the marker is how a retry recognises its own row");
  assert.ok(row.title.length <= 200 && row.detail.length <= 4000);
});

test("a status row says the move and needs no comment author", () => {
  const event = classifyTicket(seeded({ lastSeen: seen() }), issue({ status: "In Progress" }), { reader: READER }).events[0];
  const row = ticketRowFor(event);
  assert.equal(row.title, "SR-242996 — status Waiting for Customer → In Progress");
  assert.match(row.detail, /What changed: status Waiting for Customer → In Progress/);
  assert.match(row.detail, /Options: reply · chase the assignee · close · snooze/);
});

test("the wake text names the rows, the four options, and that Jira is untouched", () => {
  const events = classifyTicket(seeded({ lastSeen: seen() }), issue({ status: "In Progress", assignee: "Roth, Chris" }), { reader: READER }).events;
  const text = wakeTextFor({ key: "SR-242996", summary: "Firewall outgoing", events, rows: [{ id: 12 }, { id: 13 }] });
  assert.match(text, /^Ticket watch: SR-242996 moved/);
  assert.match(text, /status Waiting for Customer → In Progress/);
  assert.match(text, /assignee Greene, Ernest → Roth, Chris/);
  assert.match(text, /queue row #12, #13/);
  assert.match(text, /reply, chase the assignee, close, snooze/);
  assert.match(text, /Nothing has been written to Jira/);
});

// ---- 6. the wake door -----------------------------------------------------------------------------------------

function board({ enabled = true, assistants = [{ id: "assistant-1", name: "Assistant #1" }, { id: "assistant-3", name: "Assistant #3" }] } = {}) {
  const calls = [];
  const assistant = {
    assistants,
    wake: (text, alertId, rule, opts) => {
      calls.push({ text, alertId, rule, opts });
      return enabled ? { queued: true, pending: calls.length, assistantId: opts.assistantId } : { queued: false, refused: "disabled", assistantId: opts.assistantId };
    },
  };
  return { assistant, calls };
}

async function post(assistant, body, { method = "POST", route = "/api/ticket-watch/wake", authorised = () => true } = {}) {
  let answer = null;
  const routes = createTicketWatchRoutes({ assistant, config: { token: "t" }, sendJson: (_res, status, payload) => (answer = { status, body: payload }), readBody: async () => body, authorised });
  const handled = await routes({ method, url: route, headers: {} }, {}, route, new URL(route, "http://panel"));
  return { handled, answer };
}

test("POST /api/ticket-watch/wake calls the panel's own wake with the ticket rule and the assistant's id", async () => {
  const { assistant, calls } = board();
  const { handled, answer } = await post(assistant, { assistantId: "assistant-3", text: "Ticket watch: SR-242996 moved." });
  assert.equal(handled, true);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.queued, true);
  assert.deepEqual(calls, [{ text: "Ticket watch: SR-242996 moved.", alertId: null, rule: "ticket", opts: { assistantId: "assistant-3" } }]);
});

test("the door refuses what it cannot do, and the answer carries the reason", async () => {
  const { assistant } = board();
  assert.equal((await post(assistant, { text: "x" })).answer.status, 400, "no assistant id");
  assert.equal((await post(assistant, { assistantId: "assistant-3" })).answer.status, 400, "no text");
  assert.equal((await post(assistant, { assistantId: "assistant-9", text: "x" })).answer.status, 404, "an assistant this panel does not have — no fallback to #1");
  assert.equal((await post(assistant, { assistantId: "assistant-3", text: "x" }, { method: "GET" })).answer.status, 405);
  assert.equal((await post(assistant, { assistantId: "assistant-3", text: "x" }, { authorised: () => false })).answer.status, 403);

  const off = board({ enabled: false });
  const refused = await post(off.assistant, { assistantId: "assistant-3", text: "x" });
  assert.equal(refused.answer.status, 409);
  assert.equal(refused.answer.body.refused, "disabled");
  assert.match(refused.answer.body.error, /switched off/);

  const other = await post(assistant, {}, { route: "/api/assistant/queue" });
  assert.equal(other.handled, false, "another route's path is not this module's to answer");
});
