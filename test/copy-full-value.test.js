// A double-click on a name or a branch selects only what the cell SHOWS, and the cell shows an ellipsis: the copy
// came back as the cut string ("make-a-truncated-worktree-name-and-e..."). The chart still ellipsises - the row has
// eleven columns and the name has to lose letters - so the fix is what the clipboard GETS, not what the cell draws.
//
//   (1) a truncated worktree name copies whole, from a selection anchored inside td.name's .row-name;
//   (2) a truncated branch copies whole, from a selection anchored inside the branch cell's own link;
//   (3) a copy anywhere else - another cell of the same row - is the browser's own business: the handler writes
//       nothing and cancels nothing;
//   (4) the trigger for the COPY EVENT is TRUNCATION, not the cell: a name that fits its column is left alone as
//       well, because hijacking that copy would replace the reader's own selection with something they did not
//       select.
//
// PR 712 answered the copy event only. A HIGHLIGHT is a copy by itself now, and its cases are the second half:
//
//   (5) a highlight inside a name or branch cell answers its whole value - truncated or not, because a highlight is
//       a request for the value and half a name hands over the whole name;
//   (6) a caret is not a highlight, another cell is not ours, and a drag across two cells is two values;
//   (7) the write goes through navigator.clipboard.writeText, falls back to the hidden textarea when the API
//       refuses, puts the reader's highlight back afterwards, and says "copied" either way;
//   (8) the same highlight answered twice writes the clipboard once;
//   (9) the listeners are registered on the document and nothing is cancelled: no stopPropagation anywhere in the
//       module, so the row's expand, its double-click and its drag are the page's own.
//
// No browser here: the module is a classic script on the page, so it is loaded for its side effect and driven with
// page-shaped stubs whose scrollWidth/clientWidth are the numbers the browser would report. The real page is proved
// in tools/verify-copy-full-name.mjs, which drags a highlight and reads navigator.clipboard.readText() in Chromium.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// The base build has no module at all, so the import is the first thing that is red. It is caught rather than left
// to fail the file, so each case reports its own missing module instead of the run reporting an unloadable file.
let copyFull = null;
try {
  await import("../public/core/copy-full-value.js");
  copyFull = globalThis.wtCopyFull || null;
} catch {
  copyFull = null;
}
const engine = () => {
  assert.ok(copyFull, "public/core/copy-full-value.js must exist and publish globalThis.wtCopyFull");
  return copyFull;
};

// ---- page-shaped stubs ------------------------------------------------------------------------------
// One selector matcher for the two shapes the module uses ("td.name, td.branch" and ".row-name"): a tag, then
// classes. A stub matches, walks to its parent, and hands back a child the same way the DOM would.
const parse = (sel) =>
  String(sel)
    .split(",")
    .map((part) => {
      const m = /^([a-z0-9]+)?((?:\.[\w-]+)*)$/i.exec(part.trim());
      return { tag: m[1] || "", classes: (m[2].match(/[\w-]+/g) || []) };
    });
const matches = (el, sel) => parse(sel).some((p) => (!p.tag || el.tag === p.tag) && p.classes.every((c) => el.classes.includes(c)));

