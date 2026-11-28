// A TURNOVER BRANCH IS A ROW, AND ITS CHILDREN HANG UNDER IT.
//
// Row 406 is the model, in the reader's own words: root trees are research or turnover and never implementation, a
// multi-agent feature is ONE turnover parent with its children under it, and a small one-off that lands is a single
// turnover branch carrying its own research and implementation. The chart has to draw that model, so this file pins
// the two halves that can be wrong independently:
//
//   1. THE PAGE HALF, run with a stub `state` and no browser (the same harness test/chart-nesting.test.js uses):
//      - every turnover branch the project NAMES has a row of its own, the worktree standing on it when there is one
//        and a placeholder row for the branch when there is not;
//      - a child attaches to that row ONLY when the cut book records it (`row.parentLine.kind === "recorded"`, which
//        the server fills through lib/worktrees.js `recordedParentFor`); a reconstructed or unknown parent attaches
//        nowhere and the ∅ mark carries the reason;
//      - a container and its subtree are never held back by the chart's top N.
//   2. THE SERVER HALF, against a real repository and the real server.js: a project names a turnover branch that has
//      no worktree, two children were cut from it and recorded in the cut book, and the container's START press
//      (`POST /api/worktree/turnover-start`) puts a worktree on the branch - reusing one that already holds it, never
//      pushing and never landing - so the row can be reconciled like any other.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { boot, configureRepo, git, stopBootedPanels, waitForState } from "../tools/panel-testkit.mjs";
import { sliceBetween } from "../tools/panel-testkit.mjs";

// One file-level hook, registered once and never per test: boot()'s registry, swept after the last test.
after(stopBootedPanels);

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// ---- the page's own code, with stubs for the page ---------------------------------------------------------------
const page = read("public/render-projects.js");
const region = sliceBetween(page, "// ---- children under their parent", "// ---- reviewed chip");
const keyOf = (project, p) => `${project}::${p}`;
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const normPath = (p) => {
  const s = String(p || "").split(String.fromCharCode(92)).join("/");
  return s.endsWith("/") ? s.slice(0, -1) : s;
};
const state = { rows: new Map(), foldedParents: new Set(), projects: new Map() };
const pageFns = new Function(
  "state",
  "keyOf",
  "esc",
  "normPath",
  `${region}; return { childTreeOf, groupCtxOf, nestRowKeys, turnoverBranchNames, turnoverPlaceholderRow, applyTurnoverRows, dropTurnoverPlaceholder, chartParentKeyOf, parentGapOf, parentGapHtml, turnoverKeepsRow, turnoverKeptKeys, isTurnoverBranchRow, turnoverRowPath };`,
)(state, keyOf, esc, normPath);

const { childTreeOf, groupCtxOf, nestRowKeys, applyTurnoverRows, dropTurnoverPlaceholder, parentGapOf, parentGapHtml, turnoverKeepsRow, turnoverKeptKeys, turnoverRowPath } =
  pageFns;

const TURNOVER = "20261126_1800_TASK-406_the-complete-brief";
const ROOT = "/repo/demo";
const at = (tail) => `${ROOT}/.worktrees/${tail}`;

function project(extra = {}) {
  return { name: "demo", path: ROOT, mainBranch: "main", turnoverBranches: [{ branch: TURNOVER, key: "task 406" }], ...extra };
}

function reset(projects, rows) {
  state.projects = new Map(projects.map((p) => [p.name, p]));
  state.rows = new Map(rows.map((row) => [keyOf(row.project, row.path), row]));
  state.foldedParents = new Set();
}

// A recorded row's parent line is what the SERVER stamps (lib/parent-line.js), so the fixture writes it in that shape
// rather than inventing a parent field the page would read instead.
const recordedLine = (parent) => ({ kind: "recorded", parent, text: `cut from ${parent}`, title: `recorded in the cut book` });

