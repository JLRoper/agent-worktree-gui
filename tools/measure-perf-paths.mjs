// The four paths a reader actually waits on, timed one at a time, on a seeded store of its own.
//
//   node tools/measure-perf-paths.mjs                 # 200 rows, own panel, own store, own free port
//   node tools/measure-perf-paths.mjs --rows 200 --keep --json <file>
//
// WHAT IT MEASURES, and why each is split the way it is:
//
//   (1) refresh tick        `/api/state` (server + wire) apart from `applySnapshot` (the render pass), on a
//                           board holding 200+ rows, warm and as a wholesale rebuild (`renderAll`).
//   (2) console stream      a real scripted turn through the panel's own Runs-API path — paragraphs whose
//                           markdown markers arrive mid-line, fenced blocks, tool calls — with `drawJobLine`
//                           wrapped so every row append is a sample, and a MutationObserver so the DOM delta
//                           and "did the console get replaced" are facts rather than claims.
//   (3) drag-reorder        50 queued cards, a real pointer drag across all of them, counting
//                           `getBoundingClientRect` reads, DOM moves, frames and long tasks per gesture.
//   (4) SSE with a job live  the panel's own `/api/stream`, read raw on the side, counting frames and bytes
//                           per second by event type while a run is writing; the page's own reader is
//                           counted at the same time.
//
// Every path also reports wall time, the longest single long task (`PerformanceObserver('longtask')`), the
// DOM nodes added, and — for the idle window before any turn runs — which timers call back into the board
// when nothing they depend on has changed.
//
// WHAT IT IS NOT: a gate. It asserts nothing about speed and exits 0 with a table; the numbers belong in a
// report. It never touches the reader's panel: free port, own PANEL_CONFIG, own store, own gateway stub.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, openPage } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const ROWS = Number(opt("--rows", 200));
const KEEP = argv.includes("--keep");
const JSON_OUT = opt("--json", "");
const VIEWPORT = { width: 1440, height: 1000 };
const THREAD = "perf-thread-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const slash = (p) => String(p || "").replace(/\\/g, "/");
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
function stat(a) {
  const s = [...a].filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!s.length) return { n: 0, median: null, p90: null, max: null, sum: null };
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: r2(q(0.5)), p90: r2(q(0.9)), max: r2(s[s.length - 1]), sum: r2(s.reduce((x, y) => x + y, 0)) };
}
const git = (cwd, a, opts = {}) =>
  execFileSync("git", ["-c", "user.name=perf", "-c", "user.email=perf@localhost", "-c", "commit.gpgsign=false", ...a], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...opts,
  });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---- (0) the fixture ------------------------------------------------------------------------------------------
// One repository, `rows` linked worktrees, one branch each. 200 real trees is what the reader's own board is:
// the panel enumerates them with `git worktree list` and scans them, so a fabricated list would measure a
// different program. Built once and reused (`--keep`) because it is ~2 minutes of `git worktree add` on Windows.
function worktreeCount(repo) {
  try {
    return git(repo, ["worktree", "list", "--porcelain"]).split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length;
  } catch {
    return 0;
  }
}

function buildFixture(root, rows) {
  const repo = path.join(root, "perf-repo");
  if (existsSync(path.join(repo, ".git")) && worktreeCount(repo) >= rows + 0) return { repo, built: false };
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# perf fixture\n\nA repo with many worktrees, for a measurement.\n");
  writeFileSync(path.join(repo, "app.js"), "export const answer = 42;\n");
  writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first"]);
  const started = Date.now();
  for (let i = 1; i <= rows; i += 1) {
    git(repo, ["worktree", "add", "-q", "-b", `wt-${i}`, path.join(repo, ".worktrees", `w${i}`), "HEAD"]);
  }
  return { repo, built: true, buildMs: Date.now() - started };
}

// ---- (2)/(4) the scripted turn, over the panel's own Runs API ------------------------------------------------
// A script is [{ at: ms-from-start, evt }]; the gateway stub below walks it on its own clock and writes real SSE.
// The prose is written so the console sees what a real turn produces: paragraphs that grow a few words at a
// time (some carrying `**`/backticks in a LATER delta, which is the row re-parse), fenced blocks as one line
// per row, and tool calls in bursts with results.
function buildTurnScript() {
  const steps = [];
  let t = 250;
  const sayLine = (text, { perDelta = 90, words = 4 } = {}) => {
    const w = text.split(" ");
    for (let i = 0; i < w.length; i += words) {
      steps.push({ at: t, evt: { event: "message.delta", delta: `${i === 0 ? "\n\n" : ""}${w.slice(i, i + words).join(" ")} ` } });
      t += perDelta;
    }
    t += 120;
  };
  const tool = (name, preview, result, { dur = 420, envelope = false } = {}) => {
    steps.push({ at: t, evt: { event: "tool.started", tool: name, preview } });
    t += dur;
    const body = envelope ? JSON.stringify({ output: result, exit_code: 0, error: null }) : result;
    steps.push({ at: t, evt: { event: "tool.completed", tool: name, duration: dur / 1000, error: false, preview: body } });
    t += 160;
  };
  for (let para = 1; para <= 8; para += 1) {
    // The first delta of a paragraph is plain, and the marker lands in a later one: `drawRowText` grows the
    // row's text node until a marker arrives, then re-parses that row. That difference is (2)'s second number.
    sayLine(`Paragraph ${para} reads the console code before changing anything, because a repaint that moves the reader is worse than a slow turn.`);
    sayLine(`Here is the **bold claim ${para}** and an inline \`code span\` that arrives after the plain words it wraps.`);
    if (para % 2 === 0) {
      // A fenced block, one line per row: the console's own appendFenceRow path.
      sayLine("```js");
      for (let i = 0; i < 9; i += 1) sayLine(`const row${i} = paint(${i});`);
      sayLine("```");
    }
    tool("terminal", "git status --short", "M public/app.js\n?? notes.md", { envelope: true });
    tool("read_file", "public/app.js", Array.from({ length: 12 }, (_, i) => `${i + 20}|  const step${i} = ${i};`).join("\n"));
    tool("terminal", "node --test test/*.test.js", "ok 1\nok 2\n# pass 2", { envelope: true, dur: 700 });
  }
  sayLine("That is the turn: eight paragraphs, four fenced blocks and twelve calls.");
  steps.push({ at: t + 300, evt: { event: "run.completed", output: "done", usage: { total_tokens: 4321, input_tokens: 4000, output_tokens: 321 } } });
  return steps;
}

