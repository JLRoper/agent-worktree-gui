// Slot B of the console-popping campaign: does a live console's scrollbar jump, and does its tail hold?
//
// Measures the panel's OWN boxes on a RUNNING instance, one animation frame at a time, and reports per box:
//   hops            a frame where scrollTop drops by more than 20px while the previous frame was pinned at the
//                   tail and nothing the reader did scrolled the box (no wheel/mousedown/keydown on it);
//   tail retention  the longest continuous run of frames with distance-from-bottom <= 8px while rows were being
//                   appended — the reader's question is whether it holds for 60s or more;
//   lag             every excursion where distance-from-bottom > 8px, with its duration and depth (p50/p90/max);
//   jump direction  whether scrollTop ever moved up, down, or both, while output was being appended.
//
// The boxes are the panel's, not a fixture:
//   main output console   `pre.job-out` inside a card (data-out names the turn), scroll container itself;
//   reasoning, own box    `.think-body` inside `details.think[data-think-turn]` (max-height 260px, overflow auto);
//   reasoning, combined   no separate box: the reasoning rows (`.jl-think`) join `pre.job-out`, which is why the
//                         combined conditions measure one box per card and the own-box ones measure two.
//
// It starts the agents it measures through the panel's own create-run path (POST /api/agents) and tops a thread up
// when its turn has finished, so a condition always has output being appended for its whole window. It never
// touches the repository, never commits and never pushes: the agents are told to work in a scratch copy.
//
//   node tools/pop-b.mjs --base http://127.0.0.1:7333
//   node tools/pop-b.mjs --base http://127.0.0.1:7333 --only one-combined --seconds 75
//   node tools/pop-b.mjs --base http://127.0.0.1:7333 --report C:/.../pop-b/report
//
// Options: --base <url> (default http://127.0.0.1:7333), --seconds <n> (default 75), --only <name> (repeatable),
//          --cwd <dir>, --project <name>, --report <dir>, --list.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const all = (name) => argv.map((a, i) => (a === name ? argv[i + 1] : null)).filter(Boolean);
const BASE = String(opt("--base", "http://127.0.0.1:7333")).replace(/\/+$/, "");
const SECONDS = Number(opt("--seconds", "75"));
const CWD = opt("--cwd", "C:/Users/roper/AppData/Local/Temp/wag/pop-b/work/repo");
const PROJECT = opt("--project", "pop-b-probe");
const REPORT = opt("--report", "C:/Users/roper/AppData/Local/Temp/wag/pop-b/report");
const ONLY = all("--only");
const TRACE = argv.includes("--trace");
// --no-think is a MECHANISM probe, not a campaign condition: the same 🌊 card with reasoning switched off, to see
// whether the console still moves when the reasoning poll has nothing to draw into it.
const THINK = !argv.includes("--no-think");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the agents ----------------------------------------------------------------------------------------------
// Three prompts, three shapes of work: a tool loop, a read/patch loop, and one that thinks at length between
// tools. Each is told, in its own words, to stay in the scratch copy and to keep going for the whole window.
const AGENTS = [
  {
    key: "A",
    thread: "popb-a",
    prompt:
      "POPB-A. Work ONLY inside C:/Users/roper/AppData/Local/Temp/wag/pop-b/work/repo (cd there first; never read, " +
      "write or run anything outside it). Make no git commits and push nothing. Check the clock with `date` before " +
      "each step and keep looping until at least 25 minutes have passed since you started; do not stop to ask " +
      "anything and do not summarise early. Each iteration: (1) `node -e \"for (let i=0;i<6;i++) console.log(i, " +
      "Math.random().toString(36).slice(2,10))\"`, (2) `node --test math.test.js`, (3) read math.js, (4) one short " +
      "sentence about what you saw.",
  },
  {
    key: "B",
    thread: "popb-b",
    prompt:
      "POPB-B. Work ONLY inside C:/Users/roper/AppData/Local/Temp/wag/pop-b/work/repo (cd there first; never read, " +
      "write or run anything outside it). Make no git commits and push nothing. Check the clock with `date` before " +
      "each step and keep looping until at least 25 minutes have passed since you started; do not stop to ask " +
      "anything and do not summarise early. Each iteration: append one new line to notes-b.md with a timestamp and " +
      "a random word, read notes-b.md back, grep it for the word you just wrote, and patch the heading count line " +
      "at the top of the file to the number of lines it now has.",
  },
  {
    key: "C",
    thread: "popb-c",
    prompt:
      "POPB-C. Work ONLY inside C:/Users/roper/AppData/Local/Temp/wag/pop-b/work/repo (cd there first; never read, " +
      "write or run anything outside it). Make no git commits and push nothing. Check the clock with `date` before " +
      "each step and keep looping until at least 25 minutes have passed since you started; do not stop to ask " +
      "anything and do not summarise early. Each iteration: think in several paragraphs about how a small test " +
      "suite could fail intermittently (vary the angle every time), then run exactly one command — alternate " +
      "`node --test math.test.js` and `node -e \"console.log(process.version, Date.now())\"` — and then think again " +
      "about what that output means before the next command.",
  },
];

