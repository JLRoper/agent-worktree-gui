// Two consoles written at once are independent: nothing about a THIRD thing on the board may put either one back at its
// first line, not for one painted frame.
//
// What went wrong. Appending a node that is already in the page is a remove-then-insert, and a scroll box inside a
// removed subtree comes back at scrollTop 0. reorderProjects() re-appended every section of a folder to move one, so
// every open console on the board went to its first line in the same frame - the reader saw two consoles that were
// being written to jump to the top together and come back together, and read it as something switching between them.
// A single console did it as often as each of two (the cause never looked at the consoles); the second one only made it
// visible. The browser half is tools/verify-console-independence.mjs (five layouts, a real Chromium, every frame
// sampled). This file is the part that must never need a browser to fail.
//
// The helpers under test are READ OUT of public/app.js between their markers, not copied here (the way
// tool-group-key.test.js reads the group key): the DOM they act on is a model with the ONE browser rule they exist for,
// so a change to the page's own rule changes these answers.
//
//   1. the model has the browser's rule - a node inserted while attached leaves the layout tree and every scroll box in
//      it comes back at 0 - and a box that was never inserted keeps its place (so nothing below is vacuous);
//   2. placeInOrder takes out of the page only what is out of place: a list already in order detaches nothing, one
//      misplaced element detaches itself alone, two that trade places detach ONE, and any permutation ends in exactly the
//      wanted order with each element moved at most once;
//   3. holdScrolls/releaseScrolls hand a moved box its place back in the same task: pinned on its newest line, a box the
//      reader took over on the line they left it on, for all three kinds of box a card has; without the release the same
//      move leaves the box at 0 (the control: that is the frame a reader saw);
//   4. every function that re-orders a list holding consoles goes through them: reorderProjects, reorder,
//      sweepStaleBoard and reorderAgentCards hold the boxes, release them, and put nothing down with a raw append.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const begin = src.indexOf("// ---- moving nodes without losing what is scrolled inside them");
const end = src.indexOf("// ---- end moving nodes without losing what is scrolled inside them");
assert.ok(begin >= 0 && end > begin, "public/app.js carries the moving-nodes markers this test reads");
const code = src.slice(src.indexOf("\n", begin) + 1, end);

// ---- a just-enough DOM, with the one rule that matters ---------------------------------------------------------
const matches = (el, simple) => {
  const m = /^([a-z]*)((?:\.[\w-]+)*)$/.exec(simple.trim());
  if (!m) throw new Error(`selector this model does not read: ${simple}`);
  return (!m[1] || el.tag === m[1]) && m[2].split(".").filter(Boolean).every((c) => el.classes.has(c));
};
// A subtree that leaves the page is a subtree that leaves layout: every scroll box in it forgets where it was.
const leaveLayout = (el) => {
  if (el.box) {
    el.scrollTop = 0;
    el.resets += 1;
  }
  for (const k of el.children) leaveLayout(k);
};

