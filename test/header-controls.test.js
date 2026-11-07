// The header's three named controls, and where Pause lives.
//
// The board's header carries three named controls side by side: Assistant, Human and Deliverables. They used to
// speak in two registers - a Title Case name behind a sparkle, beside two SHOUTED tags - so the pair read as a
// different kind of control from the one next to it. One shape now: a leading glyph, a space, and Title Case.
//
// Pause was the fourth control in that row, and it is not a header gesture: it freezes the board's own reads, and
// the rows that govern those reads (the folders the board scans, Read now, and the bundle re-read on the Bundles
// tab) live in Settings. It moved there, and the handler did not change - the press is found by id, so the markup
// moved and the behaviour did not. Both halves are pinned here, because no browser gate names Pause: the shipped
// gates read the labels the page draws, and a later landing could move the markup back with every one of them
// still green.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const headerBlock = () => {
  const found = html.match(/<header class="topbar">[\s\S]*?<\/header>/);
  assert.ok(found, "the header is still in index.html");
  return found[0];
};

test("the three named header controls share one label shape: a leading glyph and Title Case", () => {
  const assistant = html.match(/<button id="btn-assistant"[^>]*>([\s\S]*?)<span id="assistant-badge"/);
  const human = html.match(/<span id="human-label">([^<]*)<\/span>/);
  const deliver = html.match(/<span id="deliver-label">([^<]*)<\/span>/);
  assert.ok(assistant, "no #btn-assistant");
  assert.ok(human, "no #human-label");
  assert.ok(deliver, "no #deliver-label");

  // The precedent, then the two that now match it. Exact strings: a "cleaned up" label that drops the glyph, or
  // one that goes back to caps, has to change this line and say why.
  assert.equal(assistant[1].trim(), "✧ Assistant", "the precedent: a sparkle, a space, Title Case");
  assert.equal(human[1].trim(), "🙋 Human", "Human is drawn the way Assistant is");
  assert.equal(deliver[1].trim(), "📦 Deliverables", "Deliverables is drawn the way Assistant is");

  for (const [name, text] of [["assistant", assistant[1]], ["human", human[1]], ["deliver", deliver[1]]]) {
    const label = text.trim();
    // The `u` flag matters: the human and deliver glyphs are astral code points, and without it `\S` matches one
    // UTF-16 surrogate at a time and the space assertion fails on a label that is drawn correctly.
    assert.match(label, /^\S\s[A-Z][a-z]/u, `${name} leads with one glyph, a space and a Title Case word`);
    assert.doesNotMatch(label.replace(/^\S+\s*/u, ""), /[A-Z]{2,}/, `${name} carries no SHOUTED word`);
  }
});

test("Pause is out of the header and in Settings, beside the rows it freezes", () => {
  assert.doesNotMatch(headerBlock(), /id="btn-pause"/, "the header no longer carries the pause control");
  assert.equal((html.match(/id="btn-pause"/g) || []).length, 1, "one pause control on the page, not two");

  // The Board group is the tab panel between its own opener and the next group's.
  const board = html.slice(html.indexOf('id="settings-panel-board"'), html.indexOf('id="settings-panel-repo"'));
  assert.ok(board.length > 2000, "the Board group is still the block between those two panels");
  const at = board.indexOf('id="btn-pause"');
  assert.ok(at > 0, "#btn-pause sits in Settings' Board group");
  assert.ok(board.indexOf('id="scan-roots-row"') < at, "after the folders the board scans");
  assert.ok(board.indexOf('id="board-now-row"') < at, "after Read now (Refresh now / Fetch remotes)");
  assert.ok(at < board.indexOf('for="reorder-every"'), "before the board's own reorder row");
  assert.match(board.slice(Math.max(0, at - 1200), at), /id="pause-row"/, "the control has a settings row of its own");
  assert.match(html, /<button id="btn-pause" type="button" aria-pressed="false"/, "it ships unpressed, and says so for AT");
  assert.match(html, /id="pause-row" title="[^"]*live stream[^"]*"/, "the row's title says what the press freezes");
});

test("the moved control keeps its handler: one press closes the stream, the next reconnects", () => {
  const bound = app.indexOf('$("btn-pause")?.addEventListener("click"');
  assert.ok(bound > 0, "the press is bound by id, which is what let the markup move");
  const handler = app.slice(bound, bound + 700);
  assert.match(handler, /state\.paused = !state\.paused/, "a press flips the flag");
  assert.match(handler, /paintPauseButton\(\)/, "the button is repainted from that flag");
  assert.match(handler, /state\.es\?\.close\(\)/, "pausing closes the live stream");
  assert.match(handler, /setStream\("paused", "warn"\)/, "…and the status line says paused");
  assert.match(handler, /connect\(\)/, "resuming reconnects");
  assert.match(handler, /resync\(\)/, "…and re-syncs the board");

  // The label, the pressed state and the title are one paint, so a reader who closes Settings and opens it again
  // reads the same answer, and the tooltip never promises the gesture the button no longer does.
  const paint = app.slice(app.indexOf("function paintPauseButton()"), app.indexOf("function paintPauseButton()") + 800);
  assert.match(paint, /textContent = state\.paused \? "Resume" : "Pause"/, "the label says which way the next press goes");
  assert.match(paint, /aria-pressed", state\.paused \? "true" : "false"/, "…and the pressed state follows it");
  assert.match(paint, /btn\.title = state\.paused/, "…and so does the tooltip");
  assert.match(app, /\n\$\("btn-pause"\)\?\.addEventListener[\s\S]*?\r?\n\}\);\r?\npaintPauseButton\(\);/, "the paint runs once at boot for a page that starts unpaused");
});
