#!/usr/bin/env node
// tools/measure-tier-signal.mjs — what each promotion detector costs on this machine's fleet, and what it
// misses. The gate in lib/tiers.js answers "did this repo move since the last read?" without running git;
// this tool is how the detector it uses was chosen, and how the next one is argued for.
//
// WHY A HARNESS AND NOT A PARAGRAPH: the candidates differ by three orders of magnitude in cost and by a
// third of the fleet in hit rate, and both numbers move with the host and with what is checked out on it.
// A claim like "the walk is cheap enough" is only worth reading next to the run that produced it.
//
//   node tools/measure-tier-signal.mjs                     the panel's own projects cache, 2 passes, 12 git samples
//   node tools/measure-tier-signal.mjs --cache <file>      a specific projects.json
//   node tools/measure-tier-signal.mjs --roots "a;b"       walk one level under each root instead of a cache
//   node tools/measure-tier-signal.mjs --json out.json     keep the per-repo record
//   node tools/measure-tier-signal.mjs --fixtures <dir>    where to build the event matrix (default: a temp dir)
//
// READ-ONLY, apart from the fixture repos it creates under --fixtures: it stats and walks the fleet, and runs
// `git status` / `git log -1` per repo as the ground truth. Nothing in the scanned projects is written.
//
// The columns are:
//   before      the four `.git` stats the gate used to read (`.git/HEAD`, `.git/index`, `.git/refs/heads`,
//               `.git/logs/HEAD`) — the detector this landing replaces
//   index+HEAD  the two-stat hint `docs/perf/tier-detection-2026-11-07.md` measured
//   depth 1/3   a bounded mtime pass, as the same document measured
//   walk        the unbounded worktree walk with the heavy directories pruned
//   walk+wt     that walk, plus the mtime of each entry under `.worktrees` (not its tree)
//   shipped     `statSignal()` from lib/tiers.js — the walk plus the narrow git watch set
//
// Hit rate is measured on the fleet's DIRTY repos: for each one, the newest uncommitted path is the change
// the gate has to notice, and a detector hits when it watches something at least that new. A bounded pass
// hits only when that change sits inside its bound (an edit does not move its parent directory's mtime).

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, lstatSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolveDirs, statePaths } from "../lib/paths.js";
import { statSignal, TIER_PRUNE } from "../lib/tiers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1] || "") : dflt;
};
const PASSES = Math.max(1, Number(flag("passes", 2)) || 2);
const SAMPLE = Math.max(1, Number(flag("sample", 12)) || 12);
const JSON_OUT = flag("json");

// ---------- the fleet ----------
function fleet() {
  const roots = flag("roots");
  if (roots) {
    const out = [];
    for (const root of roots.split(";").map((s) => s.trim()).filter(Boolean)) {
      let entries = [];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = path.join(root, e.name).replace(/\\/g, "/");
        if (existsSync(path.join(p, ".git"))) out.push(p);
      }
    }
    return out;
  }
  const cache = flag("cache") || statePaths(resolveDirs({ env: process.env, home: os_home() })).projectsCacheFile;
  const saved = JSON.parse(readFileSync(cache, "utf8"));
  return (saved.projects || []).map((p) => String(p.path).replace(/\\/g, "/")).filter((p) => existsSync(path.join(p, ".git")));
}
function os_home() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

const REPOS = fleet();
if (!REPOS.length) {
  console.error("measure-tier-signal: no repositories found — name a --cache or --roots");
  process.exit(2);
}

// ---------- the detectors under comparison ----------
const mtimeOf = (p) => {
  try {
    return lstatSync(p).mtimeMs || 0;
  } catch {
    return 0;
  }
};

function statsOf(repo, rels) {
  let newest = 0;
  for (const rel of rels) newest = Math.max(newest, mtimeOf(path.join(repo, rel)));
  return newest;
}

function depthPass(repo, bound) {
  let newest = 0;
  const go = (dir, d) => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (TIER_PRUNE.has(e.name)) continue; // same prunes as the walk: the difference is the BOUND, not `.git`
      const p = path.join(dir, e.name);
      newest = Math.max(newest, mtimeOf(p));
      if (d < bound && e.isDirectory()) go(p, d + 1);
    }
  };
  go(repo, 1);
  return newest;
}