class El {
  constructor(tag, { cls = "", data = {}, box = null } = {}) {
    this.tag = tag;
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.dataset = { ...data };
    this.children = [];
    this.parentNode = null;
    this.isRoot = false;
    this.box = box; // { scrollHeight, clientHeight } when this element is a scroll box
    this.scrollTop = 0;
    this.resets = 0; // how many times the browser put this box back at 0
    this.inserts = 0; // insertBefore calls this node received as the parent
  }
  get classList() {
    return { contains: (c) => this.classes.has(c) };
  }
  get scrollHeight() {
    return this.box ? this.box.scrollHeight : 0;
  }
  get clientHeight() {
    return this.box ? this.box.clientHeight : 0;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.isRoot;
  }
  get nextElementSibling() {
    const sibs = this.parentNode ? this.parentNode.children : [];
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  insertBefore(el, ref) {
    if (ref && ref.parentNode !== this) throw new Error("the reference node is not a child of this node");
    this.inserts += 1;
    if (el.parentNode) {
      // The remove half of remove-then-insert. This is the whole bug.
      el.parentNode.children.splice(el.parentNode.children.indexOf(el), 1);
      el.parentNode = null;
      leaveLayout(el);
    }
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(at, 0, el);
    el.parentNode = this;
    return el;
  }
  appendChild(el) {
    return this.insertBefore(el, null);
  }
  closest(sel) {
    for (let n = this; n; n = n.parentNode) if (matches(n, sel)) return n;
    return null;
  }
  querySelectorAll(sel) {
    const parts = sel.split(",");
    const hit = [];
    const walk = (n) => {
      for (const k of n.children) {
        if (parts.some((p) => matches(k, p))) hit.push(k);
        walk(k);
      }
    };
    walk(this);
    return hit;
  }
}
// Build-time attach: not a move, no browser rule applies.
const add = (parent, ...kids) => {
  for (const k of kids) {
    k.parentNode = parent;
    parent.children.push(k);
  }
  return parent;
};

const OVERFLOW = { scrollHeight: 1000, clientHeight: 230 }; // 770 px of scroll
const MAX = 770;
const consoleBox = (id) => new El("pre", { cls: "job-out", data: { out: id }, box: { ...OVERFLOW } });
const sectionOf = (id) => add(new El("section", { cls: "project", data: { project: id } }), consoleBox(id));
// A board: a body of sections, each with a console parked on its newest line (what a streaming console looks like).
const board = (ids) => {
  const root = new El("tbody");
  root.isRoot = true;
  const sections = ids.map(sectionOf);
  add(root, ...sections);
  const consoles = sections.map((s) => s.children[0]);
  for (const c of consoles) c.scrollTop = MAX;
  return { root, sections, consoles };
};
const order = (root) => root.children.map((s) => s.dataset.project ?? s.tag);

// The page's own answers, stood in for: who is pinned, and the clamp the browser applies to every scrollTop write.
const state = { thinkPinned: new Map(), subConsolePinned: new Map(), outPinned: {} };
const consolePinned = (id) => state.outPinned[id] !== false;
const setScroll = (el, top) => {
  if (el) el.scrollTop = Math.min(Math.max(0, Math.round(Number(top) || 0)), Math.max(0, el.scrollHeight - el.clientHeight));
};
const { placeInOrder, holdScrolls, releaseScrolls } = new Function(
  "state",
  "consolePinned",
  "setScroll",
  `${code}\nreturn { placeInOrder, holdScrolls, releaseScrolls };`,
)(state, consolePinned, setScroll);
const reset = () => {
  state.thinkPinned.clear();
  state.subConsolePinned.clear();
  state.outPinned = {};
};

// ---- 1. the model ---------------------------------------------------------------------------------------------
test("the model has the browser's rule: inserting an attached node resets its boxes, and only its boxes", () => {
  reset();
  const b = board(["a", "b"]);
  b.root.appendChild(b.sections[0]); // a goes to the end: remove-then-insert
  assert.deepEqual(order(b.root), ["b", "a"]);
  assert.equal(b.consoles[0].scrollTop, 0, "the box inside the re-appended section is back at its first line");
  assert.equal(b.consoles[0].resets, 1);
  assert.equal(b.consoles[1].scrollTop, MAX, "the box in the section that was not touched keeps its place");
  assert.equal(b.consoles[1].resets, 0);
});

// ---- 2. placeInOrder ------------------------------------------------------------------------------------------
test("a list already in order is not touched: nothing leaves the page", () => {
  reset();
  const b = board(["a", "b", "c"]);
  assert.equal(placeInOrder(b.root, [...b.sections]), 0);
  assert.equal(b.root.inserts, 0, "no insertBefore at all");
  for (const c of b.consoles) assert.deepEqual([c.scrollTop, c.resets], [MAX, 0]);
});

test("one element out of place moves alone: the sections around it keep their consoles", () => {
  reset();
  const b = board(["a", "b", "c", "d"]);
  const [a, bb, c, d] = b.sections;
  assert.equal(placeInOrder(b.root, [a, c, bb, d]), 1);
  assert.deepEqual(order(b.root), ["a", "c", "b", "d"]);
  assert.deepEqual(
    b.consoles.map((x) => x.resets),
    [0, 1, 0, 0],
    "only the section that moved lost its box; the old loop re-appended all four",
  );
});

test("two items that trade places detach ONE of them, not both - the leapfrog of two live consoles", () => {
  reset();
  const b = board(["a", "b"]);
  assert.equal(placeInOrder(b.root, [b.sections[1], b.sections[0]]), 1);
  assert.deepEqual(order(b.root), ["b", "a"]);
  assert.equal(b.consoles.filter((c) => c.resets > 0).length, 1, "the other console never left the page");
});

test("any permutation ends in exactly the wanted order, every element moved at most once", () => {
  let seed = 7;
  const MOD = 2 ** 31 - 1; // Park-Miller, so the shuffles are the same on every run
  const rnd = () => (seed = (seed * 48271) % MOD) / MOD;
  for (let round = 0; round < 300; round++) {
    reset();
    const n = 2 + Math.floor(rnd() * 9);
    const b = board(Array.from({ length: n }, (_, i) => `p${i}`));
    // Something in the parent that is not part of the order (the add-agent slot, a header row): it must stay last.
    const tail = add(new El("div", { cls: "tail" }));
    add(b.root, tail);
    const want = [...b.sections];
    for (let i = want.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [want[i], want[j]] = [want[j], want[i]];
    }
    const moved = placeInOrder(b.root, [...want, tail]);
    assert.deepEqual(
      order(b.root),
      [...want.map((s) => s.dataset.project), "div"],
      `round ${round}: the order the caller asked for, the tail still last`,
    );
    assert.equal(b.root.inserts, moved, "every move is one insertBefore");
    assert.ok(moved <= n, `round ${round}: ${moved} moves for ${n} sections`);
    for (const c of b.consoles) assert.ok(c.resets <= 1, `round ${round}: no console is reset twice by one re-order`);
  }
});

// ---- 3. hold and release --------------------------------------------------------------------------------------
test("a moved console that is following its newest line is back on it in the same task", () => {
  reset();
  const b = board(["a", "b"]);
  const held = holdScrolls(b.root);
  placeInOrder(b.root, [b.sections[1], b.sections[0]]);
  assert.equal(b.consoles[0].scrollTop, 0, "mid-move, a is at its first line: the frame the reader used to see");
  releaseScrolls(held);
  assert.deepEqual(
    b.consoles.map((c) => c.scrollTop),
    [MAX, MAX],
    "after the release no frame can be painted at 0",
  );
});

test("a console the reader took over goes back to the line they were on, not to the bottom and not to the top", () => {
  reset();
  const b = board(["a", "b"]);
  state.outPinned = { a: false }; // the reader scrolled a upwards
  b.consoles[0].scrollTop = 300;
  const held = holdScrolls(b.root);
  placeInOrder(b.root, [b.sections[1], b.sections[0]]); // detaches a
  assert.equal(b.consoles[0].scrollTop, 0);
  releaseScrolls(held);
  assert.equal(b.consoles[0].scrollTop, 300);
  assert.equal(b.consoles[1].scrollTop, MAX, "the console beside it was never moved and still follows its newest line");
});

test("without the release the same move leaves the console at 0 - the control", () => {
  reset();
  const b = board(["a", "b"]);
  holdScrolls(b.root);
  placeInOrder(b.root, [b.sections[1], b.sections[0]]);
  assert.equal(b.consoles[0].scrollTop, 0);
});

test("the hold is read BEFORE the move: a hold taken after it would read the 0 the move left", () => {
  reset();
  const b = board(["a", "b"]);
  state.outPinned = { a: false };
  b.consoles[0].scrollTop = 300;
  placeInOrder(b.root, [b.sections[1], b.sections[0]]);
  const late = holdScrolls(b.root);
  releaseScrolls(late);
  assert.equal(b.consoles[0].scrollTop, 0, "a late hold restores the reader to the top: why callers hold first");
});

test("all three kinds of scroll box a card has are held, each under its own key", () => {
  reset();
  const out = consoleBox("o1");
  const think = add(new El("details", { cls: "think", data: { thinkTurn: "t1" } }), new El("div", { cls: "think-body", box: { scrollHeight: 600, clientHeight: 200 } }));
  const sub = new El("div", { cls: "sub-console", data: { subConsoleBox: "s1" }, box: { scrollHeight: 500, clientHeight: 150 } });
  const flat = new El("pre", { cls: "job-out", data: { out: "o2" }, box: { scrollHeight: 100, clientHeight: 230 } }); // never overflowed
  const card = add(new El("div", { cls: "job" }), out, think, sub, flat);
  const other = sectionOf("z");
  const root = new El("tbody");
  root.isRoot = true;
  add(root, card, other);
  const thinkBody = think.children[0];
  state.thinkPinned.set("t1", false); // the reader parked the thinking block on a line
  thinkBody.scrollTop = 100;
  out.scrollTop = MAX;
  sub.scrollTop = 350;
  const held = holdScrolls(root);
  assert.equal(held.length, 5, "the console, the thinking body, the sub-console, the short console and the neighbour");
  placeInOrder(root, [other, card]);
  releaseScrolls(held);
  assert.equal(out.scrollTop, MAX, "pinned console: newest line");
  assert.equal(thinkBody.scrollTop, 100, "a thinking block the reader parked: their line");
  assert.equal(sub.scrollTop, 350, "pinned sub-console: newest line");
  assert.equal(flat.scrollTop, 0, "a box that never overflowed has nowhere to scroll and is left alone");
});

test("a box that left the page and did not come back is skipped, not written to", () => {
  reset();
  const b = board(["a", "b"]);
  const held = holdScrolls(b.root);
  b.root.children.splice(0, 1);
  b.sections[0].parentNode = null; // a was removed by something else while the move ran
  assert.doesNotThrow(() => releaseScrolls(held));
  assert.equal(b.consoles[0].scrollTop, MAX, "an unattached box is not touched");
});

// ---- 4. the movers go through them ----------------------------------------------------------------------------
const fn = (name) => {
  const a = src.indexOf(`\nfunction ${name}(`);
  assert.ok(a >= 0, `public/app.js has function ${name}()`);
  const z = src.indexOf("\n}\n", a);
  assert.ok(z > a, `function ${name}() ends at a closing brace in column 0`);
  return src.slice(a, z + 2);
};

for (const name of ["reorderProjects", "reorder", "sweepStaleBoard", "reorderAgentCards"]) {
  test(`${name}() holds the scroll boxes across what it moves and puts nothing down with a raw append`, () => {
    const body = fn(name);
    assert.match(body, /\bholdScrolls\(/, `${name}() reads its boxes before it moves anything`);
    assert.match(body, /\breleaseScrolls\(/, `${name}() hands them back in the same task`);
    assert.doesNotMatch(
      body,
      /\.appendChild\(|\.insertBefore\(/,
      `${name}() re-appending or re-inserting an element that is already in the page is the move that reset every console in it`,
    );
    // sweepStaleBoard moves a detail back under its own row, which is one `.after`, not a list.
    if (name !== "sweepStaleBoard") assert.match(body, /\bplaceInOrder\(/, `${name}() orders its list with placeInOrder`);
  });
}
