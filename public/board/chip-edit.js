// board/chip-edit.js - the chip itself: how it is built, inserted, folded, removed and deleted by word.
//
// Cut out of board/paste-chips.js at row 517, the first cut of that file. The paste POLICY - the threshold,
// the model, the one reader and its writers, the caret, the paste listener and the composer's undo stack -
// stays in board/paste-chips.js, which is still the entry point public/index.html loads and still publishes
// window.WMApp.board.pasteChips with every name it had (the nine that moved are read back off this file).
//
// WHAT IS HERE. The atom's construction and every way the reader edits one: chipEl and makeChip, the insert
// helpers (insertNodeAt, insertTextAt, insertNewlineAt), fold/toggle/remove (foldChip, toggleChip,
// removeChipEl), openChips, regrowBox, chipBesideCaret, and the Ctrl+Backspace / Ctrl+Delete word delete
// (chipBoxChars, chipCaretPoint, chipWordSpan, chipWidenSpan, chipPointAt, chipDeleteChars) that the
// keyboard listener in board/paste-chips.js calls.
//
// LOAD ORDER. A classic script loaded BEFORE board/paste-chips.js in public/index.html, because that file's
// export object is built at load and reads these names; both load before app.js, so every bare-name caller in
// app.js and the other board scripts still finds them. No function here runs at load: each reads `state`, the
// DOM and the helpers left in board/paste-chips.js by name when it is called, exactly as it did inside that
// file.
//
// This file publishes exactly the nine names board/paste-chips.js re-exports, on
// window.WMApp.board.chipEdit. The word-delete helpers are not on that surface: board/paste-chips.js reaches
// them as ordinary classic-script globals.

// ---- building and editing chips -----------------------------------------------------------

function chipEl(id, lines, text) {
  const el = document.createElement("span");
  el.className = "paste-chip";
  el.setAttribute("contenteditable", "false");
  el.dataset.pasteChip = id;
  el.title = "a pasted block \u2014 click to read it here, \u00d7 or Backspace to remove it whole";
  const label = document.createElement("span");
  label.className = "pc-label";
  label.dataset.pasteToggle = id;
  label.textContent = chipLabel(lines, text);
  el.appendChild(label);
  const x = document.createElement("span");
  x.className = "pc-x";
  x.dataset.pasteRemove = id;
  x.setAttribute("role", "button");
  x.setAttribute("aria-label", "remove this pasted block");
  x.textContent = "\u00d7";
  el.appendChild(x);
  return el;
}

function makeChip(text) {
  const info = pasteText(text);
  state.pasteChipSeq = (state.pasteChipSeq || 0) + 1;
  const id = `pc${state.pasteChipSeq}`;
  state.pasteChips.set(id, { text: info.text, lines: info.lines });
  return chipEl(id, info.lines, info.text);
}

function insertNodeAt(box, node) {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const inBox = Boolean(range && box.contains(range.startContainer));
  if (!inBox) {
    box.appendChild(node);
  } else {
    range.deleteContents();
    range.insertNode(node);
  }
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(after);
  }
}

function insertTextAt(box, text) {
  const s = String(text == null ? "" : text);
  if (!s) return;
  insertNodeAt(box, document.createTextNode(s));
}

function touchBox(box) {
  if (box) box.dispatchEvent(new Event("input", { bubbles: true }));
}

// Shift+Enter: a real newline at the caret, wherever the caret is. Works in a textarea too, so all the
// message boxes share one implementation.
function insertNewlineAt(box) {
  insertTextAt(box, "\n");
  touchBox(box);
}

// Remove one chip, whole, from the DOM and from the state — and put the caret where it was, so Backspace
// twice in a row reads as deleting two blocks.
function removeChipEl(el, { focus = false } = {}) {
  if (!el) return;
  const box = chipBoxOf(el);
  const id = el.dataset.pasteChip;
  const offset = box ? serialOffsetIn(box, el, 0) : 0;
  foldChip(el);
  el.remove();
  if (id) state.pasteChips.delete(id);
  if (!box) return;
  if (focus) {
    try {
      box.focus({ preventScroll: true });
    } catch {
      box.focus();
    }
  }
  setCaretOffset(box, offset);
  touchBox(box);
}

function openChips(root) {
  return [...(root || document).querySelectorAll(".paste-chip.is-open")];
}

