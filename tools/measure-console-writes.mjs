// What WRITES a console's scrollTop, and which of those writes the layout had already moved past.
//
//   node tools/measure-console-writes.mjs                                  # siblings layout, 75 s window
//   node tools/measure-console-writes.mjs --only one --seconds 45
//   node tools/measure-console-writes.mjs --only projects --json out.json
//   node tools/measure-console-writes.mjs --control                        # same run, read-logging OFF
//   node tools/measure-console-writes.mjs --root <dir>                     # serve another checkout
//
// WHY THIS TOOL EXISTS. Every console harness in this repo samples what a frame PAINTS (requestAnimationFrame, then a
// threshold on `scrollHeight - scrollTop - clientHeight`). That is the right instrument for a hop that lasts a frame and
// the wrong one for the defect the reader actually reports: a jump that is undone before the next sample. live-1
// recorded 97 excursions in which `scrollTop` fell 34-190 px while `scrollHeight` grew 0 px, 85 of them repaired by the
// 400 ms stickConsole sweep and 12 by the next streamed line, 54 lasting under 50 ms. A painted series cannot say which
// write did that, or who called it, because by the time a frame is sampled the value is already back.
//
// So this records the WRITES. It wraps `scrollTop`'s setter and the `scrollTop` / `scrollHeight` / `clientHeight`
// getters on Element.prototype (filtered to the console boxes: `pre.job-out`, `.think-body`, `.sub-console`, `.job-body`)
// BEFORE app.js parses, so:
//
//   * every write is logged with its time, the value before it, the value asked for, the value the browser landed on,
//     the geometry at that instant, whether the box was even in the layout, and the page callers' file:line;
//   * every READ of the three geometry properties on a console box is logged too, so a write can be joined to the read
//     its target came from. A DOM-primitive counter (`domSeq`, bumped by the wrapped insertBefore/appendChild/... when
//     the subtree carries a console) tells us how many console-moving operations happened between that read and that
//     write. That is the whole "the layout has already moved past it" test: same task, a read, a mutation, a write that
//     uses the read. `stale` below is the number of pixels by which the write's target misses the bottom AT WRITE TIME;
//     `src.ageMs` / `src.domAge` say how old the read it came from was.
//
// It also keeps the per-frame painted series, so a write and a painted excursion can be joined in the report rather
// than argued about: an excursion is a run of frames off the bottom, its CAUSE is the last write (or DOM move) in the
// gap before it, and its REPAIR is the first write that puts it back - with the caller, and with the delay.
//
// WHAT IS DRIVEN. The same throwaway panel and stub Runs API as tools/verify-console-independence.mjs: a spare port,
// its own PANEL_CONFIG / HERMES_HOME / jobs.json / projects cache, a stub gateway that plays plain text over real SSE
// one word per 75 ms, the panel's own POST /api/agents to spawn, and a churn driver that touches a file in a CLOSED
// project every 4 s so the ranking really moves. Nothing synthetic reaches the page.
//
// WHAT IT DOES NOT DO. No product change. It reads and reports; it does not fix, and it exits 0 on a run that measured
// something and 2 on a run that measured nothing (no console overflowed, or no write was ever logged), so a green run
// can never be a pass on an empty log.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SECONDS = Number(opt("--seconds", 75));
const ONLY = opt("--only");
const JSON_OUT = opt("--json");
const HEADLESS = !argv.includes("--headed");
// The control run turns READ logging off and leaves everything else identical: if the excursion count moves, the
// instrument is measuring itself and no number in the report means anything.
const CONTROL = argv.includes("--control");
// `--type` drives the reader's own gesture: real keystrokes into a card's reply box for the whole window. That is the
// one condition in public/app.js's own scroll handler that matters - `lastInputAt` is what lets a clamp be read as the
// reader scrolling away, and it is only set by a real wheel/mousedown/keydown/touchstart.
const TYPE_INTO = argv.includes("--type");
const MAX_WAIT_MS = 150_000;
const OFF_BOTTOM = 8; // px; "pinned at the tail" for this tool, the same threshold the reader's report used
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);

const LAYOUTS = {
  one: { desc: "ONE streaming console", cards: [{ project: "alpha" }], folders: 1 },
  siblings: { desc: "TWO consoles in sibling worktree rows of ONE project", cards: [{ project: "alpha" }, { project: "alpha", branch: "feature-b" }], folders: 1 },
  projects: { desc: "TWO consoles in TWO projects of one folder", cards: [{ project: "alpha" }, { project: "beta" }], folders: 1 },
  // Closer to the reader's board: four live rows in two projects, so the 5 s liveness pass produces a `row` frame - and
  // therefore a placeRow detail swap - four times as often as in `siblings`.
  busy: {
    desc: "FOUR consoles in four rows of two projects",
    cards: [{ project: "alpha" }, { project: "alpha", branch: "feature-b" }, { project: "beta" }, { project: "beta", branch: "feature-c" }],
    folders: 1,
  },
};

// ---- the stub Hermes gateway: plain text, one word per 75 ms, over real SSE ---------------------------------------------
const WORDS = `the console is a fixed height box and its content is longer than the box
a repaint that patches the row extends the words and moves nothing else
keeping the newest line in view means scrolling to the bottom after every growth
a reader who has scrolled up is a reader the panel must not touch
the sweep runs on its own clock whether or not the wire is moving
a card that keeps its node keeps the reader's place in it`.split(/\s+/).filter(Boolean);

