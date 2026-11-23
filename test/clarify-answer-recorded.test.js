// THE ANSWER THE READER GAVE, on the row the popup draws.
//
// The defect, measured on this board's own store rather than inferred from a screenshot: a reader answered a clarify
// card, the turn's footer said "answered: ...", and the Clarify popup kept calling that same question "closed
// unanswered". Two rows carried it, and both carry the same 21 to 106 millisecond gap:
//
//   seq 66  closed at 2026-11-23T04:01:29.771Z   the answer written at 2026-11-23T04:01:29.877Z
//   seq 63  closed at 2026-11-22T17:36:49.290Z   the answer written at 2026-11-22T17:36:49.311Z
//
// The cause is a race, not a miscount. The gateway publishes `clarify.settled` the moment it takes an answer, and that
// event arrives BEFORE the POST that carried the answer returns. The settle branch closed the question and nulled
// `j.question`; `noteAnswered` then read `j.question.key`, found nothing, wrote the answer only onto `questionDone`,
// and the history row stayed closed. The reply delivery (`Assistant.noteAnswerByReply`) had the same read, so a reader
// pressing Answer on a card whose run had ended left the row saying "closed unanswered" too.
//
// These tests drive the SHIPPED code at those seams: the settle, the answer, the reply delivery, and the boot repair
// that fixes rows a store written before this fix still holds. The popup half is `public/core/clarify-history.js`, and
// the button's number is the store's `outstanding` (`lib/clarify-history.js`), never its total.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { ClarifyHistory } from "../lib/clarify-history.js";
import { Jobs } from "../lib/jobs.js";
import "../public/core/clarify-history.js";

