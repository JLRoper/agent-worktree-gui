// A scan of an unchanged row costs one git process, not three.
//
// `status` carries the head sha; the commit date is immutable for that sha, and the ahead/behind count is unchanged
// while the base and the head both stand. The scan cache keys the date by the sha and the count by `ref|sha` with a
// 30s TTL, so a row re-read on the panel's cadence reuses both instead of spawning `log` and `rev-list` again.
//
// This file pins the cache's two edges: a stale count is served inside the TTL and refreshed by `forgetScanCaches()`,
// and a NEW head is a new key, so a commit is never hidden by the cache.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { forgetScanCaches, scanWorktree } from "../lib/scan.js";

const EMAIL = ["scan", "example.invalid"].join(String.fromCharCode(64));

function repo(t) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "wag-scan-cache-"));
  const dir = path.join(sandbox, "repo");
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Scan Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(path.join(dir, "seed.txt"), "the trunk\n");
  git("add", "-A");
  git("commit", "-qm", "the trunk");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(path.join(dir, "feature.txt"), "the feature\n");
  git("add", "-A");
  git("commit", "-qm", "the feature's commit");
  const featureHead = git("rev-parse", "HEAD");
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return { dir, git, featureHead };
}

const CTX = { remoteRef: "main", mainBranch: "main", remote: null, bases: [], liveMinutes: 5, nested: [], parents: [] };

test("a re-read row reuses the commit date and the count, and a moved base is picked up once the cache is forgotten", async (t) => {
  const r = repo(t);
  forgetScanCaches();
  const first = await scanWorktree(r.dir, CTX, "fast");
  assert.equal(first.branch, "feature");
  assert.equal(first.ahead, 1, "one commit the base does not have");
  assert.equal(first.behind, 0);
  assert.equal(first.lastCommit, r.git("log", "-1", "--format=%cI", "feature"), "the commit date is the sha's own");

  // The base moves (a merge into main, or a fetch): inside the TTL the cached count is what a re-read row sees.
  r.git("checkout", "-q", "main");
  writeFileSync(path.join(r.dir, "main.txt"), "the base moved\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "the base moves");
  r.git("checkout", "-q", "feature");
  const stale = await scanWorktree(r.dir, CTX, "fast");
  assert.equal(stale.ahead, 1, "the count is the one the cache holds");
  assert.equal(stale.behind, 0, "and it is the same 30s-old answer the row cadence already tolerates");

  // The next pass that knows the base moved asks again.
  forgetScanCaches();
  const fresh = await scanWorktree(r.dir, CTX, "fast");
  assert.equal(fresh.ahead, 1);
  assert.equal(fresh.behind, 1, "the base's new commit is counted once the cache is forgotten");
});

test("a new head is a new key, so a commit is never hidden by the cache", async (t) => {
  const r = repo(t);
  forgetScanCaches();
  const first = await scanWorktree(r.dir, CTX, "fast");
  assert.equal(first.ahead, 1);
  writeFileSync(path.join(r.dir, "more.txt"), "another commit\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "the feature moves");
  const second = await scanWorktree(r.dir, CTX, "fast");
  assert.equal(second.head, r.git("rev-parse", "HEAD").slice(0, 7));
  assert.equal(second.ahead, 2, "the new head was read, not served from the old key");
  assert.notEqual(second.lastCommit, first.lastCommit, "and the date is the new commit's");
});