async function api(route, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text };
}

async function jobs() {
  const r = await api("/api/jobs");
  return (r.json?.jobs || []).slice();
}

const latestFor = (list, thread) =>
  list.filter((j) => j.thread === thread).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;

async function spawnTurn(agent) {
  const r = await api("/api/agents", {
    prompt: agent.prompt,
    cwd: CWD,
    project: PROJECT,
    existing: true,
    thread: agent.thread,
  });
  if (r.status !== 202) throw new Error(`spawn refused (${r.status}): ${r.text.slice(0, 300)}`);
  return r.json.job;
}

// A thread whose last turn has finished is topped up with a new turn on the SAME thread, so the card and its
// console keep growing instead of the window measuring a finished transcript.
async function ensureLive(agents) {
  const before = await jobs();
  const out = [];
  for (const a of agents) {
    const last = latestFor(before, a.thread);
    if (last && (last.status === "running" || last.status === "starting")) {
      out.push({ thread: a.thread, turn: last.id, status: last.status, spawned: false });
      continue;
    }
    const job = await spawnTurn(a);
    out.push({ thread: a.thread, turn: job.id, status: job.status, spawned: true });
  }
  return out;
}

// ---- what the page records ------------------------------------------------------------------------------------
// Every animation frame, every console box and every reasoning box that is in the DOM, with the numbers the brief
// asks for. `rows` is there so "was output being appended" is answered by the page, not by a guess.
function recorder({ trace = false } = {}) {
  const R = (window.__popb = { t0: performance.now(), frames: [], inputs: [], errors: [], sets: [] });
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  const now = () => Math.round((performance.now() - R.t0) * 10) / 10;
  // --trace answers "who moved the box": every scrollTop ASSIGNMENT that takes a console up by more than 20px is
  // recorded with the stack that made it. Off by default (a setter on every element is not free).
  if (trace) {
    // Scroll events as the browser reports them (an anchoring adjustment or a clamp writes no value through the
    // setter, so the event is the only witness), plus every DOM move that takes a console or a card holding one out
    // of the tree or puts it back — the panel's own node-moving code is a candidate for "the box went up".
    document.addEventListener(
      "scroll",
      (e) => {
        const el = e.target;
        if (!el || !el.matches || !el.matches("pre.job-out, .think-body")) return;
        R.scrollEvents = R.scrollEvents || [];
        R.scrollEvents.push({ t: now(), key: el.dataset.out ? `out:${el.dataset.out}` : "think", st: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), ch: Math.round(el.clientHeight) });
      },
      true,
    );
    R.muts = [];
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        const hits = [...r.removedNodes, ...r.addedNodes].filter(
          (n) => n && n.nodeType === 1 && (n.matches?.("pre.job-out") || n.querySelector?.("pre.job-out")),
        ).length;
        if (!hits) continue;
        R.muts.push({ t: now(), removed: r.removedNodes.length, added: r.addedNodes.length, consoles: hits, target: String(r.target.className || r.target.nodeName).slice(0, 60) });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    // Every other way JS can move a scroll area: scrollTo / scrollBy / scrollIntoView / scroll. A box scrolled by any
    // of these writes no scrollTop value, so without this the setter's silence is not evidence of anything.
    const instruments = [
      [Element.prototype, "scrollTo"],
      [Element.prototype, "scrollBy"],
      [Element.prototype, "scroll"],
      [Element.prototype, "scrollIntoView"],
      [HTMLElement.prototype, "scrollIntoView"],
    ];
    for (const [proto, name] of instruments) {
      const orig = proto && proto[name];
      if (typeof orig !== "function") continue;
      proto[name] = function (...args) {
        try {
          const box = this.closest?.("pre.job-out, .think-body");
          if (box) {
            const before = box.scrollTop;
            const who = this.tagName + (this.className ? "." + String(this.className).slice(0, 30) : "");
            queueMicrotask(() => {
              if (before - box.scrollTop > 20) {
                R.sets.push({ t: now(), via: name, key: `out:${box.dataset.out || ""}`, from: Math.round(before), to: Math.round(box.scrollTop), node: who, stack: String(new Error().stack || "").split("\n").slice(1, 7).map((s) => s.trim()).join(" | ") });
              }
            });
          }
        } catch {
          /* instrument only */
        }
        return orig.apply(this, args);
      };
    }
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      enumerable: true,
      get() {
        return proto.get.call(this);
      },
      set(v) {
        try {
          const cur = proto.get.call(this);
          if (this.matches?.("pre.job-out, .think-body") && cur - Number(v) > 20) {
            R.sets.push({
              t: now(),
              via: "scrollTop",
              key: this.dataset.out ? `out:${this.dataset.out}` : `think:${this.closest("details.think")?.dataset.thinkTurn || ""}`,
              from: Math.round(cur),
              to: Math.round(Number(v)),
              stack: String(new Error().stack || "").split("\n").slice(1, 7).map((s) => s.trim()).join(" | "),
            });
          }
        } catch {
          /* a getter that throws must not break the page */
        }
        proto.set.call(this, v);
      },
    });
  }
  for (const type of ["wheel", "mousedown", "pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(
      type,
      (e) => {
        const t = e.target;
        const box = t && t.closest ? t.closest("pre.job-out, .think-body") : null;
        if (box) R.inputs.push({ t: now(), type, key: box.dataset.out ? `out:${box.dataset.out}` : "think" });
      },
      true,
    );
  }
  const boxes = () => {
    const list = [];
    for (const card of document.querySelectorAll(".job")) {
      const thread = card.dataset.thread || "";
      const collapsed = card.classList.contains("collapsed");
      for (const pre of card.querySelectorAll("pre.job-out")) {
        // A console that has been replaced by a fresh node is a different scroll area even when it looks the same:
        // stamping the node is what tells "the box moved" from "the box was swapped".
        pre.__popbNode = pre.__popbNode || `n${(window.__popbNodeSeq = (window.__popbNodeSeq || 0) + 1)}`;
        list.push({ key: `out:${thread}:${pre.dataset.out || ""}`, thread, kind: "out", el: pre, collapsed, node: pre.__popbNode });
      }
      for (const d of card.querySelectorAll("details.think")) {
        const body = d.querySelector(".think-body");
        if (!body) continue;
        body.__popbNode = body.__popbNode || `n${(window.__popbNodeSeq = (window.__popbNodeSeq || 0) + 1)}`;
        list.push({ key: `think:${thread}:${d.dataset.thinkTurn || ""}`, thread, kind: "think", el: body, collapsed, node: body.__popbNode });
      }
    }
    return list;
  };
  const tick = () => {
    const t = now();
    const frame = { t, boxes: [] };
    for (const b of boxes()) {
      const el = b.el;
      if (!el || !el.isConnected) continue;
      const st = el.scrollTop;
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      frame.boxes.push({
        k: b.key,
        kind: b.kind,
        thread: b.thread,
        st: Math.round(st * 10) / 10,
        sh: Math.round(sh * 10) / 10,
        ch: Math.round(ch * 10) / 10,
        d: Math.round((sh - st - ch) * 10) / 10,
        rows: el.querySelectorAll(".jl, .think-block").length,
        n: b.node,
        vis: !b.collapsed && el.getClientRects().length > 0,
      });
    }
    R.frames.push(frame);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- the analysis ---------------------------------------------------------------------------------------------
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return Math.round(s[i] * 10) / 10;
};

