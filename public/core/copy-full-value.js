// The clipboard gets the WHOLE worktree name and the WHOLE branch, even though the cell cuts both with an ellipsis.
//
// WHY. public/chart.css ellipsises three things: `td.name` and `td.branch` (line 83) and the name inside the first
// one, `td.name .row-name` (line 113). An ellipsis is a drawing, not a change to the text - but the browser's own
// copy takes the text the SELECTION covers, and a double-click on an ellipsised name selects what is painted, which
// is the cut string. Ctrl+C then put "make-a-truncated-worktree-name-and-e…" on the clipboard: a name that cannot
// be pasted anywhere, from the one gesture a reader uses to take a name out of the board.
//
// WHAT THIS DOES, and what it deliberately does not. The chart keeps its ellipsis and its layout - the row has
// eleven columns and the name is the one thing that can afford to lose letters - so nothing here touches CSS, the
// cells or their widths. The rule is only about the CLIPBOARD: when the selection (or the caret) sits inside a
// truncated name or branch cell, the copy event is answered with the cell's whole value instead of the visible
// fragment.
//
// Three bounds on that, each of them the difference between a fix and a new bug:
//
//   - the CELL decides, not the row: a copy in any other cell - the tip sha, the verdict, the dirty count - is
//     left completely alone. The handler writes nothing and calls no preventDefault, so the browser's own copy
//     runs exactly as it always did;
//   - TRUNCATION is the trigger, not the cell. A name that fits its column is copied by the browser as the reader
//     selected it: half a name they dragged across, one word of a branch. Replacing that with the whole value
//     would be the clipboard quietly disagreeing with the highlight on the screen;
//   - the selection has to live in ONE cell. A drag from the name into the branch is a selection of two values,
//     and answering it with one of them would lose the other, so a selection whose anchor and focus resolve to
//     different cells is the browser's.
//
// The listener is on the DOCUMENT, not on the rows: the board rebuilds and repaints rows constantly (a scan, a
// fold, a single-row repaint), and a listener bound to a row would be gone with it. Nothing here holds a node.
//
// WHERE THE WHOLE VALUE COMES FROM. The row's cells carry it as `data-copy-value` (public/render-projects.js, the
// one place that draws td.name and td.branch). It is not `data-copy`: that attribute is the console's block-lift
// mechanism (public/board/console.js), and any element wearing it grows a ⧉ button on hover, which inside a chart
// cell would be a new control in the row. It is not the cell's `title` either: the name cell's title is the tree's
// PATH, and the branch cell's is the sentence about the remote, so neither is the value being copied.
//
// Loaded by public/index.html as a classic script (this page has no bundler and no ES modules), before app.js. It
// declares, publishes itself on `globalThis.wtCopyFull` for the tests, and registers its one listener; nothing
// waits on boot.
(function () {
  "use strict";

  // The two cells the chart truncates, and the attribute the row carries their whole value on.
  const CELL_SEL = "td.name, td.branch";
  const NAME_INNER_SEL = ".row-name";
  const VALUE_ATTR = "data-copy-value";

  // The element a selection node belongs to. A selection's endpoints are usually text nodes, and the caret in an
  // empty cell is the cell itself.
  function elementOf(node) {
    if (!node) return null;
    if (node.nodeType === 3) return node.parentElement || null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  // The cell a node sits in, or null. `closest` is what makes a text node inside `.row-name`, a click on the
  // branch's own link, and a caret at the cell's edge all answer the same td.
  function cellOf(node) {
    const el = elementOf(node);
    return el && typeof el.closest === "function" ? el.closest(CELL_SEL) : null;
  }

  // The element whose overflow is the ellipsis. In the name cell that is `.row-name` (the flex line's own child,
  // css line 113); the branch cell truncates as a whole (css line 83), so it is its own clip.
  function clipOf(cell) {
    if (!cell) return null;
    if (cell.classList && cell.classList.contains("name") && typeof cell.querySelector === "function") {
      return cell.querySelector(NAME_INNER_SEL) || cell;
    }
    return cell;
  }

  // Is this cell drawing less than it holds? The same test the browser's own overflow test is: the content is
  // wider than the box. A cell with no width yet (a row measured before layout) is not truncated - it is unknown -
  // and is left to the browser, because guessing there would replace a correct copy with a wrong one.
  function truncated(cell) {
    const el = clipOf(cell);
    if (!el) return false;
    const content = Number(el.scrollWidth || 0);
    const box = Number(el.clientWidth || 0);
    return box > 0 && content > box;
  }

  // The whole value the row put on the cell, or "" when it carries none (a row with no branch at all).
  function valueOf(cell) {
    if (!cell || typeof cell.getAttribute !== "function") return "";
    return String(cell.getAttribute(VALUE_ATTR) || "");
  }

  // What this copy should put on the clipboard, or null when it is not ours to answer. Pure: it reads the
  // selection and the cell, writes nothing, so the test drives it and the listener below is a three-line caller.
  function copyValueFor(sel) {
    if (!sel || !sel.rangeCount) return null;
    const cell = cellOf(sel.anchorNode);
    if (!cell) return null;
    // One cell, not two: an anchor and a focus in different cells is a drag across values.
    if (cellOf(sel.focusNode) !== cell) return null;
    if (!truncated(cell)) return null;
    const value = valueOf(cell);
    return value || null;
  }

  function onCopy(event) {
    if (!event || !event.clipboardData) return;
    const sel = typeof globalThis.getSelection === "function" ? globalThis.getSelection() : null;
    const value = copyValueFor(sel);
    if (!value) return; // not a truncated name or branch cell: the browser's copy, untouched
    event.clipboardData.setData("text/plain", value);
    event.preventDefault();
  }

  const api = { CELL_SEL, NAME_INNER_SEL, VALUE_ATTR, elementOf, cellOf, clipOf, truncated, valueOf, copyValueFor, onCopy };
  globalThis.wtCopyFull = api;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("copy", onCopy);
  }
})();
