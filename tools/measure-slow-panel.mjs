#!/usr/bin/env node
// What a slow panel costs its two background passes, measured rather than guessed.
//
// The row this answers: "project discovery runs 5.8 s across 177 projects" and "the static bundle scan misses its
// 1200 ms budget every 20 to 30 seconds". Both passes are chains of awaits on the panel's OWN event loop, so neither
// number is about the work they do - at idle the same walk is tens of milliseconds and the same scan is under 35. So
// this harness measures the two things that decide the wall clock:
//
//   the WORK   - a discovery pass over the real roots, with lib/projects.js's own phase breakdown (readdir, the
//                seq of stats, the per-project row scan, the store write), and a bundle read plus the same stat of
//                every file it hashed;
//   the LOOP   - an event-loop lag sampler running beside both, idle and under a load generator that reproduces the
//                panel's steady state: `threads` concurrent `git status` reads across the board's repos.
//
// It also reads the panel's own log, which is the production evidence: the discovery totals it printed and the
// cadence of the bundle scan's deadline misses. Nothing here writes into the checkout: the discovery cache is
// copied into a scratch folder and the tier book lives there too.
//
//   node tools/measure-slow-panel.mjs [--roots "C:/a;C:/b"] [--cache <projects.json>] [--public <dir>]
//                                     [--log <server.out.log>] [--workers 2] [--repeats 4]
//                                     [--loaded-passes 2] [--max-pass-ms 180000] [--json] [--keep]
//
// Defaults come from this panel's own config.json and state folder, so a plain run measures the board the reader is
// looking at. Point --roots/--cache at another machine's copy and the same harness measures that one.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBuild, readBundle } from "../lib/build-version.js";
import { ProjectRegistry } from "../lib/projects.js";
import { Store } from "../lib/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HOME = process.env.WAG_HOME ? path.resolve(process.env.WAG_HOME) : path.join(os.homedir(), ".wag");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const configFile = path.join(ROOT, "config.json");
// A worktree has no config.json of its own (the file is the reader's, not the repo's): the panel's settings live in
// the primary checkout, two folders up. Fall back to it so a run from a worktree measures the board it is part of.
const primaryConfigFile = path.resolve(ROOT, "..", "..", "config.json");
const panelConfig = (() => {
  for (const file of [configFile, primaryConfigFile]) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* no config here: try the next place, and let an empty list mean "pass --roots" */
    }
  }
  return {};
})();

const ROOTS = String(arg("roots", (panelConfig.scanRoots || []).join(";")))
  .split(/[;,]/)
  .map((s) => s.trim())
  .filter(Boolean);
const CACHE = path.resolve(String(arg("cache", path.join(HOME, "state", "projects.json"))));
const PUBLIC_DIR = path.resolve(String(arg("public", path.join(ROOT, "public"))));
const LOG = path.resolve(String(arg("log", path.join(HOME, "logs", "server.out.log"))));
const WORKERS = Math.max(1, Number(arg("workers", 2)) || 2);
const REPEATS = Math.max(1, Number(arg("repeats", 4)) || 4);
const LOADED_PASSES = Math.max(1, Number(arg("loaded-passes", 2)) || 2);
const MAX_PASS_MS = Math.max(10_000, Number(arg("max-pass-ms", 180_000)) || 180_000);
const JSON_OUT = flag("json");
const KEEP = flag("keep");
const ONLY = String(arg("only", "all")).toLowerCase();
const WORK = arg("work", null) ? path.resolve(String(arg("work"))) : mkdtempSync(path.join(os.tmpdir(), "wag-slow-panel-"));
mkdirSync(WORK, { recursive: true });

