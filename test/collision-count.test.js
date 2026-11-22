// THE HUMAN BUTTON'S COLLISION COUNT: three defects measured on the live panel on 2026-11-22, one case each.
//
// WHY THESE CASES. Each one is the SHAPE the reader was shown, not a simplification of it:
//
//   1. a pair keyed by the worktree DIRECTORY NAME, which the panel renames under it. Two research rounds existed as
//      two records - .worktrees/research-round-a-for-the-initiatives-tab-e85acb against ...-b-for-the-initiatives-tab-
//      1d1d2c, then the same two trees under the run slugs the panel renames them to - so a ruling on the first key
//      did not reach the second and the pair was escalated twice. The names below are the measured ones.
//   2. a shared PARENT DIRECTORY counted as a shared file. Both trees were untracked under
//      docs/assets/initiatives-redesign/ (git collapses an untracked tree to one `? dir/` line), one having written 39
//      files under a/ and the other 18 under b/, with no tracked file modified and no commit in either. The fixture is
//      those two subtrees on a real disk.
//   3. the badge outliving its pairs: records in the reader state whose trees no longer exist, and a reported note
//      whose reporting tree was gone, which only `op:forget` could drop.
//
// A case here must FAIL on the build that shipped the defect (ac327faf) and pass after the fix. Nothing in this file
// imports a helper the fix added: the assertions are about behaviour, so the old code runs them and fails on its own
// answer rather than at import.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CollisionBook, detectCollisions, pairKey, stateOf, touchedOf } from "../lib/collisions.js";
import { sweepCollisions } from "../lib/collision-flow.js";

await import("../public/core/review-lane.js");
const lane = globalThis.wtReviewLane;

const PROJECT = "agent-worktree-gui";
const WORKTREES = `/repos/${PROJECT}/.worktrees`;
const tree = (dirName, over = {}) => ({
  project: PROJECT,
  path: `${WORKTREES}/${dirName}`,
  name: dirName,
  branch: `wtgui/${dirName}`,
  parent: "main",
  live: true,
  // Every tree in this file is a live run touching lib/shared.js unless a case says otherwise: the pair is the
  // ordinary two-workers-one-file overlap, and it is the one the reader was shown.
  dirtyFiles: [{ code: "M", path: "lib/shared.js" }],
  untrackedFiles: [],
  commitFiles: [],
  ...over,
});

// The two trees the reader measured, under the names the panel cut them with and under the run slugs it renamed them
// to. The six-hex tags are the part a rename keeps - the same pair of trees, twice.
const PRE_A = "research-round-a-for-the-initiatives-tab-e85acb";
const PRE_B = "research-round-b-for-the-initiatives-tab-1d1d2c";
const POST_A = "research-round-a-for-initiatives-tab-e85acb";
const POST_B = "research-round-b-for-initiatives-tab-1d1d2c";

const owners = (rows) => {
  const map = new Map(rows.map((row, index) => [row.path, `assistant-${index + 1}`]));
  return {
    ownerOf: (side) => map.get(side.path) || null,
    tasksFor: () => [],
    fileQueue: () => ({ taskId: null }),
  };
};

// Two sweeps four seconds apart, which is the pass rule's own spacing: the first files the pair, the second hands it to
// the reader (nothing stood down, and no merge probe is wired so git has not settled it). The dependencies travel in so
// the renamed rows are swept with the same owners as the pair was filed under.
function escalatePair(book, rows, at, deps = owners(rows)) {
  sweepCollisions({ rows, book, now: at, ...deps });
  return sweepCollisions({ rows, book, now: at + 4000, ...deps });
}

