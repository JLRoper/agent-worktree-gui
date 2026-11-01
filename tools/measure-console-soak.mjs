// Does a long session leak, or slow down? An accelerated soak of the board's live path, on its own panel.
//
//   node tools/measure-console-soak.mjs                       # a day's event volume, spread over 12 turns, then one long turn
//   node tools/measure-console-soak.mjs --events 40000        # a shorter day (pilot)
//   node tools/measure-console-soak.mjs --shapes multi        # only the many-turns shape
//   node tools/measure-console-soak.mjs --shapes one          # only the single long turn
//   node tools/measure-console-soak.mjs --json out.json       # the raw record
//
// WHAT IS MEASURED. Four counters per checkpoint, every `--sample-every` events:
//
//   * heap        - CDP Performance.getMetrics JSHeapUsedSize, sampled AFTER a forced full GC
//                   (HeapProfiler.collectGarbage), so the number is what the page RETAINS, not what it
//                   has allocated since the last collection. A soak that only grew garbage reads flat.
//   * DOM nodes   - the same CDP table's Nodes, plus the page's own count of every element and of the
//                   console's children (pre.job-out), because "nodes" at the document level hides
//                   WHERE they are.
//   * listeners   - CDP's JSEventListeners.
//   * retained arrays - the page's own stores, read by name: state.jobLines (entries and total lines),
//                   state.toolStore, state.toolStorePending, state.thinkCache, state.eventWindows,
//                   state.outScrolls / state.outPinned (keyed by turn), state.toolGroupOpen,
//                   state.codeBoxOpen, state.batchCalls.
//
// Cost is measured twice, from opposite sides: each injected batch is timed in the page (page ms/1,000
// events, which includes the layout each append forces by reading pre.scrollHeight), and
// Performance.getMetrics' cumulative ScriptDuration / LayoutDuration / RecalcStyleDuration are read at
// every checkpoint and differenced (browser ms/1,000 events, which includes everything the page did, not
// just the loop). A trend in both is a slowdown; a trend in one only is a property of the instrument.
//
// WHAT IS DRIVEN. The page's OWN entry points, through CDP's Runtime.evaluate: `appendJobLine(evt)` - the
// function core/sse.js's `jobline` handler calls - with the same `live` counter block the server's
// emitLine attaches, and every `--counter-every` events a `job` frame through `updateJob()` (the panel's
// fast event counter path: the card's `live.events`, merged and re-rendered). No line is written into the
// DOM by the harness; every node under measurement is the page's own.
//
// Event mix per `--text-share` / the rest: whole output lines (`tool-out`, one div each - what a terminal
// burst looks like), tool calls (`tool`, a `.tgrp` group), and prose (`text`, one paragraph grown in
// place, `mode: "set"`). Every event stamps `state.lastEventAt`, the line core/sse.js's handler runs, so
// the 30 s safety-net resync never fires mid-window (a resync would rebuild the board and trim the very
// consoles under measurement, which would read as a cap that is not there).
//
// EVENT SOURCE. The page's EventSource is stubbed out (tools/browser.mjs installFakeEventSource), so no
// server frame can arrive to repaint the fabricated cards; the sandbox server has no projects and no
// jobs, so a real stream would carry nothing but heartbeats. This is the house pattern for a card
// fabricated in the page's own state (tools/verify-console-boxes.mjs) and it is stated in the report: the
// numbers describe the page's line path, not the wire.
//
// THE TWO SHAPES, and why both:
//   multi  A day's traffic as it really arrives: `--turns` turns on ONE conversation, each created when
//          its window opens (a `job` frame's own `updateJob()` + renderJobs() paint), each streaming its
//          share of the events. TURNS_PER_PAGE is 5 (public/app.js), so past the fifth turn the card
//          rebuilds and pages to the newest five.
//   one    The whole volume into ONE turn: the shape a marathon agent run has, where no turn boundary
//          ever rebuilds the console underneath it.
// A cap that only exists at a turn boundary is invisible in `one` and shows up in `multi`; a leak that
// grows per turn is invisible in `one` and shows up in `multi`. Neither shape alone answers the question.
//
// HEAP SNAPSHOT DIFF. A full HeapProfiler.takeHeapSnapshot before the window and after it, aggregated by
// node (type + constructor name) to count and retained self_size, then differenced. The snapshot is the
// independent check on the page's own counters: if the counters say the console grew by N divs, the diff
// must show N more HTMLDivElement. An allocation profile (startSampling/stopSampling) is taken over the
// same window and names the call frames that did the allocating, in case the snapshot's constructor name
// is too generic to be useful.
//
// SERVER SIDE. The brief's other candidate is the job store's own line array (lib/jobs.js MAX_LINES).
// That is Node, not the tab, so it is measured where it lives: a Jobs instance from this tree is handed
// the same 200,000 lines through its own `push()` and its `j.lines.length` is reported. No gateway, no
// file: the store object only.
//
// PORT. 7382, never the reader's live board on 7331 (exit 2 rather than bind over anything). The page is
// proved to be THIS tree's before a number is taken: GET /app.js is hashed and compared with the file on
// disk, and git HEAD is printed beside it.
//
// OTHER OPTIONS. --turns N (the many-turns shape's conversation size), --one-events N (the single-turn
// volume), --batch N (events per Runtime.evaluate), --sample-every N, --counter-every N (job frames per event),
// --text-share 0..1, --line-chars N, --ceiling-min N (stop a shape at a wall clock), --dump (print the card's
// DOM census at every checkpoint), --no-snapshot, --keep (leave the sandbox on disk), --port, --root.
//
// A NOTE ON CDP's Nodes. The metric counts EVERY live node, detached ones included, and after a forced GC it
// reads ~4-5x the page's element count on this page; it is reported as a live-node gauge beside the page's own
// element count, not as "DOM elements". The snapshot's constructor counts are the authoritative DOM numbers.
//
// Exit codes: 0 measured; 2 measured nothing (port busy, no Playwright, the card never painted, the
// window delivered fewer events than asked); 1 the page raised an error.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeEventSource, loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const flag = (n) => argv.includes(n);

