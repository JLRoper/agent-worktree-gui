// The REVIEW LANE's client half: one reading of `row.review`, the header count, the table filter, and the third kind
// in the Human rotation.
//
// The lane has four surfaces and they must agree:
//
//   1. the amber ▣ on the row and the ✓ Reviewed beside it (public/render-projects.js `reviewRowMarkHtml`);
//   2. the result card under the row - summary, report anchor, next-step chips (public/board-scaffold.js);
//   3. the header count that filters the table (public/app.js `paintReviewChip` / `tableHidesRow`);
//   4. the Human rotation, where a review row is the THIRD KIND after permissions and clarify questions.
//
// This file pins the ARITHMETIC (public/core/review-lane.js) directly, and the wiring of those four surfaces by
// slicing the files that draw them - the same approach test/clarify-reask.test.js takes for the rotation, because a
// shared predicate that nothing calls is not a lane.
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
  // The rows the filter keeps are exactly the rows the count counted.
  const kept = [...rows.values()].filter((r) => lane.keeps(r, true));
  assert.equal(kept.length, lane.count(rows.values()));
  assert.deepEqual(kept.map((r) => r.path), ["p/tree", "p/other"]);
});

test("the filter keeps everything when it is off, and exactly the lane when it is on", () => {
  assert.equal(lane.keeps(reviewed(), false), true);
  assert.equal(lane.keeps({ path: "x" }, false), true);
  assert.equal(lane.keeps(reviewed(), true), false);
  assert.equal(lane.keeps({ path: "x" }, true), false);
  assert.equal(lane.keeps(row(), true), true);
});

test("since reads the delivery stamp, and an undated record sorts last rather than first", () => {
  assert.equal(lane.since(row()), Date.parse("2026-11-18T10:00:00.000Z"));
  assert.equal(lane.since({ review: {} }), Number.MAX_SAFE_INTEGER);
  assert.equal(lane.since({}), Number.MAX_SAFE_INTEGER);
});

// ---- 2. the rotation's order ----------------------------------------------------------------------------------

const item = (kind, sinceMs, key) => ({ kind, sinceMs, key: key || `${kind}:${sinceMs}` });

test("permissions step first, then clarify questions, then rows to review - oldest first inside each kind", () => {
  const list = [
    item("review", 300),
    item("question", 500),
    item("approval", 900),
    item("review", 100),
    item("write", 800),
    item("question", 200),
  ];
  const sorted = lane.sortHuman(list);
  assert.deepEqual(sorted.map((i) => `${i.kind}:${i.sinceMs}`), [
    "write:800",
    "approval:900",
    "question:200",
    "question:500",
    "review:100",
    "review:300",
  ]);
  // The caller's own list is untouched: a sort that reordered state.rows in place would move the table.
  assert.equal(list[0].sinceMs, 300);
});

test("an undated item keeps its place at the end of its kind, and the sort is stable", () => {
  const sorted = lane.sortHuman([item("review", undefined, "a"), item("review", 5, "b"), item("review", undefined, "c")]);
  assert.deepEqual(sorted.map((i) => i.key), ["b", "a", "c"]);
});

// ---- 3. the badge and its title -------------------------------------------------------------------------------

test("the badge is one total split three ways, and the title names each kind", () => {
  const list = [item("approval", 1), item("write", 2), item("question", 3), item("review", 4), item("review", 5)];
  const b = lane.badge(list);
  assert.deepEqual(b, { total: 5, permissions: 2, questions: 1, reviews: 2 });
  const title = lane.title(b);
  assert.match(title, /2 permissions, 1 clarify question, 2 to review/);
  // Zero is the quiet state: no badge, and the title says so rather than reading "0 permissions, 0 ...".
  assert.match(lane.title(lane.badge([])), /nothing is waiting/);
  assert.equal(lane.badge([]).total, 0);
  assert.match(lane.title([item("review", 1)]), /0 permissions, 0 clarify questions, 1 to review/);
});

