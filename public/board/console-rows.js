// Cut 3 of four for public/board/console.js, card 9 of docs/reports/module-separation-2026-11-28.html's split plan.
// The plan named 2,277-3,699 for this cut; 3,699 is inside settleScrolls on this base, so the boundary is 3,690, the
// blank line after setScroll, and the frame's second pass (settleScrolls) travels with cut 4. A classic script, loaded
// by public/index.html after /board/console.js and before app.js.
//
// WHAT MOVED, BYTE FOR BYTE: the console writers (consoleHeld, wireConsole), the board's consoles without walking the
// board (placedNodes, consoleOuts), the rows a console holds by line id, the marching tail, the typing and stream
// speed controls, thinking reconciliation, the patch-a-piece family, the copy buttons and their observer, the motion
// that is paused off screen, the folded command card's marks, the reader's own input per card, and the scroll record
// setScroll writes.
//
// The page's own globals are unchanged. Every top-level `function` here is a `window` property under its own name, and
// every top-level `const`/`let` a binding in the one global lexical environment console.js and app.js read, so not one
// call site changes: the names console.js no longer declares are still page globals, declared here.

// ---- console writers
// How a write reaches a console, and what a console owns.
//
//   * A row is addressed through the console of the JOB that owns the line — never by a document-wide
//     `[data-lid]` query. Line ids are one server sequence, not a page-wide key: a card the board adopted from
//     another panel process can carry the same numbers, and a global lookup then writes one agent's line into
//     another agent's console. Three agents at once is where that stops being theoretical.
//   * Following the newest line never measures the page inside a write. A console remembers whether the reader is at
//     its bottom (set once when it is first seen, then updated only by its own scroll events), and a stick is one
//     scrollTop write, batched to at most one per console per animation frame. Reading scrollHeight per row per tick
//     lays the whole board out again for every line of every agent, which is what made one agent's output stutter
//     the others.
// Is a live corner gesture holding this console? `public/app.js` owns the gesture and declares `outDragging`; asked by
// bare name and defensively, because this script is loaded before app.js and the unit benches evaluate it without the
// page's gesture at all. While a gesture runs the box belongs to the reader's pointer: nothing may re-pin its line,
// rebuild its text, or replace it, or the corner they are holding walks away from them.
function consoleHeld(out) {
  return typeof outDragging === "function" && outDragging(out);
}

function wireConsole(el) {
  if (!el || el._wired) return el;
  el._wired = true;
  // The growth counter the follow path reads (see grew): a console placed with content already in it has grown at
  // least once, and every writer after this bumps it.
  if (el._grow == null) el._grow = 0;
  // The empty console's placeholder, held by reference: the append path removes it once, and asking the selector
  // engine for a row that stops existing on the first line was 12318 matcher evaluations in one 24 s window.
  if (typeof el.querySelector === "function") el._wait = el.querySelector(":scope > [data-wait]");
  // The one resize target a command card needs (see cmdFoldResize): the console it is drawn in. Asked by typeof
  // because this function is evaluated on its own, with no ResizeObserver in scope, by test/console-tail-pin.test.js.
  if (typeof cmdFoldResize === "object" && cmdFoldResize && typeof el.tagName === "string") cmdFoldResize.observe(el);
  // "Following" is the last line itself, not a band around it. Forty px of tolerance read as generous, but one row of
  // a long turn is taller than that: a reader who nudged up to read the newest line was still "at the bottom" to the
  // page and every paint path re-anchored them on the next line (measured on 0.46.0: 42 moves / +850 px in 30 s on a
  // console parked 24 px up, against 0 px at 296 px). Two px is a scroll landing on the end, not a reader in the band.
  el._atBottom = el._selfTop == null ? true : el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
  el.addEventListener(
    "scroll",
    () => {
      // Every scroll is measured, the panel's own included. A restore puts the reader back where its record says, and
      // that is the bottom only when the record says so: assuming "the panel wrote it, so it is following" pinned a
      // console the reader had been handed back to the middle of (applyStoredScrolls writes atBottom:false). One
      // scroll event is a gesture or a rebuild, not a row, so the layout read this costs is the one the per-row
      // paints were paying for.
      el._atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    },
    { passive: true },
  );
  // A console that arrives already in the reader's raw view (or with focus on) is drawn that way once, here: the
  // state is the page's, so a repaint may replace the node but never the reader's choice. Called guardedly because
  // this function is READ OUT of the page on its own by test/console-tail-pin.test.js (a vm over the source): a
  // bare call to a second function would make that region depend on a third, which is not what it is testing.
  if (typeof paintConsoleModes === "function") paintConsoleModes(el);
  return el;
}

// ---- the board's consoles, without walking the board ----------------------------------------------------------
// Six paths want every console of one kind on the page, and each asked the whole document for them every time:
// - the typing stream on every tick (paintTypedLines -> consoleOuts);
// - every streamed line (drawJobLine);
// - every stream repaint (paintStreamConsole);
// - the 400 ms sweep, twice over (consoles and subagent consoles).
// On the reader's board each of those is a walk of a 55k-node page to find a few dozen nodes. A console only arrives by
// being placed, so a node observer of their own notes each one as it lands. A lookup returns the noted ones still in
// the page, still of that kind, in document order: the same list the walk returned. It must be its own observer and
// not the copy observer's queue. A lookup first takes the records still waiting for it, so a console placed earlier in
// this same task is counted; taking the copy observer's records would run the copy buttons' mount in the middle of a
// paint. Before the watch is set up (placedNodes.watch, beside the copy observer) a lookup is the walk it replaces.
// What it cannot see is a node that TAKES one of these classes after it was placed; nothing in this file does that
// (no classList.add / className write names job-out, sub-console, detail, tgrp or queue-ago, and nothing
// sets data-q-clock or data-detail on a placed node), and test/placed-nodes.test.js holds the lookup to the walk's
// answer through every way a node does arrive and leave.
function placedNodes(sel) {
  const w = placedNodes.watch;
  const set = w && w.sets.get(sel);
  if (!set) return [...document.querySelectorAll(sel)];
  for (const r of w.mo.takeRecords()) for (const n of r.addedNodes) notePlaced(w, n);
  const out = [];
  for (const el of set) {
    if (!el.isConnected) set.delete(el);
    else if (el.matches(sel)) out.push(el);
  }
  return out.length > 1 ? out.sort(byDocumentOrder) : out;
}

function notePlaced(w, node) {
  if (!node || node.nodeType !== 1) return;
  for (const [sel, set] of w.sets) if (node.matches(sel)) set.add(node);
  if (!node.firstElementChild) return;
  for (const el of node.querySelectorAll(w.any)) for (const [sel, set] of w.sets) if (el.matches(sel)) set.add(el);
}

function byDocumentOrder(a, b) {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

// One scan per paint: every console on the board, grouped by the job it draws (a pinned copy is its job's too).
function consoleOuts() {
  const byJob = new Map();
  for (const el of placedNodes("pre.job-out")) {
    const id = el.dataset.out || "";
    const job = id.endsWith("@pin") ? id.slice(0, -4) : id;
    let list = byJob.get(job);
    if (!list) byJob.set(job, (list = []));
    list.push(wireConsole(el));
  }
  return byJob;
}

const stickPending = new Set();
let stickFrame = 0;

// This console's content changed, by one line or by one character. It is the ONLY thing the follow path needs to
// know: a console whose counter has not moved cannot have grown, so the height it would read is the height it has
// already put the reader on, and the read (which lays the whole box out before it can answer) is skipped. Bumped by
// every writer - the append path, the typed stream, a stream repaint, a raw repaint - and by nothing else.
//
// The card's session scroller is marked with it too: it grows whenever the console inside it does, and its own frame
// read has the same reason to be skipped.
function grew(out) {
  if (!out) return;
  out._grow = (Number(out._grow) || 0) + 1;
  const body = out.closest && out.closest(".job-body");
  if (body) body._grow = (Number(body._grow) || 0) + 1;
}

// ---- the rows a console holds, by line id ---------------------------------------------------------------
// The typed stream and the append path both need the row a line id names, and both used to ask the document with a
// selector: 12318 selector evaluations and 437 ms of the browser's own matcher in one 24 s window. The rows are made
// here, so a console keeps its own index instead - one Map from `data-lid` to the rows carrying it, built once per
// console and kept as rows arrive and leave. A lookup validates what it hands back, so a row a rebuild detached is
// never drawn into.
const lidOf = (el) => (el && el.dataset && el.dataset.lid != null ? String(el.dataset.lid) : "");

function indexLid(map, el) {
  const lid = lidOf(el);
  if (!lid) return;
  const list = map.get(lid);
  if (!list) map.set(lid, [el]);
  else if (!list.includes(el)) list.push(el);
}

function lidIndex(out) {
  let map = out._lidIndex;
  if (!map) {
    map = out._lidIndex = new Map();
    for (const el of out.querySelectorAll("[data-lid]")) indexLid(map, el);
  }
  return map;
}

function lidRows(out, lid) {
  const list = lidIndex(out).get(String(lid));
  if (!list || !list.length) return [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const el = list[i];
    if (!el.isConnected || !out.contains(el)) list.splice(i, 1);
  }
  return list;
}

// A subtree that just joined this console (a row, a markdown block, a tool group) adds its ids to the index.
function indexSubtree(out, el) {
  if (!out || !el || !el.querySelectorAll) return;
  const map = lidIndex(out);
  indexLid(map, el);
  for (const row of el.querySelectorAll("[data-lid]")) indexLid(map, row);
}

// A subtree that is leaving takes its ids with it: an index that still names a detached row finds nothing (validated
// above) but would grow forever.
function unindexSubtree(out, el) {
  const map = out && out._lidIndex;
  if (!map || !el || !el.querySelectorAll) return;
  for (const row of el.querySelectorAll("[data-lid]")) {
    const list = map.get(lidOf(row));
    if (!list) continue;
    const i = list.indexOf(row);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) map.delete(lidOf(row));
  }
}

