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
import { ASSISTANT_AGENT_MANAGER_ID } from "./roles.js";
import { reasonOf } from "./assistant/read.js";

export const ASSISTANTS_VERSION = 1;
export const PRIMARY_ASSISTANT = "assistant-1";
export const PRIMARY_THREAD = "panel-assistant";
// Six is a board's worth of assistants, not a farm: each one is a thread the reader has to talk to, and the
// point of the feature is a second opinion (a manager and, say, a reviewer), not a crowd.
export const ASSISTANT_MAX = 6;
// The cap on one assistant's standing rules. Over it the OLDEST rule the ASSISTANT wrote is trimmed — never a
// reader's rule: the cap exists so an agent that keeps restating itself cannot crowd out the reader's answers,
// and a trim that took one of the reader's would be that same eviction by another route. `withRuleAdded` is the
// one implementation of it, so the harvest's guard and the store's own writer cannot drift apart again.
export const RULE_MAX = 40;
// What a full list of the reader's own rules answers when there is nothing of the assistant's to trade.
export const RULE_FULL_MESSAGE =
  `the list already holds ${RULE_MAX} rules and every one of them is the reader's — nothing of the assistant's own to trim, so delete a rule first`;
// A name is a TAB LABEL: 40 characters is what fits beside the panel's own tabs. The cap lives here rather than in the
// page because a hand-written POST must not be able to write a longer one.
export const ASSISTANT_NAME_MAX = 40;

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

// A thread id is a Hermes session id, so it has to survive being one: no spaces, no separators, bounded length.
// The panel only ever writes ids this rule accepts, and a hand-edited file that carries anything else falls back to
// the assistant's derived thread rather than sending a run to a session id the gateway cannot hold.
export const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const isThreadId = (t) => THREAD_ID_RE.test(String(t || ""));

/**
 * A hard restart starts a FRESH thread rather than reusing the old one, and the name says so: `<base>-r<gen>`.
 * `-r<n>` cannot collide with another assistant's derived thread (`panel-assistant-2` belongs to #2, never to #1's
 * second generation), which a bare counter would. Gen 1 is the base itself; a restart moves to gen 2 and up.
 */
export const restartedThreadFor = (base, gen) => (Number(gen) <= 1 ? base : `${base}-r${Number(gen)}`);

/** The generation a thread id names, against its base: 1 for the base itself, n for `<base>-rn`, 0 for anything else. */
export function threadGenOf(thread, base) {
  const t = String(thread || "");
  if (t === String(base || "")) return 1;
  const m = new RegExp(`^${String(base || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-r(\\d+)$`).exec(t);
  return m ? Number(m[1]) : 0;
}

export const nameFor = (id) => `Assistant #${assistantNumber(id)}`;

/**
 * The one reading of a name a reader typed. Trimmed, folded to one line (a tab label has no second line) and capped at
 * ASSISTANT_NAME_MAX; an empty result is the caller's to refuse. Duplicates are deliberately allowed: the id is what
 * tells two assistants apart, so two of them may share a name.
 */
