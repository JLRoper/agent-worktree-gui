// Worktree Monitor client.
//   - worktree rows are patched individually from the SSE stream
//   - liveness is shown as labelled evidence chips (files / hermes / board / port)
//   - agents spawned from the "New agent" card stream their stdout live

// Declared BEFORE `state`: it is read while the state literal below is built, and a `const` further
// down the file would still be in its temporal dead zone at that moment (the read would throw and get
// swallowed, leaving an empty history).
const SPAWN_HISTORY_KEY = "wm.spawnHistory";
const SPAWN_HISTORY_MAX = 50;

const state = {
  // thread -> px. Ctrl+wheel over a console zooms that console only, like a terminal window; the Settings
  // "Console size" stays the baseline for every card. Kept in memory so a repaint does not undo it.
  consoleZoom: new Map(),
  // Hot Agent: the rotation through agents that are waiting for input. `stack` is the visit history (so
  // Alt+Left can walk back), `cursor` points at the one on screen.
  hot: { on: false, stack: [], cursor: -1 },
  projects: new Map(),
  // Handle for the board-reorder clock, which the settings row can re-arm at another cadence.
  reorderTimer: null,
  // The card a jump just landed on, so the highlight survives the repaint a running card gets on every
  // job event (a class added to the node is gone the moment the node is replaced).
  jumpThread: null,
  rows: new Map(),
  expanded: new Set(),
  rowEls: new Map(),
  detailEls: new Map(),
  tbodyEls: new Map(),
  settings: {},
  spawn: {},
  paused: false,
  es: null,
  events: 0,
  eventsAt: 0,
  lastEventAt: null,
  pool: null,
  jobs: new Map(),
  jobLines: new Map(),
  replyDrafts: {},
  // Up/Down in a reply box walks this thread's previous prompts; this remembers how far back you are
  // and the draft you started from.
  replyNav: new Map(),
  // The New-agent box has the same Up/Down walk, over everything spawned from it (persisted, because
  // a prompt you typed yesterday is exactly what you want back after a reload).
  spawnHistory: loadSpawnHistory(),
  spawnNav: null,
  // Popups that are open, by thread, with the position they were opened at — so a repaint (which
  // replaces the card) does not silently close the list the reader is working in.
  openArtifacts: new Map(),
  // The reply box that should take the caret once its card exists (set by a spawn or a jump, cleared
  // by itself the moment focus lands or the reader types somewhere else).
  pendingFocus: null,
  // Replies typed while the agent is still working, in the order they were written. They go out one
  // at a time as each turn finishes: Hermes refuses a second session on a thread already running.
  replyQueue: new Map(),
  // Documents pasted or dropped into a reply box, per thread: the reply area is rebuilt on every job
  // event, so these cannot live in the DOM the way the New-agent box's list can.
  replyAttachments: new Map(),
  // Row keys whose own agent evidence moved on the last paint; the reorder pass colours only these green.
  movedRows: new Set(),
  // Transcript scroll per console (pre[data-out]). Folding a project throws the console markup away,
  // so the position has to live outside the DOM or it comes back at the top.
  outScrolls: {},
  collapsedJobs: loadCollapsedJobs(),
  expandedProjects: loadExpandedProjects(),
  collapsedFixed: loadCollapsedFixed(),
  collapsedRoots: loadCollapsedRoots(),
  recentRoots: loadRecentRoots(),
  cloneStatus: {},
  approvals: new Map(),
  scanRoots: [],
  pollGap: new Map(), // key -> observed seconds between that row's scans, smoothed
  lastScanAt: new Map(), // key -> ms of the previous scan we rendered
  turnOpen: new Map(), // job id -> whether that turn's body is expanded (default: only the newest)
  turnPage: new Map(), // thread -> how many pages of turns back from the newest (0 = newest page)
  gitOpen: new Set(), // row key -> the git/commit/diff accordion is unfolded
  pinnedTurns: new Set(), // turn id -> starred, so it also shows above the paged turns
  liveOpen: new Set(), // row key -> the liveness-evidence block is unfolded
  maximized: null, // thread id of the conversation pulled out to fill the window
  zoom: 100, // page zoom percent (the browser's own Ctrl +/- is not always delivered)
};

// Every call to the panel's own server goes through here. A plain fetch has no deadline, so when the
// server is restarting — a gateway bounce refuses or hangs connections for a while — the promise never
// settles: the button stays disabled, no message appears, and the card is indistinguishable from a
// frozen page. A timeout turns that into a sentence on screen.
async function apiFetch(url, opts = {}, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(`the panel server did not answer within ${Math.round(timeoutMs / 1000)}s — it may be restarting; try again`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const $ = (id) => document.getElementById(id);
const keyOf = (project, p) => `${project}::${p}`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function relTime(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Precise duration for the life column: 1h24m12s, not "1h". Seconds matter there because the
// number is the whole point of the column.
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m${String(rs).padStart(2, "0")}s`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

// Coarse on purpose: "4h ago" answers "when did I last use this", and a per-second figure on a stale
// session would be noise. The exact moment is in the tooltip.
function fmtAgo(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(String(ts || ""));
  if (!Number.isFinite(t) || t <= 0) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function elapsed(j) {
  if (!j.startedAt) return "—";
  const end = j.endedAt ? Date.parse(j.endedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(j.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// Row order inside a project: work that is happening right now comes first. Our own running agents
// lead (that is the panel driving a process), then any other live session, then everything else
// newest-life-first — the worktree that showed signs of life most recently sits at the top.
function rowTier(row) {
  if (panelFor(row)?.running) return 0;
  if (isRowLive(row)) return 1;
  return 2;
}

function lifeAt(row) {
  const alive = Date.parse(row.lastAliveAt || "");
  return Number.isFinite(alive) ? alive : Number.NEGATIVE_INFINITY; // never alive sorts last
}

// What counts as an agent moving in a row. The cheap scan fields (verdict, age, git tip) are the
// scanner working, not the agent: a verdict flipping is not movement, and flashing green for it made
// every poll look like progress.
// The project's own checkout, on its main branch. Merges land here and a fast-forward rewrites file
// mtimes, which read exactly like an agent working in the main tree — it is how main kept flashing
// while the real work happened one directory down. Main rows therefore move on agent evidence
// (sessions, board entries, ports, cards) and on nothing else.
function isMainWorktree(project, row) {
  const main = state.projects.get(project)?.mainBranch;
  return Boolean(main && row.branch && row.branch === main);
}

function movementKey(row, { onMain = false } = {}) {
  const s = row.signals || {};
  const h = s.hermes || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const sessions = `${(h.titles || []).join("|")}#${num(h.running)}`;
  const idle = (h.idleList || []).map((x) => `${x.id}:${num(x.lastActivityAt)}`).join("|");
  const board = (s.board?.entries || []).map((e) => e.pid).join("|");
  const ports = (s.ports?.listening || []).join("|");
  // Only what a card is DOING, never how many cards there are: the count and the thread list are
  // omitted from some row events, so `0/0` flipping to `0/10` read as movement on every refresh and
  // every row pulsed green. A start is still movement; a bookkeeping total is not.
  const cards = num(s.panel?.running);
  const files = onMain ? "" : s.files?.at || "";
  return `${sessions}#${idle}#${board}#${ports}#${cards}#${files}`;
}

function orderRows(rows) {
  return rows.sort(
    (a, b) => rowTier(a) - rowTier(b) || lifeAt(b) - lifeAt(a) || String(a.name).localeCompare(String(b.name)),
  );
}

function verdictClass(v) {
  const s = String(v || "");
  if (s.startsWith("MERGED")) return "merged";
  if (s === "ON MAIN") return "onmain";
  if (s.startsWith("NO COMMITS") || s.startsWith("EMPTY REPO")) return "nocommits";
  if (s.startsWith("UNMERGED")) return "unmerged";
  return "error";
}

// ---------------- agents ----------------
function jobLines(id) {
  return state.jobLines.get(id) || [];
}

// ---- minimize / expand a card -----------------------------------------------
// Folding is per-card and remembered in localStorage, so a refresh (or the 30s
// resync, which rebuilds every card) does not spring everything back open.
function loadCollapsedJobs() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.collapsedJobs") || "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsedJobs() {
  try {
    localStorage.setItem("wm.collapsedJobs", JSON.stringify([...state.collapsedJobs]));
  } catch {
    /* no storage available: folding just won't survive a reload */
  }
}

// Each project section is minimized to its title line by default; the ones you opened are
// remembered, so a reload (or the 30s resync, which rebuilds every section) keeps your layout.
function loadExpandedProjects() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.expandedProjects") || "[]"));
  } catch {
    return new Set();
  }
}

function saveExpandedProjects() {
  try {
    localStorage.setItem("wm.expandedProjects", JSON.stringify([...state.expandedProjects]));
  } catch {
    /* no storage: the choice simply will not persist */
  }
}

// The two fixed cards at the top ("New agent", "Agents") collapse from their title row too. They
// are not projects — they always exist — so they get their own remembered set instead of pretending
// to be discovered worktrees.
function loadCollapsedFixed() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.collapsedFixed") || "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsedFixed() {
  try {
    localStorage.setItem("wm.collapsedFixed", JSON.stringify([...state.collapsedFixed]));
  } catch {
    /* no storage: the choice simply will not persist */
  }
}

function applyFixedCollapse(name) {
  const sec = document.getElementById(name);
  if (!sec) return;
  const open = !state.collapsedFixed.has(name);
  sec.classList.toggle("fixed-collapsed", !open);
  const head = sec.querySelector(".project-head[data-toggle-fixed]");
  if (head) {
    head.title = `${open ? "minimize" : "expand"} this card`;
    const chev = head.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25be" : "\u25b8";
  }
}

function toggleFixed(name) {
  if (!name) return;
  if (state.collapsedFixed.has(name)) state.collapsedFixed.delete(name);
  else state.collapsedFixed.add(name);
  saveCollapsedFixed();
  applyFixedCollapse(name);
  // Collapsing the Agents card and expanding it again must not lose the reply drafts or the
  // scroll position of a running turn: nothing is destroyed, the body is only hidden.
}

function toggleProject(name) {
  if (!name) return;
  if (state.expandedProjects.has(name)) state.expandedProjects.delete(name);
  else state.expandedProjects.add(name);
  saveExpandedProjects();
  applyProjectCollapse(name);
  // Rows are only built for projects that are open, so opening one has to build them now — and
  // closing one should drop them again instead of leaving hidden markup behind.
  renderProjectRows(name);
  // Keep the folder's collapse-all button honest when projects are opened one by one.
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  const root = sec?.closest("section.root-group")?.dataset.root;
  if (root) paintRootButton(root);
  paintCollapseAll();
}

// ---- folder layer ------------------------------------------------------------
// Projects are wrapped in one accordion per folder: `scanRoots` entries, plus a sibling folder
// group for any project that is NOT actually inside a root (an explicit `projects[]` entry can
// point anywhere, and a repo outside every root must not be shown under one).
function loadCollapsedRoots() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.collapsedRoots") || "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsedRoots() {
  try {
    localStorage.setItem("wm.collapsedRoots", JSON.stringify([...state.collapsedRoots]));
  } catch {
    /* no storage: the choice simply will not persist */
  }
}

// Folders can be shown as "every project" or "only projects touched in the last week". The choice is
// per folder and remembered, like the collapsed state.
function loadRecentRoots() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.recentRoots") || "[]"));
  } catch {
    return new Set();
  }
}

function saveRecentRoots() {
  try {
    localStorage.setItem("wm.recentRoots", JSON.stringify([...state.recentRoots]));
  } catch {
    /* no storage: the choice simply will not persist */
  }
}

const RECENT_DAYS = 7;

const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

// Longest matching scan root wins, so a nested root groups under the more specific folder.
// No match means the project lives outside every root: group it under its own parent folder.
function rootOf(project) {
  const raw = normPath(project.path);
  const lower = raw.toLowerCase();
  if (!lower) return "(unknown folder)";
  const roots = (state.scanRoots || []).map(normPath).filter(Boolean);
  const match = roots
    .filter((r) => lower === r.toLowerCase() || lower.startsWith(`${r.toLowerCase()}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return match;
  const cut = raw.lastIndexOf("/");
  return cut > 0 ? raw.slice(0, cut) : raw;
}

// `C:/ProjectDevelopment` reads as `C:\ProjectDevelopment\` in the header — that is the folder
// the user recognises — while a posix path keeps its slashes.
function labelRoot(root) {
  const r = String(root || "");
  if (/^[A-Za-z]:\//.test(r)) return `${r.replace(/\//g, "\\")}\\`;
  return r.endsWith("/") ? r : `${r}/`;
}

function toggleRoot(root) {
  if (!root) return;
  if (state.collapsedRoots.has(root)) state.collapsedRoots.delete(root);
  else state.collapsedRoots.add(root);
  saveCollapsedRoots();
  applyRootCollapse(root);
  paintCollapseAll();
}

function applyRootCollapse(root) {
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  if (!sec) return;
  const open = !state.collapsedRoots.has(root);
  sec.classList.toggle("collapsed", !open);
  const head = sec.querySelector(".root-head[data-toggle-root]");
  if (head) {
    head.title = `${open ? "collapse" : "expand"} ${labelRoot(root)}`;
    const chev = head.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25be" : "\u25b8";
  }
}

// ---- collapse-all inside one folder -------------------------------------------
// One button per folder that opens or closes every project section it holds, without touching
// the folder itself. The label follows what is actually on screen: "Collapse all" while any
// project in the folder is open, "Expand all" once none are.
function paintRootButton(root) {
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  const btn = sec?.querySelector("[data-root-collapse]");
  if (!btn) return;
  const names = [...sec.querySelectorAll("section.project")].map((s) => s.dataset.project);
  const anyOpen = names.some((n) => state.expandedProjects.has(n));
  btn.textContent = anyOpen ? "Collapse all" : "Expand all";
  btn.title = `${anyOpen ? "collapse" : "expand"} every project in ${labelRoot(root)} (${names.length})`;
}

function toggleAllInRoot(root) {
  if (!root) return;
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  if (!sec) return;
  const names = [...sec.querySelectorAll("section.project")].map((s) => s.dataset.project);
  if (!names.length) return;
  const collapse = names.some((n) => state.expandedProjects.has(n));
  for (const n of names) {
    if (collapse) state.expandedProjects.delete(n);
    else state.expandedProjects.add(n);
  }
  saveExpandedProjects();
  for (const n of names) applyProjectCollapse(n);
  paintRootButton(root);
}

// Rebuild one folder in place — used by the all/recent toggle so the rest of the board keeps its
// scroll and its own expansion state.
function renderRoot(root) {
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  if (!sec) return;
  const all = sortedProjects().filter((p) => rootOf(p) === root);
  const shown = new Set(shownInRoot(root, all).map((p) => p.name));
  const prevKeys = [...sec.querySelectorAll(".root-body section.project")].map((s) => s.dataset.project);
  const holder = document.createElement("div");
  holder.innerHTML = rootSection(root, all);
  const fresh = holder.firstElementChild;
  sec.replaceWith(fresh);
  for (const p of all) {
    if (!shown.has(p.name)) {
      state.tbodyEls.delete(p.name);
      continue;
    }
    const tbody = fresh.querySelector(`[data-tbody="${CSS.escape(p.name)}"]`);
    if (!tbody) continue;
    state.tbodyEls.set(p.name, tbody);
    for (const map of [state.rowEls, state.detailEls]) {
      for (const k of [...map.keys()]) if (state.rows.get(k)?.project === p.name) map.delete(k);
    }
    renderProjectRows(p.name);
    refreshChips(p.name);
  }
  // Same count means this was a re-rank, not a filter change: say which projects moved. Flipping All
  // / 7d changes the set, and flashing every survivor of that would be noise.
  pinOpenProjects(fresh.querySelector(".root-body"), prevKeys);
  const nextSections = [...fresh.querySelectorAll(".root-body section.project")];
  if (prevKeys.length === nextSections.length) flashMovedByKey(prevKeys, nextSections, fresh);
}

function toggleRootRecent(root) {
  if (!root) return;
  if (state.recentRoots.has(root)) state.recentRoots.delete(root);
  else state.recentRoots.add(root);
  saveRecentRoots();
  renderRoot(root);
}

// One gesture for the whole board: fold every folder AND every project section, or unfold them all
// again. Collapsing has to include the folders — with 95 projects across a few roots, folding only
// the projects still leaves a long list of folder headers that each need their own click.
function boardRoots() {
  return [...document.querySelectorAll("section.root-group")].map((s) => s.dataset.root).filter(Boolean);
}

// The two cards above the board — New agent and Unattached agents — fold like project sections, and
// "Collapse all" has to include them.
const FIXED_CARDS = ["newagent", "agents"];

// Keep the row you clicked exactly where it was under the pointer while its accordion opens or closes.
// The inserted content shifts everything around it (and the browser's scroll anchoring picks an element
// above), so without this the row slides out from under the cursor. `findEl` is a function because a
// rebuild can replace the node; it is re-queried after the mutation.
function keepInPlace(findEl, mutate) {
  const el = findEl();
  if (!el) return mutate();
  const before = el.getBoundingClientRect().top;
  mutate();
  const settle = () => {
    const after = findEl();
    if (!after) return;
    const delta = after.getBoundingClientRect().top - before;
    // A small correction only: a huge delta means the board really did rearrange, and yanking the page
    // to chase it would be worse than letting it move.
    if (Math.abs(delta) >= 1 && Math.abs(delta) < 600) window.scrollBy(0, delta);
  };
  settle();
  setTimeout(settle, 0);
  setTimeout(settle, 80);
}

function anythingOpen() {
  const names = [...state.projects.keys()];
  return (
    names.some((n) => state.expandedProjects.has(n)) ||
    boardRoots().some((r) => !state.collapsedRoots.has(r)) ||
    // The two fixed cards fold too, and "Collapse all" means all of it.
    FIXED_CARDS.some((id) => !state.collapsedFixed.has(id))
  );
}

function paintCollapseAll() {
  const btn = $("btn-collapse-all");
  if (!btn) return;
  const open = anythingOpen();
  const names = [...state.projects.keys()];
  btn.textContent = open ? "Collapse all" : "Expand all";
  btn.title = `${open ? "collapse" : "expand"} the whole tree — every folder, project, worktree row, card and turn (${boardRoots().length} folders, ${names.length} projects) — Ctrl+${open ? "[" : "]"}`;
}

// One direction at a time. The header button must toggle (one button, two words), but a hotkey that
// only toggled would be a coin flip — the reader asks to collapse and gets whatever the board's state
// happened to imply. So the action lives here and both callers say which way they mean.
function setEverythingOpen(open) {
  const names = [...state.projects.keys()];
  const roots = boardRoots();
  if (!names.length && !roots.length) return;
  if (!open) {
    state.expandedProjects.clear();
    state.expanded.clear(); // an open row would otherwise come back when a project is reopened
    for (const r of roots) state.collapsedRoots.add(r);
    for (const id of FIXED_CARDS) state.collapsedFixed.add(id);
  } else {
    for (const n of names) state.expandedProjects.add(n);
    for (const r of roots) state.collapsedRoots.delete(r);
    for (const id of FIXED_CARDS) state.collapsedFixed.delete(id);
  }
  // ...and on down to the turns. A card body and a turn transcript are accordions too, and stopping at
  // the row meant "collapse all" still left a screenful of open transcripts underneath.
  for (const c of conversations()) {
    if (open) state.collapsedJobs.delete(c.thread);
    else state.collapsedJobs.add(c.thread);
    for (const turn of c.turns || []) {
      state.turnOpen.set(turnKey(turn), open);
      // A pinned turn has its own copy above the paged ones with its own key.
      if (state.pinnedTurns.has(turn.id)) state.turnOpen.set(turnKey(turn, "@pin"), open);
    }
  }
  saveExpandedProjects();
  saveCollapsedRoots();
  saveCollapsedFixed();
  saveCollapsedJobs();
  renderAll(); // folders and projects both changed shape: one rebuild is cheaper than patching two layers
  renderJobs(); // the unattached cards are not part of a project section
  // The fixed cards live in the static markup, so renderAll does not touch them.
  for (const id of FIXED_CARDS) applyFixedCollapse(id);
  paintCollapseAll();
}

function toggleEverything() {
  setEverythingOpen(!anythingOpen());
}

// ---- clone a repo into a folder ------------------------------------------------
// The "+" in a folder header opens this row. The root is fixed to the folder you clicked, so a
// clone can only ever land inside a configured scan root, and the server re-checks that.
function showCloneForm(root, show = true) {
  const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
  if (!form) return;
  form.hidden = !show;
  if (show) form.querySelector("[data-clone-input]")?.focus();
}

async function cloneIntoRoot(root) {
  const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
  if (!form) return;
  const input = form.querySelector("[data-clone-input]");
  const btn = form.querySelector("[data-clone-go]");
  const name = String(input?.value || "").trim();

  // Status lives in state, not only in the DOM: a snapshot re-renders every folder section, and
  // an inline-only message was wiped a couple of seconds after the clone finished.
  const setStatus = (text, kind = "busy") => {
    state.cloneStatus[root] = { text, kind };
    const span = document.querySelector(`[data-clone-form="${CSS.escape(root)}"] [data-clone-msg]`);
    if (span) {
      span.textContent = text;
      span.classList.toggle("clone-err", kind === "err");
    }
  };

  if (!name) {
    input?.focus();
    return;
  }
  btn.disabled = true;
  setStatus("cloning over ssh…");
  try {
    const res = await apiFetch("/api/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, name }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(j.error || `HTTP ${res.status}`, "err");
      return;
    }
    setStatus(`cloned → ${j.dest} (${Math.round((j.tookMs || 0) / 1000)}s, ${j.url})`, "ok");
    if (input) input.value = "";
    // Discovery re-runs server-side and broadcasts a snapshot when it is done; this second
    // resync covers a missed event so the new project appears without waiting for the timer.
    setTimeout(() => void resync(), 2000);
  } catch (e) {
    setStatus(`failed: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
}

// Toggle the class in place rather than re-rendering: the rows stay painted underneath, so
// expanding is instant and a collapse costs no DOM churn.
function applyProjectCollapse(name) {
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  if (!sec) return;
  const open = state.expandedProjects.has(name);
  sec.classList.toggle("collapsed", !open);
  const head = sec.querySelector(".project-head[data-toggle-project]");
  if (head) {
    head.title = `${open ? "minimize" : "expand"} ${name}`;
    const chev = head.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25be" : "\u25b8";
  }
}

function toggleJob(id) {
  if (!id) return;
  if (state.collapsedJobs.has(id)) state.collapsedJobs.delete(id);
  else state.collapsedJobs.add(id);
  saveCollapsedJobs();
  renderConversation(id);
  // Opening a conversation should land on the newest output, not on the first line of a turn from
  // an hour ago — the whole point of opening it is usually to see where the agent got to.
  if (!state.collapsedJobs.has(id)) scrollThreadToBottom(id);
}

// A chat pulled out to fill the window. One at a time: opening another closes the first, and Esc
// puts it back, so there is always a way out that does not depend on finding a small button.
function setMaximized(thread) {
  const next = thread && state.maximized !== thread ? thread : null;
  state.maximized = next;
  document.body.classList.toggle("modal-open", Boolean(next));
  for (const el of document.querySelectorAll(".job.maximized")) el.classList.remove("maximized");
  for (const btn of document.querySelectorAll(".btn-max")) {
    btn.textContent = "\u2922";
    btn.title = "expand this chat to fill the window (Esc to close)";
  }
  if (next) {
    // A minimized card cannot be maximized: open it first.
    if (state.collapsedJobs.has(next)) {
      state.collapsedJobs.delete(next);
      saveCollapsedJobs();
      renderConversation(next);
    }
    const card = document.querySelector(`.job[data-thread="${CSS.escape(next)}"]`);
    if (card) {
      card.classList.add("maximized");
      const btn = card.querySelector(".btn-max");
      if (btn) {
        btn.textContent = "\u2921";
        btn.title = "shrink this chat back into the list (Esc)";
      }
      card.scrollIntoView({ block: "start" });
    }
    scrollThreadToBottom(next);
  }
}

// Put the newest output in view: the last turn's scrollback goes to its bottom, and so does the
// maximized card's body when the whole chat is pulled out.
function scrollThreadToBottom(thread) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return;
  const outs = [...card.querySelectorAll("pre.job-out")];
  const out = outs[outs.length - 1];
  if (out) out.scrollTop = out.scrollHeight;
  const body = card.querySelector(".job-body");
  if (card.classList.contains("maximized") && body) body.scrollTop = body.scrollHeight;
}

function foldAll(collapsed) {
  for (const c of conversations()) {
    if (collapsed) state.collapsedJobs.add(c.thread);
    else state.collapsedJobs.delete(c.thread);
  }
  saveCollapsedJobs();
  renderJobs();
}

// One-line summary shown while a card is minimized: the newest prose the agent
// wrote (its last thought, or the final answer once it is done), falling back to
// the newest thing it did.
function jobPreview(j) {
  const lines = jobLines(j.id);
  const from = Math.max(0, lines.length - 40);
  let fallback = null;
  for (let i = lines.length - 1; i >= from; i--) {
    const t = String(lines[i].text || "").replace(/\s+/g, " ").trim();
    if (!t || lines[i].kind === "cmd" || lines[i].kind === "dim") continue;
    if (lines[i].kind === "text") return t.slice(-150);
    if (!fallback) fallback = t.slice(-150);
  }
  if (fallback) return fallback;
  return j.status === "running" || j.status === "starting" ? "starting…" : "no output";
}

function refreshJobPreview(id) {
  const j = state.jobs.get(id);
  if (!j) return;
  const el = document.querySelector(`[data-preview="${CSS.escape(j.thread || j.id)}"]`);
  if (el) el.textContent = jobPreview(j);
}

// ---- conversations ------------------------------------------------------------
// Every turn of one thread is a separate CLI process, but they are one conversation: group
// them so the card reads top to bottom and the reply box continues the same session.
function conversations() {
  const groups = new Map();
  for (const j of state.jobs.values()) {
    const key = j.thread || j.id;
    const arr = groups.get(key) || [];
    arr.push(j);
    groups.set(key, arr);
  }
  const out = [];
  for (const [thread, turns] of groups) {
    turns.sort((a, b) => (a.turn || 1) - (b.turn || 1) || String(a.startedAt).localeCompare(String(b.startedAt)));
    out.push({ thread, turns, first: turns[0], latest: turns[turns.length - 1] });
  }
  out.sort((a, b) => String(b.latest.startedAt).localeCompare(String(a.latest.startedAt)));
  return out;
}

// URLs in agent output become links. They are opened by the panel (POST /api/open-url) rather than by
// navigating, so a webview host cannot swallow the click and the link lands in the OS default browser.
const OUT_URL_RE = /https?:\/\/[^\s<>"'`\u001b]+/g;

function linkifyText(text) {
  return esc(text ?? "").replace(OUT_URL_RE, (raw) => {
    let url = raw;
    let tail = "";
    // Sentence punctuation after a URL belongs to the sentence, not to the link.
    while (url && /[.,;:!?)\]]$/.test(url)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    // Looks like a real host: a dotted name, an IP, or localhost — a dev agent prints
    // http://localhost:5173/ constantly, and that is exactly the link worth clicking.
    const host = url.replace(/^https?:\/\//, "").split(/[/:?#]/)[0].toLowerCase();
    const plausible = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(".");
    if (!plausible) return raw;
    return `<a class="out-link" href="${url}" target="_blank" rel="noreferrer noopener" data-open-url="${url}" title="open in your browser">${url}</a>${tail}`;
  });
}

// A tool that runs for minutes is the one thing that makes a healthy turn look frozen — a 159 s
// recursive grep did exactly that, and the card showed nothing but the line that started it. Every
// line carries the server's timestamp, so the tool still in flight can grow a live clock.
// Lines lead with the tool's glyph (📖 read_file · path); history written before glyphs leads with ▸,
// so the arrow is optional and the glyph run is skipped before the name is taken.
const TOOL_START_RE = /^(?:▸\s*)?(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?([^\s·]+)/u;
const TOOL_DONE_RE = /^\s*↳\s*([^\s·]+)/;

// Index of the started tool call that has no result yet, or -1. Parallel calls interleave, so count
// starts and completions per tool name rather than assuming the last line is the running one.
function inflightToolIndex(lines) {
  const started = new Map();
  const finished = new Map();
  let lastIdx = -1;
  let lastName = null;
  lines.forEach((l, i) => {
    const text = String(l.text || "");
    const start = l.kind === "tool" ? TOOL_START_RE.exec(text) : null;
    if (start) {
      started.set(start[1], (started.get(start[1]) || 0) + 1);
      lastIdx = i;
      lastName = start[1];
      return;
    }
    const done = l.kind === "tool-out" ? TOOL_DONE_RE.exec(text) : null;
    if (done) finished.set(done[1], (finished.get(done[1]) || 0) + 1);
  });
  if (lastIdx < 0 || !lastName) return -1;
  return (started.get(lastName) || 0) > (finished.get(lastName) || 0) ? lastIdx : -1;
}

function liveLabel(secs) {
  const n = Math.max(0, Math.floor(secs));
  return ` · running ${n < 60 ? `${n}s` : `${Math.floor(n / 60)}m${String(n % 60).padStart(2, "0")}s`}`;
}

function liveSuffix(from) {
  return liveLabel((Date.now() - (Number(from) || Date.now())) / 1000);
}

// Redraws the clocks in place — never a repaint, so a scrolled console stays put while it ticks.
function tickLiveClocks() {
  for (const el of document.querySelectorAll("[data-live-from]")) {
    const from = Number(el.dataset.liveFrom) || Date.now();
    const secs = (Date.now() - from) / 1000;
    el.textContent = liveLabel(secs);
    // Past a minute it is the only moving part on the card, so it stops being quiet.
    el.classList.toggle("is-long", secs >= 60);
  }
}

setInterval(tickLiveClocks, 1000);

// The console is what the agent DID, not the run protocol around it. Three lines are bookkeeping: the POST
// that opened the run, the run id echoed back, and the completion summary with the token total. The card
// already states all three — the head carries "turn 2 · done · 26s · 186725 tok" and the foot the outcome —
// so they are stored but not drawn.
const BOOKKEEPING_LINES = new Set(["cmd", "init", "result"]);
function isBookkeeping(l) {
  return Boolean(l && BOOKKEEPING_LINES.has(l.kind));
}

function turnBody(turn, copy = "") {
  const lines = jobLines(turn.id).filter((l) => !isBookkeeping(l)).slice(-300);
  const running = turn.status === "running" || turn.status === "starting";
  // Which started tool call has no result yet. Parallel calls interleave, so count starts and
  // completions per tool name instead of assuming "the last line is the running one".
  const busy = running ? inflightToolIndex(lines) : -1;
  const body = lines
    .map((l, i) => {
      const live = i === busy ? `<span class="jl-live" data-live-from="${Number(l.at) || Date.now()}">${liveSuffix(Number(l.at) || Date.now())}</span>` : "";
      return `<div class="jl jl-${esc(l.kind || "raw")}" data-lid="${esc(l.lid ?? "")}">${linkifyText(l.text)}${live}</div>`;
    })
    .join("") || '<div class="jl jl-dim">waiting for output…</div>';
  return `<pre class="job-out" data-out="${esc(turn.id)}${esc(copy)}">${body}</pre>` +
    approvalPrompt(turn, copy) + approvalDecided(turn);
}

// The approval question belongs where the reading stopped: directly under the console output of the
// turn that is parked on it, not in a separate panel at the bottom of the card. It is a box that
// behaves like a popup (raised, bordered, the only thing asking for a decision) but it lives in the
// flow, so it never covers the output it is about.
function approvalPrompt(turn, copy = "") {
  const approval = turn.approval;
  if (!approval) return "";
  // A question only exists while its turn does. The panel's approval object can outlive the run — the
  // run errors, is cancelled, or its stream simply ends while the request is still attached — and a box
  // offering "Allow once" for a turn that is already dead is worse than no box. The terminal state of
  // the turn wins, and the error line left in its console is the record of what happened.
  const live = turn.status === "running" || turn.status === "starting";
  if (!live || turn.approvalDone) return "";
  const choices = Array.isArray(approval.choices) && approval.choices.length ? approval.choices : ["once", "deny"];
  const label = { once: "Allow once", session: "Allow for this session", always: "Always allow", deny: "Deny" };
  return `<div class="turn-approval" data-approval-for="${esc(turn.id)}${esc(copy)}">
    <div class="ta-head mono">⚠ waiting on you — this turn is parked until you answer</div>
    <pre class="ta-cmd mono">${esc(approval.command || "(no command text)")}</pre>
    <div class="ta-actions">
      ${choices.map((c) => `<button class="btn-approve${c === "deny" ? " btn-deny" : ""}" data-approve="${esc(turn.id)}" data-choice="${esc(c)}" data-request="${esc(approval.requestId || "")}" type="button" title="${esc(c === "deny" ? "refuse this command — the agent is told no and carries on without it" : `allow this command (${c})`)}">${esc(label[c] || c)}</button>`).join("")}
    </div>
  </div>`;
}

// Once answered the box collapses to one line: what was decided, about what.
function approvalDecided(turn) {
  const done = turn.approvalDone;
  if (!done || turn.approval) return "";
  const denied = String(done.choice || "").toLowerCase() === "deny";
  const verb = denied ? "denied" : `approved ${done.choice || ""}`.trim();
  return `<div class="turn-approval-done mono${denied ? " is-deny" : ""}" title="${esc(done.command || "")}">${denied ? "✕" : "✓"} ${esc(verb)}${done.command ? `: ${esc(String(done.command).slice(0, 140))}` : ""}</div>`;
}

// A turn is open when the reader opened it, otherwise only the newest turn is: opening an agent
// shows its current turn in full and lists the earlier ones as the single request line each.
// The pinned copy of a turn keeps its own open state (`pin:<id>`), so unfolding it never unfolds the
// original in the page — and a pinned turn starts folded.
function turnKey(turn, copy = "") {
  return copy === "@pin" ? `pin:${turn.id}` : turn.id;
}

function turnIsOpen(conv, turn, copy = "") {
  const forced = state.turnOpen.get(turnKey(turn, copy));
  if (forced !== undefined) return forced;
  if (copy === "@pin") return false;
  return turn.id === conv.latest.id;
}

function toggleTurn(key) {
  // The pinned duplicate toggles under its own key, so it opens and closes independently of the turn
  // it was cloned from.
  const pinnedCopy = key.startsWith("pin:");
  const id = pinnedCopy ? key.slice(4) : key;
  const turn = state.jobs.get(id);
  if (!turn) return;
  const conv = conversations().find((c) => c.thread === (turn.thread || turn.id));
  if (!conv) return;
  const copy = pinnedCopy ? "@pin" : "";
  state.turnOpen.set(key, !turnIsOpen(conv, turn, copy));
  renderConversation(conv.thread);
  // A turn that was just opened should show its newest lines, not its first line.
  if (turnIsOpen(conv, turn, copy)) {
    const pre = document.querySelector(`pre[data-out="${CSS.escape(id)}${copy}"]`);
    if (pre) pre.scrollTop = pre.scrollHeight;
  }
}

// Long conversations page their turns: five at a time, newest page first, because a thread with
// thirty turns is thirty transcript panes the reader almost never needs at once.
const TURNS_PER_PAGE = 5;

function turnPageOffset(thread, turnCount) {
  const pages = Math.max(1, Math.ceil(turnCount / TURNS_PER_PAGE));
  return Math.min(pages - 1, Math.max(0, state.turnPage.get(thread) || 0));
}

// `inline` puts the turn's request on the head line itself — the folded form is two rows: the head with
// the request, then one line saying what the turn is doing (or, once done, what it concluded).
function turnHead(turn, index, open, copy = "", inline = false) {
  const label = `turn ${turn.turn || index + 1}`;
  const pinned = state.pinnedTurns.has(turn.id);
  const state_ = turn.revived
    // Rebuilt from the gateway's store: there is no duration to report, and "done · 0s" claims a run
    // of zero seconds that never happened here.
    ? "revived"
    : turn.status === "running" || turn.status === "starting"
      ? `running ${elapsed(turn)}`
      : `${turn.status} · ${elapsed(turn)}${turn.tokens?.total ? ` · ${turn.tokens.total} tok` : ""}`;
  return `<div class="turn-head mono dimmer" data-turn-head="${esc(turn.id)}" data-toggle-turn="${esc(turnKey(turn, copy))}" title="${open ? "collapse" : "expand"} this turn"><button type="button" class="btn-star${pinned ? " on" : ""}" data-star-turn="${esc(turn.id)}" title="${pinned ? "unpin this turn" : "pin this turn above the paged turns"}">${pinned ? "\u2605" : "\u2606"}</button><span class="chev">${open ? "\u25be" : "\u25b8"}</span> <span class="turn-text">${esc(label)} · ${esc(state_)}</span>${inlinePrompt(turn, inline)}</div>`;
}

function inlinePrompt(turn, inline) {
  const text = inline ? displayPrompt(turn.prompt) : "";
  if (!text) return "";
  return `<span class="turn-prompt-inline" title="${esc(text)}">${esc(text)}</span>`;
}

// One turn: its head, then either the full prompt + output, or a single line carrying the request
// that turn was about. The one-line form is what makes a long conversation readable.
// `copy` marks the pinned duplicate's transcript so it cannot collide with the paged one.
// The prompt the agent was given vs the prompt the card shows. Attachment paths are appended to the
// request as a paragraph of machine text — the agent needs them, the reader has the chips for them — so
// that paragraph is stripped before the prompt is drawn.
const ATTACH_BLOCK_RE = /(?:\r?\n){1,2}Attachment: [^\n]*? — (?:read_file it|use vision_analyze on it) before answering\./g;
function displayPrompt(text) {
  return String(text || "").replace(ATTACH_BLOCK_RE, "").trim();
}

// What the reader attached to this turn, under its prompt: a link to the file, no x (the file is
// already part of this turn — removing it here would mean editing history the agent has seen).
function turnAttachmentsHtml(turn) {
  const list = Array.isArray(turn.attachments) ? turn.attachments : [];
  if (!list.length) return "";
  return `<div class="turn-attachments">${list
    .map(
      (a) =>
        `<button type="button" class="turn-attach mono" data-open-path="${esc(a.path)}" title="open ${esc(a.path)} in Notepad++">[${esc(a.name)}]</button>`,
    )
    .join("")}</div>`;
}

// The answer a turn ended on: the first sentence of what the agent said AFTER its last tool call. Not the
// console, not the tool output, not the thinking — the line a reader would have kept.
function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(s);
  const out = m ? m[1] : s;
  return out.length > 220 ? `${out.slice(0, 217)}…` : out;
}

function turnPeekLine(turn) {
  const lines = state.jobLines.get(turn.id) || turn.lines || [];
  if (!lines.length) return null;
  const running = turn.status === "running" || turn.status === "starting";
  if (running) {
    // What it is doing right now: the newest tool CALL, drawn exactly as the console draws it. The
    // completion line ("↳ terminal") is skipped while a call exists — swapping to it for two seconds
    // read as the peek going backwards.
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l && l.kind === "tool" && String(l.text || "").trim()) return { kind: "tool", text: String(l.text).trim() };
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l && l.kind === "tool-out" && String(l.text || "").trim()) return { kind: "tool", text: String(l.text).trim() };
    }
    return null;
  }
  // Finished: the first sentence it said after its last tool call.
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const k = lines[i] && lines[i].kind;
    if (k === "tool" || k === "tool-out") { last = i; break; }
  }
  const after = lines
    .slice(last + 1)
    .filter((l) => l && l.kind === "text" && String(l.text || "").trim())
    .map((l) => String(l.text).trim())
    .join(" ");
  const said = firstSentence(after);
  if (said) return { kind: "answer", text: said };
  // A turn that ended on a tool still has an answer somewhere: fall back to its last words.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l && l.kind === "text" && String(l.text || "").trim()) {
      return { kind: "answer", text: firstSentence(l.text) };
    }
  }
  return null;
}

