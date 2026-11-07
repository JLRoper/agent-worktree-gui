#!/usr/bin/env node
// Before/after measurement for the two-tier discovery gate (lib/tiers.js).
//
// The brief's baseline, measured on this machine: 177 projects across its two scan roots (the checkout folders
// it watches), 58 skipped non-repo directories, a steady-state discovery pass measured in tens of milliseconds.
//
// This harness rebuilds that shape in a scratch folder - `--repos 177 --dirs 58` by default, split across two
// roots - and times a FULL discovery pass against a checkout of your choosing. The point of `--root` is to point
// the same harness at an export of the commit BEFORE the change, so the two numbers are the same work measured
// the same way:
//
//   mkdir -p <scratch>/base && git archive <base-sha> | tar -x -C <scratch>/base
//   node tools/measure-discovery-tiers.mjs --base <scratch>/base --passes 5
//
// It also counts what the board's steady-state scan would QUEUE for the same fleet (the scheduler's own
// `enqueueDue` decisions, with `scanRow` stubbed - no git runs), which is the half the tier actually cuts: rows
// in an old repo are not polled at all.
//
// The last section proves the promotion path on a REAL repository: a repo whose only commit is 20 days old
// classifies as old, the first gate pass records a baseline without promoting, touching `.git/index` makes the
// next pass promote it (one full probe + one full read of its rows), and a third pass does not promote again.
//
// Nothing here writes into the checkout: the fixture lives under `--work` (a fresh temp dir unless given) and is
// removed at the end unless `--keep`. Every module it imports is imported by file:/// URL so the base export and
// the working tree can be measured in one run.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN_ROOT = path.resolve(HERE, "..");
const DAY = 864e5;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const AFTER_ROOT = path.resolve(String(arg("root", OWN_ROOT)));
const BASE_ROOT = arg("base", null) ? path.resolve(String(arg("base"))) : null;
const LIVE_ROOTS = arg("roots", null)
  ? String(arg("roots"))
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  : null;
const LIVE_CACHE = arg("cache", null) ? path.resolve(String(arg("cache"))) : null;
const REPOS = Math.max(2, Number(arg("repos", 177)) || 177);
const DIRS = Math.max(0, Number(arg("dirs", 58)) || 58);
const PASSES = Math.max(1, Number(arg("passes", 5)) || 5);
const JSON_OUT = flag("json");
const KEEP = flag("keep");
const WORK = arg("work", null) ? path.resolve(String(arg("work"))) : mkdtempSync(path.join(tmpdir(), "wag-tiers-"));

const say = (...a) => {
  if (!JSON_OUT) console.log(...a);
};
const nowIso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

// The scheduler logs to the console directly (its own `log`), which is right in a panel and noise in a report:
// collect those lines instead of printing them, and hand them back for the JSON report.
async function quiet(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try {
    return await fn(lines);
  } finally {
    console.log = original;
  }
}

// ---- the fixture ---------------------------------------------------------------------------------------------
// A repo here is a directory holding a `.git` DIRECTORY with the four paths the gate watches. Discovery only
// asks that `.git` is a directory (lib/projects.js), and the cache below seeds every record, so no git process
// is needed to make 177 projects: a steady-state pass is exactly what the baseline measured.
function buildFixture() {
  // A live run walks the machine's real roots with a copy of the panel's own projects cache as the seed: that is
  // the 47-163 ms baseline the brief quotes, measured by the same code that measured the synthetic one.
  if (LIVE_ROOTS) {
    const records = LIVE_CACHE ? JSON.parse(readFileSync(LIVE_CACHE, "utf8")).projects || [] : [];
    return { roots: LIVE_ROOTS, records, live: true };
  }
  const roots = [path.join(WORK, "root-a"), path.join(WORK, "root-b")];
  for (const r of roots) mkdirSync(r, { recursive: true });
  const records = [];
  const aCount = Math.round(REPOS * 0.62);
  for (let i = 0; i < REPOS; i += 1) {
    const root = i < aCount ? roots[0] : roots[1];
    const name = `repo-${String(i + 1).padStart(3, "0")}`;
    const repo = path.join(root, name);
    for (const rel of [".git", ".git/refs/heads", ".git/logs"]) mkdirSync(path.join(repo, rel), { recursive: true });
    for (const rel of [".git/HEAD", ".git/index", ".git/logs/HEAD"]) writeFileSync(path.join(repo, rel), `${rel}\n`);
    // One in ten is inside the seven-day window: the shape this machine's board actually has (17 of 177 in the
    // live cache when this was written), which is why the old tier is where the saving is.
    const ageDays = i % 10 === 0 ? 1 : 20 + (i % 40);
    records.push({
      name,
      path: repo.replace(/\\/g, "/"),
      root: root.replace(/\\/g, "/"),
      head: "main",
      empty: false,
      remote: null,
      remoteUrl: null,
      mainBranch: "main",
      prRepo: null,
      activityAt: nowIso(ageDays * DAY),
      lastCommit: nowIso(ageDays * DAY),
    });
  }
  for (let i = 0; i < DIRS; i += 1) {
    mkdirSync(path.join(i % 2 === 0 ? roots[0] : roots[1], `notes-${String(i + 1).padStart(2, "0")}`), { recursive: true });
  }
  return { roots, records };
}

