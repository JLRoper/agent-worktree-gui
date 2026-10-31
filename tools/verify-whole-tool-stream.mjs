// The whole tool result: opening its original box fetches the full row in place, exactly once.
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
//              a whole 260-line result (no gateway cut), a result with a 900-character line (the panel's note, and
//              it says the line was shortened), a result the gateway cut (the gateway's own sentence, and the two
//              notes are told apart), and a short result (no note at all — nothing was cut)
//   driven     the store reader the click reads through: lib/tool-results.js against a seeded state.db — `index`
//              picks the i-th result of the turn, `maxChars: 0` returns the row exactly as stored, and the default
//              still cuts with its own marker
//   driven     the fold in a real browser, on a panel of its own on a spare port (never 7331, apiServer pinned at a
//              dead port so nothing here can buy a worker): a card whose lines are the SHIPPED server's own output
//              for a 260-line result, painted by the shipped renderJobs(). Its folded .code-head is the sole
//              fetch/fold control: one full=1&n=1 SQLite-backed read fills the SAME box, updates its count and
//              preserves normal open/shut state through renderJobs and DOM-backed burst rebuilds. No separate
//              footer, duplicate preview, repeated full fetch or mutation of jobLines is allowed. Missing rows,
//              HTTP refusals/retry, gateway truncation notes and parked console scroll are also driven.
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
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { linesForEvent, foldNoteText, FOLD_NOTE_RE } from "../lib/jobs/console-lines.js";
import { unwrapToolText } from "../lib/tool-text.js";
import { toolResults } from "../lib/tool-results.js";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
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
const TURN = "probe-turn";
const BROWSER_STARTED_AT = new Date(Date.now() - 120_000).toISOString();
const BROWSER_ENDED_AT = new Date(Date.now() - 30_000).toISOString();
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
  // The successful browser click reads this real store through the sandbox's actual HTTP route.
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec("create table messages (id integer primary key, session_id text, role text, tool_name text, tool_call_id text, content text, timestamp real)");
  const ins = db.prepare("insert into messages (session_id, role, tool_name, tool_call_id, content, timestamp) values (?, 'tool', 'terminal', ?, ?, ?)");
  ins.run(THREAD, "call-whole", longResult, Date.parse(BROWSER_STARTED_AT) / 1000 + 1);
  ins.run(THREAD, "call-gateway-cut", cutResult, Date.parse(BROWSER_STARTED_AT) / 1000 + 2);
  db.close();
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
        apiServer: { url: "http://127.0.0.1:9", key: "" },
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
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "", API_SERVER_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
  const q = new URLSearchParams({ thread: THREAD, tool: "terminal", row: "0", full: "1", n: "1", from: String(Date.parse(BROWSER_STARTED_AT)), to: String(Date.parse(BROWSER_ENDED_AT)) });
  const response = await fetch(`${base}/api/tool-results?${q}`);
  const rows = (await response.json()).results || [];
  ok("browser fixture: the real SQLite route serves the exact full row", response.ok && rows.length === 1 && rows[0].text === longBody, `${response.status}, ${rows[0]?.text.length || 0} chars`);
}

async function stopSandbox() {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 10_000, what: "the panel to exit" });
  await sleep(200);
}

