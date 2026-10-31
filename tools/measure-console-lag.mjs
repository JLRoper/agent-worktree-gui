// How far behind its newest line does a live console sit, for how long, and what put it there?
//
//   node tools/measure-console-lag.mjs                                      # the natural board (control + the reported defect)
//   node tools/measure-console-lag.mjs --scenario placeRow                  # fire ONLY placeRow's detail swap
//   node tools/measure-console-lag.mjs --scenario cards                     # ... the same, on a row holding TWO cards
//   node tools/measure-console-lag.mjs --scenario cardsIdle                 # that row, nothing injected (control)
//   node tools/measure-console-lag.mjs --scenario renderAll                 # fire ONLY renderAll()
//   node tools/measure-console-lag.mjs --scenario sseProject                # fire ONLY the `project` SSE frame
//   node tools/measure-console-lag.mjs --scenario all7d                     # fire ONLY the All/7d folder toggle
//   node tools/measure-console-lag.mjs --scenario rankOnly                  # ONLY the page's own 5 s reorder clock
//   node tools/measure-console-lag.mjs --scenario input                     # a clamp while the reader types elsewhere
//   node tools/measure-console-lag.mjs --scenario clamp                     # the same clamp, nobody typing (control)
//   node tools/measure-console-lag.mjs --url http://127.0.0.1:7331 --rows 4  # a LIVE panel, read-only, its running rows
//   node tools/measure-console-lag.mjs --seconds 75 --json out.json         # a longer window and the raw record
//
// OPTIONS that change what the wire looks like (the sandbox only): --rate <ms> is the word cadence (default 75; a real
// agent writes several words a millisecond in a burst) and --burst <chars> drops one tool-output-sized delta in every
// 40 words. A stub that writes one word every 75 ms is a fair test of the code paths but a poor one for a lag, which
// is measured in pixels per millisecond. --deep records the geometry every `stickConsole`/`setScroll` saw even when no
// console was off the bottom yet, which is what shows a writer being clamped by a layout that had not settled.
//
// THE DEFECT. On 0.34.0 a console that follows its newest line can sit BEHIND it - 34-380 px short of its newest line,
// never at the top - for a fraction of a second, and then be back. The report ties it to placeRow swapping a row's
// detail; **the measurement does not confirm that**, and this file does not claim it. See docs/console-lag.md: it was
// reproduced ONLY against a live board that was really churning (97 excursions in 75 s, every one a clamp, the top
// falling 34-190 px with the content height unchanged), and EVERY sandbox scenario here reads 0 - including `stream`
// and `cards`, which call placeRow 101-184 times per minute on a row that holds one console or two. So a sandbox run
// that reads 0 is the control, not the reproduction: it says the harness cannot produce this fault, not that the fault
// is absent.
//
// It is not the hop of docs/console-scroll-hop.md either: that one is a jump to scrollTop 0 and it is gone. This one is
// a lag - the box keeps a position below its newest line - and nothing in the repo measured it before this tool.
//
// WHAT IT MEASURES. Per painted frame, for every overflowing `pre.job-out`:
//
//     lag = scrollHeight - scrollTop - clientHeight
//
// i.e. the px between the bottom of the box and its newest line. A frame with lag > --thresh opens an excursion; the
// excursion closes on the first frame back within the threshold. For each one the recorder keeps the lag it started
// at, the worst lag, the duration, whether the box's TOP was held while its content grew (`frozen`) or the top fell
// (`clamped`), and the page events that led to it - the wrapped page functions, the DOM moves that carried a console,
// the setScroll writes (with the value ASKED for, so a write the browser clamped is visible) and pin changes.
//
// Nothing is inferred from source. Every row of the report is a count or a distribution taken from a run.
//
// WHAT IS DRIVEN (a throwaway panel of its own - tools/panel-testkit.mjs: spare port, own PANEL_CONFIG / HERMES_HOME /
// jobs.json, API_SERVER_KEY empty - so the reader's panel on 7331 is never touched; --url is the other mode: it opens
// ONE tab of a panel that is already running, opens the rows of the runs that are live at that moment, and posts
// nothing, clicks nothing and writes nothing)
//   * a stub Runs API that plays plain text over real SSE; the cards are spawned through the panel's own POST
//     /api/agents and every line reaches the page as a `jobline` frame from the panel's own server. --rate/--burst make
//     it arrive at a real burst rate instead of one word per 75 ms, because this defect is measured in px per ms
//   * `stream`   the natural board: two cards in two sibling worktree rows of one project, the panel's own scan clock
//                (worktreeSeconds 5), the 5 s reorder clock and a file touched in a closed project every 4 s, so
//                placeRow fires on its own - 182-184 times a minute, and the console never leaves the bottom
//   * every other scenario is a QUIET board - the scan clocks pushed out to an hour, no churn, the reorder clock
//                stopped - plus exactly ONE injected trigger on a 3 s beat, so a lag can be attributed to it; each
//                report prints the call counts, which is what proves the trigger really fired
//   * `cards` vs `placeRow`: the same injected detail swap on a row that holds TWO cards and on rows that hold one
//   * `input` / `clamp` are the lastInputAt pair: the same raw clamp of an open section (which is how the browser
//                resets a console) with and without a keypress landing anywhere else on the page 0-1.2 s before it
//
// WHAT IT HAS FOUND (docs/console-lag.md). The live mode reproduces the defect; the sandbox does not, in any scenario,
// including the ones that blamed it. That is a result about the harness, and the doc says so rather than naming a
// cause: the leading sequence (a same-task restore reading a height the layout has not settled yet, plus the early
// return in stickConsole) is consistent with all 97 live records and is still unproven. --deep is the mode that would
// settle it: it records the geometry of EVERY stickConsole/setScroll, lagging or not.
//
// Exit codes: 0 the run measured something; 2 it did not (no Playwright, the consoles never overflowed, the injected
// trigger never fired); 1 the page raised an error. A run that reads 0 excursions is a measured answer, not a failure.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SECONDS = Number(opt("--seconds", 75));
const THRESH = Number(opt("--thresh", 8));
const INJECT_MS = Number(opt("--inject-ms", 3000));
const KEY_MS = Number(opt("--key-ms", 800));
const SCENARIO = opt("--scenario", "stream");
const LIVE_URL = opt("--url");
const LIVE_ROWS = Number(opt("--rows", 2));
const LIVE_MATCH = opt("--match", "");
const DEEP = argv.includes("--deep");
const JSON_OUT = opt("--json");
const HEADLESS = !argv.includes("--headed");
const MAX_WAIT_MS = 150_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);

