// The console and the reasoning block, measured while a STREAM of tokens is flowing and again while it is paused.
//
//   node tools/measure-stream-jitter.mjs --mode stream        # 🌊 one-stream console (reasoning is rows of it)
//   node tools/measure-stream-jitter.mjs --mode think         # the 🧠 block above a condensed console
//   --report <dir>   where the captures go (default the directory the tool runs in)
//   --label <name>   name of the capture (default the mode)
//   --flow1/--pause/--flow2/--settle <ms>   the four windows (defaults 30000/15000/20000/8000)
//   --md <path>      also write the per-window table as markdown
//
// WHAT IT DRIVES
//   * a throwaway panel of its own (panel-testkit: spare port, own config/jobs/projects cache, assistant off,
//     API_SERVER_KEY empty), so the reading panel on 7331 is never touched
//   * a stub Runs API that plays a generated reply over real SSE: prose arrives as message.delta frames of one to
//     three words every ~75 ms, the panel's own lib/jobs.js coalesces them at 120 ms into a growing line, and the
//     page's pacer types it — this is the normal output of a streaming turn, with nothing invented on the page
//   * a session store of its own (`<sandbox>/hermes/state.db`) that GROWS while the stream flows: a new reasoning
//     row every ~2 s, which is what /api/thinking reads back and what the reasoning pane is drawn from. It stops
//     growing while the stream is paused, so "paused" is a stalled model on the wire AND a still store.
//   * headless=OFF Chromium in a profile of its own, because the question is what the reader's screen does.
//
// WHAT IT RECORDS, per second
//   rows replaced vs rows mutated in place (prose and reasoning separately), on three independent readings:
//     - every repaint (`syncStreamConsole` / `paintThink`) stamps each row it is about to draw and counts how many
//       of those NODE OBJECTS are still there when it returns
//     - a MutationObserver counts element rows added/removed and rows swapped for a new node with the same lid
//     - a once-a-second walk of `[data-lid]` compares node identity with the previous second
//   plus: scrollTop jumps (and whether each was a follow-to-bottom or a pull), the console's distance from the
//   bottom, selection survival, rAF frame intervals, long tasks, and total DOM mutation records.
//
// The page never changes what it does. Every recorder is a wrapper, a MutationObserver or a rAF loop.
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
const MODE = opt("--mode", "stream");
if (!["stream", "think"].includes(MODE)) {
  console.log(`--mode must be stream or think, not ${MODE}`);
  process.exit(2);
}
const REPORT = opt("--report", process.cwd());
const LABEL = opt("--label", MODE);
const FLOW1 = Number(opt("--flow1", 30000));
const PAUSE = Number(opt("--pause", 15000));
const FLOW2 = Number(opt("--flow2", 20000));
const SETTLE = Number(opt("--settle", 8000));
const MD = opt("--md");
const THREAD = "probe-jitter";
const SCRATCH = path.join(os.tmpdir(), "measure-stream-jitter");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(n * 10) / 10;

// ---- the generated reply -----------------------------------------------------------------------------------------
// Long enough to flow for FLOW1 + FLOW2 at ~28 words/s and then some. Paragraph breaks are where the console
// starts a NEW line, so they are counted and spaced.
const WORDS = `the panel draws one line at a time and the reader watches it arrive while the turn is still going
a console that grows is a console the reader can trust and one that is rebuilt is not
the reasoning arrives from the store while the prose arrives from the run stream and the two are drawn by two
different paths on the same card the pens keep their own clocks and neither one waits for the other
a row that keeps its node keeps the selection inside it and the scroll that hangs off it
a repaint that swaps the node takes both of them away without a trace on screen
the words come in frames of one to three and the pacer releases them a word at a time on its own clock
the sweep reads the store every second or so and redraws whatever grew since the last read
if the redraw patches the row the reader sees the words extend and nothing else moves
if it replaces the row the reader sees the same words on a new node and a selection that is gone
an empty answer from a store that cannot be read is not a turn that thought nothing
a body that is shorter than the one on screen is not a window trim in the middle of an answer
the console is a fixed height box and its content is longer than the box by a factor of ten
what moves the box is not the words but the layout the words produce when a line wraps
keeping the newest line in view means scrolling to the bottom after every growth
that scroll is the panel's own and it is the one the reader asked for by sitting at the bottom
a reader who has scrolled up is a reader the panel must not touch and must not yank back down
the reasoning block is polled and the console is appended to and that is the whole difference between them
the poll is the only thing on a live card that redraws what it has already drawn
so the jitter lives in the poll or it lives in the pacer and it is measurable in both
count the rows that are still the same node after a repaint and you have counted what the reader keeps
count the rows that came back as new nodes and you have counted what the reader lost
the frame clock says whether any of it costs a frame and the long task observer says whether it costs more
a long task over fifty milliseconds is a frame the reader did not get while the turn was running
the selection check is the one that cannot be faked because a selection lives in the text nodes themselves
no amount of scroll restoration puts a selection back once the text node under it has been replaced
the paused case is the control because a stalled model still leaves the poll running on its own clock
if the paused seconds show the same churn then the churn was never about the tokens at all
and if they show none then every row counted while flowing belongs to the arrival of the words themselves`
  .split(/\s+/)
  .filter(Boolean);

function replyText(words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[i % WORDS.length]);
  return out;
}
const REPLY = replyText(1800);
const PARAGRAPH_WORDS = 55;

