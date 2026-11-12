// The worktree chart draws a round BESIDE main, with its stage trees under the round.
//
// A round's parent tree is cut from `origin/main` - a remote-tracking ref, not a local branch - so its record carries
// `parentRef: "origin/main"` and NO chart parent. The chart hangs a row under the row whose BRANCH equals `parent`,
// and no row is called `origin/main`: the round therefore draws at the top level, beside the checkout's `main` row,
// while its stage trees (recorded with the round's branch as their parent) hang one indent under the round.
//
// Two halves are proved here, together, because a picture that groups rows nobody recorded is as wrong as a record
// nothing draws:
//
//   1. THE SERVER half: a LIVE round - the real `Assistant.cutPipelineTree`, the real `Jobs.makeWorktree`, and a real
//      repository whose `origin/main` is a real remote-tracking ref - writes the round's record and its stage
//      children's records into the book the scan reads (`ParentBook.rowsFor`);
//   2. THE PAGE half: fed those very rows, the chart's own grouping (`childTreeOf`, `groupCtxOf`, `nestRowKeys` in
//      public/render-projects.js) draws main and the round as two top-level rows, with both stage trees under the
//      round - so a two-stage round reads as the round's own group, never as main's children.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";
import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { enterStage } from "../lib/task-pipeline.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const CLOCK = "2026-11-09T10:00:00.000Z";
const EMAIL = ["chart", "example.invalid"].join(String.fromCharCode(64));
const ROUND = { slug: "carry-the-form", tag: "a1b2c3", title: "carry the form" };

// A real repository whose `origin/main` is a real remote-tracking branch, and a checkout moved AHEAD of it: a round
// that started from the checkout's tip would carry a commit the remote has never seen, so the two tips must differ
// for the proof to mean anything.
function repo(t) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "wag-chart-nest-"));
  const dir = path.join(sandbox, "repo");
  const originDir = path.join(sandbox, "origin.git");
  const run = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=Chart Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (...args) => run(dir, ...args);
  const write = (rel, body) => writeFileSync(path.join(dir, rel), body);
  mkdirSync(path.join(dir, ".worktrees"), { recursive: true });
  git("init", "-q", "-b", "main");
  write("seed.txt", "the round began here\n");
  git("add", "-A");
  git("commit", "-qm", "the round's parent");
  run(sandbox, "init", "-q", "--bare", originDir);
  git("remote", "add", "origin", originDir.replace(/\\/g, "/"));
  git("push", "-q", "-u", "origin", "main");
  const originSha = git("rev-parse", "origin/main");
  write("local-only.md", "unpushed local work\n");
  git("add", "-A");
  git("commit", "-qm", "local work nobody pushed");
  const checkoutSha = git("rev-parse", "HEAD");
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return { dir, originDir, git, write, originSha, checkoutSha };
}

// The panel's own Assistant, with the panel's own cutter and parent book under it: `cutPipelineTree` is the method
// that named `main` as the round's chart parent, so the proof has to run through it, not around it.
function panel(t, dir, bundleFile) {
  const jobs = new Jobs({
    config: { apiServer: { url: "http://127.0.0.1:1" }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 60 },
    onEvent: () => {},
    onLog: () => {},
  });
  const parents = new ParentBook({ file: path.join(dir, "logs", "parents.json"), onLog: () => {} });
  jobs.parents = parents;
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "logs", "jobs.json"), assistantFile: path.join(dir, "logs", "assistant.json"), defaultCwd: dir, pipelineBundleFile: bundleFile },
    jobs: {
      list: () => [],
      firstOfThread: () => null,
      busyFor: () => ({ held: false, where: null, by: [] }),
      modelFor: () => null,
      get: () => null,
      create: async (opts) => ({ id: "job-1", status: "running", ...opts }),
      answerQuestion: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      clarify: { state: () => null },
      makeWorktree: (repoDir, prompt, opts) => jobs.makeWorktree(repoDir, prompt, opts),
    },
    getProjects: () => [{ name: "demo", path: dir }],
    getRows: () => [],
    onLog: () => {},
    now: () => Date.parse(CLOCK),
  });
  // The cut is what this file proves. The sweep the cut hands off to would need a bundle and a spawner to start the
  // stage, and starting it is a different file's subject.
  assistant.sweepQueues = () => {};
  t.after(() => {
    for (const timer of [assistant.persistTimer, assistant.wakeTimer, assistant.timer, assistant.settleTimer]) clearTimeout(timer);
  });
  return { assistant, jobs, parents };
}

