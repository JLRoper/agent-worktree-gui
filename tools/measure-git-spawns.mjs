#!/usr/bin/env node
// How many git processes does the panel START, over a fixed window, against the real fleet?
//
// The unit is a PROCESS CREATION, not a concurrency sample: every counted event is one `git.exe` the
// panel asked the OS to start (tools/git-spawn-counter.cjs appends a line at the moment of the spawn,
// from the main thread and from every scan worker). A sample of how many git.exe are alive at an
// instant cannot answer this question - it reads high during a burst and zero a second later - which is
// why this harness counts creations.
//
// Three paths are measured separately, because they are three different questions:
//
//   discovery  lib/projects.js `discover()` - the pass that decides which repositories exist. A known
//              record must be reused, so this should cost no git at all once the cache is warm.
//   refresh    lib/scheduler.js `fullPass()` - the pass behind boot, the Refresh/Fetch buttons and the
//              slow clock. This is the one that re-reads every project.
//   stat       the hourly gate, one `tierPass()` per slice of the hour (buckets x slices), which is
//              four `stat(2)` calls per repo and must never start git.
//
// The base tree is measured with `--root` pointing at an export of the commit before the change, so
// both numbers come from the same harness, the same seeded cache and the same machine:
//
//   mkdir -p <work>/base && git archive <base-sha> | tar -x -C <work>/base
//   node tools/measure-git-spawns.mjs --root <work>/base --label before --work <work>
//   node tools/measure-git-spawns.mjs --label after --work <work>
//
// A run against the whole fleet is minutes per pass. For a bounded comparison, hand it a cache holding
// the fixed fleet (`--cache`), cap the count (`--limit`) and read those records in place as configured
// projects (`--explicit`), with `--roots` pointing at an empty directory so nothing else is walked:
//
//   node tools/measure-git-spawns.mjs --cache <work>/fleet.json --limit 10 --explicit --roots <work>/none ...
//
// The cache it seeds from is the panel's own `projects.json` (`--cache`), copied into `--work` so a run
// never writes the board's state. Nothing here boots a server or binds a port: it drives the same
// modules the scheduler drives, in this process.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const COUNTER = path.join(HERE, "git-spawn-counter.cjs");
const DAY = 864e5;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// The first thing this process does is re-exec itself WITH the counter preloaded, so the counter is in
// place before any of the panel's modules are imported and before a worker thread exists.
if (!process.env.WAG_GIT_COUNT_LOG) {
  const work = path.resolve(String(arg("work", "") || mkdtempSync(path.join(os.tmpdir(), "wag-spawns-"))));
  mkdirSync(work, { recursive: true });
  const log = path.join(work, `git-spawns-${String(arg("label", "run"))}-${process.pid}.log`);
  const child = spawnSync(
    process.execPath,
    ["--require", COUNTER, SELF, ...process.argv.slice(2), "--work", work, "--log", log],
    { stdio: "inherit", env: { ...process.env, WAG_GIT_COUNT_LOG: log, WAG_PHASE: "boot" } },
  );
  process.exit(child.status === null ? 1 : child.status);
}

const ROOT = path.resolve(String(arg("root", path.resolve(HERE, ".."))));
const LABEL = String(arg("label", path.basename(ROOT)));
const WORK = path.resolve(String(arg("work")));
const LOG = process.env.WAG_GIT_COUNT_LOG;
const CACHE_SRC = path.resolve(String(arg("cache", path.join(os.homedir(), ".wag", "state", "projects.json"))));
const ROOTS = String(arg("roots", "C:/ProjectDevelopment,C:/CodeReviews"))
  .split(/[;,]/)
  .map((s) => s.trim())
  .filter(Boolean);
const TICKS = Math.max(0, Number(arg("ticks", 20)) || 20);
const TICK_MS = Math.max(0, Number(arg("tickMs", 1000)) || 1000);
const DRAIN_MS = Math.max(1000, Number(arg("drainMs", 180000)) || 180000);
const LIMIT = Math.max(0, Number(arg("limit", 0)) || 0);
// `--explicit` reads the seeded records as CONFIGURED projects: each is driven in place at its own real
// path, and the roots have nothing to walk. It is what makes a run BOUNDED - `--limit` alone only slices
// the cache by recency, because a roots walk still probes every repo of this machine that the slice does
// not mention. A project read through a junction is dropped as "outside its root" and never scans a row,
// which would measure a fleet that costs less than the real one for the wrong reason.
const EXPLICIT = flag("explicit");
// `--phases discovery,refresh,stat` runs only the named paths (a smoke run wants discovery alone, which
// is seconds, while a full refresh over a real fleet is minutes). Default: every path.
const ONLY = String(arg("phases", ""))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const wants = (name) => !ONLY.length || ONLY.includes(name);
const JSON_OUT = flag("json");

