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
import { applyPins, checkReleaseTags, parsePins } from "../tools/verify-version-tags.mjs";

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

test("a tag for a version this ref has not carried yet is held, not a finding, when its own commit declares it", () => {
  const versions = history([["1.0.0", "a".repeat(40), { name: "v1.0.0", commit: "a".repeat(40), annotated: true }]]);
  const held = { name: "v1.1.0", version: "1.1.0", commit: "b".repeat(40), declares: true };
  assert.deepEqual(checkReleaseTags({ versions, orphanTags: [held] }), [], "a live branch's pre-landing anchor is not a false claim");
});

test("a tag whose own commit does not declare the version is still an orphan", () => {
  const versions = history([["1.0.0", "a".repeat(40), { name: "v1.0.0", commit: "a".repeat(40), annotated: true }]]);
  const findings = checkReleaseTags({ versions, orphanTags: [{ name: "v1.2.0", version: "1.2.0", commit: "c".repeat(40), declares: false }] });
  assert.deepEqual(findings.map((f) => f.kind), ["orphan-tag"]);
  assert.match(findings[0].message, /does not declare 1\.2\.0/);
});

test("a landed version whose tag points at another commit is still wrong-commit", () => {
  const versions = history([
    ["1.0.0", "a".repeat(40), { name: "v1.0.0", commit: "a".repeat(40), annotated: true }],
    ["1.1.0", "b".repeat(40), { name: "v1.1.0", commit: "c".repeat(40), annotated: true, declares: true }],
  ]);
  assert.deepEqual(checkReleaseTags({ versions, orphanTags: [] }).map((f) => f.kind), ["wrong-commit"]);
});

