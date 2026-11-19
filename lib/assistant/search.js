// Searching the assistants' turns: the prompt one was given, the reply it ended on, and its console lines.
//
// WHERE THE TEXT IS. A turn IS a job record in the panel's store - `jobs.json`, read through `Jobs.list()` and
// `Jobs.get()` in lib/jobs.js, the same pair lib/assistant/messages.js reads. Its prompt is the record's `prompt`,
// its reply is `finalMessage` (the run's own last word; the card's `completion.final.text` is the same text after
// the summary pass), and its tool lines are `lines[]` - one `{kind, text, lid, at}` per console line. Nothing here
// reads the page: a card draws five turns and a 60-line console tail, while the store holds every turn it kept, so
// the search reaches back past the page by construction.
//
// ONE INDEX, EVERY ASSISTANT. The store is one file and every assistant's turns sit in it on their own threads, so
// there is nothing to copy and nothing to move: each assistant's threads are searched into their own list, and the
// lists are MERGED into one ordered index here, at query time (`mergeAssistantHits`). Every hit carries the
// assistant it belongs to (`assistantId`, `assistant`), which is what lets a result row name it and a press switch
// the panel to that assistant's tab. The text is never duplicated on disk, and a second assistant costs one more
// pass over the same records rather than a second store.
//
// THE MATCHER is public/core/turn-search.js - the file the page loads as a classic script - so `*`, `?`, the
// substring rule, case-insensitivity and the metacharacter escaping have ONE implementation. `[` is a bracket
// here, never an unterminated character class.
//
// THE CAP'S PREFERENCE. When more turns match than the limit shows, the reader's OWN INPUT is kept first, then the
// replies, then the console lines: the thing he typed is what he can act on, and a cap that buried it under a
// hundred tool lines would be a cap that hid the answer. Inside one class the merge ranks NEWEST FIRST, and a tie
// between two matches at the same millisecond is broken by the assistant, the thread and the turn, so a tie cannot
// shuffle between two reads. Every answer carries `matched` (everything that matched) beside `displayed` (what
// `hits` holds), so the page always prints both numbers rather than implying the list is complete.
//
// THE COST. A filter can match thousands of turns, and only `limit` of them are ever drawn. Matching therefore
// collects references (the field's text and where it is) and takes the excerpt - the only expensive part, a regex
// window per match - AFTER the merge and the slice, so the work per answer is bounded by the rows it shows plus one
// pass to count. The count itself has to read every match; nothing else does.
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
  const fields = [{ field: "input", kind: "prompt", index: null, lid: null, text: prompt, at: Date.parse(record?.startedAt || summary?.startedAt || "") || 0 }];
  if (scope !== "all") return fields;
  const reply = String(record?.finalMessage || summary?.completion?.final?.text || "");
  fields.push({ field: "reply", kind: "final", index: null, lid: null, text: reply, at: Date.parse(record?.endedAt || summary?.endedAt || record?.startedAt || "") || 0 });
  const lines = Array.isArray(record?.lines) ? record.lines : [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || {};
    const text = String(line.text == null ? "" : line.text);
    if (!text.trim()) continue;
    fields.push({
      field: "tool",
      kind: String(line.kind || "line"),
      index: i,
      // The console row's own id, so the page can put the highlight on THAT line rather than on the first match
      // anywhere in the turn: three matching console lines in one message are three different rows on screen.
      lid: line.lid != null ? String(line.lid) : null,
      text,
      at: Number(line.at) || Date.parse(record?.startedAt || "") || 0,
    });
  }
  return fields;
}

// One assistant's threads, matched. `owner` is `{assistantId, assistant}` for the merged read and null for the old
// single-corpus read (a caller that passed `threads` itself), so a hit names its assistant exactly when one exists.
// The answer holds references, not excerpts: `text` rides along and the caller turns the survivors into rows.
function matchTurns({ summaries, records, allow, owner, scope, compiled }) {
  const hits = [];
  for (const summary of summaries) {
    if (!summary || typeof summary !== "object") continue;
    const thread = String(summary.thread || "");
    if (allow && !allow.has(thread)) continue;
    const record = records(summary.id) || summary;
    const turnId = String(record.id || summary.id || "");
    if (!turnId) continue;
    for (const f of turnFields(summary, record, scope)) {
      if (!f.text) continue;
      const text = f.text.length > SEARCH_FIELD_CAP ? f.text.slice(0, SEARCH_FIELD_CAP) : f.text;
      if (!compiled.re.test(text)) continue;
      hits.push({
        id: turnId,
        thread,
        // The counter the store wrote, which can move backwards after a trim; the page shows its own ordinal.
        turn: Number(record.turn ?? summary.turn) || 0,
        field: f.field,
        kind: f.kind,
        index: f.index,
        lid: f.lid ?? null,
        at: f.at,
        ...(owner ? { assistantId: owner.assistantId, assistant: owner.assistant } : {}),
        text,
      });
    }
  }
  return hits;
}