export const pickAssistantName = (raw) =>
  clip(
    String(raw ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    ASSISTANT_NAME_MAX,
  );

/** Where an extra assistant's charter lives, relative to the state directory (beside the primary's charter). */
export const charterRelFor = (id) => path.join("assistants", id, "charter.md");

export function seedAssistants({ at = new Date() } = {}) {
  return [
    {
      id: PRIMARY_ASSISTANT,
      name: nameFor(PRIMARY_ASSISTANT),
      roleId: ASSISTANT_AGENT_MANAGER_ID,
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
      roleId: String(r.roleId || ASSISTANT_AGENT_MANAGER_ID),
      // #1 KEEPS THE ID THE PANEL ALWAYS USED unless a hard restart moved it: the old `id === PRIMARY ? PRIMARY_THREAD`
      // rule silently put a restarted #1 back on the thread it had just left on the next reload, so the press looked
      // like it had done nothing after a panel restart. Any id the panel itself could have written is kept; anything
      // else (a hand-edited file, a spacer) falls back to the assistant's derived thread.
      threadId: isThreadId(r.threadId) ? String(r.threadId) : id === PRIMARY_ASSISTANT ? PRIMARY_THREAD : threadFor(id),
      // The threads this assistant has hard-restarted away from, newest first. Display and attribution only: its
      // turns and its live check read `threadId`, while the message board and the board's own "is this a worker?"
      // test still recognise the old thread as this assistant's rather than as an agent with an odd name.
      ...(Array.isArray(r.previousThreads) && r.previousThreads.length
        ? { previousThreads: r.previousThreads.filter(isThreadId).slice(0, 5) }
        : {}),
      ...(id === PRIMARY_ASSISTANT ? {} : { charterRel: String(r.charterRel || charterRelFor(id)) }),
      rules: (Array.isArray(r.rules) ? r.rules : [])
        .filter((x) => x && typeof x.text === "string" && x.text.trim())
        .slice(-RULE_MAX)
        .map((x) => ({ id: String(x.id || randomUUID().slice(0, 8)), text: clip(x.text, 400), at: x.at || null, by: x.by || "reader" })),
      // When the standing rules were copied out of Assistant #1's list into this one's. Absent on a record written
      // before the split, which is how the boot pass tells "never copied" from "the reader deleted them all".
      ...(r.rulesSeededAt ? { rulesSeededAt: String(r.rulesSeededAt) } : {}),
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
 * The assistants that still name ONE role, by id. The roster is the authority a role delete is judged against: an
 * assistant's record stores `roleId`, so a role nothing names is a role nothing can resolve.
 */
export const assistantsRunning = (assistants = [], roleId) =>
  (Array.isArray(assistants) ? assistants : []).filter((a) => String(a?.roleId || "") === String(roleId || "")).map((a) => String(a.id));

/**
 * Re-point every record naming a RETIRED role id onto the id that replaced it, and write the roster once.
 *
 * This is the assistants half of the role upgrade (`lib/roles.js` `upgradeRetiredRoles` renames the ROLE record; a
 * record pointing at the old id would then resolve nothing). It is a repoint, not a re-charter: the assistant keeps
 * its own copy of the charter its file holds, so a role id moving never rewrites one byte of what that assistant is
 * told. Idempotent — a record already on the new id is left alone and nothing is written.
 * @param map - `{ <retired id>: <new id> }`.
 * @returns {{ id: string, from: string, to: string }[]} the records that moved.
 */
export function repointRetiredRoles(file, assistants = [], map = {}) {
  const moved = [];
  for (const rec of Array.isArray(assistants) ? assistants : []) {
    if (!rec) continue;
    const from = String(rec.roleId || "");
    const to = map[from];
    if (!to || to === from) continue;
    rec.roleId = String(to);
    moved.push({ id: String(rec.id), from, to: String(to) });
  }
  if (moved.length) writeAssistantsFile(file, assistants);
  return moved;
}

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
    roleId: String(role?.id || ASSISTANT_AGENT_MANAGER_ID),
    threadId: threadFor(id),
    charterRel: charterRelFor(id),
    rules: [],
    createdAt: iso(at),
  };
}

/**
 * The list with one rule on the end and the cap held. Over RULE_MAX exactly one rule makes room, and it is the
 * OLDEST rule the ASSISTANT wrote — the reader's rules are not the assistant's to drop, and a cap that trimmed
 * them would let an agent erase the reader's answers by restating itself forty times.
 *
 * `refused` is true only when the list is full and holds nothing the assistant wrote: there is no rule to trade,
 * so the caller says so rather than silently losing one of the reader's.
 * @returns {{rules: object[], trimmed: object|null, refused: boolean}}
 */
export function withRuleAdded(rules = [], rule, cap = RULE_MAX) {
  const out = Array.isArray(rules) ? [...rules] : [];
  out.push(rule);
  let trimmed = null;
  while (out.length > cap) {
    // The oldest assistant rule is the first in the list: rules are appended, so the array is chronological.
    // `r !== rule` keeps the rule being added out of its own trim — the line that lands is never the one dropped.
    const i = out.findIndex((r) => r && r.by === "assistant" && r !== rule);
    if (i === -1) return { rules: Array.isArray(rules) ? rules : [], trimmed: null, refused: true };
    trimmed = out[i];
    out.splice(i, 1);
  }
  return { rules: out, trimmed, refused: false };
}

/** The rules a record owns. #1's live in assistant.json, so its record's list is empty and unused. */
export function addRuleTo(record, text, { by = "reader", at = new Date() } = {}) {
  const t = clip(String(text ?? "").trim(), 400);
  if (!t) throw Object.assign(new Error("a rule needs some text"), { code: "rule-invalid" });
  const rules = Array.isArray(record.rules) ? record.rules : [];
  if (!rules.some((r) => r.text === t)) {
    const added = withRuleAdded(rules, { id: randomUUID().slice(0, 8), text: t, at: iso(at), by });
    if (added.refused) throw Object.assign(new Error(RULE_FULL_MESSAGE), { code: "rule-full" });
    record.rules = added.rules;
  }
  return record.rules;
}

export function removeRuleFrom(record, id) {
  record.rules = (Array.isArray(record.rules) ? record.rules : []).filter((r) => r.id !== id);
  return record.rules;
}
