// One assistant's own settings file: the knobs, the rule levels, the default role prompt and the ordered
// escalation list that belong to THIS assistant, kept beside that assistant's charter.
//
// Why a file per assistant rather than a block in assistant.json: Assistant #1's settings, rules, scratchpad and
// charter stay exactly where they were (state/assistant.json, state/assistant-charter.md) and are not migrated.
// A second assistant already owns `state/assistants/assistant-N/charter.md`; this is its sibling,
// `state/assistants/assistant-N/settings.json`, so one directory holds everything that assistant remembers.
// #1 may carry this file too, but only the fields its own store has never held — the role prompt and the
// escalation list. Its knobs keep living in assistant.json, read and written by ./store-file.js, unchanged.
//
// The file is deliberately small and self-describing: a reader who opens it can see which values they chose,
// and nothing here is a copy of today's defaults — a knob this file does not carry keeps following the default
// it would have had, exactly as assistant.json's `present` discipline does.
//
// There is no whitelist in here any more. Which projects an assistant was shown and which trees it could start a
// worker in used to be two lists on this file; the SPAWN switch is the only gate now, and the tree a spawn cuts
// belongs to the assistant whose turn wrote the line (lib/assistant.js `startSpawn` -> the panel's owner store).
// A file written by the older build is read with `whitelists` simply dropped.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pickRules, pickSettings } from "./config.js";
import { reasonOf } from "./read.js";

export const PROFILE_VERSION = 1;
// The default role prompt rides in the preamble of every turn of that assistant, so it is bounded like a rule
// set rather than like a charter: long enough for a real instruction, short enough not to become a second charter.
export const PROMPT_CAP = 8000;
// The Director's own clock, in minutes. 0 is "no cadence" and is what every other assistant carries; a role that
// needs a standing wake (the Assistant Director, every twenty minutes) writes its number here when the assistant
// is created. The sentry reads it — there is no second timer — so the interval belongs to the assistant, not to
// the panel, and an assistant removed or switched off cannot leave a timer behind.
export const WAKE_EVERY_MAX_MINUTES = 1440;
export const pickWakeEvery = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(WAKE_EVERY_MAX_MINUTES, Math.round(n));
};

/** Where one assistant's settings file lives, relative to the state directory (beside its charter). */
export const profileRelFor = (id) => path.join("assistants", String(id || ""), "settings.json");

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) : t;
};

// The escalation list: the assistants this one would hand a subject to, in the order it would try them.
//
// It is stored, ordered and INERT. Nothing reads it yet - a wake still goes to the tree's owner and to nobody
// else - so an assistant with a list behaves exactly like one without. It is here because the split between the
// panel's watchdog and one assistant's own settings needs somewhere for this list to live before the behaviour
// that walks it exists; the pane says as much rather than implying a hand-over that never happens.
//
// An id is an assistant record ("assistant-2"). Anything else, a duplicate and an assistant's own id are dropped
// rather than carried: the file may be hand-edited, and a list that names a stranger is a refusal waiting to
// happen in a later branch.
export const ESCALATION_MAX = 8;

export function pickEscalation(value, self = "") {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  const out = [];
  const seen = new Set();
  const own = String(self || "").trim();
  for (const part of raw) {
    const id = clip(String(part ?? "").trim(), 60);
    if (!/^assistant-[0-9]+$/.test(id)) continue;
    if (id === own || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= ESCALATION_MAX) break;
  }
  return out;
}

/**
 * The profile an assistant has before it has a file: no knobs of its own, no prompt, no escalation list and no
 * cadence.
 */
export const EMPTY_PROFILE = { settings: {}, rules: {}, prompt: "", escalateTo: [], wakeEveryMinutes: 0 };

// Who wrote the default role prompt this assistant runs on. ABSENT means the reader's: every file written before
// this field existed, and every save from the Role tab, carries no stamp, and absence is the safe reading (a
// consolidation may not overwrite it). Only a pass that writes the prompt from a rule list stamps "assistant".
const PROMPT_BY = new Set(["reader", "assistant"]);
export const pickPromptBy = (value) => (PROMPT_BY.has(String(value || "")) ? String(value) : null);

/**
 * One profile, normalised. Unknown keys, wrong types and over-long entries are dropped rather than trusted: this
 * reads a file a reader may hand-edit, and every value here ends up either in a preamble or in a knob. A file that
 * still carries the retired `whitelists` key loses it here, which is the whole migration.
 */
export function pickProfile(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const profile = {
    settings: pickSettings(p.settings && typeof p.settings === "object" ? p.settings : {}),
    rules: pickRules(p.rules && typeof p.rules === "object" ? p.rules : {}),
    prompt: String(p.prompt ?? "").slice(0, PROMPT_CAP),
    escalateTo: pickEscalation(p.escalateTo),
    // The standing wake's interval. Absent (or 0) is no cadence, which is what every assistant but the Director
    // has; the number is read by the sentry's own pass, never by a timer of its own.
    wakeEveryMinutes: pickWakeEvery(p.wakeEveryMinutes),
  };
  // The prompt's provenance is written only when a consolidation set the prompt, so it is added only when the file
  // carries it: an absent key stays absent (the reader's prompt), and a profile this build never touched keeps the
  // exact shape it had.
  const promptBy = pickPromptBy(p.promptBy);
  if (promptBy) profile.promptBy = promptBy;
  if (p.promptAt) profile.promptAt = String(p.promptAt);
  const promptFrom = Array.isArray(p.promptFrom) ? p.promptFrom.map((id) => String(id)).slice(0, 40) : [];
  if (promptFrom.length) profile.promptFrom = promptFrom;
  return profile;
}

