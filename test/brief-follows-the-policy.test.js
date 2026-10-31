// The first line of a worker's brief tells the truth about where its branch goes — and keeps telling it on every turn.
//
// What this pins, each one a way a tree in a project that ALLOWS pushes was once briefed as local-only:
//
//   1. the blanket paragraph follows the policy in force: `allow` is not "local-only … a push will park and then fail";
//   2. a tree cut from main is told, on its FIRST turn, to push and open a pull request — with the parent book wired in
//      the way server.js wires it (`jobs.parents = new ParentBook(…)`). A Jobs built without one hid the fault: the
//      parent book's record is an OBJECT, and handing it over as the parent printed "cut from `[object Object]`";
//   3. the same tree is told the same thing on a LATER turn, after the panel has renamed its branch (lib/tree-names.js
//      changes the slug and keeps the six-hex tag) — the parent is recorded under the tag, not under the old name;
//   4. a reply reaches the worker with its project's policy and remote, through the real /api/agents/reply route.
//
// The run body is read off a stub Runs API that records what was actually POSTed: "what the worker reads" is the claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs, remoteWriteLine } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { configureRepo, git as runGit, post, startPanel } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test, and the developer's real session store is none
// of this suite's business. Set before any Jobs is constructed.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-brief-home-"));
process.env.API_SERVER_KEY = "";

