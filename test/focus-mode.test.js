// The two gestures a double-click on the top bar must not disturb.
//
// The header gains one gesture: a double-click on the top bar toggles focus mode. Two existing paths sit beside it
// and neither may move:
//
//   1. the board's single-click fold of a project head (public/app.js, the document `click` listener's
//      `.project-head[data-toggle-project]` branch) - a single click on a head must still fold the project, and the
//      two clicks a double-click produces must never be read as a fold;
//   2. the model readout's own double-click (`[data-model-pick]`, its own document listener) - a single click on the
//      readout stays a single click, and its double-click must still open the list rather than be swallowed by the
//      header's handler.
//
// WHAT IS DRIVEN: the shipped registrations, sliced out of public/app.js and run in a vm. The click listener's whole
// body runs against a target that only the project head matches, so the test would fail if a branch above the fold
// started consuming that click. Nothing here is re-implemented.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");

// One registration's own source: from its opening line to the closing `});` at column 0. Every callback nested
// inside it is indented, so the first `\n});\n` after the start is the end of the listener. `anchor` picks the
// registration among several that open the same way (the page has more than one document click listener), by a
// line only the one under test carries.
function listenerSource(opening, anchor) {
  for (let at = app.indexOf(opening); at > 0; at = app.indexOf(opening, at + opening.length)) {
    const end = app.indexOf("\n});\n", at);
    assert.ok(end > at, `the registration ends at column 0: ${opening}`);
    const text = app.slice(at, end + 5);
    if (text.includes(anchor)) return text;
  }
  assert.fail(`app.js still carries the registration: ${opening} / ${anchor}`);
}

// A sandbox with just the page names a listener reaches on the target this test builds. `document.addEventListener`
// records the handler instead of registering it, so the test can dispatch the event itself.
function listenerHarness(source, stubs = {}) {
  const handlers = new Map();
  const ctx = {
    document: {
      addEventListener: (type, fn) => handlers.set(type, fn),
      querySelector: () => null,
    },
    CSS: { escape: (s) => String(s) },
    state: { pendingFocus: null, projectHues: new Map(), settings: {} },
    ...stubs,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, handlers };
}

function event(target, extra = {}) {
  const e = {
    target,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    prevented: 0,
    stopped: 0,
    preventDefault() {
      e.prevented += 1;
    },
    stopPropagation() {
      e.stopped += 1;
    },
    ...extra,
  };
  return e;
}

// A target that matches exactly the selectors the test says it does, and nothing else. That is what makes the whole
// click listener safe to run: every branch above the fold asks `closest` and gets null.
function targetMatching(matches) {
  return {
    closest(sel) {
      return Object.prototype.hasOwnProperty.call(matches, sel) ? matches[sel] : null;
    },
  };
}

