// search-count.js - the ONE readout beside the assistant's search box: what the header says, what the footer
// says, and the title on both.
//
// WHY THIS EXISTS. The box counts the thing a key press moves. That thing is the MATCH - one field of one turn:
// the prompt, the reply, or one console line - because a filter can hit five rows inside a single turn, and a
// reader who presses Down five times has to see the count move five times. How many TURNS those matches belong
// to is a fact about the answer, not about the walk, so it is carried as secondary text in the footer.
//
// THE DEFECT THIS REPLACES. The header counted TURNS ("1 of 1") while the footer counted HITS ("5 matched, 5
// displayed"), so a filter that hit five rows of one turn printed two numbers that disagreed, and the feature
// read as broken. One function now answers both, from one list, so a header and a footer cannot disagree: the
// header's total IS the number of rows the walk steps, and the footer's "displayed" is that same number.
//
// Published on globalThis as `wtSearchCount`, loaded as a classic script by public/index.html (before
// assistant.js) and imported by test/assistant-search-count.test.js - the same load contract
// public/core/turn-search.js has.
(function (root) {
  "use strict";

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The turn count is a fact the server already reports (`turns`): distinct turns over EVERY match, not just
  // the rows the cap let through. A caller holding only the rows can still answer, keyed the same way
  // lib/assistant/search.js counts distinct turns, so the fallback cannot invent a second rule.
  function countTurns(hits) {
    const seen = new Set();
    for (const hit of Array.isArray(hits) ? hits : []) {
      if (!hit || hit.id == null || hit.thread == null) continue;
      seen.add(`${hit.thread}\u0000${hit.id}`);
    }
    return seen.size;
  }

  // The walk's own arithmetic: the next index, wrapping at both ends. `current` may be -1 (nothing current
  // yet): a Down from there lands on the first row and an Up on the last. A total of 0 answers -1.
  function step(current, delta, total) {
    const n = Math.max(0, Number(total) || 0);
    if (!n) return -1;
    const d = Number(delta) < 0 ? -1 : 1;
    const c = Number(current);
    if (!Number.isFinite(c) || c < 0 || c >= n) return d < 0 ? n - 1 : 0;
    return (c + d + n) % n;
  }

  /**
   * One readout over one answer.
   *
   * `hits` is the list the box steps through - the rows the server showed, and the ONLY source of the totals both
   * surfaces print. `matched` and `turns` are the server's own counts over every match it found; a missing one falls
   * back to the list, never to a second derivation.
   *
   * `displayed` is accepted for a caller that still passes the server's copy, and ignored: the footer's "displayed"
   * is the length of `hits`, because a number the reader can count in the list cannot disagree with the list.
   *
   * @returns {{current, total, matched, displayed, turns, capped, text, foot, title}}
   *   `total` is the number of rows the keyboard steps, `current` is 1-based, `text` is the header ("2 of 5"),
   *   `foot` is the footer's wording ("5 hits matched, 5 displayed, in 1 turn"), and `capped` is true when the
   *   answer held more matches than the list shows.
   */
  function readout({ hits = [], matched = null, turns = null, at = -1 } = {}) {
    const list = Array.isArray(hits) ? hits : [];
    const total = list.length;
    const count = (value, fallback) => {
      if (value == null || value === "") return fallback;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
    };
    const m = count(matched, total);
    const d = total;
    const t = count(turns, countTurns(list));
    const n = Number(at);
    const current = total ? (Number.isFinite(n) && n >= 0 && n < total ? Math.floor(n) + 1 : 1) : 0;
    const capped = m > d;
    // The header speaks the WALK. The footer speaks the ANSWER, and its "displayed" is the same list the header
    // divides up, so the two cannot print different totals in one view.
    const text = `${current} of ${total}`;
    const foot = total ? `${plural(m, "hit", "hits")} matched, ${d} displayed, in ${plural(t, "turn", "turns")}` : "";
    const title = !total
      ? "no turn matches this filter"
      : capped
        ? `${plural(t, "turn", "turns")}, ${m} hits matched, ${d} displayed; your own input is kept when the cap bites, so the list may not hold every match`
        : `${plural(t, "turn", "turns")}, ${m} hits matched; Up and Down step one match per press, Enter opens the turn it is in`;
    return { current, total, matched: m, displayed: d, turns: t, capped, text, foot, title };
  }

  root.wtSearchCount = { countTurns, readout, step };
})(globalThis);
