// Choosing which of the worktree chart's twelve columns are drawn.
//
// Five facts, each driven rather than read off the source:
//
//   1. the server's normaliser keeps only the ids the panel knows, in canonical order, and never hides every column —
//      an empty table has no row to bring the columns back from;
//   2. the page's column list and the server's are the SAME list, in the same order. A typo on either side hides
//      nothing and reports success, which is indistinguishable from a switch that does not work;
//   3. the header and the column-spanning rows are built from the shown set, so hiding a column leaves a table whose
//      header and every row still agree (colspan 12 → 9, not a bare strip of panel at the right edge);
//   4. the OWNER column is the one the page decides for itself: it hides while every row is on Assistant #1 and no
//      second assistant exists — a column of identical tags — and comes back on its own for a reassigned tree or a
//      second assistant, without the reader moving a switch. `DEFAULT_HIDDEN_COLUMNS` is empty because of it: a
//      default that hid the column would hide the one thing that makes it useful;
//   5. POST /api/settings/columns writes the panel's own config.json, the answer carries the stored list back, and the
//      choice survives a restart of the process that never saw the browser;
//   6. the WRITE survives a panel slow enough to miss its deadline: the switches and the counter hold the list the
//      reader asked for while the request is retried with backoff for at least a minute, the server's answer is what
//      the page and the file then agree on, and only a real, final failure puts the switch back with the reason.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CHART_COLUMN_IDS, DEFAULT_HIDDEN_COLUMNS, REQUIRED_COLUMN_ID, chartColumnsFrom, shownChartColumns } from "../lib/chart-columns.js";
import { post, sliceRegion, startPanel } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
// The chart's own code moved out of public/app.js into public/charts.js in step 3 of
// docs/reports/module-map-2026-11-07.html's order of work. The column region is read from the file that carries it
// now; `src` stays public/app.js for the colspan pins at the bottom, because the rows that span the table are still
// built there.
const charts = readFileSync(new URL("../public/charts.js", import.meta.url), "utf8");
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The page's own region, run with a stub `state`: the same function the browser calls, with no board under it. The
// owner column is decided from `state.rows` and `state.assistant.assistants`, so both are part of the stub.
const region = sliceRegion(charts, "chart columns");
const page = (settings = {}, extra = {}) =>
  new Function("state", "esc", `${region}; return { CHART_COLUMNS, shownColumns, wtColspan, chartHeaderHtml, ownerMatters };`)(
    { settings, rows: new Map(), assistant: null, ...extra },
    esc,
  );

// ---- the switch row and its write, driven with no browser -----------------------------------------
// `saveChartColumns` lives in its own marked region; here it runs against a fake switch row, a fake clock and a
// `send` the test owns, which is how a 60 s retry budget is exercised in milliseconds.
const switchesSrc = sliceRegion(charts, "chart column switches");

function switchRow({ stored = [], on = {} } = {}) {
  const boxes = CHART_COLUMNS_STUB().map((c) => ({
    dataset: { chartCol: c.id },
    checked: !stored.includes(c.id),
  }));
  const holder = {
    childElementCount: boxes.length,
    innerHTML: "",
    querySelectorAll: (sel) => (sel === "[data-chart-col]" ? boxes : []),
  };
  const count = { textContent: "" };
  const preview = { textContent: "", classes: new Set(), classList: { toggle: (c, on2) => (on2 ? preview.classes.add(c) : preview.classes.delete(c)) } };
  const nodes = { "chart-cols": holder, "chart-cols-count": count, "chart-cols-preview": preview };
  const state = { settings: { hiddenColumns: stored.slice() }, rows: new Map(), assistant: null, ...on };
  const api = new Function(
    "state", "$", "esc", "apiFetch", "renderAll", "showBanner", "CHART_COLUMNS", "OWNER_COLUMN_ID", "ownerMatters",
    `${switchesSrc}; return { chartColumnsStored, chartColumnsPending, chartColumnsSentence, paintChartColumns, saveChartColumns, writeChartColumns, postChartColumns, COLUMN_WRITE_TIMEOUT_MS, COLUMN_WRITE_BUDGET_MS, COLUMN_WRITE_WAITS_MS };`,
  )(
    state,
    (id) => nodes[id] || null,
    esc,
    async () => {
      throw new Error("no apiFetch in this stub");
    },
    () => {},
    () => {},
    CHART_COLUMNS_STUB(),
    "assistant",
    () => false,
  );
  return {
    api,
    state,
    boxes,
    count,
    preview,
    box: (id) => boxes.find((b) => b.dataset.chartCol === id),
    checkedIds: () => boxes.filter((b) => b.checked).map((b) => b.dataset.chartCol),
    hiddenIds: () => boxes.filter((b) => !b.checked).map((b) => b.dataset.chartCol),
  };
}

