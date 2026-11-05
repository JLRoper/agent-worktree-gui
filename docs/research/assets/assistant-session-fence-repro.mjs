// Minimal reproduction for docs/research/assistant-session-fence.md
//
// One stub Runs API, one Jobs registry, two threads:
//   A. an ordinary panel thread, two turns -> proves which id each call carries;
//   B. a session revived from the CLI, replied to -> proves which id the 409 fence is worded from.
//
// Run from the repo root:  node docs/research/assets/assistant-session-fence-repro.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Jobs } from "../../../lib/jobs.js";

const THREAD = "wtgui-ordinary-thread-0001";
const CLI_THREAD = "cli-owned-session-0001";
const calls = [];
let n = 0;

const json = (res, code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const body = req.method === "POST" ? await readBody(req) : null;
  calls.push({ method: req.method, path: url.pathname, body });
  if (url.pathname === "/v1/capabilities") {
    return json(res, 200, { version: "fence-repro", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true } });
  }
  if (url.pathname === "/v1/runs" && req.method === "POST") {
    if (body?.session_id === CLI_THREAD) {
      return json(res, 409, { error: { code: "permission_denied", message: "permission_denied: this session belongs to the cli surface" } });
    }
    n += 1;
    return json(res, 200, { object: "hermes.run", run_id: `run_${n}`, status: "running" });
  }
  const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
  if (m) {
    const [, runId, sub] = m;
    if (sub === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": attached\n\n");
      req.on("close", () => {});
      return undefined;
    }
    if (sub === "/steer") return json(res, 200, { accepted: true, run_id: runId });
    if (sub === "/stop") return json(res, 200, { object: "hermes.run.stop", run_id: runId, accepted: true });
    if (!sub) return json(res, 200, { object: "hermes.run", run_id: runId, status: "running", execution_generation: 1, pending_controls: [] });
  }
  return json(res, 404, { error: { code: "not_found", message: "not found" } });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const dir = await mkdtemp(path.join(os.tmpdir(), "fence-repro-"));
const jobs = new Jobs({
  config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: `http://127.0.0.1:${server.address().port}`, key: "test" }, defaultCwd: dir },
  onLog: () => {},
});

try {
  // ---- A. the ordinary thread: two turns, each its own run, one shared session -------------------------
  const first = await jobs.create({ prompt: "first turn", thread: THREAD, existing: true, cwd: dir });
  const second = await jobs.create({ prompt: "second turn", thread: THREAD, reply: true, existing: true, cwd: dir });
  assert.equal(first.thread, THREAD);
  assert.equal(second.thread, THREAD, "both turns name the same session");
  assert.notEqual(first.runId, second.runId, "each turn has its own run id");

  const posts = calls.filter((c) => c.method === "POST" && c.path === "/v1/runs");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.body.session_id), [THREAD, THREAD]);
  assert.ok(posts.every((p) => !("run_id" in p.body) && !("runId" in p.body)), "a POST carries session_id, never a run id");

  await jobs.steer(first.id, "change course");
  await jobs.stop(first.id);
  const steer = calls.find((c) => c.path === `/v1/runs/${first.runId}/steer`);
  const stop = calls.find((c) => c.path === `/v1/runs/${first.runId}/stop`);
  assert.ok(steer, "steer addresses the RUN id");
  assert.ok(stop, "stop addresses the RUN id");
  assert.ok(!calls.some((c) => c.path.includes(THREAD)), "no wire call puts the session id in a /v1/runs path");

  // ---- B. the fence: a revived CLI session, replied to ---------------------------------------------------
  const revived = jobs.revive({ thread: CLI_THREAD, prompt: "what I asked the CLI", cwd: dir, tail: [{ role: "assistant", text: "what the CLI answered" }] }).job;
  assert.equal(revived.revived, true);
  const refused = await jobs.create({ prompt: "answer it from the panel", thread: CLI_THREAD, reply: true, existing: true, cwd: dir });
  assert.equal(refused.status, "failed");
  const refusalPost = calls.filter((c) => c.method === "POST" && c.path === "/v1/runs").at(-1);
  assert.equal(refusalPost.body.session_id, CLI_THREAD);

  console.log("calls:");
  for (const c of calls) console.log(`  ${c.method} ${c.path}${c.body && c.path === "/v1/runs" ? `  body.session_id=${c.body.session_id}` : ""}`);
  console.log("");
  console.log(`A: thread=${first.thread} runs=${first.runId},${second.runId}; steer/stop used ${first.runId}`);
  console.log(`B: revived card ${revived.id} has revived=true and runId=${revived.runId}`);
  console.log(`B: the reply card ${refused.id} has revived=${Boolean(refused.revived)} and says:`);
  console.log(`   ${refused.error}`);
  console.log("");
  console.log(`B expected the CLI wording ("this session is the CLI's ... hermes --resume ${CLI_THREAD}")`);
  console.log(`B got the generic wording: ${/this session is the CLI's/.test(refused.error) ? "NO — it is the CLI one" : "YES"}`);
} finally {
  clearInterval(jobs.titleSweep);
  clearInterval(jobs.approvalSweep);
  for (const j of jobs.jobs.values()) {
    clearInterval(j.statsTimer);
    clearInterval(j.poller);
    clearTimeout(j.timer);
    j.ctrl?.abort?.();
  }
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
