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
//   old     no commit for 7 days. One `stat(2)` of four paths an HOUR, staggered across the hour by a
//           bucket hashed from its path, so a minute's slice is a handful of repos and never a burst.
//
// Movement on any of those four paths - or the reader opening the project - promotes it: ONE full probe,
// which puts it back on the recent tier when the commit it finds is inside the window, and returns it to
// the gate with a fresh baseline when it is not. A repo demotes again after 7 days with no commit.
//
// Nothing in this module runs git. `statSignal` is four filesystem stats; `TierBook` keeps what it saw in a
// small JSON file beside the projects cache, so a restart resumes the hour instead of re-seeding every
// baseline. (A re-seed is harmless; a restart that PROMOTED the fleet would be the burst this prevents.)
import { stat } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const RECENT_DAYS = 7;
export const TIER_BUCKETS = 60;
export const TIER_CHECK_SECONDS = 60;

// The four paths whose mtime says something happened in a repository. `.git/HEAD` moves on a checkout,
// `.git/index` on a stage/checkout, `.git/refs/heads` (the DIRECTORY) on a branch created or deleted, and
// `.git/logs/HEAD` on a commit, checkout or reset - so between them a commit, a rebase, a branch and a
// switch all leave a mark, and nothing else has to be read.
export const TIER_PATHS = [
  ["head", ".git/HEAD"],
  ["index", ".git/index"],
  ["refs", ".git/refs/heads"],
  ["logs", ".git/logs/HEAD"],
];
export const SIGNAL_KEYS = TIER_PATHS.map(([key]) => key);

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

// Which tier a project belongs to. The rule is the commit date, and only the commit date: `activityAt` is
// discovery's answer for "the last commit, or the .git mtime of a repo with no commits yet". A record whose
// date is MISSING is recent, not old - "we do not know" is not "nothing happened in seven days", and
// treating it as old would silently stop reading a project discovery has not probed yet.
export function tierOf(project, now = Date.now(), days = RECENT_DAYS) {
  const at = Date.parse(project?.activityAt || "");
  if (!Number.isFinite(at) || at <= 0) return "recent";
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

// Four stats, no git. A missing path reads 0 rather than throwing: a repo whose `.git/logs/HEAD` does not
// exist yet (a fresh clone has one only after its first reflog write) still has `HEAD` and `index` to
// compare, and a repo that has been deleted altogether reads four zeros, which is itself movement.
export async function statSignal(repoPath) {
  const out = {};
  await Promise.all(
    TIER_PATHS.map(async ([key, rel]) => {
      try {
        const s = await stat(path.join(repoPath, rel));
        out[key] = Number(s.mtimeMs) || 0;
      } catch {
        out[key] = 0;
      }
    }),
  );
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

  // Compare one repo's four mtimes with the last ones recorded. The FIRST call for a repo only records a
  // baseline (`first: true`) - it cannot know whether the current state is movement or the state it just
  // found. A moved signal is deliberately NOT recorded here: the caller promotes and then seeds the
  // post-probe state, so a promotion that fails is retried on the repo's next slice instead of being
  // remembered as already handled.
  stat(repoPath, signal, now = Date.now()) {
    const key = this.key(repoPath);
    const cur = this.repos[key];
    const baseline = cur?.baseline || null;
    if (!baseline) {
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
