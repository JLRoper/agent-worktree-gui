// search-items.js - the search's TURN map: which hits belong to one message, and the order the list reads in.
//
// WHY THIS EXISTS. The search reads three fields of a turn - the prompt, the reply, and every console line - and
// one query can hit four of them in ONE turn. The walk steps MATCHES (public/core/search-count.js owns that
// count), but several surfaces still need the turn a match belongs to: the ring round the whole message, the
// turn count in the footer, and a result row that says which message its press would open. So hits are grouped
// here, once, by (thread, turn id), and every surface reads the same grouping.
//
// THE ORDER (`order`). The server answers in the cap's own preference - your input first, then replies, then
// console lines - because that is which matches survive the cap, not the order a reader wants to walk them in.
// The list is ordered here instead, by the clock:
//
//   * items newest first, an item's stamp being the newest row inside it (so a reply five minutes old outranks a
//     prompt from six hours ago, whatever field the match is in);
//   * rows inside one item in READING order - the prompt, then the console lines by their own index, then the
//     reply - so a message still reads top to bottom and a step inside it moves down the screen;
//   * equal stamps broken by the conversation's own order (the store's `turn` number, then the order the answer
//     listed them), so a tie is stable rather than whatever the sort happened to do.
//
// Published on globalThis as `wtSearchItems`, loaded as a classic script by public/index.html (before
// assistant.js) and imported by test/assistant-search-items.test.js - the same load contract
// public/core/turn-search.js has.

(function (root) {
  "use strict";

  // The one separator that cannot occur in a thread id or a turn id, so two items can never share a key by
  // concatenation. lib/assistant/search.js already uses a NUL for its own distinct-turn count.
  const SEP = "\u0000";

  // The order a message reads on screen: the prompt rides the head, the console rows follow in their own order,
  // and the reply is the last word. A field this map does not name sorts after all three, in answer order.
  const READING = { input: 0, tool: 1, reply: 2 };

  function keyOf(hit) {
    const thread = hit && hit.thread != null ? String(hit.thread) : "";
    const id = hit && hit.id != null ? String(hit.id) : "";
    return `${thread}${SEP}${id}`;
  }

  const atOf = (hit) => {
    const n = Number(hit && hit.at);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const readingRank = (hit) => {
    const rank = READING[hit && hit.field != null ? String(hit.field) : ""];
    return rank == null ? 3 : rank;
  };

  const lineIndex = (hit) => {
    const n = Number(hit && hit.index);
    return Number.isFinite(n) ? n : 0;
  };

  // Hits in, items out, in the order each item FIRST appears. An item keeps the hit objects themselves - the result
  // row prints their excerpt fields - and `fields` lists the distinct fields it matched in, so a caller can say
  // which parts of the turn matched without walking the hits again. `stamp` is the newest timestamp among its rows
  // (the moment the reader last saw this message do something), and `first` is the item's place in the answer, which
  // is what keeps a time tie stable. A hit with no thread or no id is not an item: there would be nothing on the
  // page to open. `assistantId`/`assistant` ride along from the hit so a header can name whose message it is and the
  // cross-assistant tie has one fact to read.
  function group(hits) {
    const items = [];
    const byKey = new Map();
    for (const hit of Array.isArray(hits) ? hits : []) {
      if (!hit || typeof hit !== "object") continue;
      if (hit.id == null || hit.thread == null) continue;
      const key = keyOf(hit);
      let item = byKey.get(key);
      if (!item) {
        item = {
          key,
          thread: String(hit.thread),
          id: String(hit.id),
          turn: Number(hit.turn) || 0,
          assistantId: hit.assistantId == null ? "" : String(hit.assistantId),
          assistant: hit.assistant == null ? "" : String(hit.assistant),
          stamp: 0,
          first: items.length,
          hits: [],
          fields: [],
        };
        byKey.set(key, item);
        items.push(item);
      }
      item.hits.push(hit);
      const at = atOf(hit);
      if (at > item.stamp) item.stamp = at;
      if (!item.assistantId && hit.assistantId != null) item.assistantId = String(hit.assistantId);
      if (!item.assistant && hit.assistant != null) item.assistant = String(hit.assistant);
      const field = hit.field == null ? "" : String(hit.field);
      if (field && !item.fields.includes(field)) item.fields.push(field);
    }
    return items;
  }

  // Two items at the same instant. Inside ONE conversation the store's own numbering decides and then the answer's
  // order, which is what makes a tie stable. ACROSS conversations - the case the every-assistant search creates - the
  // numbering is not comparable, so the ASSISTANT decides, then the thread, and only then the numbering: two
  // assistants that answered at the same millisecond hold their order whatever order the answer listed them in.
  function tie(a, b) {
    if (a.thread !== b.thread) {
      const owner = String(a.assistantId || a.assistant || a.thread).localeCompare(String(b.assistantId || b.assistant || b.thread));
      if (owner) return owner;
      const thread = String(a.thread).localeCompare(String(b.thread));
      if (thread) return thread;
    }
    return a.turn - b.turn || a.first - b.first;
  }

  // The walk's order: items newest first, their rows in reading order, ties by the assistant and the conversation's
  // own numbering. The input list is not touched - the caller keeps the answer exactly as the server sent it - and a
  // hit that cannot name a message stays at the end in its own order, because a walk that silently dropped it would
  // print a total smaller than the `matched` count beside it.
  function order(hits) {
    const list = Array.isArray(hits) ? hits.slice() : [];
    const items = group(list);
    items.sort((a, b) => b.stamp - a.stamp || tie(a, b));
    const out = [];
    const kept = new Set();
    for (const item of items) {
      const rows = item.hits.map((hit) => ({ hit }));
      rows.sort((a, b) => readingRank(a.hit) - readingRank(b.hit) || lineIndex(a.hit) - lineIndex(b.hit));
      for (const row of rows) {
        out.push(row.hit);
        kept.add(row.hit);
      }
    }
    for (const hit of list) if (!kept.has(hit)) out.push(hit);
    return out;
  }

  // One press, one MATCH is the walk's rule (public/core/search-count.js's `step`), so the item map answers
  // only the grouping question: which turn does this hit belong to, and how many turns does a list hold.
  root.wtSearchItems = { keyOf, group, order };
})(globalThis);
