// The quiet-window reaper: a worker run that stops producing events is stopped by the panel, not by the 7200s cap.
//
// The assistant's OWN turn has had a quiet watchdog since lib/assistant.js `supervise()` (four quiet windows, a
// question exempt). Nothing reaped a WORKER run: a #354 run read `running` until the 2h wall-clock cap killed it,
// and another job read running for 45 minutes with no tree and no events. lib/jobs.js `sweepStalledRuns` is that
// half, and these cases are its contract:
//
//   1. both halves are required: quiet past `jobStallQuietMinutes` AND an age past the run's own budget. A young
//      quiet run is left alone; a run quiet past the window but still inside its budget is WATCHED (the chip's
//      `quiet`), not stopped;
//   2. the reap goes through the panel's own cancel path - the POST /v1/runs/<id>/stop the cancel route fires -
//      and the card reads `interrupted` with a reason naming the quiet window and the budget;
//   3. a question, an approval, a live child and a compaction are waits, not stalls, and are exempt;
//   4. a run the READER cancelled is never touched;
//   5. the defaults are the panel's own (10 minutes, 1800s, 80%) and a config key overrides each.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

// lib/jobs.js reads the Hermes store for a card's title and stats; keep it out of the reader's own state.
process.env.HERMES_HOME = await mkdtemp(path.join(os.tmpdir(), "wtgui-reaper-home-"));

const MIN = 60_000;
const THREAD = "wtgui-a-stuck-worker-21fcf1";

const answer = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// A panel watching one card, with the gateway stubbed at `fetch`: nothing here ever reaches a real gateway, and the
// stop the reap fires is recorded instead of sent.
async function panel(t, { config = {}, card = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-reaper-"));
  const logs = [];
  const calls = [];
  const jobs = new Jobs({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      apiServer: { url: "http://gateway.test", key: "test-key" },
      jobMaxRuntimeSeconds: 7200,
      defaultCwd: dir,
      ...config,
    },
    onEvent: () => {},
    onLog: (m) => logs.push(String(m)),
    children: { killScope: () => 0 },
  });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).endsWith("/stop")) return answer({ ok: true });
    if (String(url).endsWith("/v1/capabilities")) return answer({ features: {}, version: "test" });
    return answer({ ok: true });
  };
  t.after(async () => {
    globalThis.fetch = real;
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    clearInterval(jobs.approvalReconcile);
    await rm(dir, { recursive: true, force: true });
  });
  const job = {
    id: "job-stuck",
    thread: THREAD,
    runId: "run_stuck_1",
    status: "running",
    prompt: "do the thing",
    model: "test/model",
    budget: 1800,
    startedAt: new Date(Date.now() - 60 * MIN).toISOString(),
    lastEventAt: Date.now() - 30 * MIN,
    lines: [{ kind: "init", text: "run run_stuck_1", at: Date.now() - 60 * MIN }],
    // The stream is open and the gateway has said nothing: the exact shape the reaper exists for.
    streamOpen: true,
    ...card,
  };
  jobs.jobs.set(job.id, job);
  return { jobs, job, logs, calls, dir };
}