function makeGateway(scriptFactory) {
  const state = { runs: new Map(), posts: 0 };
  const timers = new Set();
  const later = (ms, fn) => {
    const h = setTimeout(() => {
      timers.delete(h);
      fn();
    }, Math.max(0, ms));
    timers.add(h);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "perf-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_perf_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "", script: scriptFactory(), startedAt: null, events: 0 });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, usage: { total_tokens: 4321, input_tokens: 4000, output_tokens: 321 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = state.runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      if (rec.startedAt == null) rec.startedAt = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      const from = Number(req.headers["last-event-id"] ?? url.searchParams.get("last_seq") ?? -1) + 1;
      let idx = Math.max(0, from);
      const walk = () => {
        if (!open || idx >= rec.script.length) return;
        const step = rec.script[idx];
        const due = rec.startedAt + step.at;
        later(due - Date.now(), () => {
          if (!open) return;
          res.write(`id: ${idx}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: idx, timestamp: Date.now() / 1000 })}\n\n`);
          rec.events += 1;
          if (step.evt.event === "run.completed") {
            rec.status = "completed";
            rec.output = step.evt.output;
            later(40, () => res.end());
          }
          idx += 1;
          walk();
        });
      };
      walk();
      return;
    }
    json(404, {});
  });
  return {
    state,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearTimeout(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the panel ------------------------------------------------------------------------------------------------
async function startPanel({ dir, port, scanRoot, gwPort, repo }) {
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const cfgPath = path.join(dir, "config.json");
  const cfg = {
    port,
    host: "127.0.0.1",
    scanRoots: [scanRoot],
    threads: 4,
    // Scans are switched OFF for the measurement window: the boot pass is the only scan, so a refresh tick
    // measures the request and the render instead of competing with git in the background.
    worktreeSeconds: 3600,
    liveSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    registrySeconds: 3600,
    fetchSeconds: -1,
    refreshSeconds: 3600,
    projects: [],
    dataDir: path.join(dir, "data"),
    scratchDir: path.join(dir, "scratch"),
    jobsFile: path.join(logs, "jobs.json"),
    assistantFile: path.join(logs, "assistant.json"),
    projectsCacheFile: path.join(logs, "projects.json"),
    assistant: { enabled: false },
    apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "stub" },
    remoteBranchPolicy: "local-only",
    defaultCwd: repo,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const out = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath, HERMES_HOME: path.join(dir, "hermes"), API_SERVER_KEY: "", PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`panel exited (${child.exitCode}):\n${out.join("")}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > until) throw new Error(`panel never answered /api/health:\n${out.join("")}`);
    await sleep(120);
  }
  return {
    base,
    log: () => out.join(""),
    stop: async () => {
      child.kill();
      for (let i = 0; i < 40 && child.exitCode === null; i += 1) await sleep(100);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

async function stateOf(base) {
  const r = await fetch(`${base}/api/state`);
  return r.json();
}
async function jobsOf(base) {
  const r = await fetch(`${base}/api/jobs`);
  const d = await r.json().catch(() => ({}));
  return Array.isArray(d.jobs) ? d.jobs : [];
}
async function jobCount(base) {
  try {
    return (await jobsOf(base)).length;
  } catch {
    return null;
  }
}
// The newest turn on a thread: a reply adds a second job to the same thread name.
function newestFor(jobs, thread) {
  return jobs
    .filter((j) => (j.thread || j.id) === thread)
    .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0))[0] || null;
}
async function jobStatusOf(base, thread) {
  const j = newestFor(await jobsOf(base), thread);
  return j ? j.status : null;
}
async function waitForJob(base, thread, want, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let s = null;
  for (;;) {
    s = await jobStatusOf(base, thread).catch(() => null);
    if (s && want.includes(String(s))) return s;
    if (Date.now() > until) throw new Error(`timed out waiting for ${thread} to reach ${want.join("|")} (status ${s})`);
    await sleep(250);
  }
}
async function waitForRows(base, want, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = 0;
  for (;;) {
    try {
      const s = await stateOf(base);
      const rows = (s.projects || []).reduce((n, p) => n + (p.worktrees || []).length, 0);
      last = rows;
      if (rows >= want) return { rows, projects: (s.projects || []).length, state: s };
    } catch {
      /* the boot pass may hold the event loop for a moment */
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${want} rows (last saw ${last})`);
    await sleep(400);
  }
}

// A timer's callback is captured BY REFERENCE when `setInterval(fn, ms)` is called, so wrapping `window.tickApprovals`
// later never sees it. This init script runs before any page script: it wraps setInterval itself and records each
// callback by its own `fn.name`, which is how "what runs on a clock when nothing changed" gets a name.
function timerInstrumentation() {
  const si = window.setInterval.bind(window);
  window.__timers = [];
  window.setInterval = function (fn, ms, ...rest) {
    const rec = { name: (fn && fn.name) || "(anonymous)", ms, calls: 0, total: 0, max: 0 };
    window.__timers.push(rec);
    const id = si(function () {
      const t0 = performance.now();
      try {
        return fn.apply(this, arguments);
      } finally {
        rec.calls += 1;
        const d = performance.now() - t0;
        rec.total += d;
        rec.max = Math.max(rec.max, d);
      }
    }, ms, ...rest);
    rec.id = id;
    return id;
  };
}