function peekHtml(turn) {
  const peek = turnPeekLine(turn);
  if (!peek) return `<div class="turn-peek" data-peek-turn="${esc(turn.id)}" hidden></div>`;
  return `<div class="turn-peek${peek.kind === "tool" ? " is-tool" : ""}" data-peek-turn="${esc(turn.id)}" title="${esc(peek.text)}">${esc(peek.text)}</div>`;
}

// A folded turn has no console on the page, so the peek is repainted by hand as its lines arrive.
function refreshTurnPeek(turn) {
  if (!turn || !turn.id) return;
  for (const el of document.querySelectorAll(`.turn-peek[data-peek-turn="${CSS.escape(turn.id)}"]`)) {
    const peek = turnPeekLine(turn);
    el.hidden = !peek;
    el.classList.toggle("is-tool", Boolean(peek && peek.kind === "tool"));
    const text = peek ? peek.text : "";
    if (el.textContent !== text) el.textContent = text;
    el.title = text;
  }
}

function turnBlock(conv, turn, index, copy = "") {
  const open = turnIsOpen(conv, turn, copy);
  const tkey = turnKey(turn, copy);
  // The rail down the turns' left edge is violet while a turn is executing, slate otherwise, so `is-running`
  // is the only state the CSS needs from here.
  const running = turn.status === "running" || turn.status === "starting";
  const cls = `turn${open ? "" : " folded"}${running ? " is-running" : ""}`;
  if (!open) {
    // Two rows: the head carries the request, the peek carries what the turn is doing or concluded.
    return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, false, copy, true)}` +
      `${peekHtml(turn)}${turnAttachmentsHtml(turn)}</div>`;
  }
  return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, true, copy, true)}` +
    // The request stays on the head line whether the turn is open or folded: it is the turn's title either
    // way, and the open form used to drop it onto its own row, which pushed the transcript down for nothing.
    `${turnAttachmentsHtml(turn)}${turnBody(turn, copy)}</div>`;
}

