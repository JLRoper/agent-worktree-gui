// search-items.js - the search's ITEM map: which hits are one thing to step through.
//
// WHY AN ITEM IS NOT A HIT. The search reads three fields of a turn - the prompt, the reply, and every console line
// - and one query can hit four of them in ONE turn. A reader stepping "next match" means the next MESSAGE, not the
// next row of the message they are already on: four hits in one turn are one press, and the count beside the box
// reads "2 of 4" for four matching turns, never "5 of 12" for the hits inside them. So hits are grouped here, once,
// by (thread, turn id), and the page steps the groups.
//
// WRAP, NOT CLAMP. step() wraps at both ends: Down on the last item lands on the first, Up on the first lands on the
// last. That is the rule Enter already had, so no key disagrees with another about what comes after the end;
// docs/assistant-search-keys.md states it for the reader.
//
// Published on globalThis as `wtSearchItems`, loaded as a classic script by public/index.html (before assistant.js)
// and imported by test/assistant-search-items.test.js - the same load contract public/core/turn-search.js has.
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

  // One press, one item: the next index, wrapping at both ends. `current` may be -1 (nothing current yet): a Down
  // from there lands on the first item and an Up on the last. A `total` of 0 answers -1 - an empty list has no item
  // to stand on - and an out-of-range `current` is treated as "nothing current" rather than trusted.
  function step(current, delta, total) {
    const n = Math.max(0, Number(total) || 0);
    if (!n) return -1;
    const d = Number(delta) < 0 ? -1 : 1;
    const c = Number(current);
    if (!Number.isFinite(c) || c < 0 || c >= n) return d < 0 ? n - 1 : 0;
    return (c + d + n) % n;
  }

  root.wtSearchItems = { keyOf, group, step };
})(globalThis);
