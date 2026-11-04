// The Element assistant, driven against a STUBBED BRIDGE: a scratch directory holding the two files the real
// Python program exposes — `outbox.txt`, which it polls and renames to `outbox.sent`, and its stdout log, where
// every message it receives is printed as `[HH:MM:SS] <- <room>: <body>`. No Matrix credentials, no Python, no
// network: the stub drains the outbox and writes the `<-` lines the way the bridge does, and the module under
// test cannot tell the difference.
//
// What this file is the contract for, in the order the brief states it:
//
//   1. EVERY wait on a person goes out — a clarify card and an approval — carrying its lettered options, and a
//      letter comes back that the panel applies exactly as the card's own press would (same method, same
//      request id);
//   2. nothing else is sent unprompted: a sweep with no new wait and no question sends nothing at all;
//   3. a destructive ask refuses a letter: the option is ARMED, and only `go` runs it;
//   4. one message per wait, edited in place: a second sweep, a restart and an answer send no second copy, and
//      the record's own text gains the outcome;
//   5. a failed send is a record the Gateway block draws (and Retry re-sends that record, never a copy);
//   6. work filed from the room goes through the panel's own queue add — real filenames, so the lane guard
//      still applies — and an open question about another assistant's queue is answered from `queueView`.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant, ElementChannel, createBridgeChannel, waitText } from "../lib/assistant.js";
import { ASSISTANT_THREAD } from "../lib/assistant.js";
import { waitsOf } from "../lib/jobs.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";

const ROOM = "!stub:example.invalid";

