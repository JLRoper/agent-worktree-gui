// The restart action, proved without touching the live gateway or the live panel.
//
//   node tools/verify-restart.mjs
//
// A restart is the one action that can take this process (or the gateway running the turn that asked for
// it) down, so it is the feature that most needs proving and the least safe to exercise against the real
// thing. Everything that reaches outside the process is injectable (lib/restart.js), and this file drives
// the real controller against a STUB gateway on an ephemeral port, the real job store and the real
// assistant — the shape verify-restored-turns.mjs uses for a stub gateway.
//
// The five things the brief asks for, each with its own section:
//
//   1. the queue        — the request returns at once and the action runs only once the turn has ended
//   2. the preflight    — a provider key has to be in $HERMES_HOME/.env, or the restart is refused
//   3. the proof+resume — the new process is proved with ONE REAL TURN (never the port), and only then is
//                         the assistant woken once with the completion payload of everything interrupted
//   4. the detection    — a gateway restart the panel did not ask for gives every lost run one terminal
//                         status and fires the SAME single resume wake
//   5. the line shape   — RESTART gateway / RESTART panel parses, harvests and reaches the route
//
// Plus the panel path (a record the replacement resumes) and the helper that waits for the old pid before
// anything binds the port.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const { Jobs } = await import("../lib/jobs.js");
const { Assistant, ASSISTANT_THREAD, parseActions } = await import("../lib/assistant.js");
const { RestartController, PROOF_PROMPT, providerKeyCheck } = await import("../lib/restart.js");

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 20_000, stepMs = 100) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > until) return false;
    await sleep(stepMs);
  }
};

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-restart-"));
const homeDir = path.join(dir, "hermes-home");
const homeNoKey = path.join(dir, "hermes-home-empty");
mkdirSync(homeDir, { recursive: true });
mkdirSync(homeNoKey, { recursive: true });
const tmpGH = path.join(dir, "gh");
mkdirSync(tmpGH, { recursive: true });
let storeSeq = 0;
const nextFile = (kind) => path.join(dir, `${kind}-${++storeSeq}.json`);

