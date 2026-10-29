// The two lies this panel told for sixteen hours, and the tests that keep them told.
//
//   node --test test/restart-stop.test.js
//
// BUG 1 — a gateway that was never restarted reported as freshly restarted.
//   `hermes gateway restart` is a service-manager verb. The board's gateway is a foreground `gateway run`
//   process, so the command exits 0 having done nothing, and the proof turn then passes because the gateway
//   answering it is the one that was already there. A restart is now accepted only when the pid the gateway
//   reports is not the pid it reported before; when it does not move, the panel stops the recorded pid and
//   starts the recorded argv itself, and if the pid still does not move the verdict is a FAILURE whose reason
//   is "the gateway process never changed".
//
// BUG 2 — a run the panel marked interrupted kept running in the gateway.
//   Editing this store is not stopping a run. Nine abandoned turns once held every concurrency slot with their
//   session_turn_leases never released. So every interrupt path POSTs /v1/runs/<id>/stop, tolerating 404 and
//   409 as "already gone", journalling each attempt and its answer, and the boot path does the same for a run
//   issued to an earlier gateway identity.
//
// WHAT IS DRIVEN: the real RestartController and the real Jobs store, against a stub Runs API on an ephemeral
// port (runs, status, an SSE stream held open, and a /stop whose answer each test chooses). The pid is a stub
// function, so no test restarts — or kills — anything.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { Jobs } from "../lib/jobs.js";
import { NEVER_CHANGED_REASON, RestartController, gatewayLaunchPlan } from "../lib/restart.js";

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-restart-stop-"));
const home = path.join(dir, "hermes-home");
const work = path.join(dir, "work");
for (const d of [home, work]) mkdirSync(d, { recursive: true });
// Every read of the gateway's record goes through HERMES_HOME. Point it at the sandbox so no test can see the
// developer's own gateway_state.json (or the state.db behind it).
process.env.HERMES_HOME = home;
writeFileSync(path.join(home, ".env"), "OPENROUTER_API_KEY=test-key\n", "utf8");
writeFileSync(path.join(home, "gateway_state.json"), JSON.stringify({
  pid: 111,
  kind: "hermes-gateway",
  // The shape this machine really records: …/hermes-agent/hermes_cli/main.py gateway run --quiet
  argv: ["C:\\hermes-agent\\hermes_cli\\main.py", "gateway", "run", "--quiet"],
  start_time: 1110,
  gateway_state: "running",
}), "utf8");

let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a stub Runs API ----------------------------------------------------------------------------
// What lib/jobs.js and lib/restart.js ask of a real gateway: capabilities, a submitted run, its status, its
// event stream, and the stop. `stopStatus` is a number (every stop gets it) or a function of the run id.
function makeGateway() {
  const state = { stops: [], stopStatus: 200, runs: new Map(), seq: 0, stopAnswers: [] };
  const json = (res, code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, { version: "restart-stop-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      state.seq += 1;
      const id = `run_${state.seq}`;
      state.runs.set(id, { run_id: id, status: "running", output: "" });
      return json(res, 200, { run_id: id, status: "running" });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const timer = setInterval(() => res.write(": held\n\n"), 400);
        req.on("close", () => clearInterval(timer));
        return;
      }
      if (sub === "/stop") {
        const code = typeof state.stopStatus === "function" ? state.stopStatus(id) : state.stopStatus;
        state.stops.push(id);
        state.stopAnswers.push(code);
        return json(res, code, code === 200 ? { stopped: true } : { error: { code: code === 404 ? "run_not_found" : "run_not_stopping", message: `HTTP ${code}` } });
      }
      const run = state.runs.get(id);
      if (!run) return json(res, 404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(res, 200, run);
    }
    json(res, 404, { error: { message: "not found" } });
  });
  return {
    state,
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---- the controller with no jobs to interrupt ---------------------------------------------------
const emptyJobs = () => ({
  list: () => [],
  runningJobs: () => [],
  runProbe: async () => ({ known: false, reachable: true, status: 404 }),
  markInterruptedByRestart: () => false,
  measureTree: async () => {},
  stopInterruptedRuns: async () => [],
});

function makeController(over = {}) {
  return new RestartController({
    config: { restartFile: path.join(dir, `restart-${++seq}.json`), gatewayRestartLog: path.join(dir, `gateway-restart-${seq}.log`) },
    jobs: emptyJobs(),
    home,
    log: () => {},
    credentials: () => null,
    identityWaitMs: 120,
    identityPollMs: 5,
    pollMs: 5,
    ...over,
  });
}

// Ask for a gateway restart and wait for its verdict, the way the route would.
async function restartAndWait(controller) {
  assert.equal(controller.request({ target: "gateway", reason: "the test asks", waitFor: "no-thread" }).accepted, true);
  const until = Date.now() + 30_000;
  for (;;) {
    const s = controller.state();
    if (!s.running && s.last) return s.last;
    if (Date.now() > until) throw new Error(`the restart never finished: ${JSON.stringify(s)}`);
    await sleep(20);
  }
}

// A real Jobs store against the stub, with its timers taken down when the test ends.
async function makeJobs(t, { jobsFile = path.join(dir, `jobs-${++seq}.json`) } = {}) {
  const gw = makeGateway();
  const url = await gw.listen();
  const jobs = new Jobs({ config: { jobsFile, defaultCwd: work, assistantCwd: path.join(dir, "assistant"), apiServer: { url, key: "test-key" } }, onLog: () => {} });
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
    await gw.close();
  });
  return { jobs, gw, url };
}

