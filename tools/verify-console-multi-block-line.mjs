// A long answer that arrives as ONE console line, drawn whole.
//
// lib/jobs.js keeps one open console line per paragraph and grows it; a gateway can also hand the whole answer over
// in a single delta, and then the line a turn's record holds is one string with every physical line of the answer
// inside it. Job 6073fb2a (thread panel-assistant-5, turn 12) is exactly that: one `text` line of 4,446 characters,
// 26 newlines, starting "Here is a deliberately long answer - if the bottom is cut again, the fix did not take." and
// ending 27 physical lines later. On 1.91.2 the console drew its first sentence and nothing else.
//
// This harness takes that STORED line, from the panel's own /api/jobs or from a snapshot file, and draws it through
// the page's real path in a real browser: the live append (`recordJobLine` -> `drawJobLine`, one frame carrying the
// whole line), the block planner and the pacer, then the settle. It measures what reached the DOM against what the
// record holds, and it asserts the two are the same characters.
//
//   node tools/verify-console-multi-block-line.mjs                       # live panel on :7331
//   node tools/verify-console-multi-block-line.mjs --jobs jobs.json      # a snapshot
//   JOB=6073fb2a SHOT=shot.png node tools/verify-console-multi-block-line.mjs
//   PANEL_ROOT=<git archive of origin/main> node tools/verify-console-multi-block-line.mjs   # the red proof
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPage, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PANEL_ROOT ? path.resolve(process.env.PANEL_ROOT) : path.join(HERE, "..");
const WIDTH = Number(process.env.WIDTH || 1109);
const HEIGHT = Number(process.env.HEIGHT || 900);
const JOB = process.env.JOB || "6073fb2a";
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const JOBS = argOf("jobs") || process.env.JOBS || `http://127.0.0.1:7331/api/jobs`;

// The turn's stored line: the longest prose line of the named job. Read from the live panel unless a snapshot file
// is named, so the harness measures the answer the reader actually has.
async function storedLine() {
  const body = /^https?:/i.test(JOBS)
    ? await (await fetch(JOBS, { signal: AbortSignal.timeout(10_000) })).text()
    : readFileSync(path.resolve(JOBS), "utf8");
  const data = JSON.parse(body);
  const jobs = Array.isArray(data) ? data : data.jobs || [];
  const job = jobs.find((j) => String(j.id || "").startsWith(JOB));
  if (!job) throw new Error(`no job ${JOB} in ${JOBS}`);
  const prose = (job.lines || []).filter((l) => (l.kind === "text" || l.kind === "final") && l.text);
  if (!prose.length) throw new Error(`job ${JOB} has no prose line`);
  const line = prose.reduce((a, b) => (String(b.text).length > String(a.text).length ? b : a));
  return { line, job };
}

const { line: LINE, job } = await storedLine();
const STORED = String(LINE.text);
const SEGMENTS = STORED.split("\n");
const BLANKS = SEGMENTS.filter((s) => s === "").length;
const NONBLANK = SEGMENTS.filter((s) => s !== "");

// The fixture: the shipped scripts, a card and a console, and nothing else. The turn is driven the way the wire
// drives it - one frame, the whole line - then settled through the page's own path.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>one line, every block</title>
<link rel="stylesheet" href="/public/style.css">
</head>
<body style="margin:0;padding:18px;background:#0d1117">
<div class="job" id="card" style="max-width:760px">
  <div class="job-head mono">Assistant #12</div>
  <div class="job-body" id="body"><div class="turn"><div class="out-wrap" id="wrap"></div></div></div>
  <div class="job-foot mono" id="foot">done \u00b7 3m 04s</div>
</div>
<div class="job" id="whole" style="max-width:760px;margin-top:18px">
  <div class="job-head mono">The same turn, drawn without the console's height cap</div>
  <div class="job-body" id="whole-body"></div>
