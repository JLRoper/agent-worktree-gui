// The changelog refuses a release tag whose commit main never carried, and it refuses only the sections it writes.
//
// WHY: a section names the commit that first declared the number, and a version tag is the repository's statement
// that this number was released from that commit. When the tag sits on an unlanded branch commit - the v1.192.0 /
// v1.191.1 / v1.193.1 shape - the section links a sha no reader of main can open, and the header's claim ("anchored
// at the commit that first declared its version on main") is false the moment the file is committed. So the render
// stops, names the tag, its commit and the branch holding it, and writes nothing.
//
// The scope is the sections this run WRITES. A kept section is the file's own business and the gate's, and another
// branch's unlanded bump is not this render's claim at all: a render of main must not be blocked by a neighbour's
// draft tag, which is the difference between a rule that gets run and one that gets bypassed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const CHANGELOG = path.join(ROOT, "tools", "changelog.mjs");

const pkg = (version) => `{\n  "name": "fixture",\n  "version": "${version}"\n}\n`;

function runCli(dir) {
  const r = spawnSync(process.execPath, [CHANGELOG, "--ref", "main"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    windowsHide: true,
    timeout: 120000,
  });
  return { status: r.status, text: `${r.stdout || ""}${r.stderr || ""}` };
}

// Two releases on main, both anchored, and a GitHub remote so the links resolve. No CHANGELOG.md: the first render
// is then a full one, which is the shape whose sections are all written by this run.
function repo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-changelog-off-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "package.json"), pkg("0.1.0"), "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feat: the first capability"]);
  const first = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["tag", "-a", "v0.1.0", first, "-m", "v0.1.0"]);
  writeFileSync(path.join(dir, "package.json"), pkg("0.2.0"), "utf8");
  git(dir, ["commit", "-q", "-am", "chore: 0.2.0 - the version this landing carries"]);
  const second = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["tag", "-a", "v0.2.0", second, "-m", "v0.2.0"]);
  git(dir, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  return { dir, first, second };
}

test("a release tag on a side branch is refused, by name, and nothing is written", async (t) => {
  const { dir, first } = repo(t);
  // A second declaration of 0.2.0 on a side branch, and the tag moved onto it: the number main carries is now
  // anchored to a commit main never carried.
  git(dir, ["checkout", "-q", "-b", "wtgui/side", first]);
  writeFileSync(path.join(dir, "package.json"), pkg("0.2.0"), "utf8");
  git(dir, ["commit", "-q", "-am", "chore: 0.2.0 - the same number, declared on a branch"]);
  git(dir, ["tag", "-f", "-a", "v0.2.0", "-m", "v0.2.0"]);
  git(dir, ["checkout", "-q", "main"]);

  const r = runCli(dir);
  assert.equal(r.status, 1, r.text);
  assert.match(r.text, /refused - 1 version tag names a commit main never carried/);
  assert.match(r.text, /v0\.2\.0 at [0-9a-f]{10} \(held by wtgui\/side\)/);
  assert.equal(existsSync(path.join(dir, "CHANGELOG.md")), false, "a refused render writes no file");
});

test("a tag back on the commit main carries renders, and the top section is the version main reads", async (t) => {
  const { dir, second } = repo(t);
  git(dir, ["tag", "-f", "-a", "v0.2.0", second, "-m", "v0.2.0"]);

  const r = runCli(dir);
  assert.equal(r.status, 0, r.text);
  const text = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  const headings = [...text.matchAll(/^## v(\d+\.\d+\.\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["0.2.0", "0.1.0"], "newest first, and 0.2.0 is the version package.json reads");
  assert.match(text, /anchored by an\s+annotated tag at the commit that first declared its version on main/);
});

// The scope that keeps the rule usable in a live repository: a neighbour's unlanded bump is tagged above main's
// newest, and it is not a section this render writes, so it must not block a render of main.
test("another branch's unlanded draft tag does not block a render of main", async (t) => {
  const { dir, second } = repo(t);
  git(dir, ["checkout", "-q", "-b", "wtgui/other", second]);
  writeFileSync(path.join(dir, "package.json"), pkg("0.3.0"), "utf8");
  git(dir, ["commit", "-q", "-am", "chore: 0.3.0 - another tree's draft"]);
  git(dir, ["tag", "-a", "v0.3.0", "-m", "v0.3.0"]);
  git(dir, ["checkout", "-q", "main"]);

  const r = runCli(dir);
  assert.equal(r.status, 0, r.text);
  const text = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.match(text, /^## v0\.2\.0 /m, "main's own newest release is the top section");
  assert.doesNotMatch(text, /^## v0\.3\.0 /m, "a version main never carried gets no section");
});
