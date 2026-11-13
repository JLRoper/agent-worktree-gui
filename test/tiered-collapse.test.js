// Ctrl+[ folds ONE tier per press, from the lowest tier with anything open upward: turn bodies, then the agent
// cards, then the worktree rows, then the project sections, then the folder roots and the two fixed cards together.
// It used to call setEverythingOpen(false) and close all five at once — which is still what the header's
// "Collapse all" button does, because that is what its label promises.
//
// The selector and the gesture are driven out of public/app.js, not re-implemented: the tier region is sliced from
// the file, the fold bookkeeping it reads is the shipped bookkeeping, and only the page's paints and its four stores
// are stubs. Eight facts:
//
//   1. nextCollapseTier(state) names the lowest open tier, in the shipped order, and null when nothing is open;
//   2. it is pure: a hand-built state answers with no page, no DOM and no module state behind it;
//   3. five presses on a fully open board name five tiers and close exactly one each;
//   4. a press saves only the sets it wrote (turns and rows have no store: their fold is the session's);
//   5. a partial board closes its lowest open tier first;
//   6. the turns tier counts the default-open newest turn a card paints, so a card never hides an open body;
//   7. a fully closed board makes the press a no-op — never a fall-through into expanding;
//   8. the parent tiers arm the parent's cascade clock exactly as a click does (same key, same delay), it fires,
//      and no tier ever clears a child's fold;
//   9. the hotkey routes the left bracket to the tier gesture, keeps the focus guard, and the header title no
//      longer advertises Ctrl+[ as collapsing everything.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import vm from "node:vm";
import { sliceBetween, sliceRegion } from "../tools/panel-testkit.mjs";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
// The turn order, the conversation grouping and the fold book's three names moved to public/turns.js in step 4 of
// docs/reports/module-map-2026-11-07.html; the regions are sliced from the file that now carries them, and loaded
// into the same context as the tier region that calls them.
const turnsSource = readFileSync(new URL("../public/turns.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
// The turns tier delegates the "every turn, both copies" rule to public/core/turn-fold.js, so the module is part of
// the region's own code and is loaded into each context before the sliced regions that call it.
const foldSource = readFileSync(new URL("../public/core/turn-fold.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");

// ---- the fixture: one folder, two projects, three rows, four cards, one assistant ------------------------------
const PROJECTS = [
  { name: "app", path: "C:/Proj/app" },
  { name: "other", path: "C:/Proj/other" },
];
const ROWS = [
  { project: "app", path: "C:/Proj/app/.worktrees/one" },
  { project: "app", path: "C:/Proj/app/.worktrees/two" },
  { project: "other", path: "C:/Proj/other/.worktrees/solo" },
];
const ROW_ONE = "app::C:/Proj/app/.worktrees/one";
const ROW_SOLO = "other::C:/Proj/other/.worktrees/solo";
const ROW_KEYS = [ROW_ONE, "app::C:/Proj/app/.worktrees/two", ROW_SOLO];
const CARD_THREADS = ["t-one", "t-solo", "t-two", "t-homeless"];
const ASSISTANT_THREAD = "assistant-1";
const TURN_IDS = ["t-homeless", "t-one-a", "t-one-b", "t-solo", "t-two", ASSISTANT_THREAD];
const FIXED = ["newagent", "agents"];
const ROOT = "C:/Proj";

const at = (min) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
// One job per turn. `t-one` has two, so "the newest turn of a card" is a real choice rather than the only one.
const JOBS = [
  { id: "t-one-a", thread: "t-one", turn: 1, startedAt: at(0), ownerPath: "C:/Proj/app/.worktrees/one" },
  { id: "t-one-b", thread: "t-one", turn: 2, startedAt: at(5), ownerPath: "C:/Proj/app/.worktrees/one" },
  { id: "t-two", thread: "t-two", turn: 1, startedAt: at(10), ownerPath: "C:/Proj/app/.worktrees/two" },
  { id: "t-solo", thread: "t-solo", turn: 1, startedAt: at(15), ownerPath: "C:/Proj/other/.worktrees/solo" },
  { id: "t-homeless", thread: "t-homeless", turn: 1, startedAt: at(20), ownerPath: "C:/Proj/app" },
  { id: ASSISTANT_THREAD, thread: ASSISTANT_THREAD, turn: 1, startedAt: at(25), ownerPath: "" },
];

// ---- the shipped regions, in a page-shaped context ------------------------------------------------------------
// The state is the module's own (`state`), so the shipped `conversations()` groups the same jobs the fixture wrote.
// Everything that touches the page — the paints, the four stores, the document — is a stub that records.
function harness() {
  const state = {
    settings: { collapseAfterSeconds: 30 },
    scanRoots: [ROOT],
    projects: new Map(PROJECTS.map((p) => [p.name, p])),
    rows: new Map(ROWS.map((r) => [`${r.project}::${r.path}`, r])),
    jobs: new Map(JOBS.map((j) => [j.id, { ...j }])),
    turnOpen: new Map(),
    pinnedTurns: new Set(),
    expanded: new Set(),
    expandedProjects: new Set(),
    collapsedJobs: new Set(),
    collapsedRoots: new Set(),
    collapsedFixed: new Set(),
    collapseTimers: new Map(),
    detailEls: new Map(),
    assistant: { assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: ASSISTANT_THREAD }] },
    assistantThread: ASSISTANT_THREAD,
  };
  const saves = [];
  const painted = [];
  const expandedAll = [];
  const sandbox = {
    state,
    saveCollapsedJobs: () => saves.push(["jobs", [...state.collapsedJobs].sort()]),
    saveExpandedProjects: () => saves.push(["projects", [...state.expandedProjects].sort()]),
    saveCollapsedRoots: () => saves.push(["roots", [...state.collapsedRoots].sort()]),
    saveCollapsedFixed: () => saves.push(["fixed", [...state.collapsedFixed].sort()]),
    // The project toggle asks the page whether the narrowed board is up before it writes a fold (public/app.js
    // `toggleProject`). This harness is the full board, so the answer is no.
    focusModeOn: () => false,
    showBanner: () => {},
    setEverythingOpen: (open) => expandedAll.push(open),
    renderConversation: (thread) => painted.push(thread),
    renderJobs: () => painted.push("#jobs"),
    renderProjectRows: (name) => painted.push(`rows:${name}`),
    applyProjectCollapse: () => {},
    applyRootCollapse: () => {},
    applyFixedCollapse: () => {},
    paintRootButton: () => {},
    paintCollapseAll: () => painted.push("#collapse-all"),
    // No node stands for a card or a row here: every lookup answers null, which is the "not on the page" branch.
    document: { querySelector: () => null },
    CSS: { escape: (s) => String(s) },
    // A ready parent arms a real 30 s clock, and a test run must not sit on it: the handle is unref'd so the
    // process can end, while a tick under `mock.timers` still fires it.
    setTimeout: (fn, ms) => {
      const timer = globalThis.setTimeout(fn, ms);
      timer?.unref?.();
      return timer;
    },
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
  };
  const context = vm.createContext(sandbox);
  // The turns tier's own rule, in the same context as the regions that call it.
  vm.runInContext(foldSource, context);
  // The path/root helpers and the per-project toggle the project tier mirrors a click with.
  vm.runInContext(sliceBetween(source, "const normPath = (p) =>", "// ---- the collapse cascade"), context);
  vm.runInContext(sliceBetween(source, "function toggleProject(name) {", "// ---- folder layer"), context);
  // The cascade the parent tiers must not route around.
  vm.runInContext(sliceRegion(source, "the collapse cascade", "the collapse cascade"), context);
  // The constants the tiers read: the fixed cards, the turn order, the conversation grouping, the assistant test.
  vm.runInContext(sliceBetween(source, "const FIXED_CARDS =", "// Keep the row you clicked"), context);
  vm.runInContext(sliceBetween(turnsSource, "const turnOrder = (a, b) =>", "function turnSeqOf("), context);
  vm.runInContext(sliceBetween(turnsSource, 'function turnKey(turn, copy = "") {', "function turnIsOpen("), context);
  vm.runInContext(
    sliceBetween(source, "function assistantSessionFor(thread, board = state) {", "// ---------------- agents ----------------"),
    context,
  );
  // The region under test, straight out of the file.
  vm.runInContext(sliceRegion(source, "collapse one tier", "collapse one tier"), context);
  return {
    state,
    saves,
    painted,
    expandedAll,
    run: (code) => vm.runInContext(code, context),
    tier: () => vm.runInContext("nextCollapseTier(state)", context),
    press: () => vm.runInContext("collapseOneTier()", context),
    timers: () => [...state.collapseTimers.keys()].sort(),
    board: () => ({
      turnOpen: [...state.turnOpen].sort(([a], [b]) => String(a).localeCompare(String(b))),
      cards: [...state.collapsedJobs].sort(),
      rows: [...state.expanded].sort(),
      projects: [...state.expandedProjects].sort(),
      roots: [...state.collapsedRoots].sort(),
      fixed: [...state.collapsedFixed].sort(),
    }),
  };
}

// The board Ctrl+] leaves: every tier open, every turn explicitly open.
function fullyOpen() {
  const h = harness();
  for (const id of TURN_IDS) h.state.turnOpen.set(id, true);
  for (const thread of CARD_THREADS) h.state.collapsedJobs.delete(thread);
  for (const key of ROW_KEYS) h.state.expanded.add(key);
  for (const p of PROJECTS) h.state.expandedProjects.add(p.name);
  h.saves.length = 0;
  h.painted.length = 0;
  return h;
}

// A board whose three lower tiers are already shut: the only tier left open is the projects.
function belowProjects() {
  const h = harness();
  for (const id of TURN_IDS) h.state.turnOpen.set(id, false);
  for (const thread of CARD_THREADS) h.state.collapsedJobs.add(thread);
  h.state.expanded.clear();
  for (const p of PROJECTS) h.state.expandedProjects.add(p.name);
  h.saves.length = 0;
  h.painted.length = 0;
  return h;
}

const withTimers = (fn) => async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
};

