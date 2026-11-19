// The collision detector and its COLLISION line: the three relations, the evidence, the note and the ruling.
//
// WHY THESE CASES. Each one is a shape the panel must tell apart, and a broken implementation fails it for its own
// reason rather than by accident:
//
//   * two live rows dirtying the SAME file - the ordinary two-workers-one-file case, with the path as evidence;
//   * two live rows dirtying DIFFERENT files, with one tree's branch being the other's parent - the merge-target
//     relation, which is a collision with NO shared file, so a detector that only compares file sets cannot pass it;
//   * two children of one TURNOVER branch whose own commits change the same file - the sibling relation, which needs
//     the COMMIT set and the turnover predicate, so a detector comparing only dirty files cannot pass it;
//   * a dormant row, a row of another project, and a pair with nothing in common - the three ways a pair must NOT be
//     reported, so a detector that flags everything fails here;
//   * the COLLISION line, its broken shape, and the target resolution - the worker's own way in;
//   * the book: a second pass escalates, a stand-down does not, a ruling survives a re-detection, and a note whose
//     target names no row is the reader's.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CollisionBook,
  detectCollisions,
  brokenCollisionLines,
  parseCollisionLines,
  pairKey,
  relationSentence,
  resolveCollisionTarget,
  sideOf,
  stateOf,
  touchedOf,
} from "../lib/collisions.js";
import { queueRowsFor, rulingRowsFor, sweepCollisions } from "../lib/collision-flow.js";

const TURNOVER = "20261020_1624_DMR-39015_menuOAuth2Gateway";
const tree = (name, over = {}) => ({
  project: "coll-proj",
  path: `/repos/coll-proj/.worktrees/${name}`,
  name,
  branch: `wtgui/${name}`,
  parent: "main",
  live: true,
  dirtyFiles: [],
  untrackedFiles: [],
  commitFiles: [],
  ...over,
});

test("two live runs dirtying the same file are one collision, with the path as evidence", () => {
  const rows = [
    tree("worker-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("worker-two", { dirtyFiles: [{ code: "MM", path: "lib/shared.js" }] }),
  ];
  const pairs = detectCollisions(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].key, pairKey(rows[0].path, rows[1].path));
  assert.deepEqual(pairs[0].files, ["lib/shared.js"]);
  assert.deepEqual(pairs[0].relations.map((r) => r.kind), ["shared-file"]);
  // The evidence is a path, never a bare flag: the marker and the queue row are built from this.
  assert.match(relationSentence(pairs[0].relations, "worker-two"), /1 shared file with worker-two/);
});

test("a dirty file and an untracked file of the same name are the same touch", () => {
  const pairs = detectCollisions([
    tree("worker-one", { dirtyFiles: [{ code: "M", path: "Docs/Plan.MD" }] }),
    tree("worker-two", { untrackedFiles: ["docs/plan.md"] }),
  ]);
  assert.equal(pairs.length, 1, "a Windows path arrives in whatever case the tool that wrote it liked");
  assert.deepEqual(pairs[0].files, ["docs/plan.md"]);
});

test("one tree's branch is the other's merge target: a collision with no shared file at all", () => {
  const rows = [
    tree("parent-branch", { branch: "feature/roll-up", parent: "main", dirtyFiles: [{ code: "M", path: "a.js" }] }),
    tree("child-tree", { branch: "wtgui/child-tree", parent: "feature/roll-up", dirtyFiles: [{ code: "M", path: "b.js" }] }),
  ];
  const pairs = detectCollisions(rows);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].files, []);
  assert.deepEqual(pairs[0].relations, [{ kind: "merge-target", lander: "b", target: "feature/roll-up" }]);
  assert.match(relationSentence(pairs[0].relations, "child-tree"), /child-tree lands into feature\/roll-up/);
});