/**
 * Read one assistant's settings file.
 * @returns {{ found: boolean, error: string|null, profile: object }} — a missing file is not an error: it is an
 *   assistant that has not chosen anything yet, so it falls back to the defaults and to `EMPTY_PROFILE`.
 */
export function readProfileFile(file) {
  if (!existsSync(file)) return { found: false, error: null, profile: { ...EMPTY_PROFILE } };
  try {
    return { found: true, error: null, profile: pickProfile(JSON.parse(readFileSync(file, "utf8"))) };
  } catch (err) {
    return { found: false, error: reasonOf(err), profile: { ...EMPTY_PROFILE } };
  }
}

/**
 * THE RETIRED FRAME, read off disk. `dock` was one assistant's own field until the pane became the panel's single
 * choice; this answers the value a file still carries, or null for a file that never had one (or cannot be read).
 * It is the one-time migration's read — no other code in this build looks at a per-assistant frame again — and
 * `dropLegacyDock` below is the write that takes the key out of the file.
 */
export function readLegacyDock(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const value = raw && typeof raw === "object" ? raw.dock : null;
    return value === "docked" || value === "floating" ? value : null;
  } catch {
    return null;
  }
}

/**
 * TAKE THE RETIRED FRAME OUT of one assistant's settings file. Returns what the file held, so the migration can
 * report whose value won — or `had: null` when there was nothing to remove. A file whose ONLY content was the
 * frame is deleted rather than left as an empty husk: absence is what "this assistant chose nothing of its own"
 * has always looked like, and the file is created again by the first field the reader saves.
 */
export function dropLegacyDock(file) {
  try {
    if (!existsSync(file)) return { had: null, error: null, deleted: false };
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || !Object.prototype.hasOwnProperty.call(raw, "dock")) {
      return { had: null, error: null, deleted: false };
    }
    const had = readLegacyDock(file);
    const rest = { ...raw };
    delete rest.dock;
    // What is left that the reader chose: a non-empty object or list, a number, a stamped name. An empty `settings`
    // or `rules` object is the shape a save leaves behind, not a choice, so it does not keep an otherwise empty file.
    const chosen = (v) =>
      Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : v != null && v !== "";
    const carries = ["settings", "rules", "escalateTo", "wakeEveryMinutes", "promptBy", "promptAt", "promptFrom"].some((k) => chosen(rest[k]));
    const keepsPrompt = String(rest.prompt ?? "").trim().length > 0;
    if (!carries && !keepsPrompt) {
      unlinkSync(file);
      return { had, error: null, deleted: true };
    }
    rest.savedAt = new Date().toISOString();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(rest, null, 1));
    renameSync(tmp, file);
    return { had, error: null, deleted: false };
  } catch (err) {
    return { had: null, error: reasonOf(err), deleted: false };
  }
}

/**
 * Write one assistant's settings file, tmp+rename. Only the halves the caller hands over are written, so the same
 * writer serves an extra assistant (all four) and Assistant #1 (prompt and escalation only, since its knobs stay in
 * assistant.json). A write failure is returned, never thrown: the caller journals it.
 */
export function writeProfileFile(file, profile = {}) {
  try {
    const body = { version: PROFILE_VERSION, savedAt: new Date().toISOString() };
    if ("settings" in profile) body.settings = pickSettings(profile.settings || {});
    if ("rules" in profile) body.rules = pickRules(profile.rules || {});
    body.prompt = String(profile.prompt ?? "").slice(0, PROMPT_CAP);
    // The prompt's provenance travels with a non-empty prompt only: an assistant with no prompt has nothing to
    // attribute, and a stored `promptBy: "assistant"` beside an empty string would say a consolidation wrote a
    // contract that is not there.
    if (body.prompt) {
      const by = pickPromptBy(profile.promptBy);
      if (by) body.promptBy = by;
      if (profile.promptAt) body.promptAt = String(profile.promptAt);
      const from = Array.isArray(profile.promptFrom) ? profile.promptFrom.map((id) => String(id)).slice(0, 40) : [];
      if (from.length) body.promptFrom = from;
    }
    // Only when the reader has one. An empty list is the ABSENCE of the key, not an empty array in the file: that is
    // what keeps Assistant #1's file byte-identical until the reader uses a field assistant.json never held.
    const escalateTo = pickEscalation(profile.escalateTo);
    if (escalateTo.length) body.escalateTo = escalateTo;
    // A cadence of 0 is the absence of the key, not a stored zero: an assistant that was never given a standing wake
    // keeps a file that says nothing about one, and a role that hands its assistant a number writes only that number.
    const wakeEveryMinutes = pickWakeEvery(profile.wakeEveryMinutes);
    if (wakeEveryMinutes > 0) body.wakeEveryMinutes = wakeEveryMinutes;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 1));
    renameSync(tmp, file);
    return { error: null };
  } catch (err) {
    return { error: reasonOf(err) };
  }
}
