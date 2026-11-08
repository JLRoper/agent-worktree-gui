// charts.js - the worktree chart's own code, cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 22,000 lines and a third of the board's work landed in it, so one file
// was one lane. This is step 3 of the order of work in docs/reports/module-map-2026-11-07.html ("charts.js and
// deliverables.js out of app.js. Self-contained, low risk, and they prove the re-export pattern twice"), moved
// line for line: not one body was rewritten and not one call site was touched. The report's row for this file is
// "the 9 chart* functions" - chartTopLimit, chartTopOrder, chartTopSplit, chartDrawOrder, chartHeaderHtml,
// chartTopStored, chartTopSentence, chartColumnsStored and chartColumnsSentence - and the code each of them heads
// comes with them, because it is the same lane: the top-N collapse and the arrow that offers the rest, the column
// list the header is built from, and the two chart settings rows' readers and painters.
//
// WHAT IS HERE
//
//   the top-N collapse         which rows a chart holds back, and in what order: rowActivityAt, the count
//                              (chartTopLimit, CHART_TOP_DEFAULT), the one order "top" means (chartTopOrder,
//                              chartTopName), the split (chartTopSplit), the drawn order (chartDrawOrder), the
//                              hidden-row tests (rowTopHidden, heldRowCount), and the arrow in the legend that
//                              offers the rest (topToggleTitle, topSlotHtml, paintTopToggle, refreshTopToggle,
//                              toggleShowOld).
//   the chart's columns        CHART_COLUMNS and the floors derived from it (WT_COLS, COL_MIN, COL_GIVE), the
//                              hidden/shown set (hiddenColumnIds, OWNER_COLUMN_ID, ownerMatters, shownColumns),
//                              the colspan (wtColspan) and the header (chartHeaderHtml).
//   the chart's settings rows  the count's reader and sentence (chartTopStored, chartTopSentence), the retired-key
//                              note (legacyAgeNote) and the pair that paints and saves that row (paintTopSetting,
//                              saveTopSetting); the columns' reader and sentence (chartColumnsStored,
//                              chartColumnsSentence) and the pair that paints and saves those switches
//                              (paintChartColumns, saveChartColumns). The listeners those rows bind stay in
//                              public/app.js, with the rest of the page's wiring.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state                      chartTopLimit, chartDrawOrder, the hidden-row tests, both settings readers and the
//                              two savers read state.settings or state.rows.
//   lifeAtFor                  rowActivityAt folds the row's last life into its activity (this file).
//   applyRowRank               chartDrawOrder asks the board's live ranking for the rows on the chart.
//   saveShowOldProjects,       toggleShowOld writes the reader's choice and repaints the one project it changed,
//   renderProjectRows,         then repaints the arrow it moved.
//   refreshChips
//   projectNode                paintTopToggle and refreshTopToggle find the arrow by its attribute (public/dom.js).
//   esc, $                     the markup and the settings nodes (core/dom-format.js).
//   apiFetch                   the two savers POST the panel's config (core/transport.js).
//   renderAll, showBanner      a save that lands redraws the board and says so.
//   CSS.escape                 the savers' own lookups are by attribute value.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare name.
// This file declares, and registers the listeners its own settings rows and its arrow own; nothing in it reads an
// app.js binding while it loads, so sitting before app.js costs nothing and cannot land in a temporal dead zone.
// public/app.js re-exports these names on window.WMApp.charts.

// ---- the top-N collapse: which rows a chart is holding back ------------------------------------
// The newest moment this row's WORK moved: its last commit, its last edited file (the server folds both into
// lastEdit, and keeps lastCommit beside it), the last moment the panel saw it alive, and any event we received
// about one of its agents — an event is a fresh look at the tree, which is why noteEventLife counts it as life too.
function rowActivityAt(row) {
  return Math.max(lifeAtFor(row), Date.parse(row.lastEdit || "") || 0, Date.parse(row.lastCommit || "") || 0);
}

