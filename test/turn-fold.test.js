// The transcript's fold book, and the gesture the pager now makes with it.
//
// Paging used to move the window and nothing else: going up and back down left every turn on the way exactly as it
// was, so a reader who walked a thirty-turn thread with the arrows still had a page of open transcripts at the end.
// This file proves the rule that replaced it, and the one place the rule is written:
//
//   1. a turn has two copies under two keys, and the pinned copy is folded until the reader opens it — even when the
//      turn it was cloned from is the newest one and therefore open;
//   2. a page holds the newest five turns, and the offset counts BACK from there (seven turns -> two pages, "3–7"
//      then "1–2"), with a remembered offset clamped to the pages that still exist;
//   3. paging past a page folds every turn on it, and coming back down folds the page that was only passed through:
//      the arrows end a thread with every turn closed;
//   4. the pinned copy is never folded by that gesture — it sits above the page on EVERY page, so it is not "the page
//      I left" — and the reader's own click still closes it;
//   5. `reveal` unfolds, un-freezes and pages in one turn: the assistant's "open this turn" and the panel's three jump
//      paths all mean that, and none of them may leave the pager on a page the turn is not on;
//   6. Collapse all / Expand all and the Ctrl+[ turns tier move both copies, because that gesture asks for every turn;
//   7. nothing outside public/core/turn-fold.js writes the three books, every file that draws the card goes through it,
//      the module is loaded before app.js, and the page arithmetic is not spelled a second time in app.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/core/turn-fold.js");
const fold = globalThis.wtTurnFold;

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
// The card itself moved out of app.js with step 7 of docs/reports/module-map-2026-11-07.html: renderJobs,
// conversationHtml and turnBlock live in public/render-jobs.js now, and they are card renderers too.
const jobs = readFileSync(new URL("../public/render-jobs.js", import.meta.url), "utf8");
const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// A page-shaped state: exactly the three books the module owns, plus the two sets the card reads beside them.
function page(turns = [], { pinned = [], page: at = 0 } = {}) {
  const state = { turnOpen: new Map(), turnCompact: new Set(), turnPage: new Map(), pinnedTurns: new Set(pinned) };
  if (at) state.turnPage.set("t", at);
  return { state, turns };
}

// Seven settled turns, oldest first: the smallest thread that has two pages, so paging has somewhere to go.
const turns = Array.from({ length: 7 }, (_, i) => ({ id: `turn-${i + 1}` }));
const idsOf = (state) => [...state.turnOpen].map(([k, v]) => `${k}:${v ? "open" : "closed"}`).sort();

// ---- 1. two copies, one identity ------------------------------------------------------------------------------
test("a turn's two copies have two keys, and the pinned one is folded until the reader opens it", () => {
  assert.equal(fold.key("t1"), "t1", "the turn in its page is keyed by its id");
  assert.equal(fold.key("t1", fold.PIN), "pin:t1", "the pinned copy is the same id behind the pin marker");
  assert.equal(fold.idOf("pin:t1"), "t1", "a pin key names the turn it was cloned from — that is how a prune finds it");
  assert.equal(fold.idOf("pin:t1"), fold.idOf("t1"), "both copies agree on the turn");
  assert.equal(fold.isPinCopy("pin:t1"), true);
  assert.equal(fold.isPinCopy("t1"), false);

  const { state } = page(turns);
  assert.equal(fold.isOpen(state, turns[6], turns[6].id), true, "with nothing written, a card opens on its newest turn");
  assert.equal(fold.isOpen(state, turns[0], turns[6].id), false, "and lists every older one as a line");
  assert.equal(fold.isOpen(state, turns[6], turns[6].id, fold.PIN), false, "the pinned copy of the newest starts folded");
  assert.equal(fold.isOpen(state, turns[0], turns[6].id, fold.PIN), false, "and so does every other pin");

  // The reader's click is the only thing that opens a pin, and it opens THAT copy alone.
  assert.equal(fold.toggle(state, turns[6], turns[6].id, fold.PIN), true, "a click opens the pinned copy");
  assert.equal(fold.isOpen(state, turns[6], turns[6].id, fold.PIN), true);
  assert.equal(fold.isOpen(state, turns[6], turns[6].id), true, "the copy in the page is still the newest and still open");
  assert.deepEqual(idsOf(state), ["pin:turn-7:open"]);

  // …and the copy in the page can be closed under the pin without closing it.
  fold.toggle(state, turns[6], turns[6].id);
  assert.deepEqual(idsOf(state), ["pin:turn-7:open", "turn-7:closed"], "one click closes one copy");
});

