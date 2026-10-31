// Slot C of the console-popping campaign: does a live agent's console pop while it writes, and does its tail hold?
//
//   node tools/pop-c.mjs --spawn --thread pop-c-combined          # start one real agent run on the 7334 instance
//   node tools/pop-c.mjs --measure --thread pop-c-combined --mode combined --seconds 150
//   node tools/pop-c.mjs --measure --thread pop-c-separated --mode separated --seconds 150
//
// WHAT THIS MEASURES. On a real run of my own panel instance (port 7334; its own config, data dir and scratch), the
// page is opened in Chromium with the run's card expanded and, every animation frame, every overflowing console box is
// sampled: `scrollTop`, `scrollHeight`, `clientHeight`, the distance from the bottom, whether it is pinned at the tail,
// the box's own position and height on the page, and how many rows it holds. Two boxes are possible per card:
//
//   output   `pre.job-out` - the main output console (data-out = the turn's id)
//   reason   `details.think .think-body` - the reasoning in its OWN box (default renderer, thinking on)
//
// In the 🌊 stream renderer (`--mode combined`) the reasoning is not a separate box: it is rows of the console itself
// (`pre.job-out .jl-think`), so the same card has one box, and the tool records how many reasoning rows that console
// is carrying. Nothing in this tool writes to the panel, the run or the repo: it reads the page and the store.
//
// WHAT IT REPORTS, per box, over the window
//   hops        a frame whose scrollTop dropped by more than 20 px while the previous frame was pinned and nothing
//               scrolled the box (a scrollTop write on the box is recorded by a wrapped setter, so a hop that IS a
//               scroll write is labelled as one instead of being counted as a layout reset). Count, times, biggest drop,
//               and who moved it: a DOM re-append/insert inside the box, a content replacement, a resize, or a scroll.
//   retention   the longest continuous run of frames with distance <= 8 px while output was being appended (an append
//               is a frame where the box's scrollHeight grew; a gap of more than 2 s between appends ends the run).
//               The reader's question is whether the tail holds for 60 s or more.
//   lag         excursions where the distance from the bottom is > 8 px: count, duration p50/p90/max, depth p50/p90/max.
//   direction   up-only / down-only / both, from the direction of the box's own jumps.
//
// The window is --window seconds (default 75, the campaign's minimum) counted from the moment EVERY expected box
// overflows; the capture itself runs for --seconds (default 150) or until the run stops writing, so the doc can also
// say what the tail did beyond the official window.
//
// Exit codes: 0 measured; 2 the run did not produce the condition (no Playwright, no live job with that thread, a box
// that never overflowed, the console drew nothing) - a clean number over an empty window proves nothing.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const MODE = String(opt("--mode", "combined"));
const THREAD = opt("--thread");
const BASE = String(opt("--base", "http://127.0.0.1:7334")).replace(/\/+$/, "");
const CWD = String(opt("--cwd", "C:/Users/roper/AppData/Local/Temp/wag/pop-c/fixture/pop-c-fixture"));
const SECONDS = Number(opt("--seconds", 150));
const WINDOW = Number(opt("--window", 75));
const REPORT = String(opt("--report", "C:/Users/roper/AppData/Local/Temp/wag/pop-c/reports"));
const SPAWN = argv.includes("--spawn");
const HEADED = argv.includes("--headed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "-");

// ---- the fixture prompt ------------------------------------------------------------------------------------------
// A real run that writes for minutes: reasoning before every tool call, two terminal calls per cycle, both of them
// append/read a file under the pop-c scratch tree and nothing else. It is a fixture, not a task: no commits, no pushes.
const PROMPT = `Fixture run - measurement only, not a real task.

Where to work: stay inside C:/Users/roper/AppData/Local/Temp/wag/pop-c/agentbox and nowhere else. Never read, write, list or run anything under C:/ProjectDevelopment or C:/CodeReviews or the user's home directory. Make no git commits, no pushes and no network calls. Always use absolute paths in your terminal commands.

Repeat the cycle below 30 times, then stop.

Cycle:
1. Think for four to six sentences about what this cycle will check and why. This reasoning is the thing being measured, so make it substantial.
2. Run ONE terminal command that appends a single line (for example "cycle 3 ok") to C:/Users/roper/AppData/Local/Temp/wag/pop-c/agentbox/notes.log, creating the file if it is missing. Use node -e with forward slashes, e.g.
   node -e "require('fs').appendFileSync('C:/Users/roper/AppData/Local/Temp/wag/pop-c/agentbox/notes.log','cycle 3 ok\\n')"
3. Run ONE more terminal command that prints six to ten short lines from that file, e.g. a wc -l followed by a tail of the last five lines.
4. Say one short sentence about what the two commands reported.

Do not batch cycles together, do not run two commands in one call, and do not stop early. After the thirtieth cycle, reply with exactly DONE-MEASURING.
`;

async function jobs() {
  const r = await fetch(`${BASE}/api/jobs`);
  if (!r.ok) throw new Error(`GET /api/jobs -> ${r.status}`);
  return r.json();
}

if (SPAWN) {
  const thread = THREAD || `pop-c-${Date.now().toString(36)}`;
  const r = await fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: opt("--project", "pop-c-fixture"),
      cwd: CWD,
      existing: true,
      thread,
      prompt: PROMPT,
      model: opt("--model", "deepseek/deepseek-v4.1-flash-1017"),
      reasoningEffort: opt("--effort", "medium"),
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!body.job) {
    log(`SPAWN REFUSED ${r.status}: ${JSON.stringify(body).slice(0, 600)}`);
    process.exit(2);
  }
  log(`spawned job ${body.job.id} · thread ${body.job.thread} · run ${body.job.runId} · status ${body.job.status}`);
  process.exit(0);
}

