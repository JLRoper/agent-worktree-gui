// The permissions history's pure half: what a row IS, the order it takes, and the honest count over the cap.
//
// The popup (public/permissions-history.js) owns the DOM, the fetch, the answer press and the geometry. Everything a
// test wants to pin down without a browser lives here, in the same shape as public/core/clarify-history.js: one
// global object, no DOM and no clock except the one passed in.
//
// THE THREE STATES, and why "expired" is one of them:
//
//   open      the request is still parked on the panel and a person has not pressed anything. Full colour, the exact
//             request text, the choices the host allowed, and the answer control.
//   answered  a person pressed a choice and the host accepted it. The row is quiet and the choice is its strongest
//             element, with the request text muted behind it: the decision is what the reader is scanning for.
//   expired   nobody chose. The window closed (or the panel restarted, or the gateway dropped the request) and the
//             host's own fail-closed rule denied the command. It must NOT read as a decision, so it carries the
//             reason and how long the request waited instead: "timed out after 4m".
//
// The store bounds itself (lib/permissions-history.js keeps 400). This file bounds the RENDER, and every count it
// prints counts what the popup was handed: "showing 50 of 137" is never the number it chose to draw.
(function (root) {
  "use strict";

  /** Rows drawn before the reader asks for the rest. The footer names the total either way. */
  const RENDER_CAP = 50;
  const STATES = ["open", "answered", "expired"];
  // The four the host's approval contract allows, and the words the panel has always used for them (public/app.js
  // APPROVAL_LABEL, lib/jobs.js APPROVAL_CHOICE_LABEL): the popup must not invent a fifth vocabulary.
  const CHOICE_LABEL = { once: "Allow once", session: "Allow for session", always: "Always allow", deny: "Deny" };

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  const asMs = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const t = Date.parse(String(v || ""));
    return Number.isFinite(t) ? t : 0;
  };

  /** One of the states, defensively: an unknown status reads as expired, never as a decision nobody made. */
  function stateOf(entry) {
    const s = String(entry?.state || entry?.status || "").trim();
    if (STATES.includes(s)) return s;
    return s ? "expired" : "open";
  }

  /**
   * The order the popup draws, and why it is not simply newest first: an OPEN request is a person's to-do and a
   * settled row is history, so every open row comes first (the one whose window closes soonest at the top, because
   * that is the one time is running out on), then the settled rows newest first. A row that is still open but that
   * the live queue no longer carries is drawn as expired by the route before it reaches here, so "open" always means
   * answerable.
   */
  function ordered(entries) {
    const all = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === "object").slice();
    const byDeadline = (a, b) => (Number(a.deadline) || Infinity) - (Number(b.deadline) || Infinity) || Number(a.seq || 0) - Number(b.seq || 0);
    const bySeq = (a, b) => Number(b.seq || 0) - Number(a.seq || 0) || asMs(b.askedAt) - asMs(a.askedAt);
    const open = all.filter((e) => stateOf(e) === "open").sort(byDeadline);
    const settled = all.filter((e) => stateOf(e) !== "open").sort(bySeq);
    return [...open, ...settled];
  }

  /** "16m", "2h", "3d". The span a row prints beside its age or in "timed out after 16m". */
  function spanText(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n < MIN) return "moments";
    if (n < HOUR) return `${Math.max(1, Math.round(n / MIN))}m`;
    if (n < DAY) return `${Math.round(n / HOUR)}h`;
    return `${Math.round(n / DAY)}d`;
  }

  /** The row's age: when it was asked, as the reader reads a list. */
  function ageText(entry, now = Date.now()) {
    const asked = asMs(entry?.askedAt || entry?.receivedAt);
    if (!asked) return "";
    const ms = Math.max(0, Number(now) - asked);
    if (ms < MIN) return "just now";
    return `${spanText(ms)} ago`;
  }

  /**
   * What an expired row says. The store records the word and the moment; the span is counted from the ASK, because
   * "timed out after 4m" is about how long the request waited, not when the row was tidied away.
   */
  function closedLine(entry) {
    const why = String(entry?.closedWhy || "timed out").trim() || "timed out";
    const asked = asMs(entry?.askedAt || entry?.receivedAt);
    const at = asMs(entry?.closedAt || entry?.answeredAt);
    if (!asked || !at || at < asked) return why;
    return `${why} after ${spanText(at - asked)}`;
  }

  /** The choice as the row prints it: the panel's own word for it, with the key when it differs. */
  function choiceText(entry) {
    const key = String(entry?.choice ?? "").trim();
    if (!key) return "";
    const label = CHOICE_LABEL[key] || key;
    return label === key ? key : `${label} (${key})`;
  }

  /** The exact request text, as one line, for a title or a muted copy. The row body keeps its own line breaks. */
  function requestLine(entry, n = 240) {
    const t = String(entry?.command ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "(the request text was not recorded)";
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  /** The gateway's one-line policy note, or empty when the host sent none. */
  function policyLine(entry) {
    return String(entry?.policy ?? "").replace(/\s+/g, " ").trim();
  }

  /** How long is left on an open request, as the row prints it beside the countdown. */
  function leftText(entry, now = Date.now()) {
    const deadline = Number(entry?.deadline) || 0;
    if (!deadline) return "no window given";
    const left = deadline - Number(now);
    if (left <= 0) return "window closed";
    return `~${spanText(left)} left`;
  }

  /** The four names a row carries, each falling back rather than printing an empty cell. */
  function namesOf(entry) {
    const thread = String(entry?.thread || "").trim();
    const agent = String(entry?.agent || thread || "").trim() || "an agent";
    const run = String(entry?.runId || "").trim();
    const tree = String(entry?.tree || "").trim();
    const assistant = String(entry?.assistantName || "").trim();
    return {
      agent,
      run: run || "no run recorded",
      thread: thread || "no thread recorded",
      tree: tree || "(no tree)",
      assistant: assistant || (entry?.assistantId ? String(entry.assistantId) : "no assistant"),
    };
  }

  /**
   * How many requests are waiting on a person, off the LIVE list the board already carries: /api/state's `approvals`,
   * which is the approval transport's own queue (lib/approvals.js `list()`), applied by public/settings.js and kept
   * current by the approval frames. A request whose deadline has passed is NOT waiting - the gateway has denied the
   * command by then - so it counts nothing even while the panel's sweep has not removed it yet. One entry per id,
   * because one request is one question however many frames carried it.
   */
  function openCount(list, now = Date.now()) {
    const rows = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
    const seen = new Set();
    let n = 0;
    for (const r of rows) {
      const id = String(r?.id || "").trim();
      if (!id || seen.has(id)) continue;
      const deadline = Number(r?.deadline) || 0;
      if (deadline && Number(now) >= deadline) continue;
      seen.add(id);
      n += 1;
    }
    return n;
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
    if (!t) return "no permission requests yet";
    if (s >= t) return `showing all ${t}`;
    return `showing ${s} of ${t}`;
  }

  root.wtPermissionsHistory = {
    RENDER_CAP,
    STATES,
    CHOICE_LABEL,
    stateOf,
    ordered,
    spanText,
    ageText,
    closedLine,
    choiceText,
    requestLine,
    policyLine,
    leftText,
    namesOf,
    openCount,
    capOf,
    footText,
  };
})(typeof window !== "undefined" ? window : globalThis);
