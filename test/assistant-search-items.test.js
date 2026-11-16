// The assistant search's ITEM map: public/core/search-items.js.
//
// WHAT THIS FILE IS FOR. A search hit is one FIELD of one turn - the prompt, the reply, or one console line - and
// one query can hit several of them in the SAME turn. Up and Down must move the reader's current match from one
// message to the next, so the hits have to collapse into items BEFORE a press is counted. The mapping is the whole
// subject here:
//
//   * a turn's prompt, reply and every console line are ONE item, however many of them matched;
//   * the item's place in the walk is the place of its FIRST hit, never a second ordering the list does not show;
//   * the walk WRAPS at both ends (docs/assistant-search-keys.md states it), so Down on the last item lands on the
//     first and Up on the first lands on the last;
//   * the key is thread + turn id, so the same turn id on two threads is two items and never one.
import assert from "node:assert/strict";
import test from "node:test";
import "../public/core/search-items.js";

const { group, step, keyOf } = globalThis.wtSearchItems;

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

test("an item of one turn per press: three rows of one message do not make three presses", () => {
  const hits = [
    hit("panel-assistant", "a", "input"),
    hit("panel-assistant", "a", "reply"),
    hit("panel-assistant", "b", "input"),
    hit("panel-assistant", "c", "input"),
    hit("panel-assistant", "c", "tool"),
  ];
  const items = group(hits);
  assert.equal(items.length, 3);
  // Walking the items, one press each, visits a, b, c - never a twice for its two hits.
  let at = 0;
  const seen = [items[at].id];
  for (let i = 0; i < 2; i += 1) {
    at = step(at, 1, items.length);
    seen.push(items[at].id);
  }
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("the walk wraps at both ends, which is the stated behaviour", () => {
  assert.equal(step(0, 1, 4), 1);
  assert.equal(step(3, 1, 4), 0, "Down on the last item lands on the first");
  assert.equal(step(0, -1, 4), 3, "Up on the first lands on the last");
  assert.equal(step(2, -1, 4), 1);
  // Nothing current yet: Down lands on the first, Up on the last.
  assert.equal(step(-1, 1, 4), 0);
  assert.equal(step(-1, -1, 4), 3);
  // One item is still a ring: both directions land on it.
  assert.equal(step(0, 1, 1), 0);
  assert.equal(step(0, -1, 1), 0);
  // No items: there is nothing to stand on.
  assert.equal(step(0, 1, 0), -1);
  assert.equal(step(-1, -1, 0), -1);
  // An out-of-range index is treated as "nothing current" rather than trusted.
  assert.equal(step(9, 1, 4), 0);
  assert.equal(step(9, -1, 4), 3);
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

test("an empty list is no item and no step, never a crash", () => {
  assert.deepEqual(group([]), []);
  assert.deepEqual(group(null), []);
  assert.deepEqual(group(undefined), []);
  assert.equal(step(0, 1, 0), -1);
});

test("the module's three answers are functions on one global", () => {
  assert.equal(typeof globalThis.wtSearchItems.group, "function");
  assert.equal(typeof globalThis.wtSearchItems.step, "function");
  assert.equal(typeof globalThis.wtSearchItems.keyOf, "function");
});
