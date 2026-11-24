// The Clarify popup's RE-ASK: the reader's one press on a question they missed, and everything that must be true for it
// to be safe to offer.
//
// What these pin down, and why each is its own test:
//
//   THE QUOTE IS THE STORED ONE. The popup draws a question through `oneLine(..., 400)` (public/core/clarify-history.js
//   `questionLine`), which cuts it at 400 characters and folds every newline to a space. A body built from that line is
//   a mutilated question, so the text is built from the record and `reaskQuoteCheck` refuses a body that lost a byte.
//   The first test proves both halves: the display line is NOT contained in the body, and the stored question (newlines
//   and all) IS, with every choice.
//
//   ONE SEND PER ITEM. `beginReask` claims synchronously, so two presses that arrive together cannot both send, and
//   `finishReask` writes the record to the file - a second press after a restart is refused by the same record.
//
//   THE OTHER GUARDS, each named: an ANSWERED item has no button (and the route refuses it), a thread holding a LIVE run
//   is refused, and a thread the panel no longer holds is refused with its own sentence instead of sending into nothing.
//
// The route is driven through `createClarifyHistoryRoutes` with its own transport helpers and a sender that records what
// it was handed - the shipped module, not a copy of its logic.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ClarifyHistory,
  collapseItems,
  readerReplies,
  reaskDigest,
  reaskQuoteCheck,
  reaskText,
  REASK_LINE,
  withReplyEvidence,
} from "../lib/clarify-history.js";
import { createClarifyHistoryRoutes } from "../routes/clarify-history.js";
import "../public/core/clarify-history.js";

