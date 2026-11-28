// queue-drag.js - the queue pane's POINTER GESTURE: the card that follows the pointer, the pane's own edge crawl,
// the drop that writes the reader's order, and the click the browser fires at the end of a drag. Cut out of
// public/queue-cards.js, which is entry 8 of docs/reports/module-separation-2026-11-28.html's split plan
// (public/board/queue-drag.js, the report's 1,100-1,307 of a 1,307-line file).
//
// WHY THIS FILE EXISTS. The report's one measured collision on this file is this gesture: row 443 edits the drag
// today and had to open the same 1,254-line closure as any row editing the card's markup. The drag is 208 of those
// lines, and what it needs from the rest of the pane is a list of cards in drawing order, the ids of that list, the
// rule that refuses a drop, the paint that restores the list, and the one write path. Everything else it reads is
// its own.
//
// WHAT IS HERE
//
//   the drag record           the card being dragged, the moment the last gesture ENDED (the clock that tells the
//                             click the browser fires at the end of a drag from the reader's own press), and the
//                             frame handle of the pane's edge crawl.
//   the pane's edge           queueScrollerOf, and the frame loop that scrolls it while a pointer is held near the
//                             edge, so a card can be put on a row that is not on screen.
//   where a card lands        queueDragPaint: before the first queued card whose midpoint the pointer has passed,
//                             else after the last one; then re-anchored under the pointer.
//   the gesture               queueCardDown / queueCardMove / queueCardUp, the 4 px threshold, the transform, and the
//                             one write: `reorder` with the ids in the order the pane now draws them.
//   the click guard           queueCardClickGuard, which swallows the click a drag leaves behind in the capture phase.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   the row cut               queueCardsIn and queueIdsIn (the pane's list as cards, and as ids), queueDropBlocked
//                             (the hold rule a drop is judged by), and the read cache and the refusal line it shares.
//   the card cut              renderAssistantQueue (the drop repaints from the answer) and queueAct (the one write).
//   the drag record it puts BACK on the page's own state, and the one fact the card cut reads off it: `dragLive` is
//                             a function rather than a copied binding, because `queueDrag` is this file's own `let`
//                             and a constant handed to another factory would stop seeing the assignment.
//
// THE LOAD CONTRACT. This file declares ONE thing: a factory. public/index.html loads it before public/queue-cards.js,
// and that entry point builds it last, after the row and the card cuts, because it reads their names. Nothing here
// touches the document while it loads. The queue sub-tab marker pair below is the test harnesses' slice, kept
// verbatim so the existing slice tests still find the code they drive.


