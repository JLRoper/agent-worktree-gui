// The clarify history: the store (lib/clarify-history.js), its pure page half (public/core/clarify-history.js) and the
// two seams in Jobs that write it (a prompt arriving, and a prompt closing with no answer).
//
// What these pin down, in the order the brief names them: the ORDER (newest first, one record per prompt however often
// it is re-asked), the THREE STATES (open, answered, closed, and that "closed" can never read as answered), and the CAP
// (50 drawn of 137 kept, with the total always the store's own). The seams are driven through a real Jobs over a temp
// directory, so a change that stops recording the ask, the answer or the reason fails here rather than in the browser.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClarifyHistory, CLARIFY_HISTORY_KEEP, clarifyHistoryEntry, clarifyItems, closedWhyFor, collapseItems, collapseKey, outstandingOf, readerReplies } from "../lib/clarify-history.js";
import { createClarifyHistoryRoutes } from "../routes/clarify-history.js";
import { Jobs } from "../lib/jobs.js";
import "../public/core/clarify-history.js";

const Core = globalThis.wtClarifyHistory;
const quiet = () => {};
const iso = (ms) => new Date(ms).toISOString();

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "clarify-history-"));
  return { dir, file: path.join(dir, "clarify-history.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

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
    choices: ["one", "two"],
    askedAt: iso(Date.UTC(2026, 0, 1, 0, n)),
    ...over,
  });
}

// ---- ordering ---------------------------------------------------------------------------------------------------
test("the list is newest first and keeps one record per prompt when it is re-asked", () => {
  const s = new ClarifyHistory({});
  ask(s, 1);
  ask(s, 2);
  ask(s, 3);
  assert.deepEqual(s.list().entries.map((e) => e.seq), [3, 2, 1]);
  assert.deepEqual(s.list().entries.map((e) => e.jobId), ["job-3", "job-2", "job-1"]);

  // The same prompt, re-asked: no second row, the question text is the newer one, and the order does not move.
  s.ask({ ...askFields(s, 2), question: "question 2, asked again?", reasks: 2 });
  const rows = s.list().entries;
  assert.equal(rows.length, 3, "a re-ask must not invent a second row for one prompt");
  assert.equal(rows.find((e) => e.jobId === "job-2").question, "question 2, asked again?");
  assert.equal(rows.find((e) => e.jobId === "job-2").reasks, 2);
  assert.deepEqual(rows.map((e) => e.seq), [3, 2, 1]);
});

function askFields(s, n) {
  const row = s.list().entries.find((e) => e.jobId === `job-${n}`);
  return {
    key: row.key,
    requestId: row.requestId,
    jobId: row.jobId,
    thread: row.thread,
    agent: row.agent,
    tree: row.tree,
    assistantId: row.assistantId,
    assistantName: row.assistantName,
    question: row.question,
    choices: row.choices,
    askedAt: row.askedAt,
  };
}

test("a store written to disk reads back in the same order, after a restart", () => {
  const t = tempFile();
  try {
    const first = new ClarifyHistory({ file: t.file });
    ask(first, 1);
    ask(first, 2);
    first.answered("clarify:job-2:prompt-2", { answer: "two", by: "reader", at: iso(Date.UTC(2026, 0, 1, 1)) });
    const again = new ClarifyHistory({ file: t.file });
    const rows = again.list().entries;
    assert.deepEqual(rows.map((e) => e.seq), [2, 1]);
    assert.equal(rows[0].status, "answered");
    assert.equal(rows[0].answer, "two");
    assert.equal(rows[0].answeredBy, "reader");
    assert.equal(rows[1].status, "open");
    // The file is the only thing that carried it, and it is valid JSON on its own.
    assert.equal(JSON.parse(readFileSync(t.file, "utf8")).version, 1);
  } finally {
    t.done();
  }
});