test("a quiet run past its budget is reaped through the cancel path, with the window and the budget in the reason", async (t) => {
  const { jobs, job, logs, calls } = await panel(t);
  const now = Date.now();
  const reaped = await jobs.sweepStalledRuns({ now });

  assert.equal(reaped.length, 1, "the board's quiet worker is the one card reaped");
  assert.equal(job.status, "interrupted", "the row stops reading running");
  assert.equal(job.termination?.by, "reaper", "the panel's own act is recorded as what ended it");
  assert.match(job.error, /nothing on the run's stream for 30m 00s/, "the reason names the quiet window");
  assert.match(job.error, /the 10m 00s quiet window/, "and the window the panel was holding");
  assert.match(job.error, /past its 1800s budget/, "and the budget it outlived");
  assert.equal(job.reaped?.quietSeconds, 1800);
  assert.equal(job.reaped?.budgetSeconds, 1800);
  assert.equal(job.reaped?.cancelAsked, true, "the reap took the panel's cancel path");
  const stop = calls.filter((c) => c.url.endsWith("/stop") && c.method === "POST");
  assert.equal(stop.length, 1, "the gateway was asked to stop the run, once");
  assert.ok(stop[0].url.includes("run_stuck_1"), "for this run");
  assert.ok(logs.some((l) => l.startsWith(`run ${job.id}: reaped:`)), "the reap is journalled");
  const sum = jobs.summary(job);
  assert.equal(sum.stuck?.state, "reaped", "the card's own field says reaped");
  assert.equal(sum.reaped?.reason, job.error, "and carries the same reason");
});

test("a young quiet run is left alone: silence inside the window is not a stall", async (t) => {
  const { jobs, job, calls } = await panel(t, {
    card: { startedAt: new Date(Date.now() - 4 * MIN).toISOString(), lastEventAt: Date.now() - 3 * MIN },
  });
  const reaped = await jobs.sweepStalledRuns({ now: Date.now() });
  assert.deepEqual(reaped, []);
  assert.equal(job.status, "running");
  assert.equal(calls.filter((c) => c.url.endsWith("/stop")).length, 0);
  assert.equal(jobs.summary(job).stuck, null, "a moving run draws no chip");
});

test("quiet past the window but inside the budget is watched, not stopped", async (t) => {
  const { jobs, job, calls } = await panel(t, {
    card: { startedAt: new Date(Date.now() - 12 * MIN).toISOString(), lastEventAt: Date.now() - 11 * MIN },
  });
  const reaped = await jobs.sweepStalledRuns({ now: Date.now() });
  assert.deepEqual(reaped, [], "the age is still inside the 1800s budget");
  assert.equal(job.status, "running");
  assert.equal(calls.filter((c) => c.url.endsWith("/stop")).length, 0);
  const stuck = jobs.summary(job).stuck;
  assert.equal(stuck?.state, "quiet", "but the card says it has gone quiet");
  assert.equal(stuck?.overBudget, false);
  assert.equal(stuck?.windowSeconds, 600);
});

test("a card's own budget is the one its age is judged against", async (t) => {
  const { jobs, job } = await panel(t, {
    card: {
      budget: 600,
      startedAt: new Date(Date.now() - 20 * MIN).toISOString(),
      lastEventAt: Date.now() - 12 * MIN,
    },
  });
  const reaped = await jobs.sweepStalledRuns({ now: Date.now() });
  assert.equal(reaped.length, 1);
  assert.match(job.error, /past its 600s budget/, "the run's own 600s, not the panel default");
  assert.equal(job.reaped?.budgetSeconds, 600);
});

test("an open approval is a wait, not a stall", async (t) => {
  const { jobs, job } = await panel(t, {
    card: { approval: { requestId: "ap-1", command: "rm -rf build", choices: ["approve", "deny"] } },
  });
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), []);
  assert.equal(job.status, "running");
});

test("an open question is a wait, not a stall", async (t) => {
  const { jobs, job } = await panel(t, {
    card: { question: { requestId: "q-1", question: "which branch?", choices: ["main"] } },
  });
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), []);
  assert.equal(job.status, "running");
});

test("a live child is a build in flight, not a stall", async (t) => {
  const { jobs, job } = await panel(t, {
    card: { subagents: [{ index: 1, goal: "build the thing", running: true, sessionId: "sub-1", ids: ["sub-1"] }] },
  });
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), []);
  assert.equal(job.status, "running");
});

test("a tool in flight is a build, not a stall", async (t) => {
  const { jobs, job } = await panel(t, {
    card: { inflight: [{ tool: "terminal", id: "call-1", at: Date.now() - 30 * MIN }] },
  });
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), []);
  assert.equal(job.status, "running", "a long test run says nothing while it works");
});

