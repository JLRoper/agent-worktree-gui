// The 🧠 on a card and the reasoning rows of its console answer to ONE value: the card's own thread.
//
// What went wrong, twice over.
//
// (1) The press wrote `wtgui.think.<thread>` from the button's `data-think-thread`, which is the CARD's thread, while
//     the reasoning decided whether to draw itself from `turn.thread || turn.id`. On a card whose turns carry a thread
//     of their own - an assistant's turns run under a session the gateway named from the prompt, not under the panel
//     thread - or carry none at all, the press changed a key the rows never read, so the button lit up and nothing
//     else moved.
// (2) The store was then read under that same turn-derived value. Asking the store for `panel-assistant-5` answers
//     "nothing recorded" (its turns thought under `wtgui-continue-...`), which is why only the one assistant whose
//     session happened to match its thread ever showed any reasoning.
//
// The two questions are different and this file pins both: VISIBILITY belongs to the card (`streamBodyHtml`'s
// `thread` parameter, the same value the button writes), and the STORE READ belongs to the turn's own session
// (`thinkingSessionFor`). It drives the shipped renderer, sliced out of public/render-jobs.js with its dependencies
// handed in, so it runs the one implementation the page runs.
import assert from "node:assert/strict";
import test from "node:test";

import { readSource, sliceBetween } from "../tools/panel-testkit.mjs";

const consoleSrc = readSource("public/board/console.js");
const renderSrc = readSource("public/render-jobs.js");
const turnsSrc = readSource("public/turns.js");
const appSrc = readSource("public/app.js");
const indexSrc = readSource("public/index.html");

// ---- the stream's body, taken from the page ------------------------------------------------------
function loadStreamBody() {
  const region = sliceBetween(renderSrc, "function streamBodyHtml(", "\nfunction mdRunHtml(");
  const make = new Function(
    "thinkingOn",
    "state",
    "lineHtml",
    "consoleMdIsProse",
    "toolGroupHtml",
    "mdRunHtml",
    "TOOL_DONE_RE",
    "paceThinkBlock",
    "globalThis",
    `${region}\nreturn streamBodyHtml;`,
  );
  return (deps) => make(...deps);
}

const T0 = 1_760_000_000_000;

function bench({ thinking, previews = false, blocks = [] }) {
  const asked = [];
  const merged = [];
  const paced = [];
  const W = {
    merge(lines, list, opts) {
      merged.push({ lines: [...lines], blocks: [...list], opts });
      // A block goes at the end for this bench: what matters is that it was handed to the merge at all.
      return [...lines, ...list.map((b) => ({ kind: "think", text: b.text, at: b.at, lid: `think:${b.at}` }))];
    },
    pieces: (items) => items.map((line, i) => ({ line, sep: i > 0 })),
  };
  const state = { thinkCache: new Map(), codeBoxOpen: new Set() };
  const turn = { id: "c093d847" };
  const lines = [{ kind: "text", text: "the answer", at: T0, lid: "l1" }];
  if (previews) lines.push({ kind: "think", text: "still thinking", at: T0 + 10, lid: "think:…", preview: true, live: true });
  state.thinkCache.set(turn.id, { blocks, at: 0 });
  const body = loadStreamBody()([
    (thread) => {
      asked.push(String(thread));
      return thinking;
    },
    state,
    (l) => (l.kind === "think" ? `THINK:${l.text}` : `LINE:${l.text}`),
    () => false,
    () => "GROUP",
    () => "MD",
    /↳ (\w+)/,
    (_turn, b) => {
      paced.push(b);
      return null;
    },
    { wtStream: W },
  ]);
  const html = body(turn, lines, false, "panel-assistant-5", null);
  return { html, asked, merged, paced };
}

const blocks = [{ at: T0 + 5, text: "a thought that belongs to the card" }];

test("the 🧠 decides the reasoning rows: off draws none, on draws them in the stream", () => {
  const off = bench({ thinking: false, blocks });
  assert.doesNotMatch(off.html, /THINK:/, "no reasoning row with the switch off");
  assert.match(off.html, /LINE:the answer/, "the console itself is still drawn");

  const on = bench({ thinking: true, blocks });
  assert.match(on.html, /THINK:a thought that belongs to the card/, "the reasoning is a row of the console");
  assert.match(on.html, /LINE:the answer/);
});

test("the rows' switch is the card's thread, and only that", () => {
  const { asked } = bench({ thinking: true, blocks });
  assert.deepEqual([...new Set(asked)], ["panel-assistant-5"], "the switch is read from the card's thread");
});