// How many rows a chart draws before the reader opens the rest. 0 (or anything unreadable) means every row is
// drawn — the same reading the server gives the key, so a config.json that says "off" beats a client that thinks
// it read a number.
const CHART_TOP_DEFAULT = 10;
function chartTopLimit() {
  const n = Number(state.settings?.chartTopCount);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : CHART_TOP_DEFAULT;
}

const chartTopName = (row) => String(row?.name || "").trim();

// The ONE order "top" means, and the order the held-back rows are listed in once a chart is opened: last activity,
// newest first, then by name. Deliberately NOT the chart's live ranking (`applyRowRank`): that order is smoothed over
// events and moves as they arrive, so taking the first N of it would draw a different set from one scan to the next.
// This is a total order over the rows as they stand — activity, then name, then path — so the same rows always give
// the same top N whatever order the scan (or a fixture) happened to hand them over in.
function chartTopOrder(rows) {
  return [...rows].sort((a, b) => {
    const byActivity = rowActivityAt(b) - rowActivityAt(a);
    if (byActivity) return byActivity;
    const byName = chartTopName(a).localeCompare(chartTopName(b), undefined, { sensitivity: "base" });
    if (byName) return byName;
    return String(a.path || "").localeCompare(String(b.path || ""));
  });
}

// One project's rows, split the way its chart draws them: `top` is the first N of chartTopOrder, `held` the rest in
// that same order, and `all` the whole list. The sort comes BEFORE the slice on purpose — a slice of the array the
// server happened to send is the bug this shape exists to prevent.
function chartTopSplit(rows) {
  const all = chartTopOrder(rows);
  const limit = chartTopLimit();
  if (!limit) return { all, top: all, held: [] };
  return { all, top: all.slice(0, limit), held: all.slice(limit) };
}

// A row this project's chart is holding back, unless the reader asked that chart for everything. Measured from
// ACTIVITY, never from when the directory was created: a tree cut months ago that somebody is working in right now
// has the newest activity there is, so it is the first row drawn rather than a row held back.
function rowTopHidden(row) {
  if (!row?.project || state.showOldProjects.has(row.project)) return false;
  const mine = [...state.rows.values()].filter((r) => r.project === row.project);
  const key = keyOf(row.project, row.path);
  return chartTopSplit(mine).held.some((r) => keyOf(r.project, r.path) === key);
}

// How many of a project's rows are below its chart's top N, whether or not that chart is currently showing them.
function heldRowCount(project) {
  const mine = [...state.rows.values()].filter((r) => r.project === project);
  return chartTopSplit(mine).held.length;
}

// The rows one project's chart draws, in the order it draws them: the top N in the chart's usual live ranking, then —
// once the reader has opened the chart — the held-back remainder in chartTopOrder itself, so "show the rest" lists
// them the way they were chosen (newest activity first, then by name) rather than in scan order.
function chartDrawOrder(project) {
  const mine = [...state.rows.values()].filter((r) => r.project === project);
  const split = chartTopSplit(mine);
  const head = applyRowRank(split.top);
  return state.showOldProjects.has(project) ? [...head, ...split.held] : head;
}

function topToggleTitle(project, count, held, showing) {
  const n = `${held} worktree${held === 1 ? "" : "s"}`;
  if (!count) return "every worktree is drawn: no count limit is set (Settings → Top worktrees per chart)";
  if (showing) {
    return held
      ? `hold back the ${n} below the top ${count} again`
      : `nothing here is below the top ${count} — this chart is showing every worktree`;
  }
  return held
    ? `show the ${n} below the top ${count} — newest activity first, then by name`
    : `nothing here is below the top ${count} — every worktree is on the chart`;
}

