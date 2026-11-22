// The assistant search's popover scroll: public/core/search-scroll.js, and the page that calls it.
//
// WHY THIS FILE EXISTS. A keyboard step used to scroll the transcript and leave the popover's own scroller where it
// was, so from the sixth result on the current row was outside the list's visible band while the header went on
// counting. The rule that fixes it is arithmetic over four numbers, and the two shapes that break a naive
// `scrollIntoView` are exactly the two a unit test can pin without a browser:
//
//   * a row TALLER than the visible band keeps its TOP visible (a matching turn's text starts at its top, and a
//     bottom-aligned tall row shows the reader the foot of the thing they searched for);
//   * the way back UP retraces the way down, because the offset of a row is a function of that row's own geometry
//     and of nothing else - not of the direction the walk arrived from, and not of where the scroller happened to be.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../public/core/search-scroll.js";

const { target, place, shows } = globalThis.wtSearchScroll;

// The popover as it measures at 1440x900: a 376px band inside a 1px border, one row per message with its item
// header above it, so a press moves the list by 59px (a 34px row plus a 21px header plus the 1px gap).
const BAND = 376;
const PITCH = 59;
const ROW = 34;
const FIRST = 24;
const FOOTER = 35;
const rowsAt = (count) => Array.from({ length: count }, (_, i) => FIRST + i * PITCH);
const contentHeight = (count) => FIRST + (count - 1) * PITCH + ROW + FOOTER;
const maxScrollFor = (count) => contentHeight(count) - BAND;

const offset = (rowTop, { bandHeight = BAND, maxScroll = maxScrollFor(10), rowHeight = ROW } = {}) =>
  target({ rowTop, rowHeight, bandHeight, maxScroll });

test("a row below the band lands with its bottom at the band's bottom, the nearest edge in", () => {
  const rows = rowsAt(10);
  // The band is 376px and the pitch is 59px, so the sixth row (index 5) still ends inside it and the seventh is the
  // first one past the fold: its bottom is 36px below the band's bottom, which is exactly what the list scrolls.
  const seventh = rows[6];
  assert.equal(offset(seventh), seventh + ROW - BAND, "the row's bottom edge is the band's bottom edge");
  assert.equal(offset(seventh), 36, "the first press past the fold moves only as far as it must");
  // One press one row: past the fold every step moves by exactly the pitch, not by a page.
  assert.equal(offset(rows[7]) - offset(rows[6]), PITCH);
  assert.equal(offset(rows[9]) - offset(rows[8]), PITCH);
});

test("a row above the band comes back into it, and a row already inside does not move", () => {
  const rows = rowsAt(10);
  // The rows that fit are the first six: their offset is the top of the list, clamped, because a list cannot scroll
  // above its first row - and a press between them moves nothing.
  assert.equal(offset(rows[0]), 0, "the first row is at the top, clamped");
  assert.equal(offset(rows[1]), 0);
  for (const i of [0, 1, 2, 3, 4, 5]) assert.equal(offset(rows[i]), 0, `row ${i} is inside the band at the top`);
  // A row above the fold while the list is scrolled down comes back to the bottom edge it left from.
  assert.equal(offset(rows[4]), 0);
  // The rule is absolute: asking twice asks for the same place, so a press that lands on the same row moves nothing.
  assert.equal(offset(rows[6]), offset(rows[6]));
});

test("a row taller than the band keeps its TOP visible rather than its bottom", () => {
  const rowTop = 300;
  const tall = offset(rowTop, { rowHeight: 900, maxScroll: 4000 });
  assert.equal(tall, rowTop, "a row that cannot fit is aligned by its top, where its text starts");
  assert.notEqual(tall, rowTop + 900 - BAND, "the bottom-aligned answer would show the foot of the turn");
  // The rest of it is off the bottom, which is the honest read: the matched text is at the top.
  assert.ok(tall + BAND < rowTop + 900);
  // Taller than the band but already at the top: a row at the very start of the list still asks for 0.
  assert.equal(offset(0, { rowHeight: 900 }), 0);
  // And the scroller's own reach still wins: a tall row near the end of a short list cannot scroll past its content.
  assert.equal(offset(rowTop, { rowHeight: 900, maxScroll: 100 }), 100);
});

