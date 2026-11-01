// A console the reader parked just above its newest line must stay exactly where they left it while lines arrive.
//
// The seam-free half of `tools/measure-console-drift.mjs` (there is no layout engine in `npm test`), so this reads the
// shipped functions out of `public/app.js` and drives them with the one browser rule they depend on: `scrollTop` is an
// offset into the content, clamped to `scrollHeight - clientHeight`, and assigning it is a write.
//
// What it pins down, and why. "Following the newest line" used to be a distance test with a 40 px tolerance, cached on
// the element (`_atBottom`) and consulted by every paint path (`stickSoon`, `stickConsole`, `paintStreamConsole`,
// `drawJobLine`). Forty px is wider than one row of a long turn, so a reader who nudged up to read the last line was
// still "at the bottom" as far as the page was concerned and was re-anchored on the next arriving line - measured on
// 0.46.0 as 42 moves / +850 px in 30 s on a console parked 24 px up, against 0 px when the same console was parked
// 296 px up (C:/CodeReviews/agent-worktree-gui/bounce/slot-c.md has the trend; the drift capture is this file's
// browser half). The rule now: the console follows only while it is on its newest line (gap <= 2 px) or the reader
// said so with ↓. A parked console is not moved at all.
//
// The restores keep their own 32 px tolerance on purpose: a rebuilt card has to know whether the reader *was* at the
// bottom, and that answer is read from a position the panel captured, not from a live gesture.
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

// The pin cache, the writer and both stick paths, read OUT of the page: a change to the rule changes these answers.
const code = [
  "const selfScrolled = new WeakSet();",
  "const stickPending = new Set();",
  "let stickFrame = 0;",
  grab("consolePinned"),
  grab("pinConsole"),
  grab("setScroll"),
  grab("wireConsole"),
  grab("stickSoon"),
  grab("stickConsole"),
].join("\n");

const frames = [];
const context = {
  state: { outPinned: {}, outScrolls: {} },
  WeakSet,
  Set,
  Math,
  Number,
  requestAnimationFrame: (fn) => {
    frames.push(fn);
    return frames.length;
  },
};
vm.createContext(context);
vm.runInContext(code, context);

// ---- a console box, with the browser's two rules ---------------------------------------------------------------
class Console {
  constructor({ content = 1000, view = 240, top = 0 } = {}) {
    this.dataset = { out: "turn-1" };
    this.content = content;
    this.clientHeight = view;
    this.top = top;
    this.isConnected = true;
    this.writes = []; // every assignment, so "the panel did not write" is countable
    this.scrollHandlers = [];
  }
  get scrollHeight() {
    return this.content;
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(v) {
    const clamped = Math.max(0, Math.min(Number(v) || 0, this.scrollHeight - this.clientHeight));
    this.writes.push(clamped);
    this.top = clamped;
  }
  addEventListener(type, fn) {
    if (type === "scroll") this.scrollHandlers.push(fn);
  }
  // The reader's own gesture: the browser moves the box and then reports it.
  scrollTo(where) {
    this.top = Math.max(0, Math.min(where, this.scrollHeight - this.clientHeight));
    for (const fn of this.scrollHandlers) fn();
  }
  grow(px) {
    this.content += px;
  }
  get max() {
    return this.scrollHeight - this.clientHeight;
  }
}

const wired = (opts) => {
  const el = new Console(opts);
  context.wireConsole(el);
  for (const fn of el.scrollHandlers) fn();
  return el;
};
const settle = () => {
  // The page sticks at most once per frame; a test frame is one synchronous turn.
  while (frames.length) frames.shift()();
};

// ---- the readings ----------------------------------------------------------------------------------------------
test("at the newest line is what makes a console follow, not 40 px above it", () => {
  const atBottom = wired({ content: 1000, view: 240, top: 760 });
  assert.equal(atBottom.top, atBottom.max, "the control box is on its newest line");
  assert.equal(atBottom._atBottom, true, "a console on its newest line follows");

  const parked = wired({ content: 1000, view: 240, top: 736 }); // 24 px above the end: one line of a long turn
  assert.equal(parked.max - parked.top, 24, "the reader parked 24 px above the bottom");
  assert.equal(parked._atBottom, false, "24 px above the newest line is reading, not following");
});

test("a console parked 24 px above the bottom is not moved while its next line arrives", () => {
  const el = wired({ content: 1000, view: 240, top: 736 });
  context.pinConsole(""); // no pin is written by a capture; the reader's own gesture unpinned it
  context.state.outPinned[el.dataset.out] = false;
  const before = el.top;
  el.grow(30); // one more line lands
  el.writes.length = 0;

  context.stickSoon(el); // the paint path that follows the newest line
  settle();
  context.stickConsole(el); // the 400 ms repair sweep

  assert.deepEqual(el.writes, [], "neither stick path wrote to a console the reader is reading");
  assert.equal(el.top, before, "the box is exactly where the reader left it");
  assert.equal(el.max - el.top, 54, "the content grew by the new line and the view did not chase it");
});

test("the same console on its newest line still follows, one line behind or a hundred", () => {
  const el = wired({ content: 1000, view: 240, top: 760 });
  el.grow(30);
  context.stickSoon(el);
  settle();
  assert.equal(el.top, el.max, "a following console stays on its newest line");

  const big = wired({ content: 60_000, view: 228, top: 59_772 });
  big.grow(120);
  context.stickSoon(big);
  settle();
  assert.equal(big.max - big.top, 0, "and it still does at a 50k-token console's height");
});

test("↓ is the reader's own way back to the tail, and it re-pins", () => {
  const el = wired({ content: 1000, view: 240, top: 400 });
  context.state.outPinned[el.dataset.out] = false;
  context.pinConsole(el.dataset.out); // what the ↓ button does before it scrolls
  context.setScroll(el, el.scrollHeight);
  assert.equal(el.top, el.max, "↓ puts the console on its newest line");
  assert.equal(context.consolePinned(el.dataset.out), true, "and the console follows again");
  el.grow(30);
  context.stickSoon(el);
  settle();
  assert.equal(el.top, el.max, "so the next line is followed");
});

test("a reader's scroll handler re-pins only on the newest line itself; the restores keep their own tolerance", () => {
  // The document's scroll listener is the page's re-pin rule. It is asserted from the shipped source because it is
  // mounted on `document`, not on a function this file can drive.
  assert.ok(
    src.includes("const onTail = gap <= 2;") && src.includes("state.outPinned[pre.dataset.out] = onTail;"),
    "the reader's own scroll event re-pins at the newest line, not within 32 px of it",
  );
  assert.ok(
    src.includes("el._atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;"),
    "and so does the console's own scroll cache",
  );
  // Restores are a different question (was the reader at the bottom when we captured?), and they keep 32 px.
  assert.ok(
    src.includes("atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32"),
    "a capture still reads 'was at the bottom' with its own tolerance",
  );
  // The ↓ chip appears exactly where following stops, or a reader parked a few px up is offered no way back.
  assert.ok(
    src.includes("const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight <= 2;"),
    "the ↓ chip appears when the console stops following, not 24 px later",
  );
});
