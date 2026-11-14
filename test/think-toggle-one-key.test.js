// The 🧠 on a card and the reasoning block under it answer to ONE value: the card's own thread.
//
// What went wrong, twice over.
//
// (1) The press wrote `wtgui.think.<thread>` from the button's `data-think-thread`, which is the CARD's thread, while
//     the block decided whether to draw itself from `turn.thread || turn.id`. On a card whose turns carry a thread of
//     their own - an assistant's turns run under a session the gateway named from the prompt, not under the panel
//     thread - or carry none at all, the press changed a key the block never read, so the button lit up and nothing
//     else moved.
// (2) The block then read the STORE under that same turn-derived value. Asking the store for `panel-assistant-5`
//     answers "nothing recorded" (its turns thought under `wtgui-continue-...`), which is why only the one assistant
//     whose session happened to match its thread ever showed any reasoning.
//
// The two questions are different and this file pins both: VISIBILITY belongs to the card (`thinkHtml`'s `thread`
// parameter, the same value the button writes), and the STORE READ belongs to the turn's own session
// (`thinkingSessionFor`). It drives the shipped `thinkHtml` and `thinkingSessionFor`, sliced out of
// public/board/console.js with their dependencies handed in, so it runs the one implementation the page runs.
import assert from "node:assert/strict";
import test from "node:test";

import { readSource, sliceBetween } from "../tools/panel-testkit.mjs";

const consoleSrc = readSource("public/board/console.js");
const renderSrc = readSource("public/render-jobs.js");
const turnsSrc = readSource("public/turns.js");
const appSrc = readSource("public/app.js");

// ---- the block's own renderer, taken from the page ------------------------------------------------
function loadThinkHtml() {
  const both = sliceBetween(consoleSrc, "function thinkingSessionFor(", "async function loadThinking(") +
    "\n" +
    sliceBetween(consoleSrc, "function thinkHtml(", "// ---- copy buttons");
  return new Function(
    "state",
    "thinkingOn",
    "turnKey",
    "thinkOpenFor",
    "turnLive",
    "paceThinkBlock",
    "linkifyText",
    "esc",
    "toBottomBtnHtml",
    `${both}\nreturn { thinkHtml, thinkingSessionFor };`,
  );
}

function bench() {
  const asked = [];
  const blocks = [{ at: 1_760_000_000_000, text: "a thought that belongs to the card" }];
  // One cached read per turn this file presses, the way a card that has been read from the store holds one.
  const ids = ["b04d91cf", "wtgui-ship-the-small-sheet-e459d1", "c093d847"];
  const state = { thinkCache: new Map(ids.map((id) => [id, { blocks, at: 0 }])), thinkOpen: new Set(), thinkClosed: new Set() };
  // Which key the block's switch is read from. The card's answer is the one the button writes; a read of any other
  // key is the defect this file exists for.
  const on = new Set();
  const thinkingOn = (thread) => {
    asked.push(String(thread));
    return on.has(String(thread));
  };
  const page = loadThinkHtml()(
    state,
    thinkingOn,
    (turn, copy = "") => `${turn.id}${copy}`,
    () => true, // the block is open
    () => false, // a finished turn
    (_turn, b) => b.text,
    (s) => s,
    (s) => String(s),
    () => "",
  );
  return { page, on, asked, blocks };
}

// The four card shapes on a real board, each with the one turn a reader presses 🧠 on. `turn` is what the renderer
// hands the body; `card` is the thread the button beside it writes.
const CARDS = [
  { name: "a turn that shares the card's thread", card: "panel-assistant-2", turn: { id: "b04d91cf", thread: "panel-assistant-2" } },
  { name: "a turn carrying no thread (its own id is the thread)", card: "wtgui-ship-the-small-sheet-e459d1", turn: { id: "wtgui-ship-the-small-sheet-e459d1" } },
  { name: "a turn carrying a thread of its own", card: "panel-assistant-5", turn: { id: "c093d847", thread: "a-session-of-its-own" } },
  { name: "the Director's turn: an assistant session, no thread on the row", card: "panel-assistant-5", turn: { id: "c093d847" } },
];

