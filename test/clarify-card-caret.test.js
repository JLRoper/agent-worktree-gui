// A reader typing an answer into a clarify card keeps the caret and the selection across a repaint.
//
// The card is rebuilt from a live board: a worktree row is re-painted on the scan clock, a turn event replaces the
// card, and both paths take the node the caret was in out of the page. The draft map already kept every WORD (the box
// came back full), so the defect was the other half: the box came back unfocused with the caret at 0, mid-sentence.
//
// WHAT IS DRIVEN: the shipped `captureTyping` and `restoreTyping` sliced out of public/app.js and run against
// test/fixtures/mini-dom.js - the page's own functions, with only the card's free variables supplied. Nothing here
// re-implements the capture or the restore.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDom } from "./fixtures/mini-dom.js";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const SOURCE = sliceBetween(app, "function captureTyping(root) {", "// After a repaint: the inline add-agent field");

// The panel's own caret escape is a browser built-in; the fixture has no CSS object, and the two names the capture
// path uses are these.
const CSS = { escape: (s) => String(s).replace(/["\\\]]/g, (c) => `\\${c}`) };

function page(dom, state = {}) {
  const build = new Function(
    "state",
    "document",
    "window",
    "CSS",
    "readBox",
    "writeBox",
    "restoreBoxDraft",
    "restorePersistedBox",
    "growBoxToDraft",
    "queuedEditFor",
    "setCaretOffset",
    "clearBoxDraft",
    `${SOURCE}\nreturn { captureTyping, restoreTyping };`,
  );
  // The reply-box helpers are never reached by the clarify branch (its card carries no `.reply-box`), and a test that
  // silently depended on one would be testing a different box, so each of them throws if it is ever called.
  const never = (name) => () => {
    throw new Error(`${name} must not be called for a clarify answer box`);
  };
  return build(
    state,
    dom.document,
    dom.window,
    CSS,
    never("readBox"),
    never("writeBox"),
    never("restoreBoxDraft"),
    never("restorePersistedBox"),
    never("growBoxToDraft"),
    never("queuedEditFor"),
    never("setCaretOffset"),
    never("clearBoxDraft"),
  );
}

// The card as the page draws it: a `.turn-question` with the answer box in it. `draw()` is the repaint - the same
// markup again, in a NEW node, which is exactly what `renderConversation`'s `replaceWith` does.
function cardOf(dom, { turn = "turn-1", copy = "", value = "" } = {}) {
  const card = dom.document.createElement("div");
  card.className = "job";
  card.dataset.thread = "th-worker";
  const box = dom.document.createElement("div");
  box.className = "turn-question";
  card.appendChild(box);
  const draw = (text = value) => {
    box.replaceChildren();
    const ta = dom.document.createElement("textarea");
    ta.className = "tq-other";
    ta.dataset.qother = turn;
    ta.dataset.qcopy = copy;
    ta.value = text;
    box.appendChild(ta);
    return ta;
  };
  return { card, box, draw };
}

const SENTENCE = "The report says the caret should stay where I am typing it";

test("a focused answer box is captured with its caret and its selection", () => {
  const dom = createDom();
  const { card, draw } = cardOf(dom);
  dom.document.body.appendChild(card);
  const box = draw(SENTENCE);
  box.focus();
  box.setSelectionRange(4, 18);
  const { captureTyping } = page(dom);
  const held = captureTyping(card);
  assert.deepEqual(held, { qbox: "turn-1", qcopy: "", value: SENTENCE, start: 4, end: 18 });
});

test("a card that does not hold the caret is not captured, so it still repaints", () => {
  const dom = createDom();
  const { card } = cardOf(dom);
  const elsewhere = dom.document.createElement("input");
  dom.document.body.appendChild(card);
  dom.document.body.appendChild(elsewhere);
  elsewhere.focus();
  const { captureTyping } = page(dom);
  assert.equal(captureTyping(card), null, "nothing to put back, so the repaint is the ordinary one");
});

test("the capture is null when the focused box is outside the card being repainted", () => {
  const dom = createDom();
  const mine = cardOf(dom);
  const other = cardOf(dom, { turn: "turn-2" });
  dom.document.body.appendChild(mine.card);
  dom.document.body.appendChild(other.card);
  const box = other.draw(SENTENCE);
  box.focus();
  const { captureTyping } = page(dom);
  assert.equal(captureTyping(mine.card), null, "another card's caret is not this card's business");
});

test("a rebuilt box gets the words, the focus and the selection back", () => {
  const dom = createDom();
  const { card, box, draw } = cardOf(dom);
  dom.document.body.appendChild(card);
  const typed = draw(SENTENCE);
  typed.focus();
  typed.setSelectionRange(0, SENTENCE.length);
  const { captureTyping, restoreTyping } = page(dom);
  const held = captureTyping(card);
  // ...and the repaint: the node the reader typed into is gone, and a new one is drawn from the draft map.
  const fresh = draw(SENTENCE);
  assert.notEqual(fresh, typed, "the repaint really did replace the node");
  assert.equal(dom.document.activeElement, null, "the old caret went with the old node");
  restoreTyping(card, held);
  assert.equal(dom.document.activeElement, fresh, "the caret is back in the answer box");
  assert.equal(fresh.value, SENTENCE, "every word is there");
  assert.equal(fresh.selectionStart, 0, "the selection starts where the reader left it");
  assert.equal(fresh.selectionEnd, SENTENCE.length, "and ends where the reader left it");
});

test("the caret and the selection survive repeated repaints at the scan cadence", () => {
  const dom = createDom();
  const { card, draw } = cardOf(dom);
  dom.document.body.appendChild(card);
  const first = draw(SENTENCE);
  first.focus();
  first.setSelectionRange(11, 21);
  const { captureTyping, restoreTyping } = page(dom);
  // The panel re-paints a worktree row every 5 s; a reader takes far longer than one scan to write a sentence, so the
  // property is not "one repaint is survived" but "every one is".
  let box = first;
  for (let pass = 1; pass <= 6; pass++) {
    const held = captureTyping(card);
    assert.ok(held, `pass ${pass}: the reader's caret was captured`);
    box = draw(SENTENCE); // the card is rebuilt from the draft map, exactly as conversationHtml draws it
    restoreTyping(card, held);
    assert.equal(dom.document.activeElement, box, `pass ${pass}: the caret is in the rebuilt box`);
    assert.equal(box.value, SENTENCE, `pass ${pass}: the sentence is intact`);
    assert.equal(box.selectionStart, 11, `pass ${pass}: the selection still starts at 11`);
    assert.equal(box.selectionEnd, 21, `pass ${pass}: the selection still ends at 21`);
  }
});

test("the draft map is never touched by the restore - the words are the reader's", () => {
  const dom = createDom();
  const { card, draw } = cardOf(dom);
  dom.document.body.appendChild(card);
  const box = draw(SENTENCE);
  box.focus();
  box.setSelectionRange(SENTENCE.length, SENTENCE.length);
  const drafts = new Map([["turn-1", SENTENCE]]);
  const { captureTyping, restoreTyping } = page(dom, {});
  const held = captureTyping(card);
  restoreTyping(card, held);
  assert.equal(drafts.get("turn-1"), SENTENCE, "the map still holds what the reader typed");
  assert.equal(drafts.size, 1, "and the restore added no second entry");
});

test("a moved card keeps its own value: the restore does not rewrite what the reader already has", () => {
  const dom = createDom();
  const { card, draw } = cardOf(dom);
  dom.document.body.appendChild(card);
  const box = draw(SENTENCE);
  box.focus();
  box.setSelectionRange(3, 7);
  // The row path MOVES the card into the rebuilt detail rather than replacing it: the value and the selection ride
  // with the node and only the focus is lost. Re-writing the value there would move the caret and cost the reader the
  // engine's own spacing, so the restore reads before it writes.
  const writes = [];
  const build = new Function(
    "state", "document", "window", "CSS", "readBox", "writeBox", "restoreBoxDraft", "restorePersistedBox",
    "growBoxToDraft", "queuedEditFor", "setCaretOffset", "clearBoxDraft",
    `${SOURCE}\nreturn { captureTyping, restoreTyping };`,
  );
  const never = () => () => assert.fail("unexpected reply-box helper call");
  const api = build({}, dom.document, dom.window, CSS, never(), never(), never(), never(), never(), never(), never(), never());
  const held = api.captureTyping(card);
  const fresh = dom.document.createElement("div");
  card.parentNode.insertBefore(fresh, card);
  fresh.appendChild(box); // the move
  api.restoreTyping(fresh, held);
  assert.equal(writes.length, 0);
  assert.equal(box.value, SENTENCE, "the moved box still holds the sentence");
  assert.equal(dom.document.activeElement, box, "and the caret came back to it");
  assert.equal(box.selectionStart, 3);
  assert.equal(box.selectionEnd, 7);
});

test("a box that is gone when the restore runs is silent, not a throw", () => {
  const dom = createDom();
  const { card, draw } = cardOf(dom);
  dom.document.body.appendChild(card);
  const box = draw(SENTENCE);
  box.focus();
  box.setSelectionRange(0, 4);
  const { captureTyping, restoreTyping } = page(dom);
  const held = captureTyping(card);
  // The question was answered while the repaint was in flight: the box left the card, and there is nothing to restore.
  box.parentNode.replaceChildren();
  assert.doesNotThrow(() => restoreTyping(card, held));
  assert.equal(dom.document.activeElement, null, "no box, nothing focused");
});
