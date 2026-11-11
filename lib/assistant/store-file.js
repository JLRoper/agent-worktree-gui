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
import { AGGRESSIVE_KEYS, AGGRESSIVE_RULE_IDS, ALERT_CAP, DEFAULTS, JOURNAL_CAP, NOTES_CAP, SPAWN_INTENT_CAP, pickRules, pickSettings } from "./config.js";
import { COMMAND_AUDIT_CAP, readAudits } from "./audit.js";

// 2: `watch` escalates to wake by default (see the migration in readAssistantFile).
export const STORE_VERSION = 2;
const RULES_CAP = 40;
const WATCH_CAP = 40;
const HARVESTED_CAP = 50;
// The carried-line ledger. It has to outlive the harvest mark it stands behind: 50 turn ids age out in an afternoon
// of Director turns, and the ledger holds one small record per QUEUE/MESSAGE line — 200 is roughly a fortnight of
// them, and the QUEUE half is also written into the row it filed, so a pruned ledger still cannot re-file a row.
export const CARRIED_CAP = 200;
const TERMINAL_CAP = 100;
const RESTART_CAP = 25;

// What a stored "aggressive mode" record looks like, normalised. The record is the reason the mode can be
// switched off correctly after a restart: it holds, for EVERY key the profile writes, whether that key
// existed before the mode went on and — if it did — exactly what it was. A key that did not exist is recorded
// as absent with no value, which is the whole point: turning the mode off DELETES it again so it falls back to
// whatever its default is then, instead of being frozen at whatever the default was the day the button was
// pressed. Nothing here trusts the file: an unknown key, a wrong shape or a missing half is dropped, and a
// record with no entries at all is reported as `incomplete` so the caller can say so rather than silently
// believing it can restore something.
export function readAggressiveRecord(raw) {
  const saved = { settings: {}, rules: {} };
  const a = raw && typeof raw === "object" ? raw : {};
  const src = a.saved && typeof a.saved === "object" ? a.saved : {};
  const one = (r) => (r && typeof r === "object" ? (r.present === true ? { present: true, value: r.value } : { present: false }) : null);
  for (const key of AGGRESSIVE_KEYS) {
    const r = one(src.settings && src.settings[key]);
    if (r) saved.settings[key] = r;
  }
  for (const id of AGGRESSIVE_RULE_IDS) {
    const r = one(src.rules && src.rules[id]);
    if (r) saved.rules[id] = r;
  }
  const on = a.on === true;
  const entries = Object.keys(saved.settings).length + Object.keys(saved.rules).length;
  return { on, at: typeof a.at === "string" ? a.at : null, saved, incomplete: on && entries === 0 };
}