test("the 🧠 decides the block: one press on each of the four card shapes flips the block under it", () => {
  for (const { name, card, turn } of CARDS) {
    const { page, on } = bench();
    // Off: the card draws no block, whatever its turn carries.
    on.delete(card);
    assert.equal(page.thinkHtml(turn, "", card), "", `${name}: the block is drawn with the switch off`);
    // On: the same press, one key later, draws it.
    on.add(card);
    const html = page.thinkHtml(turn, "", card);
    assert.match(html, /class="think"/, `${name}: the block drawn with the switch on`);
    assert.match(html, new RegExp(`data-think-turn="${turn.id}"`), `${name}: the block keeps its own turn key`);
    // ...and the block carries the reasoning the store read put in the cache.
    assert.match(html, new RegExp("a thought that belongs to the card"), `${name}: the block draws its cached reasoning`);
  }
});

test("the block's switch is the card's thread, and only that", () => {
  for (const { name, card, turn } of CARDS) {
    const { page, asked } = bench();
    page.thinkHtml(turn, "", card);
    assert.deepEqual([...new Set(asked)], [card], `${name}: the switch is read from the card's thread (read ${asked.join(",")})`);
  }
});

test("a turn's own thread is not a second answer: the card's switch wins over it", () => {
  const turn = { id: "c093d847", thread: "a-session-of-its-own" };
  const { page, on } = bench();
  // The turn's own thread says on, the card says off: no block, because the button beside it writes the card's key.
  on.add("a-session-of-its-own");
  assert.equal(page.thinkHtml(turn, "", "panel-assistant-5"), "");
  // The card says on, the turn's own thread says off: the block is drawn, because that is the button's key.
  on.clear();
  on.add("panel-assistant-5");
  assert.match(page.thinkHtml(turn, "", "panel-assistant-5"), /class="think"/);
});

test("the store is read under the turn's own session, never the card's thread", () => {
  const { page } = bench();
  // An assistant's row: the gateway named the session, the panel thread is only a label.
  assert.equal(
    page.thinkingSessionFor({ id: "c093d847", thread: "panel-assistant-5", sessionId: "wtgui-continue-if-you-can-exit-if-062ff1" }),
    "wtgui-continue-if-you-can-exit-if-062ff1",
  );
  // A worker run: the thread IS the session (the run was started with it).
  assert.equal(page.thinkingSessionFor({ id: "40a58224", thread: "wtgui-change-the-clarify-card-2e7c16", sessionId: "wtgui-change-the-clarify-card-2e7c16" }), "wtgui-change-the-clarify-card-2e7c16");
  // A legacy row with no session recorded falls back to the thread, then to its id.
  assert.equal(page.thinkingSessionFor({ id: "abc123", thread: "some-thread" }), "some-thread");
  assert.equal(page.thinkingSessionFor({ id: "abc123" }), "abc123");
});

test("the card's thread travels from the head to the block, in the shipped renderer", () => {
  // The button writes the card's thread.
  assert.match(renderSrc, /data-think-thread="\$\{esc\(thread\)\}"/);
  // The card's render hands that same value down to the turn's body, and the body hands it to both switches.
  assert.match(renderSrc, /turnBody\(turn, copy, conv\.thread, taskLink\)/);
  assert.match(renderSrc, /function turnBody\(turn, copy = "", thread = /);
  assert.match(renderSrc, /streamBodyHtml\(turn, lines, lines\.length < all\.length, thread, [a-zA-Z]+\)/);
  assert.match(renderSrc, /thinkHtml\(turn, copy, thread\)/);
  // The block reads visibility from that parameter and nothing else.
  assert.match(consoleSrc, /function thinkHtml\(turn, copy = "", thread = /);
  assert.match(consoleSrc, /if \(!thinkingOn\(thread\)\) return "";/);
  // The store read names the turn's session.
  assert.match(consoleSrc, /\/api\/thinking\?thread=\$\{encodeURIComponent\(thinkingSessionFor\(turn\)\)\}/);
  // A poll's repaint reads the choice back from the card the block is drawn in.
  assert.match(consoleSrc, /closest\("\.job\[data-thread\]"\)\?\.dataset\.thread/);
  // The press repaints the card it came from, and the switch repaints that card rather than a lookup.
  assert.match(appSrc, /setThinking\(thread, !thinkingOn\(thread\), thinkBtn\.closest\("\.job\[data-thread\]"\)\)/);
  assert.match(turnsSrc, /function setThinking\(thread, on, card = null\)/);
  assert.match(turnsSrc, /renderConversation\(thread, \{ card \}\)/);
  assert.match(renderSrc, /function renderConversation\(thread, \{ scroll = false, card = null \} = \{\}\)/);
});
