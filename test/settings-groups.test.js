// The Settings panel: its groups START FOLDED, the reader's unfolds are what is remembered, and a search box
// narrows the panel to the rows that answer it.
//
// The mechanism is the page's, not a node module, so this drives the page's own regions the way
// chart-columns.test.js does — sliced out of public/app.js and run against stub groups and a stub localStorage.
// Five facts:
//
//   1. the top bar carries neither read-now button any more, and Settings carries each exactly once, in the Board
//      group's Read-now row (a leftover copy in the header is what that move was asked to remove);
//   2. every group's heading is the control — one per group, a stable key, the ARIA state a keyboard user reads —
//      and the markup ships every one of them FOLDED, class and aria-expanded together, so the page never paints
//      an open group before the script runs;
//   3. the stylesheet hides a folded group's rows by class alone, so a fold needs no markup swap mid-click (the
//      trap that closed Settings under the reader on the Clean-scratch press);
//   4. the fold is remembered as the UNFOLDS: an absent key reads as every group folded, a remembered unfold opens
//      exactly that group, a click writes it and a second click takes it back out — and loading neither writes a
//      key nor rewrites the one it read. The older folded-list key is inert: not read, not rewritten;
//   5. the search filters rows by their text and their titles, a group with no surviving row goes away, a group
//      with a match is shown open without touching the stored fold, the match is marked through the Custom
//      Highlight API rather than re-rendered, and clearing the box (Esc, the ✕, or simply emptying it) puts every
//      group back as the reader had it.
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
const settingsHead = settings.match(/<div class="settings-head">([\s\S]*?)<\/div>/);
assert.ok(settingsHead, "the settings panel must carry its fixed head");

const groupTags = [...settings.matchAll(/<div class="settings-group([^"]*)">/g)].map(([, cls]) => cls.trim());
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
  const boardSlice = settings.slice(boardStart, settings.indexOf('<div class="settings-group', boardStart + 10));
  assert.match(boardSlice, /id="board-now-row"/, "the Read-now row is the Board group's");
  const row = boardSlice.match(/<div class="settings-row" id="board-now-row"([\s\S]*?)<\/div>/);
  assert.ok(row, "the Read-now row must be a settings row");
  assert.match(row[1], /id="btn-refresh"/);
  assert.match(row[1], /id="btn-fetch"/);
  assert.match(row[1], /title="[^"]+"/, "each gesture explains itself in the row's tooltip");
});

