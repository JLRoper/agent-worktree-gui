// Choosing which of the worktree chart's ten columns are drawn.
//
// Four facts, each driven rather than read off the source:
//
//   1. the server's normaliser keeps only the ids the panel knows, in canonical order, and never hides every column —
//      an empty table has no row to bring the columns back from;
//   2. the page's column list and the server's are the SAME list, in the same order. A typo on either side hides
//      nothing and reports success, which is indistinguishable from a switch that does not work;
//   3. the header and the column-spanning rows are built from the shown set, so hiding a column leaves a table whose
//      header and every row still agree (colspan 10 → 7, not a bare strip of panel at the right edge);
//   4. POST /api/settings/columns writes the panel's own config.json, the answer carries the stored list back, and the
//      choice survives a restart of the process that never saw the browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CHART_COLUMN_IDS, REQUIRED_COLUMN_ID, chartColumnsFrom, shownChartColumns } from "../lib/chart-columns.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The page's own region, run with a stub `state`: the same function the browser calls, with no board under it.
const begin = src.indexOf("// ---- chart columns");
const end = src.indexOf("// ---- end chart columns");
assert.ok(begin > 0 && end > begin, "the chart-columns region is in public/app.js");
const region = src.slice(begin, end);
const page = (settings = {}) =>
  new Function("state", "esc", `${region}; return { CHART_COLUMNS, shownColumns, wtColspan, chartHeaderHtml };`)({ settings }, esc);

test("the server keeps only the ids it knows, in the chart's own order", () => {
  assert.deepEqual(chartColumnsFrom(["cherry", "tip"]), ["tip", "cherry"]);
  assert.deepEqual(chartColumnsFrom(["CHERRY", " tip ", "cherry"]), ["tip", "cherry"]);
  // A hand-edited config (or a page from a later build) naming something this server cannot draw is dropped rather
  // than stored: the alternative is a config that reads as "hide the branch column" and hides nothing.
  assert.deepEqual(chartColumnsFrom(["nope", 7, null, "pr"]), ["pr"]);
  assert.deepEqual(chartColumnsFrom("tip"), []);
  assert.deepEqual(chartColumnsFrom(undefined), []);
});

test("hiding every column keeps the actions cell, so the chart is never empty", () => {
  const all = chartColumnsFrom(CHART_COLUMN_IDS);
  assert.deepEqual(all, CHART_COLUMN_IDS.filter((id) => id !== REQUIRED_COLUMN_ID));
  assert.deepEqual(shownChartColumns(CHART_COLUMN_IDS), [REQUIRED_COLUMN_ID]);
});

test("the page's columns are the server's columns, in the same order", () => {
  const { CHART_COLUMNS } = page();
  assert.deepEqual(
    CHART_COLUMNS.map((c) => c.id),
    CHART_COLUMN_IDS,
  );
  // A switch with no label is unreadable in Settings, and an empty one is the actions column whose header is blank
  // in the table on purpose.
  for (const c of CHART_COLUMNS) assert.equal(typeof c.label, "string", `${c.id} carries a label`);
});

test("nothing hidden draws all ten headers, each tagged with its column id", () => {
  const { chartHeaderHtml, shownColumns, wtColspan } = page({});
  assert.equal(shownColumns().length, CHART_COLUMN_IDS.length);
  assert.equal(wtColspan(), CHART_COLUMN_IDS.length);
  const html = chartHeaderHtml();
  assert.equal((html.match(/<th /g) || []).length, CHART_COLUMN_IDS.length);
  for (const id of CHART_COLUMN_IDS) assert.match(html, new RegExp(`data-col-id="${id}"`));
  assert.match(html, /Ahead \/ Behind/);
  assert.match(html, /Life \/ next read/);
  // The two long explanations stay on their own headers rather than being lost with the hand-written markup.
  assert.match(html, /data-col-id="ahead" title="/);
  assert.match(html, /data-col-id="life" title="/);
});

test("a hidden column leaves the header, the colspan and the order consistent", () => {
  const { chartHeaderHtml, shownColumns, wtColspan } = page({ hiddenColumns: ["tip", "cherry", "life"] });
  assert.equal(wtColspan(), 7);
  assert.deepEqual(
    shownColumns().map((i) => CHART_COLUMN_IDS[i]),
    ["name", "branch", "ahead", "pr", "dirty", "verdict", "actions"],
  );
  const html = chartHeaderHtml();
  assert.equal((html.match(/<th /g) || []).length, 7);
  assert.doesNotMatch(html, /data-col-id="tip"/);
  assert.doesNotMatch(html, /data-col-id="cherry"/);
  assert.doesNotMatch(html, /data-col-id="life"/);
  assert.ok(html.indexOf('data-col-id="branch"') < html.indexOf('data-col-id="ahead"'), "table order survives");
});

test("a config that hides all ten still draws one column, and it is the actions cell", () => {
  const { shownColumns, wtColspan, chartHeaderHtml } = page({ hiddenColumns: [...CHART_COLUMN_IDS] });
  assert.deepEqual(shownColumns(), [CHART_COLUMN_IDS.length - 1]);
  assert.equal(wtColspan(), 1);
  assert.match(chartHeaderHtml(), /data-col-id="actions"/);
});

test("every column-spanning row asks for the shown count, never a literal 10", () => {
  // Five rows widen to the whole table: the delete question, the lock refusal, the rename offer, the refresh offer
  // and an expanded worktree's detail. A literal there is what leaves one of them short of the last column.
  assert.equal((src.match(/colspan="10"/g) || []).length, 0);
  assert.equal((src.match(/colspan="\$\{wtColspan\(\)\}"/g) || []).length, 5);
});

test("POST /api/settings/columns stores the choice in config.json and survives a restart", async (t) => {
  const panel = await startPanel({ keep: true });
  const first = await post(panel.base, "/api/settings/columns", { body: { hidden: ["cherry", "tip", "nonsense"] } });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.hidden, ["tip", "cherry"]);
  assert.deepEqual(first.json.settings.hiddenColumns, ["tip", "cherry"]);

  // What is in FORCE and what was WRITTEN are two different reads: the route answers with the first, and the file on
  // disk is what the next boot believes.
  const cfg = JSON.parse(readFileSync(path.join(panel.dir, "config.json"), "utf8"));
  assert.deepEqual(cfg.hiddenColumns, ["tip", "cherry"]);
  const live = await (await fetch(`${panel.base}/api/config`)).json();
  assert.deepEqual(live.hiddenColumns, ["tip", "cherry"]);
  await panel.stop();

  // A restart with no browser attached: the setting is the panel's, not the tab's.
  const again = await startPanel({ dir: panel.dir, keep: false, reuseConfig: true });
  t.after(() => again.stop());
  const after = await (await fetch(`${again.base}/api/config`)).json();
  assert.deepEqual(after.hiddenColumns, ["tip", "cherry"]);

  // And "show all" is an empty list, not a missing key.
  const cleared = await post(again.base, "/api/settings/columns", { body: { hidden: [] } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual(cleared.json.hidden, []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(panel.dir, "config.json"), "utf8")).hiddenColumns, []);
});
