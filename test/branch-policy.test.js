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
import { policyForProject, policyFrom } from "../lib/remote-writes.js";
import { installGuard, guardPaths, commonDirOf } from "../lib/push-guard.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Off this box's own Hermes install: a run body is what is under test, and reading the developer's real session
// store for its counters is both slow and none of this suite's business. Set before any Jobs is constructed.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-policy-home-"));
process.env.API_SERVER_KEY = "";

const git = (dir, args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim();
  } catch (e) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${String((e && e.message) || e)}`);
  }
};
const commit = (dir, message = "work") =>
  git(dir, ["-c", "user.name=policy-test", "-c", "user.email=policy@localhost", "commit", "-q", "--allow-empty", "-m", message]);

// A repo with one commit on `branch`, ready to be cut from. `-b <branch>` is what makes the parent interesting: the
// panel branches from whatever this checkout has checked out, and the whole point is that it is not always main.
function makeRepo(branch = "main") {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-policy-repo-"));
  git(dir, ["init", "-q", "-b", branch]);
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

  // …and this checkout's own config.json declares exactly that shape: a local-only global with these two repos
  // explicitly allowed, because a blanket deny would break their landing path (push a branch, open a PR).
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
  assert.equal(policyFrom(cfg.remoteBranchPolicy), "local-only", "config.json's global is local-only");
  for (const name of ["agent-worktree-gui", "heroes-js"]) {
    const entry = (cfg.projects || []).find((p) => p.name === name);
    assert.ok(entry, `config.json carries an explicit ${name} entry`);
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
  const onMain = makeRepo("main");
  repos.push(onMain);
  const jobsB = makeJobs(dirA, stub.url);
  t.after(() => jobsB.dispose());
  await jobsB.create({ prompt: "land a change", cwd: onMain, existing: false, project: "agent-worktree-gui", branchPolicy: "allow", remote: "github" });
  const bodyB = stub.last();
  assert.match(bodyB, /cut from `main`/, `a tree cut from main names main as its parent:\n${bodyB}`);
  assert.match(bodyB, /do not merge into it/, "it is told not to merge into the landing branch");
  assert.match(bodyB, /push it and open a pull request/, "it is told to push and open a PR");
  assert.doesNotMatch(bodyB, /merge `[^`]+` into `main` LOCALLY/, "never the turnover-branch instruction for a landing parent");

  // 3. A tree nobody can name (cut by hand, no record, no upstream) gets the blanket rule and NO invented parent.
  const handCut = makeRepo("main");
  repos.push(handCut);
  const handTree = path.join(handCut, ".worktrees", "by-hand");
  mkdirSync(path.dirname(handTree), { recursive: true });
  git(handCut, ["worktree", "add", "-q", "-b", "by-hand", handTree]);
  const jobsC = makeJobs(dirA, stub.url);
  t.after(() => jobsC.dispose());
  await jobsC.create({ prompt: "work in a hand cut tree", cwd: handTree, existing: true });
  const bodyC = stub.last();
  assert.doesNotMatch(bodyC, /cut from `/, `no parent is invented for a tree that records none:\n${bodyC}`);
  assert.match(bodyC, /LOCAL-ONLY/, "the blanket local-only rule stands instead");
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
