// The two per-row cards behind their controls: the result's collapsed label, the words the collision diamond says, and
// which of them a row remembers as expanded.
//
// Three things are pinned here, because each of them is a place the controls can lie:
//
//   1. THE LABEL. The result chip reads the first CLAUSE of the run's summary, the run's age and "reviewed" once it
//      has been checked - and it carries no absolute path and no chevron while it is collapsed (the path and the
//      chevron are the expansion's own).
//   2. THE WORDS. The collision row carries ONE diamond and no counts chip, so the tally's two numbers are SPOKEN:
//      `collisionWords` says the state and the count ("2 collisions: 1 open, 1 resolved"), and `collisionDiamondLabel`
//      is the control's accessible name and title. A ruling - the reader's or the panel's automatic pick - and a
//      stand-down are RESOLVED, everything else is OPEN, one row's project only. A ruling stops counting as open the
//      moment it is recorded, which is what applyCollisionRecord writes.
//   3. THE MEMORY. A control starts collapsed; only opening is remembered, per row and per card, so a repaint that
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
  assert.equal(chips.collisionWords(chips.tally(list)), "7 collisions: 2 open, 5 resolved");
  // Every pair resolved: the diamond goes outlined, and its sentence still carries both numbers.
  const quiet = chips.tally(list.filter((r) => chips.pairResolved(r)));
  assert.deepEqual([quiet.open, quiet.resolved], [0, 5]);
  assert.equal(chips.collisionWords(quiet), "5 collisions, all resolved");
  assert.deepEqual(chips.tally([]), { open: 0, resolved: 0, total: 0 });
});

test("the diamond's words are the count in words, in every shape a row can be in", () => {
  const words = (open, resolved) => chips.collisionWords({ open, resolved });
  assert.equal(words(1, 0), "1 collision, open");
  assert.equal(words(0, 1), "1 collision, resolved");
  assert.equal(words(2, 0), "2 collisions, all open");
  assert.equal(words(1, 1), "2 collisions: 1 open, 1 resolved");
  assert.equal(words(3, 1), "4 collisions: 3 open, 1 resolved");
  assert.equal(words(0, 0), "");
  // Never a numeral drawn as a bare pair of counts: an "N open . M resolved" string is the chip this replaced.
  assert.ok(!/^\d+ open/.test(words(2, 5)));
});

test("the accessible name and the title say the state, the count, and what the press does", () => {
  const collapsed = chips.collisionDiamondLabel({ open: 1, resolved: 1 }, false);
  assert.match(collapsed, /^2 collisions: 1 open, 1 resolved on this worktree/);
  assert.match(collapsed, /press to open every pair/);
  assert.match(collapsed, /both sides, the shared files and the ruling presses/);
  const expanded = chips.collisionDiamondLabel({ open: 1, resolved: 1 }, true);
  assert.match(expanded, /^2 collisions: 1 open, 1 resolved on this worktree/);
  assert.match(expanded, /press to close it/);
  // The state is in WORDS on the resolved side too: a quiet diamond still says it is resolved, not just dimmer.
  assert.match(chips.collisionDiamondLabel({ open: 0, resolved: 3 }, false), /^3 collisions, all resolved/);
  assert.match(chips.collisionDiamondLabel({ open: 0, resolved: 1 }, false), /^1 collision, resolved/);
});

