// What the board digest costs now that it is an append-only tail, and whether it fits one screen.
//
//   node tools/verify-digest-cost.mjs              (through npm: npm run verify:digest-cost)
//   node tools/verify-digest-cost.mjs --json <f>   keep the ledger
//   node tools/verify-digest-cost.mjs --headed     a window instead of headless Chromium
//
// WHAT IT MEASURES. The digest used to be a block rewritten in full on every turn it was due: every live run and the
// five most recent, each with its prompt, its tree and its last tool calls - about 8 KB on the busiest board this
// panel carries. It is a tail now: one message a turn, one row per item, and a row carries its text only when its
// state token moved. This tool builds that board and measures three messages on it:
//
//   first     every row is new, so every row carries its text. The worst case a turn ever sends.
//   quiet     the same board one turn later: rows and no text. What a sweep that finds nothing changed costs.
//   changed   one row's state moved: one row's text, and the other rows still silent.
//
// AND WHETHER IT FITS. The message is rendered in the assistant float's own box - `#assistant.is-floating` at the
// page's default geometry (42% of a 1440 px window by 80% of a 900 px window), with the panel's real stylesheet and
// the console's own type - and the block's natural height is compared with the height the float's chat pane has for
// it. A digest that needs a scroll to read is not one screen, whatever its character count says.
//
// Exit codes: 0 the tail is smaller than the block it replaced and fits the float; 1 a check failed; 2 the browser
// half could not run (Playwright is not installed), which is neither a pass nor a failure and says so.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIGEST_SCREEN, LIVE_RUNS_LINE, buildDigestMessage, displayLines } from "../lib/assistant/digest-tail.js";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const JSON_OUT = opt("--json");
const HEADED = argv.includes("--headed");

