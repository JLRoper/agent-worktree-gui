// The standing rules: the answers the reader has written down, carried into every turn's preamble, and the one
// list a model may add to but never overwrite.
//
// A rule is {id, text, at, by} — four fields, and `by` is what tells the reader's own answers from the ones the
// assistant wrote for itself. There is no store of their own: Assistant #1's list is the `rules` array in
// assistant.json, and every other assistant carries its own copy on its record in assistants.json. That is the
// whole shape, and it is why this module is a list of decisions rather than a file reader like ./queue.js: the
// two files belong to their stores, and lib/assistants.js already owns the record-level writes (`addRuleTo`,
// `removeRuleFrom`, `withRuleAdded`).
//
// What lives HERE is everything that decides what a list becomes:
//
//   · the 400-character text every rule is stored as (`ruleText`) and the refusal of an empty one;
//   · the exact-duplicate check — the same sentence twice is one rule, not two;
//   · the assistant's near-duplicate refinement: a model restates itself with a word changed ("is interrupted" /
//     "was interrupted"), and for its OWN rules that is a refinement of the earlier rule rather than a second
//     one. The reader's rules are never touched this way (`refinedRule`);
//   · the cap: 40 rules, and the one that makes room is the OLDEST the assistant wrote, never one of the
//     reader's. `withRuleAdded` makes the trade and this module is the one place that calls it, so the RULE:
//     harvest, #1's store and an extra assistant's record all trim by the same rule (`addRuleToList`);
//   · the seeding pass that copies #1's list onto an extra assistant exactly once (`seedRulesFrom`), and the
//     resolution of "which list is this assistant's" (`rulesOf`).
//
// The class keeps the method names the routes, the tabs and the harnesses call — `addRule`, `addRuleFor`,
// `removeRuleFor`, `rulesFor`, `seedRulesFor`, `loadAssistantRules`, `removeRule` — and each is a delegation to
// the matching door below. The doors make the same calls on the instance the class would have made itself: the
// journal line, the charter entry, `persist()` and `emit()`. That is the ./queue.js split read the other way
// round (there the class owns the file and the module the transitions; here the class owns the two stores and
// this module the list), and it is what keeps the behaviour unchanged: the same journal text, the same charter
// entry, the same one persist per add.
//
// Nothing here reads the job store, spawns a turn or talks HTTP.
import { randomUUID } from "node:crypto";
import { PRIMARY_ASSISTANT, RULE_FULL_MESSAGE, addRuleTo, removeRuleFrom, withRuleAdded, writeAssistantsFile } from "../assistants.js";
import { words } from "./match.js";
import { clip, nowIso, reasonOf } from "./read.js";

// The text a rule is stored as: 400 characters, clipped by the same `clip` the rest of the file uses, and NOT
// trimmed — "   " is truthy and has always been storable through the reader's door, so a change here would be a
// change in what the list accepts. `addRuleTo` (the record's writer) trims, and that asymmetry is old; this
// module preserves it rather than quietly unifying the two.
export const RULE_TEXT_MAX = 400;
// How close two sentences have to be, by shared-word ratio, before the assistant's new rule is read as a
// restatement of its own earlier one. Jaccard over the words `match.js` keeps.
export const RULE_REFINE_RATIO = 0.75;
// How many rules ONE TURN is shown. The store holds 40; the preamble is the head of every request, so the text a
// turn carries is capped well below it, and `briefingRules` decides which rules make the cut.
export const RULE_BRIEFING_MAX = 12;
// How much of each rule the briefing carries. This is the INJECTION clip, not the 400-character store cap above: a
// rule longer than this rides every turn as a clipped sentence, so this - not `RULE_TEXT_MAX` - is the space one
// seat reserves. The Prompt tab's budget diagram reads it, and so does the list in lib/assistant.js; a second
// literal there would let the picture and the prompt disagree.
export const RULE_BRIEFING_CHARS = 200;

/** The stored text of a rule: clipped to the cap, nothing else. */
export const ruleText = (text) => clip(text, RULE_TEXT_MAX);

/**
 * The rules one turn is shown: the reader's hold their own places in the cap, and the assistant's fill only what
 * is left.
 *
 * The list is chronological and appended to, so `rules.slice(-12)` picked by POSITION alone: thirty rules the
 * assistant wrote for itself pushed every reader rule out of the window, and the turn read the model's own
 * guesses with the reader's answers nowhere in the text. The reader's are taken first - all of them when they
 * fit, the newest `cap` when they do not - and the newest of the assistant's fill the places that remain.
 * `leftOut` is what the block's trailing sentence reports.
 *
 * @returns {{rules: object[], leftOut: number}}
 */