// Every deliverable this conversation produced — files and URLs — in the order they were delivered.
function artifactsFor(conv) {
  const seen = new Map();
  for (const t of conv.turns) {
    for (const a of t.artifacts || []) {
      const key = String(a.path || a.url || "").toLowerCase();
      if (key && !seen.has(key)) seen.set(key, a);
    }
  }
  return [...seen.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
}

function baseNameOf(p) {
  return String(p || "").split(/[\\/]/).pop();
}

function closeArtifactPops() {
  state.openArtifacts.clear();
  for (const pop of document.querySelectorAll("[data-artifacts-pop]")) pop.hidden = true;
}

async function openArtifact(path) {
  try {
    const r = await apiFetch("/api/open-path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) showBanner(`open ${baseNameOf(path)}: ${d.error || `HTTP ${r.status}`}`);
  } catch (e) {
    showBanner(`open ${baseNameOf(path)}: ${e.message}`);
  }
}

async function openArtifactUrl(url) {
  try {
    const r = await apiFetch("/api/open-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) showBanner(`open ${url}: ${d.error || `HTTP ${r.status}`}`);
  } catch (e) {
    showBanner(`open ${url}: ${e.message}`);
  }
}

async function deleteArtifact(thread, key) {
  try {
    const r = await apiFetch("/api/jobs/artifact/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) showBanner(`delete: ${d.error || `HTTP ${r.status}`}`);
    renderArtifactsPop(thread);
  } catch (e) {
    showBanner(`delete: ${e.message}`);
  }
}

// navigator.clipboard needs a secure context; the panel is served over http on loopback, which
// browsers do NOT always treat as secure, so there is a textarea fallback behind it.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// One row per deliverable: the name (or the URL) opens it, `copy` takes the full location, `✕` asks
// before removing it. The path itself is not a column — it is on hover, which is where you look for it.
function artifactRowsHtml(list) {
  return list
    .map((a) => {
      const isUrl = a.kind === "url";
      const key = isUrl ? a.url : a.path;
      const name = isUrl ? String(a.url).replace(/^https?:\/\//, "") : baseNameOf(a.path);
      const openAttr = isUrl ? `data-open-url="${esc(a.url)}"` : `data-open-path="${esc(a.path)}"`;
      return `<div class="ap-row" data-artifact-key="${esc(key)}">
        <span class="ap-kind" title="${isUrl ? "URL" : "file"}">${isUrl ? "\u{1F517}" : "\u{1F4C4}"}</span>
        <button type="button" class="ap-name${isUrl ? " is-url" : ""}" ${openAttr} title="${esc(key)}">${esc(name)}</button>
        <button type="button" class="ap-copy mono" data-copy-path="${esc(key)}" title="copy the full ${isUrl ? "URL" : "path"}">copy</button>
        <button type="button" class="ap-del" data-del-artifact="${esc(key)}" title="${isUrl ? "remove from this list" : "delete this file from disk"}">✕</button>
      </div>`;
    })
    .join("");
}

function artifactsPopHtml(thread, list, openAt) {
  const position = openAt ? ` style="left:${openAt.left}px; top:${openAt.top}px"` : "";
  const hidden = openAt ? "" : " hidden";
  return `<div class="artifacts-pop" data-artifacts-pop="${esc(thread)}"${hidden}${position}>
      <div class="ap-head mono dimmer">${list.length} deliverable${list.length === 1 ? "" : "s"} — newest last</div>
      ${artifactRowsHtml(list)}
    </div>`;
}

// Rebuild one popup in place (after a delete, or a confirmation was cancelled) without touching the card.
function renderArtifactsPop(thread) {
  const pop = document.querySelector(`[data-artifacts-pop="${CSS.escape(thread)}"]`);
  const conv = conversations().find((c) => c.thread === thread);
  if (!pop || !conv) return;
  const list = artifactsFor(conv);
  if (!list.length) {
    closeArtifactPops();
    return;
  }
  pop.innerHTML = `<div class="ap-head mono dimmer">${list.length} deliverable${list.length === 1 ? "" : "s"} — newest last</div>${artifactRowsHtml(list)}`;
}

// --- the stats row above an agent's reply box ------------------------------------------------
// The CLI prints `~357K/1M │ [███░░░░░░░] ~34% │ ◎ 99.0% │ ◷ 4.2s │ ↑ 231 t/s` above its prompt;
// this is the same readout for the card. Each segment is independently optional because the gateway
// omits a figure it has no data for (no cache reads, no provider latency), and with no segments at
// all the row is not rendered — zeros there would claim knowledge we do not have.
function fmtTokens(n) {
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  const unit = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  if (unit[0] === 1) return String(Math.round(n));
  const scaled = abs / unit[0];
  const text = (scaled < 10 ? scaled.toFixed(2) : scaled < 100 ? scaled.toFixed(1) : scaled.toFixed(0))
    .replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `${n < 0 ? "-" : ""}${text}${unit[1]}`;
}

// A ten-cell meter whose tail cell is a partial block. Rounding to whole cells drew nothing at all
// below ~5%, so a nearly-empty context read as a bracketed hatch of ░ rather than a gauge; the eighth
// blocks keep a small value visible and the empty cells are middots, which stay clean at 11px.
function contextBar(pct, width = 10) {
  const safe = Math.max(0, Math.min(100, Number(pct) || 0));
  const PARTIAL = ["", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589"];
  const cells = (safe / 100) * width;
  const full = Math.min(width, Math.floor(cells));
  const tail = full < width ? PARTIAL[Math.min(7, Math.round((cells - full) * 8))] : "";
  return "\u2588".repeat(full) + tail + "\u00b7".repeat(Math.max(0, width - full - (tail ? 1 : 0)));
}

function statsLine(stats, model = null) {
  if (!stats || typeof stats !== "object") return "";
  const segs = [];
  const pct = Number.isFinite(stats.context_percent) ? stats.context_percent : null;
  const mark = stats.context_estimated ? "~" : "";
  const known = Number.isFinite(stats.context_used) && Number.isFinite(stats.context_max) && stats.context_max > 0;
  if (known) {
    segs.push(`${mark}${fmtTokens(stats.context_used)}/${fmtTokens(stats.context_max)}`);
    if (pct !== null) segs.push(`${contextBar(pct)} ${mark}${Math.round(pct)}%`);
  } else if (pct !== null) {
    segs.push(`${mark}${Math.round(pct)}%`);
  }
  if (Number.isFinite(stats.cache_hit_pct)) segs.push(`\u25ce ${stats.cache_hit_pct.toFixed(1)}%`);
  // Latency and throughput are the two figures the store does not record: they are computed over the
  // turn's wall clock minus its tool time, so they are marked as estimates rather than presented as
  // measurements. Cache, context and compactions are exact.
  const est = (flag) => (flag ? "~" : "");
  if (Number.isFinite(stats.avg_latency_s)) segs.push(`\u25f7 ${est(stats.latency_estimated)}${stats.avg_latency_s.toFixed(1)}s`);
  if (Number.isFinite(stats.avg_tps)) segs.push(`\u2191 ${est(stats.tps_estimated)}${Math.round(stats.avg_tps)} t/s`);
  // Shown even at 0: a compaction count that only appears after the first compaction reads as a
  // missing number, and this one is a real measurement.
  // Compactions get their own mark. \u29c9 was already the panel/agent glyph everywhere else in the board, so
  // the same square meant "an agent lives here" and "this transcript was compacted N times". A double arrow
  // pressed down reads as "condensed" and collides with nothing.
  if (Number.isFinite(stats.compressions)) segs.push(`\u21ca ${stats.compressions}`);
  if (!segs.length) return "";
  // The model leads the line: these figures describe what that model did, and the id's owner prefix is
  // dropped for width (the full id stays in the tooltip).
  const modelSeg = model
    ? `<span class="stat stat-model" title="${esc(model)}">${esc(String(model).split("/").pop())}</span>`
    : "";
  const title = "this session's usage: context occupancy, prompt-cache hit rate, and \u21ca = how many times the transcript was compacted into a summary; latency and t/s are estimated from the turn's wall clock (~)";
  const body = [modelSeg, segs.map((s) => `<span class="stat">${esc(s)}</span>`).join('<span class="stat-sep">\u2502</span>')]
    .filter(Boolean)
    .join('<span class="stat-sep">\u2502</span>');
  // A span, not a div: the readout belongs on the footer line with the outcome and the token count,
  // to their right, and a block element there costs a line of card height for nothing.
  return `<span class="job-stats mono" title="${esc(title)}">${body}</span>`;
}

// A failed turn can be asked again, but it is not a "retry" in the strict sense: the run is over, and re-sending
// the prompt starts a NEW turn in the same thread. The button says so in its tooltip rather than pretending the
// failed one will resume.
function turnRetryHtml(latest, thread) {
  if (!latest?.error || !retryableError(latest.error)) return "";
  if (latest.status === "running" || latest.status === "starting") return "";
  return ` <button type="button" class="btn-retry" data-retry-turn="${esc(thread)}" title="send this turn's prompt again as a NEW turn — the failed turn's edits are already on disk">retry</button>`;
}

function conversationHtml(conv) {
  const { thread, turns, latest } = conv;
  const collapsed = state.collapsedJobs.has(thread);
  const maximized = state.maximized === thread;
  const homeless = isHomelessConv(conv);
  const runningTurn = turns.find((t) => t.status === "running" || t.status === "starting");
  const running = Boolean(runningTurn);
  const queue = state.replyQueue.get(thread) || [];
  const queued = queue.length;
  const queuedTitle = queue.map((q, i) => `${i + 1}. ${q.text}`).join("\n");
  const runningNow = running;
  // A pending approval for this conversation means the agent is not thinking, it is waiting on you.
  const waitingApproval = [...state.approvals.values()].find((a) => a && a.thread && a.thread === thread) || null;
  // A run parks its own approval inside the turn (the Runs API path): same message, different
  // carrier, so the card can answer it without the CLI approval plugin.
  const runApproval = runningTurn?.approval || latest.approval || null;
  // The session's own name is the card's title, and it is set like the revive row's: bold, with how long ago
  // the thread was last used in the same dimmed grey next to it. The cwd only appears when a session has no
  // name at all.
  const titleHtml = latest.title
    ? `<span class="job-title mono" title="${esc(latest.title)}">${esc(latest.title)}</span>` +
      (latest.lastActiveAt
        ? `<span class="job-when mono" title="last used ${esc(new Date(latest.lastActiveAt).toLocaleString())}">${esc(fmtAgo(latest.lastActiveAt))}</span>`
        : "")
    : "";
  const meta = [
    latest.title ? null : latest.cwd ? `cwd ${latest.cwd}` : null,
    // Why this card is in the unattached panel: it has no worktree, or one that is not in the scan.
    homeless ? (latest.ownerPath ? `owner ${latest.ownerPath} (not in the scan)` : "no worktree") : null,
    // With usage figures present the model leads that strip instead (it is what the numbers belong to);
    // without them this line is the only place it can appear.
    latest.stats ? null : latest.model ? `model ${latest.model}` : "(default model)",
    latest.worktree ? `worktree ${latest.worktree}` : null,
    latest.existing ? "in existing worktree" : null,
    turns.length > 1 ? `${turns.length} turns` : null,
    // The run id is bookkeeping and it now sits at the end of the row, to the right of the turn count,
    // instead of leading the line.
    latest.runId ? `run ${String(latest.runId).replace(/^run_/, "").slice(0, 8)}` : null,
  ].filter(Boolean).join(" · ");
  // A run has no process to exit. The pool maps run status onto 0/1 so the old CLI card keeps
  // rendering, but printing "exit 0" for it reads as if a child process came and went — answer
  // "what happened" instead. A legacy CLI turn still has a real exit code worth showing.
  const outcome = latest.runId
    ? `${latest.status}${latest.exitCode && latest.exitCode !== 0 ? ` · exit ${latest.exitCode}` : ""}`
    : `exit ${latest.exitCode ?? "?"}`;
  // No clock here while a turn runs: the turn head already says "turn 2 - running 12s", and a second
  // counter a few lines above the reply box only pushed the box down.
  const foot = latest.status === "running" || latest.status === "starting"
    ? ""
    : latest.revived
      // Rebuilt from the gateway's session store, so there was never a process here: "exit ?" and
      // "0s" would both describe a run that did not happen in this panel. Say when it was last used.
      ? `<span class="mono dim">revived · last active ${esc(relTime(latest.startedAt))} ago</span>`
      : `<span class="mono dim">${esc(outcome)} · ${esc(elapsed(latest))}${latest.tokens?.total ? ` · tokens ${latest.tokens.total}` : ""}${latest.error ? ` · ${esc(latest.error)}` : ""}</span>${turnRetryHtml(latest, thread)}`;
  const artifacts = artifactsFor(conv);
  const blocks = (() => {
    const offset = turnPageOffset(thread, turns.length);
    const end = turns.length - offset * TURNS_PER_PAGE;
    const start = Math.max(0, end - TURNS_PER_PAGE);
    return { offset, start, end, html: turns.slice(start, end).map((t, i) => turnBlock(conv, t, start + i)).join("") };
  })();
  const pages = Math.max(1, Math.ceil(turns.length / TURNS_PER_PAGE));
  // Starred turns are repeated above the page — still accordions, and still present in their own
  // page, so pinning never moves a turn out from under its history.
  const pinned = turns.filter((t) => state.pinnedTurns.has(t.id));
  const pinnedHtml = pinned.length
    ? `<div class="pinned-turns">
        <div class="pinned-head mono"><span>\u2605 pinned</span><span class="dimmer">${pinned.length} of ${turns.length}</span></div>
        ${pinned.map((t) => turnBlock(conv, t, turns.indexOf(t), "@pin")).join("")}
      </div>`
    : "";
  const pager = pages > 1
    ? `<span class="turn-pager" title="turns ${blocks.start + 1}–${blocks.end} of ${turns.length} — page through them here">` +
      `<button type="button" class="pager-btn" data-turn-page="older" data-thread-page="${esc(thread)}"${blocks.offset >= pages - 1 ? " disabled" : ""} title="older turns">\u25b2</button>` +
      `<button type="button" class="pager-btn" data-turn-page="newer" data-thread-page="${esc(thread)}"${blocks.offset === 0 ? " disabled" : ""} title="newer turns">\u25bc</button>` +
      `<span class="pager-n mono">${blocks.start + 1}–${blocks.end} / ${turns.length}</span>` +
      `</span>`
    : "";
  const jumped = state.jumpThread && state.jumpThread.thread === thread && Date.now() < state.jumpThread.until ? " jump" : "";
  const zoom = state.consoleZoom.get(thread);
  return `<div class="job${collapsed ? " collapsed" : ""}${maximized ? " maximized" : ""}${jumped}" data-thread="${esc(thread)}" data-id="${esc(thread)}" data-sig="${esc(conversationSignature(conv))}"${zoom ? ` style="--out-size:${zoom}px"` : ""}>
    <div class="job-head" data-toggle="${esc(thread)}" title="${collapsed ? "expand" : "minimize"} this conversation">
      <span class="agent-glyph" title="a Hermes agent session — ⧉ marks an agent row">\u29c9</span>
      <span class="chev">${collapsed ? "\u25b8" : "\u25be"}</span>
      <span class="pill ${runningNow ? "pill-running" : `pill-notrunning${latest.status === "failed" ? " is-failed" : ""}`}" title="${esc(runningNow ? `running ${elapsed(latest)}` : `${latest.status} · ${elapsed(latest)}${latest.error ? ` · ${latest.error}` : ""}`)}">${runningNow ? "running" : latest.status === "failed" ? "exited" : "not-running"}</span>
      ${waitingApproval ? `<button class="sig sig-approval" data-approval-jump="${esc(waitingApproval.id)}" title="this agent is blocked on an approval — click to answer it">waiting on you →</button>` : ""}
      ${runApproval && !waitingApproval ? `<span class="sig sig-approval" title="this run is parked on a flagged command — answer it in the card below">waiting on approval</span>` : ""}
      ${titleHtml}
      ${meta ? `<span class="mono dim">${esc(meta)}</span>` : ""}
      ${artifacts.length ? `<button type="button" class="btn-artifacts" data-artifacts="${esc(thread)}" title="${artifacts.length} deliverable(s) from this agent — click to open, copy or delete them">\u{1F4C4} ${artifacts.length}</button>` : ""}
      ${pager}
      <span class="spacer"></span>
      ${latest.yolo ? '<span class="pill yolo">--yolo</span>' : ""}
      ${homeless ? `<button class="btn-attach" data-attach-toggle="${esc(thread)}" type="button" title="attach this agent to a worktree — it then lives under that row">\u2935 attach</button>` : ""}
      <span class="mono dimmer thread-name" data-thread-name="${esc(thread)}" data-label="${esc(latest.label || "")}" title="${latest.label ? esc(`${latest.label} — Hermes thread ${thread}`) : "Hermes session thread — continue it any time"}">${esc(latest.label || thread)}</span>
      <button class="btn-rename" data-rename-thread="${esc(thread)}" type="button" title="rename this session — a label for the panel only; the Hermes thread id never changes">\u270e</button>
      <button class="btn-max" data-max-thread="${esc(thread)}" type="button" title="${maximized ? "shrink this chat back into the list (Esc)" : "expand this chat to fill the window (Esc to close)"}">${maximized ? "\u2921" : "\u2922"}</button>
      <button class="btn-clear-thread" data-clear-thread="${esc(thread)}" type="button" title="forget this agent session — removes its turns and transcript from the panel (the worktree it made stays on disk)">✕</button>
    </div>
    ${collapsed ? `<div class="job-preview mono" data-preview="${esc(thread)}">${esc(jobPreview(latest))}</div>` : ""}
    ${homeless ? `<div class="attach-row" data-attach-row="${esc(thread)}" hidden>
      <span class="dimmer mono">attach to</span>
      <select data-attach-path="${esc(thread)}"></select>
      <button class="btn-attach-go" data-attach-go="${esc(thread)}" type="button">Attach</button>
    </div>` : ""}
    ${artifacts.length ? artifactsPopHtml(thread, artifacts, state.openArtifacts.get(thread)) : ""}
    <div class="job-body">
      ${pinnedHtml}
      ${blocks.html}
      ${queued ? `<div class="ghost-turns">${queue
        .map((q) => `<div class="ghost-turn"><div class="ghost-head mono"><span class="ghost-badge">queued</span><span class="queue-ago" data-queued-at="${q.at}">${fmtDur(Date.now() - q.at)}</span><span class="dimmer">sends when the current turn finishes</span></div><div class="ghost-prompt">${linkifyText(q.text)}</div></div>`)
        .join("")}</div>` : ""}
      ${foot ? `<div class="job-foot">${foot}</div>` : ""}
      <div class="reply">
        <div class="reply-wrap">
          <div class="attach-chips" data-chips="${esc(thread)}">${attachmentChipsHtml(thread)}</div>
          <textarea class="reply-box" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" data-reply="${esc(thread)}" rows="2" spellcheck="false"
            placeholder="${running ? "a turn is running — Enter steers it; Queue reply holds yours for the next turn" : "Reply to this agent — continues the same Hermes thread, Enter to send"}"></textarea>
          <div class="reply-actions">
            ${running
              ? `<button class="btn-reply btn-steer-primary" data-steer="${esc(runningTurn.id)}" type="button" title="send this into the running turn — the agent reads it at its next tool boundary and the turn carries on">Steer turn</button>`
              : `<button class="btn-reply" data-thread="${esc(thread)}" type="button" title="send this as the next turn (Enter)">Send reply</button>`}
            ${running ? `<button class="btn-queue" data-queue-reply="${esc(thread)}" type="button" title="hold this reply and send it the moment the current turn finishes">Queue reply</button>` : ""}
            ${queued ? `<span class="queue-note mono" title="${esc(queuedTitle)}">${queued} queued</span>` : ""}
            ${running ? `<button class="btn-cancel" data-id="${esc(runningTurn.id)}" type="button" title="cancel the run this agent is in the middle of">Cancel turn</button>` : ""}
          </div>
        </div>
        ${latest.stats ? `<div class="job-stats-row">${statsLine(latest.stats, latest.model || modelsState?.defaultModel || null)}</div>` : ""}
        <div class="reply-row">
          <span class="warnline" data-reply-warn="${esc(thread)}"></span>
        </div>
      </div>
    </div>
  </div>`;
}

function restoreReplyDraft(thread) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  if (box && state.replyDrafts[thread]) box.value = state.replyDrafts[thread];
}

// Typing state inside a card, so a rebuild can put it back. Row events arrive every few seconds for a
// fast-polling row, and the detail row is rebuilt on each one — without this, a half-typed reply was
// thrown away mid-sentence and the cursor went with it.
function captureTyping(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el) || !el.classList?.contains("reply-box")) return null;
  return { thread: el.dataset.reply, value: el.value, start: el.selectionStart, end: el.selectionEnd };
}

function restoreTyping(root, typing) {
  for (const box of root.querySelectorAll(".reply-box[data-reply]")) {
    const draft = state.replyDrafts[box.dataset.reply];
    if (draft) box.value = draft;
  }
  if (!typing) return;
  const box = root.querySelector(`.reply-box[data-reply="${CSS.escape(typing.thread)}"]`);
  if (!box) return;
  box.value = typing.value;
  state.replyDrafts[typing.thread] = typing.value;
  box.focus();
  try {
    box.setSelectionRange(typing.start, typing.end);
  } catch {
    /* a box that is no longer a text field: nothing to restore */
  }
}

// Renaming a session is a panel-side display name only: the Hermes thread id is identity (it is what
// resumes the conversation), so the label is kept beside the job store and never rewrites the id.
function beginRename(thread) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card || card.querySelector(".rename-input")) return;
  const span = card.querySelector(`[data-thread-name="${CSS.escape(thread)}"]`);
  if (!span) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input mono";
  input.maxLength = 80;
  input.spellcheck = false;
  // Keep password managers out: this is a session label, not a login. 1Password honours
  // data-1p-ignore; the rest are the same opt-out for Bitwarden, LastPass and Dashlane.
  input.setAttribute("data-1p-ignore", "");
  input.setAttribute("data-bwignore", "");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-form-type", "other");
  input.setAttribute("autocomplete", "off");
  input.value = span.dataset.label || "";
  input.placeholder = thread;
  span.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const value = input.value;
    input.replaceWith(span);
    if (save) void saveLabel(thread, value);
  };
  // The input sits inside a head that folds the card on click and a card that reacts to Enter, so
  // its keys stay here: Enter saves, Escape cancels, clicking away saves.
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function saveLabel(thread, label) {
  try {
    const r = await apiFetch("/api/jobs/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread, label }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    for (const j of d.jobs || []) state.jobs.set(j.id, j);
    renderConversation(thread);
  } catch (err) {
    showBanner(`rename ${thread}: ${err.message}`);
  }
}

// Ask the server to read one worktree now, from the ring on its row. The reply is only a receipt:
// the refreshed row arrives through the normal row event, so the row paints itself.
async function forceRowRead(btn) {
  const key = btn.dataset.refreshRow;
  const row = state.rows.get(key);
  if (!row || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  btn.classList.add("busy");
  try {
    const r = await apiFetch("/api/refresh/row", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: row.project, path: row.path }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // Apply the returned row directly: if nothing about the worktree changed, the server has no row
    // event to broadcast and the click would look like it did nothing (the ring would not reset).
    if (d.row) placeRow(row.project, d.row, {});
  } catch (err) {
    showBanner(`refresh ${row.name || row.path}: ${err.message}`);
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove("busy");
  }
}

// Put the caret back in an agent's reply box — after sending, so a follow-up can be typed straight
// away. Re-applied on the next tick because sending rebuilds the card (and so the textarea).
function focusReplyBox(thread) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  if (!box || box.disabled) return false;
  // preventScroll: the caller has just positioned the card; the browser's own scroll-to-focus would
  // yank the page again a frame later.
  box.focus({ preventScroll: true });
  const end = box.value.length;
  try {
    box.setSelectionRange(end, end);
  } catch {
    /* not a text field any more */
  }
  return document.activeElement === box;
}

// A real newline at the caret, for Shift+Enter. Doing it by hand rather than leaving it to the default
// action keeps the caret and the saved draft in step, and works the same in both message boxes.
function insertNewlineAtCaret(el) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.value = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
  const pos = start + 1;
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// Open a console URL with the OS default browser. Doing it through the panel means it works even when
// the page is hosted in something that blocks target=_blank.
async function openInBrowser(url) {
  if (!url) return;
  try {
    const r = await apiFetch("/api/open-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  } catch (err) {
    showBanner(`open ${url}: ${err.message}`);
  }
}

// Reply history: the prompts of this thread's earlier turns, oldest first. Up walks back through them,
// Down walks forward and finally back to whatever you were typing.
function turnPrompts(thread) {
  return [...state.jobs.values()]
    .filter((j) => (j.thread || j.id) === thread)
    .sort((a, b) => (a.turn || 0) - (b.turn || 0))
    .map((j) => String(j.prompt || "").trim())
    .filter(Boolean);
}

// A reply typed while the agent is still working: hold it and start it the moment that turn ends, so
// Hermes never sees a second session on the same thread at once (which it answers with "busy").
function queueReply(thread, text) {
  const q = state.replyQueue.get(thread) || [];
  q.push({ text, at: Date.now() });
  state.replyQueue.set(thread, q);
  renderConversation(thread);
}

function replyQueued(thread) {
  return state.replyQueue.get(thread) || [];
}

function threadBusy(thread) {
  return [...state.jobs.values()].some(
    (j) => (j.thread || j.id) === thread && (j.status === "running" || j.status === "starting"),
  );
}

async function drainReplyQueue(thread) {
  const q = replyQueued(thread);
  if (!q.length || threadBusy(thread)) return;
  const text = q.shift().text;
  if (!q.length) state.replyQueue.delete(thread);
  else state.replyQueue.set(thread, q);
  renderConversation(thread);
  try {
    await sendReply(thread, text);
  } catch {
    /* sendReply reports its own errors */
  }
}

// ---- New-agent prompt history ---------------------------------------------------------
// Shell-style recall for the spawn box: Up walks back through what you have spawned, Down walks
// forward, and whatever you were part-way through typing is kept as the "draft" at the end (back 0).
// Persisted, because the prompt worth reusing is usually from a previous session, not this one.
// (SPAWN_HISTORY_KEY / SPAWN_HISTORY_MAX live at the top of the file, above `state`.)

function loadSpawnHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(SPAWN_HISTORY_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((x) => typeof x === "string" && x.trim()).slice(-SPAWN_HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

function saveSpawnHistory() {
  try {
    localStorage.setItem(SPAWN_HISTORY_KEY, JSON.stringify(state.spawnHistory.slice(-SPAWN_HISTORY_MAX)));
  } catch {
    /* private mode / quota: history is a convenience, not state the panel needs */
  }
}

// Remember a prompt that actually spawned. Consecutive duplicates are noise — pressing Spawn twice
// with the same text should not make Up walk the same line twice.
function rememberSpawnPrompt(text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  if (state.spawnHistory[state.spawnHistory.length - 1] !== clean) {
    state.spawnHistory.push(clean);
    if (state.spawnHistory.length > SPAWN_HISTORY_MAX) {
      state.spawnHistory.splice(0, state.spawnHistory.length - SPAWN_HISTORY_MAX);
    }
    saveSpawnHistory();
  }
  state.spawnNav = null;
}

// step +1 = older, -1 = newer. Returns false when there is nothing to recall, so the caller can let
// the arrow key move the caret instead.
function recallSpawnPrompt(step) {
  const box = $("job-prompt");
  const prompts = state.spawnHistory || [];
  if (!prompts.length) return false;
  // Going forward with no walk in progress would just rewrite the same text and swallow the key.
  if (step < 0 && !(state.spawnNav && state.spawnNav.back > 0)) return false;
  // First Up captures what is in the box as the draft; later steps keep that original draft.
  const nav = state.spawnNav && state.spawnNav.back > 0 ? state.spawnNav : { back: 0, stash: box.value };
  const back = Math.max(0, Math.min(prompts.length, nav.back + step));
  const value = back === 0 ? nav.stash : prompts[prompts.length - back];
  state.spawnNav = { back, stash: nav.stash };
  box.value = value;
  const end = value.length;
  try {
    box.setSelectionRange(end, end);
  } catch {
    /* not a text field */
  }
  return true;
}

function recallReply(box, step) {
  const thread = box.dataset.reply;
  if (!thread) return;
  const prompts = turnPrompts(thread);
  if (!prompts.length) return;
  const nav = state.replyNav.get(thread) || { back: 0, stash: box.value };
  // `back` counts steps behind the draft: 0 = what you were typing, 1 = newest prompt, 2 = the one
  // before it, and so on.
  const back = Math.max(0, Math.min(prompts.length, nav.back + step));
  const value = back === 0 ? nav.stash : prompts[prompts.length - back];
  state.replyNav.set(thread, { back, stash: nav.stash });
  box.value = value;
  const end = value.length;
  try {
    box.setSelectionRange(end, end);
  } catch {
    /* not a text field */
  }
  state.replyDrafts[thread] = value;
}

async function sendReply(thread, preset = null) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  const typed = String(preset ?? box?.value ?? "").trim();
  const attached = attachmentBlock(thread);
  if (!typed && !attached) return;
  const text = typed + attached;
  const btn = document.querySelector(`.btn-reply[data-thread="${CSS.escape(thread)}"]`);
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch("/api/agents/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread, text, attachments: attachmentsFor(thread) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.replyDrafts[thread] = "";
    clearAttachments(thread);
    // A sent reply ends the history walk: the next Up starts from the newest prompt again.
    state.replyNav.delete(thread);
    // A queued reply must not wipe something the reader has since typed into the box.
    if (box && (preset == null || !box.value.trim())) box.value = "";
    updateJob(d.job, { scroll: true });
    // Sending a reply is you switching to the new turn: fold everything before it, including turns
    // you had opened by hand, so the card shows one full chat — the one you are now in — instead of
    // that one plus the scrollback you were reading a moment ago.
    focusNewTurn(thread, d.job.id);
    // Sending is one keystroke away from the follow-up: keep the caret in the box instead of dropping
    // it (the click on Send used to move focus to the button, and the rebuild replaces the textarea).
    focusReplyBox(thread);
    setTimeout(() => focusReplyBox(thread), 0);
    setTimeout(() => focusReplyBox(thread), 80);
  } catch (err) {
    const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
    if (warn) warn.textContent = `reply failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function steerTurn(thread, id, text, btn = null) {
  const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
  const typed = String(text ?? "").trim();
  const attached = attachmentBlock(thread);
  if (!typed && !attached) {
    focusReplyBox(thread);
    if (warn) warn.textContent = "type what the agent should do instead";
    return false;
  }
  const body = typed + attached;
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch("/api/jobs/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text: body, attachments: attachmentsFor(thread) }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      if (warn) warn.textContent = out.error || `steer refused (HTTP ${res.status})`;
      if (btn) btn.disabled = false;
      return false;
    }
    // The text went into the LIVE turn, so clear the draft: leaving it would invite sending the same
    // instruction twice, once as a steer and once as the next turn.
    state.replyDrafts[thread] = "";
    clearAttachments(thread);
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    if (box) box.value = "";
    if (warn) warn.textContent = "steered — the agent reads this at its next tool boundary";
    focusReplyBox(thread);
    return true;
  } catch (err) {
    if (warn) warn.textContent = `steer failed: ${err.message}`;
    if (btn) btn.disabled = false;
    return false;
  }
}

function jobHtml(j) {
  return conversationHtml({ thread: j.thread || j.id, turns: [j], first: j, latest: j });
}

// Make one turn the only open one in its conversation. Explicit per-turn state is dropped for the
// older turns (their default is "folded" once they are no longer the newest) and the new turn is
// pinned open, so a reply lands with the previous turn collapsed to its request line.
function focusNewTurn(thread, turnId) {
  // A new turn means the reader is back at the newest page.
  state.turnPage.delete(thread);
  for (const j of state.jobs.values()) {
    if ((j.thread || j.id) !== thread) continue;
    if (j.id === turnId) state.turnOpen.set(j.id, true);
    else state.turnOpen.delete(j.id);
  }
  renderConversation(thread);
  scrollThreadToBottom(thread);
}

// The worktree an agent's directory belongs to: an exact match on the row path, or the deepest row
// containing it (an agent started in a subdirectory still belongs to that worktree).
function matchWorktree(dir) {
  const d = normPath(dir).toLowerCase();
  if (!d) return null;
  let best = null;
  for (const r of state.rows.values()) {
    const p = normPath(r.path).toLowerCase();
    if (d !== p && !d.startsWith(`${p}/`)) continue;
    if (!best || p.length > best.path.length) best = r;
  }
  return best;
}

// Attach an unattached agent to a worktree: it then lives under that row, owned like any other.
async function attachAgent(thread, pathOverride = null) {
  const sel = document.querySelector(`[data-attach-path="${CSS.escape(thread)}"]`);
  const path = pathOverride || sel?.value;
  if (!path) return false;
  try {
    const r = await apiFetch("/api/jobs/attach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread, path }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    invalidatePanelMap();
    await resync();
    return true;
  } catch (err) {
    showBanner(`attach ${thread}: ${err.message}`);
    return false;
  }
}

// One agent's "forget this": two clicks, no modal. The first arms it (a stray click must not delete
// a transcript), the second within four seconds removes the conversation.
async function clearThread(btn) {
  const thread = btn.dataset.clearThread;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "✕ sure?";
    btn.classList.add("armed");
    clearTimeout(btn._disarm);
    btn._disarm = setTimeout(() => {
      btn.dataset.armed = "";
      btn.textContent = "\u2715";
      btn.classList.remove("armed");
    }, 4000);
    return;
  }
  clearTimeout(btn._disarm);
  btn.disabled = true;
  try {
    const r = await apiFetch("/api/jobs/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    for (const [id, j] of [...state.jobs]) {
      if ((j.thread || j.id) !== thread) continue;
      state.jobs.delete(id);
      state.jobLines.delete(id);
    }
    state.collapsedJobs.delete(thread);
    if (state.maximized === thread) setMaximized(null);
    renderJobs();
    repaintAgentState();
  } catch (err) {
    showBanner(`clear ${thread}: ${err.message}`);
    btn.disabled = false;
    btn.dataset.armed = "";
    btn.textContent = "\u2715";
    btn.classList.remove("armed");
  }
}

// ---- approvals ------------------------------------------------------------------
// Requests arrive from the Hermes approval-transport plugin (~/.hermes/plugins/worktree-panel).
// This only records the human's choice: Hermes owns the policy, the timeout and the fail-closed
// behaviour, and a request that expires here is denied there.
const APPROVAL_LABEL = { once: "Allow once", session: "Allow for session", always: "Always allow", deny: "Deny" };

function approvalCard(r) {
  const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
  const buttons = (r.allowed || ["once", "deny"])
    .map((c) => {
      const cls = c === "deny" ? "" : c === "once" ? ' class="primary"' : "";
      return `<button type="button"${cls} data-approval-id="${esc(r.id)}" data-approval-choice="${esc(c)}">${esc(APPROVAL_LABEL[c] || c)}</button>`;
    })
    .join("");
  return `<div class="approval" data-approval="${esc(r.id)}">
    <div class="ap-head"><span class="mono dim">${esc(r.surface || "agent")}</span>${r.thread ? `<button class="sig sig-panel" data-agent-thread="${esc(r.thread)}" title="jump to the agent blocked on this approval">⧉ agent</button>` : ""}<span class="spacer"></span><span class="mono ${left < 20 ? "warn" : "dimmer"}" data-approval-left="${esc(r.id)}">expires in ${left}s</span></div>
    <pre class="ap-cmd mono">${esc(r.command || "(no command text)")}</pre>
    ${r.description ? `<div class="ap-desc dim">${esc(r.description)}</div>` : ""}
    <div class="ap-actions">${buttons}<span class="ap-err mono"></span></div>
  </div>`;
}

function renderApprovals() {
  const sec = $("approvals");
  if (!sec) return;
  const list = [...state.approvals.values()].sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
  sec.hidden = list.length === 0;
  if (!list.length) {
    $("approval-list").innerHTML = "";
    return;
  }
  $("approval-chips").innerHTML = `<span class="chip bad">${list.length} waiting</span>`;
  $("approval-list").innerHTML = list.map(approvalCard).join("");
}

function tickApprovals() {
  for (const r of state.approvals.values()) {
    const el = document.querySelector(`[data-approval-left="${CSS.escape(r.id)}"]`);
    if (!el) continue;
    const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
    el.textContent = left ? `expires in ${left}s` : "expired";
    el.classList.toggle("warn", left < 20);
  }
}
setInterval(tickApprovals, 1000);

async function answerApproval(id, choice, btn) {
  const card = btn?.closest(".approval");
  const err = card?.querySelector(".ap-err");
  card?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  if (err) err.textContent = "";
  try {
    const res = await apiFetch("/api/approvals/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, choice }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (err) err.textContent = j.error || `HTTP ${res.status}`;
      card?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  } catch (e) {
    if (err) err.textContent = e.message;
    card?.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

// Every output pane's position, so a rebuild can put the reader back where they were instead of
// dropping them at the first line of an hour-old transcript.
function captureScrolls(root) {
  const map = new Map();
  if (!root) return map;
  for (const o of root.querySelectorAll("pre.job-out")) {
    map.set(o.dataset.out, {
      top: o.scrollTop,
      atBottom: o.scrollHeight - o.scrollTop - o.clientHeight < 32,
    });
  }
  return map;
}

function restoreScrolls(root, map) {
  if (!root || !map.size) return;
  for (const o of root.querySelectorAll("pre.job-out")) {
    const was = map.get(o.dataset.out);
    if (!was) continue;
    o.scrollTop = was.atBottom ? o.scrollHeight : Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight));
  }
}

// Put every console in this subtree back where the reader left it, from the remembered positions.
// Used after a subtree was rebuilt from scratch, where there is no old node to measure.
function applyStoredScrolls(root) {
  if (!root) return;
  for (const o of root.querySelectorAll("pre.job-out")) {
    const was = state.outScrolls[o.dataset.out];
    if (!was) continue;
    o.scrollTop = was.atBottom ? o.scrollHeight : Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight));
  }
}

// Rebuilding the unattached list is cheap but not free; anything that makes several rows appear at
// once (a boot pass, a discovery sweep) should coalesce into one repaint.
let jobsRefreshQueued = false;
function queueJobsRefresh() {
  if (jobsRefreshQueued) return;
  jobsRefreshQueued = true;
  requestAnimationFrame(() => {
    jobsRefreshQueued = false;
    renderJobs();
  });
}

// Rebuilding every card is the most expensive thing this page does, and a burst of job events (a spawn
// fanning out, several agents finishing at once) used to trigger it several times per frame. Coalesce
// to one rebuild per animation frame — the work is identical, only the count changes.
let renderJobsQueued = false;
function scheduleRenderJobs() {
  if (renderJobsQueued) return;
  renderJobsQueued = true;
  requestAnimationFrame(() => {
    renderJobsQueued = false;
    renderJobs();
  });
}

function renderJobs() {
  // Only unattached agents live here now: anything created in a worktree is listed under that
  // worktree's row, so this panel is the "homeless" workspace (project-root runs, pending spawns,
  // agents whose worktree was removed).
  const convs = homelessConversations();
  const nested = conversations().length - convs.length;
  for (const id of [...state.collapsedJobs]) if (!conversations().some((c) => c.thread === id)) state.collapsedJobs.delete(id);
  // Forgetting a cleared job's explicit turn state keeps the map from growing forever.
  const live = new Set([...state.jobs.keys()]);
  for (const id of [...state.turnOpen.keys()]) {
    // Pinned copies share the turn id with a `pin:` prefix; prune on the turn they belong to.
    if (!live.has(id.startsWith("pin:") ? id.slice(4) : id)) state.turnOpen.delete(id);
  }
  // Same for a cleared thread's remembered page.
  const threads = new Set([...state.jobs.values()].map((j) => j.thread || j.id));
  for (const t of [...state.turnPage.keys()]) if (!threads.has(t)) state.turnPage.delete(t);
  // The list is rebuilt wholesale, so remember where every open transcript was and put it back:
  // a `jobs` event must not cost the reader their place in an agent they are reading.
  const prevScrolls = captureScrolls($("jobs"));
  $("jobs").innerHTML = convs.length
    ? convs.map(conversationHtml).join("")
    : `<p class="empty">No unattached agents${nested ? ` — ${nested} agent${nested === 1 ? "" : "s"} listed under their worktree rows` : ""}.</p>`;
  restoreScrolls($("jobs"), prevScrolls);
  applyStoredScrolls($("jobs"));
  for (const c of convs) restoreReplyDraft(c.thread);
  const running = convs.filter((c) => c.turns.some((t) => t.status === "running" || t.status === "starting")).length;
  const folded = convs.filter((c) => state.collapsedJobs.has(c.thread)).length;
  const turns = [...state.jobs.values()].length;
  $("agents-chips").innerHTML =
    `<span class="chip">${convs.length} unattached</span>` +
    (nested ? `<span class="chip">${nested} in worktrees</span>` : "") +
    (turns > convs.length ? `<span class="chip">${turns} turns</span>` : "") +
    (running ? `<span class="chip warn">${running} running</span>` : "") +
    (folded ? `<span class="chip">${folded} minimized</span>` : "");
  const fold = $("btn-fold-jobs");
  if (fold) fold.textContent = convs.length && folded === convs.length ? "Expand all" : "Minimize all";
  // The cards were just rebuilt. Readers at the bottom stay at the bottom, readers scrolled up keep
  // their line, and only genuinely new cards jump to the newest output.
  restoreScrolls($("jobs"), prevScrolls);
  for (const c of convs) {
    if (state.collapsedJobs.has(c.thread)) continue;
    if (!prevScrolls.has(c.latest.id)) scrollThreadToBottom(c.thread);
  }
  paintAgentBadges();
  // The cards were just rebuilt from nothing, so a pending spawn target has to be re-applied here
  // too — renderConversation bails out to renderJobs() whenever the card did not exist yet.
  applyPendingFocus();
}

// Row badges ("⧉ 2 · 1 running") follow job events without rebuilding the table.
function paintAgentBadges() {
  for (const row of state.rows.values()) {
    const tr = document.querySelector(`tr.row[data-key="${CSS.escape(keyOf(row.project, row.path))}"]`);
    if (!tr) continue;
    const cell = tr.querySelector("td.name");
    const existing = cell?.querySelector("[data-open-row]");
    const html = agentBadgeHtml(row);
    if (existing && !html) {
      existing.remove();
      continue;
    }
    if (!html) continue;
    if (existing) existing.outerHTML = html;
    else cell?.insertAdjacentHTML("beforeend", ` ${html}`);
  }
}

function updateJob(j, { scroll = false } = {}) {
  const prev = state.jobs.get(j.id);
  const statusChanged = !prev || prev.status !== j.status;
  // A parked approval appearing or being answered changes what the ROW badge and the project chip say,
  // and neither follows a status change (a run stays "running" through both). Without this the row kept
  // advertising "awaiting approval" after the question was answered.
  const approvalChanged =
    Boolean(prev?.approval) !== Boolean(j.approval) ||
    String(prev?.approvalDone?.choice || "") !== String(j.approvalDone?.choice || "");
  const prevOwner = prev ? prev.ownerPath || null : null;
  const ownerChanged = (j.ownerPath || null) !== prevOwner;
  state.jobs.set(j.id, { ...prev, ...j });
  if (!state.jobLines.has(j.id) && j.lines?.length) state.jobLines.set(j.id, j.lines.slice());
  renderConversation(j.thread || j.id, { scroll });
  // Starting or finishing a turn changes what the worktree rows should say about themselves.
  if (statusChanged || approvalChanged) {
    repaintAgentState();
    // A queued reply goes out as soon as this thread has nothing running any more.
    const t = j.thread || j.id;
    if (!threadBusy(t)) void drainReplyQueue(t);
  }
  // Ownership decides which container the card belongs to — the unattached list or a worktree's
  // agents block. Repaint both sides the moment it changes (a spawn that starts out owned, a `-w`
  // tree appearing, an attach), instead of leaving the card where it was until the next snapshot.
  if (ownerChanged) {
    invalidatePanelMap();
    scheduleRenderJobs();
    for (const from of new Set([prevOwner, j.ownerPath || null].filter(Boolean))) {
      const want = normPath(from).toLowerCase();
      const row = [...state.rows.values()].find((r) => normPath(r.path).toLowerCase() === want);
      if (!row) continue;
      renderProjectRows(row.project);
      refreshChips(row.project);
    }
    reorderProjects();
  }
}

// What the card actually draws. If none of this changed, the DOM does not need rebuilding — and
// rebuilding is what used to throw the reader back to the top of a chat mid-read.
function conversationSignature(conv) {
  const turns = conv.turns.map((t) => `${t.id}:${t.status}:${t.exitCode ?? ""}:${t.error ? 1 : 0}`).join(",");
  // A run's approval lives on the TURN (Runs API), not in state.approvals. Without it here, a prompt
  // arriving mid-turn changes nothing in the signature, so the card is not repainted and the approval
  // box only appears whenever some unrelated event forces a rebuild (observed: ~20 s later).
  const runApprovals = conv.turns
    .map((t) => `${t.id}:${t.approval ? t.approval.requestId || t.approval.command || 1 : 0}:${t.approvalDone ? t.approvalDone.choice || 1 : 0}`)
    .join(",");
  const open = [...state.turnOpen].map(([k, v]) => `${k}${v ? 1 : 0}`).join(",");
  const approvals = [...state.approvals.values()]
    .filter((a) => a && a.thread === conv.thread)
    .map((a) => a.id)
    .join("|");
  const l = conv.latest;
  // Which page of turns this card is showing: paging back must survive a repaint, and paging is a
  // structural change (different turn blocks), so it belongs in the signature.
  const pageOffset = state.turnPage.get(conv.thread) || 0;
  const pinned = conv.turns.filter((t) => state.pinnedTurns.has(t.id)).map((t) => t.id).join(",");
  return [
    conv.thread,
    turns,
    pageOffset,
    pinned,
    open,
    l.label || "",
    // Queued replies show as a note next to the buttons; a change must repaint the card.
    (state.replyQueue.get(conv.thread) || []).length,
    state.collapsedJobs.has(conv.thread) ? "c" : "o",
    state.maximized === conv.thread ? "m" : "-",
    isHomelessConv(conv) ? "h" : "-",
    approvals,
    runApprovals,
    l.runId || "",
    l.cwd || "",
    l.model || "",
    l.yolo ? "y" : "",
    l.worktree || "",
    l.existing ? "e" : "",
    l.tokens?.total || "",
    // The stats row lives in the foot of the card: a new reading must repaint it, or the numbers
    // stay as they were until some unrelated event rebuilds the conversation.
    JSON.stringify(l.stats || null),
  ].join("~");
}

function renderConversation(thread, { scroll = false } = {}) {
  const conv = conversations().find((c) => c.thread === thread);
  const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!conv) return renderJobs();
  if (!el) return renderJobs();
  const sig = conversationSignature(conv);
  if (el.dataset.sig === sig) return;
  // Rebuild, then put the reader back exactly where they were: every output pane, the maximized
  // body, and the page itself. Following the newest output only happens when they were already at
  // the bottom (or when the caller explicitly asks for it, e.g. a freshly spawned turn).
  const prev = [...el.querySelectorAll("pre.job-out")].map((o) => ({
    id: o.dataset.out,
    top: o.scrollTop,
    atBottom: o.scrollHeight - o.scrollTop - o.clientHeight < 32,
  }));
  const prevBody = el.querySelector(".job-body");
  const bodyTop = prevBody ? prevBody.scrollTop : 0;
  const bodyAtBottom = prevBody ? prevBody.scrollHeight - prevBody.scrollTop - prevBody.clientHeight < 32 : true;
  const pageY = window.scrollY;
  const typing = captureTyping(el);
  const holder = document.createElement("div");
  holder.innerHTML = conversationHtml(conv);
  const fresh = holder.firstElementChild;
  fresh.dataset.sig = sig;
  el.replaceWith(fresh);
  restoreTyping(fresh, typing);
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  for (const o of fresh.querySelectorAll("pre.job-out")) {
    const was = prev.find((p) => p.id === o.dataset.out);
    const follow = scroll || (was ? was.atBottom : conv.latest.status === "running");
    if (follow) o.scrollTop = o.scrollHeight;
    else if (was) o.scrollTop = Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight));
  }
  const body = fresh.querySelector(".job-body");
  if (body) {
    body.scrollTop = bodyAtBottom ? body.scrollHeight : Math.min(bodyTop, Math.max(0, body.scrollHeight - body.clientHeight));
  }
  // A repaint replaces the card node, and the node that held the caret is gone with it — so a spawn
  // that asked for the reply box puts the caret back here, once the new card is in the document.
  applyPendingFocus();
}

// After a spawn the reader wants to be typing, not hunting: put that agent's card in view and its
// reply box under the cursor. Both have to survive the repaint that follows a spawn (the first job
// event rebuilds the card), so the target is remembered and re-applied after every render until it
// takes — or until the reader starts typing somewhere else, which is never interrupted.
function applyPendingFocus() {
  const pending = state.pendingFocus;
  if (!pending) return;
  if (Date.now() > pending.until) {
    state.pendingFocus = null;
    return;
  }
  // No "is something else focused" guard on purpose: right after a spawn the caret is still in the
  // New-agent box, which is exactly the state we are replacing. The reader taking over is signalled by
  // a click outside the card, a keypress or a wheel scroll, and each clears the target on its own.
  focusReplyBox(pending.thread);
  // The jump needs the same treatment as the caret: a smooth scroll is cancelled when the card is
  // rebuilt mid-animation, and that is why the page only sometimes followed the new agent. Keep the
  // card in view for a few seconds, and only until the reader takes over.
  if (Date.now() < (pending.scrollUntil || 0)) {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(pending.thread)}"]`);
    if (card) {
      const r = card.getBoundingClientRect();
      const outOfView = r.top < 48 || r.bottom > window.innerHeight - 48;
      if (outOfView) card.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }
}

// Cards for agents owned by a worktree are painted by the row-detail renderer, not by
// renderConversation/renderJobs, so a one-shot focus after a render is the wrong shape: a spawn can
// repaint through any of several paths. A cheap watch re-applies the caret while the target stands.
setInterval(applyPendingFocus, 250);

// Scrolling with the wheel is the reader taking over just as much as a click is: stop pulling the
// page back to the spawned agent.
document.addEventListener(
  "wheel",
  () => {
    if (state.pendingFocus) state.pendingFocus = null;
  },
  { passive: true }
);

function appendJobLine(evt) {
  const line = evt.line || {};
  const buf = state.jobLines.get(evt.id) || [];
  // mode "set" = the agent is still writing the same paragraph; that line grows in place
  // instead of a new one being pushed for every streamed fragment.
  const at = line.lid ? buf.findIndex((l) => l.lid === line.lid) : -1;
  if (line.mode === "set" && at >= 0) buf[at] = { ...buf[at], ...line };
  else buf.push(line);
  if (buf.length > 1000) buf.splice(0, buf.length - 1000);
  state.jobLines.set(evt.id, buf);
  // A folded turn shows only the peek, and it is not part of the console the lines are appended to.
  refreshTurnPeek(state.jobs.get(evt.id));
  // Kept in the buffer, never drawn: see BOOKKEEPING_LINES above.
  if (isBookkeeping(line)) return;
  // A pinned turn renders twice — in its page and in the pinned block above — so every pane carrying
  // this id (or its "@pin" copy) gets the line.
  const outs = [...document.querySelectorAll("pre.job-out")].filter(
    (el) => el.dataset.out === evt.id || el.dataset.out === `${evt.id}@pin`,
  );
  if (!outs.length) return;
  for (const out of outs) {
    // Streamed lines follow the newest output only for a reader who is already at the bottom; someone
    // scrolled up to read stays where they are.
    const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    if (out.firstElementChild?.classList.contains("jl-dim")) out.innerHTML = "";
    const existing = line.lid ? out.querySelector(`[data-lid="${CSS.escape(String(line.lid))}"]`) : null;
    if (line.mode === "set" && existing) {
      existing.innerHTML = linkifyText(line.text);
    } else {
      const div = document.createElement("div");
      div.className = `jl jl-${line.kind || "raw"}`;
      if (line.lid) div.dataset.lid = line.lid;
      div.innerHTML = linkifyText(line.text);
      out.appendChild(div);
    }
    if (stick) out.scrollTop = out.scrollHeight;
  }
  refreshJobPreview(evt.id);
}

async function retrySpawn() {
  const attempt = lastSpawnAttempt;
  if (!attempt) return;
  const btn = document.querySelector("[data-retry-spawn]");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "retrying…";
  }
  try {
    const r = await apiFetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(attempt.body) }, { timeoutMs: 60000 });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    lastSpawnAttempt = null;
    $("spawn-msg").textContent = `spawned ${d.job.id}${d.job.runId ? ` · run ${String(d.job.runId).replace(/^run_/, "").slice(0, 8)}` : ""}${d.job.worktreePath ? ` · ${d.job.worktreePath}` : ""}`;
    $("job-prompt").value = "";
    clearAttachments("spawn");
    updateJob(d.job, { scroll: true });
    revealSpawnedAgent(d.job);
  } catch (e) {
    const why = String(e.message || e);
    $("spawn-msg").innerHTML = spawnMsgHtml(why);
  }
}

// The companion to the timeout above: a spawn whose answer never arrived still owns a card. Re-read the
// board once and, if a turn exists with this prompt from the last three minutes, treat the spawn as
// done — clear the box, say it started, and walk the reader to the card exactly as a normal spawn does.
async function recoverSpawnAfterTimeout(body) {
  try {
    await resync();
    const wanted = String(body.prompt || "").trim();
    const cutoff = Date.now() - 180_000;
    const hit = [...state.jobs.values()].find(
      (j) => String(j.prompt || "").trim() === wanted && Date.parse(j.startedAt || 0) >= cutoff,
    );
    if (!hit) return false;
    $("job-prompt").value = "";
    rememberSpawnPrompt(wanted);
    $("spawn-msg").textContent = `spawned ${hit.id} — the reply was lost, but the turn did start`;
    updateJob(hit, { scroll: true });
    revealSpawnedAgent(hit);
    return true;
  } catch {
    return false;
  }
}

// ---- retry ---------------------------------------------------------------------------------
// A retry button is only worth having when the same request could plausibly work now. Retrying a missing API
// key, an unknown project or an unborn HEAD just loops, and those already have their own fix ("make the first
// commit") or their own cause to repair. So the errors are split: transient (offer retry) and everything else
// (offer nothing, which is honest).
function retryableError(message) {
  const s = String(message || "");
  if (!s) return false;
  if (/did not answer within|timed out|timeout|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network error|EAI_AGAIN|gateway accepted the request but returned no run_id/i.test(s)) return true;
  const http = /HTTP (\d{3})/.exec(s);
  if (http) return Number(http[1]) >= 500 || Number(http[1]) === 429;
  if (/rate limit|rate-limited|429|overloaded|temporarily unavailable/i.test(s)) return true;
  return false;
}

// The last spawn that failed. Re-sent as-is: re-reading the form would let the reader's later edits silently
// change what the retry means, and it is their prompt, not ours to rewrite.
let lastSpawnAttempt = null;

function spawnMsgHtml(why) {
  return `${esc(`spawn failed: ${why}`)}${retryableError(why) ? ` <button type="button" class="btn-retry" data-retry-spawn="1" title="send the same spawn request again — the failed attempt created nothing">retry</button>` : ""}`;
}

async function spawnAgent() {
  const body = formValues();
  const typed = String(body.prompt || "").trim();
  if (!typed) {
    $("spawn-msg").textContent = "a prompt is required";
    return;
  }
  // The chips stay chips on screen; their paths are appended here, where the request is built.
  body.prompt = typed + attachmentBlock("spawn");
  // The same list rides along as data, so the turn's card can list what it was given.
  body.attachments = attachmentsFor("spawn");
  $("btn-spawn").disabled = true;
  lastSpawnAttempt = { body: { ...body } };
  try {
    const r = await apiFetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { timeoutMs: 60000 });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    lastSpawnAttempt = null;
    $("spawn-msg").textContent = `spawned ${d.job.id}${d.job.runId ? ` · run ${String(d.job.runId).replace(/^run_/, "").slice(0, 8)}` : ""}${d.job.worktreePath ? ` · ${d.job.worktreePath}` : ""}`;
    // The prompt now belongs to an agent: clear the box so the next one starts blank, and keep it in
    // history so a single Up brings it straight back. A REFUSED spawn keeps the text for editing.
    rememberSpawnPrompt(typed);
    $("job-prompt").value = "";
    clearAttachments("spawn");
    $("job-prompt").focus();
    updateJob(d.job, { scroll: true });
    // Take the reader to the new agent: unfold folder/project/worktree and scroll to its card.
    revealSpawnedAgent(d.job);
  } catch (e) {
    const why = String(e.message || e);
    // The one refusal with an obvious one-click fix: the repo has no commits, so there is no HEAD for a
    // worktree to branch from. Offer the commit here rather than making the reader open a terminal.
    if (/unborn HEAD|has no commits yet/i.test(why)) {
      const dir = body.cwd || $("job-cwd").value.trim() || "";
      $("spawn-msg").innerHTML = `${esc(`spawn failed: ${why}`)} <button type="button" class="btn-fix-first" data-first-commit="${esc(dir)}" data-first-commit-run="1" title="create an empty initial commit in that repository — local only, nothing is pushed">make the first commit</button>`;
    } else {
      $("spawn-msg").innerHTML = spawnMsgHtml(why);
    }
    // A lost reply does not mean a lost turn: the gateway can die after the run was created, and the
    // card then arrives on its own while the form still holds the text — which reads exactly like a
    // spawn that never happened. Look for it before asking the reader to type it again.
    if (/did not answer within/.test(why)) void recoverSpawnAfterTimeout(body);
  } finally {
    $("btn-spawn").disabled = false;
  }
}

