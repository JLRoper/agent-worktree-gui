// The Clarify history's pure half: what a row IS, the order it takes, and the honest count over the cap.
//
// The popup (public/clarify-history.js) owns the DOM, the fetch and the geometry. Everything a test wants to pin down
// without a browser lives here, in the same shape as the other core modules: one global object, no DOM and no clock
// except the one passed in.
//
// THE THREE STATES, and why "closed" is one of them:
//
//   open      the question is still parked on the turn. Full colour, its choices shown, an "unanswered" marker.
//   answered  the reader chose. The row is greyed, the chosen answer is the strongest element in it, and the question
//             sits muted behind the answer: the answer is what the reader is scanning for.
//   closed    no answer exists because the card was cancelled, timed out, was withdrawn or the turn ended. It must NOT
//             be greyed like an answered row, and it must say WHY and how long it waited: "cancelled after 16m".
//
// The store bounds itself (lib/clarify-history.js keeps 400). This file bounds the RENDER, and every count it prints
// counts the store: "showing 50 of 137" is the total the popup was handed, never the number it chose to draw.
(function (root) {
  "use strict";

  /** Rows drawn before the reader asks for the rest. The footer names the total either way. */
  const RENDER_CAP = 50;
  const STATES = ["open", "answered", "closed"];

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  const asMs = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const t = Date.parse(String(v || ""));
    return Number.isFinite(t) ? t : 0;
  };

  /** One of the three states, defensively: an unknown status reads as closed, never as an answer nobody gave. */
  function stateOf(entry) {
    const s = String(entry?.status || "").trim();
    if (STATES.includes(s)) return s;
    return s ? "closed" : "open";
  }

  /** Newest first, by the store's own sequence (askedAt only breaks a tie a hand-edited file could create). */
  function ordered(entries) {
    return (Array.isArray(entries) ? entries : [])
      .filter((e) => e && typeof e === "object")
      .slice()
      .sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0) || asMs(b.askedAt) - asMs(a.askedAt));
  }

  /** "16m", "2h", "3d". The span a row prints beside its age or in "cancelled after 16m". */
  function spanText(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n < MIN) return "moments";
    if (n < HOUR) return `${Math.max(1, Math.round(n / MIN))}m`;
    if (n < DAY) return `${Math.round(n / HOUR)}h`;
    return `${Math.round(n / DAY)}d`;
  }

  /** The row's age: when it was asked, as the reader reads a list. */
  function ageText(entry, now = Date.now()) {
    const asked = asMs(entry?.askedAt);
    if (!asked) return "";
    const ms = Math.max(0, Number(now) - asked);
    if (ms < MIN) return "just now";
    return `${spanText(ms)} ago`;
  }

  /**
   * What a closed row says. The store records the word and the moment; the span is counted from the ASK, because
   * "cancelled after 16m" is about how long the reader's card was waiting, not when the row was tidied away.
   */
  function closedLine(entry) {
    const why = String(entry?.closedWhy || "closed unanswered").trim() || "closed unanswered";
    const asked = asMs(entry?.askedAt);
    const at = asMs(entry?.closedAt || entry?.answeredAt);
    if (!asked || !at || at < asked) return why;
    return `${why} after ${spanText(at - asked)}`;
  }

  /** The answer as the row prints it: the exact text the reader chose (or the joined multi-select answer). */
  function answerText(entry) {
    return String(entry?.answer ?? "").trim();
  }

  /** A question's first line, for the muted line under an answered row and the title of any row. */
  function questionLine(entry) {
    return String(entry?.question ?? "").replace(/\s+/g, " ").trim();
  }

  /** The three names a row carries, each falling back rather than printing an empty cell. */
  function namesOf(entry) {
    const tree = String(entry?.tree || "").trim();
    const agent = String(entry?.agent || entry?.thread || "").trim() || "an agent";
    const assistant = String(entry?.assistantName || "").trim();
    return { agent, tree: tree || "(no tree)", assistant: assistant || (entry?.assistantId ? String(entry.assistantId) : "no assistant") };
  }

  /**
   * The page of rows the popup draws, with the honest total. `limit` is a render cap, never a filter: `total` is what
   * the caller handed in, `shown` is what will be drawn, and `more` says whether anything is held back.
   */
  function capOf(entries, limit = RENDER_CAP) {
    const all = ordered(entries);
    const total = all.length;
    const n = Number(limit);
    const want = Number.isFinite(n) && n > 0 ? Math.floor(n) : RENDER_CAP;
    const rows = all.slice(0, want);
    const shown = rows.length;
    return { rows, total, shown, more: total > shown, foot: footText(shown, total) };
  }

  /** "showing 50 of 137", and "showing all 12" when nothing is held back: no silent truncation either way. */
  function footText(shown, total) {
    const s = Math.max(0, Number(shown) || 0);
    const t = Math.max(0, Number(total) || 0);
    if (!t) return "no questions yet";
    if (s >= t) return `showing all ${t}`;
    return `showing ${s} of ${t}`;
  }

  root.wtClarifyHistory = {
    RENDER_CAP,
    STATES,
    stateOf,
    ordered,
    spanText,
    ageText,
    closedLine,
    answerText,
    questionLine,
    namesOf,
    capOf,
    footText,
  };
})(typeof window !== "undefined" ? window : globalThis);