test("the way back up is the way down, row for row", () => {
  const rows = rowsAt(10);
  const down = rows.map((rowTop) => offset(rowTop));
  const up = [...rows].reverse().map((rowTop) => offset(rowTop));
  assert.deepEqual(up, [...down].reverse(), "the reverse walk visits the down walk's offsets in reverse order");
  // The sequence itself is a one-row walk: no step is a page, no step goes backwards, and every step past the fold
  // is exactly one pitch.
  const steps = down.slice(1).map((value, i) => value - down[i]);
  for (const step of steps) assert.ok(step >= 0, "a down press never scrolls the list up");
  for (const step of steps) assert.ok(step <= PITCH, `one press moved ${step}px, more than one row`);
  for (const step of steps.filter((s) => s > 0).slice(1)) assert.equal(step, PITCH, "past the fold, one press is one row");
});

test("a tall row in the middle does not break the reverse walk", () => {
  // A filter whose seventh message is a whole screen tall: the two rows around it must still retrace.
  const rows = rowsAt(10);
  const heightOf = (i) => (i === 6 ? 900 : ROW);
  const at = (i) => offset(rows[i], { rowHeight: heightOf(i), maxScroll: 4000 });
  const down = rows.map((_, i) => at(i));
  const up = [...rows.keys()].reverse().map((i) => at(i));
  assert.deepEqual(up, [...down].reverse());
  assert.equal(at(6), rows[6], "the tall row is top aligned");
  assert.equal(at(7), rows[7] + ROW - BAND, "the row after it is bottom aligned again");
});

test("the answer never asks for a position the scroller does not have", () => {
  const rows = rowsAt(10);
  const max = maxScrollFor(10);
  for (const rowTop of rows) {
    const value = offset(rowTop);
    assert.ok(value >= 0, `${rowTop} asked for ${value}`);
    assert.ok(value <= max, `${rowTop} asked for ${value}, past the scroller's ${max}`);
  }
  // A row at the very bottom of a list whose footer follows it still lands inside the scroller's reach.
  const last = offset(rows[9]);
  assert.ok(last + BAND <= contentHeight(10) - FOOTER, "the last row's bottom is above the footer, not below the view");
  // Fewer rows than fit: nothing to scroll, whatever row is current.
  for (const rowTop of rowsAt(3)) assert.equal(offset(rowTop, { maxScroll: 0 }), 0);
});

// A popover that behaves: the border box starts at y=121 with a 1px border, the band is 376px, the content is 629px,
// and a row's on-screen rect moves with the scroller the way a real one does.
function fakePop({ contentHeight = 629, band = BAND, border = 1, outerTop = 121 } = {}) {
  const state = { scrollTop: 0 };
  const scroller = {
    get scrollTop() {
      return state.scrollTop;
    },
    set scrollTop(value) {
      state.scrollTop = value;
    },
    clientHeight: band,
    clientTop: border,
    scrollHeight: contentHeight,
    getBoundingClientRect: () => ({ top: outerTop, left: 930, height: band + border * 2, width: 380 }),
  };
  const rowAt = (contentTop, height = ROW) => ({
    getBoundingClientRect: () => ({ top: outerTop + border + contentTop - state.scrollTop, left: 935, height, width: 370 }),
  });
  return { scroller, rowAt, state };
}

test("place() reads a scroller and a row and writes the offset it computed", () => {
  const { scroller, rowAt } = fakePop();
  // The row's content offset is 378 (measured from the scroller's own top, padding included), so its bottom sits 36px
  // past the band and that is what the list scrolls to.
  const row = rowAt(378);
  const next = place(scroller, row);
  assert.equal(next, 36, "bottom aligned, from the row's own content offset");
  assert.equal(scroller.scrollTop, next, "and the scroller is actually moved");
  // Idempotent: placing again changes nothing, which is what a repeat press on one row must do.
  assert.equal(place(scroller, row), next);
  assert.equal(scroller.scrollTop, next);
  // A scroller already holding another list: the same row's content offset is the same number, so the answer is too.
  const other = fakePop();
  other.state.scrollTop = 120;
  assert.equal(place(other.scroller, other.rowAt(378)), next, "the same row, the same offset, whatever the scroll");
  // A row taller than the band is top aligned, at its content offset.
  const tall = fakePop({ contentHeight: 4000 });
  assert.equal(place(tall.scroller, tall.rowAt(700, 900)), 700);
});

