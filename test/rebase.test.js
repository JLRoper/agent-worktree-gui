// The rebase control's engine, driven against real git.
//
// What this file pins, and why each one is a way to lose somebody's work if it is wrong:
//   1. THE TARGET IS CHOSEN BY PROOF. A child cut from a feature branch is replayed onto that branch's newest commit,
//      and the base ref is REFUSED for it — replaying onto main would carry the feature branch's own commits as the
//      child's new work. That refusal is the whole safety argument, so it gets its own case with its own fixture.
//   2. A BRANCH CUT FROM MAIN needs no parent record: the base ref is a legal target because the commits it would
//      replay are the branch's own, and the test proves the board's own ref (main) is what it lands on.
//   3. NOTHING TO REPLAY IS SAID, not silently done: a branch that already contains the target's tip is refused with a
//      sentence rather than "rebased" over a no-op.
//   4. A CONFLICT IS AN ABORT. The tree was clean when it started, so the abort has to put it back byte for byte and
//      hand back the colliding paths — the case where a half-rebased worktree would strand the reader.
//   5. A SECOND REPLAY IS REFUSED while one is open, and a branch carrying its own merge commits is replayed with its
//      topology intact (a plain rebase would flatten the resolutions somebody did by hand).
//
// Every fixture is a throwaway repo under the OS temp dir; nothing here touches this checkout or the panel's own state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { candidateRefs, pickPlan, rebaseInProgress, rebaseOn, rebaseWorktree } from "../lib/rebase.js";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    .replace(/\r\n/g, "\n")
    .trim();
}
// For the questions git answers with an exit code (is-ancestor, diff --quiet) rather than with output.
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
  return git(repo, "rev-parse", "HEAD");
}

const tmp = [];
const made = [];
function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rebase-test-"));
  tmp.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rebase@test.local");
  git(root, "config", "user.name", "Rebase Test");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "a.txt", "one\n", "one");
  return root;
}
function tree(repo, branch, from) {
  const wt = path.join(repo, ".worktrees", branch.replace(/\//g, "-"));
  mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", branch, wt, from);
  made.push(wt);
  return wt;
}
test.after(() => {
  for (const dir of tmp) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a worktree the OS still holds open is not this suite's problem */
    }
  }
});

test("a child cut from a feature branch replays onto that branch's newest commit", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "feature/parent");
  commit(repo, "p.txt", "parent\n", "parent work");
  const wt = tree(repo, "feat/child", "feature/parent");
  commit(wt, "c.txt", "child\n", "child work");
  git(repo, "checkout", "-q", "feature/parent");
  const parentTip = commit(repo, "p2.txt", "parent moved\n", "parent moves on");

  const out = await rebaseWorktree({ worktree: wt, branch: "feat/child", parent: "feature/parent", baseRef: "main", mainBranch: "main" });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.target, "feature/parent");
  assert.equal(out.replayed, 1, "only the child's own commit is replayed");
  assert.equal(out.containsTarget, true, "the parent's new tip is an ancestor of the new HEAD");
  // The parent's newer work is IN the child now, and the child's own commit still sits on top of it: one commit of its
  // own off the parent, and both files present.
  assert.equal(git(wt, "rev-list", "--count", "feature/parent..HEAD"), "1");
  assert.equal(ran(wt, "merge-base", "--is-ancestor", parentTip, "HEAD"), true);
  assert.equal(existsSync(path.join(wt, "p2.txt")), true);
  assert.equal(existsSync(path.join(wt, "c.txt")), true);
  // A rewrite, not a merge: the tip moved and the tree is clean.
  assert.notEqual(out.from, out.to);
  assert.equal(git(wt, "status", "--porcelain"), "");
});