async function browserPhase(pw) {
  const LIVE_CALL = "💻 terminal · bash -lc 'cat big.txt'";
  const CUT_CALL = "💻 terminal · bash -lc 'cat huge.txt'";
  const resultLines = complete("terminal", longResult);
  const cutLines = complete("terminal", cutResult);
  const serverFoldNote = resultLines.at(-1).text;
  const storedText = unwrapToolText(longResult).text;
  const browser = await pw.chromium.launch({ headless: true });
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
    await installFakeEventSource(context);
    await context.addInitScript(
      ({ snapshot, resultLines, cutLines, serverFoldNote, storedText, liveCall, cutCall, thread, id, startedAt, endedAt }) => {
        const realFetch = window.fetch.bind(window);
        const probe = { snapshot, calls: [], replyMode: "real", fullAttempts: 0, serverFoldNote, storedText };
        window.__probe = probe;
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        window.fetch = async (url, opts = {}) => {
          const u = String(url);
          const method = String(opts.method || "GET").toUpperCase();
          if (method !== "GET" && method !== "HEAD") return json({ error: "writes disabled in this browser fixture" }, 405);
          if (u.includes("/api/state")) return json({ ...probe.snapshot, jobs: [...state.jobs.values()] });
          if (u.includes("/api/tool-results")) {
            probe.calls.push(u);
            if (new URL(u, location.href).searchParams.get("full") === "1") {
              probe.fullAttempts += 1;
              // Only the explicit refusal/empty-store cases are stubbed. All successful reads use real SQLite.
              if (probe.replyMode === "empty") return json({ thread, tool: "terminal", results: [] });
              if (probe.replyMode === "refuse-once" && probe.fullAttempts === 1) return json({ error: "fixture store refusal" }, 503);
            }
          }
          return realFetch(url, opts);
        };
        localStorage.setItem("wtgui.autoCollect", "0");
        const pre = () => document.querySelector(`pre.job-out[data-out="${id}"]`);
        probe.show = (opts = {}) => {
          const padding = (side) => opts.padded ? Array.from({ length: 55 }, (_, i) => ({ kind: "text", text: `${side} reading-position line ${i + 1}: keep this place while the result loads`, lid: `${side}-${i}` })) : [];
          const lines = [
            ...padding("before"),
            { kind: "text", text: "reading the file", lid: "l1" },
            { kind: "tool", text: liveCall, at: Date.parse(startedAt) + 1000, lid: "call-0" },
            ...resultLines,
            { kind: "text", text: "and the huge one", lid: "l2" },
            { kind: "tool", text: cutCall, at: Date.parse(startedAt) + 2000, lid: "call-1" },
            ...cutLines,
            ...padding("after"),
          ];
          state.jobs.clear();
          state.jobLines.clear();
          state.toolStore.clear();
          state.toolGroupOpen.clear();
          state.codeBoxOpen.clear();
          state.codeBoxShut.clear();
          state.callFolded.clear();
          state.foldRows.clear();
          state.foldPending?.clear();
          state.toolStorePending.clear();
          state.outPinned = {};
          state.maximized = id;
          state.jobLines.set(id, lines);
          state.jobs.set(id, {
            id, thread, turn: 1, status: "done", prompt: "single-box whole stream probe", displayPrompt: "single-box whole stream probe",
            cwd: null, worktree: false, worktreePath: null, projectPath: null, ownerPath: null, branch: null,
            runId: "run_probe", startedAt, endedAt, model: "probe/model", lines: [], artifacts: [], attachments: [], subagents: [],
          });
          probe.calls = [];
          probe.fullAttempts = 0;
          probe.replyMode = opts.replyMode || "real";
          probe.originalLines = JSON.stringify(lines);
          renderJobs();
          // The fixture opens the outer bursts, not their output boxes, without triggering a store read.
          for (const g of pre().querySelectorAll(".tgrp")) {
            const body = g.querySelector(".tgrp-body");
            if (body?.hidden) { body.hidden = false; rememberToolGroup(g); }
          }
          return probe.read();
        };
        probe.headers = () => [...pre().querySelectorAll(".code-head[data-fold-turn][data-fold-tool][data-fold-row]")].map((h) => {
          const box = h.closest(".code-box");
          const body = box?.querySelector(".code-body");
          return {
            turn: h.dataset.foldTurn, tool: h.dataset.foldTool, row: h.dataset.foldRow,
            key: h.dataset.codeKey || "", codeFold: h.dataset.codeFold || "", fetch: h.dataset.toolFold === "1", inverted: h.dataset.codeInverted || "",
            open: Boolean(body && !body.hidden && h.getAttribute("aria-expanded") === "true" && box.classList.contains("is-open")),
            hidden: body?.hidden, expanded: h.getAttribute("aria-expanded"), disabled: h.disabled,
            n: h.querySelector(".code-n")?.textContent || "",
            body: [...(body?.querySelectorAll(".jl[data-ltext]") || [])].map((r) => r.dataset.ltext),
          };
        });
        probe.result = (row) => probe.headers().find((h) => h.turn === id && h.tool === "terminal" && h.row === String(row)) || null;
        probe.read = () => {
          const o = pre();
          const source = state.jobLines.get(id) || [];
          return {
            headers: probe.headers(), boxes: o.querySelectorAll(".code-box").length,
            footers: o.querySelectorAll(".fold-read").length,
            externalNotes: [...o.querySelectorAll(".jl-fold")].filter((d) => !d.closest(".code-box") && !d.hidden).length,
            calls: probe.calls.slice(), fullCalls: probe.calls.filter((u) => new URL(u, location.href).searchParams.get("full") === "1"),
            lines: source.length, unchanged: JSON.stringify(source) === probe.originalLines,
            tailInBuffer: source.some((l) => String(l.text || "").includes("line 41 of a long tool result")),
            inputNotes: source.filter((l) => WMApp.core.consoleFormat.foldNote(l.text)).map((l) => l.text),
            held: state.foldRows.size, text: o.textContent,
            output: [...o.querySelectorAll(".jl[data-ltext]")].filter((d) => d.getClientRects().length > 0).map((d) => d.dataset.ltext),
            gateway: [...o.querySelectorAll(".jl[data-ltext]")].filter((d) => d.dataset.ltext.includes("truncated by the gateway")).map((d) => ({ text: d.dataset.ltext, interactive: Boolean(d.closest(".code-head, [data-tool-fold], .fold-read")) })),
          };
        };
        probe.rebuild = () => {
          renderJobs();
          for (const g of [...pre().querySelectorAll(".tgrp")]) rebuildToolGroup(g, { filter: g.dataset.filter || "", open: !g.querySelector(".tgrp-body")?.hidden });
          return probe.read();
        };
        probe.scroll = () => {
          const o = pre();
          const r = o.getBoundingClientRect();
          const h = [...o.querySelectorAll(".code-head")].find((d) => d.dataset.foldRow === "0");
          const row = [...o.querySelectorAll(".jl[data-ltext]")].find((d) => {
            if (!d.getClientRects().length) return false;
            const a = d.getBoundingClientRect();
            return a.bottom > r.top + 2 && a.top < r.bottom;
          });
          return { top: o.scrollTop, max: o.scrollHeight - o.clientHeight, gap: o.scrollHeight - o.clientHeight - o.scrollTop,
            header: h ? h.getBoundingClientRect().top - r.top : null,
            reader: row?.dataset.ltext || "", offset: row ? row.getBoundingClientRect().top - r.top : null,
            pinned: state.outPinned[id] };
        };
        probe.park = (inside = false) => {
          const o = pre();
          const target = inside ? [...o.querySelectorAll(".code-body .jl[data-ltext]")].find((d) => d.dataset.ltext === "line 120 of a long tool result")
            : [...o.querySelectorAll(".code-head")].find((d) => d.dataset.foldRow === "0");
          if (!target) return null;
          target.scrollIntoView({ block: "center" });
          o.scrollTop += target.getBoundingClientRect().top - o.getBoundingClientRect().top - 80;
          state.outPinned[id] = false;
          o._selfTop = o.scrollTop;
          return probe.scroll();
        };
      },
      { snapshot: realSnapshot, resultLines, cutLines, serverFoldNote, storedText, liveCall: LIVE_CALL, cutCall: CUT_CALL,
        thread: THREAD, id: TURN, startedAt: BROWSER_STARTED_AT, endedAt: BROWSER_ENDED_AT },
    );
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err?.message || err)));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__probe && window.WMApp?.core?.consoleFormat), null, { timeout: 20_000 });
    const read = () => page.evaluate(() => window.__probe.read());
    const header = (row = 0) => page.locator(`pre.job-out[data-out="${TURN}"] .code-head[data-fold-turn="${TURN}"][data-fold-tool="terminal"][data-fold-row="${row}"]`);
    const result = (st, row = 0) => st.headers.find((h) => h.row === String(row) && h.tool === "terminal" && h.turn === TURN);
    const noFooter = (label, st) => check(`${label}: no separate hidden-lines footer`, [st.footers, st.externalNotes], [0, 0]);
    const click = async (row = 0) => {
      if (await header(row).count() !== 1) return false;
      await header(row).click();
      return true;
    };
    const loaded = () => waitFor(() => page.evaluate(() => {
      const c = window.__probe.result(0);
      return Boolean(c?.open && !c.fetch && state.foldRows.size === 1 && !state.foldPending?.size);
    }), { timeoutMs: 5000, stepMs: 50, what: "the full row to open in the original output box" });
    const assertWhole = (label, st, key) => {
      const own = result(st);
      check(`${label}: the result still occupies exactly one of two output boxes`, [st.boxes, st.headers.length], [2, 2]);
      check(`${label}: the same header keeps identity and ordinary fold semantics`, own ? [own.turn, own.tool, own.row, own.key, own.codeFold, own.fetch, own.inverted] : null,
        [TURN, "terminal", "0", key, "1", false, ""]);
      ok(`${label}: the full result is actually open and its count updated`, Boolean(own?.open && own.n === `${LONG_LINES} lines`));
      ok(`${label}: every full line appears exactly once, without duplicating the preview`, JSON.stringify(own?.body) === JSON.stringify(longBody.split(RF)) && st.output.filter((s) => /^line \d+ of a long tool result$/.test(s)).length === LONG_LINES, `${own?.body.length || 0}/${LONG_LINES} rows`);
      ok(`${label}: jobLines still contains the original heads and notes, never the tail`, st.unchanged && !st.tailInBuffer && st.inputNotes.length === 2);
      noFooter(label, st);
    };

    const parity = await page.evaluate(() => ({ note: window.__probe.serverFoldNote,
      recognised: WMApp.core.consoleFormat.foldNote(window.__probe.serverFoldNote), rebuilt: WMApp.core.consoleFormat.foldText({ hidden: 220 }) }));
    check("(a) the server's input note is unchanged", parity.note, "… 220 lines hidden — click to read");
    ok("(a) the browser still recognises that metadata", parity.recognised === true);
    check("(a) both worlds build the same sentence", parity.rebuilt, parity.note);

    const before = await page.evaluate(() => window.__probe.show());
    check("(b) two results produce two boxes and two identified headers", [before.boxes, before.headers.length], [2, 2]);
    check("(b) the headers carry their own whole-turn row identities", before.headers.map((h) => [h.turn, h.tool, h.row]), [[TURN, "terminal", "0"], [TURN, "terminal", "1"]]);
    ok("(b) both headers start folded with normal fold keys and fetch on opening", before.headers.length === 2 && before.headers.every((h) => !h.open && h.hidden && h.expanded === "false" && h.fetch && h.codeFold === "1" && h.key && !h.inverted));
    const original = result(before);
    check("(b) the folded header counts the retained lines out of the full result", original?.n, `40 of ${LONG_LINES} lines`);
    ok("(b) the retained head is exactly the first 40 lines, with no line 41", JSON.stringify(original?.body) === JSON.stringify(longBody.split(RF).slice(0, 40)));
    check("(b) no full row was fetched just to draw a folded header", before.fullCalls, []);
    check("(b) the original server notes remain in the input, not in a rendered footer", before.inputNotes.length, 2);
    ok("(b) the ring buffer holds only the two heads, never the full tail", before.lines < 100 && !before.tailInBuffer, `${before.lines} input lines`);
    noFooter("(b)", before);
    if (SHOT_DIR) {
      mkdirSync(SHOT_DIR, { recursive: true });
      await page.locator("pre.job-out .code-head").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOT_DIR, "1-folded.png") });
    }

    const pressed = await click();
    ok("(c) the real click is on the original box header", pressed);
    ok("(c) opening it loads the full row immediately", pressed && await loaded());
    let st = await read();
    check("(c) exactly one request asks for exactly one uncapped row of this turn", st.fullCalls.map((u) => {
      const q = new URL(u, base).searchParams;
      return [q.get("thread"), q.get("tool"), q.get("row"), q.get("full"), q.get("n"), q.get("from"), q.get("to")];
    }), [[THREAD, "terminal", "0", "1", "1", String(Date.parse(BROWSER_STARTED_AT)), String(Date.parse(BROWSER_ENDED_AT))]]);
    assertWhole("(c)", st, original?.key || "missing-original-key");
    ok("(c) the other result remains folded and keeps its own fetch control", Boolean(result(st, 1)?.fetch && !result(st, 1)?.open && result(st, 1)?.row === "1"));
    check("(c) full text is held outside the input ring buffer", [st.held, st.lines], [1, before.lines]);
    if (SHOT_DIR) {
      await page.evaluate(() => { const o = document.querySelector("pre.job-out"); state.outPinned[o.dataset.out] = false; o.scrollTop = o.scrollHeight; o._selfTop = o.scrollTop; });
      await page.screenshot({ path: path.join(SHOT_DIR, "2-opened.png") });
    }

    st = await page.evaluate(() => window.__probe.rebuild());
    assertWhole("(d) renderJobs plus DOM-backed burst rebuild", st, original?.key || "missing-original-key");
    if (await click()) {
      st = await page.evaluate(() => window.__probe.rebuild());
      const closed = result(st);
      ok("(d) a second click closes the same full box through both rebuilds", Boolean(closed && closed.hidden && !closed.open && closed.expanded === "false" && !closed.fetch && !closed.inverted && closed.key === original?.key));
      await click();
      st = await page.evaluate(() => window.__probe.rebuild());
      assertWhole("(d) cached reopen", st, original?.key || "missing-original-key");
    } else ok("(d) the original header remains available to close/reopen", false);
    check("(d) subsequent close/reopen and all rebuilds do not repeat the full fetch", st.fullCalls.length, 1);

    const cuts = st.gateway;
    ok("(e) the gateway's honest truncation sentence is still present", st.text.includes(GATEWAY_CUT) && cuts.some((c) => c.text === GATEWAY_CUT));
    ok("(e) gateway notes are never fetch controls", cuts.length > 0 && cuts.every((c) => !c.interactive));
    noFooter("(e)", st);

    // Empty and refused reads must leave the same header usable, never cache a fabricated full result.
    for (const [mode, label, notice] of [["empty", "(f) missing stored row", "no copy of this result"], ["refuse-once", "(g) refused store read", "could not be read"]]) {
      const first = await page.evaluate((replyMode) => window.__probe.show({ replyMode }), mode);
      const didClick = await click();
      const answered = didClick && await waitFor(() => page.evaluate((n) => window.__probe.read().text.includes(n), notice), { timeoutMs: 5000, stepMs: 50, what: `${label}'s honest notice` });
      st = await read();
      const own = result(st);
      ok(`${label}: the failed click reports the real failure, not invented output`, answered);
      check(`${label}: a failed read leaves the full-row cache empty`, [st.held, st.fullCalls.length], [0, 1]);
      ok(`${label}: the original identified header stays enabled for retry`, Boolean(own && own.fetch && !own.disabled && own.key === result(first)?.key && own.codeFold === "1"));
      ok(`${label}: the original preview is still the only output for that call`, st.boxes === 2 && st.unchanged && JSON.stringify(own?.body) === JSON.stringify(longBody.split(RF).slice(0, 40)));
      noFooter(label, st);
      await page.evaluate(() => { window.__probe.replyMode = "real"; });
      const retried = await click();
      ok(`${label}: a real second header click retries successfully`, retried && await loaded());
      st = await read();
      check(`${label}: exactly the failed attempt and the retry went out`, st.fullCalls.length, 2);
      assertWhole(`${label} retry`, st, result(first)?.key || "missing-original-key");
    }

    // Keep the reader away from the bottom on both sides of the target; do not confuse browser clamping
    // after a fold with a repaint losing the reader's place. Padding is input prose, never fake tool output.
    const padded = await page.evaluate(() => window.__probe.show({ padded: true }));
    const parked = await page.evaluate(() => window.__probe.park());
    ok("(h) the scroll proof really starts parked away from both ends", Boolean(parked && parked.top > 0 && parked.gap > 40 && parked.max > 80 && parked.pinned === false), JSON.stringify(parked));
    const scrollClicked = await click();
    const scrollLoaded = scrollClicked && await loaded();
    const afterLoad = await page.evaluate(() => window.__probe.scroll());
    ok("(h) first full fetch preserves console position and the visible reading row", Boolean(scrollLoaded && parked && Math.abs(afterLoad.top - parked.top) <= 2 && afterLoad.reader === parked.reader && Math.abs(afterLoad.offset - parked.offset) <= 2 && Math.abs(afterLoad.header - parked.header) <= 2 && afterLoad.pinned === false), JSON.stringify({ before: parked, after: afterLoad }));
    const inside = await page.evaluate(() => window.__probe.park(true));
    ok("(h) a line inside the full result can be parked away from the tail", Boolean(inside && inside.gap > 40 && inside.reader.includes("of a long tool result")), JSON.stringify(inside));
    await page.evaluate(() => window.__probe.rebuild());
    const afterRebuild = await page.evaluate(() => window.__probe.scroll());
    ok("(h) renderJobs and burst rebuild preserve the parked full-result reading line", Boolean(inside && afterRebuild.reader === inside.reader && Math.abs(afterRebuild.offset - inside.offset) <= 2 && afterRebuild.gap > 40 && afterRebuild.pinned === false), JSON.stringify({ before: inside, after: afterRebuild }));
    st = await read();
    assertWhole("(h) scrolled rebuild", st, result(padded)?.key || "missing-original-key");
    check("(h) the scroll proof also needed only one full-row fetch", st.fullCalls.length, 1);
    ok("no page errors anywhere, including refusal and retry", pageErrors.length === 0, pageErrors.join(" | ") || "none");
  } finally {
    await browser.close();
  }
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
