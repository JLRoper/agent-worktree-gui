// The release executor: every gate, the removal order, and one end-to-end run against a real repo.
//
// The gates are proved with the two subprocess seams (`run` for git, `runGh` for gh) so each refusal can be forced on
// its own and checked against the sentence the reader would read; then the SAME function is driven with real git
// against a throwaway repo, a worktree and a bare remote, because a gate that passes on a fake is not evidence that
// `git worktree remove` and `git push --delete` do what this module claims.
//
// What the panel never takes from the worker's word: every gate below is a fact the panel measures. A marker whose
// reason says "merged and clean" buys nothing — `status`, `gh pr view` and the merge-base diff decide.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReleaseRequests, jobHoldingTree, releaseWorktree, releasesEnabled } from "../lib/worktrees.js";
import { configureRepo, git, ran, slash } from "../tools/panel-testkit.mjs";

const bare = (repo, args) =>
  execFileSync("git", ["--git-dir", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    .split(String.fromCharCode(13))
    .join("")
    .trim();
const hasRef = (cwd, ref) => ran(cwd, ["rev-parse", "--verify", "--quiet", ref]);

// ---- the fake panel -------------------------------------------------------------------------------------------------
const PROJECT = { name: "wtgui", path: "C:/proj/agent-worktree-gui", mainBranch: "main", remote: "origin", releaseWorktrees: true };
const TREE = "C:/proj/agent-worktree-gui/.worktrees/thing-1a2b3c";
const BRANCH = "wtgui/thing-1a2b3c";
const MERGE = "4f0e5f4b2a8c9d7e6f5a4b3c2d1e0f9a8b7c6d5e";
const BASE_SHA = "9b".repeat(20);
const LISTING = `worktree C:/proj/agent-worktree-gui\nbranch refs/heads/main\n\nworktree ${TREE}\nbranch refs/heads/${BRANCH}\n`;
const OK = { ok: true, out: "", err: "" };

// The happy path's answers, in the order the executor asks for them. A test overrides one entry by putting a more
// specific pattern in front; `specific` entries are checked first because the table is walked in order.
//
// `worktree list --porcelain` is STATEFUL: the first answer is the board before the removal and the second is what git
// says afterwards, which is how a real removal looks (the tree is in the first listing and gone from the second). A
// test that wants the tree to survive passes `state.listAfter`.
function fakeRun(extra = [], state = {}) {
  const calls = [];
  let listings = 0;
  const after = state.listAfter || { ok: true, out: `worktree ${slash(PROJECT.path)}\nbranch refs/heads/main\n` };
  const table = [
    ...extra,
    ["worktree list --porcelain", () => (++listings === 1 ? state.listFirst || { ok: true, out: LISTING } : after)],
    ["cat-file -e", state.catFile || { ok: true, out: "" }],
    ["fetch", OK],
    ["diff --merge-base", { ok: true, out: "" }],
    ["rev-parse HEAD^{tree}", { ok: true, out: "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e" }],
    [`rev-parse ${MERGE}^{tree}`, { ok: true, out: "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e" }],
    ["rev-parse --verify --quiet", { ok: true, out: BASE_SHA }],
    ["merge-base --is-ancestor", { ok: true, out: "" }],
    ["status --porcelain", { ok: true, out: "" }],
    ["worktree remove", OK],
    ["branch -D", OK],
    ["push", OK],
  ];
  const run = async (args, cwd) => {
    const line = args.join(" ");
    calls.push(line);
    for (const [match, resp] of table) {
      if (line.includes(match)) return typeof resp === "function" ? resp(args, cwd) : resp;
    }
    return OK;
  };
  run.calls = calls;
  return run;
}

// gh as the executor sees it: the PR index first (only asked when the row carries no PR), then the view.
function fakeGh({ state = "MERGED", oid = MERGE, list = [{ number: 7, state, headRefName: BRANCH, title: "a change" }], view } = {}) {
  const calls = [];
  const gh = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    if (line.startsWith("pr list")) return { ok: true, out: JSON.stringify(list), err: "" };
    if (line.startsWith("pr view")) return view || { ok: true, out: JSON.stringify({ state, mergeCommit: { oid } }), err: "" };
    return { ok: false, out: "", err: `unexpected gh call: ${line}` };
  };
  gh.calls = calls;
  return gh;
}

const REQUEST = {
  key: `wtgui::${TREE}`,
  project: "wtgui",
  path: TREE,
  branch: BRANCH,
  why: "the PR landed and the tree is clean",
  runId: "run-1",
  requestedAt: "2026-10-29T12:00:00.000Z",
  state: "requested",
};

const call = (overrides = {}) =>
  releaseWorktree({ project: PROJECT, request: REQUEST, row: { pr: { number: 7 } }, jobs: [], run: fakeRun(), runGh: fakeGh(), ...overrides });

// ---- the switch ------------------------------------------------------------------------------------------------------
test("the switch is a boolean and only `true` opens it", () => {
  assert.equal(releasesEnabled({ releaseWorktrees: true }), true);
  for (const value of [false, undefined, null, "true", 1, "yes", {}]) {
    assert.equal(releasesEnabled({ releaseWorktrees: value }), false, `${JSON.stringify(value)} must not open the delete`);
  }
});

test("refused: releaseWorktrees is off — and nothing is even asked of git", async () => {
  const run = fakeRun();
  const out = await call({ project: { ...PROJECT, releaseWorktrees: false }, run });
  assert.equal(out.ok, false);
  assert.equal(out.gate, "releaseWorktrees");
  assert.match(out.outcome, /^refused: releaseWorktrees is off for project wtgui/);
  assert.deepEqual(run.calls, [], "a closed switch must not spawn git at all");
});

test("refused: the board's own switch closes a project that carries the grant, before any git", async () => {
  const run = fakeRun();
  const gh = fakeGh();
  const out = await call({ cleanup: false, run, runGh: gh });
  assert.equal(out.ok, false);
  assert.equal(out.gate, "agentCleanup");
  assert.match(out.outcome, /^refused: agent cleanup is off in Settings → Board → Agents clean up/);
  assert.deepEqual(run.calls, [], "the board's veto outranks the project's grant and asks git nothing");
  assert.deepEqual(gh.calls, []);
});

// ---- the reader's lock -----------------------------------------------------------------------------------------------
test("refused: the reader's lock outranks a worker's request", async () => {
  const run = fakeRun();
  const locks = { check: () => ({ locked: true, reason: "the reader locked this worktree" }) };
  const out = await call({ run, locks });
  assert.equal(out.gate, "lock");
  assert.match(out.outcome, /^refused: the reader locked this worktree/);
  assert.deepEqual(run.calls, []);
});

// ---- the tree --------------------------------------------------------------------------------------------------------
test("refused: the project's own checkout is never a release target", async () => {
  const run = fakeRun();
  const out = await call({ run, request: { ...REQUEST, path: slash(PROJECT.path), branch: "main" } });
  assert.equal(out.gate, "worktree");
  assert.match(out.outcome, /is the project's own checkout/);
});

test("refused: a path git does not list as a worktree", async () => {
  const run = fakeRun([["worktree list --porcelain", { ok: true, out: `worktree ${slash(PROJECT.path)}\nbranch refs/heads/main\n` }]]);
  const out = await call({ run });
  assert.equal(out.gate, "worktree");
  assert.match(out.outcome, /^refused: .* is not a worktree of wtgui/);
});

test("refused: a detached HEAD has no branch to delete", async () => {
  const run = fakeRun([["worktree list --porcelain", { ok: true, out: `worktree ${TREE}\n\nworktree ${slash(PROJECT.path)}\nbranch refs/heads/main\n` }]]);
  const out = await call({ run, request: { ...REQUEST, branch: null } });
  assert.equal(out.gate, "branch");
  assert.match(out.outcome, /detached HEAD/);
});

test("refused: the project's main branch is never deleted, whatever a marker says", async () => {
  const run = fakeRun([["worktree list --porcelain", { ok: true, out: `worktree ${TREE}\nbranch refs/heads/main\n\nworktree ${slash(PROJECT.path)}\nbranch refs/heads/other\n` }]]);
  const out = await call({ run, request: { ...REQUEST, branch: null } });
  assert.equal(out.gate, "branch");
  assert.match(out.outcome, /main branch/);
});

// ---- clean -----------------------------------------------------------------------------------------------------------
test("refused: one uncommitted path is enough — the file list is the only copy", async () => {
  const run = fakeRun([["status --porcelain", { ok: true, out: " M lib/a.js\n?? scratch.txt\n" }]]);
  const out = await call({ run });
  assert.equal(out.gate, "clean");
  assert.match(out.outcome, /^refused: the tree is not clean \(2 changed paths\)/);
  assert.ok(!run.calls.some((c) => c.includes("worktree remove")), "a dirty tree must not be touched");
});

test("refused: git status failing is a no, not an empty answer", async () => {
  const run = fakeRun([["status --porcelain", { ok: false, out: "", err: "fatal: not a git repository" }]]);
  const out = await call({ run });
  assert.equal(out.gate, "clean");
  assert.match(out.outcome, /git status failed/);
});

// ---- the PR ----------------------------------------------------------------------------------------------------------
test("refused: no pull request means nothing shows the branch landed", async () => {
  // A branch that carries a commit main does not have, with no PR: the second acceptance is measured here and says
  // no (the refusals way of putting it is the same sentence it always gave).
  const run = fakeRun([["rev-list --count", { ok: true, out: "1\n" }]]);
  const out = await call({ row: null, run, runGh: fakeGh({ list: [] }) });
  assert.equal(out.gate, "pr");
  assert.match(out.outcome, /^refused: no pull request is recorded for wtgui\/thing-1a2b3c/);
});

test("refused: an OPEN PR is not a merged one", async () => {
  const out = await call({ run: fakeRun(), runGh: fakeGh({ state: "OPEN" }) });
  assert.equal(out.gate, "pr");
  assert.match(out.outcome, /^refused: PR #7 reads OPEN, not MERGED/);
});

test("refused: gh failing to answer is a refusal, not a pass", async () => {
  const out = await call({ run: fakeRun(), runGh: fakeGh({ view: { ok: false, out: "", err: "gh: Not Found (HTTP 404)" } }) });
  assert.equal(out.gate, "pr");
  assert.match(out.outcome, /^refused: gh could not read PR #7 — gh: Not Found/);
});

test("refused: MERGED with no merge commit", async () => {
  const out = await call({ run: fakeRun(), runGh: fakeGh({ oid: "" }) });
  assert.equal(out.gate, "pr");
  assert.match(out.outcome, /reads MERGED but has no merge commit/);
});

// ---- the tree-equal gate ----------------------------------------------------------------------------------------------
test("refused: work the merge commit did not land", async () => {
  const run = fakeRun([
    ["diff --merge-base", { ok: true, out: "diff --git a/x.txt b/x.txt\n+x\n" }],
    ["merge-base", { ok: true, out: MERGE }],
    ["diff --name-only", { ok: true, out: "x.txt\n" }],
    [`diff ${MERGE} HEAD --`, { ok: true, out: "diff --git a/x.txt b/x.txt\n+y\n" }],
  ]);
  const out = await call({ run });
  assert.equal(out.gate, "tree");
  assert.match(out.outcome, /^refused: the tree carries work PR #7 did not land \(1 path of its own/);
  assert.ok(!run.calls.some((c) => c.includes("worktree remove")));
});

test("a squash landing passes on the paths the branch touched, though its SHAs never join the merge's history", async () => {
  // Measured: `git diff --merge-base <mergeCommit>..HEAD` is refused by git ("does not work with ranges"), and with the
  // two-revision form a squashed branch diffs its whole work against the merge — the trunk has the content, not the
  // commits, and main has usually moved on since the fork. What answers "is this branch's content in what landed" is
  // the branch's OWN paths, compared one by one against the merge commit.
  const run = fakeRun([
    ["diff --merge-base", { ok: true, out: "diff --git a/x.txt b/x.txt\n+x\n" }],
    ["merge-base", { ok: true, out: "0123456789abcdef0123456789abcdef01234567" }],
    ["diff --name-only", { ok: true, out: "x.txt\n" }],
    [`diff ${MERGE} HEAD --`, { ok: true, out: "" }],
  ]);
  const out = await call({ run });
  assert.equal(out.ok, true, out.outcome);
  assert.equal(out.outcome, "removed");
  assert.match(out.steps.find((s) => s.step === "tree").detail, /every path this branch touched \(1\) already carries its content/);
});

test("refused: the merge commit is not in this checkout, even after a fetch", async () => {
  const run = fakeRun([["cat-file -e", { ok: false, out: "", err: "fatal: Not a valid object name" }]], { catFile: { ok: false, out: "", err: "fatal: Not a valid object name" } });
  const out = await call({ run });
  assert.equal(out.gate, "tree");
  assert.match(out.outcome, /is not in this checkout and could not be fetched/);
  assert.ok(run.calls.some((c) => c.includes("fetch --quiet --no-tags origin main")), "the executor fetches the base branch once before giving up");
});

test("the fetch is one attempt: the gate re-reads the object afterwards", async () => {
  let asked = 0;
  const run = fakeRun([
    [
      "cat-file -e",
      () => {
        asked += 1;
        return asked === 1 ? { ok: false, out: "", err: "fatal: Not a valid object name" } : { ok: true, out: "" };
      },
    ],
  ]);
  const out = await call({ run });
  assert.equal(out.ok, true, `expected a pass after the fetch: ${out.outcome}`);
  assert.equal(asked, 2);
});

// ---- the base the tree was cut from ---------------------------------------------------------------------------------
// A merged PR says the merge reached ITS base. The release has to ask whether that base was THIS tree's: a child
// rolled into its parent turnover branch has its merge commit reachable from the parent and from nothing on
// origin/main, and the tree-equal gate alone cannot tell that apart from a landing. The recorded parent is the
// panel's own note from the cut (branch-parents.json, keyed by the tree's six-hex tag).
const PARENT = "wtgui/turnover-parent-4f1a2b";
const parentRoots = [];
test.after(async () => {
  for (const dir of parentRoots) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function parentBook(entries = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-release-parents-"));
  parentRoots.push(dir);
  const file = path.join(dir, "branch-parents.json");
  await writeFile(file, `${JSON.stringify(entries)}\n`, "utf8");
  return file;
}

test("a merge into origin/main passes when the tree has no recorded parent", async () => {
  const parentsPath = await parentBook({});
  const run = fakeRun();
  const out = await call({ run, parentsPath });
  assert.equal(out.ok, true, out.outcome);
  const step = out.steps.find((s) => s.step === "base");
  assert.ok(step, "the release names the base it measured");
  assert.match(step.detail, /reachable from origin\/main/);
  assert.match(step.detail, /no recorded parent/);
});

test("a merge into the tree's recorded parent passes, because that is where its work lives", async () => {
  const parentsPath = await parentBook({
    "tag:1a2b3c": { parent: PARENT, branch: BRANCH, tree: TREE, at: "2026-11-12T00:00:00.000Z" },
  });
  const run = fakeRun();
  const out = await call({ run, parentsPath });
  assert.equal(out.ok, true, out.outcome);
  const step = out.steps.find((s) => s.step === "base");
  assert.ok(step, "the release names the base it measured");
  assert.ok(step.detail.includes(`reachable from refs/heads/${PARENT}`), step.detail);
  assert.ok(step.detail.includes(`recorded parent ${PARENT}`), step.detail);
  assert.ok(
    run.calls.some((c) => c.includes(`merge-base --is-ancestor ${MERGE} refs/heads/${PARENT}`)),
    "the parent, not origin/main, is what the merge was measured against",
  );
  assert.ok(
    !run.calls.some((c) => c.startsWith("merge-base --is-ancestor") && c.includes("origin/main")),
    "a recorded parent must not also be measured against the project base",
  );
});

test("refused: a merge reachable from neither names the base it checked", async () => {
  const parentsPath = await parentBook({ "tag:1a2b3c": { parent: PARENT, branch: BRANCH, tree: TREE } });
  const run = fakeRun([["merge-base --is-ancestor", { ok: false, out: "", err: "exit code 1" }]]);
  const out = await call({ run, parentsPath });
  assert.equal(out.ok, false, "a merge that never reached the tree's base is not a landing");
  assert.equal(out.gate, "base");
  assert.match(out.outcome, /neither its merge commit .* nor the tip of wtgui\/thing-1a2b3c is reachable from wtgui\/turnover-parent-4f1a2b/);
  assert.ok(!run.calls.some((c) => c.includes("worktree remove")), "nothing is removed on a base refusal");
});

test("a tree with no recorded parent falls back to the project base, not to a guessed parent", async () => {
  // The book has a record for ANOTHER tree, and the fake git says that other branch would contain the merge. With no
  // record for THIS tree the project base is the only authority, so the release must refuse and name origin/main.
  const parentsPath = await parentBook({ "tag:ffffff": { parent: PARENT, branch: "wtgui/other-ffffff", tree: "elsewhere/other" } });
  const run = fakeRun([
    ["merge-base --is-ancestor", (args) => (args.join(" ").includes("turnover") ? { ok: true, out: "" } : { ok: false, out: "", err: "exit code 1" })],
  ]);
  const out = await call({ run, parentsPath });
  assert.equal(out.ok, false);
  assert.equal(out.gate, "base");
  assert.match(out.outcome, /reachable from origin\/main/);
  assert.match(out.outcome, /no recorded parent/);
  assert.ok(run.calls.some((c) => c.includes("merge-base --is-ancestor") && c.includes("origin/main")));
});

// ---- the jobs gate ---------------------------------------------------------------------------------------------------
test("refused: a job still running or queued in that tree", async () => {
  for (const status of ["running", "starting", "waiting", "queued"]) {
    const run = fakeRun();
    const out = await call({ run, jobs: [{ id: "busy-1", status, cwd: TREE }] });
    assert.equal(out.gate, "jobs", `${status} must hold the tree`);
    assert.match(out.outcome, /^refused: an agent is still holding that worktree \(busy-1/);
    assert.ok(!run.calls.some((c) => c.includes("worktree remove")));
  }
  // The tree is matched through any of the three path fields, and a settled job holds nothing.
  assert.equal(jobHoldingTree([{ id: "x", status: "running", ownerPath: TREE }], TREE)?.id, "x");
  assert.equal(jobHoldingTree([{ id: "x", status: "running", worktreePath: TREE }], TREE)?.id, "x");
  assert.equal(jobHoldingTree([{ id: "x", status: "done", cwd: TREE }], TREE), null);
  assert.equal(jobHoldingTree([{ id: "x", status: "running", cwd: "C:/other" }], TREE), null);
});

// ---- the removal -----------------------------------------------------------------------------------------------------
test("the removal runs in the one order: the links out first, then worktree, local branch, remote branch, plain rmdir", async () => {
  const run = fakeRun();
  const out = await call({ run });
  assert.equal(out.ok, true);
  assert.equal(out.outcome, "removed");
  const order = run.calls.filter((c) => c.includes("worktree remove") || c.includes("branch -D") || c.startsWith("push"));
  assert.deepEqual(order, [`worktree remove ${TREE}`, `branch -D ${BRANCH}`, `push origin --delete ${BRANCH}`]);
  assert.deepEqual(
    out.steps.map((s) => s.step),
    ["clean", "pr", "base", "tree", "jobs", "junction", "worktree", "branch", "remote", "shell"],
  );
  // The link step is the one before the git call that would recurse through a junction, and this tree has none (the
  // fake run means TREE does not exist on disk): the step still has to be there, and to say so.
  assert.equal(out.steps.find((s) => s.step === "junction").detail, "no directory link inside the tree");
  assert.equal(out.branch, BRANCH);
  assert.equal(out.pr, 7);
  assert.equal(out.mergeCommit, MERGE);
});

test("a branch that is already gone from the remote is not a failed release", async () => {
  const run = fakeRun([["push", { ok: false, out: "", err: "error: unable to delete 'wtgui/thing-1a2b3c': remote ref does not exist" }]]);
  const out = await call({ run });
  assert.equal(out.ok, true);
  assert.equal(out.outcome, "removed");
  assert.match(out.steps.find((s) => s.step === "remote").detail, /was not on origin/);
});

test("a local branch that was already deleted is not a failed release either", async () => {
  const run = fakeRun([["branch -D", { ok: false, out: "", err: "error: branch 'wtgui/thing-1a2b3c' not found" }]]);
  const out = await call({ run });
  assert.equal(out.ok, true);
  assert.match(out.steps.find((s) => s.step === "branch").detail, /already gone/);
});

test("git refusing the worktree removal stops the sequence there", async () => {
  const run = fakeRun([
    ["worktree remove", { ok: false, out: "", err: "error: failed to delete 'C:/proj/x': Permission denied" }],
    ["worktree list --porcelain", () => ({ ok: true, out: LISTING })],
  ]);
  const out = await call({ run });
  assert.equal(out.ok, false);
  assert.match(out.outcome, /^refused: git could not remove the worktree — .*Permission denied/);
  assert.ok(!run.calls.some((c) => c.includes("branch -D")), "a tree that survived its own removal keeps its branch");
});

// ---- end to end, real git --------------------------------------------------------------------------------------------
// A throwaway repo, a worktree, a bare remote, and the marker read out of a final message — the whole path, with gh
// standing in at its own boundary (there is no GitHub repository behind a temp fixture) and every git answer real.
const tempRoots = [];
test.after(async () => {
  for (const r of tempRoots) {
    await rm(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

async function makeLanding(style) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-release-e2e-"));
  tempRoots.push(root);
  const remote = path.join(root, "remote.git");
  const proj = path.join(root, "proj");
  const tree = path.join(root, "tree");
  execFileSync("git", ["init", "-q", "--bare", remote], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await mkdir(proj, { recursive: true });
  git(proj, ["init", "-q", "-b", "main"]);
  configureRepo(proj);
  await writeFile(path.join(proj, "README.md"), "# test\n", "utf8");
  git(proj, ["add", "."]);
  git(proj, ["commit", "-q", "-m", "init"]);
  git(proj, ["remote", "add", "origin", slash(remote)]);
  git(proj, ["push", "-q", "-u", "origin", "main"]);
  bare(slash(remote), ["symbolic-ref", "HEAD", "refs/heads/main"]);
  // The worktree and its branch.
  git(proj, ["worktree", "add", "-q", "-b", "feature", slash(tree)]);
  await writeFile(path.join(tree, "feature.txt"), "the feature\n", "utf8");
  git(tree, ["add", "."]);
  git(tree, ["commit", "-q", "-m", "the feature"]);
  git(tree, ["push", "-q", "-u", "origin", "feature"]);
  // Main moves on after the fork, which is what makes the two landing styles take different arms of the tree gate.
  await writeFile(path.join(proj, "other.txt"), "somebody else's work\n", "utf8");
  git(proj, ["add", "."]);
  git(proj, ["commit", "-q", "-m", "other work on main"]);
  if (style === "squash") {
    git(proj, ["merge", "-q", "--squash", "feature"]);
    git(proj, ["commit", "-q", "-m", "the feature (squashed)"]);
  } else {
    git(proj, ["merge", "-q", "--no-ff", "-m", "merge the feature", "feature"]);
  }
  const mergeSha = git(proj, ["rev-parse", "HEAD"]);
  git(proj, ["push", "-q", "origin", "main"]);
  return { root, remote, proj, tree, branch: "feature", mergeSha };
}

let sharedSquashPromise = null;
function getSquashLanding() {
  if (!sharedSquashPromise) sharedSquashPromise = makeLanding("squash");
  return sharedSquashPromise;
}

function e2eFixture(fixture, fileName = "releases.json") {
  const store = new ReleaseRequests({ file: path.join(fixture.root, fileName), trees: () => [{ project: "wtgui", path: slash(fixture.tree), branch: fixture.branch }] });
  const job = { id: "e2e-run", thread: "wtgui-e2e", worktreePath: slash(fixture.tree), branch: fixture.branch };
  const recorded = store.record({
    job,
    finalText: `The branch is landed and the tree is clean.\n\nRELEASE ${slash(fixture.tree)} | the PR is merged and nothing is left in the tree`,
  });
  return { store, recorded, project: { name: "wtgui", path: slash(fixture.proj), mainBranch: "main", remote: "origin", releaseWorktrees: true } };
}

const ghFor = (mergeSha) => async (args) => {
  const line = args.join(" ");
  if (line.startsWith("pr list")) {
    return { ok: true, out: JSON.stringify([{ number: 7, state: "MERGED", mergedAt: "2026-10-29T12:00:00Z", headRefName: "feature", headRefOid: mergeSha, title: "the feature" }]), err: "" };
  }
  if (line.startsWith("pr view")) return { ok: true, out: JSON.stringify({ state: "MERGED", mergeCommit: { oid: mergeSha } }), err: "" };
  return { ok: false, out: "", err: `unexpected gh call: ${line}` };
};

test("end to end: a dirty tree is refused, and nothing is deleted", async () => {
  const fixture = await getSquashLanding();
  const scratchPath = path.join(fixture.tree, "scratch.txt");
  await writeFile(scratchPath, "not committed\n", "utf8");
  try {
    const { store, project } = e2eFixture(fixture, "releases-dirty.json");
    const request = store.pending()[0];
    const out = await releaseWorktree({ project, request, row: null, jobs: [], runGh: ghFor(fixture.mergeSha) });
    assert.equal(out.ok, false);
    assert.equal(out.gate, "clean");
    assert.match(out.outcome, /^refused: the tree is not clean \(1 changed path\)/);
    assert.equal(existsSync(fixture.tree), true, "the tree is still there");
    assert.equal(hasRef(fixture.proj, "refs/heads/feature"), true, "its branch is still there");
    assert.ok(bare(slash(fixture.remote), ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").includes("feature"), "its remote branch is still there");
  } finally {
    await unlink(scratchPath).catch(() => {});
  }
});

test("end to end: a RELEASE line removes the worktree, the local branch and the remote branch (squashed landing)", async () => {
  const fixture = await getSquashLanding();
  const { store, recorded, project } = e2eFixture(fixture, "releases-squash.json");
  assert.equal(recorded.requests.length, 1, "the marker was read out of the final message");
  assert.equal(recorded.refused.length, 0);
  const request = store.pending()[0];
  assert.equal(slash(request.path), slash(fixture.tree));

  const out = await releaseWorktree({ project, request, row: null, jobs: [], runGh: ghFor(fixture.mergeSha) });
  assert.equal(out.ok, true, `expected a removal, got: ${out.outcome} ${JSON.stringify(out.steps)}`);
  assert.equal(out.outcome, "removed");
  assert.match(out.steps.find((s) => s.step === "tree").detail, /every path this branch touched \(1\) already carries its content/);
  store.finish(request.key, { outcome: out.outcome, detail: out.detail, steps: out.steps });
  assert.equal(store.forRow("wtgui", fixture.tree).state, "removed");

  // The three things the request was for, checked against git and the bare remote rather than the module's own report.
  assert.equal(existsSync(fixture.tree), false, "the worktree directory is gone");
  assert.ok(!git(fixture.proj, ["worktree", "list", "--porcelain"]).includes(slash(fixture.tree)), "git no longer lists the worktree");
  assert.equal(hasRef(fixture.proj, "refs/heads/feature"), false, "the local branch is gone");
  assert.ok(!bare(slash(fixture.remote), ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").includes("feature"), "the remote branch is gone");
  // …and main is untouched.
  assert.equal(hasRef(fixture.proj, "refs/heads/main"), true);
  assert.ok(bare(slash(fixture.remote), ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).includes("main"));
});

test("end to end: a true merge commit passes on history, not on identical trees", async () => {
  const base = await getSquashLanding();
  const { root, remote, proj } = base;
  const tree = path.join(root, "tree-merge");
  git(proj, ["worktree", "add", "-q", "-b", "feature", slash(tree)]);
  await writeFile(path.join(tree, "feature2.txt"), "the second feature\n", "utf8");
  git(tree, ["add", "."]);
  git(tree, ["commit", "-q", "-m", "the second feature"]);
  git(tree, ["push", "-q", "-u", "origin", "feature"]);
  await writeFile(path.join(proj, "other2.txt"), "more work on main\n", "utf8");
  git(proj, ["add", "."]);
  git(proj, ["commit", "-q", "-m", "more work on main"]);
  git(proj, ["merge", "-q", "--no-ff", "-m", "merge the feature", "feature"]);
  const mergeSha = git(proj, ["rev-parse", "HEAD"]);
  git(proj, ["push", "-q", "origin", "main"]);
  const fixture = { root, remote, proj, tree, branch: "feature", mergeSha };

  const { store, project } = e2eFixture(fixture, "releases-merge.json");
  const request = store.pending()[0];
  const out = await releaseWorktree({ project, request, row: null, jobs: [], runGh: ghFor(fixture.mergeSha) });
  assert.equal(out.ok, true, `expected a removal, got: ${out.outcome} ${JSON.stringify(out.steps)}`);
  assert.match(out.steps.find((s) => s.step === "tree").detail, /brings nothing the merge commit does not have/);
  assert.equal(existsSync(fixture.tree), false);
  assert.equal(hasRef(fixture.proj, "refs/heads/feature"), false);
  assert.ok(!bare(slash(fixture.remote), ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").includes("feature"));
});

test("end to end: a child rolled into its parent is released against the parent, and refused against origin/main without the record", async () => {
  // The release gap itself: a child cut from a parent turnover branch, merged back into that parent, with a MERGED
  // PR whose merge commit contains the child tip. origin/main never saw the work. Without a record the release must
  // refuse and name origin/main; with the record the parent is where the work legitimately lives, so it must pass.
  const base = await getSquashLanding();
  const { root, remote, proj } = base;
  const parentBranch = "wtgui/turnover-parent-4f1a2b";
  const childBranch = "wtgui/turnover-child-1a2b3c";
  const parentTree = path.join(root, "parent-turnover");
  const childTree = path.join(root, "child-turnover");
  git(proj, ["worktree", "add", "-q", "-b", parentBranch, slash(parentTree), "origin/main"]);
  git(proj, ["worktree", "add", "-q", "-b", childBranch, slash(childTree), parentBranch]);
  await writeFile(path.join(childTree, "child.txt"), "the child's work\n", "utf8");
  git(childTree, ["add", "."]);
  git(childTree, ["commit", "-q", "-m", "the child's work"]);
  git(childTree, ["push", "-q", "-u", "origin", childBranch]);
  const childTip = git(childTree, ["rev-parse", "HEAD"]);
  git(parentTree, ["merge", "-q", "--no-ff", "-m", "roll the child into the parent", childBranch]);
  const mergeSha = git(parentTree, ["rev-parse", "HEAD"]);
  assert.equal(ran(proj, ["merge-base", "--is-ancestor", mergeSha, "origin/main"]), false, "the merge never reached origin/main");
  assert.equal(ran(proj, ["merge-base", "--is-ancestor", childTip, mergeSha]), true, "the merge commit contains the child tip");
  const mainBefore = git(proj, ["rev-parse", "origin/main"]);

  const store = new ReleaseRequests({ file: path.join(root, "releases-gap.json"), trees: () => [{ project: "wtgui", path: slash(childTree), branch: childBranch }] });
  store.record({
    job: { id: "e2e-gap", thread: "wtgui-e2e", worktreePath: slash(childTree), branch: childBranch },
    finalText: `The roll is done.\n\nRELEASE ${slash(childTree)} | rolled into its parent`,
  });
  const request = store.pending()[0];
  const project = { name: "wtgui", path: slash(proj), mainBranch: "main", remote: "origin", releaseWorktrees: true };

  // 1. No record for this tree: the project base decides, and it never contained the merge.
  const refused = await releaseWorktree({ project, request, row: { pr: { number: 7 } }, jobs: [], runGh: ghFor(mergeSha) });
  assert.equal(refused.ok, false, "without the record this must be refused");
  assert.equal(refused.gate, "base");
  assert.match(refused.outcome, /neither its merge commit .* nor the tip of wtgui\/turnover-child-1a2b3c is reachable from origin\/main/);
  assert.equal(existsSync(childTree), true, "the refused tree is still there");
  assert.equal(hasRef(proj, `refs/heads/${childBranch}`), true, "its local branch is still there");

  // 2. The recorded parent: the same merge is finished work in the place it belongs.
  const parentsPath = await parentBook({
    "tag:1a2b3c": { parent: parentBranch, branch: childBranch, tree: slash(childTree), at: new Date().toISOString() },
  });
  const passed = await releaseWorktree({ project, request, row: { pr: { number: 7 } }, jobs: [], parentsPath, runGh: ghFor(mergeSha) });
  assert.equal(passed.ok, true, `expected the parent to carry the roll: ${passed.outcome} ${JSON.stringify(passed.steps)}`);
  assert.ok(passed.steps.find((s) => s.step === "base").detail.includes(`recorded parent ${parentBranch}`));
  assert.equal(existsSync(childTree), false, "the child tree is gone");
  assert.equal(hasRef(proj, `refs/heads/${childBranch}`), false, "the child branch is gone");
  assert.ok(!bare(slash(remote), ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").includes(childBranch), "the child branch is gone from origin");
  // …and the parent, which is where the work now lives, is untouched.
  assert.equal(hasRef(proj, `refs/heads/${parentBranch}`), true, "the parent branch was not deleted");
  assert.equal(existsSync(parentTree), true, "the parent tree is still there");
  assert.equal(git(proj, ["rev-parse", "origin/main"]), mainBefore, "origin/main never moved");
});

// ---- the second acceptance: nothing to land ---------------------------------------------------------------------------
// A documentation or review tree: a registered worktree of its own project, a branch of its own, no PR anywhere, and —
// for the case that is accepted — nothing on the branch that main does not already have. `ahead` is the one thing the
// acceptance turns on: 0 commits over origin/main is releasable, 1 is a branch that still needs the merged-PR path.
async function makeNothingToLand({ ahead = 0 } = {}) {
  const base = await getSquashLanding();
  const { root, remote, proj } = base;
  const tree = path.join(root, "doc-tree");
  git(proj, ["worktree", "add", "-q", "-b", "doc-tree", slash(tree)]);
  if (ahead > 0) {
    await writeFile(path.join(tree, "notes.md"), "a change nobody opened a PR for\n", "utf8");
    git(tree, ["add", "."]);
    git(tree, ["commit", "-q", "-m", "a change nobody opened a PR for"]);
  }
  git(tree, ["push", "-q", "-u", "origin", "doc-tree"]);
  return { root, remote, proj, tree, branch: "doc-tree" };
}

// The request a settled turn leaves behind: one RELEASE line, read out of the final message by the panel's own parser.
function nothingToLandRequest(fixture, why, fileName = "releases.json") {
  const store = new ReleaseRequests({
    file: path.join(fixture.root, fileName),
    trees: () => [{ project: "wtgui", path: slash(fixture.tree), branch: fixture.branch }],
  });
  const recorded = store.record({
    job: { id: "e2e-run", thread: "wtgui-e2e", worktreePath: slash(fixture.tree), branch: fixture.branch },
    finalText: `Nothing is left to land here.\n\nRELEASE ${slash(fixture.tree)} | ${why}`,
  });
  return {
    store,
    recorded,
    request: store.pending()[0],
    project: { name: "wtgui", path: slash(fixture.proj), mainBranch: "main", remote: "origin", releaseWorktrees: true },
  };
}

// gh for a branch that never had a pull request: the index is empty, and a `pr view` is a call the executor must never
// make, because there is no number to make it with.
const noPrGh = async (args) => {
  const line = args.join(" ");
  if (line.startsWith("pr list")) return { ok: true, out: "[]", err: "" };
  return { ok: false, out: "", err: `unexpected gh call: ${line}` };
};

const hasBareRef = (repo, ref) => {
  try {
    bare(repo, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
};

test("nothing to land: a clean tree 0 commits ahead of origin/main and no PR is released", async () => {
  const fixture = await makeNothingToLand({ ahead: 0 });
  const { store, recorded, request, project } = nothingToLandRequest(fixture, "a documentation tree with nothing to land", "releases-nothing-0.json");
  assert.equal(recorded.requests.length, 1, "the marker was read out of the final message");
  assert.equal(recorded.refused.length, 0);
  assert.equal(git(fixture.tree, ["rev-list", "--count", "origin/main..HEAD"]), "0", "the fixture is the case the acceptance names");

  const out = await releaseWorktree({ project, request, row: null, jobs: [], runGh: noPrGh });
  assert.equal(out.ok, true, `expected a removal, got: ${out.outcome} ${JSON.stringify(out.steps)}`);
  assert.equal(out.outcome, "removed");
  assert.equal(out.pr, null, "no PR is involved in this acceptance");
  assert.match(out.steps.find((s) => s.step === "nothing").detail, /^nothing to land — origin\/main\.\.HEAD counts 0 commits$/);
  store.finish(request.key, { outcome: out.outcome, detail: out.detail, steps: out.steps });
  assert.equal(store.forRow("wtgui", fixture.tree).state, "removed");

  // Checked against git and the bare remote, not the module's own report.
  assert.equal(existsSync(fixture.tree), false, "the worktree directory is gone");
  assert.ok(!git(fixture.proj, ["worktree", "list", "--porcelain"]).includes(slash(fixture.tree)), "git no longer lists it");
  assert.equal(hasRef(fixture.proj, "refs/heads/doc-tree"), false, "the local branch is gone");
  assert.equal(hasBareRef(slash(fixture.remote), "refs/heads/doc-tree"), false, "the remote branch is gone");
  assert.equal(hasRef(fixture.proj, "refs/heads/main"), true, "main is untouched");
});

test("nothing to land refuses a branch that IS ahead of main, and leaves the tree completely intact", async () => {
  const fixture = await makeNothingToLand({ ahead: 1 });
  const { request, project } = nothingToLandRequest(fixture, "a tree with one commit nobody opened a PR for", "releases-nothing-1.json");
  assert.equal(git(fixture.tree, ["rev-list", "--count", "origin/main..HEAD"]), "1");

  const out = await releaseWorktree({ project, request, row: null, jobs: [], runGh: noPrGh });
  assert.equal(out.ok, false);
  assert.equal(out.gate, "pr", "the gate that said no is named, the way every refusal is");
  assert.match(out.outcome, /^refused: no pull request is recorded for doc-tree and it is 1 commit ahead of origin\/main, so nothing shows this branch landed$/);

  // The worktree, its work, its local branch and its remote branch are all still there.
  assert.equal(existsSync(fixture.tree), true, "the tree is still there");
  assert.equal(existsSync(path.join(fixture.tree, "notes.md")), true, "its work is still in it");
  assert.ok(git(fixture.proj, ["worktree", "list", "--porcelain"]).includes(slash(fixture.tree)), "git still lists the worktree");
  assert.equal(hasRef(fixture.proj, "refs/heads/doc-tree"), true, "its local branch is still there");
  assert.equal(hasBareRef(slash(fixture.remote), "refs/heads/doc-tree"), true, "its remote branch is still there");
  assert.equal(git(fixture.tree, ["rev-list", "--count", "origin/main..HEAD"]), "1", "the branch still carries its commit");
});

test("the count is a number or it is nothing: an unreadable rev-list falls back to the tree-equal diff", async () => {
  const run = fakeRun([
    ["rev-list --count", { ok: false, out: "", err: "fatal: ambiguous argument 'origin/main..HEAD': unknown revision" }],
    ["diff origin/main HEAD", { ok: true, out: "" }],
  ]);
  const out = await call({ row: null, run, runGh: fakeGh({ list: [] }) });
  assert.equal(out.ok, true, `expected the fallback to accept it: ${out.outcome}`);
  assert.match(out.steps.find((s) => s.step === "nothing").detail, /HEAD's tree is identical to origin\/main/);
  assert.ok(run.calls.includes("fetch --quiet --no-tags origin main"), "the base branch is fetched once before the count is given up on");
});

test("refused: the count is unreadable and the trees differ — no delete on an unmeasured branch", async () => {
  const run = fakeRun([
    ["rev-list --count", { ok: false, out: "", err: "fatal: bad revision 'origin/main..HEAD'" }],
    ["diff origin/main HEAD", { ok: true, out: "diff --git a/x.txt b/x.txt\n+x\n" }],
  ]);
  const out = await call({ row: null, run, runGh: fakeGh({ list: [] }) });
  assert.equal(out.gate, "pr");
  assert.match(out.outcome, /^refused: no pull request is recorded .* and its tree differs from origin\/main/);
  assert.ok(!run.calls.some((c) => c.includes("worktree remove")));
});

test("an unmeasurable branch refuses rather than passing: no count and no diff is not a 0", async () => {
  const run = fakeRun([
    ["rev-list --count", { ok: true, out: "" }],
    ["diff origin/main HEAD", { ok: false, out: "", err: "fatal: bad revision 'origin/main'" }],
  ]);
  const out = await call({ row: null, run, runGh: fakeGh({ list: [] }) });
  assert.equal(out.gate, "pr");
  assert.match(out.outcome, /could not measure it against origin\/main/);
});

test("nothing to land does not skip the jobs gate: a live run still holds the tree", async () => {
  for (const status of ["running", "starting", "waiting", "queued"]) {
    const run = fakeRun([["rev-list --count", { ok: true, out: "0\n" }]]);
    const out = await call({ row: null, run, runGh: fakeGh({ list: [] }), jobs: [{ id: "busy-2", status, cwd: TREE }] });
    assert.equal(out.gate, "jobs", `${status} must hold the tree`);
    assert.match(out.outcome, /^refused: an agent is still holding that worktree \(busy-2/);
    assert.ok(!run.calls.some((c) => c.includes("worktree remove")));
  }
});