// Ask for this console to follow its newest line, at most once per frame, and only while the reader is following it.
function stickSoon(el) {
  if (!el || !el.dataset) return;
  // The card's own session scroller follows the same line, and is asked FIRST: in the docked Chat pane the console
  // this call is about cannot scroll at all (it is drawn at its content height), so the body is the only box that has
  // anywhere to move, and it must not depend on the console's own pin to be asked.
  // Called guardedly for the same reason `wireConsole` guards `paintConsoleModes`: this function is READ OUT of the
  // page on its own by test/console-tail-pin.test.js (a vm over the source), and that region must not depend on a
  // third name to answer its own question.
  if (typeof stickCardBodySoon === "function") stickCardBodySoon(el);
  if (!consolePinned(el.dataset.out) && el._atBottom !== true) return;
  stickPending.add(el);
  const flush = () => {
    const batch = [...stickPending];
    stickPending.clear();
    for (const out of batch) {
      if (!out.isConnected) continue;
      if (!consolePinned(out.dataset.out) && out._atBottom !== true) continue;
      // The console's own tail stands down for the same reason the transcript's does: a gesture owns this box, and
      // a scroll written inside it between two moves is the box moving under the hand. Guarded by `typeof` for the
      // same reason stickSoon's body pin is: this region is READ OUT of the page on its own by
      // test/console-tail-pin.test.js (a vm over the source), with no gesture in scope.
      if (typeof consoleHeld === "function" && consoleHeld(out)) continue;
      // Nothing has been added since the last time this console was put on its newest line, so the height it would
      // read is the one it wrote: the frame after every growth is the one that has work, and a call that only asks
      // again (a repaint, a settle pass, the 400 ms repair) costs a comparison instead of a full layout. This is the
      // whole of the measured 661 ms a two-line callback carried: 12757 asks, most of them with nothing new to follow.
      if (out._stuckAt != null && out._stuckAt === out._grow) continue;
      setScroll(out, out.scrollHeight); // one read per console per frame, not one per row
      out._stuckAt = out._grow;
    }
  };
  // A row that lands in a TIMER is in the box at the end of that task, and it is painted in the frame that task belongs
  // to. An animation frame asked for here runs after that paint, so the reader saw the row hanging below the box's
  // bottom edge for one frame before the next frame's stick put it back: measured on a live turn whose rows are released
  // by the order-based hold (public/core/type-stream.js createReasoningHold), 81px below the edge and 81px short of the
  // tail, once per release, against 0.5px before that hold learned to release whole paragraphs late. The microtask below
  // runs at the end of THIS task and before the browser paints, so the frame the row is in is the frame it is corrected
  // in. The rAF stays for whatever grows during rendering, and coalesces the same set: the second of the two flushes
  // finds `_stuckAt` level and costs one comparison.
  if (!el._stickMicro) {
    el._stickMicro = true;
    Promise.resolve().then(() => {
      el._stickMicro = false;
      flush();
    });
  }
  if (stickFrame) return;
  stickFrame = requestAnimationFrame(() => {
    stickFrame = 0;
    flush();
  });
}
// ---- end console writers

// ---- the console's marching tail ---------------------------------------------------------------------------------
// The trailing decoration a LIVE turn's console carries: ". . . . " under its last line, one dot every 500 ms, four
// dots to the cycle (two seconds), and the fourth clears at the right edge of its slot so the row never grows. Any
// new output clears it back to a single dot: the row is the sign of a feed that has gone quiet, so a burst restarts
// its clock.
//
// It is NOT a console line, and that is the whole design. It is a sibling of the pre (render-jobs.js turnBody puts
// it between the console and the console's own tools), so:
//   * it never joins createDrawStream - it is no segment, it is never ordered against one, it is never typed, and
//     nothing here can reorder, restart or scroll the record;
//   * the record's own DOM is never touched, so pre.textContent is the turn's record with no dot in it, at any
//     moment of the march and not only after the turn ends;
//   * the feed's height and scroll are the console's own: the row is one fixed line UNDER the box, and the dot slot
//     is exactly ". . . . " wide (style.css .march-dots), so a step can never reflow the box or move a reader.
// The march is ONE timer (started when a row exists, stopped when none does) that rewrites the row's own text node -
// nodeValue, never textContent, because replacing the text node is a childList mutation and the copy observer wakes
// for those. No frame loop runs and nothing in here reads a box.
//
// Reduced motion: the row holds a static single dot and the word it stands for. The dot is still because the
// panel's ONE existing rule says so (style.css "@media (prefers-reduced-motion: reduce) { .live-pulse .pulse-dot {
// animation: none } }"); this file only decides whether a march starts at all, and adds no media query of its own.
const MARCH_STEP_MS = 500; // one dot every half second
const MARCH_DOTS = 4; // ". . . . " - the slot's own width, so the next step is the clear at that edge
const MARCH_LABEL = "working"; // what a still row says instead of marching

// The reader's own setting, read once and then kept live by the MediaQueryList itself. Not a per-frame or per-paint
// read: it is asked when a row is drawn and when the clock decides what to write.
const marchMotion = (() => {
  let mq;
  return () => {
    if (mq === undefined) {
      try {
        mq = globalThis.matchMedia ? globalThis.matchMedia("(prefers-reduced-motion: reduce)") : null;
      } catch {
        mq = null; // no media support at all: nothing asked for stillness, so the march runs
      }
    }
    return Boolean(mq && mq.matches);
  };
})();

// The dots a row shows `ms` after its last burst: 1 at the arrival, 2 at 500 ms, 3 at 1000, 4 at 1500, and 1 again
// at 2000. The cycle IS four steps of 500 ms, so two seconds is the whole march - and a step is a function of the
// clock, never of how often a timer happened to fire.
function marchDotsAt(from, now) {
  const steps = Math.floor(Math.max(0, Number(now) - Number(from)) / MARCH_STEP_MS);
  return (steps % MARCH_DOTS) + 1;
}

// ". . . . " with ONE space between dots and the slot's trailing space, so every step is the same 8 characters wide
// and the fourth dot's step clears back to the first.
function marchText(dots) {
  const n = Math.min(MARCH_DOTS, Math.max(1, Math.round(Number(dots) || 1)));
  return `${Array(n).fill(".").join(" ")} `;
}

// One entry per turn with a row drawn: when its last burst arrived, and the dot count currently written.
function marchEntry(id, now) {
  if (!state.march) state.march = new Map();
  let m = state.march.get(id);
  if (!m) {
    m = { at: Number(now) || Date.now(), dots: 1 };
    state.march.set(id, m);
  }
  return m;
}

// Every row on the page, read from the consoles that carry one: the row IS the console's next sibling, which is
// where turnBody puts it. A pinned turn draws its own copy, and both march on the same clock and the same count.
function marchRows() {
  const rows = [];
  for (const out of placedNodes("pre.job-out")) {
    const row = out.nextElementSibling;
    if (row && row.dataset && row.dataset.march) rows.push(row);
  }
  return rows;
}

// ONLY the decoration's own text node. nodeValue on the node the row was parsed with: assigning textContent would
// replace that node, and a replaced child is a childList mutation the page's copy observer wakes for.
function marchWrite(row, dots) {
  const el = row.querySelector(".march-dots");
  if (!el) return;
  const text = marchText(dots);
  let node = el._marchText;
  if (!node || node.parentNode !== el) {
    node = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : el.appendChild(document.createTextNode(""));
    el._marchText = node;
  }
  if (node.nodeValue !== text) node.nodeValue = text;
}

let marchTimer = 0;

function marchStart() {
  if (marchTimer || marchMotion()) return; // a still row has nothing to march
  marchTimer = setInterval(() => {
    if (!document.hidden) marchAdvance(Date.now()); // a hidden tab has no reader to show a dot to
  }, MARCH_STEP_MS);
}

