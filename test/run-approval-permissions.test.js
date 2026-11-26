// A RUN's own approval in the permission history: the record, the header's count, the answer and the expiry.
//
// The defect this pins (measured 2026-11-26): a live approval card on a run - "waiting on you - this turn is parked
// until you answer: write to CLAUDE.md, Allow once / Deny, -6m left" - beside a Permissions popup reading "No
// permission request has reached this panel yet" and GET /api/permissions/history answering `total 0`. The card is
// drawn from the JOB's mirrored approval (lib/jobs.js `j.approval`, from the run's `approval.request`), while the
// popup and the button read the CLI approval TRANSPORT (lib/approvals.js), which never saw the request. One record
// for every approval the panel shows is the fix, and these are its five claims:
//
//   1. a job-mirrored approval yields a history entry AND a non-zero count, with the transport queue EMPTY;
//   2. the same request replayed (the stream re-delivers `approval.request` on every reconnect) is ONE record;
//   3. answering it settles the record with the choice a person pressed, through `jobs.approve`;
//   4. an expiry settles it as EXPIRED, never as a `deny` nobody pressed;
//   5. a restart keeps the record, and a reopened store reads it rather than re-deriving it.
//
// A sixth case covers the other door the fix names: a run that REPORTS `waiting_for_approval` in its own status,
// with the event never having reached this panel (a dropped stream, a restart that re-attached the run without its
// park), has its box and its record rebuilt from `pending_controls`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { PermissionsHistory } from "../lib/permissions-history.js";
import { createRunApprovalBridge, placeOfJob } from "../lib/run-permissions.js";
import { PERMISSIONS_HISTORY_PATH, createPermissionsHistoryRoutes } from "../routes/permissions-history.js";

const TREE = "/repo/agent-worktree-gui/.worktrees/am-approval";
const RUN = "run_5a1c0ffee";

