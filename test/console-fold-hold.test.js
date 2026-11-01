// A fold the reader opens hands the console over instead of sliding it to the bottom of what was opened.
//
// The seam-free half of tools/verify-console-fold-hold.mjs (there is no layout engine in `npm test`), so this reads
// the shipped markup and drives the shipped functions:
//
//   1. the Settings row exists once, in the Agent cards group, UNCHECKED (the console holds still, which is the
//      default) and its title explains both answers;
//   2. the switch is the page's own key: `wtgui.foldFollow` reads as off when absent, on only for "1", and a
//      private-mode storage that throws reads as off — the hold, never a broken console;
//   3. the hold itself, driven for real: it unpins the console and records where the reader is, does nothing at all
//      when the setting is on, and touches no scroll position (the growth is what the reader asked for, so there is
//      nothing for the panel to write);
//   4. every press that OPENS a folded output goes through it — a result box's head, a call's own row, a call row in
//      a run, the run's "all N" button, a tool row, the fold note that reads the store, and the batch's "+ N
//      commands" — and the presses that CLOSE one do not (a shrinking console is the browser's own clamp);
//   5. the row is primed from the stored answer and the change is saved.
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
const cardsGroup = () => {
  const start = html.indexOf('data-settings-group="cards"');
  const end = html.indexOf('<div class="settings-group', start + 10);
  assert.ok(start > 0 && end > start, "the Agent cards group is in the page");
  return html.slice(start, end);
};

