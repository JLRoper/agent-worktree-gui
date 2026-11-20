// SETTLING A COLLISION FROM GIT, NOT FROM THE READER: the decision function, the sweep that uses it, and the way an
// automatic pick is drawn.
//
// WHY THESE CASES. The reader's rule is that a collision is only his when neither order makes the merge harder, and
// each fixture is one of the three answers `git merge-tree` can give:
//
//   * ONE DIRECTION CLEAN - the order is named by git and nothing else is needed. The side the other one merges onto
//     goes first; the pair is auto-ruled and files no notice;
//   * BOTH DIRECTIONS CLEAN - either order merges, so the reader's own tie-break decides: older cut, then fewer
//     commits, then branch name. This must be the SAME answer however the pair is seen, which is the point of it;
//   * BOTH DIRECTIONS CONFLICT - the only pair that still raises the card, and the only one that may reach him.
//
// Plus the regressions the brief names: a re-detected pair never asks twice (no second probe, no second ruling, no
// card), a withdrawn automatic pick is not put straight back, and a question git could not answer never settles
// silently. The probe itself is exercised against a real temporary repository, because "it ran merge-tree in both
// directions against the two tips" is a fact about processes, not about a stub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CollisionBook, deterministicPick, mayAskReader, settleCollision, sideOf, stateOf } from "../lib/collisions.js";
import { rulingRowsFor, sweepCollisions } from "../lib/collision-flow.js";
import { mergeConflictPaths, probePairMerge } from "../lib/collision-merge.js";

await import("../public/core/review-lane.js");
const lane = globalThis.wtReviewLane;

const PROJECT = "coll-proj";
const TREE = (name, over = {}) => ({
  project: PROJECT,
  path: `/repos/${PROJECT}/.worktrees/${name}`,
  name,
  branch: `wtgui/${name}`,
  head: String(over.head || (name === "coll-a" ? "a" : "b")).repeat(40).slice(0, 40),
  parent: "main",
  live: true,
  dirtyFiles: [{ code: "M", path: "lib/shared.js" }],
  untrackedFiles: [],
  commitFiles: [],
  ...over,
});
const SIDE = (name, over = {}) => sideOf(TREE(name, over));
const PAIR = (over = {}) => ({
  key: "pair-key",
  project: PROJECT,
  a: SIDE("coll-a"),
  b: SIDE("coll-b"),
  files: ["lib/shared.js"],
  relations: [{ kind: "shared-file", files: ["lib/shared.js"] }],
  ...over,
});
const MERGE = ({ aClean = null, bClean = null, a = null, b = null, aFirst = null, bFirst = null, tips = null } = {}) => ({
  ok: true,
  at: "2026-11-19T12:00:00.000Z",
  // The tips a real probe records: the sweep reuses an answer while the pair still stands on them.
  tips: tips || { a: SIDE("coll-a").head, b: SIDE("coll-b").head },
  aFirst: aFirst || { clean: aClean, conflicts: aClean === false ? ["lib/shared.js"] : [], error: null },
  bFirst: bFirst || { clean: bClean, conflicts: bClean === false ? ["lib/shared.js"] : [], error: null },
  a,
  b,
});

// ---- 1. one direction clean -------------------------------------------------------------------------------------
test("one clean direction names the order: the side the other merges onto goes first", () => {
  // A first is clean, so B's work merges onto A without a conflict: A goes first and B still lands.
  const settled = settleCollision({ ...PAIR(), merge: MERGE({ aClean: true, bClean: false }) });
  assert.equal(settled.why, "one-direction");
  assert.equal(settled.pick, "a");
  assert.match(settled.reason, /coll-b merges onto coll-a without a conflict, so coll-a goes first/);
  // The same pair with the other direction clean names the other side - the rule reads git, not the row order.
  const other = settleCollision({ ...PAIR(), merge: MERGE({ aClean: false, bClean: true }) });
  assert.equal(other.pick, "b");
  assert.match(other.reason, /coll-a merges onto coll-b without a conflict, so coll-b goes first/);
  // One clean direction is never a question for the reader.
  assert.equal(mayAskReader({ ...PAIR(), merge: MERGE({ aClean: true, bClean: false }) }), false);
  assert.equal(mayAskReader({ ...PAIR(), merge: MERGE({ aClean: false, bClean: true }) }), false);
});

