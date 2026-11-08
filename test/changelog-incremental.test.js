// The changelog render is INCREMENTAL: it keeps the sections CHANGELOG.md already carries and renders only the
// releases above them.
//
// The defect this file exists for: a section costs one `git log <previous-tag>..<tag>` subprocess, and this
// repository has hundreds of releases, so a full render ran past `tools/land.mjs`'s 600 second cap. A landing could
// never finish its post-merge render, and CHANGELOG.md fell releases behind the base. The rule that fixes it is
// narrow enough to pin down here: a section already in the file is the file's, byte for byte, and a section the
// file does not carry is rendered exactly as a full render would render it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseChangelog, renderChangelogForward, renderRepo } from "../tools/changelog.mjs";
import { configureRepo, git } from "../tools/panel-testkit.mjs";

const FILE = "CHANGELOG.md";

// A repository whose package.json declares one version per commit, so every release's range is the one commit that
// bumped it. Tags are not needed: the render reads the version walk, and a tag only matters to the gate.
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-forward-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["remote", "add", "origin", "https://github.com/acme/sandbox.git"]);
  setVersion(dir, "1.0.0");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feat: the first capability"]);
  return dir;
}

function setVersion(dir, version) {
  writeFileSync(
    path.join(dir, "package.json"),
    `{\n  "name": "sandbox",\n  "version": "${version}",\n  "private": true\n}\n`,
    "utf8",
  );
}

function release(dir, version, subject) {
  setVersion(dir, version);
  git(dir, ["commit", "-q", "-am", subject]);
}

// The section for one version, exactly as the file carries it — heading through the blank line before the next.
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

test("the parser reads a section back, and normalises a CRLF checkout", () => {
  const text = ["# Changelog", "", "prose", "", "## v1.2.0 — 2026-01-02 · 2 commits", "", "body", "", "## v1.1.0 — 2026-01-01 · 1 commit", "", "body one", ""].join("\n");
  const lf = parseChangelog(text);
  assert.deepEqual(lf.sections.map((s) => [s.version, s.commits]), [["1.2.0", 2], ["1.1.0", 1]]);
  assert.deepEqual(lf.header, ["# Changelog", "", "prose"]);
  assert.equal(lf.sections[1].text, "## v1.1.0 — 2026-01-01 · 1 commit\n\nbody one");

  const crlf = parseChangelog(text.replace(/\n/g, "\r\n"));
  assert.deepEqual(crlf, lf, "a CRLF checkout reads the same as the LF blob it came from");
  assert.deepEqual(parseChangelog("").sections, []);
});