const Core = globalThis.wtClarifyHistory;
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.UTC(2026, 0, 2, 12);

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "clarify-reask-"));
  return { dir, file: path.join(dir, "clarify-history.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// A question longer than the popup's 400-character line, with newlines, a fence inside it and choices. This is the
// shape the trap is about: a quote from the display line loses the tail, the newlines and the fence.
const LONG = [
  "The turnover branch is two commits ahead of main and the pair of docs pages I drafted are not in either of them.",
  "",
  "Here is the block I mean (it is inside the tree, at docs/reports/plan.html):",
  "",
  "```",
  "<h1>the plan</h1>",
  "```",
  "",
  "The first commit is a version bump and the second is a changelog render, and neither one names the rows the reader",
  "asked about. Should the next turn land the docs pair on this branch before the PR, or wait for the render to catch",
  "up with main so the PR reads one commit instead of three? I have the branch checked out and the tree is clean.",
].join("\n");
const CHOICES = ["land the docs pair first", "wait for the render to catch up", "land it as it is"];

function ask(store, n, over = {}) {
  return store.ask({
    key: `clarify:job-${n}:prompt-${n}`,
    requestId: `prompt-${n}`,
    jobId: `job-${n}`,
    thread: `thread-${n}`,
    agent: `agent ${n}`,
    tree: `tree-${n}`,
    assistantId: "assistant-1",
    assistantName: "Assistant #1",
    question: `question ${n}?`,
    choices: ["yes", "no"],
    askedAt: iso(NOW),
    ...over,
  });
}

function close(store, n, why = "timed out", at = NOW + 60_000) {
  return store.closed(`clarify:job-${n}:prompt-${n}`, { why, at: iso(at) });
}

// ---- the quote --------------------------------------------------------------------------------------------------
test("the re-ask body carries the STORED question byte for byte, newlines and choices, not the 400-char display line", () => {
  const entry = { question: LONG, choices: CHOICES, multiSelect: true };
  const text = reaskText(entry);
  assert.ok(text.startsWith(REASK_LINE), "the reader's line is the first line of the body");
  assert.ok(text.includes(LONG), "the stored question is contained byte for byte");
  assert.ok(LONG.length > 400, `the fixture is longer than the display line (${LONG.length} chars)`);
  // The trap, made explicit: the line the POPUP draws cannot pass for a quote.
  const drawn = Core.questionLine(entry);
  assert.equal(drawn.includes("\n"), false, "the display line folds newlines away");
  assert.ok(!text.includes(`${drawn}\u0000`), "the display line is not what the body was built from");
  assert.ok(!text.includes(`${drawn}.`), "sanity: no punctuation trick makes the drawn line a quote");
  for (const c of CHOICES) assert.ok(text.includes(c), `the choice ${JSON.stringify(c)} is quoted`);
  assert.ok(text.includes("Choices (choose any):"), "a multi-select question says the choices are not one-of");
  assert.deepEqual(reaskQuoteCheck(entry, text), { ok: true, missing: [] });
});

test("a body that lost the question, a choice or the line is REFUSED, never sent", () => {
  const entry = { question: LONG, choices: CHOICES };
  const drawn = Core.questionLine(entry);
  const truncated = `${REASK_LINE}\n\n${drawn}`;
  const bad = reaskQuoteCheck(entry, truncated);
  assert.equal(bad.ok, false, "the display line is not a quote");
  assert.ok(bad.missing.some((m) => /byte for byte/.test(m)), `the refusal names the missing question: ${bad.missing.join("; ")}`);

  const noChoice = `${REASK_LINE}\n\n${LONG}`;
  const dropped = reaskQuoteCheck(entry, noChoice);
  assert.equal(dropped.ok, false, "a choice the reader was shown has to ride with the question");
  assert.ok(dropped.missing.some((m) => m.includes(CHOICES[1])));

  assert.equal(reaskQuoteCheck(entry, LONG).ok, false, "the reader's line is part of the body, not decoration");
  assert.equal(reaskText({ question: "   " }), "", "a record with no question produces no body at all");
});

test("a fence inside the question cannot close the quote early", () => {
  const entry = { question: "before\n```\ninside\n```\nafter", choices: [] };
  const text = reaskText(entry);
  const fence = text.split("\n")[2];
  assert.ok(fence.length > 3, `the fence is longer than the question's own run (got ${fence})`);
  const quoted = baseline(text);
  assert.equal(quoted, entry.question, "the fenced block holds exactly the question");
});

// The fenced block's contents: the body's fence line, then up to the matching fence.
function baseline(text) {
  const lines = text.split("\n");
  const fence = lines[2];
  const end = lines.indexOf(fence, 3);
  return lines.slice(3, end).join("\n");
}

// ---- the store's one-send record --------------------------------------------------------------------------------
test("one send per item: the claim refuses a second press before anything is awaited", () => {
  const t = tempFile();
  try {
    const s = new ClarifyHistory({ file: t.file });
    ask(s, 1);
    close(s, 1);
    const entry = s.find("clarify:job-1:prompt-1");
    assert.deepEqual(s.beginReask(entry), { ok: true });
    const second = s.beginReask(entry);
    assert.equal(second.ok, false, "a claim in flight refuses the next press");
    assert.equal(second.pending, true);

    s.finishReask(entry, { at: iso(NOW + 120_000), jobId: "job-reask", thread: "thread-1", text: reaskText(entry) });
    const record = s.reaskFor(entry);
    assert.equal(record.jobId, "job-reask");
    assert.equal(record.thread, "thread-1");
    assert.equal(record.chars, reaskText(entry).length);
    assert.equal(record.sha256, reaskDigest(reaskText(entry)));
    assert.equal(s.beginReask(entry).ok, false, "the durable record refuses a second send after the first");

    // It is in the FILE: a restarted panel reads the same record and refuses the same press.
    const raw = JSON.parse(readFileSync(t.file, "utf8"));
    assert.equal(raw.entries[0].reask.jobId, "job-reask");
    const again = new ClarifyHistory({ file: t.file });
    assert.equal(again.reaskFor(again.find("clarify:job-1:prompt-1")).jobId, "job-reask");

    // A refused send records nothing and leaves no claim behind.
    const other = ask(s, 2, { question: "another?" });
    close(s, 2);
    assert.equal(s.beginReask(other).ok, true);
    s.abandonReask(other);
    assert.equal(other.reask, null);
    assert.equal(s.beginReask(other).ok, true, "a released claim can be taken again");
    s.abandonReask(other);
  } finally {
    t.done();
  }
});

test("the record rides the collapsed item, and an answered item never grows one", () => {
  const s = new ClarifyHistory({});
  ask(s, 1);
  close(s, 1);
  const done = s.find("clarify:job-1:prompt-1");
  s.beginReask(done);
  s.finishReask(done, { jobId: "job-reask", thread: "thread-1", text: reaskText(done) });
  // A re-asked question that comes back (same words, same agent) stays ONE item, and the record stays with it.
  ask(s, 2, { thread: "thread-1", agent: "agent 1", question: "question 1?", askedAt: iso(NOW + 180_000) });
  const [item] = s.items().items;
  assert.equal(item.state, "open");
  assert.equal(item.reask?.jobId, "job-reask", "the record travels with the collapsed item");

  ask(s, 3);
  s.answered("clarify:job-3:prompt-3", { answer: "yes" });
  const answered = s.items().items.find((i) => i.state === "answered");
  assert.equal(answered.reask, null, "an answered item carries no re-ask record");
  assert.deepEqual(
    collapseItems(s.list().entries).find((i) => i.seq === answered.seq).reask,
    null,
  );
});

// ---- the route --------------------------------------------------------------------------------------------------
function harness({ entries = [], threadExists = (t) => t.startsWith("thread-"), busy = () => ({ held: false }) } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "clarify-reask-route-"));
  const store = new ClarifyHistory({ file: path.join(dir, "clarify-history.json") });
  for (const e of entries) store.ask(e);
  const sent = [];
  const answers = [];
  let n = 0;
  // Each answer is tied to the RESPONSE object of its own request, because two concurrent presses finish in the order
  // the event loop decides, not the order they were sent.
  const sendJson = (res, status, body) => answers.push({ res, status, body });
  const jobs = {
    clarifyHistory: store,
    list: () => [],
    firstOfThread: (thread) => (threadExists(thread) ? { id: "job-1", thread } : null),
    busyFor: busy,
    onLog: () => {},
  };
  let fail = null;
  const sendReask = async ({ entry, text, thread }) => {
    sent.push({ entry, text, thread });
    n += 1;
    if (fail) return fail;
    return { ok: true, job: { id: `job-reask-${n}`, thread }, at: iso(NOW + n * 1000) };
  };
  const routes = createClarifyHistoryRoutes({
    jobs,
    sendJson,
    readBody: async (req) => req.__body || {},
    authorised: () => true,
    config: {},
    sendReask,
  });
  const call = async (seq) => {
    const req = { method: "POST", url: "/api/clarify/reask", __body: { seq } };
    const res = {};
    const handled = await routes(req, res, "/api/clarify/reask", new URL("http://127.0.0.1/api/clarify/reask"));
    assert.equal(handled, true, "the route owns its own path");
    const mine = answers.find((a) => a.res === res);
    assert.ok(mine, "the route answered this request");
    return mine;
  };
  return { store, sent, call, jobs, dir, done: () => rmSync(dir, { recursive: true, force: true }), failWith: (f) => { fail = f; } };
}

