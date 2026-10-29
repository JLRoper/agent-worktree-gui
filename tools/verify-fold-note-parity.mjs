// A fold note is a real control on EVERY render path, and the row it names is the row its click fetches.
//
//   node tools/verify-fold-note-parity.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-fold-note-parity.mjs
//   FOLD_NOTE_PHASES=jobs,browser node tools/verify-fold-note-parity.mjs      # one layer at a time
//
// WHY THIS EXISTS
//
// The whole-tool-stream change made the panel fold a long result and put the rest behind a click. Two things
// then did not agree:
//
//   * the AFFORDANCE. `cfFoldRow` only emits `button.fold-read[data-tool-fold]` when it is handed a fold, and
//     the console only ever built one from a per-burst cursor on the ONE path whose segment starts with a
//     `↳ tool · 1.2s` result header. A burst the served window trimmed of its call line (`/api/jobs` serves the
//     last 120 lines, `jobs.json` keeps 120, `MAX_LINES` is 600) renders through `consoleBodyHtml` with no fold
//     at all, so a reload showed "… 17 lines hidden — click to read" as a plain `div.jl-fold` with nothing to
//     click. Measured on the live board: `clickable: 0` with every burst opened and the store route answering
//     200.
//   * the ROW. That cursor was seeded by counting the result lines the CONSOLE holds, while
//     `lib/tool-results.js` indexes a tool's rows over the WHOLE TURN (`LIMIT 1 OFFSET row`). The note in burst
//     `9658fe9e#2` named `row=0`, and row 0 for `terminal` in that turn is the opening recon command (799
//     chars, 14 lines) — a different result. A click read back the wrong text.
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
// The row check is by CONTENT, because a position is exactly what went wrong: the console lines drawn above a
// note are the first lines of that result's stored row (one fold, one `unwrapToolText`), so the fetched text's
// first line is compared against the first head line drawn above the note that was pressed — and the fixture
// results open with the marker their own command printed, so that same first line is also the command text the
// burst's header names.
//
// The browser half needs a Playwright install; without one this prints BROWSER-HALF-NOT-RUN and exits non-zero
// rather than passing on a half that never ran. :7331 and :8642 are never touched.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { Jobs } from "../lib/jobs.js";
import { toolResults } from "../lib/tool-results.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);
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
    env: { ...process.env, PANEL_CONFIG: path.resolve(configPath), HERMES_HOME: path.resolve(home), PANEL_TOKEN: "" },
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
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await context.addInitScript(
    ({ snapshot, lines, trimmedLines, oldLines, trimmedOld, startedAt, endedAt, thread, id }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { snapshot, calls: [] };
      window.__probe = probe;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = String((opts && opts.method) || "GET").toUpperCase();
        // The board's own snapshot: the card under test lives in it. Everything else is the sandbox panel's own
        // answer — `/api/tool-results` above all, because the store read is half of what is being proved.
        if (method === "GET" && u.includes("/api/state")) return json({ ...probe.snapshot, jobs: [...state.jobs.values()] });
        if (method === "GET" && u.includes("/api/tool-results")) probe.calls.push(u);
        return realFetch(url, opts);
      };
      const FakeStream = function () {
        this.readyState = 1;
      };
      FakeStream.prototype.addEventListener = function () {};
      FakeStream.prototype.removeEventListener = function () {};
      FakeStream.prototype.close = function () {};
      window.EventSource = FakeStream;

      const foldRe = /^\s*…\s+\d+ lines?(?: hidden| shortened)(?:, \d+ lines? shortened)? — click to read\s*$/;
      // Paint the turn as a card: the same call renderJobs() makes on a reload, over the lines handed in.
      probe.show = (which) => {
        state.jobs.clear();
        state.jobLines.clear();
        state.toolStore.clear();
        state.toolGroupOpen.clear();
        state.codeBoxOpen.clear();
        state.callFolded.clear();
        state.foldRows.clear();
        state.outPinned = {};
        state.maximized = id;
        const src = which === "trimmed" ? trimmedLines : which === "old" ? oldLines : which === "trimmed-old" ? trimmedOld : lines;
        state.jobLines.set(id, src.map((l) => ({ ...l })));
        state.jobs.set(id, {
          id,
          thread,
          turn: 1,
          status: "done",
          prompt: "fold note parity probe",
          displayPrompt: "fold note parity probe",
          cwd: null,
          worktree: false,
          branch: null,
          runId: "run_probe",
          startedAt,
          endedAt,
          model: "probe/model",
          lines: [],
          artifacts: [],
          attachments: [],
          subagents: [],
        });
        renderJobs();
        return (state.jobLines.get(id) || []).length;
      };
      // Every fold note the console drew, and whether it is a control.
      probe.notes = () =>
        [...document.querySelectorAll("pre.job-out .jl-fold")].map((d) => {
          const btn = d.querySelector("[data-tool-fold]");
          const grp = d.closest(".tgrp");
          return {
            text: d.dataset.ltext,
            isButton: Boolean(btn),
            tool: btn ? btn.dataset.foldTool : null,
            row: btn ? btn.dataset.foldRow : null,
            turn: btn ? btn.dataset.foldTurn : null,
            grp: grp ? grp.dataset.tgrp : null,
          };
        });
      // The console lines DRAWN above a note, and the call line the result belongs to: the head the panel kept, in
      // document order (it may be nested in a diff window) and no further back than the panel's own 40 lines. The
      // header sits between the head and the call line, so the walk skips it once and keeps going for the call.
      const headOf = (noteEl) => {
        const pre = document.querySelector("pre.job-out");
        const rows = [...pre.querySelectorAll("[data-ltext]")];
        const at = rows.indexOf(noteEl);
        const head = [];
        let call = "";
        let pastHeader = false;
        for (let k = at - 1; k >= 0; k--) {
          const d = rows[k];
          const t = String(d.dataset.ltext || "");
          const kind = d.dataset.lkind || "";
          if (kind === "tool") {
            call = t;
            break;
          }
          if (kind !== "tool-out") break;
          if (/^\s*↳\s*\S/.test(t)) {
            // The result header: the head is under it and the call line is above it.
            if (pastHeader) break;
            pastHeader = true;
            continue;
          }
          if (foldRe.test(t)) break;
          if (!pastHeader && head.length < 40) head.unshift(t);
        }
        return { head, call };
      };
      const noteFor = (tool, row) =>
        [...document.querySelectorAll("pre.job-out .jl-fold")].find((d) => {
          const btn = d.querySelector("[data-tool-fold]");
          return btn && btn.dataset.foldTool === String(tool) && btn.dataset.foldRow === String(row);
        }) || null;
      probe.headFor = (tool, row) => {
        const noteEl = noteFor(tool, row);
        return noteEl ? headOf(noteEl) : null;
      };
      probe.bodyText = () => document.querySelector("pre.job-out").textContent;
      // The stored text a press drew, as the panel's own store rows: the ones that appeared after the press
      // (earlier presses left theirs on the card too).
      probe.storedRows = () => [...document.querySelectorAll('pre.job-out [data-lkind="store"]')].map((d) => String(d.dataset.ltext || ""));
      probe.lineCount = () => (state.jobLines.get(id) || []).length;
      probe.storeCalls = () => probe.calls.slice();
      probe.grps = () =>
        [...document.querySelectorAll("pre.job-out .tgrp")].map((g) => ({
          t: g.dataset.tgrp,
          jl: g.querySelectorAll(".jl").length,
          open: !(g.querySelector(".tgrp-body") || {}).hidden,
        }));
      probe.openAll = async () => {
        for (const g of [...document.querySelectorAll("pre.job-out .tgrp")]) {
          const body = g.querySelector(".tgrp-body");
          if (body && body.hidden) g.querySelector("[data-tgrp-more]")?.click();
          await new Promise((r) => setTimeout(r, 250));
        }
        return probe.grps();
      };
      // Press one note, by the tool and the row it names, and report what went out and what came back.
      probe.press = async (tool, row) => {
        const noteEl = noteFor(tool, row);
        if (!noteEl) return { pressed: false };
        const btn = noteEl.querySelector("[data-tool-fold]");
        const before = { calls: probe.calls.length, lines: probe.lineCount(), head: headOf(noteEl), stores: probe.storedRows().length };
        const named = { tool: btn.dataset.foldTool, row: btn.dataset.foldRow, turn: btn.dataset.foldTurn };
        btn.click();
        for (let i = 0; i < 60 && probe.calls.length === before.calls; i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 400));
        return {
          pressed: true,
          named,
          head: before.head,
          url: probe.calls.slice(before.calls)[0] || "",
          fetched: (probe.storedRows()[before.stores] || "").replace(/\s+$/, ""),
          text: probe.bodyText(),
          lines0: before.lines,
          lines: probe.lineCount(),
          foldsHeld: state.foldRows.size,
        };
      };
      probe.repaint = () => renderJobs();
      // The panel's own store read, driven the way its 3s timer drives it, then the repaint every push performs:
      // used to prove a note resolves from the store's rows alone, with no stamp and no cursor to help it.
      probe.readStore = async (tool) => {
        await ensureToolStore(id, tool, null);
        renderJobs();
        return probe.notes();
      };
    },
    {
      snapshot: realSnapshot,
      lines: SERVER_LINES,
      trimmedLines: TRIMMED,
      oldLines: OLD_LINES,
      trimmedOld: TRIMMED_OLD,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      thread: THREAD,
      id: TURN,
    },
  );

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__probe && window.WMApp && window.WMApp.core), null, { timeout: 20_000 });

  // (f) the whole turn, painted the way a card is painted: every note is a control on the FIRST paint, before any
  // store read — the parity the incremental path always had and a reload did not.
  const full = await page.evaluate(() => {
    const n = window.__probe.show("full");
    return { lines: n, notes: window.__probe.notes(), calls: window.__probe.storeCalls().length, grps: window.__probe.grps() };
  });
  check("(f) the card holds the shipped server's own lines for the turn", full.lines, SERVER_LINES.length);
  check("(f) one note per folded result, all on the card", full.notes.length, notes.length);
  ok("(f) EVERY note is a real button on the first paint", full.notes.every((n) => n.isButton), JSON.stringify(full.notes.map((n) => [n.grp, n.isButton])));
  check("(f) each one names the tool, the row and the turn it needs", full.notes.map((n) => [n.tool, Number(n.row), n.turn]), EXPECTED_ROWS.map(([tool, row]) => [tool, row, TURN]));
  check("(f) nothing was fetched to draw them", full.calls, 0);
  ok("(f) and the notes are spread over more than one burst", new Set(full.notes.map((n) => n.grp)).size > 1, JSON.stringify(full.notes.map((n) => n.grp)));

  // (g) the reload shape: the same turn served as a window that starts inside its last result — no call line, no
  // result header — which is what made the live board's note a plain div.
  const trimmedCard = await page.evaluate(() => {
    const n = window.__probe.show("trimmed");
    return { lines: n, notes: window.__probe.notes() };
  });
  check("(g) the served window is a suffix of the turn", trimmedCard.lines, TRIMMED.length);
  ok("(g) the window's burst has no call line of its own", !TRIMMED.some((l) => l.kind === "tool"), JSON.stringify(TRIMMED.map((l) => l.kind).slice(0, 3)));
  ok("(g) …and the note in it is STILL a button", trimmedCard.notes.length > 0 && trimmedCard.notes.every((n) => n.isButton), JSON.stringify(trimmedCard.notes.map((n) => [n.isButton, n.tool, n.row])));
  ok("(g) and it names the row its own result came from", trimmedCard.notes.some((n) => n.tool === "terminal" && n.row === "3"), JSON.stringify(trimmedCard.notes.map((n) => [n.tool, n.row])));
  // Press it where it was drawn: no burst wrapper, no store read behind it — the click is the only handle.
  const trimPress = await page.evaluate(() => window.__probe.press("terminal", 3));
  ok("(g) the window's own note presses and reads its result back", trimPress.pressed && trimPress.url.includes("row=3") && trimPress.url.includes("full=1"), trimPress.url);
  ok("(g) and the text that comes back is the fourth result", String(trimPress.fetched || "").includes(terminalResults[3].marker), JSON.stringify(trimPress.fetched));
  ok("(g) the note is replaced by the whole result in its place", String(trimPress.text || "").includes(terminalResults[3].marker) && !String(trimPress.text || "").includes("— click to read"), `${String(trimPress.text || "").length} chars on the console`);

  // (h) the whole turn again, its bursts opened: the store read goes through the real route, and every note is
  // still a control once the rows are in hand.
  await page.evaluate(() => window.__probe.show("full"));
  await page.evaluate(() => window.__probe.openAll());
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  const opened = await page.evaluate(() => ({ grps: window.__probe.grps(), calls: window.__probe.storeCalls(), notes: window.__probe.notes() }));
  ok("(h) opening the bursts read the store through the real route", opened.calls.filter((u) => u.includes("/api/tool-results")).length > 0, JSON.stringify(opened.calls.slice(0, 3)));
  ok("(h) every burst is open", opened.grps.every((g) => g.open), JSON.stringify(opened.grps));
  ok("(h) every note is still a button once the store has landed", opened.notes.every((n) => n.isButton), JSON.stringify(opened.notes.map((n) => [n.tool, n.row])));

  // (i) THE ACCEPTANCE: press several notes on a card with several bursts, and compare what each click fetches
  // with the burst's own command text and with the head drawn above the note that was pressed.
  const pressOrder = [
    ["terminal", 0],
    ["terminal", 1],
    ["patch", 0],
    ["terminal", 3],
  ];
  const pressed = [];
  for (const [tool, row] of pressOrder) {
    // eslint-disable-next-line no-await-in-loop
    pressed.push(await page.evaluate(([t, r]) => window.__probe.press(t, r), [tool, row]));
  }
  const allResults = [...terminalResults, ...patchResults];
  for (let i = 0; i < pressed.length; i++) {
    const [tool, row] = pressOrder[i];
    const one = pressed[i];
    const call = String((one.head && one.head.call) || "");
    const want = allResults.find((r) => call.includes(r.cmd));
    const firstLine = String(one.fetched || "");
    const headFirst = String((one.head && one.head.head && one.head.head[0]) || "").replace(/\s+$/, "");
    check(`(i) ${tool} row ${row}: the request asked for exactly the row the note named`, [one.pressed, one.named.tool, one.named.row, one.url.includes(`row=${row}&full=1`)], [true, tool, String(row), true]);
    ok(`(i) ${tool} row ${row}: the fetched text opens with the marker the burst's own command printed`, Boolean(want) && firstLine === want.marker, `${JSON.stringify(firstLine)} vs ${JSON.stringify(want && want.marker)} (the burst's call line is ${JSON.stringify(call)})`);
    ok(`(i) ${tool} row ${row}: and with the head drawn above the note that was pressed`, headFirst !== "" && firstLine.startsWith(headFirst.slice(0, 60)), JSON.stringify(headFirst));
    ok(`(i) ${tool} row ${row}: the console's ring buffer did not take the result`, one.lines === one.lines0, `${one.lines} lines before and after`);
  }
  ok("(i) notes in different bursts fetched different rows", new Set(pressed.map((p) => `${p.named.tool}#${p.named.row}`)).size === pressed.length, JSON.stringify(pressed.map((p) => `${p.named.tool}#${p.named.row}`)));

  // (j) a repaint keeps the opened results open, and the job's own lines never grew or shrank.
  await page.evaluate(() => window.__probe.repaint());
  const afterRepaint = await page.evaluate(() => ({ text: window.__probe.bodyText(), notes: window.__probe.notes(), lines: window.__probe.lineCount() }));
  ok("(j) a repaint does not fold an opened result back shut", afterRepaint.text.includes(terminalResults[3].marker));
  check("(j) and the job's own lines are untouched by all of it", afterRepaint.lines, SERVER_LINES.length);
  ok("(j) every note left on the card is still a button", afterRepaint.notes.every((n) => n.isButton), JSON.stringify(afterRepaint.notes.map((n) => [n.tool, n.row])));

  // (k) the incremental path is left exactly as it was: a card from BEFORE the stamp existed has notes carrying no
  // identity of their own, and they must still open from the burst's own cursor pairing — with the store loaded,
  // which is the state the live board's own card is in.
  const oldCard = await page.evaluate(() => {
    const n = window.__probe.show("old");
    return { lines: n, notes: window.__probe.notes() };
  });
  check("(k) the old card holds the same lines", oldCard.lines, SERVER_LINES.length);
  ok("(k) a note with no stamp of its own is still a button, from the cursor", oldCard.notes.length === notes.length && oldCard.notes.every((n) => n.isButton), JSON.stringify(oldCard.notes.map((n) => [n.tool, n.row])));
  await page.evaluate(() => window.__probe.openAll());
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  const oldWithStore = await page.evaluate(() => window.__probe.notes());
  check("(k) and it names the same rows the cursor always named", oldWithStore.map((n) => [n.tool, Number(n.row)]), EXPECTED_ROWS);
  const oldPress = await page.evaluate(() => window.__probe.press("terminal", 1));
  ok("(k) pressing one still reads its row back", oldPress.pressed && oldPress.url.includes("row=1") && String(oldPress.fetched || "").includes(terminalResults[1].marker), `${oldPress.url} → ${JSON.stringify(oldPress.fetched)}`);

  // (l) the hardest case, and the one the live measurement was taken in: the note names no tool and no row at all
  // (a card written before the stamp existed, in a burst the window trimmed of its call line). It must stay the
  // honest plain sentence while nothing can name it — and become a button naming the right row as soon as this
  // turn's store read for that tool is in hand, resolved from the HEAD alone.
  const bareCard = await page.evaluate(() => {
    const n = window.__probe.show("trimmed-old");
    return { lines: n, notes: window.__probe.notes() };
  });
  check("(l) the card is the trimmed window with no identity on the note", [bareCard.lines, bareCard.notes.length], [TRIMMED.length, 1]);
  ok("(l) with nothing to name the result by, the note promises nothing", bareCard.notes.every((n) => !n.isButton), JSON.stringify(bareCard.notes));
  const bareResolved = await page.evaluate(() => window.__probe.readStore("terminal"));
  check("(l) a store read for the turn's tool lets the head name the row on its own", bareResolved.map((n) => [n.tool, Number(n.row)]), [["terminal", 3]]);
  const barePress = await page.evaluate(() => window.__probe.press("terminal", 3));
  ok("(l) and the row it names is the row the click fetches", barePress.pressed && String(barePress.fetched || "").includes(terminalResults[3].marker), `${barePress.url} → ${JSON.stringify(barePress.fetched)}`);

  ok("no page errors", pageErrors.length === 0, pageErrors.join(" | ") || "none");
  await browser.close();
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
