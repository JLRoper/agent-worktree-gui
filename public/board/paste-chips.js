// board/paste-chips.js — a big paste collapses, in place at the caret, into one inline chip.
//
// WHY THIS FILE EXISTS. A <textarea> cannot hold an inline widget: its text is either text or it is not
// editable, so "one chip you can type quotes around" is a contenteditable box with the pasted block as a
// NON-EDITABLE INLINE ATOM inside it. This module is that atom, for every box the reader writes a prompt in,
// and there is one implementation of it — no per-box copy.
//
// THE VALUE CONTRACT (the reason the box could stop being a textarea). Exactly one place reads a box's text:
//
//     readBox(box)  ->  the same string `box.value` used to give, with every chip serialized back to the
//                       text it swallowed, in position.
//
// Every reader of a prompt box (send, steer, queue, draft save, history recall, the Clear button) goes
// through it, and every writer goes through writeBox/writeBoxModel. A chip therefore never changes what a
// caller sees; it only changes what the reader sees.
//
// WHERE THE CHIP'S TEXT LIVES. In the panel's state, keyed by an id — `state.pasteChips` (id -> {text, lines})
// — never only in the DOM. The card on this board is rebuilt on every scan, so a chip that lived only in the
// markup would come back as a stranger (or not at all); `state.boxModels` (box key -> chip/text segments) is
// what a rebuild and a reload replay, and the same pair is mirrored into sessionStorage so a reload brings a
// pasted block back with its text instead of losing a 400-line paste to one accidental F5.
//
// BELOW THE THRESHOLD NOTHING CHANGES: a short paste is plain inline text, an image or file paste is still
// the attachment chip board/attachments.js owns (this module steps aside for it — see the paste listener).
//
// Loaded as a classic script BEFORE app.js (see index.html), so its globals exist by the time app.js builds
// its state and wires its own handlers. It reaches out for `state` by name at call time, exactly as
// board/attachments.js does.

// ---- the thresholds, and what a chip says ------------------------------------------------
// A paste collapses when it is long enough to be worth collapsing: 300 characters or 5 lines, whichever it
// hits first. The label shows the line count and the first characters, and the preview is display only.
const PASTE_CHIP_MIN_CHARS = 300;
const PASTE_CHIP_MIN_LINES = 5;
const PASTE_CHIP_PREVIEW = 40;

// The chip-bearing drafts, mirrored per browser tab. Only drafts that CARRY a chip are mirrored: a plain
// draft is plain text and behaves exactly as it did before this feature (nothing here is remembered for it),
// while a pasted block is the one thing nobody wants to lose to a reload.
const CHIP_DRAFT_KEY = "wtgui.chipDrafts";
const CHIP_DRAFT_MAX = 8;
const CHIP_DRAFT_BYTES = 3 * 1024 * 1024;

// ---- the model ---------------------------------------------------------------------------

// The lines a paste counts as. A trailing newline is not a line of its own (a copied block almost always
// ends with one), so "4 lines plus a final newline" stays below the 5-line threshold and pastes as text.
// CRLF is normalised to LF, which is what a textarea's own value does with a pasted block today.
function pasteText(raw) {
  const text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n");
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return { text, lines: Math.max(1, parts.length) };
}

function pasteShouldChip(text) {
  return text.length >= PASTE_CHIP_MIN_CHARS || pasteText(text).lines >= PASTE_CHIP_MIN_LINES;
}

function chipText(id) {
  const c = state.pasteChips && state.pasteChips.get(id);
  return c && typeof c.text === "string" ? c.text : "";
}

function chipLabel(lines, text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  const preview = flat.length > PASTE_CHIP_PREVIEW ? `${flat.slice(0, PASTE_CHIP_PREVIEW)}\u2026` : flat;
  return `[Pasted ${lines} line${lines === 1 ? "" : "s"}: ${preview}]`;
}