// ---- 2. both directions clean: the deterministic pick -----------------------------------------------------------
test("both directions clean: older cut first, then fewer commits, then the branch name", () => {
  const facts = { a: { cutAt: "2026-11-19T09:00:00.000Z", commits: 4 }, b: { cutAt: "2026-11-19T10:00:00.000Z", commits: 1 } };
  const both = settleCollision({ ...PAIR(), merge: MERGE({ aClean: true, bClean: true, ...facts }) });
  assert.equal(both.why, "both-clean");
  assert.equal(both.pick, "a");
  assert.equal(both.basis, "older cut");
  assert.equal(both.reason, "no merge risk either way, and the older cut goes first");

  // Reversed sides give the reversed answer: the rule is about the trees, never about which row asked.
  const reversed = settleCollision({ a: PAIR().b, b: PAIR().a, merge: MERGE({ aClean: true, bClean: true, a: facts.b, b: facts.a }) });
  assert.equal(reversed.pick, "b");
  assert.equal(reversed.basis, "older cut");

  // The same cut second: fewer commits goes first.
  const tie = settleCollision({ ...PAIR(), merge: MERGE({ aClean: true, bClean: true, a: facts.a, b: { cutAt: facts.a.cutAt, commits: 2 } }) });
  assert.equal(tie.pick, "b");
  assert.equal(tie.basis, "fewer commits");

  // Same cut and same count: the branch name breaks it, and it breaks the same way every time.
  const named = settleCollision({ ...PAIR(), merge: MERGE({ aClean: true, bClean: true, a: facts.a, b: { cutAt: facts.a.cutAt, commits: 4 } }) });
  assert.equal(named.basis, "branch name");
  assert.equal(named.pick, "a");
  assert.equal(deterministicPick(PAIR().a, PAIR().b, { a: {}, b: {} }).pick, "a");
  // Swapped input still names the same TREE: with no facts at all the branch name decides, and it decides the same side.
  const swapped = deterministicPick(PAIR().b, PAIR().a, { a: {}, b: {} });
  assert.equal(swapped.pick, "b");
  assert.equal(swapped.pick === "a" ? PAIR().b.branch : PAIR().a.branch, "wtgui/coll-a");

  // No facts at all is still an answer, and still the same one: a missing cut is not "infinitely old", so the branch
  // name decides.
  const bare = settleCollision({ ...PAIR(), merge: MERGE({ aClean: true, bClean: true }) });
  assert.equal(bare.pick, "a");
  assert.equal(bare.basis, "branch name");
});

// ---- 3. both directions conflict: the only card ----------------------------------------------------------------
test("both directions conflict: no pick, and that is the only collision that asks the reader", () => {
  const rec = { ...PAIR(), merge: MERGE({ aClean: false, bClean: false }) };
  const settled = settleCollision(rec);
  assert.equal(settled.pick, null);
  assert.equal(settled.why, "both-conflict");
  assert.match(settled.reason, /both directions conflict/);
  assert.equal(mayAskReader(rec), true);

  // A question git could not answer is the reader's too: silence must never settle a pair.
  const unknown = settleCollision({ ...PAIR(), merge: MERGE({ aClean: null, bClean: null }) });
  assert.equal(unknown.why, "unknown");
  assert.equal(unknown.pick, null);
  assert.equal(mayAskReader({ ...PAIR(), merge: MERGE({ aClean: null, bClean: null }) }), true);
  assert.equal(mayAskReader({ ...PAIR(), merge: null }), true);

  // One direction alone, with the other unanswered, is still a safe order: that direction IS clean.
  assert.equal(settleCollision({ ...PAIR(), merge: MERGE({ aClean: true, bClean: null }) }).pick, "a");
  assert.equal(mayAskReader({ ...PAIR(), merge: MERGE({ aClean: false, bClean: null }) }), true, "neither direction proved clean");
});

// ---- the sweep -------------------------------------------------------------------------------------------------
const ownerOf = (side) => (side.path.endsWith("coll-a") ? "assistant-1" : "assistant-2");