test("a clean merge probe does not settle a pair that still carries detected paths", () => {
  // Two trees writing one file uncommitted sit on identical tips, so merge-tree answers clean with no conflicted path.
  // The paths the detector recorded are the dirty ones, so the pair is still the reader's and the chip must say so.
  const dirty = pair({ key: "dirty", state: "reader", files: ["lib/shared.js"], resolution: { kind: "tree" }, evidence: { ok: true, files: [] } });
  assert.equal(chips.pairResolved(dirty), false);
  assert.deepEqual(chips.tally([dirty]), { open: 1, resolved: 0, total: 1 });
  // A REPORTED pair that named no file, between tips that merge clean, has nothing to press: that one is settled.
  const reported = pair({ key: "reported", state: "reader", files: [], resolution: { kind: "tree" }, evidence: { ok: true, files: [] } });
  assert.equal(chips.pairResolved(reported), true);
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

test("the row's strip draws the result chip and ONE collision diamond, and the detail draws neither card", () => {
  const rowFile = read("public/render-projects.js");
  const scaffold = read("public/board-scaffold.js");
  // ONE CONTROL PER CELL. The collision diamond rides the name line, where the per-pair marks and the counts chip used
  // to sit; that is the strip that costs no height. The result chip is the chart's `reviewedExtra` column: a cell of
  // its own right after the name, because two review chips in the name line pushed the name into an ellipsis on every
  // row that carried both.
  const nameCell = sliceBetween(rowFile, 'name: `<td class="name"', 'reviewedExtra: `<td class="reviewed-extra"');
  assert.ok(!nameCell.includes("${resultChipHtml(row, delKey)}"), "the result chip left the name cell");
  assert.match(nameCell, /\$\{collisionDiamondHtml\(row, delKey\)\}/, "the one collision diamond is in the name line");
  assert.ok(!nameCell.includes("${collisionChipHtml("), "no counts chip is drawn on the row");
  assert.ok(!nameCell.includes("${collisionRowMarkHtml("), "no per-pair mark is drawn beside it - the diamond replaced both");
  assert.match(nameCell, /\$\{reviewRowMarkHtml\(row\)\}/, "the amber mark and its press stay in the name line");
  const extraCell = sliceBetween(rowFile, 'reviewedExtra: `<td class="reviewed-extra"', "// Same rule for the branch");
  assert.match(extraCell, /\$\{resultChipHtml\(row, delKey\)/, "the result chip has a cell of its own");
  assert.ok(!extraCell.includes('class="name"'), "and it is not inside the name cell");
  // Both are buttons with their own state, so a Tab reaches them and Enter presses them.
  const chip = sliceBetween(scaffold, "function resultChipHtml(row, key)", "// The card behind a chip");
  assert.match(chip, /<button type="button" class="rowchip result-chip/);
  assert.match(chip, /aria-expanded="\$\{open \? "true" : "false"\}"/);
  assert.match(chip, /data-rowchip-key="\$\{esc\(key\)\}"/);
  // A collapsed chip carries no chevron: the expansion is the only thing that draws one.
  assert.match(chip, /open \? `<span class="rowchip-chev"/);

  // THE DIAMOND is a real button: the row's own tally, the panel's own words, and a press the existing chip wiring
  // already owns (the same `data-rowchip="collision"` contract), so a click, Enter, Space and Escape all reach it.
  const diamond = sliceBetween(scaffold, "function collisionDiamondHtml(row, key)", "// THE RESULT CHIP");
  assert.match(diamond, /<button type="button" class="collision-mark collision-diamond/);
  assert.match(diamond, /data-rowchip="collision" data-rowchip-key="\$\{esc\(key\)\}"/);
  assert.match(diamond, /aria-expanded="\$\{open \? "true" : "false"\}"/);
  assert.match(diamond, /aria-label="\$\{esc\(say\)\}"/);
  assert.match(diamond, /title="\$\{esc\(say\)\}"/);
  assert.match(diamond, /wtRowChips\.tally\(list, row\.project\)/);
  assert.match(diamond, /const say = rowChipTitle\("collision", row, open\)/);
  // The fill is the state and the OUTLINE is the resolved state: the glyph changes with the count, never colour alone.
  assert.match(diamond, /const glyph = counts\.open \? "\\u25c6" : "\\u25c7"/);
  assert.match(diamond, /const state = counts\.open \? \(waiting \? "is-waiting" : "is-open"\) : "is-resolved"/);
  // ONE per row: the builder takes the row, not one record, and never maps over the pairs.
  assert.ok(!/\.map\(/.test(diamond), "one diamond for the row, not one per pair");

  // The two cards themselves are the popup's content now, and the detail no longer emits them.
  const detail = sliceBetween(scaffold, "function detailHtml(row) {", "// THE COLLISION CARD reads the RECORD");
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
  // The diamond's two inks and its 24x24 box: filled violet while a pair is open, outlined and quieter when every one
  // is resolved, the box the hit target the brief asks for, and the focus ring the keyboard reader needs.
  assert.match(css, /\.collision-diamond\.is-open \{[^}]*color: #c9a0ff/);
  assert.match(css, /\.collision-diamond\.is-waiting \{[^}]*color: #e4c8ff/);
  assert.match(css, /\.collision-diamond\.is-resolved \{[^}]*color: #8b7aa8/);
  assert.match(css, /\.collision-diamond \{[^}]*width: 24px;/);
  assert.match(css, /\.collision-diamond \{[^}]*height: 24px;/);
  assert.match(css, /\.collision-diamond:focus-visible \{[^}]*outline: 2px solid #9ec6ff/);
  // The counts chip is gone from the sheet as well as the markup: a rule nobody matches is how the old shape returns.
  assert.ok(!/\.rowchip\.collision-chip/.test(css), "no collision-chip rule survives");
});

test("the row chips open their card popups, and no title promises a card under the row", () => {
  const app = read("public/app.js");
  const scaffold = read("public/board-scaffold.js");
  // The press is the chip's own: one opener, two kinds of card behind it. The Human rotation used to call the same two
  // functions; it is gone, and nothing in app.js drives a chip any more.
  assert.match(scaffold, /function openRowChipPop\(/);
  assert.match(scaffold, /function setRowChipOpen\(/);
  const popup = sliceBetween(scaffold, "function rowChipInner(kind, row, key)", "// What the popup draws");
  assert.match(popup, /reviewBlockHtml\(row, key\)/);
  assert.match(popup, /collisionBlockHtml\(row, key\)/);
  assert.doesNotMatch(app, /openRowChipPop\(/, "the page no longer lands on a chip from a header rotation");
  // The copy followed the surface: the reader is told about the chip and the card behind it, not a block underneath.
  assert.equal(app.includes("result card under it"), false, "no title promises a card under the row");
});

// THE PAIR CARD IS A SUMMARY OVER FOUR CLOSED SECTIONS. The card's job is to state the decision - which side goes
// first - without the reader scrolling: two trees, the file they share and the two order presses fit above the fold,
// and the prose that used to sit there (the stand-down paragraph, git's own sentences, task numbers) moved into
// sections that are closed until asked for. Each header keeps its one line, so a minimised section still reads.
test("the pair card is a summary over four closed sections", () => {
  const scaffold = read("public/board-scaffold.js");
  const css = read("public/style.css");
  const block = sliceBetween(scaffold, "function collisionBlockHtml(row, key) {", "// The card behind a chip, from the row the board holds now.");
  // ABOVE THE FOLD: the two sides, the shared files and the presses are one summary, drawn BEFORE any section.
  const summary = block.indexOf('class="collision-summary"');
  const sections = block.indexOf('class="collision-accordion"');
  assert.ok(summary > 0 && sections > summary, "the summary is drawn before the sections");
  const above = block.slice(summary, sections);
  assert.match(above, /collisionSideSummaryHtml\(rec, mineSide, true\)/);
  assert.match(above, /collisionSideSummaryHtml\(rec, otherSide, false\)/);
  assert.match(above, /chipsHtml/);
  assert.match(above, /collision-actions/);
  // FOUR sections, in the brief's order: this row, its counterpart, the merge check, the history.
  assert.match(block, /collisionAccordionHtml\(secId\("this-row"\), "This row", sideKeyInfo\(mineSide\)/);
  assert.match(block, /collisionAccordionHtml\(secId\("counterpart"\), "Counterpart", sideKeyInfo\(otherSide\)/);
  assert.match(block, /collisionAccordionHtml\(secId\("merge"\), "Merge check", mergeKey/);
  assert.match(block, /collisionAccordionHtml\(secId\("history"\), "History", historyKey/);
  // EVERY header carries its own one line: the side's task number, assistant and state; git's verdict and the shared
  // file count; the task numbers and their states.
  assert.match(block, /const sideKeyInfo = \(side\) =>/);
  assert.match(block, /const mergeKey = \[/);
  assert.match(block, /const historyKey =/);
  assert.match(block, /\[`#\$\{t\.id\}`, t\.assistant, t\.state\]/);
  assert.match(block, /both directions conflict/);
  // THE PILL IS A WORD, NOT THE PARAGRAPH: the stand-down prose and the superseded sentence are History's now.
  assert.ok(!block.includes("finishedSay"), "the pill no longer prints the stand-down prose");
  assert.match(block, /const stateWord = superseded/);
  assert.match(block, /"stood down"/);
  assert.match(block, /const stood = \[/);
  // The header is a real button, the body is closed by the `hidden` attribute, and the chevrons are real escapes in
  // the source rather than the double-escaped text that once printed a literal `\u25be`.
  const acc = sliceBetween(scaffold, "function collisionAccordionHtml(", "// The press that opens and closes one section.");
  assert.match(acc, /<button type="button" class="collision-acc-head" data-collision-acc-toggle="\$\{esc\(id\)\}"/);
  assert.match(acc, /aria-expanded="\$\{open \? "true" : "false"\}"/);
  assert.match(acc, /aria-controls="cacc-\$\{esc\(id\)\}"/);
  assert.match(acc, /\$\{open \? "" : " hidden"\}/);
  const BS = String.fromCharCode(92);
  assert.ok(!acc.includes(BS + BS + "u25be"), "the chevron is one escape, not two");
  // The press is the section's own: it toggles the attribute and the body, and the row-chip wiring already treats a
  // press inside the card as the card's.
  const toggle = sliceBetween(scaffold, "function toggleCollisionSection(section)", "// A press on a header is the section's own");
  assert.match(toggle, /head\.setAttribute\("aria-expanded", open \? "false" : "true"\)/);
  assert.match(toggle, /body\.hidden = open;/);
  assert.match(scaffold, /const head = e\.target\.closest && e\.target\.closest\("\[data-collision-acc-toggle\]"\)/);
  assert.match(scaffold, /e\.stopPropagation\(\);/);
  // A repaint under an open card reopens the sections the reader had open before it puts the caret back.
  assert.match(scaffold, /const opened = kind === "collision" \? \[\.\.\.pop\.querySelectorAll\("\.collision-block"\)\]/);
  assert.match(scaffold, /toggleCollisionSection\(sec\)/);
  // The styles the card depends on: a closed body is display:none even though it is a flex column, the summary is
  // allowed to shrink below a long branch name, and the header's own focus ring is drawn.
  assert.match(css, /\.collision-acc-body\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.collision-summary \{[^}]*min-width: 0;/);
  assert.match(css, /\.collision-acc-head:focus-visible \{ outline: 2px solid #a371f7/);
  assert.ok(!/\.collision-body \{/.test(css), "the old one-paragraph body rule is gone");
});
