// ---- Hermes' own storage: two Settings targets, cleaned only through the `hermes` CLI -------------------------
//
// The panel does not own these stores and never edits them. `<home>\state.db` is the gateway's session database
// (SQLite; 8.1 GB here) and `<home>\checkpoints` is the /rollback history — another program's data, with its own
// retention rules, its own locks and its own "keep" flags. So every CHANGE is delegated to the CLI:
// `hermes sessions prune|optimize` and `hermes checkpoints prune`. No SQL runs here, no file is unlinked here, and
// nothing in this module imports a database driver.
//
// TWO PROFILES, ONE CONTRACT. Hermes keeps a default store at `<home>\state.db` and one per named profile at
// `<home>\profiles\<name>\state.db`. The second store this panel reports on is `intelligent-automation` (the
// gateway's automation profile). A profile is addressed with the CLI's global `--profile <name>` flag, which Hermes
// consumes before argparse and uses to point HERMES_HOME at the profile directory; `default` is addressed with no
// flag at all. `HERMES_PROFILE` in the environment does NOT switch a store, so it is not used. Verified on this
// machine: `hermes sessions stats` reports 4736 sessions / 8065 MB; `hermes sessions stats --profile
// intelligent-automation` reports 14 / 64.4 MB.
//
// PINNED AND ARCHIVED SESSIONS SURVIVE. `prune --include-pinned` and `prune --include-archived` are the CLI's two
// opt-ins for deleting rows a reader asked to keep. This module never passes either — `callCli` refuses an argv that
// carries one, and a test pins that — so a pin is a durable keep flag on this surface too. A prune is always
// followed by `sessions optimize` (FTS5 segment merge + VACUUM), because a delete leaves free pages inside state.db
// and the number the card shows is what the FILES occupy.
//
// THE GET IS A STAT. Describing the two stores is `statSync` on four files (state.db + state.db-wal, twice); the
// checkpoint size is a stat walk of the checkpoint base. The CLI is never run from the GET, so a Settings read can
// never block on a locked database, a VACUUM or a gateway that holds the store.
//
// THE RUNNER IS INJECTED. `runHermes({ bin, args, timeoutMs })` is a default here and an option on
// createMaintenanceRoutes, exactly like `census`: a test hands in a canned dry-run table instead of pruning a real
// store. The real runner is execFile with an argv ARRAY (never a shell), windowsHide, and an explicit timeout.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { hermesHome as defaultHermesHome } from "./hermes-runtime.js";
import { LIVE_STATUSES, walkSize } from "./paths.js";

export const HERMES_SESSIONS_TARGET = "hermes-sessions";
export const HERMES_CHECKPOINTS_TARGET = "hermes-checkpoints";

/** The stores this surface reports and prunes, in the order the CLI is addressed for each of them. */
export const HERMES_SESSION_PROFILES = ["default", "intelligent-automation"];

/** The default age threshold: a session unused for a day is what "Clean" offers to prune. */
export const DEFAULT_OLDER_THAN_HOURS = 24;
export const MIN_OLDER_THAN_HOURS = 1;
export const MAX_OLDER_THAN_HOURS = 8760; // a year — 4736 sessions over two months is nowhere near it

export const PRUNE_TIMEOUT_MS = 120_000;
export const OPTIMIZE_TIMEOUT_MS = 600_000;
export const CHECKPOINTS_TIMEOUT_MS = 600_000;
export const STATUS_TIMEOUT_MS = 60_000;

const MAX_BUFFER = 16 * 1024 * 1024;

/** The two flags that would delete a row the reader pinned or archived. Never passed; callCli refuses them. */
export const FORBIDDEN_PRUNE_FLAGS = Object.freeze(["--include-pinned", "--include-archived"]);

/** `--older-than` hours: absent/garbage -> the default; anything finite -> clamped into 1..8760. */
export function clampOlderThanHours(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_OLDER_THAN_HOURS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OLDER_THAN_HOURS;
  return Math.min(MAX_OLDER_THAN_HOURS, Math.max(MIN_OLDER_THAN_HOURS, Math.round(n)));
}

/** The directory holding one profile's store files. `default` is the Hermes home itself. */
export function sessionStoreDir({ home = defaultHermesHome(), profile = "default" } = {}) {
  return profile === "default" ? String(home || "") : path.join(String(home || ""), "profiles", profile);
}

/** The two files whose SIZE is the store's footprint (the -shm file is a lock map, not data). */
export function sessionStoreFiles({ home = defaultHermesHome(), profile = "default" } = {}) {
  const dir = sessionStoreDir({ home, profile });
  return ["state.db", "state.db-wal"].map((name) => path.join(dir, name));
}

