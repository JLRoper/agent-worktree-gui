// The run's event stream, as the panel subscribes to it.
//
// Three facts, each one a bug this file was written for:
//
//   1. RESUME, NOT REPLAY. The subscriber reconnects after a dropped socket and asks for the event after
//      the last one it printed (`Last-Event-ID`). The gateway replays from seq 0 when asked for nothing, so
//      a reconnect without it prints the run's whole transcript a second time under the reader's nose.
//   2. ONE LINE PER PARAGRAPH, NOT PER TOKEN. 40 deltas make ONE console line, and the store emits fewer
//      `jobline` frames than it received fragments - a fast model writes 30-60 a second and every one of
//      them used to be a frame to each reader.
//   3. A HONEST LIVE STORY. `summary().live` carries what the card's pulse draws: how many events have
//      arrived, when the last one did, whether text is streaming and which tool is in flight - and it is
//      null the moment the turn settles.
//
// Driven against a stub Runs API over real HTTP, with a real `Jobs` (no panel process, no browser). The
// page's own four-state drawing is asserted in tools/verify-live-pulse.mjs against a real page.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
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

// ---- the stub gateway -----------------------------------------------------------------------------
// One run, its events numbered from 0 like the real thing. Each connection is handed to the test, which
// decides what it hears: that is what lets the drop, the resume and the terminal event be separate steps
// instead of a race.
function makeStub() {
  const state = {
    capabilities: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true },
    connections: [], // [{ lastEventId, res }]
    seq: -1,
    status: "running",
    output: "",
    closed: false,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") return json(200, { version: "stream-stub", features: state.capabilities });
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      return json(200, { run_id: "run_stub_1", status: "running" });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (!m) return json(404, { error: { message: "not found" } });
    if ((m[2] || "") === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": open\n\n");
      const conn = { lastEventId: req.headers["last-event-id"] ?? null, res, open: true };
      state.connections.push(conn);
      req.on("close", () => {
        conn.open = false;
      });
      return;
    }
    // GET /v1/runs/{id}: the status endpoint, the backstop the subscriber polls when a socket ends.
    return json(200, { run_id: m[1], status: state.status, output: state.output, usage: { total_tokens: 12, input_tokens: 7, output_tokens: 5 } });
  });
  const send = (events) => {
    const conn = [...state.connections].reverse().find((c) => c.open);
    if (!conn) throw new Error("no open stream to send on");
    for (const evt of events) {
      state.seq += 1;
      const payload = { ...evt, run_id: "run_stub_1", seq: state.seq, timestamp: Date.now() / 1000 };
      conn.res.write(`id: ${state.seq}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  };
  return {
    state,
    send,
    // The socket goes away without a terminal event: a gateway restart, a proxy idle timeout, a laptop lid.
    drop: () => {
      for (const c of state.connections) if (c.open) c.res.end();
    },
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => {
      for (const c of state.connections) if (c.open) c.res.end();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

test("a dropped stream resumes at the last seq, one line per paragraph, and the live story is honest", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-stream-"));
  const stub = makeStub();
  const port = await stub.listen();
  const seen = { lines: [], sets: 0, news: 0, liveFrames: [] };
  const jobs = new Jobs({
    config: { apiServer: { url: `http://127.0.0.1:${port}`, key: "stub-key" }, jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir },
    onEvent: (evt) => {
      if (evt.type === "jobline") {
        seen.lines.push(evt.line);
        if (evt.line?.mode === "set") seen.sets += 1;
        if (evt.live) seen.liveFrames.push(evt.live);
      }
      if (evt.type === "job") seen.news += 1;
    },
    onLog: () => {},
  });
  t.after(async () => {
    for (const j of jobs.jobs.values()) jobs.settle(j, "cancelled", {});
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const job = await jobs.create({ prompt: "canary", cwd: dir, existing: true, thread: "wtgui-canary-1" });
  assert.equal(job.status, "running", "the stub accepted the run");
  assert.equal(job.runId, "run_stub_1");

  await waitFor(() => stub.state.connections.length === 1, { what: "the subscriber to open the stream" });

  // ---- 1. forty fragments, one line -----------------------------------------------------------
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
  stub.send(words.map((w) => ({ event: "message.delta", delta: `${w} ` })));
  const live = () => jobs.jobs.get(job.id);
  await waitFor(() => live().eventCount === 40, { what: "40 deltas consumed" });
  await waitFor(() => seen.sets > 0, { what: "the first throttled flush" });

  const textLines = () => live().lines.filter((l) => l.kind === "text");
  assert.equal(textLines().length, 1, "40 deltas are ONE console line, not forty");
  assert.equal(textLines()[0].text, `${words.join(" ")} `, "the line holds every fragment, in order");
  assert.ok(seen.sets < 20, `the store emitted ${seen.sets} set-frames for 40 fragments - coalesced, not one per token`);
  const liveFrames = () => seen.liveFrames.map((l) => l.events);
  assert.ok(Math.max(...liveFrames()) >= 40, `the console frames carry the run's live numbers (max events ${Math.max(...liveFrames())}) - the pulse advances with the output, not on a separate summary per token`);

  // ---- 2. the live story, mid-turn ------------------------------------------------------------
  const mid = jobs.summary(live());
  assert.equal(mid.live.events, 40, "the card is told how many events have arrived");
  assert.equal(mid.live.stream, "open", "the subscriber says it holds the stream");
  assert.equal(mid.live.streaming, true, "a delta was the last thing heard: text is streaming");
  assert.equal(mid.live.tool, null, "no tool is in flight yet");
  assert.ok(mid.live.lastEventAt >= mid.live.startedAt, "the last event is stamped after the run started");

  // ---- 3. a tool call: named while it runs, duration and error flag when it lands ---------------
  stub.send([{ event: "tool.started", tool: "terminal", preview: "ls" }]);
  await waitFor(() => live().eventCount === 41, { what: "tool.started" });
  const inTool = jobs.summary(live());
  assert.equal(inTool.live.tool?.name, "terminal", "the pulse can name the tool that is running");
  assert.equal(inTool.live.streaming, false, "text is not streaming while a tool owns the turn");

  stub.send([{ event: "tool.completed", tool: "terminal", duration: 1.25, error: false, preview: "a.txt" }]);
  await waitFor(() => live().eventCount === 42, { what: "tool.completed" });
  const toolLines = live().lines.filter((l) => l.kind === "tool");
  assert.equal(toolLines.length, 1);
  assert.match(toolLines[0].text, /^💻 terminal/, "the call is the 💻 line the console already draws");
  assert.ok(live().lines.some((l) => l.kind === "tool-out" && /↳ terminal · 1\.25s/.test(l.text)), "the completion carries the duration");
  assert.equal(jobs.summary(live()).live.tool, null, "the call is over: no tool is in flight");

  // ---- 4. reasoning is one dim line, never prose ----------------------------------------------
  stub.send([{ event: "reasoning.available", text: "first line\nsecond line of the block" }]);
  await waitFor(() => live().eventCount === 43, { what: "reasoning.available" });
  const dim = live().lines.filter((l) => l.kind === "dim" && l.text.startsWith("🧠 reasoning"));
  assert.equal(dim.length, 1, "reasoning lands as one dim line");
  assert.match(dim[0].text, /^🧠 reasoning · first line second line of the block$/, "the block is flattened, not invented");
  assert.ok(!textLines()[0].text.includes("reasoning"), "it is never merged into the answer");

  // ---- 5. the socket drops; the subscriber resumes at the last seq -----------------------------
  const beforeDrop = live().lastSeq;
  assert.equal(beforeDrop, 42, "43 events numbered from 0: the last seq is 42");
  stub.drop();
  await waitFor(() => stub.state.connections.length === 2, { timeoutMs: 8000, what: "the subscriber to reconnect" });
  assert.equal(
    stub.state.connections[1].lastEventId,
    String(beforeDrop),
    "the reconnect hands back the last seq it printed, so the gateway replays from the next one",
  );

  // ---- 6. the rest of the run, and the turn settles -------------------------------------------
  stub.state.status = "completed";
  stub.state.output = "the answer";
  stub.send([{ event: "message.delta", delta: "omega" }, { event: "run.completed", output: "the answer", usage: { total_tokens: 12, input_tokens: 7, output_tokens: 5 } }]);
  await waitFor(() => !["running", "starting", "waiting"].includes(live().status), { what: "the run to settle" });

  const settled = jobs.summary(live());
  assert.equal(settled.status, "done");
  assert.equal(settled.live, null, "a settled card has no pulse: there is nothing left to heartbeat");
  assert.equal(textLines().length, 1, "the resumed fragment joins the SAME line - nothing was replayed");
  assert.equal(textLines()[0].text, `${words.join(" ")} omega`, "no fragment was printed twice across the reconnect");
  assert.equal(stub.state.connections.length, 2, "one reconnect, not a loop");
});

test("a gateway without run_events_sse is polled, and the card says which path it is on", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-stream-off-"));
  const stub = makeStub();
  stub.state.capabilities = { run_submission: true, run_steer: true };
  const port = await stub.listen();
  const jobs = new Jobs({
    config: { apiServer: { url: `http://127.0.0.1:${port}`, key: "stub-key" }, jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir },
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(async () => {
    for (const j of jobs.jobs.values()) jobs.settle(j, "cancelled", {});
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const job = await jobs.create({ prompt: "canary", cwd: dir, existing: true, thread: "wtgui-canary-2" });
  await sleep(150);
  const stored = jobs.jobs.get(job.id);
  const said = stored.lines.map((l) => l.text).join("\n");
  assert.match(said, /does not advertise run_events_sse/, "the card says it is polled, not streamed");
  assert.equal(stored.streamMode, "poll");
  assert.equal(stub.state.connections.length, 0, "no stream is opened on a gateway that has none");
  assert.equal(jobs.summary(stored).live.stream, "off", "the pulse is told there is no stream to judge silence by");
});
