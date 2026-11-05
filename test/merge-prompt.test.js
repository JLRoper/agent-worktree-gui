// The merging agent's script, asserted where the two rules that shape main's history live in it.
//
// Both are about what a landing leaves behind, not about how a conflict is resolved:
//   - a one-commit branch fast-forwards (or rebases and fast-forwards). A merge commit around one commit says nothing
//     the commit did not, and the old text offered that route whenever `git log --merges -5` was non-empty - which the
//     merges this panel's own landings had just made always were, so the exception fed itself.
//   - a harness and its report travel inside the change's commit, not as a stacked "add harness" commit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergePrompt } from "../lib/merge-prompt.js";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const base = {
  project: "agent-worktree-gui",
  worktree: "C:/repo/.worktrees/lane",
  root: "C:/repo",
  branch: "wtgui/lane",
  base: "main",
  remote: "origin",
  baseRef: "origin/main",
};

test("a one-commit branch is told to rebase and fast-forward, and has no merge-commit route", () => {
  const prompt = mergePrompt({ ...base, ahead: 1, commits: ["1111111 the change"] });
  assert.match(prompt, /Fast-forward first/);
  assert.match(prompt, /this branch carries ONE commit, so there is no merge-commit route here/);
  assert.match(prompt, /the rebase in \(a\) is the whole\s+answer/);
  assert.doesNotMatch(prompt, /--no-edit/, "the merge-commit command is not in front of the agent for one commit");
  assert.doesNotMatch(prompt, /more than one commit/);
});

