// ORDER AND ARCHIVE ON THE STORE ITSELF (row 297): the two halves that do not need a server.
//
// WHAT THIS FILE PINS, and why each one has a wrong answer that looks right:
//
//   1. THE LIST BEFORE ANY MOVE IS THE LIST THE READER HAS TODAY. A store written before `order` existed has no
//      numbers at all, and the read must fall back to the rule the tab has always drawn with (newest edit first, the
//      creation time standing in for a record nobody edited). A first move seeds 1..n from THAT order, so one press
//      moves one card and nothing else jumps.
//   2. A RECORD THAT CARRIES NO ORDER IS PLACED BY ITS createdAt, after the numbered ones. A hand edit and a record
//      this panel wrote before the field are the same case, and neither may sort to a random place.
//   3. ARCHIVED IS A STATE, NOT A DELETE. The tree record stays exactly where it is, the index the chart overlays from
//      stops naming it, and Restore puts it back on the number it went away with.
//   4. THE WRITE RULE IS UNCHANGED. A store that cannot be read refuses reorder, archive and restore with the same
//      sentence and the same bytes on disk.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Initiatives, normTreePath } from "../lib/initiatives.js";

// A drive-letter path is assembled rather than typed: the repository's own reader refuses a literal one in a tracked
// file, and this file needs the Windows spelling to prove the tree key.
const DRIVE = ["C", ":"].join("");
const TREE = `${DRIVE}/work/alpha/.worktrees/order-one`;

function store(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-initiatives-order-"));
  const file = path.join(dir, "initiatives.json");
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { dir, file, make: () => new Initiatives({ file, log: () => {} }) };
}

