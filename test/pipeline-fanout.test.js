// The fan-out model — lib/pipeline-fanout.js and lib/pipeline-aggregate.js.
//
// Two questions this file answers, and each one is the difference between a drawing and a workspace:
//
//   1. WHICH stages of a graph run in their own tree. `isolation: "shared"` (the default, and what every bundle written
//      before the field meant) is one tree per row. `isolation: "per-stage"` gives a fan-out's lanes one tree each and
//      the aggregator its own tree for the one merge — and nothing else, so a chain keeps today's single tree.
//   2. WHAT that merge is. `git merge-tree --write-tree` pre-flights every lane over the object database, then ONE
//      octopus commit combines them. The tree the pre-flight predicted is the tree the commit has; a lane that wrote a
//      sibling's path is refused BY PATH, before any merge starts.
//
// The aggregate tests build a real repository: a fan-out that is never merged is a diagram, and a byte comparison is
// the only thing that proves each stage's report arrived intact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BUNDLE_FAULTS, parseBundle } from "../lib/pipeline-bundle.js";
import { AGGREGATE_FAULTS, aggregateBranches, parseMergeTree, preflightMerge } from "../lib/pipeline-aggregate.js";
import {
  aggregateBranchesOf,
  aggregateMessage,
  aggregateRecord,
  fanOutBaseOf,
  fanOutOf,
  isolationOf,
  stageRoleOf,
} from "../lib/pipeline-fanout.js";

const stage = (n) => ({
  id: `S${n}`,
  title: `Stage ${n}`,
  prompt: `Work stage ${n}.`,
  artifact: { id: `report-${n}`, path: `reports/S${n}.md`, schema: "report/1", writer: `writer-${n}` },
});

const handoff = (id, from, to, artifact, kind = "sequence") => ({ id, from, to, artifact, kind });
const pipelineOf = (over = {}) => ({
  id: "reports",
  title: "Reports",
  isolation: "per-stage",
  stages: [stage(1), stage(2), stage(3)],
  gates: [],
  // Two roots and one aggregator: the pipeline's START is the fork, so the lanes are S1 and S2 and the join is S3.
  handoffs: [handoff("h1", "S1", "S3", "report-1"), handoff("h2", "S2", "S3", "report-2")],
  ...over,
});

const bundleOf = (record) => {
  const parsed = parseBundle({ bundleVersion: 1, name: "test", pipelines: [record] }, { file: "pipeline-bundle.json" });
  assert.equal(parsed.ok, true, parsed.reason || "the fixture bundle must parse");
  return parsed.bundle;
};

// ---- the field --------------------------------------------------------------------------------------------------
test("a pipeline that names no isolation is shared, and one that names per-stage is read as per-stage", () => {
  const shared = bundleOf(pipelineOf({ isolation: undefined }));
  assert.equal(shared.pipelines[0].isolation, "shared", "absence is today's model, not an empty one");
  assert.equal(isolationOf(shared.pipelines[0]), "shared");

  const perStage = bundleOf(pipelineOf());
  assert.equal(perStage.pipelines[0].isolation, "per-stage");
  assert.equal(isolationOf(perStage.pipelines[0]), "per-stage");
});