// The document the row is assigned against: a draft stage, then a critique. Only the assignment reads it here.
const BUNDLE = {
  bundleVersion: 1,
  name: "review",
  pipelines: [
    {
      id: "review",
      title: "Review",
      stages: [
        { id: "D1", title: "Draft", prompt: "Write the draft.", artifact: { id: "draft", path: "draft.md", schema: "doc/1", writer: "the drafter", kind: "document" } },
        { id: "C1", title: "Critique", prompt: "Critique the draft.", inputs: { read: [{ artifact: "draft" }] }, artifact: { id: "critique", path: "critique.md", schema: "doc/1", writer: "the critic", kind: "document" } },
      ],
      gates: [],
      handoffs: [{ id: "h1", from: "D1", to: "C1", artifact: "draft", kind: "sequence" }],
    },
  ],
};

// The page's own grouping region, run with a stub `state` and a stub `keyOf`: the same functions the browser calls,
// with no board under them. The region carries DOM painters too; they are declared here and never called.
const page = readFileSync(new URL("../public/render-projects.js", import.meta.url), "utf8");
const region = sliceRegion(page, "children under their parent");
const keyOf = (project, p) => `${project}::${p}`;
const state = { rows: new Map(), foldedParents: new Set() };
const { childTreeOf, groupCtxOf, nestRowKeys, paintRowGroup } = new Function("state", "keyOf", "esc", "normPath", `${region}; return { childTreeOf, groupCtxOf, nestRowKeys, paintRowGroup };`)(
  state,
  keyOf,
  (s) => String(s ?? ""),
  (p) => { const s = String(p || "").split(String.fromCharCode(92)).join("/"); return s.endsWith("/") ? s.slice(0, -1) : s; },
);

