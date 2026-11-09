#!/usr/bin/env node
// HARNESS: LIVE GATE
// Prove a per-stage ROUND is landable: every stage runs in its own tree (the panel's own `Jobs.makeWorktree`, cut at
// the round's frozen parent), and when the pipeline is over the driver asks for ONE assembly, which the Assistant
// performs by cherry-picking each stage run's commit, in visit order, onto a branch cut from that same frozen parent.
//
// The unit tests pin each half (test/pipeline-assembly.test.js, test/task-pipeline-drive.test.js,
// test/pipeline-stage-trees.test.js). This is the whole thing in one run against a real repository, because "one
// branch that carries every stage" is a claim about a COMMIT and a TREE, and neither is proved by an argument over a
// record:
//
//   1. a four-stage round (baseline, implement, compare, correct) is driven from `queued` to `done` by the real
//      `Assistant.sweepQueues` and the real `driveTaskPipelines`: four stage trees, four commits, one assembly;
//   2. the assembled branch carries EVERY stage's file, byte for byte, in the order the round ran, and its history
//      starts at the round's frozen parent;
//   3. nothing from another round is in it - a commit that landed on the parent after the round began, and a SECOND
//      round run afterwards, are both absent;
//   4. the row's landing branch is the assembly's: `pipelineRun.tree.branch` and `worktree` name it, and the stage
//      trees are still their own;
//   5. a two-stage round assembles the same way, and its branch name and commit are printed for the report;
//   6. two stages writing the SAME lines park the row `pipeline-assembly-conflict`, naming the path, and leave no
//      assembly branch behind.
//
// Nothing here pushes: a stage branch is local only, and the assembly is the branch the landing step would push.
//
//   node tools/verify-pipeline-assembly.mjs                 quiet when green except the summary
//   VERIFY_KEEP=1 node tools/verify-pipeline-assembly.mjs  keep the sandbox (the repo, the trees, the branches)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Assistant } from "../lib/assistant.js";
import { readQueueFile } from "../lib/assistant/queue.js";
import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { parseBundle } from "../lib/pipeline-bundle.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOCK = "2026-11-09T14:00:00.000Z";
const EMAIL = ["assembly", "example.invalid"].join(String.fromCharCode(64));

