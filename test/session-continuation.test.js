// Real Jobs over HTTP: a new run continues a conversation; it is not a new agent process.
// The gateway is a test fixture. No live gateway, model, session store or git worktree is touched.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-continuation-"));
  const previousHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = path.join(dir, "hermes");
  const requests = [];
  const server = createServer(async (req, res) => {
    const json = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/v1/capabilities") {
      return json(200, { features: { run_submission: true, run_events_sse: true } });
    }
    if (req.url === "/v1/runs" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      return json(202, { run_id: `fixture-run-${requests.length}`, status: "running" });
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "finished", exit_code: 0 })}\n\n`);
    }
    return json(404, { error: "unexpected request" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const jobs = new Jobs({
    config: {
      apiServer: { url: `http://127.0.0.1:${server.address().port}`, key: "fixture-key" },
      jobsFile: path.join(dir, "jobs.json"),
      defaultCwd: dir,
    },
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(async () => {
    for (const j of jobs.jobs.values()) jobs.settle(j, "cancelled", {});
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    clearTimeout(jobs.persistTimer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
  });
  const create = async (opts) => {
    const result = await jobs.create({ cwd: dir, existing: true, remoteWrite: "none", ...opts });
    const until = Date.now() + 10_000;
    while (jobs.jobs.get(result.id).status === "running" && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const job = jobs.summary(jobs.jobs.get(result.id));
    assert.equal(job.status, "done", `fixture run settled: ${job.error || job.status}`);
    return job;
  };
  return { dir, jobs, requests, create };
}

const workspaceNotes = (job) => job.lines.filter((line) => line.kind === "dim" && /asked to work in|⇢ workspace /.test(line.text));

test("a reply keeps the session and cwd safeguard without repeating the workspace setup note", async (t) => {
  const f = await fixture(t);
  const thread = "wtgui-continuation-fixture";
  const first = await f.create({ prompt: "first task", thread });
  const reply = await f.create({ prompt: "continue the task", thread, reply: true });

  assert.equal(f.requests.length, 2, "one run per turn");
  assert.deepEqual(f.requests.map((body) => body.session_id), [thread, thread], "both runs continue the same conversation");
  assert.notEqual(first.runId, reply.runId, "the execution id changes, not the conversation id");
  for (const body of f.requests) {
    assert.equal(body.cwd, f.dir);
    assert.ok(body.input.includes(`cd "${f.dir.replaceAll("\\", "/")}"`), "each run still re-anchors its tools");
    assert.ok(body.input.includes("use absolute paths"));
    assert.equal(Object.hasOwn(body, "conversation_history"), false, "the gateway loads the session's history");
  }
  assert.equal(workspaceNotes(first).length, 1, "the setup note is available on the first turn");
  assert.equal(workspaceNotes(reply).length, 0, "a continuation must not repeat the setup warning");
});

test("an accepted reply's startup line identifies the continued session and its new turn", async (t) => {
  const f = await fixture(t);
  const thread = "wtgui-continued-startup-fixture";
  await f.create({ prompt: "first task", thread });
  const reply = await f.create({ prompt: "continue", thread, reply: true });
  const init = reply.lines.find((line) => line.kind === "init");
  assert.ok(init.text.includes(`continuing session ${thread} · turn 2`), init.text);
  assert.ok(init.text.includes(`run ${reply.runId}`), "the new execution is still named");
});

test("the first workspace note describes the safeguard without asserting a gateway cwd defect", async (t) => {
  const f = await fixture(t);
  const first = await f.create({ prompt: "first task", thread: "wtgui-neutral-cwd-fixture" });
  const note = workspaceNotes(first)[0];
  assert.match(note.text, /^⇢ workspace /);
  assert.match(note.text, /tool-directory safeguard/);
  assert.doesNotMatch(note.text, /accepts the run|still starts|gateway.s (own )?directory|measured|2026/);
});

test("a resumed session with no earlier panel card does not show a new-workspace notice", async (t) => {
  const f = await fixture(t);
  const reply = await f.create({ prompt: "continue an existing conversation", thread: "wtgui-resumed-fixture", reply: true });
  assert.equal(workspaceNotes(reply).length, 0);
  assert.match(reply.lines.find((line) => line.kind === "init").text, /continuing session wtgui-resumed-fixture · turn 1/);
  assert.ok(f.requests[0].input.includes("use absolute paths"), "a resumed run keeps the safeguard");
});

test("reusing a known thread without a reply flag still counts as continuation", async (t) => {
  const f = await fixture(t);
  const thread = "wtgui-known-thread-fixture";
  await f.create({ prompt: "first task", thread });
  const next = await f.create({ prompt: "next task", thread });
  assert.equal(workspaceNotes(next).length, 0);
  assert.ok(next.lines.find((line) => line.kind === "init").text.includes(`continuing session ${thread} · turn 2`));
});

test("an unanchored assistant turn gets no workspace notice or cd wrapper", async (t) => {
  const f = await fixture(t);
  const first = await f.create({ prompt: "read the board", thread: "wtgui-board-fixture", anchorCwd: false });
  assert.equal(workspaceNotes(first).length, 0);
  assert.equal(f.requests[0].input, "read the board");
});
