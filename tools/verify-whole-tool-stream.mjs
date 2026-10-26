// The whole tool result: the gateway streams it, the card keeps a head of it, and the click reads the rest.
//
//   node tools/verify-whole-tool-stream.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-whole-tool-stream.mjs
//
// WHY THIS EXISTS
//
// A tool result reaches the panel twice, and each path has its own cap. Raising the gateway's (so the run stream
// carries the whole result instead of a 500-character preview) gets text the panel then folds, so the fold is the
// part the reader feels:
//
//   * the gateway's preview cap — gateway/platforms/api_server_runs.py (_DEFAULT_TOOL_COMPLETED_PREVIEW_MAX_CHARS
//     = 500, HERMES_RUN_PREVIEW_CHARS = 0 for "the whole thing"). Measured live with
//     tools/measure-tool-output-cap.mjs; with the cap lifted the panel must stop saying the stream was cut.
//   * the panel's own fold — lib/jobs/console-lines.js (MAX_TOOL_LINES = 40, MAX_TOOL_LINE_CHARS = 400), which
//     keeps a result's head in the console's 600-line ring buffer (lib/jobs.js MAX_LINES) and puts the rest one
//     click away in the session store (lib/tool-results.js) rather than pushing it through the buffer.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven     the two caps by their own code: linesForEvent() from the shipped lib/jobs/console-lines.js is handed
//              a whole 260-line result (no note), a 260-line result with a 900-character line (the panel's note, and
//              it says the line was shortened), a result the gateway cut (the gateway's own sentence, and the two
//              notes are told apart), and a short result (no note at all — nothing was cut)
//   driven     the store reader the click reads through: lib/tool-results.js against a seeded state.db — `index`
//              picks the i-th result of the turn, `maxChars: 0` returns the row exactly as stored, and the default
//              still cuts with its own marker
//   driven     the fold in a real browser, on a panel of its own on a spare port (never 7331, apiServer pinned at a
//              dead port so nothing here can buy a worker): a card whose lines are the SHIPPED server's own output
//              for a 260-line result, painted by the shipped renderJobs(). The note is a button, no request is made
//              before the click, the click asks for exactly that row uncapped, the whole text is drawn in place,
//              the job's own lines are untouched (the ring buffer is not what held it), and a repaint does not fold
//              it back shut
//   inspected  that the sentence the server pushes is the sentence the browser recognises: the note text is built
//              once in each world (lib/jobs/console-lines.js, public/core/console-format.js) and this harness hands
//              the server's own string to the browser's matcher, because a note the browser does not recognise is a
//              fold with no way to read the rest of it
//
// The browser half needs a Playwright install; without one this prints BROWSER-HALF-NOT-RUN, counts a failure and
// exits non-zero rather than passing on a half that never ran.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { linesForEvent, foldNoteText, FOLD_NOTE_RE } from "../lib/jobs/console-lines.js";
import { unwrapToolText } from "../lib/tool-text.js";
import { toolResults } from "../lib/tool-results.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);
// Optional photographic evidence: `--shots <dir>` writes 1-folded.png and 2-opened.png of the real card.
const SHOT_DIR = process.argv[process.argv.indexOf("--shots") + 1] && process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : "";

