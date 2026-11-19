// A project can have more than one BASE BRANCH, and each row is judged against its own.
//
// fleet-kafka has no main: dev, qa, uat and prod are long-lived base branches. The board used to compare every row
// of a project against one `<remote>/<mainBranch>` ref, so every fleet-kafka row read NO BASE REF and its ahead and
// behind figures were empty. This fixture builds that shape for real - a bare origin with four environment branches
// and no main, plus one configured environment whose branch does not exist - and scans trees against it, so the
// ordering (recorded parent, then the environment in the tree or branch name, then the project's single base), the
// counts and the verdict word are proved from git rather than from the rule in isolation.
//
// The single-branch project is the control: with no list it must read exactly as it did before this rule existed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { baseBranchesFrom, branchOfRef, envIn, envOfBranchName, isOnBase, onBaseVerdict, rowBaseCandidates } from "../lib/base-branches.js";
import { scanWorktree } from "../lib/scan.js";
import { git, sliceRegion } from "../tools/panel-testkit.mjs";

const commit = (dir, file, body, message) => {
  writeFileSync(path.join(dir, file), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
};

test("the list reads every shape a reader writes, and drops what is not a branch", () => {
  assert.deepEqual(baseBranchesFrom([{ branch: "dev", env: "dev" }, { branch: "qa", env: "QA" }]), [
    { branch: "dev", env: "dev" },
    { branch: "qa", env: "qa" },
  ]);
  // A plain list names each branch its own environment; a qualified name loses the ref prefix.
  assert.deepEqual(baseBranchesFrom(["dev", "refs/heads/release/prod"]), [
    { branch: "dev", env: "dev" },
    { branch: "release/prod", env: "prod" },
  ]);
  // env -> branch
  assert.deepEqual(baseBranchesFrom({ uat: "origin/uat" }), [{ branch: "origin/uat", env: "uat" }]);
  // A repeat is one entry, and a hand-editing mistake does not become a git argument.
  assert.deepEqual(baseBranchesFrom([{ branch: "dev", env: "dev" }, { branch: "DEV", env: "other" }, { branch: "two words" }, null, 7]), [
    { branch: "dev", env: "dev" },
  ]);
  assert.deepEqual(baseBranchesFrom(undefined), []);
  assert.equal(envOfBranchName("release/uat"), "uat");
});

test("the environment is a word, matched rightmost, not a substring", () => {
  const bases = baseBranchesFrom(["dev", "qa", "uat", "prod"]);
  assert.equal(envIn("fleet-kafka-prod", bases)?.env, "prod");
  assert.equal(envIn("fix-qa-2", bases)?.env, "qa");
  // `devops` is not `dev`, and a second environment of the same name is.
  assert.equal(envIn("devops", bases), null);
  assert.equal(envIn("dev2", bases)?.env, "dev");
  // A promotion branch names two environments: the target is the one written last.
  assert.equal(envIn("promote-uat-to-prod", bases)?.env, "prod");
  // The branch is the row's identity, so it wins over the folder when they disagree.
  assert.equal(
    envIn("feature/x-dev", bases)?.env,
    "dev",
  );
});

test("the candidate order is parent, then environment, then the single base", () => {
  const bases = baseBranchesFrom([{ branch: "dev", env: "dev" }, { branch: "qa", env: "qa" }, { branch: "prod", env: "prod" }]);
  const common = { bases, remote: "origin", mainBranch: "main", fallbackRef: "origin/main" };

  // A recorded parent that IS a base wins, even when the tree's own name says another environment.
  assert.deepEqual(
    rowBaseCandidates({ ...common, parent: "dev", branch: "fleet-kafka-qa", treeName: "fleet-kafka-qa" }).map((c) => [c.ref, c.source]),
    [["origin/dev", "parent"], ["origin/qa", "env"], ["origin/main", "default"]],
  );
  // A parent that is NOT a base of this project is skipped: a tree cut from a feature branch, or from a turnover
  // branch, must still be measured against the base its work would land on.
  assert.deepEqual(
    rowBaseCandidates({ ...common, parent: "feature/optym-turnover", branch: "wtgui/abc123", treeName: "tree-1" }).map((c) => [c.ref, c.source]),
    [["origin/main", "default"]],
  );
  // No parent: the tree name names the environment.
  assert.deepEqual(
    rowBaseCandidates({ ...common, branch: "wtgui/abc123", treeName: "fleet-kafka-uat", bases: baseBranchesFrom(["dev", "uat"]) }).map((c) => [c.ref, c.source]),
    [["origin/uat", "env"], ["origin/main", "default"]],
  );
  // A parent whose own name carries an environment inherits that base (a legacy tree with no exact parent record).
  assert.deepEqual(
    rowBaseCandidates({ ...common, parent: "feature/x-qa", branch: "wtgui/abc123", treeName: "tree-1" }).map((c) => [c.ref, c.source]),
    [["origin/qa", "parent"], ["origin/main", "default"]],
  );
  // Nothing to resolve, no fallback: an empty list, and the scan says NO BASE REF for that row.
  assert.deepEqual(rowBaseCandidates({ branch: "wtgui/abc123", treeName: "tree-1" }), []);
  // The same ref is offered once, however it was reached.
  assert.deepEqual(
    rowBaseCandidates({ ...common, bases: baseBranchesFrom([{ branch: "main", env: "main" }]), fallbackRef: "origin/main" }).map((c) => c.ref),
    ["origin/main"],
  );
  assert.equal(branchOfRef("origin/feature/x", "origin"), "feature/x");
  assert.equal(branchOfRef("feature/x", "origin"), "feature/x");
});

test("standing on a base keeps ON MAIN for main, and says ON BASE for any other", () => {
  assert.equal(onBaseVerdict({ branch: "main", baseBranch: "main", mainBranch: "main" }), "ON MAIN");
  assert.equal(onBaseVerdict({ branch: "dev", baseBranch: "dev", mainBranch: "main" }), "ON BASE");
  assert.equal(onBaseVerdict({ branch: "feature/x", baseBranch: "dev", mainBranch: "main" }), null);
  assert.equal(isOnBase("ON BASE"), true);
  assert.equal(isOnBase("ON MAIN"), true);
  assert.equal(isOnBase("UNMERGED (1 commit)"), false);
});

// A project whose environments are four long-lived branches and which has no main at all, plus one configured
// environment whose branch is missing. Returns the paths the scan and the assertions need.
function fourBaseProject(root) {
  const bare = path.join(root, "fleet-origin.git");
  mkdirSync(bare);
  git(bare, "init", "-q", "--bare", "-b", "dev");

  const seed = path.join(root, "fleet-seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "dev");
  commit(seed, "fleet.txt", "one\n", "the first fleet commit");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "dev");
  for (const env of ["qa", "uat", "prod"]) {
    git(seed, "checkout", "-q", "-b", env, "dev");
    git(seed, "push", "-q", "origin", env);
  }
  git(seed, "checkout", "-q", "dev");

  const checkout = path.join(root, "fleet-checkout");
  git(root, "clone", "-q", bare, checkout);

  const trees = {
    dev: path.join(root, "fleet-a"),
    qa: path.join(root, "fleet-qa"),
    uat: path.join(root, "fleet-uat"),
    prod: path.join(root, "fleet-prod"),
    staging: path.join(root, "fleet-staging"),
  };
  // The dev tree's branch and folder say nothing about an environment: only its recorded parent names dev.
  git(checkout, "worktree", "add", "-q", "-b", "wtgui/aaa111", trees.dev, "origin/dev");
  commit(trees.dev, "dev.txt", "dev work\n", "a dev change");
  // The qa tree is found by its FOLDER name, the uat tree by its branch name.
  git(checkout, "worktree", "add", "-q", "-b", "feature/bbb222", trees.qa, "origin/qa");
  commit(trees.qa, "qa.txt", "qa one\n", "a qa change");
  commit(trees.qa, "qa2.txt", "qa two\n", "a second qa change");
  git(checkout, "worktree", "add", "-q", "-b", "release/uat", trees.uat, "origin/uat");
  // A tree standing ON prod itself: ahead 0 against its own base, which is the ON BASE word.
  git(checkout, "worktree", "add", "-q", "-b", "prod", trees.prod, "origin/prod");
  // The configured `staging` environment has no branch anywhere: this row alone must read NO BASE REF, and its
  // siblings must keep their own bases.
  git(checkout, "worktree", "add", "-q", "-b", "wtgui/ccc333", trees.staging, "origin/dev");

  // One more commit on origin/dev, so the dev tree is behind as well as ahead: the counts have to be against ITS
  // base, and 1/1 is impossible to mistake for a count against a main this project does not have.
  commit(seed, "fleet2.txt", "two\n", "a later dev commit");
  git(seed, "push", "-q", "origin", "dev");
  git(checkout, "fetch", "-q", "origin");

  const project = {
    name: "fleet",
    path: checkout,
    remote: "origin",
    mainBranch: "main",
    baseBranches: [
      { branch: "dev", env: "dev" },
      { branch: "qa", env: "qa" },
      { branch: "uat", env: "uat" },
      { branch: "prod", env: "prod" },
      { branch: "staging", env: "staging" },
    ],
  };
  return { bare, checkout, trees, project };
}

function soloProject(root) {
  const bare = path.join(root, "solo-origin.git");
  mkdirSync(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = path.join(root, "solo-seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  commit(seed, "solo.txt", "one\n", "the first solo commit");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  const checkout = path.join(root, "solo-checkout");
  git(root, "clone", "-q", bare, checkout);
  const tree = path.join(root, "solo-w1");
  git(checkout, "worktree", "add", "-q", "-b", "wtgui/solo1", tree, "origin/main");
  commit(tree, "work.txt", "work\n", "solo work");
  return { checkout, tree, project: { name: "solo", path: checkout, remote: "origin", mainBranch: "main" } };
}

test("four environment branches: each row is measured against its own, and a missing one is that row's alone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wtgui-bases-four-"));
  try {
    const { trees, project } = fourBaseProject(root);
    const ctx = {
      remoteRef: `${project.remote}/${project.mainBranch}`,
      remote: project.remote,
      mainBranch: project.mainBranch,
      bases: baseBranchesFrom(project.baseBranches),
      parents: [
        { path: trees.dev.replace(/\\/g, "/"), branch: "wtgui/aaa111", parent: "dev", parentSource: "cut" },
        { path: trees.prod.replace(/\\/g, "/"), branch: "prod", parent: "prod", parentSource: "cut" },
      ],
    };
    const dev = await scanWorktree(trees.dev, ctx, "full");
    const qa = await scanWorktree(trees.qa, ctx, "full");
    const uat = await scanWorktree(trees.uat, ctx, "full");
    const prod = await scanWorktree(trees.prod, ctx, "full");
    const staging = await scanWorktree(trees.staging, ctx, "full");

    // dev: resolved from the recorded parent, and counted against origin/dev - the later dev commit is the `behind`.
    assert.equal(dev.baseRef, "origin/dev");
    assert.equal(dev.baseSource, "parent");
    assert.equal(dev.ahead, 1);
    assert.equal(dev.behind, 1);
    assert.match(dev.verdict, /^UNMERGED \(1 commit\)$/);

    // qa: the folder name carries the environment, and two commits are off origin/qa.
    assert.equal(qa.baseRef, "origin/qa");
    assert.equal(qa.baseSource, "env");
    assert.equal(qa.baseEnv, "qa");
    assert.equal(qa.ahead, 2);
    assert.equal(qa.behind, 0);

    // uat: the branch name carries it. A branch with no commit of its own is not MERGED.
    assert.equal(uat.baseRef, "origin/uat");
    assert.equal(uat.baseSource, "env");
    assert.equal(uat.verdict, "NO COMMITS");

    // prod: the tree stands on its own base, and says ON BASE rather than claiming a main this project has not got.
    assert.equal(prod.baseRef, "origin/prod");
    assert.equal(prod.verdict, "ON BASE");

    // staging: configured, named by the folder, and not on the remote. This row alone is unmeasurable.
    assert.equal(staging.baseRef, "origin/staging");
    assert.equal(staging.baseSource, "missing");
    assert.equal(staging.baseMissing, true);
    assert.equal(staging.verdict, "NO BASE REF");
    assert.equal(staging.ahead, null);
    // ...and it did not poison the rows beside it (each was read in the same pass and kept its own base).
    assert.equal(dev.verdict, "UNMERGED (1 commit)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single-branch project is untouched: origin/main is the base and its counts are the old ones", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wtgui-bases-solo-"));
  try {
    const { tree, project } = soloProject(root);
    const ctx = {
      remoteRef: `${project.remote}/${project.mainBranch}`,
      remote: project.remote,
      mainBranch: project.mainBranch,
      bases: baseBranchesFrom(project.baseBranches),
      parents: [],
    };
    const row = await scanWorktree(tree, ctx, "full");
    assert.equal(row.baseRef, "origin/main");
    assert.equal(row.baseSource, "default");
    assert.equal(row.baseEnv, null);
    assert.equal(row.ahead, 1);
    assert.equal(row.behind, 0);
    assert.match(row.verdict, /^UNMERGED \(1 commit\)$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The chip beside the branch, read out of the page and run with no browser (the shape test/branch-cell.test.js uses).
// The rule is the one the board rests on: a row measured against the project's single base stays as quiet as it was,
// and only a row with a base of its own - or one whose base is missing - says so.
const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const cellCode = sliceRegion(appSrc, "branch cell");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The branch NAME is drawn by public/core/branch-link.js (shared with the Initiatives tab), so the slice runs with
// that module's global injected, exactly as the page loads it before app.js.
await import("../public/core/branch-link.js");
const { baseChipHtml, branchCellHtml } = new Function("esc", "wtBranchLink", `${cellCode}; return { baseChipHtml, branchCellHtml };`)(esc, globalThis.wtBranchLink);
const strip = (html) => html.replace(/<[^>]*>/g, "");

test("the chart shows the resolved base beside the branch, and hides it where the base is the single one", () => {
  // An ordinary project: origin/main is the row's base, so the cell is exactly what it was before this rule.
  assert.equal(baseChipHtml({ baseRef: "origin/main", baseSource: "default" }), "");
  assert.equal(baseChipHtml({ baseRef: null }), "");
  assert.equal(strip(branchCellHtml({ branch: "wtgui/abc123", baseRef: "origin/main", baseSource: "default" })), "wtgui/abc123");

  // A row with its own base says which one, quietly, and its tooltip says why it was chosen.
  const parent = baseChipHtml({ baseRef: "origin/dev", baseSource: "parent", baseEnv: "dev" });
  assert.match(parent, /class="branch-base"/);
  assert.match(parent, /data-base-ref="origin\/dev"/);
  assert.match(parent, /data-base-source="parent"/);
  assert.equal(strip(parent).trim(), "origin/dev");
  assert.match(parent, /the branch this tree was cut from \(the dev environment\)/);

  const env = baseChipHtml({ baseRef: "origin/qa", baseSource: "env", baseEnv: "qa" });
  assert.match(env, /data-base-source="env"/);
  assert.match(env, /the qa environment carried by this tree or its branch name/);
  assert.equal(strip(env).trim(), "origin/qa");

  // A missing base keeps the chip with a `?`, so a NO BASE REF row names the ref that is gone instead of saying nothing.
  const missing = baseChipHtml({ baseRef: "origin/staging", baseSource: "missing", baseMissing: true, baseEnv: "staging" });
  assert.match(missing, /is-missing/);
  assert.equal(strip(missing).trim(), "origin/staging?");
  assert.match(missing, /no base ref for this row: origin\/staging does not exist in this checkout/);

  // And the chip rides beside the LINK too: a pushed branch keeps its remote page and still shows its base.
  const linked = branchCellHtml({ branch: "feature/x", branchUrl: "https://example.test/x", baseRef: "origin/prod", baseSource: "env", baseEnv: "prod" });
  assert.match(linked, /class="branch-link"/);
  assert.match(linked, /class="branch-base"[\s\S]*origin\/prod/);
});
