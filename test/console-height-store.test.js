// A console height the reader dragged must survive the rebuild that replaces or builds the box, at the size they left
// it — not on the cap, and not at the content height a fresh box happens to measure.
//
// The seam-free half of `tools/verify-console-height.mjs` (there is no layout engine in `npm test`): it reads the
// shipped store and placement functions out of `public/app.js` and drives them over a small console model, with the one
// browser rule they depend on - the computed `max-height` a box is drawn under, and `clientHeight` following the height
// the inline style gives it.
//
// Why it exists. `.job-out` is a browser-resized box (`resize: vertical` under a max-height, public/style.css), so the
// size the reader gave it lives only in that node's inline style. Measured on 0.48.2 (C:/CodeReviews/agent-worktree-gui/
// resize/rebuild.md): eight of twelve rebuild triggers threw it away — a status change, a new turn, a fold, a project
// collapse and a reload all came back on the 320 px cap (or, on a short transcript, at 121.5 px / 69.8 px). The height
// now lives in `state.outHeights`, keyed by the turn id the console carries, and goes back on every path that builds or
// replaces the node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `public/app.js still carries ${name}()`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is still a top-level function`);
  return src.slice(start, end + 3);
}

// ---- a console box, and the page's own storage ----------------------------------------------------------------
// `writes` is ordered across BOTH kinds of write, so "the height went on before the scroll was placed" is assertable:
// the scroll has to be clamped in the box the reader left, not in the 320 px one it is about to stop being.
class Console {
  constructor({ out, cap, content = 1000 } = {}) {
    this.dataset = { out };
    this.cap = cap; // what getComputedStyle().maxHeight resolves to for this box
    this.content = content;
    this.top = 0;
    this.writes = [];
    const self = this;
    const values = {};
    this.style = new Proxy(values, {
      set(target, prop, value) {
        self.writes.push(`${String(prop)}=${String(value)}`);
        target[prop] = String(value);
        return true;
      },
    });
  }
  get scrollHeight() {
    return this.content;
  }
  // The inline height wins over the cap; without one the box is as tall as whatever the sheet allows.
  get clientHeight() {
    const inline = parseFloat(this.style.height);
    const h = Number.isFinite(inline) ? inline : parseFloat(this.cap);
    return Math.min(Number.isFinite(h) ? h : this.content, this.content);
  }
  get max() {
    return this.scrollHeight - this.clientHeight;
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(v) {
    const clamped = Math.max(0, Math.min(Number(v) || 0, this.max));
    this.writes.push(`scrollTop=${clamped}`);
    this.top = clamped;
  }
}

// A subtree rebuilt from HTML: the boxes under it and nothing else.
const root = (consoles) => ({
  querySelectorAll: (sel) => (sel === "pre.job-out" ? consoles : []),
});

const storage = new Map();
const context = {
  state: { outPinned: {}, outScrolls: {}, outHeights: {} },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  },
  getComputedStyle: (el) => ({ maxHeight: el.cap }),
  Math,
  Number,
  Set,
  WeakSet,
  Object,
};
vm.createContext(context);
vm.runInContext(
  [
    "const selfScrolled = new WeakSet();",
    grab("loadOutHeights"),
    grab("saveOutHeights"),
    grab("rememberOutHeight"),
    grab("pruneOutHeights"),
    grab("consolePinned"),
    grab("setScroll"),
    grab("applyStoredHeight"),
    grab("applyStoredHeights"),
    grab("applySubConsoleScrolls"),
    grab("applyStoredScrolls"),
    grab("placeBuiltConsoles"),
  ].join("\n"),
  context,
);

const fresh = (opts = {}) => {
  context.state.outHeights = {};
  context.state.outScrolls = {};
  context.state.outPinned = {};
  storage.clear();
  return new Console({ cap: "320px", out: "turn-1", ...opts });
};

// ---- the height survives a rebuild -----------------------------------------------------------------------------
test("a stored height survives a rebuild, above the cap, with the cap lifted off it", () => {
  const box = fresh();
  context.state.outHeights["turn-1"] = 420;

  context.placeBuiltConsoles(root([box])); // a card built from nothing: a collapsed project expanded again

  assert.equal(box.style.height, "420px", "the box is the height the reader dragged it to, not its 320 px cap");
  assert.equal(box.style.maxHeight, "none", "and the cap that would clip it is lifted, exactly as the drag does");
  assert.equal(box.clientHeight, 420, "the box the reader left is the box that is drawn");
});