const round = (n) => Math.round(n * 10) / 10;
const say = (...a) => {
  if (!JSON_OUT) console.log(...a);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the loop, measured -----------------------------------------------------------------------------------
// A sampler, not a profiler: it asks for a 10 ms timer and records how late each one was. That lateness IS the cost
// of a turn of the loop, and every await in the two passes pays it once.
function lagSampler() {
  const lags = [];
  let expected = performance.now() + 10;
  let timer = null;
  let stopped = false;
  const tick = () => {
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + 10;
    if (!stopped) timer = setTimeout(tick, 10);
  };
  timer = setTimeout(tick, 10);
  return () => {
    stopped = true;
    clearTimeout(timer);
    lags.sort((a, b) => a - b);
    const q = (p) => (lags.length ? lags[Math.min(lags.length - 1, Math.floor(lags.length * p))] : 0);
    return { samples: lags.length, p50: round(q(0.5)), p95: round(q(0.95)), max: round(lags[lags.length - 1] || 0) };
  };
}

// ---- the load the panel puts on its own loop --------------------------------------------------------------
// `threads` concurrent `git -C <repo> status` reads, each one starting straight after the last finishes, is the
// shape of the scan pool: three child processes, their stdout parsed, a row written and an SSE event emitted before
// the next one starts. The pause between a result and the next spawn is the loop work this harness leaves to the
// process under test.
function startLoad(repos) {
  let stop = false;
  let spawns = 0;
  const one = (repo) =>
    new Promise((resolve) => {
      execFile(
        "git",
        ["-C", repo, "status", "--porcelain=v2", "--branch"],
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        () => {
          spawns += 1;
          resolve();
        },
      );
    });
  const loops = [];
  for (let i = 0; i < WORKERS; i += 1) {
    loops.push(
      (async () => {
        let n = i;
        while (!stop) {
          await one(repos[n % repos.length]);
          n += WORKERS;
          await sleep(15);
        }
      })(),
    );
  }
  return {
    spawns: () => spawns,
    stop: async () => {
      stop = true;
      await Promise.all(loops);
    },
  };
}

// The repos the load generator reads: the board's own records, so the load is spread over the same projects a real
// pass walks. Read from the work copy when discovery made one, else straight from the panel's cache.
function loadRepos() {
  for (const file of [path.join(WORK, "projects.json"), CACHE]) {
    try {
      return (JSON.parse(readFileSync(file, "utf8")).projects || []).map((p) => p.path).filter((p) => p && existsSync(p));
    } catch {
      /* try the next place */
    }
  }
  return [];
}

// ---- 1. the discovery walk ---------------------------------------------------------------------------------
async function measureDiscovery() {
  if (!ROOTS.length) {
    say("  no scan roots: pass --roots \"C:/a;C:/b\" (this tree has no config.json and the primary checkout names none)");
    return { roots: [], idle: [], loaded: [] };
  }
  const registryCache = path.join(WORK, "projects.json");
  if (existsSync(CACHE)) copyFileSync(CACHE, registryCache);
  else say(`  no discovery cache at ${CACHE} - every repo is probed on the first pass`);
  const known = (() => {
    try {
      return JSON.parse(readFileSync(registryCache, "utf8")).projects || [];
    } catch {
      return [];
    }
  })();
  const cfg = {
    scanRoots: ROOTS,
    projects: [],
    discovery: panelConfig.discovery || { worktreeSource: "git" },
    tierDays: panelConfig.tierDays,
    tierBuckets: panelConfig.tierBuckets,
    tierCheckSeconds: panelConfig.tierCheckSeconds,
  };
  const store = new Store();
  // The panel's store holds one row per worktree, not per project. Three per project is the board's own shape
  // (the project folder, its main tree and a child tree), and it is what makes `activityFromRows` do its real work.
  for (const p of known) {
    for (let i = 0; i < 3; i += 1) {
      store.rows.set(`${p.name}::${p.path}#${i}`, { path: `${p.path}#${i}`, lastCommit: p.activityAt, lastAliveAt: p.activityAt });
    }
  }
  const registry = new ProjectRegistry({
    getConfig: () => cfg,
    store,
    cacheFile: registryCache,
    tierFile: path.join(WORK, "tiers.json"),
    onLog: () => {},
  });
  say(`  ${registry.list.length} known project(s), ${store.rows.size} row(s), roots ${ROOTS.join(", ")}`);

  const pass = async (label) => {
    const stopLag = lagSampler();
    const t0 = performance.now();
    await registry.discover();
    const wall = round(performance.now() - t0);
    const lag = stopLag();
    const p = registry.lastPass || {};
    const out = { label, wallMs: wall, ...p, lag };
    say(
      `  ${label.padEnd(10)} ${String(wall).padStart(7)} ms | stat ${String(p.statMs).padStart(8)} | readdir ${String(p.readdirMs).padStart(5)} | ` +
        `rows ${String(p.rowsMs).padStart(6)} | save ${String(p.saveMs).padStart(5)} | loop lag p50 ${lag.p50} p95 ${lag.p95} max ${lag.max} ms`,
    );
    return out;
  };

  const idle = [];
  for (let i = 0; i < REPEATS; i += 1) idle.push(await pass(`idle-${i + 1}`));

  const repos = known.map((p) => p.path).filter((p) => p && existsSync(p));
  const loaded = [];
  let load = null;
  let spawns = 0;
  if (repos.length) {
    say(`  loading the loop: ${WORKERS} concurrent git reads over ${repos.length} repo(s)`);
    load = startLoad(repos);
    await sleep(1500);
    for (let i = 0; i < LOADED_PASSES; i += 1) {
      const one = await pass(`loaded-${i + 1}`);
      loaded.push(one);
      if (one.wallMs > MAX_PASS_MS) {
        say(`  a loaded pass took ${one.wallMs} ms, past --max-pass-ms ${MAX_PASS_MS}: stopping the loaded passes here`);
        break;
      }
    }
    await load.stop();
    spawns = load.spawns();
  } else {
    say("  no repo on disk to load the loop with - the loaded half is empty");
  }
  return { roots: ROOTS, known: registry.list.length, rows: store.rows.size, idle, loaded, workers: WORKERS, spawns };
}

// ---- 2. the static bundle scan -----------------------------------------------------------------------------
async function measureBundle() {
  // The scan's own work, on its own: the read every file (readBundle is the function scanBundle calls) plus the
  // same stat of every hashed file and of core/, which is the second half of scanBundle.
  const oneScan = async () => {
    const t0 = performance.now();
    const bundle = await readBundle(PUBLIC_DIR);
    const readMs = performance.now() - t0;
    const t1 = performance.now();
    for (const rel of Object.keys(bundle.files)) await stat(path.join(PUBLIC_DIR, rel)).catch(() => null);
    await stat(path.join(PUBLIC_DIR, "core")).catch(() => null);
    const stampsMs = performance.now() - t1;
    return { files: Object.keys(bundle.files).length, readMs: round(readMs), stampsMs: round(stampsMs), totalMs: round(performance.now() - t0) };
  };

  const idle = [];
  for (let i = 0; i < 5; i += 1) idle.push(await oneScan());

  // The scan as the module runs it, deadline included: one refresh() is one scan attempt. A miss is the module's
  // own log line, not a re-derivation from the clock.
  const said = [];
  const build = createBuild({ publicDir: PUBLIC_DIR, log: (line) => said.push(line) });
  await build.current();
  const refreshResults = [];
  for (let i = 0; i < 5; i += 1) {
    const before = said.length;
    const t0 = performance.now();
    await build.refresh();
    refreshResults.push({ wallMs: round(performance.now() - t0), missed: said.slice(before).some((l) => /did not answer within/.test(l)) });
  }
  build.close();

  const loaded = { scans: [], refreshes: [], loop: null };
  const repos = loadRepos();
  if (repos.length) {
    const load = startLoad(repos);
    await sleep(1500);
    const stopLag = lagSampler();
    for (let i = 0; i < 4; i += 1) loaded.scans.push(await oneScan());
    const said2 = [];
    const build2 = createBuild({ publicDir: PUBLIC_DIR, log: (line) => said2.push(line) });
    await build2.current();
    // One attempt every two seconds for half a minute. The module's own cool-off decides which of those attempts
    // really scans and which answer from the held bundle at once, so the gaps between MISSES are the cadence the
    // panel's log prints - and the scan's own work stays in the tens of milliseconds while the loop is what is slow.
    const startedAt = performance.now();
    for (let i = 0; i < 15; i += 1) {
      const before = said2.length;
      const t0 = performance.now();
      await build2.refresh();
      loaded.refreshes.push({
        at: round((t0 - startedAt) / 1000),
        wallMs: round(performance.now() - t0),
        missed: said2.slice(before).some((l) => /did not answer within/.test(l)),
      });
      await sleep(2000);
    }
    build2.close();
    loaded.loop = stopLag();
    await load.stop();
    loaded.spawns = load.spawns();
  }
  const misses = loaded.refreshes.filter((r) => r.missed);
  say(`  scan at idle: ${idle.map((s) => s.totalMs).join(", ")} ms over ${idle[0].files} file(s)`);
  say(`  refreshes at idle: ${refreshResults.map((r) => `${r.wallMs}${r.missed ? " MISS" : ""}`).join(", ")} ms`);
  if (loaded.scans.length) {
    say(`  scan under load: ${loaded.scans.map((s) => s.totalMs).join(", ")} ms | loop lag p50 ${loaded.loop.p50} p95 ${loaded.loop.p95} max ${loaded.loop.max} ms`);
    const gaps = [];
    for (let i = 1; i < misses.length; i += 1) gaps.push(round(misses[i].at - misses[i - 1].at));
    say(
      `  refreshes under load: ${loaded.refreshes.length} attempts over ${round(loaded.refreshes[loaded.refreshes.length - 1].at)} s, ` +
        `${misses.length} missed the 1200 ms deadline${gaps.length ? `, ${gaps.join("/")} s apart` : ""} | ${loaded.spawns} git spawns`,
    );
  }
  return { publicDir: PUBLIC_DIR, idle, refreshResults, loaded, misses: misses.length };
}

// ---- 3. the panel's own log ---------------------------------------------------------------------------------
function measureLog() {
  if (!existsSync(LOG)) {
    say(`  no panel log at ${LOG} - nothing to read`);
    return null;
  }
  const lines = readFileSync(LOG, "utf8").split(/\r?\n/);
  const discoveries = [];
  const misses = [];
  for (const line of lines) {
    const m = /^(\d\d:\d\d:\d\d) projects: (\d+) .*discovery (\d+)ms/.exec(line);
    if (m) discoveries.push({ at: m[1], projects: Number(m[2]), ms: Number(m[3]) });
    const s = /^(\d\d:\d\d:\d\d) the static bundle scan did not answer within 1200 ms/.exec(line);
    if (s) misses.push(s[1]);
  }
  const secs = (hms) => {
    const [h, m, s] = hms.split(":").map(Number);
    return h * 3600 + m * 60 + s;
  };
  const gaps = [];
  for (let i = 1; i < misses.length; i += 1) {
    const gap = secs(misses[i]) - secs(misses[i - 1]);
    if (gap >= 0 && gap < 300) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const q = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : 0);
  const totals = discoveries.map((d) => d.ms).sort((a, b) => a - b);
  const under = totals.filter((n) => n <= 250).length;
  if (discoveries.length) {
    say(
      `  discovery passes in the log: ${discoveries.length} | min ${totals[0]} ms, median ${totals[Math.floor(totals.length / 2)]} ms, ` +
        `max ${totals[totals.length - 1]} ms | ${under} at or under 250 ms, ${totals.length - under} slow | newest ${discoveries[discoveries.length - 1].at} ${discoveries[discoveries.length - 1].ms} ms`,
    );
  }
  if (misses.length) {
    say(`  bundle scan misses: ${misses.length} | gap between attempts median ${q(0.5)} s, p95 ${q(0.95)} s, min ${gaps[0]} s, max ${gaps[gaps.length - 1]} s`);
  }
  return { log: LOG, discoveries, misses, gapSeconds: { median: q(0.5), p95: q(0.95), min: gaps[0] ?? null, max: gaps[gaps.length - 1] ?? null } };
}

// ---- run ---------------------------------------------------------------------------------------------------
if (!JSON_OUT) {
  console.log(`measure-slow-panel - ${new Date().toISOString()} - ${os.cpus().length} cpu(s), ${round(os.freemem() / 1e9)} GB free`);
  console.log(`  work ${WORK}${KEEP ? " (kept)" : ""}`);
}
say("\n1. discovery - the walk the board runs to find its projects");
const discovery = ONLY === "bundle" || ONLY === "log" ? { skipped: true } : await measureDiscovery();
say("\n2. the static bundle scan - the read every static request is versioned from");
const bundle = ONLY === "discovery" || ONLY === "log" ? { skipped: true } : await measureBundle();
say("\n3. the panel's own log - the production evidence");
const log = ONLY === "discovery" || ONLY === "bundle" ? { skipped: true } : measureLog();

if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), discovery, bundle, log }, null, 2));
}
if (!KEEP) {
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* a scratch folder that will not go is not a failed measurement */
  }
}
