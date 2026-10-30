// The Settings panel: its groups fold, and the board's two read-now gestures live in it.
//
// The mechanism is the page's, not a node module, so this drives the page's own region the way chart-columns.test.js
// does — sliced out of public/app.js and run against stub groups and a stub localStorage. Four facts:
//
//   1. the top bar carries neither button any more, and Settings carries each exactly once, in the Board group's
//      Read-now row (a leftover copy in the header is what this move was asked to remove);
//   2. every group's heading is the control — one per group, a stable key, and the ARIA state a keyboard user reads;
//   3. the stylesheet hides a folded group's rows by class alone, so a fold needs no markup swap mid-click (the
//      trap that closed Settings under the reader on the Clean-scratch press);
//   4. the fold survives a reload: the class is repainted from localStorage at load, a click writes it, and a second
//      click takes it back out.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const topbar = html.match(/<header class="topbar">([\s\S]*?)<\/header>/);
assert.ok(topbar, "index.html must carry the top bar");

// The settings panel is static markup: from its own div to the board that follows it.
const settingsStart = html.indexOf('<div id="settings"');
const settings = html.slice(settingsStart, html.indexOf("<main", settingsStart));
assert.ok(settingsStart > 0 && settings.length > 1000, "index.html must carry the settings panel");

const heads = [...settings.matchAll(/<h3 class="settings-group-head"([^>]*)>([^<]*)<\/h3>/g)].map(([, attrs, label]) => ({
  label: label.trim(),
  key: (attrs.match(/data-settings-group="([^"]+)"/) || [])[1],
  role: (attrs.match(/role="([^"]+)"/) || [])[1],
  tabindex: (attrs.match(/tabindex="([^"]+)"/) || [])[1],
  aria: (attrs.match(/aria-expanded="([^"]+)"/) || [])[1],
}));

