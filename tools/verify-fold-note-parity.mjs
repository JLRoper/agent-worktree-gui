// One result, one header: every render path fetches the header's own full row into the original output box.
//
//   node tools/verify-fold-note-parity.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-fold-note-parity.mjs
//   FOLD_NOTE_PHASES=jobs,browser node tools/verify-fold-note-parity.mjs      # one layer at a time
//
// WHY THIS EXISTS
//
// Opening a long result's ordinary box must read the complete row in place, not leave the preview beside a
// second full-result box. The server's fold-note lines remain in jobLines as result identity metadata; the
// reader sees no separate hidden-lines link once that identity is known. Pairing is over the WHOLE TURN per
// tool, not a cursor restarted at each burst or the trimmed console window.
//
// WHAT IS DRIVEN HERE
//
//   jobs     the shipped counter (`lib/jobs.js` `withResultRow`, through `consume`) — the row is counted over
//            the whole turn, per tool, and survives the ring buffer trimming the lines away; and the shipped
//            note (`lib/jobs/console-lines.js`) carries that row on the LINE, next to a sentence the browser's
//            own matcher recognises.
//   browser  a card whose lines are the SHIPPED server's own output for a multi-result turn, painted by the
//            shipped `renderJobs()`, over a sandbox panel of its own port with a seeded `state.db` — so
//            `/api/tool-results` is the real route over real SQLite, and the store rows are the ones the route
//            hands back. The same turn is then served the way a reload serves it: as a window that starts
//            inside its last result, with the call line and the result header trimmed away.
//
// Real Playwright header clicks check the exact request, every returned line exactly once, updated counts,
// normal non-inverted fold keys, cached close/reopen, renderJobs and DOM-backed rebuildToolGroup. Condensed,
// one-stream, trimmed, legacy cursor and legacy head-match paths share the contract. Content markers tie each
// box to its own command, while deep equality proves the input buffer and its original fold notes never change.
//
// The browser half needs a Playwright install; without one this prints BROWSER-HALF-NOT-RUN and exits non-zero
// rather than passing on a half that never ran. :7331 and :8642 are never touched.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { Jobs } from "../lib/jobs.js";
import { toolResults } from "../lib/tool-results.js";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PHASES = new Set(
  String(process.env.FOLD_NOTE_PHASES || "jobs,browser")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const LF = String.fromCharCode(10);

let checks = 0;
let failures = 0;
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
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---------------------------------------------------------------------------------------------
// The turn this harness drives: four results for `terminal` and one for `patch`, in the order the calls ran,
// each result too long for the panel's 40-line head so each one ends in a fold note.
//
// Every result opens with the marker its own command printed (a terminal result echoes what it printed), which
// is what makes "the fetched row's first line vs the burst header's command text" checkable. Nothing here is
// hand-written console markup: the console lines come from the shipped `linesForEvent`, driven through the
// shipped registry below.
const THREAD = "wtgui-fold-parity-probe-5d2e10";
const TURN = "fold-parity-turn";
const RESULT_LINES = 60; // > MAX_TOOL_LINES (40), so hidden = 20
const terminalResults = [
  { cmd: "git log --oneline -40", marker: "=== git log ===" },
  { cmd: "cat huge.txt", marker: "=== head of huge.txt ===" },
  { cmd: "wc -l *", marker: "=== line counts ===" },
  { cmd: "ls -l src", marker: "=== listing src ===" },
];
const patchResults = [{ cmd: "patch docs/a.md", marker: "=== patch docs/a.md ===" }];
const bodyOfResult = (r) =>
  [r.marker, ...Array.from({ length: RESULT_LINES - 1 }, (_, i) => `${r.marker} line ${i + 2} of ${r.cmd}`)].join(LF);

// The turn's events, in the order the gateway emitted them: a call and its result per tool call.
function turnEvents() {
  const out = [];
  const push = (tool, r) => {
    out.push({ event: "tool.started", tool, preview: r.cmd });
    out.push({ event: "tool.completed", tool, preview: JSON.stringify({ output: bodyOfResult(r) }), duration: 1.25 });
  };
  push("terminal", terminalResults[0]);
  out.push({ event: "message.delta", delta: "reading the source" });
  push("terminal", terminalResults[1]);
  push("patch", patchResults[0]);
  out.push({ event: "message.delta", delta: "and the rest" });
  push("terminal", terminalResults[2]);
  push("terminal", terminalResults[3]);
  return out;
}

// The console lines the SHIPPED server pushes for those events, driven through the shipped registry — so the
// counter under test is the one the panel really uses, not a copy of it in the harness.
const registry = new Jobs({ jobsFile: null });
const job = {
  id: TURN,
  thread: THREAD,
  turn: 1,
  status: "done",
  lines: [],
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  endedAt: new Date(Date.now() - 30_000).toISOString(),
};
for (const evt of turnEvents()) registry.consume(job, evt);
const SERVER_LINES = job.lines.map((l) => ({ kind: l.kind, text: l.text, ...(l.fold ? { fold: l.fold } : {}) }));
const noteLines = (lines) => lines.filter((l) => l.kind === "tool-out" && /— click to read\s*$/.test(String(l.text || "")));
const notes = noteLines(SERVER_LINES);
const EXPECTED_ROWS = [
  ["terminal", 0],
  ["terminal", 1],
  ["patch", 0],
  ["terminal", 2],
  ["terminal", 3],
];
// The reload shape: `/api/jobs` serves the last 120 lines and the ring buffer trims from the front, so a burst
// routinely arrives with its call line and its `↳ tool` header already gone. Start the window 38 lines into the
// last result, i.e. two head lines past where its header would have been.
const lastNoteAt = SERVER_LINES.map((l, i) => (/— click to read\s*$/.test(String(l.text || "")) ? i : -1)).filter((i) => i >= 0).at(-1);
const TRIMMED = SERVER_LINES.slice(lastNoteAt - 38);
// The same lines as a card saved before any of this existed holds them: no stamp on the note at all.
const OLD_LINES = SERVER_LINES.map(({ kind, text }) => ({ kind, text }));
// …and the two together: a card written before the stamp, served as a window that starts inside its last result.
// This note names no tool and no row — the state the live board's own measurement was taken in.
const TRIMMED_OLD = TRIMMED.map(({ kind, text }) => ({ kind, text }));

if (PHASES.has("jobs")) {
  console.log("── the note the server pushes, and the row it counts " + "─".repeat(20));
  check("(a) a note per folded result", notes.length, terminalResults.length + patchResults.length);
  check("(a) each note names its own tool and its index over the WHOLE turn for that tool", notes.map((l) => [l.fold.tool, l.fold.row]), EXPECTED_ROWS);
  check(
    "(a) the sentence itself is untouched: the reader still reads the panel's own fold note",
    [...new Set(notes.map((l) => l.text))],
    [`… ${RESULT_LINES - 40} lines hidden — click to read`],
  );
  ok("(a) the identity is on the LINE, never in its text", notes.every((l) => !/terminal|patch/.test(l.text) && l.fold && Number.isInteger(l.fold.row)));
  ok(
    "(a) and the browser's own matcher recognises every one of them",
    notes.every((l) => /^\s*…\s+\d+ lines?(?: hidden| shortened)(?:, \d+ lines? shortened)? — click to read\s*$/.test(l.text)),
  );
  // A result that fits the head says nothing (no note at all) — but it is still one of the turn's results, so the
  // note AFTER it must count it: that is what "counted at the event" buys over "counted in the window".
  const short = new Jobs({ jobsFile: null });
  const j2 = { id: "short", thread: "t", lines: [] };
  short.consume(j2, { event: "tool.completed", tool: "terminal", preview: JSON.stringify({ output: `on main${LF}nothing to commit` }) });
  short.consume(j2, { event: "tool.completed", tool: "terminal", preview: JSON.stringify({ output: bodyOfResult(terminalResults[0]) }) });
  check("(b) a result inside the head gets no note, and still advances the count", [noteLines(j2.lines).length, noteLines(j2.lines)[0].fold.row], [1, 1]);

  // The ring buffer (MAX_LINES = 600) trims the lines a long turn held. The ROW must not go with them: the store
  // still indexes that result over the whole turn, so the note still has to name its own index.
  const deep = new Jobs({ jobsFile: null });
  const j3 = { id: "deep", thread: "t", lines: [] };
  for (let i = 0; i < 3; i++) deep.consume(j3, { event: "tool.completed", tool: "terminal", preview: JSON.stringify({ output: bodyOfResult(terminalResults[0]) }) });
  const before = j3.lines.length;
  check("(c) three results of 42 lines each are on the card", before, 3 * 42);
  for (let i = 0; i < 700; i++) deep.push(j3, { kind: "tool-out", text: `filler ${i}` });
  deep.consume(j3, { event: "tool.completed", tool: "terminal", preview: JSON.stringify({ output: bodyOfResult(terminalResults[1]) }) });
  check("(c) 700 more lines were trimmed away by the ring buffer", j3.lines.length <= 600, true);
  check("(c) the next note still names the turn's own row, not a row inside the window", [before, noteLines(j3.lines).at(-1).fold.row], [126, 3]);
  ok("(c) and the window no longer holds the turn's first result", !j3.lines.some((l) => l.fold && l.fold.row === 0));
  const persisted = JSON.stringify(job.resultRows);
  ok("(d) the count is kept on the job, so a restart can keep counting", /"terminal":4/.test(persisted) && /"patch":1/.test(persisted), persisted);
  // The store's own reading of the same turn: the rows the counter indexes into, read through the shipped store
  // reader over a seeded state.db, so the two halves cannot drift apart in this file either.
  const dir0 = mkdtempSync(path.join(tmpdir(), "wtgui-fold-parity-"));
  try {
    const db = new DatabaseSync(path.join(dir0, "state.db"));
    db.exec("create table messages (id integer primary key, session_id text, role text, tool_name text, tool_call_id text, content text, timestamp real)");
    const ins = db.prepare("insert into messages (session_id, role, tool_name, tool_call_id, content, timestamp) values (?, 'tool', ?, ?, ?, ?)");
    let n = 0;
    for (const [tool, r] of [...terminalResults.map((r) => ["terminal", r]), ...patchResults.map((r) => ["patch", r])]) ins.run(THREAD, tool, `call-${++n}`, JSON.stringify({ output: bodyOfResult(r) }), 1000 + n);
    db.close();
    const win = { dbPath: path.join(dir0, "state.db"), sessionId: THREAD, tool: "terminal", from: 900_000, to: 1_100_000 };
    check(
      "(d) the store's rows for the turn open with the result each note names",
      notes.filter((l) => l.fold.tool === "terminal").map((l) => toolResults({ ...win, index: l.fold.row, maxChars: 0 })[0].text.split(LF)[0]),
      terminalResults.map((r) => r.marker),
    );
  } finally {
    rmSync(dir0, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// The browser half.
let dir = null;
let panel = null;
let base = "";
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-fold-parity-"));
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  for (const d of [scanRoot, home, configDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  // The store the real route reads: one `messages` row per result, in the order the calls ran and inside the
  // turn's own clock window.
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec("create table messages (id integer primary key, session_id text, role text, tool_name text, tool_call_id text, content text, timestamp real)");
  const ins = db.prepare("insert into messages (session_id, role, tool_name, tool_call_id, content, timestamp) values (?, 'tool', ?, ?, ?, ?)");
  const from = Date.parse(job.startedAt) / 1000;
  let seq = 0;
  const seed = (tool, r) => ins.run(THREAD, tool, `call-${++seq}`, JSON.stringify({ output: bodyOfResult(r) }), from + seq);
  for (const r of terminalResults) seed("terminal", r);
  for (const r of patchResults) seed("patch", r);
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
    env: { ...process.env, PANEL_CONFIG: path.resolve(configPath), HERMES_HOME: path.resolve(home), PANEL_TOKEN: "", API_SERVER_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: `the sandbox panel to answer on ${base}` });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
  // The route this harness leans on has to answer from the store we seeded, before a browser is involved.
  const q = `thread=${THREAD}&row=3&full=1&n=1&from=${Date.parse(job.startedAt)}&to=${Date.parse(job.endedAt)}`;
  const one = await fetch(`${base}/api/tool-results?tool=terminal&${q}`).then((r) => r.json());
  const rows = Array.isArray(one.results) ? one.results : [];
  check("(e) the sandbox route serves the seeded rows: row 3 is the fourth result", [rows.length, String(rows[0] && rows[0].text).split(LF)[0]], [1, terminalResults[3].marker]);
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
  const browser = await pw.chromium.launch({ headless: true });
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
    await installFakeEventSource(context);
    await context.addInitScript(
      ({ snapshot, lines, trimmedLines, oldLines, trimmedOld, startedAt, endedAt, thread, id }) => {
        const realFetch = window.fetch.bind(window);
        const probe = { snapshot, calls: [] };
        window.__probe = probe;
        const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        window.fetch = async (url, opts = {}) => {
          const u = String(url);
          const method = String(opts.method || "GET").toUpperCase();
          if (method === "GET" && u.includes("/api/state")) return json({ ...probe.snapshot, jobs: [...state.jobs.values()] });
          // Both shallow pairing reads and full-row clicks reach the sandbox's real SQLite-backed route.
          if (method === "GET" && u.includes("/api/tool-results")) probe.calls.push(u);
          return realFetch(url, opts);
        };
        localStorage.setItem("wtgui.autoCollect", "0");
        // The condensed half of this probe reads the tallied group's body (a head row per tool, its fold, the
        // "all N" button). The shipped default is one expandable line per call, so the tally is asked for here.
        localStorage.setItem("wtgui.toolGroups", "1");
        const foldRe = /^\s*…\s+\d+ lines?(?: hidden| shortened)(?:, \d+ lines? shortened)? — click to read\s*$/;
        const pre = () => document.querySelector(`pre.job-out[data-out="${id}"]`);
        probe.show = (which = "full", stream = false) => {
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
          // renderJobs() rewrites the card list only when the set of cards, or a card's own conversationSignature,
          // has moved — that is what stops a live console being replaced under the reader on every append. This
          // probe paints the same turn from different lines (full | trimmed | old), which moves no signature:
          // clear the memo of the last one first, or section (g) reads the card (f) left in the DOM.
          state.jobsListSig = "";
          state.maximized = id;
          localStorage.setItem(`wtgui.stream.${thread}`, stream ? "1" : "0");
          probe.calls = [];
          const src = which === "trimmed" ? trimmedLines : which === "old" ? oldLines : which === "trimmed-old" ? trimmedOld : lines;
          state.jobLines.set(id, src.map((l) => ({ ...l })));
          state.jobs.set(id, {
            id, thread, turn: 1, status: "done", prompt: "single-box fold parity probe", displayPrompt: "single-box fold parity probe",
            cwd: null, worktree: false, branch: null, runId: "run_probe", startedAt, endedAt, model: "probe/model",
            lines: [], artifacts: [], attachments: [], subagents: [],
          });
          probe.originalLines = JSON.stringify(state.jobLines.get(id));
          renderJobs();
          return probe.read();
        };
        const callFor = (header) => {
          const rows = [...pre().querySelectorAll("[data-ltext], .code-head")];
          for (let k = rows.indexOf(header) - 1; k >= 0; k--) {
            if (rows[k].dataset.lkind === "tool") return rows[k].dataset.ltext || "";
          }
          return "";
        };
        probe.controls = () => [...pre().querySelectorAll(".code-head[data-fold-turn][data-fold-tool][data-fold-row]")].map((h) => {
          const box = h.closest(".code-box");
          const body = box?.querySelector(".code-body");
          return {
            turn: h.dataset.foldTurn, tool: h.dataset.foldTool, row: h.dataset.foldRow,
            key: h.dataset.codeKey || "", codeFold: h.dataset.codeFold || "", fetch: h.dataset.toolFold === "1",
            inverted: h.dataset.codeInverted || "", n: h.querySelector(".code-n")?.textContent || "",
            open: Boolean(body && !body.hidden && h.getAttribute("aria-expanded") === "true" && box.classList.contains("is-open")),
            expanded: h.getAttribute("aria-expanded"), call: callFor(h), grp: h.closest(".tgrp")?.dataset.tgrp || "",
            body: [...(body?.querySelectorAll(".jl[data-ltext]") || [])].map((r) => r.dataset.ltext),
          };
        });
        probe.result = (tool, row) => probe.controls().find((c) => c.turn === id && c.tool === tool && c.row === String(row)) || null;
        probe.read = () => {
          const o = pre();
          const notes = [...o.querySelectorAll("[data-ltext]")].filter((d) => foldRe.test(d.dataset.ltext || ""));
          return {
            controls: probe.controls(), boxes: o.querySelectorAll(".code-box").length,
            output: [...o.querySelectorAll(".jl[data-ltext]")].filter((d) => d.getClientRects().length > 0).map((d) => d.dataset.ltext),
            footerLinks: o.querySelectorAll(".fold-read").length,
            externalNotes: notes.filter((d) => !d.closest(".code-box") && !d.hidden).map((d) => ({ text: d.dataset.ltext, button: Boolean(d.querySelector("[data-tool-fold]")) })),
            calls: probe.calls.slice(), fullCalls: probe.calls.filter((u) => new URL(u, location.href).searchParams.get("full") === "1"),
            lines: (state.jobLines.get(id) || []).length, unchanged: JSON.stringify(state.jobLines.get(id)) === probe.originalLines,
            groups: [...o.querySelectorAll(".tgrp")].map((g) => ({ key: g.dataset.tgrp, open: !g.querySelector(".tgrp-body")?.hidden, flat: g.dataset.gflat === "1" })),
          };
        };
        probe.rebuild = () => {
          // A full render removes any _burst shortcut: the following rebuild must read the DOM back correctly.
          renderJobs();
          for (const g of [...pre().querySelectorAll(".tgrp")]) rebuildToolGroup(g, { filter: g.dataset.filter || "", open: !g.querySelector(".tgrp-body")?.hidden });
          return probe.read();
        };
        probe.readStore = async (tool) => {
          await ensureToolStore(id, tool, null);
          // The store read lands in state.toolStore, which no conversationSignature carries: force the card list to
          // repaint (same reason as show()), or the legacy note stays a plain note instead of resolving to its row.
          state.jobsListSig = "";
          renderJobs();
          return probe.read();
        };
      },
      { snapshot: realSnapshot, lines: SERVER_LINES, trimmedLines: TRIMMED, oldLines: OLD_LINES, trimmedOld: TRIMMED_OLD,
        startedAt: job.startedAt, endedAt: job.endedAt, thread: THREAD, id: TURN },
    );
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err?.message || err)));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__probe && window.WMApp?.core), null, { timeout: 20_000 });
    const read = () => page.evaluate(() => window.__probe.read());
    const header = (tool, row) => page.locator(`pre.job-out[data-out="${TURN}"] .code-head[data-fold-turn="${TURN}"][data-fold-tool="${tool}"][data-fold-row="${row}"]`);
    const named = (st) => st.controls.map((c) => [c.tool, Number(c.row), c.turn]);
    const noFooter = (label, st) => check(`${label}: no separate hidden-lines link or external note`, [st.footerLinks, st.externalNotes.length], [0, 0]);
    const openAll = async () => {
      const groups = page.locator(`pre.job-out[data-out="${TURN}"] .tgrp`);
      for (let i = 0; i < await groups.count(); i++) {
        if (await groups.nth(i).locator(".tgrp-body").evaluate((b) => b.hidden)) await groups.nth(i).locator("[data-tgrp-more]").click();
      }
    };
    // In the 🌊 view a call's box is drawn BEHIND its own row, and that row is the box's opener there: the header
    // lives inside the shut `.tgrp-out`, so it has no box to press until the row is opened. That is the reader's own
    // two steps (press the row, then the header inside it) and the ones verify-output-boxes drives; the condensed
    // view has no `.tgrp-call`, so this is a no-op there.
    const reveal = async (tool, row) => {
      const call = header(tool, row).locator("xpath=ancestor::div[contains(@class,'tgrp-call')][1]");
      if ((await call.count()) !== 1) return;
      if (await header(tool, row).isVisible()) return;
      await call.locator("xpath=.//div[contains(@class,'tgrp-row')]").click();
      await waitFor(() => header(tool, row).isVisible(), { timeoutMs: 5000, stepMs: 50, what: `the stream's row ${tool} ${row} to open its box` });
    };
    const press = async (tool, row) => {
      const before = await read();
      const own = before.controls.find((c) => c.tool === tool && c.row === String(row));
      if (await header(tool, row).count() !== 1) return { pressed: false, before, own, after: before, requests: [] };
      await reveal(tool, row);
      await header(tool, row).click();
      const loaded = await waitFor(() => page.evaluate(([id, t, r]) => {
        const c = window.__probe.result(t, r);
        return Boolean(c && c.open && !c.fetch && state.foldRows.has(foldKey(id, t, r)) && !state.foldPending?.has(foldKey(id, t, r)));
      }, [TURN, tool, row]), { timeoutMs: 5000, stepMs: 50, what: `${tool} row ${row} to open in its original box` });
      const after = await read();
      return { pressed: true, loaded, before, own, after, requests: after.fullCalls.slice(before.fullCalls.length) };
    };
    const assertPress = (label, p, tool, row, result, boxCount, withCall = true) => {
      const c = p.after.controls.find((v) => v.tool === tool && v.row === String(row));
      ok(`${label}: a real header click loads the row`, p.pressed && p.loaded);
      check(`${label}: exactly the named turn/tool/row is requested uncapped`, p.requests.map((u) => {
        const q = new URL(u, base).searchParams;
        return [q.get("thread"), q.get("tool"), q.get("row"), q.get("full"), q.get("n"), q.get("from"), q.get("to")];
      }), [[THREAD, tool, String(row), "1", "1", String(Date.parse(job.startedAt)), String(Date.parse(job.endedAt))]]);
      check(`${label}: the same logical header retains its identity and normal fold key`, c ? [c.turn, c.tool, c.row, c.key, c.codeFold, c.fetch, c.inverted] : null,
        p.own ? [TURN, tool, String(row), p.own.key, "1", false, ""] : [TURN, tool, String(row), "nonempty original key", "1", false, ""]);
      ok(`${label}: the original box is open with the full line count`, Boolean(c?.open && c.n === `${RESULT_LINES} lines`));
      const want = bodyOfResult(result).split(LF);
      ok(`${label}: every full line occurs once, with no duplicate first 40 lines`, JSON.stringify(c?.body) === JSON.stringify(want) && want.every((text) => p.after.output.filter((t) => t === text).length === 1), `${c?.body.length || 0}/${want.length} rows`);
      if (withCall) ok(`${label}: the result matches its burst's own command and preview`, Boolean(p.own?.call.includes(result.cmd) && p.own.body[0] === result.marker && c?.body[0] === p.own.body[0]), p.own?.call || "no call header");
      check(`${label}: there is still only one box per result`, p.after.boxes, boxCount);
      ok(`${label}: jobLines and its original fold identities are untouched`, p.before.unchanged && p.after.unchanged && p.after.lines === p.before.lines);
      noFooter(label, p.after);
    };
    const cycle = async (label, tool, row, result, boxes) => {
      const before = await read();
      const own = before.controls.find((c) => c.tool === tool && c.row === String(row));
      if (await header(tool, row).count() !== 1) {
        ok(`${label}: the loaded result still has one header to close/reopen`, false);
        return;
      }
      await header(tool, row).click();
      let st = await read();
      let c = st.controls.find((v) => v.tool === tool && v.row === String(row));
      ok(`${label}: the second click folds that very box`, Boolean(c && !c.open && c.expanded === "false"));
      st = await page.evaluate(() => window.__probe.rebuild());
      c = st.controls.find((v) => v.tool === tool && v.row === String(row));
      ok(`${label}: shut state and identity survive renderJobs plus a DOM-backed rebuild`, Boolean(c && !c.open && c.expanded === "false" && c.key === own.key && !c.fetch && !c.inverted));
      await header(tool, row).click();
      st = await page.evaluate(() => window.__probe.rebuild());
      c = st.controls.find((v) => v.tool === tool && v.row === String(row));
      ok(`${label}: reopening survives both rebuilds and shows the full cached text once`, Boolean(c?.open && c.key === own.key && JSON.stringify(c.body) === JSON.stringify(bodyOfResult(result).split(LF))));
      check(`${label}: close/reopen never fetches the full row twice`, st.fullCalls.length, before.fullCalls.length);
      check(`${label}: rebuilds never add a second copy`, st.boxes, boxes);
      ok(`${label}: the input ring buffer is still unchanged`, st.unchanged);
      noFooter(label, st);
    };

    // The SERVER'S notes remain input metadata; the HEADER is the only rendered fetch/fold control.
    const full = await page.evaluate(() => window.__probe.show("full"));
    check("(f) the card holds the shipped server's own lines", full.lines, SERVER_LINES.length);
    check("(f) one original box and one identified header per result", [full.boxes, full.controls.length], [notes.length, notes.length]);
    check("(f) every header names its own turn, tool and whole-turn row", named(full), EXPECTED_ROWS.map(([t, r]) => [t, r, TURN]));
    ok("(f) every long-result header starts folded and is the fetch control", full.controls.length === notes.length && full.controls.every((c) => !c.open && c.expanded === "false" && c.fetch && c.codeFold === "1" && c.key && !c.inverted && c.n === "40 of 60 lines"), JSON.stringify(full.controls.map((c) => [c.tool, c.row, c.open, c.n, c.fetch, c.key, c.codeFold, c.inverted])));
    check("(f) rendering the folded headers needs no request", full.calls.length, 0);
    ok("(f) the identities span several independent bursts", new Set(full.controls.map((c) => c.grp)).size > 1);
    noFooter("(f)", full);

    const trimmed = await page.evaluate(() => window.__probe.show("trimmed"));
    check("(g) the served window is the real suffix with no call line", [trimmed.lines, TRIMMED.some((l) => l.kind === "tool")], [TRIMMED.length, false]);
    check("(g) the trimmed result is one identified folded box, not a footer", [trimmed.boxes, named(trimmed)], [1, [["terminal", 3, TURN]]]);
    ok("(g) its own header starts folded and requests the missing row", trimmed.controls.length === 1 && !trimmed.controls[0].open && trimmed.controls[0].fetch);
    noFooter("(g)", trimmed);
    assertPress("(g) trimmed terminal row 3", await press("terminal", 3), "terminal", 3, terminalResults[3], 1, false);
    await cycle("(g) trimmed", "terminal", 3, terminalResults[3], 1);

    await page.evaluate(() => window.__probe.show("full"));
    await openAll();
    const storeReady = await waitFor(() => page.evaluate((id) => state.toolStore.has(`${id}|terminal`) && state.toolStore.has(`${id}|patch`), TURN), { timeoutMs: 5000, stepMs: 50, what: "the opened bursts' SQLite route reads" });
    const opened = await read();
    ok("(h) opening the bursts reads the real SQLite route", storeReady && opened.calls.some((u) => new URL(u, base).searchParams.get("full") !== "1"));
    ok("(h) every burst is open, but its result boxes are still folded", opened.groups.every((g) => g.open) && opened.controls.length === notes.length && opened.controls.every((c) => !c.open && c.fetch));
    check("(h) capped pairing reads do not load any uncapped row", opened.fullCalls.length, 0);
    noFooter("(h)", opened);

    for (const [tool, row] of EXPECTED_ROWS) {
      const result = tool === "terminal" ? terminalResults[row] : patchResults[row];
      assertPress(`(i) ${tool} row ${row}`, await press(tool, row), tool, row, result, notes.length);
    }
    const afterPresses = await read();
    check("(i) the separate bursts fetched five separate row identities", new Set(afterPresses.fullCalls.map((u) => {
      const q = new URL(u, base).searchParams;
      return `${q.get("tool")}#${q.get("row")}`;
    })).size, EXPECTED_ROWS.length);
    const rebuilt = await page.evaluate(() => window.__probe.rebuild());
    check("(j) repainting and rebuilding keep every fetched box open", rebuilt.controls.map((c) => c.open), EXPECTED_ROWS.map(() => true));
    check("(j) the server's input line count never changes", rebuilt.lines, SERVER_LINES.length);
    ok("(j) every input line, including the original fold notes, is identical", rebuilt.unchanged);
    noFooter("(j)", rebuilt);
    await cycle("(j) multi-burst", "terminal", 1, terminalResults[1], notes.length);

    const old = await page.evaluate(() => window.__probe.show("old"));
    check("(k) the legacy card still holds the same server lines", old.lines, SERVER_LINES.length);
    check("(k) legacy unstamped lines still identify their boxes from the burst cursor", named(old), EXPECTED_ROWS.map(([t, r]) => [t, r, TURN]));
    await openAll();
    await waitFor(() => page.evaluate((id) => state.toolStore.has(`${id}|terminal`) && state.toolStore.has(`${id}|patch`), TURN), { timeoutMs: 5000, stepMs: 50, what: "the legacy card's SQLite rows" });
    const oldWithStore = await read();
    check("(k) real store reads keep every legacy box paired to its own row", named(oldWithStore), EXPECTED_ROWS.map(([t, r]) => [t, r, TURN]));
    assertPress("(k) legacy terminal row 1", await press("terminal", 1), "terminal", 1, terminalResults[1], notes.length);

    const bare = await page.evaluate(() => window.__probe.show("trimmed-old"));
    check("(l) an unidentifiable legacy window keeps one honest plain note", [bare.lines, bare.externalNotes.length, bare.controls.length], [TRIMMED.length, 1, 0]);
    ok("(l) with no identity it does not offer a wrong-row fetch", bare.externalNotes.every((n) => !n.button) && bare.footerLinks === 0);
    const resolved = await page.evaluate(() => window.__probe.readStore("terminal"));
    check("(l) the real store's head match resolves that window's own row", named(resolved), [["terminal", 3, TURN]]);
    noFooter("(l) resolved", resolved);
    assertPress("(l) resolved legacy row 3", await press("terminal", 3), "terminal", 3, terminalResults[3], 1, false);

    for (const [which, label] of [["full", "(m) one-stream"], ["trimmed", "(n) trimmed one-stream"]]) {
      const st = await page.evaluate((w) => window.__probe.show(w, true), which);
      const count = which === "full" ? notes.length : 1;
      check(`${label}: one identified box per result`, [st.boxes, st.controls.length], [count, count]);
      ok(`${label}: the stream is flat and every result still starts folded`, st.groups.length > 0 && st.groups.every((g) => g.flat && g.open) && st.controls.length === count && st.controls.every((c) => !c.open && c.fetch));
      noFooter(label, st);
      assertPress(`${label} row 3`, await press("terminal", 3), "terminal", 3, terminalResults[3], count, which === "full");
      await cycle(label, "terminal", 3, terminalResults[3], count);
    }
    ok("no page errors", pageErrors.length === 0, pageErrors.join(" | ") || "none");
  } finally {
    await browser.close();
  }
}
console.log("");
if (PHASES.has("browser")) {
  console.log("── the affordance and the row, in a browser " + "─".repeat(24));
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
}

console.log("");
console.log(failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
