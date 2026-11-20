// row-chips.js - the two per-row cards as one-line chips: the collapsed label of the RESULT, the open/resolved
// count of the COLLISION pairs, and the per-row remembered expansion both of them read.
//
// WHY THIS EXISTS. The result card and the collision card were blocks in the row's detail: two tall paragraphs that
// only existed once the reader opened the row, and the reader opened the row to find out whether there was anything
// worth opening. A row now carries both as ONE-LINE chips in its chip strip, and the card itself is a popup behind
// the chip. That leaves three things that a renderer and a popup must agree about, and all three are pure:
//
//   the label      the result's first CLAUSE, the run's age, and "reviewed" once it has been checked - never a
//                  path (the report path is what the popup is for) and never a chevron (a collapsed chip carries
//                  neither; the chevron appears when the chip is expanded)
//   the count      the collision pairs of ONE row, split into open and resolved. A pair is RESOLVED when a ruling
//                  is recorded against it - the reader's or the panel's own automatic pick - or when a side stood
//                  down, which is the assistant's resolution of it. Both numbers come from the store's own state
//                  (the record the row carries), so a ruling stops counting as open the moment it is recorded and
//                  not when the card is next drawn.
//   the memory     which chips are expanded, per row and per card, as a set of "<kind>|<row key>" entries that the
//                  page persists in its browser settings store. Only OPENING is remembered, so a row nobody has
//                  opened starts collapsed, and a repaint that rebuilds the row reads the same set and comes back
//                  open instead of slamming the card shut under the reader.
//
// Published on globalThis as `wtRowChips`, loaded as a classic script by public/index.html (before app.js) and
// imported by test/row-chips.test.js - the same load contract public/core/review-lane.js has.
(function (root) {
  "use strict";

  const CHIP_KINDS = ["result", "collision"];
  // A chip is ONE line in a row that is already one line: enough for the first clause of a real summary, short enough
  // that the row's name keeps the width it needs beside it (the chip's own max-width, public/chart.css, is the
  // second half of the same rule).
  const LABEL_CAP = 58;
  const ELLIPSIS = "\u2026";
  // A path the collapsed chip must never carry. The report path is the one thing the expansion exists to show, and a
  // drive letter in a chip is a machine's own directory in a reading surface: both are stripped here rather than
  // trusted to the summary's wording. Relative paths (docs/reports/...) are NOT paths in this sense - they are how a
  // run names its report, and they may stay in a clause that a run wrote itself.
  const ABS_PATH = /(?<![\w.@+~\/-])(?:[A-Za-z]:[\\/][^\s,;:()"']*|\\\\[^\s,;:()"']+|\/(?:[\w.@+~-]+\/)+[\w.@+~./-]*)/g;

  const stripPaths = (text) =>
    String(text ?? "")
      .replace(ABS_PATH, " ")
      .replace(/\s+/g, " ")
      .trim();

  // The FIRST CLAUSE of a sentence: up to a full stop, question mark or exclamation that ends one, or a semicolon.
  // Capped at a word boundary with an ellipsis, so a run that wrote one long sentence still yields a chip rather
  // than a line of tiny text.
  function firstClause(text) {
    const cleaned = stripPaths(text);
    if (!cleaned) return "";
    const cut = cleaned.match(/^(.+?)(?:[.!?](?:\s|$)|;|$)/);
    let clause = (cut ? cut[1] : cleaned).trim().replace(/[,;:.\s]+$/, "");
    if (!clause) clause = cleaned;
    if (clause.length > LABEL_CAP) {
      const head = clause.slice(0, LABEL_CAP);
      const space = head.lastIndexOf(" ");
      const trimmed = (space > 24 ? head.slice(0, space) : head).replace(/[,;:.\s]+$/, "");
      clause = `${trimmed}${ELLIPSIS}`;
    }
    return clause;
  }

  // The result chip's collapsed text: the clause, then the run's age (the caller formats it, because the page has one
  // relative-time reader and a second one here would drift from it), then "reviewed" when it has been checked.
  function resultLabel(rec, age = "") {
    const r = rec || {};
    const bits = [];
    const clause = firstClause(r.summary);
    if (clause) bits.push(clause);
    const when = String(age || "").trim();
    if (when) bits.push(when);
    if (r.reviewedAt) bits.push("reviewed");
    return bits.join(" \u00b7 ");
  }

  // A pair is RESOLVED when a ruling is recorded against it - the reader's pick or the panel's own automatic one -
  // or when a side stood down (its notice closed, or its queue row finished: the assistant's own resolution), or when
  // a LANDING has superseded it (lib/collisions.js `supersede`): a pair whose branch is already in main is not open,
  // and counting it open would keep a row violet for work that is over.
  function pairResolved(rec) {
    if (!rec) return false;
    if (rec.superseded) return true;
    // A counterpart resolved to the same tree, or to no tree at all, is settled by that answer: there is no decision
    // left for the reader, and no press the card could honestly offer.
    if (rec.resolution && rec.resolution.kind && rec.resolution.kind !== "tree") return true;
    // A pair git MEASURED as touching nothing in common is not a decision either: the card prints "no shared file"
    // and offers no press, so counting it open would leave a chip glowing on a pair nobody can act on.
    if (rec.resolution?.kind === "tree" && rec.evidence?.ok === true && Array.isArray(rec.evidence.files) && rec.evidence.files.length === 0) return true;
    if (rec.ruling) return true;
    const stood = Array.isArray(rec.stoodDown) ? rec.stoodDown : Object.values(rec.stoodDown || {});
    if (stood.some(Boolean)) return true;
    return Array.isArray(rec.stoodByTask) && rec.stoodByTask.length > 0;
  }

  // One row's pairs, counted. `project` scopes the count to the row's own project: a record that names another
  // project is that project's pair and is not drawn on this row's chip. A record with no project (an older store, or
  // a worker's note that named no tree) is this row's, because it arrived through this tree's own list.
  function tally(list, project = null) {
    const rows = Array.isArray(list) ? list : [];
    let open = 0;
    let resolved = 0;
    for (const rec of rows) {
      if (!rec) continue;
      if (project && rec.project && rec.project !== project) continue;
      if (pairResolved(rec)) resolved += 1;
      else open += 1;
    }
    return { open, resolved, total: open + resolved };
  }

  // The collision chip's two numbers. Both are always drawn: "0 open . 5 resolved" is the sentence that says the
  // row is quiet, which a lone "5 resolved" leaves the reader to infer.
  function collisionLabel(counts) {
    const open = Math.max(0, Math.floor(Number(counts && counts.open) || 0));
    const resolved = Math.max(0, Math.floor(Number(counts && counts.resolved) || 0));
    return `${open} open \u00b7 ${resolved} resolved`;
  }

  // ---- the remembered expansion ----------------------------------------------------------------------------------
  // "<kind>|<row key>": the kind first, so one store holds both cards and a row can have one of them open without
  // opening the other.
  function chipId(kind, key) {
    return `${String(kind || "")}|${String(key || "")}`;
  }

  function readOpen(raw) {
    try {
      const parsed = JSON.parse(raw || "[]");
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((id) => typeof id === "string" && CHIP_KINDS.some((k) => id.startsWith(`${k}|`))));
    } catch {
      return new Set();
    }
  }

  function storeValue(set) {
    return JSON.stringify([...(set || [])].filter((id) => typeof id === "string").sort());
  }

  function isOpen(set, kind, key) {
    return Boolean(set && typeof set.has === "function" && set.has(chipId(kind, key)));
  }

  // A NEW set, so a caller can hand the answer straight to its store without a second read of what changed.
  function toggle(set, kind, key) {
    const next = new Set(set || []);
    const id = chipId(kind, key);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  // The entries of a stored set, as {kind, key}: what a painter walks to reopen the rows a reader left open.
  function entries(set) {
    const out = [];
    for (const id of set || []) {
      const bar = String(id).indexOf("|");
      if (bar < 0) continue;
      const kind = String(id).slice(0, bar);
      const key = String(id).slice(bar + 1);
      if (!CHIP_KINDS.includes(kind) || !key) continue;
      out.push({ kind, key });
    }
    return out;
  }

  root.wtRowChips = {
    CHIP_KINDS,
    LABEL_CAP,
    firstClause,
    resultLabel,
    pairResolved,
    tally,
    collisionLabel,
    chipId,
    readOpen,
    storeValue,
    isOpen,
    toggle,
    entries,
  };
})(globalThis);
