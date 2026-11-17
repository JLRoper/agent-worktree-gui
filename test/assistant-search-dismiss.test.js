// The assistant search's dismissal: public/core/search-dismiss.js, and the page that wires it.
//
// WHY THIS FILE EXISTS. The results popover could only be closed by a key or by opening a row: a reader who clicked
// away kept a floating list over the card, still ringing a match they had stopped looking at. The rule has three
// edges that a handler gets wrong easily, so the predicate is a pure function here and pinned by these tests:
//
//   * a mousedown on the box, on a result row, on the list's own scrollbar or on its footer must NOT close it (a
//     click on a row still opens that row);
//   * the decision is taken on mousedown, so a drag that STARTS in the list and ends elsewhere never closes it;
//   * everything else - the transcript below, another pane of the same float, the board - closes it, while the
//     filter text stays in the box for the next keystroke.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../public/core/search-dismiss.js";

const { outside, inside } = globalThis.wtSearchDismiss;

// The two zones as the page hands them in. A real node answers `contains`; a stub with the same method answers the
// same question without a DOM, which is what keeps this a unit test.
const node = (children = []) => ({ contains: (target) => children.includes(target) });
const input = node();
const row = { id: "row" };
const footer = { id: "footer" };
const pop = node([row, footer]);
const zones = { input, pop };

test("the box and the list are the two places a mousedown belongs to the search", () => {
  assert.equal(outside(input, zones), false, "the box itself");
  assert.equal(outside(row, zones), false, "a result row: its click still opens that row");
  assert.equal(outside(footer, zones), false, "the footer is part of the list");
  assert.equal(outside(pop, zones), false, "the popover itself (its scrollbar, its padding)");
});

test("anything else is outside, including another pane of the same float", () => {
  const transcript = { id: "transcript" };
  const settingsPane = { id: "settings" };
  const board = { id: "board" };
  assert.equal(outside(transcript, zones), true, "the transcript below the list");
  assert.equal(outside(settingsPane, zones), true, "another pane of the panel counts as outside");
  assert.equal(outside(board, zones), true, "the board behind the float");
  assert.equal(outside({ id: "scope-button" }, zones), true, "the scope chip beside the box is outside the box");
});

test("a mousedown that cannot be placed does not close anything", () => {
  assert.equal(outside(null, zones), false, "a synthetic event with no target is not a dismissal");
  assert.equal(outside(undefined, zones), false);
});

test("a zone that did not arrive protects nothing, and identity still answers", () => {
  assert.equal(outside({ id: "x" }, {}), true, "no zones at all: everything is outside");
  assert.equal(outside({ id: "x" }, { input: null, pop: null }), true);
  // A node with no `contains` (a detached fragment, a bare stub) still answers for itself.
  const bare = { id: "bare" };
  assert.equal(inside(bare, bare), true);
  assert.equal(inside({ id: "x" }, bare), false);
});

// ---- the page's own use of it ---------------------------------------------------------------------------------
// A predicate the page never calls is not a dismissal. These read the wiring: the listener, the two zones, and the
// one clear that keeps the filter.
const page = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const wireAt = page.indexOf("function wireSearch");
const wireBody = wireAt >= 0 ? page.slice(wireAt, page.indexOf("\n  // ---- boot", wireAt)) : "";
const dismissAt = page.indexOf("function dismissSearch");
const dismissBody = dismissAt >= 0 ? page.slice(dismissAt, page.indexOf("// Ctrl+Q's half", dismissAt)) : "";

test("the page listens on mousedown and hands the predicate the box and the list", () => {
  assert.ok(wireBody, "wireSearch exists in public/assistant.js");
  assert.match(wireBody, /addEventListener\(\s*"mousedown"/, "the decision is made on mousedown, so a drag out of the list cannot close it");
  assert.match(wireBody, /wtSearchDismiss/, "the page uses the shared predicate");
  assert.match(wireBody, /outside\(e\.target, \{ input: as\$\("as-search-q"\), pop \}\)/, "the two zones are the box and the results panel");
});

test("closing drops the answer and leaves the filter in the box", () => {
  assert.ok(dismissBody, "dismissSearch exists in public/assistant.js");
  assert.match(dismissBody, /clearSearch\(\)/, "the hits, the highlight and the count go");
  assert.doesNotMatch(dismissBody, /clearSearchAll\(\)/, "the filter must stay, so the next keystroke asks the same question");
  assert.doesNotMatch(dismissBody, /input\.value\s*=/, "and the box's text is not rewritten");
  assert.match(dismissBody, /searchSeq \+= 1/, "an answer still in flight cannot reopen what the mousedown closed");
});

test("the page loads the dismissal module before the page that wires it", () => {
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const modAt = index.indexOf('src="/core/search-dismiss.js"');
  const assistantAt = index.indexOf('src="/assistant.js"');
  assert.ok(modAt >= 0, "public/index.html loads public/core/search-dismiss.js");
  assert.ok(assistantAt > modAt, "the module is loaded before assistant.js, which reads it");
});