export function briefingRules(rules = [], cap = RULE_BRIEFING_MAX) {
  const list = (Array.isArray(rules) ? rules : []).filter(Boolean);
  const reader = list.filter((r) => r.by !== "assistant");
  const written = list.filter((r) => r.by === "assistant");
  const shown = reader.slice(-cap);
  const room = Math.max(0, cap - shown.length);
  // `slice(-0)` is `slice(0)` - the whole array - so an exhausted cap must not call it.
  const filled = room ? written.slice(-room) : [];
  return { rules: [...shown, ...filled], leftOut: list.length - shown.length - filled.length };
}

/** The rule whose text is exactly this one, or null. The same sentence twice is one rule. */
export function exactRule(rules = [], text) {
  const list = Array.isArray(rules) ? rules : [];
  return list.find((r) => r.text === text) || null;
}

/**
 * The assistant-authored rule this text restates, or null. Only rules the ASSISTANT wrote are candidates: a
 * reader's rule is an answer, and an agent that paraphrased it would be editing the reader's mind.
 */
export function refinedRule(rules = [], text) {
  const list = Array.isArray(rules) ? rules : [];
  const sig = words(text);
  if (!sig.size) return null;
  for (const r of list) {
    if (!r || r.by !== "assistant") continue;
    const other = words(r.text);
    if (!other.size) continue;
    let shared = 0;
    for (const w of sig) if (other.has(w)) shared += 1;
    if (shared / (sig.size + other.size - shared) >= RULE_REFINE_RATIO) return r;
  }
  return null;
}

/**
 * One rule added to a list, with the decision named. The four answers are:
 *
 *   `duplicate` — the text is already there; the caller returns the list untouched (no journal, no persist).
 *   `refined`   — the assistant's own earlier rule now carries this text, in place (the SAME object, so a
 *                 caller holding the list sees the change); `rule` is that entry.
 *   `added`     — a new entry on the end; `rules` is the new array and `trimmed` names the rule the cap cost,
 *                 if any.
 *
 * A list that is full of the reader's rules has nothing of the assistant's to trade, and that throws
 * `rule-full` with RULE_FULL_MESSAGE so the caller (the RULE: harvest, or the POST route) can say so instead of
 * silently losing a reader's rule.
 *
 * @returns {{kind: "duplicate"|"refined"|"added", rules: object[], rule: object|null, trimmed: object|null}}
 */
export function addRuleToList(rules = [], { text, by = "reader", at = null } = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const t = ruleText(text);
  if (!t) throw new Error("a rule needs some text");
  if (exactRule(list, t)) return { kind: "duplicate", rules: list, rule: null, trimmed: null };
  if (by === "assistant") {
    const near = refinedRule(list, t);
    if (near) {
      near.text = t;
      near.at = at || nowIso();
      return { kind: "refined", rules: list, rule: near, trimmed: null };
    }
  }
  const rule = { id: randomUUID().slice(0, 8), text: t, at: at || nowIso(), by };
  const added = withRuleAdded(list, rule);
  if (added.refused) throw Object.assign(new Error(RULE_FULL_MESSAGE), { code: "rule-full" });
  return { kind: "added", rules: added.rules, rule, trimmed: added.trimmed };
}

/** The list without one rule, and whether anything went. The array is new either way. */
export function removeRuleFromList(rules = [], id) {
  const list = Array.isArray(rules) ? rules : [];
  const next = list.filter((r) => r.id !== id);
  return { rules: next, removed: next.length !== list.length };
}

/**
 * Copy Assistant #1's standing rules onto ONE record. Idempotent: a record already stamped is left alone, and
 * #1's own list is never touched — the copies get fresh ids, so deleting a rule from #2 can never delete #1's.
 * `addRuleTo` is the record's own writer: it clips to the same 400 characters, de-duplicates and gives each copy
 * its own id.
 */
export function seedRulesFrom(primaryRules = [], rec = null) {
  if (!rec || rec.id === PRIMARY_ASSISTANT) return rec?.rules || [];
  if (rec.rulesSeededAt) return rec.rules || [];
  const holder = { rules: [] };
  for (const r of primaryRules) addRuleTo(holder, r.text, { by: r.by || "reader" });
  rec.rules = holder.rules;
  rec.rulesSeededAt = nowIso();
  return rec.rules;
}

