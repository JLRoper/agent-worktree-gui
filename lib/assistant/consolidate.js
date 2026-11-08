// Consolidation: what a rule list becomes when the assistant tidies it, under the reader's grant.
//
// A turn may add a rule (lib/assistant/rules.js `addRuleToList`), and a list that only grows is a list that
// eventually says the same thing four ways: Assistant #2's store held 40 rules, 39 of them the model's own, most
// at the 400-character cap, and the twelve-seat window could only ever show eleven of them clipped. The reader
// used to be the only hand that could tidy that: merge two rules, drop one, move one into the charter, or promote
// a rule to the role prompt. A reader pressing a button for every tidy-up is the bottleneck the tiers design was
// written to remove, and a model allowed to tidy unasked is the failure that design was written to prevent.
//
// The answer is a GRANT, not a capability: the reader grants consolidation once, on the assistant record
// (`consolidate: { by: "reader", at }`), and the assistant may then run the pass. Four doors, each with one
// unsafe case it refuses by name:
//
//   merge          several rules become one. Refuses when a safety-pinned source would become an unpinned rule:
//                  the whole point of a pin is that the window never leaves it out, and a rewrite that loses the
//                  pin is the "never push the oauth2-multi turnover branch" failure in miniature.
//   delete         a rule leaves the list. Refuses a reader's rule (an answer is rewritten or merged, never
//                  dropped) and a safety-pinned one (a boundary is not tidied away).
//   moveToCharter  a rule's TEXT leaves the every-turn tier and lands in the long tier, dated. Refuses a pinned
//                  rule (a boundary must not ride a file sent once every twenty turns) and a charter with no room.
//   setRolePrompt  the tier-1 seat is set from the consolidation. Refuses a prompt over ROLE_PROMPT_MAX, an empty
//                  one (deleting the operating contract is not a shorter contract) and overwriting a prompt the
//                  READER wrote (no `promptBy: "assistant"` stamp on a prompt that already says something).
//
// Every write the pass makes keeps its provenance: a produced rule carries `rewritten: true`, `rewrittenFrom`
// (the ids it replaced) and `rewrittenAt`, and a reader's rule keeps `by: "reader"` through the rewrite. Before
// anything is written, `snapshotConsolidation` puts the whole list, the charter and the prompt in
// `<logs>/rule-consolidations/<iso>-<assistant>.json`; a wrong judgement is then reversible, which is what makes
// the grant safe to give.
//
// Nothing here reads a store, writes a file except the one snapshot, or talks HTTP. The list, the charter and the
// prompt come in as values; the caller (lib/assistant.js) owns persistence.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CHARTER_MAX_CHARS, appendEntry } from "../charter.js";
import { nowIso } from "./read.js";
import { RULE_BRIEFING_MAX, RULE_TEXT_MAX, briefingRules } from "./rules.js";

export const CONSOLIDATE_VERSION = 1;
// The tier-1 seat from docs/design/prompt-tiers-2026-11-08.md §3.2. A consolidation may WRITE a role prompt, and
// the only number it may write one against is the budget the tier gets: 1,472 characters, not the 8,000 the
// reader's own form still allows while the rest of the migration lands. The narrower cap is the safe direction.
export const ROLE_PROMPT_MAX = 1472;
export const CONSOLIDATION_DIR = "rule-consolidations";
// The ops a plan may name. `keep` is how a plan says "I read this one and it stays as it is"; it is REQUIRED for
// every rule the plan does not otherwise touch, because a plan that silently skipped a rule would read as a plan
// that considered it.
export const PLAN_OPS = Object.freeze(["keep", "rewrite", "merge", "drop", "charter", "prompt"]);

/** The refusal a caller maps to a 4xx, with a code the tests and the page can branch on. */
const refuse = (code, message) => Object.assign(new Error(message), { code });

/** The reader's grant on one record: `{ granted, at }`. Anything but a reader-stamped grant reads as absent. */
export function grantOf(record) {
  const g = record && record.consolidate;
  return { granted: Boolean(g && g.by === "reader" && g.at), at: g?.at || null };
}

/** The reader grants (or the panel records that they did). One field, stamped so a hand edit is visible. */
export function grantConsolidation(record, { at = null } = {}) {
  if (!record) throw refuse("assistant-unknown", "no such assistant");
  record.consolidate = { by: "reader", at: at || nowIso() };
  return grantOf(record);
}

