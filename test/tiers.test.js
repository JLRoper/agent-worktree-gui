// The two-tier gate's own rules (lib/tiers.js), and the half of discovery the change must not disturb: a
// steady-state pass reuses every record it knows and starts no git process at all.
//
// The tier rule is the last COMMIT, and only that: a repo inside the window keeps today's treatment, one past it
// is checked by four .git stats an hour. The four paths are the ones whose mtime a commit, a checkout, a branch
// or a stage leaves a mark on, and the bucket is a hash of the PATH so a repo's minute does not move when its
// neighbours come and go.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RECENT_DAYS,
  SIGNAL_KEYS,
  TierBook,
  bucketFor,
  nextCheckAt,
  signalMoved,
  sliceIndex,
  statSignal,
  tierOf,
} from "../lib/tiers.js";
import { ProjectRegistry } from "../lib/projects.js";
import { Store } from "../lib/store.js";
import { git } from "../tools/panel-testkit.mjs";

const root = mkdtempSync(path.join(tmpdir(), "wag-tiers-"));
after(() => rmSync(root, { recursive: true, force: true }));
const p = (...s) => path.join(root, ...s).replace(/\\/g, "/");
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const DAY = 864e5;

test("tier: the last commit decides, and an unknown date is recent rather than old", () => {
  const now = Date.now();
  assert.equal(tierOf({ activityAt: iso(0) }, now), "recent");
  assert.equal(tierOf({ activityAt: iso(RECENT_DAYS - 0.5) }, now), "recent", "inside the window");
  assert.equal(tierOf({ activityAt: iso(RECENT_DAYS + 0.5) }, now), "old", "past the window");
  // "we have not probed it yet" is not "nothing happened in seven days": a record without a date must keep
  // today's treatment, or discovery would stop reading a project nothing had classified.
  assert.equal(tierOf({ activityAt: null }, now), "recent");
  assert.equal(tierOf({}, now), "recent");
  assert.equal(tierOf({ activityAt: "not a date" }, now), "recent");
  assert.equal(tierOf({ activityAt: iso(8) }, now, 10), "recent", "the window is a config knob");
});