test("the base ref is refused for a feature child: that replay would carry the parent's commits", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "feature/parent");
  commit(repo, "p.txt", "parent\n", "parent work");
  const wt = tree(repo, "feat/child", "feature/parent");
  commit(wt, "c.txt", "child\n", "child work");

  // No recorded parent, so the only candidate is the base ref — exactly the shape a tree cut outside the panel has.
  const out = await rebaseWorktree({ worktree: wt, branch: "feat/child", parent: null, baseRef: "main", mainBranch: "main" });
  assert.equal(out.ok, false, "a replay that would move somebody else's commits is refused");
  assert.equal(out.refused, "foreign");
  assert.match(out.error, /would carry 1 commit/);
  assert.match(out.error, /feature\/parent/, "the refusal names the branch the commits belong to");
  // Nothing was written: the tip is where it was.
  assert.equal(git(wt, "rev-list", "--count", "main..HEAD"), "2");
});

test("the base ref is refused for a feature child even after the base moves on — the case git would replay", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "feature/parent");
  commit(repo, "p.txt", "parent\n", "parent work");
  const wt = tree(repo, "feat/child", "feature/parent");
  commit(wt, "c.txt", "child\n", "child work");
  // The base moves on, so the merge base falls BELOW the parent's commit: `git rebase main` here would replay the
  // parent's work as this child's own new commits. This is the shape the ownership proof exists for.
  commit(repo, "m.txt", "main\n", "main moves on");
  const before = git(wt, "rev-parse", "HEAD");

  const out = await rebaseWorktree({ worktree: wt, branch: "feat/child", parent: null, baseRef: "main", mainBranch: "main" });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "foreign");
  assert.match(out.error, /would carry 1 commit/);
  assert.match(out.error, /feature\/parent/);
  assert.equal(git(wt, "rev-parse", "HEAD"), before, "nothing was written");
  assert.equal(git(wt, "status", "--porcelain"), "");
});

test("a branch cut from main is replayed onto the base ref with no parent record", async () => {
  const repo = makeRepo();
  const wt = tree(repo, "feat/mine", "main");
  commit(wt, "mine.txt", "mine\n", "my work");
  const mainTip = commit(repo, "later.txt", "later\n", "main moves on");

  const out = await rebaseWorktree({ worktree: wt, branch: "feat/mine", parent: null, baseRef: "main", mainBranch: "main" });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.target, "main");
  assert.equal(out.replayed, 1);
  assert.equal(ran(wt, "merge-base", "--is-ancestor", mainTip, "HEAD"), true);
  assert.equal(existsSync(path.join(wt, "later.txt")), true, "main's newer file is in the worktree");
  assert.equal(git(wt, "rev-list", "--count", "main..HEAD"), "1");

  // And a second press has nothing to replay: refused with a sentence, not an empty rebase.
  const again = await rebaseWorktree({ worktree: wt, branch: "feat/mine", parent: null, baseRef: "main", mainBranch: "main" });
  assert.equal(again.ok, false);
  assert.match(again.error, /already contains main's tip/);
});

test("a conflicting replay is aborted and the worktree is left exactly as it was", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "feature/parent");
  commit(repo, "shared.txt", "base\n", "shared base");
  const wt = tree(repo, "feat/clash", "feature/parent");
  commit(wt, "shared.txt", "child side\n", "child edits the same line");
  git(repo, "checkout", "-q", "feature/parent");
  commit(repo, "shared.txt", "parent side\n", "parent edits the same line");
  const before = git(wt, "rev-parse", "HEAD");

  const out = await rebaseWorktree({ worktree: wt, branch: "feat/clash", parent: "feature/parent", baseRef: "main", mainBranch: "main" });
  assert.equal(out.ok, false);
  assert.equal(out.conflict, true);
  assert.equal(out.aborted, true, "the abort ran");
  assert.equal(out.clean, true, "the tree came back clean");
  assert.equal(out.unchanged, true, "HEAD is the commit it started from");
  assert.deepEqual(out.files, ["shared.txt"], "the colliding path is named");
  assert.equal(git(wt, "rev-parse", "HEAD"), before);
  assert.equal(git(wt, "status", "--porcelain"), "");
  assert.equal(git(wt, "rev-parse", "--git-path", "rebase-merge").length > 0, true);
  assert.equal(await rebaseInProgress(wt), null, "no rebase is left open");
});