/** stat-only: both profiles' state.db + state.db-wal, summed. Never opens a database. */
export function measureSessionStore({ home = defaultHermesHome() } = {}) {
  const out = { bytes: 0, files: 0 };
  for (const profile of HERMES_SESSION_PROFILES) {
    for (const file of sessionStoreFiles({ home, profile })) {
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        out.files += 1;
        out.bytes += Number(st.size) || 0;
      } catch {
        /* a profile that was never used has no files: it contributes 0, not an error */
      }
    }
  }
  return out;
}

function measureOneProfile({ home, profile }) {
  let bytes = 0;
  for (const file of sessionStoreFiles({ home, profile })) {
    try {
      bytes += Number(statSync(file).size) || 0;
    } catch {
      /* gone between measurements */
    }
  }
  return bytes;
}

/** `<home>\checkpoints` is the base `hermes checkpoints status` names; the panel never invents another. */
export function checkpointsDir({ home = defaultHermesHome() } = {}) {
  return path.join(String(home || ""), "checkpoints");
}

/** Where `hermes.exe` lives. Only an .exe is accepted on Windows: execFile cannot run a .cmd without a shell. */
export function resolveHermesBinary({ home = defaultHermesHome(), env = process.env, platform = process.platform } = {}) {
  const names = platform === "win32" ? ["hermes.exe"] : ["hermes"];
  const explicit = String(env.HERMES_BIN || "").trim();
  if (explicit && existsSync(explicit)) return { bin: explicit, reason: "" };
  const tryDir = (dir) => {
    if (!dir) return null;
    for (const name of names) {
      const full = path.join(dir, name);
      if (existsSync(full)) return full;
    }
    return null;
  };
  const inHome = tryDir(path.join(String(home || ""), "bin"));
  if (inHome) return { bin: inHome, reason: "" };
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const found = tryDir(dir);
    if (found) return { bin: found, reason: "" };
  }
  return {
    bin: null,
    reason: `the hermes CLI was not found (looked for ${names[0]} in the hermes home's bin folder and on PATH)`,
  };
}

/** The binary this request will use, honouring an injected one. `bin: null` means "do not look; it is missing". */
function binaryFor({ home, bin }) {
  if (bin === undefined) return resolveHermesBinary({ home });
  if (!bin) return { bin: null, reason: "the hermes CLI was not found on this machine" };
  return { bin: String(bin), reason: "" };
}

// ---- the real runner --------------------------------------------------------------------------------------------
const lastNonEmptyLine = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || "";

/**
 * The real `hermes` runner: argv array, no shell, windowsHide, explicit timeout. It never throws — a spawn error,
 * a non-zero exit and a timeout all come back as `{ ok: false }` with the CLI's own last sentence, because the
 * caller's answer to all three is the same: refuse, and quote the CLI rather than inventing a reason.
 */
export function hermesCliRunner({ env = process.env } = {}) {
  return function runHermes({ bin, args = [], timeoutMs = PRUNE_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      execFile(
        bin,
        args.map(String),
        { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER, env },
        (err, stdout, stderr) => {
          const out = String(stdout || "");
          const errText = String(stderr || "");
          if (err) {
            const timedOut = err.killed === true || err.signal === "SIGTERM";
            resolve({
              ok: false,
              code: typeof err.code === "number" ? err.code : null,
              stdout: out,
              stderr: errText,
              timedOut,
              sentence: lastNonEmptyLine(out) || lastNonEmptyLine(errText) || String(err.message || err),
            });
            return;
          }
          resolve({ ok: true, code: 0, stdout: out, stderr: errText, sentence: "" });
        },
      );
    });
  };
}

/** The runner the panel uses unless a test injects one. */
export const runHermesCli = hermesCliRunner();

/** One guarded CLI call. Returns `{ ok, stdout, sentence }`; never throws, never passes a pin/archive opt-in. */
async function callCli(runHermes, { bin, args, timeoutMs }) {
  const offending = (args || []).find((arg) => FORBIDDEN_PRUNE_FLAGS.includes(String(arg)));
  if (offending) {
    return { ok: false, stdout: "", sentence: `refusing to pass ${offending}: pinned and archived sessions are kept` };
  }
  try {
    const res = await runHermes({ bin, args, timeoutMs });
    if (!res || typeof res !== "object") {
      return { ok: false, stdout: "", sentence: "the hermes CLI returned nothing" };
    }
    const exited = res.code === undefined || res.code === null || res.code === 0;
    const stdout = String(res.stdout || "");
    if (res.ok === false || !exited) {
      return {
        ok: false,
        stdout,
        sentence:
          String(res.sentence || "") ||
          lastNonEmptyLine(stdout) ||
          lastNonEmptyLine(res.stderr) ||
          "the hermes CLI failed without saying why",
      };
    }
    return { ok: true, stdout, sentence: "" };
  } catch (e) {
    return { ok: false, stdout: "", sentence: String((e && e.message) || e) };
  }
}