test("every settings group ships folded, and its heading is the fold control", () => {
  assert.equal(heads.length, 7, `the panel has seven groups, found ${heads.length}`);
  assert.equal(groupTags.length, heads.length, "one group per heading");
  const keys = heads.map((h) => h.key);
  assert.ok(keys.every(Boolean), "each heading carries a stable data-settings-group key");
  assert.equal(new Set(keys).size, keys.length, "the keys are unique, so a fold cannot spill into another group");
  for (const [i, head] of heads.entries()) {
    assert.equal(head.role, "button", `${head.label} is a control`);
    assert.equal(head.tabindex, "0", `${head.label} is reachable by Tab`);
    // BOTH halves of the default: a group the script never touches (or the frame before it runs) is folded.
    assert.equal(head.aria, "false", `${head.label} ships folded`);
    assert.match(groupTags[i], /\bfolded\b/, `${head.label}'s group ships folded`);
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

test("the search box is in the panel's fixed head and says what it searches", () => {
  const box = settingsHead[1].match(/<input id="settings-search"([^>]*)>/);
  assert.ok(box, "the head carries the search box, so it is on screen whatever group is open");
  assert.match(box[1], /type="search"/, "the browser's own clear affordance comes with a search field");
  assert.match(box[1], /placeholder="[^"]*search[^"]*(label|row)[^"]*"/i, "the placeholder says what it searches");
  assert.match(box[1], /placeholder="[^"]*tooltip/i, "...and that it reads more than the visible label");
  assert.match(box[1], /aria-label="[^"]+"/, "the box is named for a screen reader");
  assert.doesNotMatch(box[1], /tabindex="-1"/, "Tab reaches it: it is a real input, first in the panel's own order");
  assert.equal(html.split('id="settings-search"').length - 1, 1, "one search box in the page");
  assert.match(settingsHead[1], /id="btn-settings-search-clear"/, "and one ✕ to clear it");
  // The match marking is a highlight, not a wrapper element: the stylesheet owns it and no markup is rebuilt.
  assert.match(css, /::highlight\(settings-search-match\)\s*\{[^}]*background/, "the match has a colour");
});

// ---- the page's own regions, driven -------------------------------------------------------------------
const beginFolds = src.indexOf("// ---- settings group folds");
const endFolds = src.indexOf("// ---- end settings group folds");
const beginSearch = src.indexOf("// ---- settings search");
const endSearch = src.indexOf("// ---- end settings search");
assert.ok(beginFolds > 0 && endFolds > beginFolds, "the settings-fold region is in public/app.js");
assert.ok(beginSearch > endFolds && endSearch > beginSearch, "the settings-search region follows it");
const foldsRegion = src.slice(beginFolds, endFolds);
const searchRegion = src.slice(beginSearch, endSearch);
const region = `${foldsRegion}\n${searchRegion}`;

const STORE_KEY = "wtgui.settingsUnfolded";
const LEGACY_KEY = "wtgui.settingsFolded";

const page = ({ groups, seed = null, legacy = null }) => {
  const store = new Map();
  if (seed !== null) store.set(STORE_KEY, JSON.stringify(seed));
  if (legacy !== null) store.set(LEGACY_KEY, JSON.stringify(legacy));
  const writes = [];
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      writes.push(k);
      store.set(k, String(v));
    },
    removeItem: (k) => void store.delete(k),
  };
  const box = {
    value: "",
    handlers: {},
    focused: false,
    focus() {
      this.focused = true;
    },
    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    },
  };
  const clear = {
    hidden: true,
    handlers: {},
    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    },
  };
  // The Custom Highlight API, stubbed down to what the region uses: a registry and ranges that record the text
  // node and offsets they were built from. A row's own text is the one text node the walker hands back.
  const CSS = {
    highlights: {
      name: null,
      ranges: null,
      set(name, highlight) {
        this.name = name;
        this.ranges = highlight.ranges;
      },
      delete(name) {
        if (this.name === name) {
          this.name = null;
          this.ranges = null;
        }
      },
    },
  };
  class Highlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  }
  class Range {
    setStart(node, at) {
      this.node = node;
      this.start = at;
    }
    setEnd(node, at) {
      this.node = node;
      this.end = at;
    }
  }
  const NodeFilter = { SHOW_TEXT: 4 };
  const document = {
    querySelectorAll: () => groups,
    getElementById: (id) =>
      id === "settings-search" ? box : id === "btn-settings-search-clear" ? clear : null,
    createTreeWalker: (root) => {
      let handed = false;
      return {
        nextNode: () => {
          if (handed) return null;
          handed = true;
          return { nodeValue: String(root.textContent || "") };
        },
      };
    },
  };
  const api = new Function(
    "localStorage",
    "document",
    "CSS",
    "Highlight",
    "Range",
    "NodeFilter",
    `${region}; return { initSettingsGroups, initSettingsSearch, paintSettingsSearch, settingsUnfolds, SETTINGS_FOLD_KEY, SETTINGS_SEARCH_HIGHLIGHT };`,
  )(localStorage, document, CSS, Highlight, Range, NodeFilter);
  return { ...api, store, writes, box, clear, CSS };
};

const classList = (classes) => ({
  toggle: (name, on) => void (on ? classes.add(name) : classes.delete(name)),
  contains: (name) => classes.has(name),
});

// A settings row: the text it shows and the title it explains itself with, plus (optionally) a titled control
// inside it — the case where a word is only in the tooltip of a button.
function row(text, title = "", innerTitles = []) {
  const classes = new Set(["settings-row"]);
  return {
    classes,
    textContent: text,
    getAttribute: (name) => (name === "title" ? title : null),
    querySelectorAll: (sel) =>
      sel === "[title]" ? innerTitles.map((t) => ({ getAttribute: () => t })) : [],
    classList: classList(classes),
  };
}

// A preview strip or a preset row: part of the row above it, never a setting of its own.
function attach(kind) {
  const classes = new Set([kind]);
  return { classes, textContent: "", classList: classList(classes) };
}

function group(key, children = []) {
  const classes = new Set(["settings-group"]);
  const head = {
    dataset: { settingsGroup: key },
    attrs: {},
    handlers: {},
    classList: { contains: (name) => name === "settings-group-head" },
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
    children: [head, ...children],
    classList: classList(classes),
    querySelector: (sel) => (/settings-group-head/.test(sel) ? head : null),
  };
}

test("an absent key means every group folded, and painting at load writes nothing", () => {
  const display = group("display", [row("Page zoom"), row("Panel font")]);
  const board = group("board", [row("Refresh now")]);
  const p = page({ groups: [display, board] });
  p.initSettingsGroups();

  assert.ok(display.classes.has("folded"), "a browser with no saved key opens every group folded");
  assert.equal(display.head.attrs["aria-expanded"], "false");
  assert.ok(board.classes.has("folded"));
  assert.equal(board.head.attrs["aria-expanded"], "false");
  assert.equal(p.store.has(p.SETTINGS_FOLD_KEY), false, "reading a default must not invent a key");
  assert.deepEqual(p.writes, [], "loading never rewrites what the browser had");
});

