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
  COLLISION_RESOLVED_KEEP_MS,
  CollisionBook,
  detectCollisions,
  brokenCollisionLines,
  finishedSides,
  owningTaskFor,
  parseCollisionLines,
  pairKey,
  relationSentence,
  resolveCollisionTarget,
  sideOf,
  sideTaskOf,
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

test("one tree's branch is the other's merge target: that alone files NOTHING", () => {
  // The primary checkout on main is every tree's merge target, so this relation is true of most rows on the board.
  // Filed on its own it is noise: four rows were filed that way in one night and every one was the reader's own
  // checkout. A pair needs a shared path; the branch relation is context on one that has it.
  const only = [
    tree("primary", { branch: "main", parent: null, dirtyFiles: [{ code: "M", path: "notes.txt" }] }),
    tree("child-tree", { branch: "wtgui/child-tree", parent: "main", dirtyFiles: [{ code: "M", path: "b.js" }] }),
  ];
  assert.deepEqual(detectCollisions(only), [], "a branch relation with no shared file is not a collision");

  // With a shared file it is still said, after the evidence, so the sentence can name which way the work flows.
  const both = [
    tree("parent-branch", { branch: "feature/roll-up", parent: "main", dirtyFiles: [{ code: "M", path: "a.js" }] }),
    tree("child-tree", { branch: "wtgui/child-tree", parent: "feature/roll-up", dirtyFiles: [{ code: "M", path: "a.js" }] }),
  ];
  const pairs = detectCollisions(both);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].files, ["a.js"]);
  assert.deepEqual(pairs[0].relations.map((r) => r.kind), ["shared-file", "merge-target"]);
  assert.deepEqual(pairs[0].relations[1], { kind: "merge-target", lander: "a", branch: "wtgui/child-tree", target: "feature/roll-up" });
  assert.match(relationSentence(pairs[0].relations, "child-tree"), /1 shared file with child-tree; wtgui\/child-tree lands into feature\/roll-up/);
});

test("two children of one turnover branch whose own commits change the same file", () => {
  const rows = [
    tree("turnover-child-one", { branch: "wtgui/turnover-child-one", parent: TURNOVER, commitFiles: ["src/rating.java", "README.md"] }),
    tree("turnover-child-two", { branch: "wtgui/turnover-child-two", parent: TURNOVER, commitFiles: ["src/Rating.java"] }),
  ];
  const pairs = detectCollisions(rows);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].relations, [{ kind: "sibling", parent: TURNOVER, files: ["src/rating.java"], turnover: true }]);
  assert.deepEqual(pairs[0].files, ["src/rating.java"]);
  assert.match(relationSentence(pairs[0].relations, "turnover-child-two"), /both changed under 20261020/);
});

test("two branches cut from the same parent and committing the same file are siblings, under any parent", () => {
  // main is the drop zone every tree lands into, so two branches from main that both commit one file are a PAIR -
  // not two unrelated collisions with main, which is what the primary checkout row used to be told twice.
  const rows = [
    tree("from-main-one", { branch: "wtgui/from-main-one", parent: "main", commitFiles: ["src/sibling.js"] }),
    tree("from-main-two", { branch: "wtgui/from-main-two", parent: "main", commitFiles: ["src/sibling.js"] }),
    tree("unrelated", { branch: "wtgui/unrelated", parent: "feature/roll-up", commitFiles: ["src/sibling.js"] }),
  ];
  const pairs = detectCollisions(rows);
  // one and two are ONE pair; the tree under another parent shares the path but is not a sibling of either.
  const sibling = pairs.filter((p) => p.relations.some((r) => r.kind === "sibling" && r.parent === "main"));
  assert.equal(sibling.length, 1);
  assert.deepEqual(sibling[0].relations, [{ kind: "sibling", parent: "main", files: ["src/sibling.js"], turnover: false }]);
  for (const pair of pairs.filter((p) => p !== sibling[0])) {
    assert.equal(pair.relations.some((r) => r.kind === "sibling"), false, `${pair.a.name}/${pair.b.name} has a different parent`);
  }
});