test("opening a turn clears its snippet — an open turn cannot also be frozen", () => {
  const { state } = page(turns);
  fold.freeze(state, turns[0]);
  assert.equal(state.turnCompact.has("turn-1"), true);
  assert.equal(fold.toggle(state, turns[0], turns[6].id), true, "the click opens it (it was not the newest)");
  assert.equal(state.turnCompact.has("turn-1"), false, "and the frozen form is gone with the fold it described");
});

// ---- 2. the arithmetic ----------------------------------------------------------------------------------------
test("a page is the newest five turns, and the offset counts back from there", () => {
  assert.equal(fold.PER_PAGE, 5, "the card's own number, and the only place it is written");
  assert.equal(fold.pages(0), 1, "a card is never zero pages wide");
  assert.equal(fold.pages(1), 1);
  assert.equal(fold.pages(5), 1);
  assert.equal(fold.pages(6), 2);
  assert.equal(fold.pages(7), 2, "seven turns is two pages");

  assert.deepEqual(fold.range(7, 0), { offset: 0, pages: 2, start: 2, end: 7 }, "page one is turns 3–7: \"3–7 / 7\"");
  assert.deepEqual(fold.range(7, 1), { offset: 1, pages: 2, start: 0, end: 2 }, "page two is turns 1–2: \"1–2 / 7\"");
  assert.deepEqual(fold.range(7, 9), fold.range(7, 1), "an offset past the oldest page is the oldest page");
  assert.deepEqual(fold.range(7, -3), fold.range(7, 0), "and a negative one is the newest");
  assert.deepEqual(fold.range(0, 0), { offset: 0, pages: 1, start: 0, end: 0 }, "an empty thread has an empty page");

  // The remembered offset is clamped to the pages that exist now: the store trims old turns, and a page index from
  // before the trim would show nothing at all.
  const { state } = page(turns, { page: 4 });
  assert.equal(fold.offset(state, "t", 7), 1, "clamped to the oldest page a seven-turn thread has");
  assert.equal(fold.offset(state, "t", 40), 4, "and a longer thread has no reason to clamp it");
});

test("one arrow press names the page it left and the page it lands on", () => {
  const { state } = page(turns);
  const older = fold.stepPage(state, "t", turns.length, "older");
  assert.deepEqual(older, { from: 0, to: 1, left: { offset: 0, pages: 2, start: 2, end: 7 } }, "up lands on turns 1–2");
  assert.equal(state.turnPage.get("t"), 1, "and the card remembers it");

  const newer = fold.stepPage(state, "t", turns.length, "newer");
  assert.deepEqual(newer, { from: 1, to: 0, left: { offset: 1, pages: 2, start: 0, end: 2 } }, "down lands back on turns 3–7");
  assert.equal(state.turnPage.has("t"), false, "the newest page is the absence of a page, not a stored 0");

  assert.equal(fold.stepPage(state, "t", turns.length, "newer"), null, "an arrow at its own end moved nothing");
  assert.equal(fold.stepPage(state, "t", 3, "older"), null, "a thread with one page has nowhere to go");
});

test("pageForIndex is the inverse of the range: the page that SHOWS a turn", () => {
  assert.equal(fold.pageForIndex(7, 6), 0, "the newest turn is on page 0");
  assert.equal(fold.pageForIndex(7, 2), 0, "so is the third turn, because page 0 is turns 3–7: this thread does not divide evenly");
  assert.equal(fold.pageForIndex(7, 1), 1, "the turn before it is on page 1");
  assert.equal(fold.pageForIndex(7, 0), 1, "…and so is the oldest");
  assert.equal(fold.pageForIndex(12, 0), 2, "twelve turns put the oldest on page 2");
  assert.equal(fold.pageForIndex(12, 11), 0);
  assert.equal(fold.pageForIndex(0, 0), 0, "an empty thread answers the only page there is");
  for (const total of [1, 5, 6, 7, 11, 12]) {
    for (let index = 0; index < total; index += 1) {
      const pageAt = fold.pageForIndex(total, index);
      const r = fold.range(total, pageAt);
      assert.ok(index >= r.start && index < r.end, `${total} turns: turn ${index} is inside the page its own offset names`);
    }
  }
});

