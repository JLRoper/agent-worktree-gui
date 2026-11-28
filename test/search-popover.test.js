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

const { keyIntent, placeGeometry, dragGeometry, mount, PLACE_DEFAULTS } = globalThis.wtSearchPopover;

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
    children: [],
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
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    insertBefore(child) {
      this.children.unshift(child);
      return child;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, right: 0, bottom: 0, top: 0, width: 0, height: 0 }),
    ...props,
  };
  // The chrome is built through the popover's own document, so a fake popover needs one that hands back fakes and
  // can take the drag's own document-level listeners.
  if (!el.ownerDocument) {
    el.ownerDocument = {
      createElement: () => fakeEl(),
      addEventListener() {},
      removeEventListener() {},
    };
  }
  return el;
}

// A global `window`/`document` for the duration of one test: the module reads both through `root`/bare globals.
function withDom(run, { viewport = { width: 1440, height: 900 }, zoom = 1 } = {}) {
  const docListeners = new Map();
  const winListeners = new Map();
  const before = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.window = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };
  globalThis.document = {
    documentElement: {},
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };
  // Settings > Display's zoom: the module reads it off documentElement to turn a visual rect into a layout length.
  globalThis.getComputedStyle = () => ({ zoom: String(zoom) });
  try {
    return run({ window: globalThis.window, document: globalThis.document, docListeners, winListeners });
  } finally {
    globalThis.window = before.window;
    globalThis.document = before.document;
    globalThis.getComputedStyle = before.getComputedStyle;
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
test("the popover opens at the box's LEFT edge and grows rightwards", () => {
  const box = { left: 1200, right: 1420, bottom: 40 };
  const g = placeGeometry({ box, viewportWidth: 1760, viewportHeight: 900 });
  assert.equal(g.width, 360, "the box's 220px plus 140, inside the 380 cap");
  assert.equal(g.left, 1200, "the left edge is the box's own left edge");
  assert.equal(g.right, 1560, "it grows to the RIGHT, not left of the box");
  assert.equal(g.top, 46, "6px under the box");
  assert.equal(g.maxHeight, Math.max(120, Math.min(900 * 0.42, 900 - 46 - 12)));
});

test("a small box gets the floor and a box near the window's edge NARROWS instead of sliding left", () => {
  // The assistant's box is ~55px: the 250px floor is what makes the popover wider than the box it hangs under.
  const narrow = placeGeometry({ box: { left: 1497, right: 1553, bottom: 114 }, viewportWidth: 1760, viewportHeight: 1000 });
  assert.equal(narrow.width, PLACE_DEFAULTS.minWidth);
  assert.equal(narrow.left, 1497, "the left edge is the input's own left edge, not the pane's");
  assert.ok(narrow.right <= 1760 - PLACE_DEFAULTS.pad, `right ${narrow.right} sits inside the window`);
  // The count beside the box can shrink the room to ~197px: the placement squeezes to it rather than sliding left,
  // which is what keeps the left edge under the box at the real bar's own layout.
  const squeezed = placeGeometry({ box: { left: 1554.6, right: 1635.6, bottom: 76 }, viewportWidth: 1760, viewportHeight: 1000 });
  assert.equal(squeezed.left, 1554.6, "the left edge is still the box's");
  assert.equal(Math.round(squeezed.width * 10) / 10, 197.4, "and it is 197px wide, not 250px off the box's left");
  // 30px from the right edge not even `squeeze` fits: the popover backs off the edge and keeps a readable width.
  const tight = placeGeometry({ box: { left: 1700, right: 1730, bottom: 114 }, viewportWidth: 1760, viewportHeight: 1000 });
  assert.equal(tight.left, 1760 - PLACE_DEFAULTS.pad - PLACE_DEFAULTS.squeeze, "the squeeze keeps the list readable");
  assert.equal(tight.right, 1760 - PLACE_DEFAULTS.pad, "it runs to the window's own padding and stops");
  // A very wide box gets the cap, and a box off the left edge is kept off the window's edge.
  assert.equal(placeGeometry({ box: { left: 900, right: 1700, bottom: 10 }, viewportWidth: 1760, viewportHeight: 900 }).width, PLACE_DEFAULTS.widthCap);
  assert.equal(placeGeometry({ box: { left: -300, right: -200, bottom: 10 }, viewportWidth: 1440, viewportHeight: 900 }).left, 8, "never off the left edge");
  // A second bar may pass its own numbers, but the RULE is the same one: the Hot Agent opener is 34px wide.
  const hot = placeGeometry({ box: { left: 1035, right: 1069, bottom: 75 }, viewportWidth: 1760, viewportHeight: 1000, options: { minWidth: 330, widthCap: 420 } });
  assert.equal(hot.width, 330);
  assert.equal(hot.left, 1035, "under the button, not 296px to its left");
});

test("a short window floors the height instead of collapsing the list", () => {
  const g = placeGeometry({ box: { left: 1200, right: 1420, bottom: 800 }, viewportWidth: 1440, viewportHeight: 820 });
  assert.equal(g.maxHeight, 120, "the floor wins over the room left below the box");
});

// ---- the drag and the grip -------------------------------------------------------------------
test("a move follows the pointer's travel and stays inside the window", () => {
  const start = { left: 100, top: 100, width: 250, height: 200 };
  const moved = dragGeometry({ kind: "move", start, dx: 40, dy: 30, viewportWidth: 1760, viewportHeight: 1000 });
  assert.deepEqual({ left: moved.left, top: moved.top, width: moved.width, height: moved.height }, { left: 140, top: 130, width: 250, height: null });
  const off = dragGeometry({ kind: "move", start, dx: 5000, dy: 5000, viewportWidth: 1760, viewportHeight: 1000 });
  assert.equal(off.left, 1760 - PLACE_DEFAULTS.pad - 250, "the right edge stops at the window's padding");
  assert.equal(off.top, 1000 - PLACE_DEFAULTS.pad - 200, "the bottom edge stops at the window's padding");
  const back = dragGeometry({ kind: "move", start, dx: -5000, dy: -5000, viewportWidth: 1760, viewportHeight: 1000 });
  assert.deepEqual({ left: back.left, top: back.top }, { left: PLACE_DEFAULTS.pad, top: PLACE_DEFAULTS.pad }, "never off the top-left");
});

test("a grip drag resizes it, with a floor and the window as the ceiling", () => {
  const start = { left: 100, top: 100, width: 250, height: 200 };
  const bigger = dragGeometry({ kind: "resize", start, dx: 100, dy: 60, viewportWidth: 1760, viewportHeight: 1000 });
  assert.equal(bigger.width, 350);
  assert.equal(bigger.height, 260);
  assert.equal(bigger.resized, true);
  const tiny = dragGeometry({ kind: "resize", start, dx: -500, dy: -500, viewportWidth: 1760, viewportHeight: 1000 });
  assert.equal(tiny.width, PLACE_DEFAULTS.minWidth, "the floor is a width the reader can still read");
  assert.equal(tiny.height, PLACE_DEFAULTS.minHeight);
  const huge = dragGeometry({ kind: "resize", start, dx: 9000, dy: 9000, viewportWidth: 1760, viewportHeight: 1000 });
  assert.equal(huge.width, 1760 - PLACE_DEFAULTS.pad - 100);
  assert.equal(huge.height, 1000 - PLACE_DEFAULTS.pad - 100);
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

test("show places the popover under its own box and hides do not place", () => {
  withDom(
    () => {
      const input = fakeEl({ getBoundingClientRect: () => ({ left: 1200, right: 1255, bottom: 40 }) });
      const anchor = fakeEl({ getBoundingClientRect: () => ({ left: 1100, right: 1130, bottom: 36 }) });
      const pop = fakeEl({ hidden: true });
      const bar = mount({ input, pop, anchor, readout: () => ({ text: "" }) });
      const g = bar.place();
      assert.equal(g, null, "a hidden popover is not placed");
      bar.show("<i>x</i>");
      assert.equal(pop.style.width, "250px", "the input is 55px wide: the floor applies");
      assert.equal(pop.style.left, "1100px", "an explicit anchor wins: the popover opens at ITS left edge");
      assert.equal(pop.style.top, "42px");
      // No anchor means the INPUT itself, which is what the turn search passes: left edge at the box's left edge.
      const own = fakeEl({ hidden: true });
      const atInput = mount({ input, pop: own, readout: () => ({ text: "" }) });
      atInput.show("<i>y</i>");
      assert.equal(own.style.left, "1200px");
    },
    { viewport: { width: 1760, height: 1000 } },
  );
});

test("hide clears a resized height and a reopen draws the anchored default again", () => {
  withDom(
    () => {
      const input = fakeEl({ getBoundingClientRect: () => ({ left: 1200, right: 1255, bottom: 40 }) });
      const pop = fakeEl({ hidden: true });
      const bar = mount({ input, pop, readout: () => ({ text: "" }) });
      bar.show("<i>x</i>");
      assert.equal(pop.style.left, "1200px");
      assert.equal(pop.style.top, "46px");
      // What a grip drag leaves behind, and what a drag of the strip leaves behind.
      pop.style.height = "300px";
      pop.style.maxHeight = "300px";
      pop.classList.add("is-moved");
      bar.hide();
      assert.equal(pop.hidden, true);
      assert.equal(pop.style.height, "", "closing forgets the reader's size");
      assert.equal(pop.classList.contains("is-moved"), false, "closing forgets the reader's rectangle");
      bar.show("<i>y</i>");
      assert.equal(pop.style.left, "1200px", "the reopen is the anchored default, not where it was left");
      assert.equal(pop.style.top, "46px");
      assert.equal(pop.style.width, "250px");
      assert.equal(pop.style.height, "", "and it is its natural height again");
    },
    { viewport: { width: 1760, height: 1000 } },
  );
});

test("the popover carries a drag strip with a close x, and a grip, and show re-adds them", () => {
  withDom(() => {
    const input = fakeEl();
    const pop = fakeEl({ hidden: true });
    const closes = [];
    const bar = mount({ input, pop, readout: () => ({ text: "" }), onClose: () => closes.push("close") });
    bar.show("<b>rows</b>");
    const classes = pop.children.map((child) => child.className);
    assert.ok(classes.includes("as-search-drag"), `a drag strip is the first child: ${classes.join(", ")}`);
    assert.ok(classes.includes("as-search-grip"), `a grip is the last child: ${classes.join(", ")}`);
    const strip = pop.children.find((child) => child.className === "as-search-drag");
    assert.equal(pop.children[0], strip, "the strip sits at the top");
    const x = strip.children.find((child) => child.className === "as-search-x");
    assert.ok(x, "the close x rides the strip");
    for (const fn of x.listeners.get("click") || []) fn({ preventDefault() {} });
    assert.deepEqual(closes, ["close"], "the x calls the bar's close");
    // The strip's own mousedown is a drag, not a row press: it must not be preventative of nothing and must not throw.
    for (const fn of strip.listeners.get("mousedown") || []) fn({ clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
    assert.equal(pop.classList.contains("is-moving"), true, "the strip starts a move");
  });
});

test("a zoomed page is written in layout px: the popover opens at the box's own left, not zoom-times past it", () => {
  withDom(
    () => {
      const input = fakeEl({ getBoundingClientRect: () => ({ left: 1200, right: 1255, bottom: 40, top: 20, width: 55, height: 20 }) });
      const pop = fakeEl({ hidden: true });
      const bar = mount({ input, pop, readout: () => ({ text: "" }) });
      bar.show("<i>x</i>");
      // Visual 1200 at zoom 1.1 is layout 1090.9: the length a style write needs. The old rule wrote 1200, which draws
      // at 1320 - 120px right of the box.
      assert.ok(Math.abs(parseFloat(pop.style.left) - 1200 / 1.1) < 1e-6, `left ${pop.style.left} is layout px`);
      assert.equal(pop.style.top, "42px", "top is the box's bottom plus the gap, in layout px (40 / 1.1 + 6, rounded)");
      assert.ok(parseFloat(pop.style.width) >= 250, "the width floor is layout px too");
    },
    { viewport: { width: 1760, height: 1000 }, zoom: 1.1 },
  );
});

test("resetPlacement forgets the reader's rectangle while the list stays open", () => {
  withDom(
    () => {
      const input = fakeEl({ getBoundingClientRect: () => ({ left: 1200, right: 1255, bottom: 40 }) });
      const pop = fakeEl({ hidden: true });
      const bar = mount({ input, pop, readout: () => ({ text: "" }) });
      bar.show("<b>rows</b>");
      pop.style.height = "260px";
      pop.classList.add("is-resized");
      const back = bar.resetPlacement();
      assert.equal(pop.hidden, false, "a scope change leaves the list open");
      assert.equal(pop.style.height, "", "but the size is the anchored default's");
      assert.equal(pop.style.top, "46px");
      assert.equal(back.left, 1200);
    },
    { viewport: { width: 1760, height: 1000 } },
  );
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
