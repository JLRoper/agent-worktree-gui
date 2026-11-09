// One tree per stage of a pipeline round, all cut from ONE frozen parent.
//
// The model this replaces: a row had ONE tree, cut before its first stage, and every later stage ran its agent in
// that same directory. Two things followed, and both are defects rather than conveniences:
//
//   1. every cut re-resolved the parent branch, so a tree cut halfway through a round started at whatever main was
//      THEN - work that landed after the round began was in the second stage's workspace and not in the first's;
//   2. a critique stage read the draft because the draft was sitting beside it in the same directory. The document
//      said nothing about it, so a stage could read any file an earlier stage left behind.
//
// This file pins the replacement, against REAL git:
//
//   1. a stage tree is cut at the round's frozen commit, so a commit that landed on the parent branch after the round
//      began cannot be seen in it - and the driver asks for that commit, never the branch;
//   2. a critique stage receives the draft through its DECLARED INPUT (`inputs.read` and the handoff pin), resolved
//      by `artifactOf` at the writer's own commit, and its own tree does not contain the draft stage's file at all.
//
// The third proof - that the worktree chart nests a round's stage trees under the round's parent - is
// test/chart-nesting.test.js: it reads the record THIS file's cuts write.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { parseBundle } from "../lib/pipeline-bundle.js";
import { pinOf } from "../lib/stage-pin.js";
import { beginStageRun, settleStageRun } from "../lib/task-pipeline.js";
import { driveTaskPipelines, inputManifest, stagePrompt, stageTreeLookup } from "../lib/task-pipeline-drive.js";

const CLOCK = "2026-11-09T10:00:00.000Z";
// Written as a join so the address is not scanned as one in this file: the same trick test/task-pipeline-pins.test.js
// uses.
const EMAIL = ["stage", "example.invalid"].join(String.fromCharCode(64));
const DRAFT_BODY = "# the draft\n\nwhat the critique has to read\n";

// A real repository on `main` with one commit: the round's parent. Every assertion here is a git reading, so a fixture
// that faked one would prove nothing.
function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-stage-trees-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Stage Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (rel, body) => {
    const at = path.join(dir, rel);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, body);
  };
  git("init", "-q", "-b", "main");
  write("seed.txt", "the round began here\n");
  git("add", "-A");
  git("commit", "-qm", "the round's parent");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, git, write };
}

// The panel's own cutter, with the two books it writes a cut into.
function cutter(t, dir) {
  const jobs = new Jobs({
    config: { apiServer: { url: "http://127.0.0.1:1" }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 60 },
    onEvent: () => {},
    onLog: () => {},
  });
  const parents = new ParentBook({ file: path.join(dir, "logs", "parents.json"), onLog: () => {} });
  jobs.parents = parents;
  return { jobs, parents };
}

const DRAFT = { id: "draft", path: "draft.md", schema: "doc/1", writer: "the drafter", kind: "document" };
const CRITIQUE = { id: "critique", path: "critique.md", schema: "doc/1", writer: "the critic", kind: "document" };

// The document: a draft stage, then a critique that DECLARES the draft as an input it reads. The handoff carries the
// same artifact, which is the one fact the previous stage proved.
const DOC = {
  bundleVersion: 1,
  name: "review",
  pipelines: [
    {
      id: "review",
      title: "Review",
      stages: [
        { id: "D1", title: "Draft", prompt: "Write the draft.", artifact: DRAFT },
        { id: "C1", title: "Critique", prompt: "Critique the draft.", inputs: { read: [{ artifact: "draft" }] }, artifact: CRITIQUE },
      ],
      gates: [],
      handoffs: [{ id: "h1", from: "D1", to: "C1", artifact: "draft", kind: "sequence" }],
    },
  ],
};

const parsed = parseBundle(DOC, { file: "review.json" });
assert.equal(parsed.ok, true, parsed.reason || "the fixture bundle must parse");
const PIPELINE = parsed.bundle.pipelines[0];
const [DRAFT_STAGE, CRITIQUE_STAGE] = PIPELINE.stages;

const row = (over = {}) => ({
  id: 1,
  title: "the review round",
  detail: "",
  state: "queued",
  thread: null,
  threads: [],
  worktree: null,
  project: "demo",
  files: [],
  attempts: 0,
  reason: "",
  hold: null,
  ...over,
});