test("the two read-now buttons are in Settings, not in the top bar", () => {
  assert.doesNotMatch(topbar[1], /id="btn-refresh"|id="btn-fetch"/, "the header no longer carries them");
  for (const id of ["btn-refresh", "btn-fetch"]) {
    assert.equal(settings.split(`id="${id}"`).length - 1, 1, `#${id} appears once, in Settings`);
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} exists exactly once in the page`);
  }
  // ...and specifically in the Board group's Read-now row, so the pair sits with the rows that read the board.
  const boardStart = settings.indexOf('data-settings-group="board"');
  const boardSlice = settings.slice(boardStart, settings.indexOf('<div class="settings-group">', boardStart));
  assert.match(boardSlice, /id="board-now-row"/, "the Read-now row is the Board group's");
  const row = boardSlice.match(/<div class="settings-row" id="board-now-row"([\s\S]*?)<\/div>/);
  assert.ok(row, "the Read-now row must be a settings row");
  assert.match(row[1], /id="btn-refresh"/);
  assert.match(row[1], /id="btn-fetch"/);
  assert.match(row[1], /title="[^"]+"/, "each gesture explains itself in the row's tooltip");
});

test("every settings group's heading is the fold control", () => {
  assert.equal(heads.length, 7, `the panel has seven groups, found ${heads.length}`);
  assert.equal(settings.split('<div class="settings-group">').length - 1, heads.length, "one heading per group");
  const keys = heads.map((h) => h.key);
  assert.ok(keys.every(Boolean), "each heading carries a stable data-settings-group key");
  assert.equal(new Set(keys).size, keys.length, "the keys are unique, so a fold cannot spill into another group");
  for (const head of heads) {
    assert.equal(head.role, "button", `${head.label} is a control`);
    assert.equal(head.tabindex, "0", `${head.label} is reachable by Tab`);
    assert.equal(head.aria, "true", `${head.label} ships open`);
  }
});

test("a folded group is hidden by its class, not by a second copy of the rows", () => {
  const rule = css.match(/\.settings-group\.folded\s*>\s*:not\(\.settings-group-head\)\s*\{([^}]*)\}/);
  assert.ok(rule, "the fold needs one rule that hides the group's rows");
  assert.match(rule[1], /display:\s*none/);
  const head = css.match(/\n\.settings-group-head\s*\{([^}]*)\}/);
  assert.ok(head, "no .settings-group-head rule");
  assert.match(head[1], /cursor:\s*pointer/, "the heading has to read as the control it now is");
  assert.match(css, /\.settings-group-head::before\s*\{\s*content:\s*"▾"/, "an open group points down");
  assert.match(css, /\.settings-group\.folded \.settings-group-head::before\s*\{\s*content:\s*"▸"/, "a folded one points right");
});

// ---- the page's own fold region, driven ---------------------------------------------------------------
const begin = src.indexOf("// ---- settings group folds");
const end = src.indexOf("// ---- end settings group folds");
assert.ok(begin > 0 && end > begin, "the settings-fold region is in public/app.js");
const region = src.slice(begin, end);
const page = (groups, seed = null) => {
  const store = new Map(seed === null ? [] : [["wtgui.settingsFolded", JSON.stringify(seed)]]);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  };
  const document = { querySelectorAll: () => groups };
  const api = new Function("localStorage", "document", `${region}; return { initSettingsGroups, SETTINGS_FOLD_KEY };`)(localStorage, document);
  return { ...api, store };
};

function group(key) {
  const classes = new Set();
  const head = {
    dataset: { settingsGroup: key },
    attrs: {},
    handlers: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    },
  };
  return {
    key,
    head,
    classes,
    classList: {
      toggle: (name, on) => void (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    querySelector: (sel) => (/settings-group-head/.test(sel) ? head : null),
  };
}

test("the remembered folds are painted at load, and a click writes and clears them", () => {
  const display = group("display");
  const board = group("board");
  const p = page([display, board], ["display"]);
  p.initSettingsGroups();

  // Boot: the remembered fold is on, and the reader's assistive tech is told so.
  assert.deepEqual([...display.classes], ["folded"], "display comes back folded");
  assert.equal(display.head.attrs["aria-expanded"], "false");
  assert.deepEqual([...board.classes], [], "board was not folded");
  assert.equal(board.head.attrs["aria-expanded"], "true");

  // A click folds an open group and records it.
  board.head.handlers.click[0]();
  assert.ok(board.classes.has("folded"), "clicking the heading folds the group");
  assert.equal(board.head.attrs["aria-expanded"], "false");
  assert.deepEqual(JSON.parse(p.store.get("wtgui.settingsFolded")).sort(), ["board", "display"]);

  // A second click unfolds it again, and the record goes with it.
  board.head.handlers.click[0]();
  assert.ok(!board.classes.has("folded"));
  assert.equal(board.head.attrs["aria-expanded"], "true");
  assert.deepEqual(JSON.parse(p.store.get("wtgui.settingsFolded")), ["display"]);

  // display, folded from boot, unfolds on its own click.
  display.head.handlers.click[0]();
  assert.ok(!display.classes.has("folded"));
  assert.deepEqual(JSON.parse(p.store.get("wtgui.settingsFolded")), []);
});

test("Enter and Space fold from the keyboard without scrolling the panel", () => {
  const cards = group("cards");
  const p = page([cards], []);
  p.initSettingsGroups();
  let prevented = 0;
  const key = (k) => cards.head.handlers.keydown[0]({ key: k, preventDefault: () => void (prevented += 1) });
  key(" ");
  assert.ok(cards.classes.has("folded"), "Space folds the group");
  key(" ");
  assert.ok(!cards.classes.has("folded"), "and Space again opens it");
  key("Enter");
  assert.ok(cards.classes.has("folded"), "Enter folds it too");
  key("a");
  assert.ok(cards.classes.has("folded"), "a letter types nowhere near the fold");
  assert.equal(prevented, 3, "only the keys that fold swallow the default (Space would scroll)");
});