// ---- parsing the CLI's own output -------------------------------------------------------------------------------

const PRUNE_HEADER_RE = /^(\d+) session\(s\) match\b/;
// `  wtgui-…  2026-11-25 01:04  api_server deepseek-v4.1-flash-1017  267 msgs  Title`
const PRUNE_ROW_RE = /^\s{2,}\S+\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s/;
const PRUNED_RE = /(?:^|\n)Pruned (\d+) session\(s\)\./;

/**
 * Count the sessions a `sessions prune` run matched. The CLI prints a header (`N session(s) match (...)`) and one
 * indented row per session, then `Dry run — nothing deleted.`; `No sessions match (...)` is the zero answer.
 *
 * The header is the authority (a non-dry-run prints at most 15 rows and then a truncation line), the rows are the
 * cross-check, and an output with neither is NOT read as "0" — the caller refuses with the CLI's own last line
 * instead of reporting a number it could not see.
 */
export function parsePrunePreview(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.some((line) => /^No sessions match\b/.test(line.trim()))) return { ok: true, count: 0 };
  for (const line of lines) {
    const m = PRUNE_HEADER_RE.exec(line.trim());
    if (m) return { ok: true, count: Number(m[1]) || 0 };
  }
  const rows = lines.filter((line) => PRUNE_ROW_RE.test(line)).length;
  if (rows > 0) return { ok: true, count: rows };
  return { ok: false, count: 0, sentence: lastNonEmptyLine(text) };
}

/** Just the matched count from the header, or null when the run printed no header. */
export function parsePruneMatchCount(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = PRUNE_HEADER_RE.exec(line.trim());
    if (m) return Number(m[1]) || 0;
  }
  return null;
}

/** The CLI's own delete confirmation (`Pruned 13 session(s).`), or null when it printed none. */
export function parsePrunedCount(text) {
  const m = PRUNED_RE.exec(String(text || ""));
  return m ? Number(m[1]) || 0 : null;
}

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** `Total size:      7.9 GB` (hermes_cli.sizefmt) -> bytes, or null when the line is absent/unreadable. */
export function parseCheckpointTotal(text) {
  const m = /^\s*Total size:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)\s*$/m.exec(String(text || ""));
  if (!m) return null;
  const bytes = Math.round(Number(m[1]) * (SIZE_UNITS[m[2]] || 1));
  return Number.isFinite(bytes) ? bytes : null;
}

/** `Deleted orphan:  3` / `Deleted stale:  1` from `checkpoints prune`. Missing lines read as 0. */
export function parseCheckpointCounts(text) {
  const num = (re) => {
    const m = re.exec(String(text || ""));
    return m ? Number(m[1]) || 0 : 0;
  };
  return { orphan: num(/^\s*Deleted orphan:\s*(\d+)\s*$/m), stale: num(/^\s*Deleted stale:\s*(\d+)\s*$/m) };
}

// ---- statements -------------------------------------------------------------------------------------------------

/** The refusal a live run earns, or "" when the board is idle. Mirrors the scratch holder refusal's shape. */
export function liveJobRefusal(jobs = [], what = "session store") {
  const live = (Array.isArray(jobs) ? jobs : []).filter((j) => j && LIVE_STATUSES.has(String(j.status || "")));
  const n = live.length;
  if (!n) return "";
  return `${n} live run${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} working — prune the ${what} when the board is idle`;
}

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

/** The store as the CLI addresses it: default with no flag, a profile with its global `--profile`. */
function profileArgs(profile) {
  return profile === "default" ? [] : ["--profile", String(profile)];
}

function profileLabel(profile) {
  return profile === "default" ? "the default store" : `the ${profile} store`;
}

/**
 * The Settings card, stat-only. `detail` names the default threshold because the GET has no per-request threshold.
 */