// ---- 3. the gesture -------------------------------------------------------------------------------------------
test("paging past a page folds every turn on it, and up then down closes the whole thread", () => {
  const { state } = page(turns);
  assert.deepEqual(idsOf(state), [], "nothing written yet: the newest turn is open by default");

  // Up: the page being read (turns 3–7, with turn 7 open) is left, so all five fold.
  const older = fold.stepPage(state, "t", turns.length, "older");
  fold.foldPage(state, turns, older.left.offset);
  assert.deepEqual(
    idsOf(state),
    ["turn-3:closed", "turn-4:closed", "turn-5:closed", "turn-6:closed", "turn-7:closed"],
    "every turn on the page just left is closed, including the one the card opened on",
  );
  assert.equal(fold.isOpen(state, turns[6], turns[6].id), false, "and the newest turn does not re-open itself: the entry says closed");
  assert.equal(fold.isOpen(state, turns[0], turns[6].id), false, "turns 1–2 were folded all along");

  // Down: the page that was only passed through (turns 1–2) folds too.
  const newer = fold.stepPage(state, "t", turns.length, "newer");
  fold.foldPage(state, turns, newer.left.offset);
  assert.equal(
    [...state.turnOpen.values()].every((open) => open === false),
    true,
    "after up and back down there is no open turn left: that is the collapse gesture",
  );
  assert.equal(state.turnOpen.size, 7, "an entry per turn, and no pin entries invented on the way");
});

test("the pinned copy survives the gesture; only the reader's click closes it", () => {
  const { state } = page(turns, { pinned: ["turn-7", "turn-4"] });
  fold.toggle(state, turns[6], turns[6].id, fold.PIN); // the reader opens the pin of turn 7
  fold.toggle(state, turns[3], turns[3].id, fold.PIN); // …and of turn 4

  const older = fold.stepPage(state, "t", turns.length, "older");
  fold.foldPage(state, turns, older.left.offset);
  assert.equal(fold.isOpen(state, turns[6], turns[6].id, fold.PIN), true, "turn 7's pinned copy is still open");
  assert.equal(fold.isOpen(state, turns[3], turns[3].id, fold.PIN), true, "so is turn 4's, though neither is on the page");
  assert.equal(fold.isOpen(state, turns[6], turns[6].id), false, "the copies IN the page folded with it");
  assert.equal(fold.isOpen(state, turns[3], turns[3].id), false);

  const newer = fold.stepPage(state, "t", turns.length, "newer");
  fold.foldPage(state, turns, newer.left.offset);
  assert.equal(fold.isOpen(state, turns[6], turns[6].id, fold.PIN), true, "coming back down did not close them either");

  // The pin is still an accordion with a reader's handle on it.
  fold.toggle(state, turns[6], turns[6].id, fold.PIN);
  assert.equal(fold.isOpen(state, turns[6], turns[6].id, fold.PIN), false, "the reader's click closes it");
});

// ---- 5. reveal ------------------------------------------------------------------------------------------------
test("reveal puts one turn in front of the reader: open, un-frozen, on its own page", () => {
  const { state } = page(turns, { page: 1 }); // the reader has walked back to turns 1–2
  assert.equal(fold.offset(state, "t", 7), 1);

  const shown = fold.reveal(state, "t", turns, "turn-6");
  assert.deepEqual(shown, { found: true, changed: true, page: 0 }, "turn 6 lives on the newest page");
  assert.equal(fold.isOpen(state, turns[5], turns[6].id), true, "it is unfolded");
  assert.equal(fold.offset(state, "t", 7), 0, "and the pager is moved to the page that shows it — the console exists there");

  assert.equal(fold.reveal(state, "t", turns, "turn-6").changed, false, "a second call changed nothing, so no repaint");
  assert.equal(fold.reveal(state, "t", turns, "gone").found, false, "an id the thread no longer has is answered, not guessed");
  assert.equal(fold.reveal(state, "t", turns, "gone").changed, false);
  assert.equal(state.turnPage.has("t"), false, "…and the page it was already on is untouched");

  // A frozen turn is revealed as a whole turn, not as a snippet.
  fold.setOpen(state, "turn-3", false);
  fold.freeze(state, "turn-3");
  assert.deepEqual(fold.reveal(state, "t", turns, "turn-3"), { found: true, changed: true, page: 0 }, "turn 3 is on the newest page");
  assert.equal(state.turnCompact.has("turn-3"), false);
  assert.equal(fold.isOpen(state, turns[2], turns[6].id), true);
});

