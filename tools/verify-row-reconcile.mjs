// The row's ⟳, proved from the shipped page rather than a copy of it — the same technique as
// tools/verify-merge-chip.mjs, and for the same reason: the markup and the request are the parts a browser proof
// would catch, and reading them out of public/app.js is enough to catch a drift in either.
//
//   node tools/verify-row-reconcile.mjs
//
// Three things, in the order the reader meets them:
//   1. the button is in the row-actions cell, LEFT of the ✕, and is not drawn on the project's own checkout row;
//   2. its tooltip sells the reconcile rather than a re-read the sweep already does every 5-30 s;
//   3. the click posts the read ONE DEPTH DEEPER — /api/refresh/row with `reconcile: true` — never a second route,
//      and paints the returned row in place.
//
// No browser: the function is sliced out of the page and driven with stubs for exactly the things it touches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// CRLF on a Windows checkout: normalised once so a "one function" slice is the same shape on either line ending.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// ---- 1. the markup -------------------------------------------------------------------------------------
const cell = src.split("\n").find((line) => line.includes('class="row-actions"') && line.includes("data-refresh-tree"));
assert.ok(cell, "public/app.js still draws the row-actions cell with a ⟳ in it");
assert.ok(
  cell.includes('isProjectRoot ? "" : `'),
  "both controls live in the isProjectRoot ternary, so the project's own checkout row draws neither",
);
const atRefresh = cell.indexOf('data-refresh-tree="');
const atDelete = cell.indexOf('data-del-tree="');
assert.ok(atRefresh > 0, "the ⟳ is a control on the row");
assert.ok(atDelete > atRefresh, "the ⟳ sits LEFT of the ✕");
assert.match(cell.slice(cell.lastIndexOf("<button", atRefresh)), /class="btn-refresh-tree"/);
assert.match(cell, /title="reconcile this one worktree[^"]*TODO[^"]*description[^"]*journalled/,
  "the tooltip names the TODO, the description and the journal — the parts a re-read alone does not do");

// ---- 2. the click --------------------------------------------------------------------------------------
const begin = src.indexOf("async function refreshTreeRow(btn) {");
const end = src.indexOf("\n}\n", begin);
assert.ok(begin > 0 && end > begin, "refreshTreeRow is still one function in public/app.js");
const body = src.slice(begin, end + 2);

const calls = [];
const placed = [];
const banners = [];
const opened = [];
const cleared = [];
const stubs = {
  apiFetch: async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, project: "proj", row: { path: "C:/x/wt", name: "wt" }, journal: ["re-read, nothing moved"], agent: { offered: true } }) };
  },
  placeRow: (...args) => placed.push(args),
  showBanner: (s) => banners.push(s),
  clearRefreshOffer: (k) => cleared.push(k),
  paintRefreshOffer: (k) => opened.push(k),
  refreshAgentMode: () => "ask",
  state: { rows: new Map([["proj::C:/x/wt", { project: "proj", path: "C:/x/wt", name: "wt" }]]) },
  state_refreshOffers: new Map(),
};
// `state.refreshOffers` is read and written by the function under test, so it has to be the same object.
stubs.state.refreshOffers = stubs.state_refreshOffers;

const fn = new Function(
  "apiFetch",
  "placeRow",
  "showBanner",
  "clearRefreshOffer",
  "paintRefreshOffer",
  "refreshAgentMode",
  "state",
  `${body}\nreturn refreshTreeRow;`,
);
const refreshTreeRow = fn(
  stubs.apiFetch,
  stubs.placeRow,
  stubs.showBanner,
  stubs.clearRefreshOffer,
  stubs.paintRefreshOffer,
  stubs.refreshAgentMode,
  stubs.state,
);

const btn = { dataset: { refreshTree: "proj::C:/x/wt" }, disabled: false, isConnected: true, classList: { add() {}, remove() {} } };
await refreshTreeRow(btn);

assert.equal(calls.length, 1, "one click, one request");
assert.equal(calls[0].url, "/api/refresh/row", "the ⟳ posts to the read the ring already uses — there is no second route");
assert.equal(calls[0].body.reconcile, true, "and asks for the reconcile depth");
assert.equal(calls[0].body.project, "proj");
assert.equal(calls[0].body.path, "C:/x/wt");
assert.equal(calls[0].body.refreshAgent, "ask", "the reader's agent setting travels with the click");
assert.equal(placed.length, 1, "the answered row is painted in place, so a nothing-moved click still shows");
assert.equal(placed[0][1].path, "C:/x/wt");
assert.ok(opened.length === 1, "the offer card is drawn from the server's own `agent.offered`");
assert.ok(/re-read, nothing moved/.test(banners[0] || ""), `the banner says what the pass found: ${banners[0]}`);
assert.equal(btn.dataset.busy, undefined, "the button is usable again afterwards");
assert.equal(btn.disabled, false);

// A row that vanished between the paint and the click must not send anything.
calls.length = 0;
await refreshTreeRow({ dataset: { refreshTree: "proj::C:/gone" }, disabled: false, isConnected: true, classList: { add() {}, remove() {} } });
assert.equal(calls.length, 0, "a row the page no longer holds is not reconciled");

console.log("row reconcile: markup, tooltip and request all hold");