// ---- the model picker -----------------------------------------------------------------------
// A run may name a model; the panel does not choose the provider, so "(default)" is whatever the
// gateway is configured with, and a spawn then sends no model at all. The list comes from
// /api/models, which reads the provider list Hermes itself fetched — not a hardcoded menu.
let modelsState = null;

function modelOptionHtml(d) {
  const def = d?.defaultModel || null;
  const out = [`<option value="">${esc(def ? `(default: ${def})` : "(gateway default)")}</option>`];
  for (const p of d?.providers || []) {
    out.push(`<optgroup label="${esc(p.label)}">`);
    for (const m of p.models) out.push(`<option value="${esc(m)}">${esc(m)}</option>`);
    out.push("</optgroup>");
  }
  return out.join("");
}

function renderModelPicker(keep = "") {
  const sel = $("job-model");
  if (!sel) return;
  sel.innerHTML = modelOptionHtml(modelsState);
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  const d = modelsState;
  // Say how old the list is: it is a cache of what the provider advertised, not a live call.
  sel.title = d?.count
    ? `${d.count} model${d.count === 1 ? "" : "s"} available to ${d.provider || "this account"}, list fetched ${d.fetchedAt ? `${relTime(d.fetchedAt)} ago` : "at an unknown time"}${d.staleDays > 7 ? " — stale, run: hermes model --refresh" : ""}`
    : "no provider list found in the Hermes home — a run falls back to the gateway's configured model";
}

async function loadModels() {
  const keep = $("job-model")?.value || "";
  try {
    const r = await apiFetch("/api/models");
    modelsState = r.ok ? await r.json() : null;
  } catch {
    modelsState = null;
  }
  renderModelPicker(keep);
}

// The spawn target: one entry per discovered project, most recently worked on first.
function syncProjectPicker(projects) {
  const sel = $("job-project");
  const keep = sel.value;
  sel.innerHTML = projects.length
    ? projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.activityAt ? ` · ${relTime(p.activityAt)}` : ""}</option>`).join("")
    : '<option value="">(no projects)</option>';
  if (keep && projects.some((p) => p.name === keep)) sel.value = keep;
  // The startup location is a plain editable field; keep suggestions and the default in step.
  const dl = $("project-paths");
  if (dl) dl.innerHTML = projects.map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join("");
  const cur = selectedProject();
  if (cur && !$("job-cwd").value.trim()) $("job-cwd").value = cur.path;
  // The spawn list is where `empty` is authoritative (it is recomputed on every discovery), and the board
  // keeps its own copy of each project. Mirror it, so a repo that just got its first commit stops looking
  // empty everywhere rather than in the warning only.
  for (const p of projects) {
    const known = state.projects.get(p.name);
    if (known && typeof p.empty === "boolean") known.empty = p.empty;
  }
  updateSpawnNote();
}

function selectedProject() {
  const name = $("job-project").value;
  return (state.spawn.projects || []).find((p) => p.name === name) || null;
}

function updateSpawnNote() {
  const p = selectedProject();
  const cwd = $("job-cwd").value.trim();
  const where = cwd || p?.path || state.spawn.defaultCwd || "?";
  const custom = Boolean(cwd) && Boolean(p) && cwd !== p.path;
  // The checkbox is "create workspace": ticked means a new tree, unticked means run in the folder as it is.
  const create = $("job-create").checked;
  $("spawn-note").textContent = create
    ? `run · new worktree under ${where}/.worktrees/` +
      (custom ? " · custom location (differs from the selected project)" : ` · project ${p ? p.name : "(none)"}`)
    : `runs IN ${where} (no new worktree${state.spawnTarget ? ` · ${state.spawnTarget}` : ""}); edits land in that tree`;
  // A repo with no commits has no HEAD to branch from, so the panel cannot create a worktree in it.
  const emptyRepo = Boolean(p) && Boolean(p.empty) && (!cwd || cwd === p.path);
  const warn = $("spawn-warn");
  // The one-click fix lives HERE, not only in the message a failed spawn leaves behind: the button is
  // disabled before the spawn is ever attempted, so the refusal never happens and the reader was left
  // with a command to retype by hand.
  warn.innerHTML = emptyRepo
    ? `${esc(`${p.name} has no commits yet (unborn HEAD), so no worktree can be cut from it. `)}` +
      `<button type="button" class="btn-fix-first" data-first-commit="${esc(p.path)}" title="create an empty initial commit in that repository — local only, nothing is pushed">make the first commit</button>`
    : "";
  $("btn-spawn").disabled = emptyRepo;
}

// Open a row and bring its agents block into view (used by the row's ⧉ badge).
function openAgentsBlock(key) {
  if (!state.expanded.has(key)) document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  const block = document.querySelector(`tr.detail[data-detail="${CSS.escape(key)}"] .agents-block`);
  if (block) block.scrollIntoView({ block: "nearest" });
  else document.querySelector(`tr.detail[data-detail="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
}

// The per-worktree "\u25b6": run an agent INSIDE that existing worktree (no new tree at all).
// Any click that aims one of the fixed cards must also show it: filling in a form the reader cannot
// see is worse than not aiming it at all.
function revealCard(id) {
  if (!state.collapsedFixed.has(id)) return;
  state.collapsedFixed.delete(id);
  saveCollapsedFixed();
  applyFixedCollapse(id);
}

// Aiming the spawn card must also SHOW it. The top bar is sticky, so `scrollIntoView({block:"start"})`
// parks the card's own header underneath it, and focusing the prompt afterwards scrolls the textarea to
// the bottom of the window — together they pushed the whole card above the fold (measured: card top at
// -349px while the caret sat in the prompt). Scroll to just below the bar, then focus without letting
// the browser scroll again.
function scrollCardUnderBar(card) {
  const bar = document.querySelector(".topbar");
  const offset = (bar?.getBoundingClientRect().height || 0) + 12;
  const top = window.scrollY + card.getBoundingClientRect().top - offset;
  // Instant, not smooth: a smooth animation across a thousand rows is cancelled by the board's own
  // repaint (the page height changes under it) and stops wherever it happened to be — which is how the
  // card kept ending up half-visible.
  window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  // Re-assert after the paint has settled. The board repaints on its own clock and a trait like `.armed`
  // changing the card's border can shift the document under us; one follow-up scroll is cheaper than a
  // card the reader cannot see. Re-computed from the card's CURRENT rect, not the stale one.
  const again = () => {
    const bar2 = document.querySelector(".topbar");
    const off2 = (bar2?.getBoundingClientRect().height || 0) + 12;
    const want = Math.max(0, window.scrollY + card.getBoundingClientRect().top - off2);
    if (Math.abs(want - window.scrollY) > 2) window.scrollTo({ top: want, behavior: "auto" });
  };
  requestAnimationFrame(again);
  setTimeout(again, 120);
}

function focusPromptWithoutScrolling() {
  const prompt = $("job-prompt");
  if (!prompt) return;
  try {
    prompt.focus({ preventScroll: true });
  } catch {
    prompt.focus(); // an engine without focus options: the scroll above has already put it in view
  }
}

function focusSpawnForWorktree(path, name) {
  revealCard("newagent");
  $("job-cwd").value = path;
  // Aiming at a worktree that exists means "run here": no new workspace.
  $("job-create").checked = false;
  state.spawnTarget = name || null;
  updateSpawnNote();
  const card = $("newagent");
  card.classList.add("armed");
  setTimeout(() => card.classList.remove("armed"), 1400);
  scrollCardUnderBar(card);
  focusPromptWithoutScrolling();
}

// The green "+": aim the spawn card at that project and put the cursor in the prompt.
function focusSpawn(projectName) {
  revealCard("newagent");
  if (projectName) {
    const p = (state.spawn.projects || []).find((x) => x.name === projectName);
    $("job-project").value = projectName;
    // The green "+" is the "start work here" gesture: point the location field at that project.
    if (p) $("job-cwd").value = p.path;
    // ...and that means a NEW worktree in that project, not the project folder itself.
    $("job-create").checked = true;
    state.spawnTarget = null;
    updateSpawnNote();
  }
  const card = $("newagent");
  card.classList.add("armed");
  setTimeout(() => card.classList.remove("armed"), 1400);
  scrollCardUnderBar(card);
  focusPromptWithoutScrolling();
}

function formValues() {
  return {
    prompt: $("job-prompt").value,
    // An explicitly edited location wins over the project picker (the server prefers `cwd`).
    cwd: $("job-cwd").value.trim() || undefined,
    // true = run in that directory as-is (an existing worktree), no new worktree created. The checkbox says
    // the opposite ("create workspace"), so this is where the two meet.
    existing: !$("job-create").checked,
    project: $("job-project").value || undefined,
    model: $("job-model").value.trim() || undefined,
    budget: Number($("job-budget").value) || undefined,
    maxTurns: Number($("job-maxTurns").value) || undefined,
    // No skills / yolo here on purpose: a run carries input, cwd, model, max_turns and run_budget.
    // The form keeps those two controls visible but disabled rather than pretending they work.
  };
}

// ---------------- worktrees ----------------
// The panel's own agents, mapped to the worktree they work in. Rendered straight from the job
// list so a just-started agent shows up immediately, without waiting for the next scan.
function panelAgentsByPath() {
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const map = new Map();
  const add = (p, j) => {
    if (!p) return;
    const k = norm(p);
    const cur = map.get(k) || { running: 0, total: 0, threads: [] };
    cur.total += 1;
    if (j.status === "running" || j.status === "starting") cur.running += 1;
    if (!cur.threads.includes(j.thread)) cur.threads.push(j.thread);
    map.set(k, cur);
  };
  for (const j of state.jobs.values()) {
    if (j.existing || j.reply) add(j.cwd, j);
    if (j.worktreePath) add(j.worktreePath, j);
  }
  return map;
}