</div>
<script src="/public/core/dom-format.js"></script>
<script src="/public/core/console-format.js"></script>
<script src="/public/core/console-markdown.js"></script>
<script src="/public/core/type-stream.js"></script>
<script src="/public/board/console.js"></script>
<script>
  const STORED = ${JSON.stringify(STORED)};
  const LINE = ${JSON.stringify({ kind: LINE.kind || "text", lid: LINE.lid ?? 385234 })};
  window.__out = { stored: STORED.length };
  window.addEventListener("error", (e) => { (window.__out.errors = window.__out.errors || []).push(String((e.error && e.error.stack) || e.message)); });
  window.state = {
    typeStream: null, outPinned: {}, outScrolls: {}, outHeights: {},
    subConsoles: new Map(), subConsoleReads: new Map(), subConsolePinned: new Map(), openSubConsole: new Set(),
    collapsedSubs: new Set(), codeBoxShut: new Set(), foldRows: new Map(), toolStore: new Map(), typed: new Map(),
    thinkPinned: new Map(), thinkLoading: new Set(), thinkOpen: new Set(), openFences: new Set(), toolGroups: new Map(),
    consoleFocus: new Set(), consoleRaw: new Set(), codeBoxOpen: new Set(), callFolded: new Set(), callOpen: new Set(),
    batchCalls: new Map(), foldPending: new Map(), jobLines: new Map(), jobs: new Map(), reasoningReads: new Map(),
    subConsoleTop: new Map(), thinkCache: new Map(), thinkClosed: new Set(), thinkFed: new Set(),
    thinkScroll: new Map(), toolGroupOpen: new Map(), toolStorePending: new Set(),
  };
  window.toolGroupsOn = () => false;
  window.paintSubagents = () => {};
  window.apiFetch = () => Promise.reject(new Error("no api in the fixture"));
  window.refreshTurnPeek = () => {};
  window.refreshJobPreview = () => {};
  window.updateJobFoot = () => {};
  // settings.js's one-stream-per-turn switch: this fixture draws a single turn as one stream.
  window.streamOn = () => true;
  // board-scaffold.js's liveness rule, and app.js's jobLines(): the fixture only ever holds one running turn.
  window.turnLive = (job) => Boolean(job && job.status === "running");
  window.jobLines = (id) => window.state.jobLines.get(String(id)) || [];
  // app.js's tab ceiling: one turn in the fixture, so it never trims.
  window.trimJobLines = () => {};

  // The pacer on a clock this harness drives, so nothing here waits on a real timer.
  let t = 0;
  const P = globalThis.wtType.createDrawStream({ rate: 40, now: () => t, schedule: () => 1, cancel: () => {}, onPaint: (lids) => paintTypedLines(lids) });
  window.state.typeStream = P;
  window.WMApp.core.consoleFormat.setShownFor(typedShown);

  const JOB = "job-multiblock";
  const body = document.getElementById("body");
  body.insertAdjacentHTML("beforeend", '<pre class="job-out" data-out="' + JOB + '"></pre>');

  // The record, and the wire's one frame carrying the WHOLE line - the reproduction, not a shortened stand-in.
  // The REBUILD path is measured FIRST, before any frame reaches the page: that is a card repaint (or a page load)
  // drawing the turn's stored record, which is what the reader's card was showing when the answer stopped after its
  // first sentence. On 1.91.2 it draws the first physical line of the store line and stops - 86 characters.
  const rebuilt = document.createElement("div");
  rebuilt.innerHTML = consoleMdHtml([{ ...LINE, text: STORED }]);
  window.__out.rebuild = {
    rows: rebuilt.querySelectorAll("[data-lid]").length,
    blocks: rebuilt.querySelectorAll(".md-block").length,
    text: rebuilt.textContent.length,
    tail: rebuilt.textContent.slice(-70),
  };

  const evt = { id: JOB, line: { ...LINE, text: STORED, mode: "new" } };
  recordJobLine(evt);
  drawJobLine(evt);

  // The row state at the moment the frame is drawn: this is where 1.91.2 stopped after the first sentence.
  const atFrame = () => {
    const out = document.querySelector("pre.job-out");
    const rows = [...out.querySelectorAll("[data-lid]")];
    return {
      rows: rows.length,
      drawn: rows.reduce((n, r) => n + r.textContent.length, 0),
      ltext: rows.reduce((n, r) => n + (r.dataset.ltext || "").length, 0),
      tail: rows.length ? rows[rows.length - 1].textContent.slice(-70) : null,
      scrollH: out.scrollHeight, clientH: out.clientHeight,
    };
  };
  window.__out.frame = atFrame();
  window.__out.pacerFeed = P.feed ? "live" : "none";

  // Let the pacer finish every row it was given, then settle the turn the way the panel does.
  t += 60_000; P.tick(t);
  window.__out.typed = atFrame();
  flushTypeStream(JOB);
  window.__out.settled = atFrame();

  // What the console holds, character for character: the raw view writes consoleMdRawText with textContent, and each
  // row's data-ltext is the physical line it was drawn from.
  const rows = [...document.querySelectorAll("pre.job-out [data-lid]")];
  window.__out.readback = rows.map((r) => r.dataset.ltext || "").filter((s) => s !== "");
  window.__out.raw = consoleMdRawText(jobLines(JOB));
  const out = document.querySelector("pre.job-out");
  window.__out.dom = {
    text: rows.map((r) => r.textContent).join("\\n"),
    visible: out.innerText.length,
    textContent: out.textContent.length,
    innerText: out.innerText.length,
    scrollH: out.scrollHeight, clientH: out.clientHeight,
    maxH: getComputedStyle(out).maxHeight, overflowY: getComputedStyle(out).overflowY,
    scrollable: out.scrollHeight - out.clientHeight,
    lastRowBottom: rows.length ? Math.round(rows[rows.length - 1].getBoundingClientRect().bottom) : null,
    consoleBottom: Math.round(out.getBoundingClientRect().bottom),
    blocks: [...out.querySelectorAll(".md-block")].map((b) => b.className.replace("md-block", "").trim() || "para"),
  };

  // The same turn with the console's height cap lifted, so a screenshot carries every block of the answer.
  const whole = document.createElement("div");
  whole.className = "turn";
  whole.innerHTML = '<pre class="job-out" style="max-height:none;overflow:visible">' + consoleMdHtml(jobLines(JOB)) + "</pre>";
  document.getElementById("whole-body").appendChild(whole);
  window.__out.whole = {
    blocks: [...whole.querySelectorAll(".md-block")].length,
    height: Math.round(whole.getBoundingClientRect().height),
    tail: whole.textContent.slice(-70).replace(/\\s+/g, " "),
  };
