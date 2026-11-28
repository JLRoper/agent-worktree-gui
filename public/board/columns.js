// board/columns.js - the chart's column widths, the fit and the grips, cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is the file six open queue rows claimed at 2026-11-28. This is
// cut 7 of the eight in docs/reports/module-separation-2026-11-28.html, section 5's card for
// public/app.js: "natural widths, the column plan, the grips and the fit". Moved line for line: not
// one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the widths store        COL_WIDTHS_KEY, COL_WIDTHS_INSERTIONS, loadColWidths, colWidths and
//                           saveColWidths: what this browser remembers about the chart's columns.
//   the plan                headerCells, naturalColumnWidths, columnPlan, WT_SCROLL, fitTarget,
//                           columnSigs, columnSignature, fitColumns, pendingFits, fitScheduled,
//                           scheduleColumnFit and fitAllColumns: the natural width of each column,
//                           the plan that fits them into the room the page has, and the signatures
//                           that keep a fit from running twice for the same table.
//   the grips               colDrag and installColumnGrips: the grip on each header edge. The drag
//                           itself (beginColumnDrag, dragColumn, endColumnDrag) stays in app.js; it
//                           reads the same `colDrag` binding, which is page-wide either way.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.rows, state.projects, state.jobs, state.expanded, document, localStorage
//                           the stores the plan reads to know what each column holds.
//   esc, keyOf (core/dom-format.js), and public/app.js's own $, showNote, showBanner,
//   renderProjectRows, placeRow, refreshChips and the row width classes.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a
// top-level `function` here is a window property and a top-level `let` (colWidths, fitScheduled,
// colDrag) is a binding every other script reads by bare name. index.html loads this file before
// app.js, and the file DECLARES ONLY - nothing here reads a `state` field or an app.js binding while
// it loads - so sitting before app.js costs nothing and cannot land in a temporal dead zone.
// public/app.js re-exports these names on window.WMApp.columns, which is the door public/charts.js,
// public/render-projects.js and public/settings.js already reach for.
//
// RE-MEASURED FROM 3bb43694. The report's card names 9,846-10,056. On this base it is 4,882-5,147: the
// report's row began at naturalColumnWidths, which would have left the widths store and the header
// cells that plan is computed from in app.js; the cut takes them with it, which is the same surface
// plus the four declarations it reads first.

const COL_WIDTHS_KEY = "wtgui.colWidths";
// Where each column that was added AFTER this storage existed sits, and how many entries a saved list has when that
// column was not there yet. A stored width list is positional, so an inserted column is one entry MISSING and every
// entry after the insertion point belongs to the column before it: each entry below splices its empty slot in, in
// age order, so a hand-set name or branch width stays on the column the reader gave it to. This used to be one
// constant for `reviewedExtra`; the Kind column is a second insertion at a different point, and a single index would
// have shifted the oldest lists in the wrong place. `null` is "measure this one", so a new column needs no width.
const COL_WIDTHS_INSERTIONS = [
  { id: "reviewedExtra", writtenBefore: 13 }, // name, branch, assistant, initiative, tip, ahead, cherry, pr, dirty, life, nextread, verdict, actions
  { id: "kind", writtenBefore: 14 }, // the same list with reviewedExtra in it: name .. nextread, verdict, actions
];

function loadColWidths() {
  const out = new Array(WT_COLS).fill(null);
  try {
    const raw = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || "[]");
    let saved = Array.isArray(raw) ? raw : [];
    for (const { id, writtenBefore } of COL_WIDTHS_INSERTIONS) {
      const at = CHART_COLUMNS.findIndex((c) => c.id === id);
      if (at > 0 && saved.length === writtenBefore) saved = [...saved.slice(0, at), null, ...saved.slice(at)];
    }
    for (let i = 0; i < WT_COLS; i += 1) if (Number.isFinite(saved[i]) && saved[i] > 0) out[i] = Math.round(saved[i]);
  } catch {
    /* a corrupt value is the same as none */
  }
  return out;
}
let colWidths = loadColWidths();