test("a ruling survives the panel renaming both trees: one physical pair stays one record", () => {
  const book = new CollisionBook({});
  const before = [tree(PRE_A), tree(PRE_B)];
  const deps = owners(before);
  escalatePair(book, before, Date.parse("2026-11-22T09:00:00.000Z"), deps);

  const [ruledOn] = book.all();
  assert.equal(stateOf(ruledOn), "reader", "the pair reached the reader under the names it was cut with");
  const ruledKey = ruledOn.key;
  book.rule(ruledKey, { pick: "a", note: "round A lands first", at: Date.parse("2026-11-22T09:05:00.000Z") });
  assert.equal(stateOf(book.get(ruledKey)), "ruled");
  const pickedBefore = book.get(ruledKey)[book.get(ruledKey).ruling.pick];
  const renamedPath = pickedBefore.path.replace(PRE_A, POST_A).replace(PRE_B, POST_B);

  // The panel's rename: the same two trees, the same tags, the directories and branches rebuilt from the run slugs.
  const after = [tree(POST_A), tree(POST_B)];
  assert.deepEqual(
    detectCollisions(after).map((pair) => pair.key),
    [ruledKey],
    "the key names the trees, not the directory the panel rewrites",
  );
  assert.equal(pairKey(before[0].path, before[1].path), pairKey(after[0].path, after[1].path));

  const renamed = escalatePair(book, after, Date.parse("2026-11-22T09:10:00.000Z"), deps);
  // A fresh record under the renamed key would need two sweeps to escalate again, which is exactly what the reader saw.
  const again = escalatePair(book, after, Date.parse("2026-11-22T09:20:00.000Z"), deps);

  assert.equal(book.all().length, 1, "one physical pair is one record, whatever its directory is called");
  assert.equal(book.get(ruledKey).ruling.pick, "a", "the ruling is still the answer after the rename");
  assert.equal(stateOf(book.get(ruledKey)), "ruled");
  assert.deepEqual(renamed.escalated, [], "the renamed pair is not handed to the reader a second time");
  assert.deepEqual(again.escalated, [], "no later sweep escalates it either");
  assert.deepEqual(renamed.filed, [], "and no second notice is filed into the queues");
  // The SIDE the ruling picked is the same TREE, and the record now spells it the way the panel renamed it: the side
  // order is the identity order, so a rename cannot move the pick onto the other tree.
  const pick = book.get(ruledKey).ruling.pick;
  const picked = book.get(ruledKey)[pick];
  assert.equal(picked.path, renamedPath, "the picked side is the renamed tree, not the other one");
  assert.equal(picked.name, renamedPath.split("/").pop());
  assert.equal(book.get(ruledKey).ruling.name, picked.name, "the ruling's own sentence is renamed with the tree");
  assert.equal(book.forTree(renamedPath)[0]?.state, "ruled", "the renamed row reads the ruling");
});