</script>
</body></html>`;

const TYPES = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html" };
function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404).end("not found"); }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `: ${extra}` : ""}`);
};

console.log(`\n== ${job.id} turn ${job.turn}, one ${STORED.length}-character line over ${ROOT}`);
console.log(`== stored ${STORED.length} chars, ${SEGMENTS.length} physical lines (${BLANKS} blank, ${NONBLANK.length} with words)`);
const { server, base } = await serve();
try {
  const res = await withBrowser(async ({ page }) => {
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e.message || e)));
    await openPage(page, base, { selector: "pre.job-out" });
    await page.waitForTimeout(250);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
    return { out: await page.evaluate(() => window.__out), errs };
  }, { viewport: { width: WIDTH, height: HEIGHT } });
  if (res && res.skipped) { console.log("BROWSER-HALF-NOT-RUN"); failures += 1; }
  else {
    const { out, errs } = res;
    ok("the page threw nothing", errs.length === 0, errs.join(" | ").slice(0, 200));
    if (out.errors) console.log("PAGE ERRORS: " + out.errors.join(" | "));
    ok("the stored line is the 4,446-character reproduction", out.stored === 4446, `${out.stored} chars`);
    if (!out.frame || !out.dom) {
      console.log("\nFAIL  the page never drew the turn, so nothing could be measured");
    } else {
    ok("the console drew a row for every non-blank physical line", out.frame.rows === NONBLANK.length,
      `${out.frame.rows} rows for ${NONBLANK.length} physical lines with words`);
    ok("a rebuild of the same record draws every block too", out.rebuild.rows === NONBLANK.length && out.rebuild.blocks >= 5,
      `${out.rebuild.rows} rows, ${out.rebuild.blocks} blocks, ${out.rebuild.text} chars of text`);
    ok("a rebuild reaches the answer's last line", /fresh report from the reader shows it still clipping/i.test(out.rebuild.tail || ""),
      JSON.stringify(out.rebuild.tail));
    ok("every block in the line is a block", out.dom.blocks.length >= 5, out.dom.blocks.join(","));
    ok("the answer's last words reach the reader", /fresh report from the reader shows it still clipping/i.test(out.settled.tail || ""),
      JSON.stringify(out.settled.tail));
    ok("every row reads back its own physical line, character for character",
      JSON.stringify(out.readback) === JSON.stringify(NONBLANK), `${out.readback.length} rows`);
    ok("the raw view is the whole line", out.raw === STORED, `${out.raw.length} of ${STORED.length} chars`);
    ok("the console scrolls or grows, it does not clip",
      out.dom.scrollH > out.dom.clientH ? out.dom.overflowY !== "hidden" : true,
      `${out.dom.scrollH} px of content in a ${out.dom.clientH} px box (max-height ${out.dom.maxH}, overflow ${out.dom.overflowY}, ${out.dom.scrollable} px scrollable)`);
    ok("no CSS clamp hides the text", out.dom.maxH === "none" || out.dom.overflowY !== "hidden",
      `max-height ${out.dom.maxH}, overflow ${out.dom.overflowY}`);
    ok("the whole reply is drawn when the cap is lifted", out.whole.blocks === out.dom.blocks.length,
      `${out.whole.blocks} blocks, ${out.whole.height} px tall, ends ${JSON.stringify(out.whole.tail)}`);
    console.log(`\n== rendered ${out.dom.visible} visible chars, ${out.dom.blocks.length} blocks, ${out.frame.rows} rows; read back ${out.readback.join("\n").length} chars of ${STORED.length}; raw ${out.raw.length}`);
    }
  }
} finally {
  server.close();
}
console.log(`\n${failures ? "FAIL" : "PASS"}  ${failures ? `${failures} failed` : "all checks"}`);
process.exitCode = failures ? 1 : 0;
