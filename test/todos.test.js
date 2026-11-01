// The TODO action lines' id grammar.
//
// Dogfood issue 3: an agent wrote `TODO DROP 2 — reason`, the whole argument was read as the item id, the line was
// refused WHOLE, and the agent's prose still told the reader it had dropped item 2 — so item 2 stayed open and the
// next turn's block still listed it. The id is the leading integer; a trailing reason is the author's note and is not
// part of it. The refusal is kept for a missing id and for an argument that does not START with one.
//
// The fixture is the real store (`TodoLists`) over a temp file, because the half that matters is not the parse: it is
// that the dropped item is gone from what the NEXT turn reads (`todoBlock`), not merely that a line was accepted.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { oldestOpen, parseTodoLines, TodoLists, todoBlock, todoCounts } from "../lib/todos.js";

const withStore = (fn) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-todos-"));
  const tree = path.join(dir, "tree");
  const lists = new TodoLists({ file: path.join(dir, "todos.json"), trees: () => [{ project: "p", path: tree, branch: "b" }] });
  lists.seed({ project: "p", path: tree, texts: ["one", "two", "three"], by: "assistant" });
  const key = lists.keyFor({ project: "p", path: tree });
  const items = () => lists.items(key);
  const block = () => todoBlock(items(), { where: tree, project: "p", standing: false });
  const apply = (line) => lists.applyLines({ project: "p", path: tree, lines: parseTodoLines(line), by: "assistant" });
  try {
    return fn({ dir, tree, lists, key, items, block, apply });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ---- the four cases the dogfood run asked for -------------------------------------------------------------------
test("TODO DROP 2 — reason drops item 2 and reads as dropped next turn", () =>
  withStore(({ items, block, apply }) => {
    const [parsed] = parseTodoLines("TODO DROP 2 — reason");
    assert.deepEqual({ op: parsed.op, id: parsed.id, error: parsed.error }, { op: "drop", id: 2, error: null });
    const [r] = apply("TODO DROP 2 — reason");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.id, 2);
    assert.equal(items().find((i) => i.id === 2).status, "dropped");
    // The bug's actual symptom: the next turn's list still offered item 2 as open.
    const blockText = block();
    assert.match(blockText, /2\. \[dropped\] two/);
    assert.doesNotMatch(blockText, /2\. \[todo\s*\] two/);
    assert.equal(todoCounts(items()).open, 2);
    assert.equal(oldestOpen(items()).id, 1);
  }));

test("TODO DROP 2 reason (no dash) drops item 2 too", () =>
  withStore(({ items, block, apply }) => {
    const [parsed] = parseTodoLines("TODO DROP 2 reason");
    assert.deepEqual({ op: parsed.op, id: parsed.id, error: parsed.error }, { op: "drop", id: 2, error: null });
    const [r] = apply("TODO DROP 2 reason");
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(items().map((i) => i.status), ["todo", "dropped", "todo"]);
    assert.match(block(), /2\. \[dropped\] two/);
  }));

test("TODO DROP with no id is still refused, and nothing is dropped", () =>
  withStore(({ items, block, apply }) => {
    const [parsed] = parseTodoLines("TODO DROP");
    assert.equal(parsed.id, null);
    assert.match(parsed.error, /needs an item id/);
    assert.doesNotMatch(parsed.error, /got/, "a missing id has nothing to quote back");
    const [r] = apply("TODO DROP");
    assert.equal(r.ok, false);
    assert.match(r.error, /needs an item id/);
    assert.deepEqual(items().map((i) => i.status), ["todo", "todo", "todo"]);
    assert.match(block(), /2\. \[todo\s*\] two/);
  }));

test("TODO DROP reason (no leading integer) is still refused, and quotes what it got", () =>
  withStore(({ items, apply }) => {
    const [parsed] = parseTodoLines("TODO DROP reason");
    assert.equal(parsed.id, null);
    assert.match(parsed.error, /needs an item id \(got “reason”\)/);
    const [r] = apply("TODO DROP reason");
    assert.equal(r.ok, false);
    assert.deepEqual(items().map((i) => i.status), ["todo", "todo", "todo"]);
  }));

// ---- the boundary the fix must not cross ------------------------------------------------------------------------
test("a digit run glued to a word is not an id", () =>
  withStore(({ items, apply }) => {
    for (const line of ["TODO DROP 2x", "TODO DROP 2_reason", "TODO DROP #", "TODO DROP -- 2"]) {
      const [r] = apply(line);
      assert.equal(r.ok, false, `${line} should be refused`);
      assert.match(r.error, /needs an item id/);
    }
    assert.deepEqual(items().map((i) => i.status), ["todo", "todo", "todo"]);
  }));

test("every id op takes a trailing reason, and the reason survives in the raw line", () =>
  withStore(({ items, apply }) => {
    const cases = [
      ["TODO DONE 1 closed by the fix", 1, "done"],
      ["TODO DOING 2 starting now", 2, "doing"],
      ["TODO DROP 3 no longer applies — folded into 1", 3, "dropped"],
      ["TODO REOPEN 1 back again", 1, "todo"],
      ["TODO DONE #2 hash form with a reason", 2, "done"],
    ];
    for (const [line, id, status] of cases) {
      const [r] = apply(line);
      assert.equal(r.ok, true, `${line}: ${r.error}`);
      assert.equal(r.id, id, line);
      assert.equal(items().find((i) => i.id === id).status, status, line);
      assert.match(r.raw, /reason|now|again|applies|fix|closed/, "the raw line is kept whole for the journal");
    }
  }));

test("TODO IN <tree> | <op> <id> <reason> reads the id out of the right field", () =>
  withStore(({ items, lists, tree, apply }) => {
    const [parsed] = parseTodoLines(`TODO IN ${tree} | DROP 2 — reason`);
    assert.deepEqual({ op: parsed.op, id: parsed.id, target: parsed.target, error: parsed.error }, { op: "drop", id: 2, target: tree, error: null });
    const [r] = apply(`TODO IN ${tree} | DROP 2 — reason`);
    assert.equal(r.ok, true, r.error);
    assert.equal(items().find((i) => i.id === 2).status, "dropped");
    assert.equal(lists.items(lists.keyFor({ project: "p", path: tree })).length, 3);
  }));

test("an id past the end of the list is the store's refusal, not the parser's", () =>
  withStore(({ apply }) => {
    const [parsed] = parseTodoLines("TODO DROP 9 — no such item");
    assert.deepEqual({ id: parsed.id, error: parsed.error }, { id: 9, error: null });
    const [r] = apply("TODO DROP 9 — no such item");
    assert.equal(r.ok, false);
    assert.match(r.error, /no item 9 in this list — its ids run 1\.\.3/);
  }));