function marchStop() {
  if (!marchTimer) return;
  clearInterval(marchTimer);
  marchTimer = 0;
}

// The row a live turn's console carries, or "" - the ONE place it is drawn. The count is the turn's own state, so a
// repaint of the card (a poll, a rail resize, a focus toggle) draws the march where it had got to, never from one dot.
function marchRowHtml(turn) {
  if (!turnLive(turn)) return ""; // done reads done: the row is not drawn at all
  const id = String(turn.id ?? "");
  if (!id) return "";
  const now = Date.now();
  const m = marchEntry(id, now);
  const still = marchMotion();
  m.dots = still ? 1 : marchDotsAt(m.at, now);
  marchStart();
  const title = still
    ? "this turn is still running - motion is held still here (this system asks for reduced motion), so the row does not march"
    : "this turn is still running - the dots mark a feed that has gone quiet: one every 0.5 s, cleared to one dot whenever output arrives";
  return `<span class="live-pulse is-stream march${still ? " is-still" : ""}" data-march="${esc(id)}" title="${esc(title)}"><span class="pulse-dot" aria-hidden="true"></span><span class="march-dots">${marchText(m.dots)}</span><span class="march-label">${MARCH_LABEL}</span></span>`;
}

// New output: back to a single dot, now, and the march's clock restarts from this line.
function marchReset(id) {
  const key = String(id ?? "");
  const m = state.march && state.march.get(key);
  if (!m) return; // no row was ever drawn for this turn: nothing to clear
  m.at = Date.now();
  m.dots = 1;
  for (const row of marchRows()) if (row.dataset.march === key) marchWrite(row, 1);
  marchStart();
}

// One tick: advance every row that has come due. A row whose turn has stopped marching is ended here too, so a card
// that settles without a job event still loses its dots within the half second rather than at the next repaint.
function marchAdvance(now) {
  const rows = marchRows();
  if (!rows.length || !state.march) {
    marchStop();
    return;
  }
  const still = marchMotion();
  for (const row of rows) {
    const key = row.dataset.march;
    const turn = state.jobs && state.jobs.get(key);
    if (turn && !turnLive(turn)) {
      marchEnd(key);
      continue;
    }
    const m = state.march && state.march.get(key);
    if (!m) continue;
    const dots = still ? 1 : marchDotsAt(m.at, now);
    if (m.dots === dots) continue;
    m.dots = dots;
    marchWrite(row, dots);
  }
  // A count whose row and turn are both gone (a cleared card, a turn the board dropped) is pruned here: the map is
  // keyed by turn, and a card that never reports its end is the one way an entry could outlive it.
  const seen = new Set(rows.map((r) => r.dataset.march));
  for (const key of [...state.march.keys()]) {
    if (seen.has(key)) continue;
    const turn = state.jobs && state.jobs.get(key);
    if (!turn || !turnLive(turn)) state.march.delete(key);
  }
}

// The turn reads done: the row goes at once - both copies of it - and its count with it, so no dot is left on the
// card or anywhere near the record.
function marchEnd(id) {
  const key = String(id ?? "");
  if (state.march) state.march.delete(key);
  for (const row of document.querySelectorAll(`[data-march="${CSS.escape(key)}"]`)) row.remove();
  if (!marchRows().length) marchStop();
}
// ---- end the console's marching tail

// The ONE writer. The stream says which segments grew; every pane carrying one gets the new prefix (a pinned turn
// draws its own copy, so the same line can be in two consoles at once).
//
// What it draws is the stream's own watermark for the segment (`shownFor` hands back `text.slice(0, shown)`), never
// a number derived from the DOM. A row a repaint has just rebuilt therefore asks for exactly the characters that had
// been emitted before the row disappeared, and typing carries on at that character; `drawRowText` appends the tail
// to the row's own text node when the new text extends what is drawn, so no tick re-writes a character already on
// screen and no ancestor repaint can take one back.
function paintTypedLines(keys) {
  const P = state.typeStream;
  if (!P) return;
  const byJob = consoleOuts();
  for (const lid of keys) {
    const outs = byJob.get(String(P.jobFor(lid) ?? ""));
    if (!outs || !outs.length) continue;
    for (const out of outs) {
      // A reasoning row types inside its thinking block, which follows its own stickiness, not the console's.
      for (const el of lidRows(out, lid)) {
        // The row's own record goes with the question, so a paint can never shorten a line to a prefix the stream has
        // stopped growing (see typedShown): the worst a stale tick can do is nothing. A row with no record of its own
        // (a reasoning row) asks with nothing.
        const rec = el.dataset.ltext;
        const shown = rec == null ? P.shownFor(lid) : P.shownFor(lid, rec);
        // `null` is the stream saying it has stopped answering for this line: its record has moved past what the wire
        // last carried, so the prefix on screen is not the line any more. Skipping the row there left a settled turn
        // drawn at its own top - the rest of the answer never reached the DOM, the console had nothing to scroll, and
        // the card's `done` sat under a reply that was cut. A row with a record draws that record whole instead.
        if (shown == null) {
          if (rec == null) continue;
          if (!drawRowText(el, rec)) continue;
        } else if (!drawRowText(el, shown)) continue;
        grew(out);
        stickSoon(out);
      }
    }
  }
}

// The turn is over: nothing may be left waiting in either buffer, and the last of a paragraph's words are released
// rather than left to a clock that has nothing more to say.
function flushTypeStream(job) {
  state.typeHold?.drain(String(job ?? ""));
  state.typeGate?.drain(String(job ?? ""));
  state.typeStream?.flushJob(String(job ?? ""));
}

function paintStreamSpeed() {
  const w = typeWordSpeed();
  const l = typeLineRate();
  const words = $("stream-words");
  if (words && document.activeElement !== words) words.value = String(w);
  const lines = $("stream-lines");
  if (lines && document.activeElement !== lines) lines.value = String(l);
  // The preset the stored value lands on is lit, so the row says what it is without reading the number back.
  for (const b of document.querySelectorAll("[data-stream-words-set]")) {
    b.classList.toggle("on", Number(b.dataset.streamWordsSet) === w);
  }
  for (const b of document.querySelectorAll("[data-stream-lines-set]")) {
    b.classList.toggle("on", Number(b.dataset.streamLinesSet) === l);
  }
  const preview = $("stream-preview");
  if (!preview) return;
  preview.textContent =
    !w && !l
      ? "output arrives exactly as the run sent it — both off"
      : `${w ? `words type at ${w}/s` : "words appear as they arrive"} · ${l ? `new lines walk in at ${l}/s` : "new lines appear at once"}`;
}

function saveTypeWords(value) {
  const n = globalThis.wtType ? globalThis.wtType.clampWords(value) : 0;
  state.typeStream?.setRate(n);
  try {
    localStorage.setItem(TYPE_WORDS_KEY, String(n));
  } catch {
    /* private mode: the choice just will not persist */
  }
  paintStreamSpeed();
}

function saveTypeLines(value) {
  const n = globalThis.wtType ? globalThis.wtType.clampLines(value) : 0;
  state.typeGate?.setRate(n);
  try {
    localStorage.setItem(TYPE_LINES_KEY, String(n));
  } catch {
    /* private mode: the choice just will not persist */
  }
  paintStreamSpeed();
}