function analyse(frames, inputs) {
  const byKey = new Map();
  for (const f of frames) {
    for (const b of f.boxes) {
      if (!byKey.has(b.k)) byKey.set(b.k, { key: b.k, kind: b.kind, thread: b.thread, pts: [] });
      byKey.get(b.k).pts.push({ t: f.t, ...b });
    }
  }
  const boxes = [];
  for (const box of byKey.values()) {
    const pts = box.pts;
    const overflowing = pts.filter((p) => p.sh > p.ch + 8).length;
    const hops = [];
    const downDeltas = [];
    const upDeltas = [];
    const appends = [];
    const shrinks = [];
    let nodeChanges = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const prev = pts[i - 1];
      const cur = pts[i];
      // "Output was being appended" is CONTENT GROWTH, not a new row: a streamed thinking block or a tool result
      // that is still arriving makes the box taller without adding a row, and that is most of what a live console
      // does. Row count is kept as a second signal for a burst that lands in one frame.
      const appended = cur.sh > prev.sh + 0.5 || cur.rows > prev.rows;
      if (appended) appends.push(cur.t);
      const shrank = cur.sh < prev.sh - 0.5;
      if (shrank) shrinks.push({ t: cur.t, from: prev.sh, to: cur.sh });
      const swapped = prev.n !== cur.n;
      if (swapped) nodeChanges += 1;
      // A hop: the box moved UP by more than 20px between two frames, it was pinned at the tail in the frame
      // before, and no reader input touched it in the 400ms leading up to the frame.
      const dropped = prev.st - cur.st > 20;
      const pinnedBefore = prev.d <= 8;
      const touched = inputs.some((x) => x.t <= cur.t && x.t > cur.t - 400);
      if (dropped && pinnedBefore && !touched) {
        // How it came back: the highest scrollTop in the next 250ms, so a jump that is silently re-stuck reads as
        // one, and a jump the box stays away from reads as another.
        const back = pts.filter((p) => p.t > cur.t && p.t <= cur.t + 250).map((p) => p.st);
        hops.push({ t: cur.t, from: prev.st, to: cur.st, drop: Math.round(prev.st - cur.st), shFrom: prev.sh, shTo: cur.sh, rows: cur.rows, swapped, backTo: back.length ? Math.max(...back) : null });
      }
      if (appended) {
        if (cur.st - prev.st > 1) downDeltas.push(cur.st - prev.st);
        if (prev.st - cur.st > 1) upDeltas.push(prev.st - cur.st);
      }
    }
    // Tail retention: the longest run of consecutive frames at the tail (d <= 8) that contains at least one
    // appended row — "stays pinned while output arrives".
    let best = null;
    let run = null;
    const flush = () => {
      if (!run) return;
      if (run.appended && (!best || run.to - run.from > best.to - best.from)) best = run;
      run = null;
    };
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const appended = i > 0 && (p.sh > pts[i - 1].sh + 0.5 || p.rows > pts[i - 1].rows);
      if (p.d <= 8) {
        if (!run) run = { from: p.t, to: p.t, frames: 0, appended: false };
        run.to = p.t;
        run.frames += 1;
        if (appended) run.appended = true;
      } else {
        flush();
      }
    }
    flush();
    // Lag: every stretch where the box was off the tail, with how long it lasted and how deep it went.
    const excursions = [];
    let cur = null;
    for (const p of pts) {
      if (p.d > 8) {
        if (!cur) cur = { from: p.t, to: p.t, maxD: 0 };
        cur.to = p.t;
        cur.maxD = Math.max(cur.maxD, p.d);
      } else if (cur) {
        excursions.push(cur);
        cur = null;
      }
    }
    if (cur) excursions.push(cur);
    const durations = excursions.map((e) => Math.round(e.to - e.from));
    const depths = excursions.map((e) => Math.round(e.maxD));
    const dirs = [upDeltas.length ? "up" : null, downDeltas.length ? "down" : null].filter(Boolean);
    boxes.push({
      key: box.key,
      kind: box.kind,
      thread: box.thread,
      frames: pts.length,
      framesOverflowing: overflowing,
      sh: pts.length ? { min: Math.min(...pts.map((p) => p.sh)), max: Math.max(...pts.map((p) => p.sh)) } : null,
      ch: pts.length ? Math.round(pts[pts.length - 1].ch) : null,
      pinnedFrames: pts.filter((p) => p.d <= 8).length,
      rowsAppended: Math.max(0, pts[pts.length - 1].rows - pts[0].rows),
      appendFrames: appends.length,
      nodeChanges,
      shrinks: shrinks.length,
      shrinkDetail: shrinks.slice(0, 8),
      hops: hops.length,
      hopTimes: hops.map((h) => h.t),
      hopDetail: hops.slice(0, 12),
      tailLongest: best ? Math.round((best.to - best.from) / 100) / 10 : 0,
      tailRuns: (() => {
        const runs = [];
        let r = null;
        for (let i = 0; i < pts.length; i += 1) {
          const p = pts[i];
          const appended = i > 0 && (p.sh > pts[i - 1].sh + 0.5 || p.rows > pts[i - 1].rows);
          if (p.d <= 8) {
            if (!r) r = { from: p.t, to: p.t, appended: false };
            r.to = p.t;
            if (appended) r.appended = true;
          } else if (r) {
            runs.push(r);
            r = null;
          }
        }
        if (r) runs.push(r);
        return runs.filter((x) => x.appended).map((x) => Math.round((x.to - x.from) / 100) / 10);
      })(),
      lag: {
        excursions: excursions.length,
        framesOffTail: pts.filter((p) => p.d > 8).length,
        durations: { p50: pct(durations, 50), p90: pct(durations, 90), max: durations.length ? Math.max(...durations) : null },
        depths: { p50: pct(depths, 50), p90: pct(depths, 90), max: depths.length ? Math.max(...depths) : null },
      },
      direction: dirs.length ? dirs.join("+") : "neither",
    });
  }
  return boxes;
}

