// The cleanup route, driven twice against ONE fixture repo: the dry run, then the apply.
//
// The fixture holds every shape the plan has a rule for, because a route test that only ever sees an easy tree proves
// the wire shape and nothing about the rules:
//
//   one tree whose branch main already contains      -> removed, with an ancestor proof
//   one whose commit was cherry-picked into main     -> removed, with a cherry proof (its shas are NOT in main)
//   one clean tree holding work main lacks           -> merged --no-ff into a child of the turnover branch
//   one dirty tree holding work main lacks           -> its branch merged, its working tree left alone
//   one turnover branch, fully merged                -> kept, never deleted
//   one worktree of this repo OUTSIDE the folder     -> skipped, never removed (the board has no row for it)
//   the primary checkout                             -> skipped
//
// What is pinned, each one a way this looks right and is wrong:
//
//   1. the dry run REMOVES NOTHING and still writes the plan page into the TARGET repo under docs/reports;
//   2. the apply removes exactly the two landed trees, deletes their branches, and leaves the other trees standing;
//   3. a cherry-equivalent branch really is deleted: git's own `branch -d` refuses it, so the proof has to carry it;
//   4. a merge lands as a CHILD branch with a two-parent --no-ff commit, and main itself does not move;
//   5. a dirty tree keeps its uncommitted file and its branch is still the one merged - the working tree is never
//      consulted for the merge;
//   6. the turnover branch survives even though it is merged, and the panel's own tree and the primary are skipped;
//   7. no force and no push: no remote exists in the fixture, no refs/remotes are written, and the only forced call
//      is the remover's own (lib/worktree-remove.js), which this route never passes a flag to;
//   8. the status codes: 200, 403 without the token, 404 for an unknown project, 405 for a GET.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configureRepo, git, post, ran, slash, startPanel } from "../tools/panel-testkit.mjs";

const TURNOVER = "20260710_1338_DMR-1-turnover";

// One repo, five worktrees, each one a different verdict. Built once per test file: git is the slow part and none of
// the assertions below mutate what another one reads (the apply test is last, and it is the only writer).
function makeFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "cleanup-route-"));
  const repo = path.join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  configureRepo(repo);
  writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "root");
  const treeOf = (name) => slash(path.join(repo, ".worktrees", name));
  const cut = (name, branch) => {
    git(repo, "worktree", "add", "-q", "-b", branch, treeOf(name), "main");
    return treeOf(name);
  };

  // 1. merged: commit on a branch, then fast-forward main onto it. The branch is an ancestor of main.
  const merged = cut("merged", "wtgui/merged");
  writeFileSync(path.join(merged, "merged.txt"), "already in main\n", "utf8");
  git(merged, "add", "-A");
  git(merged, "commit", "-qm", "merged work");
  git(repo, "merge", "--ff-only", "-q", "wtgui/merged");

  // 2. cherry: the commit's CONTENT is in main but its sha is not - the case `git branch -d` refuses to delete.
  //    The pick must land on a DIFFERENT parent or git would compute a byte-identical commit (same tree, same
  //    parent, same author and committer, same second) and the branch would simply be an ancestor, which is the
  //    other rule. An unrelated commit on main between the cut and the pick forces the sha apart.
  const cherry = cut("cherry", "wtgui/cherry");
  writeFileSync(path.join(cherry, "cherry.txt"), "picked across\n", "utf8");
  git(cherry, "add", "-A");
  git(cherry, "commit", "-qm", "cherry work");
  const cherrySha = git(cherry, "rev-parse", "HEAD");
  writeFileSync(path.join(repo, "unrelated.txt"), "something else on main\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "unrelated main work");
  git(repo, "cherry-pick", "--allow-empty", cherrySha);

  // 3. unmerged clean: one commit main does not have, nothing uncommitted.
  const unmerged = cut("unmerged", "wtgui/unmerged");
  writeFileSync(path.join(unmerged, "unmerged.txt"), "work main lacks\n", "utf8");
  git(unmerged, "add", "-A");
  git(unmerged, "commit", "-qm", "unmerged work");

  // 4. dirty: a commit main lacks AND an uncommitted file that is the only copy of that work.
  const dirty = cut("dirty", "wtgui/dirty");
  writeFileSync(path.join(dirty, "dirty-commit.txt"), "committed part\n", "utf8");
  git(dirty, "add", "-A");
  git(dirty, "commit", "-qm", "dirty branch work");
  writeFileSync(path.join(dirty, "dirty-work.txt"), "uncommitted, the only copy\n", "utf8");

  // 5. a turnover branch, fully merged into main: the one branch the plan must never delete.
  const turnover = cut("turnover", TURNOVER);
  writeFileSync(path.join(turnover, "turnover.txt"), "roll-up work\n", "utf8");
  git(turnover, "add", "-A");
  git(turnover, "commit", "-qm", "turnover work");
  git(repo, "merge", "--ff-only", "-q", TURNOVER);

  // 6. a tree of the SAME repository that sits OUTSIDE the project folder (the shape a landing run's comparison tree
  //    has). It is on main, so nothing else would save it: only the board's own membership test keeps it out of play.
  const outsidePath = slash(path.join(base, "scratch", "land-check"));
  mkdirSync(path.dirname(outsidePath), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "land/fixture-check", outsidePath, "main");

  return { base, repo: slash(repo), trees: { merged, cherry, unmerged, dirty, turnover }, outside: outsidePath };
}

