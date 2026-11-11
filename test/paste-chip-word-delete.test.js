// Ctrl+Backspace and Ctrl+Delete in a chip box: the word on that side of the caret goes, and a chip sitting
// beside the caret goes WHOLE in one press.
//
// WHAT THIS COVERS, and why it is stated in keys rather than in functions: the box is a contenteditable host
// with one non-editable atom in it, and the only honest contract is "press this, the box reads that". Every
// case below fires a real keydown at the box, through the module's own document-level handler, and then reads
// the box back with readBox() - the one reader every send, steer and draft path uses.
//
//   1. Ctrl+Backspace with the caret just after a chip removes the chip, keeps the typed text on either side,
//      and takes the chip's text out of the panel's state with it;
//   2. Ctrl+Delete with the caret just before a chip does the same in the forward direction;
//   3. Ctrl+Backspace inside typed text removes the word before the caret (and the whitespace it owns);
//   4. Ctrl+Delete inside typed text removes the word after the caret;
//   5. the keys this must not disturb: plain Backspace beside a chip (still one chip, whole), plain Backspace
//      inside text (left to the browser, CHARACTERWISE), Enter (sent by app.js, never eaten here), and the
//      chip's own delete control.
//
// The four word-delete cases are the defect: the handler returned early on any modifier, so a box with a chip
// in it did nothing on Ctrl+Backspace at the boundary, and the DOM-level word delete was Chrome's accident
// rather than the module's contract. They fail before the fix and pass after it; the guards pass either way.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createDom } from "./fixtures/mini-dom.js";