test("a MISSED item is re-asked in one POST, in its own thread, with the stored question", async () => {
  const h = harness({
    entries: [
      {
        key: "clarify:job-1:prompt-1",
        requestId: "prompt-1",
        jobId: "job-1",
        thread: "thread-1",
        agent: "agent 1",
        question: LONG,
        choices: CHOICES,
        askedAt: iso(NOW),
      },
    ],
  });
  try {
    h.store.closed("clarify:job-1:prompt-1", { why: "timed out", at: iso(NOW + 300_000) });
    const out = await h.call(1);
    assert.equal(out.status, 202, JSON.stringify(out.body));
    assert.equal(out.body.ok, true);
    assert.equal(h.sent.length, 1, "one press, one send");
    assert.equal(h.sent[0].thread, "thread-1", "the SAME thread the question was asked in");
    assert.equal(h.sent[0].text, reaskText(h.store.find("clarify:job-1:prompt-1")));
    assert.ok(h.sent[0].text.includes(LONG), "the send carries the whole stored question");
    for (const c of CHOICES) assert.ok(h.sent[0].text.includes(c), `the send carries ${JSON.stringify(c)}`);
    assert.equal(out.body.text, h.sent[0].text, "the answer hands the page the body it sent");
    assert.equal(out.body.reask.jobId, "job-reask-1", "the record names the turn the re-asked card will be asked in");
    assert.equal(h.store.find("clarify:job-1:prompt-1").reask.jobId, "job-reask-1", "and the store keeps it");

    // THE SECOND PRESS: the record refuses it, and nothing is sent.
    const twice = await h.call(1);
    assert.equal(twice.status, 409, JSON.stringify(twice.body));
    assert.equal(twice.body.code, "already_reasked");
    assert.equal(twice.body.already, true);
    assert.match(twice.body.error, /already re-asked/);
    assert.equal(h.sent.length, 1, "a second press sends nothing");

    // The popup draws the record instead of the button, from the same item the route read.
    const [item] = h.store.items().items;
    assert.equal(item.reask.jobId, "job-reask-1");
  } finally {
    h.done();
  }
});

