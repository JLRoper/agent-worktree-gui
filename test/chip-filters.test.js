// The project header's summary chips filter the table by the same predicates they count with (public/core/chip-filters.js).
// This pins the predicates on fixed rows, and that app.js counts and filters through that one table rather than a copy.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import "../public/core/chip-filters.js";

const { predicates } = globalThis.ChipFilters;
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const rows = [
  { verdict: "MERGED into origin/main", mergeable: true },
  { verdict: "NO COMMITS", untracked: true },
  { verdict: "EMPTY REPO" },
  { verdict: "ON MAIN", dirty: true, signals: { ports: { on: true } } },
  { verdict: "AHEAD 2 · NOT MERGED", dirty: true, verdictStale: true },
  { verdict: "", signals: { ports: { on: false } } },
];

const count = (key) => rows.filter(predicates[key]).length;

test("each chip's predicate counts the rows its label says", () => {
  assert.equal(count("merged"), 1);
  assert.equal(count("nocommits"), 2, "NO COMMITS and EMPTY REPO both count as no commits");
  assert.equal(count("unmerged"), 3, "copied from the old chipsHtml: EMPTY REPO is also unmerged there (kept, see TODO)");
  assert.equal(count("dirty"), 3, "dirty or untracked");
  assert.equal(count("serving"), 1);
  assert.equal(count("removable"), 1);
  assert.equal(count("stale"), 1);
});

test("predicates tolerate rows with missing fields", () => {
  for (const key of Object.keys(predicates)) {
    assert.doesNotThrow(() => predicates[key]({}), `${key} on an empty row`);
  }
});

test("chipsHtml counts through the predicate table, not a second copy of the logic", () => {
  const body = app.slice(app.indexOf("function chipsHtml(name) {"), app.indexOf("function filterChip("));
  assert.match(body, /count\("merged"\)/);
  assert.match(body, /CHIP\.predicates\[key\]/);
  assert.doesNotMatch(body, /startsWith\("MERGED"\)/, "no inline copy of the merged test left in chipsHtml");
});

test("renderProjectRows filters through the shared rowShown predicate", () => {
  const begin = app.indexOf("function renderProjectRows(name");
  const body = app.slice(begin, app.indexOf("\nfunction ", begin + 1));
  assert.match(body, /rowShown\(name, r\)/);
  const rsBegin = app.indexOf("function rowShown(name, row)");
  const rsBody = app.slice(rsBegin, app.indexOf("\nfunction ", rsBegin + 1));
  assert.match(rsBody, /CHIP\.predicates\[key\]/);
  assert.match(rsBody, /state\.expanded\.has\(k\)/, "an open row stays drawn under a filter");
});

test("the chip click is handled before the header's collapse click", () => {
  const chip = app.indexOf('e.target.closest("[data-chip-filter]")');
  const toggle = app.indexOf('e.target.closest(".project-head[data-toggle-project]")');
  assert.ok(chip > 0 && toggle > 0, "both branches exist");
  assert.ok(chip < toggle, "the chip branch must run first, or a chip click also folds the project");
});