test("two children of one turnover branch whose own commits change the same file", () => {
  const rows = [
    tree("turnover-child-one", { branch: "wtgui/turnover-child-one", parent: TURNOVER, commitFiles: ["src/rating.java", "README.md"] }),
    tree("turnover-child-two", { branch: "wtgui/turnover-child-two", parent: TURNOVER, commitFiles: ["src/Rating.java"] }),
  ];
  const pairs = detectCollisions(rows);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].relations, [{ kind: "sibling-turnover", parent: TURNOVER, files: ["src/rating.java"] }]);
  assert.deepEqual(pairs[0].files, ["src/rating.java"]);
  assert.match(relationSentence(pairs[0].relations, "turnover-child-two"), /both changed under 20261020/);
});

test("children of one NON-turnover branch are not siblings: that is not a drop zone both land in", () => {
  const rows = [
    tree("one", { parent: "feature/roll-up", commitFiles: ["src/rating.java"] }),
    tree("two", { parent: "feature/roll-up", commitFiles: ["src/rating.java"] }),
  ];
  const pairs = detectCollisions(rows);
  // They DO share a committed file - that is the ordinary shared-file collision - but the turnover relation is not
  // claimed for a branch that is not a turnover branch: the evidence would name a drop zone that does not exist.
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].relations.some((r) => r.kind === "sibling-turnover"), false);
  assert.deepEqual(pairs[0].relations.map((r) => r.kind), ["shared-file"]);
});

test("the three pairs that are NOT collisions: dormant, another project, nothing in common", () => {
  const live = tree("worker-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] });
  const dormant = tree("worker-two", { live: false, dirtyFiles: [{ code: "M", path: "lib/shared.js" }] });
  assert.deepEqual(detectCollisions([live, dormant]), [], "a dormant tree holding a file is not a worker stepping on it");

  const otherProject = tree("worker-three", { project: "another-proj", dirtyFiles: [{ code: "M", path: "lib/shared.js" }] });
  assert.deepEqual(detectCollisions([live, otherProject]), [], "the same relative path in two repos is not a shared file");

  const elsewhere = tree("worker-four", { dirtyFiles: [{ code: "M", path: "lib/other.js" }] });
  assert.deepEqual(detectCollisions([live, elsewhere]), []);
});

test("a row with no branch, or a released one, is never a live run", () => {
  const rows = [
    tree("detached", { branch: "HEAD", dirtyFiles: [{ code: "M", path: "x.js" }] }),
    tree("released", { released: { why: "gone" }, dirtyFiles: [{ code: "M", path: "x.js" }] }),
    tree("real", { dirtyFiles: [{ code: "M", path: "x.js" }] }),
  ];
  assert.deepEqual(detectCollisions(rows), []);
});

test("touchedOf keeps the three sets apart, because the evidence says which one produced the path", () => {
  const t = touchedOf({
    dirtyFiles: [{ code: "M", path: "a.js" }],
    untrackedFiles: ["b.js"],
    commitFiles: ["c.js", "a.js"],
  });
  assert.deepEqual(t.dirty, ["a.js", "b.js"]);
  assert.deepEqual(t.commits, ["a.js", "c.js"]);
  assert.deepEqual(t.all, ["a.js", "b.js", "c.js"]);
});

test("sideOf names a tree without a lookup: path, directory name, branch, parent", () => {
  const one = sideOf({ path: "C:\\repos\\proj\\.worktrees\\tree-one\\", branch: "wtgui/tree-one", parent: TURNOVER });
  assert.deepEqual(one, { path: "C:/repos/proj/.worktrees/tree-one", name: "tree-one", branch: "wtgui/tree-one", parent: TURNOVER });
});

test("the COLLISION line: a target and a sentence after one pipe", () => {
  const text = [
    "I shipped the fixture and stopped.",
    "COLLISION coll-two | both of us are rewriting docs/reports/plan.html and lib/report.js",
    "COLLISION `wtgui/other-tree` | the migration in db/001.sql is the one I am about to run too",
  ].join("\n");
  const lines = parseCollisionLines(text);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { target: "coll-two", text: "both of us are rewriting docs/reports/plan.html and lib/report.js" });
  assert.equal(lines[1].target, "`wtgui/other-tree`");
  // The pipe is the field break: a colon or a slash in the sentence cannot be mistaken for one.
  assert.deepEqual(parseCollisionLines("COLLISION tree | see: C:/x/y.js, then stop"), [{ target: "tree", text: "see: C:/x/y.js, then stop" }]);
});

