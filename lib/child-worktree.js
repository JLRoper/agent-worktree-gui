// A child worktree cut from a ROW's branch — the missing half of the roll-up.
//
// The roll-up (lib/steward.js `rollUp`) merges a child into the branch it was cut from, INSIDE that parent's own
// worktree. It has one precondition the panel could not satisfy: a parent that is a local worktree branch. The only
// place the panel cut a tree was `jobs.makeWorktree`, and that cuts from the PROJECT CHECKOUT's HEAD by design — it
// is where a run starts, and the checkout is on main. So every tree the panel made was a child of main, and the one
// target a roll-up may never use is main. A reader could roll a child up only if they had cut the parent by hand.
//
// This module is the other direction: `git worktree add -b <child> <path> <parentBranch>`, where the start ref is the
// ROW's branch rather than HEAD. Nothing here knows about the panel's books; the caller writes the cut down in the two
// places a parent is read from (lib/parents.js ParentBook, lib/jobs.js `rememberParent`) because only the caller has
// both a project name and a job store. That record is "cut" — the only source a roll-up will act on — so a child cut
// here is exactly the child the UNMERGED chip has been offering an outcome it could not reach.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitIn } from "./scan.js";
import { isMainName } from "./parents.js";

// The same 24 characters the panel names a tree from a prompt with: long enough to read, short enough that the
// directory and the branch stay usable in a prompt or a shell.
export const CHILD_SLUG_MAX = 24;

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const lastLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";

// What the child is called, from the parent's branch: `wtgui/fix-the-chart-1a2b3c` becomes `fix-the-chart`. The
// six-hex tag is dropped because the child gets its own (it is what makes the name unique and what survives a
// rename, lib/tree-names.js); keeping the parent's would read as the same tree twice. A name the reader typed wins
// and goes through the same slug pass, so "Child two" and "child/two" both land somewhere legal.
export function childSlug(parentBranch, asked = "") {
  const typed = String(asked ?? "").trim();
  // Only the BRANCH is read for its last path segment: a name the reader typed is a name, even when it has a slash
  // ("child of feat/parent" is that whole phrase slugged, not the word "parent").
  const fromBranch = String(parentBranch ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
  const source = typed || fromBranch.replace(/-[0-9a-f]{6}$/i, "");
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHILD_SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "child";
}

export const childBranchFor = (slug, tag) => `wtgui/${slug}-${tag}`;
export const childPathFor = (repoDir, slug, tag) => `${norm(repoDir)}/.worktrees/${slug}-${tag}`;

// The cut. Returns the facts the caller needs to write down — the branch, the directory, the parent it came from and
// the commit that parent resolved to at THIS moment (git forgets it the instant `worktree add` returns) — or a
// sentence saying why nothing was cut. `run` is the subprocess seam, so a test can drive the refusals without git.
export async function cutChildWorktree({
  repoDir,
  parentBranch,
  mainBranch = null,
  name = "",
  tag = null,
  run = gitIn,
} = {}) {
  const repo = norm(repoDir);
  if (!repo) return { ok: false, error: "no project directory to cut a child worktree in" };
  const parent = String(parentBranch ?? "").trim();
  if (!parent) return { ok: false, error: "this row has no branch, so there is nothing to cut a child from" };
  // No branch name the panel calls main may be a roll-up target, so a "child" of one is a tree with nowhere to go:
  // that is the New-agent card's job (it cuts from the checkout's HEAD, which is exactly this).
  if (isMainName(parent, mainBranch)) {
    return { ok: false, error: `${parent} is a main branch — a child of it has no roll-up to arrive at; start that work from the New-agent card` };
  }
  const local = await run(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${parent}`], 15000);
  if (!local.ok) {
    return { ok: false, error: `${parent} is not a local branch of this repository, so no child can be cut from it` };
  }
  const sha = await run(repo, ["rev-parse", parent], 15000);
  const slug = childSlug(parent, name);
  const stone = String(tag ?? "").trim() || randomUUID().slice(0, 6);
  const branch = childBranchFor(slug, stone);
  const treePath = childPathFor(repo, slug, stone);
  // The tag makes a collision very unlikely and still not impossible (a name the reader typed, twice). Both halves
  // are checked so the answer is a sentence rather than git's own refusal, which does not say which half was taken.
  if (existsSync(treePath)) return { ok: false, error: `${treePath} is already there — pick another name` };
  const taken = await run(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], 15000);
  if (taken.ok) return { ok: false, error: `${branch} already exists — pick another name` };
  // The start ref is the parent BRANCH, stated: `worktree add -b <branch> <path>` with no start ref silently uses
  // HEAD, which is the bug this whole module exists to correct.
  const add = await run(repo, ["worktree", "add", "-b", branch, treePath, parent], 90_000);
  if (!add.ok) return { ok: false, error: `git worktree add refused: ${lastLine(add.err || add.out) || "no reason given"}` };
  return {
    ok: true,
    branch,
    path: treePath,
    parent,
    parentSha: sha.ok ? String(sha.out || "").trim() || null : null,
    slug,
    tag: stone,
    name: path.basename(treePath),
  };
}
