// What a console does when the card is repainted and ONE more line arrives — in the condensed renderer and in the
// one-stream (🌊) one.
//
// The reasoning block is polled and redrawn; the console is the other half of the same card and it has its own way
// of looking like it flickers: `drawJobLine` used to clear the console whenever its first child was a `.jl-dim` line,
// which is right for the "waiting for output…" placeholder and wrong for a real dim note ("⇢ asked to work in …",
// "cut from …", "push guard: …"). Every full repaint puts such a note on top, so the next live line wiped everything
// the reader had and drew only itself until the following repaint put it back — the console and everything under it
// riding up and down. That is fixed (public/app.js drawJobLine clears only `[data-wait]`), and this measures whether
// it stays fixed on REAL content rather than on a fixture.
//
// `--stream` measures the SAME claims one renderer down: in a 🌊 card the reasoning is not a block above the console,
// it is lines of the console, and that console is POLLED — `loadThinking` → `paintThink` → `paintStreamConsole` on
// every reasoning re-read. Written as one `innerHTML` assignment that took the whole console with it, several times a
// second. The stream scenario adds what the condensed one cannot see: the rows that did not change must keep their
// NODES (a selection inside the console is the reader's), and a poll that would lose the NEWEST rows must draw nothing.
//
//   node tools/measure-console-live.mjs                    # this checkout, newest real run with tool output
//   node tools/measure-console-live.mjs --stream           # the same, drawn as ONE stream with its real reasoning
//   node tools/measure-console-live.mjs --root <checkout>  # measure another checkout (e.g. a `git archive` export)
//   node tools/measure-console-live.mjs --run <id>         # name the run to draw
//   node tools/measure-console-live.mjs --jobs <file>      # the job store to read (default <WAG_HOME>/state/jobs.json)
//   node tools/measure-console-live.mjs --blocks <file>    # the reasoning to draw (default: read the run's thread
//                                                          #   back out of <HERMES_HOME>/state.db, as the route does)
//   node tools/measure-console-live.mjs --state-db <file>  # another session store (default <HERMES_HOME>/state.db)
//   node tools/measure-console-live.mjs --report <dir>     # where the JSON + shots go (default C:/CodeReviews/agent-worktree-gui)
//   node tools/measure-console-live.mjs --shots            # also write the before/after screenshots
//
// WHAT IS DRIVEN, and what is not
//   * a sandbox panel of its own — free port, own PANEL_CONFIG / jobs.json / projects cache, assistant off, a gateway
//     pointed at a closed port so nothing can be posted — serving the chosen checkout's public/, so no live panel is
//     touched;
//   * ONE card drawn client-side from a REAL finished run's own record and its own `lines`, taken read-only out of the
//     panel's job store. No turn is started, nothing is posted, and no line is invented: the console is the transcript
//     that run actually produced. `--stream` also draws the reasoning that run's own thread recorded, read read-only
//     out of the session store — not a fixture;
//   * then the things a live card does to it: a FULL REPAINT (`renderConversation`, what the thinking sweep, a new
//     deliverable or an approval causes), a POLL REPAINT (`paintThink`, the reasoning re-read), and ONE live line
//     through the panel's own `appendJobLine`/`drawJobLine`. Each is followed per painted frame by the console's own
//     numbers and by where the reply box under it sits.
//
// WHAT THIS IS NOT: the live stream itself. A live console needs a turn to be started, and this tool refuses to start
// one. tools/verify-console-flicker.mjs is the harness that plays a scripted turn through a stub Runs API and gates the
// same claims on the wire; this one measures them on a real transcript, read-only, and reports what it saw.
//
// CHECKS (exit 1 while any fails)
//   (1) the console drew a real transcript (>= 20 rows, >= 5 tool rows, >= 1 burst group)
//   (2) a full repaint keeps every row and does not take 40px of the console's height away
//   (3) one live line after a repaint ADDS a row instead of replacing the console (the wipe bug)
//   (4) nothing under the console moves up: the reply box may be pushed down, never pulled up
//   (5) no page errors
// — and in `--stream`, where the reasoning is drawn as lines of that console:
//   (6) the console drew the turn's reasoning as its own rows (>= 2 `.jl-think`)
//   (7) a POLL repaint keeps the nodes of the rows that did not change (the console is patched, not replaced)
//   (8) a text selection standing in the console survives a poll repaint
//   (9) a poll whose body would drop rows from the MIDDLE draws nothing (row count and place held)
//  (10) one live line after a poll adds a row and does not take the console's height away
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const REPORT_DIR = opt("--report", "C:/CodeReviews/agent-worktree-gui");
const WANT_RUN = opt("--run");
const SHOTS = argv.includes("--shots");
const STREAM = argv.includes("--stream");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the reasoning a 🌊 card draws as lines of its console -----------------------------------------------------
// The same read the route does (`/api/thinking` → lib/thinking.js → thinkingFor), pointed at the panel's own session
// store, so the console is drawn with what that thread actually thought. `--blocks` takes a dump instead (the route's
// own answer, saved); a thread with no reasoning is a SKIP in stream mode, not an empty console measured as if it
// were a stream.
async function loadReasoning(thread) {
  const given = opt("--blocks");
  if (given) {
    const file = path.resolve(given);
    if (!existsSync(file)) return { skip: `no reasoning dump at ${file}` };
    const blocks = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(blocks) ? blocks : blocks.blocks || [];
    return list.length ? { blocks: list, from: file } : { skip: `${file} holds no reasoning blocks` };
  }
  const home = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || process.env.HOME || "", "hermes");
  const dbPath = path.resolve(opt("--state-db", path.join(home, "state.db")));
  if (!existsSync(dbPath)) return { skip: `no session store at ${dbPath}` };
  const mod = await import(pathToFileURL(path.join(ROOT, "lib", "thinking.js")).href);
  const read = mod.thinkingFor(thread, { dbPath });
  if (read.error) return { skip: `the session store at ${dbPath} could not be read: ${read.error}` };
  return read.blocks.length ? { blocks: read.blocks, from: dbPath } : { skip: `thread ${thread} recorded no reasoning in ${dbPath}` };
}