// Jump from a worktree row to the agent card it belongs to.
// Clicking a project's panel chip while something is running: open the folder, the project and the row
// that hold the first live agent, then land on that card with the caret in its reply box. Every step is a
// different accordion, and the card does not exist in the DOM until the row is open, so the scroll is
// re-asserted on the next frames rather than measured once too early.
// Order the project's rows the way the board draws them, so "the top agent" is the one the reader would
// hit first scrolling down: an open row keeps its slot, the rest are ranked.
function rowsInBoardOrder(projectName) {
  const rows = [...state.rows.values()].filter((r) => r.project === projectName);
  const dom = [...document.querySelectorAll("tr.row")]
    .filter((el) => String(el.dataset.key || "").startsWith(`${projectName}::`))
    .map((el) => el.dataset.key);
  const pos = new Map(dom.map((k, i) => [k, i]));
  return rows.sort((a, b) => {
    const ka = keyOf(projectName, a.path);
    const kb = keyOf(projectName, b.path);
    const pa = pos.has(ka) ? pos.get(ka) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(kb) ? pos.get(kb) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

// The first card of one row, newest first — the card that sits at the top of that row's agents block.
function topAgentOf(row) {
  const agents = agentsFor(row);
  if (!agents.length) return null;
  const latest = (c) => Number(Date.parse((c.turns || []).at(-1)?.startedAt || 0)) || 0;
  return [...agents].sort((a, b) => latest(b) - latest(a))[0];
}

function jumpToPanelAgent(projectName, { running = false } = {}) {
  let found = null;
  for (const r of rowsInBoardOrder(projectName)) {
    const agents = agentsFor(r);
    const pick = running
      ? agents.find((c) => (c.turns || []).some((x) => x.status === "running" || x.status === "starting"))
      : topAgentOf(r);
    if (!pick) continue;
    const turn = (pick.turns || []).find((x) => x.status === "running" || x.status === "starting") || (pick.turns || []).at(-1);
    found = { row: r, thread: pick.thread, turnId: turn ? turn.id : null };
    break;
  }
  if (!found) return;
  const project = state.projects.get(projectName);
  const root = project ? rootOf(project) : null;
  if (root && state.collapsedRoots.has(root)) toggleRoot(root);
  if (!state.expandedProjects.has(projectName)) toggleProject(projectName);
  const key = keyOf(projectName, found.row.path);
  if (!state.expanded.has(key)) document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  // The live turn shows its console only while it is open; a reader who folded it would land on a header.
  if (running && found.turnId && state.turnOpen.get(found.turnId) === false) {
    state.turnOpen.set(found.turnId, true);
    renderConversation(found.thread);
  }
  if (state.collapsedJobs.has(found.thread)) {
    state.collapsedJobs.delete(found.thread);
    saveCollapsedJobs();
    renderConversation(found.thread);
  }
  const land = () => {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(found.thread)}"]`);
    if (!card) return;
    // Center it: a card pinned under the sticky bar is "visible" by the numbers and useless to read.
    card.scrollIntoView({ block: "center", behavior: "auto" });
    state.jumpThread = { thread: found.thread, until: Date.now() + 1700 };
    card.classList.add("jump");
    setTimeout(() => {
      if (state.jumpThread && state.jumpThread.thread === found.thread) state.jumpThread = null;
      // Look the node up again: a running card is rebuilt on every job event, so the node captured here
      // may already be detached, and the class it carries is not part of the render signature.
      document.querySelector(`.job[data-thread="${CSS.escape(found.thread)}"]`)?.classList.remove("jump");
    }, 1700);
    state.pendingFocus = { thread: found.thread, until: Date.now() + 20_000, scrollUntil: Date.now() + 6_000 };
    applyPendingFocus();
  };
  requestAnimationFrame(land);
  setTimeout(land, 120);
  setTimeout(land, 400);
}

function jumpToAgent(thread) {
  if (!thread) return;
  revealCard("agents");
  if (state.collapsedJobs.has(thread)) {
    state.collapsedJobs.delete(thread);
    saveCollapsedJobs();
    renderConversation(thread);
  }
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) {
    $("jobs").scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.add("jump");
  setTimeout(() => card.classList.remove("jump"), 1700);
  // Remember the target so a repaint (which replaces this node) lands the caret back in it. The jump
  // keeps re-asserting itself for a few seconds: smooth scrolling dies when the card is rebuilt.
  state.pendingFocus = { thread, until: Date.now() + 20_000, scrollUntil: Date.now() + 6_000 };
  applyPendingFocus();
}

// The star of a turn as it appears in the page (not the pinned copy), so a pin/unpin can anchor on it.
function findTurnStar(thread, turnId) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return null;
  const stars = [...card.querySelectorAll(`[data-star-turn="${CSS.escape(turnId)}"]`)];
  return stars.find((b) => !b.closest(".pinned-turns")) || stars[0] || null;
}

// After a spawn, follow the agent home: unfold its folder, its project and its worktree row, then
// bring the card into view and flash it. A `-w` spawn has no owner for a few seconds and its row is
// only discovered once the tree exists, so this watches for up to ~30s and then gives up quietly.
function revealSpawnedAgent(job, deadlineMs = 30_000) {
  const started = Date.now();
  const attempt = () => {
    const thread = job?.thread;
    if (!thread) return;
    const live = state.jobs.get(job.id) || job;
    const owner = live.ownerPath;
    const row = owner
      ? [...state.rows.values()].find((r) => normPath(r.path).toLowerCase() === normPath(owner).toLowerCase())
      : null;
    if (!row) {
      if (Date.now() - started > deadlineMs) {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        if (card) jumpToAgent(thread); // nowhere better to go: show it where it is
        return;
      }
      setTimeout(attempt, 700);
      return;
    }
    const project = state.projects.get(row.project);
    const root = project ? rootOf(project) : "";
    if (root && state.collapsedRoots.has(root)) {
      state.collapsedRoots.delete(root);
      saveCollapsedRoots();
      applyRootCollapse(root);
    }
    if (!state.expandedProjects.has(row.project)) toggleProject(row.project);
    const key = keyOf(row.project, row.path);
    if (!state.expanded.has(key)) {
      document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
    }
    // Sections and rows are built synchronously by the two calls above; wait one frame so layout is
    // settled before scrolling, then land on the card itself. If the card is not painted yet (the run
    // posted back before its first job event arrived), keep trying instead of giving up on frame one
    // — that race is why the jump only sometimes happened.
    requestAnimationFrame(() => {
      jumpToAgent(thread);
      if (!document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`) && Date.now() - started < deadlineMs) {
        setTimeout(attempt, 400);
      }
    });
  };
  attempt();
}

// The panel's own agents are the freshest evidence there is — we are literally driving the process
// — so the chip and the row's liveness must follow the job list, not the last git scan. The map is
// memoized per job change because sigChips runs once per row.
let panelMapCache = null;
function panelMap() {
  if (!panelMapCache) panelMapCache = panelAgentsByPath();
  return panelMapCache;
}
function invalidatePanelMap() {
  panelMapCache = null;
  agentsByPathCache = null;
}

// Agents grouped by the worktree that OWNS them (set when the agent was created), so a row can
// list its own agents. Conversations with no owner are "homeless" and stay in the Agents panel.
let agentsByPathCache = null;
function agentsByPath() {
  if (agentsByPathCache) return agentsByPathCache;
  const map = new Map();
  for (const c of conversations()) {
    const owner = c.latest.ownerPath || c.first.ownerPath || null;
    if (!owner) continue;
    const k = normPath(owner).toLowerCase();
    const list = map.get(k) || [];
    list.push(c);
    map.set(k, list);
  }
  agentsByPathCache = map;
  return map;
}

function agentsFor(row) {
  return agentsByPath().get(normPath(row.path).toLowerCase()) || [];
}

// Threads that already have a card somewhere on the board, so a session the row reports is never
// offered for revival when it is already there.
function knownThreads() {
  return new Set([...state.jobs.values()].map((j) => j.thread || j.id));
}

// Rebuild the card for a session the gateway still has. The conversation never went anywhere — what
// was lost was the panel's record pointing at it — so this asks the server for one, after which a
// reply runs as another turn on the same session id, exactly like any other agent on the board.
async function reviveSession(btn) {
  const sessionId = btn.dataset.reviveSession;
  const path = btn.dataset.revivePath;
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = "reviving…";
  try {
    const r = await apiFetch("/api/sessions/revive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, path }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // The server already emitted a job event; applying it here too makes the card appear even if
    // this tab's stream happens to be between reconnects.
    if (d.job) updateJob(d.job, { scroll: true });
    await resync();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = was;
    showBanner(`revive ${sessionId}: ${e.message}`);
  }
}

function agentsRunning(list) {
  return list.filter((c) => c.latest.status === "running" || c.latest.status === "starting").length;
}

function isAgentRunning(conv) {
  return conv.latest.status === "running" || conv.latest.status === "starting";
}

function isHomelessConv(conv) {
  const owner = conv.latest.ownerPath || conv.first.ownerPath || null;
  if (!owner) return true;
  const k = normPath(owner).toLowerCase();
  return ![...state.rows.values()].some((r) => normPath(r.path).toLowerCase() === k);
}

function homelessConversations() {
  // Unattached = no owner, or an owner that is not a row we can show (project root runs, or a
  // worktree that has since been removed). Without this such an agent would fall off the screen.
  return conversations().filter(isHomelessConv);
}

// The worktrees an agent can be attached to, grouped project-first for a readable picker.
function worktreeOptionsHtml() {
  const rows = [...state.rows.values()].sort(
    (a, b) => String(a.project).localeCompare(String(b.project)) || String(a.name).localeCompare(String(b.name)),
  );
  return rows
    .map((r) => `<option value="${esc(r.path)}">${esc(r.project)} · ${esc(r.name)}${r.branch ? ` (${esc(r.branch)})` : ""}</option>`)
    .join("");
}
function panelFor(row) {
  return panelMap().get(normPath(row.path).toLowerCase()) || null;
}
// A row is live if a signal fired OR one of our agents is running in it right now.
function isRowLive(row) {
  return Boolean(row.live) || Boolean(panelFor(row)?.running);
}

// The chip's tooltip: what the evidence is, then which sessions it is — numbered, one per line. A native
// tooltip honors the newlines, so the list reads as a list instead of one long run-on line.
function hermesTitle(head, titles) {
  const list = (titles || []).map((x) => String(x || "").trim()).filter(Boolean);
  if (!list.length) return head;
  const numbered = list.map((x, i) => `${i + 1}. ${x}`).join("\n");
  return `${head}\n\n${numbered}`;
}

function sigChips(row) {
  const s = row.signals || {};
  const out = [];
  // The label says only WHO the evidence is (a Hermes session external to this panel). Whether it is
  // working right now lives in the tooltip: "hermes running" read as a second kind of chip.
  if (s.hermes?.on) {
    const head = s.hermes.running
      ? "A Hermes agent external to this application is actively taking turns in this worktree."
      : `Hermes session open here${s.hermes.matched === "work" ? " — placed by its newest tool calls, not its start directory" : ""}.`;
    out.push(`<span class="sig sig-hermes" title="${esc(hermesTitle(head, s.hermes.titles))}">⧉ hermes</span>`);
  }
  if (s.board?.on) out.push(`<span class="sig sig-board" title="board entry, PID alive now: ${esc((s.board.entries || []).map((e) => e.pid).join(', '))}">● board</span>`);
  if (s.ports?.on) out.push(`<span class="sig sig-port" title="dev server listening: ${esc((s.ports.listening || []).join(', '))}">:${esc((s.ports.listening || []).join(' :'))}</span>`);
  if (s.files?.on) out.push(`<span class="sig sig-files" title="files edited ${relTime(s.files.at)} ago">✎ files</span>`);
  // The row's panel agents are already drawn as the ⧉ badge beside its name — same count, same running
  // state — so a second "⧉ panel" chip here just said it twice. The badge opens the row and its agents.
  return out.join("");
}

// Repaint only the chip strip of one row, so a turn starting/finishing lands instantly instead of
// waiting for that row's next scan (which can be 45-90s away).
function paintRowChips(row) {
  const cell = document.querySelector(`td.age[data-key="${CSS.escape(keyOf(row.project, row.path))}"]`);
  const holder = cell?.querySelector(".sigs");
  if (!holder) return;
  const html = sigChips(row);
  if (holder.innerHTML !== html) holder.innerHTML = html;
}

function repaintAgentState() {
  invalidatePanelMap();
  for (const row of state.rows.values()) paintRowChips(row);
  // The ⧉ badge in a row's name cell carries "awaiting approval", so it has to be repainted here too —
  // it is not part of the chips, and it was the one thing left stale after an answer.
  paintAgentBadges();
  for (const name of state.projects.keys()) refreshChips(name);
  // An agent starting or finishing changes where its project belongs: bring it up (or let it settle)
  // without waiting for the next 30s snapshot, in every folder the reader is not working in.
  reorderProjects();
}

function livenessLines(row) {
  const s = row.signals || {};
  const lines = [];
  if (s.hermes?.on)
    lines.push(
      `Hermes session active here${s.hermes.running ? " (a turn is executing right now)" : ""}: ${(s.hermes.titles || []).map((t) => `"${t}"`).join(" · ")}` +
        (s.hermes.matched === "work" ? " — placed by its newest tool calls, not its start directory" : ""),
    );
  else if (s.hermes?.idle) lines.push(`Hermes session open here but idle (${s.hermes.idle})`);
  if (s.board?.on) lines.push(`Board: PID ${(s.board.entries || []).map((e) => e.pid).join(", ")} — alive now`);
  else if (s.board?.dead) lines.push(`Board: ${s.board.dead} entr${s.board.dead === 1 ? "y" : "ies"}, none with a live PID`);
  if (s.ports?.on) lines.push(`Dev server: :${(s.ports.listening || []).join(", ")} listening`);
  else if (s.ports?.declared?.length) lines.push(`Dev server: declared :${(s.ports.declared || []).join(", ")} — nothing listening`);
  if (s.files?.on) lines.push(`Files edited ${relTime(s.files.at)} ago`);
  lines.push(row.live ? `Verdict: live via ${row.liveWhy || "?"}` : "Verdict: not live — no session, board entry or listening port");
  return lines;
}

// One badge per row saying how many agents this worktree owns, and how many are running.
function agentBadgeHtml(row) {
  const mine = agentsFor(row);
  if (!mine.length) return "";
  const running = agentsRunning(mine);
  // A parked approval is the one state that needs the reader, and it used to be invisible the moment
  // the row was collapsed — the badge only ever said "running".
  const waiting = mine.filter((c) =>
    (c.turns || []).some((t) => t.approval && (t.status === "running" || t.status === "starting")),
  ).length;
  const cls = waiting ? "sig-approval" : running ? "sig-panel" : "sig-panel-done";
  const bits = [waiting ? `${waiting} awaiting approval` : null, running ? `${running} running` : null].filter(Boolean);
  return `<button class="sig ${cls}" data-open-row="${esc(keyOf(row.project, row.path))}" title="${mine.length} agent${mine.length === 1 ? "" : "s"} owned by this worktree${waiting ? `, ${waiting} parked on a permission request — click to answer it` : running ? `, ${running} running` : ""} — click to open the row and its agents">⧉ ${mine.length}${bits.length ? ` · ${bits.join(" · ")}` : ""}</button>`;
}

// ---- removing a worktree ---------------------------------------------------------------------
// The red ✕ opens an inline confirmation row under the tree: the question says where the files go
// (Recycle Bin) rather than just "delete?", and nothing happens until the second click.
function showWorktreeConfirm(key) {
  document.querySelectorAll("tr.row-confirm").forEach((el) => el.remove());
  const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  const row = state.rows.get(key);
  if (!rowEl || !row) return;
  const confirm = document.createElement("tr");
  confirm.className = "row-confirm";
  confirm.dataset.confirmRow = key;
  // One cell across every column, not a message cell plus the narrow actions column: the table is laid out at a
  // fixed width, so the 3% actions column could not hold two buttons and they were pushed past the card's edge,
  // where `.project`'s overflow clipped them and nothing could be clicked.
  // The flex layout lives on a div INSIDE the cell: a td with `display:flex` stops being a table cell and loses
  // its colspan, which collapsed this row to its content width instead of the card's.
  confirm.innerHTML = `<td colspan="10">
      <div class="row-confirm-cell">
        <span class="rc-msg"><span class="dimmer">Remove worktree</span> <b>${esc(row.name)}</b> <span class="dimmer">on</span> <span class="mono">${esc(row.branch || "—")}</span><span class="dimmer">? Its files go to the Recycle Bin (recoverable there) and git's record of it is pruned.</span></span>
        <span class="rc-actions"><button class="btn-del-no" type="button" data-del-tree-no="${esc(key)}">Cancel</button><button class="btn-del-yes" type="button" data-del-tree-yes="${esc(key)}">Delete</button></span>
      </div>
    </td>`;
  rowEl.after(confirm);
}

// The scanner runs on its own clock, so the board only knows a worktree is gone once a pass has been
// round it. Waiting for the counter to move is what stops a row reappearing from a pass that began
// before the delete.
async function scanTick() {
  try {
    const s = await apiFetch("/api/stats").then((r) => r.json());
    return Number(s?.scheduler?.ticks) || 0;
  } catch {
    return null;
  }
}

async function waitForScanPass(baseline, { timeoutMs = 25000 } = {}) {
  if (baseline === null) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 700));
    const now = await scanTick();
    if (now !== null && now > baseline) return true;
  }
  return false;
}

async function confirmDeleteWorktree(key) {
  const [project, ...rest] = key.split("::");
  const target = rest.join("::");
  const confirmEl = document.querySelector(`tr.row-confirm[data-confirm-row="${CSS.escape(key)}"]`);
  const yes = confirmEl?.querySelector("[data-del-tree-yes]");
  const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  const cross = rowEl?.querySelector("[data-del-tree]");
  // The request is fire-and-forget, so the click has to look REGISTERED: the x greys out and stops
  // accepting clicks, the confirmation keeps its "deleting…" label, and both stay that way until the
  // scan has caught up.
  if (cross) {
    cross.disabled = true;
    cross.classList.add("pending");
    cross.title = "deleting this worktree — waiting for the next scan";
  }
  if (yes) {
    yes.disabled = true;
    yes.textContent = "deleting…";
  }
  const baseline = await scanTick();
  try {
    const r = await apiFetch("/api/worktree/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, path: target }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      showBanner(`delete worktree: ${d.error || `HTTP ${r.status}`}`);
      if (cross) {
        cross.disabled = false;
        cross.classList.remove("pending");
        cross.title = "remove this worktree — its files go to the Recycle Bin and git's record of it is pruned";
      }
      if (yes) {
        yes.disabled = false;
        yes.textContent = "Delete";
      }
      return;
    }
    if (yes) yes.textContent = "waiting for the scan…";
    // Everything the board must wait for: the scanner finishing a pass that saw the worktree already
    // gone. Only then is the row dropped here — before it, a pass that started earlier can still put
    // the row back on screen for a folder that no longer exists.
    await waitForScanPass(baseline);
    confirmEl?.remove();
    // Drop it here too: the server broadcasts a `drop`, but a tab whose stream hiccuped would keep a
    // row for a worktree that is gone, and this is the tab that asked for the deletion.
    removeRow(project, d.rowPath || target);
    showBanner(
      d.alreadyGone
        ? `worktree row removed — the folder was already gone (${d.name || target})`
        : `worktree removed to the Recycle Bin (${d.name || target})${d.branch ? ` on ${d.branch}` : ""}`,
    );
  } catch (e) {
    showBanner(`delete worktree: ${e.message}`);
    if (cross) {
      cross.disabled = false;
      cross.classList.remove("pending");
    }
    if (yes) {
      yes.disabled = false;
      yes.textContent = "Delete";
    }
  }
}

function rowHtml(row) {
  const isOpen = state.expanded.has(keyOf(row.project, row.path));
  const dirty =
    row.dirty || row.untracked
      ? `<span class="dirty">${row.dirty}</span>${row.untracked ? ` <span class="dimmer">+${row.untracked}?</span>` : ""}`
      : `<span class="clean">clean</span>`;
  const pr = row.pr
    ? `<span class="${row.pr.state === "OPEN" ? "pr-open" : "pr-merged"}" title="${esc(row.pr.title || "")}">#${row.pr.number} ${esc(row.pr.state)}</span>`
    : row.remoteBranch === "gone"
      ? `<span class="dimmer">none · branch gone</span>`
      : `<span class="dimmer">none</span>`;
  const badge = `<span class="badge ${verdictClass(row.verdict)}${row.verdictStale ? " stale" : ""}">${esc(row.verdict)}</span>`;
  // The project's own checkout is not a worktree anyone may delete from here.
  const projectRoot = state.projects.get(row.project)?.path;
  const isProjectRoot = projectRoot && normPath(projectRoot).toLowerCase() === normPath(row.path).toLowerCase();
  return `<tr class="row${isOpen ? " expanded" : ""}" data-key="${esc(keyOf(row.project, row.path))}">
    <td class="name"><button class="btn-row-agent" data-agent-path="${esc(row.path)}" data-agent-name="${esc(row.name)}"
      title="start a Hermes agent in this worktree — it runs here (no new worktree)">\u25b6</button> <span>${esc(row.name)}</span> ${agentBadgeHtml(row)}</td>
    <td class="mono branch">${esc(row.branch || "—")}</td>
    <td class="mono dim nowrap">${esc(row.head || "—")}</td>
    <td class="mono nowrap">${row.ahead === null ? "—" : `<span class="${row.ahead ? "dirty" : "dimmer"}">${row.ahead}</span> / ${row.behind ?? "—"}`}</td>
    <td class="mono dim nowrap">+${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}</td>
    <td>${pr}</td>
    <td class="mono nowrap">${dirty}</td>
    ${ageCellHtml(row)}
    <td>${badge}</td>
    <td class="row-actions">${isProjectRoot ? "" : `<button class="btn-del-tree" data-del-tree="${esc(keyOf(row.project, row.path))}" title="remove this worktree — its files go to the Recycle Bin and git's record of it is pruned">✕</button>`}</td>
  </tr>`;
}

// ---- the age column: last life seen, plus a ring that fills toward the next read --------------
// The number is NOT "time since last poll" (that is the ring): it is the last moment any liveness
// evidence fired for this worktree. The ring fills up to the moment the row is due to be read again,
//
// The cadence the server sends is what the scheduler WOULD apply; when the panel is behind (a big
// fleet, a slow repo) the real gap is longer, so the ring is sized to the observed gap once we
// have one -- otherwise it empties 30s in and then sits empty for a minute, which reads as broken.
const RING_C = 2 * Math.PI * 6;

function noteScan(row) {
  const key = keyOf(row.project, row.path);
  const t = Date.parse(row.scannedAt || "");
  if (!Number.isFinite(t)) return;
  const configured = Math.max(1, Number(row.pollSeconds || state.settings.worktreeSeconds || 5));
  const prev = state.lastScanAt.get(key);
  if (Number.isFinite(prev) && t > prev) {
    const gap = (t - prev) / 1000;
    // A 30s resync can be the first time we see two scans of a 5s row; that gap (30s) says nothing
    // about how often the row is really read, so only gaps inside a sane multiple are believed.
    if (gap > 0 && gap <= configured * 4) {
      const smoothed = state.pollGap.has(key) ? state.pollGap.get(key) * 0.6 + gap * 0.4 : gap;
      state.pollGap.set(key, smoothed);
    }
  }
  state.lastScanAt.set(key, t);
}

function ringState(row) {
  const now = Date.now();
  const scanned = Date.parse(row.scannedAt || "");
  const configured = Math.max(1, Number(row.pollSeconds || state.settings.worktreeSeconds || 5));
  const observed = state.pollGap.get(keyOf(row.project, row.path)) || 0;
  // Never shorter than the configured cadence, never more than 10x it (a stuck row must not turn
  // into a 10-minute ring that looks frozen).
  const every = Math.max(configured, Math.min(Math.round(observed), configured * 10));
  const total = every * 1000;
  const remain = Number.isFinite(scanned) ? Math.max(0, scanned + total - now) : 0;
  const overdue = Number.isFinite(scanned) ? Math.max(0, now - (scanned + total)) : 0;
  const frac = Math.min(1, remain / total);
  // The ring counts UP to the next read: empty the moment a row is scanned, full and green when it is
  // due again. `frac` is what is left, `fill` is what has elapsed.
  return { now, scanned, configured, every, total, remain, overdue, frac, fill: 1 - frac };
}

function ringOffset(st) {
  // The drawn length is circumference minus offset, so leaving `frac` undrawn means the arc grows as
  // the row approaches its next read: empty just after a scan, full when the row is due.
  return (RING_C * st.frac).toFixed(2);
}

function ringStroke(st) {
  if (st.overdue > st.total * 0.5) return "var(--red)";
  if (st.overdue > 0) return "var(--amber)";
  return st.fill >= 0.9 ? "var(--green)" : "var(--dim)";
}

function ageCellHtml(row) {
  const alive = Date.parse(row.lastAliveAt || "");
  const label = Number.isFinite(alive) ? fmtDur(Date.now() - alive) : "never live";
  const st = ringState(row);
  return `<td class="age nowrap" data-key="${esc(keyOf(row.project, row.path))}">
      <span class="age-line"><span class="age-num${Number.isFinite(alive) ? "" : " dimmer"}">${esc(label)}</span><button class="poll-btn" data-refresh-row="${esc(keyOf(row.project, row.path))}" type="button" title="read this worktree now"><svg class="poll-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle class="poll-track" cx="8" cy="8" r="6" fill="none" stroke-width="2"></circle>
        <circle class="poll-arc" cx="8" cy="8" r="6" fill="none" stroke-width="2" transform="rotate(-90 8 8)" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${ringOffset(st)}" stroke="${ringStroke(st)}"></circle>
      </svg></button></span><span class="sigs">${sigChips(row)}</span></td>`;
}

function paintAgeCell(cell, row) {
  const st = ringState(row);
  const arc = cell.querySelector(".poll-arc");
  if (arc) {
    // Only write the attributes that actually moved: this runs for every visible row every second,
    // and an unnecessary attribute write on an SVG node still costs style invalidation.
    const off = ringOffset(st);
    const stroke = ringStroke(st);
    if (arc.getAttribute("stroke-dashoffset") !== off) arc.setAttribute("stroke-dashoffset", off);
    if (arc.getAttribute("stroke") !== stroke) arc.setAttribute("stroke", stroke);
  }
  // A running panel agent IS life, observed by us, whatever the last scan said.
  const running = panelFor(row)?.running;
  const alive = running ? st.now : Date.parse(row.lastAliveAt || "");
  const live = Number.isFinite(alive);
  const num = cell.querySelector(".age-num");
  if (num) {
    num.textContent = live ? fmtDur(st.now - alive) : "never live";
    num.classList.toggle("dimmer", !live);
  }
  const cadence = st.every === st.configured ? `every ${st.every}s` : `every ${st.every}s, observed (configured ${st.configured}s)`;
  const title =
    `last life ${live ? `${fmtDur(st.now - alive)} ago${running ? " (a panel agent is running here now)" : ""}` : "never seen"} · polled ${relTime(row.scannedAt)} ago · ` +
    `next read ${st.remain > 0 ? `in ${Math.ceil(st.remain / 1000)}s` : `due now${st.overdue > st.total ? ` (overdue ${fmtDur(st.overdue)})` : ""}`} (${cadence})`;
  if (cell.title !== title) cell.title = title;
}

function detailHtml(row) {
  const parts = [];
  const dirty = row.dirtyFiles || [];
  const untr = row.untrackedFiles || [];
  const commits = row.unmergedCommits || [];
  if (dirty.length) {
    parts.push(`<div class="col"><h4>Modified (${dirty.length})</h4><ul>${dirty.map((f) => `<li><span class="dimmer">${esc(f.code)}</span> ${esc(f.path)}</li>`).join("")}</ul></div>`);
  }
  if (untr.length) {
    parts.push(`<div class="col"><h4>Untracked (${untr.length})</h4><ul>${untr.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>`);
  }
  const pm = state.projects.get(row.project) || {};
  if (commits.length) {
    parts.push(
      `<div class="col"><h4>Commits not on ${esc(pm.remoteRef || "remote main")}${row.diffSummary ? ` · ${esc(row.diffSummary)}` : ""}</h4><ul>${commits
        .map((c) => `<li><span class="dimmer">${esc(c.sha)}</span> ${esc(c.subject)}</li>`)
        .join("")}</ul></div>`,
    );
  }
  // The git side of the row (state, commit list, dirty files, diff summary) folds into one line:
  // opening a worktree is about seeing its agents and what is unmerged, not a wall of file names.
  const key = keyOf(row.project, row.path);
  // Liveness evidence folds too; collapsed, its strongest line stays visible to the right of the
  // header, because "why is this row live" is the one thing worth seeing without unfolding.
  const liveLines = livenessLines(row);
  const liveOpen = state.liveOpen.has(key);
  const liveBlock = `<div class="live-block${liveOpen ? "" : " collapsed"}" data-live-block="${esc(key)}">
      <div class="live-head" data-toggle-live="${esc(key)}" title="${liveOpen ? "fold" : "unfold"} the liveness evidence">
        <span class="chev">${liveOpen ? "\u25be" : "\u25b8"}</span>
        <h4>Liveness evidence</h4>
        ${liveOpen ? "" : `<span class="live-first mono" title="${esc(liveLines[0] || "no evidence")}">${esc(liveLines[0] || "no evidence")}</span>`}
      </div>
      <ul>${liveLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    </div>`;
  const gitOpen = state.gitOpen.has(key);
  const gitSummary = [
    row.verdict || "…",
    row.branch ? `branch ${row.branch}` : null,
    dirty.length ? `${dirty.length} modified` : null,
    untr.length ? `${untr.length} untracked` : null,
    commits.length ? `${commits.length} not on ${pm.remoteRef || "remote main"}` : null,
    row.diffSummary || null,
    row.lastCommit ? `last commit ${relTime(row.lastCommit)} ago` : null,
  ].filter(Boolean).join(" · ");
  // Each of these was a fragment of one long "·"-joined line, so the reader had to hunt for "cherry" inside it.
  // They are list items now, and the head's summary joins them as the first item while the block is open.
  const metaItems = [
    row.isAncestor === true ? "ancestor of remote main" : row.isAncestor === false ? "not an ancestor" : null,
    `cherry +${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}`,
    row.reflogEntries ? `branch reflog: ${row.reflogEntries} distinct commit(s)` : null,
    row.everMoved === true
      ? `branch carried its own commits${row.mergedCount ? ` (${row.mergedCount} since ${esc(String(row.branchBase || "").slice(0, 7))})` : ""}`
      : row.everMoved === false
        ? "branch never moved — it has no commits of its own"
        : null,
    `remote branch: ${esc(row.remoteBranch || "?")}`,
    row.lastCommit ? `last commit ${relTime(row.lastCommit)} ago` : null,
    row.error ? `error: ${esc(row.error)}` : null,
  ].filter(Boolean);
  const agents = agentsFor(row);
  // No heading: the row's own badge already says how many agents it owns and how many are running, and the
  // cards are the first thing under the row - a title above them only pushed them down.
  const agentsHtml = agents.length
    ? `<div class="agents-block">${agents.map((c) => conversationHtml(c)).join("")}</div>`
    : "";
  // Sessions the row says are here but that have no card: the conversation lives in the gateway, and
  // the panel's job store is what held the card. Reviving one puts a card back you can reply to —
  // offered one at a time, because a tree collects every session ever run in it.
  const known = knownThreads();
  const idleSessions = (row.signals?.hermes?.idleList || []).filter((s) => s && s.id && !known.has(s.id));
  const sessionsHtml = idleSessions.length
    ? `<div class="sessions-block">
        ${idleSessions
          .map(
            // Shaped like an agent card's head — glyph, chevron, then a pill-sized revive button in the
            // status column — so a session with no card reads as the same kind of thing, one level down.
            // The glyph is grey rather than the purple of a live agent: this session has no card.
            (s) => `<div class="session-row">
            <span class="agent-glyph" title="a Hermes session in this worktree with no card on the board">\u29c9</span>
            <span class="chev" title="no card on the board">\u25b8</span>
            <button type="button" class="btn-revive" data-revive-session="${esc(s.id)}" data-revive-path="${esc(row.path)}" title="put this session back on the board as a card — the conversation is in the gateway, so a reply continues it where it stopped">revive</button>
            <span class="session-when mono" title="${esc(s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : "last use unknown")}">${esc(fmtAgo(s.lastActivityAt))}</span>
            <span class="session-name mono dim">${esc(s.title || "(untitled session)")}</span>
            <span class="session-id mono" title="${esc(s.id)}">${esc(String(s.id).slice(0, 16))}…</span>
          </div>`,
          )
          .join("")}
      </div>`
    : "";
  // Merge state and liveness evidence lead the block again, but as two folded one-line strips: they are
  // reference material and were taking a block's worth of height above the agents when they sat open here.
  return `<tr class="detail" data-detail="${esc(key)}"><td colspan="9">
    <div class="git-block${gitOpen ? "" : " collapsed"}" data-git-block="${esc(key)}">
      <div class="git-head" data-toggle-git="${esc(key)}" title="${gitOpen ? "fold" : "unfold"} the merge state, commit and diff detail">
        <span class="chev">${gitOpen ? "\u25be" : "\u25b8"}</span>
        <h4>Merge state</h4>
        <span class="git-summary mono">${esc(gitSummary)}</span>
      </div>
      <div class="git-body">
        <ul class="git-list">
          <li class="git-summary-line">${esc(gitSummary)}</li>
          ${metaItems.map((m) => `<li>${m}</li>`).join("")}
        </ul>
        ${parts.length ? `<div class="cols">${parts.join("")}</div>` : ""}
      </div>
    </div>
    ${liveBlock}
    ${agentsHtml}
    ${sessionsHtml}
  </td></tr>`;
}

function chipsHtml(name) {
  const rows = [...state.rows.values()].filter((r) => r.project === name);
  const merged = rows.filter((r) => String(r.verdict || "").startsWith("MERGED")).length;
  const noCommits = rows.filter((r) => {
    const v = String(r.verdict || "");
    return v.startsWith("NO COMMITS") || v.startsWith("EMPTY REPO");
  }).length;
  const unmerged = rows.filter((r) => {
    const v = String(r.verdict || "");
    return !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN";
  }).length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const open = rows.filter((r) => !isRowLive(r) && r.idle).length;
  const serving = rows.filter((r) => r.signals?.ports?.on).length;
  const removable = rows.filter((r) => r.mergeable).length;
  // Every agent whose home is a row in this project. Violet while any of them is working; amber as
  // soon as they are all idle, because "a live panel" is only true when something is actually running.
  const panelAgents = rows.flatMap((r) => agentsFor(r));
  const panelAgentCount = panelAgents.length;
  const panelRunningCount = panelAgents.filter((c) =>
    c.turns.some((t) => t.status === "running" || t.status === "starting"),
  ).length;
  const stale = rows.filter((r) => r.verdictStale).length;
  const out = [`<span class="chip">${rows.length} worktrees</span>`];
  if (merged) out.push(`<span class="chip good">${merged} merged</span>`);
  if (noCommits) out.push(`<span class="chip">${noCommits} no commits</span>`);
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (open) out.push(`<span class="chip">${open} open idle</span>`);
  if (serving) out.push(`<span class="chip info">${serving} serving</span>`);
  // Violet in both states, like the ⧉ hermes chip: this is a Hermes-agent fact, not a warning. Amber
  // made every project with finished agents look like it wanted attention; the tooltip still says how
  // many are running right now.
  // How many agents are working RIGHT NOW, from every source: the panel's own cards and any Hermes
  // session (CLI or otherwise) whose turn is leased. The split is in the tooltip, so the chip stays the
  // answer to one question — "is anything running".
  const outsideRunning = rows.reduce((n, r) => n + (Number(r.signals?.hermes?.running) || 0), 0);
  // Hermes agents that are NOT this panel's: an external CLI session taking a turn in one of this
  // project's worktrees. Counted only while it is executing — a closed or idle CLI session has nothing
  // to report at project level.
  if (outsideRunning) {
    const head = `${outsideRunning} Hermes agent${outsideRunning === 1 ? "" : "s"} from outside this panel ${outsideRunning === 1 ? "is" : "are"} executing a turn in this project right now`;
    const titles = rows.filter((r) => Number(r.signals?.hermes?.running) > 0).flatMap((r) => r.signals?.hermes?.titles || []);
    out.push(`<span class="chip hermes" title="${esc(hermesTitle(head, titles))}">${outsideRunning} hermes</span>`);
  }
  // The panel's own agents: how many cards, and how many of them are executing. The colour IS the state —
  // violet while something runs, grey while the panel is quiet — so a reader does not have to parse the
  // number to know whether anything is working.
  if (panelAgentCount) {
    const trees = rows.filter((r) => agentsFor(r).length).length;
    const busy = panelRunningCount > 0;
    const title = `${panelAgentCount} agent card${panelAgentCount === 1 ? "" : "s"} across ${trees} worktree${trees === 1 ? "" : "s"} in this project${busy ? ` · ${panelRunningCount} running right now` : " · none running"}`;
    const tag = busy ? ` · ${panelRunningCount} running` : "";
    const body = `⧉ ${panelAgentCount} panel${panelAgentCount === 1 ? "" : "s"}${tag}`;
    // Always a button: busy it jumps to the agent that is working, quiet it jumps to the top agent card.
    const cls = `chip${busy ? " agents" : ""} chip-jump`;
    const hint = busy ? "click to jump to the running agent" : "click to jump to the top agent";
    out.push(
      `<button type="button" class="${cls}" data-jump-panel="${esc(name)}" data-jump-running="${busy ? "1" : "0"}" title="${esc(title)} — ${hint}">${body}</button>`,
    );
  }
  // Amber and loud: an agent parked on a permission request is the one thing here that is waiting for
  // a human, and it must be visible with the project collapsed.
  const panelWaiting = panelAgents.filter((c) =>
    (c.turns || []).some((t) => t.approval && (t.status === "running" || t.status === "starting")),
  ).length;
  if (panelWaiting) {
    out.push(
      `<span class="chip sig-approval" title="an agent in this project is parked on a permission request — open the row to answer it">\u26a0 ${panelWaiting} awaiting approval</span>`,
    );
  }
  if (removable) out.push(`<span class="chip info">${removable} safe to remove</span>`);
  if (stale) out.push(`<span class="chip">${stale} reclassifying</span>`);
  return out.join("");
}

// ---- project ordering + the green "+" ------------------------------------------
// Projects are listed most-recently-worked-on first: the newest of the repo's own activity
// (last commit / git index mtime) and the newest file edit inside any of its worktrees.
function projectActivity(p) {
  let best = Date.parse(p.activityAt || "") || 0;
  for (const r of state.rows.values()) {
    if (r.project !== p.name) continue;
    best = Math.max(best, Date.parse(r.lastEdit || "") || 0, Date.parse(r.lastCommit || "") || 0);
  }
  return best;
}

// "Touched" is deliberately wider than sort order: a commit, a file edit, or any life evidence
// observed in one of its worktrees. A month-old checkout that an agent is working in right now is
// touched; a merged tree nobody has opened since spring is not.
function projectTouchedAt(p) {
  let best = projectActivity(p);
  for (const r of state.rows.values()) {
    if (r.project !== p.name) continue;
    best = Math.max(best, Date.parse(r.lastAliveAt || "") || 0);
  }
  return best;
}

function shownInRoot(root, projects) {
  if (!state.recentRoots.has(root)) return projects;
  const cutoff = Date.now() - RECENT_DAYS * 864e5;
  return projects.filter((p) => projectTouchedAt(p) >= cutoff);
}

// Where a project belongs in its folder: a panel agent working there leads, then any live worktree,
// then the rest by newest activity. Activity alone never moved a project that agents were working in
// — a turn leaves no commit or file edit behind, so "several agents busy here" ranked like "untouched".
function projectRanks() {
  const rank = new Map();
  for (const p of state.projects.values()) rank.set(p.name, { tier: 2, activity: Date.parse(p.activityAt || "") || 0 });
  for (const r of state.rows.values()) {
    const cur = rank.get(r.project);
    if (!cur) continue;
    if (panelFor(r)?.running) cur.tier = 0;
    else if (cur.tier > 1 && isRowLive(r)) cur.tier = 1;
    cur.activity = Math.max(cur.activity, Date.parse(r.lastEdit || "") || 0, Date.parse(r.lastCommit || "") || 0);
  }
  return rank;
}

// A rebuild regenerates every section in ranked order, which loses the one rule the live reorder keeps:
// the project you have OPEN stays where it is. Without this the 30-second resync slid the project being
// read to the top the moment its agent did something — an open section must never move under the reader.
// `prevNames` is that folder's project order from before the rebuild.
function pinOpenProjects(body, prevNames) {
  if (!body || !prevNames || !prevNames.length) return;
  const els = [...body.querySelectorAll(":scope > section.project")];
  if (!els.length) return;
  const byName = new Map(els.map((el) => [el.dataset.project, el]));
  const pinned = new Map();
  prevNames.forEach((n, i) => {
    if (!state.expandedProjects.has(n) || i >= els.length) return;
    const el = byName.get(n);
    if (el) pinned.set(i, el);
  });
  if (!pinned.size) return;
  const held = new Set(pinned.values());
  const free = els.filter((el) => !held.has(el));
  const want = [];
  let f = 0;
  for (let i = 0; i < els.length; i++) want.push(pinned.has(i) ? pinned.get(i) : free[f++]);
  if (want.every((el, i) => el === els[i])) return;
  for (const el of want) body.appendChild(el);
}

function sortedProjects() {
  const rank = projectRanks();
  const at = (p) => rank.get(p.name) || { tier: 2, activity: 0 };
  return [...state.projects.values()].sort((a, b) => {
    const ra = at(a);
    const rb = at(b);
    return ra.tier - rb.tier || rb.activity - ra.activity || String(a.name).localeCompare(String(b.name));
  });
}

// Re-order the board live, one folder at a time. Only the projects the reader has OPEN hold their
// place (moving one under a cursor mid-read is worse than a stale order); every other project sorts
// into the gaps around them, which is what brings a busy project to the top while you read another.
// Project reordering is a full sort of every folder, and row events arrive in bursts, so coalesce it
// into one frame. Hidden tabs never paint: apply at once there rather than leave the order stale.
let reorderFrame = 0;
function queueReorderProjects() {
  if (reorderFrame) return;
  const flush = () => {
    reorderFrame = 0;
    reorderProjects();
  };
  if (document.hidden) return flush();
  reorderFrame = requestAnimationFrame(flush);
}

function reorderProjects() {
  const host = $("projects");
  if (!host) return;
  const rank = projectRanks();
  const at = (n) => rank.get(n) || { tier: 2, activity: 0 };
  const cmp = (x, y) => {
    const a = at(x.dataset.project);
    const b = at(y.dataset.project);
    return a.tier - b.tier || b.activity - a.activity || String(x.dataset.project).localeCompare(String(y.dataset.project));
  };
  // An open project keeps its exact slot — opening one is you saying "this is the one I am reading",
  // so it must not slide out from under the cursor. Everything closed sorts into the gaps around it:
  // one open project is no reason to hold the rest of the folder still.
  const order = (els) => {
    const open = new Map();
    els.forEach((el, i) => {
      if (state.expandedProjects.has(el.dataset.project)) open.set(i, el);
    });
    const free = els.filter((el) => !state.expandedProjects.has(el.dataset.project)).sort(cmp);
    const out = [];
    let f = 0;
    els.forEach((_, i) => out.push(open.has(i) ? open.get(i) : free[f++]));
    return out;
  };
  for (const body of host.querySelectorAll(".root-body")) {
    const sections = [...body.querySelectorAll("section.project")];
    if (!sections.length) continue;
    const want = order(sections);
    if (want.every((el, i) => el === sections[i])) continue;
    for (const el of want) body.appendChild(el);
    flashMoved(sections, want, body);
  }
  // Then the folders themselves, on the same ranking: a folder holding the project an agent is busy
  // in leads, then the one worked in most recently.
  const groups = [...host.querySelectorAll("section.root-group")];
  const folderRank = (g) => {
    let tier = 2;
    let act = 0;
    for (const s of g.querySelectorAll("section.project")) {
      const r = at(s.dataset.project);
      tier = Math.min(tier, r.tier);
      act = Math.max(act, r.activity);
    }
    return { tier, act };
  };
  // A folder you are reading a project in holds its slot for the same reason the project does: the
  // folder sliding up takes the open section with it, which looks exactly like the section itself jumping.
  const holdsOpen = (g) => [...g.querySelectorAll("section.project")].some((s) => state.expandedProjects.has(s.dataset.project));
  const ranked = groups.slice().sort((a, b) => {
    const ra = folderRank(a);
    const rb = folderRank(b);
    return ra.tier - rb.tier || rb.act - ra.act || String(a.dataset.root || "").localeCompare(String(b.dataset.root || ""));
  });
  const pinnedGroups = new Map();
  groups.forEach((g, i) => { if (holdsOpen(g)) pinnedGroups.set(i, g); });
  const freeGroups = ranked.filter((g) => !pinnedGroups.has(groups.indexOf(g)));
  const wantGroups = [];
  let gf = 0;
  groups.forEach((_, i) => wantGroups.push(pinnedGroups.has(i) ? pinnedGroups.get(i) : freeGroups[gf++]));
  if (!wantGroups.every((g, i) => g === groups[i])) for (const g of wantGroups) host.appendChild(g);
}

// One accordion per folder. The header carries the folder path and the aggregate state of
// everything inside it, so a collapsed folder still says what it holds.
function rootChips(projects, hidden = 0) {
  const names = new Set(projects.map((p) => p.name));
  const rows = [...state.rows.values()].filter((r) => names.has(r.project));
  const unmerged = rows.filter((r) => {
    const v = String(r.verdict || "");
    return v && !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN";
  }).length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const live = rows.filter(isRowLive).length;
  const out = [
    `<span class="chip">${projects.length} project${projects.length === 1 ? "" : "s"}</span>`,
    `<span class="chip">${rows.length} worktrees</span>`,
  ];
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (live) out.push(`<span class="chip live">${live} live</span>`);
  // In "last 7 days" mode the folder is a filtered view, and saying so beats an unexplained short list.
  if (hidden) out.push(`<span class="chip" title="projects with no commit, edit or life evidence in the last ${RECENT_DAYS} days">${hidden} hidden</span>`);
  return out.join("");
}

function rootSection(root, allProjects) {
  const open = !state.collapsedRoots.has(root);
  const recentOnly = state.recentRoots.has(root);
  const projects = shownInRoot(root, allProjects);
  const hidden = allProjects.length - projects.length;
  const anyOpen = projects.some((p) => state.expandedProjects.has(p.name));
  const recentTitle = recentOnly
    ? `showing ${projects.length} of ${allProjects.length} projects — only those touched in the last ${RECENT_DAYS} days; click to show every project`
    : `showing all ${allProjects.length} projects; click to show only those touched in the last ${RECENT_DAYS} days`;
  return `<section class="root-group${open ? "" : " collapsed"}" data-root="${esc(root)}">
    <div class="root-head" data-toggle-root="${esc(root)}" title="${open ? "collapse" : "expand"} ${esc(labelRoot(root))}">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <h2>${esc(labelRoot(root))}</h2>
      <div class="chips">${rootChips(projects, hidden)}</div>
      <span class="spacer"></span>
      <button type="button" class="btn-root-recent${recentOnly ? " on" : ""}" data-root-recent="${esc(root)}" title="${esc(recentTitle)}">${recentOnly ? `${RECENT_DAYS}d` : "All"}</button>
      <button type="button" class="btn-root-collapse" data-root-collapse="${esc(root)}" title="${anyOpen ? "collapse" : "expand"} every project in ${esc(labelRoot(root))} (${projects.length})">${anyOpen ? "Collapse all" : "Expand all"}</button>
      <button type="button" class="btn-root-clone" data-root-clone="${esc(root)}" title="clone a GitHub repo over ssh into ${esc(labelRoot(root))}">+</button>
    </div>
    <div class="root-clone" data-clone-form="${esc(root)}"${state.cloneStatus[root] ? "" : " hidden"}>
      <input type="text" data-clone-input="${esc(root)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" placeholder="repo name — e.g. agent-worktree-gui, or owner/repo" spellcheck="false">
      <button type="button" data-clone-go="${esc(root)}">Clone via ssh</button>
      <span class="mono dim${state.cloneStatus[root]?.kind === "err" ? " clone-err" : ""}" data-clone-msg="${esc(root)}">${esc(state.cloneStatus[root]?.text || "")}</span>
    </div>
    <div class="root-body">
${projects.map((p) => projectSection(p.name)).join("\n")}
    </div>
  </section>`;
}

function projectSection(name) {
  const p = state.projects.get(name) || { name };
  const open = state.expandedProjects.has(name);
  const mainLine = p.localMain && p.remoteTip
    ? `local ${esc(p.mainBranch)} <code>${esc(p.localMain)}</code> · ${p.mainBehind ?? "?"} behind / ${p.mainAhead ?? "?"} ahead of remote`
    : p.error ? esc(p.error) : "local main unknown";
  const board = p.board
    ? `<span class="mono ${p.board.live?.length ? "sig-board-live" : "dimmer"}">board: ${p.board.live?.length ? p.board.live.map((e) => `pid ${e.pid}`).join(", ") : `no live entries (${p.board.dead} stale)`}</span>`
    : "";
  const tip = p.remoteTip
    ? `<span class="mono dim">${esc(p.remoteRef || "")} <code>${esc(p.remoteTip)}</code> ${esc(String(p.remoteTipSubject || "").slice(0, 60))} · ${relTime(p.remoteTipDate)} ago</span>`
    : "";
  return `<section class="project${open ? "" : " collapsed"}" data-project="${esc(name)}">
    <div class="project-head" data-toggle-project="${esc(name)}" title="${open ? "minimize" : "expand"} ${esc(name)}">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <h2>${esc(name)}</h2>
      <button class="btn-plus" data-spawn-project="${esc(name)}" title="start a Hermes agent, worktree and branch in ${esc(name)}">+</button>
      <span class="path">${esc(p.path || "")}</span>
      <span class="spacer"></span><div class="chips" data-chips="${esc(name)}">${chipsHtml(name)}</div>
    </div>
    <div class="project-head meta-line">
      <span class="mono dim">${mainLine}</span><span class="spacer"></span>${board}${tip}
      <span class="dimmer mono">${p.fetchNote ? esc(p.fetchNote) + " · " : ""}fetched ${relTime(p.fetchedAt)} ago</span>
    </div>
    <table><thead><tr>
      <th>Worktree</th><th>Branch</th><th>Tip</th><th>Ahead / Behind</th><th>Cherry</th>
      <th>PR</th><th>Dirty</th><th title="time since this worktree was last seen alive (any evidence firing) · the ring fills up to green as the row becomes due for its next read · chips are the evidence: ⧉ hermes session · ● board PID · :port dev server · ✎ files edited">Life / next read</th><th>Verdict</th><th title="remove a worktree (sent to the Recycle Bin)"></th>
    </tr></thead><tbody data-tbody="${esc(name)}"></tbody></table>
    <div class="legend">liveness evidence: <span class="sig sig-hermes">⧉ hermes</span> session active · <span class="sig sig-board">● board</span> live board PID · <span class="sig sig-port">:port</span> dev server listening · <span class="sig sig-files">✎ files</span> edited recently — a row is live only if one of these fired · the number is time since that last happened, the ring fills up to green as the row becomes due for its next read</div>
  </section>`;
}

function refreshChips(name) {
  const el = document.querySelector(`[data-chips="${CSS.escape(name)}"]`);
  if (el) el.innerHTML = chipsHtml(name);
}

function reorder(name) {
  const tbody = state.tbodyEls.get(name);
  if (!tbody) return;
  const mine = [...state.rows.values()].filter((r) => r.project === name);
  // The order if nothing were pinned: our running agents first, then everything by how recently it
  // showed life. This is what "latest movement at the top" means once all the accordions are closed.
  const ranked = orderRows([...mine]).map((r) => keyOf(name, r.path));
  // An open row keeps its exact slot — opening it is you saying "I am reading this". Everything closed
  // sorts into the gaps around it, exactly how closed projects sort around an open one in a folder.
  const slotKeys = [...tbody.children].filter((el) => el.classList.contains("row")).map((el) => el.dataset.key);
  const fixed = new Set(slotKeys.filter((k) => state.expanded.has(k)));
  const free = ranked.filter((k) => !fixed.has(k));
  const orderedKeys = [];
  let f = 0;
  for (const k of slotKeys) orderedKeys.push(fixed.has(k) ? k : free[f++] ?? k);
  // A row that just arrived has no slot of its own yet: give it one at the end of the free queue.
  for (const k of free.slice(f)) if (!orderedKeys.includes(k)) orderedKeys.push(k);
  const want = [];
  for (const k of orderedKeys) {
    const tr = state.rowEls.get(k);
    if (tr) want.push(tr);
    const d = state.detailEls.get(k);
    if (d) want.push(d);
  }
  // Only touch the DOM when the order really changed: this runs on every row event, and re-appending
  // identical nodes would fight the scroll position while someone is reading.
  const current = [...tbody.children];
  if (current.length === want.length && current.every((el, i) => el === want[i])) return;
  for (const el of want) tbody.appendChild(el);
  // Say which rows moved: the order is the panel's judgement about what to look at first, and a
  // silent shuffle leaves you guessing whether the row under the cursor is still the same row.
  // Green only where an agent actually moved in that row; a row that merely slid a slot because its
  // neighbour came alive gets the quiet grey. This is what stopped the MAIN row pulsing every time an
  // agent one level down did something.
  flashMovedByKey(
    current.map((el) => el.dataset.key),
    want,
    tbody,
    (el) => (state.movedRows.has(el.dataset.key) ? "flash" : "flash-idle"),
  );
  state.movedRows.clear();
}

// Green flash on the things that moved UP the order. A project pushed to the top shifts everything
// below it down by one, and flashing those too turned a single mover into a wall of green; an element
// that only slid downwards is not news.
function flashMovedByKey(beforeKeys, afterEls, reflowHost, colorFor = null) {
  const was = new Map();
  beforeKeys.forEach((k, i) => {
    if (k) was.set(k, i);
  });
  const moved = [];
  afterEls.forEach((el, i) => {
    const k = el.dataset.key || el.dataset.project || el.dataset.root;
    const from = k ? was.get(k) : undefined;
    if (from !== undefined && i < from) moved.push(el);
  });
  if (!moved.length) return;
  // Remove then re-add in one pass with a single reflow between, so an element that moves twice in
  // quick succession restarts the animation instead of silently keeping the dying one.
  const kinds = new Map(moved.map((el) => [el, colorFor ? colorFor(el) : "flash"]));
  for (const el of moved) {
    el.classList.remove("flash", "flash-idle");
  }
  if (reflowHost) void reflowHost.offsetWidth;
  for (const el of moved) {
    const kind = kinds.get(el);
    el.classList.add(kind);
    clearTimeout(el._flashT);
    el._flashT = setTimeout(() => el.classList.remove(kind), 950);
  }
}

function flashMoved(before, after, reflowHost) {
  flashMovedByKey(before.map((el) => el.dataset.key || el.dataset.project || el.dataset.root), after, reflowHost);
}

// SSE row events arrive in bursts (a scan batch finishes several rows at once). Painting each one
// as it lands forces a layout per event; coalescing them into one animation frame keeps a burst to
// a single style pass, which is what made the table stutter when the scanner was busy.
const pendingRows = new Map();
let rowFrame = 0;

function queueRow(project, row, opts) {
  pendingRows.set(keyOf(project, row.path), { project, row, opts });
  if (rowFrame) return;
  // rAF does not run at all in a hidden tab, so batching there would freeze the board's state until
  // the tab is looked at again (and a spawn's new row would never arrive). Apply immediately when
  // hidden; batch only while the tab is actually painting.
  const flush = () => {
    rowFrame = 0;
    const batch = [...pendingRows.values()];
    pendingRows.clear();
    for (const b of batch) placeRow(b.project, b.row, b.opts);
    // A row that starts or stops being alive changes where its project belongs, and liveness evidence
    // moves far more often than a job status does — so let every row batch also re-rank the folders.
    if (batch.length) queueReorderProjects();
  };
  if (document.hidden) return flush();
  rowFrame = requestAnimationFrame(flush);
}

function placeRow(project, row, { flash = false } = {}) {
  row.project = project;
  const key = keyOf(project, row.path);
  const prevRow = state.rows.get(key) || null;
  // Decided before the new row overwrites the old one, and outside the flash branch: it also decides
  // whether a refresh that found nothing gets the quiet grey pulse.
  const onMain = isMainWorktree(project, row);
  const moved = !prevRow || movementKey(prevRow, { onMain }) !== movementKey(row, { onMain });
  // Remembered for the reorder pass that follows this paint: a row that swaps slots because a NEIGHBOUR
  // moved must not flash green for it. Cleared by reorder() once it has coloured the moved rows.
  if (moved) state.movedRows.add(key);
  else state.movedRows.delete(key);
  const isNew = !state.rows.has(key);
  noteScan(row);
  state.rows.set(key, row);
  // A worktree that has just appeared can adopt the agents that were waiting in the unattached panel:
  // their owner path now resolves to a row. (A `-w` spawn is owned seconds before its row exists.)
  if (isNew) {
    invalidatePanelMap();
    queueJobsRefresh();
  }
  const tbody = state.tbodyEls.get(project);
  // If the section was rebuilt (project event), the cached tbody is detached. Repaint this
  // project's rows instead of quietly appending into a node nobody can see.
  if (!tbody || !tbody.isConnected) {
    if (!state.projects.has(project)) {
      renderAll();
      return;
    }
    const fresh = document.querySelector(`[data-tbody="${CSS.escape(project)}"]`);
    if (fresh) state.tbodyEls.set(project, fresh);
    renderProjectRows(project);
    refreshChips(project);
    return;
  }
  const holder = document.createElement("tbody");
  holder.innerHTML = rowHtml(row);
  const newTr = holder.firstElementChild;
  const old = state.rowEls.get(key);
  // A collapsed section is not on screen: keep the row in state (the chips and counters need it)
  // but spend nothing on its markup. Expanding the project renders it from state.
  if (!state.expandedProjects.has(project)) {
    refreshChips(project);
    return;
  }
  const oldDetail = state.detailEls.get(key);
  const typing = oldDetail ? captureTyping(oldDetail) : null;
  const outs = oldDetail
    ? [...oldDetail.querySelectorAll("pre.job-out")].map((o) => ({
        id: o.dataset.out,
        top: o.scrollTop,
        atBottom: o.scrollHeight - o.scrollTop - o.clientHeight < 32,
      }))
    : [];
  if (oldDetail) oldDetail.remove();
  state.detailEls.delete(key);
  if (old) old.replaceWith(newTr);
  else tbody.appendChild(newTr);
  state.rowEls.set(key, newTr);
  if (state.expanded.has(key)) {
    const h2 = document.createElement("tbody");
    h2.innerHTML = detailHtml(row);
    const dEl = h2.firstElementChild;
    newTr.after(dEl);
    state.detailEls.set(key, dEl);
    // Put the reader back: the reply they were typing, where the caret was, and how far each
    // transcript had been scrolled.
    restoreTyping(dEl, typing);
    const scrollMap = new Map(outs.map((o) => [o.id, { top: o.top, atBottom: o.atBottom }]));
    restoreScrolls(dEl, scrollMap);
    applyStoredScrolls(dEl);
  }
  if (flash && old) {
    // Green when an agent moved in this row; a quiet grey when the refresh ran and found nothing new.
    // Two outcomes, two colours — one colour for both made every 5s tick look like progress.
    const kind = moved ? "flash" : "flash-idle";
    newTr.classList.add(kind);
    setTimeout(() => newTr.classList.remove(kind), 900);
  }
  reorder(project);
  refreshChips(project);
}

function removeRow(project, p) {
  const key = keyOf(project, p);
  state.rowEls.get(key)?.remove();
  state.detailEls.get(key)?.remove();
  state.rowEls.delete(key);
  state.detailEls.delete(key);
  state.rows.delete(key);
  refreshChips(project);
}

// Paint one project's rows into its (possibly just replaced) tbody.
function renderProjectRows(name) {
  const tbody = state.tbodyEls.get(name);
  if (!tbody) return;
  // Open rows carry agent transcripts; a rebuild must not throw the reader to the top of one.
  const prevScrolls = captureScrolls(tbody);
  const prevRowKeys = [...tbody.children].filter((el) => el.classList.contains("row")).map((el) => el.dataset.key);
  tbody.innerHTML = "";
  // A collapsed project shows nothing, so building its rows would be pure waste — with 94
  // projects that was ~110 invisible rows and most of the render cost of a snapshot.
  if (!state.expandedProjects.has(name)) {
    for (const k of [...state.rowEls.keys()]) if (state.rows.get(k)?.project === name) state.rowEls.delete(k);
    for (const k of [...state.detailEls.keys()]) if (state.rows.get(k)?.project === name) state.detailEls.delete(k);
    return;
  }
  const rows = orderRows([...state.rows.values()].filter((r) => r.project === name));
  for (const row of rows) {
    const key = keyOf(name, row.path);
    const holder = document.createElement("tbody");
    holder.innerHTML = rowHtml(row);
    const tr = holder.firstElementChild;
    tbody.appendChild(tr);
    state.rowEls.set(key, tr);
    if (state.expanded.has(key)) {
      const h2 = document.createElement("tbody");
      h2.innerHTML = detailHtml(row);
      const dEl = h2.firstElementChild;
      tr.after(dEl);
      state.detailEls.set(key, dEl);
    }
  }
  restoreScrolls(tbody, prevScrolls);
  applyStoredScrolls(tbody);
  // This path rebuilds the table in ranked order, which is how a row most often changes place (a
  // project event or a snapshot). Without this the move was silent — the node was new, so nothing
  // remembered where it used to be.
  flashMovedByKey(prevRowKeys, [...tbody.children].filter((el) => el.classList.contains("row")), tbody);
}

// Header summary. The project count is the live one — what the table is actually showing — not
// the configured fallback list the server reports before discovery has run.
function paintConfigLine() {
  const cfg = state.settings || {};
  if (cfg.host === undefined) return;
  const n = state.projects.size || (Array.isArray(cfg.projects) ? cfg.projects.length : 0);
  $("config-line").textContent = `${cfg.version ? `v${cfg.version} · ` : ""}${n} project(s) · cheap fields every ${cfg.worktreeSeconds}s · verdict/PR every ${cfg.slowSeconds}s · ${cfg.threads} scan threads · ${cfg.host}`;
}

function renderAll() {
  // A full re-render rebuilds the chips from scratch; the job list is the freshest input.
  invalidatePanelMap();
  const projects = sortedProjects();
  for (const id of [...state.expandedProjects]) if (!state.projects.has(id)) state.expandedProjects.delete(id);
  // Wrap every project in its folder accordion: one group per scan root, and a sibling group
  // for any project that lives outside all of them (so nothing is filed under a folder it is
  // not actually in). Groups are ordered by their most recently active project.
  const groups = new Map();
  for (const p of projects) {
    const root = rootOf(p);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  }
  const prevRoots = new Map();
  for (const g of $("projects").querySelectorAll("section.root-group")) {
    prevRoots.set(g.dataset.root, [...g.querySelectorAll(".root-body section.project")].map((s) => s.dataset.project));
  }
  $("projects").innerHTML =
    [...groups.entries()]
      .sort((a, b) => projectActivity(b[1][0]) - projectActivity(a[1][0]) || a[0].localeCompare(b[0]))
      .map(([root, list]) => rootSection(root, list))
      .join("") || '<p class="empty">No git repos found under scanRoots.</p>';
  // The rebuild sorted every folder by activity; put the open ones back in the slot they held.
  for (const g of $("projects").querySelectorAll("section.root-group")) {
    pinOpenProjects(g.querySelector(".root-body"), prevRoots.get(g.dataset.root));
  }
  // ...and the folder that holds an open project keeps its own place in the folder list.
  {
    const folders = [...$("projects").querySelectorAll("section.root-group")];
    const holdsOpen = (g) => [...g.querySelectorAll("section.project")].some((s) => state.expandedProjects.has(s.dataset.project));
    const pinned = new Map();
    folders.forEach((g, i) => {
      const prev = prevRoots.get(g.dataset.root);
      if (prev && holdsOpen(g)) pinned.set(i, g);
    });
    if (pinned.size) {
      const held = new Set(pinned.values());
      const free = folders.filter((g) => !held.has(g));
      const want = [];
      let f = 0;
      for (let i = 0; i < folders.length; i++) want.push(pinned.has(i) ? pinned.get(i) : free[f++]);
      if (!want.every((g, i) => g === folders[i])) for (const g of want) $("projects").appendChild(g);
    }
  }
  state.tbodyEls.clear();
  state.rowEls.clear();
  state.detailEls.clear();
  for (const p of projects) {
    const tbody = document.querySelector(`[data-tbody="${CSS.escape(p.name)}"]`);
    if (tbody) state.tbodyEls.set(p.name, tbody);
    renderProjectRows(p.name);
    refreshChips(p.name);
  }
  paintConfigLine();
  paintCollapseAll();
  // A full rebuild reorders the sections too: same test as renderRoot — a re-rank flashes, a filter
  // change (different set) does not.
  for (const g of $("projects").querySelectorAll("section.root-group")) {
    const was = prevRoots.get(g.dataset.root);
    const now = [...g.querySelectorAll(".root-body section.project")];
    if (was && was.length === now.length) flashMovedByKey(was, now, g);
  }
}

function applySnapshot(data) {
  // Captured before anything is mutated: if the set of projects is the same afterwards, the
  // sections on screen are still valid and a full re-render would be pure cost.
  const beforeSig = [...state.projects.keys()].sort().join("|");
  state.settings = data.settings || state.settings;
  if (Array.isArray(data.scanRoots)) state.scanRoots = data.scanRoots;
  if (data.spawn) {
    state.spawn = data.spawn;
    const t = data.spawn.transport || {};
    const caps = t.capabilities || {};
    $("chip-key").textContent = t.reachable ? `api: up${caps.steer ? " · steer" : ""}` : "api: down";
    $("chip-key").title = t.error || `${t.url || ""}${caps.version ? ` · hermes ${caps.version}` : ""}`;
    $("chip-bin").textContent = String(t.url || "").replace(/^https?:\/\//, "") || "no gateway";
    $("chip-bin").title = caps.runCwd
      ? "the gateway honours per-run cwd, so agents work in their own worktree"
      : "the gateway ignores per-run cwd (hermes-runs-api-knobs.diff not applied) — agents run in the gateway's directory";
    syncProjectPicker(data.spawn.projects || []);
  }
  if (data.skipped) {
    $("skipped-note").textContent = data.skipped.length
      ? `skipped under scanRoots (not git repos): ${data.skipped.map((s) => String(s.dir).split(/[\\/]/).pop()).join(", ")}`
      : "";
  }
  if (data.jobs) {
    state.jobs.clear();
    for (const j of data.jobs) {
      state.jobs.set(j.id, j);
      if (!state.jobLines.has(j.id) && j.lines?.length) state.jobLines.set(j.id, j.lines.slice());
    }
    renderJobs();
    invalidatePanelMap();
  }
  if (Array.isArray(data.approvals)) {
    state.approvals.clear();
    for (const r of data.approvals) if (r && r.id) state.approvals.set(r.id, r);
    renderApprovals();
  }
  // A snapshot refreshes what it carries; it does not retract rows. Only an explicit "drop"
  // event retires a worktree, so a snapshot arriving mid-scan can never blank the table.
  const incomingProjects = data.projects || [];
  // ...and a snapshot that knows of NO projects is not evidence that there are none: it is what the
  // server reports while its first discovery sweep is still running (a restart, or a sweep that
  // failed). Keeping the board and saying so beats flashing "No git repos found under scanRoots".
  if (!incomingProjects.length && state.projects.size) {
    $("health").className = "dot warn";
    return;
  }
  const seen = new Set();
  for (const p of incomingProjects) {
    seen.add(p.name);
    state.projects.set(p.name, p);
    const wts = Array.isArray(p.worktrees) ? p.worktrees : [];
    if (!wts.length) continue;
    for (const [k, r] of [...state.rows]) if (r.project === p.name) state.rows.delete(k);
    for (const w of wts) {
      const row = { ...w, project: p.name };
      state.rows.set(keyOf(p.name, w.path), row);
      noteScan(row);
    }
  }
  // A snapshot is authoritative about WHICH projects exist: the server drops a project when it
  // disappears from the roots (or was only ever a config fallback before discovery ran), and the
  // client must drop it too instead of keeping a section nothing will ever repaint.
  for (const name of [...state.projects.keys()]) if (!seen.has(name)) state.projects.delete(name);
  for (const [k, r] of [...state.rows]) {
    if (!seen.has(r.project)) {
      state.rows.delete(k);
      state.rowEls.delete(k);
      state.detailEls.delete(k);
    }
  }
  const afterSig = [...state.projects.keys()].sort().join("|");
  if (beforeSig !== afterSig || !document.querySelector("section.project[data-project]")) {
    // The set of projects changed: sections have to be built (or removed) wholesale.
    renderAll();
  } else {
    // Same projects: repaint what is actually on screen. A full re-render here rebuilt 94
    // sections and every row twice a minute for no structural reason, which is exactly the
    // periodic hitch the panel had.
    for (const p of state.projects.values()) {
      refreshChips(p.name);
      renderProjectRows(p.name); // no-ops for a collapsed project
    }
  }
  reorderProjects();
  $("health").className = "dot ok";
  $("banner").classList.add("hidden");
}

function showBanner(msg) {
  const b = $("banner");
  if (!msg) return b.classList.add("hidden");
  b.classList.remove("ok");
  b.textContent = msg;
  b.classList.remove("hidden");
}

// A short green confirmation (the red banner is for failures): used when a gesture did what it said
// without opening a dialog, e.g. an agent attaching itself to the worktree it was already sitting in.
let noteTimer = 0;
function showNote(msg) {
  const b = $("banner");
  if (!b) return;
  b.textContent = msg;
  b.classList.add("ok");
  b.classList.remove("hidden");
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    b.classList.add("hidden");
    b.classList.remove("ok");
  }, 4000);
}

function setStream(label, cls = "ok") {
  $("stream-state").textContent = label;
  $("health").className = `dot ${cls}`;
}

function connect() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/stream");
  state.es = es;
  es.addEventListener("open", () => setStream("● live"));
  es.addEventListener("snapshot", (e) => {
    const d = JSON.parse(e.data);
    state.lastEventAt = Date.now();
    applySnapshot(d.data ? d.data : d);
  });
  es.addEventListener("row", (e) => {
    const evt = JSON.parse(e.data);
    state.events += 1;
    state.lastEventAt = Date.now();
    // Liveness-only updates repaint the row but do not flash it: evidence blinks on and off
    // far more often than git state moves, and flashing for that is just noise.
    queueRow(evt.project, evt.row, { flash: evt.changed !== false && !evt.livenessOnly });
  });
  es.addEventListener("project", (e) => {
    const evt = JSON.parse(e.data);
    const cur = state.projects.get(evt.project.name) || {};
    state.projects.set(evt.project.name, { ...cur, ...evt.project });
    refreshChips(evt.project.name);
    const sec = document.querySelector(`section.project[data-project="${CSS.escape(evt.project.name)}"]`);
    if (!sec) {
      renderAll();
      return;
    }
    // Replace only the section's own markup, then immediately repaint its rows: swapping the
    // whole section used to leave an empty <tbody> behind until the next full re-render,
    // which is what made the worktree table vanish for seconds at a time.
    const holder = document.createElement("div");
    holder.innerHTML = projectSection(evt.project.name);
    const freshHolder = holder.firstElementChild;
    // A project event replaces the whole section. If it was mid-flash (it had just moved because an
    // agent started in it), the replacement would silently drop the highlight.
    if (sec.classList.contains("flash")) {
      freshHolder.classList.add("flash");
      clearTimeout(freshHolder._flashT);
      freshHolder._flashT = setTimeout(() => freshHolder.classList.remove("flash"), 1150);
    }
    sec.replaceWith(freshHolder);
    state.tbodyEls.set(evt.project.name, freshHolder.querySelector(`[data-tbody="${CSS.escape(evt.project.name)}"]`));
    renderProjectRows(evt.project.name);
    reorderProjects();
  });
  es.addEventListener("drop", (e) => {
    const evt = JSON.parse(e.data);
    removeRow(evt.project, evt.path);
  });
  es.addEventListener("job", (e) => {
    state.lastEventAt = Date.now();
    updateJob(JSON.parse(e.data).job);
  });
  es.addEventListener("jobline", (e) => appendJobLine(JSON.parse(e.data)));
  es.addEventListener("approval", (e) => {
    const r = JSON.parse(e.data).request;
    if (!r || !r.id) return;
    state.approvals.set(r.id, r);
    renderApprovals();
    // The agent that is blocked now says "waiting on you" instead of just "running".
    if (r.thread) renderConversation(r.thread);
  });
  es.addEventListener("approval-answered", (e) => {
    const evt = JSON.parse(e.data);
    const r = state.approvals.get(evt.id);
    state.approvals.delete(evt.id);
    renderApprovals();
    if (r && r.thread) renderConversation(r.thread);
  });
  es.addEventListener("jobs", (e) => {
    state.lastEventAt = Date.now();
    state.jobs.clear();
    for (const j of JSON.parse(e.data).jobs) state.jobs.set(j.id, j);
    scheduleRenderJobs();
    repaintAgentState();
  });
  es.addEventListener("heartbeat", (e) => {
    state.pool = JSON.parse(e.data).pool;
  });
  es.addEventListener("error", () => setStream("reconnecting…", "warn"));
}

async function resync() {
  try {
    applySnapshot(await apiFetch("/api/state").then((r) => r.json()));
  } catch (e) {
    showBanner(`Cannot reach the server: ${e.message}`);
    setStream("offline", "bad");
  }
}

async function post(route) {
  try {
    await fetch(route, { method: "POST" });
    await resync();
  } catch (e) {
    showBanner(`${route}: ${e.message}`);
  }
}

$("btn-refresh").addEventListener("click", () => post("/api/refresh"));
$("btn-collapse-all").addEventListener("click", () => toggleEverything());

// Ctrl+[ folds the whole board, Ctrl+] opens it — the square brackets point the way (in, then out).
// Ignored while a field has focus: a bracket belongs in a prompt or a filter, not on the board.
window.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.metaKey || e.altKey) return;
  // e.key is layout-dependent; e.code is not, so either identifies the key.
  let open = null;
  if (e.key === "[" || e.code === "BracketLeft") open = false;
  else if (e.key === "]" || e.code === "BracketRight") open = true;
  if (open === null) return;
  const el = e.target;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  e.preventDefault();
  setEverythingOpen(open);
});
$("btn-fetch").addEventListener("click", () => post("/api/fetch"));
$("job-project").addEventListener("change", () => {
  const p = selectedProject();
  if (p) $("job-cwd").value = p.path;
  $("job-create").checked = true;
  state.spawnTarget = null;
  updateSpawnNote();
});
$("job-cwd").addEventListener("input", updateSpawnNote);
$("job-create").addEventListener("change", () => {
  updateSpawnNote();
});
$("btn-spawn").addEventListener("click", spawnAgent);
// Retry, in the two places an error is posted: the spawn card and a settled turn's foot.
document.addEventListener("click", (e) => {
  const spawn = e.target.closest ? e.target.closest("[data-retry-spawn]") : null;
  if (spawn) {
    e.preventDefault();
    void retrySpawn();
    return;
  }
  const turn = e.target.closest ? e.target.closest("[data-retry-turn]") : null;
  if (!turn) return;
  e.preventDefault();
  e.stopPropagation();
  const thread = turn.dataset.retryTurn;
  const conv = conversations().find((c) => c.thread === thread);
  const last = conv?.turns?.[conv.turns.length - 1];
  const text = String(last?.prompt || "").trim();
  if (!text) return;
  turn.disabled = true;
  void sendReply(thread, text);
});
$("btn-clear-jobs").addEventListener("click", () => post("/api/jobs/clear"));
$("btn-fold-jobs").addEventListener("click", () => {
  const convs = conversations();
  const allFolded = convs.length > 0 && convs.every((c) => state.collapsedJobs.has(c.thread));
  foldAll(!allFolded);
});
$("job-prompt").addEventListener("input", () => updateSpawnNote());
// Ctrl+wheel over a console resizes its text, the way a terminal does, instead of zooming the page. Scoped to
// that card's output (`--out-size`), so one long transcript can be shrunk without touching the rest of the board;
// the Settings "Console size" remains the baseline. Steps of 1px, clamped to what a monospace face still reads
// at, and the page zoom is only suppressed while the pointer is actually over a console.
const CONSOLE_ZOOM_MIN = 7;
const CONSOLE_ZOOM_MAX = 24;

