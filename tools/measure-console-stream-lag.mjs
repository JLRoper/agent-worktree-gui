// Where does a live console's time go, per delta, and what does the tool row's clock cost?
//
//   node tools/measure-console-stream-lag.mjs --label new
//   node tools/measure-console-stream-lag.mjs --root <export> --label base
//
// WHAT IS MEASURED. A panel of its own (tools/panel-testkit.mjs: spare port, own PANEL_CONFIG / HERMES_HOME /
// jobs.json, API_SERVER_KEY empty) from the checkout named by --root, with a stub Runs API that plays a long
// streaming turn over real SSE. One card is spawned through the panel's own POST /api/agents (`existing: true`) and
// pinned into the ONE-STREAM console (`wtgui.stream.<thread>` = "1" written before the spawn, so the card is BUILT
// as a stream), on a 1440x900 page.
//
// The turn has two halves:
//   * a PRELUDE of 20 prose/call/result rounds, sent before anything is measured, so the console is already at its
//     300-line window and the tool rows already exist when the windows start;
//   * a 24 s METRICS window in which text grows at a burst cadence (one delta every 25 ms, which lib/jobs.js
//     coalesces to ~8 frames/s), a tool starts every 2 s and its result lands 1.4 s later, and one five-call parallel
//     burst starts at 9 s. Nothing is read from the page in this window except the probe's own counters: no geometry,
//     no per-frame layout, so the browser's own LayoutCount/RecalcStyleCount are not the harness's.
//   * an 8 s BADGE window in which ONE tool call is in flight and a requestAnimationFrame sampler records, every
//     frame, the row's clock text, the clock's own width, the row's width and the truncation window the target on
//     that row has. This window is separate on purpose: its per-frame getBoundingClientRect IS a forced layout and
//     would land in the metrics if the two shared a window.
//
// WHAT IT REPORTS. CDP Performance.getMetrics across the metrics window (LayoutCount, RecalcStyleCount, their
// durations, ScriptDuration, TaskDuration, Nodes), PerformanceObserver longtask entries plus a requestAnimationFrame
// heartbeat for gaps a paint could not close, a CDP CPU profile (Profiler.start/stop) aggregated to self time per
// function and `file:line`, the page's own per-function call counts and inclusive times for every step of the delta
// path, and the delta-to-frame latency taken on the app's own EventSource listeners. `--json` writes the whole
// record; the report is built from that file.
//
// Exit codes: 0 the run measured something; 2 it did not (no Playwright, no console, no streamed frames); 1 the page
// raised an error.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const LABEL = opt("--label", "new");
const SECONDS = Number(opt("--seconds", 24));
const BADGE_SECONDS = Number(opt("--badge-seconds", 12));
const PRELUDE_ROUNDS = Number(opt("--prelude", 20));
const JSON_OUT = opt("--json");
const KEEP = argv.includes("--keep");
const VIEW_W = 1440;
const VIEW_H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);