// The script: one to three words per delta, every ~75 ms, a blank line every PARAGRAPH_WORDS so the console starts a
// new row, and a hole of PAUSE ms with no event at all in the middle of it.
function buildScript() {
  const steps = [];
  let t = 300;
  let i = 0;
  let para = 0;
  const flowUntil = (end) => {
    while (t < end && i < REPLY.length) {
      const n = 1 + Math.floor(Math.random() * 3);
      const chunk = REPLY.slice(i, i + n).join(" ");
      i += n;
      para += n;
      const lead = para >= PARAGRAPH_WORDS ? "\n\n" : i === n ? "" : " ";
      if (lead === "\n\n") para = 0;
      steps.push({ at: t, evt: { event: "message.delta", delta: `${lead}${chunk} ` } });
      t += 62 + Math.round(Math.random() * 26);
    }
  };
  flowUntil(FLOW1);
  t = FLOW1 + PAUSE;
  // the paragraph the pause interrupted continues, so the pause is a stall and not a new line
  flowUntil(FLOW1 + PAUSE + FLOW2);
  steps.push({ at: t + 200, evt: { event: "run.completed", output: "done", usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } } });
  return steps;
}

// ---- the reasoning store ------------------------------------------------------------------------------------------
// `messages.reasoning_content`, one row per assistant message, exactly the column lib/thinking.js reads. The rows are
// appended while the stream flows and not while it is paused.
const REASONING = [
  "The reader is watching a live card, so the thing to measure is the pane that is redrawn rather than appended to. I will keep the prose flowing through the run stream and let the store carry the reasoning, because those are the two real sources the two panes read.",
  "A repaint that patches a row keeps the text node under the reader's selection. A repaint that replaces the row does not. The difference is invisible in a screenshot taken after the fact and obvious in a selection that collapses while the reader is holding it.",
  "I want the console's distance from the bottom as well as its scrollTop, because a box that grows under a reader who is at the bottom moves its content up without moving scrollTop at all. The snap back to the bottom is the panel's stick, and the size of the snap is the jitter.",
  "The pacer releases words on its own clock, about twenty-five times a second at the default rate, and every release rewrites the row's contents in place. That is a mutation the reader does not see as a jump, but it is a text node swap under any selection inside that row.",
  "If the poll redraws a growing reasoning block by replacing its row, then the sentence the reader is halfway through selecting is rebuilt under the cursor every time the store is read. That would be the streaming version of the collapse the block used to have.",
  "The paused window is the control. The poll keeps running on its own timer against a store that is not growing, so anything that still changes in those seconds is the panel's own furniture rather than the arrival of words.",
  "A long task is the only measure here that can say the reader lost a frame. Everything else is bookkeeping about nodes; a long task is a frame that did not happen while the turn was running and the reader was watching.",
  "I should record the scroll's author, because the panel's own stick to the bottom is a scrollTop jump with no user input that the reader wants. The jump that matters is the one upward, or the one that overshoots the content and comes back.",
];

function storePath(dir) {
  return path.join(dir, "hermes", "state.db");
}

function seedStore(dir) {
  mkdirSync(path.join(dir, "hermes"), { recursive: true });
  const db = new DatabaseSync(storePath(dir));
  db.exec(`
    create table if not exists sessions (id text primary key, source text not null, started_at real not null,
      model text, cwd text, title text, message_count integer default 0);
    create table if not exists messages (id integer primary key autoincrement, session_id text not null, role text not null,
      content text, timestamp real not null, reasoning text, reasoning_content text, tool_name text, tool_call_id text,
      token_count integer, finish_reason text);
  `);
  db.prepare("insert or replace into sessions (id, source, started_at, model, cwd, title) values (?,?,?,?,?,?)").run(THREAD, "probe", Date.now() / 1000, "probe/model", ROOT, "jitter probe");
  db.close();
}

// One reasoning row. Timestamps are epoch seconds and rise with the clock, so each is a new block with its own
// `think:<at>` lid — the shape the store really has.
function makeReasoningWriter(dir) {
  const st = { on: false, timer: null, n: 0, rows: [] };
  const write = () => {
    if (!st.on) return;
    const text = REASONING[st.n % REASONING.length] + ` (${st.n + 1})`;
    st.n += 1;
    try {
      const db = new DatabaseSync(storePath(dir));
      db.prepare("insert into messages (session_id, role, content, timestamp, reasoning_content) values (?,?,?,?,?)").run(THREAD, "assistant", "…", Date.now() / 1000, text);
      db.close();
      st.rows.push({ at: Date.now(), chars: text.length });
    } catch {
      /* a locked store is a read the caller retries on its next poll */
    }
    st.timer = setTimeout(write, 2000);
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
    state: st,
  };
}

