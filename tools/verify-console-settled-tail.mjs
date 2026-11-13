// The tail a settled console was losing.
//
// A turn's prose is typed out by the word pacer (public/core/type-stream.js). The console's live paint asks the
// pacer what may be drawn for a row and, when the pacer has stopped answering for that line (`shownFor` returns
// null: the record in the store has moved past what the wire's last frame carried), the paint SKIPPED the row -
// so the row kept the prefix it was built with, and the rest of the answer was never in the DOM. A long reply
// therefore ended at its own top, the console had nothing to scroll, and the card's `done` sat right under it.
//
// This harness reproduces that state with the shipped renderer, the shipped pacer and the shipped paint, and
// asserts the settled row ends up carrying the whole record on both surfaces a reader reads:
//   * the card console (`pre.job-out`), which is the docked rail's chat and the in-page reader view;
//   * the docked console under a sub-row (`subConsoleHtml`), the child's own box.
//
//   node tools/verify-console-settled-tail.mjs            # exit 0 = green
//   PANEL_ROOT=<git archive of the base> node tools/verify-console-settled-tail.mjs   # the red proof
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPage, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PANEL_ROOT ? path.resolve(process.env.PANEL_ROOT) : path.join(HERE, "..");
const WIDTH = Number(process.env.WIDTH || 1109);
const HEIGHT = Number(process.env.HEIGHT || 733);

// The answer: one console line, as lib/jobs.js stores an assistant message (its newlines inside the string), long
// enough that a prefix of it is plainly not the answer.
const RECORD = ["**TL;DR**", "- **Ready to land, nothing missing**: the branch is clean at the base the reader named and the"]
  .concat(Array.from({ length: 14 }, (_, i) => `  paragraph ${i + 1}: the run read every row, opened the three candidates the reader named, and measured each one.`))
  .concat(["**The last line of the answer is this one, and a reader must be able to read it.**"])
  .join("\n");
// The wire's last frame for that line: its first two lines, and no more.
const FRAME = RECORD.split("\n").slice(0, 2).join("\n");

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>settled tail</title>
<link rel="stylesheet" href="/public/style.css">
</head>
<body style="margin:0;padding:18px;background:#0d1117">
<div class="job" id="card" style="max-width:620px">
  <div class="job-head mono">Assistant #1</div>
  <div class="job-body" id="body"><div class="turn"><div class="out-wrap" id="wrap"></div></div></div>
  <div class="job-foot mono">done · 36s · tokens 703k</div>
</div>
<div class="subagents mono" id="subs" style="max-width:620px;margin-top:18px">
  <span class="sub-head" role="button" tabindex="0"><span class="sub-chev">\u25be</span> \u29c9 1 subagent \u00b7 all done</span>
  <div class="sub-row is-open" role="button" tabindex="0" data-sub-console="child-1">
    <span class="sub-caret sub-chev">\u25be</span><span class="sub-dot"></span>
    <span class="sub-title">the child's own console</span>
    <span class="sub-meta mono">done \u00b7 1m 14s</span>
  </div>
