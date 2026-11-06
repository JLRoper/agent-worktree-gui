// The ticket watch, driven directly: no server, no Jira, no network. `lib/ticket-watch.js` owns the list, the diff
// and the wake's words, and every one of those is a function this file can hand an argument to - which is the whole
// reason the Jira GET and the HTTP call live in tools/ticket-watch.mjs instead.
//
// What this pins, in the order the brief lists it:
//   1. the LIST: one file per assistant beside its queue, entries exactly `{key, note, addedAt, lastSeen}`, a
//      re-add keeping the baseline, a corrupt file reported as an error rather than read as empty;
//   2. the BASELINE: a key whose `lastSeen` is all nulls raises nothing, so adding a ticket is never a burst of
//      wakes about history the reader has already read;
//   3. the three MOVEMENT CLASSES: a new comment (and only a NEW one), a status change, an assignee change - with
//      "unassigned" a value rather than an absence;
//   4. MOVEMENT ONLY: two comments, one that names the reader and one that does not, produce the same event shape
//      and the same wake words. The poller decides nothing about relevance, and there is no addressed test left to
//      call;
//   5. the WAKE: the ticket key, what moved, the command that reads the ticket, and the instruction to judge it -
//      with no verdict and no options;
//   6. IDEMPOTENCE: the same issue classified twice raises nothing the second time and marks no write;
//   7. the WAKE DOOR: `POST /api/ticket-watch/wake` calls `assistant.wake(text, null, "ticket", {assistantId})` -
//      the panel's own ladder, no second path - and carries a refusal (switched off) back as a value;
//   8. the SEED: the four Optym SRs at the repo root, which is what `seed` loads.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MOVEMENT_KINDS,
  addTicket,
  classifyTicket,
  createTicketWatchRoutes,
  isBaseline,
  movementLine,
  readTicketFile,
  removeTicket,
  ticketsPathFor,
  wakeTextFor,
  writeTicketFile,
} from "../lib/ticket-watch.js";

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
  assert.equal(first.changed, true);
  assert.deepEqual(first.entry.lastSeen, { commentId: null, status: null, assignee: null, updated: null });
  assert.equal(first.entry.addedAt, at.toISOString());

  // The baseline is a fact about the ticket, not about the note: re-adding is how a note is edited, and it must
  // not re-raise every comment the reader has already seen.
  const withSeen = { ...first.doc, tickets: [{ ...first.entry, lastSeen: seen() }] };
  const again = addTicket(withSeen, { key: "SR-242996", note: "renamed note", at });
  assert.equal(again.added, false);
  assert.equal(again.changed, true, "the note moved, so the file is worth writing");
  assert.equal(again.entry.note, "renamed note");
  assert.deepEqual(again.entry.lastSeen, seen());
  assert.equal(again.entry.addedAt, first.entry.addedAt);

  const same = addTicket(again.doc, { key: "SR-242996", note: "renamed note", at });
  assert.equal(same.changed, false, "re-seeding an unchanged list must not rewrite it");

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

// ---- 2/3. the baseline and the three movement classes ---------------------------------------------------------

test("a key whose lastSeen is all nulls is a BASELINE: it raises nothing, even with comments on the ticket", () => {
  const out = classifyTicket(seeded(), issue({ comments: [comment(4212127, "Greene, Ernest", "[~Roper] are you good to go?")] }));
  assert.equal(out.baseline, true);
  assert.equal(isBaseline(seeded()), true);
  assert.deepEqual(out.events, []);
  assert.equal(out.changed, true, "the baseline snapshot is written, so the NEXT check has something to diff against");
  assert.deepEqual(out.entry.lastSeen, { commentId: "4212127", status: "Waiting for Customer", assignee: "Greene, Ernest", updated: AT });
});

test("only a NEW comment is a movement: the ones at or below lastSeen.commentId are history", () => {
  const old = comment(4212127, "Greene, Ernest", "[~Roper] are you good to go?");
  const fresh = comment(4217187, "Roper, Jacob", "[~GREENE] the 5671 rule is working");
  const none = classifyTicket(seeded({ lastSeen: seen() }), issue({ comments: [old] }));
  assert.deepEqual(none.events, []);
  assert.equal(none.changed, false);

  const one = classifyTicket(seeded({ lastSeen: seen() }), issue({ comments: [old, fresh] }));
  assert.equal(one.events.length, 1);
  assert.equal(one.events[0].kind, "comment");
  assert.equal(one.events[0].id, "4217187");
  assert.equal(one.events[0].author, "Roper, Jacob");
  assert.equal(one.events[0].length, fresh.body.length);
  assert.equal(one.entry.lastSeen.commentId, "4217187");
});

test("a status change and an assignee change are movements, and losing the assignee is a value", () => {
  const moved = classifyTicket(seeded({ lastSeen: seen() }), issue({ status: "In Progress", assignee: "Roth, Chris" }));
  assert.deepEqual(moved.events.map((e) => [e.kind, e.from, e.to]), [
    ["status", "Waiting for Customer", "In Progress"],
    ["assignee", "Greene, Ernest", "Roth, Chris"],
  ]);

  const dropped = classifyTicket(seeded({ lastSeen: seen() }), issue({ assignee: null }));
  assert.deepEqual(dropped.events.map((e) => [e.kind, e.from, e.to]), [["assignee", "Greene, Ernest", null]]);
  assert.equal(dropped.entry.lastSeen.assignee, null);
});

test("the three classes are the only three, and every movement is one of them", () => {
  assert.deepEqual([...MOVEMENT_KINDS], ["comment", "status", "assignee"]);
  const all = classifyTicket(
    seeded({ lastSeen: seen() }),
    issue({ status: "In Progress", assignee: "Roth, Chris", comments: [comment(4217187, "Greene, Ernest", "ping")] }),
  );
  assert.deepEqual(all.events.map((e) => e.kind).sort(), ["assignee", "comment", "status"]);
});

