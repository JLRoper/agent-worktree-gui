// The assistant search's TURN map: public/core/search-items.js.
//
// WHAT THIS FILE IS FOR. A search hit is one FIELD of one turn - the prompt, the reply, or one console line - and
// one query can hit several of them in the SAME turn. The walk steps matches (that count is
// test/assistant-search-count.test.js's subject); this mapping is what lets every surface name the TURN a match
// belongs to - the ring round the message, the turn count in the footer, a result row's press. The mapping is the
// whole subject here:
//
//   * a turn's prompt, reply and every console line are ONE item, however many of them matched;
//   * the item's place in the list is the place of its FIRST hit, never a second ordering the list does not show;
//   * the key is thread + turn id, so the same turn id on two threads is two items and never one.
//
// THE ORDER is the second subject (`order`). The answer arrives in the cap's preference - input, then replies, then
// console lines - which decides which matches survive, not the order a reader walks them in. `order` puts the items
// newest first by their newest row, the rows inside an item in reading order, and breaks equal timestamps by the
// conversation's own numbering, so the list a Down walks is the list the popover draws.
import assert from "node:assert/strict";
import test from "node:test";
import "../public/core/search-items.js";

const { group, keyOf, order } = globalThis.wtSearchItems;

const hit = (thread, id, field, extra = {}) => ({ thread, id, turn: Number(id.replace(/\D/g, "")) || 0, field, ...extra });

test("four hits in one turn are one item, in the order the hits first appear", () => {
  const hits = [
    hit("panel-assistant", "t3", "input"),
    hit("panel-assistant", "t3", "reply"),
    hit("panel-assistant", "t3", "tool"),
    hit("panel-assistant", "t3", "tool"),
    hit("panel-assistant", "t2", "input"),
    hit("panel-assistant", "t1", "reply"),
  ];
  const items = group(hits);
  assert.equal(items.length, 3, "three turns, not six hits");
  assert.deepEqual(
    items.map((i) => i.id),
    ["t3", "t2", "t1"],
    "the item order is the hit order, so the list and the walk agree",
  );
  assert.equal(items[0].hits.length, 4, "every hit of the turn is kept on the item");
  assert.deepEqual(items[0].fields, ["input", "reply", "tool"], "the fields it matched in, once each");
  assert.equal(items[0].turn, 3, "the store's own turn counter rides along");
  assert.equal(items[1].hits.length, 1);
  assert.equal(items[0].hits[0], hits[0], "the item holds the hit objects themselves, not copies");
});

test("a list of hits collapses to the turns it touches, one entry per message", () => {
  const hits = [
    hit("panel-assistant", "a", "input"),
    hit("panel-assistant", "a", "reply"),
    hit("panel-assistant", "b", "input"),
    hit("panel-assistant", "c", "input"),
    hit("panel-assistant", "c", "tool"),
  ];
  const items = group(hits);
  assert.equal(items.length, 3);
  // The footer's turn count is this length: five matching rows, three messages.
  assert.deepEqual(
    items.map((i) => i.id),
    ["a", "b", "c"],
    "the turns are listed once each, in the order their first hit appears",
  );
});

test("the key is thread and turn id, so one id on two threads is two items", () => {
  const hits = [
    hit("panel-assistant", "t1", "input"),
    hit("worker-thread", "t1", "input"),
    hit("panel-assistant", "t1", "reply"),
  ];
  const items = group(hits);
  assert.equal(items.length, 2, "the same turn id under another thread is another message");
  assert.equal(items[0].thread, "panel-assistant");
  assert.equal(items[0].hits.length, 2);
  assert.equal(items[1].thread, "worker-thread");
  assert.notEqual(keyOf(hits[0]), keyOf(hits[1]));
  assert.equal(keyOf(hits[0]), keyOf(hits[2]), "two fields of one turn share one key");
});

test("a hit that could not be opened is not an item", () => {
  const items = group([
    { field: "input" },
    { id: "t1", field: "input" },
    { thread: "panel-assistant", field: "input" },
    { thread: "panel-assistant", id: "t1", field: "input" },
    null,
    "not a hit",
  ]);
  assert.equal(items.length, 1, "a hit with no thread or no id has nothing on the page to open");
  assert.equal(items[0].id, "t1");
});

test("an empty list is no item, never a crash", () => {
  assert.deepEqual(group([]), []);
  assert.deepEqual(group(null), []);
  assert.deepEqual(group(undefined), []);
});

test("the module's answers are functions on one global, and the walk is not one of them", () => {
  assert.equal(typeof globalThis.wtSearchItems.group, "function");
  assert.equal(typeof globalThis.wtSearchItems.keyOf, "function");
  assert.equal(typeof globalThis.wtSearchItems.order, "function");
  assert.equal(globalThis.wtSearchItems.step, undefined, "the walk belongs to public/core/search-count.js");
});

// ---- the order the list reads in ----------------------------------------------------------------------------
// The defect: the answer arrives in the cap's preference, so the reader's oldest prompt sat on top of a reply from
// five minutes ago. These cases pin the walk's order - newest message first, rows inside a message in reading order,
// ties by conversation order - because the popover draws exactly the list this function answers.
const at = (hours, minutes = 0) => Date.UTC(2026, 10, 12, hours, minutes);
const t = (id, turn, field, when, extra = {}) => ({ thread: "panel-assistant", id, turn, field, at: when, ...extra });

