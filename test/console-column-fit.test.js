// Measuring the worktree table's columns must not lay out the table the consoles live in, and a scroll write that moved
// nothing must not claim the reader's next scroll.
//
// The seam-free half of `tools/verify-console-column-fit.mjs` (there is no layout engine in `npm test`): it reads the
// shipped functions out of `public/app.js` and drives them over a small DOM model.
//
// 1. naturalColumnWidths() used to set `table-layout: auto; width: max-content` on the LIVE table for one synchronous
//    layout. The table's detail rows hold the agent cards, and a `pre-wrap` transcript at max-content has no line
//    breaks, so every console in the table was a fraction of its height for that layout; the browser clamped its scroll
//    offset, the styles went back, and the offset did not. Measured with the browser gate on 0.46.8: one fitColumns()
//    took a console from its newest line 716/716 to 147/716, and 18 of 18 measurements in a 30 s window moved one by
//    604-1139 px. The rule now: the measurement is taken on a copy of the header and the worktree rows, the live table
//    is never restyled, and a spanning row (the detail, the delete confirmation) is not a column's content.
// 2. setScroll() used to add the box to `selfScrolled` on every write. A write to the value the box already holds sends
//    no scroll event, so the flag waited for the next event - the reader's own scroll - and spent it: the place they
//    scrolled to was never recorded (docs/console-bounce-manual-7391.md; the gate's first wheel left `record null`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `public/app.js still carries ${name}()`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is still a top-level function`);
  return src.slice(start, end + 3);
}

// ---- a DOM model: elements, inline styles that log their writes, and a table layout that knows colspan ------------
const styleWrites = [];
function makeStyle(owner) {
  const values = {};
  return new Proxy(values, {
    set(target, prop, value) {
      styleWrites.push({ owner, prop: String(prop), value: String(value) });
      target[prop] = String(value);
      return true;
    },
  });
}

