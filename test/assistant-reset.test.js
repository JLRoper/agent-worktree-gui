// The assistant reset, driven directly: no server, no browser, no real gateway.
//
// What this pins, in the brief's order:
//   1. the dry run reports ROW BY ROW what would be cleared — the admission, its run and generation, the card, the
//      evidence, the queued run behind it, the wakes and the watches — and sends no POST;
//   2. `409 assistant_live` while a run is EXECUTING (started/running or a parked control); a queued run does not
//      refuse, because refusing on it would deadlock the reset against the fence it exists to clear;
//   3. `409 fence_unclearable` when every unknown row on the session is unnameable, carrying the admission ids and
//      generations it could not name, and clearing nothing;
//   4. the resolve body is built from a FRESH GET — the card's cached generation is a decoy — and the request is
//      `POST /v1/runs/{run_id}/resolve-unknown` with exactly `{admission_id, execution_generation}`. The reset never
//      calls `/stop` (the measured 409 `unknown_execution` path that leaves the fence standing).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { createResetRoutes } from "../lib/assistant/reset.js";

const PRIMARY = "assistant-1";
const SCHEMA = `
CREATE TABLE session_admissions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  owner_epoch INTEGER,
  generation INTEGER
);`;

function seedDb(file, rows = []) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT INTO session_admissions (admission_id,request_id,principal_id,target_session_id,lineage_json,payload_json,payload_digest,intent,status,outcome,owner_epoch,generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const row of rows) {
    insert.run(
      row.admissionId,
      row.requestId || `run_${row.admissionId}`,
      "panel",
      row.threadId,
      JSON.stringify([row.threadId]),
      JSON.stringify({ text: "seed" }),
      "seed",
      "queue",
      row.status || "unknown",
      row.outcome || null,
      row.ownerEpoch ?? 3,
      row.generation ?? 1,
    );
  }
  db.close();
}

function settleDb(file, admissionId) {
  const db = new DatabaseSync(file);
  db.prepare("UPDATE session_admissions SET status = 'terminal', outcome = 'interrupted' WHERE admission_id = ?").run(admissionId);
  db.close();
}

