// Does a combined console that is PINNED stay on its tail while FOUR agents write, and does one the reader parked
// 80 px up hold its line?
//
//   node tools/measure-console-pin.mjs                       # 4 combined consoles, 60 s, port 7373
//   node tools/measure-console-pin.mjs --seconds 90          # a longer window
//   node tools/measure-console-pin.mjs --park 80             # the reader's distance from the tail (px)
//   node tools/measure-console-pin.mjs --settle-park 1500    # the control: arm after the reader's input window closes
//   node tools/measure-console-pin.mjs --json <path>         # keep the raw capture
//   node tools/measure-console-pin.mjs --headed              # a window instead of headless Chromium
//   node tools/measure-console-pin.mjs --keep                # leave the sandbox behind
//
// EXIT CODE: 0 when the window was measured and both promises held; 1 when the measurement ran and a pinned console
// was PAINTED off its tail, or the parked card's line moved; 2 when nothing was measured (no console overflowed, or no
// frame/write was logged) or the instrument's own self-test failed — a green run can never be a pass on an empty log.
//
// WHY THIS TOOL EXISTS. tools/measure-console-writes.mjs ranks WRITES and tools/measure-console-scroll-hop.mjs times
// hops on one shared beat. Neither answers the reader's question here: with FOUR agents writing into the combined (🌊)
// layout — one card pinned at the tail, one parked 80 px up, two others streaming — does the pinned card ever LEAVE
// the tail, and does the parked card's line drift? Those are two different instruments on one clock:
//
//   * FRAMES, sampled in requestAnimationFrame: for every console box, scrollTop / scrollHeight / clientHeight, the
//     panel's own pin state, and — the half nothing here had before — the ANCHOR: the first row with any part of itself
//     inside the box, its key, and its offset from the box top. That pair IS the reader's line, and it is exactly what
//     syncStreamConsole's relative correction (public/app.js, `keep` in syncStreamConsole) is written to hold still.
//     A parked card whose scrollTop moves may be the correction WORKING; a parked card whose anchor moves is the
//     reader's line sliding, which is the defect.
//   * WRITES, logged from Element.prototype.scrollTop's setter before public/app.js parses, each with its page caller
//     stack, so every excursion/drift is attributed to a named caller and site rather than to "the browser".
//
// WHAT IS DRIVEN. A throwaway panel on PORT 7373 (never 7331 — that is the reader's own panel, and this tool refuses
// to boot there) with its own PANEL_CONFIG / HERMES_HOME / jobs.json / projects cache, four live runs over a stub Runs
// API that plays plain text over real SSE one word per 75 ms, the panel's own POST /api/agents to spawn, a churn driver
// that touches a file in a CLOSED project every 4 s so the ranking really moves, and /api/thinking answered with blocks
// that keep growing — the row ABOVE the parked reader is the only thing the relative correction can move it for.
// Nothing synthetic reaches the page except the reader's own wheel, which is a real trusted wheel at the box.
//
// WHAT IT DOES NOT DO. No product change. It reads and reports. The pin/park gestures are done BEFORE the window is
// armed, so their own writes are not counted against the page, and the self-test runs AFTER it, so the tool's own
// writes cannot reach the numbers.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PORT = Number(opt("--port", 7373));
const SECONDS = Number(opt("--seconds", 60));
const PARK = Number(opt("--park", 80));
// ms to wait after the park before the window is armed. 0 is the condition where the reader has JUST parked (their
// input is still inside the page's 1200 ms window); a longer value is the control where the reader has gone back to
// watching. Both are the same card, same place, same window.
const SETTLE_PARK = Number(opt("--settle-park", 0));
const JSON_OUT = opt("--json");
const HEADLESS = !argv.includes("--headed");
const KEEP = argv.includes("--keep");
// The reader's panel is on 7331 and must never be touched: a run that boots there would measure the reader's own board
// and could stop it. Refuse before doing anything.
const FORBIDDEN_PORTS = new Set([7331]);
// px. "On the tail" for this tool is what the reader means by it: no more than 8 px short of the newest line. The
// stricter 1 px and the page's own 32 px are reported beside it so a borderline excursion cannot hide in a threshold.
const OFF_TAIL = 8;
const OFF_TAIL_STRICT = 1;
const OFF_TAIL_PAGE = 32;
// px. syncStreamConsole corrects the parked reader's line when the anchor row moved by >= 2 px, so 2 px is the
// tolerance the page itself promises; anything beyond it is drift it should have written away.
const ANCHOR_TOL = 2;
const MAX_WAIT_MS = 150_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);

// ---- the stub Hermes gateway: four runs of plain text, one word per 75 ms, over real SSE ---------------------------
const WORDS = `the console is a fixed height box and its content is longer than the box
a repaint that patches the row extends the words and moves nothing else
keeping the newest line in view means scrolling to the bottom after every growth
a reader who has scrolled up is a reader the panel must not touch
the sweep runs on its own clock whether or not the wire is moving
a card that keeps its node keeps the reader's place in it
the tail belongs to whoever is reading it and nobody else`.split(/\s+/).filter(Boolean);

