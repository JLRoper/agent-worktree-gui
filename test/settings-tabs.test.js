// The Settings panel is a TAB STRIP: one tab per group, one panel on screen, the reader's tab remembered — and a
// search that stays GLOBAL across every tab.
//
// The mechanism is the page's, not a node module, so this drives the page's own regions the way
// chart-columns.test.js does — sliced out of public/app.js and run against a stub strip, stub panels and a stub
// localStorage. Six facts:
//
//   1. the top bar carries neither read-now button any more, and Settings carries each exactly once, in the Board
//      panel's Read-now row (a leftover copy in the header is what that move was asked to remove);
//   2. the markup carries one tab per `data-settings-group` key, in the same order as the panels (Display first),
//      with aria-controls/aria-labelledby tying each tab to its own panel;
//   3. exactly one tab is selected and one panel is not `hidden`: the six other panels ship hidden, so the page
//      never paints all seven before the script runs;
//   4. the tab the reader chose is remembered (`wtgui.settingsTab`), an absent or stale key lands on the first tab
//      without writing one, and the old fold keys are inert: neither read nor rewritten;
//   5. the strip is one Tab stop (roving tabindex), a press selects and remembers, and ArrowLeft/ArrowRight/Home/End
//      move + select while Enter/Space select and Space is swallowed;
//   6. the search is global: every tab counts the rows that answer it, a match on a tab the reader is not on is
//      revealed by switching to the first tab that answers, the reader's own tab is never written by the search, and
//      clearing the box goes back to it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

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

const tabs = [...settings.matchAll(/<button type="button" class="settings-tab"([^>]*)>/g)].map(([, attrs]) => ({
  key: (attrs.match(/data-settings-tab="([^"]+)"/) || [])[1],
  id: (attrs.match(/id="([^"]+)"/) || [])[1],
  role: (attrs.match(/role="([^"]+)"/) || [])[1],
  controls: (attrs.match(/aria-controls="([^"]+)"/) || [])[1],
  selected: (attrs.match(/aria-selected="([^"]+)"/) || [])[1],
  tabindex: (attrs.match(/tabindex="([^"]+)"/) || [])[1],
  label: (attrs.match(/title="([^"]+)"/) || [])[1],
}));
const panels = [...settings.matchAll(/<div class="settings-group"([^>]*)>/g)].map(([, attrs]) => ({
  key: (attrs.match(/data-settings-group="([^"]+)"/) || [])[1],
  id: (attrs.match(/id="([^"]+)"/) || [])[1],
  role: (attrs.match(/role="([^"]+)"/) || [])[1],
  labelledby: (attrs.match(/aria-labelledby="([^"]+)"/) || [])[1],
  hidden: /(^|\s)hidden(\s|$)/.test(attrs),
}));

test("the two read-now buttons are in Settings, not in the top bar", () => {
  assert.doesNotMatch(topbar[1], /id="btn-refresh"|id="btn-fetch"/, "the header no longer carries them");
  for (const id of ["btn-refresh", "btn-fetch"]) {
    assert.equal(settings.split(`id="${id}"`).length - 1, 1, `#${id} appears once, in Settings`);
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} exists exactly once in the page`);
  }
  // ...and specifically in the Board panel's Read-now row, so the pair sits with the rows that read the board.
  const boardStart = settings.indexOf('data-settings-group="board"');
  const boardSlice = settings.slice(boardStart, settings.indexOf('<div class="settings-group', boardStart + 10));
  assert.match(boardSlice, /id="board-now-row"/, "the Read-now row is the Board tab's");
  const row = boardSlice.match(/<div class="settings-row" id="board-now-row"([\s\S]*?)<\/div>/);
  assert.ok(row, "the Read-now row must be a settings row");
  assert.match(row[1], /id="btn-refresh"/);
  assert.match(row[1], /id="btn-fetch"/);
  assert.match(row[1], /title="[^"]+"/, "each gesture explains itself in the row's tooltip");
});

test("one tab per data-settings-group key, in the markup's own order", () => {
  assert.equal(tabs.length, 7, `the strip has seven tabs, found ${tabs.length}`);
  assert.equal(panels.length, 7, `the panel has seven panels, found ${panels.length}`);
  assert.equal(settings.split('role="tablist"').length - 1, 1, "one tab strip");
  assert.ok(tabs.every((t) => t.key), "each tab carries a stable data-settings-tab key");
  assert.ok(panels.every((p) => p.key), "each panel carries its data-settings-group key");
  assert.deepEqual(tabs.map((t) => t.key), panels.map((p) => p.key), "the strip's order IS the panels' order");
  assert.equal(new Set(tabs.map((t) => t.key)).size, tabs.length, "the keys are unique");
  for (const [i, tab] of tabs.entries()) {
    assert.equal(tab.role, "tab", `${tab.key} is a tab`);
    assert.equal(tab.controls, panels[i].id, `${tab.key}'s tab controls its own panel (${panels[i].id})`);
    assert.equal(panels[i].role, "tabpanel", `${tab.key}'s panel is a tabpanel`);
    assert.equal(panels[i].labelledby, tab.id, "and is named by that tab");
  }
});

