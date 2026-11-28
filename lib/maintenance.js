// The Settings -> General "Storage & cleanup" surface: what this panel's own machinery leaves on disk, and the one
// bounded way to clean each kind.
//
// Five targets. Three are FILES this panel owns. Nothing here walks into a checkout, removes a worktree, touches a
// ref or signals a process; the panel's project cleanup (lib/cleanup-plan.js / lib/cleanup-run.js) is a different
// feature with a different, git-shaped vocabulary and is deliberately NOT reused here: a scratch folder, an
// abandoned atomic-write temp file and a rotated log archive have no branch, no proof and no merge. What IS reused is
// lib/paths.js: the scratch safety rules (scratchProblem, SCRATCH_MARKER, scratchHolders) and its size walk.
//
//   scratch        everything under the RESOLVED scratch directory (config.scratchDir), minus the marker
//   state-temp     the job store's atomic-write leftovers (`jobs.json.<pid>-<n>.tmp`) older than an hour
//   log-archives   rotated `server.out.log.*` archives beside the live log, newest 20 kept
//
// The other two are HERMES' OWN stores, which this panel does not own and never edits: `hermes-sessions` (the
// gateway's state.db + WAL for the default and intelligent-automation profiles) and `hermes-checkpoints` (the
// /rollback history). They share this contract so the page paints them for free, but every change goes through the
// `hermes` CLI — lib/hermes-maintenance.js owns those two, including the argument for why no SQL runs here.
//
// THE BOUND IS THE POINT. lib/paths.js `cleanScratch` empties a folder in one call and has no ceiling: a scratch tree
// holding a copied node_modules can keep the request busy for minutes (the peak trap this surface exists to avoid).
// This module therefore does NOT call `cleanScratch`; it asks the same refusal questions through `scratchProblem` /
// `scratchHolders`, then removes at most MAX_SCRATCH_ENTRIES top-level entries within MAX_SCRATCH_MS. Whatever is left
// is reported as `remaining`, and a second press carries on. The other two targets are a single directory listing
// each, so they are naturally small and are not capped.
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HERMES_CHECKPOINTS_TARGET,
  HERMES_SESSIONS_TARGET,
  cleanHermesCheckpoints,
  cleanHermesSessions,
  describeHermesCheckpoints,
  describeHermesSessions,
  runHermesCli,
} from "./hermes-maintenance.js";
import {
  SCRATCH_DIR_NAME,
  SCRATCH_MARKER,
  pathKey,
  scratchHolders,
  scratchProblem,
  statePaths,
  walkSize,
} from "./paths.js";

/**
 * The target ids, in the order the page paints them. The first three are files this panel owns; the last two are
 * Hermes' own stores, pruned only through the `hermes` CLI (lib/hermes-maintenance.js) — same contract, different
 * owner of the data.
 */
export const MAINTENANCE_TARGET_IDS = [
  "scratch",
  "state-temp",
  "log-archives",
  HERMES_SESSIONS_TARGET,
  HERMES_CHECKPOINTS_TARGET,
];

/** One press removes at most this many top-level scratch entries... */
export const MAX_SCRATCH_ENTRIES = 250;
/** ...and stops starting new ones once this long has passed (checked between entries). */
export const MAX_SCRATCH_MS = 1500;
/** A job-store temp file younger than this may be an IN-FLIGHT write, so it is never removed. */
export const STATE_TEMP_MIN_AGE_MS = 60 * 60 * 1000;
/** Rotated server log archives kept by LastWriteTime; older ones are removable. */
export const LOG_ARCHIVES_KEEP = 20;

const TEMP_NAME_RE = /^jobs\.json\..+\.tmp$/;
const ARCHIVE_NAME_RE = /^server\.out\.log\..+$/;

/** The default scratch folder every install gets when neither config nor env names one (`<tmpdir>/wag`). */
export function defaultScratchDir({ tmpdir = os.tmpdir() } = {}) {
  return path.join(tmpdir, SCRATCH_DIR_NAME);
}

/** Where the job store lives. In the split layout this is `<dataDir>/state`; the temp files are written beside it. */
export function storeDirOf(config = {}) {
  const file = String(config.jobsFile || "").trim();
  return file ? path.dirname(file) : statePaths(config).stateDir;
}

/** The folder holding server.out.log and its rotated archives. */
export function logsDirOf(config = {}) {
  return String(config.logsDir || "").trim() || statePaths(config).logsDir;
}