test("every named turnover branch has a row: a branch with no worktree is a placeholder, and its recorded children hang under it", () => {
  const child1 = at("the-first-child-aaaa11");
  const child2 = at("the-second-child-bbbb22");
  const plain = at("plain-research-cccc33");
  reset(
    [project()],
    [
      { project: "demo", path: ROOT, branch: "main", parent: null },
      { project: "demo", path: child1, branch: "wtgui/the-first-child-aaaa11", parent: TURNOVER, parentSource: "cut", parentLine: recordedLine(TURNOVER), branchKind: "implementation" },
      { project: "demo", path: child2, branch: "wtgui/the-second-child-bbbb22", parent: TURNOVER, parentSource: "cut", parentLine: recordedLine(TURNOVER), branchKind: "research" },
      { project: "demo", path: plain, branch: "wtgui/plain-research-cccc33", parent: "main", parentSource: "cut", parentLine: { kind: "base", parent: "main", text: "cut from the project base main" }, branchKind: "research" },
    ],
  );

  // No worktree stands on the branch, so the chart makes a row for it.
  const added = applyTurnoverRows("demo");
  assert.equal(added.length, 1, "one turnover branch, one row");
  const container = added[0];
  assert.equal(container.branch, TURNOVER);
  assert.equal(container.placeholder, true, "it is the branch, not a worktree");
  assert.equal(container.path, turnoverRowPath(TURNOVER), "its key is the branch, under a prefix no directory can be");
  assert.equal(container.branchKind, "turnover");
  assert.equal(container.turnoverKey, "task 406", "the key the project filed the branch under travels with the row");

  const tree = childTreeOf("demo");
  const containerKey = keyOf("demo", container.path);
  assert.equal(tree.parentOf.get(containerKey), undefined, "the container hangs under nothing");
  assert.equal(tree.parentOf.get(keyOf("demo", child1)), containerKey, "the recorded implementation child hangs under it");
  assert.equal(tree.parentOf.get(keyOf("demo", child2)), containerKey, "and the recorded research child too");
  assert.equal(tree.parentOf.get(keyOf("demo", plain)), undefined, "a tree cut from main stays a sibling of the checkout");

  // The drawn order: the container gathers both children directly under it, whatever order the rank hands them over in.
  const order = nestRowKeys(tree.parentOf, [keyOf("demo", child2), keyOf("demo", child1), containerKey, keyOf("demo", ROOT), keyOf("demo", plain)]);
  assert.deepEqual(order, [containerKey, keyOf("demo", child2), keyOf("demo", child1), keyOf("demo", ROOT), keyOf("demo", plain)]);

  const ctx = groupCtxOf(tree, containerKey);
  assert.equal(ctx.depth, 0, "a container row is not one indent in");
  assert.equal(ctx.childCount, 2, "its fold covers both children");
  assert.equal(groupCtxOf(tree, keyOf("demo", child1)).depth, 1);
  assert.equal(groupCtxOf(tree, keyOf("demo", child2)).depth, 1);

  // Never held back by the chart's top N, and neither is anything under it; a plain row keeps the reader's count.
  assert.equal(turnoverKeepsRow(container), true, "the container is always drawn");
  assert.equal(turnoverKeepsRow(state.rows.get(keyOf("demo", child1))), true, "a recorded child of the container is drawn with it");
  assert.equal(turnoverKeepsRow(state.rows.get(keyOf("demo", plain))), false, "a row outside the container is ranked like any other");

  // Applying twice does not double the row, and a REAL row standing on the branch replaces it.
  applyTurnoverRows("demo");
  assert.equal([...state.rows.values()].filter((r) => r.placeholder).length, 1, "still one placeholder");
  const real = { project: "demo", path: at(TURNOVER), branch: TURNOVER, parent: "main", parentSource: "cut", branchKind: "turnover", turnoverContainer: TURNOVER };
  state.rows.set(keyOf("demo", real.path), real);
  assert.equal(dropTurnoverPlaceholder("demo", TURNOVER), true, "the arriving worktree removes the placeholder");
  assert.equal(state.rows.get(keyOf("demo", container.path)), undefined);
  assert.equal(applyTurnoverRows("demo").length, 0, "and the branch is no longer synthesized");
  assert.equal(childTreeOf("demo").parentOf.get(keyOf("demo", child1)), keyOf("demo", real.path), "the children hang under the real container now");
});

