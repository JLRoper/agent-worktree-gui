// Does a card still jitter while a turn streams? Four numbers, one verdict.
//
//   node tools/verify-console-jitter.mjs                  # both card modes, headed Chromium (~60 s)
//   node tools/verify-console-jitter.mjs --mode stream    # 🌊 one-stream console only
//   node tools/verify-console-jitter.mjs --mode think     # 🧠 block above a condensed console only
//   node tools/verify-console-jitter.mjs --headless       # no window (rAF is throttled; the counts still run)
//   node tools/verify-console-jitter.mjs --resync-check   # +34 s of flow, to catch the panel's 30 s rebuild
//   node tools/verify-console-jitter.mjs --json <path>    # keep the raw capture beside the printed table
//   node tools/verify-console-jitter.mjs --keep           # leave the sandbox behind for inspection
//   node tools/verify-console-jitter.mjs --late-stick 60  # self-test: the page sticks 60 ms late, the painted gap must FAIL
//
// WHAT THIS ANSWERS
//   docs/jitter-synthesis.md reconciles three investigations: the code-level map (`jitter-sources.md`), the seconds
//   while tokens flow (`jitter-streaming.md`) and the seconds at rest (`jitter-static.md`). This tool is the single
//   repeatable test that decides the question those three describe: is the jitter present or gone?
//
//   It measures exactly four things, on a stream it owns end to end:
//     1. row churn per second — console rows REPLACED (a row came back as a new node) vs REWRITTEN in place (the
//        pacer's next prefix, the live append). Only the first is a row the reader lost; the second is a text node
//        the reader's selection lost inside a row that survived.
//     2. surviving rows across a repaint — every row the repaint is about to draw is stamped, and the tags still in
//        the box are counted when it returns (`kept == stamped` is a patch; anything less is a replacement).
//        Plus a once-a-second identity walk, which is the same question asked by an observer instead of a wrapper.
//     3. scrollTop movement with no input — every frame, both scroll boxes: direction, whether the growth explains
//        it, whether the panel's own `setScroll` asked for it, and how far the box ever sat from its bottom.
//        That last one is read where the frame PAINTS it (a ResizeObserver delivery, after the page's own
//        same-frame stick); the start-of-frame read is printed beside it as `gap rAF` and judges nothing.
//     4. thinking-block replacement rate — how many `details.think` nodes `paintThink` throws away per second, and
//        how many of its blocks survive each poll.
//
// WHAT IT DRIVES (nothing synthetic reaches the page)
//   * a sandbox panel of its own from tools/panel-testkit.mjs `startPanel()` — spare port, own PANEL_CONFIG,
//     jobs/projects cache, HERMES_HOME, assistant off, API_SERVER_KEY empty. The reading panel on 7331 is never
//     touched and no other process is restarted.
//   * a stub Runs API that plays a FIXED reply over real SSE: two words every 75 ms, a paragraph break every 55
//     words, then a hole with no event at all, then more words. The panel's own lib/jobs.js coalesces them at
//     120 ms into one growing line, exactly as it does for a real gateway.
//   * a `<sandbox>/hermes/state.db` that grows a `messages.reasoning_content` row every 2 s while the wire flows and
//     not at all while it is paused — the store `/api/thinking` reads, in the shape lib/thinking.js expects.
//   * the page's own clocks, untouched: the pacer, the 1.2 s thinking sweep, the 1200/2000 ms freshness gate, the
//     400 ms stick, `syncStreamConsole`, `paintThink`, `drawJobLine` and `setScroll`.
//
// EXIT CODES
//   0  every threshold below held (or Playwright is not installed: SKIP, like the other measurement tools)
//   1  a jitter threshold was crossed — the numbers printed are the evidence
//   2  the run did not drive what it measures (no polls, no churn, a page error) or it was asked to do the 30 s
//      check and the board rebuilt the streaming card. A pass on a run that measured nothing is worse than a failure.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const MODE = opt("--mode", "both");
const HEADLESS = argv.includes("--headless");
const KEEP = argv.includes("--keep");
const RESYNC_CHECK = argv.includes("--resync-check");
// A self-test of the painted-gap read, not a mode a landing runs: the page's own stickSoon fires this many ms late, so
// a console that grows is left off its bottom for a few painted frames, and the painted read must catch it.
const LATE_STICK_MS = Number(opt("--late-stick", "0")) || 0;
const JSON_OUT = opt("--json");
if (!["stream", "think", "both"].includes(MODE)) {
  console.log(`--mode must be stream, think or both, not ${MODE}`);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(n * 10) / 10;

// The windows. A card is drawn from a fixed script, so the same seconds are measured on every run. The flowing
// window is deliberately shorter than the panel's 30 s safety net (public/app.js:14843 → resync) so a scheduled
// rebuild cannot pollute a per-second floor; --resync-check is the mode that goes looking for it on purpose.
const W = { flow1: RESYNC_CHECK ? 34000 : 14000, pause: RESYNC_CHECK ? 4000 : 7000, flow2: RESYNC_CHECK ? 4000 : 3000 };
const REASONING_EVERY = 2000;
// The pacer types one word at ~40 words/s (25 ms each, floor 40 ms a frame). The last reasoning row written before
// the pause must be finished before the paused window starts, or the control measures the flow it excludes.
const REASONING_LEAD = 3000;
const THREAD = "probe-console-jitter";

// ---- the fixed stream ---------------------------------------------------------------------------------------------
// Deterministic on purpose: the same words, the same frames, the same paragraph breaks on every run, so two runs of
// this tool are comparable without a capture diff.
const WORDS = `the console grows a line at a time while the turn is still running
a row that keeps its node keeps the selection inside it
the pacer releases words on its own clock and rewrites the row in place
the poll reads the store and redraws whatever grew since the last read
a repaint that patches the row extends the words and moves nothing else
a repaint that replaces the row keeps the words and loses the nodes
the reasoning block is replaced whole on every poll of the store
the console is a fixed height box and its content is longer than the box
keeping the newest line in view means scrolling to the bottom after every growth
a reader who has scrolled up is a reader the panel must not touch
the sweep runs on its own clock whether or not the wire is moving
the frame clock says whether any of it costs a frame`.split(/\s+/).filter(Boolean);

function replySteps(from, until, seed) {
  const steps = [];
  let t = from;
  let i = seed;
  let para = 0;
  while (t < until) {
    const chunk = [WORDS[i % WORDS.length], WORDS[(i + 1) % WORDS.length]];
    i += 2;
    para += 2;
    const lead = para >= 55 ? "\n\n" : i === seed + 2 ? "" : " ";
    if (lead === "\n\n") para = 0;
    steps.push({ at: t, evt: { event: "message.delta", delta: `${lead}${chunk.join(" ")} ` } });
    t += 75;
  }
  return { steps, next: i };
}
function buildScript() {
  const a = replySteps(300, W.flow1, 0);
  const b = replySteps(W.flow1 + W.pause, W.flow1 + W.pause + W.flow2, a.next);
  const steps = [...a.steps, ...b.steps];
  // The paragraph the pause interrupted continues: the pause is a stalled model, not a new line.
  steps.push({ at: W.flow1 + W.pause + W.flow2 + 250, evt: { event: "run.completed", output: "done", usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } } });
  return steps;
}