// ---- the three states -------------------------------------------------------------------------------------------
test("an answer records what, who and when; a closed question records why and never reads as answered", () => {
  const s = new ClarifyHistory({});
  ask(s, 1, { askedAt: "2026-01-01T00:00:00.000Z" });
  ask(s, 2, { askedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(Core.stateOf(s.find("clarify:job-1:prompt-1")), "open");
  assert.equal(Core.stateOf(s.find("clarify:job-2:prompt-2")), "open");

  s.answered("clarify:job-1:prompt-1", { answer: "two", by: "reader", at: "2026-01-01T00:16:00.000Z" });
  const answered = s.find("clarify:job-1:prompt-1");
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "two");
  assert.equal(answered.answeredBy, "reader");
  assert.equal(answered.answeredAt, "2026-01-01T00:16:00.000Z");
  // An answered row reads as answered, and its "when" line is the answer's own.
  assert.equal(Core.answerText(answered), "two");
  assert.match(Core.ageText({ askedAt: answered.answeredAt }, Date.parse("2026-01-01T00:20:00.000Z")), /4m ago/);

  s.closed("clarify:job-2:prompt-2", { why: "cancelled", at: "2026-01-01T00:16:00.000Z" });
  const closed = s.find("clarify:job-2:prompt-2");
  assert.equal(closed.status, "closed");
  assert.equal(closed.answer, "", "a closed question must not carry an answer");
  assert.equal(Core.closedLine(closed), "cancelled after 16m");

  // Closing an answered question cannot overwrite the answer with a grey row.
  s.closed("clarify:job-1:prompt-1", { why: "cancelled", at: "2026-01-01T00:30:00.000Z" });
  assert.equal(s.find("clarify:job-1:prompt-1").status, "answered");
  assert.equal(s.find("clarify:job-1:prompt-1").answer, "two");
});

test("the closed word follows the cause it can defend, and a timeout is not a cancellation", () => {
  assert.equal(closedWhyFor({ status: "cancelled" }), "cancelled");
  assert.equal(closedWhyFor({ status: "stopped" }), "cancelled");
  assert.equal(closedWhyFor({ status: "done" }), "the turn ended");
  assert.equal(closedWhyFor({ deadline: Date.now() - 1000 }), "timed out");
  assert.equal(closedWhyFor({}), "closed unanswered");
  // A deadline that has NOT passed does not turn a stop into a timeout.
  assert.equal(closedWhyFor({ deadline: Date.now() + 60_000, status: "cancelled" }), "cancelled");

  const s = new ClarifyHistory({});
  ask(s, 1, { askedAt: "2026-01-01T00:00:00.000Z", deadline: Date.parse("2026-01-01T00:05:00Z") });
  s.closed(s.list().entries[0].key, { why: "timed out", at: "2026-01-01T00:05:00.000Z" });
  assert.equal(Core.closedLine(s.list().entries[0]), "timed out after 5m");
});

test("an unknown status read off disk is closed, never a phantom answer", () => {
  const entry = clarifyHistoryEntry({ key: "k", status: "weird", answer: "" });
  assert.equal(Core.stateOf({ ...entry, status: "weird" }), "closed");
  assert.equal(Core.stateOf({ ...entry, status: "" }), "open");
});

test("reconcile closes a question whose turn is gone, and keeps one whose turn still holds it", () => {
  const s = new ClarifyHistory({});
  ask(s, 1);
  ask(s, 2);
  const live = { id: "job-2", status: "running", question: { key: "clarify:job-2:prompt-2" } };
  const changed = s.reconcile([live]);
  assert.equal(changed, 1);
  assert.equal(s.find("clarify:job-1:prompt-1").status, "closed");
  assert.equal(s.find("clarify:job-2:prompt-2").status, "open");
});

// ---- the cap ----------------------------------------------------------------------------------------------------
test("the render cap draws the newest 50 of 137 and SAYS the total", () => {
  const s = new ClarifyHistory({});
  for (let i = 1; i <= 137; i += 1) ask(s, i, { askedAt: iso(Date.UTC(2026, 0, 1, 0, 0, i)) });
  const out = s.list();
  assert.equal(out.total, 137);

  const capped = Core.capOf(out.entries, 50);
  assert.equal(capped.shown, 50);
  assert.equal(capped.total, 137);
  assert.equal(capped.more, true);
  assert.equal(capped.foot, "showing 50 of 137");
  assert.equal(capped.rows[0].seq, 137, "the cap keeps the NEWEST rows");
  assert.equal(capped.rows[49].seq, 88);

  const all = Core.capOf(out.entries, 0);
  assert.equal(all.rows.length, Core.RENDER_CAP, "a zero limit means the cap, never an empty list");
  assert.equal(Core.footText(12, 12), "showing all 12");
  assert.equal(Core.footText(0, 0), "no questions yet");
});

test("the store bounds itself and still reports the total it keeps", () => {
  const s = new ClarifyHistory({ keep: 5 });
  for (let i = 1; i <= 8; i += 1) ask(s, i);
  const out = s.list();
  assert.equal(out.total, 5);
  assert.deepEqual(out.entries.map((e) => e.seq), [8, 7, 6, 5, 4]);
  assert.equal(CLARIFY_HISTORY_KEEP, 400);
});

// ---- the two Jobs seams -----------------------------------------------------------------------------------------
test("a prompt arriving is recorded with its names, and an answer is stamped from the call that took it", () => {
  const t = tempFile();
  try {
    const jobs = new Jobs({ config: { jobsFile: path.join(t.dir, "jobs.json"), clarifyHistoryFile: t.file }, onLog: quiet });
    jobs.assistantNameFor = (id) => (id === "assistant-1" ? "Assistant #1" : null);
    const j = {
      id: "job-9",
      runId: "run-9",
      thread: "thread-9",
      status: "running",
      startedAt: iso(Date.UTC(2026, 0, 1, 0, 0)),
      endedAt: null,
      lines: [],
      title: "the landing tree",
      worktree: "floating-header-a-purple-clarify-button-d2cf83",
      assistantId: "assistant-1",
      question: null,
    };
    jobs.jobs.set(j.id, j);
    jobs.consume(j, {
      event: "clarify.request",
      prompt_id: "prompt-9",
      question: "land it on the turn, or only the agent?",
      choices: ["the turn", "the agent"],
      timeout_s: 900,
    });
    const open = jobs.clarifyHistory.list().entries[0];
    assert.equal(open.status, "open");
    assert.equal(open.jobId, "job-9");
    assert.equal(open.thread, "thread-9");
    assert.equal(open.agent, "the landing tree");
    assert.equal(open.tree, "floating-header-a-purple-clarify-button-d2cf83");
    assert.equal(open.assistantId, "assistant-1");
    assert.equal(open.assistantName, "Assistant #1");
    assert.deepEqual(open.choices, ["the turn", "the agent"]);

    jobs.noteAnswered(j, "the turn", { status: "running", by: "reader" });
    const answered = jobs.clarifyHistory.list().entries[0];
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer, "the turn");
    assert.equal(answered.answeredBy, "reader");
    assert.ok(Date.parse(answered.answeredAt) > 0);
    assert.equal(j.question, null, "the box still collapses exactly as it did");
  } finally {
    t.done();
  }
});