// ---- 1. the order ----------------------------------------------------------------------------------------------
test("nextCollapseTier names the lowest open tier, in the shipped order", () => {
  assert.deepEqual(
    [...harness().run("COLLAPSE_TIERS")],
    ["turns", "cards", "rows", "projects", "folders"],
    "the tier order is the one the gesture documents",
  );
  const h = fullyOpen();
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    seen.push(h.tier());
    h.press();
  }
  assert.deepEqual(seen, ["turns", "cards", "rows", "projects", "folders"], "each press names the tier it took");
  assert.equal(h.tier(), null, "a closed board has no tier left");
});

// ---- 2. the selector is pure -----------------------------------------------------------------------------------
test("the selector answers from the state it is handed, with no page behind it", () => {
  // A context with no document, no conversations and no stubs — only the region's own functions and the fold module
  // they delegate the book to.
  const context = vm.createContext({});
  for (const code of [
    foldSource,
    sliceBetween(source, "const normPath = (p) =>", "// ---- the collapse cascade"),
    sliceBetween(source, "const FIXED_CARDS =", "// Keep the row you clicked"),
    sliceBetween(turnsSource, "const turnOrder = (a, b) =>", "function turnSeqOf("),
    sliceBetween(turnsSource, 'function turnKey(turn, copy = "") {', "function turnIsOpen("),
    sliceBetween(source, "function assistantSessionFor(thread, board = state) {", "// ---------------- agents ----------------"),
    sliceRegion(source, "collapse one tier", "collapse one tier"),
  ]) {
    vm.runInContext(code, context);
  }
  // Each board is built INSIDE the context, so the region reads a state object it was handed and nothing else.
  const tier = (body) => vm.runInContext(`(() => { ${body}; return nextCollapseTier(state); })()`, context);
  const base = `
    const state = {
      projects: new Map([["app", { name: "app", path: "C:/Proj/app" }]]),
      scanRoots: ["C:/Proj"],
      jobs: new Map([["turn-1", { id: "turn-1", thread: "t-one", turn: 1, startedAt: "2026-01-01T12:00:00Z" }]]),
      turnOpen: new Map(), collapsedJobs: new Set(), expanded: new Set(), expandedProjects: new Set(),
      collapsedRoots: new Set(["C:/Proj"]), collapsedFixed: new Set(["newagent", "agents"]),
      assistant: null, assistantThread: "assistant-1",
    };`;
  assert.equal(
    tier(`${base} state.turnOpen.set("turn-1", false); state.collapsedJobs.add("t-one")`),
    null,
    "everything shut: no tier",
  );
  const folded = `${base} state.turnOpen.set("turn-1", false); state.collapsedJobs.add("t-one");`;
  assert.equal(tier(base), "turns", "a card's newest turn is painted open unless its key says otherwise");
  assert.equal(tier(`${base} state.turnOpen.set("turn-1", false)`), "cards", "the turn folded, the card is next");
  assert.equal(tier(folded), null, "turns, cards and both folder sets shut: the board is closed");
  assert.equal(tier(`${folded} state.expanded.add("app::C:/Proj/app")`), "rows", "an open row outranks the projects");
  assert.equal(tier(`${folded} state.expandedProjects.add("app")`), "projects", "an open project outranks the folder");
  assert.equal(tier(`${folded} state.collapsedRoots.clear()`), "folders", "a bare folder still counts");
  assert.equal(tier(`${folded} state.collapsedFixed.clear()`), "folders", "the two fixed cards are the folder tier's other half");
});