// The chart's arrow: the same little chip the console uses to jump back to its newest line, sitting at the bottom of
// the worktree chart, pointing down when it will show you more rows and up once it is showing them. Its label carries
// the real number — "show 15 more" is what says how much is behind it — so it is a pill rather than a circle
// (public/style.css `.wt-age-labeled`). It lives in the legend line rather than in the chart box itself because that
// line is the one box under the chart that neither scrolls sideways nor clips its children — the chart does both the
// moment the card is narrower than its columns — so the arrow stays on the chart's bottom edge at every width. It is
// invisible unless the pointer is over the chart (public/style.css), and it is not rendered at all while the count is
// off.
function topSlotHtml(project) {
  const count = chartTopLimit();
  if (!count) return "";
  const showing = state.showOldProjects.has(project);
  const held = heldRowCount(project);
  // Nothing held back and nothing shown: there is no choice to offer here, so this chart draws no arrow at all.
  if (!showing && !held) return "";
  const label = showing ? `↑ show top ${count}` : `↓ show ${held} more`;
  return `<button type="button" class="tail-chip wt-age-toggle wt-age-labeled${showing ? " is-on" : ""}" data-age-toggle="${esc(project)}" aria-pressed="${showing ? "true" : "false"}" title="${esc(topToggleTitle(project, count, held, showing))}">${label}</button>`;
}

// The arrow's own state, in place. The rows are re-rendered by the caller, and this is the button that asked for
// it: keeping the same node means the pointer does not fall off a control that just moved under it.
function paintTopToggle(project) {
  const btn = projectNode("data-age-toggle", project);
  if (!btn) return;
  const count = chartTopLimit();
  const showing = state.showOldProjects.has(project);
  const held = heldRowCount(project);
  btn.classList.toggle("is-on", showing);
  btn.setAttribute("aria-pressed", showing ? "true" : "false");
  btn.textContent = showing ? `↑ show top ${count}` : `↓ show ${held} more`;
  btn.title = topToggleTitle(project, count, held, showing);
}

// The legend is built ONCE, when the section's markup is created - before the first snapshot's rows are in
// `state`, so a count taken then is always zero and a button decided then would never appear. The arrow is
// therefore filled into this slot on every rows change instead (refreshChips below calls straight through): the
// chart draws an arrow exactly while it has something held back or is showing everything, and none otherwise.
function refreshTopToggle(project) {
  const slot = projectNode("data-age-slot", project);
  if (!slot) return;
  const want = topSlotHtml(project);
  if (!want) {
    if (slot.firstElementChild) slot.innerHTML = "";
    return;
  }
  // Same button: keep the node so the pointer does not fall off a control that just moved under it.
  if (!slot.firstElementChild) slot.innerHTML = want;
  else paintTopToggle(project);
}

// One chart, shown in full or held back again. The choice is this project's alone and it is remembered.
function toggleShowOld(project) {
  if (!project) return;
  if (state.showOldProjects.has(project)) state.showOldProjects.delete(project);
  else state.showOldProjects.add(project);
  saveShowOldProjects();
  refreshTopToggle(project);
  renderProjectRows(project);
  refreshChips(project);
}

