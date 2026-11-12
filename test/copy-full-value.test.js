// A double-click on a name or a branch selects only what the cell SHOWS, and the cell shows an ellipsis: the copy
// came back as the cut string ("make-a-truncated-worktree-name-and-e…"). The chart still ellipsises - the row has
// eleven columns and the name has to lose letters - so the fix is what the clipboard GETS, not what the cell draws.
//
//   (1) a truncated worktree name copies whole, from a selection anchored inside td.name's .row-name;
//   (2) a truncated branch copies whole, from a selection anchored inside the branch cell's own link;
//   (3) a copy anywhere else - another cell of the same row - is the browser's own business: the handler writes
//       nothing and cancels nothing;
//   (4) the trigger is TRUNCATION, not the cell: a name that fits its column is left alone as well, because
//       hijacking that copy would replace the reader's own selection (half a name, a word they dragged across)
//       with something they did not select.
//
// No browser here: the module is a classic script on the page, so it is loaded for its side effect and driven with
// page-shaped stubs whose scrollWidth/clientWidth are the numbers the browser would report. The real page is proved
// in tools/verify-copy-full-name.mjs, which double-clicks and presses Ctrl+C in Chromium.
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
