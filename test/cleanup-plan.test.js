// The cleanup plan's rules, each one held still by a test of its own.
//
// The planner is pure (lib/cleanup-plan.js): it is handed the facts a read measured and returns a verdict per tree.
// That is what makes these tests worth having - every rule is pinned without a repository, a lock file or a job, and a
// rule that moves in the code cannot be covered up by the shape of a fixture.
//
// What is pinned here, each one a way this feature looks right and is wrong:
//
//   1. the primary checkout and the panel's own tree are never candidates, whatever their branch holds;
//   2. a locked tree is skipped with the lock's own sentence, and a tree a live job holds is skipped too - both
//      BEFORE any count is read, so no amount of "already merged" can outrank them;
//   3. a turnover branch, and the branch the project marks as its base, is kept even when its work is fully in main:
//      deleting it would orphan every child cut from it;
//   4. a branch that is an ancestor of main is dropped with an ANCESTOR proof, and a branch main lacks whose commits
//      are all cherry-equivalent is dropped with a CHERRY proof - and a cherry that was never measured is not a proof;
//   5. a clean branch holding work main lacks is MERGED (its tree stays), into a child of the turnover branch when the
//      project has one and of main when it does not;
//   6. a DIRTY branch holding work main lacks is merged too, its working tree is left alone, and the report names it;
//   7. a branch whose work is already in main but whose tree is dirty is kept, with the reason saying why;
//   8. nothing in a plan asks for a force.
import assert from "node:assert/strict";
import test from "node:test";

import { TURNOVER_NAME_RE, branchProtection, isTurnoverName, planCleanup, proofOf } from "../lib/cleanup-plan.js";

const PROJECT = { name: "demo", path: "/repos/demo", mainBranch: "main" };
const OWN = "/repos/demo/.worktrees/panel";
const tree = (over = {}) => ({
  path: "/repos/demo/.worktrees/x",
  branch: "wtgui/x",
  head: "1".repeat(40),
  dirty: false,
  dirtyFiles: [],
  ancestor: false,
  behind: 0,
  cherry: { ahead: 0, unique: 0, equivalent: 0, measured: true },
  main: "main",
  ...over,
});
const plan = (trees, project = PROJECT, extra = {}) =>
  planCleanup({ project, trees, primaryPath: project.path, ownPath: OWN, ...extra });
const rowFor = (rows, p) => rows.find((r) => r.path === p);

test("the primary checkout is skipped, even on a branch that is already landed and clean", () => {
  const r = plan([tree({ path: PROJECT.path, branch: "main", ancestor: true, cherry: { ahead: 0, unique: 0, equivalent: 0, measured: true } })]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].verdict, "skip");
  assert.match(r.rows[0].reason, /primary checkout/);
  assert.equal(r.droppable, 0);
});

