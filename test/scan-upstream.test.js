// The raw numbers behind the Ahead / Behind column, proved against REAL git: `scanWorktree` keeps what `git status
// --porcelain=v2 --branch` says about the branch's own upstream (row.upstream / upstreamAhead / upstreamBehind), and
// row.ahead / row.behind stay the count against the project's main, which the verdict is built from. The same rows go
// through lib/sync-state.js to show the answer the board draws for each situation.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanWorktree } from "../lib/scan.js";
import { syncState } from "../lib/sync-state.js";

const ID = ["-c", "user.name=wag-test", "-c", "user.email=wag-test@example.test", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
const git = (cwd, ...args) => execFileSync("git", [...ID, "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const root = mkdtempSync(path.join(tmpdir(), "wag-upstream-"));
after(() => rmSync(root, { recursive: true, force: true }));
const p = (...s) => path.join(root, ...s).replace(/\\/g, "/");

let n = 0;
function commit(dir, file, msg = file) {
  writeFileSync(path.join(dir, file), `${msg} ${++n}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", msg);
}

// origin (bare) <- project checkout `main` (where main is committed) <- worktree `feat` cut from origin/main
git(root, "init", "-q", "--bare", "-b", "main", p("origin.git"));
git(root, "clone", "-q", p("origin.git"), p("project"));
git(p("project"), "switch", "-q", "-C", "main");
commit(p("project"), "base.txt");
git(p("project"), "push", "-q", "-u", "origin", "main");
// A second clone stands for "somebody else": it moves main and the branch on the remote.
git(root, "clone", "-q", p("origin.git"), p("other"));
git(p("other"), "switch", "-q", "-C", "main", "origin/main");

git(p("project"), "worktree", "add", "-q", "-b", "feat", p("feat"), "origin/main");

const ctx = { remoteRef: "origin/main", mainBranch: "main", parents: [] };
const scan = () => scanWorktree(p("feat"), ctx, "fast");
const board = (row, extra = {}) => syncState({ row: { ...row, remoteBranch: "exists", ...extra }, remote: "origin", fetchNote: "" });

test("cut from origin/main and never pushed: its upstream is main, so it has no copy of its own", async () => {
  const row = await scan();
  assert.equal(row.branch, "feat");
  assert.equal(row.upstream, "origin/main");
  // git is counting against main here, which is exactly why the board must not call this "the remote copy":
  assert.deepEqual([row.upstreamAhead, row.upstreamBehind], [0, 0]);
  const s = board(row, { remoteBranch: "gone" });
  assert.equal(s.state, "none");
  assert.match(s.why, /never been pushed/);
});

test("pushed with -u: its upstream is its own copy and a commit shows as ↑1 while main's count agrees", async () => {
  commit(p("feat"), "work-1.txt");
  git(p("feat"), "push", "-q", "-u", "origin", "feat");
  let row = await scan();
  assert.equal(row.upstream, "origin/feat");
  assert.deepEqual([row.upstreamAhead, row.upstreamBehind], [0, 0]);
  assert.equal(board(row).state, "level");

  commit(p("feat"), "work-2.txt");
  row = await scan();
  assert.deepEqual([row.upstreamAhead, row.upstreamBehind], [1, 0]);
  assert.deepEqual([row.ahead, row.behind], [2, 0], "the verdict's count is against main and still counts both commits");
  assert.equal(board(row).state, "ahead");
});

test("main moving on changes the count against main and NOT the count against the branch's own copy", async () => {
  git(p("feat"), "push", "-q", "origin", "feat"); // pushed: level with its own copy
  commit(p("other"), "main-moves.txt");
  git(p("other"), "push", "-q", "origin", "main");
  git(p("project"), "fetch", "-q", "--prune", "origin");
  const row = await scan();
  assert.deepEqual([row.upstreamAhead, row.upstreamBehind], [0, 0], "level with its own copy");
  assert.deepEqual([row.ahead, row.behind], [2, 1], "two commits main lacks, one commit it has that this branch lacks");
  const s = board(row);
  assert.equal(s.state, "level");
  assert.equal(s.behind, 0);
});

test("somebody else pushes to the branch: ↓1 after a fetch", async () => {
  git(p("other"), "fetch", "-q", "origin");
  git(p("other"), "switch", "-q", "-C", "feat", "origin/feat");
  commit(p("other"), "theirs.txt");
  git(p("other"), "push", "-q", "origin", "feat");
  git(p("project"), "fetch", "-q", "--prune", "origin");
  const row = await scan();
  assert.deepEqual([row.upstreamAhead, row.upstreamBehind], [0, 1]);
  assert.equal(board(row).state, "behind");

  commit(p("feat"), "mine.txt");
  const both = await scan();
  assert.deepEqual([both.upstreamAhead, both.upstreamBehind], [1, 1]);
  assert.equal(board(both).state, "diverged");
});

test("its copy deleted on the remote and pruned: the upstream is still named but git gives no count", async () => {
  git(p("other"), "push", "-q", "origin", "--delete", "feat");
  git(p("project"), "fetch", "-q", "--prune", "origin");
  const row = await scan();
  assert.equal(row.upstream, "origin/feat");
  assert.equal(row.upstreamAhead, null);
  assert.equal(row.upstreamBehind, null);
  assert.equal(board(row).state, "gone");
});

test("no upstream at all: nothing recorded, and a branch the remote does have reads as untracked", async () => {
  git(p("feat"), "branch", "--unset-upstream");
  const row = await scan();
  assert.equal(row.upstream, null);
  assert.equal(row.upstreamAhead, null);
  assert.equal(board(row, { remoteBranch: "exists" }).state, "untracked");
  assert.equal(board(row, { remoteBranch: "gone" }).state, "none");
});