const git = (dir, args) => {
  try {
    return runGit(dir, args);
  } catch (e) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${String((e && e.message) || e)}`);
  }
};
// The panel's own git calls (what a finished turn left behind) can still hold a ref lock for a moment when a test
// renames the branch right after the run ends, and the lock is the panel's, not the thing under test: ask again.
async function gitSettled(dir, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return git(dir, args);
    } catch (e) {
      if (attempt >= 20 || !/.lock|Unable to create|cannot lock/i.test(String((e && e.message) || e))) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
const commit = (dir, message = "work") =>
  git(dir, ["commit", "-q", "--allow-empty", "-m", message]);

function makeRepo(branch = "main") {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-brief-repo-"));
  git(dir, ["init", "-q", "-b", branch]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# brief sandbox\n");
  git(dir, ["add", "."]);
  commit(dir, "first");
  return dir;
}

const sweep = (...dirs) => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* background measureTree git handle on Windows; OS temp is throwaway */
    }
  }
};

// The smallest gateway that accepts a run and records its body. `/v1/capabilities` is answered too, because the real
// panel probes it before it promises a card.
async function stubGateway() {
  const submitted = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ version: "stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, model_options: true } }));
    }
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

// A Jobs pointed at the stub with its store in a temp dir — wired the way server.js wires it, parent book included.
function makeJobs(dir, url) {
  const jobs = new Jobs({
    config: { apiServer: { url }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 3600 },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.parents = new ParentBook({ file: path.join(dir, "logs", "parents.json") });
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

test("the blanket paragraph follows the policy in force instead of always saying local-only", () => {
  const tree = "C:/work/proj/.worktrees/x-aaaaaa";
  const dflt = remoteWriteLine({}, tree);
  assert.match(dflt, /^LOCAL-ONLY: this worktree/, "no policy given is the default, which is local-only");
  assert.match(dflt, /a push you attempt will park and then fail/);

  const local = remoteWriteLine({ branchPolicy: "local-only" }, tree);
  assert.equal(local, dflt, "an explicit local-only is the same paragraph as no policy");

  const allow = remoteWriteLine({ branchPolicy: "allow" }, tree);
  assert.match(allow, /^REMOTE WRITES ALLOWED: /);
  assert.match(allow, /lets a push from this worktree \(C:\/work\/proj\/\.worktrees\/x-aaaaaa\) through without asking/);
  assert.match(allow, /when the reader asks/, "it is still not a licence to push probes by itself");
  assert.doesNotMatch(allow, /LOCAL-ONLY|will park|do not `git push`/, "nothing in it says the tree cannot push");

  const deny = remoteWriteLine({ policy: "deny" }, tree);
  assert.match(deny, /^NO REMOTE WRITES: /);
  assert.match(deny, /do not `git push`, do not create a remote branch and do not open a pull request/);

  // A run started to land is a different paragraph, and it stays one whatever the policy says.
  assert.match(remoteWriteLine({ remoteWrite: "land", remote: "origin", branchPolicy: "local-only" }, tree), /^WILL LAND: /);
});

let sharedRepo = null;
test.before(() => {
  sharedRepo = makeRepo("main");
});
test.after(() => {
  if (sharedRepo) sweep(sharedRepo);
});

test("a tree cut from main is told to push for a pull request, on its first turn and after its branch is renamed", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-brief-jobs-"));
  const repo = sharedRepo;
  const jobsA = makeJobs(dir, stub.url);
  let jobsB = null;
  t.after(async () => {
    jobsA.dispose();
    jobsB?.dispose();
    await stub.stop();
    sweep(dir);
  });

  // ---- the first turn: the panel cuts the tree from main -------------------------------------------------------
  const first = await jobsA.create({ prompt: "land a change", cwd: repo, existing: false, project: "fixture", branchPolicy: "allow", remote: "origin" });
  assert.notEqual(first.status, "failed", `the run was accepted: ${first.error || ""}`);
  const body1 = stub.last();
  assert.doesNotMatch(body1, /\[object Object\]/, `the parent is a name, never a stringified record:\n${body1}`);
  assert.match(body1, /cut from `main` — a landing branch, so do not merge into it/);
  assert.match(body1, /`git push -u origin HEAD` then `gh pr create --fill`/, "the push is spelled out with the project's own remote");
  assert.match(body1, /Remote writes are allowed for this project, so a push is not asked about/, "and it quotes the guard truthfully");
  assert.doesNotMatch(body1, /LOCAL-ONLY|LOCALLY and do not push/, "nothing in the brief says this tree cannot push");

  // ---- the panel renames the branch (the slug changes, the six-hex tag stays) ----------------------------------
  const tree = first.worktreePath;
  const tag = String(first.branch).slice(-6);
  const renamed = `wtgui/a-much-better-name-${tag}`;
  await gitSettled(tree, ["branch", "-m", first.branch, renamed]);
  assert.equal(git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]), renamed, "the tree is now on a branch its record has never heard of");

  // ---- a later turn, on a fresh Jobs (a restarted panel reads the record back from disk) ------------------------
  jobsB = makeJobs(dir, stub.url);
  await jobsB.create({ prompt: "Keep going", cwd: tree, reply: true, ownerPath: tree, project: "fixture", branchPolicy: "allow", remote: "origin" });
  const body2 = stub.last();
  assert.doesNotMatch(body2, /\[object Object\]/);
  assert.match(body2, /cut from `main` — a landing branch/, `a renamed tree still reads where it was cut from:\n${body2}`);
  assert.match(body2, /push it and open a pull request/);
  assert.match(body2, /Remote writes are allowed for this project/);
  assert.doesNotMatch(body2, /LOCAL-ONLY|will park and then fail/, "the reply is not told the blanket local-only rule");

  // ---- a tree whose branch merely LOOKS like another is not the recorded tree --------------------------------
  // The same directory switched to a branch with no tag in its name is a different piece of work: the record is not
  // handed to it just because the directory is the same.
  await gitSettled(tree, ["switch", "-q", "-c", "scratch/unrelated"]);
  const asked = await jobsB.parentBranchFor({ tree, branch: null, known: null });
  assert.equal(asked, null, "an untagged branch in the recorded directory does not inherit the record");
});

test("a parent that is not a name is never handed over as one", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-brief-name-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });
  // The shape the parent book's record has: an object, with a `parent` of null for a tree cut from main.
  const record = { project: "p", branch: "wtgui/x-abcdef", parent: null, parentRef: "main", parentSource: "unknown" };
  assert.equal(await jobs.parentBranchFor({ tree: dir, branch: "detached-nothing-aaaaaa", known: record }), null, "an object is ignored, not stringified");
  assert.equal(await jobs.parentBranchFor({ tree: dir, branch: "x-aaaaaa", known: "deadbeefcafe1234" }), null, "a sha is not a branch to land on");
  assert.equal(await jobs.parentBranchFor({ tree: dir, branch: "x-aaaaaa", known: " feature/turnover " }), "feature/turnover", "a name is trimmed and kept");
});

test("a tree nobody can name still follows its project's policy", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-brief-hand-"));
  const repo = sharedRepo;
  const handTree = path.join(repo, ".worktrees", "by-hand");
  git(repo, ["worktree", "add", "-q", "-b", "by-hand", handTree]);
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });

  await jobs.create({ prompt: "work in a hand cut tree", cwd: handTree, existing: true, branchPolicy: "allow" });
  const allowed = stub.last();
  assert.doesNotMatch(allowed, /cut from `/, "no parent is invented for a tree that records none");
  assert.match(allowed, /REMOTE WRITES ALLOWED/, "the project allows pushes, so the blanket line says so");
  assert.doesNotMatch(allowed, /LOCAL-ONLY/);

  await jobs.create({ prompt: "work in a hand cut tree", cwd: handTree, existing: true });
  assert.match(stub.last(), /LOCAL-ONLY/, "with no policy named, the default rule stands");
});

