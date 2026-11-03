// The version-anchor rules: where a version first appeared, and what a tag has to say about it.
//
// The walk in tools/release-history.mjs is the part a wrong implementation gets plausibly wrong — a commit that
// touches package.json without touching the version line (a new npm script) must not be read as a bump, and a
// version that lands twice must keep its FIRST appearance. tools/verify-version-tags.mjs's findings are the other
// half: a tag at the wrong commit or with no message is as misleading as no tag at all. Both are pure functions
// here, so every shape is pinned without building a repository for it; the live walk and the live gate are run
// by hand against this repo's own 205 tags.
import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, firstAppearances, parseVersionHistory, parseVersionTag } from "../tools/release-history.mjs";
import { classify, collectReleases, groupCommits, renderChangelog } from "../tools/changelog.mjs";
import { checkReleaseTags } from "../tools/verify-version-tags.mjs";

// One package.json log record, the way `git log --format=%x1e%H%x1f%ad%x1f%s -p` writes it.
function record({ sha, date = "2026-01-01", subject = "chore: work", minus = null, plus = null }) {
  const diff = ["", "diff --git a/package.json b/package.json", "--- a/package.json", "+++ b/package.json", "@@ -1,3 +1,3 @@"];
  if (minus) diff.push(`-  "version": "${minus}",`);
  if (plus) diff.push(`+  "version": "${plus}",`);
  return `\x1e${sha}\x1f${date}\x1f${subject}\n${diff.join("\n")}\n`;
}

test("a version first appears at the commit whose patch writes it, not at a later edit of the file", () => {
  const text = [
    record({ sha: "b".repeat(40), date: "2026-01-03", subject: "chore: add a script" }),
    record({ sha: "c".repeat(40), date: "2026-01-02", subject: "feat: a thing", minus: "0.1.0", plus: "0.2.0" }),
    record({ sha: "a".repeat(40), date: "2026-01-01", subject: "first commit", plus: "0.1.0" }),
  ].join("");
  const versions = parseVersionHistory(text);
  assert.deepEqual(versions.map((v) => [v.version, v.sha.slice(0, 1), v.from]), [
    ["0.1.0", "a", null],
    ["0.2.0", "c", "0.1.0"],
  ]);
});

test("a commit that only touches another package.json field is not a bump", () => {
  const text = [
    record({ sha: "b".repeat(40), subject: "chore: add a script", minus: null, plus: null }),
    record({ sha: "a".repeat(40), subject: "first commit", plus: "0.1.0" }),
  ].join("");
  assert.equal(parseVersionHistory(text).length, 1);
});

test("the same version written twice keeps its first commit as the anchor", () => {
  const text = [
    // a revert re-writes the value it had before; the anchor is still the first declaration.
    record({ sha: "c".repeat(40), subject: "fix: put it back", minus: "0.3.0", plus: "0.2.0" }),
    record({ sha: "b".repeat(40), subject: "chore: try a number", minus: "0.2.0", plus: "0.3.0" }),
    record({ sha: "a".repeat(40), subject: "feat: start", minus: "0.1.0", plus: "0.2.0" }),
  ].join("");
  const transitions = parseVersionHistory(text);
  assert.deepEqual(transitions.map((v) => [v.version, v.sha.slice(0, 1)]), [["0.2.0", "a"], ["0.3.0", "b"], ["0.2.0", "c"]]);
  const anchors = firstAppearances(transitions);
  assert.deepEqual(anchors.map((v) => [v.version, v.sha.slice(0, 1)]), [["0.2.0", "a"], ["0.3.0", "b"]]);
});

