// The branch-landing policy: per project, and explicit in the run body.
//
// Three facts, each driven rather than read off the source:
//
//   1. a project's own `remoteBranchPolicy` overrides the global one, the global default is local-only, and the
//      value the guard is INSTALLED with is the project's — so a repo that lands by PR (this panel, heroes-js) keeps
//      pushing while every other checkout stays local;
//   2. a worker's run body names the branch its tree was really cut from — read at the cut, not assumed to be main —
//      and says the two different things that follow from it: merge into the parent locally, or push and open a PR
//      when the parent is main/master. A tree nobody can name gets the blanket rule and NO invented parent;
//   3. the panel's own assistant gets none of it: its turn has no directory, so it has no tree to land.
//
// The run body is asserted against a stub Runs API that records what was actually POSTed, because "what the worker
// reads" is the claim, not "what the formatter returns".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Jobs } from "../lib/jobs.js";
import { branchLandingLine } from "../lib/branch-policy.js";
import { policyForProject, policyFrom } from "../lib/remote-writes.js";
import { installGuard, guardPaths, commonDirOf } from "../lib/push-guard.js";
import { ROOT, configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test, and reading the developer's real session
// store for its counters is both slow and none of this suite's business. Set before any Jobs is constructed.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-policy-home-"));
process.env.API_SERVER_KEY = "";

const git = (dir, args) => {
  try {
    return runGit(dir, args);
  } catch (e) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${String((e && e.message) || e)}`);
  }
};
const commit = (dir, message = "work") =>
  git(dir, ["commit", "-q", "--allow-empty", "-m", message]);

// A repo with one commit on `branch`, ready to be cut from. `-b <branch>` is what makes the parent interesting: the
// panel branches from whatever this checkout has checked out, and the whole point is that it is not always main.
function makeRepo(branch = "main") {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-policy-repo-"));
  git(dir, ["init", "-q", "-b", branch]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# policy sandbox\n");
  git(dir, ["add", "."]);
  commit(dir, "first");
  return dir;
}

// The smallest gateway that accepts a run and records its body.
async function stubGateway() {
  const submitted = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          submitted.push(JSON.parse(raw || "{}"));
        } catch {
          submitted.push({});
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: `stub-run-${submitted.length}`, status: "running" }));
      });
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "done", exit_code: 0 })}\n\n`);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ run_id: "stub-run-0", status: "completed" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    submitted,
    last: () => String(submitted[submitted.length - 1]?.input || ""),
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// A Jobs instance pointed at the stub, with its store in a temp dir. The timers are cleared by `dispose` — the suite
// asserts what was POSTed, it never waits for a run to end.
function makeJobs(dir, url) {
  const jobs = new Jobs({
    config: { apiServer: { url }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 3600 },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.dispose = () => {
    for (const j of jobs.jobs.values()) {
      clearTimeout(j.timer);
      clearTimeout(j.persistTimer);
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      try {
        j.ctrl?.abort();
      } catch {
        /* an aborted stream is the point */
      }
    }
    clearTimeout(jobs.persistTimer);
  };
  return jobs;
}

test("a project's own policy overrides the global, and the global defaults to local-only", async (t) => {
  // The default: a value nobody set, and a value that cannot be read, both mean "the closed one".
  assert.equal(policyFrom(undefined), "local-only", "the global default is local-only");
  assert.equal(policyForProject({}, undefined), "local-only", "a project with no policy of its own inherits local-only");
  assert.equal(policyForProject(null, undefined), "local-only", "no project at all is still local-only");
  // The override, in both directions — this is what keeps a landing repo pushing under a local-only global.
  assert.equal(policyForProject({ name: "agent-worktree-gui", remoteBranchPolicy: "allow" }, "local-only"), "allow");
  assert.equal(policyForProject({ name: "heroes-js", remoteBranchPolicy: "allow" }, "local-only"), "allow");
  assert.equal(policyForProject({ name: "Menu", remoteBranchPolicy: "deny" }, "allow"), "deny");
  // An unreadable per-project value falls back to the global, never to a permissive guess.
  assert.equal(policyForProject({ remoteBranchPolicy: "whatever" }, "deny"), "deny");

  // The enforcement half reads the same value: the guard is installed with the PROJECT's policy, and that is what
  // its own `policy` file says afterwards — the file the hook reads on every push.
  const repo = makeRepo("main");
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-policy-guard-"));
  t.after(() =>
    Promise.all([rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }), rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })]),
  );
  const project = { name: "heroes-js", path: repo, remote: "github", mainBranch: "main", remoteBranchPolicy: "allow" };
  const out = await installGuard({
    projectPath: repo,
    worktree: repo,
    panelUrl: "http://127.0.0.1:7331",
    policy: policyForProject(project, "local-only"),
  });
  assert.equal(out.ok, true, `the guard installs: ${out.error || ""}`);
  const common = await commonDirOf(repo);
  const policyFile = readFileSync(guardPaths(common).policy, "utf8").trim();
  assert.equal(policyFile, "allow", "the guard's own copy of the policy is the project's, not the global local-only");

  // …and the shipped example declares exactly that shape: a local-only global with these two repos explicitly
  // allowed, because a blanket deny would break their landing path (push a branch, open a PR). config.json is the
  // reader's own file and is untracked; config.example.json is the copy every clone carries.
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  assert.equal(policyFrom(cfg.remoteBranchPolicy), "local-only", "the example's global is local-only");
  for (const name of ["agent-worktree-gui", "heroes-js"]) {
    const entry = (cfg.projects || []).find((p) => p.name === name);
    assert.ok(entry, `the example carries an explicit ${name} entry`);
    assert.equal(entry.remoteBranchPolicy, "allow", `${name} stays allowed to push a branch and open a PR`);
  }
});

