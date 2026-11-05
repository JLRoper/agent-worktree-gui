// A gateway build that has the `clarify` toolset but not the Runs API half of the contract offers
// the tool to the model and then refuses every call with the tool's own message ("Clarify tool is
// not available in this execution context"). This proves the panel's answer to that, through the
// SHIPPED classes: the ROUTE is probed before a run's body is composed, and the sentence that body
// carries is conditional on the answer —
//
//   no answer endpoint            -> "ask it in prose and end the turn", on the very first run;
//   an endpoint that answers      -> "call the tool and stay parked", so a worker does not stop;
//   a refusal seen on a stream    -> the prose sentence, because a route with no callback delivers
//                                    nothing (the refusal outranks a present route);
//   nothing observed or probed    -> no sentence at all, which is the behaviour this panel had.
//
// The earlier version of this gate asserted that a `clarify.request` made the prompt say NOTHING.
// That was true while the panel could only learn "broken": with a probe it can also learn "works",
// and the point of the positive sentence is a worker that parks instead of ending its turn.
//
//   node tools/verify-clarify.mjs
//
// Everything here is driven against a stub Runs API on an ephemeral loopback port, so no real
// gateway is contacted and no worker is started. Exit code is the verdict (the report is on stdout,
// so a pipe cannot swallow it: `process.exitCode` is set rather than `process.exit()`).
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLARIFY_REFUSAL, createClarifyCapability, isClarifyTool } from "../lib/clarify.js";
import { Jobs, previewRequest } from "../lib/jobs.js";

let ran = 0;
let failed = 0;
const check = (name, got, want) => {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};

// ── the capability record, driven directly ───────────────────────────────────────────────────────
const fresh = () => createClarifyCapability();

{
  const cap = fresh();
  check("a fresh record claims nothing", cap.state().available, null);
  check("...and says nothing in a prompt", cap.instruction(), "");
}

{
  const cap = fresh();
  const changed = cap.observeEvent({
    event: "tool.completed",
    tool: "clarify",
    error: true,
    preview: CLARIFY_REFUSAL,
  });
  check("the tool's own refusal is recorded", cap.state().available, false);
  check("...and it changed the answer", changed, true);
  check("...and the run is told to ask in prose", /ask it in prose/.test(cap.instruction()), true);
  check("...and the tool is named as off limits", /Do not call the clarify tool/.test(cap.instruction()), true);
  check("...and a second refusal is not a second change", cap.observeEvent({ event: "tool.completed", tool: "clarify", preview: CLARIFY_REFUSAL }), false);
  check("...while the refusal count still rises", cap.state().refusals, 2);
}

{
  // The real order: the panel probes the gateway at boot and records its version, THEN a run refuses.
  const cap = fresh();
  cap.noteVersion("build-1");
  cap.observeEvent({ event: "tool.completed", tool: "clarify", preview: CLARIFY_REFUSAL });
  check("a refusal is recorded under the build that was probed", cap.state().available, false);
  check("...and the version is kept", cap.state().version, "build-1");
  cap.noteVersion("build-1");
  check("the same build does not clear the record", cap.state().available, false);
  cap.noteVersion("build-2");
  check("a NEW gateway version clears it (an upgrade is re-learned)", cap.state().available, null);
}

{
  const cap = fresh();
  // A different tool saying the same words is not evidence about clarify.
  check("another tool's output is ignored", cap.observeEvent({ event: "tool.completed", tool: "terminal", preview: CLARIFY_REFUSAL }), false);
  check("...so nothing is claimed", cap.state().available, null);
  // A bridged clarify arrives with a server prefix.
  check("mcp__server__clarify is recognised", isClarifyTool("mcp__github__clarify"), true);
  check("a clarify.request is the proof it works", cap.observeEvent({ event: "clarify.request", prompt_id: "p", question: "?" }), true);
  check("...and the prompt now says to call the tool", /call the clarify tool/.test(cap.instruction()), true);
  check("...and stops telling it to ask in prose", /ask it in prose/.test(cap.instruction()), false);
}