/**
 * Read the assistant's file into a snapshot.
 * @param file - the assistant.json path.
 * @param base - the settings the caller already resolved from its own config; the file's settings are merged
 *   OVER it, so a knob the file never set keeps the value the panel booted with.
 * @returns {{ found: boolean, migrated: boolean, error: string|null, settings?, present?: { settings: string[], rules: string[] },
 *   aggressive?: { on: boolean, at: string|null, saved: { settings: object, rules: object }, incomplete: boolean },
 *   notes?, rules?, watches?, alerts?, journal?, harvested?: Set<string>, terminalWakes?: Map, restartWakes?: Set<string> }}
 *   found false means there is no file yet (a first boot is not an error); `migrated` means the caller should
 *   persist what it was handed, so the file is stamped with the new version exactly once. `present` lists the
 *   knobs and rule ids the file itself carries — the keys that must be written back and the ones that must not.
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
    // Which knobs the FILE actually carries, as opposed to which ones the merged settings happen to have a
    // value for. The difference is the whole of "an absent knob falls back to its default": an absent key must
    // stay absent through a mode change, so the caller writes back only the keys that were there (plus the ones
    // the reader or the profile sets). A file written before a knob existed reports it absent, which is right.
    const present = { settings: Object.keys(pickSettings(s)), rules: Object.keys(s.rules && typeof s.rules === "object" ? pickRules(s.rules) : {}) };
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
      present,
      aggressive: readAggressiveRecord(raw.aggressive),
      // The pad, capped at what a turn reads. The TAIL is kept, the same way an appended line keeps the newest
      // text: a legacy 8,000-character string is trimmed to its last 1,200 rather than its first.
      notes: typeof raw.notes === "string" ? raw.notes.slice(-NOTES_CAP) : "",
      rules: Array.isArray(raw.rules) ? raw.rules.filter((r) => r && typeof r.text === "string").slice(-RULES_CAP) : [],
      watches: Array.isArray(raw.watches) ? raw.watches.filter((w) => w && w.id && w.thread).slice(-WATCH_CAP) : [],
      alerts: Array.isArray(raw.alerts) ? raw.alerts.filter((a) => a && a.id && a.rule).slice(-ALERT_CAP) : [],
      journal: Array.isArray(raw.journal) ? raw.journal.filter(Boolean).slice(-JOURNAL_CAP) : [],
      harvested: new Set(Array.isArray(raw.harvested) ? raw.harvested.filter((x) => typeof x === "string").slice(-HARVESTED_CAP) : []),
      // The carried-line ledger: one record per QUEUE/MESSAGE line this panel has already carried out, keyed by the
      // turn and the line's place in it. `harvested` above is a WINDOW over harvest events and a re-read of a turn
      // that has fallen out of it runs every line again; this list does not age out that way. A record read back is
      // never trusted further than the shape it is: the key is what the lookup uses, and a keyless record is dropped.
      carriedLines: Array.isArray(raw.carriedLines)
        ? raw.carriedLines
            .filter((x) => x && typeof x === "object" && typeof x.key === "string" && x.key.trim())
            .map((x) => ({
              key: String(x.key).trim().slice(0, 160),
              kind: x.kind === "message" ? "message" : "queue",
              who: x.who ? String(x.who) : null,
              turnId: x.turnId ? String(x.turnId) : null,
              target: x.target ? String(x.target) : null,
              at: x.at ? String(x.at) : null,
              outcome: typeof x.outcome === "string" ? x.outcome : null,
              ref: x.ref === 0 || x.ref ? x.ref : null,
            }))
            .slice(-CARRIED_CAP)
        : [],
      // The spawn debt: one record per SPAWN line seen in a turn, with what became of it. A record without an
      // outcome is a line that has not produced a card or a job yet — the watchdog's input.
      spawnIntents: Array.isArray(raw.spawnIntents)
        ? raw.spawnIntents
            .filter((x) => x && typeof x === "object" && x.id && (typeof x.prompt === "string" || x.outcome))
            .map((x) => ({
              id: String(x.id),
              turnId: x.turnId ? String(x.turnId) : null,
              thread: x.thread ? String(x.thread) : null,
              at: Number(x.at) || 0,
              target: String(x.target || ""),
              existing: x.existing === true,
              // The parent the line named (`SPAWN FROM <ref>`), when it named one. Read back for the same reason the
              // target is: a replay after a restart has to be recognised as the SAME line, and a lost debt re-issued
              // must not be re-read as a plain cut from the checkout.
              from: x.from ? String(x.from) : null,
              // WHICH queue row the line named. Read back like the tree and branch beside it: a restart that
              // re-reads this line needs the id to ask the row whether a cut already happened for it.
              taskId: Number(x.taskId) > 0 ? Number(x.taskId) : null,
              prompt: String(x.prompt || "").slice(0, 240),
              outcome: typeof x.outcome === "string" ? x.outcome : null,
              alertId: x.alertId ? String(x.alertId) : null,
              jobThread: x.jobThread ? String(x.jobThread) : null,
              reportedAt: x.reportedAt ? String(x.reportedAt) : null,
              // Where the brief went, and the verdict that kept it from being replayed. Read back so a skip survives
              // the restart that would otherwise re-owe the line and start it again.
              tree: x.tree ? String(x.tree) : null,
              branch: x.branch ? String(x.branch) : null,
              landedAt: x.landedAt ? String(x.landedAt) : null,
              landedWhy: x.landedWhy ? String(x.landedWhy).slice(0, 240) : null,
            }))
            .slice(-SPAWN_INTENT_CAP)
        : [],
      // One finish is one wake, across a restart: the thread's terminal result is remembered, not re-derived.
      terminalWakes: new Map(
        Array.isArray(raw.terminalWakes) ? raw.terminalWakes.filter((e) => Array.isArray(e) && e.length === 2).slice(-TERMINAL_CAP) : [],
      ),
      restartWakes: new Set(Array.isArray(raw.restartWakes) ? raw.restartWakes.filter((x) => typeof x === "string").slice(-RESTART_CAP) : []),
      // The per-turn command ledger. It has to outlive the process: the whole point is that a turn a restart
      // cut in half is reconciled by the NEXT process, from the lines the job store still holds.
      commandAudits: readAudits(raw.commandAudits),
    };
  } catch (err) {
    // A missing file is `found: false`; a file that cannot be READ is an error the caller journals. An
    // unreadable store starts the assistant empty rather than refusing to boot.
    return { found: false, migrated: false, error: String((err && err.message) || err) };
  }
}

/**
 * Write the whole snapshot, tmp+rename, stamped with the current schema version.
 * @param snapshot.settings - the keys to persist, and ONLY those: a knob the caller leaves out is absent from
 *   the file on purpose (see the `present` half of readAssistantFile), so this writer never re-stamps a knob
 *   that was not there before.
 * @param snapshot.aggressive - the mode's own record, written as it is stored: `{ on, at, saved }` while the
 *   mode is on, `{ on: false }` when it is off. It lives in this file and not in the page, which is what lets
 *   the mode be switched off correctly after a panel restart.
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
        aggressive: snapshot.aggressive && typeof snapshot.aggressive === "object" ? snapshot.aggressive : { on: false },
        notes: snapshot.notes,
        rules: snapshot.rules,
        watches: snapshot.watches,
        alerts: (snapshot.alerts || []).slice(-ALERT_CAP),
        journal: (snapshot.journal || []).slice(-JOURNAL_CAP),
        harvested: [...(snapshot.harvested || [])].slice(-HARVESTED_CAP),
        // The carried-line ledger, capped on the way out exactly as on the way in (see the note at the top).
        carriedLines: (snapshot.carriedLines || []).slice(-CARRIED_CAP),
        // The debt list, capped on the way out exactly as on the way in (see the note at the top).
        spawnIntents: (snapshot.spawnIntents || []).slice(-SPAWN_INTENT_CAP),
        terminalWakes: [...(snapshot.terminalWakes || new Map())].slice(-TERMINAL_CAP),
        restartWakes: [...(snapshot.restartWakes || [])].slice(-RESTART_CAP),
        commandAudits: (snapshot.commandAudits || []).slice(-COMMAND_AUDIT_CAP),
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