/** The reader takes the grant back. The field is deleted, not set false: absent is what an unasked reader means. */
export function revokeConsolidation(record) {
  if (record) delete record.consolidate;
  return grantOf(record);
}

const needGrant = (granted) => {
  if (!granted) {
    throw refuse(
      "consolidate-not-granted",
      "consolidation is not granted for this assistant - the reader grants it on the assistant record before a pass may write",
    );
  }
};

const needRule = (rules, id) => {
  const at = (Array.isArray(rules) ? rules : []).findIndex((r) => r && r.id === id);
  if (at === -1) throw refuse("consolidate-unknown-rule", `no rule with id ${String(id || "(none)")}`);
  return at;
};

const bodyOf = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const stampOf = (at) => at || nowIso();

/**
 * Several rules become one, at the position of the earliest source. The produced rule keeps that source's id, the
 * EARLIEST source's author wins when the sources disagree (`by: "reader"` if any source was the reader's: an
 * answer outranks a guess), and `rewrittenFrom` names every id it replaced.
 *
 * Refusals: no grant; fewer than two sources; an unknown id; an empty or over-cap text; and a pinned source whose
 * merged text is not itself marked `safety: true`.
 * @returns {{rules: object[], rule: object}}
 */
export function mergeRules({ rules = [], from = [], text, safety = false, granted = false, at = null } = {}) {
  needGrant(granted);
  const list = Array.isArray(rules) ? rules : [];
  const ids = [...new Set((Array.isArray(from) ? from : [from]).map((x) => String(x || "").trim()).filter(Boolean))];
  if (ids.length < 2) throw refuse("consolidate-merge", "a merge takes at least two rule ids");
  const sources = ids.map((id) => {
    const i = needRule(list, id);
    return { i, r: list[i] };
  });
  const body = bodyOf(text);
  if (!body) throw refuse("consolidate-text", "a merged rule needs some text");
  if (body.length > RULE_TEXT_MAX) {
    throw refuse("consolidate-text", `a rule is stored at ${RULE_TEXT_MAX} characters - this one is ${body.length}`);
  }
  const pinned = sources.some((s) => s.r.safety === true);
  if (pinned && safety !== true) {
    throw refuse(
      "consolidate-safety-lost",
      "a source rule is pinned safety: true - the merged rule must carry safety: true itself, or the boundary is demoted to a line the window may leave out",
    );
  }
  const first = sources.slice().sort((a, b) => a.i - b.i)[0];
  const by = sources.some((s) => s.r.by !== "assistant") ? "reader" : "assistant";
  const when = stampOf(at);
  const rule = {
    id: first.r.id,
    text: body,
    at: when,
    by,
    ...(pinned || safety === true ? { safety: true } : {}),
    rewritten: true,
    rewrittenFrom: ids,
    rewrittenAt: when,
  };
  const consumed = new Set(ids.filter((id) => id !== first.r.id));
  const next = [];
  for (const r of list) {
    if (r && r.id === first.r.id) next.push(rule);
    else if (!(r && consumed.has(r.id))) next.push(r);
  }
  return { rules: next, rule };
}

/** One rule rewritten in place. The same door as `mergeRules`, with the safety refusal and the provenance. */
export function rewriteRule({ rules = [], id, text, safety = false, granted = false, at = null } = {}) {
  needGrant(granted);
  const list = Array.isArray(rules) ? rules : [];
  needRule(list, id);
  const body = bodyOf(text);
  if (!body) throw refuse("consolidate-text", "a rewritten rule needs some text");
  if (body.length > RULE_TEXT_MAX) {
    throw refuse("consolidate-text", `a rule is stored at ${RULE_TEXT_MAX} characters - this one is ${body.length}`);
  }
  const source = list.find((r) => r && r.id === id);
  if (source.safety === true && safety !== true) {
    throw refuse("consolidate-safety-lost", `rule ${id} is pinned safety: true - a rewrite must carry safety: true`);
  }
  const when = stampOf(at);
  const rule = {
    id,
    text: body,
    at: when,
    by: source.by || "assistant",
    ...(source.safety === true || safety === true ? { safety: true } : {}),
    rewritten: true,
    rewrittenFrom: [id],
    rewrittenAt: when,
  };
  return { rules: list.map((r) => (r && r.id === id ? rule : r)), rule };
}

/**
 * A rule leaves the list. Refused for the reader's rules and for pinned ones: the reader's answer may be rewritten
 * or merged (its intent survives in the produced text) but never simply dropped, and a pinned boundary is not
 * tidied away at all. Deleting the assistant's own unpinned rule is the ordinary case the op exists for.
 * @returns {{rules: object[], rule: object}}
 */