test("a live round's parent draws beside main, and its two stage trees hang under the round", async (t) => {
  const r = repo(t);
  assert.notEqual(r.checkoutSha, r.originSha, "the fixture must move the checkout ahead of origin/main");
  const bundleFile = path.join(r.dir, "logs", "pipeline-bundle.json");
  mkdirSync(path.dirname(bundleFile), { recursive: true });
  writeFileSync(bundleFile, JSON.stringify(BUNDLE));
  const { assistant, parents } = panel(t, r.dir, bundleFile);

  const added = assistant.queueMutate("assistant-1", "add", { title: "the review round", project: "demo" });
  assert.equal(added.ok, true, added.error || "the row must be filed");
  const id = added.task.id;
  const assigned = assistant.queueMutate("assistant-1", "pipeline", { id, pipeline: "review", stage: "D1" });
  assert.equal(assigned.ok, true, assigned.error || "the row must be put on a stage");

  // THE ROUND'S FIRST CUT, through the method that had the defect: the round's parent tree from origin/main, then
  // stage D1's own child of it.
  const first = await assistant.cutPipelineTree("assistant-1", { taskId: id, pipeline: "review", stage: "D1", role: "stage", stageName: "Draft", position: 1, visit: 1 });
  assert.ok(first && first.pipelineRun, "the cut writes the row");
  const round = first.pipelineRun.round;
  assert.equal(round.base, "origin/main", "the round is cut from origin/main");
  assert.equal(round.sha, r.originSha, "at the remote's tip, not the checkout's");
  assert.equal(r.git("-C", round.parentPath, "rev-parse", "HEAD"), r.originSha);
  assert.equal(existsSync(path.join(round.parentPath, "local-only.md")), false, "the checkout's unpushed work is not in the round's tree");
  const d1 = first.pipelineRun.trees.D1;
  assert.ok(d1, "the first stage's tree is cut with the round's");

  // 1. THE SERVER HALF: what the scan reads.
  const roundRec = parents.get("demo", round.parent);
  assert.equal(roundRec.parent, null, "the round records NO local parent");
  assert.equal(roundRec.parentRef, "origin/main", "and records the ref it was cut from");
  assert.equal(roundRec.parentSha, r.originSha, "with the commit that ref resolved to");
  assert.equal(roundRec.parentSource, "unknown", "a remote-tracking ref is not a roll-up target");
  assert.match(roundRec.why, /origin\/main/, "and the record says why it is no parent");
  const d1Rec = parents.get("demo", d1.branch);
  assert.equal(d1Rec.parent, round.parent, "the stage tree hangs under the round's branch");
  assert.equal(d1Rec.parentSource, "cut", "a stage's parent is a local branch, watched at the cut");

  // The second stage. The row enters C1 the way a driver's advance does - `enterStage` keeps the round - and the same
  // cut makes its tree, so both children come from one round rather than two.
  const qfile = assistant.queuePathOf(assistant.assistantRecord("assistant-1"));
  const q = readQueueFile(qfile);
  const moved = enterStage(q.tasks.find((task) => Number(task.id) === Number(id)), { stage: "C1", enteredAt: CLOCK });
  writeQueueFile(qfile, q.tasks.map((task) => (Number(task.id) === Number(id) ? moved : task)), q.nextId);
  const second = await assistant.cutPipelineTree("assistant-1", { taskId: id, pipeline: "review", stage: "C1", role: "stage", stageName: "Critique", position: 2, visit: 1 });
  assert.ok(second && second.pipelineRun, "the second cut writes the row");
  const c1 = second.pipelineRun.trees.C1;
  assert.ok(c1, "the second stage's tree is cut");
  assert.equal(parents.get("demo", c1.branch).parent, round.parent, "and hangs under the round too");
  assert.equal(second.pipelineRun.round.parentPath, round.parentPath, "ONE round: the second cut did not replace it");

  // The ref the cut recorded survives the slow clock that reconstructs parents: a reconstruction agreeing with
  // "no parent" must not blank `origin/main` off the record.
  await parents.refresh({ project: "demo", repoDir: r.dir, mainBranch: "main" });
  const after = parents.get("demo", round.parent);
  assert.equal(after.parent, null);
  assert.equal(after.parentRef, "origin/main", "the ref the cut recorded survives a refresh");
  assert.equal(after.parentSha, r.originSha);

  // 2. THE PAGE HALF: the rows the chart would hold, from those records plus the checkout's own row.
  const rows = parents.rowsFor("demo");
  const mainPath = r.dir.replace(/\\/g, "/");
  const chartRows = [
    { project: "demo", path: mainPath, branch: "main", parent: null },
    ...rows.map((rec) => ({ project: "demo", path: rec.path, branch: rec.branch, parent: rec.parent, parentSource: rec.parentSource })),
  ];
  state.rows = new Map(chartRows.map((row) => [keyOf(row.project, row.path), row]));
  state.foldedParents = new Set();

  const rowKey = (branch) => keyOf("demo", rows.find((row) => row.branch === branch).path);
  const tree = childTreeOf("demo");
  const mainKey = keyOf("demo", mainPath);
  const roundKey = rowKey(round.parent);
  const d1Key = rowKey(d1.branch);
  const c1Key = rowKey(c1.branch);
  assert.equal(tree.parentOf.get(roundKey), undefined, "the round is a top-level row, BESIDE main");
  assert.deepEqual(tree.childrenOf.get(mainKey) || [], [], "main has no children: the round is not nested under it");
  assert.equal(tree.parentOf.get(d1Key), roundKey, "stage 1 hangs under the round");
  assert.equal(tree.parentOf.get(c1Key), roundKey, "and stage 2 does too");
  assert.deepEqual(tree.childrenOf.get(roundKey), [d1Key, c1Key], "ONE group: the round's stage trees together");

  // The drawing order: main and the round at the top (in the order the rows arrive), both stage trees directly under
  // the round even when the input order put them first.
  const order = nestRowKeys(tree.parentOf, [d1Key, mainKey, roundKey, c1Key]);
  assert.deepEqual(order, [mainKey, roundKey, d1Key, c1Key], "main and the round are top-level; the stage trees follow the round");

  // One indent in, with the round's own fold covering both stages and nothing under main.
  const roundCtx = groupCtxOf(tree, roundKey);
  assert.equal(roundCtx.parentKey, null, "the round is not one indent in");
  assert.equal(roundCtx.depth, 0);
  assert.equal(roundCtx.childCount, 2, "the round offers the fold that hides its stages");
  assert.equal(groupCtxOf(tree, d1Key).parentKey, roundKey);
  assert.equal(groupCtxOf(tree, d1Key).depth, 1);
  assert.equal(groupCtxOf(tree, d1Key).childCount, 0, "a stage tree has no children of its own");

  // The reader's fold reaches the round's stages, and only them.
  state.foldedParents.add(roundKey);
  assert.equal(groupCtxOf(tree, d1Key).hidden, true, "folding the round hides stage 1");
  assert.equal(groupCtxOf(tree, c1Key).hidden, true, "and stage 2");
  assert.equal(groupCtxOf(tree, roundKey).hidden, false, "the round stays on screen");
  assert.equal(groupCtxOf(tree, mainKey).hidden, false, "and main is untouched by the round's fold");
});

