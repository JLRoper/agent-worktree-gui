// The Unattached agents card starts MINIMIZED (row 416).
//
// The two fixed cards keep their fold in `wm.collapsedFixed`, and that store only ever records COLLAPSED ids. An
// absent "agents" entry therefore used to mean EXPANDED, so a hard refresh opened the unattached panel for every
// reader who had never folded it - the reader's complaint. The default now comes from the page's own state: an
// untouched card takes FIXED_DEFAULT_COLLAPSED ("agents"), a card the reader has folded or unfolded keeps their
// choice in `wm.fixedChosen` (written on a click of that card's head only), and a stored collapse is honored.
//
// These tests drive the shipped code: the region around the default and its store is sliced out of public/app.js,
// and `toggleFixed` with it. Five facts:
//
//   1. an untouched store starts #agents collapsed and #newagent open;
//   2. the default is written into the fold state the painter reads, and persisted;
//   3. a stored collapse still applies - the default never reopens a folded card;
//   4. an explicit expand (the head click) survives a reload, and a second click collapses it again;
//   5. only the card's own head writes the choice: no global gesture does, and the shipped markup paints #agents
//      folded before any script runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { sliceBetween, sliceRegion } from "../tools/panel-testkit.mjs";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const region = sliceRegion(source, "the fixed cards' default fold", "the fixed cards' default fold");
const toggleSource = sliceBetween(source, "function toggleFixed(name) {", "// Opening a project is the reader's own promotion signal");

const FIXED_CARDS = ["newagent", "agents"];

// One page load: the stores are read into `state` exactly as app.js does at boot, and the painted-region code is
// loaded into a context whose only page services are the two stubs the region needs.
function load({ collapsed = [], chosen = [] } = {}) {
  const stored = {};
  if (collapsed) stored["wm.collapsedFixed"] = JSON.stringify(collapsed);
  if (chosen) stored["wm.fixedChosen"] = JSON.stringify(chosen);
  const localStorage = {
    getItem: (key) => (key in stored ? stored[key] : null),
    setItem: (key, value) => {
      stored[key] = String(value);
    },
  };
  const state = {
    collapsedFixed: new Set(JSON.parse(stored["wm.collapsedFixed"] || "[]")),
    fixedChosen: new Set(JSON.parse(stored["wm.fixedChosen"] || "[]")),
  };
  const context = vm.createContext({
    state,
    localStorage,
    FIXED_CARDS,
    // The real writers from app.js, kept in step with the state the region reads.
    saveCollapsedFixed: () => localStorage.setItem("wm.collapsedFixed", JSON.stringify([...state.collapsedFixed])),
    scheduleCollapseCascade: () => null,
    applyFixedCollapse: () => {},
  });
  vm.runInContext(region, context);
  vm.runInContext(toggleSource, context);
  const run = (code) => vm.runInContext(code, context);
  return { state, stored, run, html };
}

test("an untouched store starts the unattached card minimized and leaves the new-agent card open", () => {
  const { state, run } = load();
  assert.equal(run("fixedCardStartsCollapsed('agents', state.collapsedFixed, state.fixedChosen)"), true);
  assert.equal(run("fixedCardStartsCollapsed('newagent', state.collapsedFixed, state.fixedChosen)"), false);
  const changed = run("defaultFixedCollapse()");
  assert.equal(changed, true);
  assert.deepEqual([...state.collapsedFixed].sort(), ["agents"]);
  assert.deepEqual([...state.fixedChosen], []);
});

test("the default is written into the fold state the painter reads, and persisted", () => {
  const { stored, run, state } = load();
  run("defaultFixedCollapse()");
  assert.deepEqual(JSON.parse(stored["wm.collapsedFixed"]), ["agents"]);
  // The painter's own read of the state sees the card closed, and a second boot has nothing left to change.
  assert.equal(state.collapsedFixed.has("agents"), true);
  assert.equal(run("defaultFixedCollapse()"), false);
});

test("a stored collapse still applies - the default never reopens a folded card", () => {
  const { state, run } = load({ collapsed: ["agents", "newagent"] });
  run("defaultFixedCollapse()");
  assert.equal(state.collapsedFixed.has("agents"), true);
  assert.equal(state.collapsedFixed.has("newagent"), true);
});

test("an explicit expand survives a reload, and a second head click collapses it again", () => {
  // The reader clicks the minimized head: it opens, and the choice is written beside the fold.
  const first = load();
  first.run("defaultFixedCollapse()");
  first.run("toggleFixed('agents')");
  assert.equal(first.state.collapsedFixed.has("agents"), false);
  assert.deepEqual([...first.state.fixedChosen], ["agents"]);
  assert.deepEqual(JSON.parse(first.stored["wm.collapsedFixed"]), []);
  assert.deepEqual(JSON.parse(first.stored["wm.fixedChosen"]), ["agents"]);

  // A reload reads those two stores: the chosen expand is not overridden by the default.
  const again = load({
    collapsed: JSON.parse(first.stored["wm.collapsedFixed"]),
    chosen: JSON.parse(first.stored["wm.fixedChosen"]),
  });
  again.run("defaultFixedCollapse()");
  assert.equal(again.state.collapsedFixed.has("agents"), false);
  assert.equal(again.run("fixedCardStartsCollapsed('agents', state.collapsedFixed, state.fixedChosen)"), false);

  // The next click on the head folds it again, and that too survives a reload.
  again.run("toggleFixed('agents')");
  assert.equal(again.state.collapsedFixed.has("agents"), true);
  const third = load({
    collapsed: JSON.parse(again.stored["wm.collapsedFixed"]),
    chosen: JSON.parse(again.stored["wm.fixedChosen"]),
  });
  third.run("defaultFixedCollapse()");
  assert.equal(third.state.collapsedFixed.has("agents"), true);
});

test("only the card's own head writes the choice, and the shipped markup paints #agents folded", () => {
  // `state.fixedChosen.add` is the writer; if a global gesture gained one, Expand all would become a persisted
  // reader choice and a later hard refresh would open the card the reader never folded.
  const writers = source.match(/state\.fixedChosen\.add\(/g) || [];
  assert.equal(writers.length, 1, "exactly one writer: toggleFixed");
  assert.match(toggleSource, /state\.fixedChosen\.add\(name\)/);

  const agents = html.indexOf('<section class="project fixed-collapsed" id="agents">');
  const newagent = html.indexOf('id="newagent"');
  assert.ok(agents > 0, "#agents ships with the fixed-collapsed class");
  assert.ok(newagent > 0 && !/class="project fixed-collapsed" id="newagent"/.test(html), "#newagent keeps its shipped open default");
  assert.match(html, /data-toggle-fixed="agents" title="expand this card"/);
});
