// A cancelled run, and an answer that arrives after it ended.
//
// The gateway resolves a clarify prompt on a run it has already cancelled and still answers `200
// {status:"resolved"}` — so the POST's own verdict is not the run's. Reading it as delivery wrote "answered" onto
// a turn that could never resume, cleared the one box the reader could still see, and left the card `running`
// (LIVE) on a run the gateway had already ended, which in turn refused every send to that thread.
//
// These cases are the contract: an answer to a run that has already ended is refused and says so, the question is
// not cleared by it, a terminal run's card settles on ONE sweep with the reason on the jobs log, and a live run's
// answer lands exactly as it did before.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const RUN = "run_5c1d2a77e0b34f0c9a1b";
const THREAD = "wtgui-make-a-clarify-answer-to-64120f";

const answer = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// One card parked on a question, with the gateway stubbed at `fetch`. `runStatus` is what GET /v1/runs says, and
// every POST is counted so a case can prove the panel did not spend one on a run it already knows is over.
async function panel(t, { runStatus = "running", post = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-clarify-cancelled-"));
  const logs = [];
  const posts = [];
  const jobs = new Jobs({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      apiServer: { url: "http://gateway.test", key: "test-key" },
      jobMaxRuntimeSeconds: 3600,
      defaultCwd: dir,
    },
    onEvent: () => {},
    onLog: (m) => logs.push(String(m)),
  });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v1/capabilities")) return answer({ features: {}, version: "test" });
    if (u.includes("/clarify") && String(init.method || "").toUpperCase() === "POST") {
      posts.push(JSON.parse(String(init.body || "{}")));
      return post ? post() : answer({ run_id: RUN, status: "resolved", prompt_id: "p1" });
    }
    if (u.includes(`/v1/runs/${RUN}`)) {
      return answer({
        run_id: RUN,
        status: runStatus,
        execution_generation: 1,
        output: runStatus === "cancelled" ? "" : "working",
        pending_controls: [
          { kind: "clarify", prompt_id: "p1", execution_generation: 1, question: "Ship it to main?" },
        ],
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  t.after(async () => {
    globalThis.fetch = real;
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    clearTimeout(jobs.persistTimer);
    await rm(dir, { recursive: true, force: true });
  });
  const card = {
    id: "job-1",
    thread: THREAD,
    runId: RUN,
    status: "running",
    prompt: "make the clarify answer to a dead run say so",
    model: "test/model",
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lines: [{ kind: "init", text: `run ${RUN}`, at: Date.now() - 5 * 60_000 }],
    streamOpen: false,
    question: {
      key: `clarify:job-1:p1`,
      requestId: "p1",
      question: "Ship it to main?",
      choices: ["yes", "no"],
      multiSelect: false,
      timeoutSeconds: null,
      deadline: null,
      at: new Date(Date.now() - 60_000).toISOString(),
      reasks: 0,
      lastAskedAt: null,
    },
    questionDone: null,
  };
  jobs.jobs.set(card.id, card);
  return { jobs, logs, card, posts, dir };
}

test("an answer to a cancelled run is undelivered, and the question stays", async (t) => {
  const { jobs, logs, card, posts } = await panel(t, { runStatus: "cancelled" });

  const out = await jobs.answerQuestion("job-1", "yes", "p1");

  assert.equal(out.ok, false, "a dead run cannot take the answer");
  assert.equal(out.undelivered, true, "the caller can tell a refusal from a missing field");
  assert.equal(out.runStatus, "cancelled");
  assert.match(out.error, /already ended \(cancelled\)/);
  assert.equal(posts.length, 0, "nothing is POSTed to a run already known to be over");
  assert.ok(card.question, "the box stays: the reader can see the answer never landed");
  assert.equal(card.questionDone, null, '"answered" is not written onto a run that ended');
  assert.equal(card.status, "running", "the answer path does not decide the run's own status");
  const line = logs.find((m) => /undelivered/.test(m));
  assert.ok(line, "the refusal is journaled");
  assert.ok(line.includes(RUN), `and names the run: ${line}`);
});

test("a cancelled run's job settles on the next sweep, with the reason journaled", async (t) => {
  const { jobs, logs, card } = await panel(t, { runStatus: "cancelled" });

  await jobs.sweepOrphanedRuns(Date.now());

  assert.equal(card.status, "cancelled", "a card cannot stay LIVE on a run the gateway ended");
  assert.ok(card.endedAt, "the clock stopped");
  assert.ok(card.questionDone?.closed, "the parked question is closed with the turn that can never take it");
  assert.equal(card.question, null);
  const journal = logs.find((m) => m.includes("run job-1") && m.includes(RUN) && /already ended/.test(m));
  assert.ok(journal, `the reason names the run and its terminal status: ${logs.join(" | ")}`);
  const line = card.lines.map((l) => String(l.text || "")).find((x) => /run cancelled in the gateway/.test(x));
  assert.ok(line, "the card says what settled it");
  assert.match(line, /already ended it \(cancelled\)/);
  assert.doesNotMatch(line, /restart/i, "a live sweep is not a restart's write-off");
});

test("a live run's answer still lands, and the card still reads 'answered'", async (t) => {
  const { jobs, card, posts } = await panel(t, { runStatus: "running" });

  const out = await jobs.answerQuestion("job-1", "yes", "p1");

  assert.equal(out.ok, true, "a parked run takes the answer as it always did");
  assert.equal(out.answer, "yes");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { answer: "yes", request_id: "p1", execution_generation: 1 });
  assert.equal(card.question, null, "the box collapses");
  assert.deepEqual({ answer: card.questionDone.answer }, { answer: "yes" });
});

// The page half: a delivered answer still reads `✓ answered: …`, and a refusal is printed where the reader is
// looking (the box's warn slot), with the question still on the card because nothing was delivered.
test("the page keeps '✓ answered' for a delivered answer and prints the refusal for an undelivered one", async () => {
  const page = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const answered = sliceBetween(page, "function questionAnswered(", "// Answer a question a run is parked on.");
  const questionAnswered = new Function("esc", `${answered}; return questionAnswered;`)((s) => String(s));

  assert.equal(questionAnswered({ question: { question: "Ship it?" }, questionDone: null }), "", "a parked question never reads answered");
  assert.match(questionAnswered({ question: null, questionDone: { answer: "yes" } }), /✓ answered: yes/);
  assert.match(questionAnswered({ question: null, questionDone: { answer: "", closed: true } }), /closed without an answer here/);

  // The undelivered path is the shipped refusal path: `out.error` goes into the box's warn slot and the buttons
  // come back, so the reader can answer the same question again when a live run offers it.
  const submit = sliceBetween(page, "async function answerRunQuestion(", "// A turn is open when");
  assert.match(submit, /if \(warn\) warn\.textContent = text;/, "the refusal is written in the box");
  assert.match(submit, /for \(const b of buttons\) b\.disabled = false;/, "and the answer controls stay usable");
});