// A gateway with the two methods the route uses. `runs[runId]` is a function (or an array consumed in order) so a
// test can make the enumeration's GET disagree with the fresh GET before the POST — which is exactly the stale
// generation the design forbids trusting.
function gatewayStub({ runs = {}, resolve = null } = {}) {
  const calls = [];
  const queues = new Map();
  for (const [id, value] of Object.entries(runs)) queues.set(id, Array.isArray(value) ? value.slice() : [value]);
  return {
    calls,
    async getRun(runId) {
      calls.push({ method: "GET", path: `/v1/runs/${runId}` });
      const queue = queues.get(runId) || [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (!next) return { ok: false, status: 404, code: "run_not_found", error: `Run not found: ${runId}` };
      if (next.transport) return { ok: false, status: 0, code: "transport", error: `could not reach the gateway for run ${runId}` };
      return { ok: true, status: 200, run: next };
    },
    async resolveUnknown(runId, body) {
      calls.push({ method: "POST", path: `/v1/runs/${runId}/resolve-unknown`, body });
      if (resolve) return resolve(runId, body);
      return { ok: true, status: 200, receipt: { run_id: runId, status: "terminal", outcome: "interrupted" } };
    },
  };
}

async function board(t, { rows = [], jobs = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-reset-"));
  const dbPath = path.join(dir, "state.db");
  seedDb(dbPath, rows);
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: { list: () => jobs, api: { url: "http://127.0.0.1:1" }, headers: () => ({}) },
    getProjects: () => [],
    getRows: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  const two = assistant.createAssistant({}).created;
  t.after(async () => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, assistant, two };
}

async function callReset({ assistant, id, body = {}, method = "POST", gateway, dbPath }) {
  let answer = null;
  const route = `/api/assistants/${id}/reset`;
  const routes = createResetRoutes({
    assistant,
    config: { token: "panel-token" },
    gateway,
    dbPath,
    sendJson: (_res, status, payload) => {
      answer = { status, body: payload };
    },
    readBody: async () => body,
    authorised: () => true,
  });
  const handled = await routes({ method, url: route, headers: {} }, {}, route, new URL(route, "http://panel"));
  assert.equal(handled, true, "the route claims its own path");
  assert.ok(answer, "the route answered with one JSON body");
  return answer;
}

test("the dry run reports every row and the queued run behind the fence, and sends no POST", async (t) => {
  const now = Date.now();
  const cards = [];
  const { assistant, two, dbPath } = await board(t, {
    rows: [{ admissionId: "adm_1", requestId: "run_1", threadId: "panel-assistant-2", generation: 1 }],
    jobs: cards,
  });
  cards.push(
    {
      id: "card_1",
      thread: two.threadId,
      runId: "run_1",
      status: "interrupted",
      startedAt: "2026-11-04T01:02:11Z",
      executionGeneration: 99,
      unknownAnswers: [
        { at: 1793840401000, http: 200, runStatus: "unknown" },
        { at: 1793840431000, http: 200, runStatus: "unknown" },
      ],
    },
    { id: "card_2", thread: two.threadId, runId: "run_2", status: "queued", startedAt: "2026-11-04T01:10:00Z", unknownAnswers: [] },
  );
  assistant.pendingWake.push({ reason: "watch finished: land the queue fix", rule: "watch", assistantId: two.id, at: now - 6 * 60_000 });
  assistant.pendingWake.push({ reason: "#1's own wake", rule: "watch", assistantId: PRIMARY, at: now });
  assistant.wakeTimer = setTimeout(() => {}, 60_000);
  assistant.addWatch({ thread: two.threadId, title: "its own turn finished", assistantId: two.id });
  assistant.addWatch({ thread: "wtgui-a-worker-1a2b3c", title: "the queue fix is pushed", assistantId: two.id });
  assistant.addWatch({ thread: "wtgui-a-worker-1a2b3c", title: "#1's watch", assistantId: PRIMARY });

  const gateway = gatewayStub({
    runs: {
      run_1: { run_id: "run_1", status: "unknown", admission_id: "adm_1", execution_generation: 1, pending_controls: [] },
      run_2: { run_id: "run_2", status: "queued", admission_id: "adm_2", execution_generation: null, pending_controls: [] },
    },
  });
  const out = await callReset({ assistant, id: two.id, body: { dryRun: true, reason: "test" }, gateway, dbPath });

  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.dryRun, true);
  assert.deepEqual(out.body.assistant, { id: two.id, name: two.name, threadId: two.threadId });
  assert.equal(out.body.verdict, "clearable");
  assert.equal(out.body.stillFenced, true);

  assert.equal(out.body.clear.admissions.length, 1, "one row per admission, not a count");
  const [admission] = out.body.clear.admissions;
  assert.equal(admission.runId, "run_1");
  assert.equal(admission.admissionId, "adm_1");
  assert.equal(admission.executionGeneration, 1, "the dry run names the generation the fresh GET returned");
  assert.equal(admission.action, "resolve-unknown");
  assert.deepEqual(admission.card, { id: "card_1", status: "interrupted", startedAt: "2026-11-04T01:02:11Z" });
  assert.deepEqual(admission.evidence.answers, [
    [1793840401000, "unknown"],
    [1793840431000, "unknown"],
  ]);

  assert.equal(out.body.block.queued.length, 1);
  assert.deepEqual(out.body.block.queued[0], { runId: "run_2", executionGeneration: null, card: "card_2" });
  assert.deepEqual(out.body.block.unnameable, []);

  assert.equal(out.body.clear.wakes.length, 1, "only this assistant's wake");
  assert.equal(out.body.clear.wakes[0].reason, "watch finished: land the queue fix");
  assert.ok(out.body.clear.wakes[0].ageMs >= 6 * 60_000 && out.body.clear.wakes[0].ageMs < 6 * 60_000 + 10_000, "the wake is aged from its enqueue stamp");
  assert.equal(out.body.clear.watches.length, 2, "both of its watches, including the one on a worker's thread");

  assert.equal(out.body.keep.queue.rows, 0);
  assert.equal(typeof out.body.keep.scratchpad.notes, "number");
  assert.equal(typeof out.body.keep.charter.sha, "string");

  assert.deepEqual(gateway.calls.map((c) => c.method), ["GET", "GET"], "a dry run sends no POST");
  assert.equal(assistant.pendingWake.length, 2, "a dry run drops nothing");
  assert.equal(assistant.watches.length, 3, "a dry run drops no watch");
});

test("409 assistant_live names the executing run, and a queued run is not executing", async (t) => {
  const cards = [];
  const { assistant, two, dbPath } = await board(t, {
    rows: [{ admissionId: "adm_1", requestId: "run_1", threadId: "panel-assistant-2", generation: 1 }],
    jobs: cards,
  });
  cards.push(
    { id: "card_1", thread: two.threadId, runId: "run_1", status: "running", startedAt: new Date(Date.now() - 12 * 60_000).toISOString() },
    { id: "card_2", thread: two.threadId, runId: "run_2", status: "queued", startedAt: new Date().toISOString() },
  );
  const gateway = gatewayStub({
    runs: {
      run_1: { run_id: "run_1", status: "started", admission_id: "adm_1", execution_generation: 4, pending_controls: [] },
      run_2: { run_id: "run_2", status: "queued", admission_id: "adm_2", execution_generation: null, pending_controls: [] },
    },
  });
  const out = await callReset({ assistant, id: two.id, body: {}, gateway, dbPath });

  assert.equal(out.status, 409);
  assert.equal(out.body.code, "assistant_live");
  assert.equal(out.body.runId, "run_1");
  assert.match(out.body.error, /still executing/);
  assert.match(out.body.error, /started 12m ago/);
  assert.deepEqual(gateway.calls.map((c) => c.method), ["GET", "GET"], "a refusal mutates nothing");
  assert.equal(assistant.pendingWake.length, 0);
});

test("409 assistant_live also refuses on a parked control, even when the status is not started/running", async (t) => {
  const cards = [];
  const { assistant, two, dbPath } = await board(t, { rows: [], jobs: cards });
  cards.push({ id: "card_1", thread: two.threadId, runId: "run_1", status: "waiting", startedAt: new Date().toISOString() });
  const gateway = gatewayStub({
    runs: { run_1: { run_id: "run_1", status: "running", admission_id: "adm_9", execution_generation: 2, pending_controls: [{ request_id: "ap_1" }] } },
  });
  const out = await callReset({ assistant, id: two.id, body: { dryRun: true }, gateway, dbPath });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "assistant_live");
});

