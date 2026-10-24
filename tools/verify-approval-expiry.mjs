// An approval nobody answers must not stay on the board as a button.
//
//   node tools/verify-approval-expiry.mjs
//
// Measured on the live box, 2026-10-24 (run_32e739f284fb4996b97ef1aa48b43032): the gateway's 300 s approval
// window closed at 12:00:48 and the agent was told "BLOCKED: Command timed out without user response", but no
// client was told anything — `approval.responded` is emitted ONLY by `POST /v1/runs/{id}/approval`, so the run
// status still read `waiting_for_approval` with the request attached nine minutes later, the panel's card still
// offered "Allow once", and the reader's four clicks (12:08:46, 12:08:49, 12:08:56, 12:09:36) were each answered
// 409 `Run has no pending approval`.
//
// This drives the shipped Jobs class against a stand-in Runs API that parks a run on an approval and can answer
// like the real gateway does, and asserts the four things that keep a card honest: the deadline comes from the
// EVENT's clock, the sweep takes the box away, a press after the window never reaches the gateway, and the
// gateway's own "no pending approval" is a verdict rather than an error to show forever.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs } from "../lib/jobs.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const near = (name, got, want, slack) => ok(name, Math.abs(Number(got) - Number(want)) <= slack, { got, want, slack });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the stand-in Runs API ─────────────────────────────────────────────────────────────────────────────────────
// One plan at a time (`plan`), because the cases run in sequence: how old the approval request looks, and how the
// gateway answers a POST to /approval. Every approval POST is recorded per run, which is what proves a click after
// the window never left the panel.
const plan = { stampOffsetMs: 0, answer: 200, windowSeconds: 60 };
const posts = []; // { runId, body, code }
let runs = 0;

const readJson = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });

const api = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/v1/capabilities") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "hermes.capabilities", features: { run_approval_response: true } }));
  }

  if (path === "/v1/runs" && req.method === "POST") {
    runs++;
    const runId = `run_probe${String(runs).padStart(2, "0")}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "hermes.run", run_id: runId, status: "running" }));
  }

  const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
  if (events) {
    const runId = events[1];
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": open\n\n");
    // A parked run: the flagged command's request, then nothing. The stream stays open the way the gateway's does
    // while the agent blocks on the answer.
    const stamp = (Date.now() + plan.stampOffsetMs) / 1000;
    res.write(
      `id: 1\ndata: ${JSON.stringify({
        event: "tool.started",
        run_id: runId,
        timestamp: stamp,
        tool: "terminal",
        preview: "curl -s -m 4 -H \"Authorization: Bearer ***\" http://127.0.0.1:8642/v1/capabilities",
      })}\n\n`,
    );
    res.write(
      `id: 2\ndata: ${JSON.stringify({
        event: "approval.request",
        run_id: runId,
        timestamp: stamp,
        // The real gateway always names the request: `_ApprovalEntry.__init__` sets `request_id` (a uuid4 hex) and
        // the notify callback ships it, which is what `resolve_gateway_approval(..., request_id=…)` matches on.
        request_id: `req_${runId}`,
        command: "curl -s -m 4 -H \"Authorization: Bearer ***\" http://127.0.0.1:8642/v1/capabilities",
        pattern_key: "terminal:curl",
        choices: ["once", "deny"],
      })}\n\n`,
    );
    return; // held open on purpose
  }

  const status = /^\/v1\/runs\/([^/]+)$/.exec(path);
  if (status && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "hermes.run", run_id: status[1], status: "running" }));
  }

  const approval = /^\/v1\/runs\/([^/]+)\/approval$/.exec(path);
  if (approval && req.method === "POST") {
    const body = await readJson(req);
    const code = plan.answer === 200 ? null : "approval_not_pending";
    posts.push({ runId: approval[1], body, code });
    res.writeHead(plan.answer, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify(
        plan.answer === 200
          ? { object: "hermes.run.approval_response", run_id: approval[1], choice: body.choice, resolved: 1 }
          : { error: { message: `Run has no pending approval: ${approval[1]}`, code, type: "invalid_request_error" } },
      ),
    );
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found", code: "not_found" } }));
});

const dir = mkdtempSync(join(tmpdir(), "wtgui-approval-"));
process.env.HERMES_HOME = dir; // no store read leaves the scratch tree

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

let jobs = null;
const summaries = [];
const startRun = async () => {
  const before = summaries.length;
  const summary = await jobs.create({ prompt: "probe the approval window", thread: null, existing: true, cwd: dir, worktree: false });
  // The card is fed by the stream, so wait for the approval to land on the summary the API serves.
  for (let i = 0; i < 60 && !latest(summary.id)?.approval; i++) await sleep(50);
  return latest(summary.id);
};
const latest = (id) => summaries.filter((s) => s.id === id).at(-1) || null;

try {
  const port = await listen(api);
  jobs = new Jobs({
    config: { apiServer: { url: `http://127.0.0.1:${port}`, key: "probe-key" }, jobsFile: join(dir, "jobs.json"), defaultCwd: dir },
    onEvent: (evt) => {
      if (evt?.type === "job") summaries.push(evt.job);
    },
    approvalWindow: () => ({ seconds: plan.windowSeconds }),
  });

  // ── 1. the deadline is the GATEWAY's clock, not this panel's ─────────────────────────────────────────────
  // The request arrives here 3 minutes after the gateway started waiting (a replayed event, a panel that attached
  // late): its window has 0 s left, and a deadline counted from arrival would have invented 60 s of it.
  plan.stampOffsetMs = -180_000;
  plan.answer = 200;
  const stale = await startRun();
  ok("1. the request reaches the card", Boolean(stale?.approval), stale?.approval ? null : stale);
  check("1. the card carries the gateway's window", stale?.approval?.timeoutSeconds, 60);
  near("1. the deadline is the event's own start + the window", stale?.approval?.deadline, Date.now() - 120_000, 2_000);
  ok("1. so the card is already closed", Number(stale?.approval?.deadline) < Date.now(), stale?.approval?.deadline);

  // …and the sweep takes it off the board, with the record that says nobody answered.
  check("1. the sweep takes exactly that one box", jobs.sweepApprovals(), 1);
  const swept = latest(stale.id);
  check("1. nothing is parked on the turn any more", swept?.approval, null);
  check("1. and it is recorded as unanswered, not as a decision", Boolean(swept?.approvalDone?.expired), true);
  check("1. no choice was invented", swept?.approvalDone?.choice, "");
  near("1. how long it went unanswered", swept?.approvalDone?.waitedSeconds, 180, 2);
  ok(
    "1. the console keeps one line saying what happened",
    (swept?.lines || []).some((l) => /no answer within the gateway's 60s window/.test(String(l.text || ""))),
    (swept?.lines || []).at(-1)?.text,
  );
  check("1. and the gateway was never asked", posts.length, 0);

  // ── 2. a press after the window never leaves the panel ───────────────────────────────────────────────────
  // The gap this covers: the box is on screen, the page has not repainted, and the panel's own sweep has not run
  // yet. The press is answered locally, so the gateway is spared a request it can only refuse.
  plan.windowSeconds = 2;
  plan.stampOffsetMs = 0;
  const fresh = await startRun();
  ok("2. a fresh request is open", Number(fresh?.approval?.deadline) > Date.now(), fresh?.approval?.deadline);
  await sleep(2_400); // past the window, inside the 5 s sweep
  const late = await jobs.approve(fresh.id, "once");
  check("2. the press is refused locally", late.ok, false);
  check("2. it is named as gone", Boolean(late.gone), true);
  ok("2. and says why in words", /window .*already closed|already closed/.test(String(late.error)), late.error);
  check("2. nothing was posted to the gateway", posts.length, 0);
  check("2. the box is gone", latest(fresh.id)?.approval, null);
  check("2. recorded as unanswered", Boolean(latest(fresh.id)?.approvalDone?.expired), true);

  // ── 3. the real-time sweep, without anyone pressing anything ─────────────────────────────────────────────
  // Same 2 s window, no click: the interval has to take the box away on its own, or a reader who walks away
  // comes back to a live-looking prompt for a command the agent was already refused.
  const walked = await startRun();
  ok("3. the box is up while the window is open", Boolean(walked?.approval), walked?.approval);
  let auto = null;
  for (let i = 0; i < 50 && !auto?.approvalDone; i++) {
    await sleep(200);
    auto = latest(walked.id);
  }
  check("3. the sweep removed it with nobody pressing", auto?.approval, null);
  ok("3. and left the record", Boolean(auto?.approvalDone?.expired), auto?.approvalDone);
  ok("3. without asking the gateway", posts.length === 0, posts.length);

  // ── 4. the gateway's own verdict is handled, not displayed forever ───────────────────────────────────────
  // A window long enough that the panel is not the one that gives up: the gateway answers "no pending approval"
  // — exactly the incident's 409, four times over — and the card must go with one request, not four.
  plan.windowSeconds = 900;
  plan.answer = 409;
  const goneRun = await startRun();
  const posted = posts.length;
  const first = await jobs.approve(goneRun.id, "once", goneRun?.approval?.requestId);
  check("4. the gateway's refusal is not a success", first.ok, false);
  check("4. it is reported as the gateway's verdict", first.code, "approval_not_pending");
  check("4. with the words the reader needs", Boolean(first.gone), true);
  check("4. the box is gone", latest(goneRun.id)?.approval, null);
  check("4. recorded as unanswered, so nothing was decided", latest(goneRun.id)?.approvalDone?.choice, "");
  check("4. and marked as the gateway's doing", latest(goneRun.id)?.approvalDone?.reason, "withdrawn");
  check("4. exactly one request went out", posts.length - posted, 1);
  const again = await jobs.approve(goneRun.id, "once");
  check("4. a second press sends nothing", posts.length - posted, 1);
  check("4. and is answered as settled", Boolean(again.gone), true);

  // ── 5. an answer inside the window still works ───────────────────────────────────────────────────────────
  plan.answer = 200;
  const good = await startRun();
  const answered = await jobs.approve(good.id, "once", good?.approval?.requestId);
  check("5. the answer is accepted", answered.ok, true);
  check("5. with the choice that was offered", answered.choice, "once");
  check("5. the body carries the choice", posts.at(-1)?.body?.choice, "once");
  check("5. and the request id the gateway sent", posts.at(-1)?.body?.request_id, good?.approval?.requestId);
  check("5. which is the gateway's own id, not one the panel invented", posts.at(-1)?.body?.request_id, `req_${good?.runId}`);
  check("5. the box is replaced by the decision", latest(good.id)?.approval, null);
  check("5. approved, not expired", latest(good.id)?.approvalDone?.choice, "once");
  check("5. no expiry flag", Boolean(latest(good.id)?.approvalDone?.expired), false);

  // ── 6. a late press on a settled turn is told, not lectured ──────────────────────────────────────────────
  const beforeStale = posts.length;
  const settled = await jobs.approve(good.id, "once");
  check("6. the stale press is refused", settled.ok, false);
  check("6. as already settled", Boolean(settled.gone), true);
  ok("6. in words a reader understands", /already settled/.test(String(settled.error)), settled.error);
  check("6. without another request", posts.length - beforeStale, 0);
} finally {
  try {
    clearInterval(jobs?.titleSweep);
    clearInterval(jobs?.approvalSweep);
    for (const j of jobs?.jobs?.values?.() || []) {
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      clearTimeout(j.timer);
      j.ctrl?.abort?.();
    }
  } catch {
    /* nothing to unwind */
  }
  await new Promise((r) => api.close(r));
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