test("a second replay is refused while one is open in the tree", async () => {
  const repo = makeRepo();
  const wt = tree(repo, "feat/busy", "main");
  commit(wt, "b.txt", "b\n", "work");
  // The marker a stopped rebase leaves behind, in the path git itself reports for it.
  const marker = path.resolve(wt, git(wt, "rev-parse", "--git-path", "rebase-merge"));
  mkdirSync(marker, { recursive: true });
  const plan = { ok: true, target: "main", targetSha: git(repo, "rev-parse", "main"), mergeBase: git(repo, "rev-parse", "main"), replay: 1 };
  const out = await rebaseOn({ worktree: wt, branch: "feat/busy", plan });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "in-progress");
  assert.match(out.error, /already has a rebase open/);
  rmSync(marker, { recursive: true, force: true });
  assert.equal(await rebaseInProgress(wt), null);
});

test("a branch carrying its own merge commits is replayed with the topology kept", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "feature/parent");
  commit(repo, "p.txt", "parent\n", "parent work");
  const wt = tree(repo, "feat/merged", "feature/parent");
  git(wt, "checkout", "-q", "-b", "side");
  commit(wt, "s.txt", "side\n", "side work");
  git(wt, "checkout", "-q", "feat/merged");
  git(wt, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  assert.equal(Number(git(wt, "rev-list", "--count", "--merges", "feature/parent..HEAD")), 1, "the fixture has a merge commit");
  git(repo, "checkout", "-q", "feature/parent");
  commit(repo, "p2.txt", "parent moved\n", "parent moves on");

  const out = await rebaseWorktree({ worktree: wt, branch: "feat/merged", parent: "feature/parent", baseRef: "main", mainBranch: "main" });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.method, "rebase-merges", "the merge commit is not flattened away");
  assert.equal(Number(git(wt, "rev-list", "--count", "--merges", "feature/parent..HEAD")) >= 1, true);
  assert.equal(existsSync(path.join(wt, "s.txt")), true);
});

test("the pure decision: candidates, then the first ref whose replay is this branch's own", () => {
  assert.deepEqual(
    candidateRefs({ branch: "feat/child", parent: "feature/parent", baseRef: "origin/main", mainBranch: "main" }),
    ["feature/parent", "origin/main", "main"],
  );
  // No parent, no duplicate: the base ref and the local main are the same string once trimmed.
  assert.deepEqual(candidateRefs({ branch: "feat/x", parent: null, baseRef: "main", mainBranch: "main" }), ["main"]);
  // Never itself, never a detached HEAD.
  assert.deepEqual(candidateRefs({ branch: "main", parent: "main", baseRef: "HEAD", mainBranch: "main" }), []);

  const base = { sha: "b".repeat(40), mergeBase: "a".repeat(40), replay: 2, foreign: 0 };
  // A foreign owner loses even when it is first in the list; the next candidate wins.
  const plan = pickPlan({
    branch: "feat/x",
    candidates: [{ ref: "main", ...base, foreign: 1, foreignOn: "feature/parent" }, { ref: "feature/parent", ...base }],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.target, "feature/parent");
  assert.equal(plan.replay, 2);
  assert.match(plan.tried[0].why, /would carry 1 commit this branch does not own \(feature\/parent\)/);
  // Level with the target is "nothing to replay", not a plan.
  assert.equal(pickPlan({ branch: "feat/x", candidates: [{ ref: "main", ...base, mergeBase: base.sha }] }).ok, false);
  assert.match(pickPlan({ branch: "feat/x", candidates: [{ ref: "gone" }] }).error, /no such ref/);
});
