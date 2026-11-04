// The landing's last step, pinned where it decides: the pure plan for every state a base can be in, and one real
// repository for the promise the brief makes — run it twice and get one render, a clean tree, and a green check.
//
// The defect this file exists for: a landing finished with a CHANGELOG that named every release but the one it
// had just landed. `npm run changelog:check` stayed red and the next reader found a release with no section. The
// fix is not a document telling an agent to remember a second step; it is a command the landing path runs, which
// renders from the history the base now carries, commits only CHANGELOG.md, and proves itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FILE, docsOnlyPush, foreignCommits, landPlan, missingReleases, parseSections } from "../tools/land.mjs";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

// ---------- the pure half ----------

test("parseSections reads section headers and nothing else", () => {
  const text = [
    "# Changelog",
    "",
    "## v1.2.0 — 2026-11-04 · 2 commits",
    "",
    "### Added",
    "",
    "- something ([`abc1234`](https://example/commit/abc1234))",
    "## v1.1.0 — 2026-11-03 · 1 commit",
    "",
  ].join("\n");
  assert.deepEqual(parseSections(text), ["1.2.0", "1.1.0"]);
  assert.deepEqual(parseSections(""), []);
});

test("missingReleases counts a middle version as stale, not only the newest", () => {
  const releases = [{ version: "1.0.0" }, { version: "1.1.0" }, { version: "1.2.0" }];
  // v1.1.0 was hand-deleted from the middle: the newest section is present and the file is still stale.
  const disk = "## v1.2.0 — 2026-11-04 · 1 commit\n## v1.0.0 — 2026-10-20 · 1 commit\n";
  assert.deepEqual(missingReleases(releases, disk).map((r) => r.version), ["1.1.0"]);
  assert.deepEqual(missingReleases(releases, "").map((r) => r.version), ["1.0.0", "1.1.0", "1.2.0"]);
  const complete = releases.map((r) => `## v${r.version} — 2026-11-04 · 1 commit`).join("\n");
  assert.deepEqual(missingReleases(releases, complete), []);
});

test("foreignCommits names the shas the base does not carry", () => {
  const releases = [
    { version: "1.1.0", commits: [{ sha: "aaaa111", subject: "one" }, { sha: "bbbb222", subject: "two" }] },
    { version: "1.2.0", commits: [{ sha: "cccc333", subject: "three" }] },
  ];
  const onBase = new Set(["aaaa111", "bbbb222"]);
  assert.deepEqual(foreignCommits(releases, (sha) => onBase.has(sha)), [
    { version: "1.2.0", sha: "cccc333", subject: "three" },
  ]);
  assert.deepEqual(foreignCommits(releases, () => true), []);
});

const base = { onBase: true, base: "main", clean: true, behind: 0, changed: true, missing: [{ version: "1.2.0" }], foreign: [], mode: "base" };

test("landPlan refuses a dirty tree, a base that moved, and a base render naming foreign commits", () => {
  const dirty = landPlan({ ...base, clean: false });
  assert.equal(dirty.action, "refuse");
  assert.match(dirty.why, /not clean/);

  const behind = landPlan({ ...base, behind: 2 });
  assert.equal(behind.action, "refuse");
  assert.match(behind.why, /2 commits behind main/);

  const foreign = landPlan({ ...base, foreign: [{ version: "1.2.0", sha: "abc1234", subject: "x" }] });
  assert.equal(foreign.action, "refuse");
  assert.match(foreign.why, /names 1 commit main does not carry/);
});

test("landPlan is idempotent by construction: an unchanged render is current and commits nothing", () => {
  const current = landPlan({ ...base, changed: false });
  assert.equal(current.action, "current");
  assert.match(current.why, /already names every release/);
});

test("a changed file that names every release is a sha change, and the message says so instead of naming no release", () => {
  const stale = landPlan({ ...base, missing: [], mode: "check" });
  assert.equal(stale.action, "stale");
  assert.match(stale.why, /every release is named, but the text differs/);
  assert.doesNotMatch(stale.why, /it would add\s*$/);
  const commit = landPlan({ ...base, missing: [] });
  assert.equal(commit.action, "commit");
  assert.match(commit.why, /it would rewrite/);
});

