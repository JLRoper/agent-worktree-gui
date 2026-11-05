// A stopped worker asks with `clarify`, and a question nobody answers is asked again — hourly, on a
// timer, as ONE entry.
//
// The defect this pins: a worker that needs a decision and asks in PROSE ends its turn. The run stops,
// the question sits on a finished card, and whatever it was in the middle of is abandoned — the panel
// never learns the gateway could have parked it instead. So:
//
//   · the panel PROVES the answer route before it composes a run's body, and tells the run to call the
//     tool when the route is there (and to ask in prose when it is not — the old path still works);
//   · a run parked on a question is re-asked by the sentry an hour later, then hourly, anchored to the
//     last ask rather than to a sweep — and never by ending and restarting the run;
//   · the re-ask moves the COUNT on the question it already has (`reasks`, `asks`), one alert and one
//     wait, so an ignored question is overwritten in place instead of piling up;
//   · the page's HUMAN rotation keys a question on (kind, turn, request id) — the count is not part of
//     it, which is what makes the re-ask the same row rather than a second one.
//
// Everything below is the SHIPPED code: lib/jobs.js against a stub Runs API on an ephemeral loopback
// port (so a real run's stream is read, parsed and parked the way it is in life), lib/assistant.js's
// own sweep with the clock aged rather than waited, and the page's key builder sliced out of
// public/app.js. "An hour later" is a rewritten timestamp, not a 60-minute test.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { CLARIFY_PROBE_RUN, createClarifyCapability, probeClarifyRoute } from "../lib/clarify.js";
import { Jobs, waitsOf } from "../lib/jobs.js";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const QUESTION = "Which summary do you want?";
const PROMPT_ID = "p-1";
const HOUR = 60 * 60_000;
const iso = (ms) => new Date(ms).toISOString();

// ── the route probe: reads the ANSWER, not the status code ──────────────────────────────────────
// The one thing a missing route and an unknown run id agree on is "404". What separates them is the
// body: the gateway's own `run_not_found` envelope means the route ran; a bare 404 means there is no
// route to run.
const reply = (status, body, kind = "json") => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (kind !== "json") throw new Error("not JSON");
    return body;
  },
});

test("the rule probe settles the route from the error body, and says nothing when it cannot tell", async () => {
  const at = (res, extra = {}) => probeClarifyRoute({ url: "http://gw:1", headers: { Authorization: "Bearer k" }, ...extra, fetchImpl: async () => res });

  assert.deepEqual((await at(reply(404, { error: { message: `Run not found: ${CLARIFY_PROBE_RUN}`, type: "invalid_request_error", code: "run_not_found" } }))).present, true,
    "a route that answered `run_not_found` for a made-up id is PRESENT");
  assert.deepEqual((await at(reply(404, null, "text"))).present, false,
    "a bare 404 is the router saying there is no such route");
  assert.equal((await at(reply(401, { error: { code: "gateway_auth_failed" } }))).present, null,
    "a 401 is an auth layer answering before the router — no verdict");
  assert.equal((await at(reply(200, { ok: true }))).present, true,
    "a 2xx from the route is proof it is there");
  assert.equal((await probeClarifyRoute({ url: "http://gw:1", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).present, null,
    "a transport failure settles nothing");
  assert.equal((await probeClarifyRoute({ url: "", fetchImpl: async () => reply(200, {}) })).present, null,
    "no gateway url, no claim");
});

test("the instruction a run carries is conditional on both halves of the evidence", () => {
  const fresh = () => createClarifyCapability();

  assert.equal(fresh().instruction(), "", "an unprobed, unobserved build is told nothing at all");

  const routeUp = fresh();
  routeUp.noteRoute({ present: true });
  assert.match(routeUp.instruction(), /call the clarify tool/, "a present route makes the run ask with the tool");
  assert.match(routeUp.instruction(), /comes back into this same turn/, "…and says the answer resumes the turn");
  assert.doesNotMatch(routeUp.instruction(), /ask it in prose/, "…and never tells it to end the turn on the question");

  const routeDown = fresh();
  routeDown.noteRoute({ present: false });
  assert.match(routeDown.instruction(), /ask it in prose/, "a build with no route keeps the prose instruction");

  const refused = fresh();
  refused.noteRoute({ present: true });
  refused.observeEvent({ event: "tool.completed", tool: "clarify", error: true, preview: "Clarify tool is not available in this execution context" });
  assert.match(refused.instruction(), /ask it in prose/, "a refusal outranks a present route — the callback is what refuses");
  assert.match(refused.instruction(), /Do not call the clarify tool/, "…and the tool is off limits again");

  const upgraded = fresh();
  upgraded.noteRoute({ present: true });
  upgraded.noteVersion("build-a");
  upgraded.noteVersion("build-b");
  assert.equal(upgraded.state().route, null, "a new build has not been probed");
  assert.equal(upgraded.instruction(), "", "…so the prompt goes quiet until it is");
});

// ── a parked worker, against a stub Runs API ────────────────────────────────────────────────────
async function stubGateway(t, { routePresent = true, park = "run_1", refuse = null } = {}) {
  const bodies = [];
  const openStreams = new Set();
  let probes = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/v1/capabilities") {
      // No clarify feature flag on purpose: the box this was measured on answers the route and
      // advertises nothing, which is why the panel probes the route itself.
      return json(200, { object: "hermes.api_server.capabilities", version: "reask-build-1", features: { run_submission: true, run_events_sse: true } });
    }
    const clarify = /^\/v1\/runs\/([^/]+)\/clarify$/.exec(url.pathname);
    if (clarify && req.method === "POST") {
      probes += 1;
      if (!routePresent) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("404: Not Found");
      }
      return json(404, { error: { message: `Run not found: ${clarify[1]}`, type: "invalid_request_error", code: "run_not_found" } });
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
    const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (events) {
      const id = events[1];
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "close" });
      // The question parks ITS run and the stream STAYS OPEN: that is what the gateway does while a
      // prompt is pending, and it is why nothing else on the board moves for this job. A build with
      // no route never parks anything, so the stub's scripts are per run id.
      if (park === id) {
        res.write(`data: ${JSON.stringify({ event: "tool.started", tool: "clarify", preview: QUESTION, seq: 0 })}\n\n`);
        res.write(`data: ${JSON.stringify({ event: "clarify.request", prompt_id: PROMPT_ID, question: QUESTION, choices: ["a (Recommended)", "b"], multi_select: false, seq: 1 })}\n\n`);
      }
      if (refuse === id) {
        res.write(`data: ${JSON.stringify({ event: "tool.completed", tool: "clarify", error: true, preview: "Clarify tool is not available in this execution context", seq: 2 })}\n\n`);
      }
      openStreams.add(res);
      return;
    }
    if (/^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { status: "running", output: "", usage: {} });
    return json(404, { error: "not found" });
  });
  const base = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => {
    for (const res of openStreams) res.destroy();
    server.closeAllConnections?.();
    server.close();
  });
  return { base, bodies, probes: () => probes };
}

