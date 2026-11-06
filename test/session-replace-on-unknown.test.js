// The gateway's `unknown_execution` on a run it admitted and never claimed is the SESSION's answer, and the panel
// owes it a replacement rather than a write-off.
//
// Measured on this board, 2026-11-06: six turns across panel-assistant (turn 28, 19:30), panel-assistant-3
// (turns 12-14, 19:18-19:33) and panel-assistant-4 (turns 12-13, 19:34-19:36) each read
// "the gateway admitted run … but never claimed it (queued with no execution generation)". Nothing ran. Each card
// was written off, and the turn after it re-posted to the same session id — because the thread's card that spoke
// for the session was chosen by `turn`, and a turn number REPEATS as the store prunes a thread's older cards
// (`turn: siblings.length + 1`). panel-assistant-4's highest turn (23) belonged to a card from 18:10, three hours
// before the failure at 19:34.
//
// Two contracts, pinned here on the three sessions' own shapes:
//   * the sweep replaces the session ON that answer — same card, same prompt, one re-post — instead of writing
//     the turn off, so no turn that never started is lost;
//   * a thread's session is the one its NEWEST card names, on the clock, never the highest turn number.
// The write-off still stands where a replacement cannot be made: a card the store restored has no request body to
// re-post, and a card replaces its session at most once.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const PROMPT = "sweep the queue";

// A gateway that answers the fence for the run ids it is told to, `run_not_found` for every other, and records
// what was posted. `answers` is per run id: `{status, execution_generation}`.
function stubGateway(t, fenced = {}, { postStatus = 202 } = {}) {
  const real = globalThis.fetch;
  const posted = [];
  const asked = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.endsWith("/v1/capabilities")) return json({ features: {}, version: "test" });
    if (/\/clarify$/.test(u)) return json({ error: { code: "run_not_found" } }, 404);
    if (/\/stop$/.test(u)) return json({ ok: true });
    if (u.endsWith("/v1/runs") && method === "POST") {
      posted.push(JSON.parse(init.body));
      if (postStatus >= 300) return json({ error: { message: "refused" } }, postStatus);
      n += 1;
      return json({ run_id: `run_new${n}00`, status: "started" }, 202);
    }
    const one = /\/v1\/runs\/([^/]+)$/.exec(u);
    if (one) {
      asked.push(one[1]);
      const row = fenced[one[1]];
      if (!row) return json({ error: { code: "run_not_found" } }, 404);
      return json({ run_id: one[1], ...row });
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return { posted, asked };
}

