// "Previous turn on send": the three answers, and the rule each one writes.
//
// Sending a reply used to have one behaviour — the turn you were reading folded itself into a compact snippet.
// It is now a setting (Settings > Agent cards) with three answers: freeze a snippet, leave the turn exactly as
// it was, or minimize it before the new turn's output is drawn. The plan is the page's own function, so this
// slices it out of public/app.js and drives it with a stub localStorage, the way settings-groups.test.js and
// chart-columns.test.js drive their regions. Five facts:
//
//   1. the default is the snippet the panel drew before the setting existed, so a board that never touches the
//      row keeps behaving exactly as it did;
//   2. "leave as is" pins an open turn open and writes NOTHING about a folded one — re-opening a turn the reader
//      folded by hand is not "leave it";
//   3. "minimize" clears both flags, so every earlier turn falls to its one-line peek;
//   4. an unknown or missing stored value falls back to the snippet, never to a mode the page cannot draw;
//   5. the row exists once, in the Agent cards group, as a select over exactly those three values, and the page
//      paints it at boot and writes it on change.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const begin = src.indexOf("// ---- previous turn on send");
const end = src.indexOf("// ---- end previous turn on send");
assert.ok(begin > 0 && end > begin, "the previous-turn region is in public/app.js");
const region = src.slice(begin, end);

function page({ stored = null, select = null } = {}) {
  const store = new Map();
  if (stored !== null) store.set("wtgui.prevTurn", stored);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  const state = { turnOpen: new Map(), turnCompact: new Set() };
  const $ = (id) => (id === "prev-turn-mode" ? select : null);
  const api = new Function(
    "localStorage",
    "state",
    "$",
    `${region}; return { PREV_TURN_MODES, previousTurnPlan, applyPreviousTurnPlan, prevTurnMode, applyPrevTurnMode };`,
  )(localStorage, state, $);
  return { ...api, store, state };
}

// The turns a conversation hands over: the one just finished, one the reader folded, one still running.
const turns = [
  { id: "turn-3", open: true },
  { id: "turn-2", open: false },
  { id: "turn-1", open: true },
];

test("the default answer is the snippet the panel drew before the setting existed", () => {
  const p = page();
  assert.equal(p.prevTurnMode(), "snippet", "nothing stored means the old behaviour");
  const plan = p.previousTurnPlan("snippet", turns);
  assert.deepEqual(plan, [
    { id: "turn-3", open: false, compact: true },
    { id: "turn-2", open: false, compact: undefined },
    { id: "turn-1", open: false, compact: true },
  ]);
  // A turn that was already folded keeps whatever it was — nothing is claimed about its compact flag.
  assert.equal(plan[1].compact, undefined);

  p.applyPreviousTurnPlan(plan);
  assert.deepEqual([...p.state.turnOpen.keys()], [], "no older turn is left explicitly open");
  assert.deepEqual([...p.state.turnCompact].sort(), ["turn-1", "turn-3"], "the turns that were showing keep a snippet");
});

test("leave as is keeps an open turn open and says nothing about a folded one", () => {
  const p = page({ stored: "keep" });
  assert.equal(p.prevTurnMode(), "keep");
  const plan = p.previousTurnPlan("keep", turns);
  assert.deepEqual(plan, [
    { id: "turn-3", open: true, compact: false },
    { id: "turn-2", open: undefined, compact: undefined },
    { id: "turn-1", open: true, compact: false },
  ]);

  // A stale compact mark on a turn that is now open must not resurface the next time it is folded.
  p.state.turnCompact.add("turn-3");
  p.applyPreviousTurnPlan(plan);
  assert.equal(p.state.turnOpen.get("turn-3"), true, "the turn the reader was reading stays open");
  assert.equal(p.state.turnOpen.get("turn-2"), undefined, "a turn the reader had folded is not reopened");
  assert.deepEqual([...p.state.turnCompact], [], "an open turn carries no compact mark");
});

