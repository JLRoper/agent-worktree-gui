// search-popover.js - the ONE popover, keyboard walk and scroller-follow both header searches use.
//
// WHY THIS EXISTS. The assistant's turn search (Ctrl+Q) grew a popover under its box, a keyboard walk
// (Up/Down/Shift+Enter/Enter/Escape) and a rule that kept the row the walk stood on inside the list's own
// scroller. The Hot Agent search (Ctrl+Shift+Q) is a second box beside it, over a different store, and it has to
// behave the same way: same popover, same keys, same follow. Two copies of that machinery is how the two bars
// drift - one of them keeps the current row visible, the other one does not - so the machinery lives here once
// and each bar supplies only its data and its rows.
//
// WHO OWNS WHAT:
//
//   * THIS MODULE owns the popover element's life (`show`, `hide`), where it sits (`place`), the drag strip, the
//     resize grip and the close x (`chrome`, `beginDrag`, `applyMoved`), the keyboard's meaning (`keyIntent`), the
//     count's DOM (`paintCount`), which row is current (`markCurrent`), the scroller follow (`follow`, through
//     public/core/search-scroll.js) and the mousedown dismissal (through public/core/search-dismiss.js, capture
//     phase, so a drag that starts inside the list never closes it).
//   * THE BAR owns the hits, the readout's wording and the row markup. It passes a `readout` function that
//     answers the count, and a `current` function that answers which row the walk is standing on.
//
// THE KEYBOARD, once (docs/assistant-search-keys.md and docs/hot-agent-search-keys.md state it for the reader):
//
//   Down          step forward      Up (and Shift+Down/Shift+Up)   step back
//   Shift+Enter   step back         Enter                            open the current row
//   Escape        clear and close (the bar decides what "clear" leaves behind)
//
// `keyIntent` is the pure half and takes a key plus the shift flag; a test can answer it without a DOM. Every
// intent is preventative: a press that steps must never also scroll the page, which is the browser's default for
// an arrow key in a text input.
//
// PLACEMENT is anchored to the BOX's own rectangle, not to the whole control the box sits in. The popover's LEFT
// edge opens at the box's left edge and it grows RIGHTWARDS; its top edge sits `gap` below the box's bottom edge.
// The old rule aligned right edges and grew leftwards from the bar's own right edge, so a popover wider than the
// box (250px floor against a ~55px input) started 140px left of the box - and on the Hot Agent bar, whose opener
// is a 34px button, 296px left of it. When the window is too narrow for the full width the popover NARROWS rather
// than sliding back under the pane, so its left edge is always inside the box's own span. `placeGeometry` takes
// numbers, so the rule is unit-tested; `place` reads the nodes and writes the element's four style properties.
//
// MOVED AND RESIZED. The popover carries three controls of its own: a drag strip across its top (`data-search-drag`)
// with the close x at its right, and a grip in its bottom-right corner (`data-search-grip`). A drag moves it, a
// grip drag resizes it with a minimum width and height, and both write a `moved` rectangle that survives until the
// search CLOSES - `hide()` clears it, and so does `resetPlacement()`, which a scope change calls while the list is
// still open. A reopen therefore draws the anchored default again. The drag strip is not focusable and its
// mousedown is preventative, so the caret stays in the box and the arrow walk, the scroller follow and the count
// keep working while the popover is somewhere else.
//
// Published on globalThis as `wtSearchPopover`, loaded as a classic script by public/index.html before
// assistant.js, and imported by test/search-popover.test.js - the same load contract public/core/search-scroll.js
// has.
(function (root) {
  "use strict";

  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), Math.max(lo, hi));

  // The default geometry: the assistant's popover's old numbers, now applied from the box's LEFT edge. A second bar
  // may narrow or widen it, but it does not get a different RULE - only different numbers. `squeeze` is the narrowest
  // a PLACEMENT may go to stay under its box (a resize cannot go below `minWidth`): the assistant's box keeps only
  // ~197px to the window's right edge when its count is showing, and a list squeezed to that is still readable while
  // one that slid 52px left of the box would not be under it any more.
  const PLACE_DEFAULTS = { minWidth: 250, minHeight: 120, squeeze: 160, widthCap: 380, grow: 140, pad: 8, gap: 6, share: 0.42, floor: 120 };

  /**
   * What a key press means to a search box. Pure over the key and the shift flag; null for every other key, which
   * is what makes the caller skip a press it does not own (a letter goes into the box).
   *
   * @returns {"step-forward"|"step-back"|"open"|"clear"|null}
   */
  function keyIntent(key, shift = false) {
    if (key === "ArrowDown") return shift ? "step-back" : "step-forward";
    if (key === "ArrowUp") return "step-back";
    if (key === "Enter") return shift ? "step-back" : "open";
    if (key === "Escape") return "clear";
    return null;
  }

  /**
   * Where the popover goes, from the BOX's own rectangle and the window's size.
   *
   * `box` is `{ left, right, bottom }` in viewport coordinates (what `getBoundingClientRect` answers); the answer
   * is the four style values the element needs. The left edge opens at the box's left edge and the popover grows to
   * the right; its top edge is `gap` under the box. The width narrows to fit the window rather than sliding left of
   * the box; only when the window cannot hold `minWidth` at the box's edge does the popover back off that edge, and
   * the left edge is always kept `pad` away from the window's own edge.
   */
  function placeGeometry({ box = null, viewportWidth = 0, viewportHeight = 0, options = {} } = {}) {
    const o = { ...PLACE_DEFAULTS, ...(options || {}) };
    const vw = Math.max(0, num(viewportWidth));
    const vh = Math.max(0, num(viewportHeight));
    const boxLeft = num(box?.left);
    const boxWidth = Math.max(0, num(box?.right) - boxLeft);
    const want = Math.min(o.widthCap, Math.max(o.minWidth, boxWidth + o.grow));
    // Anchor the LEFT edge, then narrow to fit. A popover that slid left to fit would be the defect this rule
    // replaces; one that narrows is still under the box it belongs to. `squeeze` is the narrowest placement, so the
    // box's own edge is only abandoned when even that will not fit to the window's right.
    const left = Math.min(Math.max(o.pad, boxLeft), Math.max(o.pad, vw - o.pad - Math.min(want, o.squeeze)));
    const room = Math.max(0, vw - o.pad - left);
    const width = Math.max(Math.min(o.squeeze, room), Math.min(want, room));
    const top = Math.round(clamp(num(box?.bottom) + o.gap, o.pad, Math.max(o.pad, vh - o.pad - o.minHeight)));
    const maxHeight = Math.max(o.floor, Math.min(vh * o.share, vh - top - o.pad - 4));
    return { width, left, top, right: left + width, maxHeight };
  }

  /**
   * Where a drag leaves the popover, from its rectangle when the drag started.
   *
   * `kind` is `"move"` or `"resize"`; `start` is `{ left, top, width, height }`; `dx`/`dy` are the pointer's travel
   * since the press. A move keeps the popover's size and clamps its rectangle inside the window; a resize keeps
   * its top-left and grows it, with `minWidth`/`minHeight` as the floor and the window's edge as the ceiling. Pure
   * arithmetic, so the walk's own shape can be unit-tested without a pointer.
   */
  function dragGeometry({ kind = "move", start = null, dx = 0, dy = 0, viewportWidth = 0, viewportHeight = 0, options = {} } = {}) {
    const o = { ...PLACE_DEFAULTS, ...(options || {}) };
    const p = start || {};
    const vw = Math.max(0, num(viewportWidth));
    const vh = Math.max(0, num(viewportHeight));
    const width0 = Math.max(o.minWidth, num(p.width));
    const height0 = Math.max(o.minHeight, num(p.height));
    if (kind === "resize") {
      const width = clamp(width0 + num(dx), o.minWidth, Math.max(o.minWidth, vw - o.pad - num(p.left)));
      const height = clamp(height0 + num(dy), o.minHeight, Math.max(o.minHeight, vh - o.pad - num(p.top)));
      return { left: num(p.left), top: num(p.top), width, height, resized: true };
    }
    const left = clamp(num(p.left) + num(dx), o.pad, Math.max(o.pad, vw - o.pad - width0));
    const top = clamp(num(p.top) + num(dy), o.pad, Math.max(o.pad, vh - o.pad - height0));
    return { left, top, width: width0, height: null, resized: false };
  }

  /**
   * Wire one search bar. Every function below is supplied by the bar; nothing here knows a hit's shape.
   *
   * @param input         the <input> the reader types in.
   * @param pop           the popover CONTAINER: what opens, closes and is placed (and what a mousedown outside
   *                      means). It is also the scroller unless `scroller` names a different element.
   * @param scroller      the element whose own scroll follows the walk (a popover with a head and a footer scrolls
   *                      its list, not itself). Defaults to `pop`.
   * @param count         the count element beside (or above) the box, or null for a bar with no count.
   * @param readout       () => ({ text, foot, title, capped, hidden, current, total, matched, displayed, turns }).
   * @param current       () => the index the walk is standing on, -1 for none.
   * @param onStep        (delta) => void - delta is +1 or -1.
   * @param onOpen        () => void - Enter.
   * @param onEscape      () => void - Escape (the bar clears its own filter and does its own focus).
   * @param onDismiss     () => void - a mousedown outside the box and the list.
   * @param onType        () => void - the box's text changed (the bar debounces; this module does not).
   * @param onPick        (index) => void - a click on a result row.
   * @param onClose       () => void - the popover's own x. Defaults to onEscape when the bar supplies none.
   * @param anchor        the box the popover hangs under; defaults to `input`. The Hot Agent bar passes its opener
   *                      button because its input lives INSIDE the popover: the popover's head box is what lands
   *                      under the control the reader pressed.
   * @param rowSelector   how a result row is found, `[data-search-hit]` by default.
   * @param placeOptions  geometry overrides (minWidth, minHeight, widthCap, grow, pad, gap, share, floor).
   */
  function mount({
    input = null,
    pop = null,
    scroller = null,
    count = null,
    readout = null,
    current = () => -1,
    onStep = null,
    onOpen = null,
    onEscape = null,
    onDismiss = null,
    onType = null,
    onPick = null,
    onClose = null,
    anchor = null,
    rowSelector = "[data-search-hit]",
    placeOptions = null,
  } = {}) {
    if (!input || !pop) throw new Error("wtSearchPopover.mount needs an input and a popover");
    const list = scroller || pop;
    const rows = () => [...list.querySelectorAll(rowSelector)];
    const rowAt = (index) => rows().find((row) => Number(row.dataset.searchHit) === Number(index)) || null;
    const options = () => ({ ...PLACE_DEFAULTS, ...(placeOptions || {}) });

    // The reader's own rectangle: set by a drag or a grip drag, null while the popover sits at its anchored
    // default. `height` is null on a move (the list's natural height under its cap) and a number on a resize.
    let moved = null;
    let drag = null;

    function ensureChrome() {
      const doc = pop.ownerDocument || root.document;
      if (!doc || typeof doc.createElement !== "function") return null;
      let bar = pop.querySelector("[data-search-drag]");
      let grip = pop.querySelector("[data-search-grip]");
      if (!bar) {
        bar = doc.createElement("div");
        bar.className = "as-search-drag";
        bar.setAttribute("data-search-drag", "1");
        bar.title = "drag to move these results";
        const close = doc.createElement("button");
        close.type = "button";
        close.className = "as-search-x";
        close.setAttribute("data-search-close", "1");
        close.setAttribute("aria-label", "close the search results");
        close.title = "close the results (Esc)";
        close.textContent = "\u2715";
        // The x is pressed with the mouse but the caret belongs in the box: the bar's own close handler puts it
        // back where its rule says (the box for the turn search, the opener for the Hot Agent bar).
        close.addEventListener("mousedown", (e) => e.preventDefault());
        close.addEventListener("click", (e) => {
          e.preventDefault?.();
          if (typeof onClose === "function") onClose();
          else if (typeof onEscape === "function") onEscape();
        });
        bar.appendChild(close);
        bar.addEventListener("mousedown", (e) => {
          if (e.target?.closest?.("[data-search-close]")) return;
          beginDrag("move", e);
        });
        pop.insertBefore(bar, pop.firstChild);
      }
      if (!grip) {
        grip = doc.createElement("div");
        grip.className = "as-search-grip";
        grip.setAttribute("data-search-grip", "1");
        grip.title = "drag to resize these results";
        grip.addEventListener("mousedown", (e) => beginDrag("resize", e));
        pop.appendChild(grip);
      }
      return { bar, grip };
    }

    function applyMoved() {
      if (!moved) return null;
      const o = options();
      const vw = root.window?.innerWidth || 0;
      const vh = root.window?.innerHeight || 0;
      const width = Math.min(Math.max(o.minWidth, num(moved.width)), Math.max(o.minWidth, vw - o.pad * 2));
      const height =
        moved.height == null ? null : Math.min(Math.max(o.minHeight, num(moved.height)), Math.max(o.minHeight, vh - o.pad * 2));
      const left = clamp(num(moved.left), o.pad, Math.max(o.pad, vw - o.pad - width));
      const top =
        height == null
          ? clamp(num(moved.top), o.pad, Math.max(o.pad, vh - o.pad - o.minHeight))
          : clamp(num(moved.top), o.pad, Math.max(o.pad, vh - o.pad - height));
      moved = { left, top, width, height };
      pop.style.width = `${width}px`;
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      pop.classList.add("is-moved");
      if (height == null) {
        pop.style.height = "";
        pop.style.maxHeight = `${Math.max(o.floor, Math.min(vh * o.share, vh - top - o.pad - 4))}px`;
      } else {
        pop.style.height = `${height}px`;
        pop.style.maxHeight = `${height}px`;
        pop.classList.add("is-resized");
      }
      return { ...moved, moved: true };
    }

    function place() {
      if (pop.hidden) return null;
      ensureChrome();
      if (moved) return applyMoved();
      const box = (anchor || input).getBoundingClientRect();
      const g = placeGeometry({ box, viewportWidth: root.window?.innerWidth || 0, viewportHeight: root.window?.innerHeight || 0, options: placeOptions });
      pop.style.width = `${g.width}px`;
      pop.style.left = `${g.left}px`;
      pop.style.top = `${g.top}px`;
      pop.style.height = "";
      pop.style.maxHeight = `${g.maxHeight}px`;
      return g;
    }

    function beginDrag(kind, e) {
      if (pop.hidden || drag) return;
      const r = pop.getBoundingClientRect();
      drag = {
        kind,
        x: num(e.clientX),
        y: num(e.clientY),
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      };
      e.preventDefault?.();
      e.stopPropagation?.();
      pop.classList.add(kind === "move" ? "is-moving" : "is-resizing");
      const doc = pop.ownerDocument || root.document;
      doc.addEventListener("mousemove", dragMove, true);
      doc.addEventListener("mouseup", dragEnd, true);
    }

    function dragMove(e) {
      if (!drag) return;
      const g = dragGeometry({
        kind: drag.kind,
        start: drag.rect,
        dx: num(e.clientX) - drag.x,
        dy: num(e.clientY) - drag.y,
        viewportWidth: root.window?.innerWidth || 0,
        viewportHeight: root.window?.innerHeight || 0,
        options: placeOptions,
      });
      moved = { left: g.left, top: g.top, width: g.width, height: g.height };
      applyMoved();
    }

    function dragEnd() {
      if (!drag) return;
      const kind = drag.kind;
      drag = null;
      pop.classList.remove("is-moving", "is-resizing");
      const doc = pop.ownerDocument || root.document;
      doc.removeEventListener("mousemove", dragMove, true);
      doc.removeEventListener("mouseup", dragEnd, true);
      // A resize changes the band the walk has to stay inside: put the current row back in it, so the reader never
      // loses the row they were standing on by making the list shorter.
      if (kind === "resize") follow();
    }

    function show(html) {
      // The LIST is what a bar redraws, not the whole popover: the assistant's popover IS its own scroller (head and
      // footer live inside the list's html), while the Hot Agent popover keeps a permanent head - its box - over a
      // scrollable list and a footer under it. Writing `list` is the same write for the first bar and the only
      // possible one for the second.
      list.innerHTML = String(html == null ? "" : html);
      pop.hidden = false;
      place();
      return pop;
    }

    function resetPlacement() {
      if (drag) {
        const doc = pop.ownerDocument || root.document;
        doc.removeEventListener("mousemove", dragMove, true);
        doc.removeEventListener("mouseup", dragEnd, true);
      }
      moved = null;
      drag = null;
      pop.classList.remove("is-moved", "is-resized", "is-moving", "is-resizing");
      pop.style.height = "";
      if (!pop.hidden) return place();
      return null;
    }

    function hide() {
      pop.hidden = true;
      list.innerHTML = "";
      // A closed search forgets where it was: the next open draws the anchored default again.
      resetPlacement();
    }

    function isOpen() {
      return !pop.hidden;
    }

    // The count's own DOM: the data attributes a harness reads (`data-search-current`, `-total`, `-matched`,
    // `-displayed`, `-turns`), the text, the tooltip and the amber cap. The BAR decides whether the element is
    // shown at all (`hidden`), because the assistant hides it until a filter exists while the Hot Agent bar shows
    // its list's size from the first press.
    function paintCount() {
      if (!count || typeof readout !== "function") return null;
      const c = readout() || {};
      count.dataset.searchCurrent = String(c.current == null ? 0 : c.current);
      count.dataset.searchTotal = String(c.total == null ? 0 : c.total);
      count.dataset.searchMatched = String(c.matched == null ? 0 : c.matched);
      count.dataset.searchDisplayed = String(c.displayed == null ? c.total || 0 : c.displayed);
      count.dataset.searchTurns = String(c.turns == null ? 0 : c.turns);
      if (c.query != null) count.dataset.searchQuery = String(c.query);
      count.hidden = Boolean(c.hidden);
      count.classList.toggle("is-capped", Boolean(c.capped));
      count.textContent = count.hidden ? "" : String(c.text || "");
      if (c.title) count.title = String(c.title);
      else count.removeAttribute("title");
      return c;
    }

    // Which row the walk is standing on: `.is-current` plus aria-current on that row, off every other. The bar's
    // own highlight inside a card is separate - this is the list's row.
    function markCurrent() {
      const at = Number(current());
      for (const row of rows()) {
        const on = at >= 0 && Number(row.dataset.searchHit) === at;
        row.classList.toggle("is-current", on);
        if (on) row.setAttribute("aria-current", "true");
        else row.removeAttribute("aria-current");
      }
      return at;
    }

    // The scroller follows the highlight. The arithmetic (nearest edge in, one row per press, same number from
    // either direction) is public/core/search-scroll.js; this reads the two nodes and hands them over. A plain
    // scrollTop write, so a held key cannot queue a smooth scroll, and nothing but the scroller moves.
    function follow() {
      if (pop.hidden) return null;
      const row = rowAt(Number(current()));
      if (!row) return null;
      const scroll = root.wtSearchScroll;
      if (!scroll || typeof scroll.place !== "function") return null;
      return scroll.place(list, row);
    }

    function wire() {
      input.addEventListener("keydown", (e) => {
        const intent = keyIntent(e.key, e.shiftKey);
        if (!intent) return;
        // Every intent is the box's: an arrow must step, not scroll the page, and Escape must not reach the rail
        // and close the whole panel while the reader is only clearing a filter.
        e.preventDefault();
        if (intent === "clear") {
          e.stopPropagation();
          if (typeof onEscape === "function") onEscape();
          return;
        }
        if (intent === "open") {
          if (typeof onOpen === "function") onOpen();
          return;
        }
        if (typeof onStep === "function") onStep(intent === "step-forward" ? 1 : -1);
      });
      input.addEventListener("input", () => {
        if (typeof onType === "function") onType();
      });
      pop.addEventListener("click", (e) => {
        const row = e.target.closest?.(rowSelector);
        if (!row || typeof onPick !== "function") return;
        onPick(Number(row.dataset.searchHit));
      });
      pop.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof onEscape === "function") onEscape();
      });
      // The popover is placed in viewport coordinates, so a resize or a scroll of the page moves the box: re-place
      // rather than leave it pointing at where the row used to be. A MOVED popover keeps its rectangle and is only
      // clamped back inside the window.
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, { passive: true, capture: true });
      // A mousedown OUTSIDE the box and outside the list: the reader has gone somewhere else, so the bar closes
      // its list. `mousedown`, not `click`, so a drag that STARTS inside the results is not a dismissal, and
      // capture phase, so the decision is made before a handler that might rebuild the pane under it.
      document.addEventListener(
        "mousedown",
        (e) => {
          if (pop.hidden) return;
          const mod = root.wtSearchDismiss;
          if (!mod || typeof mod.outside !== "function") return;
          if (mod.outside(e.target, { input, pop })) {
            if (typeof onDismiss === "function") onDismiss();
          }
        },
        true,
      );
      return api;
    }

    const api = {
      place,
      show,
      hide,
      isOpen,
      paintCount,
      markCurrent,
      follow,
      wire,
      rows,
      rowAt,
      resetPlacement,
      el: { input, pop, count, list },
    };
    return api;
  }

  root.wtSearchPopover = { keyIntent, placeGeometry, dragGeometry, mount, PLACE_DEFAULTS };
})(globalThis);
