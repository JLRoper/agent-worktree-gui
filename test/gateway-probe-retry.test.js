// A probe that runs out of its budget is not a verdict about the gateway.
//
// Measured on this board: every refused spawn in one run said "the Hermes gateway API is not usable"
// while /v1/capabilities answered 200 in 4-14 ms from the same host and /api/state read
// `reachable: true`. The cause was a single 4-second abort reported in the same sentence as an
// unreachable gateway. These cases are the contract the fix is held to:
//
//   * an abort followed by an answer counts as REACHABLE - the probe is retried once on a timeout;
//   * a 503, and a connection that never opened, still read as UNUSABLE, keyed on the status code and
//     on the transport error respectively;
//   * two timeouts in a row are reported as the probe's own deadline, never as "not usable".
//
// The timeout budget is injected (150 ms) so the abort is a real one - a real HTTP server holds the
// first request open - rather than a stubbed rejection that never exercises the timer.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { createSpawn } from "../lib/features/spawn.js";

const CAPS = { version: "test-build", features: { run_submission: true, run_events_sse: true, run_steer: true } };

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// A panel pointed at `url`, with the probe budget a test can afford.
async function board(t, url, { probeTimeoutMs = 150 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-probe-"));
  const logs = [];
  const jobs = new Jobs({
    config: { jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir, apiServer: { url, key: "test-key" } },
    probeTimeoutMs,
    onLog: (m) => logs.push(String(m)),
  });
  const spawn = createSpawn({ getConfig: () => ({ defaultCwd: dir }), getProjects: () => [], jobs });
  t.after(async () => {
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    clearInterval(jobs.approvalReconcile);
    await rm(dir, { recursive: true, force: true });
  });
  return { jobs, spawn, logs };
}

// A server that lets the FIRST request hang past the probe's budget and answers the second, which is
// the shape of the refusal this run was reporting: one slow answer, then a fast one.
async function slowThenFast(t) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits === 1) return; // held open on purpose: the probe's AbortController is what ends it
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CAPS));
  });
  const url = await listen(server);
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url, hits: () => hits };
}

test("an abort followed by an answer counts as reachable", async (t) => {
  const server = await slowThenFast(t);
  const { jobs, spawn, logs } = await board(t, server.url);

  const transport = await jobs.probe();

  assert.equal(server.hits(), 2, "the timeout was retried exactly once");
  assert.equal(transport.reachable, true, "the second answer is the verdict");
  assert.equal(transport.attempts, 2);
  assert.equal(transport.timedOut, false);
  assert.equal(transport.capabilities?.runs, true, "the retry's capabilities are the record");
  assert.equal(await spawn.gatewayRefusal(), null, "a slow first answer does not refuse the spawn");
  assert.ok(logs.some((l) => /timed out after 150ms - retrying once/.test(l)), "the retry is written down");
});

test("two timeouts are reported as the probe's deadline, not as an unusable gateway", async (t) => {
  // Nothing ever answers, so both attempts spend their own budget.
  const server = createServer(() => {});
  const url = await listen(server);
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const { jobs, spawn } = await board(t, url);

  const transport = await jobs.probe();

  assert.equal(transport.reachable, false);
  assert.equal(transport.timedOut, true, "the timeout is its own fact on the record");
  assert.equal(transport.attempts, 2, "one retry happened before this was reported");
  const said = await spawn.gatewayRefusal();
  assert.match(said, /timed out/, "the sentence names the timeout");
  assert.match(said, /4s|150ms/, "with the budget it spent");
  assert.doesNotMatch(said, /not usable/i, "a timeout is never worded as the gateway being unusable");
  assert.match(String(transport.error), /no answer within 150ms/);
});

test("a 503 still reads as unusable, keyed on the status code", async (t) => {
  const real = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    return { ok: false, status: 503, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const { jobs, spawn } = await board(t, "http://gateway.test");

  const transport = await jobs.probe();

  assert.equal(hits, 1, "a refusal is an answer: it is not retried");
  assert.equal(transport.reachable, false);
  assert.equal(transport.status, 503, "the status code is kept on the record");
  assert.equal(transport.timedOut, false);
  const said = await spawn.gatewayRefusal();
  assert.match(said, /not usable/i, "a 503 is a refusal about the gateway");
  assert.match(said, /HTTP 503/, "and it names the code that said so");
  assert.doesNotMatch(said, /timed out/);
});

test("a refused connection still reads as unusable, keyed on the transport error", async (t) => {
  // A port that was listening and is now closed: connecting to it is refused at once, on loopback.
  const closed = createServer(() => {});
  const url = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  const { jobs, spawn } = await board(t, url);

  const transport = await jobs.probe();

  assert.equal(transport.reachable, false);
  assert.equal(transport.timedOut, false, "a dead socket is not a timeout");
  assert.equal(transport.attempts, 1, "a transport error is an answer: it is not retried");
  assert.match(String(transport.error), /ECONNREFUSED/, "the transport error is kept, not flattened to 'fetch failed'");
  const said = await spawn.gatewayRefusal();
  assert.match(said, /not usable/i, "a refused connection is the gateway being unusable");
  assert.match(said, /ECONNREFUSED/);
  assert.doesNotMatch(said, /timed out/);
});