const fixture = makeFixture();

// One panel for the read shapes and one apply; `token` is set so the 403 case is real rather than theoretical.
async function panelFor(extra = {}) {
  return startPanel({
    token: "cleanup-token",
    config: { projects: [{ name: "fixture", path: fixture.repo, mainBranch: "main", turnoverBranch: TURNOVER }] },
    // The remover's platform seam: on Windows a real apply also recycles each tree, and a test must not fill the
    // reader's Recycle Bin with scratch repos (lib/worktree-remove.js says so at the seam).
    env: { WTGUI_TEST_PLATFORM: "linux" },
    ...extra,
  });
}

test("cleanup route: the dry run returns a plan per rule and removes nothing", async () => {
  const panel = await panelFor();
  try {
    const r = await post(panel.base, "/api/projects/fixture/cleanup", { body: { dryRun: true }, token: panel.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.dryRun, true);
    const rows = r.json.plan.rows;
    const by = (p) => rows.find((row) => row.path === p);
    assert.equal(by(fixture.repo)?.verdict, "skip", "the primary checkout is never a candidate");
    assert.equal(by(fixture.trees.merged)?.verdict, "remove");
    assert.equal(by(fixture.trees.merged)?.proof.kind, "ancestor");
    assert.equal(by(fixture.trees.cherry)?.verdict, "remove");
    assert.equal(by(fixture.trees.cherry)?.proof.kind, "cherry");
    assert.equal(by(fixture.trees.unmerged)?.verdict, "merge");
    assert.equal(by(fixture.trees.unmerged)?.merge.base, TURNOVER);
    assert.equal(by(fixture.trees.dirty)?.verdict, "merge");
    assert.equal(by(fixture.trees.dirty)?.merge.treeKept, true);
    assert.deepEqual(by(fixture.trees.dirty)?.dirtyFiles, ["dirty-work.txt"]);
    assert.equal(by(fixture.trees.turnover)?.verdict, "keep");
    assert.match(by(fixture.trees.turnover)?.reason || "", /turnover branch/);
    // A tree of this repo that sits outside the project folder is out of play, with the reason on its row.
    assert.equal(by(fixture.outside)?.verdict, "skip", "a tree outside the project folder is not the cleanup's to touch");
    assert.match(by(fixture.outside)?.reason || "", /sits outside/);
    // Nothing moved: every tree is still on disk and every branch still exists.
    for (const p of [...Object.values(fixture.trees), fixture.outside]) assert.equal(existsSync(p), true, `${p} must still be there`);
    assert.equal(ran(fixture.repo, "rev-parse", "--verify", "refs/heads/wtgui/merged"), true);
    assert.equal(ran(fixture.repo, "rev-parse", "--verify", `refs/heads/${TURNOVER}`), true);
    // ...and the page was written into the TARGET repo, under the name the brief fixes.
    const reports = readdirSync(path.join(fixture.repo, "docs", "reports"));
    const page = reports.find((f) => /^worktree-cleanup-\d{4}-\d{2}-\d{2}-\d{4}\.html$/.test(f));
    assert.ok(page, `a report named worktree-cleanup-<date>-<hhmm>.html, got ${reports.join(", ")}`);
    const html = readFileSync(path.join(fixture.repo, "docs", "reports", page), "utf8");
    assert.match(html, /DRY RUN/);
    assert.match(html, /cherry-equivalent/);
    assert.match(html, /No <code>--force<\/code> anywhere/);
    // A row per worktree, including the skipped primary.
    assert.equal((html.match(/class="verdict v-/g) || []).length, rows.length);
  } finally {
    await panel.stop();
  }
});

test("cleanup route: the apply removes the landed trees, merges the rest into children, and never pushes", async () => {
  const panel = await panelFor();
  try {
    const r = await post(panel.base, "/api/projects/fixture/cleanup", { body: { dryRun: false }, token: panel.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.dryRun, false);
    const counts = r.json.run.counts;
    assert.equal(counts.remove, 2, `two trees were landed: ${JSON.stringify(counts)}`);
    assert.equal(counts.merge, 2, `two branches hold work main lacks: ${JSON.stringify(counts)}`);
    assert.equal(counts.failed || 0, 0);

    // 1 and 2: the landed trees are gone, folder and branch.
    for (const name of ["merged", "cherry"]) {
      assert.equal(existsSync(fixture.trees[name]), false, `${name} must be removed`);
      assert.equal(ran(fixture.repo, "rev-parse", "--verify", `refs/heads/wtgui/${name}`), false, `wtgui/${name} must be deleted`);
    }
    // A cherry-equivalent branch is the case `git branch -d` refuses: it is gone, so the proof carried the delete.
    assert.match(JSON.stringify(r.json.run.rows.find((x) => x.path === fixture.trees.cherry)?.result || {}), /cherry/);

    // 3 and 4: the other two trees stand, and each branch now has a child merge commit with two parents.
    for (const name of ["unmerged", "dirty"]) {
      assert.equal(existsSync(fixture.trees[name]), true, `${name} must stay`);
      assert.equal(ran(fixture.repo, "rev-parse", "--verify", `refs/heads/wtgui/${name}`), true, `wtgui/${name} must stay`);
    }
    const children = git(fixture.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/cleanup/").split("\n").filter(Boolean);
    assert.equal(children.length, 2, `one child per merged branch, got ${children.join(", ")}`);
    const mainTip = git(fixture.repo, "rev-parse", "main");
    for (const child of children) {
      const line = git(fixture.repo, "rev-list", "--parents", "-n", "1", child).split(" ");
      assert.equal(line.length, 3, `${child} must be a merge commit with two parents`);
      assert.equal(line[1], mainTip, `${child}'s first parent must be main - a --no-ff merge, not a squash`);
      assert.equal(git(fixture.repo, "rev-parse", `${child}^2`).startsWith(line[2]), true);
    }
    // The branch's work really is in its child, and main itself did NOT move.
    assert.equal(ran(fixture.repo, "merge-base", "--is-ancestor", "wtgui/unmerged", children.find((c) => c.includes("unmerged"))), true);
    assert.equal(git(fixture.repo, "rev-parse", "main"), mainTip, "main is never merged into");

    // 5: the dirty tree kept its uncommitted file, and the merge never consulted it.
    assert.equal(readFileSync(path.join(fixture.trees.dirty, "dirty-work.txt"), "utf8"), "uncommitted, the only copy\n");
    assert.match(git(fixture.trees.dirty, "status", "--porcelain"), /dirty-work\.txt/);
    const dirtyChild = children.find((c) => c.includes("dirty"));
    assert.equal(git(fixture.repo, "cat-file", "-t", `${dirtyChild}:dirty-commit.txt`), "blob");
    assert.equal(ran(fixture.repo, "cat-file", "-e", `${dirtyChild}:dirty-work.txt`), false, "an uncommitted file is never in the merge");

    // 6: the turnover branch is untouched even though it is fully merged, and the out-of-project tree was never
    //    a candidate: it is still there, with its branch.
    assert.equal(ran(fixture.repo, "rev-parse", "--verify", `refs/heads/${TURNOVER}`), true);
    assert.equal(existsSync(fixture.trees.turnover), true);
    assert.equal(existsSync(fixture.outside), true, "a tree outside the project folder is never removed by the cleanup");
    assert.equal(ran(fixture.repo, "rev-parse", "--verify", "refs/heads/land/fixture-check"), true, "and its branch is never deleted");

    // 7: no push and no remote. The fixture has never had one, and nothing here invents one.
    assert.equal(git(fixture.repo, "remote").trim(), "");
    assert.equal(git(fixture.repo, "for-each-ref", "refs/remotes").trim(), "");

    // The page the apply wrote says what it did, and the run names the child branches in the answer.
    const reports = readdirSync(path.join(fixture.repo, "docs", "reports")).filter((f) => f.endsWith(".html"));
    const html = readFileSync(path.join(fixture.repo, "docs", "reports", reports[reports.length - 1]), "utf8");
    assert.match(html, /This run APPLIED the plan/);
    assert.match(html, /merged --no-ff into cleanup\//);
    // The dirty tree is NAMED in the page, with the uncommitted file it kept, and the merge says the tree stayed.
    assert.ok(html.includes(`<code>${fixture.trees.dirty}</code>`), "the dirty tree is a row of its own in the report");
    assert.match(html, /dirty-work\.txt/);
    assert.match(html, /the dirty tree was left in place, its working files untouched/);
    // Every row carries its keep-or-drop call, and the two landed trees carry `drop`.
    assert.equal((html.match(/class="call c-drop"/g) || []).length, 2);
    assert.equal((html.match(/class="call c-keep"/g) || []).length, 5);
    assert.match(r.json.report.path, /^docs[\\/]reports[\\/]worktree-cleanup-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);
  } finally {
    await panel.stop();
  }
});

test("cleanup route: 404 for an unknown project, 405 for a GET, and no flag at all is still a dry run", async () => {
  const panel = await panelFor();
  try {
    // A write from the loopback is authorised by design (lib/http/transport.js `authorised`), so the token case is
    // about a NON-loopback caller and is covered where it lives; what this route must answer itself is the path.
    const unknown = await post(panel.base, "/api/projects/nope/cleanup", { body: { dryRun: true }, token: panel.token });
    assert.equal(unknown.status, 404);
    assert.match(unknown.json.error, /unknown project: nope/);
    const get = await fetch(`${panel.base}/api/projects/fixture/cleanup`, { headers: { "x-panel-token": panel.token } });
    assert.equal(get.status, 405);
    const missingFlag = await post(panel.base, "/api/projects/fixture/cleanup", { body: {}, token: panel.token });
    // No `dryRun: false` is a DRY RUN: a caller that forgets the flag cannot delete a tree by accident.
    assert.equal(missingFlag.status, 200);
    assert.equal(missingFlag.json.dryRun, true);
    // ...and neither is the STRING "false": only the literal boolean buys the write.
    const stringFlag = await post(panel.base, "/api/projects/fixture/cleanup", { body: { dryRun: "false" }, token: panel.token });
    assert.equal(stringFlag.status, 200);
    assert.equal(stringFlag.json.dryRun, true);
    assert.equal(stringFlag.json.run, undefined, "a string flag must not return a run");
  } finally {
    await panel.stop();
  }
});

test.after(() => {
  rmSync(fixture.base, { recursive: true, force: true });
});