export function describeHermesSessions({ home = defaultHermesHome(), bin } = {}) {
  const resolved = binaryFor({ home, bin });
  const measured = measureSessionStore({ home });
  return {
    id: HERMES_SESSIONS_TARGET,
    label: "Hermes sessions",
    detail: `Hermes session stores (default + intelligent-automation): sessions unused > ${DEFAULT_OLDER_THAN_HOURS}h; pinned and archived sessions are kept; a prune is followed by VACUUM`,
    bytes: measured.bytes,
    files: measured.files,
    dirs: 0,
    removable: Boolean(resolved.bin),
    ...(resolved.bin ? {} : { blockedReason: `${HERMES_SESSIONS_TARGET} will not be cleaned: ${resolved.reason}` }),
  };
}

/** The Settings card for the checkpoint base: a stat walk, never `checkpoints status` (that is a CLI run). */
export async function describeHermesCheckpoints({ home = defaultHermesHome(), bin } = {}) {
  const dir = checkpointsDir({ home });
  const resolved = binaryFor({ home, bin });
  const measured = existsSync(dir) ? await walkSize(dir) : { bytes: 0, files: 0, dirs: 0 };
  return {
    id: HERMES_CHECKPOINTS_TARGET,
    label: "Hermes checkpoints",
    detail: `${dir} — the /rollback history Hermes keeps per project; \`hermes checkpoints prune\` drops stale commits and keeps projects whose workdir is out of reach`,
    bytes: Number(measured.bytes) || 0,
    files: Number(measured.files) || 0,
    dirs: Number(measured.dirs) || 0,
    removable: Boolean(resolved.bin),
    ...(resolved.bin ? {} : { blockedReason: `${HERMES_CHECKPOINTS_TARGET} will not be cleaned: ${resolved.reason}` }),
  };
}

// ---- cleaning ---------------------------------------------------------------------------------------------------

/**
 * Prune both session stores through the CLI.
 *
 * Preview: one `sessions prune --older-than <N>h --dry-run` per profile; `removedFiles` is the number of sessions the
 * two tables matched, `removedBytes` is 0 and `remaining` repeats the match count (nothing was measured, so nothing
 * is claimed about size). Clean: per profile, measure db+wal, prune with `--yes`, `sessions optimize` (the VACUUM),
 * measure again; `removedBytes` is max(0, before-after) summed and `removedFiles` is what the CLI confirmed it
 * deleted (falling back to the pre-measured header count when the confirmation line is unreadable).
 *
 * A CLI refusal is returned as `refused` with whatever was already measured, never a crash and never a claim about
 * files that were not pruned.
 */
export async function cleanHermesSessions({
  home = defaultHermesHome(),
  bin,
  jobs = [],
  dryRun = true,
  olderThanHours,
  runHermes = runHermesCli,
  started = Date.now(),
} = {}) {
  const target = HERMES_SESSIONS_TARGET;
  const refusal = liveJobRefusal(jobs, "session store");
  if (refusal) return result({ target, dryRun, refused: refusal, started });

  const resolved = binaryFor({ home, bin });
  if (!resolved.bin) {
    return result({ target, dryRun, refused: `${target} will not be cleaned: ${resolved.reason}`, started });
  }

  const hours = clampOlderThanHours(olderThanHours);
  const ago = `${hours}h`;

  if (dryRun) {
    let matched = 0;
    for (const profile of HERMES_SESSION_PROFILES) {
      const run = await callCli(runHermes, {
        bin: resolved.bin,
        args: ["sessions", "prune", "--older-than", ago, "--dry-run", ...profileArgs(profile)],
        timeoutMs: PRUNE_TIMEOUT_MS,
      });
      if (!run.ok) {
        return result({
          target,
          dryRun,
          refused: `the prune preview for ${profileLabel(profile)} failed: ${run.sentence}`,
          started,
        });
      }
      const parsed = parsePrunePreview(run.stdout);
      if (!parsed.ok) {
        return result({
          target,
          dryRun,
          refused: `could not read the prune preview for ${profileLabel(profile)}: ${parsed.sentence || "the CLI printed no session table"}`,
          started,
        });
      }
      matched += parsed.count;
    }
    return result({ target, dryRun, removedFiles: matched, removedBytes: 0, remaining: matched, started });
  }

  let removedFiles = 0;
  let removedBytes = 0;
  let remaining = 0;

  for (const profile of HERMES_SESSION_PROFILES) {
    const before = measureOneProfile({ home, profile });
    const prune = await callCli(runHermes, {
      bin: resolved.bin,
      args: ["sessions", "prune", "--older-than", ago, "--yes", ...profileArgs(profile)],
      timeoutMs: PRUNE_TIMEOUT_MS,
    });
    if (!prune.ok) {
      return result({
        target,
        dryRun,
        removedFiles,
        removedBytes,
        remaining,
        refused: `the prune of ${profileLabel(profile)} failed: ${prune.sentence}`,
        started,
      });
    }
    const matched = parsePruneMatchCount(prune.stdout);
    const pruned = parsePrunedCount(prune.stdout);
    removedFiles += pruned !== null ? pruned : matched !== null ? matched : 0;
    // The CLI spares an open row and any row a live write guard holds, so a run can confirm fewer than it matched.
    if (matched !== null && pruned !== null) remaining += Math.max(0, matched - pruned);

    const optimize = await callCli(runHermes, {
      bin: resolved.bin,
      args: ["sessions", "optimize", ...profileArgs(profile)],
      timeoutMs: OPTIMIZE_TIMEOUT_MS,
    });
    const after = measureOneProfile({ home, profile });
    removedBytes += Math.max(0, before - after);
    if (!optimize.ok) {
      return result({
        target,
        dryRun,
        removedFiles,
        removedBytes,
        remaining,
        refused: `the prune of ${profileLabel(profile)} ran but its VACUUM failed: ${optimize.sentence}`,
        started,
      });
    }
  }

  return result({ target, dryRun, removedFiles, removedBytes, remaining, started });
}