// ---- the reasoning store ------------------------------------------------------------------------------------------
// `messages.reasoning_content`, one row per assistant message, the column lib/thinking.js reads. Every row gets its
// own `think:<timestamp>` lid, which is the shape a real store has.
const REASONING = [
  "The reader is watching a live card, so the pane to measure is the one that is redrawn rather than appended to. The prose comes through the run stream and the reasoning comes from the store, and the two are drawn by two different paths on the same card.",
  "A repaint that patches a row keeps the text node under the reader's selection. One that replaces the row does not. The difference is invisible in a screenshot taken afterwards and obvious in a selection that collapses while it is being held.",
  "I want the console's distance from its bottom as well as its scrollTop, because a box that grows under a reader who is at the bottom moves its content without moving scrollTop at all. The snap back is the panel's stick, and the size of the snap is the jitter.",
  "The pacer releases words on its own clock, about twenty-five times a second at the default rate, and every release rewrites the row's contents in place. The reader does not see a jump, but every text node under a selection in that row is gone.",
  "If the poll redraws a reasoning block by replacing its node, then the sentence being selected is rebuilt under the cursor every time the store is read. That is the streaming form of the collapse the block used to have.",
  "The paused window is the control. The poll keeps running on its own timer against a store that is not growing, so anything that still changes in those seconds belongs to the panel rather than to the arrival of words.",
  "A long task is the only measure that can say the reader lost a frame. Everything else is bookkeeping about nodes; a long task is a frame that did not happen while the turn was running.",
  "The console's own scroll is the panel's, not the reader's. It only becomes a fault when it moves upward, or when it lands a frame away from the bottom it was pinned to.",
];

