// A skill result types its head, not all forty rows.
//
// What went wrong. Every row of a paced result was its own pacer entry, and the pacer advances every entry it holds,
// so forty rows meant every tick rewrote every row that had grown: one second carried 296 row writes and the two
// seconds of that burst were 61% of a streamed window's writes. The head is what a reader watches; past a handful of
// rows the typing is a delay.
//
// The rule is READ OUT of public/app.js between its markers, so a change to the page's own rule changes these answers:
// a row is paced only below RESULT_PACED_ROWS, and a row's index counts from the call's own header — another call's
// header ends the count, so two results in one burst type the head of each.
import assert from "node:assert/strict";
import test from "node:test";

import { readSource, sliceRegion } from "../tools/panel-testkit.mjs";

const code = sliceRegion(readSource("public/app.js"), "result row head");
const { resultRowIndex, shouldPaceResultRow, RESULT_PACED_ROWS } = new Function(
  `${code}\nreturn { resultRowIndex, shouldPaceResultRow, RESULT_PACED_ROWS };`,
)();

const header = (tool) => ({ kind: "tool", text: `↳ ${tool}` });
const out = (n) => ({ kind: "tool-out", text: `row ${n}` });
const raw = (text) => ({ kind: "raw", text });

test("the index counts the rows between the call's header and this line", () => {
  const line = out(3);
  const lines = [header("skill_view"), out(1), out(2), line];
  assert.equal(resultRowIndex(lines, line), 2, "zero-based: two rows precede the third");
  assert.equal(shouldPaceResultRow(lines, line), true);
});

test("the first row under a header is row zero", () => {
  const line = out(1);
  assert.equal(resultRowIndex([header("skill_view"), line], line), 0);
});

test("another call's header ends the count, so each result types its own head", () => {
  const line = out(2);
  const lines = [header("skill_view"), out(1), raw("between calls"), header("terminal"), out(1), line];
  assert.equal(resultRowIndex(lines, line), 1);
});

test("rows that are not a result's own lines do not consume a head slot", () => {
  const line = out(2);
  const lines = [header("skill_view"), raw("a note"), out(1), { kind: "dim", text: "…" }, line];
  assert.equal(resultRowIndex(lines, line), 1);
});

test("the cap decides the head, and it is the constant the page ships", () => {
  assert.equal(RESULT_PACED_ROWS, 6);
  const lines = [header("skill_view")];
  for (let n = 1; n <= RESULT_PACED_ROWS; n += 1) lines.push(out(n));
  const fifth = lines[RESULT_PACED_ROWS]; // the last row that may type (index 5)
  assert.equal(resultRowIndex(lines, fifth), 5);
  assert.equal(shouldPaceResultRow(lines, fifth), true, "the last row of the head types");
  const tail = out(7);
  lines.push(tail);
  assert.equal(resultRowIndex(lines, tail), 6);
  assert.equal(shouldPaceResultRow(lines, tail), false, "the first row past the head lands at once");
});

test("a smaller cap paces only that many rows", () => {
  const lines = [header("skill_view"), out(1), out(2)];
  const second = lines[2];
  assert.equal(shouldPaceResultRow(lines, second, 1), false);
  assert.equal(shouldPaceResultRow(lines, second, 2), true);
});

test("a line the list does not carry is measured by the rows above it", () => {
  const line = out(2);
  const lines = [header("skill_view"), out(1)];
  assert.equal(resultRowIndex(lines, line), 1, "the count is what is above it");
});