const SOURCE = readFileSync(new URL("../public/board/paste-chips.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PASTE = Array.from({ length: 6 }, (_, i) => `pasted line ${i + 1} of the block`).join("\n");

// One page's worth of the module: its own document, its own selection, and the state the panel would hold.
function page() {
  const dom = createDom();
  const state = { pasteChips: new Map(), boxModels: new Map(), pasteChipSeq: 0 };
  const store = new Map();
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sandbox = {
    document: dom.document,
    window: dom.window,
    state,
    sessionStorage,
    Event: dom.MiniEvent,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: "public/board/paste-chips.js" });
  return { dom, ctx, state, document: dom.document };
}

function boxFor(env, key = "reply:probe-thread") {
  const box = env.document.createElement("div");
  box.className = "reply-box chipbox";
  box.setAttribute("contenteditable", "true");
  box.setAttribute("data-chipbox", key);
  env.document.body.appendChild(box);
  return box;
}

// A real paste event at the box, carrying plain text - the gesture the reader makes.
function pasteAt(env, box, text) {
  const ev = new env.dom.MiniEvent("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { files: [], getData: () => text };
  box.dispatchEvent(ev);
  return ev;
}

// A real keydown at the box, with the modifiers held.
function keyAt(env, box, key, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  const ev = new env.dom.MiniEvent("keydown", { bubbles: true, cancelable: true });
  ev.key = key;
  ev.ctrlKey = ctrl;
  ev.shiftKey = shift;
  ev.altKey = alt;
  ev.metaKey = meta;
  box.dispatchEvent(ev);
  return ev;
}

function setUp(env, { before = "", after = "", paste = true } = {}) {
  const box = boxFor(env);
  if (before) env.ctx.writeBox(box, before);
  box.focus();
  env.ctx.setCaretOffset(box, env.ctx.readBox(box).length);
  if (paste) pasteAt(env, box, PASTE);
  if (after) {
    // Typing after the paste: the module inserts at the caret, which is where the paste left it.
    env.ctx.insertTextAt(box, after);
    env.ctx.setCaretOffset(box, env.ctx.readBox(box).length);
  }
  return box;
}

const chipsOf = (box) => box.querySelectorAll(".paste-chip").length;
const CHIP_TEXT = PASTE;

test("1. Ctrl+Backspace just after a chip removes the chip whole, keeps the text on both sides, and clears its state", () => {
  const env = page();
  const box = setUp(env, { before: "Quote this: ", after: " and this after" });
  assert.equal(chipsOf(box), 1, "the paste formed one chip before the key is pressed");
  env.ctx.setCaretOffset(box, "Quote this: ".length + CHIP_TEXT.length);
  assert.equal(env.ctx.caretOffset(box), "Quote this: ".length + CHIP_TEXT.length, "the caret sits at the chip's right edge");

  const ev = keyAt(env, box, "Backspace", { ctrl: true });

  assert.equal(env.ctx.readBox(box), "Quote this:  and this after", "Ctrl+Backspace at the chip boundary removes the chip and nothing else");
  assert.equal(chipsOf(box), 0, "the chip is gone from the box");
  assert.equal(env.state.pasteChips.size, 0, "and its pasted text is gone from the panel's state, not left behind");
  assert.equal(ev.defaultPrevented, true, "the module handled the press: the browser's own word delete did not also run");
});

test("2. Ctrl+Delete just before a chip removes the chip whole, keeps the text on both sides, and clears its state", () => {
  const env = page();
  const box = setUp(env, { before: "Quote this: ", after: " and this after" });
  env.ctx.setCaretOffset(box, "Quote this: ".length);
  assert.equal(env.ctx.caretOffset(box), "Quote this: ".length, "the caret sits at the chip's left edge");

  const ev = keyAt(env, box, "Delete", { ctrl: true });

  assert.equal(env.ctx.readBox(box), "Quote this:  and this after", "Ctrl+Delete at the chip boundary removes the chip and nothing else");
  assert.equal(chipsOf(box), 0, "the chip is gone from the box");
  assert.equal(env.state.pasteChips.size, 0, "and its pasted text is gone from the panel's state");
  assert.equal(ev.defaultPrevented, true, "the module handled the press");
});

test("3. Ctrl+Backspace inside typed text removes the word before the caret, with the whitespace it owns", () => {
  const env = page();
  const box = boxFor(env);
  env.ctx.writeBox(box, "alpha beta gamma delta");
  box.focus();
  env.ctx.setCaretOffset(box, "alpha beta gamma delta".length);

  const ev = keyAt(env, box, "Backspace", { ctrl: true });

  assert.equal(env.ctx.readBox(box), "alpha beta gamma ", "Ctrl+Backspace took 'delta', exactly one word");
  assert.equal(ev.defaultPrevented, true, "the module handled the press, so the result does not depend on the engine");
});

test("4. Ctrl+Delete inside typed text removes the word after the caret, with the whitespace it owns", () => {
  const env = page();
  const box = boxFor(env);
  env.ctx.writeBox(box, "alpha beta gamma");
  box.focus();
  env.ctx.setCaretOffset(box, "alpha ".length);

  const ev = keyAt(env, box, "Delete", { ctrl: true });

  assert.equal(env.ctx.readBox(box), "alpha gamma", "Ctrl+Delete took 'beta' and its trailing space");
  assert.equal(ev.defaultPrevented, true, "the module handled the press");
});

test("5. plain Backspace beside a chip still removes that chip whole, as it always did", () => {
  const env = page();
  const box = setUp(env, { before: "Quote this: " });
  env.ctx.setCaretOffset(box, "Quote this: ".length + CHIP_TEXT.length);

  keyAt(env, box, "Backspace");

  assert.equal(env.ctx.readBox(box), "Quote this: ", "plain Backspace beside the chip removed the chip, not a character of it");
  assert.equal(chipsOf(box), 0, "the chip is gone");
  assert.equal(env.state.pasteChips.size, 0, "its state went with it");
});

test("6. plain Backspace inside text is left to the browser, characterwise", () => {
  const env = page();
  const box = boxFor(env);
  env.ctx.writeBox(box, "hello");
  box.focus();
  env.ctx.setCaretOffset(box, 5);

  const ev = keyAt(env, box, "Backspace");

  assert.equal(ev.defaultPrevented, false, "the module did not take a plain Backspace that is not beside a chip");
});

test("7. Enter is never eaten by the chip handler: app.js sends the reply with it", () => {
  const env = page();
  const box = setUp(env, { before: "Quote this: " });

  const ev = keyAt(env, box, "Enter");

  assert.equal(ev.defaultPrevented, false, "Enter reaches the composer's own handler untouched");
  assert.equal(chipsOf(box), 1, "and the chip is still there");
});

test("8. the chip's own delete control still removes exactly that chip", () => {
  const env = page();
  const box = setUp(env, { before: "Quote this: " });
  const chip = box.querySelector(".paste-chip");
  const x = chip && chip.querySelector(".pc-x");
  assert.ok(x, "the chip carries its own delete control");

  x.dispatchEvent(new env.dom.MiniEvent("click", { bubbles: true, cancelable: true }));

  assert.equal(chipsOf(box), 0, "the control removed the chip");
  assert.equal(env.ctx.readBox(box), "Quote this: ", "and nothing of the typed text");
  assert.equal(env.state.pasteChips.size, 0, "and its text left the panel's state");
});

// Chrome treats a punctuation character as a word of its own and takes the whitespace on that side with it:
// measured in a plain contenteditable at 24 shapes, and the box now reads the same in both directions.
test("9. punctuation is a word of its own, with the whitespace that side owns", () => {
  const cases = [
    { text: "alpha, beta", caret: 5, key: "Delete", want: "alphabeta", why: "Ctrl+Delete on a comma takes the comma and the space after it" },
    { text: "alpha, beta", caret: 5, key: "Backspace", want: ", beta", why: "Ctrl+Backspace before a comma takes the word before it" },
    { text: "alpha , beta", caret: 8, key: "Backspace", want: "alpha beta", why: "Ctrl+Backspace after ' ,' takes the comma and the space in front of it" },
    { text: "alpha! beta", caret: 7, key: "Backspace", want: "alphabeta", why: "Ctrl+Backspace after '! ' takes the bang and its space" },
    { text: "alpha! beta", caret: 6, key: "Delete", want: "alpha!beta", why: "Ctrl+Delete on a space takes the space alone, as Chrome does" },
  ];
  for (const c of cases) {
    const env = page();
    const box = boxFor(env);
    env.ctx.writeBox(box, c.text);
    box.focus();
    env.ctx.setCaretOffset(box, c.caret);
    keyAt(env, box, c.key, { ctrl: true });
    assert.equal(env.ctx.readBox(box), c.want, c.why);
  }
});