{
  // The route probe: the other half of the evidence, and the one that makes the instruction
  // conditional BEFORE any run has asked anything. A fresh record claims nothing; a probe settles it.
  const cap = fresh();
  check("a fresh record has no route verdict", cap.state().route, null);
  check("...and still says nothing in a prompt", cap.instruction(), "");

  const up = fresh();
  check("a probed-present route changes the answer", up.noteRoute({ present: true, evidence: "HTTP 404 run_not_found" }), true);
  check("...and is recorded", up.state().route, true);
  check("...and the run is told to call the tool", /call the clarify tool/.test(up.instruction()), true);
  check("...and not to end its turn on the question", /Do not end your turn on the question in prose/.test(up.instruction()), true);
  check("...and the same verdict twice is not a second change", up.noteRoute({ present: true }), false);

  const down = fresh();
  down.noteRoute({ present: false, evidence: "HTTP 404 no envelope" });
  check("a probed-absent route is recorded", down.state().route, false);
  check("...and the run is told to ask in prose", /ask it in prose/.test(down.instruction()), true);

  // A route with no callback: the endpoint answers, the TOOL refuses. The refusal is the stronger
  // evidence — the run must not be sent at a tool that cannot deliver.
  const stuck = fresh();
  stuck.noteRoute({ present: true });
  stuck.observeEvent({ event: "tool.completed", tool: "clarify", error: true, preview: CLARIFY_REFUSAL });
  check("a refusal outranks a present route", /ask it in prose/.test(stuck.instruction()), true);
  check("...and the tool is still named as off limits", /Do not call the clarify tool/.test(stuck.instruction()), true);

  // An upgrade is a different build: both records clear, in either direction.
  const v = fresh();
  v.noteRoute({ present: true });
  v.noteVersion("build-a");
  v.noteVersion("build-b");
  check("a version change clears the route record", v.state().route, null);
  check("...and the prompt goes quiet again", v.instruction(), "");
}

check("previewRequest carries the hint when given one", /in prose/.test(previewRequest({ prompt: "x", clarifyInstruction: "ask it in prose" }).body.input), true);
check("previewRequest is unchanged without one", previewRequest({ prompt: "x" }).body.input, "x");

// ── the same thing end to end, through Jobs, against a stub Runs API ─────────────────────────────
// Each run's script is keyed by the run id the stub hands back; the events are the ones the real
// gateway emits on the run's stream.
const scripts = {
  run_1: [
    { event: "tool.completed", tool: "clarify", error: true, duration: 0, preview: CLARIFY_REFUSAL },
    { event: "run.completed" },
  ],
  run_2: [
    { event: "clarify.request", prompt_id: "p-1", question: "Which summary do you want?", choices: ["a", "b"], multi_select: false },
    { event: "run.completed" },
  ],
  run_3: [{ event: "run.completed" }],
};

const bodies = [];
// Whether this stub build carries the answer route. It is flipped between the two panel instances
// below, which is the only way to prove the instruction is CONDITIONAL: same panel, same stub, one
// route added. A build without it answers the panel's probe with a bare 404 (no envelope); a build
// with it answers the way the real gateway does for a run id that does not exist.
let routePresent = false;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === "/v1/capabilities") {
    // Deliberately NO clarify feature flag: the route's presence is what the panel must read, and the
    // build this was measured against advertises nothing while answering the route.
    return json(200, { object: "hermes.api_server.capabilities", version: "stub-build-1", features: { run_submission: true, run_events_sse: true } });
  }
  const clarify = /^\/v1\/runs\/([^/]+)\/clarify$/.exec(url.pathname);
  if (clarify && req.method === "POST") {
    if (!routePresent) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404: Not Found");
    }
    return json(404, { error: { message: `Run not found: ${clarify[1]}`, type: "invalid_request_error", code: "run_not_found" } });
  }
  const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (events) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "close" });
    for (const evt of scripts[events[1]] || []) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    // The gateway closes a run's stream once it has delivered the terminal event; so does this.
    return res.end();
  }
  if (url.pathname === "/v1/runs" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      json(200, { run_id: `run_${bodies.length}`, session_id: bodies[bodies.length - 1].session_id || null });
    });
    return;
  }
  if (/^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { status: "completed", output: "done", usage: {} });
  return json(404, { error: "not found" });
});

const scratch = mkdtempSync(path.join(tmpdir(), "verify-clarify-"));
const listen = () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