// ---- the stub Runs API ----------------------------------------------------------------------------------------------
// Every event the page receives is pushed by a --control call from this harness, so a window boundary is a fact and
// not a guess about a timer's phase. The stream itself is real SSE, so the panel's own lib/jobs.js does the
// translating (120 ms text coalescing included) and the page's own painters draw what is measured.
function makeGateway() {
  const runs = new Map();
  let posts = 0;
  let seq = 0;
  const clients = new Set();
  const push = (evt) => {
    seq += 1;
    const frame = `id: ${seq}\ndata: ${JSON.stringify({ ...evt, seq, timestamp: Date.now() / 1000 })}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        /* a closed client is dropped on its own close event */
      }
    }
    return clients.size;
  };
  const json = (res, code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        version: "console-stream-lag-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      await new Promise((r) => req.on("end", r));
      posts += 1;
      const id = `run_lag_${posts}`;
      runs.set(id, { id, ended: false });
      return json(res, 200, { run_id: id, status: "running" });
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(res, 404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(res, 200, {
        run_id: rec.id,
        status: rec.ended ? "completed" : "running",
        output: "",
        usage: { total_tokens: 12000, input_tokens: 9000, output_tokens: 3000 },
      });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": open\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/control/text" && req.method === "POST") {
      const b = await readBody(req);
      return json(res, 200, { sent: push({ event: "message.delta", run_id: "run_lag_1", delta: String(b.delta || "") }), clients: clients.size });
    }
    if (url.pathname === "/control/tool" && req.method === "POST") {
      const b = await readBody(req);
      return json(res, 200, { sent: push({ event: "tool.started", run_id: "run_lag_1", tool: String(b.tool || "terminal"), preview: String(b.preview || "") }) });
    }
    if (url.pathname === "/control/tool-done" && req.method === "POST") {
      const b = await readBody(req);
      return json(res, 200, {
        sent: push({ event: "tool.completed", run_id: "run_lag_1", tool: String(b.tool || "terminal"), duration: Number(b.duration) || 0.4, preview: String(b.preview || "") }),
      });
    }
    if (url.pathname === "/control/end" && req.method === "POST") {
      const rec = runs.get("run_lag_1");
      if (rec) rec.ended = true;
      return json(res, 200, { sent: push({ event: "run.completed", run_id: "run_lag_1", status: "completed" }) });
    }
    return json(res, 404, {});
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    push,
    close: () =>
      new Promise((r) => {
        for (const res of clients) {
          try {
            res.end();
          } catch {
            /* already gone */
          }
        }
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the wire recorder ------------------------------------------------------------------------------------------------
// Installed BEFORE any page script, so the app's own `new EventSource(...)` is the one that is counted. It records, per
// event type, the frame count and bytes; and for every `jobline` frame the handler's own duration plus the first
// animation frame that follows it - the gap between a delta arriving and the page being able to paint it.
function wireProbe() {
  const W = (window.__wire = { frames: {}, delta: [], rafGaps: [], longs: [], errors: [], started: performance.now() });
  const ES = window.EventSource;
  if (!ES) return;
  function Wrapped(url, opts) {
    const es = new ES(url, opts);
    const add = es.addEventListener.bind(es);
    es.addEventListener = (type, fn, o) => {
      if (typeof fn !== "function") return add(type, fn, o);
      const wrapped = function (e) {
        const t = performance.now();
        let kind = "";
        try {
          const m = /"kind":"([a-z-]+)"/.exec(String((e && e.data) || ""));
          kind = m ? m[1] : "";
        } catch {
          kind = "";
        }
        const rec = W.frames[type] || (W.frames[type] = { n: 0, bytes: 0, ms: 0, max: 0, kinds: {} });
        rec.n += 1;
        rec.bytes += String((e && e.data) || "").length;
        if (kind) rec.kinds[kind] = (rec.kinds[kind] || 0) + 1;
        try {
          return fn.call(es, e);
        } finally {
          const d = performance.now() - t;
          rec.ms += d;
          if (d > rec.max) rec.max = d;
          if (type === "jobline") {
            const slot = { t, d, kind, bytes: String((e && e.data) || "").length };
            if (W.delta.length < 8000) W.delta.push(slot);
            requestAnimationFrame(() => {
              if (W.delta.length < 8000) W.delta.push({ mark: "raf", at: performance.now(), wait: performance.now() - t, kind, d });
            });
          }
        }
      };
      return add(type, wrapped, o);
    };
    return es;
  }
  Wrapped.prototype = ES.prototype;
  Wrapped.CONNECTING = 0;
  Wrapped.OPEN = 1;
  Wrapped.CLOSED = 2;
  window.EventSource = Wrapped;
  // A frame the page could not paint is a gap in this heartbeat; long tasks are kept beside it because
  // PerformanceObserver('longtask') is not guaranteed to emit in headless Chromium and a bare null is not a reading.
  let last = 0;
  const beat = (ts) => {
    if (last && ts - last >= 20 && W.rafGaps.length < 4000) W.rafGaps.push(Math.round(ts - last));
    last = ts;
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (W.longs.length < 2000) W.longs.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* no longtask support: the heartbeat is the reading */
  }
  window.addEventListener("error", (e) => W.errors.push(String((e && e.message) || e).slice(0, 200)));
  // A timer's callback is captured BY REFERENCE at registration, so wrapping `window.tickLiveClocks` after load never
  // sees the work its interval does. Wrapping setInterval here, before any page script, is what puts a name on the
  // clocks: calls, total and max per registered callback.
  W.timers = {};
  const si = window.setInterval;
  window.setInterval = function (fn, ms, ...args) {
    let wrapped = fn;
    if (typeof fn === "function") {
      const name = fn.name || `(anonymous ${ms}ms)`;
      wrapped = function (...callArgs) {
        const t = performance.now();
        try {
          return fn.apply(this, callArgs);
        } finally {
          const d = performance.now() - t;
          const rec = W.timers[name] || (W.timers[name] = { ms, n: 0, tot: 0, max: 0 });
          rec.n += 1;
          rec.tot += d;
          if (d > rec.max) rec.max = d;
        }
      };
    }
    return si.call(window, wrapped, ms, ...args);
  };
}

// ---- the page-side counter: every step of the delta path, and the DOM churn it causes -------------------------------
function pageProbe() {
  const P = (window.__probe = {
    fn: {},
    missing: [],
    muts: { added: 0, removed: 0, records: 0, tgrp: 0, badge: 0 },
    byTarget: {},
    rowIdentity: { changes: 0, nodes: 0 },
  });
  const now = () => performance.now();
  // A classic script's top-level `function f(){}` is a window property, and its own callers resolve through the global
  // object, so assigning here changes what `drawJobLine(...)` means to the page. A function the build does not have is
  // recorded by name instead of silently skipped.
  const wrap = (name) => {
    const orig = window[name];
    if (typeof orig !== "function") {
      P.missing.push(name);
      return;
    }
    const rec = (P.fn[name] = { n: 0, ms: 0, max: 0, bytes: 0 });
    function wrapped(...args) {
      const t = now();
      // How much text the call was handed, for the two renderers whose cost is the size of their input: a markdown
      // block re-parsed per paint is the shape of anything quadratic in a transcript.
      if (args.length && typeof args[0] === "string") rec.bytes += args[0].length;
      try {
        return orig.apply(this, args);
      } finally {
        const d = now() - t;
        rec.n += 1;
        rec.ms += d;
        if (d > rec.max) rec.max = d;
      }
    }
    try {
      Object.defineProperty(wrapped, "name", { value: name });
    } catch {
      /* a name is cosmetic */
    }
    window[name] = wrapped;
  };
  [
    "appendJobLine",
    "recordJobLine",
    "drawJobLine",
    "drawRowText",
    "paintTypedLines",
    "flushTypeStream",
    "appendProseLine",
    "streamBodyHtml",
    "syncStreamConsole",
    "paintStreamConsole",
    "toolGroupHtml",
    "rebuildToolGroup",
    "consoleMdHtml",
    "consoleBodyHtml",
    "tickLiveClocks",
    "paintCommandFoldMark",
    "clearCommandFoldMark",
    "scheduleCommandFoldMark",
    "cmdCutOffset",
    "updateJob",
    "renderConversation",
    "paintToBottom",
    "setScroll",
    "stickSoon",
    "loadThinking",
    "paintThink",
  ].forEach(wrap);
  P.watch = () => {
    const out = document.querySelector("pre.job-out");
    if (!out || out._probeObserved) return false;
    out._probeObserved = true;
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        P.muts.records += 1;
        let added = 0;
        let removed = 0;
        for (const n of r.addedNodes) added += n.nodeType === 1 ? 1 + (n.querySelectorAll ? n.querySelectorAll("*").length : 0) : 1;
        for (const n of r.removedNodes) removed += n.nodeType === 1 ? 1 + (n.querySelectorAll ? n.querySelectorAll("*").length : 0) : 1;
        P.muts.added += added;
        P.muts.removed += removed;
        const target = r.target && r.target.nodeType === 1 ? r.target : r.target && r.target.parentElement;
        // What the churn landed ON, by the node's own first class: a rebuild that replaces the whole window attributes
        // its nodes to the pieces it replaced, not to a guess in the report.
        const key = target ? `${target.tagName.toLowerCase()}${target.classList && target.classList[0] ? "." + target.classList[0] : ""}` : "?";
        const by = P.byTarget[key] || (P.byTarget[key] = { added: 0, removed: 0, n: 0 });
        by.added += added;
        by.removed += removed;
        by.n += 1;
        if (target && target.closest && target.closest(".tgrp")) P.muts.tgrp += 1;
        if (target && target.classList && (target.classList.contains("tgrp-state") || (target.closest && target.closest(".tgrp-state")))) P.muts.badge += 1;
      }
    });
    mo.observe(out, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "data-live-from"] });
    P.disconnect = () => mo.disconnect();
    return true;
  };
  P.reset = () => {
    for (const k of Object.keys(P.fn)) {
      P.fn[k].n = 0;
      P.fn[k].ms = 0;
      P.fn[k].max = 0;
      P.fn[k].bytes = 0;
    }
    P.muts = { added: 0, removed: 0, records: 0, tgrp: 0, badge: 0 };
    P.byTarget = {};
    if (window.__wire) {
      window.__wire.frames = {};
      window.__wire.delta = [];
      window.__wire.rafGaps = [];
      window.__wire.longs = [];
      window.__wire.errors = [];
      window.__wire.timers = {};
    }
    P.rowIdentity = { changes: 0, nodes: 0 };
    P.since = performance.now();
  };
  return P.missing;
}

// ---- the badge sampler ------------------------------------------------------------------------------------------------
// One reading per FRAME of: the clock's text, the clock's own width and left edge, the row's width, the truncation
// window the row's target has, and the clock node's identity. Per-frame getBoundingClientRect is a forced layout, so
// this runs in its own window and never beside a metrics window.
function badgeProbe(ms) {
  return new Promise((resolve) => {
    // The BUSY tool row's own clock: a `data-live-from` span inside a .tgrp, which is the badge under test. The card's
    // head and the empty-console placeholder carry the same attribute, so the group is what names the row.
    // It is re-resolved EVERY frame on purpose: the first trial found the span detached part-way through a call, because
    // a rebuilding paint replaced the whole row. A sampler that holds the node it found reports a badge that stopped
    // existing; one that re-resolves reports the badge being REPLACED, which is the finding.
    const find = () => {
      const clock = [...document.querySelectorAll("pre.job-out .tgrp [data-live-from]")].pop() || null;
      const row = clock ? clock.closest(".tgrp-row") : null;
      return { clock, row, target: row ? row.querySelector(".tgrp-last") : null };
    };
    const first = find();
    if (!first.clock) return resolve({ found: false });
    const samples = [];
    const seen = new WeakSet();
    let nodes = 0;
    let detaches = 0;
    const t0 = performance.now();
    const tick = () => {
      const t = Math.round(performance.now() - t0);
      const { clock, row, target } = find();
      if (!clock) {
        detaches += 1;
        samples.push({ t, gone: true });
      } else {
        if (!seen.has(clock)) {
          seen.add(clock);
          nodes += 1;
        }
        const c = clock.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        const g = target ? target.getBoundingClientRect() : null;
        samples.push({
          t,
          text: clock.textContent,
          cw: Math.round(c.width * 100) / 100,
          cx: Math.round((c.left - r.left) * 100) / 100,
          rw: Math.round(r.width * 100) / 100,
          tw: g ? Math.round(g.width * 100) / 100 : null,
          cut: target ? target.scrollWidth > target.clientWidth + 1 : null,
          from: clock.dataset.liveFrom || "",
        });
      }
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else finish();
    };
    const finish = () => {
      const texts = [];
      let widthChanges = 0;
      let truncChanges = 0;
      let lastText = null;
      let lastW = null;
      let lastCut = null;
      for (const s of samples) {
        if (s.gone) continue;
        if (s.text !== lastText) {
          if (lastText !== null) texts.push({ t: s.t, from: lastText, to: s.text });
          lastText = s.text;
        }
        if (lastW !== null && Math.abs(s.cw - lastW) > 0.01) widthChanges += 1;
        lastW = s.cw;
        if (lastCut !== null && s.cut !== lastCut) truncChanges += 1;
        lastCut = s.cut;
      }
      const live = samples.filter((s) => !s.gone);
      const widths = live.map((s) => s.cw);
      const first0 = live[0] || {};
      resolve({
        found: true,
        frames: samples.length,
        nodes,
        detaches,
        texts,
        widthChanges,
        truncChanges,
        widthMin: widths.length ? Math.min(...widths) : null,
        widthMax: widths.length ? Math.max(...widths) : null,
        role: first0.from === undefined ? "" : "tgrp-state + jl-live",
        froms: [...new Set(live.map((s) => s.from))].slice(0, 6),
        trace: live.filter((s, i) => i % 4 === 0).slice(0, 160).map((s) => ({ t: s.t, text: s.text, cw: s.cw, cx: s.cx, rw: s.rw, tw: s.tw, cut: s.cut })),
      });
    };
    requestAnimationFrame(tick);
  });
}

// ---- CDP helpers ------------------------------------------------------------------------------------------------------
async function metricsOf(cdp) {
  const r = await cdp.send("Performance.getMetrics");
  const out = {};
  for (const m of r.metrics) out[m.name] = m.value;
  return out;
}

function profileTop(profile, limit = 22) {
  if (!profile || !profile.nodes) return [];
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    if (!node) continue;
    const dt = deltas[i] || 0;
    const f = node.callFrame || {};
    const key = `${f.functionName || "(anonymous)"}@${f.url || ""}:${(f.lineNumber ?? 0) + 1}`;
    const prev = self.get(key) || { key, fn: f.functionName || "(anonymous)", url: f.url || "", line: (f.lineNumber ?? 0) + 1, us: 0, n: 0 };
    prev.us += dt;
    prev.n += 1;
    self.set(key, prev);
  }
  return [...self.values()].sort((a, b) => b.us - a.us).slice(0, limit);
}

// ---- one measured run -------------------------------------------------------------------------------------------------
async function runOnce(pw, { gw, gwPort, work, repo }) {
  const sandbox = await startPanel({
    dir: work,
    root: TREE,
    config: {
      scanRoots: [path.dirname(repo)],
      projects: [],
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      liveSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: repo,
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
    env: { API_SERVER_KEY: "" },
  });
  const port = new URL(sandbox.base).port;
  const out = { tree: TREE, label: LABEL, panelPort: Number(port), panelPid: sandbox.pid, viewport: `${VIEW_W}x${VIEW_H}`, pagePid: null, seconds: SECONDS };
  const browser = await pw.chromium.launch({ headless: true });
  // Playwright exposes no pid; the browser's own CDP does. Quoted in the record so the processes this run started can
  // be named and reaped rather than assumed closed.
  try {
    const bs = await browser.newBrowserCDPSession();
    const info = await bs.send("SystemInfo.getProcessInfo");
    const proc = (info.processInfo || []).find((p) => p.type === "browser");
    out.browserPid = proc ? proc.id : null;
    await bs.detach().catch(() => {});
  } catch {
    out.browserPid = null;
  }
  try {
    const ctx = await browser.newContext({ viewport: { width: VIEW_W, height: VIEW_H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 300)));
    await page.addInitScript(wireProbe);
    // The sandbox has no session store. The 🌊 console wants the reasoning blocks too, and answering this route keeps
    // the sweep's poll from returning a 404 body - the count of POLLS is part of what is measured, not their payload.
    await page.route("**/api/thinking**", (route) => route.fulfill({ json: { blocks: [{ at: Date.now() - 20_000, text: "The console is a fixed height box; the row under test is the one being written." }] } }));
    const requests = [];
    page.on("request", (r) => requests.push({ url: r.url(), at: Date.now() }));

    await page.goto(sandbox.base, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs && state.projects, null, { timeout: 30_000 });

    // The card is BUILT in ONE-STREAM mode: the per-card key is written before the spawn, because that is what the
    // card's build reads (a press afterwards would be a repaint, not the build).
    const thread = `lag-${LABEL}-${Date.now().toString(36)}`;
    await page.evaluate((t) => localStorage.setItem(`wtgui.stream.${t}`, "1"), thread);
    const reveal = () =>
      page.evaluate((p) => {
        const n2 = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const row = [...state.rows.values()].find((r) => n2(r.path) === p);
        if (!row) return false;
        state.expandedProjects.add(row.project);
        state.expanded.add(`${row.project}::${row.path}`);
        renderAll();
        return true;
      }, String(repo).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
    await reveal();
    const spawn = async () => {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `measure the console's stream path, ${thread}`, cwd: repo, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
      return r.job.id;
    };
    const jobId = await spawn();
    out.jobId = jobId;
    out.thread = thread;
    await reveal();
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 60_000 });
    const missing = await page.evaluate(pageProbe);
    out.missingProbes = missing;
    await page.waitForFunction(() => window.__probe && window.__probe.watch && window.__probe.watch(), null, { timeout: 20_000 });

    const control = async (route, body) => {
      const r = await fetch(`http://127.0.0.1:${gwPort}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      return r.json().catch(() => ({}));
    };
    const text = (s) => control("/control/text", { delta: s });
    const tool = (name, preview) => control("/control/tool", { tool: name, preview });
    const toolDone = (name, duration, preview) => control("/control/tool-done", { tool: name, duration, preview });

    const WORDS = "the console is a fixed height box and its content is longer than the box keeping the newest line in view means scrolling to the bottom after every growth a reader who has scrolled up is a reader the panel must not touch the sweep runs on its own clock whether or not the wire is moving".split(" ");
    const lineOfTool = (n) => Array.from({ length: n }, (_, k) => `  ${String(k + 1).padStart(3)} ok  ${WORDS[(k + n) % WORDS.length]} ${WORDS[(k + 3) % WORDS.length]}`).join("\n");
    // A command card: one long single-line payload, which the clamp cannot fit, so the fold marker has to find where the
    // text stops. This is the shape that reaches console.js paintCommandFoldMark.
    const cmdLine = (n) =>
      `\nMESSAGE console | round ${n}: ${Array.from({ length: 90 }, (_, k) => WORDS[(k + n) % WORDS.length]).join(" ")}\n`;

    // ---- PRELUDE: fill the console's 300-line window through the app's own path, before anything is measured ---------
    log(LABEL, `prelude: ${PRELUDE_ROUNDS} rounds into ${thread}`);
    let firstAck = null;
    for (let i = 0; i < PRELUDE_ROUNDS; i++) {
      await text(`\n\nRound ${i + 1}: the call below reads one file and prints what it found, and this sentence is the prose that ends the burst before it.\n`);
      await sleep(30);
      if (i % 5 === 2) {
        await text(cmdLine(i + 1));
        await sleep(30);
      }
      await tool(i % 3 === 0 ? "terminal" : i % 3 === 1 ? "read_file" : "search_files", `docs/round-${i + 1}.md`);
      await sleep(30);
      const ack = await toolDone(i % 3 === 0 ? "terminal" : i % 3 === 1 ? "read_file" : "search_files", 0.2 + (i % 9) / 10, lineOfTool(10) + `\n  round ${i + 1} complete`);
      if (!firstAck) {
        firstAck = ack;
        log(LABEL, `control ack: ${JSON.stringify(ack)}`);
      }
      await sleep(30);
    }
    // One long markdown reply, as a real turn writes one: a heading, prose, a list, a table and a fence, in a single
    // message, so it is ONE md block in the window. A markdown parse per paint is linear in this block's length; a
    // parse per delta is quadratic in it, and this is the block that shows which.
    const bigMd = [
      "## What the console keeps",
      "",
      ...Array.from({ length: 16 }, (_, k) => `Paragraph ${k + 1}: ${Array.from({ length: 22 }, (_, j) => WORDS[(j + k) % WORDS.length]).join(" ")} with **bold ${k}** and \`code ${k}\`.`),
      "",
      "### The rows",
      ...Array.from({ length: 18 }, (_, k) => `- item ${k + 1}: ${WORDS[(k * 3) % WORDS.length]} ${WORDS[(k * 5 + 1) % WORDS.length]} and a longer tail that wraps in the box`),
      "",
      "| tool | calls | seconds |",
      "| --- | --- | --- |",
      ...Array.from({ length: 10 }, (_, k) => `| read_file | ${k + 1} | ${(k * 0.7 + 0.2).toFixed(2)} |`),
      "",
      "```bash",
      ...Array.from({ length: 12 }, (_, k) => `  npm run test:module lib/thing-${k}.js`),
      "```",
      "",
    ].join("\n");
    await text(`${bigMd}\n`);
    await sleep(120);
    const shapeNow = () =>
      page.evaluate((t) => {
        const out = document.querySelector(`.job[data-thread="${t}"] pre.job-out`);
        if (!out) return { found: false };
        return {
          found: true,
          children: out.children.length,
          rows: out.querySelectorAll(".tgrp-call").length,
          groups: out.querySelectorAll(".tgrp").length,
          ltext: out.querySelectorAll("[data-ltext]").length,
          cmd: out.querySelectorAll(".code-box.is-cmd").length,
          clamped: out.querySelectorAll(".code-box.is-cmd.is-clamped").length,
          marked: out.querySelectorAll(".code-fold-dots").length,
          text: out.textContent.replace(/\s+/g, " ").slice(0, 120),
          lines: (typeof state !== "undefined" && state.jobLines.get(document.querySelector(`.job[data-thread="${t}"]`)?.dataset.thread || "") || []).length,
        };
      }, thread);
    try {
      await page.waitForFunction(
        (t) => {
          const out = document.querySelector(`.job[data-thread="${t}"] pre.job-out`);
          return Boolean(out && out.querySelectorAll("[data-ltext]").length >= 150 && out.querySelectorAll(".tgrp-call").length >= 10);
        },
        thread,
        { timeout: 25_000 },
      );
    } catch {
      log(LABEL, `prelude did not reach the window: ${JSON.stringify(await shapeNow())}`);
    }
    const preShape = await page.evaluate((t) => {
      const out = document.querySelector(`.job[data-thread="${t}"] pre.job-out`);
      return {
        pieces: out.children.length,
        rows: out.querySelectorAll(".tgrp-call").length,
        groups: out.querySelectorAll(".tgrp").length,
        lines: out.querySelectorAll("[data-ltext]").length,
        scrollH: out.scrollHeight,
        clientH: out.clientHeight,
        bars: out.scrollHeight > out.clientHeight + 4,
        visible: document.visibilityState,
      };
    }, thread);
    out.preludeShape = preShape;
    log(LABEL, `prelude shape: ${JSON.stringify(preShape)}`);
    await sleep(1500);

    // ---- SILENCE window: the wire says nothing for three seconds ---------------------------------------------
    // Whatever still runs here runs on the page's own clocks, with no delta to react to and no tool row to change. It
    // isolates anything that feeds itself - a rebuild that re-triggers the observer that ordered it.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
    await page.evaluate(() => window.__probe.reset());
    const q0 = await metricsOf(cdp);
    await sleep(3000);
    const q1 = await metricsOf(cdp);
    const quiet = await page.evaluate(() => {
      const P = window.__probe;
      const W = window.__wire;
      return {
        fn: P.fn,
        muts: P.muts,
        timers: W.timers,
        frames: W.frames,
        rafGaps: W.rafGaps.length,
        cmdBoxes: document.querySelectorAll("pre.job-out .code-box.is-cmd").length,
        dots: document.querySelectorAll("pre.job-out .code-fold-dots").length,
      };
    });
    out.silence = {
      seconds: 3,
      perf: {
        LayoutCount: q1.LayoutCount - q0.LayoutCount,
        LayoutDuration: Math.round((q1.LayoutDuration - q0.LayoutDuration) * 1000 * 100) / 100,
        RecalcStyleCount: q1.RecalcStyleCount - q0.RecalcStyleCount,
        RecalcStyleDuration: Math.round((q1.RecalcStyleDuration - q0.RecalcStyleDuration) * 1000 * 100) / 100,
        ScriptDuration: Math.round((q1.ScriptDuration - q0.ScriptDuration) * 1000 * 100) / 100,
        TaskDuration: Math.round((q1.TaskDuration - q0.TaskDuration) * 1000 * 100) / 100,
        Nodes: q1.Nodes,
      },
      browser: quiet,
    };
    log(LABEL, `silence: ${JSON.stringify(out.silence.perf)}`);
    log(LABEL, `silence fn: ${JSON.stringify(Object.fromEntries(Object.entries(quiet.fn).filter(([, v]) => v.n).map(([k, v]) => [k, [v.n, Math.round(v.ms * 10) / 10]])))}`);
    log(LABEL, `silence cards: ${quiet.cmdBoxes} boxes, ${quiet.dots} marks`);

    // ---- METRICS window ------------------------------------------------------------------------------------------
    await page.evaluate(() => window.__probe.reset());
    const m0 = await metricsOf(cdp);
    await cdp.send("Profiler.start");

    // The text pump: one delta every 25 ms is a burst rate a real agent writes at; lib/jobs.js coalesces growing text
    // on its own 120 ms clock, so the page sees ~8 frames a second whatever this sends.
    let pumping = true;
    let wi = 0;
    const pump = (async () => {
      while (pumping) {
        const w = [WORDS[wi % WORDS.length], WORDS[(wi + 1) % WORDS.length], WORDS[(wi + 2) % WORDS.length]];
        wi += 3;
        await text(w.join(" ") + " ");
        await sleep(25);
      }
    })();
    const startedAt = Date.now();
    const events = [];
    const at = (ms, fn) => setTimeout(fn, ms);
    for (let k = 0; k < Math.floor(SECONDS / 2); k++) {
      at(k * 2000 + 200, () => {
        events.push({ t: Date.now() - startedAt, what: "tool.start" });
        void tool(k % 2 ? "read_file" : "terminal", `src/module-${k}.js`);
      });
      at(k * 2000 + 1600, () => {
        events.push({ t: Date.now() - startedAt, what: "tool.done" });
        void toolDone(k % 2 ? "read_file" : "terminal", 1.1 + (k % 5) / 10, lineOfTool(6) + `\n  ${k} done`);
      });
    }
    // One five-call parallel burst: a group whose rows all arrive in one tick, which is what a rebuild of the group
    // costs when the burst is long.
    at(9000, () => {
      events.push({ t: Date.now() - startedAt, what: "burst.start" });
      for (let b = 0; b < 5; b++) void tool("read_file", `src/burst-${b}.js`);
    });
    at(13000, () => {
      for (let b = 0; b < 5; b++) void toolDone("read_file", 0.4 + b / 10, lineOfTool(3) + `\n  burst ${b}`);
    });
    await sleep(SECONDS * 1000);
    pumping = false;
    await pump.catch(() => {});
    const profile = await cdp.send("Profiler.stop");
    const m1 = await metricsOf(cdp);
    const page1 = await page.evaluate(() => {
      const P = window.__probe;
      const W = window.__wire;
      const raf = W.delta.filter((d) => d.mark === "raf");
      const hand = W.delta.filter((d) => !d.mark);
      const num = (a) => a.map((x) => x.wait ?? x.d).sort((x, y) => x - y);
      const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
      const waits = num(raf).map((x) => Math.round(x * 100) / 100);
      const gaps = W.rafGaps.slice().sort((a, b) => a - b);
      return {
        fn: P.fn,
        muts: P.muts,
        byTarget: Object.entries(P.byTarget)
          .sort((a, b) => b[1].added + b[1].removed - (a[1].added + a[1].removed))
          .slice(0, 10)
          .reduce((acc, [k, v]) => ((acc[k] = v), acc), {}),
        timers: W.timers,
        frames: W.frames,
        rafGaps: { n: gaps.length, p50: pct(gaps, 0.5), p95: pct(gaps, 0.95), max: gaps[gaps.length - 1] || null, over50: gaps.filter((g) => g >= 50).length, over100: gaps.filter((g) => g >= 100).length },
        longs: { n: W.longs.length, total: W.longs.reduce((a, b) => a + b.dur, 0), max: W.longs.reduce((a, b) => Math.max(a, b.dur), 0), top: W.longs.slice().sort((a, b) => b.dur - a.dur).slice(0, 10) },
        deltaToFrame: { n: waits.length, p50: pct(waits, 0.5), p90: pct(waits, 0.9), p99: pct(waits, 0.99), max: waits[waits.length - 1] || null, mean: waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 100) / 100 : null },
        handler: { n: hand.length, mean: hand.length ? Math.round((hand.reduce((a, b) => a + b.d, 0) / hand.length) * 100) / 100 : null, max: hand.length ? Math.round(Math.max(...hand.map((x) => x.d)) * 100) / 100 : null },
        kinds: hand.reduce((acc, d) => ((acc[d.kind || "?"] = (acc[d.kind || "?"] || 0) + 1), acc), {}),
        shape: (() => {
          const out = document.querySelector("pre.job-out");
          return out ? { pieces: out.children.length, rows: out.querySelectorAll(".tgrp-call").length, groups: out.querySelectorAll(".tgrp").length, scrollH: out.scrollHeight, clientH: out.clientHeight } : null;
        })(),
        visibility: document.visibilityState,
      };
    });
    const thinkingPolls = requests.filter((r) => r.url.includes("/api/thinking")).length;
    const statePolls = requests.filter((r) => r.url.includes("/api/state")).length;
    out.metrics = {
      windowSeconds: SECONDS,
      perf: {
        LayoutCount: m1.LayoutCount - m0.LayoutCount,
        LayoutDuration: Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000 * 100) / 100,
        RecalcStyleCount: m1.RecalcStyleCount - m0.RecalcStyleCount,
        RecalcStyleDuration: Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000 * 100) / 100,
        ScriptDuration: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000 * 100) / 100,
        TaskDuration: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000 * 100) / 100,
        Nodes: m1.Nodes,
        JSEventListeners: m1.JSEventListeners,
      },
    };
    out.metrics.browser = page1;
    out.metrics.network = { thinkingPolls, statePolls, total: requests.length };
    out.metrics.profileTop = profileTop(profile.profile, 26).map((f) => ({
      fn: f.fn,
      where: f.url ? `${f.url.replace(/^.*\/public\//, "public/")}:${f.line}` : "",
      ms: Math.round((f.us / 1000) * 100) / 100,
      samples: f.n,
    }));
    out.metrics.events = events.length;
    log(LABEL, `metrics: ${JSON.stringify(out.metrics.perf)}`);
    log(LABEL, `frames: ${JSON.stringify(page1.frames.jobline || {})}`);
    log(LABEL, `muts: ${JSON.stringify(page1.muts)}`);
    log(LABEL, `timers: ${JSON.stringify(page1.timers)}`);
    log(LABEL, `delta: ${JSON.stringify(page1.deltaToFrame)} rafGaps ${JSON.stringify(page1.rafGaps)} longs ${page1.longs.n}/${page1.longs.total}ms`);

    // ---- BADGE window ----------------------------------------------------------------------------------------------
    await page.evaluate(() => window.__probe.reset());
    await tool("terminal", "npm test -- --watch=false");
    await sleep(300);
    const badgePromise = page.evaluate(badgeProbe, BADGE_SECONDS * 1000);
    // Ten seconds in, the clock crosses into two digits, which is where a proportional badge changes width even when
    // its text is only a second longer; the call ends just after so the swap to the duration is in the same trace.
    await sleep(BADGE_SECONDS * 1000 - 1200);
    await toolDone("terminal", 42.7, lineOfTool(4) + "\n  6 passing");
    out.badge = await badgePromise;
    // The finished row: the badge the reader is left with, its width, and the truncation window the target gained when
    // the clock went away. Read once, after the swap, so the numbers are the row's, not the sampler's.
    out.badgeFinal = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("pre.job-out .tgrp-row[data-tgrp-call]")];
      const row = rows[rows.length - 1] || null;
      if (!row) return null;
      const st = row.querySelector(".tgrp-state");
      const tg = row.querySelector(".tgrp-last");
      const r = row.getBoundingClientRect();
      return {
        text: st ? st.textContent : "",
        stateW: st ? Math.round(st.getBoundingClientRect().width * 100) / 100 : null,
        stateX: st ? Math.round((st.getBoundingClientRect().left - r.left) * 100) / 100 : null,
        rowW: Math.round(r.width * 100) / 100,
        targetW: tg ? Math.round(tg.getBoundingClientRect().width * 100) / 100 : null,
        targetCut: tg ? tg.scrollWidth > tg.clientWidth + 1 : null,
        live: row.querySelectorAll("[data-live-from]").length,
      };
    });
    // ---- the fold-marker's own cost, measured directly ----------------------------------------------------------
    // No command card reached this turn (the card path needs a frame this stub does not install), so the marker is
    // measured on a card built to its own shape: a clamped .code-box.is-cmd whose body holds N text rows, laid out in
    // the console's own box. This is a MICRO-measurement, not a turn: it says what one mark costs, not how often a
    // turn asks for one.
    out.foldProbe = await page.evaluate(() => {
      if (typeof paintCommandFoldMark !== "function") return { missing: true };
      const outEl = document.querySelector("pre.job-out");
      if (!outEl) return { missing: true };
      const words = "the prompt is long enough that the clamp cannot show all of it so the marker has to find the row where the text stops and cut there".split(" ");
      const mk = (n) => {
        const box = document.createElement("div");
        box.className = "code-box is-cmd is-clamped";
        box.style.cssText = "max-height:96px;overflow:hidden;position:relative;width:900px";
        const body = document.createElement("div");
        body.className = "code-body";
        body.style.cssText = "max-height:96px;overflow:hidden;padding:6px";
        for (let i = 0; i < n; i++) {
          const d = document.createElement("div");
          d.className = "jl jl-text";
          d.textContent = i === 0 ? `prompt ${Array.from({ length: 40 }, (_, k) => words[k % words.length]).join(" ")}` : Array.from({ length: 16 }, (_, k) => words[(k + i) % words.length]).join(" ");
          body.appendChild(d);
        }
        box.appendChild(body);
        outEl.appendChild(box);
        return box;
      };
      const box = mk(24);
      const n0 = window.__probe.fn.cmdCutOffset ? window.__probe.fn.cmdCutOffset.n : 0;
      const runs = [];
      for (let i = 0; i < 8; i++) {
        const t = performance.now();
        paintCommandFoldMark(box);
        runs.push(performance.now() - t);
      }
      const n1 = window.__probe.fn.cmdCutOffset ? window.__probe.fn.cmdCutOffset.n : 0;
      const marked = box.querySelectorAll(".code-fold-dots").length;
      const textNodes = (() => {
        const w = document.createTreeWalker(box.querySelector(".code-body"), NodeFilter.SHOW_TEXT, null);
        let c = 0;
        while (w.nextNode()) c += 1;
        return c;
      })();
      box.remove();
      runs.sort((a, b) => a - b);
      return {
        runs: runs.map((r) => Math.round(r * 100) / 100),
        p50: Math.round(runs[Math.floor(runs.length / 2)] * 100) / 100,
        max: Math.round(runs[runs.length - 1] * 100) / 100,
        rangeReads: n1 - n0,
        perCall: Math.round(((n1 - n0) / 8) * 10) / 10,
        textNodes,
        marked,
      };
    });
    log(LABEL, `fold: ${JSON.stringify(out.foldProbe)}`);
    // The clock the page keeps on the whole card, and the badge's own node count, are read after the window: the
    // sampler holds only what moved.
    out.badgeWindow = await page.evaluate(() => {
      const P = window.__probe;
      return { tickLiveClocks: P.fn.tickLiveClocks || null, muts: P.muts, clocks: document.querySelectorAll("[data-live-from]").length };
    });
    log(LABEL, `badge: ${out.badge ? `${out.badge.frames} frames, ${out.badge.texts.length} text changes, ${out.badge.widthChanges} width changes, width ${out.badge.widthMin}-${out.badge.widthMax}, nodes ${out.badge.nodes}` : "NOT FOUND"}`);

    await control("/control/end", {});
    await sleep(500);
    await ctx.close().catch(() => {});
    return out;
  } finally {
    await browser.close().catch(() => {});
    await sandbox.stop().catch(() => {});
  }
}

