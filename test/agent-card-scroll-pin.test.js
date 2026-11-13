// The agent card's OWN session scroller must follow a long stream, and must let go the moment the reader scrolls up.
//
// WHAT THIS PINS. In the docked Chat pane (and in a maximized card) the card's `.job-body` is the scrollport: the
// turns are drawn at their content height inside it (`.job-out { max-height: none }`), so the console's own pin has
// no overflow to follow and returned every time. The pane grew under the reader and nothing moved - the new lines
// went below the fold and the reader dragged the session bar down by hand. The fix is the console's rule one level
// up: `.job-body` follows its foot while the reader is at it (a few px), and is never moved once they have taken it.
//
// WHY IT IS DRIVEN OUT OF THE PAGE. There is no layout engine in `npm test`, so this reads the shipped functions out
// of `public/board/console.js` and drives them with the one browser rule they depend on: `scrollTop` is an offset into
// the content, clamped to `scrollHeight - clientHeight`, and assigning it is a write. A change to the rule changes
// these answers; a change that only renames something does not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const page = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = `${page("public/board/console.js")}\n${page("public/app.js")}\n${page("public/assistant.js")}`;

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `public/board/console.js still carries ${name}()`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is still a top-level function`);
  return src.slice(start, end + 3);
}

const code = [
  "const CARD_TAIL_PX = 8;",
  "const selfScrolled = new WeakSet();",
  "const stickPending = new Set();",
  "let stickFrame = 0;",
  "const cardStickPending = new Set();",
  "let cardStickFrame = 0;",
  grab("consolePinned"),
  grab("setScroll"),
  grab("isCardScrollport"),
  grab("cardBodyOf"),
  grab("cardBodyFollowing"),
  grab("noteCardBodyScroll"),
  grab("stickCardBodySoon"),
  grab("stickCardBody"),
  grab("cardTailConsole"),
  grab("stickSoon"),
  grab("stickConsole"),
  grab("paintToBottom"),
].join("\n");

const frames = [];
const context = {
  state: { outPinned: {}, outScrolls: {}, thinkPinned: new Map() },
  WeakSet,
  Set,
  Map,
  Math,
  Number,
  Boolean,
  String,
  requestAnimationFrame: (fn) => {
    frames.push(fn);
    return frames.length;
  },
};
vm.createContext(context);
vm.runInContext(code, context);

const settle = () => {
  // The page sticks at most once per body per frame; a test frame is one synchronous turn.
  while (frames.length) frames.shift()();
};

// ---- the boxes, with the browser's two rules ------------------------------------------------------------------
class Wrap {
  constructor() {
    this.toggled = new Map();
    this.classList = { toggle: (cls, on) => this.toggled.set(cls, Boolean(on)) };
  }
}

class Box {
  constructor({ content = 1000, view = 240, top = 0 } = {}) {
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
  get max() {
    return this.scrollHeight - this.clientHeight;
  }
  grow(px) {
    this.content += px;
  }
  // The reader's own gesture: the browser moves the box and then reports it.
  scrollTo(where) {
    this.top = Math.max(0, Math.min(where, this.max));
    for (const fn of this.scrollHandlers) fn();
  }
}

// A `.job-body` the docked Chat pane draws: the sheet makes it `overflow: auto`, so it is one of the two scrollports
// `isCardScrollport` names.
class PaneBody extends Box {
  constructor(opts = {}) {
    super(opts);
    this.dataset = {};
    this.classList = { toggled: new Map(), toggle: (cls, on) => this.classList.toggled.set(cls, Boolean(on)) };
    this.outs = [];
  }
  closest(sel) {
    if (sel === '[data-subpane="chat"]') return this;
    return null;
  }
  querySelectorAll(sel) {
    return sel === "pre.job-out" ? this.outs.slice() : [];
  }
}

// A `.job-body` on the board's own card: `overflow: visible`, never a scrollport, and it must never be armed.
class PlainBody extends PaneBody {
  closest() {
    return null;
  }
}

class Console extends Box {
  constructor(body, { out = "turn-1", content = 1000, view = 240, top = 0 } = {}) {
    super({ content, view, top });
    this.dataset = { out };
    this.body = body;
    this.wrap = new Wrap();
    if (body) body.outs.push(this);
  }
  closest(sel) {
    if (sel === ".job-body") return this.body;
    if (sel === ".out-wrap") return this.wrap;
    return null;
  }
}

// A console drawn in the pane cannot scroll itself: its content height IS its client height.
const paneConsole = (body, out = "turn-1") => {
  const pre = new Console(body, { out, content: 900, view: 900 });
  return pre;
};

// ---- the readings ----------------------------------------------------------------------------------------------

test("the pane follows a streamed line: the body moves, because the console cannot", () => {
  const body = new PaneBody({ content: 1000, view: 400, top: 600 });
  context.noteCardBodyScroll(body); // the reader is on the foot
  assert.equal(body._atBottom, true, "a body on its foot is following");

  const pre = paneConsole(body);
  assert.equal(
    pre.scrollHeight - pre.scrollTop - pre.clientHeight,
    0,
    "the console is drawn at its content height: it has no tail of its own to follow",
  );

  body.grow(120); // one reasoning chunk lands under the last line
  context.stickSoon(pre);
  settle();
  assert.equal(body.max - body.top, 0, "the session scroller rode the growth and the line is on screen");
  // The console still receives the no-op write its own pin has always made (`setScroll(out, out.scrollHeight)` on a
  // box with no overflow clamps to 0): what matters is that it does not move, not that the call is skipped.
  assert.equal(pre.top, 0, "and the console itself did not move: it has nothing to scroll");
});

test("a few px off the foot still follows; a reader parked above that is left exactly where they are", () => {
  const near = new PaneBody({ content: 1000, view: 400, top: 600 - 4 });
  assert.equal(near.max - near.top, 4, "the reader is 4 px off the foot");
  context.noteCardBodyScroll(near);
  assert.equal(near._atBottom, true, "a few px is the reader still following");

  const parked = new PaneBody({ content: 1000, view: 400, top: 600 - 40 });
  context.noteCardBodyScroll(parked);
  assert.equal(parked._atBottom, false, "40 px up is reading, not following");
});

test("a reader who scrolled up is not moved by the next forty lines", () => {
  const body = new PaneBody({ content: 4000, view: 400, top: 900 });
  context.noteCardBodyScroll(body);
  assert.equal(body._atBottom, false, "the reader took the pane over");
  const pre = paneConsole(body);
  const before = body.top;
  const gapBefore = body.max - body.top;
  body.writes.length = 0;

  for (let i = 0; i < 40; i += 1) {
    body.grow(24); // a line lands
    context.stickSoon(pre); // the append path every streamed line takes
    context.stickCardBody(body); // and the settled pass after a repaint
    settle();
  }

  assert.deepEqual(body.writes, [], "no stick path wrote to a pane the reader is reading");
  assert.equal(body.top, before, "the box is exactly where the reader left it");
  assert.equal(body.max - body.top, gapBefore + 40 * 24, "the content grew and the view never chased it");
});

test("a body that is not a scrollport is never armed, so the board's cards pay nothing", () => {
  const plain = new PlainBody({ content: 4000, view: 400, top: 0 });
  const pre = paneConsole(plain);
  assert.equal(context.cardBodyOf(pre), null, "an overflow:visible .job-body is not a session scroller");

  plain.grow(200);
  plain.writes.length = 0;
  context.stickSoon(pre);
  settle();
  context.stickCardBody(plain);
  assert.deepEqual(plain.writes, [], "nothing was measured or written for it");
});

test("a maximized card is a scrollport too, by its own rule", () => {
  const body = new PlainBody({ content: 2000, view: 400, top: 1600 });
  body.closest = (sel) => (sel === ".job.maximized" ? body : null);
  assert.equal(context.isCardScrollport(body), true, "`.job.maximized .job-body` is `overflow: auto`");
  body.grow(90);
  context.stickCardBody(body);
  assert.equal(body.max - body.top, 0, "and it is carried to its foot the same way");
});

test("the newest console carries the pane's one chip, and it speaks for the body", () => {
  const body = new PaneBody({ content: 4000, view: 400, top: 900 });
  context.noteCardBodyScroll(body);
  const older = paneConsole(body, "turn-1");
  const newest = paneConsole(body, "turn-2");

  context.paintToBottom(newest);
  assert.equal(newest.wrap.toggled.get("is-at-end"), false, "scrolled away: the chip is offered");
  context.paintToBottom(older);
  assert.equal(older.wrap.toggled.get("is-at-end"), true, "only the newest console is the pane's chip");

  body.scrollTo(body.max); // the reader is back on the foot
  context.paintToBottom(newest);
  assert.equal(newest.wrap.toggled.get("is-at-end"), true, "on the foot: the chip fades out");
});

test("a pane with no console at all offers no chip", () => {
  const body = new PaneBody({ content: 4000, view: 400, top: 900 });
  assert.equal(context.cardTailConsole(body), null, "every turn folded: nothing to hang it on");
});

// ---- the two call sites that cannot be driven from here ---------------------------------------------------
// The reader's scroll handler and the ↓ press are mounted on `document` by public/app.js, so they are asserted from
// the shipped source: the first is what keeps the pin honest, the second is the reader's way back.
test("the page reads the pane's own scroll, and ↓ moves the body", () => {
  assert.ok(
    src.includes('pre.classList.contains("job-body")') && src.includes("if (readerInputHere(pre)) noteCardBodyScroll(pre);"),
    "a scroll on .job-body records whether the reader is at its foot",
  );
  assert.ok(
    /const body = cardBodyOf\(box\);\s*\n\s*if \(body\) \{\s*\n\s*body\._atBottom = true;/.test(src),
    "the to-the-newest chip re-pins the session scroller and jumps it",
  );
  assert.ok(
    src.includes("setScroll(body, body.scrollHeight);") && src.includes("function pinChatToBottom(force = false)"),
    "the assistant's own pin writes through setScroll, so the panel can tell its scroll from the reader's",
  );
});
