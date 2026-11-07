// The scan half of the two-tier split: an OLD repo is stat-gated (no row scan, no full pass, no fetch), and one
// of its signal moving - or the reader opening the project - promotes it for exactly ONE full probe and
// one read of its rows. A RECENT repo is untouched: it keeps today's treatment.
//
// The repo here is real (a commit dated 20 days ago is what makes it old), while the pool is a stub: the test is
// about the scheduler's DECISIONS, not about git's speed.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../lib/projects.js";
import { Scheduler } from "../lib/scheduler.js";
import { Store } from "../lib/store.js";
import { gitIn } from "../lib/scan.js";
import { git } from "../tools/panel-testkit.mjs";

const root = mkdtempSync(path.join(tmpdir(), "wag-discovery-tiers-"));
after(() => rmSync(root, { recursive: true, force: true }));
const DAY = 864e5;
const scanRoot = path.join(root, "repos").replace(/\\/g, "/");

function makeRepo(name, ageDays) {
  const dir = path.join(scanRoot, name);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() - ageDays * DAY).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  execFileSync("git", ["-C", dir, "add", "-A"], { env, stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "first"], { env, stdio: "ignore" });
  return dir.replace(/\\/g, "/");
}

const oldRepo = makeRepo("old-repo", 20);
const newRepo = makeRepo("new-repo", 0);

const store = new Store();
const stateDir = path.join(root, "state");
mkdirSync(stateDir, { recursive: true });
const registry = new ProjectRegistry({
  getConfig: () => ({ scanRoots: [scanRoot], projects: [], tierDays: 7, tierBuckets: 1, tierCheckSeconds: 1 }),
  store,
  onLog: () => {},
  cacheFile: path.join(stateDir, "projects.json"),
  tierFile: path.join(stateDir, "tiers.json"),
});

const rowsFor = (project, rowPath) => ({
  path: rowPath,
  name: path.basename(rowPath),
  branch: "main",
  head: "abcdef0",
  ahead: 0,
  behind: 0,
  dirty: 0,
  untracked: 0,
  verdict: "MERGED",
  lastCommit: project.activityAt,
});

const scanned = [];
const scheduler = new Scheduler({
  config: { worktreeSeconds: 5, midSeconds: 30, dormantSeconds: 30, slowSeconds: 3600, tierBuckets: 1, tierCheckSeconds: 1, tierDays: 7, fetchSeconds: 0 },
  store,
  pool: {
    run: async ({ wtPath }) => {
      scanned.push(wtPath);
      return rowsFor({ activityAt: new Date().toISOString() }, wtPath);
    },
    isBusy: () => false,
    inFlight: 0,
  },
  registry,
  getProjects: () => registry.projects,
  listWorktrees: async (projectPath) => [{ path: projectPath, branch: "main", head: "abcdef0" }],
});
// The decisions under test are the scheduler's, not git's or the session store's: session attribution reads the
// real ~/.hermes store and costs seconds on a cold process, so it is stubbed. `scanOne` is reduced to the pool
// call plus the row write, which is what "the promotion read the repo's rows" means here.
scheduler.sessionRoots = async () => new Map();
scheduler.claudeRoots = async () => new Map();
scheduler.scanOne = async (project, rowPath, depth) => {
  const row = await scheduler.pool.run({ wtPath: rowPath, ctx: {} });
  return store.putRow(project.name, row, depth || "full");
};

test("discovery classifies both repos, and the old one keeps its record", async () => {
  const list = await registry.discover();
  const old = list.find((project) => project.name === "old-repo");
  const fresh = list.find((project) => project.name === "new-repo");
  assert.ok(old && fresh, "both repos are projects");
  assert.equal(old.tier, "old", "a commit 20 days old is the old tier");
  assert.equal(fresh.tier, "recent", "a commit today keeps today's treatment");
  assert.match(old.activityAt, /T/, "the probe read a real commit date");
  // A row for each, so the scheduler has something it could scan.
  for (const project of [old, fresh]) store.putRow(project.name, rowsFor(project, project.path), "full", { force: true });
});