// Each run gets its own seed and its own salt so four consoles are four different texts on one cadence, the shape of a
// board where several agents are writing at once.
function script(seed, lenMs, salt) {
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
    // The salt is in the text, not in a comment, so a copy of any console is attributable to its run.
    const word = inLine === 1 && sep !== " " ? `${w} [${salt}]` : w;
    out.push({ at: t, evt: { event: "message.delta", delta: `${word}${sep}` } });
    t += 75;
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
      return json(200, { version: "pin-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_pin_${posts}`;
        runs.set(id, { id, startedAt: null, script: script(posts * 41, lenMs, `run ${posts}`) });
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

// ---- the page-side instrument -------------------------------------------------------------------------------------
// Installed before public/app.js parses, so no write and no frame is missed by being early. Everything it keeps is on
// one clock (performance.now()), so a write, a DOM move and a frame can be joined instead of argued about.
function pageInit() {
  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const R = {
    writes: [],
    ops: [],
    rewrites: [],
    scrolls: [],
    errors: [],
    frames: 0,
    boxes: {},
    order: [],
    dropped: 0,
    stopped: false,
    armed: null,
    armAt: 0,
    windowEnd: 0,
    selftest: null,
  };
  window.__pin = R;
  window.__now = now;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && (e.reason.message || e.reason)) || "")}`));
  // The page marks the reader's own input with `lastInputAt` (public/app.js), a module-level binding the page cannot
  // read from here. The same four events, the same capture phase, give a faithful stand-in: `inputAgo` below is how long
  // before a scroll event the reader last touched ANYTHING - the 1200 ms window in which the page treats a scroll as the
  // reader's own and rewrites the console's pin state from it.
  let lastInput = -1e9;
  for (const ev of ["wheel", "mousedown", "keydown", "touchstart"]) {
    document.addEventListener(ev, () => {
      lastInput = now();
    }, { capture: true, passive: true });
  }

  // The page's own caller chain, innermost first: the init script's wrappers are not page files and are skipped, and
  // the file:line is kept because two callers of the same function are different writers (stickConsole from the 400 ms
  // sweep and stickConsole from settleScrolls both write, and only one of them is the sweep).
  // The frame is `fn|file:line` - NOT `fn@file`, which every mail-shaped redactor in the toolchain rewrites.
  const pageStack = (max) => {
    const out = [];
    for (const line of String(new Error().stack || "").split("\n").slice(1)) {
      const m = /^\s*at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/.exec(line);
      if (!m || !/\/(app|assistant)\.js|\/core\//.test(m[2])) continue;
      const fn = String(m[1] || "<anon>")
        .replace(/^async\s+/, "")
        .replace(/^(?:new\s+)?(?:Object|Array|Promise|Window|Node|Element|HTMLElement)\./, "");
      const file = String(m[2]).split("/").pop();
      out.push(`${fn}|${file}:${m[3]}`);
      if (out.length >= max) break;
    }
    return out.join(" < ");
  };

  // Only the main console is measured: in the combined (🌊) layout the reasoning is drawn INSIDE this box, so there is
  // exactly one scroll area per card and `pre.job-out` is it.
  const isConsole = (el) => Boolean(el && el.nodeType === 1 && el.tagName === "PRE" && el.classList && el.classList.contains("job-out") && el.dataset && el.dataset.out);
  const idOf = (el) => `out:${el.dataset.out}`;
  const idOfRow = (row, i) => {
    const lid = row && row.dataset ? row.dataset.lid : "";
    if (lid) return `l:${lid}`;
    const grp = row && row.dataset ? row.dataset.tgrp : "";
    return grp ? `g:${grp}` : `i:${i}`;
  };
  const pinnedNow = (el) => {
    try {
      if (typeof state === "undefined" || !state.outPinned) return true;
      return state.outPinned[el.dataset.out] !== false;
    } catch {
      return true;
    }
  };

  const EP = Element.prototype;
  const D = {
    scrollTop: Object.getOwnPropertyDescriptor(EP, "scrollTop"),
    scrollHeight: Object.getOwnPropertyDescriptor(EP, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(EP, "clientHeight"),
  };
  if (!D.scrollTop || !D.scrollTop.get || !D.scrollTop.set) return; // nothing to wrap: the run reports it, it does not pass
  let inGeom = false;
  const geom = (el) => {
    inGeom = true;
    try {
      return { top: D.scrollTop.get.call(el), sh: D.scrollHeight.get.call(el), ch: D.clientHeight.get.call(el) };
    } finally {
      inGeom = false;
    }
  };

  // ---- the DOM-primitive counter and the move log -----------------------------------------------------------------
  // A console carried into a fresh node comes back with scrollTop 0 and NO write: the browser clamped it. Logging the
  // primitive that carried it is the only way an unexplained move in the frame series gets a caller.
  let domSeq = 0;
  const carries = (nodes) => {
    for (const n of nodes) {
      if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
      if (n.nodeType === 1 && n.matches && n.matches("pre.job-out")) return true;
      if (n.querySelector && n.querySelector("pre.job-out")) return true;
    }
    return false;
  };
  const desc = (n) => {
    if (!n || n.nodeType !== 1) return n ? n.nodeName : "";
    const cn = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    const d = n.dataset || {};
    const id = d.project ? `[${d.project}]` : d.root ? "[folder]" : d.thread ? `[${String(d.thread).slice(0, 14)}]` : "";
    return `${n.tagName.toLowerCase()}${cn ? `.${cn}` : ""}${id}`;
  };
  const wrap = (proto, name, pick) => {
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__m) return;
    const w = function () {
      let host = null;
      let nodes = [];
      let carry = false;
      try {
        const p = pick(this, arguments);
        host = p[0];
        nodes = Array.from(p[1] || []);
        carry = carries(nodes);
      } catch {
        /* never break the page */
      }
      const r = orig.apply(this, arguments);
      try {
        if (carry) {
          domSeq += 1;
          if (R.ops.length < 6000) {
            // No geometry is read here on purpose: a layout read inside a detached subtree manufactures the clamp it
            // would be measuring.
            const keys = [];
            for (const n of nodes) {
              if (!n || n.nodeType !== 1) continue;
              const sel = n.matches && n.matches("pre.job-out") ? [n] : [...(n.querySelectorAll ? n.querySelectorAll("pre.job-out") : [])];
              for (const b of sel.slice(0, 4)) keys.push(idOf(b));
            }
            R.ops.push({ t: now(), seq: domSeq, op: name, host: desc(host), node: desc(nodes.find((n) => n && n.nodeType === 1)), keys: keys.join(","), by: pageStack(4) });
          }
        }
      } catch {
        /* ignore */
      }
      return r;
    };
    w.__m = true;
    proto[name] = w;
  };
  wrap(Node.prototype, "insertBefore", (s, a) => [s, [a[0]]]);
  wrap(Node.prototype, "appendChild", (s, a) => [s, [a[0]]]);
  wrap(Element.prototype, "after", (s, a) => [s.parentNode, a]);
  wrap(Element.prototype, "before", (s, a) => [s.parentNode, a]);
  wrap(Element.prototype, "append", (s, a) => [s, a]);
  wrap(Element.prototype, "replaceWith", (s, a) => [s.parentNode, [s, ...a]]);
  wrap(Element.prototype, "replaceChildren", (s, a) => [s, [...s.children, ...a]]);
  wrap(Element.prototype, "remove", (s) => [s.parentNode, [s]]);

  // ---- the row rewrite -----------------------------------------------------------------------------------------
  // `paintTypedLines` and `drawJobLine` rewrite a row's CONTENTS in place (`el.innerHTML = ...`). That changes the
  // height of a row ABOVE the reader without any scroll write and without any console-carrying DOM move, so it is the
  // one mutation a "silent" fall or a "grew" drift can be pinned on. Logged WITHOUT reading geometry: a layout read
  // here would manufacture the very shift it is measuring.
  const DHTML = Object.getOwnPropertyDescriptor(EP, "innerHTML");
  if (DHTML && DHTML.set) {
    Object.defineProperty(EP, "innerHTML", {
      configurable: true,
      enumerable: DHTML.enumerable,
      get: DHTML.get,
      set: function (v) {
        try {
          const out = this.closest ? this.closest("pre.job-out") : null;
          if (out && R.rewrites.length < 20_000) {
            const lid = this.dataset && this.dataset.lid;
            // `ltext` is the FULL line the row was drawn for; `chars` is what this rewrite puts in it. A rewrite with
            // fewer chars than ltext redraws the row SHORTER than it stood - a height change with no scroll write.
            R.rewrites.push({ t: now(), box: idOf(out), row: lid ? `l:${lid}` : "", chars: String(v == null ? "" : v).length, ltext: String((this.dataset && this.dataset.ltext) || "").length, by: pageStack(4) });
          }
        } catch {
          /* never break the page */
        }
        DHTML.set.call(this, v);
      },
    });
  }

  // ---- every scroll event on a console ------------------------------------------------------------------------------
  // The page's scroll handler is where the PIN STATE is decided: inside 1200 ms of any input it sets
  // `state.outPinned[id] = (dist < 32)`. A scroll this page caused itself is meant to be ignored (`selfScrolled` /
  // `justPlaced`), so an event that still reads as the reader's is the only way a console the reader never touched is
  // unpinned. The record carries the geometry at the event, the panel's own last value (`_selfTop`), whether the value
  // is still that one, and how long before it the reader last touched anything.
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target;
      if (!isConsole(el) || R.scrolls.length >= 4000) return;
      let g;
      try {
        g = geom(el);
      } catch {
        return;
      }
      R.scrolls.push({
        t: now(),
        box: idOf(el),
        top: Math.round(g.top),
        sh: Math.round(g.sh),
        ch: Math.round(g.ch),
        dist: Math.round(g.sh - g.top - g.ch),
        pin: pinnedNow(el),
        selfTop: el._selfTop == null ? null : Math.round(el._selfTop),
        placed: el._selfTop != null && Math.abs(g.top - el._selfTop) <= 1,
        inputAgo: Math.round(now() - lastInput),
      });
    },
    true,
  );

  const ring = (el) => {
    const id = idOf(el);
    let b = R.boxes[id];
    if (!b) {
      b = R.boxes[id] = { id, key: el.dataset.out, series: { ts: [], top: [], sh: [], ch: [], pin: [], akey: [], aoff: [] } };
      R.order.push(id);
    }
    return b;
  };

  // ---- the setter ---------------------------------------------------------------------------------------------------
  Object.defineProperty(EP, "scrollTop", {
    configurable: true,
    enumerable: D.scrollTop.enumerable,
    get: D.scrollTop.get,
    set: function (v) {
      if (!isConsole(this)) {
        D.scrollTop.set.call(this, v);
        return;
      }
      if (R.writes.length > 60_000) {
        R.dropped += 1;
        D.scrollTop.set.call(this, v);
        return;
      }
      const t = now();
      const before = geom(this);
      const asked = Number(v);
      const rec = {
        t,
        seq: domSeq,
        box: idOf(this),
        from: Math.round(before.top),
        asked: Math.round(asked) || 0,
        sh: Math.round(before.sh),
        ch: Math.round(before.ch),
        max: Math.round(before.sh - before.ch),
        pin: pinnedNow(this),
        conn: this.isConnected,
        dead: !this.isConnected || before.ch === 0,
        st: R.inSelftest ? 1 : 0,
        by: pageStack(5),
      };
      D.scrollTop.set.call(this, v);
      rec.landed = Math.round(D.scrollTop.get.call(this));
      rec.short = rec.max - rec.asked;
      rec.landedShort = rec.max - rec.landed;
      R.writes.push(rec);
    },
  });

  // The other way a caller can move a box without touching the property. Nothing in public/app.js uses them on a
  // console today; wrapping them is how the log proves that rather than assuming it.
  for (const name of ["scrollTo", "scrollBy"]) {
    const orig = EP[name];
    if (typeof orig !== "function") continue;
    const w = function () {
      if (isConsole(this)) {
        const g = geom(this);
        R.writes.push({
          t: now(), seq: domSeq, box: idOf(this), via: name, from: Math.round(g.top), asked: null,
          sh: Math.round(g.sh), ch: Math.round(g.ch), max: Math.round(g.sh - g.ch), pin: pinnedNow(this),
          conn: this.isConnected, dead: !this.isConnected || g.ch === 0, st: R.inSelftest ? 1 : 0, by: pageStack(5),
        });
      }
      return orig.apply(this, arguments);
    };
    w.__m = true;
    EP[name] = w;
  }

  // ---- the sample: geometry, the panel's pin state, and the reader's ANCHOR ------------------------------------------
  // The anchor is the first row with any part of itself inside the box plus its offset from the box top - the pair
  // syncStreamConsole captures and re-writes for a reader it must not move. Binary search over the children, so a
  // 300-row console costs ~9 rect reads a frame, not 300: the instrument must not become the jitter it measures.
  const anchorOf = (el) => {
    const kids = el.children;
    const n = kids.length;
    if (!n) return { key: "", off: null };
    const br = el.getBoundingClientRect();
    let lo = 0;
    let hi = n - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom > br.top + 0.5) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (found < 0) return { key: "", off: null };
    const row = kids[found];
    return { key: idOfRow(row, found), off: Math.round(row.getBoundingClientRect().top - br.top) };
  };

  const sampleOne = (el) => {
    const g = geom(el);
    const a = anchorOf(el);
    return { id: idOf(el), top: Math.round(g.top), sh: Math.round(g.sh), ch: Math.round(g.ch), pin: pinnedNow(el), akey: a.key, aoff: a.off, rows: el.children.length };
  };

  const sample = () => {
    if (R.stopped) return;
    R.frames += 1;
    for (const el of document.querySelectorAll("pre.job-out")) {
      const s = sampleOne(el);
      const b = ring(el);
      b.series.ts.push(Math.round(now()));
      b.series.top.push(s.top);
      b.series.sh.push(s.sh);
      b.series.ch.push(s.ch);
      b.series.pin.push(s.pin ? 1 : 0);
      b.series.akey.push(s.akey);
      b.series.aoff.push(s.aoff == null ? -9999 : s.aoff);
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  // Arm the window: everything the gestures did is discarded here, and the per-box snapshot below is the reference
  // every drift number in the report is measured against.
  window.__arm = () => {
    R.armAt = now();
    R.writes.length = 0;
    R.ops.length = 0;
    R.rewrites.length = 0;
    R.scrolls.length = 0;
    const boxes = {};
    for (const id of R.order) {
      const b = R.boxes[id];
      b.series = { ts: [], top: [], sh: [], ch: [], pin: [], akey: [], aoff: [] };
    }
    for (const el of document.querySelectorAll("pre.job-out")) {
      const s = sampleOne(el);
      boxes[s.id] = { ...s, dist: s.sh - s.top - s.ch, max: s.sh - s.ch };
    }
    R.armed = boxes;
    return { at: R.armAt, boxes };
  };
  window.__endWindow = () => {
    R.windowEnd = now();
    return R.windowEnd;
  };

  // The self-test is the reason a zero can be believed: each step must be VISIBLE to the instrument, in frames and (or)
  // in the write/move ledgers. It runs after the window, so none of its writes reach the numbers.
  //   (1) a pinned box written to 0 through the page's own setScroll and repaired 40 ms later - the frame series must
  //       show it off its tail while pin state still reads pinned, and both writes must be in the log;
  //   (2) a raw re-append of the section carrying a pinned console - the browser's own clamp, which NO write explains:
  //       the op log must hold the append and the frames must show the box at 0;
  //   (3) a raw 6 px move of the parked box with no setScroll - the anchor series must show it, so a parked card whose
  //       line moved could never be reported as holding.
  window.__selftest = async (ids) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = { at: now(), steps: [] };
    R.selftest = st;
    const byId = (id) => [...document.querySelectorAll("pre.job-out")].find((el) => idOf(el) === id) || null;
    const pinned = byId(ids && ids.pinned);
    const parked = byId(ids && ids.parked);
    R.inSelftest = true;
    // (1) jump + repair on the pinned box.
    if (pinned) {
      const before = Math.round(pinned.scrollTop);
      st.jumpAt = now();
      window.setScroll(pinned, 0);
      const jumped = Math.round(pinned.scrollTop);
      await wait(40);
      st.repairAt = now();
      window.setScroll(pinned, pinned.scrollHeight);
      const repaired = Math.round(pinned.scrollTop);
      st.steps.push({
        ok: before > 20 && jumped <= 2 && repaired > 20,
        what: "pinned box written to 0, repaired 40 ms later through setScroll",
        box: ids.pinned,
        before,
        jumped,
        repaired,
      });
      await wait(120);
    } else {
      st.steps.push({ ok: false, why: "no pinned box to drive" });
    }
    // (2) the browser's own clamp, with no write at all.
    if (pinned) {
      const sec = pinned.closest("section.project") || pinned.closest("section.root-group");
      if (sec && sec.parentNode) {
        const rawBefore = Math.round(pinned.scrollTop);
        st.rawAt = now();
        sec.parentNode.appendChild(sec);
        const rawAfter = Math.round(pinned.scrollTop);
        await wait(120);
        window.setScroll(pinned, pinned.scrollHeight);
        st.steps.push({
          ok: rawBefore > 20 && rawAfter <= 2,
          what: "raw re-append of the console's section, no write",
          box: ids.pinned,
          before: rawBefore,
          after: rawAfter,
        });
      } else {
        st.steps.push({ ok: false, why: "the console is not inside a section" });
      }
      await wait(120);
    }
    // (3) a raw 6 px move of the parked box: the anchor series must see the reader's line leave its place. Measured
    // from the anchor AS IT IS NOW, not from the armed one - the window may have ended after a rebuild.
    if (parked) {
      const a0 = anchorOf(parked);
      const before = Math.round(parked.scrollTop);
      R.st3At = now();
      parked.scrollTop = before + 6; // NOT setScroll: no page caller, the same shape as a browser clamp
      await wait(60);
      const a1 = anchorOf(parked);
      R.st3End = now();
      st.steps.push({
        ok: Math.abs(Math.round(parked.scrollTop) - (before + 6)) <= 1 && (a0.off == null || a1.off == null || a1.off - a0.off <= -4),
        what: "parked box moved 6 px with a raw scrollTop write",
        box: ids.parked,
        before,
        after: Math.round(parked.scrollTop),
        aoffBefore: a0.off,
        aoffAfter: a1.off,
        keyBefore: a0.key,
        keyAfter: a1.key,
        at: R.st3At,
        until: R.st3End,
      });
      window.setScroll(parked, before);
      await wait(40);
    } else {
      st.steps.push({ ok: false, why: "no parked box to drive" });
    }
    R.inSelftest = false;
    st.doneAt = now();
    return st;
  };
  window.__stop = () => {
    R.stopped = true;
  };
  window.__dump = () => {
    const boxes = {};
    for (const id of R.order) {
      const b = R.boxes[id];
      boxes[id] = { id: b.id, key: b.key, series: b.series };
    }
    return {
      writes: R.writes,
      ops: R.ops,
      rewrites: R.rewrites,
      scrolls: R.scrolls,
      errors: R.errors,
      frames: R.frames,
      boxes,
      armed: R.armed,
      armAt: R.armAt,
      windowEnd: R.windowEnd,
      dropped: R.dropped,
      selftest: R.selftest || null,
      st3At: R.st3At || 0,
      st3End: R.st3End || 0,
    };
  };
}

// ---- fixtures -------------------------------------------------------------------------------------------------------
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

// ---- the panel on the fixed port, with the serving proof the run is judged by ---------------------------------------
async function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function bootPanel({ port, dir, config, env = {} }) {
  const cfgPath = path.join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...config, port }, null, 2), "utf8");
  const out = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: cfgPath,
      HERMES_HOME: path.join(dir, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      PANEL_PARENT_WATCH_STDIN: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "echo",
      API_SERVER_KEY: "",
      ...env,
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
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(`panel exited before it was ready (${JSON.stringify(exited)}):\n${out.join("")}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) {
        const health = await r.json().catch(() => null);
        // The serving proof the run quotes: the board itself, its status, its size and its title - a page that only
        // answered /api/health would leave "does it serve" unanswered.
        const page = await fetch(`${base}/`);
        const html = await page.text();
        const title = (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || "";
        return {
          base,
          port,
          pid: child.pid,
          dir,
          health: { status: r.status, body: health },
          root: { status: page.status, bytes: Buffer.byteLength(html), title },
          panel: out,
          async stop() {
            if (!exited) {
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, 8_000);
                timer.unref?.();
                child.once("exit", () => {
                  clearTimeout(timer);
                  resolve();
                });
                child.kill();
              });
              if (!exited) child.kill("SIGKILL");
            }
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (!KEEP) await rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
          },
        };
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`panel did not answer /api/health on ${port} within 30 s:\n${out.join("")}`);
    }
    await sleep(120);
  }
}