</div>
<script src="/public/core/dom-format.js"></script>
<script src="/public/core/console-format.js"></script>
<script src="/public/core/console-markdown.js"></script>
<script src="/public/core/type-stream.js"></script>
<script src="/public/board/console.js"></script>
<script>
  const RECORD = ${JSON.stringify(RECORD)};
  const FRAME = ${JSON.stringify(FRAME)};
  window.__out = {};
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

  // The pacer on a clock this harness drives, so nothing depends on a real timer.
  let t = 0;
  const P = globalThis.wtType.createDrawStream({ rate: 40, now: () => t, schedule: () => 1, cancel: () => {} , onPaint: (lids) => paintTypedLines(lids) });
  window.state.typeStream = P;
  window.WMApp.core.consoleFormat.setShownFor(typedShown);

  const LINE = { kind: "text", text: RECORD, lid: 12 };
  const JOB = "job-settled";

  // The wire's last frame for the line arrives; the pacer holds it and types it out.
  P.feed("12", JOB, FRAME);
  t += 60; P.tick(t);          // a few words of the frame are on screen
  window.__out.frameShown = P.paintLog ? null : null;

  // The console is drawn now, exactly as a live card draws it: up to the pacer's prefix.
  window.__out.prefixAtBuild = P.shownFor("12", RECORD) || P.shownFor("12");
  document.getElementById("wrap").innerHTML = '<pre class="job-out" data-out="' + JOB + '">' +
    globalThis.WMApp.core.consoleFormat.bodyHtml([LINE], {}) + "</pre>";
  window.__out.live = (() => {
    const out = document.querySelector("pre.job-out");
    const row = out.querySelector('[data-lid="12"]');
    return { drawn: row ? row.textContent.length : 0, record: RECORD.length, text: row ? row.textContent : null };
  })();
  // The cut the reader reads: one line of a long answer, the box ended, a "done" foot underneath, nothing to scroll.
  window.__out.before = (() => {
    const out = document.querySelector("pre.job-out");
    const row = out.querySelector('[data-lid="12"]');
    return { drawn: row ? row.textContent.length : 0, record: RECORD.length, rowText: row ? row.textContent : null,
      consoleClientH: out.clientHeight, consoleScrollH: out.scrollHeight, maxH: getComputedStyle(out).maxHeight, overflowY: getComputedStyle(out).overflowY };
  })();

  // The pacer finishes the frame it was given - and then has nothing left to type, while the store's record has
  // the whole answer.
  t += 4000; P.tick(t);

  // The turn is over: the panel's own settle path runs.
  flushTypeStream(JOB);
  window.__out.after = (() => {
    const out = document.querySelector("pre.job-out");
    const row = out.querySelector('[data-lid="12"]');
    return { drawn: row ? row.textContent.length : 0, record: RECORD.length, tail: row ? row.textContent.slice(-60) : null,
      ltext: row ? row.dataset.ltext.length : 0,
      consoleClientH: out.clientHeight, consoleScrollH: out.scrollHeight,
      lastRowBottom: row ? Math.round(row.getBoundingClientRect().bottom) : null,
      consoleBottom: Math.round(out.getBoundingClientRect().bottom) };
  })();

  // The docked console, the child's own box: the same record, drawn by its own renderer.
  window.state.subConsoles.set("child-1", { lines: [{ kind: "text", text: RECORD, lid: null }], running: false, loading: false });
  window.state.openSubConsole.add("child-1");
  document.getElementById("subs").insertAdjacentHTML("beforeend", subConsoleHtml("child-1"));
  window.__out.docked = (() => {
    const box = document.querySelector("[data-sub-console-box='child-1']");
    if (!box) return null;
    const cs = getComputedStyle(box);
    return { drawn: box.innerText.length, record: RECORD.length, tail: box.innerText.slice(-60).replace(/\\s+/g, " "),
      clientH: box.clientHeight, scrollH: box.scrollHeight, maxH: cs.maxHeight, overflowY: cs.overflowY,
      scrollable: box.scrollHeight - box.clientHeight };
  })();
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

console.log(`\n== fixture over ${ROOT}`);
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
    if (out.errors) console.log("PAGE ERRORS:" + out.errors.join(" | "));
    ok("the live console drew only the pacer's prefix", out.live.drawn > 0 && out.live.drawn < out.live.record,
      `${out.live.drawn} of ${out.live.record} chars: ${JSON.stringify(out.live.text)}`);
    const PLAIN = RECORD.replace(/\*\*/g, "").length;
    ok("a finished frame leaves the row where it stopped", out.before.drawn < out.before.record,
      `${out.before.drawn} of ${out.before.record} chars drawn before the settle, console ${out.before.consoleScrollH} px of content in a ${out.before.consoleClientH} px box (max-height ${out.before.maxH}, overflow ${out.before.overflowY})`);
    ok("the settled console draws the whole record", out.after.drawn >= PLAIN - 6,
      `${out.after.drawn} chars drawn of ${PLAIN} characters of text (${out.after.record} with its markdown markers)`);
    ok("the answer's last line reaches the reader", /a reader must be able to read it/i.test(out.after.tail || ""), JSON.stringify(out.after.tail));
    ok("the row still carries the whole line as its record", out.after.ltext === out.after.record, `${out.after.ltext} chars`);
    ok("the console grew to hold it", out.after.consoleScrollH > out.before.consoleScrollH,
      `${out.before.consoleScrollH} -> ${out.after.consoleScrollH} px of content, box ${out.before.consoleClientH} -> ${out.after.consoleClientH} px, max-height ${out.before.maxH}, overflow ${out.before.overflowY}`);
    const d = out.docked;
    ok("the docked console draws the child's whole message", Boolean(d) && d.drawn >= d.record - 40 && /a reader must be able to read it/i.test(d.tail || ""),
      d ? `${d.drawn} of ${d.record} chars, client ${d.clientH} / scroll ${d.scrollH} px, max-height ${d.maxH}, overflow ${d.overflowY}, ${d.scrollable} px scrollable` : "no docked console");
  }
} finally {
  server.close();
}
console.log(`\n${failures ? "FAIL" : "PASS"}  ${failures ? `${failures} failed` : "all checks"}`);
process.exitCode = failures ? 1 : 0;