test("a stage tree is cut at the round's frozen parent: a landing after the round began is not in it", async (t) => {
  const r = repo(t);
  const { jobs, parents } = cutter(t, r.dir);

  // The FIRST cut of the round. Nothing pinned it, so it resolves the parent checkout's branch and writes both halves
  // of the answer down - the branch, and the commit it resolved to at that moment.
  const draft = await jobs.makeWorktree(r.dir, "write the draft", { project: "demo", round: true });
  const roundSha = r.git("rev-parse", "main");
  assert.equal(draft.startRef, "main", "the first cut is from the checkout's branch");
  assert.equal(draft.startSha, roundSha, "and records the commit it resolved to");
  assert.equal(draft.parentName, "main", "the branch is the record's parent, even though it is a main branch");
  const draftRec = parents.get("demo", draft.branch);
  assert.equal(draftRec.parent, "main", "the parent book names the branch the chart hangs the tree under");
  assert.equal(draftRec.parentSource, "cut", "and says the panel watched the cut, not that it guessed");
  assert.equal(draftRec.parentSha, roundSha);

  // A LANDING, after the round began. This is the commit the old model let a mid-round cut see.
  r.write("landed-after.md", "landed on main after the round began\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "a landing after the round began");
  const landed = r.git("rev-parse", "main");
  assert.notEqual(landed, roundSha, "the fixture must actually move main");

  // The SECOND stage's tree, cut the way the assistant cuts it: at the round's commit, from the round's parent.
  const critique = await jobs.makeWorktree(r.dir, "critique the draft", { project: "demo", from: roundSha, parent: "main" });
  assert.notEqual(critique.branch, draft.branch, "each stage has its own branch");
  assert.notEqual(critique.path, draft.path, "and its own directory");
  assert.equal(r.git("-C", critique.path, "rev-parse", "HEAD"), roundSha, "the stage tree is at the round's commit, not main's tip");
  assert.equal(existsSync(path.join(critique.path, "landed-after.md")), false, "the landing is NOT in the stage's workspace");
  assert.equal(r.git("-C", critique.path, "ls-tree", "--name-only", "HEAD", "landed-after.md"), "", "and the commit does not name it either");
  // …and the parent is written the same way, so the chart can hang it under the round's parent even though the cut was
  // pinned to a sha (a record whose parentRef is a sha names no branch to nest under).
  const critiqueRec = parents.get("demo", critique.branch);
  assert.equal(critiqueRec.parent, "main");
  assert.equal(critiqueRec.parentSource, "cut");
  assert.equal(critiqueRec.parentSha, roundSha, "the record names the commit the round froze, not main's new tip");
});

test("the driver asks for the round's frozen commit, never the branch as it stands now", () => {
  const roundSha = "9f3c1a2d4e5f60718293a4b5c6d7e8f901234567";
  // A row at its SECOND stage: the first settled, the tree for the second not cut yet. Its round was recorded at the
  // first cut, and the commit still landed on the parent branch since - the driver must not care.
  let task = row({
    pipelineRun: {
      pipeline: "review",
      stage: "C1",
      enteredAt: CLOCK,
      via: "h1",
      round: { parent: "main", sha: roundSha, at: CLOCK, by: "panel" },
      visits: { D1: 1, C1: 1 },
      trees: {
        D1: { path: "C:/demo/.worktrees/write-the-draft-a1b2c3", branch: "wtgui/write-the-draft-a1b2c3", startSha: roundSha, parent: "main" },
      },
      stageRuns: [{ id: "review/D1#1", stage: "D1", visit: 1, status: "done", thread: "T1", artifact: { id: "draft", path: "draft.md", present: true } }],
    },
  });
  task = beginStageRun(task, { stage: "C1", at: CLOCK });
  const lookup = stageTreeLookup(task, PIPELINE, task.pipelineRun);
  assert.equal(lookup.needed, true, "the second stage has no tree of its own yet");
  assert.equal(lookup.path, null, "and does NOT answer the first stage's tree");

  const out = driveTaskPipelines([task], { bundle: parsed.bundle, jobs: [], isLive: () => false, at: CLOCK, unattended: true });
  assert.equal(out.ensureTree.length, 1, "the cut is asked for");
  assert.equal(out.ensureTree[0].stage, "C1");
  assert.equal(out.ensureTree[0].role, "stage", "a chain stage's own tree, not the row's");
  assert.equal(out.ensureTree[0].base, roundSha, "cut at the commit the round began at");
  assert.equal(out.ensureTree[0].parent, "main", "and recorded under the round's parent");
  assert.equal(out.starts.length, 0, "nothing starts until the tree exists");
});

test("a critique stage receives the draft by declared input, and its own tree does not contain it", async (t) => {
  const r = repo(t);
  const { jobs } = cutter(t, r.dir);

  // Stage one's tree, with the draft written and committed - the pin is a blob at a commit, not a hash of a checkout.
  const draftTree = await jobs.makeWorktree(r.dir, "write the draft", { project: "demo" });
  writeFileSync(path.join(draftTree.path, "draft.md"), DRAFT_BODY);
  r.git("-C", draftTree.path, "add", "draft.md");
  r.git("-C", draftTree.path, "commit", "-qm", "the draft");
  const draftSha = r.git("-C", draftTree.path, "rev-parse", "HEAD");
  const pin = pinOf(draftTree.path, "draft.md", { commit: draftSha });
  assert.ok(pin.blob, "the draft is committed, so it has a blob");

  // Stage two's tree, cut at the round's frozen parent. It has never seen the draft.
  const critiqueTree = await jobs.makeWorktree(r.dir, "critique the draft", { project: "demo", from: draftTree.startSha, parent: "main" });
  assert.equal(existsSync(path.join(critiqueTree.path, "draft.md")), false, "the draft stage's file is NOT in the critique's tree");
  assert.equal(r.git("-C", critiqueTree.path, "rev-parse", "HEAD"), draftTree.startSha);

  // The record the driver reads: D1 settled, its artifact PINNED to the commit and the blob it wrote.
  let task = row({
    pipelineRun: {
      pipeline: "review",
      stage: "C1",
      enteredAt: CLOCK,
      via: "h1",
      round: { parent: "main", sha: draftTree.startSha, at: CLOCK, by: "panel" },
      visits: { D1: 1, C1: 1 },
      trees: { D1: { path: draftTree.path, branch: draftTree.branch, startSha: draftTree.startSha } },
    },
  });
  task = beginStageRun(task, { stage: "D1", at: CLOCK });
  task = settleStageRun(task, {
    stage: "D1",
    status: "done",
    at: CLOCK,
    commit: draftSha,
    artifact: { id: "draft", path: "draft.md", file: "draft.md", present: true, commit: draftSha, blob: pin.blob, blobSha256: pin.sha256 },
  });
  const run = task.pipelineRun;

  // 1. The handoff: the edge the row arrived by carries the draft, resolved at the writer's commit.
  const handed = inputManifest({ pipeline: PIPELINE, stage: CRITIQUE_STAGE, run, worktree: critiqueTree.path, commit: draftTree.startSha });
  const byEdge = handed.entries.find((entry) => entry.artifact === "draft");
  assert.ok(byEdge, "the draft is in the manifest");
  assert.equal(byEdge.via, "handoff");
  assert.equal(byEdge.present, true, "present — read at the writer's commit, not looked for in this tree");
  assert.equal(byEdge.commit, draftSha, "pinned to the commit the draft stage settled at");
  assert.equal(byEdge.readAt, draftSha, "and the entry says where it was actually read");
  assert.equal(byEdge.sha256, pin.sha256, "hashed from the BLOB the commit holds");
  assert.equal(byEdge.blob, pin.blob);

  // 2. The stage's own DECLARATION (`inputs.read[]`), with no handoff to lean on: a fresh agent handed the record
  //    still resolves the draft the same way.
  const declared = inputManifest({ pipeline: PIPELINE, stage: CRITIQUE_STAGE, run: { ...run, via: null }, worktree: critiqueTree.path, commit: draftTree.startSha });
  const byRead = declared.entries.find((entry) => entry.artifact === "draft");
  assert.ok(byRead, "the stage declares the draft as an input it reads");
  assert.equal(byRead.via, "read");
  assert.equal(byRead.present, true);
  assert.equal(byRead.commit, draftSha);

  // 3. The prompt the critique's worker is handed says WHERE it is, and says it is not in its own tree.
  const prompt = stagePrompt(task, PIPELINE, CRITIQUE_STAGE, {
    run,
    tree: { path: critiqueTree.path, branch: critiqueTree.branch },
    facts: { head: critiqueTree.branch, commit: draftTree.startSha, dirty: 0 },
  });
  assert.match(prompt, /INPUTS/);
  assert.match(prompt, /NOT in this stage's tree/);
  assert.match(prompt, new RegExp(`git show ${draftSha.slice(0, 12)}:draft\\.md`));
  // The workspace line still names the critique's OWN tree, so the reader can see the two are different directories.
  assert.ok(prompt.includes(`  tree        ${critiqueTree.path}   branch ${critiqueTree.branch}`), "the stage's own tree is named");
});
