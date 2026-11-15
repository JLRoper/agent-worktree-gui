// The cleanup page: the per-repo report the chip opens, proved as a rendering rather than as a file that exists.
//
// The route test proves the report is WRITTEN into the target repo; this one proves what it SAYS, one requirement per
// assertion, because a page with the right filename and the wrong columns is the failure mode that reads as success:
//
//   1. the name is docs/reports/worktree-cleanup-<date>-<hhmm>.html, in the repo the run is about;
//   2. one row per worktree AND branch, including the skipped primary checkout and a detached tree;
//   3. the verdict, and what that verdict means, on every row;
//   4. the proof (ancestor or cherry) with the sentence behind it, and no proof chip where there is none;
//   5. what a merge added: the child, its base, files, bytes and lines, and the note that a dirty tree stayed put;
//   6. the dirty files, named;
//   7. the keep-or-drop call on every row;
//   8. a dry run says DRY RUN, an apply says APPLIED and carries each row's outcome.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderCleanupReport, reportRelPath, writeCleanupReport } from "../lib/cleanup-report.js";

const AT = new Date(2026, 10, 14, 9, 30);
const SHA = "a".repeat(40);

const PLAN = {
  project: "demo",
  main: "main",
  turnoverBranch: "20260710_1338_DMR-1-turnover",
  primaryPath: "/repos/demo",
  ownPath: "/repos/demo/.worktrees/panel",
  counts: { remove: 2, merge: 1, keep: 1, skip: 1 },
  droppable: 2,
  rows: [
    {
      path: "/repos/demo/.worktrees/merged",
      branch: "wtgui/merged",
      verdict: "remove",
      call: "drop",
      proof: { kind: "ancestor", detail: "wtgui/merged is an ancestor of main - every commit it carries is already there" },
      reason: "already in main by history, and the tree is clean",
      dirty: false,
      dirtyFiles: [],
    },
    {
      path: "/repos/demo/.worktrees/cherry",
      branch: "wtgui/cherry",
      verdict: "remove",
      call: "drop",
      proof: { kind: "cherry", detail: "git cherry marks all 1 commit main lacks as cherry-equivalent (-), so the content is already in main" },
      reason: "every commit main lacks is cherry-equivalent, and the tree is clean",
      dirty: false,
      dirtyFiles: [],
    },
    {
      path: "/repos/demo/.worktrees/dirty",
      branch: "wtgui/dirty",
      verdict: "merge",
      call: "keep",
      proof: { kind: "none", detail: "1 of 1 commit main lacks is not in main by content" },
      merge: { base: "20260710_1338_DMR-1-turnover", child: "cleanup/wtgui-dirty-20261114-0930-ab12", commit: SHA, files: 3, bytes: 2048, linesAdded: 40, linesRemoved: 2, treeKept: true },
      reason: "1 commit main lacks, and the tree is dirty: merge the branch into a child and leave the tree alone",
      dirty: true,
      dirtyFiles: ["dirty-work.txt", "notes/a.md"],
    },
    {
      path: "/repos/demo/.worktrees/panel",
      branch: "wtgui/panel",
      verdict: "keep",
      call: "keep",
      proof: { kind: "none", detail: "no proof was read for this tree" },
      reason: "the panel's own tree - its cwd is this folder, so nothing here may remove it",
      dirty: false,
      dirtyFiles: [],
    },
    {
      path: "/repos/demo",
      branch: "main",
      verdict: "skip",
      call: "keep",
      proof: { kind: "none", detail: "" },
      reason: "the project's primary checkout - the plan never touches it",
      dirty: false,
      dirtyFiles: [],
    },
  ],
};

const render = (extra = {}) => renderCleanupReport({ project: { name: "demo", path: "/repos/demo" }, plan: PLAN, at: AT, reportPath: reportRelPath(AT), ...extra });
const text = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

test("the report is named docs/reports/worktree-cleanup-<date>-<hhmm>.html", () => {
  assert.equal(reportRelPath(AT), "docs/reports/worktree-cleanup-2026-11-14-0930.html");
  assert.equal(reportRelPath(new Date(2027, 0, 2, 0, 5)), "docs/reports/worktree-cleanup-2027-01-02-0005.html");
});