// ---- chart columns: which of the table's eleven the reader keeps ------------------------------------------
// Eleven columns on every row is a lot of chart, and a reader chasing one fact (which trees are merged, which are
// behind) does not need the other ten on screen. Hiding a column is a settings choice stored in this panel's
// config.json (`hiddenColumns`, POST /api/settings/columns), and the column set is DATA here rather than eleven
// hand-written cells: the header, every row, the two column-spanning rows and the width measurement all read this
// list, so a hidden column is one absent <td> everywhere instead of a table whose cells disagree with its headers.
// The ids are the server's too (lib/chart-columns.js validates them); test/chart-columns.test.js asserts the two
// lists are the same, because a typo on either side hides nothing and looks like a broken button.
//
// Each column carries its own width floor and its own readiness to give room back. The table is `table-layout: fixed`
// on purpose (auto layout let one long branch grow it past its card), so every column width is a number somebody has
// to choose. Percentages chose badly: the verdict column held 12.6% of the row to show "NO COMMITS", and the
// worktree column held 28% to carry a name, a rename ✎ and the agent chips - exactly what the name alone used up, so
// the chips were the part that got clipped while the far side of the row sat empty. The split is now measured: each
// column asks for its widest cell, the columns that read the same at any width give their room up first when the
// table is narrower than that, and the spare room goes to the two text columns. A drag on the edge between two
// headers sets those two by hand (remembered in this browser, shared by every project table); a double-click on any
// edge hands the board back to the measurement.
const CHART_COLUMNS = [
  { id: "name", label: "Worktree", min: 170, give: 0.35 },
  { id: "branch", label: "Branch", min: 110, give: 0.45 },
  {
    id: "assistant",
    label: "Owner",
    min: 56,
    give: 1,
    title:
      "the assistant that controls this worktree, as a compact tag: M1 = Manager 1, M2 = Manager 2, A1 = Assistant #1. The cell's tooltip carries the assistant's own name and the role it runs (\"Assistant #2 — Manager\"), and the same fact is a line in the row's detail: \"Controlled by: Assistant #2 — Manager\". The column hides ITSELF while every row is on Assistant #1 and no second assistant exists, because it would be a column of identical tags; it comes back on its own the moment a tree is reassigned or a second assistant is created. Stored per tree and DISPLAY ONLY: it does not change who wakes, who runs, or who answers. Switch it off in Settings → Display → Chart columns.",
  },
  { id: "tip", label: "Tip", min: 70, give: 1 },
  {
    id: "ahead",
    label: "Ahead / Behind",
    min: 58,
    give: 1,
    title:
      "↑ commits this branch has that its own copy on the remote does not (not pushed yet). ↓ commits that copy has that this tree does not (not pulled). gone: the copy was deleted on the remote. —: never pushed. A dotted count with a ? is as of the last fetch that worked, because the latest one failed. The count against main is in the verdict's tooltip.",
  },
  { id: "cherry", label: "Cherry", min: 56, give: 1.1 },
  { id: "pr", label: "PR", min: 62, give: 1.1 },
  { id: "dirty", label: "Dirty", min: 64, give: 1 },
  {
    id: "life",
    label: "Life",
    min: 92,
    give: 0.6,
    title:
      "time since this worktree was last seen alive (any evidence firing) · chips are the evidence: ⧉ hermes session · ● board PID · :port dev server · ✎ files edited. The next-read ring and its countdown are the column beside this one.",
  },
  {
    id: "nextread",
    label: "Next read",
    min: 92,
    give: 0.5,
    title: "the ring fills up to green as the row becomes due for its next read · the countdown reads \"due in Xs\" while it waits, \"due now\" the moment it is due, and \"overdue <time>\" once the read is late · click the ring to read this worktree now",
  },
  { id: "verdict", label: "Verdict", min: 104, give: 0.5 },
  { id: "actions", label: "", min: 52, give: 0.15, title: "remove a worktree (sent to the Recycle Bin)" },
];
const WT_COLS = CHART_COLUMNS.length;
// Floors, measured off the real cell text at the panel's own font sizes: the hash, `0 / 0`, `+0/−0`, `none`,
// `clean`/`3 +1?`, `0s` with the ring and one chip, `NO COMMITS` and the row's ⟳ then ✕ each fit whole at these numbers.
// A long branch or a long `MERGED (squash/rebase, 3 commits)` still ellipsizes - that is the cheapest thing to lose.
const COL_MIN = CHART_COLUMNS.map((c) => c.min);
// How readily a column gives width back when the content is wider than the table, per column: 1 is a column that
// says little at any width (`+0/−0`, `none`), 0.15 is one that must not move (the row's ✕). A column only ever gives
// up its own slack above its floor, so the numbers decide how the squeeze is shared, not who is cut to the bone.
const COL_GIVE = CHART_COLUMNS.map((c) => c.give);