// ---- the run to draw -------------------------------------------------------------------------------------------
// The newest finished run in the panel's own job store whose console carries real tool output. A store with none is
// a skip, not a failure: inventing lines would measure the fixture instead of the page.
function jobsFile() {
  const given = opt("--jobs");
  if (given) return path.resolve(given);
  const home = process.env.WAG_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".wag");
  return path.join(home, "state", "jobs.json");
}
function pickRun() {
  const file = jobsFile();
  if (!existsSync(file)) return { skip: `no job store at ${file}` };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { skip: `the job store at ${file} did not parse: ${e.message}` };
  }
  const jobs = Array.isArray(doc) ? doc : doc.jobs || Object.values(doc);
  const usable = (j) => {
    const lines = Array.isArray(j.lines) ? j.lines : [];
    return lines.length >= 20 && lines.filter((l) => l && (l.kind === "tool" || l.kind === "tool-out")).length >= 5;
  };
  // ARMED is the shape the wipe bug needs: `drawJobLine` cleared the console when its first child was a dim row, and a
  // repaint is what puts one back on top. A transcript that opens on a tool call cannot exercise it, so a store with no
  // armed run is a skip rather than a green measurement of nothing.
  const armed = (j) => String((j.lines[0] || {}).kind || "") === "dim";
  if (WANT_RUN) {
    const one = jobs.find((j) => j.id === WANT_RUN);
    if (!one) return { skip: `no run ${WANT_RUN} in ${file}` };
    if (!usable(one)) return { skip: `run ${WANT_RUN} carries no console worth measuring` };
    return { run: one };
  }
  const ranked = jobs
    .filter(usable)
    .filter((j) => String(j.thread || "") && !String(j.thread).startsWith("panel-assistant"))
    // An armed run first (the wipe path can be reached at all), then a finished one: its transcript is complete and
    // its console will not grow between two runs of this tool.
    .sort(
      (a, b) =>
        (armed(b) ? 1 : 0) - (armed(a) ? 1 : 0) ||
        (b.endedAt ? 1 : 0) - (a.endedAt ? 1 : 0) ||
        Number(b.endedAt || b.startedAt || 0) - Number(a.endedAt || a.startedAt || 0),
    );
  if (!ranked.length) return { skip: "no run in the store carries 20+ console lines with 5+ tool lines" };
  if (!ranked.some(armed)) return { skip: "no run in the store opens its console on a dim note, so the wipe path would not be armed" };
  return { run: ranked[0] };
}