test("a multi-commit branch may take the merge route, but only when the repo keeps merge commits", () => {
  const prompt = mergePrompt({ ...base, ahead: 3, commits: ["1111111 one", "2222222 two", "3333333 three"] });
  assert.match(prompt, /only if this repo keeps merge commits/);
  assert.match(prompt, /git log --merges -5/);
  assert.match(prompt, /merges this\s+panel's own landings made are not a policy/);
  assert.match(prompt, /git merge --no-edit wtgui\/lane/);
  assert.doesNotMatch(prompt, /carries ONE commit/);
});

test("the harness travels in the change's own commit", () => {
  const prompt = mergePrompt({ ...base, ahead: 1 });
  assert.match(prompt, /PHASE 1C - what belongs in a commit on this branch/);
  assert.match(prompt, /A verification harness, its screenshots and its report are part of the change they measure/);
  assert.match(prompt, /not a separate "add harness" or "add report" commit stacked on top/);
});

test("the prompt no longer forbids the render: it is the landing's own last step, at the merged tip", () => {
  const prompt = mergePrompt({ ...base, ahead: 1, commits: ["1111111 the change"] });
  assert.doesNotMatch(prompt, /Do NOT render the changelog on this branch/, "the instruction that left the merged tip red is gone");
  assert.match(prompt, /THE CHANGELOG IS THIS LANDING'S LAST STEP, AT THE MERGED TIP - never a follow-up row/);
  assert.match(prompt, /PHASE 4 - publish, then render at the merged tip: the landing's last step is the changelog/);
  assert.match(prompt, /npm run land/);
  assert.match(prompt, /npm run land:check/);
  assert.doesNotMatch(prompt, /git push origin main/, "the base is published by the command, not by a remembered second step");
  assert.match(prompt, /A bump commit that also carries CHANGELOG\.md folds the\s+render into the commit it describes/);
  assert.match(prompt, /\.githooks\/pre-push refuses a base push whose changelog is stale/);
});

test("the prompt states the order and why: bump, push, merge, then render at the merged tip", () => {
  const prompt = mergePrompt({ ...base, ahead: 2, commits: ["1111111 one", "2222222 two"] });
  const at = (s) => prompt.indexOf(s);
  for (const step of ["1. bump the version on wtgui/lane", "2. push wtgui/lane", "3. merge it", "4. fetch main", "5. prove it"]) {
    assert.ok(at(step) > 0, `the ordered block is missing "${step}"`);
  }
  assert.ok(at("1. bump the version on wtgui/lane") < at("2. push wtgui/lane"));
  assert.ok(at("2. push wtgui/lane") < at("3. merge it"));
  assert.ok(at("3. merge it") < at("4. fetch main"), "the render follows the merge, because the merge is what rewrites the shas");
  assert.ok(at("4. fetch main") < at("5. prove it"));
  assert.match(prompt, /The render must follow the merge because the section has to name the shas the merge's rewrite produced/);
  assert.match(prompt, /A landing\s+that stops at the merge leaves a red tip/);
});

test("an unknown count keeps the exception conditional instead of claiming one shape", () => {
  const prompt = mergePrompt({ ...base });
  assert.match(prompt, /only if this repo keeps merge commits/);
  assert.match(prompt, /more than one commit/);
  assert.doesNotMatch(prompt, /carries ONE commit/, "nothing was counted, so nothing is claimed about the count");
});

// ---------- the order, in a real repository ----------

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

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

test("a worker following the prompt's order lands a merged tip where the changelog is current", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-order-"));
  const work = path.join(dir, "work");
  try {
    mkdirSync(work, { recursive: true });
    git(work, ["init", "-q", "-b", "main"]);
    configureRepo(work);
    git(work, ["config", "core.autocrlf", "false"]);
    git(work, ["remote", "add", "github", "git@github.com:JTest/sandbox.git"]);
    copyTools(work);
    writeFileSync(path.join(work, "package.json"), `{\n  "name": "sandbox",\n  "version": "1.0.0",\n  "private": true\n}\n`, "utf8");
    writeFileSync(path.join(work, "CHANGELOG.md"), "# Changelog\n", "utf8");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "feat: the first capability, so a release has something to name"]);
    git(work, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);

    // The branch: the change, then the bump (PHASE 1B), then the render the old rule asked for.
    git(work, ["checkout", "-q", "-b", "wtgui/lane"]);
    writeFileSync(path.join(work, "feature.txt"), "the change\n", "utf8");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "feat: the change this landing carries"]);
    setVersion(work, "1.1.0");
    git(work, ["commit", "-q", "-am", "chore: 1.1.0 — the version this landing carries"]);
    git(work, ["tag", "-a", "v1.1.0", "-m", "v1.1.0"]);
    const branchRender = land(work, "--render", "--no-fetch", "--no-push");
    assert.equal(branchRender.status, 0, branchRender.text);
    git(work, ["commit", "-q", "-am", "docs: render the changelog — 2 releases"]);

    // The merge the host makes: a rebase, which re-creates every sha the branch carries.
    git(work, ["checkout", "-q", "main"]);
    writeFileSync(path.join(work, "sibling.txt"), "a sibling landing\n", "utf8");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "docs: a sibling landing moved main"]);
    git(work, ["checkout", "-q", "wtgui/lane"]);
    git(work, ["rebase", "-q", "main"]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "-q", "--ff-only", "wtgui/lane"]);

    // The case that bit us three times: the branch render names shas the rebase replaced, so the merged tip is red.
    const red = land(work, "--check", "--no-fetch");
    assert.equal(red.status, 1, red.text);
    assert.match(red.text, /land: CHANGELOG\.md is stale/);
    assert.match(red.text, /every release is named, but the text differs/);

    // The prompt's order: render at the merged tip, in the same run.
    const render = land(work, "--no-fetch", "--no-push");
    assert.equal(render.status, 0, render.text);
    assert.match(render.text, /land: committed [0-9a-f]{7} — docs: render the changelog — 2 releases/);
    assert.match(render.text, /changelog: CHANGELOG\.md is current — 2 releases/);

    const green = land(work, "--check", "--no-fetch");
    assert.equal(green.status, 0, green.text);
    assert.match(green.text, /changelog: CHANGELOG\.md is current — 2 releases/);

    // Every sha the newest section links is a commit the merged tip carries — the reader can follow them.
    const text = readFileSync(path.join(work, "CHANGELOG.md"), "utf8");
    const newest = text.slice(text.indexOf("## v1.1.0"), text.indexOf("## v1.0.0"));
    const shas = [...newest.matchAll(/commit\/([0-9a-f]{40})/g)].map((m) => m[1]);
    assert.ok(shas.length >= 2, "the newest section links its commits");
    for (const sha of shas) {
      assert.equal(
        spawnSync("git", ["-C", work, "merge-base", "--is-ancestor", sha, "HEAD"]).status,
        0,
        `${sha} is not on the merged tip`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