function loadPasteChipState() {
  const out = { chips: new Map(), drafts: new Map(), seq: 0 };
  let raw = null;
  try {
    raw = JSON.parse(sessionStorage.getItem(CHIP_DRAFT_KEY) || "null");
  } catch {
    raw = null; // no storage (private mode, a blocked tab): chips live for this page's life, which is enough
  }
  const chips = raw && raw.chips && typeof raw.chips === "object" ? raw.chips : {};
  for (const [id, c] of Object.entries(chips)) {
    if (!c || typeof c.text !== "string") continue;
    const text = c.text;
    out.chips.set(id, { text, lines: Number(c.lines) || pasteText(text).lines });
    const n = Number(String(id).replace(/^pc/, ""));
    if (Number.isFinite(n) && n > out.seq) out.seq = n;
  }
  const drafts = raw && raw.drafts && typeof raw.drafts === "object" ? raw.drafts : {};
  for (const [key, model] of Object.entries(drafts)) {
    const clean = cleanModel(model).filter((s) => s.t !== "chip" || out.chips.has(s.id));
    if (clean.length) out.drafts.set(key, clean);
  }
  return out;
}

// Text segments merge, empty ones vanish, a chip that no longer has its text does not survive: the model is
// the box's own content read back, so it has to serialize to exactly the string the draft holds.
function cleanModel(model) {
  const out = [];
  if (!Array.isArray(model)) return out;
  for (const seg of model) {
    if (!seg || typeof seg !== "object") continue;
    if (seg.t === "chip" && typeof seg.id === "string") out.push({ t: "chip", id: seg.id });
    else if (seg.t === "text" && typeof seg.v === "string" && seg.v) {
      const last = out[out.length - 1];
      if (last && last.t === "text") last.v += seg.v;
      else out.push({ t: "text", v: seg.v });
    }
  }
  return out;
}

function modelText(model) {
  return cleanModel(model)
    .map((s) => (s.t === "chip" ? chipText(s.id) : s.v))
    .join("");
}

// What is in the box right now, as segments. The DOM is the working copy while the reader types; this is what
// the panel remembers, and what a rebuild replays.
function serializeBox(box) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.t === "text") last.v += v;
    else out.push({ t: "text", v });
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        // A typing engine writes a NON-BREAKING space where its own text goes (a space at the end of a line, or
        // next to a chip) so the space stays visible. A textarea never did that, and the reader typed a space,
        // so it is read back as the space it was typed as. A chip's own text is untouched: that is the paste.
        push(child.data.replace(/\u00a0/g, " "));
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (child.dataset && child.dataset.pasteChip) {
        out.push({ t: "chip", id: child.dataset.pasteChip });
        continue;
      }
      const tag = child.tagName;
      if (tag === "BR") {
        push("\n");
        continue;
      }
      // A block wrapper is an editing engine's own doing (a line break it inserted itself) and means the same
      // thing here as in a textarea: one more line.
      if (tag === "DIV" || tag === "P" || tag === "LI") {
        if (out.length) push("\n");
        walk(child);
        push("\n");
        continue;
      }
      walk(child);
    }
  };
  walk(box);
  // A trailing block newline is the WRAPPER's, not the reader's — and only a block wrapper can explain one, so
  // this is the only case it is dropped: a real newline at the very end of the box (Shift+Enter, or a pasted
  // block's own last line) is the reader's text and stays.
  const tail = box.lastChild;
  const wrapperTail = Boolean(tail && tail.nodeType === 1 && (tail.tagName === "DIV" || tail.tagName === "P" || tail.tagName === "LI"));
  const last = out[out.length - 1];
  if (last && last.t === "text") {
    if (wrapperTail && last.v.endsWith("\n")) last.v = last.v.slice(0, -1);
    if (!last.v) out.pop();
  }
  return out;
}

// ---- the one reader, and its writers ------------------------------------------------------
// The read side takes the engine's NON-BREAKING space back to the space the reader typed (see serializeBox);
// the write side has to hand it back the same way, or the reader loses a space they typed. A browser stores a
// typed space as U+00A0 exactly where a plain space is COLLAPSING whitespace — the end of the box's content,
// and a run touching a chip (an inline-block) — and it drops a plain space written there on the next
// keystroke: type "two words", let a repaint rewrite the box, and the next letter eats the space, so the agent
// receives "twowords". Only those runs are written non-breaking, so ordinary spaces still wrap and break.
const NBSP = "\u00a0";
const holdSpaces = (text, { end = false, chipBefore = false, chipAfter = false } = {}) => {
  const s = String(text == null ? "" : text);
  let out = s;
  if (chipBefore) out = out.replace(/^ +/, (m) => NBSP.repeat(m.length));
  if (end || chipAfter) out = out.replace(/ +$/, (m) => NBSP.repeat(m.length));
  return out;
};