test("the marker's tooltip names the summary, the report and the step count", () => {
  const say = lane.markerTitle(row({ review: { report: "docs/reports/x.html", next: ["one", "two"] } }));
  assert.match(say, /result to review/);
  assert.match(say, /a result/);
  assert.match(say, /docs\/reports\/x\.html/);
  assert.match(say, /2 next steps/);
  assert.equal(lane.markerTitle({ path: "x" }), "");
});

// ---- 4. the four surfaces are wired ---------------------------------------------------------------------------

const app = read("public/app.js");
const rowsSrc = read("public/render-projects.js");
const scaffold = read("public/board-scaffold.js");
const html = read("public/index.html");
const settings = read("public/settings.js");

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
  // It is drawn after both of them in the name line, so the three never overwrite one another.
  const name = sliceBetween(rowsSrc, 'name: `<td class="name"', "// Same rule for the branch");
  assert.match(name, /\$\{turnoverRowMarkHtml\(row\)\}\$\{reviewRowMarkHtml\(row\)\}/);
  // The row's own <tr> says it too, at rest, without a tooltip being opened.
  assert.match(rowsSrc, /typeof wtReviewLane !== "undefined" && wtReviewLane\.awaiting\(row\) \? " has-review" : ""/);
  assert.match(read("public/style.css"), /tr\.row\.has-review \{/);
});

test("the result card is drawn by the panel from the stored delivery: anchor through open-file, chips beneath", () => {
  const card = sliceBetween(scaffold, "function reviewBlockHtml(row, key)", "// The refresh offer:");
  // A REAL anchor through the existing route, with the TREE as its base: a report path is relative to the worktree.
  assert.match(card, /fileAnchor\(rec\.report, \{/);
  assert.match(card, /base: row\.path/);
  assert.match(card, /class="review-chips"/);
  assert.match(card, /class="review-chip"/);
  // No report and no steps still draw a card that says so, rather than a blank space.
  assert.match(card, /no report path - the summary above is the whole of what this run left/);
  assert.match(card, /no next steps were named/);
  // It is emitted with the detail, from the row's stored record - not by the run and not on a timer.
  assert.match(scaffold, /\$\{reviewBlockHtml\(row, key\)\}/);
});

test("the rotation takes review rows as a THIRD kind, and drops one the moment it is not awaiting", () => {
  const questions = sliceBetween(app, "function humanQuestions()", "// The header control: one red count");
  assert.match(questions, /out\.push\(\.\.\.reviewRotationRows\(\)\)/);
  assert.match(questions, /return wtReviewLane\.keepKinds\(wtReviewLane\.sortHuman\(\[\.\.\.out, \.\.\.dock\]\), humanKinds\(\)\)/);
  const rotation = sliceBetween(app, "function reviewRotationRows()", "// The header control: one red count");
  assert.match(rotation, /if \(!wtReviewLane\.awaiting\(row\)\) continue;/, "reviewed, archived or deleted rows never enter it");
  assert.match(rotation, /kind: "review"/);
  assert.match(rotation, /key: `review:\$\{keyOf\(row\.project, row\.path\)\}`/);
  // H lands on it: the row opens, the card is centred and flashed, and Reviewed takes the caret.
  const show = sliceBetween(app, "function humanShowReview(q)", "// The last step of every show path");
  assert.match(app, /if \(q\.kind === "review"\) return humanShowReview\(q\);/);
  assert.match(show, /hotOpenPath\(row\)/);
  assert.match(show, /scrollIntoView/);
  assert.match(show, /human-flash/);
  assert.match(show, /\[data-review-done="\$\{CSS\.escape\(key\)\}"\]/);
  // The badge total includes them and the title splits it three ways.
  const paint = sliceBetween(app, "function paintHumanButton()", "// Open exactly the path to one question");
  assert.match(paint, /wtReviewLane\.badge\(list\)/);
  assert.match(paint, /wtReviewLane\.split\(counts, kinds\)/);
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