test("a forward render keeps the file's sections byte for byte and renders only the releases above them", () => {
  const dir = makeRepo();
  try {
    release(dir, "1.1.0", "feat: a second capability");
    release(dir, "1.2.0", "fix: the second capability's defect");

    // No file yet: the first render is the whole walk, and it is what the file starts from.
    const first = renderRepo({ root: dir });
    assert.equal(first.mode, "full");
    writeFileSync(path.join(dir, FILE), first.text, "utf8");
    assert.equal(parseChangelog(first.text).sections.length, 3);

    release(dir, "1.3.0", "feat: the capability this landing adds");
    release(dir, "1.4.0", "perf: the walk stops earlier");

    const forward = renderRepo({ root: dir });
    assert.equal(forward.mode, "forward", "a file carrying sections is rendered forward, not from the first tag");
    assert.equal(forward.kept, 3);
    assert.deepEqual(forward.rendered, ["1.4.0", "1.3.0"]);
    assert.equal(forward.releaseCount, 5);

    // The three sections the file already carried are untouched — every line, including their headings' dates.
    for (const v of ["1.2.0", "1.1.0", "1.0.0"]) {
      assert.equal(section(forward.text, v), section(first.text, v), `v${v}'s section is the file's, unchanged`);
    }

    // The two it renders are what a full render writes for those releases: same commits, same counts, same links.
    const full = renderRepo({ root: dir, full: true });
    for (const v of ["1.4.0", "1.3.0"]) {
      assert.equal(section(forward.text, v), section(full.text, v), `v${v}'s section matches the full render`);
    }
    assert.match(section(forward.text, "1.4.0"), /## v1\.4\.0 .* · 1 commit\n/);
    assert.match(section(forward.text, "1.3.0"), /- feat: the capability this landing adds/);

    // The header counts what the file carries, newest first, and says which range it spans.
    assert.match(forward.text, /5 releases from v1\.0\.0 .* to v1\.4\.0/);

    // A second run renders nothing and writes the same file: the render is idempotent.
    writeFileSync(path.join(dir, FILE), forward.text, "utf8");
    const again = renderRepo({ root: dir });
    assert.equal(again.rendered.length, 0, "a settled file has nothing above it to render");
    assert.equal(again.text, forward.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hole in the middle is filled, and the full render needs no file at all", () => {
  const dir = makeRepo();
  try {
    release(dir, "1.1.0", "feat: a second capability");
    release(dir, "1.2.0", "fix: the second capability's defect");
    const full = renderRepo({ root: dir, full: true });

    // A hand-deleted section is the same red check as a missing release (see tools/land.mjs's missingReleases):
    // the forward render has to put it back, not preserve the hole for ever.
    const withoutMiddle = full.text
      .replace(section(full.text, "1.1.0"), "")
      .replace(/\n{3,}/g, "\n\n");
    writeFileSync(path.join(dir, FILE), withoutMiddle, "utf8");

    const forward = renderRepo({ root: dir });
    assert.equal(forward.mode, "forward");
    assert.deepEqual(forward.rendered, ["1.1.0"], "the missing middle release is the only one rendered");
    assert.equal(section(forward.text, "1.1.0"), section(full.text, "1.1.0"));
    assert.equal(section(forward.text, "1.2.0"), section(full.text, "1.2.0"));
    assert.equal(section(forward.text, "1.0.0"), section(full.text, "1.0.0"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forward render of a complete file is the full render, byte for byte", () => {
  const dir = makeRepo();
  try {
    release(dir, "1.1.0", "feat: a second capability");
    release(dir, "1.2.0", "fix: the second capability's defect");
    const full = renderRepo({ root: dir, full: true });
    writeFileSync(path.join(dir, FILE), full.text, "utf8");
    const forward = renderRepo({ root: dir });
    assert.equal(forward.mode, "forward");
    assert.equal(forward.text, full.text, "keeping every section and rendering none is the full render");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a section naming a sha the ref no longer carries is rendered again, not kept", () => {
  const dir = makeRepo();
  try {
    release(dir, "1.1.0", "feat: a second capability");
    const first = renderRepo({ root: dir, full: true });
    writeFileSync(path.join(dir, FILE), first.text, "utf8");

    // A rebase merge re-creates the branch's commits with new shas: the file still names the old one, the walk has
    // the new one. Keeping that section would make the defect land.mjs refuses permanent.
    git(dir, ["commit", "--amend", "-q", "-m", "feat: a second capability, re-created by the merge"]);
    const forward = renderRepo({ root: dir });
    assert.equal(forward.mode, "forward");
    assert.deepEqual(forward.rendered, ["1.1.0"], "the section that stopped matching is the one rendered");
    assert.equal(forward.kept, 1);
    assert.match(section(forward.text, "1.1.0"), /re-created by the merge/);
    assert.equal(section(forward.text, "1.0.0"), section(first.text, "1.0.0"), "the section that still matches is kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderChangelogForward leaves the versions below the file's oldest section alone", () => {
  // The file begins at v1.50.2 while the walk starts at v0.1.0 — the shape this repository's own CHANGELOG.md had
  // when the render was repaired. Those 300 releases are history the file deliberately starts after, and a forward
  // render must not walk them: that walk is the minutes this change removes.
  const releases = [
    { version: "1.50.2", sha: "a".repeat(40), date: "2026-01-01", previous: "1.50.1", commits: [] },
    { version: "1.50.3", sha: "b".repeat(40), date: "2026-01-02", previous: "1.50.2", commits: [{ sha: "b".repeat(40), subject: "fix: one" }] },
  ];
  const sections = [{ version: "1.50.2", date: "2026-01-01", commits: 1, text: "## v1.50.2 — 2026-01-01 · 1 commit\n\nbody" }];
  const out = renderChangelogForward({ releases, sections, repoUrl: null });
  assert.deepEqual(out.rendered, ["1.50.3"]);
  assert.equal(out.kept, 1);
  assert.deepEqual(parseChangelog(out.text).sections.map((s) => s.version), ["1.50.3", "1.50.2"], "nothing below the file's oldest section is printed");
});