if (!THREAD) {
  log("--thread <thread> is required (--spawn prints one)");
  process.exit(2);
}

// ---- the page-side recorder --------------------------------------------------------------------------------------
// Installed before the page's own scripts: the two localStorage keys the campaign is about (thinking on, stream mode as
// asked) must be set before the first card is drawn, or the card is rendered in the other mode for a frame.
function init({ thread, mode }) {
  localStorage.setItem("wtgui.think", "1");
  localStorage.setItem(`wtgui.think.${thread}`, "1");
  localStorage.setItem(`wtgui.stream.${thread}`, mode === "combined" ? "1" : "0");
}

// The recorder. Runs in the page; reads only. One sample per animation frame, taken AFTER that frame has been
// painted: the rAF callback schedules a setTimeout(0), which runs once the frame's paint is done, so a dip the page
// repairs in a later rAF callback of the same frame is not counted as a painted hop. Each measured box is also
// observed (child/text mutations, scroll events) so a hop can be attributed instead of merely counted.
function recorder({ thread, mode, windowMs }) {
  const boxIds = new WeakMap();
  let boxSeq = 0;
  const idOf = (el) => {
    if (!boxIds.has(el)) boxIds.set(el, `b${++boxSeq}`);
    return boxIds.get(el);
  };
  const keyFor = (el) =>
    el.matches("pre.job-out")
      ? `output:${el.dataset.out || ""}:${idOf(el)}`
      : `reason:${el.closest("details.think")?.dataset.thinkTurn || ""}:${idOf(el)}`;
  const mine = (el) => {
    const card = el.closest(".job");
    return card && card.dataset.thread === thread;
  };
  const measured = new Map(); // element -> { key, kind }
  const frames = [];
  const ops = []; // DOM surgery that touched a measured box (or an ancestor/descendant of one)
  const scrollWrites = []; // scrollTop / scrollTo / scrollIntoView calls ON a measured box
  const events = []; // what happened to a box between two samples: scroll events and mutations
  const serials = new WeakMap();
  let serialSeq = 0;
  const lastSerial = new Map();
  let armed = false;
  let raf = 0;
  let timer = 0;
  let overflowAt = null;
  let lastAt = null;
  const expectedKinds = () => (mode === "combined" ? ["output"] : ["output", "reason"]);

  // ---- a box's own scroll events and mutations -------------------------------------------------------------------
  function watch(el, key) {
    const mo = new MutationObserver((list) => {
      let added = 0;
      let removed = 0;
      let chars = 0;
      for (const m of list) {
        if (m.type === "characterData") chars += 1;
        else {
          added += m.addedNodes ? m.addedNodes.length : 0;
          removed += m.removedNodes ? m.removedNodes.length : 0;
        }
      }
      const attrs = list.filter((m) => m.type === "attributes").length;
      events.push({ t: performance.now(), k: key, kind: "mut", added, removed, chars, attrs });
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "open", "hidden"] });
    el.addEventListener(
      "scroll",
      () => events.push({ t: performance.now(), k: key, kind: "scroll", st: el.scrollTop }),
      { passive: true },
    );
  }

  // ---- who moves a box: the scrollTop setter and the scroll APIs --------------------------------------------------
  const elProto = Element.prototype;
  const desc = Object.getOwnPropertyDescriptor(elProto, "scrollTop");
  Object.defineProperty(elProto, "scrollTop", {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      return desc.get.call(this);
    },
    set(v) {
      const m = measured.get(this);
      if (m) scrollWrites.push({ t: performance.now(), k: m.key, v: Number(v), op: "scrollTop=" });
      return desc.set.call(this, v);
    },
  });
  for (const name of ["scrollTo", "scrollBy"]) {
    const orig = elProto[name];
    if (typeof orig !== "function") continue;
    elProto[name] = function (...a) {
      const m = measured.get(this);
      if (m) scrollWrites.push({ t: performance.now(), k: m.key, op: name, args: a.map((x) => (typeof x === "object" ? JSON.stringify(x) : Number(x))).join(",") });
      return orig.apply(this, a);
    };
  }
  const origIntoView = elProto.scrollIntoView;
  if (typeof origIntoView === "function") {
    elProto.scrollIntoView = function (...a) {
      const m = measured.get(this);
      if (m) scrollWrites.push({ t: performance.now(), k: m.key, op: "scrollIntoView" });
      return origIntoView.apply(this, a);
    };
  }

  // ---- who moves a box: DOM surgery on it, inside it, or around it -------------------------------------------------
  const touches = (target) => {
    for (const [el, m] of measured) {
      if (el === target || el.contains(target) || target.contains(el)) return m.key;
    }
    return null;
  };
  const note = (op, target, extra) => {
    if (!target || target.nodeType !== 1) return;
    const key = touches(target);
    if (!key) return;
    ops.push({ t: performance.now(), op, k: key, tag: target.tagName ? target.tagName.toLowerCase() : "", cls: String(target.className || "").slice(0, 60), ...extra });
  };
  for (const [name, fn] of [
    ["appendChild", Node.prototype.appendChild],
    ["removeChild", Node.prototype.removeChild],
    ["replaceChild", Node.prototype.replaceChild],
  ]) {
    Node.prototype[name] = function (...a) {
      note(name, this, { argTag: a[0] && a[0].nodeType === 1 ? a[0].tagName.toLowerCase() : "" });
      return fn.apply(this, a);
    };
  }
  if (Node.prototype.insertBefore) {
    const orig = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function (n, ref) {
      note("insertBefore", this, { ref: ref && ref.nodeType === 1 ? ref.className : "" });
      return orig.call(this, n, ref);
    };
  }
  if (elProto.replaceChildren) {
    const orig = elProto.replaceChildren;
    elProto.replaceChildren = function (...a) {
      note("replaceChildren", this);
      return orig.apply(this, a);
    };
  }
  const innerHTML = Object.getOwnPropertyDescriptor(elProto, "innerHTML");
  if (innerHTML && innerHTML.set) {
    Object.defineProperty(elProto, "innerHTML", {
      configurable: true,
      get: innerHTML.get,
      set(v) {
        if (measured.size) note("innerHTML", this, { bytes: String(v || "").length });
        return innerHTML.set.call(this, v);
      },
    });
  }

  function boxes() {
    if (!armed) return [];
    const out = [];
    const add = (el, kind) => {
      const key = keyFor(el);
      if (!measured.has(el)) {
        measured.set(el, { key, kind });
        serials.set(el, ++serialSeq);
        watch(el, key);
      }
      if (lastSerial.get(key) !== serials.get(el)) {
        lastSerial.set(key, serials.get(el));
        events.push({ t: performance.now(), k: key, kind: "swap", serial: serials.get(el) });
      }
      out.push({ el, key, kind });
    };
    for (const el of document.querySelectorAll("pre.job-out")) if (mine(el)) add(el, "output");
    if (mode === "separated") for (const el of document.querySelectorAll("details.think .think-body")) if (mine(el)) add(el, "reason");
    return out;
  }

  const boxState = (b, prev) => {
    const el = b.el;
    const st = el.scrollTop;
    const sh = el.scrollHeight;
    const ch = el.clientHeight;
    const d = sh - st - ch;
    const rect = el.getBoundingClientRect();
    const rows = el.children.length;
    const thinkRows = b.kind === "output" ? el.querySelectorAll(".jl-think").length : 0;
    const s = {
      k: b.key,
      st,
      sh,
      ch,
      d,
      pinned: d <= 8,
      top: Math.round(rect.top * 10) / 10,
      h: Math.round(rect.height * 10) / 10,
      rows,
      thinkRows,
      overflow: sh - ch > 1,
      visible: rect.width > 0 && rect.height > 0,
      inView: rect.bottom > 0 && rect.top < window.innerHeight,
    };
    if (prev) {
      s.dsh = sh - prev.sh;
      s.dst = st - prev.st;
      s.dtop = s.top - prev.top;
      s.dh = s.h - prev.h;
      s.drows = rows - prev.rows;
    }
    return s;
  };

  let prev = new Map();
  function read() {
    if (!armed) return;
    const t = performance.now();
    const list = boxes();
    const frame = { t, boxes: [], overflow: 0, kinds: [], vis: document.visibilityState, docST: document.scrollingElement ? document.scrollingElement.scrollTop : 0 };
    const next = new Map();
    for (const b of list) {
      const p = prev.get(b.key);
      const s = boxState(b, p);
      next.set(b.key, s);
      if (s.overflow) {
        frame.overflow += 1;
        const kind = b.kind;
        if (!frame.kinds.includes(kind)) frame.kinds.push(kind);
      }
      frame.boxes.push(s);
    }
    prev = next;
    frames.push(frame);
    if (overflowAt == null && expectedKinds().every((k) => frame.kinds.includes(k))) overflowAt = t;
    lastAt = t;
    schedule();
  }
  function schedule() {
    if (!armed) return;
    raf = requestAnimationFrame(() => {
      if (!armed) return;
      timer = setTimeout(read, 0);
    });
  }

  const api = {
    arm() {
      armed = true;
      schedule();
      return true;
    },
    ready() {
      return { overflowAt, frames: frames.length, expected: expectedKinds(), boxes: [...measured.values()].map((m) => m.key), vis: document.visibilityState };
    },
    sinceOverflow() {
      return overflowAt == null ? null : performance.now() - overflowAt;
    },
    stop() {
      armed = false;
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      return true;
    },
    dump() {
      return { thread, mode, windowMs, overflowAt, lastAt, frames, ops, scrollWrites, events };
    },
  };
  window.__popc = api;
  return true;
}

