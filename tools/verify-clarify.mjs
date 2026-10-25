// A gateway build that has the `clarify` toolset but not the Runs API half of the contract offers
// the tool to the model and then refuses every call with the tool's own message ("Clarify tool is
// not available in this execution context"). This proves the panel's answer to that, through the
// SHIPPED classes: the refusal is observed on a run's stream, the capability is recorded, and the
// next turn's body — the assistant's own turn and every worker alike, they post through one body —
// tells the run to ask in prose instead of spending a call that can only fail. Then the positive
// control: a `clarify.request` on a later run proves the round trip works, and the record clears, so
// the hint stops appearing. An unknown build is never lectured.
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
  check("...and then the prompt says nothing", cap.instruction(), "");
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
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === "/v1/capabilities") {
    return json(200, { object: "hermes.api_server.capabilities", version: "stub-build-1", features: { run_submission: true, run_events_sse: true } });
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

  // 1. Nothing observed yet: the panel behaves exactly as it did before this check existed.
  const j1 = await spawn("t1");
  check("run 1 posts a body", bodies.length, 1);
  check("...with no clarify hint while the build is unproven", /ask it in prose/.test(bodies[0].input), false);

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
  check("...with the hint gone again", /ask it in prose/.test(bodies[2].input), false);
  await settle(jobs, j3.id);
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