// The columns the chart hides. Read from the panel's config.json on every render rather than cached, so the row
// that arrives on the next scan and the header rebuilt by a `project` event agree with the switch the reader moved.
function hiddenColumnIds() {
  const raw = state.settings?.hiddenColumns;
  return new Set((Array.isArray(raw) ? raw : []).map((x) => String(x || "").toLowerCase()));
}

// The columns actually drawn, as indexes into CHART_COLUMNS, in the table's own order. At least one always
// survives: an empty table is not a narrower chart, and the last column carries the row's ⟳ and ✕. The server keeps
// the same floor (lib/chart-columns.js), so a config that hides everything still draws that cell after a restart.
//
// The owner column is the one column that hides ITSELF, on top of the reader's switch: with every row on Assistant
// #1 and no second assistant on the board it is a column of identical tags that costs a whole column of the chart
// nothing but width. It returns the moment it can say something — a tree moved to another assistant, a stored owner
// that is gone (drawn as the fallback), or a second assistant existing anywhere on the board. The switch in Settings
// still turns it OFF for good; this rule can only take it away while it says nothing, and `chartColumnsSentence`
// says so beside the switches so a ticked box over a missing column is explained rather than read as a bug.
function ownerMatters(rows = state.rows, assistants = state.assistant?.assistants) {
  if (Array.isArray(assistants) && assistants.length > 1) return true;
  const list = typeof rows?.values === "function" ? [...rows.values()] : Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const a = row?.assistant;
    if (!a) continue;
    if (String(a.stored || "").trim()) return true;
    const id = String(a.id || "").trim();
    if (id && id !== "assistant-1") return true;
  }
  return false;
}

const OWNER_COLUMN_ID = "assistant";

function shownColumns(forceOwner = false) {
  const hidden = hiddenColumnIds();
  const shown = CHART_COLUMNS.map((_, i) => i).filter((i) => !hidden.has(CHART_COLUMNS[i].id));
  const ownerAt = shown.findIndex((i) => CHART_COLUMNS[i].id === OWNER_COLUMN_ID);
  if (ownerAt >= 0 && !forceOwner && !ownerMatters()) shown.splice(ownerAt, 1);
  return shown.length ? shown : [WT_COLS - 1];
}

// How many cells a column-spanning row needs: an expanded worktree, a delete question, a lock refusal, a rename
// offer. It used to be the literal 10 in five places, which is exactly how a hidden column leaves a bare strip of
// panel at the right edge (or a cell one column short, silently dropping the last one).
function wtColspan() {
  return shownColumns().length;
}

function chartHeaderHtml(forceOwner = false) {
  return shownColumns(forceOwner)
    .map((i) => {
      const c = CHART_COLUMNS[i];
      const attrs = `data-col-id="${esc(c.id)}"${c.title ? ` title="${esc(c.title)}"` : ""}`;
      return `<th ${attrs}>${esc(c.label)}</th>`;
    })
    .join("");
}
// ---- end chart columns

// ---- how many worktrees a chart draws before its arrow shows the rest -----------------------------
// The count lives in this panel's config.json (POST /api/settings/chart-top), like the refresh mode above: one
// number for every browser, and it survives a restart. The per-chart "show all" arrow is the one half of this that
// is per-browser (state.showOldProjects). Moving the number redraws the board, because rows leave and come back the
// instant the count moves - waiting for the next scan would show the change one project at a time.
const CHART_TOP_MAX_UI = 5000;

function chartTopStored() {
  const n = Number(state.settings?.chartTopCount);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : CHART_TOP_DEFAULT;
}

function chartTopSentence(count) {
  return count > 0
    ? `draw the top ${count} worktree${count === 1 ? "" : "s"} of every chart — last activity newest first, then by name`
    : "draw every worktree of every chart — no count limit";
}