// ---- metrics -------------------------------------------------------------------------------------------------------
const PIN = 8;
const HOP_DROP = 20;
const GAP_MS = 2000;

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

function analyse(raw, { from, to }) {
  const out = { boxes: {}, window: { from, to, ms: to - from } };
  const keys = [...new Set(raw.frames.flatMap((f) => f.boxes.map((b) => b.k)))];
  const events = (key, a, b) => (raw.events || []).filter((e) => e.k === key && e.t > a && e.t <= b);
  const writes = (key, a, b) => (raw.scrollWrites || []).filter((w) => w.k === key && w.t > a && w.t <= b);
  for (const key of keys) {
    const series = raw.frames
      .filter((f) => f.t >= from && f.t <= to)
      .map((f) => ({ t: f.t, b: f.boxes.find((x) => x.k === key) }))
      .filter((x) => x.b);
    if (!series.length) continue;
    const res = {
      key,
      kind: key.split(":")[0],
      frames: series.length,
      cadenceMs: 0,
      overflowFrames: 0,
      appends: 0,
      growthPx: 0,
      shrinks: 0,
      mutationFrames: 0,
      scrollEventFrames: 0,
      swaps: 0,
      pinnedFrames: 0,
      inViewFrames: 0,
      hops: [],
      retention: { longestMs: 0, at: null, runs: [] },
      lag: { episodes: 0, durations: [], depths: [], maxDepth: 0, totalMs: 0 },
      direction: { up: 0, down: 0 },
    };
    const gaps = [];
    for (let i = 1; i < series.length; i += 1) gaps.push(series[i].t - series[i - 1].t);
    res.cadenceMs = Math.round(pct(gaps, 50) || 0);
    for (let i = 1; i < series.length; i += 1) {
      const p = series[i - 1].b;
      const c = series[i].b;
      const a = series[i - 1].t;
      const b = series[i].t;
      if (c.overflow) res.overflowFrames += 1;
      if (c.dsh > 0) {
        res.appends += 1;
        res.growthPx += c.dsh;
      }
      if (c.dsh < 0) res.shrinks += 1;
      const ev = events(key, a, b);
      const muts = ev.filter((e) => e.kind === "mut");
      const scr = ev.filter((e) => e.kind === "scroll");
      if (muts.length) res.mutationFrames += 1;
      if (scr.length) res.scrollEventFrames += 1;
      if (ev.some((e) => e.kind === "swap")) res.swaps += 1;
      if (p.pinned && p.st - c.st > HOP_DROP) {
        const wr = writes(key, a, b);
        const surgery = raw.ops.filter((o) => o.k === key && o.t > a && o.t <= b);
        res.hops.push({
          t: Math.round(b - from),
          drop: Math.round(p.st - c.st),
          dBefore: Math.round(p.d),
          dAfter: Math.round(c.d),
          wrote: wr.map((w) => `${w.op}${w.v !== undefined ? `(${Math.round(w.v)})` : ""}`),
          scrolled: scr.length,
          muts: muts.length,
          mutAdded: muts.reduce((x, m) => x + (m.added || 0), 0),
          mutRemoved: muts.reduce((x, m) => x + (m.removed || 0), 0),
          chars: muts.reduce((x, m) => x + (m.chars || 0), 0),
          attrs: muts.reduce((x, m) => x + (m.attrs || 0), 0),
          dtop: Math.round(c.dtop || 0),
          dom: surgery.map((o) => `${o.op}<${o.tag}.${o.cls}>`).slice(0, 3),
          resized: Math.abs(c.dh) >= 0.5,
          grew: c.dsh > 0,
          shrank: c.dsh < 0,
        });
        res.direction.up += 1;
      }
      if (c.st - p.st > HOP_DROP) res.direction.down += 1;
      if (c.pinned) res.pinnedFrames += 1;
      if (c.inView) res.inViewFrames += 1;
    }
    // ---- tail retention: the longest run of pinned frames inside a continuous append episode -------------------
    const growIdx = [];
    for (let i = 0; i < series.length; i += 1) if (series[i].b.dsh > 0) growIdx.push(i);
    const eps = [];
    for (const i of growIdx) {
      const last = eps[eps.length - 1];
      if (last && series[i].t - series[last.end].t <= GAP_MS) last.end = i;
      else eps.push({ start: i, end: i });
    }
    for (const e of eps) {
      let runStart = null;
      let best = 0;
      let bestAt = null;
      const limit = series[e.end].t + GAP_MS;
      for (let j = e.start; j < series.length; j += 1) {
        if (series[j].t > limit) break;
        if (series[j].b.pinned) {
          if (runStart == null) runStart = series[j].t;
          const ms = series[j].t - runStart;
          if (ms > best) {
            best = ms;
            bestAt = runStart;
          }
        } else {
          runStart = null;
        }
      }
      res.retention.runs.push({ at: Math.round(series[e.start].t - from), ms: Math.round(best) });
      if (best > res.retention.longestMs) {
        res.retention.longestMs = best;
        res.retention.at = bestAt == null ? null : Math.round(bestAt - from);
      }
    }
    // ---- lag: excursions with distance > 8 px ----------------------------------------------------------------
    let lagStart = null;
    let lagDepth = 0;
    for (let i = 0; i < series.length; i += 1) {
      const bx = series[i].b;
      if (bx.d > PIN) {
        if (lagStart == null) {
          lagStart = series[i].t;
          lagDepth = bx.d;
        }
        lagDepth = Math.max(lagDepth, bx.d);
      } else if (lagStart != null) {
        res.lag.durations.push(Math.round(series[i].t - lagStart));
        res.lag.depths.push(Math.round(lagDepth));
        res.lag.maxDepth = Math.max(res.lag.maxDepth, lagDepth);
        res.lag.totalMs += series[i].t - lagStart;
        lagStart = null;
      }
    }
    if (lagStart != null) {
      res.lag.durations.push(Math.round(series[series.length - 1].t - lagStart));
      res.lag.depths.push(Math.round(lagDepth));
      res.lag.maxDepth = Math.max(res.lag.maxDepth, lagDepth);
    }
    res.lag.episodes = res.lag.durations.length;
    res.lag.p50 = pct(res.lag.durations, 50);
    res.lag.p90 = pct(res.lag.durations, 90);
    res.lag.max = res.lag.durations.length ? Math.max(...res.lag.durations) : 0;
    res.lag.depthP50 = pct(res.lag.depths, 50);
    res.lag.depthP90 = pct(res.lag.depths, 90);
    out.boxes[key] = res;
  }
  // ---- the two-box question: did both boxes drop in the SAME frame? -----------------------------------------
  const pair = [];
  for (let i = 1; i < raw.frames.length; i += 1) {
    const p = raw.frames[i - 1];
    const c = raw.frames[i];
    if (c.t < from || c.t > to) continue;
    const dropped = [];
    for (const b of c.boxes) {
      const q = p.boxes.find((x) => x.k === b.k);
      if (!q) continue;
      if (q.pinned && q.st - b.st > HOP_DROP) dropped.push(b.k.split(":")[0]);
    }
    if (dropped.length) pair.push({ t: Math.round(c.t - from), dropped });
  }
  out.simultaneous = pair;
  out.bothInSameFrame = pair.filter((x) => [...new Set(x.dropped)].length >= 2).length;
  return out;
}

