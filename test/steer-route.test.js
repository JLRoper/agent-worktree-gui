// POST /api/jobs/steer, and the guard under it — the two answers that decide whether a typed instruction is
// steered or refused, proved over real HTTP against the real server and against the store directly.
//
// The browser half (press Steer turn, read the card) is tools/verify-steer-turn.mjs; this file is about the
// contract the page talks to:
//
//   200  the gateway took the steer — `{ok: true, accepted: true, runId}` from one recorded POST /v1/runs/<id>/steer
//   409  the run exists and will not take one RIGHT NOW: the gateway's 409 (with or without a code on it), or a run
//        the panel already knows is parked on an approval — and that last one costs the gateway no request at all
//   400  a request the route cannot act on: no such card, no text, a card that is not running
//
// `jobs.steer`'s status guard is driven directly in the second test (a `new Jobs()` over a temp store), because the
// statuses it must refuse are cheaper to arrange there than through a panel.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { post, startPanel, waitFor } from "../tools/panel-testkit.mjs";

// `run_guard` is deliberately NOT here: the stub 404s it, which is how one seeded card is left interrupted (the
// card a steer must refuse on its status alone).
const RUNS = ["run_accept", "run_refuse", "run_refuse_plain", "run_parked", "run_stale"];

// A Runs API that records every steer it is sent and refuses the ones the table says it refuses.
function makeStub() {
  const steers = [];
  const refusals = new Map([
    ["run_refuse", { status: 409, body: { error: { message: "Run is not currently accepting steer input", code: "run_not_accepting_steer" } } }],
    ["run_refuse_plain", { status: 409, body: { error: { message: "Run is not currently accepting steer input" } } }],
  ]);
  const json = (res, code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, { version: "steer-route-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true } });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: { message: "not found", code: "not_found" } });
    const runId = decodeURIComponent(m[1]);
    const sub = m[2] || "";
    if (!RUNS.includes(runId)) return json(res, 404, { error: { message: "Run not found", code: "run_not_found" } });
    if (sub === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": attached\n\n");
      const timer = setInterval(() => res.write(": hold\n\n"), 1500);
      req.on("close", () => clearInterval(timer));
      return undefined;
    }
    if (sub === "/steer" && req.method === "POST") {
      const body = await readBody(req);
      steers.push({ runId, body });
      const no = refusals.get(runId);
      if (no) return json(res, no.status, no.body);
      return json(res, 200, { object: "hermes.run.steer", run_id: runId, accepted: true });
    }
    if (!sub) return json(res, 200, { object: "hermes.run", run_id: runId, status: "running", execution_generation: 1 });
    return json(res, 404, { error: { message: "not found", code: "not_found" } });
  });
  return { steers, server, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const card = (id, runId, over = {}) => ({
  id,
  thread: `wtgui-steer-${id}`,
  turn: 1,
  prompt: `the turn behind ${id}`,
  cwd: null,
  sessionId: `wtgui-steer-${id}`,
  status: "running",
  exitCode: null,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endedAt: null,
  runId,
  worktree: false,
  existing: false,
  lines: [{ kind: "tool", lid: 1, at: Date.now() - 30_000, text: "💻 terminal · a long one" }],
  ...over,
});

test("POST /api/jobs/steer maps 200 / 409 / 400 the way the card reads them", async (t) => {
  const stub = makeStub();
  await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-steer-route-"));
  const logs = path.join(dir, "logs");
  await mkdir(logs, { recursive: true });
  const jobsFile = path.join(logs, "jobs.json");
  await writeFile(
    jobsFile,
    JSON.stringify({
      savedAt: new Date().toISOString(),
      jobs: [
        card("accept", "run_accept"),
        card("refuse", "run_refuse"),
        card("refuse-plain", "run_refuse_plain"),
        card("parked", "run_parked", {
          approval: {
            command: "chmod 777 probe.txt",
            choices: ["once", "deny"],
            timeoutSeconds: 600,
            at: new Date().toISOString(),
            deadline: Date.now() + 600_000,
          },
        }),
        card("idle", "run_guard", { status: "interrupted", endedAt: new Date().toISOString(), error: "the panel restarted while this was running" }),
      ],
    }),
    "utf8",
  );
  const panel = await startPanel({
    dir,
    config: { jobsFile, apiServer: { url: stubUrl, key: "sandbox-key" }, assistant: { enabled: false } },
  });
  t.after(async () => {
    await panel.stop();
    await stub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  });

  // The gateway still holds every seeded run, so the panel re-attaches them at boot and the cards read `running`.
  // Wait for that: a steer posted against a card the boot reconcile has not reached yet is refused by the status
  // guard, which is a different (correct) answer and would make this test lie about the mapping.
  const cardFor = async (id) => (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs.find((j) => j.id === id);
  const attached = await waitFor(async () => (await cardFor("accept"))?.status === "running" && (await cardFor("parked"))?.status === "running", {
    timeoutMs: 20_000,
    what: "the seeded cards to re-attach to the stub's runs",
  });
  assert.ok(attached, "the seeded cards re-attached");
  assert.equal((await cardFor("idle"))?.status, "interrupted", "the card whose run the gateway has lost stays interrupted");

  const steer = (id, text) => post(panel.base, "/api/jobs/steer", { body: { id, text } });

  // ---- 200: the steer is taken, and it is the gateway's own POST that carries it --------------------
  const accepted = await steer("accept", "into the live turn");
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.ok, true);
  assert.equal(accepted.json.accepted, true);
  assert.equal(accepted.json.runId, "run_accept");
  assert.equal(stub.steers.filter((s) => s.runId === "run_accept").length, 1, "one POST /v1/runs/run_accept/steer");
  assert.equal(stub.steers.find((s) => s.runId === "run_accept").body.input, "into the live turn", "carrying the typed text");

  // ---- 409: the gateway refuses a run that will not take a steer ------------------------------------
  const refused = await steer("refuse", "too late");
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, "run_not_accepting_steer");
  assert.equal(refused.json.runId, undefined);
  assert.match(refused.json.error, /not currently accepting steer input/);

  // A gateway 409 with no code on it is still a refusal, not a malformed request.
  const refusedPlain = await steer("refuse-plain", "too late as well");
  assert.equal(refusedPlain.status, 409, refusedPlain.text);
  assert.equal(refusedPlain.json.code, null);
  assert.equal(stub.steers.filter((s) => s.runId === "run_refuse_plain").length, 1);

  // ---- 409: a run parked on an approval, refused by the PANEL, with no request to the gateway --------
  const parked = await steer("parked", "answer the approval first");
  assert.equal(parked.status, 409, parked.text);
  assert.equal(parked.json.ok, false);
  assert.equal(parked.json.code, "run_parked_on_approval");
  assert.match(parked.json.error, /parked on an approval/);
  assert.equal(stub.steers.filter((s) => s.runId === "run_parked").length, 0, "the parked refusal costs the gateway no request");

  // ---- 400: requests the route cannot act on at all -------------------------------------------------
  const unknown = await steer("nope", "hello");
  assert.equal(unknown.status, 400, unknown.text);
  assert.equal(unknown.json.ok, false);
  assert.equal(unknown.json.error, "unknown job");

  const empty = await steer("accept", "   ");
  assert.equal(empty.status, 400, empty.text);
  assert.equal(empty.json.error, "steer text is required");

  const idle = await steer("idle", "carry on");
  assert.equal(idle.status, 400, idle.text);
  assert.equal(idle.json.error, "run is not running (interrupted)");

  // Nothing above quietly turned into a second steer for the run that accepted one.
  assert.equal(stub.steers.filter((s) => s.runId === "run_accept").length, 1);
});