// ---- the conditions -------------------------------------------------------------------------------------------
// "combined" is the 🌊 one-stream card: reasoning is rows of the console (.jl-think), so one box per card.
// "own box" is the condensed card with 🧠 on: the reasoning is a details.think block with its own scroller.
const CONDITIONS = [
  { name: "one-combined", agents: ["A"], mode: "combined", minimise: [], what: "one agent writing, reasoning combined with the output" },
  { name: "one-ownbox", agents: ["A"], mode: "ownbox", minimise: [], what: "one agent writing, reasoning in its own box" },
  { name: "three-combined", agents: ["A", "B", "C"], mode: "combined", minimise: [], what: "three agents writing at once, combined" },
  { name: "three-ownbox", agents: ["A", "B", "C"], mode: "ownbox", minimise: [], what: "three agents writing at once, own box" },
  { name: "three-combined-min", agents: ["A", "B", "C"], mode: "combined", minimise: ["B", "C"], what: "three agents writing, combined, the other two rows minimised" },
  { name: "three-ownbox-min", agents: ["A", "B", "C"], mode: "ownbox", minimise: ["B", "C"], what: "three agents writing, own box, the other two rows minimised" },
];

if (argv.includes("--list")) {
  for (const c of CONDITIONS) console.log(`${c.name}\t${c.what}`);
  process.exit(0);
}

