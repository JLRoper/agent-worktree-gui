// The three small rules the restart storm needed, at their own scale: no restart without a reason, a wait that
// can be withdrawn before it runs, and a boot that does not replay a brief whose work already landed.
//
//   node --test test/restart-idempotence.test.js
//
// The controller half drives the real RestartController with a fake job store (only `list`/`runningJobs`, which is
// all the wait reads) and an injected restart command, so a test never bounces anything. The landedness half uses
// throwaway git repositories, because the rule under test IS git's answer: patch-id, tree equality and the PR —
// never "ahead by N".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RestartController } from "../lib/restart.js";
import { judgeLanded, pickBase } from "../lib/assistant/landed.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-restart-idem-"));
const home = path.join(dir, "hermes");
mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, ".env"), "OPENROUTER_API_KEY=test-key\n", "utf8");

let seq = 0;
// Only what the controller's wait reads: a list of jobs with threads and statuses.
const fakeJobs = (jobs = []) => {
  const store = { jobs, list: () => store.jobs, runningJobs: () => store.jobs.filter((j) => j.status === "running") };
  return store;
};
const makeController = (over = {}) => {
  const runs = [];
  const controller = new RestartController({
    config: { restartFile: path.join(dir, `restart-${++seq}.json`), pythonBin: "node" },
    jobs: over.jobs || fakeJobs(),
    assistant: null,
    home,
    log: () => {},
    credentials: () => ({ url: "http://127.0.0.1:1", key: "k" }),
    // The one thing substituted: the command. The verdict (pid guard, proof) is not injectable, and no test here
    // reaches it — a restart that starts at all is the failure these tests look for.
    runGatewayRestart: () => {
      runs.push(Date.now());
      return { command: "stub gateway restart", pid: 4242, at: new Date().toISOString() };
    },
    identity: () => null,
    gatewayState: () => null,
    proveGateway: () => ({ ok: true, ms: 1, runId: "proof-1", status: "completed", output: "ok" }),
    pollMs: 40,
    identityWaitMs: 200,
    identityPollMs: 20,
    ...over,
  });
  return { controller, runs };
};

test("a restart with no reason is a 400, and nothing is queued", async () => {
  const { controller, runs } = makeController();
  for (const request of [{ target: "gateway" }, { target: "gateway", reason: "" }, { target: "gateway", reason: "   " }, { target: "panel", reason: null }]) {
    assert.throws(
      () => controller.request(request),
      (e) => e.status === 400 && /reason/.test(e.message),
      JSON.stringify(request),
    );
  }
  assert.equal(controller.state().queued.length, 0, "a refused request leaves no wait behind");
  await sleep(150);
  assert.equal(runs.length, 0, "and it starts nothing");
});

test("a reason is kept, trimmed, and the request is still accepted at once", async () => {
  const { controller } = makeController({ jobs: fakeJobs([{ thread: "held", status: "running" }]) });
  const rec = controller.request({ target: "gateway", reason: "  pick up the new config  ", waitFor: "held" });
  assert.equal(rec.accepted, true);
  assert.equal(rec.reason, "pick up the new config");
  assert.equal(controller.state().queued[0].waitFor, "held");
  controller.cancel(rec.id);
});

test("a waiting entry can be cancelled, and then the restart never runs", async () => {
  const jobs = fakeJobs([{ thread: "held", status: "running" }]);
  const { controller, runs } = makeController({ jobs });
  const rec = controller.request({ target: "gateway", reason: "a wait worth dropping", waitFor: "held" });
  await sleep(120); // let the loop reach its poll
  assert.equal(controller.state().queued[0].state, "waiting");

  const out = controller.cancel(rec.id);
  assert.equal(out.dropped, true);
  assert.equal(out.id, rec.id);
  assert.equal(out.queue.length, 0);
  assert.equal(controller.state().queued.length, 0);
  assert.ok(controller.state().journal.some((j) => /cancelled before it ran/.test(j.text)), "the withdrawal is journalled");
  assert.equal(controller.state().last, null, "a cancelled wait is not a restart");

  // The turn it was waiting for ends. Without the loop's own check the entry would now execute.
  jobs.jobs[0].status = "done";
  await sleep(400);
  assert.equal(runs.length, 0, "the wait ended and nothing restarted");
  assert.equal(controller.state().running, null);
  assert.equal(controller.state().last, null);
});

test("cancelling is about a wait only: an unknown id is null, an empty id is a 400", async () => {
  const { controller } = makeController();
  assert.equal(controller.cancel("nope"), null);
  assert.throws(() => controller.cancel(""), (e) => e.status === 400);
});