test("an old repo is not queued for a row scan; a recent one is", () => {
  const old = registry.projects.find((project) => project.name === "old-repo");
  const fresh = registry.projects.find((project) => project.name === "new-repo");
  const queued = [];
  const realScan = scheduler.scanRow;
  scheduler.scanRow = (project, row) => queued.push(`${project.name}::${row.path}`);
  try {
    const t = Date.now();
    for (const project of [old, fresh]) {
      scheduler.enqueueDue(project, t);
      scheduler.enqueueDue(project, t + 31_000);
    }
  } finally {
    scheduler.scanRow = realScan;
  }
  assert.deepEqual(
    queued.map((key) => key.split("::")[0]),
    ["new-repo"],
    "the old tier's rows are not polled at all, the recent tier's are",
  );
});

test("the gate checks one old repo, promotes it on movement, and never checks the recent one", async () => {
  const old = registry.projects.find((project) => project.name === "old-repo");
  assert.equal(old.tier, "old", "still old before the gate runs");
  const before = scanned.length;
  const t = Date.now();

  const first = await scheduler.tierPass(t);
  assert.equal(first.checked, 1, "only the old repo is stat-checked");
  assert.equal(first.promoted, 0, "the first check records a baseline instead of promoting");

  // Movement on one of the four watched paths. Staging a file rewrites .git/index.
  writeFileSync(path.join(oldRepo, "touched.txt"), "touched\n");
  execFileSync("git", ["-C", oldRepo, "add", "-A"], { stdio: "ignore" });
  const moved = await scheduler.tierPass(t + 2000);
  assert.equal(moved.checked, 1);
  assert.equal(moved.promoted, 1, "a touched old repo promotes within ONE pass");
  assert.equal(scheduler.stats.tierPromotions, 1);
  assert.equal(scanned.length, before + 1, "promotion ran today's full treatment: one row re-read");

  // The commit is still 20 days old, so it returns to the gate with a FRESH baseline - and the next slice must
  // not promote it again for the movement that was already handled.
  const settled = await scheduler.tierPass(t + 3000);
  assert.equal(settled.promoted, 0, "a promotion re-seeds the baseline; the same movement does not promote twice");
  assert.equal(registry.projects.find((project) => project.name === "old-repo").tier, "old");
  assert.equal(scanned.length, before + 1);

  // The recent repo was never stat-checked: the gate's `checked` counts only old repos, which the count of 1
  // above already says (there are two projects and only one was read).
});

test("the reader opening an old project promotes it again, and a recent one costs nothing", async () => {
  const before = scanned.length;
  const opened = await scheduler.openProject("old-repo");
  assert.equal(opened.promoted, true, "opening an old section is a promotion signal");
  assert.equal(scheduler.stats.tierPromotions, 2);
  assert.equal(scanned.length, before + 1, "its rows were read");

  const recent = await scheduler.openProject("new-repo");
  assert.equal(recent.promoted, false, "a recent project is already on the scan cadence");
  assert.equal(recent.tier, "recent");

  const missing = await scheduler.openProject("not-a-project");
  assert.equal(missing.ok, false);
  assert.match(missing.why, /no project called/);
});

// ---- the refresh path's gate --------------------------------------------------------------------------------
// The three tests above are the old tier's SCAN half. These three are the half that made the fleet slow: every
// refresh pass (the slow clock, the Refresh button, the pass the Fetch button chains) walked all ~100 projects
// and re-read every worktree of every one of them, so the 160 repositories that had not moved in a week paid a
// full `git worktree list`, a project meta and one scan per row on every pass, forever. A refresh may not read
// an old repo at all, and it may not promote one either: the tier is decided by a probe the stat gate runs.

test("a refresh pass reads no old repo, and cannot make it recent", async () => {
  const old = registry.projects.find((project) => project.name === "old-repo");
  assert.equal(old.tier, "old", "still on the gate before the refresh");
  // Every project body starts with `store.patchProject(await projectMeta(project))`, so a record this pass
  // touched is a pass that ran git. Nothing here stubs projectMeta: the assertion is that it is never called.
  const patched = [];
  const realPatch = store.patchProject.bind(store);
  store.patchProject = (name, patch) => {
    patched.push(name);
    return realPatch(name, patch);
  };
  const readsBefore = scanned.filter((rowPath) => rowPath === old.path).length;
  const parkedBefore = scheduler.stats.tierParked;
  try {
    await scheduler.fullPass({ rows: true });
  } finally {
    store.patchProject = realPatch;
  }
  assert.ok(!patched.includes("old-repo"), "the old project's pass body never started: no git worktree list, no meta, no scan");
  assert.ok(patched.includes("new-repo"), "the recent project is still read: the gate is a tier, not a mode");
  assert.equal(scanned.filter((rowPath) => rowPath === old.path).length, readsBefore, "no row of the old repo was re-read");
  assert.equal(registry.projects.find((project) => project.name === "old-repo").tier, "old", "a refresh cannot promote a repo, whatever it would have found");
  assert.equal(scheduler.stats.tierParked - parkedBefore, 1, "the gate counts the pass it parked");
});

