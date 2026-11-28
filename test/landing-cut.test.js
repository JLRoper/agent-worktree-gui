// THE LANDING CUT: a landing task gets its own turnover branch, keyed to its task id, at the cut - and an
// implementation never stands at the repository root.
//
// The reader's model (2026-11-28): root trees are research or turnover, never implementation. A small one-off that
// will land is a SINGLE turnover branch carrying its research and implementation. The panel used to default the base
// to the checkout, so implementation-at-root was the default shape. The reader decided: when a small landing task has
// no turnover branch, the panel CREATES one automatically, keyed to the task id, and cuts the worker on it - no ask.
//
// What this file pins, one claim per test:
//
//   1. a brief that names landing work is a LANDING brief whatever its opening words say (the kind follows the verb,
//      not the first sentence);
//   2. a landing cut with no registered branch makes one, keyed to its task id, and two keys both read back from the
//      registry, which accumulates and is never overwritten; a second cut for one key reuses its branch;
//   3. a landing cut that names no key is refused by the cut, in the sentence that says why, and nothing is cut;
//   4. a registered turnover branch that has already landed is refused by name: a landed branch is not a container;
//   5. the SPAWN carries the task id as its landing key and its queue row, and the job record stamps the row.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { inferKindFromBrief, landingSignal, planCut } from "../lib/branch-kind.js";
import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { planTurnoverCut, turnoverLookup } from "../lib/project-turnover.js";

const EMAIL = ["landing", "example.invalid"].join(String.fromCharCode(64));
const FIXED_AT = new Date("2026-11-26T18:00:00");

// A real repository on main, with one commit: the cut reads the checkout's own branch, so every cut below is a real
// `git worktree add` rather than a comparison of strings.
function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-landing-cut-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Landing Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Landing Fixture");
  git("config", "user.email", EMAIL);
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "seed.txt"), "the base's own work\n");
  git("add", "-A");
  git("commit", "-qm", "the base's own work");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, git };
}

