// The green COMPLETE chip on a finished card, and what its press does — proved against two panels of its own (the
// change, and the build it replaces) plus a real browser over both, and a stub Runs API that records every run asked for.
//
//   node tools/verify-complete-chip.mjs                boot both panels from this checkout and HEAD~1
//   PANEL_BEFORE_SHA=<sha> node tools/verify-complete-chip.mjs   name the build to compare against
//
// WHAT WAS WRONG. A card whose latest turn was `done` wore the same amber pill as a card that had stopped: the word
// "not-running" over a finished turn, and a press that sent "Continue if you can, exit if you are done" to an agent that
// had already said it was done — a second turn on finished work, from the one control the reader would reach for.
//
// NOW. A card whose latest turn is exactly `done` wears the SAME pill in the same place at the same size, reading
// COMPLETE in the panel's own green, with no refresh glyph (nothing is being resumed), and its press queues ONE ask for
// the board assistant through the wake queue an alert handed over uses (POST /api/jobs/ask-complete ->
// Assistant.askAboutComplete -> wake) — never a message to the worker, and never /api/assistant/say, which starts an
// assistant turn at once and would talk over a run already in flight. The ask names the thread, the worktree, the branch
// and the run, asks for a judgement on the EVIDENCE (the commits, the PR, the report's own admissions) rather than on the
// agent's word, asks what is left for that worktree and who owns it, and says the chip was pressed. The chip says the ask
// landed; a queue that refuses it (the hourly budget, a switched-off assistant) says so on the card instead of claiming
// success.
//
// WHAT IS DRIVEN
//   * a panel of THIS checkout on its own PANEL_CONFIG (own port, own store, own throwaway HERMES_HOME) against a stub
//     Runs API on an ephemeral port — real HTTP, real job store, real wake queue, real route
//   * a second panel built by `git archive` from the PRE-CHANGE commit (HEAD~1 by default, overridable with
//     PANEL_BEFORE_SHA), with the same seeded store, for the before/after of every other status
//   * a real headless Chromium over both panels: the pill's tag, classes, word, ink, size, place and hooks, read off the
//     cards the panels actually serve
//   * the PRESSES, in the browser, on the running panel: one accepted ask, a duplicate, a budget refusal, a
//     disabled-assistant refusal, and a later ask after the assistant's turn was read — with every request the page made
//     recorded, every run the panel asked for recorded off the stub, and the job store read before and after
// WHAT IS ONLY INSPECTED (read off the source, not driven)
//   * that the COMPLETE branch is a status branch beside the continue pill's, that the re-attach pill's own line is
//     byte-identical to the one it had, that askAboutComplete reaches wake() and never say(), and that the press path is
//     one call off the chip's own hook
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one it says BROWSER-HALF-NOT-RUN and fails rather than passing
// on a half that never ran. The live panel on :7331 and the live gateway on :8642 are never touched.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { completionPayload, outcomeFrom } from "../lib/completion.js";

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