test("an isolation model this panel does not run is refused whole, and the refusal names the file's own path", () => {
  const parsed = parseBundle({ bundleVersion: 1, name: "test", pipelines: [pipelineOf({ isolation: "isolated" })] }, { file: "b.json" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, BUNDLE_FAULTS.ISOLATION);
  assert.equal(parsed.where, "pipelines[0]");
  assert.match(parsed.reason, /shared or per-stage/);
});

// ---- the block --------------------------------------------------------------------------------------------------
test("a pipeline-start fan-out is two lanes and one join, and the fork is the start itself", () => {
  const plan = fanOutOf(bundleOf(pipelineOf()).pipelines[0]);
  assert.deepEqual(plan, { isolate: true, fork: null, lanes: ["S1", "S2"], join: "S3", block: ["S1", "S2", "S3"], why: null });
  assert.equal(stageRoleOf(plan, "S1"), "lane");
  assert.equal(stageRoleOf(plan, "S2"), "lane");
  assert.equal(stageRoleOf(plan, "S3"), "join");
});

test("a stage with two successors is the fork, and its commit is the block's base", () => {
  const record = pipelineOf({
    stages: [stage(0), stage(1), stage(2), stage(3)],
    handoffs: [handoff("f1", "S0", "S1", "report-1"), handoff("f2", "S0", "S2", "report-2"), handoff("j1", "S1", "S3", "report-1"), handoff("j2", "S2", "S3", "report-2")],
  });
  const plan = fanOutOf(bundleOf(record).pipelines[0]);
  assert.equal(plan.fork, "S0");
  assert.deepEqual(plan.lanes, ["S1", "S2"]);
  assert.equal(plan.join, "S3");
  assert.equal(stageRoleOf(plan, "S0"), "fork", "the fork runs in the row's own tree");
  assert.equal(
    fanOutBaseOf({ fanout: { base: null }, stageRuns: [{ stage: "S0", status: "done", commit: "a".repeat(40) }] }, plan, (run) => run.stageRuns),
    "a".repeat(40),
    "the fork's settled commit is the base every lane is cut from",
  );
});

test("a chain has no block: per-stage does not cut a tree per stage of one continuous piece of work", () => {
  const record = pipelineOf({ stages: [stage(1), stage(2), stage(3)], handoffs: [handoff("c1", "S1", "S2", "report-1"), handoff("c2", "S2", "S3", "report-2")] });
  assert.equal(fanOutOf(bundleOf(record).pipelines[0]), null);
});

test("a loop out of a stage is a two-outcome gate, not a lane", () => {
  // The shipped seed's shape: S9 → S8 is the capped back edge and S9 → S10 the rail. One sequence edge is not a fork.
  const record = pipelineOf({
    stages: [stage(8), stage(9), stage(10)],
    handoffs: [handoff("h8", "S8", "S9", "report-8"), handoff("h9", "S9", "S8", "report-8", "loop"), handoff("h10", "S9", "S10", "report-9")],
  });
  assert.equal(fanOutOf(bundleOf(record).pipelines[0]), null);
});

test("a graph this version cannot run flat is refused BY NAME, and the row runs shared", () => {
  // A lane that forks again: a nested fan-out needs a second aggregate, so it is refused rather than flattened.
  const nested = pipelineOf({
    stages: [stage(1), stage(2), stage(3), stage(4), stage(5)],
    handoffs: [handoff("a", "S1", "S4", "report-1"), handoff("b", "S2", "S3", "report-2"), handoff("c", "S2", "S4", "report-2"), handoff("d", "S3", "S4", "report-3"), handoff("e", "S4", "S5", "report-4")],
  });
  const plan = fanOutOf(bundleOf(nested).pipelines[0]);
  assert.equal(plan.isolate, false);
  assert.match(plan.why, /reaches lane|forks again|one fan-out block per pipeline/);
  assert.ok(plan.why.includes("shared"), "the refusal says what happens instead, not only what is wrong");
  assert.equal(stageRoleOf(plan, "S1"), null, "a refused block has no roles: the driver falls back to the row's tree");
});

// ---- the aggregate ----------------------------------------------------------------------------------------------
const sh = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-fanout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(["init", "-q", "-b", "main", "."], dir);
  sh(["config", "user.email", "test@example.invalid"], dir);
  sh(["config", "user.name", "Test"], dir);
  // The comparison is BYTES: autocrlf would turn the same content into different bytes in the checkout and the blob.
  sh(["config", "core.autocrlf", "false"], dir);
  writeFileSync(path.join(dir, "README.md"), "# base\n");
  sh(["add", "."], dir);
  sh(["commit", "-qm", "base"], dir);
  return dir;
}