/** Which list is this record's: #1 answers the store's own array, an extra one answers its record's copy. */
export function rulesOf(record, primaryRules = []) {
  if (!record || record.id === PRIMARY_ASSISTANT) return primaryRules;
  return record.rules || [];
}

// ---- the doors the Assistant's methods delegate to ---------------------------------------------

/** `Assistant#rulesFor`. */
export function rulesOfAssistant(assistant, id = PRIMARY_ASSISTANT) {
  return rulesOf(assistant.assistantRecord(id), assistant.rules);
}

/** `Assistant#seedRulesFor` — one boot pass per record, see `seedRulesFrom`. */
export function seedRulesForRecord(assistant, rec) {
  return seedRulesFrom(assistant.rules, rec);
}

/**
 * `Assistant#loadAssistantRules` — every other assistant's rule set, one boot pass. A record already stamped
 * keeps whatever it has now, and the write is attempted once for all of them; a file that cannot be written is
 * logged rather than thrown, because a boot that refuses to start over a rule copy is worse than one that will
 * copy again next boot.
 */
export function seedEveryAssistantRules(assistant) {
  let wrote = false;
  for (const rec of assistant.assistants) {
    if (rec.id === PRIMARY_ASSISTANT || rec.rulesSeededAt) continue;
    seedRulesForRecord(assistant, rec);
    assistant.onLog(`assistant: copied ${assistant.rules.length} standing rule(s) to ${rec.name} — its own list from here`);
    wrote = true;
  }
  if (!wrote) return assistant.assistants;
  try {
    writeAssistantsFile(assistant.assistantsFile, assistant.assistants);
  } catch (err) {
    assistant.onLog(`assistant: could not record the rules copied to the extra assistants (${reasonOf(err)})`);
  }
  return assistant.assistants;
}

/**
 * `Assistant#addRule` — the reader's and the assistant's one door onto #1's list. The journal says who wrote it
 * and what the cap cost; the charter gets the entry, because a standing answer changing is exactly what the
 * long tier is for.
 */
export function addRuleToAssistant(assistant, text, by = "reader") {
  const out = addRuleToList(assistant.rules, { text, by });
  if (out.kind === "duplicate") return assistant.rules;
  if (out.kind === "refined") {
    assistant.journalAdd("rule", null, `assistant refined: ${out.rule.text}`);
    assistant.appendCharter(`the assistant refined a standing rule: ${out.rule.text}`, { by: "panel", kind: "rule" });
  } else {
    assistant.rules = out.rules;
    assistant.journalAdd(
      "rule",
      null,
      `${by === "assistant" ? "assistant wrote: " : ""}${out.rule.text}${out.trimmed ? ` (trimmed the oldest assistant rule: ${out.trimmed.text})` : ""}`,
    );
    assistant.appendCharter(`${by === "assistant" ? "the assistant" : "the reader"} added a standing rule: ${out.rule.text}`, { by: "panel", kind: "rule" });
  }
  assistant.persist();
  assistant.emit();
  return assistant.rules;
}

/** `Assistant#removeRule` — #1's list only; nothing to journal, and no write when nothing went. */
export function removeRuleFromAssistant(assistant, id) {
  const out = removeRuleFromList(assistant.rules, id);
  assistant.rules = out.rules;
  if (out.removed) assistant.persist();
  assistant.emit();
  return assistant.rules;
}

/**
 * `Assistant#addRuleFor` — one assistant's rules. #1's are the class's own list in assistant.json; the others
 * keep theirs on their record, because there is no second assistant.json and a rule list is three fields, not a
 * store.
 */
export function addRuleForRecord(assistant, id, text, by = "reader") {
  const rec = assistant.assistantRecord(id);
  if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
  if (rec.id === PRIMARY_ASSISTANT) return addRuleToAssistant(assistant, text, by);
  addRuleTo(rec, text, { by });
  writeAssistantsFile(assistant.assistantsFile, assistant.assistants);
  assistant.journalAdd("rule", rec.threadId, `${rec.name}: ${clip(String(text || ""), 200)}`);
  assistant.emit();
  return rec.rules;
}

/** `Assistant#removeRuleFor` — the record's own removal, written back and repainted. */
export function removeRuleForRecord(assistant, id, ruleId) {
  const rec = assistant.assistantRecord(id);
  if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
  if (rec.id === PRIMARY_ASSISTANT) return removeRuleFromAssistant(assistant, ruleId);
  removeRuleFrom(rec, ruleId);
  writeAssistantsFile(assistant.assistantsFile, assistant.assistants);
  assistant.emit();
  return rec.rules;
}