test("a COLLISION line with no pipe is reported, not silently dropped", () => {
  assert.deepEqual(parseCollisionLines("COLLISION coll-two has the same file"), []);
  assert.deepEqual(brokenCollisionLines("COLLISION coll-two has the same file"), ["COLLISION coll-two has the same file"]);
  assert.deepEqual(brokenCollisionLines("nothing to see"), []);
});

test("a target resolves by full path, suffix, directory name or branch - and names nothing otherwise", () => {
  const rows = [
    tree("coll-one", { branch: "wtgui/coll-one" }),
    tree("coll-two", { branch: "wtgui/coll-two" }),
  ];
  assert.equal(resolveCollisionTarget(rows, rows[1].path, "coll-proj").name, "coll-two");
  assert.equal(resolveCollisionTarget(rows, ".worktrees/coll-two", "coll-proj").name, "coll-two");
  assert.equal(resolveCollisionTarget(rows, "coll-one", "coll-proj").name, "coll-one");
  assert.equal(resolveCollisionTarget(rows, "wtgui/coll-one", "coll-proj").name, "coll-one");
  assert.equal(resolveCollisionTarget(rows, "the tree I am thinking of", "coll-proj"), null);
  assert.equal(resolveCollisionTarget(rows, "coll-one", "another-proj"), null);
});

test("the book: a new pair starts at the assistants, a second pass escalates it", () => {
  const book = new CollisionBook({ now: () => Date.parse("2026-11-19T12:00:00.000Z") });
  const pair = {
    key: "a|b",
    project: "coll-proj",
    a: sideOf({ path: "/r/a", branch: "wtgui/a", parent: "main" }),
    b: sideOf({ path: "/r/b", branch: "wtgui/b", parent: "main" }),
    files: ["lib/shared.js"],
    relations: [{ kind: "shared-file", files: ["lib/shared.js"] }],
  };
  const first = book.upsertDetected(pair, Date.parse("2026-11-19T12:00:00.000Z"));
  assert.equal(first.isNew, true);
  assert.equal(first.passTicked, true);
  assert.equal(stateOf(first.record), "assistants");
  // Inside the pause this is the same look, not a second pass.
  const same = book.upsertDetected(pair, Date.parse("2026-11-19T12:00:01.000Z"));
  assert.equal(same.passTicked, false);
  assert.equal(same.record.passes, 1);
  const second = book.upsertDetected(pair, Date.parse("2026-11-19T12:00:05.000Z"));
  assert.equal(second.passTicked, true);
  assert.equal(second.record.passes, 2);
});

test("the sweep files one row per owner, once, naming the other tree and the evidence", () => {
  const book = new CollisionBook({});
  const filed = [];
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const owners = new Map([[rows[0].path, "assistant-1"], [rows[1].path, "assistant-2"]]);
  const names = { "assistant-1": "Manager 1", "assistant-2": "Manager 2" };
  const deps = {
    ownerOf: (side) => owners.get(side.path) || null,
    nameOf: (id) => names[id] || id,
    tasksFor: () => [],
    fileQueue: (payload) => {
      filed.push(payload);
      return { taskId: 100 + filed.length };
    },
  };
  const first = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  assert.equal(first.pairs, 1);
  assert.equal(filed.length, 2, "one row into each owning assistant's queue");
  assert.deepEqual(filed.map((f) => f.assistantId).sort(), ["assistant-1", "assistant-2"]);
  assert.match(filed[0].title, /^Collision with coll-two: 1 shared file with Manager 2$/);
  assert.match(filed[0].detail, /lib\/shared\.js/);
  assert.deepEqual(filed[0].files, ["lib/shared.js"]);
  assert.match(filed[1].title, /Collision with coll-one: 1 shared file with Manager 1/);
  // A second sweep does not file the same pair twice.
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:03.000Z"), ...deps });
  assert.equal(filed.length, 2);
  assert.equal(first.escalated.length, 0);
});