function saveColWidths() {
  try {
    localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths));
  } catch {
    /* private mode: the widths just do not persist */
  }
}

function headerCells(table) {
  return table?.tHead?.rows?.[0] ? [...table.tHead.rows[0].cells] : [];
}

// What each column would be with nothing constraining it: the header text and every cell below it, chips and
// buttons included. Measured on a COPY of the header and the worktree rows, laid out at max-content beside the real
// table for one synchronous step and taken out again before the frame paints.
//
// Never on the real table. Its detail rows hold the agent cards, and a `white-space: pre-wrap` transcript laid out at
// max-content has no line breaks at all: a paragraph that wraps over five lines is one line, so for that one layout
// every console in the table was a fraction of its height. The browser clamps a scroll offset that no longer fits; the
// styles went back, the transcript was tall again, and the offset was not. A console following its run was painted
// near its first lines until the next streamed line or the 400 ms sweep put it back - the console that "bounces up and
// quickly back down in a split second" - and a console the reader had parked stayed wherever the clamp left it, the
// place they lost "somewhere else in the scrollbar". Every row repaint ends in a measurement (scheduleColumnFit) and a
// streaming transcript changes the table's text, so it was every few seconds (tools/verify-console-column-fit.mjs: 18
// of 18 measurements in 30 s moved a console, by 604-1139 px). A spanning row is not a column's content either: its
// unwrapped transcript used to be shared out over the columns it spans, so the split moved with what agents wrote.
function naturalColumnWidths(table) {
  const ths = headerCells(table);
  if (!ths.length || !table.parentNode) return ths.map(() => 0);
  // The copy keeps the table's own classes and inline style (its min-width in sideways-scroll mode), and sits in the
  // same wrapper, so every selector that sizes a header or a cell sizes it the same way. Only the worktree rows go in:
  // the detail and confirmation rows span every column and stand for none of them.
  const probe = table.cloneNode(false);
  if (table.tHead) probe.appendChild(table.tHead.cloneNode(true));
  const body = document.createElement("tbody");
  for (const tb of table.tBodies) {
    for (const tr of tb.rows) if (tr.classList.contains("row")) body.appendChild(tr.cloneNode(true));
  }
  probe.appendChild(body);
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.left = "0";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.tableLayout = "auto";
  probe.style.width = "max-content";
  const cells = headerCells(probe);
  for (const th of cells) th.style.width = "";
  table.parentNode.insertBefore(probe, table.nextSibling);
  const natural = cells.map((th) => Math.ceil(th.getBoundingClientRect().width));
  probe.remove();
  return natural;
}

