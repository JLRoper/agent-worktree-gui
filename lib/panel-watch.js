// lib/panel-watch.js - the board's watchdog sweep, as data.
//
// WHY: the panel has a sentry for its own assistant (the `sweep()` pass in lib/assistant.js), but nothing
// watches the BOARD from outside a panel turn: a run that died while nobody was looking, a run still marked
// running an hour later, a settle the wake budget refused. tools/panel-watch.mjs is that watch on a clock, and
// this module is its one decision: which runs are news, and which are history.
//
// THE DEFECT THIS FILE EXISTS TO PREVENT. The watch kept its one-shot set as a list, sorted the ids (they are
// hex, so sorted is alphabetical) and cut the list to the newest 200 BY THAT ORDER. Every id that sorts low was
// dropped on the next save, so the next pass called it new again: the same two ended runs, named in a fresh
// "Watchdog: FAILED ..." turn every ten minutes, long after both had fallen out of the job store. Nothing on
// the board could act on them. The set is now keyed by id with the time it was first reported, and it is pruned
// by RECENCY - an id the feed still names is never pruned at all.
//
// TWO CLASSES, and the difference between them is the whole fix:
//
//   LIVE      a failed run the job store still holds whose record carries no `endedAt`: it is failing NOW, so
//             it is reported on every pass until it ends or a repair replaces it. Silence here is the opposite
//             bug - a live failure nobody hears about.
//   HISTORY   a failed run whose record already carries `endedAt`, or one the job store no longer holds at all
//             (the panel resurrects runs from the gateway's own history, and those are not in jobs.json):
//             reported ONCE, recorded in the state file, and never again - while the feed keeps naming it, and
//             for the retention window after it leaves. A failed run that has ended is a fact about the past;
//             it is not a condition that becomes true again.
//
// A REPORT THAT NEVER LANDED IS NOT CONSUMED. The caller writes the state file only after the panel accepted
// the announce (tools/panel-watch.mjs). Recording an alert the assistant never saw would be the same silence
// this file is fixing, one layer down.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const PANEL_WATCH_STATE_VERSION = 1;

// How long a reported id is remembered after the feed stops naming it. Seven days is long enough that a gateway
// restart which hides a run for an hour cannot resurrect it, and short enough that the file cannot grow forever.
export const REPORTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// A ceiling on the remembered ids, applied by RECENCY (oldest first) and never by id order. The retention above
// is the real bound; this is the belt beside it, for a feed that names thousands of runs at once.
export const REPORTED_CAP = 5000;

// The statuses this sweep treats as a failed run. `rejected` is the gateway's refusal; `error` is what an older
// store wrote before the statuses were unified.
export const FAILED_STATUS = new Set(["failed", "rejected", "error"]);

// The panel kills a run at 60 minutes; 55 is the point where "still running" is worth a person's look.
export const LONG_RUN_MINUTES_DEFAULT = 55;

const ISO = (ms) => new Date(Number(ms) || 0).toISOString();

function clip(text, max) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/**
 * The ids the JOB STORE holds, which is not the same list the panel serves: /api/jobs also carries runs the
 * panel resurrected from the gateway after the store let them go. A run absent from this set is one the board
 * has no record of, so no row, queue or repair can be keyed on it.
 */
export function jobStoreIds(store) {
  const list = Array.isArray(store) ? store : Array.isArray(store?.jobs) ? store.jobs : [];
  const ids = new Set();
  for (const job of list) {
    const id = String(job?.id == null ? "" : job.id).trim();
    if (id) ids.add(id);
  }
  return ids;
}

/** The name a line uses for a run: the card's title when it has one, the prompt's first words when it does not. */
function nameOf(job) {
  return clip(job?.title || job?.label || job?.prompt || job?.thread || "a run", 70);
}

/** What the run died on, in the panel's own words (the gateway refusal is built in lib/jobs.js). */
function reasonOf(job) {
  const reason = job?.outcome?.reason || job?.outcome?.detail || job?.error || job?.completion?.reason || "";
  return clip(reason, 120);
}

/**
 * One failed run's line. The shape is the one the panel's assistant has been reading for weeks - `FAILED <id> -
 * <what it was> [<why>]` - so a reader looking at two turns sees the same fact, and the parenthesis says which
 * class this report belongs to.
 */
export function failedLine(job, { gone = false, ended = false } = {}) {
  const id = String(job?.id == null ? "" : job.id);
  const reason = reasonOf(job);
  const why = reason ? ` [${reason}]` : "";
  const note = gone
    ? " (the job store no longer holds this run)"
    : ended
      ? " (the run already ended; this is its one report)"
      : "";
  return `FAILED ${id} - ${nameOf(job)}${why}${note}`;
}

/** A run still marked running past the window. It is a live condition, so it is said on every pass it is true. */
export function longRunLine(job, now = Date.now(), longRunMinutes = LONG_RUN_MINUTES_DEFAULT) {
  const started = Date.parse(String(job?.startedAt || job?.createdAt || ""));
  if (!Number.isFinite(started)) return null;
  const minutes = Math.round((Number(now) - started) / 60_000);
  if (minutes <= Math.max(1, Number(longRunMinutes) || LONG_RUN_MINUTES_DEFAULT)) return null;
  return `LONG RUN ${String(job.id)} - ${nameOf(job)} has been running ${minutes} min`;
}