test("a run the gateway is compacting is exempt, and the chip says so", async (t) => {
  // A compaction frame is only evidence while it is fresh (lib/jobs.js COMPACTION_FRAME_MS, 10 minutes). The quiet
  // window is shortened here so the two overlap: a 6-minute-old frame inside a 5-minute window is a run whose
  // silence the gateway explained, and the reaper leaves it alone. A frame older than a summary call could take is
  // NOT an explanation, and that case is the next test.
  const at = Date.now() - 6 * MIN;
  const { jobs, job } = await panel(t, {
    config: { jobStallQuietMinutes: 5 },
    card: {
      budget: 120,
      startedAt: new Date(Date.now() - 20 * MIN).toISOString(),
      lastEventAt: at,
      lastStatus: { kind: "compression", text: "Preflight compression: ~339,000 tokens >= 200,000 threshold.", at },
    },
  });
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), [], "compaction is the gateway's own silence");
  assert.equal(job.status, "running");
  const stuck = jobs.summary(job).stuck;
  assert.equal(stuck?.state, "compacting", "and the card explains the silence instead of accusing it");
});

test("a compaction frame older than a summary call is no explanation: that run is reaped", async (t) => {
  const at = Date.now() - 30 * MIN;
  const { jobs, job } = await panel(t, {
    card: {
      lastEventAt: at,
      lastStatus: { kind: "compression", text: "Preflight compression: ~339,000 tokens >= 200,000 threshold.", at },
    },
  });
  const reaped = await jobs.sweepStalledRuns({ now: Date.now() });
  assert.equal(reaped.length, 1, "a compaction that has not finished in 30 minutes is a stall");
  assert.equal(job.status, "interrupted");
  assert.match(job.error, /quiet window/);
});

test("a run the reader cancelled is never touched", async (t) => {
  const { jobs, job, calls } = await panel(t);
  job.termination = { by: "reader", at: new Date().toISOString() };
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), []);
  assert.equal(job.status, "running", "its ending belongs to the gateway's answer");

  job.termination = null;
  job.cancelRequested = true;
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), []);
  assert.equal(job.status, "running", "a cancel already on its way is not the reaper's business");
  assert.equal(calls.filter((c) => c.url.endsWith("/stop")).length, 0);
});

test("the assistant's own turn is the sentry's, not the reaper's", async (t) => {
  const { jobs, job } = await panel(t, { card: { assistant: true } });
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), []);
  assert.equal(job.status, "running");
});

test("a turn held for a run slot draws no stuck chip: it has no stream to be quiet on", async (t) => {
  const { jobs, job } = await panel(t, {
    card: {
      status: "waiting",
      runId: null,
      startedAt: new Date(Date.now() - 40 * MIN).toISOString(),
      lastEventAt: null,
      lines: [],
    },
  });
  assert.equal(jobs.summary(job).stuck, null);
  assert.deepEqual(await jobs.sweepStalledRuns({ now: Date.now() }), [], "and the reaper has no run to cancel");
});

test("the settings have defaults and a config key overrides each", async (t) => {
  const bare = await panel(t);
  assert.equal(bare.jobs.stallQuietMs, 600_000, "10 minutes of quiet by default");
  assert.equal(bare.jobs.stallBudgetSeconds, 1800, "the spawn form's own budget by default");
  assert.equal(bare.jobs.compactPercent, 80, "80% of the context ceiling by default");

  const tuned = await panel(t, {
    config: { jobStallQuietMinutes: 3, jobStallBudgetSeconds: 900, jobCompactContextPercent: 65 },
  });
  assert.equal(tuned.jobs.stallQuietMs, 180_000);
  assert.equal(tuned.jobs.stallBudgetSeconds, 900);
  assert.equal(tuned.jobs.compactPercent, 65, "an override is honoured");

  const clamped = await panel(t, {
    config: { jobStallQuietMinutes: 0.1, jobCompactContextPercent: 20 },
  });
  assert.equal(clamped.jobs.stallQuietMs, 60_000, "a sub-minute window is floored: it would reap between two calls");
  assert.equal(clamped.jobs.compactPercent, 50, "the threshold is clamped to a share that is still a warning");
});