// The page's column list, read once from the region under test so the stub cannot drift from the page.
let COLUMNS_CACHE = null;
const CHART_COLUMNS_STUB = () => (COLUMNS_CACHE ||= page().CHART_COLUMNS);
// A board with one assistant and every tree on it: the owner column has nothing to say.
const idle = () => ({ rows: new Map([["a::C:/x", { assistant: { id: "assistant-1", name: "Assistant #1", label: "Manager 1" } }]]), assistant: { assistants: [{ id: "assistant-1" }] } });
// The same board after the reader cut a second assistant: the column has something to say on every row.
const second = () => ({ rows: new Map(), assistant: { assistants: [{ id: "assistant-1" }, { id: "assistant-2" }] } });
// A tree moved to the second assistant: the column has something to say on THAT row.
const reassigned = () => ({
  rows: new Map([["a::C:/x", { assistant: { id: "assistant-2", name: "Assistant #2", label: "Manager 2" } }]]),
  assistant: { assistants: [{ id: "assistant-1" }] },
});

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

test("nothing hidden draws every header the column can speak for — and the owner column is silent on an idle board", () => {
  const { chartHeaderHtml, shownColumns, wtColspan } = page({}, idle());
  assert.equal(shownColumns().length, CHART_COLUMN_IDS.length - 1, "eleven of twelve: the owner column hides itself");
  assert.equal(wtColspan(), CHART_COLUMN_IDS.length - 1);
  assert.doesNotMatch(chartHeaderHtml(), /data-col-id="assistant"/);
  const html = chartHeaderHtml();
  for (const id of CHART_COLUMN_IDS.filter((x) => x !== "assistant")) assert.match(html, new RegExp(`data-col-id="${id}"`));
  assert.match(html, /Ahead \/ Behind/);
  // Life and Next read are two columns now: the age and its chips, the ring and its countdown. Each keeps its own
  // header and its own explanation, and the Life id is unchanged so a stored hiddenColumns entry still lands on it.
  assert.match(html, /<th data-col-id="life"[^>]*>Life<\/th>/);
  assert.match(html, /<th data-col-id="nextread"[^>]*>Next read<\/th>/);
  // The two long explanations stay on their own headers rather than being lost with the hand-written markup.
  assert.match(html, /data-col-id="ahead" title="/);
  assert.match(html, /data-col-id="life" title="[^"]*time since this worktree was last seen alive/);
  assert.match(html, /data-col-id="nextread" title="[^"]*the ring fills up to green/);
  assert.doesNotMatch(html, /Life \/ next read/);
});