// A read that BEGINS after this call. loadThinking drops a request while one is in flight (the poll must not stack up),
// but an answer already on its way may have been asked for before the store held the reply the caller is waiting on,
// so this waits that one out and then asks again. Resolves once the answer is painted — which is also when the stream
// has been handed any new thought, so a caller that looks at the stream afterwards sees it.
async function loadThinkingAfter(turn) {
  const until = Date.now() + REASONING_READ_WAIT_MS;
  while (state.thinkLoading.has(turn.id) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  await loadThinking(turn);
}

// One turn's thoughts, from the store, bounded by the turn's own clock.
//
// The session the STORE is read under is the turn's own Hermes session, never the card's thread. A worker run is
// started with the thread as its session, so the two are the same string there; an assistant's turns run under a
// session the gateway named from the prompt, so asking the store for `panel-assistant-5` answers "nothing recorded"
// while that turn's own session holds its blocks. That is what made only the one assistant whose session matched its
// thread show any reasoning at all.
//
// Visibility is a different question with a different answer (see `streamBodyHtml`): the 🧠 switch belongs to the CARD.
function thinkingSessionFor(turn) {
  return String(turn?.sessionId || turn?.thread || turn?.id || "");
}

// ---- reconcile thinking ----
// Two writers describe the same thought, and they do not agree about how many pieces it has: the store keeps ONE
// block per ASSISTANT MESSAGE, while the live stream draws ONE ROW per SEGMENT, cut at every tool boundary (row
// #276). So a store block is the CONCATENATION of its segments' texts, and a preview row's words are a SLICE of it.
//
// The match is by TEXT, never by count. Matching from the tail by position was wrong the moment the two lists had
// different lengths, which is every live turn: a block already written but not yet drawn (the store ahead of the
// page) shifted every row onto its neighbour's words, and a preview with no partner was DROPPED - and a preview the
// cache no longer holds is still on screen, so the next delta rebuilt that row from the delta alone
// (growLiveThought) and it lost every word it had already drawn. That is row #285: a row that began mid-sentence
// with the block's own first words missing. The counterweight to the old rule is why it was written - a tab that
// joined late holds only the newest thoughts - and a slice match answers that too: the row is found by its own text
// (or its tail, when it attached mid-block), wherever in the store's list it belongs.
//
// A row that cannot be placed keeps exactly what it already shows. Nothing is dropped, nothing is handed a
// neighbour's words, and no row is ever rewritten shorter than what it drew.
function reconcileThinking(prev, fresh, settled = false) {
  const previews = (prev || []).filter((b) => b && b.preview);
  if (!fresh.length) return prev; // an empty or failed read is not "nothing was thought"
  if (!previews.length || settled) return fresh;
  const out = [];
  let bi = 0; // the store's blocks are consumed in order, and the cursor inside one only moves forward
  let cursor = 0;
  for (let i = 0; i < previews.length; i++) {
    const p = previews[i];
    const own = String(p.text ?? "");
    if (!own) {
      out.push(p);
      continue;
    }
    let hit = null;
    for (let k = bi; k < fresh.length && !hit; k++) {
      const t = String(fresh[k].text ?? "");
      const from = k === bi ? cursor : 0;
      let at = t.indexOf(own, from);
      // A row that attached mid-block holds the block's TAIL, not its start, so it is placed by that tail.
      if (at < 0 && own.length >= 24) {
        const tail = own.slice(-64);
        const j = t.indexOf(tail, from);
        if (j >= 0) at = j - (own.length - tail.length);
      }
      if (at >= 0) hit = { k, at, text: t };
    }
    if (!hit) {
      out.push(p); // no block carries these words (yet): the row keeps them
      continue;
    }
    // The row's slice runs to where the NEXT row's words begin in the same block, otherwise to the block's end -
    // so two rows of one message never overlap, and together they spell the store's block exactly.
    let end = hit.text.length;
    const nextOwn = String(previews[i + 1]?.text ?? "");
    if (nextOwn) {
      const n = hit.text.indexOf(nextOwn, hit.at + own.length);
      if (n >= 0) end = n;
    }
    bi = hit.k;
    cursor = end;
    const slice = hit.text.slice(Math.max(0, hit.at), end);
    out.push({ ...p, text: slice || own, preview: true });
  }
  return out;
}
// ---- end reconcile thinking ----

// Take the live preview rows out of the console record. The store's blocks are merged by `at` on the next
// paint, so the settled console shows each thought once, in the order the record placed it.
function dropThoughtPreviews(turn) {
  const buf = state.jobLines.get(turn.id);
  if (!buf) return;
  const keep = buf.filter((l) => !(l && l.preview && l.kind === "think"));
  if (keep.length !== buf.length) state.jobLines.set(turn.id, keep);
}

// A store read changes ROWS of the console, so the console is what is repainted. The version bump is the
// repaint's licence: paintStreamConsole skips a console whose own appends have drawn the current record, and
// a store read is not an append.
function repaintThoughts(turn) {
  if (!state.jobLineVersion) state.jobLineVersion = new Map();
  state.jobLineVersion.set(turn.id, (state.jobLineVersion.get(turn.id) || 0) + 1);
  paintStreamConsole(turn, "");
  if (document.querySelector(`pre.job-out[data-out="${CSS.escape(turn.id)}@pin"]`)) paintStreamConsole(turn, "@pin");
}

async function loadThinking(turn) {
  if (state.thinkLoading.has(turn.id)) return;
  state.thinkLoading.add(turn.id);
  const prev = state.thinkCache.get(turn.id)?.blocks || [];
  const live = turnLive(turn);
  // The console keeps what it has unless a read it can TRUST says otherwise: a failed read, or an empty answer
  // while the turn still runs, must not blank rows and refill them on the next poll.
  let blocks = prev;
  let adopted = false;
  try {
    // Bounded by the turn's own clock, which stops where the next turn began (an interrupted turn has no endedAt).
    const { from, to } = turnBounds(turn);
    const r = await apiFetch(
      `/api/thinking?thread=${encodeURIComponent(thinkingSessionFor(turn))}&from=${from}&to=${to}`,
    );
    if (r.ok) {
      const d = await r.json();
      const fresh = Array.isArray(d.blocks) ? d.blocks : [];
      if (!d.error && fresh.length) {
        blocks = reconcileThinking(prev, fresh, !live);
        adopted = true;
      }
    }
  } catch {
    /* an unreadable store is not worth a banner: the rows just keep what they already show */
  } finally {
    state.thinkLoading.delete(turn.id);
  }
  state.thinkCache.set(turn.id, { blocks, at: Date.now() });
  if (adopted) {
    if (!live) dropThoughtPreviews(turn);
    else syncThoughtRows(turn, blocks.filter((b) => b && b.preview));
    repaintThoughts(turn);
  }
}


function stickSubConsole(box) {
  if (!box || !box.isConnected) return;
  // A child console growing inside a card's session scroller grows the body too (see stickCardBodySoon).
  stickCardBodySoon(box);
  const id = box.dataset.subConsoleBox || "";
  if (state.subConsolePinned.get(id) === false) return;
  const max = box.scrollHeight - box.clientHeight;
  if (max <= 0 || Math.abs(box.scrollTop - max) <= 1) return;
  setScroll(box, max);
}

// In the single-stream mode there is no block to repaint: the blocks are lines of the console itself, so a read that
// lands mid-turn redraws that console, keeping the reader where they were (the same rule as the run's own appends).
//
// The redraw is a PATCH, not a replacement. Written as one `innerHTML` assignment it threw away every row of a live
// console — and the reader's text selection with it — on every reasoning re-read (~1.2 s while a turn runs), leaving
// the scroll to whatever the browser did with a box whose children had just been replaced: the same fault
// `Let a card pick its model, and keep the console still while it runs` cured one level up for the condensed console
// (a fresh <pre> at scrollTop 0, several times a second), still open one renderer down. So: a row whose words did not
// move keeps its NODE, a new row is inserted where it belongs, a row the turn's window has dropped is removed, and
// the reader's place goes back where it was. A body that would drop rows from the MIDDLE or the tail — a failed store
// read, a shorter answer mid-turn — draws nothing at all, the same rule `loadThinking` follows for the blocks it has.
const streamRowKey = (n) => {
  const lid = n?.dataset?.lid;
  if (lid) return `l:${lid}`;
  const grp = n?.dataset?.tgrp;
  return grp ? `g:${grp}` : "";
};

// ---- patch a piece, never replace it -----------------------------------------------------------------------
// A repaint asks the same question of every piece: is this the same piece with different words, or a different
// piece? Replacing it throws away every node under it - the clocks that tick, the copy button, the reader's
// selection - and that churn (3660 nodes added, 2179 removed in one 24 s window, 3330 of them inside the console)
// is cause 8. A piece of the same shape in the same place is PATCHED: words and classes move, the node stays. The
// badge fix in section 4 holds only because of this: a clock is one node per row for the life of the row.
//
// Identity is the shape (a tool group, or a row/block and the line ids it draws), never the words. A tool group's
// shape is the run it collects - the tools of its head rows and the keys of its calls - so a group that gained a
// call, or lost one, is a different group and is replaced; the same run with a new clock, a new result or a new
// tally is patched.
function copyData(to, from) {
  if (!to || !from || !to.dataset || !from.dataset) return;
  for (const k of Object.keys(to.dataset)) if (!(k in from.dataset)) delete to.dataset[k];
  for (const [k, v] of Object.entries(from.dataset)) if (to.dataset[k] !== v) to.dataset[k] = v;
}

const pieceIds = (el) => {
  const ids = [];
  if (el?.dataset?.lid != null) ids.push(String(el.dataset.lid));
  for (const row of el?.querySelectorAll ? el.querySelectorAll("[data-lid]") : []) ids.push(String(row.dataset.lid));
  return ids.join("|");
};

const groupShape = (el) => {
  const heads = [...el.querySelectorAll(":scope > .tgrp-head > .tgrp-row")].map((n) => n.dataset.tgrpTool || "");
  const calls = [...el.querySelectorAll("[data-call-key]")].map((n) => n.dataset.callKey || "");
  return `${heads.join(",")}/${calls.join(",")}`;
};

// One clock slot: text and the states it carries, never a node.
function patchClock(row, freshRow) {
  const have = row.querySelector("[data-tgrp-clock]");
  const want = freshRow.querySelector("[data-tgrp-clock]");
  if (!have || !want) return;
  if (have.textContent !== want.textContent) have.textContent = want.textContent;
  if (have.className !== want.className) have.className = want.className;
  copyData(have, want);
}

function patchGroup(have, fresh) {
  copyData(have, fresh);
  if (have.className !== fresh.className) have.className = fresh.className;
  const hRows = [...have.querySelectorAll(":scope > .tgrp-head > .tgrp-row")];
  const fRows = [...fresh.querySelectorAll(":scope > .tgrp-head > .tgrp-row")];
  for (let i = 0; i < hRows.length && i < fRows.length; i += 1) {
    copyData(hRows[i], fRows[i]);
    hRows[i].classList.toggle("is-active", fRows[i].classList.contains("is-active"));
    patchClock(hRows[i], fRows[i]);
  }
  const hCalls = [...have.querySelectorAll(".tgrp-call")];
  const fCalls = [...fresh.querySelectorAll(".tgrp-call")];
  for (let i = 0; i < hCalls.length && i < fCalls.length; i += 1) {
    const h = hCalls[i];
    const f = fCalls[i];
    const hRow = h.querySelector(":scope > .tgrp-row");
    const fRow = f.querySelector(":scope > .tgrp-row");
    if (!hRow || !fRow) return false;
    // A call row's own line does not move once it is on the wire; a drawable that rewrote it is a different row,
    // and the group is replaced rather than half-patched.
    if ((hRow.dataset.ltext || "") !== (fRow.dataset.ltext || "")) return false;
    copyData(hRow, fRow);
    if (hRow.className !== fRow.className) hRow.className = fRow.className;
    if (hRow.getAttribute("aria-expanded") !== fRow.getAttribute("aria-expanded")) {
      hRow.setAttribute("aria-expanded", fRow.getAttribute("aria-expanded") || "false");
    }
    if (hRow.title !== fRow.title) hRow.title = fRow.title;
    patchClock(hRow, fRow);
    // An open box's stored output is written only when what it holds changed; a folded one is not read.
    const hBox = h.querySelector(":scope > .tgrp-out");
    const fBox = f.querySelector(":scope > .tgrp-out");
    if (hBox && fBox) {
      if (hBox.hidden !== fBox.hidden) hBox.hidden = fBox.hidden;
      if (!fBox.hidden && hBox.innerHTML !== fBox.innerHTML) hBox.innerHTML = fBox.innerHTML;
    }
    if (h.classList.contains("is-open") !== f.classList.contains("is-open")) h.classList.toggle("is-open");
  }
  // The tally button and the body's fold are the reader's state, carried by the fresh markup.
  const hMore = have.querySelector(":scope > .tgrp-head > .tgrp-more");
  const fMore = fresh.querySelector(":scope > .tgrp-head > .tgrp-more");
  if (hMore && fMore) {
    if (hMore.className !== fMore.className) hMore.className = fMore.className;
    if (hMore.textContent !== fMore.textContent) hMore.textContent = fMore.textContent;
    if (hMore.title !== fMore.title) hMore.title = fMore.title;
  }
  const hBody = have.querySelector(":scope > .tgrp-body");
  const fBody = fresh.querySelector(":scope > .tgrp-body");
  if (hBody && fBody && hBody.hidden !== fBody.hidden) hBody.hidden = fBody.hidden;
  return true;
}

function patchPiece(have, fresh) {
  if (!have || !fresh || have.nodeName !== fresh.nodeName) return false;
  const grp = Boolean(have.classList && have.classList.contains("tgrp"));
  if (grp !== Boolean(fresh.classList && fresh.classList.contains("tgrp"))) return false;
  if (grp) {
    if (groupShape(have) !== groupShape(fresh)) return false;
    return patchGroup(have, fresh);
  }
  if (pieceIds(have) !== pieceIds(fresh)) return false;
  copyData(have, fresh);
  if (have.className !== fresh.className) have.className = fresh.className;
  const hText = have.dataset ? have.dataset.ltext : null;
  const fText = fresh.dataset ? fresh.dataset.ltext : null;
  if (hText != null && fText != null && hText !== fText) drawRowText(have, fText);
  else if (fresh.firstElementChild && have.innerHTML !== fresh.innerHTML) {
    have.innerHTML = fresh.innerHTML;
    // A command card's body was just re-written: the three dots went with the children they ended, and the cache that
    // said the card was marked no longer describes what is on screen. Mark it again on this frame's own schedule.
    const cards = have.classList.contains("is-cmd") ? [have] : have.querySelectorAll(".code-box.is-cmd");
    for (const box of cards) {
      clearCommandFoldMark(box);
      scheduleCommandFoldMark(box);
    }
  }
  return true;
}

function syncStreamConsole(out, body, stick) {
  // A live corner gesture holds this box: a patch is a rebuild of the text under the pointer, and the reader is sizing
  // the box, not reading it. What it would have drawn arrives on the release (the gesture asks for one repaint).
  if (globalThis.consoleHeld?.(out)) return false;
  const holder = document.createElement("div");
  holder.innerHTML = body;
  const next = [...holder.children];
  const before = [...out.children];
  // Where the reader is: the first row with any part of itself inside the box, and how far into the box it starts.
  // A poll that grows a row above it must not slide the reader's line down the box.
  const keep = (() => {
    if (stick) return null;
    const box = out.getBoundingClientRect();
    for (const n of before) {
      const r = n.getBoundingClientRect();
      if (r.bottom > box.top + 1) return { key: streamRowKey(n), off: Math.round(r.top - box.top) };
    }
    return null;
  })();
  // A shorter body is only ever a WINDOW TRIM: `windowLines`/`slice(-300)` and `MAX_BLOCKS` drop rows off the TOP.
  // Rows that vanish from the middle or the tail are a read this console should not draw (a failed store read, a
  // shorter answer mid-turn), and drawing it is what collapses the box and pulls everything under it up the page.
  // So: every row below the first one the new body still names must still be named by it.
  const nextKeys = new Set(next.map(streamRowKey).filter(Boolean));
  if (next.length < before.length) {
    const firstNext = next.map(streamRowKey).find(Boolean) || "";
    const keyed = before.map((n) => streamRowKey(n)).filter(Boolean);
    const from = Math.max(0, keyed.indexOf(firstNext));
    if (keyed.slice(from).some((k) => !nextKeys.has(k))) return false;
  }
  if (!before.length) {
    out.replaceChildren(...next);
  } else {
    const byKey = new Map();
    for (const n of before) {
      const k = streamRowKey(n);
      if (k && !byKey.has(k)) byKey.set(k, n);
    }
    let cursor = out.firstElementChild;
    for (const fresh of next) {
      const k = streamRowKey(fresh);
      const have = k ? byKey.get(k) : null;
      if (k) byKey.delete(k);
      let place = have;
      if (have) {
        // The same row in the same place: only its words can have moved, so it is patched in place - and replaced
        // only when it is not the same row at all (see patchPiece).
        if (have !== cursor) out.insertBefore(have, cursor);
        if (!have.isEqualNode(fresh) && !patchPiece(have, fresh)) {
          have.replaceWith(fresh);
          place = fresh;
        }
      } else {
        out.insertBefore(fresh, cursor);
        place = fresh;
      }
      cursor = place.nextElementSibling;
    }
    // Whatever the new body does not name is out of this turn's window. It is all below the loop's cursor, so
    // removing it moves nothing the reader is looking at.
    while (cursor) {
      const gone = cursor;
      cursor = cursor.nextElementSibling;
      unindexSubtree(out, gone);
      gone.remove();
    }
  }
  if (keep?.key) {
    const again = [...out.children].find((n) => streamRowKey(n) === keep.key);
    if (again) {
      const off = Math.round(again.getBoundingClientRect().top - out.getBoundingClientRect().top);
      if (Math.abs(off - keep.off) >= 2) setScroll(out, out.scrollTop + (off - keep.off));
    }
  }
  // A think row this paint created (or patched) has to be measured on the page: its minimized form is the first
  // section cut by the console's own four-line lid. Doing it here keeps a settled read from drawing a provisional,
  // uncut section until the next sweep.
  for (const row of out.querySelectorAll(".jl-think[data-think-row]")) fitThinkRow(row);
  // The rows this paint replaced include the open markdown block (if there was one): the next appended line must
  // start from the DOM that is actually there, never from a block node this page has just detached.
  out._md = null;
  out._lidIndex = null;
  grew(out);
  return true;
}

// The ↓ chip's answer for the frame that just drew a line, without a single box read. A console the panel has just
// put on its newest line is at its end; one it did not put there is not - `following` IS that judgement, and the
// geometry cannot say anything else about it. The full answer (whether there is anything to scroll at all, and
// whether the reader is inside the 2 px band) belongs to the three moments it can change: the reader's own scroll,
// a resize, and the 400 ms pass - and each of those measures. This path used to read scrollHeight and clientHeight on
// the console AND on the card body, twice each, for 286 calls and 98.16 ms of self time per streaming window.
function paintTailChip(box, following) {
  const wrap = box && box.closest ? box.closest(".out-wrap") : null;
  if (!wrap) return;
  wrap.classList.toggle("is-at-end", Boolean(following));
  // Not following: the truthful answer is one the paint path cannot give, so the 400 ms pass is asked for it. A
  // following console clears nothing, which is every console in a stream that nobody has taken over.
  if (box) box._chipDirty = !following;
}

function paintStreamConsole(turn, copy = "", thread = turn.thread || turn.id) {
  const out = placedNodes("pre.job-out").find((el) => el.dataset.out === `${turn.id}${copy}`);
  if (!out) return false;
  if (globalThis.consoleHeld?.(out)) return false;
  // What this repaint would draw, as one string. The gate the report asked for is the version below, and it is the
  // one that matters: recordJobLine already draws the line it changes, so a console whose append path has drawn the
  // store's current version needs nothing rebuilt. 16 full window builds and 12248 drawJobLine calls per 24 s ran on
  // a page whose append path had drawn every one of those lines already; the sweep exists for text the panel did
  // not see arrive, and that is exactly what a version that did not move says.
  const ver = (state.jobLineVersion && state.jobLineVersion.get(turn.id)) || 0;
  if (out._drawnVer === ver) return true;
  const sig = `${ver}|${thread}`;
  if (out._paintSig === sig) return true;
  out._paintSig = sig;
  const all = jobLines(turn.id).filter((l) => !isBookkeeping(l));
  const stick = consolePinned(`${turn.id}${copy}`) || wireConsole(out)._atBottom !== false;
  syncStreamConsole(out, streamBodyHtml(turn, all.slice(-300), all.length > 300, thread), stick);
  if (stick) stickSoon(out);
  paintTailChip(out, stick);
  return true;
}


// ---- copy buttons ------------------------------------------------------------------------------
// One mechanism for every "lift this block" affordance: an element carrying `data-copy` carries a small
// button in its corner that appears while the pointer is over it and copies THAT BLOCK's own visible
// text. The button is mounted here, by the observer below, never by the renderers - so a block another
// worker draws (the console's code and diff windows) opts in by carrying the same attribute, and there
// is no second mechanism to keep in step with this one.
//
// What a block copies is what it SHOWS: the reading goes through innerText, so a folded burst or a
// folded reasoning block contributes only the lines on screen, never a hidden one. Every control inside
// the block is taken out of that reading - this button's own label, the "N lines" and "+ N commands"
// buttons, the jump-to-the-newest-line chip - because a control's label is chrome, not output.
const COPY_SEL = "[data-copy]";
const COPY_BTN_SEL = "[data-copy-btn]";
const COPY_TEXT_SEL = "[data-copy-text]";
const COPY_TITLE = "copy this block's text to the clipboard";
const COPY_FLASH_MS = 1400;

function copyButtonHtml() {
  return `<button type="button" class="copy-block" data-copy-btn="1" title="${COPY_TITLE}" aria-label="${COPY_TITLE}">⧉</button>`;
}

// The one place a button is created. Idempotent: the button this inserts is itself a mutation, so the
// observer below sees it, asks again, finds the button already there and stops.
function mountCopyButtons(root) {
  if (!root || root.nodeType !== 1) return;
  const blocks = [];
  if (root.matches?.(COPY_SEL)) blocks.push(root);
  for (const el of root.querySelectorAll?.(COPY_SEL) || []) blocks.push(el);
  for (const block of blocks) {
    // A <details> renders only its summary while it is folded, so its button goes IN the summary: a folded
    // block has to be copyable too, and what it copies is still its folded text.
    const host = block.tagName === "DETAILS" ? block.querySelector(":scope > summary") || block : block;
    if (host.querySelector(":scope > .copy-block")) continue;
    host.insertAdjacentHTML("beforeend", copyButtonHtml());
  }
}

// Generic by construction: ANY render path that puts a `[data-copy]` block on the page gets its button -
// a card rebuilt from scratch, a console line appended by the run's stream, a pinned copy of a turn.

// ---- motion nobody can see -------------------------------------------------------------------------------------
// A card's pulse dot is a looping opacity + transform animation, which the compositor runs for free while the dot is
// painted. Scrolled out of view it is not painted, and Chrome then runs the animation on the MAIN thread instead -
// its own trace logs "compositor property animations have no effect" (failure 1 << 17) - every frame, for a dot
// nobody can see. Measured on the reader's board in a GPU-composited client, three alternating pairs of 8 s with the
// rows open: one dot off screen held 4.5 points of a core (9.3% animated against 4.8% still), and the same dot on
// screen 0.1. A board scrolled past its running cards pays that once per dot. So a dot off screen is paused
// (`.is-offscreen`, style.css) and plays again as it scrolls back in. Watched from the node observer below, which sees
// every node any render path places; the dots are long-lived (the pulse is rewritten in place every second), and a
// detached one is let go the next time a dot arrives.
const motionDots = new Set();
const offscreenMotion =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const e of entries) e.target.classList.toggle("is-offscreen", !e.isIntersecting);
      })
    : null;

