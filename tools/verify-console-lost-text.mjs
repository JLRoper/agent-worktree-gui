// A paragraph the reader was watching when they switched away is drawn WHOLE when they come back.
//
// The finding this gates: the console types a live paragraph out word by word, and the only thing that knows how much
// may be drawn is the pacer (core/type-stream.js). A repaint asks it for a prefix of the line — but while a tab is
// hidden the page drew every frame whole and never fed the pacer, so the pacer stopped at the text the paragraph had
// when the reader left. When they came back, every repaint (the 5 s row pass, a thinking sweep, a status flip) drew
// that old prefix over the whole line: "This" for a paragraph that starts "This branch was added to main as version
// 0.47.0.", "Because it was a rebase mer" for one that goes on for two more lines. The text was never missing from the
// job store — only from the screen — so a reload put it back and nothing else did.
//
// What is driven: a sandbox panel of THIS checkout (its own PANEL_CONFIG / jobs.json / HERMES_HOME, its own free port,
// API_SERVER_KEY empty, a gateway pointed at a closed port so nothing can be posted), and a real browser over it. The
// turn's frames go through the page's own recordJobLine + drawJobLine — the pair the SSE handler calls — and the
// repaint is the page's own turnBody(turn), the renderer a card rebuild uses. The tab is hidden and shown again by
// overriding document.hidden and dispatching visibilitychange, which is the same signal the browser delivers. Nothing
// is posted, no live panel is touched, and no line is invented: the paragraphs are a run's own answer.
//
// CHECKS (exit 1 while any fails)
//   (1) the console was typing: at least three of the five paragraphs were drawn short while the tab was visible, so a
//       clean run is not a run where the pacer never started
//   (2) after the tab was hidden mid-type and shown again, EVERY row draws its whole record — 0 short rows, 0 missing
//       characters (this is the finding: on the unfixed tree it was 5 rows and 506 characters)
//   (3) no page errors
//
//   node tools/verify-console-lost-text.mjs
//   node tools/verify-console-lost-text.mjs --root <checkout>   # gate another checkout (e.g. a git archive export)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright } from "./browser.mjs";
import { createVerifier } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// The paragraphs are the shape of a real answer — a lead-in, a short verdict, then long ones — because how much of a
// line the pacer has handed out when the tab goes away is what the console then keeps for good.
const PARAGRAPHS = [
  "Checking fresh rather than repeating myself: what main holds now, which commit put this branch's version there, and what version your board reports.",
  "This branch was added to main as version 0.47.0.",
  "Before it landed, main was at 0.46.8 (c4a0093). PR #174 merged at 12:55 PM EST and took main to 0.47.0; its last commit, e237d6e, is the one that changed the number.",
  "Because it was a rebase merge, the PR's first five commits show 0.46.8 in package.json, and only the sixth (e237d6e) sets 0.47.0. They all landed together in that one merge.",
  "Your board on 7331 now reports 0.47.0 too: it restarted at 1:28 PM EST and picked up the new number.",
];

