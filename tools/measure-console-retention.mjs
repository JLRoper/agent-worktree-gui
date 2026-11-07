// What a long-lived tab keeps, measured on the page itself: the console buffers behind `state.jobLines`, before and
// after the three bounds docs/console-memory-growth.md asks for.
//
//   node tools/measure-console-retention.mjs                      # this working tree
//   node tools/measure-console-retention.mjs --root <export>       # some other tree (a git archive of a base)
//   node tools/measure-console-retention.mjs --json out.json
//
// WHY THIS EXISTS. The document measured 121 driven turns and found 240 console buffers holding 19,982 lines that
// nothing ever released: not the per-thread clear, not "Clear finished", not the panel being replaced. The three
// changes are testable in public/app.js and public/board/console.js (test/console-memory-bounds.test.js does that),
// but a unit test cannot say what a TAB holds. This harness boots a real panel from `--root`, opens the real page,
// and drives the page's own entry points (`appendJobLine`, `applySnapshot`, and the card's own record) with the
// shapes the document measured, reading `state.jobLines` back by name and the heap after a forced GC.
//
// WHAT IS DRIVEN, and why each phase exists:
//   streamed       12 threads x 10 turns, 76 lines each, streamed through `appendJobLine` and then settled with the
//                  last 60 lines as the record's tail - the document's normal turn. Buffers are created by frames.
//   clear-finished the reader's "Clear finished": `applySnapshot({ jobs: [] })`. Measured before this change as 19
//                  buffers and 752 lines left behind; here it is 120 turns.
//   reload-snapshot a snapshot carrying 240 settled records the tab never watched stream, 60-line tails. Every one of
//                  them used to be copied into a second array; the card can read the record instead.
//   many-turns     200 turns, one line each: the per-turn cap says nothing about a tab that has watched hundreds of
//                  turns, which is what the global ceiling is for.
//   cap-probe      one turn streaming 1,290 lines, the document's cap probe: the client's per-turn trim against the
//                  panel's own ring (lib/jobs.js MAX_LINES).
//
// HONEST LIMITS. The load is fabricated in the page (EventSource is stubbed, as in tools/measure-console-soak.mjs)
// and the records are built to the document's line counts, not replayed from a gateway: these are the page's line
// path and its stores, not the wire. Every number is a read-back from the page after `HeapProfiler.collectGarbage`,
// and the panel is proved to be serving THIS tree's public/app.js by hash before any number is taken.
//
// Exit codes: 0 measured; 2 measured nothing (port busy, no Playwright, the page did not paint, wrong tree served);
// 1 the page raised an error.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFakeEventSource, loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const flag = (n) => argv.includes(n);

