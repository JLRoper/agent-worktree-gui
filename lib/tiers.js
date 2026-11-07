// The two tiers a repository is read in, and the stat gate that moves one between them.
//
// The board used to re-read every worktree of every project forever: a fast scan of each row on its own
// cadence, a full project pass every `slowSeconds`, and a fetch of every remote every `fetchSeconds`. On
// this machine's fleet of 177 repositories under two roots, 160 had not taken a commit in seven days, so
// most of that git was spent proving that nothing had changed.
//
// So a REPOSITORY (not a row) is read in one of two tiers:
//
//   recent  its last commit is within `tierDays` (7). Today's treatment, unchanged.
//   old     no commit for 7 days. One signal read an HOUR - a walk of the worktree plus a handful of `.git`
//           stats - staggered across the hour by a bucket hashed from its path, so a minute's slice is a
//           handful of repos and never a burst.
//
// Movement on that signal - or the reader opening the project - promotes it: ONE full probe, which puts it
// back on the recent tier when the commit it finds is inside the window, and returns it to the gate with a
// fresh baseline when it is not. A repo demotes again after 7 days with no commit.
//
// THE SIGNAL IS THE WORKTREE, NOT JUST `.git`. It was four `.git` stats, and on this fleet that missed 35 of
// the 101 dirty repos: an edit moves neither `.git/index` nor `.git/HEAD`, so a row being worked on stayed
// parked. `docs/perf/tier-detection-2026-11-07.md` measured the candidates; `statSignal` is now the pick from
// that measurement - one unbounded walk of the worktree with the heavy directories pruned, plus the narrow
// git watch set a commit, a branch or a checkout rewrites. It is ~10 ms per repo against 3-6 s for the six or
// seven git calls it replaces, and it promotes on all three events the gate exists for (see `test/tiers.test.js`).
//
// Nothing in this module runs git. `TierBook` keeps what it saw in a small JSON file beside the projects
// cache, so a restart resumes the hour instead of re-seeding every baseline. (A re-seed is harmless; a
// restart that PROMOTED the fleet would be the burst this prevents.)
import { mkdirSync, readFileSync, readdirSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const RECENT_DAYS = 7;
export const TIER_BUCKETS = 60;
export const TIER_CHECK_SECONDS = 60;

// The directories the worktree walk does not descend into. `node_modules` and build output are somebody
// else's writes, and a dependency edit is not the row's own work; `.git` is handled by the watch set below.
// `.worktrees` is deliberately NOT in this list: it has its own rule (below), because a sibling worktree is
// a row of its own whose tree this walk does not need to read - only its existence and its mtime.
export const TIER_PRUNE = new Set([
  ".git", "node_modules", "target", "build", "dist", "out", ".next", ".venv", "__pycache__", ".gradle", "bin", "obj",
]);

// The narrow git watch set: the files a commit, a stage, a checkout or a branch rewrites, and nothing else.
// `index` and the reflog move on a commit, `HEAD` on a checkout, `refs/heads` on a branch created or
// deleted, `packed-refs` on a gc or a packed branch. Each path is a list of segments joined under the
// repository's REAL git dir (a linked worktree has `.git` as a FILE naming it) and, for the refs, under the
// COMMON dir a worktree shares with its main checkout. Deliberately absent: `FETCH_HEAD` and `refs/remotes`,
// which the panel's own fetch pass rewrites - watching them would promote repos for the panel's own writes.
export const TIER_GIT_PATHS = [
  ["index", "gitdir", ["index"]],
  ["head", "gitdir", ["HEAD"]],
  ["logs", "gitdir", ["logs", "HEAD"]],
  ["packed", "common", ["packed-refs"]],
  ["refs", "common", ["refs", "heads"]],
];
export const SIGNAL_KEYS = ["worktree", ...TIER_GIT_PATHS.map(([key]) => key)];

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

// Which tier a project belongs to. The rule is the commit date, and only the commit date: `activityAt` is
// discovery's answer for "the last commit". A record whose date is MISSING is OLD, not recent: "we do not
// know" must never mean "read every project in full". An unknown date puts the repo on the hourly gate, and
// its first probe either finds a commit inside the window, which promotes it, or leaves it gated. The
// opposite default is how a whole fleet ends up scanned: one missing field, and every repo is recent.
export function tierOf(project, now = Date.now(), days = RECENT_DAYS) {
  const at = Date.parse(project?.activityAt || "");
  if (!Number.isFinite(at) || at <= 0) return "old";
  return now - at <= Math.max(1, Number(days) || RECENT_DAYS) * 864e5 ? "recent" : "old";
}

// The bucket a repository's hourly check falls in. A hash of the PATH, not its position in a list: the
// set of projects changes (a repo appears, another is deleted) and a positional slot would shift every
// later repo's hour, while a hash of the path keeps each repo's minute stable for as long as it exists.
// SHA-256 of the normalised, lowercased path so two panels on this machine agree, and a different drive
// letter or slash style cannot move a repo to another slot.
export function bucketFor(repoPath, buckets = TIER_BUCKETS) {
  const n = Math.max(1, Math.floor(Number(buckets) || TIER_BUCKETS));
  let h;
  try {
    h = createHash("sha256").update(norm(repoPath).toLowerCase()).digest();
  } catch {
    return 0;
  }
  return h.readUInt32BE(0) % n;
}

// Which slice is due at `now`: with the defaults (60 buckets of 60 s) this is the minute of the hour.
export function sliceIndex(now = Date.now(), buckets = TIER_BUCKETS, checkSeconds = TIER_CHECK_SECONDS) {
  const every = Math.max(1, Number(checkSeconds) || TIER_CHECK_SECONDS) * 1000;
  const span = every * Math.max(1, Math.floor(Number(buckets) || TIER_BUCKETS));
  return Math.floor((now % span) / every);
}

// The next time this repo's slice comes round. In the current rotation window a bucket sits at
// `windowStart + bucket * every`; once that has passed, the next window opens `span` later.
export function nextCheckAt(repoPath, now = Date.now(), buckets = TIER_BUCKETS, checkSeconds = TIER_CHECK_SECONDS) {
  const n = Math.max(1, Math.floor(Number(buckets) || TIER_BUCKETS));
  const every = Math.max(1, Number(checkSeconds) || TIER_CHECK_SECONDS) * 1000;
  const span = every * n;
  const windowStart = Math.floor(now / span) * span;
  let at = windowStart + bucketFor(repoPath, n) * every;
  if (at <= now) at += span;
  return at;
}

// ---------- the signal ----------

const mtimeOf = (p) => {
  try {
    return Number(lstatSync(p).mtimeMs) || 0;
  } catch {
    return 0;
  }
};

// Where a repository's `.git` really is. A main checkout has a `.git` DIRECTORY; a linked worktree has a
// `.git` FILE whose one line names its git dir under the main checkout's `.git/worktrees/<name>`, and that
// git dir's `commondir` file names the checkout's shared one. Reading the wrong pair is how a worktree row
// ends up with four zero mtimes and never moves, so both are resolved here and the caller reads `index`,
// `HEAD` and `logs/HEAD` from the git dir and the refs from the common one.
export function gitDirs(repoPath) {
  const dotgit = path.join(repoPath, ".git");
  const asDir = { gitdir: dotgit, common: dotgit };
  try {
    if (statSync(dotgit).isDirectory()) return asDir;
    const m = /^\s*gitdir:\s*(.+?)\s*$/im.exec(readFileSync(dotgit, "utf8"));
    if (!m) return asDir;
    const gitdir = path.resolve(repoPath, m[1].replace(/\\/g, "/"));
    let common = gitdir;
    try {
      const cd = readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
      if (cd) common = path.resolve(gitdir, cd.replace(/\\/g, "/"));
    } catch {
      /* no commondir: the git dir is its own common dir */
    }
    return { gitdir, common };
  } catch {
    return asDir; // not a repository at all: every path below reads 0, which is what a deleted repo looks like
  }
}

// The newest mtime anywhere in the worktree, to any depth, with `TIER_PRUNE` skipped. The depth is not
// bounded on purpose: an edit changes the file's mtime and NOT its parent directory's, so a depth bound is a
// coverage loss and not a cost knob - on this fleet a depth-1 pass saw 52 of the 101 dirty repos and a
// depth-3 pass 87, while the unbounded pruned walk saw 93 and cost less than either, because pruning the
// heavy directories is what the bounded passes were really paying for.
//
// `.worktrees` gets one rule of its own: the walk does not descend into a sibling worktree (it is a row of
// its own, and its tree is not this repository's work), but it DOES read the mtime of each entry directly
// inside it - a worktree created, removed or touched is movement for this repo, and git reports a nested
// worktree as a single dirty path, so those entries are exactly what a `status` would name.
export function newestInTree(repoPath) {
  let newest = 0;
  const stack = [repoPath];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // an unreadable directory is not movement; a deleted one reads through its parent's mtime
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name === ".worktrees") {
        let kids;
        try {
          kids = readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const kid of kids) newest = Math.max(newest, mtimeOf(path.join(full, kid.name)));
        continue;
      }
      if (TIER_PRUNE.has(entry.name)) continue;
      const at = mtimeOf(full);
      if (at > newest) newest = at;
      if (entry.isDirectory()) stack.push(full); // a symlink or junction is read, never followed
    }
  }
  return newest;
}

