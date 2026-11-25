// The REVIEW LANE's client half: one reading of `row.review`, the header count and the table filter.
//
// The lane has three surfaces and they must agree:
//
//   1. the amber ▣ on the row and the ✓ Reviewed beside it (public/render-projects.js `reviewRowMarkHtml`);
//   2. the result card under the row - summary, report anchor, next-step chips (public/board-scaffold.js);
//   3. the header count that filters the table (public/app.js `paintReviewChip` / `tableHidesRow`).
//
// This file pins the ARITHMETIC (public/core/review-lane.js) directly, and the wiring of those three surfaces by
// slicing the files that draw them - the same approach test/clarify-reask.test.js takes for a shared rule, because a
// shared predicate that nothing calls is not a lane.
//
// THE COUNT IS THE HEADER'S ONLY ONE. The Human control that used to carry a second count of these rows is gone;
// `#btn-review` is where a reader sees how many results are waiting, and its press filters the table to exactly them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
// The text between two markers, so a test asserts about ONE function rather than about a file that happens to
// contain the string somewhere.
function sliceBetween(source, from, to) {
  const a = source.indexOf(from);
  assert.ok(a >= 0, `${from} is in the file`);
  const b = source.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} follows ${from}`);
  return source.slice(a, b);
}

await import("../public/core/review-lane.js");
const lane = globalThis.wtReviewLane;

const row = (over = {}) => ({
  project: "proj",
  path: "p/tree",
  ...over,
  review: { summary: "a result", report: null, next: [], at: "2026-11-18T10:00:00.000Z", reviewedAt: null, ...(over.review || {}) },
});
const reviewed = () => row({ review: { reviewedAt: "2026-11-18T11:00:00.000Z" } });

// ---- 1. the one predicate -------------------------------------------------------------------------------------

test("a delivery is awaiting until it is stamped, and absence is not a delivery", () => {
  assert.equal(lane.awaiting(row()), true);
  assert.equal(lane.awaiting(reviewed()), false, "the amber mark is the ABSENCE of the stamp");
  assert.equal(lane.awaiting({ path: "x" }), false, "a row with no delivery is not in the lane");
  assert.equal(lane.awaiting(null), false);
  assert.equal(lane.awaiting({ review: { reviewedAt: null } }), false, "a record with no summary is not a delivery");
});

test("count is over ROWS, so a stale entry for a gone tree cannot inflate the badge", () => {
  const rows = new Map([
    ["a", row()],
    ["b", reviewed()],
    ["c", row({ path: "p/other" })],
    ["d", { path: "p/plain" }],
  ]);
  assert.equal(lane.count(rows.values()), 2);
  assert.equal(lane.count([]), 0);
  assert.equal(lane.count(null), 0);
  // The rows the app's filter keeps are exactly the rows the count counted: `tableHidesRow` asks the same predicate.
  const kept = [...rows.values()].filter((r) => !lane.awaiting(r));
  assert.equal(rows.size - kept.length, lane.count(rows.values()));
});

test("since reads the delivery stamp, and an undated record sorts last rather than first", () => {
  assert.equal(lane.since(row()), Date.parse("2026-11-18T10:00:00.000Z"));
  assert.equal(lane.since({ review: {} }), Number.MAX_SAFE_INTEGER);
  assert.equal(lane.since({}), Number.MAX_SAFE_INTEGER);
});

test("the module exports the marker and count arithmetic, and no rotation arithmetic", () => {
  assert.deepEqual(Object.keys(lane).sort(), ["awaiting", "awaitingCollisions", "collisionTitle", "count", "landOrderOf", "markerTitle", "since"]);
  for (const gone of ["sortHuman", "badge", "split", "keepKinds", "kindKey", "rank", "title", "keeps", "collisions"]) {
    assert.equal(lane[gone], undefined, `${gone} belonged to the removed rotation`);
  }
});

test("the marker's tooltip names the summary, the report and the step count", () => {
  const say = lane.markerTitle(row({ review: { report: "docs/reports/x.html", next: ["one", "two"] } }));
  assert.match(say, /result to review/);
  assert.match(say, /a result/);
  assert.match(say, /docs\/reports\/x\.html/);
  assert.match(say, /2 next steps/);
  assert.equal(lane.markerTitle({ path: "x" }), "");
});

// ---- 2. the surfaces are wired --------------------------------------------------------------------------------

const app = read("public/app.js");
const rowsSrc = read("public/render-projects.js");
const scaffold = read("public/board-scaffold.js");
const html = read("public/index.html");
const settings = read("public/settings.js");
const css = read("public/style.css");

test("the header draws the count and the bulk press, and the page loads the lane's arithmetic", () => {
  assert.match(html, /id="btn-review"/);
  assert.match(html, /id="review-badge"/);
  assert.match(html, /id="btn-review-all"/);
  assert.match(html, /<script src="\/core\/review-lane\.js"><\/script>/);
  const paint = sliceBetween(app, "function paintReviewChip()", "function paintReviewTable()");
  assert.match(paint, /wtReviewLane\.count\(state\.rows\.values\(\)\)/, "the count is over the rows, not the store");
  assert.match(paint, /badge\.hidden = n === 0/, "zero is the quiet state");
  assert.match(paint, /all\.hidden = !\(on && n > 0\)/, "the bulk press is offered only where it can act");
});

test("the Review control is the header's ONE count of these rows, and its copy says so", () => {
  // The button's own title: it counts, it filters, and it does not promise a key that no longer exists.
  const tag = html.match(/<button id="btn-review"[^>]*>/)[0];
  assert.match(tag, /whose result you have not checked yet/, "the title says what it counts");
  assert.match(tag, /filter the table to exactly those rows/, "the title says what the press does");
  assert.doesNotMatch(tag, /Press H|press H|H steps/, "the H rotation is gone and no title may promise it");
  assert.doesNotMatch(tag, /Human/, "and it does not point at a control that no longer exists");
  // Nothing else in the page carries a count of the same rows.
  assert.equal((html.match(/id="review-badge"/g) || []).length, 1, "one review count on the page");
  assert.doesNotMatch(app, /paintHumanButton|humanQuestions|humanStep|reviewRotationRows/, "the rotation's code is gone");
});

test("the count filters the table, and the filter overrides the chart's hold and focus mode", () => {
  const hides = sliceBetween(app, "function tableHidesRow(row)", "// Is this row DRAWN open?");
  assert.match(hides, /if \(reviewModeOn\(\)\) return !wtReviewLane\.awaiting\(row\);/);
  assert.match(hides, /return rowTopHidden\(row\) \|\| focusHidesRow\(row\);/);
  // Both row builders ask the one answer: an incremental paint and a full rebuild cannot disagree.
  assert.match(rowsSrc, /if \(tableHidesRow\(row\)\) \{/);
  assert.match(rowsSrc, /const laneOrder = reviewModeOn\(\)/);
  assert.match(rowsSrc, /\.filter\(\(r\) => r\.project === name && typeof wtReviewLane !== "undefined" && wtReviewLane && wtReviewLane\.awaiting\(r\)\)/);
  // And a lane project is drawn open, so a folded project cannot hide a row the count promised.
  assert.match(app, /projectDrawsOpen\(name\)[\s\S]{0,200}reviewModeOn\(\) && projectHasReviewRow\(name\)/);
});

test("the row carries an amber mark and a Reviewed press, distinct from the lock and the turnover mark", () => {
  const mark = sliceBetween(rowsSrc, "function reviewRowMarkHtml(row)", "// ---- the age column");
  assert.match(mark, /class="review-mark"/, "its own class, not the lock's and not the turnover's");
  assert.match(mark, /data-review-done=/, "the press lives on the row");
  assert.match(mark, /\\u25a3/, "an amber filled square - not the 🔒 and not the ⇄");
  assert.doesNotMatch(mark, /1F512|21c4/, "it does not borrow either other marker's glyph");
  // It is drawn after both of them in the name line, so the three never overwrite one another: turnover, the row's one
  // collision diamond, then the amber mark.
  const name = sliceBetween(rowsSrc, 'name: `<td class="name"', "// Same rule for the branch");
  assert.match(name, /\$\{turnoverRowMarkHtml\(row\)\}\$\{collisionDiamondHtml\(row, delKey\)\}\$\{reviewRowMarkHtml\(row\)\}/);
  // The row's own <tr> says it too, at rest, without a tooltip being opened - and only while the chip's own switch
  // is on (Settings > Board > Chart columns, "Reviewed"): a switched-off chip leaves no amber edge behind.
  assert.match(rowsSrc, /const reviewOn = reviewChipShown\(\);/);
  assert.match(rowsSrc, /reviewOn && typeof wtReviewLane !== "undefined" && wtReviewLane\.awaiting\(row\) \? " has-review" : ""/);
  assert.match(css, /tr\.row\.has-review \{/);
});

