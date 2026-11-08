// What the page says about a turn another assistant's message started.
//
// The store writes the turn's card line as "message from <name>: <request>", so drawn as-is the head spends its one
// line naming the sender - and this was the one origin with no chip at all, while a watchdog turn and an
// assistant-wake turn both wear one. The chip carries the sender's own name in the same purple .turn-origin box the
// assistant attribution wears, its tooltip names the sender and the thread, and the head text drops the opener the
// way watchdogPromptText drops its own, so the request starts the line.
//
// Read out of the page and run with no browser, like test/watchdog-turn-chip.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sliceRegion, sliceBetween } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/turns.js", import.meta.url), "utf8");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const region = sliceRegion(src, "turn origin");
// Name the anchor inside the region before asserting on it: a failure then says the code left its section rather
// than that a class vanished.
assert.match(region, /function messageHtml\(turn\) \{/, "messageHtml is not in the turn origin section");
assert.match(region, /function messagePromptText\(text, turn\) \{/, "messagePromptText is not in the turn origin section");

// displayPrompt and the head's inline line live below the region; both are read from the file rather than copied,
// so this pins what the page draws and not a paraphrase of it.
const display = sliceBetween(src, "const ATTACH_BLOCK_RE", "// What the reader attached to this turn");
const inline = sliceBetween(src, "function inlinePrompt(turn, inline) {", "// One turn: its head, then either");
const { originHtml, displayPrompt, messagePromptText, inlinePrompt } = new Function(
  "esc",
  `${region}; ${display}; ${inline}; return { originHtml, displayPrompt, messagePromptText, inlinePrompt };`,
)(esc);

// The store's own shape: the MESSAGE line in lib/assistant.js writes `display: "message from <name>: <text>"`, which
// lib/jobs.js keeps as the turn's `prompt`, and the origin it records beside it.
const MESSAGE = {
  id: "8f21c4aa",
  thread: "panel-assistant",
  prompt: "message from Assistant #2: the reader's screenshot is on your turn - start a worker to read it.",
  origin: { kind: "assistant-message", from: "assistant-2", name: "Assistant #2", id: "assistant-2", thread: "panel-assistant-2", reason: "the reader's screenshot is on your turn" },
};

const words = (html) => html.replace(/<[^>]*>/g, "").trim();

test("a message turn wears the purple chip, reading the sender's own name", () => {
  const html = originHtml(MESSAGE);
  assert.match(html, /class="turn-origin mono"/, "the chip reuses the .turn-origin box");
  assert.doesNotMatch(html, /is-watchdog/, "a message is not the watchdog's dark chip");
  assert.equal(words(html), "Assistant #2", "the chip reads the sender's own name and nothing else");
  // The request is not drawn on the chip: it lives in the head text, once.
  assert.doesNotMatch(words(html), /screenshot/);
});

test("the tooltip names the sender and the thread", () => {
  const title = /title="([^"]*)"/.exec(originHtml(MESSAGE))[1];
  assert.match(title, /Assistant #2/, "the sender's name is in the tooltip");
  assert.match(title, /assistant-2/, "the sender's id is in the tooltip");
  assert.match(title, /panel-assistant-2/, "the thread it was written on is in the tooltip");
});

test("the head text drops the opener, so the request starts the line", () => {
  assert.equal(
    displayPrompt(MESSAGE.prompt, MESSAGE),
    "the reader's screenshot is on your turn - start a worker to read it.",
  );
  assert.doesNotMatch(displayPrompt(MESSAGE.prompt, MESSAGE), /^message from/);
  // The head draws exactly that line: the same text, with no opener in front of it.
  const head = inlinePrompt(MESSAGE, true);
  assert.match(head, /class="turn-prompt-inline"/);
  assert.match(words(head), /^the reader's screenshot is on your turn/);
  assert.doesNotMatch(words(head), /message from Assistant #2:/);
  // Only at the START: a request that mentions the format mid-sentence keeps its words.
  assert.equal(messagePromptText("why is it message from Assistant #2: here", MESSAGE), "why is it message from Assistant #2: here");
});

test("the opener is dropped only on a turn the origin says a message started", () => {
  // A reader's own request that happens to begin with the same words is untouched: no origin, no strip.
  const reader = { id: "1a2b3c4d", thread: "panel-assistant", prompt: "message from the build box: it failed", origin: null };
  assert.equal(displayPrompt(reader.prompt, reader), "message from the build box: it failed");
  assert.equal(originHtml(reader), "", "and it draws no chip");
  // A message turn whose recorded name has moved on since the line was written still loses the opener.
  const renamed = { ...MESSAGE, origin: { ...MESSAGE.origin, name: "Assistant #2 (renamed)" } };
  assert.equal(displayPrompt(MESSAGE.prompt, renamed), "the reader's screenshot is on your turn - start a worker to read it.");
  // A message turn with no opener in its line keeps every word of it.
  const bare = { ...MESSAGE, prompt: "the reader's screenshot is on your turn" };
  assert.equal(displayPrompt(bare.prompt, bare), "the reader's screenshot is on your turn");
});

test("a turn stored before the name was recorded still chips, by its id and its own thread", () => {
  const old = {
    id: "0d9e8f7a",
    thread: "panel-assistant",
    prompt: "message from assistant-2: read the map",
    origin: { kind: "assistant-message", from: "assistant-2" },
  };
  const html = originHtml(old);
  assert.match(html, /class="turn-origin mono"/);
  assert.equal(words(html), "assistant-2", "the id is the name when no name was stored");
  const title = /title="([^"]*)"/.exec(html)[1];
  assert.match(title, /assistant-2/);
  assert.match(title, /panel-assistant/, "the turn's own thread is named when the origin carries none");
  assert.equal(displayPrompt(old.prompt, old), "read the map");
});

test("nothing from the origin is trusted as markup", () => {
  const html = originHtml({ ...MESSAGE, origin: { ...MESSAGE.origin, name: '<script>alert(1)</script>' } });
  assert.doesNotMatch(html, /<script>/);
  assert.match(words(html), /&lt;script&gt;/, "the name is drawn as text, escaped");
  assert.match(/title="([^"]*)"/.exec(html)[1], /&lt;script&gt;/, "and so is the tooltip");
});
