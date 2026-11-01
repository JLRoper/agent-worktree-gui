// A run of tool calls: the TALLIED group, or one expandable line per call — the reader's own answer, kept in
// Settings > Agent cards and read by every console.
//
// The seam-free half of tools/verify-tool-call-rows.mjs (there is no layout engine in `npm test`), so this drives the
// shipped renderer and reads the shipped markup:
//
//   1. the Settings row exists once, in the Agent cards group, unchecked (the one-line shape is what ships) and it
//      explains both answers in its title;
//   2. the switch is the page's own key: `wtgui.toolGroups` reads as off when absent, on only for "1", and a
//      private-mode storage that throws reads as off rather than breaking a render;
//   3. a ONE-call burst drawn with the tally off is ONE row — no head row, no tally, no "all N" button, no "↳ tool"
//      result line — which is the four-line shape the reader was shown:
//        head row (terminal ×1 …) + "all N" + the call row + its "↳ terminal" line + the output box;
//   4. the same burst drawn with the tally on is the group it always was: a head row per tool with its count and a
//      body holding the call block;
//   5. the card's signature carries the switch, or a press in Settings repaints into the shape the card already has.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const part = (a, b) => {
  const start = source.indexOf(a);
  const end = source.indexOf(b, start);
  assert.ok(start >= 0 && end > start, `app.js still carries ${a}`);
  return source.slice(start, end);
};
const count = (html_, re) => (html_.match(re) || []).length;

