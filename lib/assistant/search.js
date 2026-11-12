// Searching the assistant's own turns: the prompt it was given, the reply it ended on, and its console lines.
//
// WHERE THE TEXT IS. A turn IS a job record in the panel's store - `jobs.json`, read through `Jobs.list()` and
// `Jobs.get()` in lib/jobs.js, the same pair lib/assistant/messages.js reads. Its prompt is the record's `prompt`,
// its reply is `finalMessage` (the run's own last word; the card's `completion.final.text` is the same text after
// the summary pass), and its tool lines are `lines[]` - one `{kind, text, lid, at}` per console line. Nothing here
// reads the page: a card draws five turns and a 60-line console tail, while the store holds every turn it kept, so
// the search reaches back past the page by construction.
//
// THE MATCHER is public/core/turn-search.js - the file the page loads as a classic script - so `*`, `?`, the
// substring rule, case-insensitivity and the metacharacter escaping have ONE implementation. `[` is a bracket
// here, never an unterminated character class.
//
// THE CAP'S PREFERENCE. When more turns match than the limit shows, the reader's OWN INPUT is kept first, then the
// replies, then the console lines: the thing he typed is what he can act on, and a cap that buried it under a
// hundred tool lines would be a cap that hid the answer. Every answer carries `matched` (everything that matched)
// beside `displayed` (what `hits` holds), so the page always prints both numbers rather than implying the list is
// complete.
import "../../public/core/turn-search.js";

const { compile, excerpt } = globalThis.wtTurnSearch;

// The two scopes the box offers: everything, or the reader's own input only.
export const SEARCH_SCOPES = ["all", "input"];
export const DEFAULT_SEARCH_SCOPE = "all";
// How many hits one answer shows unless the caller asks differently, and the ceiling a caller may ask for.
export const DEFAULT_SEARCH_LIMIT = 20;
export const SEARCH_LIMIT_MAX = 50;
// Per field, so one enormous prompt cannot make a request unbounded on its own.
export const SEARCH_FIELD_CAP = 4000;

// Which field a hit came from, in the order the cap prefers them. The numbers are a sort key, not an ordering the
// page draws: the page reads `field` and prints its own words.
const FIELD_ORDER = { input: 0, reply: 1, tool: 2 };

export function normScope(scope) {
  const s = String(scope == null ? "" : scope)
    .trim()
    .toLowerCase();
  return SEARCH_SCOPES.includes(s) ? s : DEFAULT_SEARCH_SCOPE;
}

export function normLimit(limit) {
  const n = Number.parseInt(String(limit == null ? "" : limit), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(SEARCH_LIMIT_MAX, n);
}

// The fields of one turn that `scope` makes searchable, newest text first is NOT a thing here: the caller orders.
// `record` is the job store's own record; `summary` is what `Jobs.list()` answered, and it is the fallback for a
// store that cannot answer `get` (a bare Jobs in a test).
function turnFields(summary, record, scope) {
  const prompt = String(record?.prompt ?? summary?.prompt ?? "");
  const fields = [{ field: "input", kind: "prompt", index: null, text: prompt, at: Date.parse(record?.startedAt || summary?.startedAt || "") || 0 }];
  if (scope !== "all") return fields;
  const reply = String(record?.finalMessage || summary?.completion?.final?.text || "");
  fields.push({ field: "reply", kind: "final", index: null, text: reply, at: Date.parse(record?.endedAt || summary?.endedAt || record?.startedAt || "") || 0 });
  const lines = Array.isArray(record?.lines) ? record.lines : [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || {};
    const text = String(line.text == null ? "" : line.text);
    if (!text.trim()) continue;
    fields.push({ field: "tool", kind: String(line.kind || "line"), index: i, text, at: Number(line.at) || Date.parse(record?.startedAt || "") || 0 });
  }
  return fields;
}

/**
 * One search over a set of turns.
 *
 * @param summaries  `Jobs.list()` - the turn summaries, each with `id`, `thread`, `turn`, `prompt`, `startedAt`.
 * @param records    `(id) => raw job record | null` - `Jobs.get()`, for the fields the summary drops.
 * @param threads    the threads to search, or null for every turn the caller passed in.
 * @param query      what the reader typed.
 * @param scope      "all" (default) or "input".
 * @param limit      how many hits to return; `matched` still counts every one.
 * @returns {{ query, scope, limit, wildcard, matched, displayed, turns, hits }}
 *   `matched` is every hit the query found, `displayed` is `hits.length`, and `turns` is how many distinct turns
 *   those matches belong to.
 */
export function searchTurns({ summaries = [], records = () => null, threads = null, query = "", scope = DEFAULT_SEARCH_SCOPE, limit = DEFAULT_SEARCH_LIMIT } = {}) {
  const compiled = compile(query);
  const scoped = normScope(scope);
  const capped = normLimit(limit);
  const base = { query: compiled ? compiled.text : "", scope: scoped, limit: capped, wildcard: Boolean(compiled && compiled.wildcard), matched: 0, displayed: 0, turns: 0, hits: [] };
  if (!compiled) return base;
  const allow = threads ? new Set(threads.map((t) => String(t))) : null;
  const hits = [];
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (!summary || typeof summary !== "object") continue;
    const thread = String(summary.thread || "");
    if (allow && !allow.has(thread)) continue;
    const record = records(summary.id) || summary;
    const turnId = String(record.id || summary.id || "");
    if (!turnId) continue;
    for (const f of turnFields(summary, record, scoped)) {
      if (!f.text) continue;
      const text = f.text.length > SEARCH_FIELD_CAP ? f.text.slice(0, SEARCH_FIELD_CAP) : f.text;
      if (!compiled.re.test(text)) continue;
      const ex = excerpt(text, compiled);
      hits.push({
        id: turnId,
        thread,
        // The counter the store wrote, which can move backwards after a trim; the page shows its own ordinal.
        turn: Number(record.turn ?? summary.turn) || 0,
        field: f.field,
        kind: f.kind,
        index: f.index,
        at: f.at,
        // The one-line window around the match, already split so the row can mark `hit` without re-finding it.
        before: ex.before,
        hit: ex.hit,
        after: ex.after,
        lead: ex.lead,
        tail: ex.tail,
      });
    }
  }
  // The cap's preference: the reader's input first, then the reply, then the console. Newest first inside each
  // class, so the newest thing he typed is the first row, not the oldest.
  hits.sort((a, b) => (FIELD_ORDER[a.field] ?? 9) - (FIELD_ORDER[b.field] ?? 9) || b.at - a.at);
  const shown = hits.slice(0, capped);
  return {
    ...base,
    matched: hits.length,
    displayed: shown.length,
    turns: new Set(hits.map((h) => `${h.thread}\u0000${h.id}`)).size,
    hits: shown,
  };
}