const ROOT = path.resolve(opt("--root", path.resolve(HERE, "..")));
const PORT = Number(opt("--port", 7391));
const THREADS = Number(opt("--threads", 12));
const TURNS_PER_THREAD = Number(opt("--turns", 10));
const LINES_PER_TURN = Number(opt("--lines", 76));
const RELOAD_TURNS = Number(opt("--reload-turns", 240));
const MANY_TURNS = Number(opt("--many-turns", 200));
const CAP_LINES = Number(opt("--cap-lines", 1290));
const JSON_OUT = opt("--json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

// ---- the sandbox: own config, own jobs store, own HERMES_HOME -----------------------------------------
async function startPanel(port, dir) {
  const cfgPath = path.join(dir, "config.json");
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  const cfg = {
    port,
    host: "127.0.0.1",
    scanRoots: [path.join(dir, "empty-root")],
    threads: 1,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    refreshSeconds: 3600,
    fetchSeconds: 3600,
    reorderSeconds: 0,
    projects: [],
    jobsFile: path.join(dir, "logs", "jobs.json"),
    assistantFile: path.join(dir, "logs", "assistant.json"),
    projectsCacheFile: path.join(dir, "logs", "projects.json"),
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const out = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: cfgPath,
      HERMES_HOME: path.join(dir, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "echo",
      API_SERVER_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(`panel exited before it was ready (${JSON.stringify(exited)}):\n${out.join("")}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`panel did not answer ${base}/api/health within 30 s:\n${out.join("")}`);
    }
    await sleep(100);
  }
  return {
    base,
    dir,
    pid: child.pid,
    log: () => out.join(""),
    async stop() {
      if (!exited) {
        child.kill();
        const until = Date.now() + 5_000;
        while (!exited && Date.now() < until) await sleep(50);
      }
    },
  };
}

// ---- the page-side instrument --------------------------------------------------------------------------
// Everything it calls is the page's own global function, so the work under measurement is the shipped path.
function retentionInit() {
  const state_ = state;
  let lid = 0;
  const words = ["reading", "the", "worktree", "row", "and", "patching", "the", "console", "render", "path"];
  const payload = (i) =>
    `  src/lib/session-${i % 97}.js:${100 + (i % 800)}: output line ${i} of the agent's turn, ${words[i % words.length]} ${words[(i + 3) % words.length]}`;
  const line = (i) => ({ kind: "tool-out", text: payload(i), lid: (lid += 1), at: Date.now() });
  const tailOf = (n, from) => Array.from({ length: n }, (_, k) => line(from + k));

  function mkJob(id, thread, index, status) {
    const started = Date.now() - (index + 1) * 60_000;
    return {
      id,
      thread,
      turn: index + 1,
      status,
      prompt: `turn ${index + 1}`,
      displayPrompt: `turn ${index + 1}`,
      cwd: null,
      worktree: false,
      worktreePath: null,
      projectPath: null,
      ownerPath: null,
      branch: null,
      runId: `run_${id}`,
      startedAt: new Date(started).toISOString(),
      endedAt: status === "running" ? null : new Date(started + 30_000).toISOString(),
      model: "measure/model",
      lines: [],
      artifacts: [],
      attachments: [],
      subagents: [],
      live:
        status === "running"
          ? { events: 1, lastEventAt: started, startedAt: started, seq: 1, stream: "open", streaming: true, tool: null }
          : null,
    };
  }

  const api = {
    ready() {
      return {
        visible: !document.hidden,
        hasAppendJobLine: typeof appendJobLine === "function",
        hasApplySnapshot: typeof applySnapshot === "function",
        hasJobLines: typeof jobLines === "function",
        hasState: Boolean(state_ && state_.jobs && state_.jobLines),
      };
    },
    reset() {
      state_.jobs.clear();
      state_.jobLines.clear();
      state_.jobsListSig = "";
      document.getElementById("jobs").innerHTML = "";
      lid = 0;
      return true;
    },
    // One turn, the way the board gets one: a record, its card, then the run's lines through the page's own path.
    // It settles with the last 60 lines as its tail, which is what /api/jobs would carry for it afterwards.
    turn(id, thread, index, n) {
      const job = mkJob(id, thread, index, "running");
      state_.jobs.set(id, job);
      state_.jobsListSig = "";
      renderJobs();
      const painted = Boolean(document.querySelector(`pre.job-out[data-out="${id}"]`));
      for (let i = 0; i < n; i += 1) {
        const live = { events: i + 1, lastEventAt: Date.now(), startedAt: Date.now(), seq: i + 1, stream: "open", streaming: true, tool: null };
        appendJobLine({ id, line: line(i), live });
        state_.lastEventAt = Date.now();
      }
      const settled = { ...state_.jobs.get(id), status: "done", endedAt: new Date().toISOString(), live: null, lines: tailOf(60, Math.max(0, n - 60)) };
      state_.jobs.set(id, settled);
      updateJob(settled);
      return { id, painted, buffer: (state_.jobLines.get(id) || []).length };
    },
    // A snapshot that lists settled records the tab never watched stream: the reload shape.
    seedSnapshot(count) {
      const jobs = [];
      for (let i = 0; i < count; i += 1) {
        const id = `seed-${String(i).padStart(3, "0")}`;
        const job = mkJob(id, `seed-thread-${i % 12}`, i % 10, "done");
        job.lines = tailOf(60, 1_000 + i * 60);
        jobs.push(job);
      }
      applySnapshot({ jobs });
      return { jobs: state_.jobs.size, buffers: state_.jobLines.size };
    },
    // The reader's "Clear finished": the panel answers with an empty list.
    clearFinished() {
      applySnapshot({ jobs: [] });
      return { jobs: state_.jobs.size, buffers: state_.jobLines.size };
    },
    // One turn with the cap probe's volume, streamed into a record that already exists.
    capProbe(id, n) {
      state_.jobs.set(id, mkJob(id, "cap-thread", 0, "running"));
      state_.jobsListSig = "";
      renderJobs();
      for (let i = 0; i < n; i += 1) {
        const live = { events: i + 1, lastEventAt: Date.now(), startedAt: Date.now(), seq: i + 1, stream: "open", streaming: true, tool: null };
        appendJobLine({ id, line: line(i), live });
        state_.lastEventAt = Date.now();
      }
      return { buffer: (state_.jobLines.get(id) || []).length, newestLid: (state_.jobLines.get(id) || []).slice(-1)[0]?.lid ?? null };
    },
    // What the tab RETAINS: the console buffers by name, the records' own tails, and what a card would draw for a
    // turn whose buffer is gone (the page's own jobLines(), not the harness's idea of it).
    sample(probeId) {
      let jlLines = 0;
      let jlChars = 0;
      let jlMax = 0;
      for (const b of state_.jobLines.values()) {
        jlLines += b.length;
        jlMax = Math.max(jlMax, b.length);
        for (const l of b) jlChars += String(l.text || "").length;
      }
      let tailLines = 0;
      for (const j of state_.jobs.values()) tailLines += (j.lines || []).length;
      return {
        jobs: state_.jobs.size,
        buffers: state_.jobLines.size,
        bufferLines: jlLines,
        bufferChars: jlChars,
        bufferMax: jlMax,
        recordTailLines: tailLines,
        lineSlots: jlLines + tailLines,
        drawnForEvicted: probeId ? jobLines(probeId).length : null,
        consoles: document.querySelectorAll("pre.job-out").length,
        elements: document.getElementsByTagName("*").length,
      };
    },
  };
  window.__MEM = api;
  return api.ready();
}

async function heap(cdp) {
  await cdp.send("HeapProfiler.enable").catch(() => {});
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const r = await cdp.send("Performance.getMetrics");
  const get = (n) => (r.metrics || []).find((m) => m.name === n)?.value ?? null;
  return { heap: get("JSHeapUsedSize"), nodes: get("Nodes"), listeners: get("JSEventListeners") };
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v == null ? "-" : String(v));

function report(rec) {
  const rows = [
    ["phase", "jobs", "buffers", "buffer lines", "record tails", "line slots", "heap"],
    ...rec.samples.map((s) => [
      s.at,
      num(s.jobs),
      num(s.buffers),
      num(s.bufferLines),
      num(s.recordTailLines),
      num(s.lineSlots),
      s.heap == null ? "-" : mb(s.heap),
    ]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log("   " + r.map((c, i) => pad(c, widths[i])).join("  "));
}

// ---- main -----------------------------------------------------------------------------------------------
async function main() {
  if (PORT === 7331) {
    console.error("port 7331 is the reader's live board - this harness needs its own panel (7391 or --port)");
    return 2;
  }
  if (!(await portFree(PORT))) {
    console.error(`port ${PORT} is already in use - binding over a listener is not a measurement`);
    return 2;
  }
  const pw = loadPlaywright();
  if (!pw) {
    console.error(notRun("console retention", "no playwright install found - set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright"));
    return 2;
  }
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-retention-"));
  const panel = await startPanel(PORT, work);
  let browser = null;
  const rec = { root: ROOT, port: PORT, startedAt: new Date().toISOString(), samples: [], phases: {} };
  try {
    const served = await fetch(`${panel.base}/app.js`).then((r) => r.text());
    const servedSha = createHash("sha256").update(served).digest("hex");
    const diskSha = createHash("sha256").update(readFileSync(path.join(ROOT, "public", "app.js"))).digest("hex");
    console.log(`\n== panel ${panel.base} (pid ${panel.pid}), serving ${ROOT}`);
    console.log(`   GET /app.js -> ${served.length} bytes  sha256 ${servedSha.slice(0, 16)}...  disk ${diskSha.slice(0, 16)}...  match: ${servedSha === diskSha}`);
    if (servedSha !== diskSha) throw new Error("the panel served a different public/app.js than --root holds; the numbers would not name this tree");
    rec.appJsSha = servedSha;

    browser = await pw.chromium.launch({ headless: !flag("--headed") });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await installFakeEventSource(page);
    await page.goto(`${panel.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section.project, #jobs", { timeout: 30_000 }).catch(() => {});
    const ready = await page.evaluate(retentionInit);
    if (!ready.hasState || !ready.hasAppendJobLine || !ready.hasApplySnapshot || !ready.hasJobLines) {
      throw new Error(`the page is missing a function this harness drives: ${JSON.stringify(ready)}`);
    }
    if (!ready.visible) throw new Error("the page reports document.hidden - a hidden tab holds whole lines, so this would not be the live path");
    console.log(`   page ready: ${JSON.stringify(ready)}`);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable").catch(() => {});
    const sample = async (at, probeId = null) => {
      const h = await heap(cdp);
      const s = await page.evaluate((id) => window.__MEM.sample(id), probeId);
      const row = { at, ...s, ...h };
      rec.samples.push(row);
      log("sample", `${pad(at, 18)} jobs ${pad(row.jobs, 4)} buffers ${pad(row.buffers, 4)} lines ${pad(row.bufferLines, 6)} tails ${pad(row.recordTailLines, 5)} heap ${h.heap == null ? "-" : mb(h.heap)}`);
      return row;
    };

    // ---- 1. streamed: the document's normal turn, streamed into 120 turns ------------------------------
    const t0 = Date.now();
    await page.evaluate(() => window.__MEM.reset());
    for (let t = 0; t < THREADS; t += 1) {
      for (let i = 0; i < TURNS_PER_THREAD; i += 1) {
        const id = `live-${t}-${i}`;
        const r = await page.evaluate(
          ([jid, thread, idx, n]) => window.__MEM.turn(jid, thread, idx, n),
          [id, `thread-${t}`, i, LINES_PER_TURN],
        );
        // A card paints one open turn at a time (the rest are paged), so only a thread's first turn is proved to
        // have drawn a console here; the others still receive their lines into their own buffer.
        if (i === 0 && !r.painted) throw new Error(`turn ${id} painted no pre.job-out - the card path did not render`);
      }
    }
    rec.phases.streamed = { turns: THREADS * TURNS_PER_THREAD, linesPerTurn: LINES_PER_TURN, ms: Date.now() - t0 };
    const streamed = await sample("streamed");

    // ---- 2. clear finished: the reader's own press ------------------------------------------------------
    const cleared = await page.evaluate(() => window.__MEM.clearFinished());
    rec.phases.clearFinished = cleared;
    const afterClear = await sample("clear-finished");

    // ---- 3. reload shape: a snapshot of settled turns the tab never watched stream ---------------------
    await page.evaluate(() => window.__MEM.reset());
    const seeded = await page.evaluate((n) => window.__MEM.seedSnapshot(n), RELOAD_TURNS);
    rec.phases.reloadSnapshot = seeded;
    await sample("reload-snapshot");

    // ---- 4. many turns: the ceiling on how many buffers a tab holds ------------------------------------
    await page.evaluate(() => window.__MEM.reset());
    const many = await page.evaluate((n) => {
      for (let i = 0; i < n; i += 1) {
        const id = `many-${String(i).padStart(3, "0")}`;
        window.__MEM.turn(id, "many-thread", i, 1);
      }
      return { turns: n };
    }, MANY_TURNS);
    rec.phases.manyTurns = many;
    const manyRow = await sample("many-turns", "many-000");

    // ---- 5. cap probe: one turn with the document's 1,290 lines ----------------------------------------
    const cap = await page.evaluate((n) => window.__MEM.capProbe("cap-probe", n), CAP_LINES);
    rec.phases.capProbe = { streamed: CAP_LINES, ...cap };
    await sample("cap-probe");

    rec.errors = errors;
    if (errors.length) throw new Error(`the page raised: ${errors.slice(0, 3).join(" | ")}`);

    // ---- the answers the document asked for ------------------------------------------------------------
    rec.verdict = {
      clearFinishedReleased: streamed.buffers - afterClear.buffers,
      clearFinishedLinesReleased: streamed.bufferLines - afterClear.bufferLines,
      reloadSnapshotBuffers: seeded.buffers,
      reloadSnapshotJobs: seeded.jobs,
      tabBuffersAtManyTurns: manyRow.buffers,
      evictedTurnStillDraws: manyRow.drawnForEvicted,
      capBuffer: cap.buffer,
      streamedHeap: streamed.heap,
      clearedHeap: afterClear.heap,
    };
    console.log("");
    report(rec);
    console.log("");
    log("answer", `clear finished: ${streamed.buffers} buffers / ${streamed.bufferLines} lines -> ${afterClear.buffers} / ${afterClear.bufferLines}`);
    log("answer", `reload snapshot of ${RELOAD_TURNS} settled turns: ${seeded.buffers} buffers opened (the records' tails are held once, in the records)`);
    log("answer", `after ${MANY_TURNS} turns the tab holds ${manyRow.buffers} buffers; the oldest turn still draws ${manyRow.drawnForEvicted} lines from its record`);
    log("answer", `one turn streamed ${CAP_LINES} lines keeps ${cap.buffer} (newest lid ${cap.newestLid})`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await panel.stop();
    await sleep(300);
    const listening = !(await portFree(PORT));
    rec.teardown = { panelPid: panel.pid, panelListeningAfter: listening };
    console.log(`\nTEARDOWN ${JSON.stringify(rec.teardown)}`);
    if (JSON_OUT) {
      try {
        mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
        writeFileSync(path.resolve(JSON_OUT), JSON.stringify(rec, null, 2), "utf8");
        console.log(`JSON ${path.resolve(JSON_OUT)}`);
      } catch (e) {
        // Never let the record's own write hide the measurement's failure: the error above is the one that matters.
        console.error(`could not write ${JSON_OUT}: ${e && e.message}`);
      }
    }
    if (!flag("--keep")) {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        /* a sandbox left behind is not a failed measurement */
      }
    }
    if (listening) {
      console.error(`port ${PORT} is still listening after teardown`);
      return 1;
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`FAILED ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