// ---- 6. every turn, both copies -------------------------------------------------------------------------------
test("Collapse all and the Ctrl+[ turns tier move both copies", () => {
  const { state } = page(turns, { pinned: ["turn-2"] });
  fold.foldAll(state, turns, state.pinnedTurns, true);
  assert.deepEqual(idsOf(state), [...turns.map((t) => `${t.id}:open`), "pin:turn-2:open"].sort(), "expand all opens both");

  fold.foldAll(state, turns, state.pinnedTurns, false);
  assert.deepEqual(idsOf(state), [...turns.map((t) => `${t.id}:closed`), "pin:turn-2:closed"].sort(), "collapse all closes both");

  const nothingPinned = page(turns);
  fold.foldAll(nothingPinned.state, turns, nothingPinned.state.pinnedTurns, false);
  assert.equal(nothingPinned.state.turnOpen.size, 7, "an unstarred turn has no pin entry to invent");
});

test("a cleared job takes its fold entries, and a cleared thread its page", () => {
  const { state } = page(turns, { pinned: ["turn-1"] });
  fold.setOpen(state, "turn-1", true);
  fold.setOpen(state, "turn-1", true, fold.PIN);
  fold.freeze(state, "turn-1");
  fold.setOpen(state, "turn-2", false);

  const forgotten = fold.prune(state, { turnIds: new Set(["turn-2"]), threads: new Set() });
  assert.equal(forgotten, 2, "the turn and its pinned copy both go — the pin is pruned on the turn it belongs to");
  assert.deepEqual(idsOf(state), ["turn-2:closed"], "the live turn keeps the entry the reader made");
  assert.equal(state.turnCompact.has("turn-1"), false, "a forgotten turn takes its snippet with it");
  assert.equal(state.turnPage.has("t"), false, "a thread the board no longer draws keeps no page");

  fold.setOffset(state, "kept", 2);
  fold.prune(state, { turnIds: new Set(["turn-2"]), threads: new Set(["kept"]) });
  assert.equal(state.turnPage.get("kept"), 2, "a live thread's page is untouched");
});

// ---- 7. one owner ---------------------------------------------------------------------------------------------
test("the books are written only in the module, and both card renderers go through it", () => {
  // No file outside the module writes `turnOpen` / `turnCompact` / `turnPage`: every gesture above has an API here.
  for (const [name, src] of [
    ["public/app.js", app],
    ["public/render-jobs.js", jobs],
    ["public/assistant.js", assistant],
  ]) {
    for (const book of ["turnOpen", "turnCompact", "turnPage"]) {
      assert.doesNotMatch(
        src,
        new RegExp(`state\\.${book}\\.(?:set|delete|add|clear)\\(`),
        `${name} writes state.${book} directly — that write belongs in public/core/turn-fold.js`,
      );
    }
    assert.match(src, /wtTurnFold\./, `${name} draws a card, so it must go through the fold module`);
  }

  // The assistant used to read the fold book itself (a second owner, and one that could not page). It no longer reads
  // it at all: its one path into a turn is `reveal`.
  assert.doesNotMatch(assistant, /state\.turn(?:Open|Page|Compact)\.(?:get|set|has|delete|add|clear)\(/);
  assert.match(assistant, /wtTurnFold\.reveal\(/, "the queue row's 'open this turn' is the module's reveal");

  // The page arithmetic has one spelling too: the module slices, counts and steps. renderJobs draws the page and
  // moved to public/render-jobs.js with step 7 of the module map; the arrow press stayed in app.js.
  assert.doesNotMatch(app, /TURNS_PER_PAGE/, "the page size is the module's constant, not a second local one");
  assert.doesNotMatch(app, /turnPageOffset/, "the offset is asked for, not recomputed beside the renderer");
  assert.doesNotMatch(jobs, /TURNS_PER_PAGE/, "the page size is the module's constant, not a second local one");
  assert.match(jobs, /wtTurnFold\.range\(/, "the page's slice is the module's range");
  assert.match(app, /wtTurnFold\.stepPage\(/, "an arrow press is the module's step");
  assert.match(app, /wtTurnFold\.foldPage\(/, "and the page it left is folded by the module");

  // Loaded before app.js, which reads it at render time; assistant.js is the second caller, never a second owner.
  const foldAt = html.indexOf('src="/core/turn-fold.js"');
  const appAt = html.indexOf('src="/app.js"');
  const assistantAt = html.indexOf('src="/assistant.js"');
  assert.ok(foldAt > 0, "the page loads the module");
  assert.ok(foldAt < appAt, "before app.js");
  assert.ok(assistantAt > appAt, "and assistant.js still loads after app.js, where its card renderer lives");
});
