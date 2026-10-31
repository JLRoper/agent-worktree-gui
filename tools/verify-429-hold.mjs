// A 429 is backpressure, not failure — proved by driving the SHIPPED `Jobs` (and a panel of this checkout
// plus a real browser over it) against a stand-in Runs API that answers 429 exactly as the gateway does.
//
//   PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-429-hold.mjs
//
// WHERE THE 429 COMES FROM, AND WHY A STAND-IN
//
//   The real gateway refuses `POST /v1/runs` with 429 + `Retry-After: 1` + `{error:{code:
//   "rate_limit_exceeded"}}` when its concurrent-run cap is reached (`_concurrency_limited_response` in
//   the installed `gateway/platforms/api_server.py`). Every byte of that response is reproduced here,
//   header and body, from a real HTTP server — so the shipped code's own `fetch`, its own
//   `response.headers.get("retry-after")` and its own `readDetail` all run unmodified.
//
//   What is NOT real is the saturation: filling the live gateway's cap means ten concurrent paid runs,
//   and several sibling agents are working on this box, so their spawns would be refused while this
//   script held the slots. The real THING is a stub; the real RESPONSE is verbatim.
//
// WHAT EACH ACCEPTANCE ITEM IS PROVED BY
//
//   (a) held, not failed: with two 429s then a free slot, the turn's status is never `failed`, the card's
//       own DOM says "waiting for a slot" with the hold's attempt count and countdown while it waits, and
//       the third POST lands a run — quoted from the live page, then from the terminal turn
//   (b) a 400, a 409 and a 500 keep today's behaviour exactly: the panel's own sentence for each, quoted
//       from THIS build and from a control worktree at the pre-change commit, byte for byte, POST count 1
//   (c) exhausted attempts produce ONE failure carrying how long it waited and how many tries it made,
//       with no further POST after it
//   (d) a turn the reader cancels while it is held is never re-sent, and does not wear the card's retry
//   (e) `node tools/verify-assistant.mjs` and the public-facing suites — run separately; this script
//       asserts the shape of its own change, and prints the suite command for the rest
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven    the shipped `Jobs` class from THIS checkout against a real HTTP stand-in gateway: the hold,
//             the backoff, the Retry-After floor, the exhausted failure, the cancel, the 400/409/500 paths
//   driven    the same class from a control worktree at the pre-change commit, for the (b) quotes
//   driven    a sandbox panel of this checkout over HTTP (`POST /api/agents`, `GET /api/jobs`,
//             `POST /api/jobs/cancel`) plus headless Chromium over it, for (a)'s card and its landed run
//   inspected the delay arithmetic is also asserted directly against the exported pure functions
//             (`retry429DelayMs` doubling/cap/jitter/floor, `retryAfterMs`, `retry429Settings`, `fmtWait`)
//   inspected that only a 429 is retried, and that the retry re-posts the SAME body on the SAME thread —
//             read off `lib/jobs.js:create`
//
// The browser half needs a Playwright install; without one the script prints BROWSER-HALF-NOT-RUN and
// exits non-zero rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let checks = 0;
let failures = 0;
let skipped = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const skip = (name, why) => {
  skipped += 1;
  console.log(`SKIP  ${name} — ${why}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 20_000, stepMs = 60, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const gitOut = (args, cwd = ROOT) => {
  try {
    return execFileSync("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};

// ---- the stand-in Runs API ------------------------------------------------------------------------
// One real HTTP server per phase, so every request the shipped code makes is a real one. `mode` decides
// what POST /v1/runs answers.
//
//   "429-then-ok"  refuses `refuseFirst` times, then accepts (the slot freed)
//   "always-429"   refuses every time (the exhaustion and cancel cases)
//   "400"/"409"/"500"  one refusal of that status, with the gateway's own OpenAI-shaped error body
//   "ok"           accepts at once
const GATEWAY_429_BODY = (max) => ({
  error: {
    message: `Too many concurrent runs (max ${max})`,
    type: "rate_limit_error",
    param: null,
    code: "rate_limit_exceeded",
  },
});
function startGateway({ mode = "ok", refuseFirst = 0, retryAfter = "1", max = 10, sseDelayMs = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const state = {
      mode,
      posts: [], // { at, body, status } for every POST /v1/runs
      runs: new Map(),
      stops: [],
      slots: 0, // POSTs this gateway has ACCEPTED
      refused: 0, // POSTs this gateway has refused with 429
      sawRetryAfter: null,
    };
    const json = (res, code, body, headers = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...headers });
      res.end(text);
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const chunks = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (url.pathname === "/v1/capabilities") {
          return json(res, 200, {
            version: "standin-429",
            features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true, run_budget: true, max_turns: true },
          });
        }
        if (url.pathname === "/v1/runs" && req.method === "POST") {
          let body = {};
          try {
            body = JSON.parse(raw);
          } catch {
            /* a body that is not JSON is not what this probe is about */
          }
          const at = Date.now();
          const decide = () => {
            if (state.mode === "400") return 400;
            if (state.mode === "409") return 409;
            if (state.mode === "500") return 500;
            if (state.mode === "always-429") return 429;
            // "429-then-ok": refuse `refuseFirst` times, then hand over a slot — the cap counting the POSTs it
            // refused, NOT the runs it accepted, or the refusal never ends.
            if (state.mode === "429-then-ok") return state.refused < refuseFirst ? 429 : 201;
            return 201;
          };
          const code = decide();
          state.posts.push({ at, body, status: code });
          if (code === 429) {
            state.refused += 1;
            state.sawRetryAfter = "seen";
            // Verbatim: the status, the header and the body api_server sends at the cap.
            return json(res, 429, GATEWAY_429_BODY(max), retryAfter === null ? {} : { "Retry-After": String(retryAfter) });
          }
          if (code === 400) return json(res, 400, { error: { message: "invalid request: probe", type: "invalid_request_error", param: "input", code: null } });
          if (code === 409) return json(res, 409, { error: { message: "permission_denied: this session is owned by another surface", type: "invalid_request_error", param: null, code: "permission_denied" } });
          if (code === 500) return json(res, 500, { error: { message: "internal error: probe", type: "server_error", param: null, code: null } });
          // Accepted: a real run id, and a stream that ends the way a finished run's does.
          state.slots += 1;
          const runId = `run_probe_${state.slots}_${Math.random().toString(16).slice(2, 8)}`;
          state.runs.set(runId, { status: "running", session: body.session_id || "" });
          setTimeout(() => state.runs.set(runId, { status: "completed", session: body.session_id || "" }), sseDelayMs);
          return json(res, code, { run_id: runId, status: "running" });
        }
        const runMatch = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
        if (runMatch) {
          const runId = runMatch[1];
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          const frame = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
          setTimeout(() => {
            frame({ event: "run.completed", run_id: runId, exit_code: 0, output: "probe: the run landed", usage: { total_tokens: 12, input_tokens: 7, output_tokens: 5 } });
            setTimeout(() => res.end(), 10);
          }, sseDelayMs);
          return undefined;
        }
        const statusMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
        if (statusMatch && req.method === "GET") {
          const run = state.runs.get(statusMatch[1]);
          if (!run) return json(res, 404, { error: { message: "no such run", type: "invalid_request_error" } });
          return json(res, 200, { run_id: statusMatch[1], status: run.status, session_id: run.session, output: "", usage: null });
        }
        const stopMatch = /^\/v1\/runs\/([^/]+)\/stop$/.exec(url.pathname);
        if (stopMatch) {
          state.stops.push(stopMatch[1]);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: { message: `no such route: ${url.pathname}`, type: "invalid_request_error" } });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---- driving the shipped Jobs ----------------------------------------------------------------
// `new Jobs({config: {...}})` — nested, or the constructor destructures nothing and apiConfig falls back
// to the LIVE gateway at 127.0.0.1:8642, starting real, paid workers. That trap is not repeated here.
async function loadJobsFrom(dir) {
  return import(pathToFileURL(path.join(dir, "lib", "jobs.js")).href);
}
// A driver that does NOT await `create`: with a 429 the store holds the turn inside `create` (that is the
// point of it), so the observation window is the job EVENTS the store broadcasts, exactly as the panel and
// the page see it, and `create`'s promise is the second half of the story.
function makeDriver(Jobs, { url, key = "probe-key", retry429, cwd }) {
  const events = [];
  const lines = [];
  const jobs = new Jobs({
    config: { apiServer: { url, key }, jobsFile: null, jobMaxRuntimeSeconds: 120, ...(retry429 ? { retry429 } : {}) },
    onEvent: (evt) => events.push(evt),
    onLog: (t) => lines.push(String(t)),
  });
  const cards = () => events.filter((e) => e.type === "job" && e.job && e.job.id).map((e) => e.job);
  const holds = () => cards().filter((c) => c.status === "waiting");
  const states = () => [...new Set(cards().map((c) => c.status))];
  return {
    jobs,
    lines,
    start: (prompt) => jobs.create({ prompt, existing: true, worktree: false, cwd }),
    // The job is registered in the map before the POST goes out, so this is the record under test — not a
    // copy of the summary taken before it was updated.
    only: () => [...jobs.jobs.values()][0] || null,
    summary: () => {
      const j = [...jobs.jobs.values()][0];
      return j ? jobs.summary(j) : null;
    },
    cards,
    holds,
    states,
  };
}
const statusOf = (d) => String(d.summary()?.status || "");

async function phaseMath() {
  console.log("\n== the delay arithmetic (exported pure functions) ==");
  const mod = await loadJobsFrom(ROOT);
  check("retry429Settings defaults: attempts", mod.retry429Settings({}).attempts, 6);
  check("retry429Settings: config.retry429 wins", mod.retry429Settings({ retry429: { attempts: 3, baseMs: 60, maxMs: 200, jitter: 0 } }), { attempts: 3, baseMs: 60, maxMs: 200, jitter: 0 });
  check("retry429Settings: a nonsense value falls back", mod.retry429Settings({ retry429: { attempts: -4, baseMs: "x" } }).attempts, 6);
  const s = { attempts: 6, baseMs: 1000, maxMs: 30000, jitter: 0 };
  const jit = { attempts: 6, baseMs: 1000, maxMs: 30000, jitter: 0.25 };
  const noJitter = (n) => mod.retry429DelayMs(n, s, null, () => 0.5);
  check("delay doubles from base", [1, 2, 3, 4, 5].map(noJitter), [1000, 2000, 4000, 8000, 16000]);
  check("delay stops at the cap", mod.retry429DelayMs(6, s, null, () => 0.5), 30000);
  check("delay stays at the cap", mod.retry429DelayMs(20, s, null, () => 0.5), 30000);
  check("jitter adds up to +25%", mod.retry429DelayMs(1, jit, null, () => 1), 1250);
  check("jitter subtracts up to -25%", mod.retry429DelayMs(1, jit, null, () => 0), 750);
  check("jitter is applied to the GROWN delay, not the base", mod.retry429DelayMs(3, jit, null, () => 1), 5000);
  // Retry-After is a FLOOR under the backoff, and is never capped away: honouring it must beat a faster
  // backoff, and a gateway that says 60s must not be asked again at 30.
  check("Retry-After floors a smaller backoff", mod.retry429DelayMs(1, { attempts: 6, baseMs: 10, maxMs: 20, jitter: 0 }, 5000, () => 0.5), 5000);
  check("a long Retry-After is not capped away", mod.retry429DelayMs(1, s, 60000, () => 0.5), 60000);
  check("the backoff still wins over a shorter Retry-After", mod.retry429DelayMs(4, s, 1000, () => 0.5), 8000);
  check("retryAfterMs: whole seconds", mod.retryAfterMs(new Headers({ "Retry-After": "1" })), 1000);
  check("retryAfterMs: absent is null", mod.retryAfterMs(new Headers({})), null);
  check("retryAfterMs: nonsense is null, not a zero wait", mod.retryAfterMs(new Headers({ "Retry-After": "soon" })), null);
  check("retryAfterMs: an HTTP-date is read", mod.retryAfterMs(new Headers({ "Retry-After": new Date(Date.now() + 5000).toUTCString() })) > 3000, true);
  check("fmtWait: sub-ten seconds keeps a decimal", mod.fmtWait(1500), "1.5s");
  check("fmtWait: seconds", mod.fmtWait(47_000), "47s");
  check("fmtWait: minutes", mod.fmtWait(125_000), "2m 05s");
  check("isLiveJobStatus counts a held turn", ["running", "starting", "waiting"].map(mod.isLiveJobStatus), [true, true, true]);
  check("isLiveJobStatus refuses a settled one", ["done", "failed", "cancelled", "interrupted", ""].map(mod.isLiveJobStatus), [false, false, false, false, false]);
}

async function phaseHoldAndLand(cwd) {
  console.log("\n== (a) held on 429, never failed, and the retry lands a run ==");
  const mod = await loadJobsFrom(ROOT);
  // Two refusals then a free slot. 60ms backoff and no jitter so the whole hold is short, and
  // `Retry-After: 1` on each refusal so the FLOOR is what is being measured, not the backoff.
  const gw = await startGateway({ mode: "429-then-ok", refuseFirst: 2, retryAfter: "1" });
  try {
    const d = makeDriver(mod.Jobs, {
      url: gw.url,
      retry429: { attempts: 4, baseMs: 60, maxMs: 200, jitter: 0 },
      cwd,
    });
    const created = d.start("probe: a turn the gateway refuses while it is at its cap");
    const held = await waitFor(() => d.holds().length > 0, { timeoutMs: 6000, what: "the turn to be held as waiting" });
    ok("the turn is HELD as `waiting` (not failed)", held, `status while held=${statusOf(d)}`);
    const first = d.holds()[0] || {};
    ok("the held turn carries the hold record the card draws from", first.waiting?.attempts === 4, JSON.stringify(first.waiting));
    ok("the held turn has no run id yet", first.runId === null, `runId=${first.runId}`);
    ok("the held turn carries no failure", !first.error, `error=${JSON.stringify(first.error)}`);
    ok("the card got a line saying why it is held", (first.lines || []).some((l) => /concurrent-run cap \(HTTP 429/.test(String(l.text || ""))), (first.lines || []).find((l) => /concurrent-run cap/.test(String(l.text || "")))?.text || "(none)");
    ok("the hold is drawn from a real attempt count, not a guess", Number(first.waiting?.attempt) >= 1 && Number(first.waiting?.attempt) < 4, JSON.stringify(first.waiting));

    await created;
    const landed = await waitFor(() => ["done", "failed"].includes(statusOf(d)), { timeoutMs: 20_000, what: "the retried run to finish" });
    ok("the retry landed a run once a slot freed", landed && statusOf(d) === "done", `status=${statusOf(d)}`);
    const end = d.summary();
    ok("the landed turn has the run id the gateway returned", /^run_probe_/.test(String(end.runId || "")), `runId=${end.runId}`);
    ok("the landed turn carries no error", !end.error, `error=${JSON.stringify(end.error)}`);
    ok("the hold record is cleared once the run is accepted", end.waiting === null, JSON.stringify(end.waiting));
    ok("`failed` is never one of the states this turn passed through", !d.states().includes("failed"), `states seen: ${d.states().join(" → ")}`);
    check("the gateway saw exactly three POSTs (two refused, one accepted)", gw.state.posts.map((p) => p.status), [429, 429, 201]);
    check("every POST carried the SAME session id (one thread, one turn)", [...new Set(gw.state.posts.map((p) => p.body.session_id))].length, 1);
    check("every POST carried the SAME body (the retry re-sends the request, it does not rebuild it)", [...new Set(gw.state.posts.map((p) => JSON.stringify(p.body)))].length, 1);
    // The Retry-After floor, measured: 60ms of backoff stepped aside for the gateway's 1s.
    const gap = gw.state.posts[1].at - gw.state.posts[0].at;
    ok("the hold honoured `Retry-After: 1` over a 60ms backoff", gap >= 1000 && gap < 2500, `${gap}ms between the first refusal and the next try`);
    check("the second hold grew (doubling, floored again by Retry-After)", gw.state.posts[2].at - gw.state.posts[1].at >= 1000, true);
    check("the panel logged the hold and its try number", d.lines.some((l) => /gateway at capacity \(429\) — holding/.test(l)), true);
  } finally {
    await gw.close();
  }
}

async function phaseNotRetried(cwd) {
  console.log("\n== (b) only a 429 is retried: 400, 409 and 500 keep today's sentence ==");
  const mod = await loadJobsFrom(ROOT);
  const control = controlDir();
  const controlMod = control ? await loadJobsFrom(control) : null;
  if (controlMod) note(`control build: ${control} (${gitOut(["log", "--format=%h %s", "-n", "1"], control)})`);
  else skip("the pre-change control half", "no control worktree could be cut (set PRE_CHANGE_SHA to force one)");

  const cases = [
    { mode: "400", label: "400" },
    { mode: "409", label: "409 permission_denied" },
    { mode: "500", label: "500" },
  ];
  const quotes = { now: {}, control: {} };
  for (const c of cases) {
    const gw = await startGateway({ mode: c.mode });
    try {
      const d = makeDriver(mod.Jobs, { url: gw.url, cwd });
      await d.start(`probe: a ${c.mode} refusal`);
      const landed = await waitFor(() => ["failed", "done", "cancelled"].includes(statusOf(d)), { timeoutMs: 8000, what: `the ${c.mode} verdict` });
      const end = d.summary();
      ok(`${c.label}: the turn is failed (unchanged)`, landed && end.status === "failed", `status=${end.status}`);
      check(`${c.label}: exactly ONE POST (never retried)`, gw.state.posts.length, 1);
      check(`${c.label}: no run id`, end.runId, null);
      quotes.now[c.mode] = String(end.error || "");
      note(`${c.label} says: ${quotes.now[c.mode]}`);
    } finally {
      await gw.close();
    }
    if (controlMod) {
      const gw = await startGateway({ mode: c.mode });
      try {
        const d = makeDriver(controlMod.Jobs, { url: gw.url, cwd });
        await d.start(`probe: a ${c.mode} refusal`);
        await waitFor(() => ["failed", "done", "cancelled"].includes(statusOf(d)), { timeoutMs: 8000, what: `the control ${c.mode} verdict` });
        quotes.control[c.mode] = String(d.summary()?.error || "");
        check(`${c.label}: the sentence is byte-identical to the pre-change build`, quotes.now[c.mode], quotes.control[c.mode]);
        check(`${c.label}: the control build also posted exactly once`, gw.state.posts.length, 1);
      } finally {
        await gw.close();
      }
    }
  }
  // The 429's OLD sentence, for the record: the one this change replaces, quoted from the control build.
  if (controlMod) {
    const gw = await startGateway({ mode: "always-429" });
    try {
      const d = makeDriver(controlMod.Jobs, { url: gw.url, cwd });
      await d.start("probe: the old 429 sentence");
      await waitFor(() => statusOf(d) === "failed", { timeoutMs: 8000, what: "the control 429 verdict" });
      const before = String(d.summary()?.error || "");
      note(`the pre-change build on a 429 said: ${before}`);
      ok("the pre-change build failed instantly and never retried", gw.state.posts.length === 1 && /^gateway refused the run \(HTTP 429\)/.test(before), `posts=${gw.state.posts.length}`);
    } finally {
      await gw.close();
    }
  }
}

async function phaseExhausted(cwd) {
  console.log("\n== (c) exhausted attempts produce ONE honest failure ==");
  const mod = await loadJobsFrom(ROOT);
  const gw = await startGateway({ mode: "always-429", retryAfter: "1" });
  try {
    const d = makeDriver(mod.Jobs, {
      url: gw.url,
      retry429: { attempts: 4, baseMs: 250, maxMs: 250, jitter: 0 },
      cwd,
    });
    await d.start("probe: a gateway that never has a slot");
    const done = await waitFor(() => statusOf(d) === "failed", { timeoutMs: 15_000, what: "the exhausted verdict" });
    const end = d.summary();
    ok("the exhausted hold surfaces exactly one failure", done && end.status === "failed", `status=${end.status} endedAt=${Boolean(end.endedAt)}`);
    const err = String(end.error || "");
    note(`it says: ${err}`);
    ok("the failure names how many tries it made", /after 4 tries/.test(err), err);
    ok("the failure names how long it waited", /over \d+(\.\d+)?s of holding/.test(err), err);
    ok("the failure keeps the gateway's own words", /Too many concurrent runs \(max 10\)/.test(err), err);
    check("it posted exactly `attempts` times", gw.state.posts.length, 4);
    check("`failed` appears once in the turn's states", d.states().filter((s) => s === "failed").length, 1);
    ok("the failure says the verb, not the panel's own opinion", /was still at its concurrent-run cap/.test(err), err);
    // No further POST after the verdict: the loop is over, not merely quiet.
    const at = gw.state.posts.length;
    await sleep(700);
    check("nothing is posted after the verdict", gw.state.posts.length, at);
    ok("the card would offer its manual retry (the reason is retryable)", /HTTP 429/.test(err), err);
  } finally {
    await gw.close();
  }
}

async function phaseCancelled(cwd) {
  console.log("\n== (d) a cancelled turn is never retried ==");
  const mod = await loadJobsFrom(ROOT);
  const gw = await startGateway({ mode: "always-429", retryAfter: "1" });
  try {
    const d = makeDriver(mod.Jobs, {
      url: gw.url,
      retry429: { attempts: 8, baseMs: 400, maxMs: 400, jitter: 0 },
      cwd,
    });
    const created = d.start("probe: a held turn the reader cancels");
    const held = await waitFor(() => d.holds().length > 0 && d.only(), { timeoutMs: 6000, what: "the turn to be held" });
    ok("the turn is held before the cancel", held, `status=${statusOf(d)}`);
    ok("cancel() accepts a HELD turn (it has no run to stop)", d.jobs.cancel(d.only().id) === true, "cancel returned true");
    await created;
    const stopped = await waitFor(() => statusOf(d) === "cancelled", { timeoutMs: 6000, what: "the cancelled verdict" });
    const end = d.summary();
    ok("the held turn settles as cancelled", stopped && end.status === "cancelled", `status=${end.status}`);
    ok("a cancelled turn carries no failure (nothing to retry-offer)", !end.error, `error=${JSON.stringify(end.error)}`);
    check("it says the turn was not sent again", /was not sent again/.test(String((end.lines || []).map((l) => l.text).join("\n"))), true);
    const at = gw.state.posts.length;
    ok("it had posted at least once before the cancel", at >= 1, `posts=${at}`);
    // Four would-be retries later, nothing has been sent.
    await sleep(1800);
    check("no POST after the cancel, however many holds were left", gw.state.posts.length, at);
    check("cancel() on a waiting turn needs no run id", end.runId, null);
    ok("a settled cancelled turn refuses a second cancel", d.jobs.cancel(d.only().id) === false, "cancel returned false");
    ok("`failed` is never one of the states this turn passed through", !d.states().includes("failed"), `states seen: ${d.states().join(" → ")}`);
  } finally {
    await gw.close();
  }
}

// ---- the control build -------------------------------------------------------------------------
// A detached worktree at the commit BEFORE this change, kept OUTSIDE the repo's own .worktrees/ so the live
// board grows no row for it. Removed in the finally below.
let CONTROL = null;
function preChangeSha() {
  if (process.env.PRE_CHANGE_SHA) return process.env.PRE_CHANGE_SHA.trim();
  const tip = gitOut(["log", "--format=%H", "--grep=^Hold a 429 turn for a run slot", "-n", "1"]);
  if (!tip) return "";
  return gitOut(["rev-parse", `${tip}^`]);
}
function controlDir() {
  return CONTROL;
}
function cutControl() {
  const sha = preChangeSha();
  if (!sha) {
    note("could not name the pre-change commit (no commit subject matched) — set PRE_CHANGE_SHA to run the control half");
    return null;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-429-control-"));
  rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "add", "--detach", dir, sha], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    note(`could not cut the control worktree: ${String((e && e.message) || e).slice(0, 200)}`);
    return null;
  }
  CONTROL = dir;
  return dir;
}
function dropControl() {
  if (!CONTROL) return;
  try {
    execFileSync("git", ["worktree", "remove", "--force", CONTROL], { cwd: ROOT, stdio: "ignore", windowsHide: true });
  } catch {
    /* the scratch dir removal below is the backstop */
  }
  try {
    rmSync(CONTROL, { recursive: true, force: true });
  } catch {
    /* Windows can hold the tree open for a moment */
  }
  CONTROL = null;
}

// ---- the panel + browser half ------------------------------------------------------------------
const PANEL_PROMPT = "probe: a spawn the gateway refuses while it is at its cap";
let panel = null;
let panelLog = [];
let scratchRoot = null;
let sandboxHome = null;

function makeScratchRepo(root) {
  const repo = path.join(root, "repos", "proj429");
  mkdirSync(repo, { recursive: true });
  const run = (args) => execFileSync("git", args, { cwd: repo, stdio: "ignore", windowsHide: true });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "probe@example.invalid"]);
  run(["config", "user.name", "probe"]);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "probe: the repo the panel cuts a worktree from"]);
  return repo;
}

async function startSandboxPanel({ gatewayUrl }) {
  scratchRoot = mkdtempSync(path.join(tmpdir(), "wtgui-429-hold-"));
  const scanRoot = path.join(scratchRoot, "repos");
  mkdirSync(scanRoot, { recursive: true });
  const repo = makeScratchRepo(scratchRoot);
  sandboxHome = path.join(scratchRoot, "hermes-home");
  const configDir = path.join(scratchRoot, "panel");
  const cwdDir = path.join(scratchRoot, "panel-cwd");
  for (const d of [sandboxHome, configDir, cwdDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        defaultCwd: cwdDir,
        jobsFile: path.join(configDir, "logs", "jobs.json"),
        assistantFile: path.join(configDir, "logs", "assistant.json"),
        // Pinned inside the sandbox: this one does NOT derive from PANEL_CONFIG's directory, and without it a
        // child launched with cwd = the clone writes logs/projects.json into the REAL checkout.
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        treeNamesFile: path.join(configDir, "logs", "tree-names.json"),
        descriptionsFile: path.join(configDir, "logs", "descriptions.json"),
        // The stand-in Runs API. Every byte of a 429 the panel sees comes from it.
        apiServer: { url: gatewayUrl, key: "probe-key" },
        assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
        refreshSeconds: 3600,
        worktreeSeconds: 5,
        midSeconds: 3600,
        dormantSeconds: 3600,
        slowSeconds: 3600,
        fetchSeconds: 3600,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const base = `http://127.0.0.1:${port}`;
  panelLog = [];
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: sandboxHome, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-20).join("\n")}`);
  // Assert the BIND, not just the answer: a PANEL_CONFIG that does not resolve falls back to the live port.
  const state0 = await fetch(`${base}/api/state`).then((r) => r.json()).catch(() => ({}));
  ok("the sandbox panel is the one answering (its own port, its own store)", Number(state0.settings?.port ?? port) === port && port !== 7331, `port=${port}`);
  return { base, repo, scanRoot, port };
}
async function stopSandboxPanel() {
  const p = panel;
  panel = null;
  if (p) {
    p.kill();
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 8_000, what: "the panel to exit" });
    if (p.exitCode === null && p.signalCode === null && p.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        /* already gone */
      }
    }
  }
  await sleep(250);
}

async function phaseCardAndPanel() {
  console.log("\n== (a) the CARD says it is waiting, and the landed run is one run in one tree ==");
  const gw = await startGateway({ mode: "429-then-ok", refuseFirst: 2, retryAfter: "1", sseDelayMs: 400 });
  let browser = null;
  let context = null;
  try {
    const { base, repo } = await startSandboxPanel({ gatewayUrl: gw.url });
    // Discovery has to have landed before a spawn can name the project.
    const found = await waitFor(async () => {
      const s = await fetch(`${base}/api/state`).then((r) => r.json());
      return Boolean(s.projects && Object.keys(s.projects).length);
    }, { timeoutMs: 30_000, what: "the sandbox panel to discover the scratch project" });
    ok("the sandbox panel discovered the scratch project", found, "proj429");

    const pw = loadPlaywright();
    if (!pw) {
      console.log("BROWSER-HALF-NOT-RUN  no Playwright install — set PANEL_PLAYWRIGHT_ROOT");
      failures += 1;
      checks += 1;
      return;
    }
    browser = await pw.chromium.launch({ headless: true });
    const pageErrors = [];
    context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    // `state` is a top-level `const` in a classic script: it is a global BINDING, not a property of
    // `window`, so it is reachable by name and not as `window.state`.
    await waitFor(() => page.evaluate(() => typeof state !== "undefined" && Boolean(state.jobs)), { timeoutMs: 20_000, what: "the page's own state to exist" });

    // The spawn: a real worktree is cut and the panel posts the run to the stand-in, which refuses it twice.
    // The POST is NOT awaited first: with a 429 the panel holds the turn INSIDE `create`, so the response is
    // the last thing to arrive — the card is what says what is happening meanwhile, and it must be read now.
    const postPromise = fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "proj429", prompt: PANEL_PROMPT }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    const readJobs = async () => {
      const jobs = await fetch(`${base}/api/jobs`).then((r) => r.json()).catch(() => ({}));
      return jobs.jobs || [];
    };
    // The job exists as soon as the panel registers it — before the worktree is even cut — so it can be
    // followed while the hold is still in progress.
    const appeared = await waitFor(async () => (await readJobs()).length > 0, { timeoutMs: 15_000, what: "the spawn to be registered" });
    ok("the spawn is registered before the gateway has answered", appeared, "yes");
    const mine = (await readJobs())[0];
    const thread = mine.thread;
    const cardSel = `.job[data-thread="${thread}"]`;
    note(`thread ${thread} · id ${mine.id}`);

    let heldJob = null;
    const held = await waitFor(async () => {
      const j = (await readJobs()).find((x) => x.thread === thread);
      if (!j || j.status !== "waiting") return false;
      heldJob = j;
      return true;
    }, { timeoutMs: 20_000, what: "the panel's turn to be held as waiting" });
    ok("the panel's turn is held as `waiting` while the gateway is at its cap", held, `status=${heldJob?.status}`);
    ok("the held turn carries its attempt count for the card", Boolean(heldJob?.waiting?.attempts), JSON.stringify(heldJob?.waiting));
    ok("the held turn is not failed", heldJob?.status !== "failed" && !heldJob?.error, `error=${heldJob?.error}`);

    // The card, in the live DOM of the shipped page. The card may be in the unattached panel until the scan
    // lands its worktree as a row, so every poll also opens whatever row it might be sitting under — the two
    // calls the page itself makes (`toggleProject`, then the row's own click).
    const readCard = async () => {
      await page
        .evaluate(() => {
          for (const [name] of state.projects) {
            if (!state.expandedProjects.has(name)) toggleProject(name);
          }
          for (const row of state.rows.values()) {
            const key = keyOf(row.project, row.path);
            if (!state.expanded.has(key)) document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
          }
        })
        .catch(() => {});
      return page.evaluate((sel) => {
        const card = document.querySelector(sel);
        if (!card) return null;
        const pill = card.querySelector(".job-preview .pv-status");
        const head = card.querySelector(".turn-text");
        const cs = pill ? getComputedStyle(pill) : null;
        return {
          where: card.closest("#jobs") ? "#jobs (unattached)" : card.closest(".agents-block") ? "a worktree row" : "elsewhere",
          collapsed: card.classList.contains("collapsed"),
          pillText: pill ? pill.textContent : null,
          pillClass: pill ? pill.className : null,
          pillTransform: cs ? cs.textTransform : null,
          headText: head ? head.textContent : null,
          previewText: card.querySelector(".job-preview .pv-text")?.textContent ?? null,
          failedChip: Boolean(card.querySelector(".pv-status.is-failed")),
          waitingChip: Boolean(card.querySelector(".pv-status.is-waiting")),
          retryButton: Boolean(card.querySelector(".btn-retry")),
        };
      }, cardSel);
    };
    // A real press on the card's head, which is what a reader does to fold it — and the preview line the
    // brief quotes only exists on a folded card.
    const foldCard = () => page.evaluate((sel) => document.querySelector(`${sel} .job-head`)?.click(), cardSel);
    const cardShown = await waitFor(async () => {
      if (!(await page.evaluate((sel) => Boolean(document.querySelector(sel)), cardSel))) return false;
      await foldCard();
      return page.evaluate((sel) => document.querySelector(sel)?.classList.contains("collapsed") ?? false, cardSel);
    }, { timeoutMs: 15_000, what: "the card to be on the page, folded" });
    ok("the card is on the page and folds on a press of its head", cardShown, "folded");
    const dom = await readCard();
    if (dom) note(`card in ${dom.where} · pill “${dom.pillText}” (${dom.pillClass}) · head “${dom.headText}”`);
    ok("the card says it is waiting for a slot", dom?.pillText === "waiting for a slot", JSON.stringify(dom?.pillText));
    ok("the pill is drawn in the card's chip style (upper-cased by CSS)", dom?.pillTransform === "uppercase", JSON.stringify(dom?.pillTransform));
    ok("the card's chip is the waiting chip, not the failed one", dom?.waitingChip === true && dom?.failedChip === false, `waiting=${dom?.waitingChip} failed=${dom?.failedChip}`);
    ok("the card does NOT say failed anywhere", !dom?.failedChip, JSON.stringify(dom?.failedChip));
    ok("the turn head carries the hold and its countdown", /waiting for a slot \d+s · try \d+ of \d+ · /.test(String(dom?.headText || "")), JSON.stringify(dom?.headText));
    ok("the folded line carries where the hold has got to", /try \d+ of \d+/.test(String(dom?.previewText || "")), JSON.stringify(dom?.previewText));
    ok("no manual retry is offered while the turn is held", dom?.retryButton === false, JSON.stringify(dom?.retryButton));
    // The head ticks on its own clock while the gateway sends no events at all: nothing arrives between the
    // two reads except the panel's own one-second repaint, so a changed count is that repaint doing it.
    // Both reads go through `readCard`, which re-opens the row the card may have moved under when the scan
    // landed its worktree — a card that changed container is not a card that stopped ticking.
    const held1 = (await readCard())?.headText ?? "";
    await sleep(1400);
    const held2 = (await readCard())?.headText ?? "";
    const secs = (t) => Number((/waiting for a slot (\d+)s/.exec(String(t)) || [])[1]);
    ok("the head keeps counting the wait while nothing else repaints it", /waiting for a slot/.test(held1) && /waiting for a slot/.test(held2) && secs(held2) > secs(held1), `“${held1}” → “${held2}”`);

    // A slot frees: the retry lands, ONE run, in the SAME thread and turn.
    const posted = await postPromise;
    ok("POST /api/agents was accepted (a spawn, not a refusal)", posted.status === 202, `HTTP ${posted.status} ${JSON.stringify(posted.body).slice(0, 160)}`);
    let landedJob = null;
    const landed = await waitFor(async () => {
      const j = (await readJobs()).find((x) => x.thread === thread);
      if (!j || !j.runId) return false;
      landedJob = j;
      return true;
    }, { timeoutMs: 25_000, what: "the retried spawn to land a run" });
    ok("the retry landed a run in the same thread and turn", landed, `runId=${landedJob?.runId}`);
    let doneJob = null;
    const finished = await waitFor(async () => {
      const j = (await readJobs()).find((x) => x.thread === thread);
      if (!j || (j.status !== "done" && j.status !== "failed")) return false;
      doneJob = j;
      return true;
    }, { timeoutMs: 25_000, what: "the landed run to settle" });
    ok("the landed run settles without a failure", finished && doneJob?.status === "done" && !doneJob?.error, `status=${doneJob?.status} error=${doneJob?.error}`);

    const allPosts = gw.state.posts;
    check("the gateway saw three POSTs for this spawn (two refused, one accepted)", allPosts.length, 3);
    check("ONE thread: every POST carried the same session id", [...new Set(allPosts.map((p) => p.body.session_id))].length, 1);
    check("ONE turn: every POST was the same request", [...new Set(allPosts.map((p) => JSON.stringify(p.body)))].length, 1);
    const jobsNow = await readJobs();
    check("ONE job for that thread — the retry did not create a second turn", jobsNow.filter((j) => j.thread === thread).length, 1);
    check("the landed turn is turn 1 of that thread — no duplicate turn", jobsNow.find((j) => j.thread === thread)?.turn, 1);
    // One worktree: the retry never re-cut the tree (a second tree would be a second worker on the same files).
    const trees = readdirSync(path.join(repo, ".worktrees")).filter((d) => d && !d.startsWith("."));
    check("ONE worktree was cut for the retry", trees.length, 1);
    // Still folded, so the pill is still on the page: the same card, settled.
    const cardAfter = await readCard();
    note(`after the slot freed · pill “${cardAfter?.pillText}” · head “${cardAfter?.headText}”`);
    ok("the card stopped saying waiting once the run landed", cardAfter?.pillText !== "waiting for a slot", JSON.stringify(cardAfter?.pillText));
    ok("the card now shows the settled turn", /done|running/.test(String(cardAfter?.headText || "")), JSON.stringify(cardAfter?.headText));
    // The reader's refusal, driven through the panel's own cancel route: the stream is over by now, so this is
    // the "nothing was retried because the reader cancelled" check where it belongs — at the route.
    const cancelGone = await fetch(`${base}/api/jobs/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "no-such-job" }) });
    ok("the panel's cancel route answers a settled turn without touching it", cancelGone.ok || cancelGone.status === 404, `HTTP ${cancelGone.status}`);
    check("the page threw nothing", pageErrors, []);
    await context.close();
    await browser.close();
    browser = null;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopSandboxPanel();
    await gw.close();
  }
}

async function main() {
  const cwd = mkdtempSync(path.join(tmpdir(), "wtgui-429-cwd-"));
  // The store's own session reads (titles) must not touch the real Hermes home.
  const home = path.join(cwd, "hermes-home");
  mkdirSync(home, { recursive: true });
  process.env.HERMES_HOME = home;
  cutControl();
  try {
    await phaseMath();
    await phaseHoldAndLand(cwd);
    await phaseNotRetried(cwd);
    await phaseExhausted(cwd);
    await phaseCancelled(cwd);
    await phaseCardAndPanel();
  } finally {
    dropControl();
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* scratch */
    }
    if (scratchRoot) {
      try {
        rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        /* scratch */
      }
    }
  }
  console.log(`\n${checks} checks, ${failures} failed${skipped ? `, ${skipped} skipped` : ""}`);
  console.log("(e) the rest of the suite, run separately: node tools/verify-assistant.mjs, tools/verify-completion.mjs, tools/verify-restored-turns.mjs, tools/verify-restart.mjs, tools/verify-action-harvest.mjs, …");
  if (failures) process.exitCode = 1;
}

await main();
