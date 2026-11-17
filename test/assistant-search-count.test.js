// The assistant search's count: public/core/search-count.js, and the page that paints it.
//
// WHY THIS FILE EXISTS. The header and the footer used to count different things - the header counted TURNS
// ("1 of 1") while the footer counted HITS ("5 matched, 5 displayed") - so a filter that hit five rows of one
// turn printed two numbers that disagreed and the box looked broken. The count has ONE source now: the list of
// rows the keyboard steps. These tests pin that source, the wording both surfaces print, and the page's use of
// it, so the two numbers cannot drift apart again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../public/core/search-count.js";

const { countTurns, readout, step } = globalThis.wtSearchCount;

const hit = (id, field = "tool", thread = "panel-assistant") => ({ id, thread, field });

test("five rows inside ONE turn read 1 of 5 - this is the defect the count module replaces", () => {
  const hits = [1, 2, 3, 4, 5].map((i) => hit("one", i === 0 ? "input" : "tool"));
  const c = readout({ hits, matched: 5, displayed: 5, turns: 1, at: 0 });
  assert.equal(c.text, "1 of 5", 'the header speaks the matches the keyboard steps, not "1 of 1"');
  assert.equal(c.total, 5);
  assert.equal(c.current, 1);
  assert.equal(c.turns, 1, "one turn holds all five rows");
  assert.equal(c.foot, "5 hits matched, 5 displayed, in 1 turn", "the footer keeps hits-matched/displayed and carries the turn count as secondary text");
  assert.equal(c.capped, false);
  assert.match(c.title, /one match per press/);
});

test("five turns read 1 of 5 too, and the footer names the five turns", () => {
  const hits = ["t5", "t4", "t3", "t2", "t1"].map((id) => hit(id, "input"));
  const c = readout({ hits, matched: 5, displayed: 5, turns: 5, at: 0 });
  assert.equal(c.text, "1 of 5");
  assert.equal(c.turns, 5);
  assert.equal(c.foot, "5 hits matched, 5 displayed, in 5 turns");
  assert.equal(c.capped, false);
});

test("the header's total IS the footer's displayed count, so one view cannot print two totals", () => {
  // A capped answer: twelve rows matched, the list holds ten. The walk steps ten, so the header divides ten,
  // and the footer says the same ten while still admitting the twelve.
  const hits = Array.from({ length: 10 }, (_, i) => hit(`t${i}`, i < 6 ? "input" : "tool"));
  const c = readout({ hits, matched: 12, displayed: 10, turns: 6, at: 0 });
  assert.equal(c.total, c.displayed, "the header's total and the footer's displayed are one number");
  assert.equal(c.text, "1 of 10");
  assert.equal(c.foot, "12 hits matched, 10 displayed, in 6 turns");
  assert.equal(c.capped, true, "the cap is a fact the count must not hide");
  assert.match(c.title, /12 hits matched, 10 displayed/);
  assert.match(c.title, /kept when the cap bites/, "the capped title says why the list may not hold every match, without claiming an order the list does not use");
});

test("a server number that disagreed with the list cannot reach the footer", () => {
  // The defect was two surfaces counting different things. The list is what the reader can count, so the footer's
  // "displayed" is its length even when a caller hands in a stale or wrong copy of the server's number.
  const hits = [1, 2, 3, 4, 5].map((i) => hit(`t${i}`, "tool"));
  const c = readout({ hits, matched: 5, displayed: 9, turns: 2, at: 0 });
  assert.equal(c.displayed, 5, "the list wins over a number that contradicts it");
  assert.equal(c.text, "1 of 5");
  assert.equal(c.foot, "5 hits matched, 5 displayed, in 2 turns", "the header's 5 and the footer's 5 are the same 5");
  assert.equal(c.capped, false);
});

test("the current row moves with the walk, and a position nothing names reads as the first", () => {
  const hits = [1, 2, 3, 4, 5].map((i) => hit(`t${i}`, "tool"));
  assert.equal(readout({ hits, at: 0 }).text, "1 of 5");
  assert.equal(readout({ hits, at: 1 }).text, "2 of 5");
  assert.equal(readout({ hits, at: 4 }).text, "5 of 5");
  assert.equal(readout({ hits, at: -1 }).text, "1 of 5", "nothing current yet: the first row is the standing row");
  assert.equal(readout({ hits, at: 99 }).text, "1 of 5", "an out-of-range index is not trusted");
});

