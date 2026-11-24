// THE META LINE DRAWS NOTHING WHILE A READ IS IN FLIGHT.
//
// WHY THIS FILE EXISTS. `.init-meta` is a flex COLUMN with a gap, so any node inside it costs a line box AND the gap,
// whether or not it holds a word. The read's hint used to be drawn there unconditionally - `<span class="as-hint
// init-read">${initLoading ? "reading…" : initErr ? … : ""}</span>` - and expanding an initiative repaints the pane
// while a stale read starts in the same render, so the hint entered the meta line for as long as the read took and
// pushed every card below it down by one line plus the gap (measured: 16.67 px at 660 px and 340 px docks, then back).
//
// The measurement lives in tools/verify-init-read-zero-shift.mjs (a browser gate: the read is PARKED by the network so
// the in-flight sample is held still, and a MutationObserver proves the string never enters the pane). This file pins
// the two source shapes that measurement depends on, so the gate cannot stay green after a refactor quietly reintroduces
// the placeholder:
//
//   1. THE SPAN IS WRITTEN ONLY FOR A FAILURE. The meta line's markup may mention `initErr`; it may not mention
//      `initLoading` and may not carry the loading word. `read failed:` is the only text it can hold.
//   2. AN EMPTY CARRIER STILL COSTS NOTHING. The stylesheet keeps `#as-initiatives .init-read:empty { display: none }`
//      as the second lock: an empty span is still a flex item in that column and would still be charged the 8px gap.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pane = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

// The renderer's markup: from the node the meta line is built in to the end of the template literal.
const metaAt = pane.indexOf('<div class="init-meta">');
assert.ok(metaAt > 0, "the initiatives meta line is where this test expects it");
const metaEnd = pane.indexOf("</div>", pane.indexOf("init-read", metaAt) + 1);
const metaLine = pane.slice(metaAt, metaEnd > 0 ? metaEnd : metaAt + 900);

test("the meta line writes its read span only when there is a failure to show", () => {
  assert.match(metaLine, /initErr \?/, "the span is guarded by initErr");
  assert.match(metaLine, /read failed:/, "the failure text is still rendered");
  assert.doesNotMatch(metaLine, /initLoading/, "the in-flight state may not draw anything in the meta line");
  assert.doesNotMatch(metaLine, /reading/, "the loading word may not be written into the meta line at all");
  // One carrier, not a permanent empty one: a bare `<span class="as-hint init-read"></span>` outside the guard would
  // still be a flex item and still cost the column's gap.
  const carriers = metaLine.match(/class="as-hint init-read"/g) || [];
  assert.equal(carriers.length, 1, "exactly one read span, and it is inside the initErr guard");
  const guard = metaLine.indexOf("initErr ?");
  const carrier = metaLine.indexOf('class="as-hint init-read"');
  assert.ok(carrier > guard, "the span lives in the initErr branch, not beside it");
});

test("an empty read carrier is removed from the column by the stylesheet", () => {
  assert.match(
    css,
    /#as-initiatives \.init-read:empty\s*\{\s*display:\s*none;?\s*\}/,
    "the empty carrier must not be a flex item: `:empty { display: none }`",
  );
});
