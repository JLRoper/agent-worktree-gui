// What the update chip's expanded panel is told: one line per release between the build a tab is
// running and the build on disk, from CHANGELOG.md, parsed once per revision of the file.
//
// Three facts this file exists for:
//
//   1. the line is the FIRST bullet that is not under "Docs & tests" - a docs bullet is never what
//      a reader asking "what does the new build do" is shown, and a release with no other bullet
//      has no line at all (null here; the chip says "no changelog line found");
//   2. the range is (since, upto] - the running release is not news, the disk release is, and a
//      version the file has no section for yet is still listed with no line;
//   3. the parse is held against the file's mtime and size, so the page's 30 second poll cannot
//      re-read 230 KB of changelog, and a burst of callers shares one read.
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { betweenVersions, createReleaseNotes, parseReleaseNotes, versionParts } from "../lib/release-notes.js";

// The shape tools/changelog.mjs renders, with plain hyphens: this parser reads the version out of a
// heading, never the separator, so the fixture does not need the renderer's punctuation.
const CHANGELOG = [
  "# Changelog",
  "",
  "## v1.77.0 - 2026-11-09 - 4 commits",
  "",
  "[`b00d4be`](https://example.test/b00d4be) - [compare v1.76.28...v1.77.0](https://example.test/cmp)",
  "",
  "### Added",
  "",
  "- feat: the expanded chip ([`aaa1111`](https://example.test/aaa1111))",
  "- feat: a second added line ([`bbb2222`](https://example.test/bbb2222))",
  "",
  "### Docs & tests",
  "",
  "- docs: render the changelog ([`ccc3333`](https://example.test/ccc3333))",
  "",
  "## v1.76.28 - 2026-11-09 - 2 commits",
  "",
  "### Docs & tests",
  "",
  "- docs: only a doc ([`ddd4444`](https://example.test/ddd4444))",
  "",
  "### Other",
  "",
  "- chore: still housekeeping ([`eee5555`](https://example.test/eee5555))",
  "",
  "## v1.76.27 - 2026-11-08 - 1 commit",
  "",
  "### Fixed",
  "",
  "- fix: a real fix ([`fff6666`](https://example.test/fff6666))",
  "",
  "## v1.76.26 - 2026-11-08 - 1 commit",
  "",
  "### Docs & tests",
  "",
  "- test: only a test ([`999aaaa`](https://example.test/999aaaa))",
  "",
].join("\n");

test("a release's line is its first non-docs bullet, said the way a reader says it", () => {
  const notes = parseReleaseNotes(CHANGELOG);
  assert.deepEqual([...notes.keys()], ["1.77.0", "1.76.28", "1.76.27", "1.76.26"], "one entry per heading, newest first");
  assert.equal(notes.get("1.77.0"), "feat: the expanded chip (aaa1111)", "the short sha survives, the markdown does not");
  assert.equal(notes.get("1.76.28"), "chore: still housekeeping (eee5555)", "a docs group before it is skipped, not taken as the top line");
  assert.equal(notes.get("1.76.27"), "fix: a real fix (fff6666)");
});

test("a release with no non-docs bullet has no line - it is not given a docs bullet to stand in", () => {
  const notes = parseReleaseNotes(CHANGELOG);
  assert.equal(notes.get("1.76.26"), null, "a docs-and-tests-only release carries nothing a reader is owed");
  assert.equal(parseReleaseNotes("").size, 0, "an empty file is no releases, not a crash");
});

test("the range is (since, upto], newest first", () => {
  const notes = parseReleaseNotes(CHANGELOG);
  assert.deepEqual(
    betweenVersions(notes, "1.76.26", "1.77.0").map((r) => r.version),
    ["1.77.0", "1.76.28", "1.76.27"],
    "the running release is not news; every release above it, up to the disk one, is"
  );
  assert.deepEqual(betweenVersions(notes, "1.77.0", "1.77.0"), [], "the same release is an empty range");
  assert.deepEqual(betweenVersions(notes, "1.76.27", "1.76.27"), [], "a tab on the disk release has nothing to read");
  assert.deepEqual(
    betweenVersions(notes, "1.76.26", "1.77.0").map((r) => r.note),
    ["feat: the expanded chip (aaa1111)", "chore: still housekeeping (eee5555)", "fix: a real fix (fff6666)"]
  );
});