test("a live preview is drawn from the record and the store is NOT merged beside it", () => {
  const live = bench({ thinking: true, previews: true, blocks });
  assert.match(live.html, /THINK:still thinking/, "the preview row is drawn");
  assert.equal(live.merged.length, 0, "the store's blocks do not join a turn that already has preview rows");
  assert.equal(live.paced.length, 0, "a live preview is never re-typed from its first word");
});

test("with no preview the settled blocks are merged by at and paced", () => {
  const settled = bench({ thinking: true, blocks });
  assert.equal(settled.merged.length, 1, "the store's blocks are merged into the record");
  assert.deepEqual(settled.merged[0].blocks, blocks);
  assert.equal(settled.merged[0].opts.hidePreviews, true, "the old one-line dim preview is dropped beside a whole block");
  assert.deepEqual(settled.paced, blocks, "a settled block is fed to the pacer under its own lid");
});

test("the store is read under the turn's own session, never the card's thread", () => {
  const region = sliceBetween(consoleSrc, "function thinkingSessionFor(", "// ---- reconcile thinking ----");
  const make = new Function(`${region}\nreturn thinkingSessionFor;`);
  const thinkingSessionFor = make();
  // An assistant's row: the gateway named the session, the panel thread is only a label.
  assert.equal(
    thinkingSessionFor({ id: "c093d847", thread: "panel-assistant-5", sessionId: "wtgui-continue-if-you-can-exit-if-062ff1" }),
    "wtgui-continue-if-you-can-exit-if-062ff1",
  );
  // A worker run: the thread IS the session (the run was started with it).
  assert.equal(thinkingSessionFor({ id: "40a58224", thread: "wtgui-change-the-clarify-card-2e7c16" }), "wtgui-change-the-clarify-card-2e7c16");
  // A legacy row with no session recorded falls back to the thread, then to its id.
  assert.equal(thinkingSessionFor({ id: "abc123", thread: "some-thread" }), "some-thread");
  assert.equal(thinkingSessionFor({ id: "abc123" }), "abc123");
});

test("the card's thread travels from the head to the stream, in the shipped renderer", () => {
  // The button writes the card's thread.
  assert.match(renderSrc, /data-think-thread="\$\{esc\(thread\)\}"/);
  // The card's render hands that same value down to the turn's body, and the body hands it to the stream.
  assert.match(renderSrc, /turnBody\(turn, copy, conv\.thread, taskLink\)/);
  assert.match(renderSrc, /function turnBody\(turn, copy = "", thread = /);
  assert.match(renderSrc, /streamBodyHtml\(turn, lines, lines\.length < all\.length, thread, taskLink\)/);
  assert.match(renderSrc, /const thinking = thinkingOn\(thread\);/);
  // There is no second renderer and no pane to hand it to.
  assert.doesNotMatch(renderSrc, /thinkHtml\(/);
  assert.doesNotMatch(consoleSrc, /function thinkHtml\(/);
  assert.doesNotMatch(consoleSrc, /details\.think/);
  // The store read names the turn's session.
  assert.match(consoleSrc, /\/api\/thinking\?thread=\$\{encodeURIComponent\(thinkingSessionFor\(turn\)\)\}/);
  // The live append reads the switch from the card the console is in.
  assert.match(consoleSrc, /function cardThreadOf\(id\)/);
  assert.match(consoleSrc, /closest\?\.\("\.job\[data-thread\]"\)/);
  // The press repaints the card it came from, and the switch repaints that card rather than a lookup.
  assert.match(appSrc, /setThinking\(thread, !thinkingOn\(thread\), thinkBtn\.closest\("\.job\[data-thread\]"\)\)/);
  assert.match(turnsSrc, /function setThinking\(thread, on, card = null\)/);
  assert.match(turnsSrc, /renderConversation\(thread, \{ card \}\)/);
  assert.match(renderSrc, /function renderConversation\(thread, \{ scroll = false, card = null \} = \{\}\)/);
});

test("the separate pane and its two switches are gone from the page", () => {
  for (const name of ["stream-default", "show-stream-button", "data-stream-thread", "btn-stream"]) {
    assert.equal(indexSrc.includes(name), false, `${name} is not a setting or a control any more`);
  }
  assert.doesNotMatch(turnsSrc, /function streamOn\(/);
  assert.doesNotMatch(turnsSrc, /function setStreamMode\(/);
  assert.doesNotMatch(appSrc, /streamOn\(/);
});