// The fold's two shipped halves, in the page's own order: `foldProjectFromClick` and the document click listener that
// calls it. Sliced, not re-implemented, so the guard and the caller are both the page's.
function foldHarness() {
  const calls = [];
  const handlers = new Map();
  const ctx = {
    document: { addEventListener: (type, fn) => handlers.set(type, fn), querySelector: () => null },
    CSS: { escape: (s) => String(s) },
    state: { pendingFocus: null, projectHues: new Map(), settings: {} },
    keepInPlace: (_find, run) => run(),
    toggleProject: (name) => calls.push(name),
    revertEditOnClickAway: () => {},
    closeArtifactPops: () => {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(shipped(app, "function foldProjectFromClick(e) {", '\ndocument.addEventListener("click"'), ctx);
  vm.runInContext(listenerSource('document.addEventListener("click", async (e) => {', "foldProjectFromClick(e)"), ctx);
  return { ctx, handlers, calls };
}

test("a single click on a project head still folds that project", async () => {
  const head = { dataset: { toggleProject: "alpha" } };
  const { handlers, calls } = foldHarness();
  const click = handlers.get("click");
  assert.ok(click, "the board's click listener is registered on the document");

  const e = event(targetMatching({ ".project-head[data-toggle-project]": head }));
  await click(e);

  assert.deepEqual(calls, ["alpha"], "the press folded the project under the caret");
  assert.equal(e.prevented, 0, "the fold is the head's own only path; nothing above it claimed the press");
});

test("a double-click on the model readout opens the model list", async () => {
  const calls = [];
  const btn = { dataset: { modelPick: "opus" }, id: "readout" };
  const { handlers } = listenerHarness(listenerSource('document.addEventListener("dblclick", (e) => {', '[data-model-pick]'), {
    openModelPop: (thread, el) => calls.push([thread, el]),
    state: { pendingFocus: null, projectHues: new Map() },
  });
  const dbl = handlers.get("dblclick");
  assert.ok(dbl, "the model readout's double-click listener is registered on the document");

  const e = event(targetMatching({ "[data-model-pick]": btn }));
  dbl(e);

  assert.deepEqual(calls, [["opus", btn]], "the readout's own double-click still opens its list");
  assert.equal(e.prevented, 1, "and it still owns the event, as its comment promises");
});

test("a double-click that is not the model readout is left alone", () => {
  const calls = [];
  const { handlers } = listenerHarness(listenerSource('document.addEventListener("dblclick", (e) => {', '[data-model-pick]'), {
    openModelPop: (thread, el) => calls.push([thread, el]),
    state: { pendingFocus: null, projectHues: new Map() },
  });
  const e = event(targetMatching({}));
  handlers.get("dblclick")(e);

  assert.deepEqual(calls, [], "nothing opened");
  assert.equal(e.prevented, 0, "and nothing was consumed: a single click on the readout stays a single click");
});

// ---- the mode itself ----------------------------------------------------------------------------------------
//
// The predicate and the mode are driven from the shipped region (`// ---- focus mode` in public/app.js) plus the two
// functions it leans on that already exist: `normPath` from app.js and `turnLive`/`LIVE_STATUS` from
// board-scaffold.js. The page owns the state; this harness owns only the nodes and the repaints, so a change to the
// predicate or to `setFocusMode` is what a red test reports.

const scaffold = readFileSync(new URL("../public/board-scaffold.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");

function shipped(source, startMarker, endMarker) {
  const a = source.indexOf(startMarker);
  assert.ok(a >= 0, `the shipped source still carries: ${startMarker}`);
  const b = endMarker ? source.indexOf(endMarker, a + startMarker.length) : source.length;
  assert.ok(b > a, `the shipped source still ends at: ${endMarker}`);
  return source.slice(a, b);
}

// The tree a job carries, and the liveness read, exactly as the page has them.
const normPathSource = shipped(app, "const normPath = (p) =>", "\n");
const liveSource = shipped(scaffold, 'const LIVE_STATUS = new Set([', "\n// An approval is only a question");

class ClassList {
  constructor() {
    this.set = new Set();
  }
  toggle(name, on) {
    const want = on === undefined ? !this.set.has(name) : Boolean(on);
    if (want) this.set.add(name);
    else this.set.delete(name);
    return want;
  }
  add(name) {
    this.set.add(name);
  }
  remove(name) {
    this.set.delete(name);
  }
  contains(name) {
    return this.set.has(name);
  }
}

function rowKey(project, path) {
  return `${project}::${path}`;
}

// A page-shaped sandbox: the state the mode reads, and spies for every repaint it asks for. No DOM.
// `storedProjects` is `expandedProjects` when the reader's own folds matter to the test; by default every project is
// stored open, which is what the older tests assume.
function focusHarness({ jobs = [], rows = [], projects = [], expanded = [], storedProjects = null } = {}) {
  const seen = { banners: [], renders: [], chips: [], reorders: 0, cascades: 0, folds: [] };
  const sections = new Map();
  for (const name of projects) sections.set(name, { classList: new ClassList() });
  const bar = { title: "", dataset: {} };
  const rowNodes = new Map();
  const detailNodes = new Map();
  for (const key of expanded) {
    rowNodes.set(key, { classList: new ClassList() });
    detailNodes.set(key, { removed: false, remove() { this.removed = true; } });
  }
  const ctx = {
    state: {
      jobs: new Map(jobs.map((j, i) => [j.id || `job-${i}`, j])),
      rows: new Map(rows.map((r) => [rowKey(r.project, r.path), r])),
      projects: new Map(projects.map((p) => (typeof p === "string" ? [p, { name: p }] : [p.name, p]))),
      expanded: new Set(expanded),
      expandedProjects: new Set(storedProjects ?? projects),
      rowEls: rowNodes,
      detailEls: detailNodes,
      focusMode: false,
      focusSig: "",
    },
    document: {
      addEventListener: (type, fn) => ctx.handlers.set(type, fn),
      querySelector: (sel) => (sel === ".topbar" ? bar : null),
      body: { classList: new ClassList() },
    },
    handlers: new Map(),
    projectNode: (_attr, name) => sections.get(name) || null,
    renderProjectRows: (name) => seen.renders.push(name),
    refreshChips: (name) => seen.chips.push(name),
    reorderProjects: () => {
      seen.reorders += 1;
    },
    clearEveryCollapseCascade: () => {
      seen.cascades += 1;
    },
    showBanner: (text) => seen.banners.push(text),
    applyProjectCollapse: (name) => seen.folds.push(name),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(normPathSource, ctx);
  vm.runInContext(liveSource, ctx);
  vm.runInContext(sourceOfRegion(), ctx);
  return { ctx, seen, sections, bar, rowNodes, detailNodes };
}

function sourceOfRegion() {
  const begin = app.indexOf("// ---- focus mode");
  const end = app.indexOf("// ---- end focus mode");
  assert.ok(begin >= 0 && end > begin, "public/app.js still carries the focus-mode region");
  return app.slice(app.indexOf("\n", begin) + 1, end);
}

test("the predicate keeps a tree with one live panel and drops a tree with none", () => {
  const h = focusHarness({
    jobs: [
      { id: "live", status: "running", worktreePath: "/w/alpha" },
      { id: "idle", status: "done", worktreePath: "/w/beta" },
    ],
    rows: [
      { project: "p", path: "/w/alpha" },
      { project: "p", path: "/w/beta" },
    ],
  });
  const kept = vm.runInContext("liveFocusTrees()", h.ctx);
  assert.deepEqual([...kept], ["/w/alpha"], "alpha's one running panel is the whole kept set");
  assert.equal(vm.runInContext('focusKeepsRow({ path: "/w/alpha" })', h.ctx), true);
  assert.equal(vm.runInContext('focusKeepsRow({ path: "/w/beta" })', h.ctx), false);
  assert.equal(vm.runInContext('focusKeepsRow({ path: "/w/gamma" })', h.ctx), false, "no job, no row");
});

test("a job with neither a worktree path nor a worktree name is dropped", () => {
  const h = focusHarness({ jobs: [{ id: "plain", status: "running" }] });
  assert.equal(vm.runInContext('focusTreeOfJob({ status: "running" })', h.ctx), "", "no path, no tree");
  assert.equal(vm.runInContext("liveFocusTrees().size", h.ctx), 0, "a run in a plain checkout keeps nothing alive");
  assert.equal(vm.runInContext('focusKeepsRow({ path: "" })', h.ctx), false, "and an empty row path matches nothing");
});

// ---- a pathless run in a project's own checkout -------------------------------------------------------------
//
// A run that was NOT given a worktree works in the project's checkout, and carries no `worktreePath`. Two shapes of
// that record exist, and both have to keep the CHECKOUT row - and never a tree cut from it, whose directory has a name
// of its own:
//
//   * `worktree` names the project's folder (lib/jobs.js sets it from the directory the run was handed);
//   * neither a path nor a name is written, and the checkout is where the record's own `ownerPath` / `cwd` sit. That
//     is the shape the store actually writes for a run it cut nothing for: a live board was measured at 301 pathless
//     jobs, not one of them carrying a `worktree` name.

const FACTORY = { name: "factory", path: "C:/ProjectDevelopment/factory" };

test("a pathless job in a project's checkout keeps that project's checkout row", () => {
  const h = focusHarness({
    jobs: [{ id: "checkout", status: "running", worktreePath: null, worktree: "factory" }],
    rows: [
      { project: "factory", path: "C:/ProjectDevelopment/factory" },
      { project: "factory", path: "C:/ProjectDevelopment/factory/.worktrees/one" },
      { project: "other", path: "C:/ProjectDevelopment/other" },
    ],
    projects: [FACTORY, { name: "other", path: "C:/ProjectDevelopment/other" }],
  });
  const kept = vm.runInContext("liveFocusTrees()", h.ctx);
  assert.deepEqual([...kept], ["c:/projectdevelopment/factory"], "the checkout is the whole kept set");
  assert.equal(vm.runInContext('focusKeepsRow({ path: "C:/ProjectDevelopment/factory" })', h.ctx), true);
  assert.equal(
    vm.runInContext('focusKeepsRow({ path: "C:/ProjectDevelopment/factory/.worktrees/one" })', h.ctx),
    false,
    "a tree cut from the checkout is another row and keeps nothing",
  );
  assert.equal(vm.runInContext('focusKeepsRow({ path: "C:/ProjectDevelopment/other" })', h.ctx), false, "no run, no row");
});

test("a pathless job sitting on a project checkout keeps that row, in the shape the store writes", () => {
  const h = focusHarness({
    jobs: [
      {
        id: "checkout",
        status: "running",
        worktreePath: null,
        worktree: null,
        ownerPath: "C:/ProjectDevelopment/factory",
        cwd: "C:/ProjectDevelopment/factory",
        baseCheckout: true,
      },
    ],
    rows: [
      { project: "factory", path: "C:/ProjectDevelopment/factory" },
      { project: "factory", path: "C:/ProjectDevelopment/factory/.worktrees/one" },
    ],
    projects: [FACTORY],
  });
  assert.deepEqual([...vm.runInContext("liveFocusTrees()", h.ctx)], ["c:/projectdevelopment/factory"]);
  assert.equal(vm.runInContext('focusKeepsRow({ path: "C:/ProjectDevelopment/factory" })', h.ctx), true);
  assert.equal(
    vm.runInContext('focusKeepsRow({ path: "C:/ProjectDevelopment/factory/.worktrees/one" })', h.ctx),
    false,
    "the checkout is kept, and the tree cut from it is not",
  );
});

test("a pathless job whose own paths are inside a tree keeps nothing, not even the parent", () => {
  const h = focusHarness({
    jobs: [
      // The attach fallback's shape: the owner is the checkout that CONTAINS the run, the cwd is the tree itself.
      {
        id: "lost-tree",
        status: "running",
        worktreePath: null,
        ownerPath: "C:/ProjectDevelopment/factory",
        cwd: "C:/ProjectDevelopment/factory/.worktrees/one",
      },
    ],
    rows: [
      { project: "factory", path: "C:/ProjectDevelopment/factory" },
      { project: "factory", path: "C:/ProjectDevelopment/factory/.worktrees/one" },
    ],
    projects: [FACTORY],
  });
  assert.equal(vm.runInContext("liveFocusTrees().size", h.ctx), 0, "a run in a tree whose path went missing keeps no row");
  assert.equal(vm.runInContext('focusKeepsRow({ path: "C:/ProjectDevelopment/factory" })', h.ctx), false);
});

test("a pathless job whose worktree names no known project keeps nothing", () => {
  const h = focusHarness({
    jobs: [
      { id: "assistant", status: "running", assistant: true, worktreePath: null, worktree: "assistant-cwd" },
      { id: "bare", status: "running", assistant: true, worktreePath: null },
    ],
    rows: [{ project: "factory", path: "C:/ProjectDevelopment/factory" }],
    projects: [FACTORY],
  });
  assert.deepEqual(
    [...vm.runInContext('focusCheckoutTreesOfJob({ assistant: true, worktree: "assistant-cwd" })', h.ctx)],
    [],
    "the assistant's own cwd names no project on the board",
  );
  assert.deepEqual(
    [...vm.runInContext("focusCheckoutTreesOfJob({ assistant: true })", h.ctx)],
    [],
    "no name at all keeps nothing",
  );
  assert.equal(vm.runInContext("liveFocusTrees().size", h.ctx), 0, "neither assistant run keeps the checkout row alive");
  assert.equal(vm.runInContext('focusKeepsRow({ path: "C:/ProjectDevelopment/factory" })', h.ctx), false);
});

test("a pathless job naming a directory a tree was cut into keeps nothing", () => {
  const h = focusHarness({
    jobs: [{ id: "child-dir", status: "running", worktreePath: null, worktree: "one" }],
    rows: [
      { project: "factory", path: "C:/ProjectDevelopment/factory" },
      { project: "factory", path: "C:/ProjectDevelopment/factory/.worktrees/one" },
    ],
    projects: [FACTORY],
  });
  assert.equal(
    vm.runInContext("liveFocusTrees().size", h.ctx),
    0,
    "a child row's directory name is not a project: it never keeps the child row, and it never keeps the checkout",
  );
});

test("the match is the whole tree path, not a substring of one", () => {
  const h = focusHarness({
    jobs: [{ id: "live", status: "running", worktreePath: "/w/alpha" }],
    rows: [
      { project: "p", path: "/w/alpha" },
      { project: "p", path: "/w/alpha-two" },
      { project: "p", path: "/w/alpha/sub" },
      { project: "p", path: "/w/alphabet" },
      { project: "p", path: "/w/alph" },
    ],
  });
  const kept = vm.runInContext("liveFocusTrees()", h.ctx);
  const rows = vm.runInContext("state.rows", h.ctx);
  const keptPaths = [...rows.values()].filter((r) => vm.runInContext("focusKeepsRow", h.ctx)(r, kept)).map((r) => r.path);
  assert.deepEqual(keptPaths, ["/w/alpha"], "only the tree itself is kept: a prefix, a child and a suffix are other trees");
});

test("the same tree written with backslashes, a trailing slash or another case still matches", () => {
  const h = focusHarness({
    jobs: [{ id: "live", status: "running", worktreePath: "\\w\\Alpha\\" }],
    rows: [{ project: "p", path: "/w/alpha" }],
  });
  assert.equal(vm.runInContext('focusKeepsRow({ path: "/w/alpha" })', h.ctx), true);
});

test("a job still parked on an approval keeps its tree", () => {
  const h = focusHarness({
    jobs: [{ id: "held", status: "waiting", approval: { id: "a1" }, worktreePath: "/w/held" }],
    rows: [{ project: "p", path: "/w/held" }],
  });
  assert.equal(vm.runInContext('focusKeepsRow({ path: "/w/held" })', h.ctx), true);
});

test("a double-click on the header bar toggles focus mode, and off again", () => {
  const h = focusHarness({
    jobs: [{ id: "live", status: "running", worktreePath: "/w/alpha" }],
    rows: [{ project: "alpha", path: "/w/alpha" }],
    projects: ["alpha"],
  });
  const dbl = h.ctx.handlers.get("dblclick");
  assert.ok(dbl, "the region registers the header's double-click on the document");
  const barTarget = targetMatching({ ".topbar": h.bar });

  const on = event(barTarget);
  dbl(on);
  assert.equal(h.ctx.state.focusMode, true, "the first double-click is the mode on");
  assert.equal(h.ctx.document.body.classList.contains("focus-mode"), true, "and the page says so");
  assert.match(h.seen.banners.at(-1), /^focus mode: only worktrees/, "the banner names the gesture that leaves it");
  assert.ok(h.seen.renders.includes("alpha"), "the project was repainted under the new mode");

  dbl(event(barTarget));
  assert.equal(h.ctx.state.focusMode, false, "the next double-click is the mode off");
  assert.equal(h.ctx.document.body.classList.contains("focus-mode"), false);
  assert.match(h.seen.banners.at(-1), /^focus mode off/);
});

test("entry to the mode folds the open rows' nodes and leaves the reader's record alone", () => {
  const keys = ["alpha::/w/alpha", "beta::/w/beta"];
  const h = focusHarness({
    jobs: [{ id: "live", status: "running", worktreePath: "/w/alpha" }],
    rows: [
      { project: "alpha", path: "/w/alpha" },
      { project: "beta", path: "/w/beta" },
    ],
    projects: ["alpha", "beta"],
    expanded: keys,
  });
  assert.equal(h.ctx.state.expanded.size, 2, "two rows are open going in");
  // The mode deletes its entries from detailEls as it folds them, so hold the nodes themselves: the record is the
  // assertion, not the map.
  const details = keys.map((k) => h.detailNodes.get(k));
  const rows = keys.map((k) => h.rowNodes.get(k));

  vm.runInContext("setFocusMode(true)", h.ctx);

  assert.deepEqual([...h.ctx.state.expanded], keys, "the reader's record of what was open is untouched");
  assert.equal(details[0].removed, true, "the open row's detail left the page");
  assert.equal(details[1].removed, true);
  assert.equal(rows[0].classList.contains("expanded"), false, "and no row is drawn open");
  assert.equal(vm.runInContext('rowDrawsOpen("alpha::/w/alpha")', h.ctx), false, "the mode draws every row minimized");
  assert.equal(h.seen.cascades, 1, "a fold that was already in flight does not undo it");

  vm.runInContext("setFocusMode(false)", h.ctx);
  assert.equal(vm.runInContext('rowDrawsOpen("alpha::/w/alpha")', h.ctx), true, "the row the reader had open comes back");
  assert.deepEqual([...h.ctx.state.expanded], keys, "and the record never moved");
});

test("a project holding a live row is drawn expanded while the mode is on, and the fold written is none", () => {
  const h = focusHarness({
    jobs: [{ id: "live", status: "running", worktreePath: "/w/beta" }],
    rows: [
      { project: "alpha", path: "/w/alpha" },
      { project: "beta", path: "/w/beta" },
      { project: "gamma", path: "/w/gamma" },
    ],
    projects: ["alpha", "beta", "gamma"],
    // The reader had alpha open and beta and gamma folded: the case the mode used to hide.
    storedProjects: ["alpha"],
  });
  assert.equal(vm.runInContext('projectDrawsOpen("beta")', h.ctx), false, "nothing is forced while the mode is off");

  vm.runInContext("setFocusMode(true)", h.ctx);

  assert.equal(vm.runInContext('projectDrawsOpen("beta")', h.ctx), true, "the project holding the live row draws expanded");
  assert.equal(vm.runInContext('projectDrawsOpen("alpha")', h.ctx), true, "the reader's own open project stays open");
  assert.equal(vm.runInContext('projectDrawsOpen("gamma")', h.ctx), false, "a folded project with no live row stays folded");
  assert.deepEqual([...h.ctx.state.expandedProjects], ["alpha"], "not one project fold was written");
  assert.ok(h.seen.folds.includes("beta"), "the section was re-applied with the fold its rows were built on");

  vm.runInContext("setFocusMode(false)", h.ctx);

  assert.equal(vm.runInContext('projectDrawsOpen("beta")', h.ctx), false, "the stored fold is what the board draws again");
  assert.deepEqual([...h.ctx.state.expandedProjects], ["alpha"], "still the reader's own layout");
});

test("a project with no surviving row is hidden, and comes back when the mode goes off", () => {
  const h = focusHarness({
    jobs: [{ id: "live", status: "running", worktreePath: "/w/alpha" }],
    rows: [
      { project: "alpha", path: "/w/alpha" },
      { project: "beta", path: "/w/beta" },
      { project: "gamma", path: "/w/gamma" },
    ],
    projects: ["alpha", "beta", "gamma"],
  });
  vm.runInContext("paintFocusSections()", h.ctx);
  assert.equal(h.sections.get("beta").classList.contains("is-focus-out"), false, "nothing is hidden while the mode is off");

  vm.runInContext("setFocusMode(true)", h.ctx);

  assert.equal(h.sections.get("alpha").classList.contains("is-focus-out"), false, "the project with the live panel stays");
  assert.equal(h.sections.get("beta").classList.contains("is-focus-out"), true, "a project with no live tree is hidden");
  assert.equal(h.sections.get("gamma").classList.contains("is-focus-out"), true);

  vm.runInContext("setFocusMode(false)", h.ctx);
  for (const name of ["alpha", "beta", "gamma"]) {
    assert.equal(h.sections.get(name).classList.contains("is-focus-out"), false, `${name} is drawn again`);
  }
});

test("the header's double-click leaves the model readout and the bar's own controls alone", () => {
  const h = focusHarness({ projects: [] });
  const dbl = h.ctx.handlers.get("dblclick");
  const readout = targetMatching({ "[data-model-pick]": { dataset: { modelPick: "opus" } } });
  const e = event(readout);
  dbl(e);
  assert.equal(h.ctx.state.focusMode, false, "the readout's double-click is not the header's gesture");
  assert.equal(e.prevented, 0, "and this handler did not consume it");

  const control = { dataset: {} };
  const insideButton = {
    closest(sel) {
      if (sel === ".topbar") return h.bar;
      if (sel === "button, a, input, select, textarea, label, #title-settings") return control;
      return null;
    },
  };
  const c = event(insideButton);
  dbl(c);
  assert.equal(h.ctx.state.focusMode, false, "a double-click on Assistant/Settings is that control's own");
  assert.equal(c.prevented, 0);
});

test("the header's listener is registered after the model readout's", () => {
  const model = app.indexOf('document.addEventListener("dblclick", (e) => {');
  const header = app.indexOf('document.addEventListener("dblclick", onHeaderDoubleClick);');
  assert.ok(model > 0 && header > model, "the readout's listener keeps the registration it had, and runs first");
});

test("a click inside the top bar is never a project fold", async () => {
  const bar = { dataset: {} };
  // A target inside the top bar that would match a project head if asked: the shape the guard exists for.
  const target = {
    closest(sel) {
      if (sel === ".topbar") return bar;
      if (sel === ".project-head[data-toggle-project]") return { dataset: { toggleProject: "alpha" } };
      return null;
    },
  };
  const { handlers: registered, calls } = foldHarness();

  const e = event(target);
  await registered.get("click")(e);

  assert.deepEqual(calls, [], "the first click of the header's double-click did not fold anything");
});
