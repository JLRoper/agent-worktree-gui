// A wheel over one card must not decide another card's pin.
//
// What went wrong. The guard that separates "the reader scrolled this console" from "the panel clamped it" was one
// document-wide timestamp (`lastInputAt`, public/app.js): any wheel / key / click anywhere on the page made the next
// 1,200 ms of EVERY console's scroll events read as its reader's own. So a wheel the reader used to park card B let a
// silent 35 px clamp on card A - which they never touched - rewrite A's pin from `true` to `false`, and A then stayed
// off its tail for the rest of the window because nothing re-pins an unpinned console. tools/measure-console-pin.mjs
// measured it on the page: pin 1 -> 0 at 35 px from the tail, 790 ms after the wheel, 2,587 frames behind it.
//
// The guard under test is READ OUT of public/app.js between its markers, not copied here (the way
// console-independence.test.js reads its region): the page's own rule is what is driven, so a change to that rule
// changes these answers.
//
//   1. the clock is per card: a wheel inside card A re-arms A and leaves B exactly as it was - the defect, in one
//      assertion, against a control that shows the same wheel reaching A at all;
//   2. every kind of reader input the page records (wheel, mousedown, keydown, touchstart) is scoped the same way, and
//      one inside a card's reply box counts for the card's console;
//   3. input outside every card decides nothing - the board's chrome and the assistant panel are not a console scroll;
//   4. the window is 1,200 ms and per card: A at 1,199 ms still counts, at 1,201 ms does not, while B's later gesture
//      keeps B armed on its own clock;
//   5. the page's three scroll sites ask the per-card question, and the document-wide comparison is gone from all
//      three - a call site left behind would silently restore the old behaviour for that box.
import assert from "node:assert/strict";
import { after } from "node:test";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const begin = src.indexOf("// ---- the reader's own input, per card");
const end = src.indexOf("// ---- end the reader's own input, per card");
assert.ok(begin >= 0 && end > begin, "public/app.js carries the per-card input markers this test reads");
const code = src.slice(src.indexOf("\n", begin) + 1, end);

// ---- a just-enough DOM: parent links, a class list and `closest` for the one selector the guard asks for -----------
class El {
  constructor(tag, { cls = "", data = {}, parent = null } = {}) {
    this.tag = tag;
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.dataset = { ...data };
    this.parentNode = parent;
    this.children = [];
    if (parent) parent.children.push(this);
  }
  get classList() {
    return { contains: (c) => this.classes.has(c) };
  }
  closest(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[data-([\w-]+)\])?$/.exec(sel);
    if (!m) throw new Error(`selector this model does not read: ${sel}`);
    const classes = m[2].split(".").filter(Boolean);
    for (let n = this; n; n = n.parentNode) {
      if (m[1] && n.tag !== m[1]) continue;
      if (!classes.every((c) => n.classes.has(c))) continue;
      if (m[3] && n.dataset[m[3]] == null) continue;
      return n;
    }
    return null;
  }
}

// The page's own guard, evaluated against a stub document: listeners are kept so the test can fire the same events the
// page listens for, and `Date.now` is a clock the test sets by hand (the window is the whole subject here).
let clock = 1_000_000;
const realNow = Date.now;
function page() {
  const listeners = new Map();
  const document = {
    addEventListener(ev, cb) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(cb);
    },
  };
  const api = new Function("document", `${code}\nreturn { readerInputHere, lastInputAt, INPUT_WINDOW_MS };`)(document);
  return {
    ...api,
    fire(ev, target) {
      for (const cb of listeners.get(ev) || []) cb({ type: ev, target });
      return target;
    },
    listened: () => [...listeners.keys()].sort(),
  };
}

// Card A and card B: each with a console, and A with the reply box a reader types in.
function board() {
  const cardA = new El("div", { cls: "job", data: { thread: "thA" } });
  const cardB = new El("div", { cls: "job", data: { thread: "thB" } });
  const outA = new El("pre", { cls: "job-out", data: { out: "outA" }, parent: cardA });
  const outB = new El("pre", { cls: "job-out", data: { out: "outB" }, parent: cardB });
  const replyA = new El("div", { cls: "reply-box", data: { reply: "thA" }, parent: cardA });
  const chrome = new El("div", { cls: "board-chrome" });
  return { cardA, cardB, outA, outB, replyA, chrome };
}

test("a wheel inside one card does not arm another card's console", () => {
  const p = page();
  const b = board();
  clock = 1_000_000;
  p.fire("wheel", b.outA);
  assert.equal(p.readerInputHere(b.outA), true, "the card the reader wheeled is armed");
  assert.equal(p.readerInputHere(b.outB), false, "the card they did not touch is not: this is the defect");
});

test("every input the page records is scoped to the card it landed in, including the reply box", () => {
  const b = board();
  for (const ev of ["wheel", "mousedown", "keydown", "touchstart"]) {
    const p = page();
    clock = 2_000_000;
    p.fire(ev, b.replyA);
    assert.equal(p.readerInputHere(b.outA), true, `${ev} in card A's reply box arms card A`);
    assert.equal(p.readerInputHere(b.outB), false, `${ev} in card A leaves card B alone`);
  }
});

test("input outside every card decides nothing", () => {
  const p = page();
  const b = board();
  clock = 3_000_000;
  p.fire("wheel", b.chrome);
  p.fire("keydown", b.chrome);
  assert.equal(p.readerInputHere(b.outA), false);
  assert.equal(p.readerInputHere(b.outB), false);
  // and an event with no element at all (a synthesized event, a document target) does not throw or arm anything.
  p.fire("wheel", null);
  assert.equal(p.readerInputHere(b.outA), false);
});

test("the window is 1,200 ms and each card keeps its own clock", () => {
  const p = page();
  const b = board();
  const t0 = 4_000_000;
  clock = t0;
  p.fire("wheel", b.outA);
  clock = t0 + 1_199;
  assert.equal(p.readerInputHere(b.outA), true, "1,199 ms after the reader's wheel is still their scroll");
  clock = t0 + 1_201;
  assert.equal(p.readerInputHere(b.outA), false, "1,201 ms is the panel's own move again");

  // A second gesture in the OTHER card moves only that card's clock.
  clock = t0 + 500;
  p.fire("wheel", b.outB);
  clock = t0 + 1_300;
  assert.equal(p.readerInputHere(b.outA), false, "card A's window closed");
  assert.equal(p.readerInputHere(b.outB), true, "card B was wheeled 800 ms ago and is still the reader's");
  assert.equal(p.INPUT_WINDOW_MS, 1200);
});

test("all three scroll sites ask the per-card question and none keeps the document-wide one", () => {
  assert.equal((src.match(/readerInputHere\(pre\)/g) || []).length, 3, "think-body, sub-console and job-out scroll sites");
  assert.doesNotMatch(src, /Date\.now\(\) - lastInputAt < 1200/, "no call site compares against a page-wide clock");
  assert.equal((src.match(/lastInputAt\.set\(/g) || []).length, 1, "one writer, keyed by card thread");
  assert.match(src, /e\.target\.closest\("\.job\[data-thread\]"\)/, "the writer resolves the card from the event target");
});

// Keep the real clock for every other test in this process.
after(() => {
  Date.now = realNow;
});
// The guard reads Date.now directly; install the test clock once the file's helpers are defined.
Date.now = () => clock;
