// A clarify card is a WAIT, not a stall - and a wake that arrives during it waits for the answer.
//
// THE DEFECT, read from the code: `supervise()` judged every assistant's own turn at its own quiet window and stopped
// it after four of them with no line produced, then let the queued wake go out when the stop landed (lib/assistant.js,
// the `four of them` rule). A turn parked on the `clarify` tool produces NO lines at all - the wait is silent by
// design and the gateway only touches its own activity clock - so a card waiting on a person was indistinguishable
// from a hung turn, and the sentry killed it. Four reader cards died that way on 2026-11-21.
//
// The rule the rest of this module already keeps is narrower than "anything quiet": what travels is only a wait a
// person can answer - a clarify card, a run's approval, the panel's own. The sentry simply did not apply it. This
// file pins all four halves, and the fourth is what keeps the exemption from becoming a licence to hang:
//
//   1. a turn with an open clarify is NOT stopped after four quiet windows;
//   2. a wake that arrives during that wait sits in `pendingWake` and goes out once the question is answered;
//   3. a turn with NO open question that produces nothing for four windows is STILL stopped, exactly as before;
//   4. an approval waiting on the reader is exempt on the same rule.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { awaitsPerson } from "../lib/assistant/read.js";

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const iso = (at) => new Date(at).toISOString();
const now = Date.now();
const THREAD = "panel-assistant";

// The quiet window the sentry reads is `max(300 s, quietSeconds x 4)`. 60 s puts the floor at five minutes, and the
// cards below have been silent for thirty, so the window is not what any assertion here depends on.
const QUIET_SECONDS = 60;
const SILENT_MS = 30 * 60_000;
const STARTED_MS = 40 * 60_000;

// A card as the job store hands it to `supervise()`: the assistant's own thread, a live status, and the last line it
// produced. `question` and `approval` are the two parked shapes the store writes on the record (`lib/jobs.js`
// `clarify.request` / `approval.request`).
function turn({ id = "a1-turn", status = "running", line = true, question = null, approval = null } = {}) {
  const j = {
    id,
    thread: THREAD,
    status,
    startedAt: iso(now - STARTED_MS),
    lines: line ? [{ kind: "tool", text: "💻 terminal · git status", at: now - SILENT_MS }] : [],
  };
  if (question) j.question = question;
  if (approval) j.approval = approval;
  return j;
}

const parkedQuestion = (id = "q-1") => ({
  key: `clarify:${id}:req-1`,
  requestId: "req-1",
  question: "Which tree should the landing record name?",
  choices: ["the worktree", "the primary checkout"],
  at: iso(now - SILENT_MS),
  deadline: null,
});

const parkedApproval = () => ({
  requestId: "req-2",
  command: "git push --force",
  at: iso(now - SILENT_MS),
  deadline: now + 60_000,
});

async function board(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-sentry-question-"));
  const said = [];
  const stopped = [];
  const rows = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: {
      list: () => rows,
      // A real stop takes the card to `cancelled` (`jobs.stop`), which is what makes it not live any more - and that
      // is the half a held wake waits behind, so the fake does it too.
      stop: async (id) => {
        stopped.push(id);
        const row = rows.find((r) => r.id === id);
        if (row) row.status = "cancelled";
        return { ok: true };
      },
    },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  // What goes out instead of a real turn: its text, so a wake can be told apart from a stop.
  assistant.say = async (text) => {
    said.push({ text: String(text) });
    return { id: `said-${said.length}` };
  };
  assistant.settings.enabled = true;
  assistant.settings.quietSeconds = QUIET_SECONDS;
  t.after(async () => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, said, stopped, rows };
}

const stallLines = (assistant) => assistant.journal.filter((j) => j.kind === "stalled");

