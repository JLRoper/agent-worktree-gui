// Two cleanup defects, both measured on the reader's own board on 2026-11-02.
//
//   1. The assistant's leftover sweep raised "finished with uncommitted work — 2 modified · 4 untracked — branch main"
//      for trees that were not trees any more. The panel evicts a tree and leaves the empty directory behind; `git
//      status` run inside it does not fail, it walks UP to the primary checkout and answers with the reader's OWN
//      files. A husk is "tree gone (evicted, directory left behind)" and never a leftover.
//   2. The cleanup audit behind GET /api/cleanup inverted the truth: 18 EMPTY husk directories read "uncommitted
//      tracked changes (real work)" — protected — while task-46's LIVE tree read "clean and fully merged/pushed" —
//      deletable. Deleting that would have destroyed a working agent's tree.
//
// The fixtures are real git trees, and the CLI's own words are injected: `hermes worktree list` classifies every
// DIRECTORY under `.worktrees/`, so the broken verdict this test hands in is exactly the one the CLI really prints.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Assistant } from "../lib/assistant.js";
import { auditRepo, clearAuditCache } from "../lib/hermes-worktrees.js";
import { git } from "../tools/panel-testkit.mjs";

const root = mkdtempSync(path.join(tmpdir(), "wag-cleanup-"));
after(() => rmSync(root, { recursive: true, force: true }));
const p = (...s) => path.join(root, ...s).replace(/\\/g, "/");
const write = (dir, file, text) => writeFileSync(path.join(dir, file), text);

const repo = p("project");
const dirtyTree = p("project", ".worktrees", "dirty-tree");
const liveTree = p("project", ".worktrees", "live-tree");
const husk = p("project", ".worktrees", "console-redraw-guard-e1cea2");

mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
for (const f of ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt"]) write(repo, f, `${f}\n`);
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
git(repo, "worktree", "add", "-q", "-b", "wtgui/dirty-tree", dirtyTree);
git(repo, "worktree", "add", "-q", "-b", "wtgui/live-tree", liveTree);
mkdirSync(path.join(liveTree, "src"), { recursive: true });
// The husk: it WAS a worktree, git's registration is gone, and the empty folder is still on disk — the shape an
// eviction leaves and the shape rmdir refuses while something holds it.
git(repo, "worktree", "add", "-q", "-b", "wtgui/console-redraw-guard", husk);
git(repo, "worktree", "remove", "--force", husk);
mkdirSync(husk, { recursive: true });

// The reader's own checkout: 2 modified, 4 untracked. These are the numbers the false alert reported.
write(repo, "one.txt", "changed in the primary\n");
write(repo, "two.txt", "changed in the primary\n");
for (const f of ["config.json", "lib-jobs.js", "notes.md", "scratch.tmp"]) write(repo, f, "the reader's own file\n");
// The real tree's own work: 3 modified, 2 untracked — a different shape from the primary's, on purpose.
write(dirtyTree, "one.txt", "changed in the tree\n");
write(dirtyTree, "two.txt", "changed in the tree\n");
write(dirtyTree, "three.txt", "changed in the tree\n");
for (const f of ["tree-note.md", "tree-scratch.tmp"]) write(dirtyTree, f, "the tree's own work\n");

const treeRow = (over = {}) => ({
  age_days: 1.1,
  size_mb: 1,
  untracked: [],
  ...over,
});

// A stand-in for `hermes worktree list --json`. It answers the CLI's real, measured verdicts — including the wrong
// ones this fix has to correct — and `git worktree list --porcelain` from the real repository, because the audit's
// "is this registered" question must be answered by git, not by the fixture's opinion.
function fakeCli(trees) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args.includes("--porcelain")) return { stdout: git(repo, "worktree", "list", "--porcelain"), stderr: "" };
    return { stdout: JSON.stringify({ repo, trees, branches: [] }), stderr: "" };
  };
  return { run, calls };
}

const auditTrees = () => [
  // Exactly what the CLI printed for the husk: the PRIMARY checkout's branch, and its dirt read as real work.
  treeRow({ name: "console-redraw-guard-e1cea2", path: husk, branch: "main", verdict: "keep", reason: "uncommitted tracked changes (real work)" }),
  treeRow({ name: "dirty-tree", path: dirtyTree, branch: "wtgui/dirty-tree", verdict: "keep", reason: "uncommitted tracked changes (real work)" }),
  // …and exactly what it printed for the tree task-46 was working in.
  treeRow({ name: "live-tree", path: liveTree, branch: "wtgui/live-tree", verdict: "reap", reason: "clean and fully merged/pushed" }),
];

test("an empty husk is 'tree gone' and the DELETABLE case, never the primary checkout's real work", async () => {
  clearAuditCache();
  const { run } = fakeCli(auditTrees());
  const audit = await auditRepo(repo, { run, force: true });
  const row = audit.trees.find((t) => t.path === husk);
  assert.ok(row, "the husk is still listed (it is a directory under .worktrees/)");
  assert.equal(row.verdict, "reap", "the safe thing to delete is offered for deletion");
  assert.equal(row.reason, "tree gone (evicted, directory left behind)");
  assert.equal(row.gone, true);
  assert.equal(row.empty, true);
  assert.equal(row.deletable, true);
  assert.equal(row.branch, null, "the primary checkout's branch is not this row's branch");
  assert.deepEqual(row.untracked, [], "and the reader's untracked files are not this row's either");
});