test("a recorded parent that has no row still draws a mark, and a branch the project stops naming loses its row", () => {
  const orphan = at("orphan-111111");
  reset(
    [project()],
    [{ project: "demo", path: orphan, branch: "wtgui/orphan-111111", parent: "wtgui/gone-999999", parentSource: "cut", parentLine: recordedLine("wtgui/gone-999999") }],
  );
  applyTurnoverRows("demo");
  const gap = parentGapOf(state.rows.get(keyOf("demo", orphan)));
  assert.ok(gap, "the row attaches nowhere and says so");
  assert.match(gap.why, /attaches nowhere - cut from wtgui\/gone-999999, which has no row on this chart/);
  const html = parentGapHtml(state.rows.get(keyOf("demo", orphan)));
  assert.match(html, /class="parent-gap"/);
  assert.match(html, /\u2205/, "the mark is the ∅");
  assert.match(html, /aria-label="attaches nowhere/);

  // A project whose turnover list no longer names the branch drops the placeholder instead of leaving a stale row.
  reset([project({ turnoverBranches: [] }), ], [{ project: "demo", path: ROOT, branch: "main", parent: null }]);
  applyTurnoverRows("demo");
  assert.equal([...state.rows.values()].filter((r) => r.placeholder).length, 0, "nothing is synthesized for a project with no branches");
});

test("a reconstructed or unknown parent attaches NOWHERE and says why; a watched cut with no line still attaches", () => {
  const guessed = at("guessed-222222");
  const unknown = at("unknown-333333");
  const watched = at("watched-444444");
  const backfilled = at("backfilled-555555");
  reset(
    [project()],
    [
      { project: "demo", path: ROOT, branch: "main", parent: null },
      { project: "demo", path: at(TURNOVER), branch: TURNOVER, parent: "main", parentSource: "cut", branchKind: "turnover" },
      { project: "demo", path: guessed, branch: "wtgui/guessed-222222", parent: TURNOVER, parentSource: "backfilled", parentLine: { kind: "reconstructed", parent: TURNOVER, text: `cut from ${TURNOVER} - reconstructed from its reflog, not recorded` } },
      { project: "demo", path: unknown, branch: "wtgui/unknown-333333", parentSource: "unknown", parentLine: { kind: "unknown", parent: null, text: "unknown - no cut record and its reflog names no local branch" } },
      { project: "demo", path: watched, branch: "wtgui/watched-444444", parent: TURNOVER, parentSource: "cut" },
      { project: "demo", path: backfilled, branch: "wtgui/backfilled-555555", parent: TURNOVER, parentSource: "backfilled" },
    ],
  );
  const tree = childTreeOf("demo");
  const containerKey = keyOf("demo", at(TURNOVER));
  assert.equal(tree.parentOf.get(keyOf("demo", guessed)), undefined, "a reconstructed parent is not a record: no edge");
  assert.equal(tree.parentOf.get(keyOf("demo", unknown)), undefined, "an unknown parent is no edge either");
  assert.equal(tree.parentOf.get(keyOf("demo", watched)), containerKey, "a watched cut with no parent line still attaches (an older snapshot)");
  assert.equal(tree.parentOf.get(keyOf("demo", backfilled)), undefined, "a backfilled guess never attaches, even with no parent line");

  const guessGap = parentGapOf(state.rows.get(keyOf("demo", guessed)));
  assert.match(guessGap.why, /reconstructed, not recorded/);
  assert.match(parentGapHtml(state.rows.get(keyOf("demo", guessed))), /reconstruction is not a record/);
  const unknownGap = parentGapOf(state.rows.get(keyOf("demo", unknown)));
  assert.match(unknownGap.why, /the cut book cannot name its parent/);
  const backfilledGap = parentGapOf(state.rows.get(keyOf("demo", backfilled)));
  assert.match(backfilledGap.why, /was reconstructed, not recorded/);
  assert.equal(parentGapOf(state.rows.get(keyOf("demo", watched))), null, "an attached row carries no ∅");
  assert.equal(parentGapOf(state.rows.get(keyOf("demo", at(TURNOVER)))), null, "and neither does the container");
});

// ---- the chart's split: a container does not spend one of the reader's N -----------------------------------------
const charts = read("public/charts.js");
const splitCode = sliceBetween(charts, "const CHART_TOP_DEFAULT = 10;", "// How many of a project's rows are below");
const chartState = { settings: { chartTopCount: 2 }, showOldProjects: new Set(), rows: new Map() };
const { chartTopSplit } = new Function(
  "state",
  "keyOf",
  "rowActivityAt",
  "turnoverKeptKeys",
  "esc",
  `${splitCode}; return { chartTopSplit };`,
)(chartState, keyOf, (r) => Number(r.activityAt || 0), (project) => turnoverKeptKeys(project), esc);

test("a turnover container and its children are on the chart whatever the top N says, and do not spend its slots", () => {
  const rows = [
    { project: "demo", path: ROOT, branch: "main", name: "main", activityAt: 1 },
    { project: "demo", path: at(TURNOVER), branch: TURNOVER, name: TURNOVER, activityAt: 2, branchKind: "turnover" },
    { project: "demo", path: at("one-aaaa11"), branch: "wtgui/one-aaaa11", name: "one", activityAt: 99, parentLine: recordedLine(TURNOVER) },
    { project: "demo", path: at("two-bbbb22"), branch: "wtgui/two-bbbb22", name: "two", activityAt: 98, parentLine: recordedLine(TURNOVER) },
    { project: "demo", path: at("busy-cccc33"), branch: "wtgui/busy-cccc33", name: "busy", activityAt: 97 },
    { project: "demo", path: at("later-dddd44"), branch: "wtgui/later-dddd44", name: "later", activityAt: 3 },
  ];
  reset([project()], rows);
  // The split asks the page's own answer, which is what the real page does (`typeof turnoverKeepsRow === "function"`).
  const split = chartTopSplit([...state.rows.values()]);
  const shown = split.top.map((r) => r.name);
  assert.ok(shown.includes(TURNOVER), "the container is drawn even though it is not in the top two by activity");
  assert.ok(shown.includes("one") && shown.includes("two"), "and so are its children");
  assert.ok(shown.includes("busy"), "the slots still go to the busiest rows OUTSIDE the container");
  assert.deepEqual(split.held.map((r) => r.name), ["main"], "only the checkout is held back: the container spent no slot");
});

// ---- the server half: a real repository, the real route -----------------------------------------------------------
const childTag = (branch) => branch.match(/-([0-9a-f]{6})$/)?.[1] || "";

function fixture(t) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "wag-turnover-rows-"));
  const repo = path.join(sandbox, "repos", "turnover-demo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "seed.txt"), "the container's base\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seed the repository");
  configureRepo(repo);
  // THE CONTAINER IS A BRANCH AND NOTHING ELSE: no worktree stands on it, which is the shape the chart has to draw.
  git(repo, "branch", TURNOVER, "main");
  // Two children cut from it, each on its own worktree, recorded in the cut book the panel reads.
  const children = {};
  for (const [name, tag] of [["the-first-child", "aaaa11"], ["the-second-child", "bbbb22"]]) {
    const branch = `wtgui/${name}-${tag}`;
    const tree = path.join(repo, ".worktrees", `${name}-${tag}`);
    git(repo, "worktree", "add", "-q", "-b", branch, tree, TURNOVER);
    children[name] = { branch, tree, tag };
  }
  // An unrecorded tree, cut from the container, whose parent only its reflog remembers: the chart must NOT hang it
  // under the container, and its ∅ mark is the proof.
  const orphanBranch = "wtgui/orphan-child-cccc33";
  const orphanTree = path.join(repo, ".worktrees", "orphan-child-cccc33");
  git(repo, "worktree", "add", "-q", "-b", orphanBranch, orphanTree, TURNOVER);

  const bookFile = path.join(sandbox, "branch-parents.json");
  const at = new Date().toISOString();
  const book = {};
  for (const rec of Object.values(children)) {
    book[`tag:${rec.tag}`] = { parent: TURNOVER, branch: rec.branch, tree: rec.tree.replace(/\\/g, "/"), kind: "research", at };
  }
  writeFileSync(bookFile, `${JSON.stringify(book, null, 2)}\n`, "utf8");
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return { sandbox, repo, bookFile, children, orphanBranch, orphanTree };
}

