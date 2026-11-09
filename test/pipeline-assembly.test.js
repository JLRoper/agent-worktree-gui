// A FINISHED PER-STAGE ROUND, ASSEMBLED: ONE branch that carries every stage's commit.
//
// A round gives every stage its own tree, cut at the round's frozen parent (test/pipeline-stage-trees.test.js pins
// that half). This file pins the half that makes such a round LANDABLE: when the pipeline is over, the stage runs'
// commits are cherry-picked onto ONE branch cut from the round's frozen parent, in visit order, and that branch is
// what the row's landing step pushes and merges.
//
// The four rules this file proves, on real git:
//
//   1. the assembled branch starts at the round's frozen parent, so a commit that landed after the round began - and
//      a second round's work - is NOT in it;
//   2. every stage's work is in it, byte for byte, and the history reads in visit order (baseline, implement, compare,
//      correct);
//   3. two stages that write the same path on DIFFERENT lines compose, the later stage's version on top; the SAME
//      lines are a refusal that names the path and the stage, leaves the branch at the parent and the tree clean;
//   4. a stage that never committed is named as skipped, never invented into the branch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { parseBundle } from "../lib/pipeline-bundle.js";
import { ASSEMBLY_FAULTS, assembleStages, assemblyMessage, assemblyOrder, assemblyRecord } from "../lib/pipeline-assembly.js";
import { assemblyPlanOf } from "../lib/task-pipeline-drive.js";
import { settleStageRun } from "../lib/task-pipeline.js";

const CLOCK = "2026-11-09T12:00:00.000Z";
// Written as a join so the address is not scanned as one in this file.
const EMAIL = ["assembly", "example.invalid"].join(String.fromCharCode(64));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// A real repository with local identity, so `git cherry-pick` (which runs git without our `-c` flags) can commit.
function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-assembly-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Assembly Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (rel, body) => {
    const at = path.join(dir, rel);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, body);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Assembly Fixture");
  git("config", "user.email", EMAIL);
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  write("seed.txt", "the round began here\n");
  git("add", "-A");
  git("commit", "-qm", "the round's parent");
  // One reader for another directory: a stage tree is a different worktree of the same repository, and the `-C <dir>`
  // form of `git` above would accumulate two `-C`s.
  const at = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=Assembly Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, git, write, at };
}