const ROOT = path.resolve(opt("--root", path.resolve(HERE, "..")));
const PORT = Number(opt("--port", 7382));
const SHAPES = String(opt("--shapes", "multi,one")).split(",").map((s) => s.trim()).filter(Boolean);
const EVENTS = Number(opt("--events", 200_000));
const ONE_EVENTS = Number(opt("--one-events", 60_000));
const TURNS = Number(opt("--turns", 12));
const BATCH = Number(opt("--batch", 200));
const SAMPLE_EVERY = Number(opt("--sample-every", 5_000));
const COUNTER_EVERY = Number(opt("--counter-every", 10));
const TEXT_SHARE = Number(opt("--text-share", 0.15));
const LINE_CHARS = Number(opt("--line-chars", 80));
const HEADED = flag("--headed");
const SNAPSHOT = !flag("--no-snapshot");
const JSON_OUT = opt("--json");
const DUMP = flag("--dump");
const CEILING_MS = Number(opt("--ceiling-min", 40)) * 60_000;
const WIDTH = 1400;
const HEIGHT = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);
const since = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

function gitOut(cwd, ...args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

// ---- the sandbox (own config, own jobs/projects cache, own HERMES_HOME) ------------------------------
async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function startPanel(port, dir) {
  const cfgPath = path.join(dir, "config.json");
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
  const { spawn } = await import("node:child_process");
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
    port,
    dir,
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

// ---- the page-side instrument -----------------------------------------------------------------------
// Installed once after the page boots, as window.__SOAK. Everything it calls is the page's own global
// function (appendJobLine / updateJob / renderJobs), so the work under measurement is the shipped path.
function soakInit(spec) {
  // `state` and the render/line functions are top-level declarations in a classic script: the functions are
  // window properties, `state` is a lexical binding visible only to the global scope (so `window.state` is
  // undefined even though `state` resolves). Bare identifiers are what the page's own code uses.
  const state_ = state;
  const S = spec;
  const R = {
    seq: 0,
    turns: [],
    cur: null,
    lid: 0,
    paragraph: "",
    paragraphLid: 0,
    kinds: { "tool-out": 0, tool: 0, text: 0 },
    renderJobsCalls: 0,
    visible: !document.hidden,
  };
  // Count every rebuild of the unattached list: a rebuild trims every console back to the 1,000-line
  // buffer, so a shape whose number of rebuilds is not reported cannot say whether a flat DOM is a cap
  // or an absence of work.
  const origRenderJobs = renderJobs;
  globalThis.renderJobs = function (...a) {
    R.renderJobsCalls += 1;
    return origRenderJobs.apply(this, a);
  };
  const words = ["reading", "the", "worktree", "row", "and", "patching", "the", "console", "render",
    "path", "so", "the", "soak", "has", "something", "realistic", "to", "draw", "at", "speed"];
  const payload = (k) => {
    const base = `  src/lib/session-${k % 97}.js:${100 + (k % 800)}: line ${k} of the agent's output, ${words[k % words.length]} ${words[(k + 3) % words.length]}`;
    return base.length > S.lineChars ? base.slice(0, S.lineChars) : base.padEnd(S.lineChars, ".");
  };

  const api = {
    ready() {
      return {
        visible: !document.hidden,
        hasAppendJobLine: typeof appendJobLine === "function",
        hasUpdateJob: typeof updateJob === "function",
        hasRenderJobs: typeof renderJobs === "function" && renderJobs !== origRenderJobs,
        hasState: Boolean(state_ && state_.jobs),
      };
    },
    reset() {
      state_.jobs.clear();
      state_.jobLines.clear();
      state_.toolStore.clear();
      state_.toolGroupOpen.clear();
      state_.codeBoxOpen.clear();
      state_.outPinned = {};
      state_.outScrolls = {};
      state_.jobsListSig = "";
      document.getElementById("jobs").innerHTML = "";
      R.seq = 0;
      R.turns = [];
      R.cur = null;
      R.paragraph = "";
      R.kinds = { "tool-out": 0, tool: 0, text: 0 };
      R.consoleRebuilds = 0;
      // A console that goes away is a console the card REBUILT — the only thing that trims a live console back
      // to its 1,000-line buffer. Counting removals of pre.job-out is what separates "the DOM is capped" from
      // "nothing rebuilt it in this window".
      if (R.obs) R.obs.disconnect();
      R.obs = new MutationObserver((muts) => {
        for (const mu of muts) {
          for (const n of mu.removedNodes || []) {
            if (n.nodeType !== 1) continue;
            const outs = n.matches?.("pre.job-out") ? [n] : [...(n.querySelectorAll?.("pre.job-out") || [])];
            R.consoleRebuilds += outs.length;
          }
        }
      });
      R.obs.observe(document.body, { childList: true, subtree: true });
      return true;
    },
    // One turn of the conversation, created the way a `job` frame creates it: state, then the card list.
    startTurn(index, { live = true } = {}) {
      const thread = "soak-thread";
      const id = `soak-turn-${index}`;
      const started = Date.now() - (S.turns - index) * 60_000;
      const job = {
        id,
        thread,
        turn: index + 1,
        status: live ? "running" : "done",
        prompt: `soak turn ${index + 1}`,
        displayPrompt: `soak turn ${index + 1}`,
        cwd: null,
        worktree: false,
        worktreePath: null,
        projectPath: null,
        ownerPath: null,
        branch: null,
        runId: `run_soak_${index}`,
        startedAt: new Date(started).toISOString(),
        endedAt: live ? null : new Date(started + 30_000).toISOString(),
        model: "soak/model",
        lines: [],
        artifacts: [],
        attachments: [],
        subagents: [],
        live: live ? { events: 0, lastEventAt: started, startedAt: started, seq: 0, stream: "open", streaming: true, tool: null } : null,
      };
      state_.jobs.set(id, job);
      state_.jobsListSig = "";
      window.renderJobs();
      const out = document.querySelector(`pre.job-out[data-out="${id}"]`);
      R.cur = { id, index, startedMs: started, live };
      R.turns.push(id);
      R.paragraph = "";
      R.paragraphLid = ++R.lid;
      return { id, painted: Boolean(out), consoles: document.querySelectorAll("pre.job-out").length };
    },
    // n events through the page's own line path. Timed inside the page, so the number is the page's own
    // work (including the layout each append forces by reading pre.scrollHeight), not the CDP round trip.
    batch(n) {
      if (!R.cur) throw new Error("batch() before startTurn()");
      const t0 = performance.now();
      const S_ = S;
      for (let i = 0; i < n; i += 1) {
        const k = (R.seq += 1);
        let line;
        const r = Math.random();
        if (r < S_.textShare) {
          R.paragraph += (R.paragraph ? " " : "") + words[k % words.length];
          line = { kind: "text", mode: "set", lid: `p${R.paragraphLid}`, text: R.paragraph, at: Date.now() };
          R.kinds.text += 1;
        } else if (r < S_.textShare + 0.05) {
          line = { kind: "tool", text: `💻 terminal · npm test -- --grep "soak ${k}"`, at: Date.now() };
          R.kinds.tool += 1;
        } else {
          line = { kind: "tool-out", text: payload(k), at: Date.now() };
          R.kinds["tool-out"] += 1;
        }
        const now = Date.now();
        const live = { events: k, lastEventAt: now, startedAt: R.cur.startedMs, seq: k, stream: "open", streaming: true, tool: null };
        appendJobLine({ id: R.cur.id, line, live });
        // The line core/sse.js's `jobline` handler runs: it stamps the board's liveness clock, which is what
        // keeps the 30 s safety-net resync from rebuilding the board mid-window.
        state_.lastEventAt = now;
        // The fast event counter: a `job` frame every S_.counterEvery events, through updateJob().
        if (k % S_.counterEvery === 0) {
          const cur = state_.jobs.get(R.cur.id);
          if (cur) updateJob({ ...cur, live });
        }
      }
      return { ms: performance.now() - t0, seq: R.seq, kinds: { ...R.kinds } };
    },
    // Everything the report calls "retained": the page's stores by name, and where the DOM nodes are.
    sample() {
      const outs = [...document.querySelectorAll("pre.job-out")];
      let elems = 0;
      let maxElems = 0;
      let jl = 0;
      let chars = 0;
      for (const o of outs) {
        // The lines are not the console's DIRECT children (the card wraps them in its own body), so the count
        // has to be of everything under it; `childElementCount` reads a flat 3 and hides the whole growth.
        const n = o.getElementsByTagName("*").length;
        elems += n;
        maxElems = Math.max(maxElems, n);
        jl += o.querySelectorAll(".jl").length;
        chars += o.textContent.length;
      }
      let jlLines = 0;
      let jlMax = 0;
      for (const b of state_.jobLines.values()) {
        jlLines += b.length;
        jlMax = Math.max(jlMax, b.length);
      }
      return {
        events: R.seq,
        elements: document.getElementsByTagName("*").length,
        consoles: outs.length,
        consoleElements: elems,
        consoleMaxElements: maxElems,
        consoleLines: jl,
        consoleChars: chars,
        jobLinesEntries: state_.jobLines.size,
        jobLinesLines: jlLines,
        jobLinesMax: jlMax,
        toolStore: state_.toolStore.size,
        toolStorePending: state_.toolStorePending.size,
        thinkCache: state_.thinkCache ? state_.thinkCache.size : null,
        eventWindows: state_.eventWindows ? state_.eventWindows.size : null,
        outScrolls: Object.keys(state_.outScrolls || {}).length,
        outPinned: Object.keys(state_.outPinned || {}).length,
        toolGroupOpen: state_.toolGroupOpen.size,
        codeBoxOpen: state_.codeBoxOpen.size,
        batchCalls: state_.batchCalls ? state_.batchCalls.size : null,
        jobs: state_.jobs.size,
        renderJobsCalls: R.renderJobsCalls,
        consoleRebuilds: R.consoleRebuilds,
        turns: R.turns.length,
      };
    },
    // A census of the fabricated card's own DOM, by class: the answer to "which structure grew" has to name
    // a node the page actually appended, not just a total.
    census() {
      const root = document.querySelector('.job[data-thread="soak-thread"]') || document.getElementById("jobs");
      const by = new Map();
      if (root) {
        for (const el of root.getElementsByTagName("*")) {
          const key = `${el.tagName.toLowerCase()}.${String(el.className || "").split(/\s+/).filter(Boolean).join(".")}`;
          by.set(key, (by.get(key) || 0) + 1);
        }
      }
      const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const outs = [...document.querySelectorAll("pre.job-out")].map((o) => ({
        out: o.dataset.out,
        kids: o.getElementsByTagName("*").length,
        chars: o.textContent.length,
        cls: o.className,
      }));
      return { total: root ? root.getElementsByTagName("*").length : 0, top, outs };
    },
  };
  window.__SOAK = api;
  return api.ready();
}

// ---- CDP plumbing -----------------------------------------------------------------------------------
const METRIC_KEYS = ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "JSEventListeners", "Documents", "LayoutObjects", "Frames", "LayoutCount", "RecalcStyleCount", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"];

async function metrics(cdp) {
  const r = await cdp.send("Performance.getMetrics");
  const out = {};
  for (const m of r.metrics || []) if (METRIC_KEYS.includes(m.name)) out[m.name] = m.value;
  return out;
}

async function heapNodes(cdp, page) {
  await cdp.send("HeapProfiler.enable").catch(() => {});
  await cdp.send("HeapProfiler.collectGarbage");
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  }
  const json = chunks.join("");
  const bytes = json.length;
  if (!json) throw new Error("the heap snapshot came back empty");
  // A page at 50,000 console lines produces a snapshot V8 cannot JSON.parse in this process. Say so rather than
  // dying with an out-of-memory, and keep the counters (which are already in the record) usable.
  if (bytes > 260_000_000) throw new Error(`heap snapshot is ${(bytes / 1048576).toFixed(0)} MB — too large to parse here (--no-snapshot skips it)`);
  const snap = JSON.parse(json);
  const fields = snap.snapshot.meta.node_fields;
  const nameAt = fields.indexOf("name");
  const typeAt = fields.indexOf("type");
  const sizeAt = fields.indexOf("self_size");
  const detachedAt = fields.indexOf("detachedness");
  const stride = fields.length;
  const strings = snap.strings;
  const typeNames = snap.snapshot.meta.node_types[typeAt] || [];
  const byName = new Map();
  let total = 0;
  let detached = 0;
  let count = 0;
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const type = typeNames[snap.nodes[i + typeAt]] || "?";
    const name = strings[snap.nodes[i + nameAt]] || "";
    const size = snap.nodes[i + sizeAt] || 0;
    total += size;
    count += 1;
    if (detachedAt >= 0 && snap.nodes[i + detachedAt] === 1) detached += 1;
    const key = `${type} ${name}`;
    const e = byName.get(key) || { count: 0, size: 0 };
    e.count += 1;
    e.size += size;
    byName.set(key, e);
  }
  return { bytes, total, count, detached, byName };
}