test("items are ordered by their own newest row, newest first - not by the field the cap preferred", () => {
  // The server's order for this answer is input first, then reply, then console - so today's list reads the
  // six-hour-old prompt on top and the five-minute-old reply at the bottom.
  const hits = [
    t("old-prompt", 1, "input", at(6)),
    t("recent-reply", 4, "reply", at(11, 55)),
    t("middle-reply", 3, "reply", at(10)),
    t("oldest-line", 2, "tool", at(7)),
  ];
  const out = order(hits);
  assert.deepEqual(
    out.map((h) => h.id),
    ["recent-reply", "middle-reply", "oldest-line", "old-prompt"],
    "the newest row is 1 of N and Down walks backwards in time",
  );
  assert.equal(out.length, hits.length, "no hit is dropped from the walk");
  assert.deepEqual(hits.map((h) => h.id), ["old-prompt", "recent-reply", "middle-reply", "oldest-line"], "the answer it was given is not reordered in place");
  // The item map built over the ordered list draws the same order and reports the item's newest row as its stamp.
  const items = group(out);
  assert.deepEqual(items.map((i) => i.id), ["recent-reply", "middle-reply", "oldest-line", "old-prompt"]);
  assert.equal(items[0].stamp, at(11, 55), "the header's age is the newest row in that message");
});

test("rows inside one item keep reading order: prompt, console lines by index, reply", () => {
  const hits = [
    t("one", 7, "reply", at(9, 30)),
    t("one", 7, "tool", at(9, 20), { index: 1 }),
    t("one", 7, "input", at(9)),
    t("one", 7, "tool", at(9, 10), { index: 0 }),
    t("one", 7, "tool", at(9, 25), { index: 2 }),
  ];
  const out = order(hits);
  assert.deepEqual(
    out.map((h) => (h.field === "tool" ? `tool:${h.index}` : h.field)),
    ["input", "tool:0", "tool:1", "tool:2", "reply"],
    "the turn still reads top to bottom, whatever order the answer listed its rows in",
  );
});

test("equal timestamps break by conversation order, so a tie is stable", () => {
  // Both messages' newest rows carry the same millisecond; the store's own numbering says which came first. Without
  // the tie-break the sort would be free to shuffle them between paints.
  const hits = [t("later", 5, "input", at(8)), t("earlier", 2, "input", at(8))];
  assert.deepEqual(order(hits).map((h) => h.id), ["earlier", "later"], "the earlier turn in the conversation stays first");
  assert.deepEqual(order([...hits].reverse()).map((h) => h.id), ["earlier", "later"], "the answer's own order cannot change a tie");
  // A tie with no numbering at all still keeps the answer's order: the sort is stable.
  const unnumbered = [{ thread: "t", id: "b", field: "input", at: at(8) }, { thread: "t", id: "a", field: "input", at: at(8) }];
  assert.deepEqual(order(unnumbered).map((h) => h.id), ["b", "a"]);
});

test("an item's stamp is its newest row, so a long turn sorts by its last activity", () => {
  const hits = [
    t("long", 1, "input", at(6)),
    t("long", 1, "tool", at(11, 55), { index: 0 }),
    t("other", 2, "input", at(10)),
  ];
  const out = order(hits);
  assert.deepEqual(out.map((h) => h.id), ["long", "long", "other"], "the message that did something five minutes ago is first");
  assert.equal(out[0].at, at(6), "and its rows are still in reading order - the prompt leads the message");
});

test("a hit that cannot name a message stays in the walk, after the items", () => {
  const loose = { field: "tool", at: at(12) };
  const out = order([t("one", 1, "input", at(9)), loose]);
  assert.equal(out.length, 2);
  assert.equal(out[1], loose, "dropping it would make the header divide fewer rows than the footer's matched count");
});

test("a tie between two assistants is decided by the assistant, so the list does not depend on the answer's order", () => {
  // The every-assistant search can answer two assistants' turns at the SAME millisecond. Their turn counters are not
  // comparable across two stores, so the assistant decides - then the thread - and only then the numbering. Without
  // that, the order would be whatever the answer happened to list first and would move between paints.
  const same = at(9);
  const one = { thread: "panel-assistant", id: "one", turn: 1, field: "input", at: same, assistantId: "assistant-1", assistant: "Assistant #1" };
  const two = { thread: "panel-assistant-2", id: "two", turn: 1, field: "input", at: same, assistantId: "assistant-2", assistant: "Assistant #2" };
  assert.deepEqual(order([one, two]).map((h) => h.id), ["one", "two"]);
  assert.deepEqual(order([two, one]).map((h) => h.id), ["one", "two"], "the answer's own order cannot change a tie between assistants");
  assert.deepEqual(order([two, one]).map((h) => h.assistant), ["Assistant #1", "Assistant #2"]);
  // The item remembers whose message it is, so a header can name it without walking the hits again.
  const items = group([two, one]);
  assert.deepEqual(items.map((i) => i.assistantId), ["assistant-2", "assistant-1"]);
  assert.deepEqual(items.map((i) => i.assistant), ["Assistant #2", "Assistant #1"]);
});

test("an empty or absent answer is an empty walk, never a crash", () => {
  assert.deepEqual(order([]), []);
  assert.deepEqual(order(null), []);
  assert.deepEqual(order(undefined), []);
});