test("a book that still says `main` for the round's parent tree draws the same sibling picture", () => {
  // A record written before the cut stopped naming main (or a hand-edited book). The page refuses the edge, so the
  // board a reader already has draws the round the same way without a migration.
  const root = "/repo/demo";
  const rows = [
    { project: "demo", path: root, branch: "main", parent: null },
    { project: "demo", path: `${root}/.worktrees/carry-the-form-a1b2c3`, branch: "wtgui/carry-the-form-a1b2c3", parent: "main", parentSource: "cut" },
    { project: "demo", path: `${root}/.worktrees/carry-the-form-stage-1-write-the-draft-111111`, branch: "wtgui/carry-the-form-stage-1-write-the-draft-111111", parent: "wtgui/carry-the-form-a1b2c3", parentSource: "cut" },
  ];
  state.rows = new Map(rows.map((row) => [keyOf(row.project, row.path), row]));
  state.foldedParents = new Set();
  const tree = childTreeOf("demo");
  const mainKey = keyOf("demo", root);
  const parentKey = keyOf("demo", rows[1].path);
  const childKey = keyOf("demo", rows[2].path);
  assert.equal(tree.parentOf.get(parentKey), undefined, "main is never a row's parent, so the parent tree is top-level");
  assert.equal(tree.parentOf.get(childKey), parentKey, "and the stage tree still hangs under it");
  assert.equal(tree.childrenOf.get(mainKey), undefined, "the checkout gains no children");
});