test("a worker's run body names the parent its tree was really cut from", async (t) => {
  const stub = await stubGateway();
  const repos = [];
  const dirs = [];
  t.after(async () => {
    await stub.stop();
    for (const d of [...repos, ...dirs]) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // 1. A turnover branch: the tree is cut FROM it, so the worker is told to merge back into it locally and not push.
  const turnover = makeRepo("main");
  repos.push(turnover);
  git(turnover, ["checkout", "-q", "-b", "feature/turnover"]);
  const dirA = mkdtempSync(path.join(tmpdir(), "wtgui-policy-jobs-"));
  dirs.push(dirA);
  const jobsA = makeJobs(dirA, stub.url);
  t.after(() => jobsA.dispose());

  const jobA = await jobsA.create({ prompt: "probe the turnover branch", cwd: turnover, existing: false, project: "Menu" });
  const bodyA = stub.last();
  assert.equal(jobA.status !== "failed", true, `the run was accepted: ${jobA.error || ""}`);
  assert.match(bodyA, /cut from `feature\/turnover`/, `the body names the real parent, not main:\n${bodyA}`);
  assert.match(bodyA, /merging `[^`]+` into `feature\/turnover` LOCALLY and do not push/, "the body says to merge into the parent locally");
  assert.doesNotMatch(bodyA, /cut from `main`/, "the parent is read, never assumed to be main");
  assert.doesNotMatch(bodyA, /open a pull request/, "a tree cut from a turnover branch is not told to open a PR");

  // The cut is RECORDED, so a later worker in the same tree is told the same parent even though the tree has no
  // upstream and git remembers nothing about where it branched from.
  const treeA = jobA.worktreePath;
  const jobsA2 = makeJobs(dirA, stub.url);
  t.after(() => jobsA2.dispose());
  await jobsA2.create({ prompt: "follow-up in the same tree", cwd: treeA, existing: true, project: "Menu" });
  assert.match(stub.last(), /cut from `feature\/turnover`/, `a second run in the tree reads the recorded parent:\n${stub.last()}`);

  // 2. Cut from main: the opposite instruction — do not merge into it, push the branch and open a PR.
  git(turnover, ["checkout", "-q", "main"]);
  const jobsB = makeJobs(dirA, stub.url);
  t.after(() => jobsB.dispose());
  await jobsB.create({ prompt: "land a change", cwd: turnover, existing: false, project: "agent-worktree-gui", branchPolicy: "allow", remote: "github" });
  const bodyB = stub.last();
  assert.match(bodyB, /cut from `main`/, `a tree cut from main names main as its parent:\n${bodyB}`);
  assert.match(bodyB, /do not merge into it/, "it is told not to merge into the landing branch");
  assert.match(bodyB, /push it and open a pull request/, "it is told to push and open a PR");
  assert.doesNotMatch(bodyB, /merge `[^`]+` into `main` LOCALLY/, "never the turnover-branch instruction for a landing parent");

  // 3. A tree nobody can name (cut by hand, no record, no upstream) gets the blanket rule and NO invented parent.
  const handTree = path.join(turnover, ".worktrees", "by-hand");
  mkdirSync(path.dirname(handTree), { recursive: true });
  git(turnover, ["worktree", "add", "-q", "-b", "by-hand", handTree]);
  const jobsC = makeJobs(dirA, stub.url);
  t.after(() => jobsC.dispose());
  await jobsC.create({ prompt: "work in a hand cut tree", cwd: handTree, existing: true });
  const bodyC = stub.last();
  assert.doesNotMatch(bodyC, /cut from `/, `no parent is invented for a tree that records none:\n${bodyC}`);
  assert.match(bodyC, /LOCAL-ONLY/, "the blanket local-only rule stands instead");
});

// A project that NAMES its turnover branch is cut from it, even when its checkout stands on master. That is the
// defect this case exists for: a plain SPAWN cut from the project checkout's HEAD, so for a repo parked on master the
// parent read master and every worker was briefed to push a new remote branch - which is how children of an
// unpublished turnover branch reached the shared remote.
test("a project's turnover branch is the parent of a tree cut on a master checkout", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo("master");
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-policy-turnover-"));
  t.after(async () => {
    await stub.stop();
    rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  // The turnover branch carries one commit master does not, so the start point of the cut is provable.
  git(repo, ["checkout", "-q", "-b", "dmr-7-turnover"]);
  writeFileSync(path.join(repo, "turnover.txt"), "rolled up work\n");
  git(repo, ["add", "."]);
  commit(repo, "turnover work");
  const turnoverTip = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-q", "master"]);

  const jobs = makeJobs(dir, stub.url);
  t.after(() => jobs.dispose());
  const job = await jobs.create({
    prompt: "roll the fix up",
    cwd: repo,
    existing: false,
    project: "Menu",
    turnoverBranch: "dmr-7-turnover",
    branchPolicy: "allow",
    remote: "origin",
  });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.match(body, /cut from `dmr-7-turnover`/, `the turnover branch is the parent:\n${body}`);
  assert.match(body, /this project's turnover branch \(local only\)/, "the paragraph names the case it is in");
  assert.match(body, /merging `[^`]+` into `dmr-7-turnover` LOCALLY and do not push/, "the worker rolls up locally");
  assert.doesNotMatch(body, /push it and open a pull request|gh pr create/, "and is never told to open one");
  assert.doesNotMatch(body, /cut from `master`/, "the checkout's own branch is not the parent");
  // The cut really started at the turnover tip, and the reader's checkout did not move.
  assert.equal(git(job.worktreePath, ["rev-parse", "HEAD"]), turnoverTip, "the tree starts at the turnover branch's tip");
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "master", "the checkout is still where the reader left it");
});

// The paragraph's two halves, driven directly: the turnover case reads the same whether the branch is remote-backed
// or local only, and a landing parent may say a new remote branch is permitted ONLY when no turnover branch exists.
test("the turnover parent's paragraph is local-only, remote-backed or not, and main may push only without one", () => {
  const localOnly = branchLandingLine({
    parent: "feature/turnover",
    branch: "wtgui/roll-the-fix-up-a1b2c3",
    turnoverBranch: "feature/turnover",
    policy: "allow",
    remote: "origin",
  });
  assert.match(localOnly, /cut from `feature\/turnover` - this project's turnover branch \(local only\)/);
  assert.match(localOnly, /merging `[^`]+` into `feature\/turnover` LOCALLY and do not push/);
  assert.match(localOnly, /Do not open a pull request/);
  assert.doesNotMatch(localOnly, /push it and open a pull request|gh pr create/);

  const backed = branchLandingLine({
    parent: "feature/turnover",
    branch: "wtgui/roll-the-fix-up-a1b2c3",
    turnoverBranch: "feature/turnover",
    turnoverOnRemote: true,
    policy: "allow",
    remote: "origin",
  });
  assert.match(backed, /this project's turnover branch \(it is remote-backed/, "the remote-backed branch is named, not hidden");
  assert.match(backed, /merging `[^`]+` into `feature\/turnover` LOCALLY and do not push/, "and the instruction is the same one");
  assert.doesNotMatch(backed, /push it and open a pull request|gh pr create/);

  // A landing parent with no turnover branch keeps the push, and says why it is allowed to.
  const plain = branchLandingLine({ parent: "main", branch: "wtgui/x-a1b2c3", policy: "allow", remote: "origin" });
  assert.match(plain, /push it and open a pull request/);
  assert.match(plain, /A new remote branch is permitted here only because this project has no turnover branch configured and there is none on origin/);

  // A landing parent WITH one never says push: the work rolls into the declared branch instead.
  const declared = branchLandingLine({
    parent: "main",
    branch: "wtgui/x-a1b2c3",
    turnoverBranch: "feature/turnover",
    policy: "allow",
    remote: "origin",
  });
  assert.match(declared, /This project's turnover branch is `feature\/turnover`, so do not push a new remote branch/);
  assert.match(declared, /merging `[^`]+` into `feature\/turnover` LOCALLY and do not open a pull request/);
  assert.doesNotMatch(declared, /push it and open a pull request/);
  assert.doesNotMatch(declared, /`git push -u/);
});

// The stage's own case, and the one that was missing: a stage whose declared artifact is a document has nothing to
// land, so its worker is told to commit and report - on a tree cut from main, where the parent's paragraph used to say
// "push it and open a pull request". The paragraph is asserted where a worker READS it: the run body the spy gateway
// received. The ping-pong's drafter pushed a branch and opened PR #607 under the old rendering.
test("a stage whose artifact is not a pull request is local-only: commit and report, no push and no PR", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo("main");
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-policy-stage-"));
  t.after(async () => {
    await stub.stop();
    rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const jobs = makeJobs(dir, stub.url);
  t.after(() => jobs.dispose());

  // 1. The same tree, cut from main, for a stage whose artifact IS the pull request: the parent's rule, unchanged.
  await jobs.create({ prompt: "land the patch", cwd: repo, existing: false, project: "agent-worktree-gui", branchPolicy: "allow", remote: "github", remoteWrite: "pr" });
  const prBody = stub.last();
  assert.match(prBody, /cut from `main`/, `a pr stage keeps the parent's paragraph:\n${prBody}`);
  assert.match(prBody, /push it and open a pull request/, "a stage that lands by PR is still told to open one");
  assert.match(prBody, /gh pr create --fill/);

  // 2. The same cut, for a stage that writes a document: local-only, whatever the parent is.
  await jobs.create({ prompt: "write the draft", cwd: repo, existing: false, project: "agent-worktree-gui", branchPolicy: "allow", remote: "github", remoteWrite: "local" });
  const body = stub.last();
  assert.match(body, /This stage's artifact is not a pull request, so this tree is local-only/, `the stage's own case is rendered:\n${body}`);
  assert.match(body, /commit on `[^`]+` and report the commit/, "it is told to commit on the stage branch and report the commit");
  assert.doesNotMatch(body, /gh pr create/, "and never to open a PR");
  assert.doesNotMatch(body, /push it and open a pull request/, "nor to push the branch for one");
  assert.doesNotMatch(body, /cut from `main`/, "the parent is not named — it would not change the answer");

  // 3. A tree nobody can name still gets a true sentence, because the stage's case does not need the parent at all.
  const line = branchLandingLine({ localOnly: true, branch: "wtgui/write-the-draft-a1b2c3", policy: "allow" });
  assert.match(line, /^LANDING: /);
  assert.match(line, /local-only/);
  assert.doesNotMatch(line, /\{\{|\$/, "no placeholders in a sentence a worker has to obey");
});

test("the panel's own assistant is handed no landing paragraph at all", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-policy-assistant-"));
  t.after(async () => {
    await stub.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const jobs = makeJobs(dir, stub.url);
  t.after(() => jobs.dispose());

  // How lib/assistant.js starts its own turn: no worktree, and `anchorCwd: false` because it reads the board rather
  // than working in a directory. There is no tree, so there is nothing to land and nothing to promise.
  await jobs.create({
    prompt: "what is on the board?",
    cwd: dir,
    worktree: false,
    anchorCwd: false,
    preamble: "the board digest rides here",
  });
  const body = stub.last();
  assert.match(body, /the board digest rides here/, "the assistant's own context still rides ahead of its prompt");
  assert.doesNotMatch(body, /LANDING: this worktree/, "no landing paragraph on the assistant's turn");
  assert.doesNotMatch(body, /cut from `/, "nothing about parents on the assistant's turn");
  assert.doesNotMatch(body, /do not \`git push\`/, "no push rule on the assistant's turn");
});
