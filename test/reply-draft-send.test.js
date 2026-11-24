// THE SENT DRAFT STAYS SENT, in-process: the ONE clear a send makes (`clearSentDraft`, public/app.js) covers
// every store a draft lives in - the map, the paste-chip mirror and the box's DOM - keyed on the thread the BOX is
// bound to, and it leaves a draft the reader has typed since exactly where it is.
//
// WHAT IS DRIVEN: the shipped `clearSentDraft` sliced out of public/app.js and run against test/fixtures/mini-dom.js
// with only its free variables supplied (state, document, CSS, readBox, writeBox, forgetReplyDraft). Nothing here
// re-implements the clear. The chip serialization itself is proved in a real browser by
// tools/verify-reply-draft-send.mjs; this test supplies the plain-text half of the same read/write contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDom } from "./fixtures/mini-dom.js";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const SOURCE = sliceBetween(app, "function clearSentDraft(thread", "// Typing state inside a card");

const CSS = { escape: (s) => String(s).replace(/["\\\]]/g, (c) => `\\${c}`) };
const THREAD = "wtgui-thread-under-test-1111aa";

function page(dom, over = {}) {
  const state = {
    replyDrafts: {},
    replyNav: new Map(),
    justSent: new Map(),
    ...over,
  };
  const cleared = [];
  const build = new Function(
    "state",
    "document",
    "CSS",
    "readBox",
    "writeBox",
    "forgetReplyDraft",
    `${SOURCE}\nreturn { clearSentDraft };`,
  );
  const api = build(
    state,
    dom.document,
    CSS,
    // The plain half of the module's contract: a box's text is its content.
    (box) => (box ? String(box.textContent || "") : ""),
    (box, text) => box.replaceChildren(...(text ? [dom.document.createTextNode(String(text))] : [])),
    (thread) => {
      cleared.push(thread);
      return true;
    },
  );
  return { ...api, state, cleared };
}

// A reply box as the renderer draws it: the class the querySelector looks for, and its own bound thread.
function boxOf(dom, thread, text) {
  const el = dom.document.createElement("div");
  el.className = "reply-box chipbox";
  el.dataset.reply = thread;
  el.dataset.chipbox = `reply:${thread}`;
  if (text) el.replaceChildren(dom.document.createTextNode(text));
  dom.document.body.appendChild(el);
  return el;
}

test("the clear empties the map, the box and the mirror for the thread the box is bound to", () => {
  const dom = createDom();
  const p = page(dom);
  p.state.replyDrafts[THREAD] = "the words that went out";
  p.state.replyNav.set(THREAD, { back: 2 });
  const box = boxOf(dom, THREAD, "the words that went out");
  assert.equal(p.clearSentDraft(THREAD, "the words that went out", box), true);
  assert.equal(p.state.replyDrafts[THREAD], "", "the draft map is emptied, not left holding the sent words");
  assert.equal(p.cleared.length, 1, "the paste-chip mirror is cleared");
  assert.equal(p.cleared[0], THREAD, "by the thread the mirror is keyed on");
  assert.equal(box.textContent, "", "and the box itself is empty");
  assert.equal(p.state.replyNav.has(THREAD), false, "the history walk ends with the send");
  const sent = p.state.justSent.get(THREAD);
  assert.equal(sent.text, "the words that went out", "the just-sent record names the text, for a repaint's snapshot");
  assert.ok(sent.at > 0);
});

test("the thread comes from the BOX, never from a name the send path happens to hold", () => {
  const dom = createDom();
  const p = page(dom);
  const box = boxOf(dom, THREAD, "sent from this box");
  p.state.replyDrafts[THREAD] = "sent from this box";
  p.state.replyDrafts["a-stale-name"] = "someone else's draft";
  // The clear is handed a different name (a thread renamed as a run settled), and the box's own is what counts.
  p.clearSentDraft("a-stale-name", "sent from this box", box);
  assert.equal(p.state.replyDrafts[THREAD], "", "the bound thread's draft is the one cleared");
  assert.equal(p.state.replyDrafts["a-stale-name"], "someone else's draft", "another thread's draft is untouched");
  assert.deepEqual(p.cleared, [THREAD], "the mirror clear follows the box too");
  assert.equal(box.textContent, "");
});

test("a box holding something the reader typed since keeps it, map and mirror included", () => {
  const dom = createDom();
  const p = page(dom);
  const box = boxOf(dom, THREAD, "the NEXT message, typed while the POST was open");
  p.state.replyDrafts[THREAD] = "the NEXT message, typed while the POST was open";
  assert.equal(p.clearSentDraft(THREAD, "the held reply that went out", box), false);
  assert.equal(box.textContent, "the NEXT message, typed while the POST was open", "the reader's newer draft stays");
  assert.equal(p.state.replyDrafts[THREAD], "the NEXT message, typed while the POST was open", "and stays the panel's draft");
  assert.deepEqual(p.cleared, [], "its chips are not dropped either");
  assert.equal(p.state.justSent.get(THREAD).text, "the held reply that went out", "the just-sent record is still written");
});

test("with no box on the page the mirror is still cleared by the thread", () => {
  const dom = createDom();
  const p = page(dom);
  p.state.replyDrafts[THREAD] = "sent from a card that has been rebuilt away";
  // The card was rebuilt, moved or folded away for the length of the POST: nothing to query, nothing to write.
  assert.equal(p.clearSentDraft(THREAD, "sent from a card that has been rebuilt away", null), true);
  assert.deepEqual(p.cleared, [THREAD], "the mirror is keyed on the thread, so a missing box cannot leave it behind");
  assert.equal(p.state.replyDrafts[THREAD], "");
});

test("every box for the thread is cleared, including a copy the page has already detached", () => {
  const dom = createDom();
  const p = page(dom);
  const live = boxOf(dom, THREAD, "sent words");
  const moved = boxOf(dom, THREAD, "sent words");
  // The duplicate the sweep drops: the same thread drawn twice, one copy out of the document.
  dom.document.body.removeChild(moved);
  assert.equal(p.clearSentDraft(THREAD, "sent words", moved), true);
  assert.equal(live.textContent, "", "the copy on the page is emptied too");
  assert.equal(moved.textContent, "", "and so is the node the send started with");
});