// ---- a stub gateway -------------------------------------------------------------------------
// Exactly what lib/jobs.js and lib/restart.js ask of a real one: capabilities, run submission, a pollable
// status, and the SSE events stream. It can be told to answer 503 (the window a restarting gateway is in)
// and to forget a run (what a restarted gateway does to the runs it was holding in memory).
function makeStub() {
  const state = { posts: [], runs: new Map(), capabilitiesCalls: 0, capabilities503: 0, forget: new Set(), seq: 0 };
  const timers = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/v1/capabilities") {
      state.capabilitiesCalls += 1;
      if (state.capabilities503 > 0) {
        state.capabilities503 -= 1;
        res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "restarting" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ version: "0.22.2-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } }),
      );
      return;
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        state.seq += 1;
        const isProof = String(body.input || "").trim().startsWith(PROOF_PROMPT.slice(0, 24));
        const id = `${isProof ? "proof" : body.session_id === ASSISTANT_THREAD ? "wake" : "run"}-${state.seq}`;
        state.runs.set(id, { id, status: "running", output: "", session: body.session_id || null, input: String(body.input || "") });
        state.posts.push({ id, session: body.session_id || null, input: String(body.input || ""), at: Date.now(), isProof, cwd: body.cwd || null });
        // A proof turn and a wake turn answer quickly; a worker run keeps going until it is told otherwise.
        if (isProof) settleIn(id, 300, "PANEL-RESTART-OK — the provider key was loaded");
        else if (body.session_id === ASSISTANT_THREAD) settleIn(id, 40, "noted");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id }));
      });
      return;
    }
    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (runMatch && req.method === "GET") {
      const record = state.runs.get(runMatch[1]);
      if (!record || state.forget.has(runMatch[1])) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Run not found", code: "run_not_found" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: record.id, status: record.status, output: record.output }));
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const record = state.runs.get(id);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!record || state.forget.has(id)) return res.end();
      const frame = (e) => `event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`;
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (record.status === "completed") {
          clearInterval(timer);
          res.write(frame({ event: "run.completed", output: record.output }));
          res.end();
        } else if (ticks > 75) {
          clearInterval(timer);
          res.end();
        }
      }, 200);
      timers.push(timer);
      req.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(404).end("{}");
  });

  function settleIn(id, ms, output = "") {
    const record = state.runs.get(id);
    if (!record) return;
    const timer = setTimeout(() => {
      record.status = "completed";
      record.output = output;
    }, ms);
    timers.push(timer);
  }

  const close = () =>
    new Promise((r) => {
      for (const t of timers) clearInterval(t);
      // Runs are still streaming on this stub: a plain close would sit here until every stream ends.
      server.closeAllConnections?.();
      server.close(() => r());
    });

  return { state, server, settleIn, close };
}

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${stub.server.address().port}`;

// ---- the store and the assistant under test -------------------------------------------------
const jobsFile = nextFile("jobs");
const assistantFile = nextFile("assistant");
const jobsConfig = () => ({
  jobsFile,
  assistantFile,
  apiServer: { url, key: "test-key" },
  defaultCwd: dir,
  assistantCwd: path.join(dir, "assistant-cwd"),
});
const jobs = new Jobs({ config: jobsConfig(), onLog: () => {} });
const restartCalls = [];
const assistant = new Assistant({
  config: jobsConfig(),
  jobs,
  getProjects: () => [],
  onEvent: () => {},
  onLog: () => {},
  onRestart: (spec) => restartCalls.push(spec),
});
// A fresh store per section, so one section's jobs are never another's board.
const make = () => new Jobs({ config: { ...jobsConfig(), jobsFile: nextFile("jobs"), assistantFile: nextFile("assistant") }, onLog: () => {} });
const controllers = [];
const makeController = ({ jobs: j = jobs, assistant: a = assistant, ...over } = {}) => {
  const controller = new RestartController({
    config: { ...jobsConfig(), restartFile: path.join(dir, `restart-${controllers.length}.json`) },
    jobs: j,
    assistant: a,
    home: homeDir,
    log: () => {},
    credentials: () => ({ url, key: "test-key" }),
    pollMs: 100,
    ...over,
  });
  controllers.push(controller);
  return controller;
};

console.log("\n1. the queue — the action runs after the turn that asked for it has ended");

// The provider key the preflight wants, in a fake HERMES_HOME.
writeFileSync(path.join(homeDir, ".env"), "OPENROUTER_API_KEY=sk-or-v1-0000000000000000000000000000\n");

// The gateway's own record of which process is running. A restart's verdict is now (the pid changed) AND (a
// real turn passed): a command that leaves the same pid running is a FAILED restart, whatever it exited with.
// So the stub "restart" below replaces this record the way a real one would.
const statePath = path.join(homeDir, "gateway_state.json");
const writeGatewayState = (pid) =>
  writeFileSync(statePath, JSON.stringify({
    pid,
    kind: "hermes-gateway",
    argv: [path.join(dir, "hermes-agent", "hermes_cli", "main.py"), "gateway", "run", "--quiet"],
    start_time: pid * 10,
    gateway_state: "running",
  }));
writeGatewayState(1000);
const bumpGatewayPid = () => writeGatewayState(JSON.parse(readFileSync(statePath, "utf8")).pid + 1);

// The turn that asks for the restart: a real run, deliberately not on the assistant's own thread so it is
// the ONLY thing holding the queue (the stub keeps it going until the test settles it).
const REQUESTER = "wtgui-requester";
const requesterTurn = await jobs.create({ prompt: "please restart the gateway", thread: REQUESTER, cwd: tmpGH, existing: true, worktree: false });
check("the requesting turn is a live run", jobs.jobs.get(requesterTurn.id).status, "running");

let restartedAt = null;
let capabilitiesAtRestart = null;
const controller = makeController({
  runGatewayRestart: () => {
    restartedAt = Date.now();
    capabilitiesAtRestart = stub.state.capabilitiesCalls;
    stub.state.capabilities503 = 1; // the new process is not answering yet
    bumpGatewayPid(); // a real restart replaces the process, and the pid guard is what says so
    return { command: "hermes gateway restart (stub)", pid: 4242, at: new Date().toISOString() };
  },
});
const requestedAt = Date.now();
const accepted = controller.request({ target: "gateway", reason: "the board asks for it", waitFor: REQUESTER });
check("the request is accepted at once", accepted.accepted, true);
ok("...and is queued rather than run", ["queued", "waiting"].includes(accepted.state), accepted.state);
ok("...and nothing has restarted yet", restartedAt === null, `restartedAt=${restartedAt}`);
await sleep(600);
ok("the restart is still held while the turn runs", restartedAt === null, `restartedAt=${restartedAt}`);
check("the status says what it is waiting for", controller.state().queued[0]?.waitFor, REQUESTER);

// Two workers to interrupt, and one run the gateway says it already finished.
const workerA = await jobs.create({ prompt: "worker a", cwd: tmpGH, existing: true, worktree: false });
const workerB = await jobs.create({ prompt: "worker b", cwd: tmpGH, existing: true, worktree: false });
const workerC = await jobs.create({ prompt: "worker c", cwd: tmpGH, existing: true, worktree: false });
stub.state.runs.get(workerC.runId).status = "completed";
stub.state.runs.get(workerC.runId).output = "finished before the restart";

// Now let the requesting turn end: the stub completes it, the panel settles it, the queue moves.
await sleep(900);
stub.settleIn(requesterTurn.runId, 60, "restart queued");
ok("the queued restart ran once the turn ended", await waitFor(() => restartedAt !== null, 15_000), `restartedAt=${restartedAt}`);
ok("...and only after that turn ended", restartedAt > requestedAt + 1_000, `queued at +0ms, ran at +${restartedAt - requestedAt}ms`);
ok("...and only once the panel had settled that turn", jobs.jobs.get(requesterTurn.id).status !== "running", jobs.jobs.get(requesterTurn.id).status);
ok("...and the whole restart finished", await waitFor(() => controller.state().last !== null && controller.state().running === null, 40_000), JSON.stringify(controller.state().running));
// The wake is coalesced on a 150 ms timer and then sent as a run of its own, so it lands after the verdict,
// never inside it: wait for the post instead of guessing how long "after" is.
await waitFor(() => stub.state.posts.some((p) => p.session === ASSISTANT_THREAD), 10_000);
await sleep(200);

console.log("\n2. the preflight — a provider key has to be in $HERMES_HOME/.env");
const noKey = providerKeyCheck(homeNoKey);
check("no key anywhere is refused", noKey.ok, false);
ok("...and the refusal names the .env it looked in", /\.env/.test(noKey.reason), noKey.reason);
ok("...and says what happens without it", /No LLM provider configured/.test(noKey.reason), noKey.reason);
const withKey = providerKeyCheck(homeDir);
check("a key in .env passes, and says where it came from", [withKey.ok, withKey.source, withKey.name], [true, "env", "OPENROUTER_API_KEY"]);
ok("...and the value never comes back with it", !JSON.stringify(withKey).includes("sk-or-v1-"), JSON.stringify(withKey));

// A key written in config.yaml's model block instead of .env is accepted, and named as that source.
const yamlHome = path.join(dir, "hermes-home-yaml");
mkdirSync(yamlHome, { recursive: true });
writeFileSync(path.join(yamlHome, "config.yaml"), 'model:\n  provider: openrouter\n  api_key: "sk-or-v1-fromyaml"\n');
const fromYaml = providerKeyCheck(yamlHome);
check("a key in config.yaml is accepted and named as that source", [fromYaml.ok, fromYaml.source], [true, "config.yaml"]);

const blocked = makeController({ home: homeNoKey, jobs: make(), assistant: null, runGatewayRestart: () => { throw new Error("must not run"); } });
let refusal = null;
try {
  blocked.request({ target: "gateway" });
} catch (e) {
  refusal = e;
}
check("a request with no key is refused with 409", refusal?.status, 409);
ok("...and the refusal is the preflight's own words", /provider key/.test(String(refusal?.message || "")), String(refusal?.message || ""));
check("...and nothing was queued", blocked.state().queued.length, 0);
check("a target that is neither gateway nor panel is a 400", (() => { try { controller.request({ target: "lunch" }); return null; } catch (e) { return e.status; } })(), 400);

console.log("\n3. the proof and the one wake — a real turn, never the port");
const internal = (id) => jobs.jobs.get(id);
check("every run the restart killed got a terminal status", [internal(workerA.id).status, internal(workerB.id).status], ["interrupted", "interrupted"]);
ok("...and no run is left 'running' with no verdict", ![workerA, workerB, workerC, requesterTurn].some((job) => internal(job.id).status === "running"), JSON.stringify([internal(workerA.id).status, internal(workerB.id).status, internal(workerC.id).status, internal(requesterTurn.id).status]));
check("...recorded as the restart's doing", [internal(workerA.id).termination?.by, internal(workerB.id).termination?.by], ["gateway", "gateway"]);
check("a run the gateway had already finished reads 'done', not interrupted", internal(workerC.id).status, "done");
check("...and its own closing message was kept", internal(workerC.id).finalMessage, "finished before the restart");

const proofs = stub.state.posts.filter((p) => p.isProof);
check("the new process was proved with exactly one real turn through the gateway", proofs.length, 1);
ok("...sent as a run with the proof prompt, not a health probe", String(proofs[0]?.input || "").includes("PANEL-RESTART-OK"), String(proofs[0]?.input || "").slice(0, 80));
ok("...and it really is a run the gateway accepted and answered", stub.state.runs.get(proofs[0]?.id)?.status === "completed", JSON.stringify(stub.state.runs.get(proofs[0]?.id)));
check("...after the health wait rode out the 503 window", [stub.state.capabilities503, stub.state.capabilitiesCalls > capabilitiesAtRestart + 1], [0, true]);
check("the outcome records the proof", [controller.state().last.proof.ok, controller.state().last.proof.status], [true, "completed"]);
check("...and names what it interrupted", controller.state().last.interrupted.length, 2);
check("...with the run ids", controller.state().last.interrupted.map((j) => j.id).sort(), [workerA.id, workerB.id].sort());

const wakes = stub.state.posts.filter((p) => p.session === ASSISTANT_THREAD);
check("the assistant was woken exactly once", wakes.length, 1);
const wakeText = wakes[0]?.input || "";
ok("...with the restart named", /restart — the gateway was restarted from this panel/.test(wakeText), wakeText.slice(0, 200));
ok("...with the proof in it", /proof: one real turn through the gateway completed/.test(wakeText), wakeText.slice(0, 400));
check("...and a completion payload per interrupted run", (wakeText.match(/completion — /g) || []).length, 2);
ok("...saying an interrupted run never finished", /interrupted run never finished/.test(wakeText), wakeText.slice(-220));

console.log("\n4. the detection — a gateway restart the panel did not ask for");
const detect = make();
const detectAssistant = new Assistant({ config: jobsConfig(), jobs: detect, getProjects: () => [], onEvent: () => {}, onLog: () => {} });
const orphanA = await detect.create({ prompt: "orphan a", cwd: tmpGH, existing: true, worktree: false });
const orphanB = await detect.create({ prompt: "orphan b", cwd: tmpGH, existing: true, worktree: false });
const orphanC = await detect.create({ prompt: "orphan c", cwd: tmpGH, existing: true, worktree: false });
await sleep(300);
// The gateway was restarted: it no longer knows two of the three runs, and it says the third finished.
stub.state.forget.add(orphanA.runId);
stub.state.forget.add(orphanB.runId);
stub.state.runs.get(orphanC.runId).status = "completed";
stub.state.runs.get(orphanC.runId).output = "finished while the gateway was down";

const detected = await detect.sweepOrphanedRuns();
check("both runs that stopped reporting were found", detected.map((j) => j.id).sort(), [orphanA.id, orphanB.id].sort());
const dint = (id) => detect.jobs.get(id);
check("each got one terminal status", [dint(orphanA.id).status, dint(orphanB.id).status], ["interrupted", "interrupted"]);
check("...attributed to the gateway restart", [dint(orphanA.id).termination?.by, dint(orphanB.id).termination?.by], ["gateway", "gateway"]);
check("a run the gateway still has is left alone", detected.some((j) => j.id === orphanC.id), false);
check("...and one it says finished is adopted, not interrupted", dint(orphanC.id).status, "done");
check("nothing is left running", detect.runningJobs().map((j) => j.id), []);

const secondSweep = await detect.sweepOrphanedRuns();
check("a second sweep re-marks nothing (one terminal status per run)", secondSweep.length, 0);
check("...and the statuses are unchanged", [dint(orphanA.id).status, dint(orphanB.id).status], ["interrupted", "interrupted"]);

const wakeBefore = stub.state.posts.filter((p) => p.session === ASSISTANT_THREAD).length;
const first = detectAssistant.wakeAfterRestart(detected, { target: "gateway", detected: true, reason: "the gateway was restarted and the panel did not ask for it" });
const second = detectAssistant.wakeAfterRestart(detected, { target: "gateway", detected: true, reason: "the gateway was restarted and the panel did not ask for it" });
ok("the detection fired the resume wake", Boolean(first), JSON.stringify(first));
check("...and the same restart is never woken twice", second, null);
await waitFor(() => stub.state.posts.filter((p) => p.session === ASSISTANT_THREAD).length > wakeBefore, 5_000);
const wakesAfter = stub.state.posts.filter((p) => p.session === ASSISTANT_THREAD);
check("...so exactly one wake went out", wakesAfter.length, wakeBefore + 1);
ok("...saying the panel did not ask for it", /did not ask for it/.test(wakesAfter.at(-1)?.input || ""), String(wakesAfter.at(-1)?.input || "").slice(0, 160));
check("...with a payload per lost run", (String(wakesAfter.at(-1)?.input || "").match(/completion — /g) || []).length, 2);

console.log("\n5. the line shape — RESTART gateway | RESTART panel");
const parsed = parseActions("Board looks stuck.\nRESTART gateway because the board is stuck\nRESTART panel\nI will restart gateway later.\nRESTARTED");
check("both shapes parse, and only those", parsed.restart, [{ target: "gateway", reason: "because the board is stuck" }, { target: "panel", reason: "" }]);

restartCalls.length = 0;
assistant.harvest({ id: "asst-turn-restart", thread: ASSISTANT_THREAD, lines: [{ kind: "text", text: "Queuing that now.\nRESTART gateway because you asked", lid: 1, at: Date.now() }] });
check("a harvested RESTART line reaches the route", restartCalls.map((s) => s.target), ["gateway"]);
check("...with the turn it must wait for", restartCalls[0]?.waitFor, ASSISTANT_THREAD);
ok("...and the journal says queued, not done", assistant.state().journal.some((j) => j.kind === "restart-queued"), JSON.stringify(assistant.state().journal.slice(0, 2)));
check("...and it carries the reason the model wrote", restartCalls[0]?.reason, "because you asked");

const stern = new Assistant({ config: jobsConfig(), jobs: make(), getProjects: () => [], onEvent: () => {}, onLog: () => {}, onRestart: () => { const e = new Error("restart refused — no provider key in C:/hermes/.env"); e.status = 409; throw e; } });
stern.harvest({ id: "asst-turn-refused", thread: ASSISTANT_THREAD, lines: [{ kind: "text", text: "RESTART panel", lid: 1, at: Date.now() }] });
ok("a refused RESTART is journaled as refused", stern.state().journal.some((j) => j.kind === "restart-refused"), JSON.stringify(stern.state().journal.slice(0, 2)));
const noWiring = new Assistant({ config: jobsConfig(), jobs: make(), getProjects: () => [], onEvent: () => {}, onLog: () => {} });
noWiring.harvest({ id: "asst-turn-nowire", thread: ASSISTANT_THREAD, lines: [{ kind: "text", text: "RESTART gateway", lid: 1, at: Date.now() }] });
ok("an unwired panel says so instead of pretending", noWiring.state().journal.some((j) => j.kind === "restart-skipped"), JSON.stringify(noWiring.state().journal.slice(0, 2)));

console.log("\n6. the panel path — the record, the resume, and the helper that waits for the old pid");
const panelJobs = make();
const panelJob = await panelJobs.create({ prompt: "panel path worker", cwd: tmpGH, existing: true, worktree: false });
const panelAssistantCalls = [];
const panelAssistant = { wakeAfterRestart: (list, meta) => panelAssistantCalls.push({ list: list.map((j) => j.id), meta }) };
const panelFile = path.join(dir, "panel-restart.json");
let exitCode = null;
const panelController = new RestartController({
  config: { ...jobsConfig(), restartFile: panelFile },
  jobs: panelJobs,
  assistant: panelAssistant,
  home: homeDir,
  log: () => {},
  credentials: () => ({ url, key: "test-key" }),
  spawnPanel: () => ({ command: "node lib/panel-restart.cjs server.js …", pid: 5150, at: new Date().toISOString() }),
  shutdown: (code) => { exitCode = code; },
  pollMs: 50,
});
panelController.request({ target: "panel", reason: "from the board" });
await waitFor(() => exitCode !== null, 15_000);
check("the panel restart exits through the shared path", exitCode, 0);
const record = JSON.parse(readFileSync(panelFile, "utf8"));
check("...after recording what was running", record.runningIds, [panelJob.id]);
check("...and nothing was woken before the replacement proved the gateway", panelAssistantCalls.length, 0);
check("...with the record still un-resumed", record.resumedAt, null);

// The replacement's boot path: jobs.load() stamps the running turn interrupted, then resumePending proves
// the gateway and wakes once. (The stamp is reproduced here rather than by restarting a store.) What that wake
// says is decided by the gateway, and there are two answers to drive, because the reconcile in the middle of the
// resume tells them apart:
//   * the gateway STILL HAS the run  → it is re-attached, so nothing was interrupted, and the wake names the turn
//     that is going on rather than a completion nobody will ever see
//   * the gateway has FORGOTTEN it   → nobody saw it end, so it is named as the interrupted turn it is
const bootJob = panelJobs.jobs.get(panelJob.id);
bootJob.status = "interrupted";
bootJob.error = `the panel restarted while this was running (run ${bootJob.runId} may still be live in the gateway)`;
bootJob.endedAt = new Date().toISOString();
panelJobs.finalise(bootJob);
const bootAssistantCalls = [];
const bootAssistant = { wakeAfterRestart: (list, meta) => bootAssistantCalls.push({ list: list.map((j) => j.id), meta }) };
const proofsBefore = stub.state.posts.filter((p) => p.isProof).length;
const bootController = new RestartController({
  config: { ...jobsConfig(), restartFile: panelFile },
  jobs: panelJobs,
  assistant: bootAssistant,
  home: homeDir,
  log: () => {},
  credentials: () => ({ url, key: "test-key" }),
  pollMs: 50,
});
const resume = await bootController.resumePending();
ok("the replacement proved the new gateway with one real turn", stub.state.posts.filter((p) => p.isProof).length === proofsBefore + 1, String(stub.state.posts.filter((p) => p.isProof).length));
check("...and woke the assistant once", bootAssistantCalls.length, 1);
// The stub still holds this run, so the boot reconcile re-attached to it instead of writing the turn off.
check("...with nothing reported as interrupted", bootAssistantCalls[0]?.list, []);
check("...naming instead the run the gateway still had", (bootAssistantCalls[0]?.meta.reattached || []).map((j) => j.id), [panelJob.id]);
check("...with its run id, so the wake can say what is going on", bootAssistantCalls[0]?.meta.reattached?.[0]?.runId, bootJob.runId);
check("the re-attached turn is running on the board again", panelJobs.jobs.get(panelJob.id).status, "running");
const resumedRecord = JSON.parse(readFileSync(panelFile, "utf8"));
check("...and the record says which run was re-attached", [resumedRecord.reattached.map((j) => j.id), resumedRecord.interrupted], [[panelJob.id], []]);
check("...as a panel restart, not a detected one", [bootAssistantCalls[0]?.meta.target, bootAssistantCalls[0]?.meta.detected], ["panel", false]);
check("...only after proving it", [bootAssistantCalls[0]?.meta.proof.ok, bootAssistantCalls[0]?.meta.proof.status], [true, "completed"]);
check("...with the resume record naming both counts", [resumedRecord.resume.interrupted, resumedRecord.resume.reattached], [0, 1]);
check("...and the record is marked resumed", resumedRecord.resumedAt !== null, true);
check("a second boot does not resume the same restart again", await bootController.resumePending(), null);

// The wake text for that case, through the REAL assistant: a re-attached run is named as still going, and the
// wake may not say nothing was running.
const resumedAssistant = new Assistant({ config: jobsConfig(), jobs: make(), getProjects: () => [], onEvent: () => {}, onLog: () => {} });
const wakeTextBefore = stub.state.posts.filter((p) => p.session === ASSISTANT_THREAD).length;
resumedAssistant.wakeAfterRestart([], {
  target: "panel",
  proof: { ok: true, ms: 120, runId: "proof-resume", status: "completed", output: "PANEL-RESTART-OK" },
  reattached: [{ id: panelJob.id, thread: panelJob.thread, runId: bootJob.runId }],
});
await waitFor(() => stub.state.posts.filter((p) => p.session === ASSISTANT_THREAD).length > wakeTextBefore, 5_000);
const reattachedText = stub.state.posts.filter((p) => p.session === ASSISTANT_THREAD).at(-1)?.input || "";
ok("the wake text names the re-attached turn as still going", /was still going in the gateway, so the panel re-attached/.test(reattachedText), reattachedText.slice(0, 400));
ok("...with the run id", reattachedText.includes(String(bootJob.runId)), reattachedText.slice(0, 400));
ok("...and says nothing was interrupted", /nothing was interrupted\./.test(reattachedText), reattachedText.slice(0, 400));
ok("...without claiming no run was going", !/no run was still going when it stopped/.test(reattachedText), reattachedText.slice(0, 400));
ok("...and without inventing a completion payload for it", !/interrupted run never finished/.test(reattachedText), reattachedText.slice(-300));

// The other answer: the gateway has no record of the run at all.
const goneJobs = make();
const goneJob = await goneJobs.create({ prompt: "panel path worker gone", cwd: tmpGH, existing: true, worktree: false });
const goneFile = path.join(dir, "panel-restart-gone.json");
const goneAssistantCalls = [];
const goneAssistant = { wakeAfterRestart: (list, meta) => goneAssistantCalls.push({ list: list.map((j) => j.id), meta }) };
writeFileSync(
  goneFile,
  JSON.stringify({ id: "gone-case", target: "panel", reason: "", requestedBy: "reader", requestedAt: new Date().toISOString(), runningIds: [goneJob.id], thread: ASSISTANT_THREAD, provider: null, resumedAt: null }),
);
const goneInternal = goneJobs.jobs.get(goneJob.id);
goneInternal.status = "interrupted";
goneInternal.error = `the panel restarted while this was running (run ${goneInternal.runId} may still be live in the gateway)`;
goneInternal.endedAt = new Date().toISOString();
goneJobs.finalise(goneInternal);
stub.state.forget.add(goneJob.runId);
const goneResume = await new RestartController({
  config: { ...jobsConfig(), restartFile: goneFile },
  jobs: goneJobs,
  assistant: goneAssistant,
  home: homeDir,
  log: () => {},
  credentials: () => ({ url, key: "test-key" }),
  pollMs: 50,
}).resumePending();
check("a run the gateway no longer has is named as the interrupted one", goneAssistantCalls[0]?.list, [goneJob.id]);
check("...with nothing claimed as re-attached", (goneAssistantCalls[0]?.meta.reattached || []).length, 0);
check("...and the record keeps them apart", [goneResume.record.interrupted.map((j) => j.id), goneResume.record.reattached], [[goneJob.id], []]);
ok("...its card repaired to interrupted-by-restart", /the gateway no longer has run/.test(goneInternal.error), goneInternal.error);
ok("...with no promise it will finish on its own", !/will finish on its own/.test(goneInternal.error) && !/may still be live/.test(goneInternal.error), goneInternal.error);

// The helper waits for the outgoing pid before it binds the port. Two cases, each with its own marker: a
// detached replacement writes its marker a moment after the helper itself has exited.
const helper = path.join(ROOT, "lib", "panel-restart.cjs");
const helperEnv = { ...process.env, HERMES_PANEL_RESTART_WAIT_MS: "6000" };
const cases = [
  { name: "gone", parent: "999999", marker: path.join(dir, "replacement-gone.txt") },
  { name: "alive", parent: null, marker: path.join(dir, "replacement-alive.txt") },
];
for (const c of cases) {
  const fakeServer = path.join(dir, `fake-server-${c.name}.cjs`);
  const pidFile = path.join(dir, `fake-server-${c.name}.pid`);
  writeFileSync(fakeServer, `require("node:fs").appendFileSync(${JSON.stringify(c.marker)}, "started\\n"); process.exit(0);\n`);
  let dummyParent = null;
  let parentPid = c.parent;
  if (c.parent === null) {
    dummyParent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore" });
    parentPid = String(dummyParent.pid);
  }
  const child = spawn(process.execPath, [helper, fakeServer, pidFile, path.join(dir, `${c.name}.out.log`), path.join(dir, `${c.name}.err.log`), parentPid], { stdio: "ignore", env: helperEnv });
  if (dummyParent) {
    await sleep(600);
    check("while the old process is alive, nothing has bound the port", existsSync(c.marker), false);
    await new Promise((r) => dummyParent.on("exit", r));
  }
  await new Promise((r) => child.on("exit", r));
  if (c.parent === "999999") {
    ok("with the old process already gone, the replacement starts at once", await waitFor(() => existsSync(c.marker), 5_000, 100), "marker file missing");
  } else {
    ok("once the old process exits, the replacement starts", await waitFor(() => existsSync(c.marker), 5_000, 100), "marker file missing");
  }
  await sleep(300);
  ok(`...and the pid file names it (${c.name})`, existsSync(pidFile) && Number(readFileSync(pidFile, "utf8")) > 0, existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "no pid file");
}

// ---- cleanup -------------------------------------------------------------------------------
await stub.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} checks, ${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);