// ---- analysis -------------------------------------------------------------------------------------------------------
const framesOf = (by) => String(by || "").split(" < ").filter(Boolean);
// `setScroll` is the innermost page frame of EVERY write (it is the one function in app.js that writes a console), so
// the writer is the next frame up - that is the difference between "the 400 ms sweep put it back" and "the pacer moved it".
const writerFrame = (by) => {
  const f = framesOf(by);
  for (const x of f) {
    const fn = x.split("|")[0];
    if (fn !== "setScroll" && fn !== "scrollTop") return x;
  }
  return f[0] || "?";
};
const callerOf = (by) => writerFrame(by).split("|")[0] || "?";
const siteOf = (by) => writerFrame(by).replace("|", " ") || "?";

function rankWrites(writes) {
  const rows = new Map();
  for (const w of writes) {
    if (w.asked == null) continue;
    const name = callerOf(w.by);
    let r = rows.get(name);
    if (!r) {
      r = { name, sites: new Map(), n: 0, up: 0, off: 0, parked: 0, dead: 0, atTail: 0, onParked: 0, onParkedTail: 0 };
      rows.set(name, r);
    }
    r.n += 1;
    const site = siteOf(w.by);
    r.sites.set(site, (r.sites.get(site) || 0) + 1);
    if (w.from - w.asked > 2) r.up += 1;
    if (w.dead) {
      r.dead += 1;
      continue;
    }
    if (w.landedShort <= 2) r.atTail += 1;
    if (!w.pin && w.landedShort > 2) r.parked += 1; // a box the reader took over, left above its bottom: the feature
    if (w.pin && w.landedShort > 2) r.off += 1; // a PINNED box left behind its newest line: the defect
  }
  return [...rows.values()].sort((a, b) => b.n - a.n);
}

