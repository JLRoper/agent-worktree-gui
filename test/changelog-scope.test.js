// The changelog's SCOPE: this repository's own work, and nothing else.
//
// The defect this file exists for: a landing agent wrote a retest report for PictureViewer and Picture Manager,
// filed it under this repo's docs/ and pushed it here. v1.76.24 then listed that report as this panel's work, and
// the report's subject is not the only route in - a neutral subject with a foreign path writes the same bullet.
// History is not rewritten for it; the report is deleted in a new commit, and the renderer and the commit-msg gate
// read ONE list of the projects whose reports do not belong here, so a second report cannot follow the first.
//
// What is pinned here:
//   - one vocabulary: subject, path and token are read as words, case and separators ignored, whole words only;
//   - the rule: a DOCS commit naming another project is left out, and a DELETION is not a match, because removing
//     the report is this repo's own cleanup and the commit that removes it must be able to say so;
//   - the repair: a section the file already carries that names another project is rendered again, so a file that
//     already lists the report heals on the next forward render, not only on a minutes-long --full walk;
//   - the gate: the real .githooks/commit-msg refuses the commit, by subject and by staged path, and lets the
//     deletion and this repo's own docs through.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classify, renderRepo } from "../tools/changelog.mjs";
import {
  SCOPE_FILE,
  foreignCommit,
  isDocsSubject,
  loadScope,
  namesForeignProject,
  sectionNamesForeignProject,
} from "../tools/changelog-scope.mjs";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const FILE = "CHANGELOG.md";
const FOREIGN_SUBJECT = "docs: PictureViewer and Picture Manager SSO retest on dev with deploy evidence (DMR-39015)";

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-scope-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["remote", "add", "origin", "https://github.com/acme/sandbox.git"]);
  return dir;
}

function setVersion(dir, version) {
  writeFileSync(path.join(dir, "package.json"), `{\n  "name": "sandbox",\n  "version": "${version}",\n  "private": true\n}\n`, "utf8");
}

function commitAll(dir, subject) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", subject]);
}

function release(dir, version, subject) {
  setVersion(dir, version);
  git(dir, ["commit", "-q", "-am", subject]);
}

// The SHIPPED list and the SHIPPED tool, so the test pins what the repository carries rather than a fixture that
// could drift from it.
function installScope(dir) {
  mkdirSync(path.join(dir, "tools"), { recursive: true });
  for (const name of ["changelog-scope.mjs", "changelog-scope.json"]) {
    copyFileSync(path.join(ROOT, "tools", name), path.join(dir, "tools", name));
  }
}

function section(text, version) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## v${version} `));
  assert.ok(start >= 0, `the file names v${version}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## v")) {
      end = i;
      break;
    }
  }
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

test("the docs half of the rule is the renderer's own docs classification", () => {
  // changelog-scope.mjs repeats the docs prefix because the renderer imports it and cannot be imported back. The
  // repetition is only safe while the two answers agree, so every prefix either one reads is checked here.
  const samples = [
    "docs: a report",
    "docs(scope): a report",
    "docs!: a report",
    "Docs: a report",
    "doc: a report",
    "feat: a report",
    "fix(docs): a report",
    "test: a report",
    "chore: 1.2.3 - the version",
    "docs a report",
  ];
  for (const subject of samples) {
    assert.equal(isDocsSubject(subject), classify(subject) === "docs", `${JSON.stringify(subject)}: the gate and the renderer agree`);
  }
});

test("a token matches whole words, whatever the case and separator", () => {
  const scope = loadScope(ROOT);
  assert.ok(scope.projects.length > 0, "the shipped scope names at least one project");
  for (const text of [
    FOREIGN_SUBJECT,
    "docs/pictureviewer-retest.html",
    "docs/landing-PictureViewer-pmw-sso-retest-2026-11-09.html",
    "docs/landing-picture_viewer_deploy.html",
    "docs/landing-picture-viewer-deploy.html",
    "docs/picture-manager-web-deploy.html",
  ]) {
    assert.ok(namesForeignProject(text, scope), `${JSON.stringify(text)} names another project`);
  }
  // This repository's own subjects, and the ordinary English word, are not a project.
  for (const text of [
    "feat: the changelog render keeps the sections the file carries",
    "docs: name the retest evidence without machine paths",
    "fix: the console shows the same picture after a reorder",
    "docs: pmwx is not a token",
    "chore: 1.76.24 - the version this landing carries",
  ]) {
    assert.equal(namesForeignProject(text, scope), null, `${JSON.stringify(text)} is this repo's own work`);
  }
});

