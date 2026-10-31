// Which single shared thing resets every open console's scrollTop, and on what beat?
//
//   node tools/measure-console-scroll-hop.mjs                      # two projects, two live cards, ~95 s
//   node tools/measure-console-scroll-hop.mjs --seconds 150        # a longer window (more beats)
//   node tools/measure-console-scroll-hop.mjs --reorder-seconds 0  # control: the page's reorder clock stopped
//   node tools/measure-console-scroll-hop.mjs --json <path>        # keep the raw capture
//   node tools/measure-console-scroll-hop.mjs --allow-hops         # report only, even when a hop was seen
//   node tools/measure-console-scroll-hop.mjs --keep               # leave the sandbox behind
//   node tools/measure-console-scroll-hop.mjs --headed             # a window instead of headless Chromium
//
// EXIT CODE: 0 when no console was painted off its newest line, 1 when one was (that is the defect this tool exists to
// measure, so a regression is a red run and not a number somebody has to remember to read).
//
// It boots its own panel (tools/panel-testkit.mjs, spare port, own config/HERMES_HOME, API_SERVER_KEY empty), plays
// one fixed reply per card over a stub Runs API, and opens BOTH projects and BOTH worktree rows so the two cards are
// the two different projects' cards — the shape the reader reports ("all open cards, across projects, at once").
//
// Recorded, all on one clock (performance.now()):
//   * every scrollTop write (setScroll), with from/to/scrollHeight/clientHeight and the caller stack
//   * every scroll event on a console box, with the geometry at that instant
//   * every DOM primitive that moves a subtree containing a `pre.job-out` (insertBefore/after/append/replaceWith/
//     replaceChildren/remove) with its caller stack — a move is what clamps a scroll box to 0
//   * the page's own render entry points (placeRow, renderProjectRows, renderJobs, applySnapshot, renderConversation,
//     renderAll, reorderProjects, sweepStaleBoard, settleScrolls, restoreScrolls, applyStoredScrolls, stickConsole,
//     updateJob, appendJobLine, drawJobLine, paintTypedLines, paintThink, loadThinking) with caller stacks
//   * every timer scheduled and every firing, so a beat can be named by its period
//   * a per-frame sample of every console box (what a frame can paint)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const JSON_OUT = opt("--json");
const KEEP = argv.includes("--keep");
const SECONDS = Number(opt("--seconds", 95));
const HEADLESS = !argv.includes("--headed");
// 0 stops the page's reorder clock (Settings > Board > reorder seconds); the default is the page's own 5 s.
const REORDER_SECONDS = opt("--reorder-seconds") == null ? null : Number(opt("--reorder-seconds"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORDS = `the console is a fixed height box and its content is longer than the box
a repaint that patches the row extends the words and moves nothing else
a repaint that replaces the row keeps the words and loses the nodes
keeping the newest line in view means scrolling to the bottom after every growth
a reader who has scrolled up is a reader the panel must not touch
the sweep runs on its own clock whether or not the wire is moving
the board rebuilds a row to say a scan found nothing new
a card that keeps its node keeps the reader's place in it`.split(/\s+/).filter(Boolean);

// Two different scripts so the two cards are two different replies, on the same 75 ms cadence.
function steps(from, until, seed, salt) {
  const out = [];
  let t = from;
  let i = seed;
  let para = 0;
  while (t < until) {
    const chunk = [WORDS[i % WORDS.length], WORDS[(i + 1) % WORDS.length]];
    i += 2;
    para += 2;
    const lead = para >= 55 ? "\n\n" : "\n";
    if (lead === "\n\n") para = 0;
    out.push({ at: t, evt: { event: "message.delta", delta: `${lead}${chunk.join(" ")} ${salt} ` } });
    t += 75;
  }
  return out;
}

// One stub gateway serving every run the panel posts; run N plays script N.
function makeGateway(scriptLen) {
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
      return json(200, { version: "scroll-hop-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_hop_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "", startedAt: null, script: steps(300, scriptLen, state.posts === 1 ? 0 : 40, state.posts === 1 ? "alpha" : "beta") });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } });
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
      rec.script.forEach((step, i) => {
        later(rec.startedAt + step.at - Date.now(), () => {
          if (!open) return;
          res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
        });
      });
      return;
    }
    json(404, {});
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearTimeout(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the page-side recorder --------------------------------------------------------------------------------------
function pageInit(opts) {
  try {
    if (opts && opts.reorderSeconds != null) localStorage.setItem("wm.reorderSeconds", String(opts.reorderSeconds));
  } catch {
    /* storage may be unavailable */
  }
  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const R = { calls: [], scrolls: [], scrollEvents: [], moves: [], fires: [], sched: [], frames: [], errors: [], suspects: [] };
  const CAP = { calls: 30000, scrolls: 20000, scrollEvents: 20000, moves: 12000, fires: 20000, frames: 60000 };
  window.__p = R;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  const stack = (n = 3) =>
    String(new Error().stack || "")
      .split("\n")
      .slice(2, 2 + n)
      .map((l) => l.trim().replace(/^at\s+/, ""))
      .filter((l) => l && !l.includes("pageInit"))
      .join(" <- ");

  const idx = new WeakMap();
  let nid = 0;
  const tag = (el) => {
    if (!el) return -1;
    if (!idx.has(el)) idx.set(el, ++nid);
    return idx.get(el);
  };
  const kind = (el) => (el?.classList?.contains("job-out") ? "console" : el?.classList?.contains("think-body") ? "think" : el?.classList?.contains("sub-console") ? "sub" : "");

  // -- timers: who scheduled what, and every firing (the beat's own clock).
  const meta = new Map();
  let seq = 0;
  for (const name of ["setInterval", "setTimeout"]) {
    const orig = window[name];
    if (typeof orig !== "function") continue;
    const w = function (fn, delay, ...rest) {
      const id = `${name}#${++seq}`;
      meta.set(id, { id, kind: name, delay: Number(delay) || 0, at: now(), stack: stack(4) });
      const cb =
        typeof fn === "function"
          ? function () {
              if (R.fires.length < CAP.fires) R.fires.push({ t: now(), id, delay: Number(delay) || 0 });
              return fn.apply(this, arguments);
            }
          : fn;
      return orig.call(window, cb, delay, ...rest);
    };
    w.__w = true;
    window[name] = w;
  }
  window.__sched = () => [...meta.values()];

  // -- every scroll event on a console, at the geometry of that instant.
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target;
      const k = kind(el);
      if (!k) return;
      if (R.scrollEvents.length >= CAP.scrollEvents) return;
      R.scrollEvents.push({ t: now(), node: tag(el), kind: k, out: el.dataset?.out || "", top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), sh: el.scrollHeight, ch: el.clientHeight });
    },
    true,
  );

  // -- per frame: what a frame can paint.
  const last = new Map();
  const sample = () => {
    for (const el of document.querySelectorAll("pre.job-out, .think-body")) {
      const id = tag(el);
      const top = Math.round(el.scrollTop);
      const max = Math.round(el.scrollHeight - el.clientHeight);
      const prev = last.get(id);
      if (!prev || prev.top !== top || prev.max !== max || prev.conn !== el.isConnected) {
        if (R.frames.length < CAP.frames) R.frames.push({ t: now(), node: id, kind: kind(el), out: el.dataset?.out || "", top, max, sh: el.scrollHeight, ch: el.clientHeight, conn: el.isConnected });
        last.set(id, { top, max, conn: el.isConnected });
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  // -- DOM primitives: a move is what clamps a scroll box to 0, and its caller is the answer.
  // Geometry is NOT read here: a layout read inside a mutation wrapper can manufacture the clamp being investigated.
  const outsIn = (nodes) => {
    const outs = [];
    for (const node of nodes) {
      if (!node || node.nodeType !== 1) continue;
      if (node.matches?.("pre.job-out")) outs.push(node.dataset.out || "");
      for (const el of node.querySelectorAll?.("pre.job-out") || []) outs.push(el.dataset.out || "");
    }
    return outs;
  };
  const record = (op, host, nodes) => {
    if (R.moves.length >= CAP.moves) return;
    const outs = outsIn(nodes);
    if (!outs.length) return;
    R.moves.push({ t: now(), op, host: host?.tagName ? `${host.tagName.toLowerCase()}.${host.className || ""}` : "", outs, stack: stack(5) });
  };
  const wrapNode = (proto, name, pick) => {
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__m) return;
    const w = function () {
      const r = orig.apply(this, arguments);
      const [host, nodes] = pick(this, arguments);
      record(name, host, nodes);
      return r;
    };
    w.__m = true;
    proto[name] = w;
  };
  wrapNode(Node.prototype, "insertBefore", (self, a) => [a[0] || self, [a[0]]]);
  wrapNode(Node.prototype, "appendChild", (self, a) => [a[0] || self, [a[0]]]);
  wrapNode(Element.prototype, "after", (self, a) => [self, a]);
  wrapNode(Element.prototype, "before", (self, a) => [self, a]);
  wrapNode(Element.prototype, "append", (self, a) => [self, a]);
  wrapNode(Element.prototype, "replaceWith", (self, a) => [self.parentNode, a]);
  wrapNode(Element.prototype, "replaceChildren", (self, a) => [self, a]);
  wrapNode(Element.prototype, "remove", (self) => [self.parentNode, [self]]);
  // An `innerHTML` rebuild never calls any of those: the children leave through the parser. Watch the tree instead.
  const mo = () => {
    const obs = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type !== "childList" || R.moves.length >= CAP.moves) continue;
        const gone = [...m.removedNodes].filter((n) => n.nodeType === 1 && !n.isConnected);
        const came = [...m.addedNodes].filter((n) => n.nodeType === 1);
        const outsGone = outsIn(gone);
        const outsCame = outsIn(came);
        if (!outsGone.length && !outsCame.length) continue;
        R.moves.push({ t: now(), op: "innerHTML-or-batch", host: m.target?.id || m.target?.tagName?.toLowerCase() || "", outs: [...outsGone.map((o) => `-${o}`), ...outsCame.map((o) => `+${o}`)], stack: "" });
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) mo();
  else document.addEventListener("DOMContentLoaded", mo, { once: true });

  // -- the page's own faces, wrapped after app.js parses.
  window.__instrument = () => {
    const out = [];
    const names = [
      "setScroll", "stickConsole", "stickThinkBody", "restoreScrolls", "applyStoredScrolls", "settleScrolls",
      "restoreThinkBody", "restoreThinkBodies", "captureScrolls", "placeRow", "queueRow", "renderProjectRows",
      "renderJobs", "renderConversation", "applySnapshot", "renderAll", "reorderProjects", "reorder",
      "sweepStaleBoard", "scheduleBoardSweep", "updateJob", "appendJobLine", "drawJobLine", "paintTypedLines",
      "paintThink", "loadThinking", "syncStreamConsole", "resync", "paintCardMeta", "refreshSubagentRoster",
      "repaintAgentState", "paintSubagents",
    ];
    for (const name of names) {
      const orig = window[name];
      if (typeof orig !== "function" || orig.__i) continue;
      const w = function () {
        if (R.calls.length < CAP.calls) {
          const a0 = arguments[0];
          const detail = typeof a0 === "string" ? a0.slice(0, 40) : a0?.dataset ? `[${a0.tagName?.toLowerCase()} ${a0.className || ""}]` : "";
          R.calls.push({ t: now(), name, detail, stack: stack(3) });
        }
        const before = name === "setScroll" && arguments[0] ? { top: Math.round(arguments[0].scrollTop), sh: arguments[0].scrollHeight, ch: arguments[0].clientHeight } : null;
        const r = orig.apply(this, arguments);
        if (before && R.scrolls.length < CAP.scrolls) {
          const el = arguments[0];
          R.scrolls.push({
            t: now(),
            out: el.dataset?.out || "",
            kind: kind(el),
            from: before.top,
            asked: Math.round(Number(arguments[1]) || 0),
            to: Math.round(el.scrollTop),
            sh: el.scrollHeight,
            ch: el.clientHeight,
            max: Math.round(el.scrollHeight - el.clientHeight),
            stack: stack(4),
          });
        }
        return r;
      };
      w.__i = true;
      window[name] = w;
      out.push(name);
    }
    // reorderProjects is the one path that re-appends WHOLE SECTIONS. A section re-append detaches every card inside
    // it, so record the order before and after: a changed order is a move, and a move is a clamp.
    const rpOrig = window.reorderProjects;
    if (typeof rpOrig === "function" && !rpOrig.__r) {
      const r = function () {
        const order = () => [...document.querySelectorAll("section.project[data-project]")].map((s) => s.dataset.project);
        const before = order();
        const consolesBefore = document.querySelectorAll("pre.job-out").length;
        const out = rpOrig.apply(this, arguments);
        const after = order();
        const moved = before.filter((n, i) => after[i] !== n).length + Math.abs(before.length - after.length);
        if (R.calls.length < CAP.calls) R.calls.push({ t: now(), name: "reorderProjects:result", detail: `moved=${moved} order=${after.join(",").slice(0, 120)} consoles=${consolesBefore}`, stack: stack(3) });
        return out;
      };
      r.__r = true;
      window.reorderProjects = r;
      out.push("reorderProjects:result");
    }
    // captureScrolls is the only description of "where the console was" a rebuild trusts: log what it saw, because a
    // capture taken AFTER a move reads 0 and turns into a real write to 0.
    const capOrig = window.captureScrolls;
    if (typeof capOrig === "function" && !capOrig.__c) {
      const c = function () {
        const map = capOrig.apply(this, arguments);
        const seen = [...map.entries()].map(([k, v]) => `${k}=${v.top}/${v.atBottom ? "B" : "-"}`).join(" ");
        if (R.calls.length < CAP.calls) R.calls.push({ t: now(), name: "captureScrolls:result", detail: seen.slice(0, 200), stack: stack(4) });
        return map;
      };
      c.__c = true;
      window.captureScrolls = c;
      out.push("captureScrolls:result");
    }
    return out;
  };
  window.__dump = () => R;
}

function loadPlaywright() {
  for (const root of [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd(), "C:/Users/roper/AppData/Roaming/npm/node_modules"].filter(Boolean)) {
    for (const p of [path.join(root, "node_modules", "playwright"), path.join(root, "playwright"), root]) {
      try {
        return require(p);
      } catch {
        /* not there */
      }
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

function git(args, cwd) {
  return execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}

// ---- reading the capture -------------------------------------------------------------------------------------------
// The four numbers the report turns on: the hop instants (and their gaps), the reorderProjects calls that re-appended a
// section, which writer repaired each hop, and every interval that fired with its period.
function report(cap) {
  const t1 = (n) => Math.round(n);            // hop instants are grouped to the millisecond: both consoles land in one frame
  const t2 = (n) => Math.round(n * 10) / 10;  // a repair delay keeps its tenth
  const byOut = new Map();
  for (const f of cap.frames) {
    if (f.kind !== "console") continue;
    if (!byOut.has(f.out)) byOut.set(f.out, []);
    byOut.get(f.out).push(f);
  }
  const hops = [];
  for (const [out, list] of byOut) {
    for (let i = 0; i < list.length; i++) {
      if (!(list[i].top <= 2 && list[i].max > 20)) continue;
      hops.push({ out, t: list[i].t, max: list[i].max });
    }
  }
  const instants = [...new Set(hops.map((h) => t1(h.t)))].sort((a, b) => a - b);
  console.log(`\n== scroll hop: ${instants.length} painted instants, ${cap.start?.consoles?.length || 0} console(s) under test`);
  for (const t of instants) {
    const hs = hops.filter((h) => t1(h.t) === t);
    const w = cap.scrolls.filter((s) => s.t >= t && s.t <= t + 600 && s.from <= 2 && s.to > 20).sort((a, b) => a.t - b.t)[0];
    const who = !w ? "no repair in 600 ms" : /stickConsole/.test(w.stack) ? "stickConsole" : /paintTypedLines/.test(w.stack) ? "paintTypedLines" : /drawJobLine/.test(w.stack) ? "drawJobLine" : w.stack.split("<-")[1]?.trim();
    console.log(`   ${String(t).padStart(9)}ms  ${hs.length} console(s) at 0 (max ${hs.map((h) => h.max).join(" / ")})  repaired by ${who}${w ? ` +${t2(w.t - t)}ms -> ${w.to}` : ""}`);
  }
  const gaps = instants.slice(1).map((t, i) => t1(t - instants[i]));
  if (gaps.length) console.log(`   gaps: ${gaps.join(", ")} ms — mean ${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)} ms`);

  const rp = cap.calls.filter((c) => c.name === "reorderProjects:result");
  const moved = rp.filter((c) => !/\bmoved=0\b/.test(c.detail));
  const callers = {};
  for (const m of moved) {
    const c = cap.calls.filter((x) => x.name === "reorderProjects" && x.t <= m.t + 2 && x.t >= m.t - 15).slice(-1)[0];
    const who = c ? c.stack.split("<-").map((s) => s.trim()).filter((s) => /app\.js|assistant\.js/.test(s))[0] || c.stack.split("<-")[0].trim() : "?";
    callers[who] = (callers[who] || 0) + 1;
  }
  console.log(`\n== reorderProjects: ${rp.length} calls, ${moved.length} re-appended a section`);
  for (const [k, n] of Object.entries(callers).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${k}`);
  const consoleCounts = moved.map((m) => Number((/consoles=(\d+)/.exec(m.detail) || [0, 0])[1]));
  if (consoleCounts.length) console.log(`   consoles inside the re-appended sections: ${Math.max(...consoleCounts)} at most`);

  const back = cap.scrolls.filter((s) => s.to < s.from - 1);
  console.log(`\n== setScroll: ${cap.scrolls.length} writes, ${back.length} backwards`);
  const fired = new Map();
  for (const f of cap.fires) fired.set(f.id, (fired.get(f.id) || 0) + 1);
  const seen = new Set();
  console.log(`== intervals that fired`);
  for (const t of cap.timers) {
    if (t.kind !== "setInterval") continue;
    const n = fired.get(t.id) || 0;
    if (!n) continue;
    const at = (t.stack.match(/(?:app|assistant)\.js\?v=[^:]+:(\d+):/) || [])[1] || "?";
    const key = `${t.delay}|${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`   ${String(t.delay).padStart(6)}ms  fires=${String(n).padStart(3)}  scheduled at line ${at}`);
  }
  // The count is the verdict: the caller exits non-zero on it, so a hop this tool can see is a red run.
  return instants.length;
}

const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(0);
}

const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-hop-"));
const profile = path.join(work, "profile");
mkdirSync(profile, { recursive: true });
const projects = [
  { name: "alpha", repo: path.join(work, "roots", "alpha"), thread: "hop-probe-alpha", open: true },
  { name: "beta", repo: path.join(work, "roots", "beta"), thread: "hop-probe-beta", open: true },
  // Closed projects. Their ranks move as their activity moves, and that is what makes `reorderProjects()` re-append
  // EVERY section of their folder — including the two the reader has open.
  { name: "gamma", repo: path.join(work, "roots", "gamma"), open: false },
  { name: "delta", repo: path.join(work, "roots", "delta"), open: false },
  { name: "epsilon", repo: path.join(work, "roots", "epsilon"), open: false },
  { name: "zeta", repo: path.join(work, "roots", "zeta"), open: false },
];
for (const p of projects) {
  mkdirSync(p.repo, { recursive: true });
  git(["init", "-q", "-b", "main"], p.repo);
  writeFileSync(path.join(p.repo, "README.md"), `# ${p.name}\n`);
  git(["add", "."], p.repo);
  git(["commit", "-q", "-m", "first"], p.repo);
}
const gw = makeGateway(SECONDS * 1000 - 800);
const gwPort = await gw.listen();
const sandbox = await startPanel({
  dir: work,
  keep: KEEP,
  config: {
    scanRoots: [path.join(work, "roots")],
    projects: [],
    refreshSeconds: 30,
    worktreeSeconds: 5,
    midSeconds: 45,
    dormantSeconds: 90,
    liveSeconds: 5,
    slowSeconds: 300,
    fetchSeconds: -1,
    assistant: { enabled: false },
    remoteBranchPolicy: "local-only",
    defaultCwd: path.join(work, "roots"),
    apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
  },
  env: { API_SERVER_KEY: "" },
});
const ctx = await pw.chromium.launchPersistentContext(profile, { headless: HEADLESS, viewport: { width: 1400, height: 1000 } });
const pageErrors = [];
let capture = null;
try {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  await page.addInitScript(pageInit, { reorderSeconds: REORDER_SECONDS });
  await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30000 });
  // Two projects, discovered.
  await page.waitForFunction((names) => names.every((n) => [...state.projects.keys()].some((k) => k === n)), projects.map((p) => p.name), { timeout: 60000 });
  const instrumented = await page.evaluate(() => window.__instrument());
  const live = projects.filter((p) => p.open);
  const spawned = [];
  for (const p of live) {
    const r = await fetch(`${sandbox.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: `probe: stream a fixed reply from ${p.name}`, cwd: p.repo, existing: true, thread: p.thread }),
    }).then((x) => x.json());
    if (!r || !r.job) throw new Error(`spawn failed for ${p.name}: ${JSON.stringify(r)}`);
    spawned.push({ project: p.name, job: r.job.id, thread: p.thread });
  }
  // The closed projects have to MOVE in the ranking, or `reorderProjects()` never re-appends a section and there is
  // nothing to measure. Real work does that by touching files; the driver below does the same thing on a clock.
  const touch = setInterval(() => {
    const closed = projects.filter((p) => !p.open);
    const pick = closed[Math.floor(Date.now() / 4000) % closed.length];
    try {
      writeFileSync(path.join(pick.repo, `probe-${Date.now()}.txt`), "activity\n");
    } catch {
      /* the tree may be gone; the next tick picks another */
    }
  }, 4000);
  touch.unref?.();
  // Both jobs exist as cards in state; a card owned by a worktree is only DRAWN once its row is open, so open the
  // projects and their main rows first, then wait for the consoles.
  await page.waitForFunction(
    (threads) => threads.every((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t)),
    live.map((p) => p.thread),
    { timeout: 60000 },
  );
  const opened = await page.evaluate((names) => {
    const out = [];
    for (const name of names) {
      const rows = [...state.rows.values()].filter((r) => r.project === name);
      const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const proj = state.projects.get(name);
      const main = rows.find((r) => norm(r.path) === norm(proj?.path)) || rows.find((r) => String(r.branch || "") === String(proj?.mainBranch || "main")) || rows[0];
      if (!main) continue;
      state.expandedProjects.add(name);
      state.expanded.add(`${name}::${main.path}`);
      out.push({ project: name, row: main.path, rows: rows.length });
    }
    if (typeof renderAll === "function") renderAll();
    return out;
  }, live.map((p) => p.name));
  for (const p of live) await page.waitForSelector(`.job[data-thread="${p.thread}"] pre.job-out`, { timeout: 30000 });
  await sleep(2500);
  const start = await page.evaluate(() => ({
    consoles: [...document.querySelectorAll("pre.job-out")].map((el) => ({ out: el.dataset.out, top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), inRow: Boolean(el.closest("tr.detail")) })),
    rowsOpen: [...state.expanded],
    projectsOpen: [...state.expandedProjects],
  }));
  await sleep(SECONDS * 1000);
  capture = await page.evaluate(() => window.__dump());
  capture.timers = await page.evaluate(() => window.__sched());
  capture.instrumented = instrumented;
  capture.start = start;
  capture.opened = opened;
  capture.spawned = spawned;
  capture.pageErrors = pageErrors;
  capture.base = sandbox.base;
  const out = { at: new Date().toISOString(), seconds: SECONDS, reorderSeconds: REORDER_SECONDS, sandbox: sandbox.dir, base: sandbox.base, capture };
  if (JSON_OUT) {
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
    console.log(`capture: ${JSON_OUT}`);
  }
  console.log(`start: ${JSON.stringify(start)}`);
  console.log(`calls=${capture.calls.length} scrolls=${capture.scrolls.length} scrollEvents=${capture.scrollEvents.length} moves=${capture.moves.length} fires=${capture.fires.length} frames=${capture.frames.length} errors=${capture.pageErrors.length}`);
  const hops = report(capture);
  // A painted hop is the defect this tool exists to measure: a regression is a red run, not a number in a report
  // somebody has to remember to read. `--allow-hops` keeps the old report-only use for a baseline capture.
  if (hops && !argv.includes("--allow-hops")) {
    console.log(`\nFAIL  ${hops} painted hop instants — a console was painted at the top of its box and pulled back`);
    process.exitCode = 1;
  } else if (!hops) {
    console.log("\nOK  no console was painted off its newest line");
  }
} finally {
  await ctx.close().catch(() => {});
  await gw.close().catch(() => {});
  await sandbox.stop().catch(() => {});
  if (!KEEP && !JSON_OUT) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