function watchMotion(root) {
  if (!offscreenMotion || !root || root.nodeType !== 1) return;
  const found = root.matches?.(".pulse-dot") ? [root] : [...(root.querySelectorAll?.(".pulse-dot") || [])];
  if (!found.length) return;
  for (const d of motionDots) {
    if (d.isConnected) continue;
    offscreenMotion.unobserve(d);
    motionDots.delete(d);
  }
  for (const d of found) {
    if (motionDots.has(d)) continue;
    motionDots.add(d);
    offscreenMotion.observe(d);
  }
}

// ---- the folded command card's last preview row ---------------------------------------------------------------
// A command card folded to its preview rows (core/command card, style.css `--cmd-rows`) used to END at the clamp's
// edge, so a prompt cut in the middle of a sentence read as if it stopped there. It now ends with three ASCII dots,
// and a card that is open draws no marker at all: the dots say "there is more", and there is no more when it is open.
//
// WHY IT IS MEASURED, AND NOT WRITTEN INTO THE MARKUP. The clamp is a HEIGHT - N lines of the card's own line height,
// set by the reader in Settings > Display - and a prompt wraps, so WHICH character is the last visible one is a fact
// only the browser has (it depends on the width the card happens to be drawn at). So the last visible character is
// found with a Range over the body's text nodes, everything after it is taken out, and the three dots are written
// where the text stops. What was taken is remembered on the body (`cmdMarks`, below), so opening the card, or
// re-measuring it at a new width, starts from the whole prompt again: nothing is lost, only folded. What the console
// COPIES is untouched by any of this - a card carries its line in `data-ltext` and copy reads that, never the drawn
// rows.
const CMD_FOLD_DOTS = "...";
const cmdFoldPending = new Set();
let cmdFoldFrame = 0;
// One canvas for the dots' own width in the body's font: three dots that do not fit on the row would be clipped with
// the rest of the text, which is the one way this marker can come out invisible.
const cmdDotsCtx = typeof document !== "undefined" && document.createElement ? document.createElement("canvas").getContext("2d") : null;