// ---- the sandbox panel ------------------------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const git = (cwd, a) => execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...a], { cwd, stdio: "pipe" });

async function startSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-console-live-"));
  const repo = path.join(dir, "repo");
  const logs = path.join(dir, "logs");
  mkdirSync(repo, { recursive: true });
  mkdirSync(logs, { recursive: true });
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first"]);
  const port = await freePort();
  const cfgPath = path.join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      port,
      host: "127.0.0.1",
      scanRoots: [path.join(dir, "empty-root")],
      threads: 1,
      worktreeSeconds: 60,
      midSeconds: 60,
      dormantSeconds: 60,
      slowSeconds: 300,
      refreshSeconds: 3600,
      fetchSeconds: -1,
      projects: [{ name: "probe", path: repo, remote: "origin", mainBranch: "main", remoteBranchPolicy: "local-only", worktrees: null }],
      jobsFile: path.join(logs, "jobs.json"),
      projectsCacheFile: path.join(logs, "projects.json"),
      assistantFile: path.join(logs, "assistant.json"),
      assistant: { enabled: false },
      // No gateway: nothing in this tool may start or steer a turn.
      apiServer: { url: "http://127.0.0.1:9", key: "none" },
      remoteBranchPolicy: "local-only",
      defaultCwd: repo,
    }),
  );
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath, HERMES_HOME: path.join(dir, "hermes"), API_SERVER_KEY: "", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) return { base, repo, dir, stop: () => { try { child.kill(); } catch { /* gone */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* busy */ } }, log };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`the sandbox panel never answered on ${base}\n${log.join("").slice(-2000)}`);
}