// One label's own cache + tier book, so the two builds cannot read each other's state.
function seed(label, fixture) {
  const dir = path.join(WORK, label);
  mkdirSync(dir, { recursive: true });
  const cacheFile = path.join(dir, "projects.json");
  writeFileSync(cacheFile, JSON.stringify({ savedAt: nowIso(), projects: fixture.records }, null, 0));
  return { dir, cacheFile, tierFile: path.join(dir, "tiers.json") };
}

// ---- one checkout's measurement -----------------------------------------------------------------------------
async function load(root) {
  const mod = (rel) => import(pathToFileURL(path.join(root, "lib", rel)).href);
  const [{ ProjectRegistry }, { Store }, { Scheduler }, tiers] = await Promise.all([
    mod("projects.js"),
    mod("store.js"),
    mod("scheduler.js"),
    mod("tiers.js").catch(() => null),
  ]);
  return { ProjectRegistry, Store, Scheduler, tiers };
}

async function measure(label, root, fixture) {
  const { ProjectRegistry, Store, Scheduler, tiers } = await load(root);
  const files = seed(label, fixture);
  const logs = [];
  const store = new Store();
  const registry = new ProjectRegistry({
    getConfig: () => ({ scanRoots: fixture.roots, projects: [], tierBuckets: 60, tierCheckSeconds: 60, tierDays: 7 }),
    store,
    onLog: (line) => logs.push(String(line)),
    cacheFile: files.cacheFile,
    tierFile: files.tierFile,
  });
  const times = [];
  let list = [];
  for (let i = 0; i < PASSES; i += 1) {
    logs.length = 0;
    const t0 = performance.now();
    list = await registry.discover();
    times.push(performance.now() - t0);
  }
  const probed = Number((logs.find((l) => /probed \d+ new/.test(l)) || "").match(/probed (\d+) new/)?.[1] || 0);
  const skipped = Number((logs.find((l) => /skipped \d+ non-repo/.test(l)) || "").match(/skipped (\d+) non-repo/)?.[1] || 0);
  const tiered = list.some((p) => p.tier === "old" || p.tier === "recent");

  // The steady-state scan decisions: a fresh store with one MERGED row per project, then two `enqueueDue` calls
  // one interval apart (the first only seeds each row's slot). `scanRow` is stubbed, so this counts the board's
  // decisions with no git and no scan cost.
  const scanStore = new Store();
  for (const p of fixture.records) {
    scanStore.ensureProject(p);
    scanStore.putRow(p.name, { path: p.path, branch: "main", head: "abc1234", ahead: 0, behind: 0, dirty: 0, untracked: 0, verdict: "MERGED", lastCommit: p.lastCommit }, "full", { force: true });
  }
  const scheduler = new Scheduler({
    config: { worktreeSeconds: 5, midSeconds: 30, dormantSeconds: 30, slowSeconds: 3600, tierBuckets: 60, tierCheckSeconds: 60, tierDays: 7 },
    store: scanStore,
    pool: { run: async () => ({}), isBusy: () => false, inFlight: 0 },
    registry: null,
    getProjects: () => list,
  });
  let queued = 0;
  scheduler.scanRow = () => {
    queued += 1;
  };
  const t = Date.now();
  for (const p of list) scheduler.enqueueDue(p, t);
  for (const p of list) scheduler.enqueueDue(p, t + 31_000);

  // The LAST few passes are the settled figure: the first writes the tier book for the whole fleet, and the two
  // after it carry the file system's own cost for that write (a ~23 KB state file being flushed and scanned). The
  // brief's 47-163 ms baseline measured a steady state, so the comparison uses the tail and reports the warm-up
  // beside it rather than folding both into one median.
  const tail = times.slice(-Math.min(3, times.length));
  const tailSorted = tail.slice().sort((a, b) => a - b);
  return {
    label,
    root,
    projects: list.length,
    skipped,
    probed,
    tiered,
    tierRecent: tiered ? list.filter((p) => p.tier !== "old").length : null,
    tierOld: tiered ? list.filter((p) => p.tier === "old").length : null,
    passes: times.map((ms) => Math.round(ms)),
    firstMs: Math.round(times[0]),
    settledMs: Math.round(tailSorted[Math.floor(tailSorted.length / 2)]),
    minMs: Math.round(Math.min(...tail)),
    maxMs: Math.round(Math.max(...tail)),
    queuedRows: queued,
    tierGate: Boolean(tiers && typeof scheduler.tierPass === "function"),
  };
}

