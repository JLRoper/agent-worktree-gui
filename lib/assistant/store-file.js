// assistant.json: the one file the assistant remembers across restarts with.

// Read into a plain snapshot, write a plain snapshot back, and own the schema version and the caps - nothing
// else. The FIELDS stay on the class that debounces their writes: this module never holds state between
// calls, so there is one writer and one place a list is capped on the way out.

// Every list in the file has a cap, and the SAME cap is applied on the way in and on the way out. That
// redundancy is deliberate and load-bearing: a cap that moves from one to the other changes how much history
// a restart remembers, silently, in the one direction nobody notices until a restart reads less than the
// running process had. Do not move one without the other.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALERT_CAP, DEFAULTS, JOURNAL_CAP, LINE_CAP, pickRules, pickSettings } from "./config.js";

// 2: `watch` escalates to wake by default (see the migration in readAssistantFile).
export const STORE_VERSION = 2;
const RULES_CAP = 40;
const WATCH_CAP = 40;
const HARVESTED_CAP = 50;
const TERMINAL_CAP = 100;
const RESTART_CAP = 25;

/**
 * Read the assistant's file into a snapshot.
 * @param file - the assistant.json path.
 * @param base - the settings the caller already resolved from its own config; the file's settings are merged
 *   OVER it, so a knob the file never set keeps the value the panel booted with.
 * @returns {{ found: boolean, migrated: boolean, error: string|null, settings?, notes?, rules?, watches?,
 *   alerts?, journal?, harvested?: Set<string>, terminalWakes?: Map, restartWakes?: Set<string> }}
 *   found false means there is no file yet (a first boot is not an error); `migrated` means the caller should
 *   persist what it was handed, so the file is stamped with the new version exactly once.
 */
export function readAssistantFile(file, { base = {} } = {}) {
  if (!existsSync(file)) return { found: false, migrated: false, error: null };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const s = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    const settings = {
      ...base,
      ...pickSettings(s),
      rules: { ...DEFAULTS.rules, ...(s.rules && typeof s.rules === "object" ? pickRules(s.rules) : {}) },
    };
    // A persisted setting shadows the default forever, so a default that changes has to travel to existing
    // files explicitly. v2: `watch` started at "alert" and now starts at "wake" — a file written before that
    // change still carrying the old default is moved with it, once. (Someone who deliberately chose "alert"
    // is indistinguishable from someone who never chose; the setting is one select away.)
    let migrated = false;
    if (Number(raw.version || 1) < 2 && settings.rules.watch === "alert") {
      settings.rules.watch = "wake";
      migrated = true;
    }
    return {
      found: true,
      migrated,
      error: null,
      settings,
      notes: typeof raw.notes === "string" ? raw.notes.slice(0, LINE_CAP) : "",
      rules: Array.isArray(raw.rules) ? raw.rules.filter((r) => r && typeof r.text === "string").slice(-RULES_CAP) : [],
      watches: Array.isArray(raw.watches) ? raw.watches.filter((w) => w && w.id && w.thread).slice(-WATCH_CAP) : [],
      alerts: Array.isArray(raw.alerts) ? raw.alerts.filter((a) => a && a.id && a.rule).slice(-ALERT_CAP) : [],
      journal: Array.isArray(raw.journal) ? raw.journal.filter(Boolean).slice(-JOURNAL_CAP) : [],
      harvested: new Set(Array.isArray(raw.harvested) ? raw.harvested.filter((x) => typeof x === "string").slice(-HARVESTED_CAP) : []),
      // One finish is one wake, across a restart: the thread's terminal result is remembered, not re-derived.
      terminalWakes: new Map(
        Array.isArray(raw.terminalWakes) ? raw.terminalWakes.filter((e) => Array.isArray(e) && e.length === 2).slice(-TERMINAL_CAP) : [],
      ),
      restartWakes: new Set(Array.isArray(raw.restartWakes) ? raw.restartWakes.filter((x) => typeof x === "string").slice(-RESTART_CAP) : []),
    };
  } catch (err) {
    // A missing file is `found: false`; a file that cannot be READ is an error the caller journals. An
    // unreadable store starts the assistant empty rather than refusing to boot.
    return { found: false, migrated: false, error: String((err && err.message) || err) };
  }
}

/**
 * Write the whole snapshot, tmp+rename, stamped with the current schema version.
 * @returns {{ error: string|null }} - the caller journals a failure; this never throws.
 */
export function writeAssistantFile(file, snapshot = {}) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify(
      {
        // 2: `watch` escalates to wake by default (see the migration above).
        version: STORE_VERSION,
        savedAt: new Date().toISOString(),
        settings: snapshot.settings,
        notes: snapshot.notes,
        rules: snapshot.rules,
        watches: snapshot.watches,
        alerts: (snapshot.alerts || []).slice(-ALERT_CAP),
        journal: (snapshot.journal || []).slice(-JOURNAL_CAP),
        harvested: [...(snapshot.harvested || [])].slice(-HARVESTED_CAP),
        terminalWakes: [...(snapshot.terminalWakes || new Map())].slice(-TERMINAL_CAP),
        restartWakes: [...(snapshot.restartWakes || [])].slice(-RESTART_CAP),
      },
      null,
      1,
    );
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
    return { error: null };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