function zoomConsole(out, step) {
  const card = out.closest(".job");
  const thread = card && card.dataset.thread;
  if (!thread) return;
  const base = Number(state.consoleZoom.get(thread)) || parseFloat(getComputedStyle(out).fontSize) || 11.5;
  // Half-pixel steps: the console's default size is 11.5px, and rounding to whole pixels made the first tick
  // jump 1.5px while every tick after it moved 1.
  const next = Math.min(CONSOLE_ZOOM_MAX, Math.max(CONSOLE_ZOOM_MIN, Math.round((base + step) * 2) / 2));
  state.consoleZoom.set(thread, next);
  card.style.setProperty("--out-size", `${next}px`);
  out.style.fontSize = `${next}px`;
}

// Ctrl+wheel over a console must not ALSO zoom the window. Cancel it at the earliest point in the event's path
// (capture on window) and stop it there, so neither the page's own listeners nor anything above them sees a
// cancellable wheel: a passive listener anywhere in the path - the panel has one on document for pendingFocus -
// can otherwise leave the browser free to run its zoom gesture.
const onConsoleWheel = (e) => {
  if (!e.ctrlKey) return;
  const out = e.target && e.target.closest ? e.target.closest(".job-out") : null;
  if (!out) return;
  if (e.cancelable) e.preventDefault();
  e.stopPropagation();
  zoomConsole(out, e.deltaY < 0 ? 1 : -1);
};
window.addEventListener("wheel", onConsoleWheel, { passive: false, capture: true });
// Trackpad pinch arrives as a gesture in Safari, not as a ctrl+wheel, and would zoom the page under the pointer.
for (const type of ["gesturestart", "gesturechange"]) {
  window.addEventListener(
    type,
    (e) => {
      const out = e.target && e.target.closest ? e.target.closest(".job-out") : null;
      if (!out) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    },
    { passive: false, capture: true },
  );
}

// The console resizes like the reply box, but its max-height is what stops it eating the card — and a
// max-height also stops the drag dead. The handle lives in the bottom-right 16px corner, so grabbing
// there lifts the cap first; the height the drag then writes is an inline style and wins over both.
document.addEventListener(
  "pointerdown",
  (e) => {
    const out = e.target && e.target.closest ? e.target.closest(".job-out") : null;
    if (!out) return;
    const r = out.getBoundingClientRect();
    if (e.clientX >= r.right - 16 && e.clientY >= r.bottom - 16) out.style.maxHeight = "none";
  },
  true,
);

// ---- documents pasted into a prompt ------------------------------------------------
// The gateway's runs API has no attachment field, so a document is stored by the panel and its absolute
// path is appended to the prompt at SEND time. On screen it is a chip above the box — `[name] ×` — so the
// thing you typed is not buried under a paragraph of machine text.
const spawnAttachments = []; // the New-agent box's list; it lives in static markup, so no re-render to survive

function attachmentsFor(ctx) {
  return ctx === "spawn" ? spawnAttachments : state.replyAttachments.get(ctx) || [];
}

function setAttachments(ctx, list) {
  if (ctx === "spawn") {
    spawnAttachments.length = 0;
    spawnAttachments.push(...list);
  } else if (list.length) {
    state.replyAttachments.set(ctx, list);
  } else {
    state.replyAttachments.delete(ctx);
  }
}