function diffSnapshots(a, b) {
  const out = [];
  for (const [key, e] of b.byName) {
    const prev = a.byName.get(key) || { count: 0, size: 0 };
    const dCount = e.count - prev.count;
    const dSize = e.size - prev.size;
    if (dCount || dSize) out.push({ key, count: e.count, size: e.size, dCount, dSize });
  }
  out.sort((x, y) => y.dSize - x.dSize || y.dCount - x.dCount);
  return out;
}

// ---- the soak itself --------------------------------------------------------------------------------
async function runShape({ shape, events, turns, page, cdp }) {
  const rec = { shape, asked: events, samples: [], batches: [], snapshots: null, sampling: null, rebuilds: 0 };
  const reset = await page.evaluate(() => window.__SOAK.reset());
  if (!reset) throw new Error("reset() failed");
  const ready = await page.evaluate(() => window.__SOAK.ready());
  if (!ready.visible) throw new Error("the page reports document.hidden — a hidden tab holds whole lines, so this would not be the live path");

  // The first turn is created up front so the first baseline is "one painted card, no lines".
  const first = await page.evaluate((i) => window.__SOAK.startTurn(i, { live: true }), 0);
  if (!first.painted) throw new Error("the fabricated turn painted no pre.job-out — the card path did not render");
  rec.consoles = first.consoles;

  let baseMetrics = await metrics(cdp);
  let baseSnap = null;
  let profileStarted = false;
  if (SNAPSHOT) {
    log(shape, "baseline heap snapshot…");
    await cdp.send("HeapProfiler.enable").catch(() => {});
    baseSnap = await heapNodes(cdp, page);
    log(shape, `baseline: ${baseSnap.count} nodes, ${(baseSnap.total / 1048576).toFixed(1)} MB retained, snapshot ${(baseSnap.bytes / 1048576).toFixed(1)} MB`);
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 65536, includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false }).catch(() => {});
    profileStarted = true;
  }

  const sampleNow = async (at) => {
    // A forced full GC first: without it the heap figure is whatever garbage the last batch happened to
    // leave behind, and a leak cannot be told from a slow collector.
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const m = await metrics(cdp);
    const s = await page.evaluate(() => window.__SOAK.sample());
    const row = {
      at,
      events: s.events,
      heap: m.JSHeapUsedSize ?? null,
      nodes: m.Nodes ?? null,
      listeners: m.JSEventListeners ?? null,
      docs: m.Documents ?? null,
      scriptS: m.ScriptDuration ?? null,
      layoutS: m.LayoutDuration ?? null,
      recalcS: m.RecalcStyleDuration ?? null,
      taskS: m.TaskDuration ?? null,
      page: s,
    };
    rec.samples.push(row);
    return row;
  };

  const t0 = Date.now();
  let done = 0;
  let turnIndex = 0;
  let perTurn = shape === "multi" ? Math.ceil(events / Math.max(1, turns)) : events;
  let turnLeft = perTurn;
  await sampleNow(0);
  const tickEvery = Math.max(BATCH, Math.min(SAMPLE_EVERY, 5000));
  let sinceSample = 0;
  while (done < events) {
    if (shape === "multi" && turnLeft <= 0 && turnIndex + 1 < turns) {
      turnIndex += 1;
      const t = await page.evaluate((i) => window.__SOAK.startTurn(i, { live: true }), turnIndex);
      if (!t.painted) throw new Error(`turn ${turnIndex} painted no console`);
      turnLeft = perTurn;
      sinceSample = 0;
      await sampleNow(done);
    }
    const n = Math.min(BATCH, events - done, shape === "multi" ? turnLeft : Infinity);
    const r = await page.evaluate((k) => window.__SOAK.batch(k), n);
    rec.batches.push({ at: done, n, ms: r.ms });
    done += n;
    turnLeft -= n;
    sinceSample += n;
    if (sinceSample >= SAMPLE_EVERY || done >= events) {
      sinceSample = 0;
      const row = await sampleNow(done);
      log(shape, `${String(done).padStart(7)} events · heap ${(row.heap / 1048576).toFixed(2)} MB · nodes ${row.nodes} · listeners ${row.listeners} · console elements ${row.page.consoleElements} (worst ${row.page.consoleMaxElements}, ${row.page.consoleLines} lines) · ${since(t0)}`);
      if (DUMP) {
        const c = await page.evaluate(() => window.__SOAK.census());
        log(shape, `census: ${c.total} elements in the card · ${c.top.map(([k, n]) => `${k}=${n}`).join(" ")}`);
        log(shape, `consoles: ${c.outs.map((o) => `${o.out} ${o.kids} elements, ${o.chars} chars`).join(" · ")}`);
      }
    }
    if (Date.now() - t0 > CEILING_MS) {
      log(shape, `stopping at the ${(CEILING_MS / 60000).toFixed(0)}-minute ceiling`);
      break;
    }
  }
  rec.elapsedMs = Date.now() - t0;
  rec.delivered = done;

  // The final read happens after a forced GC so the heap figure is what is RETAINED.
  for (let i = 0; i < 2; i += 1) await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await sleep(150);
  const end = await sampleNow(done);
  rec.peak = rec.samples.reduce((m, s) => Math.max(m, s.heap || 0), 0);

  if (SNAPSHOT) {
    if (profileStarted) {
      const prof = await cdp.send("HeapProfiler.stopSampling").catch(() => null);
      const tree = prof?.profile?.head;
      const rows = [];
      const walk = (node, stack) => {
        const cf = node.callFrame || {};
        const label = `${cf.functionName || "(anonymous)"} ${String(cf.url || "").replace(/^.*\//, "").replace(/\?.*$/, "")}:${(cf.lineNumber ?? -1) + 1}`;
        if (node.selfSize) rows.push({ fn: label, size: node.selfSize, stack: stack.slice(-2).join(" < ") });
        for (const c of node.children || []) walk(c, [...stack, label]);
      };
      if (tree) walk(tree, []);
      rows.sort((x, y) => y.size - x.size);
      rec.sampling = rows.slice(0, 12);
    }
    log(shape, "final heap snapshot…");
    const endSnap = await heapNodes(cdp, page);
    rec.snapshots = {
      base: { nodes: baseSnap.count, retained: baseSnap.total, bytes: baseSnap.bytes },
      end: { nodes: endSnap.count, retained: endSnap.total, bytes: endSnap.bytes },
      top: diffSnapshots(baseSnap, endSnap).slice(0, 20),
      detached: endSnap.detached,
    };
    log(shape, `snapshot: ${baseSnap.count} -> ${endSnap.count} nodes, retained ${(baseSnap.total / 1048576).toFixed(1)} -> ${(endSnap.total / 1048576).toFixed(1)} MB`);
  }
  rec.rebuilds = end.page.renderJobsCalls;
  rec.end = end;
  rec.base = baseMetrics;
  return rec;
}

