// Two consoles written at once are independent: nothing about a THIRD thing on the board may put either one back at its
// first line, not for one painted frame.
//
// What went wrong. Appending a node that is already in the page is a remove-then-insert, and a scroll box inside a
// removed subtree comes back at scrollTop 0. reorderProjects() re-appended every section of a folder to move one, so
// every open console on the board went to its first line in the same frame - the reader saw two consoles that were
// being written to jump to the top together and come back together, and read it as something switching between them.
// A single console did it as often as each of two (the cause never looked at the consoles); the second one only made it
// visible. The browser half is tools/verify-console-independence.mjs (six layouts, a real Chromium, every frame
// sampled) and the write half is tools/measure-console-writes.mjs (every scrollTop write and its caller). This file is
// the part that must never need a browser to fail.
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
//      sweepStaleBoard and reorderAgentCards hold the boxes, release them, and put nothing down with a raw append;
//   5. the COMBINED layout (reasoning drawn as rows inside the console) has ONE box per card where the separated one has
//      two, and it obeys the same rule: a move holds that box once and puts it back on its newest line, a repaint that
//      patches a row inside it moves nothing (only replacing the box does), and the detail swap placeRow performs is
//      held before the card leaves and handed back in the same task. Measured on the page, that swap clamps a console
//      to its first line 95-110 times in 60 s with no write at all, and the same-task restore is why no frame paints it
//      (docs/console-combined-first-line.md);
//   6. a subagent strip's signature is its OWN: one child's read, or the reader opening a child in another session's
//      strip, changes only the strip that draws that child - so a repaint cannot throw another session's open child
//      console back to its first line. The page-global counter this replaced is gone.
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
  remove() {
    if (!this.parentNode) return this;
    const sibs = this.parentNode.children;
    sibs.splice(sibs.indexOf(this), 1);
    this.parentNode = null;
    leaveLayout(this); // taking a subtree out of the page is the same leave as a move's first half
    return this;
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

// The COMBINED layout (🌊). With the reasoning drawn as rows INSIDE the console, a card has ONE scroll box where the
// separated layout has two (`pre.job-out` plus a `.think-body`), and the reasoning rows are not boxes at all. Four
// agents were driven in this layout while three of them kept writing: the write log blames the card swap placeRow
// performs for 95 clamps to scrollTop 0 in 60 s with no write behind them (docs/console-combined-first-line.md).
const thinkRow = (id, i) => new El("div", { cls: "jl-think", data: { lid: `${id}:${i}` } });
const combinedCard = (id, rows = 3) => {
  const card = new El("div", { cls: "job", data: { thread: `t-${id}` } });
  const out = new El("pre", { cls: "job-out", data: { out: id }, box: { ...OVERFLOW } });
  add(out, ...Array.from({ length: rows }, (_, i) => thinkRow(id, i)));
  add(card, out);
  return { card, out };
};
const combinedSection = (id, rows = 3) => {
  const { card, out } = combinedCard(id, rows);
  const section = add(new El("section", { cls: "project", data: { project: id } }), card);
  return { section, card, out };
};
// The keyed row patch syncStreamConsole makes on every 1.2 s poll: the row is re-drawn in place and the box that holds
// it never leaves the page. `out.insertBefore(fresh, have)` then `have.remove()` is the model's `have.replaceWith()`.
const repaintRow = (out, index, fresh) => {
  out.insertBefore(fresh, out.children[index]);
  out.children[index + 1].remove();
  return out;
};

// The page's own answers, stood in for: who is pinned, and the clamp the browser applies to every scrollTop write.
const state = { thinkPinned: new Map(), subConsolePinned: new Map(), outPinned: {} };
const consolePinned = (id) => state.outPinned[id] !== false;
const setScroll = (el, top) => {
  if (!el) return;
  const v = Math.min(Math.max(0, Math.round(Number(top) || 0)), Math.max(0, el.scrollHeight - el.clientHeight));
  // The page stamps every write it makes (`el._selfTop = v`), and captureScrolls() reads that stamp to tell "the
  // panel placed this box" from "this is a fresh node sitting at 0". The model keeps the stamp for the same reason.
  el._selfTop = v;
  el.scrollTop = v;
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

// ---- 5. the combined layout: the reasoning is rows OF the console -------------------------------------------------
// Four agents on one board, all drawn with the reasoning combined into the console and three of them still writing
// while the first was being read: 5,083 scrollTop writes in 60 s, and 110 scrollTop changes with NO write at all - every
// one of them DOWN to 0, every one of them a card carried into a fresh agent slot (fillAgentSlots' replaceWith,
// public/app.js:11112, reached from placeRow on the 5 s row pass and from renderProjectRows on a project frame). The
// restore in that same task is why not one painted frame showed a pinned console at its first line.
// docs/console-combined-first-line.md is the measurement; this section is its rule.
const scrollCode = ["captureScrolls", "restoreScrolls"].map(fn).join("\n");
const { captureScrolls, restoreScrolls } = new Function(
  "state",
  "consolePinned",
  "setScroll",
  `${scrollCode}\nreturn { captureScrolls, restoreScrolls };`,
)(state, consolePinned, setScroll);
// The swap placeRow performs: the detail's agent slot is replaced and the live card is moved into the fresh one. The
// card leaves the page on the way, so the console inside it is a scroll area at 0 by the time the slot is back.
const swapSlot = (detail, card) => {
  const slot = card.parentNode;
  const fresh = new El("div", { cls: "agent-slot" });
  detail.insertBefore(fresh, slot);
  slot.remove();
  fresh.appendChild(card);
  return fresh;
};
const detailOf = (...cards) => {
  const detail = new El("tr", { cls: "detail", data: { detail: "alpha::a" } });
  for (const card of cards) add(detail, add(new El("div", { cls: "agent-slot" }), card));
  return detail;
};

test("the combined layout is ONE box per card: a moved section holds its console once and puts it back", () => {
  reset();
  const a = combinedSection("a");
  const b = combinedSection("b");
  const root = new El("tbody");
  root.isRoot = true;
  add(root, a.section, b.section);
  assert.equal(root.querySelectorAll(".think-body").length, 0, "combined: the reasoning is rows of the console, so there is no second box to lose");
  assert.equal(a.out.children.length, 3, "and the rows really are inside it - nothing below is vacuous");
  a.out.scrollTop = MAX;
  b.out.scrollTop = MAX;
  const held = holdScrolls(root);
  assert.deepEqual(held.map((h) => h.key), ["a", "b"], "one entry per console: a reasoning row is not a scroll box of its own");
  placeInOrder(root, [b.section, a.section]); // a moves: it leaves the layout on the way
  assert.equal(a.out.scrollTop, 0, "mid-move the combined console is at its first line, exactly as a separated one is");
  releaseScrolls(held);
  assert.deepEqual([a.out.scrollTop, b.out.scrollTop], [MAX, MAX], "and both are back on their newest line in the same task");
});

test("a repaint that patches a row inside the combined console moves nothing - only replacing the box does", () => {
  reset();
  const a = combinedSection("a");
  const root = new El("tbody");
  root.isRoot = true;
  add(root, a.section);
  a.out.scrollTop = MAX;
  for (let i = 0; i < 3; i++) repaintRow(a.out, 0, thinkRow("a", 100 + i)); // the 1.2 s poll re-drawing the first row
  assert.equal(a.out.scrollTop, MAX, "the box the reader is following never left the page");
  assert.equal(a.out.resets, 0, "and the browser never put it back at its first line");
  // The failure shape this rules out: a repaint that replaces the console node instead of patching a row in it.
  const fresh = consoleBox("a");
  a.card.insertBefore(fresh, a.out);
  a.out.remove();
  assert.equal(fresh.scrollTop, 0, "a replaced box starts at its first line - which is why the 🌊 renderer patches rows");
});

test("the detail swap placeRow performs clamps the console to 0 and the same task hands each reader their place back", () => {
  reset();
  const parked = combinedCard("parked");
  const pinned = combinedCard("pinned");
  const detail = detailOf(parked.card, pinned.card);
  const root = new El("tbody");
  root.isRoot = true;
  add(root, detail);
  setScroll(parked.out, 300); // the reader scrolled this one up and left it there
  setScroll(pinned.out, MAX); // this one follows its newest line
  state.outPinned = { parked: false };
  const held = captureScrolls(detail); // read BEFORE the card leaves the page
  swapSlot(detail, parked.card);
  swapSlot(detail, pinned.card);
  assert.deepEqual([parked.out.scrollTop, pinned.out.scrollTop], [0, 0], "both consoles are at their first line mid-swap");
  restoreScrolls(detail, held); // and the page hands them back in the same task, so no frame is painted at 0
  assert.deepEqual(
    [parked.out.scrollTop, pinned.out.scrollTop],
    [300, MAX],
    "the parked box goes back to the reader's line, the pinned one to its newest line - neither to the top",
  );
});

test("without that restore the same swap leaves the console at its first line - the frame the write log caught", () => {
  reset();
  const a = combinedSection("a");
  const detail = detailOf(a.card);
  const root = new El("tbody");
  root.isRoot = true;
  add(root, detail);
  setScroll(a.out, 300);
  state.outPinned = { a: false };
  captureScrolls(detail); // taken and thrown away: the swap without the hand-back
  swapSlot(detail, a.card);
  assert.equal(a.out.scrollTop, 0, "110 times in 60 s on the page - and only the same-task restore kept it off the screen");
});

test("placeRow reads every console's top before the card leaves the detail and restores it after fillAgentSlots", () => {
  const body = fn("placeRow");
  const capture = body.search(/querySelectorAll\("pre\.job-out"\)/);
  const fill = body.indexOf("fillAgentSlots(");
  const restore = body.indexOf("restoreScrolls(");
  const stored = body.indexOf("applyStoredScrolls(");
  assert.ok(capture >= 0, "placeRow() captures the consoles it is about to move");
  assert.ok(fill > capture, "the capture is taken before fillAgentSlots() moves the cards - a read taken after it reads the 0");
  assert.ok(restore > fill, "and every console is put back after the cards are in the new detail");
  assert.ok(stored > restore, "with the remembered positions applied after the pre-move capture");
  assert.match(body, /\bholdSubConsoles\(/, "a child's console cannot ride on the element, so it is held by the card");
  assert.match(body, /\breleaseScrolls\(heldSubs\)/, "and handed back in the same task");
});

test("the 🌊 repaint patches the console's rows and never replaces the console itself", () => {
  const body = fn("syncStreamConsole");
  assert.doesNotMatch(body, /out\.replaceWith\(/, "replacing the box would be a fresh scroll area at its first line");
  assert.match(body, /out\.insertBefore\(/, "rows are moved into place inside the same box");
  assert.match(body, /have\.replaceWith\(fresh\)/, "only a row whose words moved is replaced");
});

// ---- 6. a subagent strip's signature ---------------------------------------------------------------------------
// The subagent strip under a turn's console is rebuilt in place from its signature. The signature it used to build
// carried `[...state.openSubConsole]` and a PAGE-GLOBAL counter bumped by every child's read, so a poll of one
// session's child changed every session's strip: with two sessions each showing an open child console, each 5 s poll
// rebuilt BOTH strips and put BOTH child consoles back at their first line. The strip's own rows and its own
// children's read counts are what it draws; nothing else may be in it.
const sigCode = ["subagentsSig", "subagentsOpenSig", "subagentsStripSig", "bumpSubRead"].map(fn).join("\n");
const stripSig = new Function("state", `${sigCode}\nreturn { subagentsSig, subagentsOpenSig, subagentsStripSig, bumpSubRead };`);
const stripState = () => {
  const s = { openSubConsole: new Set(), subConsoleReads: new Map(), collapsedSubs: new Set() };
  const { subagentsSig, subagentsOpenSig, subagentsStripSig, bumpSubRead } = stripSig(s);
  return { s, subagentsSig, subagentsOpenSig, subagentsStripSig, bumpSubRead };
};
const child = (id, goal = `review ${id}`, running = true) => ({ id, goal, running });

test("a read of one child changes only the strip that draws that child", () => {
  const { s, subagentsStripSig, bumpSubRead } = stripState();
  const alpha = [child("c-alpha", "check the build")];
  const beta = [child("c-beta", "read the diff")];
  s.openSubConsole.add("c-alpha");
  s.openSubConsole.add("c-beta");
  const alphaBefore = subagentsStripSig(alpha, "turn-alpha");
  const betaBefore = subagentsStripSig(beta, "turn-beta");
  // A poll of the alpha child's console lands.
  bumpSubRead("c-alpha");
  assert.notEqual(subagentsStripSig(alpha, "turn-alpha"), alphaBefore, "the strip that draws it repaints");
  assert.equal(
    subagentsStripSig(beta, "turn-beta"),
    betaBefore,
    "the other session's strip is not rebuilt by a read that has nothing to do with it - a rebuild is a new scroll box",
  );
});

test("the reader opening a child in another session's strip leaves this strip's signature alone", () => {
  const { s, subagentsStripSig } = stripState();
  const alpha = [child("c-alpha")];
  const beta = [child("c-beta")];
  s.openSubConsole.add("c-alpha");
  const alphaBefore = subagentsStripSig(alpha, "turn-alpha");
  s.openSubConsole.add("c-beta");
  assert.equal(subagentsStripSig(alpha, "turn-alpha"), alphaBefore, "one strip's open set is not another's");
  assert.notEqual(subagentsStripSig(beta, "turn-beta"), subagentsStripSig(alpha, "turn-alpha"));
});

test("a read of a child that is not open changes no strip: nothing draws it", () => {
  const { s, subagentsStripSig, bumpSubRead } = stripState();
  const alpha = [child("c-alpha")];
  const before = subagentsStripSig(alpha, "turn-alpha");
  bumpSubRead("c-alpha"); // the roster poll read a closed child
  assert.equal(subagentsStripSig(alpha, "turn-alpha"), before);
});

test("a strip's own rows, its own read counts and its own fold are in its signature", () => {
  const { s, subagentsStripSig } = stripState();
  const alpha = [child("c-alpha")];
  s.openSubConsole.add("c-alpha");
  const base = subagentsStripSig(alpha, "turn-alpha");
  assert.equal(subagentsStripSig(alpha, "turn-alpha"), base, "the same strip twice is the same signature");
  s.collapsedSubs.add("turn-alpha");
  const folded = subagentsStripSig(alpha, "turn-alpha");
  assert.notEqual(folded, base, "folding this strip repaints it");
  assert.equal(subagentsStripSig(alpha, "turn-beta"), base, "another strip's fold is not this one's");
  const done = subagentsStripSig([child("c-alpha", "review c-alpha", false)], "turn-alpha");
  assert.notEqual(done, folded, "a child finishing repaints its own strip");
  const renamed = subagentsStripSig([child("c-alpha", "a different goal")], "turn-alpha");
  assert.notEqual(renamed, done, "a child's goal is what the strip draws");
});

test("one counter per child: two children keep their own read counts", () => {
  const { s, subagentsStripSig, bumpSubRead } = stripState();
  s.openSubConsole.add("c-alpha");
  s.openSubConsole.add("c-beta");
  bumpSubRead("c-alpha");
  bumpSubRead("c-alpha");
  bumpSubRead("c-beta");
  assert.deepEqual([s.subConsoleReads.get("c-alpha"), s.subConsoleReads.get("c-beta")], [2, 1]);
  assert.match(subagentsStripSig([child("c-alpha")], "t1"), /c-alpha@2/);
  assert.match(subagentsStripSig([child("c-beta")], "t2"), /c-beta@1/);
});

test("the strip repaint compares a per-strip signature, and puts the open child consoles back in the same task", () => {
  const body = fn("paintSubagents");
  assert.match(body, /subagentsStripSig\(rows, key\)/, "the strip compares its own signature");
  assert.doesNotMatch(body, /subConsoleVersion/, "the page-global counter that rebuilt every strip is gone");
  assert.doesNotMatch(
    body,
    /\[\.\.\.state\.openSubConsole\]/,
    "the whole board's open set is not part of one strip's signature",
  );
  assert.match(body, /applySubConsoleScrolls\(fresh\)/, "the repaint puts each open child console back before the frame");
});
assert.doesNotMatch(src, /subConsoleVersion/, "public/app.js has no page-global subagent strip counter left");