/**
 * Is this the panel's own DEFAULT scratch folder, which may be treated as mine without the marker?
 *
 * THE MARKER GAP, and why the gap is closed only here. `cleanScratch` refuses any folder without `.wag-scratch`,
 * because a `scratchDir` typo pointing at somebody's documents must not become a deletion. On this machine the
 * default folder (`%TEMP%/wag`) exists WITHOUT the marker — it was provisioned before the marker existed, or the
 * marker was cleaned away with the OS temp dir — so the old rule would leave the panel's own scratch permanently
 * uncleanable. The default folder is definitionally the panel's: no reader types that path, it is `tmpdir/wag`, the
 * OS may empty it at any time, and nothing but throwaway files belongs there. So an UNMARKED directory is allowed
 * only when it resolves to exactly that default (or the boot recorded `scratchDirSource: "default"`). Any OTHER
 * unmarked directory is still refused with the original sentence.
 */
export function isDefaultScratchDir({ config = {}, tmpdir = os.tmpdir() } = {}) {
  const configured = String(config.scratchDir || "").trim();
  if (!configured) return false;
  if (config.scratchDirSource === "default") return true;
  return pathKey(configured) === pathKey(defaultScratchDir({ tmpdir }));
}

/** Why the scratch target must not be cleaned, or "" when it may. Mirrors cleanScratch's two refusals. */
export function scratchRefusal({ config = {}, jobs = [], keep = [], home = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  const dir = String(config.scratchDir || "").trim();
  if (!dir) return "this panel has no scratch directory configured";
  const problem = scratchProblem({ scratchDir: dir, home, dataDir: config.dataDir || null, keep });
  if (problem) return problem;
  if (!existsSync(dir)) return "";
  if (!existsSync(path.join(dir, SCRATCH_MARKER)) && !isDefaultScratchDir({ config, tmpdir })) {
    return `${dir} was not made by the panel (no ${SCRATCH_MARKER} file inside it), and the panel does not delete in a folder it did not make — add an empty file named ${SCRATCH_MARKER} to it if it really is yours to empty`;
  }
  const holders = scratchHolders({ scratchDir: dir, jobs });
  if (holders.length) {
    const named = holders.map((j) => `${j.id || j.thread || "?"}${j.cwd ? ` in ${String(j.cwd).replace(/\\/g, "/")}` : ""}`);
    return `scratch is in use: ${holders.length === 1 ? "a live run is working" : `${holders.length} live runs are working`} in or writing to it (${named.join(" · ")}) — stop ${holders.length === 1 ? "it" : "them"} first, or clean it by hand`;
  }
  return "";
}

// ---- measuring one directory entry ------------------------------------------------------------------------------
// A file's size without following a link; a directory's total through the shared async walk. A link is its own size,
// never the tree behind it — walking through one is how a scratch cleaner finds a folder it was not pointed at.
async function measureEntry(full, dirent) {
  if (dirent && dirent.isDirectory()) {
    const found = await walkSize(full);
    return { bytes: Number(found.bytes) || 0, files: Number(found.files) || 0, dirs: Number(found.dirs) || 0 };
  }
  try {
    const st = dirent && dirent.isSymbolicLink() ? lstatSync(full) : await stat(full);
    return { bytes: Number(st.size) || 0, files: 1, dirs: 0 };
  } catch {
    return { bytes: 0, files: 0, dirs: 0 };
  }
}

async function listEntries(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  return entries ? entries.filter((entry) => entry.name !== SCRATCH_MARKER) : [];
}

// ---- the three targets, as the page reads them ----------------------------------------------------------------

async function describeScratch({ config, jobs, keep, tmpdir }) {
  const dir = String(config.scratchDir || "").trim();
  const refusal = scratchRefusal({ config, jobs, keep, tmpdir });
  // MEASURE ONLY A FOLDER THE PANEL MAY CLEAN. A refused path can be a drive root or a home folder; walking it here
  // would turn one Settings read into a scan of somebody's whole disk. The refusal is the answer, and 0 B is honest.
  let measured = { bytes: 0, files: 0, dirs: 0 };
  if (!refusal && dir && existsSync(dir)) {
    measured = await walkSize(dir);
  }
  return {
    id: "scratch",
    label: "Scratch files",
    detail: dir
      ? `${dir} — throwaway comparisons and exports the panel and its agents write here; the OS may also clear it`
      : "this panel has no scratch directory configured",
    bytes: Number(measured.bytes) || 0,
    files: Number(measured.files) || 0,
    dirs: Number(measured.dirs) || 0,
    removable: !refusal,
    ...(refusal ? { blockedReason: `scratch will not be cleaned: ${refusal}` } : {}),
  };
}

function stateTempNames(config) {
  // The atomic write puts its temp file BESIDE the store, which in the split layout is `<dataDir>/state`. A config that
  // names `jobsFile` elsewhere still lands beside THAT file. Both the store's folder and the data directory are listed,
  // because "the panel's data dir" and "where the store lives" are the same folder on a flat (PANEL_CONFIG) install and
  // one level apart otherwise; a name found twice is counted once.
  const dirs = [];
  const seen = new Set();
  for (const dir of [storeDirOf(config), String(config.dataDir || "").trim()]) {
    const key = pathKey(dir);
    if (!dir || seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir).filter((name) => TEMP_NAME_RE.test(name));
    } catch {
      continue;
    }
    for (const name of names) out.push({ dir, name, file: path.join(dir, name) });
  }
  return out;
}

