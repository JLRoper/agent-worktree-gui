// The clipboard gets the WHOLE worktree name and the WHOLE branch, from a highlight as well as from Ctrl+C, even
// though the cell cuts both with an ellipsis.
//
// WHY. public/chart.css ellipsises three things: `td.name` and `td.branch` (line 83) and the name inside the first
// one, `td.name .row-name` (line 113). An ellipsis is a drawing, not a change to the text - but the browser's own
// copy takes the text the SELECTION covers, and a highlight on an ellipsised name covers what is painted, which is
// the cut string. Ctrl+C then put "make-a-truncated-worktree-name-and-e…" on the clipboard: a name that cannot be
// pasted anywhere, from the one gesture a reader uses to take a name out of the board.
//
// WHAT THIS DID IN PR 712, and what it adds. 712 answered the `copy` EVENT: when the selection (or the caret) sat
// inside a TRUNCATED name or branch cell, the copy was written as the cell's whole value instead of the visible
// fragment. That still holds, unchanged, in `copyValueFor`/`onCopy` below - including its truncation gate, which is
// why a name that fits its column keeps the browser's own copy of exactly what was selected.
//
//   What 712 did not answer was the HIGHLIGHT itself. Selecting a word and then reaching for Ctrl+C is two
//   gestures, and the reader's instruction here is one: highlighting part of a name or a branch IS the copy. So
//   `onSelectEnd` answers a settled, non-collapsed selection inside those same two cells with the row's whole value,
//   through `navigator.clipboard.writeText` (with the hidden-textarea fallback below for a browser or a gesture the
//   API refuses), and `flash` says "copied" beside the cell, because an invisible write looks like nothing happened.
//   The highlight path has no truncation gate on purpose: a highlight is a request for the value, so half a name
//   hands over the whole name whether or not the column had to cut it. The copy-event path keeps 712's gate.
//
// WHAT THIS DOES NOT DO. The chart keeps its ellipsis and its layout - the row has eleven columns and the name is the
// one thing that can afford to lose letters - so nothing here touches CSS widths, the cells or their text. Three
// bounds, each the difference between a fix and a new bug:
//
//   - the CELL decides, not the row: a highlight or copy in any other cell - the tip sha, the verdict, the dirty
//     count - is left completely alone. The handler writes nothing, cancels nothing and stops nothing, so the
//     browser and the row's own click handler run exactly as they always did;
//   - the selection has to live in ONE cell. A drag from the name into the branch is a selection of two values, and
//     answering it with one of them would lose the other, so a selection whose anchor and focus resolve to
//     different cells is the browser's;
//   - nothing here calls preventDefault or stopPropagation on a mouse or key event, and the flash is
//     `pointer-events: none`: the row still expands on a click, a double-click still selects its word, and a drag
//     still selects exactly the range the reader dragged. tools/verify-copy-full-name.mjs proves all three in
//     Chromium rather than asserting them.
//
// The listeners are on the DOCUMENT, not on the rows: the board rebuilds and repaints rows constantly (a scan, a
// fold, a single-row repaint), and a listener bound to a row would be gone with it. Nothing here holds a node.
//
// WHERE THE WHOLE VALUE COMES FROM. The row's cells carry it as `data-copy-value` (public/render-projects.js, the
// one place that draws td.name and td.branch), written from the worktree model's own name and branch. It is never
// the cell's textContent, which is the ellipsised string. It is not `data-copy`: that attribute is the console's
// block-lift mechanism (public/board/console.js), and any element wearing it grows a ⧉ button on hover, which
// inside a chart cell would be a new control in the row. It is not the cell's `title` either: the name cell's title
// is the tree's PATH, and the branch cell's is the sentence about the remote, so neither is the value being copied.
//
// Loaded by public/index.html as a classic script (this page has no bundler and no ES modules), before app.js. It
// declares, publishes itself on `globalThis.wtCopyFull` for the tests, and registers its listeners; nothing waits
// on boot.
(function () {
  "use strict";

  // The two cells the chart truncates, and the attribute the row carries their whole value on.
  const CELL_SEL = "td.name, td.branch";
  const NAME_INNER_SEL = ".row-name";
  const VALUE_ATTR = "data-copy-value";
  // The flash's own class and lifetime. Long enough to read, short enough that a second highlight replaces it.
  const FLASH_CLASS = "copy-flash";
  const FLASH_MS = 1100;
  // How long a selection has to stand still before the settled-selection check answers it. Only a fallback: the
  // mouseup path answers the ordinary drag, this one catches a selection made without one (keyboard, or a release
  // outside the window).
  const SETTLE_MS = 160;

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

  function selectionNow() {
    return typeof globalThis.getSelection === "function" ? globalThis.getSelection() : null;
  }

  // What a copy EVENT should put on the clipboard, or null when it is not ours to answer. Pure: it reads the
  // selection and the cell, writes nothing. 712's rule, unchanged: one TRUNCATED cell, and only then.
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

  // What a settled HIGHLIGHT should put on the clipboard, or null when it is not ours to answer. A highlight is
  // non-collapsed (a caret alone is not a highlight) and lives in one name or branch cell; its whole value is the
  // answer whether or not the column had to cut it. Pure, like `copyValueFor`, so the test drives it directly.
  function highlightValueFor(sel) {
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const cell = cellOf(sel.anchorNode);
    if (!cell) return null;
    if (cellOf(sel.focusNode) !== cell) return null;
    const value = valueOf(cell);
    return value || null;
  }

  // The highlight's own text, for the dedupe key. A selection with no text (a node selection across the cell) still
  // answers its cell's value, so this is only ever the second half of the key.
  function selectionText(sel) {
    try {
      return String(sel || "");
    } catch {
      return "";
    }
  }

  // ---- the flash ---------------------------------------------------------------------------------------
  // One node, appended to the body and left `pointer-events: none`, so a repainted row cannot strand it inside a
  // table cell and no click can land on it. It removes itself; the board is rebuilt constantly and a flash that
  // outlived its write would be a chip sitting on the page forever.
  function flash(cell) {
    if (typeof document === "undefined" || !document.body || typeof document.createElement !== "function") return null;
    const prior = typeof document.querySelectorAll === "function" ? document.querySelectorAll(`.${FLASH_CLASS}`) : [];
    for (const old of [...prior]) if (typeof old.remove === "function") old.remove();
    const el = document.createElement("div");
    el.className = FLASH_CLASS;
    el.textContent = "copied";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    const rect = cell && typeof cell.getBoundingClientRect === "function" ? cell.getBoundingClientRect() : null;
    if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.bottom)) {
      el.style.left = `${Math.round(rect.left)}px`;
      el.style.top = `${Math.round(rect.bottom + 4)}px`;
    }
    document.body.appendChild(el);
    if (typeof globalThis.setTimeout === "function") {
      globalThis.setTimeout(() => {
        if (typeof el.remove === "function") el.remove();
        else if (el.parentNode) el.parentNode.removeChild(el);
      }, FLASH_MS);
    }
    return el;
  }

  // ---- the write ---------------------------------------------------------------------------------------
  // The clipboard API first: it is the modern write, and it is what proves the value in a real browser. A browser
  // that refuses it - no `navigator.clipboard` (a plain-http origin), no permission, or a gesture it does not count
  // - gets the old hidden-textarea path, which is a `copy` command with the value in a selected textarea. The
  // selection is put back afterwards so the reader's highlight stays on the screen where they made it.
  function fallbackWrite(value) {
    if (typeof document === "undefined") return false;
    const body = document.body;
    if (!body || typeof document.createElement !== "function" || typeof document.execCommand !== "function") return false;
    const sel = selectionNow();
    const saved = [];
    if (sel && sel.rangeCount) for (let i = 0; i < sel.rangeCount; i += 1) saved.push(sel.getRangeAt(i).cloneRange());
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
    body.appendChild(ta);
    let ok = false;
    try {
      ta.focus();
      ta.select();
      ok = document.execCommand("copy") === true;
    } catch {
      ok = false;
    }
    if (typeof ta.remove === "function") ta.remove();
    else if (ta.parentNode) ta.parentNode.removeChild(ta);
    if (sel && typeof sel.removeAllRanges === "function") {
      sel.removeAllRanges();
      for (const range of saved) sel.addRange(range);
    }
    return ok;
  }

  function writeClipboard(value) {
    const text = String(value == null ? "" : value);
    if (!text) return Promise.resolve(false);
    const nav = typeof navigator !== "undefined" ? navigator : null;
    const clip = nav && nav.clipboard;
    if (clip && typeof clip.writeText === "function") {
      try {
        return Promise.resolve(clip.writeText(text)).then(
          () => true,
          () => fallbackWrite(text),
        );
      } catch {
        return Promise.resolve(fallbackWrite(text));
      }
    }
    return Promise.resolve(fallbackWrite(text));
  }

  // ---- the two answers ---------------------------------------------------------------------------------
  let lastKey = ""; // the highlight already answered, so a settle check and a mouseup do not write twice
  let pointerDown = false;
  let settleTimer = null;

  function onCopy(event) {
    if (!event || !event.clipboardData) return;
    const sel = selectionNow();
    const value = copyValueFor(sel);
    if (!value) return; // not a truncated name or branch cell: the browser's copy, untouched
    event.clipboardData.setData("text/plain", value);
    event.preventDefault();
    // The same highlight answered by the copy event must not be written a second time by the settle check.
    lastKey = `${value}\u0000${selectionText(sel)}`;
    flash(cellOf(sel.anchorNode));
  }

  // Answer the selection the reader has now, if it is a highlight inside a name or branch cell. Returns the write's
  // promise (or a resolved false) so the browser proof and the unit test can await it; a duplicate of the last
  // answered highlight writes nothing.
  function onSelectEnd() {
    const sel = selectionNow();
    const value = highlightValueFor(sel);
    if (!value) {
      lastKey = "";
      return Promise.resolve(false);
    }
    const key = `${value}\u0000${selectionText(sel)}`;
    if (key === lastKey) return Promise.resolve(false);
    lastKey = key;
    const cell = cellOf(sel.anchorNode);
    return writeClipboard(value).then((ok) => {
      if (ok) flash(cell);
      return ok;
    });
  }

  // A selection made with no mouseup of ours (a shift+arrow drag, a release outside the window) still has to
  // answer, so a settled selection is checked once. While the pointer is down the drag is still moving: the mouseup
  // above is the answer for it, and writing mid-drag would flash "copied" over a name the reader has not finished
  // selecting.
  function scheduleSettleCheck() {
    if (pointerDown) return;
    if (typeof globalThis.setTimeout !== "function") return;
    if (settleTimer) globalThis.clearTimeout(settleTimer);
    settleTimer = globalThis.setTimeout(() => {
      settleTimer = null;
      void onSelectEnd();
    }, SETTLE_MS);
  }

  function onPointerDown() {
    pointerDown = true;
    lastKey = "";
    // A settle check scheduled a moment ago is for a selection this press is about to collapse: drop it, or it
    // would answer a highlight that no longer exists while the reader is mid-drag.
    if (settleTimer) {
      globalThis.clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  function onPointerUp() {
    pointerDown = false;
    void onSelectEnd();
  }

  const api = {
    CELL_SEL,
    NAME_INNER_SEL,
    VALUE_ATTR,
    FLASH_CLASS,
    elementOf,
    cellOf,
    clipOf,
    truncated,
    valueOf,
    copyValueFor,
    highlightValueFor,
    fallbackWrite,
    writeClipboard,
    flash,
    onCopy,
    onSelectEnd,
    scheduleSettleCheck,
  };
  globalThis.wtCopyFull = api;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("copy", onCopy);
    // Capture, so a handler that stops propagation inside a row cannot hide the end of the gesture from us. None of
    // these cancel anything: the click that expands the row, the double-click and the drag all run as they did.
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("mouseup", onPointerUp, true);
    // A keyboard selection (shift+arrow, Home/End) has no mouseup of ours; the settle check above answers it.
    document.addEventListener("selectionchange", scheduleSettleCheck);
  }
})();