test("a cancelled card is closed with its word, not greyed as answered", () => {
  const t = tempFile();
  try {
    const jobs = new Jobs({ config: { jobsFile: path.join(t.dir, "jobs.json"), clarifyHistoryFile: t.file }, onLog: quiet });
    const j = {
      id: "job-10",
      runId: "run-10",
      thread: "thread-10",
      status: "running",
      startedAt: iso(Date.UTC(2026, 0, 1, 0, 0)),
      endedAt: null,
      lines: [],
      title: "a cancelled card",
      thread2: null,
    };
    jobs.jobs.set(j.id, j);
    jobs.consume(j, { event: "clarify.request", prompt_id: "prompt-10", question: "which side first?", choices: ["a", "b"] });
    j.status = "cancelled";
    jobs.closeQuestion(j, {});
    const row = jobs.clarifyHistory.list().entries[0];
    assert.equal(row.status, "closed");
    assert.equal(row.closedWhy, "cancelled");
    assert.equal(row.answer, "");
    assert.match(Core.closedLine(row), /^cancelled after /);
  } finally {
    t.done();
  }
});

// ---- the names a row carries ------------------------------------------------------------------------------------
test("every row names the agent, the tree and the assistant, with a fallback rather than an empty cell", () => {
  const withNames = Core.namesOf({ agent: "fix the header", tree: "floating-header-...", assistantName: "Assistant #1" });
  assert.deepEqual(withNames, { agent: "fix the header", tree: "floating-header-...", assistant: "Assistant #1" });
  const bare = Core.namesOf({});
  assert.equal(bare.agent, "an agent");
  assert.equal(bare.tree, "(no tree)");
  assert.equal(bare.assistant, "no assistant");
});