// ---- the promotion proof, on a real repository ---------------------------------------------------------------
function makeOldRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_DATE: nowIso(20 * DAY), GIT_COMMITTER_DATE: nowIso(20 * DAY) };
  const run = (...args) => execFileSync("git", args, { cwd: dir, env, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# old\n");
  run("add", "-A");
  run("commit", "-q", "-m", "an old commit");
}

async function provePromotion(root) {
  const { ProjectRegistry, Store, Scheduler, tiers } = await load(root);
  if (!tiers || typeof Scheduler.prototype.tierPass !== "function") return { supported: false };
  const repo = path.join(WORK, "promote", "old-repo");
  makeOldRepo(repo);
  const scanRoot = path.join(WORK, "promote");
  const dir = path.join(WORK, "promote-state");
  mkdirSync(dir, { recursive: true });
  const store = new Store();
  const registry = new ProjectRegistry({
    getConfig: () => ({ scanRoots: [scanRoot], projects: [], tierBuckets: 1, tierCheckSeconds: 1, tierDays: 7 }),
    store,
    onLog: () => {},
    cacheFile: path.join(dir, "projects.json"),
    tierFile: path.join(dir, "tiers.json"),
  });
  const list = await registry.discover();
  const project = list.find((p) => p.path.toLowerCase() === repo.replace(/\\/g, "/").toLowerCase());
  if (!project) return { supported: true, ok: false, why: "the fixture repo was not discovered" };
  const tierBefore = project.tier;
  let scanned = 0;
  const scheduler = new Scheduler({
    config: { worktreeSeconds: 5, midSeconds: 30, dormantSeconds: 30, slowSeconds: 3600, tierBuckets: 1, tierCheckSeconds: 1, tierDays: 7 },
    store,
    pool: {
      run: async ({ wtPath }) => {
        scanned += 1;
        return { path: wtPath, name: "old-repo", branch: "main", head: "abcdef0", ahead: 0, behind: 0, dirty: 0, untracked: 0, verdict: "NO COMMITS", lastCommit: project.activityAt };
      },
      isBusy: () => false,
      inFlight: 0,
    },
    registry,
    getProjects: () => registry.projects,
    listWorktrees: async () => [{ path: repo.replace(/\\/g, "/"), branch: "main", head: "abcdef0" }],
  });
  store.putRow(project.name, { path: repo.replace(/\\/g, "/"), branch: "main", head: "abcdef0", ahead: 0, behind: 0, dirty: 0, untracked: 0, verdict: "NO COMMITS" }, "full", { force: true });
  const t = Date.now();
  const passes = await quiet(async (lines) => {
    const first = await scheduler.tierPass(t);
    const second = await scheduler.tierPass(t + 1000);
    // Movement: the index is one of the four watched paths, and staging a file is exactly what it records.
    writeFileSync(path.join(repo, "touched.txt"), "touched\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    const moved = await scheduler.tierPass(t + 2000);
    const next = await scheduler.tierPass(t + 3000);
    return { first, second, moved, next, lines: lines.slice() };
  });
  const { first, second, moved, next } = passes;
  const after = registry.projects.find((p) => p.name === project.name);
  return {
    supported: true,
    ok: Boolean(project.tier === "old" && first.checked === 1 && first.promoted === 0 && moved.promoted === 1 && next.promoted === 0),
    tierBefore,
    firstPass: first,
    secondPass: second,
    movedPass: moved,
    nextPass: next,
    scannings: scanned,
    tierAfter: after?.tier || null,
    lastCommit: after?.activityAt || null,
    promotions: scheduler.stats.tierPromotions,
    log: passes.lines,
  };
}

// ---- run -----------------------------------------------------------------------------------------------------
const fixture = buildFixture();
say(
  fixture.live
    ? `fixture: LIVE roots ${fixture.roots.join(" + ")} with ${fixture.records.length} cached record(s); state in ${WORK}`
    : `fixture: ${REPOS} repo(s) + ${DIRS} non-repo dir(s) across 2 roots in ${WORK}`,
);
const after = await measure("after", AFTER_ROOT, fixture);
const before = BASE_ROOT ? await measure("before", BASE_ROOT, fixture) : null;
const promote = await provePromotion(AFTER_ROOT);

const report = {
  measuredAt: new Date().toISOString(),
  fixture: { repos: fixture.live ? fixture.records.length : REPOS, dirs: fixture.live ? null : DIRS, roots: fixture.roots, live: Boolean(fixture.live) },
  before,
  after,
  promote,
};
if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (r) =>
    `${r.label.padEnd(7)} ${String(r.projects).padStart(4)} projects  ${String(r.skipped).padStart(3)} skipped  ${String(r.probed).padStart(2)} probed  ` +
    `settled ${r.settledMs} ms (${r.minMs}-${r.maxMs}; first pass ${r.firstMs})  ${r.queuedRows} row scans queued` +
    (r.tiered ? `  ${r.tierRecent} recent / ${r.tierOld} old` : "  (no tier field)");
  console.log("");
  if (before) console.log(line(before));
  console.log(line(after));
  if (before) {
    const delta = before.settledMs - after.settledMs;
    const sign = delta >= 0 ? "-" : "+";
    const pct = before.settledMs ? Math.abs(Math.round((delta / before.settledMs) * 100)) : 0;
    console.log(`\nsettled discovery: ${before.settledMs} ms -> ${after.settledMs} ms (${sign}${pct}%)`);
    console.log(`settled row scans: ${before.queuedRows} -> ${after.queuedRows} (${before.queuedRows ? Math.round(((before.queuedRows - after.queuedRows) / before.queuedRows) * 100) : 0}% fewer)`);
  }
  if (promote.supported) {
    console.log(
      `\npromotion: ${promote.tierBefore} on discovery; first check recorded a baseline (checked ${promote.firstPass.checked}, promoted ${promote.firstPass.promoted}); ` +
        `after staging a file the NEXT check promoted ${promote.movedPass.promoted} (${promote.scannings} row scan, ${promote.promotions} promotion) and the check after it promoted ${promote.nextPass.promoted}; ` +
        `tier after ${promote.tierAfter}`,
    );
    console.log(promote.ok ? "promotion proof: PASS - a touched old repo promotes within ONE pass" : "promotion proof: FAIL");
  } else {
    console.log("\npromotion: not supported by this tree (no lib/tiers.js or tierPass) - expected for a base export");
  }
}
if (!KEEP && !arg("work", null)) rmSync(WORK, { recursive: true, force: true });
else say(`\nkept: ${WORK}`);
process.exitCode = promote.supported && !promote.ok ? 1 : 0;