test("the reply route briefs a worker with the policy and remote of its tree's project", async (t) => {
  const stub = await stubGateway();
  const repo = sharedRepo;
  const panel = await startPanel({
    config: {
      apiServer: { url: stub.url, key: "sandbox-key" },
      // The GLOBAL says local-only; only the project's own override allows. A reply that fell back to the global would
      // brief this worker as local-only, which is the whole fault.
      remoteBranchPolicy: "local-only",
      projects: [{ name: "fixture", path: repo, remote: "origin", mainBranch: "main", remoteBranchPolicy: "allow" }],
    },
  });
  t.after(async () => {
    await panel.stop();
    await stub.stop();
  });

  const spawned = await post(panel.base, "/api/agents", { body: { prompt: "create a second landing tree", cwd: repo, project: "fixture", reasoningEffort: "medium" } });
  assert.equal(spawned.status, 202, `the spawn is accepted: ${spawned.text}`);
  const job = spawned.json.job;
  const body1 = String(stub.submitted[0]?.input || "");
  assert.deepEqual(stub.submitted[0]?.model_options, { reasoning: { enabled: true, effort: "medium" } }, "the chosen reasoning level reaches the gateway, not just the card");
  assert.equal(job.reasoningEffort, "medium", "the setting is returned on the actual job");
  assert.match(body1, /cut from `main` — a landing branch/, `the first turn is told to land by pull request:\n${body1}`);
  assert.doesNotMatch(body1, /\[object Object\]/);

  // Wait for the first turn to settle, then rename its branch the way the panel does after a first turn.
  const until = Date.now() + 20_000;
  let settled = null;
  while (Date.now() < until) {
    const all = await (await fetch(`${panel.base}/api/jobs`)).json();
    settled = (all.jobs || all).find((j) => j.id === job.id);
    if (settled && !["starting", "running", "queued"].includes(settled.status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(settled && !["starting", "running", "queued"].includes(settled.status), `the first turn settled: ${settled?.status}`);
  const tree = settled.worktreePath || job.worktreePath;
  assert.ok(tree, "the job names its tree");
  await gitSettled(tree, ["branch", "-m", settled.branch || job.branch, `wtgui/renamed-after-the-first-turn-${String(settled.branch || job.branch).slice(-6)}`]);

  const replied = await post(panel.base, "/api/agents/reply", { body: { thread: job.thread, text: "Keep going" } });
  assert.equal(replied.status, 202, `the reply is accepted: ${replied.text}`);
  const body2 = String(stub.submitted[1]?.input || "");
  assert.deepEqual(stub.submitted[1]?.model_options, { reasoning: { enabled: true, effort: "medium" } }, "replies keep the reasoning level selected at spawn");
  assert.equal(replied.json.job.reasoningEffort, "medium");
  assert.equal(stub.submitted[1]?.session_id, stub.submitted[0]?.session_id, "the route continues the same conversation");
  assert.equal(Object.hasOwn(stub.submitted[1], "conversation_history"), false, "the route does not replace the saved history");
  assert.ok(body2.includes("use absolute paths"), "the reply still re-anchors its tools");
  assert.ok(replied.json.job.lines.some((line) => line.kind === "init" && line.text.includes(`continuing session ${job.thread} · turn 2`)));
  assert.ok(!replied.json.job.lines.some((line) => /asked to work in|⇢ workspace /.test(line.text)), "no repeated setup note on the route's returned card");
  assert.match(body2, /cut from `main` — a landing branch/, `the reply is briefed like the first turn:\n${body2}`);
  assert.match(body2, /`git push -u origin HEAD`/, "with the project's own remote, not a placeholder");
  assert.match(body2, /Remote writes are allowed for this project, so a push is not asked about/, "and the project's policy, not the global one");
  assert.doesNotMatch(body2, /LOCAL-ONLY|will park and then fail/, "the continuation is not told the tree is local-only");
});
