// The 🌊 button's own tooltip, held to what the page actually draws.
//
// The stream view used to fold nothing, so the button said so ("in the order it happened, nothing folded"). The
// result boxes landed with every result folded in the stream too, and that sentence was left behind: the one place
// the page contradicted itself, and nothing failed, because a title string inside the card's header template is not
// covered by any console test. This reads the button's own markup out of public/app.js (the way tool-group-key.test.js
// reads the group key) and pins the claim: a stream still shows each result as the shut box it is everywhere else.
//
// The browser harness (tools/verify-output-boxes.mjs) proves the boxes themselves; this only holds the words the
// reader hovers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const button = () => {
  const at = src.indexOf('<button class="btn-stream');
  assert.ok(at >= 0, "public/app.js still draws the 🌊 button");
  const end = src.indexOf("</button>", at);
  assert.ok(end > at, "…and closes it");
  return src.slice(at, end);
};

const count = (s, re) => (s.match(re) || []).length;

test("the 🌊 tooltip says a stream keeps each result a folded box — both before and after it is on", () => {
  const b = button();
  assert.equal(count(b, /nothing folded/g), 0, "nothing is unfolded in a stream any more, so the tooltip must not say it is");
  assert.equal(count(b, /shut box/g), 2, "the on and off branches both say what a result is in a stream");
  assert.match(b, /aria-pressed="\$\{streamOn\(thread\) \? "true" : "false"\}"/, "and the button is still the same toggle");
});

test("the one-stream section's own comment does not claim the stream is unfolded", () => {
  const at = src.indexOf("// ---- one stream ----");
  assert.ok(at >= 0, "public/app.js still carries the one-stream section");
  const section = src.slice(at, src.indexOf("const STREAM_KEY", at));
  assert.equal(/nothing folded/.test(section), false);
  assert.match(section, /shut box/, "it says what the stream keeps folded and what it does not");
});