// ---- one row per QUESTION: the collapse, the answered-wins rule, and the count ------------------------------------
//
// The store keeps one record per ASK, which is right for an audit trail and wrong for a popup: a question asked,
// closed and asked again arrived as two rows, one ANSWERED and one "closed unanswered", and the second read as a
// question the reader had ignored. These pin the rules that turn the store's asks into the popup's items, in the order
// they decide a row: an answer in ANY attempt wins; otherwise an open attempt wins; otherwise a reader's own reply
// softens the word; otherwise the closed word stands.
function entry(n, over = {}, state = {}) {
  return Object.assign(
    clarifyHistoryEntry(
      {
        key: `clarify:k${n}`,
        jobId: `job-${n}`,
        thread: `thread-${n}`,
        agent: `agent ${n}`,
        tree: `tree-${n}`,
        assistantId: "assistant-1",
        assistantName: "Assistant #1",
        question: `question ${n}?`,
        askedAt: iso(Date.UTC(2026, 0, 1, 0, n)),
        ...over,
      },
      { seq: n },
    ),
    state,
  );
}

const answeredState = (answer, at = Date.UTC(2026, 0, 1, 0, 1)) => ({
  status: "answered",
  answer,
  answeredBy: "reader",
  answeredAt: iso(at + 60_000),
});

test("the collapse key is the question's own words and the agent that asked them, not the job", () => {
  const a = entry(1, { question: "Should WS-4 stay out?", agent: "hot-4", jobId: "job-a", key: "clarify:a" });
  const b = entry(2, { question: "  should   WS-4 stay out? ", agent: "Hot-4", jobId: "job-b", key: "clarify:b" });
  const other = entry(3, { question: "Should WS-4 stay out?", agent: "hot-9", jobId: "job-c" });
  assert.equal(collapseKey(a), collapseKey(b), "spacing, case and the job do not make a new question");
  assert.notEqual(collapseKey(a), collapseKey(other), "a different agent asking the same words is its own item");
  // A row with no question at all cannot be compared by its words, so it stands alone rather than swallowing every
  // other unrecorded row into one item.
  const blank = entry(4, { question: "" });
  assert.equal(collapseKey(blank), "seq:4");
});

test("an answered attempt wins over a later cancelled one, in either order", () => {
  const firstAnswered = entry(1, { question: "same question?", agent: "hot-4" }, answeredState("yes, wave 2"));
  const laterCancelled = entry(
    2,
    { question: "same question?", agent: "hot-4", thread: "thread-1" },
    { status: "closed", closedWhy: "cancelled", closedAt: iso(Date.UTC(2026, 0, 1, 0, 9)) },
  );
  for (const input of [
    [firstAnswered, laterCancelled],
    [laterCancelled, firstAnswered],
  ]) {
    const items = collapseItems(input);
    assert.equal(items.length, 1, "one question, one item");
    assert.equal(items[0].state, "answered", "the answer cannot be taken back by a later card's outcome");
    assert.equal(items[0].answer, "yes, wave 2");
    assert.equal(items[0].closedWhy, "", "an answered item carries no closed word at all");
    assert.equal(items[0].attemptCount, 2);
    assert.equal(items[0].seq, 2, "the item stands where its NEWEST attempt stands");
  }
});