test("the walk wraps at both ends, which is the stated behaviour", () => {
  assert.equal(step(0, 1, 5), 1);
  assert.equal(step(4, 1, 5), 0, "Down on the last row lands on the first");
  assert.equal(step(0, -1, 5), 4, "Up on the first lands on the last");
  assert.equal(step(2, -1, 5), 1);
  // Nothing current yet: Down lands on the first, Up on the last.
  assert.equal(step(-1, 1, 5), 0);
  assert.equal(step(-1, -1, 5), 4);
  // One row is still a ring: both directions land on it.
  assert.equal(step(0, 1, 1), 0);
  assert.equal(step(0, -1, 1), 0);
  // No rows: there is nothing to stand on.
  assert.equal(step(0, 1, 0), -1);
  assert.equal(step(-1, -1, 0), -1);
  // An out-of-range index is treated as "nothing current" rather than trusted.
  assert.equal(step(9, 1, 5), 0);
  assert.equal(step(9, -1, 5), 4);
});

test("an empty answer reads 0 of 0 and has no footer", () => {
  const c = readout({ hits: [], matched: 0, displayed: 0, turns: 0 });
  assert.equal(c.text, "0 of 0");
  assert.equal(c.foot, "");
  assert.equal(c.capped, false);
  assert.equal(c.title, "no turn matches this filter");
});

test("the turn count falls back to the rows when the server did not send one, keyed by thread and turn", () => {
  const hits = [hit("a", "input"), hit("a", "reply"), hit("b", "input"), hit("b", "tool", "worker-thread")];
  assert.equal(countTurns(hits), 3, "two fields of one turn are one turn; the same id on another thread is another");
  const c = readout({ hits, at: 0 });
  assert.equal(c.turns, 3);
  assert.equal(c.foot, "4 hits matched, 4 displayed, in 3 turns", "a missing count falls back to the list, never to a second rule");
});

// ---- the page's own use of it ---------------------------------------------------------------------------------
// The module can be right and the page can still count turns, so this reads the page: paintSearchCount must
// paint the one readout, and the readout must be handed the rows the keyboard steps.
const page = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const paintCountAt = page.indexOf("function paintSearchCount");
const paintCountEnd = page.indexOf("// One result row:", paintCountAt);
const paintCount = paintCountAt >= 0 && paintCountEnd > paintCountAt ? page.slice(paintCountAt, paintCountEnd) : "";
const readoutAt = page.indexOf("function searchReadout");
const readoutEnd = page.indexOf("\n  // The count beside the box", readoutAt) >= 0 ? page.indexOf("\n  // The count beside the box", readoutAt) : readoutAt + 1400;
const readoutBody = readoutAt >= 0 ? page.slice(readoutAt, readoutEnd > readoutAt ? readoutEnd : readoutAt + 1400) : "";

test("paintSearchCount paints the one readout and never counts the turn list itself", () => {
  assert.ok(paintCount, "paintSearchCount exists in public/assistant.js");
  assert.match(paintCount, /searchReadout\(\)/, "the header is painted from the shared readout");
  assert.doesNotMatch(paintCount, /searchItems\.length/, "the header must not derive its total from the turn map");
  assert.doesNotMatch(paintCount, /searchOut\.turns/, "the header's total is the walk, not the turn count");
});

test("the readout is handed the rows the keyboard steps, and the server's counts beside them", () => {
  assert.ok(readoutBody, "searchReadout exists in public/assistant.js");
  assert.match(readoutBody, /wtSearchCount/, "the page uses the module rather than re-deriving the count");
  assert.match(readoutBody, /hits: searchHits/, "the walk's list is the count's source");
  assert.match(readoutBody, /matched: out\.matched/, "the server's matched count is carried through");
  assert.doesNotMatch(
    readoutBody,
    /displayed: out\.displayed/,
    "the footer's displayed count is the row list, never a second server number that could disagree with it",
  );
  assert.match(readoutBody, /at: searchHitAt/, "the standing row is the walk's index");
});

test("the page loads the count module before the page that paints it", () => {
  // A module the page never loads is not a count source: this is the wiring half of the same promise.
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const countAt = index.indexOf('src="/core/search-count.js"');
  const assistantAt = index.indexOf('src="/assistant.js"');
  assert.ok(countAt >= 0, "public/index.html loads public/core/search-count.js");
  assert.ok(assistantAt > countAt, "the module is loaded before assistant.js, which reads it");
});
