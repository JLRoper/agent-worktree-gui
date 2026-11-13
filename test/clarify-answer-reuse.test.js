// Where an ANSWERED clarify card's answer lands: on the thread that ASKED, continuing the session that already
// holds the context the answer is about, and NOT as a new session in the same tree.
//
// The defect this pins, measured on this board: a thread did a ticket's work in two turns for 597k tokens and
// produced a drafted comment; the follow-up on that work then ran as a FRESH session in the same tree and spent
// 393k input re-deriving the one-line comment the asking thread still had in its transcript. An answer is a
// continuation, so the default delivery is the asking thread:
//
//   · the run is still parked on the prompt - it takes the answer itself (`POST /v1/runs/<id>/clarify`), no new
//     turn, no new session, the turn carries on with the context it asked from;
//   · the run has ENDED under the card - the answer becomes a REPLY turn on that same thread, so the session
//     continues instead of a new one starting beside it;
//   · the answer changes gear (another task, another tree, another repo), or the asking thread's context is
//     already large - `fresh: true` starts a NEW session in the same tree. Explicit, never the default, and the
//     managers' shared action prompt says the same thing (TO for a continuation, SPAWN IN for a gear change).
//
// Everything below is the SHIPPED code: lib/assistant.js's delivery against a real Jobs store and a stub Runs API
// on an ephemeral loopback port, in a real (empty) git tree, with the run that asked forced to `completed` - the
// state a card is left in when its run ends before the reader presses Answer.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Assistant } from "../lib/assistant.js";
import { actionGrammar, parseActions } from "../lib/assistant/actions.js";
import { answerDelivery, answerTurnText } from "../lib/clarify-answer.js";
import { Jobs } from "../lib/jobs.js";

const run = promisify(execFile);
const QUESTION = "Which comment do you want posted on the ticket?";
const PROMPT_ID = "p-answer-1";
const ASKING_THREAD = "wtgui-reuse-the-asking-thread";

// ── the choice, on its own ──────────────────────────────────────────────────────────────────────────────
test("the default delivery is the asking thread, and only a gear change mints a session", () => {
  // Intent, before anything is posted: the parked run takes it.
  assert.equal(answerDelivery({ job: { thread: ASKING_THREAD } }).mode, "resume");

  // The parked run took it: same run, same thread.
  assert.deepEqual(
    answerDelivery({ job: { thread: ASKING_THREAD }, resumed: { ok: true } }).mode,
    "resume",
  );

  // The run ended under the card. THIS is the default that changed: a reply on the asking thread, not a new
  // session in the same tree.
  const ended = answerDelivery({ job: { thread: ASKING_THREAD }, resumed: { ok: false, undelivered: true, code: "run_ended", runStatus: "completed" } });
  assert.equal(ended.mode, "reply", "an ended run's answer continues the thread that asked");
  assert.match(ended.why, /continues the thread that asked/);
  assert.match(ended.why, /already ended/);

  // A run the READER stopped is not restarted by an answer, and it is not silently turned into a reply either.
  assert.equal(
    answerDelivery({ job: {}, resumed: { ok: false, undelivered: true, code: "run_ended", runStatus: "cancelled" } }).mode,
    "refuse",
    "a stopped run is the reader's decision, and an answer does not take it back",
  );
  assert.equal(
    answerDelivery({ job: { stoppedBy: "reader" }, resumed: { ok: false, undelivered: true, code: "run_ended", runStatus: "" } }).mode,
    "refuse",
    "the card's own record of a stop outranks a blank run status",
  );

  // A refusal the GATEWAY wrote (not a delivery failure) is repeated, never worked around with a turn.
  const gateway = answerDelivery({ job: {}, resumed: { ok: false, undelivered: false, code: "bad_answer", error: "the answer is too long" } });
  assert.equal(gateway.mode, "refuse");
  assert.match(gateway.why, /too long/);

  // The gear change: explicit, and the only mode that starts a new session.
  const fresh = answerDelivery({ job: { thread: ASKING_THREAD }, fresh: true, resumed: { ok: false, undelivered: true } });
  assert.equal(fresh.mode, "fresh", "`fresh` is taken before anything is posted");
});