function chipBoxOf(node) {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  return el && el.closest ? el.closest("[data-chipbox]") : null;
}

function readBox(box) {
  if (!box) return "";
  // Anything still a real field form reads itself, so a box this feature never touched cannot change meaning.
  if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") return String(box.value == null ? "" : box.value);
  return serializeBox(box)
    .map((s) => (s.t === "chip" ? chipText(s.id) : s.v))
    .join("");
}

function writeBox(box, text) {
  if (!box) return;
  if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
    box.value = String(text == null ? "" : text);
    return;
  }
  const s = String(text == null ? "" : text);
  // A box with content is always ending its content here, so its last spaces go back non-breaking.
  if (!s) box.replaceChildren(); // empty, not a lone empty text node: the placeholder is drawn on :empty
  else box.replaceChildren(document.createTextNode(holdSpaces(s, { end: true })));
}

function writeBoxModel(box, model) {
  const segs = cleanModel(model);
  const frag = document.createDocumentFragment();
  segs.forEach((seg, i) => {
    if (seg.t === "text") {
      // Same rule per segment: the last one ends the content, and a run touching a chip is collapsing too.
      frag.appendChild(
        document.createTextNode(
          holdSpaces(seg.v, {
            end: i === segs.length - 1,
            chipBefore: i > 0 && segs[i - 1].t === "chip",
            chipAfter: i + 1 < segs.length && segs[i + 1].t === "chip",
          }),
        ),
      );
      return;
    }
    const c = state.pasteChips.get(seg.id);
    if (!c) return; // a chip whose text is gone is not drawn at all: never a half-chip
    frag.appendChild(chipEl(seg.id, c.lines, c.text));
  });
  box.replaceChildren(frag);
}

function boxKeyOf(box) {
  return (box && box.dataset && box.dataset.chipbox) || "";
}

// The model the panel holds for this box, if it is the model OF this draft. Keyed on the text as well as the
// key, so a model can never outlive the draft it was made from (a history recall, a pending steer coming
// back, a cleared box): if the two disagree, the draft wins and the model is dropped.
function modelForDraft(box, text) {
  const key = boxKeyOf(box);
  const model = key ? state.boxModels.get(key) : null;
  if (!model || !model.some((s) => s.t === "chip")) return null;
  if (text != null && modelText(model) !== String(text)) return null;
  return model;
}

function restoreBoxDraft(box, text) {
  const model = modelForDraft(box, text);
  if (!model) return false;
  writeBoxModel(box, model);
  return true;
}

// A draft this page did not live long enough to type: the chip-bearing ones are mirrored in sessionStorage
// and come back here, on the first render of the box they belong to.
function restorePersistedBox(box) {
  const key = boxKeyOf(box);
  if (!key || readBox(box)) return false;
  const model = state.boxModels.get(key);
  if (!model || !model.some((s) => s.t === "chip")) return false;
  writeBoxModel(box, model);
  return true;
}

function restoreChipBoxes(root) {
  const boxes = (root || document).querySelectorAll("[data-chipbox]");
  let restored = 0;
  for (const box of boxes) if (restorePersistedBox(box)) restored += 1;
  return restored;
}

// Move what one box holds into another box, chips included. The inline add-agent field hands its prompt to the
// New agent card, and a pasted block must not be flattened into text on the way: the model travels, so the chip
// is on the card and the run still receives every character of it.
function transferBoxModel(fromKey, toBox, text) {
  const model = fromKey ? state.boxModels.get(fromKey) : null;
  // Trimmed on both sides: the caller hands over its own trimmed copy of the text, and a send trims anyway —
  // what matters is that the model is the model OF this prompt, not that the whitespace matches.
  const mine =
    model && model.some((s) => s.t === "chip") && modelText(model).trim() === String(text).trim() ? model : null;
  if (!mine) {
    writeBox(toBox, text);
    return false;
  }
  writeBoxModel(toBox, mine);
  const key = boxKeyOf(toBox);
  if (key) state.boxModels.set(key, cleanModel(mine));
  saveChipDrafts();
  return true;
}

