// The DELIVERABLES popover's kind chips — the narrowing they do, tested without a browser.
//
// The popover already had one search box (#dl-filter). The chips beside it are the second narrowing, and the two
// have to compose rather than compete: a reader who turns `image` off and types "report" sees the reports that are
// not images. What the head says (#dl-count) describes THAT list, not the archive, and a kind with no rows in the
// popup gets no chip at all — a dead control is worse than an absent one.
//
// The answers live in public/core/deliver-kinds.js, which the page loads as a classic script and which assigns
// globalThis.wtDeliverKinds, so importing it here is the same code the reader's page runs. The kinds themselves are
// lib/deliverables.js's DELIVER_KINDS, and the first test is the one that keeps the page from growing a fourth.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";
import { DELIVER_KINDS } from "../lib/deliverables.js";

await import("../public/core/deliver-kinds.js");
const K = globalThis.wtDeliverKinds;

// The list's rendering moved to public/deliverables.js in step 3 of docs/reports/module-map-2026-11-07.html's
// order of work.
const list = readFileSync(new URL("../public/deliverables.js", import.meta.url), "utf8");

// A store's list, newest first, with every kind in it. The targets are what the text filter searches as well as the
// titles, so one entry can be found by a word that appears only in its path.
const row = (seq, kind, title, target) => ({
  seq,
  kind,
  title,
  target,
  agent: "wtgui-alfa-327334",
  project: "agent-worktree-gui",
  at: new Date(1_800_000_000_000 - seq * 60_000).toISOString(),
  missingAt: null,
});
const ENTRIES = [
  row(30, "file", "The 200-row probe report", "/trees/alfa/docs/report.html"),
  row(29, "image", "The dock overlapping the console", "/trees/alfa/docs/shot.png"),
  row(28, "link", "The handback plan", "http://127.0.0.1:7473/report.html"),
  row(27, "file", "The console lag profile", "/trees/alfa/docs/lag.md"),
  row(26, "file", "A second report", "/trees/alfa/docs/report-2.html"),
];

test("the page's kinds are the store's DELIVER_KINDS, in its order — never a fourth invented one", () => {
  assert.deepEqual([...K.KINDS], [...DELIVER_KINDS], "the chips and the store must name the same kinds");
  assert.deepEqual(new Set(K.KINDS), new Set(["link", "file", "image"]), "and there is no 'other'");
  // The page is a classic script and cannot import the store's constant, so the coupling is pinned here instead:
  // a kind the store would refuse to record must never get a chip.
  for (const kind of K.KINDS) {
    assert.match(K.GLYPH[kind], /[\u{1F300}-\u{1FAFF}\u{1F500}-\u{1F5FF}]/u, `${kind} has a glyph`);
  }
});

test("all on by default: every row is visible, every kind has a chip, nothing is switched off", () => {
  assert.deepEqual(K.presentKinds(ENTRIES), ["link", "file", "image"], "a kind with rows gets a chip, in canonical order");
  assert.deepEqual(K.onKinds(ENTRIES, []), ["link", "file", "image"], "and it starts pressed");
  assert.equal(K.visible(ENTRIES, {}).length, ENTRIES.length, "an empty off-list hides nothing");
  assert.equal(K.visible(ENTRIES).length, ENTRIES.length, "and neither does no argument at all");
  // The head's sentence has not changed for the untouched list: it is still the plain total.
  assert.equal(K.countText({ shown: 5, total: 5, entries: ENTRIES }), "5 deliverables — newest first");
  assert.equal(K.countText({ shown: 1, total: 1, entries: [ENTRIES[0]] }), "1 deliverable — newest first", "one is singular");
  assert.equal(K.narrowed({}), false);
});

test("one kind off hides exactly that kind, and nothing about the stored list changes", () => {
  const before = JSON.stringify(ENTRIES);
  const shown = K.visible(ENTRIES, { off: ["image"] });
  assert.deepEqual(shown.map((e) => e.seq), [30, 28, 27, 26], "the image row is the only one gone");
  assert.ok(
    shown.every((e) => e.kind !== "image"),
    "no image survives",
  );
  assert.equal(JSON.stringify(ENTRIES), before, "the narrowing is a VIEW: the store's rows are untouched");
  assert.deepEqual(K.presentKinds(ENTRIES), ["link", "file", "image"], "the image still has rows, so its chip stays — to switch it back on");
  assert.deepEqual(K.onKinds(ENTRIES, ["image"]), ["link", "file"]);
  // Two kinds off at once is the same rule applied twice.
  assert.deepEqual(K.visible(ENTRIES, { off: ["image", "link"] }).map((e) => e.seq), [30, 27, 26]);
});

