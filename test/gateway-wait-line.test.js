// The console BODY has to say the wait. The card's head already carries the pulse ("no events yet · 56s"), but on
// run_1ab0c80b the first event of any kind arrived 82 s after the POST and the body under a live head was blank, so a
// working run read as a dead panel. The rule (landing row #255):
//
//   1. at SUBSCRIBE, one dim line into the body: the run has started and the gateway has sent nothing yet;
//   2. the first event of ANY kind annotates that SAME row with what was measured (never a second row);
//   3. a run that settles having never sent an event says so ONCE, in that same row;
//   4. the sentence is the GATEWAY's - this panel holds the stream and has taken no event off it - and never a claim
//      about what the model is doing.
//
// The age that ticks is the page's (public/board/console.js waitLineHtml + public/app.js tickLiveClocks); these cases
// pin the server half, which is what puts the line in the record and ends it honestly.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

const WAIT_TEXT = "run started - the gateway has sent nothing yet";

// One gateway: `first` answers the run's event stream with one delta and a completion, `silent` holds the stream open
// and writes NOTHING - the measured case. The status endpoint keeps saying running, so only the test's own settle can
// end a silent run.
async function fixture(t, mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-gateway-wait-"));
  const home = process.env.HERMES_HOME;
  process.env.HERMES_HOME = path.join(dir, "hermes");
  const held = [];
  const frames = [];
  const server = createServer(async (req, res) => {
    const json = (data, code = 200) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (req.url === "/v1/capabilities") return json({ features: { run_submission: true, run_events_sse: true } });
    if (req.url === "/v1/runs" && req.method === "POST") {
      for await (const chunk of req) void chunk;
      return json({ run_id: "run_wait_fixture" });
    }
    if (/\/events$/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "first") {
        res.write(`data: ${JSON.stringify({ event: "message.delta", delta: "hello", seq: 1 })}\n\n`);
        res.write(`data: ${JSON.stringify({ event: "run.completed", output: "hello", exit_code: 0, seq: 2 })}\n\n`);
        return res.end();
      }
      held.push(res);
      return;
    }
    if (/^\/v1\/runs\/[^/]+$/.test(req.url) && req.method === "GET") return json({ status: "running" });
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = { apiServer: { url: `http://127.0.0.1:${server.address().port}`, key: "fixture-key" }, jobsFile: path.join(dir, "jobs.json") };
  const store = new Jobs({ config, onLog: () => {}, onEvent: (evt) => frames.push(evt) });
  const start = (opts = {}) => store.create({ prompt: "wait for the gateway", thread: "wtgui-gateway-wait-fixture", cwd: dir, existing: true, remoteWrite: "none", ...opts });
  t.after(async () => {
    for (const job of store.jobs.values()) store.settle(job, "cancelled", {});
    clearInterval(store.titleSweep);
    clearInterval(store.approvalSweep);
    clearInterval(store.approvalReconcile);
    clearTimeout(store.persistTimer);
    for (const res of held) res.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (home === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = home;
  });
  return { store, frames, start, dir };
}

const settleWait = async (store, id, deadline = Date.now() + 10_000) => {
  while (store.get(id).status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return store.get(id);
};

test("at subscribe the body carries one dim line saying the gateway has sent nothing yet", async (t) => {
  const f = await fixture(t, "silent");
  const summary = await f.start();
  const job = f.store.get(summary.id);
  assert.equal(job.status, "running");
  const line = f.store.waitLineOf(job);
  assert.ok(line, "the wait line is in the run's own record, not only in the page");
  assert.equal(line.kind, "dim", "it is drawn as the console's quiet note, not as the agent's words");
  assert.equal(line.wait, "gateway", "the mark the page ticks its age from");
  assert.equal(line.text, WAIT_TEXT);
  assert.ok(Number.isFinite(line.at) && Math.abs(Date.now() - line.at) < 10_000, "the line carries the stamp the age counts from");
  // The line reaches the page the way every console line does: a jobline frame, and the summary's own tail.
  assert.ok(f.frames.some((e) => e.type === "jobline" && e.line?.lid === line.lid), "pushed as a console line");
  assert.ok(summary.lines.some((l) => l.wait === "gateway"), "the summary carries it to a page that was not listening");
});

test("the first event annotates that same row - no second row, and the wait is over", async (t) => {
  const f = await fixture(t, "first");
  const summary = await f.start();
  const job = await settleWait(f.store, summary.id);
  assert.equal(job.status, "done");
  const rows = job.lines.filter((l) => l.wait);
  assert.equal(rows.length, 1, "one row about one wait, from subscribe to the end");
  assert.equal(rows[0].wait, "first");
  assert.match(rows[0].text, /^an event from the gateway arrived after \d+(\.\d+)?s$/);
  assert.notEqual(rows[0].text, WAIT_TEXT, "the row no longer claims nothing has arrived");
  const set = f.frames.find((e) => e.type === "jobline" && e.line?.mode === "set" && e.line?.wait === "first");
  assert.ok(set, "the page is told to rewrite the row in place (mode: set), which is what stops its clock");
  assert.equal(set.line.lid, rows[0].lid, "the annotation names the row already on screen");
});

test("a run that settles having sent nothing says so once, in the row the wait was drawn in", async (t) => {
  const f = await fixture(t, "silent");
  const summary = await f.start();
  const job = f.store.get(summary.id);
  const line = f.store.waitLineOf(job);
  assert.ok(line);
  f.store.settle(job, "cancelled", {});
  assert.equal(line.wait, "never");
  assert.match(line.text, /^the run ended after \d+(\.\d+)?s with no event from the gateway$/);
  assert.equal(job.lines.filter((l) => l.wait === "gateway" || l.wait === "never" || l.wait === "first").length, 1, "one row, not a second note under it");
  const set = f.frames.find((e) => e.type === "jobline" && e.line?.mode === "set" && e.line?.wait === "never");
  assert.ok(set, "the live page is handed the same row again, to replace the clock");
  assert.equal(set.line.lid, line.lid);
  // Settling again (a late stop, a second caller) must not write a second verdict.
  const once = line.text;
  f.store.settle(job, "cancelled", {});
  assert.equal(line.text, once, "said once");
  assert.equal(job.lines.filter((l) => l.wait === "never").length, 1);
});

test("every sentence about the wait is about the gateway, never about thinking", async (t) => {
  const f = await fixture(t, "first");
  const summary = await f.start();
  const job = await settleWait(f.store, summary.id);
  const rows = job.lines.filter((l) => l.wait);
  assert.ok(rows.length >= 1, "there is a wait row to judge");
  for (const line of rows) {
    assert.doesNotMatch(line.text, /think|reasoning|the model|agent is/i, `claims nothing about the model: ${line.text}`);
    assert.match(line.text, /gateway/);
  }
});
