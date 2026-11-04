// The landing gate has one job, and it used to fail open at exactly the moment it was needed.
//
// Measured on this repo's own tool: a worktree at 0.84.0 with origin/main at 0.87.0 ran `check`, printed nothing
// and exited 0 — a branch that is merely behind passed as if it had bumped. Two causes, both pinned here: the
// branch with no commits of its own returned 0 before reading anything, and any value that was merely NOT EQUAL
// to the base's counted as a bump, so "behind" read as "bumped".
//
// This file builds one repository with one bare remote and proves the three states in that one tree:
//   1. unchanged against the base, with commits to land  -> refused
//   2. bumped above the base                             -> allowed, and it prints both numbers
//   3. behind the base with no bump                      -> refused, and it names the base's number
// The base's version must come from origin/main's CURRENT tree (case 3's base moved after the branch was cut), and
// the branch's from HEAD, so an uncommitted bump is not a pass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function copyTool(dest) {
  mkdirSync(path.join(dest, "tools"), { recursive: true });
  for (const f of ["version.mjs", "release-history.mjs"]) {
    writeFileSync(
      path.join(dest, "tools", f),
      readFileSync(path.join(ROOT, "tools", f), "utf8").split(CR + LF).join(LF),
      "utf8",
    );
  }
}

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-vcheck-"));
  const work = path.join(dir, "work");
  const remote = path.join(dir, "remote.git");
  mkdirSync(work, { recursive: true });
  git(dir, ["init", "-q", "--bare", "-b", "main", remote]);
  git(work, ["init", "-q", "-b", "main"]);
  configureRepo(work);
  git(work, ["config", "core.autocrlf", "false"]);
  copyTool(work);
  writeFileSync(path.join(work, "package.json"), `{\n  "name": "sandbox",\n  "version": "1.0.0",\n  "private": true\n}\n`, "utf8");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "Add the manifest so the version has one home"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  return { dir, work, remote, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function commit(work, rel, text, subject) {
  const p = path.join(work, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
  git(work, ["add", "--", rel]);
  git(work, ["commit", "-q", "-m", subject]);
}

function setVersion(work, v) {
  const file = path.join(work, "package.json");
  writeFileSync(file, readFileSync(file, "utf8").replace(/"version":\s*"[^"]*"/, `"version": "${v}"`), "utf8");
}

// Run the gate the way a landing agent and the pre-push hook do: from inside the tree, offline.
function check(work) {
  const r = spawnSync(process.execPath, [path.join(work, "tools", "version.mjs"), "check"], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, VERSION_NO_GH: "1", GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { status: r.status, text: `${r.stdout || ""}${r.stderr || ""}` };
}

test("check refuses unchanged, allows bumped, and refuses behind — in one tree", () => {
  const box = sandbox();
  try {
    const { work } = box;
    const cut = git(work, ["rev-parse", "HEAD"]);

    // main moves on without this branch: origin/main's version becomes 1.1.0 while the branch sits at 1.0.0.
    setVersion(work, "1.1.0");
    git(work, ["commit", "-q", "-am", "Bump the version to 1.1.0 on main"]);
    git(work, ["push", "-q", "origin", "main"]);
    const base = git(work, ["rev-parse", "origin/main"]);
    assert.equal(JSON.parse(git(work, ["show", "origin/main:package.json"])).version, "1.1.0");

    // ---- 1. unchanged against the base, carrying a commit of its own: refused ----
    git(work, ["checkout", "-q", "-b", "unbumped"]);
    commit(work, "docs/notes.md", "the layout\n", "docs: describe how the panel reads its own layout");
    const unchanged = check(work);
    assert.equal(unchanged.status, 1, `unchanged must be refused\n${unchanged.text}`);
    assert.match(unchanged.text, /version check: refused/);
    assert.match(unchanged.text, /branch\s+1\.1\.0\s+\(HEAD's package\.json\)/);
    assert.match(unchanged.text, new RegExp(`base\\s+origin/main\\s+1\\.1\\.0\\s+\\(${base.slice(0, 7)}`));

    // ---- an uncommitted bump is not a bump: HEAD is what a push carries ----
    // Written straight into the file (not through `apply`, which commits and tags its own write): the point is a
    // number that exists only in the working tree.
    setVersion(work, "1.2.0");
    const uncommitted = check(work);
    assert.equal(uncommitted.status, 1, `an uncommitted bump must not pass\n${uncommitted.text}`);
    assert.match(uncommitted.text, /working tree's package\.json reads 1\.2\.0/);
    assert.match(uncommitted.text, /branch\s+1\.1\.0\s+\(HEAD's package\.json\)/);

    // ---- 2. bumped above the base: allowed, and it says what it compared ----
    git(work, ["commit", "-q", "-am", "Bump the version to 1.2.0 for the layout doc, a doc-only change"]);
    const bumped = check(work);
    assert.equal(bumped.status, 0, `a bump above the base must pass\n${bumped.text}`);
    assert.match(bumped.text, /version check: ok/);
    assert.match(bumped.text, /branch\s+1\.2\.0\s+\(HEAD's package\.json\)/);
    assert.match(bumped.text, /base\s+origin\/main\s+1\.1\.0/);
    assert.notEqual(bumped.text.trim(), "", "a pass must never be silent");

    // ---- 3. behind the base with no bump at all: refused, and it names the base's number ----
    git(work, ["checkout", "-q", "-b", "behind", cut]);
    assert.equal(JSON.parse(readFileSync(path.join(work, "package.json"), "utf8")).version, "1.0.0");
    const behind = check(work);
    assert.equal(behind.status, 1, `a branch behind main must be refused\n${behind.text}`);
    assert.match(behind.text, /version check: refused — this branch's version is behind origin\/main's/);
    assert.match(behind.text, /branch\s+1\.0\.0\s+\(HEAD's package\.json\)/);
    assert.match(behind.text, /base\s+origin\/main\s+1\.1\.0/);
    assert.match(behind.text, /then bump above 1\.1\.0 in this PR/);

    // ---- and the same branch with commits, still behind: refused too ----
    commit(work, "chart.js", "export const columns = 9;\n", "fix: stop the chart squeezing ten columns onto one row");
    const behindCommits = check(work);
    assert.equal(behindCommits.status, 1, `behind with commits must be refused\n${behindCommits.text}`);
    assert.match(behindCommits.text, /is behind origin\/main's/);
    assert.match(behindCommits.text, /fix: stop the chart squeezing ten columns onto one row/);

    // ---- main itself: nothing to land, and the pass still says what it compared ----
    git(work, ["checkout", "-q", "main"]);
    const onMain = check(work);
    assert.equal(onMain.status, 0, onMain.text);
    assert.match(onMain.text, /nothing to land, so nothing to bump/);
    assert.match(onMain.text, /branch\s+1\.1\.0/);
    assert.match(onMain.text, /base\s+origin\/main\s+1\.1\.0/);
  } finally {
    box.done();
  }
});

test("check refuses rather than passing when it cannot name the base", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-vcheck-nobase-"));
  try {
    const work = path.join(dir, "work");
    copyTool(work);
    writeFileSync(path.join(work, "package.json"), `{\n  "name": "sandbox",\n  "version": "1.0.0"\n}\n`, "utf8");
    git(work, ["init", "-q", "-b", "trunk"]);
    configureRepo(work);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "Add the manifest"]);
    // No remote, and no main/master: there is nothing to compare against, so the gate must not answer "fine".
    const r = check(work);
    assert.equal(r.status, 1, `no base must refuse, not pass\n${r.text}`);
    assert.match(r.text, /nothing was compared/);
    assert.match(r.text, /check --base origin\/main/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