const checks = [];
const ok = (name, cond, extra = "") => {
  checks.push(Boolean(cond));
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` - ${extra}` : ""}`);
  return Boolean(cond);
};
const fmt = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const bytes = (s) => Buffer.byteLength(String(s ?? ""), "utf8");
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

// The busiest realistic board: ten live runs and the five most recent, each asked something long enough that the old
// block's per-row prompt and tree were the 8 KB the change exists to stop repeating.
const longPrompt = "work " + "x".repeat(450);
const job = (over) => ({
  id: "j",
  thread: "t",
  title: "worker",
  status: "running",
  startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  prompt: longPrompt,
  worktreePath: ".worktrees/a-tree",
  finalMessage: "",
  lines: [],
  ...over,
});
const jobs = [];
for (let i = 1; i <= 10; i += 1) {
  jobs.push(
    job({
      id: `live${i}abc`.slice(0, 8),
      thread: `live-thread-${i}`,
      title: `live worker ${i}`,
      startedAt: new Date(Date.now() - i * 60_000).toISOString(),
      worktreePath: `.worktrees/live-${i}`,
    }),
  );
}
for (let i = 1; i <= 5; i += 1) {
  jobs.push(
    job({
      id: `rec${i}abcd`.slice(0, 8),
      thread: `recent-thread-${i}`,
      title: `recent worker ${i}`,
      status: "done",
      startedAt: new Date(Date.now() - (10 + i) * 60_000).toISOString(),
      endedAt: new Date(Date.now() - (9 + i) * 60_000).toISOString(),
      worktreePath: `.worktrees/recent-${i}`,
    }),
  );
}

// The SAME shape `Assistant.digestItems` hands the builder: a stable id, the state projection, the pointer and the
// one-line text. Nothing here reads a job store, so this measures the module's own contract.
const itemOf = (j) => ({
  id: j.id,
  state: { status: j.status, endedAt: j.endedAt || null, tree: j.worktreePath || null, completion: null },
  pointer: { assistant: "assistant-1", thread: "panel-assistant", turn: `t${j.id}`.slice(0, 8) },
  text: `${j.title} \u00b7 ${j.status} \u00b7 ${j.worktreePath.split("/").slice(-2).join("/")} \u00b7 asked: ${j.prompt.slice(0, 40)}`,
});

const at0 = new Date().toISOString();
const first = buildDigestMessage({ items: jobs.map(itemOf), at: at0, head: [LIVE_RUNS_LINE] });
const quiet = buildDigestMessage({ items: jobs.map(itemOf), at: new Date(Date.parse(at0) + 60_000).toISOString(), previous: first, head: [LIVE_RUNS_LINE] });
const changedJobs = jobs.map((j) => (j.id === jobs[0].id ? { ...j, status: "done", endedAt: new Date().toISOString() } : j));
const changed = buildDigestMessage({
  items: changedJobs.map(itemOf),
  at: new Date(Date.parse(at0) + 120_000).toISOString(),
  previous: quiet,
  head: [LIVE_RUNS_LINE],
});

console.log("board digest tail, on the busiest board this panel carries (10 live, 5 recent):");
console.log("");
for (const [label, msg] of [
  ["first turn (every row new)      ", first],
  ["next turn (nothing changed)     ", quiet],
  ["next turn (one row changed)     ", changed],
]) {
  const n = msg.items.filter((i) => i.changed).length;
  console.log(
    `  ${label} ${fmt(bytes(msg.text)).padStart(6)} B | ${fmt(msg.text.length).padStart(5)} chars | ${String(msg.lines).padStart(2)} display lines at ${DIGEST_SCREEN.cols} cols | ${n} changed, ${msg.items.length - n} same`,
  );
}
console.log("");
console.log(`  the block it replaces was about ${kb(8000)} on this board; the first tail message is ${kb(bytes(first.text))}`);
console.log("");

// ---- the checks the tail has to earn -------------------------------------------------------------------------
ok("the first message carries every row's text (the worst case)", first.items.length === 15 && first.items.every((i) => i.text.length > 0));
ok("an unchanged turn sends rows and no text", bytes(quiet.text) < bytes(first.text) && quiet.items.every((i) => !i.text), `${kb(bytes(quiet.text))} vs ${kb(bytes(first.text))}`);
ok("a changed turn sends one row's text and no more", changed.items.filter((i) => i.text).length === 1 && bytes(changed.text) > bytes(quiet.text), `${kb(bytes(changed.text))} vs ${kb(bytes(quiet.text))}`);
ok(
  "the first message is one screen by the module's own measure",
  displayLines(first.text, DIGEST_SCREEN.cols) <= DIGEST_SCREEN.lines,
  `${displayLines(first.text, DIGEST_SCREEN.cols)} lines, budget ${DIGEST_SCREEN.lines}`,
);
ok("the tail is smaller than the block it replaces", bytes(first.text) < 8000 && bytes(quiet.text) < bytes(first.text) * 0.75, `${kb(bytes(first.text))} and ${kb(bytes(quiet.text))} vs ${kb(8000)}`);

// ---- the browser half: the same message in the float's own box ------------------------------------------------
const playwright = loadPlaywright();
if (!playwright) {
  console.log("");
  console.log(notRun("tools/verify-digest-cost.mjs", "the digest's box is measured in Chromium, and Playwright is not installed on this machine"));
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-digest-"));
const fixture = path.join(dir, "digest-box.html");
const css = pathToFileURL(path.join(ROOT, "public", "style.css")).href;
// The float's real shell, at the geometry `placeFloat()` writes for a 1440 x 900 window: 605 x 720.
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}">
<style>html,body{margin:0;background:#0d1117}pre.digest{max-height:none;resize:none;height:auto}</style>
</head><body>
<aside id="assistant" class="assistant is-floating" style="left:8px;top:8px;width:605px;height:720px">
  <div class="as-bar"><span class="as-glyph">\u2727</span><strong>Assistant</strong><span class="as-mode mono">draft-only</span><span class="spacer"></span></div>
  <div class="as-tabs"><button type="button" class="is-on">Assistant #1</button><button type="button">Role</button><button type="button">Watchdog</button><button type="button">Bridge</button></div>
  <div class="as-subtabs"><button type="button" class="is-on">Chat</button><button type="button">Settings</button><button type="button">Queue</button><button type="button">Worktrees</button><button type="button">Alerts</button><button type="button">Watches</button><button type="button">Messages</button><button type="button">Notes</button></div>
  <div class="as-body"><section class="as-pane" data-pane="assistant-1"><section class="as-subpane" data-subpane="chat" id="as-chat"><pre class="job-out digest" id="digest"></pre></section></section></div>
</aside></body></html>`;
writeFileSync(fixture, html, "utf8");

