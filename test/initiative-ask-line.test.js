// The initiative card's assistant row, as a contract: what the row CARRIES, what the press WRITES, and where it writes
// it. The real gestures are driven in test/e2e/initiative-ask-row.spec.mjs (a real browser, real presses); this file
// pins the three decisions that browser run cannot tell apart from a lucky one:
//
//   1. THE TITLE IS THE CARD'S, NOT THE ID'S. The row carries `data-init-title` built from `init.title` - the same
//      string the card draws in `.init-title` - and the press hands that to focusInitiativeAssistant. A row carrying
//      `init.id` would pass every screenshot and put an id in the reader's sentence.
//   2. ONE WRITER. The line is written by `startAssistantLine`, the same function the wave lane's owner chip uses:
//      `writeBox`, then an `input` event (the composer's own draft contract - public/app.js writes state.replyDrafts
//      from it), then focus and the caret at the END of readBox. A second writeBox somewhere would drift from the wave
//      chip the moment either changed.
//   3. THE PRESSED ASSISTANT'S OWN BOX. The lookup is `hostFor(own, "chat")`; `as$("as-chat")` is Assistant #1's host
//      and was the old code's answer for every assistant, so a press on #2 wrote into #1's hidden box.
//
// Nothing here asserts the sentence's punctuation beyond the template both the row and the PR ask for:
// `Question about <title>: ` - one question, the card's words, the colon and the space the caret follows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sliceBetween } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

const row = sliceBetween(assistant, "function initAssistantRowHtml(init, a) {", "// The task rows for one fold");
const chatBox = sliceBetween(assistant, "function chatBoxOf(own, thread) {", "// A SENTENCE THE READER HAS NOT FINISHED");
const startLine = sliceBetween(assistant, "function startAssistantLine(box, line) {", "// THE WAVE BAR'S OWNER CHIP");
const initiativePress = sliceBetween(assistant, "function focusInitiativeAssistant(id, thread, title) {", "// All three writes the tab makes");
const pressHandler = sliceBetween(assistant, 'if (el.dataset.initAssistant) {', 'if (el.dataset.initEdit) {');

test("the row carries the title the card shows, never the initiative's id", () => {
  assert.match(row, /const about = String\(init\.title \|\| ""\);/, "the row reads its own initiative's title");
  assert.match(row, /data-init-title="\$\{esc\(about\)\}"/, "and draws it on the button as data-init-title");
  assert.doesNotMatch(row, /data-init-title="\$\{esc\(init\.id\)\}/, "the id is never what the line will name");
  // The same string the card draws: the title span is the card's own render of init.title, so the attribute and the
  // visible words cannot disagree.
  assert.match(assistant, /<span class="init-title">\$\{esc\(init\.title\)\}<\/span>/, "the card draws init.title in .init-title");
});

test("the press hands the row's title to the opener", () => {
  assert.match(
    pressHandler,
    /focusInitiativeAssistant\(\s*String\(el\.dataset\.initAssistant\),\s*String\(el\.dataset\.initThread \|\| ""\),\s*String\(el\.dataset\.initTitle \|\| ""\),\s*\)/,
    "the assistant, its thread and the title travel together, read from the row that was pressed",
  );
});

test("the line is the PR's template, and it goes through the wave chip's own writer", () => {
  assert.match(
    initiativePress,
    /return startAssistantLine\(box, `Question about \$\{about\}: `\);/,
    "one writer, one sentence: Question about <title>: ",
  );
  assert.doesNotMatch(initiativePress, /writeBox\(/, "the opener does not write the box itself");
  // The line replaces what the box held (a second initiative is a new question), and a card with no title still opens
  // the pane without inventing words.
  assert.match(initiativePress, /const about = String\(title == null \? "" : title\)\.trim\(\);/, "the title is read once, trimmed");
  assert.match(initiativePress, /if \(!about\) \{/, "no title: open the pane and put the caret in it, with no invented line");
});

test("startAssistantLine writes, keeps the draft, focuses and puts the caret at the end", () => {
  assert.match(startLine, /writeBox\(box, line\);/, "the visible write");
  assert.match(
    startLine,
    /box\.dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/,
    "the input event public/app.js turns into state.replyDrafts - the store a repaint reads, not the DOM alone",
  );
  assert.match(startLine, /box\.focus\(\{ preventScroll: true \}\)/, "the box takes the focus");
  assert.match(
    startLine,
    /setCaretOffset\(box, readBox\(box\)\.length\)/,
    "the caret lands after the last character, so typing continues the sentence",
  );
  assert.doesNotMatch(startLine, /\b(asPost|say|fetch|post)\(/, "and nothing is sent from here");
});

test("the box asked is the pressed assistant's own, not Assistant #1's", () => {
  assert.match(chatBox, /const chat = hostFor\(own, "chat"\);/, "the pane belongs to the assistant that was pressed");
  assert.doesNotMatch(chatBox, /as\$\("as-chat"\)/, "the #1-only host lookup is gone from this path");
  // The three attempts in order: the thread's own reply box, the newest reply box the pane draws, its intro box.
  assert.match(chatBox, /\.reply-box\[data-reply="\$\{CSS\.escape\(want\)\}"\]/, "the thread's own reply box first");
  assert.match(chatBox, /querySelector\("\.reply-box\[data-reply\]"\)/, "then the newest reply box on the pane");
  assert.match(chatBox, /as\$\(firstBoxId\(own\)\)/, "then the assistant's intro box, for one nothing has been asked yet");
});

test("the wave lane's owner chip still uses the same writer", () => {
  const waveChip = sliceBetween(assistant, "function openQuestionAbout(at) {", "// A queue row is a CONSOLE row.");
  assert.match(waveChip, /return startAssistantLine\(box, `I have a question about #/, "one writer for both prefills");
  assert.doesNotMatch(waveChip, /writeBox\(/, "and no second write of its own");
});