// ---- the stub Runs API --------------------------------------------------------------------------------------------
function makeGateway(script, phases) {
  const state = { runs: new Map(), posts: 0, startedAt: null, closed: false };
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
    if (url.pathname === "/v1/capabilities") return json(200, { version: "jitter-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
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
      state.startedAt = rec.startedAt;
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
  // The windows are cut on the STUB's clock, so "paused" means the wire really went quiet: the mark and the
  // reasoning writer are switched at the same moment the script has its hole. The writer stops REASONING_LEAD ms
  // before the hole, because the block it last wrote goes on typing for a few seconds afterwards (the pacer releases
  // 40 words a second) and those seconds would otherwise be counted as "paused".
  const REASONING_LEAD = 3500;
  later(Math.max(0, FLOW1 - REASONING_LEAD), () => phases.quiesce());
  later(FLOW1, () => phases.pause());
  later(FLOW1 + PAUSE, () => phases.resume());
  later(FLOW1 + PAUSE + FLOW2 + 220, () => phases.done());
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

// ---- the page-side instrument ------------------------------------------------------------------------------------
// Before app.js. Storage only: which card mode this run is measuring, and the reader's own type speeds left at their
// defaults (40 words/s, no line gate), because those are what a reader has.
function pageInit({ thread, mode }) {
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
  const R = {
    buckets: [],
    marks: [],
    frames: [],
    longtasks: [],
    polls: [],
    live: [],
    typed: [],
    sel: [],
    scrolls: [],
    cards: [],
    errors: [],
    snapshots: [],
  };
  const P = { seq: 0, lastSnap: new Map(), lastSec: -1, armed: 0 };
  window.__rec = R;
  window.__probe = {
    now,
    mark(name) {
      R.marks.push({ name, t: now() });
      return now();
    },
    arm() {
      P.armed = 1;
    },
    // The buckets live in a Map while the page runs; a Map is not JSON, so a capture is dumped through here.
    dump() {
      return { ...R, buckets: [...B.values()].sort((a, b) => a.s - b.s) };
    },
  };
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));

  const B = new Map();
  const bucket = (t) => {
    const s = Math.floor((t == null ? now() : t) / 1000);
    let b = B.get(s);
    if (!b) {
      b = {
        s,
        mut: 0, mutCon: 0, mutThink: 0, mutChar: 0, mutChild: 0, mutAttr: 0,
        addProse: 0, addThink: 0, addTool: 0, remProse: 0, remThink: 0, remTool: 0,
        repProse: 0, repThink: 0, repTool: 0,
        inPlaceProse: 0, inPlaceThink: 0, inPlaceOther: 0,
        polls: 0, thinkPolls: 0, rowsStamped: 0, rowsKept: 0, thinkBlocksStamped: 0, thinkBlocksKept: 0,
        liveDraws: 0, liveNew: 0, liveInPlace: 0, liveReplaced: 0,
        typedPaints: 0, typedRows: 0,
        cards: 0,
        frames: 0,
        scrollChanges: 0, scrollUp: 0, scrollFollow: 0, scrollOther: 0, yJumps: 0, gapMax: 0, gapSamples: 0, gapSum: 0,
        selChecks: 0, selLosses: 0, longtasks: 0, longtaskMs: 0,
      };
      B.set(s, b);
    }
    return b;
  };
  const kindOf = (lid) => (String(lid || "").startsWith("think:") ? "think" : "prose");

  // -- one element row, by the rank it is counted in: a reasoning row, a prose row, or a tool group.
  const rowKind = (n) => {
    const lid = n?.dataset?.lid;
    if (lid) return kindOf(lid);
    if (n?.dataset?.tgrp) return "tool";
    return "prose";
  };

  // -- rows: added, removed, and swapped for a new node with the same lid.
  const obs = new MutationObserver((list) => {
    const t = now();
    const b = bucket(t);
    for (const m of list) {
      b.mut += 1;
      if (m.type === "attributes") {
        b.mutAttr += 1;
        continue;
      }
      if (m.type === "characterData") b.mutChar += 1;
      else b.mutChild += 1;
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (target?.closest?.("pre.job-out")) b.mutCon += 1;
      if (target?.closest?.(".think")) b.mutThink += 1;
      if (m.type !== "childList") {
        const row = target?.closest?.("[data-lid]");
        if (row && row.isConnected) {
          const k = kindOf(row.dataset.lid);
          if (k === "think") b.inPlaceThink += 1;
          else b.inPlaceProse += 1;
        }
        continue;
      }
      // A node that is still connected was MOVED, not thrown away (the Agents panel re-places a card in its slot, and
      // every row under it comes out of one parent and into another). Only a disconnected row left the page.
      const addedRows = [...m.addedNodes].filter((n) => n.nodeType === 1).flatMap((n) => [n, ...n.querySelectorAll("[data-lid]")]).filter((n) => n.dataset && n.dataset.lid !== undefined && n.isConnected);
      const removedRows = [...m.removedNodes].filter((n) => n.nodeType === 1).flatMap((n) => [n, ...n.querySelectorAll("[data-lid]")]).filter((n) => n.dataset && n.dataset.lid !== undefined && !n.isConnected);
      const added = addedRows;
      const removed = removedRows;
      // A batch that takes several rows out of the page at once is a repaint of a whole pane, not a row edit. Its
      // stack names the caller, which is the difference between "the stream did this" and "the board did".
      if (removed.length >= 5) {
        (R.bigReplaces = R.bigReplaces || []).push({ t, rows: removed.length, lids: removed.slice(0, 3).map((n) => n.dataset.lid), stack: String(new Error().stack || "").split("\n").slice(2, 9).map((s) => s.trim()).join(" < ").slice(0, 400) });
      }
      // Who wrote into the row the reader's selection is standing in: the answer to "what took my selection".
      if (selState.text && m.type !== "attributes") {
        const row = target?.closest?.("[data-lid]");
        const a = window.getSelection()?.anchorNode;
        if (row && a && row.contains(a)) (R.selKills = R.selKills || []).push({ t, lid: row.dataset.lid, kind: selState.kind, type: m.type });
      }
      for (const n of added) {
        const k = rowKind(n);
        if (k === "think") b.addThink += 1;
        else if (k === "tool") b.addTool += 1;
        else b.addProse += 1;
      }
      for (const n of removed) {
        const k = rowKind(n);
        if (k === "think") b.remThink += 1;
        else if (k === "tool") b.remTool += 1;
        else b.remProse += 1;
      }
      // A row swapped for a new node carrying the same lid — replaceWith, the thing that costs the reader their
      // selection. Counted only when both halves are in the SAME record, which is what a replace produces.
      for (const oldNode of removed) {
        const lid = oldNode.dataset.lid;
        if (!lid) continue;
        if (added.some((n) => n.dataset.lid === lid)) {
          const k = kindOf(lid);
          if (k === "think") b.repThink += 1;
          else b.repProse += 1;
        }
      }
      // The row that stayed and had its own children rewritten: the pacer's `el.innerHTML = …` or a live `mode:set`
      // append. The row itself is connected, so this is a mutation the reader keeps the node for.
      const row = target?.closest?.("[data-lid]");
      if (row && row.isConnected && !removed.includes(row)) {
        const k = kindOf(row.dataset.lid);
        if (k === "think") b.inPlaceThink += 1;
        else b.inPlaceProse += 1;
      }
    }
  });
  // At document_start there may be no body yet, and observing null throws — which would take the rest of this script
  // (and window.__instrument) down with it. The panel's own work starts at DOMContentLoaded, so a late attach misses
  // nothing.
  const attachObserver = () => {
    const root = document.body || document.documentElement;
    if (!root) return false;
    obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    return true;
  };
  if (!attachObserver()) document.addEventListener("DOMContentLoaded", attachObserver, { once: true });

  // -- selection: what is standing, and how long it survives. Three targets, because the answer is not the same for
  // a row that is being rewritten, a reasoning row, and a row that has settled: the newest paragraph, the newest
  // reasoning block, and the FIRST paragraph of the console (which no painter touches once it is written).
  const selState = { text: "", kind: "", at: 0 };
  const selNow = () => {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return "";
    return String(s.toString());
  };
  const pickTarget = (which) => {
    const q = (sel) => [...document.querySelectorAll(sel)].filter((n) => n.isConnected && n.textContent.trim().length > 40);
    if (which === "reasoning") {
      const pool = q(".think-block:not(.think-empty), pre.job-out [data-lid^=\"think:\"]");
      return { row: pool[pool.length - 1], kind: "reasoning" };
    }
    const pool = q("pre.job-out .jl-text");
    return { row: which === "settled" ? pool[0] : pool[pool.length - 1], kind: which };
  };
  const ORDER = ["growing", "reasoning", "settled"];
  let armNext = 0;
  // A selection that is never touched would otherwise stand for the whole run and produce one sample; it is re-armed
  // every MAX_HOLD ms so each target gets a turn, and the ones that reach MAX_HOLD are recorded as having survived
  // that long (which is the answer for a row nothing repaints).
  const MAX_HOLD = 4000;
  const armSelection = () => {
    const kind = ORDER[armNext % ORDER.length];
    const { row } = pickTarget(kind);
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
    R.sel.push({ t: selState.at, event: "arm", kind, text: selState.text.slice(0, 30) });
    return true;
  };
  // Every frame, not every second: a selection that lives 40 ms and one that lives one second are different faults,
  // and the second is what a once-a-second check would report for both.
  const checkSelection = () => {
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
    const b = bucket();
    b.selChecks += 1;
    b.selLosses += 1;
    R.sel.push({ t: now(), event: "lost", kind: selState.kind, held: Math.round((now() - selState.at) * 10) / 10, now: txt.slice(0, 24) });
    selState.text = "";
  };

  // -- scroll: scrollTop, the room below it, and who moved it.
  const lastScroll = new Map();
  let lastY = window.scrollY;
  let lastSetScroll = new Map();
  const userAnim = { at: -1e9 };
  for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) window.addEventListener(ev, () => (userAnim.at = now()), true);
  const sampleScroll = (key, el) => {
    if (!el || !el.isConnected) return;
    const top = Math.round(el.scrollTop);
    const max = Math.round(el.scrollHeight - el.clientHeight);
    const prev = lastScroll.get(key);
    const b = bucket();
    if (max > 0) {
      b.gapSamples += 1;
      b.gapSum += Math.max(0, max - top);
      b.gapMax = Math.max(b.gapMax, Math.max(0, max - top));
    }
    if (prev && (prev.top !== top || prev.max !== max)) {
      const d = top - prev.top;
      const dm = max - prev.max;
      if (d !== 0) {
        b.scrollChanges += 1;
        const viaSet = (lastSetScroll.get(key) || -1e9) > now() - 120;
        if (d < -2) b.scrollUp += 1;
        else if (d > 0 && Math.abs(d - dm) <= 2) b.scrollFollow += 1;
        else b.scrollOther += 1;
        R.scrolls.push({ t: now(), key, from: prev.top, to: top, d, dm, maxBefore: prev.max, maxAfter: max, viaSetScroll: viaSet ? 1 : 0, user: now() - userAnim.at < 500 ? 1 : 0 });
      }
    }
    lastScroll.set(key, { top, max });
  };

  // -- frames, long tasks, and the once-a-second identity walk.
  const snap = () => {
    const m = new Map();
    for (const el of document.querySelectorAll("pre.job-out [data-lid], .think-body [data-lid]")) {
      const lid = el.dataset.lid;
      if (!lid) continue;
      if (!el.__probe) el.__probe = ++P.seq;
      m.set(lid, el);
    }
    const prev = P.lastSnap;
    let kept = 0;
    let swapped = 0;
    let added = 0;
    let gone = 0;
    for (const [lid, el] of m) {
      if (!prev.has(lid)) added += 1;
      else if (prev.get(lid) === el) kept += 1;
      else swapped += 1;
    }
    for (const lid of prev.keys()) if (!m.has(lid)) gone += 1;
    P.lastSnap = m;
    R.snapshots.push({ t: now(), rows: m.size, kept, swapped, added, gone });
    const b = bucket();
    b.snapRows = m.size;
    b.snapKept = kept;
    b.snapSwapped = swapped;
    b.snapAdded = added;
    b.snapGone = gone;
  };

  let lastFrame = performance.now();
  const frame = () => {
    const t = performance.now();
    const dt = t - lastFrame;
    lastFrame = t;
    if (dt > 0 && dt < 4000) {
      R.frames.push([now(), Math.round(dt * 10) / 10]);
      bucket().frames += 1;
    }
    checkSelection();
    if (!selState.text && now() - (P.lastArm || 0) > 700) {
      if (armSelection()) P.lastArm = now();
    }
    const s = Math.floor(now() / 1000);
    if (s !== P.lastSec) {
      if (P.lastSec >= 0) snap();
      P.lastSec = s;
    }
    const job = typeof state !== "undefined" ? [...state.jobs.values()].find((j) => j.thread === "probe-jitter") : null;
    if (job) {
      const con = document.querySelector(`pre.job-out[data-out="${job.id}"]`);
      sampleScroll("console", con);
      if (con) {
        const b = bucket();
        b.conRows = con.children.length;
        b.conScrollH = con.scrollHeight;
        b.conClientH = con.clientHeight;
        b.conTop = Math.round(con.scrollTop);
      }
      sampleScroll("think", document.querySelector("details.think[open] .think-body") || document.querySelector(".think-body"));
    }
    // The page's own liveness clock, sampled once a second. The panel's 30 s safety net resyncs the whole board when
    // this is more than 20 s old, and a resync rebuilds every card — so how stale it gets while tokens arrive is the
    // difference between "the stream is the only thing repainting" and "the safety net keeps rebuilding the card".
    if (job) {
      const b = bucket();
      b.staleMs = Math.round((Date.now() - (typeof state !== "undefined" && state.lastEventAt ? state.lastEventAt : 0)) / 1000);
    }
    if (Math.abs(window.scrollY - lastY) > 1) {
      bucket().yJumps += 1;
      lastY = window.scrollY;
    }
    bucket().framesLive = bucket().frames;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

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

  // -- the entry points. Wrapped AFTER app.js loads (window.__instrument), so the wrappers are what the page calls.
  // A "row" is a direct child of the box being repainted: the console's own rows, or the block's own blocks. Children
  // are what a repaint hands back or throws away, so they are what is stamped.
  const rowsIn = (root) => (root ? [...root.children].filter((n) => n.isConnected) : []);
  const stamp = (rows) => rows.map((n) => {
    if (!n.__probe) n.__probe = ++P.seq;
    return n;
  });
  const keptOf = (root, rows) => rows.filter((n) => n.isConnected && n.parentElement && root.contains(n)).length;
  const capSel = (root) => {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const a = s.anchorNode;
    if (!a || !root.contains(a)) return null;
    return { text: String(s.toString()), anchor: a };
  };
  const selSurvived = (cap) => (cap ? Boolean(cap.anchor.isConnected && cap.text && String(window.getSelection()?.toString() || "") === cap.text) : null);

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

    // The two repainters. Each stamps every row it is about to draw and counts the nodes that are still there when
    // it returns: kept = mutated in place (a row whose words moved is rewritten or re-inserted, never a new node),
    // replaced = the node the reader had is gone.
    if (wrap("syncStreamConsole", (orig) => function (outEl, body, stick) {
      const rows = stamp(rowsIn(outEl));
      const cap = capSel(outEl);
      const h0 = outEl ? outEl.scrollHeight : 0;
      const t0 = outEl ? Math.round(outEl.scrollTop) : 0;
      const r = orig.apply(this, arguments);
      const kept = keptOf(outEl, rows);
      const after = rowsIn(outEl);
      const prose = rows.filter((n) => kindOf(n.dataset.lid) === "prose").length;
      const think = rows.filter((n) => kindOf(n.dataset.lid) === "think").length;
      const b = bucket();
      b.polls += 1;
      b.rowsStamped += rows.length;
      b.rowsKept += kept;
      R.polls.push({
        t: now(), kind: "stream", stamped: rows.length, kept, replaced: rows.length - kept, prose, think,
        rowsAfter: after.length, added: Math.max(0, after.length - kept),
        h0, h1: outEl ? outEl.scrollHeight : 0, top0: t0, top1: outEl ? Math.round(outEl.scrollTop) : 0,
        sel: selSurvived(cap), before: cap ? cap.text.slice(0, 24) : "", drew: Boolean(r),
      });
      return r;
    })) out.push("syncStreamConsole");

    if (wrap("paintThink", (orig) => function (turn) {
      // In 🌊 mode paintThink hands the console to paintStreamConsole; counting here too would count one repaint
      // twice, so the block path only records when it actually replaces the <details>.
      const streaming = typeof streamOn === "function" && streamOn(turn?.thread || turn?.id) && document.querySelector(`pre.job-out[data-out="${turn?.id}"]`);
      if (streaming) return orig.apply(this, arguments);
      const el = document.querySelector(`details.think[data-think-turn="${CSS.escape(String(typeof turnKey === "function" ? turnKey(turn, "") : ""))}"]`);
      const body = el?.querySelector(".think-body");
      const blocks = stamp(rowsIn(body));
      const cap = body ? capSel(body) : null;
      const h0 = body ? body.scrollHeight : 0;
      const top0 = body ? Math.round(body.scrollTop) : 0;
      const r = orig.apply(this, arguments);
      const kept = keptOf(body, blocks);
      const fresh = document.querySelector(`details.think[data-think-turn="${CSS.escape(String(typeof turnKey === "function" ? turnKey(turn, "") : ""))}"]`);
      const bodyNow = fresh?.querySelector(".think-body");
      const b = bucket();
      b.thinkPolls += 1;
      b.thinkBlocksStamped += blocks.length;
      b.thinkBlocksKept += kept;
      R.polls.push({
        t: now(), kind: "think", stamped: blocks.length, kept, replaced: blocks.length - kept,
        detailsReplaced: el && el !== fresh ? 1 : 0,
        rowsAfter: fresh ? document.querySelectorAll(`details.think[data-think-turn="${CSS.escape(String(typeof turnKey === "function" ? turnKey(turn, "") : ""))}"] .think-block`).length : 0,
        added: fresh ? Math.max(0, document.querySelectorAll(`details.think[data-think-turn="${CSS.escape(String(typeof turnKey === "function" ? turnKey(turn, "") : ""))}"] .think-block`).length - kept) : 0,
        h0, h1: bodyNow ? bodyNow.scrollHeight : 0, top0, top1: bodyNow ? Math.round(bodyNow.scrollTop) : 0,
        sel: selSurvived(cap), before: cap ? cap.text.slice(0, 24) : "",
      });
      return r;
    })) out.push("paintThink");

    // The live line path: a growing paragraph keeps its row and has its contents rewritten; a new paragraph appends a
    // row; a line drawn twice would replace one.
    if (wrap("drawJobLine", (orig) => function (evt) {
      const line = (evt && evt.line) || {};
      const lid = line.lid;
      let before = null;
      let outEl = null;
      if (typeof document !== "undefined") {
        outEl = document.querySelector(`pre.job-out[data-out="${evt?.id}"]`);
        before = lid != null && outEl ? outEl.querySelector(`[data-lid="${CSS.escape(String(lid))}"]`) : null;
      }
      const r = orig.apply(this, arguments);
      const after = lid != null && outEl ? document.querySelector(`pre.job-out[data-out="${evt?.id}"] [data-lid="${CSS.escape(String(lid))}"]`) : null;
      const b = bucket();
      b.liveDraws += 1;
      if (before && after && before === after) b.liveInPlace += 1;
      else if (!before && after) b.liveNew += 1;
      else if (before && after && before !== after) b.liveReplaced += 1;
      R.live.push({ t: now(), lid: String(lid ?? ""), kind: line.kind || "", mode: line.mode || "", inPlace: before && after && before === after ? 1 : 0, fresh: !before && after ? 1 : 0, replaced: before && after && before !== after ? 1 : 0 });
      return r;
    })) out.push("drawJobLine");

    // The pacer: every tick rewrites the contents of the rows it names, in place. This is the streaming mutation.
    if (wrap("paintTypedLines", (orig) => function (lids) {
      const b = bucket();
      b.typedPaints += 1;
      b.typedRows += (lids || []).length;
      R.typed.push({ t: now(), n: (lids || []).length });
      return orig.apply(this, arguments);
    })) out.push("paintTypedLines");

    // A whole card rebuilt under the reader (a status flip, a deliverable, an approval). Should not happen for the
    // plain flow this measures; recorded so a run can say whether it did.
    if (wrap("renderConversation", (orig) => function () {
      const t0 = now();
      const r = orig.apply(this, arguments);
      const b = bucket();
      b.cards += 1;
      R.cards.push({ t: t0, ms: Math.round((now() - t0) * 10) / 10 });
      return r;
    })) out.push("renderConversation");

    // The board's own repaint: a snapshot (the 30 s safety net, a reload, a settings change) rebuilds every section,
    // and a live card comes back as a new node with new rows. Recorded so a whole-console replacement can be
    // attributed to the board rather than to the stream.
    if (wrap("applySnapshot", (orig) => function () {
      const t0 = now();
      const rows = document.querySelectorAll("pre.job-out [data-lid]").length;
      const r = orig.apply(this, arguments);
      const b = bucket();
      R.boardSnapshots = R.boardSnapshots || [];
      R.boardSnapshots.push({ t: t0, rowsBefore: rows, rowsAfter: document.querySelectorAll("pre.job-out [data-lid]").length });
      return r;
    })) out.push("applySnapshot");

    // Who scrolled: the page's own helper, so a scrollTop change can be attributed to the panel rather than guessed.
    if (wrap("setScroll", (orig) => function (el, top) {
      if (el) {
        const key = el.matches?.("pre.job-out") ? "console" : el.classList?.contains("think-body") ? "think" : "other";
        lastSetScroll.set(key, now());
      }
      return orig.apply(this, arguments);
    })) out.push("setScroll");

    return out;
  };
}

