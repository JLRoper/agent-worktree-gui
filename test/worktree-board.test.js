// What the board is allowed to draw as a project worktree, and what a tree with no tag may never be.
//
// Two defects, one shape. `git worktree list` answers for the REPOSITORY, so a tree cut from this repo anywhere on
// disk is in its answer: a lander made nine comparison trees under `%LOCALAPPDATA%/hermes/cache/scratch/land-check/`
// and the board drew all nine as this project's worktrees — basenames with no tag, detached HEADs, and four of them
// duplicating the `land/*` branches — because nothing asked where a listed path actually lives. Separately, the
// rename path handed a directory with no `-<hex6>` tag a randomly invented one, which is a fresh identity for a tree
// whose ledger record had been keyed on the path the rename then moved.
//
// WHAT IS DRIVEN: a real `Scheduler.discover` over a real `Store`, with the git listing injected (the one seam that
// needs a repository, and this file supplies the listing instead). The assertions are about what the board holds —
// the rows, the project summary the title line's chips read, and the payload /api/state serves — plus the guard both
// rename call sites consult. Nothing here touches a real repo, a port or a browser.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isInsideProject, projectWorktrees } from "../lib/project.js";
import { Scheduler } from "../lib/scheduler.js";
import { Store } from "../lib/store.js";
import { renameRefusal } from "../lib/tree-names.js";

const ROOT = "C:/ProjectDevelopment/agent-worktree-gui";
const SCRATCH = "C:/Users/roper/AppData/Local/hermes/cache/scratch/land-check";
const PROJECT = { name: "agent-worktree-gui", path: ROOT, mainBranch: "main", remote: "github", prRepo: "JLRoper/agent-worktree-gui" };

// The listing the land-check trees produced, plus the trees this project really owns. A detached worktree has no
// `branch` line in `git worktree list --porcelain`, which is why those entries carry none.
const LISTING = [
  { path: ROOT, branch: "main" },
  { path: `${ROOT}/.worktrees/fix-the-thing-1a2b3c`, branch: "wtgui/fix-the-thing-1a2b3c" },
  { path: `${ROOT}/.worktrees/bare-name`, branch: "wtgui/bare-name" },
  { path: `${ROOT}/bug/nested-checkout`, branch: "wtgui/nested-checkout-2b3c4d" },
  { path: `${SCRATCH}/folds` },
  { path: `${SCRATCH}/main` },
  { path: `${SCRATCH}/w-picker2`, branch: "land/pr-model-picker" },
  { path: `${SCRATCH}/w-spawn`, branch: "land/spawn-cards-visible" },
];
const OWNED = [
  ROOT,
  `${ROOT}/.worktrees/fix-the-thing-1a2b3c`,
  `${ROOT}/.worktrees/bare-name`,
  `${ROOT}/bug/nested-checkout`,
];
const OUTSIDE = [`${SCRATCH}/folds`, `${SCRATCH}/main`, `${SCRATCH}/w-picker2`, `${SCRATCH}/w-spawn`];

function harness(listing = LISTING) {
  const store = new Store();
  store.ensureProject(PROJECT);
  const scheduler = new Scheduler({
    config: { projects: [PROJECT] },
    store,
    pool: { inFlight: 0, isBusy: () => false },
    getProjects: () => [PROJECT],
    listWorktrees: async () => listing,
  });
  return { store, scheduler };
}

const pathsOf = (rows) => rows.map((r) => r.path).sort();

test("a listing splits into the trees this project owns and the ones git only mentions", () => {
  const { kept, outside } = projectWorktrees(ROOT, LISTING);
  assert.deepEqual(pathsOf(kept), [...OWNED].sort());
  assert.deepEqual(pathsOf(outside), [...OUTSIDE].sort());
});

test("membership is the folder, not the repository — and a sibling prefix is not a subdirectory", () => {
  assert.equal(isInsideProject(ROOT, ROOT), true, "the project's own checkout is a row (it carries ON MAIN)");
  assert.equal(isInsideProject(ROOT, `${ROOT}/.worktrees/x-1a2b3c`), true);
  assert.equal(isInsideProject(ROOT, `${ROOT}-old`), false, "agent-worktree-gui-old is another project");
  assert.equal(isInsideProject(ROOT, `${SCRATCH}/main`), false);
  // The page, the registry and a scan spell the same directory differently; the test is spelling-blind for the same
  // reason every path comparison in the panel is.
  assert.equal(isInsideProject("C:\\ProjectDevelopment\\agent-worktree-gui", "c:/projectdevelopment/AGENT-WORKTREE-GUI/.worktrees/x-1a2b3c"), true);
  assert.equal(isInsideProject(ROOT, ""), false);
});

