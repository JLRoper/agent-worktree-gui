// The sandbox both reset gates share: a stub gateway, the panel's job store, and the durable
// `session_admissions` file the reset route reads.
//
// Split out of tools/verify-assistant-reset.mjs when the browser gate needed the same five states: two copies of the
// stub would drift apart, and the thing under test (the route) must be the same one both gates drive.
//
// The stub gateway answers what lib/assistant/reset.js asks of a real one — `GET /v1/runs/{id}` and
// `POST /v1/runs/{id}/resolve-unknown` — plus `POST /v1/runs/{id}/stop`, which the measured gateway answers
// 409 `unknown_execution` and which the reset must never call. A resolve SETTLES the sandbox store only when the
// body names both current ids, exactly as the measured endpoint does, so a body built from a stale cache fails here
// the way it fails there.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startPanel } from "./panel-testkit.mjs";

export const THREAD = "panel-assistant-2";
export const ASSISTANT = "assistant-2";

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

export function seedDb(file, rows = []) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.close();
  insertRows(file, rows);
}

export function insertRows(file, rows = []) {
  const db = new DatabaseSync(file);
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
      row.ownerEpoch ?? 18,
      row.generation ?? 1,
    );
  }
  db.close();
}

export function setRow(file, admissionId, { status = "terminal", outcome = "interrupted" } = {}) {
  const db = new DatabaseSync(file);
  db.prepare("UPDATE session_admissions SET status = ?, outcome = ? WHERE admission_id = ?").run(status, outcome, admissionId);
  db.close();
}

export function unknownRows(file, threadId = THREAD) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT admission_id FROM session_admissions WHERE target_session_id = ? AND status = 'unknown' ORDER BY seq").all(threadId);
  db.close();
  return rows.map((r) => r.admission_id);
}

// ---- the stub gateway ----------------------------------------------------------------------------------
export function makeGateway() {
  const state = {
    runs: {},
    resolveCalls: [],
    stopCalls: [],
    capabilitiesCalls: 0,
    failResolve: new Set(),
    settle: true,
    dbPath: null,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    };
    const runMatch = /^\/v1\/runs\/([^/]+)(\/[a-z-]+)?$/.exec(url.pathname);
    if (url.pathname === "/v1/capabilities") {
      state.capabilitiesCalls += 1;
      return send(200, { version: "stub", features: { run_submission: true, run_events_sse: true } });
    }
    if (!runMatch) return send(404, { error: { code: "not_found", message: "no such route" } });
    const runId = decodeURIComponent(runMatch[1]);
    const action = runMatch[2] || "";
    if (action === "/stop" && req.method === "POST") {
      state.stopCalls.push(runId);
      return send(409, { error: { code: "unknown_execution", message: "unknown_execution" } });
    }
    if (action === "/resolve-unknown" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        state.resolveCalls.push({ runId, body, keys: body && typeof body === "object" ? Object.keys(body).sort() : [] });
        if (state.failResolve.has(runId)) return send(409, { error: { code: "stale_generation", message: "the generation has moved" } });
        const run = state.runs[runId];
        if (!run || String(run.status) !== "unknown") return send(409, { error: { code: "unknown_execution", message: "this run is not unknown" } });
        if (body?.admission_id !== run.admission_id) return send(409, { error: { code: "not_found", message: "the admission does not belong to this run" } });
        if (Number(body?.execution_generation) !== Number(run.execution_generation)) return send(409, { error: { code: "stale_generation", message: "the generation has moved" } });
        if (state.settle && state.dbPath) setRow(state.dbPath, run.admission_id);
        run.status = "cancelled";
        return send(200, {
          run_id: runId,
          admission_id: run.admission_id,
          status: "terminal",
          outcome: "interrupted",
          authority_epoch: 19,
          execution_generation: Number(run.execution_generation),
        });
      });
      return undefined;
    }
    if (req.method === "GET") {
      const run = state.runs[runId];
      if (!run) return send(404, { error: { code: "run_not_found", message: `Run not found: ${runId}` } });
      return send(200, run);
    }
    return send(405, { error: { code: "method_not_allowed", message: "no" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        state,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
        posts: () => state.resolveCalls.length,
      });
    });
  });
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();