test("the owner column comes back on its own for a second assistant, or for one reassigned tree", () => {
  for (const [why, board] of [
    ["a second assistant exists", second()],
    ["a tree was moved to another assistant", reassigned()],
  ]) {
    const { chartHeaderHtml, shownColumns } = page({}, board);
    assert.equal(shownColumns().length, CHART_COLUMN_IDS.length, `all twelve with ${why}`);
    assert.match(chartHeaderHtml(), /data-col-id="assistant"/, `the header returns with ${why}`);
  }
  // A stored owner that is gone still says something: the cell draws the fallback's owner, and the tooltip why.
  const gone = { rows: new Map([["a::C:/x", { assistant: { id: "assistant-1", stored: "assistant-9" } }]]), assistant: { assistants: [{ id: "assistant-1" }] } };
  assert.equal(page({}, gone).shownColumns().length, CHART_COLUMN_IDS.length, "a stored owner keeps the column up");
});

test("the reader's own switch still wins over the column's self-hide", () => {
  const { shownColumns, chartHeaderHtml } = page({ hiddenColumns: ["assistant"] }, second());
  assert.equal(shownColumns().length, CHART_COLUMN_IDS.length - 1);
  assert.doesNotMatch(chartHeaderHtml(), /data-col-id="assistant"/);
  // …and the reader hiding everything else leaves the owner column alone on the chart — not an empty table, and not
  // the actions cell, which is the survivor only when EVERY column (the owner's included) is hidden.
  const only = page({ hiddenColumns: CHART_COLUMN_IDS.filter((id) => id !== "assistant") }, second());
  assert.deepEqual(only.shownColumns(), [CHART_COLUMN_IDS.indexOf("assistant")]);
  const none = page({ hiddenColumns: [...CHART_COLUMN_IDS] }, second());
  assert.deepEqual(none.shownColumns(), [CHART_COLUMN_IDS.length - 1]);
});

test("a hidden column leaves the header, the colspan and the order consistent", () => {
  // The owner column is drawn here because a second assistant exists (see the tests above); the three named columns
  // are the reader's own hidden list.
  const { chartHeaderHtml, shownColumns, wtColspan } = page({ hiddenColumns: ["tip", "cherry", "life"] }, second());
  assert.equal(wtColspan(), 9);
  assert.deepEqual(
    shownColumns().map((i) => CHART_COLUMN_IDS[i]),
    ["name", "branch", "assistant", "ahead", "pr", "dirty", "nextread", "verdict", "actions"],
  );
  const html = chartHeaderHtml();
  assert.equal((html.match(/<th /g) || []).length, 9);
  assert.doesNotMatch(html, /data-col-id="tip"/);
  assert.doesNotMatch(html, /data-col-id="cherry"/);
  assert.doesNotMatch(html, /data-col-id="life"/);
  // Keeping the id means an entry a reader stored before the split still hides Life — and only Life: the ring's new
  // column is not swept up by it.
  assert.match(html, /data-col-id="nextread"/);
  assert.ok(html.indexOf('data-col-id="branch"') < html.indexOf('data-col-id="ahead"'), "table order survives");
});

test("a config that hides every column still draws one, and it is the actions cell", () => {
  const { shownColumns, wtColspan, chartHeaderHtml } = page({ hiddenColumns: [...CHART_COLUMN_IDS] }, second());
  assert.deepEqual(shownColumns(), [CHART_COLUMN_IDS.length - 1]);
  assert.equal(wtColspan(), 1);
  assert.match(chartHeaderHtml(), /data-col-id="actions"/);
});

test("every column-spanning row asks for the shown count, never a literal 10", () => {
  // Four rows widen to the whole table: the delete question, the lock refusal, the refresh offer and an expanded
  // worktree's detail. A literal there is what leaves one of them short of the last column.
  //
  // The rows are built in TWO files now: the split that moved the board's scaffolding into public/board-scaffold.js
  // took the detail row and the refresh offer with it, and this pin kept reading public/app.js alone — so it counted
  // 2 of 4 and failed on a page whose four rows were all correct. Read the file that carries each row.
  const board = readFileSync(new URL("../public/board-scaffold.js", import.meta.url), "utf8");
  const spanning = `${src}\n${board}`;
  assert.equal((spanning.match(/colspan="10"/g) || []).length, 0);
  assert.equal((spanning.match(/colspan="\$\{wtColspan\(\)\}"/g) || []).length, 4);
});