function cmdDotsWidth(body) {
  if (!cmdDotsCtx) return 0;
  const cs = getComputedStyle(body);
  cmdDotsCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return cmdDotsCtx.measureText(CMD_FOLD_DOTS).width;
}

// The last character of this text node that renders inside the clamp, then backed off until the dots fit after it on
// the same row. The per-character rect's bottom only grows with the offset (text flows down), so a binary search is
// exact; the back-off walks at most one row's worth of characters.
function cmdCutOffset(node, limitY, maxX, dots) {
  const len = node.data ? node.data.length : 0;
  if (!len) return 0;
  const r = document.createRange();
  const rect = (i) => {
    r.setStart(node, Math.max(0, i - 1));
    r.setEnd(node, i);
    return r.getBoundingClientRect();
  };
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (rect(mid).bottom <= limitY + 0.5) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 0 && rect(lo).right + dots > maxX) lo -= 1;
  return lo;
}

// Everything after `last`, gone: the rows below the clamp's edge, and the rest of the row the cut is in. Every node
// is remembered with its parent and the sibling it stood in front of, so the whole prompt goes back by INSERTING
// what was taken - never by re-parsing the body's innerHTML, which was itself a DOM write and made the next mark's
// first read a forced layout.
function cmdCutAfter(body, last, removed) {
  let node = last;
  while (node && node !== body) {
    let sib = node.nextSibling;
    while (sib) {
      const after = sib.nextSibling;
      removed.push({ node: sib, parent: node.parentNode, after });
      sib.remove();
      sib = after;
    }
    node = node.parentNode;
  }
}

// One card's mark as it was drawn: the measurement it was made from, the text node the cut landed in and the tail it
// lost, every node the cut removed and where it stood, and the dots. Restoring is putting those same nodes back.
const cmdMarks = new WeakMap();