async function panel(t, opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-session-replace-"));
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
  const gw = stubGateway(t, opts.fenced || {}, { postStatus: opts.postStatus });
  t.after(async () => {
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
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

// One card of a thread, as the store holds it. `startedAt` is minutes ago, so a case can say which card is the
// newest on the clock and which merely carries the highest turn number.
const cardOf = ({ id, thread, turn, status, error = null, runId, minutesAgo, sessionId = thread, requestBody = null }) => ({
  id,
  thread,
  turn,
  sessionId,
  runId,
  status,
  error,
  prompt: PROMPT,
  cwd: null,
  startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  endedAt: new Date(Date.now() - (minutesAgo - 1) * 60_000).toISOString(),
  lines: [],
  ...(requestBody ? { requestBody } : {}),
});
const lineText = (job) => (job.lines || []).map((l) => String(l.text || "")).join("\n");

// ---- the three sessions, their own shapes, and the replacement ------------------------------------------

// panel-assistant-3: turn 16 from 19:01 still stood when turn 12 failed at 19:18, so the highest turn number
// belonged to a card that was 17 minutes older and had ended `cancelled`.
test("panel-assistant-3: the fenced answer replaces the session instead of writing the turn off", async (t) => {
  const FENCED_RUN = "run_0d761663d3fe41f89a6183e42f43701d";
  const { jobs, logs, dir, gw } = await panel(t, { fenced: { [FENCED_RUN]: { status: "queued", execution_generation: null } } });
  const card = cardOf({
    id: "6c0cad5a",
    thread: "panel-assistant-3",
    turn: 12,
    status: "running",
    runId: FENCED_RUN,
    minutesAgo: 2,
    requestBody: { input: PROMPT, session_id: "panel-assistant-3", cwd: dir },
  });
  card.cwd = dir;
  jobs.jobs.set(card.id, card);
  // the older card whose turn number is higher — the one the old ordering read
  jobs.jobs.set("50acb288", { ...cardOf({ id: "50acb288", thread: "panel-assistant-3", turn: 16, status: "cancelled", runId: "run_b7b97bd0e0f14ec583d5fe27de34b9dd", minutesAgo: 45 }), lines: [] });

  const now = Date.now();
  assert.deepEqual(await jobs.sweepOrphanedRuns(now), [], "a run queued a moment ago is not a fence");
  assert.equal(card.status, "running", "one answer is not evidence");

  await jobs.sweepOrphanedRuns(now + 15_000);
  assert.equal(card.status, "running", "the turn is NOT written off — nothing ran, so nothing is lost");
  assert.equal(card.error, null, "no failure is recorded against a turn that will still run");
  assert.ok(card.sessionReplaced, "the card records the replacement");
  assert.equal(card.sessionReplaced.from, "panel-assistant-3");
  assert.match(card.sessionReplaced.why, /queued with no execution generation/);
  assert.equal(card.sessionReplaced.runId, FENCED_RUN, "the fenced run is named, not silently dropped");
  assert.equal(gw.posted.length, 1, "one re-post, not a storm");
  assert.equal(gw.posted[0].session_id, card.sessionId, "posted to the session the card now records");
  assert.notEqual(gw.posted[0].session_id, "panel-assistant-3", "never re-posted to the fenced session");
  assert.equal(gw.posted[0].input, PROMPT, "the SAME request, byte for byte");
  assert.equal(card.runId, "run_new100", "the card watches the run the re-post was given");
  assert.equal(card.thread, "panel-assistant-3", "the conversation still groups under its own thread");
  assert.match(lineText(card), /session replaced/, "the reader is told on the card");
  assert.match(lineText(card), /NEW session \(the last one was lost\)/, "the init line does not pretend to continue it");
  assert.ok(logs.some((m) => m.includes("replaced with")), "the journal names the replacement");
});

// panel-assistant: same fence, its own session id, and the turn number that spoke for it was 29 from 19:01.
test("panel-assistant: the fence is answered with a new session, and the card keeps its turn", async (t) => {
  const FENCED_RUN = "run_cad05c381c964f88bbc7d5f6c47d9717";
  const { jobs, dir, gw } = await panel(t, { fenced: { [FENCED_RUN]: { status: "queued", execution_generation: null } } });
  const card = cardOf({
    id: "9eb792fe",
    thread: "panel-assistant",
    turn: 28,
    status: "running",
    runId: FENCED_RUN,
    minutesAgo: 3,
    requestBody: { input: PROMPT, session_id: "panel-assistant", cwd: dir },
  });
  card.cwd = dir;
  jobs.jobs.set(card.id, card);
  jobs.jobs.set("4209fb0c", { ...cardOf({ id: "4209fb0c", thread: "panel-assistant", turn: 29, status: "done", runId: "run_a1111111111111111111111111111111", minutesAgo: 90 }), lines: [] });

  const now = Date.now();
  await jobs.sweepOrphanedRuns(now);
  await jobs.sweepOrphanedRuns(now + 15_000);

  assert.equal(card.status, "running");
  assert.equal(card.turn, 28, "the replacement is the same turn, not a new one");
  assert.match(card.sessionId, /^wtgui-sweep-the-queue-[a-z0-9]{6}$/, "a fresh Hermes session id");
  assert.equal(gw.posted[0].session_id, card.sessionId);
});

// panel-assistant-4: the failed card (19:34) was NEWER than every card on its thread but carried turn 12 while
// turn 23 sat on a card from 18:10, and its session had 6.8% context — the cheapest kind of session to replace.
test("panel-assistant-4: a reused turn number does not hide the fence, and the context is restarted cheaply", async (t) => {
  const FENCED_RUN = "run_370a1aecff104969a9ae642d1ffe1c1f";
  const { jobs, dir, gw } = await panel(t, { fenced: { [FENCED_RUN]: { status: "queued", execution_generation: null } } });
  const card = cardOf({
    id: "d23fabb5",
    thread: "panel-assistant-4",
    turn: 12,
    status: "running",
    runId: FENCED_RUN,
    minutesAgo: 2,
    requestBody: { input: PROMPT, session_id: "panel-assistant-4", cwd: dir },
  });
  card.cwd = dir;
  jobs.jobs.set(card.id, card);
  jobs.jobs.set("3cda4774", { ...cardOf({ id: "3cda4774", thread: "panel-assistant-4", turn: 23, status: "done", runId: "run_66ddc52d92fe4f32896ee063aff34543", minutesAgo: 200 }), lines: [] });

  const now = Date.now();
  await jobs.sweepOrphanedRuns(now);
  await jobs.sweepOrphanedRuns(now + 15_000);

  assert.equal(card.status, "running", "the turn survives the answer");
  assert.ok(card.sessionReplaced, "and its session is the one that changed");
  assert.equal(gw.posted[0].session_id, card.sessionId);
});

// ---- the ordering contract ------------------------------------------------------------------------------

test("a thread's session is the one its NEWEST card names, not the highest turn number", async (t) => {
  const { jobs, dir, gw } = await panel(t, {});
  const THREAD = "panel-assistant-4";
  // The repaired card: newest on the clock, turn 12, session replaced once already.
  jobs.jobs.set("new", {
    ...cardOf({ id: "new", thread: THREAD, turn: 12, status: "done", runId: "run_ffffffffffffffffffffffffffffffff", minutesAgo: 1, sessionId: "wtgui-a-new-session-9ab9ab" }),
    lines: [],
  });
  // An older card with a higher turn number, still naming the fenced session.
  jobs.jobs.set("old", { ...cardOf({ id: "old", thread: THREAD, turn: 23, status: "done", runId: "run_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", minutesAgo: 200, sessionId: THREAD }), lines: [] });

  const card = await jobs.create({ prompt: PROMPT, thread: THREAD, reply: true, cwd: dir, existing: true, ownerPath: dir, anchorCwd: false });

  assert.equal(gw.posted[0].session_id, "wtgui-a-new-session-9ab9ab", "the next turn continues the repaired session");
  assert.equal(card.sessionReplaced, null, "nothing is replaced twice");
  assert.equal(jobs.sessionFor([...jobs.jobs.values()].filter((j) => j.thread === THREAD && j.id !== card.id)), "wtgui-a-new-session-9ab9ab");
});

// ---- where the write-off still stands -------------------------------------------------------------------

test("a card the store restored has no request to re-post: the turn is written off as before", async (t) => {
  const FENCED_RUN = "run_11111111111111111111111111111111";
  const { jobs, dir } = await panel(t, { fenced: { [FENCED_RUN]: { status: "queued", execution_generation: null } } });
  const card = cardOf({ id: "restored", thread: "panel-assistant-3", turn: 9, status: "running", runId: FENCED_RUN, minutesAgo: 2 });
  card.cwd = dir;
  jobs.jobs.set(card.id, card);

  const now = Date.now();
  await jobs.sweepOrphanedRuns(now);
  await jobs.sweepOrphanedRuns(now + 15_000);

  assert.equal(card.status, "failed");
  assert.equal(card.error, "unknown_execution", "the card keeps the gateway's own word the next repair keys on");
  assert.ok(!card.sessionReplaced, "no replacement is claimed where none was made");
});

test("a second fence on a session this panel opened is written off, not replaced again", async (t) => {
  const RUN = "run_22222222222222222222222222222222";
  const { jobs, dir, gw } = await panel(t, { fenced: { [RUN]: { status: "queued", execution_generation: null } } });
  const card = cardOf({
    id: "twice",
    thread: "panel-assistant",
    turn: 30,
    status: "running",
    runId: RUN,
    minutesAgo: 2,
    sessionId: "wtgui-the-one-it-opened-1a2b3c",
    requestBody: { input: PROMPT, session_id: "wtgui-the-one-it-opened-1a2b3c", cwd: dir },
  });
  card.cwd = dir;
  card.sessionReplaced = { from: "panel-assistant", to: "wtgui-the-one-it-opened-1a2b3c", why: "run earlier", runId: "run_0" };
  jobs.jobs.set(card.id, card);

  const now = Date.now();
  await jobs.sweepOrphanedRuns(now);
  await jobs.sweepOrphanedRuns(now + 15_000);

  assert.equal(gw.posted.length, 0, "no second replacement");
  assert.equal(card.status, "failed", "the gateway naming a real fault is the reader's call, not a silent re-run");
});

test("the re-post is refused: the card still takes the gateway's word", async (t) => {
  const RUN = "run_33333333333333333333333333333333";
  const { jobs, dir, gw } = await panel(t, { fenced: { [RUN]: { status: "queued", execution_generation: null } }, postStatus: 503 });
  const card = cardOf({
    id: "refused",
    thread: "panel-assistant",
    turn: 31,
    status: "running",
    runId: RUN,
    minutesAgo: 2,
    requestBody: { input: PROMPT, session_id: "panel-assistant", cwd: dir },
  });
  card.cwd = dir;
  jobs.jobs.set(card.id, card);

  const now = Date.now();
  await jobs.sweepOrphanedRuns(now);
  await jobs.sweepOrphanedRuns(now + 15_000);

  assert.equal(gw.posted.length, 1, "the replacement was attempted");
  assert.equal(card.status, "failed", "and the turn is still settled rather than left live for ever");
  assert.equal(card.error, "unknown_execution");
  assert.match(lineText(card), /could not replace session/, "the card says the repair did not take");
  assert.equal(card.sessionId, "panel-assistant", "a failed re-post does not move the card's session");
});

// ---- the shape that must NOT be re-run ------------------------------------------------------------------

test("an unknown RUN (not a fenced admission) is still written off: it may have executed", async (t) => {
  const RUN = "run_44444444444444444444444444444444";
  const { jobs, dir, gw } = await panel(t, { fenced: { [RUN]: { status: "unknown", execution_generation: 2, admission_id: "adm-1" } } });
  const card = cardOf({
    id: "unknown-run",
    thread: "panel-assistant-3",
    turn: 20,
    status: "running",
    runId: RUN,
    minutesAgo: 2,
    requestBody: { input: PROMPT, session_id: "panel-assistant-3", cwd: dir },
  });
  card.cwd = dir;
  jobs.jobs.set(card.id, card);

  const now = Date.now();
  await jobs.sweepOrphanedRuns(now);
  await jobs.sweepOrphanedRuns(now + 15_000);

  assert.equal(gw.posted.length, 0, "a run that may have run is never re-posted behind the reader's back");
  assert.equal(card.status, "interrupted", "the card is settled with its gateway");
});