const chosen = ONLY.length ? CONDITIONS.filter((c) => ONLY.includes(c.name)) : CONDITIONS;
if (!chosen.length) {
  console.log(`no condition matches ${ONLY.join(", ")}`);
  process.exit(2);
}

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(2);
}
mkdirSync(REPORT, { recursive: true });

const health = await api("/api/config");
console.log(`instance ${BASE} · version ${health.json?.version || "?"} · ${SECONDS}s per condition`);
const stamp = await api("/api/build").then((r) => r.json?.build || null).catch(() => null);
if (stamp) console.log(`build ${String(stamp).slice(0, 12)}`);

const browser = await pw.chromium.launch({ headless: true });
const results = [];
const startedAt = new Date().toISOString();
try {
  for (const cond of chosen) {
    const agents = cond.agents.map((k) => AGENTS.find((a) => a.key === k));
    const live = await ensureLive(agents);
    console.log(`\n== ${cond.name} — ${cond.what}`);
    console.log(`   threads: ${live.map((l) => `${l.thread}=${l.turn}${l.spawned ? " (new turn)" : ""}`).join(", ")}`);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    // The mode is per session and set before the page's own scripts run, so the card is BUILT in the shape under
    // test instead of being toggled after the fact.
    await context.addInitScript(
      ({ threads, mode, minimise, think }) => {
        localStorage.setItem("wtgui.think", think ? "1" : "0");
        for (const t of threads) {
          localStorage.setItem(`wtgui.think.${t}`, think ? "1" : "0");
          localStorage.setItem(`wtgui.stream.${t}`, mode === "combined" ? "1" : "0");
        }
        // A minimised card is remembered per browser by the panel itself (`wm.collapsedJobs`), so the condition is
        // built that way before the first paint instead of being clicked into place and measured mid-render.
        if (minimise.length) localStorage.setItem("wm.collapsedJobs", JSON.stringify(minimise));
      },
      { threads: agents.map((a) => a.thread), mode: cond.mode, minimise: cond.minimise.map((k) => AGENTS.find((a) => a.key === k).thread), think: THINK },
    );
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console: ${m.text().slice(0, 200)}`);
    });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
    // The board draws a row's cards only when the row is open; the chip the panel itself offers jumps to it.
    await page.evaluate(() => document.querySelector("[data-jump-panel]")?.click());
    await sleep(1500);
    // A card that should be minimised is clicked into place up to three times: a card created for a turn that started
    // after the page loaded paints itself open, and one click can land before that paint.
    const collapseWanted = cond.minimise.map((k) => AGENTS.find((a) => a.key === k).thread);
    for (let pass = 0; pass < 3; pass += 1) {
      const left = await page.evaluate(
        ({ threads }) => {
          for (const d of document.querySelectorAll("details.think")) if (!d.open) d.querySelector("summary")?.click();
          const still = [];
          for (const t of threads) {
            const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
            if (!card) {
              still.push(t);
              continue;
            }
            if (!card.classList.contains("collapsed")) card.querySelector(".job-head")?.click();
          }
          return still;
        },
        { threads: collapseWanted },
      );
      await sleep(1200);
      const now = await page.evaluate(
        ({ threads }) => threads.filter((t) => !document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`)?.classList.contains("collapsed")),
        { threads: collapseWanted },
      );
      if (!now.length) break;
      if (pass === 2) console.log(`   WARNING  these cards would not stay minimised: ${now.join(", ")} (left = ${left.join(",") || "none"})`);
    }
    const shaped = await page.evaluate(
      ({ threads }) => {
        const out = { cards: [], notes: [] };
        for (const t of threads) {
          const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
          if (!card) {
            out.notes.push(`no card for ${t}`);
            continue;
          }
          out.cards.push({
            thread: t,
            collapsed: card.classList.contains("collapsed"),
            outs: card.querySelectorAll("pre.job-out").length,
            thinks: card.querySelectorAll("details.think").length,
          });
        }
        return out;
      },
      { threads: agents.map((a) => a.thread) },
    );
    console.log(`   cards: ${JSON.stringify(shaped.cards)}${shaped.notes.length ? " · " + shaped.notes.join("; ") : ""}`);
    await sleep(2500);
    await page.evaluate(recorder, { trace: TRACE });
    await sleep(SECONDS * 1000);
    const R = await page.evaluate(() => window.__popb);
    // Only the cards under test: another thread's finished console on the same board is not part of this condition.
    const want = new Set(agents.map((a) => a.thread));
    // A minimised card has no scroller to measure (its console is not laid out): those threads are still writing,
    // which is the point of the condition, but the numbers are the visible card's. The set comes from what the card
    // ACTUALLY is after the clicks, not from what the condition asked for.
    const hidden = new Set((shaped.cards || []).filter((c) => c.collapsed).map((c) => c.thread));
    const measured = analyse(R.frames, R.inputs);
    const boxes = measured.filter((b) => want.has(b.thread) && !hidden.has(b.thread));
    if (measured.length !== boxes.length) console.log(`   (${measured.length - boxes.length} box(es) on other/minimised cards ignored)`);
    const shot = path.join(REPORT, `pop-b-${cond.name}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    const row = { ...cond, at: new Date().toISOString(), seconds: SECONDS, frames: R.frames.length, boxes, errors: [...pageErrors, ...R.errors] };
    results.push(row);
    writeFileSync(path.join(REPORT, `pop-b-${cond.name}.json`), JSON.stringify({ ...row, frames: R.frames.length, inputs: R.inputs }, null, 1));
    for (const b of boxes) {
      console.log(
        `   ${b.kind === "out" ? "console" : "reason"} ${b.key.padEnd(34)} frames ${String(b.frames).padStart(5)} · overflow ${String(b.framesOverflowing).padStart(5)} · +${b.rowsAppended} rows / ${b.appendFrames} growth frames / ${b.shrinks} shrinks · hops ${String(b.hops).padStart(3)} · tail ${String(b.tailLongest).padStart(6)}s · lag ${b.lag.excursions}x / ${b.lag.framesOffTail} frames off tail p50 ${b.lag.durations.p50 ?? "-"}ms p90 ${b.lag.durations.p90 ?? "-"}ms max ${b.lag.durations.max ?? "-"}ms · depth max ${b.lag.depths.max ?? "-"}px · ${b.direction}`,
      );
    }
    if (row.errors.length) console.log(`   page errors: ${row.errors.slice(0, 3).join(" | ")}`);
    if (TRACE && R.sets.length) {
      const byStack = new Map();
      for (const s of R.sets) byStack.set(s.stack, (byStack.get(s.stack) || 0) + 1);
      console.log(`   traced scrollTop assignments that went UP: ${R.sets.length}`);
      for (const [stack, n] of [...byStack.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
        console.log(`     ${n}x  ${stack.replace(/https?:\/\/127\.0\.0\.1:7333/g, "").slice(0, 420)}`);
      }
      writeFileSync(path.join(REPORT, `pop-b-${cond.name}-sets.json`), JSON.stringify(R.sets, null, 1));
    }
    if (TRACE) {
      // What was happening in the 120ms around each hop: a console node leaving/entering the DOM, a scroll event the
      // browser raised, or neither. This is how "who moved the box" is answered without guessing.
      const near = (t, list, win = 120) => (list || []).filter((x) => Math.abs(x.t - t) <= win).length;
      for (const b of boxes) {
        if (!b.hops) continue;
        const withMut = b.hopTimes.filter((t) => near(t, R.muts)).length;
        const withScroll = b.hopTimes.filter((t) => near(t, R.scrollEvents)).length;
        const withSet = b.hopTimes.filter((t) => near(t, R.sets)).length;
        console.log(`   ${b.key}: ${b.hops} hops · ${withMut} within 120ms of a console DOM move · ${withScroll} of a scroll event · ${withSet} of a scrollTop assignment`);
        const span = R.frames.length ? R.frames[R.frames.length - 1].t : 0;
        console.log(`   window ${Math.round(span / 1000)}s: ${(R.muts || []).length} console DOM moves, ${(R.scrollEvents || []).length} scroll events on the boxes`);
      }
      writeFileSync(path.join(REPORT, `pop-b-${cond.name}-trace.json`), JSON.stringify({ sets: R.sets, muts: R.muts, scrollEvents: R.scrollEvents || [] }, null, 1));
    }
    await context.close();
  }
} finally {
  await browser.close().catch(() => {});
}

const summary = { base: BASE, startedAt, seconds: SECONDS, conditions: results };
writeFileSync(path.join(REPORT, "pop-b-summary.json"), JSON.stringify(summary, null, 1));
console.log(`\nwrote ${path.join(REPORT, "pop-b-summary.json")}`);