test("an old repo with no rows is mapped ONCE, and gated from then on", async () => {
  // A cold process has no rows, and the board draws a project from its rows: the first pass over an old repo
  // has to map them. That single read is the only git an old repo pays outside the stat check - the pass after
  // it, and every pass after that, must not touch it.
  const mapStore = new Store();
  const listed = [];
  const mapScheduler = new Scheduler({
    config: { worktreeSeconds: 5, midSeconds: 30, dormantSeconds: 30, slowSeconds: 3600, tierBuckets: 1, tierCheckSeconds: 1, tierDays: 7, fetchSeconds: 0 },
    store: mapStore,
    pool: {
      run: async ({ wtPath }) => ({ path: wtPath, name: path.basename(wtPath), branch: "main", head: "abcdef0", ahead: 0, behind: 0, dirty: 0, untracked: 0, verdict: "MERGED" }),
      isBusy: () => false,
      inFlight: 0,
    },
    registry: null,
    getProjects: () => registry.projects,
    listWorktrees: async (projectPath) => {
      listed.push(projectPath);
      return [{ path: projectPath, branch: "main", head: "abcdef0" }];
    },
  });
  mapScheduler.sessionRoots = async () => new Map();
  mapScheduler.claudeRoots = async () => new Map();
  mapScheduler.scanOne = async (project, rowPath, depth) => {
    const row = await mapScheduler.pool.run({ wtPath: rowPath, ctx: {} });
    return mapStore.putRow(project.name, row, depth || "full");
  };
  const oldPath = registry.projects.find((project) => project.name === "old-repo").path;
  const newPath = registry.projects.find((project) => project.name === "new-repo").path;

  await mapScheduler.fullPass({ rows: true });
  assert.deepEqual(listed.slice().sort(), [newPath, oldPath].sort(), "a cold pass maps both repos, because the board needs their rows");
  assert.equal(mapStore.rowsFor("old-repo").length, 1, "the old repo's row exists");

  await mapScheduler.fullPass({ rows: true });
  assert.deepEqual(listed.slice().sort(), [newPath, oldPath, newPath].sort(), "the second pass re-lists only the recent repo");
  assert.equal(mapStore.rowsFor("old-repo").length, 1, "and the old repo's row is untouched");
});

test("a discovery pass over known records starts no git at all", async () => {
  // The other half of the brief: discovery must not re-probe a project it already knows. `git` is the seam the
  // registry takes, so this counts the spawns rather than inferring them.
  const dir = path.join(root, "discovery-count");
  mkdirSync(dir, { recursive: true });
  let spawns = 0;
  const counting = new ProjectRegistry({
    getConfig: () => ({ scanRoots: [scanRoot], projects: [], tierDays: 7, tierBuckets: 1, tierCheckSeconds: 1 }),
    store: new Store(),
    onLog: () => {},
    cacheFile: path.join(dir, "projects.json"),
    tierFile: path.join(dir, "tiers.json"),
    git: (cwd, args) => {
      spawns += 1;
      return gitIn(cwd, args);
    },
  });
  const first = await counting.discover();
  assert.equal(first.length, 2, "both repos are projects");
  const seeding = spawns;
  assert.ok(seeding > 0, "the first pass probes the repos it has never seen");
  const second = await counting.discover();
  assert.equal(second.length, 2);
  assert.equal(spawns, seeding, "a second pass reuses every record: not one git process");
  assert.equal(second.find((project) => project.name === "old-repo").tier, "old", "and the old repo is on the gate, not the scan cadence");
});