// ---- the plan the fallback launches -------------------------------------------------------------
test("the fallback starts the recorded argv as `python -m hermes_cli.main …`, from the checkout it came from", () => {
  const plan = gatewayLaunchPlan({ argv: ["C:\\hermes-agent\\hermes_cli\\main.py", "gateway", "run", "--quiet"] }, home);
  assert.deepEqual(plan.args, ["-m", "hermes_cli.main", "gateway", "run", "--quiet"]);
  assert.equal(plan.root, "C:\\hermes-agent", "the checkout is what -m hermes_cli.main needs on PYTHONPATH");
  // The module form is already what this asks for, and must not be doubled.
  assert.deepEqual(gatewayLaunchPlan({ argv: ["python", "-m", "hermes_cli.main", "gateway", "run"] }, home).args, ["-m", "hermes_cli.main", "gateway", "run"]);
  // Nothing after the executable is nothing to start.
  assert.deepEqual(gatewayLaunchPlan({ argv: ["python"] }, home).args, []);
});

// ---- BUG 1 --------------------------------------------------------------------------------------
test("a pid that never changes is a FAILURE, and it triggers the stop-and-start fallback", async () => {
  const stopped = [];
  const spawned = [];
  let proofs = 0;
  const restarted = [];
  const logPath = path.join(dir, "gateway-restart-never-changed.log");
  const controller = makeController({
    config: { restartFile: path.join(dir, "restart-never-changed.json"), gatewayRestartLog: logPath },
    identity: () => ({ pid: 111, startTime: 1110, state: "running" }),
    runGatewayRestart: () => {
      restarted.push("hermes gateway restart");
      return { command: "hermes gateway restart", pid: 9, at: new Date().toISOString() };
    },
    stopProcess: async (pid) => {
      stopped.push(pid);
      return { ok: true, forced: false };
    },
    spawnGateway: async (plan) => {
      spawned.push(plan);
      return { pid: 4242, command: plan.command };
    },
    proveGateway: () => {
      proofs += 1;
      return { ok: true, stage: "turn", runId: "run_proof", status: "completed", output: "PANEL-RESTART-OK", ms: 5 };
    },
  });
  const last = await restartAndWait(controller);
  assert.deepEqual(restarted, ["hermes gateway restart"], "the service-manager command is still the FIRST attempt");
  assert.deepEqual(stopped, [111], "the pid the gateway recorded is the one the fallback stopped");
  assert.equal(spawned.length, 1, "the fallback started the gateway again");
  assert.deepEqual(spawned[0].args, ["-m", "hermes_cli.main", "gateway", "run", "--quiet"]);
  assert.equal(proofs, 0, "a gateway that never changed is not proved with a turn — that turn would pass and prove nothing");
  assert.equal(last.state, "failed");
  assert.equal(last.proof.ok, false);
  assert.equal(last.proof.reason, NEVER_CHANGED_REASON);
  assert.match(readFileSync(logPath, "utf8"), /the gateway process never changed/, "the restart log says it, where a reader goes to look");
});

test("a pid that changed, plus a turn through the new process, is the only success", async () => {
  let pid = 111;
  const controller = makeController({
    identity: () => ({ pid, startTime: pid * 10, state: "running" }),
    runGatewayRestart: () => {
      pid = 222;
      return { command: "hermes gateway restart", pid: 9, at: new Date().toISOString() };
    },
    proveGateway: () => ({ ok: true, stage: "turn", runId: "run_proof", status: "completed", output: "PANEL-RESTART-OK", ms: 11 }),
    stopProcess: async () => {
      throw new Error("the fallback must not run when the pid changed");
    },
    spawnGateway: async () => {
      throw new Error("the fallback must not run when the pid changed");
    },
  });
  const last = await restartAndWait(controller);
  assert.equal(last.state, "done");
  assert.equal(last.proof.ok, true);
  assert.equal(last.proof.runId, "run_proof");
});

test("a pid that changed but a turn that failed is still a failure", async () => {
  let pid = 111;
  const controller = makeController({
    identity: () => ({ pid, startTime: pid * 10, state: "running" }),
    runGatewayRestart: () => {
      pid = 222;
      return { command: "hermes gateway restart", pid: 9, at: new Date().toISOString() };
    },
    proveGateway: () => ({ ok: false, stage: "turn", status: "failed", reason: "the proof turn ended failed" }),
  });
  const last = await restartAndWait(controller);
  assert.equal(last.state, "failed");
  assert.equal(last.proof.ok, false);
  assert.equal(last.proof.reason, "the proof turn ended failed", "the verdict names the turn, not the pid, when the pid DID move");
});