// ---- the stubbed bridge ----------------------------------------------------------------------------------
// `drain()` is the bridge's outbox loop: it takes the whole file as ONE message and renames it to
// `outbox.sent`. `say()` is its sync loop printing an incoming message. Both are the real contract, minus
// the Matrix login.
function stubBridge(dir, { running = true } = {}) {
  const outbox = path.join(dir, "outbox.txt");
  const log = path.join(dir, "matrix-bridge.log");
  const sent = [];
  if (!existsSync(log)) writeFileSync(log, "=== stub bridge start ===\n");
  const drain = () => {
    if (!existsSync(outbox)) return;
    const text = readFileSync(outbox, "utf8").trim();
    if (!text) {
      unlinkSync(outbox);
      return;
    }
    sent.push(text);
    writeFileSync(path.join(dir, "outbox.sent"), text, "utf8");
    unlinkSync(outbox);
  };
  const timer = setInterval(drain, 5);
  const bridge = createBridgeChannel({
    config: { matrix: { roomId: running ? ROOM : "", scriptPath: path.join(dir, "hermes_matrix_bridge.py"), pythonPath: "", autoStart: false } },
    outboxPath: outbox,
    logPath: log,
    status: () => ({ running, pid: running ? 4242 : null, stalePid: running ? null : 4241 }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  return {
    bridge,
    sent,
    outbox,
    log,
    setRunning: (on) => {
      running = Boolean(on);
    },
    drain,
    stop: () => clearInterval(timer),
    say: (text, who = "Bert Jeremiah") => appendFileSync(log, `[12:00:00] <- ${who}: ${text}\n`),
    // A line the panel itself produced — the bridge logs both directions, and only `<-` is a person talking.
    echo: (text) => appendFileSync(log, `[12:00:01] -> (1.2s) ${text}\n`),
  };
}

// The job store's two answered questions, as the panel's own `Jobs` would answer them: the call is recorded,
// and the parked control is CLEARED the way `noteAnswered` / `approve` clear it.
function stubJobs(rows) {
  const calls = [];
  return {
    calls,
    rows,
    list: () => rows,
    get: (id) => rows.find((r) => String(r.id) === String(id)) || null,
    waitingOnPerson: () => rows.flatMap((r) => waitsOf(r)),
    async approve(id, choice, requestId) {
      calls.push({ kind: "approve", id, choice, requestId });
      const j = rows.find((r) => String(r.id) === String(id));
      if (!j || !j.approval) return { ok: false, error: "Run has no pending approval" };
      j.approvalDone = { choice, command: j.approval.command, at: new Date().toISOString() };
      j.approval = null;
      return { ok: true, choice };
    },
    async answerQuestion(id, answer, requestId) {
      calls.push({ kind: "clarify", id, answer, requestId });
      const j = rows.find((r) => String(r.id) === String(id));
      if (!j || !j.question) return { ok: false, error: "no pending question" };
      j.questionDone = { answer: String(answer), at: new Date().toISOString() };
      j.question = null;
      return { ok: true, answer };
    },
  };
}

const clarifyRow = (over = {}) => ({
  id: "job-clarify",
  thread: "worker-1",
  title: "Deploy the parser fix",
  branch: "wtgui/deploy-parser",
  question: {
    requestId: "prompt-q1",
    question: "Where should the parser fix go?",
    choices: ["Deploy to QA", "Deploy to prod (Recommended)"],
    multiSelect: false,
    at: new Date().toISOString(),
    deadline: Date.now() + 600_000,
  },
  ...over,
});

const approvalRow = (over = {}) => ({
  id: "job-approve",
  thread: "worker-2",
  title: "Clean the build directory",
  branch: "wtgui/clean-build",
  approval: {
    requestId: "prompt-a1",
    command: "rm -rf build",
    choices: ["once", "deny"],
    at: new Date().toISOString(),
    deadline: Date.now() + 300_000,
  },
  ...over,
});

async function scratch(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `wtgui-${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function channel(dir, jobs, { bridge, assistant = null, stateFile = null } = {}) {
  return new ElementChannel({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), matrix: { roomId: ROOM } },
    jobs,
    assistant,
    bridge,
    stateFile: stateFile || path.join(dir, "element.json"),
    onLog: () => {},
    clock: () => Date.now(),
  });
}

// ---- 1. every wait goes out, with its letters, exactly once ------------------------------------------------
test("a clarify card goes out as ONE message carrying its lettered options, and B answers it as B", async (t) => {
  const dir = await scratch(t, "element-clarify");
  const stub = stubBridge(dir);
  t.after(() => stub.stop());
  const jobs = stubJobs([clarifyRow()]);
  const el = channel(dir, jobs, { bridge: stub.bridge });

  await el.sweep();
  assert.equal(stub.sent.length, 1, "one wait is one message — not one per sweep, poll or repaint");
  const text = stub.sent[0];
  assert.match(text, /A\. Deploy to QA/);
  assert.match(text, /B\. Deploy to prod — recommended/);
  assert.match(text, /Reply with one letter/, "the message says how to answer it");

  // The reply is a LOG LINE — the only channel the bridge gives the panel for an inbound message.
  stub.say("B");
  await el.sweep();
  assert.deepEqual(jobs.calls, [{ kind: "clarify", id: "job-clarify", answer: "Deploy to prod (Recommended)", requestId: "prompt-q1" }]);
  assert.equal(stub.sent.length, 1, "the answer is applied, not announced: no second message");

  const msg = el.state().messages[0];
  assert.equal(msg.status, "answered");
  assert.match(msg.resolution, /^B\. Deploy to prod/);
  assert.match(msg.text, /✓ B\. Deploy to prod/, "the one record is edited in place as it resolves");
});

test("an approval waiting on a human goes out too, with the card's own words for each choice", async (t) => {
  const dir = await scratch(t, "element-approval");
  const stub = stubBridge(dir);
  t.after(() => stub.stop());
  const jobs = stubJobs([approvalRow({ approval: { requestId: "p9", command: "git status", choices: ["once", "session", "deny"], at: new Date().toISOString() } })]);
  const el = channel(dir, jobs, { bridge: stub.bridge });

  await el.sweep();
  assert.equal(stub.sent.length, 1);
  assert.match(stub.sent[0], /\$ git status/);
  assert.match(stub.sent[0], /A\. Allow once/);
  assert.match(stub.sent[0], /B\. Allow for this session/);
  assert.match(stub.sent[0], /C\. Deny/);

  stub.say("c");
  await el.sweep();
  assert.deepEqual(jobs.calls, [{ kind: "approve", id: "job-approve", choice: "deny", requestId: "p9" }], "a lower-case letter is a letter");
  assert.equal(stub.sent.length, 1);
});

// ---- 2. nothing else is sent unprompted -------------------------------------------------------------------
test("a quiet sweep sends nothing: no stream, no status, no journal line", async (t) => {
  const dir = await scratch(t, "element-quiet");
  const stub = stubBridge(dir);
  t.after(() => stub.stop());
  const el = channel(dir, stubJobs([]), { bridge: stub.bridge });
  await el.sweep();
  await el.sweep();
  await el.sweep();
  assert.deepEqual(stub.sent, [], "three passes over an empty board send nothing at all");

  // Even an answer the panel wrote itself in the log is not a person talking: only `<-` lines are read.
  stub.echo("I filed it for you");
  await el.sweep();
  assert.deepEqual(stub.sent, []);
  assert.equal(el.state().inbox.entries, 0);
});

// ---- 3. a destructive ask refuses until `go` ---------------------------------------------------------------
test("a destructive approval arms on the letter and runs only on go", async (t) => {
  const dir = await scratch(t, "element-destructive");
  const stub = stubBridge(dir);
  t.after(() => stub.stop());
  const jobs = stubJobs([approvalRow()]);
  const el = channel(dir, jobs, { bridge: stub.bridge });

  await el.sweep();
  assert.equal(stub.sent.length, 1);
  assert.match(stub.sent[0], /A\. Allow once {3}⚠ destructive/, "the option that runs the command is marked");
  assert.match(stub.sent[0], /reply its letter, then reply go/);

  stub.say("A");
  await el.sweep();
  assert.equal(jobs.calls.length, 0, "a letter alone runs nothing");
  assert.equal(el.state().messages[0].status, "awaiting-go");
  assert.match(el.state().messages[0].text, /⏳ A\. Allow once chosen — reply go/);
  assert.equal(stub.sent.length, 1, "the confirmation prompt is the same record, not a second message");

  stub.say("go");
  await el.sweep();
  assert.deepEqual(jobs.calls, [{ kind: "approve", id: "job-approve", choice: "once", requestId: "prompt-a1" }]);
  assert.equal(stub.sent.length, 1);
  assert.equal(el.state().messages[0].status, "answered");

  // And a destructive ask that was never armed does not run on a stray `go`.
  const dir2 = await scratch(t, "element-destructive-2");
  const stub2 = stubBridge(dir2);
  t.after(() => stub2.stop());
  const jobs2 = stubJobs([approvalRow({ id: "job-approve-2" })]);
  const el2 = channel(dir2, jobs2, { bridge: stub2.bridge });
  await el2.sweep();
  stub2.say("go");
  await el2.sweep();
  assert.equal(jobs2.calls.length, 0, "go with nothing armed decides nothing");
});

test("deny is never the destructive side: B denies the same command at once", async (t) => {
  const dir = await scratch(t, "element-deny");
  const stub = stubBridge(dir);
  t.after(() => stub.stop());
  const jobs = stubJobs([approvalRow()]);
  const el = channel(dir, jobs, { bridge: stub.bridge });
  await el.sweep();
  stub.say("B");
  await el.sweep();
  assert.deepEqual(jobs.calls, [{ kind: "approve", id: "job-approve", choice: "deny", requestId: "prompt-a1" }]);
});

// ---- 4. one message per wait, across sweeps, a restart and a resolution ------------------------------------
test("a restart neither re-sends an open wait nor loses the record it was sent as", async (t) => {
  const dir = await scratch(t, "element-restart");
  const stub = stubBridge(dir);
  t.after(() => stub.stop());
  const jobs = stubJobs([clarifyRow()]);
  const first = channel(dir, jobs, { bridge: stub.bridge });
  await first.sweep();
  assert.equal(stub.sent.length, 1);

  // A NEW process over the same state directory, the same board and the same wait.
  const second = channel(dir, jobs, { bridge: stub.bridge });
  await second.sweep();
  assert.equal(stub.sent.length, 1, "a restart is not a second copy");
  assert.equal(second.state().messages.length, 1);
  assert.equal(second.state().messages[0].status, "open");

  // The wait ends on another surface (answered on the card); the record closes in place and still nothing goes.
  jobs.rows[0].question = null;
  jobs.rows[0].questionDone = { answer: "", closed: true, at: new Date().toISOString() };
  await second.sweep();
  assert.equal(stub.sent.length, 1);
  assert.equal(second.state().messages[0].status, "closed");
  assert.match(second.state().messages[0].text, /✕ closed/);
});

// ---- 5. a failed send is surfaced, and Retry re-sends the SAME record --------------------------------------
test("a send the bridge cannot take is a record in the block, and Retry sends that record once it is back", async (t) => {
  const dir = await scratch(t, "element-failed");
  const stub = stubBridge(dir, { running: false });
  t.after(() => stub.stop());
  const jobs = stubJobs([clarifyRow()]);
  const el = channel(dir, jobs, { bridge: stub.bridge });

  await el.sweep();
  const st = el.state();
  assert.equal(stub.sent.length, 0);
  assert.equal(st.messages[0].status, "unsent");
  assert.match(st.messages[0].send.error, /bridge is not running/);
  assert.equal(st.failures.length, 1, "the Gateway block has it");
  assert.equal(st.failures[0].kind, "send");
  assert.match(st.messages[0].text, /⚠ NOT DELIVERED: the Matrix bridge is not running/);

  stub.setRunning(true);
  const out = await el.retry();
  assert.equal(out.retried, 1);
  assert.equal(stub.sent.length, 1);
  assert.equal(el.state().messages[0].status, "open");
  assert.equal(el.state().counts.failed, 1, "the failure is history, kept, not erased");
});

// ---- 6. the two queue doors --------------------------------------------------------------------------------
async function queuePanel(t) {
  const dir = await scratch(t, "element-queue");
  const project = path.join(dir, "proj");
  mkdirSync(path.join(project, "lib"), { recursive: true });
  writeFileSync(path.join(project, "lib", "assistant.js"), "// a real file\n", "utf8");
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  await writeFile(
    path.join(dir, "assistants.json"),
    JSON.stringify({
      version: 1,
      assistants: [
        { id: PRIMARY_ASSISTANT, name: "Assistant #1", threadId: ASSISTANT_THREAD, rules: [] },
        { id: "assistant-2", name: "Assistant #2", threadId: threadFor("assistant-2"), rules: [] },
      ],
    }),
  );
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => [], get: () => null, firstOfThread: () => null },
    getProjects: () => [{ name: "proj", path: project }],
    onLog: () => {},
  });
  const stub = stubBridge(dir);
  t.after(() => stub.stop());
  const el = new ElementChannel({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, matrix: { roomId: ROOM } },
    jobs: stubJobs([]),
    assistant,
    bridge: stub.bridge,
    getProjects: () => [{ name: "proj", path: project }],
    stateFile: path.join(dir, "element.json"),
    onLog: () => {},
  });
  return { dir, project, assistant, stub, el };
}

test("work filed from the room goes through the panel's own add, with a real filename so the lane guard applies", async (t) => {
  const { assistant, stub, el, project } = await queuePanel(t);

  stub.say("file tidy the console in lib/assistant.js into assistant 2");
  await el.sweep();
  const one = assistant.queueView("assistant-2");
  assert.equal(one.tasks.length, 1);
  assert.equal(one.tasks[0].title, "tidy the console", "the verb and the target are not part of the title");
  assert.deepEqual(one.tasks[0].files, ["lib/assistant.js"], "the file named is a REAL file under the project root");
  assert.equal(one.tasks[0].project, "proj");
  assert.equal(one.tasks[0].createdBy, "element");
  assert.match(stub.sent.at(-1), /Filed #1 in Assistant #2's queue — tidy the console · lane lib\/assistant\.js/);

  stub.say("file tidy the queue pane in lib/assistant.js into assistant 2");
  await el.sweep();
  const two = assistant.queueView("assistant-2");
  assert.equal(two.tasks.length, 2);
  assert.equal(two.tasks[0].laneHead, true, "the first row claiming the file heads the lane");
  assert.equal(two.tasks[1].lane, "lib/assistant.js", "the second row is IN that lane — the guard the real add gives");
  assert.equal(two.tasks[1].laneHeadId, 1);

  // A filename that is not on disk is not claimed: no invented lane.
  stub.say("file document the lane rule in lib/not-a-file.js into assistant 2");
  await el.sweep();
  const three = assistant.queueView("assistant-2");
  assert.deepEqual(three.tasks[2].files, [], "an invented path claims nothing");
  assert.equal(three.tasks[2].lane, null);

  // An open question about that queue is answered from the same read the Queue tab draws.
  stub.say("what's in assistant 2's queue?");
  await el.sweep();
  const answer = stub.sent.at(-1);
  assert.match(answer, /Assistant #2's queue — 3 open, 3 rows/);
  assert.match(answer, /#1 queued · tidy the console · lib\/assistant\.js · lane head/);
  assert.match(answer, /#2 queued · tidy the queue pane · lib\/assistant\.js · lane lib\/assistant\.js after #1/, "the row behind the head says so");
  assert.ok(existsSync(path.join(project, "lib", "assistant.js")));
});

test("a filing line with no title is refused in words, and nothing is added", async (t) => {
  const { assistant, stub, el } = await queuePanel(t);
  stub.say("file into assistant 2");
  await el.sweep();
  assert.match(stub.sent.at(-1), /Not filed: a task needs a title/);
  assert.equal(assistant.queueView("assistant-2").tasks.length, 0);
});

// ---- the message builder, on its own ----------------------------------------------------------------------
test("waitText carries every option and its letter, and says what is not sent", () => {
  const text = waitText({
    n: 4,
    kind: "clarify",
    title: "Where to?",
    where: "wtgui/x",
    prompt: "Pick one",
    status: "open",
    choices: [
      { letter: "A", label: "QA", destructive: false },
      { letter: "B", label: "prod", destructive: true },
    ],
  });
  assert.match(text, /WTGUI question · wait 4 · Where to\?/);
  assert.match(text, /A\. QA/);
  assert.match(text, /B\. prod {3}⚠ destructive/);
  assert.match(text, /prefix its number to be exact \(4A\)/);
  assert.match(text, /one message per question/);
});