test("POST /api/settings/columns stores the choice in config.json and survives a restart", async (t) => {
  const panel = await startPanel({ keep: true });
  // A sandbox config carries no `hiddenColumns` key: no preference has ever been expressed, so the panel serves the
  // read-time default — EMPTY, because the owner column hides itself from the rows rather than from a config — and
  // NOTHING was written to the file for it.
  const fresh = await (await fetch(`${panel.base}/api/config`)).json();
  assert.deepEqual(fresh.hiddenColumns, DEFAULT_HIDDEN_COLUMNS);
  assert.deepEqual(DEFAULT_HIDDEN_COLUMNS, [], "no column starts hidden: the owner column hides itself from the rows");
  assert.equal("hiddenColumns" in JSON.parse(readFileSync(path.join(panel.dir, "config.json"), "utf8")), false, "the default is not a written record");

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

// ---- the write that has to survive a panel slow enough to miss its deadline ----------------------

test("the retry schedule waits at least a minute in growing steps, with the budget to finish", () => {
  const { api } = switchRow();
  const waits = api.COLUMN_WRITE_WAITS_MS;
  const total = waits.reduce((a, b) => a + b, 0);
  assert.equal(waits[0], 0, "the first attempt is immediate");
  assert.ok(total >= 60_000, `the waits add up to ${total}ms, which has to be a minute or more`);
  assert.ok(api.COLUMN_WRITE_BUDGET_MS > total, "the budget has to leave room for the last attempt's own deadline");
  for (let i = 1; i < waits.length; i += 1) assert.ok(waits[i] > 0, `wait ${i} is a real wait`);
  assert.ok(api.COLUMN_WRITE_TIMEOUT_MS < 10_000, "one attempt is shorter than the client deadline this row replaced");
});

test("a write that times out twice still lands, and the switch holds the value while it tries", async () => {
  const dom = switchRow();
  let calls = 0;
  const send = async () => {
    calls += 1;
    if (calls < 3) throw new Error("the panel server did not answer within 8s - it may be restarting; try again");
    return ["life"];
  };
  const saving = dom.api.saveChartColumns(["life"], { send, waits: [0, 0, 0], sleep: async () => {} });
  // The first paint happens synchronously, before any attempt is answered: the switch is the PENDING list already.
  assert.equal(dom.box("life").checked, false, "the Life switch stays where the reader put it");
  assert.equal(dom.count.textContent, "11/12", "and the counter counts the pending value");
  assert.deepEqual(dom.hiddenIds(), ["life"]);
  assert.match(dom.preview.textContent, /the switch keeps the value you set/);
  assert.equal(dom.state.settings.hiddenColumns.length, 0, "the file's list is untouched until the panel answers");

  await saving;
  assert.equal(calls, 3, "two timeouts, then the answer");
  assert.deepEqual(dom.state.settings.hiddenColumns, ["life"], "the answer reconciles the page");
  assert.equal(dom.state.chartColsPending, null, "the pending list is cleared by the answer");
  assert.equal(dom.box("life").checked, false, "and the switch still reads the saved value");
  assert.equal(dom.count.textContent, "11/12");
  assert.doesNotMatch(dom.preview.textContent, /NOT SAVED/);
  assert.match(dom.preview.textContent, /11 of 12 columns on the chart · hidden: life/);
});

test("the server's answer wins over the list the page asked for", async () => {
  const dom = switchRow();
  const send = async () => ["tip"];
  await dom.api.saveChartColumns(["life"], { send, waits: [0], sleep: async () => {} });
  assert.deepEqual(dom.state.settings.hiddenColumns, ["tip"], "the stored list is the server's, not the page's");
  assert.deepEqual(dom.hiddenIds(), ["tip"], "and the boxes follow it");
});

test("a refusal is not retried, and the switch goes back with the panel's own reason", async () => {
  const dom = switchRow();
  let calls = 0;
  const send = async () => {
    calls += 1;
    throw Object.assign(new Error("hidden must be an array of column ids"), { final: true });
  };
  await assert.rejects(
    () => dom.api.writeChartColumns(["life"], { send, waits: [0, 0, 0], sleep: async () => {} }),
    (err) => /did not save it after 1 tries/.test(err.message) && /hidden must be an array of column ids/.test(err.message),
  );
  assert.equal(calls, 1, "a 4xx is the panel answering: another try cannot change it");
  // The row the reader actually sees, driven through the press handler's own entry point.
  await dom.api.saveChartColumns(["life"], { send, waits: [0, 0, 0], sleep: async () => {} });
  assert.equal(dom.state.chartColsPending, null);
  assert.equal(dom.box("life").checked, true, "the switch goes back to what config.json holds");
  assert.equal(dom.preview.classes.has("bad"), true);
  assert.match(dom.preview.textContent, /^NOT SAVED - the panel did not save it after 1 tries over 1s: hidden must be an array of column ids/);
  assert.match(dom.preview.textContent, /config\.json still says: every column is on the chart/);
});

test("a genuine timeout failure is reported and the row stops showing the pending value", async () => {
  const dom = switchRow({ stored: ["tip"] });
  const send = async () => {
    throw new Error("the panel server did not answer within 8s - it may be restarting; try again");
  };
  await assert.rejects(
    () => dom.api.writeChartColumns(["tip", "life"], { send, waits: [0, 0, 0], sleep: async () => {} }),
    /did not save it after 3 tries/,
  );
  await dom.api.saveChartColumns(["tip", "life"], { send, waits: [0, 0, 0], sleep: async () => {} });
  assert.deepEqual(dom.state.settings.hiddenColumns, ["tip"], "the file's list never moved");
  assert.deepEqual(dom.hiddenIds(), ["tip"], "and the row reads back that list");
  assert.equal(dom.count.textContent, "11/12");
  assert.match(dom.preview.textContent, /^NOT SAVED - the panel did not save it after 3 tries/);
});

test("a newer press owns the write: the older retry cannot overwrite it when its answer finally lands", async () => {
  const dom = switchRow();
  let release;
  const slow = () => new Promise((resolve) => { release = () => resolve(["tip"]); });
  const first = dom.api.saveChartColumns(["tip"], { send: slow, waits: [0, 0], sleep: async () => {} });
  const second = dom.api.saveChartColumns(["tip", "life"], { send: async () => ["tip", "life"], waits: [0], sleep: async () => {} });
  await second;
  assert.deepEqual(dom.state.settings.hiddenColumns, ["tip", "life"]);
  release();
  await first;
  assert.deepEqual(dom.state.settings.hiddenColumns, ["tip", "life"], "the older answer is dropped");
  assert.deepEqual(dom.hiddenIds(), ["tip", "life"]);
});

test("the one attempt classifies the answer: 2xx reconciles, 4xx is final, 5xx is worth another try", async () => {
  const dom = switchRow();
  const answer = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const api = (status, body) =>
    new Function(
      "state", "$", "esc", "apiFetch", "renderAll", "showBanner", "CHART_COLUMNS", "OWNER_COLUMN_ID", "ownerMatters",
      `${switchesSrc}; return { postChartColumns };`,
    )(dom.state, () => null, esc, answer(status, body), () => {}, () => {}, CHART_COLUMNS_STUB(), "assistant", () => false).postChartColumns;

  assert.deepEqual(await api(200, { hidden: ["tip"] })(["life"]), ["tip"], "the stored list comes back");
  await assert.rejects(() => api(400, { error: "hidden must be an array" })(["life"]), (e) => e.final === true && /hidden must be an array/.test(e.message));
  await assert.rejects(() => api(500, { error: "config.json is locked" })(["life"]), (e) => e.final === undefined && /config\.json is locked/.test(e.message));
});