test("a remembered unfold opens exactly that group, and the stored state is not rewritten", () => {
  const display = group("display", [row("Page zoom")]);
  const cards = group("cards", [row("Show thinking")]);
  const p = page({ groups: [display, cards], seed: ["cards"] });
  p.initSettingsGroups();

  assert.ok(!cards.classes.has("folded"), "the group the reader opened comes back open");
  assert.equal(cards.head.attrs["aria-expanded"], "true");
  assert.ok(display.classes.has("folded"), "a group they never opened stays folded");
  assert.equal(display.head.attrs["aria-expanded"], "false");
  assert.equal(p.store.get(STORE_KEY), JSON.stringify(["cards"]), "the remembered array is read, not rewritten");
  assert.deepEqual(p.writes, [], "no write happens on the read path");
});

test("the older folded-list key is inert: not read, not rewritten", () => {
  const display = group("display", [row("Page zoom")]);
  const p = page({ groups: [display], legacy: [] });
  p.initSettingsGroups();

  // `[]` under the old key meant "everything was open"; under the new default it must not open anything.
  assert.ok(display.classes.has("folded"), "a legacy list cannot open a group");
  assert.equal(p.store.get(LEGACY_KEY), "[]", "the old key is left exactly as the reader left it");
  assert.equal(p.store.has(STORE_KEY), false, "and the new key is not seeded from it");
  assert.deepEqual(p.writes, []);
});

test("a click records the unfold, and a second click takes it back out", () => {
  const display = group("display", [row("Page zoom")]);
  const board = group("board", [row("Refresh now")]);
  const p = page({ groups: [display, board], seed: ["board"] });
  p.initSettingsGroups();

  // A click on a folded group opens it and remembers that.
  display.head.handlers.click[0]();
  assert.ok(!display.classes.has("folded"), "clicking the heading opens the group");
  assert.equal(display.head.attrs["aria-expanded"], "true");
  assert.deepEqual(JSON.parse(p.store.get(STORE_KEY)).sort(), ["board", "display"]);

  // A second click folds it again, and the record goes with it.
  display.head.handlers.click[0]();
  assert.ok(display.classes.has("folded"));
  assert.equal(display.head.attrs["aria-expanded"], "false");
  assert.deepEqual(JSON.parse(p.store.get(STORE_KEY)), ["board"]);

  // And the remembered-unfold group folds like any other, leaving nothing behind for it.
  board.head.handlers.click[0]();
  assert.ok(board.classes.has("folded"));
  assert.deepEqual(JSON.parse(p.store.get(STORE_KEY)), []);
});

test("Enter and Space fold from the keyboard without scrolling the panel", () => {
  const cards = group("cards", [row("Show thinking")]);
  const p = page({ groups: [cards] });
  p.initSettingsGroups();
  let prevented = 0;
  const key = (k) => cards.head.handlers.keydown[0]({ key: k, preventDefault: () => void (prevented += 1) });
  key(" ");
  assert.ok(!cards.classes.has("folded"), "Space opens the folded group");
  key(" ");
  assert.ok(cards.classes.has("folded"), "and Space again folds it");
  key("Enter");
  assert.ok(!cards.classes.has("folded"), "Enter opens it too");
  key("a");
  assert.ok(!cards.classes.has("folded"), "a letter types nowhere near the fold");
  assert.equal(prevented, 3, "only the keys that fold swallow the default (Space would scroll)");
});

test("typing filters the rows by text and title, hides an empty group and opens the matching one", () => {
  const zoom = row("Page zoom", "page zoom — Ctrl+wheel, Ctrl + / Ctrl − , Ctrl 0 resets");
  const font = row("Panel font", "The panel's own typeface");
  const refresh = row("Refresh now", "re-read every worktree row");
  const display = group("display", [zoom, font, attach("settings-preview")]);
  const board = group("board", [refresh]);
  const p = page({ groups: [display, board], seed: ["display"] });
  p.initSettingsGroups();
  p.initSettingsSearch();

  p.box.value = "zoom";
  p.box.handlers.input[0]();

  assert.ok(!zoom.classes.has("search-hidden"), "the row whose label matches stays");
  assert.ok(font.classes.has("search-hidden"), "the row that does not answer goes away");
  assert.ok(!display.classes.has("search-hidden"), "a group with a surviving row stays");
  assert.ok(board.classes.has("search-hidden"), "a group left with no row goes away");
  assert.ok(!display.classes.has("folded"), "the matching group is shown open for the search");
  assert.equal(display.head.attrs["aria-expanded"], "true");
  assert.equal(p.clear.hidden, false, "the ✕ is offered once there is something to clear");
  assert.equal(p.store.get(STORE_KEY), JSON.stringify(["display"]), "a search never rewrites the saved fold");

  // The match is marked, not rebuilt: one highlight, one range, and the row's own text node underneath it.
  assert.equal(p.CSS.highlights.name, p.SETTINGS_SEARCH_HIGHLIGHT, "the match goes through CSS.highlights");
  assert.equal(p.CSS.highlights.ranges.length, 1, "one hit in 'Page zoom'");
  assert.equal(p.CSS.highlights.ranges[0].start, 5, "the range covers the word inside the label");
  assert.equal(p.CSS.highlights.ranges[0].end, 9);

  // A word that is only in a control's tooltip — or only in the row's own tooltip — finds the row too.
  p.box.value = "ctrl+wheel";
  p.box.handlers.input[0]();
  assert.ok(!zoom.classes.has("search-hidden"), "the row's title is searched");
  assert.equal(p.CSS.highlights.ranges, null, "a title-only match has no text to mark, so nothing is highlighted");
  p.box.value = "";
  p.box.handlers.input[0]();
  assert.ok(!zoom.classes.has("search-hidden") && !font.classes.has("search-hidden"), "every row is back");
});