// `refs/heads`: the directory and its immediate entries. Creating a branch writes a ref file (or, for a
// two-segment name like `feature/x`, a directory that holds it), and deleting one removes it - both move one
// of these. Deeper ref names are covered by the parent directory entry they land in.
function headsSignal(common) {
  const heads = path.join(common, "refs", "heads");
  let newest = mtimeOf(heads);
  try {
    for (const entry of readdirSync(heads, { withFileTypes: true })) {
      newest = Math.max(newest, mtimeOf(path.join(heads, entry.name)));
    }
  } catch {
    /* a repo with no branches yet reads the directory's own mtime, which is 0 when it is gone */
  }
  return newest;
}

// The signal: one number per watched path, plus `worktree` for the newest thing in the tree. Same shape as
// the four-stat gate it replaces - a flat object of numbers - so `signalMoved` and the tier book read it
// unchanged. Nothing here runs git and nothing is written. A missing path reads 0 rather than throwing: a
// repo that has been deleted altogether reads zeros, which is itself movement.
export async function statSignal(repoPath) {
  const { gitdir, common } = gitDirs(repoPath);
  const out = {};
  for (const [key, where, segments] of TIER_GIT_PATHS) {
    out[key] = key === "refs" ? headsSignal(common) : mtimeOf(path.join(where === "gitdir" ? gitdir : common, ...segments));
  }
  out.worktree = newestInTree(repoPath);
  return out;
}