// The timer list is the honest answer to "what repeats when nothing changed": `fn.name` is the page's own function
// name because the wrapper receives the very function `setInterval` was handed.
//
// ---- instrumentation installed in the page ----------------------------------------------------------------
// Wrappers on the page's own globals: a classic script's `function f(){}` is a property of `window`, so assigning
// over it replaces what the internal callers resolve through the global object. Each sample is one call, with the
// DOM delta the MutationObserver saw between entry and exit.
function installInstrumentation() {
  const P = {
    samples: [],
    long: [],
    mut: { added: 0, removed: 0, records: 0 },
    counters: {},
    windows: {},
    wrapped: [],
  };
  window.__perf = P;

  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      P.mut.records += 1;
      const count = (list) => {
        let n = 0;
        for (const node of list || []) {
          n += 1;
          if (node.nodeType === 1) n += node.querySelectorAll("*").length;
        }
        return n;
      };
      P.mut.added += count(rec.addedNodes);
      P.mut.removed += count(rec.removedNodes);
    }
  });
  for (const sel of ["#jobs", "#projects", "#as-queue"]) {
    const el = document.querySelector(sel);
    if (el) mo.observe(el, { childList: true, subtree: true, characterData: true });
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.long.push({ start: e.startTime, dur: e.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* no longtask support: the field stays empty and the report says so */
  }
  // A frame gap is the reader's own experience of a blocked main thread, and unlike the Long Tasks API it is
  // available in every Chromium this repo is driven with. A gap over 20 ms is a frame the page could not paint.
  P.gaps = [];
  {
    let last = performance.now();
    const beat = () => {
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (gap >= 20) P.gaps.push({ t: now, gap });
      requestAnimationFrame(beat);
    };
    requestAnimationFrame(beat);
  }

  const wrap = (name, hooks = {}) => {
    const orig = window[name];
    if (typeof orig !== "function") return false;
    const w = function (...args) {
      const t0 = performance.now();
      const m0 = { added: P.mut.added, removed: P.mut.removed };
      // The record is pushed BEFORE the call so a hook that reads it later (a microtask, or a nested call's
      // own record landing on top) still names the right sample.
      const rec = { n: name, ms: -1, t: t0, added: 0, removed: 0 };
      P.samples.push(rec);
      if (P.samples.length > 60000) P.samples.splice(0, 10000);
      const extra = hooks.before ? hooks.before(args, rec) : null;
      if (extra) Object.assign(rec, extra);
      try {
        return orig.apply(this, args);
      } finally {
        rec.ms = performance.now() - t0;
        rec.added = P.mut.added - m0.added;
        rec.removed = P.mut.removed - m0.removed;
        if (hooks.after) hooks.after(rec, args);
      }
    };
    window[name] = w;
    P.wrapped.push(name);
    return true;
  };

  // (2) the console: the draw entry point, the row renderer, and the two functions that decide append vs re-parse.
  wrap("drawJobLine", {
    before: (args, rec) => {
      const evt = args[0] || {};
      const line = evt.line || {};
      const id = String(evt.id || "");
      const out = document.querySelector(`pre.job-out[data-out="${CSS.escape(id)}"]`);
      const kidsBefore = out ? out.childElementCount : null;
      const firstBefore = out ? out.firstElementChild : null;
      // The delta this frame actually adds to a text row. `mode: "set"` re-sends the whole row, so the arriving
      // part is what the row is missing — the same slice drawRowText tests for a marker.
      let delta = String(line.text ?? "");
      const lid = line.lid ? String(line.lid) : "";
      if (line.mode === "set" && lid) {
        const row = out ? out.querySelector(`[data-lid="${CSS.escape(lid)}"]`) : null;
        const drawn = row && typeof row._drawn === "string" ? row._drawn : "";
        if (String(line.text ?? "").startsWith(drawn)) delta = String(line.text ?? "").slice(drawn.length);
      }
      rec.outId = id;
      rec.kidsBefore = kidsBefore;
      rec.sameFirstAtEntry = firstBefore;
      return {
        kind: String(line.kind || ""),
        mode: String(line.mode || ""),
        marker: /[*_`[]/.test(delta),
        textChars: delta.length,
      };
    },
    after: (rec) => {
      const o = document.querySelector(`pre.job-out[data-out="${CSS.escape(rec.outId || "")}"]`);
      rec.kidsAfter = o ? o.childElementCount : null;
      rec.sameFirst = Boolean(o && rec.sameFirstAtEntry === o.firstElementChild);
      delete rec.sameFirstAtEntry;
    },
  });
  wrap("drawRowText");
  wrap("appendProseLine");
  wrap("appendJobLine");
  // The row path: a `row` frame's own entry points, so "the console line also repainted the row" is a count and
  // not an inference.
  wrap("queueRow");
  wrap("placeRow");
  // Repaints: if one of these arrives per jobline frame, the whole console is being rebuilt per row.
  wrap("renderConversation");
  wrap("renderJobs");
  wrap("renderProjectRows");
  wrap("renderAll");
  wrap("applySnapshot", {
    // Which path asked for the snapshot: `resync`'s catch-up, the stream's own `snapshot` frame, or a route's post.
    before: () => ({ caller: String(new Error().stack || "").split("\n").slice(2, 4).join(" | ").replace(/\s+/g, " ").slice(0, 160) }),
  });
  wrap("refreshChips");
  wrap("reorder");
  wrap("paintCardMeta");
  // The clocks: what calls back into the board when nothing has changed.
  for (const n of ["tickLiveClocks", "sweepThinking", "tickApprovals", "refreshSubagentRoster", "applyPendingFocus", "tickQuestionClocks", "tickLivenessRanks", "reorderProjects"]) wrap(n);

  P.reset = () => {
    P.samples.length = 0;
    P.long.length = 0;
    P.gaps.length = 0;
    P.mut.added = 0;
    P.mut.removed = 0;
    P.mut.records = 0;
  };
  P.summary = () => {
    const by = {};
    for (const s of P.samples) {
      by[s.n] = by[s.n] || { n: 0, total: 0, max: 0, added: 0, removed: 0 };
      by[s.n].n += 1;
      by[s.n].total += s.ms;
      by[s.n].max = Math.max(by[s.n].max, s.ms);
      by[s.n].added += s.added;
      by[s.n].removed += s.removed;
    }
    return {
      calls: by,
      longMax: P.long.length ? Math.max(...P.long.map((l) => l.dur)) : null,
      longCount: P.long.length,
      longTotal: P.long.reduce((a, l) => a + l.dur, 0),
      frameGapMax: P.gaps.length ? Math.max(...P.gaps.map((g) => g.gap)) : null,
      frameGapCount: P.gaps.length,
      domAdded: P.mut.added,
      domRemoved: P.mut.removed,
    };
  };
  return P.wrapped;
}

// (1) one refresh tick, split: request + wire, JSON parse, render.
async function tick(page) {
  return page.evaluate(async () => {
    const t0 = performance.now();
    const res = await fetch("/api/state");
    const buf = await res.arrayBuffer();
    const t1 = performance.now();
    const doc = JSON.parse(new TextDecoder().decode(buf));
    const t2 = performance.now();
    const rows = (doc.projects || []).reduce((n, p) => n + (p.worktrees || []).length, 0);
    window.applySnapshot(doc);
    const t3 = performance.now();
    // The wire's own accounting: how long the server took to answer, and how long the bytes took to arrive.
    const rt = performance.getEntriesByName(`${location.origin}/api/state`).at(-1) || null;
    return {
      fetchMs: t1 - t0,
      parseMs: t2 - t1,
      renderMs: t3 - t2,
      totalMs: t3 - t0,
      serverWaitMs: rt ? rt.responseStart - rt.requestStart : null,
      downloadMs: rt ? rt.responseEnd - rt.responseStart : null,
      bytes: buf.byteLength,
      encodedBytes: rt ? rt.encodedBodySize : null,
      encoding: res.headers.get("content-encoding") || "identity",
      status: res.status,
      rows,
      projects: (doc.projects || []).length,
      rowEvents: doc.stats ? doc.stats.rowEvents : null,
    };
  });
}

// (4) the panel's SSE, read raw on the side: frames and bytes per event type over a window.
async function readSse(base, ms) {
  const ctrl = new AbortController();
  const t0 = Date.now();
  const out = { ms, bytes: 0, frames: 0, byType: {}, biggest: 0, first: null, snapshotBytes: 0 };
  let res;
  try {
    res = await fetch(`${base}/api/stream`, { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
  } catch (e) {
    return { ...out, error: String(e.message || e) };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.bytes += value.length;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^event: (.+)$/m.exec(frame);
        const type = m ? m[1].trim() : "(none)";
        const len = Buffer.byteLength(frame) + 2;
        out.byType[type] = (out.byType[type] || 0) + 1;
        out.frames += 1;
        out.biggest = Math.max(out.biggest, len);
        if (!out.first) out.first = { type, len };
        if (type === "snapshot" && !out.snapshotBytes) out.snapshotBytes = len;
      }
    }
  } catch {
    /* aborted at the window's end */
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  const elapsed = (Date.now() - t0) / 1000;
  return {
    ...out,
    seconds: r2(elapsed),
    eventsPerSecond: r2((out.frames - (out.byType.snapshot ? 1 : 0)) / elapsed),
    bytesPerSecond: Math.round((out.bytes - (out.snapshotBytes || 0)) / elapsed),
  };
}

// ---- the run -------------------------------------------------------------------------------------------------
const report = { measuredAt: new Date().toISOString(), root: slash(ROOT), rows: ROWS, paths: {} };
let panel = null;
let gateway = null;
const cleanupDirs = [];

try {
  const scratchRoot = opt("--workdir", path.join(os.tmpdir(), "wag", "9e207b2a"));
  const fixtureRoot = path.join(scratchRoot, "fixture");
  const runDir = path.join(scratchRoot, "run");
  mkdirSync(scratchRoot, { recursive: true });

  console.log(`fixture: ${slash(fixtureRoot)} (${ROWS} worktrees)`);
  const fixture = buildFixture(fixtureRoot, ROWS);
  report.fixture = { repo: slash(fixture.repo), built: fixture.built, buildMs: fixture.buildMs || 0, worktrees: worktreeCount(fixture.repo) - 1 };
  console.log(`  ${report.fixture.worktrees} worktree(s)${fixture.built ? ` built in ${r1(fixture.buildMs / 1000)}s` : " (reused)"}`);

  gateway = makeGateway(() => buildTurnScript());
  const gwPort = await gateway.listen();
  const port = await freePort();
  console.log(`panel: http://127.0.0.1:${port} (free port, own store) gateway stub :${gwPort}`);
  if (existsSync(runDir) && !KEEP) rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  panel = await startPanel({ dir: runDir, port, scanRoot: fixtureRoot, gwPort, repo: fixture.repo });

  const booted = Date.now();
  const loaded = await waitForRows(panel.base, ROWS, 300_000);
  report.boot = { ms: Date.now() - booted, rows: loaded.rows, projects: loaded.projects };
  console.log(`  ${loaded.rows} row(s) in ${loaded.projects} project(s) after ${r1(report.boot.ms / 1000)}s`);

  const started = await withBrowser(
    async ({ page }) => {
      await openPage(page, panel.base, { selector: ".topbar", timeout: 60_000 });
      // The board has to be OPEN before anything is timed: a collapsed project draws no rows at all. Wait for the
      // SNAPSHOT to have populated the page's own store (a bare `section.project` can exist a moment before), then
      // expand every project through the page's own toggle — the header button toggles the WHOLE tree and its label
      // depends on folders and cards too, so pressing it blind can fold the very project that was asked for.
      await page.waitForFunction(() => state.projects.size > 0, null, { timeout: 60_000 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.evaluate(() => {
          for (const n of state.projects.keys()) if (!state.expandedProjects.has(n)) toggleProject(n);
        });
        const rows = await page.evaluate(() => document.querySelectorAll("tr.row").length);
        if (rows > 0) break;
        await sleep(400);
      }
      try {
        await page.waitForSelector("section.project tr.row", { timeout: 60_000 });
      } catch (e) {
        const diag = await page.evaluate(() => ({
          sections: document.querySelectorAll("section.project").length,
          roots: [...document.querySelectorAll("section.root-group")].map((g) => ({ root: g.dataset.root, hidden: g.querySelector(".root-body")?.hidden ?? null, rows: g.querySelectorAll("tr.row").length })),
          tbodyRows: [...document.querySelectorAll("[data-tbody]")].map((b) => b.children.length),
          text: (document.body.innerText || "").slice(0, 300),
          // `state` is a top-level `const`: not a window property, but it IS in the global lexical scope a page
          // script's own evaluation resolves, so a probe can read it by name.
          page: {
            rows: state.rows ? state.rows.size : null,
            projects: state.projects ? [...state.projects.keys()] : null,
            expanded: state.expandedProjects ? [...state.expandedProjects] : null,
            tbody: state.tbodyEls ? [...state.tbodyEls.keys()] : null,
            ageDays: typeof ageHideDays === "function" ? ageHideDays() : null,
            hidden: state.rows ? [...state.rows.values()].filter((r) => rowAgeHidden(r)).length : null,
            built: state.rows ? [...state.rows.values()].filter((r) => !rowAgeHidden(r)).length : null,
          },
        }));
        throw new Error(`no row painted: ${JSON.stringify(diag)}\n${String((e && e.message) || e)}`);
      }
      const wrapped = await page.evaluate(installInstrumentation);
      report.instrumented = wrapped;
      // The board has to be expanded and settled before a render is timed: a collapsed project draws no rows.
      const settle = await page.evaluate(async () => {
        const before = Date.now();
        await new Promise((r) => {
          const tick = () => (document.querySelectorAll("tr.row").length >= 1 ? r() : setTimeout(tick, 100));
          tick();
        });
        return { ms: Date.now() - before, rows: document.querySelectorAll("tr.row").length, nodes: document.getElementsByTagName("*").length };
      });
      report.board = settle;

      // ---- (1) the refresh tick -------------------------------------------------------------------------
      const ticks = [];
      await page.evaluate(() => window.__perf.reset());
      for (let i = 0; i < 5; i += 1) {
        const t = await tick(page);
        ticks.push(t);
        await sleep(120);
      }
      const tickSummary = await page.evaluate(() => window.__perf.summary());
      const fullRender = await page.evaluate(() => {
        const t0 = performance.now();
        window.renderAll();
        return performance.now() - t0;
      });
      const nodeCount = await page.evaluate(() => document.getElementsByTagName("*").length);
      report.paths.refresh = {
        ticks,
        fetch: stat(ticks.map((t) => t.fetchMs)),
        serverWait: stat(ticks.map((t) => t.serverWaitMs)),
        download: stat(ticks.map((t) => t.downloadMs)),
        parse: stat(ticks.map((t) => t.parseMs)),
        render: stat(ticks.map((t) => t.renderMs)),
        total: stat(ticks.map((t) => t.totalMs)),
        bytes: ticks[0].bytes,
        encoding: ticks[0].encoding,
        rows: ticks[0].rows,
        domAdded: tickSummary.domAdded,
        domAddedPerTick: Math.round(tickSummary.domAdded / ticks.length),
        renderCalls: tickSummary.calls.renderProjectRows?.n ?? 0,
        longMax: r1(tickSummary.longMax),
        frameGapMax: r1(tickSummary.frameGapMax),
        fullRenderMs: r2(fullRender),
        domNodes: nodeCount,
        rowsInDom: await page.evaluate(() => document.querySelectorAll("tr.row").length),
        nodeHistogram: await page.evaluate(() => {
          // Rows are <tr> plus their detail rows; count what one row costs so a reader can scale it.
          const first = document.querySelector("tr.row");
          return first ? first.querySelectorAll("*").length : null;
        }),
      };

      // ---- the idle window: what repeats when nothing changed -------------------------------------------
      // The board has to be QUIET first: the boot pass is still finishing when the first rows are on screen, and
      // measuring during it counts the scan's own row frames as "idle work". Settle on the store's own row-event
      // counter (it rides in the snapshot), then measure.
      const quiet = await (async () => {
        let last = -1;
        const until = Date.now() + 90_000;
        let stableSince = Date.now();
        for (;;) {
          const ev = (await stateOf(panel.base)).stats?.rowEvents ?? -1;
          if (ev !== last) {
            last = ev;
            stableSince = Date.now();
          } else if (Date.now() - stableSince > 3000) {
            return { rowEvents: ev, quietMs: 3000 };
          }
          if (Date.now() > until) return { rowEvents: last, quietMs: null };
          await sleep(400);
        }
      })();
      const evIdle0 = quiet.rowEvents;
      await page.evaluate(() => {
        window.__perf.reset();
        for (const t of window.__timers) {
          t.calls = 0;
          t.total = 0;
          t.max = 0;
        }
      });
      const idleBefore = { jobs: await jobCount(panel.base) };
      await sleep(10_000);
      const evIdle1 = (await stateOf(panel.base)).stats?.rowEvents ?? null;
      const idle = await page.evaluate(() => ({ ...window.__perf.summary(), timers: window.__timers.map((t) => ({ name: t.name, ms: t.ms, calls: t.calls, total: t.total, max: t.max })) }));
      const idleCalls = Object.entries(idle.calls)
        .map(([n, v]) => ({ n, calls: v.n, ms: r1(v.total), max: r2(v.max), added: v.added }))
        .sort((a, b) => b.calls - a.calls || b.ms - a.ms);
      report.paths.idle = {
        windowSeconds: 10,
        longMax: r1(idle.longMax),
        longCount: idle.longCount,
        frameGapMax: r1(idle.frameGapMax),
        frameGapCount: idle.frameGapCount,
        domAdded: idle.domAdded,
        domRemoved: idle.domRemoved,
        calls: idleCalls,
        serverRowEvents: evIdle1 != null && evIdle0 != null ? evIdle1 - evIdle0 : null,
        quietMs: quiet.quietMs,
        timers: idle.timers.filter((t) => t.calls).map((t) => ({ name: t.name, every: t.ms, calls: t.calls, ms: r1(t.total), max: r2(t.max) })).sort((a, b) => b.ms - a.ms || b.calls - a.calls),
        jobsBefore: idleBefore.jobs,
      };

      // ---- (2) the console stream -----------------------------------------------------------------------
      await page.evaluate(() => window.__perf.reset());
      const evC0 = (await stateOf(panel.base)).stats?.rowEvents ?? null;
      const spawnRes = await fetch(`${panel.base}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "perf: write the long turn", cwd: fixture.repo, existing: true, thread: THREAD }),
      });
      const spawned = await spawnRes.json().catch(() => ({}));
      report.paths.console = { spawnStatus: spawnRes.status, runId: spawned.job?.runId || null, id: spawned.job?.id || null, spawnBody: spawnRes.ok ? undefined : spawned };
      if (!spawnRes.ok) throw new Error(`spawn refused (${spawnRes.status}): ${JSON.stringify(spawned)}`);
      // A run aimed at an existing tree is filed under that tree's ROW, and a row's agents only exist once the
      // row is open — the card is in its `<tr class="detail">`, not in the unattached list. Open it the way the
      // reader does: a press on the row.
      const jobsNow = await jobsOf(panel.base);
      const mine = newestFor(jobsNow, THREAD);
      const owner = mine?.ownerPath || mine?.cwd || null;
      report.paths.console.ownerPath = owner;
      if (owner) {
        const opened = await page.evaluate((o) => {
          const want = String(o).toLowerCase().replace(/\\/g, "/");
          const tr = [...document.querySelectorAll("tr.row")].find((t) => String(t.dataset.key || "").toLowerCase().replace(/\\/g, "/").endsWith(want));
          if (!tr) return false;
          if (!tr.classList.contains("expanded")) tr.click();
          return tr.classList.contains("expanded");
        }, owner);
        report.paths.console.rowOpened = opened;
        await sleep(250);
      }
      await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 30_000 });
      await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`)?.scrollIntoView({ block: "center" }), THREAD);
      const streamStart = Date.now();
      // Wait for the result line, which is the turn's own end, with a ceiling that a stalled stub cannot hang.
      // The status is read off the panel's own route, not the page: `state` is a top-level `const`, so it is not
      // a window property a probe can reach.
      await waitForJob(panel.base, THREAD, ["done", "failed", "interrupted"], 120_000).catch(() => null);
      const wallMs = Date.now() - streamStart;
      await sleep(400);
      const consoleSamples = await page.evaluate(() => window.__perf.samples.filter((s) => s.n === "drawJobLine").map((s) => ({ ...s })));
      const consoleSummary = await page.evaluate(() => window.__perf.summary());
      const consoleState = await page.evaluate((th) => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(th)}"]`);
        const out = card ? card.querySelector("pre.job-out") : null;
        return {
          rows: out ? out.childElementCount : 0,
          nodes: out ? out.querySelectorAll("*").length : 0,
          fences: out ? out.querySelectorAll(".md-fence").length : 0,
          fenceRows: out ? out.querySelectorAll(".md-fence-row, .md-fence-body > *").length : 0,
          toolRows: out ? out.querySelectorAll(".tgrp, .jl-tool").length : 0,
          lines: out ? out.querySelectorAll("[data-lid]").length : 0,
        };
      }, THREAD);
      const textDraws = consoleSamples.filter((s) => s.kind === "text" && s.mode === "set");
      const plainText = textDraws.filter((s) => !s.marker);
      const markerText = textDraws.filter((s) => s.marker);
      const repainters = consoleSamples.filter((s) => (s.removed || 0) > 1 || s.sameFirst === false);
      report.paths.console = {
        ...report.paths.console,
        wallMs,
        drawCalls: consoleSamples.length,
        drawMs: stat(consoleSamples.map((s) => s.ms)),
        plainText: { ...stat(plainText.map((s) => s.ms)), added: stat(plainText.map((s) => s.added)), chars: stat(plainText.map((s) => s.textChars)) },
        markerText: { ...stat(markerText.map((s) => s.ms)), added: stat(markerText.map((s) => s.added)), count: markerText.length },
        perKind: Object.fromEntries(
          [...new Set(consoleSamples.map((s) => s.kind))].map((k) => [k, stat(consoleSamples.filter((s) => s.kind === k).map((s) => s.ms))]),
        ),
        repaints: { calls: repainters.length, of: consoleSamples.length, ms: stat(repainters.map((s) => s.ms)) },
        wraps: Object.entries(consoleSummary.calls).map(([n, v]) => ({ n, calls: v.n, ms: r1(v.total), max: r2(v.max) })).sort((a, b) => b.ms - a.ms),
        longMax: r1(consoleSummary.longMax),
        longCount: consoleSummary.longCount,
        frameGapMax: r1(consoleSummary.frameGapMax),
        frameGapCount: consoleSummary.frameGapCount,
        longTotal: r1(consoleSummary.longTotal),
        domAdded: consoleSummary.domAdded,
        console: consoleState,
        jobStatus: await jobStatusOf(panel.base, THREAD),
        serverRowEvents: evC0 != null ? ((await stateOf(panel.base)).stats?.rowEvents ?? null) - evC0 : null,
        snapshotCalls: await page.evaluate(() => window.__perf.samples.filter((s) => s.n === "applySnapshot").map((s) => ({ ms: s.ms, rows: null, caller: s.caller }))),
      };

      // ---- (4) SSE with a live job running ---------------------------------------------------------------
      // A second turn, so the SSE window has a run writing into it; the console numbers for it are not used.
      await page.evaluate(() => window.__perf.reset());
      const replyRes = await fetch(`${panel.base}/api/agents/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thread: THREAD, text: "perf: the sse window" }),
      });
      const replied = await replyRes.json().catch(() => ({}));
      await sleep(900);
      const evS0 = (await stateOf(panel.base)).stats?.rowEvents ?? null;
      const pageEventsBefore = await page.evaluate(() => ({ joblines: window.__perf.samples.filter((s) => s.n === "appendJobLine").length }));
      const sse = await readSse(panel.base, 10_000);
      const pageAfter = await page.evaluate(() => ({
        joblines: window.__perf.samples.filter((s) => s.n === "appendJobLine").length,
        longMax: window.__perf.summary().longMax,
        longCount: window.__perf.summary().longCount,
        frameGapMax: window.__perf.summary().frameGapMax,
        domAdded: window.__perf.mut.added,
        jobs: document.querySelectorAll(".job[data-thread]").length,
        rate: (document.getElementById("stream-rate") || {}).textContent || "",
        wraps: Object.entries(window.__perf.summary().calls).map(([n, v]) => ({ n, calls: v.n, ms: Math.round(v.total * 10) / 10, max: Math.round(v.max * 100) / 100 })).sort((a, b) => b.ms - a.ms).slice(0, 8),
      }));
      report.paths.sse = {
        replyStatus: replyRes.status,
        runId: replied.job?.runId || replied.runId || null,
        seconds: sse.seconds,
        frames: sse.frames,
        bytes: sse.bytes,
        bytesPerSecond: sse.bytesPerSecond,
        eventsPerSecond: sse.eventsPerSecond,
        byType: sse.byType,
        snapshotBytes: sse.snapshotBytes,
        biggestFrame: sse.biggest,
        pageJoblines: pageAfter.joblines - pageEventsBefore.joblines,
        pageLongMax: r1(pageAfter.longMax),
        pageLongCount: pageAfter.longCount,
        pageFrameGapMax: r1(pageAfter.frameGapMax),
        pageDomAdded: pageAfter.domAdded,
        pageCards: pageAfter.jobs,
        pageRate: pageAfter.rate,
        pageWraps: pageAfter.wraps,
        serverRowEvents: evS0 != null ? ((await stateOf(panel.base)).stats?.rowEvents ?? null) - evS0 : null,
      };

      // ---- (3) the drag across 50 rows ------------------------------------------------------------------
      // The turn from the SSE window is waited out first: a drag timed while another run is writing is a drag
      // plus a stream, and the two numbers would be quoted as one.
      await waitForJob(panel.base, THREAD, ["done", "failed", "interrupted"], 120_000).catch(() => null);
      await sleep(500);
      // 50 queued cards, seeded through the assistant's own queue file, then a real pointer drag from the
      // bottom card to the top. The pane scrolls under the pointer (its edge crawl), so the gesture travels the
      // whole list rather than only the visible part.
      const q = await (await fetch(`${panel.base}/api/assistant/queue?assistantId=assistant-1`)).json();
      const queueFile = q.queue?.file;
      const at = new Date("2026-11-02T09:00:00.000Z").toISOString();
      const tasks = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        title: `queued task ${i + 1} with a title long enough to wrap once`,
        state: "queued",
        owner: "assistant-1",
        createdBy: "reader",
        createdAt: at,
        thread: `perf-q-${i + 1}`,
        threads: [`perf-q-${i + 1}`],
        files: [],
      }));
      if (queueFile) writeFileSync(queueFile, JSON.stringify({ version: 1, nextId: 51, tasks }, null, 2), "utf8");
      // Open the float and its queue sub-tab. The float remembers being open, so press the button only if closed.
      if (!(await page.locator("#assistant").isVisible())) await page.locator("#btn-assistant").click();
      await page.waitForSelector("#assistant", { state: "visible", timeout: 20_000 });
      if (!(await page.locator("#as-queue").isVisible())) {
        if (await page.locator("#as-subtabs").isVisible()) await page.click('#as-subtabs [data-as-subtab="queue"]');
      }
      await page.waitForSelector("#as-queue:not(.hidden)", { timeout: 20_000 });
      await page.waitForFunction(() => document.querySelectorAll("#as-queue .as-task").length >= 50, null, { timeout: 30_000 });
      const drag = await page.evaluate(async () => {
        // Count what a pointer move costs: box reads and DOM moves are the two things queueDragPaint does per move.
        const P = window.__perf;
        const counters = { rects: 0, insertBefore: 0, pointermoves: 0, frames: 0 };
        const rect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function patched() {
          counters.rects += 1;
          return rect.call(this);
        };
        const ib = Node.prototype.insertBefore;
        Node.prototype.insertBefore = function patched(node, ref) {
          counters.insertBefore += 1;
          return ib.call(this, node, ref);
        };
        window.addEventListener("pointermove", () => (counters.pointermoves += 1), true);
        let last = performance.now();
        const gaps = [];
        let raf = 0;
        const loop = () => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          counters.frames += 1;
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        window.__dragCounters = counters;
        window.__dragStop = () => {
          cancelAnimationFrame(raf);
          Element.prototype.getBoundingClientRect = rect;
          Node.prototype.insertBefore = ib;
          gaps.sort((a, b) => a - b);
          return { ...counters, frameMedian: gaps[Math.floor(gaps.length / 2)] || null, frameMax: gaps[gaps.length - 1] || null, gapCount: gaps.length };
        };
        window.__dragLayout = () => {
          // The pane's own edge: the first ancestor of a card that can actually scroll. The rail and the float both
          // scroll in `.as-body`, and a narrow window falls back to the document — measure the one the gesture will
          // crawl, not a guessed selector.
          const card = document.querySelector('#as-queue .as-task[data-as-qrow="50"]');
          let scroller = null;
          for (let n = card?.closest?.('[data-subpane="queue"]')?.parentElement || null; n && n !== document.body; n = n.parentElement) {
            if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
            if (n.scrollHeight <= n.clientHeight + 1) continue;
            scroller = n;
            break;
          }
          if (!scroller) {
            const d = document.scrollingElement;
            if (d && d.scrollHeight > d.clientHeight + 1) scroller = d;
          }
          window.__dragScroller = scroller;
          const box = (id) => {
            const el = document.querySelector(`#as-queue .as-task[data-as-qrow="${id}"] .as-task-body`);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom };
          };
          const sb = scroller ? scroller.getBoundingClientRect() : null;
          return {
            first: box(1),
            last: box(50),
            scroller: sb ? { tag: scroller.tagName, cls: String(scroller.className || "").slice(0, 40), top: sb.top, bottom: sb.bottom } : null,
            scrollTop: scroller ? scroller.scrollTop : null,
            scrollHeight: scroller ? scroller.scrollHeight : null,
            clientHeight: scroller ? scroller.clientHeight : null,
            cards: document.querySelectorAll("#as-queue .as-task").length,
            viewportH: window.innerHeight,
          };
        };
        window.__dragScrollTop = () => (window.__dragScroller ? window.__dragScroller.scrollTop : -1);
        window.__dragScrollTo = (y) => {
          if (window.__dragScroller) window.__dragScroller.scrollTop = y;
        };
        return true;
      });
      // Put #50 in view, press it, travel above #1, and let the pane's edge crawl bring the top into reach.
      await page.evaluate(() => document.querySelector('#as-queue .as-task[data-as-qrow="50"]')?.scrollIntoView({ block: "center" }));
      await sleep(150);
      let layout = await page.evaluate(() => window.__dragLayout());
      const x = Math.round(layout.last.x + layout.last.width / 2);
      const dragStartMs = Date.now();
      await page.mouse.move(x, Math.round(layout.last.top + 14));
      await page.mouse.down();
      await page.mouse.move(x, Math.round(layout.last.top + 14) - 18, { steps: 3 });
      // Crawl: hold the pointer just inside the pane's top edge until the list reaches the top.
      const edgeY = Math.round((layout.scroller ? layout.scroller.top : 0) + 6);
      const crawlStart = Date.now();
      let crawlSteps = 0;
      let scrollTopAfterCrawl = layout.scrollTop;
      for (let i = 0; i < 500; i += 1) {
        await page.mouse.move(x, edgeY, { steps: 1 });
        await sleep(8);
        crawlSteps += 1;
        if (i % 4 !== 3) continue;
        scrollTopAfterCrawl = await page.evaluate(() => window.__dragScrollTop());
        if (scrollTopAfterCrawl <= 0) break;
      }
      const crawlMs = Date.now() - crawlStart;
      layout = await page.evaluate(() => window.__dragLayout());
      const dropY = Math.round(Math.max(layout.scroller ? layout.scroller.top + 8 : 8, layout.first ? layout.first.top + 3 : 8));
      await page.mouse.move(x, dropY, { steps: 6 });
      await page.mouse.up();
      const dragWallMs = Date.now() - dragStartMs;
      await sleep(400);
      const dragCounters = await page.evaluate(() => window.__dragStop());
      const order = await page.evaluate(() =>
        [...document.querySelectorAll("#as-queue .as-task")].filter((e) => e.dataset.asQstate === "queued").map((e) => Number(e.dataset.asQrow)),
      );
      const serverOrder = await (await fetch(`${panel.base}/api/assistant/queue?assistantId=assistant-1`)).json();
      const serverIds = (serverOrder.queue?.tasks || [])
        .slice()
        .sort((a, b) => (Number(a.order) || Number(a.id)) - (Number(b.order) || Number(b.id)) || Number(a.id) - Number(b.id))
        .map((t) => Number(t.id));
      const dragLong = await page.evaluate(() => window.__perf.summary());
      report.paths.drag = {
        seeded: tasks.length,
        cardsInPane: layout.cards,
        wallMs: dragWallMs,
        crawlMs,
        crawlSteps,
        scrollTopAfterCrawl,
        scroller: layout.scroller,
        scrollHeight: layout.scrollHeight,
        viewportH: layout.viewportH,
        rectReads: dragCounters.rects,
        insertBefore: dragCounters.insertBefore,
        pointermoves: dragCounters.pointermoves,
        frames: dragCounters.frames,
        frameMedian: r2(dragCounters.frameMedian),
        frameMax: r2(dragCounters.frameMax),
        longMax: r1(dragLong.longMax),
        longCount: dragLong.longCount,
        domAdded: dragLong.domAdded,
        domRemoved: dragLong.domRemoved,
        rectsPerMove: dragCounters.pointermoves ? r2(dragCounters.rects / dragCounters.pointermoves) : null,
        domOrderTop5: order.slice(0, 5),
        domOrderBottom3: order.slice(-3),
        serverOrderTop5: serverIds.slice(0, 5),
        movedToTop: order[0] === 50 || serverIds[0] === 50,
        wraps: Object.entries(dragLong.calls).map(([n, v]) => ({ n, calls: v.n, ms: r1(v.total), max: r2(v.max) })).sort((a, b) => b.ms - a.ms).slice(0, 8),
      };

      return true;
    },
    { viewport: VIEWPORT, headless: true, initScript: timerInstrumentation, launchOptions: { args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] } },
  );
  report.ok = Boolean(started);
} catch (e) {
  report.error = String((e && e.stack) || e);
  console.error(report.error);
} finally {
  try {
    if (panel) await panel.stop();
  } catch {
    /* the verdict is the numbers */
  }
  try {
    if (gateway) await gateway.close();
  } catch {
    /* same */
  }
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* windows may still hold a file */
    }
  }
}

