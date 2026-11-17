// search-items.js - the search's TURN map: which hits belong to one message.
//
// WHY THIS EXISTS. The search reads three fields of a turn - the prompt, the reply, and every console line - and
// one query can hit four of them in ONE turn. The walk steps MATCHES (public/core/search-count.js owns that
// count), but several surfaces still need the turn a match belongs to: the ring round the whole message, the
// turn count in the footer, and a result row that says which message its press would open. So hits are grouped
// here, once, by (thread, turn id), and every surface reads the same grouping.
//
// Published on globalThis as `wtSearchItems`, loaded as a classic script by public/index.html (before
// assistant.js) and imported by test/assistant-search-items.test.js - the same load contract
// public/core/turn-search.js has.

(function (root) {
  "use strict";

  // The one separator that cannot occur in a thread id or a turn id, so two items can never share a key by
  // concatenation. lib/assistant/search.js already uses a NUL for its own distinct-turn count.
  const SEP = "\u0000";

  function keyOf(hit) {
    const thread = hit && hit.thread != null ? String(hit.thread) : "";
    const id = hit && hit.id != null ? String(hit.id) : "";
    return `${thread}${SEP}${id}`;
  }

  // Hits in, items out, in the order each item FIRST appears. An item keeps the hit objects themselves - the result
  // row prints their excerpt fields - and `fields` lists the distinct fields it matched in, so a caller can say
  // which parts of the turn matched without walking the hits again. A hit with no thread or no id is not an item:
  // there would be nothing on the page to open.
  function group(hits) {
    const items = [];
    const byKey = new Map();
    for (const hit of Array.isArray(hits) ? hits : []) {
      if (!hit || typeof hit !== "object") continue;
      if (hit.id == null || hit.thread == null) continue;
      const key = keyOf(hit);
      let item = byKey.get(key);
      if (!item) {
        item = { key, thread: String(hit.thread), id: String(hit.id), turn: Number(hit.turn) || 0, hits: [], fields: [] };
        byKey.set(key, item);
        items.push(item);
      }
      item.hits.push(hit);
      const field = hit.field == null ? "" : String(hit.field);
      if (field && !item.fields.includes(field)) item.fields.push(field);
    }
    return items;
  }

  // One press, one MATCH is the walk's rule (public/core/search-count.js's `step`), so the item map answers
  // only the grouping question: which turn does this hit belong to, and how many turns does a list hold.
  root.wtSearchItems = { keyOf, group };
})(globalThis);
