// The run record's per-call tool duration.
//
// The report (docs/reports/terminal-call-latency-2026-11-11.html) could not find a slow call from the run record:
// jobs.json carried the turn's total (`durationMs`) and its console lines, but nothing per tool call. The console
// prints `↳ terminal · 1.25s`, and the same number has to land in the record, with the call's own preview, so an
// investigation starts from jobs.json instead of re-running the turn.
//
// This test drives the real event path over HTTP: a real child process is timed here, its measured duration is sent
// as the gateway's `tool.completed.duration` (seconds), and the assertion is on BOTH `summary()` (what /api/jobs
// answers) and the persisted jobs.json (what a later investigation reads).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 10_000, stepMs = 25, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(stepMs);
  }
}

// One run, its events numbered from 0. The stream stays open until the test closes it, so the panel's subscriber
// is the real one and the completion is the real event the console draws.
function makeStub() {
  const state = { connections: [], seq: -1, status: "running" };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "timing-stub", features: { run_submission: true, run_events_sse: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      return json(200, { run_id: "run_timing_1", status: "running" });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (!m) return json(404, { error: { message: "not found" } });
    if ((m[2] || "") === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": open\n\n");
      const conn = { res, open: true };
      state.connections.push(conn);
      req.on("close", () => {
        conn.open = false;
      });
      return;
    }
    return json(200, { run_id: m[1], status: state.status, output: "" });
  });
  const send = (events) => {
    const conn = [...state.connections].reverse().find((c) => c.open);
    if (!conn) throw new Error("no open stream to send on");
    for (const evt of events) {
      state.seq += 1;
      conn.res.write(`id: ${state.seq}\ndata: ${JSON.stringify({ ...evt, run_id: "run_timing_1", seq: state.seq })}\n\n`);
    }
  };
  return {
    state,
    send,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => {
      for (const c of state.connections) if (c.open) c.res.end();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

function makeJobs(dir, url) {
  const jobs = new Jobs({
    config: { apiServer: { url }, jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir, jobMaxRuntimeSeconds: 3600 },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.dispose = () => {
    for (const j of jobs.jobs.values()) {
      clearTimeout(j.timer);
      clearTimeout(j.persistTimer);
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      try {
        j.ctrl?.abort();
      } catch {
        /* an aborted stream is the point */
      }
    }
    clearTimeout(jobs.persistTimer);
  };
  return jobs;
}

test("a completed tool call's measured duration lands in the summary and in jobs.json", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-tool-timing-"));
  const stub = makeStub();
  const port = await stub.listen();
  const jobs = makeJobs(dir, `http://127.0.0.1:${port}`);
  t.after(async () => {
    jobs.dispose();
    await stub.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* a measureTree git handle on Windows; the OS temp is throwaway */
    }
  });

  const job = await jobs.create({ prompt: "time one real command", cwd: dir, existing: true, thread: "wtgui-timing-1" });
  const live = () => jobs.jobs.get(job.id);
  assert.equal(job.status, "running", `the stub accepted the run: ${job.error || ""}`);
  await waitFor(() => stub.state.connections.length === 1, { what: "the subscriber to open the stream" });

  // A REAL call, timed here. The probe is a child Node process that sleeps 250 ms, so the number below is not a
  // fixture constant: it is what this host actually spent starting and running the command.
  const startedAt = performance.now();
  execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 250)"], { stdio: "ignore" });
  const measuredMs = performance.now() - startedAt;
  assert.ok(measuredMs >= 250, `the probe really ran: ${measuredMs.toFixed(1)} ms`);

  stub.send([{ event: "tool.started", tool: "terminal", preview: "node -e setTimeout 250" }]);
  await waitFor(() => live().eventCount === 1, { what: "tool.started" });
  stub.send([{ event: "tool.completed", tool: "terminal", duration: measuredMs / 1000, error: false, preview: "done" }]);
  await waitFor(() => live().eventCount === 2, { what: "tool.completed" });

  const expected = Math.round(measuredMs);
  const summary = jobs.summary(live());
  assert.equal(summary.toolTimings.length, 1, "one call, one timing");
  assert.equal(summary.toolTimings[0].tool, "terminal");
  assert.equal(summary.toolTimings[0].ms, expected, "the gateway's seconds are recorded as milliseconds");
  assert.equal(summary.toolTimings[0].call, "node -e setTimeout 250", "the record names the command, not just the tool");
  assert.equal(summary.toolTimings[0].error, false);

  // The persisted record is the one a later investigation reads. schedulePersist debounces 700 ms.
  await waitFor(
    () => {
      try {
        const store = JSON.parse(readFileSync(path.join(dir, "jobs.json"), "utf8"));
        return (store.jobs || []).some((j) => j.id === job.id && j.toolTimings?.[0]?.ms === expected);
      } catch {
        return false;
      }
    },
    { timeoutMs: 5000, what: "the timing in jobs.json" },
  );
  const persisted = JSON.parse(readFileSync(path.join(dir, "jobs.json"), "utf8")).jobs.find((j) => j.id === job.id);
  assert.equal(persisted.toolTimings[0].call, "node -e setTimeout 250");
  assert.equal(persisted.toolTimings[0].ms, expected);

  console.log(`tool timing: recorded ${persisted.toolTimings[0].ms} ms for a real ${measuredMs.toFixed(1)} ms child process`);
});