test("exactly one tab is selected, and only its panel is not hidden", () => {
  assert.deepEqual(tabs.map((t) => t.selected), ["true", "false", "false", "false", "false", "false", "false"],
    "Display is the first visit's tab, and it is the only selected one");
  assert.equal(tabs.filter((t) => t.tabindex === "0").length, 1, "the strip is one Tab stop: one tab is reachable");
  assert.equal(tabs[0].tabindex, "0");
  assert.ok(tabs.slice(1).every((t) => t.tabindex === "-1"), "the rest are roving stops");
  assert.deepEqual(panels.map((p) => p.hidden), [false, true, true, true, true, true, true],
    "the six other panels ship hidden, so the page never paints all seven");
});

test("the strip is styled by a class of its own, and the fold machinery is gone", () => {
  const strip = css.match(/\n\.settings-tabs\s*\{([^}]*)\}/);
  assert.ok(strip, "no .settings-tabs rule");
  assert.match(strip[1], /display:\s*flex/, "the tabs are one flex row");
  assert.match(strip[1], /flex-wrap:\s*wrap/, "and wrap rather than scroll, so every tab is reachable");
  const selected = css.match(/\.settings-tab\[aria-selected="true"\]\s*\{([^}]*)\}/);
  assert.ok(selected, "the selected tab needs its own look");
  assert.match(selected[1], /border-bottom-color/, "a tab reads as the current one by its underline");
  assert.match(css, /\n\.settings-group\[hidden\]\s*\{[^}]*display:\s*none/, "a hidden panel is not drawn");
  assert.doesNotMatch(css, /\.settings-group\s*\+\s*\.settings-group/, "no divider between groups any more");
  assert.doesNotMatch(css, /\.settings-group\.folded/, "no folded state");
  assert.doesNotMatch(css, /\.settings-group-head/, "no heading control");
});

test("the fold store is retired: nothing reads it, nothing writes it", () => {
  assert.doesNotMatch(src, /settingsUnfolds|paintSettingsFold|saveSettingsUnfolds|initSettingsGroups|SETTINGS_FOLD_KEY/,
    "the fold machinery is out of the script");
  assert.doesNotMatch(src, /\.settings-group-head/, "and no script still looks for a group heading");
  for (const key of ["wtgui.settingsUnfolded", "wtgui.settingsFolded"]) {
    assert.doesNotMatch(src, new RegExp(`localStorage\\.(getItem|setItem)\\(\\s*["']${key.replace(/\./g, "\\.")}["']`),
      `${key} is neither read nor rewritten`);
  }
  assert.match(src, /SETTINGS_TAB_KEY = "wtgui\.settingsTab"/, "the chosen tab has its own key");
});