// The box grew to hold the reader's draft; an unfolded block is more of it. Re-measure with the panel's own
// grower (a page global), capped exactly as a typed draft is — past the cap the box scrolls, like a long draft.
function regrowBox(box) {
  if (!box || typeof growBoxToDraft !== "function") return;
  const replyMax = typeof REPLY_MAX_LINES === "number" ? REPLY_MAX_LINES : 18;
  const spawnMax = typeof SPAWN_MAX_LINES === "number" ? SPAWN_MAX_LINES : 14;
  growBoxToDraft(box, box.id === "job-prompt" ? spawnMax : replyMax);
}

function foldChip(el) {
  const box = chipBoxOf(el);
  el.classList.remove("is-open");
  const body = el.querySelector(".pc-body");
  if (body) body.remove();
  regrowBox(box);
}

// Clicking the chip shows the full pasted text in place, wrapped and read-only; clicking again folds it back.
// This is a read, never an edit path: the body is not editable and nothing here touches the model.
function toggleChip(el) {
  const box = chipBoxOf(el);
  if (el.classList.contains("is-open")) {
    foldChip(el);
    return;
  }
  const c = state.pasteChips.get(el.dataset.pasteChip);
  if (!c) return;
  if (!el.querySelector(".pc-body")) {
    const body = document.createElement("div");
    body.className = "pc-body";
    body.setAttribute("contenteditable", "false");
    const text = document.createElement("div");
    text.className = "pc-text";
    text.textContent = c.text;
    body.appendChild(text);
    el.appendChild(body);
  }
  el.classList.add("is-open");
  regrowBox(box);
}

// Is a chip the very next thing in the box's own text, on the side the key deletes from?
function chipBesideCaret(box, dir) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (!box.contains(node)) return null;
  const chip = (n) => (n && n.nodeType === 1 && n.dataset && n.dataset.pasteChip ? n : null);
  if (node.nodeType === 3) {
    if (dir < 0 && range.startOffset === 0) return chip(node.previousSibling);
    if (dir > 0 && range.startOffset === node.data.length) return chip(node.nextSibling);
    return null;
  }
  const kids = node.childNodes;
  const at = dir < 0 ? range.startOffset - 1 : range.startOffset;
  return at >= 0 && at < kids.length ? chip(kids[at]) : null;
}

// ---- Ctrl+Backspace and Ctrl+Delete -----------------------------------------------------
// The handler below used to return on any modifier, so a word delete was whatever the engine did on its own:
// at a chip's edge Chrome happens to take the atom, but nothing here decided it, the chip's text was left in
// state.pasteChips, and no test could see any of it. These helpers let the box do it itself, so the same press
// reads the same in every engine and the suite can fire it.
//
// The rule is Chrome's own, measured case by case: take the word on that side of the caret, with the
// whitespace that side owns. Punctuation is a word of its own, a line break is taken alone, and a chip is an
// atom - the branch above removes it whole, and a word delete never reaches across one.
//
// Every helper here is chip-prefixed on purpose: these files are classic scripts sharing one global, and
// public/dom.js already declares a pointAt() of its own, which silently replaced this one until it was renamed.

const CHIP_WORD_CHAR = /[\p{L}\p{N}_]/u;
const CHIP_SPACE_CHAR = /\s/u;
const chipIsHighSurrogate = (ch) => ch >= "\uD800" && ch <= "\uDBFF";
const chipIsLowSurrogate = (ch) => ch >= "\uDC00" && ch <= "\uDFFF";

// The box's content as the caret sees it: one entry per character, a <br> as one line break, and a chip (or
// any element this module did not make) as an atom boundary with no characters of its own. Every writer of
// these boxes is this module, so the content is flat - text nodes, chips and breaks, as siblings under the
// box - and an engine-made wrapper is a boundary, never a place to edit.
function chipBoxChars(box) {
  const out = [];
  for (const child of box.childNodes) {
    if (child.nodeType === 3) {
      for (let i = 0; i < child.data.length; i += 1) {
        out.push({ node: child, index: i, ch: child.data[i], kind: "text" });
      }
    } else if (child.nodeType === 1 && child.tagName === "BR") {
      out.push({ node: child, index: 0, ch: "\n", kind: "break" });
    } else {
      out.push({ node: child, index: 0, ch: "", kind: "atom" });
    }
  }
  return out;
}

// Where the caret sits among those characters, as an insertion point (0..chars.length), or -1 when this box is
// not the one being edited (a live selection, a caret elsewhere, a caret inside an engine-made wrapper).
function chipCaretPoint(box, chars) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return -1;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return -1;
  const node = range.startContainer;
  if (!box.contains(node)) return -1;
  if (node.nodeType === 3) {
    const first = chars.findIndex((e) => e.node === node);
    return first < 0 ? -1 : first + Math.min(range.startOffset, node.data.length);
  }
  if (node !== box) return -1;
  const child = box.childNodes[range.startOffset] || null;
  if (!child) return chars.length;
  const at = chars.findIndex((e) => e.node === child);
  return at < 0 ? chars.length : at;
}

