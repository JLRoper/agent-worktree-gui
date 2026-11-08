// The landing that finishes its own changelog, pinned where it decides: the refusals before anything is merged,
// the shape of the PR it reads, and one real repository with a linked tree and an origin - the command run from a
// WORKTREE (the way a landing agent runs it) merges through a stand-in gh, fast-forwards the PRIMARY checkout,
// renders there through land.mjs, and ends on `changelog --check` naming the count.
//
// The defect this file is about: `gh pr merge --rebase --admin` bypasses the pre-push render, so a landing that
// stopped at the merge left CHANGELOG.md stale at 1.53.6, at 1.60.0 through 1.60.3, at 1.65.0 and at 1.65.3.
// The fix is one command that does both, and the refusals are the part that has to happen FIRST: a merge that
// cannot be followed by its render is worse than no merge, because nobody then owns the render.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { landPrPlan, parseArgs, primaryCheckout, readPullRequest, releaseCount } from "../tools/land-pr.mjs";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const DASH = String.fromCharCode(8212); // the separator the check prints, kept out of the source on purpose

// ---------- the pure half ----------

test("parseArgs takes a number, a URL or nothing, and refuses the rest", () => {
  assert.deepEqual(parseArgs([]).pr, null);
  assert.equal(parseArgs(["412"]).pr, "412");
  assert.equal(parseArgs(["https://github.com/JLRoper/agent-worktree-gui/pull/412"]).pr, "https://github.com/JLRoper/agent-worktree-gui/pull/412");
  const opt = parseArgs(["412", "--base", "trunk", "--check", "--gh-script", "fake.mjs"]);
  assert.equal(opt.base, "trunk");
  assert.equal(opt.check, true);
  assert.equal(opt.gh, "fake.mjs");
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("readPullRequest reduces gh's view to the three facts the landing judges", () => {
  const open = readPullRequest('{"number":7,"state":"OPEN","mergeCommit":null,"baseRefName":"main","headRefName":"feature"}');
  assert.deepEqual(
    { number: open.number, state: open.state, merged: open.merged, mergeCommit: open.mergeCommit, base: open.base },
    { number: 7, state: "OPEN", merged: false, mergeCommit: null, base: "main" },
  );
  const merged = readPullRequest({ number: 7, state: "MERGED", mergeCommit: { oid: "abc1234def" }, baseRefName: "main" });
  assert.equal(merged.merged, true);
  assert.equal(merged.mergeCommit, "abc1234def");
});

test("releaseCount reads the count out of the line the check prints, and invents none", () => {
  assert.equal(releaseCount(`changelog: CHANGELOG.md is current ${DASH} 445 releases`), 445);
  assert.equal(releaseCount("changelog: CHANGELOG.md is out of date"), null);
  assert.equal(releaseCount(""), null);
});

const ok = { pr: { number: 7, state: "OPEN", base: "main", merged: false }, base: "main", primaryBranch: "main", tracked: 0, ahead: 0, behind: 2 };

test("landPrPlan merges only a checkout it could then render, and every refusal names the reason", () => {
  assert.equal(landPrPlan(ok).action, "merge");
  assert.match(landPrPlan(ok).why, /--rebase --admin/);

  const closed = landPrPlan({ ...ok, pr: { number: 7, state: "CLOSED", base: "main", merged: false } });
  assert.equal(closed.action, "refuse");
  assert.match(closed.why, /CLOSED, not MERGED/);

  const otherBase = landPrPlan({ ...ok, pr: { number: 7, state: "OPEN", base: "release", merged: false } });
  assert.match(otherBase.why, /targets release, not main/);

  const onBranch = landPrPlan({ ...ok, primaryBranch: "wtgui/somewhere" });
  assert.match(onBranch.why, /primary checkout is on wtgui\/somewhere, not main/);

  const tracked = landPrPlan({ ...ok, tracked: 2, dirtyLines: [" M package.json", "M lib/x.js"] });
  assert.match(tracked.why, /2 tracked changes \( M package\.json; M lib\/x\.js\)/);

  const ahead = landPrPlan({ ...ok, ahead: 1 });
  assert.match(ahead.why, /1 commit main does not have/);

  assert.equal(landPrPlan({ pr: null }).action, "refuse");
});

test("an already-merged PR skips the merge and leaves only the fast-forward and the render", () => {
  const merged = landPrPlan({ ...ok, pr: { number: 7, state: "MERGED", base: "main", merged: true, mergeCommit: "abc1234def" } });
  assert.equal(merged.action, "skip-merge");
  assert.match(merged.why, /already MERGED at abc1234/);
});

test("primaryCheckout names the primary checkout, not the linked tree asking", () => {
  const box = sandbox();
  try {
    assert.equal(primaryCheckout(box.linked).replace(/\\/g, "/"), box.work.replace(/\\/g, "/"));
    assert.equal(primaryCheckout(box.work).replace(/\\/g, "/"), box.work.replace(/\\/g, "/"));
  } finally {
    box.done();
  }
});

// ---------- the real half: a linked tree, an origin, and a stand-in gh ----------

function copyTools(dest) {
  mkdirSync(path.join(dest, "tools"), { recursive: true });
  for (const f of ["land.mjs", "land-pr.mjs", "changelog.mjs", "release-history.mjs", "release-tag.mjs", "verify-version-tags.mjs"]) {
    writeFileSync(
      path.join(dest, "tools", f),
      readFileSync(path.join(ROOT, "tools", f), "utf8").split(CR + LF).join(LF),
      "utf8",
    );
  }
}

// The stand-in host. `gh pr view` reads a file; `gh pr merge` does what a rebase merge does to the remote - the
// branch's commit is RE-CREATED (the same tree on a new sha, which is what a rebase does to a one-commit branch)
// and main becomes it - and flips the state to MERGED. Every call is appended to a log, so the test can assert the
// ARGUMENTS the command sends (the --rebase --admin in particular) and that a refusal sends none.
const FAKE_GH = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.LAND_PR_FAKE, "utf8"));
appendFileSync(state.log, argv.join(" ") + "\\n");
if (argv[0] === "pr" && argv[1] === "view") {
  console.log(JSON.stringify(state.view));
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "merge") {
  const { bare, branch, linked } = state.merge;
  execFileSync("git", ["-C", linked, "commit", "-q", "--amend", "--no-edit"], {
    stdio: "ignore",
    env: { ...process.env, GIT_COMMITTER_DATE: "2027-01-01T00:00:00 +0000" },
  });
  const tip = execFileSync("git", ["-C", linked, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", linked, "push", "-q", bare, branch + ":refs/heads/main"], { stdio: "ignore" });
  const next = { ...state, view: { ...state.view, state: "MERGED", mergeCommit: { oid: tip } } };
  writeFileSync(process.env.LAND_PR_FAKE, JSON.stringify(next, null, 2));
  console.log("merged " + tip);
  process.exit(0);
}
console.error("fake gh: unsupported " + argv.join(" "));
process.exit(2);
`;

function sandbox(view = { state: "OPEN", mergeCommit: null }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-land-pr-"));
  const bare = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  const linked = path.join(dir, "linked");
  mkdirSync(work, { recursive: true });
  git(dir, ["init", "-q", "--bare", "-b", "main", bare]);
  git(dir, ["init", "-q", "-b", "main", work]);
  configureRepo(work);
  git(work, ["config", "core.autocrlf", "false"]);
  git(work, ["remote", "add", "origin", bare.replace(/\\/g, "/")]);
  // A GitHub remote for the render's links: the base's file carries them and changelog.mjs refuses without one.
  git(work, ["remote", "add", "github", "git@github.com:JTest/sandbox.git"]);
  copyTools(work);
  writeFileSync(path.join(work, "package.json"), `{\n  "name": "sandbox",\n  "version": "1.0.0",\n  "private": true\n}\n`, "utf8");
  writeFileSync(path.join(work, "CHANGELOG.md"), "# Changelog\n", "utf8");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "feat: the first capability, so a release has something to name"]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  git(work, ["checkout", "-q", "-b", "feature"]);
  const pkg = path.join(work, "package.json");
  writeFileSync(pkg, readFileSync(pkg, "utf8").replace(/"version":\s*"[^"]*"/, '"version": "1.1.0"'), "utf8");
  git(work, ["commit", "-q", "-am", "feat: the capability this landing carries, and its version"]);
  // The claim `version.mjs apply` makes: an annotated v<version> on the branch's bump commit, pushed so every lane
  // reads the number as taken. A rebase merge re-creates that commit, and this is the tag it orphans.
  git(work, ["tag", "-a", "v1.1.0", "-m", "v1.1.0"]);
  git(work, ["push", "-q", "origin", "feature"]);
  git(work, ["push", "-q", "origin", "refs/tags/v1.1.0"]);
  // The primary goes back to the base before the linked tree takes the branch: the landing runs FROM a worktree
  // and renders IN the primary checkout, which is the whole shape of the command.
  git(work, ["checkout", "-q", "main"]);
  git(work, ["worktree", "add", "-q", linked, "feature"]);

  const stateFile = path.join(dir, "gh.json");
  const log = path.join(dir, "gh.log");
  writeFileSync(log, "", "utf8");
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        view: { number: 7, url: "https://github.com/JTest/sandbox/pull/7", baseRefName: "main", headRefName: "feature", ...view },
        merge: { work, bare, linked, branch: "feature" },
        log,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(path.join(dir, "fake-gh.mjs"), FAKE_GH.trimStart(), "utf8");

  return {
    dir,
    work,
    linked,
    stateFile,
    log,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    run: (...args) =>
      spawnSync(process.execPath, [path.join(linked, "tools", "land-pr.mjs"), ...args], {
        cwd: linked,
        encoding: "utf8",
        env: { ...process.env, LAND_PR_FAKE: stateFile, GIT_TERMINAL_PROMPT: "0" },
        windowsHide: true,
      }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("one run from the worktree merges, fast-forwards the primary checkout, renders there and prints the count", () => {
  const box = sandbox();
  try {
    const before = git(box.work, ["rev-parse", "main"]);
    const r = box.run("7", "--gh-script", path.join(box.dir, "fake-gh.mjs"));
    const text = `${r.stdout || ""}${r.stderr || ""}`;
    assert.equal(r.status, 0, text);

    // The merge was asked for with the admin bypass, which is what this repo's ruleset requires and what bypasses
    // the pre-push render - the reason the render has to ride in the same command.
    assert.ok(box.calls().includes("pr merge 7 --rebase --admin"), box.calls().join("\n"));
    assert.match(text, /land-pr: PR #7 is MERGED - merge commit [0-9a-f]{7}/);
    assert.match(text, /fast-forwarded [0-9a-f]{7} -> [0-9a-f]{7}/);
    assert.match(text, /changelog --check reads current - 2 releases/);

    // The primary checkout moved, and its tip is the landing plus its render - one CHANGELOG.md commit, pushed.
    const head = git(box.work, ["rev-parse", "HEAD"]);
    assert.notEqual(head, before);
    assert.equal(git(box.work, ["rev-parse", "origin/main"]), head, "the render is pushed");
    assert.deepEqual(git(box.work, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean), ["CHANGELOG.md"]);
    assert.equal(git(box.work, ["status", "--porcelain", "-uno"]), "");

    // The file the check just called current names the release the landing carried.
    const changelog = readFileSync(path.join(box.work, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /## v1\.1\.0 /);
    assert.match(changelog, /2 releases from v1\.0\.0/);

    // A second run is idempotent: the PR reads MERGED, the checkout is at the tip, and nothing is committed twice.
    const again = box.run("7", "--gh-script", path.join(box.dir, "fake-gh.mjs"));
    const againText = `${again.stdout || ""}${again.stderr || ""}`;
    assert.equal(again.status, 0, againText);
    assert.match(againText, /already MERGED|is MERGED/);
    assert.match(againText, /changelog --check reads current - 2 releases/);
    assert.equal(git(box.work, ["rev-parse", "HEAD"]), head, "the second run commits nothing");
    assert.equal(box.calls().filter((l) => l.startsWith("pr merge")).length, 1, "the second run merges nothing");
  } finally {
    box.done();
  }
});

test("a refused landing merges nothing, and says why before it touches the tip", () => {
  const box = sandbox({ state: "CLOSED" });
  try {
    const before = git(box.work, ["rev-parse", "origin/main"]);
    const r = box.run("7", "--gh-script", path.join(box.dir, "fake-gh.mjs"));
    const text = `${r.stdout || ""}${r.stderr || ""}`;
    assert.equal(r.status, 1, text);
    assert.match(text, /land-pr: refused - PR #7 is CLOSED, not MERGED/);
    assert.deepEqual(box.calls(), ["pr view 7 --json number,url,state,mergeCommit,baseRefName,headRefName"]);
    assert.equal(git(box.work, ["rev-parse", "origin/main"]), before);
  } finally {
    box.done();
  }
});

test("--check judges only: it merges nothing and writes nothing", () => {
  const box = sandbox();
  try {
    const before = git(box.work, ["rev-parse", "origin/main"]);
    const r = box.run("7", "--check", "--gh-script", path.join(box.dir, "fake-gh.mjs"));
    const text = `${r.stdout || ""}${r.stderr || ""}`;
    assert.equal(r.status, 0, text);
    assert.match(text, /PR #7 reads OPEN/);
    assert.match(text, /would proceed - PR #7 would be merged with --rebase --admin/);
    assert.equal(box.calls().filter((l) => l.startsWith("pr merge")).length, 0);
    assert.equal(git(box.work, ["rev-parse", "origin/main"]), before);
    assert.equal(readFileSync(path.join(box.work, "CHANGELOG.md"), "utf8"), "# Changelog\n");
  } finally {
    box.done();
  }
});

test("the primary checkout's own untracked artifacts do not stop the render, and the commit is still one file", () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.work, "config.7330.json"), "{}\n", "utf8");
    appendFileSync(path.join(box.work, "local-note.md"), "another run's artifact\n", "utf8");
    const r = box.run("7", "--gh-script", path.join(box.dir, "fake-gh.mjs"));
    const text = `${r.stdout || ""}${r.stderr || ""}`;
    assert.equal(r.status, 0, text);
    assert.match(text, /2 untracked files left alone/);
    assert.match(text, /changelog --check reads current - 2 releases/);
    assert.deepEqual(git(box.work, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean), ["CHANGELOG.md"]);
    assert.equal(readFileSync(path.join(box.work, "config.7330.json"), "utf8"), "{}\n", "the stray file is not touched");
  } finally {
    box.done();
  }
});

// The commit origin's v<version> tag peels to — the `^{}` line, which is the one a reader (and the gate) follows.
function peeled(box, name = "v1.1.0") {
  const exact = new RegExp(`refs/tags/${name.replace(/\./g, "\\.")}(\\^\\{\\})?$`);
  const lines = git(box.work, ["ls-remote", "--tags", "origin"])
    .split("\n")
    .filter(Boolean)
    .filter((l) => exact.test(l.split(/\s+/)[1] || ""));
  const line = lines.find((l) => l.endsWith("^{}")) || lines[lines.length - 1] || "";
  return line.split(/\s+/)[0] || "";
}

test("the landing moves the release tag onto the commit the rebase merge produced, with no hand step", () => {
  const box = sandbox();
  try {
    const claimed = git(box.linked, ["rev-parse", "HEAD"]);
    assert.equal(peeled(box), claimed, "the fixture starts where a real branch does: the claim is on the pre-merge sha");

    const r = box.run("7", "--gh-script", path.join(box.dir, "fake-gh.mjs"));
    const text = `${r.stdout || ""}${r.stderr || ""}`;
    assert.equal(r.status, 0, text);

    const merged = JSON.parse(readFileSync(box.stateFile, "utf8")).view.mergeCommit.oid;
    assert.notEqual(merged, claimed, "a rebase merge re-creates the bump commit under a new sha");
    assert.match(text, /land-pr: moved [0-9a-f]{10} -> [0-9a-f]{10} on origin \(--force\)/);
    assert.match(text, new RegExp(`land-pr: done .*tag v1\\.1\\.0 at ${merged.slice(0, 7)}`));
    assert.equal(peeled(box), merged, "origin's tag names the merged commit, not the branch's pre-merge one");

    // The second run finds the anchor right: nothing is force-pushed, nothing is merged, nothing is committed.
    const tip = git(box.work, ["rev-parse", "HEAD"]);
    const again = box.run("7", "--gh-script", path.join(box.dir, "fake-gh.mjs"));
    const againText = `${again.stdout || ""}${again.stderr || ""}`;
    assert.equal(again.status, 0, againText);
    assert.match(againText, /land-pr: v1\.1\.0 is already at [0-9a-f]{10} on origin/);
    assert.equal(peeled(box), merged);
    assert.equal(git(box.work, ["rev-parse", "HEAD"]), tip);
  } finally {
    box.done();
  }
});