test("the search box is in the panel's fixed head and says what it searches", () => {
  const box = settingsHead[1].match(/<input id="settings-search"([^>]*)>/);
  assert.ok(box, "the head carries the search box, so it is on screen whichever tab is open");
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
const tabsRegion = sliceRegion(src, "settings tabs");
const searchRegion = sliceRegion(src, "settings search");
const region = `${tabsRegion}\n${searchRegion}`;

const STORE_KEY = "wtgui.settingsTab";

const page = ({ groups, tabSeed = null, legacy = null }) => {
  const store = new Map();
  if (tabSeed !== null) store.set(STORE_KEY, String(tabSeed));
  if (legacy !== null) store.set(legacy.key, legacy.value);
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
  const strip = {
    handlers: {},
    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    },
  };
  const body = { scrollTop: 0 };
  const tabEls = groups.map(({ key, label }) => {
    const attrs = {};
    const el = {
      dataset: { settingsTab: key },
      attrs,
      focused: false,
      tabIndex: -1,
      setAttribute(name, value) {
        attrs[name] = String(value);
      },
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
      removeAttribute: (name) => void delete attrs[name],
      focus() {
        this.focused = true;
      },
      closest: () => el,
      querySelector: (sel) => (sel === ".settings-tab-count" ? el.badge : sel === ".settings-tab-label" ? { textContent: label } : null),
    };
    el.badge = { textContent: "0", hidden: true };
    return el;
  });
  const panelEls = groups.map(({ key, children = [] }) => ({ dataset: { settingsGroup: key }, children, hidden: false }));
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
    querySelectorAll: (sel) => (sel.includes('[role="tab"]') ? tabEls : panelEls),
    querySelector: (sel) => (sel.includes("settings-body") ? body : null),
    getElementById: (id) =>
      id === "settings-tabs" ? strip : id === "settings-search" ? box : id === "btn-settings-search-clear" ? clear : null,
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
    `${region}; return { initSettingsTabs, initSettingsSearch, paintSettingsSearch, paintSettingsTab, settingsTabKey, SETTINGS_TAB_KEY, SETTINGS_SEARCH_HIGHLIGHT };`,
  )(localStorage, document, CSS, Highlight, Range, NodeFilter);
  return { ...api, store, writes, box, clear, CSS, tabs: tabEls, panels: panelEls, strip, body };
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
    querySelectorAll: (sel) => (sel === "[title]" ? innerTitles.map((t) => ({ getAttribute: () => t })) : []),
    classList: classList(classes),
  };
}

// A preview strip or a preset row: part of the row above it, never a setting of its own.
function attach(kind) {
  const classes = new Set([kind]);
  return { classes, textContent: "", classList: classList(classes) };
}

const group = (key, children = [], label = key) => ({ key, label, children });

const two = () => [group("display", [row("Page zoom"), row("Panel font")], "Display"), group("cards", [row("Show thinking")], "Agent cards")];

test("an absent key selects the first tab, and painting at load writes nothing", () => {
  const p = page({ groups: two() });
  p.initSettingsTabs();

  assert.equal(p.tabs[0].attrs["aria-selected"], "true", "a browser with no saved key opens Display");
  assert.equal(p.panels[0].hidden, false);
  assert.equal(p.tabs[1].attrs["aria-selected"], "false");
  assert.equal(p.panels[1].hidden, true);
  assert.equal(p.store.has(STORE_KEY), false, "reading a default must not invent a key");
  assert.deepEqual(p.writes, [], "loading never rewrites what the browser had");
});

test("a remembered tab is restored, and the stored key is not rewritten", () => {
  const p = page({ groups: two(), tabSeed: "cards" });
  p.initSettingsTabs();

  assert.equal(p.tabs[1].attrs["aria-selected"], "true", "the tab the reader chose comes back");
  assert.equal(p.tabs[1].tabIndex, 0, "and it is the strip's Tab stop");
  assert.equal(p.panels[1].hidden, false);
  assert.equal(p.tabs[0].attrs["aria-selected"], "false");
  assert.equal(p.panels[0].hidden, true);
  assert.equal(p.store.get(STORE_KEY), "cards", "the remembered key is read, not rewritten");
  assert.deepEqual(p.writes, [], "no write happens on the read path");
});

test("a stored key that names no panel falls back to the first tab, not an empty window", () => {
  const p = page({ groups: two(), tabSeed: "retired-tab" });
  p.initSettingsTabs();

  assert.equal(p.tabs[0].attrs["aria-selected"], "true");
  assert.equal(p.panels[0].hidden, false);
  assert.equal(p.panels.filter((panel) => !panel.hidden).length, 1, "exactly one panel is on screen");
  assert.deepEqual(p.writes, [], "a stale key is not repaired by writing over it for the reader");
});