test("a turn parked on a clarify question is not stopped by the sentry after four quiet windows", async (t) => {
  const { assistant, rows, stopped } = await board(t);
  const card = turn({ question: parkedQuestion() });
  rows.push(card);

  const health = assistant.supervise();

  assert.deepEqual(health.stalledTurns, [], "a waiting card is not a stalled turn");
  assert.equal(health.stalled, null, "and nothing is reported as the stalled id either");
  await wait(50);
  assert.deepEqual(stopped, [], "the parked turn was not stopped");
  assert.deepEqual(stallLines(assistant), [], "nothing was journalled as a stall");
  assert.equal(assistant.assistantLive("assistant-1"), true, "the parked turn is still live, so a wake is held behind it");
});

test("a wake that arrives during an open question is held in pendingWake and goes out once the answer lands", async (t) => {
  const { assistant, said, rows } = await board(t);
  const card = turn({ question: parkedQuestion() });
  rows.push(card);

  // The wake arrives while the reader is looking at the card: it is queued, then the coalescing flush runs and finds
  // the parked turn live. The sentry passes in the middle of the wait - that is the moment the defect was: it read
  // the silence as a stall, stopped the card, and the stop is what let this wake out.
  const queued = assistant.wake("a worker settled in the tree the question is about", null, "settle");
  assert.equal(queued.queued, true, "the wake was accepted, not refused at the door");
  await wait(60);
  assistant.supervise();
  await wait(400);

  assert.equal(said.length, 0, "nothing was started beside the parked turn");
  assert.equal(assistant.pendingWake.length, 1, "the wake is held in pendingWake, not dropped");
  assert.match(assistant.pendingWake[0].reason, /question is about/, "it is the same wake, still waiting");
  assert.equal(assistant.assistantLive("assistant-1"), true, "held because the parked turn is live");
  assert.equal(card.status, "running", "and the sentry did not take the card out from under the question");

  // The reader answers: the question leaves the record and the turn goes on to its own end, which is what calls
  // `flushWake` (`observe`). The wake must go out now - the answer is what it was waiting for.
  delete card.question;
  card.status = "done";
  card.endedAt = iso(now);
  assistant.observe({ type: "job", job: card });
  await wait(200);

  assert.equal(assistant.pendingWake.length, 0, "the hold is released");
  assert.equal(said.length, 1, "the wake went out once, as one turn");
  assert.match(said[0].text, /question is about/, "with the reason it was queued for");
});

test("a turn with NO open question that produces nothing for four windows is still stopped", async (t) => {
  const { assistant, rows, stopped } = await board(t);
  rows.push(turn({ id: "a1-hung" }));

  const health = assistant.supervise();

  assert.deepEqual(health.stalledTurns.map((x) => x.turnId), ["a1-hung"], "the quiet turn is judged, exactly as before");
  await wait(50);
  assert.deepEqual(stopped, ["a1-hung"], "and stopped");
  assert.equal(stallLines(assistant).length, 1, "with the stall line the reader knows");
  assert.match(stallLines(assistant)[0].text, /produced nothing for/);
});

test("an approval waiting on the reader is exempt on the same rule", async (t) => {
  const { assistant, rows, stopped } = await board(t);
  rows.push(turn({ id: "a1-approval", status: "waiting_for_approval", approval: parkedApproval() }));

  const health = assistant.supervise();

  assert.deepEqual(health.stalledTurns, [], "a card waiting on the reader's approval is not a stall either");
  await wait(50);
  assert.deepEqual(stopped, [], "nothing was stopped while the approval box is open");
  assert.deepEqual(stallLines(assistant), []);
});

test("a question is a wait, an approval is a wait, and a finished card is neither", () => {
  assert.equal(awaitsPerson(turn({ question: parkedQuestion() })), true);
  assert.equal(awaitsPerson(turn({ approval: parkedApproval() })), true);
  assert.equal(awaitsPerson(turn()), false, "a quiet turn with nothing parked is judged on its clock");
  assert.equal(awaitsPerson(null), false);
});