function clearBoxDraft(boxOrKey) {
  const key = typeof boxOrKey === "string" ? boxOrKey : boxKeyOf(boxOrKey);
  if (!key) return;
  // A composer the panel cleared holds no history: the draft the entries belonged to is gone (see the
  // action stack below).
  clearComposerActions(key);
  // The chips go with the draft they were part of: a box that has been sent, steered or cleared has no claim on
  // a pasted block any more, and holding its text would keep a megabyte alive for the life of the page.
  const model = state.boxModels.get(key);
  if (model) for (const seg of model) if (seg.t === "chip") state.pasteChips.delete(seg.id);
  state.boxModels.delete(key);
  saveChipDrafts();
}

// Remember what this box holds. Only a draft that carries a chip needs a model: a plain draft is text, and the
// panel already keeps its text.
function rememberBoxModel(box) {
  const key = boxKeyOf(box);
  if (!key) return;
  const model = serializeBox(box);
  if (!model.some((s) => s.t === "chip")) {
    state.boxModels.delete(key);
    return;
  }
  state.boxModels.set(key, model);
}

let chipSaveTimer = null;
function saveChipDraftsSoon() {
  if (chipSaveTimer) return;
  chipSaveTimer = setTimeout(() => {
    chipSaveTimer = null;
    saveChipDrafts();
  }, 250);
}

function saveChipDrafts() {
  if (chipSaveTimer) {
    clearTimeout(chipSaveTimer);
    chipSaveTimer = null;
  }
  const drafts = {};
  const chips = {};
  for (const [key, model] of state.boxModels) {
    if (!Array.isArray(model) || !model.some((s) => s.t === "chip")) continue;
    drafts[key] = cleanModel(model);
    for (const seg of model) {
      if (seg.t !== "chip") continue;
      const c = state.pasteChips.get(seg.id);
      if (c) chips[seg.id] = { text: c.text, lines: c.lines };
    }
  }
  try {
    const order = Object.keys(drafts);
    if (!order.length) {
      sessionStorage.removeItem(CHIP_DRAFT_KEY);
      return;
    }
    // A handful of boxes at a time, oldest dropped: a tab remembers pastes, not a history of them.
    while (order.length > CHIP_DRAFT_MAX) delete drafts[order.shift()];
    let payload = JSON.stringify({ chips, drafts });
    while (payload.length > CHIP_DRAFT_BYTES && order.length > 1) {
      delete drafts[order.shift()];
      payload = JSON.stringify({ chips, drafts });
    }
    sessionStorage.setItem(CHIP_DRAFT_KEY, payload);
  } catch {
    /* quota or a blocked store: the chip is still in the box, and the model still in memory */
  }
}

// ---- the caret ---------------------------------------------------------------------------
// A chip has a length in the serialized string (the text it swallowed) but a caret can never be inside it, so
// the caret is measured and placed in serialized units and clamped to a chip's own edge. That is what keeps
// ↑/↓ recall, the caret restore after a rebuild and Shift+Enter honest.

function nodeLength(node) {
  if (!node) return 0;
  if (node.nodeType === 3) return node.data.length;
  if (node.nodeType !== 1) return 0;
  if (node.dataset && node.dataset.pasteChip) return chipText(node.dataset.pasteChip).length;
  if (node.tagName === "BR") return 1;
  let n = 0;
  for (const child of node.childNodes) n += nodeLength(child);
  return n;
}

// How many serialized characters sit before (node, offset) inside `parent`. NOT app.js's `offsetIn`, which
// measures a card selection in visible text: this one counts a chip as the text it swallowed, which is the
// unit every caret here is placed in.
function serialOffsetIn(parent, node, offset) {
  // A caret sitting IN an element is at a CHILD boundary, not a character offset: that is the position Chrome
  // leaves right after a chip, and the one the whole caret model has to agree with.
  if (node === parent) {
    let m = 0;
    const kids = parent.childNodes;
    for (let i = 0; i < offset && i < kids.length; i += 1) m += nodeLength(kids[i]);
    return m;
  }
  let n = 0;
  for (const child of parent.childNodes) {
    if (child === node) {
      if (child.nodeType === 3) return n + Math.min(offset, child.data.length);
      const kids = child.childNodes;
      let m = 0;
      for (let i = 0; i < offset && i < kids.length; i += 1) m += nodeLength(kids[i]);
      return n + m;
    }
    if (child.nodeType === 1 && child.contains(node)) return n + serialOffsetIn(child, node, offset);
    n += nodeLength(child);
  }
  return n;
}

