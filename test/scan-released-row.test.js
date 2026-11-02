// A released worktree's leftover FOLDER is not a tree of its own, and the scan must never answer for the primary
// checkout in its place. `git -C <an empty directory under a checkout>` does not fail: it walks UP and answers for the
// checkout above it — its branch, its HEAD, THE READER'S OWN DIRTY FILES — which is how nine released trees each
// reported "2 modified · 4 untracked — branch main". lib/own-tree.js answers "is this a tree of its own" and
// lib/scan.js now asks it before any `git -C status/log`, reporting RELEASED with no counts at all.
//
// The other half of the contract is that the guard does not over-reach: a real tree's OWN dirt is still reported, and
// a real clean tree still reads 0. The numbers are chosen so that a scan reading the WRONG tree cannot pass — the
// primary checkout carries 2 modified + 4 untracked, the worktree carries 3 modified + 2 untracked.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanWorktree } from "../lib/scan.js";
import { Store } from "../lib/store.js";
import { git } from "../tools/panel-testkit.mjs";

const root = mkdtempSync(path.join(tmpdir(), "wag-released-row-"));
after(() => rmSync(root, { recursive: true, force: true }));
const p = (...s) => path.join(root, ...s).replace(/\\/g, "/");
const write = (dir, file, text) => writeFileSync(path.join(dir, file), text);

const repo = p("project");
const ownTree = p("project", ".worktrees", "own-tree");
const cleanTree = p("project", ".worktrees", "clean-tree");
const husk = p("project", ".worktrees", "released-husk");

mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
for (const f of ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt"]) write(repo, f, `${f}\n`);
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
git(repo, "worktree", "add", "-q", "-b", "wtgui/own-tree", ownTree);
git(repo, "worktree", "add", "-q", "-b", "wtgui/clean-tree", cleanTree);
// The released tree: it WAS a worktree, git's record of it is gone, and the folder is still there with nothing in it.
git(repo, "worktree", "add", "-q", "-b", "wtgui/released-husk", husk);
git(repo, "worktree", "remove", "--force", husk);
rmSync(husk, { recursive: true, force: true });
mkdirSync(husk, { recursive: true });

// The reader's own checkout: 2 modified, 4 untracked.
write(repo, "one.txt", "changed in the primary\n");
write(repo, "two.txt", "changed in the primary\n");
for (const f of ["config.json", "lib-jobs.js", "notes.md", "scratch.tmp"]) write(repo, f, "the reader's own file\n");
// The real tree's own work: 3 modified, 2 untracked — a different shape from the primary's, on purpose.
write(ownTree, "one.txt", "changed in the tree\n");
write(ownTree, "two.txt", "changed in the tree\n");
write(ownTree, "three.txt", "changed in the tree\n");
for (const f of ["tree-note.md", "tree-scratch.tmp"]) write(ownTree, f, "the tree's own work\n");

const ctx = { remoteRef: "origin/main", mainBranch: "main", parents: [] };
const scan = (dir) => scanWorktree(dir, ctx, "fast");

test("an empty leftover folder is RELEASED — no branch, no counts, and the reason names the checkout git answered for", async () => {
  const row = await scan(husk);
  assert.equal(row.verdict, "RELEASED");
  assert.equal(row.branch, null, "the primary checkout's branch is not this row's branch");
  assert.equal(row.head, null);
  assert.equal(row.dirty, 0);
  assert.equal(row.untracked, 0);
  assert.deepEqual(row.dirtyFiles, []);
  assert.deepEqual(row.untrackedFiles, []);
  assert.equal(row.ahead, null);
  assert.match(row.released.why, /leftover directory/);
  assert.match(row.released.why, /git answers for/);
  assert.equal(row.released.outer.replace(/\\/g, "/").toLowerCase(), repo.toLowerCase(), "it names the checkout the walk-up landed on");
  assert.equal(row.error, row.released.why, "the routes that read one tree refuse with the same sentence");
});

test("a real worktree's own uncommitted work is still reported, with its own counts and its own files", async () => {
  const row = await scan(ownTree);
  assert.equal(row.branch, "wtgui/own-tree");
  assert.equal(row.dirty, 3);
  assert.equal(row.untracked, 2);
  assert.deepEqual(
    row.dirtyFiles.map((f) => f.path).sort(),
    ["one.txt", "three.txt", "two.txt"],
    "paths are this tree's own, not the primary checkout's",
  );
  assert.deepEqual([...row.untrackedFiles].sort(), ["tree-note.md", "tree-scratch.tmp"]);
  assert.equal(row.released, null, "a tree of its own is never labelled released");
});

test("a real clean worktree still reads 0, and is not released", async () => {
  const row = await scan(cleanTree);
  assert.equal(row.branch, "wtgui/clean-tree");
  assert.equal(row.dirty, 0);
  assert.equal(row.untracked, 0);
  assert.notEqual(row.verdict, "RELEASED");
});

test("the project's own checkout still reports its own dirt — the guard suppresses nobody's files", async () => {
  const row = await scan(repo);
  assert.equal(row.branch, "main");
  assert.equal(row.dirty, 2);
  // The four reader files, plus the `.worktrees/` folder this sandbox cut its trees into (git collapses an untracked
  // directory to one entry).
  assert.deepEqual(
    row.untrackedFiles.map((f) => f.replace(/\/$/, "")).sort(),
    [".worktrees", "config.json", "lib-jobs.js", "notes.md", "scratch.tmp"],
  );
});

test("the store keeps the RELEASED row instead of the verdict it held while the tree was there", async () => {
  const store = new Store();
  store.ensureProject({ name: "project", path: repo, mainBranch: "main", remote: "origin" });
  store.putRow("project", { path: husk, name: "released-husk", verdict: "MERGED (2 commits)", branch: "wtgui/released-husk", dirty: 0, untracked: 0, ahead: 0 }, "full");
  const before = store.rowsFor("project")[0];
  assert.equal(before.verdict, "MERGED (2 commits)");

  const row = await scan(husk);
  store.putRow("project", row, "fast");
  const afterRelease = store.rowsFor("project").find((r) => r.path === row.path);
  assert.equal(afterRelease.verdict, "RELEASED", "a fast pass does not resurrect the old verdict");
  assert.equal(afterRelease.verdictStale, false);
  assert.equal(afterRelease.dirty, 0);
  assert.equal(afterRelease.untracked, 0);
  assert.equal(afterRelease.mergeable, false);
  const summary = store.summaryFor("project");
  assert.equal(summary.released, 1);
  assert.equal(summary.unmerged, 0, "a folder left behind is not outstanding work");
  assert.equal(summary.dirty, 0);
});

test("a tree cut again at the same path takes the row back — it is not still RELEASED", async () => {
  const store = new Store();
  store.ensureProject({ name: "project", path: repo, mainBranch: "main", remote: "origin" });
  store.putRow("project", await scan(husk), "fast");
  assert.equal(store.rowsFor("project")[0].verdict, "RELEASED");

  // The folder is a worktree again (a re-cut at the path the released one used), with work of its own.
  rmSync(husk, { recursive: true, force: true });
  git(repo, "worktree", "add", "-q", "-b", "wtgui/reborn", husk);
  write(husk, "one.txt", "work in the reborn tree\n");

  const reborn = await scan(husk);
  assert.equal(reborn.branch, "wtgui/reborn");
  assert.equal(reborn.released, null, "the released record belongs to the folder that was not a tree");
  assert.equal(reborn.dirty, 1);
  store.putRow("project", reborn, "fast");
  const row = store.rowsFor("project")[0];
  assert.equal(row.released, null);
  assert.notEqual(row.verdict, "RELEASED", "a fast pass hands the tree back to the verdict a full scan will classify");
  assert.equal(row.dirty, 1, "and the tree's own dirt is on the row");
});
