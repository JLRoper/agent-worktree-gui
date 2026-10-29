// A gateway that answers `unknown` for a run the panel is still watching.
//
// `unknown` is not a status: the run is neither live nor finished, so nothing about it ever settles and a card left
// `running` on that answer stays running for good — measured on run_fe8af9942ccc474987962ff44c653e79, whose card read
// "running" for 48 minutes while GET /v1/runs/<id> answered 200 `{"status":"unknown"}` on every sweep. These cases are
// the contract: two consecutive answers at least 15s apart separate the card through the path a 404 takes; a single
// answer on a card already past its wall-clock cap does too; a single answer on a young card does not, because a run
// that is only starting answers `unknown` once and then `completed`; and a 404 behaves exactly as it did before.
//
// The sweep takes a `now`, which is how "the next sweep said it again" is driven in milliseconds instead of 15 seconds.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

const RUN = "run_fe8af9942ccc474987962ff44c653e79";
const CAP = 3600;
const THREAD = "wtgui-do-some-project-cleanup-of-w-42c493";

const answer = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const unknown = () => answer({ run_id: RUN, status: "unknown", output: "", pending_controls: [] });

// A panel watching one card, with the gateway stubbed at `fetch`: the capabilities probe answers, and every ask about
// the run goes through `onRun` so a case can change the gateway's mind between sweeps.
async function panel(t, { onRun, startedMinutesAgo = 5 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-unknown-"));
  const logs = [];
  const jobs = new Jobs({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      apiServer: { url: "http://gateway.test", key: "test-key" },
      jobMaxRuntimeSeconds: CAP,
      defaultCwd: dir,
    },
    onEvent: () => {},
    onLog: (m) => logs.push(String(m)),
  });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/capabilities")) return answer({ features: {}, version: "test" });
    if (u.includes("/v1/runs/")) return onRun(u);
    throw new Error(`unexpected fetch ${u}`);
  };
  t.after(async () => {
    globalThis.fetch = real;
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    await rm(dir, { recursive: true, force: true });
  });
  const card = {
    id: "job-1",
    thread: THREAD,
    runId: RUN,
    status: "running",
    prompt: "do some project cleanup",
    model: "test/model",
    startedAt: new Date(Date.now() - startedMinutesAgo * 60_000).toISOString(),
    lines: [{ kind: "init", text: `run ${RUN}`, at: Date.now() - startedMinutesAgo * 60_000 }],
    // The stream dropped when the gateway lost the run: the sweep is the only thing asking.
    streamOpen: false,
  };
  jobs.jobs.set(card.id, card);
  return { jobs, logs, card, dir };
}

test("unknown twice, a sweep apart, separates the card through the 404 path", async (t) => {
  const { jobs, logs, card } = await panel(t, { onRun: unknown });
  const now = Date.now();

  assert.deepEqual(await jobs.sweepOrphanedRuns(now), [], "one answer is not a verdict");
  assert.equal(card.status, "running", "the card is left alone on the first answer");

  const lost = await jobs.sweepOrphanedRuns(now + 15_000);
  assert.equal(lost.length, 1, "the second answer is the panel's evidence");
  assert.equal(card.status, "interrupted");
  assert.equal(card.runGone, true, "the re-attach chip is not offered for a run nobody there has");
  assert.match(card.error, /the gateway restarted while this was running/);
  assert.equal(card.termination?.by, "gateway");
  assert.ok(card.endedAt, "the clock stopped where the panel last saw it");

  const line = logs.find((m) => m.includes("answered unknown"));
  assert.ok(line, "the journal names the answer that killed the card");
  assert.ok(line.includes(RUN), `the line names the run: ${line}`);
  assert.ok(line.includes(new Date(now).toISOString()), `the first answer carries its timestamp: ${line}`);
  assert.ok(line.includes(new Date(now + 15_000).toISOString()), `the second answer carries its timestamp: ${line}`);
});

test("unknown once, then completed, completes normally and is never written off", async (t) => {
  let asked = 0;
  const { jobs, logs, card } = await panel(t, {
    onRun: () =>
      ++asked === 1
        ? unknown()
        : answer({ run_id: RUN, status: "completed", output: "cleanup done", usage: { total_tokens: 10 } }),
  });
  const now = Date.now();

  await jobs.sweepOrphanedRuns(now);
  assert.equal(card.status, "running", "a run that is starting answers unknown once");
  assert.equal(card.unknownAnswers?.length, 1, "the answer is recorded, not acted on");

  const lost = await jobs.sweepOrphanedRuns(now + 30_000);
  assert.deepEqual(lost, [], "nothing was given a terminal status by the sweep");
  assert.equal(card.status, "done");
  assert.equal(card.finalMessage, "cleanup done");
  assert.ok(!card.runGone, "the card still has its run");
  assert.equal(card.unknownAnswers, null, "the live answer cleared the record");
  assert.ok(!logs.some((m) => m.includes("answered unknown")), "no write-off was journaled");
});

test("one unknown answer is enough on a card already past its wall-clock cap", async (t) => {
  const { jobs, card } = await panel(t, { onRun: unknown });
  card.startedAt = new Date(Date.now() - (CAP + 60) * 1000).toISOString();

  const lost = await jobs.sweepOrphanedRuns(Date.now());
  assert.equal(lost.length, 1);
  assert.equal(card.status, "interrupted");
  assert.equal(card.runGone, true);
});

test("one unknown answer on a young card is untouched", async (t) => {
  const { jobs, logs, card } = await panel(t, { onRun: unknown });

  assert.deepEqual(await jobs.sweepOrphanedRuns(Date.now()), []);
  assert.equal(card.status, "running", "the card keeps running");
  assert.ok(!card.runGone);
  assert.equal(card.error, undefined);
  assert.equal(card.unknownAnswers?.length, 1);
  assert.ok(!logs.some((m) => m.includes("answered unknown")), "nothing was written off");
});

test("a 404 still separates the card as it does today", async (t) => {
  const { jobs, card } = await panel(t, { onRun: () => answer({}, 404) });

  const lost = await jobs.sweepOrphanedRuns(Date.now());
  assert.equal(lost.length, 1);
  assert.equal(card.status, "interrupted");
  assert.equal(card.runGone, true);
  assert.match(card.error, /the gateway restarted while this was running/);
});