// ---- the run -------------------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  notRun("playwright is not installed on this machine", "tools/pop-c.mjs cannot measure a page without a browser");
  process.exit(2);
}
const store = await jobs();
const job = (store.jobs || []).find((j) => j.thread === THREAD);
if (!job) {
  log(`not measured: no job with thread ${THREAD} on ${BASE} (GET /api/jobs has ${(store.jobs || []).length})`);
  process.exit(2);
}
if (job.status !== "running") {
  log(`not measured: job ${job.id} (${THREAD}) is ${job.status}, not running - spawn one first`);
  process.exit(2);
}
log(`job ${job.id} · thread ${THREAD} · ${job.status} · ${(job.lines || []).length} line(s) so far · mode ${MODE}`);

mkdirSync(REPORT, { recursive: true });
const browser = await pw.chromium.launch({ headless: !HEADED });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let raw = null;
let meta = {};
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e).slice(0, 200)));
  await page.addInitScript(init, { thread: THREAD, mode: MODE });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && state.jobs && state.rows, null, { timeout: 30_000 });
  await page.waitForFunction((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t), THREAD, { timeout: 60_000 });
  const opened = await page.evaluate(({ thread, cwd }) => {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const job = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread);
    const want = norm(job?.ownerPath || job?.cwd || cwd);
    const row = [...state.rows.values()].find((r) => norm(r.path) === want) || [...state.rows.values()].find((r) => norm(r.path).endsWith(want.split("/").slice(-1)[0]));
    if (!row) return { ok: false, rows: [...state.rows.values()].map((r) => r.path) };
    state.expandedProjects.add(row.project);
    state.expanded.add(`${row.project}::${row.path}`);
    renderAll();
    return { ok: true, row: `${row.project}::${row.path}` };
  }, { thread: THREAD, cwd: CWD });
  if (!opened.ok) {
    log(`not measured: no worktree row for the job (${JSON.stringify(opened)})`);
    await browser.close();
    process.exit(2);
  }
  await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 45_000 });
  // A console below the fold is a scroll box the browser need not paint: put it in the middle of the window and
  // keep it there (the page scroll only - the box itself is never touched), so every frame this tool calls painted
  // really was on screen.
  const keepInView = async () => {
    await page.evaluate(({ thread }) => {
      const el = document.querySelector(`.job[data-thread="${thread}"] pre.job-out`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < 60 || r.bottom > window.innerHeight - 40) window.scrollTo(0, Math.max(0, window.scrollY + r.top - 120));
    }, { thread: THREAD }).catch(() => {});
  };
  await keepInView();
  await page.evaluate(recorder, { thread: THREAD, mode: MODE, windowMs: WINDOW * 1000 });
  await page.evaluate(() => window.__popc.arm());
  const want = MODE === "combined" ? 1 : 2;
  const waitUntil = Date.now() + 180_000;
  let ready = null;
  while (Date.now() < waitUntil) {
    ready = await page.evaluate(() => window.__popc.ready());
    if (ready.overflowAt != null) break;
    await sleep(300);
  }
  if (ready.overflowAt == null) {
    log(`not measured: the ${MODE} card did not put ${want} overflowing box(es) on screen in 180 s (${JSON.stringify(ready)})`);
    await browser.close();
    process.exit(2);
  }
  log(`boxes overflowing: ${ready.boxes.join(", ")} · capturing ${SECONDS} s (official window ${WINDOW} s)`);
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await keepInView();
    const live = await page.evaluate(() => window.__popc.sinceOverflow());
    if (live == null) break;
    // stop early once the run is no longer writing and the official window is over
    const now = (await jobs()).jobs.find((j) => j.thread === THREAD);
    if (now && now.status !== "running" && live >= WINDOW * 1000 + 1000) break;
    await sleep(1000);
  }
  raw = await page.evaluate(() => window.__popc.dump());
  meta = { base: BASE, job: job.id, run: job.runId, thread: THREAD, mode: MODE, window: WINDOW, seconds: SECONDS, errors };
} finally {
  await browser.close();
}

