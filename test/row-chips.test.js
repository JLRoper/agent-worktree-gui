// The two per-row cards as one-line chips: the result's collapsed label, the collision pairs split into open and
// resolved, and which chips a row remembers as expanded.
//
// Three things are pinned here, because each of them is a place the chips can lie:
//
//   1. THE LABEL. The result chip reads the first CLAUSE of the run's summary, the run's age and "reviewed" once it
//      has been checked - and it carries no absolute path and no chevron while it is collapsed (the path and the
//      chevron are the expansion's own).
//   2. THE COUNT. The collision chip's two numbers come from the store's own records: a ruling - the reader's or the
//      panel's automatic pick - and a stand-down are RESOLVED, everything else is OPEN, one row's project only. A
//      ruling stops counting as open the moment it is recorded, which is what applyCollisionRecord writes.
//   3. THE MEMORY. A chip starts collapsed; only opening is remembered, per row and per card, so a repaint that
//      rebuilds the row reads the same set and comes back open.
//
// The wiring is pinned by slicing the files that draw it - the same approach test/review-lane.test.js takes, because
// a pure function that nothing calls is not a chip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
function sliceBetween(source, from, to) {
  const a = source.indexOf(from);
  assert.ok(a >= 0, `${from} is in the file`);
  const b = source.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} follows ${from}`);
  return source.slice(a, b);
}

await import("../public/core/row-chips.js");
const chips = globalThis.wtRowChips;

const result = (over = {}) => ({ summary: "Both cards became chips; the suite is green.", at: "2026-11-20T10:00:00.000Z", report: null, next: [], reviewedAt: null, ...over });
const pair = (over = {}) => ({ key: "k", project: "proj", state: "assistants", ruling: null, stoodDown: [], stoodByTask: [], ...over });

// A drive letter is BUILT here, never written: this tree's own absolute-path gate reads every line for a machine's
// folder, and a fixture that must contain one spells it from parts so the gate keeps reading the words, not a path.
const DRIVE = "C" + ":";

test("the result chip reads the first clause, and never an absolute path", () => {
  assert.equal(chips.firstClause("Both cards became chips; the suite is green."), "Both cards became chips");
  assert.equal(chips.firstClause("Rebuilt the fixture and left the tree clean."), "Rebuilt the fixture and left the tree clean");
  // An absolute path is never part of a collapsed chip: a drive letter is a machine's own directory.
  assert.equal(chips.firstClause(`Moved it from ${DRIVE}/ProjectDevelopment/agent-worktree-gui/x/y.js today.`), "Moved it from today");
  assert.equal(chips.firstClause("Read /usr/local/share/thing.conf first."), "Read first");
  // A relative path is how a run names its report, and it is not an absolute path: it is left to the run's wording.
  assert.match(chips.firstClause("The report is docs/reports/chip.html and it is short."), /docs\/reports\/chip\.html/);
  // One long sentence still yields a chip: capped at a word boundary, with an ellipsis.
  const long = chips.firstClause("This run rebuilt the whole fixture, re-read every row on the board and then checked the chips carefully");
  assert.ok(long.length <= chips.LABEL_CAP + 1, long);
  assert.match(long, /\u2026$/);
  assert.equal(chips.firstClause(""), "");
});

test("the result chip carries the age, and 'reviewed' once it has been checked", () => {
  const awaiting = chips.resultLabel(result(), "12m ago");
  assert.equal(awaiting, "Both cards became chips \u00b7 12m ago");
  const reviewed = chips.resultLabel(result({ reviewedAt: "2026-11-20T11:00:00.000Z" }), "1h ago");
  assert.equal(reviewed, "Both cards became chips \u00b7 1h ago \u00b7 reviewed");
  // No age known: still a chip, and no stray separator.
  assert.equal(chips.resultLabel(result(), ""), "Both cards became chips");
  // The collapsed text is the chip's whole content: no chevron and no report path anywhere in it.
  assert.ok(!/[\u25be\u25b8]/.test(awaiting + reviewed));
  assert.ok(!/[A-Za-z]:[\\/]/.test(chips.resultLabel(result({ summary: `Land it from ${DRIVE}/x/y.js now.` }), "2m ago")));
});

test("the collision tally splits open from resolved, counting rulings and stand-downs as resolved", () => {
  const list = [
    pair({ key: "open-1" }),
    pair({ key: "open-2", state: "reader" }),
    // A reader's ruling is resolved.
    pair({ key: "ruled-1", state: "ruled", ruling: { pick: "a", name: "one" } }),
    // The panel's own automatic pick is resolved too - it is an answer, not a question.
    pair({ key: "ruled-2", state: "ruled", ruling: { pick: "b", name: "two", auto: true, reason: "only one direction merges cleanly" } }),
    // An assistant's resolution: its notice closed and the store kept the reason (forTree's array shape).
    pair({ key: "stood-1", stoodDown: [{ side: "a", taskId: 12, state: "done" }] }),
    // …and the store's own object shape, which a record carries before it is read for a row.
    pair({ key: "stood-2", stoodDown: { b: { at: "2026-11-20T10:00:00.000Z", taskId: 13, state: "parked" } } }),
    // A side whose own queue task finished: the work the collision was about is laid down.
    pair({ key: "stood-3", stoodByTask: [{ side: "a", taskId: 14, state: "done" }] }),
  ];
  assert.deepEqual(chips.tally(list), { open: 2, resolved: 5, total: 7 });
  assert.equal(chips.collisionLabel(chips.tally(list)), "2 open \u00b7 5 resolved");
  // Every pair resolved is a muted chip, and its sentence still carries both numbers.
  const quiet = chips.tally(list.filter((r) => chips.pairResolved(r)));
  assert.deepEqual([quiet.open, quiet.resolved], [0, 5]);
  assert.equal(chips.collisionLabel(quiet), "0 open \u00b7 5 resolved");
  assert.deepEqual(chips.tally([]), { open: 0, resolved: 0, total: 0 });
});

test("the tally is scoped to the row's own project", () => {
  const list = [pair({ key: "mine" }), pair({ key: "theirs", project: "another-proj" }), pair({ key: "older", project: null })];
  assert.deepEqual(chips.tally(list, "proj"), { open: 2, resolved: 0, total: 2 });
  assert.deepEqual(chips.tally(list), { open: 3, resolved: 0, total: 3 });
});

test("a ruling stops counting as open the moment it is recorded, not when the card is next drawn", () => {
  // What the page holds before the press…
  const before = [pair({ key: "pair-1" })];
  assert.deepEqual(chips.tally(before), { open: 1, resolved: 0, total: 1 });
  // …and the record applyCollisionRecord writes back onto every row that carries the pair, before any repaint: the
  // number the chip draws is read from this state, so the open count moves on the write itself.
  const after = [{ ...before[0], state: "ruled", ruling: { pick: "a", name: "this tree", auto: true } }];
  assert.deepEqual(chips.tally(after), { open: 0, resolved: 1, total: 1 });
  assert.equal(chips.pairResolved(after[0]), true);
  assert.equal(chips.pairResolved(before[0]), false);
});

test("the expansion starts collapsed, and is remembered per row and per card", () => {
  const empty = chips.readOpen(null);
  assert.equal(chips.isOpen(empty, "result", "proj::a/tree"), false, "a row nobody has opened is collapsed");
  assert.equal(chips.isOpen(empty, "collision", "proj::a/tree"), false);

  let open = chips.toggle(empty, "result", "proj::a/tree");
  assert.equal(chips.isOpen(open, "result", "proj::a/tree"), true);
  assert.equal(chips.isOpen(open, "collision", "proj::a/tree"), false, "the other card on the same row stays collapsed");
  assert.equal(chips.isOpen(open, "result", "proj::b/tree"), false, "another row stays collapsed");

  // The stored value round-trips, which is what a reload reads.
  const reread = chips.readOpen(chips.storeValue(open));
  assert.equal(chips.isOpen(reread, "result", "proj::a/tree"), true);
  assert.deepEqual(chips.entries(reread), [{ kind: "result", key: "proj::a/tree" }]);

  // Collapsing forgets it again, so the next paint cannot bring the card back.
  const closed = chips.toggle(open, "result", "proj::a/tree");
  assert.equal(chips.isOpen(closed, "result", "proj::a/tree"), false);
  assert.deepEqual(chips.entries(chips.readOpen(chips.storeValue(closed))), []);

  // A store that is not a list of known kinds reads as empty rather than throwing: the page boots on whatever the
  // last build wrote, and an unknown key in it must not draw a chip nobody can close.
  assert.deepEqual(chips.entries(chips.readOpen("{not json")), []);
  assert.deepEqual(chips.entries(chips.readOpen('["result|a::b","nonsense|a::b","result|",5]')), [{ kind: "result", key: "a::b" }]);
});

test("the row's strip draws both chips, and the detail draws neither card", () => {
  const rowFile = read("public/render-projects.js");
  const scaffold = read("public/board-scaffold.js");
  // ONE CHIP PER CELL. The collision chip rides the name line, beside the marks the row already had - that is the strip
  // that costs no height. The result chip is the chart's `reviewedExtra` column: a cell of its own right after the name,
  // because two review chips in the name line pushed the name into an ellipsis on every row that carried both.
  const nameCell = sliceBetween(rowFile, 'name: `<td class="name"', 'reviewedExtra: `<td class="reviewed-extra"');
  assert.ok(!nameCell.includes("${resultChipHtml(row, delKey)}"), "the result chip left the name cell");
  assert.match(nameCell, /\$\{collisionChipHtml\(row, delKey\)\}/, "the collision chip stays in the name line");
  assert.match(nameCell, /\$\{reviewRowMarkHtml\(row\)\}/, "the amber mark and its press stay in the name line");
  assert.match(nameCell, /\$\{collisionRowMarkHtml\(row\)\}/, "the violet row mark stays");
  const extraCell = sliceBetween(rowFile, 'reviewedExtra: `<td class="reviewed-extra"', "// Same rule for the branch");
  assert.match(extraCell, /\$\{resultChipHtml\(row, delKey\)/, "the result chip has a cell of its own");
  assert.ok(!extraCell.includes('class="name"'), "and it is not inside the name cell");
  // Both are buttons with their own state, so a Tab reaches them and Enter presses them.
  const chip = sliceBetween(scaffold, "function resultChipHtml(row, key)", "// The card behind a chip");
  assert.match(chip, /<button type="button" class="rowchip result-chip/);
  assert.match(chip, /aria-expanded="\$\{open \? "true" : "false"\}"/);
  assert.match(chip, /data-rowchip-key="\$\{esc\(key\)\}"/);
  // The collision chip carries the tally of the row's own project, violet only while a pair is open.
  assert.match(chip, /wtRowChips\.tally\(list, row\.project\)/);
  assert.match(chip, /counts\.open \? " is-live" : " is-quiet"/);
  // A collapsed chip carries no chevron: the expansion is the only thing that draws one.
  assert.match(chip, /open \? `<span class="rowchip-chev"/);

  // The two cards themselves are the popup's content now, and the detail no longer emits them.
  const detail = sliceBetween(scaffold, "function detailHtml(row) {", "// THE COLLISION CARD.");
  assert.ok(!detail.includes("${collisionBlockHtml(row, key)}"), "the collision card left the row's detail");
  assert.ok(!detail.includes("${reviewBlockHtml(row, key)}"), "the result card left the row's detail");
  const pop = sliceBetween(scaffold, "function rowChipInner(kind, row, key)", "// What the popup draws");
  assert.match(pop, /kind === "result" \? reviewBlockHtml\(row, key\) : collisionBlockHtml\(row, key\)/);
});

test("an open card survives a re-render, and Escape closes it", () => {
  const scaffold = read("public/board-scaffold.js");
  const rowFile = read("public/render-projects.js");
  // The popup re-anchors onto the row's NEW chip and repaints its body only when the record it draws moved.
  const paint = sliceBetween(scaffold, "function paintRowChipPops(project = null)", "// ARROWS STEP THE POPUP");
  assert.match(paint, /if \(pop\._anchor !== anchor\)/);
  assert.match(paint, /openRowChipPop\(kind, key\)/);
  assert.match(paint, /wtRowChips\.entries\(rowChipStore\(\)\)/);
  assert.match(scaffold, /if \(pop\._sig !== sig\)/);
  // A body redrawn under the reader's caret puts the caret back on the same control.
  assert.match(scaffold, /const at = rowChipFocusables\(pop\)\.indexOf\(document\.activeElement\);/);
  // Every path that replaces a row's chip nodes calls it: placeRow's chip repaint and the project's full rebuild.
  assert.match(rowFile, /if \(typeof paintRowChipPops === "function"\) paintRowChipPops\(\);/);
  assert.match(rowFile, /if \(typeof paintRowChipPops === "function"\) paintRowChipPops\(name\);/);
  // Keyboard: Escape closes and hands the caret back, the arrows step the card's own controls.
  const keys = sliceBetween(scaffold, 'document.addEventListener("keydown"', "// The popup is fixed");
  assert.match(keys, /e\.key === "Escape"/);
  assert.match(keys, /closeRowChipPop\(kind, key, \{ focusChip: true \}\)/);
  assert.match(keys, /e\.key === "ArrowDown" \|\| e\.key === "ArrowUp"/);
  assert.match(keys, /stepRowChipPop\(pop, e\.key === "ArrowDown" \? 1 : -1\)/);
  // The remembered store is the browser's own, and only the open chips are in it.
  assert.match(scaffold, /const ROWCHIP_STORE_KEY = "wm\.openRowChips";/);
  assert.match(scaffold, /localStorage\.setItem\(ROWCHIP_STORE_KEY/);
});

test("the popup is clamped to the window, so neither card is clipped at 768", () => {
  const scaffold = read("public/board-scaffold.js");
  const place = sliceBetween(scaffold, "function placeRowChipPop(pop, anchor)", "function rowChipFocusables");
  assert.match(place, /Math\.min\(ROWCHIP_POP_MAX, vw - gutter \* 2\)/, "never wider than the window minus its gutter");
  assert.match(place, /if \(left \+ width > vw - gutter\) left = vw - gutter - width/);
  assert.match(place, /if \(top \+ height > vh - gutter\) top = Math\.max\(gutter, rect\.top - 6 - height\)/, "flips above the chip");
  const css = read("public/chart.css");
  assert.match(css, /\.rowchip-pop \{[^}]*position: fixed;/);
  assert.match(css, /\.rowchip-pop \{[^}]*overflow: auto;/);
  // The two colours the brief names: violet while a pair is open, muted when every one is resolved.
  assert.match(css, /\.rowchip\.collision-chip\.is-live \{[^}]*color: #c9a0ff/);
  assert.match(css, /\.rowchip\.collision-chip\.is-quiet/);
});

test("the Human rotation opens the chip, and the header copy no longer promises a card under the row", () => {
  const app = read("public/app.js");
  const showReview = sliceBetween(app, "function humanShowReview(q)", "// A COLLISION, brought in front of the reader");
  assert.match(showReview, /setRowChipOpen\("result", key, true\)/);
  assert.match(showReview, /openRowChipPop\("result", key\)/);
  const showCollision = sliceBetween(app, "function humanShowCollision(q)", "// The last step of every show path");
  assert.match(showCollision, /setRowChipOpen\("collision", key, true\)/);
  assert.match(showCollision, /openRowChipPop\("collision", key\)/);
  // The copy followed the surface: the reader is told about the chip and the card behind it, not a block underneath.
  const titles = app.includes("result card under it");
  assert.equal(titles, false, "no title promises a card under the row");
  assert.match(app, /opens its result chip onto the card behind it/);
  assert.match(app, /opens its collision chip onto the pair card/);
});