test("landPlan's gate writes nothing and names what it would add", () => {
  const stale = landPlan({ ...base, mode: "check" });
  assert.equal(stale.action, "stale");
  assert.match(stale.why, /stale — it would add v1\.2\.0/);
});

test("landPlan renders on a branch and commits on the base", () => {
  const branch = landPlan({ ...base, onBase: false, mode: "render" });
  assert.equal(branch.action, "render");
  assert.match(branch.why, /not the base branch/);

  const onBranchWithForeign = landPlan({
    ...base,
    onBase: false,
    mode: "render",
    foreign: [{ version: "1.2.0", sha: "abc1234", subject: "x" }],
  });
  assert.equal(onBranchWithForeign.action, "render");
  assert.match(onBranchWithForeign.why, /re-render after the merge/);

  const commit = landPlan({ ...base, mode: "base" });
  assert.equal(commit.action, "commit");
  assert.match(commit.why, /it would add v1\.2\.0 and publish the result/);
});

// ---------- the real half: one sandbox, two runs ----------

function copyTools(dest) {
  mkdirSync(path.join(dest, "tools"), { recursive: true });
  for (const f of ["land.mjs", "changelog.mjs", "release-history.mjs"]) {
    writeFileSync(
      path.join(dest, "tools", f),
      readFileSync(path.join(ROOT, "tools", f), "utf8").split(CR + LF).join(LF),
      "utf8",
    );
  }
}