test("a collapsed item keeps every attempt with its own timestamp, and the item's age is its first ask", () => {
  const older = entry(
    1,
    { question: "one question?", agent: "hot-4", askedAt: iso(Date.UTC(2026, 0, 1, 0, 1)) },
    { status: "closed", closedWhy: "closed unanswered", closedAt: iso(Date.UTC(2026, 0, 1, 0, 11)) },
  );
  const newer = entry(2, { question: "one question?", agent: "hot-4", askedAt: iso(Date.UTC(2026, 0, 1, 0, 8)) }, answeredState("go"));
  const [item] = collapseItems([older, newer]);
  assert.deepEqual(item.attempts.map((a) => a.status), ["answered", "closed"], "newest attempt first");
  assert.equal(item.attempts[1].askedAt, iso(Date.UTC(2026, 0, 1, 0, 1)), "each attempt keeps its own ask time");
  assert.equal(item.askedAt, iso(Date.UTC(2026, 0, 1, 0, 1)), "the item is as old as the first time it was asked");
  assert.equal(Core.attemptLine(item.attempts[1], Date.UTC(2026, 0, 1, 1, 1)), "asked 1h ago · closed unanswered after 10m");
});

test("a closed item counts from the attempt that closed, not from the first ask", () => {
  const first = entry(
    1,
    { question: "asked twice?", agent: "hot-4", askedAt: iso(Date.UTC(2026, 0, 1, 0, 1)) },
    { status: "closed", closedWhy: "cancelled", closedAt: iso(Date.UTC(2026, 0, 1, 0, 3)) },
  );
  const second = entry(
    2,
    { question: "asked twice?", agent: "hot-4", askedAt: iso(Date.UTC(2026, 0, 1, 0, 8)) },
    { status: "closed", closedWhy: "cancelled", closedAt: iso(Date.UTC(2026, 0, 1, 0, 9)) },
  );
  const [item] = collapseItems([first, second]);
  assert.equal(item.closedAskedAt, iso(Date.UTC(2026, 0, 1, 0, 8)), "the second card's own wait is 1m, not the item's 8m");
  assert.equal(Core.closedLine(item), "cancelled after 1m");
});

test("the outstanding count is items still waiting, never attempts and never an answered one", () => {
  const asked = entry(1, { question: "waiting?", agent: "hot-4" }, { status: "open" });
  const askedAgain = entry(2, { question: "waiting?", agent: "hot-4" }, { status: "open" });
  const answered = entry(3, { question: "answered?", agent: "hot-4" }, answeredState("yes"));
  const closed = entry(4, { question: "closed?", agent: "hot-4" }, {
    status: "closed",
    closedWhy: "timed out",
    closedAt: iso(Date.UTC(2026, 0, 1, 0, 5)),
  });
  const items = collapseItems([asked, askedAgain, answered, closed]);
  assert.equal(items.length, 3, "two asks of one question are one item");
  assert.equal(outstandingOf(items), 1, "one item is still waiting, however many times it was asked");
  assert.equal(outstandingOf([]), 0);
  assert.equal(outstandingOf(undefined), 0, "a route with no store answers zero, not a throw");
});

