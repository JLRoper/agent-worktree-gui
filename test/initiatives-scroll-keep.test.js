// THE INITIATIVES PANE KEEPS THE READER'S PLACE ACROSS ITS REPAINT, AND DOES NOT REPAINT FOR NOTHING.
//
// WHY THIS FILE EXISTS. The pane is rebuilt from a poll. Two facts about that rebuild are DOM facts that no pure
// function can carry, and both have been got wrong once already:
//
//   1. THE REPAINT IS REBUILT ON THE READER'S ROW, NOT ON A NUMBER. The scroller is captured before the pane's markup
//      is written and put back afterwards, on the first card that starts inside the view. The anchor has to be a CARD:
//      `data-init-assistant-row` and `data-init-hist-row` carry an assistant's id or a time, which repeats under every
//      card that has one, so resolving those back after a rebuild finds a different row - measured, that mistake moved
//      the pane 1315 px. The row that is captured also has to be the first one that STARTS in view: anchoring on a
//      card straddling the top edge reads a zero correction when the change happened inside that very card.
//   2. AN UNCHANGED PAYLOAD IS NOT REPAINTED. The markup string is the whole of what this renderer draws, so an
//      identical string is an identical DOM: writing it again throws away the reader's anchor, their selection and the
//      task-fold nodes the same pass reconciles - one rebuild per poll, which is the reader's creep's engine.
//
// The measurements live in tools/verify-initiatives-creep.mjs (a browser gate: 60 s idle, then a real store change).
// This file pins the source shape those measurements depend on, so the gate cannot be made green by a fix that is
// deleted in the next refactor.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pane = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
// The renderer and the two helpers that sit immediately above it. `openInitiativeTree` is the function after them.
const from = pane.indexOf("// THE READER'S PLACE IS A CARD, NOT A NUMBER.");
const to = pane.indexOf("function openInitiativeTree(", from);
assert.ok(from > 0 && to > from, "the scroll-keeping block and the renderer are where this test expects them");
const region = pane.slice(from, to);
const renderStart = region.indexOf("function renderAssistantInitiatives(");
const render = region.slice(renderStart);
const capture = region.slice(region.indexOf("function captureInitScroll("), region.indexOf("function restoreInitScroll("));
const restore = region.slice(region.indexOf("function restoreInitScroll("), renderStart);

test("the scroller is captured before the markup is written and restored after the task folds are reconciled", () => {
  const capturedAt = render.indexOf("const keepScroll = captureInitScroll(host);");
  const wroteAt = render.indexOf("host.innerHTML = markup;");
  const foldsAt = render.indexOf("paintInitTaskLists(host);");
  const restoredAt = render.indexOf("restoreInitScroll(keepScroll);");
  assert.ok(capturedAt > 0, "the renderer captures the scroller");
  assert.ok(wroteAt > capturedAt, "the capture happens before the write, not after it");
  assert.ok(foldsAt > wroteAt, "the task folds are reconciled after the write");
  assert.ok(restoredAt > foldsAt, "the scroll is put back after the folds, which are part of what moved the content");
  // The old shape: a bare `host.innerHTML = ` with no capture, which is the bug this pins.
  assert.equal(render.includes("host.innerHTML = `"), false, "no unguarded write of the pane's markup");
});

test("an unchanged payload is not written again", () => {
  assert.match(render, /if \(markup !== initMarkup\) \{\s*host\.innerHTML = markup;\s*initMarkup = markup;/, "the write is guarded by the markup the pane is already showing");
  assert.ok(render.includes("paintInitTaskLists(host);"), "the folds are still reconciled when the markup is unchanged");
  // The cached markup must not survive a pane that has no document: the next read would then skip the paint that
  // draws it.
  assert.match(render, /if \(!initDoc\) \{\s*initMarkup = "";/, "a pane with no document clears the cache");
});

test("the anchor is a card id, unique in the pane - never a row whose value repeats", () => {
  assert.ok(capture.includes('.init-card'), "the capture reads the pane's cards");
  assert.ok(capture.includes('data-init-card'), "the anchor is the card's own id");
  for (const repeated of ["data-init-assistant-row", "data-init-hist-row", "data-init-tree-row"]) {
    assert.equal(capture.includes(repeated), false, `${repeated} repeats under every card and must not be an anchor`);
  }
  // The first card that STARTS inside the view, not the one straddling its top edge.
  assert.match(capture, /const pick = \(starts\)/, "the capture has the starts-in-view rule");
  assert.match(capture, /pick\(true\) \|\| pick\(false\)/, "a card that starts in view is preferred, with a straddling card as the fallback");
});

test("the three states that are left alone are left alone", () => {
  // A reader at the top keeps the top (a new initiative appears where they are looking), a reader at the foot stays
  // at the foot, and a card the pass removed falls back to the old number.
  assert.match(restore, /if \(keep\.atBottom\) \{\s*scroller\.scrollTop = scroller\.scrollHeight;/, "the foot stays the foot");
  assert.match(restore, /if \(keep\.atTop\) \{\s*scroller\.scrollTop = 0;/, "the top stays the top");
  assert.match(restore, /scroller\.scrollTop = keep\.top;/, "a missing anchor falls back to the number it was captured with");
  assert.match(restore, /Math\.abs\(shift\) < 0\.5/, "a sub-pixel difference is rounding, not a move");
});