test("a docs commit is foreign by its subject or by a path it adds, and a deletion is not", () => {
  const scope = loadScope(ROOT);
  assert.deepEqual(foreignCommit({ subject: FOREIGN_SUBJECT, files: [] }, scope), { project: "pictureviewer", how: "in its subject" });
  assert.deepEqual(foreignCommit({ subject: "docs: name the retest evidence without machine paths", files: [{ status: "A", path: "docs/landing-pictureviewer-pmw-sso-retest-2026-11-09.html" }] }, scope).project, "pictureviewer");
  assert.equal(foreignCommit({ subject: "docs: delete the retest report copied in from another project", files: [{ status: "D", path: "docs/landing-pictureviewer-pmw-sso-retest-2026-11-09.html" }] }, scope), null, "removing it is this repo's cleanup");
  assert.equal(foreignCommit({ subject: "fix: the retest retries a dropped request", files: [{ status: "M", path: "lib/retest.js" }] }, scope), null, "a non-docs commit is not the scope rule");
  assert.equal(foreignCommit({ subject: FOREIGN_SUBJECT, files: [] }, { projects: [] }), null, "a repo without the list filters nothing");
});

test("a kept section is read for the bullets a foreign commit would have written", () => {
  const scope = loadScope(ROOT);
  const sectionText = [
    "## v1.76.24 - 2026-11-09 - 1 commit",
    "",
    "[`f8df153`](https://example.invalid/f8df153) - [compare v1.76.23...v1.76.24](https://example.invalid/c)",
    "",
    "### Docs & tests",
    "",
    `- ${FOREIGN_SUBJECT} ([\`719425b\`](https://example.invalid/719425b))`,
  ].join("\n");
  assert.equal(sectionNamesForeignProject(sectionText, scope), "pictureviewer");
  assert.equal(sectionNamesForeignProject(sectionText.replace(/- docs: .*\n?/, ""), scope), null, "a heading and a meta line are not a commit");
});

test("the renderer leaves a docs commit naming another project out of its release, and keeps the deletion", () => {
  const dir = sandbox();
  setVersion(dir, "1.0.0");
  commitAll(dir, "feat: the first capability");

  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "landing-pictureviewer-pmw-sso-retest-2026-11-09.html"), "<h1>retest</h1>\n", "utf8");
  commitAll(dir, FOREIGN_SUBJECT);
  release(dir, "1.1.0", "chore: 1.1.0 - the version this landing carries");

  // The CONTROL: without the list nothing is filtered, so the difference below is the list's doing and not a
  // blanket rule about reports.
  const control = renderRepo({ root: dir, full: true });
  assert.match(section(control.text, "1.1.0"), /2 commits/);
  assert.match(section(control.text, "1.1.0"), /PictureViewer/);

  installScope(dir);
  const render = renderRepo({ root: dir, full: true });
  const v110 = section(render.text, "1.1.0");
  assert.match(v110, /## v1\.1\.0 .* 1 commit$/m, "only the bump is left in the release");
  assert.match(v110, /chore: 1\.1\.0/);
  assert.doesNotMatch(v110, /PictureViewer|picture-manager/, "the foreign report is not listed");
  assert.equal(render.dropped, 1, "the render says how many it left out");

  // The DELETION is this repo's own cleanup: it names the foreign path with status D, and the release that removes
  // the report must be able to list it, or the changelog would hide the fix.
  git(dir, ["rm", "-q", "docs/landing-pictureviewer-pmw-sso-retest-2026-11-09.html"]);
  commitAll(dir, "docs: delete the retest report copied in from another project");
  release(dir, "1.2.0", "chore: 1.2.0 - the version this landing carries");
  const after = renderRepo({ root: dir, full: true });
  const v120 = section(after.text, "1.2.0");
  assert.match(v120, /delete the retest report copied in from another project/, "the removal is the fix and it is listed");
  assert.match(v120, /2 commits/);
  assert.equal(after.dropped, 1, "still only the original report was left out");
  rmSync(dir, { recursive: true, force: true });
});