function caretOffset(box) {
  if (!box) return 0;
  if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") return Number(box.selectionStart) || 0;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return readBox(box).length;
  const range = sel.getRangeAt(0);
  const at = range.startContainer;
  if (!box.contains(at)) return readBox(box).length;
  return serialOffsetIn(box, at, range.startOffset);
}

function setCaretOffset(box, offset) {
  if (!box) return;
  if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
    const at = Math.max(0, Math.min(offset, String(box.value || "").length));
    try {
      box.setSelectionRange(at, at);
    } catch {
      /* nothing to place a caret in */
    }
    return;
  }
  const range = document.createRange();
  let left = Math.max(0, offset);
  let placed = false;
  const walk = (parent) => {
    for (const child of parent.childNodes) {
      if (placed) return;
      if (child.nodeType === 3) {
        if (left <= child.data.length) {
          range.setStart(child, left);
          placed = true;
          return;
        }
        left -= child.data.length;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const len = nodeLength(child);
      if (left <= 0) {
        range.setStartBefore(child);
        placed = true;
        return;
      }
      if (left >= len) {
        left -= len;
        continue;
      }
      // Strictly inside it: a chip (or a <br>) has no inside for a caret, so the caret lands on its far edge.
      if ((child.dataset && child.dataset.pasteChip) || child.tagName === "BR") {
        range.setStartAfter(child);
        placed = true;
        return;
      }
      walk(child);
      if (!placed) {
        range.setStartAfter(child);
        placed = true;
      }
      return;
    }
  };
  walk(box);
  if (!placed) {
    range.selectNodeContents(box);
    range.collapse(false);
  }
  range.collapse(true);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretAtEnd(box) {
  return caretOffset(box) >= readBox(box).length;
}

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

// ---- what a paste does --------------------------------------------------------------------
// A paste of a FILE belongs to board/attachments.js: it registers first, and its handler has already run (and
// prevented the default) by the time this one is reached.

function pasteInto(box, raw) {
  const info = pasteText(raw);
  if (pasteShouldChip(info.text)) {
    // Nothing of the paste is lost: the chip carries every character and readBox gives them back in place.
    // The model and the caret as they were BEFORE the chip are what the composer's own Ctrl+Z steps back
    // to: this write is programmatic, so the editing engine's undo stack never saw it and cannot take it.
    const beforeModel = serializeBox(box);
    const beforeCaret = caretOffset(box);
    const chip = makeChip(info.text);
    insertNodeAt(box, chip);
    touchBox(box);
    saveChipDrafts();
    recordComposerPasteChip(box, chip.dataset.pasteChip, beforeModel, beforeCaret);
    return "chip";
  }
  // Below the threshold the paste is exactly what it was before this feature: inline text.
  const text = box.dataset.single ? info.text.replace(/[\r\n]+/g, "") : info.text;
  insertTextAt(box, text);
  touchBox(box);
  return "text";
}

// ---- the composer's own undo stack --------------------------------------------------------
// WHY THIS IS HERE. A chip is written by this module, not by the editing engine: insertNodeAt puts a node
// into the box that the engine never saw, so its undo stack cannot step back over it, and Ctrl+Z after a
// paste did nothing at all. The same is true of the file chip board/attachments.js draws above the box: a
// programmatic write the engine's history has no record of. This is the record of the writes made on the
// reader's behalf - one entry per chip insert, carrying the model the composer held BEFORE it - so the
// press puts the composer back exactly as it was.
//
// WHAT IT DOES NOT DO. Ordinary typing is the engine's and stays the engine's: an entry is honoured only
// while the composer still reads exactly what its insert left (composerEntryLive), so once the reader has
// typed in that box the entry is stale, it is dropped, and Ctrl+Z falls through to the browser untouched.
// Nothing here re-writes a composer the reader has moved on from.
//
// BOUNDED, and cleared with the draft. A long session can paste a hundred times; the stack keeps the last
// COMPOSER_ACTION_MAX inserts and forgets the oldest, because an entry carries a whole draft's model and an
// unbounded one is a leak. clearBoxDraft empties it: a composer that has been sent has no history.
const COMPOSER_ACTION_MAX = 24;
let composerPast = [];
let composerFuture = [];

// A composer is named the way its box is (data-chipbox): "spawn", "reply:<thread>", "add:<key>". An
// attachment set is keyed by its context instead - the thread id, or "spawn" - so it is mapped onto the box
// name of the composer it belongs to: one name for one composer, whichever half wrote to it.
function composerKeyOf(ctx) {
  return ctx === "spawn" ? "spawn" : `reply:${ctx}`;
}

// Two states of a box, compared as the segments the box holds. Never through state.pasteChips: a chip whose
// text has already gone still compares as the chip it is.
function composerSameModel(a, b) {
  return JSON.stringify(cleanModel(a)) === JSON.stringify(cleanModel(b));
}

function composerPush(entry) {
  composerPast.push(entry);
  if (composerPast.length > COMPOSER_ACTION_MAX) composerPast.splice(0, composerPast.length - COMPOSER_ACTION_MAX);
  composerFuture = []; // a write after an undo starts a new history: the redo branch is gone
}

// The attachment set as the reader sees it, for an entry's own guard. Empty when the module that owns those
// chips is not on this page, which makes an attachment entry stale rather than wrongly live.
function composerAttachmentPaths(ctx) {
  if (typeof attachmentsFor !== "function") return [];
  return attachmentsFor(ctx).map((a) => a && a.path);
}

// Ctrl+Z for a pasted block: pasteInto calls this with the model and the caret the box held before the chip
// went in. The chip's own text is kept on the entry, because a redo has to put the chip's state back.
function recordComposerPasteChip(box, chipId, beforeModel, beforeCaret) {
  if (!box || !chipId) return;
  const c = state.pasteChips.get(chipId);
  if (!c) return;
  composerPush({
    kind: "paste-chip",
    key: boxKeyOf(box),
    box,
    chipId,
    text: c.text,
    lines: c.lines,
    beforeModel: cleanModel(beforeModel),
    beforeCaret: Number(beforeCaret) || 0,
    afterModel: serializeBox(box),
    afterCaret: caretOffset(box),
  });
}

// Ctrl+Z for a pasted or dropped file: board/attachments.js calls this once the upload has landed and the
// chip is drawn, with the set before the file joined it and the set after.
function recordComposerAttachment(ctx, before, after, attachment) {
  if (!ctx || !attachment || !attachment.path) return;
  composerPush({
    kind: "attachment",
    key: composerKeyOf(ctx),
    ctx,
    attachment,
    beforeList: (before || []).slice(),
    afterList: (after || []).slice(),
    beforePaths: (before || []).map((a) => a && a.path),
    afterPaths: (after || []).map((a) => a && a.path),
  });
}

// Has the composer moved since this entry's write? Only a composer that still reads exactly what the write
// left may be stepped back - that guard is what leaves a typed character to the engine's own undo.
function composerEntryLive(entry) {
  if (!entry) return false;
  if (entry.kind === "paste-chip") {
    if (!entry.box || !entry.box.parentNode) return false; // the card was rebuilt: that box is gone
    return composerSameModel(serializeBox(entry.box), entry.afterModel);
  }
  if (entry.kind === "attachment") {
    return JSON.stringify(composerAttachmentPaths(entry.ctx)) === JSON.stringify(entry.afterPaths);
  }
  return false;
}

// The newest entry this composer made, taken off the stack. A stale top entry is dropped and answers null,
// so the press goes to the engine rather than rewriting a draft the reader has typed into.
function composerTake(stack, key, live) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (entry.key !== key) continue;
    stack.splice(i, 1);
    return live(entry) ? entry : null;
  }
  return null;
}

