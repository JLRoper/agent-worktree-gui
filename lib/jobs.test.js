// The manual re-attach decision, and the refusal that keeps a TO out of a busy thread — driven against a sandbox
// PANEL_CONFIG. Sibling of tools/verify-reattach-chip.mjs, which drives the same press through a real browser and
// asserts the chip's DOM; this file drives the LOGIC: the store the chip is drawn from, the route the press posts to,
// and the answer each of the three gateway replies leaves behind.
//
//   node lib/jobs.test.js
//
// WHAT IS DRIVEN: a real panel process (`node server.js`) on its own PANEL_CONFIG — its own port, own store, own
// throwaway HERMES_HOME, assistant off — over real HTTP against a stub Runs API on an ephemeral port:
//
//   1. the store the chip is drawn from: `interrupted` + a run id + no 404 is the card that offers it; a running card,
//      a finished card and a card the gateway has already disowned are all NOT that card;
//   2. the three answers, each pressed through POST /api/jobs/reattach: a run the gateway still has is re-attached
//      (and its own ending is adopted when it comes), a run that had ended has its result adopted, and a run the
//      gateway has no record of is written off with the tree and the branch on the console;
//   3. the busy-thread refusal: POST /api/assistant/answer into a thread (or a tree) that already has a live run is
//      409 and posts nothing, while the same call into a free thread still goes out.
//
// WHAT IS ONLY INSPECTED: the DOM. Which element carries the chip, and that it reads `not-running` in the plain pill's
// own ink, is driven in tools/verify-reattach-chip.mjs against a real headless browser; this file asserts the payload
// that renderer reads. :7331 and :8642 are never touched.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Jobs } from "./jobs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 30_000, stepMs = 250, what = "condition" } = {}) {
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
const git = (dir, args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- the stub Runs API ---------------------------------------------------------------------------
// An id in `answers` is a run the gateway has; a terminal answer ends its stream; every other id is a run the gateway
// still holds and whose stream is simply kept open. `gone(id)` deletes the record, which is what a 404 means here.
function makeStub() {
  const answers = new Map();
  const seen = { submitted: [], status: [] };
  const timers = [];
  const json = (code, body, res) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
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
      return json(200, { version: "sandbox-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      seen.submitted.push(await readBody(req));
      return json(200, { run_id: `stub-run-${seen.submitted.length}`, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      const a = answers.get(id);
      if (sub === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const timer = setInterval(() => {
          const cur = answers.get(id);
          if (!cur || cur.status === "running") {
            res.write(": hold\n\n");
            return;
          }
          clearInterval(timer);
          if (cur.output) res.write(`event: message.delta\ndata: ${JSON.stringify({ event: "message.delta", delta: `\n\n${cur.output}` })}\n\n`);
          res.write(`event: run.${cur.status}\ndata: ${JSON.stringify({ event: `run.${cur.status}`, output: cur.output, usage: cur.usage, exit_code: cur.exit_code })}\n\n`);
          res.end();
        }, 150);
        timers.push(timer);
        req.on("close", () => clearInterval(timer));
        return;
      }
      seen.status.push(id);
      if (!a) return json(404, { error: { message: "Run not found", code: "run_not_found" } }, res);
      if (a.code && a.code !== 200) return json(a.code, { error: { message: `stub ${a.code}`, code: "stub_error" } }, res);
      return json(200, { run_id: id, ...a }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  return {
    answers,
    seen,
    server,
    set: (id, body) => answers.set(id, body),
    gone: (id) => answers.delete(id),
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-jobs-test-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
const treeA = path.join(dir, "tree-a");
const treeB = path.join(dir, "tree-b");
const logsDir = path.join(configDir, "logs");
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, cwdDir, logsDir, treeA, treeB]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
const port = await freePort();
const configPath = path.join(configDir, "config.json");
const jobsPath = path.join(logsDir, "jobs.json");
const base = `http://127.0.0.1:${port}`;

// ---- the store the test hands the panel ----------------------------------------------------------
const START = "2026-10-26T02:10:00.000Z";
const LAST = Date.parse("2026-10-26T02:24:00.000Z");
const writtenOff = (runId) => `the panel restarted while this was running — the gateway still has run ${runId}, so it will finish on its own, but this card cannot steer it`;
const settled = (runId) => `the panel restarted while this was running — the gateway no longer has run ${runId}, so its outcome was never seen here`;
const card = (id, runId, over = {}) => ({
  id,
  thread: `wtgui-${id}`,
  turn: 1,
  prompt: `the turn behind ${id}`,
  cwd: cwdDir,
  projectPath: null,
  ownerPath: null,
  sessionId: `wtgui-${id}`,
  status: "running",
  exitCode: null,
  startedAt: START,
  endedAt: null,
  runId,
  worktree: false,
  existing: false,
  lines: [{ kind: "tool", lid: 1, at: LAST, text: "\u{1F4BB} terminal · build it" }],
  ...over,
});
writeFileSync(
  jobsPath,
  JSON.stringify({
    savedAt: START,
    jobs: [
      // A run the gateway still has: the boot reconcile re-attaches it, which is what makes this the healthy card.
      card("j-healthy", "run_healthy"),
      // …and one that was already over before the panel came back.
      card("j-finished", "run_finished", { status: "done", exitCode: 0, endedAt: new Date(LAST).toISOString() }),
      // The three cards the chip is for, each written off by the old code.
      card("j-live", "run_live", { status: "interrupted", endedAt: new Date(LAST).toISOString(), branch: "wtgui/fixture-abc123", error: writtenOff("run_live"), outcome: { word: "interrupted", exitCode: null, source: null, reason: writtenOff("run_live") } }),
      card("j-terminal", "run_terminal", { status: "interrupted", endedAt: new Date(LAST).toISOString(), error: writtenOff("run_terminal"), outcome: { word: "interrupted", exitCode: null, source: null, reason: writtenOff("run_terminal") } }),
      card("j-gone", "run_gone", { status: "interrupted", endedAt: new Date(LAST).toISOString(), branch: "wtgui/fixture-abc123", error: writtenOff("run_gone"), outcome: { word: "interrupted", exitCode: null, source: null, reason: writtenOff("run_gone") } }),
      // …and one the gateway has already been asked about: no chip, because there is nothing left to ask.
      card("j-known-gone", "run_known_gone", { status: "interrupted", endedAt: new Date(LAST).toISOString(), runGone: true, error: settled("run_known_gone"), outcome: { word: "interrupted", exitCode: null, source: null, reason: settled("run_known_gone") } }),
      // The busy-thread fixtures: a live run, an idle thread in the same tree, and a free thread in a tree of its own.
      card("j-busy", "run_busy", { status: "running", thread: "wtgui-busy", cwd: treeA, ownerPath: treeA }),
      card("j-idle-mate", "run_idle_mate", { status: "done", exitCode: 0, endedAt: new Date(LAST).toISOString(), thread: "wtgui-idle-mate", cwd: treeA, ownerPath: treeA }),
      card("j-free", "run_free", { status: "done", exitCode: 0, endedAt: new Date(LAST).toISOString(), thread: "wtgui-free", cwd: treeB, ownerPath: treeB }),
    ],
  }),
);
ok("the store handed to the panel carries the old write-off wording", readFileSync(jobsPath, "utf8").includes(writtenOff("run_live")));

// At boot: the gateway will not answer FOR the runs whose verdicts must stand (a 5xx is not a verdict), it still has
// the healthy run and the busy one, and it has no record of the one that is already settled.
stub.set("run_healthy", { status: "running" });
stub.set("run_busy", { status: "running" });
stub.gone("run_known_gone");
for (const id of ["run_live", "run_terminal", "run_gone", "run_finished", "run_idle_mate", "run_free"]) {
  stub.set(id, { code: 500, body: { error: { message: "internal error" } } });
}

writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootDir],
      refreshSeconds: 5,
      worktreeSeconds: 2,
      midSeconds: 10,
      dormantSeconds: 20,
      slowSeconds: 30,
      fetchSeconds: 3600,
      threads: 1,
      scanMode: "all",
      defaultCwd: cwdDir,
      jobsFile: jobsPath,
      projectsCacheFile: path.join(logsDir, "projects.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      assistant: { enabled: false },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const panelLog = [];
let panel = null;
const api = async (route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const cardFor = async (id) => (await api("/api/jobs")).body.jobs?.find((j) => j.id === id) || null;
const textOf = (j) => (j?.lines || []).map((l) => String(l.text || "")).join("\n");
const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 60_000, stepMs: 400, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  try {
    p.kill();
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 10_000, what: "the panel to exit" });
  } catch {
    /* fall through to the hard kill */
  }
  if (p.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
  }
  p.stdout?.destroy();
  p.stderr?.destroy();
  await sleep(300);
};

let err = null;
try {
  // ── 1. a panel of its own, and the verdicts a 5xx must leave alone ──────────────────────────────
  console.log(`\nphase 1 — a panel on its own PANEL_CONFIG (port ${port}, stub at ${stubUrl})`);
  await startPanel();
  const logText = panelLog.join("\n");
  ok("the panel logged the sandbox port", logText.includes(`agent-worktree-gui on http://127.0.0.1:${port}`), `port ${port}`);
  ok("…and the stub it was pointed at, not the live gateway", logText.includes(`agent transport: ${stubUrl}`));
  ok("…and nothing bound the live panel's port", !panelLog.some((l) => /:7331\b/.test(l)));
  ok("it restored the seeded cards", await waitFor(() => panelLog.some((l) => /restored 9 job\(s\) from/.test(l)), { timeoutMs: 30_000, what: "the seeded store" }), panelLog.find((l) => /restored 9 job/.test(l)) || "");
  ok("the boot reconcile re-attached the run the gateway still had", await waitFor(() => panelLog.some((l) => /run j-healthy: the gateway still has this run \(run_healthy\)/.test(l)), { timeoutMs: 20_000, what: "the automatic re-attach" }));
  check("the card whose run came back is running", (await cardFor("j-healthy"))?.status, "running");
  for (const id of ["j-live", "j-terminal", "j-gone"]) {
    const c = await cardFor(id);
    check(`${id} keeps its interrupted verdict (a 5xx is not a verdict)`, c?.status, "interrupted");
    ok(`…and still carries the promise it was written off with`, /will finish on its own/.test(c?.error || ""), c?.error || "");
  }

  // ── 2. the store the chip is drawn from ─────────────────────────────────────────────────────────
  console.log("\nphase 2 — the store the chip reads: interrupted + a run id + no 404");
  // The same predicate the card renders from (public/app.js `runMayStillExist`).
  const offersChip = (c) => c?.status === "interrupted" && Boolean(c?.runId) && !c?.runGone;
  for (const id of ["j-live", "j-terminal", "j-gone"]) {
    check(`${id} is a card the chip is drawn on`, offersChip(await cardFor(id)), true);
  }
  check("a running card is not", offersChip(await cardFor("j-healthy")), false);
  check("a finished card is not", offersChip(await cardFor("j-finished")), false);
  check("a card the gateway has already disowned is not", offersChip(await cardFor("j-known-gone")), false);

  // ── 3. the three answers, each pressed through the route ────────────────────────────────────────
  console.log("\nphase 3a — still live: re-attached, and its own ending adopted");
  stub.set("run_live", { status: "running" });
  const press = (id) => api("/api/jobs/reattach", { id });
  const live = await press("j-live");
  check("the press answers ok", [live.status, live.body?.ok, live.body?.action], [200, true, "reattached"]);
  check("the card is running again", (await cardFor("j-live"))?.status, "running");
  check("…with the promise cleared", (await cardFor("j-live"))?.error, null);
  stub.set("run_live", { status: "completed", exit_code: 0, output: "Answered after the panel came back.", usage: { total_tokens: 900, input_tokens: 700, output_tokens: 200 } });
  ok("the run's own ending is adopted on the re-attached stream", await waitFor(async () => (await cardFor("j-live"))?.status === "done", { timeoutMs: 25_000, what: "the run to end" }));
  const liveDone = await cardFor("j-live");
  check("…as done, with the exit status it reported", [liveDone?.status, liveDone?.exitCode], ["done", 0]);
  ok("…its answer on the console", textOf(liveDone).includes("Answered after the panel came back."));

  console.log("\nphase 3b — ended: one press adopts the result");
  stub.set("run_terminal", { status: "completed", exit_code: 3, output: "It finished with a non-zero exit.", usage: { total_tokens: 400 } });
  const terminal = await press("j-terminal");
  check("the press answers adopted", [terminal.status, terminal.body?.action], [200, "adopted"]);
  const terminalCard = await cardFor("j-terminal");
  // `completed` maps to `done` on the stream path too (TERMINAL_STATUS), and the non-zero exit is kept beside it
  // rather than renaming the verdict — the adopt path and the live path have to agree about the same run.
  check("…the card takes the run's own verdict, with its exit status kept", [terminalCard?.status, terminalCard?.exitCode], ["done", 3]);
  ok("…with its answer on the console", textOf(terminalCard).includes("It finished with a non-zero exit."));

  console.log("\nphase 3c — no record: written off, with the work pointed at");
  stub.gone("run_gone");
  const gone = await press("j-gone");
  check("the press answers gone", [gone.status, gone.body?.action], [200, "gone"]);
  const goneCard = await cardFor("j-gone");
  check("…the verdict stays interrupted", goneCard?.status, "interrupted");
  ok("…the promise is replaced by what the gateway said", goneCard?.error === settled("run_gone"), goneCard?.error || "");
  check("…and the card is marked as one the gateway has lost", goneCard?.runGone, true);
  ok("…nothing on it promises a finish any more", !/will finish on its own/.test(JSON.stringify(goneCard)));
  ok("…its console names the tree the turn worked in", textOf(goneCard).includes(cwdDir), textOf(goneCard).slice(-240));
  ok("…and the branch its row is on", / · branch wtgui\/fixture-abc123 /.test(textOf(goneCard)), textOf(goneCard).slice(-240));
  ok("…and says which PR it knows (none, and it does not invent one)", /the panel knows no PR for wtgui\/fixture-abc123/.test(textOf(goneCard)) && !/PR #/.test(textOf(goneCard)), textOf(goneCard).slice(-240));
  ok("…and the pointers it used come back with the answer", gone.body?.pointers?.worktree && gone.body.pointers.branch === "wtgui/fixture-abc123", JSON.stringify(gone.body?.pointers || null));
  const again = await press("j-gone");
  check("pressing it again is idempotent, not a second write-off", [again.body?.action, again.body?.already], ["gone", true]);

  // ── 4. the busy-thread refusal ──────────────────────────────────────────────────────────────────
  console.log("\nphase 4 — a reply is refused, not stacked, while a run is going");
  const busyThread = "wtgui-busy";
  const beforeBusy = (await api("/api/jobs")).body.jobs.filter((j) => j.thread === busyThread).length;
  const refused = await api("/api/assistant/answer", { thread: busyThread, text: "this must not become a second run" });
  check("posting into a thread with a live run is a conflict", refused.status, 409);
  ok("…and the panel says which run holds it", /already has a live run/.test(refused.body?.error || "") && /j-busy/.test(refused.body?.error || ""), refused.body?.error || "");
  check("…and nothing was posted", (await api("/api/jobs")).body.jobs.filter((j) => j.thread === busyThread).length, beforeBusy);
  check("…and the stub was never asked for a run", stub.seen.submitted.filter((b) => b.session_id === busyThread).length, 0);
  const idleMate = await api("/api/assistant/answer", { thread: "wtgui-idle-mate", text: "a second agent in this tree" });
  check("the same call into a thread whose TREE is busy is refused too", idleMate.status, 409);
  ok("…naming the run in that tree", /that worktree already has a live run/.test(idleMate.body?.error || "") && /j-busy/.test(idleMate.body?.error || ""), idleMate.body?.error || "");
  const freeThread = await api("/api/assistant/answer", { thread: "wtgui-free", text: "nobody is working in this tree" });
  check("a thread of its own with nothing running is still answered", [freeThread.status, Boolean(freeThread.body?.job?.id)], [202, true]);
  check("…and that one DID reach the gateway", stub.seen.submitted.filter((b) => b.session_id === "wtgui-free").length, 1);

  // ── 5. the same question as an API, for the callers that do not go through the route ───────────
  console.log("\nphase 5 — Jobs.busyFor");
  const store = new Jobs({ config: { jobsFile: path.join(dir, "probe.json"), apiServer: { url: "http://127.0.0.1:9" } } });
  const seed = (over) => store.jobs.set(over.id, { lines: [], ...over });
  seed({ id: "p-live", thread: "t-live", status: "running", cwd: treeA, ownerPath: treeA });
  seed({ id: "p-idle-mate", thread: "t-idle-mate", status: "done", cwd: treeA, ownerPath: treeA });
  seed({ id: "p-free", thread: "t-free", status: "done", cwd: treeB, ownerPath: treeB });
  seed({ id: "p-interrupted", thread: "t-interrupted", status: "interrupted", cwd: treeB, ownerPath: treeB, runId: "run_x", endedAt: new Date(LAST).toISOString() });
  check("a thread that is turning is held, by that thread", [store.busyFor("t-live").held, store.busyFor("t-live").where], [true, "thread"]);
  check("a thread in a busy tree is held, by that tree", [store.busyFor("t-idle-mate").held, store.busyFor("t-idle-mate").where], [true, "tree"]);
  check("a thread in a tree of its own is not held", store.busyFor("t-free").held, false);
  check("an interrupted card is NOT busy — picking it up is the point", store.busyFor("t-interrupted").held, false);
  check("an unknown thread is not held", store.busyFor("nobody").held, false);
  ok("…and the holder is named", store.busyFor("t-live").by.map((b) => b.id), JSON.stringify(["p-live"]));

  // ── 6. the same predicate the leftover sweep asks before it blames a tree ──────────────────────
  // A tree a live run's cwd holds is that run's worktree, so the assistant raises no "uncommitted work" leftover
  // for it. `runInTree` is that question, built on runningJobs(); this is the store half of it, with the
  // assistant's own decision (no alert when held, the alert when not) driven in tools/verify-assistant.mjs.
  console.log("\nphase 6 — Jobs.runInTree");
  check("a tree a running turn works in is held", store.runInTree(treeA)?.id, "p-live");
  check("…and a tree only a finished turn worked in is not", store.runInTree(treeB), null);
  // The path a caller holds is not always the path the store wrote: a trailing slash, backslashes and case are
  // the same tree, which is what lets a row path from the scanner match a job's own cwd.
  check("…and the same tree in another spelling is still held", store.runInTree(`${treeA.toUpperCase()}\\`)?.id, "p-live");
  check("a tree nothing works in is not held", store.runInTree(path.join(dir, "no-such-tree")), null);
  check("an empty path is not a tree", store.runInTree(""), null);
  // `waiting` is a live status too — the gateway refused the POST with 429 and the panel is holding the turn, so
  // the tree is taken exactly as a running one's is. A leftover raised in that window would be just as false.
  seed({ id: "p-hold", thread: "t-hold", status: "waiting", cwd: treeB, ownerPath: treeB });
  check("a turn held on the gateway's 429 cap holds its tree too", store.runInTree(treeB)?.id, "p-hold");
  store.jobs.delete("p-hold");
  check("…and once it is gone the tree is free again", store.runInTree(treeB), null);
} catch (e) {
  err = e;
  failures += 1;
  console.log(`\nphases threw: ${String((e && e.message) || e)}`);
  console.log(panelLog.slice(-25).join("\n"));
} finally {
  await stopPanel();
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nDRIVEN: a real panel on PANEL_CONFIG :${port} (its own store, HERMES_HOME and port) over HTTP — the store`);
console.log("        the chip reads, POST /api/jobs/reattach for each of the three gateway answers, and");
console.log("        POST /api/assistant/answer refusals — against a stub Runs API on an ephemeral port.");
console.log("INSPECTED: the DOM. The chip element itself, and that it wears the plain pill's ink, is driven in");
console.log("        tools/verify-reattach-chip.mjs in a real headless browser. :7331 and :8642 are never touched.");
console.log(err ? `RESULT: threw — ${String(err.message || err)}` : failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exitCode = err || failures ? 1 : 0;