test("tags sort by number, not by string: v0.9.0 is older than v0.84.0", () => {
  assert.equal(parseVersionTag("v0.68.10"), "0.68.10");
  assert.equal(parseVersionTag("v1.2"), null);
  assert.equal(parseVersionTag("release-1.2.3"), null);
  assert.ok(compareVersions("0.9.0", "0.84.0") < 0);
  assert.ok(compareVersions("0.68.10", "0.68.9") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("the conventional prefix decides the group, and an unprefixed subject lands under Other", () => {
  assert.equal(classify("feat: a card folds"), "added");
  assert.equal(classify("fix(console): a repaint"), "fixed");
  assert.equal(classify("perf: half the work"), "performance");
  assert.equal(classify("docs: the scale"), "docs");
  assert.equal(classify("test: 47 cases"), "docs");
  assert.equal(classify("chore: bump"), "other");
  assert.equal(classify("Worktree monitor panel: the first commit"), "other");
});

test("groups print in reader order and skip the empty ones", () => {
  const commits = [
    { sha: "1", subject: "chore: later" },
    { sha: "2", subject: "fix: one" },
    { sha: "3", subject: "feat: one" },
  ];
  assert.deepEqual(groupCommits(commits).map(([key]) => key), ["added", "fixed", "other"]);
});

test("a commit two ranges share is printed by the earlier release only", () => {
  const versions = [
    { version: "0.1.0", sha: "a" },
    { version: "0.2.0", sha: "b" },
    { version: "0.3.0", sha: "c" },
  ];
  const lists = { a: [{ sha: "a1", subject: "feat: one" }], b: [{ sha: "b1", subject: "feat: two" }], c: [{ sha: "b1", subject: "feat: two" }, { sha: "c1", subject: "fix: three" }] };
  const releases = collectReleases(versions, (from, to) => lists[to]);
  assert.deepEqual(releases.map((r) => r.commits.map((c) => c.sha)), [["a1"], ["b1"], ["c1"]]);
  assert.equal(releases[2].previous, "0.2.0");
});

test("the render is newest first, grouped, and links only when there is a GitHub remote", () => {
  const releases = [
    { version: "0.1.0", sha: "a".repeat(40), date: "2026-01-01", previous: null, commits: [{ sha: "a".repeat(40), subject: "feat: start" }] },
    { version: "0.2.0", sha: "b".repeat(40), date: "2026-01-02", previous: "0.1.0", commits: [
      { sha: "b".repeat(40), subject: "feat: a thing" },
      { sha: "c".repeat(40), subject: "fix: another" },
    ] },
  ];
  const text = renderChangelog({ releases, repoUrl: "https://github.com/x/y" });
  assert.ok(text.indexOf("## v0.2.0") < text.indexOf("## v0.1.0"), "newest release comes first");
  assert.match(text, /### Added\n\n- feat: a thing/);
  assert.match(text, /### Fixed\n\n- fix: another/);
  assert.match(text, /compare v0\.1\.0\.\.\.v0\.2\.0/);
  const plain = renderChangelog({ releases, repoUrl: null });
  assert.doesNotMatch(plain, /https:\/\//);
  const cut = renderChangelog({ releases, repoUrl: null, since: "0.1.0" });
  assert.match(cut, /^# Changes since v0\.1\.0/m);
  assert.doesNotMatch(cut, /## v0\.1\.0/);
});

function history(versions) {
  return versions.map((v) => ({ version: v[0], sha: v[1], date: "2026-01-01", subject: "chore: bump", tag: v[2] }));
}

test("the gate passes only when every bump has an annotated tag at its own commit", () => {
  const versions = history([
    ["0.1.0", "a".repeat(40), { name: "v0.1.0", commit: "a".repeat(40), annotated: true }],
    ["0.2.0", "b".repeat(40), { name: "v0.2.0", commit: "b".repeat(40), annotated: true }],
  ]);
  assert.deepEqual(checkReleaseTags({ versions, orphanTags: [] }), []);
});

test("a bump with no tag, a tag at another commit, a lightweight tag and an orphan tag are all findings", () => {
  const versions = history([
    ["0.1.0", "a".repeat(40), { name: "v0.1.0", commit: "a".repeat(40), annotated: true }],
    ["0.2.0", "b".repeat(40), null],
    ["0.3.0", "c".repeat(40), { name: "v0.3.0", commit: "d".repeat(40), annotated: true }],
    ["0.4.0", "e".repeat(40), { name: "v0.4.0", commit: "e".repeat(40), annotated: false }],
  ]);
  const kinds = checkReleaseTags({ versions, orphanTags: [{ name: "v0.9.0", version: "0.9.0", commit: "f".repeat(40) }] }).map((f) => f.kind);
  assert.deepEqual(kinds, ["missing", "wrong-commit", "lightweight", "orphan-tag"]);
});

test("a number that goes backwards in history is reported even when both bumps are tagged", () => {
  const transitions = [
    { version: "0.2.0", sha: "b".repeat(40), date: "2026-01-01", subject: "chore: bump" },
    { version: "0.1.5", sha: "c".repeat(40), date: "2026-01-02", subject: "chore: bump back" },
  ];
  const versions = history([
    ["0.2.0", "b".repeat(40), { name: "v0.2.0", commit: "b".repeat(40), annotated: true }],
    ["0.1.5", "c".repeat(40), { name: "v0.1.5", commit: "c".repeat(40), annotated: true }],
  ]);
  assert.deepEqual(checkReleaseTags({ versions, transitions, orphanTags: [] }).map((f) => f.kind), ["backwards"]);
});
