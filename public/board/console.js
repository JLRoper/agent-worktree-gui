// The client console's ENTRY POINT, cut out of public/app.js and then cut four ways by the module-separation plan
// (docs/reports/module-separation-2026-11-28.html, card 9). A classic script, evaluated BEFORE app.js
// (public/index.html) because app.js's boot IIFE calls the console's renderers on the first paint.
//
// WHERE THE CONSOLE LIVES NOW. The console is five classic scripts, loaded in this order by public/index.html:
//
//   /board/console.js         this file - the line vocabulary every cut reads: the two tool regexes, the call
//                             argument, the in-flight call and the bookkeeping kinds
//   /board/console-stream.js  the gateway wait line, reasoning and markdown prose, the docked console, the row text
//   /board/console-tools.js   the tool group key, the trimmed group head and the tool-usage group
//   /board/console-rows.js    the writers, the rows by line id, the marching tail, patching and the copy buttons
//   /board/job-line.js        drawJobLine and the job card's own console frame
//
// A cut that has not landed yet still declares its names below; each cut file's own header names what it took, and
// this file is only what no cut claimed.
//
// This entry point re-exports nothing and delegates nothing, because a classic script cannot: a top-level
// `function` here IS a `window` property under its own name, and a top-level `const`/`let` a binding in the page's
// one global lexical environment, so a name moved to a cut file is still the same page global read by the same bare
// name. What the load order buys and what it forbids is unchanged:
//   * every top-level `function` in any of the five files is a `window` property under its own name, so an inline
//     handler, a later script and the other board modules read it exactly as they read it before;
//   * every top-level `const`/`let` is a lexical binding in the page's one global lexical environment, which the
//     later app.js reads by bare name;
//   * a name one file does NOT declare (`state`, `esc`, `apiFetch`, `toolGroupsOn`, `paintSubagents`,
//     `typeWordSpeed`, ...) may only be read from inside a function body. At top level app.js has not run yet: the
//     console's own `state.*` initialisations therefore stay in app.js, beside the `state` literal they extend.
//
// Everything that draws a card, a row, a chart, the deliverable list, Settings or the pipeline modal stays in app.js.


