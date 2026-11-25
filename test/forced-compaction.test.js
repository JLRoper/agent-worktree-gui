// Forced compaction: a thread whose context passes the threshold is asked to compact, once per crossing.
//
// The row's evidence: turn 56 held 339K of context and reported zero compressions over 56 turns. The gateway only
// compresses when ITS preflight threshold is met (agent/turn_context_compaction.py), and a model with a large window
// never reaches it - so the panel's own readout (stats.context_used against the card's ceiling) is what decides.
//
// The ask is POST /v1/runs/<id>/compact, the sibling of the stop/steer controls the local runs-API patch adds,
// gated on `features.run_compact`, and what the gateway ANSWERS is what lands on the job. These cases hold the
// contract:
//
//   1. one ask per crossing: a second sweep at the same 10-point band sends nothing;
//   2. a run the gateway is already compacting is never asked;
//   3. a stock gateway (features.run_compact false) is never sent a request - the job records `unsupported`;
//   4. a route that answers 404 is recorded as unsupported with its status, not as a compaction;
//   5. a drop back below the threshold re-arms the card, so the next climb is asked again;
//   6. the record is on the job (`compaction`), and the summary carries it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

process.env.HERMES_HOME = await mkdtemp(path.join(os.tmpdir(), "wtgui-compact-home-"));

const THREAD = "wtgui-a-loaded-thread-21fcf1";
const RUN = "run_compact_1";

const answer = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function panel(t, { capabilities = { runCompact: true }, onCompact = null, card = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-compact-"));
  const logs = [];
  const calls = [];
  const jobs = new Jobs({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      apiServer: { url: "http://gateway.test", key: "test-key" },
      jobMaxRuntimeSeconds: 7200,
      defaultCwd: dir,
    },
    onEvent: () => {},
    onLog: (m) => logs.push(String(m)),
    children: { killScope: () => 0 },
  });
  jobs.transport.capabilities = capabilities;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (u.endsWith("/compact")) return onCompact ? onCompact() : answer({ ok: true });
    if (u.endsWith("/v1/capabilities")) return answer({ features: {}, version: "test" });
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
    id: "job-loaded",
    thread: THREAD,
    runId: RUN,
    status: "running",
    prompt: "keep going",
    startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    lastEventAt: Date.now() - 30_000,
    // 339K of a 1M window: the row's own evidence, at 33.9%. The crossing below is driven at 85%.
    stats: { context_used: 339_000, context_max: 1_000_000, context_percent: 33.9 },
    lines: [],
    ...card,
  };
  jobs.jobs.set(job.id, job);
  return { jobs, job, logs, calls, dir };
}

const compactCalls = (calls) => calls.filter((c) => c.url.endsWith("/compact") && c.method === "POST");

test("one ask per crossing: a second sweep at the same band sends nothing", async (t) => {
  const { jobs, job, calls, logs } = await panel(t);
  job.stats = { context_used: 850_000, context_max: 1_000_000, context_percent: 85 };
  const now = Date.now();

  const first = await jobs.sweepCompaction({ now });
  assert.equal(first.length, 1, "the crossing asked");
  assert.equal(compactCalls(calls).length, 1, "one request to the gateway's compaction control");
  assert.ok(compactCalls(calls)[0].url.includes(RUN), "for the run whose context crossed");
  assert.equal(job.compaction.state, "asked");
  assert.equal(job.compaction.percent, 85);
  assert.equal(job.compaction.threshold, 80, "the default threshold is 80%");
  assert.equal(job.compaction.band, 80);
  assert.ok(logs.some((l) => /compaction asked/.test(l)), "the ask is journalled");

  const second = await jobs.sweepCompaction({ now: now + 15_000 });
  assert.deepEqual(second, [], "the same crossing is not asked twice");
  assert.equal(compactCalls(calls).length, 1, "and nothing was sent");
  assert.equal(jobs.summary(job).compaction?.state, "asked", "the record rides the summary");
});

