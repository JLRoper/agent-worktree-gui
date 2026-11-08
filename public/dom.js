// dom.js - the page's DOM primitives, cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 22,000 lines and a third of the board's work landed in it, so one
// file was one lane. This is step 2 of the order of work in docs/reports/module-map-2026-11-07.html ("dom.js out
// of app.js. Everything else depends on these helpers, so cutting them first makes the later cuts small"), moved
// line for line: not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   rowNode, projectNode       the two cached node lookups. A lookup by ATTRIBUTE VALUE walks the whole document,
//                              and both of these run on every agent event and on every row placed (see
//                              test/board-lookups.test.js, which measures the lookups these two exist to avoid).
//   restartClassAnimation      restart a one-shot animation a class carries, without a forced layout.
//   beginDomMove, endDomMove   the bracket around a repaint that moves nodes out of the page and back. The depth
//                              they keep is read by the caret claim in app.js, by bare name.
//   selectionIn                is the reader's selection standing in this element?
//   captureCardSelection,      the selection save and restore across a rebuild: a detached Range cannot be put
//   restoreCardSelection       back, so what is recorded is where it stood and it is rebuilt afterwards.
//   offsetIn, pointAt          the character-offset arithmetic those two are built on.
//   cardForThread              which copy of a thread's card is the board's (not the unattached panel's).
//   copyText                   the clipboard writer and its textarea fallback: the panel is served over http on
//                              loopback, which browsers do not always treat as a secure context.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.rowEls   rowNode's node map, kept by placeRow in app.js. This is the module's only back-edge, and it is
//                  the same kind of edge core/dom-format.js already has to `state`.
//   CSS.escape     the two lookups, and the selectors cardForThread builds.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare name.
// This file DECLARES ONLY - nothing in it reads an app.js binding while it loads, so sitting before app.js costs
// nothing and cannot land in a temporal dead zone. public/app.js re-exports these names on window.WMApp.dom.

// One call brackets a move: while a move is open a blur leaves the reader's caret claim alone, and the restore
// that ends the move puts the caret back. The depth is a top-level `let`, so app.js reads it by bare name.
let domMoveDepth = 0;
function beginDomMove() {
  domMoveDepth += 1;
}
function endDomMove() {
  domMoveDepth = Math.max(0, domMoveDepth - 1);
}

// navigator.clipboard needs a secure context; the panel is served over http on loopback, which
// browsers do NOT always treat as secure, so there is a textarea fallback behind it.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// Is the reader's selection standing in this element? A non-collapsed range counts wherever it touches: a drag that
// started before the readout and runs off its end has endpoints outside it and still owns the text between them.
function selectionIn(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (el.contains(r.startContainer) || el.contains(r.endContainer) || r.intersectsNode(el)) return true;
  }
  return false;
}

// A board rebuild detaches every card and puts it back, and the browser drops the selection on the way through: a
// saved `Range` does not bring it back (measured — a clone whose boundary nodes are connected again, reattached card,
// `addRange` leaves `getSelection()` empty and collapsed; the boundary points died with the subtree). What survives
// is where in the readout the selection stood, so that is what is recorded: the card it belongs to and a character
// offset into its usage readout. A rebuild re-renders that markup, so the range is rebuilt against the nodes that are
// actually on screen afterwards.
function offsetIn(root, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(root);
  try {
    r.setEnd(node, offset);
  } catch {
    return null;
  }
  return r.toString().length;
}

// The text node and offset at character position `n` inside `root`.
function pointAt(root, n) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last = null;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const len = t.data.length;
    if (n <= seen + len) return { node: t, offset: n - seen };
    seen += len;
    last = t;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

// Which copy of a thread's card to restore onto: the board's, not the unattached panel's, when both exist.
function cardForThread(thread) {
  const cards = [...document.querySelectorAll(`.job[data-thread="${CSS.escape(thread)}"]`)];
  return cards.find((c) => c.closest("tr.detail")) || cards[0] || null;
}

function captureCardSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const held = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (r.collapsed) continue;
    const startEl = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const card = startEl?.closest?.(".job[data-thread]");
    if (!card) continue;
    // The readout when the selection sits in it, the whole card otherwise.
    const root = startEl.closest("[data-stats]") || card;
    if (!root.contains(r.endContainer)) continue;
    const start = offsetIn(root, r.startContainer, r.startOffset);
    const end = offsetIn(root, r.endContainer, r.endOffset);
    if (start == null || end == null || end <= start) continue;
    held.push({ thread: card.dataset.thread, stats: root !== card, start, end });
  }
  return held.length ? held : null;
}

function restoreCardSelection(held) {
  if (!held || !held.length) return;
  const sel = window.getSelection();
  if (!sel) return;
  // Only when nothing else is selected now: a reader who has picked something else has moved on.
  if (sel.rangeCount && !sel.isCollapsed) return;
  const ranges = [];
  for (const h of held) {
    const card = cardForThread(h.thread);
    const root = card && (h.stats ? card.querySelector("[data-stats]") : card);
    if (!root) continue;
    const a = pointAt(root, h.start);
    const b = pointAt(root, h.end);
    if (!a || !b) continue;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      continue;
    }
    ranges.push(r);
  }
  if (!ranges.length) return;
  sel.removeAllRanges();
  for (const r of ranges) sel.addRange(r);
}

// A worktree row's own node, from the map placeRow keeps, checked before use (still in the page, still this key);
// the document is asked only when the map has no live node. Both callers run on every agent event, and a lookup by
// attribute value walks the whole board.
function rowNode(key) {
  const kept = state.rowEls.get(key);
  if (kept && kept.isConnected && kept.dataset.key === key) return kept;
  return document.querySelector(`#projects tr.row[data-key="${CSS.escape(key)}"]`);
}

// Restart a one-shot animation a class carries, without a forced layout. Taking the class off and putting it back in
// one task needs a reflow between the two (`void el.offsetWidth`) or the browser sees no change, and on a 55k-node
// board that reflow ran on every pulse. A running animation is put back to its first frame instead, and a class
// that is not there is simply added: neither needs layout. Only the instant between an animation ending and its
// class being taken off still pays the reflow.
function restartClassAnimation(el, cls, animationName) {
  if (el.classList.contains(cls)) {
    const running = el.getAnimations().find((a) => a.animationName === animationName);
    if (running) {
      running.currentTime = 0;
      return;
    }
    el.classList.remove(cls);
    void el.offsetWidth;
  }
  el.classList.add(cls);
}

// One project's node by its attribute (its chip strip, its age slot, its age button). A lookup by attribute value
// walks the whole document, and refreshChips runs on every row placed - about 340 calls a minute on the reader's
// board, three lookups each: about 300 ms a minute of querySelector under refreshChips and refreshTopToggle in a
// read-only profile of it. The node found is kept and checked before each use - still in the page, still carrying this
// name - so a section rebuilt from scratch, or a strip some other attribute owner reuses, is simply looked up again.
// The cache hangs off the function itself, so it exists from the first line of this file (a top-level `const` here
// would be in its temporal dead zone for any call made before this point is evaluated).
function projectNode(attr, name) {
  const nodes = (projectNode.nodes ||= new Map());
  const key = `${attr}\u0000${name}`;
  const kept = nodes.get(key);
  if (kept && kept.isConnected && kept.getAttribute(attr) === name) return kept;
  const found = document.querySelector(`[${attr}="${CSS.escape(name)}"]`);
  if (found) nodes.set(key, found);
  else nodes.delete(key);
  return found;
}