test("the turn text names the question, the answer, and the one thing a new turn cannot know", () => {
  const text = answerTurnText({ question: { question: QUESTION } }, "post the second comment");
  assert.match(text, /the reader has answered the question this thread asked/);
  assert.match(text, new RegExp(QUESTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the question travels with the answer");
  assert.match(text, /answer: post the second comment/);
  assert.match(text, /same session that asked/, "it says the thread it continues is the one that asked");
  assert.match(text, /Do not re-derive/, "and it forbids the re-derivation this change exists to stop");
});

// ── the delivery, against a real job store and a stub Runs API ─────────────────────────────────────────

async function stubGateway(t) {
  const bodies = [];
  const statuses = new Map(); // run id -> the status `GET /v1/runs/<id>` answers with
  const openStreams = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/v1/capabilities") {
      return json(200, { object: "hermes.api_server.capabilities", version: "reuse-build-1", features: { run_submission: true, run_events_sse: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw || "{}"));
        json(200, { run_id: `run_${bodies.length}`, session_id: bodies[bodies.length - 1].session_id || null });
      });
      return;
    }
    const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (events) {
      const id = events[1];
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "close" });
      if (id === "run_1") {
        res.write(`data: ${JSON.stringify({ event: "tool.started", tool: "clarify", preview: QUESTION, seq: 0 })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ event: "clarify.request", prompt_id: PROMPT_ID, question: QUESTION, choices: ["the first", "the second (Recommended)"], multi_select: false, seq: 1 })}\n\n`,
        );
      }
      openStreams.add(res);
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one) return json(200, { status: statuses.get(one[1]) || "running", output: "", usage: {} });
    const clarify = /^\/v1\/runs\/([^/]+)\/clarify$/.exec(url.pathname);
    if (clarify && req.method === "POST") {
      return json(200, { ok: true, prompt_id: PROMPT_ID });
    }
    return json(404, { error: "not found" });
  });
  const base = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => {
    for (const res of openStreams) res.destroy();
    server.closeAllConnections?.();
    server.close();
  });
  return { base, bodies, statuses };
}