function describeStateTemp({ config, now }) {
  const files = [];
  let bytes = 0;
  for (const candidate of stateTempNames(config)) {
    try {
      const st = statSync(candidate.file);
      if (now - st.mtimeMs < STATE_TEMP_MIN_AGE_MS) continue;
      files.push(candidate);
      bytes += Number(st.size) || 0;
    } catch {
      /* gone between the listing and the stat */
    }
  }
  return {
    id: "state-temp",
    label: "Job-store temp files",
    detail: `${storeDirOf(config)} — atomic-write leftovers from the job store; only files older than 1 hour are removable`,
    bytes,
    files: files.length,
    dirs: 0,
    removable: true,
  };
}

// One listing of the log folder, newest first. The LIVE log is `server.out.log` and does not match the archive
// pattern, so it is never a candidate; `server.err.log.*` is a different rotation and is out of this target's scope.
function listLogArchives(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!ARCHIVE_NAME_RE.test(name)) continue;
    try {
      const st = statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, file: path.join(dir, name), bytes: Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0 });
    } catch {
      /* gone between the listing and the stat */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

function describeLogArchives({ config }) {
  const dir = logsDirOf(config);
  const archives = listLogArchives(dir);
  const removable = archives.slice(LOG_ARCHIVES_KEEP);
  return {
    id: "log-archives",
    label: "Rotated server logs",
    detail: `${path.join(dir, "server.out.log.*")} — ${archives.length} archive${archives.length === 1 ? "" : "s"}; the newest ${LOG_ARCHIVES_KEEP} are kept`,
    bytes: removable.reduce((sum, f) => sum + f.bytes, 0),
    files: removable.length,
    dirs: 0,
    removable: true,
  };
}

/**
 * Every target, measured now. The numbers describe THE REMOVABLE SET (what one clean call would deal with), not the
 * whole folder: for `log-archives` the newest 20 are retained and do not count, and for `state-temp` a temp file
 * younger than an hour is in flight and does not count.
 *
 * The two Hermes targets are measured WITHOUT running the CLI (a stat of four store files, a stat walk of the
 * checkpoint base), so a Settings read cannot block on a locked database. `hermes` is `{ home, bin }`; `bin`
 * undefined means "look for it", `bin: null` means "do not look, it is missing" (a test's seam).
 */
export async function readMaintenanceTargets({
  config = {},
  jobs = [],
  keep = [],
  now = Date.now(),
  tmpdir = os.tmpdir(),
  hermes = {},
} = {}) {
  return [
    await describeScratch({ config, jobs, keep, tmpdir }),
    describeStateTemp({ config, now }),
    describeLogArchives({ config }),
    describeHermesSessions({ home: hermes.home, bin: hermes.bin }),
    await describeHermesCheckpoints({ home: hermes.home, bin: hermes.bin }),
  ];
}

// ---- cleaning ----------------------------------------------------------------------------------------------------

function result({ target, dryRun, removedFiles = 0, removedBytes = 0, remaining = 0, refused = null, started }) {
  return {
    ok: true,
    target,
    dryRun,
    removedFiles,
    removedBytes,
    remaining,
    ...(refused ? { refused } : {}),
    ms: Math.max(0, Date.now() - started),
  };
}

async function cleanScratchTarget({ config, jobs, keep, dryRun, tmpdir, limits, now, started }) {
  const dir = String(config.scratchDir || "").trim();
  const refusal = scratchRefusal({ config, jobs, keep, tmpdir });
  if (refusal) {
    const entries = dir ? await listEntries(dir) : [];
    return result({ target: "scratch", dryRun, remaining: entries.length, refused: `scratch will not be cleaned: ${refusal}`, started });
  }
  if (!existsSync(dir)) return result({ target: "scratch", dryRun, remaining: 0, started });

  const entries = await listEntries(dir);
  const cap = Math.max(1, Number(limits.maxEntries) || MAX_SCRATCH_ENTRIES);
  const budget = Math.max(1, Number(limits.maxMs) || MAX_SCRATCH_MS);
  const deadline = started + budget;
  let attempted = 0;
  let removed = 0;
  let removedFiles = 0;
  let removedBytes = 0;

  for (const entry of entries) {
    if (attempted >= cap) break;
    // Checked between entries (never before the first), so a folder whose entries each take a while still makes
    // progress on every press, and the answer comes back in bounded time rather than after the whole tree.
    if (attempted > 0 && Date.now() >= deadline) break;
    attempted += 1;
    const full = path.join(dir, entry.name);
    const measured = await measureEntry(full, entry);
    if (dryRun) {
      removedFiles += measured.files;
      removedBytes += measured.bytes;
      continue;
    }
    try {
      await rm(full, { recursive: Boolean(entry.isDirectory()), force: true, maxRetries: 2, retryDelay: 50 });
      removed += 1;
      removedFiles += measured.files;
      removedBytes += measured.bytes;
    } catch {
      /* still open, still there: it counts as remaining, not as removed */
    }
  }

  return result({
    target: "scratch",
    dryRun,
    removedFiles,
    removedBytes,
    remaining: entries.length - (dryRun ? attempted : removed),
    started,
  });
}

async function cleanStateTempTarget({ config, dryRun, now, started }) {
  const candidates = [];
  let remaining = 0;
  for (const candidate of stateTempNames(config)) {
    try {
      const st = await stat(candidate.file);
      if (now - st.mtimeMs < STATE_TEMP_MIN_AGE_MS) {
        remaining += 1;
        continue;
      }
      candidates.push({ file: candidate.file, bytes: Number(st.size) || 0 });
    } catch {
      /* gone between the listing and the stat */
    }
  }
  if (dryRun) {
    return result({
      target: "state-temp",
      dryRun,
      removedFiles: candidates.length,
      removedBytes: candidates.reduce((sum, f) => sum + f.bytes, 0),
      remaining,
      started,
    });
  }
  let removedFiles = 0;
  let removedBytes = 0;
  for (const candidate of candidates) {
    try {
      await unlink(candidate.file);
      removedFiles += 1;
      removedBytes += candidate.bytes;
    } catch {
      remaining += 1;
    }
  }
  return result({ target: "state-temp", dryRun, removedFiles, removedBytes, remaining, started });
}

async function cleanLogArchivesTarget({ config, dryRun, started }) {
  const dir = logsDirOf(config);
  const archives = listLogArchives(dir);
  const remove = archives.slice(LOG_ARCHIVES_KEEP);
  const kept = archives.length - remove.length;
  if (dryRun) {
    return result({
      target: "log-archives",
      dryRun,
      removedFiles: remove.length,
      removedBytes: remove.reduce((sum, f) => sum + f.bytes, 0),
      remaining: kept,
      started,
    });
  }
  let removedFiles = 0;
  let removedBytes = 0;
  let remaining = kept;
  for (const archive of remove) {
    try {
      await unlink(archive.file);
      removedFiles += 1;
      removedBytes += archive.bytes;
    } catch {
      remaining += 1;
    }
  }
  return result({ target: "log-archives", dryRun, removedFiles, removedBytes, remaining, started });
}

/**
 * Clean one target. `dryRun` is decided by the caller (the route makes anything but a literal `false` a dry run), so
 * this function always does what it is told. A refusal is not an exception: the answer carries `refused` as the same
 * sentence cleanScratch would have thrown, with nothing removed.
 *
 * `hermes` / `runHermes` / `olderThanHours` reach the two CLI-delegated targets; the file targets ignore them.
 */
export async function cleanMaintenanceTarget({
  target,
  config = {},
  jobs = [],
  keep = [],
  dryRun = true,
  now = Date.now(),
  tmpdir = os.tmpdir(),
  limits = {},
  hermes = {},
  runHermes = runHermesCli,
  olderThanHours,
} = {}) {
  const started = Date.now();
  const options = { config, jobs, keep, dryRun, tmpdir, now, limits, started };
  if (target === "scratch") return cleanScratchTarget(options);
  if (target === "state-temp") return cleanStateTempTarget(options);
  if (target === "log-archives") return cleanLogArchivesTarget(options);
  if (target === HERMES_SESSIONS_TARGET) {
    return cleanHermesSessions({ home: hermes.home, bin: hermes.bin, jobs, dryRun, olderThanHours, runHermes, started });
  }
  if (target === HERMES_CHECKPOINTS_TARGET) {
    return cleanHermesCheckpoints({ home: hermes.home, bin: hermes.bin, jobs, dryRun, runHermes, started });
  }
  return { ok: false, error: `unknown maintenance target: ${String(target || "(none)")}` };
}

// Kept for a caller that wants the sentence the page's blockedReason carries without re-measuring the folder.
export { scratchRefusal as scratchBlockedReason };
