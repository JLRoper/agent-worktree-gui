// Slot A of the console-popping campaign: drive a REAL panel instance (its own port, config, data dir and scratch)
// through three live agents doing loops of tool calls, and record — on every animation frame — what both console
// boxes do. Nothing here changes the product; this is a measurement harness.
//
//   node tools/pop-a.mjs spawn        [--agents 3] [--cycles 20] [--work <dir>] [--project <name>]
//   node tools/pop-a.mjs record       --scenario <name> --mode own|combined --seconds 80 [--threads t1,t2]
//                                     [--minimise t2,t3] [--out <dir>]
//   node tools/pop-a.mjs report       # the table, from every scenario-*.json in --out
//   node tools/pop-a.mjs resummarise  # re-derive every stored scenario from its RAW frames, no agents needed
//   node tools/pop-a.mjs kill         # stop the runs this tool started (POST /api/jobs/cancel)
//
// `--threads` is also the MEASUREMENT filter: a stopped card from an earlier condition is still on the board, and
// sampling its console would turn a one-agent run into a three-agent one. `--minimise` names the cards to leave folded
// (their boxes are display:none, so they are not measurable at all — that is the condition, not a gap in the data).
//
// It attaches to an ALREADY RUNNING instance (default http://127.0.0.1:7332) and never starts or restarts one: the
// instance is stood up by hand from the worktree so its state (PANEL_CONFIG + dataDir + scratchDir) is provably its
// own. `spawn` uses the panel's own create-run route (POST /api/agents, `existing: true`), so the cards are real
// cards on a real board; `record` opens the page in Chromium through tools/browser.mjs and instruments it.
//
// WHAT IS RECORDED, per overflowing box, on every animation frame
//   pre.job-out          the main output console (the scroller is the <pre> itself)
//   details.think .think-body   the reasoning console when it has its own box (max-height 260px, overflow auto)
//   in `combined` mode the reasoning is lines of the main console (🌊 one-stream renderer), so there is no second
//   box to measure and the field is empty — recorded as such, not as "0 hops".
// For each frame: scrollTop, scrollHeight, clientHeight, distance from the bottom (scrollHeight - scrollTop -
// clientHeight), pinned = distance <= 8, the box's child count, clientWidth, and how many scrollTop WRITES landed on
// it since the previous frame. Writes come from a hook on Element.prototype.scrollTop, with the box's
// scrollHeight at the time and the top of the call stack, which is how a write is attributed to the function that
// made it (`setScroll < stickConsole < run` is the settle pass; `setScroll < paintTypedLines < onPaint < tick` is the
// type pacer). The panel's own setScroll() stamps `_selfTop` before writing, so a write whose value equals `_selfTop`
// is the panel's, and anything else (there is no other writer in this build) is not.
//
// AND, because a rAF sample is taken before the frame's layout, a SECOND read per frame from a 0ms timer queued in
// the same callback — after the frame's rendering steps — so `painted` says whether the reader could see what the
// sample measured. A hop and a painted hop are different claims; both are reported.
//
// WHAT IS COMPUTED, per box (tools/pop-a.mjs report; the definitions live in `summarise` below)
//   hops         frames where scrollTop dropped > 20px, the previous frame was pinned, and NO scrollTop write
//                reached that box in the frame — with their timings, split by whether the content also shrank
//   tail         the longest run of frames at distance <= 8px, and separately the longest such run while output was
//                being appended (>= 2 child-count changes inside it) — the reader's "does it hold 60s"
//   lag          excursions above 8px: count, and p50/p90/max of their duration and of their depth
//   direction    up-only / down-only / both, from unexplained drops and unexplained rises > 20px
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0] || "report";
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const BASE = String(opt("--base", "http://127.0.0.1:7332")).replace(/\/+$/, "");
const OUT = opt("--out", "C:/Users/roper/AppData/Local/Temp/wag/pop-a/out");
const WORK = opt("--work", "C:/Users/roper/AppData/Local/Temp/wag/pop-a/work");
const PROJECT = opt("--project", "pop-a");
const SECONDS = Number(opt("--seconds", 80));
const MODE = String(opt("--mode", "own"));
const SCENARIO = String(opt("--scenario", `${MODE}-${SECONDS}s`));
const THREADS = opt("--threads", null);
const MINIMISE = String(opt("--minimise", "") || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const threadsFile = path.join(OUT, "agent-threads.json");

const api = async (p, body = null, method = null) => {
  const r = await fetch(`${BASE}${p}`, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (!r.ok) throw new Error(`${method || (body ? "POST" : "GET")} ${p} → ${r.status}: ${text.slice(0, 300)}`);
  return json;
};

// ---- spawn -----------------------------------------------------------------------------------------------------
// The prompt is the measurement's fuel: a long loop of SMALL, sequential tool calls with prose between them, so the
// console streams continuously instead of jumping a whole cycle at once. Each agent gets its own folder under the
// instance's scratch directory and is told, in the body, to make no commits anywhere.
function promptFor(agent, cycles) {
  const scratch = `C:/Users/roper/AppData/Local/Temp/wag/pop-a/scratch/${agent}`;
  return `Work ONLY inside ${scratch} — create that folder if it is missing. Make no git commits anywhere, do not touch any other directory, and do not ask questions.

This is a long streaming exercise: keep working until the cycle count is done, and do not stop early.

Repeat the cycle below ${cycles} times. Make ONE tool call at a time and read each result before the next call; never batch two steps into one command.

Before every tool call, write three to five sentences of reasoning about what you expect that call to return and why the value matters. Then make exactly one call.

Cycle steps (n = the cycle number):
1. Run: node -e "let s=0;for(let i=1;i<=20;i++)s+=i*i;console.log('${agent} n='+n+' sum='+s)"
2. Write a 12-line text file at ${scratch}/cycle-<n>.txt recording the cycle number, the sum you got, and one sentence about what you are doing.
3. Run: grep -c . ${scratch}/cycle-<n>.txt
4. Run: wc -l ${scratch}/cycle-<n>.txt
5. Run: sha256sum ${scratch}/cycle-<n>.txt

Use the absolute path in every command. After each cycle say one sentence about it, then start the next one immediately.`;
}

async function spawn() {
  const n = Number(opt("--agents", 3));
  const cycles = Number(opt("--cycles", 20));
  mkdirSync(OUT, { recursive: true });
  const made = [];
  for (let i = 1; i <= n; i++) {
    const agent = `agent${i}`;
    const body = { prompt: promptFor(agent, cycles), cwd: WORK, existing: true, project: PROJECT, reasoningEffort: "high" };
    const answer = await api("/api/agents", body);
    const job = answer.job || answer;
    made.push({ agent, thread: job.thread, id: job.id });
    console.log(`spawned ${agent}: ${job.id} thread ${job.thread}`);
    // Stagger the starts a little so their tool bursts do not land in lockstep.
    if (i < n) await sleep(1500);
  }
  writeFileSync(threadsFile, JSON.stringify(made, null, 1));
  console.log(`\nthreads → ${threadsFile}`);
  return made;
}

async function killRuns() {
  const jobs = (await api("/api/jobs")).jobs || [];
  let stopped = 0;
  for (const j of jobs) {
    if (!["running", "starting", "waiting"].includes(String(j.status || ""))) continue;
    try {
      await api("/api/jobs/cancel", { id: j.id });
      stopped += 1;
      console.log(`cancelled ${j.id} (${j.thread})`);
    } catch (e) {
      console.log(`could not cancel ${j.id}: ${e.message}`);
    }
  }
  console.log(`${stopped} run(s) cancelled`);
}

// ---- the page-side recorder ------------------------------------------------------------------------------------
// One clock (window.__t0), one hook, one rAF loop. Everything it needs to decide a hop is recorded here rather than
// inferred later: a per-frame sample PLUS the scrollTop writes that landed between frames.
function pageInit({ mode, threads, minimise, seconds }) {
  const T0 = performance.now();
  window.__t0 = T0;
  try {
    localStorage.setItem("wtgui.autoCollect", "0");
    for (const t of threads) {
      localStorage.setItem(`wtgui.think.${t}`, "1");
      localStorage.setItem(`wtgui.stream.${t}`, mode === "combined" ? "1" : "0");
    }
    // Whisper the card fold state in before the first render: minimised cards render head + one line, no console.
    localStorage.setItem("wm.collapsedJobs", JSON.stringify(minimise));
  } catch {
    /* private mode */
  }
  const P = (window.__pop = {
    t0: T0,
    mode,
    threads,
    minimise,
    seconds,
    boxes: new Map(), // key -> { k, frames: [[t, st, sh, ch, rows, writes]] }
    writes: [], // { t, k, from, to, self, sh, ch, stack }
    post: [], // [t, k, distance] read AFTER the frame's rendering steps — what that frame painted
    muts: [], // { t, k, type, lid, lkind, grp, added, removed } — what changed inside a console, and when
    resizes: [], // { t, k, lid, from, to } — a ROW's height moved, with the row named
    scrolls: [], // { t, k, trusted }
    errors: [],
    frames: 0,
    hiddenFrames: 0,
    stopped: false,
    startedAt: null,
  });
  // ONE KEY PER NODE, not per turn. The board can hold two copies of the same conversation for a frame (a row detail
  // and the one a sweep is about to drop), and both carry the same `data-out`; with a per-turn key their scroll writes
  // land on one series and the numbers become unattributable. The base (turn) is what the report groups on, the uid is
  // what makes a write belong to the node it was written to.
  P.nextUid = 0;
  // Only the cards this scenario names are measured. A stopped card from an earlier condition is still on the board,
  // and its console is a box like any other: sampling it would silently turn a one-agent run into a three-agent one.
  const wanted = new Set(threads);
  const cardThread = (el) => el.closest?.(".job[data-thread]")?.dataset.thread || null;
  const baseOf = (el) => {
    if (!el || el.nodeType !== 1 || !el.dataset) return "";
    const thread = cardThread(el);
    if (thread && !wanted.has(thread)) return "";
    if (el.tagName === "PRE" && el.classList.contains("job-out")) return `out:${el.dataset.out}`;
    if (el.classList && el.classList.contains("think-body")) return `think:${el.closest("details.think")?.dataset.thinkTurn || "?"}`;
    return "";
  };
  const keyOf = (el) => {
    const base = baseOf(el);
    if (!base) return "";
    if (!el.__popUid) el.__popUid = ++P.nextUid;
    return `${base}#${el.__popUid}`;
  };
  // The attribution hook: every scrollTop write to a measured box, with where it came from and whether the panel
  // owns it (`_selfTop` is stamped by setScroll immediately before the write).
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  let since = new Map(); // key -> writes since the last frame
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      return desc.get.call(this);
    },
    set(v) {
      const k = keyOf(this);
      if (k) {
        const self = this._selfTop != null && Math.abs(Number(this._selfTop) - Number(v)) <= 1;
        // The stack is what names the writer. Only the first four frames, and only the function names: a full stack
        // string per write on a hot console is the expensive half of this whole hook.
        const stack = String(new Error().stack || "")
          .split("\n")
          .slice(2, 6)
          .map((l) => l.trim().replace(/^at\s+/, "").replace(/\s*\(.*$/, "").replace(/^.*\//, ""))
          .join(" < ");
        const rec = { t: Math.round((performance.now() - T0) * 10) / 10, k, from: desc.get.call(this), to: v, self, sh: this.scrollHeight, ch: this.clientHeight, stack };
        P.writes.push(rec);
        if (P.writes.length > 40000) P.writes.splice(0, 4000);
        since.set(k, (since.get(k) || 0) + 1);
      }
      return desc.set.call(this, v);
    },
  });
  // WHAT CHANGED THE CONTENT, in the same frame the pin was lost. A scrollTop drop with no write is a layout clamp,
  // and a clamp needs the content to get shorter for a moment — so the writer that ran is the thing to name. Every
  // mutation under a console is recorded with the row it touched (`data-lid` / `data-lkind`), which is how the frame
  // that lost 35px points at the row that lost two lines.
  const mo = new MutationObserver((records) => {
    const t = Math.round((performance.now() - T0) * 10) / 10;
    for (const r of records) {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const pane = el && el.closest ? el.closest("pre.job-out, .think-body") : null;
      if (!pane) continue;
      const k = keyOf(pane);
      if (!k) continue;
      const row = el.closest ? el.closest("[data-lid]") : null;
      const grp = el.closest ? el.closest("[data-tgrp]") : null;
      P.muts.push({
        t,
        k,
        type: r.type,
        lid: row ? row.dataset.lid : null,
        lkind: row ? row.dataset.lkind || row.className || null : null,
        grp: grp ? "tgrp" : null,
        added: r.addedNodes ? r.addedNodes.length : 0,
        removed: r.removedNodes ? r.removedNodes.length : 0,
      });
      if (P.muts.length > 60000) P.muts.splice(0, 6000);
    }
  });
  mo.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  // WHICH ROW CHANGED HEIGHT, exactly. The clamp needs the content to be shorter at layout time, and a row that is
  // re-rendered in two steps (text written short, then long) is the only thing in this console that does that on a
  // clock. A ResizeObserver on every row of a measured box says which row, and by how much, in the same frame.
  const heights = new WeakMap();
  const ro = new ResizeObserver((entries) => {
    const t = Math.round((performance.now() - T0) * 10) / 10;
    for (const e of entries) {
      const el = e.target;
      const h = Math.round((e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height) || 0);
      const was = heights.get(el);
      if (was == null) {
        heights.set(el, h);
        continue;
      }
      if (Math.abs(h - was) < 3) continue;
      heights.set(el, h);
      P.resizes.push({ t, k: el.__popK || "", lid: el.__popLid || null, from: was, to: h });
      if (P.resizes.length > 20000) P.resizes.splice(0, 2000);
    }
  });
  P.observeRows = (box) => {
    for (const child of box.children) {
      if (child.__popObs) continue;
      child.__popObs = true;
      child.__popK = keyOf(box);
      child.__popLid = child.dataset?.lid || child.dataset?.tgrp || child.className || null;
      ro.observe(child);
    }
  };
  // A scroll the reader makes is the only thing that may legitimately un-pin a box, so it is recorded separately
  // (and is always `isTrusted:false` here — the harness never touches the page).
  document.addEventListener(
    "scroll",
    (e) => {
      const t = e.target;
      const k = keyOf(t);
      if (!k) return;
      P.scrolls.push({ t: Math.round((performance.now() - T0) * 10) / 10, k, trusted: Boolean(e.isTrusted) });
    },
    true,
  );
  const sample = () => {
    const t = Math.round((performance.now() - T0) * 10) / 10;
    const seen = new Set();
    for (const el of document.querySelectorAll("pre.job-out, .think-body")) {
      const k = keyOf(el);
      if (!k) continue;
      // A minimised card's console is display:none: clientHeight 0 is not a box that can be pinned, scrolled or
      // measured, and counting it would report a permanent 0-distance "pinned" run for a card nobody can see.
      const ch = el.clientHeight;
      if (!ch) continue;
      seen.add(k);
      let box = P.boxes.get(k);
      if (!box) {
        box = { k, frames: [] };
        P.boxes.set(k, box);
      }
      // clientWidth rides along: a re-wrap is what a width change does, and a re-wrap is the only layout change a
      // console can suffer with no mutation inside it at all.
      box.frames.push([t, Math.round(el.scrollTop), Math.round(el.scrollHeight), ch, el.children.length, since.get(k) || 0, el.clientWidth]);
      P.observeRows(el);
    }
    since = new Map();
    // THE PAINT PROBE. A rAF sample is taken before the frame's layout and before anything another callback of the
    // same frame does, so it can catch a displacement that never reaches the screen — the difference between "the
    // pin dropped" and "the reader saw it drop". A 0ms timer queued here runs after the rendering steps, so what it
    // reads is what the frame painted. Recorded per frame, per box, as a distance only (that is all it is asked).
    const paintAt = Math.round((performance.now() - T0) * 10) / 10;
    setTimeout(() => {
      for (const el of document.querySelectorAll("pre.job-out, .think-body")) {
        const k = keyOf(el);
        if (!k || !el.clientHeight) continue;
        P.post.push([paintAt, k, el.scrollHeight - el.scrollTop - el.clientHeight]);
      }
    }, 0);
    // A box that left the DOM (card rebuilt, row collapsed, turn folded) is not sampled this frame; that is data
    // too, and the gap is what a rebuild looks like from here.
    P.frames += 1;
    if (document.hidden) P.hiddenFrames += 1;
    if (!P.stopped) requestAnimationFrame(sample);
  };
  window.addEventListener("error", (e) => P.errors.push(String((e && e.message) || e)));
  requestAnimationFrame(() => {
    P.startedAt = performance.now() - T0;
    sample();
  });
  P.stats = () => ({ frames: P.frames, boxes: [...P.boxes.keys()], hidden: P.hiddenFrames, writes: P.writes.length, seconds: Math.round((performance.now() - T0) / 100) / 10 });
  P.dump = () => {
    P.stopped = true;
    return {
      t0: P.t0,
      frames: P.frames,
      hiddenFrames: P.hiddenFrames,
      errors: P.errors,
      boxes: [...P.boxes.values()],
      writes: P.writes,
      post: P.post,
      muts: P.muts,
      resizes: P.resizes,
      scrolls: P.scrolls,
      mode: P.mode,
      threads: P.threads,
      minimise: P.minimise,
    };
  };
}

// ---- page prep: get every card on screen, in the shape the scenario asks for ------------------------------------
// A fresh browser context draws the board folded, so nothing is on screen until the project, the row and each card
// are opened. The fold state is localStorage (`wm.collapsedJobs`), so the cards the scenario wants MINIMISED are
// written there before the page's scripts run and are never clicked open.
async function prepPage(page, threads, minimise) {
  // The cards the scenario wants MINIMISED are never opened: their fold state is already in localStorage, and clicking
  // a head to "make sure" is what turned a minimised run into an all-expanded one.
  const open = () =>
    page.evaluate(({ want, keep }) => {
      const rows = document.querySelectorAll("section.project.collapsed");
      for (const s of rows) s.querySelector(".project-head")?.click();
      for (const b of document.querySelectorAll("[data-open-row]")) {
        if (b.getAttribute("aria-expanded") !== "true") b.click();
      }
      for (const t of want) {
        if (keep.includes(t)) continue;
        const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        if (card && card.classList.contains("collapsed")) card.querySelector(".job-head")?.click();
      }
      return want.map((t) => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        return {
          t,
          card: Boolean(card),
          collapsed: card ? card.classList.contains("collapsed") : null,
          outs: card ? card.querySelectorAll("pre.job-out").length : 0,
          thinks: card ? card.querySelectorAll(".think-body").length : 0,
        };
      });
    }, { want: threads, keep: minimise });
  const visible = (list) => list.map((x) => ({ ...x, t: x.t.slice(-6) }));
  let state = [];
  for (let i = 0; i < 24; i++) {
    state = await open();
    const ready = state.every((s) => s.card && (s.collapsed ? true : s.outs > 0));
    if (ready && i > 1) break;
    await sleep(500);
  }
  return visible(state);
}

// ---- record ----------------------------------------------------------------------------------------------------
async function record() {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }
  let threads = (THREADS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!threads.length) {
    if (!existsSync(threadsFile)) throw new Error(`no threads given and no ${threadsFile}`);
    threads = JSON.parse(readFileSync(threadsFile, "utf8")).map((a) => a.thread);
  }
  const minimise = MINIMISE.split(",").map((s) => s.trim()).filter(Boolean);
  mkdirSync(OUT, { recursive: true });
  const browser = await pw.chromium.launch({ headless: true });
  const errors = [];
  let dump = null;
  let layout = null;
  let shape = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await ctx.addInitScript(pageInit, { mode: MODE, threads, minimise, seconds: SECONDS });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
    });
    // The renderer and the fold state are chosen per session in localStorage, and a card is BUILT in that shape — so
    // they are written before the first paint (the init script does this too, for a page opened after it), then the
    // page is reloaded so the scenario's shape is the shape the page is built in rather than toggled into.
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate(({ ts, mn, mode }) => {
      localStorage.setItem("wm.collapsedJobs", JSON.stringify(mn));
      for (const t of ts) {
        localStorage.setItem(`wtgui.think.${t}`, "1");
        localStorage.setItem(`wtgui.stream.${t}`, mode === "combined" ? "1" : "0");
      }
    }, { ts: threads, mn: minimise, mode: MODE });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
    await sleep(1500);
    layout = await prepPage(page, threads, minimise);
    shape = await page.evaluate((ts) => {
      const out = {};
      for (const t of ts) {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        if (!card) continue;
        const pre = card.querySelector("pre.job-out");
        const th = card.querySelector("details.think");
        out[t.slice(-6)] = {
          collapsed: card.classList.contains("collapsed"),
          stream: typeof streamOn === "function" ? streamOn(t) : null,
          think: typeof thinkingOn === "function" ? thinkingOn(t) : null,
          outBox: pre ? { h: pre.clientHeight, sh: pre.scrollHeight, rows: pre.children.length, dataOut: pre.dataset.out } : null,
          thinkBox: th ? { h: th.querySelector(".think-body")?.clientHeight ?? 0, rows: th.querySelectorAll(".think-block").length } : null,
        };
      }
      return out;
    }, threads);
    console.log(`recording ${SCENARIO} (mode ${MODE}) for ${SECONDS}s`);
    console.log(`layout: ${JSON.stringify(layout)}`);
    console.log(`shape : ${JSON.stringify(shape)}`);
    const t0 = Date.now();
    let last = 0;
    while ((Date.now() - t0) / 1000 < SECONDS) {
      await sleep(5000);
      const s = await page.evaluate(() => window.__pop.stats());
      if (s.frames !== last) {
        process.stdout.write(`  +${Math.round((Date.now() - t0) / 1000)}s frames=${s.frames} boxes=${s.boxes.length} writes=${s.writes}\n`);
        last = s.frames;
      }
    }
    dump = await page.evaluate(() => window.__pop.dump());
    await page.screenshot({ path: path.join(OUT, `shot-${SCENARIO}.png`), fullPage: false }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  const summary = summarise(dump);
  const file = path.join(OUT, `scenario-${SCENARIO}.json`);
  const head = await readFileHead();
  writeFileSync(
    file,
    JSON.stringify(
      {
        scenario: SCENARIO,
        mode: MODE,
        seconds: SECONDS,
        base: BASE,
        instance: head,
        at: new Date().toISOString(),
        threads,
        minimise,
        layout,
        shape,
        errors,
        frames: dump.frames,
        hiddenFrames: dump.hiddenFrames,
        pageErrors: dump.errors,
        summary,
        raw: dump,
      },
      null,
      1,
    ),
  );
  printSummary({ scenario: SCENARIO, mode: MODE, seconds: SECONDS, minimise, summary, frames: dump.frames, hiddenFrames: dump.hiddenFrames });
  console.log(`\n→ ${file}`);
}