export function deleteRule({ rules = [], id, granted = false } = {}) {
  needGrant(granted);
  const list = Array.isArray(rules) ? rules : [];
  const i = needRule(list, id);
  const rule = list[i];
  if (rule.safety === true) {
    throw refuse("consolidate-pinned", `rule ${id} is pinned safety: true - a boundary is never dropped, only rewritten with its intent kept`);
  }
  if (rule.by !== "assistant") {
    throw refuse("consolidate-reader", `rule ${id} is the reader's - a reader's rule is rewritten or merged, never dropped`);
  }
  return { rules: list.filter((r) => r && r.id !== id), rule };
}

/**
 * A rule's text leaves the every-turn tier and lands in the charter, as one dated entry at the position the
 * charter's own writer gives it. Refused for a pinned rule (a boundary must not leave the tier that rides every
 * turn) and when the charter has no room left (`appendEntry` prunes the oldest entries first and refuses by
 * returning the file unchanged, so the text is never lost by a truncation).
 * @returns {{rules: object[], charter: string, entry: string}}
 */
export function moveRuleToCharter({ rules = [], id, charter = "", because = "", granted = false, at = null } = {}) {
  needGrant(granted);
  const list = Array.isArray(rules) ? rules : [];
  const i = needRule(list, id);
  const rule = list[i];
  if (rule.safety === true) {
    throw refuse("consolidate-pinned", `rule ${id} is pinned safety: true - a boundary stays in the every-turn tier`);
  }
  const before = String(charter ?? "");
  const entry = `standing rule moved to the charter: ${rule.text}${because ? ` (${because})` : ""} - rule id ${id}`;
  // `limit: Infinity`: a move carries the whole rule. The changelog's 300-character clip is for a turn's summary
  // line; a rule that leaves the every-turn tier must arrive as the sentence it was, or the move is a lossy edit.
  const next = appendEntry(before, entry, { at: at ? new Date(at) : new Date(), by: "panel", kind: "rule", limit: Infinity });
  if (next === before || next.length > CHARTER_MAX_CHARS) {
    throw refuse("charter-full", `the charter is full at ${CHARTER_MAX_CHARS} characters - prune it before moving a rule into it`);
  }
  return { rules: list.filter((r) => r && r.id !== id), charter: next, entry };
}

/**
 * The tier-1 seat, set from a consolidation. Refused over ROLE_PROMPT_MAX, refused when empty, and refused when the
 * current prompt is the reader's (`promptBy: "reader"` with text). An assistant may replace its OWN prompt, or fill
 * an empty one; it may not overwrite the operating contract a person wrote.
 *
 * `from` records the rule ids the prompt absorbs (the pass removes them from the list), so the provenance of a
 * prompt built out of rules is as readable as a rule's.
 * @returns {{prompt: string, promptBy: "assistant", promptAt: string, promptFrom: string[]|undefined}}
 */
export function setRolePrompt({ prompt = "", promptBy = null, text, from = [], granted = false, at = null } = {}) {
  needGrant(granted);
  const body = String(text ?? "").trim();
  if (!body) throw refuse("consolidate-prompt-empty", "a role prompt that says nothing is the absence of a contract, not a shorter one");
  if (body.length > ROLE_PROMPT_MAX) {
    throw refuse("consolidate-prompt-long", `the role prompt seat is ${ROLE_PROMPT_MAX} characters - this one is ${body.length}`);
  }
  if (String(prompt || "").trim() && promptBy !== "assistant") {
    throw refuse("consolidate-prompt-reader", "the role prompt on this assistant was written by the reader - the assistant may fill an empty one, never replace theirs");
  }
  const ids = (Array.isArray(from) ? from : []).map((x) => String(x || "").trim()).filter(Boolean);
  return {
    prompt: body,
    promptBy: "assistant",
    promptAt: at || nowIso(),
    ...(ids.length ? { promptFrom: ids } : {}),
  };
}

/**
 * The whole pass over one assistant's list, charter and prompt. The plan is `{ ops: [...] }` (or a bare array);
 * every op consumes its ids and no id may be consumed twice. Every rule must be named by exactly one op's ids,
 * whether that op keeps it, rewrites it, merges it, drops it, moves it or absorbs it into the prompt - a plan that
 * leaves one unaccounted for is refused with the ids, because a silent skip is how a pass loses a rule.
 *
 * The ops are applied in plan order, which is the caller's business: a merge names its own sources, so ordering
 * only matters for which ops see the list a previous op produced.
 *
 * @returns {{rules, charter, prompt, promptBy, promptAt, promptFrom, report}} the new values and the counts; the
 *   caller writes them, snapshot first.
 */
