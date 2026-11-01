// The board's per-event DOM lookups: what they cost the page, and that they still find what they found.
//
// Read from a profile of the reader's own board (a read-only second client, 60 s, 105 projects / 170 rows / a 55k-node
// page): the largest DOM costs on it were lookups BY ATTRIBUTE VALUE - `document.querySelector('[data-x="name"]')` -
// which cannot use the id/class fast paths and walk the whole document each time:
//   paintSubagents()                 250 ms a minute: one or two lookups per job, for every job, on every roster poll
//   refreshChips / refreshAgeToggle  300 ms a minute: two or three lookups on every row placed (~340 a minute)
//   pulseRow / noteEventLife         a lookup for the row and one for its age cell on every agent event, and a forced
//                                    layout (`void tr.offsetWidth`) to restart the flash
// plus a looping pulse dot that, scrolled out of view, falls off the compositor and runs on the main thread (4.5
// points of a core per dot, measured). This file drives the shipped functions over a small DOM model that counts
// document lookups and layouts, so a change that puts a whole-document walk back on one of these paths is caught here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `public/app.js carries ${name}()`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is a top-level function`);
  return src.slice(start, end + 3);
}

// ---- a DOM model: elements by attribute, a document that counts what it is asked -------------------------------
class Node {
  constructor(attrs = {}, { cls = [] } = {}) {
    this.attrs = { ...attrs };
    this.classes = new Set(cls);
    this.children = [];
    this.hidden = false;
    this.connected = true;
    this.dataset = {};
    this.writes = 0;
    this._html = "";
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  get isConnected() {
    return this.connected;
  }
  get classList() {
    const c = this.classes;
    return {
      contains: (x) => c.has(x),
      add: (...xs) => xs.forEach((x) => c.add(x)),
      remove: (...xs) => xs.forEach((x) => c.delete(x)),
      toggle: (x, on) => ((on ?? !c.has(x)) ? c.add(x) : c.delete(x)),
    };
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this.writes += 1;
    this._html = String(v);
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  querySelector() {
    return null;
  }
  remove() {
    this.connected = false;
    doc.nodes = doc.nodes.filter((n) => n !== this);
  }
}

const doc = {
  nodes: [],
  queries: 0,
  scans: 0,
  // `[attr="value"]` (optionally behind a tag/class prefix) and `[attr]`, which is all these paths ask.
  querySelector(sel) {
    this.queries += 1;
    const m = /\[([\w-]+)="([^"]*)"\]/.exec(sel);
    if (!m) return null;
    return this.nodes.find((n) => n.connected && n.getAttribute(m[1]) === m[2].replace(/\\(.)/g, "$1")) || null;
  },
  querySelectorAll(sel) {
    this.scans += 1;
    const m = /^\[([\w-]+)\]$/.exec(sel);
    return m ? this.nodes.filter((n) => n.connected && n.getAttribute(m[1]) != null) : [];
  },
  add(node) {
    this.nodes.push(node);
    return node;
  },
  reset() {
    // A fresh board: whatever the last one held is out of the page, as it would be after a rebuild.
    for (const n of this.nodes) n.connected = false;
    this.nodes = [];
    this.queries = 0;
    this.scans = 0;
  },
};
const CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };

// ---- paintSubagents: two passes over the page per roster poll, whatever the number of jobs -------------------------
const subs = { document: doc, CSS, Map, Set, Boolean, String };
vm.createContext(subs);
let subsLoaded = false;
function roster({ jobs = 100, withRows = [] } = {}) {
  if (!subsLoaded) {
    vm.runInContext(grab("paintSubagents"), subs);
    subsLoaded = true;
  }
  doc.reset();
  subs.state = { jobs: new Map() };
  for (let i = 0; i < jobs; i++) subs.state.jobs.set(`job-${i}`, { id: `job-${i}` });
  subs.rowsAsked = [];
  subs.subagentsForTurn = (job) => {
    subs.rowsAsked.push(job.id);
    return withRows.includes(job.id) ? [{ id: `${job.id}-child`, running: true }] : [];
  };
  subs.subagentsStripSig = (rows, key) => `sig:${key}:${rows.length}`;
  subs.subagentsHtml = (rows, key) => `<div data-subs-turn="${key}">${rows.length}</div>`;
  subs.placedAgain = [];
  subs.applySubConsoleScrolls = (el) => subs.placedAgain.push(el);
}

test("a roster poll walks the page twice, not once or twice for every job", () => {
  roster({ jobs: 100, withRows: ["job-42"] });
  const box = doc.add(new Node({ "data-subs-turn": "job-42" }));
  box.dataset.sig = "sig:job-42:1"; // already showing what the roster says
  subs.paintSubagents();
  assert.equal(doc.queries, 0, "no per-job document lookup (was one or two for each of the 100 jobs)");
  assert.equal(doc.scans, 2, "one pass for the folded tallies, one for the strips");
  assert.deepEqual(subs.rowsAsked, ["job-42"], "and only a job with a strip on the page has its rows worked out");
});

