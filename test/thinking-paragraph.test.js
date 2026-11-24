// The minimized text of a thought: its FIRST SECTION, cut at the first blank line, and the shapes that would bite.
//
// public/board/console.js is a classic script, so this drives the shipped region against a vm context the way
// reasoning-delta-pane.test.js does. The browser half - what a real row draws, the four-line lid's measured cut, and
// the expand round-trip - is tools/verify-think-paragraph.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const consoleSrc = read("public/board/console.js");

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CRLF = CR + LF;

const sliceBetween = (src, a, b) => {
  const begin = src.indexOf(a);
  const end = src.indexOf(b, begin + a.length);
  assert.ok(begin > 0 && end > begin, `${a} .. ${b} is in the source`);
  return src.slice(begin, end);
};

function loadSection() {
  const region = sliceBetween(consoleSrc, "// ---- a thought's first section", "// The markup of one thinking row.");
  const make = new vm.Script(`(function(){ ${region}; return { thinkSection, THINK_DOTS }; })`).runInThisContext();
  return make();
}

test("three paragraphs: the minimized text is the first paragraph, and more is hidden", () => {
  const { thinkSection, THINK_DOTS } = loadSection();
  assert.equal(THINK_DOTS, "....", "four dots, his delimiter");
  const text = ["First I read the row.", "Then I read the code.", "At the end I can say what changed."].join(LF + LF);
  const sec = thinkSection(text);
  assert.equal(sec.head, "First I read the row.");
  assert.equal(sec.hidden, true, "two paragraphs follow, so the row ends in dots");
});

test("one paragraph shorter than the lid carries no dots", () => {
  const { thinkSection } = loadSection();
  const sec = thinkSection("One thought, one line, nothing after it.");
  assert.equal(sec.head, "One thought, one line, nothing after it.");
  assert.equal(sec.hidden, false, "a fully shown thought carries no dots");
});

test("CRLF: a CRLF blank line is still a blank line, and the CR is not content", () => {
  const { thinkSection } = loadSection();
  const sec = thinkSection("first" + CRLF + CRLF + "second");
  assert.equal(sec.head, "first", "no stray CR survives into the first section");
  assert.equal(sec.hidden, true);
});

test("a lone newline is not a blank line, so the section continues", () => {
  const { thinkSection } = loadSection();
  const sec = thinkSection("line one" + LF + "line two");
  assert.equal(sec.head, "line one" + LF + "line two");
  assert.equal(sec.hidden, false);
});

test("a blank line carrying spaces still delimits", () => {
  const { thinkSection } = loadSection();
  const sec = thinkSection("first" + LF + "   " + LF + "second");
  assert.equal(sec.head, "first");
  assert.equal(sec.hidden, true, "the spaces-only line is a delimiter, and second is hidden");
});

test("leading blank lines are skipped, so the first section is never empty", () => {
  const { thinkSection } = loadSection();
  const sec = thinkSection(LF + LF + "the thought opens late" + LF + LF + "and continues here");
  assert.equal(sec.head, "the thought opens late", "a thought that OPENS with a blank line still has words");
  assert.equal(sec.hidden, true);
  assert.equal(thinkSection(LF + LF).head, "", "a thought of blank lines only has no section, and hides nothing");
  assert.equal(thinkSection(LF + LF).hidden, false);
});

test("trailing blank lines are not hidden content, so the row keeps no dots", () => {
  const { thinkSection } = loadSection();
  for (const tail of [LF + LF, LF + "   " + LF, CRLF + CRLF]) {
    const sec = thinkSection("the whole thought" + tail);
    assert.equal(sec.head, "the whole thought");
    assert.equal(sec.hidden, false, "trailing blanks hide nothing");
  }
});

test("a blank line inside a fenced code block is not a delimiter: the section keeps the closing fence", () => {
  const { thinkSection } = loadSection();
  const text = ["Intro sentence.", "```js", "const a = 1;", "", "const b = 2;", "```", "", "After the fence."].join(LF);
  const sec = thinkSection(text);
  assert.equal(sec.head, ["Intro sentence.", "```js", "const a = 1;", "", "const b = 2;", "```"].join(LF), "the fence comes through whole");
  assert.equal(sec.hidden, true, "the paragraph after the fence is hidden, and the cut happens after the close");
});

test("a fence that never closes keeps the whole thought rather than showing half a fence", () => {
  const { thinkSection } = loadSection();
  const text = ["Intro.", "```", "a", "", "b"].join(LF);
  const sec = thinkSection(text);
  assert.equal(sec.head, text);
  assert.equal(sec.hidden, false);
  const onlyFence = "```" + LF + "a" + LF + LF + "b" + LF + "```";
  assert.equal(thinkSection(onlyFence).head, onlyFence, "a fence that opens the thought is a section of its own");
});

test("the section stops before the blank line, not after it", () => {
  const { thinkSection } = loadSection();
  const text = "first" + LF + LF + "second";
  const sec = thinkSection(text);
  assert.equal(text.slice(0, text.indexOf(sec.head) + sec.head.length), "first", "no trailing newline is drawn with the dots");
});