test("two presses that arrive together send ONCE", async () => {
  const h = harness({
    entries: [{ key: "clarify:job-1:prompt-1", jobId: "job-1", thread: "thread-1", agent: "agent 1", question: LONG, choices: CHOICES, askedAt: iso(NOW) }],
  });
  try {
    h.store.closed("clarify:job-1:prompt-1", { why: "timed out", at: iso(NOW + 60_000) });
    // The first POST is inside its await when the second arrives; the claim is what decides.
    const [a, b] = await Promise.all([h.call(1), h.call(1)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [202, 409], `one accepted, one refused (got ${statuses})`);
    assert.equal(h.sent.length, 1, "exactly one run was started");
  } finally {
    h.done();
  }
});

test("an ANSWERED item is refused: the button is not drawn, and the route refuses what the page never offers", async () => {
  const h = harness({
    entries: [{ key: "clarify:job-1:prompt-1", jobId: "job-1", thread: "thread-1", agent: "agent 1", question: "which?", choices: ["a", "b"], askedAt: iso(NOW) }],
  });
  try {
    h.store.answered("clarify:job-1:prompt-1", { answer: "b", by: "reader", at: iso(NOW + 60_000) });
    const out = await h.call(1);
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.code, "answered");
    assert.match(out.body.error, /was answered/);
    assert.equal(h.sent.length, 0, "nothing was sent for an answered question");
  } finally {
    h.done();
  }
});

test("a thread holding a LIVE run is refused by name, and nothing is sent", async () => {
  const h = harness({
    entries: [{ key: "clarify:job-1:prompt-1", jobId: "job-1", thread: "thread-1", agent: "agent 1", question: "which?", choices: [], askedAt: iso(NOW) }],
    busy: () => ({ held: true, where: "thread", thread: "thread-1", by: [{ id: "job-live", thread: "thread-1", status: "running" }] }),
  });
  try {
    h.store.closed("clarify:job-1:prompt-1", { why: "timed out", at: iso(NOW + 60_000) });
    const out = await h.call(1);
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.code, "thread_busy");
    assert.match(out.body.error, /already has a live run/);
    assert.match(out.body.error, /job-live/);
    assert.equal(h.sent.length, 0, "a live thread gets no second run");
    assert.equal(h.store.find("clarify:job-1:prompt-1").reask, null, "a refusal records no re-ask");
  } finally {
    h.done();
  }
});

test("a session that is gone is refused plainly instead of sending into nothing", async () => {
  const h = harness({
    entries: [{ key: "clarify:job-1:prompt-1", jobId: "job-1", thread: "thread-gone", agent: "agent 1", question: "which?", choices: [], askedAt: iso(NOW) }],
    threadExists: () => false,
  });
  try {
    h.store.closed("clarify:job-1:prompt-1", { why: "the turn ended", at: iso(NOW + 60_000) });
    const out = await h.call(1);
    assert.equal(out.status, 404, JSON.stringify(out.body));
    assert.equal(out.body.code, "unknown_thread");
    assert.match(out.body.error, /no longer on this board/);
    assert.match(out.body.error, /thread-gone/);
    assert.equal(h.sent.length, 0);
  } finally {
    h.done();
  }
});

