// The ONE popover both header searches mount: public/core/search-popover.js.
//
// WHY THIS FILE EXISTS. The Hot Agent search is a second bar beside the assistant's turn search, and the brief is
// explicit that it must be built on the component 1.114.3 landed rather than on a copy of the behaviour that existed
// before it: same keys, same placement, same count, same follow through public/core/search-scroll.js. A second copy
// is how one bar keeps its current row visible and the other one does not. So the shared parts are pinned here, and
// the page's USE of them (two mounts, no local arithmetic) is pinned too.
//
// The module is a classic script, loaded by public/index.html before assistant.js and importable by this file for its
// global, the same contract public/core/search-scroll.js has. A DOM is not available under `node --test`, so the
// element fakes below are the smallest ones the module actually touches; the real wiring is proved in a browser by
// tools/verify-hot-agent-search.mjs and tools/verify-assistant-search*.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../public/core/search-popover.js";

const { keyIntent, placeGeometry, mount, PLACE_DEFAULTS } = globalThis.wtSearchPopover;

// ---- one element, only what the module reads ------------------------------------------------
function fakeEl(props = {}) {
  const classes = new Set();
  const el = {
    hidden: false,
    innerHTML: "",
    textContent: "",
    style: {},
    dataset: {},
    title: "",
    attributes: {},
    listeners: new Map(),
    classList: {
      toggle(name, on) {
        const want = on === undefined ? !classes.has(name) : Boolean(on);
        if (want) classes.add(name);
        else classes.delete(name);
        return want;
      },
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, right: 0, bottom: 0, top: 0, width: 0, height: 0 }),
    ...props,
  };
  return el;
}

// A global `window`/`document` for the duration of one test: the module reads both through `root`/bare globals.
function withDom(run, { viewport = { width: 1440, height: 900 } } = {}) {
  const docListeners = new Map();
  const winListeners = new Map();
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };
  globalThis.document = {
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };
  try {
    return run({ window: globalThis.window, document: globalThis.document, docListeners, winListeners });
  } finally {
    globalThis.window = before.window;
    globalThis.document = before.document;
  }
}

// ---- the keyboard's meaning -----------------------------------------------------------------
test("the key meanings are the ones both bars document", () => {
  assert.equal(keyIntent("ArrowDown"), "step-forward");
  assert.equal(keyIntent("ArrowDown", true), "step-back", "Shift+Down reverses the step");
  assert.equal(keyIntent("ArrowUp"), "step-back");
  assert.equal(keyIntent("Enter"), "open");
  assert.equal(keyIntent("Enter", true), "step-back", "Shift+Enter is the third way back");
  assert.equal(keyIntent("Escape"), "clear");
  for (const key of ["a", "Tab", "ArrowLeft", " ", "F5", "Backspace"]) assert.equal(keyIntent(key), null, `${key} is the box's own`);
});

test("a stepping press is preventative, and Escape does not reach the panel", () => {
  withDom(() => {
    const input = fakeEl();
    const pop = fakeEl();
    const seen = [];
    const bar = mount({
      input,
      pop,
      readout: () => ({ text: "1 of 2", total: 2 }),
      onStep: (d) => seen.push(d),
      onOpen: () => seen.push("open"),
      onEscape: () => seen.push("escape"),
    });
    bar.wire();
    const press = (key, shiftKey = false) => {
      let prevented = false;
      let stopped = false;
      for (const fn of input.listeners.get("keydown") || []) {
        fn({ key, shiftKey, preventDefault: () => (prevented = true), stopPropagation: () => (stopped = true) });
      }
      return { prevented, stopped };
    };
    assert.deepEqual(press("ArrowDown"), { prevented: true, stopped: false });
    assert.deepEqual(press("ArrowDown", true), { prevented: true, stopped: false });
    assert.deepEqual(press("ArrowUp"), { prevented: true, stopped: false });
    assert.deepEqual(press("Enter"), { prevented: true, stopped: false });
    assert.deepEqual(press("Enter", true), { prevented: true, stopped: false });
    assert.deepEqual(press("Escape"), { prevented: true, stopped: true });
    assert.equal(press("a").prevented, false, "a letter is left to the box");
    assert.deepEqual(seen, [1, -1, -1, "open", -1, "escape"]);
  });
});

// ---- the placement arithmetic ---------------------------------------------------------------
test("the popover aligns its right edge with the box and grows leftwards", () => {
  const box = { left: 1200, right: 1420, bottom: 40 };
  const g = placeGeometry({ box, viewportWidth: 1440, viewportHeight: 900 });
  assert.equal(g.width, 360, "the box's 220px plus 140, inside the 380 cap");
  assert.equal(g.left, g.width === 360 ? 1420 - 360 : g.left);
  assert.equal(g.top, 46, "6px under the box");
  assert.equal(g.maxHeight, Math.max(120, Math.min(900 * 0.42, 900 - 46 - 12)));
});