// Back to the whole prompt: everything the fold took, put back where it stood. Idempotent, so every path may call it.
function clearCommandFoldMark(box) {
  const body = box && box.querySelector ? box.querySelector(":scope > .code-body") : null;
  if (!body) return;
  const mark = cmdMarks.get(body);
  if (!mark) return;
  // Reverse order: a removed node's `after` is either still in the tree or was restored by a later entry.
  for (let i = mark.nodes.length - 1; i >= 0; i -= 1) {
    const { node, parent, after } = mark.nodes[i];
    if (!parent) continue;
    if (after && after.parentNode === parent) parent.insertBefore(node, after);
    else parent.appendChild(node);
  }
  if (mark.dots && mark.dots.parentNode) mark.dots.parentNode.removeChild(mark.dots);
  if (mark.text && mark.text.node) mark.text.node.data += mark.text.tail;
  cmdMarks.delete(body);
}

// One card, marked or unmarked to match its own state. Called for every card a render path places, for the press that
// folds one, and when a body's width changes (the wrap moved, so the last visible character moved with the dots).
//
// A mark is measured, not re-measured: the three numbers that decide where the cut lands are the body's width, its
// height and the length of its text, and when none of them moved the mark already on the card is the answer. That
// was 1.7 ms per call and 32 Range reads for four text nodes, 8 of 8 re-marks doing the same binary search again.
function paintCommandFoldMark(box) {
  if (!box || box.nodeType !== 1 || !box.classList || !box.classList.contains("is-cmd")) return;
  // A card inside a console a live corner gesture owns is text under the pointer, and the observer above is fired by
  // that gesture's own height writes. The flush asks the same question; so does this, so no other call site can rewrite
  // the card in the frame after a write (docs/reports/console-corner-drag-code-2026-11-24.html, 4.4).
  const held = typeof box.closest === "function" ? box.closest("pre.job-out") : null;
  if (held && consoleHeld(held)) return;
  const body = box.querySelector(":scope > .code-body");
  if (!body) return;
  const clamped = box.classList.contains("is-clamped");
  // A card that could not be measured on this frame is measured again on the next one, a few frames at most: the
  // fold's class can land a frame AFTER the repaint that asked for the mark (a settings reset re-renders the card and
  // folds it afterwards), and a card whose fold arrived late used to keep no dots at all - the one-shot repaint had
  // already run. Bounded, so a card that is genuinely open costs four cheap returns and then nothing.
  const retry = () => {
    if ((box._foldTries = (box._foldTries || 0) + 1) > 4) return;
    scheduleCommandFoldMark(box);
  };
  // Always start from the whole prompt: a card that was marked and is being measured again must be measured on its
  // own text, not on last frame's cut.
  if (!clamped || !body.isConnected || body.hidden) {
    clearCommandFoldMark(box);
    if (body.isConnected && !body.hidden) retry();
    return;
  }
  // A body with no layout (a folded turn, a hidden pane) cannot be measured, and marking it would mark it wrongly.
  // It is watched until it has one: the first layout is what makes the answer possible, and nothing schedules a
  // second look at a card that is merely off screen.
  const w = body.clientWidth;
  const h = body.clientHeight;
  if (!w || !h) {
    clearCommandFoldMark(box);
    if (cmdFoldResize) cmdFoldResize.observe(body);
    retry();
    return;
  }
  // The whole prompt fits its preview rows: nothing is hidden, so nothing says otherwise.
  if (body.scrollHeight <= h + 1) {
    clearCommandFoldMark(box);
    retry();
    return;
  }
  if (body.dataset.cmdFolding === "1") return;
  const sig = `${w}|${h}|${body.textContent.length}`;
  const drawn = cmdMarks.get(body);
  // The mark already on the card, if it is still on the card: a repaint that rewrote this body's children took the
  // dots with the old nodes, and a cache entry that says "drawn" must not keep them from being drawn again.
  if (drawn && drawn.sig === sig && drawn.dots && drawn.dots.isConnected && body.contains(drawn.dots)) return;
  clearCommandFoldMark(box);
  body.dataset.cmdFolding = "1";
  try {
    const cs = getComputedStyle(body);
    const rect = body.getBoundingClientRect();
    // The clamp is a border-box height, so the text's own area ends `padding-bottom` above the box's bottom edge.
    const limitY = rect.top + h - (parseFloat(cs.paddingBottom) || 0);
    const maxX = rect.left + w - (parseFloat(cs.paddingRight) || 0) - (parseFloat(cs.borderRightWidth) || 0);
    const dots = cmdDotsWidth(body);
    const nodes = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    // The LAST node with a visible character is the row to end; the first node that is wholly below the edge ends it.
    let chosen = null;
    for (const node of nodes) {
      const cut = cmdCutOffset(node, limitY, maxX, dots);
      if (cut <= 0) break;
      chosen = { node, cut };
      if (cut < (node.data || "").length) break;
    }
    if (!chosen) return;
    const { node, cut } = chosen;
    const mark = { sig, text: { node, tail: (node.data || "").slice(cut) }, nodes: [], dots: null };
    node.data = node.data.slice(0, cut);
    // The label is bold chrome and the dots are not: placed after it, never inside it.
    const holder = node.parentNode && node.parentNode.classList && node.parentNode.classList.contains("code-prompt-label") ? node.parentNode : node;
    const span = document.createElement("span");
    span.className = "code-fold-dots";
    span.textContent = CMD_FOLD_DOTS;
    holder.parentNode.insertBefore(span, holder.nextSibling);
    mark.dots = span;
    cmdCutAfter(body, span, mark.nodes);
    cmdMarks.set(body, mark);
    // This card has its answer: the next frame's retry budget starts over, so a later transient (a settings change, a
    // turn unfolding) still gets its four frames.
    box._foldTries = 0;
  } finally {
    delete body.dataset.cmdFolding;
  }
}

// A card whose body changed width is re-measured, and a card whose body had no layout yet is measured as soon as it
// has one. ONE observer for the console AND the bodies: the console is what a card's width follows (a panel resize,
// a maximized card), and a body is watched only until it first has a layout (a turn unfolding, a pane shown) - a
// target per card per paint was 20 observations for one console and one more for every rebuild.
const cmdFoldResize =
  typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          const root = entry.target;
          if (!root) continue;
          // A body names its own card; the console names every card inside it.
          const own = root.classList && root.classList.contains("code-body") ? root.parentElement : null;
          if (own && own.classList && own.classList.contains("is-cmd")) {
            scheduleCommandFoldMark(own);
            continue;
          }
          if (!root.querySelectorAll) continue;
          for (const box of root.querySelectorAll(".code-box.is-cmd")) scheduleCommandFoldMark(box);
        }
      })
    : null;

// Every card a render path placed, batched into one frame: a console rebuild puts twenty cards on the page at once,
// and twenty separate measurements would be twenty layout flushes.
function scheduleCommandFoldMark(root) {
  if (!root || root.nodeType !== 1) return;
  const boxes = [];
  if (root.matches?.(".code-box.is-cmd")) boxes.push(root);
  for (const el of root.querySelectorAll?.(".code-box.is-cmd") || []) boxes.push(el);
  if (!boxes.length) return;
  for (const box of boxes) cmdFoldPending.add(box);
  armCommandFoldFrame();
}

// The next frame's flush. One owner for the handle, because the flush re-arms itself while a gesture holds a card.
function armCommandFoldFrame() {
  if (cmdFoldFrame) return;
  cmdFoldFrame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(flushCommandFoldMarks)
      : (setTimeout(flushCommandFoldMarks, 0), 1);
}

// One frame of marks, and the place the corner gesture is asked. cmdFoldResize watches every console (wireConsole
// observes each one), so a drag's own height writes fire this flush, and a mark rewrites the text nodes inside the
// console under the pointer - the exact "text rebuilt under the pointer" the gesture forbids, landing in the frame
// after the write. A card the gesture holds goes back into the pending set and the frame is armed again, so it is
// marked after the release instead of dropping out of the batch
// (docs/reports/console-corner-drag-code-2026-11-24.html, 4.4).
function flushCommandFoldMarks() {
  cmdFoldFrame = 0;
  const batch = [...cmdFoldPending];
  cmdFoldPending.clear();
  let waiting = false;
  for (const box of batch) {
    if (!box.isConnected) continue;
    const out = typeof box.closest === "function" ? box.closest("pre.job-out") : null;
    if (out && consoleHeld(out)) {
      cmdFoldPending.add(box);
      waiting = true;
      continue;
    }
    paintCommandFoldMark(box);
  }
  if (waiting) armCommandFoldFrame();
}

const copyObserver = new MutationObserver((records) => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node.nodeType !== 1) continue;
      mountCopyButtons(node);
      watchMotion(node);
      scheduleCommandFoldMark(node);
    }
  }
});