test("with its switch off the chip is not rendered at all, and with it on the press is unchanged", () => {
  // The region is run on its own, with the one predicate it asks about stubbed: this is the chart's paint, not a
  // browser, so "not rendered" means the string a row is built from carries no element - not a class that hides one.
  const region = sliceBetween(rowsSrc, "// ---- reviewed chip", "// ---- end reviewed chip");
  const build = (shown) =>
    new Function("esc", "keyOf", "wtReviewLane", "chartChipShown", `${region}; return { reviewRowMarkHtml, reviewChipShown };`)(
      (s) => String(s),
      (p, w) => `${p}::${w}`,
      { awaiting: () => true, markerTitle: () => "a result to review" },
      () => shown,
    );
  const row = { project: "proj", path: "p/tree", review: { summary: "a result", reviewedAt: null } };
  assert.equal(build(false).reviewChipShown(), false);
  assert.equal(build(false).reviewRowMarkHtml(row), "", "off emits nothing: no span, no button, no placeholder");
  // On is exactly what the row draws today: the mark, its sentence, and the one press that clears it.
  const on = build(true).reviewRowMarkHtml(row);
  assert.match(on, /class="review-mark"/);
  assert.match(on, /data-review-done="proj::p\/tree"/);
  assert.match(on, /✓ Reviewed/);
  // A row with nothing to review is empty either way - the switch only decides which of the two reasons applies.
  assert.equal(build(true).reviewRowMarkHtml({ project: "p", path: "w", review: { reviewedAt: "x" } }), "");
  assert.equal(build(true).reviewRowMarkHtml({ project: "p", path: "w" }), "");
});