let checks = 0;
let failures = 0;
function ok(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`ok    ${name}`);
    return true;
  }
  failures += 1;
  console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  return false;
}
function is(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(name, same, same ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const write = (file, body) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

// ---- the bundle: a chain of named stages, one pipeline per round ------------------------------------------------
const stageOf = (id, title) => ({
  id,
  title,
  prompt: `Write work/${id}.md and commit it.`,
  artifact: { id: `doc-${id}`, path: `work/${id}.md`, schema: "doc/1", writer: `${id}-seat` },
});
const chainOf = (id, ids) => ({
  id,
  title: `The ${ids.length}-stage round`,
  stages: ids.map((stageId) => stageOf(stageId, stageId)),
  gates: [],
  handoffs: ids.slice(1).map((to, index) => ({ id: `h${index + 1}`, from: ids[index], to, artifact: `doc-${ids[index]}`, kind: "sequence" })),
});

const PARENT = "assembly-proof";
const ROUND4 = chainOf("round4", ["B1", "I1", "C1", "K1"]);
const ROUND2 = chainOf("round2", ["B1", "I1"]);
const CONFLICT = chainOf("conflict", ["B1", "I1"]);

// What each stage writes, and what a CONFLICTING stage writes instead of its own file.
const bodyFor = (stageId) => `# ${stageId}\n\nwhat ${stageId} produced\n`;

let assistant = null;
let repo = null;
const sandbox = mkdtempSync(path.join(os.tmpdir(), "wtgui-assembly-e2e-"));

// One stage's work, done by a scripted seat: write its file, commit it on its own branch, answer the commit. It is
// handed nothing but its tree, so the file it writes comes from the tree's directory name and the stage id it read in
// the prompt - exactly the way a real seat learns where it is.
function workStage(treePath, stageId, { body = null } = {}) {
  const rel = `work/${stageId}.md`;
  write(path.join(treePath, rel), body ?? bodyFor(stageId));
  git(treePath, ["add", "--", rel]);
  git(treePath, ["-c", "user.name=proof", "-c", `user.email=${EMAIL}`, "commit", "-qm", `${stageId}: ${rel}`]);
  return git(treePath, ["rev-parse", "HEAD"]);
}

// The Assistant, with a real job store for the cuts and a spawner that does the stage's work at once.
function buildAssistant(dir) {
  const board = [];
  let seq = 0;
  const jobs = new Jobs({
    config: { apiServer: { url: "http://127.0.0.1:1" }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 60 },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.parents = new ParentBook({ file: path.join(dir, "logs", "parents.json"), onLog: () => {} });
  // The store the Assistant writes its rows into, and the two methods it reads a board with.
  const store = {
    list: () => board.slice(),
    firstOfThread: (thread) => board.find((job) => job.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    get: (id) => board.find((job) => job.id === id) || null,
    create: async (opts) => ({ id: `job-${(seq += 1)}`, status: "running", ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    clarify: { state: () => null },
    makeWorktree: (repoDir, prompt, opts) => jobs.makeWorktree(repoDir, prompt, opts),
  };
  const made = new Assistant({
    config: { jobsFile: path.join(dir, "logs", "jobs.json"), assistantFile: path.join(dir, "logs", "assistant.json"), defaultCwd: dir, pipelineBundleFile: path.join(dir, "pipeline-bundle.json") },
    jobs: store,
    getProjects: () => [{ name: PARENT, path: repo }],
    getRows: () => [],
    onLog: (line) => process.env.VERIFY_VERBOSE === "1" && console.log(`  log: ${line}`),
    // The seat: the stage's own tree and the stage id the driver wrote into its prompt, nothing else.
    spawner: async (spec) => {
      const found = /\(([\w-]+)\/([\w-]+)\), visit (\d+)/.exec(String(spec.prompt || ""));
      if (!found) throw new Error("the stage prompt carries no provenance line");
      const [, , stageId] = found;
      seq += 1;
      const thread = `proof-${String(seq).padStart(2, "0")}`;
      const commit = workStage(spec.target, stageId);
      const job = { id: `job-${seq}`, thread, status: "done", cwd: spec.target, worktreePath: spec.target, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), finalMessage: `${stageId} committed ${commit}` };
      board.push(job);
      job.commit = commit;
      // The landing a stage's run was handed. Every stage tree must be local: the branch that lands is the assembly's.
      made.remoteWrites.push(spec.remoteWrite || null);
      return job;
    },
    now: () => Date.now(),
  });
  made.remoteWrites = [];
  made.settings.spawn = "auto";
  return { assistant: made, jobs, store, board };
}

// One row driven to its end. `settle` waits for the row to park or finish: every cut and every pick is an async step
// the sweep starts, so the loop re-sweeps until the row stops moving.
async function runRound(dir, pipelineId, { stages, conflict = false } = {}) {
  const rowQueue = assistant.queuePathOf(assistant.assistantRecord("assistant-1"));
  const added = assistant.queueMutate("assistant-1", "add", { title: `run ${pipelineId}`, project: PARENT, detail: "one round, one branch" });
  if (!added.ok) throw new Error(`the row was refused: ${added.error}`);
  const id = added.task.id;
  const assigned = assistant.queueMutate("assistant-1", "pipeline", { id, pipeline: pipelineId, stage: "B1" });
  if (!assigned.ok) throw new Error(`the pipeline assignment was refused: ${assigned.error}`);
  const rowOf = () => readQueueFile(rowQueue).tasks.find((task) => task.id === id) || null;
  for (let step = 0; step < 900; step += 1) {
    assistant.sweepQueues();
    await sleep(120);
    const row = rowOf();
    if (!row) break;
    if (row.state === "done" || row.state === "parked") return { id, row, rowOf };
  }
  return { id, row: rowOf(), rowOf };
}

let fourRound = null;
let twoRound = null;
let clash = null;

try {
  // ---- the throwaway repository, and one bundle holding every round ------------------------------------------
  repo = path.join(sandbox, "repo");
  mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "proof"]);
  git(repo, ["config", "user.email", EMAIL]);
  git(repo, ["config", "core.autocrlf", "false"]);
  write(path.join(repo, "README.md"), "# the parent branch\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "the parent"]);
  const parentSha = git(repo, ["rev-parse", "HEAD"]);

  // A REAL origin, so the round's parent tree is proved to be cut from `origin/main` and not from the checkout. The
  // checkout is then moved AHEAD of the remote with work nobody pushed: that is the case the rule exists for, and a
  // round that started from the checkout's tip would carry a commit the remote has never seen.
  const originDir = path.join(sandbox, "origin.git");
  git(sandbox, ["init", "-q", "--bare", originDir]);
  git(repo, ["remote", "add", "origin", originDir]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  write(path.join(repo, "local-only.md"), "unpushed local work\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "local work the round must not see"]);
  const checkoutTip = git(repo, ["rev-parse", "HEAD"]);
  const originTip = git(repo, ["rev-parse", "origin/main"]);
  is("the checkout is ahead of origin/main", [checkoutTip !== originTip, originTip], [true, parentSha]);

  const bundleFile = path.join(sandbox, "pipeline-bundle.json");
  const bundleDoc = { bundleVersion: 1, name: "assembly-proof", pipelines: [ROUND4, ROUND2, CONFLICT] };
  write(bundleFile, `${JSON.stringify(bundleDoc, null, 2)}\n`);
  const parsed = parseBundle(bundleDoc, { file: bundleFile });
  if (!parsed.ok) throw new Error(`the fixture bundle does not parse: ${parsed.reason}`);

  const built = buildAssistant(sandbox);
  assistant = built.assistant;

  // ---- 1. a four-stage round, from queued to done ---------------------------------------------------------
  fourRound = await runRound(sandbox, "round4", { stages: ["B1", "I1", "C1", "K1"] });
  const four = fourRound.row;
  is("the four-stage round finished", four.state, "done");
  const run4 = four.pipelineRun;
  ok("the row carries ONE assembly", Boolean(run4.assembly && run4.assembly.commit), JSON.stringify(run4.assembly || null));
  is("every stage of the round committed in its own tree", Object.keys(run4.trees || {}).sort(), ["B1", "C1", "I1", "K1"]);
  const stageTrees = Object.values(run4.trees).map((tree) => tree.path);
  ok("four stage trees, no two the same", new Set(stageTrees).size === 4 && !stageTrees.includes(repo), stageTrees.join(", "));
  ok("the assembled branch is not a stage tree", !stageTrees.includes(run4.assembly.path), `${run4.assembly.path}`);

  const assembled = run4.assembly.path;
  // 2. EVERY stage's work, byte for byte, and the history in the round's order.
  for (const stageId of ["B1", "I1", "C1", "K1"]) {
    const rel = `work/${stageId}.md`;
    ok(`${rel} is on the assembled branch`, existsSync(path.join(assembled, rel)));
    is(`${rel} is byte-identical to what ${stageId} wrote`, sha256(path.join(assembled, rel)), sha256(path.join(run4.trees[stageId].path, rel)));
    is(`${rel}'s blob is ${stageId}'s own`, git(assembled, ["rev-parse", `HEAD:${rel}`]), git(run4.trees[stageId].path, ["rev-parse", `HEAD:${rel}`]));
  }
  is(
    "the history reads baseline, implement, compare, correct",
    git(assembled, ["log", "--format=%s", `${run4.assembly.base}..HEAD`]).split("\n").filter(Boolean).reverse(),
    ["B1: work/B1.md", "I1: work/I1.md", "C1: work/C1.md", "K1: work/K1.md"],
  );
  is("the assembled branch starts at the round's frozen parent", git(assembled, ["rev-parse", `${run4.assembly.commit}~4`]), fourRound.row.pipelineRun.round.sha);
  is("the round's frozen parent IS origin/main's commit at the first cut", run4.round.sha, parentSha);
  is("and the round says which ref it cut from", run4.round.base, "origin/main");

  // 1b. THE ROUND'S PARENT TREE: one real worktree, cut from origin/main, on the branch every stage was cut from -
  // and the tree the assembly landed in. Its name is `<task-slug>-<tag>`, the round's own slug and tag.
  const root = run4.round.parentPath;
  ok("the round records its parent tree's path", Boolean(root) && existsSync(root), String(root));
  is("the parent tree's directory is <task-slug>-<tag>", path.basename(root), `${run4.round.slug}-${run4.round.tag}`);
  is("the parent tree's branch is the round's branch", git(root, ["rev-parse", "--abbrev-ref", "HEAD"]), run4.round.parent);
  is("the round's branch is wtgui/<task-slug>-<tag>", run4.round.parent, `wtgui/${path.basename(root)}`);
  // The tree's HEAD is the assembled tip by now; its ROOT is what proves where it was cut, and the checkout's tip is
  // not in that history at all.
  is("the parent tree's history starts at origin/main's commit, not the checkout's tip", git(root, ["merge-base", "HEAD", parentSha]), parentSha);
  ok("the checkout's own tip is not in the round's parent tree", run4.round.sha !== checkoutTip);
  ok("the checkout was ahead of origin/main when the round began", checkoutTip !== parentSha, `${checkoutTip.slice(0, 12)} vs ${parentSha.slice(0, 12)}`);
  ok("unpushed local work is NOT in the round's parent tree", !existsSync(path.join(root, "local-only.md")));
  is("the assembly happened IN the round's parent tree", [run4.assembly.path, run4.assembly.branch], [root, run4.round.parent]);
  // Every stage child is named by the one function: Stage <n>: <title>, one directory per column of the document.
  const stageTitles = { B1: "B1", I1: "I1", C1: "C1", K1: "K1" };
  for (const [index, stageId] of ["B1", "I1", "C1", "K1"].entries()) {
    const tree = run4.trees[stageId];
    const dir = path.basename(tree.path);
    is(`${stageId}'s tree is named for its stage and column`, dir, `${run4.round.slug}-stage-${index + 1}-${stageTitles[stageId].toLowerCase()}-${tree.tag}`);
    is(`${stageId}'s tree branch is wtgui/<dir>`, tree.branch, `wtgui/${dir}`);
    is(`${stageId}'s tree says what it is`, tree.display, `Stage ${index + 1}: ${stageTitles[stageId]}`);
    is(`${stageId}'s tree hangs under the round's parent tree`, tree.parent, run4.round.parent);
    is(`${stageId}'s tree starts at the round's parent tree's commit`, git(tree.path, ["merge-base", "HEAD", parentSha]), parentSha);
  }
  ok(
    "every tree of the round carries its own six-hex tag, and the round one of its own",
    new Set(Object.values(run4.trees).map((tree) => tree.tag)).size === 4 && /^[0-9a-f]{6}$/.test(run4.round.tag) && !Object.values(run4.trees).some((tree) => tree.tag === run4.round.tag),
    Object.values(run4.trees).map((tree) => tree.tag).join(","),
  );

  // 3. Nothing from another round: a landing on main AFTER the freeze, and a SECOND round's stage commits.
  write(path.join(repo, "landed-later.md"), "a landing after the round began\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "a landing after the round began"]);
  // Pushed, so the landing is what `origin/main` now says: a round that begins afterwards starts from THAT tip, and
  // the first round's parent tree is still at the commit it was cut at.
  git(repo, ["push", "-q", "origin", "main"]);
  const laterSha = git(repo, ["rev-parse", "origin/main"]);
  ok("the parent branch moved after the round began", laterSha !== parentSha);
  ok("the late landing is NOT in the assembled branch", !existsSync(path.join(assembled, "landed-later.md")) && git(assembled, ["ls-tree", "--name-only", "HEAD", "landed-later.md"]) === "");

  // 4. The row's landing branch is the assembly's, and the stage branches are still their own.
  is("the row's tree IS the assembly", [run4.tree.path, run4.tree.branch], [assembled, run4.assembly.branch]);
  is("the row's worktree is the assembly's too", four.worktree, assembled);
  is("the assembly branch is a wtgui branch", /^wtgui\//.test(run4.assembly.branch), true);
  ok("the assembly is verified against every stage's paths", run4.assembly.verified === true);

  // ---- 5. a TWO-stage round, same machinery ---------------------------------------------------------------
  twoRound = await runRound(sandbox, "round2", { stages: ["B1", "I1"] });
  const two = twoRound.row;
  is("the two-stage round finished", two.state, "done");
  const run2 = two.pipelineRun;
  ok("it carries its own assembly", Boolean(run2.assembly && run2.assembly.commit));
  is("its base is the commit the second round froze, not the first round's", run2.round.sha, laterSha);
  is("two commits above the base, in order", git(run2.assembly.path, ["log", "--format=%s", `${run2.assembly.base}..HEAD`]).split("\n").filter(Boolean).reverse(), ["B1: work/B1.md", "I1: work/I1.md"]);
  for (const stageId of ["B1", "I1"]) {
    is(`the second round's work/${stageId}.md is on its branch`, sha256(path.join(run2.assembly.path, `work/${stageId}.md`)), sha256(path.join(run2.trees[stageId].path, `work/${stageId}.md`)));
  }
  // The second round has its OWN parent tree, cut from the moved origin/main, and it is not the first round's.
  is("the second round's parent tree is its own directory", path.basename(run2.round.parentPath), `${run2.round.slug}-${run2.round.tag}`);
  ok("and not the first round's tree", run2.round.parentPath !== run4.round.parentPath);
  is("its parent tree's history starts at the tip origin/main had when it began", git(run2.round.parentPath, ["merge-base", "HEAD", laterSha]), laterSha);
  is("its assembly is in that parent tree", [run2.assembly.path, run2.assembly.branch], [run2.round.parentPath, run2.round.parent]);
  // Nothing from the FIRST round is in the second round's branch: its files exist only on the first assembly.
  ok("the second round's branch carries no file of the first round beyond the shared stage names", !existsSync(path.join(run2.assembly.path, "work/C1.md")) && !existsSync(path.join(run2.assembly.path, "work/K1.md")));
  ok("and no commit of the first round is an ancestor of it", !isAncestor(run2.assembly.path, run4.assembly.commit, run2.assembly.commit));
  ok("the first round's branch carries nothing of the second round's parent tip", !existsSync(path.join(assembled, "landed-later.md")));

  // ---- 6. two stages writing the SAME lines park the row, and leave no branch --------------------------------
  write(path.join(repo, "work", "shared.md"), "one\ntwo\nthree\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "the shared note"]);
  // The conflict's two stages each rewrite the middle line, from their own tree cut at this round's parent. Each still
  // writes the artifact its stage declares, so the only refusal in play is the assembly's.
  built.assistant.spawner = async (spec) => {
    const found = /\(([\w-]+)\/([\w-]+)\), visit (\d+)/.exec(String(spec.prompt || ""));
    if (!found) throw new Error("the stage prompt carries no provenance line");
    const [, pipelineId, stageId] = found;
    const clashBody = pipelineId === "conflict" ? (stageId === "B1" ? "one\nFIRST\nthree\n" : "one\nSECOND\nthree\n") : null;
    write(path.join(spec.target, `work/${stageId}.md`), bodyFor(stageId));
    if (clashBody) write(path.join(spec.target, "work", "shared.md"), clashBody);
    git(spec.target, ["add", "--", "work"]);
    git(spec.target, ["-c", "user.name=proof", "-c", `user.email=${EMAIL}`, "commit", "-qm", `${stageId}: work/${stageId}.md`]);
    const commit = git(spec.target, ["rev-parse", "HEAD"]);
    const job = { id: `job-c-${stageId}`, thread: `conflict-${stageId}`, status: "done", cwd: spec.target, worktreePath: spec.target, startedAt: new Date().toISOString(), commit };
    built.board.push(job);
    return job;
  };
  clash = await runRound(sandbox, "conflict", { stages: ["B1", "I1"] });
  const parked = clash.row;
  is("the clashing round parked instead of landing a half-round", parked.state, "parked");
  ok("the reason names the path both stages changed", /work\/shared\.md/.test(String(parked.reason || "")), parked.reason);
  ok("and it says the assembly was refused", /assembly/.test(String(parked.reason || "")), parked.reason);
  const decision = (parked.pipelineRun.stageRuns || []).map((entry) => entry.decision).filter(Boolean).at(-1);
  is("the stage run records the assembly conflict code", decision && decision.code, "pipeline-assembly-conflict");
  ok("no assembly record was written for the refused round", !parked.pipelineRun.assembly);
  const branches = git(repo, ["branch", "--list", "wtgui/*"]).split("\n").filter(Boolean);
  // One parent branch per round, plus one per stage tree: the assembly lands on the round's parent branch, so a
  // refused assembly leaves no branch of its own behind.
  const expectedBranches =
    (1 + Object.keys(run4.trees).length) + (1 + Object.keys(run2.trees).length) + (1 + Object.keys(parked.pipelineRun.trees || {}).length);
  is("no assembly branch is left behind for the refused round", branches.length, expectedBranches);
  ok("the refused round's parent tree is still there to look at", existsSync(parked.pipelineRun.round.parentPath), String(parked.pipelineRun.round.parentPath));
  ok("every stage tree ran local-only: the landing paragraph was never handed to one", built.assistant.remoteWrites.length > 0 && built.assistant.remoteWrites.every((value) => value === "local"), built.assistant.remoteWrites.join(", "));

  console.log(
    `\n      assembly: round4 ${run4.assembly.commit.slice(0, 12)} on ${run4.assembly.branch} (4 stages, ${git(assembled, ["rev-list", "--count", `${run4.assembly.base}..HEAD`])} commits) · ` +
      `round2 ${run2.assembly.commit.slice(0, 12)} on ${run2.assembly.branch} (2 stages) · conflict parked with ${(decision && decision.fact && (decision.fact.conflicts || []).join(", ")) || "work/shared.md"}`,
  );
  console.log(`      two-stage round: directory ${run2.round.parentPath} · branch ${run2.assembly.branch} at ${run2.assembly.commit}`);
  console.log(`      its stage children: ${Object.values(run2.trees).map((tree) => `${path.basename(tree.path)} (${tree.branch})`).join(" · ")}`);
} catch (error) {
  failures += 1;
  console.log(`FAIL  the harness threw: ${String((error && error.stack) || error)}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") console.log(`\n      VERIFY_KEEP=1 - the sandbox is at ${sandbox}`);
  else rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function isAncestor(where, ancestor, descendant) {
  try {
    execFileSync("git", ["-C", where, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

console.log(`\n${checks} checks, ${failures} failed.`);
process.exit(failures ? 1 : 0);