// What a block copies: its own text, as the reader sees it. innerText alone will not do - a flex row (a
// tool burst's call: glyph, name, tally, arguments, timer) has its items blockified, so innerText breaks
// them onto five separate lines, and textContent ignores what is folded away altogether. So the walk
// below keeps innerText's rules for what is SHOWN - a folded or hidden subtree contributes nothing - one
// line box at a time, and lays a flex row's items out the way the reader sees them: one line, separated.
const COPY_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "BUTTON"]);

function copyBlockBox(el) {
  const d = getComputedStyle(el).display;
  return d !== "none" && d !== "contents" && !d.startsWith("inline");
}

function copyShownText(el) {
  if (!el || el.nodeType !== 1) return "";
  if (COPY_SKIP_TAGS.has(el.tagName)) return ""; // a control's label is chrome, never output
  // A cell a renderer duplicates to fill a column - a diff window's second context cell - marks itself so the
  // block's copy is the record once, not once per column.
  if (el.hasAttribute && el.hasAttribute("data-copy-skip")) return "";
  if (el.tagName === "BR") return "\n";
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || el.hidden) return "";
  if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return "";
  // A folded block contributes its title line and nothing else, whatever its contents compute to.
  if (el.tagName === "DETAILS" && !el.open) return copyShownText(el.querySelector(":scope > summary"));
  // A command line's card is one line of the record (core/console-format.js's frame, drawn by
  // core/assistant-command.js), not a block of chrome: it copies the line it was drawn from, which it carries the way
  // every console row carries its own. Without this the head - a button, so skipped below - would take the command
  // itself out of a copied console and leave only the payload.
  if (el.matches && el.matches(".code-box[data-ltext]")) return String(el.getAttribute("data-ltext") || "");
  // A wrapper a renderer added for a fold is read THROUGH, not treated as a block of its own: a block's copy is
  // trimmed at its edges, and applied to a tool call's output that would eat the leading spaces of whichever line
  // happens to be first under the wrapper (a result line reads "  ↳ patch · 3.27s" on screen). The lines inside
  // are the console's own text, so they are lifted exactly as they are shown.
  if (el.hasAttribute && el.hasAttribute("data-copy-through")) {
    return [...el.childNodes].map((k) => (k.nodeType === 3 ? k.nodeValue : k.nodeType === 1 ? copyShownText(k) : "")).join("\n");
  }
  const display = cs.display;
  if (display === "flex" || display === "inline-flex" || display === "grid" || display === "inline-grid") {
    // A flex ROW lays its items out on one line - which is the whole reason this walk exists - while a
    // flex COLUMN or a grid stacks them, one line each. (A tool burst's head is a column: one row per
    // tool, and its copy is one line per tool.)
    const onOneLine = (display === "flex" || display === "inline-flex") && !String(cs.flexDirection || "").startsWith("column");
    return [...el.children]
      .map(copyShownText)
      .map((t) => t.trim())
      .filter(Boolean)
      .join(onOneLine ? " " : "\n");
  }
  const kids = [...el.childNodes];
  // A line box - text and inline content only: innerText is exact for one, pre-wrap and all.
  if (!kids.some((k) => k.nodeType === 1 && copyBlockBox(k))) return el.innerText;
  return kids
    .map((k) => (k.nodeType === 3 ? k.nodeValue : k.nodeType === 1 ? copyShownText(k) : ""))
    .join("\n")
    .replace(/[ \t]+(?=\r?\n)/g, "")
    .replace(/(\r?\n){2,}/g, "\n")
    .replace(/^[\s\r\n]+|[\s\r\n]+$/g, "");
}

// The part that IS the block's text, when the marked element is a wrapper: a tool burst's button sits on
// the burst (so hovering anywhere in it finds one button) while a burst copies its CALL - the header and
// its summary as rendered - and never its result lines. It is a DIRECT child: a burst inside a console
// carries one of its own, and the console must not read it as its own text.
function blockCopyText(block) {
  return copyShownText(block.querySelector(`:scope > ${COPY_TEXT_SEL}`) || block);
}

function flashCopyButton(btn, ok) {
  btn.textContent = ok ? "✓" : "✕";
  btn.classList.toggle("is-copied", ok);
  btn.classList.toggle("is-failed", !ok);
  btn.title = ok ? "copied to the clipboard" : "the clipboard refused it - nothing was copied";
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.textContent = "⧉";
    btn.classList.remove("is-copied", "is-failed");
    btn.title = COPY_TITLE;
  }, COPY_FLASH_MS);
}

// ---- the reader's own input, per card
// Which card the reader is working in is the question a scroll event has to answer, so the clock is keyed by the CARD
// and not by the page. With one document-wide `lastInputAt`, a wheel over card B licensed the next scroll event on
// card A to be read as A's reader scrolling: A's pin was rewritten from a silent 35 px clamp 790 ms after the wheel,
// and it then stayed 1,277 px off its tail for the rest of the window (tools/measure-console-pin.mjs, 2,587 frames).
// Input outside every card (the board's own chrome, the assistant panel) is not a console scroll and decides nothing.
const INPUT_WINDOW_MS = 1200; // a scroll this soon after a wheel / key / click in the SAME card is the reader's
const lastInputAt = new Map(); // card thread -> when the reader last wheeled / keyed / clicked inside that card

// Did the reader touch the card this box belongs to, inside the window? A box with no card above it answers `false`:
// nothing the reader did elsewhere on the page is evidence about it, and a scroll the panel cannot attribute stays the
// panel's own.
function readerInputHere(el) {
  const card = el && el.closest ? el.closest(".job[data-thread]") : null;
  const at = card ? lastInputAt.get(card.dataset.thread) : 0;
  return Boolean(at) && Date.now() - at < INPUT_WINDOW_MS;
}
// ---- end the reader's own input, per card
const selfScrolled = new WeakSet();

function consolePinned(id) {
  return state.outPinned[id] !== false;
}

function pinConsole(id) {
  if (id) state.outPinned[id] = true;
}

// A fold the reader opens inside a console hands that console over. The growth is the reader's, not the run's: a
// console still following its newest line carries the view down by the height of what was just folded out (the 400 ms
// stick and the next live line both answer "this console is off its end"), so the box's LAST line fills the view and
// the line the reader was on is gone above it. Unpinned, the view does not move and the box opens under the header
// that was pressed; ↓ (or scrolling back to the end) follows the run again. `atBottom: false` is written with the
// position because a rebuilt card and a re-rendered table restore from that record (applyStoredScrolls,
// restoreScrolls), and a stale "atBottom" would follow the growth on the next repaint.
//
// Called only when a press OPENS something: folding a box back away shrinks the console, and the browser's own clamp
// is the right answer there. Settings > Agent cards > "Jump to an opened result" restores the old follow-the-growth
// behaviour, and off is the default (foldFollowsConsole).
function holdConsoleFor(control) {
  const pre = control && control.closest ? control.closest("pre.job-out") : null;
  if (!pre || !pre.dataset.out || foldFollowsConsole()) return null;
  state.outPinned[pre.dataset.out] = false;
  state.outScrolls[pre.dataset.out] = { top: pre.scrollTop, atBottom: false };
  // …and the page's cached answer has to say so too. A paced paint consults `_atBottom` instead of measuring, and the
  // fold's own growth fires no scroll event to correct it, so a console that was just handed over would be carried to
  // the bottom of what the reader opened on the next tick — the fault this function exists to prevent.
  pre._atBottom = false;
  return pre;
}

// Every scroll the panel performs goes through here. Its scroll event arrives after this task, and without a
// record of what the panel did it is indistinguishable from the reader scrolling - which unpinned consoles during
// a rebuild and left them parked at the top until something else happened to move them.
// A node whose scrollTop is still where the panel put it: the event it is reporting is the panel's own.
function justPlaced(el) {
  return el._selfTop != null && Math.abs(el.scrollTop - el._selfTop) <= 1;
}

function setScroll(el, top) {
  if (!el) return;
  const v = Math.max(0, Math.round(Number(top) || 0));
  el._selfTop = v;
  // Only a write that MOVES the box sends a scroll event, so only that write may claim the next one as the panel's.
  // Most writes move nothing - the follow path re-sticks a console already on its newest line every frame, and a
  // restore often lands on the line the box is on - and the flag such a write left behind had no event of its own to
  // spend it on: it was spent on the reader's next real scroll instead. The wheel still unpinned the console, but its
  // place was never recorded, so state.outScrolls kept the old answer (none at all, or "at the bottom") and the next
  // rebuild that restores from it put the reader somewhere they had not been (docs/console-bounce-manual-7391.md).
  // Reading scrollTop here costs no layout: assigning it already lays the box out to clamp the value.
  const from = el.scrollTop;
  el.scrollTop = v;
  if (el.scrollTop !== from) selfScrolled.add(el);
}