test("the chips compose with the text filter — both narrow the same list, neither wins", () => {
  // "report" alone matches the three titles/paths that say report.
  assert.deepEqual(K.visible(ENTRIES, { query: "report" }).map((e) => e.seq), [30, 28, 26]);
  // The same word with images off: the image is not in either answer, so it drops out of the intersection.
  assert.deepEqual(K.visible(ENTRIES, { query: "report", off: ["image"] }).map((e) => e.seq), [30, 28, 26]);
  // A word that only the link matches, with the link off, is the empty list — the case that has to be SAID, not
  // painted as "nothing has been delivered".
  assert.deepEqual(K.visible(ENTRIES, { query: "handback", off: ["link"] }), []);
  assert.equal(K.narrowed({ query: "handback", off: ["link"] }), true);
  // Case and surrounding space are the filter's own tolerance, unchanged by the chips.
  assert.deepEqual(K.visible(ENTRIES, { query: "  REPORT  ", off: ["file"] }).map((e) => e.seq), [28]);
  // The kind test is not a substring of the title test: a query of "image" finds no row, because no TITLE says it.
  assert.deepEqual(K.visible(ENTRIES, { query: "image" }), []);
});

test("the count reports the filtered set, not the archive's total", () => {
  // The brief's own shape: shown of total, then the kinds the count is over.
  assert.equal(K.countText({ shown: 3, total: 30, query: "report", entries: ENTRIES }), "3 of 30 · link file image");
  // With a kind off the tail names what is left, so the number and the words agree.
  assert.equal(K.countText({ shown: 2, total: 30, off: ["image"], entries: ENTRIES }), "2 of 30 · link file");
  assert.equal(K.countText({ shown: 0, total: 30, query: "handback", off: ["link"], entries: ENTRIES }), "0 of 30 · file image");
  // Every chip off is a state, not a crash: the count keeps the two numbers and names no kind.
  assert.equal(K.countText({ shown: 0, total: 30, off: [...K.KINDS], entries: ENTRIES }), "0 of 30");
  // A store that only ever delivered files names ONE kind — the count is a description, not a checklist.
  const filesOnly = ENTRIES.filter((e) => e.kind === "file");
  assert.equal(K.countText({ shown: 2, total: 3, query: "report", entries: filesOnly }), "2 of 3 · file");
  // Nothing narrowed: the sentence the page has always shown.
  assert.equal(K.countText({ shown: 5, total: 5, entries: ENTRIES }), "5 deliverables — newest first");
});

test("a kind with no rows gets no chip — the dead chip is hidden, never greyed", () => {
  const filesOnly = ENTRIES.filter((e) => e.kind === "file");
  assert.deepEqual(K.presentKinds(filesOnly), ["file"], "only the kind the popup actually holds");
  assert.deepEqual(K.presentKinds([]), [], "an empty store has no chip at all");
  assert.deepEqual(K.presentKinds([row(1, "link", "only a link", "http://x/y")]), ["link"]);
  // The page hides the chip rather than dimming it: a control that can never do anything is not drawn.
  const paint = sliceRegion(list, "deliverables");
  assert.match(paint, /chip\.hidden\s*=\s*!on/, "the paint hides a chip for a kind with no rows");
  assert.match(paint, /group\.hidden\s*=\s*shown\.length === 0/, "and hides the group when no kind has a row");
});

test("the state is the paint's INPUT: a repaint re-reads it instead of rebuilding it", () => {
  const off = ["image"];
  const first = K.visible(ENTRIES, { off });
  const countFirst = K.countText({ shown: first.length, total: ENTRIES.length, off, entries: ENTRIES });
  // A repaint: the list is rebuilt from a NEW array (that is what every deliverable frame does), the state is the
  // same object the page holds. The narrowing is unchanged, because nothing in the paint path writes it.
  const repainted = [row(31, "file", "Delivered while the list was open", "/trees/alfa/docs/new.html"), ...ENTRIES];
  const second = K.visible(repainted, { off });
  assert.equal(second.filter((e) => e.kind === "image").length, 0, "the kind stays off through the repaint");
  assert.deepEqual(second.map((e) => e.seq), [31, ...first.map((e) => e.seq)], "and the new row arrives filtered by the same state");
  assert.equal(K.countText({ shown: second.length, total: repainted.length, off, entries: repainted }), "5 of 6 · link file");
  assert.notEqual(K.countText({ shown: second.length, total: repainted.length, off, entries: repainted }), countFirst, "the numbers move with the list; the narrowing does not");
  // The source half: the paint function must never assign the state it reads, or a frame would reset the chips.
  const paint = sliceRegion(list, "deliverables");
  const body = paint.slice(paint.indexOf("function paintDeliverRows"), paint.indexOf("// A row: a glyph by kind"));
  assert.ok(body.length > 500, "the paint function was found");
  assert.doesNotMatch(body, /deliver\.kindsOff\s*=/, "the paint never writes kindsOff");
  assert.doesNotMatch(body, /deliver\.filter\s*=/, "…and never writes the text filter either");
  assert.match(paint, /kindsOff:\s*\[\]/, "the state starts as ALL ON, an empty off-list");
  assert.match(paint, /deliver\.kindsOff\s*=\s*window\.wtDeliverKinds\.KINDS\.filter/, "only a chip press assigns it");
});

test("the empty list says which narrowing emptied it", () => {
  assert.equal(K.emptyText({ query: "handback" }), "nothing matches “handback”.");
  assert.equal(K.emptyText({ query: "handback", off: ["link"] }), "nothing matches “handback”.");
  assert.equal(K.emptyText({ off: [...K.KINDS] }), "every kind is switched off — press a chip to see those rows again.");
  assert.equal(K.emptyText({}), "nothing matches the kinds left on.");
});
