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
import assert from "node:assert/strict";
import test from "node:test";
import "../public/core/search-items.js";

const { group, keyOf } = globalThis.wtSearchItems;

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
  assert.equal(globalThis.wtSearchItems.step, undefined, "the walk belongs to public/core/search-count.js");
});