test("the sweep escalates a pair that survives one pass with nobody standing down", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  // Open rows, but on OTHER files: neither queue claims the overlap, so this pair escalates on the pass rule alone.
  const tasks = { "assistant-1": [{ id: 7, state: "queued", files: ["lib/other.js"] }], "assistant-2": [{ id: 8, state: "queued", files: ["lib/other.js"] }] };
  const deps = {
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: (id) => tasks[id] || [],
    fileQueue: () => ({ taskId: null }), // nothing filed: the pass rule still runs
  };
  const first = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  assert.equal(first.escalated.length, 0, "the first pass files it and leaves it with the assistants");
  const second = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:04.000Z"), ...deps });
  assert.equal(second.escalated.length, 1);
  assert.equal(second.escalated[0].why, "no-stand-down");
  assert.equal(stateOf(book.all()[0]), "reader");
});

test("a side that closes or parks its filed row stands down, and the pair does not escalate", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const tasks = { "assistant-1": [{ id: 11, state: "queued", files: ["lib/shared.js"] }], "assistant-2": [{ id: 12, state: "queued", files: ["lib/shared.js"] }] };
  const deps = {
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: (id) => tasks[id] || [],
    fileQueue: (payload) => ({ taskId: payload.assistantId === "assistant-1" ? 11 : 12 }),
  };
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  tasks["assistant-1"][0].state = "done";
  const second = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:04.000Z"), ...deps });
  assert.equal(second.stoodDown.length, 1);
  assert.equal(second.stoodDown[0].side, "a");
  assert.equal(second.escalated.length, 0, "assistants first: one stood down, so the reader is not asked");
  assert.equal(stateOf(book.all()[0]), "assistants");
});

test("both queues claiming the same file is the reader's, without waiting for a pass", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  // Two ORDINARY queue rows (not the rows the panel filed) each claiming the shared file: the deadlock.
  const tasks = {
    "assistant-1": [{ id: 1, state: "running", files: ["lib/shared.js"] }],
    "assistant-2": [{ id: 2, state: "queued", files: ["lib/./shared.js"] }],
  };
  const deps = {
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: (id) => tasks[id] || [],
    fileQueue: (payload) => ({ taskId: payload.assistantId === "assistant-1" ? 21 : 22 }),
  };
  tasks["assistant-1"].push({ id: 21, state: "queued", files: ["lib/shared.js"] });
  tasks["assistant-2"].push({ id: 22, state: "queued", files: ["lib/shared.js"] });
  const first = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  assert.equal(first.escalated.length, 1);
  assert.equal(first.escalated[0].why, "both-claim");
});

test("a ruling is stored against the pair, and a re-detected pair reads as already ruled", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const deps = { ownerOf: () => "assistant-1", tasksFor: () => [], fileQueue: () => ({ taskId: 5 }) };
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  const [rec] = book.all();
  const ruled = book.rule(rec.key, { pick: "a", note: "the migration lands first", at: Date.parse("2026-11-19T12:05:00.000Z") });
  assert.equal(ruled.ok, true);
  assert.equal(stateOf(book.get(rec.key)), "ruled");
  // Detected again on a later sweep: the record keeps its ruling and does not come back as a question.
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:10:00.000Z"), ...deps });
  const again = book.get(rec.key);
  assert.equal(again.ruling.pick, "a");
  assert.equal(again.ruling.name, "coll-one");
  assert.equal(stateOf(again), "ruled");
  const view = book.forTree(rows[1].path)[0];
  assert.equal(view.state, "ruled");
  assert.equal(view.other.name, "coll-one");
  assert.equal(view.ruling.note, "the migration lands first");
  // Withdrawing it puts the pair back to the assistants' pass, not to "nothing".
  assert.equal(book.rule(rec.key, { pick: "clear" }).ok, true);
  assert.equal(stateOf(book.get(rec.key)), "assistants");
});