// What one press takes: [from, to) in characters, or null when there is nothing on that side to take.
function chipWordSpan(chars, point, dir) {
  const isWord = (e) => e && e.kind === "text" && CHIP_WORD_CHAR.test(e.ch);
  const isSpace = (e) => e && e.kind === "text" && CHIP_SPACE_CHAR.test(e.ch);
  const isText = (e) => e && e.kind === "text";
  if (dir < 0) {
    let i = point;
    const prev = chars[i - 1];
    if (!prev) return null;
    if (prev.kind === "break") return { from: i - 1, to: i }; // a line break goes on its own
    if (prev.kind !== "text") return null; // the chip branch above owns this press
    if (isSpace(prev)) {
      // Whitespace, then what it was in front of: a word, or one punctuation character.
      while (i > 0 && isSpace(chars[i - 1])) i -= 1;
      if (i > 0 && isWord(chars[i - 1])) while (i > 0 && isWord(chars[i - 1])) i -= 1;
      else if (i > 0 && isText(chars[i - 1])) i -= 1;
    } else if (isWord(prev)) {
      while (i > 0 && isWord(chars[i - 1])) i -= 1;
    } else {
      i -= 1; // punctuation: one character, as Chrome takes it
    }
    return i < point ? { from: i, to: point } : null;
  }
  let j = point;
  const next = chars[j];
  if (!next) return null;
  if (next.kind === "break") return { from: j, to: j + 1 };
  if (next.kind !== "text") return null;
  if (isSpace(next)) {
    // Forward over whitespace the whitespace goes alone: the word after it keeps its own press.
    while (j < chars.length && isSpace(chars[j])) j += 1;
  } else if (isWord(next)) {
    while (j < chars.length && isWord(chars[j])) j += 1;
    while (j < chars.length && isSpace(chars[j])) j += 1;
  } else {
    j += 1; // punctuation, then the whitespace that side owns
    while (j < chars.length && isSpace(chars[j])) j += 1;
  }
  return j > point ? { from: point, to: j } : null;
}

// A span never splits a character outside the basic plane: an emoji is two code units, and half of one is not
// a thing a box can hold.
function chipWidenSpan(chars, span) {
  let { from, to } = span;
  if (from > 0 && chars[from] && chipIsLowSurrogate(chars[from].ch) && chars[from - 1] && chipIsHighSurrogate(chars[from - 1].ch)) {
    from -= 1;
  }
  if (to < chars.length && chars[to] && chipIsLowSurrogate(chars[to].ch) && chars[to - 1] && chipIsHighSurrogate(chars[to - 1].ch)) {
    to += 1;
  }
  return { from, to };
}

// The DOM point at a character index: an offset inside the text node that holds it, the boundary in front of
// the element at it, or the end of the box.
function chipPointAt(box, chars, at) {
  if (at <= 0) return { node: box, offset: 0 };
  if (at >= chars.length) return { node: box, offset: box.childNodes.length };
  const e = chars[at];
  if (e.kind === "text") return { node: e.node, offset: e.index };
  const parent = e.node.parentNode || box;
  return { node: parent, offset: [...parent.childNodes].indexOf(e.node) };
}

// Take the characters, leave the caret where the run began, and let the box's own reader hear about it (an
// `input`, exactly as a typed deletion makes) so the draft and the chip model are saved.
function chipDeleteChars(box, chars, span) {
  const start = chipPointAt(box, chars, span.from);
  const end = chipPointAt(box, chars, span.to);
  // The serial offset the caret keeps, counted before the DOM changes: a chip is the text it swallowed.
  let caret = 0;
  for (let i = 0; i < span.from; i += 1) caret += chars[i].kind === "atom" ? nodeLength(chars[i].node) : 1;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  range.deleteContents();
  setCaretOffset(box, caret);
  touchBox(box);
}

// ---- what this file publishes ----------------------------------------------------------------
// The nine names board/paste-chips.js re-exports off this module, so its window.WMApp.board.pasteChips is the
// surface it always was. Nothing else is published: the word-delete helpers are read as page globals.
window.WMApp = window.WMApp || {};
window.WMApp.board = window.WMApp.board || {};
window.WMApp.board.chipEdit = {
  insertTextAt,
  insertNewlineAt,
  makeChip,
  chipEl,
  removeChipEl,
  toggleChip,
  foldChip,
  openChips,
  chipBesideCaret,
};
