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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pickRules, pickSettings } from "./config.js";
import { reasonOf } from "./read.js";

export const PROFILE_VERSION = 1;
// The default role prompt rides in the preamble of every turn of that assistant, so it is bounded like a rule
// set rather than like a charter: long enough for a real instruction, short enough not to become a second charter.
export const PROMPT_CAP = 8000;

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

/** The profile an assistant has before it has a file: no knobs of its own, no prompt, no escalation list. */
export const EMPTY_PROFILE = { settings: {}, rules: {}, prompt: "", escalateTo: [] };

/**
 * One profile, normalised. Unknown keys, wrong types and over-long entries are dropped rather than trusted: this
 * reads a file a reader may hand-edit, and every value here ends up either in a preamble or in a knob. A file that
 * still carries the retired `whitelists` key loses it here, which is the whole migration.
 */
export function pickProfile(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    settings: pickSettings(p.settings && typeof p.settings === "object" ? p.settings : {}),
    rules: pickRules(p.rules && typeof p.rules === "object" ? p.rules : {}),
    prompt: String(p.prompt ?? "").slice(0, PROMPT_CAP),
    escalateTo: pickEscalation(p.escalateTo),
  };
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
    // Only when the reader has one. An empty list is the ABSENCE of the key, not an empty array in the file: that is
    // what keeps Assistant #1's file byte-identical until the reader uses a field assistant.json never held.
    const escalateTo = pickEscalation(profile.escalateTo);
    if (escalateTo.length) body.escalateTo = escalateTo;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 1));
    renameSync(tmp, file);
    return { error: null };
  } catch (err) {
    return { error: reasonOf(err) };
  }
}