function composerPutAttachments(entry, list) {
  if (typeof setAttachments !== "function" || typeof renderChips !== "function") return;
  setAttachments(entry.ctx, list.slice());
  renderChips(entry.ctx);
}

function composerUndo(box) {
  const key = boxKeyOf(box);
  if (!key) return false;
  const entry = composerTake(composerPast, key, composerEntryLive);
  if (!entry) return false;
  if (entry.kind === "paste-chip") {
    state.pasteChips.delete(entry.chipId);
    writeBoxModel(box, entry.beforeModel);
    setCaretOffset(box, entry.beforeCaret);
    touchBox(box);
  } else {
    composerPutAttachments(entry, entry.beforeList);
  }
  composerFuture.push(entry);
  if (composerFuture.length > COMPOSER_ACTION_MAX) composerFuture.splice(0, composerFuture.length - COMPOSER_ACTION_MAX);
  return true;
}

function composerRedo(box) {
  const key = boxKeyOf(box);
  if (!key) return false;
  const entry = composerTake(composerFuture, key, (e) =>
    e.kind === "paste-chip"
      ? Boolean(e.box && e.box.parentNode) && composerSameModel(serializeBox(box), e.beforeModel)
      : JSON.stringify(composerAttachmentPaths(e.ctx)) === JSON.stringify(e.beforePaths),
  );
  if (!entry) return false;
  if (entry.kind === "paste-chip") {
    state.pasteChips.set(entry.chipId, { text: entry.text, lines: entry.lines });
    writeBoxModel(box, entry.afterModel);
    setCaretOffset(box, entry.afterCaret);
    touchBox(box);
  } else {
    composerPutAttachments(entry, entry.afterList);
  }
  composerPast.push(entry);
  if (composerPast.length > COMPOSER_ACTION_MAX) composerPast.splice(0, composerPast.length - COMPOSER_ACTION_MAX);
  return true;
}