// A gateway whose answers this test decides: the run document (which carries the pending control and the
// generation an answer must echo) and the approval POST.
function installGateway({ run = {} } = {}) {
  const calls = [];
  const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = String(opts.method || "GET").toUpperCase();
    calls.push({ method, path: u.pathname, body: opts.body ? JSON.parse(String(opts.body)) : null });
    if (u.pathname === `/v1/runs/${RUN}/approval` && method === "POST") {
      return answer(200, { status: "resolved", resolved: "resolved" });
    }
    if (u.pathname === `/v1/runs/${RUN}`) {
      return answer(
        200,
        {
          run_id: RUN,
          status: "running",
          execution_generation: 3,
          pending_controls: [{ kind: "approval", prompt_id: "prompt-A", command: "git push --force origin main" }],
          ...run,
        },
      );
    }
    return answer(404, { error: { code: "not_found", message: `unexpected ${u.pathname}` } });
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

// The panel's own half, as server.js wires it: the durable store, a run store, the bridge between them, and the
// route the header's popup reads. `transport` is deliberately an EMPTY queue: nothing in these cases is ever
// presented to the CLI transport, which is exactly the defect's shape.
async function panel(t, { run = {}, transport = [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-run-permissions-"));
  const gw = installGateway({ run });
  const file = path.join(dir, "permissions-history.json");
  const permissions = new PermissionsHistory({ file });
  const jobs = new Jobs({
    config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: "http://gateway.test", key: "k" }, defaultCwd: dir },
    onEvent: () => {},
    onLog: () => {},
  });
  const bridge = createRunApprovalBridge({ jobs, permissions });
  jobs.onApproval = (evt) => bridge.onApproval(evt);
  const seen = { status: 0, body: null };
  const routes = createPermissionsHistoryRoutes({
    approvals: { list: () => transport },
    runApprovals: () => bridge.live(),
    permissions,
    describe: () => ({}),
    sendJson: (res, status, body) => {
      res.status = status;
      res.body = body;
    },
  });
  // The popup's one read. Returns the body the page would receive.
  const read = async (query = "") => {
    const req = { method: "GET", url: `${PERMISSIONS_HISTORY_PATH}${query}` };
    const res = { status: 0, body: null };
    const handled = await routes(req, res, PERMISSIONS_HISTORY_PATH, new URL(req.url, "http://127.0.0.1"));
    assert.equal(handled, true, "the read is mounted");
    assert.equal(res.status, 200, `the read answered ${res.status}`);
    return res.body;
  };
  t.after(async () => {
    gw.restore();
    clearInterval(jobs.approvalSweep);
    clearInterval(jobs.approvalReconcile);
    clearInterval(jobs.titleSweep);
    clearTimeout(jobs.persistTimer);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, file, permissions, jobs, bridge, gw, read, seen };
}

// One fabricated job, the same shape the board carries: a live run in a tree, no approval yet.
function seedJob(jobs, over = {}) {
  const j = {
    id: "job-1",
    thread: "wtgui-am-approval",
    runId: RUN,
    status: "running",
    turn: 1,
    cwd: TREE,
    worktreePath: TREE,
    projectPath: "/repo/agent-worktree-gui",
    branch: "wtgui/approvals-are-not-showing-up",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    error: "",
    lines: [],
    ...over,
  };
  jobs.jobs.set(j.id, j);
  return j;
}

// The run's own event, as the gateway publishes it. `timestamp` is seconds, and it is what a replay repeats.
const request = (jobs, j, { command = "git push --force origin main", at = Date.now() / 1000, timeout = 600 } = {}) =>
  jobs.consume(j, { event: "approval.request", command, choices: ["once", "deny"], timeout_seconds: timeout, timestamp: at });

// ---- 1. the record and the count, with no transport event ---------------------------------------------------------
test("a job-mirrored approval is a history entry and a non-zero count, though the transport queue is empty", async (t) => {
  const p = await panel(t);
  const j = seedJob(p.jobs);
  assert.equal(p.permissions.count(), 0, "the store starts empty: nothing has ever been presented to the transport");

  request(p.jobs, j);

  // The store: one open record, with the request's own text and the run it belongs to.
  const rows = p.permissions.list();
  assert.equal(rows.total, 1, "the run's approval wrote ONE record");
  const row = rows.entries[0];
  assert.equal(row.status, "open");
  assert.equal(row.command, "git push --force origin main");
  assert.equal(row.jobId, "job-1");
  assert.equal(row.runId, RUN);
  assert.equal(row.thread, "wtgui-am-approval");
  assert.equal(row.tree, "wtgui/approvals-are-not-showing-up");
  assert.equal(row.treePath, TREE);
  assert.deepEqual(row.choices, ["once", "deny"]);
  assert.equal(row.key, "run:" + RUN + ":" + Date.parse(row.askedAt), "no prompt id: the key is the run and the instant the gateway started waiting");

  // The read the header's button and the popup use, over the SAME empty transport queue.
  const body = await p.read();
  assert.equal(body.outstanding, 1, "the button's count includes the run's approval");
  assert.equal(body.total, 1);
  assert.equal(body.pending.length, 1, "and the popup may answer it");
  assert.equal(body.pending[0].id, row.key);
  assert.equal(body.pending[0].jobId, "job-1");
  assert.deepEqual(body.pending[0].choices, ["once", "deny"]);
  assert.equal(body.pending[0].surface, "gateway run");
});

// ---- 2. one record for one request, replayed ---------------------------------------------------------------
test("a replayed approval.request is one record, not two", async (t) => {
  const p = await panel(t);
  const j = seedJob(p.jobs);
  const at = Date.now() / 1000;

  request(p.jobs, j, { at });
  const first = p.permissions.list().entries[0];
  // The stream re-delivers the request on a reconnect: same event, same gateway timestamp.
  request(p.jobs, j, { at });
  request(p.jobs, j, { at });

  const rows = p.permissions.list();
  assert.equal(rows.total, 1, "a replay of one request is still one record");
  assert.equal(rows.entries[0].key, first.key, "and the id it is known by does not move");
  assert.equal(rows.entries[0].seq, first.seq);
  const body = await p.read();
  assert.equal(body.outstanding, 1, "the button counts the request once");
  assert.equal(body.pending.length, 1);
});

// ---- 3. answering settles the record -------------------------------------------------------------------------
test("answering from the run settles the record with the choice a person pressed", async (t) => {
  const p = await panel(t);
  const j = seedJob(p.jobs);
  request(p.jobs, j);
  const key = p.permissions.list().entries[0].key;

  const out = await p.jobs.approve("job-1", "once", null);
  assert.equal(out.ok, true, `the gateway took the answer (${out.error || ""})`);
  // The answer went to the run, carrying the prompt id the panel resolved from pending_controls.
  const post = p.gw.calls.find((c) => c.method === "POST" && c.path === `/v1/runs/${RUN}/approval`);
  assert.ok(post, "the answer was posted to the run's own approval route");
  assert.equal(post.body.choice, "once");
  assert.equal(post.body.request_id, "prompt-A");

  const row = p.permissions.find(key);
  assert.equal(row.status, "answered", "the record says a person answered");
  assert.equal(row.choice, "once");
  assert.equal(row.answeredBy, "reader");
  assert.equal(row.closedWhy, "", "an answer is not an expiry");

  const body = await p.read();
  assert.equal(body.outstanding, 0, "nothing is waiting any more");
  assert.equal(body.pending.length, 0);
  assert.equal(body.entries[0].status, "answered");
});

// ---- 3b. the popup's press is the same answer the board's box sends -------------------------------------------
test("the popup's press on a run approval reaches the run, and an id the transport owns is left to it", async (t) => {
  const p = await panel(t);
  const j = seedJob(p.jobs);
  request(p.jobs, j);
  const key = p.permissions.list().entries[0].key;
  const pending = (await p.read()).pending[0];
  assert.equal(pending.id, key, "the row the popup draws is the record the store holds");

  const out = await p.bridge.answer(pending.id, "deny");
  assert.equal(out?.ok, true, `the gateway took the press (${out?.error || ""})`);
  assert.equal(out.runApproval, true);
  const post = p.gw.calls.find((c) => c.method === "POST" && c.path === `/v1/runs/${RUN}/approval`);
  assert.equal(post.body.choice, "deny", "the popup's choice is the answer the run receives");
  const row = p.permissions.find(key);
  assert.equal(row.status, "answered");
  assert.equal(row.choice, "deny");
  assert.equal((await p.read()).outstanding, 0);

  // Not a run approval: the bridge says so plainly and the caller falls through to the transport's own route.
  assert.equal(await p.bridge.answer("host-request-1", "once"), null);
});

// ---- 3c. a press after the window closed is an expiry, not the choice that was pressed --------------------------
test("a press after the window closed settles it as expired, not as the choice that was pressed", async (t) => {
  const p = await panel(t);
  const j = seedJob(p.jobs);
  request(p.jobs, j, { timeout: 10 });
  const key = p.permissions.list().entries[0].key;
  // The box is still drawn, and the gateway's window has closed since (the page can be a repaint behind).
  j.approval.deadline = Date.now() - 1;

  const out = await p.bridge.answer(key, "once");
  assert.equal(out.ok, false);
  assert.equal(out.gone, true);
  assert.match(out.error, /window for this approval had already closed/);
  assert.equal(p.gw.calls.filter((c) => c.method === "POST").length, 0, "nothing was sent to the gateway");
  const row = p.permissions.find(key);
  assert.equal(row.status, "expired", "the record says the window closed");
  assert.equal(row.choice, "", "and never claims the reader's press was honoured");
  assert.equal(row.answeredBy, "");
});

// ---- 4. an expiry reads expired, never a deny nobody pressed -------------------------------------------------
test("an expiry settles the record as expired, never as a deny nobody pressed", async (t) => {
  const p = await panel(t);
  const j = seedJob(p.jobs);
  request(p.jobs, j, { timeout: 10 });
  const key = p.permissions.list().entries[0].key;
  const deadline = Number(j.approval.deadline);

  // The gateway's window closes: the panel's own sweep is what notices.
  assert.equal(p.jobs.sweepApprovals(deadline + 1), 1, "the sweep took the card away");

  const row = p.permissions.find(key);
  assert.equal(row.status, "expired");
  assert.equal(row.choice, "", "nobody pressed anything");
  assert.equal(row.answeredBy, "");
  assert.equal(row.closedWhy, "timed out");
  assert.equal(row.closedAt, new Date(deadline).toISOString(), "stamped at the deadline, not at the sweep that noticed");
  assert.notEqual(row.choice, "deny", "the gateway's fail-closed deny is not a choice this panel may invent");

  const body = await p.read();
  assert.equal(body.outstanding, 0);
  assert.equal(body.entries[0].status, "expired");
});

// ---- 5. a restart keeps it ----------------------------------------------------------------------------------
test("a restart keeps the record, and the reopened store reads it instead of re-deriving it", async (t) => {
  const p = await panel(t);
  const j = seedJob(p.jobs);
  request(p.jobs, j);
  const key = p.permissions.list().entries[0].key;
  const command = p.permissions.find(key).command;

  // The new process: the same file, no memory of the request.
  const reopened = new PermissionsHistory({ file: p.file });
  const rows = reopened.list();
  assert.equal(rows.total, 1, "the record survived the restart");
  assert.equal(rows.entries[0].key, key);
  assert.equal(rows.entries[0].command, command);
  assert.equal(rows.entries[0].status, "open", "the file is re-read as it was written");

  // ...and a restarted panel holds no live approval, so the popup's read must settle it as expired rather than leave
  // it looking answerable - and must not turn it into a decision.
  const seen = { status: 0, body: null };
  const routes = createPermissionsHistoryRoutes({
    approvals: { list: () => [] },
    runApprovals: () => [],
    permissions: reopened,
    describe: () => ({}),
    sendJson: (res, status, body) => {
      res.status = status;
      res.body = body;
    },
  });
  const req = { method: "GET", url: PERMISSIONS_HISTORY_PATH };
  await routes(req, seen, PERMISSIONS_HISTORY_PATH, new URL(PERMISSIONS_HISTORY_PATH, "http://127.0.0.1"));
  assert.equal(seen.body.outstanding, 0, "the restarted panel cannot answer it");
  const settled = reopened.find(key);
  assert.equal(settled.status, "expired");
  assert.equal(settled.choice, "");
  assert.equal(settled.closedWhy, "the gateway no longer holds it");
});

// ---- 6. the other door: the run reports waiting_for_approval ---------------------------------------------------
test("a run that reports waiting_for_approval without an event rebuilds the box and the record from pending_controls", async (t) => {
  const p = await panel(t, {
    run: {
      status: "waiting_for_approval",
      pending_controls: [{ kind: "approval", prompt_id: "prompt-B", command: "rm -rf build" }],
    },
  });
  const j = seedJob(p.jobs);
  assert.ok(!j.approval, "the event never reached this panel");

  await p.jobs.poll(j);

  assert.ok(j.approval, "the run's own pending control is the park, so the card is rebuilt");
  assert.equal(j.approval.requestId, "prompt-B");
  assert.match(j.approval.command, /rm -rf build/);
  const rows = p.permissions.list();
  assert.equal(rows.total, 1, "and the record hears about it through the same door the event uses");
  assert.equal(rows.entries[0].key, "prompt-B");
  assert.equal(rows.entries[0].status, "open");
  const body = await p.read();
  assert.equal(body.outstanding, 1);

  // A second status read is not a second record.
  await p.jobs.poll(j);
  assert.equal(p.permissions.list().total, 1, "the rebuilt park is a park, not a new request every 15 s");
});

// ---- the placement, on its own: one shape for both feeds ------------------------------------------------------
test("placeOfJob reads the job's own record, and an unknown thread invents nothing", () => {
  const place = placeOfJob({
    id: "job-9",
    runId: "run-9",
    thread: "t-9",
    label: "the renamed session",
    branch: "wtgui/b",
    worktreePath: "/x/.worktrees/b/",
    projectPath: "/x",
    assistantId: "assistant-3",
  });
  assert.deepEqual(place, {
    jobId: "job-9",
    runId: "run-9",
    thread: "t-9",
    agent: "the renamed session",
    tree: "wtgui/b",
    treePath: "/x/.worktrees/b",
    project: "x",
    assistantId: "assistant-3",
  });
  // A job the board cannot place still names its thread and nothing it did not measure.
  const bare = placeOfJob({ id: "job-1", thread: "t-1", status: "running" });
  assert.equal(bare.treePath, "");
  assert.equal(bare.project, "");
  assert.equal(bare.agent, "t-1");
  assert.equal(bare.assistantId, null);
});
