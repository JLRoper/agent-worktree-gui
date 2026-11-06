// A repair turn must not continue a session the gateway has lost.
//
// Measured twice on this board: run_741516853a… and run_b0632b9cdae5… each ended `unknown_execution` in 3-4s, and the
// gateway answered both as `queued` with `execution_generation: null` — the fence docs/research/assistant-session-fence.md
// describes. The store refuses to claim a session whose head admission is `unknown`, so a run admitted on that session
// is ACCEPTED and never executed. `lib/jobs.js` re-posted every repair to the same `session_id` (`continuing session
// <thread> · turn N`), so each repair inherited the dead session and queued for ever.
//
// These cases are the contract. The two shapes that mean "the gateway lost this session" — a run that ended
// `unknown_execution`, and a run id the gateway still answers `queued` with no generation — open a NEW session (same
// tree, same prompt) and say so on the card. A repair on a healthy session still continues it, so a retry after a
// timeout is not a cold start. And a run the gateway admitted but never claimed is written off the way an `unknown`
// run is: the card takes the gateway's own word, and NO stop is sent, because the old id is left where it is —
// for a card that cannot re-post its request (one the store restored). A card that still holds its body replaces
// the session on that answer instead: test/session-replace-on-unknown.test.js.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

const THREAD = "wtgui-a-repair-turn-must-not-c-aa2953";
const OLD_RUN = "run_741516853a4648d99e2badb5e5f67b54";
const NEW_RUN = "run_11112222333344445555666677778888";
const PROMPT = "finish the remaining items in this tree";

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// A gateway whose run records a case can set, and which remembers every POST it was handed.
function stubGateway(t, runs = {}) {
  const real = globalThis.fetch;
  const posted = [];
  const stopped = [];
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.endsWith("/v1/capabilities")) return json({ features: {}, version: "test" });
    // The clarify route probe: this build does not have it, which changes only the prompt's hint.
    if (/\/clarify$/.test(u)) return json({ error: { code: "run_not_found" } }, 404);
    if (/\/stop$/.test(u)) {
      stopped.push(u);
      return json({ ok: true });
    }
    if (u.endsWith("/v1/runs") && method === "POST") {
      posted.push(JSON.parse(init.body));
      return json({ run_id: NEW_RUN, status: "started" }, 202);
    }
    const one = /\/v1\/runs\/([^/]+)$/.exec(u);
    if (one) {
      asked.push(one[1]);
      const row = runs[one[1]];
      if (!row) return json({ error: { code: "run_not_found" } }, 404);
      return json({ run_id: one[1], ...row });
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return { posted, stopped, asked };
}

