// A panel restart must not write a run off before it has asked the gateway.
//
// What was wrong. `Jobs.load()` stamped every turn that was running `interrupted — the panel restarted while this
// was running` in one pass, without asking the gateway whether its run had outlived the panel. Measured on this
// box: one restart wrote that verdict over three runs (`run_b881c5f3…`, `run_95e3605a…`, `run_c367…`) the gateway
// was still executing, and the card kept the lie until the boot reconcile happened to answer — or forever, when
// the probe timed out and the reconcile was skipped.
//
// The contract these tests pin:
//   * a run alive across a simulated restart comes back RUNNING, not interrupted, and the gateway's own `running`
//     answer re-attaches it (the card says so);
//   * a run the gateway reports cancelled settles on the gateway's word — `cancelled`, not `interrupted`;
//   * no frame, and no store write, ever carries `interrupted` for a run the gateway says is running;
//   * a gateway that answers nothing (a 5xx) still falls back to the restart's verdict — but only AFTER the ask,
//     and only on the card that was live, which is what keeps the re-attach chip available.
//
//   node --test test/restored-run-not-interrupted.test.js
//
// WHAT IS DRIVEN: the shipped `Jobs` store — `load()` and `reconcileRestored()` — against a stub Runs API on an
// ephemeral port. No panel process is started and the live gateway is never touched.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { Jobs } from "../lib/jobs.js";

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-restored-run-"));
const work = path.join(dir, "work");
mkdirSync(work, { recursive: true });
const START = "2026-11-05T20:00:00.000Z";
const LAST = "2026-11-05T20:14:00.000Z";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A gateway that answers per run id. `status` is what GET /v1/runs/<id> returns: a run object, the number 404,
// or the number 500. Every event stream is held open, the way the real gateway holds a live run's.
function makeGateway() {
  const state = { runs: new Map(), hits: [], streams: 0 };
  let n = 0;
  const json = (res, code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const server = createServer((req, res) => {
    const parts = String(req.url || "").split("/").filter(Boolean);
    if (parts[0] === "v1" && parts[1] === "capabilities") {
      return json(res, 200, { version: "restored-run-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true } });
    }
    const id = parts[2] ? decodeURIComponent(parts[2]) : "";
    const sub = parts[3] || "";
    state.hits.push(`${sub || "status"} ${id}`);
    if (sub === "events") {
      state.streams += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": attached\n\n");
      const timer = setInterval(() => res.write(": held\n\n"), 300);
      req.on("close", () => clearInterval(timer));
      return;
    }
    const answer = state.runs.get(id);
    if (answer === 404) return json(res, 404, { error: { message: "Run not found", code: "run_not_found" } });
    if (answer === 500) return json(res, 500, { error: { message: "internal error" } });
    if (!answer) return json(res, 404, { error: { message: "Run not found", code: "run_not_found" } });
    return json(res, 200, answer);
  });
  return {
    state,
    server,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// The card the outgoing panel's store held when it died mid-turn.
const card = (id, runId, over = {}) => ({
  id,
  thread: `wtgui-${id}`,
  turn: 1,
  prompt: `the turn behind ${id}`,
  cwd: work,
  sessionId: `wtgui-${id}`,
  status: "running",
  exitCode: null,
  startedAt: START,
  endedAt: null,
  runId,
  worktree: false,
  existing: false,
  lines: [{ kind: "tool", lid: 1, at: Date.parse(LAST), text: "terminal · build it" }],
  ...over,
});

async function boot(t, { cards, answers }) {
  const gw = makeGateway();
  const url = await gw.listen();
  for (const [id, answer] of Object.entries(answers || {})) gw.state.runs.set(id, answer);
  const store = path.join(dir, `jobs-${++seq}.json`);
  writeFileSync(store, JSON.stringify({ savedAt: START, jobs: cards }), "utf8");
  const frames = [];
  const jobs = new Jobs({
    config: { jobsFile: store, defaultCwd: work, assistantCwd: path.join(dir, "assistant"), apiServer: { url, key: "test-key" } },
    onEvent: (e) => frames.push(e),
    onLog: () => {},
  });
  t.after(async () => {
    for (const j of jobs.jobs.values()) {
      clearTimeout(j.timer);
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      try {
        j.ctrl?.abort();
      } catch {
        /* already closed */
      }
    }
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    clearTimeout(jobs.persistTimer);
    await gw.close();
  });
  return { jobs, gw, store, frames };
}

let seq = 0;
after(() => rmSync(dir, { recursive: true, force: true }));

test("a run alive across a simulated restart stays running and reads re-attached", async (t) => {
  const { jobs } = await boot(t, {
    cards: [card("j-live", "run_live")],
    answers: { run_live: { run_id: "run_live", status: "running", output: "" } },
  });
  const j = jobs.jobs.get("j-live");

  // Before anything is asked: the panel came back, the gateway has not been consulted, so there is no verdict.
  assert.equal(j.status, "running", "a restart alone does not end a run");
  assert.equal(j.awaitingGateway, true, "the card is marked as waiting for the gateway's answer");
  assert.equal(j.error || "", "", "no restart wording is written before the ask");
  assert.equal(j.endedAt, null, "the live clock is not stopped on an unasked card");

  const settled = await jobs.reconcileRestored();
  assert.deepEqual(settled, ["j-live"], "the reconcile answered for the card");
  assert.equal(j.status, "running", "the gateway still has the run, so the card stays live");
  assert.equal(j.awaitingGateway, false, "the pending marker is cleared by the answer");
  assert.equal(j.error || "", "", "nothing was written off");
  assert.equal(j.endedAt, null, "the run's own clock goes on");
  const text = (j.lines || []).map((l) => String(l.text || "")).join("\n");
  assert.match(text, /re-attached/, "the card says it was re-attached to the run");
  assert.doesNotMatch(text, /interrupted/, "and never says the run was interrupted");
});

test("a run the gateway reports cancelled settles cancelled", async (t) => {
  const { jobs } = await boot(t, {
    cards: [card("j-cancelled", "run_cancelled")],
    answers: { run_cancelled: { run_id: "run_cancelled", status: "cancelled", error: "stopped at the gateway" } },
  });
  const j = jobs.jobs.get("j-cancelled");
  assert.equal(j.status, "running", "the card is still live before the gateway is asked");

  await jobs.reconcileRestored();
  assert.equal(j.status, "cancelled", "the gateway's own word is the card's status");
  assert.equal(j.error, "stopped at the gateway", "the run's own reason is kept");
  const text = (j.lines || []).map((l) => String(l.text || "")).join("\n");
  assert.match(text, /run cancelled in the gateway/, "the console says which ending the gateway reported");
  assert.doesNotMatch(text, /this card cannot steer it/, "there is no restart promise on a run that ended");
});

test("no run is ever written interrupted while the gateway says running", async (t) => {
  const { jobs, store, frames } = await boot(t, {
    cards: [card("j-watch", "run_watch")],
    answers: { run_watch: { run_id: "run_watch", status: "running", output: "" } },
  });

  // Every frame the panel ever emits for this card, plus the store it writes: neither may carry the word while
  // the gateway's answer is `running`.
  const interruptedFrames = frames
    .filter((e) => e.type === "job" && e.job?.id === "j-watch")
    .filter((e) => e.job.status === "interrupted" || /interrupt/i.test(String(e.job.error || "")) || /interrupt/i.test(String(e.job.completion?.word || "")));
  assert.deepEqual(interruptedFrames.map((e) => e.job.status), [], "no frame wrote the word before the ask");

  await jobs.reconcileRestored();
  await sleep(1100); // persistence is debounced by 700ms
  const saved = JSON.parse(readFileSync(store, "utf8"));
  const written = saved.jobs.find((x) => x.id === "j-watch");
  assert.equal(written.status, "running", "the store keeps the live status");
  assert.equal(written.error || null, null, "the store carries no restart wording");
  assert.equal(written.completion || null, null, "no completion notice was built for a live run");
  assert.equal(written.awaitingGateway, false, "the store records that the answer arrived");
});

test("a gateway that cannot answer leaves the card live until it is asked, then falls back to the restart verdict", async (t) => {
  const { jobs } = await boot(t, {
    cards: [card("j-500", "run_500")],
    answers: { run_500: 500 },
  });
  const j = jobs.jobs.get("j-500");
  assert.equal(j.status, "running", "a 5xx that has not been asked for is not a verdict either");

  const settled = await jobs.reconcileRestored();
  assert.deepEqual(settled, ["j-500"], "the failed ask is the decision this pass made");
  assert.equal(j.status, "interrupted", "the panel's restart verdict stands only after the gateway failed to answer");
  assert.match(j.error, /the panel restarted while this was running/, "the card says who lost it");
  assert.equal(j.runGone, false, "a 5xx is not a 404: the run may still exist, so the chip stays available");
  assert.equal(j.awaitingGateway, false, "the pending marker is cleared");
  const text = (j.lines || []).map((l) => String(l.text || "")).join("\n");
  assert.match(text, /no stream for it any more/, "the console says what the panel lost");
  assert.doesNotMatch(text, /re-attached/, "nothing claims to be re-attached");
});