// The instance this run measured: its version and commit, read from the panel itself so the doc cannot drift.
async function readFileHead() {
  const cfg = await api("/api/build").catch(() => null);
  const st = await api("/api/state").catch(() => null);
  let commit = null;
  try {
    commit = readFileSync(path.join(HERE, "..", "VERSION-COMMIT"), "utf8").trim();
  } catch {
    /* not there; the caller reports the worktree's HEAD separately */
  }
  return { base: BASE, build: cfg, version: st?.version || null, commit };
}

// ---- the arithmetic --------------------------------------------------------------------------------------------
// Definitions, exactly as the brief words them:
//   hop          a frame where scrollTop dropped > 20px, the PREVIOUS frame was pinned (distance <= 8px) and no
//                scrollTop write reached that node in that frame ("nothing scrolled the box"). Split by whether the
//                content also shrank that frame (scrollHeight smaller), which is the one legitimate way a browser
//                moves a scroll box by itself.
//   tail         the longest run of frames at distance <= 8px while output was being appended — a run in which the
//                content changed at least twice (child count or scrollHeight moved). Reported next to the longest
//                pinned run of any kind, because a console that is idle also holds its tail.
//   lag          runs of frames with distance > 8px: how many, how long (ms) and how deep (px), as p50/p90/max.
//   direction    unexplained drops > 20px say "up"; unexplained rises > 20px say "down"; a box with both is "both".
//   painted      the same question asked AFTER the frame's rendering steps (see the paint probe): a hop the reader
//                could see, as opposed to one the panel corrected inside the frame that made it.
const pct = (list, p) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
};
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// One NODE's series. A node is one <pre> (or one .think-body): a card rebuild replaces it, and a replacement is not
// a scroll event, so every measurement here is taken inside one node and the replacement is counted separately.
function nodeMetrics(box, dump) {
  const f = box.frames;
  if (!f.length) return null;
  const k = box.k;
  const span = f[f.length - 1][0] - f[0][0];
  const hops = [];
  const drops = [];
  const rises = [];
  const excursions = [];
  const pinnedRuns = [];
  let run = null;
  let pinStart = -1;
  let pinChanges = 0;
  let best = 0;
  let bestWithAppends = 0;
  for (let i = 0; i < f.length; i++) {
    const [t, st, sh, ch, rows] = f[i];
    const d = sh - st - ch;
    const prev = i ? f[i - 1] : null;
    if (d <= 8) {
      if (pinStart < 0) {
        pinStart = i;
        pinChanges = 0;
      }
      // "output was being appended": the box's content moved — one more child, or a taller document.
      if (i > pinStart && (rows !== f[i - 1][4] || sh !== f[i - 1][2])) pinChanges += 1;
      const ms = t - f[pinStart][0];
      if (ms > best) best = ms;
      if (pinChanges >= 2 && ms > bestWithAppends) bestWithAppends = ms;
    } else if (pinStart >= 0) {
      pinnedRuns.push({ ms: f[i - 1][0] - f[pinStart][0], changes: pinChanges, from: f[pinStart][0] });
      pinStart = -1;
    }
    if (d > 8) {
      if (!run) run = { start: t, max: d };
      else if (d > run.max) run.max = d;
    } else if (run) {
      excursions.push({ ms: t - run.start, depth: run.max, from: run.start });
      run = null;
    }
    if (prev) {
      const [, pst, psh, pch] = prev;
      const pd = psh - pst - pch;
      const delta = st - pst;
      if (delta < -20) drops.push({ t, delta, prevPinned: pd <= 8, wrote: f[i][5] > 0, shrank: sh < psh, d, cw: f[i][6], pcw: prev[6] });
      if (delta > 20) rises.push({ t, delta, prevPinned: pd <= 8, wrote: f[i][5] > 0, grew: sh > psh, d });
    }
  }
  if (pinStart >= 0) pinnedRuns.push({ ms: f[f.length - 1][0] - f[pinStart][0], changes: pinChanges, from: f[pinStart][0] });
  if (run) excursions.push({ ms: f[f.length - 1][0] - run.start, depth: run.max, from: run.start });
  for (const x of drops) if (x.prevPinned && !x.wrote) hops.push(x);
  const unexpRises = rises.filter((x) => !x.wrote && !x.prevPinned);
  const boxWrites = (dump.writes || []).filter((w) => w.k === k);
  const stacks = new Map();
  for (const w of boxWrites) stacks.set(w.stack || "?", (stacks.get(w.stack || "?") || 0) + 1);
  const boxMuts = (dump.muts || []).filter((m) => m.k === k);
  const hopDetail = hops.slice(0, 10).map((h) => {
    const near = boxWrites.filter((w) => w.t >= h.t - 40 && w.t <= h.t + 120);
    const after = near.find((w) => w.t >= h.t);
    const frameMuts = boxMuts.filter((m) => m.t >= h.t - 34 && m.t <= h.t + 1).slice(0, 6);
    const shrinks = (dump.resizes || [])
      .filter((r) => r.k === k && r.t >= h.t - 40 && r.t <= h.t + 2 && r.to < r.from)
      .slice(0, 4)
      .map((r) => `${String(r.lid || "?").slice(0, 24)} ${r.to - r.from}px @${Math.round(r.t)}`);
    return {
      t: Math.round(h.t),
      drop: Math.round(h.delta),
      shrank: h.shrank,
      rewrap: h.cw != null && h.pcw != null && h.cw !== h.pcw ? `${h.pcw}->${h.cw}px` : null,
      restoreInMs: after ? Math.round((after.t - h.t) * 10) / 10 : null,
      restoreTo: after ? after.to : null,
      restoreStack: after ? after.stack : null,
      writesNear: near.length,
      muts: frameMuts.map((m) => `${m.type}${m.grp ? "/grp" : ""} lid=${m.lid || "-"} kind=${String(m.lkind || "-").slice(0, 28)} +${m.added}-${m.removed}`),
      shrinks,
    };
  });
  const post = (dump.post || []).filter((x) => x[1] === k);
  const off = post.filter((x) => x[2] > 8);
  return {
    node: k,
    frames: f.length,
    seconds: r1(span / 1000),
    fps: r1((f.length / Math.max(1, span)) * 1000),
    writes: boxWrites.length,
    rowChanges: f.reduce((n, x, i) => (i && (x[4] !== f[i - 1][4] || x[2] !== f[i - 1][2]) ? n + 1 : n), 0),
    hops,
    hopDetail,
    dropsTotal: drops.length,
    dropsWrote: drops.filter((x) => x.wrote).length,
    dropsShrank: drops.filter((x) => !x.wrote && x.shrank).length,
    risesTotal: rises.length,
    unexpRises,
    longestTailMs: Math.round(best),
    longestTailWithAppendsMs: Math.round(bestWithAppends),
    pinnedFrames: f.filter((x) => x[2] - x[1] - x[3] <= 8).length,
    excursions,
    direction: hops.length && unexpRises.length ? "both" : hops.length ? "up-only" : unexpRises.length ? "down-only" : "none",
    painted: { samples: post.length, paintedOffTail: off.length, paintedDepthMax: off.length ? Math.max(...off.map((x) => Math.round(x[2]))) : 0 },
    writeStacks: [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([stack, n]) => ({ n, stack })),
  };
}