function fmtBytes(n) {
  const bytes = Number(n) || 0;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function attachmentChipsHtml(ctx) {
  return attachmentsFor(ctx)
    .map(
      (a) =>
        `<span class="attach-chip mono" data-open-path="${esc(a.path)}" title="open ${esc(a.path)} in Notepad++">[${esc(a.name)}]<button type="button" class="chip-x" data-chip-remove="${esc(a.path)}" data-chip-ctx="${esc(ctx)}" title="remove this attachment">\u00d7</button></span>`,
    )
    .join("");
}

function renderChips(ctx) {
  const el =
    ctx === "spawn"
      ? document.getElementById("spawn-chips")
      : document.querySelector(`.attach-chips[data-chips="${CSS.escape(ctx)}"]`);
  if (!el) return;
  el.innerHTML = attachmentChipsHtml(ctx);
}

// What the agent actually receives: the chip stays a chip, the path travels with the message.
function attachmentBlock(ctx) {
  return attachmentsFor(ctx)
    .map((a) => {
      const how = /^image\//.test(String(a.type)) ? "use vision_analyze on it" : "read_file it";
      return `\n\nAttachment: ${a.path} (${a.type || "unknown type"}, ${fmtBytes(a.bytes)}) — ${how} before answering.`;
    })
    .join("");
}

function clearAttachments(ctx) {
  setAttachments(ctx, []);
  renderChips(ctx);
}

async function attachFiles(files, box) {
  const ctx = box.id === "job-prompt" ? "spawn" : box.dataset.reply || null;
  if (!ctx) return;
  for (const file of files) {
    if (!file) continue;
    if (!file.size) {
      if (ctx === "spawn") $("spawn-msg").textContent = `${file.name || "file"} is empty`;
      continue;
    }
    try {
      const res = await apiFetch(
        "/api/attachments",
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "x-filename": encodeURIComponent(file.name || "pasted-file"),
          },
          body: file,
        },
        { timeoutMs: 120000 },
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setAttachments(ctx, [...attachmentsFor(ctx), d]);
      renderChips(ctx);
    } catch (e) {
      const warn = ctx === "spawn" ? $("spawn-msg") : document.querySelector(`[data-reply-warn="${CSS.escape(ctx)}"]`);
      if (warn) warn.textContent = `attachment failed: ${e.message}`;
    }
  }
}

function attachTarget(el) {
  return el && el.closest ? el.closest("#job-prompt, .reply-box") : null;
}

document.addEventListener("paste", (e) => {
  const box = attachTarget(e.target);
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!box || !files.length) return; // text pastes stay text
  e.preventDefault();
  void attachFiles(files, box);
});

document.addEventListener("dragover", (e) => {
  const box = attachTarget(e.target);
  if (!box || !e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
  e.preventDefault();
  box.classList.add("drop-target");
});
document.addEventListener("dragleave", (e) => {
  const box = attachTarget(e.target);
  if (box) box.classList.remove("drop-target");
});
document.addEventListener("drop", (e) => {
  const box = attachTarget(e.target);
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!box || !files.length) return;
  e.preventDefault();
  box.classList.remove("drop-target");
  void attachFiles(files, box);
});

// "make the first commit" on an unborn-HEAD refusal: one empty local commit, then the spawn the button was
// offered for runs again. No push, no file invented for the repo.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest ? e.target.closest("[data-first-commit]") : null;
  if (!btn) return;
  const dir = btn.dataset.firstCommit || "";
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "committing…";
  try {
    const r = await apiFetch(
      "/api/repo/first-commit",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir }) },
      { timeoutMs: 60000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // Two entry points, two continuations: from a refused spawn the reader had already asked to run, so
    // it runs again; from the warning above the spawn button they have not, so it just clears the block.
    if (btn.dataset.firstCommitRun === "1") {
      $("spawn-msg").textContent = `first commit ${d.sha} made in ${d.path} — nothing pushed. Spawning again…`;
      void spawnAgent();
    } else {
      $("spawn-msg").textContent = `first commit ${d.sha} made in ${d.path} — nothing pushed.`;
      void resync().then(() => updateSpawnNote());
    }
  } catch (err) {
    $("spawn-msg").textContent = `could not make the first commit: ${err.message}`;
    btn.disabled = false;
    btn.textContent = label;
  }
});

// The chip opens its file; the x removes it.
document.addEventListener("click", (e) => {
  if (!e.target.closest) return;
  const x = e.target.closest("[data-chip-remove]");
  if (x) {
    const ctx = x.dataset.chipCtx;
    setAttachments(ctx, attachmentsFor(ctx).filter((a) => a.path !== x.dataset.chipRemove));
    renderChips(ctx);
    return;
  }
  const chip = e.target.closest(".attach-chip[data-open-path]");
  if (chip) void openArtifact(chip.dataset.openPath);
});

// Enter in the prompt spawns, the way it does in every other box here. Shift+Enter is a newline, so a
// multi-line prompt is still possible.
$("job-prompt").addEventListener("keydown", (e) => {
  // Up/Down walk what you have already spawned, shell style. Only from the very start (Up) or the very
  // end (Down) of the text, so the arrows still move the caret inside a multi-line prompt.
  if (e.key === "ArrowUp" && !e.shiftKey) {
    const box = e.target;
    // A single-line prompt walks history from anywhere (that is shell behaviour, and the caret sits at
    // the END after typing). A multi-line prompt only walks when the caret is already at the start, so
    // Up still moves between its lines first.
    const singleLine = !String(box.value).includes("\n");
    const atStart = box.selectionStart === 0 && box.selectionEnd === 0;
    if ((singleLine && box.selectionStart === box.selectionEnd) || atStart || !box.value) {
      if (recallSpawnPrompt(1)) {
        e.preventDefault();
        return;
      }
    }
  }
  if (e.key === "ArrowDown" && !e.shiftKey) {
    const box = e.target;
    const singleLine = !String(box.value).includes("\n");
    const atEnd = box.selectionStart === box.value.length && box.selectionEnd === box.value.length;
    if ((singleLine && box.selectionStart === box.selectionEnd) || atEnd) {
      if (recallSpawnPrompt(-1)) {
        e.preventDefault();
        return;
      }
    }
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
  e.stopPropagation();
  // Shift+Enter is a newline: a prompt is often more than one line.
  if (e.shiftKey) {
    insertNewlineAtCaret(e.target);
    return;
  }
  if (!$("btn-spawn").disabled) spawnAgent();
});

// Typing ends the history walk, so the next Up starts from whatever is in the box now.
$("job-prompt").addEventListener("input", () => {
  if (state.spawnNav) state.spawnNav = { back: 0, stash: $("job-prompt").value };
});
$("btn-pause").addEventListener("click", () => {
  state.paused = !state.paused;
  $("btn-pause").textContent = state.paused ? "Resume" : "Pause";
  if (state.paused) {
    state.es?.close();
    setStream("paused", "warn");
  } else {
    connect();
    resync();
  }
});

document.addEventListener("click", async (e) => {
  // A click is the reader taking over: stop chasing the box a spawn wanted focused. Clicking inside
  // that agent's own card keeps the target, so reading its output does not undo it.
  if (state.pendingFocus && !e.target.closest(`.job[data-thread="${CSS.escape(state.pendingFocus.thread)}"]`)) {
    state.pendingFocus = null;
  }
  // Files this agent produced: the button opens the list, a row opens that file in an editor, and
  // the copy button takes the full path. Clicking anywhere else closes the list.
  const artBtn = e.target.closest("[data-artifacts]");
  const insidePop = e.target.closest("[data-artifacts-pop]");
  if (!artBtn && !insidePop) closeArtifactPops();
  if (artBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = artBtn.dataset.artifacts;
    const pop = document.querySelector(`[data-artifacts-pop="${CSS.escape(thread)}"]`);
    if (pop) {
      const wasHidden = pop.hidden;
      closeArtifactPops();
      pop.hidden = !wasHidden;
      if (!pop.hidden) {
        // Fixed positioning in viewport space: the head is sticky-ish and the list must not be
        // clipped by the card, so it hangs off the button itself. The position is remembered so a
        // repaint can put the list back where the reader left it.
        const r = artBtn.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - 420, r.left));
        const top = r.bottom + 6;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        state.openArtifacts.set(thread, { left, top });
      }
    }
    return;
  }
  const delTree = e.target.closest("[data-del-tree]");
  if (delTree) {
    e.preventDefault();
    e.stopPropagation();
    showWorktreeConfirm(delTree.dataset.delTree);
    return;
  }
  const delTreeYes = e.target.closest("[data-del-tree-yes]");
  if (delTreeYes) {
    e.preventDefault();
    e.stopPropagation();
    void confirmDeleteWorktree(delTreeYes.dataset.delTreeYes);
    return;
  }
  const delTreeNo = e.target.closest("[data-del-tree-no]");
  if (delTreeNo) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelector(`tr.row-confirm[data-confirm-row="${CSS.escape(delTreeNo.dataset.delTreeNo)}"]`)?.remove();
    return;
  }
  const delBtn = e.target.closest("[data-del-artifact]");
  if (delBtn) {
    e.preventDefault();
    e.stopPropagation();
    const key = delBtn.dataset.delArtifact;
    const pop = delBtn.closest("[data-artifacts-pop]");
    const row = delBtn.closest(".ap-row");
    const isUrl = /^https?:\/\//i.test(key);
    if (row) {
      row.innerHTML = `<span class="ap-confirm mono" title="${esc(key)}">Delete ${esc(isUrl ? "this URL from the list" : baseNameOf(key))}?</span>
        <button type="button" class="ap-del-no" data-del-no="${esc(key)}" data-pop="${esc(pop?.dataset.artifactsPop || "")}">cancel</button>
        <button type="button" class="ap-del-yes" data-del-yes="${esc(key)}" data-pop="${esc(pop?.dataset.artifactsPop || "")}">yes, delete</button>`;
    }
    return;
  }
  const delYes = e.target.closest("[data-del-yes]");
  if (delYes) {
    e.preventDefault();
    e.stopPropagation();
    void deleteArtifact(delYes.dataset.pop, delYes.dataset.delYes);
    return;
  }
  const delNo = e.target.closest("[data-del-no]");
  if (delNo) {
    e.preventDefault();
    e.stopPropagation();
    renderArtifactsPop(delNo.dataset.pop);
    return;
  }
  const openUrlBtn = e.target.closest("[data-open-url]");
  if (openUrlBtn) {
    e.preventDefault();
    e.stopPropagation();
    void openArtifactUrl(openUrlBtn.dataset.openUrl);
    return;
  }
  const openBtn = e.target.closest("[data-open-path]");
  if (openBtn) {
    e.preventDefault();
    e.stopPropagation();
    void openArtifact(openBtn.dataset.openPath);
    return;
  }
  const copyBtn = e.target.closest("[data-copy-path]");
  if (copyBtn) {
    e.preventDefault();
    e.stopPropagation();
    void copyText(copyBtn.dataset.copyPath).then((ok) => {
      copyBtn.textContent = ok ? "copied" : "failed";
      copyBtn.classList.toggle("is-copied", ok);
      setTimeout(() => {
        copyBtn.textContent = "copy";
        copyBtn.classList.remove("is-copied");
      }, 1200);
    });
    return;
  }
  const apBtn = e.target.closest("[data-approval-choice]");
  if (apBtn) {
    e.preventDefault();
    e.stopPropagation();
    void answerApproval(apBtn.dataset.approvalId, apBtn.dataset.approvalChoice, apBtn);
    return;
  }
  const plus = e.target.closest(".btn-plus");
  if (plus) {
    e.stopPropagation();
    e.preventDefault();
    focusSpawn(plus.dataset.spawnProject);
    return;
  }
  const rrecent = e.target.closest("[data-root-recent]");
  if (rrecent) {
    e.stopPropagation();
    e.preventDefault();
    toggleRootRecent(rrecent.dataset.rootRecent);
    return;
  }
  const rcollapse = e.target.closest("[data-root-collapse]");
  if (rcollapse) {
    e.stopPropagation();
    e.preventDefault();
    toggleAllInRoot(rcollapse.dataset.rootCollapse);
    return;
  }
  const rclone = e.target.closest("[data-root-clone]");
  if (rclone) {
    e.stopPropagation();
    e.preventDefault();
    const root = rclone.dataset.rootClone;
    const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
    showCloneForm(root, form ? form.hidden : true); // the "+" toggles the row
    return;
  }
  const rgo = e.target.closest("[data-clone-go]");
  if (rgo) {
    e.stopPropagation();
    e.preventDefault();
    void cloneIntoRoot(rgo.dataset.cloneGo);
    return;
  }
  const rhead = e.target.closest(".root-head[data-toggle-root]");
  if (rhead) {
    const root = rhead.dataset.toggleRoot;
    keepInPlace(() => document.querySelector(`.root-head[data-toggle-root="${CSS.escape(root)}"]`), () => toggleRoot(root));
    return;
  }
  // The project's panel chip is a button only while something is running: jump to that agent instead of
  // toggling the project the chip sits in.
  const panelJump = e.target.closest("[data-jump-panel]");
  if (panelJump) {
    e.preventDefault();
    e.stopPropagation();
    jumpToPanelAgent(panelJump.dataset.jumpPanel, { running: panelJump.dataset.jumpRunning === "1" });
    return;
  }
  const phead = e.target.closest(".project-head[data-toggle-project]");
  if (phead) {
    const name = phead.dataset.toggleProject;
    keepInPlace(() => document.querySelector(`.project-head[data-toggle-project="${CSS.escape(name)}"]`), () => toggleProject(name));
    return;
  }
  // The fixed cards (New agent / Agents): the title row collapses them, but their own controls
  // (Minimize all, Clear finished, the chips) must keep working.
  const fixedHead = e.target.closest("[data-toggle-fixed]");
  if (fixedHead) {
    if (e.target.closest("button, input, select, textarea, a, label")) return;
    e.preventDefault();
    const id = fixedHead.dataset.toggleFixed;
    keepInPlace(() => document.querySelector(`[data-toggle-fixed="${CSS.escape(id)}"]`), () => toggleFixed(id));
    return;
  }
  const rowAgent = e.target.closest(".btn-row-agent");
  if (rowAgent) {
    e.stopPropagation();
    e.preventDefault();
    // Another agent in the same tree is allowed, but it is a shared working tree: say so once.
    const path = rowAgent.dataset.agentPath;
    const name = rowAgent.dataset.agentName;
    const mine = agentsByPath().get(normPath(path).toLowerCase()) || [];
    if (mine.length) {
      const running = agentsRunning(mine);
      const ok = window.confirm(
        `${mine.length} agent${mine.length === 1 ? " already works" : "s already work"} in ${name}` +
          `${running ? ` (${running} running now)` : ""}.\n\n` +
          `They share the same working tree: commits can collide (index.lock), and each sees the other's edits as its own dirty files.\n\n` +
          `Start another agent here anyway?`,
      );
      if (!ok) return;
    }
    focusSpawnForWorktree(path, name);
    return;
  }
  // The row's agent badge: open the row so the agents block is visible.
  const openRowBtn = e.target.closest("[data-open-row]");
  if (openRowBtn) {
    e.stopPropagation();
    e.preventDefault();
    openAgentsBlock(openRowBtn.dataset.openRow);
    return;
  }
  // "revive" on a session the row reports but that has no card: ask the server to rebuild one.
  const reviveBtn = e.target.closest("[data-revive-session]");
  if (reviveBtn) {
    e.stopPropagation();
    e.preventDefault();
    void reviveSession(reviveBtn);
    return;
  }
  // "waiting on you →" on an agent card: take the reader to the approval that is blocking it.
  const apJump = e.target.closest("[data-approval-jump]");
  if (apJump) {
    e.preventDefault();
    e.stopPropagation();
    const card = document.querySelector(`.approval[data-approval="${CSS.escape(apJump.dataset.approvalJump)}"]`);
    if (card) {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.add("jump");
      setTimeout(() => card.classList.remove("jump"), 1600);
    }
    return;
  }
  // The approval card's "⧉ agent": jump to the agent that is blocked (works outside #projects too).
  const apAgent = e.target.closest(".approval [data-agent-thread]");
  if (apAgent) {
    e.preventDefault();
    jumpToAgent(apAgent.dataset.agentThread);
    return;
  }
  const replyBtn = e.target.closest(".btn-reply");
  if (replyBtn) {
    await sendReply(replyBtn.dataset.thread);
    return;
  }
  // "Pull this chat out": the maximise button sits inside the head, so it must not also toggle
  // the card's collapse state.
  const maxBtn = e.target.closest("[data-max-thread]");
  if (maxBtn) {
    e.preventDefault();
    e.stopPropagation();
    setMaximized(maxBtn.dataset.maxThread);
    return;
  }
  const clearBtn = e.target.closest("[data-clear-thread]");
  if (clearBtn) {
    e.preventDefault();
    e.stopPropagation();
    await clearThread(clearBtn);
    return;
  }
  const renameBtn = e.target.closest("[data-rename-thread]");
  if (renameBtn) {
    e.preventDefault();
    e.stopPropagation();
    beginRename(renameBtn.dataset.renameThread);
    return;
  }
  // "attach": if the agent's own directory is a worktree we know, attach it there straight away;
  // only ask which one when there is no obvious answer.
  const attachToggle = e.target.closest("[data-attach-toggle]");
  if (attachToggle) {
    e.preventDefault();
    e.stopPropagation();
    const thread = attachToggle.dataset.attachToggle;
    const conv = conversations().find((c) => c.thread === thread);
    const cwd = conv ? conv.latest.cwd || conv.first.cwd || "" : "";
    const match = matchWorktree(cwd);
    if (match) {
      const ok = await attachAgent(thread, match.path);
      if (ok) showNote(`attached to ${match.project} · ${match.name}`);
      return;
    }
    const row = document.querySelector(`[data-attach-row="${CSS.escape(thread)}"]`);
    if (row) {
      // A minimized card would show a dropdown hanging off a one-liner; unfold it first so the
      // picker has context, then reveal it on the rebuilt card.
      const card = attachToggle.closest(".job");
      const minimized = Boolean(card && card.classList.contains("collapsed"));
      if (minimized) {
        state.collapsedJobs.delete(thread);
        saveCollapsedJobs();
        renderConversation(thread);
      }
      const fresh = document.querySelector(`[data-attach-row="${CSS.escape(thread)}"]`);
      if (fresh) fresh.hidden = false;
      if (fresh) {
        // Built on demand: the card may be rendered before any worktree row exists.
        const sel = fresh.querySelector("select");
        if (sel && !sel.options.length) sel.innerHTML = worktreeOptionsHtml();
        // Start from the agent's current owner when the scan does not show it, so "attach" is a
        // deliberate re-point rather than a silent move to whatever the list happens to start with.
        const owner = conv && (conv.latest.ownerPath || conv.first.ownerPath);
        if (sel && owner) {
          const hit = [...sel.options].find((o) => o.value.toLowerCase() === String(owner).toLowerCase());
          if (hit) sel.value = hit.value;
        }
        sel?.focus();
      }
    }
    return;
  }
  const attachGo = e.target.closest("[data-attach-go]");
  if (attachGo) {
    e.preventDefault();
    e.stopPropagation();
    await attachAgent(attachGo.dataset.attachGo);
    return;
  }
  // A turn folds on its own: the head row or the one-line request opens/closes that turn,
  // independently of the conversation card it sits in.
  // Star a turn: it also shows, still accordionable, in the pinned block above the paged turns.
  const starBtn = e.target.closest("[data-star-turn]");
  if (starBtn) {
    e.preventDefault();
    e.stopPropagation();
    const id = starBtn.dataset.starTurn;
    const job = state.jobs.get(id);
    if (state.pinnedTurns.has(id)) state.pinnedTurns.delete(id);
    else state.pinnedTurns.add(id);
    const thread = job ? job.thread || job.id : null;
    if (thread) {
      // Pinning inserts a block above the page, so the star just clicked would slide down out from
      // under the pointer (and a second click to undo would land somewhere else). Anchor on the PAGE
      // copy of that star (the pinned one is a different element at a different place), then scroll
      // by however far it moved so it stays where the cursor is.
      const pageStar = findTurnStar(thread, id);
      const beforeTop = pageStar ? pageStar.getBoundingClientRect().top : null;
      renderConversation(thread);
      // Correct, then correct again once the browser has settled layout: inserting the pinned block
      // changes the page height in two passes (the card now, its line boxes at the next layout), so a
      // single correction leaves the star short of where it started.
      const keepStarPut = () => {
        const anchor = findTurnStar(thread, id);
        if (beforeTop == null || !anchor) return;
        const delta = anchor.getBoundingClientRect().top - beforeTop;
        if (Math.abs(delta) > 1) window.scrollBy(0, delta);
      };
      // Now, then once layout has definitely settled: inserting the pinned block can change the page
      // height again on the next layout pass (line boxes, images), which would leave the star adrift.
      keepStarPut();
      setTimeout(keepStarPut, 0);
      setTimeout(keepStarPut, 80);
    }
    return;
  }
  // Liveness evidence folds in place; collapsed, the strongest line rides to the right of the header.
  const liveToggle = e.target.closest("[data-toggle-live]");
  if (liveToggle) {
    e.preventDefault();
    e.stopPropagation();
    const key = liveToggle.dataset.toggleLive;
    const block = document.querySelector(`[data-live-block="${CSS.escape(key)}"]`);
    if (block) {
      const open = state.liveOpen.has(key);
      if (open) state.liveOpen.delete(key);
      else state.liveOpen.add(key);
      block.classList.toggle("collapsed", open);
      const chev = liveToggle.querySelector(".chev");
      if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
      let first = liveToggle.querySelector(".live-first");
      const firstLine = block.querySelector("ul li");
      if (open) {
        if (!first && firstLine) {
          first = document.createElement("span");
          first.className = "live-first mono";
          first.textContent = firstLine.textContent;
          first.title = firstLine.textContent;
          liveToggle.appendChild(first);
        }
      } else if (first) {
        first.remove();
      }
      liveToggle.title = `${open ? "unfold" : "fold"} the liveness evidence`;
    }
    return;
  }
  // The git / commit / diff accordion inside a worktree's detail row: fold and unfold in place, so
  // nothing else in the row (agent cards, scroll positions) is rebuilt.
  const gitToggle = e.target.closest("[data-toggle-git]");
  if (gitToggle) {
    e.preventDefault();
    e.stopPropagation();
    const key = gitToggle.dataset.toggleGit;
    const block = document.querySelector(`[data-git-block="${CSS.escape(key)}"]`);
    if (block) {
      const open = state.gitOpen.has(key);
      if (open) state.gitOpen.delete(key);
      else state.gitOpen.add(key);
      block.classList.toggle("collapsed", open);
      const chev = gitToggle.querySelector(".chev");
      if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
      gitToggle.title = `${open ? "unfold" : "fold"} the git, commit and diff detail`;
    }
    return;
  }
  const turnToggle = e.target.closest("[data-toggle-turn]");
  if (turnToggle) {
    e.preventDefault();
    const id = turnToggle.dataset.toggleTurn;
    keepInPlace(() => document.querySelector(`[data-turn-head="${CSS.escape(id)}"]`), () => toggleTurn(id));
    return;
  }
  // Turn pagination: the arrows sit in the card head, next to the turn count.
  const pageBtn = e.target.closest("[data-turn-page]");
  if (pageBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = pageBtn.dataset.threadPage;
    const conv = conversations().find((c) => c.thread === thread);
    if (conv) {
      const pages = Math.max(1, Math.ceil(conv.turns.length / TURNS_PER_PAGE));
      const cur = turnPageOffset(thread, conv.turns.length);
      const next = pageBtn.dataset.turnPage === "older" ? Math.min(pages - 1, cur + 1) : Math.max(0, cur - 1);
      if (next === 0) state.turnPage.delete(thread);
      else state.turnPage.set(thread, next);
      renderConversation(thread);
    }
    return;
  }
  // A click on anything interactive inside the head belongs to that control, never to the fold:
  // attach, clear, maximize, cancel, the attach picker and its select all live in the head row.
  const head = e.target.closest(".job-head");
  // A minimized card is one row plus its preview line, and both are the handle: clicking the preview (or
  // any empty part of the row) expands it. Buttons inside the head keep their own behaviour, and an open
  // card is only folded by its head — its body is full of things to click.
  const foldedCard = e.target.closest(".job.collapsed");
  if (
    (head || foldedCard) &&
    !e.target.closest("button, a, input, select, textarea, label, [data-attach-row], [data-toggle-turn]")
  ) {
    const id = head ? head.dataset.toggle : foldedCard.dataset.thread;
    keepInPlace(() => document.querySelector(`.job[data-thread="${CSS.escape(id)}"] .job-head`), () => toggleJob(id));
    return;
  }
  // Queue reply: hold the text (do not send) because a turn is running on this thread.
  const queueBtn = e.target.closest("[data-queue-reply]");
  if (queueBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = queueBtn.dataset.queueReply;
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    const text = (box?.value || "").trim();
    if (!text) {
      if (box) box.focus();
      return;
    }
    // Clear the draft first: queueReply rebuilds the card, and the rebuild would put the text back
    // into the new box from the saved draft.
    state.replyDrafts[thread] = "";
    if (box) box.value = "";
    queueReply(thread, text);
    document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`)?.focus();
    return;
  }
  // Answer an approval a run is parked on. The buttons come from the host's own choice list.
  const approveBtn = e.target.closest("[data-approve]");
  if (approveBtn) {
    e.preventDefault();
    e.stopPropagation();
    const card = approveBtn.closest(".job");
    const warn = card ? card.querySelector("[data-reply-warn]") : null;
    approveBtn.disabled = true;
    try {
      const res = await apiFetch("/api/jobs/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: approveBtn.dataset.approve, choice: approveBtn.dataset.choice, requestId: approveBtn.dataset.request || null }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) {
        if (warn) warn.textContent = out.error || `approval failed (HTTP ${res.status})`;
        approveBtn.disabled = false;
      }
    } catch (err) {
      if (warn) warn.textContent = `approval failed: ${err.message}`;
      approveBtn.disabled = false;
    }
    return;
  }
  // Steer the turn that is running: the primary action while the agent is busy.
  const steerBtn = e.target.closest("[data-steer]");
  if (steerBtn) {
    e.preventDefault();
    e.stopPropagation();
    const card = steerBtn.closest(".job");
    const thread = card?.dataset.thread || "";
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    await steerTurn(thread, steerBtn.dataset.steer, box?.value || "", steerBtn);
    return;
  }
  const btn = e.target.closest(".btn-cancel");
  if (!btn) return;
  btn.disabled = true;
  try {
    await apiFetch("/api/jobs/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: btn.dataset.id }) });
  } catch {
    btn.disabled = false;
  }
});

// Reply affordances are re-created on every render, so they are handled at document level.
document.addEventListener("keydown", async (e) => {
  // Any key means the reader is working: stop chasing a spawn's reply box (Esc is exempt — it closes
  // things and never means "I am typing").
  if (state.pendingFocus && e.key !== "Escape") state.pendingFocus = null;
  // Esc closes the produced-files list first; a second Esc does whatever Esc did before.
  if (e.key === "Escape" && document.querySelector("[data-artifacts-pop]:not([hidden])")) {
    closeArtifactPops();
  }
  // Esc puts a pulled-out chat back; nothing else in the page holds that key.
  if (e.key === "Escape" && !$("settings").classList.contains("hidden")) {
    e.preventDefault();
    toggleSettings(false);
    return;
  }
  if (e.key === "Escape" && state.maximized) {
    e.preventDefault();
    setMaximized(null);
    return;
  }
  // The folder clone input: Enter clones, Escape closes the row.
  const cloneInput = e.target.closest && e.target.closest("[data-clone-input]");
  if (cloneInput) {
    if (e.key === "Enter") {
      e.preventDefault();
      void cloneIntoRoot(cloneInput.dataset.cloneInput);
    } else if (e.key === "Escape") {
      e.preventDefault();
      showCloneForm(cloneInput.dataset.cloneInput, false);
    }
    return;
  }
  const box = e.target.closest && e.target.closest(".reply-box");
  if (!box) return;
  // Up/Down walk the thread's previous prompts, shell style: only from the very start (Up) or the very
  // end (Down) of the text, so the arrows still move the caret inside a multi-line reply.
  if (e.key === "ArrowUp" && !e.shiftKey && box.selectionStart === 0 && box.selectionEnd === 0) {
    e.preventDefault();
    recallReply(box, 1);
    return;
  }
  if (e.key === "ArrowDown" && !e.shiftKey && box.selectionStart === box.value.length && box.selectionEnd === box.value.length) {
    e.preventDefault();
    recallReply(box, -1);
    return;
  }
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    insertNewlineAtCaret(box);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const thread = box.dataset.reply;
    const text = (box.value || "").trim();
    // While a turn is running, the primary action IS steering: the text goes into the live turn
    // rather than bouncing off a busy agent. Queue reply is the explicit "next turn" button.
    if (threadBusy(thread)) {
      if (!text) return;
      const running = [...state.jobs.values()].find(
        (j) => (j.thread || j.id) === thread && (j.status === "running" || j.status === "starting"),
      );
      if (running) {
        await steerTurn(thread, running.id, text);
        return;
      }
    }
    void sendReply(thread);
    if (state.hot.on) hotAfterSend(thread);
  }
});
document.addEventListener("input", (e) => {
  const box = e.target.closest && e.target.closest(".reply-box");
  if (box) state.replyDrafts[box.dataset.reply] = box.value;
});

// A link in agent output is opened by the panel, not by navigating: capture phase, so the row and agent
// fold handlers never see the click.
document.addEventListener(
  "click",
  (e) => {
    const link = e.target.closest && e.target.closest("a.out-link");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    void openInBrowser(link.dataset.openUrl || link.getAttribute("href") || "");
  },
  true,
);

// Pressing Send must not steal focus from the box it is sending: without this the mousedown moves the
// caret to the button and the next keystroke goes nowhere.
document.addEventListener("mousedown", (e) => {
  const btn = e.target.closest && e.target.closest(".btn-reply");
  if (btn) e.preventDefault();
});

// Folding a project throws its console markup away, so where you had scrolled has to be remembered by
// turn rather than by node — otherwise it comes back at the top. Capture phase: scroll does not bubble.
document.addEventListener(
  "scroll",
  (e) => {
    const pre = e.target;
    if (!pre || pre.tagName !== "PRE" || !pre.classList || !pre.classList.contains("job-out") || !pre.dataset.out) return;
    state.outScrolls[pre.dataset.out] = {
      top: pre.scrollTop,
      atBottom: pre.scrollHeight - pre.scrollTop - pre.clientHeight < 32,
    };
  },
  true,
);

$("projects").addEventListener("click", (e) => {
  // The agent badge inside a row opens the row (and its agents block) instead of toggling blindly.
  const badgeBtn = e.target.closest("[data-open-row]");
  if (badgeBtn) {
    e.preventDefault();
    e.stopPropagation();
    openAgentsBlock(badgeBtn.dataset.openRow);
    return;
  }
  // A row's agent chip jumps up to that conversation instead of expanding the row.
  const jump = e.target.closest("[data-agent-thread]");
  if (jump) {
    e.preventDefault();
    e.stopPropagation();
    jumpToAgent(jump.dataset.agentThread);
    return;
  }
  // The next-read ring is also a button: it forces one fresh read of just this worktree.
  const refreshBtn = e.target.closest("[data-refresh-row]");
  if (refreshBtn) {
    e.preventDefault();
    e.stopPropagation();
    void forceRowRead(refreshBtn);
    return;
  }
  const tr = e.target.closest("tr.row");
  if (!tr) return;
  // A row's own controls (play, delete, revive, refresh ring) have their own handlers. If the toggle
  // ALSO fires, `keepInPlace` corrects the page for the accordion that just opened and yanks it back —
  // which is exactly how clicking the green play button moved the caret into the prompt while leaving
  // the card off-screen.
  if (e.target.closest("button, a, input, select, textarea, label")) return;
  const key = tr.dataset.key;
  const row = state.rows.get(key);
  if (!row) return;
  keepInPlace(
    () => document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`),
    () => {
      if (state.expanded.has(key)) {
        state.expanded.delete(key);
        state.detailEls.get(key)?.remove();
        state.detailEls.delete(key);
        tr.classList.remove("expanded");
      } else {
        state.expanded.add(key);
        const holder = document.createElement("tbody");
        holder.innerHTML = detailHtml(row);
        const dEl = holder.firstElementChild;
        tr.after(dEl);
        state.detailEls.set(key, dEl);
        tr.classList.add("expanded");
      }
    },
  );
});

