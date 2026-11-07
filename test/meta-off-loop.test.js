// Two changes, both pinned by measurement rather than by reading the code:
//
//  1. `projectMeta` costs three git processes (a remote probe, one `for-each-ref`, one `rev-list`) where it used to
//     cost six (a remote probe, two `rev-parse`, two `log -1`, one `rev-list`). On a machine where a spawn blocks its
//     loop for 0.6-4.7 s under the endpoint filter, that is the difference the profile asked for.
//  2. A full pass asks the POOL for a project's meta and worktree list, so the loop that answers /api/state does not
//     sit inside a CreateProcess while the fleet is mapped - and the tree list rides back with the meta, so the
//     reconcile costs no second `git worktree list`.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectMeta } from "../lib/project.js";
import { Scheduler } from "../lib/scheduler.js";
import { Pool } from "../lib/pool.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const repoRoot = path.resolve(here, "..");
const root = mkdtempSync(path.join(tmpdir(), "wag-meta-off-loop-"));
after(() => rmSync(root, { recursive: true, force: true }));

const repo = path.join(root, "repo");
mkdirSync(repo, { recursive: true });
const run = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
run("init", "-q", "-b", "main");
writeFileSync(path.join(repo, "README.md"), "# r\n");
run("add", "-A");
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"]);
run("update-ref", "refs/remotes/origin/main", "HEAD");
run("remote", "add", "origin", "https://example.invalid/repo.git");

const project = { name: "repo", path: repo.replace(/\\/g, "/"), remote: "origin", mainBranch: "main" };

test("projectMeta answers the same fields from one ref listing", async () => {
  const meta = await projectMeta(project);
  assert.equal(meta.remoteRef, "origin/main");
  assert.equal(meta.remoteTip, run("rev-parse", "--short", "origin/main"));
  assert.equal(meta.remoteTipSubject, "first");
  assert.match(meta.remoteTipDate, /^\d{4}-\d{2}-\d{2}T/, "the commit date is the strict ISO form %cI prints");
  assert.equal(meta.localMain, run("rev-parse", "--short", "main"));
  assert.equal(meta.mainBehind, 0);
  assert.equal(meta.mainAhead, 0);
});

test("projectMeta starts three git processes, not six", () => {
  const counter = path.join(repoRoot, "tools", "git-spawn-counter.cjs");
  const logFile = path.join(root, "spawn.log");
  const mod = pathToFileURL(path.join(repoRoot, "lib", "project.js")).href;
  const script = `import(${JSON.stringify(mod)}).then(async ({ projectMeta }) => { await projectMeta(${JSON.stringify(project)}); });`;
  const child = spawnSync(process.execPath, ["--require", counter, "--input-type=module", "-e", script], {
    env: { ...process.env, WAG_GIT_COUNT_LOG: logFile },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3, `one remote probe + for-each-ref + rev-list, got:\n${lines.join("\n")}`);
  assert.match(lines.join("\n"), /for-each-ref/, "the ref listing is what replaced three of the five reads");
});

test("a full pass takes the meta and the tree list from the pool, and reads nothing on its own thread", async () => {
  const patched = {};
  const config = {
    tierDays: 7,
    tierBuckets: 60,
    tierCheckSeconds: 60,
    slowSeconds: 300,
    threads: 1,
    scanMode: "all",
    fetchSeconds: -1,
  };
  const store = {
    rowsFor: () => [],
    ensureProject() {},
    patchProject: (name, patch) => Object.assign(patched, patch),
    markError() {},
  };
  const calls = { meta: 0, list: 0 };
  const pool = {
    size: 1,
    inFlight: 0,
    queue: [],
    meta: async () => {
      calls.meta += 1;
      return { meta: { remoteTip: "abc1234", remoteRef: "origin/main" }, trees: [{ path: repo }] };
    },
  };
  const scheduler = new Scheduler({
    config,
    store,
    pool,
    registry: { getConfig: () => config, projects: [], tiers: null },
    getProjects: () => [],
    listWorktrees: async () => {
      calls.list += 1;
      return [];
    },
  });
  await scheduler.fullPassProject({ ...project }, { rows: false });
  assert.equal(calls.meta, 1, "the pool did the meta and the worktree list");
  assert.equal(calls.list, 0, "the reconcile used the list that came back with the meta");
  assert.equal(patched.remoteTip, "abc1234");
});

// The worker branch itself, not a stub: a real Pool, a real worker thread, a real git inside it.
test("the pool runs a meta job in a worker thread and hands back meta + trees", async () => {
  const pool = new Pool(1);
  try {
    const out = await pool.meta(project);
    assert.equal(out.meta.remoteTip, run("rev-parse", "--short", "origin/main"));
    assert.equal(out.meta.remoteTipSubject, "first");
    const trees = out.trees.map((t) => String(t.path).replace(/\\/g, "/").toLowerCase());
    assert.ok(
      trees.includes(repo.replace(/\\/g, "/").toLowerCase()),
      `the project's own tree is listed: ${trees.join(", ")}`,
    );
  } finally {
    pool.close();
  }
});

test("without a pool the pass still reads its own meta (a probe, a test, a bare Scheduler)", async () => {
  const patched = {};
  const config = { tierDays: 7, tierBuckets: 60, tierCheckSeconds: 60, slowSeconds: 300, threads: 1, scanMode: "all" };
  const store = { rowsFor: () => [], ensureProject() {}, patchProject: (n, p) => Object.assign(patched, p), markError() {} };
  const scheduler = new Scheduler({
    config,
    store,
    pool: null,
    registry: { getConfig: () => config, projects: [], tiers: null },
    getProjects: () => [],
    listWorktrees: async () => [],
  });
  await scheduler.fullPassProject({ ...project }, { rows: false });
  assert.equal(patched.remoteTip, run("rev-parse", "--short", "origin/main"));
  assert.equal(patched.remoteTipSubject, "first");
});
