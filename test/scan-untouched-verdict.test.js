// What a row says when the branch never committed anything. A worktree branch can be re-pointed at main
// (a `git pull`/`merge --ff-only`, a reset) without ever making a commit, and the reflog then holds two
// shas — which the panel used to read as "it moved, so it was merged". That is a merge invented out of a
// fast-forward: there is nothing of the branch's own on main because the branch never had anything.
//
// Each case is built against real git in one project with a bare origin and a second clone standing for
// "somebody else" who moves main, and each row is scanned at the moment its state is true. NO COMMITS is
// what makes the row offer its tree for cleanup; MERGED is a claim about the branch's OWN work, so it is
// only allowed when the reflog proves the branch made a commit.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanWorktree } from "../lib/scan.js";
import { Store } from "../lib/store.js";
import { git } from "../tools/panel-testkit.mjs";

const root = mkdtempSync(path.join(tmpdir(), "wag-untouched-verdict-"));
after(() => rmSync(root, { recursive: true, force: true }));
const p = (...s) => path.join(root, ...s).replace(/\\/g, "/");

let n = 0;
const commit = (dir, file, msg = file) => {
  writeFileSync(path.join(dir, file), `${msg} ${++n}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", msg);
};

// origin (bare) <- project (the reader's clone) ; other (a second clone that moves main)
git(root, "init", "-q", "--bare", "-b", "main", p("origin.git"));
git(root, "clone", "-q", p("origin.git"), p("project"));
git(p("project"), "switch", "-q", "-C", "main");
commit(p("project"), "base.txt");
git(p("project"), "push", "-q", "-u", "origin", "main");
git(root, "clone", "-q", p("origin.git"), p("other"));
git(p("other"), "switch", "-q", "-C", "main");

const ctx = { remoteRef: "origin/main", mainBranch: "main", parents: [] };
const scan = (dir) => scanWorktree(dir, ctx, "full");
const rows = {};

// The branch the bug was reported on: cut from origin/main, never committed, then fast-forwarded onto a
// newer main (a `git pull` in the tree, or the panel's own catch-up). Its reflog has TWO shas and no
// `commit:` line — it moved, but nothing of it was ever written.
git(p("project"), "worktree", "add", "-q", "-b", "wg/ffed", p("ffed"), "origin/main");
commit(p("other"), "main-advance.txt", "advance main");
git(p("other"), "push", "-q", "origin", "main");
git(p("project"), "fetch", "-q", "origin");
git(p("ffed"), "merge", "-q", "--ff-only", "origin/main");
rows.ffed = await scan(p("ffed"));

// A pristine branch, cut from the current main and never touched: the case that already said NO COMMITS.
git(p("project"), "worktree", "add", "-q", "-b", "wg/fresh", p("fresh"), "origin/main");
rows.fresh = await scan(p("fresh"));

// A squash-merged branch: two commits of its own, squashed into main by somebody else. The squash has a
// different patch-id from either commit, so only the tree comparison can see that it landed.
git(p("project"), "worktree", "add", "-q", "-b", "wg/squashed", p("squashed"), "origin/main");
commit(p("squashed"), "squash-one.txt", "the first half");
commit(p("squashed"), "squash-two.txt", "the second half");
git(p("squashed"), "push", "-q", "origin", "wg/squashed");
git(p("other"), "fetch", "-q", "origin");
git(p("other"), "merge", "-q", "--squash", "origin/wg/squashed");
git(p("other"), "commit", "-q", "-m", "the branch's work, squashed");
git(p("other"), "push", "-q", "origin", "main");
git(p("project"), "fetch", "-q", "origin");
rows.squashed = await scan(p("squashed"));

// A branch cut from another branch's landed work: it inherits one commit and makes none of its own. Its
// patches are in main (the single-commit squash keeps the patch id), which is evidence about the commits
// it points at — not about work this branch did.
git(p("project"), "worktree", "add", "-q", "-b", "wg/parent-work", p("parent-work"), "origin/main");
commit(p("parent-work"), "parent.txt", "the parent's work");
git(p("parent-work"), "push", "-q", "origin", "wg/parent-work");
git(p("other"), "fetch", "-q", "origin");
git(p("other"), "merge", "-q", "--squash", "origin/wg/parent-work");
git(p("other"), "commit", "-q", "-m", "the parent's work, squashed");
git(p("other"), "push", "-q", "origin", "main");
git(p("project"), "fetch", "-q", "origin");
git(p("project"), "worktree", "add", "-q", "-b", "wg/inherits", p("inherits"), "wg/parent-work");
rows.inherits = await scan(p("inherits"));

// A real merged PR: its commit is an ancestor of main. The tree is then fast-forwarded to main as well,
// so the reflog has a move on top of the commit — the count must still name the branch's own commit.
git(p("project"), "worktree", "add", "-q", "-b", "wg/landed", p("landed"), "origin/main");
commit(p("landed"), "landed.txt", "the work that landed");
git(p("landed"), "push", "-q", "origin", "wg/landed");
git(p("other"), "fetch", "-q", "origin");
git(p("other"), "merge", "-q", "--no-ff", "-m", "merge wg/landed", "origin/wg/landed");
git(p("other"), "push", "-q", "origin", "main");
git(p("project"), "fetch", "-q", "origin");
git(p("landed"), "merge", "-q", "--ff-only", "origin/main");
rows.landed = await scan(p("landed"));

// Ahead of main with no PR: unmerged, and it must say so.
git(p("project"), "worktree", "add", "-q", "-b", "wg/open", p("open"), "origin/main");
commit(p("open"), "still-open.txt", "the work that has not landed");
rows.open = await scan(p("open"));

test("an untouched branch that was fast-forwarded onto main reads NO COMMITS, never MERGED", () => {
  const row = rows.ffed;
  assert.equal(row.ahead, 0, "nothing of the branch's own is off main");
  assert.equal(row.ownCommits, 0, "the reflog has no `commit:` line for it");
  assert.equal(row.everMoved, true, "the reflog DID move — that is exactly what used to invent a merge");
  assert.equal(row.verdict, "NO COMMITS");
});

test("a pristine branch that was never touched at all reads NO COMMITS", () => {
  const row = rows.fresh;
  assert.equal(row.ahead, 0);
  assert.equal(row.ownCommits, 0);
  assert.equal(row.verdict, "NO COMMITS");
});

test("a squash-merged branch still reads MERGED (content identical): its own commits are in main", () => {
  const row = rows.squashed;
  assert.equal(row.ahead, 2, "its two commits are still off main");
  assert.equal(row.ownCommits, 2, "the branch did make them");
  assert.equal(row.verdict, "MERGED (content identical)");
});

test("a branch cut from landed work that never committed reads NO COMMITS, not MERGED", () => {
  const row = rows.inherits;
  assert.equal(row.ahead, 1, "it points at one commit main does not carry under that sha");
  assert.equal(row.ownCommits, 0, "the branch itself made none");
  assert.equal(row.verdict, "NO COMMITS");
});

test("a real merged PR still reads MERGED, and still names its own commit count after a catch-up", () => {
  const row = rows.landed;
  assert.equal(row.ahead, 0);
  assert.equal(row.ownCommits, 1);
  assert.equal(row.everMoved, true, "the catch-up moved the reflog on top of the commit");
  assert.equal(row.verdict, "MERGED (1 commit)");
});

test("a branch ahead with no PR still reads UNMERGED", () => {
  const row = rows.open;
  assert.equal(row.ahead, 1);
  assert.equal(row.ownCommits, 1);
  assert.equal(row.verdict, "UNMERGED (1 commit)");
});

test("the untouched row is offered for cleanup as NO COMMITS once its run is over, not withheld as unknown", () => {
  const store = new Store();
  store.ensureProject({ name: "proj", mainBranch: "main" });
  // The fixture's files are seconds old, so the scan marks the row live; an idle tree is the case a
  // reader clears, and NO COMMITS is what offers it.
  store.putRow("proj", { ...rows.ffed, branch: "wg/ffed", dirty: 0, untracked: 0, live: false }, "full");
  const placed = store.rowsFor("proj")[0];
  assert.equal(placed.verdict, "NO COMMITS");
  assert.equal(placed.mergeable, true, "nothing of the branch's own can be lost by removing its tree");
});