// A tool that runs for minutes is the one thing that makes a healthy turn look frozen — a 159 s
// recursive grep did exactly that, and the card showed nothing but the line that started it. Every
// line carries the server's timestamp, so the tool still in flight can grow a live clock.
// Lines lead with the tool's glyph (📖 read_file · path); history written before glyphs leads with ▸,
// so the arrow is optional and the glyph run is skipped before the name is taken.
const TOOL_START_RE = /^(?:▸\s*)?(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?([^\s·]+)/u;
const TOOL_DONE_RE = /^\s*↳\s*([^\s·]+)/;
// The argument a call line carries ("📖 read_file · docs/map.md"): what the tool was given. The console's own
// rows use it, and a file's code box names the file from it.
const toolCallArg = (text) => {
  const s = String(text || "");
  const sep = s.indexOf(" · ");
  return sep >= 0 ? s.slice(sep + 3) : "";
};

// Index of the started tool call that has no result yet, or -1. Parallel calls interleave, so count
// starts and completions per tool name rather than assuming the last line is the running one.
function inflightToolIndex(lines) {
  const started = new Map();
  const finished = new Map();
  let lastIdx = -1;
  let lastName = null;
  lines.forEach((l, i) => {
    const text = String(l.text || "");
    const start = l.kind === "tool" ? TOOL_START_RE.exec(text) : null;
    if (start) {
      started.set(start[1], (started.get(start[1]) || 0) + 1);
      lastIdx = i;
      lastName = start[1];
      return;
    }
    const done = l.kind === "tool-out" ? TOOL_DONE_RE.exec(text) : null;
    if (done) finished.set(done[1], (finished.get(done[1]) || 0) + 1);
  });
  if (lastIdx < 0 || !lastName) return -1;
  return (started.get(lastName) || 0) > (finished.get(lastName) || 0) ? lastIdx : -1;
}

// The name of the call that has started and not come back - the reason a steer can sit undelivered for minutes.
function inflightToolName(lines) {
  const i = inflightToolIndex(lines);
  if (i < 0) return null;
  const m = TOOL_START_RE.exec(String(lines[i].text || ""));
  return m ? m[1] : null;
}

// The console is what the agent DID, not the run protocol around it. Three lines are bookkeeping: the POST
// that opened the run, the run id echoed back, and the completion summary with the token total. The card
// already states all three — the head carries "turn 2 · done · 26s · 186725 tok" and the foot the outcome —
// so they are stored but not drawn.
const BOOKKEEPING_LINES = new Set(["cmd", "init", "result"]);
function isBookkeeping(l) {
  return Boolean(l && BOOKKEEPING_LINES.has(l.kind));
}

// Rebuilds land before the browser has finished laying the new nodes out, so a "go to the bottom" can be clamped
// to a shorter height than the console ends up with. Once the frame is done, put the pinned ones back on their
// newest line - and only those, so a console the reader took control of is never moved.
function settleScrolls(root) {
  const run = () => {
    if (!root || !root.isConnected) return;
    for (const o of root.querySelectorAll("pre.job-out")) stickConsole(o);
    for (const s of root.querySelectorAll(".sub-console")) stickSubConsole(s);
    // The card's session scroller gets the same second pass: a rebuild writes its bottom before the new nodes are
    // laid out, and the height the reader is following is the one the card ends up with, not the one it had at the
    // write. Only a body still following is touched, so a reader parked mid-history keeps their line.
    for (const b of root.querySelectorAll(".job-body")) stickCardBody(b);
    // A repaint can move the card under an open picker; put the panel back under its control.
    positionModelPop();
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function stickConsole(pre) {
  if (!pre || !pre.dataset || !consolePinned(pre.dataset.out)) return;
  // A console a corner gesture is holding is sized and scrolled by the pointer for the length of the drag.
  if (typeof consoleHeld === "function" && consoleHeld(pre)) return;
  const max = pre.scrollHeight - pre.clientHeight;
  if (max <= 0 || Math.abs(pre.scrollTop - max) <= 1) return;
  setScroll(pre, max);
}

// ---- the card's session scroller -------------------------------------------------------------------------------
// The card is drawn as a scrollport in two places: the docked Chat pane
// (`.as-subpane[data-subpane="chat"] > .job > .job-body`) and a maximized card (`.job.maximized .job-body`). In both,
// `.job-body` holds the WHOLE conversation - every turn, the composer under them - and the turn consoles inside it are
// drawn at their content height (`.job.maximized .job-out` and `.as-subpane[data-subpane="chat"] ... .job-out`, both
// `max-height: none`, public/style.css:3150 and :4209). So the console's own stick has nothing to move: `stickConsole`
// measures a <pre> that cannot scroll, finds no overflow, and returns. Nothing followed the body,
// and a long stream was appended below the fold while the reader dragged the session bar down by hand.
//
// The rule is the console's rule one level up, and it has to be, because the two boxes are the same conversation seen
// at two magnifications:
//
//   * FOLLOW ONLY A READER AT THE FOOT. Eight px, the same band `chatPinned` (public/assistant.js) has always used for
//     this box, and for the same reason the console uses 2 px: a band wider than a line reads as generous and then
//     re-anchors someone parked on the last line of a turn.
//   * NEVER TOUCH A BODY THE READER TOOK OVER. The answer is remembered on the node (`_atBottom`, set by its own scroll
//     events) and is never measured here: this is asked once per appended line, and a layout read per line is exactly
//     what the console's design exists to avoid. A body the panel has never placed is following - a card the reader
//     just opened lands on the newest output (`renderConversation` and assistant.js's `pinChatToBottom` both then record
//     where they put it).
const CARD_TAIL_PX = 8;

// Is this node one of the bodies the sheet draws as a card's scrollport? The docked (and floating) Chat pane and a
// maximized card are the two rules that make `.job-body` `overflow: auto`; everywhere else on the board it is
// `overflow: visible`, and a scrollTop write on it moves nothing while still costing the layout read every line would
// pay for it. Asked of the markup rather than of `getComputedStyle`, because this is asked once per line per console
// and a style read there is the cost this whole section exists to avoid (public/style.css:3147, :4176).
function isCardScrollport(body) {
  if (!body || !body.isConnected || typeof body.closest !== "function") return false;
  return Boolean(body.closest(".job.maximized") || body.closest('[data-subpane="chat"]'));
}

// The session scroller this node is drawn inside, or null.
function cardBodyOf(el) {
  const body = el && typeof el.closest === "function" ? el.closest(".job-body") : null;
  return isCardScrollport(body) ? body : null;
}

function cardBodyFollowing(body) {
  return body._atBottom !== false;
}

// The one place a card body's pin is decided from its own scroll. Measured on the event, like a console's, and the
// panel's own writes are excluded by the caller (`setScroll` records where it put the box).
//
// `tailPx` is the band the caller will accept as "on the foot". The reader's own scroll uses the sheet's 8 px
// (CARD_TAIL_PX); a corner gesture's release passes 0, because the distance it is recording is the drag's own doing:
// a drag that grew the console past the transcript's slack leaves the body N px off its foot, and the 8 px band read
// that as "still following" and let the next pin/rebuild scroll the box to its foot - 8 px of corner lost after the
// hand let go, measured at 820x1080 from a 140px start (tools/verify-console-corner-drag.mjs, interrupt-repaint).
// Following still resumes on the reader's own scroll, which is noted with the band.
function noteCardBodyScroll(body, tailPx = CARD_TAIL_PX) {
  if (!body) return;
  body._atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= tailPx;
}

// Is a live corner gesture holding a console inside this transcript? A gesture moves the console's BOTTOM edge from
// the pointer and freezes its TOP edge at the press; the page's tail pin scrolls the transcript to its FOOT, which
// moves that top edge by exactly the height the drag wrote, so the two cancel and the grip's bottom edge stands still
// under a hand that is travelling. That is the third recurrence of this defect, and it is not a timing bug to be
// sampled before and after: measured per step in tools/verify-console-corner-slow-drag.mjs, 40 steps of 3px moved the
// box's top by -120px and its height by +120px, with the grip's bottom edge on the same pixel for every one of the
// 40 steps.
//
// This is the PAGE's pin. The BROWSER's scroll anchor is the same writer seen from the other side, and it is stood down
// too, by the gesture itself, for the length of the drag (public/app.js's press): at the foot its compensation for a
// taller box is a scrollTop write of exactly the height the drag added - measured on the live panel, the corner stood
// still for a 60px drag at 1600 and followed at 820, and the anchor's choice of node was the difference. The offset the
// press froze is re-asserted on every move, so whatever else writes it (a pin, a poll, the anchor before it was stood
// down) is undone in the same frame, and a row landing above is corrected by the drift the gesture measures a frame
// later. The release writes no foot: it records where the drag left the transcript
// (noteCardBodyScroll), and following resumes on the reader's own scroll back to it.
function cardBodyHeld(body) {
  return typeof outGripHoldsCard === "function" && outGripHoldsCard(body);
}

const cardStickPending = new Set();
let cardStickFrame = 0;

// Ask the card's session scroller to follow its foot, at most once per body per animation frame. Called by every
// append path that grows a turn - a streamed line, a typed line, a reasoning block, a docked child console - because
// each of those grows the BODY when the console inside it does not scroll.
function stickCardBodySoon(el) {
  const body = cardBodyOf(el);
  if (!body || !cardBodyFollowing(body)) return;
  if (typeof cardBodyHeld === "function" && cardBodyHeld(body)) return;
  cardStickPending.add(body);
  if (cardStickFrame) return;
  cardStickFrame = requestAnimationFrame(() => {
    cardStickFrame = 0;
    const batch = [...cardStickPending];
    cardStickPending.clear();
    for (const b of batch) {
      if (!cardBodyFollowing(b)) continue;
      // A gesture that started after this body was queued still owns it: the queued frame must not move the top
      // edge out from under the pointer.
      if (typeof cardBodyHeld === "function" && cardBodyHeld(b)) continue;
      // One read of the scrollport per body per frame, not one per row: the same cost the console pays. And, like
      // the console, only a frame with something new in it: a body that did not grow cannot have left the reader's foot.
      if (b._stuckAt != null && b._stuckAt === b._grow) continue;
      const max = b.scrollHeight - b.clientHeight;
      if (max > 0 && b.scrollTop < max) setScroll(b, max);
      b._stuckAt = b._grow;
    }
  });
}

// The one-shot form, for a pass that runs after layout has settled (settleScrolls, two frames after a rebuild, when a
// "go to the bottom" written before the paint can be clamped short of the height the card ends up with).
function stickCardBody(body) {
  if (!isCardScrollport(body) || !cardBodyFollowing(body)) return;
  if (typeof cardBodyHeld === "function" && cardBodyHeld(body)) return;
  const max = body.scrollHeight - body.clientHeight;
  if (max <= 0 || Math.abs(body.scrollTop - max) <= 1) return;
  setScroll(body, max);
}

// The console that speaks for a card body's tail: the LAST one in document order, which is the newest turn drawn
// open. A pinned turn's own copy (`@pin`) is drawn ABOVE the turns, so it is never this one; a pane with every turn
// folded has no console and answers null.
function cardTailConsole(body) {
  if (!body || typeof body.querySelectorAll !== "function") return null;
  const outs = body.querySelectorAll("pre.job-out");
  return outs.length ? outs[outs.length - 1] : null;
}

function captureScrolls(root) {
  const map = new Map();
  if (!root) return map;
  for (const o of root.querySelectorAll("pre.job-out")) {
    map.set(o.dataset.out, {
      top: o.scrollTop,
      // A node the panel has never placed (a fresh build) sits at 0 until something moves it. Reading that 0 as
      // "the reader scrolled up" is what made a rebuilt console come back at its first line.
      atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32,
    });
  }
  return map;
}

function restoreScrolls(root, map) {
  if (!root || !map.size) return;
  for (const o of root.querySelectorAll("pre.job-out")) {
    const was = map.get(o.dataset.out);
    if (!was) continue;
    setScroll(o, consolePinned(o.dataset.out) || was.atBottom ? o.scrollHeight : Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
  }
}

// ---- one owner for a console's height ---------------------------------------------------------------------------
// A console's height is ONE number with ONE writer and ONE reader. The writer is setOutHeight below; the reader is
// the sheet's `.job-out { height: var(--out-h, auto) }`. Three paths used to write `style.height` on their own -
// the corner gesture (public/app.js), the remembered height a rebuild puts back (applyStoredHeight below), and the
// float's slack console drag (public/assistant.js) - and the gesture re-derived a fourth number from the drawn rect
// on every move. That is how the same corner broke three times: a rewrite changed the body under the box, the
// gesture kept its own idea of where the bottom was, and a second loop moved the box's top edge.
//
// What this forbids a future console rewrite from doing:
//   * writing a height on a `.job-out` anywhere but through setOutHeight - no `style.height`, no second stored copy
//     of "the height the reader chose". A new pane, a new body or a new stream shape changes WHAT is inside the box;
//     it does not get to invent a second geometry.
//   * re-pinning or re-scrolling the transcript (or the console's own tail) while a corner gesture is live. The
//     gesture owns the box's rect for the length of the drag: its height from the pointer, its top edge from the
//     press. There is one `consoleHeld`/`outGripHoldsCard` question, and every pin in this file asks it.
function setOutHeight(out, px) {
  if (!out || !out.style) return false;
  const h = Math.round(Number(px));
  if (!Number.isFinite(h) || h <= 0) return false;
  out.style.setProperty("--out-h", `${h}px`);
  return true;
}

// THE FLOOR A CONSOLE CAN ACTUALLY DRAW: the larger of the sheet's `min-height` and the console's own padding and
// borders. `--out-h: 1px` drew 18px (8px of padding top and bottom plus the two 1px rules), so a number under that
// was a store, a gesture and a restore agreeing on a height the box never had. ONE function for both paths - the press
// clamps the pointer to it (public/app.js) and a restore puts at least it back - because two floors are how the release
// came to clamp a number the restore did not (docs/reports/console-corner-drag-code-2026-11-24.html, 4.2).
function outFloor(cs) {
  const pad = (parseFloat(cs && cs.paddingTop) || 0) + (parseFloat(cs && cs.paddingBottom) || 0);
  const rule = (parseFloat(cs && cs.borderTopWidth) || 0) + (parseFloat(cs && cs.borderBottomWidth) || 0);
  const sheet = parseFloat(cs && cs.minHeight) || 0;
  return Math.max(sheet, Math.round(pad + rule));
}

// The console back to the sheet's own size: a press that never moved must leave no height behind.
function clearOutHeight(out) {
  if (out && out.style) out.style.removeProperty("--out-h");
}

// Put a console's remembered height back on a node that is NOT the one the reader dragged. `o` either came out of
// conversationHtml (a card built from nothing: a collapsed project expanded again, a row that had no card to carry) or
// replaced the box a rebuild threw away - and an inline style belongs to the element, so the number was gone with it.
// Without this the box returns on its cap or at its content height, which reads as the panel throwing the reader's
// resize away every time anything about the turn changes.
//
// The cap is the other half of the promise. A height bigger than the box's max-height is clipped by it, so a stored
// height above the cap lifts the cap exactly as the drag did; the cap is read off the page rather than assumed, because
// one board draws the same console under 320 px in a worktree row and 230 px in the unattached list. A height at or
// under the cap is left to the sheet: the inline height alone reproduces it, and the cap keeps doing its job.
// The floor is the third: a restore is the other path that decides the number, so it holds the same padding-box floor
// the release does (outFloor) and writes a clamped number back to the store.
//
// Returns whether a height was applied, so a caller can tell "the reader chose this" from "a fresh box".
function applyStoredHeight(o) {
  if (!o || !o.dataset) return false;
  // A box a live corner gesture owns has a height the reader is setting with the pointer: a stored number written over
  // it mid-drag is the box jumping under the corner.
  if (globalThis.consoleHeld?.(o)) return false;
  const stored = Number(state.outHeights[o.dataset.out || ""]);
  if (!Number.isFinite(stored) || stored <= 0) return false;
  const cs = getComputedStyle(o);
  // THE FLOOR, THE SAME ONE THE RELEASE CLAMPS TO (outFloor). A store written at the bottom of a drag can be under the
  // console's own padding box, and putting that back drew - and kept - a number the box never had.
  const h = Math.max(outFloor(cs), Math.round(stored));
  if (!setOutHeight(o, h)) return false;
  // The store agrees with the box: a clamped number goes back into the store, so the next restore does not apply the
  // undrawable one again and the entry on disk is the height the reader is looking at.
  if (h !== Math.round(stored)) globalThis.rememberOutHeight?.(o.dataset.out, h);
  // THE CAP IS LIFTED WHEN THE HEIGHT NEEDS IT - and when there is no cap TO read, because a console restored into a
  // fragment that is inserted afterwards has no layout yet: its computed max-height is the empty string, which parses
  // to NaN, and the old `Number.isFinite(cap) && h > cap` skipped the lift and nothing re-ran once the layout appeared
  // (docs/reports/console-corner-drag-code-2026-11-24.html, 4.7). An explicit height with the cap lifted is honest in
  // any pane, and a height under a cap that COULD be read still leaves the sheet's cap doing its job.
  const cap = parseFloat(cs.maxHeight);
  if (!Number.isFinite(cap) || h > cap) o.style.maxHeight = "none";
  return true;
}

// Every console under a subtree that was rebuilt: the height FIRST, so whatever scroll is placed after it is clamped in
// the box the reader left rather than in the 230px one it is about to stop being.
function applyStoredHeights(root) {
  if (!root) return;
  for (const o of root.querySelectorAll("pre.job-out")) applyStoredHeight(o);
}

// Put every console in this subtree back where the reader left it, from the remembered positions.
// Used after a subtree was rebuilt from scratch, where there is no old node to measure.
function applyStoredScrolls(root) {
  if (!root) return;
  applyStoredHeights(root);
  for (const o of root.querySelectorAll("pre.job-out")) {
    const was = state.outScrolls[o.dataset.out];
    if (!was) continue;
    setScroll(o, consolePinned(o.dataset.out) || was.atBottom ? o.scrollHeight : Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
  }
  applySubConsoleScrolls(root);
}

// A console a rebuild BUILT, rather than moved: the markup came out of conversationHtml() a moment ago, so there is no
// old node to measure and no entry in the caller's capture map, and nothing else in that rebuild is going to place it.
// Left alone it is a fresh scroll area at its first line, and the run has been writing into that console all along: the
// reader sees the top of a log the panel was following to the end - one card, once per rebuild that builds it, which is
// the "one that is never repaired" the write log could not name (docs/console-combined-first-line.md).
// Called in the same task as the insert, so no frame is ever painted at 0. A console the reader has taken over goes
// back to the line they left it on; everything else follows its newest line, which is the panel's promise.
function placeBuiltConsoles(root) {
  if (!root) return;
  for (const o of root.querySelectorAll("pre.job-out")) {
    // The height the reader dragged this console to, before anything is measured or scrolled inside it: a box that
    // comes back at its cap and then grows puts the reader's line somewhere else than where they left it.
    applyStoredHeight(o);
    if (o._selfTop != null) continue; // someone already placed it in this task; their answer is the one to keep
    const id = o.dataset.out || "";
    const was = state.outScrolls[id];
    if (was && !consolePinned(id) && !was.atBottom) {
      setScroll(o, Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
      continue;
    }
    setScroll(o, o.scrollHeight);
  }
  // A child's console lives in the same card and was built by the same insert, so it is in the same state.
  applySubConsoleScrolls(root);
}

// A repainted strip and a rebuilt card both REPLACE the node a child's console lives in, so its position cannot ride
// on the element the way holdScrolls() carries a moved one: it is remembered by child id and written back onto the
// fresh node in the same task. A box still following its newest line goes to the bottom; one the reader took over
// goes back to the line they left it on. A box that fits its content has nowhere to go and is left alone.
function applySubConsoleScrolls(root, { follow = false } = {}) {
  if (!root) return;
  for (const box of root.querySelectorAll(".sub-console[data-sub-console-box]")) {
    const id = box.dataset.subConsoleBox || "";
    if (!id) continue;
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) continue;
    if (follow || state.subConsolePinned.get(id) !== false) {
      setScroll(box, max);
      continue;
    }
    const top = state.subConsoleTop.get(id);
    if (top != null) setScroll(box, Math.min(top, max));
  }
}

// ---- moving nodes without losing what is scrolled inside them ------------------------------------------------
// Appending a node that is already in the page is a remove-then-insert: the subtree leaves the layout tree and comes
// back as a fresh scroll area at `scrollTop = 0`. That is the one kind of jump no scroll code writes, and it is what
// reads as two consoles fighting each other while one of them is written to: the move that reset them was about a
// third thing on the board (a closed section's rank, another row's place), and every console inside the moved
// subtree went to its first line in the same frame. So a move here only touches the elements that are actually out
// of place, and whatever does move holds its scroll boxes across the move, in the same task, so no frame is painted
// at 0 and no reader waits for the 400 ms sweep to hand their place back.
function placeInOrder(parent, want) {
  // Backwards, so every element is put down relative to a successor that is already where the order asks it to be.
  // An element whose next sibling is already the right one is never detached at all - that is the whole point.
  let moved = 0;
  for (let i = want.length - 1; i >= 0; i--) {
    const el = want[i];
    if (!el) continue;
    const next = want[i + 1] || null;
    if (el.parentNode === parent && el.nextElementSibling === next) continue;
    parent.insertBefore(el, next);
    moved += 1;
  }
  return moved;
}

// Where every scroll box in this subtree stands, read BEFORE anything is moved: a read taken after the move reads the
// 0 the move left, and a restore built on that writes the reader back to the top.
function holdScrolls(root) {
  const held = [];
  if (!root) return held;
  for (const el of root.querySelectorAll("pre.job-out, .sub-console")) {
    const sub = el.classList.contains("sub-console");
    held.push({
      el,
      sub,
      top: el.scrollTop,
      key: sub ? el.dataset.subConsoleBox || "" : el.dataset.out || "",
    });
  }
  return held;
}

// Put them back. A box still pinned follows its newest line (what it holds may have grown with the move); one the
// reader took over goes back to the line they were on.
function releaseScrolls(held) {
  for (const h of held || []) {
    const el = h.el;
    if (!el || !el.isConnected) continue;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) continue;
    const pinned = h.sub ? state.subConsolePinned.get(h.key) !== false : consolePinned(h.key);
    setScroll(el, pinned ? max : Math.min(h.top, max));
  }
}
// A card that is taken out of the document and put back (fillAgentSlots) is a fresh scroll area at its first line,
// so the child consoles inside it are held by the element, exactly as holdScrolls() holds a moved section's boxes.
// Only the child consoles: pre.job-out and the thinking bodies are restored by their own ids in the paths below.
function holdSubConsoles(root) {
  const held = [];
  if (!root) return held;
  for (const el of root.querySelectorAll(".sub-console[data-sub-console-box]")) {
    held.push({ el, think: false, sub: true, top: el.scrollTop, key: el.dataset.subConsoleBox || "" });
  }
  return held;
}
// ---- end moving nodes without losing what is scrolled inside them

// Scrolling at all is the reader taking over just as much as a click is: stop pulling the page back to
// the spawned agent. The wheel was the only gesture watched, so a scrollbar drag, Page Down or a
// trackpad fling still got yanked back a moment later - which is the "it pops me back up to the box"
// report. pendingScrollAt stamps our own one-time jump so it is not read as the reader scrolling.
let pendingScrollAt = 0;
// Every scroll the panel performs on purpose stamps this. The follow below ends on a READER scroll - and the
// panel's own aim/follow jumps (up to the New-agent card, then down to the new agent) are not that.
function programmaticScroll() {
  pendingScrollAt = Date.now();
}
const endFollowOnScroll = (e) => {
  if (Date.now() - pendingScrollAt < 600) return;
  // Only the page counts. A console scrolling its own output (captured here because scroll does not
  // bubble but capture sees every descendant) is the agent working, not the reader leaving.
  const t = e && e.target;
  const page = !t || t === document || t === document.scrollingElement || t === window || t === document.documentElement;
  if (!page) return;
  if (state.pendingFocus) state.pendingFocus = null;
};

// ---- the live thought, as a row of the console -------------------------------------------------------
// The card a turn is drawn in owns the 🧠 answer; a turn of an assistant's can carry a thread of its own,
// so the switch is read from the card the console is in, exactly as the settled renderer reads it.
function cardThreadOf(id) {
  const out = document.querySelector(`pre.job-out[data-out="${CSS.escape(String(id))}"]`);
  const card = out?.closest?.(".job[data-thread]");
  return card?.dataset?.thread || state.jobs.get(id)?.thread || String(id);
}

// The turn's own console buffer, created the way recordJobLine creates one: seeded from the record's
// tail when the turn is live, so a tab that joined mid-turn does not lose the lines above the preview.
function consoleBufferFor(turn) {
  let buf = state.jobLines.get(turn.id);
  if (buf) return buf;
  const rec = state.jobs.get(turn.id);
  buf = turnLive(rec) && Array.isArray(rec.lines) ? rec.lines.slice() : [];
  state.jobLines.set(turn.id, buf);
  return buf;
}

// One frame of a live thought. It grows the block its `at` names; a new `at` closes the previous
// live block (its mark stops) and starts a block of its own, which is drawn after whatever the last
// tool left in the console. `thinkFrom` is the offset the words start at inside the block, so a tab
// that joined mid-block begins where it attached and a contiguous chunk is spliced on.
function growLiveThought(turn, line) {
  const at = Number(line.at) || Date.now();
  const entry = state.thinkCache.get(turn.id) || { blocks: [], at: 0 };
  const chunk = String(line.think);
  const from = Number(line.thinkFrom) || 0;
  const changed = [];
  let block = entry.blocks.find((b) => b && b.preview && Number(b.at) === at) || null;
  if (!block) {
    for (const b of entry.blocks) {
      if (b && b.preview && b.live) {
        b.live = false;
        changed.push(b);
      }
    }
    block = { at, text: "", live: true, preview: true, base: 0 };
    entry.blocks.push(block);
    entry.blocks.sort((a, b) => Number(a.at) - Number(b.at));
  }
  const base = Number(block.base) || 0;
  const had = String(block.text || "");
  const end = base + had.length;
  // A row NEVER loses a character it has already drawn. Four cases, and the one row #285 was is the third:
  //  - the frame continues the row: append (the ordinary path);
  //  - the row has nothing yet: it starts where this frame does (a tab that attached mid-block);
  //  - the frame starts PAST the row's end (a frame no reader ever drew). The row keeps every word it has and adds
  //    the new ones. The old rule replaced the text with the chunk here, so a row whose preview the store read had
  //    just dropped (reconcileThinking) was rebuilt from a later delta alone and began mid-sentence, which is the
  //    reader's screenshot. The store read fills the seam: reconcileThinking hands the row the block's own
  //    characters for its slice;
  //  - the frame rewrites the row from inside it (the wire resent a piece, or a trim moved the block): keep the words
  //    BEFORE that offset and take the frame from there on. A frame that rewinds before the row's own start replaces
  //    it, because nothing it holds belongs to that text any more.
  if (from > 0 && from === end) block.text = had + chunk;
  else if (!had) {
    block.base = from; // nothing drawn yet: the row starts where this frame does
    block.text = chunk;
  } else if (from >= base && from < end) block.text = had.slice(0, from - base) + chunk;
  else if (from > end) {
    block.text = had + chunk;
    block.gap = true;
  } else {
    block.base = from;
    block.text = chunk;
  }
  block.live = true;
  changed.push(block);
  state.thinkCache.set(turn.id, { blocks: entry.blocks, at: Date.now() });
  syncThoughtRows(turn, changed);
}

// A thought stopped: the row keeps every word it has and loses only the mark. `at` of 0 stops
// whichever block is live, which is what a call or the terminal line does.
function endLiveThought(turn, at = 0) {
  if (!turn) return;
  const entry = state.thinkCache.get(turn.id);
  if (!entry) return;
  const changed = [];
  for (const b of entry.blocks) {
    if (!b || !b.preview || !b.live) continue;
    if (at && Number(b.at) !== at) continue;
    b.live = false;
    changed.push(b);
  }
  if (!changed.length) return;
  state.thinkCache.set(turn.id, { blocks: entry.blocks, at: Date.now() });
  syncThoughtRows(turn, changed);
}

// Put the preview rows in the turn's console record, in arrival order, and draw the ones that moved.
// A preview line is marked `preview` so the settled read takes it out again: the store's block replaces
// it by `at`, never beside it. When the card's 🧠 is off the row is not drawn, but the block is still
// kept, so turning it on mid-turn paints what has already been read.
function syncThoughtRows(turn, blocks) {
  if (!state.jobLines) return;
  const shown = thinkingOn(cardThreadOf(turn.id));
  const buf = consoleBufferFor(turn);
  for (const block of blocks) {
    const line = {
      kind: "think",
      lid: thinkLid(block.at),
      at: Number(block.at) || Date.now(),
      text: String(block.text ?? ""),
      preview: true,
      live: Boolean(block.live),
    };
    const i = buf.findIndex((l) => l && l.preview && String(l.lid) === line.lid);
    if (i >= 0) buf[i] = { ...buf[i], ...line };
    else buf.push(line);
    if (shown) drawJobLine({ id: turn.id, line: { ...line, mode: i >= 0 ? "set" : "new" } });
  }
  trimJobLines?.();
}
// ---- end the live thought ----------------------------------------------------------------------------

function appendJobLine(evt) {
  // The run's live numbers ride the line they belong to: a jobline frame carries them (lib/jobs.js emitLine),
  // so the pulse's age advances with the output instead of needing a summary frame per token.
  if (evt.live) {
    const job = state.jobs.get(evt.id);
    if (job) job.live = evt.live;
  }
  const line = evt.line || {};
  // A reasoning frame: `line.think` is the words since the last frame, `line.thinkFrom` their offset in
  // the block, and `at` names the block. The console draws it as a row of its own, in arrival order, and
  // a NEW `at` starts a new row rather than growing the one above the call it has already led to.
  if (line.think || line.thinkEnd) {
    const turn = state.jobs.get(evt.id);
    if (turn) {
      if (line.think) growLiveThought(turn, line);
      if (line.thinkEnd) endLiveThought(turn, Number(line.at) || 0);
    }
  }
  // The frames above are a PUSHED PREVIEW of a thought, not record lines: lib/jobs.js emits them
  // coalesced, keyed by a stable `at`, as the words since the last frame. growLiveThought() has already
  // put the row in the console and drawn it; returning here keeps the preview out of the line-by-line
  // hold and out of the server's record. `thinkEnd` is the same idea: the row's mark stops, nothing is
  // recorded. One frame per token would otherwise flood the transcript and repaint the console.
  if (line.thinkOnly) return;
  // A call or the turn's terminal line ends the thought above it in the stream: its mark stops here even
  // when the server's own thinkEnd frame was lost, and the row keeps its words.
  if (line.kind === "tool" || line.kind === "tool-out" || line.kind === "result") endLiveThought(state.jobs.get(evt.id), 0);
  // The line-by-line setting holds a burst of whole lines and lets them in one at a time. Bookkeeping never waits:
  // the `result` line is what says the turn ended, and it is also the frame that flushes both buffers. A hidden tab
  // is not reading anything, so it never holds a line either — the answer is there in full when the reader returns.
  if (!document.hidden && !isBookkeeping(line) && state.typeHold?.push(evt)) return;
  if (!document.hidden && !isBookkeeping(line) && state.typeGate?.push(evt)) return;
  // The turn is over: what the reasoning hold is keeping goes into the console BEFORE the line that says so.
  if (line.kind === "result") state.typeHold?.drain(evt.id);
  recordJobLine(evt);
  drawJobLine(evt);
  if (line.kind === "result") flushTypeStream(evt.id);
}

// The console's own record of the turn — the lines a rebuild draws from. A held line is not in here yet, so a
// repaint mid-burst shows the transcript as far as it has got.
//
// The buffer is trimmed to the same number of lines the panel keeps for a turn (lib/jobs.js MAX_LINES), not a longer
// one of its own: at 1,000 against the server's 600 the tab held lines the panel had already dropped, and no snapshot
// ever told it so. One number on both sides of the wire, and the page can never show a console the server has
// forgotten the tail of.
const JOB_LINES_PER_TURN = 600;

function recordJobLine(evt) {
  const line = evt.line || {};
  let buf = state.jobLines.get(evt.id);
  if (!buf) {
    // This is the only place a buffer is created. A snapshot used to seed one for every record it carried, which
    // retained the record's 60-line tail twice for every turn on the board; the card draws that tail from the record
    // itself now (`jobLines()`), so a buffer is only needed once a line is actually going into it — and then it
    // starts from the tail the card is already showing, or a turn that was running before this tab opened would
    // read as if it began at the first frame that arrived.
    const rec = state.jobs.get(evt.id);
    buf = turnLive(rec) && Array.isArray(rec.lines) ? rec.lines.slice() : [];
  }
  // mode "set" = the agent is still writing the same paragraph; that line grows in place
  // instead of a new one being pushed for every streamed fragment.
  //
  // A prose line's own newlines are PHYSICAL lines (core/console-markdown.js, consoleMdPhysicalLines): the record
  // keeps them apart so a live append and a rebuild draw the same blocks, and so the stream is asked about the row
  // that is actually on screen. A line that grows into more of them updates the rows where they stand and slots the
  // new ones in beside them, rather than at the end of the buffer: lib/jobs.js can move on to a tool line and then
  // keep writing the same paragraph.
  const base = line.lid == null || line.lid === "" ? null : String(line.lid);
  const owned = (l) => base != null && (String(l.lid ?? "") === base || String(l.lid ?? "").startsWith(`${base}.`));
  const at = base == null ? -1 : buf.findIndex(owned);
  const segs = consoleMdIsProse(line.kind) ? consoleMdPhysicalLines([line]) : null;
  if (segs && (segs.length > 1 || (line.mode === "set" && at >= 0))) {
    if (at >= 0) {
      let n = 0;
      while (at + n < buf.length && owned(buf[at + n])) n += 1;
      buf.splice(at, n, ...segs);
    } else buf.push(...segs);
  } else if (line.mode === "set" && at >= 0) {
    buf[at] = { ...buf[at], ...line };
  } else buf.push(line);
  if (buf.length > JOB_LINES_PER_TURN) buf.splice(0, buf.length - JOB_LINES_PER_TURN);
  state.jobLines.set(evt.id, buf);
  // One bump per recorded line. This is the counter a stream repaint asks before it rebuilds: the line this event
  // carries has already been DRAWN by drawJobLine below, which stamps the console with this version, so a store read
  // that would draw the same window has nothing to add (see paintStreamConsole).
  if (!state.jobLineVersion) state.jobLineVersion = new Map();
  state.jobLineVersion.set(evt.id, (state.jobLineVersion.get(evt.id) || 0) + 1);
  // A new buffer is also the moment the tab can cross its ceiling on how many turns it holds one for.
  trimJobLines();
  // A folded turn shows only the peek, and it is not part of the console the lines are appended to.
  refreshTurnPeek(state.jobs.get(evt.id));
}

// One line into every pane showing this turn.
function drawJobLine(evt) {
  const line = evt.line || {};
  // Kept in the buffer, never drawn: see BOOKKEEPING_LINES above.
  if (isBookkeeping(line)) return;
  // A prose line can carry several physical lines of its own (core/console-markdown.js, consoleMdPhysicalLines):
  // each one joins the block it belongs to, so a paragraph, a list and a heading that arrived inside ONE line are
  // drawn as those shapes and not as one run-on paragraph. The first segment keeps the line's own id, so a line that
  // grows a newline later updates the row already on screen instead of drawing it a second time.
  if (consoleMdIsProse(line.kind)) {
    const segs = consoleMdPhysicalLines([line]);
    if (segs.length > 1) {
      for (const seg of segs) drawJobLine({ ...evt, line: seg });
      return;
    }
  }
  // A pinned turn renders twice — in its page and in the pinned block above — so every pane carrying
  // this id (or its "@pin" copy) gets the line.
  const outs = placedNodes("pre.job-out")
    .filter((el) => el.dataset.out === evt.id || el.dataset.out === `${evt.id}@pin`)
    .map(wireConsole);
  if (!outs.length) return;
  // The words of a growing paragraph that may be drawn now: the stream holds the tail and releases it on its own
  // clock, so the console fills in a word or two at a time instead of a coalesced phrase at a time.
  const shownText = line.kind === "text" ? typedText(line, evt.id) : line.text;
  // Whether this turn is drawn as ONE stream. Only that console sets a piece apart from the piece above it: the
  // condensed layout keeps its own margins, which is the layout it already had. There is one console now, so
  // every turn is drawn as that stream.
  const streaming = true;
  for (const out of outs) {
    // Streamed lines follow the newest output only for a reader who is already at the bottom; someone
    // scrolled up to read stays where they are. The answer comes from the console's own remembered state (set by its
    // scroll events), not from a layout read per line.
    const stick = consolePinned(out.dataset.out) || out._atBottom !== false;
    // Only the placeholder an empty console shows gives way to the first line. This used to ask whether the first CHILD
    // was dim, but a dim line is transcript too ("⇢ asked to work in …", "cut from …", "push guard: …") and every
    // repaint — the thinking sweep, a new deliverable, an approval — puts one back on top, so the next live line wiped
    // everything the reader had on screen and drew only itself until the following repaint put it all back.
    // The placeholder an empty console shows gives way to the first line. This used to ask the selector engine for it
    // once per line; the node is held by reference from wireConsole, so a row that stops existing costs a comparison.
    const wait = out._wait;
    if (wait) {
      if (wait.isConnected) wait.remove();
      out._wait = null;
    }
    // A thought is a row of the stream. The same lid on a later frame is the SAME row grown (or its mark
    // stopping), so the node, its open state and the reader's place in it all survive the words arriving.
    if (line.kind === "think") {
      const existing = line.lid ? lidRows(out, line.lid)[0] || null : null;
      if (existing) {
        patchThinkRow(existing, line);
      } else {
        const holder = document.createElement("div");
        holder.innerHTML = thinkRowHtml(line, out.lastElementChild ? "jl-sep" : "");
        const fresh = holder.firstElementChild;
        if (fresh) {
          out.appendChild(fresh);
          indexSubtree(out, fresh);
          // The markup can only draw the section, not measure it: the lid's cut is this console's width, so it is
          // taken now that the row is in the page (a row in a collapsed card is finished by sweepThinkLids).
          fitThinkRow(fresh);
        }
      }
      grew(out);
      if (stick && !globalThis.consoleHeld?.(out)) stickSoon(out);
      out._drawnVer = (state.jobLineVersion && state.jobLineVersion.get(evt.id)) || 0;
      continue;
    }
    // A tool call joins the burst at the tail of the console and updates its tally in place; anything said in
    // between ends that burst, so the next call starts a fresh tally where the transcript has got to.
    const isTool = line.kind === "tool" || line.kind === "tool-out";
    const tail = out.lastElementChild;
    // Whether this line belongs in the burst already at the tail. A call that follows a result, or one a reasoning
    // block was written after, starts the next burst — the same cut `segments()` makes on the next repaint, so the
    // append and the poll cannot disagree about where the row lives (a row that joins and is then cut out again is
    // one the reader sees leave one box and appear in the next).
    const tailLines = isTool && tail && tail.classList.contains("tgrp") ? tail._burst || groupLines(tail) : null;
    // A tool-usage group is a RUN of calls: a call that arrives after the result above it still belongs in the same
    // group, because the group is what the two rules bracket and the run is what they bracket. Prose ends it (the
    // tail stops being a `.tgrp`), and the condensed view keeps its own cut — there a group is the burst the head
    // row tallies, and `joinsTail` is what keeps the append and that repaint honest.
    const tailFlat = Boolean(tail && tail.classList.contains("tgrp") && tail.dataset.gflat === "1");
    const joins = tailFlat
      ? true
      : !tailLines || !globalThis.wtStream || typeof globalThis.wtStream.joinsTail !== "function"
        ? true
        : globalThis.wtStream.joinsTail(
            (state.jobLines.get(evt.id) || []).filter((l) => !isBookkeeping(l)),
            line,
            state.thinkCache.get(evt.id)?.blocks || [],
            tailLines,
          );
    const openGroup = isTool && tail && tail.classList.contains("tgrp") && joins ? tail : null;
    if (isTool) {
      // A call ends the prose: the next sentence starts its own block rather than being appended to a paragraph
      // that sits above a tool row.
      out._md = null;
      const key = openGroup ? openGroup.dataset.tgrp : `${evt.id}#${Date.now().toString(36)}`;
      // A group that came from a full render has no `_burst`; read its lines back from the DOM so the new call joins
      // the burst the reader is looking at instead of starting a group that shows this line alone.
      const lines = [...(openGroup && tailLines ? tailLines : []), line];
      // The lines of a skill's result are written, not dropped in: this is where each one is handed to the stream, BEFORE
      // the burst is drawn, so its first paint already shows only the words that may be shown.
      paceResultLine(lines, line, evt.id);
      // A tool chosen by the reader keeps its filter and open body while the burst grows under it.
      const filter = openGroup ? openGroup.dataset.filter || "" : "";
      const bodyEl = openGroup ? openGroup.querySelector(".tgrp-body") : null;
      // A growing burst keeps the offset it was rendered with; a new one starts where this console's earlier bursts
      // stopped consuming this tool's rows.
      let gofs = null;
      if (openGroup) {
        try {
          gofs = openGroup.dataset.gofs ? JSON.parse(openGroup.dataset.gofs) : null;
        } catch {
          gofs = null;
        }
      } else {
        gofs = storeOffsetsBefore(out, null);
      }
      // The group already on screen says whether this console is drawn as a stream; a new one asks its card. A flat
      // piece has no head row and no "N lines" button, so a call appended to it must not grow one back. A NEW group
      // in a card is flat when the reader turned the tally off (Settings > Count tool calls) - the append has to
      // draw the shape the repaint will, or the next repaint would move every row of the burst.
      const flat = openGroup ? openGroup.dataset.gflat === "1" : streaming || !toolGroupsOn();
      // The blank line a reasoning block has always had, before every piece of a stream: a group that opens where
      // another piece already stands is set apart from it, and a group growing in place keeps the separation it was
      // drawn with (the same piece, not a new one). The condensed console has no such blank line, so a flat group
      // there takes none: `streaming`, not `flat`, is what decides.
      const sep = streaming && (openGroup ? openGroup.classList.contains("jl-sep") : Boolean(out.lastElementChild));
      const holder = document.createElement("div");
      holder.innerHTML = toolGroupHtml(lines, key, filter, bodyEl ? !bodyEl.hidden : false, openGroup ? openGroup.dataset.gat || "" : "", gofs, flat ? { flat: true, sep } : {});
      const fresh = holder.firstElementChild;
      if (fresh) {
        fresh._burst = lines;
        if (openGroup) {
          unindexSubtree(out, openGroup);
          openGroup.replaceWith(fresh);
        } else out.appendChild(fresh);
        indexSubtree(out, fresh);
        rememberToolGroup(fresh);
      }
    } else if (out.dataset.rawView === "1") {
      // The raw view is the turn's own bytes, so a line that lands while it is open is part of them: repaint the
      // text, never append a rendered row beside it.
      paintRawConsole(out);
    } else {
      const existing = line.lid ? lidRows(out, line.lid)[0] || null : null;
      if (line.mode === "set" && existing) {
        // One rule for both writers: append what the row is missing when it can, reparse it only when it must.
        drawRowText(existing, shownText);
        existing.dataset.ltext = String(line.text ?? "");
        // The wait is over (lib/jobs.js annotated the same row): the sentence that replaced it is the record now, so
        // the age stops ticking and no clock keeps writing over the annotation.
        if (existing.dataset.gwait) {
          delete existing.dataset.gwait;
          existing.classList.remove("jl-gwait", "is-silent");
        }
      } else if (consoleMdIsProse(line.kind)) {
        // The agent's own words join the block already open (a paragraph, a list, a fence) or start the next one.
        // Appending one row is the whole cost of a streamed line: nothing above it is repainted.
        indexSubtree(out, appendProseLine(out, line, streaming, shownText));
      } else {
        out._md = null;
        const waiting = line.wait === "gateway";
        const div = document.createElement("div");
        div.className = `jl jl-${line.kind || "raw"}${waiting ? " jl-gwait" : ""}`;
        // A chunk of normal output is a piece of the stream too: the same blank line above it, unless it is the
        // console's first piece. Only the 🌊 console draws that — this is the layout the condensed one already had.
        if (streaming && out.lastElementChild) div.classList.add("jl-sep");
        if (line.lid) div.dataset.lid = line.lid;
        // The line's own text travels with it, the same way a rendered line carries it: a rebuild reads lines
        // back out of the DOM, and this one must read as what was said rather than as what was drawn.
        div.dataset.ltext = String(line.text ?? "");
        div.dataset.lkind = String(line.kind || "raw");
        if (waiting) {
          // The console's statement that a live run's stream has said nothing yet, with the age the card's clock
          // ticks from this stamp. Drawn the same shape a repaint draws (public/board/console.js waitLineHtml).
          div.dataset.gwait = String(Number(line.at) || Date.now());
          div.innerHTML = waitLineHtml(line);
        } else drawRowText(div, shownText);
        out.appendChild(div);
        indexSubtree(out, div);
      }
    }
    grew(out);
    if (stick && !globalThis.consoleHeld?.(out)) stickSoon(out);
    // What this console has now drawn. recordJobLine draws every line it records, so a console whose marker equals
    // the store's version is CURRENT - and the 1 Hz sweep has nothing to rebuild. This is the version gate the
    // report asked for: without it 16 full 300-line window builds and 12248 drawJobLine calls ran in one 24 s window
    // on a page whose append path had already drawn every one of those lines.
    out._drawnVer = (state.jobLineVersion && state.jobLineVersion.get(evt.id)) || 0;
  }
  refreshJobPreview(evt.id);
}