// Any mtime change is movement. The values are compared as numbers so a JSON round-trip (the state file)
// cannot turn a change into a string difference.
export function signalMoved(before, after) {
  if (!before || !after) return false;
  for (const key of SIGNAL_KEYS) if ((Number(before[key]) || 0) !== (Number(after[key]) || 0)) return true;
  return false;
}

// The durable record of each repo's tier and last stat signature. Keyed by the normalised path, lowercase,
// because that is how the panel addresses a tree everywhere else (lib/scheduler.js `norm`).
export class TierBook {
  constructor({ file = null, buckets = TIER_BUCKETS, checkSeconds = TIER_CHECK_SECONDS, days = RECENT_DAYS } = {}) {
    this.file = file;
    this.buckets = Math.max(1, Math.floor(Number(buckets) || TIER_BUCKETS));
    this.checkSeconds = Math.max(1, Number(checkSeconds) || TIER_CHECK_SECONDS);
    this.days = Math.max(1, Number(days) || RECENT_DAYS);
    this.repos = this.load();
  }

  key(repoPath) {
    return norm(repoPath).toLowerCase();
  }

  load() {
    if (!this.file) return {};
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      const repos = saved && typeof saved.repos === "object" && saved.repos ? saved.repos : {};
      const out = {};
      for (const [key, value] of Object.entries(repos)) {
        if (!value || typeof value !== "object") continue;
        out[key] = {
          tier: value.tier === "old" ? "old" : "recent",
          at: Number(value.at) || 0,
          checkedAt: Number(value.checkedAt) || 0,
          baseline: value.baseline && typeof value.baseline === "object" ? value.baseline : null,
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  save() {
    if (!this.file) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ savedAt: new Date().toISOString(), buckets: this.buckets, repos: this.repos }, null, 0));
      return true;
    } catch {
      /* a book we cannot write is not a failure: the next pass re-seeds from memory */
      return false;
    }
  }

  entry(repoPath) {
    return this.repos[this.key(repoPath)] || null;
  }

  tierFor(repoPath) {
    return this.entry(repoPath)?.tier || null;
  }

  baselineFor(repoPath) {
    return this.entry(repoPath)?.baseline || null;
  }

  // Stamp every project with the tier its own date says, record that, and forget repos no longer under the
  // roots. Returns name -> tier, which is what discovery writes onto the project records. Pure: no stats,
  // no git - the baseline is taken by the first hourly CHECK, not by a discovery pass.
  sync(projects, now = Date.now()) {
    const tiers = new Map();
    const seen = new Set();
    let changed = false;
    for (const p of Array.isArray(projects) ? projects : []) {
      const key = this.key(p?.path);
      if (!key) continue;
      seen.add(key);
      const before = this.repos[key]?.tier;
      const tier = this.stamp(p, now);
      if (before !== tier) changed = true;
      if (p && p.name) tiers.set(p.name, tier);
    }
    for (const key of Object.keys(this.repos)) {
      if (seen.has(key)) continue;
      delete this.repos[key];
      changed = true;
    }
    if (changed) this.save();
    return tiers;
  }

  // One project's tier, recorded without touching any other entry: what a single-project refresh asks for.
  // `sync` calls it for every project it walks, so the rule lives in exactly one place.
  stamp(project, now = Date.now()) {
    const key = this.key(project?.path);
    if (!key) return tierOf(project, now, this.days);
    const tier = tierOf(project, now, this.days);
    const cur = this.repos[key];
    if (!cur || cur.tier !== tier) {
      // A tier change retires the signature with it: a baseline taken before a promotion (or before a repo went
      // recent for a week) describes a repository state that no longer applies, and comparing against it would
      // promote on the first check for movement that already happened.
      this.repos[key] = { tier, at: now, checkedAt: cur?.checkedAt || 0, baseline: null };
    }
    return tier;
  }

  // A baseline written by an OLDER signal set - the four `.git` stats, before the worktree walk - cannot
  // answer for this one: its missing `worktree` key would read 0 against a real mtime and promote every old
  // repo on its first slice after the upgrade. A signature with a key missing is treated as no signature, so
  // the first check re-seeds it and promotes nothing, exactly as a first check does.
  known(baseline) {
    if (!baseline || typeof baseline !== "object") return false;
    return SIGNAL_KEYS.every((key) => Object.prototype.hasOwnProperty.call(baseline, key));
  }

  // Compare one repo's signal with the last one recorded. The FIRST call for a repo only records a baseline
  // (`first: true`) - it cannot know whether the current state is movement or the state it just found. A
  // moved signal is deliberately NOT recorded here: the caller promotes and then seeds the post-probe state,
  // so a promotion that fails is retried on the repo's next slice instead of being remembered as already
  // handled.
  stat(repoPath, signal, now = Date.now()) {
    const key = this.key(repoPath);
    const cur = this.repos[key];
    const baseline = cur?.baseline || null;
    if (!this.known(baseline)) {
      this.repos[key] = { tier: cur?.tier || "old", at: cur?.at || now, checkedAt: now, baseline: signal };
      this.save();
      return { first: true, moved: false };
    }
    const moved = signalMoved(baseline, signal);
    const next = { ...cur, tier: cur?.tier || "old", at: cur?.at || now, checkedAt: now };
    if (!moved) next.baseline = signal;
    this.repos[key] = next;
    this.save();
    return { first: false, moved };
  }

  // Record the state a promotion just left behind: the repo is on the gate from here, and the next hour
  // compares against what the full probe saw rather than against the movement that triggered it.
  seed(repoPath, signal, tier = "old", now = Date.now()) {
    const key = this.key(repoPath);
    const cur = this.repos[key] || {};
    this.repos[key] = { tier, at: cur.at || now, checkedAt: now, baseline: signal || null };
    this.save();
  }

  counts() {
    const out = { recent: 0, old: 0, baselines: 0 };
    for (const value of Object.values(this.repos)) {
      if (value.tier === "old") out.old += 1;
      else out.recent += 1;
      if (value.baseline) out.baselines += 1;
    }
    return out;
  }
}
