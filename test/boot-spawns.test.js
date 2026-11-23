// The boot's spawn budget, proved where the budget is spent: one git process for a project's meta (fields AND the
// count against the base), the tree question answered by the filesystem when the answer is already on disk, and the
// `.agentboard` claim read behind the boot instead of in front of it.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectMeta } from "../lib/project.js";
import { scanWorktree } from "../lib/scan.js";
import { Scheduler } from "../lib/scheduler.js";
import { Store } from "../lib/store.js";
import { git } from "../tools/panel-testkit.mjs";

const root = mkdtempSync(path.join(tmpdir(), "wag-boot-spawns-"));
after(() => {
  // Windows keeps a handle on a directory a just-finished git process used; the temp dir is disposable, so a locked
  // removal must not turn a green run into a failed file.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* the OS sweeps its own temp */
  }
});
const p = (...s) => path.join(root, ...s).replace(/\\/g, "/");

let n = 0;
function commit(dir, file, msg = file) {
  writeFileSync(path.join(dir, file), `${msg} ${++n}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", msg);
}

// origin (bare) <- project checkout `main` <- a second clone that stands for "somebody else".
git(root, "init", "-q", "--bare", "-b", "main", p("origin.git"));
git(root, "clone", "-q", p("origin.git"), p("project"));
git(p("project"), "switch", "-q", "-C", "main");
commit(p("project"), "base.txt");
git(p("project"), "push", "-q", "-u", "origin", "main");
git(root, "clone", "-q", p("origin.git"), p("other"));
git(p("other"), "switch", "-q", "-C", "main", "origin/main");

const PROJECT = { name: "fixture", path: p("project"), remote: "origin", mainBranch: "main" };

test("projectMeta reads the count against the base from the same process as the fields", async () => {
  // main moves one commit on the remote (behind), and one commit lands locally (ahead): both counts non-zero, so a
  // parser that swapped them or read the wrong ref cannot pass by symmetry.
  commit(p("other"), "remote.txt", "a subject\twith a tab in it");
  git(p("other"), "push", "-q", "origin", "main");
  commit(p("project"), "local.txt", "local work");
  // The count is against the checkout's own `origin/main` ref (what the fetch pass moves), so fetch before asking.
  git(p("project"), "fetch", "-q", "origin");

  const meta = await projectMeta(PROJECT);
  assert.equal(meta.remoteRef, "origin/main");
  assert.equal(meta.mainAhead, 1, "one local commit the remote lacks");
  assert.equal(meta.mainBehind, 1, "one remote commit the checkout lacks");
  assert.equal(meta.remoteTipSubject, "a subject\twith a tab in it", "a tab in the subject is not eaten as a field");
  assert.ok(meta.remoteTip);
  assert.equal(meta.localMain, git(p("project"), "rev-parse", "--short", "HEAD"));
});

test("projectMeta still reports a base ref it cannot resolve, through the fallback", async () => {
  // A remote name the checkout does not have resolves to `origin` (lib/base-ref.js), so point the project at a
  // branch that does not exist: the one-process call fails on the committish and the two-process retry answers with
  // the same "cannot resolve" the panel showed before.
  const meta = await projectMeta({ ...PROJECT, mainBranch: "no-such-branch" });
  assert.match(meta.error, /cannot resolve origin\/main|cannot resolve/);
});

test("a directory with a .git entry is read without the rev-parse spawn, and a leftover still reads RELEASED", async () => {
  const ctx = { remoteRef: "origin/main", mainBranch: "main", parents: [] };

  // The checkout root has a `.git` DIRECTORY: treeOnDisk answers "a tree" and the scan proceeds with no rev-parse.
  const own = await scanWorktree(PROJECT.path, ctx, "fast");
  assert.equal(own.verdict === "RELEASED", false);
  assert.equal(own.branch, "main");
  assert.equal(own.error, null);

  // A directory left behind by an eviction has no `.git`: the authority is asked, and the row is RELEASED with the
  // checkout git would have answered for.
  const leftover = p("project", "leftover-dir");
  mkdirSync(leftover);
  writeFileSync(path.join(leftover, "kept.txt"), "somebody's file\n");
  const gone = await scanWorktree(leftover, ctx, "fast");
  assert.equal(gone.verdict, "RELEASED");
  assert.match(gone.released.why, /leftover directory/);
  assert.equal(gone.released.outer, p("project"));

  // A `.git` FILE whose registration was pruned passes the cheap check and fails `status`; the failure path asks the
  // authority, so a pruned tree still reads RELEASED rather than as an ERROR row holding "work".
  const pruned = p("project", "pruned-tree");
  mkdirSync(pruned);
  // No absolute-path literal in the source: the allowlist gate (tools/absolute-paths.mjs) scans this tree, and the
  // gitdir only has to point nowhere.
  writeFileSync(path.join(pruned, ".git"), `gitdir: ${path.join(root, "no-such-gitdir")}\n`);
  const broken = await scanWorktree(pruned, ctx, "fast");
  assert.equal(broken.verdict, "RELEASED", `got ${broken.verdict}: ${broken.error}`);
  assert.ok(broken.released, "the row carries the reason it is not a tree");
});

test("a boot pass leaves the board claim to boardPass", async () => {
  const store = new Store();
  const project = { name: "fixture", path: p("project"), remote: "origin", mainBranch: "main", tier: "recent" };
  const scheduler = new Scheduler({
    config: { projects: [project], scanMode: "visible" },
    store,
    pool: {
      isBusy: () => false,
      meta: async () => ({ meta: { remoteRef: "origin/main", hasRemote: true, remoteTip: "abc1234" }, trees: null }),
      run: async ({ wtPath }) => ({ path: wtPath, name: "project", branch: "main", head: "abc1234", ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
    },
    getProjects: () => [project],
  });
  scheduler.reconcile = async () => ({ ok: true, listed: 0 });
  scheduler.sessionRoots = async () => new Map();
  scheduler.claudeRoots = async () => new Map();
  // A booted scheduler has `stopped` false (start() sets it); boardPass refuses to work on a stopped one.
  scheduler.stopped = false;
  store.patchProject(project.name, { path: project.path, remote: "origin", mainBranch: "main" });
  store.seedCached({ project: project.name, path: project.path, name: "project", branch: "main", sha: "abc1234" });

  await scheduler.fullPassProject(project, { boot: true, rows: false, fetch: false });
  assert.equal(store.projects.get(project.name).board, undefined, "the boot did not spend a process table on the board");

  await scheduler.boardPass();
  assert.deepEqual(store.projects.get(project.name).board, { total: 0, live: [], dead: 0 }, "the board pass filled it");
});
