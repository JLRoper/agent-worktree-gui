// The worktree row's TURNOVER mark, as the page draws it (public/render-projects.js `rowHtml`).
//
// A project may name a turnover branch - the head line's fourth chip, `turnoverFor` in public/board-scaffold.js, is the
// one read and `/api/project-turnover` the one write. It is the branch a tree cut for that project starts from, and the
// branch its work rolls back into, so a row standing ON it is where children are cut from at will.
//
// That is a DIFFERENT fact from the lock, which says "nothing may delete this worktree": a tree can be on the turnover
// branch, locked, both or neither. The row says it twice, so neither reading is the only one available - the name is
// drawn blue at a glance, and a marker beside the lock carries a shape, a tooltip and an aria-label with the sentence.
//
// The row is read out of the page and run with stubs, like test/ahead-behind-cell.test.js: no browser, no board.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const projects = readFileSync(new URL("../public/render-projects.js", import.meta.url), "utf8");
const charts = readFileSync(new URL("../public/charts.js", import.meta.url), "utf8");
const board = readFileSync(new URL("../public/board-scaffold.js", import.meta.url), "utf8");

// The page's own text, cut from the file that declares each half: the row template from the renderer, the turnover read
// from the module whose chip writes the same field. `turnoverFor` is included rather than re-written here, so a row
// that stopped reading the configured value (and matched a branch name's shape instead) would fail these tests.
const columnsCode = sliceBetween(charts, "const CHART_COLUMNS = [", "\nconst WT_COLS");
const turnoverForCode = sliceBetween(board, "function turnoverFor(name) {", "// Which BASE-REF KIND");
const rowCode = sliceBetween(projects, "function rowHtml(row, forceOwner = false) {", "// ---- the age column");

const CHART_COLUMNS = new Function(`${columnsCode}; return CHART_COLUMNS;`)();

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const keyOf = (project, p) => `${project}::${p}`;

const TURNOVER = "20261112_0900_WAG-1_the-turnover-branch";
const OTHER = "wtgui/plain-aaaaaa";
const SAY = "the turnover branch for this project - assistants may cut child worktrees from it at will";

// The row template, with the twelve cells' own builders stubbed: this file is about the name cell and the marker, not
// about the PR, verdict, life or owner cells those builders draw.
function harness({ turnoverBranch = TURNOVER } = {}) {
  const ctx = {
    state: {
      expanded: new Set(),
      projects: new Map([["demo", { name: "demo", turnoverBranch }]]),
    },
    esc,
    keyOf,
    // The page's own answer for "is this row drawn open" (public/app.js). With focus mode off it is the stored set,
    // which is the state this harness builds; the renderer reads it instead of the set directly so one fold answer
    // covers the board and the narrowed board both.
    rowDrawsOpen: (k) => ctx.state.expanded.has(k),
    prCellHtml: () => "",
    verdictHtml: () => "",
    isProjectRootRow: () => false,
    treeTitleOf: () => "",
    agentBadgeHtml: () => "",
    deletableWithoutAsking: () => false,
    shownColumns: () => CHART_COLUMNS.map((_, i) => i),
    branchCellHtml: () => "",
    ownerCellHtml: () => "",
    aheadBehindCellHtml: () => "",
    lifeCellHtml: () => "<td></td>",
    nextReadCellHtml: () => "<td></td>",
  };
  const { rowHtml } = new Function(
    "ctx",
    `const { state, esc, keyOf, rowDrawsOpen, prCellHtml, verdictHtml, isProjectRootRow, treeTitleOf, agentBadgeHtml,
             deletableWithoutAsking, shownColumns, branchCellHtml, ownerCellHtml, aheadBehindCellHtml,
             lifeCellHtml, nextReadCellHtml } = ctx;
     ${turnoverForCode}
     ${columnsCode}
     ${rowCode}
     return { rowHtml };`,
  )(ctx);
  return {
    rowHtml,
    setTurnover: (value) => {
      ctx.state.projects.get("demo").turnoverBranch = value;
    },
  };
}

const rowOf = (over = {}) => ({
  project: "demo",
  path: "/repo/demo/.worktrees/a-tree-aaaaaa",
  name: "a-tree-aaaaaa",
  branch: TURNOVER,
  head: "abc1234",
  ahead: 0,
  behind: 0,
  cherryPlus: 0,
  cherryMinus: 0,
  dirty: 0,
  untracked: 0,
  ...over,
});