async function startSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-lost-text-"));
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  writeFileSync(path.join(logs, "jobs.json"), JSON.stringify({ savedAt: new Date().toISOString(), jobs: [] }), "utf8");
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
      slowSeconds: 60,
      refreshSeconds: 3600,
      fetchSeconds: -1,
      projects: [],
      jobsFile: path.join(logs, "jobs.json"),
      projectsCacheFile: path.join(logs, "projects.json"),
      assistantFile: path.join(logs, "assistant.json"),
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:1", key: "stub" },
      remoteBranchPolicy: "local-only",
      defaultCwd: dir,
    }),
    "utf8",
  );
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath, HERMES_HOME: path.join(dir, "home"), API_SERVER_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const plog = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (x) => plog.push(x));
  child.stderr.on("data", (x) => plog.push(x));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`sandbox panel exited: ${plog.join("").slice(-800)}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 300) throw new Error(`sandbox panel did not start: ${plog.join("").slice(-800)}`);
    await sleep(100);
  }
  return {
    base,
    stop() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a handle may still be open on Windows */
      }
    },
  };
}

// The drive. Runs IN the page, against its own functions: recordJobLine + drawJobLine are what the `jobline` SSE frame
// does, and turnBody is the console half of a card rebuild. The clock is stepped by hand (pacer.tick) so the paragraph
// is mid-type on demand instead of on a timer a hidden tab would throttle.
function driveInPage({ paragraphs }) {
  const lids = paragraphs.map((_, i) => `probe-${i + 1}`);
  const id = "probe-lost-text";
  const pacer = state.typePacer;
  const seen = (v) => Object.defineProperty(document, "hidden", { configurable: true, get: () => v });
  seen(false); // the reader is looking at the board
  lids.forEach((l) => pacer?.forget(l));
  document.querySelectorAll('[data-probe="1"]').forEach((e) => e.remove());
  const card = document.createElement("div");
  card.className = "job";
  card.dataset.thread = "probe-thread";
  card.dataset.probe = "1";
  const out = document.createElement("pre");
  out.className = "job-out";
  out.dataset.out = id;
  card.appendChild(out);
  document.body.appendChild(card);
  const turn = { id, thread: "probe-thread", turn: 1, status: "running", prompt: "probe", lines: [], cwd: "C:/probe", startedAt: new Date().toISOString() };
  state.jobs.set(id, turn);
  state.jobLines.set(id, []);
  const frame = (i, text) => {
    const line = { kind: "text", lid: lids[i], at: Date.now(), mode: "set", text };
    recordJobLine({ id, line });
    drawJobLine({ id, line });
  };
  const readRows = (scope) =>
    [...scope.querySelectorAll("[data-lid]")].map((el) => {
      const rec = String(el.dataset.ltext ?? "");
      const drawn = String(el.textContent ?? "");
      return { lid: el.dataset.lid, drawn, rec, short: rec.length - drawn.length };
    });
  // The first fifth of each paragraph: the wire's first frame for it, as a streaming model sends it.
  const first = paragraphs.map((t) => t.slice(0, Math.max(8, Math.round(t.length * 0.2))));
  for (let i = 0; i < paragraphs.length; i++) frame(i, first[i]);
  const t0 = Date.now();
  for (let k = 1; k <= 2; k++) pacer.tick(t0 + k * 60);
  const before = readRows(out);
  // The reader switches away mid-type, and the wire finishes the answer while nobody is looking.
  seen(true);
  document.dispatchEvent(new Event("visibilitychange"));
  for (let i = 0; i < paragraphs.length; i++) frame(i, paragraphs[i]);
  // They come back, and the card is rebuilt from its record.
  seen(false);
  document.dispatchEvent(new Event("visibilitychange"));
  let html;
  try {
    html = turnBody(state.jobs.get(id));
  } catch {
    html = '<pre class="job-out">' + (state.jobLines.get(id) || []).map((l) => lineHtml(l)).join("") + "</pre>";
  }
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const repaint = readRows(holder);
  document.querySelectorAll('[data-probe="1"]').forEach((e) => e.remove());
  state.jobs.delete(id);
  state.jobLines.delete(id);
  lids.forEach((l) => pacer?.forget(l));
  return {
    beforeShort: before.filter((r) => r.short > 0).length,
    rows: repaint.map((r) => ({ lid: r.lid, drawn: r.drawn.slice(0, 60), rec: r.rec.slice(0, 60), short: r.short })),
    short: repaint.filter((r) => r.short > 0).length,
    missingChars: repaint.reduce((n, r) => n + Math.max(0, r.short), 0),
  };
}

async function main() {
  const playwright = loadPlaywright({ root: ROOT, cwd: path.resolve(ROOT) });
  if (!playwright) {
    console.log("BROWSER-HALF-NOT-RUN: no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a dir with node_modules/playwright)");
    process.exit(2);
  }
  const v = createVerifier();
  const sb = await startSandbox();
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
    await page.goto(sb.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.typePacer && state.jobs, null, { timeout: 30000 });
    const measured = await page.evaluate(driveInPage, { paragraphs: PARAGRAPHS });
    console.log(`  read: ${measured.beforeShort}/${PARAGRAPHS.length} paragraphs were mid-type when the tab went away; ` +
      `after the repaint ${measured.short}/${measured.rows.length} rows are short (${measured.missingChars} characters)`);
    for (const r of measured.rows) console.log(`   ${r.short > 0 ? "SHORT" : "     "} ${r.lid}: "${r.drawn}"`);
    v.ok("the console was typing when the tab went away", measured.beforeShort >= 3, `${measured.beforeShort} of ${PARAGRAPHS.length} rows drawn short`);
    v.ok("every paragraph is whole after the reader comes back", measured.short === 0, `${measured.short} short row(s), ${measured.missingChars} missing character(s)`);
    v.ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" · "));
    await ctx.close();
  } finally {
    await browser.close().catch(() => {});
    sb.stop();
  }
  console.log(process.exitCode ? "" : `${v.checks - v.failures}/${v.checks} checks passed`);
  process.exitCode = v.failures ? 1 : 0;
}

await main();