test("a board that has just booted groups a round from its own record, with no scanned parent edge", () => {
  // What a full restart leaves behind: every row carries the round's NAME from the queue task, and none carries a
  // scanned `parent` yet (the parent book is consulted by the scan, lib/scan.js `parentFor`, not by the snapshot).
  // The chart must draw the group from the record - the store the names come from - instead of waiting for a scan.
  const root = "/repo/demo";
  const parent = `${root}/.worktrees/round-c-5b3b85`;
  const probe = `${root}/.worktrees/round-c-stage-1-probe-294b21`;
  const conclude = `${root}/.worktrees/round-c-stage-2-conclude-7ace4b`;
  const rows = [
    { project: "demo", path: root, branch: "main", parent: null },
    { project: "demo", path: parent, branch: "wtgui/round-c-5b3b85", parent: "main", parentSource: "cut", round: { display: "Round C", role: "parent", parentPath: null } },
    { project: "demo", path: probe, branch: "wtgui/round-c-stage-1-probe-294b21", parentSource: "unknown", round: { display: "Stage 1: Probe", role: "stage", position: 1, parentPath: parent } },
    { project: "demo", path: conclude, branch: "wtgui/round-c-stage-2-conclude-7ace4b", parentSource: "unknown", round: { display: "Stage 2: Conclude", role: "stage", position: 2, parentPath: parent } },
  ];
  state.rows = new Map(rows.map((row) => [keyOf(row.project, row.path), row]));
  state.foldedParents = new Set();
  const tree = childTreeOf("demo");
  const parentKey = keyOf("demo", parent);
  assert.equal(tree.parentOf.get(parentKey), undefined, "the round's parent tree is still a sibling of the checkout");
  assert.equal(tree.parentOf.get(keyOf("demo", probe)), parentKey, "the first stage tree groups with no scanned parent edge");
  assert.equal(tree.parentOf.get(keyOf("demo", conclude)), parentKey, "and so does the second");
  assert.deepEqual(tree.childrenOf.get(parentKey).sort(), [keyOf("demo", conclude), keyOf("demo", probe)].sort());

  // A stage tree whose recorded parent tree has no row keeps its own place: a child never hangs under a row that is
  // not drawn, and it does not fall back to a scanned edge the record did not name.
  state.rows = new Map([
    [keyOf("demo", probe), { project: "demo", path: probe, branch: "wtgui/round-c-stage-1-probe-294b21", parent: "wtgui/something-else-111111", round: { display: "Stage 1: Probe", role: "stage", parentPath: parent } }],
  ]);
  assert.equal(childTreeOf("demo").parentOf.get(keyOf("demo", probe)), undefined, "no parent row, no edge");
});


// ---- what a row WRITES as its indent -------------------------------------------------------------------------------
//
// `groupCtxOf` says how deep a row is; `paintRowGroup` is where that number becomes the row's `--child-depth`, and one
// rule in public/chart.css turns the variable into the indent for EVERY row. That seam is what this half pins, because
// the two ways it can be wrong are both invisible to a depth-only test:
//
//   • a row that writes NOTHING (the group parent, before this landed) falls back to the browser's 0 by luck, and a
//     later rule keyed on the variable cannot reach it at all;
//   • a row whose markers size themselves shifts its own text, which is the defect the chart actually showed: the fold
//     pushed the parent 18px into the children's column, and a nested parent's fold put its name further in than the
//     child's beneath it.
//
// The painter is run against a bare stub of a table row (no browser, no page), so the assertion is about the numbers
// and the markers the painter writes, not about a rendered column.
function fakeRow() {
  const vars = new Map();
  const attrs = new Map();
  const classes = new Set();
  const lead = {
    nodes: [],
    insertAdjacentHTML(where, html) {
      const kind = html.includes("child-tick") ? "tick" : html.includes("btn-row-fold") ? "fold" : "other";
      const node = {
        kind,
        textContent: kind === "tick" ? "\u2514" : "\u25be",
        title: "",
        attrs: new Map(),
        classList: { toggle() {} },
        getAttribute(name) { return this.attrs.get(name) ?? null; },
        setAttribute(name, value) { this.attrs.set(name, String(value)); },
        remove() { lead.nodes = lead.nodes.filter((n) => n !== node); },
      };
      if (where === "afterbegin") lead.nodes.unshift(node);
      else lead.nodes.push(node);
      return node;
    },
    querySelector(sel) {
      const want = sel === ".child-tick" ? "tick" : "fold";
      return lead.nodes.find((n) => n.kind === want) || null;
    },
    count(kind) { return lead.nodes.filter((n) => n.kind === kind).length; },
  };
  return {
    dataset: {},
    vars,
    attrs,
    classes,
    lead,
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    style: {
      getPropertyValue: (name) => vars.get(name) ?? "",
      setProperty: (name, value) => vars.set(name, value),
      removeProperty: (name) => vars.delete(name),
    },
    hasAttribute: (name) => attrs.has(name),
    removeAttribute: (name) => attrs.delete(name),
    querySelector: (sel) => (sel === "td.name .row-lead" ? lead : null),
  };
}

