// The assistants: one record per assistant the float can show — its id, its name, the role it runs, its own
// Hermes thread, and (for every assistant but the first) its own rules.
//
// Assistant #1 is deliberately DIFFERENT from the rest, and this store only NAMES it. Its settings, rules,
// scratchpad and charter still live in `state/assistant.json` and `state/assistant-charter.md`, exactly where
// they were before this file existed, and its thread is still the fixed `panel-assistant`; a second assistant
// gets the next number, a thread of its own (`panel-assistant-2`) and a charter of its own under
// `state/assistants/assistant-2/charter.md`, copied from the role it was created from.
//
// That asymmetry is the point rather than an accident: item one of introducing roles was that the assistant the
// reader already has keeps working, byte for byte and route for route, so its files are not migrated and its
// record carries no file of its own — `charterFile` (lib/paths.js) stays the one authority for where that
// charter is, and an extra assistant's charter is resolved beside it at use time rather than frozen as an
// absolute path into a data directory the reader may later move.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_MANAGER_ID } from "./roles.js";
import { reasonOf } from "./assistant/read.js";

export const ASSISTANTS_VERSION = 1;
export const PRIMARY_ASSISTANT = "assistant-1";
export const PRIMARY_THREAD = "panel-assistant";
// Six is a board's worth of assistants, not a farm: each one is a thread the reader has to talk to, and the
// point of the feature is a second opinion (a manager and, say, a reviewer), not a crowd.
export const ASSISTANT_MAX = 6;
export const RULE_MAX = 40;

const iso = (at) => new Date(at || Date.now()).toISOString();
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) : t;
};

/** `assistant-2` -> `2`. The number is the id's, so a name and a thread are derived rather than stored twice. */
export const assistantNumber = (id) => String(id || "").replace(/^assistant-/, "");

/** The Hermes thread an assistant's turns run on. #1 keeps the id the panel has always used. */
export const threadFor = (id) =>
  id === PRIMARY_ASSISTANT ? PRIMARY_THREAD : `panel-assistant-${assistantNumber(id)}`;

export const nameFor = (id) => `Assistant #${assistantNumber(id)}`;

/** Where an extra assistant's charter lives, relative to the state directory (beside the primary's charter). */
export const charterRelFor = (id) => path.join("assistants", id, "charter.md");

export function seedAssistants({ at = new Date() } = {}) {
  return [
    {
      id: PRIMARY_ASSISTANT,
      name: nameFor(PRIMARY_ASSISTANT),
      roleId: AGENT_MANAGER_ID,
      threadId: PRIMARY_THREAD,
      rules: [],
      createdAt: iso(at),
    },
  ];
}

export function writeAssistantsFile(file, assistants = []) {
  const body = JSON.stringify({ version: ASSISTANTS_VERSION, assistants }, null, 1);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch (err) {
    const e = new Error(`could not write ${file}: ${reasonOf(err)}`);
    e.code = "assistants-write-failed";
    throw e;
  }
  return assistants;
}

// A record without an id is dropped; the primary is PUT BACK if the file has lost it, because a panel with no
// first assistant has no session at all and the float would open on an empty row. Rules are sanitised to the
// shape the Settings pane draws: {id, text, by, at}.
function normaliseAssistants(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.assistants) ? raw.assistants : [];
  const out = [];
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const id = String(r.id || "").trim();
    if (!/^assistant-\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: clip(String(r.name || "").trim() || nameFor(id), 60),
      roleId: String(r.roleId || AGENT_MANAGER_ID),
      threadId: id === PRIMARY_ASSISTANT ? PRIMARY_THREAD : String(r.threadId || threadFor(id)),
      ...(id === PRIMARY_ASSISTANT ? {} : { charterRel: String(r.charterRel || charterRelFor(id)) }),
      rules: (Array.isArray(r.rules) ? r.rules : [])
        .filter((x) => x && typeof x.text === "string" && x.text.trim())
        .slice(-RULE_MAX)
        .map((x) => ({ id: String(x.id || randomUUID().slice(0, 8)), text: clip(x.text, 400), at: x.at || null, by: x.by || "reader" })),
      createdAt: r.createdAt || null,
    });
  }
  out.sort((a, b) => Number(assistantNumber(a.id)) - Number(assistantNumber(b.id)));
  if (!out.some((a) => a.id === PRIMARY_ASSISTANT)) out.unshift(...seedAssistants());
  return out;
}

/**
 * Read the assistant records, seeding the primary one when there is no file yet.
 * @returns {{ assistants: object[], seeded: boolean, error: string|null }}
 */
export function readAssistantsFile(file, { at = new Date(), seed = true } = {}) {
  try {
    if (!existsSync(file)) {
      if (!seed) return { assistants: seedAssistants({ at }), seeded: false, error: null };
      const assistants = seedAssistants({ at });
      writeAssistantsFile(file, assistants);
      return { assistants, seeded: true, error: null };
    }
    const assistants = normaliseAssistants(JSON.parse(readFileSync(file, "utf8")));
    return { assistants, seeded: false, error: null };
  } catch (err) {
    return { assistants: seedAssistants({ at }), seeded: false, error: reasonOf(err) };
  }
}

export const findAssistant = (assistants = [], id) => assistants.find((a) => a.id === id) || null;
export const isAssistantId = (id) => /^assistant-\d+$/.test(String(id || ""));

/**
 * The next assistant, built from a role. The charter is a COPY: two assistants running one role are two jobs
 * with two memories, and the item this feature was asked for says so — Assistant #2's edit must not change what
 * Assistant #1 is told. The copy is made by the caller (it owns file IO and the cap); this returns the record.
 */
export function nextAssistantRecord({ assistants = [], role, at = new Date() } = {}) {
  const used = new Set(assistants.map((a) => a.id));
  let n = 2;
  while (used.has(`assistant-${n}`)) n += 1;
  const id = `assistant-${n}`;
  return {
    id,
    name: nameFor(id),
    roleId: String(role?.id || AGENT_MANAGER_ID),
    threadId: threadFor(id),
    charterRel: charterRelFor(id),
    rules: [],
    createdAt: iso(at),
  };
}

/** The rules a record owns. #1's live in assistant.json, so its record's list is empty and unused. */
export function addRuleTo(record, text, { by = "reader", at = new Date() } = {}) {
  const t = clip(String(text ?? "").trim(), 400);
  if (!t) throw Object.assign(new Error("a rule needs some text"), { code: "rule-invalid" });
  const rules = Array.isArray(record.rules) ? record.rules : [];
  if (!rules.some((r) => r.text === t)) {
    rules.push({ id: randomUUID().slice(0, 8), text: t, at: iso(at), by });
    record.rules = rules.slice(-RULE_MAX);
  }
  return record.rules;
}

export function removeRuleFrom(record, id) {
  record.rules = (Array.isArray(record.rules) ? record.rules : []).filter((r) => r.id !== id);
  return record.rules;
}
