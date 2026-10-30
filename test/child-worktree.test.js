// The child cut, driven against real git.
//
// The one thing this file exists to pin is the START REF: `git worktree add -b <branch> <path>` with no start ref
// silently cuts from the project checkout's HEAD, which is main — the one target a roll-up may never use. Every tree
// the panel used to make was therefore a child of main, and the UNMERGED chip's "Roll into <parent>" had nothing it
// was allowed to land on. So the cases are:
//
//   1. THE CHILD IS CUT FROM THE PARENT'S TIP, not from main. The fixture gives main a commit AFTER the parent was
//      cut, so a cut from HEAD is a different sha and a different file set — the assertion cannot pass by accident.
//   2. THE PARENT'S TIP IS RECORDED, because `worktree add` throws that answer away and no later read can recover it.
//   3. THE ROLL-UP WORKS ON WHAT WAS CUT: a commit in the child fast-forwards the parent, which is the promise the
//      button makes.
//   4. THE REFUSALS ARE SENTENCES: a main branch (nowhere to roll), a branch that is not local here, a name already
//      taken on disk or in refs.
//   5. THE NAME comes from the parent's branch, drops its six-hex tag, and a name the reader typed goes through the
//      same slug pass.
//
// Throwaway repos under the OS temp dir; nothing here touches this checkout or the panel's own state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { childBranchFor, childPathFor, childSlug, cutChildWorktree } from "../lib/child-worktree.js";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    .replace(/\r\n/g, "\n")
    .trim();
}
function ran(cwd, ...args) {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}
function commit(repo, file, text, message) {
  writeFileSync(path.join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
}

// One repo with a main, a parent worktree on its own branch, and main moved on afterwards — the shape that tells a
// cut from the parent apart from a cut from HEAD.
function fixture(root) {
  const repo = path.join(root, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", ["child", "local"].join(String.fromCharCode(64)));
  git(repo, "config", "user.name", "Child Test");
  git(repo, "config", "commit.gpgsign", "false");
  commit(repo, "base.txt", "base\n", "main: base");
  const parentTree = path.join(repo, ".worktrees", "feat-parent");
  git(repo, "worktree", "add", "-q", "-b", "feat/parent", parentTree);
  commit(parentTree, "parent.txt", "the parent's work\n", "parent: its own commit");
  // Main moves on AFTER the cut: a child cut from HEAD would carry this file, one cut from the parent would not.
  commit(repo, "later.txt", "main moved on\n", "main: later");
  return { repo, parentTree, parentSha: git(parentTree, "rev-parse", "HEAD") };
}

test("the child is cut from the parent's tip, not from the checkout's HEAD", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wtgui-child-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const { repo, parentSha } = fixture(root);
  const mainSha = git(repo, "rev-parse", "main");
  assert.notEqual(parentSha, mainSha, "the fixture must make main and the parent different commits");

  const cut = await cutChildWorktree({ repoDir: repo, parentBranch: "feat/parent", tag: "a1b2c3" });
  assert.equal(cut.ok, true, cut.error);
  assert.equal(cut.branch, "wtgui/parent-a1b2c3", "the name comes from the branch's last word, with its own tag");
  assert.equal(cut.path, `${repo.replace(/\\/g, "/")}/.worktrees/parent-a1b2c3`);
  assert.equal(cut.parent, "feat/parent");
  assert.equal(cut.parentSha, parentSha, "the tip the parent resolved to at the cut is recorded, not guessed");

  // The child's HEAD is the parent's tip — this is the whole correctness claim, and a cut from HEAD fails it.
  assert.equal(git(cut.path, "rev-parse", "HEAD"), parentSha);
  assert.equal(git(cut.path, "rev-parse", "--abbrev-ref", "HEAD"), cut.branch, "the new branch is the one checked out");
  assert.equal(existsSync(path.join(cut.path, "parent.txt")), true, "the parent's commit is in the tree");
  assert.equal(existsSync(path.join(cut.path, "later.txt")), false, "main's later commit is NOT — the cut was not from HEAD");

  // git itself lists it as a worktree of this repository, which is what makes it a row on the board.
  const listed = git(repo, "worktree", "list", "--porcelain");
  assert.match(listed, new RegExp(`worktree ${cut.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(listed, /branch refs\/heads\/wtgui\/parent-a1b2c3/);
  // And the branch exists locally, at the parent's tip, ready to be merged back.
  assert.equal(git(repo, "rev-parse", "wtgui/parent-a1b2c3"), parentSha);
  assert.equal(git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/wtgui/parent-a1b2c3"), parentSha);
});

test("the parent and the child move independently after the cut", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wtgui-child-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const { repo, parentTree, parentSha } = fixture(root);
  const cut = await cutChildWorktree({ repoDir: repo, parentBranch: "feat/parent", tag: "d4e5f6" });
  assert.equal(cut.ok, true, cut.error);

  // The child commits: the parent must not have moved, and the child's tree must hold only its own file.
  commit(cut.path, "child.txt", "the child's work\n", "child: its own commit");
  const childSha = git(cut.path, "rev-parse", "HEAD");
  assert.notEqual(childSha, parentSha);
  assert.equal(git(parentTree, "rev-parse", "HEAD"), parentSha, "cutting and committing in the child never writes the parent");
  assert.equal(existsSync(path.join(parentTree, "child.txt")), false);

  // The roll-up's own mechanism: a merge inside the PARENT's worktree fast-forwards it onto the child. If the cut had
  // come from main these trees would share no line of history and this would be a real merge, not the ff the chip
  // promises for a child that stayed current.
  git(parentTree, "merge", "--ff-only", "--no-edit", cut.branch);
  assert.equal(git(parentTree, "rev-parse", "HEAD"), childSha, "the parent is fast-forwarded onto the child's tip");
  assert.equal(readFileSync(path.join(parentTree, "child.txt"), "utf8").trim(), "the child's work", "the parent's tree now holds the child's file");
});

test("a main branch, a missing branch and a taken name are refused in sentences", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wtgui-child-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const { repo } = fixture(root);

  const onMain = await cutChildWorktree({ repoDir: repo, parentBranch: "main", mainBranch: "main" });
  assert.equal(onMain.ok, false);
  assert.match(onMain.error, /main branch — a child of it has no roll-up to arrive at/);

  // `develop` is a main name even when the project calls its base something else.
  const develop = await cutChildWorktree({ repoDir: repo, parentBranch: "develop" });
  assert.equal(develop.ok, false, "a missing branch and a main name are both refusals, and this one is the name");

  const missing = await cutChildWorktree({ repoDir: repo, parentBranch: "no-such-branch" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not a local branch of this repository/);

  // No branch at all: the row this is pressed on is on a detached HEAD.
  const none = await cutChildWorktree({ repoDir: repo, parentBranch: "" });
  assert.equal(none.ok, false);
  assert.match(none.error, /has no branch/);

  // The same tag twice: the first cut takes the directory, the second is refused by name rather than by git.
  const first = await cutChildWorktree({ repoDir: repo, parentBranch: "feat/parent", tag: "0f0f0f" });
  assert.equal(first.ok, true, first.error);
  const again = await cutChildWorktree({ repoDir: repo, parentBranch: "feat/parent", tag: "0f0f0f" });
  assert.equal(again.ok, false);
  assert.match(again.error, /already there — pick another name/);
});

test("childSlug names a tree from its parent's branch, and a typed name through the same pass", () => {
  assert.equal(childSlug("wtgui/fix-the-chart-1a2b3c"), "fix-the-chart", "the parent's tag is dropped: the child gets its own");
  assert.equal(childSlug("feat/parent"), "parent", "a path-prefixed branch names from its last word");
  assert.equal(childSlug("feat/parent", "Child two"), "child-two", "a typed name is slugged the same way");
  assert.equal(childSlug("feat/parent", "  "), "parent", "blank means 'name it after the branch'");
  assert.equal(childSlug("feat/Parent_Work!"), "parent-work");
  assert.equal(childSlug("feat/" + "x".repeat(60)).length, 24, "the panel's 24-character cap");
  assert.equal(childSlug("///"), "child", "nothing usable left: a fallback rather than an empty name");
  assert.equal(childBranchFor("parent", "abc123"), "wtgui/parent-abc123");
  assert.equal(childPathFor("C:/proj/", "parent", "abc123"), "C:/proj/.worktrees/parent-abc123");
});
