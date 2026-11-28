// The tag rules the pane draws with: the chip cap, the filter function and the URL record.
//
// WHY THIS FILE EXISTS, beside test/initiative-tags-store.test.js. Every rule here has a wrong answer that still looks
// right on a screenshot:
//
//   1. THE CHIP CAP IS THREE. A card with seven tags that draws seven chips pushes the "#N waves" chip off a narrow
//      rail; a card that draws "the first three" and no +N hides the rest with nothing saying so. The split is a
//      function here so the head and the number cannot disagree.
//   2. THE FILTER IS TWO RULES IN ONE CONTROL. "any" and "all" are different questions, an untagged card is out under
//      either, and NO selected tag is NO filter - the last one is what keeps the row's default (every tag pressed)
//      showing the whole board and stops a reader who unpressed everything from staring at an empty pane.
//   3. THE URL RECORD IS THE SHAREABLE HALF. "all pressed" writes nothing, a list writes `initTags=`, and "all" adds
//      its mode - so the shortest URL is the commonest state and a pasted link lands on the same filtered board.
//
// The pure functions are loaded the way the page loads them (public/core/initiative-fold.js publishes itself on
// globalThis), and the pane's use of them is pinned by reading the files it is built from - the same contract
// test/initiative-fold.test.js uses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readStyleSheets } from "./style-sheets.js";

await import("../public/core/initiative-fold.js");
const fold = globalThis.wtInitiativeFold;
const { TAG_CHIP_FIRST, tagChips, tagFilterMatch, tagFilterParse, tagFilterQuery, tagFilterFromUrl } = fold;

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const style = readStyleSheets();
// The prefix is answered by two files after row 515: routes/initiatives.js keeps the guard, the fold and the memo,
// and routes/initiatives-write.js holds the tag registry and every write the assertions below read for.
const route = [
  readFileSync(new URL("../routes/initiatives.js", import.meta.url), "utf8"),
  readFileSync(new URL("../routes/initiatives-write.js", import.meta.url), "utf8"),
].join("\n");

const tags = (...idents) => idents.map((ident, at) => ({ id: `tag_${at + 1}`, ident, name: `${ident} tag`, color: "violet" }));

test("the chip cap is three: the head is the first three and the +N names exactly what is left", () => {
  assert.equal(TAG_CHIP_FIRST, 3);
  const two = tagChips(tags("SSO", "DMR"));
  assert.deepEqual(two.head.map((t) => t.ident), ["SSO", "DMR"]);
  assert.equal(two.hidden, 0, "a card that fits draws no +N");
  assert.deepEqual(two.rest, []);

  const five = tagChips(tags("SSO", "DMR", "OPS", "QA", "INF"));
  assert.deepEqual(five.head.map((t) => t.ident), ["SSO", "DMR", "OPS"]);
  assert.deepEqual(five.rest.map((t) => t.ident), ["QA", "INF"]);
  assert.equal(five.hidden, 2);
  assert.equal(five.total, 5);
  assert.equal(five.head.length + five.rest.length, five.total, "no tag is lost between the two halves");

  // A hand-edited list with a hole in it draws nothing for the hole rather than a chip with no word on it.
  const holed = tagChips([null, { id: "tag_x", ident: "X", name: "x" }]);
  assert.deepEqual(holed.head.map((t) => t.ident), ["X"]);
});

test("the filter: any, all, untagged cards, and the empty selection that means no filter", () => {
  const sso = "tag_1";
  const dmr = "tag_2";
  const both = [sso, dmr];

  assert.equal(tagFilterMatch([], [], "any"), true, "nothing pressed is no filter");
  assert.equal(tagFilterMatch([sso], [], "all"), true);
  assert.equal(tagFilterMatch([], [sso], "any"), false, "an untagged card is out under any selection");
  assert.equal(tagFilterMatch([], [sso], "all"), false);
  assert.equal(tagFilterMatch([sso], [sso], "any"), true);
  assert.equal(tagFilterMatch([sso], both, "any"), true, "any: one of them is enough");
  assert.equal(tagFilterMatch([sso], both, "all"), false, "all: every one of them");
  assert.equal(tagFilterMatch(both, both, "all"), true);
  assert.equal(tagFilterMatch(["tag_9"], [sso], "any"), false);
  // A missing tagIds field is the legacy record, and it behaves like an empty list.
  assert.equal(tagFilterMatch(undefined, [sso], "any"), false);
  // A string in the payload (a hand edit) is coerced, not thrown on.
  assert.equal(tagFilterMatch(sso, [sso], "any"), false, "a string is not a list");
});