test("the result card is drawn by the panel from the stored delivery: anchor through open-file, chips beneath", () => {
  const card = sliceBetween(scaffold, "function reviewBlockHtml(row, key)", "// ---- THE SAME TWO CARDS AS ONE-LINE CHIPS");
  // A REAL anchor through the existing route, with the TREE as its base: a report path is relative to the worktree.
  assert.match(card, /fileAnchor\(rec\.report, \{/);
  assert.match(card, /base: row\.path/);
  assert.match(card, /class="review-chips"/);
  assert.match(card, /class="review-chip"/);
  // No report and no steps still draw a card that says so, rather than a blank space.
  assert.match(card, /no report path - the summary above is the whole of what this run left/);
  assert.match(card, /no next steps were named/);
  // It is drawn from the row's stored record - not by the run and not on a timer - as the body of the result CHIP's
  // popup. The card left the row's detail (it was a paragraph of height under a row the reader had already opened),
  // and `rowChipInner` is the one place that says which card a chip stands for.
  const popup = sliceBetween(scaffold, "function rowChipInner(kind, row, key)", "// What the popup draws");
  assert.match(popup, /reviewBlockHtml\(row, key\)/);
  // The chip itself rides the row's name line: public/render-projects.js is where that is asserted.
  assert.ok(!scaffold.includes("${reviewBlockHtml(row, key)}"), "the card no longer costs the row a paragraph");
});

test("a press paints from the answer as well as from the snapshot, and a refused press stays pressable", () => {
  const press = sliceBetween(app, "async function reviewPress(", "document.addEventListener(\"click\"");
  assert.match(press, /apiFetch\("\/api\/review"/);
  assert.match(press, /placeRow\(project, \{ \.\.\.d\.row/);
  // The press re-arms itself on a refusal; the row is still awaiting, and the answer may have been a store error.
  const click = app.slice(app.indexOf('const done = e.target.closest("[data-review-done]")'));
  assert.match(click.slice(0, 900), /if \(!ok && done\.isConnected\) done\.disabled = false;/);
  assert.match(app, /await reviewPress\(\{ op: "review-all" \}\)/);
  assert.match(app, /reviewPress\(\{ op: "reviewed", path, project, key \}\)/);
  // A snapshot repaints the count too, so a delivery in another tab reaches this one without a press.
  assert.match(settings, /if \(typeof reviewModeOn === "function" && reviewModeOn\(\)\) paintReviewTable\(\);/);
});