async function panel(t, { runs = {}, cards = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-repair-"));
  const logs = [];
  const jobs = new Jobs({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      apiServer: { url: "http://gateway.test", key: "test-key" },
      jobMaxRuntimeSeconds: 900,
      defaultCwd: dir,
    },
    onEvent: () => {},
    onLog: (m) => logs.push(String(m)),
  });
  const gw = stubGateway(t, runs);
  for (const c of cards) jobs.jobs.set(c.id, { lines: [], ...c });
  t.after(async () => {
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    // A card this case left live still holds its poller and stats clock; they would keep the runner alive for ever.
    for (const j of jobs.jobs.values()) {
      clearTimeout(j.timer);
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      try {
        j.ctrl?.abort();
      } catch {
        /* already closed */
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { jobs, logs, dir, gw };
}

const priorTurn = (dir, over = {}) => ({
  id: "job-0f46b471",
  thread: THREAD,
  turn: 2,
  sessionId: THREAD,
  runId: OLD_RUN,
  status: "failed",
  error: "unknown_execution",
  prompt: PROMPT,
  cwd: dir,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endedAt: new Date(Date.now() - 56_000).toISOString(),
  ...over,
});

const repair = (dir) => ({ prompt: PROMPT, thread: THREAD, reply: true, cwd: dir, existing: true, ownerPath: dir });
const lineText = (job) => (job.lines || []).map((l) => String(l.text || "")).join("\n");

test("a last run that ended unknown_execution: the repair opens a NEW session and says so", async (t) => {
  const { jobs, dir, gw } = await panel(t, { cards: [] });
  const before = priorTurn(dir);
  jobs.jobs.set(before.id, { lines: [], ...before });

  const card = await jobs.create(repair(dir));
  const job = jobs.jobs.get(card.id);

  assert.equal(gw.posted.length, 1, "one POST, as always");
  assert.equal(gw.posted[0].session_id, job.sessionId, "the body posts the id the card records");
  assert.notEqual(gw.posted[0].session_id, THREAD, "the repair must NOT re-post to the session the gateway lost");
  assert.match(gw.posted[0].session_id, /^wtgui-finish-the-remaining-items-i-[a-z0-9]{6}$/, "a fresh Hermes session id, made the way a first turn's is");
  assert.equal(job.thread, THREAD, "the card's thread is unchanged — the conversation still groups under it");
  assert.deepEqual(job.sessionReplaced, {
    from: THREAD,
    to: job.sessionId,
    why: `run ${OLD_RUN} ended unknown_execution`,
    runId: OLD_RUN,
  });
  assert.match(lineText(job), /session replaced/, "the card says the session was replaced");
  assert.match(lineText(job), new RegExp(job.sessionId), "…and names the session it opened");
  assert.match(lineText(job), /NEW session/, "the init line does not pretend to continue the dead one");
  assert.deepEqual(gw.stopped, [], "the lost session's run is left where it is — no stop is sent");
  assert.equal(card.sessionReplaced?.to, job.sessionId, "the summary carries it to the page");

  // The new session is the one that answers; the old run's id is never posted to again.
  jobs.settle(job, "completed", { output: "OK" });
  assert.equal(job.status, "done");
  assert.equal(job.finalMessage, "OK");
});

test("a run the gateway answers queued with no generation is the same wedge", async (t) => {
  // The card's own error is NOT the gateway's word here — this is the second reading, the one the status endpoint
  // gives: admitted, never claimed. A repair must treat it as lost all the same.
  const { jobs, dir, gw } = await panel(t, { runs: { [OLD_RUN]: { status: "queued", execution_generation: null } } });
  jobs.jobs.set("job-queued", {
    lines: [],
    ...priorTurn(dir, { error: "the gateway restarted while this was running", status: "interrupted" }),
  });

  const card = await jobs.create(repair(dir));
  assert.notEqual(gw.posted[0].session_id, THREAD, "queued-with-no-generation opens a new session too");
  assert.match(card.sessionReplaced?.why || "", /queued with no execution generation/);
});

test("an ordinary failed run still continues its own session — a retry is not a cold start", async (t) => {
  const { jobs, dir, gw } = await panel(t, { runs: { [OLD_RUN]: { status: "failed", error: "killed", execution_generation: 3 } } });
  jobs.jobs.set("job-killed", { lines: [], ...priorTurn(dir, { error: "killed: exceeded 900s panel cap" }) });

  const card = await jobs.create(repair(dir));

  assert.equal(gw.posted[0].session_id, THREAD, "a run that merely timed out keeps its session");
  assert.equal(card.sessionReplaced, null, "no replacement is claimed where none happened");
  assert.match(lineText(jobs.jobs.get(card.id)), /continuing session/);
});

test("the replacement is not repeated: the next turn continues the session the repair opened", async (t) => {
  const NEWEST = "wtgui-a-repair-turn-must-not-c-9ab9ab";
  const { jobs, dir, gw } = await panel(t, { runs: { [NEWEST]: { status: "completed", execution_generation: 4 } } });
  jobs.jobs.set("job-repaired", {
    lines: [],
    ...priorTurn(dir, {
      status: "done",
      error: null,
      runId: "run_92022aaaaabbbbbcccccddddd",
      sessionId: NEWEST,
      sessionReplaced: { from: THREAD, to: NEWEST, why: `run ${OLD_RUN} ended unknown_execution`, runId: OLD_RUN },
    }),
  });

  const card = await jobs.create(repair(dir));

  assert.equal(gw.posted[0].session_id, NEWEST, "continuing the thread must follow the repaired session, not the fence");
  assert.equal(card.sessionReplaced, null, "one replacement per lost session, not one per turn");
});

test("a card with no request to re-post is written off when the gateway admits and never claims — twice, and without a stop", async (t) => {
  const { jobs, logs, dir, gw } = await panel(t, { runs: { [OLD_RUN]: { status: "queued", execution_generation: null } } });
  const card = {
    id: "job-wedged",
    thread: THREAD,
    turn: 1,
    sessionId: THREAD,
    runId: OLD_RUN,
    status: "running",
    prompt: PROMPT,
    cwd: dir,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lines: [],
    streamOpen: false,
  };
  jobs.jobs.set(card.id, card);
  const now = Date.now();

  assert.deepEqual(await jobs.sweepOrphanedRuns(now), [], "one queued answer is a run that was just admitted");
  assert.equal(card.status, "running", "the card is left alone on the first answer");

  await jobs.sweepOrphanedRuns(now + 15_000);
  assert.equal(card.status, "failed", "the second answer is the panel's evidence");
  assert.equal(card.error, "unknown_execution", "the card keeps the gateway's own word, which the repair keys on");
  assert.ok(card.endedAt, "the clock stopped");
  assert.match(lineText(card), /never claimed it/);
  assert.deepEqual(gw.stopped, [], "a run that never started owes no stop — the old id stays queued");
  assert.ok(
    logs.some((m) => m.includes("queued with no execution generation")),
    "the journal names the answer that settled the card",
  );
});

test("a run that is queued for a moment and then starts is not written off", async (t) => {
  let answers = 0;
  const { jobs, dir } = await panel(t, {});
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/capabilities")) return json({ features: {}, version: "test" });
    answers += 1;
    return answers === 1
      ? json({ run_id: OLD_RUN, status: "queued", execution_generation: null })
      : json({ run_id: OLD_RUN, status: "running", execution_generation: 1 });
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const card = {
    id: "job-warmup",
    thread: THREAD,
    turn: 1,
    sessionId: THREAD,
    runId: OLD_RUN,
    status: "running",
    cwd: dir,
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    lines: [],
    streamOpen: true,
  };
  jobs.jobs.set(card.id, card);

  const now = Date.now();
  await jobs.sweepOrphanedRuns(now);
  assert.equal(card.status, "running");
  assert.equal(card.unclaimedAnswers?.length, 1, "the answer is recorded, not acted on");

  await jobs.sweepOrphanedRuns(now + 15_000);
  assert.equal(card.status, "running", "the run moved on, so the card is live");
  assert.equal(card.unclaimedAnswers, null, "a run that started clears the record");
});