test("the container's start puts a worktree on a turnover branch that has none, reuses it, and refuses a branch the project does not name", async (t) => {
  const fx = fixture(t);
  const panel = await boot({
    config: {
      scanRoots: [path.dirname(fx.repo).replace(/\\/g, "/")],
      projects: [
        {
          name: "turnover-demo",
          path: fx.repo.replace(/\\/g, "/"),
          mainBranch: "main",
          turnoverBranches: [{ branch: TURNOVER, key: "task 406" }],
          turnoverPolicy: "free",
        },
      ],
      branchParentsFile: fx.bookFile,
      assistant: { enabled: false },
      worktreeSeconds: 60,
      midSeconds: 60,
      dormantSeconds: 60,
      slowSeconds: 60,
    },
  });
  const post = async (body) => {
    const r = await fetch(`${panel.base}/api/worktree/turnover-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  try {
    // THE BOARD BEFORE THE PRESS: no worktree stands on the container, and the two recorded children carry the cut
    // book's parent line, which is what the chart attaches on. Rows are matched by PATH here: a fast-pass row has no
    // `branch` yet (the full read brings it), but the parent line is stamped on every frame.
    const before = await waitForState(panel.base, (s) => {
      const p = (s.projects || []).find((x) => x.name === "turnover-demo");
      return p && (p.worktrees || []).length >= 3 ? p : null;
    }, "the project's trees are scanned");
    const projectBefore = (before.projects || []).find((x) => x.name === "turnover-demo");
    const rowAt = (p, tail) => (p.worktrees || []).find((r) => String(r.path || "").replace(/\\/g, "/").toLowerCase().endsWith(`/${tail}`));
    assert.equal(git(fx.repo, "worktree", "list", "--porcelain").includes(`branch refs/heads/${TURNOVER}`), false, "nothing stands on the container yet");
    const first = rowAt(projectBefore, "the-first-child-aaaa11");
    assert.equal(first.parentLine.kind, "recorded", "the cut book records the child");
    assert.equal(first.parentLine.parent, TURNOVER, "and names the container as its parent");
    const orphan = rowAt(projectBefore, "orphan-child-cccc33");
    assert.notEqual(orphan.parentLine.kind, "recorded", "an unrecorded cut is never drawn as a record");
    assert.notEqual(orphan.parentLine.parent, TURNOVER, "and its reflog-named parent must not be handed on as a record");

    // THE PRESS: a worktree on the branch, recorded as the container.
    const started = await post({ project: "turnover-demo", branch: TURNOVER, key: "task 406" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.equal(started.json.ok, true);
    assert.equal(started.json.branch, TURNOVER);
    assert.equal(started.json.pushed, false, "the start never pushes");
    assert.equal(started.json.landed, false, "and never lands");
    assert.equal(started.json.pr, null, "and opens no pull request");
    assert.equal(existsSync(started.json.path), true, "the worktree exists");
    const blocks = () => git(fx.repo, "worktree", "list", "--porcelain").split(/\r?\n\r?\n/);
    const onContainer = (list) =>
      list.filter((b) => b.split(/\r?\n/).includes(`branch refs/heads/${TURNOVER}`));
    const containerBlocks = onContainer(blocks());
    assert.equal(containerBlocks.length, 1, "git holds exactly one worktree on the container branch");
    const listed = containerBlocks[0].split(/\r?\n/).find((l) => l.startsWith("worktree ")).slice(9).replace(/\\/g, "/").toLowerCase();
    assert.equal(listed, started.json.path.replace(/\\/g, "/").toLowerCase(), "and it is the tree the route answered with");

    // The row the board now holds: a real turnover container, stamped as one, with a cut-book parent line.
    const after = await waitForState(panel.base, (s) => {
      const p = (s.projects || []).find((x) => x.name === "turnover-demo");
      const row = p && (p.worktrees || []).find((r) => String(r.path || "").replace(/\\/g, "/").toLowerCase() === started.json.path.replace(/\\/g, "/").toLowerCase());
      return row && row.branchKind ? p : null;
    }, "the container's row arrives");
    const projectAfter = (after.projects || []).find((x) => x.name === "turnover-demo");
    const container = projectAfter.worktrees.find((r) => String(r.path || "").replace(/\\/g, "/").toLowerCase() === started.json.path.replace(/\\/g, "/").toLowerCase());
    assert.equal(container.branchKind, "turnover", "the server stamps the branch it is");
    assert.equal(container.turnoverContainer, TURNOVER, "and says which container it is");
    assert.equal(container.parentLine.kind, "turnover", "a container has nothing above it");

    // A SECOND PRESS REUSES the tree: one container, never two.
    const again = await post({ project: "turnover-demo", branch: TURNOVER });
    assert.equal(again.status, 200);
    assert.equal(again.json.reused, true, "the worktree already on the branch IS the container");
    assert.equal(again.json.path, started.json.path, "the same path, not a second one");
    assert.equal(onContainer(blocks()).length, 1, "git still holds exactly one worktree on the branch");

    // THE REFUSALS, stated rather than silent: a branch the project does not name, an unknown project, a missing name.
    const refused = await post({ project: "turnover-demo", branch: "wtgui/not-a-container-111111" });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /not a turnover branch turnover-demo names/);
    assert.equal((await post({ project: "nope", branch: TURNOVER })).status, 404);
    assert.equal((await post({ project: "turnover-demo", branch: "" })).status, 400);
  } finally {
    await panel.stop();
  }
});