test("an unregistered path never inherits the primary checkout's dirt — and files left in it are not deletable", async () => {
  clearAuditCache();
  const stray = p("project", ".worktrees", "stray-leftover");
  mkdirSync(stray, { recursive: true });
  write(stray, "notes.md", "somebody's file\n");
  const { run } = fakeCli([
    ...auditTrees(),
    treeRow({ name: "stray-leftover", path: stray, branch: "main", verdict: "keep", reason: "uncommitted tracked changes (real work)" }),
  ]);
  const audit = await auditRepo(repo, { run, force: true });

  const row = audit.trees.find((t) => t.path === stray);
  assert.equal(row.branch, null, "git answered for the checkout above it, so its branch is not copied onto this row");
  assert.equal(row.gone, true);
  assert.equal(row.deletable, false, "a directory that still holds a file is not offered for deletion");
  assert.match(row.reason, /no \.git/);
  assert.match(row.reason, /1 entry left behind/);

  // The guard does not over-reach: the real tree beside it keeps its own branch and its own verdict.
  const dirty = audit.trees.find((t) => t.path === dirtyTree);
  assert.equal(dirty.branch, "wtgui/dirty-tree");
  assert.equal(dirty.gone, false);
  assert.equal(dirty.deletable, false, "the CLI's 'real work' is still believed for a real tree");
});

test("a tree a live run is working in is never deletable and never 'clean and fully merged/pushed'", async () => {
  clearAuditCache();
  const { run } = fakeCli(auditTrees());
  // The run's cwd, and a subdirectory of the tree it was cut for: both mean the tree is held.
  for (const cwd of [liveTree, `${liveTree}/src`]) {
    const audit = await auditRepo(repo, { run, force: true, liveCwds: [cwd] });
    const row = audit.trees.find((t) => t.path === liveTree);
    assert.equal(row.verdict, "keep", `held by ${cwd}`);
    assert.equal(row.deletable, false);
    assert.equal(row.live, true);
    assert.match(row.reason, /live run is working in this tree/);
    assert.doesNotMatch(row.reason, /fully merged/);
  }
});

test("the live answer is applied on a CACHE HIT too — a run that started since the audit still holds its tree", async () => {
  clearAuditCache();
  const { run } = fakeCli(auditTrees());
  const cold = await auditRepo(repo, { run, force: true });
  assert.equal(cold.trees.find((t) => t.path === liveTree).deletable, true, "git alone says the clean tree is reapable");
  const warm = await auditRepo(repo, { run, liveCwds: [liveTree] });
  assert.equal(warm.at, cold.at, "the cached audit was reused (the CLI ran once)");
  assert.equal(warm.trees.find((t) => t.path === liveTree).deletable, false);
});

// ---- the assistant's leftover sweep, over the same paths -----------------------------------------------------------

const row = (treePath, dirty, untracked, branch) => ({
  path: treePath,
  name: path.basename(treePath),
  branch,
  verdict: "UNMERGED",
  released: null,
  dirty,
  untracked,
  dirtyFiles: Array.from({ length: dirty }, (_, i) => ({ path: `file-${i}.txt`, status: "M" })),
  untrackedFiles: Array.from({ length: untracked }, (_, i) => ({ path: `new-${i}.txt` })),
});

const finished = (treePath, id) => {
  const now = Date.now();
  return {
    id,
    thread: `wtgui-cleanup-fixture-${id}`,
    label: "worker",
    status: "done",
    startedAt: new Date(now - 6 * 60_000).toISOString(),
    endedAt: new Date(now - 60_000).toISOString(),
    worktreePath: treePath,
    cwd: treePath,
    projectPath: repo,
    lines: [],
    artifacts: [],
  };
};

const stateDir = p("state");
mkdirSync(stateDir, { recursive: true });
const makeAssistant = (rows, runInTree = () => null) =>
  new Assistant({
    config: { jobsFile: path.join(stateDir, "jobs.json"), assistantFile: path.join(stateDir, "assistant.json") },
    jobs: { list: () => [], firstOfThread: () => null, runInTree },
    getRows: () => rows,
    onLog: () => {},
  });
const leftovers = (assistant) => assistant.alerts.filter((a) => a.rule === "leftover");

test("an empty husk raises NO leftover, even with a stale row still carrying the primary checkout's 2 modified · 4 untracked", () => {
  const assistant = makeAssistant([row(husk, 2, 4, "main")]);
  assistant.evaluate([finished(husk, "husk")], Date.now());
  assert.deepEqual(leftovers(assistant), [], "a tree that is gone cannot have left work behind");
});

test("a real worktree's own dirt still raises the leftover, with its own counts", () => {
  const assistant = makeAssistant([row(dirtyTree, 3, 2, "wtgui/dirty-tree")]);
  assistant.evaluate([finished(dirtyTree, "dirty")], Date.now());
  const [alert] = leftovers(assistant);
  assert.ok(alert, "the guard must not silence a genuine leftover");
  assert.match(alert.title, /finished with uncommitted work/);
  assert.match(alert.detail, /3 modified · 2 untracked/);
  assert.match(alert.detail, /branch wtgui\/dirty-tree/);
});

test("a cwd held by a live job is never deletable in the audit and raises no leftover", async () => {
  const live = { id: "live-1", thread: "wtgui-live", status: "running", cwd: liveTree, worktreePath: liveTree };
  const assistant = makeAssistant([row(liveTree, 3, 2, "wtgui/live-tree")], (treePath) => (treePath === liveTree ? live : null));
  assistant.evaluate([finished(liveTree, "live")], Date.now());
  assert.deepEqual(leftovers(assistant), []);

  clearAuditCache();
  const { run } = fakeCli(auditTrees());
  const audit = await auditRepo(repo, { run, force: true, liveCwds: [live.cwd] });
  const rowOut = audit.trees.find((t) => t.path === liveTree);
  assert.equal(rowOut.deletable, false);
  assert.equal(rowOut.verdict, "keep");
});