// A composer the panel cleared has no history: the draft it belonged to is gone, so nothing on the stack
// could put it back, and the entry would keep a whole pasted block alive for the life of the page.
function clearComposerActions(keyOrBox) {
  const key = typeof keyOrBox === "string" ? keyOrBox : boxKeyOf(keyOrBox);
  if (!key) return 0;
  const had = composerPast.length + composerFuture.length;
  composerPast = composerPast.filter((e) => e.key !== key);
  composerFuture = composerFuture.filter((e) => e.key !== key);
  return had - (composerPast.length + composerFuture.length);
}

// What a test and a probe read: how many actions this composer could still undo.
function composerActionDepth(keyOrBox) {
  const key = typeof keyOrBox === "string" ? keyOrBox : boxKeyOf(keyOrBox);
  if (!key) return 0;
  return composerPast.filter((e) => e.key === key).length;
}

// ---- the module's own events ---------------------------------------------------------------

document.addEventListener("paste", (e) => {
  const box = chipBoxOf(e.target);
  if (!box || e.defaultPrevented) return; // no prompt box, or an attachment already took this paste
  const cd = e.clipboardData;
  if (!cd) return;
  if ([...(cd.files || [])].length) return; // files are the attachment chip's business
  const text = cd.getData("text/plain");
  if (!text) return;
  e.preventDefault();
  pasteInto(box, text);
});

// Drag-and-drop of text is a paste in every editor, so it takes the same path. A drop of FILES is still the
// attachment chip's (its own handler has already run by the time this one sees the event).
document.addEventListener("drop", (e) => {
  const box = chipBoxOf(e.target);
  if (!box || e.defaultPrevented) return;
  const dt = e.dataTransfer;
  if (!dt || [...(dt.files || [])].length) return;
  const text = dt.getData("text/plain");
  if (!text) return;
  e.preventDefault();
  const at = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  if (at && box.contains(at.startContainer)) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(at);
  }
  pasteInto(box, text);
});

// The decorations inside a chip are not editable, so a press on one must not move the caret: a press to READ a
// pasted block is not a press to edit the prompt around it.
document.addEventListener(
  "mousedown",
  (e) => {
    const el = e.target.closest && e.target.closest(".paste-chip");
    if (el) e.preventDefault();
  },
  true,
);