// ---- 1. the Settings row -------------------------------------------------------------------------------------------
test("the switch is one row in Agent cards, unchecked, and says what both answers do", () => {
  assert.equal(html.split('id="follow-opened"').length - 1, 1, "#follow-opened exists exactly once in the page");
  const cards = cardsGroup();
  assert.match(cards, /id="follow-opened"/, "the switch lives in Agent cards, beside Count tool calls");
  const row = cards.match(/<label class="settings-row[^"]*" for="follow-opened" title="([^"]+)">([\s\S]*?)<\/label>/);
  assert.ok(row, "the switch is a labelled settings row");
  assert.match(row[2], /Jump to an opened result/, "the row names the behaviour it controls");
  assert.doesNotMatch(row[2], /type="checkbox"[^>]*checked/, "it ships OFF: the console holds still");
  assert.match(row[1], /holds still/i, "the title says what off does");
  assert.match(row[1], /follows it, sliding down to the end/i, "…and what on does");
});

// ---- 2. the page's own key -----------------------------------------------------------------------------------------
function readSwitch(seed, { throws = false } = {}) {
  const store = new Map();
  if (seed !== null) store.set("wtgui.foldFollow", seed);
  const context = vm.createContext({
    localStorage: {
      getItem: (k) => {
        if (throws) throw new Error("private mode");
        return store.has(k) ? store.get(k) : null;
      },
      setItem: (k, v) => store.set(k, String(v)),
    },
  });
  vm.runInContext(part("const FOLD_FOLLOW_KEY =", "// ---- how a run's output arrives"), context, { filename: "public/app.js" });
  return { context, store, on: vm.runInContext("foldFollowsConsole()", context) };
}

test("the switch reads wtgui.foldFollow, and an absent key is off", () => {
  assert.equal(readSwitch(null).on, false, "a browser that never set it holds the console still");
  assert.equal(readSwitch("0").on, false, "an explicit off is off");
  assert.equal(readSwitch("1").on, true, "only the stored 1 turns the follow back on");
});

test("a storage that throws reads as off instead of breaking a fold", () => {
  assert.equal(readSwitch(null, { throws: true }).on, false);
});

test("the setting is saved under its own key", () => {
  const { context, store } = readSwitch(null);
  vm.runInContext("setFoldFollow(true)", context);
  assert.equal(store.get("wtgui.foldFollow"), "1");
  vm.runInContext("setFoldFollow(false)", context);
  assert.equal(store.get("wtgui.foldFollow"), "0");
});

// ---- 3. the hold, driven -------------------------------------------------------------------------------------------
function drive(seed) {
  const store = new Map();
  if (seed !== null) store.set("wtgui.foldFollow", seed);
  const context = vm.createContext({
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    state: { outPinned: { t1: true }, outScrolls: {} },
  });
  const fn = part("function holdConsoleFor(", "\n// Every scroll the panel performs goes through here.");
  vm.runInContext(`${part("const FOLD_FOLLOW_KEY =", "// ---- how a run's output arrives")}\n${fn}`, context, { filename: "public/app.js" });
  const pre = { dataset: { out: "t1" }, scrollTop: 58, scrollHeight: 588, clientHeight: 230, _atBottom: true };
  const control = { closest: (sel) => (sel === "pre.job-out" ? pre : null) };
  const out = vm.runInContext("holdConsoleFor", context)(control);
  return { pre, out, held: vm.runInContext("state", context) };
}

test("the hold unpins the console and records where the reader is, writing no scroll", () => {
  const { pre, out, held } = drive(null);
  assert.equal(out, pre, "it answers with the console it took over");
  assert.equal(held.outPinned.t1, false, "the 400 ms stick has nothing to pull back to its end");
  assert.deepEqual(JSON.parse(JSON.stringify(held.outScrolls.t1)), { top: 58, atBottom: false }, "a repaint restores this, not the end");
  assert.equal(pre._atBottom, false, "and the page's cached at-bottom answer is cleared: a paced paint reads that, and no scroll event will fire to correct it");
  assert.equal(pre.scrollTop, 58, "the panel writes no scroll position at all: the growth is the reader's");
});

test("with the setting on nothing is taken over — the console follows the growth as it always did", () => {
  const { out, held } = drive("1");
  assert.equal(out, null, "no hold when the reader asked to follow");
  assert.equal(held.outPinned.t1, true, "still pinned");
  assert.deepEqual(held.outScrolls, {}, "and nothing recorded");
});

test("a press outside a console is not a fold", () => {
  const context = vm.createContext({ localStorage: { getItem: () => null }, state: { outPinned: {}, outScrolls: {} } });
  vm.runInContext(
    `${part("const FOLD_FOLLOW_KEY =", "// ---- how a run's output arrives")}\n${part("function holdConsoleFor(", "\n// Every scroll the panel performs goes through here.")}`,
    context,
    { filename: "public/app.js" },
  );
  assert.equal(vm.runInContext("holdConsoleFor", context)({ closest: () => null }), null);
  assert.equal(vm.runInContext("holdConsoleFor", context)(null), null);
});

// ---- 4. the presses that open, and the ones that close -------------------------------------------------------------
const handler = (marker, end) => part(marker, end);

test("opening a result box's head holds the console; folding it shut does not", () => {
  const at = source.indexOf('const codeFold = e.target.closest("[data-code-fold]");');
  assert.ok(at > 0, "the result box's head still has its handler");
  const click = source.slice(at, source.indexOf('const batchBtn = e.target.closest("[data-batch-tool]")', at));
  assert.match(click, /if \(open\) holdConsoleFor\(codeFold\);/, "the hold is on the opening press only");
  assert.ok(click.indexOf("holdConsoleFor") < click.indexOf("body.hidden = !open;"), "it is taken over BEFORE the body is shown");
});

test("a call's own row, and a call row inside a run, hold the console when they open", () => {
  const at = source.indexOf('const callRow = e.target.closest("[data-call-fold], .call-head");');
  assert.ok(at > 0, "the call row still has its handler");
  const click = source.slice(at, source.indexOf('// A result box inside a burst', at));
  assert.match(click, /if \(!folded\) holdConsoleFor\(callRow\);/, "opening folds the body out, so it holds");

  const usage = source.indexOf('const usageRow = e.target.closest("[data-tgrp-call]");');
  assert.ok(usage > 0, "the call row of a run still has its handler");
  const body = source.slice(usage, source.indexOf('// A tool call\'s own row', usage));
  assert.match(body, /if \(open\) holdConsoleFor\(usageRow\);/, "opening the row's box holds the console");
  assert.ok(body.indexOf("holdConsoleFor") < body.indexOf("boxEl.hidden = !open;"), "before the box is shown");
});

test("the run's own openers hold the console: \"all N\", a tool row, and the batch tail", () => {
  assert.match(source, /if \(open\) holdConsoleFor\(tgrpMore\);/, "the run's all-N / N-lines button");
  assert.equal((source.match(/if \(!active\) holdConsoleFor\(tgrpRow\);/g) || []).length, 2, "both tool-row handlers");
  const batch = part("async function loadBatchCalls(", "function rebuildToolGroup(");
  assert.match(batch, /holdConsoleFor\(btn\);/, "the + N commands tail");
});

test("the fold note that reads the store holds the console while the answer arrives", () => {
  const fn = part("async function expandToolFold(", "// A block the reader has open keeps its stored output current");
  assert.match(fn, /holdConsoleFor\(btn\);/, "one press, one result, and the console stays put");
});

// ---- 5. the row is primed and saved --------------------------------------------------------------------------------
test("the row is primed from the stored answer, and a press saves it", () => {
  assert.match(source, /if \(\$\("follow-opened"\)\) \$\("follow-opened"\)\.checked = foldFollowsConsole\(\);/, "primed at start-up");
  assert.match(source, /\$\("follow-opened"\)\?\.addEventListener\("change", \(e\) => setFoldFollow\(Boolean\(e\.target\.checked\)\)\);/, "saved on change");
  assert.equal(handler('if ($("group-tools")) $("group-tools").checked', 'if ($("auto-collect")) $("auto-collect").checked'), `if ($("group-tools")) $("group-tools").checked = toolGroupsOn();\nif ($("follow-opened")) $("follow-opened").checked = foldFollowsConsole();\n`, "beside the shape switch it belongs with");
});