test("409 fence_unclearable when every unknown row is unnameable, and nothing local is touched", async (t) => {
  const { assistant, two, dbPath } = await board(t, {
    rows: [
      { admissionId: "adm_unnameable", requestId: "run_gone", threadId: "panel-assistant-2", generation: 63, ownerEpoch: 18 },
      { admissionId: "adm_unnameable_2", requestId: "run_gone_2", threadId: "panel-assistant-2", generation: 64, ownerEpoch: 18 },
    ],
    jobs: [],
  });
  assistant.pendingWake.push({ reason: "a stale wake", rule: "watch", assistantId: two.id, at: Date.now() - 60_000 });
  assistant.addWatch({ thread: two.threadId, title: "still watching", assistantId: two.id });
  const gateway = gatewayStub({ runs: {} });
  const out = await callReset({ assistant, id: two.id, body: {}, gateway, dbPath });

  assert.equal(out.status, 409);
  assert.equal(out.body.code, "fence_unclearable");
  assert.equal(out.body.thread, "panel-assistant-2");
  assert.equal(out.body.admissions.length, 2);
  assert.equal(out.body.admissions[0].admissionId, "adm_unnameable");
  assert.equal(out.body.admissions[0].generation, 63);
  assert.match(out.body.error, /no card here names/);
  assert.match(out.body.error, /hermes --resume panel-assistant-2/);
  assert.equal(gateway.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(assistant.pendingWake.length, 1, "the wake is kept when the fence cannot be cleared");
  assert.equal(assistant.watches.length, 1, "the watch is kept when the fence cannot be cleared");
});

test("the resolve body is built from a fresh GET, never the card's cache, and the local half runs after the store re-read", async (t) => {
  const cards = [];
  const { assistant, two, dbPath } = await board(t, {
    rows: [{ admissionId: "adm_1", requestId: "run_1", threadId: "panel-assistant-2", generation: 1 }],
    jobs: cards,
  });
  cards.push({
    id: "card_1",
    thread: two.threadId,
    runId: "run_1",
    status: "interrupted",
    startedAt: "2026-11-04T01:02:11Z",
    executionGeneration: 99, // the decoy: a cache that is behind and must not reach the wire
    unknownAnswers: [{ at: 1793840401000, http: 200, runStatus: "unknown" }],
  });
  assistant.queueMutate(two.id, "add", { title: "the reader's ask" }, { by: "reader" });
  assistant.pendingWake.push({ reason: "watch finished: land the queue fix", rule: "watch", assistantId: two.id, at: Date.now() - 6 * 60_000 });
  assistant.pendingWake.push({ reason: "#1's own wake", rule: "watch", assistantId: PRIMARY, at: Date.now() });
  assistant.wakeTimer = setTimeout(() => {}, 60_000);
  assistant.addWatch({ thread: two.threadId, title: "its own turn finished", assistantId: two.id });
  assistant.addWatch({ thread: "wtgui-a-worker-1a2b3c", title: "#1's watch", assistantId: PRIMARY });
  assistant.wakes = [Date.now() - 60_000];
  const sweepLedger = assistant.wakes.slice();
  assistant.terminalWakes.set("thread-1", "key-1");
  assistant.restartWakes.add("restart-1");

  const gateway = gatewayStub({
    runs: {
      run_1: [
        { run_id: "run_1", status: "unknown", admission_id: "adm_1", execution_generation: 1, pending_controls: [] },
        { run_id: "run_1", status: "unknown", admission_id: "adm_1", execution_generation: 3, pending_controls: [] },
      ],
    },
    resolve: async (runId, body) => {
      settleDb(dbPath, body.admission_id);
      return {
        ok: true,
        status: 200,
        receipt: { run_id: runId, admission_id: body.admission_id, status: "terminal", outcome: "interrupted", authority_epoch: 19, execution_generation: body.execution_generation },
      };
    },
  });
  const out = await callReset({ assistant, id: two.id, body: { reason: "reader pressed Reset Assistant #2" }, gateway, dbPath });

  const post = gateway.calls.find((c) => c.method === "POST");
  assert.ok(post, "the reset posts one resolve");
  assert.equal(post.path, "/v1/runs/run_1/resolve-unknown");
  assert.deepEqual(post.body, { admission_id: "adm_1", execution_generation: 3 }, "both ids from the fresh GET, not 99 or 1");
  assert.deepEqual(Object.keys(post.body).sort(), ["admission_id", "execution_generation"], "the body is exactly the two keys");
  assert.equal(gateway.calls.filter((c) => c.path.includes("/stop")).length, 0, "the reset never uses /stop as its acknowledgement");
  assert.equal(gateway.calls.filter((c) => c.method === "GET").length, 2, "one enumeration GET and one fresh GET per candidate");

  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.dryRun, false);
  assert.equal(out.body.verdict, "clean");
  assert.equal(out.body.stillFenced, false);
  assert.equal(out.body.cleared.admissions.length, 1);
  assert.equal(out.body.receipts.length, 1);
  assert.equal(out.body.receipts[0].receipt.outcome, "interrupted");

  assert.equal(out.body.cleared.wakes.length, 1);
  assert.equal(assistant.pendingWake.length, 1, "#1's wake survives");
  assert.equal(assistant.pendingWake[0].assistantId, PRIMARY);
  assert.ok(assistant.wakeTimer, "the shared wake timer stays armed while another assistant has a wake queued");

  assert.equal(out.body.cleared.watches.length, 1);
  assert.equal(assistant.watches.length, 1, "#1's watch survives");
  assert.equal(assistant.watchOwnerOf(assistant.watches[0]), PRIMARY);
  assert.ok(assistant.journal.some((j) => j.kind === "wake-dropped"), "the dropped wake is journalled");
  assert.ok(assistant.journal.some((j) => j.kind === "reset"), "one reset line closes it");

  assert.deepEqual(assistant.wakes, sweepLedger, "the hourly sweep ledger is untouched");
  assert.equal(assistant.terminalWakes.get("thread-1"), "key-1", "the dedupe map is untouched");
  assert.equal(assistant.restartWakes.has("restart-1"), true, "the restart dedupe is untouched");
  assert.equal(assistant.queueView(two.id).tasks.length, 1, "the reader's queue row is kept");
  assert.equal(out.body.kept.queue.rows, 1);
  assert.equal(assistant.forceSweepFor.has(two.id), true, "the next sweep may re-raise a dropped condition even at the cap");
  assistant.wakes = Array.from({ length: 100 }, () => Date.now());
  const afterReset = assistant.wake("a sweep after the reset", null, "quiet", { assistantId: two.id });
  assert.equal(afterReset.queued, true, "the reset's one-shot force outranks the hourly budget");
  assert.equal(afterReset.refused, undefined);
  assert.equal(assistant.forceSweepFor.has(two.id), false, "the force is spent on that one sweep");
  if (assistant.wakeTimer) {
    clearTimeout(assistant.wakeTimer);
    assistant.wakeTimer = null;
  }
});