test("jobs.steer's status guard refuses every status that is not a running run", async (t) => {
  const stub = makeStub();
  await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-steer-guard-"));
  t.after(async () => {
    await stub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  });
  const store = new Jobs({
    config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: `http://127.0.0.1:${stub.server.address().port}`, key: "sandbox-key" } },
  });
  const seed = (over) => store.jobs.set(over.id, { lines: [], thread: `wtgui-${over.id}`, turn: 1, ...over });

  seed({ id: "g-done", status: "done", runId: "run_guard", exitCode: 0 });
  seed({ id: "g-starting", status: "starting", runId: "run_guard" });
  seed({ id: "g-no-run", status: "running", runId: null });
  seed({ id: "g-running", status: "running", runId: "run_accept" });
  seed({
    id: "g-parked",
    status: "running",
    runId: "run_parked",
    approval: { command: "chmod 777 probe.txt", choices: ["once", "deny"], deadline: Date.now() + 600_000, at: new Date().toISOString() },
  });
  seed({
    id: "g-stale",
    status: "running",
    runId: "run_stale",
    // The window the gateway gave this approval has already closed: the card has not been swept yet, but the run is
    // moving again, so this record must not refuse a steer the gateway would take.
    approval: { command: "chmod 777 probe.txt", choices: ["once", "deny"], deadline: Date.now() - 1_000, at: new Date().toISOString() },
  });

  assert.deepEqual(await store.steer("nobody", "hello"), { ok: false, error: "unknown job" });
  assert.deepEqual(await store.steer("g-done", "  "), { ok: false, error: "steer text is required" });
  assert.deepEqual(await store.steer("g-done", "carry on"), { ok: false, error: "run is not running (done)" });
  assert.deepEqual(await store.steer("g-starting", "carry on"), { ok: false, error: "run is not running (starting)" });
  assert.deepEqual(await store.steer("g-no-run", "carry on"), { ok: false, error: "run is not running (running)" });

  const parked = await store.steer("g-parked", "carry on");
  assert.equal(parked.ok, false);
  assert.equal(parked.code, "run_parked_on_approval");
  assert.match(parked.error, /parked on an approval/);
  assert.equal(stub.steers.filter((s) => s.runId === "run_parked").length, 0, "no request while the run is held");

  // A running run with no approval on it is the one status that goes out — and the stale approval above rides with it.
  const live = await store.steer("g-running", "keep going");
  assert.equal(live.ok, true);
  assert.equal(live.runId, "run_accept");
  assert.equal(stub.steers.filter((s) => s.runId === "run_accept").length, 1);
  assert.equal(stub.steers.find((s) => s.runId === "run_accept").body.input, "keep going");

  const stale = await store.steer("g-stale", "the window closed, the run did not");
  assert.equal(stale.ok, true, JSON.stringify(stale));
  assert.equal(stub.steers.filter((s) => s.runId === "run_stale").length, 1);
});