test("out-of-project, detached and untagged trees never become rows or move the header counts", async () => {
  const { store, scheduler } = harness();
  await scheduler.reconcile(PROJECT);

  const rows = store.rowsFor(PROJECT.name);
  assert.deepEqual(pathsOf(rows), [...OWNED].sort(), "only the project's own trees are boarded");
  for (const path of OUTSIDE) {
    assert.equal(rows.some((r) => r.path === path), false, `${path} must not be a row`);
  }
  // The untagged in-project tree IS shown — hiding a tree that really is this project's would be the worse failure.
  const untagged = rows.find((r) => r.path === `${ROOT}/.worktrees/bare-name`);
  assert.ok(untagged, "an in-project tree with no tag is still a row");
  assert.equal(untagged.name, "bare-name");

  // The header chips the title line draws (chipsHtml) count these rows, so the count is the proof that four scratch
  // trees did not inflate it. /api/state serves the same summary and the same row list.
  const summary = store.summaryFor(PROJECT.name);
  assert.equal(summary.total, OWNED.length, `header total is the project's own ${OWNED.length} trees, not ${LISTING.length}`);
  assert.equal(summary.unmerged, OWNED.length, "nothing boarded yet has a verdict, and nothing outside is counted");
  const state = store.snapshot();
  assert.equal(state.projects.length, 1);
  assert.deepEqual(pathsOf(state.projects[0].worktrees), [...OWNED].sort());
  assert.equal(state.projects[0].summary.total, OWNED.length);
  // Excluded, not hidden silently: the count of unboarded trees rides on the project record.
  assert.equal(store.projects.get(PROJECT.name).outsideTrees, OUTSIDE.length);
});

test("the UNMERGED arithmetic has no outside tree in it", async () => {
  const { store, scheduler } = harness();
  await scheduler.reconcile(PROJECT);
  // A real full scan's verdict for one owned tree; the rest keep the "…" discovery puts on a fresh row.
  const row = store.rowsFor(PROJECT.name).find((r) => r.name === "fix-the-thing-1a2b3c");
  store.putRow(PROJECT.name, { ...row, verdict: "MERGED (2 commits)", ahead: 0, behind: 0, dirty: 0, untracked: 0 }, "full");

  const summary = store.summaryFor(PROJECT.name);
  assert.equal(summary.total, 4);
  assert.equal(summary.merged, 1);
  assert.equal(summary.unmerged, 3, "3 owned trees, not 3 + the 4 scratch trees the repository lists");
  assert.equal(summary.removable, 1, "safe to remove counts only owned rows");
});

test("a tree an earlier build already boarded outside the project is dropped on the first pass", async () => {
  const { store, scheduler } = harness();
  // The shape the live board was left in: the scratch trees are rows, with verdicts, before this fix runs.
  store.putRow(PROJECT.name, { path: `${SCRATCH}/main`, name: "main", branch: "HEAD", verdict: "UNMERGED (2 commits)" }, "full", { force: true });
  store.putRow(PROJECT.name, { path: `${SCRATCH}/w-spawn`, name: "w-spawn", branch: "land/spawn-cards-visible", verdict: "UNMERGED (4 commits)" }, "full", { force: true });
  assert.equal(store.summaryFor(PROJECT.name).total, 2);

  await scheduler.reconcile(PROJECT);

  const paths = pathsOf(store.rowsFor(PROJECT.name));
  assert.equal(paths.includes(`${SCRATCH}/main`), false, "one discovery pass is enough — the two-pass grace is for a hiccup about an owned tree");
  assert.equal(paths.includes(`${SCRATCH}/w-spawn`), false);
  assert.deepEqual(paths, [...OWNED].sort());
  assert.equal(store.summaryFor(PROJECT.name).total, 4);
});

test("adopting a tree a job names obeys the same membership rule", async () => {
  const { store, scheduler } = harness();
  const adopted = await scheduler.adoptWorktree(PROJECT.name, `${SCRATCH}/w-picker2`);
  assert.equal(adopted, false, "a spawn or a replayed job cannot board a tree outside the project either");
  assert.equal(store.rowsFor(PROJECT.name).length, 0);
});

test("an untagged directory is refused by the naming path, and an in-project untagged tree is never renamed", async () => {
  const untagged = `${ROOT}/.worktrees/bare-name`;
  // A bare name has no tag to key the ledger on, which is the whole refusal.
  const why = renameRefusal(untagged);
  assert.match(why, /-<hex6> tag/, "the refusal names the missing tag");
  assert.match(why, /bare-name/, "and the tree it is about");
  assert.equal(renameRefusal(`${ROOT}/.worktrees/fix-the-thing-1a2b3c`), "", "a tagged tree may be renamed");
  assert.equal(renameRefusal(`${ROOT}/.worktrees/a1b2c3`), "", "a directory that IS six hex is the tag being named");

  // The guard is worthless if the call sites do not ask it: both rename halves and the suggest-name route do, and the
  // invented-tag fallback that used to give a bare name a fresh identity is gone.
  const src = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(src, /renameRefusal\(oldPath\)/, "renameWorktree (deliberate and automatic) asks before moving anything");
  // The automatic half is the naming sweep (lib/worktree-naming.js), and its only way to move a tree is renameWorktree:
  // so the refusal above is what spares an untagged tree — there is no second, unchecked auto-rename path.
  assert.match(src, /rename: \(args\) => renameWorktree\(args\)/, "the automatic sweep moves trees only through renameWorktree");
  assert.doesNotMatch(src, /autoNameWorktree/, "no second automatic rename path that could skip the refusal");
  assert.match(src, /renameRefusal\(dir\)/, "suggest-name refuses rather than offering a name the rename would reject");
  assert.doesNotMatch(src, /WORKTREE_TAG_RE/, "no tag is minted from a bare name any more");
});
