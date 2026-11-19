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
import { ClarifyHistory, CLARIFY_HISTORY_KEEP, clarifyHistoryEntry, closedWhyFor } from "../lib/clarify-history.js";
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