const file = path.join(REPORT, `pop-c-${MODE}-${stamp}.json`);
writeFileSync(file, JSON.stringify({ meta, raw }, null, 0), "utf8");

const overflowAt = raw.overflowAt;
if (overflowAt == null) {
  log("not measured: the recorder saw no overflowing box");
  process.exit(2);
}
const official = { from: overflowAt, to: overflowAt + WINDOW * 1000 };
const windowed = analyse(raw, official);
const whole = analyse(raw, { from: overflowAt, to: raw.lastAt });
writeFileSync(file.replace(/\.json$/, "-metrics.json"), JSON.stringify({ meta, official: windowed, whole }, null, 2), "utf8");

const keys = Object.keys(windowed.boxes);
if (!keys.length) {
  log("not measured: no box held enough frames inside the window");
  process.exit(2);
}
log("");
log(`window: ${WINDOW} s from the first frame every expected box overflowed · captured ${fmt((raw.lastAt - overflowAt) / 1000, 1)} s of streaming`);
log("");
const head = ["box", "frames", "fps", "appends", "shrink", "hops", "hops/min", "retention s", "lag n", "lag p50/p90/max ms", "depth p50/p90/max px", "dir"];
log(head.join(" | "));
for (const k of keys) {
  const r = windowed.boxes[k];
  const mins = windowed.window.ms / 60000;
  log([
    k,
    r.frames,
    fmt(1000 / (r.cadenceMs || 1), 0),
    r.appends,
    r.shrinks,
    r.hops.length,
    fmt(r.hops.length / mins, 1),
    fmt(r.retention.longestMs / 1000, 1),
    r.lag.episodes,
    `${fmt(r.lag.p50, 0)}/${fmt(r.lag.p90, 0)}/${fmt(r.lag.max, 0)}`,
    `${fmt(r.lag.depthP50, 0)}/${fmt(r.lag.depthP90, 0)}/${fmt(r.lag.maxDepth, 0)}`,
    `${r.direction.up}up/${r.direction.down}down`,
  ].join(" | "));
  log(`   ${k}: overflow in ${r.overflowFrames}/${r.frames} frames · mutation frames ${r.mutationFrames} · scroll-event frames ${r.scrollEventFrames} · element swaps ${r.swaps} · growth ${Math.round(r.growthPx)} px · pinned ${r.pinnedFrames}/${r.frames} · on screen ${r.inViewFrames}/${r.frames}`);
  for (const h of r.hops) {
    log(
      `   hop ${fmt(h.t / 1000, 2)} s · drop ${h.drop} px (${h.dBefore} -> ${h.dAfter} px from bottom) · ` +
        `wrote ${JSON.stringify(h.wrote)} · scroll events ${h.scrolled} · mutations ${h.muts} (+${h.mutAdded}/-${h.mutRemoved}, ${h.chars} text) · ` +
        `attrs ${h.attrs} · box moved ${h.dtop} px on the page · dom ${JSON.stringify(h.dom)} · resized ${h.resized} · grew ${h.grew} · shrank ${h.shrank}`,
    );
  }
  const runs = [...r.retention.runs].sort((a, b) => b.ms - a.ms).slice(0, 3);
  log(`   ${k}: longest pinned runs inside append episodes: ${runs.map((x) => `${fmt(x.ms / 1000, 1)} s at ${fmt(x.at / 1000, 1)} s`).join(" · ") || "none"}`);
}
log("");
log(`both boxes dropped in the same frame: ${windowed.bothInSameFrame} (of ${windowed.simultaneous.length} frames with any drop)`);
for (const k of keys) {
  const w = whole.boxes[k];
  if (!w) continue;
  log(`whole capture ${k}: ${w.hops.length} hop(s), longest retention ${fmt(w.retention.longestMs / 1000, 1)} s, lag ${w.lag.episodes} episode(s) p90 ${fmt(w.lag.p90, 0)} ms`);
}
if (meta.errors && meta.errors.length) log(`page errors: ${JSON.stringify(meta.errors)}`);
log("");
log(`raw: ${file}`);
log(`metrics: ${file.replace(/\.json$/, "-metrics.json")}`);