// Trend: a least-squares slope of the cost series against events, plus first/last thirds so the reader
// can see whether the growth is steady or a cliff.
function trend(series) {
  const pts = series.filter((p) => Number.isFinite(p.y) && Number.isFinite(p.x) && p.x >= 0);
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const third = Math.max(1, Math.floor(n / 3));
  const head = pts.slice(0, third);
  const tail = pts.slice(-third);
  const avg = (a) => a.reduce((s, p) => s + p.y, 0) / a.length;
  return { slope, first: avg(head), last: avg(tail), n, ratio: avg(head) ? avg(tail) / avg(head) : null };
}

const pct = (a, b) => (b ? `${(((a - b) / b) * 100).toFixed(1)}%` : "n/a");
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

// ---- main -------------------------------------------------------------------------------------------
async function main() {
  if (PORT === 7331) {
    console.error(`port 7331 is the reader's live board — this harness needs its own panel (7382 or --port)`);
    return 2;
  }
  if (!(await portFree(PORT))) {
    console.error(`port ${PORT} is already in use — this run needs its own panel, and binding over a listener is not a measurement`);
    return 2;
  }
  const pw = loadPlaywright();
  if (!pw) {
    console.error(notRun("console soak", "no playwright install found — set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright"));
    return 2;
  }
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-soak-"));
  const panel = await startPanel(PORT, work);
  let ctx = null;
  const errors = [];
  try {
    // The port is the promise; the file behind it is the evidence.
    const rootRes = await fetch(`${panel.base}/`);
    const rootHtml = await rootRes.text();
    const served = await fetch(`${panel.base}/app.js`).then((r) => r.text());
    const servedSha = createHash("sha256").update(served).digest("hex");
    const diskSha = createHash("sha256").update(readFileSync(path.join(ROOT, "public", "app.js"))).digest("hex");
    const head = gitOut(ROOT, "rev-parse", "HEAD");
    const dirty = gitOut(ROOT, "status", "--porcelain");
    const health = await fetch(`${panel.base}/api/health`).then((r) => r.json()).catch(() => null);
    console.log(`\n== panel: ${panel.base} (port ${PORT}, never 7331)`);
    console.log(`   GET / -> ${rootRes.status} (${rootHtml.length} bytes, title "${(/<title>([^<]*)<\/title>/i.exec(rootHtml) || [])[1] || ""}")`);
    console.log(`   GET /app.js -> ${served.length} bytes  sha256 ${servedSha.slice(0, 16)}…`);
    console.log(`   public/app.js on disk      sha256 ${diskSha.slice(0, 16)}…   match: ${servedSha === diskSha}`);
    console.log(`   git HEAD ${head.slice(0, 12)}${dirty ? `  (worktree dirty: ${dirty.split("\n").length} paths)` : "  (clean)"}   health ${JSON.stringify(health)}`);
    if (servedSha !== diskSha) throw new Error(`the panel on ${PORT} served a different public/app.js (${servedSha.slice(0, 12)} vs ${diskSha.slice(0, 12)}) — the numbers would not name this tree`);

    // ---- the server's own line array (lib/jobs.js MAX_LINES), measured where it lives --------------
    const serverSide = await (async () => {
      const { Jobs } = await import(pathToFileURL(path.resolve(ROOT, "lib", "jobs.js")).href);
      const store = new Jobs({ config: {}, onEvent: () => {}, onLog: () => {} });
      const j = { id: "soak", thread: "soak", lines: [], status: "running", startedAt: new Date().toISOString(), live: true, eventCount: 0 };
      const before = process.memoryUsage().heapUsed;
      const t0 = process.hrtime.bigint();
      const N = 200_000;
      for (let i = 0; i < N; i += 1) store.push(j, { kind: "tool-out", text: `line ${i}`, at: Date.now() });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const after = process.memoryUsage().heapUsed;
      return { pushed: N, kept: j.lines.length, ms, heapDelta: after - before };
    })();
    console.log(`\n== server store: ${serverSide.pushed} lines through lib/jobs.js push() on one job`);
    console.log(`   j.lines kept ${serverSide.kept} lines (MAX_LINES) · ${(serverSide.ms / serverSide.pushed * 1000).toFixed(4)} ms/1,000 lines · heapUsed delta ${mb(serverSide.heapDelta)} before GC (allocator noise, not retention)`);

    // ---- the tab ----------------------------------------------------------------------------------
    const profile = path.join(work, "profile");
    mkdirSync(profile, { recursive: true });
    ctx = await pw.chromium.launchPersistentContext(profile, { headless: !HEADED, viewport: { width: WIDTH, height: HEIGHT } });
    ctx.on("page", (p) => p.on("pageerror", (e) => errors.push(String((e && e.message) || e))));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
    await installFakeEventSource(ctx);
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && Boolean(state.jobs), null, { timeout: 30_000 });
    const ready = await page.evaluate(soakInit, { turns: TURNS, textShare: TEXT_SHARE, lineChars: LINE_CHARS, counterEvery: COUNTER_EVERY });
    console.log(`\n== instrument: ${JSON.stringify(ready)}`);
    if (!ready.hasAppendJobLine || !ready.hasUpdateJob) throw new Error("the page has no appendJobLine/updateJob — the shipped line path could not be driven");

    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Performance.enable").catch(() => {});
    await cdp.send("HeapProfiler.enable").catch(() => {});

    const runs = [];
    for (const shape of SHAPES) {
      if (shape !== "multi" && shape !== "one") throw new Error(`unknown shape ${shape}`);
      const events = shape === "multi" ? EVENTS : ONE_EVENTS;
      log(shape, `soak: ${events} events${shape === "multi" ? ` over ${TURNS} turns` : " into ONE turn"}, batch ${BATCH}, sample every ${SAMPLE_EVERY}`);
      const rec = await runShape({ shape, events, turns: TURNS, page, cdp, shapeDir: work });
      runs.push(rec);
    }

    // ---- the report --------------------------------------------------------------------------------
    console.log(`\n== what grew, per 1,000 events`);
    for (const rec of runs) {
      const s = rec.samples;
      const first = s[0];
      const last = s[s.length - 1];
      const span = (last.events - first.events) / 1000;
      const per1k = (a, b) => (span > 0 ? (a - b) / span : NaN);
      const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
      const rows = [
        ["heap (retained, after GC)", mb(first.heap), mb(last.heap), `${num(per1k(last.heap, first.heap), 1)} KB`],
        ["DOM elements (page count)", first.page.elements, last.page.elements, num(per1k(last.page.elements, first.page.elements), 1)],
        ["DOM nodes, live incl. detached (CDP)", first.nodes, last.nodes, num(per1k(last.nodes, first.nodes), 1)],
        ["consoles destroyed by a rebuild", first.page.consoleRebuilds, last.page.consoleRebuilds, num(per1k(last.page.consoleRebuilds, first.page.consoleRebuilds), 3)],
        ["listeners (CDP)", first.listeners, last.listeners, num(per1k(last.listeners, first.listeners), 2)],
        ["consoles painted", first.page.consoles, last.page.consoles, num(per1k(last.page.consoles, first.page.consoles), 3)],
        ["console elements (all boxes)", first.page.consoleElements, last.page.consoleElements, num(per1k(last.page.consoleElements, first.page.consoleElements), 1)],
        ["console elements, worst box", first.page.consoleMaxElements, last.page.consoleMaxElements, num(per1k(last.page.consoleMaxElements, first.page.consoleMaxElements), 1)],
        ["console .jl lines", first.page.consoleLines, last.page.consoleLines, num(per1k(last.page.consoleLines, first.page.consoleLines), 1)],
        ["jobLines entries (turns)", first.page.jobLinesEntries, last.page.jobLinesEntries, num(per1k(last.page.jobLinesEntries, first.page.jobLinesEntries), 2)],
        ["jobLines lines (all turns)", first.page.jobLinesLines, last.page.jobLinesLines, num(per1k(last.page.jobLinesLines, first.page.jobLinesLines), 1)],
        ["jobLines worst buffer", first.page.jobLinesMax, last.page.jobLinesMax, num(per1k(last.page.jobLinesMax, first.page.jobLinesMax), 2)],
        ["toolStore", first.page.toolStore, last.page.toolStore, num(per1k(last.page.toolStore, first.page.toolStore), 2)],
        ["thinkCache", first.page.thinkCache, last.page.thinkCache, num(per1k(last.page.thinkCache, first.page.thinkCache), 2)],
        ["eventWindows", first.page.eventWindows, last.page.eventWindows, num(per1k(last.page.eventWindows, first.page.eventWindows), 2)],
        ["outScrolls keys", first.page.outScrolls, last.page.outScrolls, num(per1k(last.page.outScrolls, first.page.outScrolls), 2)],
        ["outPinned keys", first.page.outPinned, last.page.outPinned, num(per1k(last.page.outPinned, first.page.outPinned), 2)],
        ["toolGroupOpen", first.page.toolGroupOpen, last.page.toolGroupOpen, num(per1k(last.page.toolGroupOpen, first.page.toolGroupOpen), 2)],
        ["renderJobs() calls", first.page.renderJobsCalls, last.page.renderJobsCalls, num(per1k(last.page.renderJobsCalls, first.page.renderJobsCalls), 2)],
      ];
      console.log(`\n-- ${rec.shape}: ${rec.delivered} events in ${(rec.elapsedMs / 1000).toFixed(1)} s (${(rec.delivered / (rec.elapsedMs / 1000)).toFixed(0)} events/s)`);
      console.log(`   ${"counter".padEnd(30)} ${String("start").padStart(12)} ${String("end").padStart(12)} ${String("per 1,000 ev").padStart(12)}`);
      for (const [k, a, b, c] of rows) console.log(`   ${k.padEnd(30)} ${String(a).padStart(12)} ${String(b).padStart(12)} ${String(c).padStart(12)}`);

      // cost: page-side (inside the loop) and browser-side (cumulative counters), both per 1,000 events
      const cost = s.map((r, i) => {
        if (!i) return null;
        const p = s[i - 1];
        const de = r.events - p.events;
        if (!de) return null;
        return {
          at: r.events,
          script: ((r.scriptS - p.scriptS) * 1e6) / de,
          layout: ((r.layoutS - p.layoutS) * 1e6) / de,
          recalc: ((r.recalcS - p.recalcS) * 1e6) / de,
          task: ((r.taskS - p.taskS) * 1e6) / de,
        };
      }).filter(Boolean);
      // page-side: each injected batch is timed on its own, so bucket the batches by the checkpoint they
      // fall inside and average — the same windows the browser counters are differenced over.
      const cps = s.map((r) => r.events);
      const buckets = new Map(cps.map((c) => [c, { ms: 0, n: 0 }]));
      for (const b of rec.batches) {
        // the checkpoint a batch belongs to: the first one at or after the batch's end
        let cp = cps.find((c) => c >= b.at + b.n);
        if (cp == null) cp = cps[cps.length - 1];
        const cell = buckets.get(cp);
        if (!cell) continue;
        cell.ms += b.ms;
        cell.n += b.n;
      }
      const batchSeries = cps.map((c) => {
        const cell = buckets.get(c);
        return { at: c, y: cell && cell.n ? (cell.ms / cell.n) * 1000 : null };
      });
      const tScript = trend(cost.map((c) => ({ x: c.at, y: c.script })));
      const tLayout = trend(cost.map((c) => ({ x: c.at, y: c.layout })));
      const tTask = trend(cost.map((c) => ({ x: c.at, y: c.task })));
      const tPage = trend(batchSeries.map((p) => ({ x: p.at, y: p.y })));
      console.log(`   cost per 1,000 events: script ${cost.length ? cost[0].script.toFixed(0) : "?"} -> ${cost.length ? cost[cost.length - 1].script.toFixed(0) : "?"} ms · layout ${cost.length ? cost[0].layout.toFixed(0) : "?"} -> ${cost.length ? cost[cost.length - 1].layout.toFixed(0) : "?"} ms · task ${cost.length ? cost[0].task.toFixed(0) : "?"} -> ${cost.length ? cost[cost.length - 1].task.toFixed(0) : "?"} ms`);
      if (tPage) console.log(`   page loop ms/1,000 events: first third ${tPage.first.toFixed(0)} -> last third ${tPage.last.toFixed(0)} (${tPage.ratio ? `${((tPage.ratio - 1) * 100).toFixed(0)}%` : "n/a"})`);
      if (tScript) console.log(`   browser script ms/1,000 events: first third ${tScript.first.toFixed(0)} -> last third ${tScript.last.toFixed(0)} (${tScript.ratio ? `${((tScript.ratio - 1) * 100).toFixed(0)}%` : "n/a"})`);
      if (tLayout) console.log(`   browser layout ms/1,000 events: first third ${tLayout.first.toFixed(0)} -> last third ${tLayout.last.toFixed(0)} (${tLayout.ratio ? `${((tLayout.ratio - 1) * 100).toFixed(0)}%` : "n/a"})`);

      if (rec.snapshots) {
        const s0 = rec.snapshots.base;
        const s1 = rec.snapshots.end;
        console.log(`   heap snapshot: ${s0.nodes} -> ${s1.nodes} nodes, retained ${mb(s0.retained)} -> ${mb(s1.retained)} (${pct(s1.retained, s0.retained)}), detached ${rec.snapshots.detached}`);
        console.log(`   top growers by retained size (type + constructor): count delta / size delta`);
        for (const g of rec.snapshots.top.slice(0, 12)) {
          if (g.dSize == null) continue;
          console.log(`     ${g.key.padEnd(46)} ${String(g.dCount > 0 ? `+${g.dCount}` : g.dCount).padStart(9)}  ${(g.dSize >= 0 ? "+" : "") + (g.dSize / 1024).toFixed(0)} KB`);
        }
        if (rec.sampling?.length) {
          console.log(`   allocation profile, top frames by sampled bytes:`);
          for (const a of rec.sampling.slice(0, 6)) console.log(`     ${String((a.size / 1024).toFixed(0)).padStart(7)} KB  ${a.fn}`);
        }
      }
    }

    const out = {
      at: new Date().toISOString(),
      panel: { port: PORT, base: panel.base, head, appSha: servedSha, appShaMatchesDisk: servedSha === diskSha, dirty: Boolean(dirty), health },
      serverSide,
      config: { events: EVENTS, oneEvents: ONE_EVENTS, turns: TURNS, batch: BATCH, sampleEvery: SAMPLE_EVERY, counterEvery: COUNTER_EVERY, textShare: TEXT_SHARE, lineChars: LINE_CHARS, snapshot: SNAPSHOT },
      runs,
      errors,
    };
    if (JSON_OUT) {
      writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 2), "utf8");
      console.log(`\n   raw record: ${path.resolve(JSON_OUT)}`);
    }
    if (errors.length) {
      console.log(`\n!! page errors: ${errors.length}`);
      for (const e of errors.slice(0, 5)) console.log(`   ${e}`);
      return 1;
    }
    const short = runs.filter((r) => r.delivered < r.asked);
    if (short.length) {
      console.log(`\n!! measured nothing complete: ${short.map((r) => `${r.shape} ${r.delivered}/${r.asked}`).join(", ")}`);
      return 2;
    }
    return 0;
  } finally {
    await ctx?.close().catch(() => {});
    await panel.stop();
    if (!flag("--keep")) rmSync(work, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\n!! ${e && e.stack ? e.stack : e}`);
    process.exit(2);
  });