test("the replace path applies it too (renderJobs and a rebuilt project detail go through applyStoredScrolls)", () => {
  const box = fresh({ out: "turn-2" });
  context.state.outHeights["turn-2"] = 490;

  context.applyStoredScrolls(root([box]));

  assert.equal(box.style.height, "490px");
  assert.equal(box.style.maxHeight, "none");
});

test("a below-cap height is kept exactly, and the cap is left where it was", () => {
  const box = fresh();
  context.state.outHeights["turn-1"] = 260;

  context.placeBuiltConsoles(root([box]));

  assert.equal(box.style.height, "260px", "the number the reader chose, to the pixel");
  assert.equal(box.style.maxHeight, undefined, "nothing to lift: 260 px is under the 320 px cap, and the sheet keeps it");
  assert.equal(box.clientHeight, 260);
});

test("a console nobody resized is left alone, so the cap still does its job", () => {
  const box = fresh();
  context.placeBuiltConsoles(root([box]));
  assert.deepEqual(box.writes, ["scrollTop=680"], "one scroll to its newest line, no inline height and no lifted cap");
  assert.equal(box.style.height, undefined);
  assert.equal(box.style.maxHeight, undefined);
});

test("the height goes on BEFORE the scroll is placed, so the reader's line is clamped in the box they left", () => {
  const box = fresh({ content: 4000 });
  context.state.outHeights["turn-1"] = 420;
  // A console the reader had parked deep in a long transcript, with the panel told they are not following it.
  context.state.outScrolls["turn-1"] = { top: 1200, atBottom: false };
  context.state.outPinned["turn-1"] = false;

  context.placeBuiltConsoles(root([box]));

  assert.deepEqual(box.writes, ["height=420px", "maxHeight=none", "scrollTop=1200"], "height first, then the line");
  assert.equal(box.max, 3580, "the parked line was clamped against a 420 px box, not a 320 px one");
});

// ---- the store itself -----------------------------------------------------------------------------------------
test("the store is persisted the way the card fold state is, and junk cannot become a height", () => {
  fresh();
  context.rememberOutHeight("turn-1", 420);
  assert.equal(storage.get("wm.outHeights"), '{"turn-1":420}', "written to its own localStorage key");

  context.rememberOutHeight("turn-2", 260.5);
  assert.deepEqual({ ...context.loadOutHeights() }, { "turn-1": 420, "turn-2": 260.5 }, "a reload reads both back");

  storage.set("wm.outHeights", '{"a":"420px","b":-3,"c":0,"d":380,"":90,"e":null}');
  assert.deepEqual({ ...context.loadOutHeights() }, { d: 380 }, "only finite, positive numbers keyed by a real id survive");

  storage.set("wm.outHeights", "not json");
  assert.deepEqual({ ...context.loadOutHeights() }, {}, "a corrupt key is not a reason to throw on boot");

  fresh();
  context.rememberOutHeight("", 500);
  context.rememberOutHeight("turn-3", 0);
  assert.deepEqual({ ...context.state.outHeights }, {}, "a press with no turn, or no height, records nothing");
});

test("a turn that left the board takes its height with it, and a pinned copy goes with the turn it copies", () => {
  fresh();
  context.state.outHeights = { "turn-1": 420, "turn-1@pin": 300, "turn-2": 260 };

  const gone = context.pruneOutHeights(new Set(["turn-1"]));

  assert.equal(gone, 1, "one entry pruned");
  assert.deepEqual({ ...context.state.outHeights }, { "turn-1": 420, "turn-1@pin": 300 }, "the turn and its pin copy stay");
  assert.equal(storage.get("wm.outHeights"), '{"turn-1":420,"turn-1@pin":300}', "and the store on disk was rewritten");
});

test("the pruned set is the one renderJobs already keeps: a live turn keeps its height", () => {
  fresh();
  context.state.outHeights = { "turn-9": 420 };
  assert.equal(context.pruneOutHeights(new Set(["turn-9"])), 0);
  assert.deepEqual({ ...context.state.outHeights }, { "turn-9": 420 });
});

// ---- the two call sites a unit test cannot execute -------------------------------------------------------------
// renderConversation swaps the card node itself (it needs the whole page), and the pointerup that RECORDS a drag is a
// raw document listener. The gate (tools/verify-console-height.mjs) drives both for real; these two assertions keep the
// calls from being deleted without a red test.
test("the shipped rebuild and the drag's release still call the store", () => {
  assert.ok(grab("renderConversation").includes("applyStoredHeight(o);"), "renderConversation puts the height back");
  assert.ok(src.includes("rememberOutHeight(out.dataset.out, now);"), "the drag's pointerup records the height it reached");
  assert.ok(src.includes("pruneOutHeights(live);"), "renderJobs prunes the store on the turns that are left");
});