/**
 * One measurement of the checkpoint base: `hermes checkpoints status`'s `Total size:` when it parses, else a stat
 * walk of the base directory. The CLI number is preferred where a before/after delta is the point (the parsed
 * value is what Hermes itself accounts for), and the walk is the fallback the spec asks for.
 */
async function measureCheckpoints({ home, bin, runHermes }) {
  const dir = checkpointsDir({ home });
  const status = await callCli(runHermes, { bin, args: ["checkpoints", "status"], timeoutMs: STATUS_TIMEOUT_MS });
  if (status.ok) {
    const parsed = parseCheckpointTotal(status.stdout);
    if (parsed !== null) return { bytes: parsed, source: "status" };
  }
  const walked = existsSync(dir) ? await walkSize(dir) : { bytes: 0 };
  return { bytes: Number(walked.bytes) || 0, source: "walk" };
}

/**
 * GC the checkpoint store through `hermes checkpoints prune`, then report the before/after delta.
 *
 * `--keep-orphans` is passed on purpose: without it the CLI asks an interactive question before deleting a project
 * whose workdir is unreachable, and a workdir that is unreachable may be an unplugged drive or a VPN that is down
 * rather than a deleted project. A panel button must never answer that question on the reader's behalf, so this
 * surface keeps orphan projects and lets the CLI reclaim stale commits and its size cap.
 *
 * There is no `--dry-run` on `checkpoints prune`, so the preview reports 0 bytes and 0 files rather than guessing:
 * the card already shows the store's current size, and "would remove" must not claim a number no run produced.
 */
export async function cleanHermesCheckpoints({
  home = defaultHermesHome(),
  bin,
  jobs = [],
  dryRun = true,
  runHermes = runHermesCli,
  started = Date.now(),
} = {}) {
  const target = HERMES_CHECKPOINTS_TARGET;
  const refusal = liveJobRefusal(jobs, "checkpoint store");
  if (refusal) return result({ target, dryRun, refused: refusal, started });

  const resolved = binaryFor({ home, bin });
  if (!resolved.bin) {
    return result({ target, dryRun, refused: `${target} will not be cleaned: ${resolved.reason}`, started });
  }

  if (dryRun) {
    // A preview that cannot name a delta is honest about it: 0 bytes, 0 files, and no "entries remain" tail.
    return result({ target, dryRun, removedFiles: 0, removedBytes: 0, remaining: 0, started });
  }

  const before = await measureCheckpoints({ home, bin: resolved.bin, runHermes });
  const prune = await callCli(runHermes, {
    bin: resolved.bin,
    args: ["checkpoints", "prune", "--keep-orphans"],
    timeoutMs: CHECKPOINTS_TIMEOUT_MS,
  });
  const after = await measureCheckpoints({ home, bin: resolved.bin, runHermes });
  const removedBytes = Math.max(0, before.bytes - after.bytes);
  if (!prune.ok) {
    return result({
      target,
      dryRun,
      removedBytes,
      refused: `the checkpoint prune failed: ${prune.sentence}`,
      started,
    });
  }
  const counts = parseCheckpointCounts(prune.stdout);
  return result({ target, dryRun, removedFiles: counts.orphan + counts.stale, removedBytes, remaining: 0, started });
}