// The name span: its extra classes, its other attributes, and the name it writes.
const nameSpan = (html) => /<span class="row-name([^"]*)"([^>]*)>([^<]*)<\/span>/.exec(html);
// The turnover marker's own tag and glyph.
const marker = (html) => /<span class="turnover-mark"[^>]*>([^<]*)<\/span>/.exec(html);
// This worktree's lock button (the one beside the name - the branch's own lock sits in the branch cell).
const treeLock = (html) => {
  const m = /<button class="btn-row-lock([^"]*)" type="button" data-lock-scope="tree"[\s\S]*?<\/button>/.exec(html);
  if (!m) return null;
  const tag = m[0];
  const pressed = /aria-pressed="([^"]*)"/.exec(tag);
  return {
    html: tag,
    classes: m[1],
    pressed: pressed ? pressed[1] : "",
    locked: tag.includes("\u{1F512}"),
    unlocked: tag.includes("\u{1F513}"),
  };
};
const blueName = (html) => /style="color:var\(--blue\)"/.test(nameSpan(html)[2]);

test("a row standing on the project's turnover branch draws the marker and the blue name", () => {
  const { rowHtml } = harness();
  const html = rowHtml(rowOf({ branch: TURNOVER }));

  const mark = marker(html);
  assert.ok(mark, "the row carries a turnover marker beside the lock");
  assert.equal(mark[1], "\u21c4", "the marker is its own shape, not the lock's");

  const name = nameSpan(html);
  assert.ok(name, "the row draws its name");
  assert.match(name[1], /\bis-turnover\b/, "the name says which row it is without reading the colour");
  assert.match(name[2], /style="color:var\(--blue\)"/, "the name is drawn in the panel's blue");
  assert.equal(name[3], "a-tree-aaaaaa", "the blue is on the NAME, not the whole cell");
});

test("an ordinary row draws neither the marker nor the blue name, and the same row does once the project names it", () => {
  const { rowHtml, setTurnover } = harness();
  const plain = rowHtml(rowOf({ branch: OTHER }));

  assert.equal(marker(plain), null, "a row on another branch carries no turnover marker");
  const name = nameSpan(plain);
  assert.doesNotMatch(name[1], /is-turnover/, "and no turnover class");
  assert.doesNotMatch(name[2], /color:var\(--blue\)/, "and no blue of its own: the row keeps the chart's own ink");
  assert.equal(blueName(plain), false);

  // The positive half, in the same fixture: the marker follows the CONFIGURED branch, not the shape of a branch name.
  // Naming the ordinary row's branch as the turnover branch moves the mark onto it and off the old one.
  setTurnover(OTHER);
  assert.ok(marker(rowHtml(rowOf({ branch: OTHER }))), "the configured branch is what marks the row");
  assert.equal(marker(rowHtml(rowOf({ branch: TURNOVER }))), null, "and the branch it replaced is no longer marked");
  assert.equal(blueName(rowHtml(rowOf({ branch: OTHER }))), true);
});

test("the lock keeps its own state in both cases: the turnover mark never reads it and the lock stays yellow", () => {
  const { rowHtml } = harness();
  const cases = [
    { branch: TURNOVER, lock: { tree: true, line: "locked by hand" }, locked: true, mark: true },
    { branch: TURNOVER, lock: null, locked: false, mark: true },
    { branch: OTHER, lock: { tree: true, line: "locked by hand" }, locked: true, mark: false },
    { branch: OTHER, lock: null, locked: false, mark: false },
  ];
  for (const c of cases) {
    const html = rowHtml(rowOf({ branch: c.branch, lock: c.lock }));
    const lock = treeLock(html);
    assert.ok(lock, `the lock button is drawn (branch ${c.branch}, locked ${c.locked})`);
    assert.equal(lock.locked, c.locked, `the lock's own glyph follows its own bit (branch ${c.branch})`);
    assert.equal(lock.unlocked, !c.locked, "and the other state's glyph is absent");
    assert.equal(lock.pressed, c.locked ? "true" : "false", "aria-pressed follows the same bit");
    assert.equal(lock.classes.includes("is-locked"), c.locked, "so does the button's own class");
    // The lock is not repainted by the turnover mark: no turnover class, no colour of its own. A locked row's amber
    // name still comes from the stylesheet, and the blue wins only on a turnover row.
    assert.doesNotMatch(lock.html, /turnover/, "the lock carries no turnover state");
    assert.doesNotMatch(lock.html, /color:/, "and no colour of its own: its ink is the row's, as before");
    assert.equal(Boolean(marker(html)), c.mark, `the marker follows the branch, not the lock (locked ${c.locked})`);
    assert.equal(blueName(html), c.branch === TURNOVER, "so does the blue name");
  }
});

test("the marker's tooltip and aria-label name it the turnover branch and say children may be cut from it", () => {
  const { rowHtml } = harness();
  const mark = marker(rowHtml(rowOf({ branch: TURNOVER })))[0];

  const title = /title="([^"]*)"/.exec(mark);
  const aria = /aria-label="([^"]*)"/.exec(mark);
  assert.ok(title, "the marker carries a tooltip");
  assert.ok(aria, "and an aria-label");
  assert.equal(title[1], SAY);
  assert.equal(aria[1], SAY);
  assert.match(aria[1], /turnover branch/, "the label says what it is");
  assert.match(aria[1], /may cut child worktrees from it at will/, "and what assistants may do with it");
});