// The tail question is about the BOX THE READER SEES, and a rebuild replaces the node without the console going away
// (a rebuild every ~13 s means no node ever lives 60 s). So the pinned runs are computed a second time over the union
// of the nodes' frames, time-ordered: a node change is a replacement, not a gap, and the pin is carried across it.
function mergedTail(framesList) {
  const all = framesList.flat().slice().sort((a, b) => a[0] - b[0]);
  let pinStart = -1;
  let pinChanges = 0;
  let best = 0;
  let bestWithAppends = 0;
  let prev = null;
  for (const f of all) {
    const [, st, sh, ch, rows] = f;
    const d = sh - st - ch;
    if (d <= 8) {
      if (pinStart < 0) {
        pinStart = f[0];
        pinChanges = 0;
      }
      if (prev && (rows !== prev[4] || sh !== prev[2])) pinChanges += 1;
      const ms = f[0] - pinStart;
      if (ms > best) best = ms;
      if (pinChanges >= 2 && ms > bestWithAppends) bestWithAppends = ms;
    } else {
      pinStart = -1;
    }
    prev = f;
  }
  return { tail: Math.round(best), tailWithAppends: Math.round(bestWithAppends) };
}

function summarise(dump) {
  // A board can draw two copies of one conversation for a frame; each copy is its own node and its own series. The
  // reported box is the union of its nodes (a rebuild replaces the node, not the console), and the node count is
  // reported: four nodes in 80s means the card was replaced three times.
  const groups = new Map();
  for (const b of dump.boxes) {
    const base = String(b.k).split("#")[0];
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(b);
  }
  const out = [];
  for (const [base, list] of groups) {
    const metrics = list.map((b) => nodeMetrics(b, dump)).filter(Boolean).sort((a, b) => b.frames - a.frames);
    if (!metrics.length) continue;
    const primary = metrics[0];
    // the union of this box's nodes, in time order — the console as the reader watched it, across rebuilds
    const framesOf = list.map((b) => b.frames);
    const merged = mergedTail(framesOf);
    const pooled = metrics.flatMap((m) => m.excursions);
    const lagMs = pooled.map((e) => Math.round(e.ms));
    const lagDepth = pooled.map((e) => Math.round(e.depth));
    const directions = new Set(metrics.map((m) => m.direction));
    const dir = directions.has("both") || (directions.has("up-only") && directions.has("down-only"))
      ? "both"
      : directions.has("up-only")
        ? "up-only"
        : directions.has("down-only")
          ? "down-only"
          : "none";
    out.push({
      box: base,
      kind: base.startsWith("out:") ? "output" : "reasoning",
      nodes: metrics.length,
      nodeFrames: metrics.map((m) => m.frames),
      frames: metrics.reduce((n, m) => n + m.frames, 0),
      seconds: r1(metrics.reduce((n, m) => n + m.seconds, 0)),
      fps: primary.fps,
      writes: metrics.reduce((n, m) => n + m.writes, 0),
      rowChanges: metrics.reduce((n, m) => n + m.rowChanges, 0),
      hops: metrics.reduce((n, m) => n + m.hops.length, 0),
      hopTimes: primary.hops.slice(0, 40).map((h) => ({ t: Math.round(h.t), drop: Math.round(h.delta) })),
      hopDetail: primary.hopDetail,
      dropsTotal: metrics.reduce((n, m) => n + m.dropsTotal, 0),
      dropsWrote: metrics.reduce((n, m) => n + m.dropsWrote, 0),
      dropsShrank: metrics.reduce((n, m) => n + m.dropsShrank, 0),
      risesTotal: metrics.reduce((n, m) => n + m.risesTotal, 0),
      unexpRises: metrics.reduce((n, m) => n + m.unexpRises.length, 0),
      longestTailMs: merged.tail,
      longestTailWithAppendsMs: merged.tailWithAppends,
      longestTailSingleNodeMs: Math.max(...metrics.map((m) => m.longestTailMs)),
      pinnedPct: Math.round((metrics.reduce((n, m) => n + m.pinnedFrames, 0) / Math.max(1, metrics.reduce((n, m) => n + m.frames, 0))) * 1000) / 10,
      lag: {
        count: pooled.length,
        p50: pct(lagMs, 50),
        p90: pct(lagMs, 90),
        max: lagMs.length ? Math.max(...lagMs) : 0,
        depthP50: pct(lagDepth, 50),
        depthP90: pct(lagDepth, 90),
        depthMax: lagDepth.length ? Math.max(...lagDepth) : 0,
        worst: pooled.slice().sort((a, b) => b.ms - a.ms).slice(0, 5).map((e) => ({ ms: Math.round(e.ms), depth: Math.round(e.depth), at: Math.round(e.from) })),
      },
      direction: dir,
      // What the frames actually PAINTED, from the after-rendering-steps probe. `hops` says the box left its tail
      // inside a frame; `paintedOffTail` says the reader could see it.
      painted: {
        samples: metrics.reduce((n, m) => n + m.painted.samples, 0),
        paintedOffTail: metrics.reduce((n, m) => n + m.painted.paintedOffTail, 0),
        paintedDepthMax: Math.max(...metrics.map((m) => m.painted.paintedDepthMax)),
      },
      writeStacks: primary.writeStacks,
      perNode: metrics.map((m) => ({ node: m.node, frames: m.frames, hops: m.hops.length, tail: m.longestTailMs, painted: m.painted.paintedOffTail })),
    });
  }
  return out;
}

