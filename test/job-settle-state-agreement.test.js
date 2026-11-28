// Row 400: a settled run must read DONE on both board reads, and the turn head must say so.
//
// The reader's report was a session whose top turn read "turn 1 · running 182m3s" over a body that already said the
// result was ready. Two live reads of the same run disagreed: GET /api/jobs answered status done with an endedAt while
// GET /api/state - the board snapshot, which carries `jobs: jobs.list()` - answered the SAME job as running with
// endedAt null. The transcript draws its turns from `state.jobs` and prints "running <elapsed>" whenever turnLive()
// is true, so the stale status kept the head running forever.
//
// This file pins the two halves that make that impossible:
//
//   1. THE REAL PATH. A run is started through /api/agents against a stub gateway that holds its stream open, the
//      board read is primed while it runs, the run is then allowed to settle, and BOTH reads are taken again. They
//      must agree on the status and the endedAt - a settle drops the cached snapshot text (server.js broadcastJobs),
//      so the next /api/state is the board the jobs read already described, not the pre-settle copy the old
//      stale-while-revalidate path answered (and, on a busy fleet, never stopped answering).
//   2. THE HEAD. turnLive() must not call a turn live on a terminal status the panel recorded, even with a lingering
//      closed question or approval record; an interrupted turn with an OPEN question stays live, which is the case
//      its own comment argues for. turnStateText() is then read on the same record and must say "done".
//
// The page functions are read out of the shipped sources and run in a vm, the way test/board-lookups.test.js reads
// them: public/board-scaffold.js is a classic script, so its declarations are page-wide and a bare extraction is the
// binding the page uses.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { configureRepo, git as runGit, post, startPanel } from "../tools/panel-testkit.mjs";

const page = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The block from one top-level line to the end of the named function, exactly as the page ships it. */
function grab(src, fromMarker, toMarker) {
  const start = src.indexOf(fromMarker);
  assert.ok(start >= 0, `the page carries ${fromMarker}`);
  const end = src.indexOf(toMarker, start);
  assert.ok(end > start, `${toMarker} follows ${fromMarker}`);
  return src.slice(start, end);
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-settle-repo-"));
  runGit(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# settle fixture\n");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-q", "-m", "first"]);
  return dir;
}

const sweep = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch {
    /* a background git handle on Windows; OS temp is throwaway */
  }
};