// ---- running one capture ------------------------------------------------------------------------------------------
function loadPlaywright() {
  for (const root of [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd(), process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : ""].filter(Boolean)) {
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

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function capture() {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
    process.exit(0);
  }
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(path.join(SCRATCH, "jitter-"));
  const repo = path.join(dir, "repo");
  const empty = path.join(dir, "empty-root");
  mkdirSync(repo, { recursive: true });
  mkdirSync(empty, { recursive: true });
  gitIt(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n");
  gitIt(repo, ["add", "."]);
  gitIt(repo, ["commit", "-q", "-m", "first"]);
  seedStore(dir);

  const script = buildScript();
  const writer = makeReasoningWriter(dir);
  const marks = [];
  let pageRef = null;
  const mark = async (name) => {
    if (!pageRef) return;
    try {
      const t = await pageRef.evaluate((n) => window.__probe.mark(n), name);
      marks.push({ name, t });
      console.log(`   mark ${name} @ ${Math.round(t)}ms`);
    } catch {
      /* the page may be gone */
    }
  };
  const phases = {
    quiesce: () => {
      writer.stop();
    },
    pause: async () => {
      writer.stop();
      await mark("pause");
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
  const panel = await startPanel({
    dir,
    keep: false,
    config: {
      scanRoots: [empty],
      refreshSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: repo,
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
    env: { API_SERVER_KEY: "" },
  });

  const profile = path.join(SCRATCH, `profile-${MODE}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const ctx = await pw.chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1280, height: 1000 } });
  const out = { mode: MODE, label: LABEL, commit: gitCommit(), at: new Date().toISOString(), marks: [], checks: [], errors: [] };
  try {
    await ctx.addInitScript(pageInit, { thread: THREAD, mode: MODE });
    const page = await ctx.newPage();
    pageRef = page;
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e)));
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
    out.instrumented = await page.evaluate(() => window.__instrument());
    const post = async (route, body) => {
      const r = await fetch(`${panel.base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    await page.evaluate(() => window.__probe.arm());
    const spawned = await post("/api/agents", { prompt: "probe: stream a long reply and think while you do it", cwd: repo, existing: true, thread: THREAD });
    if (!spawned.json || !spawned.json.job) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
    const job = spawned.json.job;
    out.job = job.id;
    writer.start();
    await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 20000 });
    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`).scrollIntoView({ block: "center" }), THREAD);
    await mark("start");
    // The card has to be big enough on screen for "what the reader sees" to mean anything: the console is 230px and
    // the block sits above it, so a 1000px window holds both with the transcript between them.
    await sleep(FLOW1 + PAUSE + FLOW2 + SETTLE + 1500);
    await mark("end");
    out.R = await page.evaluate(() => window.__probe.dump());
    out.marks = marks;
    out.timings = { flow1: FLOW1, pause: PAUSE, flow2: FLOW2, settle: SETTLE };
    out.reasoningRows = writer.state.rows.length;
  } finally {
    writer.stop();
    await ctx.close().catch(() => {});
    await panel.stop().catch(() => {});
    await gw.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
  }
  return out;
}

function gitIt(cwd, a) {
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...a], { cwd, stdio: "pipe" });
}

// ---- reading the evidence ----------------------------------------------------------------------------------------
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.floor(s.length / 2)];
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function windowsOf(cap) {
  const m = new Map(cap.R.marks.map((x) => [x.name, x.t]));
  const need = ["start", "pause", "flow2", "done"];
  const last = cap.R.marks.filter((x) => x.name === "end").pop();
  const top = Math.max(...cap.R.buckets.map((b) => b.s)) * 1000 + 999;
  if (need.some((n) => !m.has(n))) return null;
  return [
    { name: "flowing (first)", from: m.get("start"), to: m.get("pause") },
    { name: "paused", from: m.get("pause"), to: m.get("flow2") },
    { name: "flowing (second)", from: m.get("flow2"), to: m.get("done") },
    { name: "settling", from: m.get("done"), to: last ? last.t : top },
  ];
}

function summarise(cap) {
  const wins = windowsOf(cap) || [];
  const buckets = new Map(cap.R.buckets.map((b) => [b.s, b]));
  const rows = [];
  for (const w of wins) {
    const fromS = Math.floor(w.from / 1000) + 1;
    const toS = Math.floor(w.to / 1000) - 1;
    const bs = [];
    for (let s = fromS; s <= toS; s++) if (buckets.has(s)) bs.push(buckets.get(s));
    const n = bs.length;
    const per = (k) => sum(bs.map((b) => b[k] || 0));
    const perMed = (k) => med(bs.map((b) => b[k] || 0));
    const polls = cap.R.polls.filter((p) => p.t >= w.from && p.t <= w.to);
    const sels = cap.R.sel.filter((p) => p.t >= w.from && p.t <= w.to);
    const lost = sels.filter((p) => p.event === "lost");
    const heldBy = (kind) => {
      const xs = lost.filter((p) => p.kind === kind).map((p) => p.held);
      return xs.length ? med(xs) : null;
    };
    const frameDelays = cap.R.frames.filter((f) => f[0] >= w.from && f[0] <= w.to).map((f) => f[1]);
    rows.push({
      window: w.name,
      seconds: n,
      mutPerSec: r1(per("mut") / Math.max(1, n)),
      consoleMutPerSec: r1(per("mutCon") / Math.max(1, n)),
      proseAddPerSec: r1(per("addProse") / Math.max(1, n)),
      proseNewPerSec: r1((per("addProse") - per("repProse")) / Math.max(1, n)),
      proseReplacedPerSec: r1(per("repProse") / Math.max(1, n)),
      proseInPlacePerSec: r1(per("inPlaceProse") / Math.max(1, n)),
      thinkAddPerSec: r1(per("addThink") / Math.max(1, n)),
      thinkNewPerSec: r1((per("addThink") - per("repThink")) / Math.max(1, n)),
      thinkReplacedPerSec: r1(per("repThink") / Math.max(1, n)),
      thinkInPlacePerSec: r1(per("inPlaceThink") / Math.max(1, n)),
      pollsPerSec: r1(polls.length / Math.max(1, n)),
      rowsInsertedPerSec: r1(polls.reduce((a, p) => a + (p.added || 0), 0) / Math.max(1, n)),
      rowsStampedPerPoll: polls.length ? r1(sum(polls.map((p) => p.stamped)) / polls.length) : null,
      rowsKeptPerPoll: polls.length ? r1(sum(polls.map((p) => p.kept)) / polls.length) : null,
      rowsReplacedPerPoll: polls.length ? r1(sum(polls.map((p) => p.replaced)) / polls.length) : null,
      pollSelLosses: polls.filter((p) => p.sel === false).length,
      pollSelChecks: polls.filter((p) => p.sel != null).length,
      liveNewPerSec: r1(per("liveNew") / Math.max(1, n)),
      liveInPlacePerSec: r1(per("liveInPlace") / Math.max(1, n)),
      liveReplacedPerSec: r1(per("liveReplaced") / Math.max(1, n)),
      typedPaintsPerSec: r1(per("typedPaints") / Math.max(1, n)),
      typedRowsPerSec: r1(per("typedRows") / Math.max(1, n)),
      cardRebuilds: per("cards"),
      scrollChangesPerSec: r1(per("scrollChanges") / Math.max(1, n)),
      scrollUpPerSec: r1(per("scrollUp") / Math.max(1, n)),
      scrollFollowPerSec: r1(per("scrollFollow") / Math.max(1, n)),
      scrollOtherPerSec: r1(per("scrollOther") / Math.max(1, n)),
      gapMed: med(bs.map((b) => (b.gapSamples ? Math.round(b.gapSum / b.gapSamples) : 0))),
      gapMax: Math.max(0, ...bs.map((b) => b.gapMax || 0)),
      selChecks: per("selChecks"),
      selLosses: per("selLosses"),
      selArms: sels.filter((p) => p.event === "arm").length,
      selSurvived: sels.filter((p) => p.event === "survived").length,
      heldGrowing: heldBy("growing"),
      heldReasoning: heldBy("reasoning"),
      heldSettled: heldBy("settled"),
      conRows: med(bs.map((b) => b.conRows || 0)),
      conScrollH: med(bs.map((b) => b.conScrollH || 0)),
      conClientH: med(bs.map((b) => b.conClientH || 0)),
      staleMax: Math.max(0, ...bs.map((b) => b.staleMs || 0)),
      boardResyncs: (cap.R.boardSnapshots || []).filter((x) => x.t >= w.from && x.t <= w.to).length,
      fps: n ? r1(per("frames") / n) : null,
      frameP50: pct(frameDelays, 0.5),
      frameP95: pct(frameDelays, 0.95),
      frameMax: frameDelays.length ? Math.max(...frameDelays) : null,
      framesOver33: frameDelays.filter((x) => x > 33).length,
      framesOver50: frameDelays.filter((x) => x > 50).length,
      longtasks: per("longtasks"),
      longtaskMs: Math.round(per("longtaskMs")),
      snapKeptPerSec: r1(per("snapKept") / Math.max(1, n)),
      snapSwappedPerSec: r1(per("snapSwapped") / Math.max(1, n)),
    });
  }
  return rows;
}

function mdTable(rows) {
  const head = ["window", "s", "mut/s", "console mut/s", "prose new/s", "prose repl/s", "prose in-place/s", "reason new/s", "reason repl/s", "reason in-place/s", "polls/s", "rows kept/poll", "rows repl/poll", "sel arms", "sel lost", "held growing/reasoning/settled ms", "scroll chg/s", "up/s", "follow/s", "console rows", "console h", "stale s", "board resyncs", "fps", "p95 ms", ">50ms", "long tasks"];
  const key = ["window", "seconds", "mutPerSec", "consoleMutPerSec", "proseNewPerSec", "proseReplacedPerSec", "proseInPlacePerSec", "thinkNewPerSec", "thinkReplacedPerSec", "thinkInPlacePerSec", "pollsPerSec", "rowsKeptPerPoll", "rowsReplacedPerPoll", "selArms", "selLosses", "held", "scrollChangesPerSec", "scrollUpPerSec", "scrollFollowPerSec", "conRows", "conScrollH", "staleMax", "boardResyncs", "fps", "frameP95", "framesOver50", "longtasks"];
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const r of rows) {
    const v = (k) => (k === "held" ? `${r.heldGrowing ?? "—"}/${r.heldReasoning ?? "—"}/${r.heldSettled ?? "—"}` : r[k] == null ? "—" : r[k]);
    lines.push(`| ${key.map(v).join(" | ")} |`);
  }
  return lines.join("\n");
}

// ---- main --------------------------------------------------------------------------------------------------------
const cap = await capture();
const rows = summarise(cap);
mkdirSync(REPORT, { recursive: true });
const jsonPath = path.join(REPORT, `jitter-streaming-${LABEL}.json`);
writeFileSync(jsonPath, JSON.stringify({ ...cap, summary: rows }, null, 2));
console.log(`\n== ${MODE} (${LABEL}) on ${cap.commit}: ${cap.R.buckets.length} seconds, ${cap.reasoningRows} reasoning rows written`);
console.log(`   instrumented: ${JSON.stringify(cap.instrumented)}`);
console.log(`   page errors: ${cap.errors.length}`);
console.log(mdTable(rows));
console.log(`\n   capture: ${jsonPath}`);
if (MD) {
  writeFileSync(MD, `${mdTable(rows)}\n`);
  console.log(`   markdown: ${MD}`);
}
