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
//   * THIS MODULE owns the popover element's life (`show`, `hide`), where it sits (`place`), the keyboard's
//     meaning (`keyIntent`), the count's DOM (`paintCount`), which row is current (`markCurrent`), the scroller
//     follow (`follow`, through public/core/search-scroll.js) and the mousedown dismissal (through
//     public/core/search-dismiss.js, capture phase, so a drag that starts inside the list never closes it).
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
// PLACEMENT is the arithmetic the assistant's popover used before this module existed, turned into a pure
// function of two rectangles: right edges aligned with the box, never off the screen, a fixed width that grows
// leftwards from the rail's own right edge, and a max height that is the smaller of 42% of the window and the
// room below the box. `placeGeometry` takes numbers, so the rule is unit-tested; `place` reads the nodes and
// writes the element's four style properties.
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

  // The default geometry: exactly what the assistant's popover has always done. A second bar may narrow or widen
  // it, but it does not get a different RULE - only different numbers.
  const PLACE_DEFAULTS = { minWidth: 250, widthCap: 380, grow: 140, pad: 8, gap: 6, share: 0.42, floor: 120 };

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
   * Where the popover goes, from the box's own rectangle and the window's size.
   *
   * `box` is `{ left, right, bottom }` in viewport coordinates (what `getBoundingClientRect` answers); the answer
   * is the four style values the element needs. Right edges align with the box because the rail hugs the window's
   * right edge and the popover is wider than the box, so it grows leftwards; both edges are clamped inside the
   * window, and the height is whatever room is left below the box, capped at `share` of the window.
   */
  function placeGeometry({ box = null, viewportWidth = 0, viewportHeight = 0, options = {} } = {}) {
    const o = { ...PLACE_DEFAULTS, ...(options || {}) };
    const width = Math.min(o.widthCap, Math.max(o.minWidth, num(box?.right) - num(box?.left) + o.grow));
    const right = Math.min(num(viewportWidth) - o.pad, Math.max(o.pad, num(box?.right)));
    const left = Math.max(o.pad, right - width);
    const top = Math.round(num(box?.bottom) + o.gap);
    const maxHeight = Math.max(o.floor, Math.min(num(viewportHeight) * o.share, num(viewportHeight) - top - o.pad - 4));
    return { width, left, top, maxHeight };
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
   * @param anchor        the element the popover hangs under; defaults to `input`.
   * @param rowSelector   how a result row is found, `[data-search-hit]` by default.
   * @param placeOptions  geometry overrides (minWidth, widthCap, grow, pad, gap, share, floor).
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
    anchor = null,
    rowSelector = "[data-search-hit]",
    placeOptions = null,
  } = {}) {
    if (!input || !pop) throw new Error("wtSearchPopover.mount needs an input and a popover");
    const list = scroller || pop;
    const rows = () => [...list.querySelectorAll(rowSelector)];
    const rowAt = (index) => rows().find((row) => Number(row.dataset.searchHit) === Number(index)) || null;

    function place() {
      if (pop.hidden) return null;
      const box = (anchor || input).getBoundingClientRect();
      const g = placeGeometry({ box, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, options: placeOptions });
      pop.style.width = `${g.width}px`;
      pop.style.left = `${g.left}px`;
      pop.style.top = `${g.top}px`;
      pop.style.maxHeight = `${g.maxHeight}px`;
      return g;
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

    function hide() {
      pop.hidden = true;
      list.innerHTML = "";
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
      // rather than leave it pointing at where the row used to be.
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

    const api = { place, show, hide, isOpen, paintCount, markCurrent, follow, wire, rows, rowAt, el: { input, pop, count, list } };
    return api;
  }

  root.wtSearchPopover = { keyIntent, placeGeometry, mount, PLACE_DEFAULTS };
})(globalThis);