function printSummary(run) {
  const line = (s) => console.log(s);
  line(`\n${run.scenario}  mode=${run.mode}  minimised=[${run.minimise.join(",")}]  ${run.seconds}s  frames=${run.frames} (hidden ${run.hiddenFrames})`);
  for (const s of run.summary) {
    line(
      `  ${s.box.padEnd(34)} hops ${String(s.hops).padStart(2)}  tail ${String(Math.round(s.longestTailMs / 1000)).padStart(3)}s` +
        ` (with appends ${String(Math.round(s.longestTailWithAppendsMs / 1000)).padStart(3)}s)` +
        `  lag ${String(s.lag.count).padStart(2)}× p50 ${String(s.lag.p50 ?? 0).padStart(4)}ms p90 ${String(s.lag.p90 ?? 0).padStart(4)}ms max ${String(s.lag.max).padStart(5)}ms` +
        `  ${s.direction}  painted-off-tail ${s.painted ? s.painted.paintedOffTail : "n/a"}  nodes ${s.nodes}  fps ${s.fps}`,
    );
  }
}

// ---- report ----------------------------------------------------------------------------------------------------
function report() {
  if (!existsSync(OUT)) throw new Error(`nothing recorded yet: no ${OUT}`);
  const files = readdirSync(OUT).filter((f) => /^scenario-.*\.json$/.test(f)).sort();
  if (!files.length) throw new Error(`no scenario-*.json in ${OUT}`);
  const runs = files.map((f) => JSON.parse(readFileSync(path.join(OUT, f), "utf8")));
  console.log("| condition | box | frames | hops | longest tail | tail while appending | lag count | lag p50 | lag p90 | lag max | direction |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    for (const s of r.summary) {
      console.log(
        `| ${r.scenario} | ${s.box} | ${s.frames} | ${s.hops} | ${Math.round(s.longestTailMs / 1000)}s | ${Math.round(s.longestTailWithAppendsMs / 1000)}s | ${s.lag.count} | ${s.lag.p50 ?? 0}ms | ${s.lag.p90 ?? 0}ms | ${s.lag.max}ms | ${s.direction} |`,
      );
    }
  }
  const out = path.join(OUT, "report.json");
  writeFileSync(out, JSON.stringify(runs.map((r) => ({ scenario: r.scenario, mode: r.mode, seconds: r.seconds, instance: r.instance, summary: r.summary, errors: r.errors })), null, 1));
  console.log(`\n→ ${out}`);
}

// Re-derive every stored scenario from its RAW frames. The frames are the evidence; the arithmetic is the part that
// gets fixed, so a corrected definition must be re-appliable without re-running the agents.
function resummarise() {
  const files = readdirSync(OUT).filter((f) => /^scenario-.*\.json$/.test(f));
  let n = 0;
  for (const f of files) {
    const file = path.join(OUT, f);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    if (!doc.raw) continue;
    doc.summary = summarise(doc.raw);
    writeFileSync(file, JSON.stringify(doc, null, 1));
    n += 1;
    console.log(`resummarised ${f}`);
  }
  console.log(`${n} scenario file(s) re-derived from their own frames`);
}

if (cmd === "spawn") await spawn();
else if (cmd === "kill") await killRuns();
else if (cmd === "record") await record();
else if (cmd === "report") report();
else if (cmd === "resummarise") resummarise();
else {
  console.log("usage: node tools/pop-a.mjs spawn|record|report|kill [--base http://127.0.0.1:7332] [--out <dir>]");
  process.exit(2);
}