test("a book written under the old directory keys folds into one record, ruling and all", () => {
  // The reader's book as the shipped build left it: TWO records for one physical pair, both keyed by directory names.
  // The first was ruled on under the names the trees were cut with, then the panel renamed both trees and a second
  // record was minted under the renamed names - which is why the ruling "did not clear" the second one.
  const root = mkdtempSync(path.join(os.tmpdir(), "wag-collision-book-"));
  const file = path.join(root, "collisions.json");
  const side = (dirName) => ({
    path: `${WORKTREES}/${dirName}`,
    name: dirName,
    branch: `wtgui/${dirName}`,
    parent: "main",
    head: "abc1234",
    taskId: null,
    task: null,
  });
  const legacyKey = (one, two) => [one, two].map((s) => s.path.toLowerCase()).sort().join("|");
  const oldA = side(PRE_A);
  const oldB = side(PRE_B);
  const newA = side(POST_A);
  const newB = side(POST_B);
  const base = {
    project: PROJECT,
    source: "detected",
    bTarget: null,
    files: ["lib/shared.js"],
    relations: [{ kind: "shared-file", files: ["lib/shared.js"] }],
    notes: [],
    filed: {},
    stoodDown: {},
    firstAt: "2026-11-22T08:00:00.000Z",
    passAt: "2026-11-22T08:00:10.000Z",
    passes: 3,
    absent: null,
    merge: null,
    evidence: null,
    land: null,
    superseded: null,
    autoWithheld: null,
    sameTree: false,
    resolve: null,
  };
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      savedAt: "2026-11-22T08:10:00.000Z",
      records: [
        {
          ...base,
          key: legacyKey(oldA, oldB),
          a: oldA,
          b: oldB,
          reportedAt: "2026-11-22T08:00:00.000Z",
          lastAt: "2026-11-22T08:00:10.000Z",
          readerAt: "2026-11-22T08:00:10.000Z",
          readerWhy: "no-stand-down",
          ruling: {
            at: "2026-11-22T08:05:00.000Z",
            pick: "a",
            path: oldA.path,
            name: oldA.name,
            taskId: null,
            by: "reader",
            auto: false,
            reason: null,
            basis: null,
            note: "round A lands first",
          },
        },
        {
          ...base,
          key: legacyKey(newA, newB),
          a: newA,
          b: newB,
          firstAt: "2026-11-22T08:06:00.000Z",
          reportedAt: "2026-11-22T08:06:00.000Z",
          lastAt: "2026-11-22T08:06:10.000Z",
          readerAt: "2026-11-22T08:06:10.000Z",
          readerWhy: "no-stand-down",
          ruling: null,
        },
      ],
    })}\n`,
    "utf8",
  );
  try {
    const book = new CollisionBook({ file });
    assert.equal(book.all().length, 1, "the load folds the two older keys into one record");
    const [rec] = book.all();
    assert.equal(rec.key, pairKey(newA, newB), "the folded record answers to today's key");
    // The LETTER may differ - the sides are ordered by tree identity now, and the identity order can put the picked
    // tree second - so what must hold is that the letter names the TREE the reader picked, which is the tree the
    // ruling's own path names.
    assert.equal(rec.ruling?.path, oldA.path, "the ruling still names the tree the reader picked");
    assert.equal(rec[rec.ruling.pick]?.path, rec.ruling.path, "and the letter it is stored on points at that tree");
    assert.equal(stateOf(rec), "ruled");
    assert.equal(book.state().count, 0, "the swallowed second key leaves the Human count");

    // And the very next sweep, with the trees under their new names, asks for nothing.
    const after = [tree(POST_A), tree(POST_B)];
    const first = escalatePair(book, after, Date.parse("2026-11-22T09:30:00.000Z"));
    const again = escalatePair(book, after, Date.parse("2026-11-22T09:40:00.000Z"));
    assert.deepEqual(first.escalated, []);
    assert.deepEqual(again.escalated, [], "a ruled pair is not handed to the reader a second time");
    assert.deepEqual(first.filed, [], "and no notice is filed under the folded key");
    assert.equal(book.all().length, 1);
    assert.equal(book.get(rec.key).ruling.path, after[0].path, "the ruling names the tree as it is called now");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shared parent directory is not a shared file: only files BOTH sides touch count", () => {
  // The measured shape, built on a real disk: two trees, each untracked under the same parent directory, one with 39
  // files under a/ and the other 18 under b/, and no tracked file modified in either.
  const root = mkdtempSync(path.join(os.tmpdir(), "wag-collision-dirs-"));
  try {
    const dirA = path.join(root, PRE_A);
    const dirB = path.join(root, PRE_B);
    const sharedDir = ["docs", "assets", "initiatives-redesign"];
    mkdirSync(path.join(dirA, ...sharedDir, "a"), { recursive: true });
    mkdirSync(path.join(dirB, ...sharedDir, "b"), { recursive: true });
    for (let i = 1; i <= 39; i += 1) writeFileSync(path.join(dirA, ...sharedDir, "a", `round-a-${i}.js`), "a\n");
    for (let i = 1; i <= 18; i += 1) writeFileSync(path.join(dirB, ...sharedDir, "b", `round-b-${i}.js`), "b\n");

    // git's own spelling for a collapsed untracked tree: one entry, ending in "/". That trailing slash is the whole of
    // what separates a directory from a file in a row, and it is what the old key threw away.
    const rows = [
      tree(PRE_A, { path: dirA, dirtyFiles: [], untrackedFiles: ["docs/assets/initiatives-redesign/"] }),
      tree(PRE_B, { path: dirB, dirtyFiles: [], untrackedFiles: ["docs/assets/initiatives-redesign/"] }),
    ];
    assert.equal(touchedOf(rows[0]).dirty.length, 39, "the directory collapses to the 39 files under it");
    assert.deepEqual(detectCollisions(rows), [], "two different subtrees under one parent cannot conflict");

    // And the same directory still counts when both sides really do touch one file inside it.
    mkdirSync(path.join(dirA, ...sharedDir, "shared"), { recursive: true });
    mkdirSync(path.join(dirB, ...sharedDir, "shared"), { recursive: true });
    writeFileSync(path.join(dirA, ...sharedDir, "shared", "notes.md"), "same\n");
    writeFileSync(path.join(dirB, ...sharedDir, "shared", "notes.md"), "same\n");
    const pairs = detectCollisions(rows);
    assert.equal(pairs.length, 1, "a real file both sides touch is still a pair");
    assert.deepEqual(pairs[0].files, ["docs/assets/initiatives-redesign/shared/notes.md"]);
    assert.ok(
      !pairs[0].files.includes("docs/assets/initiatives-redesign"),
      "the directory itself is never the evidence",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record whose every side is gone leaves the reader count with no ruling", () => {
  const book = new CollisionBook({});
  const pairOne = [tree("stale-one-a"), tree("stale-one-b")];
  const pairTwo = [tree("stale-two-a"), tree("stale-two-b")];
  const twoOwners = {
    ownerOf: (side) => (side.path.endsWith("-a") ? "assistant-1" : "assistant-2"),
    tasksFor: () => [],
    fileQueue: () => ({ taskId: null }),
  };
  escalatePair(book, pairOne, Date.parse("2026-11-22T10:00:00.000Z"), twoOwners);
  escalatePair(book, pairTwo, Date.parse("2026-11-22T10:00:00.000Z"), twoOwners);
  // The reported note whose own tree was removed: its target named nothing, so the note was handed to the reader and
  // only `op:forget` could drop it.
  const goneNoteTree = `${WORKTREES}/reported-note-tree-e85acb`;
  book.recordNote({
    project: PROJECT,
    treePath: goneNoteTree,
    branch: "wtgui/reported-note-tree-e85acb",
    target: "a tree nobody can name",
    text: "both of us are rewriting lib/shared.js",
    rows: [],
    queues: [],
    liveAgents: null,
    at: "2026-11-22T10:01:00.000Z",
  });
  assert.equal(book.state().count, 3, "two pairs and a note are waiting on the reader");

  // Every tree those records name is gone from disk. pairTwo's second side is the one tree still standing, so its
  // record stays: only a record whose EVERY side is absent is settled without a person.
  const standing = `${WORKTREES}/stale-two-b`;
  const at = Date.parse("2026-11-22T10:05:00.000Z");
  const report = sweepCollisions({
    rows: [],
    book,
    now: at,
    ownerOf: (side) => (side.path.endsWith("-a") ? "assistant-1" : "assistant-2"),
    tasksFor: () => [],
    fileQueue: () => ({ taskId: null }),
    treeExists: (treePath) => treePath === standing,
  });

  assert.equal((report.gone || []).length, 2, "the pair with both trees gone and the note with its own tree gone");
  assert.equal(book.state().count, 1, "the record with a side still standing is still the reader's");
  const gonePair = book.all().find((rec) => rec.key === pairKey(pairOne[0].path, pairOne[1].path));
  assert.equal(stateOf(gonePair), "absent", "the verdict is a resolution, not a deleted record");
  assert.equal(gonePair.absent.how, "trees-gone");
  assert.match(gonePair.absent.why, /every tree this record names is gone/);
  assert.equal(gonePair.readerAt, null, "a record is a question or a verdict, never both");
  assert.equal(book.all().length, 3, "the verdicts are kept for reading, not dropped by the next sweep");

  // The marker on a row that is still drawn says why nobody is being asked: not "no live agent answers to it", which
  // was not true of a pair with two rows until the trees went.
  const view = book.forTree(`${WORKTREES}/stale-two-b`).find((v) => v.key === gonePair.key);
  assert.ok(!view, "the pair with both trees gone draws on no row");
  const noteView = book.forTree(goneNoteTree)[0];
  assert.equal(noteView.state, "absent");
  assert.match(lane.collisionTitle(noteView), /every tree it names is gone from disk/);
});