test("the floor, the cap and the window's edges are respected", () => {
  // A narrow box still gets the floor; a very wide one gets the cap.
  assert.equal(placeGeometry({ box: { left: 10, right: 20, bottom: 10 }, viewportWidth: 1440, viewportHeight: 900 }).width, PLACE_DEFAULTS.minWidth);
  assert.equal(placeGeometry({ box: { left: 900, right: 1420, bottom: 10 }, viewportWidth: 1440, viewportHeight: 900 }).width, PLACE_DEFAULTS.widthCap);
  // A box hanging off the right edge clamps its right edge inside the window, and so does one off the left.
  assert.equal(placeGeometry({ box: { left: 2000, right: 2100, bottom: 10 }, viewportWidth: 1440, viewportHeight: 900 }).right ?? placeGeometry({ box: { left: 2000, right: 2100, bottom: 10 }, viewportWidth: 1440, viewportHeight: 900 }).left + placeGeometry({ box: { left: 2000, right: 2100, bottom: 10 }, viewportWidth: 1440, viewportHeight: 900 }).width, 1432);
  const left = placeGeometry({ box: { left: -300, right: -200, bottom: 10 }, viewportWidth: 1440, viewportHeight: 900 });
  assert.equal(left.left, 8, "never off the left edge");
  // A second bar may pass its own numbers, but the RULE is the same one.
  const wide = placeGeometry({ box: { left: 1300, right: 1400, bottom: 10 }, viewportWidth: 1440, viewportHeight: 900, options: { minWidth: 330, widthCap: 420 } });
  assert.equal(wide.width, 330);
});

test("a short window floors the height instead of collapsing the list", () => {
  const g = placeGeometry({ box: { left: 1200, right: 1420, bottom: 800 }, viewportWidth: 1440, viewportHeight: 820 });
  assert.equal(g.maxHeight, 120, "the floor wins over the room left below the box");
});

// ---- the popover's life ---------------------------------------------------------------------
test("show writes the LIST, so a popover with a permanent head keeps its box", () => {
  withDom(() => {
    const head = { innerHTML: "the box" };
    const list = fakeEl();
    const pop = fakeEl();
    const bar = mount({ input: fakeEl(), pop, scroller: list, readout: () => ({ text: "" }) });
    bar.show("<b>one row</b>");
    assert.equal(list.innerHTML, "<b>one row</b>", "the rows land in the scroller");
    assert.equal(pop.innerHTML, "", "the popover's own html is untouched");
    assert.equal(pop.hidden, false, "showing opens the popover");
    assert.deepEqual(head, { innerHTML: "the box" }, "the head is not rewritten");
    bar.hide();
    assert.equal(pop.hidden, true);
    assert.equal(list.innerHTML, "", "closing empties the list");
  });
});

test("show places the popover under its anchor and hides do not place", () => {
  withDom(() => {
    const input = fakeEl({ getBoundingClientRect: () => ({ left: 1200, right: 1420, bottom: 40 }) });
    const anchor = fakeEl({ getBoundingClientRect: () => ({ left: 1100, right: 1130, bottom: 36 }) });
    const pop = fakeEl({ hidden: true });
    const bar = mount({ input, pop, anchor, readout: () => ({ text: "" }) });
    const g = bar.place();
    assert.equal(g, null, "a hidden popover is not placed");
    bar.show("<i>x</i>");
    assert.equal(pop.style.width, "250px", "the anchor is 30px wide: the floor applies");
    assert.equal(pop.style.left, `${1130 - 250}px`);
    assert.equal(pop.style.top, "42px");
  });
});

test("the count's DOM is written from the readout, once", () => {
  withDom(() => {
    const count = fakeEl();
    const bar = mount({
      input: fakeEl(),
      pop: fakeEl(),
      count,
      readout: () => ({ text: "2 of 5", foot: "5 matched, 5 displayed", title: "Up and Down", current: 2, total: 5, matched: 5, displayed: 5, turns: 2, capped: true }),
    });
    bar.paintCount();
    assert.equal(count.textContent, "2 of 5");
    assert.equal(count.hidden, false);
    assert.equal(count.dataset.searchCurrent, "2");
    assert.equal(count.dataset.searchTotal, "5");
    assert.equal(count.dataset.searchMatched, "5");
    assert.equal(count.dataset.searchDisplayed, "5");
    assert.equal(count.dataset.searchTurns, "2");
    assert.equal(count.title, "Up and Down");
    assert.equal(count.classList.contains("is-capped"), true, "a capped answer says so in amber");
  });
});