function script(seed, lenMs) {
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
      return json(200, { version: "write-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_writes_${posts}`;
        runs.set(id, { id, startedAt: null, script: script(posts === 1 ? 0 : 37, lenMs) });
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

// ---- the page-side instrument ------------------------------------------------------------------------------------------
// Installed as an init script, i.e. BEFORE public/app.js is parsed, so the very first setScroll of the session is
// recorded and no writer can be missed by being early.
function pageInit(opts) {
  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const READ_LOG = !opts || opts.reads !== false;
  const READ_CAP = 3000;
  const R = {
    writes: [],
    ops: [],
    focus: [],
    errors: [],
    frames: 0,
    boxes: {},
    boxOrder: [],
    readSites: {},
    reads: 0,
    writesDropped: 0,
    stopped: false,
  };
  window.__rec = R;
  window.__now = now;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && (e.reason.message || e.reason)) || "")}`));

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

  // ---- which elements are consoles ----
  // `pre.job-out` is the main output, `.think-body` the reasoning box (a div), `.sub-console` a subagent's console and
  // `.job-body` a maximized card's body. Memoised on the element: the class list of these four never changes.
  const kindCache = new WeakMap();
  const boxKind = (el) => {
    if (!el || el.nodeType !== 1) return null;
    let k = kindCache.get(el);
    if (k !== undefined) return k;
    k = null;
    const cl = el.classList;
    if (cl && cl.length) {
      if (cl.contains("job-out")) k = "out";
      else if (cl.contains("think-body")) k = "think";
      else if (cl.contains("sub-console")) k = "sub";
      else if (cl.contains("job-body")) k = "body";
    }
    kindCache.set(el, k);
    return k;
  };
  const keyOf = (el, k) => {
    if (k === "think") return (el.closest && el.closest("details.think")?.dataset.thinkTurn) || "";
    if (k === "sub") return (el.dataset && el.dataset.subConsoleBox) || "";
    if (k === "body") return (el.dataset && el.dataset.thread) || "body";
    return (el.dataset && el.dataset.out) || "";
  };

  // ---- the native accessors, captured before anything is replaced ----
  const EP = Element.prototype;
  const D = {
    scrollTop: Object.getOwnPropertyDescriptor(EP, "scrollTop"),
    scrollHeight: Object.getOwnPropertyDescriptor(EP, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(EP, "clientHeight"),
  };
  if (!D.scrollTop || !D.scrollTop.get || !D.scrollTop.set) return; // nothing to wrap: the run reports that, it does not pass
  const raw = {
    top: (el) => D.scrollTop.get.call(el),
    sh: (el) => D.scrollHeight.get.call(el),
    ch: (el) => D.clientHeight.get.call(el),
  };
  let inGeom = false;
  // All three at once, with recursion shut off: the log must not log itself.
  const geom = (el) => {
    inGeom = true;
    try {
      return { top: raw.top(el), sh: raw.sh(el), ch: raw.ch(el) };
    } finally {
      inGeom = false;
    }
  };

  // ---- the DOM-primitive counter and the move log ----
  // Every operation that touches a subtree carrying a console bumps `domSeq`. It is the only clock that says "a layout
  // change happened between that read and this write" without depending on timers or microtask boundaries: both live in
  // the same synchronous task, which is exactly the window in which a stale read becomes a bad write.
  let domSeq = 0;
  R.domSeq = () => domSeq;
  const carries = (nodes) => {
    for (const n of nodes) {
      if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
      if (n.nodeType === 1 && n.matches && n.matches("pre.job-out, .think-body, .sub-console")) return true;
      if (n.querySelector && n.querySelector("pre.job-out, .think-body, .sub-console")) return true;
    }
    return false;
  };
  const desc = (n) => {
    if (!n || n.nodeType !== 1) return n ? n.nodeName : "";
    const cn = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    const d = n.dataset || {};
    const id = d.project ? `[${d.project}]` : d.root ? "[folder]" : d.thread ? `[${String(d.thread).slice(0, 12)}]` : "";
    return `${n.tagName.toLowerCase()}${cn ? `.${cn}` : ""}${id}`;
  };
  const wrap = (proto, name, pick) => {
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__m) return;
    const w = function () {
      let host = null;
      let nodes = [];
      let carry = false;
      let wasConnected = false;
      try {
        const p = pick(this, arguments);
        host = p[0];
        nodes = Array.from(p[1] || []);
        carry = carries(nodes);
        wasConnected = nodes.some((n) => n && n.nodeType === 1 && n.isConnected);
      } catch {
        /* never break the page */
      }
      const r = orig.apply(this, arguments);
      try {
        if (carry) {
          domSeq += 1;
          if (R.ops.length < 4000) {
            // No geometry is read here on purpose: a layout read inside a detached subtree manufactures the clamp it
            // would be measuring.
            const keys = [];
            for (const n of nodes) {
              if (!n || n.nodeType !== 1) continue;
              const sel = n.matches && n.matches("pre.job-out, .think-body, .sub-console") ? [n] : [...(n.querySelectorAll ? n.querySelectorAll("pre.job-out, .think-body, .sub-console") : [])];
              for (const b of sel.slice(0, 4)) keys.push(`${boxKind(b)}:${keyOf(b, boxKind(b))}`);
            }
            R.ops.push({ t: now(), seq: domSeq, op: name, attached: wasConnected, host: desc(host), node: desc(nodes.find((n) => n && n.nodeType === 1)), keys: keys.join(","), by: pageStack(4) });
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

  // ---- the per-box read ring ----
  // A read record carries all three numbers, so a write can be matched against it in one comparison: `asked === sh`,
  // `asked === sh - ch` (a `max` the caller computed itself), or `asked === top` (a remembered position).
  const ringOf = (k, key) => {
    const id = `${k}:${key}`;
    let box = R.boxes[id];
    if (!box) {
      box = R.boxes[id] = { id, kind: k, key, reads: new Array(READ_CAP), ri: 0, rn: 0, series: { ts: [], top: [], sh: [], ch: [] }, lastWrite: null, writes: 0 };
      R.boxOrder.push(id);
    }
    return box;
  };
  const noteRead = (el, k, what, v) => {
    if (!READ_LOG) return;
    R.reads += 1;
    const box = ringOf(k, keyOf(el, k));
    const g = geom(el);
    box.reads[box.ri] = { t: now(), seq: domSeq, what, v, top: g.top, sh: g.sh, ch: g.ch };
    box.ri = (box.ri + 1) % READ_CAP;
    if (box.rn < READ_CAP) box.rn += 1;
    const site = what;
    R.readSites[site] = (R.readSites[site] || 0) + 1;
  };
  // The read a write's target came from: newest first, at most 240 back, and only reads that are not in the future.
  const findSrc = (box, asked, t) => {
    if (!READ_LOG || !box.rn) return null;
    let seen = 0;
    for (let i = 1; i <= box.rn && seen < 240; i += 1) {
      const idx = (box.ri - i + READ_CAP * 2) % READ_CAP;
      const r = box.reads[idx];
      if (!r) continue;
      seen += 1;
      if (r.t > t) continue;
      let what = null;
      if (r.what === "sh" && asked === Math.round(r.sh)) what = "sh";
      else if (r.what === "sh" && asked === Math.round(r.sh - r.ch)) what = "max";
      else if (r.what === "top" && asked === Math.round(r.top)) what = "top";
      else if (r.what === "ch" && asked === Math.round(r.sh - r.ch)) what = "max";
      if (!what) continue;
      return { what, ageMs: Math.round((t - r.t) * 10) / 10, domAge: domSeq - r.seq, shThen: Math.round(r.sh), chThen: Math.round(r.ch), topThen: Math.round(r.top) };
    }
    return null;
  };

  // ---- the getters ----
  // Reading geometry on a console box is recorded; everywhere else the native accessor answers and nothing is written
  // down, so the rest of the page (and every non-console element) is untouched.
  for (const [name, key] of [
    ["scrollTop", "top"],
    ["scrollHeight", "sh"],
    ["clientHeight", "ch"],
  ]) {
    const d = D[name];
    Object.defineProperty(EP, name, {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        const v = d.get.call(this);
        if (!inGeom) {
          const k = boxKind(this);
          if (k) {
            try {
              noteRead(this, k, key, v);
            } catch {
              /* ignore */
            }
          }
        }
        return v;
      },
      set: d.set,
    });
  }

  // ---- the setter ----
  Object.defineProperty(EP, "scrollTop", {
    configurable: true,
    enumerable: D.scrollTop.enumerable,
    get: D.scrollTop.get
      ? function () {
          const v = D.scrollTop.get.call(this);
          if (!inGeom) {
            const k = boxKind(this);
            if (k) {
              try {
                noteRead(this, k, "top", v);
              } catch {
                /* ignore */
              }
            }
          }
          return v;
        }
      : undefined,
    set: function (v) {
      const k = boxKind(this);
      if (!k) {
        D.scrollTop.set.call(this, v);
        return;
      }
      if (R.writes.length > 60_000) {
        R.writesDropped += 1;
        D.scrollTop.set.call(this, v);
        return;
      }
      const t = now();
      const before = geom(this);
      const conn = this.isConnected;
      const asked = Number(v);
      const box = ringOf(k, keyOf(this, k));
      const src = findSrc(box, Math.round(asked) || 0, t);
      const rec = {
        t,
        seq: domSeq,
        box: box.id,
        kind: k,
        from: Math.round(before.top),
        asked: Math.round(asked) || 0,
        sh: Math.round(before.sh),
        ch: Math.round(before.ch),
        max: Math.round(before.sh - before.ch),
        conn,
        // A box with no layout box (detached, or inside a display:none subtree) ignores a scrollTop write: the value
        // is stored nowhere and the element stays where it was. `dead` is that write.
        dead: !conn || before.ch === 0,
        src,
        st: R.inSelftest ? 1 : 0,
        by: pageStack(5),
      };
      D.scrollTop.set.call(this, v);
      rec.landed = Math.round(raw.top(this));
      // How far the value the writer ASKED FOR sits from the bottom, at the instant it wrote: positive means it asked
      // for a position above the newest line while the box was (or was about to be) treated as pinned.
      rec.short = rec.max - rec.asked;
      // And how far the value it LANDED on does: a positive number here with a negative `short` is the browser
      // clamping (the box grew after the target was computed), which no writer can see from its own reads.
      rec.landedShort = rec.max - rec.landed;
      R.writes.push(rec);
      box.writes += 1;
      box.lastWrite = rec;
    },
  });

  // `scrollTo`/`scrollBy` on an element is the other way a caller can move a box without touching the property. Nothing
  // in public/app.js uses them on a console today; wrapping them is how the log proves that rather than assuming it.
  for (const name of ["scrollTo", "scrollBy"]) {
    const orig = EP[name];
    if (typeof orig !== "function") continue;
    const w = function () {
      const k = boxKind(this);
      if (k) {
        const g = geom(this);
        R.writes.push({
          t: now(),
          seq: domSeq,
          box: `${k}:${keyOf(this, k)}`,
          kind: k,
          via: name,
          from: Math.round(g.top),
          asked: null,
          sh: Math.round(g.sh),
          ch: Math.round(g.ch),
          max: Math.round(g.sh - g.ch),
          conn: this.isConnected,
          dead: !this.isConnected || g.ch === 0,
          src: null,
          by: pageStack(5),
        });
      }
      return orig.apply(this, arguments);
    };
    w.__m = true;
    EP[name] = w;
  }

  // ---- the third mover: focus ----
  // Focusing an element scrolls its nearest scrollable ancestors to reveal it, which moves a console's scrollTop with no
  // write at all and by exactly the distance to the caret - the shape of a fall that no writer explains. `scrollIntoView`
  // does the same on purpose. Both are logged with the console box they touch, so a silent move in the ledger below can
  // be attributed to a focus rather than to "the browser".
  const noteFocus = (el, what) => {
    try {
      const box = el && el.closest ? el.closest("pre.job-out, .think-body, .sub-console") : null;
      if (!box) return;
      const k = boxKind(box);
      if (!k) return;
      if (R.focus.length > 4000) return;
      R.focus.push({ t: now(), seq: domSeq, what, box: `${k}:${keyOf(box, k)}`, target: desc(el), by: pageStack(4) });
    } catch {
      /* ignore */
    }
  };
  const wrapFn = (proto, name, what) => {
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__m) return;
    const w = function () {
      noteFocus(this, what);
      return orig.apply(this, arguments);
    };
    w.__m = true;
    proto[name] = w;
  };
  wrapFn(HTMLElement.prototype, "focus", "focus");
  wrapFn(EP, "scrollIntoView", "scrollIntoView");
  wrapFn(HTMLInputElement.prototype, "setSelectionRange", "setSelectionRange");
  wrapFn(HTMLTextAreaElement.prototype, "setSelectionRange", "setSelectionRange");
  wrapFn(HTMLInputElement.prototype, "select", "select");
  wrapFn(HTMLTextAreaElement.prototype, "select", "select");

  // ---- the painted series ----
  // Kept so a write can be joined to the frame it produced: the excursion analysis needs both halves.
  const sample = () => {
    if (R.stopped) return;
    R.frames += 1;
    const t = now();
    for (const el of document.querySelectorAll("pre.job-out, .think-body, .sub-console")) {
      const k = boxKind(el);
      if (!k) continue;
      const box = ringOf(k, keyOf(el, k));
      const g = geom(el);
      box.series.ts.push(Math.round(t));
      box.series.top.push(Math.round(g.top));
      box.series.sh.push(Math.round(g.sh));
      box.series.ch.push(Math.round(g.ch));
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  window.__arm = () => {
    R.armAt = now();
  };
  // The measured window closes here; the self-test below runs AFTER it, so nothing it writes can reach the ranking.
  window.__endWindow = () => {
    R.windowEnd = now();
    return R.windowEnd;
  };
  // The self-test is the tool's own sensitivity check, and it is the reason the report can claim the instrument cannot
  // miss a sub-frame jump:
  //   (1) a write to 0 through the page's own setScroll, repaired 40 ms later by the page's own "go to the bottom" - the
  //       shape live-1 recorded (a jump undone before the next sample). Both writes must appear in the log with their
  //       caller, and the frames in between must show the box off its bottom;
  //   (2) a raw re-append of an open section - the browser's own clamp, which NO write explains. The op log must hold
  //       the append with its caller and the frames must show scrollTop 0, so "the layout moved it, not the code" is a
  //       measurement here rather than an inference.
  window.__selftest = async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = { at: now(), steps: [] };
    R.selftest = st;
    const pick = [...document.querySelectorAll("pre.job-out")].filter((o) => o.scrollHeight - o.clientHeight > 40).sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (!pick) {
      st.steps.push({ ok: false, why: "no overflowing console" });
      return st;
    }
    st.box = `${boxKind(pick)}:${keyOf(pick, boxKind(pick))}`;
    st.before = Math.round(pick.scrollTop);
    st.maxBefore = Math.round(pick.scrollHeight - pick.clientHeight);
    // (1) the jump and its repair, 40 ms apart, both through setScroll.
    R.inSelftest = true;
    st.jumpAt = now();
    window.setScroll(pick, 0);
    st.jumped = Math.round(pick.scrollTop);
    await wait(40);
    st.repairAt = now();
    window.setScroll(pick, pick.scrollHeight);
    st.repaired = Math.round(pick.scrollTop);
    R.inSelftest = false;
    st.steps.push({
      ok: st.before > 20 && st.jumped <= 2 && st.repaired > 20 && st.repairAt - st.jumpAt >= 20,
      what: "write to 0, repaired 40 ms later through setScroll",
      before: st.before,
      jumped: st.jumped,
      repaired: st.repaired,
      gapMs: Math.round((st.repairAt - st.jumpAt) * 10) / 10,
    });
    await wait(120);
    // (2) the browser's own clamp: a raw re-append of the section the console lives in, with no write at all.
    const sec = pick.closest("section.project") || pick.closest("section.root-group");
    if (sec && sec.parentNode) {
      st.rawBefore = Math.round(pick.scrollTop);
      st.rawMax = Math.round(pick.scrollHeight - pick.clientHeight);
      st.rawAt = now();
      sec.parentNode.appendChild(sec);
      st.rawAfter = Math.round(pick.scrollTop);
      await wait(120);
      window.setScroll(pick, pick.scrollHeight);
      st.steps.push({
        ok: st.rawBefore > 20 && st.rawAfter <= 2,
        what: "raw re-append of the console's section, no write",
        before: st.rawBefore,
        after: st.rawAfter,
        max: st.rawMax,
      });
    } else {
      st.steps.push({ ok: false, why: "the console is not inside a section" });
    }
    await wait(80);
    return st;
  };
  window.__stop = () => {
    R.stopped = true;
  };
  window.__dump = () => {
    const boxes = {};
    for (const id of R.boxOrder) {
      const b = R.boxes[id];
      boxes[id] = { id: b.id, kind: b.kind, key: b.key, writes: b.writes, series: b.series };
    }
    return { writes: R.writes, ops: R.ops, focus: R.focus, errors: R.errors, frames: R.frames, boxes, readSites: R.readSites, reads: R.reads, writesDropped: R.writesDropped, armAt: R.armAt, windowEnd: R.windowEnd, selftest: R.selftest || null };
  };
}

// ---- fixtures ----------------------------------------------------------------------------------------------------------
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

// ---- analysis -----------------------------------------------------------------------------------------------------------
// One caller name out of a stack, without its line: the ranking is by CALLER, and the line is kept beside it as evidence.
// `setScroll` is the innermost page frame of EVERY write (it is the one function in app.js that writes a console), so the
// writer is the first frame above it - that is the difference between "the sweep put it back" and "the pacer moved it".
const framesOf = (by) => String(by || "").split(" < ").filter(Boolean);
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

// Group writes by caller. Every write is judged by what the box looked like AT THE INSTANT OF THE WRITE, because that is
// the only thing the writer could have known:
//
//   off    the box was still off its bottom after the write (`landedShort > 2`) - the write did not do its job
//   asked  of those, the caller asked for a top above the bottom (`short > 2`) - a stale or remembered target
//   grew   of those, the caller asked for the bottom as it then was and the box was taller when the value landed
//          (`short <= 2`, `landedShort > 2`) - the layout moved past the value INSIDE the write, and no read could see it
//   stale  `asked` writes whose target came from a read taken before a console-moving DOM operation (`src.domAge > 0`)
//   dead   the box had no layout at all when it was written (detached, or inside display:none): the write went nowhere
function rank(writes, boxes) {
  const rows = new Map();
  for (const w of writes) {
    // A `scrollTo`/`scrollBy` record has no target value to compare against; it is counted in its own line instead.
    if (w.asked == null) continue;
    const name = callerOf(w.by);
    let r = rows.get(name);
    if (!r) {
      r = { name, sites: new Map(), n: 0, off: 0, asked: 0, grew: 0, stale: 0, dead: 0, up: 0, shortSum: 0, shortMax: 0, staleAges: [], domAges: [], maxOff: 0 };
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
    if (w.landedShort > 2) {
      r.off += 1;
      if (w.landedShort > r.maxOff) r.maxOff = w.landedShort;
      if (w.short > 2) {
        r.asked += 1;
        r.shortSum += w.short;
        if (w.short > r.shortMax) r.shortMax = w.short;
        if (w.src && w.src.domAge > 0) {
          r.stale += 1;
          r.staleAges.push(w.src.ageMs);
          r.domAges.push(w.src.domAge);
        }
      } else {
        r.grew += 1;
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.asked + b.grew + b.dead * 2 - (a.asked + a.grew + a.dead * 2) || b.n - a.n);
}

// ---- the silent-move ledger ---------------------------------------------------------------------------------------------
// The third way a console's scrollTop changes, and the one neither a painted sampler nor a setScroll audit can see: it
// moves with NO write. Between one write (which lands on L) and the next (which reads F), the box went from L to F. When
// |F - L| > 2, something other than the panel's own scroll code moved it, and the record says what was in the gap: a DOM
// operation that carried the console (a move - the browser resets a detached scroll area to 0), a focus or
// scrollIntoView inside the box (which scrolls the nearest scrollable ancestor to reveal the caret), or nothing at all
// (a layout clamp). This is the ledger the "scrollTop fell 34-190 px while scrollHeight grew 0 px" report is made of.
function silentMoves(writes, ops, focus) {
  const out = [];
  const byBox = new Map();
  for (const w of writes) {
    if (w.asked == null || w.st) continue;
    if (!byBox.has(w.box)) byBox.set(w.box, []);
    byBox.get(w.box).push(w);
  }
  for (const [box, list] of byBox) {
    list.sort((a, b) => a.t - b.t);
    for (let i = 0; i + 1 < list.length; i += 1) {
      const a = list[i];
      const b = list[i + 1];
      const gap = b.from - a.landed;
      if (Math.abs(gap) <= 2) continue;
      const between = (arr) => arr.filter((x) => x.t > a.t && x.t <= b.t && (!x.keys || x.keys.split(",").includes(box) || x.box === box));
      const opIn = between(ops);
      const foIn = between(focus);
      out.push({
        t: b.t,
        box,
        from: a.landed,
        to: b.from,
        px: gap,
        heightDelta: b.sh - a.sh,
        maxDelta: b.max - a.max,
        gapMs: Math.round((b.t - a.t) * 10) / 10,
        op: opIn.length ? `${opIn[opIn.length - 1].op} ${opIn[opIn.length - 1].node} by ${opIn[opIn.length - 1].by || "?"}` : null,
        focus: foIn.length ? `${foIn[foIn.length - 1].what} ${foIn[foIn.length - 1].target} by ${foIn[foIn.length - 1].by || "?"}` : null,
        via: opIn.length ? "dom move" : foIn.length ? "focus/scrollIntoView" : "nothing logged",
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// An excursion is a maximal run of frames off the bottom, entered from a frame that was on it. Its cause is the last
// write (or DOM move) in the gap before the first off-bottom frame; its repair is the first write that puts it back.
function excursions(box, writes) {
  const { ts, top, sh, ch } = box.series;
  const out = [];
  let run = null;
  for (let i = 0; i < ts.length; i += 1) {
    const dist = sh[i] - top[i] - ch[i];
    const off = dist > OFF_BOTTOM && sh[i] - ch[i] > OFF_BOTTOM;
    if (off && !run) run = { startT: ts[i], startTop: top[i], max: sh[i] - ch[i], frames: 0, peak: dist, prevT: i ? ts[i - 1] : ts[i], prevTop: i ? top[i - 1] : top[i], prevMax: i ? sh[i - 1] - ch[i - 1] : 0, growth: sh[i] - (i ? sh[i - 1] : sh[i]) };
    if (off && run) {
      run.frames += 1;
      run.peak = Math.max(run.peak, dist);
      run.endT = ts[i];
      run.endTop = top[i];
    } else if (!off && run) {
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
  // Join each excursion to the writes that bracket it.
  for (const e of out) {
    const before = writes.filter((w) => w.box === box.id && w.t > e.prevT - 400 && w.t <= e.startT + 1);
    e.lastWrite = before[before.length - 1] || null;
    e.writesBefore = before.length;
    const repair = writes.filter((w) => w.box === box.id && w.t >= e.startT && (e.repairT == null || w.t <= e.repairT + 1));
    e.repair = repair[repair.length - 1] || null;
    e.dropPx = e.prevTop - e.startTop;
  }
  return out;
}

// ---- one layout ---------------------------------------------------------------------------------------------------------
async function runLayout(name, spec, pw, startPanel) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-writes-"));
  const roots = [path.join(work, "rootA")];
  const live = ["alpha", "beta"];
  const closedA = ["g1", "g2", "g3", "g4"];
  for (const n of [...live, ...closedA]) makeRepo(path.join(roots[0], n), n);
  const closed = closedA.map((n) => path.join(roots[0], n));
  const cardCwd = (c) => (c.branch ? path.join(roots[0], c.project, ".worktrees", c.branch) : path.join(roots[0], c.project));
  for (const c of spec.cards) if (c.branch) git(["worktree", "add", "-q", "-b", c.branch, cardCwd(c)], path.join(roots[0], c.project));

  const gw = makeGateway(420_000);
  const gwPort = await gw.listen();
  const sandbox = await startPanel({
    dir: work,
    config: {
      scanRoots: roots,
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
      defaultCwd: roots[0],
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
    env: { API_SERVER_KEY: "" },
  });
  const browser = await pw.chromium.launch({ headless: HEADLESS });
  let touch = null;
  const out = { name, desc: spec.desc, failures: [], notMeasured: [], errors: [], consoles: 0, writes: [], ops: [], boxes: {}, rank: [], excursions: [], frames: 0, reads: 0, control: CONTROL };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await page.addInitScript(pageInit, { reads: !CONTROL });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
    await page.waitForFunction((names) => names.every((n) => [...state.projects.keys()].includes(n)), [...new Set(spec.cards.map((c) => c.project))], { timeout: 60_000 });
    const wantRows = spec.cards.map((c) => ({ project: c.project, path: norm(cardCwd(c)) }));
    await page.waitForFunction(
      (w) => w.every((x) => [...state.rows.values()].some((r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path)),
      wantRows,
      { timeout: 60_000 },
    );
    const spawned = [];
    for (const [i, c] of spec.cards.entries()) {
      const thread = `writes-${name}-${i + 1}`;
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: stream plain text #${i + 1}`, cwd: cardCwd(c), existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed for ${JSON.stringify(c)}: ${JSON.stringify(r).slice(0, 300)}`);
      spawned.push({ thread, job: r.job.id });
    }
    touch = setInterval(() => {
      const pick = closed[Math.floor(Date.now() / 4000) % closed.length];
      try {
        writeFileSync(path.join(pick, `probe-${Date.now()}.txt`), "activity\n");
      } catch {
        /* the next tick picks another */
      }
    }, 4000);
    touch.unref?.();
    await page.waitForFunction((threads) => threads.every((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t)), spawned.map((s) => s.thread), { timeout: 60_000 });
    await page.evaluate((w) => {
      for (const x of w) {
        const row = [...state.rows.values()].find((r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path);
        if (!row) continue;
        state.expandedProjects.add(x.project);
        state.expanded.add(`${x.project}::${row.path}`);
      }
      renderAll();
    }, wantRows);
    for (const s of spawned) await page.waitForSelector(`.job[data-thread="${s.thread}"] pre.job-out`, { timeout: 45_000 });
    out.consoles = spawned.length;
    // The window starts when every console overflows its box: before that there is nothing to be off the bottom OF.
    const overflowed = await page
      .waitForFunction(
        (n) => {
          const outs = [...document.querySelectorAll("pre.job-out")].filter((o) => o.scrollHeight - o.clientHeight > 40);
          return outs.length >= n ? true : null;
        },
        spawned.length,
        { timeout: MAX_WAIT_MS, polling: 250 },
      )
      .then(() => true)
      .catch(() => false);
    if (!overflowed) {
      out.notMeasured.push(`the consoles did not all overflow within ${Math.round(MAX_WAIT_MS / 1000)} s`);
      return out;
    }
    // Start the measured window: the painted series and the write log both begin here.
    await page.evaluate(() => {
      const R = window.__rec;
      for (const id of Object.keys(R.boxes)) R.boxes[id].series = { ts: [], top: [], sh: [], ch: [] };
      R.writes.length = 0;
      R.ops.length = 0;
      window.__arm();
    });
    log(name, `${spawned.length} console(s) overflowing; recording ${SECONDS} s of writes${CONTROL ? " (control: read log off)" : ""}${TYPE_INTO ? " (the reader is typing in a reply box)" : ""}`);
    // The reader's gesture, if asked for: a real click into one card's reply box and a real keypress every 400 ms, so
    // `lastInputAt` stays inside its 1200 ms window for the whole measurement. Nothing synthetic is dispatched.
    let typing = null;
    if (TYPE_INTO) {
      const sel = `.job[data-thread="${spawned[0].thread}"] .reply-box`;
      typing = (async () => {
        try {
          await page.click(sel, { timeout: 8000 });
        } catch {
          /* the box may not be on screen yet; the keypresses still land on the document */
        }
        const until = Date.now() + SECONDS * 1000 + 4000;
        while (Date.now() < until) {
          try {
            await page.keyboard.type("k", { delay: 0 });
          } catch {
            /* the page may be mid-repaint */
          }
          await sleep(400);
        }
      })();
    }
    const t0 = Date.now();
    await page.waitForFunction((ms) => window.__now() >= (window.__rec.armAt || 0) + ms, SECONDS * 1000, { timeout: SECONDS * 1000 + 60_000, polling: 500 });
    if (typing) await typing;
    // Close the measured window FIRST: the self-test writes to a console, and a write from the tool must never be
    // counted against the page.
    await page.evaluate(() => window.__endWindow());
    const selftest = await page.evaluate(() => window.__selftest());
    const rec = await page.evaluate(() => {
      window.__stop();
      return window.__dump();
    });
    out.selftest = selftest;
    out.windowEnd = rec.windowEnd;
    // Everything after the window's end belongs to the self-test.
    out.writes = rec.writes.filter((w) => w.t <= rec.windowEnd);
    out.selftestWrites = rec.writes.filter((w) => w.t > rec.windowEnd);
    out.ops = rec.ops.filter((o) => o.t <= rec.windowEnd);
    out.focus = (rec.focus || []).filter((f) => f.t <= rec.windowEnd);
    out.selftestOps = rec.ops.filter((o) => o.t > rec.windowEnd);
    out.boxes = {};
    for (const [id, b] of Object.entries(rec.boxes)) {
      const keep = b.series.ts.map((t, i) => (t <= rec.windowEnd ? i : -1)).filter((i) => i >= 0);
      out.boxes[id] = { ...b, series: { ts: keep.map((i) => b.series.ts[i]), top: keep.map((i) => b.series.top[i]), sh: keep.map((i) => b.series.sh[i]), ch: keep.map((i) => b.series.ch[i]) } };
      // The frames the self-test painted, kept whole so its own episode can be read back.
      out.selftestFrames = out.selftestFrames || {};
      const after = b.series.ts.map((t, i) => (t > rec.windowEnd ? i : -1)).filter((i) => i >= 0);
      if (after.length) out.selftestFrames[id] = { ts: after.map((i) => b.series.ts[i]), top: after.map((i) => b.series.top[i]), sh: after.map((i) => b.series.sh[i]), ch: after.map((i) => b.series.ch[i]) };
    }
    out.frames = rec.frames;
    out.reads = rec.reads;
    out.readSites = rec.readSites;
    out.writesDropped = rec.writesDropped;
    out.errors.push(...rec.errors.map((e) => String(e).slice(0, 200)));
    out.windowMs = Date.now() - t0;
    out.rank = rank(out.writes, out.boxes);
    out.silent = silentMoves(out.writes, out.ops, out.focus);
    for (const box of Object.values(out.boxes)) {
      for (const e of excursions(box, out.writes)) out.excursions.push({ box: box.id, ...e });
    }
    out.excursions.sort((a, b) => a.startT - b.startT);
    if (!out.writes.length) out.notMeasured.push("no scrollTop write was logged at all - the instrument did not attach");
    if (out.errors.length) out.failures.push(`${out.errors.length} page error(s): ${out.errors[0]}`);
    return out;
  } finally {
    if (touch) clearInterval(touch);
    await browser.close().catch(() => {});
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

// ---- main ----------------------------------------------------------------------------------------------------------------
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log(notRun("tools/measure-console-writes.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const names = Object.keys(LAYOUTS).filter((n) => !ONLY || n === ONLY);
if (!names.length) {
  console.log(`unknown layout ${ONLY}; one of ${Object.keys(LAYOUTS).join(", ")}`);
  process.exit(2);
}
console.log(`console scrollTop writes on ${TREE} (${SECONDS} s window per layout)`);
const results = [];
for (const name of names) {
  try {
    results.push(await runLayout(name, LAYOUTS[name], pw, startPanel));
  } catch (e) {
    results.push({ name, desc: LAYOUTS[name].desc, failures: [], notMeasured: [`the run broke: ${String((e && e.stack) || e).split("\n").slice(0, 3).join(" / ")}`], errors: [], consoles: 0, writes: [], ops: [], boxes: {}, rank: [], excursions: [] });
  }
}

const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
const med = (a) => pct(a, 50);

let blind = 0;
console.log("");
for (const r of results) {
  const verdict = r.notMeasured.length ? "NOT MEASURED" : "MEASURED";
  if (verdict === "NOT MEASURED") blind += 1;
  console.log(`${verdict.padEnd(12)} ${r.name.padEnd(9)} ${r.desc}`);
  console.log(`             ${r.consoles} console(s), ${r.writes.length} write(s), ${r.reads} read(s), ${r.frames} frame(s)${r.control ? " [CONTROL: read log off]" : ""}`);
  for (const f of r.notMeasured) console.log(`             ? ${f}`);
  for (const f of r.failures) console.log(`             - ${f}`);
  if (!r.writes.length) continue;

  const ups = r.writes.filter((w) => w.asked != null && w.from - w.asked > 2);
  const dead = r.writes.filter((w) => w.dead);
  const off = r.writes.filter((w) => w.asked != null && !w.dead && w.landedShort > 2);
  const grew = off.filter((w) => w.short <= 2);
  const viaScroll = r.writes.filter((w) => w.via);
  console.log(
    `             writes: ${r.writes.length} total, ${ups.length} moved a box up, ${off.length} left it off the bottom (${grew.length} of those asked for the bottom as it then was and the box grew inside the write), ${dead.length} into a box with no layout${viaScroll.length ? `, ${viaScroll.length} via scrollTo/scrollBy` : ""}`,
  );

  console.log("             caller                                n     up    off  asked   grew  stale  dead  maxOff");
  for (const row of r.rank.slice(0, 14)) {
    const ages = row.staleAges.filter((x) => typeof x === "number");
    console.log(
      `             ${row.name.padEnd(36)} ${String(row.n).padStart(4)} ${String(row.up).padStart(6)} ${String(row.off).padStart(6)} ${String(row.asked).padStart(6)} ${String(row.grew).padStart(6)} ${String(row.stale).padStart(6)} ${String(row.dead).padStart(5)} ${String(row.maxOff).padStart(7)}${ages.length ? `  (src read age p50 ${med(ages)} ms, domAge p50 ${med(row.domAges)})` : ""}`,
    );
    for (const [site, n] of [...row.sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) console.log(`               ${String(n).padStart(4)}x ${site}`);
  }

  const ex = r.excursions;
  if (!ex.length) {
    console.log("             excursions off the bottom: 0 - this window never put a console behind its newest line");
  } else {
    const durations = ex.filter((e) => e.repairMs != null).map((e) => e.repairMs);
    const drops = ex.map((e) => e.dropPx);
    console.log(
      `             excursions off the bottom: ${ex.length}; drop p50/p90/max ${med(drops)}/${pct(drops, 90)}/${Math.max(...drops)} px; repair p50/p90/max ${med(durations)}/${pct(durations, 90)}/${Math.max(...durations)} ms; ${ex.filter((e) => e.unrepaired).length} unrepaired at the window's end`,
    );
    const causes = {};
    const repairs = {};
    for (const e of ex) {
      const c = e.lastWrite ? siteOf(e.lastWrite.by) : "no write (browser move)";
      causes[c] = (causes[c] || 0) + 1;
      const rp = e.repair ? siteOf(e.repair.by) : "none";
      repairs[rp] = (repairs[rp] || 0) + 1;
    }
    console.log("             last write before each excursion:");
    for (const [c, n] of Object.entries(causes).sort((a, b) => b[1] - a[1])) console.log(`               ${String(n).padStart(4)}x ${c}`);
    console.log("             the write that put it back:");
    for (const [c, n] of Object.entries(repairs).sort((a, b) => b[1] - a[1])) console.log(`               ${String(n).padStart(4)}x ${c}`);
    for (const e of ex.slice(0, 6)) {
      console.log(`               t=${e.startT}ms ${e.box} top ${e.prevTop}->${e.startTop} (max ${e.max}, drop ${e.dropPx} px, height grew ${e.growth} px) repaired ${e.repairMs ?? "?"} ms later`);
      if (e.lastWrite) console.log(`                 cause: ${e.lastWrite.by}`);
      if (e.repair) console.log(`                 repair: ${e.repair.by}`);
    }
  }
  // The ledger: every change of a console's scrollTop that no write explains, with what was in the gap.
  const sm = r.silent || [];
  if (!sm.length) {
    console.log("             silent moves (scrollTop changed with no write): 0 - every change in the window is accounted for by a logged write");
  } else {
    const down = sm.filter((s) => s.px < 0);
    const px = sm.map((s) => Math.abs(s.px));
    const grew = sm.filter((s) => Math.abs(s.heightDelta) <= 1);
    console.log(
      `             silent moves (scrollTop changed with no write): ${sm.length}; ${down.length} of them DOWN; |px| p50/p90/max ${med(px)}/${pct(px, 90)}/${Math.max(...px)}; ${grew.length} with scrollHeight unchanged; ${sm.filter((s) => s.via === "nothing logged").length} with nothing logged in the gap`,
    );
    const kinds = {};
    for (const s of sm) kinds[s.via] = (kinds[s.via] || 0) + 1;
    for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`               ${String(n).padStart(4)}x by ${k}`);
    for (const s of sm.slice(0, 5)) {
      console.log(`               t=${s.t}ms ${s.box} ${s.from} -> ${s.to} (${s.px} px, height ${s.heightDelta >= 0 ? "+" : ""}${s.heightDelta}, max ${s.maxDelta >= 0 ? "+" : ""}${s.maxDelta}, ${s.gapMs} ms after the previous write)`);
      if (s.op) console.log(`                 in the gap: ${s.op}`);
      if (s.focus) console.log(`                 in the gap: ${s.focus}`);
    }
  }

  // The self-test: the two things this instrument exists to see, driven on the page after the window closed.
  const st = r.selftest;
  if (st) {
    for (const s of st.steps || []) {
      console.log(`             self-test ${s.ok ? "OK  " : "FAIL"} ${s.what}${s.ok ? `: ${JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => !["ok", "what"].includes(k))))}` : ` - ${s.why || JSON.stringify(s)}`}`);
    }
    const sw = (r.selftestWrites || []).filter((w) => w.asked != null);
    if (sw.length) {
      console.log(`             self-test writes logged (${sw.length}):`);
      for (const w of sw.slice(0, 6)) console.log(`               t=${w.t}ms from ${w.from} -> asked ${w.asked}, landed ${w.landed} (max ${w.max}), ${w.dead ? "no layout, " : ""}by ${w.by}`);
    }
    // The frames between the jump and the repair: the sub-frame excursion the instrument must not miss.
    const fr = (r.selftestFrames || {})[st.box];
    if (fr && st.jumpAt != null) {
      const idx = fr.ts.map((t, i) => (t >= st.jumpAt - 20 && t <= (st.repairAt || st.jumpAt) + 60 ? i : -1)).filter((i) => i >= 0);
      const offs = idx.filter((i) => fr.sh[i] - fr.top[i] - fr.ch[i] > OFF_BOTTOM);
      console.log(`             self-test frames around the jump: ${idx.length}, ${offs.length} of them off the bottom (first top ${idx.length ? fr.top[idx[0]] : "?"}, max ${idx.length ? fr.sh[idx[0]] - fr.ch[idx[0]] : "?"})`);
    }
    const so = r.selftestOps || [];
    const moved = so.filter((o) => /appendChild|insertBefore|replaceWith|replaceChildren/.test(o.op));
    if (moved.length) console.log(`             self-test DOM move logged: ${moved.map((o) => `${o.op} ${o.node} by ${o.by || "(the tool itself - not a page caller)"}`).join(" | ")}`);
  }
}
console.log("");
if (blind) {
  console.log(`NOT MEASURED  ${blind} of ${results.length} layout(s) did not measure what they claim - a pass here would be a pass on nothing`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ tree: TREE, seconds: SECONDS, results }, null, 1));
  process.exit(2);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ tree: TREE, seconds: SECONDS, results }, null, 1));
console.log(`MEASURED  ${results.length} layout(s): every scrollTop write on a console, with its caller, and every frame it painted`);
process.exit(0);