const until = async (fn, what, ms = 5000) => {
  const stop = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function panel(t, { routePresent = true, park = "run_1", refuse = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-reask-"));
  const gw = await stubGateway(t, { routePresent, park, refuse });
  const jobsFile = path.join(dir, "jobs.json");
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const jobs = new Jobs({
    config: { apiServer: { url: gw.base, key: "test-key" }, jobsFile, defaultCwd: dir },
    onLog: () => {},
  });
  // The sweep's clock, as a variable: an hour is a rewritten timestamp, not a sleep.
  let clock = Date.now();
  const assistant = new Assistant({
    config: { jobsFile, assistantFile },
    jobs,
    getProjects: () => [],
    onLog: () => {},
    now: () => clock,
  });
  t.after(async () => {
    for (const j of jobs.list()) {
      const raw = jobs.get(j.id);
      if (!raw) continue;
      raw.status = "done"; // stops `follow`'s reconnect loop, then the sockets below go
      raw.ctrl?.abort();
      clearTimeout(raw.timer);
      clearTimeout(raw.poller);
    }
    clearTimeout(jobs.persistTimer);
    clearTimeout(assistant.timer);
    clearTimeout(assistant.wakeTimer);
    clearTimeout(assistant.persistTimer);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    jobs,
    assistant,
    bodies: gw.bodies,
    probes: gw.probes,
    dir,
    at: (ms) => {
      clock = ms;
    },
    now: () => clock,
  };
}

const spawn = (jobs, dir, thread) =>
  jobs.create({ prompt: `turn for ${thread}`, thread, existing: true, worktree: false, anchorCwd: false, cwd: dir });

test("a worker parked on a question is told to ASK with clarify, and the run stays parked", async (t) => {
  const { jobs, bodies, dir } = await panel(t);
  const first = await spawn(jobs, dir, "w1");

  assert.equal(bodies.length, 1);
  assert.match(bodies[0].input, /call the clarify tool/, "the route was proved before the body, so the worker is told to use it");
  assert.match(bodies[0].input, /comes back into this same turn/, "…and that the answer resumes the same turn");
  assert.doesNotMatch(bodies[0].input, /ask it in prose/, "…and not to end the turn on the question");

  const raw = await until(() => jobs.get(first.id)?.question, "the run to park on its question");
  assert.equal(raw.requestId, PROMPT_ID);
  assert.equal(raw.question, QUESTION);
  assert.equal(raw.reasks, 0, "the question itself is not a re-ask");
  assert.equal(raw.key, `clarify:${first.id}:${PROMPT_ID}`, "one stable key per prompt");
  assert.equal(jobs.get(first.id).status, "running", "a parked run is still alive — that is the point of asking this way");

  const waits = waitsOf(jobs.get(first.id));
  assert.equal(waits.length, 1, "one wait for one question");
  assert.equal(waits[0].key, raw.key, "the room's message is keyed on the question's own key");
  assert.equal(waits[0].reasks, 0);
});

test("an hour later the same question is asked again, on the timer, with a higher count", async (t) => {
  const { jobs, assistant, dir, at, now } = await panel(t);
  const first = await spawn(jobs, dir, "w2");
  // `q()` re-reads the record every time: `reaskQuestion` replaces `j.question` with a counted copy,
  // so a held reference is the question as it was a moment ago.
  const q = () => jobs.get(first.id)?.question;
  await until(() => q(), "the run to park on its question");

  // Age the question by 59 minutes: still inside the hour, so the sentry must say nothing.
  const parkedAt = now();
  q().at = iso(parkedAt - HOUR + 60_000);
  assistant.evaluate(jobs.list(), parkedAt);
  assert.equal(q().reasks, 0, "under an hour, the panel has not asked again");
  assert.equal(assistant.alerts.filter((a) => a.rule === "question").length, 1, "the first ask is one alert");

  // …and at 61 minutes it asks again. `evaluate` is the 5 s sentry, so this is the TICKER doing it,
  // not a turn: the run has emitted nothing at all since it parked.
  at(parkedAt);
  q().at = iso(parkedAt - HOUR - 60_000);
  assistant.evaluate(jobs.list(), parkedAt);
  assert.equal(q().reasks, 1, "the question was asked again");
  assert.ok(q().lastAskedAt, "…and the schedule is anchored to when it went out");
  assert.equal(assistant.alerts.filter((a) => a.rule === "question").length, 1, "still ONE alert — the same entry, not a second");
  assert.equal(assistant.alerts.find((a) => a.rule === "question").asks, 2, "the alert counts the question and its re-ask");
  assert.equal(q().key, `clarify:${first.id}:${PROMPT_ID}`, "the key never moves");
  assert.equal(waitsOf(jobs.get(first.id)).length, 1, "and still one wait");

  // The next sweep, milliseconds later, is NOT a second re-ask: the interval is an hour, not a tick.
  assistant.evaluate(jobs.list(), parkedAt + 5000);
  assert.equal(q().reasks, 1, "a sweep is not a re-ask");
  assert.equal(assistant.alerts.filter((a) => a.rule === "question").length, 1);

  // 59 minutes after the first re-ask: nothing. 61: the second.
  at(parkedAt + HOUR - 60_000);
  assistant.evaluate(jobs.list(), parkedAt + HOUR - 60_000);
  assert.equal(q().reasks, 1, "under an hour since the last ask, nothing goes out");

  at(parkedAt + HOUR + 60_000);
  assistant.evaluate(jobs.list(), parkedAt + HOUR + 60_000);
  assert.equal(q().reasks, 2, "an hour after the last ask, it is asked again");
  assert.equal(assistant.alerts.find((a) => a.rule === "question").asks, 3, "…and the count moved on the same alert");
  assert.equal(assistant.alerts.filter((a) => a.rule === "question").length, 1, "one question, one alert, three asks");
  assert.equal(waitsOf(jobs.get(first.id)).length, 1, "one question, one wait, three asks");

  // The card carries the count to the page (the question box draws it) …
  assert.equal(jobs.list().find((j) => j.id === first.id).question.reasks, 2);
  // … and the journal has a line per re-ask, so a reader can see when it happened.
  const journal = assistant.journal.filter((e) => e.kind === "question-reask");
  assert.equal(journal.length, 2, "each re-ask is one journal line");
});

test("answering the question ends the re-ask: the clock has nothing left to raise", async (t) => {
  const { jobs, assistant, dir, at, now } = await panel(t);
  const first = await spawn(jobs, dir, "w3");
  const q = () => jobs.get(first.id)?.question;
  await until(() => q(), "the run to park on its question");
  const parkedAt = now();
  q().at = iso(parkedAt - HOUR - 60_000);
  at(parkedAt);
  assistant.evaluate(jobs.list(), parkedAt);
  assert.equal(q().reasks, 1);

  // The answer lands the way the panel's own route lands it (the gateway's clarify.settled would do
  // the same): the question is gone, so there is nothing to ask again about.
  jobs.noteAnswered(jobs.get(first.id), "a");
  assert.equal(jobs.get(first.id).question, null);
  at(parkedAt + 3 * HOUR);
  assistant.evaluate(jobs.list(), parkedAt + 3 * HOUR);
  assert.equal(jobs.get(first.id).question, null, "an answered question is never re-asked");
  assert.equal(assistant.alerts.filter((a) => a.rule === "question" && a.status === "open").length, 0, "and its alert is closed");
});

// ── the HUMAN rotation: one row per question ───────────────────────────────────────────────────
test("the HUMAN list keys a question without its count, so a re-ask updates the row instead of adding one", async () => {
  const page = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const source = sliceBetween(page, "function humanQuestionKey(", "function humanQuestions(");
  const humanQuestionKey = new Function(`${source}; return humanQuestionKey;`)();

  const before = humanQuestionKey("question", "turn-7", "p-1");
  const after = humanQuestionKey("question", "turn-7", "p-1");
  assert.equal(before, after, "the same prompt on the same turn is the same row, however many times it is asked");
  assert.equal(humanQuestionKey("question", "turn-7", "p-1"), "question:turn-7:p-1");
  assert.notEqual(humanQuestionKey("question", "turn-7", "p-2"), before, "a NEW prompt is a different row");
  assert.notEqual(humanQuestionKey("approval", "turn-7", "p-1"), before, "an approval is not a question");
  assert.doesNotMatch(before, /2|3/, "nothing about how often it was asked can be in the key");

  // The list itself must build its rows from that key — a helper nobody calls proves nothing.
  const region = sliceBetween(page, "function humanQuestions()", "function paintHumanButton()");
  assert.match(region, /key: humanQuestionKey\(/, "the rotation's row carries the stable key");
  assert.match(region, /reasks: Math\.max\(0, Number\(ask\?\.reasks\) \|\| 0\)/, "…and the count rides on the row, outside the key");
  assert.doesNotMatch(region, /key: `${kind}:\$\{t\.id\}/, "the inline key string is gone — one builder, one answer");
});

test("a burst of runs probes the route once, and every body is the same sentence", async (t) => {
  const { jobs, bodies, dir, probes } = await panel(t);
  // Six workers started together: the memo is only written once the probe answers, so this is the
  // in-flight guard rather than the clock that keeps it to one request.
  await Promise.all(["b1", "b2", "b3", "b4", "b5", "b6"].map((thread) => spawn(jobs, dir, thread)));
  assert.equal(probes(), 1, "one probe of one build, however many runs start at once");
  assert.equal(bodies.length, 6);
  for (const body of bodies) assert.match(body.input, /call the clarify tool/, "and every run carries the proved sentence");
});

// ── the prose path, on a build with no route ──────────────────────────────────────────────────
test("a build with no clarify route still gets the prose path, before and after a refusal", async (t) => {
  const { jobs, bodies, dir } = await panel(t, { routePresent: false, park: null, refuse: "run_1" });
  assert.equal(jobs.transportInfo().clarify.route, null, "nothing has been probed yet");

  const first = await spawn(jobs, dir, "w4");
  assert.equal(jobs.transportInfo().clarify.route, false, "the route was probed before the body was composed");
  assert.match(bodies[0].input, /ask it in prose/, "the very first turn is told to ask in prose — no failed call needed");
  assert.doesNotMatch(bodies[0].input, /comes back into this same turn/, "…and is never told the tool works");

  // The gateway says the same thing anyway when the tool is called: the run's own stream carries the
  // refusal, and the panel keeps the prose path.
  await until(() => jobs.get(first.id)?.clarifyUnavailable, "the refusal on the run's stream");
  assert.equal(jobs.transportInfo().clarify.available, false, "the refusal is recorded");

  const second = await spawn(jobs, dir, "w5");
  assert.match(bodies[bodies.length - 1].input, /ask it in prose/, "and the next turn is still told to ask in prose");
  assert.doesNotMatch(bodies[bodies.length - 1].input, /comes back into this same turn/);
  assert.ok(jobs.get(second.id), "the second run was created");
});

// ── the alert the reader answers ──────────────────────────────────────────────────────────────
test("the parked alert carries the choice list and the count the assistant panel draws", async (t) => {
  const { jobs, assistant, dir, at, now } = await panel(t);
  const first = await spawn(jobs, dir, "w6");
  await until(() => jobs.get(first.id)?.question, "the run to park on its question");
  const parkedAt = now();
  jobs.get(first.id).question.at = iso(parkedAt - HOUR - 60_000);
  at(parkedAt);
  assistant.evaluate(jobs.list(), parkedAt);

  const alert = assistant.alerts.find((a) => a.rule === "question");
  assert.equal(alert.parked, true, "the alert is answerable from the panel, not a notice");
  assert.deepEqual(alert.choices, ["a (Recommended)", "b"], "the options the tool offered, verbatim");
  assert.equal(alert.requestId, PROMPT_ID, "and the prompt id the answer is posted with");
  assert.equal(alert.asks, 2);
  assert.ok(Date.parse(alert.at) >= parkedAt, "the re-ask raises the entry (it sorts newest-first)");
  assert.equal(alert.status, "open", "the same entry is still open — one row for the reader");
});