// ---- 3. five presses, five tiers -------------------------------------------------------------------------------
test("a fully open board folds one tier per press, each named, and nothing else moves", () => {
  const h = fullyOpen();
  // What the board's fold book reads after each press: the four sets are the CLOSED members, so an empty set is a
  // tier still open and a full one is a tier just folded.
  const cards = [...CARD_THREADS].sort();
  const steps = [
    ["turns", { turnOpen: [], cards: [], rows: ROW_KEYS, projects: ["app", "other"], roots: [], fixed: [] }],
    ["cards", { cards, rows: ROW_KEYS, projects: ["app", "other"], roots: [], fixed: [] }],
    ["rows", { rows: [], projects: ["app", "other"], roots: [], fixed: [] }],
    ["projects", { projects: [], roots: [], fixed: [] }],
    ["folders", { roots: [ROOT], fixed: FIXED.slice().sort() }],
  ];
  for (const [i, [name, want]] of steps.entries()) {
    const closed = h.press();
    assert.equal(closed, name, `press ${i + 1} closes the ${name} tier`);
    const board = h.board();
    if (want.turnOpen) {
      assert.deepEqual([...board.turnOpen.map(([key]) => key)].sort(), TURN_IDS.slice().sort(), "every turn has an entry");
      assert.equal(board.turnOpen.every(([, open]) => open === false), true, "…and every one of them is folded");
    }
    if (want.cards) assert.deepEqual(board.cards, want.cards, `press ${i + 1}: the cards' fold set`);
    if (want.rows) assert.deepEqual(board.rows, want.rows, `press ${i + 1}: the rows' fold set`);
    if (want.projects) assert.deepEqual(board.projects, want.projects, `press ${i + 1}: the projects' fold set`);
    assert.deepEqual(board.roots, want.roots, `press ${i + 1}: the folders' fold set`);
    assert.deepEqual(board.fixed, want.fixed, `press ${i + 1}: the fixed cards' fold set`);
  }
  const closedBoard = h.board();
  assert.equal(closedBoard.turnOpen.every(([, open]) => open === false), true, "every turn is folded");
  assert.deepEqual(closedBoard.cards, cards, "every card is minimized");
  assert.deepEqual(closedBoard.rows, [], "no row is expanded");
  assert.deepEqual(closedBoard.projects, [], "no project is expanded");
  assert.deepEqual(closedBoard.roots, [ROOT], "the folder is folded");
  assert.deepEqual(closedBoard.fixed, FIXED.slice().sort(), "both fixed cards are folded");
});