// ---- the landedness rule -------------------------------------------------------------------------
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", `user.email=${["tester", "example.invalid"].join(String.fromCharCode(64))}`, "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    windowsHide: true,
  }).trim();
const repo = (name) => {
  const p = path.join(dir, name);
  mkdirSync(p, { recursive: true });
  git(p, "init", "-q", "-b", "main");
  writeFileSync(path.join(p, "README.md"), "# fixture\n", "utf8");
  git(p, "add", ".");
  git(p, "commit", "-q", "-m", "first");
  return p;
};

test("a branch ahead by one whose commit was cherry-picked has LANDED (patch-id, not a count)", async () => {
  const p = repo("cherry");
  git(p, "checkout", "-q", "-b", "feature/brief");
  writeFileSync(path.join(p, "brief.txt"), "the brief\n", "utf8");
  git(p, "add", ".");
  git(p, "commit", "-q", "-m", "the brief");
  const sha = git(p, "rev-parse", "HEAD");
  git(p, "checkout", "-q", "main");
  // The base moves on first, so the cherry-pick cannot reproduce the same commit object.
  writeFileSync(path.join(p, "base.txt"), "the base moved\n", "utf8");
  git(p, "add", ".");
  git(p, "commit", "-q", "-m", "the base moves on");
  git(p, "cherry-pick", sha);

  assert.equal(git(p, "rev-list", "--count", "main..feature/brief"), "1", "the fixture is ahead — a count would call it unlanded");
  assert.match(git(p, "cherry", "-v", "main", "feature/brief"), /^- /, "and every commit of its own is on main by patch-id");

  const verdict = await judgeLanded({ tree: p, branch: "feature/brief" });
  assert.equal(verdict.landed, true);
  assert.equal(verdict.evidence, "patch-id");
  assert.equal(await pickBase(p), "main");
});

test("a branch whose tree is main's tree has LANDED (nothing left to replay)", async () => {
  const p = repo("tree");
  git(p, "checkout", "-q", "-b", "feature/noop");
  writeFileSync(path.join(p, "temp.txt"), "added\n", "utf8");
  git(p, "add", ".");
  git(p, "commit", "-q", "-m", "add it");
  git(p, "rm", "-q", "temp.txt");
  git(p, "commit", "-q", "-m", "and take it away");
  assert.equal(git(p, "rev-parse", "feature/noop^{tree}"), git(p, "rev-parse", "main^{tree}"), "the fixture's trees are identical");
  const verdict = await judgeLanded({ tree: p, branch: "feature/noop" });
  assert.equal(verdict.landed, true);
  assert.equal(verdict.evidence, "tree");
});

test("a branch with work main does not hold has NOT landed", async () => {
  const p = repo("open");
  git(p, "checkout", "-q", "-b", "feature/open");
  writeFileSync(path.join(p, "open.txt"), "unfinished\n", "utf8");
  git(p, "add", ".");
  git(p, "commit", "-q", "-m", "not on main");
  const verdict = await judgeLanded({ tree: p, branch: "feature/open" });
  assert.equal(verdict.landed, false);
  assert.equal(verdict.gone, undefined);
  assert.match(verdict.why, /holds work main does not|main does not/);
});

test("a tree that is gone is a skip with a reason — never a guess at another tree", async () => {
  const verdict = await judgeLanded({ tree: path.join(dir, "no-such-tree"), branch: "feature/whatever" });
  assert.equal(verdict.landed, false);
  assert.equal(verdict.gone, true);
  assert.match(verdict.why, /tree is gone/);
});

test("a merged PR is the last authority when git cannot see the landing (a squash)", async () => {
  const p = repo("pr");
  git(p, "checkout", "-q", "-b", "feature/squashed");
  writeFileSync(path.join(p, "squash.txt"), "squashed\n", "utf8");
  git(p, "add", ".");
  git(p, "commit", "-q", "-m", "the brief");
  // The branch's work is NOT on main here — only the merged PR says it landed.
  const withoutPr = await judgeLanded({ tree: p, branch: "feature/squashed" });
  assert.equal(withoutPr.landed, false);
  const withPr = await judgeLanded({ tree: p, branch: "feature/squashed", pr: { number: 12, state: "MERGED" } });
  assert.equal(withPr.landed, true);
  assert.equal(withPr.evidence, "pr");
  assert.match(withPr.why, /#12/);
});
