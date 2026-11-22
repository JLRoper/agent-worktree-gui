// The parent book's cache is keyed by the branch TIP, not by the branch.
//
// Why: the 2026-11-21 log dive found the panel spawning about eight git processes a second against the fleet, and
// `warmParents` re-deriving every UNKNOWN branch on every 30s pass was a large part of it — each unresolved branch
// costs a `reflog show` (and often a `for-each-ref --merged`). The old rule also skipped a KNOWN branch for ever, so
// a rebase that moved a branch's tip never re-asked the question.
//
// This file pins the three states that matter, against a real repository:
//   1. a backfilled answer is kept while its tip stands, and re-derived once the tip moves;
//   2. an unknown answer is kept for the TTL, then re-asked;
//   3. a cached answer is not rewritten, so `checkedAt` is the moment of the last real derivation (otherwise the TTL
//      would never expire).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ParentBook, UNKNOWN_PARENT_TTL_MS } from "../lib/parents.js";

const EMAIL = ["parents", "example.invalid"].join(String.fromCharCode(64));
const T0 = 1_700_000_000_000;

function repo(t) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "wag-parents-tip-"));
  const dir = path.join(sandbox, "repo");
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Parents Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(path.join(dir, "seed.txt"), "the trunk\n");
  git("add", "-A");
  git("commit", "-qm", "the trunk");
  // A child whose reflog says where it was cut from: the KNOWN (backfilled) case.
  git("branch", "dmr-1-turnover", "main");
  git("branch", "dmr-1-child", "dmr-1-turnover");
  // A branch with no ticket id and a creation line naming main: the UNKNOWN case.
  git("branch", "loose-branch", "main");
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return { dir, git, book: new ParentBook({ file: path.join(sandbox, "parents.json") }) };
}

const tipOf = (git, branch) => git("rev-parse", branch);

test("a backfilled parent is kept while the tip stands, and re-derived when the tip moves", async (t) => {
  const r = repo(t);
  const first = await r.book.refresh({ project: "demo", repoDir: r.dir, mainBranch: "main", now: T0 });
  const child = r.book.get("demo", "dmr-1-child");
  assert.equal(child.parent, "dmr-1-turnover", "the reflog's creation line is the parent");
  assert.equal(child.parentSource, "backfilled");
  assert.equal(child.tip, tipOf(r.git, "dmr-1-child"), "the record names the tip it was derived at");
  assert.equal(child.checkedAt, T0);
  assert.ok(first.learned >= 1);

  // The same tip, a second later: no re-derivation, and no rewrite (checkedAt is the derivation's clock).
  const second = await r.book.refresh({ project: "demo", repoDir: r.dir, mainBranch: "main", now: T0 + 1_000 });
  assert.equal(r.book.get("demo", "dmr-1-child").checkedAt, T0, "a cached answer is not re-stamped");
  assert.equal(second.learned, 0, "and nothing was learned on the second pass");

  // Move the branch: a rebase/commit is a new question, so the answer is derived again at the new tip.
  r.git("checkout", "-q", "dmr-1-child");
  writeFileSync(path.join(r.dir, "work.txt"), "moved on\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "the child moves");
  r.git("checkout", "-q", "main");
  const movedTip = tipOf(r.git, "dmr-1-child");
  assert.notEqual(movedTip, child.tip);
  await r.book.refresh({ project: "demo", repoDir: r.dir, mainBranch: "main", now: T0 + 2_000 });
  const moved = r.book.get("demo", "dmr-1-child");
  assert.equal(moved.tip, movedTip, "the record follows the branch's new tip");
  assert.equal(moved.checkedAt, T0 + 2_000, "and the derivation clock moved with it");
});

test("an unknown parent is kept for the TTL, then asked again", async (t) => {
  const r = repo(t);
  await r.book.refresh({ project: "demo", repoDir: r.dir, mainBranch: "main", now: T0 });
  const loose = r.book.get("demo", "loose-branch");
  assert.equal(loose.parentSource, "unknown");
  assert.equal(loose.tip, tipOf(r.git, "loose-branch"));
  assert.equal(loose.checkedAt, T0);

  // Inside the TTL: cached, so checkedAt does not move.
  await r.book.refresh({ project: "demo", repoDir: r.dir, mainBranch: "main", now: T0 + 60_000 });
  assert.equal(r.book.get("demo", "loose-branch").checkedAt, T0, "still the first derivation");

  // Past the TTL: re-asked even though the tip never moved, because a new sibling branch can change the answer.
  await r.book.refresh({ project: "demo", repoDir: r.dir, mainBranch: "main", now: T0 + UNKNOWN_PARENT_TTL_MS + 1 });
  const again = r.book.get("demo", "loose-branch");
  assert.equal(again.checkedAt, T0 + UNKNOWN_PARENT_TTL_MS + 1);
  assert.equal(again.tip, tipOf(r.git, "loose-branch"), "the tip is unchanged, but it was asked again");
});

test("a record written before the tip field is resolved once more to earn it", async (t) => {
  const r = repo(t);
  // The pre-change shape: a known parent, no tip, no checkedAt.
  r.book.noteBackfill({ project: "demo", branch: "dmr-1-child", parent: "dmr-1-turnover", parentSha: tipOf(r.git, "dmr-1-turnover"), why: "from the old book" });
  assert.equal(r.book.get("demo", "dmr-1-child").tip, null);
  await r.book.refresh({ project: "demo", repoDir: r.dir, mainBranch: "main", now: T0 });
  const rec = r.book.get("demo", "dmr-1-child");
  assert.equal(rec.tip, tipOf(r.git, "dmr-1-child"), "the old record earned a tip");
  assert.equal(rec.checkedAt, T0);
  assert.equal(rec.parent, "dmr-1-turnover");
});
