// The cleanup RUN's own guarantees, separate from the planner's rules: what an apply refuses to do, and what the
// source is not allowed to contain.
//
// The planner (lib/cleanup-plan.js) decides; `applyCleanup` (lib/cleanup-run.js) acts. These tests drive the act with
// a stub remover, so nothing on disk is touched, and pin the three ways a "safe" apply goes wrong:
//
//   1. a row the planner marked `keep` or `skip` is never acted on - not removed, not merged, not branch-deleted -
//      however tempting its proof looks;
//   2. a `remove` row whose proof is neither `ancestor` nor `cherry` removes the tree and REFUSES the branch: the
//      branch delete is the one step that has to be justified by the proof the row carries;
//   3. no `--force`, no forced branch delete and no `push` exists in the cleanup source at all, read from the code
//      with comments stripped so a comment that says "no --force" cannot make the scan pass on its own;
//   4. a merge that conflicts writes NOTHING and says so: a conflict is a keep with a reason, never a resolution.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyCleanup, mergeIntoChild, stampOf } from "../lib/cleanup-run.js";
import { configureRepo, git, ran } from "../tools/panel-testkit.mjs";

const row = (over = {}) => ({
  path: "/r/.worktrees/x",
  branch: "wtgui/x",
  head: "1".repeat(40),
  dirty: false,
  dirtyFiles: [],
  ahead: 0,
  proof: { kind: "ancestor", detail: "wtgui/x is an ancestor of main" },
  verdict: "keep",
  call: "keep",
  reason: "",
  merge: null,
  ...over,
});

const PROJECT = { name: "demo", path: "/r" };