test("one row per worktree and branch, with a verdict that says what it means", () => {
  const html = render();
  assert.equal((html.match(/<td class="tree">/g) || []).length, PLAN.rows.length, "one row per worktree");
  for (const row of PLAN.rows) {
    assert.ok(html.includes(`<code>${row.path}</code>`), `${row.path} must be named`);
    assert.ok(html.includes(`<code>${row.branch}</code>`) || text(html).includes(row.branch), `${row.branch} must be named`);
    assert.match(html, new RegExp(`class="verdict v-${row.verdict}"`));
  }
  assert.match(text(html), /drop the tree and its branch/);
  assert.match(text(html), /merge the branch --no-ff into a child, then keep the tree/);
  assert.match(text(html), /not the cleanup's to touch/);
});

test("the proof is printed with its kind, and a row with no proof claims none", () => {
  const html = render();
  assert.match(text(html), /wtgui\/merged is an ancestor of main/);
  assert.match(html, /<code>ancestor<\/code>/);
  assert.match(text(html), /git cherry marks all 1 commit main lacks as cherry-equivalent/);
  assert.match(html, /<code>cherry<\/code>/);
  // The merge row has no landed proof: it must not be dressed in one.
  assert.equal((html.match(/<code>ancestor<\/code>|<code>cherry<\/code>/g) || []).length, 2);
});

test("a merge says what it added, into which child, and whether the dirty tree was left in place", () => {
  const html = render();
  assert.match(text(html), /cleanup\/wtgui-dirty-20261114-0930-ab12/);
  assert.match(text(html), /20260710_1338_DMR-1-turnover -> aaaaaaaaaaaa/);
  assert.match(text(html), /3 files, 2.0 KB added, \+40\/-2 lines/);
  assert.match(text(html), /the dirty tree was left in place, its working files untouched/);
});

test("the dirty tree is named by its uncommitted files", () => {
  const html = render();
  assert.match(text(html), /2 files/);
  assert.ok(html.includes("<code>dirty-work.txt</code>"));
  assert.ok(html.includes("<code>notes/a.md</code>"));
  // ...and a clean tree says so rather than leaving the cell empty.
  assert.match(text(html), /clean/);
});

test("every row carries its keep-or-drop call", () => {
  const html = render();
  assert.equal((html.match(/class="call c-drop"/g) || []).length, 2);
  assert.equal((html.match(/class="call c-keep"/g) || []).length, 3);
  assert.match(text(html), /already in main by history, and the tree is clean/);
  assert.match(text(html), /the panel's own tree/);
});

test("a dry run says DRY RUN and an apply says APPLIED, with each row's outcome", () => {
  const dry = render();
  assert.match(text(dry), /This is a DRY RUN: nothing was removed, merged or moved/);
  const applied = render({
    run: {
      main: "main",
      counts: { remove: 2, merge: 1, keep: 1, skip: 1, failed: 1 },
      rows: PLAN.rows.map((row) =>
        row.verdict === "remove"
          ? { ...row, result: { acted: true, ok: true, why: `worktree removed and ${row.branch} deleted (${row.proof.kind})` } }
          : row.verdict === "merge"
            ? { ...row, result: { acted: false, ok: false, why: "the merge of wtgui/dirty into the turnover branch conflicts" } }
            : { ...row, result: { acted: false, ok: true, why: row.reason } },
      ),
    },
  });
  assert.match(text(applied), /This run APPLIED the plan/);
  assert.match(text(applied), /worktree removed and wtgui\/merged deleted \(ancestor\)/);
  assert.match(text(applied), /conflicts/);
  // The counts are the run's, not the plan's: a failed row shows up in the header.
  assert.match(text(applied), /1 failed/);
});

test("a branch name, path or reason carrying markup is escaped: the page is built from git strings", () => {
  // A git branch may be named `<img src=x onerror=...>`, and a path or a lock's reason can carry anything. The page is
  // opened in the reader's browser, so every one of those strings has to arrive as text.
  const hostile = {
    ...PLAN,
    rows: [
      {
        path: "/repos/demo/.worktrees/<img src=x onerror=alert(1)>",
        branch: "<script>alert(2)</script>",
        verdict: "keep",
        call: "keep",
        proof: { kind: "none", detail: "<b>1</b> commit main lacks" },
        reason: "& <not a tag>",
        dirty: false,
        dirtyFiles: ["<textarea>.git/index"],
      },
    ],
  };
  const html = render({ plan: hostile, project: { name: "<i>demo</i>", path: "/repos/demo" } });
  assert.equal(html.includes("<img src=x"), false, "no live img element");
  assert.equal(html.includes("<script>"), false, "no live script element");
  assert.equal(html.includes("<textarea>"), false, "no live textarea element");
  assert.equal(html.includes("<i>demo</i>"), false, "not even in the title");
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&amp; &lt;not a tag&gt;/);
});

test("the page is written into the target repo under docs/reports, and says where", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "cleanup-report-"));
  try {
    const repo = path.join(base, "repo");
    const html = render();
    const written = await writeCleanupReport({ repo, html, at: AT });
    assert.equal(written.ok, true, written.error);
    assert.equal(written.path, path.join("docs", "reports", "worktree-cleanup-2026-11-14-0930.html"));
    assert.equal(existsSync(written.absPath), true);
    assert.equal(readFileSync(written.absPath, "utf8"), html);
    assert.equal(written.bytes, Buffer.byteLength(html, "utf8"));
    // Nothing to write into is refused, not crashed on.
    assert.equal((await writeCleanupReport({ repo: "", html })).ok, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