test("the old fold keys are inert: not read, not rewritten", () => {
  const p = page({ groups: two(), legacy: { key: "wtgui.settingsUnfolded", value: '["cards"]' } });
  p.initSettingsTabs();

  assert.equal(p.tabs[0].attrs["aria-selected"], "true", "a legacy unfold list cannot choose a tab");
  assert.equal(p.store.get("wtgui.settingsUnfolded"), '["cards"]', "the old key is left exactly as the reader left it");
  assert.equal(p.store.has(STORE_KEY), false, "and the new key is not seeded from it");
  assert.deepEqual(p.writes, []);
});

test("a press selects the tab, shows its panel and remembers it", () => {
  const p = page({ groups: two() });
  p.initSettingsTabs();

  p.strip.handlers.click[0]({ target: p.tabs[1] });

  assert.equal(p.tabs[1].attrs["aria-selected"], "true", "the pressed tab is selected");
  assert.equal(p.tabs[1].tabIndex, 0, "and becomes the strip's Tab stop");
  assert.equal(p.tabs[0].attrs["aria-selected"], "false");
  assert.equal(p.tabs[0].tabIndex, -1);
  assert.equal(p.panels[1].hidden, false, "its panel is the one on screen");
  assert.equal(p.panels[0].hidden, true, "and the other one is gone");
  assert.equal(p.store.get(STORE_KEY), "cards", "the choice is remembered");
  assert.equal(p.body.scrollTop, 0, "the new panel starts at its own top");
});

test("the arrows walk the strip (wrapping), Home/End take the ends, and Enter/Space select", () => {
  const groups = [group("display", [row("Page zoom")]), group("cards", [row("Show thinking")]), group("board", [row("Read now")])];
  const p = page({ groups });
  p.initSettingsTabs();
  let prevented = 0;
  const key = (k, el) => p.strip.handlers.keydown[0]({ key: k, target: el, preventDefault: () => void (prevented += 1) });

  key("ArrowRight", p.tabs[0]);
  assert.equal(p.tabs[1].attrs["aria-selected"], "true", "Right moves to the next tab and selects it");
  assert.equal(p.tabs[1].focused, true, "and the focus goes with it");
  key("ArrowRight", p.tabs[2]);
  key("ArrowRight", p.tabs[2]);
  assert.equal(p.tabs[0].attrs["aria-selected"], "true", "Right on the last one wraps to the first");
  key("ArrowLeft", p.tabs[0]);
  assert.equal(p.tabs[2].attrs["aria-selected"], "true", "Left on the first wraps to the last");
  key("Home", p.tabs[2]);
  assert.equal(p.tabs[0].attrs["aria-selected"], "true", "Home takes the first");
  key("End", p.tabs[0]);
  assert.equal(p.tabs[2].attrs["aria-selected"], "true", "End takes the last");
  key("Enter", p.tabs[1]);
  assert.equal(p.tabs[1].attrs["aria-selected"], "true", "Enter selects the tab that has the focus");
  key(" ", p.tabs[2]);
  assert.equal(p.tabs[2].attrs["aria-selected"], "true", "so does Space");
  key("a", p.tabs[2]);
  assert.equal(p.tabs[2].attrs["aria-selected"], "true", "a letter is not a tab key");
  assert.equal(prevented, 8, "every key that moves or selects swallows the default (Space would scroll)");
  assert.equal(p.store.get(STORE_KEY), "board", "the keyboard's choice is remembered like a press");
});