// ---- 4. movement only: the poller does not judge ---------------------------------------------------------------

test("a comment that names the reader and one that does not produce the SAME event shape and the SAME words", () => {
  const named = classifyTicket(seeded({ lastSeen: seen() }), issue({ comments: [comment(4217187, "Greene, Ernest", "[~Roper] can you connect now?")] })).events[0];
  const ignored = classifyTicket(seeded({ lastSeen: seen() }), issue({ comments: [comment(4217187, "Roth, Chris", "moving this to the queue")] })).events[0];

  // The keys are identical and there is no verdict among them: no `addressed`, no `why`, no `options`, no severity.
  assert.deepEqual(Object.keys(named).sort(), Object.keys(ignored).sort());
  for (const banned of ["addressed", "why", "tests", "options", "severity"]) {
    assert.equal(banned in named, false, `the event must carry no ${banned}`);
  }
  const shape = (line) => line.replace(/from .*? at /, "from <author> at ").replace(/, \d+ characters$/, ", <n> characters");
  assert.equal(shape(movementLine(named)), shape(movementLine(ignored)), "the one line the assistant reads has the same wording for both");
  assert.match(movementLine(named), /^new comment #4217187 from Greene, Ernest at 2026-11-02 13:18:26/);

  // The wake text is the same too, apart from the author the movement itself names.
  const text = wakeTextFor({ key: "SR-242996", summary: "Firewall", events: [named] });
  assert.doesNotMatch(text, /addressed/i);
  assert.doesNotMatch(text, /does not mention/i);
});

// ---- 5. the wake ------------------------------------------------------------------------------------------------

test("the wake names the key, every movement, the command that reads the ticket and the judgement to make", () => {
  const events = classifyTicket(seeded({ lastSeen: seen() }), issue({ status: "In Progress", assignee: "Roth, Chris" })).events;
  const text = wakeTextFor({ key: "SR-242996", summary: "Firewall outgoing", events });
  assert.match(text, /^Ticket watch: SR-242996 moved - Firewall outgoing\./);
  assert.match(text, /status Waiting for Customer → In Progress/);
  assert.match(text, /assignee Greene, Ernest → Roth, Chris/);
  assert.match(text, /node tools\/ticket-watch\.mjs show SR-242996/);
  assert.match(text, /https:\/\/jira\.sefl\.com\/browse\/SR-242996/);
  assert.match(text, /Reported as movement only/);
  assert.match(text, /raise a clarify card only if the movement leaves the reader a decision to make/);
  assert.match(text, /docs\/ticket-watch\.md/);
  assert.match(text, /Nothing has been written to Jira/);
  assert.doesNotMatch(text, /queue row/, "the poller puts nothing in front of the reader");
});

test("the wake clip holds and a comment movement names its id, author, time and size", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ key: "SR-242996", kind: "comment", id: String(4217200 + i), summary: "x", at: AT, author: "Greene, Ernest", length: 12, excerpt: "hi" }));
  const text = wakeTextFor({ key: "SR-242996", summary: "x", events: many });
  assert.ok(text.length <= 4000);
  assert.match(text, /new comment #4217200 from Greene, Ernest at 2026-11-02 13:18:26, 12 characters/);
});

// ---- 6. idempotence ---------------------------------------------------------------------------------------------

test("classifying the same issue twice raises the movements once, and the second pass marks no write", () => {
  const withComment = issue({ comments: [comment(4217187, "Greene, Ernest", "[~Roper] ping")] });
  const first = classifyTicket(seeded({ lastSeen: seen() }), withComment);
  assert.equal(first.events.length, 1);
  assert.equal(first.changed, true);
  const second = classifyTicket(first.entry, withComment);
  assert.deepEqual(second.events, []);
  assert.equal(second.changed, false, "nothing moved, so nothing is written and the file keeps its bytes");
  assert.equal(second.snapshotMoved, false);
});

test("a Jira `updated` stamp that moves alone is not a write and never a wake", () => {
  const later = issue({ updated: "2026-11-06T09:00:00.000-0500", comments: [comment(4212127, "Greene, Ernest", "hi")] });
  const out = classifyTicket(seeded({ lastSeen: seen() }), later);
  assert.deepEqual(out.events, []);
  assert.equal(out.changed, false, "an untracked edit (a description, a link) must not rewrite the list");
  assert.equal(out.snapshotMoved, true);
  assert.equal(out.entry.lastSeen.updated, "2026-11-06T09:00:00.000-0500");
});

// ---- 7. the wake door -------------------------------------------------------------------------------------------

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
  assert.equal((await post(assistant, { assistantId: "assistant-9", text: "x" })).answer.status, 404, "an assistant this panel does not have - no fallback to #1");
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

// ---- 8. the seed ------------------------------------------------------------------------------------------------

test("the seed carries the four Optym SRs, and addTicket accepts every one of them", () => {
  const seed = JSON.parse(readFileSync(new URL("../ticket-watch.seed.json", import.meta.url), "utf8"));
  assert.deepEqual(seed.tickets.map((t) => t.key), ["SR-242996", "SR-242997", "SR-243582", "SR-243583"]);
  let doc = { version: 1, tickets: [] };
  for (const t of seed.tickets) doc = addTicket(doc, { key: t.key, note: t.note }).doc;
  assert.equal(doc.tickets.length, 4);
  assert.ok(doc.tickets.every((t) => t.lastSeen.commentId === null), "a seeded key starts as a baseline");
});