// What the columns want turned into what they get, in px, adding up to the table's own width. `cols` is the shown
// subset of CHART_COLUMNS (indexes), so `natural`, `want` and `room` are POSITIONS on screen while the floors, the
// squeeze weights and a hand-set width are looked up by the column's stable id-position in CHART_COLUMNS. Hiding a
// column therefore neither renames a remembered width nor moves the floor onto its neighbour.
function columnPlan(natural, total, cols = CHART_COLUMNS.map((_, i) => i)) {
  const fixed = cols.map((i) => colWidths[i] != null);
  const want = natural.map((n, k) => (fixed[k] ? colWidths[cols[k]] : Math.max(COL_MIN[cols[k]], n)));
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  let spare = total - sum(want);
  if (spare > 0) {
    // Spare room belongs to the columns whose text truncates: 70/30 worktree and branch, as far as they are drawn.
    // A column the reader sized by hand is a promise, so it is skipped; with both text columns hand-set the room is
    // spread over the rest.
    // Found by ID, never by position: `reviewedExtra` sits between the two text columns now, so `cols.indexOf(1)` would
    // have handed a third of the spare room to the review chip's cell instead of to the branch.
    const namePos = cols.indexOf(CHART_COLUMNS.findIndex((c) => c.id === "name"));
    const branchPos = cols.indexOf(CHART_COLUMNS.findIndex((c) => c.id === "branch"));
    let pool = [namePos, branchPos].filter((p) => p >= 0 && !fixed[p]);
    if (!pool.length) pool = want.map((_, p) => p).filter((p) => !fixed[p]);
    if (!pool.length) pool = [0];
    if (pool.length === 1) want[pool[0]] += spare;
    else if (pool.includes(namePos) && pool.includes(branchPos)) {
      const toName = Math.round(spare * 0.7);
      want[namePos] += toName;
      want[branchPos] += spare - toName;
    } else for (const p of pool) want[p] += Math.floor(spare / pool.length);
  } else if (spare < 0) {
    // Too narrow for the content: every column gives up the same fraction of what it can spare above its floor,
    // weighted by how little that costs it. Proportional rather than one column at a time - draining the first
    // column to its floor left it clipped mid-word while its neighbour sat at its full natural width.
    let over = -spare;
    for (let pass = 0; pass < 4 && over > 0.5; pass += 1) {
      const room = want.map((w, p) => (fixed[p] ? 0 : Math.max(0, w - COL_MIN[cols[p]]) * COL_GIVE[cols[p]]));
      const avail = sum(room);
      if (!avail) break;
      const take = Math.min(over, avail);
      for (let p = 0; p < want.length; p += 1) if (room[p]) want[p] -= (room[p] / avail) * take;
      over -= take;
    }
    // Every column at its floor and still too wide (a very narrow window): scale instead of letting the table grow
    // past its card, which is the bug `table-layout: fixed` exists to prevent.
    if (over > 0) {
      const scale = Math.min(1, total / sum(want));
      for (let p = 0; p < want.length; p += 1) want[p] = Math.max(24, Math.floor(want[p] * scale));
    }
  }
  // Integers that add up to the table's width EXACTLY. A fixed-layout table is never narrower than the sum of its
  // column widths, so a plan that rounds up is a table that grows past its card and is clipped at the card's edge —
  // which is exactly how the chart used to run under the assistant rail. When even the floors do not fit (a phone, or
  // the rail open on a narrow window) the columns give up proportionally here, down to a single pixel, and the
  // remainder lands on the leftmost column: a chart that fits always beats a column at its measured floor.
  const sumWant = sum(want);
  if (sumWant > total) {
    const scale = total / sumWant;
    for (let p = 0; p < want.length; p += 1) want[p] = Math.max(1, Math.floor(want[p] * scale));
  }
  want[0] = Math.max(1, want[0] + (total - sum(want)));
  return want;
}

// ---- how wide the split is allowed to be, and what happens when there is less room than that ----------------
// The table's box is the CARD, and the card's box is main's: the chart is planned to the width it is given and never
// to a floor of its own. That is the whole fix for a table that painted under the docked assistant rail — the plan
// used to keep a narrow window's floor width inside a card that had just lost 480px to the rail, and a fixed-layout
// table cannot be narrower than the sum of its column widths, so it ran out of the card and the card clipped it at
// the rail's edge with no scrollbar to reach the rest. Below the floors the columns now give up their slack and then
// scale (columnPlan), and the cell text wraps or ellipsizes instead: a chart that fits is worth more than a column
// at its measured floor.
//
// The only horizontal scroll container on the page is `main` (style.css). Nothing between main and the table may
// clip or scroll sideways, so an overflow that ever did happen would be reachable there instead of painted under the
// rail. `fitTarget` therefore reports the card's own width and no scroll mode: `.wt-scroll` is a padded wrapper, not
// a second scroller.
const WT_SCROLL = "wt-scroll";

function fitTarget(table) {
  const wrap = table.parentElement && table.parentElement.classList.contains(WT_SCROLL) ? table.parentElement : null;
  const box = Math.floor((wrap || table).clientWidth);
  return { wrap, box, total: box, scroll: false };
}

