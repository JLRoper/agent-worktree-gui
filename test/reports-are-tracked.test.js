// A page under docs/reports that is on disk and not in the index is a page a worktree carries to its grave.
//
// The defect this file exists for: .git/info/exclude carries `docs/reports/*.html`, in this clone and in every
// worktree it holds, so `git status` never names a report that was written and not added. The original Route
// implementation report was written that way, the worktree was removed, and the page with it - and the only reason
// anyone noticed is that a later report about the same round was rebuilt from the work that did land.
//
// What the tests pin, in the order the trap closes:
//   - this tree: every .html under docs/reports is in the index, and the index really does hold the pages (so a
//     broken listing cannot pass by finding nothing);
//   - a fixture where the page IS ignored: git status stays silent about it, and the check names it anyway. That pair
//     is the whole point - the silence is the bug, and a check that reads the index is what beats it;
//   - recording the page makes the same fixture pass, so the answer the check gives is the fix.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";
import { REPORT_DIR, htmlOnDisk, reportOf, trackedHtml, untrackedReports } from "../tools/reports-tracked.mjs";

test("every page under docs/reports on this tree is in the index", { skip: !existsSync(path.join(ROOT, ".git")) }, () => {
  const onDisk = htmlOnDisk(ROOT);
  const tracked = trackedHtml(ROOT);
  // A listing that found nothing would pass the next assertion for the wrong reason. There are dozens of pages.
  assert.ok(onDisk.length >= 30, `the report folder holds the pages this check is for (found ${onDisk.length})`);
  assert.ok(tracked.size >= 30, `the index holds them too (found ${tracked.size})`);
  assert.deepEqual(untrackedReports(ROOT), [], reportOf(untrackedReports(ROOT)));
});

test("an ignored page is invisible to git status and named by the check", async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "wag-reports-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q");
  configureRepo(repo);
  await mkdir(path.join(repo, ".git", "info"), { recursive: true });
  // The rule this clone really carries, byte for byte in shape: a comment, then the glob.
  await writeFile(
    path.join(repo, ".git", "info", "exclude"),
    "# Generated reports are local artefacts\ndocs/reports/*.html\n",
    "utf8",
  );
  await mkdir(path.join(repo, REPORT_DIR), { recursive: true });
  await writeFile(path.join(repo, REPORT_DIR, "kept.html"), "<!doctype html><title>kept</title>\n", "utf8");
  git(repo, "add", "-f", `${REPORT_DIR}/kept.html`);
  git(repo, "commit", "-q", "-m", "a page that was force-added");

  // The page that will be lost: written, ignored, never added.
  await writeFile(path.join(repo, REPORT_DIR, "lost.html"), "<!doctype html><title>lost</title>\n", "utf8");

  assert.equal(git(repo, "status", "--short").trim(), "", "git status says nothing, which is the defect");
  assert.deepEqual(untrackedReports(repo), [`${REPORT_DIR}/lost.html`], "the check names the page anyway");
  const message = reportOf(untrackedReports(repo));
  assert.match(message, /lost\.html/, "the failure text names the page");
  assert.match(message, /git add -f/, "the failure text carries the fix");

  // The fix the message asks for really clears it.
  git(repo, "add", "-f", `${REPORT_DIR}/lost.html`);
  assert.deepEqual(untrackedReports(repo), [], "force-adding the page satisfies the check");
});

test("a subfolder page is compared as a repo-relative path", async (t) => {
  // Reports keep their evidence beside them (docs/reports/<round>/...), so the walk has to recurse and the index
  // listing has to answer with the same shape. A flat comparison would miss a page one folder down.
  const repo = await mkdtemp(path.join(os.tmpdir(), "wag-reports-nested-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q");
  configureRepo(repo);
  await mkdir(path.join(repo, REPORT_DIR, "round", "deep"), { recursive: true });
  await writeFile(path.join(repo, REPORT_DIR, "round", "deep", "page.html"), "<!doctype html><title>deep</title>\n", "utf8");
  assert.deepEqual(untrackedReports(repo), [`${REPORT_DIR}/round/deep/page.html`], "a nested page is found");
  git(repo, "add", "-f", `${REPORT_DIR}/round/deep/page.html`);
  assert.deepEqual(untrackedReports(repo), [], "and tracked once it is added");
});

test("a secret page is local by design and is not called lost work", async (t) => {
  // `*.secret.html` is the report a clarify card links (docs/clarify-juggling-design-2026-11-24.md). It is ignored on
  // purpose, so a check that compared every .html on disk against the index would fail on the one page the convention
  // tells every agent to write. The exemption is by suffix only: a plain page beside it is still reported.
  const repo = await mkdtemp(path.join(os.tmpdir(), "wag-reports-secret-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q");
  configureRepo(repo);
  await mkdir(path.join(repo, REPORT_DIR), { recursive: true });
  await writeFile(path.join(repo, REPORT_DIR, "card.secret.html"), "<!doctype html><title>card</title>\n", "utf8");
  await writeFile(path.join(repo, REPORT_DIR, "plain.html"), "<!doctype html><title>plain</title>\n", "utf8");

  // The page is really on disk, so the empty answer below is the exemption and not a folder the walk missed.
  assert.ok(htmlOnDisk(repo).includes(`${REPORT_DIR}/card.secret.html`), "the secret page is on disk");
  assert.deepEqual(untrackedReports(repo), [`${REPORT_DIR}/plain.html`], "only the plain page is called lost");

  // A subfolder secret page is exempt too: the suffix is the rule, not the directory.
  await mkdir(path.join(repo, REPORT_DIR, "round"), { recursive: true });
  await writeFile(path.join(repo, REPORT_DIR, "round", "deep.secret.html"), "<!doctype html><title>deep</title>\n", "utf8");
  assert.deepEqual(untrackedReports(repo), [`${REPORT_DIR}/plain.html`], "a nested secret page is exempt by suffix");

  git(repo, "add", "-f", `${REPORT_DIR}/plain.html`);
  assert.deepEqual(untrackedReports(repo), [], "the plain page still has to be added");
});