test("a hidden count is emptied, not left stale", () => {
  withDom(() => {
    const count = fakeEl();
    const bar = mount({ input: fakeEl(), pop: fakeEl(), count, readout: () => ({ text: "0 of 0", hidden: true }) });
    bar.paintCount();
    assert.equal(count.hidden, true);
    assert.equal(count.textContent, "");
    assert.equal(count.attributes.title, undefined, "no tooltip on a count nobody can see");
  });
});

test("markCurrent marks one row and clears the last one", () => {
  withDom(() => {
    const rows = [0, 1, 2].map((i) => fakeEl({ dataset: { searchHit: String(i) } }));
    const list = fakeEl({ querySelectorAll: () => rows });
    let at = 0;
    const bar = mount({ input: fakeEl(), pop: fakeEl(), scroller: list, current: () => at, readout: () => ({}) });
    bar.markCurrent();
    assert.deepEqual(rows.map((r) => r.classList.contains("is-current")), [true, false, false]);
    assert.equal(rows[0].attributes["aria-current"], "true");
    at = 2;
    bar.markCurrent();
    assert.deepEqual(rows.map((r) => r.classList.contains("is-current")), [false, false, true]);
    assert.equal(rows[0].attributes["aria-current"], undefined);
    assert.equal(bar.rowAt(2), rows[2]);
  });
});

test("follow hands the current row to the scroller's own arithmetic", () => {
  withDom(() => {
    const row = fakeEl({ dataset: { searchHit: "1" } });
    const list = fakeEl({ querySelectorAll: () => [fakeEl({ dataset: { searchHit: "0" } }), row] });
    const pop = fakeEl();
    const calls = [];
    const before = globalThis.wtSearchScroll;
    globalThis.wtSearchScroll = { place: (scroller, r) => calls.push([scroller, r]) };
    try {
      const bar = mount({ input: fakeEl(), pop, scroller: list, current: () => 1, readout: () => ({}) });
      bar.show("rows");
      bar.follow();
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], list, "the follow moves the LIST, never the page or the popover");
      assert.equal(calls[0][1], row);
      bar.hide();
      assert.equal(bar.follow(), null, "a closed list follows nothing");
    } finally {
      globalThis.wtSearchScroll = before;
    }
  });
});

// ---- the page's USE of the module -----------------------------------------------------------
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("index.html loads both core files before assistant.js", () => {
  const html = read("public/index.html");
  const at = (needle) => html.indexOf(needle);
  for (const file of ["/core/search-popover.js", "/core/hot-agent-list.js"]) {
    const tag = `src="${file}"`;
    assert.ok(at(tag) > 0, `${file} is loaded by a script tag`);
    assert.ok(at(tag) < at('src="/assistant.js"'), `${file} loads before assistant.js, which mounts the bars`);
  }
  assert.ok(at('src="/core/search-scroll.js"') < at('src="/core/search-popover.js"'), "the follow's arithmetic is loaded first");
});

test("both header bars mount the one module, and the assistant's bar keeps no private arithmetic", () => {
  const js = read("public/assistant.js");
  const mounts = js.match(/wtSearchPopover/g) || [];
  assert.equal(mounts.length, 2, "two mounts: the turn search and the Hot Agent search");
  assert.match(js, /function searchBar\(\)[\s\S]{0,400}mod\.mount\(/);
  assert.match(js, /function hotBar\(\)[\s\S]{0,400}mod\.mount\(/);
  // The pre-1.114.3 behaviour was a second copy of the walk; the copy is gone, so the only place the popover's
  // geometry is computed is the module.
  assert.doesNotMatch(js, /Math\.min\(380, Math\.max\(250, r\.width \+ 140\)\)/, "the old placement formula is not still here");
  // Both bars still hand the walk to the shared wrap.
  assert.ok((js.match(/wtSearchCount\?\.step|wtSearchCount\.step/g) || []).length >= 2);
});

test("the shortcut is a SHIFTED chord beside Ctrl+Q, and only one of them answers a press", () => {
  const js = read("public/assistant.js");
  const hot = js.slice(js.indexOf("Ctrl+Shift+Q is the Hot Agent search"));
  assert.match(hot, /e\.ctrlKey && e\.shiftKey && !e\.altKey && !e\.metaKey/);
  assert.match(hot, /openHotSearch\(\)/);
  const plain = js.slice(js.indexOf("Ctrl+Q is the search box's own key"));
  assert.match(plain, /!e\.shiftKey/, "the plain chord refuses every shifted press, so the two cannot both fire");
});
