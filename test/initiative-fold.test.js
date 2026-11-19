// The Initiatives tab's two folds and its chip strip: public/core/initiative-fold.js, and the pane that draws it.
//
// WHY THIS FILE EXISTS. Three rules behind PR #791's addendum are decided in an event handler or in a painter, and
// each has a wrong answer that still looks right on a screenshot:
//
//   1. A PRESS INSIDE AN INITIATIVE CARD means one of four things. Answering "the card toggles" for every press
//      folds the initiative out from under a reader who pressed a worktree link; answering "only controls act" leaves
//      the title card dead. The description's header is a button, so it is the one control that must be answered
//      BEFORE the generic "acts on itself" rule - otherwise collapsing the description would also collapse the card.
//   2. A FOLDED DESCRIPTION is the first two lines and three dots - and the dots are a lie when the text fits, or
//      when the cut halved a word. Where the layout's cut lands is measured in the browser; what happens to it (back
//      up to a whole word, no dots past the end) is the rule pinned here.
//   3. THE PER-ASSISTANT STRIP is four chips, always, in one fixed order. A strip that grew a chip when a count
//      stopped being zero would shift the row sideways every time work moved, and a fourth colour would read as a
//      fourth kind of thing.
//
// The rules are pure functions so they can be answered without a browser; the pane's use of them is pinned by
// reading the files it is built from, the way test/turn-fold.test.js pins its own module's load contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/core/initiative-fold.js");
const fold = globalThis.wtInitiativeFold;
const { DOTS, PREVIEW_LINES, press, cut, countChips } = fold;

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const route = readFileSync(new URL("../routes/initiatives.js", import.meta.url), "utf8");

// A node whose `closest` answers the selectors it is given: the press landed on an element, or inside one, that
// matches those. That is the only thing the rule asks a node - which of the two card selectors answers first - so a
// stub is enough, and the DOM is not. A comma list in the selector is answered by any of its parts, which is what
// "this press lands inside a button" means to `closest`.
const hit = (...selectors) => {
  const node = {
    closest(selector) {
      const parts = String(selector).split(",").map((s) => s.trim());
      return parts.some((s) => selectors.includes(s)) ? node : null;
    },
  };
  return node;
};
const CARD = { contains: () => true };
const ELSEWHERE = { contains: () => false };

// ---- 1. what a press inside a card means ------------------------------------------------------------------------
test("the title card folds the initiative: the head, the words on it and the dead space of a folded card", () => {
  // The head button IS a button, and a rule that asks "is it a button?" before "is it the head?" answers "acts on
  // itself" for every press on the title - which is how the card stops folding. The live gate caught exactly that,
  // so this case is written the way the DOM is: a button that carries the title-card marker.
  assert.equal(press(hit("[data-init-card-toggle]", "button"), { card: CARD, open: true }), "card", "the head folds an open card");
  assert.equal(press(hit("[data-init-card-toggle]", "button"), { card: CARD, open: false }), "card", "and unfolds a folded one");
  assert.equal(press(hit(), { card: CARD, open: false }), "card", "a folded card is all title card: anywhere on it unfolds it");
  assert.equal(press(hit("button"), { card: CARD, open: false }), "self", "…except a control, which still acts on itself - a press that does something must never also fold the card");
  assert.equal(press(hit(), { card: CARD, open: true }), "none", "the open body's dead space does nothing - folding a card a reader is reading is worse than a press that does nothing");
  assert.equal(press(hit("[data-init-act]"), { card: CARD, open: true }), "self", "an element that says it acts on itself is believed");
});

test("the description's header folds only the description, and it is answered before the generic rule", () => {
  // It IS a button, so the "acts on itself" rule would swallow it: the order in `press` is the whole point of this
  // test, because the wrong order folds the card when the reader only wanted the description.
  const header = hit("[data-init-desc-fold]", "button");
  assert.equal(press(header, { card: CARD, open: true }), "description");
  assert.notEqual(press(header, { card: CARD, open: true }), "self");
  assert.notEqual(press(header, { card: CARD, open: true }), "card");
});