// `siblings` puts the two consoles in two ROWS of one project - the shape placeRow swaps. `projects` puts them in two
// different sections, which is the only shape in which a clamp on one console cannot touch the other: that is what the
// lastInputAt pair needs.
const SCENARIOS = {
  stream: { desc: "the natural board: two consoles, the panel's own scan clock, a closed project touched every 4 s", cards: "siblings", quiet: false, inject: null },
  placeRow: { desc: "ONLY placeRow's detail swap, on a quiet board", cards: "siblings", quiet: true, inject: "placeRow" },
  renderAll: { desc: "ONLY renderAll(), on a quiet board", cards: "siblings", quiet: true, inject: "renderAll" },
  sseProject: { desc: "ONLY the `project` SSE frame, on a quiet board", cards: "siblings", quiet: true, inject: "sseProject" },
  all7d: { desc: "ONLY the All/7d folder toggle, on a quiet board", cards: "siblings", quiet: true, inject: "all7d" },
  // A row detail that holds SEVERAL cards is the shape the live board showed the lag in: one placeRow rebuild moves
  // every card in it, and with Stabilize reordering off the row's cards are re-ranked on their own clock besides.
  cards: { desc: "ONLY placeRow's detail swap, on a row that holds TWO cards", cards: "one-row", quiet: true, inject: "placeRow", stabilizeOff: true },
  cardsIdle: { desc: "the same two-card row, nothing injected (control for `cards`)", cards: "one-row", quiet: true, inject: null, stabilizeOff: true },
  // The ranking pass on its own: the page's own reorder clock (`wm.reorderSeconds`, default 5 s) with nothing else
  // moving. placeRow calls reorderProjects() in its flush, so the two are inseparable on a live board - this separates
  // them by keeping the row's data still and letting only the clock tick.
  rankOnly: { desc: "ONLY the page's reorder clock (no injected trigger, no scans)", cards: "one-row", quiet: true, inject: null, rankOn: true, stabilizeOff: true },
  input: { desc: "a raw clamp of an open section while a keypress lands elsewhere on the page", cards: "projects", quiet: true, inject: "clamp", keys: true },
  clamp: { desc: "the same raw clamp, nobody typing anywhere (control for `input`)", cards: "projects", quiet: true, inject: "clamp", keys: false },
};

// ---- the stub Hermes gateway: plain text, one word per 75 ms, over real SSE ---------------------------------------------
const WORDS = `the console is a fixed height box and its content is longer than the box
a repaint that patches the row extends the words and moves nothing else
keeping the newest line in view means scrolling to the bottom after every growth
a reader who has scrolled up is a reader the panel must not touch
the sweep runs on its own clock whether or not the wire is moving
a card that keeps its node keeps the reader's place in it`.split(/\s+/).filter(Boolean);

// A stub stream is only a fair test if it arrives at a real rate and in real shapes. `--rate` is the word cadence (a
// real agent writes several words a millisecond during a burst, not one per 75 ms) and `--burst` is a single delta of
// that many characters dropped in every 40 words, which is what a tool's output looks like on the wire: hundreds of
// pixels of console in ONE task, not a line at a time.
const RATE_MS = Number(opt("--rate", 75));
const BURST_CHARS = Number(opt("--burst", 0));

function script(seed, lenMs, rate = 75, burstChars = 0) {
  const out = [];
  let t = 300;
  let i = seed;
  let inLine = 0;
  let lines = 0;
  while (t < lenMs) {
    const w = WORDS[i % WORDS.length];
    i += 1;
    inLine += 1;
    let sep = " ";
    if (inLine >= 11 + (i % 5)) {
      sep = lines % 4 === 3 ? "\n\n" : "\n";
      inLine = 0;
      lines += 1;
    }
    out.push({ at: t, evt: { event: "message.delta", delta: `${w}${sep}` } });
    t += rate;
    if (burstChars && i % 40 === 0) {
      // One tool-output burst: whole lines, one delta, one task on the page.
      const body = Array.from({ length: Math.ceil(burstChars / 60) }, (_, k) => `  ${String(k + 1).padStart(3)} ok  ${WORDS[(i + k) % WORDS.length]} ${WORDS[(i + k + 3) % WORDS.length]}`).join("\n");
      out.push({ at: t, evt: { event: "message.delta", delta: `\n${body}\n` } });
      t += rate;
    }
  }
  return out;
}