test("every row writes the depth it draws at: a group parent 0, its children 1, the nested parent 1, the grandchild 2", () => {
  const root = "/repo/demo";
  const at = (tail) => `${root}/.worktrees/${tail}`;
  const rows = [
    { project: "demo", path: root, branch: "main", parent: null },
    { project: "demo", path: at("plain-aaaaaa"), branch: "wtgui/plain-aaaaaa", parent: null },
    { project: "demo", path: at("group-bbbbbb"), branch: "wtgui/group-bbbbbb", parent: null },
    { project: "demo", path: at("group-stage-1-cccccc"), branch: "wtgui/group-stage-1-cccccc", parent: "wtgui/group-bbbbbb", parentSource: "cut" },
    { project: "demo", path: at("group-stage-2-eeeeee"), branch: "wtgui/group-stage-2-eeeeee", parent: "wtgui/group-bbbbbb", parentSource: "cut" },
    { project: "demo", path: at("group-stage-1-sub-dddddd"), branch: "wtgui/group-stage-1-sub-dddddd", parent: "wtgui/group-stage-1-cccccc", parentSource: "cut" },
  ];
  state.rows = new Map(rows.map((row) => [keyOf(row.project, row.path), row]));
  state.foldedParents = new Set();
  const tree = childTreeOf("demo");
  const drawn = new Set(rows.map((row) => keyOf(row.project, row.path)));
  const paint = (path) => {
    const row = rows.find((r) => r.path === path);
    const key = keyOf(row.project, row.path);
    const ctx = groupCtxOf(tree, key, drawn);
    const tr = fakeRow();
    paintRowGroup(tr, row, key, ctx);
    return { ctx, tr };
  };

  // The group. Its parent row hangs under nothing, so it is depth 0 - the same answer the ungrouped sibling gets, and
  // the same indent the CSS reads back for both.
  const parent = paint(at("group-bbbbbb"));
  assert.equal(parent.ctx.parentKey, null, "the group's parent row hangs under nobody");
  assert.equal(parent.ctx.depth, 0, "so it is depth 0, not its children's depth");
  assert.equal(parent.tr.style.getPropertyValue("--child-depth"), "0", "and it WRITES that 0 for the indent rule");
  assert.equal(parent.tr.dataset.depth, "0", "the data attribute the gates read says the same");
  assert.equal(parent.tr.classes.has("is-parent"), true, "it is a parent: it carries the fold");
  assert.equal(parent.tr.classes.has("is-child"), false, "and it is not drawn as a child");
  assert.equal(parent.tr.lead.count("tick"), 0, "a group's parent row draws NO child tick");
  assert.equal(parent.tr.lead.count("fold"), 1, "its fold sits in the gutter to its left");

  // The ungrouped sibling. Same depth, same written value: that equality IS the alignment.
  const plain = paint(at("plain-aaaaaa"));
  assert.equal(plain.ctx.parentKey, null);
  assert.equal(plain.ctx.depth, 0);
  assert.equal(plain.tr.style.getPropertyValue("--child-depth"), parent.tr.style.getPropertyValue("--child-depth"));
  assert.equal(plain.tr.dataset.depth, "0");
  assert.equal(plain.tr.classes.size, 0, "an ungrouped row is neither a child nor a parent");

  // The parent's children stay at depth 1 - INCLUDING the one that is itself a group, which takes its parent's
  // children's depth and nothing more.
  for (const tail of ["group-stage-1-cccccc", "group-stage-2-eeeeee"]) {
    const child = paint(at(tail));
    assert.equal(child.ctx.parentKey, keyOf("demo", at("group-bbbbbb")), `${tail} hangs from the group's parent row`);
    assert.equal(child.ctx.depth, 1, `${tail} is one indent in`);
    assert.equal(child.tr.style.getPropertyValue("--child-depth"), "1", `${tail} writes its own depth`);
    assert.equal(child.tr.lead.count("tick"), 1, `${tail} draws exactly one tick`);
    assert.equal(child.tr.classes.has("is-child"), true);
  }
  const nested = paint(at("group-stage-1-cccccc"));
  assert.equal(nested.ctx.childCount, 1, "the nested group's own child is drawn");
  assert.equal(nested.tr.classes.has("is-parent"), true, "so it carries a fold as well");
  assert.equal(nested.tr.lead.count("fold"), 1);
  assert.equal(nested.ctx.depth, paint(at("group-stage-2-eeeeee")).ctx.depth, "a nested parent sits in its siblings' column");

  // The second tier: one more indent, never two.
  const grand = paint(at("group-stage-1-sub-dddddd"));
  assert.equal(grand.ctx.parentKey, keyOf("demo", at("group-stage-1-cccccc")));
  assert.equal(grand.ctx.depth, 2, "the grandchild is one step past its own parent");
  assert.equal(grand.tr.style.getPropertyValue("--child-depth"), "2");
  assert.equal(grand.tr.lead.count("tick"), 1);
  assert.equal(grand.tr.lead.count("fold"), 0, "a leaf draws no fold");

  // Nesting is EXACTLY one indent per level: each step is +1 on the row above, and the two top-level shapes agree.
  const ladder = [parent.ctx.depth, nested.ctx.depth, grand.ctx.depth];
  assert.deepEqual(ladder, [0, 1, 2]);
  assert.equal(ladder[0], plain.ctx.depth, "a group parent and an ungrouped sibling draw at the same depth");
});