test("a project fold, a worktree link, an assistant's name and Edit act on themselves and leave the card alone", () => {
  for (const target of [
    hit("button", "[data-init-fold]"),
    hit("a", "[data-init-open]"),
    hit("button", "[data-init-assistant]"),
    hit("button", "[data-init-edit]"),
    hit("button", "[data-init-add]"),
    hit("textarea", "[data-init-field]"),
  ]) {
    assert.equal(press(target, { card: CARD, open: true }), "self");
  }
});

test("a press outside the card is not this pane's, and a press with no target at all is nothing", () => {
  assert.equal(press(hit("a"), { card: ELSEWHERE, open: true }), "outside", "a link elsewhere on the board");
  assert.equal(press(null, { card: CARD, open: true }), "none", "a synthetic event never folds anything");
  assert.equal(press(undefined, {}), "none");
});

// ---- 2. the folded description's text ---------------------------------------------------------------------------
test("a description that fits its two lines is whole, with no dots", () => {
  const short = "Move the Menu onto Okta SSO.";
  assert.deepEqual(cut(short, short.length), { text: short, truncated: false }, "the layout allowed the whole text");
  assert.deepEqual(cut(short, 999), { text: short, truncated: false }, "an offset past the end is no cut at all");
  assert.deepEqual(cut("", 10), { text: "", truncated: false }, "nothing to fold, nothing to mark");
});

test("a cut inside a word backs up to the space before it, so the preview never halves one", () => {
  const text = "Move the Menu and the gateway onto Okta SSO, one app at a time.";
  const at = text.indexOf("Okta") + 2; // mid-word, the way a layout's two-line break lands
  const out = cut(text, at);
  assert.equal(out.truncated, true);
  assert.equal(out.text, "Move the Menu and the gateway onto");
  assert.equal(out.text.endsWith(" "), false, "the space it backed up to is not part of the preview");
  assert.equal(text.startsWith(out.text), true, "the preview is a prefix of the description, byte for byte");
});

test("a cut that lands exactly on a word boundary keeps the whole word", () => {
  const text = "Move the Menu and the gateway onto Okta SSO and the port";
  const at = text.indexOf(" Okta"); // the break falls between two words
  assert.deepEqual(cut(text, at), { text: "Move the Menu and the gateway onto", truncated: true });
  const end = text.indexOf(" SSO") + 4;
  assert.deepEqual(cut(text, end), { text: "Move the Menu and the gateway onto Okta SSO", truncated: true }, "the second line's last whole word stays");
});

test("paragraph breaks survive the preview, and the dots sit where the text stops", () => {
  const text = "One line of prose that fills the first row.\nA second paragraph starts here and runs on for a while.";
  const at = text.indexOf("starts") + 3;
  const out = cut(text, at);
  assert.equal(out.text.includes("\n"), true, "the newline the description had is still there");
  assert.equal(out.text, "One line of prose that fills the first row.\nA second paragraph");
  assert.equal(`${out.text}${DOTS}`, `${out.text}...`, "three ASCII dots, the marker the folded command cards end on");
});

test("an unbreakable token, or an offset of nothing, is cut where the layout says", () => {
  const text = "abcdefghijklmnopqrstuvwxyz0123456789";
  assert.deepEqual(cut(text, 10), { text: "abcdefghij", truncated: true }, "no whitespace to back up to");
  assert.deepEqual(cut("one two", 0), { text: "", truncated: false }, "an empty preview says nothing, so no dots");
  assert.deepEqual(cut("one two", NaN), { text: "", truncated: false });
});

test("CRLF and a lone CR read as the paragraph breaks they are", () => {
  assert.deepEqual(cut("one\r\ntwo\r\nthree", 7), { text: "one\ntwo", truncated: true });
});

// ---- 3. the per-assistant strip ---------------------------------------------------------------------------------
test("the strip is four chips in the order a task moves through them, queued first", () => {
  assert.deepEqual(
    countChips({}).map((c) => c.label),
    ["queued", "running", "completed", "parked"],
  );
  assert.deepEqual(
    countChips({ queued: 2, running: 1, done: 3, parked: 4 }).map((c) => c.text),
    ["2 queued", "1 running", "3 completed", "4 parked"],
  );
});

