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
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { RestartController } from "../lib/restart.js";
import { judgeLanded, pickBase } from "../lib/assistant/landed.js";
import { resolveExistingTarget } from "../lib/spawn-target.js";

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

// ---- the replay itself: a debt whose tree is not there -------------------------------------------
//
// `judgeLanded` answers `gone` for a tree that is missing or that is only a SHELL — an empty `.worktrees/`
// directory the removal left behind, where every `git -C` call walks up and answers for the primary checkout.
// skipLandedReplays used to read that verdict and then drop it (`if (!verdict.landed) continue;`), so the debt
// stayed owed, the digest kept advertising it, and every boot re-issued it. These drive the pass itself.
const replayBoard = async (t, project) => {
  const store = await mkdtemp(path.join(tmpdir(), "wtgui-replay-"));
  const started = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(store, "jobs.json"),
      defaultCwd: store,
      assistantFile: path.join(store, "assistant.json"),
      charterFile: path.join(store, "assistant-charter.md"),
    },
    jobs: {
      list: () => [],
      get: () => null,
      firstOfThread: () => null,
      busyFor: () => ({ held: false, where: null, by: [] }),
    },
    getProjects: () => [{ name: path.basename(project), path: project, mainBranch: "main", remote: "origin" }],
    spawner: async (spec) => {
      started.push(spec);
      return null;
    },
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(async () => {
    clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(store, { recursive: true, force: true });
  });
  return { assistant, started };
};
const debt = (over = {}) => ({
  id: "debt0001",
  turnId: "turn-debt",
  thread: "wtgui-landed-brief",
  at: Date.now() - 10 * 60_000,
  target: "(none)",
  existing: true,
  prompt: "the brief whose tree is not there",
  outcome: "lost",
  tree: null,
  branch: null,
  ...over,
});

test("an EMPTY leftover directory is not a tree: the verdict is `gone`, not the primary checkout's branch", async () => {
  // The shape that made the 0.58.2 boot read a dead tree as landed: the worktree was removed and the empty
  // directory stayed behind, so `existsSync` said yes and `git rev-parse --abbrev-ref HEAD` inside it said `main`
  // — the PRIMARY checkout's branch, already in origin/main.
  const p = repo("replay-husk");
  const husk = path.join(p, ".worktrees", "landed-brief-bdf617");
  mkdirSync(husk, { recursive: true });
  assert.deepEqual(readdirSync(husk), [], "the fixture is an EMPTY directory that still exists");
  assert.equal(git(husk, "rev-parse", "--abbrev-ref", "HEAD"), "main", "…and git inside it answers for the primary checkout");

  const verdict = await judgeLanded({ tree: husk, branch: "wtgui/landed-brief-bdf617" });
  assert.equal(verdict.gone, true, "an empty directory where a tree used to be is GONE");
  assert.equal(verdict.landed, false);
  assert.match(verdict.why, /leftover directory/);
  assert.match(verdict.why, /replay-husk/, "the reason names the checkout git would answer for");
});

test("a debt whose tree is a leftover directory is SETTLED, journalled and not started", async (t) => {
  const p = repo("replay-settle-husk");
  const husk = path.join(p, ".worktrees", "landed-brief-da6402");
  mkdirSync(husk, { recursive: true });
  const { assistant, started } = await replayBoard(t, p);
  assistant.spawnIntents = [debt({ target: husk, tree: husk, branch: "wtgui/landed-brief-da6402" })];

  const out = await assistant.skipLandedReplays();
  assert.equal(out.length, 1, "the debt is settled rather than left owed");
  assert.equal(assistant.spawnIntents[0].outcome, "landed");
  assert.match(String(assistant.spawnIntents[0].landedWhy), /leftover directory/);
  assert.equal(started.length, 0, "no replay was started");

  const line = assistant.journal.find((j) => j.kind === "replay-skipped");
  assert.ok(line, "the skip is journalled");
  assert.match(String(line.text), /replay skipped: already landed/);
  assert.match(String(line.text), /leftover directory/);
  assert.match(String(line.text), /nothing was started/);
  assert.doesNotMatch(assistant.digest(), /the brief whose tree is not there/, "the digest stops advertising the debt");
});

test("a debt written before the tree and branch were recorded is settled too", async (t) => {
  // Every SPAWN recorded before #213 carries no tree at all, and `tree = ""` fell through the same
  // `!verdict.landed` continue — so those debts were re-advertised on every boot as well.
  const p = repo("replay-bare");
  const { assistant, started } = await replayBoard(t, p);
  assistant.spawnIntents = [debt({ target: path.basename(p), existing: false })];

  const out = await assistant.skipLandedReplays();
  assert.equal(out.length, 1);
  assert.equal(assistant.spawnIntents[0].outcome, "landed");
  assert.match(String(assistant.spawnIntents[0].landedWhy), /names no tree/);
  assert.equal(started.length, 0);
  assert.match(String(assistant.journal.find((j) => j.kind === "replay-skipped")?.text || ""), /names no tree at all/);
});

test("a debt whose tree is missing outright is settled as gone", async (t) => {
  const p = repo("replay-missing");
  const gone = path.join(p, ".worktrees", "vanished-brief-9bfebb");
  const { assistant, started } = await replayBoard(t, p);
  assistant.spawnIntents = [debt({ target: gone, tree: gone, branch: "wtgui/vanished-brief-9bfebb" })];

  const out = await assistant.skipLandedReplays();
  assert.equal(out.length, 1);
  assert.equal(assistant.spawnIntents[0].outcome, "landed");
  assert.match(String(assistant.spawnIntents[0].landedWhy), /tree is gone/);
  assert.equal(started.length, 0);
});

test("a live tree holding work main does not have is NOT settled — the skip must not over-reach", async (t) => {
  const p = repo("replay-live");
  const wt = path.join(p, ".worktrees", "live-brief-abc123");
  git(p, "checkout", "-q", "-b", "wtgui/live-brief-abc123");
  writeFileSync(path.join(p, "live.txt"), "not on main\n", "utf8");
  git(p, "add", ".");
  git(p, "commit", "-q", "-m", "the brief main does not hold");
  git(p, "checkout", "-q", "main");
  git(p, "worktree", "add", "-q", wt, "wtgui/live-brief-abc123");
  const { assistant, started } = await replayBoard(t, p);
  assistant.spawnIntents = [debt({ target: wt, tree: wt, branch: "wtgui/live-brief-abc123" })];

  const out = await assistant.skipLandedReplays();
  assert.equal(out.length, 0, "work main does not hold is not a landing");
  assert.equal(assistant.spawnIntents[0].outcome, "lost");
  assert.equal(started.length, 0);
  assert.match(assistant.digest(), /the brief whose tree is not there/, "…and it stays on the digest as owed");
});

test("a SPAWN IN a leftover directory is refused, and the refusal names the checkout it would have run in", async () => {
  // The other end of the same bug: the route accepted the husk (`isDir` was true), so the replay's run got the
  // husk as its cwd and every git call in it answered for the primary checkout.
  const p = repo("resolve-husk");
  const husk = path.join(p, ".worktrees", "gone-brief-da6402");
  mkdirSync(husk, { recursive: true });
  const projects = [{ name: "resolve-husk", path: p }];

  const refused = await resolveExistingTarget({ target: husk, projects });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "leftover");
  assert.match(refused.error, /not a tree any more/);
  assert.match(refused.error, /resolve-husk/, "the refusal says which checkout would have run it");

  const own = await resolveExistingTarget({ target: p, projects });
  assert.equal(own.ok, true, "a project's own checkout is still a tree to start in");
});
