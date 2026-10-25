#!/usr/bin/env node
// tools/merged-branches.mjs
//
// Which local branches are safe to prune — decided from PULL REQUEST state, never from git
// ancestry.
//
// Why `git branch --merged main`, `git merge-base --is-ancestor` and `git rev-list --count
// main..<branch>` are all WRONG in this repo:
//
//   * The repository ruleset "Owner only" carries `required_linear_history`, so a PR can only
//     land as a squash or a rebase. GitHub RE-CREATES the commit, so the branch's own SHAs
//     never appear on main and its tip stays a non-ancestor of main forever.
//   * This repo also sets `squash_merge_commit_message = COMMIT_MESSAGES`, so the commit that
//     lands on main is composed from the branch's own commit subjects.
//   * Net effect: a branch whose PR merged days ago still reports "ahead by N" and is never
//     listed by `git branch --merged main`. So "ahead by N" is NOT a merge signal here, and
//     "0 ahead" is not proof of a merge either — a branch cut from main with nothing committed
//     reads the same way.
//
// The PR is the only authority on whether a branch got in. So ask `gh`, not git.
//
//   node tools/merged-branches.mjs            report every local branch and the PR that owns it
//   node tools/merged-branches.mjs --prune    delete the branches a merged PR accounts for
//
// --prune deletes LOCAL refs only (`git branch -D -- <name>`): never a remote branch,
// never a tag, never a worktree. It always skips the default branch, any branch checked out in
// a worktree, a branch with an OPEN PR, and a branch no merged PR names — a branch with no PR
// has nothing that proves it landed, so it is reported and left alone.
//
// `-D`, not `-d`, on purpose: `-d` refuses exactly the branches this script exists to delete
// (git cannot see them as merged), so the ancestry question must not be asked twice.

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const prune = args.includes("--prune");
const PR_LIMIT = "500";

function fail(message) {
  process.stderr.write(`merged-branches: ${message}\n`);
  process.exit(2);
}

function git(argv) {
  return execFileSync("git", argv, { encoding: "utf8" });
}

function ghJson(argv) {
  return JSON.parse(execFileSync("gh", argv, { encoding: "utf8" }));
}

// ---------------------------------------------------------------- default branch

function defaultBranch() {
  for (const ref of ["refs/remotes/github/HEAD", "refs/remotes/origin/HEAD"]) {
    try {
      const full = git(["symbolic-ref", "--quiet", "--short", ref]).trim();
      const name = full.replace(/^[^/]+\//, "");
      if (name) return name;
    } catch {
      /* no such remote HEAD — try the next one */
    }
  }
  return "main";
}

// ---------------------------------------------------------------- local state

function localBranches() {
  const out = git([
    "for-each-ref",
    "--format=%(refname:short)\t%(objectname:short)\t%(committerdate:short)",
    "refs/heads/",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, date] = line.split("\t");
      return { name, sha, date: date || "?" };
    });
}

// branch -> worktree path for every worktree of this repo (the main checkout included).
function checkedOutBranches() {
  const out = git(["worktree", "list", "--porcelain"]);
  const map = new Map();
  let path = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch refs/heads/")) {
      map.set(line.slice("branch refs/heads/".length).trim(), path);
    }
  }
  return map;
}

// ---------------------------------------------------------------- PR state (the authority)

function prList(state) {
  try {
    return ghJson([
      "pr",
      "list",
      "--state",
      state,
      "--limit",
      PR_LIMIT,
      "--json",
      "number,headRefName,mergedAt,title",
    ]);
  } catch (error) {
    if (error.code === "ENOENT") fail("gh is not on PATH — PR state needs the GitHub CLI");
    if (prune) fail(`gh pr list --state ${state} failed, refusing to prune: ${String(error.message || error).split("\n")[0]}`);
    process.stderr.write(`merged-branches: gh pr list --state ${state} failed (${String(error.message || error).split("\n")[0]})\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------- classify

const mergedByBranch = new Map();
for (const pr of prList("merged")) {
  const previous = mergedByBranch.get(pr.headRefName);
  if (!previous || String(pr.mergedAt) > String(previous.mergedAt)) mergedByBranch.set(pr.headRefName, pr);
}

const openByBranch = new Map();
for (const pr of prList("open")) openByBranch.set(pr.headRefName, pr);

const main = defaultBranch();
const worktreeOf = checkedOutBranches();

const rows = localBranches().map((branch) => {
  const merged = mergedByBranch.get(branch.name);
  const open = openByBranch.get(branch.name);
  const row = { ...branch, merged, open, skip: null, prune: false };

  if (branch.name === main) row.skip = `default branch (${main})`;
  else if (worktreeOf.has(branch.name)) row.skip = `checked out in worktree ${worktreeOf.get(branch.name)}`;
  else if (open) row.skip = `OPEN PR #${open.number}`;
  else if (merged) row.prune = true;
  else row.skip = "no PR — nothing shows it landed";
  return row;
});

// ---------------------------------------------------------------- report

const pad = (text, width) => text + " ".repeat(Math.max(0, width - text.length));
const branchWidth = Math.max("branch".length, ...rows.map((r) => r.name.length));

process.stdout.write(`${pad("branch", branchWidth)}  ${pad("PR", 6)} ${pad("tip", 9)} verdict\n`);
for (const row of rows) {
  // The PR number always comes from `gh pr list` — never from ancestry, which cannot see a
  // squash/rebase merge at all.
  const pr = row.merged ? `#${row.merged.number}` : row.open ? `#${row.open.number}` : "none";
  const verdict = row.prune
    ? `PRUNABLE — merged PR #${row.merged.number} on ${String(row.merged.mergedAt).slice(0, 10)}`
    : row.skip;
  process.stdout.write(`${pad(row.name, branchWidth)}  ${pad(pr, 6)} ${pad(row.sha, 9)} ${verdict}\n`);
}

const prunable = rows.filter((r) => r.prune);
process.stdout.write(
  `\n${rows.length} local branches, ${prunable.length} with a merged PR, ${rows.length - prunable.length} kept.\n`
);

if (!prune) {
  process.stdout.write("Report only — re-run with --prune to delete the PRUNABLE ones (local refs only).\n");
  process.exit(0);
}

if (!prunable.length) {
  process.stdout.write("Nothing to prune.\n");
  process.exit(0);
}

process.stdout.write("\nDeleting (local refs only; remote branches, tags and worktrees untouched):\n");
for (const row of prunable) {
  // -D, never -d: ancestry cannot see these merges (squash/rebase re-created the commits),
  // and a branch whose branch record cannot be proved by PR state is skipped above.
  git(["branch", "-D", row.name]);
  process.stdout.write(`  deleted ${row.name} (merged PR #${row.merged.number})\n`);
}
process.stdout.write(`\n${prunable.length} branch(es) deleted. Worktrees were not touched.\n`);