// ---- BUG 2 --------------------------------------------------------------------------------------
test("a stop is attempted for every run the panel gives up on, and journalled", async (t) => {
  const { jobs, gw } = await makeJobs(t);
  const made = [];
  for (const name of ["a", "b", "c"]) made.push(await jobs.create({ prompt: `worker ${name}`, cwd: work, existing: true, worktree: false }));
  gw.state.stopStatus = 200;
  const controller = makeController({ jobs });
  const interrupted = await controller.interruptRunning({ by: "gateway", detail: "the test restarts it" });
  assert.equal(interrupted.length, 3);
  assert.deepEqual([...gw.state.stops].sort(), made.map((j) => j.runId).sort(), "one stop per run, none missed");
  assert.equal(jobs.stopAttempts.length, 3, "each attempt is journalled");
  assert.ok(jobs.stopAttempts.every((a) => a.ok === true && a.status === 200 && a.already === false), JSON.stringify(jobs.stopAttempts));
  assert.ok(made.every((j) => jobs.jobs.get(j.id).status === "interrupted"), "the cards keep their one terminal verdict");
});

test("404 and 409 from a stop are tolerated, and a stop that fails never blocks the interrupt", async (t) => {
  const { jobs, gw } = await makeJobs(t);
  const answers = { 1: 404, 2: 409, 3: 500 };
  gw.state.stopStatus = (id) => answers[String(id).split("_")[1]] || 200;
  const made = [];
  for (const name of ["a", "b", "c"]) made.push(await jobs.create({ prompt: `worker ${name}`, cwd: work, existing: true, worktree: false }));
  const controller = makeController({ jobs });
  const interrupted = await controller.interruptRunning({ by: "gateway", detail: "the test restarts it" });
  assert.equal(interrupted.length, 3, "every run still gets its verdict, whatever the stop answered");
  assert.ok(made.every((j) => jobs.jobs.get(j.id).status === "interrupted"));
  assert.deepEqual(gw.state.stopAnswers, [404, 409, 500]);
  const [gone, stopping, failed] = jobs.stopAttempts;
  assert.deepEqual([gone.status, gone.ok, gone.already], [404, true, true], "404 is the run already gone, which is the state wanted");
  assert.deepEqual([stopping.status, stopping.ok, stopping.already], [409, true, true], "409 is the run already stopping");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HTTP 500/, "a stop that failed is recorded as failed, not swallowed");
});

test("at boot, only a run issued to an EARLIER gateway identity is stopped", async (t) => {
  const store = path.join(dir, `jobs-boot-${++seq}.json`);
  const card = (id, runId, over = {}) => ({
    id,
    thread: `t-${id}`,
    turn: 1,
    prompt: `the turn behind ${id}`,
    cwd: work,
    sessionId: `t-${id}`,
    status: "running",
    exitCode: null,
    startedAt: "2026-10-26T02:10:00.000Z",
    endedAt: null,
    runId,
    lines: [],
    ...over,
  });
  writeFileSync(store, JSON.stringify({ savedAt: "2026-10-26T02:10:00.000Z", jobs: [
    // Issued to the gateway that is gone: nothing this process can watch, and nobody told it to stop.
    card("j-old", "run_old", { gatewayPid: 111, gatewayStart: 1110 }),
    // Issued to the gateway answering now, and the boot reconcile gave it back: live work, never touched.
    card("j-current", "run_current", { gatewayPid: 222, gatewayStart: 2220 }),
    // Issued to the old gateway but re-attached by the reconcile: running is running, whatever the stamp says.
    card("j-reattached", "run_reattached", { gatewayPid: 111, gatewayStart: 1110 }),
  ] }), "utf8");
  const { jobs, gw } = await makeJobs(t, { jobsFile: store });
  gw.state.stopStatus = 404; // a gateway that is running now has never heard of that run
  assert.equal(jobs.jobs.size, 3, "the store was restored");
  assert.ok(jobs.jobs.get("j-old").restoredLive && jobs.jobs.get("j-old").status === "interrupted", "an inherited live turn is interrupted at load");
  jobs.jobs.get("j-reattached").status = "running"; // what reconcileRestored() does to a run the gateway still has
  const out = await jobs.stopStaleRuns({ identity: { pid: 222, startTime: 2220, state: "running" } });
  assert.deepEqual(gw.state.stops, ["run_old"], "only the run from the earlier gateway is stopped");
  assert.equal(out.length, 1);
  assert.equal(out[0].already, true, "a run the gateway no longer has is a tolerated 404");
  assert.equal(jobs.jobs.get("j-old").status, "interrupted");
  assert.equal(jobs.jobs.get("j-current").status, "interrupted");
  assert.equal(jobs.jobs.get("j-reattached").status, "running", "a re-attached run is not stopped");
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
