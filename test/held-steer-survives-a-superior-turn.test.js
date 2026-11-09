// A steer the gateway handed back (`run.pending_steer`) is queued reader input: the panel keeps it on
// the turn as `pendingSteer`, the card seeds the reply box with it, and it goes out as the next turn on
// that thread. `create()` used to clear it on EVERY new turn of the thread, whoever started that turn, so
// a MESSAGE the Director injected as the next turn erased the reader's queued text before it was ever sent.
//
// The rule the tests below pin: a turn the READER started answers the hold (a sent steer, or a new
// instruction that replaces it). A turn somebody else injected - a superior's MESSAGE, a subagent
// delivery, the panel's own wake - is a turn in front of the hold, not an answer to it: the text is
// carried to that turn so the card still offers it, and it goes out afterwards, in order.
// Real Jobs over HTTP against a stub gateway. No live gateway, model, session store or worktree.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

const HELD = "also check whether the queue pane still lists the row after a reload";
const INJECTED = "MESSAGE #2 | the Director: post the whole queue before you sweep it again";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-held-steer-"));
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
      // The FIRST turn is the one the gateway hands a steer back from: it ends with `pending_steer`, which
      // is exactly how `settle()` learns to hold the text on the job.
      const held = requests.length === 1 ? { pending_steer: HELD } : {};
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "finished", exit_code: 0, ...held })}\n\n`);
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

test("a held steer survives an injected superior turn and both arrive in order", async (t) => {
  const f = await fixture(t);
  const thread = "wtgui-held-steer-fixture";

  const first = await f.create({ prompt: "sweep the queue", thread });
  assert.equal(f.jobs.get(first.id).pendingSteer?.text, HELD, "the gateway handed the steer back, so the panel holds it");

  // The Director injects the next turn: this is `Assistant.say()`'s shape (a reply that the panel, not the
  // reader, started).
  const injected = await f.create({
    prompt: INJECTED,
    thread,
    reply: true,
    origin: { kind: "assistant-message", assistantId: "panel-assistant" },
  });
  assert.ok(injected.prompt.includes("the Director"), "the injected turn is the one that arrives first");
  assert.equal(
    f.jobs.get(injected.id).pendingSteer?.text,
    HELD,
    "the reader's queued input was erased by a turn it did not start: it must be carried to the newest turn",
  );

  // The reader sends the held text when the thread is free again.
  const sent = await f.create({ prompt: HELD, thread, reply: true });
  assert.equal(f.jobs.get(sent.id).pendingSteer || null, null, "the steer was sent, so the offer is answered");

  const order = f.requests.map((body) => body.input);
  const injectedAt = order.findIndex((input) => String(input).includes("the Director"));
  const heldAt = order.findIndex((input) => String(input).includes(HELD));
  assert.ok(injectedAt > 0, "the injected turn reached the gateway");
  assert.ok(heldAt > injectedAt, "the queued input arrived after the injection, in order, and was not swallowed by it");
});

test("a reader's own next turn answers the held steer instead of carrying it", async (t) => {
  const f = await fixture(t);
  const thread = "wtgui-held-steer-answered";

  const first = await f.create({ prompt: "sweep the queue", thread });
  assert.equal(f.jobs.get(first.id).pendingSteer?.text, HELD, "the first turn ends holding the steer");

  const next = await f.create({ prompt: "a different instruction from the reader", thread, reply: true });
  assert.equal(f.jobs.get(next.id).pendingSteer || null, null, "the reader's own turn supersedes the held text");
  assert.equal(f.jobs.get(first.id).pendingSteer || null, null, "and it is cleared everywhere, so nothing is offered twice");
});