test("a reader's reply is evidence an answer exists; an assistant's own reply turn is not", () => {
  const replies = readerReplies([
    {
      id: "job-r",
      reply: true,
      thread: "thread-1",
      startedAt: iso(Date.UTC(2026, 0, 1, 0, 30)),
      prompt: "yes, once CI is green",
      origin: { kind: "assistant-reply", by: "reader" },
    },
    {
      id: "job-x",
      reply: true,
      thread: "thread-1",
      startedAt: iso(Date.UTC(2026, 0, 1, 0, 31)),
      prompt: "assistant autonomy",
      origin: { kind: "assistant-reply", by: "assistant" },
    },
    { id: "job-y", reply: true, thread: "thread-1", startedAt: iso(Date.UTC(2026, 0, 1, 0, 32)), prompt: "an older reply with no origin" },
    { id: "job-z", thread: "thread-1", startedAt: iso(Date.UTC(2026, 0, 1, 0, 33)), prompt: "not a reply turn" },
    {
      id: "job-c",
      reply: true,
      thread: "thread-1",
      startedAt: iso(Date.UTC(2026, 0, 1, 0, 34)),
      prompt: "the panel delivered the card's answer",
      origin: { kind: "assistant-reply", by: "clarify-answer" },
    },
  ]);
  assert.deepEqual(replies.map((r) => r.jobId), ["job-r", "job-c"], "only the reader's own hand and the panel answering for them");
});

test("a closed item with a reader reply reads answered in a reply and lands on that turn", () => {
  const closed = entry(
    1,
    { question: "push the tag?", agent: "hot-9", thread: "thread-9" },
    { status: "closed", closedWhy: "closed unanswered", closedAt: iso(Date.UTC(2026, 0, 1, 0, 20)) },
  );
  const replies = readerReplies([
    {
      id: "job-reply",
      reply: true,
      thread: "thread-9",
      startedAt: iso(Date.UTC(2026, 0, 1, 0, 25)),
      prompt: "yes, push it",
      origin: { kind: "assistant-reply", by: "reader" },
    },
  ]);
  const [item] = clarifyItems([closed], { replies });
  assert.equal(item.state, "replied");
  assert.equal(item.jobId, "job-reply", "the press lands on the turn the reader wrote");
  assert.equal(item.reply.text, "yes, push it");
  assert.equal(outstandingOf([item]), 0, "a replied item is not waiting on anything");
});

test("a reply does not answer an item asked after it, and no reply still reads as missed", () => {
  const before = entry(
    1,
    { question: "older question?", agent: "hot-9", thread: "thread-9", askedAt: iso(Date.UTC(2026, 0, 1, 1, 0)) },
    { status: "closed", closedWhy: "cancelled", closedAt: iso(Date.UTC(2026, 0, 1, 1, 5)) },
  );
  const after = entry(
    2,
    { question: "newer question?", agent: "hot-9", thread: "thread-9", askedAt: iso(Date.UTC(2026, 0, 1, 2, 0)) },
    { status: "closed", closedWhy: "timed out", closedAt: iso(Date.UTC(2026, 0, 1, 2, 5)) },
  );
  // A reply between the two questions belongs to the older one: that was the card open when the reader wrote.
  const between = readerReplies([
    {
      id: "job-b",
      reply: true,
      thread: "thread-9",
      startedAt: iso(Date.UTC(2026, 0, 1, 1, 30)),
      prompt: "about the older one",
      origin: { kind: "assistant-reply", by: "reader" },
    },
  ]);
  const items = clarifyItems([before, after], { replies: between });
  assert.equal(items.find((i) => i.question === "older question?").state, "replied");
  assert.equal(items.find((i) => i.question === "newer question?").state, "closed", "a reply before the ask is not an answer to it");
  // With no reply at all, a genuinely missed item still says so, in the store's own words.
  const missed = clarifyItems([before, after], { replies: [] });
  const row = missed.find((i) => i.question === "older question?");
  assert.equal(row.state, "closed");
  assert.equal(Core.stateOf(row), "closed");
  assert.equal(row.closedWhy, "cancelled");
});

test("an open or answered item is never softened into a reply", () => {
  const open = entry(1, { question: "still waiting?", agent: "hot-9", thread: "thread-9" }, { status: "open" });
  const answered = entry(2, { question: "already answered?", agent: "hot-9", thread: "thread-9" }, answeredState("yes"));
  const replies = readerReplies([
    {
      id: "job-r",
      reply: true,
      thread: "thread-9",
      startedAt: iso(Date.UTC(2026, 0, 1, 0, 50)),
      prompt: "some reply",
      origin: { kind: "assistant-reply", by: "reader" },
    },
  ]);
  const items = clarifyItems([open, answered], { replies });
  assert.equal(items.find((i) => i.question === "still waiting?").state, "open");
  assert.equal(outstandingOf(items), 1, "an open card is waiting even when a reply follows it");
  assert.equal(items.find((i) => i.question === "already answered?").state, "answered");
});