test("a folded tally still moves, and a stale strip is repainted with its child consoles put back (control)", () => {
  roster({ jobs: 10, withRows: ["job-3", "job-5"] });
  const compact = doc.add(new Node({ "data-subs-compact": "job-3" }));
  const box = doc.add(new Node({ "data-subs-turn": "job-5" }));
  box.dataset.sig = "an older roster";
  Object.defineProperty(box, "outerHTML", {
    set(html) {
      box.remove();
      const key = /data-subs-turn="([^"]+)"/.exec(html)[1];
      doc.add(new Node({ "data-subs-turn": key }));
    },
  });
  subs.paintSubagents();
  assert.match(compact.innerHTML, /1 subagent \u00b7 1 running/, "the folded tally counts the child");
  const fresh = doc.nodes.find((n) => n.getAttribute("data-subs-turn") === "job-5");
  assert.notEqual(fresh, box, "the stale strip was replaced");
  assert.equal(fresh.dataset.sig, "sig:job-5:1", "and stamped with the roster it now shows");
  assert.deepEqual(subs.placedAgain, [fresh], "its open child consoles are put back in the same task");
});

test("a turn drawn twice is painted where the per-key lookup painted it: the first node (control)", () => {
  roster({ jobs: 10, withRows: ["job-7"] });
  const first = doc.add(new Node({ "data-subs-compact": "job-7" }));
  const second = doc.add(new Node({ "data-subs-compact": "job-7" }));
  subs.paintSubagents();
  assert.equal(first.writes, 1, "the first copy got the tally");
  assert.equal(second.writes, 0, "the second was not touched, as before");
});

// ---- refreshChips: a project's nodes are kept, and an unchanged strip is not rewritten ---------------------------
// The helpers are taken only where the file has them, so the same tests can be run against a build without them.
const has = (name) => src.includes(`function ${name}(`);
const chips = { document: doc, CSS, Map, String };
vm.createContext(chips);
let chipsLoaded = false;
function project() {
  if (!chipsLoaded) {
    const names = ["refreshChips", "refreshAgeToggle", "paintAgeToggle", ...(has("projectNode") ? ["projectNode"] : [])];
    vm.runInContext(names.map(grab).join("\n"), chips);
    chipsLoaded = true;
  }
  doc.reset();
  chips.html = "<span class=chip>3 worktrees</span>";
  chips.chipsHtml = () => chips.html;
  chips.ageSlotHtml = () => ""; // nothing held back: no arrow
  const strip = doc.add(new Node({ "data-chips": "alpha" }));
  const slot = doc.add(new Node({ "data-age-slot": "alpha" }));
  return { strip, slot };
}

test("the second refresh of a project asks the document nothing", () => {
  project();
  chips.refreshChips("alpha");
  const first = doc.queries;
  assert.ok(first >= 2, "the first refresh found the strip and the age slot");
  chips.refreshChips("alpha");
  assert.equal(doc.queries, first, "the next one used the nodes it had (was two or three lookups on every row placed)");
});

test("a strip that would read the same is not rewritten; one that changed is", () => {
  const { strip } = project();
  chips.refreshChips("alpha");
  chips.refreshChips("alpha");
  assert.equal(strip.writes, 1, "written once, then left alone while chipsHtml() returns the same");
  chips.html = "<span class=chip>4 worktrees</span>";
  chips.refreshChips("alpha");
  assert.equal(strip.writes, 2, "a different strip is written");
  assert.equal(strip.innerHTML, chips.html);
});

test("a section rebuilt from scratch is found again, never painted into a detached node (control)", () => {
  const { strip } = project();
  chips.refreshChips("alpha");
  strip.remove(); // renderAll() built the section again
  const rebuilt = doc.add(new Node({ "data-chips": "alpha" }));
  chips.refreshChips("alpha");
  assert.equal(rebuilt.innerHTML, chips.html, "the new strip carries the chips");
  const other = doc.add(new Node({ "data-chips": "beta" }));
  chips.refreshChips("beta");
  assert.equal(other.innerHTML, chips.html, "and each name keeps its own node");
});

// ---- pulseRow: the row from the map, the flash restarted without a forced layout ---------------------------------
let layoutReads = 0;
class Row extends Node {
  constructor(key, cls = []) {
    super({ "data-key": key }, { cls: ["row", ...cls] });
    this.animations = [];
  }
  get offsetWidth() {
    layoutReads += 1;
    return 1200;
  }
  getAnimations() {
    return this.animations.filter((a) => this.classes.has(a.cls));
  }
}
const pulse = { document: doc, CSS, Map, setTimeout: () => 1, clearTimeout: () => {} };
vm.createContext(pulse);
let pulseLoaded = false;
function boardRow(cls = [], running = null) {
  if (!pulseLoaded) {
    const names = ["pulseRow", ...["rowNode", "restartClassAnimation"].filter(has)];
    vm.runInContext(names.map(grab).join("\n"), pulse);
    pulseLoaded = true;
  }
  doc.reset();
  layoutReads = 0;
  const tr = new Row("alpha::C:/trees/one", cls);
  if (running) tr.animations.push({ cls: "flash", animationName: "flashrow", currentTime: running });
  doc.add(tr); // the row is on the page, and in the map placeRow keeps
  pulse.state = { rowEls: new Map([["alpha::C:/trees/one", tr]]) };
  pulse.flashRowMs = () => 900;
  return tr;
}