// A config.json that still carries the retired age threshold is ignored, never read as "0" (which would draw every
// tree) and never a crash: the count above is what the chart obeys. The sentence says so, with the key's own name,
// because the leftover key is the one thing a reader can delete.
function legacyAgeNote() {
  return state.settings?.hideOlderDaysIgnored
    ? " · config.json still carries hideOlderThanDays, which is ignored now — delete it when convenient"
    : "";
}

function paintTopSetting(note = "", bad = false) {
  const stored = chartTopStored();
  const input = $("chart-top-count");
  // A rejected save leaves what was typed in the box: snapping back to the stored number reads as "it saved that",
  // when the save is exactly what failed.
  if (input && !bad && document.activeElement !== input) input.value = String(stored);
  for (const btn of document.querySelectorAll("[data-top-set]")) {
    btn.classList.toggle("on", Number(btn.dataset.topSet) === stored);
  }
  const preview = $("chart-top-preview");
  if (preview) {
    const live = input && document.activeElement === input ? Math.round(Number(input.value)) : stored;
    const count = Number.isFinite(live) && live >= 0 ? live : stored;
    const bits = [
      `${chartTopSentence(count)} · set in config.json, so it applies to every browser and survives a restart`,
      "the arrow at the bottom of a chart shows the rest, in that same order",
    ];
    preview.textContent = bad
      ? `NOT SAVED - ${note}. config.json still says: ${chartTopSentence(stored)}.`
      : `${note ? `${note} - ` : ""}${bits.join(" · ")}${legacyAgeNote()}`;
    preview.classList.toggle("bad", bad);
  }
}

async function saveTopSetting(count) {
  const stored = chartTopStored();
  const want = Number(count);
  const n = Number.isFinite(want) ? Math.max(0, Math.min(CHART_TOP_MAX_UI, Math.round(want))) : stored;
  const preview = $("chart-top-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/chart-top",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: n }),
      },
      { timeoutMs: 10000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings.chartTopCount = Number.isFinite(Number(d.count)) ? Number(d.count) : n;
    // The line moved, so which rows every chart draws moved with it: rebuild the board rather than let the next
    // scan trickle it in one project at a time.
    renderAll();
    paintTopSetting(chartTopSentence(state.settings.chartTopCount));
    showBanner(chartTopSentence(state.settings.chartTopCount));
  } catch (err) {
    paintTopSetting(String((err && err.message) || err), true);
  }
}

$("chart-top-count")?.addEventListener("change", (e) => void saveTopSetting(e.target.value));
// Enter is this box's other way out, the same bargain every other number row in Settings makes (banner-seconds,
// stream-words, stream-lines, reorder-every, rank-window): the reader who types a number and presses Enter means
// "save this", and without this handler the field can only be left by a click somewhere else. The blur is half of
// the gesture, not tidying after it — the save is async, so the field holds the focus until it is given up, and
// paintTopSetting deliberately leaves a focused box's value alone.
$("chart-top-count")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void saveTopSetting(e.target.value);
  e.target.blur();
});
for (const btn of document.querySelectorAll("[data-top-set]")) {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const input = $("chart-top-count");
    if (input) input.value = btn.dataset.topSet;
    void saveTopSetting(btn.dataset.topSet);
  });
}

// ---- which of the chart's columns are drawn ------------------------------------------------------
// The choice lives in this panel's config.json (POST /api/settings/columns, `hiddenColumns`), like the refresh mode
// and the age threshold above: one answer for every browser, and it survives a restart. The switches are BUILT from
// CHART_COLUMNS, so a column cannot be added to the chart and left out of Settings — or named one thing in the table
// and another in the row.
function chartColumnsStored() {
  const raw = state.settings?.hiddenColumns;
  const hidden = new Set((Array.isArray(raw) ? raw : []).map((x) => String(x || "").toLowerCase()));
  return CHART_COLUMNS.filter((c) => hidden.has(c.id)).map((c) => c.id);
}