// Measurements are only good while the cells are: a repaint that changed no text should not pay for a layout.
//
// "The cells" are the worktree rows and nothing else - exactly the set naturalColumnWidths() copies. A row that spans
// every column (a card's detail, a delete confirmation) is not a column's content, so its text cannot move the split,
// and counting it here re-measured the chart on every line an agent wrote: read on the reader's board with a read-only
// client, 31 and 45 measurements in a minute where a signature over the worktree rows changed 3 and 14 times, and
// every check built one string of the whole tbody's text, consoles included (about 250 KB; 12.7 MB a minute).
const columnSigs = new WeakMap();

function columnSignature(tbody) {
  let rows = 0;
  let text = 0;
  let chips = 0;
  for (const tr of tbody.rows) {
    if (!tr.classList.contains("row")) continue;
    rows += 1;
    text += tr.textContent.length;
    chips += tr.querySelectorAll(".sig, .chip").length;
  }
  return `${rows}:${text}:${chips}`;
}

function fitColumns(table) {
  // A scan landing mid-drag must not fight the pointer for the pair being sized.
  if (colDrag) return;
  const ths = headerCells(table);
  // The header and the rows are built from the same shown set, so a table whose header does not match it is a stale
  // node (a settings change between the header paint and this fit): skip rather than measure a split for a table that
  // is about to be replaced.
  const cols = shownColumns();
  if (ths.length !== cols.length) return;
  installColumnGrips(table);
  const tbody = table.tBodies[0];
  const fit = fitTarget(table);
  if (!fit.total || !tbody) return;
  // Applied BEFORE the "nothing changed" return below: whether the chart scrolls is not a fact about the rows, and
  // a phone rotating changes the answer with every cell staying exactly as it was.
  applyFitMode(table, fit);
  const sig = columnSignature(tbody);
  if (columnSigs.get(table) === sig && ths[0].style.width) return;
  columnSigs.set(table, sig);
  applyColumnWidths(table, columnPlan(naturalColumnWidths(table), fit.total, cols));
}

// One measurement per table per frame, however many rows arrived this tick.
const pendingFits = new Set();
let fitScheduled = false;

function scheduleColumnFit(table) {
  if (!table || !table.isConnected) return;
  pendingFits.add(table);
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    const tables = [...pendingFits];
    pendingFits.clear();
    // A new split can re-wrap a chip strip and make a row taller. Near the bottom of the page that shortens (or
    // lengthens) the document under the reader, so the position is held across the measurement like any rebuild.
    const pageY = window.scrollY;
    for (const t of tables) if (t.isConnected) fitColumns(t);
    if (window.scrollY !== pageY) {
      const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(pageY, maxY) });
    }
  });
}

function fitAllColumns() {
  const slot = $("projects");
  if (!slot) return;
  for (const table of slot.querySelectorAll("section.project > .wt-scroll > table")) {
    columnSigs.delete(table);
    fitColumns(table);
  }
}

// ---- dragging a column edge ------------------------------------------------------------------
// Only the two columns on either side of the grip move, and they trade width rather than push the rest of the row
// around: the sum of the pair is what stays put. Released, the pair is remembered for every project's table.
let colDrag = null;

function installColumnGrips(table) {
  const ths = headerCells(table);
  ths.forEach((th, i) => {
    // Nothing sits to the right of the ✕ column, and one grip per header is enough however often this repaints.
    if (i === ths.length - 1 || th.querySelector(".col-grip")) return;
    const grip = document.createElement("span");
    grip.className = "col-grip";
    grip.dataset.col = String(i);
    grip.title = "drag to set this column's width · double-click to fit every column to its content again";
    grip.addEventListener("pointerdown", beginColumnDrag);
    grip.addEventListener("dblclick", (e) => {
      e.preventDefault();
      colWidths = new Array(WT_COLS).fill(null);
      saveColWidths();
      fitAllColumns();
    });
    th.appendChild(grip);
  });
}