// The merged index's order: the cap's preference first (the reader's own input, then the reply, then the console),
// then newest first, then a stable tie-break. The last three keys are what make two assistants' answers order the
// same way on every read: at one millisecond the assistant's id decides, then the thread, then the turn, then the
// console line's own place in its message. Nothing here depends on the order the groups arrived in.
function compareHits(a, b) {
  return (
    (FIELD_ORDER[a.field] ?? 9) - (FIELD_ORDER[b.field] ?? 9) ||
    (Number(b.at) || 0) - (Number(a.at) || 0) ||
    String(a.assistantId || "").localeCompare(String(b.assistantId || "")) ||
    String(a.thread || "").localeCompare(String(b.thread || "")) ||
    String(a.id || "").localeCompare(String(b.id || "")) ||
    (Number(a.index ?? -1) || 0) - (Number(b.index ?? -1) || 0)
  );
}

/**
 * Merge per-assistant hit lists into ONE ordered index, at query time.
 *
 * This is the whole of "search every assistant": each group is that assistant's own matched turns, and the answer
 * is one list ranked by `compareHits` - newest first inside the cap's field preference, with a tie broken by the
 * assistant so the order never depends on the order the groups were read in. The groups are not modified, and the
 * hits are the same objects (the page prints their excerpt fields), so nothing is copied but the array.
 *
 * @param groups `[{ assistantId, assistant, hits }]` - one group per assistant (or one unnamed group).
 * @returns the merged hits, ordered.
 */
export function mergeAssistantHits(groups = []) {
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group) continue;
    for (const hit of Array.isArray(group.hits) ? group.hits : []) out.push(hit);
  }
  out.sort(compareHits);
  return out;
}

/**
 * One search over a set of turns, or over every assistant's own turns merged into one index.
 *
 * @param summaries  `Jobs.list()` - the turn summaries, each with `id`, `thread`, `turn`, `prompt`, `startedAt`.
 * @param records    `(id) => raw job record | null` - `Jobs.get()`, for the fields the summary drops.
 * @param threads    the threads to search, or null for every turn the caller passed in. Ignored when `assistants`
 *                   is given (the per-assistant groups name their own threads).
 * @param assistants `[{ id, name, threads }]` - one entry per assistant: its own thread and any thread a hard
 *                   restart left behind. This is the every-assistant read: each group is matched separately and the
 *                   groups are merged into one index, so every hit names the assistant it belongs to.
 * @param query      what the reader typed.
 * @param scope      "all" (default) or "input".
 * @param limit      how many hits to return; `matched` still counts every one.
 * @returns {{ query, scope, limit, wildcard, matched, displayed, turns, hits }}
 *   `matched` is every hit the query found across every assistant, `displayed` is `hits.length`, and `turns` is
 *   how many distinct turns those matches belong to.
 */
export function searchTurns({
  summaries = [],
  records = () => null,
  threads = null,
  assistants = null,
  query = "",
  scope = DEFAULT_SEARCH_SCOPE,
  limit = DEFAULT_SEARCH_LIMIT,
} = {}) {
  const compiled = compile(query);
  const scoped = normScope(scope);
  const capped = normLimit(limit);
  const base = { query: compiled ? compiled.text : "", scope: scoped, limit: capped, wildcard: Boolean(compiled && compiled.wildcard), matched: 0, displayed: 0, turns: 0, hits: [] };
  if (!compiled) return base;
  const list = Array.isArray(summaries) ? summaries : [];
  const groups = [];
  const named = Array.isArray(assistants) ? assistants.filter((a) => a && Array.isArray(a.threads) && a.threads.length) : [];
  if (named.length) {
    for (const a of named) {
      const assistantId = String(a.id || "");
      const assistant = String(a.name || a.id || "");
      const allow = new Set(a.threads.map((t) => String(t)).filter(Boolean));
      if (!allow.size) continue;
      groups.push({ assistantId, assistant, hits: matchTurns({ summaries: list, records, allow, owner: { assistantId, assistant }, scope: scoped, compiled }) });
    }
  } else {
    const allow = threads ? new Set(threads.map((t) => String(t))) : null;
    groups.push({ assistantId: null, assistant: null, hits: matchTurns({ summaries: list, records, allow, owner: null, scope: scoped, compiled }) });
  }
  const matched = mergeAssistantHits(groups);
  // The excerpt is made for the rows the cap keeps, never for every match: a filter that hits thousands of turns
  // counts them all and windows only the handful the popover draws.
  const shown = matched.slice(0, capped).map(({ text, ...hit }) => {
    const ex = excerpt(text, compiled);
    return { ...hit, before: ex.before, hit: ex.hit, after: ex.after, lead: ex.lead, tail: ex.tail };
  });
  return {
    ...base,
    matched: matched.length,
    displayed: shown.length,
    turns: new Set(matched.map((h) => `${h.thread}\u0000${h.id}`)).size,
    hits: shown,
  };
}
