// What the NORMAL console does when the card is repainted and ONE more line arrives.
//
// The reasoning block is polled and redrawn; the console is the other half of the same card and it has its own way
// of looking like it flickers: `drawJobLine` used to clear the console whenever its first child was a `.jl-dim` line,
// which is right for the "waiting for output…" placeholder and wrong for a real dim note ("⇢ asked to work in …",
// "cut from …", "push guard: …"). Every full repaint puts such a note on top, so the next live line wiped everything
// the reader had and drew only itself until the following repaint put it back — the console and everything under it
// riding up and down. That is fixed (public/app.js drawJobLine clears only `[data-wait]`), and this measures whether
// it stays fixed on REAL content rather than on a fixture.
//
//   node tools/measure-console-live.mjs                    # this checkout, newest real run with tool output
//   node tools/measure-console-live.mjs --root <checkout>  # measure another checkout (e.g. a `git archive` export)
//   node tools/measure-console-live.mjs --run <id>         # name the run to draw
//   node tools/measure-console-live.mjs --jobs <file>      # the job store to read (default <WAG_HOME>/state/jobs.json)
//   node tools/measure-console-live.mjs --report <dir>     # where the JSON + shots go (default C:/CodeReviews/agent-worktree-gui)
//   node tools/measure-console-live.mjs --shots            # also write the before/after screenshots
//
// WHAT IS DRIVEN, and what is not
//   * a sandbox panel of its own — free port, own PANEL_CONFIG / jobs.json / projects cache, assistant off, a gateway
//     pointed at a closed port so nothing can be posted — serving the chosen checkout's public/, so no live panel is
//     touched;
//   * ONE card drawn client-side from a REAL finished run's own record and its own `lines`, taken read-only out of the
//     panel's job store. No turn is started, nothing is posted, and no line is invented: the console is the transcript
//     that run actually produced;
//   * then the two things a live card does to it: a FULL REPAINT (`renderConversation`, what the thinking sweep, a new
//     deliverable or an approval causes) and ONE live line through the panel's own `appendJobLine`/`drawJobLine`.
//     Both are followed per painted frame by the console's own numbers and by where the reply box under it sits.
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
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const REPORT_DIR = opt("--report", "C:/CodeReviews/agent-worktree-gui");
const WANT_RUN = opt("--run");
const SHOTS = argv.includes("--shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function pageInit({ thread, id, record }) {
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
    es.dispatchEvent(new MessageEvent("jobs", { data: JSON.stringify({ jobs: [window.__card] }) }));
    return "dispatched";
  };
  window.__phase = (p) => (R.phase = p);
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

function loadPlaywright() {
  for (const root of [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd(), "C:/Users/roper/AppData/Roaming/npm/node_modules"].filter(Boolean)) {
    for (const p of [path.join(root, "node_modules", "playwright"), path.join(root, "playwright"), root]) {
      try {
        return require(p);
      } catch {
        /* not there */
      }
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
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
const out = { root: ROOT, commit: stamp, run: run.id, thread: run.thread, lines: lines.length, at: new Date().toISOString(), checks: [], errors: [] };
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
  await ctx.addInitScript(pageInit, { thread: run.thread, id: run.id, record: run });
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
  await shot("1-drawn");
  // A full repaint, exactly as the panel causes one.
  await page.evaluate(() => {
    window.__phase("repaint");
    window.__repaint();
  });
  await sleep(900);
  const repainted = await page.evaluate(() => window.__console());
  await shot("2-repainted");
  // ONE live line after that repaint.
  await page.evaluate(() => {
    window.__phase("line");
    window.__line("💻 terminal · echo console-probe");
  });
  await sleep(900);
  const appended = await page.evaluate(() => window.__console());
  await shot("3-appended");
  const R = await page.evaluate(() => window.__w);
  out.drawn = drawn;
  out.repainted = repainted;
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
  console.log(`console box ${out.shape?.rect?.h}px (client ${out.shape?.clientH}, content ${out.shape?.scrollH}); reply box top ${drawn?.replyTop} → ${repainted?.replyTop} → ${appended?.replyTop}`);
} finally {
  await browser.close().catch(() => {});
  sb.stop();
}
out.failures = failures;
const file = path.join(REPORT_DIR, `console-live-${stamp}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\n${failures ? "FAIL" : "PASS"}  ${out.checks.length - failures}/${out.checks.length} checks  → ${file}`);
process.exit(failures ? 1 : 0);