// The owner column can be ON in the file and absent from the chart: it hides itself while it would be a column of
// identical tags (ownerMatters). A sentence that counted it as drawn would make a ticked box over a missing column
// read as a bug, so the reason travels with the count — unless the reader hid that column themselves, in which case
// the list already says it.
function chartColumnsSentence(hidden = chartColumnsStored()) {
  const shown = CHART_COLUMNS.length - hidden.length;
  const head = hidden.length
    ? `${shown} of ${CHART_COLUMNS.length} columns on the chart · hidden: ${hidden.join(", ")}`
    : `every column is on the chart (${CHART_COLUMNS.length})`;
  const idle = !hidden.includes(OWNER_COLUMN_ID) && !ownerMatters();
  return idle
    ? `${head} · the Owner column hides itself while every tree is on Assistant #1 and there is no second assistant`
    : head;
}

function paintChartColumns(note = "", bad = false) {
  const stored = chartColumnsStored();
  const hidden = new Set(stored);
  const holder = $("chart-cols");
  if (holder) {
    if (!holder.childElementCount) {
      holder.innerHTML = CHART_COLUMNS.map(
        (c) =>
          `<label title="${esc(c.title || `${c.label} — the chart's ${c.label || "actions"} column`)}"><input type="checkbox" data-chart-col="${esc(c.id)}"> ${esc(c.label || "Actions")}</label>`,
      ).join("");
    }
    for (const box of holder.querySelectorAll("[data-chart-col]")) box.checked = !hidden.has(box.dataset.chartCol);
  }
  const count = $("chart-cols-count");
  if (count) count.textContent = `${CHART_COLUMNS.length - stored.length}/${CHART_COLUMNS.length}`;
  const preview = $("chart-cols-preview");
  if (preview) {
    preview.textContent = bad
      ? `NOT SAVED — ${note}. config.json still says: ${chartColumnsSentence()}.`
      : note
        ? `${note} — set in config.json, so it applies to every browser and survives a restart`
        : `${chartColumnsSentence()} · set in config.json, so it applies to every browser and survives a restart`;
    preview.classList.toggle("bad", bad);
  }
}

async function saveChartColumns(hidden) {
  // Canonical order, so the file does not depend on the order the reader clicked the switches.
  const ids = CHART_COLUMNS.map((c) => c.id);
  const want = ids.filter((id) => hidden.includes(id));
  const preview = $("chart-cols-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/columns",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hidden: want }) },
      { timeoutMs: 10000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings.hiddenColumns = Array.isArray(d.hidden) ? d.hidden.slice() : want;
    // The chart is a TABLE: a hidden column is one missing cell in the header and in every row of every project, so
    // the board is rebuilt rather than patched. The column fit is scheduled by that rebuild.
    renderAll();
    paintChartColumns();
    showBanner(chartColumnsSentence(state.settings.hiddenColumns));
  } catch (err) {
    paintChartColumns(String((err && err.message) || err), true);
  }
}

$("chart-cols")?.addEventListener("change", () => {
  const holder = $("chart-cols");
  if (!holder) return;
  const hidden = [...holder.querySelectorAll("[data-chart-col]")].filter((b) => !b.checked).map((b) => b.dataset.chartCol);
  void saveChartColumns(hidden);
});
$("btn-cols-all")?.addEventListener("click", (e) => {
  e.preventDefault();
  const holder = $("chart-cols");
  if (holder) for (const box of holder.querySelectorAll("[data-chart-col]")) box.checked = true;
  void saveChartColumns([]);
});

// The chart's own arrow: one press shows this project every tree, or holds the stale ones back again.
document.addEventListener("click", (e) => {
  const btn = e.target.closest ? e.target.closest("[data-age-toggle]") : null;
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  toggleShowOld(btn.dataset.ageToggle);
});