// ---- 1. the Settings row -------------------------------------------------------------------------------------------
test("the switch is one row in the Agent cards group, unchecked, and says what both answers do", () => {
  assert.equal(html.split('id="group-tools"').length - 1, 1, "#group-tools exists exactly once in the page");
  const cardsStart = html.indexOf('data-settings-group="cards"');
  const cardsEnd = html.indexOf('<div class="settings-group', cardsStart + 10);
  assert.ok(cardsStart > 0 && cardsEnd > cardsStart, "the Agent cards group is in the page");
  const cards = html.slice(cardsStart, cardsEnd);
  assert.match(cards, /id="group-tools"/, "the switch lives in Agent cards, beside Show thinking");
  const row = cards.match(/<label class="settings-row[^"]*" for="group-tools" title="([^"]+)">([\s\S]*?)<\/label>/);
  assert.ok(row, "the switch is a labelled settings row");
  assert.match(row[2], /Count tool calls/, "the row names the behaviour it controls");
  assert.doesNotMatch(row[2], /type="checkbox"[^>]*checked/, "it ships OFF: one expandable line per call");
  assert.match(row[1], /ONE line of its own/i, "the title says what off draws");
  assert.match(row[1], /head row per tool/i, "…and what on draws");
});

// ---- 2. the page's own key -----------------------------------------------------------------------------------------
function switchOn(seed) {
  const store = new Map();
  if (seed !== null) store.set("wtgui.toolGroups", seed);
  const context = vm.createContext({
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  });
  vm.runInContext(part("const TOOL_GROUPS_KEY =", "// ---- how a run's output arrives"), context, { filename: "public/app.js" });
  return { context, store, on: vm.runInContext("toolGroupsOn()", context) };
}

test("the switch reads wtgui.toolGroups, and an absent key is off", () => {
  assert.equal(switchOn(null).on, false, "a browser that never pressed it draws one row per call");
  assert.equal(switchOn("0").on, false, "an explicit off is off");
  assert.equal(switchOn("1").on, true, "only the stored 1 turns the tally on");
});

test("a storage that throws reads as off instead of breaking a render", () => {
  const context = vm.createContext({
    localStorage: {
      getItem: () => {
        throw new Error("private mode");
      },
    },
  });
  vm.runInContext(part("const TOOL_GROUPS_KEY =", "// ---- how a run's output arrives"), context, { filename: "public/app.js" });
  assert.equal(vm.runInContext("toolGroupsOn()", context), false);
});

// ---- 3 + 4. the two shapes, from the shipped renderer --------------------------------------------------------------
// One terminal call and its result, in the shape the gateway records them: the call line (glyph, tool, the command
// it was given, the batch's own "+ N commands" tail) and the result header under it.
const ONE_CALL = [
  { kind: "tool", text: '💻 terminal · L="C:/tmp/after1" + 2 commands', lid: 1, at: 1_000_000 },
  { kind: "tool-out", text: "  ↳ terminal · 0.31s", lid: 2, at: 1_000_310 },
  { kind: "tool-out", text: "  M public/app.js", lid: 3, at: 1_000_311 },
];

function render({ lines = ONE_CALL, opts = "{}" } = {}) {
  const state = {
    projects: new Map(),
    jobs: new Map([["turn", { id: "turn", thread: "fixture-thread", status: "done", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z" }]]),
    toolStore: new Map(), toolGroupOpen: new Map(), codeBoxOpen: new Set(), codeBoxShut: new Set(),
    callFolded: new Set(), callOpen: new Set(), foldRows: new Map(), foldPending: new Map(), batchCalls: new Map(),
  };
  const context = vm.createContext({
    window: {}, console, state, URLSearchParams,
    document: { getElementById: () => null },
    normPath: (p) => String(p ?? "").split("\\").join("/"),
    turnLive: () => false,
    repaintToolGroup: () => {},
    apiFetch: async () => ({ ok: true, json: async () => ({ results: [] }) }),
    input: lines,
  });
  for (const file of ["public/core/dom-format.js", "public/core/console-format.js"]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  for (const code of [
    part("const TOOL_START_RE =", "// Index of the started tool call"),
    part("function toolBurstRows(", "function groupLines("),
    part("function groupLines(", "function storeOffsetsBefore("),
    part("const READ_CODE_OPEN =", "// A block the reader has open keeps"),
    part("// ---- tool group key", "// ---- end tool group key"),
    part("const BATCH_TAIL_RE =", "function toBottomBtnHtml("),
  ]) vm.runInContext(code, context);
  return vm.runInContext(`toolGroupHtml(input, "turn#0", "", false, "anchor", null, ${opts})`, context);
}

const rows = (html_) => [...html_.matchAll(/<div class="jl jl-tool tgrp-row"[^>]*data-tgrp-call="([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)];
const text = (s) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

test("with the tally off, one call is ONE line: no head, no tally, no 'all N', no result line", () => {
  const drawn = render({ opts: '{flat: true}' });
  assert.match(drawn, /class="tgrp tgrp-flat"/, "the one-row shape is the flat group, not a new renderer");
  assert.equal(rows(drawn).length, 1, "one call, one row");
  assert.match(rows(drawn)[0][2], /terminal/, "the row names the tool");
  assert.match(text(rows(drawn)[0][2]), /L=(&quot;|")C:\/tmp\/after1/, "…and the command it was given");
  assert.doesNotMatch(drawn, /tgrp-head/, "no head row repeats the call it is tallying");
  assert.doesNotMatch(drawn, /data-tgrp-tool=/, "no per-tool tally row");
  assert.doesNotMatch(drawn, /data-tgrp-more=/, "no 'all N' button");
  assert.doesNotMatch(drawn, /class="call"/, "no second call row in a body");
  // The result line the reader counted as line four: it must not be in the flow — its text travels on the row.
  assert.doesNotMatch(text(drawn.replace(/<div class="tgrp-out"[\s\S]*$/, "")), /↳/, "no '↳ terminal' line in the flow");
  assert.match(drawn, /data-lresult="\s*↳ terminal · 0\.31s"/, "the result header travels on the row instead");
  assert.match(drawn, /<div class="tgrp-out" hidden>/, "and its box starts shut, one press under the row");
});

test("with the tally on, the same call is the counted group the panel always drew", () => {
  const drawn = render({ opts: "{}" });
  assert.match(drawn, /<div class="tgrp-head"/, "the group opens with its head");
  assert.match(drawn, /data-tgrp-tool="terminal"/, "a row per tool…");
  assert.match(drawn, /×1/, "…carrying the count");
  assert.match(drawn, /data-tgrp-more=/, "and the button that opens the run");
  assert.doesNotMatch(drawn, /tgrp-flat/, "the counted group is not a flat piece");
  assert.match(drawn, /class="call"/, "its body holds the call block");
});

// ---- 5. the signature, so a press is not ignored -------------------------------------------------------------------
test("every console's render path asks the switch, and the card's signature carries it", () => {
  // The condensed card's burst, the subagent strip, and a live append that starts a group.
  assert.match(source, /return toolGroupHtml\(item\.lines, `\$\{turn\.id\}#\$\{gi\}`, "", false, "", gofs, toolGroupsOn\(\) \? \{\} : \{ flat: true \}\);/);
  assert.match(source, /item\.group \? toolGroupHtml\(item\.lines, `\$\{id\}#\$\{gi\}`, "", false, "", null, toolGroupsOn\(\) \? \{\} : \{ flat: true \}\)/);
  assert.match(source, /const flat = openGroup \? openGroup\.dataset\.gflat === "1" : streaming \|\| !toolGroupsOn\(\);/);
  // The signature term beside the 🌊 one: without it, `setToolGroups` repaints every card and every repaint
  // concludes nothing changed, so the console keeps the shape it was drawn under.
  const sig = part("function conversationSignature(", "// Is the reader's selection standing in this element?");
  assert.match(sig, /toolGroupsOn\(\) \? "g" : "-"/, "the shape is part of what the card is redrawn for");
});