test("all four are drawn always: a zero is a chip, not an absence", () => {
  const chips = countChips({ queued: 0, running: 0, done: 0, parked: 0 });
  assert.equal(chips.length, 4);
  assert.equal(
    chips.every((c) => c.zero && c.cls.includes("is-zero")),
    true,
    "four zeros still draw four chips, dimmed",
  );
  assert.equal(countChips({ queued: 1 }).length, 4, "one count and three zeros is still four");
  assert.equal(countChips(undefined).length, 4, "a row with no counts at all is four zeros, not a short strip");
  assert.equal(countChips({ queued: "2" })[0].count, 2, "a string count is the number it names");
  assert.equal(countChips({ queued: -3 })[0].count, 0, "a count is never negative");
});

test("the chips keep the panel's own tones - no fourth colour for the state before running", () => {
  const tones = new Set(countChips({ queued: 1, running: 1, done: 1, parked: 1 }).map((c) => c.tone));
  assert.deepEqual([...tones].sort(), ["", "good", "warn"], "quiet, good and warn are the panel's chip tones");
  assert.equal(countChips({ queued: 5 })[0].tone, "", "queued is drawn quiet, like completed");
  assert.equal(countChips({ running: 1 })[1].tone, "good");
  assert.equal(countChips({ parked: 1 })[3].tone, "warn");
  assert.equal(countChips({ queued: 0 })[0].cls, "chip is-zero", "a zero carries no tone at all");
});

