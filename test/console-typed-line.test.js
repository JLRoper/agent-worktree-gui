// A repaint may draw LESS of a line than the reader has watched arrive, but never less than the record holds.
//
// What went wrong. The word pacer is the only thing in the page that knows how much of a growing paragraph may be
// drawn, and a repaint asks it (`typedShown`) for a prefix of the line the transcript holds. Two things can leave
// that prefix behind the record for good:
//   * a hidden tab draws every frame WHOLE (`document.hidden` returns the text without feeding the pacer), so a
//     paragraph that was mid-type when the reader left is released, flushed and forgotten at the text it had then —
//     the rest of it never reaches the pacer, and every repaint after that draws the reader a line that stops
//     mid-word ("This" for a paragraph that starts "This branch was added to main as version 0.47.0.");
//   * a row re-cut out of the DOM loses its `data-lid` (groupLines reads lines back as { kind, text }), so a pacer
//     paint cannot find it and the row keeps whatever prefix it was first drawn with.
// The invariant this test pins is the one that makes both harmless: what a repaint draws is either the record's own
// text or a prefix the pacer is STILL growing, and once the pacer has nothing left to release the record wins.
//
// The rule under test is READ OUT of public/app.js between its markers, and the pacer is the page's own
// (public/core/type-stream.js), so a change to either one changes these answers.
import assert from "node:assert/strict";
import test from "node:test";

import { readSource, sliceBetween } from "../tools/panel-testkit.mjs";

await import("../public/core/type-stream.js");
const { createPacer } = globalThis.wtType;

const code = sliceBetween(readSource("public/app.js"), "// ---- end result row head", "// ---- console row text");
// `window` is only used by the "console-format asks the page for the prefix" registration at the end of that region;
// a bare object satisfies its optional chaining, which is exactly what a harness page without the module looks like.
const make = new Function("state", "document", "window", `${code}\nreturn { typedText, typedShown };`);

// A clock, a timer queue and a paint log driven by hand, so "while the tab was hidden" is an ordering, not a wait.
function bench() {
  let t = 1_000_000;
  const timers = new Map();
  let seq = 0;
  const painted = [];
  const clock = {
    now: () => t,
    schedule: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: t + Math.max(1, ms) });
      return id;
    },
    cancel: (id) => timers.delete(id),
  };
  const pacer = createPacer({ ...clock, rate: 40, onPaint: (lids) => painted.push(...lids) });
  const document = { hidden: false };
  const page = make({ typePacer: pacer }, document, {});
  const step = (ms) => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, x]) => x.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, x] = due;
      timers.delete(id);
      t = Math.max(t, x.at);
      x.fn();
    }
    t = target;
  };
  return { page, pacer, document, step, painted, now: () => t };
}

const FULL = "This branch was added to main as version 0.47.0.";

test("a paragraph the reader is watching types out a word at a time", () => {
  const b = bench();
  const line = { lid: "7", text: "This branch" };
  assert.equal(b.page.typedText(line, "job"), "", "a line just handed to the pacer has nothing to show yet");
  b.step(40);
  assert.equal(b.page.typedShown(line), "This", "one tick released the first word of the line the record holds");
  b.step(4000);
  assert.equal(b.page.typedShown(line), "This branch", "and the whole line once the clock has run");
});

test("a paragraph that grew while the tab was hidden is not drawn short afterwards", () => {
  const b = bench();
  const lid = "7";
  // The reader is watching: the first fragment reaches the pacer and starts to type.
  b.page.typedText({ lid, text: "This" }, "job");
  b.step(40);
  assert.equal(b.page.typedShown({ lid, text: "This" }), "This");
  // The reader switches away. The page draws every frame whole from here (that is the point of the setting), and the
  // release on `visibilitychange` leaves the pacer holding the text the line had when the tab went away.
  b.document.hidden = true;
  b.pacer.releaseAll();
  const full = FULL;
  assert.equal(b.page.typedText({ lid, text: full }, "job"), full, "a hidden tab draws the whole line");
  // The reader comes back and the card is repainted from its record.
  b.document.hidden = false;
  b.pacer.flushJob("job");
  assert.equal(b.page.typedShown({ lid, text: full }), full, "the repaint draws the line the record holds, not 'This'");
});

test("a line the pacer has nothing left to release for is drawn from its record", () => {
  const b = bench();
  const lid = "9";
  b.page.typedText({ lid, text: "Before it" }, "job");
  b.step(40);
  b.document.hidden = true;
  b.pacer.releaseAll();
  b.page.typedText({ lid, text: "Before it landed, main was at 0.46.8." }, "job");
  b.document.hidden = false;
  // No settle, no growth frame: the pacer is idle and its claim is behind the record.
  assert.equal(b.page.typedShown({ lid, text: "Before it landed, main was at 0.46.8." }), "Before it landed, main was at 0.46.8.");
});

test("a row with no text of its own still asks the pacer for its prefix", () => {
  const b = bench();
  const lid = "think:1712";
  b.page.typedText({ lid, text: "a thought that is still being written out word by word" }, "job");
  b.step(40);
  // A reasoning row is drawn from its block, not from a console line: it has no text to compare against, and the
  // pacer is the only thing that knows how much of it may be shown.
  assert.equal(b.page.typedShown({ lid }), "a");
});

test("a record rewritten under the pacer is drawn as the record says", () => {
  const b = bench();
  const lid = "11";
  b.page.typedText({ lid, text: "the console row" }, "job");
  b.step(40);
  // A trim moved the line, or the wire rewrote it: the pacer's prefix is not this line any more.
  assert.equal(b.page.typedShown({ lid, text: "a different line" }), null, "the record wins over a prefix it no longer starts with");
});