// ---- what the page records -------------------------------------------------------------------------------------
function pageInit({ thread, id, record, stream, blocks }) {
  // A 🌊 card is chosen per session in localStorage, and the reasoning joins its console only while 🧠 is on: both
  // are set before the page's own scripts run, so the card is BUILT in that shape (the control) instead of toggled.
  try {
    if (stream) {
      localStorage.setItem(`wtgui.stream.${thread}`, "1");
      localStorage.setItem(`wtgui.think.${thread}`, "1");
    }
  } catch {
    /* private mode: the card is drawn condensed and the stream checks say so */
  }
  const orig = window.EventSource;
  const R = (window.__w = { t0: performance.now(), phase: "drawn", samples: [], appends: [], errors: [] });
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.__card = null;
  window.__es = [];
  const withCard = (data) => {
    const d = JSON.parse(data || "{}");
    if (window.__card) d.jobs = (Array.isArray(d.jobs) ? d.jobs : []).filter((j) => j.id !== window.__card.id).concat([window.__card]);
    return JSON.stringify(d);
  };
  window.EventSource = class extends orig {
    constructor(...a) {
      super(...a);
      window.__es.push(this);
      const add = this.addEventListener.bind(this);
      this.addEventListener = (type, fn, opts) => {
        if (type === "jobs" || type === "snapshot") {
          return add(
            type,
            function (ev) {
              return fn.call(this, new MessageEvent(type, { data: withCard(ev.data) }));
            },
            opts,
          );
        }
        return add(type, fn, opts);
      };
    }
  };
  const now = () => Math.round((performance.now() - R.t0) * 10) / 10;
  const out = () => [...document.querySelectorAll("pre.job-out")].find((el) => el.dataset.out === String(id)) || null;
  const replyBox = () => document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  const read = () => {
    const o = out();
    if (!o) return null;
    const r = replyBox()?.getBoundingClientRect();
    return {
      rows: o.querySelectorAll(".jl").length,
      top: o.querySelectorAll(":scope > .jl").length,
      tools: o.querySelectorAll(".jl-tool").length,
      groups: o.querySelectorAll(".tgrp").length,
      sh: Math.round(o.scrollHeight),
      ch: Math.round(o.clientHeight),
      st: Math.round(o.scrollTop),
      replyTop: r ? Math.round(r.top) : null,
      scrollY: Math.round(window.scrollY),
      wait: o.querySelectorAll("[data-wait]").length,
      dimTop: Boolean(o.firstElementChild && o.firstElementChild.classList.contains("jl-dim")),
    };
  };
  window.__console = read;
  let last = "";
  const tick = () => {
    const s = read();
    // A repaint is the same console with the same rows: only a change in what it HOLDS is a sample.
    const k = s ? JSON.stringify([s.rows, s.tools, s.groups, s.sh, s.ch, s.st, s.replyTop, s.scrollY]) : "null";
    if (k !== last) {
      last = k;
      if (s) R.samples.push({ t: now(), phase: R.phase, ...s });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__showCard = () => {
    const es = window.__es.find((e) => e.readyState === 1) || window.__es[0];
    if (!es) return "no stream";
    // The record's own lines, but none of its ownership: a card attached to a project path this sandbox does not have
    // is dropped from the board before it is drawn, and the console is the thing under test.
    window.__card = {
      id,
      thread,
      turn: record.turn || 1,
      status: "running",
      prompt: record.prompt,
      displayPrompt: record.prompt,
      cwd: record.cwd,
      worktree: false,
      worktreePath: null,
      projectPath: null,
      ownerPath: null,
      branch: null,
      runId: record.runId || null,
      startedAt: record.startedAt,
      endedAt: null,
      model: record.model,
      lines: Array.isArray(record.lines) ? record.lines : [],
      artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
      attachments: Array.isArray(record.attachments) ? record.attachments : [],
      subagents: [],
    };
    // The console draws from the page's own line buffer, and a board render does not seed it from `lines` (only a
    // live frame does), so fill it the way updateJob does — with the run's real lines and nothing else.
    if (!state.jobLines.has(id) && record.lines?.length) state.jobLines.set(id, record.lines.slice());
    // The reasoning this thread recorded, so a 🌊 console merges it as its own rows exactly as it does live.
    if (blocks?.length) state.thinkCache.set(id, { blocks, at: Date.now() });
    es.dispatchEvent(new MessageEvent("jobs", { data: JSON.stringify({ jobs: [window.__card] }) }));
    return "dispatched";
  };
  window.__phase = (p) => (R.phase = p);
  // The POLL's own repaint: what the 1.2 s thinking sweep causes through loadThinking → paintThink → paintStreamConsole.
  window.__poll = () => {
    const conv = conversations().find((c) => c.thread === thread);
    const turn = conv && conv.turns.find((x) => x.id === id);
    if (!turn) return "no turn";
    paintThink(turn, "");
    return "polled";
  };
  // Which rows survive a repaint: stamp every row, then count the stamped nodes still in the console.
  window.__stamp = () => {
    const o = out();
    if (!o) return 0;
    [...o.children].forEach((n, i) => (n.__rowId = i));
    R.stamped = o.children.length;
    return R.stamped;
  };
  window.__survive = () => {
    const o = out();
    if (!o) return null;
    const now = [...o.children];
    const kept = now.filter((n) => n.__rowId != null).length;
    return { total: now.length, stamped: R.stamped || 0, kept, lost: now.length - kept };
  };
  // A selection the reader is holding in the console (three rows, mid-transcript), and whether it is still there.
  window.__select = () => {
    const o = out();
    if (!o) return null;
    const rows = [...o.children].filter((n) => n.querySelectorAll("div, span").length === 0 || n.textContent.trim());
    const a = rows[Math.min(2, rows.length - 1)];
    const b = rows[Math.min(4, rows.length - 1)];
    if (!a || !b) return null;
    const r = document.createRange();
    // The whole of two rows mid-transcript: enough that a repaint which replaces ANY of them loses the selection,
    // and no offsets to guess at (a row's first child may be an element or a text node).
    r.setStartBefore(a);
    r.setEndAfter(b);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return sel.toString().slice(0, 40);
  };
  window.__selection = () => String(window.getSelection()?.toString() || "").slice(0, 40);
  // A BAD read: the store answers nothing for a live turn (the shape a failed read takes). The card must keep what it
  // is showing — the console must not shrink and must not lose its newest rows.
  window.__shortRead = () => {
    const conv = conversations().find((c) => c.thread === thread);
    const turn = conv && conv.turns.find((x) => x.id === id);
    if (!turn) return "no turn";
    state.thinkCache.set(id, { blocks: [], at: Date.now() });
    paintThink(turn, "");
    return "polled empty";
  };
  // A reader parked mid-transcript: scrolled away from the end and unpinned, the way its own scroll handler does it.
  window.__park = (top) => {
    const o = out();
    if (!o) return null;
    state.outPinned[id] = false;
    o.scrollTop = top;
    return o.scrollTop;
  };
  window.__scroll = () => {
    const o = out();
    return o ? { st: Math.round(o.scrollTop), sh: Math.round(o.scrollHeight), top: Math.round(o.getBoundingClientRect().top) } : null;
  };
  window.__thinkRows = () => {
    const o = out();
    return o ? o.querySelectorAll(".jl-think").length : 0;
  };
  window.__restoreBlocks = (b) => {
    if (!b?.length) return 0;
    state.thinkCache.set(id, { blocks: b, at: Date.now() });
    return b.length;
  };
  window.__mode = () => ({ streamOn: streamOn(thread), thinkOn: thinkingOn(thread), blocks: (state.thinkCache.get(id)?.blocks || []).length });
  // The panel's own repaint: what a thinking sweep, a deliverable or an approval does to the card.
  window.__repaint = () => {
    renderConversation(thread);
    return typeof out() !== "undefined";
  };
  // ONE live line, through the panel's own entry point, with the gate flushed so the frame is deterministic.
  window.__line = (text) => {
    const known = state.jobLines.get(id) || [];
    const lid = Math.max(0, ...known.map((l) => Number(l && l.lid) || 0)) + 1;
    const evt = { id, line: { kind: "tool", text, lid, at: Date.now() } };
    R.appends.push({ t: now(), phase: R.phase, text, lid });
    appendJobLine(evt);
    try {
      state.typeGate?.drain();
    } catch {
      /* no gate */
    }
    return lid;
  };
}

// ---- main -------------------------------------------------------------------------------------------------------
const picked = pickRun();
if (picked.skip) {
  console.log(`SKIP  ${picked.skip}`);
  process.exit(0);
}
const run = picked.run;
const lines = Array.isArray(run.lines) ? run.lines : [];
console.log(`run ${run.id} (${run.thread} turn ${run.turn}): ${lines.length} lines, ${lines.filter((l) => l.kind === "tool" || l.kind === "tool-out").length} tool lines, ${run.status}`);
// The reasoning is only read in the 🌊 scenario: the condensed card draws it as a block, and this tool measures the
// console. A thread that recorded none is a skip there (an empty stream measures nothing), never a failure.
let blockSet = [];
let blockFrom = "";
if (STREAM) {
  const reasoning = await loadReasoning(run.thread);
  if (reasoning.skip) {
    console.log(`SKIP  --stream needs the turn's reasoning: ${reasoning.skip}`);
    process.exit(0);
  }
  blockSet = reasoning.blocks;
  blockFrom = reasoning.from;
  console.log(`reasoning: ${blockSet.length} blocks / ${blockSet.reduce((n, b) => n + String(b.text || "").length, 0)} chars from ${blockFrom}`);
}

const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(0);
}
mkdirSync(REPORT_DIR, { recursive: true });
const sb = await startSandbox();
const stamp = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return path.basename(ROOT);
  }
})();
const out = { root: ROOT, commit: stamp, mode: STREAM ? "stream" : "condensed", run: run.id, thread: run.thread, lines: lines.length, reasoning: blockSet.length, blocksFrom: blockFrom, at: new Date().toISOString(), checks: [], errors: [] };
let failures = 0;
const check = (name, got, want, extra = "") => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  out.checks.push({ name, ok, got, want });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}${extra ? `\n        ${extra}` : ""}`}`);
};
const browser = await pw.chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(pageInit, { thread: run.thread, id: run.id, record: run, stream: STREAM, blocks: blockSet });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e)));
  page.on("console", (m) => {
    if (m.type() === "error") out.errors.push("console: " + m.text().slice(0, 300));
  });
  await page.goto(sb.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
  await sleep(1200);
  out.shown = await page.evaluate(() => window.__showCard());
  try {
    await page.waitForFunction(() => document.querySelectorAll("pre.job-out .jl").length > 5, null, { timeout: 30000 });
  } catch (e) {
    // A card that never draws its console is worth more than a bare timeout: say what the page holds.
    out.dom = await page.evaluate(() => ({
      cards: [...document.querySelectorAll(".job")].map((j) => j.dataset.thread),
      outs: [...document.querySelectorAll("pre.job-out")].map((o) => ({ out: o.dataset.out, rows: o.querySelectorAll(".jl").length, len: o.textContent.length })),
      jobLines: (state.jobLines.get(window.__card?.id) || []).length,
      cardLines: (window.__card?.lines || []).length,
      stateLines: (state.jobs.get(window.__card?.id)?.lines || []).length,
      streamOn: typeof streamOn === "function" ? streamOn(window.__card?.thread) : "n/a",
      consoleHtml: (document.querySelector("pre.job-out")?.innerHTML || "").slice(0, 300),
      bodyText: document.body.textContent.replace(/\s+/g, " ").slice(0, 400),
    }));
    console.log("the card did not draw a console:", JSON.stringify(out.dom, null, 1));
    throw e;
  }
  await sleep(1500);
  out.shape = await page.evaluate(() => {
    const o = document.querySelector("pre.job-out");
    const r = o?.getBoundingClientRect();
    const cs = o ? getComputedStyle(o) : null;
    return {
      rect: r ? { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) } : null,
      display: cs?.display,
      visibility: cs?.visibility,
      overflow: cs?.overflowY,
      maxHeight: cs?.maxHeight,
      hiddenAttr: o ? o.hidden : null,
      cardClass: o?.closest(".job")?.className,
      wrapClass: o?.closest(".out-wrap")?.className,
      rows: o?.querySelectorAll(".jl").length,
      clientH: o?.clientHeight,
      scrollH: o?.scrollHeight,
    };
  });
  const shot = async (name) => {
    if (!SHOTS) return;
    const f = path.join(REPORT_DIR, `console-live-${stamp}-${name}.png`);
    await page.locator(`pre.job-out[data-out="${run.id}"]`).screenshot({ path: f }).catch(() => {});
  };
  const drawn = await page.evaluate(() => window.__console());
  out.mode = await page.evaluate(() => window.__mode());
  out.thinkRows = await page.evaluate(() => window.__thinkRows());
  await shot("1-drawn");
  // A full repaint, exactly as the panel causes one.
  await page.evaluate(() => {
    window.__phase("repaint");
    window.__repaint();
  });
  await sleep(900);
  const repainted = await page.evaluate(() => window.__console());
  await shot("2-repainted");
  // THE POLL — the reasoning re-read's own repaint. In a condensed card it redraws the block; in a 🌊 card it redraws
  // the console, which is where the console's rows used to be thrown away several times a second.
  const stamped = await page.evaluate(() => window.__stamp());
  const selected = await page.evaluate(() => window.__select());
  await page.evaluate(() => {
    window.__phase("poll");
    window.__poll();
  });
  const survived = await page.evaluate(() => window.__survive());
  const selectionAfter = await page.evaluate(() => window.__selection());
  await sleep(900);
  const polled = await page.evaluate(() => window.__console());
  await shot("3-polled");
  // A READ THAT WOULD LOSE THE NEWEST ROWS: the store answers nothing for a live turn. Nothing may be drawn.
  const beforeShort = await page.evaluate(() => window.__console());
  await page.evaluate(() => {
    window.__phase("short");
    window.__shortRead();
  });
  await sleep(200);
  const afterShort = await page.evaluate(() => window.__console());
  // Put the reasoning back, so the live line and the last shot are taken on the card as it was.
  await page.evaluate((b) => window.__restoreBlocks(b), blockSet);
  await sleep(600);
  // ONE live line after that.
  await page.evaluate(() => {
    window.__phase("line");
    window.__line("💻 terminal · echo console-probe");
  });
  await sleep(900);
  const appended = await page.evaluate(() => window.__console());
  await shot("4-appended");
  const R = await page.evaluate(() => window.__w);
  out.drawn = drawn;
  out.repainted = repainted;
  out.polled = polled;
  out.poll = { stamped, survived, selected, selectionAfter };
  out.shortRead = { before: beforeShort, after: afterShort };
  out.appended = appended;
  out.samples = R.samples;
  out.appends = R.appends;
  check("the console drew a real transcript (>= 20 rows, >= 5 tool rows, >= 1 burst group)", Boolean(drawn && drawn.rows >= 20 && drawn.tools >= 5 && drawn.groups >= 1), true, `drawn: ${JSON.stringify(drawn)}`);
  check(
    "the console opens on a dim note, so the wipe path was armed",
    Boolean(drawn && drawn.dimTop),
    true,
    `first child is a dim row: ${drawn?.dimTop}`,
  );
  check(
    "a full repaint keeps every row and does not take 40px of the console's height away",
    Boolean(repainted && drawn && repainted.rows >= drawn.rows && repainted.sh >= drawn.sh - 40),
    true,
    `repaint: ${JSON.stringify(repainted)}`,
  );
  if (STREAM) {
    check(
      "the 🌊 card drew its reasoning as rows of the console (>= 2 .jl-think)",
      Boolean(out.mode?.streamOn && out.mode?.thinkOn && out.thinkRows >= 2),
      true,
      `mode: ${JSON.stringify(out.mode)}, thinking rows: ${out.thinkRows}`,
    );
    check(
      "a POLL repaint keeps the nodes of the rows that did not change (the console is patched, not replaced)",
      Boolean(survived && survived.kept >= survived.total - 3),
      true,
      `stamped ${survived?.stamped} rows, ${survived?.kept} of ${survived?.total} still the same nodes: ${JSON.stringify(out.poll)}`,
    );
    check(
      "a text selection standing in the console survives a poll repaint",
      Boolean(selected && selectionAfter && selectionAfter === selected),
      true,
      `selected ${JSON.stringify(selected)} → ${JSON.stringify(selectionAfter)}`,
    );
    check(
      "a poll whose body would drop rows from the middle draws nothing (row count and place held)",
      Boolean(beforeShort && afterShort && afterShort.rows === beforeShort.rows && afterShort.sh >= beforeShort.sh - 2 && afterShort.st >= beforeShort.st - 2),
      true,
      `before ${JSON.stringify(beforeShort)} → after ${JSON.stringify(afterShort)}`,
    );
  }
  check(
    "one live line after a repaint adds a row instead of replacing the console",
    Boolean(appended && repainted && appended.rows >= repainted.rows + 1 && appended.sh >= repainted.sh - 40),
    true,
    `after the line: ${JSON.stringify(appended)}`,
  );
  check(
    "nothing under the console moves up (the reply box may be pushed down, never pulled up)",
    Boolean(drawn && repainted && appended && repainted.replyTop >= drawn.replyTop - 2 && appended.replyTop >= repainted.replyTop - 2),
    true,
    `reply box top: ${drawn?.replyTop} -> ${repainted?.replyTop} -> ${appended?.replyTop}`,
  );
  check("no page errors", out.errors.length, 0);
  const drops = R.samples.filter((s, i) => i > 0 && s.rows < R.samples[i - 1].rows);
  out.drops = drops;
  console.log(`\nconsole over the run: ${R.samples.length} painted states; ${R.appends.length} live line${R.appends.length === 1 ? "" : "s"}; ${drops.length} fall${drops.length === 1 ? "" : "s"} in row count`);
  for (const d of drops.slice(0, 5)) console.log(`   dropped at ${Math.round(d.t)} ms [${d.phase}] to ${d.rows} rows / ${d.sh}px`);
  console.log(`rows ${drawn?.rows} → ${repainted?.rows} after a repaint → ${appended?.rows} after one line; height ${drawn?.sh} → ${repainted?.sh} → ${appended?.sh}`);
  if (STREAM) {
    console.log(`mode ${JSON.stringify(out.mode)}; the poll kept ${out.poll?.survived?.kept}/${out.poll?.survived?.total} row nodes (was ${out.poll?.survived?.stamped} stamped)`);
    console.log(`selection ${JSON.stringify(out.poll?.selected)} → ${JSON.stringify(out.poll?.selectionAfter)}; a short read left ${out.shortRead?.after?.rows} rows at scrollTop ${out.shortRead?.after?.st} (before ${out.shortRead?.before?.rows} at ${out.shortRead?.before?.st})`);
  }
  console.log(`console box ${out.shape?.rect?.h}px (client ${out.shape?.clientH}, content ${out.shape?.scrollH}); reply box top ${drawn?.replyTop} → ${repainted?.replyTop} → ${appended?.replyTop}`);
} finally {
  await browser.close().catch(() => {});
  sb.stop();
}
out.failures = failures;
const file = path.join(REPORT_DIR, `console-live-${stamp}${STREAM ? "-stream" : ""}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\n${failures ? "FAIL" : "PASS"}  ${out.checks.length - failures}/${out.checks.length} checks  → ${file}`);
process.exit(failures ? 1 : 0);