test("a held tag still has to carry a message: a lightweight one is a finding", () => {
  const versions = history([["1.0.0", "a".repeat(40), { name: "v1.0.0", commit: "a".repeat(40), annotated: true }]]);
  const held = { name: "v1.1.0", version: "1.1.0", commit: "b".repeat(40), declares: true, annotated: false };
  assert.deepEqual(checkReleaseTags({ versions, orphanTags: [held] }).map((f) => f.kind), ["lightweight"]);
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

// A commit's own patch is the transition that happened. The walk's previous entry is the previous entry in
// commit-date order, which across a merge is a SIBLING LANE, not this commit's parent: v1.76.12 was read as a
// decrease because the 1.76.13 lane's bump commit was authored 26 seconds earlier, while v1.76.12's own patch read
// 1.76.11 -> 1.76.12 and main's first-parent chain read 1.76.11 -> 1.76.12 -> 1.76.13. When the walk recorded both
// sides of the version line the finding follows them; the neighbour is only the fallback, so a commit whose patch
// shows no replaced line loses no check.
test("a decrease is read from the commit's own patch, not from the walk's previous entry", () => {
  const tag = (sha) => ({ name: "v", commit: sha, annotated: true });
  const lane = [
    { version: "1.76.13", sha: "a".repeat(40), date: "2026-11-09", subject: "chore: 1.76.13", read: "1.76.12", tag: tag("a".repeat(40)) },
    { version: "1.76.12", sha: "b".repeat(40), date: "2026-11-09", subject: "perf: a lane", read: "1.76.11", tag: tag("b".repeat(40)) },
  ];
  assert.deepEqual(
    checkReleaseTags({ versions: lane, transitions: lane }).map((f) => f.kind),
    [],
    "the lane merged in beside this commit read a higher number; the commit's own patch went up",
  );

  const hotfix = [
    { version: "1.170.0", sha: "a".repeat(40), date: "2026-11-24", subject: "chore: 1.170.0", read: "1.169.8", tag: tag("a".repeat(40)) },
    { version: "1.169.9", sha: "b".repeat(40), date: "2026-11-24", subject: "perf: a hotfix", read: "1.170.0", tag: tag("b".repeat(40)) },
  ];
  const found = checkReleaseTags({ versions: hotfix, transitions: hotfix });
  assert.deepEqual(found.map((f) => [f.kind, f.from, f.version]), [["backwards", "1.170.0", "1.169.9"]]);

  const noReplacedLine = [
    { version: "2.0.0", sha: "a".repeat(40), date: "2026-11-24", subject: "chore: 2.0.0", read: null, tag: tag("a".repeat(40)) },
    { version: "1.9.0", sha: "b".repeat(40), date: "2026-11-24", subject: "chore: 1.9.0", read: null, tag: tag("b".repeat(40)) },
  ];
  assert.deepEqual(
    checkReleaseTags({ versions: noReplacedLine, transitions: noReplacedLine }).map((f) => f.kind),
    ["backwards"],
    "no replaced line in the patch leaves the neighbour as the only reading there is",
  );
});

// A pin is a written decision about ONE finding: it stops that finding failing, and it names no other. A pin
// whose finding is gone is stale, which the gate reports as a failure - the property that lets the file describe
// history without ever hiding the next defect of the same shape.
test("a pin covers its own finding and no other, and a pin that names nothing is stale", () => {
  const one = { kind: "missing", version: "1.0.0", sha: "a".repeat(40), message: "v1.0.0 is not tagged" };
  const two = { kind: "missing", version: "1.1.0", sha: "b".repeat(40), message: "v1.1.0 is not tagged" };
  const pin = { kind: "missing", version: "1.0.0", sha: "a".repeat(40), reason: "landed on main with no tag, waiting on a tag write", repair: "git tag -a v1.0.0 aaaaaaaa" };

  const applied = applyPins([one, two], [pin]);
  assert.deepEqual(applied.live.map((f) => f.version), ["1.1.0"], "an unpinned neighbour still fails");
  assert.deepEqual(applied.pinned.map((f) => [f.version, f.reason, f.repair]), [["1.0.0", pin.reason, pin.repair]]);
  assert.deepEqual(applied.stale, []);

  assert.deepEqual(applyPins([two], [pin]).stale.map((p) => p.version), ["1.0.0"], "nothing left to name: the pin must go");

  // A wrong anchor's identity carries the commit the tag points at: a tag moved onto a DIFFERENT wrong commit is
  // a new finding, not the pinned one riding along on the same number.
  const wrong = { kind: "wrong-commit", version: "1.0.0", sha: "a".repeat(40), tagCommit: "c".repeat(40) };
  const wrongPin = { ...pin, kind: "wrong-commit", tagCommit: "c".repeat(40) };
  assert.equal(applyPins([wrong], [wrongPin]).pinned.length, 1);
  assert.deepEqual(applyPins([{ ...wrong, tagCommit: "d".repeat(40) }], [wrongPin]).live.map((f) => f.version), ["1.0.0"]);
});

test("the pin file is validated: a bad kind, a short sha, a wording-free reason and a missing tagCommit are each refused by name", () => {
  const sha = "a".repeat(40);
  const good = "landed on main in 2026-11 with no tag and no published anchor";
  const bad = parsePins(JSON.stringify({
    pins: [
      { kind: "nonsense", version: "1.0.0", sha, reason: good },
      { kind: "missing", version: "1.0.0", sha: "abc", reason: good },
      { kind: "missing", version: "1.0.0", sha, reason: "pinned" },
      { kind: "wrong-commit", version: "1.0.0", sha, reason: good },
      { kind: "missing", version: "1.0.0", sha, reason: good },
      { kind: "missing", version: "1.0.0", sha, reason: good },
    ],
  }), { file: "pins.json" });
  assert.equal(bad.pins.length, 0, "one bad pin does not let the rest through");
  const text = bad.problems.join("\n");
  assert.match(text, /pins\[0\]: kind "nonsense" is not one of/);
  assert.match(text, /pins\[1\]: sha must be the full 40-character commit/);
  assert.match(text, /pins\[2\]: reason must say what the finding is/);
  assert.match(text, /pins\[3\]: a wrong-commit pin must name the tagCommit/);
  assert.match(text, /pins\[5\]: a second pin for the same finding/);
  assert.deepEqual(parsePins("{", { file: "pins.json" }).problems.length, 1);
  assert.deepEqual(parsePins("[]", { file: "pins.json" }).problems, ["pins.json: the file must be one JSON object with a \"pins\" array"]);
});