// One measurement: the message in the float's own box, with the console's type.
const measureBox = (launchOptions = {}) =>
  withBrowser(
    async ({ page }) => {
      await page.goto(pathToFileURL(fixture).href);
      await page.evaluate((text) => {
        document.getElementById("digest").textContent = text;
      }, first.text);
      return page.evaluate(() => {
        const pre = document.getElementById("digest");
        const pane = document.getElementById("as-chat");
        const cs = getComputedStyle(pane);
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const font = getComputedStyle(pre);
        // The character's own advance, measured rather than assumed: a hundred zeros laid out in the console's font.
        const probe = document.createElement("span");
        probe.style.font = font.font;
        probe.style.position = "absolute";
        probe.style.whiteSpace = "pre";
        probe.textContent = "0".repeat(100);
        document.body.appendChild(probe);
        const charPx = probe.getBoundingClientRect().width / 100;
        probe.remove();
        return {
          blockHeight: Math.round(pre.getBoundingClientRect().height),
          blockWidth: pre.clientWidth,
          paneHeight: pane.clientHeight,
          available: Math.round(pane.clientHeight - pad),
          font: `${font.fontSize} ${font.fontFamily.split(",")[0]}`,
          lineHeight: parseFloat(font.lineHeight),
          charPx,
        };
      });
    },
    { headless: !HEADED, viewport: { width: 1440, height: 900 }, launchOptions },
  );

let box = null;
let browserError = null;
try {
  // The bundled headless shell is not always installed; a Chromium channel on the machine is just as good for a
  // layout measurement, and the second attempt is what lets this run where `playwright install` was never run.
  box = await measureBox({});
} catch (err) {
  try {
    box = await measureBox({ channel: "chrome" });
  } catch (err2) {
    browserError = String((err2 && err2.message) || err2 || err);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!box) {
  console.log("");
  console.log(notRun("tools/verify-digest-cost.mjs", `no Chromium could be launched (${browserError || "unknown"})`));
  process.exit(2);
}

const colsMeasured = Math.floor(box.blockWidth / box.charPx);
console.log("");
console.log("the same message in the assistant float's default box (605 x 720, the panel's own stylesheet):");
console.log(`  the text box is ${box.blockWidth} px wide, ${box.font}, line height ${box.lineHeight.toFixed(1)} px`);
console.log(`  the chat pane leaves ${box.available} px for it; the block is ${Math.round(box.blockHeight)} px tall`);
console.log(`  ${box.blockHeight <= box.available ? "fits one screen" : "needs a scroll"} (${Math.round(box.blockHeight)} of ${box.available} px), at about ${colsMeasured} columns of ${box.charPx.toFixed(2)} px characters`);
console.log("");

ok("the digest fits the float's default box, measured in Chromium", box.blockHeight <= box.available, `${Math.round(box.blockHeight)} px of ${box.available}`);
ok("the float's text box holds at least the columns the module budgets for", colsMeasured >= DIGEST_SCREEN.cols, `${colsMeasured} cols measured, ${DIGEST_SCREEN.cols} budgeted`);

const ledger = {
  at: new Date().toISOString(),
  screen: { ...DIGEST_SCREEN, measured: box, colsMeasured },
  messages: {
    first: { bytes: bytes(first.text), chars: first.text.length, lines: first.lines },
    quiet: { bytes: bytes(quiet.text), chars: quiet.text.length, lines: quiet.lines },
    changed: { bytes: bytes(changed.text), chars: changed.text.length, lines: changed.lines },
  },
  checks,
};
if (JSON_OUT) {
  mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
  writeFileSync(JSON_OUT, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  console.log(`ledger: ${JSON_OUT}`);
}
const failed = checks.filter((c) => !c).length;
console.log("");
console.log(`RESULT: ${failed ? `FAIL (${failed} of ${checks.length} checks)` : `PASS (${checks.length} checks)`}`);
process.exit(failed ? 1 : 0);