// ---- the stub Runs API --------------------------------------------------------------------------
// A real gateway's shape: capabilities, one run's status, its event stream, a steer, a stop. Every run body the panel
// posts is KEPT, because "which message left the panel, to whom" is the whole point of the press under test. The
// assistant's wakes are held open (no terminal event) unless the test answers them, so an assistant turn stays in flight
// exactly as long as the phases need it to.
function makeStub() {
  const answers = new Map();
  const seen = { submitted: [], status: [], steer: [] };
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
      const body = await readBody(req);
      seen.submitted.push(body);
      const runId = `stub-run-${seen.submitted.length}`;
      return json(200, { run_id: runId, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
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
      const a = answers.get(id) || null;
      if (!a) return json(404, { error: { message: "Run not found", code: "run_not_found" } }, res);
      if (a.code && a.code !== 200) return json(a.code, a.body || { error: { message: `stub ${a.code}`, code: "stub_error" } }, res);
      return json(200, { run_id: id, ...a }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  return {
    seen,
    server,
    set: (id, body) => answers.set(id, body),
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox --------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-complete-chip-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const TREE = path.join(repo, ".worktrees", "complete-the-chip");
const cwdDir = path.join(dir, "panel-cwd");
const homeNew = path.join(dir, "hermes-home-new");
const homeOld = path.join(dir, "hermes-home-old");
const cfgNewDir = path.join(dir, "panel-new");
const cfgOldDir = path.join(dir, "panel-old");
const logsNew = path.join(cfgNewDir, "logs");
const logsOld = path.join(cfgOldDir, "logs");
const oldRoot = path.join(dir, "build-before");
// `oldRoot` is deliberately NOT created here: it is where the pre-change build is cut as a worktree, and git only cuts
// one into a path that does not exist yet.
for (const d of [repo, path.join(repo, ".worktrees"), cwdDir, homeNew, homeOld, cfgNewDir, logsNew, cfgOldDir, logsOld]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
// The tree the finished turns worked in: a real worktree, so the ask's report path and worktree line name something that
// exists on disk rather than a string this script made up.
const BRANCH = "wtgui/complete-chip-a11aa01";
git(repo, ["worktree", "add", "-q", "-b", BRANCH, TREE]);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

const ports = { now: await freePort(), before: await freePort() };
const baseNow = `http://127.0.0.1:${ports.now}`;
const baseOld = `http://127.0.0.1:${ports.before}`;

// ---- the cards both panels are handed ------------------------------------------------------------
const START = "2026-10-26T09:12:00.000Z";
const END = "2026-10-26T09:31:40.000Z";
// thread slug -> the store card. Named together, so the seeding loop cannot drift from the assertions.
const CARDS = [
  { id: "j-a-done", thread: "wtgui-complete-chip-a-11aa01", status: "done", runId: "run_done_a", branch: BRANCH, report: true },
  { id: "j-b-done", thread: "wtgui-complete-chip-b-11aa01", status: "done", runId: "run_done_b", branch: "wtgui/complete-chip-b-11aa01" },
  { id: "j-c-done", thread: "wtgui-complete-chip-c-11aa01", status: "done", runId: "run_done_c", branch: "wtgui/complete-chip-c-11aa01" },
  { id: "j-d-failed", thread: "wtgui-complete-chip-d-11aa01", status: "failed", runId: "run_failed_d", branch: "wtgui/complete-chip-d-11aa01" },
  { id: "j-e-cancelled", thread: "wtgui-complete-chip-e-11aa01", status: "cancelled", runId: "run_cancelled_e", branch: "wtgui/complete-chip-e-11aa01" },
  { id: "j-f-interrupted", thread: "wtgui-complete-chip-f-11aa01", status: "interrupted", runId: "run_interrupted_f", branch: "wtgui/complete-chip-f-11aa01" },
  { id: "j-g-lost", thread: "wtgui-complete-chip-g-11aa01", status: "interrupted", runId: "run_lost_g", branch: "wtgui/complete-chip-g-11aa01", runGone: true },
];
const REPORT_BODY = "# settler report\n\nproved: the chip renders and the press queues one ask.\nnot proved: nothing yet — this file exists so the ask can name it.\n";
const reportFile = path.join(TREE, ".agentboard", "settlers-reports", `${CARDS[0].thread}.md`);
mkdirSync(path.dirname(reportFile), { recursive: true });
writeFileSync(reportFile, REPORT_BODY);

const card = (c) => {
  const ended = c.status === "running" ? null : END;
  const tree = {
    at: Date.parse(END),
    exists: true,
    path: TREE.replace(/\\/g, "/"),
    branch: c.branch,
    base: "8f12ab3c",
    commits: c.status === "done" ? 2 : 0,
    subjects: c.status === "done" ? ["Make the chip green on a finished card", "Queue one ask for the assistant instead of nudging the agent"] : [],
    dirty: 0,
    untracked: 0,
    note: "",
  };
  const base = {
    id: c.id,
    thread: c.thread,
    turn: 1,
    prompt: `the brief behind ${c.id}`,
    cwd: cwdDir,
    // No owner: the card lives in the Agents panel, where a browser can click it without opening a project row first.
    ownerPath: null,
    projectPath: null,
    sessionId: c.thread,
    status: c.status,
    exitCode: c.status === "done" ? 0 : c.status === "failed" ? 1 : null,
    startedAt: START,
    endedAt: ended,
    runId: c.runId,
    worktree: false,
    existing: false,
    worktreePath: TREE,
    branch: c.branch,
    tree,
    lines: [
      { kind: "tool", lid: 1, at: Date.parse(END) - 240_000, text: "\u{1F4BB} terminal · npm test" },
      { kind: "text", lid: 2, at: Date.parse(END), text: "done — the chip is in and the suites are green." },
    ],
  };
  if (c.status === "done") {
    base.outcome = outcomeFrom({ runStatus: "completed", run: { exit_code: 0 } });
    base.finalMessage = "done — the chip is in and the suites are green.";
    base.report = c.report ? { path: reportFile.replace(/\\/g, "/"), text: REPORT_BODY, bytes: REPORT_BODY.length, truncated: false } : null;
    base.completion = completionPayload({ ...base, report: base.report });
  }
  if (c.status === "failed") {
    base.outcome = outcomeFrom({ runStatus: "failed", run: { exit_code: 1 } });
    base.error = "the run ended with exit 1";
  }
  if (c.status === "cancelled") base.outcome = outcomeFrom({ runStatus: "cancelled", run: {} });
  if (c.status === "interrupted") {
    const promise = `the panel restarted while this was running — the gateway still has run ${c.runId}, so it will finish on its own, but this card cannot steer it`;
    const settled = `the panel restarted while this was running — the gateway no longer has run ${c.runId}, so its outcome was never seen here`;
    base.error = c.runGone ? settled : promise;
    base.outcome = { word: "interrupted", exitCode: null, source: null, reason: base.error };
  }
  if (c.runGone) base.runGone = true;
  return base;
};
const seeded = { savedAt: START, jobs: CARDS.map(card) };
for (const p of [path.join(logsNew, "jobs.json"), path.join(logsOld, "jobs.json")]) writeFileSync(p, JSON.stringify(seeded));
const seededText = readFileSync(path.join(logsNew, "jobs.json"), "utf8");
ok("the store handed to both panels carries a finished card and a stopped one", /"status":"done"/.test(seededText) && /"status":"failed"/.test(seededText));

// At boot the gateway will not answer FOR the interrupted cards (5xx is not an answer), so their verdicts stand and the
// re-attach pill is drawn — exactly the card the brief says must be untouched. `run_lost_g` is 404ed: that card has
// already been settled, so it keeps the plain not-running pill.
stub.set("run_interrupted_f", { code: 500, body: { error: { message: "internal error" } } });

// Both panels are pointed at the SAME stub: the boot reconcile must answer both identically, or the before/after of an
// interrupted card would compare two different store states rather than two builds of one page.
const settings = (p, jobs, assistant) =>
  `${JSON.stringify(
    {
      port: p,
      host: "127.0.0.1",
      scanRoots: [rootDir],
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      threads: 1,
      scanMode: "all",
      defaultCwd: cwdDir,
      jobsFile: jobs,
      projectsCacheFile: path.join(path.dirname(jobs), "projects.json"),
      treeNamesFile: path.join(path.dirname(jobs), "tree-names.json"),
      assistantFile: path.join(path.dirname(jobs), "assistant.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      assistant,
    },
    null,
    2,
  )}\n`;
const cfgNew = path.join(cfgNewDir, "config.json");
const cfgOld = path.join(cfgOldDir, "config.json");
// One wake per hour on the panel under test: the first press spends the budget, and the next card's press is the refusal
// the chip has to report rather than swallow.
writeFileSync(cfgNew, settings(ports.now, path.join(logsNew, "jobs.json"), { enabled: true, seconds: 3600, maxWakesPerHour: 1 }));
writeFileSync(cfgOld, settings(ports.before, path.join(logsOld, "jobs.json"), { enabled: false }));
for (const f of [cfgNew, cfgOld]) ok(`the config ${path.basename(path.dirname(f))} was written (a missing PANEL_CONFIG binds the LIVE port)`, readFileSync(f, "utf8").includes('"port"'));

// ---- the panel the change replaces ---------------------------------------------------------------
// A DETACHED WORKTREE of the pre-change commit, cut beside the sandbox rather than inside the repo's own .worktrees/ so
// the live board cannot grow a row for it, and removed in the finally below. It runs that commit's own server.js, lib/
// and public/ — the pill markup and the ink it draws are main's, not a copy this script reconstructed.
const beforeSha = process.env.PANEL_BEFORE_SHA || git(ROOT, ["rev-parse", "HEAD~1"]).out;
const baseApp = git(ROOT, ["show", `${beforeSha}:public/app.js`]);
ok(`a pre-change build was found (${beforeSha.slice(0, 8)})`, baseApp.ok && !baseApp.out.includes("pill-complete"), baseApp.ok ? "its public/app.js carries no pill-complete" : baseApp.err);
const cut = git(ROOT, ["worktree", "add", "--detach", oldRoot, beforeSha]);
ok(`the pre-change build was cut as a worktree of this repo at ${beforeSha.slice(0, 8)}`, cut.ok && git(oldRoot, ["rev-parse", "HEAD"]).out === beforeSha, cut.ok ? git(oldRoot, ["rev-parse", "HEAD"]).out.slice(0, 8) : cut.err);
ok("...carrying that commit's own server.js, lib/ and public/ (not this checkout's)", readFileSync(path.join(oldRoot, "server.js"), "utf8").length > 1000 && !readFileSync(path.join(oldRoot, "public", "app.js"), "utf8").includes("pill-complete") && !readFileSync(path.join(oldRoot, "lib", "assistant.js"), "utf8").includes("askAboutComplete"));

// ---- panels -------------------------------------------------------------------------------------
const panels = new Map();
async function startPanel(tag, cwdRoot, configPath, home, base) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: cwdRoot,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panels.set(tag, { child, log });
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 60_000, stepMs: 400, what: `${tag} to answer /api/state on ${base}` });
  if (!up) throw new Error(`the ${tag} panel never came up on ${base}\n${log.slice(-20).join("\n")}`);
  return { child, log };
}
async function stopPanel(tag) {
  const p = panels.get(tag);
  if (!p) return;
  panels.delete(tag);
  try {
    p.child.kill();
    await waitFor(() => p.child.exitCode !== null || p.child.signalCode !== null, { timeoutMs: 10_000, what: `${tag} to exit` });
  } catch {
    /* hard kill below */
  }
  if (p.child.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(p.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
  }
  p.child.stdout?.destroy();
  p.child.stderr?.destroy();
  await sleep(250);
}

const api = async (base, route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const cardFor = async (base, id) => ((await api(base, "/api/jobs")).body.jobs || []).find((j) => j.id === id) || null;
const assistantState = async (base) => (await api(base, "/api/assistant")).body;
const panelLogOf = (tag) => (panels.get(tag)?.log || []).join("\n");
const runsFor = (session) => stub.seen.submitted.filter((b) => String(b.session_id || "") === session);
const askRuns = () => runsFor("panel-assistant");

// ---- the browser half ---------------------------------------------------------------------------
// Every request the page makes is recorded (and still sent): "no nudge left the panel" is then a fact about the page, not
// an inference from the absence of an effect. The cards on the page are the panels' own seeded store, so nothing here
// fabricates a card the panel does not have.
const pillOf = (page, thread) =>
  page.evaluate((t) => {
    const cardEl = document.querySelector(`.job[data-thread="${t}"]`);
    if (!cardEl) return { card: false };
    const head = cardEl.querySelector(".job-head");
    const pill = head ? head.querySelector("button.pill, span.pill") : null;
    const cs = pill ? getComputedStyle(pill) : null;
    const r = pill ? pill.getBoundingClientRect() : null;
    return {
      card: true,
      html: pill ? pill.outerHTML : null,
      tag: pill ? pill.tagName : null,
      type: pill ? pill.getAttribute("type") : null,
      text: pill ? pill.textContent.trim() : null,
      classes: pill ? [...pill.classList].sort() : null,
      glyph: pill ? Boolean(pill.querySelector(".pill-again")) : null,
      full: pill ? [...pill.childNodes].map((n) => (n.nodeType === 3 ? n.textContent.trim() : n.textContent.trim())).filter(Boolean) : null,
      ink: cs ? [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderTopStyle, cs.borderTopWidth].join("|") : null,
      size: cs ? [cs.fontSize, cs.fontWeight, cs.letterSpacing, cs.textTransform, cs.padding, cs.borderRadius, cs.lineHeight, cs.fontFamily].join("|") : null,
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      afterChev: Boolean(pill && pill.previousElementSibling && pill.previousElementSibling.classList.contains("chev")),
      hooks: pill
        ? { complete: pill.hasAttribute("data-complete-ask"), continue: pill.hasAttribute("data-continue-thread"), reattach: pill.hasAttribute("data-reattach-job") }
        : null,
      title: pill ? pill.title : null,
    };
  }, thread);
const bannerOf = (page) =>
  page.evaluate(() => {
    const b = document.getElementById("banner");
    return b ? { text: b.textContent.trim(), hidden: b.classList.contains("hidden"), ok: b.classList.contains("ok") } : null;
  });
const callsOf = (page) =>
  page.evaluate(() => (window.__calls || []).map((c) => ({ url: c.url, method: c.method, body: c.body, res: c.res === undefined ? null : c.res })));

let browserRef = null;
let err = null;
let pw = null;
try {
  console.log(`\n== the sandbox: two panels, one store, one stub (${stubUrl}) ==`);
  console.log(`   panel under test ${baseNow} (port ${ports.now}) · build it replaces ${baseOld} (port ${ports.before})`);
  await startPanel("now", ROOT, cfgNew, homeNew, baseNow);
  await startPanel("before", oldRoot, cfgOld, homeOld, baseOld);
  ok("the panel under test logged its own sandbox port", panelLogOf("now").includes(`agent-worktree-gui on http://127.0.0.1:${ports.now}`), `port ${ports.now}`);
  ok("...and the stub it was pointed at, not the live gateway", panelLogOf("now").includes(`agent transport: ${stubUrl}`));
  ok("the pre-change panel booted from its own build and its own port", panelLogOf("before").includes(`agent-worktree-gui on http://127.0.0.1:${ports.before}`), `port ${ports.before}`);
  ok("neither panel bound the live board's port", !panelLogOf("now").includes(":7331") && !panelLogOf("before").includes(":7331"));
  ok("both panels restored the seeded cards", await waitFor(async () => (await cardFor(baseNow, "j-a-done")) && (await cardFor(baseOld, "j-a-done")), { timeoutMs: 30_000, what: "both stores to restore" }));
  check("the finished card is exactly where the store left it", (await cardFor(baseNow, "j-a-done"))?.status, "done");
  check("...and the failed card too", (await cardFor(baseNow, "j-d-failed"))?.status, "failed");
  check("the interrupted card the gateway 5xxed keeps its verdict", (await cardFor(baseNow, "j-f-interrupted"))?.status, "interrupted");
  check("...and is not marked as a run the gateway lost", (await cardFor(baseNow, "j-f-interrupted"))?.runGone, false);
  check("the settled card that the gateway disowned stays settled", (await cardFor(baseNow, "j-g-lost"))?.runGone, true);
  // The positive control every later count depends on: nothing in this sandbox has asked the assistant for anything yet.
  check("no run has been asked for before the press (so the later count is the press's own)", stub.seen.submitted.length, 0);
  check("...and none of the panels' boot traffic did either", askRuns().length, 0);

  pw = loadPlaywright();
  if (!pw) throw new Error("BROWSER-HALF-NOT-RUN");
  browserRef = await pw.chromium.launch({ headless: true });
  const context = await browserRef.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.__calls = [];
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = String((opts && opts.method) || "GET").toUpperCase();
      const rec = { url: u, method, body: opts && opts.body ? String(opts.body) : null };
      window.__calls.push(rec);
      const res = await real(url, opts);
      // What the page was ANSWERED, for the writes: the chip acts on the route's own words, and the checks below read
      // the text the route queued straight off the answer the page received rather than re-asking for it.
      if (method === "POST") {
        try {
          rec.res = await res.clone().json();
        } catch {
          /* a POST whose answer is not JSON needs nothing from here */
        }
      }
      return res;
    };
  });
  const pageErrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`page: ${String((e && e.message) || e)}`));
  const pageOld = await context.newPage();
  pageOld.on("pageerror", (e) => pageErrors.push(`build-before page: ${String((e && e.message) || e)}`));
  await page.goto(baseNow, { waitUntil: "domcontentloaded" });
  await pageOld.goto(baseOld, { waitUntil: "domcontentloaded" });
  const drawn = () =>
    waitFor(
      async () =>
        (await page.$$eval(".job[data-thread]", (els) => els.map((e) => e.dataset.thread))).length >= CARDS.length &&
        (await pageOld.$$eval(".job[data-thread]", (els) => els.map((e) => e.dataset.thread))).length >= CARDS.length,
      { timeoutMs: 40_000, what: "every seeded card to be drawn on both boards" },
    );
  ok("every seeded card is drawn on both boards", await drawn());
  ok("...with no page error on either", pageErrors, []);

  // ── (a) the done card: a green COMPLETE chip, no glyph, in the pill's own place ─────────────────
  console.log("\n== (a) the card whose latest turn is done ==");
  const after = await pillOf(page, CARDS[0].thread);
  const afterControl = await pillOf(pageOld, CARDS[0].thread);
  note(`before (${beforeSha.slice(0, 8)}): ${afterControl.html}`);
  note(`after  (this build)  : ${after.html}`);
  check("the card is on the page in both builds", [afterControl.card, after.card], [true, true]);
  check("on the build it replaces, the finished card read not-running with the ↻ glyph", afterControl.text, "not-running\u21bb");
  ok("...and carried the continue hook, so its press sent the agent a nudge", afterControl.hooks?.continue === true && afterControl.glyph === true, JSON.stringify(afterControl.hooks));
  check("now it reads COMPLETE", after.text, "complete");
  const caseNote = await page.evaluate((t) => {
    const el = document.querySelector(`.job[data-thread="${t}"] .job-head button.pill-complete`);
    return el ? getComputedStyle(el).textTransform : null;
  }, CARDS[0].thread);
  check("...with the same casing rule as every other pill", caseNote, "uppercase");
  check("...with no ↻ glyph on it (nothing is being resumed)", after.glyph, false);
  check("...as a button, not a badge", [after.tag, after.type], ["BUTTON", "button"]);
  check("...carrying no continue hook and no re-attach hook", [after.hooks?.continue, after.hooks?.reattach], [false, false]);
  ok("...and its own hook instead, naming the card", after.hooks?.complete === true && (after.html || "").includes(`data-complete-ask="${CARDS[0].id}"`), after.html);
  ok("the green it wears is the panel's own finished colour, not a new one", /rgb\(126, 231, 135\)/.test(after.ink || ""), after.ink);
  ok("...and it is green where the stopped pill is amber", !/rgb\(240, 198, 116\)/.test(after.ink || ""), after.ink);
  // "Same size and place": measured against the not-running pill on a card in the same container of the same page.
  const stopped = await pillOf(page, CARDS[3].thread);
  check("the pill it replaces is still drawn for a failed card (the comparison's control)", stopped.text, "exited\u21bb");
  check("...same box: font, letter-spacing, padding, radius and line-height", after.size, stopped.size);
  check("...same place in the head: immediately after the card's chevron", after.afterChev, true);
  check("...at the same column as the pill every stopped card carries", after.rect?.x, stopped.rect?.x);
  note(`measured: COMPLETE ${JSON.stringify(after.rect)} vs not-running ${JSON.stringify(stopped.rect)} — the width differs by the glyph the brief asks to drop`);
  check("...and the same height as the pill it stands in for", after.rect?.h, stopped.rect?.h);
  ok("...while the title says what the press does and what it will NOT do", /queue one ask for the board assistant/.test(after.title || "") && /Nothing is sent to this agent/.test(after.title || ""), after.title);

  // ── (b) every other status renders exactly what it renders on main ──────────────────────────────
  console.log("\n== (b) failed, cancelled, interrupted and the lost-run card: unchanged, byte for byte ==");
  for (const c of CARDS.slice(3)) {
    const now = await pillOf(page, c.thread);
    const was = await pillOf(pageOld, c.thread);
    note(`${c.id}: before ${was.html}`);
    note(`${c.id}: after  ${now.html}`);
    check(`${c.id} renders the identical pill markup before and after`, now.html, was.html);
    check(`${c.id} keeps its ink`, now.ink, was.ink);
    check(`${c.id} keeps its hooks`, now.hooks, was.hooks);
    check(`${c.id} keeps its place`, [now.rect?.x, now.rect?.h], [was.rect?.x, was.rect?.h]);
  }
  check("the failed card still says exited", (await pillOf(page, CARDS[3].thread)).text, "exited\u21bb");
  check("the cancelled card still says not-running", (await pillOf(page, CARDS[4].thread)).text, "not-running\u21bb");
  check("the interrupted card keeps the re-attach pill", (await pillOf(page, CARDS[5].thread)).hooks?.reattach, true);
  check("...with no COMPLETE hook on it", (await pillOf(page, CARDS[5].thread)).hooks?.complete, false);
  check("the card whose run the gateway lost keeps the ordinary pill", (await pillOf(page, CARDS[6].thread)).text, "not-running\u21bb");
  ok("...and no COMPLETE anywhere on a card that is not done", (await page.$$eval(".pill-complete", (els) => els.map((e) => e.closest('.job').dataset.thread))).every((t) => t === CARDS[0].thread || t === CARDS[1].thread || t === CARDS[2].thread), JSON.stringify(await page.$$eval(".pill-complete", (els) => els.map((e) => e.closest('.job').dataset.thread))));

  // ── (c)+(d)+(e) the press: one ask queued, nothing to the worker, and the text ──────────────────
  console.log("\n== (c) the press: exactly one ask for the assistant, and nothing to the agent ==");
  const turnsBefore = (await cardFor(baseNow, "j-a-done"))?.turn;
  await page.evaluate(() => {
    window.__calls.length = 0;
  });
  await page.click(`.job[data-thread="${CARDS[0].thread}"] [data-complete-ask]`);
  const queued = await waitFor(() => askRuns().length === 1, { timeoutMs: 20_000, what: "the wake queue to take the ask" });
  ok("one press puts exactly one ask on the assistant's wake queue", queued, `${askRuns().length} run(s) asked for`);
  const asked = await pillOf(page, CARDS[0].thread);
  check("(e) the chip shows the ask landed", asked.text, "asked");
  ok("...and stays the same green-grey pill, still the card's own control", asked.classes.includes("is-asked") && asked.hooks?.complete === true, JSON.stringify(asked.classes));
  const calls = await callsOf(page);
  const posts = calls.filter((c) => c.method === "POST");
  note(`the page's own writes since the press: ${JSON.stringify(posts.map((c) => c.url.replace(baseNow, "")))}`);
  const askPosts = posts.filter((c) => c.url.includes("/api/jobs/ask-complete"));
  check("the page posted exactly one ask, naming the card", [askPosts.length, JSON.parse(askPosts[0]?.body || "{}").id], [1, "j-a-done"]);
  check("no continue nudge left the page (nothing to /api/agents/reply)", posts.filter((c) => /\/api\/agents\/reply/.test(c.url)).length, 0);
  check("...and no immediate assistant turn either (/api/assistant/say)", posts.filter((c) => /\/api\/assistant\/say/.test(c.url)).length, 0);
  check("...and no write at all addressed to the finished agent's thread", posts.filter((c) => String(c.body || "").includes(CARDS[0].thread)).length, 0);
  check("the finished agent was not resumed: no run was asked for in its session", runsFor(CARDS[0].thread).length, 0);
  check("...its turn count is where it was", (await cardFor(baseNow, "j-a-done"))?.turn, turnsBefore);
  check("...and it is still the finished card it was", (await cardFor(baseNow, "j-a-done"))?.status, "done");
  check("...with no new line on its console", ((await cardFor(baseNow, "j-a-done"))?.lines || []).length, 2);
  ok("the ask is queued as a job on the assistant's own thread", ((await api(baseNow, "/api/jobs")).body.jobs || []).filter((j) => j.thread === "panel-assistant").length === 1);
  const st = await assistantState(baseNow);
  check("the assistant's own state counts that one wake", st.wakes?.lastHour, 1);
  check("...and its budget is the sandbox's own limit", st.wakes?.limit, 1);
  check("...with nothing left pending behind it", st.wakePending, 0);

  console.log("\n== (d) the queued text, verbatim ==");
  const run = askRuns()[0];
  const text = String(run.input || "");
  const routeText = String(askPosts[0]?.res?.text || "");
  const askPart = text.slice(Math.max(0, text.indexOf("[complete]")));
  // Only the ask is printed: the run body opens with the panel's own preamble (board digest, rules, charter), which is
  // the same on every assistant turn and says nothing about this change.
  console.log(`----- the ask, as it rides in the wake (body ${text.length} chars, preamble ${text.length - askPart.length}) -----`);
  console.log(askPart);
  console.log("------------------------------------------------------------------------");
  ok("the route told the page what it queued (the chip reports what the queue took)", routeText.length > 0 && askPosts[0]?.res?.queued === true, `${routeText.length} chars, queued ${askPosts[0]?.res?.queued}`);
  ok("(d) and the queue's message is that ask, character for character", text.includes(routeText) && routeText.includes(CARDS[0].thread), "the route's text rides inside the wake");
  ok("(d) it names the thread", text.includes(CARDS[0].thread), CARDS[0].thread);
  ok("(d) it names the worktree path", norm(text).includes(norm(TREE)), TREE);
  ok("(d) it names the branch", text.includes(BRANCH), BRANCH);
  ok("(d) it names the run id", text.includes("run_done_a"), "run_done_a");
  ok("(d) it asks whether the claim is true on the EVIDENCE, not on the agent's word", /not on the agent having said "done"/.test(text) && /actually on main/.test(text), "the judgement sentence");
  ok("(d) ...naming the PR's state and the report's own admissions", /what state is that PR in/.test(text) && /admits it did not/.test(text), "the evidence list");
  ok("(d) it asks what is left for that worktree and who owns it", /what still has to happen for that worktree or project/.test(text) && /who owns it/.test(text), "the next-step sentence");
  ok("(d) it says the chip was pressed, and by whom", /the reader pressed its COMPLETE chip/.test(text), "the pressed line");
  ok("...and it carries the panel's own measurement and the report's path", /the panel measured: left 2 commits not on/.test(text) && text.includes(reportFile.replace(/\\/g, "/")), "the measured lines");
  // One field per line: the assistant reads this as a list, and a whitespace-collapsing clip folds it into a paragraph.
  const fieldLines = text.split("\n").filter((l) => /^(thread|worktree|branch|run): /.test(l));
  check("(d) ...as one field per line, not folded into a paragraph", fieldLines.length, 4);
  check("...and it was addressed to the assistant, not to a worker", run.session_id, "panel-assistant");
  ok("...as a wake, wrapped in the digest the assistant already reads", /needs a look/.test(text), "the wake digest wrapper");

  // ── (f) two clicks do not queue two identical asks ──────────────────────────────────────────────
  console.log("\n== (f) a second press on the same finished card ==");
  const before = askRuns().length;
  const journalBefore = (await assistantState(baseNow)).journal || [];
  await page.click(`.job[data-thread="${CARDS[0].thread}"] [data-complete-ask]`);
  await sleep(1200);
  check("the second press queued nothing", askRuns().length, before);
  const after2 = await pillOf(page, CARDS[0].thread);
  check("...the chip still says the ask is in", after2.text, "asked");
  const journalAfter = (await assistantState(baseNow)).journal || [];
  const fresh = journalAfter.filter((j) => !journalBefore.some((b) => b.at === j.at && b.text === j.text));
  ok("...and the assistant's journal says why, in its own words", fresh.some((j) => /nothing was queued twice/.test(j.text || "")), JSON.stringify(fresh.map((j) => `${j.kind}: ${j.text}`)).slice(0, 300));
  const banner = await bannerOf(page);
  ok("(e) the card said the check is already queued", /already in the assistant's queue/.test(banner?.text || ""), banner?.text || "");
  check("...as a note, not a failure", banner?.ok, true);

  // ── (e) the refusals: the budget, then a switched-off assistant ─────────────────────────────────
  console.log("\n== (e) a wake the queue refuses (the hourly budget) ==");
  await page.click(`.job[data-thread="${CARDS[1].thread}"] [data-complete-ask]`);
  await sleep(1500);
  check("the refused ask put nothing on the queue", askRuns().length, 1);
  const refused = await api(baseNow, "/api/jobs/ask-complete", { id: "j-b-done" });
  check("the route answers the refusal instead of erroring", [refused.status, refused.body?.ok, refused.body?.queued, refused.body?.refused], [200, true, false, "budget"]);
  const bannerBudget = await bannerOf(page);
  ok("(e) the card says the budget refused it, and does not claim the ask landed", /wake budget is spent \(1\/hour\)/.test(bannerBudget?.text || ""), bannerBudget?.text || "");
  const chipB = await pillOf(page, CARDS[1].thread);
  check("...and that chip is NOT left reading 'asked'", chipB.text, "complete");
  ok("...so the reader can press it again", chipB.classes.includes("is-asked") === false, JSON.stringify(chipB.classes));
  ok("...and the refusal is in the assistant's journal, where the sentry's own suppressions go", ((await assistantState(baseNow)).journal || []).some((j) => j.kind === "ask-refused"), JSON.stringify(((await assistantState(baseNow)).journal || []).map((j) => j.kind)));

  console.log("\n== (e) a wake the queue refuses (the assistant is switched off) ==");
  const off = await api(baseNow, "/api/assistant/settings", { enabled: false });
  check("the assistant was switched off for this press", [off.status, off.body?.settings?.enabled], [200, false]);
  await page.click(`.job[data-thread="${CARDS[2].thread}"] [data-complete-ask]`);
  await sleep(1500);
  check("that press queued nothing either", askRuns().length, 1);
  const bannerOff = await bannerOf(page);
  ok("(e) the card says the assistant is off rather than that it is coming", /board assistant is switched off in Settings/.test(bannerOff?.text || ""), bannerOff?.text || "");
  const chipC = await pillOf(page, CARDS[2].thread);
  check("...and no chip claims an ask that never left", chipC.text, "complete");
  await api(baseNow, "/api/assistant/settings", { enabled: true, maxWakesPerHour: 6 });

  // ── the ask is one per turn: once the assistant has read it, a press is a new question ──────────
  console.log("\n== the assistant reads the ask, and a later press is a new question ==");
  // The stub holds a run open until the test answers it: end the first wake's run the way a real turn ends.
  stub.set("stub-run-1", { status: "completed", exit_code: 0, output: "I will look at that finished card and say what is left.", usage: { total_tokens: 10, input_tokens: 6, output_tokens: 4 } });
  const settled = await waitFor(async () => (await assistantState(baseNow)).running === false, { timeoutMs: 25_000, what: "the assistant's turn to end" });
  ok("the assistant's turn ended, so the ask it was handed has been read", settled);
  const second = await api(baseNow, "/api/jobs/ask-complete", { id: "j-a-done" });
  check("a press after that is accepted as a new question", [second.body?.ok, second.body?.queued, second.body?.duplicate], [true, true, false]);
  ok("...and reaches the queue", await waitFor(() => askRuns().length === 2, { timeoutMs: 15_000, what: "the second ask to be sent" }), `${askRuns().length} runs`);
  ok("...carrying the same standing text, because the card is the same finished card", /the reader pressed its COMPLETE chip/.test(String(askRuns()[1]?.input || "")), String(askRuns()[1]?.input || "").slice(0, 120));
  check("no page error was thrown while the presses ran", pageErrors, []);

  // ── what can only be read off the source ───────────────────────────────────────────────────────
  console.log("\n== what can only be read off the source ==");
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const appLines = app.split(/\r?\n/);
  const at = (needle) => appLines.findIndex((l) => l.includes(needle));
  const completeBranch = at('const completeChip = latest.status === "done"');
  const detachedBranch = at("const detachedChip = runMayStillExist");
  const headSlot = at(": completeChip ||");
  ok("inspected: the COMPLETE chip is a status branch of its own, and the re-attach chip's branch is untouched beside it", completeBranch > 0 && detachedBranch > 0 && headSlot > completeBranch, `complete ${completeBranch + 1}, re-attach ${detachedBranch + 1}, drawn at ${headSlot + 1}`);
  check("inspected: the status word it replaces is still spelled the same, exactly once", appLines.filter((l) => l.includes('latest.status === "failed" ? "exited" : "not-running"')).length, 1);
  check("inspected: and the re-attach pill's own markup line is byte-identical to the one main had", appLines.filter((l) => l.includes('class="pill pill-notrunning pill-reattach"')).length, 1);
  const clickAt = at('const completeBtn = e.target.closest("[data-complete-ask]");');
  const clickCall = appLines.findIndex((l, i) => clickAt > 0 && i > clickAt && l.includes("void askComplete(completeBtn);"));
  ok("inspected: the chip's click path is one call off its own hook, with no body of its own", clickAt > 0 && clickCall > clickAt, `hook at ${clickAt + 1}, the call at ${clickCall + 1}`);
  check("inspected: that press is the only place askComplete is called from", appLines.filter((l) => /askComplete\(/.test(l) && !l.includes("async function askComplete(")).length, 1);
  const fnAt = at("async function askComplete(btn)");
  const body = appLines.slice(fnAt, fnAt + 45).join("\n");
  ok("inspected: and it asks the queue route rather than sending anything to the agent", body.includes('"/api/jobs/ask-complete"') && !body.includes("sendReply") && !body.includes("continueThread"), "read off the function body");
  const lib = readFileSync(path.join(ROOT, "lib", "assistant.js"), "utf8");
  const askAt = lib.indexOf("  askAboutComplete(id) {");
  const askBody = lib.slice(askAt, lib.indexOf("\n  completeAskText(", askAt));
  ok("inspected: the ask is queued through the assistant's own wake queue", askBody.includes("this.wake(text, null, \"complete\")"), "Assistant.askAboutComplete -> wake");
  ok("inspected: and never through say(), which would start a turn at once", !/\bthis\.say\(/.test(askBody), "no say() in the press path");
  const alertAsk = lib.slice(lib.indexOf('} else if (action === "ask") {'), lib.indexOf('} else if (action === "ask") {') + 200);
  ok("inspected: that is the same queue the reader handing an alert over uses", alertAsk.includes("this.wake("), "alertAction(id, \"ask\") -> wake");
  const srv = readFileSync(path.join(ROOT, "server.js"), "utf8");
  ok("inspected: the route is a thin pass to the assistant, and does not fall into the say route", srv.includes('route === "/api/jobs/ask-complete"') && srv.includes("assistant.askAboutComplete("), "POST /api/jobs/ask-complete");

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nDRIVEN: two panels (this checkout, and the pre-change build cut as a detached worktree of HEAD~1) on their");
  console.log("        one stub Runs API, one real headless Chromium over both boards, five presses in the browser, every");
  console.log("        page request recorded, every run body the panel posted kept, and the job store read before/after.");
  console.log("INSPECTED, NOT DRIVEN: that the COMPLETE branch is a status branch beside the continue pill's, that the");
  console.log("        re-attach pill's markup line is unchanged, that the press path reaches wake() and never say(), and");
  console.log("        that the routing is one call off the chip's own hook — all read off the source above.");
  if (!failures) console.log("COMPLETE-CHIP-OK");
} catch (e) {
  if (String((e && e.message) || e) === "BROWSER-HALF-NOT-RUN") {
    console.log("\nBROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-complete-chip.mjs");
  } else {
    console.log(`\nthe phases threw: ${String((e && e.stack) || e)}`);
  }
  err = e;
  failures += 1;
} finally {
  try {
    await browserRef?.close();
  } catch {
    /* already gone */
  }
  await stopPanel("now");
  await stopPanel("before");
  await stub.close();
  // The pre-change worktree goes before the directory it lives in, and its registration goes with it — a leftover entry
  // here would leave the repo pointing at a tree that is about to be deleted.
  const gone = git(ROOT, ["worktree", "remove", "--force", oldRoot]);
  await git(ROOT, ["worktree", "prune"]);
  console.log(gone.ok ? "      the pre-change worktree was removed, and the repo's worktree list pruned with it" : `      (could not remove the pre-change worktree: ${gone.err})`);
  if (process.env.VERIFY_KEEP !== "1") {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  } else {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  }
}
process.exitCode = err || failures ? 1 : 0; // process.exitCode: a piped stdout must not lose the report