function jobsAt(dir) {
  const jobs = new Jobs({
    config: { apiServer: { url: "http://127.0.0.1:1" }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 60 },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.parents = new ParentBook({ file: path.join(dir, "logs", "parents.json"), onLog: () => {} });
  return jobs;
}

// The registry a cut reads and writes: one project record, its list accumulating one entry per key, exactly the
// shape `server.js` `rememberTurnoverBranch` writes.
function registryOf(project) {
  const registry = { projects: [project] };
  return registry;
}

test("1. a landing verb makes the brief a landing cut, whatever its first sentence says", () => {
  // THE OPENING WORDS ARE NOT THE SIGNAL. This file's own brief opens with "LANDING:" and only later names the merge;
  // an issue row opens with "Row #402 is the complete brief" and says "push and open the PR" at the end.
  const brief = "Row #402 is the complete brief. When the work is done, merge the branch locally and do not push.";
  assert.equal(landingSignal(brief), "merge", "the landing verb is found");
  assert.equal(inferKindFromBrief(brief), "implementation", "a landing brief is a landing cut");
  const plan = planCut({ parent: "main", brief });
  assert.equal(plan.kind, "implementation");
  assert.match(plan.why, /landing work \("merge"\)/, "the record says which verb decided it");

  // A landing verb that is naming the machinery is a description, not an order: these stay research.
  assert.equal(inferKindFromBrief("why does the merge status read wrong?"), "research");
  assert.equal(inferKindFromBrief("Research how the push guard decides a branch, and report."), "research");
  // With no landing and no code signal, the brief is research exactly as before.
  assert.equal(inferKindFromBrief("how does the roll-up decide which branch it reads?"), "research");
  assert.equal(landingSignal("how does the roll-up decide?"), "");
});

test("2. a landing cut makes its own turnover branch keyed to its task id, and two keys both read back", async (t) => {
  const r = repo(t);
  const jobs = jobsAt(r.dir);
  const project = { name: "demo", mainBranch: "main", turnoverBranches: [], turnoverPolicy: "ask" };
  const registry = registryOf(project);
  jobs.turnoverCutFor = (name, key, opts) => planTurnoverCut({ project, key, name: opts?.name || "", at: FIXED_AT, landing: opts?.landing === true });
  jobs.rememberTurnoverFor = async (_name, branch, key) => {
    if (!project.turnoverBranches.some((entry) => entry.branch === branch)) project.turnoverBranches.push({ branch, key });
  };

  const first = await jobs.makeWorktree(r.dir, "land the landing cut", { project: "demo", turnoverKey: "task 402", mainBranch: "main" });
  assert.equal(first.kind, "implementation", "the brief's landing verb made it a landing cut");
  assert.ok(first.container, "the cut made the container itself, with no card");
  assert.match(first.container.branch, /^20261126_1800_TASK-402_/, "the branch is keyed to the task id");
  assert.equal(first.parentName, first.container.branch, "the child is cut from its own turnover branch, not from main");
  assert.equal(r.git("rev-parse", "--verify", "--quiet", `refs/heads/${first.container.branch}`).length, 40, "the branch exists locally");
  assert.equal(project.turnoverBranches.length, 1, "the cut filed the branch under its key");

  const second = await jobs.makeWorktree(r.dir, "land the other row", { project: "demo", turnoverKey: "task 403", mainBranch: "main" });
  assert.ok(second.container);
  assert.match(second.container.branch, /^20261126_1800_TASK-403_/, "a second key gets its own branch");
  assert.notEqual(second.container.branch, first.container.branch, "one key never borrows the other's branch");
  assert.equal(project.turnoverBranches.length, 2, "the registry accumulates, one entry per key, never overwritten");
  assert.deepEqual(
    project.turnoverBranches.map((entry) => entry.key).sort(),
    ["task 402", "task 403"],
    "both keys read back",
  );
  assert.equal(turnoverLookup({ registry })("demo", "task 402"), first.container.branch, "the key's own branch resolves");
  assert.equal(turnoverLookup({ registry })("demo", "task 999"), "", "a key with no entry resolves nothing, never another feature's branch");

  const again = await jobs.makeWorktree(r.dir, "land the landing cut", { project: "demo", turnoverKey: "task 402", mainBranch: "main" });
  assert.equal(again.container.branch, first.container.branch, "a second cut for one key reuses its branch");
  assert.equal(again.container.reused, true);
  assert.equal(project.turnoverBranches.length, 2, "a reuse writes no second entry");
});

test("3. a landing cut that names no key is refused by the cut, in the sentence that says why", async (t) => {
  const r = repo(t);
  const jobs = jobsAt(r.dir);
  const project = { name: "demo", mainBranch: "main", turnoverBranches: [], turnoverPolicy: "ask" };
  jobs.turnoverCutFor = (name, key, opts) => planTurnoverCut({ project, key, name: opts?.name || "", at: FIXED_AT, landing: opts?.landing === true });
  await assert.rejects(
    () => jobs.makeWorktree(r.dir, "land the change and push it", { project: "demo", mainBranch: "main" }),
    (e) => {
      assert.match(String(e.message), /names no task id/, "the refusal names the missing key");
      assert.match(String(e.message), /SPAWN #<id> <project>/, "and the line to write instead");
      assert.match(String(e.message), /implementation never stands at the repository root/, "and why it is refused");
      return true;
    },
  );
  assert.equal(existsSync(path.join(r.dir, ".worktrees")), false, "nothing was cut");

  // The same guard holds for a bare Jobs with no planner injected at all: the cut still refuses to put an
  // implementation at the root rather than falling back to the checkout.
  const bare = jobsAt(r.dir);
  await assert.rejects(
    () => bare.makeWorktree(r.dir, "fix the push gate", { project: "demo", mainBranch: "main" }),
    (e) => {
      assert.match(String(e.message), /cannot stand at the repository root/, "the root guard is the cut's own");
      assert.match(String(e.message), /turnover branch/, "and it names what the cut needs");
      return true;
    },
  );
  assert.equal(existsSync(path.join(r.dir, ".worktrees")), false, "still nothing was cut");
});

test("4. a registered turnover branch that has already landed is refused by name", async (t) => {
  const r = repo(t);
  // A turnover branch with a commit of its own, merged to main, and main then moved PAST it: the exact shape
  // `turnoverLanded` calls dead.
  r.git("checkout", "-q", "-b", "20261120_0900_TASK-500_the_landed_feature");
  writeFileSync(path.join(r.dir, "docs", "landed.txt"), "landed work\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "the feature's landed work");
  r.git("checkout", "-q", "main");
  r.git("merge", "-q", "--no-ff", "-m", "merge the feature", "20261120_0900_TASK-500_the_landed_feature");
  writeFileSync(path.join(r.dir, "docs", "after.txt"), "main moved on\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "main moved on");

  const jobs = jobsAt(r.dir);
  const landed = "20261120_0900_TASK-500_the_landed_feature";
  const project = { name: "demo", mainBranch: "main", turnoverBranches: [{ branch: landed, key: "task 500" }], turnoverPolicy: "ask" };
  const registry = registryOf(project);
  jobs.turnoverBranchFor = turnoverLookup({ registry });
  jobs.turnoverCutFor = (name, key, opts) => planTurnoverCut({ project, key, name: opts?.name || "", at: FIXED_AT, landing: opts?.landing === true });

  await assert.rejects(
    () => jobs.makeWorktree(r.dir, "land the next change", { project: "demo", turnoverBranch: landed, turnoverKey: "task 500", mainBranch: "main" }),
    (e) => {
      assert.match(String(e.message), new RegExp(landed), "the refusal names the landed branch");
      assert.match(String(e.message), /has already landed on/, "and says it has landed");
      assert.match(String(e.message), /a landed branch is not a container/, "and why it cannot be a parent");
      assert.match(String(e.message), /new task id/, "and the remedy");
      return true;
    },
  );
});

test("5. the job record stamps the queue row a SPAWN named", async (t) => {
  const r = repo(t);
  const jobs = jobsAt(r.dir);
  const project = { name: "demo", path: r.dir, mainBranch: "main", turnoverBranches: [], turnoverPolicy: "ask" };
  jobs.turnoverCutFor = (name, key, opts) => planTurnoverCut({ project, key, name: opts?.name || "", at: FIXED_AT, landing: opts?.landing === true });
  jobs.rememberTurnoverFor = async (_name, branch, key) => {
    if (!project.turnoverBranches.some((entry) => entry.branch === branch)) project.turnoverBranches.push({ branch, key });
  };
  // The shortest possible run: `anchorCwd: false` keeps the brief and the cwd bare, and the gateway at port 1 refuses
  // the start at once, so the record can be read back without a worker.
  const job = await jobs.create({ prompt: "land the row's work", cwd: r.dir, project: "demo", existing: true, anchorCwd: false, reply: true, queueRow: 402, worktree: false });
  const record = jobs.jobs.get(job.id);
  assert.ok(record, "the cut wrote a job record");
  assert.equal(record.queueRow, 402, "the record stamps the queue row");
});
