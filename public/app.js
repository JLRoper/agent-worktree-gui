// Worktree Monitor client.
//   - worktree rows are patched individually from the SSE stream
//   - liveness is shown as labelled evidence chips (files / hermes / board / port)
//   - agents spawned from the "New agent" card stream their stdout live

// Declared BEFORE `state`: it is read while the state literal below is built, and a `const` further
// down the file would still be in its temporal dead zone at that moment (the read would throw and get
// swallowed, leaving an empty history).
const SPAWN_HISTORY_KEY = "wm.spawnHistory";
const SPAWN_HISTORY_MAX = 50;

// Both loaders below run while `state` is being built. Their keys have to be initialised by then: a `const`
// declared further down is in its temporal dead zone at this point, and the ReferenceError would be swallowed
// by the loader's own try/catch (which is exactly how the saved project colour and the anchor pin came back
// empty after every reload).
const PROJECT_HUE_KEY = "wm.projectHues";
const ANCHOR_THREAD_KEY = "wm.anchorThread";
const ANCHOR_HOVER_KEY = "wm.anchorHover";
const ANCHOR_HOVER_SECONDS_KEY = "wm.anchorHoverSeconds";
const ANCHOR_HOVER_SECONDS_DEFAULT = 3;
const ANCHOR_TOUCH_KEY = "wm.anchorTouch";          // was wm.anchorFollow
const ANCHOR_TOUCH_SECONDS_KEY = "wm.anchorTouchSeconds"; // was wm.anchorFollowSeconds
const ANCHOR_TOUCH_SECONDS_DEFAULT = 30;
const FLASH_TIME_KEY = "wm.flashSeconds";
const FLASH_TIME_DEFAULT = 0.9;   // seconds; the row flash the panel has always used
const EVENT_FLASH_KEY = "wm.eventFlash";   // flash a row when an event of its own arrives (on by default)
// Names typed onto a worktree, by row key. Declared up here because `state` reads it while it is being built, and a
// const below `state` is still in its dead zone at that moment - the try/catch in the loader swallowed the error and
// every reload came back with the agent's title instead of the name that was typed.
const TREENAMES_KEY = "wtgui.treenames";
// Which charts are showing every tree, as a set of project names. Declared up here for the same reason as
// TREENAMES_KEY just above: `state` reads this key while it is being built, and a const below `state` is still in
// its dead zone at that moment. The loader's try/catch swallowed the ReferenceError, so the choice was written to
// localStorage and then never read back - every reload held the stale rows again and pointed the arrow down.
const SHOW_OLD_KEY = "wtgui.showOldProjects";

// The chip-bearing drafts this tab already holds (board/paste-chips.js): each chip's own text by id, and
// the segments of every box that carries one. Read ONCE, above `state`, so a box can be restored from it
// the moment it is rendered — the same reason TREENAMES_KEY lives up here.
const boxChips = loadPasteChipState();

// The row ranking averages a row's liveness over a SLIDING WINDOW of the events it receives, instead of keying
// on the single newest one. Declared above `state` because the state literal reads the saved window below, and a
// const further down would still be in its temporal dead zone at that moment.
const RANK_WINDOW_KEY = "wm.rankWindowSeconds";
const RANK_WINDOW_DEFAULT = 300;   // seconds: the five minutes the reader asked for
const RANK_WINDOW_MIN = 30;
const RANK_WINDOW_MAX = 3600;
const RANK_EVENT_CAP = 400;        // hard cap on one row's ring, so an eight-hour session cannot grow it
// Hysteresis: a row takes the slot above it only when its smoothed rate beats that row's by this many events
// PER MINUTE. One console line is 0.2/min over the default window, so it can never twitch the order; a row being
// hammered clears the margin comfortably, and a row that has gone quiet yields as its events age out.
const RANK_MARGIN_PER_MIN = 1;

const state = {
  // thread -> px. Ctrl+wheel over a console zooms that console only, like a terminal window; the Settings
  // "Console size" stays the baseline for every card. Kept in memory so a repaint does not undo it.
  consoleZoom: new Map(),
  // Ctrl+wheel over a thinking body sizes it, the same way it sizes the console - per card, so one long reasoning
  // block can be shrunk without touching the rest of the board.
  thinkZoom: new Map(),
  // Hot Agent: the rotation through agents that are waiting for input. `stack` is the visit history (so
  // Alt+Left can walk back), `cursor` points at the one on screen.
  hot: { on: false, stack: [], cursor: -1 },
  // The amber flash is held here, not only on the DOM node: opening a project or a row repaints the card, and a
  // class added to the old element dies with it. The renderer re-applies it until the window closes.
  hotFlash: { thread: null, until: 0 },
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
  // The open "remove this worktree?" row, by row key. It lives in the table between the row and its
  // detail, so every path that moves or rebuilds rows has to carry it or it drifts to the top.
  confirmEls: new Map(),
  tbodyEls: new Map(),
  settings: {},
  // Where this board's links go (server: lib/hosts.js). `{hosts, projects, file, seedFile, warnings}`; the per-project
  // entry says which host a project resolves to and why it does not, and the header's chip reads it.
  hosts: null,
  // The open host-mapping strip, by project: { project, host, coords, line, error, busy }. Kept here, not only in the
  // DOM, so a snapshot repaint (every few seconds) does not wipe the proposal the reader is looking at.
  hostPanel: null,
  spawn: {},
  paused: false,
  es: null,
  events: 0,
  eventsAt: 0,
  lastEventAt: null,
  pool: null,
  jobs: new Map(),
  jobLines: new Map(),
  // The signature of the unattached list as it was last WRITTEN (`renderJobs`). A snapshot that changes nothing a
  // card draws must not replace the card node the run's own stream is writing into.
  jobsListSig: "",
  replyDrafts: {},
  // Pasted blocks collapsed into inline chips (board/paste-chips.js): id -> { text, lines }. The DOM holds
  // the id only, so the text lives HERE, where a card rebuild and a reload can find it again — and
  // boxModels is what those two replay: each box's own chip/text segments, keyed the way the box names
  // itself (its data-chipbox), with the id counter bumped past whatever this tab already remembers.
  pasteChips: boxChips.chips,
  pasteChipSeq: boxChips.seq,
  boxModels: boxChips.drafts,
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
  // The green + bar a reader has turned into a text field, by row key: { key, path, name, project, value, start,
  // end, focused }. One at a time - it is a quick start, not a form - and kept here so a board repaint mid-sentence
  // does not eat the draft.
  addAgent: null,
  // The order each row's agent cards were last painted in, by row key. "Stabilize reordering" holds a list still
  // while something in it is open, and this is the order it holds: without it a rebuild would fall back to
  // newest-turn-first and the frozen list would jump anyway.
  agentOrder: new Map(),
  // Names typed onto a worktree, by row key. The directory is cut from the prompt, so the board reads the agent's own
  // title instead (Hermes names the session from the work); this is the override on top of that.
  treeNames: loadTreeNames(),
  // Replies typed while the agent is still working, in the order they were written. They go out one
  // at a time as each turn finishes: Hermes refuses a second session on a thread already running.
  replyQueue: new Map(),
  // The held reply the reader has open in the in-place editor, if any: `{ thread, at, original, text }`, where `at`
  // is the entry's own identity in replyQueue — the entry a save writes back to, never a new entry. `original` is
  // the text the editor opened on (what Escape, Cancel and a click away put back) and `text` follows the box as it
  // is typed, so a repaint cannot throw a half-finished edit away.
  replyEdit: null,
  // The entries the drain has taken out of `replyQueue` to send, by thread, so a × pressed after the send
  // can say "that one was already sent" instead of claiming a cancellation it did not make. The entry's own
  // identity only (`at`): it is a record of a press, not the queue's state, and it neither renders nor sends.
  replySent: new Map(),
  // Documents pasted or dropped into a reply box, per thread: the reply area is rebuilt on every job
  // event, so these cannot live in the DOM the way the New-agent box's list can.
  replyAttachments: new Map(),
  // Row keys whose own agent evidence moved on the last paint; the reorder pass colours only these green.
  movedRows: new Set(),
  // Transcript scroll per console (pre[data-out]). Folding a project throws the console markup away,
  // so the position has to live outside the DOM or it comes back at the top.
  outScrolls: {},
  collapsedJobs: loadCollapsedJobs(),
  openDescs: loadOpenDescs(),
  // Which worktrees' TODO sections the reader unfolded (localStorage, `wm.openTodos`), and the reader's in-flight
  // add/edit text (module state, never persisted: a half-typed item is not something to bring back a reload later).
  todoOpen: loadOpenTodos(),
  // Which TODO items' fact bullets the reader unfolded, keyed "<row key>::<item id>" (localStorage,
  // `wm.openTodoFacts`). An item nobody has opened is collapsed — see loadOpenTodoFacts.
  todoFactsOpen: loadOpenTodoFacts(),
  todoDraft: null,
  // Rows whose ⟳ offered the double-check agent, by row key: `{ key, project, path, evidence }`. Outside the DOM so a
  // board repaint rebuilds the card instead of dropping the question the reader was about to answer.
  refreshOffers: new Map(),
  expandedProjects: loadExpandedProjects(),
  collapsedFixed: loadCollapsedFixed(),
  collapsedRoots: loadCollapsedRoots(),
  recentRoots: loadRecentRoots(),
  // Which projects' charts are showing every tree, threshold or not (see the age collapse below). Per project,
  // because one board holds a hundred of them.
  showOldProjects: loadShowOldProjects(),
  // Per-folder project search ("root" -> query). Not persisted: a filter is a moment's narrowing, and a
  // reload that came back with ninety projects hidden would look like the board had lost them.
  rootFilter: new Map(),
  // The card the reader pinned to hold its place, if any (one at a time, remembered between reloads).
  anchorThread: loadAnchorThread(),
  // Ctrl+click a project's title row to give that whole project box a theme colour (a hue, kept in
  // localStorage). Nothing else uses a hue, so a themed project is recognisable at a glance while the
  // verdict colours inside it keep their meaning.
  projectHues: loadProjectHues(),
  // Tool output the live stream did not carry (its `tool.completed` preview is often empty): the stored result,
  // fetched on demand when the reader opens a call. Key "<turnId>|<tool>" -> array of { text }.
  toolStore: new Map(),
  toolStorePending: new Set(),
  // Which tool bursts the reader has opened, and which tool they filtered one to: "<turnId>|<first line>" ->
  // { open, filter }. Kept here rather than in the DOM because every snapshot rebuild replaces the console's
  // markup - the block was opening and then snapping shut the next time a line arrived.
  toolGroupOpen: new Map(),
  // The individual calls behind a collapsed "+ N commands" batch, once the reader has asked for them:
  // "<burst id>|<tool>" -> [{ name, summary }] read from the session transcript.
  batchCalls: new Map(),
  // Which result boxes (every tool result's lines, a diff's windows, a file's body — core/console-format.js) the
  // reader has opened: "<burst id>|<segment>|<at>". Every box starts FOLDED, in the condensed view and in the one-stream
  // view alike, so this is the set of the ones they opened. Kept here for the same reason toolGroupOpen is — every
  // rebuild replaces the console's markup, and a box that snapped shut under the reader's cursor would read as the
  // panel losing the click.
  codeBoxOpen: new Set(),
  // The opposite book, for the boxes that are drawn OPEN because the reader asked for them (the whole stored text a
  // fold note's click reads): there it is the ones they SHUT that are remembered, by the same key.
  codeBoxShut: new Set(),
  // Which tool calls the reader has folded: "<burst id>|<segment>". A call's own row is its handle, and the fold
  // covers that call's output and nothing else. Kept here for the same reason codeBoxOpen is: a repaint or a
  // burst rebuild replaces the markup, and a call that sprang back open under the reader's cursor would read as
  // the panel losing the click.
  callFolded: new Set(),
  // The stream's tool-usage rows are the other way round: a row is SHUT until the reader opens it (the row is the
  // handle for the output a call returned, and a burst of five calls drawn open is a wall of output, not five
  // lines). So this book holds the ones they OPENED, keyed "<burst id>|c<segment>" — the same reasoning as
  // callFolded, only inverted, and it is read back on every rebuild so a store read landing mid-turn cannot shut
  // the box the reader just opened.
  callOpen: new Set(),
  // The whole stored text of a result the reader asked to see past the panel's fold: "<turnId>|<tool>|<row>" ->
  // the row /api/tool-results answered with. Only rows the reader actually opened are here (a result can be 100
  // kB, so caching them all would trade the ring buffer for a worse one), and it lives here rather than in the
  // DOM for the same reason callFolded does: a repaint or a burst rebuild replaces the console's markup, and a
  // result the reader just opened folding itself back shut would read as the panel losing the click.
  foldRows: new Map(),
  // One pending store read per result, shared by repaints and pinned copies of the same turn.
  foldPending: new Map(),
  // Events are life. A line arriving in an agent's console, a job starting or ending, an approval: each one proves
  // the worktree that owns that agent is being worked in right now, without waiting for the next scan to notice.
  // Key = worktree row key -> ms of the newest event seen for it.
  eventLife: new Map(),

  // The sliding window behind the ranking: row key -> ms timestamps of the liveness events it has received,
  // oldest first, pruned by the window and capped at RANK_EVENT_CAP. Bounded on purpose - an eight-hour session
  // must not grow it - and the only thing that decides a row's smoothed score.
  eventWindows: new Map(),
  // Row keys whose window has been seeded once from the life the row already carried (its own lastAliveAt /
  // lastEdit / lastCommit and its jobs' turn starts and ends), so a reload is not a fresh-start scramble.
  rankSeeded: new Set(),
  // ...and the same for a project's own activityAt, so a project's window is seeded once too.
  rankProjSeeded: new Set(),
  // The ranked row order per project, as of the last reorder tick: arrays of row keys, so the hysteresis pass
  // can compare a row against the slot it is trying to take. Rebuilt on the reorder clock, never per event.
  rankOrder: new Map(),
  // One green pulse per second per row, not one per line: a streaming turn emits dozens of lines a second, and
  // re-adding the class for each of them is a style pass each and a row that never stops being green.
  lastEventFlashAt: new Map(),
  // Whether an arriving event flashes the row and its project. The life clock and the ring restart happen either
  // way; this only decides whether the board says it out loud. Settings > Board.
  eventFlash: loadAnchorFlag(EVENT_FLASH_KEY, true),

  // How far back the row ranking averages, in seconds. A per-browser Display setting beside Flash time.
  rankWindowSeconds: loadRankSeconds(),
  // The reader's attention, tracked beside the geometry: the card under a moving pointer, and the card last
  // clicked / focused / typed in. Either one, while it is on screen and recent, wins over the reading line.
  hoverThread: null,
  hoverAt: 0,
  // What the reader clicked / put the caret in, as { kind: "card" | "project" | "row" | "root", id }. A moving
  // pointer can only claim a card (it passes over everything else), but a click claims the thing it landed on:
  // the project header or the worktree row is then the anchor, so an accordion opening holds its own bar still
  // instead of chasing an agent in another project.
  touchTarget: null,
  touchAt: 0,
  // Whether the anchor follows the pointer / last touched card at all, and how long a touched card keeps it.
  // Off is the pure geometry of the reading line, which is what the panel did before any of this.
  anchorHover: loadAnchorFlag(ANCHOR_HOVER_KEY, true),
  anchorHoverSeconds: loadAnchorSeconds(ANCHOR_HOVER_SECONDS_KEY, ANCHOR_HOVER_SECONDS_DEFAULT, 1),
  anchorTouch: loadAnchorFlag(ANCHOR_TOUCH_KEY, true, "wm.anchorFollow"),
  anchorTouchSeconds: loadAnchorSeconds(ANCHOR_TOUCH_SECONDS_KEY, ANCHOR_TOUCH_SECONDS_DEFAULT, 3, "wm.anchorFollowSeconds"),
  // How long the green/grey row flash lasts. The project outline and the card ring keep their old
  // proportions to it, so one number scales the whole "it moved / you are here" animation.
  flashSeconds: loadFlashSeconds(),
  cloneStatus: {},
  approvals: new Map(),
  scanRoots: [],
  pollGap: new Map(), // key -> observed seconds between that row's scans, smoothed
  lastScanAt: new Map(), // key -> ms of the previous scan we rendered
  turnOpen: new Map(), // job id -> whether that turn's body is expanded (default: only the newest)
  // Turns that were showing their body when the reader sent the next one: they keep their answer and last tool
  // line, and lose the thinking block and the tool chatter. Not folded all the way to a one-line peek - that
  // shrink is what used to drag the reply box out from under the reader's hands.
  turnCompact: new Set(),
  turnPage: new Map(), // thread -> how many pages of turns back from the newest (0 = newest page)
  gitOpen: new Set(), // row key -> the git/commit/diff accordion is unfolded
  // row key + "::modified" / "::untracked" -> that one file-list strip inside merge state is unfolded. A Set of its
  // own, so a strip opens and closes without touching the merge state strip around it or its sibling.
  gitSubOpen: new Set(),
  pinnedTurns: new Set(), // turn id -> starred, so it also shows above the paged turns
  liveOpen: new Set(), // row key -> the liveness-evidence block is unfolded
  maximized: null, // thread id of the conversation pulled out to fill the window
  zoom: 100, // page zoom percent (the browser's own Ctrl +/- is not always delivered)
  // The assistant's own Hermes thread, and the last state the server sent for it. Its card lives in the
  // floating panel (assistant.js owns the frame); the board must never render a second copy of it.
  assistantThread: "panel-assistant",
  assistant: null,
};

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

// Which descriptions the reader has UNFOLDED, by row key. The block leads the worktree's detail and starts folded,
// like the two strips under it (merge state, liveness): its folded peek says what the branch was for, which is the one
// thing worth seeing without opening anything, and the full text was taking a block's worth of height above the agents.
// Unfolding it is remembered, and only unfolding — the set starts empty, so a row nobody has opened is folded, and the
// remembered state is the reader's own.
//
// A NEW key, not an inversion of the old `wm.closedDescs`. That set was written by a build where every description
// started OPEN, so its contents describe a layout the board no longer has; read either way round it would fold or
// unfold rows on this reader's behalf. An absent key means every row folded, which is now the default.
function loadOpenDescs() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.openDescs") || "[]"));
  } catch {
    return new Set();
  }
}

function saveOpenDescs() {
  try {
    localStorage.setItem("wm.openDescs", JSON.stringify([...state.openDescs]));
  } catch {
    /* no storage: the unfold simply will not survive a reload */
  }
}

// Which TODO sections the reader has unfolded, by row key. The section starts FOLDED — that is the whole point of it:
// collapsed it reads the OLDEST incomplete item and a done/total count, which is the one line worth having on the row
// without opening anything. Unfolding is remembered (and only unfolding), so a row nobody has opened stays folded.
function loadOpenTodos() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.openTodos") || "[]"));
  } catch {
    return new Set();
  }
}

function saveOpenTodos() {
  try {
    localStorage.setItem("wm.openTodos", JSON.stringify([...state.todoOpen]));
  } catch {
    /* no storage: the unfold simply will not survive a reload */
  }
}

// Which TODO ITEMS the reader has unfolded the facts under, by row key + item id ("<key>::<item id>"). The bullets
// are up to three lines about one item and two of them repeat the same worker string, so on a twelve-item list they
// were thirty-six lines of repetition around the twelve lines worth reading. They start COLLAPSED and only an item
// whose own disclosure was pressed opens. Like the section itself, only unfolding is remembered — an item nobody has
// opened stays folded — and this is a NEW key, because no earlier build wrote one and an absent key must mean
// "every item folded" rather than re-opening a list on the reader's behalf.
function loadOpenTodoFacts() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.openTodoFacts") || "[]"));
  } catch {
    return new Set();
  }
}

function saveOpenTodoFacts() {
  try {
    localStorage.setItem("wm.openTodoFacts", JSON.stringify([...state.todoFactsOpen]));
  } catch {
    /* no storage: the unfold simply will not survive a reload */
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

// The chart's "older than N days" collapse. Rows whose LAST ACTIVITY is older than the threshold in the panel's
// config.json (`hideOlderThanDays`) are held out of the chart, and one arrow at the bottom of that chart shows
// every tree again. Both halves of that choice are remembered where a reload keeps them: the DAYS in the panel's
// own config.json (so they apply to every browser, and to the panel after a restart), and which charts are showing
// everything in this browser, per project, exactly like the folder-level All/7d choice above. The key itself is
// declared above `state`, which is what reads it.
function loadShowOldProjects() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SHOW_OLD_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveShowOldProjects() {
  try {
    localStorage.setItem(SHOW_OLD_KEY, JSON.stringify([...state.showOldProjects]));
  } catch {
    /* no storage: the choice simply will not persist */
  }
}

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

// ---- filter one folder's projects ---------------------------------------------
// A folder can hold ninety projects. The box in its header narrows the list to those whose name or path
// contains the query. Sections are hidden in place rather than re-rendered, so typing keeps the caret and
// clearing the box brings back exactly the projects (and the open ones) that were there before.
function rootFilterValue(root) {
  return String(state.rootFilter.get(root) || "");
}

function applyRootFilter(root) {
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  if (!sec) return;
  const q = rootFilterValue(root).trim().toLowerCase();
  const sections = [...sec.querySelectorAll(".root-body section.project")];
  let shown = 0;
  for (const s of sections) {
    const p = state.projects.get(s.dataset.project) || { name: s.dataset.project };
    const hay = `${p.name || ""} ${p.path || ""}`.toLowerCase();
    const hit = !q || hay.includes(q);
    s.classList.toggle("is-filtered-out", !hit);
    if (hit) shown += 1;
  }
  const count = sec.querySelector("[data-root-count]");
  if (count) {
    count.textContent = q ? `${shown}/${sections.length}` : "";
    count.classList.toggle("on", Boolean(q));
  }
  const empty = sec.querySelector("[data-root-empty]");
  if (empty) {
    empty.classList.toggle("is-on", Boolean(q) && shown === 0);
    empty.textContent = q ? `no project in this folder matches \u201c${rootFilterValue(root).trim()}\u201d` : "";
  }
  const clear = sec.querySelector("[data-root-search-clear]");
  if (clear) clear.classList.toggle("is-on", Boolean(q));
}

function setRootFilter(root, value) {
  const v = String(value ?? "");
  if (v.trim()) state.rootFilter.set(root, v);
  else state.rootFilter.delete(root);
  applyRootFilter(root);
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
  applyRootFilter(root);
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
  // This gesture owns the scroll until the layout has settled: the anchor observer would otherwise answer the
  // same growth a frame later, in the other direction (measured: +169px then -169px on one click).
  anchorMuteUntil = Date.now() + 250;
  mutate();
  const settle = () => {
    const after = findEl();
    if (!after) return;
    const delta = after.getBoundingClientRect().top - before;
    // A small correction only: a huge delta means the board really did rearrange, and yanking the page
    // to chase it would be worse than letting it move. Near the end of the document the browser cannot give
    // the whole delta back; the remainder is accepted rather than hunted frame after frame.
    if (Math.abs(delta) >= 1 && Math.abs(delta) < 600) window.scrollBy(0, delta);
  };
  settle();
  setTimeout(settle, 0);
  setTimeout(() => {
    settle();
    refreshAnchorBaseline();
  }, 80);
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
  // Sending asked for this turn: follow it even if the reader had scrolled up in an older one.
  for (const o of outs) pinConsole(o.dataset.out);
  const out = outs[outs.length - 1];
  if (out) setScroll(out, out.scrollHeight);
  const body = card.querySelector(".job-body");
  if (card.classList.contains("maximized") && body) setScroll(body, body.scrollHeight);
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
  return turnLive(j) ? "starting…" : "no output";
}

// ---- a turn held on the gateway's 429 cap -----------------------------------------------------
// The gateway answers `POST /v1/runs` with 429 when its concurrent-run cap is reached — "no slot right
// now", not "this run is broken" — and lib/jobs.js holds the turn and sends the same request again. These
// three helpers are what the card says while that happens: the head's state words, the countdown under
// them, and the one-line note a folded card carries. `waiting` is the status only a held turn has.
function isWaiting(j) {
  return String(j?.status || "") === "waiting";
}

// "try 2 of 6 · next in 3s" — where the hold has got to, from the hold record the panel publishes. Only
// what is known is said: a record without an attempt count says nothing about attempts.
function waitTries(j) {
  const w = j?.waiting || {};
  const total = Number(w.attempts);
  const n = Number(w.attempt);
  if (!Number.isFinite(total) || !Number.isFinite(n)) return "";
  return `try ${Math.min(n + 1, total)} of ${total}`;
}

function waitNext(j) {
  const until = Date.parse(String(j?.waiting?.until || ""));
  if (!Number.isFinite(until)) return "";
  const left = Math.ceil((until - Date.now()) / 1000);
  return left > 0 ? `next in ${left}s` : "sending now";
}

function waitNote(j) {
  const bits = [waitTries(j), waitNext(j)].filter(Boolean);
  return bits.length ? bits.join(" · ") : "held for a free run slot";
}

// The turn head's state words, in ONE place: the head draws them and the one-second ticker rewrites them,
// so a held turn says the same thing in both. This is the word that used to be "failed".
function turnStateText(turn) {
  // Rebuilt from the gateway's store: there is no duration to report, and "done · 0s" claims a run of zero
  // seconds that never happened here.
  if (turn.revived) return "revived";
  if (isWaiting(turn)) {
    const note = waitNote(turn);
    return `waiting for a slot ${elapsed(turn)} · ${note}`;
  }
  if (turnLive(turn)) return `running ${elapsed(turn)}`;
  return `${turn.status} · ${elapsed(turn)}${turn.tokens?.total ? ` · ${fmtTok(turn.tokens.total)} tok` : ""}`;
}

// A minimized card is a head and one line, and the head's pill only says whether the agent is LIVE - not how its
// last turn ended. The line under it carries the outcome: the same status word the turn's own head shows (done,
// failed, interrupted, cancelled, waiting, running), how long the turn ran, and then either the reason it died or
// the last thing it printed. A reason beats the last output: "the panel restarted while this was running" is what
// a reader needs, and it was only visible with the card open.
function jobStatusWord(j) {
  // A turn rebuilt from the gateway's store never ran here: "done · 0s" would be a claim about a duration this panel
  // never measured, so it says "revived", the same word the turn's own head uses.
  if (j.revived) return "revived";
  // Waiting for a run slot is its OWN word — not "failed", which is what the card used to say the instant the
  // gateway answered 429, and not "running", which it is not yet. The turn is held, not lost (lib/jobs.js).
  if (isWaiting(j)) return "waiting for a slot";
  if (turnLive(j)) return "running";
  return String(j.status || "").trim() || "unknown";
}

function jobStatusClass(j) {
  const s = jobStatusWord(j);
  if (s === "failed") return "failed";
  if (s === "waiting for a slot") return "waiting";
  // Interrupted means the run outlived something - the panel restarting, a stream dying. That is the one a folded
  // card has to say out loud, because the gateway may still be working on it.
  if (s === "interrupted") return "interrupted";
  if (s === "running") return "run";
  return "quiet";
}

// ---- the live pulse ---------------------------------------------------------------------------
// A live card used to say "running" and nothing else, so a model that was thinking with no tool call yet left
// the reader watching a blank row. This is the panel's HEARTBEAT on the run's event stream: it says what the
// last thing it heard was, and how long ago - never that the agent is thinking about anything, and never any
// reasoning text. The word is the only claim it makes; the age is the only number it shows.
//
// Five states, and they are five different facts:
//   stream     a text delta arrived after the last tool boundary - text is arriving now ("thinking 2s")
//   tool       a tool is in flight: named, because waiting on a command is not waiting on tokens
//   silent     nothing for a while, still pulsing: the run is live, its last event is old ("thinking 1m 10s")
//   no signal  the gateway has sent NO event since the run started - that is a gateway not sending, not an
//              agent thinking, and the pulse says so instead of pretending to read a mind
//   polled     this gateway does not advertise run_events_sse: there is no stream to judge, and a 15s poll
//              must never read as a stalled model
//
// `live` comes from lib/jobs.js (`summary().live`, and on every console line), so the pulse is drawn from what
// the subscriber actually received - a card cannot claim events the panel never saw.
const PULSE_SILENT_SECONDS = 20; // past this, "thinking 2s" would be a lie: it is silence with a live run

function livePulse(j) {
  // A held turn (the gateway's 429 cap) has no run yet; its own head already says what it is waiting for.
  if (!j || !j.live || !turnLive(j) || isWaiting(j)) return null;
  const now = Date.now();
  const started = Number(j.live.startedAt) || Date.parse(j.startedAt || "") || now;
  const last = Number(j.live.lastEventAt) || null;
  const age = last ? Math.max(0, (now - last) / 1000) : null;
  const ago = fmtSeconds(age ?? (now - started) / 1000);
  if (j.live.stream === "off") {
    return {
      cls: "is-poll",
      text: "polled · every 15s",
      title: "this gateway does not advertise run_events_sse, so the card is polled every 15s instead of streamed - a quiet minute here is the poll, not a stuck model",
    };
  }
  if (!j.live.events) {
    return {
      cls: "is-nosignal",
      text: `no events yet · ${ago}`,
      title: `this run is live but the gateway has sent no event at all in ${ago} - that is the gateway not sending, not an agent thinking`,
    };
  }
  const tool = j.live.tool?.name;
  if (tool) {
    return {
      cls: "is-tool",
      text: `${tool} · ${ago}`,
      title: `${tool} is running - the last event from this run's stream was ${ago} ago. The pulse is the panel's heartbeat on that stream, not the agent's thoughts`,
    };
  }
  if (j.live.streaming && age !== null && age < PULSE_SILENT_SECONDS) {
    return {
      cls: "is-stream",
      text: `thinking ${ago}`,
      title: `text is streaming: the last delta arrived ${ago} ago. The pulse is the panel's heartbeat on the run's stream, not the agent's thoughts`,
    };
  }
  return {
    cls: "is-silent",
    text: `thinking ${ago}`,
    title: `nothing from this run's stream for ${ago} - the run is still live in the gateway and this panel still holds its stream. The pulse is a heartbeat, not the agent's thoughts`,
  };
}

function livePulseHtml(j) {
  const p = livePulse(j);
  if (!p) return "";
  return `<span class="live-pulse ${p.cls}" data-live-pulse="${esc(j.thread || j.id)}" title="${esc(p.title)}"><span class="pulse-dot" aria-hidden="true"></span><span class="pulse-text">${esc(p.text)}</span></span>`;
}

function jobPreviewHtml(j) {
  const word = jobStatusWord(j);
  const cls = jobStatusClass(j);
  const why = String(j.error || "").replace(/\s+/g, " ").trim();
  const dur = turnLive(j) || j.revived ? "" : elapsed(j);
  // A held turn has said nothing yet — there is no prose to preview — so the line carries what it is waiting
  // for instead of falling through to "starting…", which reads as a stall.
  const text = why || (isWaiting(j) ? waitNote(j) : jobPreview(j));
  return (
    `<span class="pv-status is-${esc(cls)}" title="${esc(`${word}${dur ? ` · ${dur}` : ""}${why ? ` · ${why}` : ""}`)}">${esc(word)}</span>` +
    (dur ? `<span class="pv-meta">${esc(dur)}</span>` : "") +
    `<span class="pv-text" title="${esc(text)}">${esc(text)}</span>`
  );
}

function refreshJobPreview(id) {
  const j = state.jobs.get(id);
  if (!j) return;
  const el = document.querySelector(`[data-preview="${CSS.escape(j.thread || j.id)}"]`);
  if (el) el.innerHTML = jobPreviewHtml(j);
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
    // By the clock, not by `turn`. That counter is `siblings.length + 1` over the jobs KEEP_JOBS still holds, so
    // trimming old turns moves it BACKWARDS: the turn that resumed an interrupted thread got 7 while the dead turn
    // it replaced was still 8, and the card drew "turn 7 · running" ABOVE "turn 8 · interrupted" — running on top
    // of interrupted, which is exactly what a reader reads as a contradiction (measured live on 7473). The clock
    // only moves forward, so it orders the list; the counter is the tiebreaker for one millisecond.
    turns.sort((a, b) => (Date.parse(a.startedAt || "") || 0) - (Date.parse(b.startedAt || "") || 0) || (a.turn || 0) - (b.turn || 0));
    out.push({ thread, turns, first: turns[0], latest: turns[turns.length - 1] });
  }
  out.sort((a, b) => String(b.latest.startedAt).localeCompare(String(a.latest.startedAt)));
  return out;
}

// The number a turn is drawn under (see `turnHead`): its place in the thread by the clock. The one-second clock tick
// rewrites a running head's text in place, so it has to agree with the render or the label jumps a second later.
function turnSeqOf(j) {
  const turns = [...state.jobs.values()].filter((x) => (x.thread || x.id) === (j.thread || j.id));
  turns.sort((a, b) => (Date.parse(a.startedAt || "") || 0) - (Date.parse(b.startedAt || "") || 0) || (a.turn || 0) - (b.turn || 0));
  const i = turns.findIndex((x) => x.id === j.id);
  return i < 0 ? j.turn || "?" : i + 1;
}

// A tool that runs for minutes is the one thing that makes a healthy turn look frozen — a 159 s
// recursive grep did exactly that, and the card showed nothing but the line that started it. Every
// line carries the server's timestamp, so the tool still in flight can grow a live clock.
// Lines lead with the tool's glyph (📖 read_file · path); history written before glyphs leads with ▸,
// so the arrow is optional and the glyph run is skipped before the name is taken.
const TOOL_START_RE = /^(?:▸\s*)?(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?([^\s·]+)/u;
const TOOL_DONE_RE = /^\s*↳\s*([^\s·]+)/;
// The argument a call line carries ("📖 read_file · docs/map.md"): what the tool was given. The console's own
// rows use it, and a file's code box names the file from it.
const toolCallArg = (text) => {
  const s = String(text || "");
  const sep = s.indexOf(" · ");
  return sep >= 0 ? s.slice(sep + 3) : "";
};

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

// The name of the call that has started and not come back - the reason a steer can sit undelivered for minutes.
function inflightToolName(lines) {
  const i = inflightToolIndex(lines);
  if (i < 0) return null;
  const m = TOOL_START_RE.exec(String(lines[i].text || ""));
  return m ? m[1] : null;
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

// A run of tool calls with nothing said in between is one burst. The console draws it as one row per tool with a
// tally and the input of the last call - what the agent is doing, not every instance of it - while the full lines
// stay one click away. Text ends the burst: the next tool call starts a fresh tally at that point in the transcript.
// One console line. data-ltext/data-lkind carry the line itself rather than what it renders to, because a
// burst rebuild reads the lines back out of the DOM (groupLines): a link, a running clock or a diff window's
// markup must not change what the next render believes the line said.
function lineHtml(l, live = "", cls = "") {
  const kind = l.kind || "raw";
  // A line the stream is still revealing is drawn up to what may be shown NOW, not up to the wire's whole text:
  // a repaint mid-paragraph (a scan, a pinned copy, the 3s result sweep) must not jump the console ahead of the
  // words the reader is watching arrive. Every other line — history, a tool line, reasoning — is drawn whole.
  const shown = typedShown(l);
  const text = shown == null ? l.text : shown;
  return `<div class="jl jl-${esc(kind)}${cls ? ` ${cls}` : ""}" data-lid="${esc(l.lid ?? "")}" data-ltext="${esc(l.text ?? "")}" data-lkind="${esc(kind)}">${linkifyText(text)}${live}</div>`;
}

function burstGroups(lines) {
  const out = [];
  let burst = null;
  for (const l of lines) {
    if (l.kind === "tool" || l.kind === "tool-out") {
      if (!burst) {
        burst = { group: true, lines: [] };
        out.push(burst);
      }
      burst.lines.push(l);
    } else {
      burst = null;
      out.push({ group: false, line: l });
    }
  }
  return out;
}

// One row per tool name: how many times, the input of the most recent call, and whether it is still running.
function toolBurstRows(lines) {
  const rows = new Map();
  for (const l of lines) {
    const text = String(l.text || "");
    if (l.kind === "tool") {
      const m = TOOL_START_RE.exec(text);
      if (!m) continue;
      const name = m[1];
      const sep = text.indexOf(" · ");
      const g = /^(\p{Extended_Pictographic}[\uFE0F\u200D]*)\s*/u.exec(text);
      const row = rows.get(name) || { name, glyph: (g && g[1]) || "⚡", count: 0, done: 0, last: "", at: null, duration: null };
      row.count += 1;
      row.last = sep >= 0 ? text.slice(sep + 3) : "";
      row.at = Number(l.at) || Date.now();
      rows.set(name, row);
    } else if (l.kind === "tool-out") {
      const m = TOOL_DONE_RE.exec(text);
      if (!m) continue;
      const row = rows.get(m[1]);
      if (!row) continue;
      row.done += 1;
      const d = /·\s*([\d.]+)s/.exec(text);
      if (d) row.duration = Number(d[1]);
    }
  }
  return [...rows.values()];
}

// A call plus the output it produced, so one tool's rows can be opened on their own. A result block starts at the
// "↳ name" line and runs until the next call or result; the plain lines belong to the result above them.
function burstSegments(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    const text = String(l.text || "");
    if (l.kind === "tool") {
      const m = TOOL_START_RE.exec(text);
      cur = { tool: m ? m[1] : "", lines: [l] };
      out.push(cur);
    } else if (l.kind === "tool-out") {
      const m = TOOL_DONE_RE.exec(text);
      if (m) {
        cur = { tool: m[1], lines: [l] };
        out.push(cur);
      } else if (cur) {
        cur.lines.push(l);
      } else {
        cur = { tool: "", lines: [l] };
        out.push(cur);
      }
    }
  }
  return out;
}

// Every line of a group, from the live model when we have it and from the DOM when the group came from a full render.
function groupLines(grp) {
  if (grp._burst) return grp._burst;
  // Read the console lines back out of the DOM - but not the panel's own additions to a block: stored output, the
  // notes under it and an opened batch are all drawn UNDER a line, so counting them inflates the line tally and
  // turns them into console lines of their own on the next rebuild (an opened batch was re-absorbed as five
  // summaries that then satisfied "the preview carried this result").
  const read = (d) => {
    // The line's own text, not the rendered text: a diff window draws one row per change and a code box
    // holds its lines folded, and neither may cost the rebuild a line or invent one (the carried file label
    // is not a .jl for exactly that reason).
    const line = {
      kind: d.dataset.lkind || (d.className.match(/jl-([a-z-]+)/) || [])[1] || "raw",
      text: d.dataset.ltext != null ? d.dataset.ltext : d.textContent,
      // …and the id the row was drawn with, because it is what the next update looks the row up by: the live
      // append replaces a growing line's text through `[data-lid]`, and `paintTypedLines` finishes a half-typed one
      // the same way. A rebuild that read this back without it handed every row it redrew an empty id, so the
      // identity did not survive the group being re-cut.
      lid: d.dataset.lid || undefined,
    };
    // …and which result a fold note names travels with it too: the sentence cannot say it (that is what the
    // stamp on the line is for), and a rebuild that lost it would put the reader back in front of "click to
    // read" with nothing to click. Read from the button the note was already drawn as.
    const btn = d.querySelector ? d.querySelector("[data-tool-fold]") : null;
    if (btn) line.fold = { tool: btn.dataset.foldTool || "", row: Math.max(0, Number(btn.dataset.foldRow) || 0) };
    return line;
  };
  const out = [];
  const sources = new Map();
  for (const d of grp.querySelectorAll(".tgrp-body .jl, .tgrp-body .code-box[data-code-source]")) {
    const box = d.closest(".code-box[data-code-source]");
    if (box) {
      if (!sources.has(box)) {
        let lines = null;
        try { lines = JSON.parse(box.dataset.codeSource); } catch { /* a damaged attribute falls back to the DOM */ }
        sources.set(box, Array.isArray(lines) ? lines : null);
      }
      const lines = sources.get(box);
      if (lines) {
        if (d === box) out.push(...lines);
        continue;
      }
      if (d === box) continue;
    }
    if (d.classList.contains("jl-store") || d.classList.contains("jl-note") || d.classList.contains("jl-panel")) continue;
    // A stream row is the record of BOTH the call and the result that answered it: neither is drawn as a line of
    // its own (the row says the tool, the target and the time), so both halves travel on the row — data-ltext for
    // the call, data-lresult for the result header the console used to draw under it. Read them back as the two
    // lines they are: without the header a rebuild loses the call's time, and `storeOffsetsBefore` (which counts
    // result headers) hands the NEXT burst the wrong starting row for its stored output.
    if (d.dataset && d.dataset.lresult) {
      out.push(read(d), {
        kind: "tool-out",
        text: d.dataset.lresult,
        at: Number(d.dataset.lrat) || undefined,
        lid: d.dataset.lrld || undefined,
      });
      continue;
    }
    // A modification is drawn with its AFTER line first (the reader asked for the new side on the left), which is
    // the opposite of the order the diff had it in. A rebuild re-derives the diff from these lines, and a pair
    // read back the other way round re-classifies as a lone addition plus a lone removal - every modification
    // redrawn as two rows. So a row carrying data-lpair is read back in the diff's own order.
    const row = d.parentElement;
    const cells = row && row.dataset && row.dataset.lpair === "1" ? [...row.children] : null;
    if (cells && cells.length === 2) {
      if (d === cells[0]) continue; // read with its partner, below
      out.push(read(cells[1]), read(cells[0]));
      continue;
    }
    out.push(read(d));
  }
  return out;
}

// How many result lines of each tool the bursts already in this console have drawn. That count is where the NEXT
// burst's pairing starts (see data-gofs): a turn holds several bursts of the same tool, and each one owns its own
// slice of the store's rows.
function storeOffsetsBefore(consoleEl, except) {
  const seen = {};
  for (const g of consoleEl.querySelectorAll(".tgrp")) {
    if (g === except) continue;
    for (const l of groupLines(g)) {
      if (l.kind !== "tool-out") continue;
      const m = TOOL_DONE_RE.exec(String(l.text || ""));
      if (m) seen[m[1]] = (seen[m[1]] || 0) + 1;
    }
  }
  return seen;
}

// How many result blocks the console drew for one tool: each one is a call's output, and the session store has
// one row for each of them, so this is also how many rows to ask for.
function resultBlocksFor(lines, tool) {
  return (lines || []).filter((l) => {
    if (l.kind !== "tool-out") return false;
    const m = TOOL_DONE_RE.exec(String(l.text || ""));
    return Boolean(m) && m[1] === tool;
  }).length;
}

// Rebuild the group the reader has open, wherever it is on the board: the element that asked for the results may
// have been replaced by a repaint while the request was in flight, so aim by the group's stable state key.
function repaintToolGroup(grp) {
  if (!grp || !grp.dataset) return;
  // One turn can be drawn twice (the pinned card and its paged copy), so the lookup stays inside the console that
  // owns this group. The state key is the stable identity and wins; the group key is only a fallback, because the
  // index in it shifts when a long turn is trimmed to its last 300 lines.
  const scope = grp.closest("pre.job-out") || document;
  const gkey = grp.dataset.gstate || "";
  const key = grp.dataset.tgrp || "";
  const live =
    (gkey && scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gkey)}"]`)) ||
    (key && scope.querySelector(`.tgrp[data-tgrp="${CSS.escape(key)}"]`));
  if (!live) return;
  const bodyEl = live.querySelector(".tgrp-body");
  rebuildToolGroup(live, { filter: live.dataset.filter || "", open: bodyEl ? !bodyEl.hidden : true });
}

// Ask the panel server for this turn's stored results for one tool. The live stream's preview is often empty,
// so this is where "↳ patch" turns into the thing the tool actually returned.
//
// A turn that is still running keeps producing results: a fetch taken when the reader opened the block saw one
// patch while the burst ended with five, and every later call kept an empty header - so an entry cached while the
// turn is live expires (five seconds) instead of answering for the rest of the turn. An entry taken while live is
// also refetched ONCE after the turn ends: the last results of a turn land within a second of its endedAt, and
// freezing the mid-run answer is how a finished turn shows three "no output recorded" where the output exists.
async function ensureToolStore(turnId, tool, grp = null) {
  const cacheKey = `${turnId}|${tool}`;
  if (!turnId || !tool || !state.jobs.has(turnId)) return;
  if (state.toolStorePending.has(cacheKey)) return;
  const job = state.jobs.get(turnId);
  const live = turnLive(job);
  const have = state.toolStore.get(cacheKey);
  if (have && !(have.live && !live) && (!live || Date.now() - have.at < 5000)) return;
  // One row per result line the WHOLE TURN drew for this tool, because the entry is shared by every burst in the
  // turn: sizing it to the group that happened to fetch first cut the later bursts off at that group's count, and
  // the missing rows read as "no output recorded". A fold note names its result by that result's index over the
  // whole turn, so the read covers up to the furthest row this turn's own notes name as well — the head above
  // such a note is only checkable against its own row if the row is in hand.
  const turnLines = state.jobLines.get(turnId) || [];
  const stamped = stampedRowFor(turnLines, tool);
  const n = Math.min(60, Math.max(4, resultBlocksFor(turnLines, tool) + 1, stamped == null ? 0 : stamped + 1));
  let changed = false;
  state.toolStorePending.add(cacheKey);
  try {
    const q = new URLSearchParams({
      thread: job.thread || job.id,
      tool,
      n: String(n),
      from: String(Date.parse(job.startedAt || "") || 0),
      to: String(Date.parse(job.endedAt || "") || 0),
    });
    const r = await apiFetch(`/api/tool-results?${q}`, {}, { timeoutMs: 15000 });
    // apiFetch does not throw on a 4xx/5xx: a refusal parsed as `{results: []}` would be cached as "the store has
    // nothing", and every call in the block would say so for good.
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const results = Array.isArray(d.results) ? d.results : [];
    changed = JSON.stringify(results) !== JSON.stringify(have ? have.results : null);
    state.toolStore.set(cacheKey, { at: Date.now(), live, results });
    // One entry per (turn, tool) the reader ever opened; a long-lived tab must not keep them all.
    while (state.toolStore.size > 300) state.toolStore.delete(state.toolStore.keys().next().value);
  } catch {
    // Left uncached on purpose: a failed read is not an answer, and the next open retries it.
  } finally {
    state.toolStorePending.delete(cacheKey);
  }
  // Only a real change is worth a repaint: rebuilding the block detaches its text nodes, and a reader dragging
  // across a diff loses the selection when it happens on every sweep.
  if (changed) repaintToolGroup(grp);
}

// The panel's fold, opened: the whole stored text of one result, drawn in place of the note that offered it.
//
// This is the DOM being handed the rest of a result, never the job's own lines: the console's ring buffer
// (jobs.js MAX_LINES = 600) is what a big result would evict, and a result the reader asked to see is not
// something the card has to keep — it is one click away again after any repaint.
//
// The box it is drawn in is OPEN: the reader pressed "click to read" on the note, so a second press to unfold what
// they just asked for would read as the panel ignoring them. That is the one box that is open by default, which is
// why it keeps the boxes the reader SHUT (state.codeBoxShut) where every other box keeps the ones they opened.
const READ_CODE_OPEN = { openByDefault: true, has: (key) => !state.codeBoxShut.has(key) };
function wholeStoredHtml(got, tool = "", arg = "", boxKey = "", codeOpen = READ_CODE_OPEN) {
  const LF = String.fromCharCode(10);
  const all = String((got && got.text) || "").split(LF);
  if (!all.some((l) => l.trim())) return `<div class="jl jl-dim jl-note">  the stored result has no text</div>`;
  return (
    consoleBodyHtml(all.map((l) => ({ kind: "store", text: l })), { tool, arg, codeOpen, codeKey: boxKey, whole: true }) +
    (got.truncated ? `<div class="jl jl-dim jl-note">… this stored result was cut as well</div>` : "")
  );
}

// Which result a fold belongs to, and how many of them the opened tab may hold. The row is the pairing the burst
// already uses (the i-th result line of this tool in this turn is the store's i-th row for it), so the number the
// note was drawn with is the number the fetch asks for.
const foldKey = (turnId, tool, row) => `${turnId}|${tool}|${row}`;
const fullForFold = (fold) => state.foldRows.get(foldKey(fold.turn, fold.tool, fold.row));
const FOLD_ROWS_MAX = 12;

// Which row of the store a fold note names. The stronger of two facts wins, and the per-burst cursor is only
// the last resort.
//
// The store indexes a tool's results over the WHOLE TURN (lib/tool-results.js: one row at `OFFSET row`, ordered
// by the turn's clock window), while the console's own lines are a trimmed window of that turn — 600 lines in
// memory, the last 120 served — so a position inside the console is NOT that number. Measured: the clickable
// note in burst `9658fe9e#2` named `row=0` while the store's row 0 for `terminal` is the turn's opening recon
// command (799 chars, 14 lines), a different result entirely, so the click read back the wrong text.
//
//   * the head the panel kept. The console lines drawn above a note ARE the first lines of the stored row: one
//     fold, one `unwrapToolText` (lib/jobs/console-lines.js pushes the head, lib/tool-results.js reads the store
//     back through the same unwrapping), 40 lines on both sides. So once the burst has read its tool's rows, the
//     note names the row those lines came from — and that row can be checked against its own text.
//   * the row the server stamped on the note (`line.fold`): this result's index among the turn's results for
//     that tool, counted at the event (lib/jobs.js `withResultRow`). The only handle a burst the window trimmed
//     of its call line has, and right whenever the panel saw every result of the turn.
const HEAD_LINES = 40; // MAX_TOOL_LINES in lib/jobs/console-lines.js: the head the panel keeps of a result
const LF = String.fromCharCode(10);
// A line as it compares: no trailing newline, no trailing blanks. The panel trims trailing whitespace on the
// console side of nothing, but a diff's context lines and a store row's may differ by exactly that.
const foldLineText = (l) => String((l && l.text) != null ? l.text : l || "").replace(/\s+$/, "");
const storeRowsFor = (turnId, tool) => state.toolStore.get(`${turnId}|${tool}`)?.results || null;

// The store row a head of console lines came from: the row whose text carries those lines, in order, inside the
// head the panel kept (the row's first 40 lines). `prefer` is the row the note's own stamp named — checked
// first, so a note whose stamp is right keeps naming exactly that row (two results whose heads read the same,
// the same command run twice, are told apart by it), and one whose stamp drifted is repaired to the row the
// lines really came from.
function rowForHead(rows, head, prefer = null) {
  const H = (Array.isArray(head) ? head : []).map(foldLineText).filter((t) => t.trim());
  if (!H.length || !Array.isArray(rows) || !rows.length) return null;
  const hits = [];
  for (let i = 0; i < rows.length; i++) {
    const R = foldLineText(rows[i]).split(LF);
    for (let j = 0; j + H.length <= R.length && j <= HEAD_LINES; j++) {
      if (H.every((h, k) => R[j + k].startsWith(h))) {
        hits.push({ i, j });
        break;
      }
    }
  }
  if (!hits.length) return null;
  const wanted = hits.find((h) => h.i === prefer);
  if (wanted) return wanted.i;
  // A head that starts the row is the stronger reading than one that ends in the middle of it (which is what a
  // trimmed window leaves behind), so a j = 0 match wins over a later row's suffix match.
  const best = hits.reduce((a, b) => (b.j < a.j ? b : a));
  return best.i;
}

// The fold context a note is drawn with: the turn, the tool it belongs to, and the row of the store it names.
// `tool` is what the caller knows from the burst (a result header named it); the note's own stamp wins when the
// window trimmed that away. `cursor` is the burst's pairing, for a line written before the stamp existed.
function foldForNote({ turnId, tool = "", note = null, head = [], cursor = null }) {
  const stamped = note && note.fold ? note.fold : null;
  const which = String((stamped && stamped.tool) || tool || "");
  // No tool anywhere: a note written before the stamp existed, in a burst the window trimmed of its call line.
  // The head over it still does not answer for one tool only, so ask whichever of THIS turn's tool reads is in
  // hand which row those lines came from — the answer names the tool as well as the row.
  if (!which) return foldByHeadAnyTool(turnId, head);
  const prefer = stamped && stamped.row != null ? Math.max(0, Number(stamped.row) || 0) : null;
  const byHead = rowForHead(storeRowsFor(turnId, which), head, prefer);
  const row = byHead != null ? byHead : prefer != null ? prefer : cursor;
  if (row == null) return null;
  return { turn: turnId, tool: which, row: Math.max(0, Number(row) || 0) };
}

// Which of this turn's tools a head of console lines came from, across the store reads the card has in hand
// (the same reads every burst of the turn shares). Only ever consulted for a note that can name no tool of its
// own; the first read whose rows carry the head is the answer.
function foldByHeadAnyTool(turnId, head) {
  const prefix = `${turnId}|`;
  for (const [key, entry] of state.toolStore) {
    if (!key.startsWith(prefix) || !entry || !Array.isArray(entry.results) || !entry.results.length) continue;
    const row = rowForHead(entry.results, head, null);
    if (row != null) return { turn: turnId, tool: key.slice(prefix.length), row: Math.max(0, Number(row) || 0) };
  }
  return null;
}

// Every note's fold context in a list of console lines, keyed by the note line itself. Where the lines are drawn
// in one go (a burst the window trimmed of its call line, so no segment names its own tool), each note is still
// resolved from its stamp and the head above it — bounded to the head's own length, because a note ends the head
// the panel kept.
function noteFolds(turnId, lines) {
  const folds = new Map();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.kind !== "tool-out" || !consoleFoldNote(String(l.text || ""))) continue;
    const fold = foldForNote({ turnId, note: l, head: lines.slice(Math.max(0, i - HEAD_LINES), i) });
    if (fold) folds.set(l, fold);
  }
  return folds;
}

// The tools a burst's store read has to cover: the ones its call lines name, plus any a fold note inside it
// names. A burst the window trimmed of its call line has no rows to count, and the note is the only thing left
// that says which result it folds.
function burstStoreTools(lines) {
  const out = new Set(toolBurstRows(lines).map((r) => r.name));
  for (const l of lines) if (l && l.fold && l.fold.tool) out.add(String(l.fold.tool));
  return [...out].filter(Boolean);
}

// The furthest row this turn's own notes name for one tool: the store read that pairs a burst asks for the rows
// its result lines need, and one more result than that when a note names a later one (the head above the note
// has to be checkable against the row it claims).
function stampedRowFor(lines, tool) {
  let out = null;
  for (const l of lines || []) {
    if (!l || !l.fold || String(l.fold.tool || "") !== tool || l.fold.row == null) continue;
    const row = Math.max(0, Number(l.fold.row) || 0);
    if (out == null || row > out) out = row;
  }
  return out;
}

// The reader clicked the fold: read that one row out of the session store — whole, not the store reader's own
// 6,000-character display cut — and let the card redraw the burst with it. The request carries the turn's own
// window, exactly like the store fetch a burst makes, because the store is queried by time
// (lib/tool-results.js) and the turn's clock is the only thing that says which rows are its.
async function expandToolFold(btn) {
  const grp = btn.closest(".tgrp");
  // The button carries the turn it was drawn for (data-fold-turn). The burst's own key is the same number, but a
  // burst the window trimmed of its call line is drawn as bare console lines — no `.tgrp` to read it from — and
  // the note there is still a control the reader can press.
  const turnId = String(btn.dataset.foldTurn || (grp && grp.dataset.tgrp) || "").split("#")[0];
  const tool = btn.dataset.foldTool || "";
  const row = Math.max(0, Number(btn.dataset.foldRow) || 0);
  if (!turnId || !tool) return false;
  const job = state.jobs.get(turnId);
  if (!job) return true;
  const key = foldKey(turnId, tool, row);
  // The press is the reader asking for this result, so the console holds still while it arrives (Settings > Agent
  // cards, off by default): the answer lands under the note that was pressed, not at the bottom of the console.
  holdConsoleFor(btn);
  const rememberOpen = () => {
    state.codeBoxOpen.add(btn.dataset.codeKey || `result|${turnId}|${tool}|${row}`);
    while (state.codeBoxOpen.size > 500) state.codeBoxOpen.delete(state.codeBoxOpen.values().next().value);
  };
  if (state.foldRows.has(key)) {
    rememberOpen();
    if (grp) repaintToolGroup(grp);
    return true;
  }
  const q = new URLSearchParams({
    thread: job.thread || job.id,
    tool,
    row: String(row),
    full: "1",
    n: "1",
    from: String(Date.parse(job.startedAt || "") || 0),
    to: String(Date.parse(job.endedAt || "") || 0),
  });
  const hint = btn.querySelector(".code-hint");
  const say = (text) => { if (hint) hint.textContent = text; else btn.textContent = text; };
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  say("reading the stored result…");
  let pending = null;
  try {
    pending = state.foldPending.get(key);
    if (!pending) {
      pending = (async () => {
        const r = await apiFetch(`/api/tool-results?${q}`, {}, { timeoutMs: 15000 });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        return Array.isArray(d.results) ? d.results[0] : null;
      })();
      state.foldPending.set(key, pending);
    }
    const got = await pending;
    if (!got || !String(got.text || "").trim()) {
      // A missing or empty copy is not a full result. Keep the preview, and leave the header retryable.
      say(got ? "the stored result has no text — click to retry" : "the session store has no copy of this result — click to retry");
      return true;
    }
    state.foldRows.set(key, got);
    rememberOpen();
    // Retire closed cached results first. Evicting one the reader still has open would shrink it on a repaint.
    for (const held of state.foldRows.keys()) {
      if (state.foldRows.size <= FOLD_ROWS_MAX) break;
      if (!state.codeBoxOpen.has(`result|${held}`)) state.foldRows.delete(held);
    }
    if (grp) repaintToolGroup(grp);
    else {
      // No burst wrapper to repaint: a burst the window trimmed of its call lines is drawn as bare console lines.
      // The whole stored row goes in the note's own place — the same markup the next full repaint draws there
      // (trimmedBurstHtml), so the answer is on the card now rather than at the next paint.
      const rowEl = btn.closest(".jl-fold");
      const holder = document.createElement("div");
      holder.innerHTML = wholeStoredHtml(got, tool, "", `${turnId}|${tool}`);
      if (rowEl && rowEl.parentElement && holder.firstChild) rowEl.replaceWith(...holder.childNodes);
    }
  } catch {
    say("the session store could not be read; click to retry");
  } finally {
    if (state.foldPending.get(key) === pending) state.foldPending.delete(key);
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
  return true;
}

// A block the reader has open keeps its stored output current while its turn runs, and settles once when the turn
// ends. Only open blocks are asked for, and ensureToolStore's own throttle bounds the requests.
setInterval(() => {
  for (const grp of document.querySelectorAll(".tgrp")) {
    const bodyEl = grp.querySelector(".tgrp-body");
    if (!bodyEl || bodyEl.hidden) continue;
    const turnId = String(grp.dataset.tgrp || "").split("#")[0];
    if (!state.jobs.has(turnId)) continue;
    const lines = groupLines(grp);
    const tools = grp.dataset.filter ? [grp.dataset.filter] : burstStoreTools(lines);
    for (const tool of tools) void ensureToolStore(turnId, tool, grp);
  }
}, 3000);

// The calls behind a "+ N commands" batch: the run stream only carries the gateway's summary of a parallel batch, so
// this asks the panel server to read the session transcript and then re-renders the burst open with them in it.
async function loadBatchCalls(btn) {
  const grp = btn.closest(".tgrp");
  if (!grp) return;
  // The batch is about to be drawn open under this button, so the console holds its place rather than sliding down
  // to the end of the list that arrives (Settings > Agent cards, off by default).
  holdConsoleFor(btn);
  const gkey = btn.dataset.batchKey || grp.dataset.gstate || "";
  const tool = btn.dataset.batchTool || "";
  const want = Number(btn.dataset.batchN) || 4;
  const key = grp.dataset.tgrp || "";
  const turnId = String(key).split("#")[0];
  // The card's thread, so the server can find the session whose transcript holds the batch - and the turn's own
  // start, so it reads THAT turn's batch rather than the newest one in the session.
  const job = state.jobs.get(turnId);
  const thread = job?.thread || turnId;
  const since = job?.startedAt ? Date.parse(job.startedAt) || 0 : 0;
  btn.disabled = true;
  btn.textContent = "reading the transcript…";
  let calls = [];
  try {
    // The summary prints the calls it did NOT show, so the batch ran want+1 of them: that count is what picks the
    // right message out of the transcript.
    const first = btn.dataset.batchFirst || "";
    const q = new URLSearchParams({ thread, tool, n: String(Math.max(2, want + 1)), want: String(want + 1), since: String(since), first });
    const r = await apiFetch(`/api/tool-calls?${q}`, {}, { timeoutMs: 15000 });
    const d = await r.json().catch(() => ({}));
    calls = Array.isArray(d.calls) ? d.calls : [];
    if (!r.ok && d.error) throw new Error(d.error);
  } catch (e) {
    showBanner(`could not read the batch: ${e.message}`);
  }
  if (calls.length) {
    state.batchCalls.set(`${gkey}|${tool}`, calls);
    // One entry per burst the reader opened; a long-lived tab should not keep every one of them forever.
    while (state.batchCalls.size > 300) state.batchCalls.delete(state.batchCalls.keys().next().value);
  } else {
    showBanner(`the session transcript has no record of this ${tool} batch yet`);
  }
  const live = document.querySelector(`.tgrp[data-gstate="${CSS.escape(gkey)}"]`) || grp;
  if (live?.isConnected) rebuildToolGroup(live, { filter: live.dataset.filter || "", open: true });
}

function rebuildToolGroup(grp, { filter = "", open = false } = {}) {
  const key = grp.dataset.tgrp || "";
  const lines = groupLines(grp);
  // The anchor is the burst's own identity and travels on the node: lines read back out of the DOM carry no
  // timestamp, so without it a rebuild re-keyed the group from the first line's text and the reader's open
  // state was remembered under one key while the next repaint looked it up under another.
  const anchor = grp.dataset.gat || "";
  let gofs = null;
  try {
    gofs = grp.dataset.gofs ? JSON.parse(grp.dataset.gofs) : null;
  } catch {
    gofs = null;
  }
  const gkey = grp.dataset.gstate || toolGroupStateKey(key, lines, anchor);
  // The click is the new truth, so record it before rendering: toolGroupHtml prefers the remembered state, and
  // otherwise it would faithfully put back the state the reader just changed.
  if (toolGroupDropsState(open, filter, grp.dataset.gdefault === "open")) state.toolGroupOpen.delete(gkey);
  else state.toolGroupOpen.set(gkey, { open, filter });
  const holder = document.createElement("div");
  // A piece of a stream stays a piece of a stream: rebuilding it condensed (a store read landing, a batch opened,
  // the rollup refreshed) would put the folded group back under a card whose whole point is that nothing is folded.
  // The blank line it was drawn with is part of the piece too, so the rebuild keeps it rather than losing it until
  // the next full repaint.
  holder.innerHTML = toolGroupHtml(lines, key, filter, open, anchor, gofs, grp.dataset.gflat === "1" ? { flat: true, sep: grp.classList.contains("jl-sep") } : {});
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  fresh._burst = lines;
  grp.replaceWith(fresh);
  rememberToolGroup(fresh);
}

// ---- tool group key: what a burst is remembered BY, and the window that keeps that identity in view
// A burst's identity, for remembering whether the reader opened it. The group's DOM key changes when the console
// is rebuilt from the buffer (it is the group's index) and when the stream starts a new burst (it is a timestamp),
// so the state is keyed by the turn plus the first line the burst holds - which is the same line in all three.
//
// It has to be the burst's first CALL. A result line above it belongs to a call the console no longer holds, and it
// slides out of the window as the turn grows, so an anchor derived from it re-keys the group under the reader: the
// open group came back `hidden` on the next repaint (state.toolGroupOpen answered for a key nothing looks up now).
function toolGroupAnchor(lines) {
  const run = Array.isArray(lines) ? lines : [];
  const first = run.find((l) => l && l.kind === "tool") || run[0] || null;
  return first ? String(first.lid || first.at || first.text || "").slice(0, 40) : "";
}

// The console draws a window of the turn, not the whole of it. A raw line count cut bursts in half: the call line
// fell out of the window while the output it produced stayed, and a burst with no call line has no rows to tally -
// it stopped being a group at all (toolGroupHtml's trimmed path). So the window is cut on the burst's own boundary:
// if it would start inside a burst's results, it starts at the call line above them instead.
//
// A burst that fits in a second window is kept whole, so there is no hole between a call and what it produced. One
// that does not (a terminal call with hundreds of lines of output) keeps its call line and the ordinary window: a
// group with a call row and a gap, which is the window being a window - never a group that stops existing.
const TURN_WINDOW = 300;

function windowLines(all, keep = TURN_WINDOW) {
  const lines = Array.isArray(all) ? all : [];
  const max = Math.max(1, Number(keep) || TURN_WINDOW);
  if (lines.length <= max) return lines;
  const tail = lines.length - max;
  // A run of `tool`/`tool-out` lines is one burst (burstGroups). Walking back over the results the window opened
  // inside lands on the call that produced them; landing on anything else means the burst's own call line is already
  // out of the buffer, and the trimmed render draws what is left.
  let start = tail;
  while (start > 0 && lines[start].kind === "tool-out") start -= 1;
  // `start` equal to `tail` is a window that already begins at a burst's own call (or at a line that is not a burst's
  // at all): nothing was cut in half, so nothing has to be put back.
  if (start === tail || lines[start].kind !== "tool") return lines.slice(tail);
  return lines.length - start <= max * 2 ? lines.slice(start) : [lines[start], ...lines.slice(tail)];
}

// `anchor` is the identity the node already carries (data-gat), which wins over re-deriving it from lines that were
// read back out of the DOM and have lost their timestamp.
function toolGroupStateKey(key, lines, anchor = "") {
  return `${String(key || "").split("#")[0]}|${anchor || toolGroupAnchor(lines)}`;
}

// Is a rendered group's state worth remembering? A closed, unfiltered group is the condensed view's default and
// leaves nothing to remember - except where the group's OWN default is open (a burst the window trimmed of its call
// line is drawn open), because there the reader shutting it is a choice, and a repaint must not undo it.
function toolGroupDropsState(open, filter, openByDefault = false) {
  return !open && !filter && !openByDefault;
}

// Record the reader's choice from a rendered group, so the next rebuild can put it back.
function rememberToolGroup(grp) {
  if (!grp || !grp.dataset) return;
  const gkey = grp.dataset.gstate;
  if (!gkey) return;
  const body = grp.querySelector(".tgrp-body");
  const filter = grp.dataset.filter || "";
  const open = Boolean(body && !body.hidden);
  if (toolGroupDropsState(open, filter, grp.dataset.gdefault === "open")) {
    state.toolGroupOpen.delete(gkey);
    return;
  }
  state.toolGroupOpen.set(gkey, { open, filter });
  // A long-lived tab would otherwise accumulate one entry per burst it ever opened.
  while (state.toolGroupOpen.size > 500) state.toolGroupOpen.delete(state.toolGroupOpen.keys().next().value);
}
// ---- end tool group key

// The gateway folds a parallel batch into one line - "first command + 3 commands" - because the run stream carries a
// summary of the batch, not each call. The other calls are in the session transcript, so the tail becomes a button
// that reads them back; what it finds is remembered per burst, so a repaint keeps them on screen.
const BATCH_TAIL_RE = /^(.*?)\s*\+\s*(\d+)\s+commands?\s*$/i;

function linkBatchTail(text, tool, gkey) {
  const m = BATCH_TAIL_RE.exec(String(text || ""));
  const n = m ? Number(m[2]) || 0 : 0;
  if (!n) return esc(text);
  const title = `one summary line stands in for ${n + 1} calls run as a batch — click to list all ${n + 1} from the session transcript`;
  // The printed call text travels with the button: it is how the transcript lookup finds THIS batch rather than a
  // newer one in the same turn.
  const first = m[1].trim().slice(0, 110);
  return `${esc(m[1])} <button type="button" class="tgrp-batch" data-batch-tool="${esc(tool)}" data-batch-n="${n}" data-batch-key="${esc(gkey)}" data-batch-first="${esc(first)}" title="${esc(title)}">+ ${n} command${n === 1 ? "" : "s"}</button>`;
}

// A trimmed burst still resolves each result from its own stamped identity or its retained head. The shared
// renderer turns that result's wire note into the box header's fetch metadata and replaces its preview in place.
function trimmedBurstHtml(lines, turnId, gkey, codeOpen = state.codeBoxOpen) {
  return consoleBodyHtml(lines, {
    tool: "", arg: "", codeOpen, codeKey: String(gkey), folds: noteFolds(turnId, lines), fullForFold,
  });
}

// ---- trimmed group head: a burst that lost its call line is still a group
// A burst whose call line the window (or the buffer behind it) no longer holds has no rows to tally, but the lines it
// does hold are still one block of the reader's console. Drawn bare they had no head row, nothing to click, and
// nowhere for the open state to land: a repaint could neither keep them open nor remember them shut, and the 3s sweep
// that refreshes a block's stored output could not find them at all. The head row says what the block is - the call
// above these results is outside the window - and the node carries the same data-gstate/data-gat as any other group.
// `sep` is the stream's own blank line (`jl-sep`): a trimmed piece is a piece like any other, so it is set apart from
// the piece above it the same way.
function trimmedGroupHtml(lines, key, anchor = "", flat = false, codeOpen = state.codeBoxOpen, sep = false) {
  const gkey = toolGroupStateKey(key, lines, anchor);
  const body = trimmedBurstHtml(lines, String(key).split("#")[0], key, codeOpen);
  // A piece of a stream has no fold at all: it is open, and the reader's open state is not consulted for it.
  if (flat) {
    return (
      `<div class="tgrp tgrp-flat${sep ? " jl-sep" : ""}" data-tgrp="${esc(key)}" data-gstate="${esc(gkey)}" data-gat="${esc(anchor || toolGroupAnchor(lines))}" data-gflat="1">` +
      `<div class="tgrp-body">${body}</div></div>`
    );
  }
  // Drawn OPEN: the reader came for this output, and what the window dropped is the call, not the result. Shutting it
  // is therefore a real choice, and data-gdefault is what makes rememberToolGroup keep that choice.
  const saved = state.toolGroupOpen.get(gkey);
  const open = saved ? Boolean(saved.open) : true;
  const names = [
    ...new Set(
      lines
        .map((l) => {
          const m = l && l.kind === "tool-out" ? TOOL_DONE_RE.exec(String(l.text || "")) : null;
          return m ? m[1] : "";
        })
        .filter(Boolean),
    ),
  ];
  const label = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  const title = "the call line above these results is outside the console's window — this block is the output the card still holds";
  return `<div class="tgrp" data-copy data-tgrp="${esc(key)}" data-gstate="${esc(gkey)}" data-gat="${esc(anchor || toolGroupAnchor(lines))}" data-gdefault="open">
      <div class="tgrp-head" data-copy-text><div class="tgrp-row tgrp-row-trimmed" title="${esc(title)}"><span class="tgrp-g">\u21b3</span><span class="tgrp-name">${esc(names.join(", ") || "tool output")}</span><span class="tgrp-n">trimmed</span></div><button type="button" class="tgrp-more${open ? " is-open" : ""}" data-tgrp-more="${esc(key)}" title="${open ? "fold these result lines away" : "show every result line this card still holds"}">${label}</button></div>
      <div class="tgrp-body"${open ? "" : " hidden"}>${body}</div>
    </div>`;
}
// ---- end trimmed group head

// ---- one stream: a tool call, drawn as a row of it --------------------------------------------------------------------
// A card drawn as ONE stream (the 🌊 beside the 🧠) does not condense a run of calls into a head row with a tally; it
// draws the run as the reader asked for it — one row per call, bracketed by two rules, with what the call returned a
// click away under it. `flatRowHtml` in toolGroupHtml is where a row is built: the glyph and tool name, the target the
// call was given (the file and its range, or the command), and the time it took. Two things the condensed group's head
// row carried live on the row here: the clock of the call still in flight, and the "+ N commands" tail the gateway
// puts on a parallel batch.

// A stream piece's stored results are not asked for by the markup: an always-visible .tgrp is swept by the same 3s
// interval that keeps the condensed view's open groups current (see the setInterval beside ensureToolStore), so a
// patch with an empty preview fills itself in without the reader clicking anything.

function toolGroupHtml(lines, key, filter = "", openBody = false, anchor = "", gofs = null, opts = {}) {
  const flat = Boolean(opts && opts.flat);
  const rows = toolBurstRows(lines);
  // No recognisable call lines (a result whose start was trimmed away): show the lines rather than an empty box.
  // They still go through the one renderer, so a diff in a burst whose call lines were trimmed is a diff — and
  // every note in them is resolved on its own identity, because there is no tool name and no cursor to be had
  // here. Without that the note drew as a plain div and the reader was shown "click to read" with nothing to
  // click, which is exactly the state a reload of a long turn produces.
  // What it must not lose is BEING A GROUP: a head row that says what the block is, the data-gstate/data-gat the
  // reader's open state is remembered under, and the fold that state opens. Drawn as bare lines it dropped out of
  // the panel's own map of its groups - nothing to click, nothing to remember, nothing for the sweep to find.
  if (!rows.length) return trimmedGroupHtml(lines, key, anchor, flat, state.codeBoxOpen, Boolean(opts && opts.sep));
  // The reader's own choice wins over the caller's default: a rebuild is not the reader closing the block.
  const gkey = toolGroupStateKey(key, lines, anchor);
  const saved = flat ? null : state.toolGroupOpen.get(gkey);
  if (saved) {
    filter = saved.filter || filter;
    openBody = saved.open;
  }
  // A burst is only in flight while its TURN is live: the bare counts kept a dead turn's last burst ticking. A turn
  // the panel lost at a restart still drew "running 77m16s" an hour later, one line above the word "interrupted".
  const turnJob = state.jobs.get(String(key).split("#")[0]);
  const live = turnJob ? turnLive(turnJob) : false;
  const head = flat ? "" : rows
    .map((r) => {
      const running = r.count > r.done && live;
      const state = running
        ? `<span class="jl-live tgrp-state" data-live-from="${r.at || Date.now()}">${liveSuffix(r.at || Date.now())}</span>`
        : r.duration != null
          ? `<span class="tgrp-state">${r.duration.toFixed(2)}s</span>`
          : "";
      const last = r.last ? `<span class="tgrp-last mono" title="${esc(r.last)}">${linkBatchTail(r.last, r.name, gkey)}</span>` : "";
      const active = filter === r.name ? " is-active" : "";
      return `<div class="tgrp-row${active}" role="button" tabindex="0" data-tgrp-tool="${esc(r.name)}" title="show the ${r.count} call${r.count === 1 ? "" : "s"} this run made to ${esc(r.name)}${r.count === 1 ? "" : ", with their output"}"><span class="tgrp-g">${esc(r.glyph)}</span><span class="tgrp-name">${esc(r.name)}</span><span class="tgrp-n">×${r.count}</span>${last}${state}</div>`;
    })
    .join("");
  const segments = burstSegments(lines).filter((s) => !filter || s.tool === filter);
  const turnId = String(key).split("#")[0];
  const bodyLines = segments.flatMap((s) => s.lines);
  // Each result block takes the next stored row for ITS tool: the console's result lines and the store's rows are
  // both in the order the calls ran, so position pairs them. The segment index did not - a burst interleaves a call
  // with the result it produced, which drew call #2's output under call #1's result line.
  const LF = String.fromCharCode(10);
  const STORE_LINES = 40;
  // Where this group starts in the store's rows for each tool (carried as data-gofs): a turn can hold several
  // bursts, and every one of them pairs from ITS first result - a fresh 0 in each group drew burst 1's output
  // under burst 2's header.
  const cursorsStart = new Map(Object.entries(gofs || {}));
  const cursors = new Map(cursorsStart);
  const takeStored = (tool) => {
    const i = cursors.get(tool) || 0;
    cursors.set(tool, i + 1);
    const rowsOut = state.toolStore.get(`${turnId}|${tool}`)?.results || null;
    return rowsOut?.[i] || null;
  };
  // The index takeStored is ABOUT to take: a result's fold names which of the turn's rows it is, and the pairing
  // above is where that number comes from (the click then reads exactly that row back out of the store).
  const storedRowAt = (tool) => cursors.get(tool) || 0;
  // Result boxes: folded until the reader opens one, in the condensed view and in a stream alike; the ones they
  // opened are remembered by key.
  const codeOpenSet = state.codeBoxOpen;
  const storedHtml = (got, tool = "", arg = "", boxKey = "", at = null) => {
    const all = String(got.text || "").split(LF);
    const displayCut = Boolean(got.truncated && /^… [0-9]+ characters not shown$/.test(all.at(-1) || ""));
    if (displayCut) all.pop();
    const cut = got.truncated && !displayCut;
    if (!all.some((l) => l.trim())) return cut ? '<div class="jl jl-dim jl-note">  this result was cut before its text</div>' : "";
    const shown = all.slice(0, STORE_LINES).map((text) => ({ kind: "store", text }));
    const more = all.length - shown.length;
    const needsFull = more > 0 || displayCut;
    const fold = needsFull && at != null ? { turn: turnId, tool, row: at } : null;
    // A character-capped store read cannot know the total line count. Say preview, then read the uncapped row.
    if (needsFull) shown.push({ kind: "tool-out", text: foldNoteText(displayCut ? { shortened: 1 } : { hidden: more }) });
    return consoleBodyHtml(shown, { tool, arg, codeOpen: codeOpenSet, codeKey: boxKey, fold, fullForFold, source: [] }) +
      (cut ? `<div class="jl jl-dim jl-note">… this result was cut</div>` : "");
  };
  // What the call behind a result was given: the burst's own call line carries it ("📖 read_file · docs/map.md"),
  // and that argument is what a code box's header names the file from. Read from the lines the group was built
  // with, so a rebuild from the DOM reads the same call line.
  const callArgFor = (seg) => {
    const at = lines.indexOf(seg.lines[0]);
    for (let k = (at < 0 ? lines.length : at) - 1; k >= 0; k--) {
      const l = lines[k];
      if (l.kind !== "tool") continue;
      const m = TOOL_START_RE.exec(String(l.text || ""));
      if (m && m[1] === seg.tool) return toolCallArg(l.text);
    }
    return "";
  };
  // A block that starts with a result header is a call's output; anything else is a call itself.
  const resultHead = (seg) => (seg.lines[0] && seg.lines[0].kind === "tool-out" ? TOOL_DONE_RE.exec(String(seg.lines[0].text || "")) : null);
  const liveTurn = turnLive(state.jobs.get(turnId));
  // The stored row that belongs to THIS call. The store holds every result the turn returned for that tool and the
  // console's own lines can cover only part of the turn (a restored card keeps its last lines), so a position is
  // not an identity: the call line carries the file the tool was given, and a stored diff names the same file in
  // its own "--- a/…" header. That file is what pairs them.
  const pathKey = (p) => normPath(String(p || "")).replace(/^[ab]\//, "").toLowerCase();
  const storedForFile = (tool, arg) => {
    const want = pathKey(arg);
    if (!want) return null;
    const rowsOut = state.toolStore.get(`${turnId}|${tool}`)?.results || [];
    for (let i = 0; i < rowsOut.length; i++) {
      for (const l of String(rowsOut[i].text || "").split(LF).slice(0, 3)) {
        if (pathKey(l.replace(/^[-+]{3}\s+/, "")) === want) return { row: rowsOut[i], at: i };
      }
    }
    return null;
  };
  // A call's own row is the handle for its output: the fold covers the lines under that row and nothing else, and
  // the row's own text is still a console line inside it, so a rebuild reads the call back exactly as before.
  const callBlockHtml = (callLine, callBody, key) => {
    const folded = state.callFolded.has(key);
    const n = (callBody.match(/data-ltext=/g) || []).length;
    const label = `${n} line${n === 1 ? "" : "s"}`;
    const what = folded ? "show" : "fold";
    return (
      `<div class="call${folded ? " is-folded" : ""}" data-call-key="${esc(key)}">` +
      `<div class="call-head" title="${what} this call's output">` +
      `<button type="button" class="call-fold" data-call-fold="1" data-call-key="${esc(key)}" aria-expanded="${folded ? "false" : "true"}"` +
      ` aria-label="${what} this call's output (${label})">${folded ? "▸" : "▾"}</button>` +
      consoleBodyHtml([callLine], { tool: "", arg: "", codeOpen: null, codeKey: "" }) +
      `<span class="call-n">${label}</span>` +
      `<span class="call-hint"${folded ? "" : " hidden"}>folded — click to read</span></div>` +
      `<div class="call-body" data-copy-through${folded ? " hidden" : ""}>${callBody}</div>` +
      `</div>`
    );
  };
  // `dropHead` is for the stream's tool-usage rows: the row above the box says the tool and the time the result
  // header would repeat, so the box starts at what the call returned.
  const bodyOf = (seg, si, { dropHead = false } = {}) => {
    const arg = callArgFor(seg);
    // One key per segment, so the reader's fold survives a rebuild of the burst and a burst holding two files
    // keeps two independent boxes.
    const boxKey = `${gkey}|${si}`;
    // The result line ("  ↳ patch · 79.51s") is the console's own record of the result and stays whatever else
    // is drawn under it — unless the caller is drawing a stream row, which carries that record itself.
    const resultLine = resultHead(seg) ? seg.lines.slice(0, 1) : [];
    const headHtml = () => (dropHead ? "" : render(resultLine));
    const preview = resultHead(seg) ? seg.lines.slice(1) : seg.lines;
    const render = (list, extra = {}) =>
      consoleBodyHtml(list, { tool: seg.tool, arg, codeOpen: codeOpenSet, codeKey: boxKey, fullForFold, ...extra });
    // Where this result's store row is: the pairing below takes rows in order, so the cursor's value BEFORE it
    // advances is this result's own row — the number a fold's click fetches by.
    const rowAt = resultHead(seg) ? storedRowAt(seg.tool) : 0;
    // The cursor advances for EVERY result line, preview or not. A tool whose live previews are populated used to
    // return before consuming its row, so its rows piled up and were re-printed as "more stored result" at the end
    // while the next result line paired with the wrong row.
    const got = resultHead(seg) ? takeStored(seg.tool) : null;
    let out = headHtml() + render(preview);
    if (resultHead(seg)) {
      // The gateway's live stream carries a PREVIEW of a result. When it was cut, these lines are not the whole
      // answer, and the session store is where the rest of it is - it is where a patch's diff comes from in the
      // first place. So the stored row for this call's own file is drawn in place of the cut preview, and the cut
      // row the renderer put at the preview's edge stays as the honest answer only when the store has nothing.
      const full = preview.some((l) => consoleCutNote(String(l.text || ""))) ? storedForFile(seg.tool, arg) : null;
      // The panel's own fold, one cap down from the gateway's: the whole result arrived and the card kept its
      // head. The note is drawn as the button that opens it — unless the reader already opened THIS result, in
      // which case the whole stored text is drawn in its place (that is what the click set up, and a rebuild
      // must not fold it back shut).
      const foldAt = preview.findIndex((l) => consoleFoldNote(String(l.text || "")));
      // The note names its own result — from the head the panel kept above it (checked against the store's own
      // rows once the burst has read them) or from the row the server stamped on the line — and only falls back
      // to this burst's cursor when it has neither.
      const fold = foldAt < 0 ? null : foldForNote({ turnId, tool: seg.tool, note: preview[foldAt], head: preview.slice(0, foldAt), cursor: rowAt });
      if (full) out = headHtml() + storedHtml(full.row, seg.tool, arg, boxKey, full.at);
      else if (foldAt >= 0) {
        out = headHtml() + render(preview, fold ? { fold } : {});
      } else if (!preview.some((l) => String(l.text || "").trim())) {
        out += got
          ? storedHtml(got, seg.tool, arg, boxKey, rowAt)
          : `<div class="jl jl-dim jl-note">  ${liveTurn ? "no output in the session store yet" : "no output recorded for this call"}</div>`;
      }
    }
    return out;
  };
  // A call and the result it produced are TWO segments: the panel draws the call when the tool starts and the
  // result when it finishes, and a parallel batch interleaves them. The reader's handle is the call's own row, so
  // a call segment followed by its own tool's result segment is rendered as one foldable block - the call line on
  // top, that call's output under it, and nothing else on the card moving when it folds. A call whose result has
  // not arrived yet has nothing to fold and is drawn as the plain line it always was.
  const bodyParts = [];
  // One stream: the call still in flight carries its clock on its own row (the condensed view keeps it there too),
  // and a call IS its row — there is no separate "↳ tool" line and no output in the flow until the reader asks.
  const busyAt = flat && live ? inflightToolIndex(lines) : -1;
  const busyLine = busyAt >= 0 ? lines[busyAt] : null;
  // ---- the reader's tool-usage group: ONE row per call ------------------------------------------------------------
  // A run of calls drawn the way the reader asked for it: one rule above the rows and one below them, and inside it
  // ONE row per call — the tool, the target it was given (the file and its range, or the command) and how long it
  // took. There is no "↳ tool" line of its own: the row IS that record, and the time the result line carried is
  // drawn on the row that produced it. What the call returned is one click under its row, in the same box the
  // condensed view opens (a result's head, the stored text behind a fold note, the honest note when there is
  // nothing). A row starts shut — that is what keeps a burst of five calls five lines instead of a wall of output —
  // and the rules are the group's own edges: the blank line the stream puts above a piece (`jl-sep`, from
  // wtStream.pieces) still sits outside them, so nothing new decides where a group begins or ends.
  //
  // Rows pair by TOOL, in order, not by adjacency: a parallel batch interleaves its calls (call, call, result,
  // result), so the k-th call of a tool is answered by that tool's k-th result. A result whose call the console no
  // longer holds keeps a row of its own — one shape for the group — with no target to name.
  const flatRows = [];
  if (flat) {
    const waiting = new Map();
    for (const seg of segments) {
      const first = seg.lines[0] || {};
      if (seg.lines[0] && resultHead(seg)) {
        const queue = waiting.get(seg.tool) || [];
        const row = queue.shift();
        if (row) row.result = seg;
        else flatRows.push({ call: null, result: seg, extra: [] });
        continue;
      }
      if (first.kind === "tool") {
        const row = { call: seg, result: null, extra: [] };
        flatRows.push(row);
        const queue = waiting.get(seg.tool) || [];
        queue.push(row);
        waiting.set(seg.tool, queue);
        continue;
      }
      // A line of a burst whose call line is outside the window: it is output, so it belongs in the box of the row
      // above it. With no row above it there is nothing to open, and it is drawn as the lines it is.
      const prev = flatRows[flatRows.length - 1];
      if (prev) prev.extra.push(...seg.lines);
      else flatRows.push({ call: null, result: null, extra: [...seg.lines] });
    }
  }
  const flatRowHtml = (row, si) => {
    const call = row.call;
    const line = call ? call.lines[0] : null;
    const text = line ? String(line.text || "") : "";
    const m = line ? TOOL_START_RE.exec(text) : null;
    const res = row.result ? row.result.lines[0] : null;
    const resText = res ? String(res.text || "") : "";
    const done = res ? TOOL_DONE_RE.exec(resText) : null;
    const tool = (call && call.tool) || (row.result && row.result.tool) || (m ? m[1] : "") || "";
    const g = line ? /^(\p{Extended_Pictographic}[\uFE0F\u200D]*)\s*/u.exec(text) : null;
    const glyph = (g && g[1]) || (call ? "⚡" : "\u21b3");
    const arg = call ? toolCallArg(text) : "";
    // The gateway's own duration lives on the result header; a stream that carries none still knows when the call
    // started and when its result came back, which is the same measurement taken from the panel's side.
    const said = done ? /·\s*([\d.]+)s/.exec(resText) : null;
    const from = line ? Number(line.at) || 0 : 0;
    const to = res ? Number(res.at) || 0 : 0;
    const secs = said ? Number(said[1]) : from && to && to >= from ? (to - from) / 1000 : null;
    const failed = done ? /·\s*error\b/.test(resText) : false;
    const running = !row.result && live && line && line === busyLine;
    const stateHtml = failed
      ? `<span class="tgrp-state">error</span>`
      : secs != null
        ? `<span class="tgrp-state">${secs.toFixed(2)}s</span>`
        : running
          ? `<span class="jl-live tgrp-state" data-live-from="${from || Date.now()}">${liveSuffix(from || Date.now())}</span>`
          : "";
    const key = `${gkey}|c${si}`;
    const open = state.callOpen.has(key);
    const target = arg ? `<span class="tgrp-last mono" title="${esc(arg)}">${linkBatchTail(arg, tool, gkey)}</span>` : `<span class="tgrp-last"></span>`;
    const loose = [...(call ? call.lines.slice(1) : []), ...row.extra];
    const box =
      (loose.length ? consoleBodyHtml(loose, { tool, arg, codeOpen: codeOpenSet, codeKey: `${gkey}|c${si}` }) : "") +
      (row.result ? bodyOf(row.result, si, { dropHead: true }) : "");
    // Both halves of the record travel on the row: the call's own line (data-ltext — the reader's console line) and
    // the result header the panel drew under it until now (data-lresult). groupLines reads them back as the two
    // lines they are, so a rebuild keeps the pairing, the time, and the starting row the NEXT burst pairs from.
    const label = `${open ? "hide" : "show"} what ${tool || "this call"} returned${secs != null ? ` (${secs.toFixed(2)}s)` : ""}`;
    return (
      `<div class="tgrp-call${open ? " is-open" : ""}" data-call-key="${esc(key)}">` +
      `<div class="jl jl-tool tgrp-row" role="button" tabindex="0" data-tgrp-call="${esc(key)}" data-call-tool="${esc(tool)}"` +
      ` aria-expanded="${open ? "true" : "false"}" title="${esc(label)}"` +
      (call ? ` data-lid="${esc(line.lid ?? "")}" data-ltext="${esc(text)}" data-lkind="tool"` : ` data-lkind="tool-out"`) +
      (res ? ` data-lresult="${esc(resText)}" data-lrat="${esc(Number(res.at) || "")}" data-lrld="${esc(res.lid ?? "")}"` : "") +
      `><span class="tgrp-g">${esc(glyph)}</span><span class="tgrp-name">${esc(tool)}</span>${target}${stateHtml}</div>` +
      `<div class="tgrp-out"${open ? "" : " hidden"}>${box}</div>` +
      `</div>`
    );
  };
  if (flat) {
    for (let si = 0; si < flatRows.length; si++) {
      const row = flatRows[si];
      // Loose lines with no call and no result are output with nothing to fold: drawn where they are, as they were.
      if (!row.call && !row.result) {
        bodyParts.push(consoleBodyHtml(row.extra, { tool: "", arg: "", codeOpen: codeOpenSet, codeKey: `${gkey}|c${si}` }));
        continue;
      }
      bodyParts.push(flatRowHtml(row, si));
    }
  } else {
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const next = segments[si + 1];
      if (seg.lines[0] && seg.lines[0].kind === "tool" && next && resultHead(next) && next.tool === seg.tool) {
        bodyParts.push(callBlockHtml(seg.lines[0], bodyOf(next, si + 1), `${gkey}|${si}`));
        si++;
        continue;
      }
      bodyParts.push(bodyOf(seg, si));
    }
  }
  // No leftover list: the store's rows are paired per burst, so a group cannot know which rows belong to a burst
  // further down the turn — printing the rest of the array re-printed the NEXT burst's output under this one's last
  // result line (measured on a two-burst turn). A result line the console lost stays unshown; the call line is
  // still there, and the store is one click away on that tool's row.
  // A batch the reader has opened: the calls behind its "+ N commands", oldest first.
  const batchBlocks = rows
    .map((r) => {
      const calls = state.batchCalls.get(`${gkey}|${r.name}`);
      if (!calls || !calls.length) return "";
      // jl-panel: this block is drawn BY the panel, so groupLines must not read it back as console lines (it did,
      // and the absorbed summaries then satisfied "the preview carried this result", hiding the stored output).
      return (
        `<div class="jl jl-dim jl-panel">↳ the ${calls.length} call${calls.length === 1 ? "" : "s"} in this batch (${esc(r.name)})</div>` +
        calls.map((c) => `<div class="jl jl-tool-out jl-panel">${esc(c.summary)}</div>`).join("")
      );
    })
    .join("");
  const body =
    (bodyLines.length > 0
      ? bodyParts.join("")
      : `<div class="jl jl-dim">this run recorded nothing for ${esc(filter)}</div>`) + batchBlocks;
  const label = filter ? `all ${lines.length}` : `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  if (flat) {
    // One piece of a stream: no head row and no "N lines" button, and no template whitespace either (the console is a
    // <pre>). `data-gflat` is what keeps it flat: the 3s sweep that keeps an open group's stored results current
    // aims at this node by its state key, and a rebuild must not put the folded group back under the reader.
    // `tgrp-calls` is the row list inside the group's two rules — the rows, and nothing else, at rest.
    return (
      `<div class="tgrp tgrp-flat${opts.sep ? " jl-sep" : ""}" data-tgrp="${esc(key)}" data-gstate="${esc(gkey)}" data-gat="${esc(anchor || toolGroupAnchor(lines))}"` +
      ` data-gofs="${esc(JSON.stringify(Object.fromEntries(cursorsStart)))}" data-gflat="1">` +
      `<div class="tgrp-body tgrp-calls">${body}</div></div>`
    );
  }
  return `<div class="tgrp" data-copy data-tgrp="${esc(key)}" data-gstate="${esc(gkey)}" data-gat="${esc(anchor || toolGroupAnchor(lines))}" data-gofs="${esc(JSON.stringify(Object.fromEntries(cursorsStart)))}"${filter ? ` data-filter="${esc(filter)}"` : ""}>
      <div class="tgrp-head" data-copy-text>${head}<button type="button" class="tgrp-more${filter ? " is-open" : ""}" data-tgrp-more="${esc(key)}" title="${filter ? "show every tool in this run, not just this one" : "show every call in this run of tools, with its output"}">${label}</button></div>
      <div class="tgrp-body"${openBody || filter ? "" : " hidden"}>${body}</div>
    </div>`;
}

// The chip that jumps a console back to its newest line. It sits beside the scrolled element inside a
// positioned wrapper, so it stays in the corner of the console instead of travelling with the text; it is shown
// only while the reader is scrolled away from the end.
function toBottomBtnHtml() {
  return `<button type="button" class="to-bottom" data-to-bottom="1" title="jump to the newest line and follow it again">\u2193</button>`;
}

function paintToBottom(box) {
  const wrap = box?.closest?.(".out-wrap");
  if (!wrap) return;
  const overflowing = box.scrollHeight > box.clientHeight + 4;
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight <= 24;
  wrap.classList.toggle("is-at-end", !overflowing || atEnd);
}

// ---- one stream: the turn's own body, drawn in its order ---------------------------------------------------------
// Everything a card keeps apart, in one flow: the panel's console lines, the reasoning blocks (placed by
// core/stream-merge.js — see why its comment is the authority on where a block goes), and each RUN of tool calls drawn
// as the reader asked for it — one row per call inside two rules, with what each call returned one click under its row.
//
// The drift is drawn piece by piece on purpose (wtStream.pieces): a live line then only ever redraws the piece it
// belongs to, so a reader's selection in an earlier paragraph survives the turn growing under it. A run of call pieces
// is the exception the group IS: those pieces are collected into one group node, which is what "a rule above and a
// rule below the group" means.
function streamBodyHtml(turn, lines, windowFull = false) {
  const W = globalThis.wtStream;
  if (!W || typeof W.merge !== "function" || typeof W.pieces !== "function") return "";
  const thread = turn.thread || turn.id;
  // Reasoning joins the stream only while the 🧠 is on: with it off, the console's own one-line preview is the only
  // trace of what the agent thought, exactly as in the condensed view.
  const blocks = thinkingOn(thread) ? state.thinkCache.get(turn.id)?.blocks || [] : [];
  // Reasoning joins the console as lines keyed `think:<at>`; feeding them to the pacer HERE, where the turn's own
  // clock is at hand, is what makes lineHtml type them out exactly like prose.
  if (blocks.length) for (const b of blocks) paceThinkBlock(turn, b);
  const merged = W.merge(lines, blocks, { windowFull, hidePreviews: blocks.length > 0 });
  const storeSeen = new Map();
  const parts = [];
  let n = 0;
  // A RUN of call pieces is ONE group. `pieces()` cuts a unit per call (so a live line only ever redraws the call it
  // belongs to), but the reader's tool-usage group is the run: one rule above its rows, one below, however many calls
  // the burst made. So consecutive call pieces are collected here and handed to the one renderer that draws a group.
  // Its separation is the run's FIRST piece's — `pieces()` decides that, nothing here — and the piece after the run
  // carries its own, which is the blank line under the group.
  let run = null;
  const flushRun = () => {
    if (!run) return;
    parts.push(toolGroupHtml(run.lines, `${turn.id}#f${n++}`, "", false, "", run.gofs, { flat: true, sep: run.sep }));
    // The stored rows this group paired from are claimed for the whole TURN: the next group starts after them.
    for (const l of run.lines) {
      if (l.kind !== "tool-out") continue;
      const m = TOOL_DONE_RE.exec(String(l.text || ""));
      if (m) storeSeen.set(m[1], (storeSeen.get(m[1]) || 0) + 1);
    }
    run = null;
  };
  // Every piece here is set apart from the piece above it by the one blank line a reasoning block has always had —
  // `pieces()` says which, and `jl-sep` is the class that rule hangs on. Nothing above the first piece: there is
  // nothing up there to be set apart from.
  for (const seg of W.pieces(merged)) {
    if (!seg) continue;
    const sep = seg.sep ? "jl-sep" : "";
    if (!seg.unit) {
      // A reasoning block is a line of the stream like any other: same markup, its own kind, so a reader can copy or
      // select across it and the console's own links still work inside it.
      flushRun();
      parts.push(lineHtml(seg.line, "", sep));
      continue;
    }
    // The stored rows this group pairs from: what the earlier groups of THIS turn already consumed for that tool.
    if (!run) run = { lines: [], sep: seg.sep, gofs: Object.fromEntries(storeSeen) };
    run.lines.push(...seg.lines);
  }
  flushRun();
  return parts.join("");
}

function turnBody(turn, copy = "") {
  const all = jobLines(turn.id).filter((l) => !isBookkeeping(l));
  // A window, cut on a burst boundary rather than a line count: windowLines keeps the call line of the burst the
  // window would otherwise open inside, so that burst is still a group with a head row and a remembered state.
  const lines = windowLines(all);
  const running = turnLive(turn);
  // The 🌊: this card draws ONE stream, so the reasoning is not a block above the console — it is in it.
  const stream = streamOn(turn.thread || turn.id) && Boolean(globalThis.wtStream);
  // Which started tool call has no result yet. Parallel calls interleave, so count starts and
  // completions per tool name instead of assuming "the last line is the running one".
  const busy = running ? inflightToolIndex(lines) : -1;
  // Each burst pairs its result lines with the store's rows from ITS own offset: a turn can hold a patch burst, a
  // paragraph, then another patch burst, and the second one must start after the first one's rows.
  const storeSeen = new Map();
  const body = stream
    ? streamBodyHtml(turn, lines, lines.length < all.length)
    : burstGroups(lines)
        .map((item, gi) => {
          if (item.group) {
            const gofs = Object.fromEntries(storeSeen);
            for (const l of item.lines) {
              if (l.kind !== "tool-out") continue;
              const m = TOOL_DONE_RE.exec(String(l.text || ""));
              if (m) storeSeen.set(m[1], (storeSeen.get(m[1]) || 0) + 1);
            }
            // The reader's own answer to "count them, or one line each": with the tally off a burst is drawn as
            // the same run of rows the 🌊 console draws — no head row, no "all N" button, one press per call —
            // and the group keeps its two rules, its identity and its store offsets.
            return toolGroupHtml(item.lines, `${turn.id}#${gi}`, "", false, "", gofs, toolGroupsOn() ? {} : { flat: true });
          }
          const l = item.line;
          const i = lines.indexOf(l);
          const live = i === busy ? `<span class="jl-live" data-live-from="${Number(l.at) || Date.now()}">${liveSuffix(Number(l.at) || Date.now())}</span>` : "";
          return lineHtml(l, live);
        })
        .join("") || '<div class="jl jl-dim" data-wait="1">waiting for output…</div>';
  return (stream ? "" : thinkHtml(turn, copy)) +
    // `out-tab` carries the 18px left tab the console itself has, so the wrapper is the console's box: the chip
    // centred in the wrapper is centred in the console, not 9px off it.
    `<div class="out-wrap out-tab" data-copy><pre class="job-out" data-out="${esc(turn.id)}${esc(copy)}">${body}</pre>${toBottomBtnHtml()}</div>` +
    // The subagents this turn spawned, right under the console they ran beside: the delegation is the turn's own
    // work, not the card's, and a card with several turns would otherwise show the newest one's children under all
    // of them.
    turnSubagentsHtml(turn, copy) +
    approvalPrompt(turn, copy) + approvalDecided(turn) +
    questionPrompt(turn, copy) + questionAnswered(turn);
}

// The approval question belongs where the reading stopped: directly under the console output of the
// turn that is parked on it, not in a separate panel at the bottom of the card. It is a box that
// behaves like a popup (raised, bordered, the only thing asking for a decision) but it lives in the
// flow, so it never covers the output it is about.
// The choices a parked question offers, and what each one means. ONE table for every box the panel draws — a turn
// parked on an approval, a local-only worktree parked on a push — because "Always allow" has to mean the same
// thing in both, and the reader asked for the same box rather than a lookalike.
const APPROVAL_CHOICE_LABEL = { once: "Allow once", session: "Allow for this session", always: "Always allow", deny: "Deny" };

// The permission box itself: the amber raised box, its head, the thing being asked about, the choices, and a
// deadline the page's own 1s clock counts down. Extracted from approvalPrompt() when the remote-write permission
// arrived, so the two questions cannot drift into two designs. Everything that differs is a parameter: which
// record the press belongs to (`extra`), what the head and the tooltips say, and where the foot's countdown is
// driven from (`data-approval-until`, which tickApprovals already reads).
function permissionBoxHtml({
  id,
  requestId = "",
  forAttr = "",
  head,
  command,
  choices = ["once", "deny"],
  deadline = 0,
  windowMs = 0,
  closed = false,
  closedHead = APPROVAL_CLOSED_HEAD,
  closedNote = "",
  titles = null,
  extra = "",
}) {
  const left = deadline ? deadline - Date.now() : 0;
  const buttons =
    `<div class="ta-actions">` +
    choices
      .map(
        (c) =>
          `<button class="btn-approve${c === "deny" ? " btn-deny" : ""}" data-approve="${esc(id)}" data-choice="${esc(c)}" data-request="${esc(requestId)}" data-until="${deadline || ""}"${extra} type="button" title="${esc((titles && titles[c]) || APPROVAL_CHOICE_LABEL[c] || c)}">${esc(APPROVAL_CHOICE_LABEL[c] || c)}</button>`,
      )
      .join("") +
    `</div>`;
  // The countdown only exists when the window is known: a question with no deadline gets no invented number.
  const foot =
    !deadline || !windowMs
      ? ""
      : `<div class="ta-foot${closed ? " is-over" : left <= 20_000 ? " is-low" : ""}" data-approval-until="${deadline}" data-approval-window="${windowMs}" title="time left before this question is denied and the writer is told so">` +
        `<div class="ta-timer"><span style="width:${Math.max(0, Math.min(100, (left / windowMs) * 100)).toFixed(2)}%"></span></div>` +
        `<span class="ta-left mono">${closed ? "expired" : `~${fmtLeft(left)} left`}</span></div>`;
  return `<div class="turn-approval${closed ? " is-expired" : ""}" ${forAttr}>
    <div class="ta-head mono">${closed ? esc(closedHead) : head}</div>
    <pre class="ta-cmd mono">${esc(command || "(no command text)")}</pre>
    ${closed ? closedNote : buttons}
    ${closed ? "" : foot}
  </div>`;
}

function approvalPrompt(turn, copy = "") {
  const approval = turn.approval;
  if (!approval) return "";
  // A question only exists while its turn does. The panel's approval object can outlive the run — the
  // run errors, is cancelled, or its stream simply ends while the request is still attached — and a box
  // offering "Allow once" for a turn that is already dead is worse than no box. The terminal state of
  // the turn wins, and the error line left in its console is the record of what happened.
  const live = turnLive(turn);
  if (!live || turn.approvalDone) return "";
  const choices = Array.isArray(approval.choices) && approval.choices.length ? approval.choices : ["once", "deny"];
  // The window is the gateway's own (`approvals.timeout`), carried on the request when it arrived. An approval
  // is a question with a deadline: the gateway gives up at it and denies the command on its own, so a box that
  // keeps offering a choice past that instant is offering a decision that can no longer be made — the answer
  // comes back 409 `approval_not_pending` and the reader is told nothing about why.
  const deadline = Number(approval.deadline) || 0;
  const windowMs = (Number(approval.timeoutSeconds) || 0) * 1000;
  const closed = Boolean(deadline) && deadline - Date.now() <= 0;
  return permissionBoxHtml({
    id: turn.id,
    requestId: approval.requestId || "",
    forAttr: `data-approval-for="${esc(turn.id)}${esc(copy)}"`,
    head: "⚠ waiting on you — this turn is parked until you answer",
    command: approval.command,
    choices,
    deadline,
    windowMs,
    closed,
    closedNote: approvalClosedNote(),
    titles: {
      once: "allow this command (once)",
      session: "allow this command (session)",
      always: "allow this command (always)",
      deny: "refuse this command — the agent is told no and carries on without it",
    },
  });
}

// The window closed with nobody answering: the gateway denied the command and the agent carried on. Nothing is
// left to answer here, and saying so is better than a disabled button that looks like a decision was pending.
const APPROVAL_CLOSED_HEAD = "⚠ no answer within the gateway's window — it has already denied this command";

function approvalClosedNote() {
  return `<div class="ta-note mono">the gateway stopped waiting and denied it; the agent carried on without this command</div>`;
}

// Once answered the box collapses to one line: what was decided, about what. An approval nobody answered gets its
// own line — the gateway denied the command when its window ran out, and "✓ approved" for that would be a lie.
function approvalDecided(turn) {
  const done = turn.approvalDone;
  if (!done || turn.approval) return "";
  if (done.expired) {
    const why =
      done.reason === "withdrawn"
        ? "the gateway had already let this request go (its window closed, another surface answered it, or the run was stopped)"
        : `no answer reached the gateway inside its waiting window${Number(done.waitedSeconds) ? ` (${fmtLeft(Number(done.waitedSeconds) * 1000)} unanswered)` : ""}`;
    return `<div class="turn-approval-done mono is-expired" title="${esc(why)}${done.command ? ` — ${esc(String(done.command))}` : ""}">✕ not answered here${done.command ? `: ${esc(String(done.command).slice(0, 140))}` : ""}</div>`;
  }
  const denied = String(done.choice || "").toLowerCase() === "deny";
  const verb = denied ? "denied" : `approved ${done.choice || ""}`.trim();
  return `<div class="turn-approval-done mono${denied ? " is-deny" : ""}" title="${esc(done.command || "")}">${denied ? "✕" : "✓"} ${esc(verb)}${done.command ? `: ${esc(String(done.command).slice(0, 140))}` : ""}</div>`;
}

// ---- the agent's own question (the `clarify` tool) ---------------------------------------
// Same place as an approval — under the console of the turn that is parked on it — but a different
// thing: there is no command to judge, the prompt is a sentence to read, and the answers are full
// sentences. Light purple, not amber, so "answer me" and "allow this" never read as one interruption.
//
// The reader's picks (multi-select) and their typed "Other" answer survive a repaint: the card is
// rebuilt from a poll the moment anything else about the turn changes, and losing a half-made
// selection to that is the same bug as losing a draft.
const questionPicks = new Map(); // `${turnId}${copy}` -> Set(choice index)
const questionDrafts = new Map(); // `${turnId}${copy}` -> typed answer
const questionSending = new Set(); // `${turnId}` while a POST is in flight
const RECOMMENDED_RE = /^(.*?)\s*\(Recommended\)$/;

// The tool marks its best choice by suffixing the label; the card draws that as a chip. The chip goes BEFORE
// the label, not after it: on a wide card the text block stops at a readable measure, and a trailing chip
// then floats in the empty right-hand space looking like it belongs to nothing. Leading, it is part of the
// label's first line and stays next to what it marks at any width.
function questionHead(choice) {
  const m = RECOMMENDED_RE.exec(String(choice));
  if (!m) return `<span class="tq-text">${esc(choice)}</span>`;
  return `<span class="tq-rec">recommended</span><span class="tq-text">${esc(m[1])}</span>`;
}

// ---- the question box's look (Settings > Display) ------------------------------------------------
// The box is a signal, so how it reads is the reader's: tint, type size, how tightly the answer rows are
// packed, and whether the typed answer box is offered at all. All of it lives in this browser like every
// other Display row. The tint is a CLASS on :root (one rule set per hue in style.css), the size is one
// variable — so the Settings sample and a live card are literally the same rules, not a drawing of them.
const Q_LOOK_KEY = "wm.qLook";
const Q_TINTS = ["violet", "sky", "mint", "rose", "slate"];
const Q_SIZE_MIN = 11;
const Q_SIZE_MAX = 18;
const Q_SIZE_DEFAULT = 13;
// Question width: 0 means "the console's own box" (the default), any other value is a pixel cap.
const Q_WIDTH_MIN = 0;
const Q_WIDTH_MAX = 2400;

function qLook() {
  const out = { tint: "violet", size: Q_SIZE_DEFAULT, width: 0, compact: false, typed: true };
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(Q_LOOK_KEY) || "null");
  } catch {
    raw = null;
  }
  if (raw && typeof raw === "object") {
    if (Q_TINTS.includes(raw.tint)) out.tint = raw.tint;
    const size = Number(raw.size);
    if (Number.isFinite(size)) out.size = Math.min(Q_SIZE_MAX, Math.max(Q_SIZE_MIN, size));
    const width = Number(raw.width);
    if (Number.isFinite(width)) out.width = Math.min(Q_WIDTH_MAX, Math.max(Q_WIDTH_MIN, width));
    if (typeof raw.compact === "boolean") out.compact = raw.compact;
    if (typeof raw.typed === "boolean") out.typed = raw.typed;
  }
  return out;
}

// Read once, so a card rendered before anyone opens Settings still uses the saved look.
let qLookState = qLook();

function paintQLook(look = qLookState) {
  const size = $("q-size");
  // Never rewrite the box the reader is typing into: a clamp lands on `change`, not on every keystroke.
  if (size && document.activeElement !== size) size.value = String(look.size);
  const width = $("q-width");
  if (width && document.activeElement !== width) width.value = String(look.width);
  for (const btn of document.querySelectorAll("[data-q-width-set]")) {
    btn.classList.toggle("on", (Number(btn.dataset.qWidthSet) || 0) === look.width);
  }
  const compact = $("q-compact");
  if (compact) compact.checked = look.compact;
  const typed = $("q-typed");
  if (typed) typed.checked = look.typed;
  for (const btn of document.querySelectorAll("[data-q-tint]")) {
    btn.classList.toggle("on", btn.dataset.qTint === look.tint);
    btn.setAttribute("aria-pressed", btn.dataset.qTint === look.tint ? "true" : "false");
  }
}

function applyQLook(next = {}, { save = true } = {}) {
  const look = { ...qLookState, ...next };
  if (!Q_TINTS.includes(look.tint)) look.tint = "violet";
  const n = Number(look.size);
  look.size = Math.min(Q_SIZE_MAX, Math.max(Q_SIZE_MIN, Number.isFinite(n) && n > 0 ? n : Q_SIZE_DEFAULT));
  const w = Number(look.width);
  look.width = Math.min(Q_WIDTH_MAX, Math.max(Q_WIDTH_MIN, Number.isFinite(w) && w > 0 ? w : 0));
  look.compact = Boolean(look.compact);
  look.typed = Boolean(look.typed);
  qLookState = look;
  const root = document.documentElement;
  for (const tint of Q_TINTS) root.classList.toggle(`q-tint-${tint}`, tint === look.tint);
  root.classList.toggle("q-compact", look.compact);
  // Purely for the Settings sample, which has its typed row in its markup; a live card omits the row.
  root.classList.toggle("q-no-typed", !look.typed);
  root.style.setProperty("--q-size", `${look.size}px`);
  // 0 is not a width: it means "take the console's box", so no cap and no centring.
  root.classList.toggle("q-width-set", look.width > 0);
  if (look.width > 0) root.style.setProperty("--q-width", `${look.width}px`);
  else root.style.removeProperty("--q-width");
  paintQLook(look);
  if (save) {
    try {
      localStorage.setItem(Q_LOOK_KEY, JSON.stringify(look));
    } catch {
      /* private mode: the look still applies for this page */
    }
  }
  return look;
}

function questionPrompt(turn, copy = "") {
  const q = turn.question;
  if (!q) return "";
  // A question exists only while its turn does: the clarify waiter is retired with the turn, so a box
  // still offering an answer after the run ended would be answering nobody.
  if (!turnLive(turn) || turn.questionDone) return "";
  const key = `${turn.id}${copy}`;
  const choices = Array.isArray(q.choices) ? q.choices : [];
  const multi = Boolean(q.multiSelect) && choices.length > 0;
  const picks = questionPicks.get(key) || new Set();
  const draft = questionDrafts.get(key) || "";
  const rows = choices
    .map((c, i) =>
      multi
        ? `<label class="tq-choice is-multi${picks.has(i) ? " on" : ""}" data-qvalue="${esc(c)}" title="tick the answers you want, then send them">
      <input type="checkbox" data-qpick="1" data-qturn="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qindex="${i}"${picks.has(i) ? " checked" : ""}>
      <span class="tq-box" aria-hidden="true"></span>${questionHead(c)}</label>`
        : `<button type="button" class="tq-choice" data-qanswer="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qrequest="${esc(q.requestId || "")}" data-qvalue="${esc(c)}" title="send this answer — the agent carries on with it">
      <span class="tq-box" aria-hidden="true"></span>${questionHead(c)}</button>`,
    )
    .join("");
  // A question with no choices has nothing to answer with except words, so the typed box always stays for
  // it; with choices, Settings can take the box away, and a multi-select question then keeps a bare Send
  // button (it would otherwise be unanswerable).
  const showTyped = qLookState.typed || choices.length === 0;
  const note = !showTyped
    ? multi
      ? "tick any that apply, then Send answer"
      : "click a choice above"
    : multi
      ? "tick any that apply, then Send answer · a typed answer replaces the ticks"
      : choices.length
        ? "click a choice above, or type your own answer · Enter sends"
        : "type your answer · Enter sends, Shift+Enter adds a line";
  const sendBtn = `<button type="button" class="tq-send" data-qsend="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qrequest="${esc(q.requestId || "")}"${questionSending.has(turn.id) ? " disabled" : ""}>Send answer</button>`;
  const answerRow = showTyped
    ? `<div class="tq-other-row">
      <textarea class="tq-other" data-qother="${esc(turn.id)}" data-qcopy="${esc(copy)}" rows="2" placeholder="or type your own answer" title="anything you type here is sent as your answer, in your own words">${esc(draft)}</textarea>
      ${sendBtn}
    </div>`
    : multi
      ? `<div class="tq-other-row is-send-only">${sendBtn}</div>`
      : "";
  // The countdown: the gateway stops waiting for this answer when the window it is configured with runs out.
  // Rendered with its current width so the first paint is right, then driven by the page's one clock tick.
  const deadline = Number(q.deadline) || 0;
  const windowMs = (Number(q.timeoutSeconds) || 0) * 1000;
  const leftMs = deadline - Date.now();
  const pct = deadline && windowMs ? Math.max(0, Math.min(100, (leftMs / windowMs) * 100)).toFixed(2) : null;
  const clock = pct === null
    ? ""
    : `<div class="tq-foot${pct <= 12 ? " is-low" : ""}" data-q-clock data-q-deadline="${deadline}" data-q-window="${windowMs}" title="time left before the gateway stops waiting for this answer — measured from when the question reached the panel, so it is a second or two optimistic">
      <div class="tq-timer"><span style="width:${pct}%"></span></div>
      <span class="tq-left mono">~${fmtLeft(leftMs)} left</span>
    </div>`;
  return `<div class="turn-question" data-question-for="${esc(turn.id)}${esc(copy)}">
    <div class="tq-head mono">❓ waiting on you — the agent is parked until you answer</div>
    <div class="tq-question">${esc(q.question || "(no question text)")}</div>
    ${rows ? `<div class="tq-choices${multi ? " is-multi" : ""}">${rows}</div>` : ""}
    <div class="tq-note mono">${esc(note)}</div>
    ${answerRow}
    ${clock}
    <div class="tq-warn mono" data-qwarn="${esc(turn.id)}${esc(copy)}"></div>
  </div>`;
}

// "~49m left", "~90s left": the countdown is an estimate, so it carries the panel's tilde.
function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// One clock for the page, not one interval per card: every countdown already carries its deadline, so the
// tick only repaints the bars that are on screen and a repaint or a board poll never has to drive it.
function tickQuestionClocks() {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-q-clock]")) {
    const deadline = Number(el.dataset.qDeadline) || 0;
    const windowMs = Number(el.dataset.qWindow) || 0;
    if (!deadline || !windowMs) continue;
    const left = deadline - now;
    const pct = Math.max(0, Math.min(100, (left / windowMs) * 100));
    const fill = el.querySelector(".tq-timer > span");
    if (fill) fill.style.width = `${pct.toFixed(2)}%`;
    const label = el.querySelector(".tq-left");
    if (label) label.textContent = left <= 0 ? "time is up" : `~${fmtLeft(left)} left`;
    el.classList.toggle("is-low", pct <= 12);
    el.classList.toggle("is-over", left <= 0);
  }
}

// Once answered the box becomes one line: what the reader said, or the honest other case — the question
// closed without this panel answering it (another surface, a stop, or the clarify timeout).
function questionAnswered(turn) {
  const done = turn.questionDone;
  if (!done || turn.question) return "";
  const text = String(done.answer || "").trim();
  if (!text) return `<div class="turn-question-done mono is-quiet" title="the question was withdrawn with the turn, answered on another surface, or timed out">· question closed without an answer here</div>`;
  return `<div class="turn-question-done mono" title="${esc(text)}">✓ answered: ${esc(text.length > 220 ? `${text.slice(0, 220)}…` : text)}</div>`;
}

// Answer a question a run is parked on. One path for a clicked choice, a typed answer and a multi-select
// batch, so there is exactly one place that posts and one place that reports a refusal.
async function answerRunQuestion(turnId, answer, requestId, box) {
  if (questionSending.has(turnId)) return;
  questionSending.add(turnId);
  const warn = box ? box.querySelector(`[data-qwarn]`) : null;
  const buttons = box ? [...box.querySelectorAll("button.tq-choice, button.tq-send")] : [];
  for (const b of buttons) b.disabled = true;
  try {
    const card = box?.closest(".job");
    const res = await apiFetch("/api/jobs/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: turnId, answer, requestId: requestId || null }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      const text = out.error || `could not answer (HTTP ${res.status})`;
      if (warn) warn.textContent = text;
      else if (card) showBanner(`answer: ${text}`);
      for (const b of buttons) b.disabled = false;
      questionSending.delete(turnId);
      return;
    }
    // The job event that follows clears the box; drop the reader's scratch state with it.
    for (const k of [...questionPicks.keys()]) if (k.startsWith(turnId)) questionPicks.delete(k);
    for (const k of [...questionDrafts.keys()]) if (k.startsWith(turnId)) questionDrafts.delete(k);
  } catch (err) {
    if (warn) warn.textContent = `could not answer: ${err.message}`;
    for (const b of buttons) b.disabled = false;
  } finally {
    questionSending.delete(turnId);
  }
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
  state.turnCompact.delete(key);
  renderConversation(conv.thread);
  // A turn that was just opened should show its newest lines, not its first line.
  if (turnIsOpen(conv, turn, copy)) {
    const pre = document.querySelector(`pre[data-out="${CSS.escape(id)}${copy}"]`);
    if (pre) setScroll(pre, pre.scrollHeight);
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
// A turn the reader did not start: it answers a delivery, and the head should say which. One child names itself;
// several are listed in the tooltip, in the same order the collect prompt numbered them.
function originHtml(turn) {
  const o = turn.origin;
  // A turn the panel assistant caused: it wrote a reply into this thread, or it woke itself about something.
  // Saying so on the turn head is the difference between "the agent suddenly changed course" and a move the
  // reader can trace back to the alert that prompted it.
  if (o && o.kind === "assistant-reply") {
    const how = o.by === "reader" ? "sent from the assistant panel" : "written by the assistant";
    return ` <span class="turn-origin mono" title="${esc(how)}${o.autonomy ? ` · autonomy: ${esc(o.autonomy)}` : ""}">\u21b3 ${esc(o.by === "reader" ? "from the assistant panel" : "from the assistant")}</span>`;
  }
  if (o && o.kind === "assistant-wake") {
    return ` <span class="turn-origin mono" title="${esc(o.reason || "the assistant woke itself")}">\u21b3 assistant woke itself</span>`;
  }
  if (o && o.kind === "assistant-spawn") {
    const where = o.project ? `a worktree cut in ${o.project}` : "a directory that already existed";
    // A SPAWN IN name that had to be resolved to a real tree: the panel says which one it picked here, because
    // a chip that only says "the assistant started this" hides the one fact that was in doubt.
    const fit = o.resolvedPath ? ` — ${o.resolvedFrom} had been renamed, resolved to ${o.resolvedPath} (${o.resolvedHow || "matched"})` : "";
    return ` <span class="turn-origin mono" title="${esc(where)}${esc(fit)}">\u21b3 started by the assistant</span>`;
  }
  if (o && o.kind === "row-refresh") {
    const what = Array.isArray(o.evidence) && o.evidence.length ? o.evidence.join(" · ") : "nothing that moved";
    return ` <span class="turn-origin mono" title="${esc(`started by the ⟳ on this worktree's row to double-check the TODO, the description and the merge state — what it found: ${what}`)}">\u21b3 from the row's ⟳</span>`;
  }
  if (!o || o.kind !== "subagent-delivery") return "";
  const subs = Array.isArray(o.subagents) ? o.subagents : [];
  const one = subs.length === 1 ? subs[0] : null;
  const list = subs.map((s) => `#${s.index} ${s.title || "(untitled)"}`).join("\n");
  const text = one ? `from subagent #${one.index} · ${one.title || "untitled"}` : `from ${subs.length} subagents`;
  const title = subs.length
    ? `this turn was started by the delivery of:\n${list}`
    : "this turn was started by a subagent delivery";
  return ` <span class="turn-origin mono" title="${esc(title)}">\u21b3 ${esc(text)}</span>`;
}

function turnHead(turn, index, open, copy = "", inline = false) {
  // The number the reader counts down the thread. Not `turn.turn`: that counter is trimmed with the store and can
  // repeat (a restarted board showed two "turn 6" and two "turn 7" in one card), while `index` is the turn's place in
  // the clock-ordered list that the pager already counts ("turns 5–7 of 7").
  const label = `turn ${index + 1}`;
  const pinned = state.pinnedTurns.has(turn.id);
  const state_ = turnStateText(turn);
  return `<div class="turn-head mono dimmer" data-turn-head="${esc(turn.id)}" data-toggle-turn="${esc(turnKey(turn, copy))}" title="${open ? "collapse" : "expand"} this turn"><button type="button" class="btn-star${pinned ? " on" : ""}" data-star-turn="${esc(turn.id)}" title="${pinned ? "unpin this turn" : "pin this turn above the paged turns"}">${pinned ? "\u2605" : "\u2606"}</button><span class="chev">${open ? "\u25be" : "\u25b8"}</span> <span class="turn-text">${esc(label)} · ${esc(state_)}</span>${originHtml(turn)}${inlinePrompt(turn, inline)}</div>`;
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
  const running = turnLive(turn);
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

// A compacted turn: what it concluded, and the last tool it used. Thinking blocks and the run of tool calls -
// usually several hundred pixels of scrollback the reader has already read - are dropped, not merely folded.
function compactHtml(turn, copy = "") {
  const lines = jobLines(turn.id).filter((l) => !isBookkeeping(l));
  let lastTool = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const k = lines[i] && lines[i].kind;
    if (k === "tool" || k === "tool-out") {
      lastTool = i;
      break;
    }
  }
  const texts = (from) =>
    lines
      .slice(from)
      .filter((l) => l && l.kind === "text" && String(l.text || "").trim())
      .map((l) => String(l.text).trim());
  // The answer is what it said after its last tool call; a turn that ended on a tool still has words somewhere.
  const said = texts(lastTool + 1);
  const answer = (said.length ? said : texts(0)).join("\n\n");
  const tool = lastTool >= 0 ? lines[lastTool] : null;
  const hidden = lines.filter((l) => l.kind === "tool" || l.kind === "tool-out" || l.kind === "dim").length;
  return `<div class="turn-compact" data-compact-turn="${esc(turn.id)}${esc(copy)}">${
    tool ? `<div class="tc-tool mono" title="${esc(String(tool.text || ""))}">${linkifyText(String(tool.text || ""))}</div>` : ""
  }${answer ? `<div class="tc-answer">${linkifyText(answer)}</div>` : ""}<div class="tc-more dimmer mono">${
    hidden ? `${hidden} tool line${hidden === 1 ? "" : "s"} folded` : "thinking folded"
  } · open for the whole turn</div></div>`;
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
  const running = turnLive(turn);
  const compact = !open && state.turnCompact.has(tkey);
  const cls = `turn${open ? "" : " folded"}${compact ? " compact" : ""}${running ? " is-running" : ""}`;
  if (compact) {
    return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, false, copy, true)}` +
      `${turnAttachmentsHtml(turn)}${compactHtml(turn, copy)}${subagentsCompactHtml(turn, copy)}</div>`;
  }
  if (!open) {
    // Two rows: the head carries the request, the peek carries what the turn is doing or concluded - and a turn that
    // delegated something keeps saying so as it ages up the list, rather than handing its children to the newest turn.
    return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, false, copy, true)}` +
      `${peekHtml(turn)}${turnAttachmentsHtml(turn)}${subagentsCompactHtml(turn, copy)}</div>`;
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

// Files and links are two different things to act on: a file opens in an editor and can be deleted from
// disk, a link opens in the browser and can only be dropped from the list. One button each.
function splitArtifacts(list) {
  return {
    files: list.filter((a) => a.kind !== "url"),
    urls: list.filter((a) => a.kind === "url"),
  };
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

function artifactsPopHtml(thread, list, openAt, kind) {
  const position = openAt ? ` style="left:${openAt.left}px; top:${openAt.top}px"` : "";
  const hidden = openAt ? "" : " hidden";
  const what = kind === "url" ? "link" : "file";
  return `<div class="artifacts-pop" data-artifacts-pop="${esc(thread)}" data-artifacts-kind="${esc(kind)}"${hidden}${position}>
      <div class="ap-head mono dimmer">${list.length} ${what}${list.length === 1 ? "" : "s"} — newest last</div>
      ${artifactRowsHtml(list)}
    </div>`;
}

// Rebuild one popup in place (after a delete, or a confirmation was cancelled) without touching the card.
function renderArtifactsPop(thread) {
  const conv = conversations().find((c) => c.thread === thread);
  if (!conv) return;
  const { files, urls } = splitArtifacts(artifactsFor(conv));
  for (const [kind, list] of [["file", files], ["url", urls]]) {
    const pop = document.querySelector(
      `[data-artifacts-pop="${CSS.escape(thread)}"][data-artifacts-kind="${kind}"]`,
    );
    if (!pop) continue;
    if (!list.length) {
      pop.hidden = true;
      pop.innerHTML = "";
      continue;
    }
    const what = kind === "url" ? "link" : "file";
    pop.innerHTML = `<div class="ap-head mono dimmer">${list.length} ${what}${list.length === 1 ? "" : "s"} — newest last</div>${artifactRowsHtml(list)}`;
  }
  // The buttons carry the counts, so the card itself has to be redrawn for them to move down.
  renderConversation(thread);
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

// Token counts on a turn line, in three significant digits: 636,816 reads "636k tok", not "636816 tok".
// Truncated, not rounded - 636,816 rounded to three places is 637k, which claims a figure the count does not
// have, and these numbers only ever grow, so a turn that read 636k can never appear to fall back to 635k.
function fmtTok(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs < 1e3) return String(Math.round(v));
  const unit = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : [1e3, "k"];
  const digits = abs / unit[0];
  const places = digits >= 100 ? 0 : digits >= 10 ? 1 : 2;
  const cut = Math.floor(digits * 10 ** places) / 10 ** places;
  const text = cut
    .toFixed(places)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return `${v < 0 ? "-" : ""}${text}${unit[1]}`;
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

// Double-click opens the picker; a single click does nothing, so a stray click on the readout cannot change a model.
function modelSegHtml(model, thread) {
  return `<button type="button" class="stat stat-model${thread ? "" : " is-static"}"${thread ? ` data-model-pick="${esc(thread)}"` : ""} title="${esc(model)} — double-click to pick the model this session runs with">${esc(String(model).split("/").pop())}</button>`;
}

function statsRowHtml(latest, thread) {
  const model = latest.effectiveModel || latest.model || modelsState?.defaultModel || null;
  if (!latest.stats && !model) return "";
  return `<div class="job-stats-row">${statsLine(latest.stats, model, thread, latest.contextLimit || null)}</div>`;
}

// Where this session is against the ceiling the reader picked (or the model's own window when there is none).
// Double-click opens the picker, exactly like the model beside it.
function contextSegHtml(stats, thread, contextLimit) {
  const used = Number.isFinite(stats.context_used) ? fmtTokens(stats.context_used) : null;
  const window = Number.isFinite(stats.context_max) && stats.context_max > 0 ? stats.context_max : null;
  const ceiling = contextLimit && window ? Math.min(contextLimit, window) : contextLimit || window;
  if (!ceiling) return "";
  const over = Number.isFinite(stats.context_used) && stats.context_used > ceiling;
  const shown = used ? `${used}/${fmtTokens(ceiling)}` : `ctx ${fmtTokens(ceiling)}`;
  const why = contextLimit
    ? `this card measures its context against ${fmtTokens(contextLimit)}${window ? ` (the model's own window is ${fmtTokens(window)})` : ""} — click to cycle through the sizes, right-click for the full list`
    : `the model's context window${window ? ` (${fmtTokens(window)})` : ""} — click to cycle through the sizes, right-click for the full list`;
  return `<button type="button" class="stat stat-ctx${over ? " is-over" : ""}" data-context-pick="${esc(thread)}" title="${esc(why)}">${esc(shown)}<span class="stat-caret">\u2304</span></button>`;
}

// Dollars, at the size they actually come in. A session often costs well under a cent, and "$0.00" for a
// session that did cost something reads as free: anything under a cent is shown as such. Above a thousand the
// cents stop meaning anything and the figure is rounded with its thousands separated.
function fmtUsd(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

// What this session has spent, in tokens and in dollars — the session's own cumulative totals, which is not
// the same thing as how full its context is. The context bar beside this legitimately falls when the
// transcript is compacted; these two must not, so they are read from the store's cumulative counters and are
// never derived from the context figure. The `~` is this readout's own mark for an estimate (the panel's
// cached prices, or the gateway's own estimate); without it the figure is what was actually billed.
function usageSegHtml(stats) {
  const hasIn = Number.isFinite(stats.input_tokens);
  const hasOut = Number.isFinite(stats.output_tokens);
  if (!hasIn && !hasOut) return "";
  const tokens = `\u2211 ${fmtTok(stats.input_tokens || 0)} in / ${fmtTok(stats.output_tokens || 0)} out`;
  const money = Number.isFinite(stats.cost_usd) ? `${stats.cost_estimated ? "~" : ""}${fmtUsd(stats.cost_usd)}` : "";
  const why = [
    `${tokens} is this session's cumulative token total — every call's share added up, not how full the context is now` +
      (stats.cache_read_tokens ? `, and ${fmtTok(stats.cache_read_tokens)} prompt tokens were read back from the prompt cache besides` : "") +
      ` — so it keeps rising when the transcript is compressed and is the same figure after a panel restart`,
    money ? `${money} is what this session has cost: ${stats.cost_note || "priced from the store"}` : stats.cost_note || "",
    stats.cost_other_usd
      ? `${fmtUsd(stats.cost_other_usd)} more has gone on this session's own background review, compaction and approvals — recorded by the store separately, and not part of the counts above`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `<span class="stat stat-usage" title="${esc(why)}">${esc(money ? `${tokens} \u00b7 ${money}` : tokens)}</span>`;
}

function statsLine(stats, model = null, thread = "", contextLimit = null) {
  // The model is a control even when there are no numbers to put beside it: it is the one place a session's model can
  // be changed, and a card whose run left no usage still needs to say (and offer) it.
  if (!stats || typeof stats !== "object") {
    const bits = [model ? modelSegHtml(model, thread) : "", contextLimit ? contextSegHtml({}, thread, contextLimit) : ""].filter(Boolean);
    return bits.length ? `<span class="job-stats mono">${bits.join(" · ")}</span>` : "";
  }
  const segs = [];
  const window = Number.isFinite(stats.context_max) && stats.context_max > 0 ? stats.context_max : null;
  const ceiling = contextLimit && window ? Math.min(contextLimit, window) : contextLimit || window;
  const pct =
    ceiling && Number.isFinite(stats.context_used) ? (stats.context_used / ceiling) * 100 : Number.isFinite(stats.context_percent) ? stats.context_percent : null;
  const mark = stats.context_estimated ? "~" : "";
  const known = Number.isFinite(stats.context_used) && Number.isFinite(stats.context_max) && stats.context_max > 0;
  // Kept out of `segs`: that list is escaped when it is joined, and this one is markup (a button).
  const ctxSeg = known ? contextSegHtml(stats, thread, contextLimit) : "";
  // The bar itself is held apart from the rest of `segs` so the session's cumulative counts can sit directly
  // beside it — the pair reads as "how full the context is now, and how much has gone through it altogether".
  let bar = "";
  if (known) {
    if (pct !== null) bar = `${contextBar(pct)} ${mark}${Math.round(pct)}%`;
  } else if (pct !== null) {
    bar = `${mark}${Math.round(pct)}%`;
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
  const usageSeg = usageSegHtml(stats);
  if (!segs.length && !bar && !usageSeg) return "";
  // The model leads the line: these figures describe what that model did, and the id's owner prefix is
  // dropped for width (the full id stays in the tooltip).
  const modelSeg = model ? modelSegHtml(model, thread) : "";
  const title =
    "this session's usage: context occupancy, prompt-cache hit rate, and \u21ca = how many times the transcript was compacted into a summary; " +
    "latency and t/s are estimated from the turn's wall clock (~). \u2211 in / out are this session's cumulative token totals — not the current context occupancy — so they keep rising when the transcript is compacted; " +
    "the dollar figure beside them is what the session has cost, and a ~ in front of it means an estimate (hover it to see which price it came from)";
  const body = [modelSeg, ctxSeg, bar ? `<span class="stat">${esc(bar)}</span>` : "", usageSeg, segs.map((s) => `<span class="stat">${esc(s)}</span>`).join('<span class="stat-sep">\u2502</span>')]
    .filter(Boolean)
    .join('<span class="stat-sep">\u2502</span>');
  // A span, not a div: the readout belongs on the footer line with the outcome and the token count,
  // to their right, and a block element there costs a line of card height for nothing.
  return `<span class="job-stats mono" title="${esc(title)}">${body}</span>`;
}

// ---- picking a session's model -----------------------------------------------------------------
// Double-click the model on a card: a search-as-you-type list of everything the provider advertises, with the
// session's current choice marked. The pick is stored per thread (beside the labels) and the next turn uses it.
let modelPop = null;
// What the open popover belongs to, so a repaint can put it back under the same control instead of closing it.
// A refresh moves the card's DOM around; the reader's picker has no business disappearing because of that.
let modelPopTarget = null;
// The control the reader opened the list from. Kept by reference: a card can be repainted under the popup, and
// re-finding it by attribute name is how the list once anchored itself to a different copy of the label.
let modelPopAnchorEl = null;

function closeModelPop() {
  modelPop?.remove();
  modelPop = null;
  modelPopTarget = null;
  modelPopAnchorEl = null;
}

// The readout the context popup belongs to. The model picker no longer comes through here: it is
// core/model-menu.js's portal, which tracks its own trigger.
function popAnchor(thread) {
  if (!thread) return null;
  if (modelPopAnchorEl && modelPopAnchorEl.isConnected) return modelPopAnchorEl;
  return document.querySelector(`[data-context-pick="${CSS.escape(thread)}"]`);
}

// Put the panel under whatever the reader double-clicked, clamped to the window. Called after opening and again
// after every repaint that could have moved the control.
function positionModelPop() {
  if (!modelPop || !modelPopTarget) return true;
  const btn = popAnchor(modelPopTarget.thread);
  if (!btn || !btn.isConnected) {
    closeModelPop();
    return false;
  }
  const r = btn.getBoundingClientRect();
  // Gone from the page, or scrolled out of it: there is nothing left to point at.
  if ((r.width === 0 && r.height === 0) || r.bottom < 0 || r.top > window.innerHeight) {
    closeModelPop();
    return false;
  }
  const gap = 4;
  const margin = 8;
  const width = modelPop.offsetWidth || 360;
  const natural = 320; // the height the list wants
  const below = window.innerHeight - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  // Below the label when there is a usable list down there; otherwise above it, with the list above the search
  // bar (column-reverse) so the box the reader types in stays right where the label is. The panel never floats
  // away from the control it belongs to; it shrinks instead.
  const flip = below < Math.min(natural, 160) && above > below;
  modelPop.classList.toggle("is-flipped", flip);
  modelPop.style.left = `${Math.max(margin, Math.min(window.innerWidth - width - margin, r.left))}px`;
  if (flip) {
    modelPop.style.top = "auto";
    modelPop.style.bottom = `${window.innerHeight - r.top + gap}px`;
    modelPop.style.maxHeight = `${Math.max(160, Math.min(natural, above))}px`;
  } else {
    modelPop.style.bottom = "auto";
    modelPop.style.top = `${r.bottom + gap}px`;
    modelPop.style.maxHeight = `${Math.max(160, Math.min(natural, below))}px`;
  }
  return true;
}

// The list is core/model-menu.js's, over the one price table /api/models serves. Nothing here reads a
// price file of its own: a second copy of the table is how two pickers start quoting different numbers.

// The readout opens THE picker, not a copy of it: same rows in the same order, same prices, same rating,
// same search and keyboard — and a pick is what pickModel already stored. A session whose model has left
// the catalogue still gets its row, checked, so the list never reads "nothing is chosen" while one is.
function openModelPop(thread, anchor) {
  // The context ceiling and the model list are two popovers on the same readout; opening one closes the other.
  closeModelPop();
  const current = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread)?.effectiveModel || "";
  const extra = current ? [{ id: current, name: `${current} (not in the catalogue)` }] : [];
  ModelMenu.open(anchor, {
    rows: ModelMenu.rowsFor(modelsState, { extra }),
    value: current,
    onPick: (id) => void pickModel(thread, id),
  });
}

// ---- the context ceiling ----------------------------------------------------------------------
// Same shape as the model picker: double-click, type or pick, Enter puts the readout back. The numbers are real
// sizes (the model's window is known from the provider catalogue), the ceiling is what this card measures against.
function parseContextSize(text) {
  const s = String(text ?? "").trim().toLowerCase().replace(/[,_\s]/g, "");
  if (!s || ["full", "default", "auto", "model", "window", "reset"].includes(s)) return 1;
  const m = s.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!m) return NaN;
  const n = Number(m[1]) * (m[2] === "k" ? 1000 : m[2] === "m" ? 1e6 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : NaN;
}

function contextTiers(window) {
  const w = Number(window) > 0 ? Number(window) : null;
  const sizes = new Set();
  if (w) for (const f of [1, 0.75, 0.5, 0.25]) sizes.add(Math.round(w * f));
  for (const n of [1000000, 400000, 200000, 128000]) if (!w || n <= w) sizes.add(n);
  const list = [...sizes].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => b - a);
  return list.map((n) => ({
    value: n,
    label: `${fmtTokens(n)}${w && n === w ? " · the model's window" : w ? ` · ${Math.round((n / w) * 100)}% of the window` : ""}`,
    full: Boolean(w && n === w),
  }));
}

// The sizes this session can be measured against, biggest first: the model's own window, then the usual
// fractions of it, then the round sizes that are not fractions of anything. Clicking the readout walks this
// list, which is the whole setting for most readers - the full picker (with a typed size) is a right-click away.
function contextTierValues(window) {
  return contextTiers(window).map((t) => t.value);
}

async function cycleContext(thread) {
  const latest = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread) || {};
  const model = latest.effectiveModel || latest.model || modelsState?.defaultModel || null;
  const win = Number(latest.stats?.context_max) > 0 ? Number(latest.stats.context_max) : modelsState?.contexts?.[model] || null;
  const tiers = contextTierValues(win);
  if (!tiers.length) return;
  const full = win || tiers[0];
  const current = Number(latest.contextLimit) > 0 ? Number(latest.contextLimit) : full;
  // A stored size that is not in the ladder (typed by hand) steps to the next smaller tier rather than
  // jumping back to the top.
  const at = tiers.indexOf(current);
  const next = at === -1 ? tiers.find((n) => n < current) || tiers[0] : tiers[(at + 1) % tiers.length];
  await pickContext(thread, next === full ? 0 : next);
}

function openContextPop(thread, anchor) {
  closeModelPop();
  modelPopAnchorEl = anchor || null;
  const latest = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread) || {};
  const model = latest.effectiveModel || latest.model || modelsState?.defaultModel || null;
  const win = Number(latest.stats?.context_max) > 0 ? Number(latest.stats.context_max) : modelsState?.contexts?.[model] || null;
  const current = latest.contextLimit || win || null;
  const pop = document.createElement("div");
  pop.className = "model-pop ctx-pop";
  pop.innerHTML = `<input class="model-search mono" data-1p-ignore autocomplete="off" spellcheck="false"
      placeholder="ceiling: 200k, 1m, blank = the model's window" />
    <div class="model-list mono"></div>`;
  document.body.appendChild(pop);
  modelPop = pop;
  modelPopTarget = { kind: "context", thread };
  positionModelPop();
  positionModelPop();
  const input = pop.querySelector(".model-search");
  const list = pop.querySelector(".model-list");
  list.innerHTML =
    `<div class="model-hint dimmer">${win ? `this model's window: ${esc(fmtTokens(win))}` : "the model's window is unknown for this id"}</div>` +
    contextTiers(win)
      .map(
        (t) =>
          `<button type="button" class="model-item${t.value === current ? " is-current" : ""}" data-context="${t.value}" title="measure this session against ${fmtTokens(t.value)}">${esc(t.label)}${t.value === current ? " ✓" : ""}</button>`,
      )
      .join("") +
    `<button type="button" class="model-item" data-context="0" title="go back to the model's own window">blank · no ceiling</button>`;
  input.value = current ? fmtTokens(current) : "";
  input.select();

  const apply = (rawText) => {
    const n = parseContextSize(rawText);
    if (!Number.isFinite(n)) return; // unreadable: leave the box alone rather than guess a size
    void pickContext(thread, n === 1 ? 0 : n);
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeModelPop();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      apply(input.value);
    }
  });
  list.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-context]");
    if (b) void pickContext(thread, Number(b.dataset.context));
  });
  input.focus();
}

async function pickContext(thread, limit) {
  closeModelPop();
  try {
    const r = await apiFetch("/api/threads/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread, limit }),
    });
    if (!r.ok) return;
    const d = await r.json();
    for (const j of state.jobs.values()) {
      if ((j.thread || j.id) !== thread) continue;
      j.contextLimit = d.limit || null;
    }
    renderConversation(thread);
    showBanner(d.limit ? `this session measures its context against ${fmtTokens(d.limit)}` : "this session is back on the model's own context window");
  } catch {
    /* a pick that cannot be stored leaves the readout as it was */
  }
}

async function pickModel(thread, model) {
  closeModelPop();
  try {
    const r = await apiFetch("/api/threads/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread, model }),
    });
    if (!r.ok) return;
    const d = await r.json();
    // The card says the model that will run next; the server is the record, this only spares a round trip.
    for (const j of state.jobs.values()) {
      if ((j.thread || j.id) !== thread) continue;
      j.effectiveModel = d.model || j.model || null;
    }
    renderConversation(thread);
    showBanner(d.model ? `this session runs ${d.model} from its next turn` : "this session is back on the gateway's default model");
  } catch {
    /* a pick that cannot be stored leaves the label as it was */
  }
}

// A failed turn can be asked again, but it is not a "retry" in the strict sense: the run is over, and re-sending
// the prompt starts a NEW turn in the same thread. The button says so in its tooltip rather than pretending the
// failed one will resume.
function turnRetryHtml(latest, thread) {
  if (!latest?.error || !retryableError(latest.error)) return "";
  if (turnLive(latest)) return "";
  return ` <button type="button" class="btn-retry" data-retry-turn="${esc(thread)}" title="send this turn's prompt again as a NEW turn — the failed turn's edits are already on disk">retry</button>`;
}

// ---- subagents ------------------------------------------------------------------------------
// A run's own stream announces each delegated child twice - subagent.start and subagent.complete - and that is the
// live signal. The gateway's durable admission path does not relay those at all, so the panel also reads the store:
// a subagent is a `sessions` row with source='subagent' and the parent thread in parent_session_id. One roster
// query covers every card, which matters because a child can still be working after the turn that started it has
// finished - exactly when a reader most wants to know.
const subagentFallback = new Map(); // thread -> rows
const subagentLive = new Map(); // thread -> how many of those rows were running at the last poll
let subagentRosterAt = 0;

function fmtSeconds(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`;
}

// A child's own console, drawn in the card's transcript idiom. The panel cannot stream a child (its tools run on its
// own session), so this is a read of its messages - a poll while it is open and the child is still out.
function subConsoleHtml(id) {
  const c = state.subConsoles.get(id);
  if (!c || c.loading) return `<pre class="sub-console mono jl-dim">reading this subagent…</pre>`;
  if (!c.lines.length) return `<pre class="sub-console mono jl-dim">nothing on its console yet</pre>`;
  // The child's transcript is condensed exactly like a turn's: a run of tool calls is one row per tool with a tally,
  // the rest is its text. Same components, so the two consoles behave the same way.
  const body = burstGroups(c.lines)
    .map((item, gi) => (item.group ? toolGroupHtml(item.lines, `${id}#${gi}`, "", false, "", null, toolGroupsOn() ? {} : { flat: true }) : lineHtml(item.line)))
    .join("");
  return `<pre class="sub-console mono" data-sub-console-box="${esc(id)}">${body}</pre>`;
}

function subagentsHtml(list, key = "", collected = false) {
  const subs = Array.isArray(list) ? list : [];
  if (!subs.length) return "";
  const running = subs.filter((s) => s.running).length;
  const collapsed = state.collapsedSubs.has(key);
  const head = `\u29c9 ${subs.length} subagent${subs.length === 1 ? "" : "s"} \u00b7 ${running ? `${running} running` : "all done"}`;
  const collect =
    running > 0
      ? ""
      : collected
        ? ` <span class="subs-collected mono" title="these results were already sent back to this turn">\u2713 collected</span>`
        : ` <button type="button" class="subs-collect" data-subs-collect="${esc(key)}" title="send this turn's agent one more turn with what these subagents produced, so it can aggregate them">collect</button>`;
  const rows = subs
    .map((s) => {
      const id = s.id || "";
      const open = Boolean(id) && state.openSubConsole.has(id);
      const quiet = s.running && s.hung ? Math.max(0, (Date.now() - (s.lastSeen || Date.now())) / 1000) : 0;
      // A running child counts its own clock, the way the card's turn head does: the status stays where "done" sits,
      // and the time it has been out follows it. The number is a span so the 1s tick can advance it without a
      // repaint of the row (a repaint is what used to make these lines unreadable while they moved).
      const started = Number(s.startedAt) || 0;
      const elapsedSpan = started
        ? ` · <span data-sub-elapsed="${started}">${esc(fmtSeconds((Date.now() - started) / 1000))}</span>`
        : "";
      const meta = s.running
        ? quiet
          ? `no activity ${fmtSeconds(quiet)}`
          : `running${elapsedSpan}`
        : `${esc(s.status || "done")}${s.duration ? ` · ${fmtSeconds(s.duration)}` : ""}`;
      return `<div class="sub-row${s.running ? " is-running" : ""}${s.hung ? " is-hung" : ""}${open ? " is-open" : ""}"${id ? ` role="button" tabindex="0" data-sub-console="${esc(id)}" title="${esc(quiet ? `${s.goal || "subagent"} — nothing written for ${fmtSeconds(quiet)}, possibly hung` : `${s.goal || "subagent"} — click for its console`)}"` : ""}>
      <span class="sub-caret sub-chev">${id ? (open ? "\u25be" : "\u25b8") : ""}</span>
      <span class="sub-dot"></span>
      <span class="sub-title">${esc(s.goal || "subagent")}</span>
      <span class="sub-meta mono">${meta}</span>
      ${s.running && !open && s.preview ? `<span class="sub-preview mono" title="${esc(s.preview)}">${esc(s.preview)}</span>` : ""}
    </div>${open ? subConsoleHtml(id) : ""}`;
    })
    .join("");
  return `<div class="subagents mono${running ? "" : " is-done"}${collapsed ? " is-collapsed" : ""}" data-subs-turn="${esc(key)}">
    <span class="sub-head" role="button" tabindex="0" data-subs-toggle="${esc(key)}" title="agents this run delegated. Their tools run on their own sessions, so only their start and finish reach this card. click a line for its console; click this line to ${collapsed ? "show" : "hide"} them."><span class="sub-chev">${collapsed ? "\u25b8" : "\u25be"}</span> ${esc(head)}${collect}</span>
    ${rows}
  </div>`;
}

// ---- subagents: attribution (pure, so tools/verify-subagent-turns.mjs can run it) --------------
// A child's clock, and the turn it belongs to. A turn's window is its own run, and it stops when the next turn on
// the thread began: an interrupted turn never writes an endedAt, and reading that as "still open until now" let the
// card's first turn own every child a later turn delegated - five reviewers filed under the turn that only renamed
// a branch.
const CHILD_SLACK_MS = 3000;

function turnWindow(turn, next) {
  const from = Date.parse(turn.startedAt || "") || 0;
  const ended = Date.parse(turn.endedAt || "") || 0;
  const nextFrom = next ? Date.parse(next.startedAt || "") || 0 : 0;
  let to = ended || Infinity;
  if (nextFrom) to = Math.min(to, nextFrom);
  return { id: turn.id, from, to };
}

// turn id -> the rows that started while it was running. The stream knows exactly (they are on the job); the store
// only knows the parent thread, so it goes by the clock.
function childOwner(children, turns) {
  const ordered = [...turns].sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  const windows = ordered.map((t, i) => turnWindow(t, ordered[i + 1]));
  const owners = new Map();
  for (const child of children) {
    const at = Number(child.startedAt) || 0;
    if (!at) continue;
    // The window that holds the moment it started, taken as the newest such window: with a turn that never ended,
    // the newest match is the one that was actually running.
    let owner = null;
    for (const w of windows) if (at >= w.from - CHILD_SLACK_MS && at <= w.to + CHILD_SLACK_MS) owner = w;
    // ...or, for a child that started after its turn had finished, the last turn that had begun by then. A child
    // never belongs to a turn that had not started yet, which is what put every old child under the newest console.
    if (!owner) for (const w of windows) if (w.from <= at) owner = w;
    if (!owner) owner = windows[0];
    if (!owner) continue;
    const rows = owners.get(owner.id) || [];
    rows.push(child);
    owners.set(owner.id, rows);
  }
  return owners;
}
// ---- end attribution ---------------------------------------------------------------------------

// Which children this turn spawned, as one list in the order they started.
function subagentsForTurn(turn) {
  if (Array.isArray(turn.subagents) && turn.subagents.length) return turn.subagents;
  const thread = turn.thread || turn.id;
  const all = subagentFallback.get(thread) || [];
  if (!all.length) return [];
  const turns = [...state.jobs.values()].filter((j) => (j.thread || j.id) === thread);
  if (!turns.length) return [];
  return childOwner(all, turns).get(turn.id) || [];
}

// This turn's own window as a pair of epoch ms, so a store query (a collect, a thought read) stops where the turn
// did instead of sweeping in everything that came after it.
function turnBounds(turn) {
  const thread = turn.thread || turn.id;
  const turns = [...state.jobs.values()]
    .filter((j) => (j.thread || j.id) === thread)
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  const i = turns.findIndex((t) => t.id === turn.id);
  const w = turnWindow(turn, i >= 0 ? turns[i + 1] : null);
  return { from: w.from, to: Number.isFinite(w.to) ? w.to : Date.now() };
}

// Under the console of the turn that delegated: while a child is out, and while the turn itself is still going, so
// a finished child does not vanish mid-turn without a trace. A finished turn with finished children keeps nothing.
function turnSubagentsHtml(turn, copy = "") {
  const key = turnKey(turn, copy);
  const rows = subagentsForTurn(turn);
  if (!rows.length) return `<div class="subagents mono" data-subs-turn="${esc(key)}" hidden></div>`;
  // A finished set stays on the card, greyed: the work it did is part of the turn, and its console is still worth
  // opening. The header collapses it away for anyone who does not want it.
  return subagentsHtml(rows, key, Boolean(turn.collected));
}

// On a folded turn the strip shrinks to its tally: enough to say "this is where the agents came from" without
// reopening a transcript to show one line.
function subagentsCompactHtml(turn, copy = "") {
  const key = turnKey(turn, copy);
  const rows = subagentsForTurn(turn);
  if (!rows.length) return "";
  const live = rows.filter((r) => r.running).length;
  const cls = live ? "" : " is-done";
  return `<div class="subagents mono is-compact${cls}" data-subs-compact="${esc(key)}">\u29c9 ${rows.length} subagent${rows.length === 1 ? "" : "s"} \u00b7 ${live ? `${live} running` : "all done"}</div>`;
}

// ---- collecting results ---------------------------------------------------------------------
// Hermes joins a delegation and re-enters the parent with the results, but only while that parent is live. A one-shot
// run ends with its turn and its children finish into nothing, so the panel hands the parent the results itself, as
// one more turn on the same thread. Once per turn, and (by default) only when the parent left before its children.
const AUTO_COLLECT_KEY = "wtgui.autoCollect";
state.collecting = state.collecting || new Set();

function autoCollectOn() {
  try {
    return localStorage.getItem(AUTO_COLLECT_KEY) !== "0";
  } catch {
    return true;
  }
}

function collectedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wtgui.collected") || "[]"));
  } catch {
    return new Set();
  }
}

function markCollected(id) {
  try {
    const ids = [...collectedIds()].slice(-80);
    ids.push(id);
    localStorage.setItem("wtgui.collected", JSON.stringify(ids));
  } catch {
    /* private mode: it may collect twice after a reload, nothing worse */
  }
}

async function collectThread(turn) {
  const thread = turn?.thread || turn?.id;
  if (!thread || !turn?.id || turn.collected || state.collecting.has(turn.id) || collectedIds().has(turn.id)) return;
  // One turn per session at a time: a delivery must not race a turn that is already running.
  if ([...state.jobs.values()].some((j) => (j.thread || j.id) === thread && (turnLive(j)))) return;
  state.collecting.add(turn.id);
  try {
    // This turn's own window: an interrupted turn has no endedAt, and "to now" would hand the parent the children
    // of every turn that came after it.
    const { from, to } = turnBounds(turn);
    const r = await apiFetch(
      `/api/subagents/collect?thread=${encodeURIComponent(thread)}&from=${from}&to=${to}`,
    );
    if (!r.ok) return;
    const d = await r.json();
    if (!d.prompt) return;
    const sent = await apiFetch("/api/agents/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread,
        text: d.prompt,
        origin: {
          kind: "subagent-delivery",
          fromTurn: turn.id,
          subagents: (d.items || []).map((it, i) => ({ index: i + 1, id: it.id, title: it.goal })),
        },
      }),
    });
    if (!sent.ok) return;
    markCollected(turn.id);
    showBanner(`collecting ${d.items.length} subagent result${d.items.length === 1 ? "" : "s"} into a new turn`);
  } catch {
    /* a failed collect is not worth a banner: the button is still there */
  } finally {
    state.collecting.delete(turn.id);
  }
}

// The parent left early: its turn ended before the children it started, so nobody was there to receive them.
function parentLeftEarly(turn, rows) {
  if (!rows.length || rows.some((r) => r.running)) return false;
  const ended = Date.parse(turn.endedAt || "") || 0;
  if (!ended) return false;
  const lastChild = Math.max(...rows.map((r) => r.endedAt || 0));
  return lastChild - ended > 1500;
}

function subagentsSig(rows) {
  return rows.map((r) => `${r.goal}:${r.running ? 1 : 0}`).join("|");
}

// What THIS strip draws from the board's state: which of its OWN children are open, and how many reads of each have
// landed. The signature used to carry `[...state.openSubConsole]` and a page-global version counter, so one child's
// poll changed every session's strip and rebuilt strips that had not changed at all - and a rebuilt strip is a new
// scroll box at its first line under a console somebody is reading. A read is this strip's business only when the
// child it belongs to is in this strip.
function subagentsOpenSig(rows) {
  return rows
    .filter((r) => r.id && state.openSubConsole.has(r.id))
    .map((r) => `${r.id}@${state.subConsoleReads.get(r.id) || 0}`)
    .join(",");
}

// The whole signature one strip is compared against: its rows, its own open children's read counts, its own fold.
function subagentsStripSig(rows, key) {
  return `${subagentsSig(rows)}|${subagentsOpenSig(rows)}|${state.collapsedSubs.has(key) ? "c" : "e"}`;
}

// Repaint every strip already on the page, in place: a roster poll must not re-render cards (that would move the
// reader's scroll) and must not need a card to be re-rendered before it can show a child.
function paintSubagents() {
  for (const job of state.jobs.values()) {
    const key = job.id;
    const rows = subagentsForTurn(job);
    const compact = document.querySelector(`[data-subs-compact="${CSS.escape(key)}"]`);
    // A folded turn carries the tally only; it has no rows to paint, but the count still has to move.
    if (compact) {
      if (!rows.length) {
        compact.remove();
        continue;
      }
      const live = rows.filter((r) => r.running).length;
      compact.innerHTML = `\u29c9 ${rows.length} subagent${rows.length === 1 ? "" : "s"} \u00b7 ${live ? `${live} running` : "all done"}`;
      compact.classList.toggle("is-done", live === 0);
      continue;
    }
    const box = document.querySelector(`[data-subs-turn="${CSS.escape(key)}"]`);
    if (!box) continue;
    if (!rows.length) {
      if (!box.hidden) {
        box.hidden = true;
        box.innerHTML = "";
        delete box.dataset.sig;
      }
      continue;
    }
    const sig = subagentsStripSig(rows, key);
    if (!box.hidden && box.dataset.sig === sig) continue;
    box.outerHTML = subagentsHtml(rows, key, Boolean(job.collected));
    const fresh = document.querySelector(`[data-subs-turn="${CSS.escape(key)}"]`);
    if (fresh) {
      fresh.dataset.sig = sig;
      // The repaint replaced this strip's nodes, so an open child console inside it is a fresh box at its first line.
      // Put it back where the reader had it in this same task, before a frame can paint it at the top.
      applySubConsoleScrolls(fresh);
    }
  }
}


async function refreshSubagentRoster() {
  if (document.hidden) return;
  let roster = null;
  try {
    const r = await apiFetch("/api/subagents");
    if (!r.ok) return;
    roster = (await r.json()).roster || {};
  } catch {
    return;
  }
  subagentFallback.clear();
  for (const [thread, rows] of Object.entries(roster)) {
    subagentFallback.set(thread, rows.map((k) => ({
      id: k.id,
      goal: k.title,
      running: k.running,
      status: k.running ? "running" : "done",
      duration: null,
      startedAt: k.startedAt,
      endedAt: k.endedAt,
      lastSeen: k.lastSeen,
      hung: Boolean(k.hung),
      msgs: k.msgs,
      // A folded row says what the child is doing, not just that it is out.
      preview: k.preview || null,
    })));
  }
  subagentRosterAt = Date.now();
  paintSubagents();
  // Children that have just finished are the moment a held reply can go: drain anything queued on a thread that
  // is no longer waiting for them (drainReplyQueue checks both the turn and the children).
  for (const thread of new Set([...subagentFallback.keys(), ...state.replyQueue.keys()])) {
    if (!childrenOut(thread)) void drainReplyQueue(thread);
  }
  // The card's own pill says RUNNING while a child is out, so a flip in that answer is a card repaint, not just a
  // strip repaint. Only on a flip: re-rendering every card every 5s would fight the reader's scroll.
  for (const thread of new Set([...subagentLive.keys(), ...subagentFallback.keys()])) {
    const was = (subagentLive.get(thread) || 0) > 0;
    const now = (subagentFallback.get(thread) || []).some((s) => s.running);
    if (was !== now) renderConversation(thread);
  }
  subagentLive.clear();
  for (const thread of subagentFallback.keys()) {
    subagentLive.set(thread, subagentFallback.get(thread).filter((s) => s.running).length);
  }
  // An open console of a child that is still working has to keep moving; a finished one is a record.
  const liveOpen = [...state.openSubConsole].filter((id) => state.subConsoles.get(id)?.running);
  for (const id of liveOpen) void loadSubConsole(id);
  // ...and once the children are all back, give the parent what it never got.
  if (autoCollectOn()) {
    for (const job of state.jobs.values()) {
      const rows = subagentsForTurn(job);
      if (!job.collected && parentLeftEarly(job, rows)) void collectThread(job);
    }
  }
}

// Which subagent lines are expanded, and their console text. Kept here so a roster repaint (which rebuilds the strip)
// does not close what the reader opened.
state.openSubConsole = state.openSubConsole || new Set();
state.collapsedSubs = state.collapsedSubs || new Set();
state.subConsoles = state.subConsoles || new Map();
// How many reads of each child's console have landed, by child id: a strip's signature carries only its own
// children's counts, so a poll of one child cannot rebuild another session's strip.
state.subConsoleReads = state.subConsoleReads || new Map();
// The line the reader left each child console on, by child id. A strip repaint or a card rebuild replaces the node,
// so the position cannot ride on the element the way holdScrolls() carries it.
state.subConsoleTop = state.subConsoleTop || new Map();

function bumpSubRead(id) {
  state.subConsoleReads.set(id, (state.subConsoleReads.get(id) || 0) + 1);
}

async function loadSubConsole(id) {
  let entry = { lines: [], running: true, loading: false };
  try {
    const r = await apiFetch(`/api/subagents/console?session=${encodeURIComponent(id)}`);
    if (r.ok) {
      const d = await r.json();
      entry = { lines: Array.isArray(d.lines) ? d.lines : [], running: Boolean(d.running), loading: false };
    } else {
      entry.lines = [{ kind: "dim", text: "could not read this subagent's session" }];
    }
  } catch {
    entry.lines = [{ kind: "dim", text: "could not read this subagent's session" }];
  }
  state.subConsoles.set(id, entry);
  bumpSubRead(id);
  paintSubagents();
}

function toggleSubs(key) {
  if (!key) return;
  if (state.collapsedSubs.has(key)) state.collapsedSubs.delete(key);
  else state.collapsedSubs.add(key);
  paintSubagents();
}

async function toggleSubConsole(id) {
  if (!id) return;
  if (state.openSubConsole.has(id)) {
    state.openSubConsole.delete(id);
    state.subConsoles.delete(id);
  } else {
    state.openSubConsole.add(id);
    state.subConsoles.set(id, { lines: [], running: true, loading: true });
    bumpSubRead(id);
    paintSubagents();
    await loadSubConsole(id);
    return;
  }
  paintSubagents();
}

// 5s: one small request for the whole board, and well inside the time it takes to read a card.
setInterval(refreshSubagentRoster, 5000);

// A card with thinking on reads its turns from the store: once for a finished turn, and again every few seconds while
// one is still running (the store is the only live source - the stream's copy is a preview, and not delivered here).
function sweepThinking() {
  for (const card of document.querySelectorAll(".job[data-thread]")) {
    const thread = card.dataset.thread;
    // A card drawn as ONE stream wants the blocks too: they are lines of its console, not a block above it.
    if (!thread || (!thinkingOn(thread) && !streamOn(thread))) continue;
    const conv = conversations().find((c) => c.thread === thread);
    if (!conv) continue;
    for (const turn of conv.turns) {
      const entry = state.thinkCache.get(turn.id);
      const live = turnLive(turn);
      if (!entry || (live && Date.now() - (entry.at || 0) > 2000)) void loadThinking(turn, "");
      // A block that was open because its turn was running folds once it is not - unless the reader opened it.
      if (!live) {
        const key = turnKey(turn, "");
        const el = document.querySelector(`details.think[data-think-turn="${CSS.escape(key)}"]`);
        if (el && el.open && !thinkOpenFor(turn, key)) {
          thinkAutoOpened.add(el);
          el.open = false;
        }
      }
    }
  }
}
setInterval(sweepThinking, 1200);

// The block's own open/closed state belongs to the reader; a repaint puts it back.
// `thinkAutoOpened` is armed two ways, and both are "the panel did it, not the reader": right before a script-fired
// `el.open = ...` (sweepThinking's fold), and when a `<details open>` is INSERTED — an inserted open details fires a
// toggle of its own (see armPlacedThink). A swallowed toggle is dropped from the set, so the reader's next press on
// that node is theirs again.
document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (!d || !d.matches || !d.matches("details.think")) return;
    if (thinkAutoOpened.has(d)) {
      thinkAutoOpened.delete(d);
      return;
    }
    const key = d.dataset.thinkTurn;
    if (d.open) {
      state.thinkOpen.add(key);
      state.thinkClosed.delete(key);
    } else {
      state.thinkOpen.delete(key);
      state.thinkClosed.add(key);
    }
  },
  true,
);

function conversationHtml(conv) {
  const { thread, turns, latest } = conv;
  const collapsed = state.collapsedJobs.has(thread);
  const maximized = state.maximized === thread;
  const homeless = isHomelessConv(conv);
  const runningTurn = turns.find(turnLive);
  // A steer that missed its turn is offered back as an unsent draft: seed the box once, so the reader can send it,
  // edit it, or ignore it. Seeding is keyed on the steer itself, so a re-render cannot refill a box they cleared.
  const pendingSteer = latest.pendingSteer && typeof latest.pendingSteer.text === "string" ? latest.pendingSteer : null;
  if (pendingSteer) {
    const key = `${thread}|${pendingSteer.at || 0}`;
    const seeded = state.seededSteer || (state.seededSteer = new Set());
    if (!state.replyDrafts[thread] && !seeded.has(key)) {
      seeded.add(key);
      state.replyDrafts[thread] = pendingSteer.text;
    }
  }
  // Steering while the agent sits inside delegate_task waits for that call to return. Say so at the moment it
  // matters, instead of promising a boundary the turn may never reach.
  const inDelegate = runningTurn ? inflightToolName(jobLines(runningTurn.id)) === "delegate_task" : false;
  const running = Boolean(runningTurn);
  // The second reason Queue reply is offered: the turn is over but the subagents it started are still out. Asked
  // once here, because the placeholder, both button titles and the button itself all have to agree on it.
  const childrenStillOut = childrenOut(thread);
  const queue = state.replyQueue.get(thread) || [];
  const queued = queue.length;
  const queuedTitle = queue.map((q, i) => `${i + 1}. ${q.text}`).join("\n");
  // A turn can end while the children it delegated are still working. The card's state is what is happening, not what
  // the parent's turn did, so RUNNING outlives the turn for as long as something it started is still going.
  const liveSubs =
    turns.flatMap((t) => t.subagents || []).some((s) => s.running) ||
    (subagentFallback.get(thread) || []).some((s) => s.running);
  const runningNow = running || liveSubs;
  // A pending approval for this conversation means the agent is not thinking, it is waiting on you.
  const waitingApproval = [...state.approvals.values()].find((a) => a && a.thread && a.thread === thread) || null;
  // A run parks its own approval inside the turn (the Runs API path): same message, different
  // carrier, so the card can answer it without the CLI approval plugin. An approval whose window has closed is
  // not a signal any more — the gateway denied the command on its own and the box below says so.
  const runApprovalRaw = runningTurn?.approval || latest.approval || null;
  const runApproval = approvalLive(runApprovalRaw) ? runApprovalRaw : null;
  // …and the same for the agent's own question: the head says the agent is waiting on an ANSWER, which is
  // a different act from allowing a command, so it gets its own chip in the light purple.
  const runQuestion = runningTurn?.question || latest.question || null;
  // The session's own name is the card's title, and it is set like the revive row's: bold, with how long ago
  // the thread was last used in the same dimmed grey next to it. The cwd only appears when a session has no
  // name at all.
  const titleHtml = latest.title
    ? `<span class="job-title mono" title="${esc(latest.title)}">${esc(latest.title)}</span>`
    : "";
  // How stale the thread is, right after the state it belongs to: "NOT-RUNNING · 2m ago" reads as one fact,
  // while the same counter trailing a long session name sat far from the thing it describes.
  const whenHtml = latest.lastActiveAt
    ? `<span class="job-when mono" data-when="${esc(thread)}" title="last used ${esc(new Date(latest.lastActiveAt).toLocaleString())}">${esc(fmtAgo(latest.lastActiveAt))}</span>`
    : "";
  const meta = [
    // cwd is no longer listed here: it has its own line under the card's head, on every card, titled
    // or not.
    // Why this card is in the unattached panel: it has no worktree, or one that is not in the scan.
    homeless ? (latest.ownerPath ? `owner ${latest.ownerPath} (not in the scan)` : "no worktree") : null,
    // With usage figures present the model leads that strip instead (it is what the numbers belong to);
    // without them this line is the only place it can appear.
    latest.stats ? null : latest.model ? `model ${latest.model}` : "(default model)",
    latest.worktree ? `worktree ${latest.worktree}` : null,
    latest.baseCheckout ? "in the project checkout (no worktree)" : latest.existing ? "in existing worktree" : null,
    turns.length > 1 ? `${turns.length} turns` : null,
    // The run id is bookkeeping and it now sits at the end of the row, to the right of the turn count,
    // instead of leading the line.
    latest.runId ? `run ${String(latest.runId).replace(/^run_/, "").slice(0, 8)}` : null,
  ].filter(Boolean).join(" · ");
  // Where this agent is actually working — the top of every card, one quiet line. A card is re-read to
  // answer "which tree is this one in", and that fact used to appear only on a card whose session never
  // got a title. Only the last segments are drawn; the full path, and the row this agent is filed under
  // when that is a different folder, are in the tooltip.
  const cwdHere = normPath(latest.cwd);
  const cwdRow = normPath(latest.ownerPath);
  const cwdLine = cwdHere || cwdRow;
  const cwdTitle = [
    cwdHere ? `working directory: ${cwdHere}` : null,
    cwdRow && cwdRow !== cwdHere ? `worktree row: ${cwdRow}` : null,
    latest.worktree ? `worktree: ${latest.worktree}` : null,
  ].filter(Boolean).join("\n");
  const cwdHtml = cwdLine
    ? `<div class="job-cwd" title="${esc(cwdTitle)}">` +
      `<span class="cwd-label">cwd</span>` +
      `<span class="cwd-path mono">${esc(tailPath(cwdLine))}</span>` +
      (cwdRow && cwdHere && cwdRow !== cwdHere
        ? `<span class="cwd-row mono" title="the worktree row this agent is filed under">row ${esc(tailPath(cwdRow, 2))}</span>`
        : "") +
      "</div>"
    : "";
  // A run has no process to exit. The pool maps run status onto 0/1 so the old CLI card keeps
  // rendering, but printing "exit 0" for it reads as if a child process came and went — answer
  // "what happened" instead. A legacy CLI turn still has a real exit code worth showing.
  const outcome = latest.runId
    ? `${latest.status}${latest.exitCode && latest.exitCode !== 0 ? ` · exit ${latest.exitCode}` : ""}`
    : `exit ${latest.exitCode ?? "?"}`;
  // No clock here while a turn runs: the turn head already says "turn 2 - running 12s", and a second
  // counter a few lines above the reply box only pushed the box down.
  const foot = turnLive(latest)
    ? ""
    : latest.revived
      // Rebuilt from the gateway's session store, so there was never a process here: "exit ?" and
      // "0s" would both describe a run that did not happen in this panel. Say when it was last used.
      ? `<span class="mono dim">revived · last active ${esc(relTime(latest.startedAt))} ago</span>`
      : `<span class="mono dim">${esc(outcome)} · ${esc(elapsed(latest))}${latest.tokens?.total ? ` · tokens ${fmtTok(latest.tokens.total)}` : ""}${latest.error ? ` · ${esc(latest.error)}` : ""}</span>${turnRetryHtml(latest, thread)}`;
  const artifacts = artifactsFor(conv);
  const artSplit = splitArtifacts(artifacts);
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
  const thinkZoom = state.thinkZoom.get(thread);
  const sizeVars = [zoom ? `--out-size:${zoom}px` : "", thinkZoom ? `--think-size:${thinkZoom}px` : ""].filter(Boolean).join(";");
  // The pill the reader already knows, for a card this panel has no line to. It still reads "not-running" — that is
  // the state, and the press is the same press: pick this up. What differs is behind the click. This one asks the
  // gateway about the run it lost BEFORE starting anything: still live -> the card re-attaches to that run and
  // steers it again; ended -> the run's own result is adopted; forgotten -> the card settles honestly and the thread
  // is continued, which is the pick-up that was asked for. It is only drawn while the run may still exist; once the
  // gateway has said it has no record of it (runGone) there is nothing left to ask, and the ordinary pill stands.
  const runMayStillExist = latest.status === "interrupted" && Boolean(latest.runId) && !latest.runGone;
  const detachedChip = runMayStillExist
    ? `<button type="button" class="pill pill-notrunning pill-reattach" data-reattach-job="${esc(latest.id || thread)}" title="${esc(
        `not running: this panel lost its line to run ${latest.runId}, which may still be going in the gateway — click to pick this up. Still live: the card re-attaches to that run and can steer it again. Ended: the run's result is adopted. Forgotten: the card settles as interrupted and this thread is continued.`,
      )}">not-running<span class="pill-again" aria-hidden="true">\u21bb</span></button>`
    : "";
  // A finished agent is not a stopped one, and the reader asked for the difference: when the card's latest turn is
  // exactly `done` the pill reads COMPLETE in the panel's green and carries no refresh glyph, because nothing here is
  // being resumed. Same pill, same place, same size — a word, a colour, and a press that queues one ask for the board
  // assistant instead of nudging the agent that already finished. Every other status keeps the pill it has today, word
  // for word: `failed` stays "exited", `cancelled`/`interrupted`/lost stay "not-running", and the re-attach pill's own
  // path is untouched.
  const completeChip = latest.status === "done"
    ? `<button type="button" class="pill pill-complete" data-complete-ask="${esc(latest.id || thread)}" title="${esc(
        `done · ${elapsed(latest)} — click to queue one ask for the board assistant: whether this really is complete (the commits, the PR, the report) and what has to happen next for this worktree. Nothing is sent to this agent.`,
      )}">complete</button>`
    : "";
  const hotFlash = state.hotFlash.thread === thread && Date.now() < state.hotFlash.until;
  return `<div class="job${collapsed ? " collapsed" : ""}${maximized ? " maximized" : ""}${jumped}${hotFlash ? " hot-flash" : ""}" data-thread="${esc(thread)}" data-id="${esc(thread)}" data-sig="${esc(conversationSignature(conv))}"${sizeVars ? ` style="${sizeVars}"` : ""}>
    <div class="job-head" data-toggle="${esc(thread)}" title="${collapsed ? "expand" : "minimize"} this conversation">
      <span class="agent-glyph" title="a Hermes agent session — ⧉ marks an agent row">\u29c9</span>
      <span class="chev">${collapsed ? "\u25b8" : "\u25be"}</span>
      ${runningNow
        ? `<span class="pill pill-running" title="${esc(running ? `running ${elapsed(latest)}` : `this turn is ${latest.status}, but subagents it started are still running`)}">running</span>`
        : completeChip ||
          detachedChip ||
          `<button class="pill pill-notrunning pill-continue${latest.status === "failed" ? " is-failed" : ""}" data-continue-thread="${esc(thread)}" type="button" title="${esc(
            `${latest.status} · ${elapsed(latest)}${latest.error ? ` · ${latest.error}` : ""} — click to send this agent "${CONTINUE_TEXT}" and start its next turn`,
          )}">${latest.status === "failed" ? "exited" : "not-running"}<span class="pill-again" aria-hidden="true">\u21bb</span></button>`}
      ${livePulseHtml(latest)}
      ${whenHtml}
      ${waitingApproval ? `<button class="sig sig-approval" data-approval-jump="${esc(waitingApproval.id)}" title="this agent is blocked on an approval — click to answer it">waiting on you →</button>` : ""}
      ${runApproval && !waitingApproval ? `<span class="sig sig-approval" title="this run is parked on a flagged command — answer it in the card below">waiting on approval</span>` : ""}
      ${runQuestion ? `<button type="button" class="sig sig-question" data-question-jump="${esc(thread)}" title="the agent stopped to ask you something — click to jump to its question box">waiting on your answer →</button>` : ""}
      ${titleHtml}
      ${meta ? `<span class="mono dim">${esc(meta)}</span>` : ""}
      ${artSplit.files.length ? `<button type="button" class="btn-artifacts" data-artifacts="${esc(thread)}" data-artifacts-kind="file" title="${artSplit.files.length} file deliverable(s) from this agent — click to open in an editor, copy the path or delete the file">\u{1F4C4} ${artSplit.files.length}</button>` : ""}
      ${artSplit.urls.length ? `<button type="button" class="btn-artifacts" data-artifacts="${esc(thread)}" data-artifacts-kind="url" title="${artSplit.urls.length} URL(s) / endpoint(s) this agent printed — click to open one in your browser, copy it or remove it from the list">\u{1F517} ${artSplit.urls.length}</button>` : ""}
      ${pager}
      <span class="spacer"></span>
      ${latest.yolo ? '<span class="pill yolo" title="this run was started with the --yolo flag (auto-approve, no prompts). The panel does not send it: approvals still come to this card.">yolo</span>' : ""}
      ${homeless ? `<button class="btn-attach" data-attach-toggle="${esc(thread)}" type="button" title="attach this agent to a worktree — it then lives under that row">\u2935 attach</button>` : ""}
      <span class="mono dimmer thread-name" data-thread-name="${esc(thread)}" data-label="${esc(latest.label || "")}" title="${latest.label ? esc(`${latest.label} — Hermes thread ${thread}`) : "Hermes session thread — continue it any time"}">${esc(latest.label || thread)}</span>
      <button class="btn-pin${state.anchorThread === thread ? " is-on" : ""}" data-pin-thread="${esc(thread)}" type="button" title="${state.anchorThread === thread ? "this card holds its place while anything above it grows — click to release" : "pin this card: hold its place on screen while other cards above it grow (one pin at a time)"}">\u{1F4CC}</button>
      <button class="btn-think${thinkingOn(thread) ? " is-on" : ""}" data-think-thread="${esc(thread)}" type="button" title="${thinkingOn(thread) ? "showing this session's reasoning — open live while a turn runs, folded afterwards. click to hide it" : "show this session's reasoning: live and open while a turn runs, folded per turn afterwards (read from the session store)"}">🧠</button>
      <button class="btn-stream${streamOn(thread) ? " is-on" : ""}" data-stream-thread="${esc(thread)}" type="button" aria-pressed="${streamOn(thread) ? "true" : "false"}" title="${streamOn(thread) ? "this session is drawn as ONE stream — reasoning, tool calls, their output and the agent's own words in the order they happened, with no burst to open; each result is still the shut box it is everywhere else. click to go back to the separate thinking block and the condensed tool groups" : "draw this session as ONE stream: what the agent thought, said, called and got back, in the order it happened, with no burst to open — each result is still the shut box it is everywhere else, so a call's output is one click away (reasoning joins it while 🧠 is on; subagents keep their own strip)"}">🌊</button>
      <button class="btn-rename" data-rename-thread="${esc(thread)}" type="button" title="rename this session — a label for the panel only; the Hermes thread id never changes">\u270e</button>
      <button class="btn-max" data-max-thread="${esc(thread)}" type="button" title="${maximized ? "shrink this chat back into the list (Esc)" : "expand this chat to fill the window (Esc to close)"}">${maximized ? "\u2921" : "\u2922"}</button>
      <button class="btn-clear-thread" data-clear-thread="${esc(thread)}" type="button" title="forget this agent session — removes its turns and transcript from the panel (the worktree it made stays on disk)">✕</button>
    </div>
    ${cwdHtml}
    ${collapsed ? `<div class="job-preview mono" data-preview="${esc(thread)}">${jobPreviewHtml(latest)}</div>` : ""}
    ${homeless ? `<div class="attach-row" data-attach-row="${esc(thread)}" hidden>
      <span class="dimmer mono">attach to</span>
      <select data-attach-path="${esc(thread)}"></select>
      <button class="btn-attach-go" data-attach-go="${esc(thread)}" type="button">Attach</button>
    </div>` : ""}
    ${artSplit.files.length ? artifactsPopHtml(thread, artSplit.files, state.openArtifacts.get(thread)?.kind !== "url" ? state.openArtifacts.get(thread) : null, "file") : ""}
    ${artSplit.urls.length ? artifactsPopHtml(thread, artSplit.urls, state.openArtifacts.get(thread)?.kind === "url" ? state.openArtifacts.get(thread) : null, "url") : ""}
    <div class="job-body">
      ${pinnedHtml}
      ${blocks.html}
      ${queued ? `<div class="ghost-turns">${queue
        .map((q) => ghostTurnHtml(thread, q, queuedEditFor(thread), !threadBusy(thread) && !childrenStillOut))
        .join("")}</div>` : ""}
      ${foot ? `<div class="job-foot">${foot}</div>` : ""}
      <div class="reply">
        <div class="reply-wrap">
          <div class="attach-chips" data-chips="${esc(thread)}">${attachmentChipsHtml(thread)}</div>
          <!-- A chip needs an inline atom, and a textarea cannot hold one: this box is contenteditable and
               the chip is a non-editable span inside it. Nothing changes for the reader — Enter, Ctrl+Enter,
               Shift+Enter, the ↑/↓ recall and the draft restore are the same gestures — and every reader of
               its text goes through readBox(box) (board/paste-chips.js), which gives a chip's own text back
               in place. The placeholder moved to data-ph, because :empty draws it on a div. -->
          <div class="reply-box chipbox" contenteditable="true" role="textbox" aria-multiline="true"
            data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off"
            data-reply="${esc(thread)}" data-chipbox="reply:${esc(thread)}" data-rows="2" spellcheck="false"
            data-ph="${running
              ? (inDelegate
                ? "a subagent is out — a steer lands when delegate_task returns; Enter holds yours for the next turn"
                : "a turn is running — Ctrl+Enter steers it; Enter holds yours for the next turn")
              : childrenStillOut
                ? "this thread's subagents are still out — Enter holds yours until they finish"
                : "Reply to this agent — continues the same Hermes thread, Enter or Ctrl+Enter to send"}"></div>
          <div class="reply-actions">
            ${running
              ? `<button class="btn-reply btn-steer-primary" data-steer="${esc(runningTurn.id)}" type="button" title="${inDelegate ? "send this into the running turn (Ctrl+Enter) — it waits for delegate_task to return, and if the turn ends first it comes back to this box unsent" : "send this into the running turn (Ctrl+Enter) — the agent reads it at its next tool boundary and the turn carries on"}">Steer turn</button>`
              : `<button class="btn-reply" data-thread="${esc(thread)}" type="button" title="${childrenStillOut ? "send this as the next turn now — the subagents this thread started are still out, and Enter holds it until they finish instead" : "send this as the next turn (Enter or Ctrl+Enter)"}">Send reply</button>`}
            ${running || childrenStillOut
              ? `<button class="btn-queue" data-queue-reply="${esc(thread)}" type="button" title="${running ? "hold this reply and send it the moment the current turn finishes (Enter)" : "hold this reply until the subagents this thread started have finished, so the parent is not talking over them (Enter)"}">Queue reply</button>`
              : ""}
            ${queued ? `<span class="queue-note mono" title="${esc(queuedTitle)}">${queued} queued</span>` : ""}
            ${running ? `<button class="btn-cancel" data-id="${esc(runningTurn.id)}" type="button" title="cancel the run this agent is in the middle of">Cancel turn</button>` : ""}
          </div>
        </div>
        <div class="job-stats-slot" data-stats="${esc(thread)}">${statsRowHtml(latest, thread)}</div>
        ${pendingSteer
          ? `<div class="reply-note mono" data-pending-steer="${esc(thread)}" title="the turn ended before the gateway could read your steer at a tool boundary. It is in the box above, unsent — send it to continue on the same thread.">⇢ that steer missed the turn — it is in the box, unsent</div>`
          : ""}
        <div class="reply-row">
          <span class="warnline" data-reply-warn="${esc(thread)}"></span>
        </div>
      </div>
    </div>
  </div>`;
}

function restoreReplyDraft(thread) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  if (!box) return;
  const draft = state.replyDrafts[thread];
  if (draft) {
    // One place decides what a rebuilt box comes back as: the chip model the panel is holding for this
    // draft (a pasted block returns as a chip, with its text), else the draft's own text.
    if (!restoreBoxDraft(box, draft)) writeBox(box, draft);
    return;
  }
  // Nothing in memory: a chip-bearing draft this tab mirrored before a reload comes back here.
  restorePersistedBox(box);
}

// Typing state inside a card, so a rebuild can put it back. Row events arrive every few seconds for a
// fast-polling row, and the detail row is rebuilt on each one — without this, a half-typed reply was
// thrown away mid-sentence and the cursor went with it.
function captureTyping(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el)) return null;
  // The held reply's editor is a textarea inside the card, so a repaint takes it away the same way it takes the reply
  // box — and the reader can be mid-edit exactly when a turn ends. Captured here, put back in restoreTyping().
  if (el.classList?.contains("ghost-edit-box")) {
    return { edit: el.dataset.editThread, editAt: Number(el.dataset.editQueued) || 0, value: el.value, start: el.selectionStart, end: el.selectionEnd };
  }
  if (!el.classList?.contains("reply-box")) return null;
  // The caret is captured in the units readBox measures in, so a chip in the draft cannot move it: the
  // value is the serialized text, which is exactly what the send path posts.
  const at = caretOffset(el);
  return { thread: el.dataset.reply, value: readBox(el), start: at, end: at };
}

// What this thread's box just sent, and when: a repaint during the POST can capture the text before the reply
// is cleared, and restoring that snapshot would put the sent instruction back in the box. Kept briefly, and only
// for the exact text that went out.
state.justSent = state.justSent || new Map(); // thread -> { text, at }

// ---- the box grows with its draft ----------------------------------------------------------------
// The reply box starts two lines tall and the Send/Queue/Cancel row is drawn inside its bottom-left corner.
// Past two lines the text scrolled underneath those buttons, so the end of a longer draft was being typed
// blind. The box now grows downward a line at a time (the buttons ride its bottom edge, still inside it), and
// shrinks back when the draft does. The cap keeps one long draft from swallowing the whole window; past it the
// box scrolls, which is the only case where text can still reach the buttons.
const REPLY_MAX_LINES = 18;
const SPAWN_MAX_LINES = 14;

function growBoxToDraft(box, maxLines) {
  if (!box || (box.tagName !== "TEXTAREA" && !(box.dataset && box.dataset.chipbox))) return;
  const cs = getComputedStyle(box);
  const line = parseFloat(cs.lineHeight) || 18;
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + border;
  const rows = Math.max(2, Number(box.getAttribute("rows") || box.dataset.rows) || 2);
  const min = Math.round(rows * line + chrome);
  const max = Math.max(min, Math.min(Math.round(line * maxLines + chrome), Math.round(window.innerHeight * 0.45)));
  box.style.height = "auto"; // measure the content, not the box we are trying to size
  const want = box.scrollHeight + border;
  const h = Math.max(min, Math.min(want, max));
  box.style.height = `${h}px`;
  box.style.overflowY = want > max + 1 ? "auto" : "hidden";
  // The serialized length, not the DOM's: a chip is as long as the text it swallowed, which is what the
  // box has to make room for.
  box.dataset.grownFor = String(readBox(box).length);
}

// Grow without moving the page - unless the box is the one being typed in and it now runs off the bottom.
function growReplyBox(box) {
  if (!box || (box.tagName !== "TEXTAREA" && !(box.dataset && box.dataset.chipbox))) return;
  const maxLines = box.id === "job-prompt" ? SPAWN_MAX_LINES : REPLY_MAX_LINES;
  growBoxToDraft(box, maxLines);
  if (document.activeElement !== box) return;
  const r = box.getBoundingClientRect();
  const room = window.innerHeight - 14;
  if (r.bottom > room) {
    programmaticScroll();
    window.scrollBy(0, r.bottom - room);
    refreshAnchorBaseline();
  }
}

function restoreTyping(root, typing) {
  for (const box of root.querySelectorAll(".reply-box[data-reply]")) {
    const draft = state.replyDrafts[box.dataset.reply];
    // A rebuild hands back an empty box, so what it comes back as is decided here and nowhere else: the
    // chip model the panel holds for this draft, else the draft's own text, else what this tab mirrored
    // before a reload.
    let held = readBox(box);
    if (draft) {
      // A box that already holds this draft is the reader's OWN node — the row path moves the card across
      // instead of rebuilding it — so it is left untouched: rewriting it would only cost them the caret and
      // the engine's own spacing (a space it stored as U+00A0 comes back as a plain one, and the next
      // keystroke eats it).
      if (held !== draft) {
        if (!restoreBoxDraft(box, draft)) writeBox(box, draft);
        held = readBox(box);
      }
    } else if (restorePersistedBox(box)) held = readBox(box);
    // A repaint builds the box at its default height: give a restored draft its room back. Keyed on length
    // so a board of quiet cards is not re-measured on every tick.
    if (held && box.dataset.grownFor !== String(held.length)) growBoxToDraft(box, REPLY_MAX_LINES);
  }
  if (!typing) return;
  // The held reply's editor: the textarea is rebuilt from state (edit.text follows the box), and this puts the caret
  // and the focus back where the reader had them — so a turn ending mid-edit does not move the ground under them.
  if (typing.edit) {
    const box = root.querySelector(`.ghost-edit-box[data-edit-queued="${typing.editAt}"]`);
    if (!box) return;
    const edit = queuedEditFor(typing.edit);
    if (edit && edit.at === typing.editAt) edit.text = typing.value;
    box.value = typing.value;
    box.focus({ preventScroll: true });
    try {
      box.setSelectionRange(typing.start, typing.end);
    } catch {
      /* a box that is no longer a text field: nothing to restore */
    }
    return;
  }
  const box = root.querySelector(`.reply-box[data-reply="${CSS.escape(typing.thread)}"]`);
  if (!box) return;
  const sent = state.justSent.get(typing.thread);
  const stale = Boolean(sent && Date.now() - sent.at < 20000 && typing.value.trim() === sent.text);
  if (stale) {
    // The text in this snapshot is the text that was just sent: the box comes back empty, not refilled.
    writeBox(box, "");
    clearBoxDraft(box);
    state.replyDrafts[typing.thread] = "";
  } else {
    // The snapshot is what the reader had mid-sentence, chip and all: it comes back through the one writer.
    if (!restoreBoxDraft(box, typing.value)) writeBox(box, typing.value);
    state.replyDrafts[typing.thread] = typing.value;
  }
  // preventScroll is the whole point here: this runs on every repaint, and a plain focus() scrolls the box
  // into view - which pulled the page back up to the reader's caret every few seconds while they had
  // scrolled away to read something lower on the board.
  box.focus({ preventScroll: true });
  // A contenteditable host has no setSelectionRange: the caret is a serialized offset, which is the same
  // measure the snapshot was taken in (a chip counts as the text it swallowed, so it cannot move it).
  setCaretOffset(box, Number.isFinite(typing.end) ? typing.end : typing.start);
}

// After a repaint: the inline add-agent field comes back with its draft, and its caret and focus if the reader was
// typing in it. The row's detail is rebuilt on every scan, so without this a prompt could not be typed across one.
function restoreAddAgent(root) {
  const a = state.addAgent;
  if (!a) return;
  const input = root.querySelector(`.add-agent-input[data-add-agent-key="${CSS.escape(a.key)}"]`);
  if (!input) return;
  // Read the caret before focusing. Focusing a freshly built field fires focusin synchronously, and that handler
  // records the node's selection - which for a brand new field is 0 - so reading it afterwards put the caret at the
  // start of the sentence every time the row was rebuilt.
  const start = a.start;
  const end = a.end;
  if (readBox(input) !== a.value) {
    if (!restoreBoxDraft(input, a.value)) writeBox(input, a.value);
  }
  if (!a.focused) return;
  // preventScroll for the same reason the reply box uses it: this runs on every repaint, and a bare focus() would
  // pull the page back to this box every few seconds while the reader had scrolled away.
  input.focus({ preventScroll: true });
  const max = readBox(input).length;
  const s = Math.min(Math.max(0, Number.isFinite(start) ? start : max), max);
  const e = Math.min(Math.max(s, Number.isFinite(end) ? end : s), max);
  // The caret is placed in the same serialized units the snapshot was taken in.
  setCaretOffset(input, e);
  a.start = s;
  a.end = e;
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

// ---- the row's own ⟳ ---------------------------------------------------------------------------
// One click, no modal. The server re-reads this one tree, reconciles its TODO list against what the tree now holds and
// re-derives its description only if that has gone stale; the answer carries the row itself, the journal lines it wrote
// and — when the cheap pass found a mismatch — an offer to start an agent in that tree. The row repaints from the
// ANSWER rather than waiting for an event, because a refresh that found nothing changed has no event to wait for and the
// journal line still has to appear.
//
// `refreshAgent` is the setting the brief names: off / ask / auto, default ask. It is saved in this browser because it
// decides what THIS reader's click does — one browser may want to be asked while another never is — and the server
// re-answers every gate (a live run in the tree, an unusable gateway) before it starts anything.
const REFRESH_AGENT_KEY = "wtgui.refreshAgent";
const REFRESH_AGENT_MODES = ["off", "ask", "auto"];

function refreshAgentMode() {
  try {
    const v = localStorage.getItem(REFRESH_AGENT_KEY);
    return REFRESH_AGENT_MODES.includes(v) ? v : "ask";
  } catch {
    return "ask";
  }
}

function saveRefreshAgent(mode) {
  const value = REFRESH_AGENT_MODES.includes(String(mode)) ? String(mode) : "ask";
  try {
    localStorage.setItem(REFRESH_AGENT_KEY, value);
  } catch {
    /* private mode: the choice just does not persist */
  }
  return value;
}

function paintRefreshAgent() {
  const sel = $("refresh-agent");
  if (sel) sel.value = refreshAgentMode();
}

// The card the offer opens: the panel's own in-place question (the same `row-confirm` shape the ✕ asks in), under the
// row it belongs to, because the whole point is that the agent starts in THAT worktree.
function refreshOfferHtml(offer) {
  const row = state.rows.get(offer.key);
  if (!row) return "";
  const evidence = (offer.evidence || []).filter(Boolean);
  const what = evidence.length ? evidence.join(" · ") : "a mismatch the cheap pass cannot resolve by itself";
  return `<tr class="row-confirm refresh-offer" data-refresh-offer="${esc(offer.key)}">
      <td colspan="${wtColspan()}">
        <div class="row-confirm-cell">
          <span class="rc-msg"><span class="dimmer">⟳ re-read</span> <b>${esc(row.name)}</b> <span class="dimmer">found</span> <span class="mono">${esc(what)}</span>
            <span class="dimmer">— start one agent in this worktree to double-check the TODO, the description and the merge state? It reads the tree itself and reports back; nothing is pushed or merged.</span></span>
          <span class="rc-actions"><button class="btn-del-no" type="button" data-refresh-offer-no="${esc(offer.key)}" title="leave it — the cheap pass's journal line is already under the row">not now</button><button class="btn-refresh-yes" type="button" data-refresh-offer-yes="${esc(offer.key)}" title="start an agent in ${esc(row.path)} to double-check what the ⟳ found">start agent</button></span>
        </div>
      </td>
    </tr>`;
}

// Put the card under its row (one copy), or take it away when there is no offer for that key.
function paintRefreshOffer(key) {
  const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  for (const old of document.querySelectorAll(`tr.refresh-offer[data-refresh-offer="${CSS.escape(key)}"]`)) old.remove();
  const offer = state.refreshOffers.get(key);
  if (!offer || !rowEl) return false;
  const holder = document.createElement("tbody");
  holder.innerHTML = refreshOfferHtml(offer);
  const card = holder.firstElementChild;
  if (!card) return false;
  rowEl.after(card);
  return true;
}

// Every open card, after a rebuild that emptied a project's tbody.
function paintRefreshOffers(project = null) {
  for (const offer of [...state.refreshOffers.values()]) {
    if (project && offer.project !== project) continue;
    paintRefreshOffer(offer.key);
  }
}

function clearRefreshOffer(key) {
  state.refreshOffers.delete(key);
  for (const old of document.querySelectorAll(`tr.refresh-offer[data-refresh-offer="${CSS.escape(key)}"]`)) old.remove();
}

async function refreshTreeRow(btn) {
  const key = btn.dataset.refreshTree;
  const row = state.rows.get(key);
  if (!row || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.classList.add("is-starting");
  try {
    const r = await apiFetch(
      // The ring's own route, one depth deeper: `reconcile` asks it to go on to the TODO, the description and the
      // journal. Sending it here rather than to a second endpoint is the whole point — there is one refresh path.
      "/api/refresh/row",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: row.project, path: row.path, reconcile: true, refreshAgent: refreshAgentMode() }),
      },
      { timeoutMs: 60000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // The row, in place: the same path the next-read ring uses, so nothing below it is rebuilt.
    if (d.row) placeRow(d.project || row.project, d.row, {});
    const lines = Array.isArray(d.journal) ? d.journal : [];
    // The offer: one card under the row, when the server said the cheap pass found something to double-check.
    clearRefreshOffer(key);
    if (d.agent && d.agent.offered) {
      state.refreshOffers.set(key, { key, project: d.project || row.project, path: row.path, evidence: lines.filter((l) => !/^agent pass offered/.test(l)) });
      paintRefreshOffer(key);
    }
    showBanner(`⟳ ${row.name || row.path}: ${lines.join(" · ") || "re-read"}`);
  } catch (err) {
    showBanner(`refresh ${row.name || row.path}: ${String(err.message || err)}`);
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove("is-starting");
    if (btn.isConnected) btn.disabled = false;
  }
}

// The offer's button. The server re-answers the live-run and gateway gates, so a card left open for a minute cannot
// start a run in a tree that no longer needs one; a refusal is said on the banner and the card stays for a retry.
async function startRefreshAgentFromCard(btn) {
  const key = btn.dataset.refreshOfferYes;
  const offer = state.refreshOffers.get(key);
  const row = state.rows.get(key);
  if (!offer || !row || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  btn.disabled = true;
  try {
    const r = await apiFetch(
      "/api/refresh/row/agent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: offer.project, path: offer.path, evidence: offer.evidence || [] }),
      },
      { timeoutMs: 60000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    clearRefreshOffer(key);
    showBanner(d.say || `agent started in ${row.name || row.path}`);
    if (d.job) {
      updateJob(d.job, { scroll: false });
      revealSpawnedAgent(d.job);
    }
  } catch (err) {
    showBanner(`could not start the agent — ${String(err.message || err)}`);
  } finally {
    delete btn.dataset.busy;
    if (btn.isConnected) btn.disabled = false;
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
  // The end of what the box HOLDS, a chip included: a pasted block sits at the end of the string the next
  // keystroke will extend.
  setCaretOffset(box, readBox(box).length);
  return document.activeElement === box;
}

// A real newline at the caret, for Shift+Enter. Doing it by hand rather than leaving it to the default
// action keeps the caret and the saved draft in step, and works the same in both message boxes.
function insertNewlineAtCaret(el) {
  // A contenteditable host cannot be written with a value, so the newline is inserted at the caret instead
  // — one implementation for both message boxes and the New-agent prompt (board/paste-chips.js). It fires
  // the same input event the assignment used to, so the draft and the box's growth keep up.
  insertNewlineAt(el);
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

// Reply history: what the reader typed into this thread, oldest first. Up walks back through it, Down walks
// forward and finally back to whatever you were typing.
//
// A turn's prompt is only the reader's when the reader wrote it. A collected subagent delivery is a prompt the
// panel wrote ("The 2 subagents you delegated have finished. Aggregate their results..."), so walking the turn
// prompts unfiltered put a paragraph about subagents in the box on the second Up. Those turns carry an `origin`,
// and the text has a shape worth refusing even if an older job predates that field.
const PANEL_PROMPT = /^The \d+ subagents? you delegated (?:has|have) finished\./i;

// Everything the reader has sent on this thread, from this browser: replies, steers, and anything the queue
// delivered. Kept per thread in localStorage, capped, so Up still walks text the panel no longer has a turn for.
const REPLY_HISTORY_KEY = "wtgui.replyHistory";
const REPLY_HISTORY_MAX = 60;

function replyHistoryStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(REPLY_HISTORY_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function rememberReply(thread, text) {
  const s = String(text || "").trim();
  if (!thread || !s) return;
  try {
    const all = replyHistoryStore();
    const list = Array.isArray(all[thread]) ? all[thread] : [];
    // Sending the same thing twice in a row is one entry in the history, not two.
    if (list[list.length - 1] !== s) list.push(s);
    all[thread] = list.slice(-REPLY_HISTORY_MAX);
    localStorage.setItem(REPLY_HISTORY_KEY, JSON.stringify(all));
  } catch {
    /* private mode: history is a convenience, not state the panel needs */
  }
}

function turnPrompts(thread) {
  const prompts = [...state.jobs.values()]
    .filter((j) => (j.thread || j.id) === thread)
    .filter((j) => !j.origin)
    .sort((a, b) => (a.turn || 0) - (b.turn || 0))
    // A prompt that carried attachments holds the panel's file block at the end; recalling it must not
    // re-attach anything, so the block comes off and the words are what moves through the box.
    .map((j) => String(j.prompt || "").replace(/(?:\n\n?Attachment: [^\n]*before answering\.)+$/g, "").trim())
    .filter((text) => text && !PANEL_PROMPT.test(text));
  const mine = replyHistoryStore()[thread];
  const sent = Array.isArray(mine) ? mine.filter((x) => typeof x === "string" && x.trim() && !PANEL_PROMPT.test(x.trim())) : [];
  // Older turns first, then what this browser sent (which is the only record of a steer), de-duplicated.
  const seen = new Set();
  const out = [];
  for (const text of [...prompts, ...sent]) {
    const key = text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// A reply typed while the agent is still working: hold it and start it the moment that turn ends, so
// Hermes never sees a second session on the same thread at once (which it answers with "busy").
function queueReply(thread, text) {
  const q = state.replyQueue.get(thread) || [];
  // `at` is this entry's identity — the × and the drain both key on it — so two replies held in the same
  // millisecond still get one each: the stamp is nudged until it is unique within this thread's queue.
  let at = Date.now();
  while (q.some((entry) => entry && entry.at === at)) at += 1;
  q.push({ text, at });
  state.replyQueue.set(thread, q);
  renderConversation(thread);
}

// One press of Queue reply, from the button or from Enter: hold what the box holds and send it when the thread
// is free, instead of steering the turn that is running now. The draft is cleared BEFORE queueReply, which
// rebuilds the card - the rebuild would otherwise put the text back into the new box from the saved draft.
function queueReplyFromBox(thread) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // readBox, not box.value: what is held is what the agent would receive, a chip being the text it holds.
  const text = readBox(box).trim();
  if (!text) {
    if (box) box.focus();
    return false;
  }
  state.replyDrafts[thread] = "";
  if (box) {
    writeBox(box, "");
    clearBoxDraft(box);
  } else clearBoxDraft(`reply:${thread}`);
  queueReply(thread, text);
  document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`)?.focus();
  return true;
}

// Is the Queue reply button offered for this card right now? It is drawn for two reasons - a turn is running, or
// a finished turn whose subagents are still out - and Enter means the same thing as that button. Asking the page
// where the card drew it is what keeps the gesture and the button from ever disagreeing about whether there is
// anything to hold: no button, nothing to wait for, so Enter sends.
function queueOfferedFor(box) {
  return Boolean(box && box.closest(".reply")?.querySelector("[data-queue-reply]"));
}

// Is the Steer turn button offered for this card right now? It is drawn while a turn is live on the thread, and
// Ctrl/Cmd+Enter means the same thing as that button - the same question asked of the same markup.
function steerOfferedFor(box) {
  return Boolean(box && box.closest(".reply")?.querySelector("[data-steer]"));
}

// One press of Steer turn, from the button or from Ctrl/Cmd+Enter: send what the box holds into the turn that is
// running now. The button carries the id of the turn it was drawn for; from the keyboard the live turn on this
// thread is looked up instead, which is the same turn the card drew its button for.
function steerFromBox(thread, turnId = null) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  const id = turnId || [...state.jobs.values()].find((j) => (j.thread || j.id) === thread && turnLive(j))?.id;
  if (!id) return Promise.resolve(false);
  return steerTurn(thread, id, readBox(box));
}

function replyQueued(thread) {
  return state.replyQueue.get(thread) || [];
}

// The held reply the reader has open in its own editor, if any. One editor at a time, and it names the entry by the
// entry's own `at` — which is the identity everything here works in: a save writes back to that one entry, and an
// edit never becomes a new queue entry with a new timestamp.
function queuedEditFor(thread) {
  const edit = state.replyEdit;
  if (!edit) return null;
  return thread && edit.thread !== thread ? null : edit;
}

// One held reply on the card: the badge, the age it has been waiting and the line saying when it goes out. Its text
// is a ghost line — or, when this is the entry the reader has open, a textarea in that line's place, seeded with the
// entry's text and nothing else about the card moved. The age is the entry's own `at` either way, so an edit does not
// restart the clock: editing is not re-queueing.
function ghostTurnHtml(thread, q, edit, freeToSend) {
  // The head is the same for a held reply and for the one being edited — the badge, the age counting from the entry's
  // own `at`, the line saying when it goes out, and the × that takes this ONE entry back (usable while it is being
  // edited: the removal closes the editor with it).
  const head = (when, editing) =>
    `<div class="ghost-turn${editing ? " editing" : ""}"><div class="ghost-head mono"><span class="ghost-badge">queued</span><span class="queue-ago" data-queued-at="${q.at}">${fmtDur(Date.now() - q.at)}</span><span class="dimmer">${when}</span><button class="ghost-cancel" type="button" data-queue-cancel="${esc(thread)}" data-queue-cancel-at="${q.at}" title="cancel this queued reply — it will not be sent, and if the reply box is empty its text comes back as your draft" aria-label="cancel this queued reply for ${esc(thread)}">✕</button></div>`;
  if (!edit || edit.at !== q.at) {
    return `${head("sends when the current turn finishes", false)}<div class="ghost-prompt" data-edit-queued-open="${q.at}" data-edit-thread="${esc(thread)}" role="button" tabindex="0" title="click to edit this held reply">${linkifyText(q.text)}</div></div>`;
  }
  // An editor is open on this entry, so the line above it cannot keep promising a send: while the reader is in the
  // box this reply is held, and the card says which hold it is — still waiting for the turn and its subagents, or free
  // to go the moment it is saved.
  const when = freeToSend
    ? "the turn has finished — this held reply waits for your edit; save and it goes"
    : "editing — it is not sent while you edit it; save sends it, Escape leaves it as it was";
  return `${head(when, true)}<div class="ghost-edit" data-edit-for="${q.at}"><textarea class="ghost-edit-box mono" data-edit-queued="${q.at}" data-edit-thread="${esc(thread)}" rows="2" spellcheck="false" aria-label="edit this held reply">${esc(edit.text)}</textarea><div class="ghost-edit-actions mono"><button class="btn-edit-save" type="button" data-edit-save="${q.at}" data-edit-thread="${esc(thread)}" title="save this edit — the held reply becomes this text (Enter)">Save</button><button class="btn-edit-cancel" type="button" data-edit-cancel="${q.at}" data-edit-thread="${esc(thread)}" title="leave this held reply exactly as it was (Escape)">Cancel</button></div></div></div>`;
}

// Open the editor on one held reply, named by its own `at`. The text it opens on is remembered, so Escape, Cancel and
// a click away all put that entry back exactly as it was: nothing the reader did not save can reach the queue. One
// editor at a time — opening another leaves the first as it was.
function openQueuedEdit(thread, at) {
  const entry = replyQueued(thread).find((e) => e && e.at === at);
  if (!entry) return false;
  const already = queuedEditFor(null);
  if (already && (already.thread !== thread || already.at !== at)) cancelQueuedEdit(already.thread, already.at);
  state.replyEdit = { thread, at, original: entry.text, text: entry.text };
  renderConversation(thread);
  const box = document.querySelector(`.ghost-edit-box[data-edit-queued="${at}"][data-edit-thread="${CSS.escape(thread)}"]`);
  if (box) {
    box.focus({ preventScroll: true });
    growReplyBox(box);
    // The caret goes to the end: the reader clicked a held line to add to it, not to retype it.
    try {
      box.setSelectionRange(box.value.length, box.value.length);
    } catch {
      /* not a text field any more: nothing to place */
    }
  }
  return true;
}

// Save the edit to the ONE entry it belongs to, found by its `at`: not a new queue entry, and not the thread's whole
// queue. The entry keeps its place and its `at`, so its age carries on from when it was first held. Enter or the Save
// button is the only thing that commits an edit — nothing here sends.
function saveQueuedEdit(thread, at) {
  const edit = queuedEditFor(thread);
  if (!edit || edit.at !== at) return false;
  const box = document.querySelector(`.ghost-edit-box[data-edit-queued="${at}"][data-edit-thread="${CSS.escape(thread)}"]`);
  const text = String(box ? box.value : edit.text).trim();
  state.replyEdit = null;
  const q = replyQueued(thread);
  const i = q.findIndex((e) => e && e.at === at);
  if (i < 0) {
    // The entry left the queue while the editor was open (the × stays usable mid-edit): there is nothing to write to.
    renderConversation(thread);
    return false;
  }
  if (!text) {
    // An empty box is the reader saying the same thing the × says: that entry goes. Taken out by the same removal, so
    // the queue has one way out rather than two — and nothing is sent.
    takeQueuedReply(thread, at);
    renderConversation(thread);
    const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
    if (warn) warn.textContent = "that held reply was saved empty — it is gone, and nothing was sent";
    void drainReplyQueue(thread);
    return true;
  }
  q[i] = { ...q[i], text };
  state.replyQueue.set(thread, q);
  renderConversation(thread);
  // Sendable again the moment the edit is saved: if the turn and its subagents are already done, the drain sends it
  // now; if they are not, it stays held exactly as it was and goes when they finish.
  void drainReplyQueue(thread);
  return true;
}

// Leave the edit: the entry goes back to the text it had when the editor opened, and nothing else on the card moves.
// This is what Escape and Cancel do, and what clicking away does.
function cancelQueuedEdit(thread, at) {
  const edit = queuedEditFor(thread);
  if (!edit || (at && edit.at !== at)) return false;
  state.replyEdit = null;
  renderConversation(thread);
  return true;
}

// Take ONE held reply out of the queue, by its own identity: the removal an empty save makes and the removal the
// entry's × makes — one path, so "it goes" means the same thing however it was asked for. No other held reply on the
// thread is touched, and nothing is sent.
function takeQueuedReply(thread, at) {
  const q = replyQueued(thread);
  const i = q.findIndex((e) => e && e.at === at);
  if (i < 0) return null;
  const [entry] = q.splice(i, 1);
  if (!q.length) state.replyQueue.delete(thread);
  else state.replyQueue.set(thread, q);
  // An editor open on the entry that just left has nothing left to edit.
  const edit = queuedEditFor(thread);
  if (edit && edit.at === at) state.replyEdit = null;
  return entry;
}

// Clicking anywhere outside the open editor means the same one thing every time: REVERT — exactly what Escape means.
// An edit is therefore only ever committed by Enter or Save, an accidental click can never write text the reader had
// not finished, and no click can send anything. The editor's own box and buttons are not "away".
function revertEditOnClickAway(target) {
  const edit = state.replyEdit;
  if (!edit) return false;
  if (target && target.closest && target.closest(`.ghost-edit[data-edit-for="${edit.at}"]`)) return false;
  return cancelQueuedEdit(edit.thread, edit.at);
}

// The editor's own keys. Registered here, before the card's reply-box handler, so a keystroke in the editor is never
// read as a gesture meant for the reply box: Enter saves, Shift+Enter stays the newline the textarea makes it, Escape
// leaves the entry as it was. No key here sends and no key here steers.
document.addEventListener("keydown", (e) => {
  const box = e.target?.closest?.(".ghost-edit-box");
  if (box) {
    const thread = box.dataset.editThread;
    const at = Number(box.dataset.editQueued) || 0;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelQueuedEdit(thread, at);
      return;
    }
    if (e.key === "Enter") {
      // Only a bare Enter saves. Shift+Enter is left alone: it stays the newline the textarea makes of it, exactly as
      // it does in every other box on the page.
      if (!e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        saveQueuedEdit(thread, at);
      }
    }
    return;
  }
  // The held reply's own line is reachable from the keyboard, so the editor is not a mouse-only affordance.
  const prompt = e.target?.closest?.("[data-edit-queued-open]");
  if (prompt && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    e.stopPropagation();
    openQueuedEdit(prompt.dataset.editThread, Number(prompt.dataset.editQueuedOpen) || 0);
  }
});

// What the reader is typing, kept on state as they type it: a repaint (the turn ending, a subagent line landing)
// rebuilds the card and the textarea with it, and the editor is drawn from this rather than from the DOM that went
// away — so an edit in progress cannot be thrown out from under the reader.
document.addEventListener("input", (e) => {
  const box = e.target?.closest?.(".ghost-edit-box");
  if (!box) return;
  const edit = queuedEditFor(box.dataset.editThread);
  if (!edit || edit.at !== (Number(box.dataset.editQueued) || 0)) return;
  edit.text = box.value;
  growReplyBox(box);
});

// Why a held reply must NOT be sent right now, asked in ONE place so the two reasons can never disagree about the
// same entry:
//   "cancelled" — the reader took that entry back: it is out of the queue (the × takes it out; a flagged entry is the
//                 same answer), so it is never sent and the queue moves on without it
//   "editing"   — the reader has that entry open in its editor: it stays exactly where it is, holding everything
//                 behind it, and becomes sendable again when the edit is saved
// The × and the editor only ever change the state this reads, and the drain has no second opinion of its own. Asked
// about a held entry, the two answers it can give are "the reader is editing this" and ""; "cancelled" is what an entry
// the drain captured but the queue no longer carries looks like, so a × that removes its entry (or one that flags it)
// is answered here rather than by a check of the drain's own.
function heldReplyBlocked(thread, entry) {
  if (!entry) return "";
  if (entry.cancelled) return "cancelled";
  if (!replyQueued(thread).some((e) => e && e.at === entry.at)) return "cancelled";
  const edit = queuedEditFor(thread);
  return edit && edit.at === entry.at ? "editing" : "";
}

// The entries the drain has taken out of a thread's queue to send, newest last, so a × pressed after the send
// can tell "already sent" apart from "never held". Bounded: it is a record of the last few press answers, not a
// history of the thread.
function markReplySent(thread, entry) {
  const sent = state.replySent.get(thread) || [];
  sent.push({ at: entry.at, text: entry.text });
  state.replySent.set(thread, sent.slice(-8));
}

function replyTakenByDrain(thread, at) {
  return (state.replySent.get(thread) || []).some((entry) => entry.at === at);
}

// The × on a queued entry. It is keyed on the ENTRY's own identity — its `at` — never on the thread, so two
// held replies stay independent: cancelling the first leaves the second scheduled and still sending. An
// accidental × gives the text back as the draft when that thread's reply box is EMPTY, and leaves a box that
// already holds something alone (the reader's own words there are not ours to overwrite).
function cancelQueuedReply(thread, at) {
  // The removal is takeQueuedReply — the same one an empty save makes, so there is ONE way out of this queue and not
  // two. It keys on the entry's own `at`, and it closes an editor left open on the entry it takes, which is what keeps
  // the × working while the reader is editing one.
  const entry = takeQueuedReply(thread, at);
  if (!entry) {
    // The race, and the only two honest answers: the drain has already taken this entry out and its send is on
    // its way (the press cannot call it back, so say so), or it is simply not held here any more.
    const sent = replyTakenByDrain(thread, at);
    renderConversation(thread);
    const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
    if (warn) warn.textContent = sent ? "that one was already sent" : "that queued reply is no longer held";
    return sent ? "sent" : "gone";
  }
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // The box's own text, read the one way a prompt box is read now (a chip is the text it swallowed): the
  // answer decides whether the cancelled reply can come back as a draft.
  const backToDraft = Boolean(box && !readBox(box).trim() && entry.text);
  if (backToDraft) state.replyDrafts[thread] = entry.text;
  renderConversation(thread);
  // After the repaint: a rebuild replaces the card and the warnline with it, so the note goes in last.
  const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
  if (warn) {
    warn.textContent = backToDraft
      ? "that queued reply is cancelled — the text is back in the box as your draft"
      : "that queued reply is cancelled";
  }
  return "cancelled";
}

// Children this thread started that are still working. A finished parent turn with children out is not "busy"
// in the run sense, but a reply sent then races them: the parent starts a new turn while its own children are
// still writing. So the queue waits for them too.
function childrenOut(thread) {
  if (!thread) return false;
  if ((subagentFallback.get(thread) || []).some((s) => s && s.running)) return true;
  return [...state.jobs.values()].some(
    (j) => (j.thread || j.id) === thread && (j.subagents || []).some((s) => s && s.running),
  );
}

function threadBusy(thread) {
  return [...state.jobs.values()].some((j) => (j.thread || j.id) === thread && turnLive(j));
}

async function drainReplyQueue(thread) {
  // The next entry is read here, then the queue is re-read at send time and that entry is looked up by its own
  // identity (`at`): the turn finishing and the reader working on a held reply can land in the same moment. ONE guard
  // answers for both of the reasons an entry must not be sent — the reader took it back with its ×, or the reader has
  // it open in its editor — so the queue has no second check that could disagree with either of them.
  const next = replyQueued(thread)[0];
  if (!next || threadBusy(thread) || childrenOut(thread)) return;
  const blocked = heldReplyBlocked(thread, next);
  if (blocked === "editing") {
    // Held, not sent: the entry keeps its place and its age, the card says why it is waiting, and saving the edit is
    // what makes it sendable again. Everything behind it waits with it, so the queue cannot re-order around it.
    renderConversation(thread);
    return;
  }
  if (blocked === "cancelled") {
    // Gone, not sent: an entry the reader took back leaves the queue, and the queue moves on to the one behind it.
    const rest = replyQueued(thread).filter((e) => e && !e.cancelled && e.at !== next.at);
    if (rest.length) state.replyQueue.set(thread, rest);
    else state.replyQueue.delete(thread);
    renderConversation(thread);
    return void drainReplyQueue(thread);
  }
  const q = state.replyQueue.get(thread) || [];
  const i = q.findIndex((entry) => entry && entry.at === next.at);
  if (i < 0) return;
  const [entry] = q.splice(i, 1);
  if (!q.length) state.replyQueue.delete(thread);
  else state.replyQueue.set(thread, q);
  // Out of the queue, so the send is already on its way and no press can call it back — which is what a ×
  // landing after this point has to say, instead of claiming a cancellation that did not happen.
  markReplySent(thread, entry);
  renderConversation(thread);
  try {
    await sendReply(thread, entry.text);
  } catch {
    /* sendReply reports its own errors */
  }
}

// ---- New-agent prompt history ---------------------------------------------------------
// Shell-style recall for the spawn box: Up walks back through what you have spawned, Down walks
// forward, and whatever you were part-way through typing is kept as the "draft" at the end (back 0).
// Persisted, because the prompt worth reusing is usually from a previous session, not this one.
// (SPAWN_HISTORY_KEY / SPAWN_HISTORY_MAX live at the top of the file, above `state`.)

// ---- what a worktree is called on the board -------------------------------------------------
// A tree is cut from the prompt, so its directory name is the prompt: 24 characters, usually mid-word. Hermes names
// the session from the work itself a moment later ("Fix delete worktree button not removing directory"), and that is
// the name the row should read. A name typed onto the row wins over both; the directory name stays visible beside it,
// because that is what is on disk.
function loadTreeNames() {
  try {
    const raw = JSON.parse(localStorage.getItem(TREENAMES_KEY) || "{}");
    const map = new Map();
    for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
      if (typeof v === "string" && v.trim()) map.set(k, v.trim().slice(0, 120));
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveTreeNames() {
  try {
    const out = {};
    for (const [k, v] of state.treeNames) out[k] = v;
    localStorage.setItem(TREENAMES_KEY, JSON.stringify(out));
  } catch {
    /* storage full or blocked: the board keeps showing the name for this session */
  }
}

// The project's own checkout — the directory the project IS, and the parent of every worktree cut from it. Its name
// is the folder's name and nothing else: an agent run in the checkout (a base-checkout run, no tree cut) has a title
// of its own, and letting that title onto this row renames the project on the board after one agent's job.
function isProjectRootRow(row) {
  const root = state.projects.get(row.project)?.path;
  if (!root || !row.path) return false;
  return normPath(root).toLowerCase() === normPath(row.path).toLowerCase();
}

// The name the row shows: what the reader typed, else the agent's own title, else the directory. The project's own
// checkout is exempt from both — it reads the folder's name, whatever agents have run in it and whatever was stored
// against its key.
function treeTitleOf(row) {
  if (isProjectRootRow(row)) return "";
  const own = state.treeNames.get(keyOf(row.project, row.path));
  if (own) return own;
  const a = agentsFor(row)[0];
  return String(a?.latest?.title || a?.first?.title || "").trim();
}

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
  // What the walk started from is read through readBox: a chip in the draft is part of what the reader had.
  const nav = state.spawnNav && state.spawnNav.back > 0 ? state.spawnNav : { back: 0, stash: readBox(box) };
  const back = Math.max(0, Math.min(prompts.length, nav.back + step));
  const value = back === 0 ? nav.stash : prompts[prompts.length - back];
  state.spawnNav = { back, stash: nav.stash };
  // A recalled prompt REPLACES what the box holds, chips included: the recalled text becomes the content,
  // so it goes through the one writer and the previous draft's chip model goes with it.
  writeBox(box, value);
  clearBoxDraft(box);
  setCaretOffset(box, value.length);
  return true;
}

function recallReply(box, step) {
  const thread = box.dataset.reply;
  if (!thread) return;
  const prompts = turnPrompts(thread);
  if (!prompts.length) return;
  const nav = state.replyNav.get(thread) || { back: 0, stash: readBox(box) };
  // `back` counts steps behind the draft: 0 = what you were typing, 1 = newest prompt, 2 = the one
  // before it, and so on.
  const back = Math.max(0, Math.min(prompts.length, nav.back + step));
  const value = back === 0 ? nav.stash : prompts[prompts.length - back];
  // `current` is what the recall put there: it is how the next Up knows the box is showing history rather than
  // the reader's own draft, so it may keep walking instead of only moving the caret.
  state.replyNav.set(thread, { back, stash: nav.stash, current: value });
  // A recalled prompt replaces what the box holds, chips included: the model goes with the draft it made.
  writeBox(box, value);
  clearBoxDraft(box);
  setCaretOffset(box, value.length);
  state.replyDrafts[thread] = value;
}

// What the "▶ continue" button on a stopped card sends. One sentence, on purpose: the agent decides for itself
// whether there is work left, and an agent whose task is done is told plainly that exiting is allowed.
const CONTINUE_TEXT = "Continue if you can, exit if you are done";

// The not-running pill is this: one click sends that nudge and starts the next turn, so a stopped agent can be
// picked up without typing anything. Failures land in the card's own warning line, where a reply failure already
// goes. The button's text is the status, so "starting" is said with the refresh glyph turning, not by replacing the
// word - a pill that reads STARTING… would be claiming a status the panel does not know yet.
async function continueThread(thread, btn = null) {
  if (!thread) return;
  if (btn && btn.isConnected) {
    btn.disabled = true;
    btn.classList.add("is-starting");
  }
  const started = await sendReply(thread, CONTINUE_TEXT);
  // The card's own warning line is easy to miss when the card is folded, so a failed nudge also says it out loud.
  if (!started) showBanner(`could not continue that agent — see the card's reply line for why`);
  // The card is usually rebuilt by the reply, so this node may be gone; only touch it if it is still on the page.
  if (btn && btn.isConnected) {
    btn.disabled = false;
    btn.classList.remove("is-starting");
  }
}

// The re-attach pill's press (the not-running pill on a card this panel has no line to). One card, one question
// (POST /api/jobs/reattach), and the server runs it through reconcileRestored's own decision, so a press and a boot
// can never disagree about what the gateway answered. The card repaints itself from the job events that decision
// emits; what is added here is the sentence for the reader — and, on the answer that settles the card, the press
// then continues the thread, which is the pick-up the reader asked for.
async function reattachCard(btn) {
  const id = btn.dataset.reattachJob || "";
  if (!id) return;
  btn.disabled = true;
  btn.classList.add("is-starting");
  try {
    const res = await apiFetch("/api/jobs/reattach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      showBanner(out.error || `could not ask the gateway about that run (HTTP ${res.status})`);
      return;
    }
    // Forgotten: the card is settled, and there is nothing here left to watch — so the press finishes what it
    // promised. The thread is continued on the spot, exactly as the same pill does on every other stopped card, and
    // the settled card keeps the tree and the PR on its console for whatever the agent cannot remember.
    if (out.action === "gone") {
      showNote(`the gateway has no record of run ${out.runId} — the card is settled, and this agent is being picked up`);
      const thread = btn.closest(".job")?.dataset.thread || "";
      if (thread) await continueThread(thread, null);
      return;
    }
    showNote(
      out.action === "reattached"
        ? `the gateway still has run ${out.runId} — this card is re-attached to it and can steer it again`
        : out.action === "adopted"
          ? `the gateway had already finished run ${out.runId} — its result is on the card`
          : `asked the gateway about run ${out.runId || "this turn"}`,
    );
  } catch (e) {
    showBanner(`could not ask the gateway about that run — ${String((e && e.message) || e)}`);
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove("is-starting");
    }
  }
}

// The COMPLETE chip's press, on a card whose latest turn is `done`. It is deliberately NOT the continue pill: nothing is
// sent to the agent that already finished (it is finished — nudging it is the one thing this press must not do), and the
// panel does not start an assistant turn either, which would talk over a run already in flight. Instead one message is
// QUEUED for the board assistant through the wake queue an alert handed over uses (POST /api/jobs/ask-complete ->
// Assistant.askAboutComplete -> wake), so it lands in the assistant's next turn inside its hourly budget. The pill says
// the ask happened; a queue that refuses it (the hourly budget, or an assistant switched off) says WHY on the card, in
// the place a failed nudge already speaks, and the pill is then left as it was rather than claiming a success.
async function askComplete(btn) {
  const id = btn.dataset.completeAsk || "";
  if (!id) return;
  btn.disabled = true;
  btn.classList.add("is-asking");
  try {
    const res = await apiFetch("/api/jobs/ask-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      showBanner(out.error || `could not queue the check for the assistant (HTTP ${res.status})`);
      return;
    }
    // Already asked and the assistant has not turned yet: the ask IS queued, so the chip says asked — but nothing was
    // queued twice, and the card says so rather than letting a second press look like a second ask.
    if (out.duplicate) {
      markChipAsked(btn);
      showNote(`that check is already in the assistant's queue (asked ${out.at || "just now"}) — nothing was queued twice`);
      return;
    }
    // Refused: the wake queue would not take it. Never claim otherwise — the pill stays as it was and the card says why.
    if (!out.queued) {
      showBanner(out.reason || "the assistant's wake queue refused that ask — nothing was queued");
      return;
    }
    markChipAsked(btn);
    showNote(`queued one check for the board assistant — it is asked to look at ${out.thread || "that"} and say whether it is really complete`);
  } catch (e) {
    showBanner(`could not queue the check for the assistant — ${String((e && e.message) || e)}`);
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove("is-asking");
    }
  }
}

// The chip's own short state change, so the reader can see the press landed without reading the card's footer. No glyph
// either way: the not-running pill's ↻ says "this resumes something", which is exactly what this one does not do.
function markChipAsked(btn) {
  if (!btn || !btn.isConnected) return;
  btn.classList.add("is-asked");
  btn.textContent = "asked";
}

// The green ▶ on a worktree row: ask every agent in that worktree that is NOT running to carry on. One sentence each,
// sent together; a running agent is left alone - a reply to it would queue behind its turn, which is not probing.
async function probeWorktreeAgents(path, btn = null) {
  const mine = agentsByPath().get(normPath(path).toLowerCase()) || [];
  if (!mine.length) {
    showBanner("no agents in this worktree yet — the + under the agents starts one");
    return;
  }
  const stopped = mine.filter((c) => !convLive(c));
  if (!stopped.length) {
    showBanner(`all ${mine.length} agent${mine.length === 1 ? "" : "s"} in this worktree are already running`);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-probing");
  }
  let ok = 0;
  let failed = 0;
  await Promise.all(
    stopped.map(async (c) => {
      if (await sendReply(c.thread, CONTINUE_TEXT)) ok += 1;
      else failed += 1;
    }),
  );
  if (btn && btn.isConnected) {
    btn.disabled = false;
    btn.classList.remove("is-probing");
  }
  showBanner(`probed ${ok} not-running agent${ok === 1 ? "" : "s"} in this worktree${failed ? ` · ${failed} failed to send` : ""}`);
}

// The add-agent control, in both shapes: the green + bar, and the text field it turns into. One builder, because the
// row is rebuilt on every scan and the open field has to come back identical - value, attributes and all.
function addAgentBarHtml({ key = "", path = "", name = "", project = "", value = null }) {
  const attrs = `data-add-agent-key="${esc(key)}" data-add-agent-path="${esc(path)}" data-add-agent-name="${esc(name)}" data-add-agent-project="${esc(project)}"`;
  if (value === null) {
    return `<button type="button" class="btn-add-agent" ${attrs} title="start a Hermes agent in this worktree — click, type the first turn, Enter starts it (it runs here, no new worktree)"><span aria-hidden="true">+</span></button>`;
  }
  return (
    `<div class="add-agent-form">` +
    // A contenteditable host, like the reply box: this field is where a prompt is often pasted in from a
    // document, so a paste that big collapses to a chip here too. It keeps the single-line behaviour it had
    // as an <input> (data-single strips line breaks out of a short paste; Shift+Enter adds none).
    `<div class="add-agent-input chipbox" contenteditable="true" role="textbox" data-single="1" ${attrs} data-chipbox="add:${esc(key)}" spellcheck="false" autocomplete="off" data-form-type="other" data-1p-ignore data-bwignore data-lpignore="true"` +
    ` data-ph="what should this agent do here?  Enter starts it · Esc puts the + back"></div>` +
    `</div>`
  );
}

// Same key in, same key out: the field replaces the bar in place so the row does not change height.
function swapAddAgentBox(key, html) {
  const sel = `[data-add-agent-key="${CSS.escape(key)}"]`;
  const field = document.querySelector(`.add-agent-input${sel}`);
  const form = field?.closest(".add-agent-form") || null;
  const btn = document.querySelector(`.btn-add-agent${sel}`);
  const current = form || btn;
  if (!current) return null;
  current.insertAdjacentHTML("afterend", html);
  const fresh = current.nextElementSibling;
  current.remove();
  return fresh;
}

// Clicking the + does not send the reader to the New agent card any more: it turns the bar into a field here. The
// prompt is handed to that card only on submit, aimed at this worktree with the panel's defaults, and started.
function openAddAgent(btn) {
  const key = btn.dataset.addAgentKey || keyOf(btn.dataset.addAgentProject || "", btn.dataset.addAgentPath || "");
  const a = {
    key,
    path: btn.dataset.addAgentPath || "",
    name: btn.dataset.addAgentName || "",
    project: btn.dataset.addAgentProject || "",
    value: "",
    start: 0,
    end: 0,
    focused: true,
  };
  // One field at a time: an open box on another row becomes a + again.
  const prev = state.addAgent;
  if (prev && prev.key !== key) swapAddAgentBox(prev.key, addAgentBarHtml({ ...prev, value: null }));
  state.addAgent = a;
  const fresh = swapAddAgentBox(key, addAgentBarHtml({ ...a, value: "" }));
  fresh?.querySelector(".add-agent-input")?.focus({ preventScroll: true });
}

// Esc, an empty blur, or a run that has started: the + comes back.
function closeAddAgent() {
  const a = state.addAgent;
  if (!a) return;
  state.addAgent = null;
  swapAddAgentBox(a.key, addAgentBarHtml({ ...a, value: null }));
}

// Enter in the field: hand the prompt to the New agent card, aimed at this worktree, with the panel's defaults, and
// start it there - the card is where a run is built, so the field is a shortcut into that same path rather than a
// second spawn implementation.
async function submitAddAgent(input) {
  const a = state.addAgent;
  if (!a) return;
  const typed = String((input ? readBox(input) : a.value) ?? "").trim();
  if (!typed) {
    input?.focus();
    return;
  }
  // Agents in one worktree share it. Say so once before a second one starts editing the same files; the text stays
  // in the box if the reader says no.
  const mine = agentsByPath().get(normPath(a.path).toLowerCase()) || [];
  if (mine.length) {
    const running = agentsRunning(mine);
    const ok = window.confirm(
      `${mine.length} agent${mine.length === 1 ? " already works" : "s already work"} in ${a.name}` +
        `${running ? ` (${running} running now)` : ""}.\n\n` +
        `They share the same working tree: commits can collide (index.lock), and each sees the other's edits as its own dirty files.\n\n` +
        `Start another agent here anyway?`,
    );
    if (!ok) {
      input?.focus();
      return;
    }
  }
  a.value = typed;
  aimSpawnAtWorktree(a.path, a.name, a.project);
  resetSpawnDefaults();
  const box = $("job-prompt");
  if (box) {
    // The field's text becomes the card's prompt — a pasted block travels as a chip, not as flattened
    // text, so the run still receives every character of it.
    transferBoxModel(`add:${a.key}`, box, typed);
    growReplyBox(box);
  }
  state.addAgent = null;
  swapAddAgentBox(a.key, addAgentBarHtml({ ...a, value: null }));
  await spawnAgent({ promptFocus: false });
  // spawnAgent clears the prompt on success and leaves it on a refusal, which is the only signal it gives back.
  if (String(readBox($("job-prompt")) || "").trim()) {
    const why = String($("spawn-msg")?.textContent || "").trim();
    showBanner(`could not start that agent — ${why || "the New agent card says why"}`);
  }
}

// ---- the inline add-agent field's own events ------------------------------------------------------
// The field lives inside a row that is rebuilt on every scan, so what the reader types is remembered by input, not by
// node: the draft, the caret, and whether they were in it. Escape and Enter are handled in the capture phase so the
// board's own Escape (close the maximized card) does not fire behind them.
const addAgentFieldOf = (e) => (e.target && e.target.closest ? e.target.closest(".add-agent-input") : null);

document.addEventListener(
  "keydown",
  (e) => {
    const input = addAgentFieldOf(e);
    if (!input) return;
    if (e.key === "Enter" && e.shiftKey) {
      // This box is ONE LINE — it was an <input> until it learned to hold a chip — so Shift+Enter adds no
      // line here, exactly as it added none before.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      void submitAddAgent(input);
      return;
    }
    // Ctrl/Cmd/Alt+Enter means nothing in a one-line field — an <input> ignored it outright — so it is swallowed
    // here rather than allowed to put a line break into a box that never had one.
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAddAgent();
      return;
    }
    rememberAddAgentCaret(input);
  },
  true,
);

document.addEventListener("input", (e) => {
  const input = addAgentFieldOf(e);
  if (!input || !state.addAgent) return;
  state.addAgent.value = readBox(input);
  rememberAddAgentCaret(input);
});

document.addEventListener("keyup", (e) => {
  const input = addAgentFieldOf(e);
  if (input) rememberAddAgentCaret(input);
});
document.addEventListener("click", (e) => {
  const input = addAgentFieldOf(e);
  if (input) rememberAddAgentCaret(input);
});

document.addEventListener("focusin", (e) => {
  const input = addAgentFieldOf(e);
  if (!input || !state.addAgent) return;
  state.addAgent.focused = true;
  rememberAddAgentCaret(input);
});

document.addEventListener("focusout", (e) => {
  const input = addAgentFieldOf(e);
  if (!input || !state.addAgent) return;
  rememberAddAgentCaret(input);
  // A repaint takes this field out of the page and puts it back, which fires focusout with no reader behind it. Every
  // such move is bracketed by beginDomMove()/endDomMove(); while one is open the reader still owns the caret, so the
  // claim is not cleared and the restore at the end of the move re-focuses the box.
  if (domMoveDepth > 0) return;
  state.addAgent.focused = false;
  // An empty box that the reader left puts the + back. Deferred, and skipped when the node was removed: a repaint
  // also fires focusout, and that is not the reader walking away from an empty field.
  setTimeout(() => {
    if (!input.isConnected) return;
    if (state.addAgent && !String(state.addAgent.value || "").trim()) closeAddAgent();
  }, 0);
});

// ---- moving nodes without letting go of the caret ------------------------------------------------
// Almost every repaint here takes nodes out of the page and puts them back: a re-ranked row is re-appended, a detail
// follows its row, a project section is swapped, the whole board is rebuilt. Detaching the node that holds a focused
// field blurs it, and a blur cannot be told apart from the reader walking away - which is how the inline field used
// to lose its claim (and the caret) several times a second on a busy board. One call brackets the move: while a move
// is open a blur leaves the claim alone, and the restore that ends the move puts the caret back.
let domMoveDepth = 0;
function beginDomMove() {
  domMoveDepth += 1;
}
function endDomMove() {
  domMoveDepth = Math.max(0, domMoveDepth - 1);
}

function rememberAddAgentCaret(input) {
  const a = state.addAgent;
  if (!a || !input) return;
  // A node taken out of the page reports its selection as 0, so a blur during a move would record the caret at the
  // start of the text and the restore after the move would put it there. The value is already tracked by the input
  // event; only a field that is still on the page can say where the caret is.
  if (!input.isConnected) return;
  a.value = readBox(input);
  const at = caretOffset(input);
  a.start = Math.min(at, a.value.length);
  a.end = a.start;
}

async function sendReply(thread, preset = null) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // The one place a box's text is read. A chip serializes back to the text it swallowed, IN PLACE: quotes
  // the reader put around it and the prose on either side arrive in the order they are on screen.
  const typed = String(preset ?? (box ? readBox(box) : "")).trim();
  const attached = attachmentBlock(thread);
  if (!typed && !attached) return false;
  const text = typed + attached;
  // The typed part only: the attachment block is panel-added, and recalling it would duplicate the files.
  rememberReply(thread, typed);
  const btn = document.querySelector(`.btn-reply[data-thread="${CSS.escape(thread)}"]`);
  if (btn) btn.disabled = true;
  // The assistant's thread is answered through its own route: the server attaches the scratchpad and the
  // board digest to that turn, and a plain reply here would start a turn with neither.
  const toAssistant = thread === state.assistantThread;
  try {
    const r = await apiFetch(toAssistant ? "/api/assistant/say" : "/api/agents/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toAssistant ? { text } : { thread, text, attachments: attachmentsFor(thread) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.replyDrafts[thread] = "";
    clearAttachments(thread);
    // A sent reply ends the history walk: the next Up starts from the newest prompt again.
    state.replyNav.delete(thread);
    state.justSent.set(thread, { text: typed, at: Date.now() });
    // The captured node may already have been replaced by a repaint that landed while the POST was in flight,
    // so clear the box that is on the page now, not the one this function started with. A queued reply must not
    // wipe something the reader has since typed, hence the preset guard.
    const live = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    if (live && (preset == null || !readBox(live).trim() || readBox(live).trim() === typed)) {
      writeBox(live, "");
      clearBoxDraft(live);
    }
    if (box && box !== live && (preset == null || !readBox(box).trim())) {
      writeBox(box, "");
      clearBoxDraft(box);
    }
    updateJob(d.job, { scroll: true });
    if (d.assistant && typeof applyAssistant === "function") applyAssistant(d.assistant);
    // Sending a reply is you switching to the new turn: fold everything before it, including turns
    // you had opened by hand, so the card shows one full chat — the one you are now in — instead of
    // that one plus the scrollback you were reading a moment ago. The assistant's card sits in a fixed
    // panel, so there is no page position to hold there.
    if (!toAssistant) focusNewTurn(thread, d.job.id);
    // Sending is one keystroke away from the follow-up: keep the caret in the box instead of dropping
    // it (the click on Send used to move focus to the button, and the rebuild replaces the textarea).
    focusReplyBox(thread);
    setTimeout(() => focusReplyBox(thread), 0);
    setTimeout(() => focusReplyBox(thread), 80);
    return true;
  } catch (err) {
    const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
    if (warn) warn.textContent = `reply failed: ${err.message}`;
    return false;
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
  rememberReply(thread, typed);
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch("/api/jobs/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text: body, attachments: attachmentsFor(thread) }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      // A run parked inside delegate_task, or one whose live agent the gateway's authority cannot hand a steer
      // to, answers 409 rather than swallowing the text. Queue it instead of handing it back: the reader's
      // instruction is still what they want next, and Queue is the action that survives this state.
      const code = String(out.code || "");
      const refused = res.status === 409 && (!code || code === "run_not_accepting_steer" || code === "steer_not_accepted");
      if (refused) {
        queueReply(thread, body);
        state.replyDrafts[thread] = "";
        clearAttachments(thread);
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        if (box) {
          writeBox(box, "");
          clearBoxDraft(box);
        }
        if (warn) warn.textContent = "this turn cannot take a steer right now — queued; it sends when the turn and its subagents are done";
        if (btn) btn.disabled = false;
        return true;
      }
      if (warn) warn.textContent = out.error || `steer refused (HTTP ${res.status})`;
      if (btn) btn.disabled = false;
      return false;
    }
    // The text went into the LIVE turn, so clear the draft: leaving it would invite sending the same
    // instruction twice, once as a steer and once as the next turn.
    state.replyDrafts[thread] = "";
    clearAttachments(thread);
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    if (box) {
      writeBox(box, "");
      clearBoxDraft(box);
    }
    if (warn) {
      // A steer only lands at a tool boundary, and `delegate_task` is one call that can run for minutes: say what
      // it is waiting for, and what happens if the wait outlasts the turn.
      const waitingOn = inflightToolName(jobLines(id));
      warn.textContent = waitingOn === "delegate_task"
        ? "steered — it waits for delegate_task to return; if the turn ends first it comes back to this box unsent"
        : "steered — the agent reads this at its next tool boundary";
    }
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

// ---- previous turn on send ---------------------------------------------------------------------------
// Sending a reply puts a new turn on the page, and what becomes of the turn the reader was reading is a
// choice rather than one fixed rule: a small frozen piece of it, the whole thing left as it was, or folded
// down to its one-line peek before the new turn's output is drawn. Settings > Agent cards; saved in this
// browser. The last is the oldest behaviour, and the middle one is why the setting exists at all: the fold
// was removing a console the reader still wanted above the new turn.
const PREV_TURN_KEY = "wtgui.prevTurn";
const PREV_TURN_MODES = ["snippet", "keep", "minimize"];
function prevTurnMode() {
  try {
    const raw = localStorage.getItem(PREV_TURN_KEY);
    return PREV_TURN_MODES.includes(raw) ? raw : "snippet";
  } catch {
    return "snippet";
  }
}

// What the send does to each older turn, as explicit flags. `undefined` means "leave that flag alone" -
// "leave as is" is one of the answers, so a mode must be able to say nothing about a turn at all; writing
// a flag for it would re-open a turn the reader had folded by hand.
function previousTurnPlan(mode, turns) {
  const how = PREV_TURN_MODES.includes(mode) ? mode : "snippet";
  return turns.map((t) => {
    if (how === "keep") return { id: t.id, open: t.open ? true : undefined, compact: t.open ? false : undefined };
    if (how === "minimize") return { id: t.id, open: false, compact: false };
    // freeze a snippet: a turn that was showing keeps a readable piece of itself; one that was already
    // folded stays folded, because it was not taking up room.
    return { id: t.id, open: false, compact: t.open ? true : undefined };
  });
}

function applyPreviousTurnPlan(plan) {
  for (const op of plan) {
    if (op.open === true) state.turnOpen.set(op.id, true);
    else if (op.open === false) state.turnOpen.delete(op.id);
    if (op.compact === true) state.turnCompact.add(op.id);
    else if (op.compact === false) state.turnCompact.delete(op.id);
  }
}

function applyPrevTurnMode(mode) {
  const value = PREV_TURN_MODES.includes(mode) ? mode : "snippet";
  const sel = $("prev-turn-mode");
  if (sel) sel.value = value;
  try {
    localStorage.setItem(PREV_TURN_KEY, value);
  } catch {
    /* private mode: the choice just will not persist */
  }
}
// ---- end previous turn on send ------------------------------------------------------------------------

// Make the new turn the one that is open in its conversation: a reply lands with the turns before it drawn
// the way "Previous turn on send" says to draw them (snippet / keep / minimize). The turn the reader is
// sending into is pinned open either way, so the new turn's output is what is in front of them.
function focusNewTurn(thread, turnId) {
  // The reply box is where the reader's hands are. Folding a turn shortens the card above it, and the box
  // used to travel up by exactly that much; measure it first, put it back after.
  const boxBefore = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  const yBefore = boxBefore ? Math.round(boxBefore.getBoundingClientRect().top) : null;
  const conv = conversations().find((c) => c.thread === thread);
  const at = conv ? conv.turns.findIndex((t) => t.id === turnId) : -1;
  const previous = conv && at > 0 ? conv.turns[at - 1] : null;
  // A new turn means the reader is back at the newest page.
  state.turnPage.delete(thread);
  // What each older turn was showing has to be read BEFORE any flag moves: the turn just finished is open
  // because it was the newest, not because anything is written down about it.
  const older = conv ? conv.turns.filter((t) => t.id !== turnId) : [];
  const plan = previousTurnPlan(
    prevTurnMode(),
    older.map((t) => ({ id: t.id, open: t.id === previous?.id || state.turnOpen.get(turnKey(t)) === true })),
  );
  state.turnOpen.set(turnId, true);
  state.turnCompact.delete(turnId);
  applyPreviousTurnPlan(plan);
  renderConversation(thread);
  scrollThreadToBottom(thread);
  // Put the composer back under the reader's hands (the page clamps at its own ends; a clamped correction just
  // leaves the box where the layout put it).
  const boxAfter = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  if (yBefore != null && boxAfter) {
    const delta = Math.round(boxAfter.getBoundingClientRect().top) - yBefore;
    if (Math.abs(delta) > 1 && Math.abs(delta) < window.innerHeight * 0.9) {
      programmaticScroll();
      window.scrollBy(0, delta);
      refreshAnchorBaseline();
    }
  }
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
    // A pin is a promise about a card that exists; forgetting the thread releases it.
    if (state.anchorThread === thread) setAnchorThread(null);
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

// Answer an approval a run is parked on. Kept as a function so both the click and the pointerup path reach the
// same place; `approvalSent` makes the second of the two a no-op.
async function answerRunApproval(approveBtn) {
  const id = approveBtn.dataset.approve;
  const choice = approveBtn.dataset.choice;
  // The same box, the same four choices, two questions: a run parked on a gateway approval, or a write parked on
  // the panel's own remote-write permission (lib/remote-writes.js). The button is identical, so the ROUTE is
  // decided by which record the id belongs to — never by a second kind of button.
  if (state.rwPending.has(id)) return answerRemoteWrite(id, choice, approveBtn);
  if (approvalAlreadySent(id, choice)) return;
  noteApprovalSent(id, choice);
  const card = approveBtn.closest(".job");
  const warn = card ? card.querySelector("[data-reply-warn]") : null;
  // The window can close between the paint and the press: the gateway has already denied the command and let the
  // agent carry on, so nothing is sent — the box says what happened instead of spending a request to be told
  // "approval_not_pending" (four of those in a row is what this fence exists for).
  const until = Number(approveBtn.dataset.until) || 0;
  if (until && Date.now() >= until) {
    closeApprovalCard(approveBtn.closest(".turn-approval"));
    if (warn) warn.textContent = "that approval had already expired — the gateway denied the command and the agent carried on";
    approvalSent.delete(approvalKey(id, choice));
    return;
  }
  approveBtn.disabled = true;
  try {
    const res = await apiFetch("/api/jobs/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, choice, requestId: approveBtn.dataset.request || null }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      // The panel answers "gone" when the gateway no longer holds the request: the box goes, and the reason is
      // left where the reader is looking rather than on a prompt that can never be answered.
      if (out.gone) closeApprovalCard(approveBtn.closest(".turn-approval"));
      if (warn) warn.textContent = out.error || `approval failed (HTTP ${res.status})`;
      approveBtn.disabled = false;
      approvalSent.delete(approvalKey(id, choice));
    }
  } catch (err) {
    if (warn) warn.textContent = `approval failed: ${err.message}`;
    approveBtn.disabled = false;
    approvalSent.delete(approvalKey(id, choice));
  }
}

// Take the decision away from a card whose request is gone: the buttons become the same note a closed box draws,
// so a click that arrives after the panel answered with `gone` cannot re-post into the same 409.
function closeApprovalCard(card) {
  if (!card || card.classList.contains("is-expired")) return;
  card.classList.add("is-expired");
  const head = card.querySelector(".ta-head");
  if (head) head.textContent = APPROVAL_CLOSED_HEAD;
  const actions = card.querySelector(".ta-actions");
  if (actions) actions.outerHTML = approvalClosedNote();
  // The countdown has nothing left to count, and a stale "~2m left" under a box that is over would be its own
  // small lie. The server-side sweep replaces this box with the one record line within 5s.
  card.querySelector(".ta-foot")?.remove();
}

// ---- approvals ------------------------------------------------------------------
// Requests arrive from the Hermes approval-transport plugin (~/.hermes/plugins/worktree-panel).
// This only records the human's choice: Hermes owns the policy, the timeout and the fail-closed
// behaviour, and a request that expires here is denied there.
const APPROVAL_LABEL = { once: "Allow once", session: "Allow for session", always: "Always allow", deny: "Deny" };

// The dock is folded or not across reloads: it is a corner of the screen, and its state is the reader's.
const APPROVALS_FOLDED_KEY = "wtgui.approvalsFolded";
let approvalThreadsShown = new Set(); // threads that had an approval at the last render

function approvalsFolded() {
  try {
    return localStorage.getItem(APPROVALS_FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

function applyApprovalsFold(dock = $("approvals")) {
  if (!dock) return;
  const folded = approvalsFolded();
  dock.classList.toggle("is-folded", folded);
  const btn = $("btn-dock-approvals");
  if (btn) btn.textContent = folded ? "\u25b8" : "\u25be";
}

// Which agent this request belongs to, by the name the reader knows it by: the card's title, else its label,
// else the thread id. "agent" alone was the surface and said nothing about who was blocked.
function approvalAgentName(r) {
  const thread = r && r.thread ? String(r.thread) : "";
  if (thread) {
    const job = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread);
    if (job) return job.title || job.label || thread;
    return thread;
  }
  return r && r.surface ? String(r.surface) : "agent";
}

function approvalCard(r) {
  const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
  const buttons = (r.allowed || ["once", "deny"])
    .map((c) => {
      const cls = c === "deny" ? "" : c === "once" ? ' class="primary"' : "";
      return `<button type="button"${cls} data-approval-id="${esc(r.id)}" data-approval-choice="${esc(c)}">${esc(APPROVAL_LABEL[c] || c)}</button>`;
    })
    .join("");
  return `<div class="approval" data-approval="${esc(r.id)}">
    <div class="ap-head"><span class="mono ap-agent" title="${esc(r.thread ? `blocked agent: ${r.thread}` : r.surface || "agent")}">${esc(approvalAgentName(r))}</span>${r.thread ? `<button class="sig sig-panel" data-agent-thread="${esc(r.thread)}" title="jump to the agent blocked on this approval">⧉ agent</button>` : ""}<span class="spacer"></span><span class="mono ${left < 20 ? "warn" : "dimmer"}" data-approval-left="${esc(r.id)}">expires in ${left}s</span></div>
    <pre class="ap-cmd mono">${esc(r.command || "(no command text)")}</pre>
    ${r.description ? `<div class="ap-desc dim">${esc(r.description)}</div>` : ""}
    <div class="ap-actions">${buttons}<span class="ap-err mono"></span></div>
  </div>`;
}

// ---- remote writes: the panel's own permission box, in the same dock --------------------------------
// A worktree the panel cut is LOCAL ONLY by default (see Settings > Branches on the remote). When something tries
// to put a branch on a remote anyway — a worker's `git push`, met by the pre-push guard the panel installed, or
// the panel's own merge flow — the question lands here, and it is the SAME box a parked run gets: same amber
// chrome, same four choices, same deadline and countdown (permissionBoxHtml). Deny leaves the remote untouched;
// Allow tells the waiting hook to go ahead.
state.rwPending = state.rwPending || new Map(); // id -> request still waiting for an answer
state.rwDecided = state.rwDecided || new Map(); // id -> what was decided, shown as the collapsed line
state.rwPolicy = state.rwPolicy || "local-only";

function applyRemoteWrites(rw) {
  state.rwPolicy = (rw && rw.policy) || state.rwPolicy;
  state.rwPending.clear();
  for (const r of (rw && rw.pending) || []) if (r && r.id) state.rwPending.set(r.id, r);
  renderApprovals();
}

// One parked write. The head names the tree, because a reader answering three of these needs to know WHICH tree is
// asking; the command line is what will actually run.
function remoteWriteBoxHtml(r) {
  const deadline = Number(r.deadline) || 0;
  const windowMs = (Number(r.timeoutSeconds) || 0) * 1000;
  const closed = Boolean(deadline) && deadline - Date.now() <= 0;
  const kind = r.kind === "merge" ? "the panel's own merge flow" : "a push from this worktree";
  return permissionBoxHtml({
    id: r.id,
    requestId: r.id,
    forAttr: `data-remote-write="${esc(r.id)}" data-rw-tree="${esc(r.worktree || "")}"`,
    head: `⚠ waiting on you — ${esc(kind)}: ${esc(r.project || "this project")} is local-only`,
    command: r.command || "",
    choices: Array.isArray(r.allowed) && r.allowed.length ? r.allowed : ["once", "session", "always", "deny"],
    deadline,
    windowMs,
    closed,
    closedHead: "⚠ no answer inside the panel's window — this write has been denied",
    closedNote: `<div class="ta-note mono">the panel stopped waiting and told the writer no; nothing was pushed</div>`,
    what: "write",
    titles: {
      once: "allow this one write — the waiting push is told to go ahead",
      session: "allow writes from this worktree until the panel restarts",
      always: "allow remote writes from now on — this WRITES the panel's setting, so the box stops asking",
      deny: "refuse: nothing is pushed and the remote is left exactly as it is",
    },
  });
}

function remoteWriteDecidedHtml(d) {
  const denied = String(d.choice || "") === "deny";
  const verb = denied ? (d.expired ? "not answered — denied" : "denied") : `allowed ${d.choice}`;
  return `<div class="turn-approval-done mono${denied ? " is-deny" : ""}" title="${esc(d.why || "")}">${denied ? "✕" : "✓"} remote write ${esc(verb)}${d.command ? `: ${esc(String(d.command).slice(0, 140))}` : ""}</div>`;
}

function renderApprovals() {
  const sec = $("approvals");
  if (!sec) return;
  const list = [...state.approvals.values()].sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
  const writes = [...state.rwPending.values()].sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
  const decided = [...state.rwDecided.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 3);
  sec.hidden = list.length === 0 && writes.length === 0 && decided.length === 0;
  applyApprovalsFold(sec);
  // The card that says "waiting on you →" is part of the same fact: repaint the threads whose answer changed,
  // instead of leaving the chip on a stale card until the next job event happens to arrive.
  const threadsNow = new Set(list.map((r) => r && r.thread).filter(Boolean));
  for (const thread of new Set([...threadsNow, ...approvalThreadsShown])) {
    if (threadsNow.has(thread) === approvalThreadsShown.has(thread)) continue;
    if (document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)) renderConversation(thread);
  }
  approvalThreadsShown = threadsNow;
  const total = list.length + writes.length;
  if (!total && !decided.length) {
    $("approval-list").innerHTML = "";
    $("approval-chips").innerHTML = "";
    return;
  }
  $("approval-chips").innerHTML = total ? `<span class="chip bad">${total}</span>` : "";
  // The panel's own questions lead (they are the ones holding a worker's push), then the CLI-transport approvals,
  // then the collapsed records of writes already decided.
  $("approval-list").innerHTML =
    writes.map(remoteWriteBoxHtml).join("") + list.map(approvalCard).join("") + decided.map(remoteWriteDecidedHtml).join("");
}

function tickApprovals() {
  for (const r of state.approvals.values()) {
    const el = document.querySelector(`[data-approval-left="${CSS.escape(r.id)}"]`);
    if (!el) continue;
    const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
    el.textContent = left ? `expires in ${left}s` : "expired";
    el.classList.toggle("warn", left < 20);
  }
  // …and a run's own approval box, which carries the gateway's window: its label counts down, and at the deadline
  // the buttons go. The panel's sweep removes the box a moment later (5s), and this is what covers the gap so the
  // reader never presses a choice the gateway has already refused.
  const now = Date.now();
  for (const card of document.querySelectorAll(".turn-approval .ta-foot[data-approval-until]")) {
    const until = Number(card.dataset.approvalUntil) || 0;
    const windowMs = Number(card.dataset.approvalWindow) || 0;
    const left = until - now;
    if (windowMs) {
      const fill = card.querySelector(".ta-timer > span");
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, (left / windowMs) * 100)).toFixed(2)}%`;
    }
    const box = card.closest(".turn-approval");
    const label = card.querySelector(".ta-left");
    if (label) label.textContent = left <= 0 ? "expired" : `~${fmtLeft(left)} left`;
    card.classList.toggle("is-low", left > 0 && left <= 20_000);
    card.classList.toggle("is-over", left <= 0);
    if (left <= 0) closeApprovalCard(box);
  }
}
setInterval(tickApprovals, 1000);

// A background repaint can replace the button between the press and the release, and a click is only delivered
// when both land on the same node - so a parked run that keeps emitting events made its own approval buttons
// unclickable. Both answer paths are therefore driven from pointerup (the element under the cursor at release,
// even a freshly rebuilt one), and this records the choice so the click that sometimes follows does not send it
// twice.
const approvalSent = new Map(); // `${id}|${choice}` -> when it was sent

function approvalKey(id, choice) {
  return `${id || ""}|${choice || ""}`;
}

function approvalAlreadySent(id, choice) {
  const at = approvalSent.get(approvalKey(id, choice));
  return Boolean(at && Date.now() - at < 4000);
}

function noteApprovalSent(id, choice) {
  approvalSent.set(approvalKey(id, choice), Date.now());
  if (approvalSent.size > 40) {
    const cut = Date.now() - 60000;
    for (const [k, at] of approvalSent) if (at < cut) approvalSent.delete(k);
  }
}

async function answerApproval(id, choice, btn) {
  if (approvalAlreadySent(id, choice)) return;
  noteApprovalSent(id, choice);
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
      // Nothing was accepted, so the same choice may be pressed again at once.
      approvalSent.delete(approvalKey(id, choice));
    }
  } catch (e) {
    if (err) err.textContent = e.message;
    card?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    approvalSent.delete(approvalKey(id, choice));
  }
}

// Answer a parked remote write. The waiting side is a shell process on this box (the pre-push guard) or the
// panel's own merge flow, and both are told through the panel: this POST is the whole answer, and the collapsed
// line that replaces the box is what the reader has left as the record.
async function answerRemoteWrite(id, choice, btn) {
  const box = btn?.closest(".turn-approval");
  const req = state.rwPending.get(id) || null;
  btn?.closest(".ta-actions")?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const res = await apiFetch("/api/remote-write/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, choice, by: "reader" }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
    state.rwPending.delete(id);
    state.rwDecided.set(id, {
      choice: out.choice || choice,
      why: out.why || "",
      command: req?.command || "",
      at: Date.now(),
    });
    renderApprovals();
    showBanner(
      choice === "deny"
        ? "remote write denied — nothing was pushed"
        : choice === "always"
          ? "remote writes are now allowed — the setting is saved (Settings > Branches on the remote)"
          : `remote write allowed ${choice}${req?.branch ? ` (${req.branch})` : ""} — the waiting push is going ahead`,
    );
  } catch (e) {
    btn?.closest(".ta-actions")?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    box?.classList.add("is-error");
    showBanner(`could not answer that permission request: ${e.message}`);
  }
}

// Every output pane's position, so a rebuild can put the reader back where they were instead of
// dropping them at the first line of an hour-old transcript.
// ---- thinking -----------------------------------------------------------------------------
// What the agent thought before it acted. The runs stream only carries a 500-char preview (and not at all on the
// durable path), so this is read from the store per turn. It is a per-session preference with a global default:
// thinking is 1-2 KB per block, which is the whole point on one agent and noise across forty cards.
const THINK_KEY = "wtgui.think"; // global default, "1" when a card without its own answer should show thinking
state.thinkCache = state.thinkCache || new Map(); // turn key -> { blocks, at }
state.thinkOpen = state.thinkOpen || new Set(); // turn keys whose block is expanded
state.thinkPinned = state.thinkPinned || new Map(); // block key -> false once the reader scrolls it up
state.thinkScroll = state.thinkScroll || new Map(); // block key -> where the reader left it, for a rebuild to restore
state.thinkClosed = state.thinkClosed || new Set(); // turn keys the reader folded on purpose
state.thinkLoading = state.thinkLoading || new Set();

function thinkDefault() {
  try {
    return localStorage.getItem(THINK_KEY) === "1";
  } catch {
    return false;
  }
}

function thinkingOn(thread) {
  try {
    const own = localStorage.getItem(`wtgui.think.${thread}`);
    if (own === "1") return true;
    if (own === "0") return false;
  } catch {
    /* private mode: fall through to the default */
  }
  return thinkDefault();
}

function setThinking(thread, on) {
  try {
    localStorage.setItem(`wtgui.think.${thread}`, on ? "1" : "0");
  } catch {
    /* the choice just will not persist */
  }
  renderConversation(thread);
}

// ---- one stream ------------------------------------------------------------------------------
// The 🌊 beside the 🧠: draw this session as ONE stream — what the agent thought, said, called and got back, in the
// order it happened, with no burst to open. What is NOT folded there is the run of calls itself: a result is still the
// shut box it is in the condensed view (core/console-format.js), so the stream is one flow of what happened rather
// than a wall of output. Per session like thinking, but with no global default: a card that never pressed it renders
// exactly as it always did, which is what every card did before this existed.
const STREAM_KEY = "wtgui.stream";

// NOT `setStream`. That name is already core/sse.js's connection label (the ● live / offline pill, called from
// there, from core/transport.js and from this file); it is a global in a classic script, so a function of the same
// name here would replace it for every caller and the status pill would stop moving.
function streamOn(thread) {
  try {
    return localStorage.getItem(`${STREAM_KEY}.${thread}`) === "1";
  } catch {
    /* private mode: off, which is the default anyway */
    return false;
  }
}

function setStreamMode(thread, on) {
  try {
    localStorage.setItem(`${STREAM_KEY}.${thread}`, on ? "1" : "0");
  } catch {
    /* the choice just will not persist */
  }
  renderConversation(thread);
}

// ---- a run of tool calls: tallied, or one line each (Settings > Agent cards) -------------------
// The condensed card draws a burst of calls as ONE tallied group by default: a head row per tool with its count
// (terminal ×12), the batch's "+ N commands" tail, and a button that opens the whole run. That shape repeats the
// call it is tallying - a single `terminal ×1` cost a head row, the "all N" button, the call row, its "↳ tool"
// result line and the output box, five rows for one call - so the reader can turn it off: every call is then ONE
// row (glyph, tool, and the file, range or command it was given) and pressing that row opens what the call
// returned, in the same box the tallied view opens. Saved in this browser; one answer for every console.
const TOOL_GROUPS_KEY = "wtgui.toolGroups";

function toolGroupsOn() {
  try {
    return localStorage.getItem(TOOL_GROUPS_KEY) === "1";
  } catch {
    /* private mode: the one-line shape, which is the default anyway */
    return false;
  }
}

function setToolGroups(on) {
  try {
    localStorage.setItem(TOOL_GROUPS_KEY, on ? "1" : "0");
  } catch {
    /* the choice just will not persist */
  }
  // The shape is decided per card at render time, and conversationSignature carries the setting, so this rebuilds
  // every console into the shape just chosen instead of leaving the cards drawn under the old one.
  for (const c of conversations()) renderConversation(c.thread);
}

// ---- what a fold the reader opens does to the console (Settings > Agent cards) ------------------
// A console follows its newest line unless the reader scrolls it away (see pinConsole). That rule cannot tell new
// OUTPUT from a box the reader just opened: a folded result's body is folded out of the layout, so opening it grows
// the console's content by its own height — and the 400 ms stick, and the next live line, both find a console off its
// end and carry the view down by exactly that height. The result the reader opened to read is then above them and
// its LAST line is what fills the view, which reads as the panel jumping to the bottom of what was just opened.
//
// The press is the reader's, not the run's, so it hands the console over: the view stays where it is and the box opens
// under the header that was pressed. This is the old behaviour when turned on — the console follows the growth to its
// end. Saved in this browser; off by default.
const FOLD_FOLLOW_KEY = "wtgui.foldFollow";

function foldFollowsConsole() {
  try {
    return localStorage.getItem(FOLD_FOLLOW_KEY) === "1";
  } catch {
    return false; // private mode: the console holds still, which is the default anyway
  }
}

function setFoldFollow(on) {
  try {
    localStorage.setItem(FOLD_FOLLOW_KEY, on ? "1" : "0");
  } catch {
    /* the choice just will not persist */
  }
}

// ---- how a run's output arrives (Settings > Display) ------------------------------------------
// The wire is not the reader's pace. A paragraph reaches the console in coalesced frames (120 ms on the server, and
// several words in a fast model) and tool calls and results arrive as whole lines, so a live card used to jump a
// phrase at a time. Two settings answer that, and they answer different questions:
//
//   * Stream display speed — WORDS a second inside a growing paragraph. The line's tail waits in
//     core/type-stream.js's pacer and leaves a word at a time; what is drawn is always an exact prefix of the text
//     the run sent, so a copy of a half-typed line is what is on screen.
//   * Stream line rate — LINES a second joining a console. A burst of whole lines (a tool call and the results that
//     answered it, a run of stored output) walks in one at a time instead of landing in one paint. A line held back
//     is not in the console's record yet, so a repaint mid-burst shows the transcript as far as it has got.
//
// Both are per browser, both are 0 = off (today's behaviour), and both are flushed the moment their turn settles: a
// buffer that outlived the run would be words the reader never sees, which is the one thing this must not do.
const TYPE_WORDS_KEY = "wtgui.streamWords";
// 40 words a second is what a long answer on this box streams at (measured: 2,682 words in 72 s), so the console
// keeps up with the model and still fills in a word or two at a time. 0 is off.
const TYPE_WORDS_DEFAULT = 40;
const TYPE_LINES_KEY = "wtgui.streamLines";
const TYPE_LINES_DEFAULT = 0;

function typeSpeedStored(key, fallback, clamp) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return fallback;
    return clamp(Number(raw));
  } catch {
    return fallback; // private mode: the default holds
  }
}

function typeWordSpeed() {
  return typeSpeedStored(TYPE_WORDS_KEY, TYPE_WORDS_DEFAULT, (n) => (globalThis.wtType ? globalThis.wtType.clampWords(n) : 0));
}

function typeLineRate() {
  return typeSpeedStored(TYPE_LINES_KEY, TYPE_LINES_DEFAULT, (n) => (globalThis.wtType ? globalThis.wtType.clampLines(n) : 0));
}

// One pacer and one gate for the whole board: this is a reading preference, not a per-card one.
state.typePacer = globalThis.wtType
  ? globalThis.wtType.createPacer({ rate: typeWordSpeed(), onPaint: (lids) => paintTypedLines(lids) })
  : null;
state.typeGate = globalThis.wtType
  ? globalThis.wtType.createLineGate({
      rate: typeLineRate(),
      release: (evt) => {
        recordJobLine(evt);
        drawJobLine(evt);
      },
    })
  : null;
// The reasoning blocks the pacer has already been given: a block seen for the first time while its turn is LIVE is
// the only one that types out, so opening an old card (or reloading the page) draws history whole.
state.thinkFed = new Set();

// ---- reasoning first: a tool's lines wait for the thought in front of them -----------------------------------
// A reply's reasoning is typed at the reader's words-a-second, and the tool call that reply made (and its output) are
// whole lines on the wire, so left alone they land while the thought above them is still being written — the answer
// before the question. This holds those frames (core/type-stream.js createReasoningHold: in order, a whole job's
// queue at once) until two things are true: the store has been read again since the call arrived — the reasoning is
// written to the store a moment AFTER its tool call is on the stream, and only a read finds it — and the pacer has
// written every word of the thoughts that belong in front of the call. "In front of" is every thought newer than
// the last tool result already in the console: a reader who opens a card mid-turn gets the whole backlog typing in
// parallel, and none of that is a reason to hold a call it does not precede.
//
// Only while there is something to wait for AND a reader watching it: the words/s setting is on (0 keeps the console
// exactly as the run sent it), the turn is live, the tab is visible, and the reasoning is on screen — the 🌊 stream
// always draws it, the 🧠 block only while it is open (typing into a folded block is a wait for nothing).
const REASONING_READ_WAIT_MS = 2000; // a store read that has not answered by now is not worth holding a console for
const REASONING_READ_COOLDOWN_MS = 250; // one read serves a whole burst of calls
state.reasoningReads = new Map(); // job -> { at, done }: the latest read begun for a call

function reasoningShown(turn) {
  const thread = turn.thread || turn.id;
  if (!thinkingOn(thread)) return false;
  if (streamOn(thread) && globalThis.wtStream) return true;
  return thinkOpenFor(turn, turnKey(turn, ""));
}

function reasoningWants(evt) {
  const kind = evt?.line?.kind;
  if (kind !== "tool" && kind !== "tool-out") return false;
  if (!state.typePacer || !state.typePacer.rate()) return false;
  const turn = state.jobs.get(String(evt.id));
  return Boolean(turn) && turnLive(turn) && reasoningShown(turn);
}

// The moment of the last tool result already in the console: the thoughts newer than it are the ones a call is about
// to follow. 0 (a turn with no result yet) counts every thought of the turn.
function reasoningFloor(job) {
  const lines = state.jobLines.get(String(job)) || [];
  for (let k = lines.length - 1; k >= 0; k--) if (lines[k]?.kind === "tool-out") return Number(lines[k].at) || 0;
  return 0;
}

// A call, or the header of a result, is the cue to look at the store again. A read already in flight may have been
// answered before the store held this reply, so a cue waits for it and asks once more (loadThinkingAfter).
function reasoningStart(job, evt) {
  const line = evt?.line || {};
  const cue = line.kind === "tool" || (line.kind === "tool-out" && TOOL_DONE_RE.test(String(line.text || "")));
  if (!cue) return;
  const prev = state.reasoningReads.get(job);
  if (prev && Date.now() - prev.at < REASONING_READ_COOLDOWN_MS) return;
  const turn = state.jobs.get(job);
  if (!turn) return;
  const rec = { at: Date.now(), done: false };
  state.reasoningReads.set(job, rec);
  loadThinkingAfter(turn)
    .catch(() => {})
    .finally(() => {
      rec.done = true;
    });
}

function reasoningBusy(job) {
  const rec = state.reasoningReads.get(job);
  if (rec && !rec.done && Date.now() - rec.at < REASONING_READ_WAIT_MS) return true;
  const floor = reasoningFloor(job);
  return Boolean(
    state.typePacer?.pendingFor(job, (lid) => lid.startsWith("think:") && (Number(lid.slice(6)) || 0) > floor),
  );
}

state.typeHold = globalThis.wtType?.createReasoningHold
  ? globalThis.wtType.createReasoningHold({
      wants: reasoningWants,
      busy: reasoningBusy,
      start: reasoningStart,
      // Out of the hold, a frame still has the line-by-line setting to get past, exactly as if it had just arrived.
      release: (evt) => {
        if (!state.typeGate?.push(evt)) {
          recordJobLine(evt);
          drawJobLine(evt);
        }
      },
    })
  : null;

// Reasoning types out on the same pacer, at the same words/s the prose uses — it is the same reading. A block is
// fed the first time the panel sees it while its turn is live, and every re-read of the store feeds it again so a
// block that grew keeps flowing. Returns the prefix to draw, or null when this block is drawn whole (history, a
// hidden tab, rate 0, or the turn has settled and the flush already released it).
//
// THE TWO BRANCHES MUST NOT DISAGREE. A block that has been fed always draws the PACER'S prefix — never its whole
// text — because the two are not the same string: a live turn's reasoning runs to 100 kB and more per turn (measured:
// 58 blocks / 183 kB on this box), so the prefix the clock has reached is a small fraction of the wire's text. Drawing
// the whole text in one branch and the prefix in the other makes the block COLLAPSE back to a few words and type them
// out again the moment the branches swap — a settled turn that is revived, a tab that comes back into view. And the
// moment there is no flow to show (a settled turn, a hidden tab) the rest is released at once, so the block ends on
// the wire's whole text instead of on a prefix nobody is left to write.
function paceThinkBlock(turn, block) {
  const P = state.typePacer;
  if (!P || !block) return null;
  const lid = `think:${block.at}`;
  const flowing = !document.hidden && turnLive(turn);
  // A block first seen on a turn that is not live — an old card, a reload, thinking switched on after the fact — is
  // history and draws whole. One the pacer already holds is not history any more, whatever the status says now.
  if (!state.thinkFed.has(lid) && !flowing) return null;
  state.thinkFed.add(lid);
  const shown = P.feed(lid, String(turn.id), String(block.text ?? ""));
  if (!flowing) return P.flush(lid) ?? shown;
  return shown;
}

// A SKILL'S RESULT is written like prose and reasoning are. Its lines are fed to the pacer as they join a console,
// and every row a console draws asks `typedShown` (core/console-format.js's hook) how much of itself it may show, so
// the lines of a skill type out at the reader's words-a-second inside the result's box — and walk in at their
// lines-a-second, because the gate in front of this already holds every line. Which results those are is
// wtType.isPacedTool; every other tool's result is drawn whole, exactly as before.
//
// A result's lines arrive together, behind the "↳ tool" header that names it, so the tool a body line belongs to is
// the nearest header above it in its burst. The header itself, the panel's fold note and the gateway's own notes
// are not words of the result and are never typed.
function resultToolOf(lines, line) {
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    if (!l || l === line) continue;
    if (l.kind === "tool") return "";
    if (l.kind !== "tool-out") continue;
    const m = TOOL_DONE_RE.exec(String(l.text || ""));
    if (m) return m[1];
  }
  return "";
}

function paceResultLine(lines, line, jobId) {
  if (!state.typePacer || !globalThis.wtType || line.kind !== "tool-out" || line.lid == null) return;
  const text = String(line.text ?? "");
  if (TOOL_DONE_RE.test(text) || consoleFoldNote(text) || /^\s*(?:…|\.\.\.)\s/.test(text)) return;
  if (!globalThis.wtType.isPacedTool(resultToolOf(lines, line))) return;
  typedText(line, jobId);
}

// The words of a line that may be drawn now: the live append asks for them, and every render path asks too, so a
// repaint mid-paragraph draws the same prefix the console is showing instead of jumping to the wire's whole text.
function typedText(line, jobId) {
  const P = state.typePacer;
  const full = String(line?.text ?? "");
  // A tab nobody is looking at has no flow to show: while it is hidden every frame is drawn whole, so coming back to
  // it shows the answer as it stands instead of a paragraph still typing out the minutes nobody watched.
  if (!P || line?.lid == null || document.hidden) return full;
  return P.feed(String(line.lid), String(jobId ?? ""), full);
}

function typedShown(line) {
  const P = state.typePacer;
  if (!P || !line || line.lid == null) return null;
  return P.shownFor(String(line.lid));
}
// The console's own row renderer asks the same question for every row it draws (see consoleSetShownFor).
window.WMApp?.core?.consoleFormat?.setShownFor?.(typedShown);

// The pacer says which lines grew; every pane carrying one gets the new prefix (a pinned turn draws its own copy,
// so the same line can be in two consoles at once).
function paintTypedLines(lids) {
  const P = state.typePacer;
  if (!P) return;
  // A skill types forty lines at once, so a console is asked where its bottom is ONCE per paint — before anything in
  // it grows — and scrolled once after, instead of once per line (each ask forces a layout of everything above it).
  const stuck = new Map();
  for (const lid of lids) {
    const shown = P.shownFor(lid);
    if (shown == null) continue;
    for (const el of document.querySelectorAll(`[data-lid="${CSS.escape(String(lid))}"]`)) {
      if (!el.isConnected) continue;
      // A row that already says this is not re-parsed. The pacer and the live append both paint the same prefix
      // (the append asks the pacer how much of the line may be drawn), so without this the first wire frame after
      // a tick rewrote the row with the text the tick had just put there — an innerHTML assignment that changes no
      // character and still replaces every text node under the reader's selection.
      if (el._drawn === shown) continue;
      // A reasoning block types inside its thinking block, which follows its own stickiness, not the console's.
      const body = el.closest(".think-body");
      const out = body ? null : el.closest("pre.job-out");
      if (out && !stuck.has(out)) stuck.set(out, consolePinned(out.dataset.out) || out.scrollHeight - out.scrollTop - out.clientHeight < 40);
      el.innerHTML = linkifyText(shown);
      el._drawn = shown;
      if (body) stickThinkBody(body);
    }
  }
  for (const [out, stick] of stuck) if (stick) setScroll(out, out.scrollHeight);
}

// The turn is over: nothing may be left waiting in either buffer, and the last of a paragraph's words are released
// rather than left to a clock that has nothing more to say.
function flushTypeStream(job) {
  state.typeHold?.drain(String(job ?? ""));
  state.typeGate?.drain(String(job ?? ""));
  state.typePacer?.flushJob(String(job ?? ""));
}

// A background tab has no flow to show: release both buffers, so the reader comes back to the whole answer instead
// of to a transcript that is still typing out a paragraph nobody was watching.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  state.typeHold?.drain();
  state.typeGate?.drain();
  state.typePacer?.releaseAll();
});

function paintStreamSpeed() {
  const w = typeWordSpeed();
  const l = typeLineRate();
  const words = $("stream-words");
  if (words && document.activeElement !== words) words.value = String(w);
  const lines = $("stream-lines");
  if (lines && document.activeElement !== lines) lines.value = String(l);
  // The preset the stored value lands on is lit, so the row says what it is without reading the number back.
  for (const b of document.querySelectorAll("[data-stream-words-set]")) {
    b.classList.toggle("on", Number(b.dataset.streamWordsSet) === w);
  }
  for (const b of document.querySelectorAll("[data-stream-lines-set]")) {
    b.classList.toggle("on", Number(b.dataset.streamLinesSet) === l);
  }
  const preview = $("stream-preview");
  if (!preview) return;
  preview.textContent =
    !w && !l
      ? "output arrives exactly as the run sent it — both off"
      : `${w ? `words type at ${w}/s` : "words appear as they arrive"} · ${l ? `new lines walk in at ${l}/s` : "new lines appear at once"}`;
}

function saveTypeWords(value) {
  const n = globalThis.wtType ? globalThis.wtType.clampWords(value) : 0;
  state.typePacer?.setRate(n);
  try {
    localStorage.setItem(TYPE_WORDS_KEY, String(n));
  } catch {
    /* private mode: the choice just will not persist */
  }
  paintStreamSpeed();
}

function saveTypeLines(value) {
  const n = globalThis.wtType ? globalThis.wtType.clampLines(value) : 0;
  state.typeGate?.setRate(n);
  try {
    localStorage.setItem(TYPE_LINES_KEY, String(n));
  } catch {
    /* private mode: the choice just will not persist */
  }
  paintStreamSpeed();
}

// A read that BEGINS after this call. loadThinking drops a request while one is in flight (the poll must not stack up),
// but an answer already on its way may have been asked for before the store held the reply the caller is waiting on,
// so this waits that one out and then asks again. Resolves once the answer is painted — which is also when the pacer
// has been handed any new thought, so a caller that looks at the pacer afterwards sees it.
async function loadThinkingAfter(turn) {
  const until = Date.now() + REASONING_READ_WAIT_MS;
  while (state.thinkLoading.has(turn.id) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  await loadThinking(turn, "");
}

// One turn's thoughts, from the store, bounded by the turn's own clock.
async function loadThinking(turn, copy = "") {
  const key = turnKey(turn, copy);
  if (state.thinkLoading.has(turn.id)) return;
  state.thinkLoading.add(turn.id);
  const prev = state.thinkCache.get(turn.id)?.blocks || [];
  // The block keeps what it has unless a read it can TRUST says otherwise. This is the only pane on a card that is
  // polled; the run's own output is appended and never rebuilt, which is why the recording of a run never flickers and
  // this did.
  let blocks = prev;
  try {
    // Bounded by the turn's own clock, which stops where the next turn began (an interrupted turn has no endedAt).
    const { from, to } = turnBounds(turn);
    const r = await apiFetch(
      `/api/thinking?thread=${encodeURIComponent(turn.thread || turn.id)}&from=${from}&to=${to}`,
    );
    if (r.ok) {
      const d = await r.json();
      const fresh = Array.isArray(d.blocks) ? d.blocks : [];
      // A read that FAILED (`error`) is not a turn that recorded nothing: taking its empty array would blank the block
      // and refill it on the next poll — a collapse and reopen, every couple of seconds, on every live card.
      // And a live turn's block list only ever GROWS (the store appends one row per assistant message and takes none
      // away), so an empty answer while the turn is still running is a bad read too. A shorter non-empty answer is left
      // alone: past MAX_BLOCKS the oldest block legitimately drops out of the window.
      if (!d.error && (fresh.length || !prev.length || !turnLive(turn))) blocks = fresh;
    }
  } catch {
    /* an unreadable store is not worth a banner: the block just keeps what it already shows */
  } finally {
    state.thinkLoading.delete(turn.id);
  }
  state.thinkCache.set(turn.id, { blocks, at: Date.now() });
  paintThink(turn, "");
  if (document.querySelector(`details.think[data-think-turn="${CSS.escape(turnKey(turn, "@pin"))}"]`)) paintThink(turn, "@pin");
}

// Repaint just the block, so a read landing mid-turn does not rebuild the card under the reader.
// A block opened by the panel (because its turn is running) is not the reader opening it: without this the auto-open
// would be remembered as a choice and the block would never fold again after the turn ends.
const thinkAutoOpened = new WeakSet();

// The block scrolls like a console: new thinking keeps the newest line in view unless the reader has gone back up.
// Without this every repaint (every couple of seconds while a turn runs) put the body back at its first line.
state.subConsolePinned = state.subConsolePinned || new Map(); // child console id -> false once the reader scrolls up

function stickSubConsole(box) {
  if (!box || !box.isConnected) return;
  const id = box.dataset.subConsoleBox || "";
  if (state.subConsolePinned.get(id) === false) return;
  const max = box.scrollHeight - box.clientHeight;
  if (max <= 0 || Math.abs(box.scrollTop - max) <= 1) return;
  setScroll(box, max);
}

function stickThinkBody(body) {
  if (!body || !body.isConnected) return;
  const key = body.closest("details.think")?.dataset.thinkTurn || "";
  if (state.thinkPinned.get(key) === false) return;
  const max = body.scrollHeight - body.clientHeight;
  if (max <= 0 || Math.abs(body.scrollTop - max) <= 1) return;
  setScroll(body, max);
}

// In the single-stream mode there is no block to repaint: the blocks are lines of the console itself, so a read that
// lands mid-turn redraws that console, keeping the reader where they were (the same rule as the run's own appends).
//
// The redraw is a PATCH, not a replacement. Written as one `innerHTML` assignment it threw away every row of a live
// console — and the reader's text selection with it — on every reasoning re-read (~1.2 s while a turn runs), leaving
// the scroll to whatever the browser did with a box whose children had just been replaced: the same fault
// `Let a card pick its model, and keep the console still while it runs` cured one level up for the condensed console
// (a fresh <pre> at scrollTop 0, several times a second), still open one renderer down. So: a row whose words did not
// move keeps its NODE, a new row is inserted where it belongs, a row the turn's window has dropped is removed, and
// the reader's place goes back where it was. A body that would drop rows from the MIDDLE or the tail — a failed store
// read, a shorter answer mid-turn — draws nothing at all, the same rule `loadThinking` follows for the blocks it has.
const streamRowKey = (n) => {
  const lid = n?.dataset?.lid;
  if (lid) return `l:${lid}`;
  const grp = n?.dataset?.tgrp;
  return grp ? `g:${grp}` : "";
};

function syncStreamConsole(out, body, stick) {
  const holder = document.createElement("div");
  holder.innerHTML = body;
  const next = [...holder.children];
  const before = [...out.children];
  // Where the reader is: the first row with any part of itself inside the box, and how far into the box it starts.
  // A poll that grows a row above it must not slide the reader's line down the box.
  const keep = (() => {
    if (stick) return null;
    const box = out.getBoundingClientRect();
    for (const n of before) {
      const r = n.getBoundingClientRect();
      if (r.bottom > box.top + 1) return { key: streamRowKey(n), off: Math.round(r.top - box.top) };
    }
    return null;
  })();
  // A shorter body is only ever a WINDOW TRIM: `windowLines`/`slice(-300)` and `MAX_BLOCKS` drop rows off the TOP.
  // Rows that vanish from the middle or the tail are a read this console should not draw (a failed store read, a
  // shorter answer mid-turn), and drawing it is what collapses the box and pulls everything under it up the page.
  // So: every row below the first one the new body still names must still be named by it.
  const nextKeys = new Set(next.map(streamRowKey).filter(Boolean));
  if (next.length < before.length) {
    const firstNext = next.map(streamRowKey).find(Boolean) || "";
    const keyed = before.map((n) => streamRowKey(n)).filter(Boolean);
    const from = Math.max(0, keyed.indexOf(firstNext));
    if (keyed.slice(from).some((k) => !nextKeys.has(k))) return false;
  }
  if (!before.length) {
    out.replaceChildren(...next);
  } else {
    const byKey = new Map();
    for (const n of before) {
      const k = streamRowKey(n);
      if (k && !byKey.has(k)) byKey.set(k, n);
    }
    let cursor = out.firstElementChild;
    for (const fresh of next) {
      const k = streamRowKey(fresh);
      const have = k ? byKey.get(k) : null;
      if (k) byKey.delete(k);
      let place = have;
      if (have) {
        // The same row in the same place: only its words can have moved, so it is replaced only when they did.
        if (have !== cursor) out.insertBefore(have, cursor);
        if (!have.isEqualNode(fresh)) {
          have.replaceWith(fresh);
          place = fresh;
        }
      } else {
        out.insertBefore(fresh, cursor);
        place = fresh;
      }
      cursor = place.nextElementSibling;
    }
    // Whatever the new body does not name is out of this turn's window. It is all below the loop's cursor, so
    // removing it moves nothing the reader is looking at.
    while (cursor) {
      const gone = cursor;
      cursor = cursor.nextElementSibling;
      gone.remove();
    }
  }
  if (keep?.key) {
    const again = [...out.children].find((n) => streamRowKey(n) === keep.key);
    if (again) {
      const off = Math.round(again.getBoundingClientRect().top - out.getBoundingClientRect().top);
      if (Math.abs(off - keep.off) >= 2) setScroll(out, out.scrollTop + (off - keep.off));
    }
  }
  return true;
}

function paintStreamConsole(turn, copy = "") {
  const out = [...document.querySelectorAll("pre.job-out")].find((el) => el.dataset.out === `${turn.id}${copy}`);
  if (!out) return false;
  const all = jobLines(turn.id).filter((l) => !isBookkeeping(l));
  const stick = consolePinned(`${turn.id}${copy}`) || out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  syncStreamConsole(out, streamBodyHtml(turn, all.slice(-300), all.length > 300), stick);
  if (stick) setScroll(out, out.scrollHeight);
  paintToBottom(out);
  return true;
}

// A poll of the store used to be drawn by replacing the whole `<details>`: one fresh node per read, every block
// inside it new. That is what made the block churn 5.6 rows a second on a card whose model had stopped, and it took
// the reader's selection, the block's open state and the copy button with every read. What a poll's answer actually
// changes is the WORDS: the last thought grows as the pacer types it, one more thought appears at the end, and the
// count in the summary moves. So the node stays — its `open` belongs to the reader (sweepThinking folds it when the
// turn ends, and the card repaint on a status change re-renders it) — the summary's copy button is never touched, and
// only the text that moved is written, in place, so a selection standing in an untouched block survives the read.
const thinkRowKey = (n) => n?.dataset?.lid || (n?.classList?.contains("think-empty") ? "@empty" : "");

// Same element skeleton, different words: the one case that can be patched without replacing anything.
function sameThinkShape(a, b) {
  if (!a || !b || a.nodeType !== b.nodeType) return false;
  if (a.nodeType === 3) return true;
  if (a.nodeType !== 1) return false;
  if (a.tagName !== b.tagName) return false;
  if ((a.getAttribute("class") || "") !== (b.getAttribute("class") || "")) return false;
  // A link's identity is its target: linkifyText can turn a half-typed URL into an anchor mid-read, and that changes
  // the tree's shape rather than its words.
  if (a.tagName === "A" && (a.getAttribute("href") || "") !== (b.getAttribute("href") || "")) return false;
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let i = 0; i < a.childNodes.length; i++) if (!sameThinkShape(a.childNodes[i], b.childNodes[i])) return false;
  return true;
}

function writeThinkText(live, fresh) {
  for (let i = 0; i < live.childNodes.length; i++) {
    const l = live.childNodes[i];
    const f = fresh.childNodes[i];
    if (!f) return;
    if (l.nodeType === 3) {
      if (l.nodeValue !== f.nodeValue) l.nodeValue = f.nodeValue;
    } else if (l.nodeType === 1) {
      writeThinkText(l, f);
    }
  }
}

// One row of the block, patched against the one it replaced in the cache: same lid keeps its node (and whatever the
// reader has selected in it), a row the window has dropped is removed, a new thought is inserted where it belongs.
function syncThinkBody(body, freshBody) {
  const next = [...freshBody.children];
  const byKey = new Map();
  for (const n of body.children) {
    const k = thinkRowKey(n);
    if (k && !byKey.has(k)) byKey.set(k, n);
  }
  // The "nothing yet — it will appear here as the agent thinks" row BECOMES the first thought instead of being
  // replaced by it. It is the one line the reader is watching before there is anything to read, and the first block
  // arriving is that row's content, not a new row under it: adopt it, so the block's first paint keeps its node
  // (and the harness's "every row it drew" count is the reader's count, not a placeholder swapped for a paragraph).
  const empty = byKey.get("@empty");
  const first = next[0];
  if (empty && first && first.dataset.lid && !empty.dataset.lid) {
    empty.dataset.lid = first.dataset.lid;
    empty.className = first.className;
    empty.innerHTML = first.innerHTML;
    byKey.delete("@empty");
    byKey.set(first.dataset.lid, empty);
  }
  let cursor = body.firstElementChild;
  for (const want of next) {
    const k = thinkRowKey(want);
    const have = k ? byKey.get(k) : null;
    if (k) byKey.delete(k);
    let place = have;
    if (have) {
      if (have !== cursor) body.insertBefore(have, cursor);
      if (have.innerHTML !== want.innerHTML) {
        if (sameThinkShape(have, want)) writeThinkText(have, want);
        else have.innerHTML = want.innerHTML;
      }
    } else {
      body.insertBefore(want, cursor);
      place = want;
    }
    cursor = place.nextElementSibling;
  }
  while (cursor) {
    const gone = cursor;
    cursor = cursor.nextElementSibling;
    gone.remove();
  }
}

function syncThinkBlock(el, fresh) {
  const meta = el.querySelector(":scope > summary .think-meta");
  const wantMeta = fresh.querySelector(":scope > summary .think-meta");
  if (meta && wantMeta && meta.textContent !== wantMeta.textContent) meta.textContent = wantMeta.textContent;
  const body = el.querySelector(".think-body");
  const freshBody = fresh.querySelector(".think-body");
  if (!body || !freshBody) return false;
  syncThinkBody(body, freshBody);
  return true;
}

function paintThink(turn, copy = "") {
  const key = turnKey(turn, copy);
  // The 🌊 draws the reasoning inside the console, so that is the thing to repaint — there is no block on the page.
  if (streamOn(turn.thread || turn.id) && paintStreamConsole(turn, copy)) return;
  const el = document.querySelector(`details.think[data-think-turn="${CSS.escape(key)}"]`);
  if (!el) return;
  const holder = document.createElement("div");
  holder.innerHTML = thinkHtml(turn, copy);
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  const body = el.querySelector(".think-body");
  // A block that lost its body (a shape this renderer no longer draws) is healed once by the old wholesale path.
  if (!body) {
    el.replaceWith(fresh);
    const made = fresh.querySelector(".think-body");
    if (made) stickThinkBody(made);
    return;
  }
  // Where the reader was. A patched body keeps its scroll by itself; this is for the row that grew past the box.
  const keep = { top: body.scrollTop };
  if (!syncThinkBlock(el, fresh)) return;
  // The body is the same node, and a new thought appended under it must not push the reader's line out of view
  // unless they were reading at the bottom (or the panel pinned it there).
  if (state.thinkPinned.get(key) === false) setScroll(body, Math.min(keep.top, Math.max(0, body.scrollHeight - body.clientHeight)));
  else stickThinkBody(body);
}


// While a turn is running its block is open and re-read, which is what the separate live reasoning line used to do; once
// the turn ends it folds unless the reader left it open. One control, one mental model.
function thinkOpenFor(turn, key) {
  if (state.thinkOpen.has(key)) return true;
  if (state.thinkClosed.has(key)) return false;
  return turnLive(turn);
}

function thinkHtml(turn, copy = "") {
  const key = turnKey(turn, copy);
  if (!thinkingOn(turn.thread || turn.id)) return "";
  const entry = state.thinkCache.get(turn.id);
  const blocks = entry?.blocks || [];
  const open = thinkOpenFor(turn, key);
  const meta = !entry ? "reading…" : blocks.length ? `${blocks.length} block${blocks.length === 1 ? "" : "s"}` : "none recorded";
  return `<details class="think" data-copy data-think-turn="${esc(key)}"${open ? " open" : ""}>
    <summary><span class="think-title">🧠 thinking</span> <span class="think-meta mono">${esc(meta)}</span></summary>
    <div class="out-wrap"><div class="think-body">${
      blocks.length
        ? blocks.map((b) => {
            // The same words/s the prose types at: the block is fed the first time it is seen on a live turn, and
            // the tick repaints it through this very data-lid.
            const shown = paceThinkBlock(turn, b);
            return `<div class="think-block mono" data-lid="think:${esc(b.at)}">${linkifyText(shown == null ? b.text : shown)}</div>`;
          }).join("")
        : `<div class="think-block mono think-empty">${
            entry
              ? turnLive(turn)
                ? "nothing yet — it will appear here as the agent thinks"
                : "this turn recorded no thinking"
              : "reading the store…"
          }</div>`
    }</div>${toBottomBtnHtml()}</div>
  </details>`;
}

// ---- copy buttons ------------------------------------------------------------------------------
// One mechanism for every "lift this block" affordance: an element carrying `data-copy` carries a small
// button in its corner that appears while the pointer is over it and copies THAT BLOCK's own visible
// text. The button is mounted here, by the observer below, never by the renderers - so a block another
// worker draws (the console's code and diff windows) opts in by carrying the same attribute, and there
// is no second mechanism to keep in step with this one.
//
// What a block copies is what it SHOWS: the reading goes through innerText, so a folded burst or a
// folded reasoning block contributes only the lines on screen, never a hidden one. Every control inside
// the block is taken out of that reading - this button's own label, the "N lines" and "+ N commands"
// buttons, the jump-to-the-newest-line chip - because a control's label is chrome, not output.
const COPY_SEL = "[data-copy]";
const COPY_BTN_SEL = "[data-copy-btn]";
const COPY_TEXT_SEL = "[data-copy-text]";
const COPY_TITLE = "copy this block's text to the clipboard";
const COPY_FLASH_MS = 1400;

function copyButtonHtml() {
  return `<button type="button" class="copy-block" data-copy-btn="1" title="${COPY_TITLE}" aria-label="${COPY_TITLE}">⧉</button>`;
}

// The one place a button is created. Idempotent: the button this inserts is itself a mutation, so the
// observer below sees it, asks again, finds the button already there and stops.
function mountCopyButtons(root) {
  if (!root || root.nodeType !== 1) return;
  const blocks = [];
  if (root.matches?.(COPY_SEL)) blocks.push(root);
  for (const el of root.querySelectorAll?.(COPY_SEL) || []) blocks.push(el);
  for (const block of blocks) {
    // A <details> renders only its summary while it is folded, so its button goes IN the summary: a folded
    // block has to be copyable too, and what it copies is still its folded text.
    const host = block.tagName === "DETAILS" ? block.querySelector(":scope > summary") || block : block;
    if (host.querySelector(":scope > .copy-block")) continue;
    host.insertAdjacentHTML("beforeend", copyButtonHtml());
  }
}

// Generic by construction: ANY render path that puts a `[data-copy]` block on the page gets its button -
// a card rebuilt from scratch, a console line appended by the run's stream, a pinned copy of a turn.
//
// The same hook arms the thinking block's OPEN state, and for the same reason: it is a fact about nodes that arrive
// from a render path, whoever wrote it. A `<details open>` inserted into the document fires a `toggle` of its own,
// queued as a task — indistinguishable, to the listener below, from the reader pressing it. Every re-read of the store
// inserts one (`paintThink` → `el.replaceWith`), so without this every live turn's block was remembered as "the reader
// opened it", `state.thinkOpen` grew a key per turn, and a finished turn's reasoning never folded again. The observer
// runs as a microtask, before that queued task, so the flag is always in place in time.
function armPlacedThink(root) {
  if (!root || root.nodeType !== 1) return;
  if (root.matches?.("details.think[open]")) thinkAutoOpened.add(root);
  for (const d of root.querySelectorAll?.("details.think[open]") || []) thinkAutoOpened.add(d);
}

const copyObserver = new MutationObserver((records) => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node.nodeType !== 1) continue;
      mountCopyButtons(node);
      armPlacedThink(node);
    }
  }
});
copyObserver.observe(document.documentElement, { childList: true, subtree: true });
mountCopyButtons(document.documentElement);

// What a block copies: its own text, as the reader sees it. innerText alone will not do - a flex row (a
// tool burst's call: glyph, name, tally, arguments, timer) has its items blockified, so innerText breaks
// them onto five separate lines, and textContent ignores what is folded away altogether. So the walk
// below keeps innerText's rules for what is SHOWN - a folded or hidden subtree contributes nothing - one
// line box at a time, and lays a flex row's items out the way the reader sees them: one line, separated.
const COPY_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "BUTTON"]);

function copyBlockBox(el) {
  const d = getComputedStyle(el).display;
  return d !== "none" && d !== "contents" && !d.startsWith("inline");
}

function copyShownText(el) {
  if (!el || el.nodeType !== 1) return "";
  if (COPY_SKIP_TAGS.has(el.tagName)) return ""; // a control's label is chrome, never output
  if (el.tagName === "BR") return "\n";
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || el.hidden) return "";
  if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return "";
  // A folded block contributes its title line and nothing else, whatever its contents compute to.
  if (el.tagName === "DETAILS" && !el.open) return copyShownText(el.querySelector(":scope > summary"));
  // A wrapper a renderer added for a fold is read THROUGH, not treated as a block of its own: a block's copy is
  // trimmed at its edges, and applied to a tool call's output that would eat the leading spaces of whichever line
  // happens to be first under the wrapper (a result line reads "  ↳ patch · 3.27s" on screen). The lines inside
  // are the console's own text, so they are lifted exactly as they are shown.
  if (el.hasAttribute && el.hasAttribute("data-copy-through")) {
    return [...el.childNodes].map((k) => (k.nodeType === 3 ? k.nodeValue : k.nodeType === 1 ? copyShownText(k) : "")).join("\n");
  }
  const display = cs.display;
  if (display === "flex" || display === "inline-flex" || display === "grid" || display === "inline-grid") {
    // A flex ROW lays its items out on one line - which is the whole reason this walk exists - while a
    // flex COLUMN or a grid stacks them, one line each. (A tool burst's head is a column: one row per
    // tool, and its copy is one line per tool.)
    const onOneLine = (display === "flex" || display === "inline-flex") && !String(cs.flexDirection || "").startsWith("column");
    return [...el.children]
      .map(copyShownText)
      .map((t) => t.trim())
      .filter(Boolean)
      .join(onOneLine ? " " : "\n");
  }
  const kids = [...el.childNodes];
  // A line box - text and inline content only: innerText is exact for one, pre-wrap and all.
  if (!kids.some((k) => k.nodeType === 1 && copyBlockBox(k))) return el.innerText;
  return kids
    .map((k) => (k.nodeType === 3 ? k.nodeValue : k.nodeType === 1 ? copyShownText(k) : ""))
    .join("\n")
    .replace(/[ \t]+(?=\r?\n)/g, "")
    .replace(/(\r?\n){2,}/g, "\n")
    .replace(/^[\s\r\n]+|[\s\r\n]+$/g, "");
}

// The part that IS the block's text, when the marked element is a wrapper: a tool burst's button sits on
// the burst (so hovering anywhere in it finds one button) while a burst copies its CALL - the header and
// its summary as rendered - and never its result lines. It is a DIRECT child: a burst inside a console
// carries one of its own, and the console must not read it as its own text.
function blockCopyText(block) {
  return copyShownText(block.querySelector(`:scope > ${COPY_TEXT_SEL}`) || block);
}

function flashCopyButton(btn, ok) {
  btn.textContent = ok ? "✓" : "✕";
  btn.classList.toggle("is-copied", ok);
  btn.classList.toggle("is-failed", !ok);
  btn.title = ok ? "copied to the clipboard" : "the clipboard refused it - nothing was copied";
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.textContent = "⧉";
    btn.classList.remove("is-copied", "is-failed");
    btn.title = COPY_TITLE;
  }, COPY_FLASH_MS);
}

// The one delegated handler. It runs in the CAPTURE phase, so a press on the button is answered here and
// never reaches the console's own click handlers; and a copy that fails says so (a cross) instead of
// looking like the tick a successful one shows.
document.addEventListener(
  "click",
  (e) => {
    const target = e.target && e.target.closest ? e.target : null;
    const btn = target ? target.closest(COPY_BTN_SEL) : null;
    if (!btn) return;
    const block = btn.closest(COPY_SEL);
    if (!block) return;
    e.preventDefault();
    e.stopPropagation();
    // copyText() is the panel's own writer: the async clipboard where the origin is secure (loopback
    // is), the select-and-execCommand path behind it, and `false` when neither of them worked.
    void copyText(blockCopyText(block)).then(
      (ok) => flashCopyButton(btn, ok),
      () => flashCopyButton(btn, false),
    );
  },
  true,
);

// A console follows its newest line unless the reader has deliberately gone back to read something older. This is the
// default the panel promises, and it has to survive three things that used to fight over scrollTop: a card rebuild, a
// row rebuild (every few seconds) and the browser clamping the position while the node is replaced. Anything the panel
// moves itself must not count as the reader scrolling away, hence `selfScrolled`.
state.outPinned = state.outPinned || {}; // out id -> false only after a deliberate scroll upwards
// ---- the reader's own input, per card
// Which card the reader is working in is the question a scroll event has to answer, so the clock is keyed by the CARD
// and not by the page. With one document-wide `lastInputAt`, a wheel over card B licensed the next scroll event on
// card A to be read as A's reader scrolling: A's pin was rewritten from a silent 35 px clamp 790 ms after the wheel,
// and it then stayed 1,277 px off its tail for the rest of the window (tools/measure-console-pin.mjs, 2,587 frames).
// Input outside every card (the board's own chrome, the assistant panel) is not a console scroll and decides nothing.
const INPUT_WINDOW_MS = 1200; // a scroll this soon after a wheel / key / click in the SAME card is the reader's
const lastInputAt = new Map(); // card thread -> when the reader last wheeled / keyed / clicked inside that card
for (const ev of ["wheel", "mousedown", "keydown", "touchstart"]) {
  document.addEventListener(ev, (e) => {
    const card = e.target && e.target.closest ? e.target.closest(".job[data-thread]") : null;
    if (!card) return;
    lastInputAt.set(card.dataset.thread, Date.now());
  }, { capture: true, passive: true });
}

// Did the reader touch the card this box belongs to, inside the window? A box with no card above it answers `false`:
// nothing the reader did elsewhere on the page is evidence about it, and a scroll the panel cannot attribute stays the
// panel's own.
function readerInputHere(el) {
  const card = el && el.closest ? el.closest(".job[data-thread]") : null;
  const at = card ? lastInputAt.get(card.dataset.thread) : 0;
  return Boolean(at) && Date.now() - at < INPUT_WINDOW_MS;
}
// ---- end the reader's own input, per card
const selfScrolled = new WeakSet();

function consolePinned(id) {
  return state.outPinned[id] !== false;
}

function pinConsole(id) {
  if (id) state.outPinned[id] = true;
}

// A fold the reader opens inside a console hands that console over. The growth is the reader's, not the run's: a
// console still following its newest line carries the view down by the height of what was just folded out (the 400 ms
// stick and the next live line both answer "this console is off its end"), so the box's LAST line fills the view and
// the line the reader was on is gone above it. Unpinned, the view does not move and the box opens under the header
// that was pressed; ↓ (or scrolling back to the end) follows the run again. `atBottom: false` is written with the
// position because a rebuilt card and a re-rendered table restore from that record (applyStoredScrolls,
// restoreScrolls), and a stale "atBottom" would follow the growth on the next repaint.
//
// Called only when a press OPENS something: folding a box back away shrinks the console, and the browser's own clamp
// is the right answer there. Settings > Agent cards > "Jump to an opened result" restores the old follow-the-growth
// behaviour, and off is the default (foldFollowsConsole).
function holdConsoleFor(control) {
  const pre = control && control.closest ? control.closest("pre.job-out") : null;
  if (!pre || !pre.dataset.out || foldFollowsConsole()) return null;
  state.outPinned[pre.dataset.out] = false;
  state.outScrolls[pre.dataset.out] = { top: pre.scrollTop, atBottom: false };
  return pre;
}

// Every scroll the panel performs goes through here. Its scroll event arrives after this task, and without a
// record of what the panel did it is indistinguishable from the reader scrolling - which unpinned consoles during
// a rebuild and left them parked at the top until something else happened to move them.
// A node whose scrollTop is still where the panel put it: the event it is reporting is the panel's own.
function justPlaced(el) {
  return el._selfTop != null && Math.abs(el.scrollTop - el._selfTop) <= 1;
}

function setScroll(el, top) {
  if (!el) return;
  const v = Math.max(0, Math.round(Number(top) || 0));
  el._selfTop = v;
  selfScrolled.add(el);
  el.scrollTop = v;
}

// Rebuilds land before the browser has finished laying the new nodes out, so a "go to the bottom" can be clamped
// to a shorter height than the console ends up with. Once the frame is done, put the pinned ones back on their
// newest line - and only those, so a console the reader took control of is never moved.
// The synchronous half of settleScrolls: run it right after a rebuild inserts nodes, so nothing is ever painted at
// the first line before the frame-based pass gets to it. That one-frame flash is what read as the block "jumping".
function restoreThinkBodies(root) {
  if (!root) return;
  for (const b of root.querySelectorAll(".think-body")) restoreThinkBody(b);
}

function settleScrolls(root) {
  const run = () => {
    if (!root || !root.isConnected) return;
    for (const o of root.querySelectorAll("pre.job-out")) stickConsole(o);
    for (const b of root.querySelectorAll(".think-body")) restoreThinkBody(b);
    for (const s of root.querySelectorAll(".sub-console")) stickSubConsole(s);
    // A repaint can move the card under an open picker; put the panel back under its control.
    positionModelPop();
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

// A thinking block in a rebuilt card is a fresh node at its first line. Pinned follows the newest line (as the
// live block does); one the reader took control of returns to where they had it.
function restoreThinkBody(body) {
  if (!body || !body.isConnected) return;
  const key = body.closest("details.think")?.dataset.thinkTurn || "";
  if (state.thinkPinned.get(key) !== false) {
    stickThinkBody(body);
    return;
  }
  const was = state.thinkScroll.get(key);
  if (!was) return;
  setScroll(body, Math.min(was.top, Math.max(0, body.scrollHeight - body.clientHeight)));
}

function stickConsole(pre) {
  if (!pre || !pre.dataset || !consolePinned(pre.dataset.out)) return;
  const max = pre.scrollHeight - pre.clientHeight;
  if (max <= 0 || Math.abs(pre.scrollTop - max) <= 1) return;
  setScroll(pre, max);
}

function captureScrolls(root) {
  const map = new Map();
  if (!root) return map;
  for (const o of root.querySelectorAll("pre.job-out")) {
    map.set(o.dataset.out, {
      top: o.scrollTop,
      // A node the panel has never placed (a fresh build) sits at 0 until something moves it. Reading that 0 as
      // "the reader scrolled up" is what made a rebuilt console come back at its first line.
      atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32,
    });
  }
  return map;
}

function restoreScrolls(root, map) {
  if (!root || !map.size) return;
  for (const o of root.querySelectorAll("pre.job-out")) {
    const was = map.get(o.dataset.out);
    if (!was) continue;
    setScroll(o, consolePinned(o.dataset.out) || was.atBottom ? o.scrollHeight : Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
  }
}

// Put every console in this subtree back where the reader left it, from the remembered positions.
// Used after a subtree was rebuilt from scratch, where there is no old node to measure.
function applyStoredScrolls(root) {
  if (!root) return;
  for (const o of root.querySelectorAll("pre.job-out")) {
    const was = state.outScrolls[o.dataset.out];
    if (!was) continue;
    setScroll(o, consolePinned(o.dataset.out) || was.atBottom ? o.scrollHeight : Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
  }
  applySubConsoleScrolls(root);
}

// A repainted strip and a rebuilt card both REPLACE the node a child's console lives in, so its position cannot ride
// on the element the way holdScrolls() carries a moved one: it is remembered by child id and written back onto the
// fresh node in the same task. A box still following its newest line goes to the bottom; one the reader took over
// goes back to the line they left it on. A box that fits its content has nowhere to go and is left alone.
function applySubConsoleScrolls(root, { follow = false } = {}) {
  if (!root) return;
  for (const box of root.querySelectorAll(".sub-console[data-sub-console-box]")) {
    const id = box.dataset.subConsoleBox || "";
    if (!id) continue;
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) continue;
    if (follow || state.subConsolePinned.get(id) !== false) {
      setScroll(box, max);
      continue;
    }
    const top = state.subConsoleTop.get(id);
    if (top != null) setScroll(box, Math.min(top, max));
  }
}

// ---- moving nodes without losing what is scrolled inside them ------------------------------------------------
// Appending a node that is already in the page is a remove-then-insert: the subtree leaves the layout tree and comes
// back as a fresh scroll area at `scrollTop = 0`. That is the one kind of jump no scroll code writes, and it is what
// reads as two consoles fighting each other while one of them is written to: the move that reset them was about a
// third thing on the board (a closed section's rank, another row's place), and every console inside the moved
// subtree went to its first line in the same frame. So a move here only touches the elements that are actually out
// of place, and whatever does move holds its scroll boxes across the move, in the same task, so no frame is painted
// at 0 and no reader waits for the 400 ms sweep to hand their place back.
function placeInOrder(parent, want) {
  // Backwards, so every element is put down relative to a successor that is already where the order asks it to be.
  // An element whose next sibling is already the right one is never detached at all - that is the whole point.
  let moved = 0;
  for (let i = want.length - 1; i >= 0; i--) {
    const el = want[i];
    if (!el) continue;
    const next = want[i + 1] || null;
    if (el.parentNode === parent && el.nextElementSibling === next) continue;
    parent.insertBefore(el, next);
    moved += 1;
  }
  return moved;
}

// Where every scroll box in this subtree stands, read BEFORE anything is moved: a read taken after the move reads the
// 0 the move left, and a restore built on that writes the reader back to the top.
function holdScrolls(root) {
  const held = [];
  if (!root) return held;
  for (const el of root.querySelectorAll("pre.job-out, .think-body, .sub-console")) {
    const think = el.classList.contains("think-body");
    const sub = el.classList.contains("sub-console");
    held.push({
      el,
      think,
      sub,
      top: el.scrollTop,
      key: think ? el.closest("details.think")?.dataset.thinkTurn || "" : sub ? el.dataset.subConsoleBox || "" : el.dataset.out || "",
    });
  }
  return held;
}

// Put them back. A box still pinned follows its newest line (what it holds may have grown with the move); one the
// reader took over goes back to the line they were on.
function releaseScrolls(held) {
  for (const h of held || []) {
    const el = h.el;
    if (!el || !el.isConnected) continue;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) continue;
    const pinned = h.think
      ? state.thinkPinned.get(h.key) !== false
      : h.sub
        ? state.subConsolePinned.get(h.key) !== false
        : consolePinned(h.key);
    setScroll(el, pinned ? max : Math.min(h.top, max));
  }
}
// A card that is taken out of the document and put back (fillAgentSlots) is a fresh scroll area at its first line,
// so the child consoles inside it are held by the element, exactly as holdScrolls() holds a moved section's boxes.
// Only the child consoles: pre.job-out and the thinking bodies are restored by their own ids in the paths below.
function holdSubConsoles(root) {
  const held = [];
  if (!root) return held;
  for (const el of root.querySelectorAll(".sub-console[data-sub-console-box]")) {
    held.push({ el, think: false, sub: true, top: el.scrollTop, key: el.dataset.subConsoleBox || "" });
  }
  return held;
}
// ---- end moving nodes without losing what is scrolled inside them

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
  // The assistant's thread is a conversation but not a board agent: it is counted on neither side of
  // "unattached / in worktrees", and it is rendered only inside its floating panel.
  const boardConvs = conversations().filter((c) => c.thread !== state.assistantThread);
  const convs = homelessConversations();
  const nested = boardConvs.length - convs.length;
  for (const id of [...state.collapsedJobs]) if (!conversations().some((c) => c.thread === id)) state.collapsedJobs.delete(id);
  // Forgetting a cleared job's explicit turn state keeps the map from growing forever.
  const live = new Set([...state.jobs.keys()]);
  for (const id of [...state.turnOpen.keys()]) {
    // Pinned copies share the turn id with a `pin:` prefix; prune on the turn they belong to.
    if (!live.has(id.startsWith("pin:") ? id.slice(4) : id)) {
      state.turnOpen.delete(id);
      state.turnCompact.delete(id);
    }
  }
  // Same for a cleared thread's remembered page.
  const threads = new Set([...state.jobs.values()].map((j) => j.thread || j.id));
  for (const t of [...state.turnPage.keys()]) if (!threads.has(t)) state.turnPage.delete(t);
  // The list is rebuilt wholesale, so remember where every open transcript was and put it back:
  // a `jobs` event must not cost the reader their place in an agent they are reading.
  //
  // This panel sits ABOVE the board, so its height is in front of everything the reader is looking at: a wholesale
  // rebuild that changes it (or a page that shrinks under a reader parked at the bottom) clamps their scroll and the
  // content above is gone for good. Hold the page position across the rebuild, and hand the sweep an anchor so the
  // board below follows it like it does for every other render path.
  const pageY = window.scrollY;
  const anchor = captureBoardAnchor();
  // A snapshot merges every job in and asks for this list again even when nothing a card DRAWS has moved — and `#jobs`
  // is appended to by each run's own stream, so a card that is streaming holds lines no snapshot carries. Rebuilding
  // the list from that content replaces the card node for nothing: the console, the thinking block and the reader's
  // place in both come back as new nodes. So the markup is only written when the set of cards, or any card's own
  // signature, has moved. A card whose run is alive therefore keeps its node through a resync, and a card that is
  // genuinely dead changes signature (its status, its run, its ownership) and is rebuilt exactly as before.
  const listSig = `${convs.map((c) => `${c.thread}:${conversationSignature(c)}`).join("|")}#${convs.length}`;
  const sameList = listSig === state.jobsListSig && $("jobs").querySelectorAll(":scope > .job[data-thread]").length === convs.length;
  state.jobsListSig = listSig;
  if (!sameList) {
    // The list is rebuilt wholesale, so remember where every open transcript was and put it back:
    // a `jobs` event must not cost the reader their place in an agent they are reading.
    //
    // This panel sits ABOVE the board, so its height is in front of everything the reader is looking at: a wholesale
    // rebuild that changes it (or a page that shrinks under a reader parked at the bottom) clamps their scroll and the
    // content above is gone for good. Hold the page position across the rebuild, and hand the sweep an anchor so the
    // board below follows it like it does for every other render path.
    const prevScrolls = captureScrolls($("jobs"));
    // These cards are rebuilt from scratch, so a selection standing in one is recorded and put back on the new nodes.
    const heldSelection = captureCardSelection();
    // And so is the caret: without this, typing in an unattached card's reply box ended the moment anything about the
    // job list changed - the box was replaced under the reader and focus fell to the page.
    const typing = captureTyping($("jobs"));
    $("jobs").innerHTML = convs.length
      ? convs.map(conversationHtml).join("")
      : `<p class="empty">No unattached agents${nested ? ` — ${nested} agent${nested === 1 ? "" : "s"} listed under their worktree rows` : ""}.</p>`;
    restoreTyping($("jobs"), typing);
    // The panel above the board just changed height. This rebuild is one synchronous step, so a moved scroll is the
    // browser clamping the page (a shorter document pulls a reader parked at the bottom upward), never the reader
    // scrolling: put it back, then let the sweep hold the board's own anchor.
    if (window.scrollY !== pageY) {
      const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(pageY, maxY) });
    }
    restoreScrolls($("jobs"), prevScrolls);
    applyStoredScrolls($("jobs"));
    restoreThinkBodies($("jobs"));
    for (const c of convs) restoreReplyDraft(c.thread);
    // After the drafts are back in their boxes, put the caret back in the one the reader was typing in - with
    // preventScroll, so a restore never drags the page to the box.
    restoreTyping($("jobs"), typing);
    restoreCardSelection(heldSelection);
    // Readers at the bottom stay at the bottom, readers scrolled up keep their line, and only genuinely new cards
    // jump to the newest output.
    restoreScrolls($("jobs"), prevScrolls);
    for (const c of convs) {
      if (state.collapsedJobs.has(c.thread)) continue;
      if (!prevScrolls.has(c.latest.id)) scrollThreadToBottom(c.thread);
    }
    // Their thinking blocks and any open picker have to be put back the way the row path does it: the blocks where the
    // reader had them, the picker under its control.
    settleScrolls($("jobs"));
  }
  scheduleBoardSweep(anchor);
  const running = convs.filter((c) => c.turns.some((t) => turnLive(t))).length;
  const folded = convs.filter((c) => state.collapsedJobs.has(c.thread)).length;
  const turns = [...state.jobs.values()].filter((j) => (j.thread || j.id) !== state.assistantThread).length;
  $("agents-chips").innerHTML =
    `<span class="chip">${convs.length} unattached</span>` +
    (nested ? `<span class="chip">${nested} in worktrees</span>` : "") +
    (turns > convs.length ? `<span class="chip">${turns} turns</span>` : "") +
    (running ? `<span class="chip warn">${running} running</span>` : "") +
    (folded ? `<span class="chip">${folded} minimized</span>` : "");
  const fold = $("btn-fold-jobs");
  if (fold) fold.textContent = convs.length && folded === convs.length ? "Expand all" : "Minimize all";
  paintAgentBadges();
  // A pending spawn target has to be re-applied here too — renderConversation bails out to renderJobs() whenever the
  // card did not exist yet.
  applyPendingFocus();
}

// Row badges ("⧉ 2 · 1 running") follow job events without rebuilding the table.
function paintAgentBadges() {
  for (const row of state.rows.values()) {
    const tr = document.querySelector(`tr.row[data-key="${CSS.escape(keyOf(row.project, row.path))}"]`);
    if (!tr) continue;
    // Inside the name cell's own flex row: appended to the <td> it lands after that row and drops onto a second
    // line, which made a row taller the moment an agent started in it.
    const cell = tr.querySelector("td.name > .name-line") || tr.querySelector("td.name");
    const existing = cell?.querySelector("[data-open-row]");
    const html = agentBadgeHtml(row);
    if (existing && !html) {
      existing.remove();
      continue;
    }
    if (!html) continue;
    if (existing) existing.outerHTML = html;
    else cell?.insertAdjacentHTML("beforeend", html);
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
    String(prev?.approvalDone?.choice || "") !== String(j.approvalDone?.choice || "") ||
    // An approval nobody answered replaces the box with a record line whose `choice` is empty on both sides, so
    // the expiry itself has to be compared or the card keeps the box it was just told to drop.
    Boolean(prev?.approvalDone?.expired) !== Boolean(j.approvalDone?.expired);
  const prevOwner = prev ? prev.ownerPath || null : null;
  const ownerChanged = (j.ownerPath || null) !== prevOwner;
  state.jobs.set(j.id, { ...prev, ...j });
  if (!state.jobLines.has(j.id) && j.lines?.length) state.jobLines.set(j.id, j.lines.slice());
  // A turn that has stopped has no more frames coming, so whatever either display buffer still holds is released:
  // a resumed, interrupted or failed run settles without a `result` line, and its card must not sit mid-paragraph.
  if (statusChanged && !turnLive(j)) flushTypeStream(j.id);
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
  const turns = conv.turns
    .map((t) => `${t.id}:${t.status}:${t.exitCode ?? ""}:${t.error ? 1 : 0}:${(t.artifacts || []).length}`)
    .join(",");
  // A run's approval lives on the TURN (Runs API), not in state.approvals. Without it here, a prompt
  // arriving mid-turn changes nothing in the signature, so the card is not repainted and the approval
  // box only appears whenever some unrelated event forces a rebuild (observed: ~20 s later).
  const runApprovals = conv.turns
    .map((t) => `${t.id}:${t.approval ? t.approval.requestId || t.approval.command || 1 : 0}:${t.approvalDone ? t.approvalDone.choice || 1 : 0}`)
    .join(",");
  // The same for an agent's own question: without it here, a `clarify.request` landing mid-turn
  // changes nothing in the signature and the box only appears when some unrelated event repaints.
  const runQuestions = conv.turns
    .map((t) => `${t.id}:${t.question ? t.question.requestId || t.question.question?.slice(0, 40) || 1 : 0}:${t.question ? (t.question.choices || []).length : 0}:${t.questionDone ? (t.questionDone.answer || "closed").slice(0, 40) : 0}`)
    .join(",");
  // The re-attach pill's own input, for the same reason as the two above: the gateway answering 404 for a card's run
  // settles it — the promise becomes the settled wording and `runGone` goes up — while its status stays `interrupted`
  // and it still carries an error, so nothing else in this signature moves. Without it the pill sat on a card whose
  // run is provably gone until some unrelated event forced a rebuild.
  const runReattach = conv.turns.map((t) => `${t.id}:${t.runGone ? 1 : 0}`).join(",");
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
    // The session's own name, which Hermes writes a moment after the first turn: a card created here can be
    // repainted by its title landing, so the title belongs in the signature even though nothing else changes.
    l.title || "",
    // l.lastActiveAt is NOT here: it moves with every event of a running turn, and rebuilding the whole card for
    // it destroyed the console under the reader several times a second - which is what made the scroll jump. It is
    // repainted in place by paintCardMeta().
    // Queued replies show as a note next to the buttons; a change must repaint the card.
    (state.replyQueue.get(conv.thread) || []).length,
    // The held reply the reader has open in the in-place editor, by its `at`: opening it swaps that entry's line for a
    // textarea and closing it puts the line back, so the card has to repaint on the open/close alone. The text being
    // typed is deliberately NOT here — a keystroke must not rebuild the card the reader is typing in.
    `e${queuedEditFor(conv.thread)?.at ?? ""}`,
    state.collapsedJobs.has(conv.thread) ? "c" : "o",
    state.maximized === conv.thread ? "m" : "-",
    isHomelessConv(conv) ? "h" : "-",
    approvals,
    runApprovals,
    runQuestions,
    runReattach,
    l.runId || "",
    l.cwd || "",
    // The row this agent is filed under: the card's cwd line falls back to it, so a change must repaint.
    l.ownerPath || "",
    l.model || "",
    l.yolo ? "y" : "",
    l.worktree || "",
    l.existing ? "e" : "",
    // l.tokens.total is NOT here: it changes with every event of a running turn, and each rebuild replaced the
    // card's buttons under the reader's cursor - which is what made an approval unclickable. The foot is repainted
    // in place (paintCardMeta) and a finished turn repaints anyway when its status changes.
    // A steer the turn never read comes back as a note in the reply area: without it here the card would not
    // repaint, and the note would only appear whenever something unrelated forced a rebuild.
    l.pendingSteer ? `s${l.pendingSteer.at || 1}` : "",
    conv.turns.map((x) => `${x.origin ? `o${x.id}` : ""}${x.collected ? "c" : ""}`).join(""),
    thinkingOn(conv.thread) ? "t" : "-",
    // …and the 🌊 beside it, for exactly that reason: `streamOn` decides which console renderer the card uses
    // (`turnBody` draws one stream or the condensed groups), so without a term here a press writes its choice to
    // localStorage, asks for a repaint, and the repaint concludes nothing changed — the card flips only when some
    // unrelated event moves this signature.
    streamOn(conv.thread) ? "s" : "-",
    // …and the tool-call shape for the same reason, one level up: `toolGroupsOn` decides whether a run of calls in
    // this card is the tallied group or one row each, so a press in Settings (which repaints every conversation)
    // would otherwise conclude nothing changed and leave the console in the shape it was drawn under.
    toolGroupsOn() ? "g" : "-",
    // A card stays RUNNING while children it delegated are out, so that answer belongs in the signature.
    (subagentFallback.get(conv.thread) || []).some((s) => s.running) ||
    conv.turns.some((t) => (t.subagents || []).some((s) => s.running))
      ? "r"
      : "-",
    // The stats row is repainted in place too: a new reading must update the numbers, but it must not rebuild
    // the console under them.
  ].join("~");
}

// Is the reader's selection standing in this element? A non-collapsed range counts wherever it touches: a drag that
// started before the readout and runs off its end has endpoints outside it and still owns the text between them.
function selectionIn(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (el.contains(r.startContainer) || el.contains(r.endContainer) || r.intersectsNode(el)) return true;
  }
  return false;
}

// A board rebuild detaches every card and puts it back, and the browser drops the selection on the way through: a
// saved `Range` does not bring it back (measured — a clone whose boundary nodes are connected again, reattached card,
// `addRange` leaves `getSelection()` empty and collapsed; the boundary points died with the subtree). What survives
// is where in the readout the selection stood, so that is what is recorded: the card it belongs to and a character
// offset into its usage readout. A rebuild re-renders that markup, so the range is rebuilt against the nodes that are
// actually on screen afterwards.
function offsetIn(root, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(root);
  try {
    r.setEnd(node, offset);
  } catch {
    return null;
  }
  return r.toString().length;
}

// The text node and offset at character position `n` inside `root`.
function pointAt(root, n) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last = null;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const len = t.data.length;
    if (n <= seen + len) return { node: t, offset: n - seen };
    seen += len;
    last = t;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

// Which copy of a thread's card to restore onto: the board's, not the unattached panel's, when both exist.
function cardForThread(thread) {
  const cards = [...document.querySelectorAll(`.job[data-thread="${CSS.escape(thread)}"]`)];
  return cards.find((c) => c.closest("tr.detail")) || cards[0] || null;
}

function captureCardSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const held = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (r.collapsed) continue;
    const startEl = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const card = startEl?.closest?.(".job[data-thread]");
    if (!card) continue;
    // The readout when the selection sits in it, the whole card otherwise.
    const root = startEl.closest("[data-stats]") || card;
    if (!root.contains(r.endContainer)) continue;
    const start = offsetIn(root, r.startContainer, r.startOffset);
    const end = offsetIn(root, r.endContainer, r.endOffset);
    if (start == null || end == null || end <= start) continue;
    held.push({ thread: card.dataset.thread, stats: root !== card, start, end });
  }
  return held.length ? held : null;
}

function restoreCardSelection(held) {
  if (!held || !held.length) return;
  const sel = window.getSelection();
  if (!sel) return;
  // Only when nothing else is selected now: a reader who has picked something else has moved on.
  if (sel.rangeCount && !sel.isCollapsed) return;
  const ranges = [];
  for (const h of held) {
    const card = cardForThread(h.thread);
    const root = card && (h.stats ? card.querySelector("[data-stats]") : card);
    if (!root) continue;
    const a = pointAt(root, h.start);
    const b = pointAt(root, h.end);
    if (!a || !b) continue;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      continue;
    }
    ranges.push(r);
  }
  if (!ranges.length) return;
  sel.removeAllRanges();
  for (const r of ranges) sel.addRange(r);
}

// The two things on a card that move without changing its markup: when it was last used, and its usage figures.
// Writing them where they stand is what keeps a streaming turn from rebuilding (and resetting) its own console.
function paintCardMeta(el, conv) {
  const latest = conv.latest;
  const when = el.querySelector("[data-when]");
  if (when) {
    const next = latest.lastActiveAt ? fmtAgo(latest.lastActiveAt) : "";
    if (when.textContent !== next) when.textContent = next;
    if (latest.lastActiveAt) when.title = `last used ${new Date(latest.lastActiveAt).toLocaleString()}`;
  }
  const slot = el.querySelector("[data-stats]");
  if (slot) {
    const html = statsRowHtml(latest, conv.thread);
    // The figures are the one part of a streaming card that rewrite themselves every poll, and a rewrite deletes
    // whatever the reader had selected in them: a full row selected and copied came back empty within a second.
    // Hold the markup while a selection stands inside it and let the first tick after they let go paint the current
    // numbers — a stale reading under a live selection is the honest trade, and it is the only one that keeps the
    // selection the reader just made.
    if (slot._html !== html && !selectionIn(slot)) {
      slot.innerHTML = html;
      slot._html = html;
    }
  }
}

function renderConversation(thread, { scroll = false } = {}) {
  const conv = conversations().find((c) => c.thread === thread);
  const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!conv) return renderJobs();
  if (!el) {
    // The assistant's card lives in the floating panel, not in #jobs. Rebuilding the unattached list would
    // leave the float empty until some unrelated render, so paint that one card in its own host.
    if (thread === state.assistantThread && typeof window.__assistantRenderChat === "function") {
      window.__assistantRenderChat();
      return;
    }
    return renderJobs();
  }
  const sig = conversationSignature(conv);
  if (el.dataset.sig === sig) {
    paintCardMeta(el, conv);
    return;
  }
  // Rebuild, then put the reader back exactly where they were: every output pane, the maximized
  // body, and the page itself. Following the newest output only happens when they were already at
  // the bottom (or when the caller explicitly asks for it, e.g. a freshly spawned turn).
  const prev = [...el.querySelectorAll("pre.job-out")].map((o) => ({
    id: o.dataset.out,
    top: o.scrollTop,
    atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32,
  }));
  const prevBody = el.querySelector(".job-body");
  const bodyTop = prevBody ? prevBody.scrollTop : 0;
  const bodyAtBottom = prevBody ? prevBody.scrollHeight - prevBody.scrollTop - prevBody.clientHeight < 32 : true;
  const pageY = window.scrollY;
  const typing = captureTyping(el);
  // A rebuild replaces the card node, which drops any selection standing in its readout; record it and put it back.
  const heldSelection = captureCardSelection();
  const holder = document.createElement("div");
  holder.innerHTML = conversationHtml(conv);
  const fresh = holder.firstElementChild;
  fresh.dataset.sig = sig;
  el.replaceWith(fresh);
  restoreThinkBodies(fresh);
  restoreTyping(fresh, typing);
  restoreCardSelection(heldSelection);
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  for (const o of fresh.querySelectorAll("pre.job-out")) {
    const was = prev.find((p) => p.id === o.dataset.out);
    const follow = scroll || consolePinned(o.dataset.out) || (was ? was.atBottom : conv.latest.status === "running");
    if (follow) setScroll(o, o.scrollHeight);
    else if (was) setScroll(o, Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
  }
  // The card node was replaced, so an open child console in its subagent strip is a fresh box at its first line: put
  // it back in this same task instead of leaving it to the 400 ms sweep.
  applySubConsoleScrolls(fresh, { follow: scroll });
  const body = fresh.querySelector(".job-body");
  if (body) {
    setScroll(body, bodyAtBottom ? body.scrollHeight : Math.min(bodyTop, Math.max(0, body.scrollHeight - body.clientHeight)));
  }
  settleScrolls(fresh);
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
  if (!pending.placed && Date.now() < (pending.scrollUntil || 0)) {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(pending.thread)}"]`);
    if (card) {
      const r = card.getBoundingClientRect();
      const outOfView = r.top < 48 || r.bottom > window.innerHeight - 48;
      pending.placed = true; // once is a welcome; repeating it is the page fighting the reader
      if (outOfView) {
        programmaticScroll();
        card.scrollIntoView({ block: "center", behavior: "auto" });
      }
    }
  }
}

// Cards for agents owned by a worktree are painted by the row-detail renderer, not by
// renderConversation/renderJobs, so a one-shot focus after a render is the wrong shape: a spawn can
// repaint through any of several paths. A cheap watch re-applies the caret while the target stands.
setInterval(applyPendingFocus, 250);

// Scrolling at all is the reader taking over just as much as a click is: stop pulling the page back to
// the spawned agent. The wheel was the only gesture watched, so a scrollbar drag, Page Down or a
// trackpad fling still got yanked back a moment later - which is the "it pops me back up to the box"
// report. pendingScrollAt stamps our own one-time jump so it is not read as the reader scrolling.
let pendingScrollAt = 0;
// Every scroll the panel performs on purpose stamps this. The follow below ends on a READER scroll - and the
// panel's own aim/follow jumps (up to the New-agent card, then down to the new agent) are not that.
function programmaticScroll() {
  pendingScrollAt = Date.now();
}
const endFollowOnScroll = (e) => {
  if (Date.now() - pendingScrollAt < 600) return;
  // Only the page counts. A console scrolling its own output (captured here because scroll does not
  // bubble but capture sees every descendant) is the agent working, not the reader leaving.
  const t = e && e.target;
  const page = !t || t === document || t === document.scrollingElement || t === window || t === document.documentElement;
  if (!page) return;
  if (state.pendingFocus) state.pendingFocus = null;
};
document.addEventListener("wheel", endFollowOnScroll, { passive: true });
document.addEventListener("scroll", endFollowOnScroll, { passive: true, capture: true });
document.addEventListener("touchmove", endFollowOnScroll, { passive: true });

function appendJobLine(evt) {
  // The run's live numbers ride the line they belong to: a jobline frame carries them (lib/jobs.js emitLine),
  // so the pulse's age advances with the output instead of needing a summary frame per token.
  if (evt.live) {
    const job = state.jobs.get(evt.id);
    if (job) job.live = evt.live;
  }
  const line = evt.line || {};
  // The line-by-line setting holds a burst of whole lines and lets them in one at a time. Bookkeeping never waits:
  // the `result` line is what says the turn ended, and it is also the frame that flushes both buffers. A hidden tab
  // is not reading anything, so it never holds a line either — the answer is there in full when the reader returns.
  if (!document.hidden && !isBookkeeping(line) && state.typeHold?.push(evt)) return;
  if (!document.hidden && !isBookkeeping(line) && state.typeGate?.push(evt)) return;
  // The turn is over: what the reasoning hold is keeping goes into the console BEFORE the line that says so.
  if (line.kind === "result") state.typeHold?.drain(evt.id);
  recordJobLine(evt);
  drawJobLine(evt);
  if (line.kind === "result") flushTypeStream(evt.id);
}

// The console's own record of the turn — the lines a rebuild draws from. A held line is not in here yet, so a
// repaint mid-burst shows the transcript as far as it has got.
function recordJobLine(evt) {
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
}

// One line into every pane showing this turn.
function drawJobLine(evt) {
  const line = evt.line || {};
  // Kept in the buffer, never drawn: see BOOKKEEPING_LINES above.
  if (isBookkeeping(line)) return;
  // A pinned turn renders twice — in its page and in the pinned block above — so every pane carrying
  // this id (or its "@pin" copy) gets the line.
  const outs = [...document.querySelectorAll("pre.job-out")].filter(
    (el) => el.dataset.out === evt.id || el.dataset.out === `${evt.id}@pin`,
  );
  if (!outs.length) return;
  // The words of a growing paragraph that may be drawn now: the pacer holds the tail and releases it on its own
  // clock, so the console fills in a word or two at a time instead of a coalesced phrase at a time.
  const shownText = line.kind === "text" ? typedText(line, evt.id) : line.text;
  // Whether this turn is drawn as ONE stream. Only that console sets a piece apart from the piece above it: the
  // condensed layout keeps its own margins, which is the layout it already had.
  const streaming = streamOn(state.jobs.get(evt.id)?.thread || evt.id);
  for (const out of outs) {
    // Streamed lines follow the newest output only for a reader who is already at the bottom; someone
    // scrolled up to read stays where they are.
    const stick = consolePinned(out.dataset.out) || out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    // Only the placeholder an empty console shows gives way to the first line. This used to ask whether the first CHILD
    // was dim, but a dim line is transcript too ("⇢ asked to work in …", "cut from …", "push guard: …") and every
    // repaint — the thinking sweep, a new deliverable, an approval — puts one back on top, so the next live line wiped
    // everything the reader had on screen and drew only itself until the following repaint put it all back.
    out.querySelector(":scope > [data-wait]")?.remove();
    // A tool call joins the burst at the tail of the console and updates its tally in place; anything said in
    // between ends that burst, so the next call starts a fresh tally where the transcript has got to.
    const isTool = line.kind === "tool" || line.kind === "tool-out";
    const tail = out.lastElementChild;
    // Whether this line belongs in the burst already at the tail. A call that follows a result, or one a reasoning
    // block was written after, starts the next burst — the same cut `segments()` makes on the next repaint, so the
    // append and the poll cannot disagree about where the row lives (a row that joins and is then cut out again is
    // one the reader sees leave one box and appear in the next).
    const tailLines = isTool && tail && tail.classList.contains("tgrp") ? tail._burst || groupLines(tail) : null;
    // A tool-usage group is a RUN of calls: a call that arrives after the result above it still belongs in the same
    // group, because the group is what the two rules bracket and the run is what they bracket. Prose ends it (the
    // tail stops being a `.tgrp`), and the condensed view keeps its own cut — there a group is the burst the head
    // row tallies, and `joinsTail` is what keeps the append and that repaint honest.
    const tailFlat = Boolean(tail && tail.classList.contains("tgrp") && tail.dataset.gflat === "1");
    const joins = tailFlat
      ? true
      : !tailLines || !globalThis.wtStream || typeof globalThis.wtStream.joinsTail !== "function"
        ? true
        : globalThis.wtStream.joinsTail(
            (state.jobLines.get(evt.id) || []).filter((l) => !isBookkeeping(l)),
            line,
            state.thinkCache.get(evt.id)?.blocks || [],
            tailLines,
          );
    const openGroup = isTool && tail && tail.classList.contains("tgrp") && joins ? tail : null;
    if (isTool) {
      const key = openGroup ? openGroup.dataset.tgrp : `${evt.id}#${Date.now().toString(36)}`;
      // A group that came from a full render has no `_burst`; read its lines back from the DOM so the new call joins
      // the burst the reader is looking at instead of starting a group that shows this line alone.
      const lines = [...(openGroup && tailLines ? tailLines : []), line];
      // The lines of a skill's result are written, not dropped in: this is where each one is handed to the pacer, BEFORE
      // the burst is drawn, so its first paint already shows only the words that may be shown.
      paceResultLine(lines, line, evt.id);
      // A tool chosen by the reader keeps its filter and open body while the burst grows under it.
      const filter = openGroup ? openGroup.dataset.filter || "" : "";
      const bodyEl = openGroup ? openGroup.querySelector(".tgrp-body") : null;
      // A growing burst keeps the offset it was rendered with; a new one starts where this console's earlier bursts
      // stopped consuming this tool's rows.
      let gofs = null;
      if (openGroup) {
        try {
          gofs = openGroup.dataset.gofs ? JSON.parse(openGroup.dataset.gofs) : null;
        } catch {
          gofs = null;
        }
      } else {
        gofs = storeOffsetsBefore(out, null);
      }
      // The group already on screen says whether this console is drawn as a stream; a new one asks its card. A flat
      // piece has no head row and no "N lines" button, so a call appended to it must not grow one back. A NEW group
      // in a card is flat when the reader turned the tally off (Settings > Count tool calls) - the append has to
      // draw the shape the repaint will, or the next repaint would move every row of the burst.
      const flat = openGroup ? openGroup.dataset.gflat === "1" : streaming || !toolGroupsOn();
      // The blank line a reasoning block has always had, before every piece of a stream: a group that opens where
      // another piece already stands is set apart from it, and a group growing in place keeps the separation it was
      // drawn with (the same piece, not a new one). The condensed console has no such blank line, so a flat group
      // there takes none: `streaming`, not `flat`, is what decides.
      const sep = streaming && (openGroup ? openGroup.classList.contains("jl-sep") : Boolean(out.lastElementChild));
      const holder = document.createElement("div");
      holder.innerHTML = toolGroupHtml(lines, key, filter, bodyEl ? !bodyEl.hidden : false, openGroup ? openGroup.dataset.gat || "" : "", gofs, flat ? { flat: true, sep } : {});
      const fresh = holder.firstElementChild;
      if (fresh) {
        fresh._burst = lines;
        if (openGroup) openGroup.replaceWith(fresh);
        else out.appendChild(fresh);
        rememberToolGroup(fresh);
      }
    } else {
      const existing = line.lid ? out.querySelector(`[data-lid="${CSS.escape(String(line.lid))}"]`) : null;
      if (line.mode === "set" && existing) {
        // Same rule as the pacer's paint: write only what the row does not already say. The append's prefix comes
        // from the pacer (typedText), so after a tick this text is usually the one already in the row.
        if (existing._drawn !== shownText) {
          existing.innerHTML = linkifyText(shownText);
          existing._drawn = shownText;
        }
        existing.dataset.ltext = String(line.text ?? "");
      } else {
        const div = document.createElement("div");
        div.className = `jl jl-${line.kind || "raw"}`;
        // A chunk of normal output is a piece of the stream too: the same blank line above it, unless it is the
        // console's first piece. Only the 🌊 console draws that — this is the layout the condensed one already had.
        if (streaming && out.lastElementChild) div.classList.add("jl-sep");
        if (line.lid) div.dataset.lid = line.lid;
        // The line's own text travels with it, the same way a rendered line carries it: a rebuild reads lines
        // back out of the DOM, and this one must read as what was said rather than as what was drawn.
        div.dataset.ltext = String(line.text ?? "");
        div.dataset.lkind = String(line.kind || "raw");
        div.innerHTML = linkifyText(shownText);
        div._drawn = shownText;
        out.appendChild(div);
      }
    }
    if (stick) setScroll(out, out.scrollHeight);
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
    clearSpawnPrompt();
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
    clearSpawnPrompt();
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

// `promptFocus` is the card's own behaviour: after a spawn it puts the caret back in the prompt for the next run. A
// spawn started from a row asks for it off - the reader is working somewhere on the board, and a bare focus() scrolls
// the page up to that box, which is exactly the jump this path exists to avoid.
async function spawnAgent({ promptFocus = true } = {}) {
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
    clearSpawnPrompt();
    clearAttachments("spawn");
    if (promptFocus) $("job-prompt").focus();
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

// The rows themselves are the shared picker's (core/model-menu.js): it walks the catalogue in the
// provider order the page already uses, and it prints each row's price and 0-10 rating from the one
// table /api/models serves. Both model fields build their options with this function, so the board's
// select, the assistant's select and the floating list can never disagree about a row or its price.
// `selected` marks the row inline (the assistant's select is rebuilt from HTML, so it cannot rely on
// setting .value afterwards); `extra` keeps a saved value the catalogue no longer lists visible and checked.
function modelOptionHtml(d, { selected = "", extra = [] } = {}) {
  const out = [];
  let group = null;
  for (const r of ModelMenu.rowsFor(d, { extra })) {
    const sel = r.id === selected ? " selected" : "";
    if (!r.id) {
      out.push(`<option value=""${sel}>${esc(r.name)}</option>`);
      continue;
    }
    if ((r.group || "") !== group) {
      if (group) out.push("</optgroup>");
      group = r.group || "";
      if (group) out.push(`<optgroup label="${esc(group)}">`);
    }
    out.push(`<option value="${esc(r.id)}"${sel}>${esc(ModelMenu.optionText(r))}</option>`);
  }
  if (group) out.push("</optgroup>");
  return out.join("");
}

function renderModelPicker(keep = "") {
  const sel = $("job-model");
  if (!sel) return;
  sel.innerHTML = modelOptionHtml(modelsState);
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  const d = modelsState;
  // Say how old the list is: it is a cache of what the provider advertised, not a live call. The prices
  // and ratings are the panel's own table too, so they date each layer separately — a row with no price
  // is a table that has not been filled, not a model that costs nothing.
  const freshness = d?.fetchedAt ? `list fetched ${relTime(d.fetchedAt)} ago` : "fetched at an unknown time";
  const units = "in/out $ per Mtok · ★ = Artificial Analysis /10";
  const snapshotAt = d?.pricingSnapshotAt ? String(d.pricingSnapshotAt).slice(0, 10) : "";
  const priced = d?.pricedCount
    ? `${d.pricedCount} priced, ${d.ratedCount || 0} rated 0-10 (${units})` +
      (d.pricingAge != null ? `, prices ${relTime(new Date(Date.now() - d.pricingAge * 1000).toISOString())} old` : "") +
      (d.ratedFromSnapshot && snapshotAt ? `, the OpenRouter snapshot of ${snapshotAt} filling the gaps` : "")
    : "no prices yet — Settings → Gateway → Models & prices → Refresh models & prices rebuilds them";
  sel.title = d?.count
    ? `${d.count} model${d.count === 1 ? "" : "s"} available to ${d.provider || "this account"}, ${freshness}` +
      `${d.staleDays > 7 ? " — stale, run: hermes model --refresh" : ""} · ${priced}`
    : "no provider list found in the Hermes home — a run falls back to the gateway's configured model";
  // The floating list is what the reader clicks; the select beneath it is the value and the form's own row.
  ModelMenu.attach(sel, { models: () => modelsState });
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
  programmaticScroll();
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
    if (Math.abs(want - window.scrollY) > 2) {
      programmaticScroll();
      window.scrollTo({ top: want, behavior: "auto" });
    }
  };
  requestAnimationFrame(again);
  setTimeout(again, 120);
}

// Emptying the New-agent prompt empties what it held, chips included: the chip model goes with the text, so
// a cleared box cannot bring back a chip the reader has already sent.
function clearSpawnPrompt() {
  const box = $("job-prompt");
  if (!box) return;
  writeBox(box, "");
  clearBoxDraft(box);
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

// Point the New agent card at one existing worktree, without touching the page: the row's green + starts a run from
// where the reader is, and the card is only the thing that builds it.
function aimSpawnAtWorktree(path, name, projectName = "") {
  $("job-cwd").value = path;
  // The picker has to follow the row, not stay wherever it was: a run created with a stale project is filed, blocked
  // and re-used against that project, and the next change to the picker drags the location field with it.
  if (projectName) {
    const sel = $("job-project");
    if (sel && [...sel.options].some((o) => o.value === projectName)) sel.value = projectName;
  }
  // Aiming at a worktree that exists means "run here": no new workspace.
  $("job-create").checked = false;
  state.spawnTarget = name || null;
  updateSpawnNote();
}

// A run started from a row is the "just start it" path: no per-run choice carries over from the last spawn in the
// card - model, budget and turn cap go back to the form's own defaults. Explicit values the reader set in the card
// are for runs they start there.
function resetSpawnDefaults() {
  const model = $("job-model");
  if (model) model.value = "";
  const reasoning = $("job-reasoning");
  if (reasoning) reasoning.value = "";
  const budget = $("job-budget");
  if (budget) budget.value = "1800";
  const turns = $("job-maxTurns");
  if (turns) turns.value = "";
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
    // readBox: a chip in the box is the text it swallowed, in place, and the run must receive all of it.
    prompt: readBox($("job-prompt")),
    // An explicitly edited location wins over the project picker (the server prefers `cwd`).
    cwd: $("job-cwd").value.trim() || undefined,
    // true = run in that directory as-is (an existing worktree), no new worktree created. The checkbox says
    // the opposite ("create workspace"), so this is where the two meet.
    existing: !$("job-create").checked,
    // Does this worktree exist to LAND? Unchecked (the default) is LOCAL ONLY: the brief says so, and the panel's
    // pre-push guard refuses a push and asks the reader instead. Ticked, the brief names the landing step and the
    // tree's guard allows the push — the reader's own opt-in, in the reader's own words.
    landing: $("job-landing")?.checked ? true : undefined,
    project: $("job-project").value || undefined,
    model: $("job-model").value.trim() || undefined,
    reasoningEffort: $("job-reasoning") && !$("job-reasoning").disabled ? $("job-reasoning").value || undefined : undefined,
    budget: Number($("job-budget").value) || undefined,
    maxTurns: Number($("job-maxTurns").value) || undefined,
    // Skills have no Runs API field. Reasoning uses model_options; per-run approve-all is unavailable.
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
    if (turnLive(j)) cur.running += 1;
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
      ? agents.find(convLive)
      : topAgentOf(r);
    if (!pick) continue;
    const turn = (pick.turns || []).find(turnLive) || (pick.turns || []).at(-1);
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
    programmaticScroll();
    card.scrollIntoView({ block: "center", behavior: "auto" });
    refreshAnchorBaseline();
    state.jumpThread = { thread: found.thread, until: Date.now() + flashRingMs() };
    card.classList.add("jump");
    setTimeout(() => {
      if (state.jumpThread && state.jumpThread.thread === found.thread) state.jumpThread = null;
      // Look the node up again: a running card is rebuilt on every job event, so the node captured here
      // may already be detached, and the class it carries is not part of the render signature.
      document.querySelector(`.job[data-thread="${CSS.escape(found.thread)}"]`)?.classList.remove("jump");
    }, flashRingMs());
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
    programmaticScroll();
    $("jobs").scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  programmaticScroll();
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  refreshAnchorBaseline();
  card.classList.add("jump");
  setTimeout(() => card.classList.remove("jump"), flashRingMs());
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

// One scroll, once, to the card a spawn just produced; the caret goes there too, but focusing never
// scrolls. Returns false when the card is not painted yet, so the caller can retry.
function landOnSpawnedCard(thread) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return false;
  programmaticScroll();
  card.scrollIntoView({ block: "center", behavior: "auto" });
  refreshAnchorBaseline();
  card.classList.add("jump");
  setTimeout(() => {
    document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)?.classList.remove("jump");
  }, flashRingMs());
  // placed: true - this IS the centring; applyPendingFocus must not do it again on the next repaint.
  state.pendingFocus = { thread, until: Date.now() + 20_000, scrollUntil: Date.now() + 6_000, placed: true };
  applyPendingFocus();
  return true;
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
      // Land on the card where it is: jumpToAgent() falls back to scrolling the Agents panel when the
      // card is not painted yet, and a spawn that was still racing its first job event then jumped
      // somewhere else entirely. Here: only scroll when the card exists, and retry quietly otherwise.
      if (!landOnSpawnedCard(thread) && Date.now() - started < deadlineMs) setTimeout(attempt, 400);
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
  threadRowKeyCache = null;
}

// Agents grouped by the worktree that OWNS them (set when the agent was created), so a row can
// list its own agents. Conversations with no owner are "homeless" and stay in the Agents panel.
let agentsByPathCache = null;
// thread -> worktree row key, for turning an event into life on a row. Rebuilt with the panel maps.
let threadRowKeyCache = null;
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
    const why = String(e.message || e);
    // 409 on this route is not a permission answer: it means the thread already has a card. The row's session
    // list is drawn from the last scan, so a session revived a moment ago (or one whose card lives in the
    // unattached panel, or under another row) is still offered here. Show that card instead of a dead end.
    if (/already (has a card|on the board)/i.test(why)) {
      const existing = [...state.jobs.values()].find((j) => (j.thread || j.id) === sessionId);
      if (existing) {
        btn.disabled = false;
        btn.textContent = was;
        showNote("that session is already on the board — showing its card");
        revealSpawnedAgent(existing);
        return;
      }
    }
    btn.disabled = false;
    btn.textContent = was;
    showBanner(`revive ${sessionId}: ${why}`);
  }
}

// A turn is live while it runs - and a turn parked on an approval is still live: the agent is inside the turn,
// waiting on the reader, not finished with it. Counting a parked turn as done is what let a worktree badge say
// "2 awaiting approval" and show no running count at all. A turn HELD on the gateway's 429 cap is live for the
// same reason in the other direction: it has no run id yet, but it owns its thread and its worktree, so it must
// not read as a finished turn (the reply queue and the "is this thread busy" checks both ask this).
const LIVE_STATUS = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);

function turnLive(t) {
  if (!t) return false;
  if (t.status && LIVE_STATUS.has(String(t.status))) return true;
  return Boolean(t.approval && !t.approvalDone);
}

// An approval is only a question while the gateway is still holding it. The window is the gateway's own
// (`approvals.timeout`, carried on the request when it arrives): past it the gateway denies the command by itself
// and moves the turn on, so every place that says "waiting on you" asks this first. An approval with no window at
// all (an older panel record, restored from the store) is left alone rather than guessed at.
function approvalLive(a) {
  if (!a) return false;
  const deadline = Number(a.deadline);
  return !Number.isFinite(deadline) || Date.now() < deadline;
}

// A conversation is live if any of its turns is - not just the newest one. A parked turn can sit behind a newer
// finished one, and asking only `latest` reported such an agent as not running.
function convLive(c) {
  if (!c) return false;
  if (turnLive(c.latest)) return true;
  return (c.turns || []).some(turnLive);
}

function agentsRunning(list) {
  return list.filter(convLive).length;
}

function isAgentRunning(conv) {
  return convLive(conv);
}

function isHomelessConv(conv) {
  // The assistant is not a homeless worker even though it has no worktree: its card belongs to the floating
  // panel, and listing it in the Agents section as well would put two copies of one thread on the page.
  if (conv?.thread === state.assistantThread) return false;
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
  if (s.claude?.on) {
    const head = s.claude.running
      ? "A Claude Code session external to this application is actively taking turns in this worktree."
      : `Claude Code session open here${s.claude.matched === "work" ? " — placed by its newest tool calls, not its start directory" : ""}.`;
    out.push(`<span class="sig sig-claude" title="${esc(hermesTitle(head, s.claude.titles))}">⧉ claude</span>`);
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
  if (s.claude?.on)
    lines.push(
      `Claude Code session active here${s.claude.running ? " (a turn is executing right now)" : ""}: ${(s.claude.titles || []).map((t) => `"${t}"`).join(" · ")}` +
        (s.claude.matched === "work" ? " — placed by its newest tool calls, not its start directory" : ""),
    );
  else if (s.claude?.idle) lines.push(`Claude Code session open here but idle (${s.claude.idle})`);
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
  const waiting = mine.filter((c) => (c.turns || []).some((t) => approvalLive(t.approval) && !t.approvalDone && turnLive(t))).length;
  const cls = waiting ? "sig-approval" : running ? "sig-panel" : "sig-panel-done";
  const bits = [waiting ? `${waiting} awaiting approval` : null, running ? `${running} running` : null].filter(Boolean);
  return `<button class="sig ${cls}" data-open-row="${esc(keyOf(row.project, row.path))}" title="${mine.length} agent${mine.length === 1 ? "" : "s"} owned by this worktree${waiting ? `, ${waiting} parked on a permission request — click to answer it` : running ? `, ${running} running` : ""} — click to open the row and its agents">⧉ ${mine.length}${bits.length ? ` · ${bits.join(" · ")}` : ""}</button>`;
}

// ---- removing a worktree ---------------------------------------------------------------------
// A worktree whose work is already in main and which has nothing uncommitted is housekeeping: its ✕
// deletes it without the in-place question, because there is nothing in that folder main does not
// already have. Everything else keeps the question — unmerged commits, a stale verdict (the cheap pass
// only knows what it last saw), any modified or untracked file, and the main branch itself, which is
// never deleted from this table (the project's own checkout has no ✕ at all).
function deletableWithoutAsking(key) {
  const row = state.rows.get(key);
  if (!row) return false;
  // A locked row never deletes straight through, whatever its verdict says: the lock is the reader's, and a delete
  // that skipped the question is exactly the click the lock exists to stop.
  if (row.lock?.locked) return false;
  if (row.verdictStale) return false;
  if (row.dirty || row.untracked) return false;
  const verdict = String(row.verdict || "");
  if (verdict === "ON MAIN") return false;
  const mainBranch = state.projects.get(row.project)?.mainBranch;
  if (row.branch && mainBranch && row.branch === mainBranch) return false;
  return verdict.startsWith("MERGED");
}

// The red ✕ opens an inline confirmation row under the tree: the question says where the files go
// (Recycle Bin) rather than just "delete?", and nothing happens until the second click. The exception is
// a merged, clean worktree, whose ✕ goes straight through (see deletableWithoutAsking).
function showWorktreeConfirm(key) {
  for (const el of document.querySelectorAll("tr.row-confirm")) el.remove();
  state.confirmEls.clear();
  const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  const row = state.rows.get(key);
  if (!rowEl || !row) return;
  // THE LOCK: the question is replaced by the refusal, in the same place the Delete button would have been. It is
  // loud on purpose — the sentence names the lock and says where to remove it — and there is no Delete button to
  // press, because a button that always fails is worse than no button. The server refuses the same call with the
  // same words (409), so a script or an agent that never saw this row is refused too.
  if (row.lock?.locked) {
    const held = document.createElement("tr");
    held.className = "row-confirm row-locked";
    held.dataset.confirmRow = key;
    held.innerHTML = `<td colspan="${wtColspan()}">
        <div class="row-confirm-cell">
          <span class="rc-msg"><span class="rc-lock">${"\u{1F512}"} locked</span> <b>${esc(row.name)}</b> <span class="dimmer">cannot be deleted:</span> ${esc(row.lock.reason || "this worktree is locked by the reader")}</span>
          <span class="rc-actions"><button class="btn-del-no" type="button" data-del-tree-no="${esc(key)}">Close</button></span>
        </div>
      </td>`;
    rowEl.after(held);
    state.confirmEls.set(key, held);
    showBanner(`🔒 ${row.lock.reason || "this worktree is locked — unlock it in the row first"}`);
    return;
  }
  const confirm = document.createElement("tr");
  confirm.className = "row-confirm";
  confirm.dataset.confirmRow = key;
  // One cell across every column, not a message cell plus the narrow actions column: the table is laid out at a
  // fixed width, so the 3% actions column could not hold two buttons and they were pushed past the card's edge,
  // where `.project`'s overflow clipped them and nothing could be clicked.
  // The flex layout lives on a div INSIDE the cell: a td with `display:flex` stops being a table cell and loses
  // its colspan, which collapsed this row to its content width instead of the card's.
  confirm.innerHTML = `<td colspan="${wtColspan()}">
      <div class="row-confirm-cell">
        <span class="rc-msg"><span class="dimmer">Remove worktree</span> <b>${esc(row.name)}</b> <span class="dimmer">on</span> <span class="mono">${esc(row.branch || "—")}</span><span class="dimmer">? Its files go to the Recycle Bin (recoverable there) and git's record of it is pruned.</span></span>
        <span class="rc-actions"><button class="btn-del-no" type="button" data-del-tree-no="${esc(key)}">Cancel</button><button class="btn-del-yes" type="button" data-del-tree-yes="${esc(key)}">Delete</button></span>
      </div>
    </td>`;
  state.confirmEls.set(key, confirm);
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
    state.confirmEls.delete(key);
    // Drop it here too: the server broadcasts a `drop`, but a tab whose stream hiccuped would keep a
    // row for a worktree that is gone, and this is the tab that asked for the deletion.
    removeRow(project, d.rowPath || target);
    showBanner(
      d.alreadyGone
        ? `worktree row removed — the folder was already gone (${d.name || target})`
        : d.dirLeft
          ? `worktree removed (${d.name || target}) — its files and git record are gone, but ${
              d.panelHolds ? "this panel was started from that folder; restart it to release the folder" : "another process still holds the folder"
            } — the panel will delete the empty folder as soon as it is released`
          : d.recycled
            ? `worktree removed to the Recycle Bin (${d.name || target})${d.branch ? ` on ${d.branch}` : ""}`
            : `worktree deleted (${d.name || target})${d.branch ? ` on ${d.branch}` : ""} — the Recycle Bin declined it, so the files are gone permanently`,
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

// ---- the reader's lock: one press, one scope -----------------------------------------------
// `scope` is "tree" (this worktree) or "branch" (the branch it is on, and every worktree cut from it later). The
// server owns the answer: it writes logs/locks.json, broadcasts a snapshot, and returns the state it now holds, so the
// button paints what is true rather than what was hoped for. A refusal is a banner, never a silent no-op.
async function toggleWorktreeLock(scope, key) {
  const row = state.rows.get(key);
  if (!row) return;
  const btn = document.querySelector(`[data-lock-scope="${scope}"][data-lock-tree="${CSS.escape(key)}"]`);
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch("/api/worktree/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: row.project, path: row.path, branch: row.branch || null, scope }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      showBanner(`lock: ${d.error || `HTTP ${r.status}`}`);
      return;
    }
    showBanner(d.say || (d.locked ? "locked" : "unlocked"));
    // The snapshot the write broadcast repaints this tab too, but a tab whose stream hiccuped would keep the old
    // emoji: re-read once so the row this reader is looking at is right either way.
    await resync();
  } catch (e) {
    showBanner(`lock: ${e.message}`);
  } finally {
    const again = document.querySelector(`[data-lock-scope="${scope}"][data-lock-tree="${CSS.escape(key)}"]`);
    if (again) again.disabled = false;
  }
}

// Cancel/Delete in the confirmation row are consequential, and they sit in a table the board re-ranks
// under the cursor: a repaint between the press and the release replaces the button, the browser delivers
// no click at all, and the reader reports "the delete does nothing" while both buttons are enabled and on
// top. Both answers are therefore read on pointerup (the element under the cursor at release) and this
// short guard makes the click that sometimes still follows a no-op.
const rowConfirmSent = new Map(); // `${key}|${action}` -> when it was answered

function answerRowConfirm(action, key) {
  if (!key) return;
  const id = `${key}|${action}`;
  const at = rowConfirmSent.get(id);
  if (at && Date.now() - at < 4000) return;
  rowConfirmSent.set(id, Date.now());
  if (rowConfirmSent.size > 40) {
    const cut = Date.now() - 60000;
    for (const [k, when] of rowConfirmSent) if (when < cut) rowConfirmSent.delete(k);
  }
  if (action === "yes") {
    void confirmDeleteWorktree(key);
    return;
  }
  const el = state.confirmEls.get(key) || document.querySelector(`tr.row-confirm[data-confirm-row="${CSS.escape(key)}"]`);
  el?.remove();
  state.confirmEls.delete(key);
}

// ---- naming a tree from the work in it ------------------------------------------------------
// The ✎ takes a name from the reader, and the panel's own automatic rename takes one from the title of whichever
// agent finished in the tree last. Neither describes the work: this asks the branch. /api/worktree/suggest-name
// reads the commits on the branch and its diff against the base branch and offers a name built from them, and it
// renames NOTHING — the name, and the commits it came from, go into a question under the row, and the rename
// happens only if the reader answers it. A tree keeps the name it is given (the panel records who gave it and
// when, lib/tree-names.js), so this is the one place a better name can still come from.
const workNames = new Map(); // row key -> the suggestion its confirm box is offering

async function suggestTreeName(btn) {
  const project = btn.dataset.nameProject || "";
  const path = btn.dataset.namePath || "";
  const key = btn.dataset.nameTree || keyOf(project, path);
  btn.disabled = true;
  try {
    const r = await apiFetch(
      "/api/worktree/suggest-name",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, path }) },
      { timeoutMs: 60000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    workNames.set(key, d);
    showNameConfirm(key, d);
  } catch (err) {
    showBanner(`could not read the work in ${path}: ${err.message}`);
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

// The question the ✦ puts up: the name it would take, the commits and files it read, and what the tree is called
// now. Same row-confirm shape as the delete question, and the same reason — nothing happens until the second click.
function showNameConfirm(key, d) {
  for (const el of document.querySelectorAll("tr.row-confirm")) el.remove();
  state.confirmEls.clear();
  const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  if (!rowEl) return;
  const commits = (d.evidence?.commits || []).slice(0, 4).map((c) => `“${esc(c)}”`).join(" · ");
  const files = (d.evidence?.files || []).slice(0, 4).map((f) => esc(f.path)).join(" · ");
  const named = String(d.namedLine || "").trim();
  const confirm = document.createElement("tr");
  confirm.className = "row-confirm row-confirm-name";
  confirm.dataset.confirmRow = key;
  // Nothing to offer (no commits against the base branch and no changed files): say so, and leave the by-hand ✎
  // as the only way through rather than putting a button up that cannot do anything.
  const msg = d.name
    ? `<span class="dimmer">Name</span> <b>${esc(d.current || "")}</b> <span class="dimmer">after the work in it →</span> <b class="mono">${esc(d.dirName || d.name)}</b>
       <span class="dimmer">· ${esc(d.why || "")}${named ? ` · currently ${esc(named)}` : ""}</span>
       ${commits || files ? `<div class="rc-evidence mono dimmer">${commits ? `commits: ${commits}` : ""}${commits && files ? " — " : ""}${files ? `files: ${files}` : ""}</div>` : ""}`
    : `<span class="dimmer">Nothing to name this one from —</span> ${esc(d.why || "no commits against the base branch and no changed files")}`;
  confirm.innerHTML = `<td colspan="${wtColspan()}">
      <div class="row-confirm-cell">
        <span class="rc-msg">${msg}</span>
        <span class="rc-actions">${
          d.name
            ? `<button class="btn-del-no" type="button" data-name-tree-no="${esc(key)}">Cancel</button>
               <button class="btn-del-no" type="button" data-name-tree-edit="${esc(key)}">✎ edit…</button>
               <button class="btn-del-yes" type="button" data-name-tree-yes="${esc(key)}">Name it</button>`
            : `<button class="btn-del-no" type="button" data-name-tree-no="${esc(key)}">Cancel</button>
               <button class="btn-del-no" type="button" data-name-tree-edit="${esc(key)}">✎ name it by hand</button>`
        }</span>
      </div>
    </td>`;
  state.confirmEls.set(key, confirm);
  rowEl.after(confirm);
}

// The ✎ with the offered name already in the box: the same by-hand path, so a reader who wants a word changed does
// not have to start from the old name.
function editNameFromWork(key) {
  const d = workNames.get(key);
  const btn = document.querySelector(`[data-rename-tree="${CSS.escape(key)}"]`);
  if (!btn) return;
  if (d?.dirName || d?.name) btn.dataset.renameSuggest = d.dirName || d.name;
  void renameWorktreePrompt(btn);
}

// Take the offered name: /api/worktree/rename, the one path that renames anything, with the reader written down as
// the one who named it.
async function confirmNameWorktree(key) {
  const d = workNames.get(key) || {};
  const [project, ...rest] = key.split("::");
  const path = rest.join("::");
  const confirmEl = document.querySelector(`tr.row-confirm[data-confirm-row="${CSS.escape(key)}"]`);
  const yes = confirmEl?.querySelector("[data-name-tree-yes]");
  if (yes) {
    yes.disabled = true;
    yes.textContent = "naming…";
  }
  try {
    const r = await apiFetch(
      "/api/worktree/rename",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          path,
          name: d.dirName || d.name,
          by: "the reader (✦ from the work)",
          how: d.why ? `named from the work: ${d.why}` : "named from the work",
        }),
      },
      { timeoutMs: 120000 },
    );
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    // A moved directory is a moved row: the board's own name, the open state and the question row follow it.
    if (out.path && out.path !== path) {
      const rowKey = keyOf(project, path);
      state.treeNames.delete(rowKey);
      state.treeNames.set(keyOf(project, out.path), out.name || d.name);
      if (state.expanded.delete(rowKey)) state.expanded.add(keyOf(project, out.path));
      saveTreeNames();
      state.confirmEls.get(key)?.remove();
      state.confirmEls.delete(key);
      workNames.delete(key);
    }
    confirmEl?.remove();
    state.confirmEls.delete(key);
    showBanner(
      `“${out.name || d.name}” · branch ${out.branch || "unchanged"}${out.moved === false ? ` — the directory keeps its old name` : ""}${
        out.namedLine ? ` · ${out.namedLine}` : ""
      }`,
    );
    await resync();
  } catch (err) {
    showBanner(`could not name it “${d.dirName || d.name}”: ${err.message}`);
    if (yes) {
      yes.disabled = false;
      yes.textContent = "Name it";
    }
  }
}

// The ✦, the ✎ and Cancel in a naming question: answered on the release, like the delete question and for the same
// reason (a repaint between press and release replaces the button and the click is never delivered).
function answerNameConfirm(action, key) {
  if (!key) return;
  const id = `${key}|name-${action}`;
  const at = rowConfirmSent.get(id);
  if (at && Date.now() - at < 4000) return;
  rowConfirmSent.set(id, Date.now());
  const el = state.confirmEls.get(key) || document.querySelector(`tr.row-confirm[data-confirm-row="${CSS.escape(key)}"]`);
  if (action === "yes") {
    void confirmNameWorktree(key);
    return;
  }
  el?.remove();
  state.confirmEls.delete(key);
  if (action === "edit") editNameFromWork(key);
}

// ---- naming a tree by hand (the ✎) -----------------------------------------------------------
// A worktree carries the name of the prompt that cut it - 24 characters, usually mid-word - while the agent names
// itself from what the work turned out to be a moment later. This puts a name on the row (at once, in this browser)
// and asks the server to do the git half: the branch, and the directory when nothing is holding it open.
async function renameWorktreePrompt(btn) {
  const project = btn.dataset.renameProject || "";
  const path = btn.dataset.renamePath || "";
  const current = btn.dataset.renameName || String(path).split(/[\\/]/).filter(Boolean).pop() || "";
  const suggested = String(btn.dataset.renameSuggest || "").trim() || current;
  const name = window.prompt(
    `name this worktree\n\ndirectory: ${current}\nbranch and directory name:`,
    suggested,
  );
  if (name === null) return;
  const clean = name.trim();
  if (!clean) return;
  const rowKey = btn.dataset.renameTree || keyOf(project, path);
  // The board shows the new name immediately; the git half is best-effort and reports back below.
  state.treeNames.set(rowKey, clean);
  saveTreeNames();
  if ($("projects")) renderProjectRows(project);
  btn.disabled = true;
  try {
    const r = await apiFetch(
      "/api/worktree/rename",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, path, name: clean, by: "the reader (✎ by hand)", how: `named by hand from the row${suggested && suggested !== clean ? ` (offered “${suggested}”)` : ""}` }) },
      { timeoutMs: 120000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // A moved directory is a moved row: the key, the open state and the name follow it.
    if (d.path && d.path !== path) {
      state.treeNames.delete(rowKey);
      state.treeNames.set(keyOf(project, d.path), clean);
      if (state.expanded.delete(rowKey)) state.expanded.add(keyOf(project, d.path));
      saveTreeNames();
    }
    showBanner(
      d.unchanged
        ? `“${clean}” — already its name`
        : `“${clean}” · branch ${d.branch || "unchanged"}${d.moved === false ? ` — the directory keeps its old name` : ""}`,
    );
    await resync();
  } catch (err) {
    showBanner(`named it “${clean}” here — the git half failed: ${err.message}`);
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

// ---- a child worktree off this row's branch -------------------------------------------------
// The roll-up's other half, and the only thing this control does: it cuts a tree from the ROW's branch, never from the
// project checkout. `⇥ → Roll into <parent>` merges a child into the branch it was cut from, INSIDE that branch's own
// worktree — so the parent has to be a worktree branch, and until this existed the panel could only cut children of
// main, the one target a roll may never use. Nothing is started in the new tree: it lands on the board as a row.
//
// The name is asked for in the page's own prompt (the ✎ uses the same one) and it is OPTIONAL — an empty answer means
// "name it after the branch it was cut from", which is what the server does with no name. The -<hex6> tag is always
// the server's: it is the tree's identity through every later rename.
const childPresses = new Map(); // row key -> when its + was last taken, so a double click is one tree

async function cutChildTree(btn) {
  const project = btn.dataset.childProject || "";
  const path = btn.dataset.childPath || "";
  const parent = btn.dataset.childBranch || "";
  const key = btn.dataset.childTree || keyOf(project, path);
  // One press, one tree. A second child of the same branch is a second press — a double click is not.
  if (Date.now() - (childPresses.get(key) || 0) < 3000) return;
  const offered = String(parent).split("/").filter(Boolean).pop().replace(/-[0-9a-f]{6}$/i, "");
  const asked = window.prompt(
    `cut a child worktree off ${parent}\n\n` +
      `its branch: wtgui/<name>-<tag>, cut from ${parent}\n` +
      `nothing is started in it and nothing is pushed — it becomes a row of its own\n\n` +
      `name${offered ? ` (empty = “${offered}”)` : ""}:`,
    "",
  );
  if (asked === null) return; // cancelled: nothing was cut, and no record says otherwise
  childPresses.set(key, Date.now());
  btn.disabled = true;
  btn.classList.add("is-starting");
  try {
    const r = await apiFetch(
      "/api/worktree/child",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, path, name: String(asked).trim() }) },
      { timeoutMs: 120000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    showBanner(`cut ${d.branch} from ${parent} — ${d.name || d.branch} is a row now, and its UNMERGED chip rolls it back into ${parent}`);
    await resync();
  } catch (err) {
    showBanner(`could not cut a child of ${parent}: ${String((err && err.message) || err)}`);
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove("is-starting");
    }
  }
}
// ---- end a child worktree off this row's branch

// ---- merge control: the UNMERGED chip ------------------------------------------------------
// A row that carries commits main does not have is the one row with an action worth taking, so that chip is a button:
// one click starts an agent IN that worktree whose whole job is to land the branch (the script is lib/merge-prompt.js
// on the server). The button exists only while the tree is clean — a merge agent commits what it finds, so a
// half-finished tree would land somebody else's work — and while no merge agent is already working that tree. Both
// facts are re-read from git by the route, so a stale board cannot start one by accident.
const mergeInFlight = new Map();
// The chip a press started on, so a release that lands on a rebuilt one still starts the same merge.
let mergePress = null;

function mergeAgentLabel(row) {
  for (const a of agentsFor(row) || []) {
    const label = String(a?.latest?.label || a?.first?.label || "");
    if (!label.startsWith("MERGING into ")) continue;
    if (convLive(a)) return label;
  }
  return null;
}

// The same question for the chooser's fourth outcome: a CHECKING agent already reading this tree. The route refuses a
// second one, so the button is drawn disabled with the reason in its tooltip rather than looking like a dead control.
function checkAgentLabel(row) {
  for (const a of agentsFor(row) || []) {
    const label = String(a?.latest?.label || a?.first?.label || "");
    if (!label.startsWith("CHECKING ")) continue;
    if (convLive(a)) return label;
  }
  return null;
}

function baseBranchOf(row) {
  return String(state.projects.get(row.project)?.mainBranch || "").trim() || "main";
}

// Where a rebase of this row lands, in the page's own words: the recorded parent when there is a local one, otherwise
// the ref the board already measures the branch against (origin/<main>). It is a LABEL, not the decision — the route
// picks the target by proof and its answer names the ref it actually used, because a base ref that sits behind the
// local main branch falls back to that branch and says so.
function rebaseTargetOf(row, parent) {
  if (parent.local) return parent.parent;
  return String(row?.baseRef || "").trim() || parent.main;
}

function verdictHtml(row) {
  const verdict = String(row.verdict || "");
  const cls = `badge ${verdictClass(verdict)}${row.verdictStale ? " stale" : ""}`;
  const text = esc(row.verdict);
  // The count against the project's main lives HERE now: the Ahead / Behind column counts the branch against its own
  // copy on the remote. Every title below ends with it, and a plain badge, which had no title at all, carries it alone.
  // Inline, not a helper: this region is read out of the page on its own (tools/verify-merge-chip.mjs).
  const vs =
    row.baseRef && row.ahead !== null && row.ahead !== undefined
      ? `Against ${row.baseRef}: ${Number(row.ahead) || 0} ahead, ${Number(row.behind) || 0} behind.`
      : "";
  const withVs = (t) => (vs ? `${t} — ${vs}` : t);
  // Every other verdict is a statement; only UNMERGED has an action behind it.
  if (!verdict.startsWith("UNMERGED")) return `<span class="${cls}"${vs ? ` title="${esc(vs)}"` : ""}>${text}</span>`;
  const key = keyOf(row.project, row.path);
  const attrs =
    `data-merge-start="${esc(key)}" data-merge-project="${esc(row.project)}" data-merge-path="${esc(row.path)}"` +
    ` data-merge-branch="${esc(row.branch || "")}" data-merge-label="${esc(row.verdict)}"`;
  const merging = mergeAgentLabel(row);
  if (merging) {
    return `<button type="button" class="${cls} merge-start is-merging" ${attrs} disabled title="${esc(
      withVs(`${merging} is working this tree now — its card is under this row`),
    )}">${text}</button>`;
  }
  const dirty = Number(row.dirty) || 0;
  const untracked = Number(row.untracked) || 0;
  if (dirty || untracked) {
    // Not a dead button: the chip stays a statement and its tooltip says what would make it an action, so a click
    // can never start a merge over uncommitted work.
    return `<span class="${cls}" title="${esc(
      withVs(`this is merged by an agent, not by hand: ${dirty} modified and ${untracked} untracked file(s) are somebody's unfinished work — commit or stash them and the button appears`),
    )}">${text}</span>`;
  }
  const base = baseBranchOf(row);
  const parent = mergeParentOf(row);
  return `<button type="button" class="${cls} merge-start" ${attrs} title="${esc(
    withVs(mergeChooserTitle(row, parent)),
  )}">${text}<span class="merge-glyph" aria-hidden="true">\u21e5</span></button>`;
}
// ---- end merge control

// ---- the UNMERGED chip's chooser ---------------------------------------------------------------
// The chip used to start a merge agent on the press. It now opens five outcomes and starts NOTHING until one of them
// is clicked, because "land this" is not one decision: a child cut from a turnover branch belongs ON that branch (a
// roll-up, done in the parent's own worktree), a child that has nowhere local to go belongs on a PR, a child whose
// parent is master or unknown is a question for the reader, and a child that may ALREADY be on main needs somebody to
// say so from the content — the commit count cannot, because a squash merge leaves the branch ahead forever.
//
// The fifth is the CATCH-UP, and the only one that is not an agent: a rebase of this branch onto its parent's newest
// commit, run by the server as one git command (lib/rebase.js). It writes this branch and nothing else, so it needs
// no run, no gateway, no permission box — and it is what makes a later roll a fast-forward instead of a merge commit.
//
// That last outcome is the one that acts on the far side: its agent reads only, and a LANDED: YES is what makes the
// panel move the worktree to the Recycle Bin (the server's own sweep, through the ✕'s act). The button says so.
//
// `parent` is the branch this tree was cut from and `parentSource` says how sure that is: "cut" (the panel watched it),
// "backfilled" (guessed from a shared ticket id in the branch name) or "unknown". Only a "cut" record may drive a
// write, so a backfilled parent is SHOWN and the roll button is disabled with the reason in the popover.
function mergeParentOf(row) {
  const main = baseBranchOf(row);
  const parent = String(row?.parent || "").trim();
  const source = String(row?.parentSource || "unknown");
  const isMain = !parent || parent === main || /^(master|main|trunk|develop)$/i.test(parent);
  // "Local branch" excludes master/main: rolling into those is what the merge agent and the PR path are for.
  const local = Boolean(parent) && !isMain;
  return {
    parent: parent || null,
    sha: row?.parentSha || null,
    source,
    main,
    isMain,
    local,
    // A roll-up writes INSIDE the parent's worktree. Only a recorded cut may do that, never a guess.
    rollable: local && source === "cut",
  };
}

function mergeChooserTitle(row, parent) {
  // The fourth outcome, worded once so every branch of the tooltip says the same thing about what it costs: an agent
  // reads the base for this branch's own change, and when it is there the panel deletes the tree.
  const check = `have an agent check whether the change is already on ${parent.main} (if it is, this worktree goes to the Recycle Bin)`;
  if (parent.rollable) {
    return `choose what happens to ${row.branch || "this branch"}: roll it into ${parent.parent} (fast-forward or merge, inside that branch's own worktree), ` +
      `rebase it onto ${parent.parent}'s newest commit (one git command, nothing but this branch written), open a PR, ${check}, or ask where it should go — nothing happens until you pick one`;
  }
  if (parent.local) {
    return `${row.branch || "this branch"} looks like it belongs on ${parent.parent}, but that parent is a ${parent.source} guess — ` +
      `the panel will not merge on a guess: rebase it onto ${parent.parent}'s newest commit (that writes only this branch), open a PR, ${check}, or say where it should go`;
  }
  return `choose what happens to ${row.branch || "this branch"}: rebase it onto ${rebaseTargetOf(row, parent)}'s newest commit, open a PR, ${check}, or ask where it should go — ` +
    `its parent is ${parent.parent ? `${parent.parent} (a main branch)` : "unknown"}, which is never a roll-up target`;
}

let mergeChooser = null; // { key, el, at }

function closeMergeChooser() {
  if (!mergeChooser) return;
  try {
    mergeChooser.el.remove();
  } catch {
    /* already gone with a repaint */
  }
  mergeChooser = null;
}

// The popover. Appended to the body and positioned against the chip, so a table repaint under it cannot take it out —
// and so the reader can still read the choice while the row it belongs to re-ranks.
function openMergeChooser(key) {
  const row = state.rows.get(key);
  if (!row) return;
  closeMergeChooser();
  const parent = mergeParentOf(row);
  const chip = document.querySelector(`[data-merge-start="${CSS.escape(key)}"]`);
  const notes = [];
  if (parent.rollable) notes.push(`fast-forward or merge inside ${parent.parent}'s own worktree — never the main branch`);
  else if (parent.local) notes.push(`${parent.parent} is a ${parent.source} guess, so rolling is refused: a guess may not drive a merge`);
  else if (parent.parent) notes.push(`${parent.parent} is a main branch — the turnover destination is a PR, not a roll`);
  else notes.push(`no parent was recorded for this tree, and the panel will not invent one`);
  // A branch with its own copy on the remote is about to have that copy's shas rewritten, so the note says so before
  // the press rather than letting the Ahead / Behind column read like a breakage afterwards.
  const publishedRef = String(row?.sync?.ref || "").trim();
  const btn = (choice, label, extra = "", disabled = false, title = "") =>
    `<button type="button" class="mc-choice${extra}" data-merge-choice="${choice}" data-mc-key="${esc(key)}"${disabled ? " disabled" : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
  // A check agent already reading this tree: one at a time, and the button says who rather than going quietly dead.
  const checkLive = checkAgentLabel(row);
  const el = document.createElement("div");
  el.className = "merge-chooser";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "what should happen to this branch");
  el.dataset.mcKey = key;
  el.innerHTML =
    `<div class="mc-head">${esc(row.branch || "this branch")}${parent.parent ? ` <span class="mc-from">cut from ${esc(parent.parent)}${parent.sha ? ` @ ${esc(String(parent.sha).slice(0, 8))}` : ""}${parent.source === "cut" ? "" : ` · ${esc(parent.source)}`}</span>` : ""}</div>` +
    (parent.rollable
      ? btn("roll", `Roll into ${parent.parent}`, " is-roll")
      : btn("roll", parent.parent ? `Roll into ${parent.parent}` : "Roll into its parent", " is-roll", true)) +
    // The rebase is the one outcome that is a plain git command rather than a run, so it says so: no agent, no
    // gateway, no bill. It sits beside the roll because catching the child up is what turns that roll into a
    // fast-forward instead of a merge commit in the parent.
    btn("rebase", `Rebase on ${rebaseTargetOf(row, parent)}`, " is-rebase") +
    btn("pr", "Open a PR", " is-pr") +
    // The fourth outcome, and the only one that can delete the tree: it says so on the popover's own note line, because
    // "check whether it landed" sounds read-only and half of it is not.
    btn("check", `Check whether it is on ${parent.main}`, " is-check", Boolean(checkLive),
      checkLive ? `${checkLive} is already reading this tree — one check at a time` : `start an agent that reads ${parent.main} for this branch's own change; if the change is there, this worktree goes to the Recycle Bin`) +
    btn("ask", "Where should this go?", " is-ask") +
    `<div class="mc-note">${esc(notes.join(" · "))}</div>` +
    // The rebase's own note: what it writes, and the two facts a reader would otherwise discover the hard way — the
    // shas of this branch change, and a copy already on the remote then needs a force-push. A conflict is not a
    // half-rebased tree here; it is an abort.
    `<div class="mc-note mc-note-rebase">${esc(
      `rebase replays this branch's own commits onto ${rebaseTargetOf(row, parent)}'s newest commit and rewrites their shas${publishedRef ? ` — its copy on ${publishedRef} will then need a force-push` : ""}; no agent, nothing else is written, and a conflict aborts leaving the tree exactly as it was`,
    )}</div>` +
    `<div class="mc-note mc-note-check">${esc(
      `the check reads ${parent.main} against this branch's own change and writes nothing to either branch — but if the change is already there it moves this worktree to the Recycle Bin (unlocked and clean only)${checkLive ? ` · ${checkLive} is reading it now` : ""}`,
    )}</div>`;
  document.body.appendChild(el);
  const rect = chip ? chip.getBoundingClientRect() : null;
  if (rect) {
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8));
    const top = rect.bottom + 6 + el.offsetHeight > window.innerHeight ? Math.max(8, rect.top - el.offsetHeight - 6) : rect.bottom + 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  mergeChooser = { key, el, at: Date.now() };
}

// One click, one outcome. Nothing here runs on the press that opened the chooser.
async function chooseMergeOutcome(what, key) {
  const row = state.rows.get(key);
  if (!row) return;
  const parent = mergeParentOf(row);
  if (what === "pr") {
    // The existing path, unchanged: the merge agent does the landing (and the PR) exactly as it always has.
    return startMerge({ key, project: row.project, path: row.path, label: row.verdict || "" });
  }
  if (what === "rebase") {
    // The one outcome that is a git command rather than a run. The route re-reads the tree from git, picks the target
    // by proof, replays this branch and nothing else, and answers 409 with the colliding paths (already aborted) when
    // it conflicts — so there is nothing to confirm here beyond the choice the reader just made in the popover.
    try {
      const r = await apiFetch(
        "/api/worktree/rebase",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: row.project, path: row.path }) },
        { timeoutMs: 180000 },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showBanner(
        `rebased ${d.branch || row.branch || "the branch"} onto ${d.target} (${d.fromShort} → ${d.toShort}, ${d.replayed} commit${d.replayed === 1 ? "" : "s"} replayed)` +
          (d.published ? ` — its copy on the remote will need a force-push` : ""),
      );
      await resync();
    } catch (e) {
      showBanner(`could not rebase ${row.branch || "the branch"} — ${String(e.message || e)}`);
    }
    return;
  }
  if (what === "ask") {
    try {
      const r = await apiFetch(
        "/api/worktree/parent-question",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: row.project, path: row.path, branch: row.branch || null, note: parent.rollable ? `asked instead of rolling into ${parent.parent}` : "no parent the panel may write to", by: "the reader (chip)" }) },
        { timeoutMs: 30000 },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showBanner(`asked where ${row.branch || "this tree"} should go — recorded, nothing was started`);
    } catch (e) {
      showBanner(`could not record the question — ${String(e.message || e)}`);
    }
    return;
  }
  if (what === "check") {
    // Read-only on both branches, and the panel acts on the answer itself: the run is lib/verify-prompt.js, and a
    // LANDED: YES is what makes the server move this tree to the Recycle Bin (lib/worktree-remove.js). So there is
    // nothing here to confirm beyond the choice the reader already made in the popover.
    try {
      const r = await apiFetch(
        "/api/worktree/verify-landed",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: row.project, path: row.path }) },
        { timeoutMs: 120000 },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showBanner(`${d.label || "CHECKING"} started · ${d.branch || "branch"} against ${d.baseRef || d.base || "the base"} — the tree is deleted only if the answer is yes`);
      if (d.job) {
        updateJob(d.job, { scroll: false });
        revealSpawnedAgent(d.job);
      }
      await resync();
    } catch (e) {
      showBanner(`could not start the check — ${String(e.message || e)}`);
    }
    return;
  }
  if (what !== "roll") return;
  const inFlight = mergeInFlight.get(key) || 0;
  if (Date.now() - inFlight < 15000) return;
  mergeInFlight.set(key, Date.now());
  try {
    const r = await apiFetch(
      "/api/worktree/rollup",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: row.project, path: row.path, parent: parent.parent, branch: row.branch || null, confirm: true }) },
      { timeoutMs: 120000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    showBanner(`rolled ${row.branch || "the branch"} into ${d.parentBranch || parent.parent} (${d.method || "merge"}${d.sha ? ` ${d.sha}` : ""})`);
    await resync();
  } catch (e) {
    mergeInFlight.delete(key);
    showBanner(`could not roll ${row.branch || "the branch"} into ${parent.parent} — ${String(e.message || e)}`);
  }
}

// One click, and the agent is the server's business: this only says where. A repaint can replace the button between
// press and release (the board rebuilds the table on every scan), so the click is taken at pointerup in the delegated
// handler and the request is keyed on the row, not on the node.
async function startMerge(target) {
  // A target, not a button: the chooser has no chip to read the row's facts from (the chip may be a rebuilt node, or
  // gone), and the row key is what names the request either way.
  const path = String(target?.path || "");
  const project = String(target?.project || "");
  if (!path) return;
  const key = target?.key || keyOf(project, path);
  if (Date.now() - (mergeInFlight.get(key) || 0) < 15000) return;
  mergeInFlight.set(key, Date.now());
  const label = String(target?.label || "");
  const btn = target?.btn && target.btn.isConnected ? target.btn : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-starting");
    btn.textContent = "starting…";
  }
  try {
    const r = await apiFetch(
      "/api/worktree/merge",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, path }) },
      { timeoutMs: 120000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    showBanner(`${d.label || "MERGING"} started · ${d.branch || "branch"} → ${d.base || "base"}${d.job?.id ? ` · ${d.job.id}` : ""}`);
    if (d.job) {
      updateJob(d.job, { scroll: false });
      revealSpawnedAgent(d.job);
    }
    await resync();
  } catch (e) {
    mergeInFlight.delete(key);
    showBanner(`could not start the merge — ${String(e.message || e)}`);
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove("is-starting");
      btn.textContent = label;
    }
  }
}

// Why this row is showing that PR. The panel renames a worktree's branch after the thread slug, so a chip found
// by the tree's tag has to say so — otherwise it cannot be told apart from one found by the branch's own name,
// and that difference is the whole point of the tag route (a branch switched inside one tree gets no chip).
function prMatchNote(pr) {
  if (pr?.matched === "tag") return " · matched by the worktree tag: the panel renamed this branch, and it still carries that PR's commit";
  if (pr?.matched === "upstream") return " · matched by the branch's upstream ref, which this branch still tracks";
  return "";
}

// ---- the branch cell: a link only when the remote actually has that branch ----------------------------
// The URL is built by the SERVER (`row.branchUrl`, from the project's own remote through `githubRepo()` in
// lib/projects.js) and from git's own answer to "does the remote have this branch" — so it is null unless a page
// is certain to exist, and this renders a link or plain text, never a guess. The cell's `mono branch` class and
// its column sizing are untouched, and the row's own click handler already steps aside for an `<a>` (it treats
// `a` like a button), so the link opens the remote page and nothing else.
//
// A branch with no copy on the remote says why in its title AND carries one dim word. That word is the answer to
// the question the chart was asked to answer at a glance — which trees exist on the remote and which are local
// only — and it is the SERVER's answer (`row.branchChip`, written by decorate from the remote's own head list),
// never one re-derived here. Two words, because there are two different claims: `local` is the remote's own denial,
// and `unverified` is the panel admitting it could not tell (the remote was unreachable, or the scan had not read
// the branch yet). The second is not a weaker `local` — a row wearing nothing at all looked identical to one that was
// never pushed, which is the bug: the reader had to open a tooltip to learn the branch was probably on the remote.
// A project without a remote has every branch local, and the title says that instead of marking each row.
// ---- branch cell: the link, and the local chip
function branchCellHtml(row) {
  const name = esc(row.branch || "—");
  if (row.branchUrl) {
    const how = row.branchLinkFrom === "local-refs" ? " (found in refs/remotes from the last fetch — the remote itself was not asked)" : "";
    return `<a class="branch-link" href="${esc(row.branchUrl)}" target="_blank" rel="noopener" title="${esc(`open ${row.branch} on the remote${how}`)}">${name}</a>`;
  }
  const why = row.branchWhy || (row.remoteBranch === "n/a" ? "no remote configured" : "not read yet — the remote has not been asked about this branch");
  // `branchChip` is decorate's; the `branchLocalOnly` fallback keeps a row drawn from an older payload's field honest.
  // A row with no branch at all carries no word: there is nothing for `local` or `unverified` to be about.
  const chip = row.branch ? row.branchChip || (row.branchLocalOnly === true ? "local" : null) : null;
  const chipHtml =
    chip === "local"
      ? `<span class="branch-local" title="${esc(why)}">local</span>`
      : chip === "unverified"
        ? `<span class="branch-unverified" title="${esc(why)}">unverified</span>`
        : "";
  return `<span class="branch-plain" title="${esc(why)}">${name}</span>${chipHtml ? ` ${chipHtml}` : ""}`;
}
// ---- end branch cell

// ---- ahead / behind cell: the branch against its OWN copy on the remote -------------------------------------------
// ↑ is work that is not pushed, ↓ is work that is not pulled — what `git status` and every git client mean by "ahead /
// behind". The count is the SERVER's answer (`row.sync`, lib/sync-state.js, derived from the fresh `status` read of
// every scan); the page draws it and picks no word of its own. `row.ahead` / `row.behind` are the count against the
// project's main — a different question, "is this work in main?" — and they live in the verdict and in this cell's
// tooltip, not in the cell.
//
//   level / ahead / behind / diverged   ↑N ↓M, the side with work to do lit, a side with none dim
//   gone       the branch's copy was deleted on the remote
//   untracked  the remote has a branch of this name, but this tree does not track it
//   none       no copy on the remote: never pushed
//   stale      the project's last fetch FAILED, so the counts are as of the last fetch that worked: dotted, with a `?`
//
// A page newer than the server that feeds it (the board serves public/ fresh while a process keeps the code it started
// with) gets rows with no `row.sync`: the old numbers are drawn, labelled for what they count, with the one sentence
// that says how to get the real ones.
function vsMainLine(row) {
  if (!row || row.ahead === null || row.ahead === undefined || !row.baseRef) return "";
  const a = Number(row.ahead) || 0;
  const b = Number(row.behind) || 0;
  return `Against ${row.baseRef}: ${a} commit${a === 1 ? "" : "s"} here that it does not have, ${b} on it that this branch does not have (the verdict is built from this).`;
}

function aheadBehindCellHtml(row) {
  const main = vsMainLine(row);
  const s = row?.sync;
  if (!s) {
    const body =
      row?.ahead === null || row?.ahead === undefined
        ? "—"
        : `<span class="${row.ahead ? "dirty" : "dimmer"}">${row.ahead}</span> / ${row.behind ?? "—"}`;
    const why = `${main ? `${main} ` : ""}This board's server is older than this page, so it cannot count against the branch's own copy on the remote yet — restart the board.`;
    return `<span class="ab ab-legacy" data-sync="legacy" title="${esc(why)}">${body}</span>`;
  }
  const dim = (t) => `<span class="dimmer">${t}</span>`;
  const up = (n) => `<span class="dirty ab-up">↑${n}</span>`;
  const down = (n) => `<span class="ab-down">↓${n}</span>`;
  let body;
  switch (s.state) {
    case "level":
      body = `${dim("↑0")} ${dim("↓0")}`;
      break;
    case "ahead":
      body = `${up(s.ahead)} ${dim("↓0")}`;
      break;
    case "behind":
      body = `${dim("↑0")} ${down(s.behind)}`;
      break;
    case "diverged":
      body = `${up(s.ahead)} ${down(s.behind)}`;
      break;
    case "gone":
      body = dim("gone");
      break;
    case "untracked":
      body = dim("?");
      break;
    default:
      body = dim("—");
  }
  const counted = ["level", "ahead", "behind", "diverged"].includes(s.state);
  const stale = counted && Boolean(s.stale);
  const title = [s.why, main].filter(Boolean).join(" ");
  const data = counted ? ` data-ahead="${esc(s.ahead)}" data-behind="${esc(s.behind)}"` : "";
  return `<span class="ab${stale ? " ab-stale" : ""}" data-sync="${esc(s.state)}"${data} title="${esc(title)}">${body}${stale ? `<span class="ab-q" aria-label="stale">?</span>` : ""}</span>`;
}
// ---- end ahead / behind cell

// The PR cell: the number and state are the server's (row.pr), and the PAGE is the project's host record — `row.prUrl`
// is built by the same template as the branch cell, so `.../pull-requests/12` and `.../pull/12` both come out right
// without this file knowing which host it is looking at. No URL (an unmapped project, or a host whose pull template
// cannot be filled): the same chip, plain, with the reason in its title. Never an `<a>` around a guessed page.
function prCellHtml(row) {
  if (!row.pr) {
    return row.remoteBranch === "gone" ? `<span class="dimmer">none · branch gone</span>` : `<span class="dimmer">none</span>`;
  }
  const cls = row.pr.state === "OPEN" ? "pr-open" : "pr-merged";
  const text = `#${row.pr.number} ${row.pr.state}`;
  const why = row.prUrl ? "" : row.prWhy ? ` · no PR page: ${row.prWhy}` : "";
  const title = `${row.pr.title || ""}${prMatchNote(row.pr)}${why}`;
  if (row.prUrl) {
    return `<a class="pr-link ${cls}" href="${esc(row.prUrl)}" target="_blank" rel="noopener" title="${esc(`${text} — open this PR${why}`)}">${esc(text)}</a>`;
  }
  return `<span class="${cls}" title="${esc(title)}">${esc(text)}</span>`;
}

function rowHtml(row) {
  const isOpen = state.expanded.has(keyOf(row.project, row.path));
  const dirty =
    row.dirty || row.untracked
      ? `<span class="dirty">${row.dirty}</span>${row.untracked ? ` <span class="dimmer">+${row.untracked}?</span>` : ""}`
      : `<span class="clean">clean</span>`;
  const pr = prCellHtml(row);
  const badge = verdictHtml(row);
  // The project's own checkout is not a worktree anyone may delete or rename from here: it keeps the folder's name.
  const isProjectRoot = isProjectRootRow(row);
  // A tree is named from the prompt, cut at 24 characters; the agent names itself better a moment later. The button
  // offers that name first and takes anything the reader types. The branch column already carries the real name, so
  // the row does not repeat it here.
  const shownTitle = treeTitleOf(row);
  const shownName = shownTitle || row.name;
  const suggestName = shownTitle || "";
  // Who gave this tree the name it has, and when — the panel's own record (lib/tree-names.js), the one fact about
  // naming that git does not hold. It is what makes "the panel will not rename this again by itself" visible.
  const namedLine = String(row.named?.line || "").trim();
  // A title the panel's own naming looked at and DECLINED (it promised a PR, a commit, a merge). The tree keeps
  // the name it was cut with, and the row says why rather than looking like a naming that never arrived.
  const offerLine = String(row.nameOffer?.line || "").trim();
  const renameBtn = isProjectRoot
    ? ""
    : `<button class="btn-row-rename" data-rename-tree="${esc(keyOf(row.project, row.path))}" data-rename-project="${esc(row.project)}" data-rename-path="${esc(row.path)}" data-rename-name="${esc(row.name)}" data-rename-suggest="${esc(suggestName)}" title="name this worktree by hand — renames its branch, and the directory when nothing is holding it${suggestName ? ` (offered: “${esc(suggestName)}”)` : ""}${namedLine ? ` · ${esc(namedLine)}` : ""}${offerLine ? ` · ${esc(offerLine)}` : ""}">\u270e</button>`;
  // ✦ offers a name read from the work itself: the branch's commits and its diff against the base branch, via
  // /api/worktree/suggest-name. It renames nothing on its own — it puts a question under the row, with the commits
  // the name came from, and the rename is the reader's second click.
  const nameFromWorkBtn = isProjectRoot
    ? ""
    : `<button class="btn-row-name-work" data-name-tree="${esc(keyOf(row.project, row.path))}" data-name-project="${esc(row.project)}" data-name-path="${esc(row.path)}" title="name this worktree from the work in it — reads its commits and its diff against ${esc(baseBranchOf(row))} and offers a name built from them (asks first; the branch is renamed and the six-hex tag kept) · the panel's own naming stops at the branch's first commit and never moves a published branch, so this is how a tree that already has work gets a name${namedLine ? ` · ${esc(namedLine)}` : ""}">\u2726</button>`;
  // ＋ cuts a CHILD worktree off this row's own branch (POST /api/worktree/child). It sits to the left of the ⟳
  // deliberately: the three controls read as one sentence down the row — make another tree from this branch, re-read
  // this one, remove this one. A row with no branch (a detached HEAD) has nothing to cut from, and the project's own
  // checkout is not a worktree, so neither draws it. The glyph is the ASCII plus on purpose: the mono stack this cell
  // is set in has no ⑂/⤷ on Windows, and a control that renders as nothing is worse than a plain one.
  const childBtn = isProjectRoot || !row.branch
    ? ""
    : `<button class="btn-child-tree" data-child-tree="${esc(keyOf(row.project, row.path))}" data-child-project="${esc(row.project)}" data-child-path="${esc(row.path)}" data-child-branch="${esc(row.branch)}" type="button" title="cut a child worktree off ${esc(row.branch)} — a new tree on a new branch cut from this one, on its own row below; nothing is started in it and nothing is pushed, and it is what the child's UNMERGED chip rolls back into ${esc(row.branch)}">+</button>`;
  // One ✕ per row, and whether it needs the question at all: merged + clean deletes straight away.
  const delKey = keyOf(row.project, row.path);
  const delDirect = !isProjectRoot && deletableWithoutAsking(delKey);
  const lock = row.lock || null;
  const lockKeyAttr = esc(keyOf(row.project, row.path));
  // The reader's lock, as an emoji on the row itself (lib/locks.js). TWO toggles, because the two scopes are a real
  // difference: the padlock beside the name is THIS worktree, the one in the branch cell is the BRANCH — and the
  // branch one keeps protecting trees cut from it later, which is the whole point of locking a turnover branch. Each
  // shows its own bit truthfully, so a tree protected only by its branch reads 🔓 beside the name and 🔒 beside the
  // branch, and neither can be mistaken for the other. A locked row also carries `is-locked` on the <tr>, so the
  // state is visible without reading a tooltip.
  const treeLocked = Boolean(lock?.tree);
  // The branch's NAME lives in `lock.branch`; the boolean lives in `lock.branchLocked`. Reading the name as a truthy
  // lock made every row with a branch draw as a locked branch.
  const branchLockedByBranch = Boolean(lock?.branchLocked);
  const lockTitle = treeLocked
    ? `${lock.line || "🔒 this worktree is locked"} — click to unlock it. Nothing may delete it while it is locked.`
    : branchLockedByBranch
      ? `this worktree is not locked itself, but ${lock.branch ? `branch ${lock.branch}` : "its branch"} is (see the 🔒 in the branch cell) — click to lock this worktree as well`
      : "lock this worktree — a locked worktree can never be deleted: not by this row's ✕, not by a merge agent, not by any route";
  const treeLockBtn = `<button class="btn-row-lock${treeLocked ? " is-locked" : ""}" type="button" data-lock-scope="tree" data-lock-tree="${lockKeyAttr}"
    title="${esc(lockTitle)}" aria-pressed="${treeLocked ? "true" : "false"}" aria-label="lock this worktree">${treeLocked ? "\u{1F512}" : "\u{1F513}"}</button>`;
  const branchLockTitle = branchLockedByBranch
    ? `${lock.line || "🔒 this branch is locked"} — click to unlock it. Every worktree on ${lock.branch || "this branch"}, now and later, is protected while it is locked.`
    : "lock this BRANCH — protects this worktree and every worktree created on the branch later (a turnover branch stays protected as trees come and go)";
  const branchLockBtn = isProjectRoot
    ? ""
    : `<button class="btn-row-lock btn-branch-lock${branchLockedByBranch ? " is-locked" : ""}" type="button" data-lock-scope="branch" data-lock-tree="${lockKeyAttr}"
      title="${esc(branchLockTitle)}" aria-pressed="${branchLockedByBranch ? "true" : "false"}" aria-label="lock this branch">${branchLockedByBranch ? "\u{1F512}" : "\u{1F513}"}</button>`;
  // One cell per column, keyed by the column's id (CHART_COLUMNS), so the row and the header cannot disagree about
  // which cell is which: a hidden column is simply not in `cells`, and the row is the shown set in table order. The
  // age cell carries its own <td> (it is painted in place every second), which is why `life` is read, not wrapped.
  const cells = {
    name: `<td class="name"><div class="name-line"><button class="btn-row-agent" data-agent-path="${esc(row.path)}" data-agent-name="${esc(row.name)}" data-agent-project="${esc(row.project)}"
      title="probe every NOT-RUNNING agent in this worktree — sends 'Continue if you can, exit if you are done' to each of them (the + under the agents starts a new one)">\u25b6</button><span class="row-name" title="${esc(row.path)}">${esc(shownName)}</span>${treeLockBtn}${renameBtn}${nameFromWorkBtn}${agentBadgeHtml(row)}</div></td>`,
    branch: `<td class="mono branch">${branchCellHtml(row)}${branchLockBtn}</td>`,
    tip: `<td class="mono dim nowrap">${esc(row.head || "—")}</td>`,
    ahead: `<td class="mono nowrap">${aheadBehindCellHtml(row)}</td>`,
    cherry: `<td class="mono dim nowrap">+${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}</td>`,
    pr: `<td>${pr}</td>`,
    dirty: `<td class="mono nowrap">${dirty}</td>`,
    life: ageCellHtml(row),
    verdict: `<td class="verdict">${badge}</td>`,
    actions: `<td class="row-actions">${isProjectRoot ? "" : `${childBtn}<button class="btn-refresh-tree" data-refresh-tree="${esc(delKey)}" type="button" title="reconcile this one worktree — re-read its git state (dirty, ahead/behind, cherry, verdict, PR), then check its TODO list against what the tree now contains (a proposal, nothing closed) and its description, re-derived only if it has gone stale; every action is journalled under the row">\u27f3</button><button class="btn-del-tree${delDirect ? " is-direct" : ""}" data-del-tree="${esc(delKey)}" title="${delDirect ? "this worktree is merged and clean — deletes it straight away, its files go to the Recycle Bin and git's record is pruned" : "remove this worktree — asks first; its files go to the Recycle Bin and git's record of it is pruned"}">✕</button>`}</td>`,
  };
  return `<tr class="row${isOpen ? " expanded" : ""}${lock ? " is-locked" : ""}" data-key="${esc(keyOf(row.project, row.path))}">
    ${shownColumns().map((i) => cells[CHART_COLUMNS[i].id]).join("\n    ")}
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

// The newest moment anything told us this worktree is alive: what the last scan found, or an event we received
// that belongs to one of its agents. An event is a fresh look at the tree, so it also restarts the ring.
function eventLifeAt(row) {
  return state.eventLife.get(keyOf(row.project, row.path)) || 0;
}

function lifeAtFor(row) {
  return Math.max(eventLifeAt(row), Date.parse(row.lastAliveAt || "") || 0);
}

// ---- the age collapse: which rows a chart is holding back --------------------------------------
// The newest moment this row's WORK moved: its last commit, its last edited file (the server folds both into
// lastEdit, and keeps lastCommit beside it), the last moment the panel saw it alive, and any event we received
// about one of its agents — an event is a fresh look at the tree, which is why noteEventLife counts it as life too.
function rowActivityAt(row) {
  return Math.max(lifeAtFor(row), Date.parse(row.lastEdit || "") || 0, Date.parse(row.lastCommit || "") || 0);
}

// The threshold, as a number of days. 0 (or anything unreadable) means nothing is held back — the same reading the
// server gives the key, so a config.json that says "off" beats a client that thinks it read a number.
function ageHideDays() {
  const n = Number(state.settings?.hideOlderThanDays);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// A row the chart holds back: its last activity is older than the threshold. Deliberately NOT the age of the
// directory — a tree cut months ago that somebody is working in right now measures as active and stays, which is
// the whole point of measuring activity. Four things are never held back: the project's own checkout (the chart is
// of the worktrees CUT from it), a row that is live right now, a row the reader has open (it must not vanish under
// them), and a row with nothing to measure at all — "no evidence" is not "abandoned", and hiding a fresh tree that
// has not committed or saved anything yet would be the worst of the two mistakes.
function rowAgeStale(row) {
  const days = ageHideDays();
  if (!days || !row) return false;
  if (isProjectRootRow(row) || isRowLive(row)) return false;
  if (state.expanded.has(keyOf(row.project, row.path))) return false;
  const at = rowActivityAt(row);
  return Boolean(at) && at < Date.now() - days * 864e5;
}

// ...and the rows the chart is actually not drawing: stale ones, unless the reader asked this project's chart for
// everything.
function rowAgeHidden(row) {
  return rowAgeStale(row) && !state.showOldProjects.has(row?.project);
}

function staleRowCount(project) {
  return [...state.rows.values()].filter((r) => r.project === project && rowAgeStale(r)).length;
}

function ageToggleTitle(project, days, stale, showing) {
  const n = `${stale} worktree${stale === 1 ? "" : "s"}`;
  if (!days) return "every worktree is drawn: no age threshold is set (Settings → Hide stale worktrees)";
  if (showing) {
    return stale
      ? `hold back the ${n} whose last activity is older than ${days} day${days === 1 ? "" : "s"} again`
      : `nothing here is older than ${days} day${days === 1 ? "" : "s"} — this chart is showing every worktree`;
  }
  return stale
    ? `show the ${n} whose last activity is older than ${days} day${days === 1 ? "" : "s"} — this chart is holding them back`
    : `nothing here is older than ${days} day${days === 1 ? "" : "s"} — every worktree is on the chart`;
}

// The chart's arrow: the same little circular chip the console uses to jump back to its newest line, sitting at the
// bottom of the worktree chart, pointing down when it will show you more rows and up once it is showing them. It
// lives in the legend line rather than in the chart box itself because that line is the one box under the chart
// that neither scrolls sideways nor clips its children — the chart does both the moment the card is narrower than
// its columns — so the arrow stays on the chart's bottom edge at every width. It is invisible unless the pointer is
// over the chart (public/style.css), and it is not rendered at all while the threshold is off.
function ageSlotHtml(project) {
  const days = ageHideDays();
  if (!days) return "";
  const showing = state.showOldProjects.has(project);
  const stale = staleRowCount(project);
  // Nothing held back and nothing shown: there is no choice to offer here, so this chart draws no arrow at all.
  if (!showing && !stale) return "";
  return `<button type="button" class="tail-chip wt-age-toggle${showing ? " is-on" : ""}" data-age-toggle="${esc(project)}" aria-pressed="${showing ? "true" : "false"}" title="${esc(ageToggleTitle(project, days, stale, showing))}">${showing ? "\u2191" : "\u2193"}</button>`;
}

// The arrow's own state, in place. The rows are re-rendered by the caller, and this is the button that asked for
// it: keeping the same node means the pointer does not fall off a control that just moved under it.
function paintAgeToggle(project) {
  const btn = document.querySelector(`[data-age-toggle="${CSS.escape(project)}"]`);
  if (!btn) return;
  const days = ageHideDays();
  const showing = state.showOldProjects.has(project);
  btn.classList.toggle("is-on", showing);
  btn.setAttribute("aria-pressed", showing ? "true" : "false");
  btn.textContent = showing ? "\u2191" : "\u2193";
  btn.title = ageToggleTitle(project, days, staleRowCount(project), showing);
}

// The legend is built ONCE, when the section's markup is created - before the first snapshot's rows are in
// `state`, so a stale count taken then is always zero and a button decided then would never appear. The arrow is
// therefore filled into this slot on every rows change instead (refreshChips below calls straight through): the
// chart draws an arrow exactly while it has something held back or is showing everything, and none otherwise.
function refreshAgeToggle(project) {
  const slot = document.querySelector(`[data-age-slot="${CSS.escape(project)}"]`);
  if (!slot) return;
  const want = ageSlotHtml(project);
  if (!want) {
    if (slot.firstElementChild) slot.innerHTML = "";
    return;
  }
  // Same button: keep the node so the pointer does not fall off a control that just moved under it.
  if (!slot.firstElementChild) slot.innerHTML = want;
  else paintAgeToggle(project);
}

// One chart, shown in full or held back again. The choice is this project's alone and it is remembered.
function toggleShowOld(project) {
  if (!project) return;
  if (state.showOldProjects.has(project)) state.showOldProjects.delete(project);
  else state.showOldProjects.add(project);
  saveShowOldProjects();
  refreshAgeToggle(project);
  renderProjectRows(project);
  refreshChips(project);
}

function ringState(row) {
  const now = Date.now();
  const scannedRaw = Date.parse(row.scannedAt || "");
  const fromEvent = eventLifeAt(row);
  // The ring counts toward the NEXT READ. An event we just received says the tree is busy now, so the count starts
  // again from it - which is the "reset the donut" the reader asked for. Where neither is known, leave it unknown.
  const scanned = Number.isFinite(scannedRaw) ? Math.max(scannedRaw, fromEvent) : fromEvent || scannedRaw;
  const configured = Math.max(1, Number(row.pollSeconds || state.settings.worktreeSeconds || 5));
  const observed = state.pollGap.get(keyOf(row.project, row.path)) || 0;
  // Never shorter than the configured cadence, never more than 10x it (a stuck row must not turn
  // into a 10-minute ring that looks frozen).
  const every = Math.max(configured, Math.min(Math.round(observed), configured * 10));
  // Rows are deliberately staggered inside their cadence, so the moment this one is really due is the
  // server's own stamp (`nextReadAt`), not scannedAt plus a cadence: sized from the cadence, a phased
  // row's ring would fill early and then sit full until its turn came round. Fall back to the cadence
  // when a row predates the field.
  const dueRaw = Date.parse(row.nextReadAt || "");
  const due = Number.isFinite(dueRaw) ? dueRaw : Number.isFinite(scanned) ? scanned + every * 1000 : NaN;
  const total = Number.isFinite(due) && Number.isFinite(scanned) ? Math.max(1000, due - scanned) : every * 1000;
  const remain = Number.isFinite(due) ? Math.max(0, due - now) : 0;
  const overdue = Number.isFinite(due) ? Math.max(0, now - due) : 0;
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
  const alive = lifeAtFor(row) || NaN;
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
  // A running panel agent IS life, observed by us, whatever the last scan said - and so is any event we have
  // received about this worktree since.
  const running = panelFor(row)?.running;
  const fromEvent = eventLifeAt(row);
  const alive = running ? st.now : lifeAtFor(row) || NaN;
  const live = Number.isFinite(alive);
  const num = cell.querySelector(".age-num");
  if (num) {
    num.textContent = live ? fmtDur(st.now - alive) : "never live";
    num.classList.toggle("dimmer", !live);
  }
  const cadence = st.every === st.configured ? `every ${st.every}s` : `every ${st.every}s, observed (configured ${st.configured}s)`;
  const why = running
    ? " (a panel agent is running here now)"
    : fromEvent && fromEvent >= (Date.parse(row.lastAliveAt || "") || 0)
      ? " (an event we received for this worktree)"
      : "";
  const title =
    `last life ${live ? `${fmtDur(st.now - alive)} ago${why}` : "never seen"} · polled ${relTime(row.scannedAt)} ago · ` +
    `next read ${st.remain > 0 ? `in ${Math.ceil(st.remain / 1000)}s` : `due now${st.overdue > st.total ? ` (overdue ${fmtDur(st.overdue)})` : ""}`} (${cadence})`;
  if (cell.title !== title) cell.title = title;
}

// The worktree row an agent's thread belongs to, if it has one: the owner path on its newest turn. An agent with no
// owner sits in the unattached panel, so there is no row on the board to light up for it.
// Cached per render generation: this is asked once per streamed line, and a turn emits hundreds of them. The cache
// dies with the rest of the panel maps, which is whenever a row or an owner changes.
function rowKeyForThread(thread) {
  if (!thread) return null;
  if (!threadRowKeyCache) threadRowKeyCache = new Map();
  if (threadRowKeyCache.has(thread)) return threadRowKeyCache.get(thread);
  const conv = conversations().find((c) => c.thread === thread);
  const owner = conv?.latest?.ownerPath || conv?.first?.ownerPath || "";
  let key = null;
  if (owner) {
    const p = normPath(owner).toLowerCase();
    for (const [k, row] of state.rows) {
      if (normPath(row.path).toLowerCase() === p) {
        key = k;
        break;
      }
    }
  }
  threadRowKeyCache.set(thread, key);
  return key;
}

// The green pulse a row gets when the scanner finds life - reused here, so an event and a scan say the same thing.
function pulseRow(key) {
  const tr = document.querySelector(`#projects tr.row[data-key="${CSS.escape(key)}"]`);
  if (!tr) return;
  tr.classList.remove("flash", "flash-idle");
  void tr.offsetWidth; // restart the animation rather than let one already running expire under the new class
  tr.classList.add("flash");
  clearTimeout(tr._flashT);
  tr._flashT = setTimeout(() => tr.classList.remove("flash"), flashRowMs() + 40);
}

function pulseProject(project) {
  if (!project) return;
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(project)}"]`);
  // Only a collapsed project: an open one shows its rows, and they are the ones that flash when something happens.
  if (!sec || !sec.classList.contains("collapsed")) return;
  sec.classList.remove("flash");
  void sec.offsetWidth;
  sec.classList.add("flash");
  clearTimeout(sec._flashT);
  sec._flashT = setTimeout(() => sec.classList.remove("flash"), flashProjectMs() + 40);
}

// ---- the sliding average every liveness ranking is built on -----------------------------------
// A row's "life" used to be the moment of its LAST event, which is a maximum: one console line promoted the row to
// the top and the next line demoted it. The same shape drove the projects in a folder (newest activity wins) and
// the agent cards inside a worktree (newest turn first). All of them now average over a sliding window instead -
// the events in the last RANK_WINDOW seconds, as a rate per minute - so something being hammered sits high, a
// single line moves nothing, and a thing that goes quiet slides down as its events age out.
//
// ONE engine serves all of them. `pushEventLife(windowKey, at)` records an event against a namespaced key
// ("row:...", "proj:...", "agent:..."), `rankScore` turns that window into events per minute, and
// `tickRankedOrder` advances one scope's order by ONE adjacent swap per reorder tick, with hysteresis. It is
// bounded: every ring is capped at RANK_EVENT_CAP and pruned by the window, so a long session cannot grow it.

function lifeRowKey(rowKey) {
  return `row:${rowKey}`;
}
function lifeProjKey(project) {
  return `proj:${project}`;
}
function lifeAgentKey(thread) {
  return `agent:${thread}`;
}

function rankWindowMs() {
  const n = Number(state.rankWindowSeconds);
  return (Number.isFinite(n) && n > 0 ? n : RANK_WINDOW_DEFAULT) * 1000;
}

// One liveness event against a window key. Events arrive in time order, so the ring stays sorted and the prune is
// a splice off the front (amortised O(1) per event); the cap bounds it even under a flood.
function pushEventLife(windowKey, at) {
  if (!windowKey) return;
  const t = Number(at);
  if (!Number.isFinite(t)) return;
  let arr = state.eventWindows.get(windowKey);
  if (!arr) {
    arr = [];
    state.eventWindows.set(windowKey, arr);
  }
  arr.push(t);
  const cutoff = t - rankWindowMs();
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  if (i) arr.splice(0, i);
  if (arr.length > RANK_EVENT_CAP) arr.splice(0, arr.length - RANK_EVENT_CAP);
}

// How many of the window's events are still inside it. The ring is sorted, so this is a scan of at most
// RANK_EVENT_CAP entries - read-only, so it is safe to call from a comparator.
function rankWindowCount(windowKey, now) {
  const arr = state.eventWindows.get(windowKey);
  if (!arr || !arr.length) return 0;
  const cutoff = now - rankWindowMs();
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  return arr.length - i;
}

// The smoothed score: events per minute across the window. One console line in the default 300 s window is
// 0.2/min; a burst of twenty in ten seconds is 4/min.
function rankScore(windowKey, now) {
  return rankWindowCount(windowKey, now) / (rankWindowMs() / 60000);
}

// Drop everything that has aged out of the window, and the windows and orders of things that are gone, so a long
// session does not grow with time or with the fleet.
function pruneRankWindows(now) {
  const cutoff = now - rankWindowMs();
  const liveProjects = new Set();
  for (const r of state.rows.values()) liveProjects.add(r.project);
  for (const [key, arr] of [...state.eventWindows]) {
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;
    if (i) arr.splice(0, i);
    if (!arr.length) state.eventWindows.delete(key);
  }
  for (const key of [...state.rankSeeded]) if (!state.rows.has(key)) state.rankSeeded.delete(key);
  for (const name of [...state.rankProjSeeded]) if (!state.projects.has(name)) state.rankProjSeeded.delete(name);
  for (const scope of [...state.rankOrder.keys()]) {
    const gone = scope.startsWith("rows:")
      ? !liveProjects.has(scope.slice(5))
      : scope.startsWith("agents:")
        ? !state.rows.has(scope.slice(7))
        : scope === "projects"
          ? !state.projects.size
          : scope === "folders"
            ? !$("projects")
            : true;
    if (gone) state.rankOrder.delete(scope);
  }
}

// ---- one ranked sequence, advanced a tick at a time ---------------------------------------------
// `ids` are a scope's members (row keys, project names, thread names). `ctx` answers, per id: its `tier` (a
// primary key that applies at once), its `score` (the smoothed rate over its own window), its `recency` evidence
// and a `path` for the final tie-break. The stored order lives in state.rankOrder under `scope`.

function rankIdealOrder(ids, ctx) {
  return [...ids].sort(
    (x, y) =>
      ctx.tier(x) - ctx.tier(y) ||
      ctx.score(y) - ctx.score(x) ||
      ctx.recency(y) - ctx.recency(x) ||
      String(ctx.path(x)).localeCompare(String(ctx.path(y))),
  );
}

function tickRankedOrder(scope, ids, ctx) {
  const set = new Set(ids);
  if (!set.size) {
    state.rankOrder.delete(scope);
    return [];
  }
  const prev = (state.rankOrder.get(scope) || []).filter((k) => set.has(k));
  if (!prev.length) {
    const order = rankIdealOrder([...set], ctx);
    state.rankOrder.set(scope, order);
    return order;
  }
  const order = prev.slice();
  // A member that has just appeared gets a slot at the end; the pass below lets it climb as it proves itself.
  for (const id of set) if (!order.includes(id)) order.push(id);
  const beats = (down, up) => {
    const td = ctx.tier(down);
    const tu = ctx.tier(up);
    if (td !== tu) return td < tu;
    const sd = ctx.score(down);
    const su = ctx.score(up);
    if (sd > su + RANK_MARGIN_PER_MIN) return true;
    if (su > sd + RANK_MARGIN_PER_MIN) return false;
    // Within the margin of each other: the existing recency evidence decides, then the path.
    const rd = ctx.recency(down);
    const ru = ctx.recency(up);
    if (rd !== ru) return rd > ru;
    return String(ctx.path(down)).localeCompare(String(ctx.path(up))) < 0;
  };
  // ONE pass of adjacent swaps in which each member moves at most one slot, so a burst climbs a place a tick and a
  // burst that stops slides a place a tick, instead of either leaping.
  const moved = new Set();
  for (let i = 0; i < order.length - 1; i++) {
    const up = order[i];
    const down = order[i + 1];
    if (moved.has(up) || moved.has(down)) continue;
    if (beats(down, up)) {
      order[i] = down;
      order[i + 1] = up;
      moved.add(up);
      moved.add(down);
    }
  }
  state.rankOrder.set(scope, order);
  return order;
}

// The ids in the stored order, with tiers still applied at once (a running agent must not wait for a tick) and
// anything the tick has not seen yet falling to the ideal comparison. With no tick yet - a first paint - the
// seeded ideal order IS the order, which is what makes a reload come back smoothed rather than scrambled.
function orderedByRank(scope, ids, ctx) {
  if (ids.length < 2) return ids;
  if (!state.rankOrder.has(scope)) tickRankedOrder(scope, ids, ctx);
  const order = state.rankOrder.get(scope) || [];
  const pos = new Map(order.map((k, i) => [k, i]));
  return [...ids].sort((a, b) => {
    const ta = ctx.tier(a);
    const tb = ctx.tier(b);
    if (ta !== tb) return ta - tb;
    const pa = pos.has(a) ? pos.get(a) : order.length;
    const pb = pos.has(b) ? pos.get(b) : order.length;
    if (pa !== pb) return pa - pb;
    return ctx.score(b) - ctx.score(a) || ctx.recency(b) - ctx.recency(a) || String(ctx.path(a)).localeCompare(String(ctx.path(b)));
  });
}

// ---- the contexts: what each scope ranks on ------------------------------------------------------
// Rows inside a project: our own running agents first (rowTier, untouched), then the row's own window, then the
// existing recency evidence (lastAliveAt, which an event does NOT move), then the path.
function rowRankCtx(now) {
  const rowOf = (key) => state.rows.get(key);
  return {
    tier: (key) => { const r = rowOf(key); return r ? rowTier(r) : 2; },
    score: (key) => rankScore(lifeRowKey(key), now),
    recency: (key) => { const r = rowOf(key); return r ? lifeAt(r) : Number.NEGATIVE_INFINITY; },
    path: (key) => { const r = rowOf(key); return r ? r.path : key; },
  };
}

// Projects in a folder: the existing tier (a project an agent is busy in leads), then the project's own window,
// then its newest activity, then the name.
function projectRankCtx(rank, now) {
  const at = (name) => rank.get(name) || { tier: 2, activity: 0 };
  return {
    tier: (name) => at(name).tier,
    score: (name) => rankScore(lifeProjKey(name), now),
    recency: (name) => at(name).activity,
    path: (name) => String(name),
  };
}

// A folder ranks on its busiest project: the best tier, the best rate, the newest activity.
function folderRankCtx(byRoot, rank, now) {
  const cache = new Map();
  const info = (root) => {
    if (cache.has(root)) return cache.get(root);
    let tier = 2;
    let score = 0;
    let recency = 0;
    for (const name of byRoot.get(root) || []) {
      const r = rank.get(name) || { tier: 2, activity: 0 };
      tier = Math.min(tier, r.tier);
      recency = Math.max(recency, r.activity);
      score = Math.max(score, rankScore(lifeProjKey(name), now));
    }
    const v = { tier, score, recency };
    cache.set(root, v);
    return v;
  };
  return {
    tier: (root) => info(root).tier,
    score: (root) => info(root).score,
    recency: (root) => info(root).recency,
    path: (root) => String(root),
  };
}

// Agent cards inside one worktree: no tier (a card is not a worktree), the thread's own window, then its newest
// turn start, then the thread id so the order is total.
function agentRankCtx(row, now) {
  const byThread = new Map(agentsFor(row).map((c) => [c.thread, c]));
  const started = (t) => {
    const c = byThread.get(t);
    return c ? Number(Date.parse(c.latest?.startedAt || "")) || 0 : 0;
  };
  return {
    tier: () => 0,
    score: (t) => rankScore(lifeAgentKey(t), now),
    recency: (t) => started(t),
    path: (t) => String(t),
  };
}

// ---- seeding: the first paint is the smoothed order, not a fresh-start scramble -------------------
// Seed one row's windows from the life it ALREADY carries - its own lastAliveAt / lastEdit / lastCommit and the
// start or end of any of its jobs' turns - into the row's window, its project's window, and each job's own agent
// window. Seeded once per row key.
function seedRankWindows(row) {
  if (!row) return;
  const key = keyOf(row.project, row.path);
  if (state.rankSeeded.has(key)) return;
  state.rankSeeded.add(key);
  const now = Date.now();
  const cutoff = now - rankWindowMs();
  const stamps = [];
  const perAgent = new Map();
  const add = (v) => {
    const t = Date.parse(v || "");
    if (Number.isFinite(t) && t > cutoff && t <= now) stamps.push(t);
  };
  add(row.lastAliveAt);
  add(row.lastEdit);
  add(row.lastCommit);
  const path = normPath(row.path).toLowerCase();
  for (const j of state.jobs.values()) {
    if (normPath(j.ownerPath || "").toLowerCase() !== path) continue;
    add(j.startedAt);
    add(j.endedAt);
    const thread = j.thread || j.id;
    if (!thread) continue;
    const arr = perAgent.get(thread) || [];
    for (const v of [j.startedAt, j.endedAt]) {
      const t = Date.parse(v || "");
      if (Number.isFinite(t) && t > cutoff && t <= now) arr.push(t);
    }
    if (arr.length) perAgent.set(thread, arr);
  }
  stamps.sort((a, b) => a - b);
  for (const t of stamps) {
    pushEventLife(lifeRowKey(key), t);
    pushEventLife(lifeProjKey(row.project), t);
  }
  for (const [thread, arr] of perAgent) {
    arr.sort((a, b) => a - b);
    for (const t of arr) pushEventLife(lifeAgentKey(thread), t);
  }
}

// A project's own activity is life for its window too, once.
function seedProjectRank(project) {
  if (!project || !project.name || state.rankProjSeeded.has(project.name)) return;
  state.rankProjSeeded.add(project.name);
  const t = Date.parse(project.activityAt || "");
  const now = Date.now();
  if (Number.isFinite(t) && t > now - rankWindowMs() && t <= now) pushEventLife(lifeProjKey(project.name), t);
}

// ---- the ticks: the order moves here and nowhere else --------------------------------------------
function tickRowScope(project, now = Date.now()) {
  const ids = [...state.rows.values()].filter((r) => r.project === project).map((r) => keyOf(r.project, r.path));
  return tickRankedOrder(`rows:${project}`, ids, rowRankCtx(now));
}

function tickAgentScopes(project, now = Date.now()) {
  for (const row of state.rows.values()) {
    if (row.project !== project) continue;
    const key = keyOf(row.project, row.path);
    const threads = agentsFor(row).map((c) => c.thread);
    // A row with no cards right now keeps whatever order it had: the card list is empty for a moment (a repaint, a
    // resync) far more often than it is really gone, and forgetting the order would make every card climb again
    // from the bottom. The scope dies with its row, in pruneRankWindows.
    if (!threads.length) continue;
    tickRankedOrder(`agents:${key}`, threads, agentRankCtx(row, now));
  }
}

function tickProjectScopes(now = Date.now()) {
  const host = $("projects");
  if (!host) return;
  const ids = [...state.projects.keys()];
  const rank = projectRanks();
  tickRankedOrder("projects", ids, projectRankCtx(rank, now));
  const byRoot = new Map();
  for (const name of ids) {
    const root = rootOf(state.projects.get(name)) || "";
    const arr = byRoot.get(root) || [];
    arr.push(name);
    byRoot.set(root, arr);
  }
  const roots = [...host.querySelectorAll("section.root-group")].map((g) => g.dataset.root).filter(Boolean);
  if (roots.length) tickRankedOrder("folders", roots, folderRankCtx(byRoot, rank, now));
}

// The whole board, on the reorder clock: prune, advance every liveness scope one tick, and re-apply the orders.
// Nothing here runs per event, so a line arriving cannot shuffle anything.
function tickLivenessRanks(now = Date.now()) {
  pruneRankWindows(now);
  const projects = new Set([...state.rows.values()].map((r) => r.project));
  for (const name of projects) {
    tickRowScope(name, now);
    tickAgentScopes(name, now);
    reorder(name);
    reorderAgentCards(name);
  }
  tickProjectScopes(now);
  reorderProjects();
}

// The ranked order for the rows a caller is about to draw or move. Age-hidden rows are ranked too, so a row that
// comes back takes its slot rather than appearing at the bottom.
function applyRowRank(rows) {
  if (!rows.length) return rows;
  const project = rows[0].project;
  const byKey = new Map(rows.map((r) => [keyOf(r.project, r.path), r]));
  const all = [...state.rows.values()].filter((r) => r.project === project).map((r) => keyOf(r.project, r.path));
  const order = orderedByRank(`rows:${project}`, all, rowRankCtx(Date.now()));
  return order.map((k) => byKey.get(k)).filter(Boolean);
}

// Re-apply the agent-card order inside one project's open rows, in place, so a tick moves the cards without
// rebuilding a transcript. Stabilize reordering (with a card open) wins, exactly as it does for rows.
function reorderAgentCards(project) {
  for (const [key, dEl] of state.detailEls) {
    const row = state.rows.get(key);
    if (!row || row.project !== project) continue;
    const block = dEl.querySelector(".agents-block");
    if (!block) continue;
    const cards = [...block.children].filter((el) => el.classList.contains("job") && el.dataset.thread);
    if (cards.length < 2) continue;
    if (stabilizeOn() && rowHasOpenCard(cards.map((c) => c.dataset.thread))) continue;
    const order = orderedByRank(`agents:${key}`, cards.map((c) => c.dataset.thread), agentRankCtx(row, Date.now()));
    const pos = new Map(order.map((t, i) => [t, i]));
    const sorted = [...cards].sort((a, b) => (pos.get(a.dataset.thread) ?? order.length) - (pos.get(b.dataset.thread) ?? order.length));
    if (sorted.every((el, i) => el === cards[i])) continue;
    // Same discipline as reorder() and reorderProjects(): the cards that are already in their slot are never taken
    // out of the page (re-inserting every card before the anchor detached ALL of them, and a detached console comes
    // back at its first line), and the consoles of the ones that do move are read before the move and handed back in
    // this same task. Two live cards in one worktree row are the pair that swap places most, so this is the move a
    // reader sees as "something is switching between my consoles".
    const rest = [...block.children].filter((el) => !(el.classList.contains("job") && el.dataset.thread));
    const held = holdScrolls(block);
    beginDomMove();
    placeInOrder(block, [...sorted, ...rest]);
    endDomMove();
    releaseScrolls(held);
  }
}

// An event about a worktree is a sign of life in its own right: the age number starts again, the ring (which counts
// toward the next read) restarts from now, and the row and its project take the green pulse - unless the reader has
// switched that pulse off. Returns true when the event belonged to a row, so a caller can tell the difference.
function noteEventLife(thread) {
  const now = Date.now();
  // Every event is life for THREE windows: the agent card itself, the worktree row that owns it, and that row's
  // project. An unattached agent still has its own card, so it still ranks - it just has no row to light up.
  pushEventLife(lifeAgentKey(thread), now);
  const key = rowKeyForThread(thread);
  if (!key) return false;
  if (now > (state.eventLife.get(key) || 0)) state.eventLife.set(key, now);
  const row = state.rows.get(key);
  // ...and the row's and project's windows, which is what those two RANKINGS average. The orders themselves are
  // recomputed on the reorder clock (tickLivenessRanks), never here: an event still stamps life, pulses the row
  // and repaints the age cell exactly as it did before.
  pushEventLife(lifeRowKey(key), now);
  if (row && row.project) pushEventLife(lifeProjKey(row.project), now);
  const cell = document.querySelector(`td.age[data-key="${CSS.escape(key)}"]`);
  if (cell && row) paintAgeCell(cell, row);
  if (state.eventFlash) {
    const last = state.lastEventFlashAt.get(key) || 0;
    if (now - last >= 900) {
      state.lastEventFlashAt.set(key, now);
      pulseRow(key);
      pulseProject(row?.project);
    }
  }
  return true;
}

// Move each live card into the slot the freshly built detail made for it. A card that is not on the board yet is
// built here; one that is keeps its DOM, so its console, its open turns and its scroll position all survive a
// row repaint. Insertion order follows the slots, so the agents stay in the order the row ranks them.
// ---- the reading anchor ------------------------------------------------------------------------
// Order is already held (reorder/pinOpenProjects): nobody jumps over an open row or project. Height is not:
// a console that starts streaming, a thinking block opening, a row arriving - each changes the height above
// whatever the reader is looking at, and the page used to creep out from under them. This holds the viewport:
// the element under the reading line stays under it while things above it grow.

function loadProjectHues() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECT_HUE_KEY) || "{}");
    const map = new Map();
    for (const [name, hue] of Object.entries(raw || {})) {
      const h = Number(hue);
      if (Number.isFinite(h)) map.set(name, ((h % 360) + 360) % 360);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveProjectHues() {
  try {
    localStorage.setItem(PROJECT_HUE_KEY, JSON.stringify(Object.fromEntries(state.projectHues)));
  } catch {
    /* no storage: the colour lasts this tab only */
  }
}

// A random hue that is not the one already there: re-rolling must change what you see.
function rollProjectHue(name) {
  const prev = state.projectHues.get(name);
  let hue = Math.floor(Math.random() * 360);
  if (prev != null && Math.abs(hue - prev) < 45) hue = (hue + 150) % 360;
  state.projectHues.set(name, hue);
  saveProjectHues();
  return hue;
}

// Paint a project box in the hue it was given (or take the colour away). The section is rebuilt on every
// render, and projectSection() carries the class and the variable, so this only has to touch what is on
// screen right now.
function applyProjectHue(name) {
  const hue = state.projectHues.get(name);
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  if (sec) {
    sec.classList.toggle("has-hue", hue != null);
    if (hue != null) sec.style.setProperty("--proj-hue", String(hue));
    else sec.style.removeProperty("--proj-hue");
  }
  const head = sec?.querySelector(".project-head[data-toggle-project]");
  if (head) head.title = headTitle(name);
  updateColorsRow();
}

// The settings row says how many projects carry a colour right now, so "reset" is never a blind button.
function updateColorsRow() {
  const row = document.getElementById("colors-row");
  if (!row) return;
  const n = state.projectHues.size;
  row.title = n
    ? `${n} project${n === 1 ? "" : "s"} carr${n === 1 ? "ies" : "y"} a theme colour (Ctrl+click a project's title row to set one, Ctrl+Shift+click to drop it). Reset clears them all — this browser only.`
    : "No project has a theme colour. Ctrl+click a project's title row to give it one; reset clears every colour at once.";
}

function headTitle(name) {
  const open = state.expandedProjects.has(name);
  return `${open ? "minimize" : "expand"} ${name} — Ctrl+click to colour this project, Ctrl+Shift+click to clear it`;
}

// ANCHOR_THREAD_KEY is declared near the top of the file: loadAnchorThread() runs while `state` is built.

// Two independent signals, each with its own switch and its own window: the pointer (hover) and the hand
// (clicked / focused / typed). `legacyKey` is read once so a preference saved under the older single setting is
// not silently lost when the two were split apart.
function loadAnchorFlag(key, fallback, legacyKey = null) {
  try {
    const v = localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function saveAnchorFlag(key, on) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* no storage: this tab only */
  }
}

function loadAnchorSeconds(key, fallback, min = 1, legacyKey = null, max = 600) {
  try {
    const raw = localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
    const n = Number(raw);
    return Number.isFinite(n) && raw !== null && n >= min && n <= max ? Math.round(n) : fallback;
  } catch {
    return fallback;
  }
}

// The row-ranking window. Saved in this browser like the other Display numbers, and read while `state` is built.
function loadRankSeconds() {
  return loadAnchorSeconds(RANK_WINDOW_KEY, RANK_WINDOW_DEFAULT, RANK_WINDOW_MIN, null, RANK_WINDOW_MAX);
}

function saveAnchorSeconds(key, seconds) {
  try {
    localStorage.setItem(key, String(seconds));
  } catch {
    /* no storage: this tab only */
  }
}

function loadAnchorThread() {
  try {
    return localStorage.getItem(ANCHOR_THREAD_KEY) || null;
  } catch {
    return null;
  }
}

function saveAnchorThread(thread) {
  try {
    if (thread) localStorage.setItem(ANCHOR_THREAD_KEY, thread);
    else localStorage.removeItem(ANCHOR_THREAD_KEY);
  } catch {
    /* no storage: the pin lasts this tab only */
  }
}

function setAnchorThread(thread) {
  state.anchorThread = thread ? String(thread) : null;
  saveAnchorThread(state.anchorThread);
  for (const b of document.querySelectorAll("[data-pin-thread]")) {
    const on = b.dataset.pinThread === state.anchorThread;
    b.classList.toggle("is-on", on);
    b.title = on
      ? "this card holds its place while anything above it grows — click to release"
      : "pin this card: hold its place on screen while other cards above it grow (one pin at a time)";
  }
  refreshAnchorBaseline();
}

function toggleAnchorPin(thread) {
  setAnchorThread(state.anchorThread === thread ? null : thread);
}

function readingTop() {
  const bar = document.querySelector(".topbar");
  return bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
}

// The element the reading line sits on: a card straddling it first, then the first one below it.
function nearestReadingLine(nodes, top) {
  let best = null;
  let bestScore = Infinity;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.height < 8) continue;
    if (r.bottom < top - 40 || r.top > window.innerHeight) continue;
    const score = r.top <= top && r.bottom > top ? top - r.top : 400 + Math.abs(r.top - top);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

// A card only counts as the reader's intent while it is actually on screen: an anchor that has scrolled away
// cannot hold anything, and following it would drag the page back.
function anchorVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.height > 8 && r.bottom > readingTop() && r.top < window.innerHeight;
}

function anchorCardFor(thread) {
  if (!thread) return null;
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  return anchorVisible(card) ? card : null;
}

// Where the reader's attention is, beyond the geometry of the reading line:
//   * the card under the pointer, while the pointer is actually moving over it (a mouse parked on a card from
//     two minutes ago says nothing about what is being read now),
//   * the card last interacted with - clicked, focused, typed in - for a couple of minutes, which is the
//     "last panel I touched is where I am thinking" case.
function loadFlashSeconds() {
  try {
    const raw = localStorage.getItem(FLASH_TIME_KEY);
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : FLASH_TIME_DEFAULT;
  } catch {
    return FLASH_TIME_DEFAULT;
  }
}

function saveFlashSeconds(seconds) {
  try {
    localStorage.setItem(FLASH_TIME_KEY, String(seconds));
  } catch {
    /* no storage: this tab only */
  }
}

// The three durations the flashes use, all scaled from the one setting (0.9s row : 1.1s project : 1.7s ring).
const FLASH_BASE_SECONDS = 0.9;
function flashScale() {
  return Math.max(0, state.flashSeconds) / FLASH_BASE_SECONDS;
}
function flashRowMs() {
  return Math.round(900 * flashScale());
}
function flashProjectMs() {
  return Math.round(1100 * flashScale());
}
function flashRingMs() {
  return Math.round(1700 * flashScale());
}

// CSS owns the animation, so the durations are handed over as variables; the class-removal timeouts below
// use the same numbers, so a flash cannot keep a class after it has finished fading.
function applyFlashTime() {
  const root = document.documentElement;
  root.style.setProperty("--flash-row", `${flashRowMs()}ms`);
  root.style.setProperty("--flash-project", `${flashProjectMs()}ms`);
  root.style.setProperty("--flash-ring", `${flashRingMs()}ms`);
}

function anchorHoverMs() {
  return state.anchorHoverSeconds * 1000;
}

function anchorTouchMs() {
  return state.anchorTouchSeconds * 1000;
}

// The element a target names, looked up fresh every time. A rebuild replaces the project header, the row and
// the worktree's tbody, so holding "that thing" has to be a lookup, not a stored node: the node the click landed
// on is gone by the time the observer measures the layout.
function anchorNodeFor(target) {
  if (!target) return null;
  // A plain element was claimed by the click itself (a button, a chip, a line of text). There is no stable name to
  // look it up by, so the node is the anchor: valid while it stays in the document, dropped when a rebuild
  // replaces it.
  if (target.kind === "el") return target.el && target.el.isConnected ? target.el : null;
  if (!target.id) return null;
  if (target.kind === "card") return document.querySelector(`.job[data-thread="${CSS.escape(target.id)}"]`);
  // A project is held by its section, not just the head: the section is what grows, and its top is the bar.
  if (target.kind === "project") return document.querySelector(`section.project[data-project="${CSS.escape(target.id)}"]`);
  if (target.kind === "fixed") return document.getElementById(target.id);
  if (target.kind === "turn") return document.querySelector(`[data-turn-head="${CSS.escape(target.id)}"]`);
  if (target.kind === "row") return document.querySelector(`#projects tr.row[data-key="${CSS.escape(target.id)}"]`);
  if (target.kind === "root") return document.querySelector(`.root-head[data-toggle-root="${CSS.escape(target.id)}"]`);
  return null;
}

// Which board element an event landed on. A card beats the row and the project containing it: the agent is the
// specific thing, the accordions around it are scenery unless their own header was hit.
function boardTargetOf(el) {
  if (!el || !el.closest) return null;
  const card = el.closest(".job[data-thread]");
  if (card) return { kind: "card", id: card.dataset.thread };
  const phead = el.closest(".project-head[data-toggle-project]");
  if (phead) return { kind: "project", id: phead.dataset.toggleProject };
  const fhead = el.closest("[data-toggle-fixed]");
  if (fhead) return { kind: "fixed", id: fhead.dataset.toggleFixed };
  const turn = el.closest("[data-turn-head]");
  if (turn) return { kind: "turn", id: turn.dataset.turnHead };
  const row = el.closest("#projects tr.row[data-key]");
  if (row) return { kind: "row", id: row.dataset.key };
  const rhead = el.closest(".root-head[data-toggle-root]");
  if (rhead) return { kind: "root", id: rhead.dataset.toggleRoot };
  // Anything else the click landed on: a button, a chip, a badge, a paragraph. The element itself is the anchor.
  // The page background and the scroll containers are not - there is nothing there to hold, and claiming them
  // would fight the reader's own scroll.
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) return null;
  if (el.closest("#settings, .settings")) return { kind: "el", el };
  if (el.closest("main") && el.tagName !== "MAIN" && el.tagName !== "BODY") return { kind: "el", el };
  if (el.closest(".topbar")) return { kind: "el", el };
  return null;
}

function sameAnchorTarget(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "el") return a.el === b.el;
  return a.id === b.id;
}

// A project was claimed by its bar, so its bar is what has to still be on screen: the section it belongs to can be
// taller than the window, and once the bar has scrolled away the reader is somewhere else inside the project -
// the card at the reading line is then the better anchor.
function projectBarVisible(section) {
  const bar = section?.querySelector?.(".project-head[data-toggle-project], .project-head[data-toggle-fixed]");
  return bar ? anchorVisible(bar) : false;
}

function intentAnchorNode() {
  const now = Date.now();
  if (state.anchorHover && state.hoverThread && now - state.hoverAt < anchorHoverMs()) {
    const hovered = anchorCardFor(state.hoverThread);
    if (hovered) return { el: hovered, target: { kind: "card", id: state.hoverThread } };
  }
  if (state.anchorTouch && state.touchTarget && now - state.touchAt < anchorTouchMs()) {
    const el = anchorNodeFor(state.touchTarget);
    const kind = state.touchTarget.kind;
    // A whole project or a whole fixed card is held by its bar: once that bar has scrolled away the reader is
    // somewhere else in it, and the card at the reading line is the better answer. A plain element is only an
    // answer while it is still on screen.
    const head = kind === "project" || kind === "fixed" ? projectBarVisible(el) : true;
    if (anchorVisible(el) && head) return { el, target: state.touchTarget };
  }
  return null;
}

// pinned card > card under the pointer / last touched thing > card at the reading line > open row at it >
// project section at it > nothing. Every answer carries a target descriptor so it can be re-found after a
// rebuild.
function readingAnchor() {
  if (state.anchorThread) {
    const pinned = document.querySelector(`.job[data-thread="${CSS.escape(state.anchorThread)}"]`);
    if (pinned) return { el: pinned, pinned: true, target: { kind: "card", id: state.anchorThread } };
  }
  const intent = intentAnchorNode();
  if (intent) return { el: intent.el, pinned: false, intent: true, target: intent.target };
  const top = readingTop();
  const card = nearestReadingLine(document.querySelectorAll(".job[data-thread]"), top);
  if (card) return { el: card, pinned: false, target: { kind: "card", id: card.dataset.thread } };
  const row = nearestReadingLine(document.querySelectorAll("#projects tr.row.expanded"), top);
  if (row) return { el: row, pinned: false, target: { kind: "row", id: row.dataset.key } };
  const sec = nearestReadingLine(document.querySelectorAll("#projects section.project"), top);
  return sec ? { el: sec, pinned: false, target: { kind: "project", id: sec.dataset.project } } : null;
}

let anchorState = null;       // { el, target, top, height, pinned }
let anchorScrollY = 0;        // page scrollY at the moment the baseline was measured
let lastAnchorScrollAt = 0;   // our own scrollBy, so it is not read as the reader moving
let anchorRepickTimer = 0;
// Set while a click's own hand-keeps-the-bar-still pass (keepInPlace) is running. Both it and the observer
// answer the same layout change, and two answers measured a frame apart scroll the page one way and then the
// other: the page visibly twitches and the clicked bar can end up anywhere. One owner at a time.
let anchorMuteUntil = 0;

function refreshAnchorBaseline() {
  const a = readingAnchor();
  if (!a) {
    anchorState = null;
    return;
  }
  const r = a.el.getBoundingClientRect();
  anchorState = { el: a.el, target: a.target || null, top: Math.round(r.top), height: Math.round(r.height), pinned: a.pinned };
  anchorScrollY = Math.round(window.scrollY);
}

// The correction lands in the frame the growth did. A ResizeObserver's callback runs after layout and BEFORE that
// frame is painted, so compensating here means the reader's element is never drawn displaced; deferring the same
// correction to requestAnimationFrame painted exactly one frame with the anchor moved and then put it back, which
// reads as a twitch. Measured on a parked card with three turns streaming above it: its top jumped 17-52 px for a
// single frame 37 times in 45 s and came straight back, while the page scrolled 26 times to undo it. `anchorBusy`
// keeps compensateAnchor out of itself (a scroll it performs must not start a second correction).
let anchorBusy = false;

function scheduleAnchorCompensation() {
  if (anchorBusy) return;
  anchorBusy = true;
  try {
    compensateAnchor();
  } finally {
    anchorBusy = false;
  }
}

function compensateAnchor() {
  // A spawn/jump follow owns the scroll until it is done: compensating against the position the reader
  // held before the jump would drag them straight back off the card the panel just landed on.
  if (state.pendingFocus) {
    refreshAnchorBaseline();
    return;
  }
  if (!anchorState) return;
  if (Date.now() < anchorMuteUntil) return;
  if (!anchorState.el.isConnected) {
    // The node was replaced (a snapshot rebuilt this project). Find the same thing again and keep the baseline
    // measured before the change: re-picking here would compare the new layout with itself and let the page
    // move under the reader.
    const again = anchorNodeFor(anchorState.target);
    if (again) anchorState.el = again;
    else {
      refreshAnchorBaseline();
      return;
    }
  }
  const r = anchorState.el.getBoundingClientRect();
  const delta = Math.round(r.top) - anchorState.top;
  // A correction bigger than most of the screen is not growth - it is a baseline measured before the reader
  // moved (or before the board was as tall as it is). Re-measure and leave the page alone: a stale baseline
  // once threw this page 14,000px on a single keystroke.
  if (Math.abs(delta) > window.innerHeight * 0.75) {
    refreshAnchorBaseline();
    return;
  }
  const grewSelf = Math.abs(r.height - anchorState.height) > 1;
  // Something above the anchor changed the layout: put the anchor back where the reader had it. Growth
  // inside the anchor itself is the reader watching it expand - never compensated.
  if (!grewSelf && Math.abs(delta) > 1 && window.scrollY > 0) {
    lastAnchorScrollAt = Date.now();
    programmaticScroll();
    window.scrollBy(0, delta);
  }
  const after = anchorState.el.getBoundingClientRect();
  anchorState.top = Math.round(after.top);
  anchorState.height = Math.round(after.height);
}

let anchorObserver = null;

// Pointer + interaction tracking for the anchor. pointermove's own target is the element under the cursor, so
// this costs one closest() per move and nothing when the cursor stays still.
function trackAnchorIntent() {
  const noteHover = (target) => {
    const thread = target && target.kind === "card" ? target.id : null;
    if (thread === state.hoverThread) return;
    state.hoverThread = thread;
    state.hoverAt = thread ? Date.now() : 0;
    refreshAnchorBaseline();
  };
  const noteTouch = (target) => {
    // A click claims what it landed on, at once: the baseline is measured here, before the click handler grows
    // anything, so the observer holds THIS element rather than whatever happened to sit at the reading line. A
    // click on nothing (the page background) clears the claim and leaves the geometry in charge.
    state.touchTarget = target;
    state.touchAt = target ? Date.now() : 0;
    refreshAnchorBaseline();
  };
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return; // a touch is an interaction, not a hover
      // A moving pointer only claims cards: it crosses project headers and rows on its way somewhere else.
      noteHover(boardTargetOf(e.target));
    },
    { passive: true },
  );
  const touched = (e) => noteTouch(boardTargetOf(e.target));
  document.addEventListener("pointerdown", touched, { passive: true, capture: true });
  document.addEventListener("focusin", touched, { passive: true, capture: true });
  document.addEventListener("keydown", touched, { passive: true, capture: true });
  document.addEventListener("input", touched, { passive: true, capture: true });
}

function startAnchorObserver() {
  if (anchorObserver || typeof ResizeObserver !== "function") return;
  anchorObserver = new ResizeObserver(() => scheduleAnchorCompensation());
  // `main` is the whole scrollable board: the project list, the agent list, the two fixed cards above them and the
  // approvals dock. Native scroll anchoring is switched off (see style.css), so this observer is the only thing
  // that puts the reader's element back - it has to see every container that can grow, not just the two lists.
  const watched = ["main", "projects", "jobs", "newagent", "agents", "approvals"];
  for (const id of watched) {
    const el = document.getElementById(id);
    if (el) anchorObserver.observe(el);
  }
  // Every page scroll moves the anchor's viewport position, and the baseline has to move with it or the next
  // resize reads the reader's own scrolling as growth. Our own compensation is excepted: it measures the
  // element again after scrolling. A quiet moment then re-picks which element the reading line sits on.
  document.addEventListener(
    "scroll",
    (e) => {
      const target = e.target;
      const page = !target || target === document || target === document.scrollingElement || target === window;
      if (!page) return;
      const y = Math.round(window.scrollY);
      if (anchorState && Date.now() - lastAnchorScrollAt > 120) anchorState.top += anchorScrollY - y;
      anchorScrollY = y;
      if (Date.now() - lastAnchorScrollAt < 250) return;
      clearTimeout(anchorRepickTimer);
      anchorRepickTimer = setTimeout(refreshAnchorBaseline, 160);
    },
    { passive: true },
  );
  window.addEventListener("resize", () => {
    // A resize reflows the whole board, so every element's viewport position changes at once. Correcting against
    // a baseline measured at the old width would scroll the page to chase a number that no longer means anything:
    // stand down, then re-measure.
    anchorMuteUntil = Date.now() + 250;
    clearTimeout(anchorRepickTimer);
    anchorRepickTimer = setTimeout(refreshAnchorBaseline, 160);
  });
  trackAnchorIntent();
  refreshAnchorBaseline();
}

// ---- board hygiene ----------------------------------------------------------------------------
// A card and the detail block it sits in can outlive the row they belong to. When a row's key changes
// under it - a nested worktree adopted by its own project, a path re-cased by discovery - the old
// tr/detail pair stays in the parent project's tbody, card and all, while the same conversation is
// also rendered in the row that now owns it. A snapshot rebuilds one project at a time, so that pair
// can sit there for a minute and then vanish: the board jumps and the same agent appears twice.
// Every render ends with this sweep, which is the board's own invariant: one row per live key, one
// detail per row, one card per thread - the copy in the owning row wins, the homeless panel is next.
let boardSweepQueued = false;
// The row the reader is looking at, when a rebuild starts. Restored afterwards: a card appearing, a
// duplicate being swept or a re-rank can all change the height above the viewport, and the board used
// to jump out from under the reader when that happened.
let boardAnchor = null;

function captureBoardAnchor() {
  if (window.scrollY <= 0) return null; // at the top of the page: nothing to hold
  const top = readingTop();
  // The same chain the anchor uses - pinned, then the card under the pointer or the thing last clicked, then the
  // card at the reading line, then the row - so a rebuild holds whatever the reader is thinking about, not just
  // what happens to sit under the topbar. Held by target: that survives a rebuild AND a reorder.
  const a = readingAnchor();
  if (a && a.target && a.el.isConnected) {
    const rows = a.target.kind === "row" ? [...document.querySelectorAll("#projects tr.row[data-key]")] : null;
    return {
      target: a.target,
      index: rows ? rows.indexOf(a.el) : -1,
      offset: Math.round(a.el.getBoundingClientRect().top - top),
      y: Math.round(window.scrollY),
    };
  }
  // Rows are only a stand-in for "somewhere in this worktree". Their index is recorded because rows are
  // sorted newest-life-first: a row that gains life is promoted, and following it is exactly the bounce this
  // anchor used to cause - the page chased a promoted worktree up to the top of the board.
  const rows = [...document.querySelectorAll("#projects tr.row[data-key]")];
  const row = rows.find((tr) => tr.getBoundingClientRect().bottom > top + 1);
  if (!row) return null;
  return { target: { kind: "row", id: row.dataset.key }, index: rows.indexOf(row), offset: Math.round(row.getBoundingClientRect().top - top), y: Math.round(window.scrollY) };
}

// Put the held element back where the reader had it, and keep putting it back for the next few frames: a single
// correction measured too early - before the promoted row's detail had been re-placed, before a card had been
// rebuilt - left the reader half-way to wherever the render was going to put them (observed: a card asked to stay
// at 40px ended at -498px). Four frames is enough for the layout to settle and short enough to be invisible.
function holdAnchor(anchor, attempt = 0) {
  if (!anchor) return;
  // The reader scrolled between the capture and this hold: the page is theirs now.
  if (attempt === 0 && anchor.y != null && Math.abs(Math.round(window.scrollY) - anchor.y) > 6) return;
  const top = readingTop();
  let el = anchorNodeFor(anchor.target);
  // Reordered, not resized: leave the page alone. The green flash already says something moved; dragging the
  // reader to wherever the sort sent the row is not a way to tell them.
  if (el && anchor.target.kind === "row" && anchor.index >= 0) {
    const rows = [...document.querySelectorAll("#projects tr.row[data-key]")];
    if (rows.indexOf(el) !== anchor.index) el = null;
  }
  if (!el) return;
  const delta = Math.round(el.getBoundingClientRect().top - top) - anchor.offset;
  if (Math.abs(delta) > 2) {
    anchorMuteUntil = Date.now() + 220; // this hold owns the correction; the observer answers it too otherwise
    programmaticScroll();
    window.scrollBy(0, delta);
    refreshAnchorBaseline();
  }
  if (attempt < 4 && Math.abs(delta) > 2) requestAnimationFrame(() => holdAnchor(anchor, attempt + 1));
}

function scheduleBoardSweep(anchor = null) {
  if (anchor) boardAnchor = anchor;
  if (boardSweepQueued) return;
  boardSweepQueued = true;
  requestAnimationFrame(() => {
    boardSweepQueued = false;
    sweepStaleBoard();
    const held = boardAnchor;
    boardAnchor = null;
    holdAnchor(held);
  });
}

function sweepStaleBoard() {
  // This pass moves details back under their rows, which takes the cards out of the DOM and puts them back.
  const heldSelection = captureCardSelection();
  // A worktree that gains life is re-ranked, and its detail then follows the row - a move, which detaches the cards
  // and blurs whatever the reader was typing in. That was the cursor going missing on a green flash: the flash itself
  // touches no input, but the re-rank under it moved the box. Read the caret before any of it and put it back after.
  const typing = $("projects") ? captureTyping($("projects")) : null;
  // A detail that changes place under its row takes every console inside it out of the layout tree, which puts them
  // all back at their first line. Read the boxes before the FIRST move of this pass (a read after it would read the
  // 0 it left) and hand them back before the pass ends.
  let heldScrolls = null;
  beginDomMove();
  // A detail whose row is gone, or which no longer follows its own row.
  for (const d of [...document.querySelectorAll("tr.detail[data-detail]")]) {
    const key = d.dataset.detail;
    const ownRow = state.rowEls.get(key) || null;
    if (!state.rows.has(key)) {
      d.remove();
      if (state.detailEls.get(key) === d) state.detailEls.delete(key);
      continue;
    }
    // One row, one detail. The registered element wins; any other copy for the same key is a stray from a
    // render whose cache entry had gone stale, and two details under one row is exactly the duplicated
    // MERGE STATE / LIVENESS block the reader saw.
    const registered = state.detailEls.get(key);
    if (registered && registered !== d && registered.isConnected) {
      d.remove();
      continue;
    }
    if (!registered) state.detailEls.set(key, d);
    // The row is still there and the detail still belongs to it - the row just moved (rows sort by newest
    // life, so a worktree that gains life is re-ordered). Moving the detail with its row keeps the open
    // cards on the page; removing it instead dropped the agent card the reader was reading out of the DOM
    // until some later render rebuilt it.
    if (ownRow && d.previousElementSibling !== ownRow) {
      heldScrolls = heldScrolls || holdScrolls($("projects"));
      ownRow.after(d);
    }
  }
  // A row the server no longer lists.
  for (const tr of [...document.querySelectorAll("tr.row[data-key]")]) {
    if (!state.rows.has(tr.dataset.key)) tr.remove();
  }
  // One card per thread.
  const byThread = new Map();
  for (const card of document.querySelectorAll(".job[data-thread]")) {
    const t = card.dataset.thread;
    const list = byThread.get(t) || [];
    list.push(card);
    byThread.set(t, list);
  }
  for (const [thread, cards] of byThread) {
    if (cards.length < 2) continue;
    const conv = conversations().find((c) => c.thread === thread);
    const owner = normPath(conv?.latest?.ownerPath || conv?.first?.ownerPath || "").toLowerCase();
    const rank = (card) => {
      // The floating assistant panel is the assistant thread's only home: it outranks every board copy.
      if (card.closest("#as-chat")) return 5;
      const body = card.closest("tr.detail");
      const key = body?.previousElementSibling?.dataset?.key || "";
      const path = String(key).split("::").slice(1).join("::");
      if (owner && normPath(path).toLowerCase() === owner) return 3;
      if (card.closest("#jobs")) return 1;
      return 2;
    };
    const keep = [...cards].sort((a, b) => rank(b) - rank(a))[0];
    for (const card of cards) {
      if (card === keep) continue;
      const where = card.closest("#jobs")
        ? "the Agents panel"
        : card.closest("tr.detail")?.previousElementSibling?.dataset?.key || "a row";
      console.warn(`panel: dropped a duplicate card for ${thread} (kept the copy in ${keep.closest("#jobs") ? "the Agents panel" : keep.closest("tr.detail")?.previousElementSibling?.dataset?.key || "a row"}, removed ${where})`);
      card.remove();
    }
  }
  endDomMove();
  if (heldScrolls) releaseScrolls(heldScrolls);
  if (typing) restoreTyping($("projects"), typing);
  restoreAddAgent($("projects"));
  restoreCardSelection(heldSelection);
}

function fillAgentSlots(root, reuse) {
  if (!root) return;
  for (const slot of [...root.querySelectorAll("[data-agent-slot]")]) {
    const thread = slot.dataset.agentSlot;
    const card = reuse?.get(thread);
    if (card) {
      slot.replaceWith(card);
      continue;
    }
    const conv = conversations().find((c) => c.thread === thread);
    if (!conv) {
      slot.remove();
      continue;
    }
    const holder = document.createElement("div");
    holder.innerHTML = conversationHtml(conv);
    const fresh = holder.firstElementChild;
    if (fresh) {
      fresh.dataset.sig = conversationSignature(conv);
      slot.replaceWith(fresh);
    } else slot.remove();
  }
}

// One file-list strip inside merge state: a one-line head carrying its count, its names folded away until the
// reader opens it. The fold's own key is the row's key plus the kind, so the two strips of a row (and the merge
// state strip around them) each open and close on their own. Nothing is emitted for an empty list, so a clean
// tree has no strips at all rather than two empty ones.
function gitSubHtml(key, kind, title, count, items) {
  const subKey = `${key}::${kind}`;
  const open = state.gitSubOpen.has(subKey);
  const what = kind === "modified" ? "changed" : "untracked";
  return `<div class="git-sub${open ? "" : " collapsed"}" data-git-sub="${esc(subKey)}">
        <div class="git-sub-head" data-toggle-git-sub="${esc(subKey)}" title="${open ? "fold" : "unfold"} the ${count} ${what} file${count === 1 ? "" : "s"}">
          <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
          <h4>${esc(title)} (${count})</h4>
        </div>
        <ul>${items.join("")}</ul>
      </div>`;
}

// The description as bullets: one per sentence. The split is the SAME boundary lib/descriptions.js used to cut the
// text down to two sentences in the first place (a full stop, question or bang mark, then whitespace and something
// that can start a sentence), so the panel shows the sentences the server recognised rather than re-parsing the prose
// its own way — and text with no sentence punctuation at all (the store's word-boundary fallback) stays one bullet.
const DESC_SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"'([])/;

function descLines(text) {
  const all = String(text ?? "").trim();
  if (!all) return [];
  return all
    .split(DESC_SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- the worktree's TODO list -----------------------------------------------------------------------------------
// The section the reader asked for. FOLDED it reads the OLDEST incomplete item — the lowest id whose status is todo or
// doing — with a done/total count beside it, and deliberately NOT the most recently touched item: finishing out of
// order is the normal case, so "what is the first thing still open" is the only line worth having without opening
// anything. UNFOLDED it lists every item with its status glyph, its owner and its age, and offers the four things a
// reader can do to one — add, edit, complete, drop — plus reopening.
//
// The list itself is the server's (lib/todos.js holds it, keyed on the row, and the assistant and every agent in the
// tree write to it); nothing here derives a status or invents an item.
const TODO_GLYPH = { todo: "\u25a1", doing: "\u25b6", done: "\u2713", dropped: "\u2298" };

// A duration the way the row's other strips say them: seconds under a minute and a half, then minutes, hours, days.
function todoAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// The oldest incomplete item, from the row's own copy. The SAME rule the server applies (lib/todos.js `oldestOpen`),
// restated here because the folded line must not need a round trip — and because the harness can drive it directly.
function todoOldest(todo) {
  let best = null;
  for (const item of todo?.items || []) {
    if (item.status !== "todo" && item.status !== "doing") continue;
    if (!best || Number(item.id) < Number(best.id)) best = item;
  }
  return best;
}

// One item as one line: its id (the number every agent is told to write), its glyph, its words, and who and how long.
function todoLine(item) {
  if (!item) return "";
  const bits = [String(item.status || "todo")];
  if (item.owner) bits.push(String(item.owner));
  const age = todoAge(item.ageMs);
  if (age) bits.push(age);
  return `#${item.id} ${TODO_GLYPH[item.status] || "?"} ${item.text} · ${bits.join(" · ")}`;
}

// The folded line's peek, recomputed from the row's own state — used when the section is folded again in place (the
// head must go back to the OLDEST item still open, not to whatever was drawn last).
function todoPeekFor(key) {
  const todo = state.rows.get(key)?.todo;
  if (!todo) return "";
  const oldest = todoOldest(todo);
  if (oldest) return todoLine(oldest);
  const done = Number(todo.done) || 0;
  const total = Number(todo.total) || 0;
  return `nothing open — ${done}/${total} done${todo.dropped ? `, ${todo.dropped} dropped` : ""}`;
}

// Repaint ONE row's detail, in place, so a draft swap (the reader opening an input) lands without rebuilding the
// project. The node is rebuilt from state, so everything else in the row keeps its own remembered fold.
function repaintTodoBlock(key) {
  const row = state.rows.get(key);
  const detail = state.detailEls.get(key) || document.querySelector(`tr.detail[data-detail="${CSS.escape(key)}"]`);
  if (!row || !detail) return;
  // A <tbody> holder, like every other path that builds a <tr class="detail">. Parsed inside a <div> the `<tr>` start
  // tag is dropped by the HTML parser, so `firstElementChild` came back as the inner `<div class="detail-inner">` and
  // `replaceWith` put THAT in the tbody: the row's detail stopped being a `tr.detail[data-detail]`, every selector that
  // follows one (placeRow, the sweep, a second unfold) missed it, and the reader's fold was carried by a node the panel
  // could no longer find. One edit or add on any row did it.
  const holder = document.createElement("tbody");
  holder.innerHTML = detailHtml(row);
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  detail.replaceWith(fresh);
  state.detailEls.set(key, fresh);
  const input = fresh.querySelector(".todo-edit, .todo-add-input");
  if (input && typeof input.focus === "function") {
    input.focus();
    input.select?.();
  }
}

// The reader's own write to a worktree's list. Every op goes through here: it is stamped `by: "reader"` by the route,
// a refusal comes back WITH its reason (shown as a banner, so a press that did nothing is never silent), and a write
// that landed re-reads the board so the strip and its counts are the server's own numbers.
async function todoPost(body) {
  try {
    const r = await apiFetch("/api/todos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) {
      showBanner(`TODO: ${d.error || `HTTP ${r.status}`}`);
      return null;
    }
    if (d.message) showNote(d.message);
    await resync();
    return d;
  } catch (err) {
    showBanner(`TODO: ${err.message}`);
    return null;
  }
}

function todoBlockHtml(row, key) {
  const todo = row.todo;
  if (!todo || !(todo.items || []).length) return "";
  const open = state.todoOpen.has(key);
  const oldest = todoOldest(todo);
  const done = Number(todo.done) || 0;
  const total = Number(todo.total) || (todo.items || []).length;
  const count = `${done}/${total}`;
  // The folded line: the count, then the OLDEST item still open. With nothing open it says so rather than showing the
  // last thing that moved.
  const peek = oldest
    ? todoLine(oldest)
    : `nothing open — ${done}/${total} done${todo.dropped ? `, ${todo.dropped} dropped` : ""}`;
  const draft = state.todoDraft && state.todoDraft.key === key ? state.todoDraft : null;
  const itemHtml = (todo.items || [])
    .map((item) => {
      const editing = draft && draft.id === item.id;
      const glyph = TODO_GLYPH[item.status] || "?";
      // The facts under this item are a disclosure of its OWN: folded unless the reader opened this item, and the key
      // carries the row as well as the id, so two worktrees' item #2 never share a fold.
      const factsKey = `${key}::${item.id}`;
      const factsOpen = state.todoFactsOpen.has(factsKey);
      // The facts about the item, ONE PER BULLET, as a nested list under its line. They used to be a single string
      // ridden to the far right of a full-width line (`margin-left:auto`), so on a 1,400px row the owner and age sat a
      // screen away from the words the reader was reading and both ends needed a zoomed-out browser. The fields are the
      // store's own (lib/todos.js): owner, by, the age since it last changed, plus the optional note and files.
      const age = todoAge(item.ageMs);
      const facts = [];
      if (item.owner) facts.push(`<li class="todo-fact" data-todo-fact="owner"><span class="todo-fact-label">owner</span> ${esc(item.owner)}</li>`);
      if (item.by) facts.push(`<li class="todo-fact" data-todo-fact="by"><span class="todo-fact-label">by</span> ${esc(item.by)}</li>`);
      if (age) facts.push(`<li class="todo-fact" data-todo-fact="updated"><span class="todo-fact-label">updated</span> ${esc(age)} ago</li>`);
      if (item.note) facts.push(`<li class="todo-fact todo-note dim" data-todo-fact="note">${esc(item.note)}</li>`);
      if ((item.files || []).length) facts.push(`<li class="todo-fact todo-files dimmer mono" data-todo-fact="files">${esc(item.files.join(" "))}</li>`);
      const factsHtml = facts.length
        ? `<ul class="todo-meta todo-facts mono" aria-label="who touched TODO #${item.id}, and when">${facts.join("")}</ul>`
        : "";
      const text = editing
        ? `<input class="todo-edit" type="text" maxlength="400" data-todo-edit="${item.id}" data-todo-key="${esc(key)}" value="${esc(draft.text)}" aria-label="edit TODO #${item.id}">
           <button type="button" class="todo-btn on" data-todo-op="edit-save" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="save this item">save</button>
           <button type="button" class="todo-btn" data-todo-op="edit-cancel" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="leave it as it was">cancel</button>`
        : `<span class="todo-text">${esc(item.text)}</span>
           <button type="button" class="todo-btn" data-todo-op="edit-start" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="edit this item (stored as by: reader)">✎</button>`;
      const actions = editing
        ? ""
        : `<button type="button" class="todo-btn" data-todo-op="doing" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="claim it — doing">▶</button>
           <button type="button" class="todo-btn" data-todo-op="done" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="mark it done">✓</button>
           <button type="button" class="todo-btn" data-todo-op="drop" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="drop it — it no longer applies">⊘</button>
           ${item.status === "done" || item.status === "dropped" ? `<button type="button" class="todo-btn" data-todo-op="reopen" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="reopen it — back to todo">↺</button>` : ""}`;
      // The item's own line is unchanged — glyph, id, its words, its controls — with ONE control in front of it: the
      // disclosure that folds its facts away. The facts still hang under the line, in the same list, indented the same
      // way; only whether they are showing is new, and that is the reader's to decide per item.
      const factsToggle = facts.length
        ? `<button type="button" class="todo-facts-btn" data-toggle-todo-facts="${item.id}" data-todo-key="${esc(key)}" aria-expanded="${factsOpen ? "true" : "false"}" aria-label="${factsOpen ? "hide" : "show"} the facts for TODO #${item.id}" title="${factsOpen ? "hide" : "show"} what the panel knows about TODO #${item.id} — its owner, who touched it and when"><span class="chev">${factsOpen ? "\u25be" : "\u25b8"}</span></button>`
        : "";
      return `<li class="todo-item todo-${esc(item.status)}${facts.length && !factsOpen ? " collapsed" : ""}" data-todo-item="${item.id}">
        <div class="todo-line">
          ${factsToggle}
          <span class="todo-glyph" title="${esc(item.status)}">${glyph}</span>
          <span class="todo-id mono dimmer">#${item.id}</span>
          ${text}
          ${actions}
        </div>
        ${factsHtml}
      </li>`;
    })
    .join("");
  const journal = (todo.journal || [])
    .slice(-6)
    .map((j) => `<li>${esc(`${j.by || "?"} ${j.op || ""}${j.id ? ` #${j.id}` : ""}${j.text ? `: ${j.text}` : ""}`)}</li>`)
    .join("");
  const addOpen = Boolean(draft && draft.id === null);
  const addHtml = `<div class="todo-add">
      ${
        addOpen
          ? `<input class="todo-add-input" type="text" maxlength="400" data-todo-add-input="${esc(key)}" value="${esc(draft.text)}" placeholder="what has to happen" aria-label="add a TODO item">
             <button type="button" class="todo-btn on" data-todo-op="add-save" data-todo-key="${esc(key)}" title="add it to this worktree's list (stored as by: reader)">add</button>
             <button type="button" class="todo-btn" data-todo-op="add-cancel" data-todo-key="${esc(key)}" title="cancel">cancel</button>`
          : `<button type="button" class="todo-btn add" data-todo-op="add-start" data-todo-key="${esc(key)}" title="add an item to this worktree's TODO list">+ add</button>`
      }
    </div>`;
  // The head is a real <button>, so the section is keyboard reachable (Tab to it, Enter or Space to unfold) — the two
  // strips under it are click-only, and the brief asks for this one to be reachable.
  // The reconcile the last ⟳ wrote, on the badge: how many items the TREE's own commits and touched files make look
  // closed. Nothing is applied — it is a question, and the reader's ✓ is the only thing that closes an item.
  const proposal = Array.isArray(todo.proposal) ? todo.proposal : [];
  const proposalTitle = proposal.length
    ? `nothing is marked done by itself — this is what the last ⟳ found:\n${proposal.map((p) => `#${p.id} ${p.text}${p.because ? ` — ${p.because}` : ""}`).join("\n")}`
    : "";
  const proposalChip = proposal.length
    ? `<span class="todo-proposal mono" title="${esc(proposalTitle)}">${proposal.length} look${proposal.length === 1 ? "s" : ""} closed</span>`
    : "";
  return `<div class="todo-block${open ? "" : " collapsed"}" data-todo-block="${esc(key)}">
    <button type="button" class="todo-head" data-toggle-todo="${esc(key)}" aria-expanded="${open ? "true" : "false"}" title="${open ? "fold" : "unfold"} this worktree's TODO list — folded it reads the OLDEST item still open">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <span class="todo-title">TODO</span>
      <span class="todo-count mono" title="${done} done of ${total}">${count}</span>
      ${proposalChip}
      ${open ? "" : `<span class="todo-first mono" title="${esc(peek)}">${esc(peek)}</span>`}
    </button>
    <div class="todo-body">
      <ul class="git-list todo-list">${itemHtml}</ul>
      ${journal ? `<div class="todo-journal mono dimmer"><span>journal</span><ul>${journal}</ul></div>` : ""}
      ${addHtml}
    </div>
  </div>`;
}

// The clock on a ⟳ journal line: the reader's own wall time, because the strip answers "when did I refresh this and what
// did it find" and a relative age would drift on a repaint.
function refreshClock(at) {
  const t = Date.parse(at || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function detailHtml(row) {
  const dirty = row.dirtyFiles || [];
  const untr = row.untrackedFiles || [];
  const commits = row.unmergedCommits || [];
  const pm = state.projects.get(row.project) || {};
  // The key is what the folds in this row are remembered by (state.gitOpen, state.gitSubOpen), and the commit and
  // file strips below are built before the rest of the row, so it is taken here rather than further down.
  const key = keyOf(row.project, row.path);
  // The commits this tree carries off remote main are the reason the row is worth opening, so they are a list of
  // their own: full width of the row, one commit per line, and nothing is dropped when the list is long — the list
  // extends and the panel scrolls, it is never clipped. It used to be one of three columns in a flex row, where a
  // long commit list was cut off and a long file list was squeezed into 300px beside its neighbours.
  const commitsBlock = commits.length
    ? `<div class="git-commits">
        <h4>Commits not on ${esc(pm.remoteRef || "remote main")}${row.diffSummary ? ` · ${esc(row.diffSummary)}` : ""}</h4>
        <ul class="git-commits-list">${commits
          .map((c) => `<li><span class="dimmer">${esc(c.sha)}</span> ${esc(c.subject)}</li>`)
          .join("")}</ul>
      </div>`
    : "";
  // Modified and Untracked were the other two columns of that flex row, and a tree with forty changed files turned
  // into a wall of names above its agents. Each is a one-line strip now, carrying its count, and its names stay
  // folded away until the reader opens it. A clean tree, or one with nothing unmerged, simply has no strips here.
  const subStrips = [];
  if (dirty.length) {
    subStrips.push(
      gitSubHtml(
        key,
        "modified",
        "Modified",
        dirty.length,
        dirty.map((f) => `<li><span class="dimmer">${esc(f.code)}</span> ${esc(f.path)}</li>`),
      ),
    );
  }
  if (untr.length) {
    subStrips.push(gitSubHtml(key, "untracked", "Untracked", untr.length, untr.map((f) => `<li>${esc(f)}</li>`)));
  }
  // The git side of the row (state, commit list, dirty files, diff summary) folds into one line:
  // opening a worktree is about seeing its agents and what is unmerged, not a wall of file names.
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
    // Why the branch cell is plain text rather than a link (or the page it links to), in the reader's own words.
    row.branchUrl ? `remote page: ${esc(row.branchUrl)}` : row.branchWhy ? `branch link: ${esc(row.branchWhy)}` : null,
    row.lastCommit ? `last commit ${relTime(row.lastCommit)} ago` : null,
    row.error ? `error: ${esc(row.error)}` : null,
  ].filter(Boolean);
  // orderedAgents: with "Stabilize reordering" on and an open card in this row, the cards keep the slots they have on
  // screen instead of sorting to newest-turn-first under the one the reader is reading.
  const agents = orderedAgents(row, agentsFor(row));
  // No heading: the row's own badge already says how many agents it owns and how many are running, and the
  // cards are the first thing under the row - a title above them only pushed them down.
  // A slot per card, not a copy of it: placeRow() moves the card that is already on the board into its slot.
  // Rebuilding the cards here destroyed their consoles on every scan - several times a second while a turn ran -
  // and every rebuild is a chance for a scroll position to be lost.
  // The add-agent bar is the full width of an agent card, half its height, a white + in the middle. Its position is a
  // setting (Settings > Display > Add-agent bar at top): above the cards when on, under them when off.
  // It is what the row's green ▶ used to do, because the ▶ now probes the agents the worktree already has. It stays
  // when the row has no agents at all - that is exactly when it is needed. Clicking it turns the bar into the text
  // field below (same footprint, so the row does not move), and Enter starts the run from there.
  const addKey = keyOf(row.project, row.path);
  const addOpen = state.addAgent && state.addAgent.key === addKey;
  const addBar = addAgentBarHtml({
    key: addKey,
    path: row.path,
    name: row.name,
    project: row.project,
    value: addOpen ? state.addAgent.value : null,
  });
  const agentsHtml = `<div class="agents-block">${agents.map((c) => `<div class="agent-slot" data-agent-slot="${esc(c.thread)}"></div>`).join("")}${addBar}</div>`;
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
  // What this branch was STARTED to do, in the words of its first run's own brief. The MERGE STATE below says where
  // the branch got to; this says what it was for, which is the question an old row actually raises. The text is the
  // server's (lib/descriptions.js, written down once per tree from the earliest run in it) — nothing here derives or
  // summarises anything beyond cutting it into its own sentences — and a tree the panel has no run for has no block at
  // all, so the section simply goes away rather than standing there empty.
  //
  // A bullet list, one bullet per sentence, and FOLDED to start with — the same shape as the two strips under it
  // (`ul.git-list`, one fact per `<li>`, the head's own line repeated as the first item). Folded, the first bullet
  // rides to the right of the header as the peek, exactly as the merge state's summary and the liveness block's first
  // line do, so the three strips read as one column of one-line headers.
  const desc = row.description && row.description.text ? row.description : null;
  const descOpen = desc ? state.openDescs.has(key) : false;
  const descBullets = desc ? descLines(desc.text) : [];
  const descFrom = desc?.from
    ? ["first run in this tree", desc.from.thread || null, desc.from.at ? `started ${relTime(desc.from.at)} ago` : null]
        .filter(Boolean)
        .join(" · ")
    : "";
  const descBlock = desc
    ? `<div class="desc-block${descOpen ? "" : " collapsed"}" data-desc-block="${esc(key)}">
      <div class="desc-head" data-toggle-desc="${esc(key)}" title="${descOpen ? "fold" : "unfold"} what this branch was started to do">
        <span class="chev">${descOpen ? "\u25be" : "\u25b8"}</span>
        <h4>Description</h4>
        ${descOpen ? "" : `<span class="desc-first mono">${esc(descBullets[0] || desc.text)}</span>`}
      </div>
      <div class="desc-body">
        <ul class="git-list desc-list">
          ${descBullets.map((line, i) => `<li${i === 0 ? ` class="git-summary-line"` : ""}>${esc(line)}</li>`).join("")}
        </ul>
        ${descFrom ? `<div class="desc-from mono">${esc(descFrom)}</div>` : ""}
      </div>
    </div>`
    : "";
  // What the row's own ⟳ found: one dim line per action it took, newest first. The journal is the server's (kept per row
  // beside the panel's other stores), so the strip survives a reload — and a row nobody has refreshed by hand has no
  // strip at all rather than an empty one.
  const refreshJournal = Array.isArray(row.refreshJournal) && row.refreshJournal.length
    ? `<div class="refresh-journal mono dimmer" data-refresh-journal="${esc(key)}" title="what the ⟳ on this row found — newest first, one line per action">${row.refreshJournal
        .map((j) => `<div class="rj-line"><span class="rj-at">⟳ ${esc(refreshClock(j.at))}</span> ${esc(j.text)}</div>`)
        .join("")}</div>`
    : "";
  // Merge state and liveness evidence lead the block again, but as two folded one-line strips: they are reference
  // material and were taking a block's worth of height above the agents when they sat open here.
  // Ten columns, not nine: the row-actions cell is the tenth, and a colspan of 9 left the card area short of the
  // table's right edge by that column, so the expanded agent section ended in a bare strip of panel on the right
  // while the left was flush. (The delete confirmation row below already spans 10.)
  // A RELEASE request a worker asked for (lib/worktrees.js): the tree, when it was asked for, the run that asked, why
  // it said it was finished, and what the panel's executor answered — `removed`, or `refused: <gate>`. It is one line,
  // never a block: a reader needs the verdict and the reason, and the gates are named in the sentence. A tree nobody
  // has asked about has no `release` field and draws nothing here.
  const rel = row.release || null;
  const relWhen = rel ? relTime(rel.at || rel.requestedAt) : "";
  const relState = rel ? String(rel.state || "") : "";
  const releaseBlock = rel
    ? `<div class="release-block ${esc(relState)}" data-release="${esc(key)}" title="${esc(
        [
          rel.outcome ? `outcome ${rel.outcome}` : "no outcome yet — the executor has not run",
          rel.detail || null,
          rel.runId ? `asked by run ${rel.runId}` : null,
          rel.requestedAt ? `requested ${new Date(rel.requestedAt).toLocaleString()}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      )}">
        <span class="release-mark">⇢</span>
        <span class="release-word">release</span>
        <span class="release-state">${esc(rel.outcome || "requested")}</span>
        <span class="release-when mono">${esc(relWhen)} ago${rel.runId ? ` · run ${esc(rel.runId)}` : ""}</span>
        <span class="release-why">${esc(rel.why || "")}</span>
      </div>`
    : "";
  return `<tr class="detail" data-detail="${esc(key)}"><td colspan="${wtColspan()}"><div class="detail-inner">
    ${releaseBlock}
    ${descBlock}
    ${todoBlockHtml(row, key)}
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
        ${commitsBlock}
        ${subStrips.join("")}
      </div>
    </div>
    ${refreshJournal}
    ${liveBlock}
    ${agentsHtml}
    ${sessionsHtml}
  </div></td></tr>`;
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
  const serving = rows.filter((r) => r.signals?.ports?.on).length;
  const removable = rows.filter((r) => r.mergeable).length;
  // Every agent whose home is a row in this project. Violet while any of them is working; amber as
  // soon as they are all idle, because "a live panel" is only true when something is actually running.
  const panelAgents = rows.flatMap((r) => agentsFor(r));
  const panelAgentCount = panelAgents.length;
  const panelRunningCount = panelAgents.filter(convLive).length;
  const stale = rows.filter((r) => r.verdictStale).length;
  // What the chart is holding back, so a collapsed project cannot silently under-report its trees: the count is of
  // rows this project's chart is not drawing because their last activity is older than the threshold, and it goes
  // away the moment that chart is asked for everything.
  const held = rows.filter(rowAgeHidden).length;
  const ageDays = ageHideDays();
  const out = [`<span class="chip">${rows.length} worktrees</span>`];
  if (held) out.push(`<span class="chip" title="${esc(`${held} worktree${held === 1 ? "" : "s"} whose last activity is older than ${ageDays} day${ageDays === 1 ? "" : "s"} — the chart is holding ${held === 1 ? "it" : "them"} back; the arrow at the bottom of the chart shows every tree`)}">${held} older hidden</span>`);
  if (merged) out.push(`<span class="chip good">${merged} merged</span>`);
  if (noCommits) out.push(`<span class="chip">${noCommits} no commits</span>`);
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (serving) out.push(`<span class="chip info">${serving} serving</span>`);
  // Violet in both states, like the ⧉ hermes chip: this is a Hermes-agent fact, not a warning. Amber
  // made every project with finished agents look like it wanted attention; the tooltip still says how
  // many are running right now.
  // How many agents are working RIGHT NOW, from every source: the panel's own cards and any Hermes
  // session (CLI or otherwise) whose turn is leased. The split is in the tooltip, so the chip stays the
  // answer to one question — "is anything running".
  // Hermes agents that are NOT this panel's, read the way the panel chip is: how many sessions the project
  // has, and how many of them are executing right now. Grey while they are all sitting there, violet as soon
  // as one is running, so the colour answers "is someone working" without parsing the numbers.
  const hermesRunning = rows.reduce((n, r) => n + (Number(r.signals?.hermes?.running) || 0), 0);
  const hermesIdle = rows.reduce((n, r) => n + (Number(r.signals?.hermes?.idle) || 0), 0);
  const hermesTotal = hermesRunning + hermesIdle;
  if (hermesTotal) {
    const busy = hermesRunning > 0;
    const head = busy
      ? `${hermesTotal} Hermes session${hermesTotal === 1 ? "" : "s"} from outside this panel in this project · ${hermesRunning} executing a turn right now`
      : `${hermesTotal} Hermes session${hermesTotal === 1 ? "" : "s"} from outside this panel in this project · none executing right now`;
    const titles = rows.flatMap((r) => [
      ...(r.signals?.hermes?.titles || []),
      ...((r.signals?.hermes?.idleList || []).map((s) => s.title).filter(Boolean)),
    ]);
    const tag = busy ? ` · ${hermesRunning} running` : "";
    out.push(
      `<span class="chip hermes${busy ? " on" : ""}" title="${esc(hermesTitle(head, titles))}">${hermesTotal} hermes${tag}</span>`,
    );
  }
  // Claude Code sessions, counted the same way as the Hermes ones above.
  const claudeRunning = rows.reduce((n, r) => n + (Number(r.signals?.claude?.running) || 0), 0);
  const claudeOpen = rows.reduce((n, r) => n + (r.signals?.claude?.on ? (r.signals.claude.titles || []).length : 0) + (Number(r.signals?.claude?.idle) || 0), 0);
  if (claudeOpen) {
    const busy = claudeRunning > 0;
    const head = `${claudeOpen} Claude Code session${claudeOpen === 1 ? "" : "s"} from outside this panel in this project · ${busy ? `${claudeRunning} executing a turn right now` : "none executing right now"}`;
    const titles = rows.flatMap((r) => r.signals?.claude?.titles || []).filter(Boolean);
    out.push(
      `<span class="chip claude${busy ? " on" : ""}" title="${esc(hermesTitle(head, titles))}">${claudeOpen} claude${busy ? ` · ${claudeRunning} running` : ""}</span>`,
    );
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
    (c.turns || []).some((t) => approvalLive(t.approval) && !t.approvalDone && turnLive(t)),
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
  const ctx = projectRankCtx(rank, Date.now());
  const byName = new Map([...state.projects.values()].map((p) => [p.name, p]));
  return orderedByRank("projects", [...byName.keys()], ctx).map((n) => byName.get(n)).filter(Boolean);
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
  // Moving a section or a folder moves the cards inside them, and that drops a selection standing in one.
  const heldSelection = captureCardSelection();
  // It also drops the caret: re-appending a project section or a folder takes every card and the inline add-agent
  // field inside it out of the page, and a detached field is blurred. Read both before the moves, put them back after.
  const typing = captureTyping(host);
  const rank = projectRanks();
  const ctx = projectRankCtx(rank, Date.now());
  // An open project keeps its exact slot — opening one is you saying "this is the one I am reading",
  // so it must not slide out from under the cursor. Everything closed sorts into the gaps around it:
  // one open project is no reason to hold the rest of the folder still. The order itself is the stored
  // smoothed one, so a project climbs or slides a place a tick rather than jumping on its newest line.
  const order = (els) => {
    const open = new Map();
    els.forEach((el, i) => {
      if (state.expandedProjects.has(el.dataset.project)) open.set(i, el);
    });
    const byName = new Map(els.map((el) => [el.dataset.project, el]));
    const ranked = orderedByRank("projects", els.map((el) => el.dataset.project), ctx);
    const free = ranked
      .filter((n) => !state.expandedProjects.has(n))
      .map((n) => byName.get(n))
      .filter(Boolean);
    const out = [];
    let f = 0;
    els.forEach((_, i) => out.push(open.has(i) ? open.get(i) : free[f++]));
    return out;
  };
  // Worked out BEFORE anything moves: the plan is pure (it only reads elements and the ranking), so it can be known
  // in advance whether this tick has any work at all - and the console scroll boxes can be read while they are still
  // laid out, which a read after the move is not.
  const plans = [];
  for (const body of host.querySelectorAll(".root-body")) {
    const sections = [...body.querySelectorAll("section.project")];
    if (!sections.length) continue;
    const want = order(sections);
    if (want.every((el, i) => el === sections[i])) continue;
    plans.push({ body, sections, want });
  }
  // Then the folders themselves, on the same ranking: a folder holding the project an agent is busy
  // in leads, then the one worked in most recently.
  const groups = [...host.querySelectorAll("section.root-group")];
  // A folder's rate is its busiest project's, and it is ranked the same smoothed way, on the same clock.
  const byRoot = new Map();
  for (const name of state.projects.keys()) {
    const root = rootOf(state.projects.get(name)) || "";
    const arr = byRoot.get(root) || [];
    arr.push(name);
    byRoot.set(root, arr);
  }
  const groupByRoot = new Map(groups.map((g) => [g.dataset.root || "", g]));
  const ranked = orderedByRank("folders", groups.map((g) => g.dataset.root || ""), folderRankCtx(byRoot, rank, Date.now()))
    .map((r) => groupByRoot.get(r))
    .filter(Boolean);
  // A folder you are reading a project in holds its slot for the same reason the project does: the
  // folder sliding up takes the open section with it, which looks exactly like the section itself jumping.
  const holdsOpen = (g) => [...g.querySelectorAll("section.project")].some((s) => state.expandedProjects.has(s.dataset.project));
  const pinnedGroups = new Map();
  groups.forEach((g, i) => { if (holdsOpen(g)) pinnedGroups.set(i, g); });
  const freeGroups = ranked.filter((g) => !pinnedGroups.has(groups.indexOf(g)));
  const wantGroups = [];
  let gf = 0;
  groups.forEach((_, i) => wantGroups.push(pinnedGroups.has(i) ? pinnedGroups.get(i) : freeGroups[gf++]));
  const moveGroups = !wantGroups.every((g, i) => g === groups[i]);
  // The common case on the clock: the ranking moved nothing this tick, so the page is left exactly as it is.
  if (!plans.length && !moveGroups) return;
  // Read the scroll boxes while they are still laid out, then move ONLY what is out of place. An open project keeps
  // its slot in `want`, so its section is never one of the moved ones - which is the whole fix: a re-rank that has
  // nothing to do with a console can no longer reset it. The hold is the belt for the cases where a section really
  // has to move (sections appeared or went away) and for the consoles inside a folder that moves.
  const held = holdScrolls(host);
  beginDomMove();
  for (const p of plans) {
    placeInOrder(p.body, p.want);
    flashMoved(p.sections, p.want, p.body);
  }
  if (moveGroups) placeInOrder(host, wantGroups);
  endDomMove();
  releaseScrolls(held);
  if (typing) restoreTyping(host, typing);
  restoreAddAgent(host);
  restoreCardSelection(heldSelection);
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
      <span class="root-filter" title="filter the projects in this folder by name or path — Escape clears it">
        <input class="root-search mono" data-root-search="${esc(root)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false"
          placeholder="filter ${allProjects.length}&hellip;" value="${esc(rootFilterValue(root))}">
        <button type="button" class="root-search-clear${rootFilterValue(root) ? " is-on" : ""}" data-root-search-clear="${esc(root)}" title="clear the filter">\u2715</button>
        <span class="root-count mono${rootFilterValue(root) ? " on" : ""}" data-root-count></span>
      </span>
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
      <p class="root-empty" data-root-empty></p>
${projects.map((p) => projectSection(p.name)).join("\n")}
    </div>
  </section>`;
}

// ---- where a project's branches and PRs live: the header's chip and its Discover strip -------------------------
// The board links a branch and a PR to whatever host the project's mapping names (logs/hosts.json, lib/hosts.js). That
// mapping is data, so it has to be visible and fillable from the page: the chip says which host a project resolves to
// (or that it has none, and why), and pressing it reads the project's own remote and offers the mapping it implies.
// The proposal is never written until the reader presses the button that writes it — a mapping the panel guessed is
// not a mapping, and a guessed URL is worse than the plain text this whole feature replaced.
function hostChipHtml(name) {
  const v = state.hosts?.projects?.[name];
  if (!v) return "";
  const coords = v.coordinates ? Object.values(v.coordinates).filter(Boolean).join("/") : "";
  const label = v.host ? `host: ${v.host}` : "no host";
  const title = v.host
    ? `links come from ${v.host}${coords ? ` (${coords})` : ""}${v.landing ? " · its landing doctrine is in the merge prompt" : " · no landing doctrine"}${v.links?.repo ? ` · ${v.links.repo}` : ""} — click to change or re-discover the mapping`
    : `${v.why} — click to read this project's remote and propose a mapping for you to confirm`;
  return `<button type="button" class="btn-host${v.host ? " is-mapped" : " is-unmapped"}" data-host-project="${esc(name)}" title="${esc(title)}">${esc(label)}${coords ? ` <span class="host-coords">${esc(coords)}</span>` : ""}</button>`;
}

function hostPanelHtml(name) {
  const panel = state.hostPanel;
  if (!panel || panel.project !== name) return "";
  const ids = Object.keys(state.hosts?.hosts || {});
  const opts = ids.length ? ids.map((id) => `<option value="${esc(id)}"${id === panel.host ? " selected" : ""}>${esc(id)}</option>`).join("") : `<option value="">(no host records)</option>`;
  return `<div class="host-form" data-host-form="${esc(name)}">
      <span class="mono host-line${panel.error ? " clone-err" : ""}" data-host-line>${esc(panel.line || "")}</span>
      <label class="host-field">host <select data-host-select="${esc(name)}"${panel.busy ? " disabled" : ""}>${opts}</select></label>
      <label class="host-field">coordinates <input type="text" class="mono" data-host-coords="${esc(name)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false" placeholder="owner/repo or PROJECT/slug" value="${esc(panel.coords || "")}"${panel.busy ? " disabled" : ""}></label>
      <button type="button" data-host-save="${esc(name)}"${panel.busy ? " disabled" : ""}>Use this mapping</button>
      <button type="button" data-host-cancel="${esc(name)}">Cancel</button>
    </div>`;
}

function repaintHostPanel(name) {
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  if (!sec) return;
  const html = hostPanelHtml(name);
  const old = sec.querySelector("[data-host-form]");
  if (old) {
    if (html) old.outerHTML = html;
    else old.remove();
    return;
  }
  if (!html) return;
  const head = sec.querySelector(".project-head.meta-line");
  if (head) head.insertAdjacentHTML("afterend", html);
}

async function proposeHostMapping(name) {
  // A second press on the same chip closes the strip; it is a toggle, not a dialog.
  if (state.hostPanel?.project === name) {
    state.hostPanel = null;
    repaintHostPanel(name);
    return;
  }
  const current = state.hosts?.projects?.[name] || {};
  state.hostPanel = { project: name, host: current.host || "", coords: "", line: "reading the remote…", busy: true };
  repaintHostPanel(name);
  try {
    const res = await apiFetch("/api/hosts/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: name }),
    });
    const out = await res.json().catch(() => ({}));
    if (state.hostPanel?.project !== name) return;
    if (!res.ok) {
      state.hostPanel = { ...state.hostPanel, busy: false, error: true, line: out.error || `could not read the remote (HTTP ${res.status})` };
      repaintHostPanel(name);
      return;
    }
    const prop = out.proposal || {};
    const coords = prop.ok ? Object.values(prop.coordinates || {}).filter(Boolean).join("/") : "";
    state.hostPanel = {
      project: name,
      host: prop.ok ? prop.host : current.host || Object.keys(state.hosts?.hosts || {})[0] || "",
      coords,
      busy: false,
      error: !prop.ok,
      line: prop.ok
        ? `proposed from ${prop.remoteUrl} → ${prop.host} · ${coords} — confirm to write it`
        : `no proposal: ${prop.why || "unknown reason"}`,
    };
    repaintHostPanel(name);
    document.querySelector(`[data-host-coords="${CSS.escape(name)}"]`)?.focus();
  } catch (e) {
    if (state.hostPanel?.project !== name) return;
    state.hostPanel = { ...state.hostPanel, busy: false, error: true, line: `could not read the remote: ${e.message}` };
    repaintHostPanel(name);
  }
}

async function saveHostMapping(name) {
  const panel = state.hostPanel;
  if (!panel || panel.project !== name) return;
  const host = document.querySelector(`[data-host-select="${CSS.escape(name)}"]`)?.value || panel.host;
  const coords = document.querySelector(`[data-host-coords="${CSS.escape(name)}"]`)?.value ?? panel.coords;
  if (!host) {
    state.hostPanel = { ...panel, error: true, line: "pick a host id first — logs/hosts.json and hosts.seed.json define them" };
    repaintHostPanel(name);
    return;
  }
  state.hostPanel = { ...panel, busy: true, error: false, line: "writing the mapping…" };
  repaintHostPanel(name);
  try {
    const res = await apiFetch("/api/hosts/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: name, host, coordinates: String(coords || "").trim() }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      state.hostPanel = { ...state.hostPanel, busy: false, error: true, line: out.error || `could not write the mapping (HTTP ${res.status})` };
      repaintHostPanel(name);
      return;
    }
    state.hostPanel = null;
    repaintHostPanel(name);
    showBanner(`host mapping: ${name} → ${host}${out.mapping?.links?.repo ? ` (${out.mapping.links.repo})` : ""}`);
    // The rows carry their link as a scan result, so the cells catch up on the next pass; this resync brings the new
    // chip and the project's own coordinates back immediately.
    void resync();
  } catch (e) {
    state.hostPanel = { ...state.hostPanel, busy: false, error: true, line: `could not write the mapping: ${e.message}` };
    repaintHostPanel(name);
  }
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
  const hue = state.projectHues.get(name);
  return `<section class="project${open ? "" : " collapsed"}${hue == null ? "" : " has-hue"}" data-project="${esc(name)}"${hue == null ? "" : ` style="--proj-hue:${Number(hue)}"`}>
    <div class="project-head" data-toggle-project="${esc(name)}" title="${esc(headTitle(name))}">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <h2>${esc(name)}</h2>
      <button class="btn-plus" data-spawn-project="${esc(name)}" title="start a Hermes agent, worktree and branch in ${esc(name)}">+</button>
      <span class="path">${esc(p.path || "")}</span>
      <span class="spacer"></span><div class="chips" data-chips="${esc(name)}">${chipsHtml(name)}</div>
    </div>
    <div class="project-head meta-line">
      <span class="mono dim">${mainLine}</span><span class="spacer"></span>${board}${tip}
      <span class="dimmer mono">${p.fetchNote ? esc(p.fetchNote) + " · " : ""}fetched ${relTime(p.fetchedAt)} ago</span>${hostChipHtml(name)}
    </div>
    ${hostPanelHtml(name)}
    <div class="wt-scroll">
      <table><thead><tr>${chartHeaderHtml()}</tr></thead><tbody data-tbody="${esc(name)}"></tbody></table>
    </div>
    <div class="legend"><span class="age-slot" data-age-slot="${esc(name)}"></span>liveness evidence: <span class="sig sig-hermes">⧉ hermes</span> session active · <span class="sig sig-claude">⧉ claude</span> Claude Code session active · <span class="sig sig-board">● board</span> live board PID · <span class="sig sig-port">:port</span> dev server listening · <span class="sig sig-files">✎ files</span> edited recently — a row is live only if one of these fired · the number is time since that last happened, the ring fills up to green as the row becomes due for its next read</div>
  </section>`;
}

function refreshChips(name) {
  const el = document.querySelector(`[data-chips="${CSS.escape(name)}"]`);
  if (el) el.innerHTML = chipsHtml(name);
  // The age arrow's presence depends on the same rows, so it is refreshed from the same place.
  refreshAgeToggle(name);
}

// ---- chart columns: which of the table's ten the reader keeps ---------------------------------------------
// Ten columns on every row is a lot of chart, and a reader chasing one fact (which trees are merged, which are
// behind) does not need the other nine on screen. Hiding a column is a settings choice stored in this panel's
// config.json (`hiddenColumns`, POST /api/settings/columns), and the column set is DATA here rather than ten
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
    label: "Life / next read",
    min: 120,
    give: 0.5,
    title:
      "time since this worktree was last seen alive (any evidence firing) · the ring fills up to green as the row becomes due for its next read · chips are the evidence: ⧉ hermes session · ● board PID · :port dev server · ✎ files edited",
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
function shownColumns() {
  const hidden = hiddenColumnIds();
  const shown = CHART_COLUMNS.map((_, i) => i).filter((i) => !hidden.has(CHART_COLUMNS[i].id));
  return shown.length ? shown : [WT_COLS - 1];
}

// How many cells a column-spanning row needs: an expanded worktree, a delete question, a lock refusal, a rename
// offer. It used to be the literal 10 in five places, which is exactly how a hidden column leaves a bare strip of
// panel at the right edge (or a cell one column short, silently dropping the last one).
function wtColspan() {
  return shownColumns().length;
}

function chartHeaderHtml() {
  return shownColumns()
    .map((i) => {
      const c = CHART_COLUMNS[i];
      const attrs = `data-col-id="${esc(c.id)}"${c.title ? ` title="${esc(c.title)}"` : ""}`;
      return `<th ${attrs}>${esc(c.label)}</th>`;
    })
    .join("");
}
// ---- end chart columns

const COL_WIDTHS_KEY = "wtgui.colWidths";

function loadColWidths() {
  const out = new Array(WT_COLS).fill(null);
  try {
    const raw = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || "[]");
    if (Array.isArray(raw)) for (let i = 0; i < WT_COLS; i += 1) if (Number.isFinite(raw[i]) && raw[i] > 0) out[i] = Math.round(raw[i]);
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
// buttons included. Measured on the real table by letting it lay out at max-content for one synchronous step and
// putting the fixed split back before the frame paints - no clone, no flicker.
function naturalColumnWidths(table) {
  const ths = headerCells(table);
  const kept = ths.map((th) => th.style.width);
  const layout = table.style.tableLayout;
  const width = table.style.width;
  table.style.tableLayout = "auto";
  table.style.width = "max-content";
  for (const th of ths) th.style.width = "";
  const natural = ths.map((th) => Math.ceil(th.getBoundingClientRect().width));
  table.style.tableLayout = layout;
  table.style.width = width;
  ths.forEach((th, i) => {
    th.style.width = kept[i];
  });
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
    const namePos = cols.indexOf(0);
    const branchPos = cols.indexOf(1);
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
  // Integers that add up to the table's width exactly: rounding lands on the leftmost column, the one with room.
  want[0] = Math.max(24, want[0] + (total - sum(want)));
  return want;
}

function applyColumnWidths(table, widths) {
  headerCells(table).forEach((th, p) => {
    th.style.width = `${Math.max(24, Math.round(widths[p]))}px`;
  });
}

// ---- how wide the split is allowed to be, and what happens when there is less room than that ----------------
// The table's own box has always been the answer, and on a desktop card it still is. It stops being an answer once
// the card is narrower than the ten columns' measured floors (COL_MIN, 846px in total): the plan then had to scale
// every column below its floor, and a 393px phone - 330px of table - gave each column ~24px, so the headers wrapped
// onto three lines and the values ran into each other. There is no smaller readable version of ten columns, so below
// that width the table keeps the floor width and `.wt-scroll` (its wrapper) scrolls sideways instead. The mode is
// decided here, from the wrapper's own width, which the table cannot influence: no feedback loop, and no scrollbar
// that makes itself necessary.
const WT_SCROLL = "wt-scroll";

function fitTarget(table) {
  const wrap = table.parentElement && table.parentElement.classList.contains(WT_SCROLL) ? table.parentElement : null;
  const box = Math.floor((wrap || table).clientWidth);
  // Only the columns on the chart set the width below which it scrolls: hiding five columns lowers that floor, which
  // is the room a reader is buying back by hiding them.
  const floor = shownColumns().reduce((a, i) => a + COL_MIN[i], 0);
  const scroll = Boolean(wrap) && box > 0 && box < floor;
  return { wrap, box, total: scroll ? floor : box, scroll };
}

// Writes the mode onto the page: the class the CSS hangs the sideways scroll on, the table's own min-width (the
// width the column split adds up to, so nothing overflows inside the table), and the visible width the two
// column-spanning rows are pinned to while the columns move under them.
function applyFitMode(table, fit) {
  if (!fit.wrap) return;
  fit.wrap.classList.toggle("is-scroll", fit.scroll);
  // Written only when it changes: this runs on every row rebuild, and re-setting a value that is already there
  // costs a style recalculation of the whole table for nothing.
  const minWidth = fit.scroll ? `${fit.total}px` : "";
  if (table.style.minWidth !== minWidth) table.style.minWidth = minWidth;
  if (fit.scroll) {
    const visible = `${fit.box}px`;
    if (fit.wrap.style.getPropertyValue("--wt-visible") !== visible) fit.wrap.style.setProperty("--wt-visible", visible);
  } else if (fit.wrap.style.getPropertyValue("--wt-visible")) {
    fit.wrap.style.removeProperty("--wt-visible");
  }
}

// Measurements are only good while the cells are: a repaint that changed no text should not pay for a layout.
const columnSigs = new WeakMap();

function columnSignature(tbody) {
  let chips = 0;
  for (const el of tbody.querySelectorAll(".sig, .chip")) chips += 1;
  return `${tbody.children.length}:${tbody.textContent.length}:${chips}`;
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

function beginColumnDrag(e) {
  if (e.button !== 0) return;
  const grip = e.currentTarget;
  const table = grip.closest("table");
  const i = Number(grip.dataset.col);
  const widths = headerCells(table).map((th) => th.getBoundingClientRect().width);
  if (!widths.length || widths[i + 1] == null) return;
  // The pair is remembered by COLUMN, not by position: the header is rebuilt from the shown set on every render, so a
  // position is only true for the table it was measured on.
  const cols = shownColumns();
  colDrag = { grip, table, i, cols, x: e.clientX, widths, pair: widths[i] + widths[i + 1], left: null };
  grip.classList.add("is-dragging");
  document.body.classList.add("col-resizing");
  e.preventDefault();
  e.stopPropagation();
  window.addEventListener("pointermove", dragColumn);
  window.addEventListener("pointerup", endColumnDrag, { once: true });
  window.addEventListener("pointercancel", endColumnDrag, { once: true });
}

function dragColumn(e) {
  if (!colDrag) return;
  const { table, i, cols, x, widths, pair } = colDrag;
  const ths = headerCells(table);
  const floorLeft = COL_MIN[cols[i]];
  const floorRight = COL_MIN[cols[i + 1]];
  const left = Math.max(floorLeft, Math.min(pair - floorRight, Math.round(widths[i] + (e.clientX - x))));
  colDrag.left = left;
  colDrag.right = Math.round(pair - left);
  ths[i].style.width = `${colDrag.left}px`;
  ths[i + 1].style.width = `${colDrag.right}px`;
}

function endColumnDrag() {
  if (!colDrag) return;
  const { grip, i, cols, left, right } = colDrag;
  colDrag = null;
  window.removeEventListener("pointermove", dragColumn);
  grip.classList.remove("is-dragging");
  document.body.classList.remove("col-resizing");
  // A press with no movement is a click on the edge, not a decision about the width.
  if (left == null) return;
  colWidths[cols[i]] = left;
  colWidths[cols[i + 1]] = right;
  saveColWidths();
  fitAllColumns();
}

// A narrower window means the same content in less room, so the measurement is redone. Resizing the window fires
// this continuously, and each fit costs a layout, so it waits for the drag to settle.
let columnFitTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(columnFitTimer);
  columnFitTimer = setTimeout(fitAllColumns, 140);
});

// ---- stabilize reordering -------------------------------------------------------------------
// A list that re-sorts while the reader has something open in it moves the thing they are reading. With this on, a
// list freezes the moment one of its own elements is expanded: a project's worktree rows stop re-ranking while any of
// them is open, and the agent cards in one worktree stop re-ranking while any of those cards is open. Off, everything
// sorts on every paint as it always did. Saved in this browser.
const STABILIZE_KEY = "wtgui.stabilize";
function stabilizeOn() {
  try {
    const raw = localStorage.getItem(STABILIZE_KEY);
    // On by default: a board that shuffles under an open row is the surprise, not the absence of shuffling.
    return raw === null ? true : raw !== "0";
  } catch {
    return true;
  }
}

function applyStabilize(on) {
  const box = $("stabilize-reorder");
  if (box) box.checked = on;
  try {
    localStorage.setItem(STABILIZE_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the choice just will not persist */
  }
  // Turned on, the current order is the order worth keeping: take it before the next paint re-sorts anything.
  rememberAgentOrders();
  renderAll();
  scheduleRenderJobs();
}

// Is anything open in this list? Rows of a project, and cards of a row.
function projectHasOpenRow(name) {
  for (const key of state.expanded) if (state.rows.get(key)?.project === name) return true;
  return false;
}

function rowHasOpenCard(threads) {
  return threads.some((t) => !state.collapsedJobs.has(t));
}

// The order the cards in one row show in. With Stabilize reordering on and a card open they keep the slots they
// already have on screen; otherwise they are ranked by the same sliding average as everything else - the thread's
// own liveness over the window, so a chatty agent sits at the top of its row, a card with one line stays put, and
// one that goes quiet slides down. A frozen list keeps its remembered order.
function orderedAgents(row, agents) {
  const key = keyOf(row.project, row.path);
  if (!agents.length) return agents;
  if (stabilizeOn() && rowHasOpenCard(agents.map((c) => c.thread))) {
    const last = state.agentOrder.get(key);
    if (!last || !last.length) return agents;
    const pos = new Map(last.map((t, i) => [t, i]));
    return [...agents].sort((a, b) => (pos.get(a.thread) ?? last.length) - (pos.get(b.thread) ?? last.length));
  }
  const byThread = new Map(agents.map((c) => [c.thread, c]));
  const order = orderedByRank(`agents:${key}`, [...byThread.keys()], agentRankCtx(row, Date.now()));
  return order.map((t) => byThread.get(t)).filter(Boolean);
}

// Remember what was just painted, so the next frozen paint has an order to keep.
function rememberAgentOrder(key, detail) {
  if (!detail) return;
  const order = [...detail.querySelectorAll(".job[data-thread]")].map((c) => c.dataset.thread).filter(Boolean);
  if (order.length) state.agentOrder.set(key, order);
  else state.agentOrder.delete(key);
}

function rememberAgentOrders() {
  for (const [key, detail] of state.detailEls) rememberAgentOrder(key, detail);
}

function reorder(name) {
  const tbody = state.tbodyEls.get(name);
  if (!tbody) return;
  // Stabilized: while one row of this project is open, none of them re-ranks around it.
  if (stabilizeOn() && projectHasOpenRow(name)) return;
  // Re-appending a detail takes its cards out of the DOM on the way, which is enough to lose a selection.
  const heldSelection = captureCardSelection();
  // And enough to lose the caret: a re-rank of some OTHER worktree re-appends every row in this project, including
  // the open one the reader is typing in, and a detached box cannot keep focus. That is the cursor going missing
  // when a row flashes green - the flash touches nothing, the re-sort under it moves everything.
  const typing = $("projects") ? captureTyping($("projects")) : null;
  const mine = [...state.rows.values()].filter((r) => r.project === name);
  // The order if nothing were pinned: our running agents first, then everything by how recently it
  // showed life. This is what "latest movement at the top" means once all the accordions are closed.
  const ranked = applyRowRank([...mine]).map((r) => keyOf(name, r.path));
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
    // The confirmation is a child of its row inside the table, so a re-rank that re-appends only the
    // rows leaves it behind at index 0 - the box "pops up the top" instead of staying under the tree
    // it asks about. Carry it with its row, between the row and its detail.
    const c = state.confirmEls.get(k);
    if (c) want.push(c);
    const d = state.detailEls.get(k);
    if (d) want.push(d);
  }
  // A confirmation for a row that is gone must not survive its own row.
  for (const [k, c] of [...state.confirmEls]) {
    if (!state.rows.has(k)) {
      c.remove();
      state.confirmEls.delete(k);
    }
  }
  // Only touch the DOM when the order really changed: this runs on every row event, and re-appending
  // identical nodes would fight the scroll position while someone is reading.
  const current = [...tbody.children];
  if (current.length === want.length && current.every((el, i) => el === want[i])) return;
  // Same discipline as reorderProjects(): a detail that only slid because a NEIGHBOUR was re-ranked must not take its
  // console out of the layout tree. Only the rows that are out of place move, and what does move is put back in this
  // same task instead of waiting for the next line or the 400 ms sweep.
  const heldScrolls = holdScrolls(tbody);
  beginDomMove();
  placeInOrder(tbody, want);
  endDomMove();
  releaseScrolls(heldScrolls);
  if (typing) restoreTyping(tbody, typing);
  restoreAddAgent(tbody);
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
  restoreCardSelection(heldSelection);
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
    el._flashT = setTimeout(() => el.classList.remove(kind), flashRowMs() + 40);
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
  // This path takes the row's detail out of the document and puts a new one back. Anything that measures meanwhile
  // lays the page out with that detail missing, and near the bottom of the page a shorter document clamps the
  // reader's scroll upward for good. Hold the position, and give the sweep the anchor to hold afterwards.
  const pageY = window.scrollY;
  const rowAnchor = captureBoardAnchor();
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
  if (isNew) seedRankWindows(row);
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
  // A row the chart is holding back is not on the chart, so nothing of it may be drawn - the state, the chips and
  // the agents still know the row (they always did; the row is only held out of the drawing). The threshold can have
  // just crossed this row's activity, or the reader can have just asked this chart to hold the stale ones back, and
  // either way the row has to leave the DOM here rather than wait for the next full rebuild of the project.
  if (rowAgeHidden(row)) {
    const gone = state.rowEls.get(key);
    if (gone) {
      state.detailEls.get(key)?.remove();
      state.detailEls.delete(key);
      gone.remove();
      state.rowEls.delete(key);
    }
    refreshChips(project);
    return;
  }
  const old = state.rowEls.get(key);
  // A collapsed section is not on screen: keep the row in state (the chips and counters need it)
  // but spend nothing on its markup. Expanding the project renders it from state.
  if (!state.expandedProjects.has(project)) {
    // Collapsed: there is no row on screen to flash, so a GREEN row flash becomes a green flash on the project's own
    // bar - "something inside this box moved and you could not see it". The quiet grey pulse is not repeated here:
    // "re-read, nothing moved" is not worth a project-level signal.
    if (flash && moved) pulseProject(project);
    refreshChips(project);
    return;
  }
  const cachedDetail = state.detailEls.get(key);
  // Ask the DOM, not just the cache: a rebuild can leave `detailEls` pointing at a detached detail while a
  // different one for the same key is on screen. Removing the cached one then added a second detail under the
  // row - the duplicated MERGE STATE / LIVENESS EVIDENCE block.
  const oldDetail = document.querySelector(`tr.detail[data-detail="${CSS.escape(key)}"]`) || cachedDetail;
  const oldCards = new Map();
  if (oldDetail) for (const card of oldDetail.querySelectorAll(".job[data-thread]")) oldCards.set(card.dataset.thread, card);
  const typing = oldDetail ? captureTyping(oldDetail) : null;
  // The details below come down and their cards go into new ones; a selection in a card has to come back with them.
  const heldSelection = captureCardSelection();
  const outs = oldDetail
    ? [...oldDetail.querySelectorAll("pre.job-out")].map((o) => ({
        id: o.dataset.out,
        top: o.scrollTop,
        atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32,
      }))
    : [];
  // The cards are carried into the new detail below, and a card taken out of the document and put back comes back at
  // its first line: hold every open child console in the old detail before it leaves, and hand each one its place
  // back in this same task, once its card is in the new detail.
  const heldSubs = oldDetail ? holdSubConsoles(oldDetail) : [];
  beginDomMove();
  if (oldDetail) oldDetail.remove();
  // Any other copy for this key is a stray from an earlier render: one row, one detail.
  for (const stray of document.querySelectorAll(`tr.detail[data-detail="${CSS.escape(key)}"]`)) stray.remove();
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
    // The cards move across before anything is measured, so "where was this console" is answered by the node
    // that is actually going to stay on screen.
    fillAgentSlots(dEl, oldCards);
    rememberAgentOrder(key, dEl);
    restoreThinkBodies(dEl);
    // Put the reader back: the reply they were typing, where the caret was, and how far each
    // transcript had been scrolled.
    restoreTyping(dEl, typing);
    restoreAddAgent(dEl);
    const scrollMap = new Map(outs.map((o) => [o.id, { top: o.top, atBottom: o.atBottom }]));
    restoreScrolls(dEl, scrollMap);
    applyStoredScrolls(dEl);
    releaseScrolls(heldSubs);
    settleScrolls(dEl);
  }
  // The move is over for both shapes of row (a bare row rebuilds no detail but still replaces its <tr>).
  endDomMove();
  // After restoreTyping, which focuses the reply box and would take the document selection with it.
  restoreCardSelection(heldSelection);
  if (flash && old) {
    // Green when an agent moved in this row; a quiet grey when the refresh ran and found nothing new.
    // Two outcomes, two colours — one colour for both made every 5s tick look like progress.
    const kind = moved ? "flash" : "flash-idle";
    newTr.classList.add(kind);
    setTimeout(() => newTr.classList.remove(kind), 900);
  }
  reorder(project);
  refreshChips(project);
  // This row's cells may hold more or less than they did (a longer verdict, a chip that appeared): re-measure, once
  // per frame however many rows of this project arrived in the same tick.
  scheduleColumnFit(tbody.closest("table"));
  // The rebuild is one synchronous step, so a moved scroll is the browser clamping rather than the reader leaving:
  // put the page back before the sweep re-measures the anchor.
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  scheduleBoardSweep(rowAnchor);
  // The ⟳'s offer card sat under this row and the row was just replaced: one copy, back under the new node.
  if (state.refreshOffers.has(key)) paintRefreshOffer(key);
}

function removeRow(project, p) {
  const key = keyOf(project, p);
  // A row and its detail leaving the page shortens the document. A reader parked at the bottom would be clamped
  // upward by however tall it was, and the height does not come back with their scroll - hold the position.
  const pageY = window.scrollY;
  state.rowEls.get(key)?.remove();
  state.detailEls.get(key)?.remove();
  state.confirmEls.get(key)?.remove();
  // The offer belonged to the row that is going away: nothing can start an agent in a tree the board no longer has.
  clearRefreshOffer(key);
  state.rowEls.delete(key);
  state.detailEls.delete(key);
  state.confirmEls.delete(key);
  state.rows.delete(key);
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  refreshChips(project);
  // A row leaving takes its width requirement with it, so the split is measured again - after this tick, not inside it.
  scheduleColumnFit(state.tbodyEls.get(project)?.closest("table"));
}

// Paint one project's rows into its (possibly just replaced) tbody.
function renderProjectRows(name, { typing = null } = {}) {
  const tbody = state.tbodyEls.get(name);
  if (!tbody) return;
  // The rebuild below replaces every row of this project, and it must not walk the reader up the page. Emptying the
  // tbody and appending row by row laid the page out with part of the project missing - the reply box measures
  // itself (scrollHeight) while a draft is restored, which forces that layout - and at the bottom of the page ANY
  // shrink clamps the reader's scroll upward for good: the height comes back, the scroll position does not. So the
  // rows are built off the document and swapped in one operation, and the page position is held across the swap.
  const pageY = window.scrollY;
  // Open rows carry agent transcripts; a rebuild must not throw the reader to the top of one.
  const prevScrolls = captureScrolls(tbody);
  // The cards are carried into the rebuilt details below, so the child consoles inside them leave the document with
  // the old tbody and come back at their first line: read them here, before the swap, and release them after.
  const heldSubs = holdSubConsoles(tbody);
  const heldSelection = captureCardSelection();
  const anchor = captureBoardAnchor();
  const prevRowKeys = [...tbody.children].filter((el) => el.classList.contains("row")).map((el) => el.dataset.key);
  // The cards and the typing inside each open row live in its detail element, and this path replaces the whole
  // tbody. Capture them by row key first: the detail is rebuilt from detailHtml() below, whose agent slots are
  // empty placeholders, so without this the agents block came back as nothing and stayed empty until the next
  // scan's placeRow happened to fill it — which is what made the agents vanish for ~5s after sending a reply.
  const prevCards = new Map();
  const prevTyping = new Map();
  for (const [k, dEl] of state.detailEls) {
    if (state.rows.get(k)?.project !== name) continue;
    const cards = new Map();
    for (const card of dEl.querySelectorAll(".job[data-thread]")) cards.set(card.dataset.thread, card);
    prevCards.set(k, cards);
    prevTyping.set(k, captureTyping(dEl));
  }
  // A collapsed project shows nothing, so building its rows would be pure waste — with 94
  // projects that was ~110 invisible rows and most of the render cost of a snapshot.
  const expanded = state.expandedProjects.has(name);
  const frag = document.createDocumentFragment();
  const built = [];
  // Stabilized: while a row of this project is open, the rows keep the order they are already in on screen (a row
  // that is genuinely new goes last). Only the painting order changes - the ranking is still there for when the
  // reader closes everything.
  // Rows older than the age threshold are not built at all: the chart draws what it is showing, and the arrow in the
  // legend below it is what brings the rest back (see rowAgeHidden). The ranking above still sees them, so a row that
  // comes back to life takes its place in the order the moment it is drawn again.
  const rowsInOrder = applyRowRank([...state.rows.values()].filter((r) => r.project === name && !rowAgeHidden(r)));
  if (stabilizeOn() && projectHasOpenRow(name) && prevRowKeys.length) {
    const pos = new Map(prevRowKeys.map((k, i) => [k, i]));
    rowsInOrder.sort(
      (a, b) =>
        (pos.get(keyOf(name, a.path)) ?? prevRowKeys.length) - (pos.get(keyOf(name, b.path)) ?? prevRowKeys.length),
    );
  }
  if (expanded) {
    for (const row of rowsInOrder) {
      const key = keyOf(name, row.path);
      const holder = document.createElement("tbody");
      holder.innerHTML = rowHtml(row);
      const tr = holder.firstElementChild;
      frag.appendChild(tr);
      // An open confirmation belongs to its row, and this path rebuilds every row: carry the live node
      // over so the question survives the repaint (and does not come back at the top of the table).
      const confirmEl = state.confirmEls.get(key);
      if (confirmEl) frag.appendChild(confirmEl);
      let dEl = null;
      if (state.expanded.has(key)) {
        const h2 = document.createElement("tbody");
        h2.innerHTML = detailHtml(row);
        dEl = h2.firstElementChild;
        frag.appendChild(dEl);
      }
      built.push({ key, tr, dEl });
    }
  }
  // One swap: the old rows leave as the new ones arrive, so the document never lays out half-built.
  beginDomMove();
  tbody.replaceChildren(frag);
  if (!expanded) {
    for (const k of [...state.rowEls.keys()]) if (state.rows.get(k)?.project === name) state.rowEls.delete(k);
    for (const k of [...state.detailEls.keys()]) if (state.rows.get(k)?.project === name) state.detailEls.delete(k);
    endDomMove();
    // Nothing of this project's is on screen any more, so its confirmation is gone with it.
    for (const k of [...state.confirmEls.keys()]) if (state.rows.get(k)?.project === name) state.confirmEls.delete(k);
    // The header is still on screen and its rows are not: measure it anyway, so opening the project later does not
    // start from the percentage fallback.
    fitColumns(tbody.closest("table"));
    return;
  }
  const live = new Set(built.map((b) => b.key));
  for (const k of [...state.rowEls.keys()]) if (state.rows.get(k)?.project === name && !live.has(k)) state.rowEls.delete(k);
  // A confirmation whose row was not rebuilt is no longer on the page either.
  for (const k of [...state.confirmEls.keys()]) if (state.rows.get(k)?.project === name && !live.has(k)) state.confirmEls.delete(k);
  // Only now, with the rows in the document, put the cards into the slots the rebuilt detail made for them and the
  // reader's draft and caret back into the reply box: a detached box cannot measure itself against its own text.
  for (const { key, tr, dEl } of built) {
    state.rowEls.set(key, tr);
    if (!dEl) continue;
    state.detailEls.set(key, dEl);
    fillAgentSlots(dEl, prevCards.get(key) || new Map());
    // The thinking block lives in the card and this path re-renders or re-inserts every card in the
    // project. Without this the running turn's open block came back at its FIRST line on every project
    // event, which is what read as the reasoning flickering while the tool calls scrolled out of view.
    restoreThinkBodies(dEl);
    rememberAgentOrder(key, dEl);
    restoreTyping(dEl, prevTyping.get(key) || null);
    restoreAddAgent(dEl);
  }
  endDomMove();
  // The cards have been carried into the rebuilt details; put each open child console back on its line in this same
  // task, so the swap is never painted with one of them at the top.
  releaseScrolls(heldSubs);
  // A row that no longer exists must not leave a dead detail element remembered.
  for (const k of [...state.detailEls.keys()]) {
    if (state.rows.get(k)?.project !== name) state.detailEls.delete(k);
    else if (!state.expanded.has(k)) state.detailEls.delete(k);
  }
  // The rows this table holds have just changed, so what each column has to be wide enough for changed with them.
  // Measured here, before the position below is restored: a new split can re-wrap a chip strip and make a row
  // taller, and a height change after the restore is a clamp the reader keeps.
  fitColumns(tbody.closest("table"));
  // The swap can still change the document's height - a row that really did appear or go away. This whole rebuild is
  // one synchronous step, so a scroll that moved under it is the browser clamping (near the bottom, a shorter page
  // pulls the reader up), never the reader scrolling away: put the page back where it was.
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  // A caller that replaced the project's section before calling us has already detached the box the reader was
  // typing in, so there was nothing left here to capture: it hands the caret in instead, and this puts it back into
  // the box we just rebuilt.
  if (typing) restoreTyping(tbody, typing);
  restoreScrolls(tbody, prevScrolls);
  applyStoredScrolls(tbody);
  settleScrolls(tbody);
  restoreCardSelection(heldSelection);
  scheduleBoardSweep(anchor);
  refreshAnchorBaseline();
  // This path rebuilds the table in ranked order, which is how a row most often changes place (a
  // project event or a snapshot). Without this the move was silent — the node was new, so nothing
  // remembered where it used to be.
  flashMovedByKey(prevRowKeys, [...tbody.children].filter((el) => el.classList.contains("row")), tbody);
  // …and the ⟳'s offer card was a child of this tbody too. It lives in state, so put it back under its row instead of
  // letting a repaint answer the question for the reader.
  paintRefreshOffers(name);
}

// Header summary. The project count is the live one — what the table is actually showing — not
// the configured fallback list the server reports before discovery has run.
function paintConfigLine() {
  const cfg = state.settings || {};
  if (cfg.host === undefined) return;
  const n = state.projects.size || (Array.isArray(cfg.projects) ? cfg.projects.length : 0);
  const scope = cfg.scanMode === "visible" ? " · refresh on screen only" : "";
  $("config-line").textContent = `${cfg.version ? `v${cfg.version} · ` : ""}${n} project(s) · cheap fields every ${cfg.worktreeSeconds}s · verdict/PR every ${cfg.slowSeconds}s · ${cfg.threads} scan threads · ${cfg.host}${scope}`;
}

function renderAll() {
  // A full re-render rebuilds the chips from scratch; the job list is the freshest input.
  const anchor = captureBoardAnchor();
  // The whole board is replaced below, one project tbody at a time. Hold the page position across it: a layout that
  // happens while part of the board is missing clamps a reader parked near the bottom up the page, and the height
  // coming back does not bring their scroll with it.
  const pageY = window.scrollY;
  // The replacement takes every card off the page, so the caret is read here, before it is gone, and put back at the
  // end - a snapshot repaint must not end a sentence the reader is in the middle of.
  const typingBoard = captureTyping($("projects"));
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
  // Every card on the board is about to be replaced with a fresh node, so the consoles inside them go to their first
  // line. Remember where each one stood, by its own id: the rebuild's own restore (applyStoredScrolls) reads this map,
  // and it has nothing to read when the console was never scrolled by a reader since the card appeared.
  for (const o of $("projects").querySelectorAll("pre.job-out")) {
    state.outScrolls[o.dataset.out] = {
      top: o.scrollTop,
      atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32,
    };
  }
  // Every card and the inline add-agent field leave the page here; bracketed so their blur is not read as the reader
  // walking away. Both are put back below.
  beginDomMove();
  $("projects").innerHTML =
    [...groups.entries()]
      .sort((a, b) => projectActivity(b[1][0]) - projectActivity(a[1][0]) || a[0].localeCompare(b[0]))
      .map(([root, list]) => rootSection(root, list))
      .join("") || '<p class="empty">No git repos found under scanRoots.</p>';
  // Every tbody on the page was just replaced, so an open confirmation row is detached now. Forget it
  // here: renderProjectRows would otherwise re-insert the old node into a fresh table.
  for (const el of state.confirmEls.values()) el.remove();
  state.confirmEls.clear();
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
  // `state.detailEls` is deliberately NOT cleared. renderProjectRows() asks it for the cards each rebuilt detail has to
  // reuse, and those cards carry the consoles themselves: handing them over is a MOVE of the node, so the reader's
  // scroll position comes with it. Clearing the map here rebuilt every card from scratch - the one board-wide path
  // that could still put a live console back on its first line - while its neighbours kept their place.
  for (const k of [...state.detailEls.keys()]) if (!state.rows.has(k)) state.detailEls.delete(k);
  for (const p of projects) {
    const tbody = document.querySelector(`[data-tbody="${CSS.escape(p.name)}"]`);
    if (tbody) state.tbodyEls.set(p.name, tbody);
    renderProjectRows(p.name);
    refreshChips(p.name);
  }
  // The caret read before the replacement: put it back in the box this rebuild made for it.
  if (typingBoard) restoreTyping($("projects"), typingBoard);
  restoreAddAgent($("projects"));
  endDomMove();
  paintConfigLine();
  paintCollapseAll();
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  scheduleBoardSweep(anchor);
  refreshAnchorBaseline();
  // A rebuild recreates the sections, so every folder's filter has to be re-applied to the new nodes.
  for (const g of $("projects").querySelectorAll("section.root-group")) applyRootFilter(g.dataset.root);
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
  // The panel's own two folders and their sizes. A snapshot is the only thing that carries them, so the Settings
  // row repaints from here as well as from its own presses — the clean's answer, a boot that migrated, a job event.
  if (data.paths) {
    state.paths = data.paths;
    paintPaths();
  }
  if (data.hosts) state.hosts = data.hosts;
  if (Array.isArray(data.scanRoots)) state.scanRoots = data.scanRoots;
  if (data.spawn) {
    state.spawn = data.spawn;
    const t = data.spawn.transport || {};
    const caps = t.capabilities || {};
    const reasoning = $("job-reasoning");
    if (reasoning) {
      reasoning.disabled = !t.reachable || caps.modelOptions !== true;
      reasoning.title = reasoning.disabled
        ? "Per-agent reasoning is unavailable: the gateway must advertise model_options and the panel must support it. Restart the panel after updating it."
        : "Per-agent reasoning effort; replies keep this choice. Default uses Hermes settings. Models may map unsupported levels to their nearest supported level.";
    }
    $("chip-key").textContent = t.reachable ? `api: up${caps.steer ? " · steer" : ""}` : "api: down";
    $("chip-key").title = t.error || `${t.url || ""}${caps.version ? ` · hermes ${caps.version}` : ""}`;
    $("chip-bin").textContent = String(t.url || "").replace(/^https?:\/\//, "") || "no gateway";
    $("chip-bin").title = caps.runCwd
      ? "the gateway advertises per-run cwd — measured 2026-10-27: it is accepted, and a run's tools still start in the gateway's directory, so the prompt carries the path too"
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
  // The panel's own permission requests travel with the snapshot like the CLI-transport approvals: a reload comes
  // back to the same open question (a push still parked on an answer) rather than losing it.
  if (data.remoteWrites) applyRemoteWrites(data.remoteWrites);
  // The assistant's scratchpad, alerts and thread id travel with the snapshot (assistant.js owns the panel).
  if (data.assistant && typeof applyAssistant === "function") applyAssistant(data.assistant);
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
    // A project's own activityAt seeds its window once, so the folder order is smoothed from the first paint.
    seedProjectRank(p);
    const wts = Array.isArray(p.worktrees) ? p.worktrees : [];
    if (!wts.length) continue;
    for (const [k, r] of [...state.rows]) if (r.project === p.name) state.rows.delete(k);
    for (const w of wts) {
      const row = { ...w, project: p.name };
      state.rows.set(keyOf(p.name, w.path), row);
      noteScan(row);
      // Seed the ranking windows from the life the row already carries, so the first paint is smoothed.
      seedRankWindows(row);
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

// The two read-now gestures (Settings → Board → Read now). Both routes answer at once and do their work behind the
// request — a fast pass re-reads the rows, a fetch spawns git and then re-reads — and neither moves anything on
// screen until a read comes back. Over rows that already match, that made a click look ignored, so each gesture now
// says in the banner what it started and how much it covers.
async function readNow(route, note) {
  let message = "";
  try {
    const r = await apiFetch(route, { method: "POST" });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `the panel answered ${r.status}`);
    }
    message = note();
  } catch (e) {
    showBanner(`${route}: ${e.message}`);
    await resync();
    return;
  }
  // The note goes up AFTER the resync: applySnapshot hides the banner as its last act (a snapshot means the board
  // is healthy), so a note written before it would be wiped by the same click that asked for it.
  await resync();
  showNote(message);
}

$("btn-refresh").addEventListener("click", () =>
  readNow("/api/refresh", () => {
    const inView = state.settings?.scanMode === "visible" ? new Set(visibleProjects()) : null;
    const rows = [...state.rows.values()].filter((row) => !inView || inView.has(row.project));
    return `refresh now: re-reading ${rows.length} row${rows.length === 1 ? "" : "s"}${inView ? " in view" : ""} — each one repaints as its read lands`;
  }),
);
$("btn-reset-colors").addEventListener("click", () => {
  const n = state.projectHues.size;
  state.projectHues.clear();
  saveProjectHues();
  for (const sec of document.querySelectorAll("section.project.has-hue")) {
    sec.classList.remove("has-hue");
    sec.style.removeProperty("--proj-hue");
    const head = sec.querySelector(".project-head[data-toggle-project]");
    if (head) head.title = headTitle(sec.dataset.project);
  }
  updateColorsRow();
  showBanner(n ? `project colours cleared (${n} project${n === 1 ? "" : "s"})` : "no project colours to clear");
});
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
$("btn-fetch").addEventListener("click", () =>
  readNow("/api/fetch", () => {
    const n = [...state.projects.values()].filter((p) => p.remote).length;
    return `fetch remotes: git fetch --prune in ${n} project${n === 1 ? "" : "s"} — rows update as each fetch lands`;
  }),
);
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
const THINK_ZOOM_MIN = 8;
const THINK_ZOOM_MAX = 22;

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

// The same gesture over a thinking body: reasoning text has its own size (11.5px by default) and its own var, so
// zooming it never moves the console's text.
function zoomThink(body, step) {
  const card = body.closest(".job");
  const thread = card && card.dataset.thread;
  if (!thread) return;
  const block = body.querySelector(".think-block") || body;
  const base = Number(state.thinkZoom.get(thread)) || parseFloat(getComputedStyle(block).fontSize) || 11.5;
  const next = Math.min(THINK_ZOOM_MAX, Math.max(THINK_ZOOM_MIN, Math.round((base + step) * 2) / 2));
  state.thinkZoom.set(thread, next);
  card.style.setProperty("--think-size", `${next}px`);
}

// Ctrl+wheel over a console must not ALSO zoom the window. Cancel it at the earliest point in the event's path
// (capture on window) and stop it there, so neither the page's own listeners nor anything above them sees a
// cancellable wheel: a passive listener anywhere in the path - the panel has one on document for pendingFocus -
// can otherwise leave the browser free to run its zoom gesture.
const onConsoleWheel = (e) => {
  if (!e.ctrlKey) return;
  const target = e.target && e.target.closest ? e.target : null;
  const out = target ? target.closest(".job-out") : null;
  const think = !out && target ? target.closest(".think-body") : null;
  if (!out && !think) return;
  if (e.cancelable) e.preventDefault();
  e.stopPropagation();
  if (out) zoomConsole(out, e.deltaY < 0 ? 1 : -1);
  else zoomThink(think, e.deltaY < 0 ? 1 : -1);
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

// A TODO item's disclosure is a pointer gesture, not a place to put the caret. The item being edited keeps its edit
// box open right above the facts, and a plain button's mousedown would blur it (and take the caret mid-word); the
// click still fires — only the focus/selection default is cancelled — and Tab + Enter/Space still reach the control.
document.addEventListener("mousedown", (e) => {
  if (e.target.closest?.("[data-toggle-todo-facts]")) e.preventDefault();
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
  // Up/Down walk what you have already spawned, shell style. Only from the very start (Up) or the very end
  // (Down) of the TEXT — measured the way readBox measures it, so a chip counts as the text it swallowed
  // and the caret keeps moving with it.
  const box = e.target;
  const boxText = readBox(box);
  const at = caretOffset(box);
  if (e.key === "ArrowUp" && !e.shiftKey) {
    // A single-line prompt walks history from anywhere (that is shell behaviour, and the caret sits at
    // the END after typing). A multi-line prompt only walks when the caret is already at the start, so
    // Up still moves between its lines first.
    const singleLine = !boxText.includes("\n");
    const atStart = at === 0;
    if (singleLine || atStart || !boxText) {
      if (recallSpawnPrompt(1)) {
        e.preventDefault();
        return;
      }
    }
  }
  if (e.key === "ArrowDown" && !e.shiftKey) {
    const singleLine = !boxText.includes("\n");
    const atEnd = at >= boxText.length;
    if (singleLine || atEnd) {
      if (recallSpawnPrompt(-1)) {
        e.preventDefault();
        return;
      }
    }
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
  e.stopPropagation();
  // Shift+Enter is a newline: a prompt is often more than one line. It is inserted AT THE CARET, which is
  // the only way a contenteditable host can be given one.
  if (e.shiftKey) {
    insertNewlineAtCaret(e.target);
    return;
  }
  if (!$("btn-spawn").disabled) spawnAgent();
});

// Typing ends the history walk, so the next Up starts from whatever is in the box now.
$("job-prompt").addEventListener("input", () => {
  if (state.spawnNav) state.spawnNav = { back: 0, stash: readBox($("job-prompt")) };
});
// A chip-bearing draft this tab mirrored before a reload comes back into the box it belongs to (#job-prompt is
// static markup, so it is restored once, here, not by any render path — the reply boxes restore themselves
// through restoreTyping, and the assistant's intro box through its own render).
restoreChipBoxes(document);
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
  // The held reply's editor, its own three controls first, so a press inside the editor is never read as a fold, a
  // send or a click away from itself: clicking the held text opens it, Save writes the edit back to that one entry,
  // Cancel leaves that entry exactly as it was. None of the three sends anything.
  const editSave = e.target.closest?.("[data-edit-save]");
  if (editSave) {
    e.preventDefault();
    e.stopPropagation();
    saveQueuedEdit(editSave.dataset.editThread, Number(editSave.dataset.editSave) || 0);
    return;
  }
  const editCancel = e.target.closest?.("[data-edit-cancel]");
  if (editCancel) {
    e.preventDefault();
    e.stopPropagation();
    cancelQueuedEdit(editCancel.dataset.editThread, Number(editCancel.dataset.editCancel) || 0);
    return;
  }
  // The held reply's text is the handle. A click on a link inside it still opens the link.
  const editOpen = e.target.closest?.("[data-edit-queued-open]");
  if (editOpen && !e.target.closest("a[data-open-url]")) {
    e.preventDefault();
    e.stopPropagation();
    openQueuedEdit(editOpen.dataset.editThread, Number(editOpen.dataset.editQueuedOpen) || 0);
    return;
  }
  // Clicking away from an open editor means REVERT, every time — the same one thing Escape means. Asked here, before
  // any branch below can return, so a click on the card head, on another held reply or on empty page all mean it too.
  revertEditOnClickAway(e.target);
  // The context readout right of the model: one click moves the session's ceiling to the next size.
  const ctxPick = e.target.closest?.("[data-context-pick]");
  if (ctxPick) {
    e.preventDefault();
    e.stopPropagation();
    void cycleContext(ctxPick.dataset.contextPick);
    return;
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
    const kind = artBtn.dataset.artifactsKind === "url" ? "url" : "file";
    const pop = document.querySelector(
      `[data-artifacts-pop="${CSS.escape(thread)}"][data-artifacts-kind="${kind}"]`,
    );
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
        state.openArtifacts.set(thread, { left, top, kind });
      }
    }
    return;
  }
  // The row's own ⟳ re-reads this one worktree (git facts, TODO reconcile, description, journal) and may offer the
  // double-check agent as one card under the row.
  const childTree = e.target.closest("[data-child-tree]");
  if (childTree) {
    e.preventDefault();
    void cutChildTree(childTree);
    return;
  }
  const refreshTree = e.target.closest("[data-refresh-tree]");
  if (refreshTree) {
    e.preventDefault();
    e.stopPropagation();
    void refreshTreeRow(refreshTree);
    return;
  }
  const refreshOfferYes = e.target.closest("[data-refresh-offer-yes]");
  if (refreshOfferYes) {
    e.preventDefault();
    e.stopPropagation();
    void startRefreshAgentFromCard(refreshOfferYes);
    return;
  }
  const refreshOfferNo = e.target.closest("[data-refresh-offer-no]");
  if (refreshOfferNo) {
    e.preventDefault();
    e.stopPropagation();
    clearRefreshOffer(refreshOfferNo.dataset.refreshOfferNo);
    return;
  }
  const delTree = e.target.closest("[data-del-tree]");
  if (delTree) {
    e.preventDefault();
    e.stopPropagation();
    const key = delTree.dataset.delTree;
    // Merged and clean: nothing here that main does not already have, so no question. A locked row never gets here
    // (deletableWithoutAsking says no) — it goes to showWorktreeConfirm, which shows the refusal instead.
    if (deletableWithoutAsking(key)) void confirmDeleteWorktree(key);
    else showWorktreeConfirm(key);
    return;
  }
  // The reader's lock: one press per scope, and the row repaints from the snapshot the server broadcasts. The button
  // is answered on the release for the same reason the delete is — the board re-ranks rows under the cursor.
  const lockBtn = e.target.closest("[data-lock-scope]");
  if (lockBtn) {
    e.preventDefault();
    e.stopPropagation();
    void toggleWorktreeLock(lockBtn.dataset.lockScope === "branch" ? "branch" : "tree", lockBtn.dataset.lockTree);
    return;
  }
  const renameTree = e.target.closest("[data-rename-tree]");
  if (renameTree) {
    e.preventDefault();
    e.stopPropagation();
    void renameWorktreePrompt(renameTree);
    return;
  }
  // ✦: ask the work what this tree should be called. Nothing is renamed here — the question that comes back is
  // answered on its own buttons, on the release (see answerNameConfirm).
  const nameTree = e.target.closest("[data-name-tree]");
  if (nameTree) {
    e.preventDefault();
    e.stopPropagation();
    void suggestTreeName(nameTree);
    return;
  }
  const nameTreeYes = e.target.closest("[data-name-tree-yes]");
  if (nameTreeYes) {
    e.preventDefault();
    e.stopPropagation();
    answerNameConfirm("yes", nameTreeYes.dataset.nameTreeYes);
    return;
  }
  const nameTreeNo = e.target.closest("[data-name-tree-no]");
  if (nameTreeNo) {
    e.preventDefault();
    e.stopPropagation();
    answerNameConfirm("no", nameTreeNo.dataset.nameTreeNo);
    return;
  }
  const nameTreeEdit = e.target.closest("[data-name-tree-edit]");
  if (nameTreeEdit) {
    e.preventDefault();
    e.stopPropagation();
    answerNameConfirm("edit", nameTreeEdit.dataset.nameTreeEdit);
    return;
  }
  const delTreeYes = e.target.closest("[data-del-tree-yes]");
  if (delTreeYes) {
    e.preventDefault();
    e.stopPropagation();
    answerRowConfirm("yes", delTreeYes.dataset.delTreeYes);
    return;
  }
  const delTreeNo = e.target.closest("[data-del-tree-no]");
  if (delTreeNo) {
    e.preventDefault();
    e.stopPropagation();
    answerRowConfirm("no", delTreeNo.dataset.delTreeNo);
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
  // The host chip and its Discover strip. The chip sits inside the project header, whose click toggles the section,
  // so every one of these stops propagation — pressing "host: sefl-bitbucket" must not also collapse the project.
  const rhost = e.target.closest("[data-host-project]");
  if (rhost) {
    e.stopPropagation();
    e.preventDefault();
    void proposeHostMapping(rhost.dataset.hostProject);
    return;
  }
  const rhsave = e.target.closest("[data-host-save]");
  if (rhsave) {
    e.stopPropagation();
    e.preventDefault();
    void saveHostMapping(rhsave.dataset.hostSave);
    return;
  }
  const rhcancel = e.target.closest("[data-host-cancel]");
  if (rhcancel) {
    e.stopPropagation();
    e.preventDefault();
    state.hostPanel = null;
    repaintHostPanel(rhcancel.dataset.hostCancel);
    return;
  }
  // The clear button inside the folder search box: restore the full list and put the caret back.
  const searchClear = e.target.closest?.("[data-root-search-clear]");
  if (searchClear) {
    e.preventDefault();
    e.stopPropagation();
    const root = searchClear.dataset.rootSearchClear;
    const box = document.querySelector(`[data-root-search="${CSS.escape(root)}"]`);
    if (box) {
      box.value = "";
      box.focus();
    }
    setRootFilter(root, "");
    return;
  }
  // The search box lives in the folder head; a click in it is the reader typing, not a request to fold
  // the folder under the caret.
  if (e.target.closest?.(".root-filter")) return;
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
    // Ctrl+click themes the box instead of folding it, so a colour is one gesture away and cannot be
    // mistaken for the open/close click. Shift drops the colour again.
    if ((e.ctrlKey || e.metaKey) && !e.target.closest("button, input, select, textarea, a, label")) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        state.projectHues.delete(name);
        saveProjectHues();
        applyProjectHue(name);
        showBanner(`${name}: colour cleared`);
      } else {
        const hue = rollProjectHue(name);
        applyProjectHue(name);
        showBanner(`${name}: themed hue ${hue}° — Ctrl+click again for another, Ctrl+Shift+click to clear`);
      }
      return;
    }
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
  // The row's green ▶: probe every NOT-RUNNING agent in that worktree with the continue sentence.
  const rowAgent = e.target.closest(".btn-row-agent");
  if (rowAgent) {
    e.stopPropagation();
    e.preventDefault();
    void probeWorktreeAgents(rowAgent.dataset.agentPath || "", rowAgent);
    return;
  }
  // The + bar under a row's agents: start a new agent in this worktree. This is what the ▶ used to do.
  // The green + bar: it becomes a text field in place. The field itself carries the same data attributes, so this
  // matches the button only - a click inside the input must not re-open it.
  const addAgent = e.target.closest("button.btn-add-agent");
  if (addAgent) {
    e.stopPropagation();
    e.preventDefault();
    openAddAgent(addAgent);
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
  // The dock's own fold control.
  const dockFold = e.target.closest("#btn-dock-approvals");
  if (dockFold) {
    e.preventDefault();
    e.stopPropagation();
    try {
      localStorage.setItem(APPROVALS_FOLDED_KEY, approvalsFolded() ? "0" : "1");
    } catch {
      /* private mode: the fold still works, it just does not survive a reload */
    }
    applyApprovalsFold();
    return;
  }
  // "waiting on your answer →" on an agent card: take the reader to the question box in that card, unfolding
  // the card first if they had minimised it (a folded card renders no turn body, so there is nothing to jump to).
  const qJump = e.target.closest("[data-question-jump]");
  if (qJump) {
    e.preventDefault();
    e.stopPropagation();
    const thread = qJump.dataset.questionJump;
    if (state.collapsedJobs.has(thread)) {
      state.collapsedJobs.delete(thread);
      renderConversation(thread);
    }
    const box = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] .turn-question`);
    if (box) {
      box.scrollIntoView({ block: "center", behavior: "smooth" });
      box.classList.add("jump");
      setTimeout(() => box.classList.remove("jump"), 1600);
    }
    return;
  }
  // "waiting on you →" on an agent card: take the reader to the approval that is blocking it. The dock is fixed,
  // so this unfolds it and scrolls its own list — scrollIntoView on a fixed element only moves the page.
  const apJump = e.target.closest("[data-approval-jump]");
  if (apJump) {
    e.preventDefault();
    e.stopPropagation();
    const dock = $("approvals");
    try {
      localStorage.setItem(APPROVALS_FOLDED_KEY, "0");
    } catch {
      /* the jump still happens */
    }
    applyApprovalsFold(dock);
    const card = document.querySelector(`.approval[data-approval="${CSS.escape(apJump.dataset.approvalJump)}"]`);
    if (card) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
  // Only the Send reply button: the Steer turn button wears .btn-reply too, and this branch used to answer its
  // click with sendReply(undefined) - which looks for a box for the thread "undefined" and quietly does nothing,
  // so the button was dead and its own branch below was unreachable.
  const replyBtn = e.target.closest(".btn-reply[data-thread]");
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
  // What this branch was started to do folds like the two strips below it, except that its UNFOLDED state is
  // REMEMBERED (localStorage, `wm.openDescs`): the block starts folded, so the remembering is what keeps a reader's
  // opened rows open across a reload. Folded, it keeps its first bullet to the right of the header the way the other
  // two strips keep their first line.
  const descToggle = e.target.closest("[data-toggle-desc]");
  if (descToggle) {
    e.preventDefault();
    e.stopPropagation();
    const key = descToggle.dataset.toggleDesc;
    const block = document.querySelector(`[data-desc-block="${CSS.escape(key)}"]`);
    if (block) {
      const open = state.openDescs.has(key);
      if (open) state.openDescs.delete(key);
      else state.openDescs.add(key);
      saveOpenDescs();
      block.classList.toggle("collapsed", open);
      const chev = descToggle.querySelector(".chev");
      if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
      let first = descToggle.querySelector(".desc-first");
      const lead = block.querySelector(".desc-body li");
      if (open) {
        if (!first && lead) {
          first = document.createElement("span");
          first.className = "desc-first mono";
          first.textContent = lead.textContent;
          first.title = lead.textContent;
          descToggle.appendChild(first);
        }
      } else if (first) {
        first.remove();
      }
      descToggle.title = `${open ? "unfold" : "fold"} what this branch was started to do`;
    }
    return;
  }
  // The TODO section folds like the strips around it, and its unfold is REMEMBERED (localStorage, `wm.openTodos`) —
  // the section starts folded, so the remembering is what keeps a reader's opened rows open across a reload. The head
  // is a <button>, so this also runs on Enter/Space; nothing else in the row is rebuilt.
  const todoToggle = e.target.closest("[data-toggle-todo]");
  if (todoToggle) {
    e.preventDefault();
    e.stopPropagation();
    const key = todoToggle.dataset.toggleTodo;
    const block = document.querySelector(`[data-todo-block="${CSS.escape(key)}"]`);
    if (block) {
      const open = state.todoOpen.has(key);
      if (open) state.todoOpen.delete(key);
      else state.todoOpen.add(key);
      saveOpenTodos();
      block.classList.toggle("collapsed", open);
      const chev = todoToggle.querySelector(".chev");
      if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
      todoToggle.setAttribute("aria-expanded", open ? "false" : "true");
      let first = todoToggle.querySelector(".todo-first");
      if (open) {
        // Folded again: the OLDEST item still open goes back on the head line (never the last one that moved).
        if (!first) {
          first = document.createElement("span");
          first.className = "todo-first mono";
          todoToggle.appendChild(first);
        }
        first.textContent = todoPeekFor(key);
        first.title = first.textContent;
      } else if (first) {
        first.remove();
      }
      todoToggle.title = `${open ? "unfold" : "fold"} this worktree's TODO list — folded it reads the OLDEST item still open`;
    }
    return;
  }
  // One item's fact bullets: a disclosure of its own, and a class flip rather than a repaint — so nothing else in the
  // block moves, an item the reader is editing keeps its caret, and the toggle never reaches the row's own fold (the
  // row ignores clicks on a <button> anyway, and this stops the event here as well). The control is a real <button>,
  // so Tab reaches it and Enter/Space fire this same click. Remembered per worktree + item, never defaulted open.
  const factsToggle = e.target.closest?.("[data-toggle-todo-facts]");
  if (factsToggle) {
    e.preventDefault();
    e.stopPropagation();
    const key = String(factsToggle.dataset.todoKey || "");
    const id = String(factsToggle.dataset.toggleTodoFacts || "");
    const factsKey = `${key}::${id}`;
    const item = factsToggle.closest(".todo-item");
    const open = state.todoFactsOpen.has(factsKey);
    if (open) state.todoFactsOpen.delete(factsKey);
    else state.todoFactsOpen.add(factsKey);
    saveOpenTodoFacts();
    item?.classList.toggle("collapsed", open);
    const chev = factsToggle.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
    factsToggle.setAttribute("aria-expanded", open ? "false" : "true");
    factsToggle.setAttribute("aria-label", `${open ? "show" : "hide"} the facts for TODO #${id}`);
    factsToggle.title = `${open ? "show" : "hide"} what the panel knows about TODO #${id} — its owner, who touched it and when`;
    return;
  }
  // The reader's own buttons on a TODO item: add, edit, complete, drop, reopen. Every one of them is a POST to
  // /api/todos stamped `by: "reader"`, and a refusal (an id that is not in the list, empty text) comes back as a
  // banner rather than as a press that silently did nothing.
  const todoBtn = e.target.closest("[data-todo-op]");
  if (todoBtn) {
    e.preventDefault();
    e.stopPropagation();
    const op = String(todoBtn.dataset.todoOp || "");
    const key = String(todoBtn.dataset.todoKey || "");
    const cut = key.indexOf("::");
    const project = cut < 0 ? key : key.slice(0, cut);
    const path = cut < 0 ? "" : key.slice(cut + 2);
    const id = todoBtn.dataset.todoId ? Number(todoBtn.dataset.todoId) : null;
    const block = document.querySelector(`[data-todo-block="${CSS.escape(key)}"]`);
    const draftText = () => String(block?.querySelector(".todo-edit, .todo-add-input")?.value ?? "").trim();
    if (op === "add-start" || op === "edit-start") {
      const row = state.rows.get(key);
      const item = op === "edit-start" ? (row?.todo?.items || []).find((i) => Number(i.id) === id) : null;
      state.todoDraft = { key, id: op === "edit-start" ? id : null, text: item?.text || "" };
      if (!state.todoOpen.has(key)) {
        state.todoOpen.add(key);
        saveOpenTodos();
      }
      repaintTodoBlock(key);
      return;
    }
    if (op === "add-cancel" || op === "edit-cancel") {
      state.todoDraft = null;
      repaintTodoBlock(key);
      return;
    }
    if (op === "add-save" || op === "edit-save") {
      const text = draftText();
      if (!text) {
        showBanner("a TODO item needs some text");
        return;
      }
      state.todoDraft = null;
      void todoPost({ project, path, op: op === "add-save" ? "add" : "edit", id: op === "add-save" ? null : id, text });
      return;
    }
    void todoPost({ project, path, op, id });
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
  // The Modified / Untracked strips inside merge state fold on their own: each flips just its own class and its own
  // chevron, so one opens without touching the merge state strip around it or its sibling, and nothing in the row
  // is rebuilt (which would cost the agent cards their consoles and the reader their scroll position).
  const subToggle = e.target.closest("[data-toggle-git-sub]");
  if (subToggle) {
    e.preventDefault();
    e.stopPropagation();
    const subKey = subToggle.dataset.toggleGitSub;
    const sub = document.querySelector(`[data-git-sub="${CSS.escape(subKey)}"]`);
    if (sub) {
      const open = state.gitSubOpen.has(subKey);
      if (open) state.gitSubOpen.delete(subKey);
      else state.gitSubOpen.add(subKey);
      sub.classList.toggle("collapsed", open);
      const chev = subToggle.querySelector(".chev");
      if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
      subToggle.title = `${open ? "unfold" : "fold"} the ${subKey.endsWith("::modified") ? "changed" : "untracked"} files`;
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
  // The not-running pill on a stopped card, which is the continue button: send the canned nudge and start the next
  // turn. It is a <button>, so the fold handler below would leave it alone anyway - this stops the click at the
  // control even if the pill is later drawn as something else.
  const continueBtn = e.target.closest("[data-continue-thread]");
  if (continueBtn) {
    e.preventDefault();
    e.stopPropagation();
    void continueThread(continueBtn.dataset.continueThread || "", continueBtn);
    return;
  }
  // The COMPLETE chip, on a card whose latest turn is done: queue one ask for the board assistant and send nothing to
  // the agent. Its own hook (`data-complete-ask`), so it can never fall into the continue branch above.
  const completeBtn = e.target.closest("[data-complete-ask]");
  if (completeBtn) {
    e.preventDefault();
    e.stopPropagation();
    void askComplete(completeBtn);
    return;
  }
  // The re-attach pill: ask the gateway about this one card's run and let the panel take the same decision its boot
  // reconcile takes. Nothing is drawn from the response — the decision emits the job events the card is repainted
  // from — so the press is answered in words, and a refusal says why instead of leaving a pill that looks broken.
  const reattachBtn = e.target.closest("[data-reattach-job]");
  if (reattachBtn) {
    e.preventDefault();
    e.stopPropagation();
    void reattachCard(reattachBtn);
    return;
  }
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
  // The × on a queued entry: take that ONE entry back, by its own identity. Nothing is sent, nothing is
  // steered, and no other held reply on the thread is touched.
  const queueCancel = e.target.closest("[data-queue-cancel]");
  if (queueCancel) {
    e.preventDefault();
    e.stopPropagation();
    cancelQueuedReply(queueCancel.dataset.queueCancel, Number(queueCancel.dataset.queueCancelAt) || 0);
    return;
  }
  // Queue reply: hold the text (do not send) because a turn is running on this thread.
  const queueBtn = e.target.closest("[data-queue-reply]");
  if (queueBtn) {
    e.preventDefault();
    e.stopPropagation();
    // The same press Ctrl/Cmd+Enter makes: one function, so the button and the keystroke cannot drift apart.
    queueReplyFromBox(queueBtn.dataset.queueReply);
    return;
  }
  // Answer an approval a run is parked on. The buttons come from the host's own choice list.
  const approveBtn = e.target.closest("[data-approve]");
  if (approveBtn) {
    e.preventDefault();
    e.stopPropagation();
    void answerRunApproval(approveBtn);
    return;
  }
  // Send what the question box holds: a typed answer wins (that is the tool's "Other"), otherwise the
  // ticked choices go back as one array — the clarify tool decodes it as a multi-select answer.
  const qSend = e.target.closest("[data-qsend]");
  if (qSend) {
    e.preventDefault();
    e.stopPropagation();
    const turnId = qSend.dataset.qsend;
    const copy = qSend.dataset.qcopy || "";
    const box = qSend.closest(".turn-question");
    const typed = (box?.querySelector(".tq-other")?.value || "").trim();
    if (typed) {
      void answerRunQuestion(turnId, typed, qSend.dataset.qrequest, box);
      return;
    }
    const labels = [...(box?.querySelectorAll(".tq-choice[data-qvalue]") || [])].map((el) => el.dataset.qvalue);
    const picked = [...(questionPicks.get(`${turnId}${copy}`) || new Set())].sort((a, b) => a - b).map((i) => labels[i]).filter(Boolean);
    if (!picked.length) {
      const warn = box?.querySelector("[data-qwarn]");
      if (warn) warn.textContent = "pick an answer, or type one";
      return;
    }
    void answerRunQuestion(turnId, picked, qSend.dataset.qrequest, box);
    return;
  }
  // The panel's own fold: the card kept a result's head, and this is the reader asking for the rest of it. The
  // click reads ONE row out of the session store (whole, uncapped) and the burst is redrawn with it — nothing
  // goes into the job's lines, so the console's 600-line ring buffer is not what holds a 5,000-line result.
  const foldRead = e.target.closest("[data-tool-fold]");
  if (foldRead) {
    e.preventDefault();
    e.stopPropagation();
    void expandToolFold(foldRead);
    return;
  }
  // A row of the stream's tool-usage group: the call's own line, and the handle for the box that call returned. The
  // box starts shut (a burst of five calls reads as five rows), so a press opens it in place — no rebuild, nothing
  // else on the card moving — and opening it also asks the session store for the result, because the live preview
  // for a call is routinely empty and the row would otherwise open onto "no output in the session store yet".
  const usageRow = e.target.closest("[data-tgrp-call]");
  if (usageRow) {
    const block = usageRow.closest(".tgrp-call");
    const boxEl = block && block.querySelector(":scope > .tgrp-out");
    const key = usageRow.dataset.tgrpCall || "";
    // A press that was the end of a drag-select is a selection, not a fold (the rule a call block's caret follows).
    const picked = document.getSelection ? document.getSelection() : null;
    if (picked && !picked.isCollapsed && block && picked.containsNode && picked.containsNode(block, true)) return;
    if (boxEl && key) {
      e.preventDefault();
      e.stopPropagation();
      const open = boxEl.hidden;
      if (open) holdConsoleFor(usageRow);
      boxEl.hidden = !open;
      block.classList.toggle("is-open", open);
      usageRow.setAttribute("aria-expanded", open ? "true" : "false");
      usageRow.title = `${open ? "hide" : "show"} what ${usageRow.dataset.callTool || "this call"} returned`;
      if (open) state.callOpen.add(key);
      else state.callOpen.delete(key);
      // One entry per row the reader ever opened; a long-lived tab should not keep every one of them forever.
      while (state.callOpen.size > 500) state.callOpen.delete(state.callOpen.values().next().value);
      if (open) {
        // The row IS its box's opener. What sits behind a row is a console box like any other — folded, with its own
        // "click to read" — because the box is the same one the condensed view draws, and a reader who opened the row
        // asked to see what the call returned, not for a second thing to click. So the box's own book is written here
        // as if its header had been pressed: one action, one box, and the box's header still folds it on its own.
        for (const head of boxEl.querySelectorAll("[data-code-fold][data-code-key]")) {
          const book = head.dataset.codeInverted === "1" ? state.codeBoxShut : state.codeBoxOpen;
          if (head.dataset.codeInverted === "1") book.delete(head.dataset.codeKey);
          else book.add(head.dataset.codeKey);
          const inner = head.parentElement && head.parentElement.querySelector(":scope > .code-body");
          if (inner) inner.hidden = false;
          if (head.parentElement) head.parentElement.classList.add("is-open");
          head.setAttribute("aria-expanded", "true");
          const caret = head.querySelector(".code-caret");
          if (caret) caret.textContent = "\u25be";
          const hint = head.querySelector(".code-hint");
          if (hint) hint.textContent = "click to fold";
        }
        const grp = block.closest(".tgrp");
        const turnId = String(grp?.dataset.tgrp || "").split("#")[0];
        const tool = usageRow.dataset.callTool || "";
        if (grp && turnId && tool) void ensureToolStore(turnId, tool, grp);
      }
    }
    return;
  }
  // A tool call's own row: fold or unfold THAT call's output, and nothing else on the card. The caret is a real
  // button (Tab reaches it, Enter and Space press it, and it carries aria-expanded) and the row around it is the
  // same handle, so a press anywhere on the call line works. The press is stopped here so the burst's own row
  // handler and the reply box's gestures never see a fold as a click on them, and the copy button is a sibling of
  // this block rather than a child of it, so copying is not a fold.
  const callRow = e.target.closest("[data-call-fold], .call-head");
  if (callRow) {
    const call = callRow.closest(".call");
    const key = callRow.dataset.callKey || (call && call.dataset.callKey) || "";
    const body = call && call.querySelector(":scope > .call-body");
    // A press that was the end of a drag-select is a selection, not a fold: the reader who dragged across the
    // call's text gets the selection and the fold left alone. A plain click collapses the selection on mousedown,
    // so by the time it arrives here there is nothing to see.
    const sel = document.getSelection ? document.getSelection() : null;
    if (sel && !sel.isCollapsed && call && sel.containsNode && sel.containsNode(call, true)) return;
    if (body && key) {
      e.preventDefault();
      e.stopPropagation();
      const folded = !body.hidden;
      if (!folded) holdConsoleFor(callRow);
      body.hidden = folded;
      call.classList.toggle("is-folded", folded);
      const btn = call.querySelector("[data-call-fold]");
      if (btn) {
        btn.setAttribute("aria-expanded", folded ? "false" : "true");
        btn.textContent = folded ? "\u25b8" : "\u25be";
        btn.setAttribute("aria-label", `${folded ? "show" : "fold"} this call's output (${call.querySelector(".call-n")?.textContent || ""})`);
      }
      const hint = call.querySelector(".call-hint");
      if (hint) hint.hidden = !folded;
      const title = call.querySelector(".call-head");
      if (title) title.title = `${folded ? "show" : "fold"} this call's output`;
      if (folded) state.callFolded.add(key);
      else state.callFolded.delete(key);
      // One entry per call the reader ever folded; a long-lived tab should not keep every one of them forever.
      while (state.callFolded.size > 500) state.callFolded.delete(state.callFolded.values().next().value);
    }
    return;
  }
  // A result box inside a burst: a tool's output, folded until the reader asks for it. The fold is remembered by
  // key (the burst plus the segment), because every rebuild replaces this markup and a box that snapped shut under
  // the cursor would read as the panel losing the click. Which book it is written in depends on the box: every box
  // starts folded and the book holds the ones that were opened; the one drawn open because the reader asked for
  // it (data-code-inverted — the whole stored text a fold note reads) is the other way round.
  const codeFold = e.target.closest("[data-code-fold]");
  if (codeFold) {
    e.preventDefault();
    e.stopPropagation();
    const box = codeFold.closest(".code-box");
    const body = box && box.querySelector(".code-body");
    if (body) {
      const open = body.hidden;
      // Opening this result hands the console over: the view stays on the line the reader was reading, instead of
      // sliding to the bottom of the output that just unfolded (Settings > Agent cards, off by default).
      if (open) holdConsoleFor(codeFold);
      body.hidden = !open;
      box.classList.toggle("is-open", open);
      codeFold.setAttribute("aria-expanded", open ? "true" : "false");
      const caret = codeFold.querySelector(".code-caret");
      if (caret) caret.textContent = open ? "▾" : "▸";
      const hint = codeFold.querySelector(".code-hint");
      if (hint) hint.textContent = open ? "click to fold" : "click to read";
      const key = codeFold.dataset.codeKey || "";
      const book = codeFold.dataset.codeInverted === "1" ? state.codeBoxShut : state.codeBoxOpen;
      // Boxes that start folded remember the ones opened; boxes that start open remember the ones shut.
      if (open !== (codeFold.dataset.codeInverted === "1")) book.add(key);
      else book.delete(key);
      // A long-lived tab would otherwise keep one entry per box it ever opened.
      while (book.size > 500) book.delete(book.values().next().value);
    }
    return;
  }
  // The "+ N commands" tail of a batch: before the row handler, because the button lives inside that row.
  const batchBtn = e.target.closest("[data-batch-tool]");
  if (batchBtn) {
    e.preventDefault();
    e.stopPropagation();
    void loadBatchCalls(batchBtn);
    return;
  }
  // Steer the turn that is running: the primary action while the agent is busy.
  const tgrpRow = e.target.closest("[data-tgrp-tool]");
  if (tgrpRow) {
    e.preventDefault();
    e.stopPropagation();
    const grp = tgrpRow.closest(".tgrp");
    if (grp) {
      const tool = tgrpRow.dataset.tgrpTool;
      const active = grp.dataset.filter === tool;
      const key = grp.dataset.tgrp || "";
      // Read the identity and the console BEFORE the rebuild: `grp` is detached by it, and a turn drawn twice (the
      // pinned card and its paged copy) shares every key — the lookup has to stay in the console the reader clicked.
      const gstate = grp.dataset.gstate || "";
      const scope = grp.closest("pre.job-out") || document;
      if (!active) holdConsoleFor(tgrpRow);
      rebuildToolGroup(grp, { filter: active ? "" : tool, open: !active });
      if (!active) {
        // Opening a call asks for its stored output: the live stream's preview for this tool is routinely empty,
        // and a bare "↳ patch" header is exactly the report.
        const fresh = scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gstate)}"]`);
        void ensureToolStore(String(key).split("#")[0], tool, fresh);
      }
    }
    return;
  }
  const tgrpMore = e.target.closest("[data-tgrp-more]");
  if (tgrpMore) {
    e.preventDefault();
    e.stopPropagation();
    const grp = tgrpMore.closest(".tgrp");
    if (grp) {
      // "all N" while one tool is being shown clears the filter; otherwise it just folds the block.
      const filtered = Boolean(grp.dataset.filter);
      const bodyEl = grp.querySelector(".tgrp-body");
      const open = filtered || Boolean(bodyEl && bodyEl.hidden);
      const gstate = grp.dataset.gstate || "";
      const turnId = String(grp.dataset.tgrp || "").split("#")[0];
      const scope = grp.closest("pre.job-out") || document;
      if (open) holdConsoleFor(tgrpMore);
      rebuildToolGroup(grp, { filter: "", open });
      // Opening the whole run asks every tool's store, not only the one that was filtered: the reader opened this
      // to read what the calls returned.
      if (open) {
        const fresh = scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gstate)}"]`);
        if (fresh) for (const tool of burstStoreTools(groupLines(fresh))) void ensureToolStore(turnId, tool, fresh);
      }
    }
    return;
  }
  const toBottom = e.target.closest("[data-to-bottom]");
  if (toBottom) {
    e.preventDefault();
    e.stopPropagation();
    const box = toBottom.closest(".out-wrap")?.querySelector("pre.job-out, .think-body");
    if (box) {
      // Ask for the tail explicitly: the jump is the reader's, so the console must stop holding its old
      // position and follow the newest line again.
      if (box.matches("pre.job-out")) pinConsole(box.dataset.out);
      else state.thinkPinned.set(box.closest("details.think")?.dataset.thinkTurn || "", true);
      setScroll(box, box.scrollHeight);
      paintToBottom(box);
    }
    return;
  }
  const pinBtn = e.target.closest("[data-pin-thread]");
  if (pinBtn) {
    e.preventDefault();
    e.stopPropagation();
    toggleAnchorPin(pinBtn.dataset.pinThread);
    return;
  }
  const thinkBtn = e.target.closest("[data-think-thread]");
  if (thinkBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = thinkBtn.dataset.thinkThread;
    setThinking(thread, !thinkingOn(thread));
    return;
  }
  // The 🌊 beside it: the same press, a different choice — draw this card as one stream, or as it always was.
  const streamBtn = e.target.closest("[data-stream-thread]");
  if (streamBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = streamBtn.dataset.streamThread;
    setStreamMode(thread, !streamOn(thread));
    return;
  }
  const subsCollect = e.target.closest("[data-subs-collect]");
  if (subsCollect) {
    e.preventDefault();
    e.stopPropagation();
    const turn = [...state.jobs.values()].find((j) => j.id === subsCollect.dataset.subsCollect);
    if (turn) void collectThread(turn);
    return;
  }
  const subsHead = e.target.closest("[data-subs-toggle]");
  if (subsHead) {
    e.preventDefault();
    e.stopPropagation();
    toggleSubs(subsHead.dataset.subsToggle);
    return;
  }
  const subRow = e.target.closest("[data-sub-console]");
  if (subRow) {
    e.preventDefault();
    e.stopPropagation();
    await toggleSubConsole(subRow.dataset.subConsole);
    return;
  }
  const steerBtn = e.target.closest("[data-steer]");
  if (steerBtn) {
    e.preventDefault();
    e.stopPropagation();
    // The same press Ctrl/Cmd+Enter makes: one function, so the button and the keystroke cannot drift apart.
    await steerFromBox(steerBtn.closest(".job")?.dataset.thread || "", steerBtn.dataset.steer);
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
// Double-click, on its own listener: a single click on the readout must stay a single click.
document.addEventListener("dblclick", (e) => {
  const btn = e.target.closest?.("[data-model-pick]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  void openModelPop(btn.dataset.modelPick, btn);
});

// The reply and spawn boxes grow a line at a time as the draft gets longer.
document.addEventListener("input", (e) => {
  const box = e.target?.closest?.(".reply-box, #job-prompt");
  if (box) growReplyBox(box);
});

// A narrower window means fewer characters per line and more wrapped lines: re-measure what has content.
window.addEventListener("resize", () => {
  for (const box of document.querySelectorAll(".reply-box, #job-prompt")) {
    if (readBox(box)) growBoxToDraft(box, box.id === "job-prompt" ? SPAWN_MAX_LINES : REPLY_MAX_LINES);
  }
});

// Typing in a folder's search box filters that folder in place: no re-render, so the caret and the
// hidden projects' open state survive. Escape clears it and gives the keyboard back to the page.
document.addEventListener("input", (e) => {
  const box = e.target.closest?.("[data-root-search]");
  if (!box) return;
  setRootFilter(box.dataset.rootSearch, box.value);
});
document.addEventListener(
  "keydown",
  (e) => {
    const box = e.target.closest?.("[data-root-search]");
    if (!box) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const root = box.dataset.rootSearch;
      box.value = "";
      setRootFilter(root, "");
      box.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      box.blur();
    }
  },
  true,
);

// The context readout is a one-click control: each click moves to the next size in the ladder. The full list
// (and a typed size) is still there on right-click, which no ordinary click can trigger by accident.
document.addEventListener("contextmenu", (e) => {
  const ctx = e.target.closest?.("[data-context-pick]");
  if (!ctx) return;
  e.preventDefault();
  e.stopPropagation();
  void openContextPop(ctx.dataset.contextPick, ctx);
});

// Clicking anywhere else, or scrolling the board, closes the model list.
document.addEventListener(
  "mousedown",
  (e) => {
    if (!modelPop || modelPop.contains(e.target) || e.target.closest?.("[data-model-pick],[data-context-pick]")) return;
    closeModelPop();
  },
  true,
);
// A console sticking to its newest line scrolls constantly, and that is not the reader moving the page - only a
// scroll of the page itself puts the anchor somewhere else, so only that closes the list.
window.addEventListener(
  "scroll",
  (e) => {
    if (e.target === document) positionModelPop();
  },
  true,
);
window.addEventListener("resize", () => positionModelPop());

// A subagent line is focusable, so Enter or Space has to do what a click does.
document.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const batchKey = e.target.closest?.("[data-batch-tool]");
  if (batchKey) {
    e.preventDefault();
    void loadBatchCalls(batchKey);
    return;
  }
  // A row of the stream's tool-usage group is focusable, so Enter or Space opens its box exactly as a click does.
  const usageKey = e.target.closest?.("[data-tgrp-call]");
  if (usageKey) {
    e.preventDefault();
    usageKey.click();
    return;
  }
  const tgrpRow = e.target.closest?.("[data-tgrp-tool]");
  if (tgrpRow) {
    e.preventDefault();
    const grp = tgrpRow.closest(".tgrp");
    if (grp) {
      const tool = tgrpRow.dataset.tgrpTool;
      const active = grp.dataset.filter === tool;
      const key = grp.dataset.tgrp || "";
      // Read the identity and the console BEFORE the rebuild: `grp` is detached by it, and a turn drawn twice (the
      // pinned card and its paged copy) shares every key — the lookup has to stay in the console the reader clicked.
      const gstate = grp.dataset.gstate || "";
      const scope = grp.closest("pre.job-out") || document;
      if (!active) holdConsoleFor(tgrpRow);
      rebuildToolGroup(grp, { filter: active ? "" : tool, open: !active });
      if (!active) {
        // Opening a call asks for its stored output: the live stream's preview for this tool is routinely empty,
        // and a bare "↳ patch" header is exactly the report.
        const fresh = scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gstate)}"]`);
        void ensureToolStore(String(key).split("#")[0], tool, fresh);
      }
    }
    return;
  }
  const head = e.target.closest?.("[data-subs-toggle]");
  if (head) {
    e.preventDefault();
    toggleSubs(head.dataset.subsToggle);
    return;
  }
  const row = e.target.closest?.("[data-sub-console]");
  if (!row) return;
  e.preventDefault();
  await toggleSubConsole(row.dataset.subConsole);
});

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
  // Up/Down walk the thread's previous prompts, shell style: only from the very start (Up) or the very end
  // (Down) of the text, so the arrows still move the caret inside a multi-line reply. The text AND the caret
  // are measured the way readBox measures them, so a chip counts as the text it swallowed and the arrows
  // behave exactly as they do in a box of the same text typed by hand.
  // A box still showing a recalled entry keeps walking, with the caret wherever the recall left it; a box the
  // reader has typed into only steps at the very start (Up) or the very end (Down), so the arrows stay usable
  // inside a multi-line reply.
  const nav = state.replyNav.get(box.dataset.reply);
  const boxText = readBox(box);
  const at = caretOffset(box);
  const recalled = Boolean(nav && nav.back > 0 && boxText === nav.current);
  const atStart = at === 0;
  const atEnd = at >= boxText.length;
  if (e.key === "ArrowUp" && !e.shiftKey && (atStart || (recalled && atEnd))) {
    e.preventDefault();
    recallReply(box, 1);
    return;
  }
  if (e.key === "ArrowDown" && !e.shiftKey && (atEnd || (recalled && atStart))) {
    e.preventDefault();
    recallReply(box, -1);
    return;
  }
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    insertNewlineAtCaret(box);
    return;
  }
  // Ctrl+Enter (⌘+Enter on a Mac) is the Steer turn button's gesture, not a second way to steer: send this text
  // into the turn that is running now. It is offered exactly while that button is, so with no live turn to steer
  // it falls through to the Enter path below and means what Enter means - which is what keeps the two gestures
  // from disagreeing about a state that has no steer in it. Shift is decided first, so Ctrl+Shift+Enter is still
  // a newline and never a steer.
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && steerOfferedFor(box)) {
    e.preventDefault();
    void steerFromBox(box.dataset.reply);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const thread = box.dataset.reply;
    const text = readBox(box).trim();
    // Enter is the Queue reply button's gesture: while the card offers that button - a turn is running, or a
    // finished turn whose subagents are still out - the text is held for the next turn rather than sent into a
    // busy thread. With nothing to wait for there is nothing to hold, and Enter sends.
    if (queueOfferedFor(box)) {
      queueReplyFromBox(thread);
      return;
    }
    // A card that offers no Queue reply button while a turn is live is not a state the renderer draws; if one ever
    // turns up, the text goes into the live turn rather than bouncing off a busy agent.
    if (threadBusy(thread)) {
      if (!text) return;
      const running = [...state.jobs.values()].find(
        (j) => (j.thread || j.id) === thread && (turnLive(j)),
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
// A press on the merge chip is remembered until the release: the verdict cell above is rebuilt on every scan.
document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest && e.target.closest(".merge-start[data-merge-start]");
  // A press on the chooser's own buttons is not a press on the chip: clearing here would drop the press that a
  // repaint between press and release has to survive.
  if (e.target.closest?.(".merge-chooser")) return;
  mergePress = btn ? { key: btn.dataset.mergeStart, at: Date.now() } : null;
});

// Answering an approval happens on pointerup, not on click: a repaint between the press and the release replaces
// the button, and the browser then delivers no click at all. The choices are explicit buttons, so the release is
// the decision; `approvalSent` makes the click that sometimes still follows a no-op.
document.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  const panelBtn = e.target.closest && e.target.closest("[data-approval-choice]");
  if (panelBtn) {
    e.preventDefault();
    void answerApproval(panelBtn.dataset.approvalId, panelBtn.dataset.approvalChoice, panelBtn);
    return;
  }
  const runBtn = e.target.closest && e.target.closest("[data-approve]");
  if (runBtn) {
    e.preventDefault();
    void answerRunApproval(runBtn);
    return;
  }
  // A choice in the agent's question is the same kind of decision: answered on the release, so a repaint
  // between press and release cannot swallow it the way it swallows a click.
  const qChoice = e.target.closest && e.target.closest("[data-qanswer]");
  if (qChoice) {
    e.preventDefault();
    void answerRunQuestion(qChoice.dataset.qanswer, qChoice.dataset.qvalue, qChoice.dataset.qrequest, qChoice.closest(".turn-question"));
  }
  // Cancel/Delete on a worktree confirmation: the same failure as the approval buttons. The board re-ranks
  // the table under the cursor, a repaint replaces the button, and the click is never delivered - the reader
  // clicks Delete and nothing happens. Read at release, matched by data attribute, so a rebuilt button counts.
  const delConfirm = e.target.closest && e.target.closest("[data-del-tree-yes], [data-del-tree-no]");
  if (delConfirm) {
    e.preventDefault();
    answerRowConfirm(delConfirm.dataset.delTreeYes ? "yes" : "no", delConfirm.dataset.delTreeYes || delConfirm.dataset.delTreeNo);
    return;
  }
  // Cancel / ✎ / "Name it" on a naming question: the same swallowed-click failure, and the same answer — read at
  // the release, matched by data attribute, so a button the board rebuilt mid-press still counts.
  const nameConfirm = e.target.closest && e.target.closest("[data-name-tree-yes], [data-name-tree-no], [data-name-tree-edit]");
  if (nameConfirm) {
    e.preventDefault();
    const action = nameConfirm.dataset.nameTreeYes ? "yes" : nameConfirm.dataset.nameTreeEdit ? "edit" : "no";
    answerNameConfirm(action, nameConfirm.dataset.nameTreeYes || nameConfirm.dataset.nameTreeEdit || nameConfirm.dataset.nameTreeNo);
    return;
  }
  // A choice in the chip's chooser. Taken at release for the same reason as everything above, and matched on the KEY
  // recorded when the popover opened: the row it was drawn from re-ranks under the cursor, but the key still names it.
  const choice = e.target.closest && e.target.closest("[data-merge-choice][data-mc-key]");
  if (choice && !choice.disabled) {
    e.preventDefault();
    const key = choice.dataset.mcKey;
    const what = choice.dataset.mergeChoice;
    closeMergeChooser();
    void chooseMergeOutcome(what, key);
    return;
  }
  // A release inside the popover that is not one of its buttons (the head, the note) must not fall through and
  // re-open the chooser under itself.
  if (e.target.closest?.(".merge-chooser")) return;

  // The UNMERGED chip opens the chooser - and this is the swallowed-click fix. The old code only honoured a release
  // that landed on a `td.verdict`, so a repaint that MOVED the row (the board re-ranks on every scan) dropped the
  // press whenever the finger ended up over another cell of the same row: the reader clicked and nothing happened.
  // The match is the row now, not the cell - and the key recorded at press still names it even when the chip itself
  // was rebuilt out of existence.
  const mergeBtn = e.target.closest && e.target.closest(".merge-start[data-merge-start]");
  if (mergeBtn && !mergeBtn.disabled) {
    e.preventDefault();
    mergePress = null;
    openMergeChooser(mergeBtn.dataset.mergeStart);
    return;
  }
  const pressed = mergePress;
  mergePress = null;
  if (pressed && Date.now() - pressed.at < 3000) {
    const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(pressed.key)}"]`);
    const landedOn = e.target.closest && e.target.closest("tr.row[data-key]");
    const onThatRow = Boolean(rowEl) && (rowEl.contains(e.target) || (landedOn && landedOn.dataset.key === pressed.key));
    if (onThatRow) {
      e.preventDefault();
      openMergeChooser(pressed.key);
      return;
    }
  }
  // Any other release closes the popover: the chooser is a decision the reader is looking at, not a mode.
  closeMergeChooser();
});

// Multi-select ticks and a typed answer are the reader's scratch state until they send: keep them where a
// repaint of the card will find them again.
document.addEventListener("change", (e) => {
  const pick = e.target.closest && e.target.closest("[data-qpick]");
  if (!pick) return;
  const key = `${pick.dataset.qturn}${pick.dataset.qcopy}`;
  const set = questionPicks.get(key) || new Set();
  if (pick.checked) set.add(Number(pick.dataset.qindex));
  else set.delete(Number(pick.dataset.qindex));
  questionPicks.set(key, set);
  pick.closest(".tq-choice")?.classList.toggle("on", pick.checked);
});

document.addEventListener("input", (e) => {
  const box = e.target.closest && e.target.closest(".tq-other");
  if (!box) return;
  questionDrafts.set(`${box.dataset.qother}${box.dataset.qcopy}`, box.value);
});

// Enter sends a typed answer, Shift+Enter adds a line: the same rule as the reply box, because this is a
// box the reader types a sentence into.
document.addEventListener("keydown", (e) => {
  const box = e.target.closest && e.target.closest(".tq-other");
  if (!box || e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  box.closest(".turn-question")?.querySelector("[data-qsend]")?.click();
});

document.addEventListener("input", (e) => {
  const box = e.target.closest && e.target.closest(".reply-box");
  if (!box) return;
  const thread = box.dataset.reply;
  // readBox: the draft is the text the box HOLDS, chips serialized back in place — which is what a send
  // would post, and what a rebuild replays.
  state.replyDrafts[thread] = readBox(box);
  // Editing a recalled prompt ends the walk: what is in the box is now the reader's draft, and the next Up
  // should start from the newest prompt again rather than from wherever the recall had got to.
  const nav = state.replyNav.get(thread);
  if (nav && nav.current !== undefined && readBox(box) !== nav.current) {
    state.replyNav.set(thread, { back: 0, stash: readBox(box) });
  }
  const sent = state.justSent.get(thread);
  if (sent && readBox(box).trim() !== sent.text) state.justSent.delete(thread);
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
    // The "to the newest line" chip follows the scroll as it happens, not on the 400ms sweep: the reader should
    // see it the moment they take the console over. This also runs for the panel's own scrolls, which is right -
    // a chip that is shown or hidden has no effect on where anything sits.
    if (pre && pre.classList && (pre.classList.contains("job-out") || pre.classList.contains("think-body"))) {
      paintToBottom(pre);
    }
    if (pre && pre.classList && pre.classList.contains("think-body")) {
      const key = pre.closest("details.think")?.dataset.thinkTurn || "";
      if (selfScrolled.has(pre) || justPlaced(pre)) {
        selfScrolled.delete(pre);
        return;
      }
      if (readerInputHere(pre)) {
        state.thinkPinned.set(key, pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24);
        // Kept for the next repaint: the block is replaced whenever its text is re-read, and this is where the
        // reader was when they took it over.
        state.thinkScroll.set(key, { top: pre.scrollTop });
      }
      return;
    }
    if (pre && pre.classList && pre.classList.contains("sub-console")) {
      const id = pre.dataset.subConsoleBox || "";
      if (selfScrolled.has(pre) || justPlaced(pre)) {
        selfScrolled.delete(pre);
        return;
      }
      if (readerInputHere(pre)) {
        state.subConsolePinned.set(id, pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24);
        // Kept for the next rebuild: a strip repaint or a card rebuild replaces this box, and this is the line the
        // reader took it over on.
        state.subConsoleTop.set(id, pre.scrollTop);
      }
      return;
    }
    if (!pre || pre.tagName !== "PRE" || !pre.classList || !pre.classList.contains("job-out") || !pre.dataset.out) return;
    // A scroll the panel caused itself (restoring a position, following new lines) is not the reader leaving the
    // bottom, so it must not unpin the console.
    if (selfScrolled.has(pre) || justPlaced(pre)) {
      selfScrolled.delete(pre);
      return;
    }
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 32;
    // Only a reader's own input decides the pin. Without this, a clamp that happens while a card is rebuilt looks
    // exactly like someone scrolling up, and the console sticks at the top until they notice.
    if (readerInputHere(pre)) state.outPinned[pre.dataset.out] = atBottom;
    state.outScrolls[pre.dataset.out] = { top: pre.scrollTop, atBottom };
  },
  true,
);

// Whatever moved a pinned console off its newest line - a rebuild, the browser clamping a replaced node, a resize -
// is corrected here within a frame or two. Only pinned consoles are touched, so reading history is never interrupted.
setInterval(() => {
  for (const pre of document.querySelectorAll("pre.job-out")) {
    stickConsole(pre);
    paintToBottom(pre);
  }
  for (const body of document.querySelectorAll(".think-body")) {
    stickThinkBody(body);
    paintToBottom(body);
  }
  for (const box of document.querySelectorAll(".sub-console")) stickSubConsole(box);
}, 400);

// A wheel up is the reader leaving the bottom on purpose; coming back down re-pins in the scroll handler.
document.addEventListener(
  "wheel",
  (e) => {
    const pre = e.target && e.target.closest && e.target.closest("pre.job-out");
    if (pre && e.deltaY < 0) state.outPinned[pre.dataset.out] = false;
    const subBox = e.target && e.target.closest && e.target.closest(".sub-console");
    if (subBox && e.deltaY < 0) state.subConsolePinned.set(subBox.dataset.subConsoleBox || "", false);
    const body = e.target && e.target.closest && e.target.closest(".think-body");
    if (body && e.deltaY < 0) {
      const key = body.closest("details.think")?.dataset.thinkTurn || "";
      state.thinkPinned.set(key, false);
    }
  },
  { capture: true, passive: true },
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
        fillAgentSlots(dEl, new Map());
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
  // Subagent rows carry their own clock, like the turn head above them.
  for (const el of document.querySelectorAll("[data-sub-elapsed]")) {
    const started = Number(el.dataset.subElapsed) || 0;
    const next = started ? fmtSeconds((Date.now() - started) / 1000) : "";
    if (next && el.textContent !== next) el.textContent = next;
  }
  for (const j of state.jobs.values()) {
    // A held turn ticks on the same clock: its head counts the wait and the countdown to the next try, and
    // nothing else repaints it while it waits (the gateway sends no events for a POST it refused).
    if (j.status !== "running" && j.status !== "starting" && !isWaiting(j)) continue;
    const card = document.querySelector(`.job[data-thread="${CSS.escape(j.thread || j.id)}"]`);
    // The pulse's age is the one thing on this card that has to move without an event: the whole point of it
    // is to say how long the silence is, and nothing arrives while it is silent. Rewritten in place - a rebuilt
    // node would take the card's layout with it every second.
    const pulse = card ? livePulse(j) : null;
    for (const el of card?.querySelectorAll(".live-pulse") || []) {
      if (!pulse) {
        el.remove();
        continue;
      }
      const txt = el.querySelector(".pulse-text");
      if (txt && txt.textContent !== pulse.text) txt.textContent = pulse.text;
      if (el.title !== pulse.title) el.title = pulse.title;
      const cls = `live-pulse ${pulse.cls}`;
      if (el.className !== cls) el.className = cls;
    }
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
      const next = `turn ${turnSeqOf(j)} · ${turnStateText(j)}`;
      if (txt.textContent !== next) txt.textContent = next;
    }
  }
  const bits = [];
  if (state.pool) bits.push(`pool ${state.pool.inFlight}/${state.settings.threads || "?"}`);
  if (state.jobs.size) {
    // The assistant is a conversation but not a board agent: the float says "thinking" for it, and counting
    // it here read as a phantom agent while the Agents panel said there were none.
    const convs = conversations().filter((c) => c.thread !== state.assistantThread);
    const running = convs.filter(convLive).length;
    if (convs.length) bits.push(`${convs.length} conversation${convs.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`);
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
  // SSE is the live path; this is only a safety net for a stream that has gone quiet or died. The clock it reads is
  // stamped by EVERY frame we accept, `jobline` included (core/sse.js) — a line of output is the freshest proof a run
  // is working — so a board that is still being written to is not resynced, and one that has gone silent (or whose
  // socket is not open) still is. That second half is the point: the rebuild stays for a card that is genuinely dead.
  // The rule itself is core/liveness.js, where test/liveness.test.js can drive both halves without a browser.
  const quiet = globalThis.wtLive
    ? globalThis.wtLive.quiet({ lastEventAt: state.lastEventAt, streamOpen: state.es?.readyState === 1, paused: state.paused })
    : !state.lastEventAt || Date.now() - state.lastEventAt > 20000 || state.es?.readyState !== 1;
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
        // Every liveness ranking - rows, their projects, their folders and the agent cards - advances on this
        // same clock, never on an event: each order is recomputed a tick at a time, and this is the only place
        // any of them moves.
        tickLivenessRanks();
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
  // The zoom is a layout scale, so it changes how much room the columns have without a resize event to say so:
  // without this the chart kept a split measured for the previous scale (and, on a phone, the wrong idea of
  // whether it should be scrolling sideways).
  fitAllColumns();
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

// ---- text styles: thinking, skill output, console -------------------------------------------------
// Three kinds of console text, each with its own colour and size (Settings > Display): the agent's REASONING, what a
// SKILL prints (the result of skill_view / skills_list / skill_manage, inside its output box), and the rest of the
// console's own words and tool output. They are set apart on purpose: reasoning is how the agent got there, a skill is
// a document the reader reads rather than scans, and neither should have to share a size with a one-line `ls`.
//
// Each style is a CSS variable on :root that the stylesheet reads WITH a fallback to today's look, so an unset style
// costs nothing and "use defaults" is removing the property, not writing the old value back (reasoning has two defaults
// — dim in the 🧠 block, lavender in the 🌊 stream — and a stored copy of either would flatten the other). The console's
// size is not here: it is the existing Console size (--term-size, applyTermStyle), which this row now owns.
const TEXT_STYLES = {
  think: { colorKey: "wtgui.thinkColor", sizeKey: "wtgui.thinkSize", colorVar: "--think-color", sizeVar: "--think-font-size", color: "think-color", state: "think-color-state", size: "think-size-select", fallback: "#b3a8cc" },
  skill: { colorKey: "wtgui.skillColor", sizeKey: "wtgui.skillSize", colorVar: "--skill-color", sizeVar: "--skill-font-size", color: "skill-color", state: "skill-color-state", size: "skill-size-select", fallback: "#9aa4b2" },
  console: { colorKey: "wtgui.consoleColor", colorVar: "--con-color", color: "console-color", state: "console-color-state", fallback: "#e6e9ef" },
};
const TEXT_COLOR_RE = /^#[0-9a-f]{6}$/;

function textStyleColor(kind) {
  const set = TEXT_STYLES[kind];
  try {
    const c = String(localStorage.getItem(set.colorKey) || "").toLowerCase();
    return TEXT_COLOR_RE.test(c) ? c : "";
  } catch {
    return ""; // private mode: the default holds
  }
}

function textStyleSize(kind) {
  const set = TEXT_STYLES[kind];
  if (!set.sizeKey) return 0;
  try {
    const n = Number(localStorage.getItem(set.sizeKey));
    return TERM_SIZES.includes(n) ? n : 0;
  } catch {
    return 0;
  }
}

// `color` / `size` left out read the stored value; "" / 0 mean the default. Only a value this panel offers is applied
// or kept, so a hand-edited key cannot write nonsense into a stylesheet.
function applyTextStyle(kind, { save = false, color, size } = {}) {
  const set = TEXT_STYLES[kind];
  if (!set) return;
  const root = document.documentElement.style;
  const c = color === undefined ? textStyleColor(kind) : TEXT_COLOR_RE.test(String(color).toLowerCase()) ? String(color).toLowerCase() : "";
  if (c) root.setProperty(set.colorVar, c);
  else root.removeProperty(set.colorVar);
  const input = $(set.color);
  if (input && input.value !== (c || set.fallback)) input.value = c || set.fallback;
  const state = $(set.state);
  if (state) state.textContent = c || "default";
  let n = 0;
  if (set.sizeKey) {
    n = size === undefined ? textStyleSize(kind) : TERM_SIZES.includes(Number(size)) ? Number(size) : 0;
    if (n) root.setProperty(set.sizeVar, `${n}px`);
    else root.removeProperty(set.sizeVar);
    const sel = $(set.size);
    const want = n ? String(n) : "";
    if (sel && sel.value !== want) sel.value = want;
  }
  if (save) {
    try {
      if (c) localStorage.setItem(set.colorKey, c);
      else localStorage.removeItem(set.colorKey);
      if (set.sizeKey) {
        if (n) localStorage.setItem(set.sizeKey, String(n));
        else localStorage.removeItem(set.sizeKey);
      }
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

// "use defaults": the colour goes back to unset, and so does the size — the console's own size has no unset (it is
// the 11.5px the box always had), so for that one the size goes back to that number.
function resetTextStyle(kind) {
  applyTextStyle(kind, { save: true, color: "", size: 0 });
  if (kind === "console") applyTermStyle({ save: true, size: 11.5 });
}
// ---- end text styles

// ---- panel contrast -----------------------------------------------------------------------
// The board is a stack of greys - page, detail row, card, card header, hovered row - and each layer is a CSS
// variable. One slider places the whole stack on a scale: at 0% every layer is the same neutral (a flat board),
// at 100% the page is near black and the raised surfaces are much lighter. Colours are interpolated here rather
// than in CSS because a single scale has to move six independent variables together.
const CONTRAST_KEY = "wtgui.contrast";
// The flat point is today's most common surface, so the slider's resting position is where the board already
// was. Targets are what each layer becomes at 100%.
const CONTRAST_FLAT = [18, 22, 29]; // #12161d
const CONTRAST_MAX = {
  "--console": [0, 0, 0],
  "--bg": [5, 7, 11],
  "--surface": [26, 32, 43],
  "--card": [60, 71, 86],
  "--panel": [52, 62, 76],
  "--band": [64, 76, 92],
  "--hover": [74, 86, 104],
  "--panel-2": [92, 106, 124],
  "--line": [120, 136, 156],
};

function contrastColor(target, k) {
  const c = target.map((v, i) => Math.round(CONTRAST_FLAT[i] + (v - CONTRAST_FLAT[i]) * k));
  return `rgb(${c.join(" ")})`;
}

function applyContrast(pct, { save = true } = {}) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct)) || 0));
  const k = p / 100;
  const root = document.documentElement.style;
  for (const [name, target] of Object.entries(CONTRAST_MAX)) root.setProperty(name, contrastColor(target, k));
  const input = $("contrast");
  if (input && Number(input.value) !== p) input.value = String(p);
  const label = $("contrast-pct");
  if (label) label.textContent = `${p}%`;
  if (save) {
    try {
      localStorage.setItem(CONTRAST_KEY, String(p));
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

function contrastSetting() {
  try {
    const raw = localStorage.getItem(CONTRAST_KEY);
    if (raw !== null && Number.isFinite(Number(raw))) return Math.max(0, Math.min(100, Number(raw)));
  } catch {
    /* private mode */
  }
  return 15;
}

// ---- the add-agent bar's green --------------------------------------------------------------
// The + bar under a worktree's agents is the one thing on the row you click to start an agent, so it is meant to be
// bright and solid. But "bright" is not one number on every screen: the same green reads like a warning label on a
// dark 4K panel. One scale moves lightness and saturation together - 0% a deep, quiet green, 100% the vivid one -
// and the bar's CSS reads the five variables this writes. Saved in this browser, applied at once.
const ADDBAR_KEY = "wtgui.addbar";
const ADDBAR_DEFAULT = 40; // a notch below the old fixed #1e6b38: still solid, less shouty
function addBarColors(pct) {
  const k = Math.max(0, Math.min(100, Number(pct))) / 100;
  const s = 42 + 18 * k; // saturation 42% .. 60%
  const l = 15 + 25 * k; // lightness 15% .. 40%
  const hsl = (l2) => `hsl(140 ${Math.round(s)}% ${Math.round(l2)}%)`;
  return {
    "--addbar": hsl(l),
    "--addbar-edge": hsl(l + 9),
    "--addbar-hover": hsl(l + 5),
    "--addbar-hover-edge": hsl(l + 13),
    "--addbar-active": hsl(l - 4),
  };
}

function applyAddBarBrightness(pct, { save = true } = {}) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct)) || 0));
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(addBarColors(p))) root.setProperty(name, value);
  const input = $("addbar-bright");
  if (input && Number(input.value) !== p) input.value = String(p);
  const label = $("addbar-pct");
  if (label) label.textContent = `${p}%`;
  if (save) {
    try {
      localStorage.setItem(ADDBAR_KEY, String(p));
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

function addBarBrightnessSetting() {
  try {
    const raw = localStorage.getItem(ADDBAR_KEY);
    if (raw !== null && Number.isFinite(Number(raw))) return Math.max(0, Math.min(100, Number(raw)));
  } catch {
    /* private mode */
  }
  return ADDBAR_DEFAULT;
}

// ---- where the add-agent bar sits -----------------------------------------------------------
// The + bar is the row's "start another agent here" control. Under the cards it closes the list; above them it is the
// first thing in it. Which reads better depends on whether the reader is starting agents or reading them, so it is a
// switch. CSS-only: one class on the body flips the stack, so nothing repaints and the open cards keep their scroll.
const ADDBAR_TOP_KEY = "wtgui.addbarTop";
function addBarAtTop() {
  try {
    const raw = localStorage.getItem(ADDBAR_TOP_KEY);
    if (raw !== null) return raw !== "0";
  } catch {
    /* private mode */
  }
  return true; // above the cards: the reader asked for it there
}

function applyAddBarTop(on, { save = true } = {}) {
  const top = Boolean(on);
  document.body.classList.toggle("addbar-top", top);
  const box = $("addbar-top");
  if (box && box.checked !== top) box.checked = top;
  if (save) {
    try {
      localStorage.setItem(ADDBAR_TOP_KEY, top ? "1" : "0");
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

// ---- settings group folds --------------------------------------------------------------------------------
// Seven groups of rows is a tall panel, and none of them is a number a reader checks on every visit — so every
// group STARTS FOLDED, and its heading is the control: click it, or press Enter/Space on it, to open that one
// group. What is remembered per browser is therefore the UNFOLDS, not the folds: an absent key, a cleared store
// and a first visit all read the same way — "nothing has been opened" — which is exactly the default. A key
// holding the fold list could not say that, because "absent" and "empty" would have to mean different things,
// and a group the reader had opened would look like one they had never touched.
//
// The older `wtgui.settingsFolded` list is deliberately neither read nor rewritten. It recorded the opposite
// fact: reading it as an unfold list would open the groups a reader had closed and close the ones they had
// opened, and rewriting it would turn their own saved choice into its reverse. It is left where it is, inert.
//
// The markup ships `class="folded"` with `aria-expanded="false"` for the same reason, so the panel never paints
// an open group for the instant before this runs. The panel is static (no repaint rebuilds it), so the class on
// the group is the whole state.
const SETTINGS_FOLD_KEY = "wtgui.settingsUnfolded";

function settingsUnfolds() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_FOLD_KEY) || "null");
    return new Set(Array.isArray(raw) ? raw.filter((n) => typeof n === "string") : []);
  } catch {
    return new Set();
  }
}

// One painter for both halves of the fact, because they are one fact: the class the stylesheet hides the rows
// with, and the state a keyboard or screen-reader user is told.
function paintSettingsFold(group, unfolded) {
  group.classList.toggle("folded", !unfolded);
  const head = group.querySelector(":scope > .settings-group-head");
  if (head) head.setAttribute("aria-expanded", unfolded ? "true" : "false");
}

function saveSettingsUnfolds(open) {
  try {
    localStorage.setItem(SETTINGS_FOLD_KEY, JSON.stringify([...open]));
  } catch {
    /* private mode: the open group lasts for this visit */
  }
}

function initSettingsGroups() {
  const open = settingsUnfolds();
  for (const group of document.querySelectorAll("#settings .settings-group")) {
    const head = group.querySelector(":scope > .settings-group-head");
    if (!head || !head.dataset.settingsGroup) continue;
    paintSettingsFold(group, open.has(head.dataset.settingsGroup));
    const toggle = () => {
      const unfolded = group.classList.contains("folded");
      paintSettingsFold(group, unfolded);
      const next = settingsUnfolds();
      if (unfolded) next.add(head.dataset.settingsGroup);
      else next.delete(head.dataset.settingsGroup);
      saveSettingsUnfolds(next);
    };
    head.addEventListener("click", toggle);
    // A heading is not a button, so nothing else answers these keys here — and Space would scroll the panel.
    head.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      e.preventDefault();
      toggle();
    });
  }
}

// ---- end settings group folds

// ---- settings search -------------------------------------------------------------------------------------
// The panel is a long list of rows and every group now starts folded, so the way to a setting is the search box
// the panel's fixed head keeps on screen. What it searches is the row itself: its text, its own `title`, and the
// `title` of any control inside it (`zoom out` lives only in a button's tooltip, and it is exactly the word a
// reader would try). A row that does not answer goes away, a group left with no row goes away with it, and a
// group that does answer is shown OPEN for the search — the reader's own fold is read from storage and never
// written here, so clearing the box puts every group back exactly as they left it.
//
// The match is painted with the CSS Custom Highlight API: one Range per hit over the row's own text nodes.
// Nothing is re-rendered, so a keystroke cannot take the focus ring, a select's value or a half-typed number with
// it — and a browser without Custom Highlight still filters, it just does not mark the text.
const SETTINGS_SEARCH_ID = "settings-search";
const SETTINGS_SEARCH_CLEAR_ID = "btn-settings-search-clear";
const SETTINGS_SEARCH_HIGHLIGHT = "settings-search-match";

function settingsRowText(row) {
  const parts = [String(row.textContent || "")];
  if (typeof row.getAttribute === "function") parts.push(row.getAttribute("title") || "");
  if (typeof row.querySelectorAll === "function") {
    for (const node of row.querySelectorAll("[title]")) parts.push(node.getAttribute("title") || "");
  }
  return parts.join(" ").toLowerCase();
}

function paintSettingsSearch() {
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  const query = String((box && box.value) || "").trim().toLowerCase();
  const open = settingsUnfolds(); // the reader's state: read, never written — a search must not rewrite a fold
  const matched = [];
  for (const group of document.querySelectorAll("#settings .settings-group")) {
    const head = group.querySelector(":scope > .settings-group-head");
    let hits = 0;
    let follows = true; // a preview strip or a preset row belongs to the row above it
    for (const child of [...group.children]) {
      if (child === head) continue;
      if (child.classList && child.classList.contains("settings-row")) {
        const hit = !query || settingsRowText(child).includes(query);
        child.classList.toggle("search-hidden", !hit);
        follows = hit;
        if (hit) {
          hits += 1;
          matched.push(child);
        }
      } else if (child.classList) {
        child.classList.toggle("search-hidden", Boolean(query) && !follows);
      }
    }
    group.classList.toggle("search-hidden", Boolean(query) && hits === 0);
    // A group with a match is opened for the search only. With no query every group goes back to what the reader
    // left it as — storage is the only owner of that, and this function never writes to it.
    if (query && hits > 0) paintSettingsFold(group, true);
    else if (!query && head && head.dataset.settingsGroup) {
      paintSettingsFold(group, open.has(head.dataset.settingsGroup));
    }
  }
  const clear = document.getElementById(SETTINGS_SEARCH_CLEAR_ID);
  if (clear) clear.hidden = !query;
  paintSettingsSearchHighlight(matched, query);
}

function paintSettingsSearchHighlight(rows, query) {
  const highlights = typeof CSS !== "undefined" && CSS ? CSS.highlights : null;
  const unsupported =
    !highlights ||
    typeof Highlight !== "function" ||
    typeof Range !== "function" ||
    typeof NodeFilter === "undefined" ||
    typeof document.createTreeWalker !== "function";
  if (unsupported) return; // the filter still works; only the marking is missing
  if (!query) {
    highlights.delete(SETTINGS_SEARCH_HIGHLIGHT);
    return;
  }
  const ranges = [];
  for (const row of rows) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = String(node.nodeValue || "").toLowerCase();
      for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + query.length);
        ranges.push(range);
      }
    }
  }
  if (!ranges.length) highlights.delete(SETTINGS_SEARCH_HIGHLIGHT);
  else highlights.set(SETTINGS_SEARCH_HIGHLIGHT, new Highlight(...ranges));
}

function clearSettingsSearch() {
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  if (!box || !box.value) return;
  box.value = "";
  paintSettingsSearch();
}

function initSettingsSearch() {
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  if (!box) return;
  box.addEventListener("input", () => paintSettingsSearch());
  box.addEventListener("search", () => paintSettingsSearch()); // the browser's own ✕ in a type=search box
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Esc in a box with something in it clears the search rather than closing the panel — the first Esc is about
    // what you typed, and stopPropagation keeps the page's own Esc handler (which closes Settings) out of it. On
    // an empty box this returns early and Esc closes the panel exactly as it always did.
    if (!box.value) return;
    e.preventDefault();
    e.stopPropagation();
    box.value = "";
    paintSettingsSearch();
  });
  const clear = document.getElementById(SETTINGS_SEARCH_CLEAR_ID);
  if (clear) {
    clear.addEventListener("click", () => {
      box.value = "";
      paintSettingsSearch();
      box.focus();
    });
  }
}

// ---- end settings search

function toggleSettings(open = null) {
  const panel = $("settings");
  if (!panel) return;
  const show = open === null ? panel.classList.contains("hidden") : open;
  panel.classList.toggle("hidden", !show);
  if (!show) {
    // A panel that is opened again must not come back filtered: the search belongs to the visit that typed it.
    clearSettingsSearch();
    return;
  }
  // The groups start folded, so the first control is the search box the fixed head keeps on screen. Focus used to
  // land on the font select — which is now inside a folded (display:none) group, where focus() does nothing at all.
  const searchBox = $("settings-search");
  if (searchBox) searchBox.focus();
  const sel = $("font-select");
  if (sel) sel.value = currentFontId("ui");
  // The browser-owned rows are read at boot; painting them again here just means the panel always opens on
  // what is in effect, even if another tab changed it.
  paintQLook();
  // The two folders, always on the last snapshot the page received (their sizes are computed server-side and cached
  // for ten seconds, so opening Settings never waits on a walk), and the clean button disarmed: an armed press left
  // over from last time must not be one Enter away from deleting a folder.
  paintPaths();
  paintScratchActions(false);
  // The agent-cleanup row reads the last snapshot again on every open, so a switch another tab moved is what the
  // panel shows rather than what this tab last saw.
  paintAgentCleanup();
  // Read the gateway's window every time the panel opens: it can be changed from a CLI, and the
  // panel is not the owner of that value.
  void loadApprovalSetting();
  void loadSessionSetting();
  void loadProviderSetting();
  void loadModelsSetting();
  // The remote-write setting is the panel's own (config.json), but which trees carry the push guard is a file on
  // disk that another instance or a hand edit can change, so it is re-read every time the panel opens.
  void refreshRemoteGuards();
}

// ---- the provider endpoint every run talks to ------------------------------------------------
// model.base_url and model.api_key in config.yaml. The key never comes back from the server: the box
// shows whether one is set, where it came from and its last four characters, and typing replaces it.
let providerStateCache = null;

function paintProviderSetting(error = null) {
  const url = $("provider-url");
  const key = $("provider-key");
  const preview = $("provider-preview");
  const save = $("btn-provider-save");
  const clear = $("btn-provider-clear");
  const s = providerStateCache;
  if (!preview) return;
  if (!s) {
    preview.textContent = "could not read the provider settings";
    preview.classList.add("bad");
    return;
  }
  if (url && document.activeElement !== url) url.value = s.baseUrl || "";
  if (url) url.placeholder = s.defaultBaseUrl || "https://openrouter.ai/api/v1";
  if (key) {
    const where = s.key.inConfig ? "in config.yaml" : s.key.envName ? `from ${s.key.envName}` : null;
    key.placeholder = s.key.set ? `${s.key.masked}${where ? ` ${where}` : ""} — type to replace` : "(not set — runs have no key)";
    if (error) key.value = "";
  }
  if (save) save.disabled = !s.editable;
  if (clear) clear.disabled = !s.editable || !s.key.inConfig;
  const urlText = s.baseUrl || `${s.defaultBaseUrl} (default)`;
  const keyText = s.key.set ? `${s.key.masked}${s.key.inConfig ? " in config.yaml" : s.key.envName ? ` from ${s.key.envName}` : ""}` : "not set";
  preview.textContent = error
    ? `NOT SAVED — ${error}`
    : `${s.provider} · ${urlText} · key ${keyText}`;
  preview.classList.toggle("bad", Boolean(error) || !s.editable);
  preview.title = s.editable ? s.configPath : s.reason || s.configPath;
}

async function loadProviderSetting() {
  try {
    const r = await apiFetch("/api/settings/provider");
    providerStateCache = await r.json();
    paintProviderSetting();
  } catch (e) {
    providerStateCache = null;
    paintProviderSetting(e.message);
  }
}

async function saveProviderSetting() {
  const url = $("provider-url");
  const key = $("provider-key");
  if (!providerStateCache?.editable) return;
  const preview = $("provider-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: url?.value || "", apiKey: key?.value || "" }),
    });
    const d = await r.json();
    providerStateCache = d;
    if (!r.ok) {
      paintProviderSetting(d.error || `HTTP ${r.status}`);
      return;
    }
    if (key) key.value = "";
    paintProviderSetting();
    showBanner(d.note || "provider settings saved");
  } catch (e) {
    paintProviderSetting(e.message);
  }
}

// Two clicks: the first only arms the button, so a stray one cannot take the key out of config.yaml.
async function clearProviderKey(btn) {
  if (!btn || !providerStateCache?.editable) return;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "clear key?";
    btn.classList.add("dirty");
    clearTimeout(btn._disarm);
    btn._disarm = setTimeout(() => {
      btn.dataset.armed = "";
      btn.textContent = "clear key";
      btn.classList.remove("dirty");
    }, 4000);
    return;
  }
  clearTimeout(btn._disarm);
  btn.dataset.armed = "";
  btn.textContent = "clear key";
  btn.classList.remove("dirty");
  try {
    const r = await apiFetch("/api/settings/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearKey: true }),
    });
    const d = await r.json();
    providerStateCache = d;
    if (!r.ok) {
      paintProviderSetting(d.error || `HTTP ${r.status}`);
      return;
    }
    paintProviderSetting();
    showBanner(d.key?.set ? "model.api_key removed — the .env key is used again" : "model.api_key removed — runs now have no key from config.yaml");
  } catch (e) {
    paintProviderSetting(e.message);
  }
}

// ---- the model menu's prices and ratings -------------------------------------------------------
// The dropdown's price and coding columns are this panel's own cache of what the gateway's model
// inventory says. They are READ, never fetched, on the path that opens the menu — a cold endpoint
// must not be able to hold a dropdown — so this is the one control that regenerates them: it makes
// the gateway re-fetch every provider's live model list (the same file `hermes model --refresh`
// writes) and rebuilds the cache from that answer, then refills the menu. The reply carries both
// files' row counts and mtimes, and both are shown, because "it regenerated" and "it re-read the
// same bytes" otherwise look identical from here.
let modelsSetting = null;

// Two ages, not one. The press moves BOTH files, and a single "1d old" let the list's age stand for the
// price cache's — while neither of them dated the snapshot the ratings come from. The list's age is the
// newest provider stamp the gateway wrote into provider_models_cache.json; the prices' age is this panel's
// own cache; the ratings are dated by the snapshot's own generatedAt, and no press can move that file.
function modelListAgeText(state) {
  return state.fetchedAt ? `list ${relTime(state.fetchedAt)} old` : "list age unknown";
}

function snapshotDate(state) {
  return state.pricingSnapshotAt ? String(state.pricingSnapshotAt).slice(0, 10) : "";
}

function modelAgeText(state) {
  if (state.pricingAge === null || state.pricingAge === undefined) return "never built";
  return `${relTime(new Date(Date.now() - state.pricingAge * 1000).toISOString())} old`;
}

function paintModelsSetting(error = null) {
  const preview = $("models-preview");
  const age = $("models-age");
  const btn = $("btn-models-refresh");
  if (!preview) return;
  const s = modelsSetting;
  if (!s) {
    if (age) age.textContent = "—";
    preview.textContent = error ? `NOT REGENERATED — ${error}` : "could not read the model list";
    preview.classList.add("bad");
    return;
  }
  if (age) age.textContent = `${modelListAgeText(s)} · prices ${modelAgeText(s)}`;
  if (btn) btn.disabled = false;
  const snapAt = snapshotDate(s);
  const fromSnapshot = s.ratedFromSnapshot || 0;
  preview.textContent = error
    ? `NOT REGENERATED — ${error}`
    : `${s.count} model${s.count === 1 ? "" : "s"} in ${(s.providers || []).length} providers · ${s.pricedCount || 0} priced · ${s.ratedCount || 0} rated` +
      (snapAt && fromSnapshot ? ` · ${fromSnapshot} row${fromSnapshot === 1 ? "" : "s"} from the OpenRouter snapshot of ${snapAt}` : "");
  preview.classList.toggle("bad", Boolean(error));
  preview.title = error ? "" : `provider list: ${s.source}${s.pricingSource ? `\nprices: ${s.pricingSource}` : ""}${snapAt ? `\nratings snapshot: ${snapAt}` : ""}`;
}

async function loadModelsSetting() {
  try {
    const r = await apiFetch("/api/models");
    modelsSetting = r.ok ? await r.json() : null;
  } catch (e) {
    modelsSetting = null;
    paintModelsSetting(e.message);
    return;
  }
  paintModelsSetting();
}

async function refreshModels() {
  const btn = $("btn-models-refresh");
  const preview = $("models-preview");
  if (btn) btn.disabled = true;
  if (preview) {
    preview.textContent = "refreshing models & prices — re-fetching every provider's live model list, then rebuilding the price cache from that answer…";
    preview.classList.remove("bad");
  }
  try {
    // Long: the gateway re-probes every authenticated provider before it answers.
    const r = await apiFetch("/api/models/refresh", { method: "POST" }, { timeoutMs: 240000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      paintModelsSetting(d.error || `HTTP ${r.status}`);
      return;
    }
    // Re-read through the same path the menu itself uses, so the dropdown is drawing the new file.
    await loadModels();
    await loadModelsSetting();
    const b = d.before || {};
    const a = d.after || {};
    // Local wall clock, not the file's UTC stamp: a reader comparing "at 00:32" against their own clock
    // would be reading the wrong hour of the day.
    const clock = (iso) =>
      iso ? new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    if (preview) {
      preview.title =
        `provider_models_cache.json: mtime ${b.models?.mtimeIso || "—"} → ${a.models?.mtimeIso || "—"}, ` +
        `rows ${b.models?.rows ?? "?"} → ${a.models?.rows ?? "?"}\n` +
        `model-prices.json: mtime ${b.pricing?.mtimeIso || "—"} → ${a.pricing?.mtimeIso || "—"}, ` +
        `priced rows ${b.pricing?.priced ?? "?"} → ${a.pricing?.priced ?? "?"}\n` +
        `the OpenRouter snapshot behind the ratings is not re-fetched by this press`;
    }
    showBanner(
      `models & prices refreshed — provider list ${b.models?.rows ?? "?"} → ${a.models?.rows ?? "?"} rows ` +
        `(${b.models?.providers ?? "?"} → ${a.models?.providers ?? "?"} providers) at ${clock(a.models?.mtimeIso)} · ` +
        `price cache ${b.pricing?.priced ?? "?"} → ${a.pricing?.priced ?? "?"} rows at ${clock(a.pricing?.mtimeIso)} · ` +
        `the OpenRouter ratings snapshot was not re-fetched`,
    );
  } catch (e) {
    paintModelsSetting(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
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
  // The description lives on the row as a tooltip now; this keeps the live half of it (where the number is
  // written, or why it cannot be written here) in the same place.
  const rowEl = $("approval-row");
  if (rowEl) {
    const base = "How long a permission prompt waits for you before it fails closed — if it expires, nothing runs.";
    rowEl.title = s.editable
      ? `${base} Written to ${s.configPath}, which the gateway re-reads, so the next prompt uses it without a restart.`
      : `${base} ${s.reason || "This window cannot be changed from here"} — nothing is written.`;
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

// ---- how far back the row ranking averages ------------------------------------------------
function paintRankWindow() {
  const input = $("rank-window");
  if (input && document.activeElement !== input) input.value = String(state.rankWindowSeconds);
}

function saveRankWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    paintRankWindow();
    showBanner(`Rank window left at ${state.rankWindowSeconds} s — give a number of seconds`);
    return;
  }
  // The window is shared by every liveness ranking: it is one answer to one question, how far back the board
  // looks when it decides what is busiest.
  const clamped = Math.max(RANK_WINDOW_MIN, Math.min(RANK_WINDOW_MAX, Math.round(n)));
  try {
    localStorage.setItem(RANK_WINDOW_KEY, String(clamped));
  } catch {
    /* private mode: the choice just will not persist */
  }
  state.rankWindowSeconds = clamped;
  // An explicit change re-reads the evidence at once rather than easing over ticks: the reader asked for it.
  state.rankOrder.clear();
  tickLivenessRanks();
  paintRankWindow();
  showNote(`Rank window ${clamped} s — every liveness ranking (rows, projects, folders, agent cards) now averages over the last ${clamped} s`);
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
  const rowEl = $("session-row");
  if (rowEl) {
    const store = s.store
      ? `The store holds ${s.store.sessions} sessions and ${s.store.messages.toLocaleString()} messages — nothing deletes at ten. `
      : "The store could not be read. ";
    rowEl.title =
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
  // The reasoning and skill pickers carry a "Default" first: unset is a real choice for them (the console's has none).
  for (const kind of Object.keys(TEXT_STYLES)) {
    const set = TEXT_STYLES[kind];
    const sel = set.size ? $(set.size) : null;
    if (sel && !sel.options.length) {
      sel.innerHTML = `<option value="">Default</option>${TERM_SIZES.map((n) => `<option value="${n}">${n}px</option>`).join("")}`;
    }
    applyTextStyle(kind);
  }
}

// Paint the saved question-box look before the first card is drawn.
function initQLook() {
  applyQLook({}, { save: false });
}

$("btn-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
$("btn-settings-close")?.addEventListener("click", () => toggleSettings(false));
// The groups' folds are painted at load, not when the panel opens: a reader who opened Board last time should not
// see it folded for the instant the panel takes to open. The search box is wired here too, on an empty box, so the
// panel is never filtered by a query left in the DOM.
initSettingsGroups();
initSettingsSearch();
// A second way in that is always on screen at the top left: the title opens Settings.
$("title-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
$("font-select")?.addEventListener("change", (e) => applyFont("ui", e.target.value));
$("term-select")?.addEventListener("change", (e) => applyFont("term", e.target.value));
$("term-size-select")?.addEventListener("change", (e) => applyTermStyle({ save: true, size: e.target.value }));
// The colour follows the picker while it is dragged and is saved when it settles; a size is saved as it is chosen.
for (const [kind, set] of Object.entries(TEXT_STYLES)) {
  $(set.color)?.addEventListener("input", (e) => applyTextStyle(kind, { color: e.target.value }));
  $(set.color)?.addEventListener("change", (e) => applyTextStyle(kind, { save: true, color: e.target.value }));
  if (set.size) $(set.size)?.addEventListener("change", (e) => applyTextStyle(kind, { save: true, size: e.target.value }));
}
for (const b of document.querySelectorAll("[data-text-reset]")) b.addEventListener("click", () => resetTextStyle(b.dataset.textReset));

// ---- the question box's look: tint, size, density, and whether the typed answer is offered --------
for (const btn of document.querySelectorAll("[data-q-tint]")) {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    applyQLook({ tint: btn.dataset.qTint });
  });
}
$("q-size")?.addEventListener("change", (e) => {
  const n = Number(e.target.value);
  const look = applyQLook({ size: Number.isFinite(n) && n > 0 ? n : Q_SIZE_DEFAULT });
  // Show the clamped value: typing 40 lands on 18, and the box must say so rather than silently disagree.
  e.target.value = String(look.size);
});
$("q-width")?.addEventListener("change", (e) => {
  const n = Number(e.target.value);
  const look = applyQLook({ width: Number.isFinite(n) && n > 0 ? n : 0 });
  e.target.value = String(look.width);
});
for (const btn of document.querySelectorAll("[data-q-width-set]")) {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    applyQLook({ width: Number(btn.dataset.qWidthSet) || 0 });
  });
}
$("q-compact")?.addEventListener("change", (e) => applyQLook({ compact: Boolean(e.target.checked) }));
$("q-typed")?.addEventListener("change", (e) => {
  applyQLook({ typed: Boolean(e.target.checked) });
  // The typed row is markup, not only CSS: an open question has to be redrawn to gain or lose it.
  renderJobs();
});
$("grey-flash")?.addEventListener("change", (e) => applyGreyFlash(Boolean(e.target.checked)));
$("event-flash")?.addEventListener("change", (e) => {
  state.eventFlash = Boolean(e.target.checked);
  saveAnchorFlag(EVENT_FLASH_KEY, state.eventFlash);
});
$("stabilize-reorder")?.addEventListener("change", (e) => applyStabilize(Boolean(e.target.checked)));

// What the row's ⟳ does with a mismatch: never / ask (one card) / start it. Per browser, because the click is this
// reader's, and read again on every click rather than cached, so flipping it needs no reload.
$("refresh-agent")?.addEventListener("change", (e) => {
  const mode = saveRefreshAgent(e.target.value);
  showBanner(
    mode === "off"
      ? "row refresh: never starts an agent — the cheap pass and its journal are all"
      : mode === "auto"
        ? "row refresh: starts the double-check agent itself when the cheap pass finds a mismatch"
        : "row refresh: offers the double-check agent on one card when the cheap pass finds a mismatch",
  );
});

// Refresh everything, or only what is on screen. The scans happen in the server, so this is a server setting: it is
// written to the panel's config.json and applies to whichever browser is open.
$("scan-mode")?.addEventListener("change", async (e) => {
  const before = state.settings?.scanMode === "visible" ? "visible" : "all";
  const mode = e.target.value === "visible" ? "visible" : "all";
  try {
    const r = await apiFetch("/api/settings/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }, { timeoutMs: 10000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings.scanMode = d.mode || mode;
    paintConfigLine();
    showBanner(mode === "visible" ? "refresh: only the projects on screen" : "refresh: every project");
    reportVisibility({ force: true });
  } catch (err) {
    e.target.value = before;
    showBanner(`could not change the refresh mode: ${err.message}`);
  }
});

// ---- whether an agent may clean up after itself ------------------------------------------------
// The panel's own switch (config.json `agentCleanup`, POST /api/settings/cleanup): a veto ABOVE every project's own
// `releaseWorktrees` grant, and the reason the row says which projects that grant names — "on" alone would read as
// "every repository is open", which is not what the server decides. Off is the reader's answer to "I want to read and
// remove these trees myself", so nothing an agent says removes one; the row's ✕ still does.
function agentCleanupStored() {
  return state.settings?.agentCleanup !== false;
}

function paintAgentCleanup(note = "", bad = false) {
  const box = $("agent-cleanup");
  const preview = $("agent-cleanup-preview");
  const on = agentCleanupStored();
  // A rejected save leaves the box where the reader put it, saying the save failed: snapping it back reads as
  // "it saved that", when the save is exactly what failed.
  if (box && !bad) box.checked = on;
  if (!preview) return;
  const granted = Array.isArray(state.settings?.releaseProjects) ? state.settings.releaseProjects : [];
  const bits = [
    on
      ? granted.length
        ? `on — a project's own releaseWorktrees grant decides, and it names ${granted.join(", ")}`
        : "on — but no project carries a releaseWorktrees grant, so nothing is removed automatically either"
      : "off — no prompt carries RELEASE, a request is refused on the row, and a LANDED: YES is only a line in the console; the ✕ still removes a tree",
    "set in config.json (agentCleanup), so it applies to every browser and survives a restart",
  ];
  preview.textContent = bad ? `NOT SAVED — ${note}. config.json still says: ${on ? "on" : "off"}.` : note ? `${note} · ${bits.join(" · ")}` : bits.join(" · ");
  preview.classList.toggle("bad", bad);
}

$("agent-cleanup")?.addEventListener("change", async (e) => {
  const want = Boolean(e.target.checked);
  const before = agentCleanupStored();
  const preview = $("agent-cleanup-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/cleanup",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentCleanup: want }) },
      { timeoutMs: 10000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings = { ...(state.settings || {}), ...(d.settings || {}) };
    paintAgentCleanup();
    showBanner(
      want
        ? "agent cleanup: on — a tree goes only when its project's own grant allows it, its PR reads MERGED and it is clean"
        : "agent cleanup: off — nothing an agent says removes a worktree; you remove them from the row's ✕",
    );
  } catch (err) {
    e.target.checked = before;
    paintAgentCleanup(`could not change it: ${err.message}`, true);
    showBanner(`could not change agent cleanup: ${err.message}`);
  }
});

// ---- end agent cleanup

// ---- how old a worktree may be before the chart holds its row back ---------------------------------
// The threshold lives in this panel's config.json (POST /api/settings/age), like the refresh mode above: one
// number for every browser, and it survives a restart. The per-chart "show all" arrow is the one half of this that
// is per-browser (state.showOldProjects). Moving the number redraws the board, because rows leave and come back the
// instant the line moves - waiting for the next scan would show the change one project at a time.
const AGE_DAYS_MAX_UI = 3650;

function ageDaysStored() {
  const n = Number(state.settings?.hideOlderThanDays);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 7;
}

function ageDaysSentence(days) {
  return days > 0
    ? `hold back worktrees whose last activity is older than ${days} day${days === 1 ? "" : "s"}`
    : "hold nothing back - every worktree is on its chart";
}

function paintAgeSetting(note = "", bad = false) {
  const stored = ageDaysStored();
  const input = $("hide-older-days");
  // A rejected save leaves what was typed in the box: snapping back to the stored number reads as "it saved that",
  // when the save is exactly what failed.
  if (input && !bad && document.activeElement !== input) input.value = String(stored);
  for (const btn of document.querySelectorAll("[data-age-set]")) {
    btn.classList.toggle("on", Number(btn.dataset.ageSet) === stored);
  }
  const preview = $("hide-older-preview");
  if (preview) {
    const live = input && document.activeElement === input ? Math.round(Number(input.value)) : stored;
    const days = Number.isFinite(live) && live >= 0 ? live : stored;
    const bits = [
      `${ageDaysSentence(days)} · set in config.json, so it applies to every browser and survives a restart`,
      "the arrow at the bottom of a chart shows that chart's held-back trees",
    ];
    preview.textContent = bad
      ? `NOT SAVED - ${note}. config.json still says: ${ageDaysSentence(stored)}.`
      : note
        ? `${note} - ${bits.join(" · ")}`
        : bits.join(" · ");
    preview.classList.toggle("bad", bad);
  }
}

async function saveAgeSetting(days) {
  const stored = ageDaysStored();
  const want = Number(days);
  const n = Number.isFinite(want) ? Math.max(0, Math.min(AGE_DAYS_MAX_UI, Math.round(want))) : stored;
  const preview = $("hide-older-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/age",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: n }),
      },
      { timeoutMs: 10000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings.hideOlderThanDays = Number.isFinite(Number(d.days)) ? Number(d.days) : n;
    // The line moved, so which rows every chart draws moved with it: rebuild the board rather than let the next
    // scan trickle it in one project at a time.
    renderAll();
    paintAgeSetting(ageDaysSentence(state.settings.hideOlderThanDays));
    showBanner(ageDaysSentence(state.settings.hideOlderThanDays));
  } catch (err) {
    paintAgeSetting(String((err && err.message) || err), true);
  }
}

$("hide-older-days")?.addEventListener("change", (e) => void saveAgeSetting(e.target.value));
for (const btn of document.querySelectorAll("[data-age-set]")) {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const input = $("hide-older-days");
    if (input) input.value = btn.dataset.ageSet;
    void saveAgeSetting(btn.dataset.ageSet);
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

function chartColumnsSentence(hidden = chartColumnsStored()) {
  const shown = CHART_COLUMNS.length - hidden.length;
  return hidden.length
    ? `${shown} of ${CHART_COLUMNS.length} columns on the chart · hidden: ${hidden.join(", ")}`
    : `every column is on the chart (${CHART_COLUMNS.length})`;
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

// ---- may a branch exist on a REMOTE at all? ------------------------------------------------------
// The reader's own words: "all branches local only unless permission was specifically granted in a permission box
// like other permissions". It lives in this panel's config.json (`remoteBranchPolicy`), so it applies to every
// browser and survives a restart; changing it writes the installed guards' own copy of it as well, and THAT is
// what stands between a worker's `git push` and the remote.
const REMOTE_POLICY_SENTENCE = {
  "local-only": "branches stay local unless you allow a write in the permission box",
  allow: "remote writes go through without asking — the box is not offered",
  deny: "remote writes are refused outright — the box is not even offered",
};

function remotePolicyStored() {
  const p = String(state.settings?.remoteBranchPolicy || "local-only");
  return REMOTE_POLICY_SENTENCE[p] ? p : "local-only";
}

function paintRemotePolicy(note = "", bad = false) {
  const stored = remotePolicyStored();
  const sel = $("remote-policy");
  // A rejected save leaves what was picked in the box: snapping back reads as "it saved that", when the save is
  // exactly what failed.
  if (sel && !bad) sel.value = stored;
  const preview = $("remote-policy-preview");
  if (!preview) return;
  const g = state.remoteGuards;
  const last = g?.latest?.[0];
  const bits = [
    `config.json remoteBranchPolicy: ${stored} — ${REMOTE_POLICY_SENTENCE[stored]}`,
    !g
      ? "push guard: reading…"
      : g.count
        ? `push guard in ${g.count} worktree${g.count === 1 ? "" : "s"} across ${g.projects} project${g.projects === 1 ? "" : "s"}${last ? ` · last: ${last.tree}` : ""}${g.dirs?.length ? ` · ${g.dirs[0]}` : ""}`
        : "push guard: not installed yet — it goes in when the panel cuts a worktree (or press the button)",
    g?.landing?.length ? `${g.landing.length} tree(s) started to land, so they may push` : null,
    state.rwPending.size ? `${state.rwPending.size} permission request(s) waiting on you — in the dock, bottom right` : null,
  ].filter(Boolean);
  preview.textContent = bad ? `NOT SAVED — ${note}` : note ? `${note} · ${bits.join(" · ")}` : bits.join(" · ");
  preview.classList.toggle("bad", bad);
}

// The guard's own state (which trees carry it), read on demand: it is a file, not a scan, so opening Settings can
// ask for it every time.
async function refreshRemoteGuards() {
  try {
    const d = await apiFetch("/api/remote-write/state").then((r) => r.json());
    state.remoteGuards = d.guards || null;
    if (d.policy) state.settings = { ...(state.settings || {}), remoteBranchPolicy: d.policy };
    paintRemotePolicy();
  } catch {
    paintRemotePolicy("could not read the guard's state", true);
  }
}

async function saveRemotePolicy(policy) {
  const before = remotePolicyStored();
  const preview = $("remote-policy-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/remote-branches",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy }) },
      { timeoutMs: 20000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings = { ...(state.settings || {}), ...(d.settings || {}) };
    state.remoteGuards = d.guards || state.remoteGuards;
    paintRemotePolicy(d.note || "saved");
    showBanner(`branches on the remote: ${REMOTE_POLICY_SENTENCE[d.policy] || d.policy}`);
  } catch (err) {
    // Put the box back where it was: the stored value did NOT change.
    const sel = $("remote-policy");
    if (sel) sel.value = before;
    paintRemotePolicy(String((err && err.message) || err), true);
  }
}

async function installPushGuardNow(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "installing…";
  try {
    const r = await apiFetch("/api/remote-write/guard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "install" }) }, { timeoutMs: 180000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.remoteGuards = d.guards || state.remoteGuards;
    const failed = Number(d.failed) || 0;
    paintRemotePolicy(`push guard installed in ${d.installed} worktree${d.installed === 1 ? "" : "s"}${failed ? `, ${failed} refused (named in the log)` : ""}`);
    showBanner(`push guard: ${d.installed} worktree(s) now refuse a local-only push and ask you instead${failed ? ` · ${failed} could not be installed` : ""}`);
  } catch (err) {
    paintRemotePolicy(`could not install the push guard: ${String((err && err.message) || err)}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$("remote-policy")?.addEventListener("change", (e) => void saveRemotePolicy(e.target.value));
$("btn-guard-install")?.addEventListener("click", (e) => {
  e.preventDefault();
  void installPushGuardNow(e.target);
});

// ---- the panel's own two folders ---------------------------------------------------------------
// Where the board's state lives (the data directory) and where an agent may throw things away (the scratch
// directory). Both are outside the checkout, both are reported with their size, and the scratch one can be
// emptied — but only when no live run is standing in it: the server decides that and answers 409 with the run
// named, and this row repeats the refusal rather than looking like a press that did nothing.
const PATH_SOURCE_WORD = {
  config: "set in config.json",
  env: "from the environment",
  default: "the default",
  // A second instance (PANEL_CONFIG with no dataDir) keeps its own folder and ignores the environment on purpose.
  PANEL_CONFIG: "this instance's own folder, beside its PANEL_CONFIG file — name dataDir in that config to move it",
};

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(x) : Math.round(x * 10) / 10} ${units[i]}`;
}

const pathText = (p) => String(p || "").replace(/\\/g, "/");

function paintPaths(note = "", bad = false) {
  const p = state.paths;
  const dataSize = $("data-dir-size");
  const dataPath = $("data-dir-path");
  const scratchSize = $("scratch-dir-size");
  const scratchPath = $("scratch-dir-path");
  if (!p) {
    if (dataPath) dataPath.textContent = "…";
    if (scratchPath) scratchPath.textContent = "…";
    return;
  }
  const sizeText = (bytes, files, measuredAt) => (measuredAt ? `${fmtBytes(bytes)} · ${files} file${files === 1 ? "" : "s"}` : "measuring…");
  if (dataSize) dataSize.textContent = sizeText(p.dataBytes, p.dataFiles, p.dataMeasuredAt);
  if (scratchSize) scratchSize.textContent = sizeText(p.scratchBytes, p.scratchFiles, p.scratchMeasuredAt);
  if (dataPath) {
    // Where this board's history came from is the thing a reader will not otherwise know happened: a board that came
    // up carrying last week's cards should say where they came from. The data directory's own journal keeps the answer
    // across boots, so the line is still true tomorrow; `thisBoot` only says it happened on this very start.
    const m = p.migrated;
    const moved = m ? ` · ${m.files} file${m.files === 1 ? "" : "s"} copied here from ${pathText(m.from)} ${m.thisBoot ? "on this boot" : `on ${String(m.at || "").slice(0, 10)}`} (the originals were left where they were)` : "";
    dataPath.textContent = bad ? `${note}` : `${pathText(p.dataDir)} — ${PATH_SOURCE_WORD[p.dataSource] || p.dataSource} · ${p.dataLayout === "flat" ? "everything in this one folder" : "state/, attachments/ and logs/ inside it"}${moved}`;
    dataPath.classList.toggle("bad", Boolean(bad));
  }
  if (scratchPath) {
    // A folder the panel did not make cannot be cleaned: say so on the row, before a press finds out.
    const unmarked = p.scratchMarked === false ? " · not made by the panel, so Clean scratch will refuse (add an empty .wag-scratch file to allow it)" : "";
    scratchPath.textContent = bad
      ? `${note}`
      : note || `${pathText(p.scratchDir)} — ${PATH_SOURCE_WORD[p.scratchSource] || p.scratchSource} · every spawn prompt names its own folder under it${unmarked}`;
    scratchPath.classList.toggle("bad", Boolean(bad));
  }
}

// One press to empty the scratch directory, two to confirm — Cancel then clean, left to right, like every other
// destructive control on this board. Swapping the button for the pair in place keeps the panel's height still.
function paintScratchActions(armed = false) {
  const row = $("scratch-actions");
  if (!row) return;
  const p = state.paths;
  const size = p && p.scratchMeasuredAt ? `${fmtBytes(p.scratchBytes)} in ${p.scratchFiles} file${p.scratchFiles === 1 ? "" : "s"}` : "everything under it";
  row.innerHTML = armed
    ? `<button type="button" id="btn-clean-cancel">cancel</button><button type="button" id="btn-clean-go" class="bad">clean ${esc(size)}</button>`
    : `<button type="button" id="btn-clean-scratch" title="delete everything in the scratch directory and report how much it freed. Refused with the run named if a live agent is working inside it.">clean scratch</button>`;
  if (!armed) return;
  $("btn-clean-cancel")?.addEventListener("click", () => paintScratchActions(false));
  $("btn-clean-go")?.addEventListener("click", () => void cleanScratchNow());
}

async function openPathFolder(which) {
  try {
    const r = await apiFetch("/api/paths/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ which }),
    }, { timeoutMs: 10000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // Silent on success (a file manager window opening is the answer); the path is on the row if it did not.
    paintPaths(d.path ? `opened ${pathText(d.path)}` : "", false);
  } catch (err) {
    showBanner(`could not open the ${which} folder: ${err.message}`);
  }
}

async function cleanScratchNow() {
  const row = $("scratch-actions");
  if (row) row.innerHTML = `<span class="settings-unit mono">cleaning…</span>`;
  try {
    const r = await apiFetch("/api/scratch/clean", { method: "POST" }, { timeoutMs: 60000 });
    const d = await r.json().catch(() => ({}));
    if (d.paths) state.paths = d.paths;
    if (!r.ok) {
      // The refusal is the answer: name the runs holding it, and leave the size alone because nothing was deleted.
      const why = d.error || `HTTP ${r.status}`;
      paintScratchActions(false);
      paintPaths(why, true);
      showBanner(`scratch NOT cleaned — ${why}`);
      return;
    }
    const freed = d.freed || fmtBytes(d.freedBytes);
    const what = `freed ${freed} · ${d.removedFiles} file${d.removedFiles === 1 ? "" : "s"} removed${d.leftBehind ? ` · ${d.leftBehind} still open` : ""}`;
    paintScratchActions(false);
    paintPaths(what, false);
    showBanner(`scratch cleaned — ${what}`);
  } catch (err) {
    paintScratchActions(false);
    paintPaths(`the clean failed: ${err.message}`, true);
  }
}

$("btn-open-data")?.addEventListener("click", () => void openPathFolder("data"));
$("btn-open-scratch")?.addEventListener("click", () => void openPathFolder("scratch"));
// The presets row is rebuilt on every arm, so the first button is wired here and the pair inside
// paintScratchActions wires itself.
document.addEventListener("click", (e) => {
  const btn = e.target.closest ? e.target.closest("#btn-clean-scratch") : null;
  if (!btn) return;
  e.preventDefault();
  paintScratchActions(true);
});

// Settings that arrive from the SERVER apply here, in one place: a snapshot carries them, and a `settings` event
// carries them after a change made anywhere else (another tab, or "Always allow" in the permission box).
function applySettings(settings) {
  if (!settings) return;
  // Which columns are drawn is the one setting here that changes the table's SHAPE: another tab (or a hand-edited
  // config the panel re-broadcasts) can hide a column, and a board that only repainted its cells would leave the old
  // header over rows that no longer match it.
  const colsBefore = (state.settings?.hiddenColumns || []).join(",");
  state.settings = { ...(state.settings || {}), ...settings };
  paintConfigLine();
  const scanMode = $("scan-mode");
  if (scanMode) scanMode.value = state.settings.scanMode === "visible" ? "visible" : "all";
  paintRemotePolicy();
  paintChartColumns();
  if ((state.settings.hiddenColumns || []).join(",") !== colsBefore) renderAll();
}

// ---- the anchor's two signals: hover and last touched, each switched and timed on its own ----------
function paintAnchorSettings() {
  const hover = $("anchor-hover");
  const hoverSeconds = $("anchor-hover-seconds");
  const touch = $("anchor-touch");
  const touchSeconds = $("anchor-touch-seconds");
  const flash = $("flash-time");
  const eventFlash = $("event-flash");
  const scanMode = $("scan-mode");
  if (hover) hover.checked = state.anchorHover;
  if (hoverSeconds) hoverSeconds.value = String(state.anchorHoverSeconds);
  if (touch) touch.checked = state.anchorTouch;
  if (touchSeconds) touchSeconds.value = String(state.anchorTouchSeconds);
  if (flash) flash.value = String(state.flashSeconds);
  const rankWindow = $("rank-window");
  if (rankWindow && document.activeElement !== rankWindow) rankWindow.value = String(state.rankWindowSeconds);
  if (eventFlash) eventFlash.checked = state.eventFlash;
  if (scanMode) scanMode.value = state.settings?.scanMode === "visible" ? "visible" : "all";
  paintRefreshAgent();
  applyFlashTime();
}

$("flash-time")?.addEventListener("input", (e) => {
  const raw = Number(e.target.value);
  const n = Number.isFinite(raw) ? Math.max(0, Math.min(5, Math.round(raw * 10) / 10)) : FLASH_TIME_DEFAULT;
  state.flashSeconds = n;
  saveFlashSeconds(n);
  applyFlashTime();
});

$("anchor-hover")?.addEventListener("change", (e) => {
  state.anchorHover = Boolean(e.target.checked);
  saveAnchorFlag(ANCHOR_HOVER_KEY, state.anchorHover);
  if (!state.anchorHover) {
    state.hoverThread = null;
    state.hoverAt = 0;
  }
  refreshAnchorBaseline();
});

$("anchor-hover-seconds")?.addEventListener("input", (e) => {
  const n = Math.max(1, Math.min(600, Math.round(Number(e.target.value)) || ANCHOR_HOVER_SECONDS_DEFAULT));
  state.anchorHoverSeconds = n;
  saveAnchorSeconds(ANCHOR_HOVER_SECONDS_KEY, n);
  refreshAnchorBaseline();
});

$("anchor-touch")?.addEventListener("change", (e) => {
  state.anchorTouch = Boolean(e.target.checked);
  saveAnchorFlag(ANCHOR_TOUCH_KEY, state.anchorTouch);
  if (!state.anchorTouch) {
    state.touchTarget = null;
    state.touchAt = 0;
  }
  refreshAnchorBaseline();
});

$("anchor-touch-seconds")?.addEventListener("input", (e) => {
  const n = Math.max(3, Math.min(600, Math.round(Number(e.target.value)) || ANCHOR_TOUCH_SECONDS_DEFAULT));
  state.anchorTouchSeconds = n;
  saveAnchorSeconds(ANCHOR_TOUCH_SECONDS_KEY, n);
  refreshAnchorBaseline();
});
// The two stream rows: a number each, with presets. A typed number is clamped on `change` (and Enter), because a
// per-keystroke clamp makes 20 impossible — 2 becomes the value before the 0 is typed.
$("stream-words")?.addEventListener("change", (e) => saveTypeWords(e.target.value));
$("stream-words")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  saveTypeWords(e.target.value);
  e.target.blur();
});
$("stream-lines")?.addEventListener("change", (e) => saveTypeLines(e.target.value));
$("stream-lines")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  saveTypeLines(e.target.value);
  e.target.blur();
});
for (const b of document.querySelectorAll("[data-stream-words-set]")) {
  b.addEventListener("click", () => saveTypeWords(b.dataset.streamWordsSet));
}
for (const b of document.querySelectorAll("[data-stream-lines-set]")) {
  b.addEventListener("click", () => saveTypeLines(b.dataset.streamLinesSet));
}
paintStreamSpeed();

$("contrast")?.addEventListener("input", (e) => applyContrast(Number(e.target.value)));
$("addbar-bright")?.addEventListener("input", (e) => applyAddBarBrightness(Number(e.target.value)));
$("addbar-top")?.addEventListener("change", (e) => applyAddBarTop(Boolean(e.target.checked)));
$("auto-collect")?.addEventListener("change", (e) => {
  try {
    localStorage.setItem(AUTO_COLLECT_KEY, e.target.checked ? "1" : "0");
  } catch {
    /* private mode */
  }
});
$("prev-turn-mode")?.addEventListener("change", (e) => applyPrevTurnMode(e.target.value));
// How a run of tool calls is drawn: the tallied group, or one expandable line per call. The shape is a render-time
// decision in every console, so the handler repaints them (setToolGroups does).
$("group-tools")?.addEventListener("change", (e) => setToolGroups(Boolean(e.target.checked)));
// Nothing on screen changes shape with this one: it is read at the moment a fold is pressed, so the answer is
// already in place for the next press.
$("follow-opened")?.addEventListener("change", (e) => setFoldFollow(Boolean(e.target.checked)));
$("show-thinking")?.addEventListener("change", (e) => {
  try {
    localStorage.setItem(THINK_KEY, e.target.checked ? "1" : "0");
  } catch {
    /* private mode: the default just will not persist */
  }
  // Only cards that have no answer of their own follow this.
  for (const c of conversations()) {
    let own = null;
    try {
      own = localStorage.getItem(`wtgui.think.${c.thread}`);
    } catch {
      /* ignore */
    }
    if (own === null) renderConversation(c.thread);
  }
});
$("term-weight-select")?.addEventListener("change", (e) => applyTermStyle({ save: true, weight: e.target.value }));

// The approval window. A preset only fills the box and lights Save: one click here rewrites the
// user's global Hermes config, so it takes a deliberate second one.
$("btn-approval-save")?.addEventListener("click", () => void saveApprovalSetting());
$("btn-session-limit-save")?.addEventListener("click", () => void saveSessionSetting());
$("btn-provider-save")?.addEventListener("click", () => void saveProviderSetting());
$("btn-provider-clear")?.addEventListener("click", (e) => void clearProviderKey(e.currentTarget));
$("btn-provider-default-url")?.addEventListener("click", () => {
  const url = $("provider-url");
  if (url) url.value = url.placeholder || "https://openrouter.ai/api/v1";
});
$("btn-models-refresh")?.addEventListener("click", () => void refreshModels());
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
  // The click's path was fixed when it was dispatched, so it still names the panel after an earlier handler has swapped
  // the pressed button out of the DOM. The Clean scratch buttons do exactly that (button -> cancel/clean pair -> button),
  // and `panel.contains(e.target)` calls a detached target "outside", which closed the drawer under the reader's press.
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  if (path.includes(panel) || panel.contains(e.target) || (e.target.closest && e.target.closest("#btn-settings"))) return;
  toggleSettings(false);
});

initFonts();
initQLook();
// The question countdowns move on their own; nothing else in the panel needs a 1s clock.
setInterval(tickQuestionClocks, 1000);
applyGreyFlash(greyFlashOn());
if ($("stabilize-reorder")) $("stabilize-reorder").checked = stabilizeOn();
applyContrast(contrastSetting(), { save: false });
applyAddBarBrightness(addBarBrightnessSetting(), { save: false });
applyAddBarTop(addBarAtTop(), { save: false });
if ($("show-thinking")) $("show-thinking").checked = thinkDefault();
if ($("group-tools")) $("group-tools").checked = toolGroupsOn();
if ($("follow-opened")) $("follow-opened").checked = foldFollowsConsole();
if ($("auto-collect")) $("auto-collect").checked = autoCollectOn();
if ($("prev-turn-mode")) $("prev-turn-mode").value = prevTurnMode();
void refreshSubagentRoster();
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

// The rank window: a number of seconds, saved in this browser like the other Display rows.
$("rank-window")?.addEventListener("change", (e) => saveRankWindow(e.target.value));
$("rank-window")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveRankWindow(e.target.value);
    e.target.blur();
  }
});
paintRankWindow();
startReorderClock();
paintReorderSetting();

// Reflect the remembered collapse state of the two fixed cards before the first paint of them.
for (const id of ["newagent", "agents"]) applyFixedCollapse(id);

// ---- what the page can see ---------------------------------------------------------------------------------
// In "on screen" mode the scheduler re-reads only the projects in view. Half a screen above and below counts too,
// so scrolling to the next project finds it already read instead of blank for a second. The report is a heartbeat:
// the server believes it for 45s, so a closed tab stops pinning the fleet to nothing.
const VISIBLE_MARGIN = 0.5;
let visibleSentAt = 0;
// The last list actually sent, and the last one merely sampled. A sample taken while the board is being rebuilt is
// not the truth: collapsed sections are ~60px tall, so a mid-repaint reading says half the fleet is on screen. Only
// a list that comes up the same twice in a row is sent.
let visibleKey = "";
let visibleSampleKey = "";
let visibleTimer = 0;

function visibleProjects() {
  const margin = window.innerHeight * VISIBLE_MARGIN;
  const names = [];
  for (const sec of document.querySelectorAll("#projects section.project[data-project]")) {
    const r = sec.getBoundingClientRect();
    if (r.height < 1) continue;
    if (r.bottom >= -margin && r.top <= window.innerHeight + margin) names.push(sec.dataset.project);
  }
  return names;
}

function reportVisibility({ force = false } = {}) {
  if (state.settings?.scanMode !== "visible") return;
  const names = visibleProjects();
  const key = names.join("|");
  const stable = key === visibleSampleKey;
  visibleSampleKey = key;
  if (!stable && !force) return; // still settling: the next sample decides
  const now = Date.now();
  if (!force && key === visibleKey && now - visibleSentAt < 15000) return;
  visibleKey = key;
  visibleSentAt = now;
  apiFetch("/api/visible", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projects: names }) }, { timeoutMs: 5000 }).catch(() => {
    /* a missed heartbeat only means the server falls back to reading everything for a while */
  });
}

function startVisibilityReporting() {
  const nudge = () => {
    clearTimeout(visibleTimer);
    // Two samples a beat apart: the first may catch a repaint, the second decides.
    visibleTimer = setTimeout(() => reportVisibility(), 260);
  };
  window.addEventListener("scroll", () => { visibleKey = ""; nudge(); }, { passive: true });
  window.addEventListener("resize", () => { visibleKey = ""; nudge(); });
  // Sampled often, sent rarely: a stable list is posted when it changes and as a 15s heartbeat (the server believes
  // a report for 45s, so a closed tab stops pinning the fleet after a few missed beats).
  setInterval(() => reportVisibility(), 3000);
  setInterval(() => reportVisibility({ force: Date.now() - visibleSentAt > 15000 }), 5000);
}

startVisibilityReporting();

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
    startAnchorObserver();
    updateColorsRow();
    paintAnchorSettings();
    paintAgeSetting();
    paintChartColumns();
    paintRemotePolicy();
    paintAgentCleanup();
    void refreshRemoteGuards();
    // "On screen" mode: say what is visible before the first paint settles, so the rows in front of the reader are
    // the first thing the scheduler reads.
    reportVisibility({ force: true });
    state.eventsAt = Date.now();
  } catch (e) {
    setStream("offline", "bad");
    showBanner(`Cannot reach the server: ${e.message}. Start it with npm start.`);
  }
})();