test("the build on disk is listed even before its section is rendered, with no line", () => {
  const notes = parseReleaseNotes(CHANGELOG);
  const rows = betweenVersions(notes, "1.76.27", "1.78.0");
  assert.deepEqual(rows.map((r) => r.version), ["1.78.0", "1.77.0", "1.76.28"]);
  assert.equal(rows[0].note, null, "the bump a restart would pick up has no section until the landing renders it");
});

test("a running build that named no version gets the disk release alone, never a guessed range", () => {
  const notes = parseReleaseNotes(CHANGELOG);
  for (const since of [null, "", "not-a-version"]) {
    assert.deepEqual(
      betweenVersions(notes, since, "1.76.27").map((r) => r.version),
      ["1.76.27"],
      `since ${JSON.stringify(since)} is not a range`
    );
  }
  assert.deepEqual(betweenVersions(notes, "1.76.27", "nonsense"), [], "an unreadable upto is no range at all");
  assert.deepEqual(versionParts("v1.2.3"), [1, 2, 3]);
  assert.equal(versionParts("1.2"), null);
});

test("the parse is held against the changelog's mtime, so a poll stats and slices", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-release-notes-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "CHANGELOG.md");
  await writeFile(file, CHANGELOG);
  let parses = 0;
  const notes = createReleaseNotes({
    file,
    parse: (text) => {
      parses += 1;
      return parseReleaseNotes(text);
    },
  });

  const first = await notes.between("1.76.26", "1.77.0");
  assert.equal(parses, 1, "the first read parses once");
  assert.equal(first.state, "ok");
  assert.equal(first.since, "1.76.26");
  assert.equal(first.upto, "1.77.0");
  assert.ok(!Number.isNaN(Date.parse(first.at)), "the answer names the revision it came from");

  await notes.between("1.76.26", "1.77.0");
  await notes.between("1.76.27", "1.76.28");
  assert.equal(parses, 1, "later polls read the held parse, whatever range they ask for");

  const burst = await Promise.all(Array.from({ length: 5 }, () => notes.between("1.76.26", "1.77.0")));
  assert.equal(parses, 1, "a burst of callers shares one read");
  assert.equal(burst[4].releases.length, 3);

  const later = new Date(Date.now() + 5_000);
  await utimes(file, later, later);
  await notes.between("1.76.26", "1.77.0");
  assert.equal(parses, 2, "a new mtime is a new revision, even when the bytes are the same");

  await writeFile(file, `${CHANGELOG}\n## v1.77.1 - 2026-11-09 - 1 commit\n\n### Docs & tests\n\n- docs: later (aaabbbb)\n`);
  const grown = await notes.between("1.77.0", "1.77.1");
  assert.equal(parses, 3, "a write that changes the size is a new revision");
  assert.deepEqual(grown.releases, [{ version: "1.77.1", note: null }], "the new release has no non-docs line");
});

test("a changelog that is missing or unreadable is a state, not a failed poll", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-release-notes-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const missing = await createReleaseNotes({ file: path.join(dir, "CHANGELOG.md") }).between("1.76.26", "1.77.0");
  assert.equal(missing.state, "missing");
  assert.deepEqual(missing.releases, [{ version: "1.77.0", note: null }], "the disk release is still named");

  // A directory stats fine and reads as a failure: the fallback must be the same shape.
  const unreadable = await createReleaseNotes({ file: dir, log: () => {} }).between("1.76.26", "1.77.0");
  assert.equal(unreadable.state, "unreadable");
  assert.deepEqual(unreadable.releases, [{ version: "1.77.0", note: null }]);
});