// A run settles when its own stream has been consumed and its status fetched; wait for that rather
// than for a fixed sleep, or the assertions race the panel's own machinery.
async function settle(jobs, id, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    const j = jobs.list().find((x) => x.id === id);
    if (j && j.status !== "running" && j.status !== "starting") return j;
    if (Date.now() > until) return jobs.list().find((x) => x.id === id) || null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let jobs = null;
try {
  const base = await listen();
  jobs = new Jobs({
    config: {
      apiServer: { url: base, key: "test-key" },
      jobsFile: path.join(scratch, "jobs.json"),
      defaultCwd: scratch,
    },
  });
  const spawn = async (thread) =>
    jobs.create({ prompt: `turn for ${thread}`, thread, existing: true, worktree: false, anchorCwd: false, cwd: scratch });

  // 1. This build has no answer endpoint, and the panel knows it BEFORE the first turn: the probe
  //    answered with a bare 404, so the run is told to ask in prose without a failed call first.
  const j1 = await spawn("t1");
  check("run 1 posts a body", bodies.length, 1);
  check("the route probe settled the build first", jobs.transportInfo().clarify.route, false);
  check("...so run 1 is told to ask in prose", /ask it in prose/.test(bodies[0].input), true);
  check("...and is never told to call the tool", /comes back into this same turn/.test(bodies[0].input), false);

  await settle(jobs, j1.id);
  check("the refusal on run 1's stream was recorded", jobs.transportInfo().clarify.available, false);
  check("...and the card says why", (jobs.list().find((x) => x.id === j1.id)?.lines || []).some((l) => /cannot deliver a clarify question/.test(l.text)), true);
  // The assistant journals this (it owns the journal); the job summary is what carries the fact to it.
  check("...and the job reports it to the board", jobs.list().find((x) => x.id === j1.id)?.clarifyUnavailable, true);

  // 2. The very next turn — this is the assistant's own turn and every worker alike — is told.
  const j2 = await spawn("t2");
  check("run 2 posts a body", bodies.length, 2);
  check("...and it carries the hint", /ask it in prose/.test(bodies[1].input), true);
  check("...and the prompt the card shows is untouched", bodies[1].input.includes("turn for t2"), true);

  await settle(jobs, j2.id);
  check("a clarify.request proves the round trip works", jobs.transportInfo().clarify.available, true);

  // 3. Positive control: the hint stops appearing once the build has proved itself.
  const j3 = await spawn("t3");
  check("run 3 posts a body", bodies.length, 3);
  check("...with the prose hint gone again", /ask it in prose/.test(bodies[2].input), false);
  await settle(jobs, j3.id);

  // 4. The other build: the SAME stub with the answer route added, a fresh panel instance (its probe
  //    memo is per instance, which is what makes this a different build rather than a cached answer).
  //    No run here ever calls clarify — and the first body still tells the worker to call it. That is
  //    the whole feature: a worker that needs a decision parks with a question instead of stopping.
  routePresent = true;
  const jobs2 = new Jobs({
    config: {
      apiServer: { url: base, key: "test-key" },
      jobsFile: path.join(scratch, "jobs2.json"),
      defaultCwd: scratch,
    },
  });
  try {
    const j4 = await jobs2.create({ prompt: "turn for t4", thread: "t4", existing: true, worktree: false, anchorCwd: false, cwd: scratch });
    check("a build with the route proves it before the body", jobs2.transportInfo().clarify.route, true);
    check("run 4 posts a body", bodies.length, 4);
    check("...and it is told to CALL the tool", /call the clarify tool/.test(bodies[3].input), true);
    check("...and to stay parked rather than end the turn", /Do not end your turn on the question in prose/.test(bodies[3].input), true);
    check("...and NOT to ask in prose", /ask it in prose/.test(bodies[3].input), false);
    check("...and nothing is claimed about a refusal", jobs2.transportInfo().clarify.available, null);
    await settle(jobs2, j4.id);
  } finally {
    clearTimeout(jobs2.persistTimer);
    for (const j of jobs2.list() || []) {
      clearTimeout(j.timer);
      clearTimeout(j.poller);
    }
  }
} finally {
  server.close();
  // The store writes on a timer and each run holds its own; stop those before the scratch directory is
  // removed, or Windows refuses the unlink over an open handle and the cleanup failure reads as a verdict.
  clearTimeout(jobs?.persistTimer);
  for (const j of jobs?.list() || []) {
    clearTimeout(j.timer);
    clearTimeout(j.poller);
  }
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    console.log(`note: could not remove ${scratch} (${e.code || e}) — harmless, delete it by hand`);
  }
}

console.log(failed ? `RESULT: ${failed} FAILED of ${ran}` : `all ${ran} checks passed`);
process.exitCode = failed ? 1 : 0;