export function consolidatePlan({ rules = [], charter = "", prompt = "", promptBy = null, plan, granted = false, dryRun = false, at = null } = {}) {
  // A DRY RUN WRITES NOTHING, so it does not need the grant: validating a plan is how a reader previews what a
  // pass would do before giving the permission. Every door below is handed `granted: may`, and the real pass
  // (dryRun false) can only reach them with the reader's grant on the record.
  const may = granted === true || dryRun === true;
  if (!may) throw refuse("consolidate-not-granted", "consolidation is not granted for this assistant - the reader grants it on the assistant record before a pass may write");
  const list = Array.isArray(rules) ? rules : [];
  const ops = Array.isArray(plan) ? plan : Array.isArray(plan?.ops) ? plan.ops : null;
  if (!ops) throw refuse("consolidate-plan", "a consolidation plan is { ops: [...] } (or an array of ops)");
  const when = stampOf(at);
  const known = new Set(list.map((r) => r && r.id).filter(Boolean));
  const claimed = new Map();
  const claim = (id, op, index) => {
    if (!known.has(id)) throw refuse("consolidate-unknown-rule", `no rule with id ${id}`);
    if (claimed.has(id)) {
      throw refuse("consolidate-plan", `rule ${id} is named by op ${claimed.get(id)} and again by op ${index} - one op per rule`);
    }
    claimed.set(id, index);
  };
  const idsOf = (op) =>
    (Array.isArray(op.from) ? op.from : op.from !== undefined ? [op.from] : op.id !== undefined ? [op.id] : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean);

  let nextRules = list;
  let nextCharter = String(charter ?? "");
  let nextPrompt = String(prompt ?? "");
  let nextPromptBy = promptBy;
  let nextPromptAt = null;
  let nextPromptFrom;
  const counts = { kept: 0, rewritten: 0, merged: 0, dropped: 0, chartered: 0, prompted: 0 };
  const applied = [];

  ops.forEach((op, index) => {
    const kind = String(op?.op || "").toLowerCase();
    if (!PLAN_OPS.includes(kind)) {
      throw refuse("consolidate-plan", `op ${index} names "${op?.op}" - the ops are ${PLAN_OPS.join(", ")}`);
    }
    const ids = idsOf(op);
    // A `prompt` op may name no rule: the seat can be set from new text, and requiring it to absorb something
    // would make "write the contract the rules distilled to" impossible unless a rule happened to be left over.
    if (!ids.length && kind !== "prompt") throw refuse("consolidate-plan", `op ${index} (${kind}) names no rule id`);
    for (const id of ids) claim(id, kind, index);
    if (kind === "keep") {
      if (ids.length !== 1) throw refuse("consolidate-plan", `op ${index} (keep) takes one id`);
      counts.kept += 1;
      applied.push({ op: "keep", ids });
      return;
    }
    if (kind === "rewrite") {
      if (ids.length !== 1) throw refuse("consolidate-plan", `op ${index} (rewrite) takes one id`);
      const out = rewriteRule({ rules: nextRules, id: ids[0], text: op.text, safety: op.safety === true, granted: may, at: when });
      nextRules = out.rules;
      counts.rewritten += 1;
      applied.push({ op: "rewrite", ids, id: out.rule.id });
      return;
    }
    if (kind === "merge") {
      const out = mergeRules({ rules: nextRules, from: ids, text: op.text, safety: op.safety === true, granted: may, at: when });
      nextRules = out.rules;
      counts.merged += 1;
      applied.push({ op: "merge", ids, id: out.rule.id });
      return;
    }
    if (kind === "drop") {
      if (ids.length !== 1) throw refuse("consolidate-plan", `op ${index} (drop) takes one id`);
      const out = deleteRule({ rules: nextRules, id: ids[0], granted: may });
      nextRules = out.rules;
      counts.dropped += 1;
      applied.push({ op: "drop", ids, because: String(op.because || "") });
      return;
    }
    if (kind === "charter") {
      if (ids.length !== 1) throw refuse("consolidate-plan", `op ${index} (charter) takes one id`);
      const out = moveRuleToCharter({ rules: nextRules, id: ids[0], charter: nextCharter, because: op.because, granted: may, at: when });
      nextRules = out.rules;
      nextCharter = out.charter;
      counts.chartered += 1;
      applied.push({ op: "charter", ids });
      return;
    }
    // prompt: the tier-1 seat, set from the consolidation. The rules it names are absorbed: their text is the
    // prompt's, and they stop riding their own seats. A pinned rule is refused by setRolePrompt's own gate below
    // because a pin means "never leave the every-turn window out" - a prompt rides every turn too, so absorbing one
    // is allowed ONLY when the prompt keeps its intent, which the text cannot prove. The refusal is deliberate.
    const sources = nextRules.filter((r) => r && ids.includes(r.id));
    const pinned = sources.filter((r) => r.safety === true);
    if (pinned.length) {
      throw refuse(
        "consolidate-pinned",
        `op ${index} (prompt) absorbs a pinned rule (${pinned.map((r) => r.id).join(", ")}) - a boundary stays a rule with its own pin`,
      );
    }
    const out = setRolePrompt({ prompt: nextPrompt, promptBy: nextPromptBy, text: op.text, from: ids, granted: may, at: when });
    nextPrompt = out.prompt;
    nextPromptBy = out.promptBy;
    nextPromptAt = out.promptAt;
    nextPromptFrom = out.promptFrom;
    nextRules = nextRules.filter((r) => !(r && ids.includes(r.id)));
    counts.prompted += 1;
    applied.push({ op: "prompt", ids });
  });

  const missing = list.filter((r) => r && r.id && !claimed.has(r.id)).map((r) => r.id);
  if (missing.length) {
    throw refuse("consolidate-plan", `the plan does not account for ${missing.length} rule(s): ${missing.join(", ")}`);
  }

  const window = briefingRules(nextRules, RULE_BRIEFING_MAX);
  const report = {
    version: CONSOLIDATE_VERSION,
    at: when,
    before: { rules: list.length, chars: list.reduce((n, r) => n + String(r?.text || "").length, 0) },
    after: { rules: nextRules.length, chars: nextRules.reduce((n, r) => n + String(r?.text || "").length, 0) },
    counts,
    ops: applied,
    pinned: nextRules.filter((r) => r && r.safety === true).map((r) => r.id),
    reader: nextRules.filter((r) => r && r.by !== "assistant").length,
    assistant: nextRules.filter((r) => r && r.by === "assistant").length,
    rewritten: nextRules.filter((r) => r && r.rewritten === true).length,
    shown: window.rules.length,
    leftOut: window.leftOut,
    charterChars: nextCharter.length,
    promptChars: nextPrompt.length,
  };
  return { rules: nextRules, charter: nextCharter, prompt: nextPrompt, promptBy: nextPromptBy, promptAt: nextPromptAt, promptFrom: nextPromptFrom, report };
}

