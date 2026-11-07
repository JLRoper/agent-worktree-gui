// The two-tier gate's own rules (lib/tiers.js), and the half of discovery the change must not disturb: a
// steady-state pass reuses every record it knows and starts no git process at all.
//
// The tier rule is the last COMMIT, and only that: a repo inside the window keeps today's treatment, one past it
// is checked by one signal read an hour. The signal is the worktree walk plus the narrow git watch set, and it
// must move on the three events the gate exists for - a commit, a new branch and a dirty tree - while staying
// quiet for the panel's own fetch and for dependency trees. The bucket is a hash of the PATH so a repo's minute
// does not move when its neighbours come and go.
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
  gitDirs,
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
// A file's mtime is the only thing the signal can see, and the filesystem's clock is coarser than a test's
// loop: a write in the same tick as the read before it can tie. Ten milliseconds is well under any
// filesystem's granularity that matters here and keeps a fast machine from flaking.
const tick = () => new Promise((r) => setTimeout(r, 12));
const sigOf = (overrides = {}) => Object.fromEntries(SIGNAL_KEYS.map((key) => [key, overrides[key] ?? 100]));

test("tier: the last commit decides, and an unknown date is old rather than recent", () => {
  const now = Date.now();
  assert.equal(tierOf({ activityAt: iso(0) }, now), "recent");
  assert.equal(tierOf({ activityAt: iso(RECENT_DAYS - 0.5) }, now), "recent", "inside the window");
  assert.equal(tierOf({ activityAt: iso(RECENT_DAYS + 0.5) }, now), "old", "past the window");
  // "we do not know its date" is not "it was touched today": an unclassified record is OLD, so it sits on
  // the hourly gate and one probe decides. Defaulting it to recent is how every project gets read in full.
  assert.equal(tierOf({ activityAt: null }, now), "old");
  assert.equal(tierOf({}, now), "old");
  assert.equal(tierOf({ activityAt: "not a date" }, now), "old");
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

test("stat signal: a commit, a new branch and a dirty tree all promote; a fetch and node_modules do not", async () => {
  const repo = p("repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");

  const base = await statSignal(repo);
  assert.deepEqual(Object.keys(base).sort(), SIGNAL_KEYS.slice().sort(), "exactly the watched signal");
  for (const key of SIGNAL_KEYS) {
    // A fresh repository has no `.git/packed-refs` yet, and a missing path reads 0 rather than throwing; the
    // packing test below is what pins that key.
    if (key === "packed") continue;
    assert.ok(base[key] > 0, `${key} reads a real mtime`);
  }
  await tick();
  assert.deepEqual(await statSignal(repo), base, "an untouched repo reads the same signature");

  // A commit rewrites .git/index and .git/logs/HEAD.
  await tick();
  writeFileSync(path.join(repo, "a.txt"), "changed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "two");
  const committed = await statSignal(repo);
  assert.ok(signalMoved(base, committed), "a commit moves the signal");

  // A branch rewrites refs/heads.
  await tick();
  git(repo, "branch", "feature/two");
  const branched = await statSignal(repo);
  assert.ok(signalMoved(committed, branched), "creating a branch moves the signal");

  // A checkout rewrites .git/HEAD.
  await tick();
  git(repo, "checkout", "-q", "feature/two");
  const checkedOut = await statSignal(repo);
  assert.ok(signalMoved(branched, checkedOut), "a checkout moves the signal");

  // A DIRTY TREE is movement, and at any depth: an edit moves the file and nothing else, so a row an agent is
  // working in must promote even though no git command ran. The old four-.git-stat gate missed this, and on
  // this fleet that was 35 of the 101 dirty repos.
  const deep = path.join(repo, "src", "main", "java", "com", "sefl", "Deep.java");
  mkdirSync(path.dirname(deep), { recursive: true });
  await tick();
  writeFileSync(deep, "class Deep {}\n");
  assert.ok(signalMoved(checkedOut, await statSignal(repo)), "an unstaged edit at depth 5 moves the signal");

  // A new untracked file is movement too - that is the same walk.
  const afterDeep = await statSignal(repo);
  await tick();
  writeFileSync(path.join(repo, "notes.md"), "scratch\n");
  assert.ok(signalMoved(afterDeep, await statSignal(repo)), "an untracked file moves the signal");

  // A dependency tree is NOT the row's work: node_modules and build output are pruned on purpose.
  const dep = path.join(repo, "node_modules", "left-pad", "index.js");
  mkdirSync(path.dirname(dep), { recursive: true });
  writeFileSync(dep, "module.exports = 1\n");
  const withDeps = await statSignal(repo);
  await tick();
  writeFileSync(dep, "module.exports = 2\n");
  assert.ok(!signalMoved(withDeps, await statSignal(repo)), "an edit under node_modules is not movement");

  // The panel's own fetch pass must not promote anything: FETCH_HEAD and refs/remotes are deliberately absent
  // from the watch set, because they move for the panel's writes and not for the row's state.
  const quiet = await statSignal(repo);
  await tick();
  writeFileSync(path.join(repo, ".git", "FETCH_HEAD"), "0000\t\tbranch 'main' of origin\n");
  mkdirSync(path.join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "refs", "remotes", "origin", "main"), "0000\n");
  assert.ok(!signalMoved(quiet, await statSignal(repo)), "a fetch's own writes are not movement");

  // `packed-refs` is watched: a gc that packs the refs is movement, and a repo that has never been packed
  // reads 0 there until one writes it.
  const unpacked = await statSignal(repo);
  assert.equal(unpacked.packed, 0, "a repo that has never been packed has no packed-refs");
  await tick();
  git(repo, "pack-refs", "--all");
  assert.ok(signalMoved(unpacked, await statSignal(repo)), "packing the refs moves the signal");

  const gone = await statSignal(p("not-a-repo"));
  assert.deepEqual(gone, Object.fromEntries(SIGNAL_KEYS.map((k) => [k, 0])), "a missing repo reads zeros instead of throwing");
});

test("stat signal: a linked worktree resolves its real git dir, so its commit moves the signal", async () => {
  const main = p("wt-main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "one");
  const linked = p("wt-main", ".worktrees", "child");
  git(main, "worktree", "add", "-q", "-b", "child", linked);

  // `.git` here is a FILE. A literal `<repo>/.git/index` would read 0 and the row would never move.
  const dirs = gitDirs(linked);
  assert.notEqual(dirs.gitdir, path.join(linked, ".git"), "the gitfile names the real git dir");
  const base = await statSignal(linked);
  for (const key of SIGNAL_KEYS) {
    if (key === "packed") continue; // the common dir is packed only after a gc; pinned above
    assert.ok(base[key] > 0, `${key} reads a real mtime in a linked worktree`);
  }

  await tick();
  writeFileSync(path.join(linked, "a.txt"), "changed\n");
  git(linked, "add", "-A");
  git(linked, "commit", "-q", "-m", "two");
  assert.ok(signalMoved(base, await statSignal(linked)), "a commit in the linked worktree moves its signal");

  // The parent watches the `.worktrees` ENTRIES but does not walk into a sibling worktree: a worktree created
  // is movement for its parent, while a deep edit inside one belongs to that row's own gate.
  const parent = await statSignal(main);
  await tick();
  const second = p("wt-main", ".worktrees", "second");
  git(main, "worktree", "add", "-q", "-b", "second", second);
  assert.ok(signalMoved(parent, await statSignal(main)), "a worktree created is movement for its parent");
  const parentAfter = await statSignal(main);
  await tick();
  writeFileSync(path.join(second, "a.txt"), "dirty\n");
  assert.ok(!signalMoved(parentAfter, await statSignal(main)), "a deep edit in a sibling worktree is not the parent's movement");
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

  const sig = sigOf({ head: 10, index: 20, refs: 30, logs: 40 });
  assert.deepEqual(book.stat("/tiers/old", sig, now), { first: true, moved: false }, "the first check only records what it saw");
  assert.equal(book.stat("/tiers/old", { ...sig }, now).moved, false, "the same state is not movement");
  assert.equal(book.stat("/tiers/old", { ...sig, index: 21 }, now).moved, true, "an index that moved is movement");
  assert.equal(book.stat("/tiers/old", { ...sig, worktree: 99 }, now).moved, true, "a worktree that moved is movement");
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

test("TierBook: a baseline from the older signal set re-seeds instead of promoting the fleet", () => {
  // The gate used to record four `.git` mtimes. Every tiers.json written before this change carries that
  // shape, and comparing it with today's signal would read a missing `worktree` as 0 against a real mtime -
  // one promotion per old repo, on the first slice after the upgrade. A signature that is missing a key is
  // treated as no signature: the check re-seeds and promotes nothing.
  const file = p("state", "tiers-old.json");
  const now = Date.now();
  const book = new TierBook({ file, buckets: 4 });
  book.sync([{ name: "old", path: "/tiers/old", activityAt: iso(30) }], now);
  book.seed("/tiers/old", { head: 10, index: 20, refs: 30, logs: 40 }, "old", now);
  assert.equal(book.stat("/tiers/old", sigOf({ head: 10, index: 20, refs: 30, logs: 40 }), now).moved, false,
    "the old shape is re-seeded, not read as movement");
  assert.equal(book.baselineFor("/tiers/old").worktree, 100, "and the new shape is what the next hour compares");
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