function lane(t, dir, name, file, body) {
  const where = path.join(path.dirname(dir), `${path.basename(dir)}-${name}`);
  t.after(() => rmSync(where, { recursive: true, force: true }));
  sh(["worktree", "add", "-q", "-b", `wtgui/${name}`, where, "main"], dir);
  mkdirSync(path.join(where, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(where, file), body);
  sh(["add", "."], where);
  sh(["commit", "-qm", `${name}: ${file}`], where);
  return { where, branch: `wtgui/${name}`, commit: sh(["rev-parse", "HEAD"], where) };
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("the pre-flight parses cleanly: a tree, no paths — and a conflict by path, never by sentence", () => {
  assert.deepEqual(parseMergeTree(`${"a".repeat(40)}\n`), { tree: "a".repeat(40), conflicts: [], clean: true });
  assert.deepEqual(parseMergeTree(`${"b".repeat(40)}\nreports/shared.md\n\nAuto-merging reports/shared.md\nCONFLICT (add/add): Merge conflict`), {
    tree: "b".repeat(40),
    conflicts: ["reports/shared.md"],
    clean: false,
  });
});

test("one aggregate merges every lane in ONE commit, verified against the pre-flight, with each report byte-identical", (t) => {
  const dir = repo(t);
  const base = sh(["rev-parse", "HEAD"], dir);
  const a = lane(t, dir, "lane-a", "reports/S1.md", "# report one\n");
  const b = lane(t, dir, "lane-b", "reports/S2.md", "# report two\n");
  const agg = path.join(path.dirname(dir), `${path.basename(dir)}-agg`);
  t.after(() => rmSync(agg, { recursive: true, force: true }));
  sh(["worktree", "add", "-q", "-b", "wtgui/aggregate", agg, "main"], dir);

  const branches = [
    { stage: "S1", branch: a.branch, commit: a.commit },
    { stage: "S2", branch: b.branch, commit: b.commit },
  ];
  const message = aggregateMessage({ id: "reports" }, { join: "S3" }, branches, base);
  assert.equal(message, `stage S3: aggregate 2 stage branches (S1, S2) from base ${base.slice(0, 12)}`);

  const pre = preflightMerge({ tree: agg, base, branches });
  assert.equal(pre.ok, true, pre.reason);
  assert.deepEqual(pre.conflicts, []);

  const out = aggregateBranches({ tree: agg, base, branches, message });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.merged, true);
  assert.equal(out.parents, 3, "one octopus commit: the base and both lanes");
  assert.equal(out.verified, true, "the merge wrote exactly the tree the pre-flight predicted");
  assert.equal(out.written, pre.tree);
  assert.equal(sh(["rev-list", "--count", "main..HEAD"], agg), "3", "two lane commits and the one merge — no second merge commit");

  // Byte for byte: each lane's report is in the aggregate AT THE SAME BYTES, and the blob is the lane's own blob.
  for (const [name, laneInfo] of [["reports/S1.md", a], ["reports/S2.md", b]]) {
    const merged = path.join(agg, name);
    assert.equal(existsSync(merged), true, `${name} must be in the aggregate`);
    assert.equal(sha256(merged), sha256(path.join(laneInfo.where, name)), `${name} must be byte-identical to the lane's own file`);
    assert.equal(sh(["rev-parse", `HEAD:${name}`], agg), sh(["rev-parse", `HEAD:${name}`], laneInfo.where), `${name}'s blob is the lane's blob`);
  }

  // The record the row carries: the commit, the base, and each lane's pin.
  const record = aggregateRecord({ commit: out.commit, base, branches, at: "2026-11-05T00:00:00.000Z", tree: { path: agg }, verified: out.verified });
  assert.equal(record.commit, out.commit);
  assert.equal(record.verified, true);
  assert.deepEqual(record.branches.map((entry) => [entry.stage, entry.branch, entry.commit]), [
    ["S1", a.branch, a.commit],
    ["S2", b.branch, b.commit],
  ]);

  // Running it again is not a second merge: every lane is already an ancestor, and the aggregate does not move.
  const again = aggregateBranches({ tree: agg, base, branches, message });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyMerged, true);
  assert.equal(again.commit, out.commit, "the aggregate commit is stable");
});

