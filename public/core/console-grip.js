// core/console-grip.js - the console's bottom-right corner: one press, one move, one release, and ONE band.
//
// WHAT THIS IS. A hit band in the console's own bottom-right corner (`outGripHtml` in public/board/console.js draws it
// inside the `.out-box` that also holds the <pre>, and the sheet draws its ticks in the shape the float's corner grip
// already has) plus the gesture that owns the number. It used to live in public/app.js as a cluster of functions and
// two delegated listeners; the release's band, the move's band and seven gates each re-derived the same arithmetic.
// This file is that cluster: the press, the move, the release, the step and the one limit, and the one function that
// computes the floor and the room.
//
// THE ONE BAND. `band()` answers one floor and one room, in LAYOUT px (the unit `--out-h`, the sheet's min-height and
// `--out-h` itself speak):
//
//   min   the larger of the sheet's `min-height` and the console's own padding box (public/board/console.js outFloor),
//         because a `--out-h: 1px` drew 18px and the store then kept a number the box never had;
//   room  the distance from the frozen top edge to the NEARER of the pane's own bottom and the viewport's bottom,
//         minus the sheet's 8px so the grip is not on the very edge.
//
// The nearer edge is the point. The room used to be `innerHeight - top / zoom - 8`: innerHeight is a VISUAL length and
// the top was divided into layout px, so on a page at 90% the box stopped a tenth of the viewport short of the screen
// (measured on the live float: 97.4px at 900 tall, 68.8px at 620) and at 110% it drew 81px PAST the bottom. It also
// ignored the pane: in the float the console could grow behind the reply box and past the scrollport's own bottom.
// Both readings are one edge in one unit now, and the record names which one stopped the drag (`edge: "pane" |
// "viewport"`), so a gate can say WHERE the box stopped instead of only how tall it is.
//
// A NOTE ON DIRECTION. The press freezes the box's TOP edge, so a pointer that travels DOWN grows the box and a pointer
// that travels UP shrinks it - the grip is on the bottom edge and stays under the hand, which is what makes the corner
// the reader is holding mean something. An upward drag therefore shrinks; the expanding drag is the downward one, and
// that is the drag whose stop this file makes the pane/viewport edge. A box whose growth pushed its top up instead
// would leave the grip behind the hand, so "drag up to expand" is not a second direction this band can offer.
//
// WHAT IT REACHES OUT FOR. The page's own writers and recorders, handed in by `install(host)` from public/app.js so
// this file never reads `state` or a page global at load: `setHeight` (setOutHeight, the one writer of `--out-h`),
// `clearHeight`, `floor` (outFloor), `remember` (rememberOutHeight), `noteScroll` (noteCardBodyScroll), `setScroll`
// (the page's logging wrapper) and `flush` (renderAll, for a release that owes a deferred repaint).
//
// LOAD CONTRACT. A classic script, loaded before public/app.js and after public/board/console.js; it DECLARES ONLY at
// load and publishes its surface on globalThis as `wtConsoleGrip`. Its arithmetic is pure and has no DOM dependency,
// so test/console-grip.test.js imports this same file and drives `step`, `band`, `limit` and `release` without a
// browser, and tools/verify-console-corner-drag.mjs and tools/verify-console-resize-release.mjs import the band
// instead of re-deriving it.
(function (root) {
  "use strict";

  // The pixels kept under the box at the edge it stops on, so the grip is not drawn on the very last pixel of the
  // screen. A layout length, like every other number the gesture keeps.
  const GAP_PX = 8;

  // The page's own zoom is a unit change, and this gesture speaks one unit. `clientY` and a `getBoundingClientRect()`
  // are VISUAL px; `--out-h`, the sheet's `min-height`, the transcript's `scrollTop` and `innerHeight` are LAYOUT px;
  // Settings > Display's zoom (`applyZoom` in public/settings.js) is the scale between them, and the float's own
  // gestures divide every length they write by the same number for the same reason (public/assistant.js zoomScale).
  // Read ONCE at the press: the gesture outlives any number of frames and must not re-derive it per move.
  function zoom() {
    const z = parseFloat(getComputedStyle(document.documentElement).zoom);
    return Number.isFinite(z) && z > 0 ? z : 1;
  }

  // The height a move asks for: the pointer, expressed from the top edge the press froze, plus the pixels of the grip
  // the hand landed inside. Negative is not a height, so it lands on 0 and the next move asks again from the same edge.
  // Both arguments are layout lengths (the press divided `top` and `grab` by the page zoom, and the caller divides the
  // pointer), so the answer is one too and can go straight to the writer.
  function step(top, grab, clientY) {
    const h = Number(clientY) + Number(grab) - Number(top);
    return Number.isFinite(h) && h > 0 ? h : 0;
  }

  // The one floor-and-room function. `top` is the frozen edge in LAYOUT px; `paneBottom` and `viewport` are VISUAL
  // lengths (a rect's bottom and window.innerHeight), so both are divided by the same scale here - that single divide
  // is the fix this file exists for. A null paneBottom (a card with no scrollport: nothing clips the box there) leaves
  // the viewport as the only edge. The returned `edge` names the smaller one, and `paneRoom` / `viewRoom` keep both
  // candidates so a report can print them beside the stop.
  function band(input) {
    const opts = input || {};
    const z = Number(opts.z) > 0 ? Number(opts.z) : 1;
    const top = Number(opts.top) || 0;
    const gap = Number.isFinite(Number(opts.gap)) ? Number(opts.gap) : GAP_PX;
    const floor = Number.isFinite(Number(opts.floor)) && Number(opts.floor) > 0 ? Number(opts.floor) : 0;
    // An ABSENT edge is not a zero edge: Number(null) is 0 and Number("") is 0, so a plain isFinite would have read a
    // board card with no scrollport as a pane whose bottom is at the viewport's top and stopped the drag on it.
    const hasPane = opts.paneBottom != null && opts.paneBottom !== "" && Number.isFinite(Number(opts.paneBottom));
    const hasView = opts.viewport != null && opts.viewport !== "" && Number.isFinite(Number(opts.viewport));
    const paneRoom = hasPane ? Number(opts.paneBottom) / z - top - gap : null;
    const viewRoom = hasView ? Number(opts.viewport) / z - top - gap : null;
    const rooms = [paneRoom, viewRoom].filter((n) => n != null);
    const room = Math.max(floor, rooms.length ? Math.min(...rooms) : 0, 1);
    const edge = paneRoom != null && (viewRoom == null || paneRoom <= viewRoom) ? "pane" : viewRoom != null ? "viewport" : "none";
    return { min: floor, room, edge, paneRoom, viewRoom };
  }

  // THE ONE LIMIT, and it is the same number on a move as on the release. A box that drew a height the release would
  // not keep was the corner showing the reader a size it was about to take back: measured at 120px of bounce when a
  // downward drag carried the corner past the room. So the move holds the box to this band while the pointer keeps
  // travelling - the way a window resize stops at the screen edge - and the release's call lands on the height the
  // corner is already drawing. Applied per move from the pointer's own position (step), never accumulated, so a hand
  // that comes back up takes the corner back with it the moment it is inside the band again.
  function limit(h, min, room) {
    const lo = Number.isFinite(Number(min)) && Number(min) > 0 ? Number(min) : 0;
    // A limit under 1px is not a limit: the ONE writer refuses a height of 0 (setOutHeight, public/board/console.js),
    // so a band whose top collapsed would be a box that stops answering the pointer. The room is rounded to the pixel
    // the writer keeps: `--out-h` is an inline integer, and a fractional room left the store holding 494.53125 for a
    // box drawing 495.
    const hi = Math.max(lo, Number.isFinite(Number(room)) ? Math.round(Number(room)) : lo, 1);
    return Math.max(lo, Math.min(hi, Math.round(Number(h) || lo)));
  }

  // The height a release keeps. The moves have already held the box to limit, so for every drag that reached a limit
  // this is the height already on the box and nothing moves at the pointerup. It stays a named call because the release
  // is the one place the number is committed to the store, and because a press that already sat past the limit (a
  // window shrunk under a stored height) must still land inside it.
  function release(h, min, room) {
    return limit(h, min, room);
  }

  // THE SHEET'S CAP, NOT THE ONE THE LAST GESTURE LEFT. A box dragged past its cap carries `max-height: none` inline,
  // and the computed value of that is "none" - parseFloat answers NaN - so a press that read the computed value
  // directly took the release's "no cap" branch for the rest of that node's life: the sheet's cap was never put back,
  // even after the reader dragged the box under it again. The lift the gesture wrote is taken off for the read and put
  // back exactly as it was, so the press always asks the pane's own rule. A pane whose rule is itself `max-height:
  // none` (the docked Chat pane) has no inline lift to remove and no cap to find: NaN is the honest answer there, and
  // the release lifts it.
  function capOf(out, cs) {
    let cap = parseFloat(cs && cs.maxHeight);
    if (Number.isFinite(cap)) return cap;
    const inline = out && out.style ? out.style.maxHeight : "";
    if (!inline) return cap;
    out.style.maxHeight = "";
    try {
      cap = parseFloat(getComputedStyle(out).maxHeight);
    } finally {
      out.style.maxHeight = inline;
    }
    return cap;
  }

  // What the release leaves on the box: the sheet's cap back whenever the height the reader chose is under it, and the
  // lift whenever that height is above it - or whenever no cap could be read, which is a pane that has none (the docked
  // Chat pane) and a box an earlier gesture already lifted. An explicit height is what the gesture decided; the cap
  // exists only for a console nobody has resized.
  function capStyle(cap, h) {
    return Number.isFinite(cap) && h <= cap ? "" : "none";
  }

  // The grip's own press. Delegated from the document because the console node is replaced by ordinary repaints, and a
  // listener on the grip itself would be a listener on a node that no longer exists.
  function install(host) {
    const hooks = host || {};
    let drag = null;

    // Is a live corner gesture holding THIS console? Asked by the console's own writers (public/board/console.js) and
    // by the card rebuild (public/render-jobs.js), by bare name: the page is one global scope (public/index.html).
    const holds = (out) => Boolean(drag && out && drag.out === out);
    // Does it hold a console inside this card? A card rebuilt here is a NEW node for that console, and the corner the
    // reader is holding goes with the old one.
    const holdsCard = (el) => Boolean(drag && el && el.contains && el.contains(drag.out));
    const live = () => Boolean(drag);

    // A repaint path that found the gesture in its way says so here, and the release draws it once, after the height
    // the reader chose has been recorded - so the flush cannot re-clamp what they set. A caller with its own paint to
    // run (the assistant's chat card, which is not the board's renderAll) hands that paint over as `flush`; every
    // distinct paint is kept, because more than one path can be waiting (a poll's head and a card rebuild), and running
    // only the last one would leave the others owed.
    function defer(flush) {
      if (!drag) return;
      drag.deferred = true;
      if (typeof flush !== "function") return;
      const list = drag.flushes || (drag.flushes = []);
      if (!list.includes(flush)) list.push(flush);
    }

    function press(e) {
      if (e.button !== 0 || drag) return;
      const grip = e.target && e.target.closest ? e.target.closest("[data-out-grip]") : null;
      if (!grip) return;
      const box = grip.closest(".out-box");
      const out = box && box.querySelector(":scope > pre.job-out");
      if (!out) return;
      const r = out.getBoundingClientRect();
      const cs = getComputedStyle(out);
      // The scale between the visual numbers below (a rect, a pointer) and the layout numbers the writer and the sheet
      // speak. Read once, here.
      const z = zoom();
      // The transcript this console is drawn in, when it IS a scrollport (the docked Chat pane, a maximized card): its
      // pin is what the gesture stands down, and its own bottom is the pane edge the box may not pass. A body the sheet
      // does not scroll (a row's card on the board) is never touched, because nothing there can clamp the box's top edge
      // - and its bottom is the viewport's business, not a pane's.
      const bodyEl = out.closest(".job-body");
      const scrollport = bodyEl && (bodyEl.closest(".job.maximized") || bodyEl.closest('[data-subpane="chat"]')) ? bodyEl : null;
      // The sheet's own cap, read BEFORE the gesture lifts it, and the band every move and the release hold the box to.
      const cap = capOf(out, cs);
      const bounds = band({
        top: r.top / z,
        z,
        floor: typeof hooks.floor === "function" ? hooks.floor(cs) : 0,
        paneBottom: scrollport ? scrollport.getBoundingClientRect().bottom : null,
        viewport: window.innerHeight,
        gap: GAP_PX,
      });
      drag = {
        out,
        grip,
        box,
        pointer: e.pointerId,
        y: e.clientY,
        // THE SCALE THIS GESTURE SPEAKS IN. Every length it keeps (top, grab, h, from, min, room) is a LAYOUT length,
        // and the pointer is divided by this on the way in.
        z,
        // THE TWO NUMBERS THE WHOLE GESTURE IS: the top edge it may not let move, and where inside the grip the hand
        // landed. The height of every move is `pointer + grab - top`, so the corner lands on the pointer whatever else
        // reflowed, and nothing accumulates from one move to the next.
        top: r.top / z,
        grab: (r.bottom - e.clientY) / z,
        h: r.height / z,
        from: r.height / z,
        moved: false,
        // The floor outFloor reads off the sheet, and the room band computed in one unit, with the edge it belongs to:
        // "pane" or "viewport". A gate reads `edge` to say WHERE the drag stopped.
        min: bounds.min,
        room: bounds.room,
        edge: bounds.edge,
        paneRoom: bounds.paneRoom,
        viewRoom: bounds.viewRoom,
        cap,
        // The pointer's own request at the last move, BEFORE the band was applied (null until the first move). Nothing
        // writes a height from it: it is the witness a gate reads to tell a box that stopped on the limit from a box
        // that failed to follow the hand.
        want: null,
        hadVar: out.style.getPropertyValue("--out-h"),
        styleMax: out.style.maxHeight,
        styleMin: out.style.minHeight,
        body: scrollport,
        // The transcript's offset at the press: the one number that decides where the box's top edge lands, re-asserted
        // on every move so the edge the gesture froze is a constant and not a function of anything else that scrolls.
        bodyTop: scrollport ? scrollport.scrollTop : null,
        deferred: false,
      };
      // The record, readable by a gate after a real press: the page's two corner gates and the press-only measurement
      // read `want` / `room` / `edge` from it, and the module keeps the only copy. Cleared at the release.
      root.wtConsoleGripDrag = drag;
      // THE BROWSER'S SCROLL ANCHOR, stood down for the length of the gesture. It is a second writer of the top edge:
      // at the foot its compensation for a taller box is a scrollTop write of exactly the height the drag added, which
      // is the same cancellation the page's own tail pin used to do. The place it holds for the reader is a row landing
      // ABOVE during a drag, which every rebuild path already defers (holdsCard) and the chat pane's own pin now asks
      // the gesture about; a drag is not the moment to trade the corner for it. Restored at the release.
      if (scrollport) scrollport.style.setProperty("overflow-anchor", "none", "important");
      // The watch that keeps the frozen edge the drawn one, for the whole gesture.
      watch(drag);
      // The gesture keeps its own pointer, so a release outside the card still ends it. `touch-action: none` on the grip
      // is what makes a touch drag this gesture and not a scroll; the capture is for a pointer stack that needs it.
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* older pointer stacks: the window listeners below still carry the gesture */
      }
      // The height it has is pinned, and BOTH sheet clamps lifted off it, before the pointer moves: the first paint of
      // the gesture is then the box the reader pressed on, and neither `max-height` nor `min-height` can stop that box
      // while the pointer keeps going - a clamp applied mid-gesture is the corner walking away from the cursor, which is
      // the defect this gesture exists to end. The clamps are read back on the release, and all three inline values are
      // restored if the press turns out to be a click. The number written is the DRAWN height in layout px
      // (`r.height / z`): written as the visual rect it would be a resize of the box on any zoomed page.
      if (typeof hooks.setHeight === "function") hooks.setHeight(out, r.height / z);
      out.style.maxHeight = "none";
      out.style.minHeight = "0";
      box.classList.add("is-resizing");
      document.body.classList.add("is-out-gripping");
      e.preventDefault();
    }

    function move(e) {
      const d = drag;
      if (!d || e.pointerId !== d.pointer) return;
      // A GESTURE THAT OUTLIVES THE NODE IT HOLDS IS A DEAD GRIP. The console is replaced by ordinary repaints, and
      // while this record exists every rebuild path in the page defers to live(): a node that went away under the hand
      // left the board frozen (no repaint, no re-pin) until a pointerup that may never come. The gesture ends with the
      // node it was holding.
      if (!d.out.isConnected) return end(e);
      // THE TOP EDGE THE PRESS FROZE, not the drawn box: the height is where the pointer is, expressed from an edge no
      // pin may move while the hand is down. The pointer arrives in visual px and the edge it is expressed from is a
      // layout length, so it is divided here, by the scale the press read.
      const want = step(d.top, d.grab, e.clientY / d.z);
      // THE LIMIT IS APPLIED HERE, WHILE THE POINTER KEEPS GOING. The box stops on the console's floor and on the room
      // under the frozen top edge, so the height it draws is always one the release will keep - there is no height left
      // for the pointerup to take back. `want` is kept on the record for the gates, which judge the corner only where
      // the box was free to follow the hand.
      let h = limit(want, d.min, d.room);
      if (h < 1) h = 1;
      d.want = want;
      d.y = e.clientY;
      d.h = h;
      if (Math.abs(h - d.from) >= 1) d.moved = true;
      // An explicit pixel height through the ONE writer of `--out-h`, with the sheet's cap lifted for the length of the
      // gesture: `--out-h` alone is clamped by `max-height`, and that clamp is the thing that used to walk the handle
      // up the screen.
      if (typeof hooks.setHeight === "function") hooks.setHeight(d.out, h);
      d.out.style.maxHeight = "none";
      // THE FROZEN OFFSET, RE-ASSERTED. The top edge is what the press froze, and the transcript's offset is what moves
      // it: this writes the offset the press read, every move. A grow has room for it, so a writer that moved it (the
      // anchor, a pin, a poll) is undone in the same frame and the edge really is a constant. A shrink has no room: the
      // write is clamped by the scrollport, and the box stops following there (the gate's floor). What the write buys is
      // the way BACK - a drag that dips below the floor and comes back re-asserts the offset the moment the content has
      // room for it again, so the corner returns to the hand instead of staying where the clamp left it.
      if (d.body && d.bodyTop != null && typeof hooks.setScroll === "function") hooks.setScroll(d.body, d.bodyTop);
    }

    // THE EDGE, PUT BACK WHERE IT WAS FROZEN, once a frame for the whole gesture. Nothing above the box is the
    // gesture's (a chip that rewraps, an artifact button that appears, a live turn's row): when one of those grows, the
    // top edge slides down by its height and the corner goes with it, because the offset the press read no longer lands
    // the edge where it was. This measures that drift every frame - not every move, because a poll paints between two
    // moves and the gate's own read lands there - and scrolls the transcript by exactly it, which the growth itself made
    // room for. The height is NOT re-derived from the corrected edge: it is the pointer's travel from the pressed
    // height, so the box keeps the size the reader chose. Below the pressed height the transcript's own clamp owns the
    // offset and chasing it would inflate the offset the way-back re-asserts, so a shrink is left alone.
    function watch(d) {
      if (!d || d.edgeFrame) return;
      const tick = () => {
        d.edgeFrame = 0;
        if (drag !== d) return;
        if (d.out.isConnected && d.body) {
          if (d.h >= d.from - 0.5) {
            // Both sides in layout px: the rect is visual, the frozen edge is layout, and the transcript's scrollTop the
            // correction is written to is layout as well. Without the divide, a zoomed page reported its own scale as
            // drift every frame and the offset ran away (measured at 90%: 56px added per frame while the hand was still).
            const drift = d.out.getBoundingClientRect().top / d.z - d.top;
            if (Math.abs(drift) > 0.5 && typeof hooks.setScroll === "function") {
              d.bodyTop = Math.max(0, d.bodyTop + drift);
              hooks.setScroll(d.body, d.bodyTop);
            }
          }
          d.edgeFrame = requestAnimationFrame(tick);
        }
      };
      d.edgeFrame = requestAnimationFrame(tick);
    }

    function end(e) {
      const d = drag;
      if (!d || (e && e.pointerId != null && e.pointerId !== d.pointer)) return;
      drag = null;
      root.wtConsoleGripDrag = null;
      if (d.edgeFrame) cancelAnimationFrame(d.edgeFrame);
      d.edgeFrame = 0;
      try {
        d.grip.releasePointerCapture?.(d.pointer);
      } catch {
        /* the grip may have gone with a node: nothing to release */
      }
      d.box.classList.remove("is-resizing");
      document.body.classList.remove("is-out-gripping");
      // The anchor the press stood down goes back on the transcript whatever else happens: it is the reader's place in
      // a transcript that is not being dragged any more.
      if (d.body) d.body.style.removeProperty("overflow-anchor");
      if (d.out.isConnected) {
        if (!d.moved) {
          // A press that moved nothing is a press on the corner, not a resize: put back exactly what the sheet drew, so a
          // click here leaves neither a pinned height nor a lifted cap behind.
          if (d.hadVar) d.out.style.setProperty("--out-h", d.hadVar);
          else if (typeof hooks.clearHeight === "function") hooks.clearHeight(d.out);
          d.out.style.maxHeight = d.styleMax;
          d.out.style.minHeight = d.styleMin;
        } else {
          // The limit, here and only here on the release: the number the gesture reached, held to the sheet's floor and
          // to the room the box has under its top edge. The room was read at the press and every move has already been
          // held to it, so for a drag that reached a limit this call returns the height the box is already drawing - the
          // release commits a size, it does not change one. The sheet's own `min-height` goes back with it, so the floor
          // is the sheet's again rather than the 0 the gesture needed to follow the pointer down to it. The call goes
          // through the PUBLISHED function so a gate can wrap the ONE clamp and count the releases
          // (tools/verify-console-corner-tail.mjs) instead of inferring them from the height.
          const one = root.wtConsoleGrip && typeof root.wtConsoleGrip.release === "function" ? root.wtConsoleGrip.release : release;
          const h = one(d.h, d.min, d.room);
          if (typeof hooks.setHeight === "function") hooks.setHeight(d.out, h);
          d.out.style.minHeight = d.styleMin;
          // The cap the press read off the SHEET, so a box an earlier drag took over the cap and this one brought back
          // under it gets the sheet's cap again - the invariant the inline lift used to destroy. A pane with no cap of
          // its own (the docked chat) keeps the lift: an explicit height is what the gesture decided.
          d.out.style.maxHeight = capStyle(d.cap, h);
          if (typeof hooks.remember === "function") hooks.remember(d.out.dataset.out, h);
          // THE FOOT THE GESTURE TOOK AWAY, NOT ONE IT PUTS BACK. The drag moved the box's bottom by exactly the pointer's
          // travel, with the transcript's offset never written (its pin stood down, its anchor stood down, its room held
          // by the move): writing the foot here would scroll the transcript by the drag's own travel and put the box back
          // on the pixel it started from. What the panel records is the truth: this transcript is that far from its foot
          // now, so it stops following until the reader is back on it (following resumes on the reader's own scroll,
          // public/board/console.js noteCardBodyScroll). The band is 0 here, not the sheet's 8 px: the gap this release
          // records is the drag's own, and reading it as "still following" let the release's own repaint scroll the
          // transcript the last few px to its foot and take the corner with it.
          if (d.body && typeof hooks.noteScroll === "function") hooks.noteScroll(d.body, 0);
        }
      }
      // Whatever a repaint path wanted to draw while the pointer was down is drawn now, once.
      if (d.deferred) {
        const flushes = d.flushes || [];
        if (flushes.length) for (const f of flushes) f();
        else if (typeof hooks.flush === "function") hooks.flush();
      }
    }

    document.addEventListener("pointerdown", press, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    // A capture lost to a window blur, an alt-tab or a node that left the page is a gesture whose pointerup may never
    // arrive. Both are the end of the gesture, through the same door as a release.
    window.addEventListener("lostpointercapture", end, true);
    window.addEventListener("blur", () => end(null), true);

    return { press, move, end, defer, holds, holdsCard, live, drag: () => drag };
  }

  root.wtConsoleGrip = { GAP_PX, zoom, step, band, limit, release, capOf, capStyle, install };
})(globalThis);
