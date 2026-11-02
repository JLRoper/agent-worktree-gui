// Which of the worktree chart's columns are drawn.
//
// The page owns the drawing (public/app.js `CHART_COLUMNS`), but the choice lives in this panel's own config.json so
// it survives a restart and applies to whichever browser is open — the same reason `scanMode` and
// `hideOlderThanDays` are server-side. This module is the server's half: one list of column ids, and one normaliser
// so a hand-edited config (or a page newer than the process serving it) cannot quietly hide nothing.
//
// The stored value is the columns to HIDE, not the ones to show. A column added to the chart later therefore starts
// visible for a reader who has already hidden some — the alternative would draw a new column nowhere and read as a
// broken build.
export const CHART_COLUMN_IDS = ["name", "branch", "assistant", "tip", "ahead", "cherry", "pr", "dirty", "life", "verdict", "actions"];

// A column the chart starts WITHOUT. New columns arrive visible for a reader who has already hidden some — the whole
// reason the stored value is the columns to HIDE — and there is no exception here today: the owner column used to be
// one (it shipped OFF, because it says who a tree belongs to rather than what the tree is doing), but it no longer
// needs the switch, because the page draws it only while it can say something. A board with one assistant and every
// tree on it hides the column by itself, and a reassigned tree or a second assistant brings it back without anyone
// touching Settings — so a default that hid the column would now hide the very thing that made it useful.
export const DEFAULT_HIDDEN_COLUMNS = [];

// The last column is the row's own controls (⟳ / ✕). Hiding every column is not a narrower chart, it is an empty
// table with no way to bring anything back from the row — so the actions cell survives a config that hides all ten.
export const REQUIRED_COLUMN_ID = "actions";

export function chartColumnsFrom(value) {
  const hidden = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = String(raw ?? "").trim().toLowerCase();
    if (CHART_COLUMN_IDS.includes(id)) hidden.add(id);
  }
  if (CHART_COLUMN_IDS.every((id) => hidden.has(id))) hidden.delete(REQUIRED_COLUMN_ID);
  // Canonical order, so the file reads the same however the page happened to submit its checkboxes.
  return CHART_COLUMN_IDS.filter((id) => hidden.has(id));
}

// The ids actually drawn, for a caller that wants to answer "what is on the chart" rather than "what is hidden".
export function shownChartColumns(value) {
  const hidden = new Set(chartColumnsFrom(value));
  return CHART_COLUMN_IDS.filter((id) => !hidden.has(id));
}