test("a pulse finds its row in the map and forces no layout", () => {
  const tr = boardRow();
  pulse.pulseRow("alpha::C:/trees/one");
  assert.ok(tr.classes.has("flash"), "the row flashes");
  assert.equal(layoutReads, 0, "with no forced layout (was `void tr.offsetWidth` on every pulse)");
  assert.equal(doc.queries, 0, "and no walk of the document for the row");
});

test("a pulse on a row already flashing puts that flash back to its first frame", () => {
  const tr = boardRow(["flash"], 640);
  pulse.pulseRow("alpha::C:/trees/one");
  assert.equal(tr.animations[0].currentTime, 0, "the running animation restarted");
  assert.ok(tr.classes.has("flash"));
  assert.equal(layoutReads, 0, "without taking the class off and laying the page out to see it gone");
});

test("a grey flash gives way to the green one, and only a just-ended flash pays the reflow (control)", () => {
  const grey = boardRow(["flash-idle"]);
  pulse.pulseRow("alpha::C:/trees/one");
  assert.ok(!grey.classes.has("flash-idle") && grey.classes.has("flash"), "the green flash replaced the grey one");
  const ended = boardRow(["flash"]); // the class is still on, its animation has finished
  pulse.pulseRow("alpha::C:/trees/one");
  assert.ok(ended.classes.has("flash"));
  assert.equal(layoutReads, 1, "the one case that still needs the class off, a layout, and the class back");
});

test("a row the map no longer holds is found in the document, as before (control)", () => {
  const tr = boardRow();
  tr.remove(); // replaced since the map was written
  const placed = doc.add(new Row("alpha::C:/trees/one"));
  pulse.pulseRow("alpha::C:/trees/one");
  assert.ok(placed.classes.has("flash"), "the live row flashed, not the detached one");
  assert.equal(doc.queries, 1);
});

// ---- the pulse dot: paused while it is off screen ------------------------------------------------------------------
function motionSlice() {
  const start = src.indexOf("const motionDots = new Set();");
  assert.ok(start >= 0, "public/app.js carries the off-screen motion watcher");
  const fn = src.indexOf("function watchMotion(", start);
  const end = src.indexOf("\n}\n", fn);
  return src.slice(start, end + 3);
}
function motionContext(withObserver = true) {
  const io = { observed: new Set(), callback: null };
  const ctx = { Set, Array };
  if (withObserver) {
    ctx.IntersectionObserver = class {
      constructor(cb) {
        io.callback = cb;
      }
      observe(el) {
        io.observed.add(el);
      }
      unobserve(el) {
        io.observed.delete(el);
      }
    };
  }
  vm.createContext(ctx);
  vm.runInContext(`${motionSlice()}\nthis.watchMotion = watchMotion;`, ctx);
  return { ctx, io };
}
class Dot extends Node {
  constructor() {
    super({}, { cls: ["pulse-dot"] });
    this.nodeType = 1;
  }
  matches(sel) {
    return sel === ".pulse-dot";
  }
}
function card(...dots) {
  return { nodeType: 1, matches: () => false, querySelectorAll: (sel) => (sel === ".pulse-dot" ? dots : []) };
}

test("a pulse dot is watched once, paused while off screen, and let go once it has left the page", () => {
  const { ctx, io } = motionContext();
  const a = new Dot();
  const b = new Dot();
  ctx.watchMotion(card(a, b));
  ctx.watchMotion(card(a));
  assert.equal(io.observed.size, 2, "each dot observed once, however often its card is seen");
  io.callback([{ target: a, isIntersecting: false }, { target: b, isIntersecting: true }]);
  assert.ok(a.classes.has("is-offscreen"), "the dot out of view is marked, which pauses it (style.css)");
  assert.ok(!b.classes.has("is-offscreen"), "the one in view keeps animating");
  io.callback([{ target: a, isIntersecting: true }]);
  assert.ok(!a.classes.has("is-offscreen"), "and it plays again as it scrolls back in");
  a.connected = false; // its card was rebuilt
  const c = new Dot();
  ctx.watchMotion(card(c));
  assert.deepEqual([...io.observed].sort((x, y) => (x === b ? -1 : 1)), [b, c], "the detached dot was let go when the next one arrived");
});

test("with no IntersectionObserver nothing is watched and nothing breaks (control)", () => {
  const { ctx } = motionContext(false);
  const a = new Dot();
  assert.doesNotThrow(() => ctx.watchMotion(card(a)));
  assert.ok(!a.classes.has("is-offscreen"));
});

test("the stylesheet pauses an off-screen dot, and only that", () => {
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /\.live-pulse \.pulse-dot\.is-offscreen \{ animation-play-state: paused; \}/);
});
