// core/chip-filters.js — the project header's summary chips, as predicates over one row.
//
// A chip in a project header counts rows ("4 unmerged"). Clicking that chip filters the project's table to the rows it
// counts. The count and the filter are the same function, so the number on the chip and the rows drawn cannot disagree.
// Only chips whose count is a count of worktree rows are here; the session and agent chips (hermes, claude, panels,
// awaiting approval) count sessions or cards, not rows, so they stay display-only.
//
// This is a classic script in the page and a plain module to node (it publishes itself on globalThis), so the test
// imports the one implementation the page runs rather than a copy of it.
(function (root) {
  "use strict";

  const verdictOf = (r) => String(r.verdict || "");

  const predicates = {
    merged: (r) => verdictOf(r).startsWith("MERGED"),
    nocommits: (r) => {
      const v = verdictOf(r);
      return v.startsWith("NO COMMITS") || v.startsWith("EMPTY REPO");
    },
    unmerged: (r) => {
      const v = verdictOf(r);
      return !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN";
    },
    dirty: (r) => !!(r.dirty || r.untracked),
    serving: (r) => !!r.signals?.ports?.on,
    removable: (r) => !!r.mergeable,
    stale: (r) => !!r.verdictStale,
  };

  root.ChipFilters = { predicates };
})(globalThis);