test("a partly blocked session is not 409: it resolves what it can, re-reads, and leaves the local half alone", async (t) => {
  const cards = [];
  const { assistant, two, dbPath } = await board(t, {
    rows: [
      { admissionId: "adm_named", requestId: "run_1", threadId: "panel-assistant-2", generation: 1 },
      { admissionId: "adm_unnameable", requestId: "run_gone", threadId: "panel-assistant-2", generation: 63 },
    ],
    jobs: cards,
  });
  cards.push({ id: "card_1", thread: two.threadId, runId: "run_1", status: "interrupted", startedAt: "2026-11-04T01:02:11Z" });
  assistant.pendingWake.push({ reason: "a stale wake", rule: "watch", assistantId: two.id, at: Date.now() - 60_000 });
  assistant.addWatch({ thread: two.threadId, title: "still watching", assistantId: two.id });
  const gateway = gatewayStub({
    runs: { run_1: { run_id: "run_1", status: "unknown", admission_id: "adm_named", execution_generation: 3, pending_controls: [] } },
    resolve: async (runId, body) => {
      settleDb(dbPath, body.admission_id);
      return { ok: true, status: 200, receipt: { run_id: runId, status: "terminal", outcome: "interrupted" } };
    },
  });

  const dry = await callReset({ assistant, id: two.id, body: { dryRun: true }, gateway, dbPath });
  assert.equal(dry.status, 200, "one nameable row is not the fence_unclearable refusal");
  assert.equal(dry.body.verdict, "blocked");
  assert.equal(dry.body.clear.admissions.length, 1);
  assert.equal(dry.body.block.unnameable.length, 1);

  const real = await callReset({ assistant, id: two.id, body: {}, gateway, dbPath });
  assert.equal(real.status, 200);
  assert.equal(real.body.ok, false);
  assert.equal(real.body.verdict, "incomplete");
  assert.equal(real.body.stillFenced, true);
  assert.equal(real.body.receipts.length, 1);
  assert.equal(real.body.cleared.wakes.length, 0, "nothing local is cleared while a row is still unknown");
  assert.equal(real.body.cleared.watches.length, 0);
  assert.equal(assistant.pendingWake.length, 1);
  assert.equal(assistant.watches.length, 1);
});

test("the route refuses a non-boolean dryRun, an unknown field, a GET and an id not in the roster", async (t) => {
  const { assistant, two, dbPath } = await board(t, { rows: [], jobs: [] });
  const gateway = gatewayStub({ runs: {} });
  assert.deepEqual(await callReset({ assistant, id: two.id, body: { dryRun: "yes" }, gateway, dbPath }), {
    status: 400,
    body: { ok: false, code: "invalid_params", error: "dryRun must be a boolean" },
  });
  const unknownField = await callReset({ assistant, id: two.id, body: { dryRun: true, confirm: true }, gateway, dbPath });
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body.code, "invalid_params");
  assert.match(unknownField.body.error, /confirm/);
  assert.equal((await callReset({ assistant, id: two.id, method: "GET", gateway, dbPath })).status, 405);
  const missing = await callReset({ assistant, id: "assistant-9", body: { dryRun: true }, gateway, dbPath });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "assistant-unknown");
});