function makeGateway(lenMs) {
  const runs = new Map();
  let posts = 0;
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
      return json(200, { version: "lag-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_lag_${posts}`;
        runs.set(id, { id, startedAt: null, script: script(posts === 1 ? 0 : 37, lenMs, RATE_MS, BURST_CHARS) });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: "running", output: "", usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = runs.get(ev[1]);
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
          if (open) res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
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

// ---- the page-side recorder ---------------------------------------------------------------------------------------------
// Runs before app.js parses, so it can wrap the DOM primitives; the page functions are wrapped later, by __wrap(), once
// app.js has defined them. No geometry is read inside a wrapper: a forced layout there would answer the very question
// ("was scrollHeight stale when the page read it?") that this tool exists to ask. Geometry is read once per frame, in
// the sampler, which is what a paint sees.
function pageInit(opts) {
  try {
    if (opts.reorderOff) localStorage.setItem("wm.reorderSeconds", "0");
    if (opts.stabilizeOff) localStorage.setItem("wtgui.stabilize", "0");
  } catch {
    /* storage may be unavailable */
  }
  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const R = {
    thresh: opts.thresh,
    frames: 0,
    armed: false,
    stopped: false,
    armN: opts.armN || 0,
    overflowAt: null,
    errors: [],
    excursions: [],
    timeline: [],
    writes: 0,
    injected: [],
    consoles: 0,
    wrapMissed: [],
    // Counted whether or not the window is armed: a zero-excursion run has to be readable as "the trigger never fired"
    // or "it fired N times and moved nothing", and only these counters tell the two apart.
    calls: {},
    // Every overflowing console, every frame, armed or not: the lag distribution the excursions are cut out of.
    lagMax: 0,
    overFrames: 0,
    sampledFrames: 0,
    perConsoleMax: {},
  };
  window.__lag = R;
  window.__now = now;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e).slice(0, 200)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && (e.reason.message || e.reason)) || "").slice(0, 200)}`));

  const push = (k, w) => {
    if (!R.armed || R.stopped) return;
    R.timeline.push({ t: now(), k, w });
    if (R.timeline.length > 8000) R.timeline.splice(0, 2000);
  };
  window.__push = push;

  // The page's own caller, innermost first: the init script's wrappers are not page files and are skipped.
  const pageStack = (max) => {
    const out = [];
    for (const line of String(new Error().stack || "").split("\n").slice(1)) {
      const m = /^\s*at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/.exec(line);
      if (!m || !/\/(app|assistant)\.js|\/core\/|\/board\//.test(m[2])) continue;
      out.push(String(m[1] || "<anon>").replace(/^async\s+/, "").replace(/^(?:new\s+)?(?:Object|Array|Promise|Window|Node|Element|HTMLElement)\./, ""));
      if (out.length >= max) break;
    }
    return out.join(" < ");
  };

  const desc = (n) => {
    if (!n || n.nodeType !== 1) return n ? n.nodeName : "";
    const cn = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    const d = n.dataset || {};
    const id = d.project ? `[${d.project}]` : d.out ? `[out ${String(d.out).slice(0, 8)}]` : "";
    return `${n.tagName.toLowerCase()}${cn ? `.${cn}` : ""}${id}`;
  };

  // ---- the DOM primitives, filtered to subtrees that carry a console ---------------------------------------------------
  const carries = (nodes) => {
    for (const n of nodes) {
      if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
      if (n.nodeType === 1 && n.matches && n.matches("pre.job-out")) return true;
      if (n.querySelector && n.querySelector("pre.job-out")) return true;
    }
    return false;
  };
  const wrap = (proto, name, pick) => {
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__lagm) return;
    const w = function () {
      let carry = false;
      let node = "";
      let op = name;
      try {
        const p = pick(this, arguments);
        carry = carries(p);
        node = desc((p || []).find((n) => n && n.nodeType === 1));
      } catch {
        /* never break the page */
      }
      const r = orig.apply(this, arguments);
      try {
        if (carry && R.armed && !R.stopped) push("move", `${op} ${node} <- ${pageStack(3)}`);
      } catch {
        /* ignore */
      }
      return r;
    };
    w.__lagm = true;
    proto[name] = w;
  };
  wrap(Node.prototype, "insertBefore", (s, a) => [a[0]]);
  wrap(Node.prototype, "appendChild", (s, a) => [a[0]]);
  wrap(Element.prototype, "after", (s, a) => a);
  wrap(Element.prototype, "before", (s, a) => a);
  wrap(Element.prototype, "append", (s, a) => a);
  wrap(Element.prototype, "replaceWith", (s, a) => [s, ...a]);
  wrap(Element.prototype, "replaceChildren", (s, a) => [...s.children, ...a]);
  wrap(Element.prototype, "remove", (s) => [s]);

  // ---- the page's own entry points ------------------------------------------------------------------------------------
  // `setScroll` gets its own wrapper because the value ASKED for is the one thing a later frame cannot reconstruct.
  const wrapped = [];
  const wrapFn = (name) => {
    const orig = window[name];
    if (typeof orig !== "function" || orig.__lagw) return false;
    const idOf = (el) => String((el && el.dataset && (el.dataset.out || el.dataset.subConsoleBox)) || "").slice(0, 8);
    const w = function () {
      R.calls[name] = (R.calls[name] || 0) + 1;
      // Geometry is read in here ONLY for a console the sampler has already seen off the bottom, so a healthy run pays
      // nothing and a stuck one gets the numbers its writer saw. `stickConsole` reads scrollHeight first thing anyway,
      // so the read here is the read it was about to make.
      const el = arguments[0];
      const watching = R.armed && !R.stopped && el && el.nodeType === 1 && (opts.deep || (lastLag.get(el) || 0) > R.thresh);
      if (name === "setScroll") {
        const asked = Math.round(Number(arguments[1]) || 0);
        // Kept per console so an excursion can say what the page ASKED for and when: a write the browser clamped is
        // the difference between "nothing put it back" and "something put it back and the layout ate it".
        if (el && el.dataset) lastWrite.set(el.dataset.out || el.dataset.subConsoleBox || "", { t: now(), asked });
        if (R.armed && !R.stopped) {
          R.writes += 1;
          const at = watching ? ` from top ${Math.round(el.scrollTop)} of ${Math.round(el.scrollHeight - el.clientHeight)}` : "";
          push("write", `setScroll(${idOf(el)}) asked ${asked}${at} <- ${pageStack(3)}`);
        }
      } else if (name === "stickConsole" || name === "stickSubConsole") {
        if (watching) push("fn", `${name}(${idOf(el)}) SAW top ${Math.round(el.scrollTop)} max ${Math.round(el.scrollHeight - el.clientHeight)}`);
        const r = orig.apply(this, arguments);
        if (watching) push("fn", `${name}(${idOf(el)}) AFTER top ${Math.round(el.scrollTop)} max ${Math.round(el.scrollHeight - el.clientHeight)}`);
        return r;
      } else if (R.armed && !R.stopped) push("fn", name);
      return orig.apply(this, arguments);
    };
    w.__lagw = true;
    window[name] = w;
    wrapped.push(name);
    return true;
  };
  window.__wrap = (names) => {
    const missed = [];
    for (const n of names) if (!wrapFn(n)) missed.push(n);
    R.wrapMissed = missed;
    return missed;
  };

  // ---- the per-frame record -------------------------------------------------------------------------------------------
  const seen = new Set();
  const prev = new Map();
  const open = new Map();
  // What the last frame saw, per console: the wrappers use it to decide whether a call is worth geometry.
  const lastLag = new Map();
  const lastPin = new Map();
  const lastWrite = new Map();
  const recent = (t, ms, cap) => {
    const out = [];
    for (let i = R.timeline.length - 1; i >= 0; i--) {
      const e = R.timeline[i];
      if (e.t > t) continue;
      if (t - e.t > ms) break;
      out.unshift(`${Math.round((t - e.t) * 10) / 10}ms ${e.k} ${e.w}`);
      if (out.length >= cap) break;
    }
    return out;
  };
  const between = (a, b, cap) => {
    const out = [];
    for (const e of R.timeline) {
      if (e.t <= a) continue;
      if (e.t > b) break;
      out.push(`${Math.round((e.t - a) * 10) / 10}ms ${e.k} ${e.w}`);
      if (out.length >= cap) break;
    }
    return out;
  };
  const shapeOf = (p, top, max) => {
    if (!p) return "new";
    if (p.top - top > 2) return "clamped";
    if (max - p.max > 2 && Math.abs(p.top - top) <= 2) return "frozen";
    if (max - p.max > 2 && top - p.top > 2) return "grown-with-top";
    return "other";
  };
  const pinnedOf = (id) => {
    try {
      return state.outPinned[id] !== false;
    } catch {
      return true;
    }
  };

  const sample = () => {
    if (R.stopped) return;
    R.frames += 1;
    const t = now();
    const els = document.querySelectorAll("pre.job-out");
    R.consoles = els.length;
    for (const el of els) {
      const top = Math.round(el.scrollTop);
      const max = Math.round(el.scrollHeight - el.clientHeight);
      const id = el.dataset.out || "";
      if (max > 20) {
        seen.add(id);
        if (R.armN && R.overflowAt == null && seen.size >= R.armN) R.overflowAt = t;
      }
      const lag = Math.max(0, max - top);
      lastLag.set(el, max > 20 ? lag : 0);
      const p = prev.get(el) || null;
      prev.set(el, { top, max });
      // The distribution the excursions are cut out of, counted for the whole run.
      if (max > 20) {
        R.sampledFrames += 1;
        if (lag > R.thresh) R.overFrames += 1;
        if (lag > R.lagMax) R.lagMax = lag;
        const k = id || "?";
        if (lag > (R.perConsoleMax[k] || 0)) R.perConsoleMax[k] = lag;
      }
      if (!R.armed) continue;
      const pin = pinnedOf(id);
      if (lastPin.has(el) && lastPin.get(el) !== pin) push("pin", `${id.slice(0, 8)} ${pin ? "pinned" : "UNPINNED"}`);
      lastPin.set(el, pin);
      const bad = max > 20 && lag > R.thresh;
      let rec = open.get(el);
      if (bad && !rec) {
        if (R.excursions.length >= 600) continue;
        const w = lastWrite.get(id);
        rec = {
          t0: t,
          out: id,
          lag0: lag,
          lagMax: lag,
          top0: top,
          max0: max,
          prevTop: p ? p.top : top,
          prevMax: p ? p.max : max,
          shape: shapeOf(p, top, max),
          pinned0: pin,
          // A write the browser clamped: the page asked for a position the layout did not have yet.
          writeAsked: w && t - w.t < 400 ? w.asked : null,
          writeDt: w && t - w.t < 400 ? Math.round((t - w.t) * 10) / 10 : null,
          frames: 1,
          before: recent(t, 220, 6),
        };
        open.set(el, rec);
        R.excursions.push(rec);
      } else if (bad && rec) {
        rec.lagMax = Math.max(rec.lagMax, lag);
        rec.frames += 1;
      } else if (!bad && rec) {
        rec.t1 = t;
        rec.dur = Math.round((t - rec.t0) * 10) / 10;
        rec.top1 = top;
        rec.max1 = max;
        rec.repairedBy = recent(t, 200, 3).filter((s) => !s.includes("pin "));
        rec.during = between(rec.t0, t, 4);
        open.delete(el);
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  window.__arm = (n) => {
    R.armN = n;
  };
  window.__start = () => {
    R.armed = true;
  };
  window.__stop = () => {
    R.stopped = true;
  };

  // ---- the injected triggers ------------------------------------------------------------------------------------------
  // Each one is the page's own entry point, called with the arguments the page itself would pass. Nothing is stubbed and
  // no code path is skipped: `sseProject` dispatches a real `project` MessageEvent on the page's own EventSource with the
  // project object the server last sent it, so the handler under test runs exactly as it does on a real frame.
  const pickKey = () => {
    for (const [key] of state.detailEls) {
      const d = document.querySelector(`tr.detail[data-detail="${CSS.escape(key)}"]`);
      if (d && d.querySelector("pre.job-out")) return key;
    }
    return null;
  };
  const fire = (kind) => {
    const key = pickKey();
    if (!key) return "no open detail";
    const row = state.rows.get(key);
    if (!row) return "no row";
    R.injected.push({ t: now(), kind });
    push("inject", kind);
    if (kind === "placeRow") {
      // The row the page already holds, handed back to placeRow: this is the detail swap and nothing else. The data is
      // unchanged, so `moved` is false and no flash or rank change rides along with it.
      placeRow(row.project, { ...row });
      return "ok";
    }
    if (kind === "renderAll") {
      renderAll();
      return "ok";
    }
    if (kind === "sseProject") {
      const p = state.projects.get(row.project);
      if (!p) return "no project";
      const data = JSON.stringify({ project: JSON.parse(JSON.stringify(p)) });
      state.es.dispatchEvent(new MessageEvent("project", { data }));
      return "ok";
    }
    if (kind === "all7d") {
      const root = rootOf(state.projects.get(row.project));
      toggleRootRecent(root);
      return "ok";
    }
    return "unknown";
  };
  window.__fire = fire;

  // The clamp pair. A raw re-append of an open section is the one thing that really resets a console in this browser
  // (docs/console-scroll-hop.md §5); here it is the *cause*, and the question is what the page does about it while a
  // keypress has landed somewhere else on the page inside lastInputAt's 1200 ms window.
  window.__startClamp = (everyMs) => {
    let n = 0;
    return setInterval(() => {
      if (R.stopped) return;
      try {
        const els = [...document.querySelectorAll("pre.job-out")].filter((o) => o.scrollHeight - o.clientHeight > 20);
        if (els.length < 2) return;
        // Alternate between the two consoles, so each is clamped on its own and neither is always the victim.
        const el = els[n % 2];
        n += 1;
        const sec = el.closest("section.project");
        if (!sec || !sec.parentNode) return;
        const before = { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), id: el.dataset.out };
        R.injected.push({ t: now(), kind: "clamp", out: before.id, top: before.top, max: before.max });
        push("inject", `clamp ${String(before.id).slice(0, 8)} from ${before.top}/${before.max}`);
        sec.parentNode.appendChild(sec);
      } catch (e) {
        R.errors.push(`clamp: ${String((e && e.message) || e)}`.slice(0, 200));
      }
    }, everyMs);
  };
  window.__startKeys = (everyMs) => {
    let n = 0;
    return setInterval(() => {
      if (R.stopped) return;
      n += 1;
      // Any keypress anywhere on the page, which is what lastInputAt records.
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
      push("key", `keydown #${n}`);
    }, everyMs);
  };
  window.__startInjects = (kind, everyMs) => {
    return setInterval(() => {
      if (R.stopped) return;
      try {
        fire(kind);
      } catch (e) {
        R.errors.push(`inject ${kind}: ${String((e && e.message) || e)}`.slice(0, 200));
      }
    }, everyMs);
  };
  // Where every console stands, on demand - the pin state is a page variable, not a DOM property.
  window.__pins = () => {
    const out = {};
    for (const el of document.querySelectorAll("pre.job-out")) out[el.dataset.out] = pinnedOf(el.dataset.out);
    return out;
  };
}