// The smallest gateway that starts a run and then HOLDS its event stream, so the test decides when it settles. A GET
// on the run keeps answering `running`: the settle has to come from the terminal event, which is the real path
// (lib/jobs.js `follow`), not from the panel's 15s status poll.
async function stubGateway() {
  const submitted = [];
  const held = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ version: "stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, model_options: true } }));
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          submitted.push(JSON.parse(raw || "{}"));
        } catch {
          submitted.push({});
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: `stub-run-${submitted.length}`, status: "running" }));
      });
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`event: message.delta\ndata: ${JSON.stringify({ event: "message.delta", delta: "working", seq: 1 })}\n\n`);
      held.push(res);
      return;
    }
    if (/^\/v1\/runs\/[^/]+$/.test(url.pathname) && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ run_id: "stub-run", status: "running" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ run_id: "stub-run", status: "running" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    submitted,
    // Every turn this stub holds ends here: one completion event per open stream, the gateway's own terminal word.
    finish() {
      for (const res of held) {
        res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "done", exit_code: 0, seq: 2 })}\n\n`);
        res.end();
      }
      held.length = 0;
    },
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

test("a settled run reads done on /api/jobs AND /api/state, and the turn head says done", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const panel = await startPanel({
    config: {
      apiServer: { url: stub.url, key: "sandbox-key" },
      projects: [{ name: "fixture", path: repo, remote: null, mainBranch: "main" }],
    },
  });
  const jobOf = async (base, id) => {
    const r = await fetch(`${base}/api/jobs`);
    assert.equal(r.status, 200);
    const body = await r.json();
    return (body.jobs || []).find((j) => j.id === id) || null;
  };
  t.after(async () => {
    await panel.stop();
    await stub.stop();
    sweep(repo);
  });

  // A real spawn through the route the New-agent card posts to: the panel creates the card, the run is submitted to
  // the stub, and the stub holds its stream open so the run is RUNNING when the board read is primed below.
  const spawned = await post(panel.base, "/api/agents", {
    body: { prompt: "settle this run", cwd: repo, project: "fixture", existing: true },
  });
  assert.equal(spawned.status, 202, `the spawn is accepted: ${spawned.text}`);
  const id = spawned.json?.job?.id;
  assert.ok(id, `the route answered a card: ${spawned.text}`);

  // WAIT until the card is running (the run is submitted asynchronously), then PRIME the snapshot cache with it. This
  // is the reader's own situation: a board read taken while the run is live is the text that must not survive it.
  const deadline = Date.now() + 20_000;
  let running = null;
  while (Date.now() < deadline) {
    running = await jobOf(panel.base, id);
    if (running && running.status === "running") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(running?.status, "running", `the run is live before the prime: ${JSON.stringify(running)}`);
  const primed = await (await fetch(`${panel.base}/api/state`)).json();
  const primedJob = (primed.jobs || []).find((j) => j.id === id);
  assert.equal(primedJob?.status, "running", "the primed board read carries the live status");
  assert.equal(primedJob?.endedAt, null);

  // THE SETTLE, through the gateway's own terminal event. No polling trick, no direct store call.
  stub.finish();
  const settleDeadline = Date.now() + 20_000;
  let settledJobs = null;
  let settledState = null;
  while (Date.now() < settleDeadline) {
    settledJobs = await jobOf(panel.base, id);
    if (settledJobs && settledJobs.status !== "running") {
      // Taken in the same breath as the jobs read that proved the settle: this is the pair the reader compared.
      settledState = await (await fetch(`${panel.base}/api/state`)).json();
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(settledJobs && settledJobs.status !== "running", `the run settled: ${JSON.stringify(settledJobs)}`);
  assert.ok(settledState, "the board read answered after the settle");

  const boardJob = (settledState.jobs || []).find((j) => j.id === id);
  assert.ok(boardJob, `the board read carries the same card (${(settledState.jobs || []).length} jobs)`);
  assert.equal(settledJobs.status, "done", `the jobs read says done: ${settledJobs.status}`);
  assert.equal(boardJob.status, settledJobs.status, "the board read agrees with the jobs read");
  assert.equal(boardJob.endedAt, settledJobs.endedAt, "both reads name the same end");
  assert.ok(boardJob.endedAt, "the settled card carries an endedAt");

  // THE HEAD, on the record the board read actually serves. ONE question/approval record left behind must not keep a
  // terminal turn live - that is the "running 182m3s" the reader saw over a finished body.
  const turn = { ...boardJob, question: { id: "q1", text: "which way?" }, questionDone: true };
  const head = headOf(turn);
  assert.equal(head.live, false, "a done turn is not live, even with its closed question still on the record");
  assert.match(head.text, /^done · /, `the head says done, not running: ${head.text}`);
});

// The same two functions, driven on the shapes the settle can leave behind. Read from the shipped sources.
const SCAFFOLD = page("public/board-scaffold.js");
const APP = page("public/app.js");

function headOf(turn) {
  const liveBlock = grab(SCAFFOLD, "const LIVE_STATUS = new Set(", "// An approval is only a question");
  const headBlock = grab(APP, "function turnStateText(turn) {", "// A minimized card is a head and one line");
  const ctx = {
    Set,
    String,
    Boolean,
    // The head's own helpers, stubbed at the values that do not matter here: the status word is the claim.
    elapsed: () => "182m3s",
    isWaiting: () => false,
    waitNote: () => "",
    fmtTok: () => "",
  };
  vm.createContext(ctx);
  vm.runInContext(liveBlock, ctx);
  vm.runInContext(headBlock, ctx);
  return { live: ctx.turnLive(turn), text: ctx.turnStateText(turn) };
}

test("a terminal status outvotes a lingering record, and an interrupted turn on an open question stays live", () => {
  // The recorded terminal statuses: done, failed, cancelled. A lingering question record (closed or cleared by the
  // settle) must not resurrect any of them.
  for (const status of ["done", "failed", "cancelled"]) {
    const closed = headOf({ status, endedAt: "2026-11-28T01:23:29.045Z", question: { id: "q" }, questionDone: true });
    assert.equal(closed.live, false, `${status} with a closed question is not live`);
    const lingering = headOf({ status, endedAt: "2026-11-28T01:23:29.045Z", question: { id: "q" } });
    assert.equal(lingering.live, false, `${status} with a question record the settle left behind is not live`);
    const approval = headOf({ status, endedAt: "2026-11-28T01:23:29.045Z", approval: { id: "a" } });
    assert.equal(approval.live, false, `${status} with an approval record left behind is not live`);
  }
  // The deliberate exception: a run whose stream died while the gateway still holds its prompt is still in a turn.
  assert.equal(headOf({ status: "interrupted", question: { id: "q" } }).live, true, "interrupted on an open question stays live");
  assert.equal(headOf({ status: "running", startedAt: "2026-11-28T01:20:00.000Z" }).live, true, "a running turn is live");
  assert.equal(headOf({ status: "waiting_for_approval", approval: { id: "a" } }).live, true, "a parked approval is live");
});