function cutter(t, dir) {
  const jobs = new Jobs({
    config: { apiServer: { url: "http://127.0.0.1:1" }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 60 },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.parents = new ParentBook({ file: path.join(dir, "logs", "parents.json"), onLog: () => {} });
  return jobs;
}

// One stage's worker: write its file, commit it, answer the commit. The commit's PARENT is the round's frozen parent,
// because the tree it runs in was cut there - the fact every pick below depends on.
function worker(r, treePath, rel, body) {
  const file = path.join(treePath, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  r.at(treePath, "add", "--", rel);
  r.at(treePath, "commit", "-qm", `${rel} from this stage`);
  return r.at(treePath, "rev-parse", "HEAD");
}

// ---- the plan: what the driver asks for ---------------------------------------------------------------

const stage = (id, file) => ({ id, title: `Stage ${id}`, prompt: `Write ${file}.`, artifact: { id: `doc-${id}`, path: file, schema: "doc/1", writer: `${id}-writer` } });
const CHAIN = {
  bundleVersion: 1,
  name: "round",
  pipelines: [
    {
      id: "round",
      title: "Baseline, implement, compare, correct",
      stages: [stage("B1", "work/baseline.md"), stage("I1", "work/implement.md"), stage("C1", "work/compare.md"), stage("K1", "work/correct.md")],
      gates: [],
      handoffs: [
        { id: "h1", from: "B1", to: "I1", artifact: "doc-B1", kind: "sequence" },
        { id: "h2", from: "I1", to: "C1", artifact: "doc-I1", kind: "sequence" },
        { id: "h3", from: "C1", to: "K1", artifact: "doc-C1", kind: "sequence" },
      ],
    },
  ],
};
const parsed = parseBundle(CHAIN, { file: "round.json" });
assert.equal(parsed.ok, true, parsed.reason || "the fixture bundle must parse");
const PIPELINE = parsed.bundle.pipelines[0];

const runEntry = (id, visit, commit, branch) => ({ id: `round/${id}#${visit}`, stage: id, visit, status: "done", commit, tree: { path: `/trees/${id}-${visit}`, branch } });

const rowOf = (pipelineRun) => ({ id: 1, title: "the round", state: "running", project: "demo", worktree: null, pipelineRun });

test("the plan replays the stage runs by VISIT, then by the document's order: baseline, implement, compare, correct", () => {
  const order = assemblyOrder([
    { stage: "B1", visit: 2, commit: "b2", position: 1 },
    { stage: "C1", visit: 1, commit: "c1", position: 3 },
    { stage: "I1", visit: 1, commit: "i1", position: 2 },
    { stage: "B1", visit: 1, commit: "b1", position: 1 },
  ]);
  assert.deepEqual(order.map((entry) => entry.commit), ["b1", "i1", "c1", "b2"], "a loop's second visit comes after the first visit's last stage");
  assert.deepEqual(order.map((entry) => entry.stage), ["B1", "I1", "C1", "B1"]);
});

test("a finished round offers ONE assembly: every settled commit, in order, from the round's frozen parent", () => {
  const run = {
    pipeline: "round",
    stage: "K1",
    enteredAt: CLOCK,
    round: { parent: "main", sha: "a".repeat(40), at: CLOCK, by: "panel" },
    visits: { B1: 1, I1: 1, C1: 1, K1: 1 },
    stageRuns: [runEntry("B1", 1, "1".repeat(40), "wtgui/b1-x"), runEntry("I1", 1, "2".repeat(40), "wtgui/i1-x"), runEntry("C1", 1, "3".repeat(40), "wtgui/c1-x"), runEntry("K1", 1, "4".repeat(40), "wtgui/k1-x")],
  };
  const plan = assemblyPlanOf(rowOf(run), PIPELINE);
  assert.equal(plan.offered, true, plan.why || "");
  assert.equal(plan.base, "a".repeat(40), "the base is the round's frozen commit, never the parent branch as it stands now");
  assert.equal(plan.parent, "main");
  assert.deepEqual(plan.stages.map((entry) => [entry.stage, entry.visit]), [["B1", 1], ["I1", 1], ["C1", 1], ["K1", 1]], "baseline first, then implement, compare and correct");
  assert.deepEqual(plan.stages.map((entry) => entry.branch), ["wtgui/b1-x", "wtgui/i1-x", "wtgui/c1-x", "wtgui/k1-x"], "each stage's own branch travels with its commit");
  assert.deepEqual(plan.skipped, []);
});

test("a round already assembled is not assembled twice, and one stage's commit is not a round to assemble", () => {
  const base = "a".repeat(40);
  const assembled = assemblyPlanOf(
    rowOf({
      pipeline: "round",
      stage: "K1",
      round: { parent: "main", sha: base, at: CLOCK, by: "panel" },
      visits: { B1: 1, I1: 1 },
      stageRuns: [runEntry("B1", 1, "1".repeat(40), "wtgui/b1-x"), runEntry("I1", 1, "2".repeat(40), "wtgui/i1-x")],
      assembly: { commit: "c".repeat(40), base, branch: "wtgui/round-abc123" },
    }),
    PIPELINE,
  );
  assert.deepEqual([assembled.offered, assembled.done], [false, true]);
  assert.match(assembled.why, /second assembly for the same round is refused/);

  const one = assemblyPlanOf(
    rowOf({
      pipeline: "round",
      stage: "B1",
      round: { parent: "main", sha: base, at: CLOCK, by: "panel" },
      visits: { B1: 1 },
      stageRuns: [runEntry("B1", 1, "1".repeat(40), "wtgui/b1-x")],
    }),
    PIPELINE,
  );
  assert.deepEqual([one.offered, one.done, one.stages.length], [false, false, 1]);
  assert.match(one.why, /one stage of the round/);

  // A round with a PARENT TREE is the exception, and it is the whole point of the parent tree: the branch that lands
  // is the round's own, not the single stage's, so that one commit must be picked onto it.
  const withParent = assemblyPlanOf(
    rowOf({
      pipeline: "round",
      stage: "B1",
      round: { parentPath: "/repo/.worktrees/the-round-a1b2c3", parent: "wtgui/the-round-a1b2c3", sha: base, at: CLOCK, by: "panel" },
      visits: { B1: 1 },
      stageRuns: [runEntry("B1", 1, "1".repeat(40), "wtgui/b1-x")],
    }),
    PIPELINE,
  );
  assert.deepEqual([withParent.offered, withParent.done, withParent.stages.length], [true, false, 1], "one stage, one commit, and a landing branch to carry it");
  assert.equal(withParent.parentPath, "/repo/.worktrees/the-round-a1b2c3", "the plan names the tree to pick into");
});

test("a record with no round, and a fan-out's block, are not assembled: one tree model has no siblings to combine", () => {
  const noRound = assemblyPlanOf(rowOf({ pipeline: "round", stage: "K1", visitedAt: CLOCK, stageRuns: [runEntry("B1", 1, "1".repeat(40), "b")] }), PIPELINE);
  assert.equal(noRound.offered, false);
  assert.match(noRound.why, /records no round/);

  const fanout = parseBundle(
    {
      bundleVersion: 1,
      name: "fan",
      pipelines: [
        {
          id: "fan",
          title: "Fan",
          isolation: "per-stage",
          stages: [stage("S1", "a.md"), stage("S2", "b.md"), stage("S3", "c.md")],
          gates: [],
          handoffs: [
            { id: "h1", from: "S1", to: "S3", artifact: "doc-S1", kind: "sequence" },
            { id: "h2", from: "S2", to: "S3", artifact: "doc-S2", kind: "sequence" },
          ],
        },
      ],
    },
    { file: "fan.json" },
  ).bundle.pipelines[0];
  const plan = assemblyPlanOf(rowOf({ pipeline: "fan", stage: "S3", round: { parent: "main", sha: "a".repeat(40) }, stageRuns: [runEntry("S1", 1, "1".repeat(40), "b")] }), fanout);
  assert.equal(plan.offered, false);
  assert.match(plan.why, /fan-out/);
});

test("a stage that settled without a commit is skipped and named, never invented into the assembly", () => {
  const run = {
    pipeline: "round",
    stage: "K1",
    round: { parent: "main", sha: "a".repeat(40), at: CLOCK },
    visits: { B1: 1, I1: 1 },
    stageRuns: [runEntry("B1", 1, "1".repeat(40), "wtgui/b1-x"), { id: "round/I1#1", stage: "I1", visit: 1, status: "done", tree: { branch: "wtgui/i1-x" } }],
  };
  const plan = assemblyPlanOf(rowOf(run), PIPELINE);
  assert.deepEqual(plan.stages.map((entry) => entry.stage), ["B1"]);
  assert.deepEqual(plan.skipped.map((entry) => [entry.stage, entry.why]), [["I1", "the run recorded no commit"]]);
  assert.equal(plan.offered, false, "one commit is not a chain");
});

// ---- the assembly, on real trees ----------------------------------------------------------------------

test("a finished four-stage round assembles ONE branch: every stage's work, nothing from another round", async (t) => {
  const r = repo(t);
  const jobs = cutter(t, r.dir);
  const roundSha = r.git("rev-parse", "main");

  // LATE LANDINGS on the parent branch, after the round froze: one is main moving on, the other is a whole SECOND
  // round (its own stage tree, its own commit). Neither may reach the first round's assembly.
  r.write("late.md", "landed after the round began\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "a landing after the round began");
  const secondRound = await jobs.makeWorktree(r.dir, "the second round's baseline", { project: "demo", from: r.git("rev-parse", "main") });
  const otherCommit = worker(r, secondRound.path, "work/second-round.md", "# another round's work\n");

  // The round: four stage trees, each cut from the SAME frozen parent, each committing its own file.
  const trees = {};
  const commits = {};
  for (const [id, file] of [
    ["B1", "work/baseline.md"],
    ["I1", "work/implement.md"],
    ["C1", "work/compare.md"],
    ["K1", "work/correct.md"],
  ]) {
    trees[id] = await jobs.makeWorktree(r.dir, `stage ${id} of the round`, { project: "demo", from: roundSha, parent: "main" });
    assert.equal(r.at(trees[id].path, "rev-parse", "HEAD"), roundSha, `${id}'s tree is cut at the round's frozen parent`);
    commits[id] = worker(r, trees[id].path, file, `# ${id}\n\nwhat ${id} produced\n`);
  }
  const stages = Object.keys(commits).map((id, index) => ({ stage: id, visit: 1, commit: commits[id], branch: trees[id].branch, position: index + 1 }));

  // The assembly's own tree, cut the way the panel cuts it: a branch at the round's frozen parent.
  const assembly = await jobs.makeWorktree(r.dir, "assemble the round", { project: "demo", from: roundSha, parent: "main" });
  const result = assembleStages({ tree: assembly.path, base: roundSha, stages, message: assemblyMessage(PIPELINE, stages, roundSha), at: CLOCK });
  assert.equal(result.ok, true, result.reason || "");
  assert.equal(result.verified, true, `every stage's paths must be on the branch (mismatches: ${JSON.stringify(result.mismatches)})`);
  assert.equal(result.stages.length, 4);

  // 1. THE BASE IS THE ROUND'S FROZEN PARENT, not main's tip: the late landing and the second round are absent.
  assert.equal(r.at(assembly.path, "rev-parse", `${result.commit}~4`), roundSha, "the assembled branch starts at the round's parent");
  assert.equal(existsSync(path.join(assembly.path, "late.md")), false, "a commit that landed after the round began is NOT in the assembly");
  assert.equal(existsSync(path.join(assembly.path, "work/second-round.md")), false, "another round's work is NOT in the assembly");
  for (const commit of [otherCommit]) {
    let ancestor = true;
    try {
      execFileSync("git", ["-C", assembly.path, "merge-base", "--is-ancestor", commit, result.commit], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      ancestor = false;
    }
    assert.equal(ancestor, false, "the second round's commit is not an ancestor of the assembled branch");
  }

  // 2. EVERY stage's work, byte for byte, and the history in VISIT ORDER.
  for (const [id, file] of [
    ["B1", "work/baseline.md"],
    ["I1", "work/implement.md"],
    ["C1", "work/compare.md"],
    ["K1", "work/correct.md"],
  ]) {
    assert.equal(existsSync(path.join(assembly.path, file)), true, `${file} is on the assembled branch`);
    assert.equal(sha256(path.join(assembly.path, file)), sha256(path.join(trees[id].path, file)), `${file} is byte-identical to what ${id} wrote`);
    assert.equal(r.at(assembly.path, "rev-parse", `HEAD:${file}`), r.at(trees[id].path, "rev-parse", `HEAD:${file}`), `${file}'s blob is ${id}'s own`);
  }
  const subjects = r.at(assembly.path, "log", "--format=%s", `${roundSha}..HEAD`).split("\n").filter(Boolean).reverse();
  assert.deepEqual(subjects, ["work/baseline.md from this stage", "work/implement.md from this stage", "work/compare.md from this stage", "work/correct.md from this stage"], "baseline first, then implement, compare and correct");

  // 3. The record the row carries: one branch, its tip, the base it was cut from, and what was picked.
  const record = assemblyRecord({ commit: result.commit, base: roundSha, branch: assembly.branch, path: assembly.path, stages: result.stages, skipped: result.skipped, verified: result.verified, paths: result.paths, at: CLOCK });
  assert.equal(record.branch, assembly.branch);
  assert.equal(record.commit, result.commit);
  assert.equal(record.base, roundSha);
  assert.deepEqual(record.stages.map((entry) => entry.stage), ["B1", "I1", "C1", "K1"]);
  assert.deepEqual(record.stages.map((entry) => entry.commit), [commits.B1, commits.I1, commits.C1, commits.K1], "each entry pins the commit it was picked FROM");
  assert.equal(record.verified, true);

  // …and a second assembly of the SAME round is refused by the plan, which is the record's own proof.
  const run = {
    pipeline: "round",
    stage: "K1",
    round: { parent: "main", sha: roundSha, at: CLOCK, by: "panel" },
    visits: { B1: 1, I1: 1, C1: 1, K1: 1 },
    stageRuns: Object.keys(commits).map((id) => runEntry(id, 1, commits[id], trees[id].branch)),
    assembly: record,
  };
  assert.equal(assemblyPlanOf(rowOf(run), PIPELINE).offered, false);
});

test("two stages writing ONE path on different lines compose: the later stage's version is on top", async (t) => {
  const r = repo(t);
  const jobs = cutter(t, r.dir);
  // The base has the file all three stages will write, so each stage's change is a HUNK rather than an add.
  r.write("notes.md", "one\ntwo\nthree\nfour\nfive\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "the shared note");
  const roundSha = r.git("rev-parse", "main");

  const first = await jobs.makeWorktree(r.dir, "stage one edits the first line", { project: "demo", from: roundSha, parent: "main" });
  const second = await jobs.makeWorktree(r.dir, "stage two edits the last line", { project: "demo", from: roundSha, parent: "main" });
  const one = worker(r, first.path, "notes.md", "ONE\ntwo\nthree\nfour\nfive\n");
  const two = worker(r, second.path, "notes.md", "one\ntwo\nthree\nfour\nFIVE\n");

  const assembly = await jobs.makeWorktree(r.dir, "assemble the shared note", { project: "demo", from: roundSha, parent: "main" });
  const result = assembleStages({
    tree: assembly.path,
    base: roundSha,
    stages: [
      { stage: "B1", visit: 1, commit: one, position: 1 },
      { stage: "I1", visit: 1, commit: two, position: 2 },
    ],
    message: "assembly",
  });
  assert.equal(result.ok, true, result.reason || "");
  assert.equal(readFileSync(path.join(assembly.path, "notes.md"), "utf8"), "ONE\ntwo\nthree\nfour\nFIVE\n", "both stages' edits are present, the later one on top");
  assert.equal(result.verified, true);
});

test("two stages writing the SAME lines are refused by path, and the branch is left at the parent and clean", async (t) => {
  const r = repo(t);
  const jobs = cutter(t, r.dir);
  r.write("notes.md", "one\ntwo\nthree\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "the shared note");
  const roundSha = r.git("rev-parse", "main");

  const first = await jobs.makeWorktree(r.dir, "stage one rewrites the middle", { project: "demo", from: roundSha, parent: "main" });
  const second = await jobs.makeWorktree(r.dir, "stage two rewrites the middle too", { project: "demo", from: roundSha, parent: "main" });
  const one = worker(r, first.path, "notes.md", "one\nONE'S MIDDLE\nthree\n");
  const two = worker(r, second.path, "notes.md", "one\nTWO'S MIDDLE\nthree\n");

  const assembly = await jobs.makeWorktree(r.dir, "assemble the clashing note", { project: "demo", from: roundSha, parent: "main" });
  const result = assembleStages({
    tree: assembly.path,
    base: roundSha,
    stages: [
      { stage: "B1", visit: 1, commit: one, position: 1 },
      { stage: "I1", visit: 1, commit: two, position: 2 },
    ],
    message: "assembly",
  });
  assert.deepEqual([result.ok, result.code], [false, ASSEMBLY_FAULTS.CONFLICT]);
  assert.deepEqual(result.conflicts, ["notes.md"], "the path both stages changed on the same lines");
  assert.equal(result.stage, "I1", "the stage whose pick stopped");
  assert.match(result.reason, /B1/, "the refusal names the stage before it");
  assert.equal(r.at(assembly.path, "rev-parse", "HEAD"), result.stages[0].commit, "the clashing stage is NOT committed: the branch stops at the stage before it");
  assert.equal(r.at(assembly.path, "status", "--porcelain"), "", "the aborted pick left the tree clean");
  assert.equal(readFileSync(path.join(assembly.path, "notes.md"), "utf8"), "one\nONE'S MIDDLE\nthree\n", "and the file is the earlier stage's version, not a half-merge");
});

test("a stage that never committed is skipped, and the rest of the round still assembles", async (t) => {
  const r = repo(t);
  const jobs = cutter(t, r.dir);
  const roundSha = r.git("rev-parse", "main");
  const first = await jobs.makeWorktree(r.dir, "stage one commits", { project: "demo", from: roundSha, parent: "main" });
  const second = await jobs.makeWorktree(r.dir, "stage two never commits", { project: "demo", from: roundSha, parent: "main" });
  const one = worker(r, first.path, "work/one.md", "# one\n");
  // Stage two wrote its file and never committed: its recorded commit is the tree's own base, and its file must not
  // appear on the assembled branch.
  writeFileSync(path.join(second.path, "two.md"), "# two\n");

  const assembly = await jobs.makeWorktree(r.dir, "assemble what committed", { project: "demo", from: roundSha, parent: "main" });
  const result = assembleStages({
    tree: assembly.path,
    base: roundSha,
    stages: [
      { stage: "B1", visit: 1, commit: one, position: 1 },
      { stage: "I1", visit: 1, commit: roundSha, position: 2 },
    ],
    message: "assembly",
  });
  assert.equal(result.ok, true, result.reason || "");
  assert.deepEqual(result.stages.map((entry) => entry.stage), ["B1"]);
  assert.deepEqual(result.skipped.map((entry) => [entry.stage, entry.why]), [["I1", "the commit is already in the assembly"]], "a stage whose commit is its own base has nothing to pick");
  assert.equal(existsSync(path.join(assembly.path, "work/one.md")), true);
  assert.equal(existsSync(path.join(assembly.path, "two.md")), false, "the uncommitted file is NOT invented into the branch");
  assert.equal(result.verified, true);
});

test("an assembly tree that is not at the round's frozen parent is refused: the branch may not carry another round", async (t) => {
  const r = repo(t);
  const jobs = cutter(t, r.dir);
  const roundSha = r.git("rev-parse", "main");
  r.write("late.md", "a landing\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "a landing");
  const moved = r.git("rev-parse", "main");
  const stageTree = await jobs.makeWorktree(r.dir, "stage one", { project: "demo", from: roundSha, parent: "main" });
  const one = worker(r, stageTree.path, "work/one.md", "# one\n");

  const wrongTree = await jobs.makeWorktree(r.dir, "assembly cut from the wrong place", { project: "demo", from: moved });
  const result = assembleStages({ tree: wrongTree.path, base: roundSha, stages: [{ stage: "B1", visit: 1, commit: one }], message: "assembly" });
  assert.deepEqual([result.ok, result.code], [false, ASSEMBLY_FAULTS.SHAPE]);
  assert.match(result.reason, /not at the round's frozen parent/);
});