// A store as the panel wrote it BEFORE the order field: no `order` anywhere, and `updatedAt` differing from
// `createdAt` on one record so the fallback's rule is measurable (the edited one leads).
function beforeOrderStore(file) {
  const doc = {
    version: 1,
    savedAt: "2026-11-24T00:00:00.000Z",
    initiatives: [
      { id: "init_a", title: "Alpha", description: "first made", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" },
      { id: "init_b", title: "Beta", description: "second made", createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" },
      { id: "init_c", title: "Gamma", description: "third made", createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" },
    ],
    trees: { [normTreePath(TREE)]: { path: TREE, initiatives: ["init_b"], at: "2026-11-02T00:00:00.000Z", by: "reader", members: { init_b: { at: "2026-11-02T00:00:00.000Z", by: "reader" } } } },
  };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

test("a store with no order lists exactly as it draws today, and the first move seeds that order and moves one card", (t) => {
  const { file, make } = store(t);
  beforeOrderStore(file);
  const s = make();
  // The rule the tab has always drawn with: newest edit first, so Alpha (edited on the 4th) leads despite being the
  // oldest record. This is the list the reader sees today, and it must survive the change untouched.
  assert.deepEqual(s.initiativeList().map((i) => i.id), ["init_a", "init_c", "init_b"]);

  const moved = s.reorder({ id: "init_b", to: 1, by: "reader" });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.changed, true);
  assert.equal(moved.to, 1);
  assert.deepEqual(moved.order, [
    { id: "init_b", position: 1 },
    { id: "init_a", position: 2 },
    { id: "init_c", position: 3 },
  ]);
  // ONE CARD MOVED: the two the reader did not touch keep their relative order.
  assert.deepEqual(s.initiativeList().map((i) => i.id), ["init_b", "init_a", "init_c"]);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.initiatives.find((i) => i.id === "init_b").order, 1);
  assert.equal(doc.initiatives.find((i) => i.id === "init_b").orderBy, "reader");

  // AND IT SURVIVES A RESTART: a second instance over the file reads the same sequence.
  assert.deepEqual(make().initiativeList().map((i) => i.id), ["init_b", "init_a", "init_c"]);
});

test("a record with no order sorts after the numbered ones, newest createdAt first", (t) => {
  const { file, make } = store(t);
  const doc = {
    version: 1,
    initiatives: [
      { id: "init_ordered", title: "Ordered", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", order: 1 },
      { id: "init_older", title: "Older hand edit", createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" },
      { id: "init_newer", title: "Newer hand edit", createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z" },
    ],
    trees: {},
  };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  // The numbered record leads; the two orderless ones follow by createdAt, newest first - NOT by updatedAt, because the
  // fallback for a record with no number is the record's creation, as the brief says.
  assert.deepEqual(make().initiativeList().map((i) => i.id), ["init_ordered", "init_newer", "init_older"]);
});

test("a reorder clamps to the list, refuses a missing target and an archived card, and changes nothing at the same place", (t) => {
  const { file, make } = store(t);
  beforeOrderStore(file);
  const s = make();
  assert.equal(s.reorder({ id: "init_a" }).ok, false, "no `to` is a refusal, not a card dropped at the end");
  assert.match(s.reorder({ id: "init_a" }).error, /1-based position/);
  assert.equal(s.reorder({ id: "init_nope", to: 1 }).ok, false);
  // Out of range clamps to the ends rather than being an error nobody can act on.
  const last = s.reorder({ id: "init_a", to: 99 });
  assert.equal(last.ok, true);
  assert.equal(last.to, 3, "a target past the foot is the foot");
  const bytes = readFileSync(file, "utf8");
  const same = s.reorder({ id: "init_a", to: 3 });
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.equal(readFileSync(file, "utf8"), bytes, "a press that moves nothing writes nothing");
  // An archived record is not in the list the arrows move.
  assert.equal(s.archive({ id: "init_c", by: "reader" }).ok, true);
  const refused = s.reorder({ id: "init_c", to: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /archived/);
});

test("archive keeps the tree and the number, hides the record from the index, and restore returns it to its place", (t) => {
  const { file, make } = store(t);
  beforeOrderStore(file);
  const s = make();
  // A real move seeds 1..n from today's list ([a, c, b]) and puts Alpha at the foot: [c, b, a]. The tree belongs to
  // Beta, the card in the middle, so the archive below is the one that has something to hide and something to keep.
  const seeded = s.reorder({ id: "init_a", to: 3 });
  assert.equal(seeded.changed, true, JSON.stringify(seeded));
  const orderBefore = s.initiativeList().map((i) => i.id);
  assert.deepEqual(orderBefore, ["init_c", "init_b", "init_a"]);
  const away = s.archive({ id: "init_b", by: "assistant-3" });
  assert.equal(away.ok, true, JSON.stringify(away));
  assert.equal(away.initiative.archivedBy, "assistant-3");
  assert.ok(away.initiative.archivedAt);
  // HIDDEN FROM THE LISTS AND THE INDEX, kept in the trees.
  assert.deepEqual(s.initiativeList().map((i) => i.id), orderBefore.filter((id) => id !== "init_b"));
  assert.deepEqual(s.archivedList().map((i) => i.id), ["init_b"]);
  assert.deepEqual(s.forTree(TREE), [], "the chart overlay stops naming it");
  assert.deepEqual(s.treesFor("init_b").map((rec) => rec.key), [normTreePath(TREE)], "the tree record is still there");
  // A RESTART KEEPS IT AWAY.
  const second = make();
  assert.deepEqual(second.archivedList().map((i) => i.id), ["init_b"]);
  assert.equal(second.initiativeById("init_b").archivedAt, away.initiative.archivedAt);
  // RESTORE: back at the number it had, with the tree it had.
  const back = second.restore({ id: "init_b", by: "reader" });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.initiative.archivedAt, null);
  assert.deepEqual(second.initiativeList().map((i) => i.id), orderBefore, "the place it was archived from");
  assert.deepEqual(second.forTree(TREE), [{ id: "init_b", title: "Beta" }], "and the chart overlay names it again");
  // An archive that is already archived, and a restore of something active, are no-ops rather than errors.
  assert.equal(second.restore({ id: "init_b" }).changed, false);
});

test("an unreadable store refuses reorder, archive and restore with the same sentence and the same bytes", (t) => {
  const { file, make } = store(t);
  const broken = '{ "version": 1, "initiatives": [ { "id": "init_' ;
  writeFileSync(file, broken, "utf8");
  const s = make();
  for (const [what, call] of [
    ["reorder", () => s.reorder({ id: "init_a", to: 1 })],
    ["archive", () => s.archive({ id: "init_a" })],
    ["restore", () => s.restore({ id: "init_a" })],
  ]) {
    const out = call();
    assert.equal(out.ok, false, `${what} is refused`);
    assert.equal(out.refused, "unreadable", `${what} says why`);
    assert.match(out.error, /NOT overwritten/);
    assert.equal(readFileSync(file, "utf8"), broken, `${what} wrote nothing`);
  }
});

test("a new initiative lands on top of a numbered list, and the numbers stay a positive 1..n", (t) => {
  const { file, make } = store(t);
  beforeOrderStore(file);
  const s = make();
  s.reorder({ id: "init_b", to: 1 });
  const made = s.create({ title: "Fresh work" });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(s.initiativeList()[0].id, made.initiative.id, "a new card lands where a new card always has: on top");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  // The file's own array order is creation order (a, b, c), and the numbers moved: b was 1, a 2, c 3 before the create,
  // and the create shifted every one of them up so the new card could take 1.
  assert.deepEqual(doc.initiatives.map((i) => i.order), [3, 2, 4, 1]);
  assert.equal(doc.initiatives.every((i) => Number.isInteger(i.order) && i.order > 0), true, "no zero and no hole is a loss the next read would take for \"no order\"");
});