/** The snapshot path one pass writes: `<dir>/<iso, filesystem-safe>-<assistant>.json`. */
export function snapshotName({ assistantId = "assistant-1", at = null } = {}) {
  const stamp = String(stampOf(at)).replace(/[:.]/g, "-");
  return `${stamp}-${String(assistantId || "assistant-1").replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

/**
 * Write the BEFORE state of one pass, before the caller writes anything else. This is the whole reversibility
 * promise: the list, the charter, the prompt and the plan in one file, under the pass's timestamp, in the state
 * directory's logs folder. A write that fails throws: a pass that cannot be undone is a pass that does not run.
 * @returns {{path: string, body: object}}
 */
export function snapshotConsolidation({ dir, assistantId = "assistant-1", at = null, rules = [], charter = "", prompt = "", promptBy = null, plan = null } = {}) {
  if (!dir) throw refuse("consolidate-snapshot", "a consolidation needs a snapshot directory - a pass without one is not reversible");
  const when = stampOf(at);
  const file = path.join(dir, snapshotName({ assistantId, at: when }));
  const body = {
    version: CONSOLIDATE_VERSION,
    assistantId,
    at: when,
    before: {
      rules: (Array.isArray(rules) ? rules : []).map((r) => ({ ...r })),
      charter,
      charterChars: String(charter || "").length,
      prompt,
      promptBy,
    },
    plan,
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(body, null, 1));
  } catch (err) {
    throw refuse("consolidate-snapshot", `could not write the consolidation snapshot ${file}: ${String((err && err.message) || err)}`);
  }
  return { path: file, body };
}
