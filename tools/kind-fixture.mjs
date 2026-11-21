// tools/kind-fixture.mjs - the git fixture the Kind column's gate and its capture share.
//
// WHY A MODULE. Two harnesses need the same five rows: tools/verify-branch-kind.mjs asserts what the page draws, and
// tools/capture-kind-column.mjs photographs the same rows so the "before" pair (the base commit's page) and the
// "after" pair (this branch's page) differ in ONE thing - the tree being served - and never in the fixture under it.
// A second copy of these git commands is how a comparison starts proving the difference between two fixtures.
//
// THE ROWS
//   the project's own checkout      the primary tree, which the chart draws as a row of its own
//   the turnover branch's tree      stands ON the turnover branch, with no record: no kind is drawn for it
//   the research tree               cut from main, local only: R, and an unlifted record its press can lift
//   the turnover child              cut from the turnover branch: T, a statement with no control
//   the landed tree                 cut from main, its work merged into main: the verdict reads MERGED, and it carries
//                                   a research record on purpose - the pair that clipped the badge's words in the
//                                   regression this fixture exists to photograph (an R ahead of MERGED)
//
// The book is ~/.wag/state/branch-parents.json in a real run; here it is a file the harness names in the panel's
// config (`branchParentsFile`). Keys are the panel's own: `tag:<six hex>` (lib/jobs.js `treeParentKey`), which the
// directory names carry, so a branch renamed later still finds its record.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, slash } from "./panel-testkit.mjs";

export const TURNOVER_BRANCH = "20261112_0900_DMR-44001_the_turnover";

export const KIND_TREES = {
  research: { dir: "research-probe-aaaa11", branch: "wtgui/research-probe-aaaa11", tag: "aaaa11" },
  child: { dir: "turnover-child-bbbb22", branch: "wtgui/turnover-child-bbbb22", tag: "bbbb22" },
  landed: { dir: "landed-tree-cccc33", branch: "wtgui/landed-tree-cccc33", tag: "cccc33" },
};

// Build the repo and its four worktrees under `dir` (the panel sandbox), write the book, and hand back what a harness
// needs to name each row: the absolute paths, the suffixes the chart's row keys end with, and the book file.
export function buildKindFixture(dir) {
  const repo = path.join(dir, "repos", "kind-repo");
  const trees = {};
  for (const [name, spec] of Object.entries(KIND_TREES)) trees[name] = path.join(repo, ".worktrees", spec.dir);
  const parent = path.join(repo, ".worktrees", TURNOVER_BRANCH);
  for (const d of [repo, path.join(repo, ".worktrees")]) mkdirSync(d, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# kind sandbox\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed the sandbox repo"]);
  // The turnover branch the parent row stands on (no record: it was cut before the kind rule, which is the normal
  // absence, and no mark is drawn for it).
  git(repo, ["worktree", "add", "-q", "-b", TURNOVER_BRANCH, parent]);
  // A research tree cut from main: local only, its push refused until lifted.
  git(repo, ["worktree", "add", "-q", "-b", KIND_TREES.research.branch, trees.research, "main"]);
  // A turnover child cut from the turnover branch: it has a destination on the remote.
  git(repo, ["worktree", "add", "-q", "-b", KIND_TREES.child.branch, trees.child, TURNOVER_BRANCH]);
  // A landed tree: it commits its work on its own branch, and main merges that branch, so the row's own read finds
  // nothing ahead of main and a `commit:` line in its reflog - the MERGED verdict (lib/scan.js), not NO COMMITS.
  git(repo, ["worktree", "add", "-q", "-b", KIND_TREES.landed.branch, trees.landed, "main"]);
  writeFileSync(path.join(trees.landed, "landed.txt"), "the work this tree landed\n", "utf8");
  git(trees.landed, ["add", "-A"]);
  git(trees.landed, ["commit", "-q", "-m", "the landed tree's work"]);
  git(repo, ["merge", "-q", "--no-ff", "-m", "land the landed tree", KIND_TREES.landed.branch]);

  const bookFile = path.join(dir, "branch-parents.json");
  const at = new Date().toISOString();
  writeBook(bookFile, { trees, at });
  return {
    repo,
    bookFile,
    parent,
    trees,
    at,
    // The suffixes the rows are found by, in the order the report names them.
    suffixes: {
      research: KIND_TREES.research.dir,
      child: KIND_TREES.child.dir,
      landed: KIND_TREES.landed.dir,
      parent: TURNOVER_BRANCH,
    },
  };
}

// The book the panel boots with. A research record for the landed tree as well, on purpose: that row's badge reads
// MERGED, and the mark ahead of it is exactly the pair the regression clipped. `lifted` is the one field a lift
// writes, and it is absent unless true (lib/jobs.js `rememberParent`), which is the state a turnover child keeps.
export function writeBook(bookFile, { trees = null, at = new Date().toISOString(), lifted = false } = {}) {
  const row = (kind, parent, branch, tree) => ({ parent, branch, tree: slash(tree || ""), kind, ...(kind === "research" && lifted ? { lifted: true } : {}), at });
  const book = {
    [`tag:${KIND_TREES.research.tag}`]: row("research", "main", KIND_TREES.research.branch, trees?.research),
    [`tag:${KIND_TREES.child.tag}`]: row("turnover", TURNOVER_BRANCH, KIND_TREES.child.branch, trees?.child),
    [`tag:${KIND_TREES.landed.tag}`]: row("research", "main", KIND_TREES.landed.branch, trees?.landed),
  };
  writeFileSync(bookFile, `${JSON.stringify(book, null, 2)}\n`, "utf8");
  return book;
}
