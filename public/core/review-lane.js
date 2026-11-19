// review-lane.js - the review lane's arithmetic, in one place: is a row awaiting a check, how many are, does the
// filter keep it, and where does it sit in the reader's H rotation.
//
// WHY THIS EXISTS. The lane is drawn on four surfaces - the amber marker on the row, the card in the row's detail,
// the header count that filters the table, and the Human rotation that steps into it - and every one of them has to
// answer "is this row awaiting review" the same way. A predicate copied four times is a predicate that will
// disagree with itself the first time a field moves, which is the defect this module exists to prevent: the row
// carries `review` from the panel (server.js `withReviews` -> lib/review-inbox.js), and the ONE reading of it is
// `awaiting` below.
//
// THE ROW IS THE TRUTH ABOUT THE COUNT. A delivery lives in a store (reviews.json) and a store outlives the tree it
// describes: a row that was archived or deleted still has an entry until the panel prunes it. Counting entries would
// then badge work that is gone. So every count here takes ROWS - the list the board is drawing - and a row that is
// not in that list cannot be counted, whatever the store says. The header count and the filter read the same list,
// so "the count" and "the rows it filters to" are the same number by construction.
//
// THE ROTATION. `sortHuman` orders the three kinds the Human key steps through - a permission first, then a clarify
// question, then a row to review - and oldest first inside each kind, because the oldest unanswered thing is the
// one most likely to be the thing that is stuck. It is a stable sort over an already-built list, so a caller that
// knows something the rank does not (a card on screen, say) keeps its own order inside equal keys.
//
// Published on globalThis as `wtReviewLane`, loaded as a classic script by public/index.html (before app.js) and
// imported by test/review-lane.test.js - the same load contract public/core/search-count.js has.
(function (root) {
  "use strict";

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The four kinds, in the order the H rotation must step them. A permission is a run that cannot proceed without
  // the reader; a question is a run waiting on a decision; a review is work that is already finished and only needs
  // to be looked at. In that order, because the first two are blocking and the third is not. A COLLISION comes last:
  // it is the one kind where work has NOT stopped - the two assistants are already on it and the panel only hands it
  // over when they cannot settle it - so it must not push a blocked run or an unread result down the rotation.
  const RANK = { permission: 0, approval: 0, write: 0, question: 1, clarify: 1, review: 2, collision: 3 };

  // A delivery awaiting a check: the one predicate. `reviewedAt` is the panel's stamp, and its ABSENCE is what the
  // amber marker means - not the presence of the record, because a reviewed delivery keeps its card.
  function awaiting(row) {
    const rec = row && row.review;
    return Boolean(rec && rec.summary && !rec.reviewedAt);
  }

  // A collision awaiting the reader: the pair has been handed over (state `reader`) and nobody has ruled on it. The
  // SAME PAIR is carried by BOTH rows, so every count and every list here dedupes on the record's key: one overlap is
  // one decision, however many rows wear the marker. A ruled pair is not awaiting anything - it renders as already
  // ruled, which is the whole point of storing the ruling against the pair.
  function awaitingCollisions(row) {
    const list = row && Array.isArray(row.collisions) ? row.collisions : [];
    return list.filter((c) => c && c.state === "reader");
  }

  // The collisions on a board: unique by pair key, so the badge and the H rotation agree about how many decisions
  // there are. Returns the records themselves, oldest first, which is the order H steps them.
  function collisions(rows) {
    const seen = new Map();
    for (const row of rows || []) {
      for (const rec of awaitingCollisions(row)) {
        if (!rec.key || seen.has(rec.key)) continue;
        seen.set(rec.key, { ...rec, path: row.path, project: row.project || rec.project || null, agent: row.agent || row.name || null });
      }
    }
    return [...seen.values()].sort((a, b) => String(a.firstAt || "").localeCompare(String(b.firstAt || "")));
  }

  // How old a delivery is, in ms, for the oldest-first order. An entry with no readable stamp sorts last within its
  // kind rather than pretending to be from 1970.
  function since(row) {
    const at = Date.parse(row?.review?.at || "");
    return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
  }

  // The header count: rows awaiting review, from the ROWS. `rows` is any iterable of row objects (a Map's values, an
  // array), so the caller never has to flatten the board into a second list first.
  function count(rows) {
    let n = 0;
    for (const row of rows || []) if (awaiting(row)) n += 1;
    return n;
  }

  // The filter. `on` false keeps everything (the table as it always was); `on` true keeps exactly the rows the count
  // counted. One function for both, so a filter and a count can never be off by one.
  function keeps(row, on) {
    return !on || awaiting(row);
  }

  // The H rotation's order: kind first, then oldest first inside a kind. `sinceMs` is read off the entry the caller
  // built (`since` field), falling back to the delivery's own stamp, then to MAX so an undated item sorts last.
  function rank(item) {
    const k = String(item?.kind || "").toLowerCase();
    return RANK[k] == null ? 3 : RANK[k];
  }

  function sortHuman(items) {
    return [...(items || [])].sort((a, b) => {
      const byKind = rank(a) - rank(b);
      if (byKind) return byKind;
      const sa = Number.isFinite(a?.sinceMs) ? a.sinceMs : Number.MAX_SAFE_INTEGER;
      const sb = Number.isFinite(b?.sinceMs) ? b.sinceMs : Number.MAX_SAFE_INTEGER;
      return sa - sb;
    });
  }

  // What the Human button's title says, by kind. The badge total is the sum, and the title splits it, so a reader
  // who sees "3" can tell whether it is three blocked runs or three results to read.
  function badge(items) {
    const out = { total: 0, permissions: 0, questions: 0, reviews: 0, collisions: 0 };
    for (const item of items || []) {
      const r = rank(item);
      if (r === 0) out.permissions += 1;
      else if (r === 1) out.questions += 1;
      else if (r === 2) out.reviews += 1;
      else if (r === 3) out.collisions += 1;
      out.total += 1;
    }
    return out;
  }

  // THE READER'S FOUR SWITCHES (Settings > Human): which kinds this button counts. One reading of which switch a
  // list entry answers to, so the filter, the badge split and the title sentence cannot disagree about a kind. The
  // collision switch is its own - a reader who wants the markers on the rows but not in the rotation can have that.
  const KIND_KEYS = ["permissions", "clarify", "review", "collisions"];

  function kindKey(item) {
    const r = rank(item);
    return r === 0 ? "permissions" : r === 1 ? "clarify" : r === 2 ? "review" : r === 3 ? "collisions" : "";
  }

  // A kind is on unless the reader switched it off. An entry this module cannot place has no key, and is KEPT: a
  // switch it does not understand must not drop work it also cannot see.
  function kindOn(kinds, key) {
    return !kinds || kinds[key] !== false;
  }

  function keepKinds(items, kinds) {
    return [...(items || [])].filter((item) => kindOn(kinds, kindKey(item)));
  }

  // A caller may hand over the LIST (the natural thing: it already has it) or the badge object (when it has just
  // counted). Counting an array as if it were the badge was the bug this branch exists to make impossible.
  function asBadge(counts) {
    return Array.isArray(counts) ? badge(counts) : counts && typeof counts === "object" ? counts : badge([]);
  }

  // The split names ONLY the kinds that are on AND have something in them: a switched-off kind is not a zero in this
  // sentence, and neither is a kind that is on with nothing in it - a kind is named when there is something to name.
  // Every item in `counts` was counted from the filtered list, so a non-zero total always has at least one named kind.
  function split(counts, kinds) {
    const b = asBadge(counts);
    const parts = [];
    if (kindOn(kinds, "permissions") && b.permissions) parts.push(plural(b.permissions, "permission", "permissions"));
    if (kindOn(kinds, "clarify") && b.questions) parts.push(plural(b.questions, "clarify question", "clarify questions"));
    if (kindOn(kinds, "review") && b.reviews) parts.push(plural(b.reviews, "to review", "to review"));
    if (kindOn(kinds, "collisions") && b.collisions) parts.push(plural(b.collisions, "collision", "collisions"));
    return parts.join(", ");
  }

  function title(counts, kinds) {
    const b = asBadge(counts);
    const named = split(b, kinds);
    if (!b.total) {
      if (!named) return "nothing is waiting for you - every kind of the Human button is switched off in Settings";
      const nouns = [];
      if (kindOn(kinds, "permissions")) nouns.push("no permission");
      if (kindOn(kinds, "clarify")) nouns.push("no question");
      if (kindOn(kinds, "review")) nouns.push("no result to review");
      if (kindOn(kinds, "collisions")) nouns.push("no collision");
      return `nothing is waiting for you - ${nouns.join(", ")}`;
    }
    return `${named} - press H to step into one, Shift+H back, Esc to step out`;
  }

  // The row marker's own wording, so the tooltip and the rotation agree about what the amber mark is. Distinct from
  // the yellow lock (a tree held by a live run) and the blue turnover marker on purpose - see public/style.css.
  function markerTitle(row) {
    const rec = row?.review;
    if (!rec || !rec.summary) return "";
    const bits = ["result to review", rec.summary];
    if (rec.report) bits.push(`report: ${rec.report}`);
    if (rec.next && rec.next.length) bits.push(`${plural(rec.next.length, "next step", "next steps")}`);
    return bits.join(" - ");
  }

  // What a collision marker says: the counterpart by NAME, then the evidence, then whose turn it is. The counterpart is
  // the first thing, because "this row is in a collision" without naming the other tree is the bare flag this whole
  // feature exists to avoid.
  function collisionTitle(rec) {
    if (!rec) return "";
    const other = rec.other?.name || rec.otherTarget || "an unnamed tree";
    const files = Array.isArray(rec.files) ? rec.files : [];
    const bits = [`collision with ${other}`, plural(files.length, "shared file", "shared files")];
    if (files.length) bits.push(files.slice(0, 4).join(", "));
    if (rec.state === "ruled") bits.push(`already ruled: ${rec.ruling?.name || "a side"} goes first`);
    else if (rec.state === "reader") bits.push("yours to rule on - H steps into it");
    else bits.push("with both assistants");
    return bits.join(" - ");
  }

  root.wtReviewLane = {
    awaiting,
    awaitingCollisions,
    collisions,
    since,
    count,
    keeps,
    rank,
    sortHuman,
    badge,
    title,
    markerTitle,
    collisionTitle,
    KIND_KEYS,
    kindKey,
    keepKinds,
    split,
  };
})(globalThis);
