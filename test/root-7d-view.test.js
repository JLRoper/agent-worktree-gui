// The folder's All / 7d button is a VIEW of the server's tier, never a second decision (lib/tiers.js): a repo
// whose last commit is past the window is on the hourly stat gate, and the page must filter on that same answer.
// Before this, the page held its own cutoff and its own wider "touched" rule (a commit, a file edit, or any
// liveness evidence), so the view could disagree with the treatment it described. These pins read the function
// out of the page and run it with no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
// shownInRoot moved to public/render-projects.js with the folder card it decides, in step 7 of
// docs/reports/module-map-2026-11-07.html; recentDays stayed in app.js.
const projectsSrc = readFileSync(new URL("../public/render-projects.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function cut(name, from = src) {
  const start = from.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the page carries ${name}()`);
  const end = from.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is a top-level function`);
  return from.slice(start, end + 2);
}

const state = { recentRoots: new Set(["/work/trees"]), settings: {} };
const shownInRoot = new Function("state", `${cut("shownInRoot", projectsSrc)}\nreturn shownInRoot;`)(state);
const recentDays = new Function("state", "RECENT_DAYS", `${cut("recentDays")}\nreturn recentDays;`)(state, 7);

const project = (name, tier) => ({ name, path: `/work/trees/${name}`, tier, activityAt: new Date().toISOString() });

// The toggle itself lives beside the folder card in render-projects.js. Its label is now the one place the 7d
// view's shortfall is stated: the header's own count is the folder's FULL count (rootChips), so the button that
// folds the old projects away is where the reader is told how many it folded.
const rootRecentButton = new Function(
  "esc",
  "recentDays",
  `${cut("rootRecentButton", projectsSrc)}\nreturn rootRecentButton;`,
)((s) => String(s ?? ""), recentDays);

test("7d shows exactly the server's recent tier, and All shows everything", () => {
  const all = [project("fresh", "recent"), project("old", "old"), project("unclassified", undefined)];
  assert.deepEqual(
    shownInRoot("/work/trees", all).map((p) => p.name),
    ["fresh", "unclassified"],
    "the old tier is folded away; a record the server has not classified is shown, never hidden",
  );
  state.recentRoots = new Set();
  assert.deepEqual(
    shownInRoot("/work/trees", all).map((p) => p.name),
    ["fresh", "old", "unclassified"],
    "All is every project",
  );
  state.recentRoots = new Set(["/work/trees"]);
});

test("a project the server calls old stays hidden however recent its own timestamps look", () => {
  // The old rule would have kept this one: its activityAt is a minute ago. The server's tier is the answer, and
  // the page must not re-decide it from the record's dates.
  const tricky = { name: "tricky", tier: "old", activityAt: new Date().toISOString(), lastAliveAt: new Date().toISOString() };
  assert.deepEqual(shownInRoot("/work/trees", [tricky]), []);
  assert.doesNotMatch(cut("shownInRoot", projectsSrc), /activityAt|lastAliveAt|Date\.now|cutoff/, "no second cutoff in the client");
  assert.doesNotMatch(src, /RECENT_DAYS \* 864e5/, "the old client-side window arithmetic is gone");
});

test("the button's own label reads the window the server applies", () => {
  state.settings = {};
  assert.equal(recentDays(), 7, "the fallback is the server's default");
  state.settings = { tierDays: 3 };
  assert.equal(recentDays(), 3, "a config that moves the window moves the label with it");
  state.settings = { tierDays: null };
  assert.equal(recentDays(), 7, "a snapshot without the key falls back to 7");
  state.settings = {};
});

test("the 7d toggle carries the hidden count inside it, and All stays All", () => {
  // The count used to be a chip at the far right of the folder header, a screen away from the control that folded
  // the projects away. It now sits in the toggle's own label: "7d (12 hidden)".
  const on = rootRecentButton("/work/trees", true, { hidden: 12, total: 40 });
  assert.match(on, /^<button type="button" class="btn-root-recent on" data-root-recent="\/work\/trees"/);
  assert.match(on, />7d \(12 hidden\)<\/button>$/, "the hidden count is inside the button that caused it");
  assert.match(on, /title="showing 28 of 40 projects/, "its tooltip still says what the view shows of what");

  const nothingHeld = rootRecentButton("/work/trees", true, { hidden: 0, total: 40 });
  assert.match(nothingHeld, />7d<\/button>$/, "nothing hidden reads as the plain window, with no parenthetical");

  const all = rootRecentButton("/work/trees", false, { hidden: 0, total: 40 });
  assert.match(all, /^<button type="button" class="btn-root-recent" data-root-recent=/);
  assert.match(all, />All<\/button>$/, "All is every project and holds nothing back");
  assert.match(all, /title="showing all 40 projects/);
});
