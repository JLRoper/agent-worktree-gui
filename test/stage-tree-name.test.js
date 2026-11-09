// ONE name for every tree a round cuts.
//
// The claim is small and load-bearing: the parent tree and each stage child of a round are named by ONE pure function
// from the round's own slug and tag, so the name a cut used is the name a reader (and a re-run) can derive again. The
// tests below pin the three strings, the family shape, the visit's part in it, and the property the panel depends on:
// a second call for the same visit returns the SAME name, never a `-2`.
import test from "node:test";
import assert from "node:assert/strict";

import { roundNameOf, stageTagOf, stageTreeName } from "../lib/stage-tree-name.js";

const ROUND = { slug: "carry-the-form", tag: "a1b2c3", title: "carry the form" };

test("the parent tree is <task-slug>-<tag> on wtgui/<task-slug>-<tag>", () => {
  const name = stageTreeName(ROUND, null, 1);
  assert.equal(name.dir, "carry-the-form-a1b2c3");
  assert.equal(name.branch, "wtgui/carry-the-form-a1b2c3");
  assert.equal(name.display, "carry the form");
  assert.equal(name.parent, true);
  assert.equal(name.stage, null);
});

test("a stage child displays the stage and its name, and lives at <task-slug>-stage-<n>-<stage-slug>-<tag>", () => {
  const name = stageTreeName(ROUND, { id: "S2", name: "implement", position: 2 }, 1);
  assert.equal(name.display, "Stage 2: implement");
  assert.equal(name.dir, `carry-the-form-stage-2-implement-${name.tag}`);
  assert.match(name.dir, /^carry-the-form-stage-2-implement-[0-9a-f]{6}$/);
  assert.equal(name.branch, `wtgui/${name.dir}`);
  assert.equal(name.stage, "S2");
  assert.equal(name.position, 2);
  assert.equal(name.visit, 1);
  assert.equal(name.parent, false);
});

test("the same round, stage and visit name the same tree every time - never a -2", () => {
  const stage = { id: "S2", name: "implement", position: 2 };
  const first = stageTreeName(ROUND, stage, 1);
  const again = stageTreeName({ ...ROUND }, { ...stage }, 1);
  assert.deepEqual(again, first);
  // No collision suffix of any kind: the name is the identity, and the stage's own "2" is the document's column.
  assert.ok(!/-[2-9]$/.test(first.dir), first.dir);
});

test("a second visit is a second tree, with its own tag from the same round", () => {
  const one = stageTreeName(ROUND, { id: "S2", name: "implement", position: 2 }, 1);
  const two = stageTreeName(ROUND, { id: "S2", name: "implement", position: 2 }, 2);
  assert.notEqual(two.dir, one.dir);
  assert.notEqual(two.tag, one.tag);
  assert.equal(two.dir, `carry-the-form-stage-2-implement-${two.tag}`);
});

test("every tree of a round has its own six-hex tag, so the tag stays a tree's identity", () => {
  const names = [
    stageTreeName(ROUND, null, 1),
    stageTreeName(ROUND, { id: "B1", name: "baseline", position: 1 }, 1),
    stageTreeName(ROUND, { id: "S2", name: "implement", position: 2 }, 1),
    stageTreeName(ROUND, { id: "S2", name: "implement", position: 2 }, 2),
  ];
  const tags = names.map((name) => name.tag);
  assert.equal(new Set(tags).size, tags.length, tags.join(","));
  for (const name of names) assert.match(name.dir, /-[0-9a-f]{6}$/);
});

test("the stage slug is cut on word boundaries and stays readable", () => {
  const name = stageTreeName(ROUND, { id: "S3", name: "Implement the form and its validation", position: 3 }, 1);
  // The stage slug is cut at 24 characters, BETWEEN whole words (lib/tree-slug.js): "and" is the last that fits.
  assert.match(name.dir, /^carry-the-form-stage-3-implement-the-form-and-[0-9a-f]{6}$/);
  assert.equal(name.display, "Stage 3: Implement the form and its validation");
});

test("a round with no slug or no tag names nothing - the caller is told, not given a guess", () => {
  assert.equal(stageTreeName({ tag: "a1b2c3" }, null, 1), null);
  assert.equal(stageTreeName({ slug: "carry-the-form" }, null, 1), null);
  assert.equal(stageTreeName(null, { id: "S1", position: 1 }, 1), null);
});

test("a stage with no position names nothing: the stage number is the document's, never a counter", () => {
  assert.equal(stageTreeName(ROUND, { id: "S2", name: "implement" }, 1), null);
  assert.equal(stageTreeName(ROUND, { id: "S2", name: "implement", position: 0 }, 1), null);
  // A stage the document names but does not number still names itself by that name; the position is what it cannot
  // invent, because `<n>` is the document's column.
  assert.equal(stageTreeName(ROUND, { name: "implement", position: 2 }, 1).stage, "implement");
});

test("a stage named by its id alone still names a tree", () => {
  const name = stageTreeName(ROUND, { id: "B1", position: 1 }, 1);
  assert.equal(name.display, "Stage 1: B1");
  assert.match(name.dir, /^carry-the-form-stage-1-b1-[0-9a-f]{6}$/);
});

test("the round's slug comes from the task title when the record has none yet", () => {
  const named = roundNameOf(null, { title: "Carry the form, end to end.", tag: "a1b2c3" });
  assert.deepEqual(named, { slug: "carry-the-form-end-to-end", tag: "a1b2c3", title: "Carry the form, end to end." });
  const name = stageTreeName(named, null, 1);
  assert.equal(name.dir, "carry-the-form-end-to-end-a1b2c3");
});

test("stageTagOf is stable and depends on the visit as well as the stage", () => {
  const base = { tag: "a1b2c3", stage: "S2", position: 2, visit: 1 };
  assert.equal(stageTagOf(base), stageTagOf({ ...base }));
  assert.notEqual(stageTagOf(base), stageTagOf({ ...base, visit: 2 }));
  assert.notEqual(stageTagOf(base), stageTagOf({ ...base, stage: "S3", position: 3 }));
  assert.match(stageTagOf(base), /^[0-9a-f]{6}$/);
});