test("a press saves only the sets it wrote, and repaints the header", () => {
  const h = fullyOpen();
  for (const [name, expected] of [
    ["turns", []],
    ["cards", [["jobs", [...CARD_THREADS].sort()]]],
    ["rows", []],
    ["projects", [["projects", []]]],
    [
      "folders",
      [
        ["roots", [ROOT]],
        ["fixed", FIXED.slice().sort()],
      ],
    ],
  ]) {
    h.saves.length = 0;
    h.painted.length = 0;
    assert.equal(h.press(), name);
    assert.deepEqual(
      h.saves,
      expected,
      `the ${name} press persists ${expected.length ? "only its own set" : "nothing (its fold is the session's)"}`,
    );
    assert.ok(h.painted.includes("#collapse-all"), `the ${name} press repaints the header button`);
  }
});

// ---- 4. a partial board ----------------------------------------------------------------------------------------
test("a partial board closes its lowest open tier first", () => {
  const h = harness();
  for (const id of TURN_IDS) h.state.turnOpen.set(id, false);
  for (const thread of CARD_THREADS) h.state.collapsedJobs.add(thread);
  h.state.expanded.add(ROW_SOLO);
  for (const p of PROJECTS) h.state.expandedProjects.add(p.name);
  assert.equal(h.tier(), "rows", "turns and cards are shut, so the row is the lowest open tier");
  const before = h.board();
  assert.equal(h.press(), "rows");
  const after = h.board();
  assert.deepEqual(after.rows, [], "the row closed");
  assert.deepEqual(after.projects, before.projects, "…and the projects are still open");
  assert.deepEqual(after.roots, before.roots, "…and the folder is still open");
  assert.deepEqual(after.cards, before.cards, "…and no card moved");
  assert.equal(h.tier(), "projects", "the next press moves up one tier");
});