function seedStore(dir, thread) {
  mkdirSync(path.join(dir, "hermes"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
  db.exec(`
    create table if not exists sessions (id text primary key, source text not null, started_at real not null,
      model text, cwd text, title text, message_count integer default 0);
    create table if not exists messages (id integer primary key autoincrement, session_id text not null, role text not null,
      content text, timestamp real not null, reasoning text, reasoning_content text, tool_name text, tool_call_id text,
      token_count integer, finish_reason text);
  `);
  db.prepare("insert or replace into sessions (id, source, started_at, model, cwd, title) values (?,?,?,?,?,?)").run(thread, "probe", Date.now() / 1000, "probe/model", ROOT, "console jitter probe");
  db.close();
}

function makeReasoningWriter(dir, thread) {
  const st = { on: false, timer: null, n: 0 };
  const write = () => {
    if (!st.on) return;
    const text = `${REASONING[st.n % REASONING.length]} (${st.n + 1})`;
    st.n += 1;
    try {
      const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
      db.prepare("insert into messages (session_id, role, content, timestamp, reasoning_content) values (?,?,?,?,?)").run(thread, "assistant", "…", Date.now() / 1000, text);
      db.close();
    } catch {
      /* a locked store is a read the caller retries on its next poll */
    }
    st.timer = setTimeout(write, REASONING_EVERY);
  };
  return {
    start() {
      if (st.on) return;
      st.on = true;
      write();
    },
    stop() {
      st.on = false;
      clearTimeout(st.timer);
    },
    count: () => st.n,
  };
}

// ---- the stub Runs API --------------------------------------------------------------------------------------------
function makeGateway(script, phases) {
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
      return json(200, { version: "jitter-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_jitter_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "", startedAt: null, script });
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
      const from = Number(req.headers["last-event-id"] ?? url.searchParams.get("last_seq") ?? -1) + 1;
      let open = true;
      req.on("close", () => {
        open = false;
      });
      rec.script.forEach((step, i) => {
        if (i < from) return;
        later(rec.startedAt + step.at - Date.now(), () => {
          if (!open) return;
          res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
          if (step.evt.event === "run.completed") {
            rec.status = "completed";
            rec.output = step.evt.output;
            later(50, () => res.end());
          }
        });
      });
      // The windows are cut on the stub's clock, so "paused" means the wire really went quiet. The paused window
      // starts PAUSE_SETTLE ms after the hole opens: the last line the wire sent is still being typed, and a control
      // window that starts inside that tail measures the flow it was meant to exclude.
      later(Math.max(0, W.flow1 - REASONING_LEAD), () => phases.quiesce());
      later(W.flow1, () => phases.pause());
      later(W.flow1 + 1500, () => phases.pauseSettled());
      later(W.flow1 + W.pause, () => phases.resume());
      later(W.flow1 + W.pause + W.flow2 + 300, () => phases.done());
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
// Before app.js. Storage only: which renderer this run measures (thinking on in both; the one-stream console only
// for the stream pass), and the reader's own type speeds left at their defaults.
function pageInit({ thread, mode, lateStickMs = 0 }) {
  if (lateStickMs > 0) {
    // --late-stick: app.js is a classic script, so its stickSoon is a global the page calls by name; wrap it once the
    // document has parsed.
    document.addEventListener("DOMContentLoaded", () => {
      const onTime = window.stickSoon;
      if (typeof onTime === "function") window.stickSoon = (el) => setTimeout(() => onTime(el), lateStickMs);
    });
  }
  try {
    localStorage.setItem("wtgui.autoCollect", "0");
    localStorage.setItem("wtgui.think", "1");
    localStorage.setItem(`wtgui.think.${thread}`, "1");
    if (mode === "stream") localStorage.setItem(`wtgui.stream.${thread}`, "1");
  } catch {
    /* storage may be unavailable */
  }

  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const R = { buckets: [], marks: [], polls: [], boards: [], scrolls: [], sel: [], frames: [], longtasks: [], errors: [] };
  const B = new Map();
  const P = { seq: 0, lastSnap: new Map(), lastSec: -1 };
  const cardSel = `.job[data-thread="${thread}"]`;
  const consoleFor = (id) => document.querySelector(id ? `pre.job-out[data-out="${CSS.escape(String(id))}"]` : `${cardSel} pre.job-out`);
  const bucket = (t) => {
    const s = Math.floor((t == null ? now() : t) / 1000);
    let b = B.get(s);
    if (!b) {
      b = {
        s, mut: 0, mutConsole: 0, inPlaceProse: 0, inPlaceThink: 0, inPlaceBlock: 0, repProse: 0, repThink: 0, repBlock: 0,
        remProse: 0, remThink: 0, remTool: 0, addRows: 0, bigReplace: 0,
        conPolls: 0, rowsStamped: 0, rowsKept: 0, rowsReplacedPoll: 0,
        thinkPolls: 0, blockStamped: 0, blockKept: 0, detailsReplaced: 0,
        appends: 0, liveNew: 0, liveInPlace: 0, pacerPaints: 0,
        scrollChanges: 0, scrollUp: 0, scrollFollow: 0, scrollOther: 0, setScrollWrites: 0, gapMax: 0, gapSamples: 0,
        gapPainted: 0, gapPaintedSamples: 0,
        board: 0, card: 0, snap: 0, staleSec: 0, conRows: 0, conTop: 0, conScrollH: 0, conClientH: 0,
        frames: 0, longtasks: 0, longtaskMs: 0, idKeptCon: 0, idSwappedCon: 0, idKeptBlock: 0, idSwappedBlock: 0, idAdded: 0,
        input: 0, selLosses: 0,
      };
      B.set(s, b);
    }
    return b;
  };
  const kindOf = (lid) => (String(lid || "").startsWith("think:") ? "think" : "prose");
  const rowKind = (n) => {
    const lid = n?.dataset?.lid;
    if (lid) return kindOf(lid);
    if (n?.dataset?.tgrp) return "tool";
    return "prose";
  };

  window.__rec = R;
  window.__probe = {
    now,
    mark(name) {
      R.marks.push({ name, t: now() });
      return now();
    },
    dump() {
      return { ...R, rows: [...document.querySelectorAll(`${cardSel} pre.job-out > *`)].map((n) => ({ lid: n.dataset.lid || "", tgrp: n.dataset.tgrp || "", chars: n.textContent.length, h: Math.round(n.getBoundingClientRect().height) })), buckets: [...B.values()].sort((a, b) => a.s - b.s) };
    },
  };
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  // No input of any kind is sent, so a scroll the page did not ask for has no alibi. Counted rather than assumed.
  for (const ev of ["wheel", "keydown", "pointerdown", "mousedown", "touchstart"]) {
    window.addEventListener(ev, () => (bucket().input += 1), true);
  }

  // -- rows: added, removed, and swapped for a new node with the same lid.
  // A row's pane is read off the row itself, not off the record's target: a card rebuild (or `paintThink`'s
  // `el.replaceWith`) detaches the whole subtree, and the rows inside it still know which console or block they
  // belonged to while the target is the card or the turn.
  const paneOf = (n) => (n.closest?.("details.think") ? "block" : n.closest?.("pre.job-out") ? "console" : "");
  const obs = new MutationObserver((list) => {
    const t = now();
    const b = bucket(t);
    for (const m of list) {
      b.mut += 1;
      if (m.type === "attributes") continue;
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (target?.closest?.("pre.job-out")) b.mutConsole += 1;
      if (m.type !== "childList") {
        const row = target?.closest?.("pre.job-out [data-lid]");
        if (row && row.isConnected) {
          if (kindOf(row.dataset.lid) === "think") b.inPlaceThink += 1;
          else b.inPlaceProse += 1;
        }
        if (target?.closest?.(".think-body [data-lid]")) b.inPlaceBlock += 1;
        continue;
      }
      // A node that is still connected was MOVED, not thrown away: the board re-places a card in its slot and every
      // row under it comes out of one parent and into another. Only a disconnected row left the page.
      const rowsIn = (nodes) =>
        [...nodes]
          .filter((n) => n.nodeType === 1)
          .flatMap((n) => [n, ...n.querySelectorAll("[data-lid]")])
          .filter((n) => n.dataset && n.dataset.lid !== undefined);
      const added = rowsIn(m.addedNodes).filter((n) => n.isConnected);
      const removed = rowsIn(m.removedNodes).filter((n) => !n.isConnected);
      b.addRows += added.length;
      b.remProse += removed.filter((n) => rowKind(n) === "prose").length;
      b.remThink += removed.filter((n) => rowKind(n) === "think").length;
      b.remTool += removed.filter((n) => rowKind(n) === "tool").length;
      // A batch that takes many rows out at once is a whole-pane repaint, not a row edit. Its time is kept so a
      // floor can exclude the second it landed in.
      if (removed.length >= 5) b.bigReplace = Math.max(b.bigReplace, removed.length);
      for (const oldNode of removed) {
        const lid = oldNode.dataset.lid;
        if (!lid) continue;
        if (!added.some((n) => n.dataset.lid === lid)) continue;
        const pane = paneOf(oldNode);
        if (pane === "block") b.repBlock += 1;
        else if (kindOf(lid) === "think") b.repThink += 1;
        else b.repProse += 1;
      }
      const row = target?.closest?.("pre.job-out [data-lid]");
      if (row && row.isConnected && !removed.includes(row)) {
        if (kindOf(row.dataset.lid) === "think") b.inPlaceThink += 1;
        else b.inPlaceProse += 1;
      }
      if (target?.closest?.(".think-body [data-lid]")) b.inPlaceBlock += 1;
    }
  });
  // addInitScript runs before <body> exists, and observing null throws — taking the rest of this script with it.
  const attach = () => {
    const root = document.body || document.documentElement;
    if (!root) return false;
    obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    return true;
  };
  if (!attach()) document.addEventListener("DOMContentLoaded", attach, { once: true });

  // -- scroll: sampled per frame (what a frame can paint) and attributed to the page's own setScroll.
  const lastScroll = new Map();
  const lastSet = new Map();
  const sampleScroll = (key, el) => {
    if (!el || !el.isConnected) return;
    const top = Math.round(el.scrollTop);
    const max = Math.round(el.scrollHeight - el.clientHeight);
    const prev = lastScroll.get(key);
    const b = bucket();
    if (max > 0) {
      b.gapSamples += 1;
      b.gapMax = Math.max(b.gapMax, Math.max(0, max - top));
    }
    if (prev && prev.top !== top) {
      const d = top - prev.top;
      const dm = max - prev.max;
      b.scrollChanges += 1;
      const viaSet = (lastSet.get(key) || -1e9) > now() - 200;
      if (d < -2 && !viaSet) b.scrollUp += 1;
      else if (d > 0 && Math.abs(d - dm) <= 2) b.scrollFollow += 1;
      else b.scrollOther += 1;
      R.scrolls.push({ t: now(), key, from: prev.top, to: top, d, dm, maxBefore: prev.max, maxAfter: max, viaSet: viaSet ? 1 : 0 });
    }
    lastScroll.set(key, { top, max });
  };

  // -- selection: the row the reader is standing in, and how long it survives. Three targets, because the answer is
  // not the same for a row being written, a reasoning row, and a row nothing repaints.
  const selState = { text: "", kind: "", at: 0 };
  const pick = (which) => {
    const ok = (n) => n.isConnected && n.textContent.trim().length > 40;
    if (which === "reasoning") {
      const pool = [...document.querySelectorAll(`${cardSel} .think-block:not(.think-empty), ${cardSel} pre.job-out [data-lid^="think:"]`)].filter(ok);
      return pool[pool.length - 1];
    }
    const pool = [...document.querySelectorAll(`${cardSel} pre.job-out .jl-text`)].filter(ok);
    return which === "settled" ? pool[0] : pool[pool.length - 1];
  };
  const ORDER = ["growing", "reasoning", "settled"];
  let armNext = 0;
  let lastArm = 0;
  const MAX_HOLD = 4000;
  const arm = () => {
    const kind = ORDER[armNext % ORDER.length];
    const row = pick(kind);
    if (!row) return false;
    armNext += 1;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node || !node.nodeValue) return false;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(24, node.nodeValue.length));
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    selState.text = String(s.toString());
    selState.kind = kind;
    selState.at = now();
    R.sel.push({ t: selState.at, event: "arm", kind });
    return true;
  };
  // Every frame, not every second: a selection that lives 40 ms and one that lives 1 s are different faults, and a
  // once-a-second check reports the same number for both.
  const checkSel = () => {
    if (!selState.text) return;
    const s = window.getSelection();
    const txt = s && s.rangeCount ? String(s.toString()) : "";
    const gone = !txt || txt !== selState.text || !s.anchorNode || !s.anchorNode.isConnected;
    if (!gone) {
      if (now() - selState.at >= MAX_HOLD) {
        R.sel.push({ t: now(), event: "survived", kind: selState.kind, held: MAX_HOLD });
        selState.text = "";
      }
      return;
    }
    bucket().selLosses += 1;
    R.sel.push({ t: now(), event: "lost", kind: selState.kind, held: Math.round((now() - selState.at) * 10) / 10 });
    selState.text = "";
  };

  // -- the once-a-second identity walk: same lid, same node?
  const snap = () => {
    const m = new Map();
    for (const el of document.querySelectorAll(`${cardSel} pre.job-out [data-lid], ${cardSel} .think-body [data-lid]`)) {
      const lid = el.dataset.lid;
      if (lid) m.set(lid, el);
    }
    let keptCon = 0;
    let swappedCon = 0;
    let keptBlock = 0;
    let swappedBlock = 0;
    let added = 0;
    for (const [lid, el] of m) {
      const inCon = Boolean(el.closest("pre.job-out"));
      const prev = P.lastSnap.get(lid);
      if (!prev) added += 1;
      else if (prev === el) inCon ? (keptCon += 1) : (keptBlock += 1);
      else inCon ? (swappedCon += 1) : (swappedBlock += 1);
    }
    P.lastSnap = m;
    const b = bucket();
    b.idKeptCon = keptCon;
    b.idSwappedCon = swappedCon;
    b.idKeptBlock = keptBlock;
    b.idSwappedBlock = swappedBlock;
    b.idAdded = added;
    b.conRows = document.querySelectorAll(`${cardSel} pre.job-out [data-lid]`).length;
  };

  // -- the gap a frame PAINTS. frameFn runs at the start of a frame: before layout, and before the page's own
  // requestAnimationFrame callbacks (stickSoon queues one after every growth, and it was queued after frameFn's). So
  // frameFn's gap is the box before the page has followed it in that same frame. A ResizeObserver delivery comes
  // after every rAF callback and after layout, just before paint. A 1 px probe whose width frameFn flips every frame
  // makes one arrive every frame, and its reading is the one that reaches the screen.
  const paintedGap = (el) => {
    if (!el || !el.isConnected) return;
    const max = Math.round(el.scrollHeight - el.clientHeight);
    if (max <= 0) return;
    const gap = Math.max(0, max - Math.round(el.scrollTop));
    const b = bucket();
    b.gapPaintedSamples += 1;
    b.gapPainted = Math.max(b.gapPainted, gap);
    if (gap > 4) (R.painted ||= []).push({ t: now(), gap, top: Math.round(el.scrollTop), max });
  };
  const paintProbe = document.createElement("div");
  paintProbe.style.cssText = "position:fixed;left:-20px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
  let probeFlip = false;
  const probeRO = new ResizeObserver(() => {
    const job = typeof state !== "undefined" && state.jobs ? [...state.jobs.values()].find((j) => j.thread === thread) : null;
    if (!job) return;
    paintedGap(consoleFor(job.id));
    paintedGap(document.querySelector(`${cardSel} details.think .think-body`));
  });
  const attachProbe = () => {
    if (!document.body) return false;
    document.body.appendChild(paintProbe);
    probeRO.observe(paintProbe);
    return true;
  };
  if (!attachProbe()) document.addEventListener("DOMContentLoaded", attachProbe, { once: true });

  let lastFrame = performance.now();
  const frameFn = () => {
    probeFlip = !probeFlip;
    paintProbe.style.width = probeFlip ? "2px" : "1px";
    const t = performance.now();
    const dt = t - lastFrame;
    lastFrame = t;
    if (dt > 0 && dt < 4000) {
      R.frames.push([now(), Math.round(dt * 10) / 10]);
      bucket().frames += 1;
    }
    checkSel();
    if (!selState.text && now() - lastArm > 700) {
      if (arm()) lastArm = now();
    }
    const s = Math.floor(now() / 1000);
    if (s !== P.lastSec) {
      if (P.lastSec >= 0) snap();
      P.lastSec = s;
    }
    const job = typeof state !== "undefined" && state.jobs ? [...state.jobs.values()].find((j) => j.thread === thread) : null;
    if (job) {
      const con = consoleFor(job.id);
      sampleScroll("console", con);
      if (con) {
        const b = bucket();
        b.conTop = Math.round(con.scrollTop);
        b.conScrollH = con.scrollHeight;
        b.conClientH = con.clientHeight;
      }
      sampleScroll("think", document.querySelector(`${cardSel} details.think .think-body`));
      const b = bucket();
      // The page's own liveness clock: jobline frames do not stamp it (public/core/sse.js:129), so on a turn that is
      // only streaming the panel's 30 s safety net reads "quiet" and resyncs.
      b.staleSec = Math.round((Date.now() - (state.lastEventAt || 0)) / 1000);
    }
    requestAnimationFrame(frameFn);
  };
  requestAnimationFrame(frameFn);

  try {
    new PerformanceObserver((list) => {
      const b = bucket();
      for (const e of list.getEntries()) {
        R.longtasks.push([now(), Math.round(e.duration * 10) / 10]);
        b.longtasks += 1;
        b.longtaskMs += e.duration;
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* long tasks are not observable here */
  }

  // -- the page's own entry points, wrapped after app.js loads. A "row" is a direct child of the box being repainted:
  // the console's own rows, or the block's own blocks. Children are what a repaint hands back or throws away.
  const rowsIn = (root) => (root ? [...root.children].filter((n) => n.isConnected) : []);
  const keptOf = (root, rows) => rows.filter((n) => n.isConnected && n.parentElement && root.contains(n)).length;
  window.__instrument = () => {
    const out = [];
    const wrap = (name, make) => {
      const orig = window[name];
      if (typeof orig !== "function" || orig.__w) return false;
      const w = make(orig);
      w.__w = true;
      window[name] = w;
      return true;
    };

    // The console's own repaint. Every row it is about to draw is stamped; the ones still in the box when it returns
    // are the rows the reader keeps.
    if (wrap("syncStreamConsole", (orig) =>
      function (outEl) {
        const rows = rowsIn(outEl);
        const r = orig.apply(this, arguments);
        const kept = keptOf(outEl, rows);
        const b = bucket();
        b.conPolls += 1;
        b.rowsStamped += rows.length;
        b.rowsKept += kept;
        b.rowsReplacedPoll += rows.length - kept;
        if (rows.length) R.polls.push({ t: now(), kind: "console", stamped: rows.length, kept, replaced: rows.length - kept, rowsAfter: rowsIn(outEl).length });
        return r;
      })) out.push("syncStreamConsole");

    // The block's repaint: one fresh <details> per poll, every block inside it a new node.
    if (wrap("paintThink", (orig) =>
      function () {
        const before = document.querySelector(`${cardSel} details.think`);
        const blocks = before ? [...before.querySelectorAll(".think-block")] : [];
        const r = orig.apply(this, arguments);
        const after = document.querySelector(`${cardSel} details.think`);
        if (!before && !after) return r;
        const kept = blocks.filter((n) => n.isConnected && after && after.contains(n)).length;
        const drew = after ? after.querySelectorAll(".think-block").length : 0;
        const b = bucket();
        b.thinkPolls += 1;
        b.blockStamped += blocks.length;
        b.blockKept += kept;
        b.detailsReplaced += before && after && before !== after ? 1 : 0;
        R.polls.push({ t: now(), kind: "think", stamped: blocks.length, kept, replaced: blocks.length - kept, detailsReplaced: before && after && before !== after ? 1 : 0, rowsAfter: drew });
        return r;
      })) out.push("paintThink");

    // The live line path: a growing paragraph keeps its row and has its contents rewritten; a new paragraph appends
    // a row; a line drawn twice would replace one.
    if (wrap("drawJobLine", (orig) =>
      function (evt) {
        const lid = evt && evt.line ? evt.line.lid : null;
        const outEl = evt?.id ? consoleFor(evt.id) : null;
        const before = lid != null && outEl ? outEl.querySelector(`[data-lid="${CSS.escape(String(lid))}"]`) : null;
        const r = orig.apply(this, arguments);
        const after = lid != null && outEl ? outEl.querySelector(`[data-lid="${CSS.escape(String(lid))}"]`) : null;
        const b = bucket();
        b.appends += 1;
        if (before && after && before === after) b.liveInPlace += 1;
        else if (!before && after) b.liveNew += 1;
        return r;
      })) out.push("drawJobLine");

    if (wrap("paintTypedLines", (orig) =>
      function () {
        bucket().pacerPaints += 1;
        return orig.apply(this, arguments);
      })) out.push("paintTypedLines");

    // Who scrolled, so a scrollTop change can be attributed rather than guessed.
    if (wrap("setScroll", (orig) =>
      function (el) {
        if (el) {
          const key = el.matches?.("pre.job-out") ? "console" : el.classList?.contains("think-body") ? "think" : "other";
          lastSet.set(key, now());
          const b = bucket();
          b.setScrollWrites += 1;
          R.scrolls.push({ t: now(), key, setScroll: 1, from: Math.round(el.scrollTop), to: Math.round(arguments[1] ?? 0) });
        }
        return orig.apply(this, arguments);
      })) out.push("setScroll");

    // A card rebuilt under the reader: a status flip, a deliverable, an approval — or the board's own snapshot.
    const board = (name, key) =>
      wrap(name, (orig) =>
        function () {
          const b = bucket();
          b.board += 1;
          b[key] += 1;
          const t = now();
          const r = orig.apply(this, arguments);
          R.boards.push({ t, name, rows: document.querySelectorAll(`${cardSel} pre.job-out [data-lid]`).length });
          return r;
        });
    if (board("renderConversation", "card")) out.push("renderConversation");
    if (board("applySnapshot", "snap")) out.push("applySnapshot");

    return out;
  };
}

// ---- one pass -----------------------------------------------------------------------------------------------------
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

async function runMode(pw, ctx, work, mode) {
  const thread = mode === "stream" ? `${THREAD}-stream` : `${THREAD}-think`;
  const dir = path.join(work, mode);
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "first"], repo);
  seedStore(dir, thread);
  const script = buildScript();
  const writer = makeReasoningWriter(dir, thread);
  const marks = [];
  let pageRef = null;
  const mark = async (name) => {
    if (!pageRef) return;
    try {
      const t = await pageRef.evaluate((n) => window.__probe.mark(n), name);
      marks.push({ name, t });
    } catch {
      /* the page may be gone */
    }
  };
  const phases = {
    quiesce: () => writer.stop(),
    pause: async () => {
      writer.stop();
      await mark("pause");
    },
    pauseSettled: async () => {
      await mark("pauseSettled");
    },
    resume: async () => {
      writer.start();
      await mark("flow2");
    },
    done: async () => {
      await mark("done");
    },
  };
  const gw = makeGateway(script, phases);
  const gwPort = await gw.listen();
  const sandbox = await startPanel({
    dir,
    keep: KEEP,
    config: {
      scanRoots: [path.join(dir, "empty-root")],
      refreshSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: path.join(dir, "repo"),
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
    env: { API_SERVER_KEY: "" },
  });
  const errors = [];
  try {
    const page = await ctx.newPage();
    pageRef = page;
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
    await page.addInitScript(pageInit, { thread, mode, lateStickMs: LATE_STICK_MS });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
    const instrumented = await page.evaluate(() => window.__instrument());
    const spawned = await fetch(`${sandbox.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "probe: stream a fixed reply and think while you do it", cwd: path.join(dir, "repo"), existing: true, thread }),
    }).then((r) => r.json());
    if (!spawned || !spawned.job) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
    writer.start();
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 20000 });
    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`)?.scrollIntoView({ block: "center" }), thread);
    await mark("start");
    await sleep(W.flow1 + W.pause + W.flow2 + 1800);
    await mark("end");
    const R = await page.evaluate(() => window.__probe.dump());
    return { mode, thread, job: spawned.job.id, instrumented, errors, R, marks, reasoningRows: writer.count(), windows: W };
  } finally {
    writer.stop();
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
  }
}

// ---- reading the evidence -----------------------------------------------------------------------------------------
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};

// Windows are cut on the page's own marks, and only seconds wholly inside a window are counted, so no bucket is split
// between "flowing" and "paused".
function windowRows(cap) {
  const m = new Map(cap.R.marks.map((x) => [x.name, x.t]));
  if (!m.has("start") || !m.has("pause") || !m.has("pauseSettled") || !m.has("flow2") || !m.has("end")) return [];
  return [
    { name: "flowing", from: m.get("start"), to: m.get("pause") },
    { name: "paused", from: m.get("pauseSettled"), to: m.get("flow2") },
    { name: "flowing 2", from: m.get("flow2"), to: m.get("end") },
  ];
}

function summarise(cap) {
  const buckets = new Map(cap.R.buckets.map((b) => [b.s, b]));
  return windowRows(cap).map((w) => {
    const bs = [];
    for (const [s, b] of buckets) if (s * 1000 >= w.from && (s + 1) * 1000 <= w.to) bs.push(b);
    const n = Math.max(1, bs.length);
    const per = (k) => sum(bs.map((b) => b[k] || 0));
    const polls = cap.R.polls.filter((p) => p.t >= w.from && p.t <= w.to);
    const conPolls = polls.filter((p) => p.kind === "console" && p.stamped > 0);
    const thinkPolls = polls.filter((p) => p.kind === "think" && p.stamped > 0);
    const boardSeconds = bs.filter((b) => b.board > 0).length;
    // The per-second floor is taken over seconds without a board rebuild: a scheduled rebuild replaces every row at
    // once and is counted on its own line, not folded into "rows the stream replaced".
    const clean = bs.filter((b) => b.board === 0);
    const cn = Math.max(1, clean.length);
    const frameDelays = cap.R.frames.filter((f) => f[0] >= w.from && f[0] <= w.to).map((f) => f[1]);
    const sel = cap.R.sel.filter((p) => p.t >= w.from && p.t <= w.to);
    const sampled = cap.R.scrolls.filter((x) => !x.setScroll && x.t >= w.from && x.t <= w.to);
    const conScroll = sampled.filter((x) => x.key === "console");
    const blockScroll = sampled.filter((x) => x.key === "think");
    const up = (xs) => xs.filter((x) => x.d < -2 && !x.viaSet).length;
    const lost = sel.filter((p) => p.event === "lost");
    const held = (k) => (lost.filter((p) => p.kind === k).length ? med(lost.filter((p) => p.kind === k).map((p) => p.held)) : null);
    return {
      window: w.name,
      seconds: bs.length,
      boardSeconds,
      boardRebuilds: per("board"),
      cardRebuilds: per("card"),
      boardSnapshots: per("snap"),
      // 1. row churn
      consoleRowsReplacedPerSec: r1(sum(clean.map((b) => b.repProse + b.repThink)) / cn),
      consoleRowsReplacedTotal: sum(clean.map((b) => b.repProse + b.repThink)),
      boardRowsReplaced: sum(bs.map((b) => b.repProse + b.repThink)) - sum(clean.map((b) => b.repProse + b.repThink)),
      proseRewrittenPerSec: r1(sum(clean.map((b) => b.inPlaceProse)) / cn),
      reasonRewrittenPerSec: r1(sum(clean.map((b) => b.inPlaceThink)) / cn),
      consoleMutationsPerSec: r1(sum(clean.map((b) => b.mutConsole)) / cn),
      appendsPerSec: r1(per("appends") / n),
      pacerPaintsPerSec: r1(per("pacerPaints") / n),
      largestBatch: Math.max(0, ...bs.map((b) => b.bigReplace || 0)),
      // 2. survivors across a repaint
      consolePolls: conPolls.length,
      rowsStamped: per("rowsStamped"),
      rowsKept: per("rowsKept"),
      rowsReplacedPerPoll: conPolls.length ? r1(sum(conPolls.map((p) => p.replaced)) / conPolls.length) : null,
      survivorsPct: per("rowsStamped") ? r1((100 * per("rowsKept")) / per("rowsStamped")) : null,
      identitySwapsPerSec: r1(per("idSwappedCon") / n),
      identityKeptPerSec: r1(per("idKeptCon") / n),
      blockIdentitySwapsPerSec: r1(per("idSwappedBlock") / n),
      // 3. scroll
      scrollChanges: sampled.length,
      scrollUp: sampled.filter((x) => x.d < -2 && !x.viaSet).length,
      consoleScrollChanges: conScroll.length,
      consoleScrollUp: up(conScroll),
      blockScrollChanges: blockScroll.length,
      blockScrollUp: up(blockScroll),
      scrollFollow: per("scrollFollow"),
      scrollOther: per("scrollOther"),
      setScrollWrites: per("setScrollWrites"),
      gapMax: Math.max(0, ...bs.map((b) => b.gapMax || 0)),
      gapPainted: Math.max(0, ...bs.map((b) => b.gapPainted || 0)),
      gapPaintedSamples: per("gapPaintedSamples"),
      consoleScrollable: (med(bs.map((b) => b.conClientH || 0)) || 0) > 0 && Math.max(0, ...bs.map((b) => b.conScrollH || 0)) > (med(bs.map((b) => b.conClientH || 0)) || 0) + 20,
      inputEvents: per("input"),
      // 4. the thinking block
      thinkPolls: thinkPolls.length,
      detailsReplaced: per("detailsReplaced"),
      detailsReplacedPerSec: r1(per("detailsReplaced") / n),
      blockStamped: per("blockStamped"),
      blockKept: per("blockKept"),
      blockSurvivorsPct: per("blockStamped") ? r1((100 * per("blockKept")) / per("blockStamped")) : null,
      blockReplacedPerPoll: thinkPolls.length ? r1(sum(thinkPolls.map((p) => p.replaced)) / thinkPolls.length) : null,
      blockRowsReplacedPerSec: r1(per("repBlock") / n),
      blockRewrittenPerSec: r1(per("inPlaceBlock") / n),
      // context
      conRows: med(bs.map((b) => b.conRows || 0)),
      conRowsMax: Math.max(0, ...bs.map((b) => b.conRows || 0)),
      conScrollH: med(bs.map((b) => b.conScrollH || 0)),
      conClientH: med(bs.map((b) => b.conClientH || 0)),
      conScrollMax: Math.max(0, ...bs.map((b) => b.conScrollH || 0)),
      conTop: med(bs.map((b) => b.conTop || 0)),
      staleMax: Math.max(0, ...bs.map((b) => b.staleSec || 0)),
      fps: r1(per("frames") / n),
      frameP95: pct(frameDelays, 0.95),
      framesOver50: frameDelays.filter((x) => x > 50).length,
      longtasks: per("longtasks"),
      selLosses: per("selLosses"),
      arms: sel.filter((p) => p.event === "arm").length,
      heldGrowing: held("growing"),
      heldReasoning: held("reasoning"),
      heldSettled: held("settled"),
    };
  });
}

// ---- the thresholds -----------------------------------------------------------------------------------------------
// Every number here is argued in docs/jitter-synthesis.md ("The thresholds"). They are one-sided: a fixed code path
// reads lower and still passes, a regressed one reads higher and fails.
const T = {
  consoleRowsReplacedPerSec: 0, // any row that came back as a new node, outside a board rebuild
  consoleSurvivorsPct: 100, // kept/stamped across the console's own poll
  scrollUp: 0, // no upward scrollTop without input, ever
  pausedScrollChanges: 0, // a paused box does not move at all
  gapMaxPx: 4, // a pinned console is never more than a quarter line off its bottom
  pausedRewritesPerSec: 1, // the control: a stalled stream rewrites nothing (0.2/s of page furniture allowed)
  detailsReplacedPerSec: 0.7, // the shipped poll is 1 per ~2.4 s (0.42/s); 0.7 clears the 6-7 polls a window holds
  blockSurvivorsPct: 100, // a poll that patches hands back every block it drew. 0% is the defect, measured
};

function judge(mode, rows) {
  const checks = [];
  const add = (name, got, want, ok) => checks.push({ name, got, want, ok });
  const flow = rows.find((r) => r.window === "flowing");
  const paused = rows.find((r) => r.window === "paused");
  if (!flow || !paused) return { checks, driven: false };

  // A run that measured nothing must not pass. These are preconditions, not jitter thresholds.
  const driven =
    flow.appendsPerSec >= 2 &&
    flow.proseRewrittenPerSec + flow.reasonRewrittenPerSec >= 5 &&
    (mode === "think" ? flow.thinkPolls >= 2 : flow.consolePolls >= 3) &&
    flow.conRowsMax >= 3;
  add(`${mode}: the stream really drove the card`, { appendsPerSec: flow.appendsPerSec, rewritesPerSec: r1(flow.proseRewrittenPerSec + flow.reasonRewrittenPerSec), consoleRows: flow.conRowsMax, polls: mode === "think" ? flow.thinkPolls : flow.consolePolls }, "appends>=2/s, rewrites>=5/s, 3+ console rows and 2+ polls", driven);

  // 1. row churn: the console's only correct repaint is a patch.
  add(`${mode}: the stream replaces no console row`, flow.consoleRowsReplacedPerSec, `<= ${T.consoleRowsReplacedPerSec}/s`, flow.consoleRowsReplacedPerSec <= T.consoleRowsReplacedPerSec);
  add(`${mode}: a paused console replaces no row`, paused.consoleRowsReplacedPerSec, `<= ${T.consoleRowsReplacedPerSec}/s`, paused.consoleRowsReplacedPerSec <= T.consoleRowsReplacedPerSec);

  // 2. survivors across a repaint (the console's own poll; in 🌊 the reasoning rows are console rows too).
  if (mode === "stream" && flow.consolePolls >= 3) {
    add(`${mode}: every console poll hands back every row it drew`, flow.survivorsPct, `${T.consoleSurvivorsPct}% (${flow.rowsKept}/${flow.rowsStamped})`, flow.survivorsPct === T.consoleSurvivorsPct);
  }
  if (mode === "think" && flow.thinkPolls >= 2) {
    add(`${mode}: the thinking block hands back every row it drew`, `${flow.blockSurvivorsPct}% (${flow.blockKept}/${flow.blockStamped})`, `${T.blockSurvivorsPct}% (${flow.blockStamped}/${flow.blockStamped})`, flow.blockSurvivorsPct === T.blockSurvivorsPct);
  }

  // 3. scroll: no upward motion, no paused motion, no frame off the bottom.
  const up = flow.consoleScrollUp + paused.consoleScrollUp + flow.blockScrollUp + paused.blockScrollUp;
  add(`${mode}: no scrollTop moves up`, { console: flow.consoleScrollUp + paused.consoleScrollUp, block: flow.blockScrollUp + paused.blockScrollUp }, T.scrollUp, up === 0);
  add(`${mode}: a paused box does not move`, paused.scrollChanges, T.pausedScrollChanges, paused.scrollChanges <= T.pausedScrollChanges);
  // Judged on the PAINTED gap (the ResizeObserver read, after the page's own same-frame stick), never on frameFn's
  // start-of-frame read: that one runs before stickSoon's callback and reported 52-69 px on a page that painted 0 px,
  // while --late-stick 60 (a stick that really is late) paints 34 px and is caught. A painted read that never ran is
  // a failure, not a pass.
  const paintedRan = flow.gapPaintedSamples > 0;
  const painted = Math.max(flow.gapPainted, paused.gapPainted);
  add(
    `${mode}: the console is never painted off its bottom (painted read; ${Math.max(flow.gapMax, paused.gapMax)} px before the page's own stick in the frame)`,
    paintedRan ? painted : "painted read never ran",
    `<= ${T.gapMaxPx}px`,
    paintedRan && painted <= T.gapMaxPx,
  );
  add(`${mode}: no input was sent, so every scroll counted is the page's`, flow.inputEvents + paused.inputEvents, 0, flow.inputEvents + paused.inputEvents === 0);

  // The control: the paused seconds rewrite nothing in the console. This is what separates the tokens from the poll.
  add(`${mode}: the paused console rewrites nothing`, r1(paused.proseRewrittenPerSec + paused.reasonRewrittenPerSec), `<= ${T.pausedRewritesPerSec}/s`, paused.proseRewrittenPerSec + paused.reasonRewrittenPerSec <= T.pausedRewritesPerSec);

  // 4. the block's replacement rate while the turn is live.
  if (mode === "think" && flow.thinkPolls >= 2) {
    add(`${mode}: at most one block rebuild per poll`, flow.detailsReplaced, `<= ${flow.thinkPolls} polls`, flow.detailsReplaced <= flow.thinkPolls);
    add(`${mode}: the thinking block is not rebuilt more often than the poll`, flow.detailsReplacedPerSec, `<= ${T.detailsReplacedPerSec}/s (${flow.detailsReplaced} in ${flow.seconds}s)`, flow.detailsReplacedPerSec <= T.detailsReplacedPerSec);
  }

  return { checks, driven };
}

// ---- printing -----------------------------------------------------------------------------------------------------
function printTable(mode, rows) {
  const head = ["window", "s", "rows repl/s", "rows repl", "board rows", "prose rw/s", "reason rw/s", "appends/s", "polls", "kept/stamped", "kept %", "id swaps/s", "scroll chg", "up", "follow", "setScroll", "gap rAF", "gap painted", "block polls", "details repl", "block kept %", "fps", "p95", "stale s"];
  const key = (r) => [
    r.window, r.seconds, r.consoleRowsReplacedPerSec, r.consoleRowsReplacedTotal, r.boardRowsReplaced, r.proseRewrittenPerSec, r.reasonRewrittenPerSec,
    r.appendsPerSec, r.consolePolls ? r.consolePolls : r.thinkPolls, r.consolePolls ? `${r.rowsKept}/${r.rowsStamped}` : `${r.blockKept}/${r.blockStamped}`,
    r.consolePolls ? (r.survivorsPct ?? "—") : (r.blockSurvivorsPct ?? "—"), r.identitySwapsPerSec,
    r.scrollChanges, r.scrollUp, r.scrollFollow, r.setScrollWrites, r.gapMax, r.gapPainted,
    r.thinkPolls, r.detailsReplaced, r.blockSurvivorsPct ?? "—", r.fps, r.frameP95, r.staleMax,
  ];
  console.log(`\n== ${mode}: ${rows.map((r) => `${r.window} ${r.seconds}s`).join(" / ")}${rows.some((r) => r.boardRebuilds) ? ` (${rows.reduce((a, r) => a + r.boardRebuilds, 0)} board rebuilds)` : ""}`);
  console.log(`   ${head.join(" | ")}`);
  for (const r of rows) console.log(`   ${key(r).map((v) => (v == null ? "—" : v)).join(" | ")}`);
}

// ---- main ---------------------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(0);
}
const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-jitter-"));
const profile = path.join(work, "profile");
mkdirSync(profile, { recursive: true });
const ctx = await pw.chromium.launchPersistentContext(profile, { headless: HEADLESS, viewport: { width: 1280, height: 1000 } });
const captures = [];
let exit = 0;
try {
  // --resync-check is one long flow, and one renderer is enough to catch a board rebuild: the mechanism is the
  // board's, not the console's. It defaults to whichever mode was asked for, or 🌊.
  const modes = RESYNC_CHECK ? [MODE === "think" ? "think" : "stream"] : MODE === "both" ? ["stream", "think"] : [MODE];
  for (const mode of modes) {
    console.log(`\n-- ${mode}: a sandbox panel of its own, a fixed stream (${W.flow1} ms flow / ${W.pause} ms pause / ${W.flow2} ms flow)${RESYNC_CHECK ? ", --resync-check" : ""}`);
    const cap = await runMode(pw, ctx, work, mode);
    cap.rows = summarise(cap);
    cap.verdict = judge(mode, cap.rows);
    captures.push(cap);
    printTable(mode, cap.rows);
    const flow = cap.rows[0];
    console.log(
      `   console: ${flow.conRowsMax} rows at its fullest, ${flow.conScrollMax}/${flow.conClientH}px of content in ${flow.consoleScrollable ? "a scroll box" : "a box that never overflowed"}; ` +
        `block: ${flow.blockStamped} rows at the last poll, ${flow.blockRowsReplacedPerSec} replaced/s, ${flow.blockRewrittenPerSec} rewritten/s; card rebuilds: ${cap.rows.reduce((a, r) => a + r.cardRebuilds, 0)}, board snapshots: ${cap.rows.reduce((a, r) => a + r.boardSnapshots, 0)}; ` +
        `identity swaps/s — console ${flow.identitySwapsPerSec}, block ${flow.blockIdentitySwapsPerSec}; liveness clock up to ${Math.max(...cap.rows.map((r) => r.staleMax))}s stale`,
    );
    console.log(`   selection while flowing: ${flow.arms} armed, ${flow.selLosses} lost (median held: growing ${flow.heldGrowing ?? "—"} ms, reasoning ${flow.heldReasoning ?? "—"} ms, settled ${flow.heldSettled ?? "—"} ms)`);
    for (const c of cap.verdict.checks) {
      if (c.ok) console.log(`PASS  ${c.name}: ${JSON.stringify(c.got)}`);
      else console.log(`FAIL  ${c.name}\n        got  ${JSON.stringify(c.got)}\n        want ${JSON.stringify(c.want)}`);
    }
    if (!cap.verdict.driven) exit = Math.max(exit, 2);
  }
  const all = captures.flatMap((c) => c.verdict.checks);
  const pageErrors = captures.flatMap((c) => c.errors);
  if (pageErrors.length) {
    console.log(`\nFAIL  page errors: ${JSON.stringify(pageErrors.slice(0, 3))}`);
    exit = 2;
  }
  if (RESYNC_CHECK) {
    // The 30 s check: the panel's safety net must not rebuild a card that is demonstrably streaming. jobline frames do
    // not stamp state.lastEventAt (public/core/sse.js:129), so this is the mechanism jitter-streaming.md measured at
    // 30.1 s and 60.6 s. It is its own mode because the default windows end before the first tick.
    const rebuilds = captures.reduce((a, c) => a + c.R.buckets.reduce((x, b) => x + (b.snap || 0), 0), 0);
    const flowing = captures.map((c) => c.rows.find((r) => r.window === "flowing")).filter(Boolean);
    const lines = flowing.reduce((a, r) => a + r.appendsPerSec, 0);
    const ok = rebuilds === 0 || lines < 1;
    console.log(`\n${ok ? "PASS" : "FAIL"}  resync: a streaming card is not rebuilt by the board (${rebuilds} rebuilds while ${r1(lines)} lines/s arrived)`);
    all.push({ name: "resync: a streaming card is not rebuilt by the board", got: `${rebuilds} rebuilds at ${r1(lines)} lines/s`, want: "0 rebuilds while lines arrive", ok });
  }
  const failed = all.filter((c) => !c.ok);
  console.log(`\n${failed.length || exit ? "FAIL" : "PASS"}  ${all.length - failed.length}/${all.length} checks  (${captures.map((c) => `${c.mode} ${c.R.buckets.length}s`).join(", ")})`);
  if (JSON_OUT) {
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), windows: W, thresholds: T, captures: captures.map((c) => ({ ...c, summary: summarise(c) })) }, null, 1));
    console.log(`   capture: ${JSON_OUT}`);
  }
  if (failed.length) exit = Math.max(exit, 1);
} finally {
  await ctx.close().catch(() => {});
  if (!KEEP) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  else console.log(`   sandbox kept: ${work}`);
}
process.exit(exit);