const until = async (fn, what, ms = 5000) => {
  const stop = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-reuse-"));
  // A real git tree: `answerThread` resolves the thread's tree through own-tree.js, which asks git, so an empty
  // folder would be refused as "not a tree of its own" and the reply would never be posted.
  await run("git", ["init", "-q", dir]);
  await run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root"]);
  const gw = await stubGateway(t);
  const jobsFile = path.join(dir, "jobs.json");
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const jobs = new Jobs({ config: { apiServer: { url: gw.base, key: "test-key" }, jobsFile, defaultCwd: dir }, onLog: () => {} });
  const assistant = new Assistant({ config: { jobsFile, assistantFile }, jobs, getProjects: () => [], onLog: () => {} });
  t.after(async () => {
    for (const j of jobs.list()) {
      const raw = jobs.get(j.id);
      if (!raw) continue;
      raw.status = "done";
      raw.ctrl?.abort();
      clearTimeout(raw.timer);
      clearTimeout(raw.poller);
    }
    clearTimeout(jobs.persistTimer);
    clearTimeout(assistant.timer);
    clearTimeout(assistant.wakeTimer);
    clearTimeout(assistant.persistTimer);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, jobs, assistant, bodies: gw.bodies, statuses: gw.statuses };
}

// The card the reader is looking at: a run that asked, and then ENDED (its cap fired, the gateway dropped it, or
// the reader answered a card that had already gone by).
async function endedCard(t) {
  const p = await panel(t);
  const asking = await p.jobs.create({ prompt: "draft the ticket comment", thread: ASKING_THREAD, existing: true, worktree: false, anchorCwd: false, cwd: p.dir });
  await until(() => p.jobs.get(asking.id)?.question, "the run to park on its question");
  // The run ends under the card, which is exactly the case the reply path is for.
  const raw = p.jobs.get(asking.id);
  raw.ctrl?.abort();
  raw.status = "done";
  p.statuses.set("run_1", "completed");
  return { ...p, asking: p.jobs.get(asking.id) };
}

test("an answer to a card whose run ended continues the ASKING thread, not a newly minted one", async (t) => {
  const { jobs, assistant, asking, bodies } = await endedCard(t);
  const before = jobs.list().length;
  const postsBefore = bodies.length;

  // The parked-run path refuses first, and says why - that refusal is what USED to leave the follow-up to a new
  // session in the same tree.
  const parked = await jobs.answerQuestion(asking.id, "the second");
  assert.equal(parked.ok, false);
  assert.equal(parked.undelivered, true, "the parked run is gone, so the panel cannot claim delivery through it");
  assert.equal(parked.runStatus, "completed");

  const out = await assistant.deliverClarifyAnswer(asking.id, "the second");

  assert.equal(out.ok, true, `the answer must still land: ${out.error || out.why || ""}`);
  assert.equal(out.mode, "reply", "an ended run's answer continues the asking thread");
  // THE ASSERTION THIS CHANGE EXISTS FOR: the answering turn carries the ASKING thread's id.
  assert.equal(out.thread, ASKING_THREAD, "the answering turn is on the thread that asked");
  assert.equal(out.thread, asking.thread, "…which is the card's own thread");

  const answerTurn = jobs.get(out.jobId);
  assert.ok(answerTurn, "an answering turn exists");
  assert.notEqual(answerTurn.id, asking.id, "it is a new turn, not the dead one");
  assert.equal(answerTurn.thread, ASKING_THREAD, "the new turn carries the asking thread's id");
  assert.equal(answerTurn.thread, asking.thread, "and never a newly minted one");
  assert.equal(answerTurn.sessionId, ASKING_THREAD, "it continues that session, so the context it holds is still there");
  assert.equal(answerTurn.reply, true, "it is a reply on the thread, the one shape that resumes a session");
  assert.ok(answerTurn.turn > asking.turn, "it is the next turn of that thread");
  assert.equal(jobs.list().length, before + 1, "exactly one turn was started");
  assert.equal(bodies.length, postsBefore + 1, "exactly one run was posted");
  assert.equal(bodies[bodies.length - 1].session_id, ASKING_THREAD, "and it was posted AS that session");
  assert.match(bodies[bodies.length - 1].input, /the reader has answered the question this thread asked/);
  assert.match(bodies[bodies.length - 1].input, /answer: the second/);

  t.diagnostic(`asking thread ${asking.thread} (run ${asking.runId}) -> answering thread ${answerTurn.thread} (run ${out.runId})`);
});

test("an answer to a LIVE parked run resumes that run and starts no turn at all", async (t) => {
  const p = await panel(t);
  const asking = await p.jobs.create({ prompt: "draft the ticket comment", thread: ASKING_THREAD, existing: true, worktree: false, anchorCwd: false, cwd: p.dir });
  await until(() => p.jobs.get(asking.id)?.question, "the run to park on its question");
  const before = p.jobs.list().length;

  const out = await p.assistant.deliverClarifyAnswer(asking.id, "the second");

  assert.equal(out.ok, true, `the parked run must take it: ${out.error || out.why || ""}`);
  assert.equal(out.mode, "resume");
  assert.equal(out.thread, ASKING_THREAD);
  assert.equal(p.jobs.list().length, before, "no turn was started: the parked run carries on");
  assert.equal(p.jobs.get(asking.id).thread, ASKING_THREAD, "the card's own thread is untouched");
  t.diagnostic(`resumed thread ${out.thread} run ${out.runId} - no new turn`);
});

test("the gear-change path still starts a fresh session in the same tree, by request", async (t) => {
  const { jobs, assistant, asking, dir } = await endedCard(t);
  const before = jobs.list().length;

  const out = await assistant.deliverClarifyAnswer(asking.id, "different task: post the changelog instead", { fresh: true });

  assert.equal(out.ok, true, `a fresh session must still be reachable: ${out.error || out.why || ""}`);
  assert.equal(out.mode, "fresh", "the manager's explicit path is a mode, not the default");
  assert.notEqual(out.thread, ASKING_THREAD, "a fresh session is a new thread");
  const freshTurn = jobs.get(out.jobId);
  assert.equal(freshTurn.thread, out.thread);
  assert.notEqual(freshTurn.thread, asking.thread);
  assert.notEqual(freshTurn.reply, true, "it is not a reply on the asking thread");
  assert.equal(freshTurn.cwd, dir, "it still runs in the same tree");
  assert.equal(freshTurn.existing, true, "no new tree is cut for an answer");
  assert.equal(jobs.list().length, before + 1);
  t.diagnostic(`fresh session ${freshTurn.thread} (run ${out.runId}) in ${freshTurn.cwd}, asked from ${asking.thread}`);
});

test("the managers' shared action prompt asks for a continuation on the asking thread", () => {
  const grammar = actionGrammar({}).join(String.fromCharCode(10));
  assert.match(grammar, /TO <its thread>/, "the prompt names the continuation line");
  assert.match(grammar, /not `SPAWN IN` its tree/, "and refuses the fresh session in the same tree as the default");
  assert.match(grammar, /different task, a different tree, a different repo/, "the gear change is named");
  assert.match(grammar, /context is already large/, "the second escape - a large context - is named too");
  // The fresh path is still a line the manager can write, and it still parses.
  const parsed = parseActions("SPAWN IN wtgui-reuse-the-asking-thread | post the changelog instead");
  assert.equal(parsed.spawn.length, 1, "SPAWN IN is still a line the panel reads");
  assert.equal(parsed.spawn[0].existing, true, "SPAWN IN is still how a manager starts a run in a tree that already stands");
  assert.equal(parsed.spawn[0].target, "wtgui-reuse-the-asking-thread");
});