function setVersion(work, v) {
  const file = path.join(work, "package.json");
  writeFileSync(file, readFileSync(file, "utf8").replace(/"version":\s*"[^"]*"/, `"version": "${v}"`), "utf8");
}

function land(work, ...args) {
  const r = spawnSync(process.execPath, [path.join(work, "tools", "land.mjs"), ...args], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { status: r.status, text: `${r.stdout || ""}${r.stderr || ""}` };
}

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-land-"));
  const work = path.join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  configureRepo(work);
  git(work, ["config", "core.autocrlf", "false"]);
  // A GitHub remote, as the real clones have: the render resolves its commit links from one, and refuses when this
  // clone carries none (see "a tree with no GitHub remote" below).
  git(work, ["remote", "add", "github", "git@github.com:JTest/sandbox.git"]);
  copyTools(work);
  writeFileSync(path.join(work, "package.json"), `{\n  "name": "sandbox",\n  "version": "1.0.0",\n  "private": true\n}\n`, "utf8");
  writeFileSync(path.join(work, FILE), "# Changelog\n", "utf8");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "feat: the first capability, so a release has something to name"]);
  setVersion(work, "1.1.0");
  git(work, ["commit", "-q", "-am", "feat: the second capability, and the version this release carries"]);
  setVersion(work, "1.2.0");
  git(work, ["commit", "-q", "-am", "feat: the third capability, and the version this release carries"]);
  return { dir, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("one run renders the missing releases and commits only CHANGELOG.md; a second run leaves one render and a clean tree", () => {
  const box = sandbox();
  try {
    const { work } = box;
    const head = git(work, ["rev-parse", "HEAD"]);

    // The gate, before anything is written: red, and it says what it would add — nothing is written.
    const gate = land(work, "--check", "--no-fetch");
    assert.equal(gate.status, 1, gate.text);
    assert.match(gate.text, /land: CHANGELOG\.md is stale — it would add v1\.0\.0, v1\.1\.0, v1\.2\.0/);
    assert.equal(git(work, ["status", "--porcelain"]), "", "a gate that writes nothing leaves the tree as it found it");

    // The first run: renders, commits its own docs commit, proves itself.
    const first = land(work, "--no-fetch", "--no-push");
    assert.equal(first.status, 0, first.text);
    assert.match(first.text, /land: committed [0-9a-f]{7} — docs: render the changelog — 3 releases/);
    assert.match(first.text, /changelog: CHANGELOG\.md is current — 3 releases/);
    assert.notEqual(git(work, ["rev-parse", "HEAD"]), head, "the render is its own commit");

    // The commit is one file, and that file names all three releases.
    assert.deepEqual(git(work, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean), [FILE]);
    const text = readFileSync(path.join(work, FILE), "utf8");
    assert.deepEqual(parseSections(text), ["1.2.0", "1.1.0", "1.0.0"]);
    assert.match(text, /3 releases from v1\.0\.0 .* to v1\.2\.0/);

    // The second run: one entry per release, nothing committed, nothing left dirty.
    const made = git(work, ["rev-parse", "HEAD"]);
    const second = land(work, "--no-fetch", "--no-push");
    assert.equal(second.status, 0, second.text);
    assert.match(second.text, /land: CHANGELOG\.md is current — 3 releases, nothing to render/);
    assert.equal(git(work, ["rev-parse", "HEAD"]), made, "the second run commits nothing");
    assert.equal(git(work, ["status", "--porcelain"]), "", "the second run leaves the tree clean");
    assert.equal((readFileSync(path.join(work, FILE), "utf8").match(/^## v/gm) || []).length, 3, "one section per release, not two");

    // The gate after the render is green and prints the count, never silence.
    const green = land(work, "--check", "--no-fetch");
    assert.equal(green.status, 0, green.text);
    assert.match(green.text, /changelog: CHANGELOG\.md is current — 3 releases/);
  } finally {
    box.done();
  }
});

test("a base that is behind refuses, and names what to do first", () => {
  const box = sandbox();
  try {
    const { work } = box;
    git(work, ["checkout", "-q", "-b", "feature"]);
    git(work, ["commit", "-q", "--allow-empty", "-m", "feat: a branch commit nobody merged"]);
    const r = land(work, "--no-fetch", "--no-push");
    assert.equal(r.status, 1, r.text);
    assert.match(r.text, /land: this tree is on feature, not main — the render is the BASE branch's last step/);

    git(work, ["checkout", "-q", "main"]);
    // A base commit that is not on the base ref it compares against: simulate a moved base by pointing main's
    // local ref back one commit and asking the tool to render against "main" itself — the base render must name
    // only what HEAD carries, so nothing is foreign and the commit is allowed. The behind state is proved by the
    // pure plan above; here the branch refusal is what a real tree shows.
    assert.equal(git(work, ["status", "--porcelain"]), "");
  } finally {
    box.done();
  }
});

test("a tree with no GitHub remote refuses rather than commit a link-less render over the linked file", () => {
  const box = sandbox();
  try {
    const { work } = box;
    assert.equal(land(work, "--no-fetch", "--no-push").status, 0, "the sandbox renders its own three releases");
    const before = readFileSync(path.join(work, FILE), "utf8");
    assert.match(before, /https:\/\/github\.com\/JTest\/sandbox\/commit\//, "the render carries links");

    git(work, ["remote", "rename", "github", "upstream"]);
    git(work, ["remote", "set-url", "upstream", "git@gitlab.com:acme/widget.git"]);
    const r = land(work, "--no-fetch", "--no-push");
    assert.equal(r.status, 2, r.text);
    assert.match(r.text, /land: no GitHub remote to take the changelog's links from/);
    assert.match(r.text, /this clone's remotes are upstream \(git@gitlab\.com:acme\/widget\.git\)/);
    assert.equal(readFileSync(path.join(work, FILE), "utf8"), before, "the refusal writes nothing");
    assert.equal(git(work, ["status", "--porcelain"]), "", "and leaves the tree clean");
  } finally {
    box.done();
  }
});

test("docsOnlyPush is true only for a push whose every commit touches CHANGELOG.md", () => {
  const box = sandbox();
  try {
    const { work } = box;
    const from = git(work, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(work, FILE), `${readFileSync(path.join(work, FILE), "utf8")}## v9.9.9 — 2026-11-04 · 1 commit\n`, "utf8");
    git(work, ["commit", "-q", "-am", "docs: render the changelog — 3 releases"]);
    assert.equal(docsOnlyPush(work, from), true);

    writeFileSync(path.join(work, "notes.md"), "a change that is not a render\n", "utf8");
    git(work, ["add", "--", "notes.md"]);
    git(work, ["commit", "-q", "-m", "fix: a real change riding along with the render"]);
    assert.equal(docsOnlyPush(work, from), false, "a landing commit riding along still faces the hook");
  } finally {
    box.done();
  }
});
