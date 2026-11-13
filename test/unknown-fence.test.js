// A stop the gateway refuses because the SESSION is fenced, and the line a card gives instead of `run failed`.
//
// Measured on this box: `POST /v1/runs/{id}/stop` answers 409 `unknown_execution` on an `unknown` admission and leaves
// the fence standing (hermes_state_runtime.cancel_session_input, docs/research/assistant-session-fence.md §4). The
// panel used to count every 409 as "already gone", so the journal said a stop had landed for a run that had never
// started — and the card said only `run failed`, which is why ten of them stacked up on panel-assistant-3 before
// anyone named the fence (docs/assistant-attach-after-restart-2026-11-05.md).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { runFenceLine } from "../lib/jobs/console-lines.js";

const answer = (body, status) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function panel(t, { onStop }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-fence-"));
  const logs = [];
  const jobs = new Jobs({
    config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: "http://gateway.test", key: "test-key" }, defaultCwd: dir },
    onEvent: () => {},
    onLog: (m) => logs.push(String(m)),
  });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v1/capabilities")) return answer({ features: {}, version: "test" }, 200);
    if (u.endsWith("/stop") && init?.method === "POST") return onStop(u);
    throw new Error(`unexpected fetch ${u} ${init?.method || "GET"}`);
  };
  t.after(async () => {
    globalThis.fetch = real;
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    await rm(dir, { recursive: true, force: true });
  });
  const card = { id: "job-1", thread: "panel-assistant-3", runId: "run_fenced", status: "failed", startedAt: new Date().toISOString(), lines: [] };
  jobs.jobs.set(card.id, card);
  return { jobs, logs, card };
}

test("a 409 unknown_execution is a refusal, not an ending, and the journal says so", async (t) => {
  const { jobs, logs } = await panel(t, {
    onStop: () => answer({ error: { message: "unknown_execution", code: "unknown_execution" } }, 409),
  });
  const entry = await jobs.stopRunAtGateway({ id: "job-1", thread: "panel-assistant-3", runId: "run_fenced" }, { reason: "restart sweep" });

  assert.equal(entry.status, 409);
  assert.equal(entry.ok, false, "409 unknown_execution is a refusal: the run is still where it was");
  assert.equal(entry.already, false);
  assert.equal(entry.fence, true, "the entry names the fence so a caller can act on it");
  assert.match(entry.error, /fenced by an unknown admission/);
  const line = logs.find((l) => l.includes("stop"));
  assert.match(line, /stop FAILED/);
  assert.match(line, /fenced by an unknown admission/);
  assert.doesNotMatch(line, /already gone/);
});

test("a 409 that is not the fence keeps its old meaning, and a 404 is the state being asked for", async (t) => {
  const other = await panel(t, { onStop: () => answer({ error: { code: "run_not_stopping", message: "already stopping" } }, 409) });
  const a = await other.jobs.stopRunAtGateway({ id: "job-1", thread: "panel-assistant-3", runId: "run_fenced" });
  assert.equal(a.ok, true);
  assert.equal(a.already, true);
  assert.equal(a.fence, undefined);

  const gone = await panel(t, { onStop: () => answer({ error: { code: "run_not_found", message: "no such run" } }, 404) });
  const b = await gone.jobs.stopRunAtGateway({ id: "job-1", thread: "panel-assistant-3", runId: "run_fenced" });
  assert.equal(b.ok, true);
  assert.equal(b.already, true);
});

test("the fence line names the session, the cause and the one control that clears it", () => {
  const line = runFenceLine("panel-assistant-3");
  assert.equal(line.kind, "fence");
  assert.match(line.text, /panel-assistant-3/);
  assert.match(line.text, /fenced/);
  assert.match(line.text, /restart does not clear it/);
  assert.match(line.text, /Reset assistant/);
  assert.match(line.text, /resolve-unknown/);
});