function walk(repo, { worktrees = "children" } = {}) {
  let newest = 0;
  const stack = [repo];
  while (stack.length) {
    const dir = stack.pop();
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.name === ".worktrees") {
        if (worktrees === "skip") continue;
        if (worktrees === "walk") {
          newest = Math.max(newest, mtimeOf(p));
          stack.push(p);
          continue;
        }
        let kids = [];
        try {
          kids = readdirSync(p, { withFileTypes: true });
        } catch {}
        for (const kid of kids) newest = Math.max(newest, mtimeOf(path.join(p, kid.name)));
        continue;
      }
      if (TIER_PRUNE.has(e.name)) continue;
      newest = Math.max(newest, mtimeOf(p));
      if (e.isDirectory()) stack.push(p);
    }
  }
  return newest;
}

const DETECTORS = {
  before: (r) => statsOf(r, [".git/HEAD", ".git/index", ".git/refs/heads", ".git/logs/HEAD"]),
  "index+HEAD": (r) => statsOf(r, [".git/index", ".git/HEAD"]),
  "depth 1": (r) => depthPass(r, 1),
  "depth 3": (r) => depthPass(r, 3),
  walk: (r) => walk(r, { worktrees: "skip" }),
  "walk+wt": (r) => walk(r, { worktrees: "children" }),
};

// ---------- ground truth, four git processes at a time ----------
const run = (repo, args) =>
  new Promise((resolve) => {
    execFile("git", ["-C", repo, ...args], { timeout: 120000, maxBuffer: 128 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (stderr && /tty|terminal prompts|askpass/i.test(String(stderr))) {
        console.log(`\n  ! ${path.basename(repo)} ${args[0]}: ${String(stderr).trim().split("\n")[0].slice(0, 160)}`);
      }
      resolve(err ? null : String(stdout));
    });
  });

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// ---------- cost ----------
const timing = {};
for (const [name, fn] of Object.entries(DETECTORS)) {
  let best = Infinity;
  let bestRun = null;
  for (let pass = 0; pass < PASSES; pass += 1) {
    const t0 = performance.now();
    const vals = REPOS.map(fn);
    const total = performance.now() - t0;
    if (total < best) {
      best = total;
      bestRun = vals;
    }
  }
  timing[name] = { totalMs: Math.round(best), perRepoMs: Math.round((best / REPOS.length) * 100) / 100, values: bestRun };
}
// The shipped detector is async and reads the same things: time it the same way.
{
  let best = Infinity;
  let bestRun = null;
  for (let pass = 0; pass < PASSES; pass += 1) {
    const t0 = performance.now();
    const vals = [];
    for (const repo of REPOS) vals.push(Math.max(...Object.values(await statSignal(repo))));
    const total = performance.now() - t0;
    if (total < best) {
      best = total;
      bestRun = vals;
    }
  }
  timing.shipped = { totalMs: Math.round(best), perRepoMs: Math.round((best / REPOS.length) * 100) / 100, values: bestRun };
}