// The panel's own job store, written BEFORE the panel boots: three cards on Assistant #2's thread, each with a run the
// stub gateway answers for. Their local status is deliberately NOT `running` — `load()` rewrites those — and the route
// reads the RUN from the gateway anyway.
export function seedJobs(file, { extra = [] } = {}) {
  const cards = [
    { id: "card_1", thread: THREAD, runId: "run_1", status: "interrupted", prompt: "the lost turn", startedAt: ago(6 * 60_000), endedAt: ago(5 * 60_000), lines: [] },
    { id: "card_2", thread: THREAD, runId: "run_2", status: "done", prompt: "a finished turn", startedAt: ago(3 * 60_000), endedAt: ago(2 * 60_000), lines: [] },
    { id: "card_3", thread: THREAD, runId: "run_3", status: "interrupted", prompt: "a second lost turn", startedAt: ago(4 * 60_000), endedAt: ago(3 * 60_000), lines: [] },
    ...extra,
  ];
  writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), jobs: cards }), "utf8");
  return cards;
}

export const RUNS = () => ({
  run_1: { run_id: "run_1", status: "unknown", admission_id: "adm_1", execution_generation: 1, pending_controls: [] },
  run_2: { run_id: "run_2", status: "cancelled", admission_id: "adm_2", execution_generation: 2, pending_controls: [] },
  run_3: { run_id: "run_3", status: "unknown", admission_id: "adm_3", execution_generation: 7, pending_controls: [] },
});

/**
 * Boot the whole sandbox: directories, the job store, the store file, the stub gateway, and the panel pointed at it.
 * `dir` may be supplied by a caller that wants to remove it itself (`keep` is passed through to the panel).
 */
export async function bootResetSandbox({ dir, token = "reset-proof-token", keep = false, rows = null, jobsExtra = [], config = {} } = {}) {
  const sandbox = dir || path.join(process.env.TEMP || process.env.TMPDIR || ".", `wtgui-reset-sandbox-${Date.now()}-${process.pid}`);
  const logs = path.join(sandbox, "logs");
  const home = path.join(sandbox, "hermes");
  mkdirSync(logs, { recursive: true });
  mkdirSync(home, { recursive: true });
  const jobsFile = path.join(logs, "jobs.json");
  const stateDb = path.join(home, "state.db");
  seedJobs(jobsFile, { extra: jobsExtra });
  seedDb(stateDb, rows || [{ admissionId: "adm_1", requestId: "run_1", threadId: THREAD, generation: 1 }]);
  const gateway = await makeGateway();
  gateway.state.dbPath = stateDb;
  gateway.state.runs = RUNS();
  const panel = await startPanel({
    dir: sandbox,
    keep: true,
    token,
    config: { apiServer: { url: gateway.url, key: "stub-key" }, defaultCwd: sandbox, fetchSeconds: -1, ...config },
  });
  return {
    sandbox,
    stateDb,
    jobsFile,
    gateway,
    panel,
    token,
    async stop() {
      const log = panel.log();
      await panel.stop();
      await gateway.close();
      if (!keep) {
        const { rm } = await import("node:fs/promises");
        await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      }
      return log;
    },
  };
}

// Assistant #2 through the panel's own route, so its record, its thread id and the roster are the shipped ones.
export async function createAssistantTwo(panel, token) {
  const { post } = await import("./panel-testkit.mjs");
  const created = await post(panel.base, "/api/assistant/assistants", { token, body: {} });
  return { response: created, rec: (created.json?.assistant?.assistants || []).find((a) => a.id === ASSISTANT) || null };
}