test("a group opened by the match goes back to the reader's fold when the search clears", () => {
  const zoom = row("Page zoom", "page zoom");
  const refresh = row("Refresh now", "re-read every worktree row");
  const display = group("display", [zoom]);
  const board = group("board", [refresh]);
  const p = page({ groups: [display, board], seed: ["display"] });
  p.initSettingsGroups();
  p.initSettingsSearch();

  p.box.value = "refresh";
  p.box.handlers.input[0]();
  assert.ok(!board.classes.has("folded"), "board had no remembered unfold, but the search shows it open");
  assert.ok(display.classes.has("search-hidden"), "display has no match");
  assert.equal(p.store.get(STORE_KEY), JSON.stringify(["display"]), "the search did not save board open");

  p.box.value = "";
  p.box.handlers.input[0]();
  assert.ok(board.classes.has("folded"), "clearing puts a group nobody opened back folded");
  assert.equal(board.head.attrs["aria-expanded"], "false");
  assert.ok(!display.classes.has("folded"), "and the remembered unfold is still open");
  assert.ok(!display.classes.has("search-hidden") && !board.classes.has("search-hidden"), "both groups are back");
  assert.equal(p.clear.hidden, true, "the ✕ hides again");
  assert.equal(p.CSS.highlights.name, null, "no stale highlight is left on the page");
});

test("Esc clears the box and leaves the panel's own Esc for an empty one", () => {
  const zoom = row("Page zoom", "page zoom");
  const font = row("Panel font", "the panel's own typeface");
  const display = group("display", [zoom, font]);
  const p = page({ groups: [display] });
  p.initSettingsGroups();
  p.initSettingsSearch();

  p.box.value = "font";
  p.box.handlers.input[0]();
  assert.ok(zoom.classes.has("search-hidden"));

  let prevented = 0;
  let stopped = 0;
  const esc = () => ({ key: "Escape", preventDefault: () => void (prevented += 1), stopPropagation: () => void (stopped += 1) });
  p.box.handlers.keydown[0](esc());
  assert.equal(p.box.value, "", "Esc empties the box");
  assert.equal(prevented, 1, "and swallows the key so nothing else acts on it");
  assert.equal(stopped, 1, "the page's Esc handler never sees it, so Settings stays open");
  assert.ok(!zoom.classes.has("search-hidden") && !font.classes.has("search-hidden"), "the rows are back");

  // On an empty box Esc means what it always meant: close the panel. The handler must not claim it.
  p.box.handlers.keydown[0](esc());
  assert.equal(prevented, 1, "an empty box hands Esc back to the page");
  assert.equal(stopped, 1);
});

test("the ✕ clears the search and gives the caret back to the box", () => {
  const zoom = row("Page zoom", "page zoom");
  const display = group("display", [zoom]);
  const p = page({ groups: [display] });
  p.initSettingsGroups();
  p.initSettingsSearch();

  p.box.value = "zoom";
  p.box.handlers.input[0]();
  p.clear.handlers.click[0]();
  assert.equal(p.box.value, "");
  assert.equal(p.box.focused, true, "the reader can keep typing");
  assert.ok(!zoom.classes.has("search-hidden"));
  assert.equal(p.clear.hidden, true);
});

test("the search marks matches instead of re-rendering the row it is filtering", () => {
  // No markup is written and no text is assigned: a keystroke that took the row apart would drop a select's
  // value, a half-typed number and the caret with it.
  assert.doesNotMatch(searchRegion, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML|textContent\s*=/);
  assert.doesNotMatch(searchRegion, /createElement|appendChild|removeChild/, "nothing is built or moved");
  assert.match(searchRegion, /CSS\.highlights/, "the marking is a Custom Highlight");
  assert.match(searchRegion, /createTreeWalker/, "and it walks the row's existing text nodes");
});