// ---------- the six or seven git calls, sampled ----------
const SHAPES = {
  "scan, fast (3 spawns)": [
    ["status", "--porcelain=v2", "--branch"],
    ["log", "-1", "--format=%cI"],
    ["rev-list", "--left-right", "--count", "origin/main...HEAD"],
  ],
  "scan, full (7 spawns)": [
    ["status", "--porcelain=v2", "--branch"],
    ["log", "-1", "--format=%cI"],
    ["rev-list", "--left-right", "--count", "origin/main...HEAD"],
    ["merge-base", "--is-ancestor", "origin/main", "HEAD"],
    ["cherry", "HEAD", "origin/main"],
    ["reflog", "--format=%ct", "-5"],
    ["diff", "--stat"],
  ],
};
const gitTiming = {};
const sample = REPOS.filter((_, i) => i % Math.max(1, Math.floor(REPOS.length / SAMPLE)) === 0).slice(0, SAMPLE);
for (const [label, groups] of Object.entries(SHAPES)) {
  const times = [];
  for (const repo of sample) {
    const t0 = performance.now();
    for (const group of groups) await Promise.all([run(repo, group)]); // the panel runs each group in parallel
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  gitTiming[label] = {
    n: times.length,
    medianMs: Math.round(times[Math.floor(times.length / 2)]),
    minMs: Math.round(times[0]),
    maxMs: Math.round(times[times.length - 1]),
  };
}

// ---------- hit rate on the dirty fleet ----------
const ground = await pool(REPOS, 4, async (repo) => {
  const out = await run(repo, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (out == null) return { repo, ok: false };
  const recs = out.split("\0");
  const changed = [];
  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[i];
    if (!r || r.length < 4) continue;
    changed.push({ xy: r.slice(0, 2), p: r.slice(3) });
    if (r[0] === "R" || r[0] === "C") i += 1; // a rename names its original on the next record
  }
  const existing = changed
    .map((c) => ({ ...c, m: mtimeOf(path.join(repo, c.p)) }))
    .filter((c) => c.m > 0);
  return { repo, ok: true, existing, deleted: changed.length - existing.length };
});

const hits = Object.fromEntries(Object.keys(timing).map((k) => [k, { n: 0, hit: 0 }]));
const dirty = [];
for (let i = 0; i < REPOS.length; i += 1) {
  const g = ground[i];
  if (!g || !g.ok || !g.existing.length) continue;
  const newest = Math.max(...g.existing.map((c) => c.m));
  const newestDepth = Math.min(...g.existing.filter((c) => c.m === newest).map((c) => c.p.split("/").length));
  dirty.push({ repo: REPOS[i], newest, newestDepth });
  for (const name of Object.keys(hits)) {
    hits[name].n += 1;
    const seen = name === "depth 1" || name === "depth 3" ? null : timing[name].values[i];
    // A bounded pass can only see a change inside its bound; a file edit does not move its parent's mtime.
    const visible = name === "depth 1" ? newestDepth <= 1 : name === "depth 3" ? newestDepth <= 3 : seen >= newest;
    if (visible) hits[name].hit += 1;
  }
}

// ---------- the event matrix, on real repositories ----------
function sh(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function gitQuiet(args) {
  execFileSync("git", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}
const FIXTURES = flag("fixtures") || mkdtempSync(path.join(tmpdir(), "wag-tier-fixtures-"));
const matrix = [];
function fixture(name) {
  const repo = path.join(FIXTURES, name);
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  mkdirSync(path.join(repo, "src", "main", "java", "deep"), { recursive: true });
  writeFileSync(path.join(repo, "src", "main", "java", "deep", "Deep.java"), "class Deep {}\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "one");
  return repo;
}
function state(repo) {
  const status = sh(repo, "status", "--porcelain");
  const head = sh(repo, "rev-parse", "HEAD");
  const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
  return [status, head, branch].join("|");
}
async function read(repo) {
  const out = {};
  for (const [name, fn] of Object.entries(DETECTORS)) out[name] = fn(repo);
  out.shipped = Math.max(...Object.values(await statSignal(repo))); // the detector lib/tiers.js actually runs
  return out;
}
function compare(before, after) {
  const out = {};
  for (const k of Object.keys(before)) out[k] = after[k] !== before[k];
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EVENTS = [
  ["nothing", () => {}],
  ["append to a root file", (r) => writeFileSync(path.join(r, "a.txt"), "a\nb\n")],
  ["edit a file at depth 5", (r) => writeFileSync(path.join(r, "src", "main", "java", "deep", "Deep.java"), "class Deep { int x; }\n")],
  ["create a file at depth 5", (r) => writeFileSync(path.join(r, "src", "main", "java", "deep", "New.java"), "class New {}\n")],
  ["git add a root file", (r) => { writeFileSync(path.join(r, "a.txt"), "staged\n"); sh(r, "add", "-A"); }],
  ["commit on the branch", (r) => { sh(r, "commit", "-q", "--allow-empty", "-m", "two"); }],
  ["switch to a new branch", (r) => { sh(r, "checkout", "-q", "-b", "feature/two"); }],
  ["fetch a new upstream commit", (r) => { sh(r, "fetch", "-q", "origin"); }],
  ["commit in a sibling worktree", (r) => { sh(path.join(r, ".worktrees", "sib"), "commit", "-q", "--allow-empty", "-m", "sibling"); }],
  ["bare git status", (r) => { sh(r, "status", "--porcelain"); }],
  ["edit under node_modules", (r) => { writeFileSync(path.join(r, "node_modules", "dep", "index.js"), "v2\n"); }],
  ["edit preserving the mtime", (r) => {
    const f = path.join(r, "a.txt");
    const was = statSync(f);
    writeFileSync(f, "same mtime\n");
    utimesSync(f, was.atime, was.mtime); // the content changed, the timestamp did not
  }],
];

for (const [label, apply] of EVENTS) {
  const repo = fixture(label.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
  if (label === "fetch a new upstream commit") {
    const origin = path.join(FIXTURES, "origin.git");
    gitQuiet(["init", "-q", "--bare", "-b", "main", origin]);
    sh(repo, "remote", "add", "origin", origin.replace(/\\/g, "/"));
    sh(repo, "push", "-q", "-u", "origin", "main");
    const other = path.join(FIXTURES, "upstream-clone");
    gitQuiet(["clone", "-q", "-b", "main", origin.replace(/\\/g, "/"), other]);
    writeFileSync(path.join(other, "b.txt"), "b\n");
    sh(other, "add", "-A");
    sh(other, "commit", "-q", "-m", "upstream");
    sh(other, "push", "-q", "origin", "main");
  }
  if (label === "commit in a sibling worktree") {
    sh(repo, "worktree", "add", "-q", "-b", "sib", path.join(repo, ".worktrees", "sib"));
  }
  mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "v1\n");
  // The ground-truth `git status` may refresh `.git/index`, so it is read BEFORE the baseline and after the
  // event - never between the two detector reads, where it would look like movement the event did not cause.
  const wasState = state(repo);
  await sleep(20);
  const before = await read(repo);
  apply(repo);
  await sleep(20);
  const after = await read(repo);
  matrix.push({ event: label, stateMoved: state(repo) !== wasState, moved: compare(before, after) });
}

// ---------- the report ----------
const pad = (s, n) => String(s).padEnd(n);
const pct = (h, n) => (n ? `${Math.round((h / n) * 100)}% (${h}/${n})` : "—");

console.log(`fleet: ${REPOS.length} repositories, ${ground.filter((g) => g && g.ok).length} answered git, ${dirty.length} dirty\n`);
console.log("COST (one pass over the fleet, best of " + PASSES + ")");
for (const [name, t] of Object.entries(timing)) console.log(`  ${pad(name, 12)} ${pad(`${t.perRepoMs} ms/repo`, 14)} ${t.totalMs} ms total`);
for (const [name, t] of Object.entries(gitTiming)) console.log(`  ${pad(name, 22)} ${pad(`${t.medianMs} ms/repo`, 14)} median (n=${t.n}, ${t.minMs}-${t.maxMs})`);
console.log("\nHIT RATE (the fleet's dirty repos: does it see the newest uncommitted path?)");
for (const [name, h] of Object.entries(hits)) console.log(`  ${pad(name, 12)} ${pct(h.hit, h.n)}`);
console.log("\nEVENT MATRIX (real repos, one event each; \"moved\" is the detector's own answer)");
const cols = [...Object.keys(DETECTORS), "shipped"];
console.log(`  ${pad("event", 32)} ${pad("state", 6)} ${cols.map((c) => pad(c, 10)).join("")}`);
for (const row of matrix) {
  console.log(`  ${pad(row.event, 32)} ${pad(row.stateMoved ? "yes" : "no", 6)} ${cols.map((c) => pad(row.moved[c] ? "yes" : "no", 10)).join("")}`);
}
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ fleet: REPOS.length, timing, gitTiming, hits, matrix, dirty }, null, 0));
  console.log(`\nrecord: ${JSON_OUT}`);
}
if (!flag("fixtures")) rmSync(FIXTURES, { recursive: true, force: true });