const say = (...a) => {
  if (!JSON_OUT) console.log(...a);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the counted log ----------------------------------------------------------------------------------------
// One line per spawn. A phase's count is the difference between the line count at its start and at its end,
// which is why every phase drains the pool before it closes: a scan still in flight would otherwise be
// charged to the next phase.
function lineCount() {
  try {
    const text = readFileSync(LOG, "utf8");
    let n = 0;
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
    return n;
  } catch {
    return 0;
  }
}

function entries(fromLine) {
  let lines = [];
  try {
    lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return lines
    .slice(fromLine)
    .map((line) => {
      const [at, pid, phase, caller, rest] = line.split("\t");
      return { at: Number(at) || 0, pid, phase, caller: caller || "unknown", args: rest || "" };
    });
}

const phases = [];
async function phase(name, fn) {
  const start = lineCount();
  const t0 = Date.now();
  process.env.WAG_PHASE = name;
  const out = await fn();
  const rows = entries(start);
  const record = {
    phase: name,
    git: rows.length,
    ms: Date.now() - t0,
    callers: topCallers(rows),
    repos: out && typeof out === "object" ? out : null,
  };
  phases.push(record);
  say(`  ${name.padEnd(11)} ${String(record.git).padStart(5)} git  ${String(record.ms).padStart(7)} ms`);
  return record;
}

function topCallers(rows) {
  const by = new Map();
  for (const row of rows) by.set(row.caller, (by.get(row.caller) || 0) + 1);
  return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([caller, n]) => ({ caller, n }));
}

// ---- the fixture: this machine's own fleet ------------------------------------------------------------------
if (!existsSync(CACHE_SRC)) {
  console.error(`no projects cache at ${CACHE_SRC} - pass --cache <projects.json>`);
  process.exit(2);
}
const seedFile = path.join(WORK, `${LABEL}-projects.json`);
const seed = JSON.parse(readFileSync(CACHE_SRC, "utf8"));
let records = Array.isArray(seed.projects) ? seed.projects : [];
if (LIMIT && records.length > LIMIT) records = records.slice(0, LIMIT);
// A run gets its own cache and its own tier book: two labels must not read each other's state.
writeFileSync(seedFile, JSON.stringify({ savedAt: new Date().toISOString(), projects: records }, null, 0));
const tierFile = path.join(WORK, `${LABEL}-tiers.json`);

const now = Date.now();
const old = records.filter((p) => !(now - Date.parse(p.activityAt || "") <= 7 * DAY)).length;

// ---- load the tree under test ------------------------------------------------------------------------------
const mod = (rel) => import(pathToFileURL(path.join(ROOT, "lib", rel)).href);
const [{ ProjectRegistry }, { Store }, { Scheduler }, { Pool }] = await Promise.all([
  mod("projects.js"),
  mod("store.js"),
  mod("scheduler.js"),
  mod("pool.js"),
]);

const config = {
  scanRoots: ROOTS,
  // `--explicit` hands the registry the RECORD it seeded, not just a name and a path. A configured project
  // outside every root is never probed, so a record stripped to {name, path} carries no commit date, every
  // repo in the sample classifies as old, and the run measures a fleet that has no recent tier at all.
  projects: EXPLICIT ? records.map((p) => ({ ...p })) : [],
  scanMode: "all",
  worktreeSeconds: 5,
  midSeconds: 30,
  dormantSeconds: 30,
  slowSeconds: 300,
  liveSeconds: 5,
  liveMinutes: 5,
  tierDays: 7,
  tierBuckets: 60,
  tierCheckSeconds: 60,
  fetchSeconds: 600,
  remoteCacheSeconds: 300,
  prCacheSeconds: 300,
  fullPassConcurrency: 2,
  threads: 4,
  // The harness never wants the board frozen on a visibility report: it reads the whole fleet, which is
  // the expensive case being measured.
  fetchConcurrency: 4,
};

const store = new Store();
const registry = new ProjectRegistry({
  getConfig: () => config,
  store,
  onLog: () => {},
  cacheFile: seedFile,
  tierFile,
});
const pool = new Pool(Math.max(1, Number(config.threads) || 4));
const scheduler = new Scheduler({
  config,
  store,
  pool,
  registry,
  getProjects: () => registry.projects,
});

async function drain() {
  const until = Date.now() + DRAIN_MS;
  while (Date.now() < until) {
    if (!pool.inFlight && (!pool.queue || pool.queue.length === 0) && scheduler.projectRunning.size === 0) return true;
    await sleep(100);
  }
  return false;
}

say(`measure: ${LABEL}  root ${ROOT}`);
say(`fleet:   ${records.length} cached project(s), ${old} older than ${config.tierDays} days, ${records.length - old} recent`);
say(`state:   ${WORK}`);
say("");

let discovery = null;
let refresh = null;
let stat = null;

await phase("seed", async () => {
  // One discovery pass is what a boot does first. It is measured on its own below; this one only fills
  // the registry so the later phases have a project list.
  await registry.discover();
  return { projects: registry.projects.length };
});

if (wants("discovery")) {
  discovery = await phase("discovery", async () => {
    const list = await registry.discover();
    return { projects: list.length, old: list.filter((p) => p.tier === "old").length, recent: list.filter((p) => p.tier !== "old").length };
  });
}

let mapped = null;
if (wants("map") || wants("refresh") || wants("ticks") || wants("stat")) {
  mapped = await phase("map", async () => {
    // The first full pass of a cold process: the store is empty, so this is the pass that CREATES the rows.
    await scheduler.fullPass({ rows: true });
    await drain();
    const rows = registry.projects.reduce((n, p) => n + store.rowsFor(p.name).length, 0);
    return { rows };
  });
}

if (wants("refresh")) {
  refresh = await phase("refresh", async () => {
    // The steady-state refresh: every project already has its rows, and this is the pass the panel runs
    // on the slow clock and behind its own Refresh button.
    await scheduler.fullPass({ rows: true });
    await drain();
    const rows = registry.projects.reduce((n, p) => n + store.rowsFor(p.name).length, 0);
    return { rows };
  });
}

if (wants("ticks")) {
  await phase("ticks", async () => {
    for (let i = 0; i < TICKS; i += 1) {
      await scheduler.tick();
      await sleep(TICK_MS);
      await drain();
    }
    return { ticks: TICKS, tierChecks: scheduler.stats.tierChecks, tierPromotions: scheduler.stats.tierPromotions };
  });
}

if (wants("stat")) {
  stat = await phase("stat", async () => {
    // A whole hour of the gate, slice by slice: `tierBuckets` slices cover every bucket exactly once. This
    // is the check the tier exists for, and it must cost zero git.
    const buckets = registry.tiers.buckets;
    const every = Math.max(1, config.tierCheckSeconds) * 1000;
    const t = Date.now() + every;
    let checked = 0;
    let promoted = 0;
    for (let i = 0; i < buckets; i += 1) {
      const out = await scheduler.tierPass(t + i * every);
      checked += out.checked || 0;
      promoted += out.promoted || 0;
    }
    return { slices: buckets, checked, promoted };
  });
}

await pool.close?.();
process.env.WAG_PHASE = "idle";

const total = lineCount();
const report = {
  measuredAt: new Date().toISOString(),
  label: LABEL,
  root: ROOT,
  fleet: { projects: records.length, old, recent: records.length - old, roots: ROOTS },
  phases,
  totalGit: total,
  refreshGit: refresh?.git ?? null,
  discoveryGit: discovery?.git ?? null,
  statGit: stat?.git ?? null,
  mapGit: mapped?.git ?? null,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("");
  console.log(`${LABEL}: discovery ${report.discoveryGit} git | refresh ${report.refreshGit} git | stat ${report.statGit} git | first map ${report.mapGit} git`);
  const top = (refresh?.callers || []).slice(0, 6);
  if (top.length) console.log(`refresh spawned from: ${top.map((c) => `${c.caller} x${c.n}`).join(", ")}`);
}

// A worker that outlives the run would keep writing to the log and hold git processes open.
process.exit(0);
