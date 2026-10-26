// The NOT-RUNNABLE chip on an interrupted card whose run may still exist, proved against a panel of its own and a
// real browser.
//
// WHAT WAS WRONG. A card a restart left `interrupted` kept the not-running pill, and that pill's click sends
//   "Continue if you can, exit if you are done"
// as a NEW turn. So the one card whose run the gateway may still hold — the one whose outcome could still be adopted
// and whose turn could still be steered — was the one card whose only control started a second turn underneath it.
// The panel's own write-off made it worse: "the gateway still has run <id>, so it will finish on its own, but this
// card cannot steer it" was the last word on that card, and nothing took it back once the run left the gateway.
//
// NOW. Such a card draws the SAME pill — same word, same amber, same refresh glyph, same place — and only its click
// differs (the hook `data-reattach-job`): it asks the gateway about THAT run (POST /api/jobs/reattach) before it
// starts anything, and the panel takes the decision its boot reconcile takes (lib/jobs.js settleRestoredRun — one
// implementation, not two):
//   * still live   -> the card re-attaches to that run, steers again, and its outcome is adopted when the run ends;
//   * ended        -> the run's own result is adopted on the spot;
//   * no record    -> the card settles as interrupted (promise gone, console naming the tree and the PR) AND the
//                     thread is continued on the spot: the reader pressed one control and the work is picked up.
//
// The reader is not asked to learn a second control, and the label claims only what is true of the card in every
// answer: it is not running here.
//
//   node tools/verify-reattach-chip.mjs
//
// WHAT IS DRIVEN: a real panel process (`node server.js`) on its own PANEL_CONFIG — its own port, its own store, its
// own throwaway HERMES_HOME, assistant off — over real HTTP against a stub Runs API on an ephemeral port, plus a real
// headless Chromium over the board it serves. The store is seeded the way a restart leaves it, including cards the
// OLD code wrote off (the promise in their error, and the outcome measured into it — the state the reader's own board
// is in). At boot the stub answers 5xx for the runs that must keep their verdict ("the gateway cannot answer for this
// run" is not an answer, so no card is written off on a guess) and a live answer for the one run that must come back
// running through the automatic path. Then, one card at a time, that run's real answer is given to the stub and the
// CHIP IS CLICKED IN THE BROWSER: the re-attach and its adopted outcome, the adoption of a run that had already
// finished, and the write-off that names the tree — plus the chip's absence on a card that is running again, on a
// finished one, and on one the gateway has already said it has no record of.
//
// WHAT IS ONLY INSPECTED: the PR's URL form, and nothing else. A row carries the PR its branch has, which the scan
// reads from `gh pr list` — a sandbox has no such PR, so the presses below can only produce the panel's "knows no PR
// for <branch>" line. runGonePointerLines is imported and called directly for the URL form, which drives the WORDING
// (the wiring is what the panel presses above drive). That card's press is also driven at the route rather than by a
// click, because it is owned by a row and the browser half deliberately needs no project section on the page.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGonePointerLines } from "../lib/jobs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);

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
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- the browser half ----------------------------------------------------------------------------
function loadPlaywright() {
  const roots = [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      return require(path.join(root, "node_modules", "playwright"));
    } catch {
      /* not there */
    }
    try {
      return require(root);
    } catch {
      /* not there */
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

// ---- the stub Runs API ---------------------------------------------------------------------------
// It answers what a real gateway answers: capabilities, one run's status, its event stream, and a steer. Each run is
// given its answer by the test — `{ code: 500 }` means "the gateway is up and will not answer FOR this run", which is
// the one kind of answer that must leave a card's verdict alone.
function makeStub() {
  const answers = new Map();
  const seen = { status: [], events: [], steer: [], wakeRuns: 0, submitted: [] };
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
      // Recorded, not just counted: the pick-up half of the not-found answer is proved by the run the panel ASKS for.
      seen.submitted.push(await readBody(req));
      seen.wakeRuns += 1;
      return json(200, { run_id: `stub-wake-${seen.wakeRuns}`, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      const a = answers.get(id) || null;
      if (sub === "/steer") {
        seen.steer.push({ id, body: await readBody(req) });
        return json(200, { accepted: true, run_id: id }, res);
      }
      if (sub === "/stop") return json(200, { ok: true }, res);
      if (sub === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const timer = setInterval(() => {
          const cur = answers.get(id) || null;
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
      if (a.code && a.code !== 200) return json(a.code, a.body || { error: { message: `stub ${a.code}`, code: "stub_error" } }, res);
      return json(200, { run_id: id, ...a }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  const set = (id, body) => answers.set(id, body);
  const gone = (id) => answers.delete(id); // a run the gateway no longer has: 404
  const close = () =>
    new Promise((r) => {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return { answers, seen, server, set, gone, close };
}

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-reattach-chip-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
const logsDir = path.join(configDir, "logs");
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, cwdDir, logsDir]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
// A worktree of the sandbox repo, on a branch of its own: the card whose press is driven at the route is owned by
// it, so that press has a ROW to read a branch off (a sandbox checkout row carries no branch of its own).
const TREE = path.join(repo, ".worktrees", "branch-the-work");
git(repo, ["worktree", "add", "-q", "-b", "wtgui/reattach-pointer-abc123", TREE]);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
const port = await freePort();
const configPath = path.join(configDir, "config.json");
const jobsPath = path.join(logsDir, "jobs.json");
const base = `http://127.0.0.1:${port}`;

// ---- the store a restart left behind -------------------------------------------------------------
const START = "2026-10-25T21:04:11.400Z";
const LAST = Date.parse("2026-10-25T21:19:02.351Z");
const writtenOff = (runId) => `the panel restarted while this was running — the gateway still has run ${runId}, so it will finish on its own, but this card cannot steer it`;
const settled = (runId) => `the panel restarted while this was running — the gateway no longer has run ${runId}, so its outcome was never seen here`;
const ANSWER = "Answered after the panel came back, with the work committed.";
const card = (id, over = {}) => ({
  id,
  thread: `wtgui-reattach-${id}`,
  turn: 1,
  prompt: `the turn behind ${id}`,
  cwd: cwdDir,
  projectPath: null,
  ownerPath: null,
  sessionId: `wtgui-reattach-${id}`,
  status: "running",
  exitCode: null,
  startedAt: START,
  endedAt: null,
  runId: RUN_OF[id],
  worktree: false,
  existing: false,
  lines: [
    { kind: "tool", lid: 1, at: LAST - 60_000, text: "\u{1F4BB} terminal · build it" },
    { kind: "tool", lid: 2, at: LAST, text: "\u{1F4BB} terminal · KEY=\u2026 + 2 commands" },
  ],
  ...over,
});
// Every card and the run it belongs to, named together: a seeding loop cannot drift from the store it seeds.
const RUN_OF = {
  "j-healthy": "run_healthy",
  "j-finished": "run_finished",
  "j-chip-live": "run_live",
  "j-chip-done": "run_done",
  "j-chip-gone": "run_gone",
  "j-chip-gone-owned": "run_gone_owned",
  "j-known-gone": "run_known_gone",
};
const chipCards = ["j-chip-live", "j-chip-done", "j-chip-gone"];
writeFileSync(
  jobsPath,
  JSON.stringify({
    savedAt: START,
    jobs: [
      // A turn the restart cut off whose run the gateway STILL HAS: the boot reconcile re-attaches this one, which is
      // what makes it the healthy/running card the chip must stay off.
      card("j-healthy"),
      // …and one that had already finished before the panel came back.
      card("j-finished", { status: "done", exitCode: 0, endedAt: new Date(LAST).toISOString() }),
      // The three cards the chip is for, each written off by the old code — the promise in the error and the outcome
      // measured into it, exactly the state the reader's own sticky cards are in.
      ...chipCards.map((id) =>
        card(id, {
          status: "interrupted",
          endedAt: new Date(LAST).toISOString(),
          error: writtenOff(RUN_OF[id]),
          outcome: { word: "interrupted", exitCode: null, source: null, reason: writtenOff(RUN_OF[id]) },
        }),
      ),
      // A fourth, owned by a worktree of the sandbox repo: its press is driven at the route, because the branch a row
      // knows is what the pointer lines name.
      card("j-chip-gone-owned", {
        status: "interrupted",
        endedAt: new Date(LAST).toISOString(),
        cwd: TREE,
        projectPath: repo,
        ownerPath: TREE,
        existing: true,
        error: writtenOff(RUN_OF["j-chip-gone-owned"]),
        outcome: { word: "interrupted", exitCode: null, source: null, reason: writtenOff(RUN_OF["j-chip-gone-owned"]) },
      }),
      // A card the gateway has ALREADY been asked about and had no record of: the promise is cleared, and there is
      // nothing left to re-attach to, so no chip.
      card("j-known-gone", {
        status: "interrupted",
        endedAt: new Date(LAST).toISOString(),
        runGone: true,
        error: settled(RUN_OF["j-known-gone"]),
        outcome: { word: "interrupted", exitCode: null, source: null, reason: settled(RUN_OF["j-known-gone"]) },
      }),
    ],
  }),
);
const seededText = readFileSync(jobsPath, "utf8");
ok("the store handed to the panel carries the old write-off wording", seededText.includes(writtenOff("run_live")));

// At boot the gateway will not answer FOR the runs whose verdicts must stand (5xx), re-attaches the one run it still
// has, and has no record of the card that is already settled.
for (const id of ["j-finished", "j-chip-live", "j-chip-done", "j-chip-gone", "j-chip-gone-owned"]) {
  stub.set(RUN_OF[id], { code: 500, body: { error: { message: "internal error" } } });
}
stub.set(RUN_OF["j-healthy"], { status: "running" });
stub.gone(RUN_OF["j-known-gone"]);

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
const panelSaid = (re) => panelLog.some((l) => re.test(l));
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
const runAnswer = (id, body) => stub.set(RUN_OF[id], body);

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

// The chip's own DOM facts, read off the card the reader sees.
const chipState = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${t}"]`);
    if (!card) return { card: false };
    // The behavioural hook is what marks the pill whose click asks the gateway first, and it is how this script
    // tells that pill apart from the plain one — the two read the same and are drawn the same, on purpose.
    const chip = card.querySelector("[data-reattach-job]");
    const plain = card.querySelector("button.pill-continue");
    const running = card.querySelector(".pill-running");
    // Measured, not asserted by class name: "the same control as every stopped card" is about the ink.
    const ink = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderTopStyle, cs.borderTopWidth, cs.textTransform].join("|");
    };
    return {
      card: true,
      chip: Boolean(chip),
      chipText: chip ? chip.textContent.trim() : null,
      chipTag: chip ? chip.tagName : null,
      chipType: chip ? chip.getAttribute("type") : null,
      chipTitle: chip ? chip.title : null,
      chipClasses: chip ? [...chip.classList].sort() : null,
      chipInk: ink(chip),
      plainInk: ink(plain),
      plainText: plain ? plain.textContent.trim() : null,
      runningPill: running ? running.textContent.trim() : null,
      continuePill: plain ? plain.textContent.trim() : null,
    };
  }, thread);
const clickChip = (page, thread) => page.click(`.job[data-thread="${thread}"] .pill-reattach`);
// The card is repainted from the job event the decision emits, a frame behind the store: poll for the chip to leave
// rather than reading one paint.
const chipGone = (page, thread) => waitFor(async () => (await chipState(page, thread)).chip === false, { timeoutMs: 10_000, what: `the chip to leave ${thread}` });

let err = null;
let pw = null;
let browser = null;
try {
  // ── phase 1: a panel of its own, and the verdicts a 5xx must leave alone ─────────────────────
  console.log(`\nphase 1 — a panel of its own (PANEL_CONFIG, port ${port}, stub at ${stubUrl})`);
  await startPanel();
  const logText = panelLog.join("\n");
  ok("the panel logged the port from the sandbox config", logText.includes(`agent-worktree-gui on http://127.0.0.1:${port}`), `port ${port}`);
  ok("...and the stub it was pointed at, not the live gateway", logText.includes(`agent transport: ${stubUrl}`));
  ok("...and nothing bound the live panel's port", !panelLog.some((l) => /:7331\b/.test(l)));
  ok("it restored the seeded cards from the sandbox store", await waitFor(() => panelSaid(/restored 7 job\(s\) from/), { timeoutMs: 30_000, what: "the seeded store to be restored" }), panelLog.find((l) => /restored 7 job/.test(l)) || "");
  ok("the boot reconcile re-attached the run the gateway still had", await waitFor(() => panelSaid(/run j-healthy: the gateway still has this run \(run_healthy\) — re-attached instead of writing it off/), { timeoutMs: 20_000, what: "the automatic re-attach" }));
  ok("...and wrote off none of the cards a 5xx is not allowed to settle", /reconciled 1 turn\(s\) a restart cut off: j-healthy(\n|$)/.test(logText) && !/reconciled .*j-chip/.test(logText), panelLog.find((l) => /reconciled \d+ turn/.test(l)) || "no reconcile line");

  const healthy = await cardFor("j-healthy");
  check("the card whose run came back is running again", healthy?.status, "running");
  check("...with no error left on it", healthy?.error, null);
  for (const id of chipCards) {
    const c = await cardFor(id);
    check(`${id} keeps the interrupted verdict the 5xx is not allowed to change`, c?.status, "interrupted");
    ok(`...and still carries the promise it was written off with`, /will finish on its own/.test(c?.error || ""), c?.error || "");
    check(`...and is not marked as a run the gateway has lost`, c?.runGone, false);
  }
  const knownGone = await cardFor("j-known-gone");
  check("the card the gateway already disowned keeps its settled verdict", knownGone?.status, "interrupted");
  ok("...with the settled wording, not the promise", /the gateway no longer has run run_known_gone/.test(knownGone?.error || "") && !/will finish on its own/.test(JSON.stringify(knownGone)), knownGone?.error || "");

  // ── phase 2: the chip, in a real browser over the board this panel serves ─────────────────────
  console.log("\nphase 2 — the chip: present on the right cards and absent on the others");
  pw = loadPlaywright();
  if (!pw) throw new Error("BROWSER-HALF-NOT-RUN");
  browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const allThreads = ["j-healthy", "j-finished", ...chipCards, "j-chip-gone-owned", "j-known-gone"].map((id) => `wtgui-reattach-${id}`);
  const drawn = await waitFor(async () => (await page.$$eval(".job[data-thread]", (els) => els.map((e) => e.dataset.thread))).filter((t) => allThreads.includes(t)).length >= allThreads.length, {
    timeoutMs: 30_000,
    what: "every seeded card to be drawn",
  });
  ok("every seeded card is on the board", drawn, `${(await page.$$eval(".job[data-thread]", (els) => els.map((e) => e.dataset.thread))).filter((t) => allThreads.includes(t)).length} of ${allThreads.length}`);

  const healthyState = await chipState(page, "wtgui-reattach-j-healthy");
  check("a card that is running again has no chip", healthyState.chip, false);
  check("...it carries the running pill instead", healthyState.runningPill, "running");
  const finishedState = await chipState(page, "wtgui-reattach-j-finished");
  check("a finished card has no re-attach pill", finishedState.chip, false);
  check("...it keeps the ordinary not-running pill", finishedState.continuePill, "not-running\u21bb");
  ok("...which is a plain continue pill, with no hook of its own", finishedState.continuePill === "not-running\u21bb" && !finishedState.chipClasses, JSON.stringify(finishedState.chipClasses));
  const finishedInk = (await chipState(page, "wtgui-reattach-j-finished")).plainInk;
  ok("the plain pill was measured for the comparison (a card in the same page carries it)", Boolean(finishedInk), String(finishedInk));
  const knownState = await chipState(page, "wtgui-reattach-j-known-gone");
  check("a card whose run the gateway has already disowned has no chip", knownState.chip, false);
  ok("...and still offers the ordinary continue pill", /not-running/.test(knownState.continuePill || ""), knownState.continuePill || "");

  for (const id of chipCards) {
    const s = await chipState(page, `wtgui-reattach-${id}`);
    check(`${id}: the re-attach pill is there, on a card whose run may still exist`, s.chip, true);
    check("...it is a button, not a badge", [s.chipTag, s.chipType], ["BUTTON", "button"]);
    check("...and it reads not-running, the word every stopped card carries", s.chipText, "not-running\u21bb");
    ok("...wearing that pill's own classes", (s.chipClasses || []).includes("pill") && (s.chipClasses || []).includes("pill-notrunning"), JSON.stringify(s.chipClasses));
    check("...drawn in the plain not-running pill's own ink", s.chipInk, finishedInk);
    ok("...while its tooltip says all three answers, and promises only the press", /click to pick this up/.test(s.chipTitle || "") && /re-attaches/.test(s.chipTitle || "") && /this thread is continued/.test(s.chipTitle || ""), s.chipTitle);
    check("...and the plain continue pill is gone from that card (it would start a second turn)", s.continuePill, null);
  }

  // ── phase 3: the three answers, one press each ────────────────────────────────────────────────
  console.log("\nphase 3a — still live: the card re-attaches, and its outcome is adopted when the run ends");
  runAnswer("j-chip-live", { status: "running" });
  await clickChip(page, "wtgui-reattach-j-chip-live");
  const reattached = await waitFor(async () => (await cardFor("j-chip-live"))?.status === "running", { timeoutMs: 20_000, what: "the press to re-attach the card" });
  ok("a press on a run the gateway still has puts the card back to running", reattached, JSON.stringify((await cardFor("j-chip-live"))?.status));
  const liveCard = await cardFor("j-chip-live");
  check("...with the promise cleared off it", liveCard?.error, null);
  check("...and the outcome the promise was measured into gone", liveCard?.outcome, null);
  ok("...and the console says the panel re-attached to that run", /re-attached to it and can steer it again/.test(textOf(liveCard)), textOf(liveCard).slice(-200));
  ok("...and the chip is off the card now that it is running again", await chipGone(page, "wtgui-reattach-j-chip-live"));

  runAnswer("j-chip-live", { status: "completed", exit_code: 0, output: ANSWER, usage: { total_tokens: 900, input_tokens: 700, output_tokens: 200 } });
  const adoptedEnd = await waitFor(async () => (await cardFor("j-chip-live"))?.status === "done", { timeoutMs: 25_000, what: "the re-attached run's own ending to be adopted" });
  ok("the run's own ending is adopted on the re-attached stream", adoptedEnd);
  const liveDone = await cardFor("j-chip-live");
  check("...as done", liveDone?.status, "done");
  check("...with the exit status the run reported", liveDone?.exitCode, 0);
  ok("...and the answer it ended on is on its console", textOf(liveDone).includes(ANSWER), textOf(liveDone).slice(-200));
  check("...and the outcome word is the run's own", liveDone?.outcome?.word, "normal");

  console.log("\nphase 3b — already ended: one press adopts the run's result");
  runAnswer("j-chip-done", { status: "completed", exit_code: 0, output: ANSWER, usage: { total_tokens: 1200, input_tokens: 900, output_tokens: 300 } });
  await clickChip(page, "wtgui-reattach-j-chip-done");
  const adopted = await waitFor(async () => (await cardFor("j-chip-done"))?.status === "done", { timeoutMs: 20_000, what: "the press to adopt the finished run" });
  ok("a press on a run that had ended adopts its result", adopted);
  const doneCard = await cardFor("j-chip-done");
  check("...as done, not interrupted", doneCard?.status, "done");
  check("...with the exit status the run reported", doneCard?.exitCode, 0);
  ok("...with its answer on the console", textOf(doneCard).includes(ANSWER), textOf(doneCard).slice(-200));
  ok("...with no write-off wording left anywhere on it", !/will finish on its own/.test(JSON.stringify(doneCard)));
  ok("...and its notice carries the run's own words", /Answered after the panel came back/.test(JSON.stringify(doneCard?.completion || {})), JSON.stringify(doneCard?.completion?.final || {}).slice(0, 160));
  ok("...and the chip went with the settled card", await chipGone(page, "wtgui-reattach-j-chip-done"));

  console.log("\nphase 3c — no record: the card settles, the promise goes, and the tree is named");
  stub.gone(RUN_OF["j-chip-gone"]);
  await clickChip(page, "wtgui-reattach-j-chip-gone");
  const wroteOff = await waitFor(async () => !!(await cardFor("j-chip-gone"))?.runGone, { timeoutMs: 20_000, what: "the press to settle the card whose run is gone" });
  ok("a press on a run the gateway has no record of settles the card", wroteOff);
  const goneCard = await cardFor("j-chip-gone");
  check("...the verdict is still interrupted", goneCard?.status, "interrupted");
  ok("...the promise is replaced by what the gateway said", goneCard?.error === settled(RUN_OF["j-chip-gone"]), goneCard?.error || "");
  ok("...nothing on the card still promises a finish", !/will finish on its own/.test(JSON.stringify(goneCard)));
  ok("...and its notice promises nothing either", !/will finish on its own/.test(JSON.stringify(goneCard?.completion || {})));
  ok("...and the console names the tree the turn worked in", textOf(goneCard).includes(cwdDir), textOf(goneCard).slice(-260));
  ok("...and says the work on disk is untouched", /lost nothing on disk/.test(textOf(goneCard)), textOf(goneCard).slice(-200));
  ok("...and the pill stops asking the gateway, because there is nothing left to ask", await chipGone(page, "wtgui-reattach-j-chip-gone"));
  const asked = () => stub.seen.submitted.filter((b) => String(b.session_id || "") === "wtgui-reattach-j-chip-gone");
  const pickedUp = await waitFor(() => asked().length > 0, { timeoutMs: 20_000, what: "the press to continue the thread" });
  ok("...and one press picks the work up: the thread is continued on the spot", pickedUp, JSON.stringify(stub.seen.submitted.map((b) => [b.session_id, String(b.input || "").slice(0, 50)])));
  check("...with exactly one run asked for, not a second turn as well", asked().length, 1);
  ok("...carrying the panel's own continue nudge, so the agent decides what is left", /Continue if you can, exit if you are done/.test(String(asked()[0]?.input || "")), String(asked()[0]?.input || "").slice(0, 160));
  check("no page error was thrown while the presses ran", pageErrors, []);

  console.log("\nphase 4 — the same press on a card owned by a row, and the branch it names");
  let stateRows = { projects: [] };
  // A tree is put on the board as a placeholder the moment it is discovered (verdict "…", no branch), and the
  // full scan fills it in a moment later. The press reads THAT branch, so wait for the scan, not for the row.
  const ownsRow = await waitFor(async () => {
    stateRows = (await api("/api/state")).body || { projects: [] };
    const rows = (stateRows.projects || []).flatMap((x) => x.worktrees || []);
    return rows.some((w) => norm(w.path) === norm(TREE) && w.branch === "wtgui/reattach-pointer-abc123");
  }, { timeoutMs: 60_000, what: "the sandbox worktree's own row to be scanned" });
  const boardProject = (stateRows.projects || []).find((x) => (x.worktrees || []).some((w) => norm(w.path) === norm(TREE))) || null;
  const boardRow = (boardProject?.worktrees || []).find((w) => norm(w.path) === norm(TREE)) || null;
  ok("the board knows the sandbox worktree's own row (so the press has a branch to name)", ownsRow);
  note(`the row the press will name: project ${boardProject?.name || "(none)"} · branch ${boardRow?.branch || "(none)"} · path ${boardRow?.path || "(none)"}`);
  stub.gone(RUN_OF["j-chip-gone-owned"]);
  const ownedPress = await api("/api/jobs/reattach", { id: "j-chip-gone-owned" });
  check("the route answers the press", [ownedPress.status, ownedPress.body?.ok, ownedPress.body?.action], [200, true, "gone"]);
  note(`the pointers the press used: ${JSON.stringify(ownedPress.body?.pointers || null)}`);
  ok("...with the tree and the branch it read off the row", norm(ownedPress.body?.pointers?.worktree || "") === norm(TREE) && ownedPress.body?.pointers?.branch === "wtgui/reattach-pointer-abc123", JSON.stringify(ownedPress.body?.pointers || null));
  ok("...and no PR, because a sandbox has no gh-listed one", ownedPress.body?.pointers?.pr === null, JSON.stringify(ownedPress.body?.pointers?.pr ?? null));
  const ownedCard = await cardFor("j-chip-gone-owned");
  ok("...whose console names the tree the turn worked in", norm(textOf(ownedCard)).includes(norm(TREE)), textOf(ownedCard).slice(-300));
  ok("...and the branch that row is on", / · branch wtgui\/reattach-pointer-abc123 /.test(textOf(ownedCard)), textOf(ownedCard).slice(-200));
  ok("...and says the panel knows no PR for it (a sandbox has no gh-listed PR)", /the panel knows no PR for wtgui\/reattach-pointer-abc123/.test(textOf(ownedCard)), textOf(ownedCard).slice(-200));
  ok("...and the panel knows no PR rather than inventing one", !/PR #/.test(textOf(ownedCard)), textOf(ownedCard).slice(-200));

  console.log("\nphase 5 — what the pointer wording does with a PR, and what the panel now keeps");
  const withPr = runGonePointerLines({ worktree: "C:/w/tree", branch: "wtgui/thing-abc123", pr: { number: 28, state: "OPEN", title: "Land the thing", url: "https://github.com/o/r/pull/28" } });
  const prLine = String((withPr.find((l) => /PR #/.test(l.text)) || {}).text || "");
  ok("a PR the panel knows is pointed at by its number and state", /^PR #28 \(OPEN\)/.test(prLine), prLine);
  ok("...its title, so the reader knows which PR", /Land the thing/.test(prLine), prLine);
  ok("...and its URL, the one form the console renders as a link", /https:\/\/github\.com\/o\/r\/pull\/28$/.test(prLine), prLine);
  ok("...over a tree line that names the tree and the branch", /C:\/w\/tree/.test(withPr[0].text) && / · branch wtgui\/thing-abc123 /.test(withPr[0].text), withPr[0].text);
  const noPr = runGonePointerLines({ worktree: "C:/w/tree", branch: "main" });
  ok("with no PR known, the branch itself is named instead of a phantom PR", noPr.length === 2 && /the panel knows no PR for main/.test(noPr[1].text) && !/PR #/.test(noPr[1].text), noPr.map((l) => l.text).join(" | "));
  check("and nothing at all is written when there is nothing to point at", runGonePointerLines(null), []);
  check("...or when the caller handed it nothing", runGonePointerLines({}), []);

  const persisted = await waitFor(() => {
    try {
      const saved = JSON.parse(readFileSync(jobsPath, "utf8"));
      return saved.jobs?.find((j) => j.id === "j-chip-gone")?.runGone === true;
    } catch {
      return false;
    }
  }, { timeoutMs: 20_000, what: "the panel to persist the settled card" });
  ok("the panel persisted the card it settled", persisted);
  const noPromise = await waitFor(() => !readFileSync(jobsPath, "utf8").includes("will finish on its own"), { timeoutMs: 20_000, what: "the panel to rewrite the store without the promise" });
  ok("the promise is gone from the store on disk", noPromise);
  await sleep(400);
  const savedText = readFileSync(jobsPath, "utf8");
  ok("...and the 404's verdict is what the store keeps", /the gateway no longer has run run_gone/.test(savedText));
  // A wake is a run the panel posts into the assistant's own session; the only run asked for here is the pick-up the
  // not-found press earned, so the check is on the session, not on the count.
  ok("no wake was ever posted to the assistant's own session", !stub.seen.submitted.some((b) => String(b.session_id || "") === "panel-assistant"), JSON.stringify(stub.seen.submitted.map((b) => b.session_id)));
} catch (e) {
  if (String((e && e.message) || e) === "BROWSER-HALF-NOT-RUN") {
    console.log("\nBROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-reattach-chip.mjs");
    err = e;
    failures += 1;
  } else {
    err = e;
    failures += 1;
    console.log(`\nphases threw: ${String((e && e.message) || e)}`);
    console.log(panelLog.slice(-25).join("\n"));
  }
} finally {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  await stopPanel();
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nDRIVEN: a real panel on PANEL_CONFIG :${port} over HTTP (GET /api/jobs, POST /api/jobs/reattach) against a`);
console.log("        stub Runs API on an ephemeral port, and a real headless Chromium over the board it serves: the");
console.log("        pill's presence/absence and ink, three presses (one per gateway answer), the write-off's own lines,");
console.log("        and the run the not-found press ASKS for — the pick-up — recorded off the stub.");
console.log("INSPECTED: the PR's URL form — a sandbox has no gh-listed PR, so runGonePointerLines was called directly for");
console.log("        that wording; the panel-driven presses above drove the wiring. :7331 and :8642 are never touched.");
console.log(err ? `RESULT: threw — ${String(err.message || err)}` : failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exitCode = err || failures ? 1 : 0; // process.exitCode: a piped stdout must not lose the report