document.addEventListener(
  "click",
  (e) => {
    const el = e.target.closest && e.target.closest(".paste-chip");
    if (!el) return;
    const x = e.target.closest("[data-paste-remove]");
    e.preventDefault();
    e.stopPropagation();
    if (x) removeChipEl(el, { focus: true });
    else toggleChip(el);
  },
  true,
);

document.addEventListener(
  "keydown",
  (e) => {
    const box = chipBoxOf(e.target);
    if (e.key === "Escape") {
      // Escape folds a block that is open — first the ones in the box the reader is in, otherwise the one
      // unfolded over the board. Nothing else holds that key while a pasted block is open.
      const open = openChips(box || document);
      if (open.length) {
        e.preventDefault();
        e.stopPropagation();
        for (const el of open) foldChip(el);
      }
      return;
    }
    if (!box) return;
    // Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y: the writes this module and board/attachments.js made on the reader's
    // behalf, which the engine's own undo stack never saw. A press this composer has nothing to step back
    // over is NOT taken - it falls through to the browser exactly as before, so ordinary typing keeps the
    // engine's native undo. Ctrl+Backspace and Ctrl+Delete are untouched: they are the branch after this one.
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y")) {
      const redo = e.key === "y" || e.key === "Y" || e.shiftKey;
      const took = redo ? composerRedo(box) : composerUndo(box);
      if (took) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key !== "Backspace" && e.key !== "Delete") return;
    // Alt is the one modifier this handler still stands aside for: Alt+Backspace is undo-word in the editors a
    // reader may have in their fingers, and the panel has no business taking it.
    if (e.altKey || e.metaKey) return;
    const dir = e.key === "Backspace" ? -1 : 1;
    const chip = chipBesideCaret(box, dir);
    if (chip) {
      // One press, one chip, whole: the caret never enters a chip, and a chip is never split or half-deleted.
      // With Ctrl held as much as without it, and with the chip's text going out of the panel's state too.
      e.preventDefault();
      e.stopPropagation();
      removeChipEl(chip);
      return;
    }
    // Nothing beside the caret: a plain key is the engine's, characterwise, selection and undo and all.
    if (!e.ctrlKey || e.shiftKey) return;
    const chars = chipBoxChars(box);
    const point = chipCaretPoint(box, chars);
    if (point < 0) return;
    const span = chipWordSpan(chars, point, dir);
    if (!span) return;
    e.preventDefault();
    e.stopPropagation();
    chipDeleteChars(box, chars, chipWidenSpan(chars, span));
  },
  true,
);

// What the reader has written is remembered as a model only when it carries a chip; the text of the draft
// itself keeps travelling the way it always did.
document.addEventListener("input", (e) => {
  const box = chipBoxOf(e.target);
  if (!box) return;
  // A contenteditable that has been emptied is left holding a <br> by every engine that edits one: clear it,
  // so the placeholder's :empty rule and readBox both see a genuinely empty box.
  if (!readBox(box).trim() && !box.querySelector("[data-paste-chip]")) {
    const onlyBreaks = [...box.childNodes].every((n) => n.nodeType === 1 && n.tagName === "BR");
    if (onlyBreaks && box.childNodes.length) box.replaceChildren();
  }
  rememberBoxModel(box);
  saveChipDraftsSoon();
});

window.WMApp = window.WMApp || {};
window.WMApp.board = window.WMApp.board || {};
// Published for the later steps of the split, and for the verify scripts that drive these boxes in a browser.
window.WMApp.board.pasteChips = {
  readBox,
  writeBox,
  writeBoxModel,
  serializeBox,
  restoreBoxDraft,
  restorePersistedBox,
  restoreChipBoxes,
  transferBoxModel,
  rememberBoxModel,
  clearBoxDraft,
  chipBoxOf,
  boxKeyOf,
  caretOffset,
  setCaretOffset,
  caretAtEnd,
  insertTextAt,
  insertNewlineAt,
  pasteInto,
  makeChip,
  chipEl,
  removeChipEl,
  toggleChip,
  foldChip,
  openChips,
  chipBesideCaret,
  loadPasteChipState,
  modelText,
  chipText,
  shouldChip: pasteShouldChip,
  pasteText,
  saveChipDrafts,
  composerUndo,
  composerRedo,
  composerActionDepth,
  clearComposerActions,
};