test("the indent counts rows that are DRAWN, so a held-back row cannot step its grandchild in twice", () => {
  const root = "/repo/demo";
  const at = (tail) => `${root}/.worktrees/${tail}`;
  const rows = [
    { project: "demo", path: at("group-bbbbbb"), branch: "wtgui/group-bbbbbb", parent: null },
    { project: "demo", path: at("group-stage-1-cccccc"), branch: "wtgui/group-stage-1-cccccc", parent: "wtgui/group-bbbbbb", parentSource: "cut" },
    { project: "demo", path: at("group-stage-1-sub-dddddd"), branch: "wtgui/group-stage-1-sub-dddddd", parent: "wtgui/group-stage-1-cccccc", parentSource: "cut" },
  ];
  state.rows = new Map(rows.map((row) => [keyOf(row.project, row.path), row]));
  state.foldedParents = new Set();
  const tree = childTreeOf("demo");
  const all = rows.map((row) => keyOf(row.project, row.path));
  // The chart's top-N holds the GRANDparent back. Its child is drawn at the top level and its grandchild under that
  // child - so the grandchild is one indent in, counted from the row it is actually drawn beneath.
  const drawn = new Set(all.filter((k) => k !== keyOf("demo", at("group-bbbbbb"))));
  const mid = groupCtxOf(tree, keyOf("demo", at("group-stage-1-cccccc")), drawn);
  assert.equal(mid.parentKey, null, "its own parent is off the chart");
  assert.equal(mid.depth, 0, "so it is drawn at the top level");
  const grand = groupCtxOf(tree, keyOf("demo", at("group-stage-1-sub-dddddd")), drawn);
  assert.equal(grand.parentKey, keyOf("demo", at("group-stage-1-cccccc")), "it still hangs under its drawn parent");
  assert.equal(grand.depth, mid.depth + 1, "exactly one step in from it - not two, counting the row that is gone");
  // With every row on the chart the same tree is still one step per level: 0, 1, 2.
  const every = new Set(all);
  assert.deepEqual(
    [keyOf("demo", at("group-bbbbbb")), keyOf("demo", at("group-stage-1-cccccc")), keyOf("demo", at("group-stage-1-sub-dddddd"))].map(
      (k) => groupCtxOf(tree, k, every).depth,
    ),
    [0, 1, 2],
  );
});