setInterval(() => {
  // A hidden tab has nothing to repaint: timers keep firing there, and the work (plus the layout
  // each repaint forces) is what made coming back to the tab feel like a freeze.
  if (document.hidden) return;
  for (const el of document.querySelectorAll(".queue-ago[data-queued-at]")) {
    const at = Number(el.dataset.queuedAt) || 0;
    if (!at) continue;
    const next = fmtDur(Date.now() - at);
    if (el.textContent !== next) el.textContent = next;
  }
  for (const cell of document.querySelectorAll("td.age")) {
    const row = state.rows.get(cell.dataset.key);
    if (!row) continue;
    paintAgeCell(cell, row);
  }
  for (const j of state.jobs.values()) {
    if (j.status !== "running" && j.status !== "starting") continue;
    const card = document.querySelector(`.job[data-thread="${CSS.escape(j.thread || j.id)}"]`);
    // The clock is its own span. Replacing the whole foot here deleted the stats strip one second
    // after the card rendered it: a running card showed "running 42s" and nothing else, while every
    // settled sibling had its numbers.
    const clock = card?.querySelector(".job-foot [data-run-clock]");
    if (clock) {
      const next = `running ${elapsed(j)}`;
      if (clock.textContent !== next) clock.textContent = next;
    }
    // Only the status text is repainted. Writing head.textContent here deleted the pin star and the
    // chevron every second and put them back on the next render — the star visibly popped in and out
    // while a turn ran, and the row reflowed with it.
    // Both copies (page and pinned block) carry the same id, so update every head, not just the first.
    const heads = card?.querySelectorAll(`[data-turn-head="${CSS.escape(j.id)}"]`) || [];
    for (const head of heads) {
      const txt = head.querySelector(".turn-text");
      if (!txt) continue;
      const next = `turn ${j.turn || "?"} · running ${elapsed(j)}`;
      if (txt.textContent !== next) txt.textContent = next;
    }
  }
  const bits = [];
  if (state.pool) bits.push(`pool ${state.pool.inFlight}/${state.settings.threads || "?"}`);
  if (state.jobs.size) {
    const convs = conversations();
    const running = convs.filter((c) => c.turns.some((t) => t.status === "running")).length;
    bits.push(`${convs.length} conversation${convs.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`);
  }
  if (state.lastEventAt) {
    const rate = state.events / Math.max(1, (Date.now() - state.eventsAt) / 1000);
    bits.push(`${state.events} events · ${rate.toFixed(1)}/s`);
  } else {
    bits.push("no changes yet");
  }
  $("stream-rate").textContent = bits.join(" · ");
}, 1000);

setInterval(() => {
  if (state.paused) return;
  // SSE is the live path; this is only a safety net for a stream that has gone quiet or died.
  const quiet = !state.lastEventAt || Date.now() - state.lastEventAt > 20000 || state.es?.readyState !== 1;
  if (quiet) void resync();
}, 30000);

// A folder whose projects are all closed shows nothing but their titles, so a reorder there is easy to
// miss and no row event is arriving to trigger one — check it on a clock instead. Folders holding an open
// project are skipped inside reorderProjects(), so this never moves a card being read. The cadence is a
// setting (0 turns it off): some readers want the board to settle and stay put.
const REORDER_KEY = "wm.reorderSeconds";
const REORDER_DEFAULT = 5;
const REORDER_MAX = 600;

function reorderSeconds() {
  const stored = localStorage.getItem(REORDER_KEY);
  // Number(null) is 0, which would read as "off" for a reader who never touched the setting.
  if (stored === null || stored === "") return REORDER_DEFAULT;
  const n = Number(stored);
  if (!Number.isFinite(n) || n < 0) return REORDER_DEFAULT;
  return Math.min(REORDER_MAX, Math.round(n));
}

function startReorderClock() {
  clearInterval(state.reorderTimer);
  const every = reorderSeconds();
  state.reorderTimer = every > 0
    ? setInterval(() => {
        if (document.hidden) return;
        reorderProjects();
      }, every * 1000)
    : null;
}

document.addEventListener("visibilitychange", () => {
  // Coming back to the tab: one catch-up, then the stream and the 1s tick take over again.
  if (!document.hidden) void resync();
});

// ---- page zoom -------------------------------------------------------------------------------
// Nothing in this page blocks the browser's own zoom, but when it is opened inside a shell that
// swallows Ctrl +/- (an embedded pane, a kiosk window) there is no way to make the table bigger.
// So the page owns a scale factor as well: Ctrl+wheel, Ctrl +/- and the − 100% + control above.
const ZOOM_KEY = "wtgui.zoom";
const ZOOM_MIN = 50;
const ZOOM_MAX = 250;

function applyZoom(pct, { save = true } = {}) {
  const n = Number(pct);
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number.isFinite(n) ? Math.round(n / 10) * 10 : 100));
  state.zoom = z;
  // `zoom` scales layout, not just paint, so the sticky header and the table stay coherent.
  document.documentElement.style.zoom = z === 100 ? "" : String(z / 100);
  const label = $("zoom-pct");
  if (label) label.textContent = `${z}%`;
  if (save) {
    try {
      localStorage.setItem(ZOOM_KEY, String(z));
    } catch {
      /* private mode: the zoom just will not persist */
    }
  }
}

function zoomBy(delta) {
  applyZoom((state.zoom || 100) + delta);
}

$("btn-zoom-in")?.addEventListener("click", () => zoomBy(10));
$("btn-zoom-out")?.addEventListener("click", () => zoomBy(-10));

document.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 10 : -10);
  },
  { passive: false },
);

// ---- Hot Agent ---------------------------------------------------------------------------
// A rotation through the agents that are waiting on you: a card whose latest turn is NOT running has said what
// it wanted and is sitting there. Turning this on opens the first one, puts the caret in its reply box and
// flashes that box amber; Enter sends and moves to the next, Alt+Right skips one, Alt+Left steps back. The box
// flashes on every hop, not just the first, so the eye can follow the caret through the list.

function hotWaiting() {
  return conversations().filter((c) => {
    const t = c.latest || {};
    return t.status !== "running" && t.status !== "starting";
  });
}

function hotCandidates() {
  const waiting = hotWaiting();
  // Visible cards first, in the order the board shows them, then everything else newest-first: a folded
  // project has no cards in the DOM and those agents are just as waiting.
  const rank = new Map([...document.querySelectorAll(".agents-block .job")].map((el, i) => [el.dataset.thread, i]));
  const dom = waiting.filter((c) => rank.has(c.thread)).sort((a, b) => rank.get(a.thread) - rank.get(b.thread));
  const rest = waiting
    .filter((c) => !rank.has(c.thread))
    .sort((a, b) => Date.parse(b.latest?.startedAt || 0) - Date.parse(a.latest?.startedAt || 0));
  return [...dom, ...rest].map((c) => c.thread);
}

function hotRowFor(thread) {
  for (const row of state.rows.values()) {
    if (agentsFor(row).some((c) => c.thread === thread)) return row;
  }
  return null;
}

function hotStillWaiting(thread) {
  const conv = conversations().find((c) => c.thread === thread);
  if (!conv) return false;
  const t = conv.latest || {};
  return t.status !== "running" && t.status !== "starting";
}

// The whole card flashes, not just the box: the rotation moves the reader's attention to a panel, and a ring
// around the panel is what says "this one". The caret still lands in the reply box.
function flashHotCard(card) {
  if (!card) return;
  card.classList.remove("hot-flash");
  void card.offsetWidth; // restart it even when the last flash is still fading
  card.classList.add("hot-flash");
  clearTimeout(card._hotFlashT);
  card._hotFlashT = setTimeout(() => card.classList.remove("hot-flash"), 1300);
}

function paintHotButton() {
  const btn = $("btn-hot");
  if (!btn) return;
  const h = state.hot;
  btn.classList.toggle("on", h.on);
  btn.textContent = h.on ? `Hot Agent ${Math.min(h.cursor + 1, h.stack.length)}/${h.stack.length}` : "Hot Agent";
  btn.title = h.on
    ? "Hot Agent is on — Enter sends and moves to the next waiting agent, Alt+Right skips, Alt+Left goes back. Click to stop."
    : "Hot Agent — step through the agents that are waiting on you: each one is opened, its reply box focused and flashed amber. Enter sends and moves on; Alt+Right skips; Alt+Left goes back.";
}

function hotFocus(thread) {
  const row = hotRowFor(thread);
  if (!row) return false;
  if (!state.expandedProjects.has(row.project)) toggleProject(row.project);
  const key = keyOf(row.project, row.path);
  if (!state.expanded.has(key)) {
    document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  }
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return false;
  if (card.classList.contains("collapsed")) card.querySelector(".job-head")?.click();
  scrollCardUnderBar(card);
  const box = card.querySelector(".reply-box");
  if (box) {
    try {
      box.focus({ preventScroll: true });
    } catch {
      box.focus();
    }
    const end = box.value.length;
    if (box.setSelectionRange) box.setSelectionRange(end, end);
  }
  flashHotCard(card);
  return true;
}

function hotStep(dir) {
  const h = state.hot;
  if (!h.on) return;
  if (dir > 0) {
    let i = h.cursor;
    while (i + 1 < h.stack.length) {
      i += 1;
      if (hotStillWaiting(h.stack[i]) && hotFocus(h.stack[i])) {
        h.cursor = i;
        paintHotButton();
        return;
      }
    }
    const next = hotCandidates().find((t) => !h.stack.includes(t));
    if (!next) {
      showBanner("Hot Agent: no agents are waiting for input");
      return;
    }
    h.stack.push(next);
    h.cursor = h.stack.length - 1;
    hotFocus(next);
    paintHotButton();
    return;
  }
  let i = h.cursor;
  while (i - 1 >= 0) {
    i -= 1;
    if (hotStillWaiting(h.stack[i]) && hotFocus(h.stack[i])) {
      h.cursor = i;
      paintHotButton();
      return;
    }
  }
}

function hotToggle() {
  const h = state.hot;
  h.on = !h.on;
  if (!h.on) {
    h.stack = [];
    h.cursor = -1;
    paintHotButton();
    return;
  }
  const list = hotCandidates();
  if (!list.length) {
    h.on = false;
    paintHotButton();
    showBanner("Hot Agent: no agents are waiting for input");
    return;
  }
  h.stack = [list[0]];
  h.cursor = 0;
  paintHotButton();
  hotFocus(list[0]);
}

// Enter in the hot card: the reply is on its way, so fold that project away and step on.
function hotAfterSend(thread) {
  if (!state.hot.on) return;
  const row = hotRowFor(thread);
  if (row && state.expandedProjects.has(row.project)) toggleProject(row.project);
  hotStep(1);
}

$("btn-hot")?.addEventListener("click", (e) => {
  e.stopPropagation();
  hotToggle();
});
window.addEventListener("keydown", (e) => {
  if (!state.hot.on || !e.altKey) return;
  if (e.key === "ArrowRight") {
    e.preventDefault();
    hotStep(1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    hotStep(-1);
  }
});

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // Ctrl+, opens Settings even if the button is out of reach (a host shell can eat pointer events).
  if (e.key === "," || e.key === "<") {
    e.preventDefault();
    toggleSettings();
    return;
  }
  if (e.key === "+" || e.key === "=") {
    e.preventDefault();
    zoomBy(10);
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    zoomBy(-10);
  } else if (e.key === "0") {
    e.preventDefault();
    applyZoom(100);
  }
});

try {
  applyZoom(Number(localStorage.getItem(ZOOM_KEY) || 100), { save: false });
} catch {
  applyZoom(100, { save: false });
}

// ---- fonts: two settings, not one ----------------------------------------------
// Panel font: the page's own labels, headings and buttons (--ui).
// Terminal font: the text inside an agent card — transcript, prompt, reply box, command preview
// (--term). They are separate on purpose: a readable serif UI with a monospace transcript is a
// normal preference, and so is the other way round.
// Stacks, not families: the first face the machine actually has wins, so listing one that is not
// installed is harmless.
const UI_FONTS = [
  { id: "default", label: "Default (system UI)", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "segoe", label: "Segoe UI", stack: '"Segoe UI", system-ui, sans-serif' },
  { id: "calibri", label: "Calibri", stack: 'Calibri, "Segoe UI", sans-serif' },
  { id: "tahoma", label: "Tahoma", stack: 'Tahoma, Verdana, sans-serif' },
  { id: "verdana", label: "Verdana", stack: 'Verdana, Geneva, sans-serif' },
  { id: "trebuchet", label: "Trebuchet MS", stack: '"Trebuchet MS", "Segoe UI", sans-serif' },
  { id: "georgia", label: "Georgia (serif)", stack: 'Georgia, "Times New Roman", serif' },
  { id: "consolas", label: "Consolas (monospace UI)", stack: 'Consolas, "Cascadia Mono", monospace' },
  { id: "cascadia", label: "Cascadia Code (monospace UI)", stack: '"Cascadia Code", Consolas, monospace' },
  { id: "jetbrains", label: "JetBrains Mono (monospace UI)", stack: '"JetBrains Mono", Consolas, monospace' },
];

const TERM_FONTS = [
  { id: "default", label: "Default (monospace)", stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
  { id: "consolas", label: "Consolas", stack: 'Consolas, "Cascadia Mono", monospace' },
  { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", Consolas, monospace' },
  { id: "cascadia-mono", label: "Cascadia Mono", stack: '"Cascadia Mono", Consolas, monospace' },
  { id: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono", Consolas, monospace' },
  { id: "fira", label: "Fira Code", stack: '"Fira Code", Consolas, monospace' },
  { id: "source-code", label: "Source Code Pro", stack: '"Source Code Pro", Consolas, monospace' },
  { id: "ibm-plex", label: "IBM Plex Mono", stack: '"IBM Plex Mono", Consolas, monospace' },
  { id: "inconsolata", label: "Inconsolata", stack: 'Inconsolata, "Inconsolata-g", Consolas, monospace' },
  { id: "victor", label: "Victor Mono", stack: '"Victor Mono", Consolas, monospace' },
  { id: "ubuntu-mono", label: "Ubuntu Mono", stack: '"Ubuntu Mono", Consolas, monospace' },
  { id: "hack", label: "Hack", stack: 'Hack, Consolas, monospace' },
  { id: "menlo", label: "Menlo", stack: 'Menlo, Consolas, monospace' },
  { id: "lucida", label: "Lucida Console", stack: '"Lucida Console", Consolas, monospace' },
  { id: "courier", label: "Courier New", stack: '"Courier New", monospace' },
  { id: "panel", label: "Same as the panel font", stack: "var(--ui)" },
];

// Console text size and weight. Sizes are px at the console's default line-height; weights are the four
// the monospace faces on this box actually resolve to.
const TERM_SIZES = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 18];
const TERM_WEIGHTS = [
  { id: "300", label: "Light (300)" },
  { id: "400", label: "Normal (400)" },
  { id: "500", label: "Medium (500)" },
  { id: "600", label: "Semibold (600)" },
  { id: "700", label: "Bold (700)" },
];

// A monospace face has no emoji of its own, and a stack that ends in `monospace` hands the glyph to
// whatever monochrome symbol font the system offers — the console's tool icons then come out as small
// grey marks instead of 📖 💻 🔧. Name the colour emoji fonts just before the generic keyword, so
// ASCII still resolves in the chosen face and only the glyphs fall through.
const EMOJI_FALLBACK = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"';
function withEmojiFallback(stack) {
  const s = String(stack || "").trim();
  if (!s || s.includes("Emoji")) return s;
  const m = /^(.*?),?\s*(monospace|sans-serif|serif|system-ui)$/.exec(s);
  return m ? `${m[1]}, ${EMOJI_FALLBACK}, ${m[2]}` : `${s}, ${EMOJI_FALLBACK}`;
}

const FONT_SETS = {
  ui: { key: "wtgui.font", varName: "--ui", select: "font-select", preview: "font-preview", list: UI_FONTS },
  term: { key: "wtgui.termFont", varName: "--term", select: "term-select", preview: "term-preview", list: TERM_FONTS },
};

function currentFontId(kind) {
  const set = FONT_SETS[kind] || FONT_SETS.ui;
  let id = "default";
  try {
    id = localStorage.getItem(set.key) || "default";
  } catch {
    /* private mode: the default is fine */
  }
  return set.list.some((f) => f.id === id) ? id : "default";
}

function applyFont(kind, id, { save = true } = {}) {
  const set = FONT_SETS[kind] || FONT_SETS.ui;
  const font = set.list.find((f) => f.id === id) || set.list[0];
  document.documentElement.style.setProperty(set.varName, withEmojiFallback(font.stack));
  const sel = $(set.select);
  if (sel && sel.value !== font.id) sel.value = font.id;
  const preview = $(set.preview);
  if (preview) preview.style.fontFamily = font.stack;
  if (save) {
    try {
      localStorage.setItem(set.key, font.id);
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

// Console size/weight are not part of the font stacks: they are two vars the console box reads, so the
// panel can resize its own output without touching anything the reader types.
function termSize() {
  let n = 11.5;
  try {
    n = Number(localStorage.getItem("wtgui.termSize")) || 11.5;
  } catch {
    /* private mode */
  }
  return TERM_SIZES.includes(n) ? n : 11.5;
}

function termWeight() {
  let w = "400";
  try {
    w = localStorage.getItem("wtgui.termWeight") || "400";
  } catch {
    /* private mode */
  }
  return TERM_WEIGHTS.some((x) => x.id === w) ? w : "400";
}

function applyTermStyle({ save = false, size = null, weight = null } = {}) {
  const n = size === null ? termSize() : Number(size) || 11.5;
  const w = weight === null ? termWeight() : String(weight);
  document.documentElement.style.setProperty("--term-size", `${n}px`);
  document.documentElement.style.setProperty("--term-weight", w);
  const sizeSel = $("term-size-select");
  if (sizeSel && sizeSel.value !== String(n)) sizeSel.value = String(n);
  const weightSel = $("term-weight-select");
  if (weightSel && weightSel.value !== w) weightSel.value = w;
  // The preview must show what it describes, or it is just decoration.
  const preview = $("term-preview");
  if (preview) {
    preview.style.fontSize = `${n}px`;
    preview.style.fontWeight = w;
  }
  if (save) {
    try {
      localStorage.setItem("wtgui.termSize", String(n));
      localStorage.setItem("wtgui.termWeight", w);
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

// The grey flash says "re-read, nothing moved". It is useful when watching a row settle and noise when the board
// is busy, so it can be switched off - while the green flash, which means something actually happened, cannot.
// A body class is enough: the row still gets its class for 950ms, the animation just does not run.
function greyFlashOn() {
  try {
    return localStorage.getItem("wtgui.greyFlash") !== "0";
  } catch {
    return true;
  }
}

function applyGreyFlash(on) {
  document.body.classList.toggle("no-grey-flash", !on);
  const box = $("grey-flash");
  if (box && box.checked !== on) box.checked = on;
  try {
    localStorage.setItem("wtgui.greyFlash", on ? "1" : "0");
  } catch {
    /* private mode: the choice just will not persist */
  }
}

function toggleSettings(open = null) {
  const panel = $("settings");
  if (!panel) return;
  const show = open === null ? panel.classList.contains("hidden") : open;
  panel.classList.toggle("hidden", !show);
  if (!show) return;
  const sel = $("font-select");
  if (sel) {
    sel.value = currentFontId("ui");
    sel.focus();
  }
  // Read the gateway's window every time the panel opens: it can be changed from a CLI, and the
  // panel is not the owner of that value.
  void loadApprovalSetting();
  void loadSessionSetting();
}

// ---- the approval window -------------------------------------------------------------------
// approvals.timeout is not a panel preference like the fonts above it. The gate that waits for a
// human runs inside the GATEWAY that is executing the turn, so the server reads and writes the
// gateway's own Hermes config.yaml; the panel only shows what that file says. Which is also why this
// control can be unavailable — a gateway on another machine keeps its own file.
let approvalState = null;

// The same wording the gateway uses for its own timeout notice: 600 → "10 minutes", 7200 → "2 hours".
function humanWindow(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s && s % 3600 === 0) return `${s / 3600} hour${s / 3600 === 1 ? "" : "s"}`;
  if (s && s % 60 === 0) return `${s / 60} minute${s / 60 === 1 ? "" : "s"}`;
  return `${s} second${s === 1 ? "" : "s"}`;
}

function paintApprovalSetting(note = "", bad = false) {
  const s = approvalState;
  if (!s) return;
  const input = $("approval-timeout");
  if (input) {
    // A rejected save must leave what was typed in the box: snapping back to the stored number reads
    // as "it saved that instead", when the save is exactly what failed.
    if (!bad && document.activeElement !== input) input.value = s.timeoutSeconds;
    input.disabled = !s.editable;
    input.min = String(s.minSeconds || 15);
    input.max = String(s.maxSeconds || 86400);
  }
  const save = $("btn-approval-save");
  if (save) {
    save.disabled = !s.editable;
    // Armed whenever the box differs from the file — including after a rejection, where the typed
    // value is still sitting there unsaved and the button must not look inert.
    save.classList.toggle("dirty", Boolean(input) && String(input.value) !== String(s.timeoutSeconds));
  }
  const preview = $("approval-preview");
  if (preview) {
    const bits = [`${humanWindow(s.timeoutSeconds)} · ${s.timeoutSeconds} s`];
    bits.push(s.fromFile ? "set in config.yaml" : "the gateway's built-in default (no timeout in config.yaml)");
    if (s.mode && s.mode !== "manual") bits.push(`approvals.mode ${s.mode} — only the asks that still happen get this window`);
    preview.textContent = bad
      ? `NOT SAVED — ${note}. config.yaml still says ${s.timeoutSeconds} s.`
      : note
        ? `${note} — ${bits.join(" · ")}`
        : bits.join(" · ");
    preview.classList.toggle("bad", bad);
    preview.title = s.configPath;
  }
  const noteEl = $("approval-note");
  if (noteEl) {
    noteEl.textContent = s.editable
      ? `How long a permission prompt waits for you before it fails closed — if it expires, nothing runs. Written to ${s.configPath}, which the gateway re-reads, so the next prompt uses it without a restart.`
      : `${s.reason || "this window cannot be changed from here"} — nothing is written.`;
  }
}

async function loadApprovalSetting() {
  try {
    const r = await apiFetch("/api/settings/approvals");
    approvalState = await r.json();
    paintApprovalSetting();
  } catch (e) {
    const preview = $("approval-preview");
    if (preview) {
      preview.textContent = `could not read the approval window: ${e.message}`;
      preview.classList.add("bad");
    }
  }
}

async function saveApprovalSetting() {
  const input = $("approval-timeout");
  if (!input || !approvalState?.editable) return;
  const preview = $("approval-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutSeconds: Number(input.value) }),
    });
    const d = await r.json();
    if (!r.ok) {
      // Keep what the file still says in approvalState, so a rejected value can never look saved.
      paintApprovalSetting(d.error || `HTTP ${r.status}`, true);
      return;
    }
    approvalState = d;
    paintApprovalSetting(d.note || "saved");
  } catch (e) {
    paintApprovalSetting(e.message, true);
  }
}

// ---- how often the closed part of the board re-sorts -----------------------------------------
function paintReorderSetting(note = "") {
  const input = $("reorder-every");
  const every = reorderSeconds();
  if (input && document.activeElement !== input) input.value = String(every);
  const preview = $("reorder-preview");
  if (preview) {
    preview.textContent = note
      ? `${note} — ${every ? `re-sorting every ${humanWindow(every)}` : "re-sorting off"}`
      : every
        ? `closed folders and projects re-sort every ${humanWindow(every)} (${every} s)`
        : "closed folders and projects stay where they are (0 = off)";
  }
}

function saveReorderSetting(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    paintReorderSetting("NOT SAVED — give a number of seconds, 0 for off");
    return;
  }
  const clamped = Math.min(REORDER_MAX, Math.round(n));
  try {
    localStorage.setItem(REORDER_KEY, String(clamped));
  } catch {
    paintReorderSetting("NOT SAVED — this browser refused to store the setting");
    return;
  }
  startReorderClock();
  paintReorderSetting(clamped === Math.round(n) ? "saved" : `saved, clamped to ${REORDER_MAX} s`);
}

// ---- how many sessions the CLI's picker lists ------------------------------------------------
// Not a panel preference and not a retention policy: the store keeps every session, and this is the
// number the CLI's in-chat browser used to hardcode. It writes `sessions.list_limit`, which only the
// local CLI patch reads — so the row says so when that patch is missing, instead of saving a number
// nothing will honour.
let sessionsState = null;

function paintSessionSetting(note = "", bad = false) {
  const s = sessionsState;
  if (!s) return;
  const input = $("session-limit");
  if (input) {
    // Same as the approval window: a rejected value stays visible so it can be corrected, and the
    // line underneath says what the file actually holds.
    if (!bad && document.activeElement !== input) input.value = s.listLimit;
    input.disabled = !s.editable;
    input.min = String(s.minLimit || 1);
    input.max = String(s.maxLimit || 500);
  }
  const save = $("btn-session-limit-save");
  if (save) {
    save.disabled = !s.editable;
    save.classList.toggle("dirty", Boolean(input) && String(input.value) !== String(s.listLimit));
  }
  const preview = $("session-preview");
  if (preview) {
    const bits = [`${s.listLimit} shown in /sessions`];
    if (s.store) bits.push(`${s.store.sessions} in the store`);
    bits.push(s.fromFile ? "set in config.yaml" : "the default (config.yaml does not set it)");
    if (s.patched === false) bits.push("CLI patch missing — this number is ignored");
    preview.textContent = bad
      ? `NOT SAVED — ${note}. config.yaml still says ${s.listLimit}.`
      : note
        ? `${note} — ${bits.join(" · ")}`
        : bits.join(" · ");
    preview.classList.toggle("bad", bad || s.patched === false);
    preview.title = s.configPath;
  }
  const noteEl = $("session-note");
  if (noteEl) {
    const store = s.store
      ? `The store holds ${s.store.sessions} sessions and ${s.store.messages.toLocaleString()} messages — nothing deletes at ten. `
      : "The store could not be read. ";
    noteEl.textContent =
      s.patched === false
        ? `${store}That number is written to config.yaml, but the installed CLI has no patch to read it (a hermes update replaces hermes_cli/*.py) — re-apply docs/hermes-cli-session-limit.diff.`
        : `${store}This only changes how many the CLI's /sessions and /resume browser list at once.`;
  }
}

async function loadSessionSetting() {
  try {
    const r = await apiFetch("/api/settings/sessions");
    sessionsState = await r.json();
    paintSessionSetting();
  } catch (e) {
    const preview = $("session-preview");
    if (preview) {
      preview.textContent = `could not read the session list setting: ${e.message}`;
      preview.classList.add("bad");
    }
  }
}

async function saveSessionSetting() {
  const input = $("session-limit");
  if (!input || !sessionsState?.editable) return;
  const preview = $("session-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listLimit: Number(input.value) }),
    });
    const d = await r.json();
    if (!r.ok) {
      paintSessionSetting(d.error || `HTTP ${r.status}`, true);
      return;
    }
    sessionsState = d;
    paintSessionSetting(d.note || "saved");
  } catch (e) {
    paintSessionSetting(e.message, true);
  }
}

// The pickers are filled once, at start-up: a saved choice then has a real option to sit on before
// the panel is ever opened.
function initFonts() {
  for (const kind of Object.keys(FONT_SETS)) {
    const set = FONT_SETS[kind];
    const sel = $(set.select);
    if (sel && !sel.options.length) {
      sel.innerHTML = set.list.map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join("");
    }
    applyFont(kind, currentFontId(kind), { save: false });
  }
  const sizeSel = $("term-size-select");
  if (sizeSel && !sizeSel.options.length) {
    sizeSel.innerHTML = TERM_SIZES.map((n) => `<option value="${n}">${n}px</option>`).join("");
  }
  const weightSel = $("term-weight-select");
  if (weightSel && !weightSel.options.length) {
    weightSel.innerHTML = TERM_WEIGHTS.map((w) => `<option value="${w.id}">${esc(w.label)}</option>`).join("");
  }
  applyTermStyle({ save: false });
}

$("btn-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
$("btn-settings-close")?.addEventListener("click", () => toggleSettings(false));
// A second way in that is always on screen at the top left: the title opens Settings.
$("title-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
$("font-select")?.addEventListener("change", (e) => applyFont("ui", e.target.value));
$("term-select")?.addEventListener("change", (e) => applyFont("term", e.target.value));
$("term-size-select")?.addEventListener("change", (e) => applyTermStyle({ save: true, size: e.target.value }));
$("grey-flash")?.addEventListener("change", (e) => applyGreyFlash(Boolean(e.target.checked)));
$("term-weight-select")?.addEventListener("change", (e) => applyTermStyle({ save: true, weight: e.target.value }));

// The approval window. A preset only fills the box and lights Save: one click here rewrites the
// user's global Hermes config, so it takes a deliberate second one.
$("btn-approval-save")?.addEventListener("click", () => void saveApprovalSetting());
$("btn-session-limit-save")?.addEventListener("click", () => void saveSessionSetting());
$("session-limit")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void saveSessionSetting();
});
$("session-limit")?.addEventListener("input", (e) => {
  const dirty = Number(e.target.value) !== sessionsState?.listLimit;
  $("btn-session-limit-save")?.classList.toggle("dirty", dirty);
});
$("approval-timeout")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void saveApprovalSetting();
});
$("approval-timeout")?.addEventListener("input", (e) => {
  const dirty = Number(e.target.value) !== approvalState?.timeoutSeconds;
  $("btn-approval-save")?.classList.toggle("dirty", dirty);
});
for (const btn of document.querySelectorAll("[data-approval-set]")) {
  btn.addEventListener("click", () => {
    const input = $("approval-timeout");
    if (!input || input.disabled) return;
    input.value = btn.dataset.approvalSet;
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
}
document.addEventListener("click", (e) => {
  const panel = $("settings");
  if (!panel || panel.classList.contains("hidden")) return;
  if (panel.contains(e.target) || (e.target.closest && e.target.closest("#btn-settings"))) return;
  toggleSettings(false);
});

initFonts();
applyGreyFlash(greyFlashOn());
// The model menu is filled once at start-up from the gateway's own provider list; a failure leaves
// the "(gateway default)" entry, which is what a spawn sends anyway.
void loadModels();

// The board-reorder cadence: an input plus presets, applied the moment it is accepted.
$("reorder-every")?.addEventListener("change", (e) => saveReorderSetting(e.target.value));
$("reorder-every")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveReorderSetting(e.target.value);
    e.target.blur();
  }
});
for (const b of document.querySelectorAll("[data-reorder-set]")) {
  b.addEventListener("click", () => {
    saveReorderSetting(b.dataset.reorderSet);
    const input = $("reorder-every");
    if (input) input.value = String(reorderSeconds());
  });
}
startReorderClock();
paintReorderSetting();

// Reflect the remembered collapse state of the two fixed cards before the first paint of them.
for (const id of ["newagent", "agents"]) applyFixedCollapse(id);

(async function boot() {
  try {
    const cfg = await apiFetch("/api/config").then((r) => r.json());
    state.settings = cfg;
    state.scanRoots = Array.isArray(cfg.scanRoots) ? cfg.scanRoots : [];
    $("f-worktree").textContent = cfg.worktreeSeconds;
    $("f-slow").textContent = cfg.slowSeconds;
    paintConfigLine();
    // Deliberately no seeding of state.projects from cfg.projects here: before discovery has
    // run that list is only the config fallback, and a project seeded that way can never be
    // removed by a later snapshot (heroes-js showed up forever this way on a machine that does
    // not have it). The first snapshot paints the real set.
    await resync();
    connect();
    state.eventsAt = Date.now();
  } catch (e) {
    setStream("offline", "bad");
    showBanner(`Cannot reach the server: ${e.message}. Start it with npm start.`);
  }
})();
