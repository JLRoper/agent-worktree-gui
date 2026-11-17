// search-scroll.js - where the assistant's search popover has to sit so the row the keyboard is standing on is
// always fully visible inside the list.
//
// WHY THIS EXISTS. The results are a fixed popover under the search box with its own scroller (`.as-search-pop` is
// a flex column with `overflow-y: auto` and a max height of roughly the viewport's 42%). A keyboard step used to
// scroll the TRANSCRIPT - `(mark || turnEl).scrollIntoView({ block: "end" })` - and then put `window.scrollY` back,
// while `paintSearchCurrent` deliberately scrolled nothing. So the list itself never followed the highlight: from
// the sixth row on, every press moved the current row out of the popover's visible band and the reader lost the row
// they were stepping to, even though the header went on saying "7 of 10".
//
// THE RULE, and why it is arithmetic rather than `scrollIntoView`. `scrollIntoView` answers a different question -
// "make this element visible in every scroller above it", the page included - and its two shapes are wrong here:
//
//   * A row TALLER than the visible band. `block: "nearest"`/`"end"` align its bottom, and the top of a matching
//     turn is where its text starts, so the reader is shown the foot of the thing they searched for. A row that
//     cannot fit is therefore TOP aligned: `rowTop` goes to the band's top.
//   * THE WAY BACK. `scrollIntoView` positions a row at whichever edge it happens to be near THIS time, so a walk
//     down and the same walk back up land on different offsets and the list drifts a row at a time. The rule here
//     is a pure function of the row's own geometry, so the row's offset is the same number whichever direction the
//     walk arrives from: stepping from the last row back to the first retraces the down walk's positions exactly.
//
// The row that fits is BOTTOM aligned - its bottom edge at the band's bottom, the nearest edge when the walk comes
// from below - so one press past the fold moves the list by exactly one row and the rows the reader came from stay
// on screen above it. That is also what makes the reverse exact: the same row always produces the same offset.
//
// Published on globalThis as `wtSearchScroll`, loaded as a classic script by public/index.html (before
// assistant.js) and imported by test/assistant-search-scroll.test.js - the same load contract
// public/core/search-dismiss.js has. `target()` is pure arithmetic over numbers; `place()` is the same rule over
// two nodes (a scroller and a row), and takes stubs, which is what keeps the test a unit test.
(function (root) {
  "use strict";

  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  /**
   * The scrollTop the scroller must hold so `row` is inside the visible band.
   *
   * `rowTop` is the row's offset inside the scroller's own content (the coordinate `scrollTop` measures in), not
   * its position on screen. `bandHeight` is the scroller's `clientHeight` - the part of it a reader can see,
   * padding included. `maxScroll` is `scrollHeight - clientHeight`, so the answer can never ask for a position the
   * scroller does not have.
   *
   * The answer is ceiled, never floored: a fractional layout (a wrapped snippet line) must not leave half a pixel
   * of the row outside the band, and a ceiling is the same number every time it is asked, which is what makes the
   * reverse walk exact.
   */
  function target({ rowTop = 0, rowHeight = 0, bandHeight = 0, maxScroll = Infinity } = {}) {
    const top = num(rowTop);
    const height = Math.max(0, num(rowHeight));
    const band = Math.max(0, num(bandHeight));
    const max = Math.max(0, Math.floor(num(maxScroll, Number.POSITIVE_INFINITY)));
    // A row that fits puts its BOTTOM at the band's bottom (nearest edge in, one row per press, and the same
    // number from either direction). A row that cannot fit keeps its TOP: the matched text starts there.
    const want = height > band ? top : top + height - band;
    return Math.min(max, Math.max(0, Math.ceil(want)));
  }

  /**
   * Apply `target()` to a real scroller and row. Returns the scrollTop it set, or null when either node cannot be
   * measured (a hidden popover, a row that was repainted away). The assignment is a plain `scrollTop` write - no
   * `scrollIntoView`, no `behavior: "smooth"`: a held key must not queue animations, and a step is instantaneous.
   */
  function place(scroller, row) {
    if (!scroller || !row) return null;
    if (typeof scroller.getBoundingClientRect !== "function" || typeof row.getBoundingClientRect !== "function") return null;
    const outer = scroller.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    const scrollTop = num(scroller.scrollTop);
    // The border sits outside the scrolled content, and the padding scrolls with it: the content's zero is the
    // scroller's border box top plus its top border.
    const rowTop = inner.top - (outer.top + num(scroller.clientTop)) + scrollTop;
    const next = target({
      rowTop,
      rowHeight: inner.height,
      bandHeight: num(scroller.clientHeight),
      maxScroll: num(scroller.scrollHeight) - num(scroller.clientHeight),
    });
    scroller.scrollTop = next;
    return next;
  }

  /**
   * Does `row` sit fully inside the band at the scroller's current position? The test's own read of the rule, and
   * what a verifier can ask a real page without knowing the arithmetic.
   */
  function shows(scroller, row) {
    if (!scroller || !row) return false;
    const outer = scroller.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    const bandTop = outer.top + num(scroller.clientTop);
    const bandBottom = bandTop + num(scroller.clientHeight);
    const top = num(inner.top);
    const bottom = top + num(inner.height);
    return top >= bandTop - 0.5 && bottom <= bandBottom + 0.5;
  }

  root.wtSearchScroll = { target, place, shows };
})(globalThis);