let failures = 0;
let checks = 0;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 30_000, stepMs = 300, what = "condition" } = {}) {
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

// ---- the fixtures -----------------------------------------------------------------------------------
const GATEWAY_CUT = "… result truncated by the gateway — the live stream carries a preview of a tool result, not all of it";
const RF = String.fromCharCode(10);

// A result the gateway streamed WHOLE (the state this card exists to reach): 260 lines, no line longer than the
// panel's own per-line cap, so the ONLY thing that cuts it is the panel's fold.
const LONG_LINES = 260;
const longBody = Array.from({ length: LONG_LINES }, (_, i) => `line ${i + 1} of a long tool result`).join(RF);
const longResult = JSON.stringify({ output: longBody, exit_code: 0 });

// The same shape with one very long line: the panel's 400-character line cap cuts it, and the note has to say so.
const wideBody =
  Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(RF) + RF + `wide: ${"x".repeat(900)}`;
const wideResult = JSON.stringify({ output: wideBody, exit_code: 0 });

// What the gateway sends when its own cap is in force: a payload cut mid-string, "..." appended.
const cutBody = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of a result the gateway cut`).join("\\n");
const cutResult = `{"output": "${cutBody}","exit_code":0,"pad":"aaa`;

// A result that fits the head: nothing was cut, so there is nothing to say.
const shortResult = JSON.stringify({ output: "on main\nnothing to commit", exit_code: 0 });

const complete = (tool, preview) => linesForEvent({ event: "tool.completed", tool, preview, duration: 1.5 });
const textOf = (lines) => lines.map((l) => l.text);

console.log("── the two cuts, by their own code " + "─".repeat(40));
{
  // 1. The whole result: the head, and one honest fold note. No gateway sentence (nothing was cut by it).
  const lines = complete("terminal", longResult);
  const head = textOf(lines).filter((t) => !FOLD_NOTE_RE.test(t) && !/↳/.test(t));
  check("whole result: the head is MAX_TOOL_LINES (40) lines", head.length, 40);
  check("whole result: the head is the result's first line", head[0], "line 1 of a long tool result");
  check("whole result: the fold note counts what the panel dropped", textOf(lines).at(-1), foldNoteText({ hidden: LONG_LINES - 40 }));
  ok("whole result: the fold note is one the browser can recognise", FOLD_NOTE_RE.test(textOf(lines).at(-1)));
  ok("whole result: no gateway sentence — the stream was not cut", !textOf(lines).some((t) => t === GATEWAY_CUT));
  check("whole result: the note is the last line, so it ends the run the renderer sees", lines.at(-1).kind, "tool-out");

  // 2. The panel's per-line cap: reported, not silent.
  const wide = textOf(complete("terminal", wideResult)).at(-1);
  check("a 900-character line: the note says it was shortened", wide, foldNoteText({ hidden: 0, shortened: 1 }));
  ok("a shortened line is still a note the browser recognises", FOLD_NOTE_RE.test(wide));

  // 3. The gateway's cap: its own sentence, and the panel's note is distinguishable from it.
  const cut = textOf(complete("terminal", cutResult));
  ok("a cut payload keeps the gateway's own sentence", cut.includes(GATEWAY_CUT));
  ok("the gateway's sentence is not the panel's note", !FOLD_NOTE_RE.test(GATEWAY_CUT));
  ok("the panel's note never claims the gateway cut it", FOLD_NOTE_RE.test(foldNoteText({ hidden: 3 })) && !/gateway/.test(foldNoteText({ hidden: 3 })));
  // Both caps can bite the same result, and then both notes are on the card, each naming its own cap.
  const both = textOf(complete("terminal", cutResult));
  ok("a result cut by both caps says so twice, once per cap", both.length > 42 && both.includes(GATEWAY_CUT) && both.some((t) => FOLD_NOTE_RE.test(t)));

  // 4. Nothing cut, nothing said.
  const short = textOf(complete("terminal", shortResult));
  ok("a result inside the head gets no note at all", !short.some((t) => FOLD_NOTE_RE.test(t) || t === GATEWAY_CUT), `lines: ${short.length}`);
  check("a short result is drawn whole", short.length, 3);

  // 5. The head the panel keeps cannot evict the card: 40 lines + a note, whatever the result's size.
  const huge = complete("read_file", JSON.stringify({ content: Array.from({ length: 5000 }, (_, i) => `${i + 1}|a line`).join(RF) }));
  ok("a 5,000-line result is still 40 lines of card", huge.length <= 42, `${huge.length} lines for 5,000`);
}

// ---- the store reader the click reads through --------------------------------------------------------
console.log("");
console.log("── the row the click reads " + "─".repeat(48));
{
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-whole-stream-"));
  const dbPath = path.join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec("create table messages (id integer primary key, session_id text, role text, tool_name text, tool_call_id text, content text, timestamp real)");
  const ins = db.prepare("insert into messages (session_id, role, tool_name, tool_call_id, content, timestamp) values (?, 'tool', ?, ?, ?, ?)");
  ins.run("s1", "terminal", "call-a", JSON.stringify({ output: "first result", exit_code: 0 }), 1000);
  ins.run("s1", "terminal", "call-b", JSON.stringify({ output: longBody, exit_code: 0 }), 1001);
  ins.run("s1", "terminal", "call-c", JSON.stringify({ output: "third result", exit_code: 0 }), 1002);
  db.close();

  const win = { dbPath, sessionId: "s1", tool: "terminal", from: 999000, to: 1002000 };
  const rows = toolResults(win);
  check("three rows, in the order the calls ran", [rows.length, rows[0].text, rows[2].text], [3, "first result", "third result"]);
  check("row 1 is the long result, whole", toolResults({ ...win, index: 1, maxChars: 0 })[0].text, longBody);
  check("row 0 is the row the pairing counts to first", toolResults({ ...win, index: 0, maxChars: 0 })[0].text, "first result");
  check("the last row is still addressable", toolResults({ ...win, index: 2, maxChars: 0 })[0].text, "third result");
  check("a row past the end is empty, not a throw", toolResults({ ...win, index: 9, maxChars: 0 }), []);
  // The store reader's own default cap is still there for the array fetch the burst pairing makes.
  const capped = toolResults({ ...win, index: 1 })[0];
  check("the default read still caps at 6,000 characters", capped.text.length < longBody.length, true);
  ok("…and says how much it dropped", /characters not shown/.test(capped.text), capped.text.slice(-40));
  check("maxChars 0 is uncapped", toolResults({ ...win, index: 1, maxChars: 0 })[0].text.length, longBody.length);
  check("an uncapped row is not called cut", toolResults({ ...win, index: 1, maxChars: 0 })[0].truncated, false);
  rmSync(dir, { recursive: true, force: true });
}

// ---- the fold in a real browser ----------------------------------------------------------------------
const THREAD = "wtgui-probe-whole-stream-9c31ff";
let dir = null;
let panel = null;
let base = "";
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-whole-stream-"));
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  for (const d of [scanRoot, home, configDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        defaultCwd: scanRoot,
        jobsFile: path.join(configDir, "logs", "jobs.json"),
        assistantFile: path.join(configDir, "logs", "assistant.json"),
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        treeNamesFile: path.join(configDir, "logs", "tree-names.json"),
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
        refreshSeconds: 3600,
        worktreeSeconds: 3600,
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
  base = `http://127.0.0.1:${port}`;
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
}

async function stopSandbox() {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 10_000, what: "the panel to exit" });
  await sleep(200);
}

function loadPlaywright() {
  for (const root of [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd()].filter(Boolean)) {
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

async function browserPhase(pw) {
  // The card's lines are the shipped server's own output for a 260-line result: one call line, the result header,
  // 40 lines of head and the fold note the panel pushed. Nothing here is hand-written console markup.
  const LIVE_CALL = "💻 terminal · bash -lc 'cat big.txt'";
  const startedLines = linesForEvent({ event: "tool.started", tool: "terminal", preview: "bash -lc 'cat big.txt'" });
  const resultLines = complete("terminal", longResult);
  const serverFoldNote = resultLines.at(-1).text;
  const storedText = unwrapToolText(longResult).text;
  const CUT_CALL = "💻 terminal · bash -lc 'cat huge.txt'";
  const cutLines = complete("terminal", cutResult);
  // What the panel said about the result the gateway cut — computed here, not guessed, because a cut payload's
  // line count is whatever the salvage found.
  const cutFoldNote = FOLD_NOTE_RE.test(cutLines.at(-2).text) ? cutLines.at(-2).text : null;

  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await context.addInitScript(
    ({ snapshot, startedLines, resultLines, serverFoldNote, storedText, liveCall, cutCall, cutLines }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { snapshot, calls: [], store: null, serverFoldNote, storedText };
      window.__probe = probe;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (String((opts && opts.method) || "GET").toUpperCase() !== "POST") {
          if (u.includes("/api/state")) return json({ ...probe.snapshot, jobs: [...state.jobs.values()] });
          if (u.includes("/api/tool-results")) {
            probe.calls.push(u);
            // What the panel's own server answers for the one row the click asked for: the whole stored text.
            return json({ thread: "probe", tool: "terminal", results: [{ text: probe.storeText || storedText, truncated: false }] });
          }
          return realFetch(url, opts);
        }
        return json({ ok: true });
      };
      const FakeStream = function () {
        this.readyState = 1;
      };
      FakeStream.prototype.addEventListener = function () {};
      FakeStream.prototype.removeEventListener = function () {};
      FakeStream.prototype.close = function () {};
      window.EventSource = FakeStream;

      // The turn as the card would hold it: a call, its result, then a second call whose result the GATEWAY cut
      // (so both notes are on one card and the harness can tell them apart in the DOM).
      probe.show = (opts = {}) => {
        const id = opts.id || "probe-turn";
        const lines = [
          { kind: "text", text: "reading the file", lid: "l1" },
          { kind: "tool", text: liveCall, at: Date.now() - 90_000 },
          ...resultLines,
          { kind: "text", text: "and the huge one", lid: "l2" },
          { kind: "tool", text: cutCall, at: Date.now() - 60_000 },
          ...cutLines,
        ];
        state.jobs.clear();
        state.jobLines.clear();
        state.toolStore.clear();
        state.toolGroupOpen.clear();
        state.codeBoxOpen.clear();
        state.callFolded.clear();
        state.foldRows.clear();
        state.outPinned = {};
        state.maximized = id;
        state.jobLines.set(id, lines);
        state.jobs.set(id, {
          id,
          thread: id,
          turn: 1,
          status: "done",
          prompt: "whole tool stream probe",
          displayPrompt: "whole tool stream probe",
          cwd: null,
          worktree: false,
          worktreePath: null,
          projectPath: null,
          ownerPath: null,
          branch: null,
          runId: "run_probe",
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          endedAt: new Date(Date.now() - 30_000).toISOString(),
          model: "probe/model",
          lines: [],
          artifacts: [],
          attachments: [],
          subagents: [],
        });
        probe.serverFoldNote = serverFoldNote;
        probe.storedText = storedText;
        renderJobs();
        const grp = document.querySelector("pre.job-out .tgrp");
        const body = grp && grp.querySelector(".tgrp-body");
        if (body && body.hidden) {
          body.hidden = false;
          rememberToolGroup(grp);
        }
        return Boolean(grp);
      };

      // ---- readings ----
      probe.folds = () =>
        [...document.querySelectorAll("pre.job-out .jl-fold")].map((d) => ({
          text: d.dataset.ltext,
          kind: d.dataset.lkind,
          isButton: Boolean(d.querySelector("[data-tool-fold]")),
          row: d.querySelector("[data-tool-fold]") ? d.querySelector("[data-tool-fold]").dataset.foldRow : null,
          tool: d.querySelector("[data-tool-fold]") ? d.querySelector("[data-tool-fold]").dataset.foldTool : null,
          turn: d.querySelector("[data-tool-fold]") ? d.querySelector("[data-tool-fold]").dataset.foldTurn : null,
          title: d.querySelector("[data-tool-fold]") ? d.querySelector("[data-tool-fold]").title : null,
        }));
      probe.bodyText = () => document.querySelector("pre.job-out").textContent;
      probe.storeRows = () => probe.calls.slice();
      probe.cutRows = () => [...document.querySelectorAll("pre.job-out .df-cut")].map((d) => d.textContent);
      probe.lineCount = (id) => (state.jobLines.get(id) || []).length;
      probe.foldRowsSize = () => state.foldRows.size;
      probe.foldText = (s) => WMApp.core.consoleFormat.foldText(s);
      probe.foldNoteMatcher = (s) => WMApp.core.consoleFormat.foldNote(s);
      probe.click = async (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        await new Promise((r) => setTimeout(r, 600));
        return true;
      };
      probe.repaint = () => renderJobs();
    },
    {
      snapshot: realSnapshot,
      startedLines,
      resultLines,
      serverFoldNote,
      storedText,
      liveCall: LIVE_CALL,
      cutCall: CUT_CALL,
      cutLines,
    },
  );

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__probe && window.WMApp && window.WMApp.core && window.WMApp.core.consoleFormat), null, { timeout: 20_000 });
  // (a) the server's own note is one the browser recognises, and it reads as the reader asked
  const parity = await page.evaluate(() => ({
    note: window.__probe.serverFoldNote,
    recognised: window.__probe.foldNoteMatcher(window.__probe.serverFoldNote),
    rebuilt: window.__probe.foldText({ hidden: 220 }),
  }));
  check("(a) the server's own note text, as the card received it", parity.note, "… 220 lines hidden — click to read");
  ok("(a) the browser recognises the server's own sentence", parity.recognised === true);
  check("(a) and builds the same sentence itself", parity.rebuilt, parity.note);

  const shown = await page.evaluate(() => window.__probe.show());
  ok("(a) the card painted a tool burst", shown === true);
  await page.waitForSelector("pre.job-out .tgrp", { timeout: 20_000 });

  // (b) the fold is a head plus a counted, clickable note — and nothing was fetched to draw it
  const folds = await page.evaluate(() => window.__probe.folds());
  const head = await page.evaluate(() => window.__probe.bodyText());
  // Two results on this card: the one the gateway streamed whole (row 0) and the one it cut, which the panel also
  // folded (row 1). Both notes are the panel's, and each belongs to its own result.
  check("(b) one fold note per folded result", folds.length, 2);
  check("(b) the whole result's note reads as the count the reader needs", folds[0].text, "… 220 lines hidden — click to read");
  check("(b) the cut result's note is its own", folds[1].text, cutFoldNote);
  ok("(b) both are buttons", folds.every((f) => f.isButton === true));
  check("(b) and each belongs to its own tool and row", folds.map((f) => [f.tool, f.row]), [["terminal", "0"], ["terminal", "1"]]);
  ok("(b) it says which cap folded it, in the title", /this panel keeps a result's first 40 lines/.test(folds[0].title || ""), folds[0].title);
  ok("(b) the head is drawn and holds the result's first lines", head.includes("line 1 of a long tool result") && head.includes("line 40 of a long tool result"));
  ok("(b) and does not hold the 41st", !head.includes("line 41 of a long tool result"));
  const beforeClick = await page.evaluate(() => ({
    calls: window.__probe.storeRows(),
    lines: window.__probe.lineCount("probe-turn"),
    tailInLines: (state.jobLines.get("probe-turn") || []).some((l) => String(l.text || "").includes("line 41 of a long tool result")),
  }));
  check("(b) nothing was fetched before the click", beforeClick.calls, []);
  ok("(b) the card's own lines hold no folded tail", beforeClick.tailInLines === false);
  ok("(b) so the ring buffer has room: the card's lines are the two heads", beforeClick.lines < 100, `${beforeClick.lines} console lines for two long results`);
  if (SHOT_DIR) {
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.evaluate(() => document.querySelector("pre.job-out .jl-fold")?.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: path.join(SHOT_DIR, "1-folded.png") });
  }

  // (c) the click reads exactly that row, uncapped, and the whole text appears in its place
  const clicked = await page.evaluate(() => window.__probe.click("pre.job-out [data-tool-fold]"));
  ok("(c) the fold note is a real button a click can press", clicked === true);
  const after = await page.evaluate(() => ({
    calls: window.__probe.storeRows(),
    text: window.__probe.bodyText(),
    folds: window.__probe.folds(),
    lines: window.__probe.lineCount("probe-turn"),
    held: window.__probe.foldRowsSize(),
  }));
  check("(c) exactly one request went out", after.calls.length, 1);
  const q = new URLSearchParams(String(after.calls[0]).split("?")[1] || "");
  check("(c) it asked for the row the note named", q.get("row"), "0");
  check("(c) it asked for the whole row, not the store's display cut", q.get("full"), "1");
  check("(c) it asked for that tool in that turn", [q.get("tool"), q.get("thread")], ["terminal", "probe-turn"]);
  ok("(c) the whole stored text is drawn: its last line is there", after.text.includes("line 260 of a long tool result"));
  ok("(c) the head's lines are still there, folded open in place", after.text.includes("line 1 of a long tool result") && after.text.includes("line 40 of a long tool result"));
  // The OTHER result on the card was cut by the gateway AND folded by the panel: its own note is still a button,
  // and it is the one for row 1 — the two results on one card never share a note.
  check("(c) the opened result's note is gone, the other result's is not", after.folds.length, 1);
  check("(c) and the note left on the card belongs to the second result", [after.folds[0].row, after.folds[0].text], ["1", cutFoldNote]);
  ok("(c) the ring buffer did not take the result", after.lines === beforeClick.lines, `${after.lines} console lines before and after`);
  check("(c) the opened row is held for the next rebuild", after.held, 1);
  if (SHOT_DIR) {
    // The opened end of the result, so the shot shows lines 41+ really are on the card.
    await page.evaluate(() => {
      const out = document.querySelector("pre.job-out");
      if (out) out.scrollTop = out.scrollHeight;
    });
    await page.screenshot({ path: path.join(SHOT_DIR, "2-opened.png") });
  }

  // (d) a repaint does not fold it back shut
  await page.evaluate(() => window.__probe.repaint());
  const afterRepaint = await page.evaluate(() => ({ text: window.__probe.bodyText(), folds: window.__probe.folds() }));
  ok("(d) a repaint keeps the opened result open", afterRepaint.text.includes("line 260 of a long tool result"));
  check("(d) and does not conjure a second note", afterRepaint.folds.length, 1);

  // (e) the gateway's own cut is untouched: its sentence is still there, and it is not turned into a button
  const cut = await page.evaluate(() => ({ text: window.__probe.bodyText(), html: [...document.querySelectorAll("pre.job-out [data-tool-fold]")].map((b) => b.textContent) }));
  ok("(e) the gateway's sentence is still on the card", cut.text.includes("truncated by the gateway"));
  ok("(e) and the button on the card is the panel's fold, not the gateway's sentence", cut.html.every((t) => /lines hidden/.test(t)), cut.html.join(" | "));

  ok("no page errors", pageErrors.length === 0, pageErrors.join(" | ") || "none");

  // (f) a turn whose store has no row: honest, and the note stays a note
  const missing = await page.evaluate(async () => {
    window.__probe.storeText = "";
    state.foldRows.clear();
    window.fetch = ((real) => async (url, opts = {}) => {
      const u = String(url);
      if (String((opts && opts.method) || "GET").toUpperCase() === "GET" && u.includes("/api/tool-results")) {
        window.__probe.calls.push(u);
        return new Response(JSON.stringify({ thread: "probe", tool: "terminal", results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return real(url, opts);
    })(window.fetch);
    renderJobs();
    const btn = document.querySelector("pre.job-out [data-tool-fold]");
    if (!btn) return { found: false };
    btn.click();
    await new Promise((r) => setTimeout(r, 600));
    return { found: true, text: document.querySelector("pre.job-out").textContent };
  });
  ok("(f) with no stored row the click says so instead of inventing output", missing.found && /the session store has no copy of this result/.test(missing.text));

  await browser.close();
}

console.log("");
console.log("── the fold, in a browser " + "─".repeat(47));
const pw = loadPlaywright();
if (!pw) {
  checks += 1;
  failures += 1;
  console.log("BROWSER-HALF-NOT-RUN  no Playwright install found (set PANEL_PLAYWRIGHT_ROOT=<repo with node_modules/playwright>)");
} else {
  try {
    await startSandbox();
    await browserPhase(pw);
  } catch (err) {
    checks += 1;
    failures += 1;
    console.log(`FAIL  the browser half threw: ${err?.message || err}`);
    if (panelLog.length) console.log(panelLog.slice(-12).join("\n"));
  } finally {
    await stopSandbox();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
console.log(failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