test("place() refuses what it cannot measure instead of throwing", () => {
  assert.equal(place(null, { getBoundingClientRect: () => ({}) }), null);
  assert.equal(place({ getBoundingClientRect: () => ({}) }, null), null);
  assert.equal(place({}, {}), null, "stubs with no geometry are not a measurement");
});

test("shows() is the reader's question: is the row fully inside the band?", () => {
  const { scroller, rowAt } = fakePop();
  assert.equal(shows(scroller, rowAt(4)), true, "a row inside the band");
  assert.equal(shows(scroller, rowAt(370)), false, "a row hanging over the bottom edge");
  // And after a place(): the same row, fully visible, and the band's edges are where the module thinks they are.
  const row = rowAt(500);
  assert.equal(shows(scroller, row), false);
  place(scroller, row);
  assert.equal(shows(scroller, row), true, "the placed row is inside the band");
  assert.equal(shows(scroller, rowAt(0)), false, "and the row above it has gone past the top edge");
});

// ---- the page's own use of it ---------------------------------------------------------------------------------
// Arithmetic the page never calls is not a fix. These read the wiring: the keyboard path, the popover's own
// scroller, and the module loaded before the page that reads it.
const page = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const revealAt = page.indexOf("function revealSearchHit");
const revealBody = revealAt >= 0 ? page.slice(revealAt, page.indexOf("// One press, one MATCH", revealAt)) : "";
const keepAt = page.indexOf("function keepSearchRowVisible");
const keepBody = keepAt >= 0 ? page.slice(keepAt, page.indexOf("\n  }\n", keepAt)) : "";

test("the keyboard step scrolls the popover, not the transcript", () => {
  assert.ok(revealBody, "revealSearchHit exists in public/assistant.js");
  assert.match(revealBody, /if \(keepList\) keepSearchRowVisible\(\)/, "a keyboard step keeps the current row in the list");
  assert.doesNotMatch(revealBody, /if \(keepList\)[^\n]*scrollIntoView/, "the removed defect: a keyboard step scrolling the transcript");
  assert.match(revealBody, /if \(pop && !keepList\) \{/, "the card reveal is guarded to Enter and a click");
  const movement = revealBody.slice(
    revealBody.indexOf("const pageY = window.scrollY;"),
    revealBody.indexOf("if (keepList) keepSearchRowVisible"),
  );
  assert.equal(
    (movement.match(/scrollIntoView\(/g) || []).length,
    2,
    "two reveals, both inside the !keepList block: the turn and the mark",
  );
  assert.ok(movement.indexOf("if (pop && !keepList) {") < movement.indexOf("scrollIntoView("), "and no reveal outside that block");
  assert.ok(movement.includes("window.scrollTo({ top: pageY })"), "the window is still put back where the reader had it");
  assert.ok(keepBody, "keepSearchRowVisible exists in public/assistant.js");
  // The arithmetic MOVED into the shared popover module (public/core/search-popover.js), which both the turn search
  // and the Hot Agent search mount, so these four read the module's `follow()` - the same assertions, at the one
  // place the behaviour now lives - and the page is pinned to the module rather than to a copy of it.
  const popover = readFileSync(new URL("../public/core/search-popover.js", import.meta.url), "utf8");
  const followAt = popover.indexOf("function follow");
  const followBody = followAt >= 0 ? popover.slice(followAt, popover.indexOf("function wire", followAt)) : "";
  assert.ok(followBody, "follow() exists in public/core/search-popover.js");
  assert.match(followBody, /rowAt\(\s*Number\(current\(\)\)\s*\)/, "it reads the row the walk is standing on");
  assert.match(followBody, /wtSearchScroll/, "through the tested module, not a second copy of the arithmetic");
  assert.match(followBody, /\.place\(list, row\)/, "place() is the call that moves the bar's own list");
  assert.match(keepBody, /bar\.follow\(\)/, "and the page hands the press to that module's follow()");
});

test("the page loads the scroll module before the page that calls it", () => {
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const modAt = index.indexOf('src="/core/search-scroll.js"');
  const assistantAt = index.indexOf('src="/assistant.js"');
  assert.ok(modAt >= 0, "public/index.html loads public/core/search-scroll.js");
  assert.ok(assistantAt > modAt, "the module is loaded before assistant.js, which reads it");
});
