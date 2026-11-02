// One assistant's own settings file: the knobs, the rule levels, the default role prompt and the two optional
// whitelists that belong to THIS assistant, kept beside that assistant's charter.
//
// Why a file per assistant rather than a block in assistant.json: Assistant #1's settings, rules, scratchpad and
// charter stay exactly where they were (state/assistant.json, state/assistant-charter.md) and are not migrated.
// A second assistant already owns `state/assistants/assistant-N/charter.md`; this is its sibling,
// `state/assistants/assistant-N/settings.json`, so one directory holds everything that assistant remembers.
// #1 may carry this file too, but only the two fields its own store has never held — the role prompt and the
// whitelists. Its knobs keep living in assistant.json, read and written by ./store-file.js, unchanged.
//
// The file is deliberately small and self-describing: a reader who opens it can see which values they chose,
// and nothing here is a copy of today's defaults — a knob this file does not carry keeps following the default
// it would have had, exactly as assistant.json's `present` discipline does.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pickRules, pickSettings } from "./config.js";
import { reasonOf } from "./read.js";

export const PROFILE_VERSION = 1;
// The default role prompt rides in the preamble of every turn of that assistant, so it is bounded like a rule
// set rather than like a charter: long enough for a real instruction, short enough not to become a second charter.
export const PROMPT_CAP = 8000;
// A whitelist is a short list of names a reader typed, not an inventory: 24 entries of 200 characters is more
// than any board's worth of projects, and the cap is what keeps a paste from becoming the whole preamble.
export const WHITELIST_MAX = 24;
export const WHITELIST_ENTRY_MAX = 200;
// "*" is the whole list in one character. It is matched as an entry, never as a prefix.
export const WHITELIST_ALL = "*";

/** Where one assistant's settings file lives, relative to the state directory (beside its charter). */
export const profileRelFor = (id) => path.join("assistants", String(id || ""), "settings.json");

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) : t;
};

// One comparable form for a name: case, separator and a trailing slash are all the differences a reader's typing
// and Windows' paths introduce. Nothing else is normalised — a name that differs in a word is a different tree.
export const normName = (s) => String(s ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * The list a reader typed, as stored: one entry per item, commas and newlines both separate, blanks dropped, and
 * duplicates folded case-insensitively. Accepted as a string (what the box posts) or as an array (what the file
 * holds). `*` survives as its own entry; it is never expanded here, so the file says what the reader wrote.
 */
export function parseWhitelist(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,\n\r]+/);
  const out = [];
  const seen = new Set();
  for (const part of raw) {
    if (part === null || part === undefined) continue;
    const entry = clip(String(part).trim(), WHITELIST_ENTRY_MAX);
    if (!entry) continue;
    const key = normName(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= WHITELIST_MAX) break;
  }
  return out;
}

/** How a stored list reads back in the box: comma separated, `*` as itself, empty for "no list". */
export const whitelistText = (list) => (Array.isArray(list) ? list.join(", ") : "");

/**
 * The same list in a sentence, for a journal line or a refusal: "all (no list)" and "all (*)" are different
 * statements, and a reader who typed a name wants to see the names back rather than a count.
 */
export function describeList(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return "all (no list — every one)";
  if (items.some((e) => String(e).trim() === WHITELIST_ALL)) return "all (*)";
  const shown = items.slice(0, 6).join(", ");
  return `${items.length} entr${items.length === 1 ? "y" : "ies"} (${shown}${items.length > 6 ? ", …" : ""})`;
}

/**
 * Does a name appear on a list? Three answers are "yes" before anything is compared, and each of them is a
 * deliberate reading of the reader's instruction:
 *
 *   - an EMPTY list means every name. The item that asked for this says neither whitelist is required, so a blank
 *     box must not hide every project from an assistant that was working fine before the box existed.
 *   - "*" anywhere in the list means every name, whether it was typed alone or beside real entries.
 *   - otherwise one entry has to equal one of the names offered. Names are compared whole (never as a prefix or a
 *     substring: "agent" must not match "agent-worktree-gui"), case-insensitively, with separators and a trailing
 *     slash normalised — which is why the caller passes every name a target is known by (as written, its path, its
 *     directory name, its project) rather than this function guessing.
 */
export function whitelistMatches(entries, names) {
  const list = Array.isArray(entries) ? entries : parseWhitelist(entries);
  if (!list.length) return true;
  if (list.some((e) => String(e).trim() === WHITELIST_ALL)) return true;
  const want = new Set((Array.isArray(names) ? names : [names]).map(normName).filter(Boolean));
  if (!want.size) return false;
  return list.some((e) => want.has(normName(e)));
}

/** The profile an assistant has before it has a file: no knobs of its own, no prompt, and both lists open. */
export const EMPTY_PROFILE = { settings: {}, rules: {}, prompt: "", whitelists: { projects: [], worktrees: [] } };

/**
 * One profile, normalised. Unknown keys, wrong types and over-long entries are dropped rather than trusted: this
 * reads a file a reader may hand-edit, and every value here ends up either in a preamble or in a knob.
 */
export function pickProfile(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const w = p.whitelists && typeof p.whitelists === "object" ? p.whitelists : {};
  return {
    settings: pickSettings(p.settings && typeof p.settings === "object" ? p.settings : {}),
    rules: pickRules(p.rules && typeof p.rules === "object" ? p.rules : {}),
    prompt: String(p.prompt ?? "").slice(0, PROMPT_CAP),
    whitelists: { projects: parseWhitelist(w.projects), worktrees: parseWhitelist(w.worktrees) },
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
 * writer serves an extra assistant (all four) and Assistant #1 (prompt and whitelists only, since its knobs stay in
 * assistant.json). A write failure is returned, never thrown: the caller journals it.
 */
export function writeProfileFile(file, profile = {}) {
  try {
    const body = { version: PROFILE_VERSION, savedAt: new Date().toISOString() };
    if ("settings" in profile) body.settings = pickSettings(profile.settings || {});
    if ("rules" in profile) body.rules = pickRules(profile.rules || {});
    body.prompt = String(profile.prompt ?? "").slice(0, PROMPT_CAP);
    body.whitelists = {
      projects: parseWhitelist(profile.whitelists?.projects),
      worktrees: parseWhitelist(profile.whitelists?.worktrees),
    };
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 1));
    renameSync(tmp, file);
    return { error: null };
  } catch (err) {
    return { error: reasonOf(err) };
  }
}