// ---- the table ------------------------------------------------------------------------------------------------
function table() {
  const L = [];
  const p = report.paths || {};
  L.push("");
  L.push(`measured ${report.measuredAt} · ${report.root} · ${report.fixture ? report.fixture.worktrees : "?"} worktrees · ${report.boot ? `boot ${r1(report.boot.ms / 1000)}s` : "no boot"}`);
  if (p.refresh) {
    L.push("");
    L.push(`(1) refresh tick, ${p.refresh.rows} rows`);
    L.push(`    /api/state   fetch ${p.refresh.fetch.median} ms median (${p.refresh.fetch.max} max; server ${p.refresh.serverWait?.median ?? "—"} ms + download ${p.refresh.download?.median ?? "—"} ms) · ${Math.round(p.refresh.bytes / 1024)} KB ${p.refresh.encoding}`);
    L.push(`    JSON parse   ${p.refresh.parse.median} ms median`);
    L.push(`    render       ${p.refresh.render.median} ms median (${p.refresh.render.max} max) · renderAll ${p.refresh.fullRenderMs} ms`);
    L.push(`    tick total   ${p.refresh.total.median} ms · ${p.refresh.rows} rows · ${p.refresh.domNodes} DOM nodes (${p.refresh.nodeHistogram} per row) · DOM +${p.refresh.domAddedPerTick ?? "—"}/tick · longest frame gap ${p.refresh.frameGapMax ?? "—"} ms`);
  }
  if (p.idle) {
    L.push("");
    L.push("(idle) 10 s with nothing changed");
    L.push(`    long task max ${p.idle.longMax ?? "—"} ms · longest frame gap ${p.idle.frameGapMax ?? "—"} ms · DOM +${p.idle.domAdded}/-${p.idle.domRemoved} · server row frames ${p.idle.serverRowEvents ?? "—"}`);
    for (const t of (p.idle.timers || []).slice(0, 12)) L.push(`    ${String(t.calls).padStart(4)}x ${t.name} (every ${t.every} ms)  ${t.ms} ms total, ${t.max} max`);
    for (const c of p.idle.calls.slice(0, 6)) L.push(`    ${String(c.calls).padStart(4)}x ${c.n}  ${c.ms} ms total, ${c.max} max`);
  }
  if (p.console) {
    const c = p.console;
    const q = (s, k = "median") => (s && s[k] != null ? s[k] : "—");
    L.push("");
    L.push(`(2) console stream — ${c.drawCalls ?? "?"} row draw(s), wall ${c.wallMs ? r1(c.wallMs / 1000) : "?"} s`);
    L.push(`    per row      median ${q(c.drawMs)} ms · p90 ${q(c.drawMs, "p90")} · max ${q(c.drawMs, "max")}`);
    L.push(`    plain text   median ${q(c.plainText)} ms (${c.plainText?.n ?? "?"} frames, ${q(c.plainText?.chars)} chars)`);
    L.push(`    marker re-render median ${q(c.markerText)} ms (${c.markerText?.count ?? "?"} frames)`);
    L.push(`    full console repaint ${c.repaints?.calls}/${c.repaints?.of} draws · long max ${c.longMax ?? "—"} ms · longest frame gap ${c.frameGapMax ?? "—"} ms · DOM +${c.domAdded ?? "?"}`);
    L.push(`    console now  ${c.console?.rows ?? "?"} rows / ${c.console?.nodes ?? "?"} nodes · ${c.console?.fenceRows ?? "?"} fence rows · ${c.console?.toolRows ?? "?"} tool rows`);
    L.push(`    server row frames ${c.serverRowEvents ?? "—"} · top wraps ${(c.wraps || []).slice(0, 6).map((w) => `${w.n} ${w.calls}x/${w.ms}ms`).join(" · ")}`);
    for (const s of c.snapshotCalls || []) L.push(`    snapshot ${r1(s.ms)} ms from ${s.caller}`);
  }
  if (p.sse) {
    const s = p.sse;
    L.push("");
    L.push(`(4) SSE, live job, ${s.seconds} s`);
    L.push(`    ${s.frames} frame(s) · ${s.eventsPerSecond}/s · ${s.bytesPerSecond} B/s · biggest ${s.biggestFrame} B · snapshot ${s.snapshotBytes} B`);
    L.push(`    ${JSON.stringify(s.byType)} · page drew ${s.pageJoblines} line(s) · row frames ${s.serverRowEvents ?? "—"} · long max ${s.pageLongMax ?? "—"} ms · frame gap ${s.pageFrameGapMax ?? "—"} ms`);
    L.push(`    page wraps ${(s.pageWraps || []).slice(0, 5).map((w) => `${w.n} ${w.calls}x/${w.ms}ms`).join(" · ")}`);
  }
  if (p.drag) {
    const d = p.drag;
    L.push("");
    L.push(`(3) drag across ${d.seeded} rows`);
    L.push(`    wall ${d.wallMs} ms (crawl ${d.crawlMs} ms) · ${d.pointermoves} pointermove(s) · ${d.rectReads} getBoundingClientRect (${d.rectsPerMove}/move)`);
    L.push(`    frames median ${d.frameMedian} ms / max ${d.frameMax} ms · long max ${d.longMax} ms · DOM +${d.domAdded}/-${d.domRemoved}`);
    L.push(`    landed at top: ${d.movedToTop} · dom ${d.domOrderTop5.join(",")}… · server ${d.serverOrderTop5.join(",")}…`);
  }
  L.push("");
  return L.join("\n");
}
console.log(table());
if (JSON_OUT) {
  try {
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2), "utf8");
    console.log(`json: ${slash(JSON_OUT)}`);
  } catch (e) {
    console.log(`json not written: ${String(e.message || e)}`);
  }
}