test("a question that fell off the store is a 404, not a quote of nothing", async () => {
  const h = harness({ entries: [] });
  try {
    const out = await h.call(42);
    assert.equal(out.status, 404, JSON.stringify(out.body));
    assert.equal(out.body.code, "clarify_gone");
    assert.equal(h.sent.length, 0);
  } finally {
    h.done();
  }
});

test("a sender's refusal is answered with its own status and records nothing", async () => {
  const h = harness({
    entries: [{ key: "clarify:job-1:prompt-1", jobId: "job-1", thread: "thread-1", agent: "agent 1", question: "which?", choices: [], askedAt: iso(NOW) }],
  });
  try {
    h.store.closed("clarify:job-1:prompt-1", { why: "timed out", at: iso(NOW + 60_000) });
    h.failWith({ ok: false, status: 409, code: "tree_busy", error: "that worktree already has a live run" });
    const out = await h.call(1);
    assert.equal(out.status, 409);
    assert.equal(out.body.code, "tree_busy");
    assert.equal(h.store.find("clarify:job-1:prompt-1").reask, null, "a refused send leaves no record");
    // …and the next press may try again, because the claim was released.
    h.failWith(null);
    const again = await h.call(1);
    assert.equal(again.status, 202, JSON.stringify(again.body));
  } finally {
    h.done();
  }
});

test("the re-ask's OWN turn is not evidence of an answer, so the row stays missed after the button is used", () => {
  const at = Date.UTC(2026, 0, 2, 10);
  const closedItem = {
    seq: 1,
    key: "clarify:j1:p1",
    jobId: "j1",
    thread: "th-a",
    agent: "agent a",
    question: "which one?",
    askedAt: iso(at),
    closedAt: iso(at + 60_000),
    closedWhy: "timed out",
    status: "closed",
    attempts: [],
  };
  const item = { ...closedItem, attempts: [closedItem], state: "closed" };
  const reaskTurn = { id: "j2", thread: "th-a", reply: true, startedAt: iso(at + 120_000), origin: { kind: "clarify-reask", by: "reader" }, prompt: "please re-ask" };
  const realReply = { id: "j3", thread: "th-a", reply: true, startedAt: iso(at + 180_000), origin: { kind: "assistant-reply", by: "reader" }, prompt: "yes, do it" };

  assert.deepEqual(readerReplies([reaskTurn]), [], "a re-ask turn is the reader's, and it is not an answer");
  assert.equal(readerReplies([reaskTurn, realReply]).length, 1, "a real reply turn still counts");

  // With only the re-ask turn on the store the item is still missed, and the popup keeps the record instead of the
  // button.
  const after = withReplyEvidence([{ ...item }], readerReplies([reaskTurn]));
  assert.equal(after[0].state, "closed", "using the button does not make the question look answered");
  assert.equal(after[0].reply, undefined, "and it points at no reply turn");
});

test("the read hands the popup each item's re-ask record, so the button cannot be drawn twice", async () => {
  const h = harness({
    entries: [{ key: "clarify:job-1:prompt-1", jobId: "job-1", thread: "thread-1", agent: "agent 1", question: "which?", choices: [], askedAt: iso(NOW) }],
  });
  try {
    h.store.closed("clarify:job-1:prompt-1", { why: "timed out", at: iso(NOW + 60_000) });
    const answer = [];
    const routes = createClarifyHistoryRoutes({
      jobs: h.jobs,
      sendJson: (res, status, body) => answer.push({ status, body }),
      readBody: async (req) => req.__body || {},
      authorised: () => true,
      sendReask: async () => ({ ok: true, job: { id: "job-reask-1", thread: "thread-1" } }),
    });
    await routes({ method: "POST", url: "/api/clarify/reask", __body: { seq: 1 } }, {}, "/api/clarify/reask", new URL("http://127.0.0.1/api/clarify/reask"));
    await routes({ method: "GET", url: "/api/clarify/history" }, {}, "/api/clarify/history", new URL("http://127.0.0.1/api/clarify/history"));
    const read = answer[answer.length - 1].body;
    assert.equal(read.items[0].reask.jobId, "job-reask-1");
    assert.equal(read.total, 1);
  } finally {
    h.done();
  }
});