// ---- the TITLE each of those rows paints ---------------------------------------------------------------------------
//
// The grouping above decides WHERE a round's trees are drawn; the title decides what each row is CALLED. That half is
// `treeTitleOf` in public/app.js, a pure read of the row plus the page's stores, so it is proved at the same seam: the
// real function, sliced out of the page, with a stub `state` under it. The case that matters is the one a fresh browser
// is in - an EMPTY `wtgui.treenames` map - where the row must still read the round's own name.
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const namingRegion = sliceRegion(appSource, "what a worktree is called on the board");
const nameState = { projects: new Map(), treeNames: new Map() };
const { treeTitleOf } = new Function("state", "keyOf", "agentsFor", "normPath", `${namingRegion}; return { treeTitleOf };`)(
  nameState,
  keyOf,
  () => [],
  (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, ""),
);
// render-projects.js `rowHtml`'s own fallback: a title of "" draws the row's directory name.
const shownNameOf = (row) => treeTitleOf(row) || row.name;
const ROOT = "/repo/demo";
const roundRow = (tail, round) => ({ project: "demo", path: `${ROOT}/.worktrees/${tail}`, name: tail, round });

test("an empty treenames map still paints a round's own names, not the directory", () => {
  nameState.projects = new Map([["demo", { path: ROOT }]]);
  nameState.treeNames = new Map(); // a browser that has never typed a name

  const parent = roundRow("round-a-052254", { role: "parent", display: "274: parent row reads the task name" });
  const child = roundRow("round-a-stage-2-implement-9d41f0", { role: "stage", position: 2, display: "Stage 2: implement" });

  assert.equal(treeTitleOf(parent), "274: parent row reads the task name");
  assert.equal(treeTitleOf(child), "Stage 2: implement");
  // The directory name is the fallback, so a row painting it is exactly what a fresh profile did before the record.
  assert.notEqual(shownNameOf(parent), parent.name);
  assert.notEqual(shownNameOf(child), child.name);
});

test("the record wins over a name typed into this browser; a record with no display leaves the directory", () => {
  nameState.projects = new Map([["demo", { path: ROOT }]]);
  nameState.treeNames = new Map([[keyOf("demo", `${ROOT}/.worktrees/round-a-052254`), "typed by hand in this profile"]]);

  const parent = roundRow("round-a-052254", { role: "parent", display: "274: parent row reads the task name" });
  assert.equal(treeTitleOf(parent), "274: parent row reads the task name", "the round's record is the board's name");

  // A record that names the tree but carries no words: the page paints nothing, and the row shows the directory.
  const bare = roundRow("round-a-legacy-1a2b3c", { role: "parent", display: null });
  assert.equal(treeTitleOf(bare), "");
  assert.equal(shownNameOf(bare), "round-a-legacy-1a2b3c");
});

test("a tree no round cut keeps the name the reader typed, then the agent's title", () => {
  nameState.projects = new Map([["demo", { path: ROOT }]]);
  nameState.treeNames = new Map([[keyOf("demo", `${ROOT}/.worktrees/plain-0a1b2c`), "typed by hand in this profile"]]);
  assert.equal(treeTitleOf({ project: "demo", path: `${ROOT}/.worktrees/plain-0a1b2c`, name: "plain-0a1b2c" }), "typed by hand in this profile");
  assert.equal(treeTitleOf({ project: "demo", path: `${ROOT}/.worktrees/other-0a1b2c`, name: "other-0a1b2c" }), "");
});

test("the project's own checkout keeps the folder's name whatever the record says", () => {
  nameState.projects = new Map([["demo", { path: ROOT }]]);
  assert.equal(treeTitleOf({ project: "demo", path: `${ROOT}/`, name: "demo", round: { role: "parent", display: "a round name" } }), "");
});