test("a chip's tooltip says which bucket it counts, and counts one task as one", () => {
  const [queued] = countChips({ queued: 1 });
  assert.match(queued.title, /^1 task queued on this initiative's worktrees/);
  assert.match(countChips({ queued: 3 })[0].title, /^3 tasks queued/);
});

// ---- 4. the pane uses the module, and the two-line measure is the browser's --------------------------------------
test("the card is built from the module's rules, not from a second copy of them", () => {
  assert.match(assistant, /wtInitiativeFold\s*\n?\s*\.countChips\(/, "the strip comes from countChips");
  assert.match(assistant, /wtInitiativeFold\.press\(/, "the press rule is the module's");
  assert.match(assistant, /wtInitiativeFold\.cut\(text, initDescCutAt\(el, wtInitiativeFold\.PREVIEW_LINES\)\)/, "the cut backs the layout's offset up to a word");
  assert.match(assistant, /if \(!cut\.truncated\) return;/, "no dots when there is nothing left out");
  assert.equal(PREVIEW_LINES, 2, "a folded description is two lines");
  assert.equal(DOTS, "...", "and ends on three ASCII dots");
});

test("the two folds are two states, kept per initiative while the tab is open", () => {
  assert.match(assistant, /const initOpen = new Set\(\);/, "the card's open state is a book of its own");
  assert.match(assistant, /const initDescClosed = new Set\(\);/, "and so is the description's");
  assert.match(assistant, /const descOpen = open && !initDescClosed\.has\(init\.id\);/, "the description only folds inside an open card");
  assert.match(assistant, /const descHtml = desc && open/, "…and a title card has no description header to press");
  assert.match(assistant, /aria-expanded="\$\{open \? "true" : "false"\}"/, "the title card states its own state");
  assert.match(assistant, /aria-expanded="\$\{descOpen \? "true" : "false"\}"/, "and so does the description's header");
  assert.match(assistant, /data-init-card-toggle="\$\{esc\(init\.id\)\}"/, "the title card is one control, not a label");
  assert.match(assistant, /class="init-proj init-desc-head" data-init-desc-fold=/, "the description's header carries its own action");
});

test("both fold headers are buttons, so Enter and Space toggle them without a key handler", () => {
  // A real <button> gets Enter and Space from the browser; a div with role="button" would need a keydown branch this
  // file would then have to test. The markup is what makes the keyboard promise true.
  assert.match(assistant, /<button type="button" class="init-head-btn" data-init-card-toggle=/, "the title card");
  assert.match(assistant, /<button type="button" class="init-proj init-desc-head" data-init-desc-fold=/, "the description's header");
});

test("the module is loaded before the pane that reads it", () => {
  const mod = html.indexOf('/core/initiative-fold.js');
  const pane = html.indexOf('src="/assistant.js"');
  assert.ok(mod > 0, "index.html loads the module");
  assert.ok(pane > 0 && mod < pane, "and loads it before assistant.js");
});

test("queued is counted by the same pass that counts the other three", () => {
  assert.match(route, /const counts = \{ queued: 0, running: 0, done: 0, parked: 0 \};/);
  assert.equal((route.match(/for \(const task of mine\) \{/g) || []).length, 1, "one loop over this initiative's tasks");
  assert.equal((route.match(/counts\.queued \+= 1/g) || []).length, 1, "one place counts queued");
  const loop = route.indexOf("for (const task of mine)");
  const queued = route.indexOf('counts.queued += 1');
  const handed = route.indexOf("people.push(");
  assert.ok(queued > loop && queued < handed, "the queued count is taken inside that loop, before the row is handed to the view");
});

test("a history line names the actor and what he did, and 'reader' reads as you", () => {
  const line = (ev) => fold.historyLine(ev);
  assert.deepEqual(line({ action: "create", by: "reader", at: "2026-11-19T10:00:00.000Z" }), {
    who: "you",
    what: "created this initiative",
    at: "2026-11-19T10:00:00.000Z",
  });
  assert.equal(line({ action: "attach", by: "scout", tree: "w/alpha/.worktrees/sso-one" }).who, "scout", "an assistant keeps its id");
  assert.equal(line({ action: "attach", by: "scout", tree: "w/alpha/.worktrees/sso-one" }).what, "attached sso-one", "the leaf, not the path");
  assert.equal(line({ action: "detach", by: "reader", tree: "w/alpha/.worktrees/sso-one" }).what, "removed sso-one");
  assert.equal(line({ action: "edit", by: "scout", detail: "the description" }).what, "edited the description");
  // The time is handed back untouched: the page draws "12m ago" from its own clock, and a view module that formatted a
  // second clock would drift from the dock's.
  assert.equal(line({ action: "edit", by: "scout", at: "nonsense" }).at, "nonsense");
  assert.equal(line({ action: "edit", by: "scout" }).at, null);
  // An event this module does not know still reads as a sentence rather than `undefined`.
  assert.equal(line({ action: "explode", by: "scout" }).what, "changed this initiative");
  assert.equal(line(null).who, "you", "an empty event is a reader's, the store's own default");
  // A record with no actor is drawn as the reader the store defaults to, never as "undefined".
  assert.equal(line({ action: "create" }).who, "you");
});

test("the history fold is an accordion on the card, folded by default, and the actor and the time are on the row", () => {
  assert.match(assistant, /data-init-history-fold="\$\{esc\(init\.id\)\}"/, "the fold is a control on the initiative");
  assert.match(assistant, /const initHistoryOpen = new Set\(\);/, "folded by default: nothing is in the set until pressed");
  assert.match(assistant, /initHistoryOpen\.has\(init\.id\)/, "the card asks the set");
  assert.match(assistant, /data-init-hist-actor="\$\{esc\(line\.who\)\}"/, "the row carries the actor for the proof to read");
  assert.match(assistant, /data-init-hist-row="\$\{esc\(line\.at \|\| ""\)\}"/, "…and the time");
  assert.match(assistant, /wtInitiativeFold\.historyLine\(ev\)/, "the row's words come from the module, not from a second renderer");
  // The press handler has to answer the fold, or the button is dead markup.
  assert.match(assistant, /if \(el\.dataset\.initHistoryFold\) \{/, "the press handler answers the history fold");
  assert.match(assistant, /\[data-init-fold\], \[data-init-assist-fold\], \[data-init-history-fold\]/, "and the selector includes it");
});