// The cause of a step off the tail (or of a drift): the last write on the box in the gap before it, else nothing at
// all. Each episode's `cause` is built in place below, from the frames' own shape plus that write.

// The shape of a step off the tail, read off the two frames either side of it: did the box grow above the line it was
// showing (`grew`), or did scrollTop fall with the height unchanged (`fell`)? The two are different defects and the
// write log names different callers for them.
function shapeOf(series, at) {
  const i = at;
  if (!i) return { dTop: 0, dSh: 0, dCh: 0, kind: "first-frame" };
  const dTop = series.top[i] - series.top[i - 1];
  const dSh = series.sh[i] - series.sh[i - 1];
  const dCh = series.ch[i] - series.ch[i - 1];
  const dist = dSh - dTop - dCh;
  const kind = dTop < -1 && Math.abs(dSh) <= 1 ? "fell" : dSh > 1 && dTop >= -1 ? "grew" : dist > 0 ? "mixed" : "flat";
  return { dTop, dSh, dCh, dDist: dist, kind };
}

// A pinned excursion is a maximal run of frames that read PINNED and further than OFF_TAIL from the newest line.
function pinnedExcursions(box, writes, ops, rewrites = []) {
  const { ts, top, sh, ch, pin } = box.series;
  const out = [];
  let run = null;
  for (let i = 0; i < ts.length; i += 1) {
    const dist = sh[i] - top[i] - ch[i];
    const off = pin[i] === 1 && dist > OFF_TAIL && sh[i] - ch[i] > OFF_TAIL;
    if (off && !run) {
      run = {
        startT: ts[i],
        startTop: top[i],
        startDist: dist,
        prevT: i ? ts[i - 1] : ts[i],
        prevTop: i ? top[i - 1] : top[i],
        prevDist: i ? sh[i - 1] - top[i - 1] - ch[i - 1] : 0,
        frames: 0,
        peak: dist,
        height: sh[i] - ch[i],
        at: i,
        shape: shapeOf(box.series, i),
      };
    }
    if (off) {
      run.frames += 1;
      run.peak = Math.max(run.peak, dist);
      run.endT = ts[i];
      run.endTop = top[i];
    } else if (run) {
      run.repairT = ts[i];
      run.repairTop = top[i];
      run.repairMs = ts[i] - run.startT;
      out.push(run);
      run = null;
    }
  }
  if (run) {
    run.unrepaired = true;
    out.push(run);
  }
  for (const e of out) {
    // Who was behind it. A write in the gap that LANDED on the tail cannot be the cause of an excursion that starts
    // after it: the box was on its newest line when that caller finished. So the label says what the record can prove -
    // a write that left the box short (a defect in the writer), a write that landed on the tail and was followed by a
    // move nothing explains, or nothing at all.
    const w = writes.filter((x) => x.box === box.id && !x.st && x.t > e.prevT - 1 && x.t <= e.startT + 1).pop();
    e.cause = w
      ? { via: w.landedShort <= 2 ? "write-then-moved" : "write-short", caller: callerOf(w.by), site: siteOf(w.by), landedShort: w.landedShort, gapMs: Math.round((e.startT - w.t) * 10) / 10, write: w }
      : { via: "silent", caller: "(no write in the gap)", site: "" };
    const op = ops.filter((x) => x.t > e.prevT - 1 && x.t <= e.startT + 1 && String(x.keys || "").split(",").includes(box.id)).pop();
    if (op) e.op = { op: `${op.op} ${op.node}`, by: op.by };
    const rws = rewrites.filter((x) => x.box === box.id && x.t > e.prevT - 1 && x.t <= e.startT + 1);
    // A rewrite that redraws the row with FEWER characters than the line it stands for shrinks it in place, which is a
    // height change with no scroll write - the candidate cause of a `fell` or of a line that moved down.
    const rw = rws.filter((x) => x.chars < x.ltext).pop() || rws.pop();
    if (rw) e.rewrite = { row: rw.row, chars: rw.chars, ltext: rw.ltext, shrank: rw.chars < rw.ltext, by: rw.by, gapMs: Math.round((e.startT - rw.t) * 10) / 10 };
    const repair = writes.filter((x) => x.box === box.id && !x.st && x.t >= e.startT && (e.repairT == null || x.t <= e.repairT + 1)).pop();
    e.repair = repair ? { t: repair.t, caller: callerOf(repair.by), site: siteOf(repair.by), landedShort: repair.landedShort, ms: Math.round((repair.t - e.startT) * 10) / 10 } : null;
    e.dropPx = e.prevTop - e.startTop;
  }
  return out;
}

// Drift on the parked card: the reader's line is the ANCHOR (the first row inside the box and its offset from the box
// top), not scrollTop. A correction that writes scrollTop to hold that line is the page doing its job; the anchor
// moving means the line is sliding under the reader.
function parkedDrift(box, armed, writes, ops, rewrites = [], tol = ANCHOR_TOL) {
  const { ts, akey, aoff, pin, top, sh, ch } = box.series;
  const key0 = armed.akey;
  const off0 = armed.aoff;
  const runs = [];
  let run = null;
  let driftFrames = 0;
  let maxAbs = 0;
  for (let i = 0; i < ts.length; i += 1) {
    const moved = aoff[i] === -9999 ? false : Math.abs(aoff[i] - off0) > tol;
    const changed = Boolean(key0) && akey[i] !== key0;
    const drift = moved || changed;
    if (drift) {
      driftFrames += 1;
      maxAbs = Math.max(maxAbs, aoff[i] === -9999 ? 0 : Math.abs(aoff[i] - off0));
      if (!run) {
        run = {
          startT: ts[i],
          prevT: i ? ts[i - 1] : ts[i],
          frames: 0,
          peak: aoff[i] === -9999 ? 0 : aoff[i] - off0,
          fromKey: key0,
          toKey: akey[i],
          startTop: top[i],
          startDist: sh[i] - top[i] - ch[i],
          at: i,
          shape: shapeOf(box.series, i),
        };
      }
      run.frames += 1;
      if (aoff[i] !== -9999 && Math.abs(aoff[i] - off0) > Math.abs(run.peak)) run.peak = aoff[i] - off0;
      run.endT = ts[i];
      run.toKey = akey[i];
    } else if (run) {
      run.repairT = ts[i];
      run.repairMs = ts[i] - run.startT;
      runs.push(run);
      run = null;
    }
  }
  if (run) {
    run.unrepaired = true;
    runs.push(run);
  }
  for (const e of runs) {
    e.keyChanged = Boolean(key0) && e.toKey !== key0;
    // The cause is read off the frames first: a line above the reader that grew (scrollTop untouched) is not a write
    // at all, and naming a writer for it would be the mistake this tool exists to avoid.
    const w = writes.filter((x) => x.box === box.id && !x.st && x.t > e.prevT - 1 && x.t <= e.startT + 1).pop();
    e.cause = w
      ? { via: w.landedShort <= 2 ? "write-then-moved" : "write-left-it", caller: callerOf(w.by), site: siteOf(w.by), landedShort: w.landedShort, gapMs: Math.round((e.startT - w.t) * 10) / 10, write: w }
      : { via: e.shape.kind === "grew" ? "grew-above-no-write" : "silent", caller: "(no write in the gap)", site: "" };
    const op = ops.filter((x) => x.t > e.prevT - 1 && x.t <= e.startT + 1 && String(x.keys || "").split(",").includes(box.id)).pop();
    if (op) e.op = { op: `${op.op} ${op.node}`, by: op.by };
    const rws = rewrites.filter((x) => x.box === box.id && x.t > e.prevT - 1 && x.t <= e.startT + 1);
    const rw = rws.filter((x) => x.chars < x.ltext).pop() || rws.pop();
    if (rw) e.rewrite = { row: rw.row, chars: rw.chars, ltext: rw.ltext, shrank: rw.chars < rw.ltext, by: rw.by, gapMs: Math.round((e.startT - rw.t) * 10) / 10 };
    const repair = writes.filter((x) => x.box === box.id && !x.st && x.t >= e.startT && (e.repairT == null || x.t <= e.repairT + 1)).pop();
    e.repair = repair ? { t: repair.t, caller: callerOf(repair.by), site: siteOf(repair.by), ms: Math.round((repair.t - e.startT) * 10) / 10 } : null;
  }
  return { runs, driftFrames, maxAbs, key0, off0 };
}