// ---- main -------------------------------------------------------------------------------------------------------------
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log(notRun("console streaming lag", "no Playwright install found"));
  process.exit(2);
}
const work = mkdtempSync(path.join(os.tmpdir(), `wtgui-lag-${LABEL}-`));
const rootsDir = path.join(work, "roots");
const repo = path.join(rootsDir, "fixture");
mkdirSync(path.join(repo, "docs"), { recursive: true });
const git = (args, cwd) => execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
git(["init", "-q", "-b", "main"], repo);
writeFileSync(path.join(repo, "docs", "a.md"), "# Title\n\nbody line\n");
git(["add", "."], repo);
git(["commit", "-q", "-m", "fixture"], repo);

const gw = makeGateway();
const gwPort = await gw.listen();
let record = { label: LABEL, tree: TREE, viewport: `${VIEW_W}x${VIEW_H}`, startedAt: new Date().toISOString(), gwPort };
try {
  record = { ...record, ...(await runOnce(pw, { gw, gwPort, work, repo })) };
  if (JSON_OUT) {
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(record, null, 2), "utf8");
    log(LABEL, `json ${JSON_OUT}`);
  }
  const perf = record.metrics && record.metrics.perf;
  if (!perf || !record.metrics.browser || !record.metrics.browser.frames.jobline || record.metrics.browser.frames.jobline.n < 20) {
    console.log(notRun("console streaming lag", "the turn did not stream enough frames to measure"));
    process.exitCode = 2;
  }
  if (record.errors && record.errors.length) {
    console.log(`[${LABEL}] page errors: ${record.errors.slice(0, 3).join(" | ")}`);
    process.exitCode = 1;
  }
} finally {
  await gw.close().catch(() => {});
  if (!KEEP) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* the OS will clear the temp dir */
    }
  }
}