test("a keep row and a skip row are recorded and never acted on, whatever their proof says", async () => {
  let removed = 0;
  const plan = {
    main: "main",
    rows: [
      // A clean, landed branch the reader's LOCK holds: the proof would justify a drop, the verdict does not.
      row({ path: "/r/.worktrees/locked", branch: "wtgui/locked", verdict: "skip", reason: "locked by the reader (do not touch)" }),
      // A dirty tree whose commits are in main: kept so the uncommitted work survives.
      row({ path: "/r/.worktrees/dirty", branch: "wtgui/dirty", verdict: "keep", dirty: true, dirtyFiles: ["only-copy.txt"] }),
    ],
  };
  const out = await applyCleanup({
    project: PROJECT,
    plan,
    removeTree: async () => {
      removed += 1;
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(removed, 0, "neither a keep nor a skip row may reach the remover");
  assert.equal(out.counts.failed, 0);
  assert.equal(out.counts.keep, 1);
  assert.equal(out.counts.skip, 1);
  for (const r of out.rows) {
    assert.equal(r.result.acted, false);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.why, r.reason);
  }
});

test("a remove row with no proof loses its branch: the tree goes, the ref stays, and the reason says why", async () => {
  const plan = {
    main: "main",
    rows: [row({ path: "/r/.worktrees/x", branch: "wtgui/x", verdict: "remove", call: "drop", proof: { kind: "none", detail: "no proof was read" } })],
  };
  // The repo path is a name, not a checkout: `deleteBranchByProof` must refuse on the proof BEFORE it runs git, so a
  // missing repository cannot be what stops it.
  const out = await applyCleanup({ project: { name: "demo", path: "/r/not-a-checkout" }, plan, removeTree: async () => ({ ok: true }) });
  assert.equal(out.rows[0].result.acted, true);
  assert.equal(out.rows[0].result.ok, false);
  assert.equal(out.rows[0].result.branchDeleted, false);
  assert.match(out.rows[0].result.why, /wtgui\/x stayed: no proof this branch is landed/);
  assert.equal(out.counts.failed, 1);
});

test("an apply without the remover, or without a plan, refuses instead of half-running", async () => {
  assert.equal((await applyCleanup({ project: PROJECT, plan: null })).ok, false);
  const noRemover = await applyCleanup({ project: PROJECT, plan: { main: "main", rows: [] } });
  assert.equal(noRemover.ok, false);
  assert.match(noRemover.error, /needs removeTree/);
});

test("nothing in the cleanup source can force or push: the code, with comments stripped, names neither", () => {
  // Comments in these files TALK about --force ("no --force anywhere"), so the scan reads code only. A comment must
  // never be able to satisfy or break this test.
  // The file is normalised to LF first: this checkout is CRLF (`core.autocrlf`), and `.` does not match the CR
  // that ends such a line, so a `// ...$` strip on CRLF text silently strips NOTHING and the scan reads the
  // comments as code.
  const stripComments = (src) =>
    String(src)
      .split(String.fromCharCode(13))
      .join("")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
      .join("\n");
  const files = ["../lib/cleanup-plan.js", "../lib/cleanup-run.js", "../routes/project-cleanup.js"];
  for (const file of files) {
    const code = stripComments(readFileSync(new URL(file, import.meta.url), "utf8"));
    assert.equal(/--force|--force-with-lease|--no-verify/.test(code), false, `${file} must not pass a force flag`);
    assert.equal(/(^|\s)-D(\s|$)/.test(code), false, `${file} must not delete a branch with -D`);
    // `rows.push(...)` is an array, not a publication: the two shapes a push really takes are the quoted subcommand
    // and the git call on one line, and a push needs a remote to name.
    assert.equal(/["'`]push["'`]|\bgit\b[^\n]*\bpush\b/.test(code), false, `${file} must not run git push`);
    assert.equal(/\bremote\b/.test(code), false, `${file} must not name a remote`);
  }
  // The report module is not scanned for flags: its HTML legitimately PRINTS the sentence "no --force anywhere".
  // What it must never have is a way to act at all, so it is pinned to a renderer with no process behind it.
  const report = stripComments(readFileSync(new URL("../lib/cleanup-report.js", import.meta.url), "utf8"));
  assert.equal(/child_process|childExec|spawn\(|execFile/.test(report), false, "the report renders, it never runs anything");
  // The three git arguments the apply really uses, named here so a later edit has to change this test too: a
  // compare-and-set ref delete, a -d branch delete, and a two-parent commit from merge-tree.
  const run = readFileSync(new URL("../lib/cleanup-run.js", import.meta.url), "utf8");
  assert.match(run, /\["update-ref", "-d", `refs\/heads\/\$\{branch\}`, head\]/);
  assert.match(run, /\["branch", "-d", branch\]/);
  assert.match(run, /\["update-ref", `refs\/heads\/\$\{child\}`, sha, ZERO_SHA\]/);
});

test("stampOf is the report's own minute, and the child branch carries it", () => {
  assert.equal(stampOf(new Date(2026, 10, 14, 9, 3)), "20261114-0903");
  assert.equal(stampOf(new Date(2026, 0, 2, 23, 59)), "20260102-2359");
});

test("a conflicting merge writes no ref at all and reports the conflict", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "cleanup-merge-conflict-"));
  const repo = path.join(base, "repo");
  try {
    git(base, "init", "-q", "-b", "main", "repo");
    configureRepo(repo);
    writeFileSync(path.join(repo, "file.txt"), "base\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "root");
    // Two branches that disagree about the same line: the merge cannot be resolved, and nothing may be forced.
    git(repo, "checkout", "-q", "-b", "one");
    writeFileSync(path.join(repo, "file.txt"), "one\n", "utf8");
    git(repo, "commit", "-qam", "one");
    git(repo, "checkout", "-q", "main");
    git(repo, "checkout", "-q", "-b", "two");
    writeFileSync(path.join(repo, "file.txt"), "two\n", "utf8");
    git(repo, "commit", "-qam", "two");

    const out = await mergeIntoChild({ repo, branch: "two", base: "one", at: new Date(2026, 10, 14, 9, 3) });
    assert.equal(out.ok, false);
    assert.equal(out.conflict, true, "a conflict is reported as a conflict, not as a failed read");
    assert.match(out.error, /conflicts/);
    // No child branch, and neither side moved: a conflicted merge leaves no half-written ref behind.
    assert.equal(git(repo, "for-each-ref", "refs/heads/cleanup/").trim(), "");
    assert.equal(ran(repo, "rev-parse", "--verify", "refs/heads/one"), true);
    assert.equal(ran(repo, "rev-parse", "--verify", "refs/heads/two"), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