// A console the reader never touched can still LOSE its pin: the scroll handler rewrites `outPinned` from any scroll
// event that arrives inside 1200 ms of any input. This is that event, with the write that caused it and the geometry the
// handler read - the whole chain, so the flip gets a caller instead of a shrug.
function pinFlips(box, scrolls, writes) {
  const { ts, pin, top, sh, ch } = box.series;
  const out = [];
  for (let i = 1; i < pin.length; i += 1) {
    if (pin[i] === pin[i - 1]) continue;
    const ev = scrolls.filter((s) => s.box === box.id && s.t >= ts[i - 1] - 1 && s.t <= ts[i] + 1).pop() || null;
    const w = writes.filter((x) => x.box === box.id && !x.st && x.t >= ts[i - 1] - 1 && x.t <= ts[i] + 1).pop() || null;
    out.push({
      frame: i,
      t: ts[i],
      from: pin[i - 1],
      to: pin[i],
      dist: sh[i] - top[i] - ch[i],
      event: ev,
      lastWrite: w ? { t: w.t, caller: callerOf(w.by), site: siteOf(w.by), from: w.from, asked: w.asked, landed: w.landed, max: w.max, landedShort: w.landedShort } : null,
      framesAfter: pin.length - i,
    });
  }
  return out;
}

// A change of scrollTop that NO write explains. The third mover, and the one the frame series cannot attribute on its
// own: the record says what sat in the gap.
function silentMoves(box, writes, ops) {
  const list = writes.filter((w) => w.box === box.id && !w.st && w.asked != null).sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i + 1 < list.length; i += 1) {
    const a = list[i];
    const b = list[i + 1];
    const gap = b.from - a.landed;
    if (Math.abs(gap) <= 2) continue;
    const between = (arr) => arr.filter((x) => x.t > a.t && x.t <= b.t && String(x.keys || "").split(",").includes(box.id));
    const opIn = between(ops);
    out.push({
      t: b.t,
      from: a.landed,
      to: b.from,
      px: gap,
      heightDelta: b.sh - a.sh,
      maxDelta: b.max - a.max,
      gapMs: Math.round((b.t - a.t) * 10) / 10,
      op: opIn.length ? `${opIn[opIn.length - 1].op} ${opIn[opIn.length - 1].node} by ${opIn[opIn.length - 1].by || "?"}` : null,
      via: opIn.length ? "dom move" : "nothing logged",
    });
  }
  return out;
}

function summarise(box, writes, ops) {
  const { ts, top, sh, ch, pin } = box.series;
  const frames = ts.length;
  let off8 = 0;
  let off1 = 0;
  let off32 = 0;
  let offAny = 0;
  let pinnedFrames = 0;
  let maxDist = 0;
  let minDist = Infinity;
  let pinFlips = 0;
  let lastDist = null;
  for (let i = 0; i < frames; i += 1) {
    const dist = sh[i] - top[i] - ch[i];
    lastDist = dist;
    if (dist > OFF_TAIL) offAny += 1;
    if (pin[i] === 1) {
      pinnedFrames += 1;
      if (dist > OFF_TAIL) off8 += 1;
      if (dist > OFF_TAIL_STRICT) off1 += 1;
      if (dist > OFF_TAIL_PAGE) off32 += 1;
    }
    if (dist > maxDist) maxDist = dist;
    if (dist < minDist) minDist = dist;
    if (i && pin[i] !== pin[i - 1]) pinFlips += 1;
  }
  const mine = writes.filter((w) => w.box === box.id && !w.st);
  return {
    id: box.id,
    key: box.key,
    frames,
    pinnedFrames,
    off8,
    off1,
    off32,
    offAny,
    lastDist,
    maxDist,
    minDist: minDist === Infinity ? null : minDist,
    pinFlips,
    writes: mine.length,
    topMoved: frames ? top[frames - 1] - top[0] : 0,
    heightGrew: frames ? sh[frames - 1] - sh[0] : 0,
    firstTop: frames ? top[0] : null,
    lastTop: frames ? top[frames - 1] : null,
  };
}