test("a pair git can order is settled automatically, once, and asks nothing on any later sweep", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collision-settle-"));
  try {
    const file = path.join(dir, "collisions.json");
    const book = new CollisionBook({ file });
    let probes = 0;
    const filed = [];
    const rows = [TREE("coll-a"), TREE("coll-b")];
    const deps = {
      ownerOf,
      tasksFor: () => [],
      fileQueue: (payload) => {
        filed.push(payload);
        return { taskId: 500 + filed.length };
      },
      probeMerge: () => {
        probes += 1;
        return MERGE({ aClean: true, bClean: false });
      },
    };
    const first = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
    assert.equal(first.pairs, 1);
    assert.deepEqual(first.settled.map((s) => [s.pick, s.why, s.basis]), [["a", "one-direction", "merge"]]);
    assert.deepEqual(first.escalated, []);
    assert.deepEqual(filed, [], "a settled pair files no notice: the Ruled row is the one that carries the order");

    const [rec] = book.all();
    assert.equal(rec.ruling.by, "auto");
    assert.equal(rec.ruling.auto, true);
    assert.equal(rec.ruling.pick, "a");
    assert.equal(rec.ruling.name, "coll-a");
    assert.match(rec.ruling.reason, /coll-b merges onto coll-a/);
    assert.equal(rec.merge.aFirst.clean, true);
    assert.equal(stateOf(rec), "ruled");
    assert.equal(book.state().count, 0, "nothing waits on the reader for a pair the panel settled");

    // THE RULED ROW both assistants read is the same row a reader's ruling files, tagged automatic.
    const broadcast = rulingRowsFor(rec, { ownerOf, nameOf: (id) => id });
    assert.equal(broadcast.length, 2);
    for (const row of broadcast) {
      assert.equal(row.automatic, true);
      assert.match(row.title, /^Ruled \(automatic\): coll-a goes first over coll-b$/);
      assert.match(row.detail, /The PANEL settled this pair automatically/);
      assert.match(row.detail, /reader can overrule this automatic pick/);
    }

    // THE REGRESSION: the same pair, re-detected from the other row's side, asks git nothing and the reader nothing.
    for (const offset of [4000, 9000, 14000]) {
      const again = sweepCollisions({ rows: [...rows].reverse(), book, now: Date.parse("2026-11-19T12:00:00.000Z") + offset, ...deps });
      assert.equal(again.pairs, 1);
      assert.deepEqual(again.settled, []);
      assert.deepEqual(again.escalated, []);
      assert.deepEqual(again.filed, []);
    }
    assert.equal(probes, 1, "a settled pair is never probed again");
    assert.equal(book.all().length, 1);
    assert.equal(book.get(rec.key).ruling.pick, "a");

    // The ruling and git's evidence survive a restart: the file is the store, and a reopened book reads them back.
    assert.equal(book.save().ok, true);
    const reread = new CollisionBook({ file });
    assert.equal(reread.get(rec.key).ruling.auto, true);
    assert.equal(reread.get(rec.key).ruling.reason, rec.ruling.reason);
    assert.equal(reread.get(rec.key).merge.aFirst.clean, true);
    assert.equal(stateOf(reread.get(rec.key)), "ruled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both directions clean is settled by the same tie-break however the rows arrive", () => {
  const book = new CollisionBook({});
  const rows = [TREE("coll-a"), TREE("coll-b")];
  const facts = { a: { cutAt: "2026-11-19T09:00:00.000Z", commits: 3 }, b: { cutAt: "2026-11-19T10:00:00.000Z", commits: 1 } };
  const deps = {
    ownerOf,
    tasksFor: () => [],
    fileQueue: () => ({ taskId: 1 }),
    probeMerge: () => MERGE({ aClean: true, bClean: true, ...facts }),
  };
  const forward = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  assert.deepEqual(forward.settled.map((s) => [s.pick, s.basis]), [["a", "older cut"]]);
  // A second book, fed the rows the other way round, settles on the same TREE: the pick is a side of the pair, and
  // the pair's sides are ordered by path, never by the order the detector happened to walk the rows.
  const second = new CollisionBook({});
  const backward = sweepCollisions({ rows: [...rows].reverse(), book: second, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  assert.deepEqual(backward.settled.map((s) => [s.pick, s.basis]), [["a", "older cut"]]);
  assert.equal(second.all()[0].ruling.path, book.all()[0].ruling.path);
});

test("both directions conflicting: no ruling on the first pass, the card on the second", () => {
  const book = new CollisionBook({});
  const rows = [TREE("coll-a"), TREE("coll-b")];
  let probes = 0;
  const filed = [];
  const deps = {
    ownerOf,
    tasksFor: () => [],
    fileQueue: (payload) => {
      filed.push(payload);
      return { taskId: 700 + filed.length };
    },
    probeMerge: () => {
      probes += 1;
      return MERGE({ aClean: false, bClean: false });
    },
  };
  const first = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  assert.deepEqual(first.settled, [], "git cannot order this pair, and the panel does not guess");
  assert.equal(filed.length, 2, "the assistants still get their notices first");
  assert.equal(stateOf(book.all()[0]), "assistants");
  assert.equal(book.all()[0].merge.aFirst.clean, false);
  // The pass rule hands it over, because that is the pair the reader really has to decide.
  const second = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:04.000Z"), ...deps });
  assert.deepEqual(second.escalated.map((e) => e.why), ["no-stand-down"]);
  assert.equal(stateOf(book.all()[0]), "reader");
  assert.equal(book.state().count, 1);
  assert.equal(probes, 1, "the second pass reads the answer the record already carries");
});

test("a withdrawn automatic pick is not put straight back: the pair becomes the reader's", () => {
  const book = new CollisionBook({});
  const rows = [TREE("coll-a"), TREE("coll-b")];
  let probes = 0;
  const deps = {
    ownerOf,
    tasksFor: () => [],
    fileQueue: () => ({ taskId: 900 }),
    probeMerge: () => {
      probes += 1;
      return MERGE({ aClean: true, bClean: true });
    },
  };
  sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  const key = book.all()[0].key;
  assert.equal(book.get(key).ruling.auto, true);
  // The reader overrules it with the same withdraw the card has always had.
  const cleared = book.rule(key, { pick: "clear", at: Date.parse("2026-11-19T12:00:02.000Z") });
  assert.equal(cleared.ok, true);
  assert.equal(book.get(key).ruling, null);
  assert.deepEqual(book.get(key).autoWithheld.pick, "a");
  assert.equal(stateOf(book.get(key)), "assistants");
  // The next sweep does not re-probe and does not re-rule, and the pass then brings the pair to the reader.
  const next = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:04.000Z"), ...deps });
  assert.deepEqual(next.settled, []);
  assert.equal(book.get(key).ruling, null);
  assert.deepEqual(next.escalated.map((e) => e.why), ["no-stand-down"]);
  assert.equal(stateOf(book.get(key)), "reader");
  assert.equal(probes, 1);
});

test("a probe git could not answer never settles silently: the pair is still the reader's", () => {
  const book = new CollisionBook({});
  const rows = [TREE("coll-a"), TREE("coll-b")];
  const deps = {
    ownerOf,
    tasksFor: () => [],
    fileQueue: () => ({ taskId: 950 }),
    probeMerge: () => ({ ok: false, at: "2026-11-19T12:00:00.000Z", error: "git exited 129", aFirst: null, bFirst: null }),
  };
  const first = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:00.000Z"), ...deps });
  assert.deepEqual(first.settled, []);
  assert.equal(book.all()[0].ruling, null);
  const second = sweepCollisions({ rows, book, now: Date.parse("2026-11-19T12:00:04.000Z"), ...deps });
  assert.deepEqual(second.escalated.map((e) => e.why), ["no-stand-down"]);
  assert.equal(stateOf(book.all()[0]), "reader");
});

// ---- the lane and the probe -------------------------------------------------------------------------------------
test("the review lane draws an automatic pick as auto-settled with the reason, not as already ruled", () => {
  const rec = {
    key: "k",
    state: "ruled",
    role: "a",
    a: SIDE("coll-a"),
    b: SIDE("coll-b"),
    other: SIDE("coll-b"),
    files: ["lib/shared.js"],
    ruling: { pick: "a", name: "coll-a", auto: true, reason: "no merge risk either way, and the older cut goes first" },
  };
  const automatic = lane.collisionTitle(rec);
  assert.match(automatic, /auto-settled: coll-a goes first - no merge risk either way, and the older cut goes first/);
  assert.doesNotMatch(automatic, /already ruled/);
  // The reader's own ruling still reads as his, and the count/rotation do not treat either as waiting on him.
  const reader = lane.collisionTitle({ ...rec, ruling: { pick: "b", name: "coll-b", auto: false } });
  assert.match(reader, /already ruled: coll-b goes first/);
  assert.deepEqual(lane.awaitingCollisions({ path: "p", collisions: [rec] }), []);
});

test("the probe asks merge-tree in both directions against the two tips", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collision-merge-"));
  try {
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const email = `${os.userInfo().username || "test"}@${os.hostname() || "localhost"}.invalid`;
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: email,
    };
    const run = (args, cwd = repo) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
    run(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(repo, "shared.txt"), "base\n");
    run(["add", "."]);
    run(["commit", "-qm", "base"]);
    const a = path.join(dir, "tree-a");
    const b = path.join(dir, "tree-b");
    run(["worktree", "add", "-q", "-b", "wtgui/tree-a", a]);
    run(["worktree", "add", "-q", "-b", "wtgui/tree-b", b]);
    // Two DIFFERENT files: either order merges, so both directions are clean.
    writeFileSync(path.join(a, "a.txt"), "a\n");
    run(["add", "."], a);
    run(["commit", "-qm", "a side"], a);
    writeFileSync(path.join(b, "b.txt"), "b\n");
    run(["add", "."], b);
    run(["commit", "-qm", "b side"], b);
    const pair = {
      key: "k",
      a: sideOf({ path: a, branch: "wtgui/tree-a", head: run(["rev-parse", "HEAD"], a) }),
      b: sideOf({ path: b, branch: "wtgui/tree-b", head: run(["rev-parse", "HEAD"], b) }),
    };
    const clean = probePairMerge(pair);
    assert.equal(clean.ok, true);
    assert.equal(clean.aFirst.clean, true);
    assert.equal(clean.bFirst.clean, true);
    assert.equal(clean.tips.a, run(["rev-parse", "HEAD"], a), "the tip is the scanned sha");
    assert.equal(clean.a.commits, 1);
    assert.ok(clean.a.cutAt > 0, "the cut is read, so the tie-break has a fact to compare");
    // The same two trees, now changing the SAME file: both directions conflict, and the probe names the path.
    writeFileSync(path.join(a, "shared.txt"), "a\n");
    run(["commit", "-qam", "a changes shared"], a);
    writeFileSync(path.join(b, "shared.txt"), "b\n");
    run(["commit", "-qam", "b changes shared"], b);
    const conflicted = probePairMerge({
      key: "k",
      a: sideOf({ path: a, branch: "wtgui/tree-a", head: run(["rev-parse", "HEAD"], a) }),
      b: sideOf({ path: b, branch: "wtgui/tree-b", head: run(["rev-parse", "HEAD"], b) }),
    });
    assert.equal(conflicted.ok, true);
    assert.equal(conflicted.aFirst.clean, false);
    assert.equal(conflicted.bFirst.clean, false);
    assert.deepEqual(conflicted.aFirst.conflicts, ["shared.txt"]);
    assert.equal(conflicted.a, null, "the tie-break facts are not read when the order is the reader's");
    // A pair whose tip the repository does not have is not an answer at all.
    const missing = probePairMerge({ key: "k", a: pair.a, b: { ...pair.b, head: "0".repeat(40) } });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /does not resolve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the conflict list is read from merge-tree's own block, never from its messages", () => {
  const out = ["875c96da9ac67ae8a0d5b33617f623cd1c9e3bd9", "a.txt", "lib/shared.js", "", "Auto-merging a.txt", "CONFLICT (content): Merge conflict in a.txt"].join("\n");
  assert.deepEqual(mergeConflictPaths(out), ["a.txt", "lib/shared.js"]);
  assert.deepEqual(mergeConflictPaths("d26f8c6069aafbd60876ccbed9d5524da5106cea\n"), []);
});
