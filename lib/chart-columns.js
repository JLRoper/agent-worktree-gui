// Which of the worktree chart's columns, and which of its chips, are drawn.
//
// The page owns the drawing (public/app.js `CHART_COLUMNS`), but the choice lives in this panel's own config.json so
// it survives a restart and applies to whichever browser is open — the same reason `scanMode` and `chartTopCount`
// are server-side. This module is the server's half: one list of column ids, one list of chip ids, and one normaliser
// so a hand-edited config (or a page newer than the process serving it) cannot quietly hide nothing.
//
// The stored value is the columns to HIDE, not the ones to show. A column added to the chart later therefore starts
// visible for a reader who has already hidden some — the alternative would draw a new column nowhere and read as a
// broken build.
export const CHART_COLUMN_IDS = ["name", "branch", "assistant", "initiative", "tip", "ahead", "cherry", "pr", "dirty", "life", "nextread", "verdict", "actions"];

// THE CHIP TOGGLES that share the same control and the same stored list, but are NOT columns: a chip is a mark
// drawn inside a cell that is already there, so it has no <th>, no <td> and no width to give back when it is off -
// it simply is not rendered. The reviewed chip (the amber mark and its "✓ Reviewed" press in the row's name line)
// is the first one. They are declared separately so `shownChartColumns` and the table's own arithmetic keep
// answering about COLUMNS, which is what a header, a colspan and a width are.
export const CHART_CHIP_IDS = ["reviewed"];

// Everything one switch can name, in the order the switches are drawn: the columns, then the chips. This is the
// canonical order the stored list is normalised to, so the file reads the same however the page submitted it.
export const CHART_TOGGLE_IDS = [...CHART_COLUMN_IDS, ...CHART_CHIP_IDS];

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
    if (CHART_TOGGLE_IDS.includes(id)) hidden.add(id);
  }
  if (CHART_COLUMN_IDS.every((id) => hidden.has(id))) hidden.delete(REQUIRED_COLUMN_ID);
  // Canonical order, so the file reads the same however the page happened to submit its checkboxes.
  return CHART_TOGGLE_IDS.filter((id) => hidden.has(id));
}

// The ids actually drawn as COLUMNS, for a caller that wants to answer "what is on the chart" rather than "what is
// hidden". A hidden chip is not in this answer and never should be: it is a mark inside a cell, not a column.
export function shownChartColumns(value) {
  const hidden = new Set(chartColumnsFrom(value));
  return CHART_COLUMN_IDS.filter((id) => !hidden.has(id));
}