// ---- 5. the turns tier counts the body the card paints ---------------------------------------------------------
test("the turns tier counts a card's default-open newest turn, and folds it by its key", () => {
  const h = harness();
  for (const thread of CARD_THREADS) h.state.collapsedJobs.delete(thread);
  assert.equal(h.tier(), "turns", "a board nobody has folded still paints each card's newest turn open");
  assert.equal(h.press(), "turns");
  assert.equal(h.state.turnOpen.get("t-one-b"), false, "the NEWEST turn of t-one is the one folded closed");
  assert.equal(h.tier(), "cards", "with every turn folded, the card is the lowest open tier");
});

// ---- 6. a closed board is a no-op ------------------------------------------------------------------------------
test("a fully closed board makes the press a no-op — never a fall-through into expanding", () => {
  const h = fullyOpen();
  const closed = [];
  for (let i = 0; i < 5; i += 1) closed.push(h.press());
  assert.deepEqual(closed, ["turns", "cards", "rows", "projects", "folders"]);
  const before = h.board();
  h.saves.length = 0;
  h.painted.length = 0;
  assert.equal(h.tier(), null, "nothing is open");
  assert.equal(h.press(), null, "the press returns no tier");
  assert.deepEqual(h.board(), before, "…and changes nothing");
  assert.deepEqual(h.saves, [], "…writes nothing");
  assert.deepEqual(h.painted, [], "…and does not even repaint");
  assert.deepEqual(h.expandedAll, [], "setEverythingOpen was never called: no fall-through into expanding");
});

// ---- 7. the cascade clock, and the child rule ------------------------------------------------------------------
test("a hotkey close arms the same parent clock a click arms", () => {
  const click = belowProjects();
  click.run('toggleProject("app")');
  click.run('toggleProject("other")');
  assert.deepEqual(click.timers(), ["project:app", "project:other"], "the click path's clocks");

  const hot = belowProjects();
  assert.equal(hot.press(), "projects");
  assert.deepEqual(hot.timers(), click.timers(), "the hotkey path arms the same clocks — same keys, same parents");
});