test("a tree that CONTAINS the panel's cwd is skipped even when the cwd is below its root", () => {
  const r = plan([tree({ path: OWN, branch: "wtgui/panel", ancestor: true })], PROJECT, { ownPath: `${OWN}/sub/deeper` });
  assert.equal(r.rows[0].verdict, "skip");
  assert.match(r.rows[0].reason, /panel's own tree/);
});

test("a sibling worktree is NOT the panel's own tree: only the tree the cwd sits in is", () => {
  // The old guard asked `tree.startsWith(own + "/")`, so a worktree under the same folder as the own tree was swept
  // in too. The own tree is a containment question, asked one way only.
  const r = plan([tree({ path: "/repos/demo/.worktrees/x", branch: "wtgui/x", ancestor: true })]);
  assert.equal(r.rows[0].verdict, "remove");
  assert.equal(r.droppable, 1);
});

test("a plan whose ownPath IS the primary path still drops an ancestor-clean tree", () => {
  // The live bug: routes/project-cleanup.js passes process.cwd(), and a panel started from the primary checkout has
  // its cwd at the project root. Reading that as "every tree under here is the panel's own" made all 31 rows skip.
  const r = planCleanup({
    project: PROJECT,
    trees: [
      tree({ path: PROJECT.path, branch: "main", ancestor: true }),
      tree({ path: `${PROJECT.path}/.worktrees/landed`, branch: "wtgui/landed", ancestor: true }),
      tree({ path: `${PROJECT.path}/.worktrees/dirty`, branch: "wtgui/dirty", ancestor: true, dirty: true, dirtyFiles: ["lib/x.js"] }),
    ],
    primaryPath: PROJECT.path,
    ownPath: PROJECT.path,
  });
  const primary = rowFor(r.rows, PROJECT.path);
  const landed = rowFor(r.rows, `${PROJECT.path}/.worktrees/landed`);
  const dirty = rowFor(r.rows, `${PROJECT.path}/.worktrees/dirty`);
  assert.match(primary.reason, /primary checkout/);
  assert.equal(landed.verdict, "remove");
  assert.equal(landed.call, "drop");
  assert.equal(dirty.verdict, "keep");
  assert.equal(r.droppable, 1);
});

test("the own-tree skip holds even when the own tree's branch is fully merged: the guard is the path, not the git state", () => {
  const r = plan([tree({ path: OWN, branch: "wtgui/panel", ancestor: true, dirty: false })]);
  assert.equal(r.rows[0].call, "keep");
  assert.equal(r.droppable, 0);
});

test("a locked worktree is skipped with the lock's own sentence, before any count is read", () => {
  const r = plan([tree({ ancestor: true, locked: true, lockReason: "locked by the reader (do not touch: pairing with Sam)" })]);
  assert.equal(r.rows[0].verdict, "skip");
  assert.equal(r.rows[0].reason, "locked by the reader (do not touch: pairing with Sam)");
  assert.equal(r.droppable, 0);
});

test("a worktree a live job holds is skipped and the job is named", () => {
  const r = plan([tree({ ancestor: true, liveJob: "job-42" })]);
  assert.equal(r.rows[0].verdict, "skip");
  assert.match(r.rows[0].reason, /live job holds it \(job-42\)/);
});

test("a turnover branch is kept even though its work is in main, and the reason says it is never deleted", () => {
  const r = plan([tree({ branch: "20260710_1338_DMR-39015-forecast", ancestor: true })]);
  assert.equal(r.rows[0].verdict, "keep");
  assert.match(r.rows[0].reason, /turnover branch/);
  assert.equal(r.droppable, 0);
});

test("a turnover name that main already contains is still kept: protection is asked before the ancestor rule", () => {
  const r = plan([tree({ branch: "20260101_AB12_FOO-add-thing", ancestor: true, behind: 9 })]);
  assert.equal(r.rows[0].verdict, "keep");
  assert.match(r.rows[0].reason, /turnover branch/);
});

test("the project's base branch is kept when it is some other name than main", () => {
  const project = { ...PROJECT, turnoverBranch: "release/2026" };
  const r = planCleanup({
    project,
    trees: [tree({ branch: "main", ancestor: true }), tree({ branch: "release/2026", ancestor: true })],
    primaryPath: "/repos/other",
    ownPath: "",
  });
  const mainRow = r.rows.find((x) => x.branch === "main");
  const releaseRow = r.rows.find((x) => x.branch === "release/2026");
  assert.equal(mainRow.verdict, "keep");
  assert.match(mainRow.reason, /base branch/);
  assert.equal(releaseRow.verdict, "keep");
  assert.match(releaseRow.reason, /base branch/);
});

test("the turnover name pattern covers the brief's shape and the fleet's real YYYYMMDD_HHMM_TICKET_desc", () => {
  assert.match("20260101_AB_add", TURNOVER_NAME_RE);
  assert.match("20260710_1338_DMR-39015-forecast", TURNOVER_NAME_RE);
  assert.equal(isTurnoverName("wtgui/add-the-chip"), false);
  assert.equal(isTurnoverName("feature/menu-oauth2"), false);
  assert.equal(isTurnoverName("refs/heads/20260710_1338_DMR-1-x"), true);
  assert.equal(isTurnoverName(""), false);
  assert.equal(branchProtection("wtgui/x", PROJECT), "");
});

test("a clean branch that is an ancestor of main is dropped, with an ancestor proof", () => {
  const r = plan([tree({ ancestor: true })]);
  assert.equal(r.rows[0].verdict, "remove");
  assert.equal(r.rows[0].call, "drop");
  assert.equal(r.rows[0].proof.kind, "ancestor");
  assert.match(r.rows[0].proof.detail, /ancestor of main/);
  assert.equal(r.droppable, 1);
});

test("a clean branch whose commits main lacks are all cherry-equivalent is dropped, with a cherry proof", () => {
  const r = plan([tree({ cherry: { ahead: 2, unique: 0, equivalent: 2, measured: true } })]);
  assert.equal(r.rows[0].verdict, "remove");
  assert.equal(r.rows[0].proof.kind, "cherry");
  assert.match(r.rows[0].proof.detail, /cherry-equivalent/);
});

test("a cherry that could not be measured is not a proof: the branch is merged, never dropped", () => {
  const r = plan([tree({ cherry: { ahead: 2, unique: 0, equivalent: 0, measured: false } })]);
  assert.equal(r.rows[0].verdict, "merge");
  assert.equal(r.rows[0].proof.kind, "none");
});

test("a cherry that judged FEWER commits than main lacks is not a proof either: the unjudged commit keeps the branch", () => {
  // `git cherry` prints no mark for a merge commit, so a branch with 3 commits ahead and a merge in it yields 2 marks.
  // unique === 0 would be true there and the drop would rest on a commit nobody judged; equivalent === ahead is the
  // proof, and two-of-three is not it.
  const r = plan([tree({ cherry: { ahead: 3, unique: 0, equivalent: 2, measured: true } })]);
  assert.equal(r.rows[0].verdict, "merge", "a partial content proof must not delete a branch");
  assert.equal(r.rows[0].proof.kind, "none");
  assert.match(r.rows[0].proof.detail, /marked only 2 of 3 commits main lacks/);
  assert.match(r.rows[0].proof.detail, /1 commit is unproved/);
});

test("a branch holding exactly one commit main lacks keeps it: no content delete, no unmeasured drop", () => {
  const r = plan([tree({ cherry: { ahead: 1, unique: 1, equivalent: 0, measured: true } })]);
  assert.equal(r.rows[0].verdict, "merge");
  assert.equal(r.rows[0].proof.kind, "none");
  assert.match(r.rows[0].proof.detail, /1 of 1 commit main lacks is not in main by content/);
});

test("a clean branch with work main lacks is merged into a child of main when the project has no turnover branch", () => {
  const r = plan([tree({ cherry: { ahead: 3, unique: 3, equivalent: 0, measured: true } })]);
  assert.equal(r.rows[0].verdict, "merge");
  assert.equal(r.rows[0].call, "keep");
  assert.equal(r.rows[0].merge.base, "main");
  assert.equal(r.rows[0].merge.treeKept, false);
  assert.match(r.rows[0].reason, /merge the branch --no-ff into a child of main/);
});

test("the child is cut from the project's turnover branch when it has one", () => {
  const project = { ...PROJECT, turnoverBranch: "20260710_1338_DMR-1-x" };
  const r = plan([tree({ cherry: { ahead: 1, unique: 1, equivalent: 0, measured: true } })], project);
  assert.equal(r.rows[0].merge.base, "20260710_1338_DMR-1-x");
});

test("a DIRTY tree with commits main lacks is merged, its working tree is left alone, and the report says so", () => {
  const r = plan([tree({ dirty: true, dirtyFiles: ["lib/a.js", "docs/b.md"], cherry: { ahead: 2, unique: 2, equivalent: 0, measured: true } })]);
  assert.equal(r.rows[0].verdict, "merge");
  assert.equal(r.rows[0].merge.treeKept, true);
  assert.match(r.rows[0].reason, /leave the tree, and never the working tree, alone/);
  assert.deepEqual(r.rows[0].dirtyFiles, ["lib/a.js", "docs/b.md"]);
});

test("a dirty tree whose commits are already in main is kept, and the reason names the uncommitted work", () => {
  const r = plan([tree({ ancestor: true, dirty: true, dirtyFiles: ["lib/a.js"] })]);
  assert.equal(r.rows[0].verdict, "keep");
  assert.match(r.rows[0].reason, /uncommitted work \(1 file\)/);
  assert.equal(r.droppable, 0);
});

test("a dirty tree whose commits are cherry-equivalent in main is kept for the same reason", () => {
  const r = plan([tree({ dirty: true, dirtyFiles: ["a", "b"], cherry: { ahead: 1, unique: 0, equivalent: 1, measured: true } })]);
  assert.equal(r.rows[0].verdict, "keep");
  assert.match(r.rows[0].reason, /cherry-equivalent in main but its tree holds uncommitted work/);
});

test("a detached tree has no branch for the proof to be about, so it is kept", () => {
  const r = plan([tree({ branch: null, ancestor: true })]);
  assert.equal(r.rows[0].verdict, "keep");
  assert.match(r.rows[0].reason, /detached HEAD/);
});

test("a tree whose counts were never read is kept, with no proof claimed either way", () => {
  // The last rule: `rev-list` could not answer (a broken tree, a missing main), so ahead is 0 and ancestor is false.
  // Neither a drop nor a merge is justified by a read that did not happen.
  const r = plan([tree({ ancestor: false, cherry: { ahead: 0, unique: 0, equivalent: 0, measured: false } })]);
  assert.equal(r.rows[0].verdict, "keep");
  assert.equal(r.rows[0].call, "keep");
  assert.match(r.rows[0].reason, /no proof it is safe to drop/);
  assert.equal(r.droppable, 0);
});

test("a directory that is not a tree of its own is skipped with its reason", () => {
  const r = plan([tree({ ancestor: true, notOwnTree: "not a git worktree root: no .git entry at /repos/demo/.worktrees/x" })]);
  assert.equal(r.rows[0].verdict, "skip");
  assert.match(r.rows[0].reason, /not a git worktree root/);
});

test("a worktree of this repository that sits outside the project folder is skipped, however landed it is", () => {
  // `git worktree list` answers for the repository, so a lander's comparison tree elsewhere on disk is in it. The board
  // never draws such a tree as a row, so the cleanup must not act on it: its controls would be guards the row's own x
  // does not have. Ancestor-and-clean is the shape that would otherwise be dropped.
  const r = plan([tree({ path: "/scratch/land-check/demo", branch: "land/demo-check", ancestor: true, outside: true })]);
  assert.equal(r.rows[0].verdict, "skip");
  assert.match(r.rows[0].reason, /sits outside \/repos\/demo/);
  assert.equal(r.droppable, 0);
});

test("the counts add up, one per row, and droppable is the drop count", () => {
  const r = plan([
    tree({ path: "/repos/demo/.worktrees/a", branch: "wtgui/a", ancestor: true }),
    tree({ path: "/repos/demo/.worktrees/b", branch: "wtgui/b", cherry: { ahead: 2, unique: 0, equivalent: 2, measured: true } }),
    tree({ path: "/repos/demo/.worktrees/c", branch: "wtgui/c", cherry: { ahead: 1, unique: 1, equivalent: 0, measured: true } }),
    tree({ path: "/repos/demo/.worktrees/d", branch: "wtgui/d", ancestor: true, dirty: true, dirtyFiles: ["x"] }),
    tree({ path: "/repos/demo/.worktrees/e", branch: "wtgui/e", ancestor: true, locked: true, lockReason: "locked" }),
  ]);
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.counts, { remove: 2, merge: 1, keep: 1, skip: 1 });
  assert.equal(r.droppable, 2);
  assert.equal(rowFor(r.rows, "/repos/demo/.worktrees/a").call, "drop");
  assert.equal(rowFor(r.rows, "/repos/demo/.worktrees/c").call, "keep");
});

test("no plan asks for a force: the word does not exist anywhere in a row", () => {
  const r = plan([
    tree({ path: "/repos/demo/.worktrees/a", branch: "wtgui/a", ancestor: true }),
    tree({ path: "/repos/demo/.worktrees/c", branch: "wtgui/c", cherry: { ahead: 1, unique: 1, equivalent: 0, measured: true }, dirty: true, dirtyFiles: ["y"] }),
  ]);
  // The merge row is where a "force it through" flag would appear if the planner ever grew one.
  assert.equal(r.rows.some((row) => "force" in row || "force" in (row.merge || {})), false);
  assert.equal(JSON.stringify(r).toLowerCase().includes("force"), false);
});

test("proofOf names the branch and the main branch it was measured against", () => {
  const p = proofOf({ branch: "wtgui/x", main: "trunk", ancestor: true });
  assert.match(p.detail, /wtgui\/x is an ancestor of trunk/);
});