test("the route answers items, the item total, the attempt count and the outstanding number", async () => {
  const store = new ClarifyHistory({ keep: 50 });
  const mk = (n, question, state) => {
    const e = store.ask({
      key: `clarify:r${n}`,
      jobId: `job-${n}`,
      thread: `thread-${n}`,
      agent: "hot-4",
      question,
      askedAt: iso(Date.UTC(2026, 0, 1, 0, n)),
      assistantId: "assistant-1",
      assistantName: "Assistant #1",
    });
    Object.assign(e, state);
    store.save();
    return e;
  };
  mk(1, "the same question?", { status: "closed", closedWhy: "closed unanswered", closedAt: iso(Date.UTC(2026, 0, 1, 0, 10)) });
  mk(2, "the same question?", { status: "answered", answer: "yes", answeredBy: "reader", answeredAt: iso(Date.UTC(2026, 0, 1, 0, 11)) });
  mk(3, "another?", { status: "open" });
  const jobs = { clarifyHistory: store, list: () => [] };
  const sent = [];
  const route = createClarifyHistoryRoutes({ jobs, sendJson: (_res, code, body) => sent.push({ code, body }) });
  const url = new URL("http://127.0.0.1/api/clarify/history?limit=1");
  await route({ method: "GET", url: url.pathname + url.search }, {}, "/api/clarify/history", url);
  assert.equal(sent.length, 1);
  const body = sent[0].body;
  assert.equal(sent[0].code, 200);
  assert.equal(body.items.length, 1, "limit caps the rows drawn");
  assert.equal(body.total, 2, "and never the total: two questions, three asks");
  assert.equal(body.attempts, 3);
  assert.equal(body.outstanding, 1);
  assert.equal(body.entries.length, 1, "the raw store page keeps its own shape");
});

// ---- the header count: one painting code, every counting button -------------------------------------------------
// "the same notification counter the other header controls carry, drawn by the same painting code" is a claim about
// several files that no runtime test in this suite can see, so it is pinned at the source: the badge exists in the
// markup, the painter exists once, and EVERY counting button calls it. A future hand-rolled badge fails here.
test("the header markup carries the clarify badge, hidden at zero, and every counting button is painted by one function", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(html, /<span id="clarify-badge" hidden>0<\/span>/, "the badge is in the button and starts hidden");
  assert.equal(html.indexOf('id="human-badge"'), -1, "the Human badge this test was written against is gone");
  assert.equal((app.match(/function paintCountBadge\(/g) || []).length, 1, "one painter, not two");
  assert.match(app, /function paintCollisionsButton\(\)[\s\S]*?paintCountBadge\(btn, \$\("collisions-badge"\), n, "has-waiting"\)/);
  assert.match(app, /function paintPermissionsButton\(\)[\s\S]*?paintCountBadge\(btn, \$\("permissions-badge"\), n, "has-waiting"\)/);
  assert.match(app, /function paintClarifyButton\(\)[\s\S]*?paintCountBadge\(btn, \$\("clarify-badge"\), n, "has-unanswered"\)/);
  // Zero is quiet on both: the painter hides the badge and clears the class, and the CSS keeps a hidden badge hidden
  // (`display: inline-block` on the badge would otherwise beat the [hidden] attribute it is drawn with).
  assert.match(app, /badge\.hidden = n === 0/);
  assert.match(app, /btn\.classList\.toggle\(cls, n > 0\)/);
  assert.match(css, /#clarify-badge\[hidden\] \{ display: none; \}/);
  assert.match(css, /#btn-clarify\.has-unanswered/);
});