test("the URL record: default writes nothing, a list writes initTags, all adds its mode", () => {
  assert.equal(tagFilterQuery({ tags: null, mode: "any" }), "");
  assert.equal(tagFilterQuery({ tags: [], mode: "all" }), "", "nothing pressed is nothing to persist");
  assert.equal(tagFilterQuery({ tags: ["tag_1", "tag_2"], mode: "any" }), "initTags=tag_1%2Ctag_2");
  assert.equal(tagFilterQuery({ tags: ["tag_1"], mode: "all" }), "initTags=tag_1&initTagMode=all");
  // Deduped and trimmed on the way out, exactly as on the way in.
  assert.equal(tagFilterQuery({ tags: [" tag_1 ", "tag_1", ""], mode: "any" }), "initTags=tag_1");

  assert.equal(tagFilterFromUrl(""), null, "no parameter means the reader has never filtered");
  assert.equal(tagFilterFromUrl("?perf=1"), null);
  assert.deepEqual(tagFilterFromUrl("?initTags=tag_1,tag_2&initTagMode=all"), { tags: ["tag_1", "tag_2"], mode: "all" });
  assert.deepEqual(tagFilterFromUrl("?initTags=tag_1"), { tags: ["tag_1"], mode: "any" });
  assert.deepEqual(tagFilterFromUrl("?initTags="), { tags: [], mode: "any" }, "an empty list is a filter with nothing pressed");
  assert.deepEqual(tagFilterFromUrl("?initTags=tag_1&initTagMode=nonsense"), { tags: ["tag_1"], mode: "any" });
  assert.deepEqual(tagFilterParse(" a, b ,, a "), ["a", "b"]);
});

test("the card draws its tags AFTER the waves chip, on the folded and the open card, from initTagChipsHtml", () => {
  const card = assistant.indexOf("${statusHtml}");
  const chips = assistant.indexOf("${initTagChipsHtml(init, open)}");
  assert.ok(card > 0, "the card's status chip is where this test expects it");
  assert.ok(chips > card, "the tag chips sit AFTER the status chip, in the same facts row");
  assert.ok(assistant.includes("function initTagChipsHtml(init, open)"));
  // Both card forms call the one helper: the active card with its own open state, the archived card always expanded.
  assert.ok(assistant.includes("${initTagChipsHtml(init, true)}"), "the archived card draws the same chips");
  // The +N chip lists the rest on the expanded card, and opens the card when it is folded.
  assert.ok(assistant.includes('data-init-tags-more="${esc(id)}"'));
  assert.ok(assistant.includes("initTagsMore.add(id)"));
  assert.ok(assistant.includes("initOpen.add(id)"), "a press on a folded card's +N opens the card too");
});

test("a tag chip is its own class, not the count .chip, and the ten colours are in the sheet", () => {
  assert.ok(assistant.includes('class="init-tag init-tag-'));
  assert.ok(!/class="chip init-tag/.test(assistant), "a tag never wears the count chip's class");
  assert.ok(style.includes("#as-initiatives .init-tag {"));
  for (const color of ["slate", "red", "amber", "olive", "green", "teal", "sky", "blue", "violet", "pink"]) {
    assert.ok(style.includes(`#as-initiatives .init-tag-${color} {`), `${color} has a swatch`);
  }
});

test("the filter row is at the top of the pane, above the cards, with any/all, a Clear and the registry editor", () => {
  const row = assistant.indexOf("${initTagFilterRowHtml()}");
  const cards = assistant.indexOf("activeShown.map((init, at) => initCardHtml");
  assert.ok(row > 0 && cards > row, "the row is drawn before the cards");
  assert.ok(assistant.includes('data-init-tagmode="any"') && assistant.includes('data-init-tagmode="all"'));
  assert.ok(assistant.includes("data-init-tagclear"));
  assert.ok(assistant.includes("data-init-tagmgr"));
  // Composed with both existing controls: the view switch above it, the archived search beside it, and both lists
  // narrowed by the same selection.
  assert.ok(assistant.includes("list.filter(tagMatch)"));
  assert.ok(assistant.includes("initArchivedMatches(init, initSearch) && tagMatch(init)"));
  // Persisted both ways, and only on a press.
  assert.ok(assistant.includes('const INIT_TAG_FILTER_KEY = "wm.initiativeTagFilter"'));
  assert.ok(assistant.includes("history.replaceState"));
  assert.ok(assistant.includes("wtInitiativeFold.tagFilterFromUrl(location.search)"));
});

test("the registry's four verbs are on the route, and the three writes are the reader's alone", () => {
  assert.ok(route.includes("export const TAGS_PATH = `${INITIATIVES_PATH}/tags`"));
  assert.ok(route.includes('req.method === "PATCH"'));
  // DELETE is the method left after POST and PATCH, and the guard above its block says so rather than leaving the last
  // branch implicit - a PATCH that fell through into the delete path would be the worst bug on this prefix.
  assert.ok(route.includes('if (req.method !== "DELETE")'));
  assert.match(route, /tags are the reader's to create, rename and delete/);
  assert.ok(route.includes("initiatives.carriersOfTag(id)"));
  assert.ok(route.includes("initiatives.dropTag({ id, by })"));
  // The initiative create/update routes carry tagIds through to the store, which is where an unknown id is refused.
  assert.ok(route.includes("tagIds: payload.tagIds"));
  assert.ok(route.includes("initiatives.update({ id: existing.id, title: payload.title, description: payload.description, tagIds: payload.tagIds, by })"));
});