function el({ tag = "span", classes = [], attrs = {}, scrollWidth = 0, clientWidth = 0, parent = null, children = [] }) {
  const self = {
    nodeType: 1,
    tag,
    classes,
    attrs,
    scrollWidth,
    clientWidth,
    parentElement: parent,
    children,
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
    classList: { contains: (c) => classes.includes(c) },
    closest(sel) {
      let node = self;
      while (node) {
        if (matches(node, sel)) return node;
        node = node.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      return children.find((c) => matches(c, sel)) || null;
    },
  };
  return self;
}
const textNode = (parent) => ({ nodeType: 3, parentElement: parent });

const NAME = "make-a-truncated-worktree-name-and-e5d056";
const BRANCH = "wtgui/make-a-truncated-worktree-name-and-e5d056";

// A row's two cells, each clipped to a fraction of the text it carries: the numbers are what makes them truncated.
function row({ nameWidth = 90, branchWidth = 120 } = {}) {
  const tr = el({ tag: "tr", classes: ["row"] });
  const nameCell = el({ tag: "td", classes: ["name"], attrs: { "data-copy-value": NAME }, parent: tr, scrollWidth: 260, clientWidth: nameWidth });
  const rowName = el({ tag: "span", classes: ["row-name"], attrs: { title: `.worktrees/${NAME}` }, parent: nameCell, scrollWidth: 260, clientWidth: nameWidth });
  nameCell.children.push(rowName);
  const nameText = textNode(rowName);
  const branchCell = el({ tag: "td", classes: ["mono", "branch"], attrs: { "data-copy-value": BRANCH }, parent: tr, scrollWidth: 300, clientWidth: branchWidth });
  const link = el({ tag: "a", classes: ["branch-link"], parent: branchCell });
  branchCell.children.push(link);
  const branchText = textNode(link);
  const tipCell = el({ tag: "td", classes: ["mono", "nowrap"], parent: tr });
  const tipText = textNode(tipCell);
  return { tr, nameCell, rowName, nameText, branchCell, link, branchText, tipCell, tipText };
}

// A copy event as the page delivers it: the clipboard the handler writes into, and whether it was cancelled.
function copyEvent() {
  const said = {};
  return {
    said,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    clipboardData: {
      setData(type, value) {
        said[type] = value;
      },
    },
  };
}
const selection = (anchor, focus = anchor) => ({ anchorNode: anchor, focusNode: focus, rangeCount: 1 });
function withSelection(sel, fn) {
  const real = globalThis.getSelection;
  globalThis.getSelection = () => sel;
  try {
    return fn();
  } finally {
    if (real === undefined) delete globalThis.getSelection;
    else globalThis.getSelection = real;
  }
}

// ---- (0) the cells carry the whole value ------------------------------------------------------------
test("the row's name and branch cells carry the whole value, not only the text they draw", () => {
  engine();
  const projects = readFileSync(new URL("../public/render-projects.js", import.meta.url), "utf8");
  const source = readFileSync(new URL("../public/core/copy-full-value.js", import.meta.url), "utf8");
  const cellName = /name:\s*`<td class="name"[^`]*`/.exec(projects);
  const cellBranch = /branch:\s*`<td class="mono branch"[^`]*`/.exec(projects);
  assert.ok(cellName, "the row still draws a td.name");
  assert.ok(cellBranch, "the row still draws a td.branch");
  const attr = copyFull.VALUE_ATTR;
  assert.ok(attr && attr.startsWith("data-"), "the module names the attribute it reads");
  assert.match(cellName[0], new RegExp(`${attr}=`), `td.name carries ${attr}`);
  assert.match(cellBranch[0], new RegExp(`${attr}=`), `td.branch carries ${attr}`);
  // `data-copy` is the console's block-lift attribute (public/board/console.js): a cell wearing it grows a ⧉ button
  // on hover and changes the row's layout. The cells must not reuse it.
  assert.doesNotMatch(cellName[0], /\sdata-copy[\s=>]/, "td.name does not wear the console's data-copy");
  assert.doesNotMatch(cellBranch[0], /\sdata-copy[\s=>]/, "td.branch does not wear the console's data-copy");
  assert.match(source, /document\.addEventListener\("copy"/, "the handler is registered on the document");
});

// ---- (1) the worktree name -------------------------------------------------------------------------
test("a truncated worktree name copies whole", () => {
  const { onCopy } = engine();
  const cells = row();
  const e = copyEvent();
  withSelection(selection(cells.nameText), () => onCopy(e));
  assert.equal(e.said["text/plain"], NAME);
  assert.equal(e.defaultPrevented, true, "the browser's own cut-string copy is replaced, not appended to");
});

// ---- (2) the branch ---------------------------------------------------------------------------------
test("a truncated branch copies whole", () => {
  const { onCopy } = engine();
  const cells = row();
  const e = copyEvent();
  withSelection(selection(cells.branchText), () => onCopy(e));
  assert.equal(e.said["text/plain"], BRANCH);
  assert.equal(e.defaultPrevented, true);
});

// The caret alone (an empty selection inside the cell, then Ctrl+C) is the same cell and the same rule.
test("a caret sitting in a truncated name copies whole too", () => {
  const { onCopy } = engine();
  const cells = row();
  const e = copyEvent();
  withSelection({ anchorNode: cells.nameText, focusNode: cells.nameText, rangeCount: 1 }, () => onCopy(e));
  assert.equal(e.said["text/plain"], NAME);
});

// ---- (3) everywhere else ---------------------------------------------------------------------------
test("a copy outside the name and branch cells is the browser's own, untouched", () => {
  const { onCopy } = engine();
  const cells = row();
  const e = copyEvent();
  withSelection(selection(cells.tipText), () => onCopy(e));
  assert.deepEqual(e.said, {}, "the handler writes no clipboard data");
  assert.equal(e.defaultPrevented, false, "the handler cancels nothing");
});

// ---- (4) the trigger is truncation ------------------------------------------------------------------
test("a name that fits its column is left to the browser", () => {
  const { onCopy } = engine();
  const cells = row({ nameWidth: 260 });
  const e = copyEvent();
  withSelection(selection(cells.nameText), () => onCopy(e));
  assert.deepEqual(e.said, {});
  assert.equal(e.defaultPrevented, false);
});

// ---- (5) a HIGHLIGHT is a copy of the whole value, truncated or not ---------------------------------
// The copy event above keeps 712's truncation gate. The highlight does not: it IS the gesture that asks for the
// value, so a name that fits its column and a name that does not both answer the same whole value.
const highlight = (anchor, focus = anchor) => ({ anchorNode: anchor, focusNode: focus, rangeCount: 1, isCollapsed: false });
const caret = (node) => ({ anchorNode: node, focusNode: node, rangeCount: 1, isCollapsed: true });

test("a highlight inside a name cell answers the whole name, even when the column fits it", () => {
  const { highlightValueFor } = engine();
  const cells = row({ nameWidth: 260 });
  assert.equal(highlightValueFor(highlight(cells.nameText)), NAME);
});

test("a highlight inside the branch cell answers the whole branch", () => {
  const { highlightValueFor } = engine();
  const cells = row();
  assert.equal(highlightValueFor(highlight(cells.branchText)), BRANCH);
});

// The value comes from the model the row was drawn from, never from the ellipsised text: the drawn text is the cut
// string, and copying that is exactly the bug.
test("a truncated row still answers its whole value, not the text it paints", () => {
  const { highlightValueFor } = engine();
  const cells = row();
  cells.rowName.textContent = "make-a-truncated-worktree-name-and-e\u2026";
  assert.equal(highlightValueFor(highlight(cells.nameText)), NAME);
  assert.notEqual(highlightValueFor(highlight(cells.nameText)), cells.rowName.textContent);
});

test("a caret is not a highlight, and a highlight outside the two cells is not ours", () => {
  const { highlightValueFor } = engine();
  const cells = row();
  assert.equal(highlightValueFor(caret(cells.nameText)), null, "a caret is not a highlight");
  assert.equal(highlightValueFor(highlight(cells.tipText)), null, "another cell is the browser's");
  assert.equal(highlightValueFor(highlight(cells.nameText, cells.branchText)), null, "a drag across two cells is two values");
  assert.equal(highlightValueFor(null), null);
});

// ---- (6) the write, and the flash that says it happened ---------------------------------------------
// The module reads the selection and the clipboard through globals, so the write cases put page-shaped values there
// and take them away again. This file defines no `document` at load, which is why the module's listener block stays
// off and every case drives the exported function directly.
function flashDocument() {
  const body = {
    children: [],
    appendChild(node) {
      node.parentNode = this;
      this.children.push(node);
    },
  };
  const doc = {
    body,
    created: [],
    commanded: [],
    addEventListener() {},
    createElement(tag) {
      const el = {
        tag,
        style: {},
        attrs: {},
        value: "",
        parentNode: null,
        setAttribute(name, value) {
          this.attrs[name] = value;
        },
        focus() {
          this.focused = true;
        },
        select() {
          this.selected = true;
        },
        remove() {
          if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((n) => n !== this);
          this.parentNode = null;
        },
      };
      doc.created.push(el);
      return el;
    },
    querySelectorAll() {
      return [];
    },
    execCommand(cmd) {
      this.commanded.push(cmd);
      return true;
    },
  };
  return doc;
}
// A selection rich enough for the fallback: it can be saved (cloneRange), cleared and put back. A highlight inside
// one text node has the same anchor and focus NODE and two offsets, so the collapsed flag is explicit, not inferred
// from the two nodes being equal.
const richSelection = (anchor, focus = anchor) => ({
  anchorNode: anchor,
  focusNode: focus,
  rangeCount: 1,
  isCollapsed: false,
  getRangeAt() {
    return { cloneRange: () => ({ marker: "range" }) };
  },
  removeAllRanges() {
    this.cleared = (this.cleared || 0) + 1;
  },
  addRange(range) {
    this.restored = (this.restored || []).concat([range]);
  },
  toString() {
    return "chunk";
  },
});
async function withGlobals({ navigator: nav, document: doc, selection: sel }, fn) {
  const keys = ["navigator", "document", "getSelection"];
  const saved = {};
  for (const key of keys) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  const put = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  if (nav) put("navigator", nav);
  if (doc) put("document", doc);
  if (sel) put("getSelection", () => sel);
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
}

test("a highlight writes the whole value through navigator.clipboard and flashes copied", async () => {
  const { onSelectEnd } = engine();
  const cells = row();
  const doc = flashDocument();
  const said = [];
  const nav = { clipboard: { writeText: (v) => (said.push(v), Promise.resolve()) } };
  const sel = richSelection(cells.nameText);
  await withGlobals({ navigator: nav, document: doc, selection: sel }, async () => {
    assert.equal(await onSelectEnd(), true, "the write is reported as having landed");
  });
  assert.deepEqual(said, [NAME], "the clipboard API took the whole name");
  const chip = doc.created.find((el) => el.className === "copy-flash");
  assert.ok(chip, "a copied chip was drawn");
  assert.equal(chip.textContent, "copied");
  assert.equal(chip.attrs.role, "status");
  assert.equal(chip.parentNode, doc.body, "the chip sits on the body, not inside a row that a repaint replaces");
});

test("a refused clipboard write falls back to the hidden textarea and puts the highlight back", async () => {
  const { onSelectEnd } = engine();
  const cells = row();
  const doc = flashDocument();
  const nav = { clipboard: { writeText: () => Promise.reject(new Error("NotAllowedError")) } };
  const sel = richSelection(cells.branchText);
  await withGlobals({ navigator: nav, document: doc, selection: sel }, async () => {
    assert.equal(await onSelectEnd(), true, "the fallback copy is reported as having landed");
  });
  const ta = doc.created.find((el) => el.tag === "textarea");
  assert.ok(ta, "the fallback used a textarea");
  assert.equal(ta.value, BRANCH, "the textarea carried the whole branch");
  assert.deepEqual(doc.commanded, ["copy"], "the browser's own copy command wrote it");
  assert.equal(sel.cleared, 1, "the textarea's selection was cleared after the copy");
  assert.equal(sel.restored.length, 1, "the reader's highlight was put back exactly once");
  const chip = doc.created.find((el) => el.className === "copy-flash");
  assert.ok(chip, "the fallback still says copied");
});

test("the same highlight answered twice writes the clipboard once", async () => {
  const { onSelectEnd } = engine();
  const cells = row();
  const doc = flashDocument();
  const said = [];
  const nav = { clipboard: { writeText: (v) => (said.push(v), Promise.resolve()) } };
  const sel = richSelection(cells.nameText);
  await withGlobals({ navigator: nav, document: doc, selection: sel }, async () => {
    assert.equal(await onSelectEnd(), true);
    assert.equal(await onSelectEnd(), false, "the settle check did not answer it twice");
  });
  assert.equal(said.length, 1);
});

// ---- (7) the listeners, and the gestures they leave alone -------------------------------------------
test("the highlight listeners are on the document and nothing is cancelled", () => {
  engine();
  const source = readFileSync(new URL("../public/core/copy-full-value.js", import.meta.url), "utf8");
  assert.match(source, /document\.addEventListener\("mousedown", onPointerDown, true\)/);
  assert.match(source, /document\.addEventListener\("mouseup", onPointerUp, true\)/);
  assert.match(source, /document\.addEventListener\("selectionchange", scheduleSettleCheck\)/);
  assert.doesNotMatch(source, /\.stopPropagation\(/, "no gesture is swallowed: the row's expand and drag are the page's");
});