test("a ruling's own queue rows name the side that goes first, to both assistants", () => {
  const record = {
    key: "a|b",
    project: "coll-proj",
    a: sideOf({ path: "/r/a", branch: "wtgui/a" }),
    b: sideOf({ path: "/r/b", branch: "wtgui/b" }),
    files: ["lib/shared.js"],
    ruling: { pick: "b", name: "b", note: "b lands first" },
  };
  const rows = rulingRowsFor(record, { ownerOf: (side) => (side.path === "/r/a" ? "assistant-1" : "assistant-2"), nameOf: (id) => id });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.title, /^Ruled: b goes first over a$/);
    assert.match(row.detail, /b lands first/);
    assert.deepEqual(row.files, ["lib/shared.js"]);
  }
});

test("a COLLISION note is filed against the reporting tree, and one naming no row is the reader's", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collisions-note-"));
  try {
    const file = path.join(dir, "collisions.json");
    const book = new CollisionBook({ file, now: () => Date.parse("2026-11-19T12:00:00.000Z") });
    const rows = [tree("coll-one"), tree("coll-two")];
    const other = resolveCollisionTarget(rows, "coll-two", "coll-proj");
    const paired = book.recordNote({
      project: "coll-proj",
      treePath: rows[0].path,
      branch: rows[0].branch,
      target: "coll-two",
      text: "both of us are rewriting lib/shared.js",
      runId: "run1",
      other,
    });
    assert.equal(paired.saved, true);
    const rec = book.get(pairKey(rows[0].path, rows[1].path));
    assert.ok(rec, "a resolving target is the pair, not a private note");
    assert.equal(rec.source, "reported");
    assert.equal(rec.b.name, "coll-two");
    assert.equal(rec.notes[0].text, "both of us are rewriting lib/shared.js");
    assert.equal(rec.notes[0].runId, "run1");
    assert.equal(stateOf(rec), "assistants", "a reported pair still gets the assistants' pass");
    // The same run reporting the same target twice updates the sentence instead of piling up notes.
    book.recordNote({ project: "coll-proj", treePath: rows[0].path, branch: rows[0].branch, target: "coll-two", text: "still on it", runId: "run1", other });
    assert.equal(book.get(rec.key).notes.length, 1);
    assert.equal(book.get(rec.key).notes[0].text, "still on it");

    const unpaired = book.recordNote({
      project: "coll-proj",
      treePath: rows[0].path,
      branch: rows[0].branch,
      target: "a tree I cannot name",
      text: "someone is about to run the same migration",
      runId: "run2",
    });
    assert.equal(unpaired.saved, true);
    const lone = book.get(unpaired.record.key);
    assert.equal(lone.b, null);
    assert.equal(lone.bTarget, "a tree I cannot name");
    assert.equal(stateOf(lone), "reader", "nothing else can act on a target that names no row");
    // The row's own view names the counterpart AS WRITTEN when there is no row to name.
    const view = book.forTree(rows[0].path).find((v) => v.key === lone.key);
    assert.equal(view.other, null);
    assert.equal(view.otherTarget, "a tree I cannot name");
    // The file round-trips, ruling and all.
    assert.equal(book.save().ok, true);
    const reread = new CollisionBook({ file });
    assert.equal(reread.all().length, 2);
    assert.equal(reread.get(rec.key).notes[0].text, "still on it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pair that is no longer detected is dropped, unless the reader ruled on it", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), tasksFor: () => [], fileQueue: () => ({ taskId: 3 }) });
  assert.equal(book.all().length, 1);
  // One tree goes quiet: the pair is gone from the detector, and without a ruling it is history.
  const quiet = [rows[0], { ...rows[1], live: false }];
  sweepCollisions({ rows: quiet, book, now: Date.parse("2026-11-19T12:00:10.000Z"), tasksFor: () => [], fileQueue: () => ({ taskId: 3 }) });
  assert.equal(book.all().length, 0);

  const again = new CollisionBook({});
  sweepCollisions({ rows, book: again, now: Date.parse("2026-11-19T12:00:00.000Z"), tasksFor: () => [], fileQueue: () => ({ taskId: 4 }) });
  again.rule(again.all()[0].key, { pick: "b" });
  sweepCollisions({ rows: quiet, book: again, now: Date.parse("2026-11-19T12:00:10.000Z"), tasksFor: () => [], fileQueue: () => ({ taskId: 4 }) });
  assert.equal(again.all().length, 1, "a ruling outlives the detection that produced it");
});