test("a run the gateway is already compacting is never asked", async (t) => {
  const at = Date.now() - 2_000;
  const { jobs, job, calls } = await panel(t, {
    card: {
      stats: { context_used: 950_000, context_max: 1_000_000, context_percent: 95 },
      lastEventAt: at,
      lastStatus: { kind: "compression", text: "📦 Preflight compression: ~203,774 tokens >= 200,000 threshold.", at },
    },
  });
  assert.equal(jobs.compactingNow(job), true);
  assert.deepEqual(await jobs.sweepCompaction({ now: Date.now() }), []);
  assert.equal(compactCalls(calls).length, 0, "asking a compacting run to compact is noise");
  assert.equal(job.compaction, undefined, "and nothing is recorded against the card");
});

test("a stock gateway is never sent the request: the job records it as unsupported", async (t) => {
  const { jobs, job, calls, logs } = await panel(t, { capabilities: { runCompact: false } });
  job.stats = { context_used: 920_000, context_max: 1_000_000, context_percent: 92 };
  const asked = await jobs.sweepCompaction({ now: Date.now() });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].unsupported, true);
  assert.equal(compactCalls(calls).length, 0, "features.run_compact is false, so no request goes out");
  assert.equal(job.compaction.state, "unsupported");
  assert.match(job.compaction.why, /features\.run_compact is false/);
  assert.ok(logs.some((l) => /no compaction control/.test(l)));
});

test("a 404 on the control route is recorded as unsupported, with its status", async (t) => {
  const { jobs, job } = await panel(t, {
    capabilities: null,
    onCompact: () => answer({ error: "not found" }, 404),
  });
  job.stats = { context_used: 860_000, context_max: 1_000_000, context_percent: 86 };
  const asked = await jobs.sweepCompaction({ now: Date.now() });
  assert.equal(asked.length, 1);
  assert.equal(job.compaction.state, "unsupported");
  assert.equal(job.compaction.http, 404);
  assert.match(job.compaction.why, /no compaction route \(HTTP 404\)/);
  assert.equal(job.error ?? null, null, "a gateway that cannot compact is not a failed turn");
});

test("a drop below the threshold re-arms the card, so the next climb is a new crossing", async (t) => {
  const { jobs, job, calls } = await panel(t);
  const now = Date.now();
  job.stats = { context_used: 850_000, context_max: 1_000_000, context_percent: 85 };
  await jobs.sweepCompaction({ now });
  assert.equal(compactCalls(calls).length, 1);

  // A compaction landed and the context fell: the record that stops a second ask has to go.
  job.stats = { context_used: 400_000, context_max: 1_000_000, context_percent: 40 };
  await jobs.sweepCompaction({ now: now + 15_000 });
  assert.equal(job.compaction, null, "below the threshold the crossing is re-armed");

  job.stats = { context_used: 880_000, context_max: 1_000_000, context_percent: 88 };
  const again = await jobs.sweepCompaction({ now: now + 30_000 });
  assert.equal(again.length, 1, "the second crossing is asked");
  assert.equal(compactCalls(calls).length, 2);
  assert.equal(job.compaction.percent, 88);
});

test("a context below the threshold asks nothing and records nothing", async (t) => {
  const { jobs, job, calls } = await panel(t);
  // The row's own number: 339K of a 1M window is 33.9%, below the 80% threshold.
  assert.deepEqual(await jobs.sweepCompaction({ now: Date.now() }), []);
  assert.equal(compactCalls(calls).length, 0);
  assert.equal(job.compaction, undefined);
});

test("the card's own ceiling decides the share, and 100+ is the top band", async (t) => {
  const { jobs, job, calls } = await panel(t);
  // The reader set a 200K ceiling on this thread: 339K against it is 169.5%, one crossing, asked once.
  jobs.threadContext.set(THREAD, 200_000);
  const asked = await jobs.sweepCompaction({ now: Date.now() });
  assert.equal(asked.length, 1);
  assert.equal(job.compaction.band, 100);
  assert.equal(job.compaction.percent, 170, "the share is measured against the card's ceiling");
  await jobs.sweepCompaction({ now: Date.now() + 15_000 });
  assert.equal(compactCalls(calls).length, 1, "100 and above is one band: nothing to ask twice");
});
