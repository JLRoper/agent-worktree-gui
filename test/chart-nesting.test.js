// The worktree chart nests a round's stage trees under the round's parent.
//
// A stage tree is cut with `git worktree add -b <branch> <path> <sha>`: the ref is a COMMIT (the round's frozen
// parent), so git records no branch the tree came from and the chart would otherwise draw one stage tree per row,
// unrelated to each other and to the checkout they were cut from.
//
// Two halves are proved here, together, because a picture that groups rows nobody recorded is as wrong as a record
// nothing draws:
//
//   1. THE SERVER half: a cut made the way the assistant makes a stage cut (pinned to a sha, `parent` named) writes
//      the round's parent into the book the scan reads (`ParentBook.rowsFor`) - the branch, `parentSource: "cut"`, and
//      the frozen commit as `parentSha`;
//   2. THE PAGE half: fed those very rows, the chart's own grouping (`childTreeOf`, `groupCtxOf`, `nestRowKeys` in
//      public/render-projects.js) hangs both stage trees one indent under the parent's row, in one group, in drawing
//      order - so a two-stage round reads as one parent with its two stage trees under it, not three unrelated rows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const EMAIL = ["chart", "example.invalid"].join(String.fromCharCode(64));

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-chart-nest-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Chart Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "the round's parent"], { encoding: "utf8" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, git };
}

// The page's own grouping region, run with a stub `state` and a stub `keyOf`: the same functions the browser calls,
// with no board under them. The region carries DOM painters too; they are declared here and never called.
const page = readFileSync(new URL("../public/render-projects.js", import.meta.url), "utf8");
const region = sliceRegion(page, "children under their parent");
const keyOf = (project, p) => `${project}::${p}`;
const state = { rows: new Map(), foldedParents: new Set() };
const { childTreeOf, groupCtxOf, nestRowKeys } = new Function("state", "keyOf", "esc", `${region}; return { childTreeOf, groupCtxOf, nestRowKeys };`)(
  state,
  keyOf,
  (s) => String(s ?? ""),
);

test("a two-stage round's trees are recorded as children of the round's parent, and the chart nests them", async (t) => {
  const r = repo(t);
  const roundSha = r.git("rev-parse", "main");
  const jobs = new Jobs({
    config: { apiServer: { url: "http://127.0.0.1:1" }, jobsFile: path.join(r.dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 60 },
    onEvent: () => {},
    onLog: () => {},
  });
  const parents = new ParentBook({ file: path.join(r.dir, "logs", "parents.json"), onLog: () => {} });
  jobs.parents = parents;

  // A round's two stage trees: the first cut RESOLVES the round (`round: true` is what the assistant passes when it
  // has no round yet — its parent is the checkout's branch), the second is pinned to the round's commit and carries
  // the same parent.
  const first = await jobs.makeWorktree(r.dir, "write the draft", { project: "demo", round: true });
  const second = await jobs.makeWorktree(r.dir, "critique the draft", { project: "demo", from: roundSha, parent: "main" });
  assert.equal(first.startRef, "main");
  assert.equal(second.startRef, roundSha, "the second cut is pinned to the commit");

  // 1. THE SERVER HALF: what the scan reads for this project. The checkout itself is a row of the board (branch
  //    `main`), which is what the stage trees hang under.
  const rows = parents.rowsFor("demo");
  const rowOf = (branch) => rows.find((row) => row.branch === branch) || null;
  for (const cut of [first, second]) {
    const rec = rowOf(cut.branch);
    assert.ok(rec, `${cut.branch} is in the book the scan reads`);
    assert.equal(rec.parent, "main", "the round's parent is the branch the chart nests under");
    assert.equal(rec.parentSource, "cut", "a record, not a guess");
    assert.equal(rec.parentSha, roundSha, "and it names the commit the round froze");
  }

  // 2. THE PAGE HALF: the rows the chart would hold, from those records plus the checkout's own row.
  const mainPath = r.dir.replace(/\\/g, "/");
  const chartRows = [
    { project: "demo", path: mainPath, branch: "main", parent: null },
    ...rows.map((rec) => ({ project: "demo", path: rec.path, branch: rec.branch, parent: rec.parent, parentSource: rec.parentSource })),
  ];
  state.rows = new Map(chartRows.map((row) => [keyOf(row.project, row.path), row]));
  state.foldedParents = new Set();

  const tree = childTreeOf("demo");
  const mainKey = keyOf("demo", mainPath);
  const firstKey = keyOf("demo", first.path);
  const secondKey = keyOf("demo", second.path);
  assert.equal(tree.parentOf.get(mainKey), undefined, "the parent itself is a top-level row");
  assert.equal(tree.parentOf.get(firstKey), mainKey, "the first stage tree hangs under it");
  assert.equal(tree.parentOf.get(secondKey), mainKey, "and so does the second");
  assert.deepEqual(tree.childrenOf.get(mainKey), [firstKey, secondKey], "ONE group: the round's stage trees together");

  // The drawing order: a child is drawn directly under its parent even when the input order put it first.
  const order = nestRowKeys(tree.parentOf, [secondKey, firstKey, mainKey]);
  assert.equal(order[0], mainKey, "the round's parent is painted first");
  assert.deepEqual(new Set(order.slice(1, 3)), new Set([firstKey, secondKey]), "and both stage trees are painted immediately under it");
  assert.deepEqual(nestRowKeys(tree.parentOf, [mainKey, firstKey, secondKey]), [mainKey, firstKey, secondKey], "an order that already nests is kept");

  // One indent in, with the parent's own fold covering both.
  const firstCtx = groupCtxOf(tree, firstKey);
  assert.equal(firstCtx.parentKey, mainKey);
  assert.equal(firstCtx.depth, 1);
  assert.equal(firstCtx.childCount, 0, "a stage tree has no children of its own");
  assert.equal(groupCtxOf(tree, mainKey).childCount, 2, "the parent offers the fold that hides the whole round");

  // The reader's fold reaches the stage trees, and only them.
  state.foldedParents.add(mainKey);
  assert.equal(groupCtxOf(tree, firstKey).hidden, true, "folding the round hides the first stage tree");
  assert.equal(groupCtxOf(tree, secondKey).hidden, true, "and the second");
  assert.equal(groupCtxOf(tree, mainKey).hidden, false, "the parent stays on screen");
});