let layouts = 0;
class El {
  constructor(tag, { cls = [], text = "", colSpan = 1 } = {}) {
    this.tagName = tag.toUpperCase();
    this.classes = new Set(cls);
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.text = text;
    this.colSpan = colSpan;
    this.style = makeStyle(this);
    this.live = false; // set on the reader's own nodes, so a write to one is countable
  }
  get classList() {
    return { contains: (c) => this.classes.has(c), add: (c) => this.classes.add(c) };
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === doc.documentElement;
  }
  appendChild(c) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(c);
    else this.children.splice(at, 0, c);
    return c;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
    this.parentNode = null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.children;
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  cloneNode(deep) {
    const c = new El(this.tagName, { cls: [...this.classes], text: this.text, colSpan: this.colSpan });
    c.attrs = { ...this.attrs };
    for (const [k, v] of Object.entries(this.style)) c.style[k] = v; // an inline style attribute is copied
    if (deep) for (const ch of this.children) c.appendChild(ch.cloneNode(true));
    return c;
  }
  get tHead() {
    return this.children.find((c) => c.tagName === "THEAD") || null;
  }
  get tBodies() {
    return this.children.filter((c) => c.tagName === "TBODY");
  }
  get rows() {
    return this.children.filter((c) => c.tagName === "TR");
  }
  get cells() {
    return this.children.filter((c) => c.tagName === "TH" || c.tagName === "TD");
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  // Class selectors only (".a, .b"), which is all the signature asks.
  querySelectorAll(sel) {
    const want = sel.split(",").map((s) => s.trim().replace(/^\./, ""));
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (want.some((w) => c.classes.has(w))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  // The one layout rule this needs: a header cell is as wide as the widest cell of its column (8 px a character),
  // and a cell spanning every column shares its width out over them - the way an auto table layout distributes a
  // colspan cell. It also counts layouts on the reader's own table, which is the thing that clamps a console.
  getBoundingClientRect() {
    let table = this;
    while (table && table.tagName !== "TABLE") table = table.parentNode;
    if (!table || !table.isConnected) return { width: 0, height: 0, top: 0, left: 0 };
    if (table.live) layouts += 1;
    const head = table.tHead.rows[0].cells;
    const i = head.indexOf(this);
    let w = head[i].text.length * 8;
    for (const tb of table.tBodies) {
      for (const tr of tb.rows) {
        const cells = tr.cells;
        if (cells.length === head.length) w = Math.max(w, cells[i].text.length * 8);
        else if (cells.length === 1 && cells[0].colSpan >= head.length) w = Math.max(w, (cells[0].text.length * 8) / head.length);
      }
    }
    return { width: w, height: 18, top: 0, left: 0 };
  }
}
const doc = { documentElement: new El("html"), createElement: (tag) => new El(tag) };

// The board as the reader has it: a project's table, one worktree row, its open detail holding a long transcript, and
// a second row with its delete confirmation open.
function board({ transcript = 4000 } = {}) {
  const wrap = new El("div", { cls: ["wt-scroll"] });
  doc.documentElement.children = [];
  doc.documentElement.appendChild(wrap);
  const table = new El("table");
  wrap.appendChild(table);
  const thead = table.appendChild(new El("thead"));
  const hr = thead.appendChild(new El("tr"));
  const names = ["worktree", "branch", "life"];
  for (const n of names) hr.appendChild(new El("th", { text: n }));
  const tbody = table.appendChild(new El("tbody"));
  const row = (cells) => {
    const tr = tbody.appendChild(new El("tr", { cls: ["row"] }));
    for (const t of cells) tr.appendChild(new El("td", { text: t }));
    return tr;
  };
  row(["i-m-constently-trying-an", "wtgui/i-m-constently", "4s"]);
  const detail = tbody.appendChild(new El("tr", { cls: ["detail"] }));
  detail.appendChild(new El("td", { text: "x".repeat(transcript), colSpan: names.length }));
  row(["build-and-run-a-console", "wtgui/build-and-run", "2m"]);
  const confirm = tbody.appendChild(new El("tr", { cls: ["row-confirm"] }));
  confirm.appendChild(new El("td", { text: "Delete this worktree? Cancel Delete", colSpan: names.length }));
  // Everything above is the reader's own page.
  const mark = (el) => {
    el.live = true;
    el.children.forEach(mark);
  };
  mark(wrap);
  for (const th of hr.cells) th.style.width = "120px"; // the split the last fit applied
  styleWrites.length = 0;
  layouts = 0;
  return { wrap, table, hr, detail };
}

const context = { document: doc, Math, Number, WeakSet, Set };
vm.createContext(context);
vm.runInContext([grab("headerCells"), grab("naturalColumnWidths"), grab("columnSignature")].join("\n"), context);

test("measuring the columns never restyles or lays out the table the consoles live in", () => {
  const { table } = board();
  const natural = context.naturalColumnWidths(table);
  assert.equal(natural.length, 3, "one width per header cell");
  const onLive = styleWrites.filter((w) => w.owner.live);
  assert.deepEqual(
    onLive.map((w) => `${w.owner.tagName}.${w.prop}=${w.value}`),
    [],
    "no inline style of the live table, its headers or its rows was written - a restyle is what re-laid the transcripts out",
  );
  assert.equal(layouts, 0, "and no layout was taken against the live table, which is where a console's offset is clamped");
  assert.deepEqual(
    table.parentNode.children.map((c) => c.tagName),
    ["TABLE"],
    "the copy it measured is gone again before the call returns",
  );
});

test("a spanning row is not a column's content: an open transcript does not move the split", () => {
  const short = context.naturalColumnWidths(board({ transcript: 10 }).table);
  const long = context.naturalColumnWidths(board({ transcript: 20000 }).table);
  assert.deepEqual(long, short, "the same natural widths whether the open card holds 10 characters or 20,000");
  assert.deepEqual([...short], [24 * 8, 20 * 8, 4 * 8], "each column is its widest worktree-row cell or its header");
});

test("the copy measures the header and the worktree rows, with the table's own style and the same wrapper", () => {
  const { table, wrap } = board();
  table.style.minWidth = "846px"; // sideways-scroll mode writes this; the measurement keeps it
  styleWrites.length = 0;
  let seen = null;
  const orig = El.prototype.getBoundingClientRect;
  El.prototype.getBoundingClientRect = function () {
    let t = this;
    while (t && t.tagName !== "TABLE") t = t.parentNode;
    if (t && !seen) {
      seen = {
        parent: t.parentNode,
        rows: t.tBodies.flatMap((tb) => tb.rows.map((r) => [...r.classes].join("."))),
        layout: t.style.tableLayout,
        width: t.style.width,
        minWidth: t.style.minWidth,
        headWidths: t.tHead.rows[0].cells.map((th) => th.style.width),
      };
    }
    return orig.call(this);
  };
  try {
    context.naturalColumnWidths(table);
  } finally {
    El.prototype.getBoundingClientRect = orig;
  }
  assert.equal(seen.parent, wrap, "measured inside the table's own wrapper, so every selector that sizes a cell applies");
  assert.deepEqual(seen.rows, ["row", "row"], "only the worktree rows - no detail, no confirmation");
  assert.equal(seen.layout, "auto");
  assert.equal(seen.width, "max-content");
  assert.equal(seen.minWidth, "846px", "the table's own inline min-width came with it");
  assert.deepEqual(seen.headWidths, ["", "", ""], "and no applied split constrains what it measures");
  assert.equal(table.style.tableLayout, undefined, "while the live table kept its fixed layout");
  assert.deepEqual([...table.tHead.rows[0].cells].map((th) => th.style.width), ["120px", "120px", "120px"], "and its split");
});

// ---- the memo that decides whether a repaint measures at all ------------------------------------------------------
// fitColumns() measures only when columnSignature() changed. It is read over the same set the copy measures - the
// worktree rows - so a line an agent writes into an open card (a spanning detail row) is not a reason to measure.
test("an agent writing into an open card does not ask for a measurement", () => {
  const { table, detail } = board({ transcript: 4000 });
  const tbody = table.tBodies[0];
  const before = context.columnSignature(tbody);
  detail.cells[0].text += "\nanother paragraph the agent wrote ".repeat(40);
  assert.equal(context.columnSignature(tbody), before, "the console grew and the signature did not move");
  tbody.children = tbody.children.filter((tr) => !tr.classes.has("detail"));
  assert.equal(context.columnSignature(tbody), before, "and closing the card is not a column change either");
});

test("a worktree row that changed still asks for one (control)", () => {
  const { table } = board();
  const tbody = table.tBodies[0];
  const before = context.columnSignature(tbody);
  const first = tbody.rows.find((tr) => tr.classes.has("row"));
  first.cells[2].text = "12m"; // the life column grew a character
  const grown = context.columnSignature(tbody);
  assert.notEqual(grown, before, "a cell's text changed, so the split may have");
  const chip = new El("span", { cls: ["chip"], text: "PR" });
  first.cells[0].appendChild(chip);
  assert.notEqual(context.columnSignature(tbody), grown, "a chip appeared in the worktree column");
  const withChip = context.columnSignature(tbody);
  const tr = tbody.appendChild(new El("tr", { cls: ["row"] }));
  for (const t of ["a-new-tree", "wtgui/a-new-tree", "1s"]) tr.appendChild(new El("td", { text: t }));
  assert.notEqual(context.columnSignature(tbody), withChip, "and a new worktree row is counted");
});

// ---- setScroll and the flag it leaves for the scroll handler -------------------------------------------------------
class Box {
  constructor({ content = 1000, view = 240, top = 0 } = {}) {
    this.dataset = { out: "turn-1" };
    this.content = content;
    this.clientHeight = view;
    this.top = top;
  }
  get scrollHeight() {
    return this.content;
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(v) {
    this.top = Math.max(0, Math.min(Number(v) || 0, this.scrollHeight - this.clientHeight));
  }
}
const scroll = { WeakSet, Math, Number };
vm.createContext(scroll);
vm.runInContext(`const selfScrolled = new WeakSet();\n${grab("setScroll")}\nthis.selfScrolled = selfScrolled;`, scroll);

test("a scroll write that moved nothing leaves no claim on the reader's next scroll", () => {
  const atEnd = new Box({ content: 1000, view: 240, top: 760 });
  scroll.setScroll(atEnd, atEnd.scrollHeight); // the follow path, on a console already on its newest line
  assert.equal(atEnd.top, 760, "the box did not move");
  assert.equal(scroll.selfScrolled.has(atEnd), false, "so no scroll event is coming, and none may be claimed for the panel");

  const restored = new Box({ content: 1000, view: 240, top: 300 });
  scroll.setScroll(restored, 300); // a restore that lands on the line the box is already on
  assert.equal(scroll.selfScrolled.has(restored), false, "a restore onto the same line claims nothing either");
});

test("a scroll write that moved the box claims exactly the event it causes", () => {
  const box = new Box({ content: 1000, view: 240, top: 0 });
  scroll.setScroll(box, box.scrollHeight);
  assert.equal(box.top, 760, "the box went to its newest line");
  assert.equal(scroll.selfScrolled.has(box), true, "and its own scroll event is the panel's, not the reader's");
  assert.equal(box._selfTop, 1000, "the asked value is still what justPlaced() compares against");
});

test("the scroll handler still spends the flag on the event, and records everything else", () => {
  // The listener is mounted on `document`, not on a function this file can drive, so its two lines are asserted from
  // the shipped source: the flag is consumed by the event it stands for, and an unclaimed event writes the record.
  assert.ok(src.includes("if (selfScrolled.has(pre) || justPlaced(pre)) {\n      selfScrolled.delete(pre);\n      return;\n    }"));
  assert.ok(src.includes("state.outScrolls[pre.dataset.out] = { top: pre.scrollTop, atBottom };"));
});