test("bucket: a per-path hash, stable across calls, spread over the hour", () => {
  const paths = Array.from({ length: 177 }, (_, i) => `/trees/repo-${i}`);
  const buckets = paths.map((x) => bucketFor(x, 60));
  assert.ok(buckets.every((b) => Number.isInteger(b) && b >= 0 && b < 60), "every bucket is inside the hour");
  assert.equal(bucketFor(paths[7], 60), bucketFor(paths[7].replace(/\//g, path.sep === "/" ? "\\" : "/"), 60), "slash style does not move it");
  const used = new Set(buckets).size;
  assert.ok(used >= 45, `177 repos land in ${used} of 60 buckets - a slice is a handful, not the fleet`);
  assert.deepEqual(paths.map((x) => bucketFor(x, 60)), buckets, "the same path always lands in the same minute");
});

test("slice and next check: one minute's slice, and the next one is inside the rotation", () => {
  const start = Date.UTC(2026, 0, 1, 10, 0, 0);
  assert.equal(sliceIndex(start, 60, 60), 0);
  assert.equal(sliceIndex(start + 61 * 60e3, 60, 60), 1);
  const repo = "/trees/repo-7";
  const bucket = bucketFor(repo, 60);
  const next = nextCheckAt(repo, start, 60, 60);
  assert.ok(next > start, "the next check is in the future even when its minute just passed");
  assert.equal(sliceIndex(next, 60, 60), bucket, "the next check lands in the repo's own slice");
  assert.ok(next <= start + 60 * 60e3, "and inside the hour");
  // Asking again from inside its own minute must not answer "now": that would re-check a repo on every tick.
  const inside = start + bucket * 60e3 + 1;
  assert.equal(nextCheckAt(repo, inside, 60, 60), start + (bucket + 60) * 60e3, "the next rotation, not this tick");
});

test("stat signal: the four watched paths, and any mtime change is movement", async () => {
  const repo = p("repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");

  const base = await statSignal(repo);
  assert.deepEqual(Object.keys(base).sort(), SIGNAL_KEYS.slice().sort(), "exactly the four paths");
  for (const key of SIGNAL_KEYS) assert.ok(base[key] > 0, `${key} reads a real mtime`);
  assert.deepEqual(await statSignal(repo), base, "an untouched repo reads the same signature");

  // A commit rewrites .git/logs/HEAD and .git/index.
  writeFileSync(path.join(repo, "a.txt"), "changed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "two");
  const committed = await statSignal(repo);
  assert.ok(signalMoved(base, committed), "a commit moves the signal");

  // A branch rewrites the refs/heads DIRECTORY.
  git(repo, "branch", "feature/two");
  const branched = await statSignal(repo);
  assert.ok(signalMoved(committed, branched), "creating a branch moves the signal");

  // A checkout rewrites .git/HEAD.
  git(repo, "checkout", "-q", "feature/two");
  const checkedOut = await statSignal(repo);
  assert.ok(signalMoved(branched, checkedOut), "a checkout moves the signal");

  // Editing a file is NOT movement: the gate is about git state, and a plain write touches none of the four.
  writeFileSync(path.join(repo, "a.txt"), "edited, not staged\n");
  assert.ok(!signalMoved(checkedOut, await statSignal(repo)), "a working-tree edit without a git command is not movement");

  const gone = await statSignal(p("not-a-repo"));
  assert.deepEqual(gone, { head: 0, index: 0, refs: 0, logs: 0 }, "a missing repo reads four zeros instead of throwing");
});

test("TierBook: stamps tiers, keeps the baseline across a reload, forgets a repo that left", () => {
  const file = p("state", "tiers.json");
  const now = Date.now();
  const book = new TierBook({ file, buckets: 4, checkSeconds: 2, days: 7 });
  const projects = [
    { name: "old", path: "/tiers/old", activityAt: iso(30) },
    { name: "new", path: "/tiers/new", activityAt: iso(1) },
  ];
  const tiers = book.sync(projects, now);
  assert.equal(tiers.get("old"), "old");
  assert.equal(tiers.get("new"), "recent");

  const sig = { head: 10, index: 20, refs: 30, logs: 40 };
  assert.deepEqual(book.stat("/tiers/old", sig, now), { first: true, moved: false }, "the first check only records what it saw");
  assert.equal(book.stat("/tiers/old", { ...sig }, now).moved, false, "the same state is not movement");
  assert.equal(book.stat("/tiers/old", { ...sig, index: 21 }, now).moved, true, "an index that moved is movement");
  // A moved baseline is NOT recorded: the caller promotes and re-seeds, so a promotion that fails is retried.
  assert.equal(book.stat("/tiers/old", { ...sig, index: 21 }, now).moved, true, "still movement until the caller seeds it");
  book.seed("/tiers/old", { ...sig, index: 21 }, "old", now);
  assert.equal(book.stat("/tiers/old", { ...sig, index: 21 }, now).moved, false, "the post-promotion state is the new baseline");

  const reloaded = new TierBook({ file, buckets: 4 });
  assert.deepEqual(reloaded.baselineFor("/tiers/old"), { ...sig, index: 21 }, "the baseline survives a restart");
  assert.equal(reloaded.tierFor("/tiers/old"), "old");

  reloaded.sync([projects[1]], now);
  assert.equal(reloaded.tierFor("/tiers/old"), null, "a repo no longer under the roots is forgotten");
});

test("discovery: a steady-state pass reuses every record and starts no git process", async () => {
  const roots = [p("disc-a"), p("disc-b")];
  const records = [];
  for (const rootDir of roots) {
    mkdirSync(root, { recursive: true });
    for (const ageDays of [1, 30]) {
      const name = `${path.basename(rootDir)}-${ageDays}`;
      const repo = path.join(rootDir, name);
      for (const rel of [".git", ".git/refs/heads", ".git/logs"]) mkdirSync(path.join(repo, rel), { recursive: true });
      for (const rel of [".git/HEAD", ".git/index", ".git/logs/HEAD"]) writeFileSync(path.join(repo, rel), "x\n");
      records.push({ name, path: repo.replace(/\\/g, "/"), root: rootDir, head: "main", empty: false, remote: null, mainBranch: "main", activityAt: iso(ageDays) });
    }
  }
  const cacheFile = p("discovery-cache", "projects.json");
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ projects: records }));
  const calls = [];
  const gitStub = (...args) => {
    calls.push(args);
    return Promise.resolve({ ok: false, out: "", err: "should not be called" });
  };
  const registry = new ProjectRegistry({
    getConfig: () => ({ scanRoots: roots, projects: [], tierDays: 7 }),
    store: new Store(),
    onLog: () => {},
    cacheFile,
    tierFile: p("discovery-cache", "tiers.json"),
    git: gitStub,
  });
  const list = await registry.discover();
  assert.equal(calls.length, 0, "no probe, therefore no git: the known records are reused as they are");
  assert.equal(list.length, 4);
  assert.equal(list.filter((project) => project.tier === "old").length, 2, "the 30-day repos are on the gate");
  assert.equal(list.filter((project) => project.tier === "recent").length, 2);
  const reused = list.find((project) => project.name.endsWith("-30"));
  assert.equal(reused.activityAt, records.find((r) => r.name === reused.name).activityAt, "the record itself is reused");

  // A repo that is new to this machine is probed once - and only once: the next pass reuses the record it wrote.
  const fresh = path.join(roots[0], "brand-new");
  for (const rel of [".git", ".git/refs/heads", ".git/logs"]) mkdirSync(path.join(fresh, rel), { recursive: true });
  for (const rel of [".git/HEAD", ".git/index", ".git/logs/HEAD"]) writeFileSync(path.join(fresh, rel), "x\n");
  const probed = await registry.discover();
  assert.ok(calls.length > 0, "the unknown directory is probed");
  assert.equal(probed.length, 5);
  const afterFirst = calls.length;
  await registry.discover();
  assert.equal(calls.length, afterFirst, "and the pass after that starts no git process again");
});