test("the search is global: every tab counts its matches, and a match on another tab is revealed", () => {
  const zoom = row("Page zoom", "page zoom — Ctrl+wheel, Ctrl + / Ctrl − , Ctrl 0 resets");
  const font = row("Panel font", "The panel's own typeface");
  const refresh = row("Refresh now", "re-read every worktree row");
  const p = page({ groups: [group("display", [zoom, font, attach("settings-preview")], "Display"), group("board", [refresh], "Board")] });
  p.initSettingsTabs();
  p.initSettingsSearch();

  p.box.value = "refresh";
  p.box.handlers.input[0]();

  assert.equal(p.tabs[0].attrs["aria-selected"], "false", "the selected tab had no match");
  assert.equal(p.tabs[1].attrs["aria-selected"], "true", "the tab that answers is revealed");
  assert.equal(p.panels[0].hidden, true);
  assert.equal(p.panels[1].hidden, false, "so its row is on screen, not behind a tab");
  assert.ok(!refresh.classes.has("search-hidden"), "the matching row stays");
  assert.ok(zoom.classes.has("search-hidden"), "rows on every tab are filtered, not only the visible one");
  assert.equal(p.tabs[0].badge.textContent, "0", "the empty tab says 0");
  assert.equal(p.tabs[1].badge.textContent, "1", "the matching tab says how many");
  assert.equal(p.tabs[0].badge.hidden, false, "both badges show while the query is on");
  assert.equal(p.tabs[1].attrs["aria-label"], "Board — 1 match", "the count is in the tab's own name");
  assert.equal(p.store.has(STORE_KEY), false, "the search did not save its reveal as the reader's tab");
  assert.equal(p.clear.hidden, false, "the ✕ is offered once there is something to clear");

  p.box.value = "";
  p.box.handlers.input[0]();
  assert.equal(p.tabs[0].attrs["aria-selected"], "true", "clearing goes back to the reader's tab");
  assert.equal(p.panels[1].hidden, true);
  assert.ok(!zoom.classes.has("search-hidden") && !font.classes.has("search-hidden"), "every row is back");
  assert.equal(p.tabs[0].badge.hidden, true, "the badges hide again");
  assert.equal(p.tabs[0].attrs["aria-label"], undefined, "and the tab's own name is its label again");
  assert.equal(p.clear.hidden, true);
  assert.equal(p.CSS.highlights.name, null, "no stale highlight is left on the page");
});

test("a match on the tab already shown does not move the reader, and the counts stay per tab", () => {
  const zoom = row("Page zoom", "page zoom — Ctrl+wheel, Ctrl 0 resets");
  const font = row("Panel font", "the panel's own typeface");
  const refresh = row("Refresh now", "re-read every worktree row");
  const p = page({ groups: [group("display", [zoom, font], "Display"), group("board", [refresh], "Board")], tabSeed: "display" });
  p.initSettingsTabs();
  p.initSettingsSearch();

  p.box.value = "zoom";
  p.box.handlers.input[0]();
  assert.equal(p.tabs[0].attrs["aria-selected"], "true", "the tab the reader was on holds the match, so it stays");
  assert.equal(p.panels[0].hidden, false, "the panel they were reading is still the one on screen");
  assert.equal(p.panels[1].hidden, true);
  assert.equal(p.tabs[0].badge.textContent, "1", "Display counts its one match");
  assert.equal(p.tabs[1].badge.textContent, "0", "Board counts none");
  assert.equal(p.tabs[1].attrs["aria-label"], "Board — no matches");
  assert.ok(!zoom.classes.has("search-hidden"), "the match is marked in its own tab (kept visible by the filter)");

  // A word that is only in a control's tooltip — or only in the row's own tooltip — finds the row too.
  p.box.value = "ctrl+wheel";
  p.box.handlers.input[0]();
  assert.ok(!zoom.classes.has("search-hidden"), "the row's title is searched");
  assert.equal(p.CSS.highlights.ranges, null, "a title-only match has no text to mark, so nothing is highlighted");
});

test("the search marks matches instead of re-rendering the row it is filtering", () => {
  // No markup is written and no text is assigned: a keystroke that took the row apart would drop a select's
  // value, a half-typed number and the caret with it. The badge count is tab CHROME and lives outside this region.
  assert.doesNotMatch(searchRegion, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML|textContent\s*=/);
  assert.doesNotMatch(searchRegion, /createElement|appendChild|removeChild/, "nothing is built or moved");
  assert.match(searchRegion, /CSS\.highlights/, "the marking is a Custom Highlight");
  assert.match(searchRegion, /createTreeWalker/, "and it walks the row's existing text nodes");
});

test("Esc clears the box and leaves the panel's own Esc for an empty one", () => {
  const zoom = row("Page zoom", "page zoom");
  const font = row("Panel font", "the panel's own typeface");
  const p = page({ groups: [group("display", [zoom, font])] });
  p.initSettingsTabs();
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
  const p = page({ groups: [group("display", [zoom])] });
  p.initSettingsTabs();
  p.initSettingsSearch();

  p.box.value = "zoom";
  p.box.handlers.input[0]();
  p.clear.handlers.click[0]();
  assert.equal(p.box.value, "");
  assert.equal(p.box.focused, true, "the reader can keep typing");
  assert.ok(!zoom.classes.has("search-hidden"));
  assert.equal(p.clear.hidden, true);
});
