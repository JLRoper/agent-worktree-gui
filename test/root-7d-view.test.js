// The folder's All / 7d button is a VIEW of the server's tier, never a second decision (lib/tiers.js): a repo
// whose last commit is past the window is on the hourly stat gate, and the page must filter on that same answer.
// Before this, the page held its own cutoff and its own wider "touched" rule (a commit, a file edit, or any
// liveness evidence), so the view could disagree with the treatment it described. These pins read the function
// out of public/app.js and run it with no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function cut(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `public/app.js carries ${name}()`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is a top-level function`);
  return src.slice(start, end + 2);
}

const state = { recentRoots: new Set(["/work/trees"]), settings: {} };
const shownInRoot = new Function("state", `${cut("shownInRoot")}\nreturn shownInRoot;`)(state);
const recentDays = new Function("state", "RECENT_DAYS", `${cut("recentDays")}\nreturn recentDays;`)(state, 7);

const project = (name, tier) => ({ name, path: `/work/trees/${name}`, tier, activityAt: new Date().toISOString() });

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
  assert.doesNotMatch(cut("shownInRoot"), /activityAt|lastAliveAt|Date\.now|cutoff/, "no second cutoff in the client");
  assert.doesNotMatch(src, /RECENT_DAYS \* 864e5/, "the old client-side window arithmetic is gone");
});

test("the button's own label reads the window the server applies", () => {
  assert.equal(recentDays(), 7, "the fallback is the server's default");
  state.settings = { tierDays: 3 };
  assert.equal(recentDays(), 3, "a config that moves the window moves the label with it");
  state.settings = { tierDays: null };
  assert.equal(recentDays(), 7, "a snapshot without the key falls back to 7");
});