const Core = globalThis.wtClarifyHistory;
const quiet = () => {};
const iso = (ms) => new Date(ms).toISOString();
const ASKED = "2026-11-23T04:00:15.650Z";
const ANSWERED = "2026-11-23T04:01:29.877Z";
const ANSWER = "Throwaway initiative with 3 seeded waves and 2 lanes, captured at 1440/768/480, then deleted";

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "clarify-answer-recorded-"));
  return { dir, file: path.join(dir, "clarify-history.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function storeAt(t) {
  return new Jobs({
    config: { jobsFile: path.join(t.dir, "jobs.json"), clarifyHistoryFile: t.file },
    onEvent: quiet,
    onLog: quiet,
  });
}

// One card, asked through the same handler the gateway's event reaches (`Jobs.consume`, the `clarify.request` branch).
function askCard(jobs, over = {}) {
  const {
    question = "Your Initiatives tab has zero waves on all 7 initiatives. How should I prove the design against THE SKETCH?",
    promptId = "093ae9e17b",
    ...card
  } = over;
  const j = {
    id: "c39ac01f",
    runId: "run-1",
    thread: "panel-assistant-3",
    status: "running",
    startedAt: ASKED,
    endedAt: null,
    lines: [],
    title: "Agent board management queue check",
    worktree: "assistant-cwd",
    assistantId: "assistant-3",
    question: null,
    ...card,
  };
  jobs.jobs.set(j.id, j);
  jobs.consume(j, {
    event: "clarify.request",
    prompt_id: promptId,
    question,
    choices: [ANSWER, "Seed real waves on the real initiative", "Change the code instead"],
    timeout_s: 300,
  });
  return j;
}

const firstRow = (jobs) => jobs.clarifyHistory.list().entries[0];

// ---- the race: the gateway's settle lands while the answer POST is in flight -------------------------------------
test("a settle that arrives while an answer is in flight does not close the question", () => {
  const t = tempStore();
  try {
    const jobs = storeAt(t);
    const j = askCard(jobs);
    const key = firstRow(jobs).key;
    // `answerQuestion` marks the prompt in flight BEFORE its first await. The settle lands inside that window - it is
    // the 106ms the live store recorded between the close and the answer.
    jobs.questionAnswers.set(j.id, { requestId: "093ae9e17b", at: Date.now() });
    jobs.consume(j, { event: "clarify.settled", prompt_id: "093ae9e17b" });
    assert.equal(firstRow(jobs).status, "open", "an answer already on its way owns the settle");
    assert.ok(j.question, "the prompt stays on the record until the answer is written");
    // The POST returns: the answer is written, with the key it captured before posting.
    jobs.questionAnswers.delete(j.id);
    jobs.noteAnswered(j, ANSWER, { by: "reader", key });
    const row = firstRow(jobs);
    assert.equal(row.status, "answered");
    assert.equal(row.answer, ANSWER);
    assert.equal(row.key, key);
    assert.equal(j.questionDone.key, key, "the card's one line keeps the row's key");
  } finally {
    t.done();
  }
});

// ---- the second layer: a row already closed under the question is still written answered -------------------------
test("an answer is written to the row even when the prompt was already closed and cleared", () => {
  const t = tempStore();
  try {
    const jobs = storeAt(t);
    const j = askCard(jobs);
    const key = firstRow(jobs).key;
    // A settle with nothing in flight: the card really did go away unanswered at that moment.
    jobs.consume(j, { event: "clarify.settled", prompt_id: "093ae9e17b" });
    assert.equal(firstRow(jobs).status, "closed");
    assert.equal(j.question, null, "a settled job carries no question");
    assert.equal(j.questionDone.key, key, "what it carries instead is the row's key");
    // The reader answers anyway (the card was still on their screen). The key read before the race is what saves it.
    jobs.noteAnswered(j, ANSWER, { by: "reader", key });
    assert.equal(firstRow(jobs).status, "answered");
    assert.equal(firstRow(jobs).answer, ANSWER);
  } finally {
    t.done();
  }
});

// ---- the reply delivery: the required pin ----------------------------------------------------------------
test("a question answered by a reply reads answered in the popup and counts zero on the button", () => {
  const t = tempStore();
  try {
    const jobs = storeAt(t);
    const j = askCard(jobs);
    // The asking run had ended under the card, so `deliverClarifyAnswer` takes the reply path and the card's own
    // waiter is gone: `noteAnswered` never runs, and `noteAnswerByReply` is the only writer.
    jobs.status = "done";
    jobs.consume(j, { event: "clarify.settled", prompt_id: "093ae9e17b" });
    assert.equal(firstRow(jobs).status, "closed", "the card collapsed with no answer recorded");
    const entry = Assistant.prototype.noteAnswerByReply.call({ jobs }, j, ANSWER, "reader");
    assert.ok(entry, "the settled job's own record found its history row");
    assert.equal(entry.status, "answered");
    assert.equal(entry.via, "reply", "the row can say the answer came in a reply");
    // THE POPUP. One item, drawn from the store the way the route hands it to the page.
    const view = jobs.clarifyHistory.items();
    assert.equal(view.total, 1);
    const item = view.items[0];
    assert.equal(Core.stateOf(item), "answered", "the row reads answered, not closed unanswered");
    assert.equal(Core.answerText(item), ANSWER, "the answer stands out of the row");
    assert.match(item.question, /prove the design against THE SKETCH/);
    // THE BUTTON. `paintClarifyButton` paints `clarifyPendingCount()`, which is the store's `outstanding`: an answer
    // that arrived as a reply must not leave a count behind.
    assert.equal(view.outstanding, 0, "an answered question does not count on the button");
  } finally {
    t.done();
  }
});

// ---- the button's number is outstanding, never the store's total -------------------------------------------------
test("the button's number is what is outstanding, not the total the popup's head prints", () => {
  const t = tempStore();
  try {
    const jobs = storeAt(t);
    const answered = askCard(jobs);
    const key = firstRow(jobs).key;
    jobs.noteAnswered(answered, ANSWER, { by: "reader", key });
    // A second, different question that really was left unanswered.
    askCard(jobs, {
      id: "job-missed",
      thread: "thread-missed",
      runId: "run-2",
      title: "Another agent",
      promptId: "p-missed",
      question: "A different question that nobody answered?",
    });
    const missed = jobs.clarifyHistory.list().entries.find((e) => e.jobId === "job-missed");
    jobs.clarifyHistory.closed(missed.key, { why: "timed out" });
    const view = jobs.clarifyHistory.items();
    assert.equal(view.total, 2, "the popup's head prints the total");
    assert.equal(view.outstanding, 0, "and the button paints the outstanding count, which is a different number");
    assert.equal(Core.stateOf(view.items.find((i) => i.key === key)), "answered");
    assert.equal(Core.stateOf(view.items.find((i) => i.key === missed.key)), "closed");
  } finally {
    t.done();
  }
});

// ---- the boot repair: the rows a store written before this fix still holds --------------------------------------
test("boot repairs a row a settle closed under a recorded answer, and refuses to guess a two-question turn", () => {
  const t = tempStore();
  try {
    const store = new ClarifyHistory({ file: t.file });
    // seq 66 as this board holds it: closed "unanswered", with the job's own answer 106ms later and no key kept.
    store.ask({ key: "clarify:c39ac01f:093ae9e17b", jobId: "c39ac01f", thread: "panel-assistant-3", agent: "agent 3", question: "How should I prove the design?", askedAt: ASKED });
    store.closed("clarify:c39ac01f:093ae9e17b", { why: "closed unanswered", at: "2026-11-23T04:01:29.771Z" });
    // A turn that asked TWICE and kept no key: the answer cannot be attributed to either row, so neither is touched.
    store.ask({ key: "clarify:job-two:p-a", jobId: "job-two", thread: "t", agent: "a", question: "First?", askedAt: ASKED });
    store.ask({ key: "clarify:job-two:p-b", jobId: "job-two", thread: "t", agent: "b", question: "Second?", askedAt: ASKED });
    store.closed("clarify:job-two:p-a", { why: "closed unanswered" });
    store.closed("clarify:job-two:p-b", { why: "closed unanswered" });
    // A settled job whose key names one of two rows: only that row is repaired.
    store.ask({ key: "clarify:job-keyed:p-a", jobId: "job-keyed", thread: "t", agent: "c", question: "Third?", askedAt: ASKED });
    store.ask({ key: "clarify:job-keyed:p-b", jobId: "job-keyed", thread: "t", agent: "d", question: "Fourth?", askedAt: ASKED });
    store.closed("clarify:job-keyed:p-a", { why: "closed unanswered" });
    store.closed("clarify:job-keyed:p-b", { why: "closed unanswered" });

    const changed = store.reconcile([
      { id: "c39ac01f", questionDone: { answer: ANSWER, at: ANSWERED } },
      { id: "job-two", questionDone: { answer: "one answer, two questions", at: ANSWERED } },
      { id: "job-keyed", questionDone: { answer: "the fourth", at: ANSWERED, key: "clarify:job-keyed:p-b" } },
    ]);
    assert.equal(changed, 2, "the legible row and the keyed one, nothing else");
    const repaired = store.find("clarify:c39ac01f:093ae9e17b");
    assert.equal(repaired.status, "answered");
    assert.equal(repaired.answer, ANSWER);
    assert.equal(repaired.answeredAt, ANSWERED);
    assert.equal(repaired.closedWhy, "", "an answered row carries no closed word");
    assert.equal(store.find("clarify:job-two:p-a").status, "closed", "a two-question turn is left alone");
    assert.equal(store.find("clarify:job-two:p-b").status, "closed");
    assert.equal(store.find("clarify:job-keyed:p-a").status, "closed", "the key names the other row, so this one stays");
    assert.equal(store.find("clarify:job-keyed:p-b").status, "answered");
    // And the popup view of the repaired row, from a fresh read of the file the panel restarts into.
    const again = new ClarifyHistory({ file: t.file });
    const item = again.items().items.find((i) => i.key === "clarify:c39ac01f:093ae9e17b");
    assert.equal(Core.stateOf(item), "answered");
    assert.equal(Core.answerText(item), ANSWER);
    assert.equal(again.items().outstanding, 0);
  } finally {
    t.done();
  }
});