window.WMApp = window.WMApp || {};
window.WMApp.queueDrag = function queueDrag(deps) {
  "use strict";
  const { row, detail } = deps;
  // The row cut's list helpers and the two shared bindings, and the card cut's paint and write path.
  const { queueCache, queueDropNotes, queueCardsIn, queueIdsIn, queueDropBlocked } = row;
  const { renderAssistantQueue, queueAct } = detail;

  // ---- the queue sub-tab ------------------------------------------------------------------------

  // The drag record stays here until its own cut (queue-drag.js): the gesture below is the only code that
  // assigns it, and a `let` cannot be handed to a factory the way a Map can. It sits INSIDE the harnesses'
  // region on purpose - a slice that draws the pane reads it.
  let queueDrag = null;
  let queueDragEnded = 0;

  // ---- dragging a card into a new place ------------------------------------------------------------
  //
  // The order the pane draws is state bucket → `order` → id, so a drag only ever changes the middle term, and only
  // inside the QUEUED bucket: running, parked and done cards are not `.is-draggable` and never start a gesture. The
  // card itself is what moves — the pointer crossing a queued card's midpoint re-inserts it before that card, and the
  // transform keeps it under the pointer across the reflow — so what the reader sees before the drop is the list the
  // drop sends.
  //
  // Two rules make this safe beside a body that is itself a click target:
  //   - nothing happens until the pointer has TRAVELLED (4 px): a press and a release on the spot is the reader's
  //     click, and it reaches the opener untouched;
  //   - the click the browser fires at the end of a drag is swallowed by `queueCardClickGuard`, judged by the clock
  //     `queueDragEnded` stamps. A drag must never open a card.
  const QUEUE_DRAG_THRESHOLD = 4;

  // ---- the pane's own edge: a held gesture scrolls the list -----------------------------------------
  //
  // The pane is usually SHORTER than the queue — nine queued cards in the 480 px rail are taller than the window it
  // draws — and a pointer cannot travel past the edge of the box it is in. Without the crawl below, a card could only
  // be put where a visible card is: the pointer stopped at the edge and the drop landed on whatever midpoint it had
  // last crossed, while the reader was aiming at a row further down. That is the reader's "it does not drag and drop
  // like it says", so the frame loop is part of the gesture, not a decoration on it.
  //
  // The edge band is measured on the SCROLLER, not the pane: the rail and the float both scroll in `.as-body`, and a
  // narrow enough window falls back to the document, so the walk starts at the pane and takes the first ancestor that
  // can actually move. Speed ramps from nothing at the band's inner edge to full at the box's edge, which is what makes
  // a small overshoot crawl and a deliberate one travel.
  const QUEUE_SCROLL_EDGE = 26;
  const QUEUE_SCROLL_STEP = 14;
  let queueDragRaf = 0;
  function queueScrollerOf(el) {
    for (let n = el?.closest?.('[data-subpane="queue"]') || null; n && n !== document.body; n = n.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
      if (n.scrollHeight <= n.clientHeight + 1) continue;
      return n;
    }
    const doc = document.scrollingElement;
    return doc && doc.scrollHeight > doc.clientHeight + 1 ? doc : null;
  }
  function queueScrollBy(d, dy) {
    const s = d.scroller;
    if (!s) return 0;
    const before = s.scrollTop;
    s.scrollTop = Math.max(0, Math.min(s.scrollHeight - s.clientHeight, before + dy));
    return s.scrollTop - before;
  }
  // Where the card lands, and where it is drawn. Split out because a scroll moves the LIST under a pointer that has
  // not moved: the same decision has to run again with the pointer where it already is.
  function queueDragPaint(d, clientY) {
    // Where the card would land: before the first queued card whose midpoint the pointer has passed, else after the
    // last one. Only queued cards take part — the three fixed sections never swap places with the drag.
    const cards = queueCardsIn(d.el).filter((c) => c !== d.el && c.dataset.asQstate === "queued");
    const at = cards.find((c) => {
      const box = c.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    if (at) {
      if (d.el.nextElementSibling !== at) at.parentElement.insertBefore(d.el, at);
    } else if (cards.length) {
      const last = cards[cards.length - 1];
      if (d.el.previousElementSibling !== last) last.parentElement.insertBefore(d.el, last.nextElementSibling);
    }
    // Re-anchor under the pointer: a DOM move changes the card's layout top, and the transform is measured from that
    // top, so it is recomputed from the box the browser just laid out rather than accumulated from deltas.
    const layoutTop = d.el.getBoundingClientRect().top - d.translate;
    d.translate = Math.round(clientY - d.grab - layoutTop);
    d.el.style.transform = `translateY(${d.translate}px)`;
  }
  function queueDragFrame() {
    const d = queueDrag;
    if (!d || !d.moved) {
      queueDragRaf = 0;
      return;
    }
    let dy = 0;
    const box = d.scroller?.getBoundingClientRect?.();
    if (box && box.height > 0) {
      const top = box.top + QUEUE_SCROLL_EDGE;
      const bottom = box.bottom - QUEUE_SCROLL_EDGE;
      if (d.y < top) dy = -Math.ceil(QUEUE_SCROLL_STEP * Math.min(1, (top - d.y) / QUEUE_SCROLL_EDGE));
      else if (d.y > bottom) dy = Math.ceil(QUEUE_SCROLL_STEP * Math.min(1, (d.y - bottom) / QUEUE_SCROLL_EDGE));
    }
    // The crawl only re-decides the drop when it actually moved the list: a pointer parked far from either edge costs
    // one comparison a frame and nothing else.
    if (dy && queueScrollBy(d, dy)) queueDragPaint(d, d.y);
    queueDragRaf = requestAnimationFrame(queueDragFrame);
  }
  const queueDragScrollStart = () => {
    if (!queueDragRaf) queueDragRaf = requestAnimationFrame(queueDragFrame);
  };
  const queueDragScrollStop = () => {
    if (queueDragRaf) cancelAnimationFrame(queueDragRaf);
    queueDragRaf = 0;
  };

  function queueCardDown(e) {
    if (queueDrag || e.button !== 0) return;
    const el = e.target?.closest?.(".as-task.is-draggable");
    if (!el) return;
    // A press on a control is that control's, not the card's: the glyphs, the Move popover, any field — and the
    // row's own disclosure, whose summary must toggle instead of starting a drag.
    if (e.target.closest("button, a, input, select, textarea, label, .as-qmove-pop, summary, .as-task-more")) return;
    const rect = el.getBoundingClientRect();
    queueDrag = {
      el,
      own: String(el.dataset.asQown || ""),
      // The box a held gesture has to crawl. Measured once: the frame it has to move cannot change mid-press without
      // the pane being rebuilt, and the pane is not rebuilt while a drag is live.
      scroller: queueScrollerOf(el),
      startY: e.clientY,
      y: e.clientY,
      grab: e.clientY - rect.top,
      translate: 0,
      moved: false,
      before: queueIdsIn(el),
    };
    // No text selection and no native drag for the length of the press: without this the browser starts selecting the
    // card's own text the moment the pointer moves.
    e.preventDefault();
  }

  function queueCardMove(e) {
    const d = queueDrag;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < QUEUE_DRAG_THRESHOLD) return;
      d.moved = true;
      d.el.classList.add("is-dragging");
      d.el.closest('[data-subpane="queue"]')?.classList.add("as-qdrag");
      queueDropNotes.delete(d.own);
      // The crawl starts with the gesture and runs until the release, so a pointer held still at the pane's edge keeps
      // travelling: a reader waits for the list, they do not shake the card at it.
      queueDragScrollStart();
    }
    d.y = e.clientY;
    queueDragPaint(d, e.clientY);
  }

  async function queueCardUp(cancelled = false) {
    const d = queueDrag;
    if (!d) return;
    queueDrag = null;
    queueDragScrollStop();
    const el = d.el;
    el.classList.remove("is-dragging");
    el.style.transform = "";
    el.closest('[data-subpane="queue"]')?.classList.remove("as-qdrag");
    // A press that never travelled is the reader's click: the opener on the body gets it, untouched.
    if (!d.moved) return;
    // From here on, the click the browser fires at the end of this gesture belongs to the drag.
    queueDragEnded = Date.now();
    if (cancelled) {
      // The browser took the gesture back — a touch scroll, a lost pointer. Nothing the reader chose happened, so the
      // card goes back where it was and NOTHING is written: committing the DOM's half-finished order would reorder the
      // queue on a scroll.
      renderAssistantQueue(d.own);
      return;
    }
    const ids = queueIdsIn(el);
    if (!ids.length || ids.join(",") === d.before.join(",")) {
      // Nothing moved: a paint from the cache is the honest answer, not a write that says "the order did not move".
      renderAssistantQueue(d.own);
      return;
    }
    const rows = queueCache.get(d.own)?.view?.tasks || [];
    const blocked = queueDropBlocked(rows, ids);
    if (blocked) {
      // Snap back: the cache still holds the order before the drag, so one paint from it restores the list — and the
      // one line says which row is holding the card that was dropped.
      queueDropNotes.set(d.own, blocked.line);
      renderAssistantQueue(d.own);
      return;
    }
    queueDropNotes.delete(d.own);
    const out = await queueAct(d.own, "reorder", { ids });
    // A refusal — the server's own copy of the rule, or a list a stale pane got past — snaps back the same way: the
    // cache is the order the server last confirmed.
    if (!out) renderAssistantQueue(d.own);
  }

  // The browser fires a click at the end of a drag as well: the pointer went down and came up over a card, and that is
  // the whole of its test. This is the one place that knows a drag happened, so it swallows that click in the CAPTURE
  // phase, before the row body's own opener (a bubble listener on the same float) can see it.
  function queueCardClickGuard(e) {
    if (!queueDragEnded) return;
    if (Date.now() - queueDragEnded > 600) return;
    if (!(e.target?.closest?.(".as-task"))) return;
    queueDragEnded = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // The one fact another cut reads off this one: a gesture is live, so a repaint would take the card out from
  // under the pointer and end the drag mid-air. It is a function because `queueDrag` is this file's own `let`.
  function dragLive() {
    return Boolean(queueDrag);
  }
  // The one line of drag state a fresh press clears: the click guard's clock, reset when a new gesture starts.
  const queueDragReset = () => {
    queueDragEnded = 0;
  };

  // ---- end the queue sub-tab --------------------------------------------------------------------

  // What the entry point hands on: the four presses the panel wires at its own load, the scroller the task-id
  // press borrows, and the two one-line facts about the drag record (is a gesture live, and clear its clock).
  return {
    queueCardDown, queueCardMove, queueCardUp, queueCardClickGuard,
    queueScrollerOf, dragLive, queueDragReset,
  };
};