// ---- fixtures -----------------------------------------------------------------------------------------------------------
function git(args, cwd) {
  return execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}
function makeRepo(dir, name) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "first"], dir);
}
const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- one scenario -------------------------------------------------------------------------------------------------------
async function runScenario(name, spec, pw, startPanel) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-lag-"));
  const rootA = path.join(work, "rootA");
  for (const n of ["alpha", "beta", "g1", "g2", "g3", "g4"]) makeRepo(path.join(rootA, n), n);
  const closed = ["g1", "g2", "g3", "g4"].map((n) => path.join(rootA, n));
  const cards =
    spec.cards === "projects"
      ? [{ project: "alpha" }, { project: "beta" }]
      : spec.cards === "one-row"
        ? [{ project: "alpha" }, { project: "alpha" }]
        : [{ project: "alpha" }, { project: "alpha", branch: "feature-b" }];
  const cardCwd = (c) => (c.branch ? path.join(rootA, c.project, ".worktrees", c.branch) : path.join(rootA, c.project));
  for (const c of cards) if (c.branch) git(["worktree", "add", "-q", "-b", c.branch, cardCwd(c)], path.join(rootA, c.project));

  const gw = makeGateway(600_000);
  const gwPort = await gw.listen();
  // A quiet board keeps the panel's own clocks out of the way so a lag can only come from the injected trigger. The
  // cards still stream: jobline frames ride the run's own SSE, not the scan.
  const sandbox = await startPanel({
    dir: work,
    config: {
      scanRoots: [rootA],
      projects: [],
      refreshSeconds: spec.quiet ? 3600 : 30,
      worktreeSeconds: spec.quiet ? 3600 : 5,
      midSeconds: 3600,
      dormantSeconds: 3600,
      liveSeconds: 5,
      slowSeconds: 3600,
      fetchSeconds: -1,
      prCacheSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: rootA,
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
    env: { API_SERVER_KEY: "" },
  });
  const browser = await pw.chromium.launch({ headless: HEADLESS });
  let touch = null;
  let timers = [];
  const out = { scenario: name, desc: spec.desc, failures: [], notMeasured: [], errors: [], excursions: [], injected: [], rank: null };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    // The reorder clock is the page's own 5 s pass: ON for the natural board and for `rankOnly`, OFF where a single
    // injected trigger has to be the only thing that moves.
    const reorderOff = spec.quiet ? !spec.rankOn : false;
    await page.addInitScript(pageInit, { thresh: THRESH, reorderOff, stabilizeOff: Boolean(spec.stabilizeOff), armN: cards.length, deep: DEEP });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
    await page.waitForFunction((names) => names.every((n) => [...state.projects.keys()].includes(n)), [...new Set(cards.map((c) => c.project))], { timeout: 60_000 });
    const missed = await page.evaluate(() =>
      window.__wrap([
        "setScroll",
        "stickConsole",
        "stickSubConsole",
        "restoreScrolls",
        "applyStoredScrolls",
        "settleScrolls",
        "holdScrolls",
        "releaseScrolls",
        "captureScrolls",
        "placeRow",
        "renderAll",
        "renderProjectRows",
        "renderRoot",
        "toggleRootRecent",
        "reorderProjects",
        "reorderAgentCards",
        "fillAgentSlots",
        "applySnapshot",
        "updateJob",
        "queueRow",
        "drawJobLine",
        "appendJobLine",
        "paintTypedLines",
        "scheduleRenderJobs",
        "renderJobs",
      ]),
    );
    out.wrapMissed = missed;
    const wantRows = cards.map((c) => ({ project: c.project, path: norm(cardCwd(c)) }));
    await page.waitForFunction(
      (w) =>
        w.every((x) =>
          [...state.rows.values()].some(
            (r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path,
          ),
        ),
      wantRows,
      { timeout: 60_000 },
    );
    const spawned = [];
    for (const [i, c] of cards.entries()) {
      const thread = `lag-${name}-${i + 1}`;
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: stream plain text #${i + 1}`, cwd: cardCwd(c), existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed for ${JSON.stringify(c)}: ${JSON.stringify(r).slice(0, 300)}`);
      spawned.push({ thread, job: r.job.id });
    }
    if (!spec.quiet) {
      // The churn that makes the ranking move on a real board of a hundred repos.
      touch = setInterval(() => {
        const pick = closed[Math.floor(Date.now() / 4000) % closed.length];
        try {
          writeFileSync(path.join(pick, `probe-${Date.now()}.txt`), "activity\n");
        } catch {
          /* the next tick picks another */
        }
      }, 4000);
      touch.unref?.();
    }
    await page.waitForFunction((threads) => threads.every((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t)), spawned.map((s) => s.thread), { timeout: 60_000 });
    await page.evaluate((w) => {
      for (const x of w) {
        const row = [...state.rows.values()].find(
          (r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path,
        );
        if (!row) continue;
        state.expandedProjects.add(x.project);
        state.expanded.add(`${x.project}::${row.path}`);
      }
      renderAll();
    }, wantRows);
    for (const s of spawned) await page.waitForSelector(`.job[data-thread="${s.thread}"] pre.job-out`, { timeout: 45_000 });
    const t0 = Date.now();
    await page.waitForFunction(() => window.__lag.overflowAt != null, null, { timeout: MAX_WAIT_MS, polling: 250 }).catch(() => {});
    const overflowAt = await page.evaluate(() => window.__lag.overflowAt);
    if (overflowAt == null) {
      out.notMeasured.push(`the consoles did not all overflow within ${Math.round(MAX_WAIT_MS / 1000)} s`);
      return out;
    }
    log(name, `${spawned.length} console(s) overflowing after ${Math.round((Date.now() - t0) / 1000)} s; measuring ${SECONDS} s${spec.quiet ? " (quiet board)" : ""}`);
    await page.evaluate(() => window.__start());
    if (spec.inject === "clamp") {
      timers.push(await page.evaluate((ms) => window.__startClamp(ms), INJECT_MS));
      if (spec.keys) timers.push(await page.evaluate((ms) => window.__startKeys(ms), KEY_MS));
    } else if (spec.inject) {
      timers.push(await page.evaluate(([k, ms]) => window.__startInjects(k, ms), [spec.inject, INJECT_MS]));
    }
    for (;;) {
      const t = await page.evaluate(() => window.__now());
      if (t >= overflowAt + SECONDS * 1000) break;
      await sleep(Math.min(1000, overflowAt + SECONDS * 1000 - t));
    }
    const rec = await page.evaluate(() => {
      window.__stop();
      return {
        excursions: window.__lag.excursions,
        injected: window.__lag.injected,
        errors: window.__lag.errors,
        frames: window.__lag.frames,
        writes: window.__lag.writes,
        consoles: window.__lag.consoles,
        overflowAt: window.__lag.overflowAt,
        pins: window.__pins(),
        thresh: window.__lag.thresh,
        calls: window.__lag.calls,
        lagMax: window.__lag.lagMax,
        overFrames: window.__lag.overFrames,
        sampledFrames: window.__lag.sampledFrames,
        perConsoleMax: window.__lag.perConsoleMax,
      };
    });
    out.excursions = rec.excursions;
    out.injected = rec.injected;
    out.frames = rec.frames;
    out.writes = rec.writes;
    out.pins = rec.pins;
    out.thresh = rec.thresh;
    out.calls = rec.calls;
    out.lagMax = rec.lagMax;
    out.overFrames = rec.overFrames;
    out.sampledFrames = rec.sampledFrames;
    out.perConsoleMax = rec.perConsoleMax;
    out.consoles = rec.consoles;
    out.errors.push(...rec.errors);
    out.overflowAt = overflowAt;
    out.window = Math.round(SECONDS * 1000);
    return out;
  } finally {
    if (touch) clearInterval(touch);
    for (const t of timers) clearInterval(t);
    await browser.close().catch(() => {});
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

// ---- the report ----------------------------------------------------------------------------------------------------------
const q = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const r1 = (n) => Math.round(Number(n) * 10) / 10;

function summarise(o) {
  const ex = o.excursions.filter((e) => e.dur != null);
  const lags = ex.map((e) => e.lagMax);
  const durs = ex.map((e) => e.dur);
  const byShape = {};
  const byCause = {};
  const byWrite = { clamped: 0, landed: 0, none: 0 };
  for (const e of ex) {
    byShape[e.shape] = (byShape[e.shape] || 0) + 1;
    const first = (e.before || []).slice().reverse().find((s) => /\s(fn|move|inject|write)\s/.test(s));
    const label = first ? first.replace(/^\S+\s+/, "").split(" ").slice(0, 3).join(" ") : "nothing within 220 ms";
    byCause[label] = (byCause[label] || 0) + 1;
    if (e.writeAsked == null) byWrite.none += 1;
    else if (e.top0 < e.writeAsked - 2) byWrite.clamped += 1;
    else byWrite.landed += 1;
  }
  return {
    scenario: o.scenario,
    desc: o.desc,
    windowMs: o.window,
    frames: o.frames,
    consoles: o.consoles,
    thresh: o.thresh,
    excursions: ex.length,
    openAtEnd: o.excursions.length - ex.length,
    totalLagMs: Math.round(durs.reduce((a, b) => a + b, 0)),
    lagPx: { p50: q(lags, 50), p90: q(lags, 90), max: lags.length ? Math.max(...lags) : 0 },
    durMs: { p50: q(durs, 50), p90: q(durs, 90), max: durs.length ? Math.max(...durs) : 0 },
    perConsole: ex.reduce((m, e) => ((m[e.out] = (m[e.out] || 0) + 1), m), {}),
    byShape,
    byCause,
    byWrite,
    injected: o.injected.length,
    writes: o.writes,
    calls: o.calls || {},
    lagMax: o.lagMax || 0,
    overFrames: o.overFrames || 0,
    sampledFrames: o.sampledFrames || 0,
    perConsoleMax: o.perConsoleMax || {},
    wrapMissed: o.wrapMissed || [],
    errors: o.errors,
    notMeasured: o.notMeasured,
    pins: o.pins,
  };
}

// ---- the reader's own panel, read-only -----------------------------------------------------------------------------------
// The sandbox drives a stub. This attaches to a panel that is ALREADY streaming (the reader's, or another worker's) and
// measures what its consoles really do: nothing is posted, nothing is clicked, and the only thing done in the tab is
// opening the rows of the runs that are live right now, which is a page-local variable, not a server write.
async function runLive(base, pw) {
  const browser = await pw.chromium.launch({ headless: HEADLESS });
  const out = { scenario: "live", desc: `the live panel at ${base}, read-only, ${LIVE_ROWS} live row(s) opened`, failures: [], notMeasured: [], errors: [], excursions: [], injected: [] };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await page.addInitScript(pageInit, { thresh: THRESH, armN: LIVE_ROWS, deep: DEEP });
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 60_000 });
    await page.waitForFunction(() => state.rows.size > 0, null, { timeout: 120_000 });
    const missed = await page.evaluate(() =>
      window.__wrap([
        "setScroll",
        "stickConsole",
        "stickSubConsole",
        "restoreScrolls",
        "applyStoredScrolls",
        "settleScrolls",
        "holdScrolls",
        "releaseScrolls",
        "captureScrolls",
        "placeRow",
        "renderAll",
        "renderProjectRows",
        "renderRoot",
        "toggleRootRecent",
        "reorderProjects",
        "reorderAgentCards",
        "fillAgentSlots",
        "applySnapshot",
        "updateJob",
        "queueRow",
        "drawJobLine",
        "appendJobLine",
        "paintTypedLines",
        "scheduleRenderJobs",
        "renderJobs",
      ]),
    );
    out.wrapMissed = missed;
    const opened = await page.evaluate(([want, want2]) => {
      const n = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const running = [...state.jobs.values()].filter((j) => j.status === "running");
      const paths = new Set(running.map((j) => n(j.cwd || j.ownerPath || "")).filter(Boolean));
      const hits = [...state.rows.values()].filter((r) => paths.has(n(r.path)));
      const narrowed = want2 ? hits.filter((r) => n(r.path).includes(want2)) : hits;
      const picked = (narrowed.length ? narrowed : hits).slice(0, want);
      for (const r of picked) {
        state.expandedProjects.add(r.project);
        state.expanded.add(`${r.project}::${r.path}`);
      }
      if (picked.length) renderAll();
      return picked.map((r) => ({ project: r.project, path: r.path, thread: [...state.jobs.values()].find((j) => j.status === "running" && n(j.cwd || "") === n(r.path))?.thread || "" }));
    }, [LIVE_ROWS, String(LIVE_MATCH || "").toLowerCase()]);
    out.opened = opened;
    if (!opened.length) {
      out.notMeasured.push("no running job's row is on this board, so there is no live console to watch");
      return out;
    }
    log("live", `opened ${opened.map((o) => o.project).join(", ")}; waiting for their consoles to overflow`);
    for (const o of opened) if (o.thread) await page.waitForSelector(`.job[data-thread="${o.thread}"] pre.job-out`, { timeout: 45_000 }).catch(() => {});
    const t0 = Date.now();
    await page.waitForFunction(() => window.__lag.overflowAt != null, null, { timeout: MAX_WAIT_MS, polling: 250 }).catch(() => {});
    const overflowAt = await page.evaluate(() => window.__lag.overflowAt);
    if (overflowAt == null) {
      out.notMeasured.push(`fewer than ${LIVE_ROWS} console(s) overflowed within ${Math.round(MAX_WAIT_MS / 1000)} s`);
      return out;
    }
    log("live", `${LIVE_ROWS} console(s) overflowing after ${Math.round((Date.now() - t0) / 1000)} s; measuring ${SECONDS} s`);
    await page.evaluate(() => window.__start());
    for (;;) {
      const t = await page.evaluate(() => window.__now());
      if (t >= overflowAt + SECONDS * 1000) break;
      await sleep(Math.min(1000, overflowAt + SECONDS * 1000 - t));
    }
    const rec = await page.evaluate(() => {
      window.__stop();
      return {
        excursions: window.__lag.excursions,
        injected: window.__lag.injected,
        errors: window.__lag.errors,
        frames: window.__lag.frames,
        writes: window.__lag.writes,
        consoles: window.__lag.consoles,
        pins: window.__pins(),
        thresh: window.__lag.thresh,
        calls: window.__lag.calls,
        lagMax: window.__lag.lagMax,
        overFrames: window.__lag.overFrames,
        sampledFrames: window.__lag.sampledFrames,
        perConsoleMax: window.__lag.perConsoleMax,
      };
    });
    Object.assign(out, { ...rec, window: Math.round(SECONDS * 1000), overflowAt });
    out.excursions = rec.excursions;
    out.injected = rec.injected;
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---- main ----------------------------------------------------------------------------------------------------------------
const spec = SCENARIOS[SCENARIO];
if (!spec) {
  console.log(`unknown --scenario ${SCENARIO}; one of: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log(notRun("tools/measure-console-lag.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}

let o;
if (LIVE_URL) {
  try {
    o = await runLive(LIVE_URL, pw);
  } catch (e) {
    console.log(`[live] the run did not complete: ${String((e && e.message) || e).slice(0, 600)}`);
    process.exit(2);
  }
} else {
  const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
  try {
    o = await runScenario(SCENARIO, spec, pw, startPanel);
  } catch (e) {
    console.log(`[${SCENARIO}] the run did not complete: ${String((e && e.message) || e).slice(0, 600)}`);
    process.exit(2);
  }
}
const s = summarise(o);
const rate = (n) => r1((n / Math.max(1, s.windowMs)) * 75_000);

console.log("");
console.log(`[${s.scenario}] ${s.desc}`);
console.log(`[${s.scenario}] ${s.consoles} console(s), ${s.frames} frames, ${Math.round(s.windowMs / 1000)} s window, threshold ${s.thresh} px`);
if (s.notMeasured.length) for (const m of s.notMeasured) console.log(`[${s.scenario}] NOT MEASURED: ${m}`);
console.log(`[${s.scenario}] lag>${s.thresh}px: ${s.excursions} excursion(s) (${rate(s.excursions)} per 75 s), ${s.totalLagMs} ms total, ${s.openAtEnd} still open at the end`);
console.log(
  `[${s.scenario}] every console-frame: ${s.overFrames}/${s.sampledFrames} above ${s.thresh} px, worst lag ${s.lagMax} px (${Object.entries(s.perConsoleMax)
    .map(([k, v]) => `${String(k).slice(0, 8)} ${v}`)
    .join(", ")})`,
);
if (s.wrapMissed.length) console.log(`[${s.scenario}] not wrapped (not a page global here): ${s.wrapMissed.join(", ")}`);
if (s.excursions) {
  console.log(`[${s.scenario}]   lag px   p50 ${s.lagPx.p50}   p90 ${s.lagPx.p90}   max ${s.lagPx.max}`);
  console.log(`[${s.scenario}]   dur ms   p50 ${s.durMs.p50}   p90 ${s.durMs.p90}   max ${s.durMs.max}`);
  console.log(`[${s.scenario}]   shape    ${Object.entries(s.byShape).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`[${s.scenario}]   nearest event before it: ${Object.entries(s.byCause).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}x ${k}`).join(" | ")}`);
  console.log(`[${s.scenario}]   a setScroll write within 400 ms before it: ${s.byWrite.none} none, ${s.byWrite.clamped} did not land (asked > where the box sat), ${s.byWrite.landed} landed`);
  console.log(`[${s.scenario}]   per console: ${Object.entries(s.perConsole).map(([k, v]) => `${String(k).slice(0, 8)} ${v}`).join(", ")}`);
}
console.log(`[${s.scenario}] injected ${s.injected} trigger(s); ${s.writes} setScroll write(s); pins ${JSON.stringify(s.pins)}`);
const calls = Object.entries(s.calls).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
if (calls.length) console.log(`[${s.scenario}] page calls: ${calls.map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (s.errors.length) for (const e of s.errors.slice(0, 5)) console.log(`[${s.scenario}] PAGE ERROR: ${e}`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ summary: s, raw: o }, null, 2));
  console.log(`[${s.scenario}] wrote ${JSON_OUT}`);
}
if (s.errors.length) process.exit(1);
if (s.notMeasured.length || !s.excursions) {
  // No excursion is not a failure of the tool - it is the answer for this scenario - but it must be stated as such.
  process.exit(s.notMeasured.length ? 2 : 0);
}
process.exit(0);