test("a lane that wrote a sibling's path is refused BY PATH before any merge starts", (t) => {
  const dir = repo(t);
  const base = sh(["rev-parse", "HEAD"], dir);
  const a = lane(t, dir, "lane-a", "reports/shared.md", "# one\n");
  const b = lane(t, dir, "lane-b", "reports/shared.md", "# two\n");
  const agg = path.join(path.dirname(dir), `${path.basename(dir)}-agg`);
  t.after(() => rmSync(agg, { recursive: true, force: true }));
  sh(["worktree", "add", "-q", "-b", "wtgui/aggregate", agg, "main"], dir);
  const before = sh(["rev-parse", "HEAD"], agg);
  const branches = [
    { stage: "S1", branch: a.branch, commit: a.commit },
    { stage: "S2", branch: b.branch, commit: b.commit },
  ];

  const out = aggregateBranches({ tree: agg, base, branches, message: "aggregate" });
  assert.equal(out.ok, false);
  assert.equal(out.code, AGGREGATE_FAULTS.CONFLICT);
  assert.deepEqual(out.conflicts, ["reports/shared.md"], "the path both lanes wrote, not a sentence about one of them");
  assert.equal(out.merged, false);
  assert.equal(sh(["rev-parse", "HEAD"], agg), before, "nothing was merged: HEAD did not move");
  assert.equal(sh(["status", "--porcelain"], agg), "", "and no merge is half-applied (no MERGE_HEAD, no unmerged path)");
  assert.equal(existsSync(path.join(agg, "reports/shared.md")), false, "the refused merge wrote no working file");
});

test("a lane whose commit the aggregate cannot resolve is a named shape fault, not a silent skip", (t) => {
  const dir = repo(t);
  const base = sh(["rev-parse", "HEAD"], dir);
  const a = lane(t, dir, "lane-a", "reports/S1.md", "# one\n");
  const agg = path.join(path.dirname(dir), `${path.basename(dir)}-agg`);
  t.after(() => rmSync(agg, { recursive: true, force: true }));
  sh(["worktree", "add", "-q", "-b", "wtgui/aggregate", agg, "main"], dir);
  const out = aggregateBranches({ tree: agg, base, branches: [{ stage: "S1", branch: a.branch, commit: "f".repeat(40) }], message: "x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, AGGREGATE_FAULTS.SHAPE);
  assert.match(out.reason, /cannot resolve/);
});

// ---- the plan a row is driven under -----------------------------------------------------------------------------
test("the lane branches are the commits the lanes settled at, and a lane that has not settled makes the merge unplannable", () => {
  const plan = { isolate: true, fork: null, lanes: ["S1", "S2"], join: "S3", block: ["S1", "S2", "S3"] };
  const settled = {
    stageRuns: [
      { stage: "S1", status: "done", commit: "1".repeat(40), tree: { branch: "wtgui/s1-aaa", path: "/t/s1" }, artifact: { id: "report-1", path: "reports/S1.md", sha256: "ab".repeat(32), blob: "2".repeat(40) } },
      { stage: "S2", status: "running", commit: null, tree: { branch: "wtgui/s2-bbb", path: "/t/s2" } },
    ],
  };
  const partial = aggregateBranchesOf(settled, plan, (run) => run.stageRuns);
  assert.equal(partial.ok, false);
  assert.match(partial.why, /S2/);

  const complete = aggregateBranchesOf(
    { stageRuns: [...settled.stageRuns, { stage: "S2", status: "done", commit: "3".repeat(40), tree: { branch: "wtgui/s2-bbb", path: "/t/s2" }, artifact: { id: "report-2", path: "reports/S2.md" } }] },
    plan,
    (run) => run.stageRuns,
  );
  assert.equal(complete.ok, true);
  assert.deepEqual(complete.branches.map((branch) => [branch.stage, branch.branch, branch.commit]), [
    ["S1", "wtgui/s1-aaa", "1".repeat(40)],
    ["S2", "wtgui/s2-bbb", "3".repeat(40)],
  ]);
  assert.equal(complete.branches[0].artifact, "report-1", "the aggregate carries the artifact each lane produced, not only its branch");
});