test("siblings are compared on their own COMMITS; two trees merely dirtying the same file stay shared-file", () => {
  // The distinction the proof needs: work in flight in two trees is the ordinary shared-file pair, while work already
  // committed on two branches cut from one parent is the conflict waiting in the drop zone.
  const pairs = detectCollisions([
    tree("dirty-one", { parent: "main", dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("dirty-two", { parent: "main", dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].relations.map((r) => r.kind), ["shared-file"]);
});

test("one record per pair, whichever side the rows arrive on", () => {
  const one = tree("pair-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] });
  const two = tree("pair-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] });
  const forward = detectCollisions([one, two]);
  const backward = detectCollisions([two, one]);
  assert.equal(forward.length, 1);
  assert.equal(backward.length, 1);
  assert.equal(forward[0].key, backward[0].key, "the pair key is order-free");
  // The SIDES are ordered too: `a` is the path that sorts first, so a ruling stored as a side keeps naming a tree.
  assert.deepEqual(forward[0].a, backward[0].a);
  assert.deepEqual(forward[0].b, backward[0].b);
  assert.ok(forward[0].a.path < forward[0].b.path, "a is the lexicographically first path");

  // And the book folds both detections into one record, with one ruling slot.
  const book = new CollisionBook({});
  book.upsertDetected(forward[0], Date.parse("2026-11-19T12:00:00.000Z"));
  const second = book.upsertDetected(backward[0], Date.parse("2026-11-19T12:00:05.000Z"));
  assert.equal(second.isNew, false);
  assert.equal(book.all().length, 1);
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

test("sideOf names a tree without a lookup: path, directory name, branch, parent, and the queue task", () => {
  // Backslashes and a trailing separator are the WINDOWS forms the scanner really sees; the tree itself is named
  // relatively, because a signed drive path would only be true on the machine that wrote it.
  const one = sideOf({ path: "repos\\proj\\.worktrees\\tree-one\\", branch: "wtgui/tree-one", parent: TURNOVER });
  assert.deepEqual(one, { path: "repos/proj/.worktrees/tree-one", name: "tree-one", branch: "wtgui/tree-one", parent: TURNOVER, head: null, taskId: null, task: null });
  // The scanned tip travels too: the merge question is asked at the sha the pair was detected at, not at a branch name
  // that may have moved since.
  assert.equal(sideOf({ path: "/r/tree-one", head: "A".repeat(40) }).head, "a".repeat(40));
  // The task standing in the tree travels on the side, so the pair record can name both task ids.
  assert.equal(sideOf({ path: "/r/tree-one", taskId: 41 }).taskId, 41);
  assert.equal(sideOf({ path: "/r/tree-one", taskId: "not a number" }).taskId, null, "a number is read, never invented");
  // A RESOLVED queue row travels whole: the title, the state and whose queue holds it, beside the number.
  const side = sideOf({
    path: "/r/tree-one",
    task: { id: 41, title: "Land the card on both rows", state: "running", assistantId: "assistant-2", assistant: "Assistant #2" },
  });
  assert.deepEqual(side.task, {
    id: 41,
    name: "Land the card on both rows",
    state: "running",
    open: true,
    assistantId: "assistant-2",
    assistant: "Assistant #2",
  });
  assert.equal(side.taskId, 41);
  // An id with no state is "the board does not know", never "done": reading it as finished would call live work laid
  // down and quietly stand a real pair down.
  assert.equal(sideOf({ path: "/r/tree-one", taskId: 9 }).task.open, null);
  assert.equal(sideTaskOf({ id: 0 }), null, "a queue row with no id owns nothing");
});

test("a tree resolves to the queue row that names it in its OWN worktree field", () => {
  // Three cases the card has to tell apart: an open row, no row at all, and a row whose work is finished. The match is
  // the row's `worktree` field - the fact a spawn wrote - never the branch the tree happens to carry.
  const queues = [
    {
      assistantId: "assistant-1",
      assistant: "Assistant #1",
      tasks: [
        { id: 7, title: "Land the collision card on both rows", state: "running", worktree: "repos/proj/.worktrees/pair-a", files: ["lib/shared.js"] },
        { id: 3, title: "An earlier piece of work in the same tree", state: "done", worktree: "repos\\proj\\.worktrees\\PAIR-A\\", files: [] },
        { id: 61, title: "Compare the two siblings", state: "done", worktree: "repos/proj/.worktrees/sib-one", files: [] },
      ],
    },
    { assistantId: "assistant-2", assistant: "Assistant #2", tasks: [{ id: 9, title: "Someone else's tree", state: "queued", worktree: "repos/proj/.worktrees/other" }] },
  ];
  // 1. OPEN ROW: the newest open row wins over an older finished one in the same tree, and the assistant whose queue
  // holds it is named.
  assert.deepEqual(owningTaskFor("repos/proj/.worktrees/pair-a", queues), {
    id: 7,
    name: "Land the collision card on both rows",
    state: "running",
    open: true,
    assistantId: "assistant-1",
    assistant: "Assistant #1",
  });
  // 2. NO ROW: nothing on any queue names the tree, so the answer is null - the card says "no task row on this tree"
  // rather than leaving the line blank or borrowing the branch's name for a row that does not exist.
  assert.equal(owningTaskFor("repos/proj/.worktrees/loose-a", queues), null);
  assert.equal(owningTaskFor("", queues), null);
  // A row on ANOTHER tree never answers, even when the branch names match: branch names are not the association.
  assert.equal(owningTaskFor("repos/proj/.worktrees/pair-a", [{ assistantId: "assistant-2", tasks: [{ id: 5, state: "queued", worktree: "repos/proj/.worktrees/pair-b", branch: "wtgui/pair-a" }] }]), null);
  // 3. DONE ROW: with no open row, the finished one is still named, with its state, and `open: false` is what the card
  // reads as already stood down.
  assert.deepEqual(owningTaskFor("repos/proj/.worktrees/sib-one", queues), {
    id: 61,
    name: "Compare the two siblings",
    state: "done",
    open: false,
    assistantId: "assistant-1",
    assistant: "Assistant #1",
  });
  // A PARKED row is finished the same way - it is a decision, not missing work.
  assert.equal(owningTaskFor("repos/proj/.worktrees/parked", [{ assistantId: "assistant-1", tasks: [{ id: 2, state: "parked", worktree: "repos/proj/.worktrees/parked" }] }]).open, false);
  // The panel's OWN notice in that tree (filed by the sweep, or a ruling's priority row) is not the work: it names the
  // same worktree and would be the newest row, and answering with it says nothing about what the side is doing.
  const withNotice = [
    {
      assistantId: "assistant-1",
      assistant: "Assistant #1",
      tasks: [
        { id: 7, title: "Land the collision card on both rows", state: "running", worktree: "repos/proj/.worktrees/pair-a", carriedKey: "queue:turn-1|queue|0" },
        { id: 120, title: "Collision with pair-b: 1 shared file with Assistant #2", state: "queued", worktree: "repos/proj/.worktrees/pair-a", carriedKey: "collision:abc123def4:assistant-1" },
        { id: 121, title: "Ruled: pair-a goes first over pair-b", state: "queued", worktree: "repos/proj/.worktrees/pair-a", carriedKey: "collision-rule:abc123def4:assistant-1" },
      ],
    },
  ];
  assert.equal(owningTaskFor("repos/proj/.worktrees/pair-a", withNotice).id, 7);
});

test("finishedSides names the sides whose own task is done or parked, and only those", () => {
  const done = sideOf({ path: "/r/a", task: { id: 61, title: "Compare the siblings", state: "done", assistant: "Assistant #1" } });
  const live = sideOf({ path: "/r/b", task: { id: 62, title: "Rewrite the same file", state: "queued", assistant: "Assistant #2" } });
  assert.deepEqual(finishedSides({ a: done, b: live }), [
    { side: "a", tree: "a", path: "/r/a", taskId: 61, name: "Compare the siblings", state: "done", assistant: "Assistant #1" },
  ]);
  assert.deepEqual(finishedSides({ a: live, b: sideOf({ path: "/r/b", taskId: 12 }) }), [], "an id with no state is not finished");
  assert.deepEqual(finishedSides({ a: sideOf({ path: "/r/a" }), b: sideOf({ path: "/r/b" }) }), [], "no task rows at all is not finished either");
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
  assert.deepEqual(parseCollisionLines("COLLISION tree | see: lib/x/y.js, then stop"), [{ target: "tree", text: "see: lib/x/y.js, then stop" }]);
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

test("the pair record holds both task ids, and the queue row names the same side", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const filed = [];
  sweepCollisions({
    rows,
    book,
    now: Date.parse("2026-11-19T12:00:00.000Z"),
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: () => [],
    // The resolver names the queue task standing in each tree; the record keeps it on the side it belongs to.
    taskIdFor: (row) => (row.path.endsWith("coll-one") ? 41 : 44),
    fileQueue: (payload) => {
      filed.push(payload);
      return { taskId: 100 + filed.length };
    },
  });
  const [rec] = book.all();
  assert.equal(rec.a.name, "coll-one");
  assert.equal(rec.a.taskId, 41);
  assert.equal(rec.b.taskId, 44);
  assert.deepEqual(filed.map((f) => [f.side, /task #4[14]/.test(f.detail)]).sort(), [["a", true], ["b", true]].sort());
  // A re-detection with no resolver must not wipe the ids the record already holds.
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:05.000Z"), tasksFor: () => [], fileQueue: () => ({ taskId: null }) });
  assert.equal(book.all()[0].a.taskId, 41);
  // The row's view carries both sides, so each row can draw the pair once and name both trees.
  const fromTwo = book.forTree(rows[1].path)[0];
  assert.equal(fromTwo.role, "b");
  assert.equal(fromTwo.a.name, "coll-one");
  assert.equal(fromTwo.b.name, "coll-two");
  assert.equal(fromTwo.other.name, "coll-one");
});

test("the sweep records each side's own queue row: its title, id, state and assistant", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const queues = [
    {
      assistantId: "assistant-1",
      assistant: "Assistant #1",
      tasks: [{ id: 7, title: "Land the collision card on both rows", state: "running", worktree: rows[0].path, files: ["lib/shared.js"] }],
    },
    {
      assistantId: "assistant-2",
      assistant: "Assistant #2",
      tasks: [{ id: 8, title: "Show each side's task beside its tree", state: "queued", worktree: rows[1].path, files: ["lib/shared.js"] }],
    },
  ];
  const filed = [];
  const report = sweepCollisions({
    rows,
    book,
    now: Date.parse("2026-11-19T12:00:00.000Z"),
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: () => [],
    // The composition root's resolver: every assistant's queue, matched on the row's OWN worktree field.
    taskFor: (row) => owningTaskFor(row.path, queues),
    fileQueue: (payload) => {
      filed.push(payload);
      return { taskId: 100 + filed.length };
    },
  });
  assert.equal(report.pairs, 1);
  const [rec] = book.all();
  assert.deepEqual(rec.a.task, { id: 7, name: "Land the collision card on both rows", state: "running", open: true, assistantId: "assistant-1", assistant: "Assistant #1" });
  assert.deepEqual(rec.b.task, { id: 8, name: "Show each side's task beside its tree", state: "queued", open: true, assistantId: "assistant-2", assistant: "Assistant #2" });
  // The notice filed into each queue names the task the other side is on, not just its number.
  assert.ok(filed.every((f) => /task #(7|8) \((Land the collision card on both rows|Show each side's task beside its tree), (running|queued)\)/.test(f.detail)), JSON.stringify(filed.map((f) => f.detail)));
  // A tree no queue row names is an honest null on that side, and the other side still names its own task.
  const loose = [{ ...rows[0], path: "/repos/coll-proj/.worktrees/loose-a" }, { ...rows[1], path: "/repos/coll-proj/.worktrees/loose-b" }];
  const second = new CollisionBook({});
  sweepCollisions({
    rows: loose,
    book: second,
    now: Date.parse("2026-11-19T12:00:00.000Z"),
    ownerOf: () => "assistant-1",
    tasksFor: () => [],
    taskFor: (row) => owningTaskFor(row.path, queues),
    fileQueue: () => ({ taskId: null }),
  });
  const [looseRec] = second.all();
  assert.equal(looseRec.a.task, null);
  assert.equal(looseRec.b.task, null);
});

test("a side whose own task is done stands the pair down: the reader is not asked to arbitrate finished work", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const queues = [
    { assistantId: "assistant-1", assistant: "Assistant #1", tasks: [{ id: 61, title: "Compare the two siblings", state: "done", worktree: rows[0].path }] },
    { assistantId: "assistant-2", assistant: "Assistant #2", tasks: [{ id: 62, title: "Rewrite the same file", state: "queued", worktree: rows[1].path }] },
  ];
  const deps = {
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: () => [],
    taskFor: (row) => owningTaskFor(row.path, queues),
    fileQueue: () => ({ taskId: null }),
  };
  const first = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  assert.equal(first.finished.length, 1);
  assert.deepEqual([first.finished[0].sides, first.finished[0].tasks, first.finished[0].states], [["a"], [61], ["done"]]);
  // It never reaches the reader, even on the pass that would otherwise hand it over.
  const second = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:04.000Z"), ...deps });
  assert.equal(second.escalated.length, 0);
  assert.equal(stateOf(book.all()[0]), "assistants", "finished work is not a decision waiting on the reader");
  // Both rows' views say which side it is, with the task named - that is what the card prints.
  for (const path of [rows[0].path, rows[1].path]) {
    const view = book.forTree(path)[0];
    assert.deepEqual(view.stoodByTask.map((f) => [f.side, f.taskId, f.name, f.state]), [["a", 61, "Compare the two siblings", "done"]]);
    assert.equal(view.waiting, false);
  }
  // The work starts again in that tree: the derived stand-down goes with it, because nothing was written to the record.
  queues[0].tasks.push({ id: 63, title: "Pick the comparison back up", state: "running", worktree: rows[0].path });
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:08.000Z"), ...deps });
  assert.deepEqual(book.forTree(rows[0].path)[0].stoodByTask, []);
  assert.equal(book.forTree(rows[0].path)[0].waiting, true);
});

test("a side that closes its notice stands down WITH its reason, readable from both rows", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const tasks = { "assistant-1": [], "assistant-2": [] };
  const deps = {
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: (id) => tasks[id] || [],
    fileQueue: (payload) => {
      const taskId = payload.assistantId === "assistant-1" ? 51 : 52;
      tasks[payload.assistantId].push({ id: taskId, state: "queued", files: ["lib/shared.js"] });
      return { taskId };
    },
  };
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  tasks["assistant-1"][0].state = "done";
  const second = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:04.000Z"), ...deps });
  assert.deepEqual(second.stoodDown.map((s) => [s.side, s.taskId, s.state]), [["a", 51, "done"]]);
  const rec = book.get(pairKey(rows[0].path, rows[1].path));
  assert.deepEqual(rec.stoodDown.a, { at: "2026-11-19T12:00:04.000Z", taskId: 51, state: "done", name: "coll-one" });
  // Both rows read the same reason: that is what the card prints, instead of leaving the other side to ask why.
  for (const path of [rows[0].path, rows[1].path]) {
    const view = book.forTree(path)[0];
    assert.deepEqual(view.stoodDown, [{ side: "a", name: "coll-one", at: "2026-11-19T12:00:04.000Z", taskId: 51, state: "done" }]);
  }
});

test("a re-detected pair that already has a ruling renders as already ruled, and asks nothing again", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const deps = {
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: () => [],
    fileQueue: () => ({ taskId: null }),
  };
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:04.000Z"), ...deps });
  const key = book.all()[0].key;
  assert.equal(stateOf(book.get(key)), "reader", "with no stand-down the pair comes to the reader");
  const ruled = book.rule(key, { pick: "b", by: "reader", note: "coll-two first" });
  assert.equal(stateOf(ruled.record), "ruled");
  assert.equal(ruled.record.ruling.name, "coll-two");

  // The same pair, detected again on the next sweep - from the OTHER row's side - is the same record, and it is
  // already ruled: nothing is asked again, and the ruling's side still names the same tree.
  const again = sweepCollisions({ rows: [...rows].reverse(), book, now: Date.parse("2026-11-19T12:00:08.000Z"), ...deps });
  assert.equal(again.pairs, 1);
  assert.equal(book.all().length, 1);
  assert.equal(stateOf(book.get(key)), "ruled");
  assert.equal(book.state().count, 0, "nothing is waiting on the reader for a pair already ruled");
  for (const path of [rows[0].path, rows[1].path]) {
    const view = book.forTree(path)[0];
    assert.equal(view.state, "ruled");
    assert.equal(view.ruling.name, "coll-two");
    assert.equal(view.canAsk, false);
  }
});

test("a stood-down pair outlives the detection long enough to be read, then it is history", () => {
  const book = new CollisionBook({});
  const rows = [
    tree("coll-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    tree("coll-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const tasks = { "assistant-1": [], "assistant-2": [] };
  const deps = {
    ownerOf: (side) => (side.path.endsWith("coll-one") ? "assistant-1" : "assistant-2"),
    tasksFor: (id) => tasks[id] || [],
    fileQueue: (payload) => {
      const taskId = payload.assistantId === "assistant-1" ? 61 : 62;
      tasks[payload.assistantId].push({ id: taskId, state: "queued", files: ["lib/shared.js"] });
      return { taskId };
    },
  };
  const at = Date.parse("2026-11-19T12:00:00.000Z");
  sweepCollisions({ rows, book, now: at, ...deps });
  tasks["assistant-1"][0].state = "done";
  sweepCollisions({ rows, book, now: at + 4000, ...deps });
  const key = book.all()[0].key;
  assert.ok(book.get(key).stoodDown.a, "the stand-down is recorded");
  // The trees move apart: the next sweep sees nothing. The record stays while the reason is still worth reading...
  book.closeUndetected([], at + 60_000);
  assert.equal(book.all().length, 1);
  // ...and is dropped once it is stale.
  book.closeUndetected([], at + COLLISION_RESOLVED_KEEP_MS + 60_000);
  assert.deepEqual(book.all(), []);
});

test("the merge-target-only pair is never filed, however live both rows are", () => {
  // The reader's own checkout on main, dirty; a worker's tree cut from main, touching a different file. The old
  // detector filed this pair on the branch relation alone, which is how four rows of noise were filed in one night.
  const book = new CollisionBook({});
  const rows = [
    tree("primary", { branch: "main", parent: null, dirtyFiles: [{ code: "M", path: "notes.txt" }] }),
    tree("child-tree", { branch: "wtgui/child-tree", parent: "main", dirtyFiles: [{ code: "M", path: "lib/child.js" }] }),
  ];
  const filed = [];
  const report = sweepCollisions({
    rows,
    book,
    now: Date.parse("2026-11-19T12:00:00.000Z"),
    ownerOf: () => "assistant-1",
    tasksFor: () => [],
    fileQueue: (payload) => {
      filed.push(payload);
      return { taskId: 1 };
    },
  });
  assert.equal(report.pairs, 0);
  assert.equal(filed.length, 0);
  assert.deepEqual(book.all(), []);
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