test(
  "the clock a hotkey close starts fires, and no tier clears a child's fold",
  withTimers(() => {
    const h = belowProjects();
    const cards = [...h.state.collapsedJobs].sort();
    h.state.turnOpen.set("t-one-a", false);
    const turns = [...h.state.turnOpen];
    assert.equal(h.press(), "projects");
    assert.deepEqual(h.timers(), ["project:app", "project:other"], "each closed project holds its own clock");
    assert.deepEqual([...h.state.collapsedJobs].sort(), cards, "closing the projects touched no card");
    assert.deepEqual([...h.state.turnOpen], turns, "closing the projects touched no turn");

    // A card arrives under app after the press (a fresh turn on one of its rows) — the clock sweeps what it finds,
    // exactly as a click's would.
    h.state.jobs.set("t-late", {
      id: "t-late",
      thread: "t-late",
      turn: 1,
      startedAt: at(30),
      ownerPath: "C:/Proj/app/.worktrees/two",
    });
    mock.timers.tick(29_000);
    assert.equal(h.state.collapsedJobs.has("t-late"), false, "one second short of the clock writes nothing");
    assert.deepEqual(h.timers(), ["project:app", "project:other"], "…and both clocks are still running");
    mock.timers.tick(1_000);
    assert.equal(h.state.collapsedJobs.has("t-late"), true, "30 s after the hotkey close, the parent's cascade wrote it");
    assert.deepEqual(h.timers(), [], "both clocks are spent");
    assert.deepEqual(h.saves.at(-1), ["jobs", [...h.state.collapsedJobs].sort()], "the cascade persisted the set it wrote");
  }),
);

test("the row and folder tiers arm their clocks and still leave every child alone", () => {
  const rows = harness();
  for (const id of TURN_IDS) rows.state.turnOpen.set(id, false);
  for (const thread of CARD_THREADS) rows.state.collapsedJobs.add(thread);
  const cards = [...rows.state.collapsedJobs];
  rows.state.expanded.add(ROW_ONE);
  rows.state.expanded.add(ROW_SOLO);
  assert.equal(rows.press(), "rows");
  assert.deepEqual(rows.timers(), [`row:${ROW_ONE}`, `row:${ROW_SOLO}`].sort(), "one clock per closed row");
  assert.deepEqual([...rows.state.collapsedJobs], cards, "the rows closed and no card moved");

  const folders = harness();
  for (const id of TURN_IDS) folders.state.turnOpen.set(id, false);
  for (const thread of CARD_THREADS) folders.state.collapsedJobs.add(thread);
  const keptCards = [...folders.state.collapsedJobs];
  assert.equal(folders.press(), "folders");
  assert.deepEqual(folders.timers(), ["fixed:agents", "fixed:newagent", `root:${ROOT}`], "a clock per folder and per fixed card");
  assert.deepEqual([...folders.state.collapsedJobs], keptCards, "folding the folders touched no card");
});

// ---- 8. the hotkey and the header title ------------------------------------------------------------------------
test("Ctrl+[ is the tier gesture, Ctrl+] still opens everything, and the focus guard stays", () => {
  const handler = source.slice(source.indexOf("// Ctrl+[ peels ONE tier"), source.indexOf('$("btn-fetch")'));
  assert.ok(handler.length > 200, "the hotkey handler is the region under test");
  assert.ok(
    source.includes('$("btn-collapse-all").addEventListener("click", () => toggleEverything())'),
    "the button keeps collapsing everything in one press",
  );
  assert.match(handler, /if \(collapse\) collapseOneTier\(\);/, "the left bracket folds one tier");
  assert.match(handler, /else setEverythingOpen\(true\);/, "the right bracket still opens everything");
  assert.ok(!handler.includes("toggleEverything"), "the hotkey never toggles: that is the button's gesture");
  assert.match(
    handler,
    /el\.isContentEditable \|\| \/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(el\.tagName\)/,
    "the focus guard still ignores a bracket typed in a field",
  );
  assert.ok(
    !/setEverythingOpen\(\s*open\s*\)\s*;/.test(source),
    "no caller is left answering both brackets with the old toggle",
  );
});

test("the header title no longer advertises Ctrl+[ as collapsing everything", () => {
  const start = source.indexOf("function paintCollapseAll()");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /in one press/, "the button says it is the one-press gesture");
  assert.match(body, /Ctrl\+\[ folds one tier per press/, "and says what the left bracket really does");
  assert.ok(!/— Ctrl\+\$\{open \? "\[" : "\]"}/.test(body), "the old `— Ctrl+[` promise is gone");
  const button = html.match(/<button id="btn-collapse-all"[^>]*title="([^"]+)"/);
  assert.ok(button, "the button exists in the page");
  assert.match(button[1], /in one press/, "the static title says one press too");
  assert.match(button[1], /Ctrl\+\[ folds one tier per press/, "…and the bracket's real meaning");
});