/** A state document, whatever the file held: a missing file, an old shape and a hand-edited one all read. */
export function normalizeWatchState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const reported = {};
  for (const [id, at] of Object.entries(state.reported && typeof state.reported === "object" ? state.reported : {})) {
    const key = String(id || "").trim();
    const when = Date.parse(String(at || ""));
    if (key) reported[key] = Number.isFinite(when) ? ISO(when) : ISO(0);
  }
  return {
    version: PANEL_WATCH_STATE_VERSION,
    reported,
    // The `wake-suppressed` journal count this sweep last saw, so a new suppression is news and a rotating
    // journal (which makes the count DROP) is not.
    suppressed: Math.max(0, Number(state.suppressed) || 0),
    // When the panel was last reported down, so an outage is news once an hour rather than every pass.
    downAt: Math.max(0, Number(state.downAt) || 0),
  };
}

/**
 * Keep the ids the feed still names, and the ones reported inside the retention window; drop the rest oldest
 * first, and only then apply the cap by recency. Order is time, never the id: that is the bug this file fixes.
 */
export function pruneReported(reported, visibleIds, now = Date.now()) {
  const visible = visibleIds instanceof Set ? visibleIds : new Set(visibleIds || []);
  const kept = [];
  for (const [id, at] of Object.entries(reported || {})) {
    const when = Date.parse(String(at || ""));
    const age = Number(now) - (Number.isFinite(when) ? when : 0);
    if (visible.has(id) || age < REPORTED_RETENTION_MS) kept.push([id, Number.isFinite(when) ? when : 0]);
  }
  kept.sort((a, b) => a[1] - b[1]);
  const over = Math.max(0, kept.length - REPORTED_CAP);
  const out = {};
  for (const [id, when] of kept.slice(over)) out[id] = ISO(when);
  return out;
}

/**
 * One pass. `jobs` is what the panel serves (/api/jobs); `store` is the job store the panel persists
 * (jobs.json). Returns the lines to report and the state to persist if - and only if - they are delivered.
 *
 * @returns {{alerts: string[], state: object, counts: {failed: number, live: number, history: number}}}
 */
export function sweepBoard({ jobs = [], store = null, state = null, now = Date.now(), longRunMinutes = LONG_RUN_MINUTES_DEFAULT } = {}) {
  const prev = normalizeWatchState(state);
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => j && typeof j === "object");
  const visible = new Set(list.map((j) => String(j.id == null ? "" : j.id)).filter(Boolean));
  const held = store == null ? null : jobStoreIds(store);
  const reported = pruneReported(prev.reported, visible, now);
  const alerts = [];
  const counts = { failed: 0, live: 0, history: 0 };

  for (const job of list) {
    const id = String(job.id == null ? "" : job.id).trim();
    if (!id) continue;
    const status = String(job.status || "").toLowerCase();
    const endedAt = job.endedAt || null;
    // The store's own silence is only a fact when a store was handed in: a caller with no store path cannot
    // claim a run is gone, and guessing "gone" here would silence real failures.
    const gone = held ? !held.has(id) : false;

    if (status === "running") {
      const line = endedAt ? null : longRunLine(job, now, longRunMinutes);
      if (line) alerts.push(line);
      continue;
    }
    if (!FAILED_STATUS.has(status)) continue;
    counts.failed += 1;

    // LIVE: the store holds it and nothing has stamped its end. It is failing now, and every pass says so.
    if (!endedAt && !gone) {
      counts.live += 1;
      alerts.push(failedLine(job));
      continue;
    }

    // HISTORY: it ended, or the board has no record of it. One report, then never again.
    counts.history += 1;
    if (reported[id]) continue;
    if (Number(now) > 0) reported[id] = ISO(now);
    alerts.push(failedLine(job, { gone, ended: Boolean(endedAt) }));
  }

  return { alerts, state: { ...prev, reported }, counts };
}

/** What the panel's assistant is handed. The prefix and the ` | ` join are what the reader has been reading. */
export function announceText(alerts, { cap = 1200, prefix = "Watchdog: " } = {}) {
  const text = `${prefix}${(Array.isArray(alerts) ? alerts : []).filter(Boolean).join(" | ")}`;
  return text.length > cap ? text.slice(0, Math.max(0, cap - 1)) : text;
}

/** The saved state, and the read error when there was one worth saying (a missing file is a first run). */
export function readWatchState(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { state: normalizeWatchState(null), error: null, exists: false };
    return { state: normalizeWatchState(null), error: String((err && err.message) || err), exists: false };
  }
  try {
    return { state: normalizeWatchState(JSON.parse(text)), error: null, exists: true };
  } catch (err) {
    return { state: normalizeWatchState(null), error: `could not read ${file}: ${String((err && err.message) || err)}`, exists: true };
  }
}

/** Write the state beside the panel's own state files, through a temporary name so a crash cannot leave half. */
export function writeWatchState(file, state) {
  const doc = normalizeWatchState(state);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return doc;
}