test("a forward render renders again a section the file already carries that names another project", () => {
  const dir = sandbox();
  setVersion(dir, "1.0.0");
  commitAll(dir, "feat: the first capability");
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "landing-pictureviewer-pmw-sso-retest-2026-11-09.html"), "<h1>retest</h1>\n", "utf8");
  commitAll(dir, FOREIGN_SUBJECT);
  release(dir, "1.1.0", "chore: 1.1.0 - the version this landing carries");

  // The file as the unfixed renderer wrote it: v1.76.24's shape, the foreign report listed under the release.
  const first = renderRepo({ root: dir });
  writeFileSync(path.join(dir, FILE), first.text, "utf8");
  assert.match(section(first.text, "1.1.0"), /PictureViewer/);

  installScope(dir);
  const second = renderRepo({ root: dir });
  assert.equal(second.mode, "forward", "the file is still the seed: the repair is not a --full walk");
  const repaired = section(second.text, "1.1.0");
  assert.match(repaired, /## v1\.1\.0 .* 1 commit$/m);
  assert.doesNotMatch(repaired, /PictureViewer/);
  assert.equal(section(second.text, "1.0.0"), section(first.text, "1.0.0"), "a section that does not name another project is kept byte for byte");
  assert.equal(second.dropped, 1);
  rmSync(dir, { recursive: true, force: true });
});

// The hook is the STOP half: the report cannot be committed here at all, whatever the subject says. The DELETION
// exemption is pinned at the rule level (status D above) because a sandbox cannot commit the report first without
// the hook refusing that commit - which is exactly the behaviour wanted.
test("the real commit-msg hook refuses a foreign docs commit, by subject and by staged path, and lets this repo's docs through", () => {
  const dir = sandbox();
  setVersion(dir, "1.0.0");
  commitAll(dir, "feat: the first capability");
  mkdirSync(path.join(dir, ".githooks"), { recursive: true });
  copyFileSync(path.join(ROOT, ".githooks", "commit-msg"), path.join(dir, ".githooks", "commit-msg"));
  installScope(dir);
  git(dir, ["config", "core.hooksPath", ".githooks"]);
  const before = git(dir, ["rev-parse", "HEAD"]).trim();

  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "landing-pictureviewer-pmw-sso-retest-2026-11-09.html"), "<h1>retest</h1>\n", "utf8");
  git(dir, ["add", "-A"]);

  const tryCommit = (subject) => execFileSync("git", ["commit", "-m", subject], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.throws(
    () => tryCommit(FOREIGN_SUBJECT),
    (err) => /names another project/.test(String(err.stderr || "")) && /pictureviewer/.test(String(err.stderr || "")),
    "the foreign subject is refused with the project named",
  );
  assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), before, "nothing was committed");

  assert.throws(
    () => tryCommit("docs: name the retest evidence without machine paths"),
    (err) => /names another project/.test(String(err.stderr || "")) && /in the path it adds or edits/.test(String(err.stderr || "")),
    "the neutral subject is refused by the staged path",
  );
  assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), before, "nothing was committed");

  // This repo's own work passes. The foreign report is unstaged AND removed from the tree, because `git add -A`
  // would stage an untracked file right back and the pass has to be about this repo's own subject.
  git(dir, ["rm", "--cached", "-q", "docs/landing-pictureviewer-pmw-sso-retest-2026-11-09.html"]);
  rmSync(path.join(dir, "docs", "landing-pictureviewer-pmw-sso-retest-2026-11-09.html"));
  writeFileSync(path.join(dir, "docs", "changelog-scope.md"), "own work\n", "utf8");
  git(dir, ["add", "-A"]);
  tryCommit("docs: name the changelog scope in one list");
  assert.equal(git(dir, ["log", "-1", "--format=%s"]).trim(), "docs: name the changelog scope in one list", "this repo's own docs commit goes through");
  assert.equal(git(dir, ["rev-parse", "HEAD"]).trim() !== before, true, "one commit landed");
  rmSync(dir, { recursive: true, force: true });
});

// The repository's own list is what the fix ships: if a future report for one of these projects lands, the render
// and the hook must both know the project's name without the fix being repeated. A pin, not a fixture.
test("the shipped scope names the project whose report is being removed", () => {
  const scope = JSON.parse(readFileSync(path.join(ROOT, SCOPE_FILE), "utf8"));
  assert.ok(scope.projects.includes("pictureviewer"), "pictureviewer is named");
  assert.ok(scope.projects.some((p) => /picture manager/.test(p)), "picture manager is named");
  assert.match(scope.why, /CHANGELOG\.md/, "the list explains itself");
});