test("minimize folds every earlier turn to its one-line peek", () => {
  const p = page({ stored: "minimize" });
  assert.equal(p.prevTurnMode(), "minimize");
  p.state.turnOpen.set("turn-2", true);
  p.state.turnCompact.add("turn-1");
  const plan = p.previousTurnPlan("minimize", turns);
  assert.deepEqual(plan, [
    { id: "turn-3", open: false, compact: false },
    { id: "turn-2", open: false, compact: false },
    { id: "turn-1", open: false, compact: false },
  ]);
  p.applyPreviousTurnPlan(plan);
  assert.deepEqual([...p.state.turnOpen.keys()], [], "nothing stays open");
  assert.deepEqual([...p.state.turnCompact], [], "nothing keeps a snippet either");
});

test("an unknown mode falls back to the snippet, and the plan never mutates its input", () => {
  const p = page({ stored: "shrink" });
  assert.equal(p.prevTurnMode(), "snippet", "a hand-edited store cannot invent a fourth mode");
  assert.deepEqual(p.previousTurnPlan("nonsense", turns), p.previousTurnPlan("snippet", turns));
  assert.deepEqual(turns, [
    { id: "turn-3", open: true },
    { id: "turn-2", open: false },
    { id: "turn-1", open: true },
  ]);
  assert.deepEqual(p.PREV_TURN_MODES, ["snippet", "keep", "minimize"]);
});

test("the row writes its answer, and the page paints it at boot", () => {
  const select = { value: "snippet" };
  const p = page({ select });
  p.applyPrevTurnMode("minimize");
  assert.equal(select.value, "minimize", "the select shows the stored answer");
  assert.equal(p.store.get("wtgui.prevTurn"), "minimize");
  p.applyPrevTurnMode("nope");
  assert.equal(select.value, "snippet", "an unknown answer is written back as the default");
  assert.equal(p.store.get("wtgui.prevTurn"), "snippet");

  assert.match(src, /if \(\$\("prev-turn-mode"\)\) \$\("prev-turn-mode"\)\.value = prevTurnMode\(\);/, "the row is painted from the store at boot");
  assert.match(src, /\$\("prev-turn-mode"\)\?\.addEventListener\("change", \(e\) => applyPrevTurnMode\(e\.target\.value\)\)/, "a change is written");
  assert.match(src, /previousTurnPlan\(\s*prevTurnMode\(\)/, "the send reads the setting, not a constant");
});

test("the row is one select in the Agent cards group, with exactly the three answers", () => {
  const settingsStart = html.indexOf('<div id="settings"');
  const settings = html.slice(settingsStart, html.indexOf("<main", settingsStart));
  assert.equal(settings.split('id="prev-turn-mode"').length - 1, 1, "the select appears once in Settings");
  assert.equal(html.split('id="prev-turn-mode"').length - 1, 1, "and once in the page");

  const cardsStart = settings.indexOf('data-settings-group="cards"');
  const cards = settings.slice(cardsStart, settings.indexOf('<div class="settings-group">', cardsStart));
  assert.ok(cards.includes('id="prev-turn-mode"'), "the row lives in the Agent cards group");

  const row = cards.match(/<label class="settings-row[^"]*" for="prev-turn-mode" title="([^"]+)">([\s\S]*?)<\/label>/);
  assert.ok(row, "the row is a labelled settings row");
  assert.match(row[1], /freeze a snippet/, "the tooltip names the first answer");
  assert.match(row[1], /leave as is/, "and the second");
  assert.match(row[1], /minimize it/, "and the third");
  assert.match(row[2], /<select id="prev-turn-mode">/, "the control is a select, because there are three answers");
  const values = [...row[2].matchAll(/<option value="([^"]+)"/g)].map(([, v]) => v);
  assert.deepEqual(values, ["snippet", "keep", "minimize"], "exactly the three modes, the default first");
});