// ---- the drive ------------------------------------------------------------------------------------------------------
async function run(pw) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-pin-"));
  const roots = [path.join(work, "rootA")];
  const live = ["alpha", "beta"];
  const closedNames = ["g1", "g2", "g3", "g4"];
  for (const n of [...live, ...closedNames]) makeRepo(path.join(roots[0], n), n);
  const closed = closedNames.map((n) => path.join(roots[0], n));
  const cards = [
    { project: "alpha" },
    { project: "alpha", branch: "feature-b" },
    { project: "beta" },
    { project: "beta", branch: "feature-c" },
  ];
  const cardCwd = (c) => (c.branch ? path.join(roots[0], c.project, ".worktrees", c.branch) : path.join(roots[0], c.project));
  for (const c of cards) if (c.branch) git(["worktree", "add", "-q", "-b", c.branch, cardCwd(c)], path.join(roots[0], c.project));

  const gw = makeGateway(420_000);
  const gwPort = await gw.listen();
  const result = { panel: null, cards: {}, threads: {}, window: SECONDS, parkWant: PARK, settlePark: SETTLE_PARK, failures: [], notMeasured: [] };
  let touch = null;
  let sandbox = null;
  let browser = null;
  try {
    if (FORBIDDEN_PORTS.has(PORT)) throw new Error(`refusing to boot on ${PORT}: that is the reader's own panel`);
    if (!(await portIsFree(PORT))) throw new Error(`port ${PORT} is already in use - stop whatever is on it, this tool measures a panel it booted itself`);
    sandbox = await bootPanel({
      port: PORT,
      dir: work,
      config: {
        scanRoots: roots,
        projects: [],
        // Its own store, its own caches: nothing this panel writes may land in the checkout's logs/.
        jobsFile: path.join(work, "logs", "jobs.json"),
        assistantFile: path.join(work, "logs", "assistant.json"),
        projectsCacheFile: path.join(work, "logs", "projects.json"),
        refreshSeconds: 30,
        worktreeSeconds: 5,
        midSeconds: 45,
        dormantSeconds: 90,
        liveSeconds: 5,
        slowSeconds: 300,
        fetchSeconds: -1,
        assistant: { enabled: false },
        remoteBranchPolicy: "local-only",
        defaultCwd: roots[0],
        apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
      },
    });
    result.panel = { port: sandbox.port, pid: sandbox.pid, base: sandbox.base, health: sandbox.health, root: sandbox.root };
    log(
      "panel",
      `${sandbox.base} pid ${sandbox.pid} · GET / -> ${sandbox.root.status} (${sandbox.root.bytes} bytes, title "${sandbox.root.title}") · GET /api/health -> ${sandbox.health.status}`,
    );

    browser = await pw.chromium.launch({ headless: HEADLESS });
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));
    await page.addInitScript(pageInit);
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
    await page.waitForFunction((names) => names.every((n) => [...state.projects.keys()].includes(n)), [...new Set(cards.map((c) => c.project))], { timeout: 60_000 });
    const wantRows = cards.map((c) => ({ project: c.project, path: norm(cardCwd(c)) }));
    await page.waitForFunction(
      (w) => w.every((x) => [...state.rows.values()].some((r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path)),
      wantRows,
      { timeout: 60_000 },
    );
    // Four live runs, one per card, each spawned through the panel's own route.
    const threads = cards.map((_, i) => `pin-${live[i % 2]}-${i + 1}`);
    for (const [i, c] of cards.entries()) {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: stream plain text #${i + 1}`, cwd: cardCwd(c), existing: true, thread: threads[i] }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed for ${JSON.stringify(c)}: ${JSON.stringify(r).slice(0, 300)}`);
    }
    result.threads = Object.fromEntries(threads.map((t, i) => [t, { project: cards[i].project, branch: cards[i].branch || "main" }]));
    // Ranking churn: a closed project gets a file every 4 s, so the board's order really moves under the consoles.
    touch = setInterval(() => {
      const pick = closed[Math.floor(Date.now() / 4000) % closed.length];
      try {
        writeFileSync(path.join(pick, `probe-${Date.now()}.txt`), "activity\n");
      } catch {
        /* the next tick picks another */
      }
    }, 4000);
    touch.unref?.();
    await page.waitForFunction((ts) => ts.every((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t)), threads, { timeout: 60_000 });
    await page.evaluate((w) => {
      for (const x of w) {
        const row = [...state.rows.values()].find((r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path);
        if (!row) continue;
        state.expandedProjects.add(x.project);
        state.expanded.add(`${x.project}::${row.path}`);
      }
      renderAll();
    }, wantRows);
    for (const t of threads) await page.waitForSelector(`.job[data-thread="${t}"] pre.job-out`, { timeout: 45_000 });
    result.consoles = await page.evaluate(() => document.querySelectorAll("pre.job-out").length);

    // The combined (🌊) layout, and thinking ON so reasoning rows join the console: without a row above the reader
    // whose height moves, the relative correction has nothing to correct and a parked window would prove nothing.
    const blocks = new Map();
    let polls = 0;
    await page.route("**/api/thinking*", async (route) => {
      const url = new URL(route.request().url());
      const thread = url.searchParams.get("thread") || "";
      let list = blocks.get(thread);
      if (!list) {
        list = [{ at: Math.floor(Date.now() / 1000), text: "the console is a fixed height box" }];
        blocks.set(thread, list);
      }
      polls += 1;
      // The row the correction watches is the FIRST one inside the box, so the growth that can move it has to be
      // ABOVE it: the first block grows, and a new one only ever appears at the tail.
      list[0].text = `${list[0].text} and the rows above the reader keep moving`;
      if (polls % 4 === 0) list.push({ at: Math.floor(Date.now() / 1000) + polls, text: "a new thought arrives at the tail" });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ thread, blocks: list }) });
    });
    await page.evaluate((ts) => {
      for (const t of ts) {
        window.setThinking(t, true);
        window.setStreamMode(t, true);
      }
      window.renderAll();
    }, threads);
    result.stream = true;

    // The window may only start when every console has room to BE parked in: 40 px of overflow is not enough to put a
    // reader 80 px above the tail (a box with 78 px of scrollback, wheeled up, is just at its first line and produces
    // no scroll event at all - the park then silently does not exist).
    const MIN_RANGE = Math.max(240, PARK + 160);
    const overflowed = await page
      .waitForFunction(
        ({ min, count }) => {
          const outs = [...document.querySelectorAll("pre.job-out")].filter((o) => o.scrollHeight - o.clientHeight >= min);
          return outs.length >= count ? true : null;
        },
        { min: MIN_RANGE, count: threads.length },
        { timeout: MAX_WAIT_MS, polling: 250 },
      )
      .then(() => true)
      .catch(() => false);
    if (!overflowed) {
      result.notMeasured.push(`the consoles did not all reach ${MIN_RANGE} px of scrollback within ${Math.round(MAX_WAIT_MS / 1000)} s`);
      return result;
    }

    // The two cards the brief names: index 0 is left PINNED at the tail (the default), index 1 is parked PARK px up by
    // the reader's own gesture. 2 and 3 are left streaming, pinned, untouched.
    const sel = (t) => `.job[data-thread="${t}"] pre.job-out`;
    const readBox = (t) =>
      page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const id = el.dataset.out || "";
        const stored = state.outScrolls && state.outScrolls[id] ? { top: state.outScrolls[id].top, atBottom: state.outScrolls[id].atBottom } : null;
        return {
          id,
          pinned: state.outPinned[id] !== false,
          dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          max: Math.round(el.scrollHeight - el.clientHeight),
          top: Math.round(el.scrollTop),
          rows: el.children.length,
          stored,
          selfTop: el._selfTop == null ? null : Math.round(el._selfTop),
          justPlaced: el._selfTop != null && Math.abs(el.scrollTop - el._selfTop) <= 1,
        };
      }, sel(t));
    const pinnedBefore = await readBox(threads[0]);
    result.pinnedBeforePark = pinnedBefore;

    // Park: a real trusted wheel over the box (the page's own handler reads deltaY<0 as the reader leaving the tail),
    // then small wheels until the distance from the tail is PARK px. No scrollTop is written by the tool here: the
    // gesture has to be the reader's, or the measurement would be of its own hand.
    await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: "center" }), sel(threads[1]));
    await sleep(200);
    const parkedEl = await page.$(sel(threads[1]));
    let parkState = await readBox(threads[1]);
    const parkLog = [];
    if (parkedEl && parkState) {
      const bb = await parkedEl.boundingBox();
      if (bb) {
        await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.mouse.wheel(0, -Math.max(PARK + 60, 120));
        await sleep(140);
        for (let i = 0; i < 12; i += 1) {
          parkState = await readBox(threads[1]);
          const err = parkState.dist - PARK;
          parkLog.push({ dist: parkState.dist, err, pinned: parkState.pinned });
          if (Math.abs(err) <= 3) break;
          await page.mouse.wheel(0, err);
          await sleep(140);
        }
      }
      if (!parkState || parkState.pinned || Math.abs(parkState.dist - PARK) > 6) {
        // The wheel can miss a box that is off the viewport. Dispatch the event the page listens for ON THE ELEMENT and
        // let the page's own handler decide what it means; the scroll itself is the browser's, not a state write.
        parkState = await page.evaluate(({ s, want }) => {
          const el = document.querySelector(s);
          const id = el.dataset.out || "";
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -Math.abs(want), bubbles: true, cancelable: true }));
          const max = el.scrollHeight - el.clientHeight;
          el.scrollTop = Math.max(0, Math.min(max - want, el.scrollTop));
          return { id, pinned: state.outPinned[id] !== false, dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), max, top: Math.round(el.scrollTop), rows: el.children.length, via: "dispatched wheel + clamp" };
        }, { s: sel(threads[1]), want: PARK });
      }
      await page.mouse.move(2, 2);
    }
    // The park has to be a park: not the first line of a box with no scrollback (dist == max), not a box that is still
    // pinned, and with content above AND below the reader's line. Then a short settle, because the gesture's own scroll
    // event is what records the reader's place - a box that never scrolled keeps its stale `atBottom: true` and the
    // next rebuild restores it to the tail.
    result.park = { want: PARK, log: parkLog, final: parkState };
    // The page records the reader's place in `state.outScrolls` from the box's own scroll event - and it SKIPS an event
    // whose value is still where the panel last put it (`justPlaced`), which is exactly what a park landing on the line
    // the panel last restored looks like. A stale `atBottom: true` then gets the console put back on its tail by the
    // next rebuild, so the park would not exist. One 4 px nudge makes a fresh scroll event; if the page still has not
    // recorded the park, the run says so rather than measuring a place the page does not believe in.
    if (parkState && (!parkState.stored || parkState.stored.atBottom !== false)) {
      const bb2 = parkedEl ? await parkedEl.boundingBox().catch(() => null) : null;
      if (bb2) {
        await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2);
        await page.mouse.wheel(0, -4);
        await sleep(160);
        const rec2 = await readBox(threads[1]);
        parkLog.push({ nudge: -4, dist: rec2 && rec2.dist, stored: rec2 && rec2.stored, justPlaced: rec2 && rec2.justPlaced });
        if (rec2) parkState = rec2;
      }
      await page.mouse.move(2, 2);
    }
    result.parkRecord = parkState ? { stored: parkState.stored, justPlaced: parkState.justPlaced, selfTop: parkState.selfTop } : null;
    const parkTop = parkState ? parkState.top : null;
    const parkSettled = async () => {
      await sleep(180);
      return readBox(threads[1]);
    };
    parkState = (await parkSettled()) || parkState;
    result.parkedStart = parkState;
    // Judged by the LINE, not by the distance from the tail: while the window's clock runs the console keeps growing, so
    // a reader parked 80 px up is 80 px up for the instant they parked and further than that a second later. What must
    // not have happened is the line moving (top), the pin coming back, or the page forgetting the place.
    const parkOk = Boolean(
      parkState &&
        parkState.pinned === false &&
        parkTop != null &&
        Math.abs(parkState.top - parkTop) <= 12 &&
        parkState.top >= 40 &&
        parkState.max - parkState.top >= 40 &&
        parkState.stored &&
        parkState.stored.atBottom === false,
    );
    if (!parkOk) {
      result.notMeasured.push(`the parked card is not holding ${PARK} px above the tail with the page's own record of it: ${JSON.stringify({ parked: parkState, parkTop })}`);
      return result;
    }
    // The pinned card must be ON the tail when the window opens, or "it left the tail" would be measuring the arm.
    let pinCard = await readBox(threads[0]);
    for (let i = 0; i < 12 && (!pinCard || pinCard.pinned === false || pinCard.dist > 2); i += 1) {
      await sleep(200);
      pinCard = await readBox(threads[0]);
    }
    result.pinnedStart = pinCard;
    if (!pinCard || pinCard.pinned === false || pinCard.dist > 4) {
      result.notMeasured.push(`the pinned card was not on its tail when the window opened: ${JSON.stringify(pinCard)}`);
      return result;
    }

    // Arm: the reference every drift number is measured against, and the moment the frame and write logs start.
    if (SETTLE_PARK > 0) await sleep(SETTLE_PARK);
    const armed = await page.evaluate(() => window.__arm());
    const outs = await page.evaluate((ts) => {
      const m = {};
      for (const t of ts) {
        const el = document.querySelector(`.job[data-thread="${t}"] pre.job-out`);
        if (el) m[t] = el.dataset.out;
      }
      return m;
    }, threads);
    const ids = {
      pinned: outs[threads[0]] ? `out:${outs[threads[0]]}` : "",
      parked: outs[threads[1]] ? `out:${outs[threads[1]]}` : "",
      streams: [outs[threads[2]], outs[threads[3]]].filter(Boolean).map((x) => `out:${x}`),
    };
    result.ids = ids;
    const a = armed.boxes;
    result.armed = {
      pinned: a[ids.pinned] || null,
      parked: a[ids.parked] || null,
      streams: ids.streams.map((id) => a[id] || null),
    };
    if (!a[ids.pinned] || !a[ids.parked]) {
      result.notMeasured.push("a card left the DOM before the window was armed");
      return result;
    }
    log(
      "armed",
      `pinned ${ids.pinned} dist ${a[ids.pinned].dist} (pin ${a[ids.pinned].pin}, ${a[ids.pinned].rows} rows) · parked ${ids.parked} dist ${a[ids.parked].dist} of ${a[ids.parked].max} (pin ${a[ids.parked].pin}, anchor ${a[ids.parked].akey} at ${a[ids.parked].aoff} px) · streaming ${ids.streams.join(", ")}`,
    );

    const t0 = Date.now();
    await page.waitForFunction((ms) => window.__now() >= (window.__pin.armAt || 0) + ms, SECONDS * 1000, { timeout: SECONDS * 1000 + 60_000, polling: 500 });
    // Close the window FIRST: the self-test writes to a console, and a write from the tool must never be counted.
    const windowEnd = await page.evaluate(() => window.__endWindow());
    const selftest = await page.evaluate((i) => window.__selftest(i), ids);
    const rec = await page.evaluate(() => {
      window.__stop();
      return window.__dump();
    });
    result.windowMs = Date.now() - t0;
    result.windowEnd = windowEnd;
    result.selftest = selftest;
    result.frames = rec.frames;
    result.droppedWrites = rec.dropped;
    result.errors = [...pageErrors, ...(rec.errors || [])];
    result.writes = rec.writes.filter((w) => w.t <= windowEnd);
    result.ops = rec.ops.filter((o) => o.t <= windowEnd);
    result.rewrites = (rec.rewrites || []).filter((x) => x.t <= windowEnd);
    result.scrolls = (rec.scrolls || []).filter((x) => x.t <= windowEnd);
    result.selftestWrites = rec.writes.filter((w) => w.t > windowEnd);
    result.boxes = {};
    for (const [id, b] of Object.entries(rec.boxes)) {
      const keep = b.series.ts.map((t, i) => (t <= windowEnd ? i : -1)).filter((i) => i >= 0);
      result.boxes[id] = {
        id,
        key: b.key,
        series: {
          ts: keep.map((i) => b.series.ts[i]),
          top: keep.map((i) => b.series.top[i]),
          sh: keep.map((i) => b.series.sh[i]),
          ch: keep.map((i) => b.series.ch[i]),
          pin: keep.map((i) => b.series.pin[i]),
          akey: keep.map((i) => b.series.akey[i]),
          aoff: keep.map((i) => b.series.aoff[i]),
        },
      };
      // The self-test's own frames, kept whole so its episode can be read back.
      const after = b.series.ts.map((t, i) => (t > windowEnd ? i : -1)).filter((i) => i >= 0);
      result.selftestFrames = result.selftestFrames || {};
      if (after.length) {
        result.selftestFrames[id] = {
          ts: after.map((i) => b.series.ts[i]),
          top: after.map((i) => b.series.top[i]),
          sh: after.map((i) => b.series.sh[i]),
          ch: after.map((i) => b.series.ch[i]),
          pin: after.map((i) => b.series.pin[i]),
          akey: after.map((i) => b.series.akey[i]),
          aoff: after.map((i) => b.series.aoff[i]),
        };
      }
    }
    result.armedBoxes = rec.armed || {};
    result.st3 = { at: rec.st3At || 0, until: rec.st3End || 0 };
    return result;
  } finally {
    if (touch) clearInterval(touch);
    if (browser) await browser.close().catch(() => {});
    if (gw) await gw.close().catch(() => {});
    if (sandbox) await sandbox.stop().catch(() => {});
    if (!KEEP) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

// ---- main -----------------------------------------------------------------------------------------------------------
const pw = loadPlaywright({ root: ROOT });
if (!pw) {
  console.log(notRun("tools/measure-console-pin.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}

const r = await run(pw).catch((e) => {
  console.log(`[pin] ERROR ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n")}`);
  return { failures: [String((e && e.message) || e)], notMeasured: ["the run threw"] };
});

if (r.failures && r.failures.length) {
  for (const f of r.failures) log("pin", `FAIL ${f}`);
  process.exit(2);
}
if (r.notMeasured && r.notMeasured.length) {
  for (const n of r.notMeasured) log("pin", `NOT-MEASURED ${n}`);
  process.exit(2);
}

const ids = r.ids;
const boxes = r.boxes;
const armed = r.armed;
const pinnedBox = boxes[ids.pinned];
const parkedBox = boxes[ids.parked];
const streamBoxes = ids.streams.map((id) => boxes[id]).filter(Boolean);

if (!pinnedBox || !parkedBox || !pinnedBox.series.ts.length) {
  log("pin", "NOT-MEASURED no frame series for the pinned or the parked card");
  process.exit(2);
}

const pinnedSummary = summarise(pinnedBox, r.writes, r.ops);
const parkedSummary = summarise(parkedBox, r.writes, r.ops);
const pinnedRuns = pinnedExcursions(pinnedBox, r.writes, r.ops, r.rewrites);
const parked = parkedDrift(parkedBox, armed.parked, r.writes, r.ops, r.rewrites);
const flips = pinFlips(pinnedBox, r.scrolls || [], r.writes);
const silent = silentMoves(pinnedBox, r.writes, r.ops);
const rank = rankWrites(r.writes);
const streams = streamBoxes.map((b) => ({ ...summarise(b, r.writes, r.ops), runs: pinnedExcursions(b, r.writes, r.ops, r.rewrites).length }));

// Per-box writer counts: the parked card's own list is the evidence that no writer EVER touched it during the window,
// which is what makes "the page did not move it" a measurement rather than an inference.
const byBox = {};
for (const [id, b] of Object.entries(boxes)) {
  const counts = new Map();
  for (const w of r.writes.filter((x) => x.box === id && !x.st && x.asked != null)) {
    const name = callerOf(w.by);
    let c = counts.get(name);
    if (!c) {
      c = { name, n: 0, atTail: 0, short: 0, sites: new Map() };
      counts.set(name, c);
    }
    c.n += 1;
    if (w.landedShort <= 2) c.atTail += 1;
    else c.short += 1;
    const site = siteOf(w.by);
    c.sites.set(site, (c.sites.get(site) || 0) + 1);
  }
  byBox[id] = [...counts.values()].map((c) => ({ ...c, sites: Object.fromEntries(c.sites) })).sort((x, y) => y.n - x.n);
}

// ---- self-test --------------------------------------------------------------------------------------------------------
// A clean window means nothing unless the instrument can see the defect it is looking for. Each step is checked against
// the ledgers and, where it is a painted one, against the frames that followed it.
const st = r.selftest || { steps: [] };
const stWrites = r.selftestWrites || [];
const stFrames = r.selftestFrames || {};
const step1 = st.steps[0] || { ok: false, why: "not run" };
const step2 = st.steps[1] || { ok: false, why: "not run" };
const step3 = st.steps[2] || { ok: false, why: "not run" };
const sawJump = stWrites.some((w) => w.box === ids.pinned && w.t >= (st.jumpAt || 0) - 1 && w.t <= (st.repairAt || 0) + 1);
const pinnedAfter = stFrames[ids.pinned];
// The jump must be VISIBLE in the frames: a 0 write that no frame ever read would leave the sampler blind. The frame's
// pin flag is deliberately not required - the self-test drives a box the window may already have unpinned, and the
// question here is whether the geometry reading saw the jump, not who believed what.
const sawJumpFrame =
  Boolean(pinnedAfter) &&
  pinnedAfter.ts.some((t, i) => t >= (st.jumpAt || 0) - 1 && t <= (st.repairAt || 0) + 120 && pinnedAfter.sh[i] - pinnedAfter.top[i] - pinnedAfter.ch[i] > OFF_TAIL);
// Step 2's frame: the clamp must be PAINTED with no write in the gap, which is what proves a silent move is visible to
// this instrument at all.
const clampFrames = (pinnedAfter ? pinnedAfter.ts.map((t, i) => ({ t, dist: pinnedAfter.sh[i] - pinnedAfter.top[i] - pinnedAfter.ch[i] })) : []).filter(
  (x) => x.t >= (st.rawAt || 0) - 1 && x.t <= (st.rawAt || 0) + 140,
);
const sawClampFrame = clampFrames.some((x) => x.dist > OFF_TAIL);
const clampHadNoWrite = !stWrites.some((w) => w.box === ids.pinned && w.t >= (st.rawAt || 0) - 1 && w.t <= (st.rawAt || 0) + 140);
const parkedAfter = stFrames[ids.parked];
const sawParkedMove =
  Boolean(parkedAfter) &&
  parkedAfter.ts.some((t, i) => t >= (r.st3.at || 0) && t <= (r.st3.until || 0) + 2 && parkedAfter.aoff[i] !== -9999 && Math.abs(parkedAfter.aoff[i] - (armed.parked?.aoff ?? 0)) > ANCHOR_TOL);
const stOk = Boolean(step1.ok && step2.ok && step3.ok && sawJump && sawJumpFrame && sawClampFrame && sawParkedMove);

// ---- the print --------------------------------------------------------------------------------------------------------
log("park", `${r.parkedStart?.id} at ${r.parkedStart?.dist} px from the tail (want ${r.park?.want}), pin ${r.parkedStart?.pinned}, page record ${JSON.stringify(r.parkRecord?.stored)} · gestures ${JSON.stringify(r.park?.log)}`);
log("window", `${(r.windowMs / 1000).toFixed(1)} s · ${pinnedBox.series.ts.length} sampled frames · ${r.writes.length} console write(s) on ${Object.keys(boxes).length} box(es) · window closed at page t=${r.windowEnd}`);
log(
  "pinned",
  `${pinnedSummary.id}: ${pinnedSummary.off8}/${pinnedSummary.frames} frames off the tail WHILE PINNED (>${OFF_TAIL} px), ${pinnedSummary.off1} > ${OFF_TAIL_STRICT} px, ${pinnedSummary.off32} > ${OFF_TAIL_PAGE} px · ${pinnedSummary.offAny} frames off the tail at all · pinned ${pinnedSummary.pinnedFrames}/${pinnedSummary.frames} frames · ${pinnedRuns.length} excursion(s) · max dist ${pinnedSummary.maxDist} px · last dist ${pinnedSummary.lastDist} px · pin flips ${pinnedSummary.pinFlips} · ${pinnedSummary.writes} write(s)`,
);
for (const f of flips) {
  log(
    "pin-flip",
    `t=${f.t} frame ${f.frame}: pin ${f.from} -> ${f.to} at dist ${f.dist} px · scroll event ${f.event ? `top ${f.event.top}, dist ${f.event.dist}, sh ${f.event.sh}, ch ${f.event.ch}, input ${f.event.inputAgo} ms before, value still the panel's own ${f.event.placed}` : "none"} · last write ${f.lastWrite ? `${f.lastWrite.caller} at ${f.lastWrite.site} t=${f.lastWrite.t} (${f.lastWrite.from} -> asked ${f.lastWrite.asked}, landed ${f.lastWrite.landed}, max ${f.lastWrite.max})` : "none"} · ${f.framesAfter} frame(s) followed it`,
  );
}
log(
  "parked",
  `${parkedSummary.id}: armed ${armed.parked?.dist} px from the tail (anchor ${parked.key0} at ${parked.off0} px) · ${parked.driftFrames}/${parkedSummary.frames} frames with the line moved >${ANCHOR_TOL} px (${parked.runs.length} run(s), worst ${parked.maxAbs} px) · scrollTop moved ${parkedSummary.topMoved} px · height grew ${parkedSummary.heightGrew} px · pin flips ${parkedSummary.pinFlips}`,
);
for (const s of streams) log("stream", `${s.id}: ${s.off8}/${s.frames} frames off the tail · ${s.runs} excursion(s) · ${s.writes} write(s)`);
const parkWriters = byBox[ids.parked] || [];
log("parked-writers", parkWriters.length ? parkWriters.map((c) => `${c.name} ${c.n} (${c.atTail} on the tail, ${c.short} short)`).join(" · ") : "none - no writer touched the parked console in the window");

log("callers", `${rank.length} distinct writer(s)`);
for (const c of rank.slice(0, 12)) {
  const sites = [...c.sites.entries()].map(([s, n]) => `${s}${n > 1 ? ` x${n}` : ""}`).join(", ");
  log("  ", `${c.name} | ${sites} | ${c.n} write(s), ${c.atTail} landed on the tail, ${c.off} left a PINNED box short, ${c.parked} restored a parked one, ${c.up} moved up`);
}
if (pinnedRuns.length) {
  for (const e of pinnedRuns.slice(0, 12)) {
    log(
      "excursion",
      `t=${e.startT} ${e.frames} frame(s), peak ${e.peak} px · shape ${e.shape.kind} (top ${e.shape.dTop >= 0 ? "+" : ""}${e.shape.dTop}, scrollHeight ${e.shape.dSh >= 0 ? "+" : ""}${e.shape.dSh}) · mover ${e.cause.via} ${e.cause.caller}${e.cause.site ? ` at ${e.cause.site}` : ""}${e.rewrite ? ` · row ${e.rewrite.row || "(box)"} redrawn ${e.rewrite.ltext}->${e.rewrite.chars} chars by ${e.rewrite.by} ${e.rewrite.gapMs} ms before` : ""} · repair ${e.repair ? `${e.repair.caller} at ${e.repair.site} after ${e.repair.ms} ms` : e.unrepaired ? "UNREPAIRED" : "none"}`,
    );
  }
}
for (const e of parked.runs.slice(0, 12)) {
  log(
    "drift",
    `t=${e.startT} ${e.frames} frame(s), ${e.peak > 0 ? "+" : ""}${e.peak} px${e.keyChanged ? `, anchor ${e.fromKey} -> ${e.toKey}` : ""} · shape ${e.shape.kind} (top ${e.shape.dTop >= 0 ? "+" : ""}${e.shape.dTop}, scrollHeight ${e.shape.dSh >= 0 ? "+" : ""}${e.shape.dSh}) · mover ${e.cause.via} ${e.cause.caller}${e.cause.site ? ` at ${e.cause.site}` : ""}${e.rewrite ? ` · row ${e.rewrite.row || "(box)"} redrawn ${e.rewrite.ltext}->${e.rewrite.chars} chars by ${e.rewrite.by} ${e.rewrite.gapMs} ms before` : ""} · ${e.repairMs == null ? "UNREPAIRED" : `back in ${e.repairMs} ms`}`,
  );
}
for (const s of silent.slice(0, 8)) log("silent", `${s.from} -> ${s.to} (${s.px} px, height ${s.heightDelta >= 0 ? "+" : ""}${s.heightDelta}, ${s.gapMs} ms) · ${s.via}${s.op ? `: ${s.op}` : ""}`);
log("self-test", `step1 ${step1.ok ? "OK" : `FAIL ${step1.why || JSON.stringify(step1)}`} (write seen ${sawJump}, frame off tail ${sawJumpFrame}) · step2 ${step2.ok ? "OK" : `FAIL ${step2.why || ""}`} (frame off tail ${sawClampFrame}, no write in the gap ${clampHadNoWrite}) · step3 ${step3.ok ? "OK" : `FAIL ${step3.why || ""}`} (frame saw the move ${sawParkedMove})`);
log("errors", r.errors.length ? `${r.errors.length} page error(s): ${r.errors[0]}` : "none");

const verdictPinned = pinnedRuns.length === 0 && flips.filter((f) => f.to === 0).length === 0;
const verdictParked = parked.runs.length === 0;
const lostPin = flips.filter((f) => f.to === 0);
const verdict = verdictPinned && verdictParked ? "HELD" : !verdictPinned ? "PINNED-LEFT-THE-TAIL" : "PARKED-LINE-DRIFTED";
log("verdict", `${verdict} · pinned ${verdictPinned ? "never left the tail and kept its pin" : `${pinnedRuns.length} excursion(s)${lostPin.length ? `, lost its pin ${lostPin.length}x (${pinnedSummary.pinnedFrames}/${pinnedSummary.frames} frames still pinned)` : ""}`} · parked ${verdictParked ? "held its line" : `${parked.runs.length} drift(s), worst ${parked.maxAbs} px`}`);

const capture = {
  at: new Date().toISOString(),
  tool: "tools/measure-console-pin.mjs",
  panel: r.panel,
  cards: r.threads,
  ids,
  windowSeconds: r.window,
  windowMs: r.windowMs,
  frames: r.frames,
  park: r.park,
  parkRecord: r.parkRecord || null,
  settleParkMs: r.settlePark || 0,
  pinnedStart: r.pinnedStart || null,
  parkedStart: r.parkedStart || null,
  armed: r.armed,
  byBox,
  pinned: { summary: pinnedSummary, excursions: pinnedRuns, pinFlips: flips },
  parked: { summary: parkedSummary, drift: parked, runs: parked.runs },
  streams,
  callers: rank.map((c) => ({ ...c, sites: Object.fromEntries(c.sites) })),
  silent,
  writes: r.writes,
  ops: r.ops,
  rewrites: (r.rewrites || []).length,
  rewriteList: r.rewrites || [],
  scrolls: r.scrolls || [],
  selftest: { ok: stOk, steps: st.steps, sawJump, sawJumpFrame, sawClampFrame, clampHadNoWrite, sawParkedMove },
  errors: r.errors,
  verdict,
};
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ ...capture, boxes }, null, 1), "utf8");
  log("json", JSON_OUT);
}

if (!stOk) process.exit(2);
process.exit(verdict === "HELD" ? 0 : 1);
