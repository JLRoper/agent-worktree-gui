// Worktree Monitor client.
//   - worktree rows are patched individually from the SSE stream
//   - liveness is shown as labelled evidence chips (files / hermes / board / port)
//   - agents spawned from the "New agent" card stream their stdout live

// ---- the DOM helpers live in public/dom.js, and are re-exported here ------------------------------
//
// The page's DOM primitives were cut out of this file into public/dom.js: the two cached node lookups
// (rowNode, projectNode), the class-animation restart, the caret-safe move bracket (beginDomMove,
// endDomMove), the selection save and restore (selectionIn, captureCardSelection, restoreCardSelection,
// with offsetIn and pointAt under them, and cardForThread), and the clipboard writer (copyText). That is
// step 2 of docs/reports/module-map-2026-11-07.html's order of work, and it was a move, not a rewrite:
// nothing was renamed and no call site changed. public/dom.js is a classic script the shell loads
// immediately before this one, so its top-level declarations are page-wide and every bare name here is
// the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for
// any module that would rather reach it than a page global.
window.WMApp = window.WMApp || {};
window.WMApp.dom = {
  rowNode, projectNode, restartClassAnimation, beginDomMove, endDomMove,
  selectionIn, captureCardSelection, restoreCardSelection, offsetIn, pointAt, cardForThread,
  copyText,
};

// ---- the chart's own code lives in public/charts.js, and is re-exported here -----------------------
//
// The worktree chart's code was cut out of this file into public/charts.js: the 9 chart* functions the module
// map names (chartTopLimit, chartTopOrder, chartTopSplit, chartDrawOrder, chartHeaderHtml, chartTopStored,
// chartTopSentence, chartColumnsStored, chartColumnsSentence) and the sections they head - the top-N collapse
// and its arrow, the chart's column list and header, and the readers and painters behind the two chart settings
// rows. That is step 3 of docs/reports/module-map-2026-11-07.html's order of work, and it was a move, not a
// rewrite: nothing was renamed and no call site changed. public/charts.js is a classic script the shell loads
// before this one, so its top-level declarations are page-wide and every bare name here is the same binding it
// was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for any
// module that would rather reach it than a page global.
window.WMApp.charts = {
  chartTopLimit, chartTopOrder, chartTopSplit, chartDrawOrder, chartHeaderHtml,
  chartTopStored, chartTopSentence, chartColumnsStored, chartColumnsSentence,
  rowActivityAt, rowTopHidden, heldRowCount, topToggleTitle, topSlotHtml, paintTopToggle,
  refreshTopToggle, toggleShowOld,
  CHART_COLUMNS, WT_COLS, COL_MIN, COL_GIVE, OWNER_COLUMN_ID, hiddenColumnIds, ownerMatters,
  shownColumns, wtColspan,
  legacyAgeNote, paintTopSetting, saveTopSetting, paintChartColumns, saveChartColumns,
};

// ---- the deliverables list lives in public/deliverables.js, and is re-exported here ------------------
//
// The list was cut out of this file into public/deliverables.js: step 3 of docs/reports/module-map-2026-11-07.html's
// order of work ("charts.js and deliverables.js out of app.js"), the report's "27 deliver* functions and their UI".
// It was a move, not a rewrite: nothing was renamed and no call site changed. The page's wiring for the list (the
// button's press, the first read, the poll, and the close/place listeners) stays in this file, below, because it
// runs at this file's load and needs `state`.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for any
// module that would rather reach it than a page global.
window.WMApp.deliverables = {
  deliver, DELIVER_DEFAULT_CAP, deliverGeo, DELIVER_POLL_MS,
  deliverPopEl, openDeliverPop, closeDeliverPop, toggleDeliverPop, deliverKindChipsHtml, deliverTabStops,
  toggleDeliverKind, paintDeliverKinds,
  deliverZoom, deliverSpace, clampDeliverRect, paintDeliverRect, clearDeliverRect, deliverStoredRect,
  deliverRemember, deliverForget, deliverStoredFits, deliverRestore, deliverPosition,
  deliverGestureStart, deliverGestureMove, deliverGestureEnd,
  deliverList, deliverFetch, paintDeliverRows, deliverRowHtml, deliverLinkLabel, deliverDayLabel,
  deliverMarkActive, paintDeliverAges, deliverKeydown,
  deliverUnseenCount, paintDeliverBadge, deliverMarkSeen,
  deliverOpenTarget, deliverOpenOnServer, deliverTargetName, sayDeliverOpened, sayDeliverWhy, clearDeliverWhy,
  deliverOpenAgent, deliverOpenWorktree,
  deliverPollTick, deliverHookStream,
};

// ---- the turn's own face lives in public/turns.js, and is re-exported here -------------------------
//
// The turn surface was cut out of this file into public/turns.js: the list a card pages through (conversations,
// turnOrder, turnSeqOf), the fold book's three names (turnKey, turnIsOpen, toggleTurn), the origin chips and the
// session-replaced chip, the head and the two ways a turn is drawn shut (turnHead, inlinePrompt, displayPrompt,
// turnAttachmentsHtml, turnPeekLine, compactHtml, peekHtml, refreshTurnPeek), and the two display switches
// (thinkingOn, setThinking, streamOn, setStreamMode and their defaults). That is step 4 of
// docs/reports/module-map-2026-11-07.html's order of work, and it was a move, not a rewrite: nothing was renamed
// and no call site changed. public/turns.js is a classic script the shell loads after charts.js and before this
// one, so its top-level declarations are page-wide and every bare name here is the same binding it was before
// the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for any
// module that would rather reach it than a page global.
window.WMApp.turns = {
  conversations, turnOrder, turnSeqOf,
  turnKey, turnIsOpen, toggleTurn,
  originHtml, originAttributionHtml, isWatchdogTurn, watchdogHtml, watchdogPromptText, sessionReplacedHtml,
  turnHead, inlinePrompt, displayPrompt, turnAttachmentsHtml, turnPeekLine, firstSentence, compactHtml, peekHtml,
  refreshTurnPeek,
  THINK_KEY, thinkDefault, thinkingOn, setThinking,
  STREAM_KEY, SHOW_STREAM_KEY, showStreamButton, streamDefault, streamOn, setStreamMode,
};

// ---- the settings appliers live in public/settings.js, and are re-exported here ---------------------
//
// The 32 apply* functions were cut out of this file into public/settings.js: the page's look (zoom, fonts,
// text styles, contrast, the add-agent bar, the flash and the question box), the board's folds and its project
// hue, the settings payloads (the snapshot merge, the provider profile, the scan roots, the remote-write
// policy), approvals and turns, the chart's columns, the snapshot and focus appliers, and the skills folds.
// That is step 6 of docs/reports/module-map-2026-11-07.html's order of work, and it was a move, not a rewrite:
// nothing was renamed and no call site changed. public/settings.js is a classic script the shell loads after
// turns.js and before this one, so its top-level declarations are page-wide and every bare name here is the
// same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for any
// module that would rather reach it than a page global.
window.WMApp.settings = {
  applyFixedCollapse, applyRootCollapse, applyRootFilter, applyProjectCollapse,
  applyApprovalAnswered, applyQLook, applyQuestionAnswered,
  applyPreviousTurnPlan, applyPrevTurnMode,
  applyApprovalsFold, applyRemoteWrites, applyPendingFocus, applyRowRank,
  applyProjectHue, applyFlashTime,
  applyColumnWidths, applyFitMode, applyStabilize,
  applyJobSnapshot, applySnapshot,
  applyZoom, applyFont, applyTermStyle, applyTextStyle, applyContrast,
  applyAddBarBrightness, applyAddBarTop, applyGreyFlash,
  applySkillsFold, applyProviderProfile, applyScanRootsAnswer, applySettings,
};

// ---- the board's projects, sections and rows live in public/render-projects.js, and are re-exported here ----
//
// The project half of the board was cut out of this file into public/render-projects.js: the folder's card and its
// counts (rootScanChip, rootChips, rootSection), the project section with its head and chips (projectSection,
// refreshChips), the worktree row and the age column under it (rowHtml and the ring), the children under their
// parent and the one fold that hides them, where a folder and a project sit (projectRanks, sortedProjects,
// pinOpenProjects, reorderProjects and the queue that coalesces it), and the order a row's cards sit in
// (stabilizeOn, orderedAgents, reorder, the move flashes), with placeRow, queueRow, removeRow and
// renderProjectRows ending it. That is step 7 of docs/reports/module-map-2026-11-07.html's order of work, and it
// was a move, not a rewrite: nothing was renamed and no call site changed. public/render-projects.js is a classic
// script the shell loads after settings.js and before this one, so its top-level declarations are page-wide and
// every bare name here is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for any
// module that would rather reach it than a page global.
window.WMApp.projects = {
  projectActivity, folderActivity, shownInRoot, projectRanks, pinOpenProjects, sortedProjects,
  reorderFrame, queueReorderProjects, childrenMatching, boardGroups, groupBody, reorderProjects,
  rootScanChip, rootChips, rootSection, projectSection, refreshChips,
  childTreeOf, groupCtxOf, nestRowKeys, foldTitle, foldButtonHtml, paintFoldButton, paintRowGroup,
  paintUnder, markUnder, syncChildGroups, toggleChildFold, rowHtml,
  RING_C, noteScan, eventLifeAt, lifeAtFor, ringState, ringOffset, ringStroke, ageCellHtml, paintAgeCell,
  rowKeyForThread, pulseRow, pulseProject,
  STABILIZE_KEY, stabilizeOn, projectHasOpenRow, rowHasOpenCard, orderedAgents, rememberAgentOrder,
  rememberAgentOrders, reorder, flashMovedByKey, flashMoved, pendingRows, rowFrame, DETAIL_VOLATILE,
  stableStringify, rowDetailSig, queueRow, placeRow, removeRow, renderProjectRows,
};

// ---- the job card and its turns live in public/render-jobs.js, and are re-exported here --------------------
//
// The card half of the board was cut out of this file into public/render-jobs.js: the body a turn draws
// (streamBodyHtml, mdRunHtml, condensedBodyHtml, turnBody), the block a turn sits in (turnBlock), the card itself
// (conversationHtml and jobHtml, which wraps one homeless run in the same card), and the render and update path
// that keeps them on the page (queueJobsRefresh, scheduleRenderJobs, renderJobs, paintAgentBadges, updateJob,
// conversationSignature, paintCardMeta, renderConversation). That is step 7 of
// docs/reports/module-map-2026-11-07.html's order of work, the second of its two big cuts, and it was a move, not
// a rewrite: nothing was renamed and no call site changed. public/render-jobs.js is a classic script the shell
// loads after render-projects.js and before this one, so its top-level declarations are page-wide and every bare
// name here is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for any
// module that would rather reach it than a page global.
window.WMApp.jobs = {
  streamBodyHtml, mdRunHtml, condensedBodyHtml, turnBody, turnBlock,
  conversationHtml, jobHtml,
  jobsRefreshQueued, queueJobsRefresh, renderJobsQueued, scheduleRenderJobs,
  renderJobs, paintAgentBadges, updateJob, conversationSignature, paintCardMeta, renderConversation,
};

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
// Which parents the reader has folded shut, as a set of row keys. Declared up here for the same reason as
// SHOW_OLD_KEY: `state` reads this key while it is being built, and a const declared below it is still in its dead
// zone at that moment — the loader's try/catch would swallow the ReferenceError and the choice would be written and
// never read back. A fold is the reader's picture of the board, so it is remembered like every other fold they own.
const FOLDED_PARENTS_KEY = "wtgui.foldedParents";

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
  // thread -> px. Ctrl+wheel anywhere over a card's console text sizes that card, all three kinds at once — its own
  // words, a tool's output and the agent's reasoning — like a terminal window; the Settings "Console size" stays the
  // baseline for every card. Kept in memory so a repaint does not undo it (the card re-emits it in its markup).
  consoleZoom: new Map(),
  // Two per-console views the reader owns, kept by TURN (not on the node): a card is repainted on every job event
  // and every scan, and a class or an attribute added to the old element dies with it. `consoleRaw` shows the
  // turn's own bytes; `consoleFocus` hides the tool rows and leaves the prose, the errors and the final message.
  consoleRaw: new Set(),
  consoleFocus: new Set(),
  // HUMAN's amber ring on a card: held here, not only on the DOM node, because opening a project or a row
  // repaints the card and a class added to the old element dies with it. The renderer re-applies it until the
  // window closes. (The NOT-RUNNING rotation that first drew this ring is gone; HUMAN kept the ring.)
  hotFlash: { thread: null, until: 0 },
  hotFlashTimer: null,
  // HUMAN: the rotation through every OPEN permission and clarify question. `key` is the question last shown
  // and `at` its place in that sample; `sig` is what was last painted on the button. The list itself is never
  // stored — it is rebuilt from live state on every press, so an answered question cannot linger in it.
  human: { key: null, at: -1, sig: "" },
  humanFlashTimer: null,
  // The prompt a HUMAN hop just landed on, held for a beat so the repaint a row-opening causes puts the ring and
  // the caret back instead of dropping them: { thread, turnId, kind, until }.
  humanFocus: null,
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
  // The height the reader DRAGGED a console to, per console (pre[data-out]), in px. Same reason as the scroll above and
  // easier to see going wrong: a rebuild that replaces the box, or builds it from nothing, throws the inline height away
  // with the node, and the console comes back on its cap (a long transcript) or at its content height (a short one).
  // Persisted, like the card fold state: the number is the reader's own, and a reload is not a reason to forget it.
  outHeights: loadOutHeights(),
  collapsedJobs: loadCollapsedJobs(),
  // One timer per collapsed parent (`kind:id`), for the cascade above: a parent left collapsed for
  // `collapseAfterSeconds` writes every card under it into `collapsedJobs`. Never persisted — a reload has no
  // collapse to time, and a parent that arrives collapsed is not a decision this session made.
  collapseTimers: new Map(),
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
  // Which projects' charts are showing every tree, count or not (see the top-N collapse below). Per project,
  // because one board holds a hundred of them.
  showOldProjects: loadShowOldProjects(),
  // The parents the reader folded shut: row keys whose children are out of sight (see childTreeOf). A fold is a
  // picture of the board, never a write, so it is remembered in this browser beside every other fold the reader owns.
  foldedParents: loadFoldedParents(),
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
  // Instrumentation for the permission-prompt proof: the last count `/api/state` carried in `approvals`, when it
  // changed, and the ids. An empty `/api/approvals` beside a non-zero count here says the page's own run feed
  // carried the prompt and the plugin's long-poll feed was simply never used.
  approvalsSeen: { at: 0, count: -1, ids: [] },
  scanRoots: [],
  // path (lowercased) -> { exists } as /api/config last answered. The folders list in Settings → Board draws one row
  // per configured root and says whether that folder is still there, which the server has to stat for; it is kept
  // here rather than in `settings` because it is a fact about the disk, not about the setting.
  scanRootsDetail: new Map(),
  pollGap: new Map(), // key -> observed seconds between that row's scans, smoothed
  lastScanAt: new Map(), // key -> ms of the previous scan we rendered
  // The transcript renderer's own books: which turn copies are open, which are frozen to a snippet, and which page of
  // turns a card shows. Written ONLY through public/core/turn-fold.js — the module owns the keys, the defaults, the
  // pager arithmetic and the fold-on-page gesture; these fields are read by the renderer and by the card's signature.
  turnOpen: new Map(), // key -> whether that copy of the turn is open (default: the newest turn of a card)
  // Turns that were showing their body when the reader sent the next one: they keep their answer and last tool
  // line, and lose the thinking block and the tool chatter. Not folded all the way to a one-line peek - that
  // shrink is what used to drag the reply box out from under the reader's hands.
  turnCompact: new Set(),
  turnPage: new Map(), // thread -> how many pages of turns back from the newest (absent = the newest page)
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
  // `assistantThreads` is EVERY assistant thread — #1's and any created from a role — because each of them is a
  // conversation with no worktree, a home in the float and nothing to count on the board.
  assistantThread: "panel-assistant",
  assistantThreads: ["panel-assistant"],
  assistant: null,
};

// The assistant session a conversation belongs to, or null when it is an agent's. A thread is an assistant's when
// one of the records the server sent names it; before that first /api/assistant answer, Assistant #1's fixed thread
// is the only assistant thread there is. Every "is this a board agent" question goes through here, because with
// roles there is more than one assistant thread and comparing against #1's alone leaves #2 counted as a worker.
// `board` is a parameter for the same reason `rootOf`'s roots is: a pure reader of a state object it was handed
// must not consult the module's own.
function assistantSessionFor(thread, board = state) {
  const t = String(thread || "");
  if (!t) return null;
  const list = board.assistant?.assistants;
  // A thread a hard restart left behind is still that assistant's: its card keeps the assistant's name and stays off
  // the board's agent count, exactly as it did before the restart moved the assistant to a new thread.
  const hit = Array.isArray(list)
    ? list.find((a) => a.threadId === t || (Array.isArray(a.previousThreads) && a.previousThreads.includes(t)))
    : null;
  if (hit) return hit;
  if (t === board.assistantThread) return { id: "assistant-1", name: "Assistant #1", threadId: t };
  return null;
}

// ---------------- agents ----------------
// A turn's console buffer. A turn the tab has watched streaming has an array of its own in `state.jobLines`; a turn
// it has not - a reload, a card for a turn that settled before this page opened - draws the record's own tail, which
// is the same 60 lines a reload has always shown. Reading it from the record instead of copying it into a second
// array is what keeps a settled turn's tail from being retained twice (measured: 60 extra line objects per turn on a
// 240-turn board).
function jobLines(id) {
  const own = state.jobLines.get(id);
  if (own) return own;
  const rec = state.jobs.get(id);
  return Array.isArray(rec?.lines) ? rec.lines : [];
}

// The per-turn caps bound ONE turn (public/board/console.js trims a buffer to 600, the number lib/jobs.js keeps), and
// they say nothing about a tab that has watched hundreds of turns: every one of them keeps its array for the life of
// the page. This is the ceiling on how many turn buffers the tab holds, newest first. A settled turn past it draws
// its record's tail - exactly the console a reload gives it - so eviction costs nothing that a refresh would not
// have cost anyway. A live turn is never evicted: its buffer is where the frames arriving now are going.
const MAX_TURN_BUFFERS = 120;

function trimJobLines() {
  if (state.jobLines.size <= MAX_TURN_BUFFERS) return 0;
  let dropped = 0;
  for (const id of [...state.jobLines.keys()]) {
    if (state.jobLines.size <= MAX_TURN_BUFFERS) break;
    // Map order is the order the buffers were first written, which for a board is the order the turns started.
    if (turnLive(state.jobs.get(id))) continue;
    state.jobLines.delete(id);
    dropped += 1;
  }
  return dropped;
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

// ---- the height a console was dragged to ------------------------------------------------
// A console is a browser-resized box (`resize: vertical` under a max-height), so the size the reader gave it lives in
// one place: the inline style of the <pre> they dragged. Every path that BUILDS a card from conversationHtml - a status
// change, a new turn, a fold, a project collapse, the unattached list - and every path that REPLACES one throws that
// node away and with it the number, so the box comes back at whatever a fresh box measures: its cap when the transcript
// is long, its content height when it is short. The height therefore has to live outside the DOM, the way the scroll
// position does (state.outScrolls), and it is persisted the way the card fold state is, because a reload rebuilds every
// card on the board and case 7 of the measurement (C:/CodeReviews/agent-worktree-gui/resize/rebuild.md) was exactly
// that loss: 420 px dragged, 320 px after the reload.
//
// What is stored is the number itself, keyed by the id the console carries (`pre.dataset.out`, the turn id, with `@pin`
// on a pinned copy). Whether it is above the cap is NOT stored: the cap belongs to where the box is drawn (320 px in a
// worktree row's agents block, 230 px in the unattached workspace, public/style.css), so it is read off the page when
// the height is put back rather than remembered against it.
function loadOutHeights() {
  try {
    const raw = JSON.parse(localStorage.getItem("wm.outHeights") || "{}");
    const out = {};
    for (const [id, px] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
      const n = Number(px);
      if (id && Number.isFinite(n) && n > 0) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function saveOutHeights() {
  try {
    localStorage.setItem("wm.outHeights", JSON.stringify(state.outHeights));
  } catch {
    /* no storage available: a dragged height just won't survive a reload */
  }
}

// The reader let go of a console at a height they chose. Called from the pointerup of a drag that MOVED — a press on
// the corner that moved nothing is not a resize and records nothing.
function rememberOutHeight(id, px) {
  const n = Number(px);
  if (!id || !Number.isFinite(n) || n <= 0) return;
  state.outHeights[id] = n;
  saveOutHeights();
}

// A stored height belongs to a turn: once the turn is gone from the board the entry is dead weight, the same way a
// cleared job's turn state is (renderJobs prunes state.turnOpen and state.collapsedJobs on the same set). `@pin` marks
// a copy OF a turn, so it is pruned on the turn it copies. Returns how many went, so the caller can say so.
function pruneOutHeights(live) {
  let gone = 0;
  for (const id of Object.keys(state.outHeights)) {
    if (live.has(String(id).replace(/@pin$/, ""))) continue;
    delete state.outHeights[id];
    gone += 1;
  }
  if (gone) saveOutHeights();
  return gone;
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

function toggleFixed(name) {
  if (!name) return;
  if (state.collapsedFixed.has(name)) state.collapsedFixed.delete(name);
  else state.collapsedFixed.add(name);
  saveCollapsedFixed();
  scheduleCollapseCascade("fixed", name, state.collapsedFixed.has(name));
  applyFixedCollapse(name);
  // Collapsing the Agents card and expanding it again must not lose the reply drafts or the
  // scroll position of a running turn: nothing is destroyed, the body is only hidden.
}

// Opening a project is the reader's own promotion signal: the server re-probes an old repo and re-reads its
// rows when one is opened (POST /api/project/open), so an old section is current the moment it is unfolded
// instead of waiting up to an hour for its stat slice. Fire and forget - the rows arrive over SSE - and one
// report per project a minute, so folding and unfolding a section is not a request each time.
const projectOpenSentAt = new Map();
function noteProjectOpen(name) {
  if (!name) return;
  const now = Date.now();
  if (now - (projectOpenSentAt.get(name) || 0) < 60000) return;
  projectOpenSentAt.set(name, now);
  apiFetch("/api/project/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: name }) }, { timeoutMs: 5000 }).catch(() => {
    /* a missed report only means the section keeps its last-known rows until its next stat slice */
  });
}

function toggleProject(name) {
  if (!name) return;
  if (state.expandedProjects.has(name)) state.expandedProjects.delete(name);
  else {
    state.expandedProjects.add(name);
    noteProjectOpen(name);
  }
  saveExpandedProjects();
  scheduleCollapseCascade("project", name, !state.expandedProjects.has(name));
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
// The window the SERVER's tier gate uses (`settings.tierDays`). The All/7d button reads it so a config that moves
// the window moves the button with it; RECENT_DAYS is only the fallback for a snapshot from a build that predates
// the gate. The page decides no tier itself: `shownInRoot` filters on the server's `project.tier`.
function recentDays() {
  const n = Number(state.settings?.tierDays);
  return Number.isFinite(n) && n > 0 ? n : RECENT_DAYS;
}

// The chart's top-N collapse. A chart draws the first `chartTopCount` rows of `chartTopOrder` — last activity newest
// first, then by name — and one arrow at the bottom of that chart lists the rest in that same order. Both halves of
// that choice are remembered where a reload keeps them: the COUNT in the panel's own config.json (so it applies to
// every browser, and to the panel after a restart), and which charts are showing everything in this browser, per
// project, exactly like the folder-level All/7d choice above. The key itself is declared above `state`, which is what
// reads it — and it is deliberately still called "old" because the reader's remembered charts are the same choice,
// whatever the chart was holding them back by.
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

// The parents the reader folded shut (see childTreeOf / syncChildGroups). Only FOLDS are remembered: a parent nobody
// folded is open, so the set starts empty and a reload puts the board back the way it was left.
function loadFoldedParents() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_PARENTS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveFoldedParents() {
  try {
    localStorage.setItem(FOLDED_PARENTS_KEY, JSON.stringify([...state.foldedParents]));
  } catch {
    /* no storage: the fold simply will not persist */
  }
}

const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

// ---- the project a card's tree belongs to ---------------------------------------------------
// A card inside a tree should not spend its chrome on the bare word "worktree": every card on that row is
// one. What the head cannot show is which REPOSITORY the tree was cut from, and that is the segment above
// `.worktrees` — the project's own directory:
//   C:/ProjectDevelopment/agent-worktree-gui/.worktrees/foo-1234  ->  agent-worktree-gui
// A path with no `.worktrees` in it (the project's own checkout, a tree cut by hand somewhere else) resolves
// nothing, and the card keeps the bare word.
function projectOfTree(p) {
  const parts = normPath(p).split("/").filter(Boolean);
  const at = parts.lastIndexOf(".worktrees");
  return at > 0 ? parts[at - 1] : "";
}

// Longest matching scan root wins, so a nested root groups under the more specific folder.
// No match means the project lives outside every root: group it under its own parent folder.
// `roots` is a parameter so a pure reader (the collapse tiers' selector) can answer from the state it was handed
// instead of whatever the module happens to hold; every page caller keeps the live list by omitting it.
function rootOf(project, roots = state.scanRoots) {
  // Discovery tags every project with the root it was found under (`root`), so this is the server's answer rather
  // than a guess from the path. The path match below stays for the records that have no tag: a project config.json
  // names directly (discovery never walks it under a root) and a project read from an older discovery cache.
  const tagged = normPath(project && project.root);
  if (tagged) return tagged;
  const raw = normPath(project.path);
  const lower = raw.toLowerCase();
  if (!lower) return "(unknown folder)";
  const list = (roots || []).map(normPath).filter(Boolean);
  const match = list
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
  scheduleCollapseCascade("root", root, state.collapsedRoots.has(root));
  applyRootCollapse(root);
  paintCollapseAll();
}

// ---- the collapse cascade -----------------------------------------------------
// A folder, a project, a worktree row and the two fixed cards are accordions, and folding one is a decision about
// everything under it — but only the container's own fold was ever written down: the cards inside kept whatever fold
// they had, so a project left closed for a while came back as a wall of open transcripts.
//
// A collapsed parent now holds ONE timer, keyed by the parent itself (`kind:id`). When it fires, every card under
// that parent is written into `wm.collapsedJobs` — the persisted set `conversationHtml` reads on load — and the cards
// still in the page are rebuilt from it, because a folder's section and the fixed cards keep their DOM through a
// collapse. The next expand therefore draws them minimized. This is durable state, not an animation: nothing here is
// a CSS transition, and nothing is hidden by a class the set does not carry.
//
// The clock is the parent's own. Collapsing it again restarts the clock, expanding it cancels the clock, and an
// expand NEVER takes a child out of the set — a child's fold belongs to the child, and only that card's own toggle
// (or Minimize all) writes it.
const COLLAPSE_CASCADE_DEFAULT_SECONDS = 30;
const COLLAPSE_CASCADE_MAX_SECONDS = 3600;

function collapseAfterSeconds() {
  const n = Number(state.settings?.collapseAfterSeconds);
  if (!Number.isFinite(n) || n < 0) return COLLAPSE_CASCADE_DEFAULT_SECONDS;
  return Math.min(COLLAPSE_CASCADE_MAX_SECONDS, n);
}

const collapseTimerKey = (kind, id) => `${kind}:${id}`;

// The path a card is filed under: the worktree it runs in, or the project's own checkout.
function cardOwnerPath(conv) {
  return normPath(conv?.latest?.ownerPath || conv?.first?.ownerPath || "").toLowerCase();
}

// Every card the page draws under one parent, resolved by the same facts the renderer files them by: a row owns the
// cards whose cwd is that tree, a project owns its rows' cards, a folder owns the cards of the projects grouped under
// it, and the Agents card owns the cards no row claims. The assistant is a conversation but not a board card.
function cardsUnderParent(kind, id) {
  const convs = conversations().filter((c) => !assistantSessionFor(c.thread));
  const rows = [...state.rows.values()];
  const pathSet = (list) => new Set(list.map((r) => normPath(r.path).toLowerCase()));
  let paths;
  if (kind === "row") {
    const row = state.rows.get(id);
    paths = new Set(row ? [normPath(row.path).toLowerCase()] : []);
  } else if (kind === "project") {
    paths = pathSet(rows.filter((r) => r.project === id));
  } else if (kind === "root") {
    paths = pathSet(
      rows.filter((r) => {
        const project = state.projects.get(r.project);
        return Boolean(project) && rootOf(project) === id;
      }),
    );
  } else if (kind === "fixed" && id === "agents") {
    const every = pathSet(rows);
    return convs.filter((c) => !every.has(cardOwnerPath(c))).map((c) => c.thread);
  } else {
    return [];
  }
  return convs.filter((c) => paths.has(cardOwnerPath(c))).map((c) => c.thread);
}

// The cascade itself: write every card under the parent into the persisted set, then rebuild the ones still on the
// page. A folder's section and the fixed cards keep their cards in the DOM while collapsed, so without the rebuild
// the next expand would draw the expanded node the reader built before the timer fired.
function cascadeCollapse(kind, id) {
  const added = cardsUnderParent(kind, id).filter((t) => !state.collapsedJobs.has(t));
  if (!added.length) return 0;
  for (const thread of added) state.collapsedJobs.add(thread);
  saveCollapsedJobs();
  for (const thread of added) {
    if (!document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)) continue;
    renderConversation(thread);
  }
  return added.length;
}

// Collapsing a parent starts its clock; expanding it stops the clock. `collapsed` is the state AFTER the toggle.
function scheduleCollapseCascade(kind, id, collapsed) {
  clearCollapseCascade(kind, id);
  if (!collapsed) return null;
  const seconds = collapseAfterSeconds();
  if (!(seconds > 0)) return null; // 0 disables the cascade: a collapsed parent leaves its children alone
  const key = collapseTimerKey(kind, id);
  const timer = setTimeout(() => {
    state.collapseTimers.delete(key);
    cascadeCollapse(kind, id);
  }, Math.round(seconds * 1000));
  state.collapseTimers.set(key, timer);
  return timer;
}

function clearCollapseCascade(kind, id) {
  const key = collapseTimerKey(kind, id);
  if (!state.collapseTimers.has(key)) return false;
  clearTimeout(state.collapseTimers.get(key));
  state.collapseTimers.delete(key);
  return true;
}

// Expand-all and collapse-all answer for every parent at once, so every pending clock goes with the gesture: a timer
// that outlived it would fold cards the reader had just opened.
function clearEveryCollapseCascade() {
  for (const timer of state.collapseTimers.values()) clearTimeout(timer);
  state.collapseTimers.clear();
}
// ---- end the collapse cascade

// ---- filter one folder's projects ---------------------------------------------
// A folder can hold ninety projects. The box in its header narrows the list to those whose name or path
// contains the query. Sections are hidden in place rather than re-rendered, so typing keeps the caret and
// clearing the box brings back exactly the projects (and the open ones) that were there before.
function rootFilterValue(root) {
  return String(state.rootFilter.get(root) || "");
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
    scheduleCollapseCascade("project", n, collapse);
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
  return boardGroups().map((s) => s.dataset.root).filter(Boolean);
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
  // This button is the one-press gesture and says so; the bracket on the left peels one tier at a time, so a title
  // promising it would close the tree is a promise the key no longer keeps.
  btn.title =
    `${open ? "collapse" : "expand"} the whole tree — every folder, project, worktree row, card and turn ` +
    `(${boardRoots().length} folders, ${names.length} projects) in one press; ` +
    "Ctrl+[ folds one tier per press (turns, cards, rows, projects, folders); Ctrl+] expands everything";
}

// One direction at a time. The header button must toggle (one button, two words), but a hotkey that
// only toggled would be a coin flip — the reader asks to collapse and gets whatever the board's state
// happened to imply. So the action lives here and both callers say which way they mean.
function setEverythingOpen(open) {
  const names = [...state.projects.keys()];
  const roots = boardRoots();
  if (!names.length && !roots.length) return;
  // Every parent's clock goes with this gesture, either way: collapse-all writes every card itself (so no cascade is
  // left to run), and expand-all must not leave a timer that folds a card the reader just opened.
  clearEveryCollapseCascade();
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
    wtTurnFold.foldAll(state, c.turns || [], state.pinnedTurns, open);
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

// ---- collapse one tier ---------------------------------------------------------
// Ctrl+[ peels the board back one layer per press: the deepest accordion that still holds something open goes
// first, then the next one up. Five tiers in this order — the turn bodies inside a card, the agent cards, the
// worktree rows, the project sections, and the folder roots together with the two fixed cards. The last tier
// is one tier because a folder holds no project of its own and the two fixed cards sit above every folder.
// The header's "Collapse all" button stays the one-press gesture; this is its peel-one-layer sibling, and the
// difference is what the button's own title says.
const COLLAPSE_TIERS = ["turns", "cards", "rows", "projects", "folders"];

// The folders the board draws, derived from the facts the renderer groups by (a project outside every scan root
// is filed under its own folder). A selector that read `boardRoots()` would need the DOM; this one never does.
function boardRootsOf(state) {
  const roots = new Set();
  for (const project of state.projects.values()) roots.add(rootOf(project, state.scanRoots));
  return [...roots];
}

// The board cards the fold set belongs to: one per conversation, minus the assistant — it is a conversation but
// not a card, is drawn in its own float, and never carries a `wm.collapsedJobs` entry. Counting it would hold
// the cards tier open forever.
function cardThreadsOf(state) {
  const threads = new Set();
  for (const turn of state.jobs?.values?.() || []) {
    const thread = turn.thread || turn.id;
    if (thread && !assistantSessionFor(thread, state)) threads.add(thread);
  }
  return [...threads];
}

// The turn a card draws open when nothing says otherwise: its newest, in the order `conversations()` sorts by.
function latestTurnOf(state, thread) {
  let latest = null;
  for (const turn of state.jobs?.values?.() || []) {
    if ((turn.thread || turn.id) !== thread) continue;
    if (!latest || turnOrder(turn, latest) > 0) latest = turn;
  }
  return latest;
}

// Anything open in one tier, read from that tier's own book. The two closed sets (`collapsedJobs`,
// `collapsedRoots`/`collapsedFixed`) say nothing about a member nobody ever wrote, so the universe they range over
// comes from the board's own facts rather than from the set's size.
function tierHasOpen(state, tier) {
  if (tier === "turns") {
    for (const open of state.turnOpen.values()) if (open) return true;
    // A card whose newest turn has no entry is painted open (`turnIsOpen`), and a body on screen counts.
    return cardThreadsOf(state).some((thread) => {
      const latest = latestTurnOf(state, thread);
      return Boolean(latest) && state.turnOpen.get(turnKey(latest)) !== false;
    });
  }
  if (tier === "cards") return cardThreadsOf(state).some((thread) => !state.collapsedJobs.has(thread));
  if (tier === "rows") return state.expanded.size > 0;
  if (tier === "projects") return state.expandedProjects.size > 0;
  if (tier === "folders") {
    return (
      boardRootsOf(state).some((root) => !state.collapsedRoots.has(root)) ||
      FIXED_CARDS.some((id) => !state.collapsedFixed.has(id))
    );
  }
  return false;
}

// Pure: the state handed in is the whole input — no DOM, no writes, no module state — so the same board always
// answers the same tier. `null` is a board with nothing open, and the hotkey must treat that as a NO-OP rather
// than fall through into expanding.
function nextCollapseTier(state) {
  return COLLAPSE_TIERS.find((tier) => tierHasOpen(state, tier)) || null;
}

// One press, one tier. Only the sets this gesture wrote are saved, and the parent tiers arm their cascade clock
// exactly as a click on that parent does — the hotkey is not a way around it. No tier here writes a CHILD's fold:
// folding a project leaves its rows and cards as they were, which is what the lower tiers are for.
function collapseOneTier() {
  const tier = nextCollapseTier(state);
  if (!tier) return null;
  if (tier === "turns") {
    // One direction for every conversation, and the module knows both copies of a starred turn.
    for (const conv of conversations()) wtTurnFold.foldAll(state, conv.turns || [], state.pinnedTurns, false);
    // `turnOpen` is the session's own fold book (not persisted), so the tiers below leave it alone: the paint is
    // the whole save.
    for (const conv of conversations()) renderConversation(conv.thread);
  } else if (tier === "cards") {
    const threads = cardThreadsOf(state).filter((thread) => !state.collapsedJobs.has(thread));
    for (const thread of threads) state.collapsedJobs.add(thread);
    if (threads.length) saveCollapsedJobs();
    for (const thread of threads) {
      // A card in a folded project has no node; its fold is still written, and the next expand reads it.
      if (document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)) renderConversation(thread);
    }
    renderJobs();
  } else if (tier === "rows") {
    for (const key of [...state.expanded]) {
      state.expanded.delete(key);
      state.detailEls.get(key)?.remove();
      state.detailEls.delete(key);
      document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.classList.remove("expanded");
      scheduleCollapseCascade("row", key, true);
    }
  } else if (tier === "projects") {
    const names = [...state.expandedProjects];
    for (const name of names) {
      state.expandedProjects.delete(name);
      scheduleCollapseCascade("project", name, true);
      applyProjectCollapse(name);
      // Rows are only built for open projects, so closing one drops them instead of leaving hidden markup.
      renderProjectRows(name);
    }
    if (names.length) saveExpandedProjects();
    // Keep each folder's own collapse-all button honest, the way a click on the project header does.
    for (const name of names) {
      const root = document
        .querySelector(`section.project[data-project="${CSS.escape(name)}"]`)
        ?.closest("section.root-group")?.dataset.root;
      if (root) paintRootButton(root);
    }
  } else if (tier === "folders") {
    const roots = boardRootsOf(state).filter((root) => !state.collapsedRoots.has(root));
    for (const root of roots) {
      state.collapsedRoots.add(root);
      scheduleCollapseCascade("root", root, true);
      applyRootCollapse(root);
    }
    if (roots.length) saveCollapsedRoots();
    const fixed = FIXED_CARDS.filter((id) => !state.collapsedFixed.has(id));
    for (const id of fixed) {
      state.collapsedFixed.add(id);
      scheduleCollapseCascade("fixed", id, true);
      applyFixedCollapse(id);
    }
    if (fixed.length) saveCollapsedFixed();
  }
  paintCollapseAll();
  return tier;
}
// ---- end collapse one tier

// ---- clone a repo into a folder ------------------------------------------------
// The "+" in a folder header opens this row. The root is fixed to the folder you clicked, so a
// clone can only ever land inside a configured scan root, and the server re-checks that.
function showCloneForm(root, show = true) {
  const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
  if (!form) return;
  form.hidden = !show;
  if (show) form.querySelector("[data-clone-input]")?.focus();
}

// Status lives in state, not only in the DOM: a snapshot re-renders every folder section, and an
// inline-only message was wiped a couple of seconds after the clone finished. ONE writer for both
// actions in the row (clone, and the new local project beside it), so each reports into the same
// `data-clone-msg` span the reader is already looking at. The span is found from the FORM, not by the
// root's spelling: a stale page can press a button whose root no longer matches the folder it holds.
function setCloneStatus(form, root, text, kind = "busy") {
  state.cloneStatus[root] = { text, kind };
  const span = form?.querySelector("[data-clone-msg]");
  if (span) {
    span.textContent = text;
    span.classList.toggle("clone-err", kind === "err");
  }
}

async function cloneIntoRoot(root) {
  const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
  if (!form) return;
  const input = form.querySelector("[data-clone-input]");
  const btn = form.querySelector("[data-clone-go]");
  const name = String(input?.value || "").trim();

  const setStatus = (text, kind = "busy") => setCloneStatus(form, root, text, kind);

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

// The row's second action: a brand-new LOCAL git project, inited on `main` with one commit so the
// board has a base ref to read. Same name field and same status line as the clone beside it — a
// refusal lands where the reader is already looking, and the box keeps the cursor for the fix. It is
// handed the BUTTON, so the form and the root it posts are the ones that button belongs to.
async function newProjectInRoot(btn) {
  const form = btn?.closest("[data-clone-form]");
  const root = btn?.dataset.projectNew;
  if (!form || !root) return;
  const input = form.querySelector("[data-clone-input]");
  const name = String(input?.value || "").trim();
  if (!name) {
    input?.focus();
    return;
  }
  btn.disabled = true;
  setCloneStatus(form, root, "creating…");
  try {
    const res = await apiFetch("/api/project/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, name }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCloneStatus(form, root, j.error || `HTTP ${res.status}`, "err");
      input?.focus();
      return;
    }
    setCloneStatus(form, root, `created → ${j.dest} (${j.branch}, ${j.sha})`, "ok");
    if (input) input.value = "";
    // Discovery re-runs server-side and broadcasts a snapshot; this second resync covers a missed
    // event so the new project appears without waiting for the timer.
    setTimeout(() => void resync(), 2000);
  } catch (e) {
    setCloneStatus(form, root, `failed: ${e.message}`, "err");
    input?.focus();
  } finally {
    btn.disabled = false;
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
  // A card the restart restored but the panel has NOT re-attached yet: it is live on the board, and this panel is
  // holding no stream to judge. "no events yet" would blame the gateway for a silence nobody was listening to.
  if (j.restoredPending) return null;
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

// A block the reader has open keeps its stored output current while its turn runs, and settles once when the turn
// ends. Only open blocks are asked for, and ensureToolStore's own throttle bounds the requests.
setInterval(() => {
  for (const grp of placedNodes(".tgrp")) {
    const bodyEl = grp.querySelector(".tgrp-body");
    if (!bodyEl || bodyEl.hidden) continue;
    const turnId = String(grp.dataset.tgrp || "").split("#")[0];
    if (!state.jobs.has(turnId)) continue;
    const lines = groupLines(grp);
    const tools = grp.dataset.filter ? [grp.dataset.filter] : burstStoreTools(lines);
    for (const tool of tools) void ensureToolStore(turnId, tool, grp);
  }
}, 3000);

// The approval question belongs where the reading stopped: directly under the console output of the
// turn that is parked on it, not in a separate panel at the bottom of the card. It is a box that
// behaves like a popup (raised, bordered, the only thing asking for a decision) but it lives in the
// flow, so it never covers the output it is about.
// The choices a parked question offers, and what each one means. ONE table for every box the panel draws — a turn
// parked on an approval, a local-only worktree parked on a push — because "Always allow" has to mean the same
// thing in both, and the reader asked for the same box rather than a lookalike.
const APPROVAL_CHOICE_LABEL = { once: "Allow once", session: "Allow for this session", always: "Always allow", deny: "Deny" };

// One answer per question, shared by every box that draws it. A permission can be open as a run card
// (`turn-approval`) and as a dock card (`.approval`), and a clarify question can be drawn on the worktree
// session and in the assistant session; both copies carry the gateway's request id, so the flight is keyed
// on that id rather than on the card, the turn or the button. The entry exists from the press until the
// answer settles: every other press is refused, and every copy is greyed together.
const approvalFlights = new Map(); // `request:<id>` | `id:<id>` -> { id, requestId, choice, at }
function approvalFlightKey(id, requestId) {
  const rid = String(requestId || "").trim();
  return rid ? `request:${rid}` : `id:${String(id || "")}`;
}
function approvalInFlight(id, requestId) {
  return approvalFlights.get(approvalFlightKey(id, requestId)) || null;
}

// Every box that draws this approval, on every surface: the board card and the pinned copy of the same turn are
// two boxes for one request, and both carry the gateway's request id. A record with no id falls back to the
// turn, which is the finest identity it has.
function approvalCardsFor(id, requestId) {
  const rid = String(requestId || "").trim();
  const turn = String(id || "");
  const cards = new Set();
  for (const el of document.querySelectorAll("[data-approve]")) {
    const same = rid ? String(el.dataset.request || "") === rid : String(el.dataset.approve || "") === turn;
    if (!same) continue;
    const card = el.closest(".turn-approval");
    if (card) cards.add(card);
  }
  return cards;
}

// Grey (or un-grey) every copy of one approval at the press, before any round trip: `disabled` on the button
// itself is what a stale pointerup and a repaint that has not run yet both see, and the flight line says what
// is happening without waiting for the next snapshot.
function paintApprovalFlight(id, requestId, mode) {
  const sending = mode === "sending";
  for (const card of approvalCardsFor(id, requestId)) {
    card.classList.toggle("is-sending", sending);
    if (sending) card.setAttribute("aria-busy", "true");
    else card.removeAttribute("aria-busy");
    for (const el of card.querySelectorAll("button")) el.disabled = sending;
    const line = card.querySelector("[data-ta-flight]");
    if (line) line.hidden = !sending;
  }
}

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
  // A line under the command, for a box that has something to say about itself (the dock's "no agent on this
  // board owns that write" is the one caller). Empty for every other question.
  note = "",
  titles = null,
  extra = "",
  // Can this panel send an answer for this request at all? False for a turn with no run, a record with no
  // permitted choice, and a request the gateway has proved it no longer holds: the box then draws the note
  // instead of choices, because a button that can only be refused is worse than no button.
  answerable = true,
}) {
  const left = deadline ? deadline - Date.now() : 0;
  const canSend = !closed && answerable;
  // A press has already gone out for this request: every copy of the box greys its choices at once, so a
  // second box (the dock's copy, or this card after a repaint) cannot send a second, different answer.
  const sending = canSend && Boolean(approvalInFlight(id, requestId));
  const buttons =
    `<div class="ta-actions">` +
    choices
      .map(
        (c) =>
          `<button class="btn-approve${c === "deny" ? " btn-deny" : ""}" data-approve="${esc(id)}" data-choice="${esc(c)}" data-request="${esc(requestId)}" data-until="${deadline || ""}"${extra} type="button"${sending ? " disabled" : ""} title="${esc((titles && titles[c]) || APPROVAL_CHOICE_LABEL[c] || c)}">${esc(APPROVAL_CHOICE_LABEL[c] || c)}</button>`,
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
  return `<div class="turn-approval${closed ? " is-expired" : ""}${sending ? " is-sending" : ""}" ${forAttr}>
    <div class="ta-head mono">${closed ? esc(closedHead) : head}</div>
    <pre class="ta-cmd mono">${esc(command || "(no command text)")}</pre>
    ${note}
    <div class="ta-note mono is-sending" data-ta-flight${sending ? "" : " hidden"}>sending your answer...</div>
    ${canSend ? buttons : closed ? closedNote : approvalUnanswerableNote()}
    ${canSend ? foot : ""}
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
  // A park that is on the card is drawn. `approvalDone` records an EARLIER approval on this same turn, and gating a
  // later request on it is exactly what hid the second box behind the first's answer (docs/steer-refusal.md §1.4) —
  // `approval.responded` and settle clear `approval` itself, so its presence is the whole test.
  if (!live) return "";
  const choices = Array.isArray(approval.choices) && approval.choices.length ? approval.choices : ["once", "deny"];
  // The window is the gateway's own (`approvals.timeout`), carried on the request when it arrived. An approval
  // is a question with a deadline: the gateway gives up at it and denies the command on its own, so a box that
  // keeps offering a choice past that instant is offering a decision that can no longer be made — the answer
  // comes back 409 `approval_not_pending` and the reader is told nothing about why.
  const deadline = Number(approval.deadline) || 0;
  const windowMs = (Number(approval.timeoutSeconds) || 0) * 1000;
  const closed = Boolean(deadline) && deadline - Date.now() <= 0;
  // The panel's own verdict on whether those buttons can lead anywhere: it needs a run to post to, at least
  // one choice the host allowed, and a request its reconcile has not found gone. A page talking to a panel
  // that predates the field gets `undefined`, which is why only an explicit false closes the box.
  const answerable = Boolean(turn.runId) && approval.answerable !== false && choices.length > 0;
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
    answerable,
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

// There is a box on screen that this panel cannot send an answer for: the turn has no run to post to, the
// gateway allowed no choice, or its own reconcile found the gateway no longer holds the request. The honest
// thing is the record without the buttons: the panel is not the surface that can settle this one.
function approvalUnanswerableNote() {
  return `<div class="ta-note mono">this panel cannot answer this request: it has no line to the run that asked, so no choice is offered here</div>`;
}

// Once answered the box collapses to one line: what was decided, about what. An approval nobody answered gets its
// own line — the gateway denied the command when its window ran out, and "✓ approved" for that would be a lie.
function approvalDecided(turn) {
  const done = turn.approvalDone;
  if (!done || turn.approval) return "";
  if (done.expired) {
    // A press that lost the race is not the same event as a box nobody touched. The reader DID answer; the
    // gateway had already let the request go, and the record says which of the two happened.
    const why = done.clicked
      ? "your answer reached the gateway after it had already let this request go: its window closed, another surface answered it, or the run was stopped"
      : done.reason === "withdrawn"
        ? "the gateway had already let this request go (its window closed, another surface answered it, or the run was stopped)"
        : `no answer reached the gateway inside its waiting window${Number(done.waitedSeconds) ? ` (${fmtLeft(Number(done.waitedSeconds) * 1000)} unanswered)` : ""}`;
    const head = done.clicked ? "✕ your answer arrived too late" : "✕ not answered here";
    return `<div class="turn-approval-done mono is-expired" title="${esc(why)}${done.command ? ` - ${esc(String(done.command))}` : ""}">${head}${done.command ? `: ${esc(String(done.command).slice(0, 140))}` : ""}</div>`;
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
// One answer per QUESTION, not one per click and not one per card. The key is the gateway's request id when
// the prompt names one, so two copies of the same question (the worktree session and the assistant session)
// share a single flight; a prompt with no id falls back to the turn, which is the finest identity it has.
const questionFlights = new Map(); // questionFlightKey() -> { turnId, requestId, at } while a POST is in flight
function questionFlightKey(turnId, requestId) {
  const rid = String(requestId || "").trim();
  return rid ? `request:${rid}` : `turn:${turnId || ""}`;
}
function questionInFlight(turnId, requestId) {
  return questionFlights.get(questionFlightKey(turnId, requestId)) || null;
}
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
  // An answer for THIS question is already on its way: every copy of the box greys every control, so a
  // second click on either surface cannot send a second answer for the same request id.
  const sending = Boolean(questionInFlight(turn.id, q.requestId));
  const rows = choices
    .map((c, i) =>
      multi
        ? `<label class="tq-choice is-multi${picks.has(i) ? " on" : ""}" data-qvalue="${esc(c)}" title="tick the answers you want, then send them">
      <input type="checkbox" data-qpick="1" data-qturn="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qindex="${i}"${picks.has(i) ? " checked" : ""}${sending ? " disabled" : ""}>
      <span class="tq-box" aria-hidden="true"></span>${questionHead(c)}</label>`
        : `<button type="button" class="tq-choice" data-qanswer="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qrequest="${esc(q.requestId || "")}" data-qvalue="${esc(c)}"${sending ? " disabled" : ""} title="send this answer — the agent carries on with it">
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
  const sendBtn = `<button type="button" class="tq-send" data-qsend="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qrequest="${esc(q.requestId || "")}"${sending ? " disabled" : ""}>Send answer</button>`;
  const answerRow = showTyped
    ? `<div class="tq-other-row">
      <textarea class="tq-other" data-qother="${esc(turn.id)}" data-qcopy="${esc(copy)}" rows="2" placeholder="or type your own answer" title="anything you type here is sent as your answer, in your own words"${sending ? " disabled" : ""}>${esc(draft)}</textarea>
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
  // How many times the panel has asked the reader again about this same question (lib/assistant.js
  // re-asks an hour after it parked, then hourly). It is a count on THIS box, not a second box: the
  // question never changed, only the number of times nobody answered it.
  const reasks = Math.max(0, Number(q.reasks) || 0);
  const again = reasks
    ? `<span class="tq-again" title="the panel asks again once an hour while this stays unanswered — nothing else about the question has changed">↻ asked again ${reasks}× · still unanswered</span>`
    : "";
  return `<div class="turn-question${sending ? " is-sending" : ""}" data-question-for="${esc(turn.id)}${esc(copy)}"${sending ? ' aria-busy="true"' : ""}>
    <div class="tq-head mono">${sending ? "⏳ sending your answer — the agent is being released" : "❓ waiting on you — the agent is parked until you answer"}</div>
    ${again}
    <div class="tq-question">${esc(q.question || "(no question text)")}</div>
    ${rows ? `<div class="tq-choices${multi ? " is-multi" : ""}">${rows}</div>` : ""}
    <div class="tq-note mono${sending ? " is-sending" : ""}" data-qnote="${esc(note)}">${esc(sending ? "sending your answer, one moment..." : note)}</div>
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
  for (const el of placedNodes("[data-q-clock]")) {
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

// Every card that draws this question, on every surface. The gateway's request id is the identity that
// both the worktree session and the assistant session carry, so a match there is the same question even
// when the two cards are drawn from different turns; a prompt with no id is matched on its turn instead.
function questionCardsFor(turnId, requestId) {
  const rid = String(requestId || "").trim();
  const cards = new Set();
  if (rid) {
    for (const el of document.querySelectorAll("[data-qrequest]")) {
      if (String(el.dataset.qrequest || "") !== rid) continue;
      const card = el.closest(".turn-question");
      if (card) cards.add(card);
    }
  }
  const turn = String(turnId || "");
  if (turn) {
    for (const el of document.querySelectorAll("[data-question-for]")) {
      if (!String(el.dataset.questionFor || "").startsWith(turn)) continue;
      cards.add(el);
    }
  }
  return cards;
}

// Grey (or un-grey) every control on every copy of one question, and say what is happening. `disabled`
// is set on the element itself as well as through the class, so a repaint that has not run yet and a
// pointerup that lands on a stale button both see a control that cannot send.
function paintQuestionFlight(turnId, requestId, mode, text = "") {
  const sending = mode === "sending";
  for (const card of questionCardsFor(turnId, requestId)) {
    card.classList.toggle("is-sending", sending);
    if (sending) card.setAttribute("aria-busy", "true");
    else card.removeAttribute("aria-busy");
    for (const el of card.querySelectorAll("button, textarea, input")) el.disabled = sending;
    // The note is where "sending" is SAID, and it is set here as well as at render time: a press repaints nothing,
    // so a card waiting for the next snapshot would otherwise show dead controls with no reason for them.
    const note = card.querySelector("[data-qnote]");
    if (note) note.textContent = sending ? "sending your answer, one moment..." : note.dataset.qnote || "";
    const warn = card.querySelector("[data-qwarn]");
    if (warn) warn.textContent = sending ? "" : mode === "error" ? text : "";
  }
}

function forgetQuestionScratch(turnId) {
  for (const k of [...questionPicks.keys()]) if (k.startsWith(turnId)) questionPicks.delete(k);
  for (const k of [...questionDrafts.keys()]) if (k.startsWith(turnId)) questionDrafts.delete(k);
}

// Answer a question a run is parked on. One path for a clicked choice, a typed answer and a multi-select
// batch, so there is exactly one place that posts and one place that reports a refusal.
async function answerRunQuestion(turnId, answer, requestId, box) {
  const key = questionFlightKey(turnId, requestId);
  // One answer per question, not one per click: the first press owns the flight, and the click that often
  // follows a pointerup - or a second choice on either surface - is refused until the POST settles. A
  // refusal clears it, so the reader can answer again.
  if (questionFlights.has(key)) return;
  questionFlights.set(key, { turnId, requestId: String(requestId || ""), at: Date.now() });
  paintQuestionFlight(turnId, requestId, "sending");
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
      paintQuestionFlight(turnId, requestId, "error", text);
      if (!questionCardsFor(turnId, requestId).size && card) showBanner(`answer: ${text}`);
      return;
    }
    // The route said ok, so the question is settled server side: clear the box here and now, on every
    // surface, instead of leaving a dead card until the next snapshot or job event arrives.
    forgetQuestionScratch(turnId);
    applyQuestionAnswered(turnId, requestId, out.answer ?? answer);
  } catch (err) {
    paintQuestionFlight(turnId, requestId, "error", `could not answer: ${err.message}`);
  } finally {
    questionFlights.delete(key);
  }
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
//
// The strips are found in two passes over the page for the whole roster, then looked up by key. The loop runs over
// every job the panel knows (97 on the reader's board), and it used to ask `document.querySelector` for each one by
// attribute value - one or two walks of the whole 55k-node document per job, per roster poll: 250 ms a minute of
// querySelector under this function in a read-only profile of that board, the largest DOM cost on it. A job with no
// strip on the page is skipped before its rows are worked out (subagentsForTurn filters every job again). The FIRST
// node per key is kept, which is the one the per-key query found, so a turn drawn twice is painted where it was.
function paintSubagents() {
  const firstByKey = (attr) => {
    const map = new Map();
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      const k = el.getAttribute(attr);
      if (!map.has(k)) map.set(k, el);
    }
    return map;
  };
  const compacts = firstByKey("data-subs-compact");
  const boxes = firstByKey("data-subs-turn");
  if (!compacts.size && !boxes.size) return;
  for (const job of state.jobs.values()) {
    const key = job.id;
    const compact = compacts.get(key) || null;
    const box = compact ? null : boxes.get(key) || null;
    if (!compact && !box) continue;
    const rows = subagentsForTurn(job);
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

// ---- pipeline chip: the pipeline in force on this tree, and where in it -----------------------------------------
// `lib/jobs.js` writes the record on every job row (`pipelineForJob`: `{id, stage, since, history[]}`) and
// docs/pipelines.md §3 keeps the durable copy on the tree; this is the card drawing it, from the row it already has.
// The host chip (`hostChipHtml`) is the panel's chip of this shape, so this one takes its pill height, type scale and
// gap, and it sits beside the card's state pill: "which pipeline" and "where in it" are one question when the reader
// is judging a card.
//
// Three states, and no fourth: a record with a stage draws `pipeline: <id> · <stage>`, a record with no stage draws
// the id alone, and no record draws NOTHING — never a "local" stand-in and never an empty pill. It is a span, not a
// button: `POST /api/worktree/pipeline` refuses every switch until it can start the first stage as a turn, so a
// control here would promise work that cannot happen yet.
function pipelineChipHtml(pipeline) {
  const id = pipeline && pipeline.id ? String(pipeline.id).trim() : "";
  if (!id) return "";
  const stage = pipeline.stage ? String(pipeline.stage).trim() : "";
  const what = stage ? `pipeline ${id}, stage ${stage}` : `pipeline ${id}, no stage recorded`;
  const title = `${what} — this worktree's durable pipeline record (docs/pipelines.md §3). The chip draws what the record says; it switches nothing.`;
  return `<span class="pipeline-chip" data-pipeline="${esc(id)}"${stage ? ` data-pipeline-stage="${esc(stage)}"` : ""} title="${esc(title)}">pipeline: ${esc(id)}${stage ? ` · ${esc(stage)}` : ""}</span>`;
}
// ---- end pipeline chip

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
  markUnder(card, key);
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
function queueReply(thread, text, attachments = []) {
  const q = state.replyQueue.get(thread) || [];
  // `at` is this entry's identity — the × and the drain both key on it — so two replies held in the same
  // millisecond still get one each: the stamp is nudged until it is unique within this thread's queue.
  let at = Date.now();
  while (q.some((entry) => entry && entry.at === at)) at += 1;
  // The files travel WITH the entry. They leave the composer's staged set in the same breath: a chip that
  // stayed there would attach the same file to the next message as well, and a send would carry it twice.
  const files = (Array.isArray(attachments) ? attachments : []).filter((a) => a && a.path);
  q.push({ text, at, attachments: files });
  state.replyQueue.set(thread, q);
  if (files.length) {
    const held = new Set(files.map((a) => a.path));
    setAttachments(thread, attachmentsFor(thread).filter((a) => !held.has(a.path)));
    renderChips(thread);
  }
  renderConversation(thread);
}

// One press of Queue reply, from the button or from Enter: hold what the box holds and send it when the thread
// is free, instead of steering the turn that is running now. The draft is cleared BEFORE queueReply, which
// rebuilds the card - the rebuild would otherwise put the text back into the new box from the saved draft.
// The staged files are read before either happens: they are the held reply's now, not the composer's.
function queueReplyFromBox(thread) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // readBox, not box.value: what is held is what the agent would receive, a chip being the text it holds.
  const text = readBox(box).trim();
  if (!text) {
    if (box) box.focus();
    return false;
  }
  const files = attachmentsFor(thread);
  state.replyDrafts[thread] = "";
  if (box) {
    writeBox(box, "");
    clearBoxDraft(box);
  } else clearBoxDraft(`reply:${thread}`);
  queueReply(thread, text, files);
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
  // From the keyboard the turn is found through the SAME predicate the card drew its button from, never through any
  // live turn on the thread: Ctrl+Enter is offered only while that button is, so it must name the same turn.
  const id =
    turnId ||
    [...state.jobs.values()].find((j) => (j.thread || j.id) === thread && turnLive(j) && j.steerable?.ok)?.id;
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
  // The entry's own files, under its text: the same chip the composer drew, opening the same path. They are
  // drawn from the ENTRY, never from the composer, so a file staged later cannot appear in this bubble.
  const chips = q.attachments?.length
    ? `<div class="ghost-chips">${attachmentChipsFor(q.attachments)}</div>`
    : "";
  if (!edit || edit.at !== q.at) {
    return `${head("sends when the current turn finishes", false)}<div class="ghost-prompt" data-edit-queued-open="${q.at}" data-edit-thread="${esc(thread)}" role="button" tabindex="0" title="click to edit this held reply">${linkifyText(q.text)}</div>${chips}</div>`;
  }
  // An editor is open on this entry, so the line above it cannot keep promising a send: while the reader is in the
  // box this reply is held, and the card says which hold it is — still waiting for the turn and its subagents, or free
  // to go the moment it is saved.
  const when = freeToSend
    ? "the turn has finished — this held reply waits for your edit; save and it goes"
    : "editing — it is not sent while you edit it; save sends it, Escape leaves it as it was";
  return `${head(when, true)}<div class="ghost-edit" data-edit-for="${q.at}"><textarea class="ghost-edit-box mono" data-edit-queued="${q.at}" data-edit-thread="${esc(thread)}" rows="2" spellcheck="false" aria-label="edit this held reply">${esc(edit.text)}</textarea><div class="ghost-edit-actions mono"><button class="btn-edit-save" type="button" data-edit-save="${q.at}" data-edit-thread="${esc(thread)}" title="save this edit — the held reply becomes this text (Enter)">Save</button><button class="btn-edit-cancel" type="button" data-edit-cancel="${q.at}" data-edit-thread="${esc(thread)}" title="leave this held reply exactly as it was (Escape)">Cancel</button></div></div>${chips}</div>`;
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
  // The entry's files come back to the composer the same way its text does — only into an empty box, so a file
  // staged since is never joined by one from a reply the reader took back.
  const back = backToDraft && entry.attachments?.length ? addAttachments(thread, entry.attachments) : 0;
  renderConversation(thread);
  // After the repaint: a rebuild replaces the card and the warnline with it, so the note goes in last.
  const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
  if (warn) {
    warn.textContent = backToDraft
      ? back
        ? `that queued reply is cancelled — the text and its ${back === 1 ? "file are" : `${back} files are`} back in the box`
        : "that queued reply is cancelled — the text is back in the box as your draft"
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
    // The entry's OWN files travel with the send. The composer's staged set belongs to a later message and is
    // neither read nor cleared here.
    await sendReply(thread, entry.text, entry.attachments || []);
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
// Assistant.askAboutComplete -> wake), so it lands in the assistant's next turn. The pill says the ask happened; a queue
// that refuses it (an assistant switched off) says WHY on the card, in the place a failed nudge already speaks, and the
// pill is then left as it was rather than claiming a success. The hourly SWEEP budget cannot refuse it: a press is an
// event, and events are never budgeted (`SWEEP_WAKE_RULES` in lib/assistant/config.js).
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
// The bracket itself - beginDomMove(), endDomMove() and the depth they keep - is public/dom.js.
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

async function sendReply(thread, preset = null, presetAttachments = null) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // The one place a box's text is read. A chip serializes back to the text it swallowed, IN PLACE: quotes
  // the reader put around it and the prose on either side arrive in the order they are on screen.
  const typed = String(preset ?? (box ? readBox(box) : "")).trim();
  // A queued reply hands its OWN files in: the block is built from those, and the composer's staged set is a
  // later message's — never read, never cleared here. A box send passes null and the staged set is its own.
  const held = Array.isArray(presetAttachments);
  const files = held ? presetAttachments : attachmentsFor(thread);
  const attached = attachmentBlockFor(files);
  if (!typed && !attached) return false;
  const text = typed + attached;
  // The typed part only: the attachment block is panel-added, and recalling it would duplicate the files.
  rememberReply(thread, typed);
  const btn = document.querySelector(`.btn-reply[data-thread="${CSS.escape(thread)}"]`);
  if (btn) btn.disabled = true;
  // The assistant's thread is answered through its own route: the server attaches the scratchpad and the
  // board digest to that turn, and a plain reply here would start a turn with neither.
  const toAssistant = assistantSessionFor(thread);
  try {
    const r = await apiFetch(toAssistant ? "/api/assistant/say" : "/api/agents/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toAssistant ? { text, assistantId: toAssistant.id } : { thread, text, attachments: files }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.replyDrafts[thread] = "";
    if (!held) clearAttachments(thread);
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
      // One sentence per reason, because the three refusals want three different next actions (docs/steer-refusal.md
      // §2.2/§2.4). `out.reason` is classified by the route from the same predicate the card drew its button from;
      // a refusal it could not classify falls through to the plain sentence rather than guessing a case.
      const reason = String(out.reason || "").trim();
      const why = String(out.error || "").trim() || `HTTP ${res.status}`;
      // The route settled a run the gateway no longer has and carried the card back: repaint now, so the Steer control
      // and the card's "running" word go in the same round trip as the answer.
      if (out.card && typeof updateJob === "function") {
        try {
          updateJob(out.card);
        } catch {
          /* the job frame that follows repaints anyway */
        }
      }
      if (reason === "past_boundary") {
        // A GENUINE 409: the run exists and is already past its last tool boundary, so this text cannot land in it and
        // no later press will land either. Hold it as the reply the reader asked for — the same hold the Queue reply
        // press makes — and say it was held, so nobody is left thinking the instruction was lost. The staged files are
        // read BEFORE the box is cleared and held ON the entry: the drain sends those, not whatever is staged by then,
        // and the text stays the reader's words (the block would be a second copy of the paths).
        const files = attachmentsFor(thread);
        state.replyDrafts[thread] = "";
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        if (box) {
          writeBox(box, "");
          clearBoxDraft(box);
        }
        queueReply(thread, typed, files);
        // After the repaint queueReply causes: it replaces the card, and the old warnline with it.
        const heldWarn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
        if (heldWarn) heldWarn.textContent = `steer held — ${why}; your text is queued and goes out as the next turn on this thread.`;
        if (btn) btn.disabled = false;
        return false;
      }
      const advice =
        reason === "parked"
          ? "Nothing was queued — answer the approval above and Steer works again."
          : reason === "gone"
            ? "Nothing was queued — the card is settled now, and Send reply starts a new turn."
            : "Nothing was queued; the text is still in the box.";
      // The repaint above replaced the warnline with the card, so the sentence goes on the node that is on the page
      // now — the one captured when this press started may already be detached.
      const liveWarn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`) || warn;
      if (liveWarn) liveWarn.textContent = `steer refused — ${why}. ${advice}`;
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
  // What each older turn was showing has to be read BEFORE any flag moves: the turn just finished is open
  // because it was the newest, not because anything is written down about it.
  const older = conv ? conv.turns.filter((t) => t.id !== turnId) : [];
  const plan = previousTurnPlan(
    prevTurnMode(),
    older.map((t) => ({ id: t.id, open: t.id === previous?.id || state.turnOpen.get(turnKey(t)) === true })),
  );
  // The new turn is the one open in its card, on the newest page — the same three claims every jump path makes, so
  // they are written by the module's `reveal` rather than spelled out here.
  if (conv) wtTurnFold.reveal(state, thread, conv.turns, turnId);
  else {
    // No conversation to page in yet (the store has not grouped the new turn): the fold is the only part sayable.
    wtTurnFold.setOpen(state, turnId, true);
    wtTurnFold.unfreeze(state, turnId);
  }
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
  const requestId = approveBtn.dataset.request || "";
  // The same box, the same four choices, two questions: a run parked on a gateway approval, or a write parked on
  // the panel's own remote-write permission (lib/remote-writes.js). The button is identical, so the ROUTE is
  // decided by which record the id belongs to — never by a second kind of button.
  if (state.rwPending.has(id)) return answerRemoteWrite(id, choice, approveBtn);
  // One answer per request, whichever copy was pressed: the second press (the pinned card, or the click that
  // follows a pointerup) is refused while the first is still on its way, so the gateway never sees two answers
  // and the transcript never records the loser's 409 over the winner's decision.
  if (approvalInFlight(id, requestId)) return;
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
  const key = approvalFlightKey(id, requestId);
  approvalFlights.set(key, { id, requestId, choice, at: Date.now() });
  paintApprovalFlight(id, requestId, "sending");
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
      paintApprovalFlight(id, requestId, "error");
      if (out.gone) closeApprovalCard(approveBtn.closest(".turn-approval"));
      if (warn) warn.textContent = out.error || `approval failed (HTTP ${res.status})`;
      approvalSent.delete(approvalKey(id, choice));
      return;
    }
    // Accepted: the box goes on every surface now, and the decision is written the way the server wrote it,
    // instead of waiting for a snapshot that may be a repaint behind.
    applyApprovalAnswered(id, requestId, out.choice || choice);
  } catch (err) {
    paintApprovalFlight(id, requestId, "error");
    if (warn) warn.textContent = `approval failed: ${err.message}`;
    approvalSent.delete(approvalKey(id, choice));
  } finally {
    // Only this press could have taken the key: a second one was refused above, so removing it here cannot
    // clear another answer in flight.
    approvalFlights.delete(key);
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
state.rwReviews = state.rwReviews || new Map(); // id -> an auto-allowed write, drawn as a Keep / Unwind review
state.rwPolicy = state.rwPolicy || "local-only";

// A decided record and a review are RECEIPTS, not fixtures. The dock is a corner of the screen, and a receipt that
// outlives the thing it describes is exactly the "waiting on you" box the reader could not get rid of: both age out
// on the page's own 1 s clock (tickApprovals), so the corner clears itself with no event to wait for.
const DECIDED_TTL_MS = 90_000;
const DECIDED_SHOWN = 3; // the last three, as before: a receipt list is not a log

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
    note: r.note ? `<div class="rw-note mono" data-rw-note>⚠ ${esc(r.note)}</div>` : "",
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

// A decided record: one line, a ✕ of its own, and a click that goes back to the agent the write was about. It is a
// receipt for a question that is OVER, which is why it never shares the head with a pending request.
function remoteWriteDecidedHtml(d) {
  const id = String(d.id || "");
  const denied = String(d.choice || "") === "deny";
  const verb = denied ? (d.expired ? "not answered — denied" : "denied") : `allowed ${d.choice}`;
  const note = d.note ? `<div class="rw-note mono" data-rw-note>⚠ ${esc(d.note)}</div>` : "";
  return `<div class="rw-record mono${denied ? " is-deny" : ""}" data-rw-record="${esc(id)}" data-rw-tree="${esc(d.worktree || "")}" data-rw-branch="${esc(d.branch || "")}" title="${esc(d.why || "remote write")} — click to go to the agent this write was about">
    <span class="rw-record-text">${denied ? "✕" : "✓"} remote write ${esc(verb)}${d.command ? `: ${esc(String(d.command).slice(0, 140))}` : ""}</span>
    <button type="button" class="rw-x" data-rw-dismiss="${esc(id)}" title="dismiss this record">✕</button>
    ${note}
  </div>`;
}

// The agent a review is about, by the name the reader knows it by — the card's title, else the thread id.
function reviewAgentName(r) {
  const thread = String(r.agentThread || "");
  if (thread) {
    const job = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread);
    if (job) return job.title || job.label || thread;
  }
  return "the agent";
}

// An auto-allowed write, after the fact: the panel was never asked, so this is the only record that it happened.
// Keep closes it; Unwind names EXACTLY what it would do — a remote branch delete, or a message drafted to the agent
// when there is no safe inverse. The panel never runs an inverse of its own, and the button is the confirmation.
// ---- rw review card
// Keep is the safe action and the whole width of the card, with Unwind as the red bar under it (`.rw-keep` +
// `.rw-review .ap-actions` in the sheet). The class goes on the control in BOTH states, because the dismissed
// record's one control is the same slot.
function remoteWriteReviewHtml(r) {
  const unwind = r.unwind && r.unwind.type ? r.unwind : { type: "message", text: "" };
  const target = r.branch ? `${r.remote || "origin"}/${r.branch}` : "";
  const head =
    r.state === "unwound"
      ? `✕ unwound — ${esc(r.unwind?.label || "the write was reversed")}`
      : `✓ remote write allowed without asking${r.sha ? ` · <code>${esc(String(r.sha).slice(0, 7))}</code>` : ""}`;
  const why = [r.why, target].filter(Boolean).join(" · ");
  const buttons =
    r.state === "unwound"
      ? `<button type="button" class="rw-keep" data-rw-review-keep="${esc(r.id)}" title="dismiss this record">Dismiss</button>`
      : `<button type="button" class="rw-keep" data-rw-review-keep="${esc(r.id)}" title="keep it — the write stands and this card goes">Keep</button>` +
        (unwind.type === "delete-branch"
          ? `<button type="button" class="btn-deny" data-rw-review-unwind="${esc(r.id)}" title="deletes ${esc(unwind.label || "the remote branch")} on the remote — this click is its confirmation">Unwind — ${esc(unwind.label || "delete the remote branch")}</button>`
          : `<button type="button" data-rw-review-unwind="${esc(r.id)}" title="nothing is run: this drafts a message to the agent instead">Unwind — draft a message to ${esc(reviewAgentName(r))}</button>`);
  const detail =
    unwind.type === "delete-branch"
      ? `<div class="rw-note mono" data-rw-note>unwind runs exactly: ${esc(unwind.command || "")} — this deletes the remote branch, and the click above is its confirmation</div>`
      : `<div class="rw-note mono" data-rw-note>no safe inverse for this write — unwind drafts a message to the agent and the panel runs nothing</div>`;
  const jumpNote = r.note ? `<div class="rw-note mono" data-rw-jump-note>⚠ ${esc(r.note)}</div>` : "";
  return `<div class="rw-review" data-rw-review="${esc(r.id)}" data-rw-tree="${esc(r.worktree || "")}" data-rw-branch="${esc(r.branch || "")}" title="click to go to the agent this write came from">
    <div class="rw-review-head mono">${head}</div>
    <pre class="ap-cmd mono">${esc(r.command || "(no command text)")}</pre>
    ${why ? `<div class="rw-review-why dim">${esc(why)}</div>` : ""}
    <div class="ap-actions">${buttons}</div>
    ${detail}${jumpNote}
  </div>`;
}
// ---- end rw review card

// Records and reviews live under their OWN heads. The reader's report was a green check under "waiting on you":
// a group label says what a group is, and the dock's head only ever counts what is actually pending.
function rwGroupHtml(kind, label, title, body) {
  return `<div class="ap-group" data-rw-group="${esc(kind)}">
    <div class="ap-group-head mono"><span>${esc(label)}</span><span class="spacer"></span><button type="button" data-rw-clear="${esc(kind)}" title="${esc(title)}">clear</button></div>
    ${body}
  </div>`;
}

function renderApprovals() {
  const sec = $("approvals");
  if (!sec) return;
  const now = Date.now();
  const list = [...state.approvals.values()].sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
  const writes = [...state.rwPending.values()].sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
  const decided = [...state.rwDecided.values()]
    .filter((d) => now - (Number(d.at) || 0) < DECIDED_TTL_MS)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, DECIDED_SHOWN);
  // Only a write the remote actually shows is drawn: the panel deletes an unconfirmed one for itself, and a card
  // claiming a push that never landed would be its own false record.
  const reviews = [...state.rwReviews.values()]
    .filter((r) => !r.kept && r.state !== "checking" && now - (Number(r.at) || 0) < DECIDED_TTL_MS)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const pending = list.length + writes.length;
  // THE HEAD COUNTS. `⚠ waiting on you` only while something IS waiting; a decided record or a review is never
  // placed under a label that claims a question, which was the reader's whole report.
  const headEl = $("approval-head");
  if (headEl) headEl.textContent = pending ? "⚠ waiting on you" : "✓ nothing pending";
  sec.classList.toggle("is-quiet", pending === 0);
  sec.hidden = pending === 0 && decided.length === 0 && reviews.length === 0;
  applyApprovalsFold(sec);
  // The card that says "waiting on you →" is part of the same fact: repaint the threads whose answer changed,
  // instead of leaving the chip on a stale card until the next job event happens to arrive.
  const threadsNow = new Set(list.map((r) => r && r.thread).filter(Boolean));
  for (const thread of new Set([...threadsNow, ...approvalThreadsShown])) {
    if (threadsNow.has(thread) === approvalThreadsShown.has(thread)) continue;
    if (document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)) renderConversation(thread);
  }
  approvalThreadsShown = threadsNow;
  const listEl = $("approval-list");
  const chipsEl = $("approval-chips");
  if (!listEl || !chipsEl) return;
  if (!pending && !decided.length && !reviews.length) {
    listEl.innerHTML = "";
    chipsEl.innerHTML = "";
    return;
  }
  chipsEl.innerHTML = pending ? `<span class="chip bad">${pending}</span>` : "";
  // The panel's own questions lead (they are the ones holding a worker's push), then the CLI-transport approvals,
  // then the two groups that are OVER: auto-allowed writes to review, and the receipts of writes already decided.
  listEl.innerHTML =
    writes.map(remoteWriteBoxHtml).join("") +
    list.map(approvalCard).join("") +
    (reviews.length
      ? rwGroupHtml(
          "review",
          "auto-allowed · review",
          "keep a write the panel allowed without asking, or unwind it — nothing here runs on its own",
          reviews.map(remoteWriteReviewHtml).join(""),
        )
      : "") +
    (decided.length
      ? rwGroupHtml("decided", "decided", "clear these receipts — each one also ages out after 90 s", decided.map(remoteWriteDecidedHtml).join(""))
      : "");
}

// ---- the dock's own gestures --------------------------------------------------------------------------------
// The reader reported a box that did nothing when clicked. A click on the HEAD or on any CARD is now the way to the
// agent that asked: unfold the stack, then jump through the same jumpToAgent() a row's agent chip uses, so the card
// is flashed and the caret follows it. A decided record has no thread (it keeps what/when only), so its agent is
// resolved from the worktree and branch it was about — and where it cannot be resolved, the card says so.
function revealAgentHome(thread) {
  if (!thread) return;
  // A card only exists in the DOM while its worktree row is open, so unfold the row — and its project and root —
  // first, exactly the three folds revealSpawnedAgent does before it lands on a card it just made.
  const key = rowKeyForThread(thread);
  const row = key ? state.rows.get(key) : null;
  if (row) {
    const project = state.projects.get(row.project);
    const root = project ? rootOf(project) : "";
    if (root && state.collapsedRoots.has(root)) {
      state.collapsedRoots.delete(root);
      saveCollapsedRoots();
      applyRootCollapse(root);
    }
    if (!state.expandedProjects.has(row.project)) toggleProject(row.project);
    if (!state.expanded.has(key)) document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  }
  jumpToAgent(thread);
}

// Which agent a remote write came from: the tree first (a write is about one worktree), then the branch. Several
// agents can share a tree, so one that is working or parked wins over one that has stopped.
function rwAgentFor(r) {
  const want = normPath(r?.worktree || "").toLowerCase();
  const branch = String(r?.branch || "");
  const jobs = [...state.jobs.values()];
  const inTree = want ? jobs.filter((j) => normPath(j.ownerPath || j.cwd || "").toLowerCase() === want) : [];
  const pool = inTree.length ? inTree : branch ? jobs.filter((j) => String(j.branch || "") === branch) : [];
  if (!pool.length) return null;
  return pool.find((j) => j.status === "running" || j.status === "starting") || pool[pool.length - 1] || null;
}

function rwUnresolved(r) {
  const what = r?.branch ? `branch ${r.branch}` : "that write";
  const where = r?.worktree ? ` in ${r.worktree}` : "";
  return `no agent card on this board for ${what}${where} — the write is on record, its agent is not`;
}

// Say it instead of doing nothing: a card that cannot find its agent keeps the reason on its own face (a banner
// alone is gone in four seconds) until it is dismissed or ages out.
function dockNote(record, why) {
  if (record && typeof record === "object") record.note = why;
  renderApprovals();
  showBanner(why);
  return false;
}

// One gesture for every dock click that is not a control: unfold, then go to the agent.
function dockGoto(el) {
  const dock = $("approvals");
  if (!dock) return false;
  try {
    localStorage.setItem(APPROVALS_FOLDED_KEY, "0"); // a jump always unfolds: the cards live inside
  } catch {
    /* the jump still happens */
  }
  applyApprovalsFold(dock);
  // A CLI-transport approval names its thread, so it goes straight to the agent.
  const approvalId = el?.dataset?.approval || "";
  if (approvalId) {
    const r = state.approvals.get(approvalId);
    if (r?.thread) {
      revealAgentHome(r.thread);
      return true;
    }
    showBanner(`that approval carries no agent thread${r?.surface ? ` (${r.surface})` : ""} — there is no card to go to`);
    return false;
  }
  const writeId = el?.dataset?.remoteWrite || "";
  const recordId = el?.dataset?.rwRecord || "";
  const reviewId = el?.dataset?.rwReview || "";
  if (writeId || recordId || reviewId) {
    const r =
      (writeId && state.rwPending.get(writeId)) || (recordId && state.rwDecided.get(recordId)) || (reviewId && state.rwReviews.get(reviewId)) || null;
    if (!r) return false;
    const job = rwAgentFor(r);
    if (!job) return dockNote(r, rwUnresolved(r));
    revealAgentHome(job.thread || job.id);
    return true;
  }
  // The head: the most urgent thing the dock holds, in the order it draws them, and the first one that can name an
  // agent. When none can, the FIRST one carries the reason.
  const byDeadline = (a, b) => (a.deadline || 0) - (b.deadline || 0);
  const newest = (a, b) => (b.at || 0) - (a.at || 0);
  const heads = [
    [...state.rwPending.values()].sort(byDeadline)[0],
    [...state.approvals.values()].sort(byDeadline)[0],
    [...state.rwReviews.values()].filter((r) => !r.kept).sort(newest)[0],
    [...state.rwDecided.values()].sort(newest)[0],
  ].filter(Boolean);
  let first = null;
  for (const r of heads) {
    if (!first) first = r;
    const job = r.thread ? null : rwAgentFor(r);
    const thread = r.thread || job?.thread || job?.id || "";
    if (thread) {
      revealAgentHome(thread);
      return true;
    }
  }
  return first ? dockNote(first, rwUnresolved(first)) : false;
}

// Keep: the write stands and the review goes. The panel drops its copy too, so a reload does not bring it back.
async function keepReview(id) {
  const r = state.rwReviews.get(id);
  if (!r) return;
  r.kept = true; // optimistic: the card goes at once
  renderApprovals();
  try {
    const res = await apiFetch("/api/remote-write/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "keep" }),
    });
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      throw new Error(out.error || `HTTP ${res.status}`);
    }
  } catch (e) {
    state.rwReviews.set(id, { ...r, kept: false });
    renderApprovals();
    showBanner(`could not record that keep: ${e.message}`);
  }
}

// The inverse of an auto-allowed write. A remote branch delete is run by the PANEL from the review's own record: the
// button names it, so the click IS the confirmation, and this page sends the record's ID and never a command.
// Anything with no safe inverse becomes a message DRAFTED to the agent, which the reader sends (or does not) —
// nothing auto-executes.
async function unwindReview(id) {
  const r = state.rwReviews.get(id);
  if (!r) return;
  const plan = r.unwind || {};
  if (plan.type !== "delete-branch") {
    const job = r.agentThread ? [...state.jobs.values()].find((j) => (j.thread || j.id) === r.agentThread) : rwAgentFor(r);
    if (!job) return dockNote(r, `no agent card to draft a message to — ${rwUnresolved(r)}`);
    const thread = job.thread || job.id;
    const text = String(plan.text || "").trim();
    if (!text) return dockNote(r, "no message was drafted for that write — nothing was run");
    revealAgentHome(thread);
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    if (!box) return dockNote(r, "that agent has no reply box on this board — nothing was drafted");
    writeBox(box, text);
    clearBoxDraft(box);
    state.replyDrafts[thread] = text;
    try {
      box.focus({ preventScroll: true });
    } catch {
      box.focus();
    }
    setCaretOffset(box, readBox(box).length);
    showNote(`drafted a message to ${job.title || job.label || thread} — it is yours to send`);
    return;
  }
  const btns = [...document.querySelectorAll(`[data-rw-review-unwind="${CSS.escape(id)}"]`)];
  btns.forEach((b) => (b.disabled = true));
  try {
    const res = await apiFetch("/api/remote-write/unwind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }), // the id only: the command is the review's, never this page's
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
    state.rwReviews.set(id, out.review || { ...r, state: "unwound", at: Date.now() });
    renderApprovals();
    showBanner(
      out.alreadyGone ? `the remote branch was already gone — ${plan.label || "nothing to delete"}` : `unwound — ${out.did || plan.label || "the write was reversed"}`,
    );
  } catch (e) {
    btns.forEach((b) => (b.disabled = false));
    dockNote(r, `unwind failed: ${e.message}`);
  }
}

function tickApprovals() {
  for (const r of state.approvals.values()) {
    const el = document.querySelector(`[data-approval-left="${CSS.escape(r.id)}"]`);
    if (!el) continue;
    const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
    el.textContent = left ? `expires in ${left}s` : "expired";
    el.classList.toggle("warn", left < 20);
  }
  // A decided record and a review are receipts with a lifetime. They age out HERE, on the page's own clock: the
  // corner clears itself whether or not another event ever arrives, which is what the reader asked for after a green
  // check sat under "waiting on you" until a reload.
  const now = Date.now();
  let aged = false;
  for (const [id, d] of state.rwDecided) {
    if (now - (Number(d.at) || 0) >= DECIDED_TTL_MS) {
      state.rwDecided.delete(id);
      aged = true;
    }
  }
  for (const [id, r] of state.rwReviews) {
    if (now - (Number(r.at) || 0) >= DECIDED_TTL_MS) {
      state.rwReviews.delete(id);
      aged = true;
    }
  }
  if (aged) renderApprovals();
  // …and a run's own approval box, which carries the gateway's window: its label counts down, and at the deadline
  // the buttons go. The panel's sweep removes the box a moment later (5s), and this is what covers the gap so the
  // reader never presses a choice the gateway has already refused.
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
  // The HUMAN button's count is a live fact like the countdowns above: a question whose window just closed is no
  // longer open, and a number that kept counting it would send the reader to a box that is over. One clock for
  // both, so nothing else has to remember to repaint it.
  paintHumanButton();
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
  // The same single flight as a run approval: this box can be drawn on the dock and on the card, and its id is
  // the request id the panel gave it.
  if (approvalInFlight(id, id)) return;
  const key = approvalFlightKey(id, id);
  approvalFlights.set(key, { id, requestId: id, choice, at: Date.now() });
  paintApprovalFlight(id, id, "sending");
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
      id,
      choice: out.choice || choice,
      why: out.why || "",
      command: req?.command || "",
      // The record has to be able to find its agent after the box is gone: a decided remote write carries no
      // thread, so the tree and the branch it was about are what `dockGoto` resolves through `state.jobs`.
      worktree: req?.worktree || "",
      branch: req?.branch || "",
      kind: req?.kind || "push",
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
    paintApprovalFlight(id, id, "error");
    box?.classList.add("is-error");
    showBanner(`could not answer that permission request: ${e.message}`);
  } finally {
    approvalFlights.delete(key);
  }
}

// Every output pane's position, so a rebuild can put the reader back where they were instead of
// dropping them at the first line of an hour-old transcript.
// ---- thinking -----------------------------------------------------------------------------
// The books the two display switches read. The switches themselves - the reader's per-session answer, the
// global default, and the press that flips it - live in public/turns.js with the turn head that draws them;
// these hang off `state`, so they stay with the state it is built in.
state.thinkCache = state.thinkCache || new Map(); // turn key -> { blocks, at }
state.thinkOpen = state.thinkOpen || new Set(); // turn keys whose block is expanded
state.thinkPinned = state.thinkPinned || new Map(); // block key -> false once the reader scrolls it up
state.thinkScroll = state.thinkScroll || new Map(); // block key -> where the reader left it, for a rebuild to restore
state.thinkClosed = state.thinkClosed || new Set(); // turn keys the reader folded on purpose
state.thinkLoading = state.thinkLoading || new Set();

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
state.reasoningReads = new Map(); // job -> { at, done }: the latest read begun for a call

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
// The console's own row renderer asks the same question for every row it draws (see consoleSetShownFor).
window.WMApp?.core?.consoleFormat?.setShownFor?.(typedShown);

// A background tab has no flow to show: release both buffers, so the reader comes back to the whole answer instead
// of to a transcript that is still typing out a paragraph nobody was watching.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  state.typeHold?.drain();
  state.typeGate?.drain();
  state.typePacer?.releaseAll();
});

// The block scrolls like a console: new thinking keeps the newest line in view unless the reader has gone back up.
// Without this every repaint (every couple of seconds while a turn runs) put the body back at its first line.
state.subConsolePinned = state.subConsolePinned || new Map(); // child console id -> false once the reader scrolls up
copyObserver.observe(document.documentElement, { childList: true, subtree: true });
mountCopyButtons(document.documentElement);
watchMotion(document.documentElement);

// The watch placedNodes() reads (see there): its own observer, so a lookup can take the records waiting for it
// without taking the copy observer's.
placedNodes.watch = (() => {
  // The consoles (pre.job-out, .think-body, .sub-console: the 400 ms sweep, the pacer, every line, every stream
  // repaint), plus the other nodes a clock walked the page for: tr.detail (sweepStaleBoard, ~44 a minute), .tgrp (the
  // 3 s tool-store refresh), .queue-ago (the 1 s queue clock, 49 ms a minute of native search on its own) and
  // [data-q-clock] (the question clocks).
  const kinds = ["pre.job-out", ".think-body", ".sub-console", "tr.detail", ".tgrp", ".queue-ago", "[data-q-clock]"];
  const w = { sets: new Map(kinds.map((k) => [k, new Set()])), any: kinds.join(", "), mo: null };
  w.mo = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) notePlaced(w, n);
  });
  w.mo.observe(document.documentElement, { childList: true, subtree: true });
  notePlaced(w, document.documentElement);
  return w;
})();

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
for (const ev of ["wheel", "mousedown", "keydown", "touchstart"]) {
  document.addEventListener(ev, (e) => {
    const card = e.target && e.target.closest ? e.target.closest(".job[data-thread]") : null;
    if (!card) return;
    lastInputAt.set(card.dataset.thread, Date.now());
  }, { capture: true, passive: true });
}

// Cards for agents owned by a worktree are painted by the row-detail renderer, not by
// renderConversation/renderJobs, so a one-shot focus after a render is the wrong shape: a spawn can
// repaint through any of several paths. A cheap watch re-applies the caret while the target stands.
setInterval(applyPendingFocus, 250);
document.addEventListener("wheel", endFollowOnScroll, { passive: true });
document.addEventListener("scroll", endFollowOnScroll, { passive: true, capture: true });
document.addEventListener("touchmove", endFollowOnScroll, { passive: true });

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
  // The gateway's word for a turn it admitted and never executed: the session it was posted to is fenced, and
  // nothing about that run will ever settle. The retry is exactly the repair — it opens a NEW session for the
  // thread — so this word has to offer the button, not hide it.
  if (/unknown_execution/i.test(s)) return true;
  const http = /HTTP (\d{3})/.exec(s);
  if (http) return Number(http[1]) >= 500 || Number(http[1]) === 429;
  if (/rate limit|rate-limited|429|overloaded|temporarily unavailable/i.test(s)) return true;
  return false;
}
// ---- end retry

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
  // The live turn shows its console only while it is open — and only while its page is the one on screen, so this
  // also pages a card the reader had walked back through (the module's one "put this turn in front of the reader").
  if (running && found.turnId) {
    const conv = conversations().find((c) => c.thread === found.thread);
    if (conv && wtTurnFold.reveal(state, found.thread, conv.turns, found.turnId).changed) {
      renderConversation(found.thread);
    }
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
  if (assistantSessionFor(conv?.thread)) return false;
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
  // A job that started, stopped or parked changes the HUMAN rotation's own list, and the count on its button is
  // how the reader notices a question without looking for it — so it is repainted with the rest of the state.
  paintHumanButton();
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
  // `approvalDone` is deliberately absent: a turn whose FIRST approval was answered is not thereby un-parked when
  // its SECOND one arrives, and this badge is how the reader is told a human is needed (docs/steer-refusal.md §1.4).
  const waiting = mine.filter((c) => (c.turns || []).some((t) => approvalLive(t.approval) && turnLive(t))).length;
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
    markUnder(held, key);
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
  markUnder(confirm, key);
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
  // A RELEASED row's badge carries the REASON its path stopped being a tree (lib/own-tree.js), because the counts
  // beside it are empty by construction: the tooltip is the only place the reader can find out that this is a folder
  // left behind, and which checkout git would answer for there.
  const released = String(row.released?.why || "");
  // The count against the project's main lives HERE now: the Ahead / Behind column counts the branch against its own
  // copy on the remote. Every title below ends with it, and a plain badge, which had no title at all, carries it alone.
  // Inline, not a helper: this region is read out of the page on its own (tools/verify-merge-chip.mjs).
  const vs =
    row.baseRef && row.ahead !== null && row.ahead !== undefined
      ? `Against ${row.baseRef}: ${Number(row.ahead) || 0} ahead, ${Number(row.behind) || 0} behind.`
      : "";
  const withVs = (t) => (vs ? `${t} — ${vs}` : t);
  // Every other verdict is a statement; only UNMERGED has an action behind it.
  if (!verdict.startsWith("UNMERGED")) {
    const title = released || vs;
    return `<span class="${cls}"${title ? ` title="${esc(title)}"` : ""}>${text}</span>`;
  }
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

// ---- pr cell: the number and the state, or the one word `none` ----------------------------------------------
// The PR cell: the number and state are the server's (row.pr), and the PAGE is the project's host record — `row.prUrl`
// is built by the same template as the branch cell, so `.../pull-requests/12` and `.../pull/12` both come out right
// without this file knowing which host it is looking at. No URL (an unmapped project, or a host whose pull template
// cannot be filled): the same chip, plain, with the reason in its title. Never an `<a>` around a guessed page.
//
// No PR is one word: `none`. A row whose branch had been deleted from the remote used to read `none · branch gone`
// here, but the branch column one cell to the left already answers that — plain text instead of the blue link, with
// the `local` chip and the reason in its tooltip — so the second half only widened this column with a word the reader
// had read in the cell beside it. This cell answers one question, "which PR is this row's", and `none` is the whole
// answer. `test/pr-cell-none.test.js` holds it to the one word on every `remoteBranch` state.
function prCellHtml(row) {
  if (!row.pr) return `<span class="dimmer">none</span>`;
  const cls = row.pr.state === "OPEN" ? "pr-open" : "pr-merged";
  const text = `#${row.pr.number} ${row.pr.state}`;
  const why = row.prUrl ? "" : row.prWhy ? ` · no PR page: ${row.prWhy}` : "";
  const title = `${row.pr.title || ""}${prMatchNote(row.pr)}${why}`;
  if (row.prUrl) {
    return `<a class="pr-link ${cls}" href="${esc(row.prUrl)}" target="_blank" rel="noopener" title="${esc(`${text} — open this PR${why}`)}">${esc(text)}</a>`;
  }
  return `<span class="${cls}" title="${esc(title)}">${esc(text)}</span>`;
}
// ---- end pr cell

// ---- owner cell: the assistant's compact tag, and its name and role in the tooltip -----------------------------
// The owner column answers "whose is this tree" in one glyph pair instead of one name: M1 is Manager 1, M2 is
// Manager 2, A1 is Assistant #1. A cell is one word wide and eleven columns do not fit a name like "Assistant #2"
// twice over, so the cell carries the TAG and the tooltip carries the sentence — the assistant's own name, the
// numbered role label the server resolved, and the display-only reminder. The row's detail keeps the long form
// ("Controlled by: Assistant #1 — Manager") for the reader who wants it spelled out.
//
// The default owner IS Assistant #1, so a row with no `assistant` at all (an older payload, a hand-built row) still
// draws a tag rather than an empty cell or a dash: a column of dashes hides the fact that nothing there is unowned.
// The fallback sentence — the stored owner is no longer on the board — travels in the tooltip and in the detail's
// bullet, because a cell is one tag wide. Nothing in the wake path reads any of this.
//
// The class is `owner`, NOT `assistant`: `.assistant` is the rail's own rule (a sticky flex column 480px wide), and
// a `<td class="assistant">` inherited every line of it — a 480px column, a sticky cell, a left border and the rail's
// background painted into the middle of the chart. The tag class is `owner-tag` for the same reason.
const ownerNameOf = (row) => String(row?.assistant?.name || "").trim() || "Assistant #1";
const ownerLabelOf = (row) => String(row?.assistant?.label || "").trim();
const ownerRoleOf = (row) => String(row?.assistant?.role || "").trim();

// "Manager 1" → "M1", "Code Reviewer 2" → "CR2", "Assistant #1" → "A1". The number comes from the numbered ROLE
// LABEL (the server resolves it from the role the owner runs), and the letters are its initials, so a renamed role
// renames the tag without a write. A row the server could not label falls back to its own name, which always ends in
// the assistant's number.
function ownerTagOf(row) {
  const label = ownerLabelOf(row);
  const name = ownerNameOf(row);
  const source = label || name;
  const m = /^(.*?)[\s#]*(\d+)\s*$/.exec(source);
  const words = String(m ? m[1] : source)
    .split(/[\s/—-]+/)
    .filter(Boolean);
  const initials = words
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return `${initials || "A"}${m ? m[2] : ""}`;
}

function ownerCellHtml(row) {
  const name = ownerNameOf(row);
  const label = ownerLabelOf(row);
  const tag = ownerTagOf(row);
  const seat = `${tag} — ${name}${label ? ` (${label})` : ""} owns this worktree`;
  const title = row?.assistant?.fallback
    ? `${seat} — ${row.assistant.fallback}`
    : `${seat}. Display only: it does not change who wakes or runs.`;
  return `<td class="owner nowrap" title="${esc(title)}"><span class="owner-tag" aria-label="${esc(name)}">${esc(tag)}</span></td>`;
}
function ownerDetailHtml(row) {
  const role = ownerRoleOf(row);
  const fallback = row?.assistant?.fallback ? `<span class="owner-fallback"> — ${esc(row.assistant.fallback)}</span>` : "";
  return `<li class="git-owner" title="the assistant that owns this worktree — its own name, then the role it runs; display only: it does not change who wakes or runs">Controlled by: ${esc(ownerNameOf(row))}${role ? ` — ${esc(role)}` : ""}${fallback}</li>`;
}
// ---- end owner cell

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
  const roots = boardGroups(host).map((g) => g.dataset.root).filter(Boolean);
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
  const cell = rowNode(key)?.querySelector("td.age") || null;
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
  for (const d of placedNodes("tr.detail").filter((el) => el.hasAttribute("data-detail"))) {
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
      if (card.closest("[data-subpane=\"chat\"]")) return 5;
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
  // Moving a card that is already in the page is a remove-then-insert: every scroll box inside it comes back at its
  // first line, and a selection standing in it is dropped. Both belong to the reader, so a reused card carries them
  // across the move. A project repaint re-places every card in the row, and with three live agents that was every
  // console hopping to the top on each repaint — one agent's event, every other agent's console.
  const heldSelection = reuse && reuse.size ? captureCardSelection() : null;
  for (const slot of [...root.querySelectorAll("[data-agent-slot]")]) {
    const thread = slot.dataset.agentSlot;
    const card = reuse?.get(thread);
    if (card) {
      const held = holdScrolls(card);
      slot.replaceWith(card);
      releaseScrolls(held);
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
      // No card was carried into this slot: the rebuild BUILT one, so its consoles have no old node to read and no
      // entry in the caller's scroll map, and the same-task restores below skip them. Place them here, before the
      // frame the insert is in is painted - the top of a log the run has been writing is not where the reader was.
      placeBuiltConsoles(fresh);
    } else slot.remove();
  }
  if (heldSelection && heldSelection.length) restoreCardSelection(heldSelection);
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
  markUnder(fresh, key);
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
          ${ownerDetailHtml(row)}
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
    // A RELEASED row is a folder left behind, not work waiting to merge: it is counted in the tree total only.
    return !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN" && v !== "RELEASED";
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
  // rows below this project's top N (chartTopOrder: newest activity first, then by name), and it goes away the moment
  // that chart is asked for everything.
  const topCount = chartTopLimit();
  const held = state.showOldProjects.has(name) ? 0 : chartTopSplit(rows).held.length;
  const out = [`<span class="chip">${rows.length} worktrees</span>`];
  if (held) out.push(`<span class="chip" title="${esc(`${held} worktree${held === 1 ? "" : "s"} below the top ${topCount} — newest activity first, then by name; the arrow at the bottom of the chart shows ${held === 1 ? "it" : "them"} in that same order`)}">${held} more hidden</span>`);
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
  // Same rule as the row badge: the park on the card is the signal, not the record of an earlier answer.
  const panelWaiting = panelAgents.filter((c) =>
    (c.turns || []).some((t) => approvalLive(t.approval) && turnLive(t)),
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
      <span class="host-fields">
      ${pushControlsHtml(name)}
      <label class="host-field">host <select data-host-select="${esc(name)}"${panel.busy ? " disabled" : ""}>${opts}</select></label>
      <label class="host-field">coordinates <input type="text" class="mono" data-host-coords="${esc(name)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false" placeholder="owner/repo or PROJECT/slug" value="${esc(panel.coords || "")}"${panel.busy ? " disabled" : ""}></label>
      <button type="button" data-host-save="${esc(name)}"${panel.busy ? " disabled" : ""}>Use this mapping</button>
      <button type="button" data-host-cancel="${esc(name)}">Cancel</button>
      </span>
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
        ? `${prop.remoteUrl} -> ${prop.host}`
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

// The window does not have to move for the CHART's width to change: the assistant rail is a flex item beside main, so
// opening it, closing it or dragging its edge takes 340-640px away from (or gives them back to) every table at once —
// and not one of those is a `resize` event. That was the visibility half of the rail's bug: the columns kept the
// split they were planned at, the table kept its sum-of-widths box, and the card clipped the overflow at the rail's
// left edge. main is the one element whose box IS the chart's width, so it is the one to watch; the fit is coalesced
// on the same 140ms timer as a window resize, because a rail drag changes it every frame.
let boardWidthObserver = null;
function watchBoardWidth() {
  const main = document.querySelector("main");
  if (!main || typeof ResizeObserver !== "function") return;
  if (boardWidthObserver) boardWidthObserver.disconnect();
  let last = Math.floor(main.clientWidth);
  boardWidthObserver = new ResizeObserver(() => {
    const now = Math.floor(main.clientWidth);
    if (now === last) return;
    last = now;
    clearTimeout(columnFitTimer);
    columnFitTimer = setTimeout(fitAllColumns, 140);
  });
  boardWidthObserver.observe(main);
}
watchBoardWidth();

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
  //
  // Every configured root gets a card even when discovery has found nothing under it yet: the folder the reader just
  // named in Settings → Board has to appear, saying it holds no repo, instead of the list changing and the board not.
  // An empty group sorts last (activity 0) and its own card says why it is empty.
  const groups = new Map();
  for (const root of state.scanRoots || []) {
    const key = normPath(root);
    if (key) groups.set(key, []);
  }
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
      .sort((a, b) => folderActivity(b[1]) - folderActivity(a[1]) || a[0].localeCompare(b[0]))
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

// The banner FLOATS under the sticky topbar, so a message that appears moves nothing on the board. The layer is
// the fixed box and its three sides are measured here: the topbar's height (it wraps to a second row on a narrow
// window, so it is never a constant) and the board's own column, which is what keeps the docked rail uncovered.
// A measured client rect is VISUAL px while a length written to `style` is LAYOUT px, so both are divided by the
// page zoom — the same conversion assistant.js's `cssPx` makes for the rail.
function placeBanner() {
  const layer = $("banner-layer");
  const topbar = document.querySelector(".topbar");
  const main = document.querySelector(".shell > main");
  if (!layer || !topbar || !main) return;
  const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const bar = topbar.getBoundingClientRect();
  const col = main.getBoundingClientRect();
  layer.style.top = `${Math.max(0, bar.height / z)}px`;
  layer.style.left = `${Math.max(0, col.left / z)}px`;
  layer.style.right = `${Math.max(0, vw - col.right / z)}px`;
}

// ---- how long a red failure stays before it takes itself away -----------------------------------
// A failure used to sit there until its ✕ was pressed, so on a board that polls every few seconds it could outlive
// the condition it described and still be read minutes later. A red message now hides itself after the seconds in
// Settings → Board (0 keeps it until the ✕), the clock pauses while the pointer or the keyboard focus is inside the
// bar, and the ✕ is still an instant dismissal. The green confirmation is not a failure: it keeps its own four
// seconds whatever this is set to.
const BANNER_SECONDS_KEY = "wtgui.bannerSeconds";
const BANNER_SECONDS_DEFAULT = 5;
const BANNER_SECONDS_MAX = 30;
const BANNER_NOTE_MS = 4000;

function bannerSeconds() {
  let raw = null;
  try {
    raw = localStorage.getItem(BANNER_SECONDS_KEY);
  } catch {
    // A browser that refuses storage still gets the panel's default; the setting just will not persist.
    return BANNER_SECONDS_DEFAULT;
  }
  if (raw === null) return BANNER_SECONDS_DEFAULT;
  const text = String(raw).trim();
  if (text === "") return BANNER_SECONDS_DEFAULT;
  const n = Number(text);
  if (!Number.isFinite(n)) return BANNER_SECONDS_DEFAULT;
  return Math.max(0, Math.min(BANNER_SECONDS_MAX, Math.round(n)));
}

let noteTimer = 0;
let bannerTimer = 0;

function stopBannerTimer() {
  clearTimeout(bannerTimer);
  bannerTimer = 0;
}

// Is the bar being held? Asked of the DOM rather than kept in a flag: a flag set on pointerenter survives the bar
// being hidden under the pointer and would silence the next failure's clock.
function bannerHeld() {
  const b = $("banner");
  if (!b) return false;
  return b.matches(":hover") || b.contains(document.activeElement);
}

// (Re)start the red banner's clock. Called when a message goes up and when a hold ends, so a failure gets the full
// delay from the moment the reader stops reading it — not the remainder of the old one.
function armBannerTimer() {
  stopBannerTimer();
  if (bannerHeld()) return;
  const ms = bannerSeconds() * 1000;
  if (ms <= 0) return;
  bannerTimer = setTimeout(() => {
    bannerTimer = 0;
    if (bannerHeld()) return armBannerTimer();
    hideBanner();
  }, ms);
}

function hideBanner() {
  const b = $("banner");
  if (!b) return;
  clearTimeout(noteTimer);
  noteTimer = 0;
  stopBannerTimer();
  b.classList.add("hidden");
  b.classList.remove("ok");
}

function showBanner(msg) {
  const b = $("banner");
  if (!b) return;
  if (!msg) return hideBanner();
  const text = $("banner-text");
  if (text) text.textContent = msg;
  else b.textContent = msg;
  const x = b.querySelector(".banner-x");
  if (x) x.hidden = false;
  // The green note's pending timer must not take a failure away, and a second failure restarts the clock: the
  // message the reader is looking at now is the one that gets the full delay.
  clearTimeout(noteTimer);
  noteTimer = 0;
  b.classList.remove("ok");
  placeBanner();
  b.classList.remove("hidden");
  armBannerTimer();
}

// The Board tab's seconds row: the number the bar's clock reads. A typed value is clamped on change (and Enter),
// like the other numeric rows.
function paintBannerSetting(note = "") {
  const input = $("banner-seconds");
  const seconds = bannerSeconds();
  if (input && document.activeElement !== input) input.value = String(seconds);
  const preview = $("banner-preview");
  if (preview) {
    const what = seconds
      ? `a red failure hides itself after ${seconds} s`
      : "a red failure stays until its ✕ (0 = never hides itself)";
    preview.textContent = note ? `${note} — ${what}` : `${what}, unless you hover or focus it (a green note still goes after 4 s)`;
  }
}

function saveBannerSetting(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    paintBannerSetting("NOT SAVED — give a number of seconds, 0 to keep failures until ✕");
    return;
  }
  const clamped = Math.max(0, Math.min(BANNER_SECONDS_MAX, Math.round(raw)));
  try {
    localStorage.setItem(BANNER_SECONDS_KEY, String(clamped));
  } catch {
    paintBannerSetting("NOT SAVED — this browser refused to store the setting");
    return;
  }
  // A failure already on screen follows the new number at once: 0 leaves it alone, a number gives it the full new
  // delay rather than whatever was left of the old one.
  const b = $("banner");
  if (b && !b.classList.contains("hidden") && !b.classList.contains("ok")) armBannerTimer();
  paintBannerSetting(clamped === Math.round(raw) ? "saved" : `saved, clamped to ${BANNER_SECONDS_MAX} s`);
}

// Holding the bar pauses the clock; letting go starts the full delay again. Pointer and keyboard are separate
// entries because the ✕ is a real focus target: tabbing to it and reading is the same pause as pointing at it.
$("banner")?.addEventListener("pointerenter", stopBannerTimer);
$("banner")?.addEventListener("pointerleave", armBannerTimer);
$("banner")?.addEventListener("focusin", stopBannerTimer);
$("banner")?.addEventListener("focusout", (e) => {
  const b = $("banner");
  if (b && e.relatedTarget && b.contains(e.relatedTarget)) return;
  armBannerTimer();
});
$("banner-seconds")?.addEventListener("change", (e) => saveBannerSetting(e.target.value));
$("banner-seconds")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveBannerSetting(e.target.value);
    e.target.blur();
  }
});
paintBannerSetting();

// A short green confirmation (the red banner is for failures): used when a gesture did what it said
// without opening a dialog, e.g. an agent attaching itself to the worktree it was already sitting in.
// It is not a failure to dismiss, so it carries no ✕ and takes itself away after four seconds — its own
// fixed number, not the Board tab's, which is about failures.
function showNote(msg) {
  const b = $("banner");
  if (!b) return;
  const text = $("banner-text");
  if (text) text.textContent = msg;
  else b.textContent = msg;
  const x = b.querySelector(".banner-x");
  if (x) x.hidden = true;
  b.classList.add("ok");
  placeBanner();
  b.classList.remove("hidden");
  // A note can replace a red bar: the red bar's clock must not take the green one away at its own deadline.
  stopBannerTimer();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(hideBanner, BANNER_NOTE_MS);
}

$("banner")?.querySelector(".banner-x")?.addEventListener("click", () => hideBanner());
// Two things the layer is measured against move without a window resize: the topbar (it wraps) and the board's
// column (the rail opens, closes and is dragged). One observer on both keeps the bar where it belongs.
if (typeof ResizeObserver === "function") {
  const bannerResize = new ResizeObserver(() => placeBanner());
  for (const el of [document.querySelector(".topbar"), document.querySelector(".shell > main")]) if (el) bannerResize.observe(el);
}
window.addEventListener("resize", placeBanner);

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

// Ctrl+[ peels ONE tier off the board (the lowest tier with anything open: turn bodies, then cards, then rows,
// then projects, then the folders and the two fixed cards) and Ctrl+] opens everything — the square brackets point
// the way (in, then out). A board with nothing open makes the left bracket a no-op: it must never fall through
// into expanding. The one-press "collapse everything" is the header button, which says so.
// Ignored while a field has focus: a bracket belongs in a prompt or a filter, not on the board.
window.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.metaKey || e.altKey) return;
  // e.key is layout-dependent; e.code is not, so either identifies the key.
  const collapse = e.key === "[" || e.code === "BracketLeft";
  const expand = e.key === "]" || e.code === "BracketRight";
  if (!collapse && !expand) return;
  const el = e.target;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  e.preventDefault();
  if (collapse) collapseOneTier();
  else setEverythingOpen(true);
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
// Ctrl+wheel over a card's console text resizes it, the way a terminal does, instead of zooming the page. ONE size
// drives all of it — the agent's own words, a tool's output and its reasoning — so this writes the console's single
// variable (`--term-size`) on the card, which is the same variable Settings' Console size sets on the root: a zoom is
// a per-card override of that one baseline, and no second knob can drift out of step with it. Scoped to the card, so
// one long transcript can be shrunk without touching the rest of the board. Steps of half a pixel, clamped to what a
// monospace face still reads at; the page zoom is only suppressed while the pointer is over console text.
const CONSOLE_ZOOM_MIN = 7;
const CONSOLE_ZOOM_MAX = 24;

// The size in force on this card, read from the one variable rather than from whichever element the wheel was over
// (a `.think-body` carries no font-size of its own — only the blocks inside it do).
function cardConsoleSize(card) {
  const css = parseFloat(getComputedStyle(card).getPropertyValue("--term-size"));
  return Number.isFinite(css) ? css : 11.5;
}

function zoomConsole(zone, step) {
  const card = zone.closest(".job");
  const thread = card && card.dataset.thread;
  if (!thread) return;
  const base = Number(state.consoleZoom.get(thread)) || cardConsoleSize(card);
  // Half-pixel steps: the console's default size is 11.5px, and rounding to whole pixels made the first tick
  // jump 1.5px while every tick after it moved 1.
  const next = Math.min(CONSOLE_ZOOM_MAX, Math.max(CONSOLE_ZOOM_MIN, Math.round((base + step) * 2) / 2));
  state.consoleZoom.set(thread, next);
  card.style.setProperty("--term-size", `${next}px`);
}

// Ctrl+wheel over a console must not ALSO zoom the window. Cancel it at the earliest point in the event's path
// (capture on window) and stop it there, so neither the page's own listeners nor anything above them sees a
// cancellable wheel: a passive listener anywhere in the path - the panel has one on document for pendingFocus -
// can otherwise leave the browser free to run its zoom gesture.
// The zones are one selector's worth: `.job-out` holds the agent's words, a tool's output and (in 🌊) its reasoning;
// `.think-body` is the 🧠 block above the console. Any of them sizes the whole card, the same single step.
const onConsoleWheel = (e) => {
  if (!e.ctrlKey) return;
  const target = e.target && e.target.closest ? e.target : null;
  const zone = target ? target.closest(".job-out, .think-body") : null;
  if (!zone) return;
  if (e.cancelable) e.preventDefault();
  e.stopPropagation();
  zoomConsole(zone, e.deltaY < 0 ? 1 : -1);
};
window.addEventListener("wheel", onConsoleWheel, { passive: false, capture: true });
// Trackpad pinch arrives as a gesture in Safari, not as a ctrl+wheel, and would zoom the page under the pointer.
for (const type of ["gesturestart", "gesturechange"]) {
  window.addEventListener(
    type,
    (e) => {
      const zone = e.target && e.target.closest ? e.target.closest(".job-out, .think-body") : null;
      if (!zone) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    },
    { passive: false, capture: true },
  );
}

// The console resizes like the reply box, but its max-height is what stops it eating the card — and a
// max-height also stops the drag dead. The handle lives in the bottom-right 16px corner, so grabbing there
// pins the height the console has NOW and lifts the cap in the same breath. Lifting the cap on its own grew
// the box to its whole transcript on pointerdown — measured 230px -> 1053px on a 120-line job — so the handle
// jumped 827px below the cursor before the drag started, and the drag then moved nothing the reader could see.
// Pinning the current height keeps the corner under the pointer, and the drag's inline height wins over the cap.
let consoleDrag = null;
document.addEventListener(
  "pointerdown",
  (e) => {
    const out = e.target && e.target.closest ? e.target.closest(".job-out") : null;
    if (!out) return;
    const r = out.getBoundingClientRect();
    if (!(e.clientX >= r.right - 16 && e.clientY >= r.bottom - 16)) return;
    consoleDrag = { out, height: r.height, styleHeight: out.style.height, cap: out.style.maxHeight };
    out.style.height = `${r.height}px`;
    out.style.maxHeight = "none";
  },
  true,
);
// A grab that moved nothing is a press on the corner, not a resize: put back what was there, so a click near
// the handle does not leave the transcript pinned open at its full 1053px (or a short console pinned short).
// A grab that DID move is a height the reader chose, and it is recorded against the turn here — the one place that
// knows a press from a drag. Every rebuild that replaces or builds this box puts it back (applyStoredHeight), and it is
// persisted, so the reload that rebuilds every card on the board does not lose it either.
window.addEventListener(
  "pointerup",
  () => {
    if (!consoleDrag) return;
    const { out, height, styleHeight, cap } = consoleDrag;
    consoleDrag = null;
    const now = out.getBoundingClientRect().height;
    if (Math.abs(now - height) < 1) {
      out.style.height = styleHeight;
      out.style.maxHeight = cap;
      return;
    }
    rememberOutHeight(out.dataset.out, now);
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
// PAUSE lives in Settings now, beside the scan and read rows it freezes (it used to be a header button). The
// handler is unchanged in what it does and still finds the control by id, so moving the markup moved the control
// and nothing else: a press closes the live stream and says so in the status line, and the next press reconnects and
// re-syncs. The button carries its own state (label, aria-pressed, title) so closing Settings and opening it again
// reads the same answer, and the paint runs once at boot for a page that starts unpaused.
function paintPauseButton() {
  const btn = $("btn-pause");
  if (!btn) return;
  btn.textContent = state.paused ? "Resume" : "Pause";
  btn.setAttribute("aria-pressed", state.paused ? "true" : "false");
  btn.title = state.paused
    ? "resume the live stream — reconnects and re-syncs every row of the board"
    : "pause the live stream — nothing updates until you press Resume, which reconnects and re-syncs the board";
}
$("btn-pause")?.addEventListener("click", () => {
  state.paused = !state.paused;
  paintPauseButton();
  if (state.paused) {
    state.es?.close();
    setStream("paused", "warn");
  } else {
    connect();
    resync();
  }
});
paintPauseButton();

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
  // Fold a parent's children out of sight, or back into it. A picture, not a write: no request leaves the page, no row
  // is rebuilt, and the children are only hidden where they stand — an open console, a half-typed reply and a scroll
  // position are all still there when the fold opens again.
  const foldTree = e.target.closest("[data-fold-tree]");
  if (foldTree) {
    e.preventDefault();
    e.stopPropagation();
    toggleChildFold(foldTree.dataset.foldTree);
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
  const rnew = e.target.closest("[data-project-new]");
  if (rnew) {
    e.stopPropagation();
    e.preventDefault();
    void newProjectInRoot(rnew);
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
  // The dock's own controls, then the dock itself. The ▾ folds and unfolds; the HEAD and any CARD take the reader to
  // the agent that asked — a click there must never fold, which would hide the thing they just aimed at.
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
  if (e.target.closest("#approvals")) {
    const dismiss = e.target.closest("[data-rw-dismiss]");
    if (dismiss) {
      e.preventDefault();
      e.stopPropagation();
      state.rwDecided.delete(dismiss.dataset.rwDismiss);
      renderApprovals();
      return;
    }
    // `clear` empties its own group: the decided receipts, or the reviews (which the panel keeps on its own side
    // until its window closes — a cleared review does not come back on this page).
    const clear = e.target.closest("[data-rw-clear]");
    if (clear) {
      e.preventDefault();
      e.stopPropagation();
      if (clear.dataset.rwClear === "review") for (const r of state.rwReviews.values()) r.kept = true;
      else state.rwDecided.clear();
      renderApprovals();
      return;
    }
    const keep = e.target.closest("[data-rw-review-keep]");
    if (keep) {
      e.preventDefault();
      e.stopPropagation();
      void keepReview(keep.dataset.rwReviewKeep);
      return;
    }
    const unwind = e.target.closest("[data-rw-review-unwind]");
    if (unwind) {
      e.preventDefault();
      e.stopPropagation();
      void unwindReview(unwind.dataset.rwReviewUnwind);
      return;
    }
    // The choice buttons keep the pointerup path that answers them; every other button inside a card (a link, a
    // control this function does not know) must not turn into a jump.
    if (e.target.closest("button, a, input, select, textarea, label")) return;
    e.preventDefault();
    e.stopPropagation();
    dockGoto(e.target.closest("[data-approval], [data-remote-write], [data-rw-record], [data-rw-review]"));
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
  // Turn pagination: the arrows sit in the card head, next to the turn count. Going up and back down IS the collapse
  // gesture — the page just left folds, and only a starred turn's pinned copy is left for the reader's own click
  // (public/core/turn-fold.js). An arrow pressed at its own end left no page, so nothing folds and nothing repaints.
  const pageBtn = e.target.closest("[data-turn-page]");
  if (pageBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = pageBtn.dataset.threadPage;
    const conv = conversations().find((c) => c.thread === thread);
    if (conv) {
      const moved = wtTurnFold.stepPage(state, thread, conv.turns.length, pageBtn.dataset.turnPage);
      if (moved) {
        wtTurnFold.foldPage(state, conv.turns, moved.left.offset);
        renderConversation(thread);
      }
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
  // The console's own views, before the code-box fold: a fence's "show N lines" button, the raw toggle and focus.
  // Each is a press on ONE console but the state is the TURN's, so every copy of it (the card's and the pinned
  // strip's) moves together.
  const fenceBtn = e.target.closest("[data-md-fence]");
  if (fenceBtn) {
    e.preventDefault();
    e.stopPropagation();
    toggleConsoleFence(fenceBtn);
    return;
  }
  const rawBtn = e.target.closest("[data-md-raw]");
  if (rawBtn) {
    e.preventDefault();
    e.stopPropagation();
    toggleConsoleRaw(rawBtn);
    return;
  }
  const focusBtn = e.target.closest("[data-md-focus]");
  if (focusBtn) {
    e.preventDefault();
    e.stopPropagation();
    toggleConsoleFocus(focusBtn);
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
    // Two answers from one read, because they are different questions. The PIN is the reader's own gesture landing on
    // the newest line itself (2 px): a 32 px tolerance re-pinned a console parked one tall row up, and the next
    // arriving line carried it to the bottom - the "bouncing" a reader gets while reading the last lines. The RECORD
    // kept for a rebuild asks "was the reader at the bottom?", keeps its own tolerance, and is what the restores read.
    const gap = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
    const onTail = gap <= 2;
    const atBottom = gap < 32;
    // Only a reader's own input decides the pin. Without this, a clamp that happens while a card is rebuilt looks
    // exactly like someone scrolling up, and the console sticks at the top until they notice.
    if (readerInputHere(pre)) state.outPinned[pre.dataset.out] = onTail;
    state.outScrolls[pre.dataset.out] = { top: pre.scrollTop, atBottom };
  },
  true,
);

// Whatever moved a pinned console off its newest line - a rebuild, the browser clamping a replaced node, a resize -
// is corrected here within a frame or two. Only pinned consoles are touched, so reading history is never interrupted.
setInterval(() => {
  for (const pre of placedNodes("pre.job-out")) {
    stickConsole(pre);
    paintToBottom(pre);
  }
  for (const body of placedNodes(".think-body")) {
    stickThinkBody(body);
    paintToBottom(body);
  }
  for (const box of placedNodes(".sub-console")) stickSubConsole(box);
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
        scheduleCollapseCascade("row", key, true);
      } else {
        state.expanded.add(key);
        const holder = document.createElement("tbody");
        holder.innerHTML = detailHtml(row);
        const dEl = holder.firstElementChild;
        markUnder(dEl, key);
        tr.after(dEl);
        state.detailEls.set(key, dEl);
        fillAgentSlots(dEl, new Map());
        tr.classList.add("expanded");
        scheduleCollapseCascade("row", key, false);
      }
    },
  );
});

setInterval(() => {
  // A hidden tab has nothing to repaint: timers keep firing there, and the work (plus the layout
  // each repaint forces) is what made coming back to the tab feel like a freeze.
  if (document.hidden) return;
  for (const el of placedNodes(".queue-ago")) {
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
    const convs = conversations().filter((c) => !assistantSessionFor(c.thread));
    const running = convs.filter(convLive).length;
    if (convs.length) bits.push(`${convs.length} conversation${convs.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`);
  }
  if (state.lastEventAt) {
    const rate = state.events / Math.max(1, (Date.now() - state.eventsAt) / 1000);
    bits.push(`${state.events} events · ${rate.toFixed(1)}/s`);
  } else {
    bits.push("no changes yet");
  }
  const rateEl = $("stream-rate");
  rateEl.textContent = bits.join(" · ");
  // The line ellipsizes when the header is narrow (style.css pins it so its length cannot move the buttons to its
  // right); the whole sentence stays one hover away.
  rateEl.title = rateEl.textContent;
}, 1000);

setInterval(() => {
  if (state.paused) return;
  // The Gateway tab's bridge row is re-read on THIS clock, never a timer of its own: the pid behind the dot can
  // die while the tab is open, and a reader watching a bridge start should see it go green without a reload. Only
  // while that tab is the one on screen — a closed Settings window asks nothing.
  if (matrixSettingsShowing()) void loadMatrixStatus();
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

// ---- HUMAN's landing helpers (they outlived the NOT-RUNNING rotation) -------------------------
// These three were board/hot.js. The NOT-RUNNING button and its rotation are gone; HUMAN still lands a question
// by opening the same path (hotOpenPath), finds the row a thread lives in (hotRowFor) and rings the card amber
// (flashHotCard, kept in state.hotFlash so a repaint re-applies it). Same code, one caller now.
function hotRowFor(thread) {
  for (const row of state.rows.values()) {
    if (agentsFor(row).some((c) => c.thread === thread)) return row;
  }
  return null;
}

// Open exactly the path to one card and close everything else: after Collapse all the project is only "open"
// in state, and the folder holding it is still shut - an open project inside a closed folder is not on screen,
// which is why the counter moved and nothing appeared. The rotation keeps one project visible at a time.
function hotOpenPath(row) {
  const project = row.project;
  for (const name of [...state.expandedProjects]) {
    if (name !== project) toggleProject(name);
  }
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(project)}"]`);
  const root = sec?.closest("section.root-group")?.dataset.root;
  if (root && state.collapsedRoots.has(root)) {
    state.collapsedRoots.delete(root);
    saveCollapsedRoots();
    applyRootCollapse(root);
    paintCollapseAll();
  }
  if (!state.expandedProjects.has(project)) toggleProject(project);
  const key = keyOf(project, row.path);
  if (!state.expanded.has(key)) {
    document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  }
}

// The whole card flashes, not just the box: the rotation moves the reader's attention to a panel, and a ring
// around the panel is what says "this one". The caret still lands in the prompt's answer control.
function flashHotCard(thread) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return;
  const until = Date.now() + 1300;
  state.hotFlash = { thread, until };
  card.classList.remove("hot-flash");
  void card.offsetWidth; // restart it even when the last flash is still fading
  card.classList.add("hot-flash");
  clearTimeout(state.hotFlashTimer);
  state.hotFlashTimer = setTimeout(() => {
    state.hotFlash = { thread: null, until: 0 };
    document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)?.classList.remove("hot-flash");
  }, 1300);
}

// ---- HUMAN (the question rotation) -----------------------------------------------------------
// Every OPEN question on the board, in one rotation — a turn parked on a permission request, an agent parked on
// its own `clarify` question, and the dock's own permission cards (a CLI approval, or the panel's remote-write
// request). An agent can be RUNNING and still hold a question, which is why a rotation over stopped agents could
// never reach them.
//
// THE LIST IS NEVER CACHED. It is rebuilt from live state on every press, so a question that was answered, timed
// out, or whose turn ended is simply not in the next list. What IS remembered is the KEY of the question last
// shown and the place it held: once that question is gone its old slot is where the entry after it now sits,
// which is how a press lands on the NEXT question instead of starting over.
// One question on one turn is open while its carrier is still there and the gateway is still holding it — the
// same two tests `turnBody` and the card's own chips make, so the rotation can never offer a box that is not drawn.
function humanOpenOnTurn(turn, kind) {
  if (!turn || !turnLive(turn)) return false;
  if (kind === "question") return Boolean(turn.question) && !turn.questionDone && approvalLive(turn.question);
  return Boolean(turn.approval) && !turn.approvalDone && approvalLive(turn.approval);
}

// The name the reader knows an agent by: an assistant's own name, else the card's title, else the label, else the
// thread id. An assistant's job carries the question it is parked on in its prompt, so its card title would name
// what was asked rather than who is asking — `assistantSessionFor` is the one lookup that already knows that name.
function humanAgentName(thread) {
  const session = assistantSessionFor(thread);
  if (session) return session.name || thread;
  const job = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread);
  return (job && (job.title || job.label)) || thread || "the dock";
}

// Every open question, in the order the board shows it: cards that are in the page in DOM order (the unattached
// panel sits above the table, so it comes first), then the cards a folded project hides, newest thread first,
// then the dock's own permission cards, soonest deadline first — the one the gateway refuses soonest is the one
// to answer next. `deadline` is 0 for a question that carries no window; those sort last.
//
// An ASSISTANT's question is one of these. Its turn parks on the reader exactly like a worker's, and the one place
// it was excluded was this list: an assistant's clarify prompt never entered the rotation, so the badge counted one
// waiting question fewer than the board held. Its card lives in the float, which is fixed and has no position on
// the table, so an assistant is deliberately NOT ranked below: it takes its place with the cards a folded project
// hides, newest thread first.
// The identity of one question in the rotation: its kind, the turn it is parked on, and the gateway's own
// request id. That id is not decoration — a turn can carry a second approval after the first is answered, and
// that is a different question with its own place.
//
// It is ALSO the reason asking again cannot become a second row. A re-ask is about the SAME prompt: the turn
// does not change and neither does the request id, so the question keeps one key and the row already in the
// list is the one the count moves on. The count (`reasks`) is deliberately NOT part of the key — a key that
// counted the asks would be a new key every hour, which is exactly the pile-up this exists to prevent.
function humanQuestionKey(kind, turnId, requestId) {
  return `${kind}:${turnId}:${requestId || ""}`;
}

function humanQuestions() {
  const out = [];
  const convs = conversations();
  const rank = new Map(
    [...document.querySelectorAll(".job[data-thread]")]
      .filter((el) => !assistantSessionFor(el.dataset.thread))
      .map((el, i) => [el.dataset.thread, i]),
  );
  const onScreen = convs.filter((c) => rank.has(c.thread)).sort((a, b) => rank.get(a.thread) - rank.get(b.thread));
  const hidden = convs
    .filter((c) => !rank.has(c.thread))
    .sort((a, b) => (Date.parse(b.latest?.startedAt || "") || 0) - (Date.parse(a.latest?.startedAt || "") || 0));
  for (const c of [...onScreen, ...hidden]) {
    for (const t of c.turns) {
      for (const kind of ["approval", "question"]) {
        if (!humanOpenOnTurn(t, kind)) continue;
        const ask = kind === "question" ? t.question : t.approval;
        out.push({
          kind,
          // The request id, not just the turn: a turn can carry a second approval after the first is answered,
          // and that is a different question with its own place in the rotation.
          key: humanQuestionKey(kind, t.id, ask?.requestId),
          // How often the panel has asked again about this same question (`lib/assistant.js` re-asks an hour
          // after it parked, then hourly). It rides on the row for the count; it is not part of the key.
          reasks: Math.max(0, Number(ask?.reasks) || 0),
          thread: c.thread,
          turnId: t.id,
          agent: humanAgentName(c.thread),
          deadline: Number(ask?.deadline) || 0,
        });
      }
    }
  }
  const dock = [
    ...[...state.approvals.values()].filter(approvalLive).map((r) => ({
      kind: "approval",
      dock: true,
      key: `dock:${r.id}`,
      id: r.id,
      thread: r.thread || null,
      agent: approvalAgentName(r),
      deadline: Number(r.deadline) || 0,
    })),
    ...[...state.rwPending.values()].filter(approvalLive).map((r) => ({
      kind: "write",
      dock: true,
      key: `write:${r.id}`,
      id: r.id,
      thread: r.thread || null,
      agent: baseNameOf(r.worktree || "") || r.project || "a worktree",
      deadline: Number(r.deadline) || 0,
    })),
  ].sort((a, b) => (a.deadline > 0 ? a.deadline : Infinity) - (b.deadline > 0 ? b.deadline : Infinity));
  return [...out, ...dock];
}

// The header control: one red count of everything waiting on a human, and a title that splits it. Zero questions
// means no badge at all — a quiet button, not a broken one — and the count is repainted from live state on the
// page's own clock so a deadline that passes cannot leave a number claiming a question that is over.
function paintHumanButton() {
  const btn = $("btn-human");
  if (!btn) return;
  const list = humanQuestions();
  const perms = list.filter((q) => q.kind !== "question").length;
  const asks = list.length - perms;
  // How many of the open questions the panel has already asked again about. Not a second count on the
  // button — the button counts QUESTIONS, and a re-ask never adds one — it is said in the title so a
  // reader who has been away can tell "nobody answered" from "you were asked again and missed it".
  const repeats = list.filter((q) => Number(q.reasks) > 0).length;
  const agents = [...new Set(list.map((q) => q.agent).filter(Boolean))];
  const at = state.human.key ? list.findIndex((q) => q.key === state.human.key) : -1;
  const label = $("human-label");
  const badge = $("human-badge");
  const sig = `${list.length}|${perms}|${asks}|${repeats}|${agents.join(",")}|${at}`;
  if (sig === state.human.sig) return;
  state.human.sig = sig;
  // The label is Title Case with a leading glyph, the way ✧ Assistant is — the button's word is its name, not a
  // shouted tag. The rotation counter keeps the same shape: `🙋 Human 2/3`.
  if (label) label.textContent = at >= 0 ? `🙋 Human ${at + 1}/${list.length}` : "🙋 Human";
  if (badge) {
    badge.hidden = list.length === 0;
    badge.textContent = String(list.length);
  }
  btn.classList.toggle("has-questions", list.length > 0);
  btn.setAttribute(
    "aria-label",
    list.length
      ? `Human — ${list.length} open question${list.length === 1 ? "" : "s"} waiting on you: ${perms} permission${perms === 1 ? "" : "s"}, ${asks} clarify question${asks === 1 ? "" : "s"}${repeats ? `, ${repeats} asked again` : ""}`
      : "Human — nothing is waiting on you",
  );
  const named = agents.length > 4 ? `${agents.slice(0, 4).join(", ")} and ${agents.length - 4} more` : agents.join(", ");
  btn.title = list.length
    ? `Human — ${list.length} open question${list.length === 1 ? "" : "s"} waiting on you: ${perms} permission${perms === 1 ? "" : "s"}, ${asks} clarify question${asks === 1 ? "" : "s"}${named ? ` — held by ${named}` : ""}${repeats ? `. ${repeats} of them the panel has already asked again about (once an hour, on its own clock)` : ""}. Click or press H to step through them: each agent is opened, its prompt centred and flashed red, and its answer control focused. A question that is answered, expires or whose turn ends drops out.`
    : "Human — nothing is waiting on you: no permission or clarify question is open on this board. Click or press H to check again.";
}

// Open exactly the path to one question and put it in front of the reader. A board question: its project and row
// open, its card unfolded. An assistant's question: the float open, that assistant's own Chat tab on screen. Both:
// the turn that owns the question unfolded AND paged in (a question can live on a turn that is folded, or on a turn
// the pager is not currently showing). Then, one landing step for both, the prompt centred, flashed and its control
// focused. Returns false when the question can no longer be drawn — the caller steps on instead of opening a dead
// agent.
function humanShow(q) {
  if (q.dock) return humanShowDock(q);
  const conv = conversations().find((c) => c.thread === q.thread);
  if (!conv) return false;
  const turn = conv.turns.find((t) => t.id === q.turnId);
  if (!turn || !humanOpenOnTurn(turn, q.kind)) return false;
  // The turn that owns the question, unfolded, un-frozen and paged in — one call, because the float draws its card
  // with `conversationHtml` too and reads exactly this state: one idea of "this turn is the one".
  wtTurnFold.reveal(state, q.thread, conv.turns, turn.id);
  const assistant = assistantSessionFor(q.thread);
  let card;
  if (assistant) {
    // An assistant's card is not on the board at all: it lives in the float, one session tab and one Chat pane per
    // assistant. So the path there is open the float, put THIS assistant's Chat on screen, and let the float's own
    // renderer draw the card from the fold state just written. A thread whose session record is missing has no pane
    // to put on screen, and false here is what makes the rotation step on rather than flash a box nobody can see.
    if (typeof window.__assistantShowThread !== "function" || !window.__assistantShowThread(q.thread)) return false;
    renderConversation(q.thread);
    card = document.querySelector(`.job[data-thread="${CSS.escape(q.thread)}"]`);
  } else {
    // The project and the row first: a card inside a closed row is not on the page at all, and after Collapse all
    // the project is only open in state while its folder is still shut. hotOpenPath is HUMAN's own opener, so the
    // rotation and the board cannot drift into two ideas of "open".
    const row = hotRowFor(q.thread);
    if (row) hotOpenPath(row);
    if (state.collapsedJobs.has(q.thread)) state.collapsedJobs.delete(q.thread);
    renderConversation(q.thread);
    card = document.querySelector(`.job[data-thread="${CSS.escape(q.thread)}"]`);
    if (!card) {
      // An unattached card that no render has placed yet: #jobs is the panel's own renderer for that set.
      renderJobs();
      card = document.querySelector(`.job[data-thread="${CSS.escape(q.thread)}"]`);
    }
  }
  if (!card) return false;
  return humanLandOnQuestion(card, q);
}

// The last step of every show path, board or float: find the box that carries the question on the card holding it,
// and put it in front of the reader — centred, ringed, with the caret on the answer control. ONE implementation on
// purpose: an assistant's card is drawn by the same renderer as a board card, and a second finder or a second
// focus path would be a second idea of which box a question is.
function humanLandOnQuestion(card, q) {
  const turnEl = card.querySelector(`.turn[data-turn="${CSS.escape(q.turnId)}"]`);
  const box = turnEl?.querySelector(q.kind === "question" ? ".turn-question" : ".turn-approval");
  // The gate again, on the DOM this time: the box is drawn only while its turn is live and its carrier is open,
  // and a question that closed between the sample and this paint has no box to show.
  if (!box || box.classList.contains("is-expired")) return false;
  // The card wears HUMAN's amber ring (state-held, so a repaint keeps it), and the prompt
  // itself gets a red ring: this is a question, and the box is what the reader was brought here to read. ONE box
  // carries it: a ring left on the previous prompt would say two questions are current, and every reader of the
  // class (this page, the gate) counts exactly one.
  flashHotCard(q.thread);
  for (const el of document.querySelectorAll(".human-flash")) el.classList.remove("human-flash");
  // The PROMPT, not the card: centring the card left the question under the fold, and the console above it is
  // what the reader reads first. programmaticScroll keeps the panel's scroll-follow from reading this as the
  // reader taking over. Inside the float this scrolls the float's own chat body and never the page, which is
  // fixed under it.
  programmaticScroll();
  box.scrollIntoView({ block: "center", behavior: "smooth" });
  box.classList.remove("human-flash");
  void box.offsetWidth; // restart the ring on every hop, even while the last one is still fading
  box.classList.add("human-flash");
  clearTimeout(state.humanFlashTimer);
  state.humanFlashTimer = setTimeout(() => {
    for (const el of document.querySelectorAll(".human-flash")) el.classList.remove("human-flash");
  }, 1900);
  // The control the reader would reach for. A permission box gets its DENY focused on purpose: the panel answers
  // approvals on pointerup, so a stray key cannot approve a command, and the fail-closed choice is the safe one
  // to leave under the caret. A clarify question gets its first choice (or its typed box when it has none).
  humanFocusNow(box, q.kind);
  // A row that is opening (or a float being brought to the front) renders its detail a moment after the press, and
  // that repaint replaces this box: the target is held for a beat and put back by the next render of this thread
  // (humanRefocus, and the 250 ms humanTick that covers a float repaint) the same way the spawn's caret is. Scoped
  // to this one thread and only while nothing else holds the caret.
  state.humanFocus = { thread: q.thread, turnId: q.turnId, kind: q.kind, until: Date.now() + 1500 };
  return true;
}

// Put the caret on a prompt's answer control, and say which one: the one place a permission box and a clarify box
// agree on where the reader starts.
function humanFocusNow(box, kind) {
  const control =
    kind === "question"
      ? box.querySelector("input[data-qpick], button.tq-choice, textarea.tq-other, button.tq-send")
      : box.querySelector('[data-choice="deny"]') || box.querySelector("[data-choice]");
  if (!control) return false;
  try {
    control.focus({ preventScroll: true });
  } catch {
    control.focus();
  }
  return document.activeElement === control;
}

// After a repaint of the thread the rotation just landed on: put the red ring and the caret back, but never take
// the caret from the reader (a click, a typed reply or another control all own it from that point).
function humanRefocus(thread) {
  const want = state.humanFocus;
  if (!want || want.thread !== thread || Date.now() > want.until) return;
  const box = document.querySelector(
    `.job[data-thread="${CSS.escape(thread)}"] .turn[data-turn="${CSS.escape(want.turnId)}"] ${want.kind === "question" ? ".turn-question" : ".turn-approval"}`,
  );
  if (!box) return;
  box.classList.add("human-flash");
  if (!document.activeElement || document.activeElement === document.body) humanFocusNow(box, want.kind);
}

// …and the same put-back on a short clock, because a card can be redrawn by the ROW renderer too (opening a row,
// a reorder, a project repaint), and none of those go through renderConversation. Scoped to the one prompt the
// rotation last landed on and to the beat it asked for; the first pointerdown or keystroke ends it, so the page
// never fights the reader for the caret.
function humanTick() {
  const want = state.humanFocus;
  if (!want) return;
  if (Date.now() > want.until) {
    state.humanFocus = null;
    return;
  }
  const box = document.querySelector(
    `.job[data-thread="${CSS.escape(want.thread)}"] .turn[data-turn="${CSS.escape(want.turnId)}"] ${want.kind === "question" ? ".turn-question" : ".turn-approval"}`,
  );
  if (!box) return;
  if (!box.classList.contains("human-flash")) box.classList.add("human-flash");
  if (!document.activeElement || document.activeElement === document.body) humanFocusNow(box, want.kind);
}
setInterval(humanTick, 250);
document.addEventListener("pointerdown", () => (state.humanFocus = null), { capture: true, passive: true });
document.addEventListener("keydown", () => (state.humanFocus = null), { capture: true });

// One of the dock's own permission cards: unfold the dock, then scroll and flash the card itself. The dock is
// fixed, so scrollIntoView only moves its own list — which is exactly what the dock's own jump does.
function humanShowDock(q) {
  const dock = $("approvals");
  if (!dock) return false;
  state.humanFocus = null; // a dock card is not a thread: nothing to restore on a card's repaint
  try {
    localStorage.setItem(APPROVALS_FOLDED_KEY, "0");
  } catch {
    /* the unfurl still happens */
  }
  applyApprovalsFold(dock);
  const sel =
    q.kind === "write"
      ? `.turn-approval[data-remote-write="${CSS.escape(q.id)}"]`
      : `.approval[data-approval="${CSS.escape(q.id)}"]`;
  const card = dock.querySelector(sel);
  if (!card) return false;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  for (const el of document.querySelectorAll(".human-flash")) el.classList.remove("human-flash");
  void card.offsetWidth;
  card.classList.add("human-flash");
  clearTimeout(state.humanFlashTimer);
  state.humanFlashTimer = setTimeout(() => {
    for (const el of document.querySelectorAll(".human-flash")) el.classList.remove("human-flash");
  }, 1900);
  const control = card.querySelector('[data-approval-choice="deny"]') || card.querySelector("[data-approval-choice]") || card.querySelector('[data-choice="deny"]') || card.querySelector("[data-choice]");
  if (control) {
    try {
      control.focus({ preventScroll: true });
    } catch {
      control.focus();
    }
  }
  return true;
}

// One press: the next open question, wrapping past the last one. The list is sampled here and NOT kept; only the
// chosen key and its place are, so the next press knows where to continue from even if this question has gone.
function humanStep() {
  const list = humanQuestions();
  const last = state.human.key;
  if (!list.length) {
    state.human.key = null;
    state.human.at = -1;
    state.human.sig = "";
    paintHumanButton();
    showBanner("Human: nothing is waiting on you — no permission or clarify question is open");
    return;
  }
  // Where to look: after the question last shown; if that one has gone, the slot it held (the entry that took
  // its place), or the first when it was the last of the list.
  const at = last ? list.findIndex((q) => q.key === last) : -1;
  const from = at >= 0 ? (at + 1) % list.length : last ? (state.human.at >= list.length ? 0 : Math.max(0, state.human.at)) : 0;
  for (let n = 0; n < list.length; n++) {
    const i = (from + n) % list.length;
    if (!humanShow(list[i])) continue; // it closed between the sample and the paint: step on
    state.human.key = list[i].key;
    state.human.at = i;
    state.human.sig = "";
    paintHumanButton();
    return;
  }
  state.human.key = null;
  state.human.at = -1;
  state.human.sig = "";
  paintHumanButton();
  showBanner("Human: those questions closed before I could open one — nothing is waiting on you now");
}

$("btn-human")?.addEventListener("click", (e) => {
  e.stopPropagation();
  humanStep();
});

// H is the rotation's key, and a reader in ANY text field owns that keystroke: an `h` typed into a reply box, a
// Settings search, an answer box or a contenteditable must not jump the page. Skipped, never swallowed.
function humanTextEntry(el) {
  if (!el) return false;
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) return true;
  return Boolean(el.closest?.('[contenteditable]:not([contenteditable="false"])'));
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== "h" && e.key !== "H") return;
  if (e.repeat) return; // holding the key must not race through the whole rotation
  if (humanTextEntry(document.activeElement)) return;
  e.preventDefault();
  humanStep();
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

// ---- deliverables wiring: the page's half, which calls public/deliverables.js -------------------------
// The list's own code was cut out of this file into public/deliverables.js in step 3 of
// docs/reports/module-map-2026-11-07.html's order of work. What stays here is the wiring that has to run at THIS
// file's own load, after `state` and `apiFetch` exist: the header button's press (and the `data-wired` mark the
// shell's stale-page guard reads), the first quiet read that paints the badge, the retry hookup that attaches the
// stream listener, the interval, and the three listeners that close or place the popover. They call the module's
// functions by bare name, because public/deliverables.js is a classic script the shell loads before this one.

const deliverBtn = $("btn-deliver");
deliverBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  // The badge is the SECOND door to the same watermark: a press on the number records what the page has shown
  // WITHOUT opening the list, and the button's own toggle never fires. It is a span inside the header button on
  // purpose, and the press is delegated here rather than bound to the node because the node exists only while
  // something is unseen (paintDeliverBadge creates and removes it).
  if (e.target.closest?.("#deliver-badge")) {
    e.preventDefault();
    void deliverMarkSeen();
    return;
  }
  try {
    toggleDeliverPop();
  } catch (err) {
    // The button is here but the list could not be built. On a page whose app.js is older than the shell that is the
    // old page meeting a new API, and a silent no-op is the one outcome a control must never have: say which build
    // is running and let the shell's stale-build guard offer the reload (index.html).
    const why = String((err && err.message) || err);
    console.error(`[panel] DELIVERABLES could not open on this page: ${why}`);
    window.__panelStaleBuild?.report?.(`Opening the list threw: ${why}.`);
  }
});
// Read at click time by the shell's stale-page guard: it is how a page knows this build's app.js reached the button.
if (deliverBtn) deliverBtn.dataset.wired = "1";

// The count has to be right before the first click, and a delivery has to reach a page whose list is SHUT. One quiet
// read paints it at load, the stream's `deliverable` frame keeps it live, and a slow poll covers a tab whose stream is
// reconnecting (or a panel that reconnected it, which replaces state.es). A hidden tab polls nothing — a background
// board is not an inbox. The stream is connected by app.js's boot(), after its first await, so the hook is attached
// here as one at load and retried for five seconds rather than assuming it already exists.
(function deliverHookup(attempt = 0) {
  deliverHookStream();
  if (!state.es?.__deliverableHook && attempt < 10) setTimeout(() => deliverHookup(attempt + 1), 500);
})();
paintDeliverBadge(); // the label a screen reader reads before the first response lands
void deliverFetch({ quiet: true });
setInterval(deliverPollTick, DELIVER_POLL_MS);

// A second press of the button, an outside click, Esc, or a press of D closes it. mousedown, not click: the
// reader's next click lands where they aimed, not on the popover that was covering it.
document.addEventListener("mousedown", (e) => {
  if (!deliver.open) return;
  if (deliver.el?.contains(e.target)) return;
  if (e.target.closest?.("#btn-deliver")) return; // the button's own click toggles
  closeDeliverPop();
});

// Esc clears the filter if it has text, then closes and puts the reader back on the button.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !deliver.open) return;
  const filter = $("dl-filter");
  if (filter && filter.value) {
    e.preventDefault();
    filter.value = "";
    deliver.filter = "";
    deliver.active = 0;
    paintDeliverRows();
    filter.focus({ preventScroll: true });
    return;
  }
  e.preventDefault();
  closeDeliverPop({ focus: true });
});

// D is the list's key. It copies HUMAN's guard exactly — no modifiers, no e.repeat (holding the key must not
// race the toggle), and a caret in ANY text field owns the keystroke, so a `d` typed into a reply box, a
// Settings search or an answer box never jumps the page.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== "d" && e.key !== "D") return;
  if (e.repeat) return;
  if (humanTextEntry(document.activeElement)) return;
  e.preventDefault();
  toggleDeliverPop();
});

window.addEventListener("resize", deliverPosition);
// ---- end deliverables wiring

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

// ---- text styles: thinking, skill output, console -------------------------------------------------
// Three kinds of console text (Settings > Display): the agent's REASONING, what a SKILL prints (the result of
// skill_view / skills_list / skill_manage, inside its output box), and the rest of the console's own words and tool
// output. Each has its own COLOUR — reasoning is how the agent got there, a skill is a document the reader reads
// rather than scans — but there is only ONE size: the console's, `--term-size`, which normal output, a tool's output
// and the reasoning all resolve to. Ctrl+wheel writes that same variable on a card, so a zoom moves all three
// together, and there is no second knob here that could drift away from it.
//
// Each colour is a CSS variable on :root that the stylesheet reads WITH a fallback to today's look, so an unset style
// costs nothing and "use defaults" is removing the property, not writing the old value back (reasoning has two defaults
// — dim in the 🧠 block, lavender in the 🌊 stream — and a stored copy of either would flatten the other). The console's
// size is not here either: it is the existing Console size (--term-size, applyTermStyle), which this row now owns.
const TEXT_STYLES = {
  think: { colorKey: "wtgui.thinkColor", colorVar: "--think-color", color: "think-color", state: "think-color-state", fallback: "#b3a8cc" },
  skill: { colorKey: "wtgui.skillColor", sizeKey: "wtgui.skillSize", colorVar: "--skill-color", sizeVar: "--skill-font-size", color: "skill-color", state: "skill-color-state", size: "skill-size-select", fallback: "#9aa4b2" },
  console: { colorKey: "wtgui.consoleColor", colorVar: "--con-color", color: "console-color", state: "console-color-state", fallback: "#e6e9ef" },
};
const TEXT_COLOR_RE = /^#[0-9a-f]{6}$/;
// The Thinking text row carried a size of its own until the console's text was unified. Its stored value is retired
// rather than left in the browser pretending to apply: reasoning now reads the console size, and a key nothing reads
// is how "why is my reasoning still 14px?" gets asked six months from now.
function retireTextStyleSize(kind) {
  const set = TEXT_STYLES[kind];
  if (!set || set.sizeKey) return;
  try {
    localStorage.removeItem(`wtgui.${kind}Size`);
  } catch {
    /* private mode: there was nothing to retire */
  }
}

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

// ---- settings tabs ---------------------------------------------------------------------------------------
// Eight groups of rows is a tall panel, and the reader is nearly always here for one of them. Each group is a
// tab now, keyed by `data-settings-group` and drawn in the order the markup carries them: one panel is on
// screen at a time, and the tab the reader chose is remembered in this browser (Display is a first visit's).
// The strip is the panel's heading, so the panels carry no heading of their own — `aria-labelledby` points each
// one at its tab, and the tab carries the tooltip that used to sit on the group's <h3>.
//
// The older fold stores are deliberately neither read nor rewritten, the way each earlier one was left inert:
// `wtgui.settingsFolded` and `wtgui.settingsUnfolded` record which GROUPS were open, which is not a tab. Reading
// either as one would land the reader on whichever group they happened to open last, and rewriting it would turn
// their own saved choice into its reverse. Both stay where they are, unused.
const SETTINGS_TAB_KEY = "wtgui.settingsTab";
const SETTINGS_TABS_ID = "settings-tabs";

function settingsTabButtons() {
  return [...document.querySelectorAll(`#${SETTINGS_TABS_ID} [role="tab"]`)];
}

// The panels in the order the markup gives them — the same order the strip is in, so the key is the whole link
// between a tab and the panel it shows.
function settingsTabPanels() {
  return [...document.querySelectorAll("#settings .settings-group[data-settings-group]")];
}

// The reader's tab, or the first one: a stored key that no longer names a panel (a tab renamed or removed) must
// not leave the window with nothing on screen.
function settingsTabKey() {
  const keys = settingsTabPanels().map((panel) => panel.dataset.settingsGroup);
  try {
    const raw = localStorage.getItem(SETTINGS_TAB_KEY);
    // A tab RENAMED keeps the reader on it: "Branches" became "Repo" in this build, and falling back to Display
    // for a key that still names the same panel would read as a forgotten choice. The old key is not rewritten
    // here; the next select writes the new one.
    const wanted = raw === "branches" && keys.includes("repo") ? "repo" : raw;
    if (wanted && keys.includes(wanted)) return wanted;
  } catch {
    /* private mode */
  }
  return keys[0] || null;
}

function saveSettingsTab(key) {
  try {
    localStorage.setItem(SETTINGS_TAB_KEY, key);
  } catch {
    /* private mode: the tab just will not persist */
  }
}

// One painter for both halves of the fact — which tab is selected and which panel is on screen — because they
// are one fact. The roving tabindex makes the strip a single Tab stop: the selected tab is the reachable one,
// and the arrows inside the strip move the selection.
function paintSettingsTab(key, { save = true, focus = false, scroll = false } = {}) {
  const tabs = settingsTabButtons();
  const chosen = tabs.some((tab) => tab.dataset.settingsTab === key) ? key : tabs[0]?.dataset.settingsTab;
  if (!chosen) return;
  for (const tab of tabs) {
    const on = tab.dataset.settingsTab === chosen;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of settingsTabPanels()) panel.hidden = panel.dataset.settingsGroup !== chosen;
  if (save) saveSettingsTab(chosen);
  if (focus) tabs.find((tab) => tab.dataset.settingsTab === chosen)?.focus();
  // Opening a tab starts it at its own top, not wherever the last one was scrolled to.
  if (scroll) {
    const body = document.querySelector("#settings .settings-body");
    if (body) body.scrollTop = 0;
  }
}

function selectSettingsTab(key) {
  paintSettingsTab(key, { save: true, scroll: true });
  // The Bundles tab is a read of the bundle file and every assistant's queue, so it is refreshed when the reader asks
  // for it — not on every repaint of the settings window. A tab the reader leaves and comes back to asks again only
  // when the answer is old; a press on its own re-read row asks at once (initBundlesPanel).
  if (key === "bundles" && Date.now() - bundlesLoadedAt > 15000) void loadBundles();
  // The Pipeline tab draws the PDL bundle beside the ladder, so it is a read of a file another tab writes: a press on
  // it asks again once the answer is old, the same rule the Bundles tab follows, and an import clears its stamp.
  if (key === "pipeline" && Date.now() - pipelinesLoadedAt > 15000) void loadPipelines();
  // The release notes are a file read on the server too. A tab the reader comes back to re-asks when the answer
  // is old; the first answer is fetched at boot, beside the other tabs' reads, so the search sees its rows.
  if (key === "updates" && Date.now() - changelogLoadedAt > 15000) void loadChangelog();
}

// The per-tab counts the search hands over: a badge on the tab's chrome, and the same number in the tab's own
// name for a screen reader (the badge itself is decoration, so it is not read twice).
function paintSettingsTabCounts(counts, query) {
  for (const tab of settingsTabButtons()) {
    const n = counts.get(tab.dataset.settingsTab) || 0;
    const badge = tab.querySelector(".settings-tab-count");
    if (badge) {
      badge.textContent = String(n);
      badge.hidden = !query;
    }
    const label = tab.querySelector(".settings-tab-label");
    if (query) {
      const name = `${label ? label.textContent : tab.dataset.settingsTab} — ${n ? `${n} match${n === 1 ? "" : "es"}` : "no matches"}`;
      tab.setAttribute("aria-label", name);
    } else {
      tab.removeAttribute("aria-label");
    }
  }
}

// The WAI-ARIA tabs pattern's keys: Left/Right wrap around the strip, Home/End take the ends, and Enter/Space
// select the tab that has the focus (the arrows already selected it; this is for the reader who Tabbed to the
// strip and pressed Enter). Space would scroll the panel, so it is swallowed.
function initSettingsTabs() {
  const strip = document.getElementById(SETTINGS_TABS_ID);
  const tabs = settingsTabButtons();
  if (!strip || !tabs.length) return;
  paintSettingsTab(settingsTabKey(), { save: false });
  const at = (key) => tabs.findIndex((tab) => tab.dataset.settingsTab === key);
  strip.addEventListener("click", (e) => {
    const tab = e.target.closest("[role='tab']");
    if (tab) selectSettingsTab(tab.dataset.settingsTab);
  });
  strip.addEventListener("keydown", (e) => {
    const tab = e.target.closest("[role='tab']");
    if (!tab) return;
    const last = tabs.length - 1;
    const here = at(tab.dataset.settingsTab);
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(here + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(here - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[last];
    else if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      selectSettingsTab(tab.dataset.settingsTab);
      return;
    }
    if (!next) return;
    e.preventDefault();
    paintSettingsTab(next.dataset.settingsTab, { save: true, focus: true, scroll: true });
  });
}

// ---- end settings tabs

// ---- settings > updates: the release notes ----------------------------------------------------------------
// The tab answers "what changed since the build I am running?" from the checkout's own CHANGELOG.md, read
// through GET /api/changelog. The newest release is open with its bullets, the ones below it fold, and the
// version the panel serves is marked so the reader can see where they are in the list. The answer carries its
// own state — ok / empty / missing — and the last two are SAID in as many words: a file with no release
// headings and no file at all are different things to a reader, and neither one is a blank box.
//
// A refresh that FAILS is a notice at the top of that list, not a replacement for it: `changelogIndex` keeps the
// last good answer, and a later fetch that throws re-paints it under the red line. Losing the sections because a
// second read failed is the same blank box by another route - the reader had the list a moment ago.
const RELEASE_NOTES_ID = "release-notes";
const RELEASE_NOTES_SOURCE_ID = "release-notes-source";
const RELEASE_NOTES_ROW_ID = "release-notes-row";
let changelogIndex = null;
let changelogLoadedAt = 0;
let changelogLoading = null;

function changelogWhen(mtime) {
  const at = new Date(mtime);
  if (!mtime || Number.isNaN(at.getTime())) return "mtime unknown";
  return at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function changelogBytes(size) {
  return `${Number(size || 0).toLocaleString()} bytes`;
}

// One release: the summary IS the heading (version, date, commit count), so the folded state already answers
// the three facts a reader scans for; the body is the bullets the changelog groups them under.
function releaseNotesSectionHtml(section, serving, index) {
  const version = String(section.version || "");
  const commits = Number(section.commits) || 0;
  const count = `${commits} commit${commits === 1 ? "" : "s"}`;
  const servingHere = serving && version === String(serving);
  const body = (Array.isArray(section.lines) ? section.lines : [])
    .map((line) =>
      line.startsWith("### ")
        ? `<div class="release-group">${esc(line.slice(4))}</div>`
        : `<div class="release-bullet">${esc(line.replace(/^-\s+/, ""))}</div>`,
    )
    .join("");
  return (
    `<details class="release" data-release-version="${esc(version)}"${index === 0 ? " open" : ""}>` +
    `<summary class="release-head" title="${esc(`v${version} · ${section.date} · ${count}${servingHere ? " · the version this panel serves" : ""}`)}">` +
    `<span class="release-version mono">v${esc(version)}</span>` +
    `<span class="release-date mono">${esc(String(section.date || ""))}</span>` +
    `<span class="release-commits mono">${esc(count)}</span>` +
    (servingHere ? `<span class="release-mark">serving</span>` : "") +
    `</summary>` +
    `<div class="release-body">${body || `<div class="release-bullet">this release carries no grouped commits</div>`}</div>` +
    `</details>`
  );
}

// The list as the last good answer painted it: the sections, or the one line that says why there is no list (a
// missing file, no headings, an answer with no releases). Extracted because a FAILED refresh re-paints this under
// its notice: the two paths have to agree on what "the list" is, or a failure would quietly change it.
function releaseNotesList(data) {
  if (!data) return null;
  const file = data.file || "CHANGELOG.md";
  const where = data.path || file;
  if (data.state === "missing") {
    return {
      html: `<div class="release-state bad">${esc(`${file} is missing — there is no file at the panel root (${where}). The panel is serving v${data.serving || "unknown"}; no release notes are on disk.`)}</div>`,
      line: `${file} · not on disk`,
      title: where,
    };
  }
  if (data.state === "empty") {
    return {
      html: `<div class="release-state">${esc(`${file} is present (${changelogBytes(data.size)}, modified ${changelogWhen(data.mtime)}) but carries no "## vX.Y.Z — date · N commits" heading — there is nothing to list. The panel is serving v${data.serving || "unknown"}.`)}</div>`,
      line: `${file} · modified ${changelogWhen(data.mtime)} · ${changelogBytes(data.size)}`,
      title: where,
    };
  }
  if (data.state !== "ok" || !Array.isArray(data.sections) || !data.sections.length) {
    return {
      html: `<div class="release-state bad">${esc(data.reason || `the panel answered ${file} with no releases and no reason`)}</div>`,
      line: `${file} · no releases`,
      title: where,
    };
  }
  return {
    html: data.sections.map((section, i) => releaseNotesSectionHtml(section, data.serving, i)).join(""),
    line: `${file} · modified ${changelogWhen(data.mtime)} · ${changelogBytes(data.size)}`,
    title: where,
  };
}

function paintChangelog(error = null) {
  const list = document.getElementById(RELEASE_NOTES_ID);
  const source = document.getElementById(RELEASE_NOTES_SOURCE_ID);
  const row = document.getElementById(RELEASE_NOTES_ROW_ID);
  if (!list) return;
  const say = (html, line, title) => {
    list.innerHTML = html;
    if (source) {
      source.textContent = line;
      source.title = title || line;
    }
    if (row) row.classList.remove("search-hidden");
  };
  const held = releaseNotesList(changelogIndex);
  if (error) {
    const notice = `<div class="release-state bad">${esc(`the panel could not answer for CHANGELOG.md — ${error}`)}</div>`;
    // A failed refresh is news ABOUT the list, never a replacement for it: the notice goes at the top and every
    // section the last good read painted stays under it. Only a failure with nothing rendered yet is a lone notice.
    if (!held) return say(notice, "CHANGELOG.md · not read");
    return say(`${notice}${held.html}`, `${held.line} · refresh failed`, held.title);
  }
  if (!held) {
    return say(
      `<div class="release-state bad">${esc("the panel has not answered for CHANGELOG.md yet")}</div>`,
      "CHANGELOG.md · not read",
    );
  }
  return say(held.html, held.line, held.title);
}

async function loadChangelog() {
  if (changelogLoading) return changelogLoading;
  changelogLoading = (async () => {
    try {
      const r = await apiFetch("/api/changelog");
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      changelogIndex = data;
      changelogLoadedAt = Date.now();
      paintChangelog();
    } catch (e) {
      paintChangelog(e.message || String(e));
    } finally {
      changelogLoading = null;
    }
  })();
  return changelogLoading;
}

// ---- end settings > updates

// ---- settings search -------------------------------------------------------------------------------------
// The panel is a long list of rows spread over eight tabs, so the way to a setting is the search box the panel's
// fixed head keeps on screen. What it searches is the row itself: its text, its own `title`, and the `title` of
// any control inside it (`zoom out` lives only in a button's tooltip, and it is exactly the word a reader would
// try). A row that does not answer goes away, in every tab — the search is GLOBAL, not a filter on the tab the
// reader happens to be looking at: each tab carries the count of rows that answer it, and the first tab that
// answers is the one shown, so a match in a tab nobody selected is still revealed. The reader's own tab is never
// written by the search, so clearing the box goes back to it exactly as they left it.
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

// One flat stretch of a panel: a row answers or it does not, and a preview strip (or a preset row) belongs to the
// row above it. Extracted so a panel with its own grouping can hand its rows through the same rule.
function paintSettingsRows(nodes, query, matched) {
  let hits = 0;
  let follows = true;
  for (const child of nodes) {
    if (child.classList && child.classList.contains("settings-row")) {
      const hit = !query || settingsRowText(child).includes(query);
      child.classList.toggle("search-hidden", !hit);
      follows = hit;
      if (hit) {
        hits += 1;
        if (query) matched.push(child);
      }
    } else if (child.classList) {
      child.classList.toggle("search-hidden", Boolean(query) && !follows);
    }
  }
  return hits;
}

function paintSettingsSearch() {
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  const query = String((box && box.value) || "").trim().toLowerCase();
  const matched = [];
  const counts = new Map(); // per tab key: how many of ITS rows answer — the global answer, tab by tab
  for (const panel of settingsTabPanels()) {
    // The Skills panel is grouped two levels deep and paints its own rows (and its own heading counts); every other
    // tab is the flat list this loop has always walked. Either way the count is the rows that answer, per tab.
    // The key is written as a string rather than SKILLS_PANEL_ID because test/settings-tabs.test.js slices THIS
    // region out of app.js and runs it without the Skills tab's constants: a bare identifier here is a
    // ReferenceError in that harness, not a wrong answer.
    const hits =
      panel.dataset.settingsGroup === "skills"
        ? paintSkillsSearch(query, matched)
        : panel.dataset.settingsGroup === "permissions"
          ? paintPermissionsSearch(query, matched)
          : panel.dataset.settingsGroup === "pipeline"
            ? paintPipelineSearch(query, matched)
            : panel.dataset.settingsGroup === "bundles"
              ? paintBundlesSearch(query, matched)
              : paintSettingsRows([...panel.children], query, matched);
    counts.set(panel.dataset.settingsGroup, hits);
  }
  paintSettingsTabCounts(counts, query);
  // A match in a tab the reader is not looking at is revealed: the first tab that answers is the one shown while
  // the query is on, and the reader's own tab — never written by the search — comes back when the box clears.
  const active = settingsTabButtons().find((tab) => tab.getAttribute("aria-selected") === "true");
  const first = [...counts].find(([, n]) => n > 0)?.[0] || null;
  if (!query) paintSettingsTab(settingsTabKey(), { save: false });
  else if (first && (!active || !(counts.get(active.dataset.settingsTab) > 0))) {
    paintSettingsTab(first, { save: false });
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

// ---- the Skills tab -------------------------------------------------------------------------------------
// What an agent started from this panel can actually load, and where each of those skills came from. This tab is an
// INVENTORY, so every row is read-only — there is no switch, no editor and no delete, because a skill is a file in
// somebody's repository and a settings window is the wrong place to rewrite one. The shape is the answer to five
// facts that were each a trap:
//
//   * a skill has FOUR fields a reader needs and one of them is not a word: name, description, category, and the
//     PATH it was read from — the path is how "same name, different file" is settled by hand. The path is DRAWN
//     relative to the source that holds it (the base the heading above prints) and the whole absolute path rides in
//     the row's tooltip, so a long row reads as a skill instead of as a drive letter.
//   * a junctioned directory (`%LOCALAPPDATA%\hermes\skills\sefl` -> the team's own repo) is its OWN source. A
//     naive walk lists those skills under the profile as well, with nothing to say which copy a row is, so the
//     server hands over a source per link — with the target — and dedupes by realpath. The row says `link` when
//     the file it read was reached through one.
//   * the disk is only half the truth: the gateway's `GET /v1/skills` is what a run is actually SERVED (shadowing,
//     disabled names and platform gates resolved). A row the gateway does not serve says so; a name it serves that
//     no root carries — a plugin's `plugin:skill` — is its own row under Gateway; and a gateway that cannot answer
//     leaves every row UNKNOWN — one banner says why, and each row carries a quiet mark instead of the same word
//     stamped onto every skill in the list.
//   * the list has TWO levels of grouping — the source it was read from, then the category the skill's own
//     directory gives it — because that is the tree on disk and a flat list of ninety rows hides it. Both levels
//     fold, the count on every heading is the number of rows under it, and the fold the reader chooses is
//     remembered in this browser under `wtgui.skillsGroups`. A source starts OPEN; its categories start open only
//     while the source has six or fewer of them, so a team repo's twenty-five categories arrive folded.
//   * the settings search is global and it filters the DIRECT CHILDREN of a panel. A grouped list therefore paints
//     its own filter (`paintSkillsSearch`) and hands the same per-tab count back: a category that answers nothing
//     and a source that answers nothing are hidden, every heading's count is repainted against the filtered set,
//     and a group that DOES answer is opened for the duration of the query — a match must never be hidden behind a
//     fold the reader closed earlier.
const SKILLS_PANEL_ID = "settings-panel-skills";
const SKILLS_GROUPS_KEY = "wtgui.skillsGroups";
// A source with more category groups than this starts with them CLOSED: a 25-category team repo is a wall of rows
// to scroll past before the next source, while six still reads as one screen.
const SKILLS_OPEN_CATEGORIES = 6;
const SKILLS_KIND_LABEL = {
  profile: "profile",
  link: "link",
  "create-dir": "create dir",
  external: "external",
  project: "project",
  gateway: "gateway",
};

let skillsIndex = null;
let skillsLoadedAt = 0;
let skillsLoading = null;

const skillsKind = (source) => SKILLS_KIND_LABEL[source.kind] || source.kind || "root";
const skillsMany = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- the fold state: one record in this browser, per source and per category ------------------------------
// `{ "<source key>": { open, cats: { "<category or empty>": open } } }`. A key that is absent means the reader
// never decided it, so the defaults below answer — a skill added tomorrow opens or closes with its own source
// instead of being stranded in whatever the last read happened to hold. A storage that cannot be read (private
// mode, a value written by an older build) is an empty record, never a crash.
function readSkillsFolds() {
  try {
    const raw = localStorage.getItem(SKILLS_GROUPS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSkillsFolds(folds) {
  try {
    localStorage.setItem(SKILLS_GROUPS_KEY, JSON.stringify(folds));
  } catch {
    /* private mode: the fold just will not persist */
  }
}

const skillsFoldRecord = (folds, key) => (folds[key] && typeof folds[key] === "object" ? folds[key] : null);

// A source starts OPEN — it is the top level, and a reader looking for a source wants to see what it holds.
function skillsSourceOpen(folds, key) {
  const rec = skillsFoldRecord(folds, key);
  return !rec || rec.open !== false;
}

// Six or fewer category groups → open; more → closed. `count` is the number of groups the source will DRAW (the
// uncategorised bucket is one of them), because the threshold is about how much fits on a screen, not about how
// the directories happen to be named.
function skillsCategoryOpen(folds, key, category, count) {
  const rec = skillsFoldRecord(folds, key);
  const chosen = rec && rec.cats ? rec.cats[category || ""] : undefined;
  if (typeof chosen === "boolean") return chosen;
  return count <= SKILLS_OPEN_CATEGORIES;
}

function setSkillsFold(folds, key, category, open) {
  const rec = { ...(skillsFoldRecord(folds, key) || {}) };
  if (category === null) rec.open = open;
  else rec.cats = { ...(rec.cats || {}), [category]: open };
  folds[key] = rec;
  saveSkillsFolds(folds);
}

const skillsFoldTitle = (open, label) => `${open ? "collapse" : "expand"} ${label}`;

// ---- grouping -------------------------------------------------------------------------------------------
// The rows of one source, split by the category their own directory gives them ("" is the bucket for skills that
// sit at the top of the source; a gateway row keeps whatever category the gateway answered). The uncategorised
// bucket comes first, then categories A→Z case-insensitively, and each bucket is name-sorted the same way, so the
// same disk always reads the same list.
function skillsByName(rows) {
  return [...rows].sort(
    (a, b) =>
      String(a.name || "").toLowerCase().localeCompare(String(b.name || "").toLowerCase()) ||
      String(a.name || "").localeCompare(String(b.name || "")),
  );
}

function skillsCategories(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = row.category || "";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === "" || b === "") return a === b ? 0 : a === "" ? -1 : 1;
      return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
    })
    .map(([key, list]) => ({ key, label: key || "(no category)", rows: skillsByName(list) }));
}

// One skill: the identity line (name, the link and gateway marks) and the detail line under it (description, then
// the path RELATIVE to the source it came from). Both lines carry the same words in their `title`, so a search for
// a word in a description finds the row even though the description is drawn on the line below it — and that
// tooltip carries the whole absolute path, which is what settles "same name, different file" by hand.
function skillsRowHtml(skill) {
  const absolute = skill.path || "";
  const where = skill.rel || absolute || "no SKILL.md — the gateway serves this name and no root this panel reads carries it";
  const title = [
    skill.description || "(no description)",
    absolute ? `path: ${absolute}` : where,
    `source: ${skill.sourceLabel || skill.source}`,
  ]
    .concat(skill.category ? [`category: ${skill.category}`] : [])
    .join(" · ");
  const chips = [];
  if (skill.isLink) {
    chips.push(`<span class="skills-chip link" title="reached through a link — the source above names its target">link</span>`);
  }
  if (skill.served === false) {
    chips.push(
      `<span class="skills-chip unsent" title="the gateway does not serve this name: shadowed by a higher-precedence copy, disabled in the profile, gated to another platform, or quarantined by the project scan">not served</span>`,
    );
  }
  // The gateway did not answer: one quiet mark per row, and the ONE banner at the top of the tab explains it. The
  // word "unverified" is deliberately not repeated down the list — a row that cannot be judged must not out-shout
  // the rows that can.
  const unknown =
    skill.served === null
      ? `<span class="skills-mark" data-skills-mark="unknown" aria-hidden="true" title="the gateway did not answer, so whether this skill is served is unknown — the line at the top of this tab says why">?</span>`
      : "";
  const attrs =
    `data-skills-block="1" data-skill="${esc(skill.name)}" data-skills-source="${esc(skill.source)}" data-skills-cat="${esc(skill.category || "")}"`;
  return (
    `<div class="settings-row skills-skill" ${attrs} title="${esc(title)}">` +
    `<span class="skills-name">${esc(skill.name)}</span>${chips.join("")}${unknown}</div>` +
    `<div class="settings-preview mono skills-detail" ${attrs} title="${esc(title)}">` +
    `<span class="skills-desc">${esc(skill.description || "(no description)")}</span>` +
    `<span class="skills-path" title="${esc(absolute || title)}">${esc(where)}</span></div>`
  );
}

// One category inside a source: its own foldable heading and the skills under it.
function skillsCategoryHtml(source, cat, folds, count) {
  const open = skillsCategoryOpen(folds, source.key, cat.key, count);
  const label = `${cat.label} — ${skillsMany(cat.rows.length, "skill", "skills")}`;
  return (
    `<div class="skills-catgroup" data-skills-cat-group="${esc(cat.key)}">` +
    `<button type="button" class="skills-fold skills-fold-cat skills-cathead" data-skills-fold-source="${esc(source.key)}" data-skills-fold-cat="${esc(cat.key)}" data-skills-fold-label="${esc(label)}" aria-expanded="${open}" title="${esc(skillsFoldTitle(open, label))}">` +
    `<span class="skills-caret" aria-hidden="true"></span>` +
    `<span class="skills-cat-name">${esc(cat.label)}</span>` +
    `<span class="skills-cat-count mono">${cat.rows.length}</span></button>` +
    `<div class="skills-catbody" data-skills-body-source="${esc(source.key)}" data-skills-body-cat="${esc(cat.key)}"${open ? "" : " hidden"}>` +
    cat.rows.map(skillsRowHtml).join("") +
    `</div></div>`
  );
}

// One source: a foldable heading (label, kind when it says something the label does not, and the count of rows
// under it) and the line under it — the path it reads, the target when it is a link, or the reason it holds
// nothing. An unreadable source is a heading with a reason, never a silent gap. Its categories are the second
// level, and a source with no rows still says so instead of leaving an empty box under its heading.
function skillsSourceHtml(source, rows, folds) {
  const cats = skillsCategories(rows);
  const open = skillsSourceOpen(folds, source.key);
  const bits = [source.path];
  if (source.isLink && source.target) bits.push(`→ ${source.target}`);
  if (source.status !== "ok" && source.reason) bits.push(`— ${source.reason}`);
  const where = bits.filter(Boolean).join(" ");
  const bad = source.status === "error" || source.status === "missing" || source.status === "ignored";
  // The kind is a chip only when it says something the label does not: "Profile · PROFILE" is noise, while
  // "sefl · LINK" is the whole point of the source.
  const kind = skillsKind(source);
  const kindChip = kind.toLowerCase() === String(source.label || "").toLowerCase() ? "" : `<span class="skills-chip kind">${esc(kind)}</span>`;
  const label = `${source.label || source.key} — ${skillsMany(rows.length, "skill", "skills")}${where ? ` · ${where}` : ""}`;
  const body = cats.length
    ? cats.map((cat) => skillsCategoryHtml(source, cat, folds, cats.length)).join("")
    : `<div class="skills-empty">no skill is read from here</div>`;
  return (
    `<div class="skills-srcgroup" data-skills-block="1" data-skills-source-group="${esc(source.key)}">` +
    `<button type="button" class="skills-fold skills-fold-source skills-source${rows.length ? "" : " empty"}" data-skills-fold-source="${esc(source.key)}" data-skills-fold-label="${esc(label)}" aria-expanded="${open}" title="${esc(skillsFoldTitle(open, label))}">` +
    `<span class="skills-caret" aria-hidden="true"></span>` +
    `<span class="skills-source-name">${esc(source.label)}</span>` +
    kindChip +
    `<span class="skills-source-count mono">${rows.length}</span></button>` +
    `<div class="settings-preview mono skills-source-path${bad ? " bad" : ""}" title="${esc(where)}">${esc(where)}</div>` +
    `<div class="skills-srcbody" data-skills-body-source="${esc(source.key)}"${open ? "" : " hidden"}>${body}</div>` +
    `</div>`
  );
}

// One delegated press for every heading: the headings are drawn again on every read, so a listener per heading
// would be a listener per paint. What it writes is the reader's own choice, in this browser.
function initSkillsGroups() {
  const panel = document.getElementById(SKILLS_PANEL_ID);
  if (!panel || panel.dataset.skillsFoldWired === "1") return;
  panel.dataset.skillsFoldWired = "1";
  panel.addEventListener("click", (e) => {
    const head = e.target.closest ? e.target.closest("[data-skills-fold-source]") : null;
    if (!head || head.tagName !== "BUTTON" || !panel.contains(head)) return;
    const key = head.dataset.skillsFoldSource;
    const isCategory = head.hasAttribute("data-skills-fold-cat");
    const category = isCategory ? head.dataset.skillsFoldCat : null;
    const scope = head.closest(isCategory ? ".skills-catgroup" : ".skills-srcgroup");
    const body = isCategory ? scope?.querySelector("[data-skills-body-cat]") : scope?.querySelector(".skills-srcbody");
    const folds = readSkillsFolds();
    const next = head.getAttribute("aria-expanded") !== "true";
    setSkillsFold(folds, key, category, next);
    applySkillsFold(head, body, next);
  });
}

const skillsSetCount = (scope, selector, n) => {
  const node = scope ? scope.querySelector(selector) : null;
  if (node) node.textContent = String(n);
};

// The Skills panel's own filter. The global search walks a panel's DIRECT children and this list is two levels
// deep, so it gets this painter and the same per-tab count comes back. Every heading's count is repainted against
// the filtered set, a group that answers nothing is hidden outright, and a group that does answer is opened for the
// duration of the query — then the reader's own fold choices are put back when the box clears.
function paintSkillsSearch(query, matched) {
  const panel = document.getElementById(SKILLS_PANEL_ID);
  if (!panel) return 0;
  const flat = [...panel.children].filter((node) => !node.classList || !node.classList.contains("skills-srcgroup"));
  let hits = paintSettingsRows(flat, query, matched);
  const folds = readSkillsFolds();
  for (const group of panel.querySelectorAll(".skills-srcgroup")) {
    const key = group.dataset.skillsSourceGroup;
    const cats = [...group.querySelectorAll(".skills-catgroup")];
    let sourceHits = 0;
    for (const cat of cats) {
      const catBody = cat.querySelector("[data-skills-body-cat]");
      const catHits = paintSettingsRows(catBody ? [...catBody.children] : [], query, matched);
      sourceHits += catHits;
      skillsSetCount(cat, ".skills-cat-count", catHits);
      cat.classList.toggle("search-hidden", Boolean(query) && !catHits);
      const open = query ? catHits > 0 : skillsCategoryOpen(folds, key, cat.dataset.skillsCatGroup, cats.length);
      applySkillsFold(cat.querySelector(".skills-cathead"), catBody, open);
    }
    skillsSetCount(group, ".skills-source-count", sourceHits);
    group.classList.toggle("search-hidden", Boolean(query) && !sourceHits);
    const open = query ? sourceHits > 0 : skillsSourceOpen(folds, key);
    applySkillsFold(group.querySelector(".skills-source"), group.querySelector(".skills-srcbody"), open);
    hits += sourceHits;
  }
  return hits;
}

// The whole tab, from one payload. Called on boot and whenever the panel opens on a stale read; a failure says why
// in the summary line instead of leaving `reading…` up for ever.
function paintSkills(error = null) {
  const panel = document.getElementById(SKILLS_PANEL_ID);
  if (!panel) return;
  for (const node of [...panel.querySelectorAll("[data-skills-block]")]) node.remove();
  const summary = document.getElementById("skills-summary");
  const gateway = document.getElementById("skills-gateway");
  const data = skillsIndex;
  if (error || !data) {
    if (summary) summary.textContent = `could not read the skills — ${error || "no answer"}`;
    if (gateway) {
      gateway.textContent = "nothing was read, so this tab knows nothing about the gateway either";
      gateway.title = gateway.textContent;
      gateway.classList.add("bad");
    }
    return;
  }
  const counts = data.counts || {};
  const bits = [skillsMany(counts.rows || 0, "skill", "skills"), skillsMany(counts.sources || 0, "source", "sources")];
  if (counts.duplicates) bits.push(`${skillsMany(counts.duplicates, "duplicate copy", "duplicate copies")} skipped`);
  bits.push(data.gateway?.ok ? `${counts.served || 0} served` : `${counts.rows || 0} unverified`);
  if (data.gateway?.ok && counts.unserved) bits.push(`${counts.unserved} not served`);
  if (data.gateway?.ok && counts.gatewayOnly) bits.push(`${counts.gatewayOnly} gateway-only`);
  if (summary) summary.textContent = bits.join(" · ");
  if (gateway) {
    const ok = Boolean(data.gateway?.ok);
    // ONE line, whatever the answer: the gateway's own words are the reason a run's served set is unknown, and the
    // rows below carry only a quiet mark — no row repeats the banner in its own words.
    gateway.textContent = ok
      ? `${data.gateway.url} · /v1/skills answers ${data.gateway.count} skills · read ${new Date(data.checkedAt).toLocaleTimeString()}`
      : `gateway ${data.gateway?.url || "(none)"} · ${data.gateway?.reason || "no answer"} — no row below can be said to be served`;
    gateway.title = gateway.textContent;
    gateway.classList.toggle("bad", !ok);
  }
  const folds = readSkillsFolds();
  let html = "";
  for (const source of data.sources || []) {
    const rows = (data.skills || []).filter((s) => s.source === source.key);
    html += skillsSourceHtml(source, rows, folds);
  }
  const served = (data.skills || []).filter((s) => s.source === "gateway");
  if (served.length) {
    html += skillsSourceHtml(
      {
        key: "gateway",
        label: "Gateway",
        kind: "gateway",
        path: data.gateway?.url || "",
        status: "ok",
        target: null,
        isLink: false,
      },
      served,
      folds,
    );
  }
  panel.insertAdjacentHTML("beforeend", html);
  initSkillsGroups();
  // A query typed before this answer landed must still hide what it does not match: the new rows are in the DOM
  // now, and the search paints from the DOM rather than from a cached list.
  const box = document.getElementById("settings-search");
  if (box && box.value) paintSettingsSearch();
}

async function loadSkills() {
  if (skillsLoading) return skillsLoading;
  skillsLoading = (async () => {
    try {
      const r = await apiFetch("/api/settings/skills");
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      skillsIndex = data;
      skillsLoadedAt = Date.now();
      paintSkills();
    } catch (e) {
      paintSkills(e.message || String(e));
    } finally {
      skillsLoading = null;
    }
  })();
  return skillsLoading;
}

// ---- Permissions tab -----------------------------------------------------------------------------
// Read-only: the server parses config.yaml and asks the gateway when this tab is read, and this side
// only draws the answer. Every row prints the file:line (or endpoint) it came from; a source that
// could not be read prints its reason in place of rows, never a guessed value. The search treats this
// list like the Skills one — its rows are two levels deep, so it paints its own filter and hands the
// same per-tab count back.
const PERMISSIONS_PANEL_ID = "settings-panel-permissions";
let permissionsIndex = null;
let permissionsLoadedAt = 0;
let permissionsLoading = null;

const permissionsRows = (source) => (Array.isArray(source && source.rows) ? source.rows : []);
const permissionsBad = (source) => Boolean(source) && source.status !== "ok";

function permissionStatusText(source) {
  if (!source) return "no answer";
  if (source.status === "ok") return "read";
  if (source.status === "missing") return "not in the file";
  if (source.status === "malformed") return "cannot read — malformed";
  if (source.status === "unauthorized") return "not exposed, needs a token";
  if (source.status === "unreachable") return "cannot reach";
  return "cannot read";
}

function permissionsGroupHtml(source) {
  const rows = permissionsRows(source);
  const bad = permissionsBad(source);
  const where = source.source || source.file || source.endpoint || "(no source)";
  const title = [source.label, where, source.reason || ""].filter(Boolean).join(" · ");
  let html =
    `<div class="perm-group" data-permissions-group="${esc(source.key)}" data-permissions-block="1">` +
    `<div class="settings-row perm-head" title="${esc(title)}">` +
    `<span class="perm-label">${esc(source.label || source.key)}</span>` +
    `<span class="perm-status mono${bad ? " bad" : ""}">${esc(permissionStatusText(source))}</span>` +
    `<span class="perm-source mono" title="${esc(where)}">${esc(where)}</span>` +
    `</div>`;
  if (bad) {
    html += `<div class="settings-preview mono perm-note bad" title="${esc(source.reason || "")}">${esc(source.reason || "this source could not be read")}</div>`;
  } else if (!rows.length) {
    html += `<div class="settings-preview mono perm-note">the source is present and holds no rows</div>`;
  } else {
    html += `<div class="perm-rows">`;
    for (const row of rows) {
      const src = row.source || where;
      html +=
        `<div class="settings-row perm-row" data-permissions-row="1" data-permissions-group="${esc(source.key)}" title="${esc(`${row.name}: ${row.value} · ${src}`)}">` +
        `<span class="perm-name mono">${esc(row.name)}</span>` +
        `<span class="perm-value mono">${esc(row.value)}</span>` +
        `<span class="perm-source mono" title="${esc(src)}">${esc(src)}</span>` +
        `</div>`;
    }
    html += `</div>`;
  }
  return `${html}</div>`;
}

// The whole tab, from one payload. A failure says why in the summary line instead of leaving
// `reading…` up for ever; a source that answered still draws its rows beside one that did not.
function paintPermissions(error = null) {
  const panel = document.getElementById(PERMISSIONS_PANEL_ID);
  if (!panel) return;
  for (const node of [...panel.querySelectorAll("[data-permissions-block]")]) node.remove();
  const summary = document.getElementById("permissions-summary");
  const config = document.getElementById("permissions-config");
  const data = permissionsIndex;
  if (error || !data) {
    if (summary) summary.textContent = `could not read the permissions — ${error || "no answer"}`;
    if (config) {
      config.textContent = "nothing was read, so this tab knows nothing about config.yaml or the gateway either";
      config.title = config.textContent;
      config.classList.add("bad");
    }
    return;
  }
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const counts = data.counts || {};
  const read = sources.filter((source) => source.status === "ok").length;
  const bits = [`${read}/${sources.length} sources read`, `${counts.rows || 0} rows`];
  if (counts.unreadable) bits.push(`${counts.unreadable} cannot be read`);
  if (summary) summary.textContent = bits.join(" · ");
  if (config) {
    const ok = data.configFile?.status === "ok";
    config.textContent = ok
      ? `${data.configFile.path} · read ${new Date(data.checkedAt).toLocaleTimeString()}`
      : `config.yaml · ${data.configFile?.reason || "could not be read"}`;
    config.title = config.textContent;
    config.classList.toggle("bad", !ok);
  }
  const list = document.getElementById("permissions-list");
  if (list) list.insertAdjacentHTML("beforeend", sources.map(permissionsGroupHtml).join(""));
  // A query typed before this answer landed must still hide what it does not match.
  const box = document.getElementById("settings-search");
  if (box && box.value) paintSettingsSearch();
}

// The Permissions list's own filter: the global search walks a panel's DIRECT children and this list
// is grouped, so every source heading and every permission row is matched here and the same per-tab
// count goes back. A group that answers nothing is hidden; a heading that answers alone still shows
// its (unmatched) rows, because the heading's tooltip names the source a reader was looking for.
function paintPermissionsSearch(query, matched) {
  const panel = document.getElementById(PERMISSIONS_PANEL_ID);
  if (!panel) return 0;
  const flat = [...panel.children].filter((node) => node.id !== "permissions-list");
  let hits = paintSettingsRows(flat, query, matched);
  for (const group of panel.querySelectorAll(".perm-group[data-permissions-group]")) {
    const head = group.querySelector(".perm-head");
    const rows = [...group.querySelectorAll("[data-permissions-row]")];
    let groupHits = 0;
    for (const row of rows) {
      const hit = !query || settingsRowText(row).includes(query);
      row.classList.toggle("search-hidden", !hit);
      if (hit) {
        groupHits += 1;
        if (query) matched.push(row);
      }
    }
    const headHit = !query || (head && settingsRowText(head).includes(query));
    if (query && headHit && head) matched.push(head);
    group.classList.toggle("search-hidden", Boolean(query) && !groupHits && !headHit);
    hits += groupHits || (query && headHit ? 1 : 0);
  }
  return hits;
}

async function loadPermissions() {
  if (permissionsLoading) return permissionsLoading;
  permissionsLoading = (async () => {
    try {
      const r = await apiFetch("/api/settings/permissions");
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      permissionsIndex = data;
      permissionsLoadedAt = Date.now();
      paintPermissions();
    } catch (e) {
      paintPermissions(e.message || String(e));
    } finally {
      permissionsLoading = null;
    }
  })();
  return permissionsLoading;
}

// ---- settings > pipeline -------------------------------------------------------------------------
// The Pipeline tab's whole surface: the catalogue the panel holds (the reader's pipelines.json merged per id over
// pipelines.seed.json), one definition opened for editing, and the validation the server does before a save. It
// follows the Permissions tab's shape — read on demand, paint from the answer — with one rule the brief names: an
// open editor with unsaved changes is NOT repainted. A repaint that replaced the form would take the caret and the
// half-typed sentence with it, so paintPipelines() refreshes the list and the summary and leaves the editor alone
// while `pipelineDraftDirty` is true; save and reload are the only ways out of a dirty draft. Every input event
// marks the draft dirty, so a keystroke can never arrive at a form a repaint is about to replace.
//
// The stage SEQUENCE is the one part of a dirty form that cannot be left alone. Add and remove are presses on the
// editor's own buttons, and the rows they change are not text the reader is typing: a form still drawing the old
// rows disagrees with the draft Save will write, and the next keystroke's updateDraftFromForm() would read those
// stale rows back — resurrecting a removed stage, or dropping a new one. So add and remove repaint `#pipeline-stages`
// alone (paintPipelineStages), from the draft, and that paint is caret-safe: the focused field's stage, class,
// selection and scroll are captured before the rows are replaced and put back after, so the guard above still holds
// for a reader who is mid-sentence in a stage field.
const PIPELINE_PANEL_ID = "settings-panel-pipeline";
let pipelinesIndex = null;
let pipelinesLoadedAt = 0;
let pipelinesLoading = null;
let pipelineOpenId = null;
let pipelineDraft = null;
let pipelineDraftDirty = false;
let pipelineFindings = [];
// The closed vocabulary the exit select offers. It is read from the last answer rather than written here, so a
// check added to lib/pipelines.js reaches the tab without a second copy going stale.
let pipelineExitChecks = [];
// The PDL pipeline the dropdown names, when the reader picked one. The bundle's pipelines are a different object from
// the ladder (a ladder rung says what a tree may do with a branch; a PDL pipeline says which stages a task runs), so
// the tab keeps one selection of each: `pipelineOpenId` is the ladder being edited, this is the PDL pipeline being
// looked at. Both are offered by the one dropdown, PDL first, and only one of them is ever set.
let pipelinePdlId = null;

// The PDL pipelines this panel holds, from the same `pdl` block the queue's picker reads (lib/pipeline-source.js).
// A refused or missing bundle is [] here: the list above the dropdown already prints the loader's own reason, and a
// control that offered a pipeline the file does not hold would be the second answer this tab exists to remove.
function pdlPipelines() {
  const pdl = pipelinesIndex && pipelinesIndex.pdl;
  return pdl && pdl.ok === true && Array.isArray(pdl.pipelines) ? pdl.pipelines : [];
}

function selectedPdlPipeline() {
  if (!pipelinePdlId) return null;
  return pdlPipelines().find((p) => p.id === pipelinePdlId) || null;
}

// The PDL selection's own sentence. The editor's status element is built INSIDE the ladder editor
// (paintPipelineEditor), and a PDL pipeline closes that editor, so a note about a PDL selection needs its own row.
function setPipelinePdlNote(text = "") {
  const el = document.getElementById("pipeline-pdl-pick");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

function pdlPickNote(pdl) {
  const stages = Array.isArray(pdl.stages) ? pdl.stages.length : 0;
  const gates = Array.isArray(pdl.gates) ? pdl.gates.length : 0;
  const handoffs = Array.isArray(pdl.handoffs) ? pdl.handoffs.length : 0;
  return `PDL pipeline "${pdl.id}" — read-only here: ${stages} stage${stages === 1 ? "" : "s"}, ${gates} gate${gates === 1 ? "" : "s"}, ${handoffs} handoff${handoffs === 1 ? "" : "s"}. Open the flow to draw it.`;
}

// The map page draws a document it is handed. With a PDL pipeline selected it is handed this panel's own catalogue
// route, so the page draws the pipelines this install actually holds (config.pipelineBundleFile) rather than the
// shipped seed; with a ladder selected it stays the generated library page. Called from the paint AND from the press,
// because the link's target follows the selection, not the last read.
function paintPipelineMapLink() {
  const mapLink = document.getElementById("pipeline-map-open");
  if (!mapLink) return;
  mapLink.href = pipelinePdlId ? "/pipeline-map.html?doc=/api/assistant/pipeline-catalogue" : "/pipeline-map.html";
  mapLink.title = pipelinePdlId
    ? "open the map in a new tab — it reads this panel's PDL catalogue and draws every pipeline in it, each stage's artifact, gate and handoff with it"
    : "open the map in a new tab — every definition and every bundle pipeline on one page, each stage's role and exit check with it";
}

// The option's words: the tag first, because the two lists are one dropdown and the reader has to be able to tell
// which kind of pipeline they are about to look at before they pick it.
function pdlOptionLabel(pipeline) {
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages.length : 0;
  return `PDL · ${pipeline.id} — ${pipeline.title || pipeline.id} (${stages} stage${stages === 1 ? "" : "s"})`;
}

async function loadPipelines() {
  if (pipelinesLoading) return pipelinesLoading;
  pipelinesLoading = (async () => {
    try {
      const r = await apiFetch("/api/pipelines");
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      pipelinesIndex = data;
      pipelinesLoadedAt = Date.now();
      paintPipelines();
    } catch (e) {
      paintPipelines(e.message || String(e));
    } finally {
      pipelinesLoading = null;
    }
  })();
  return pipelinesLoading;
}

// The tab's ONE selector: a dropdown of the definitions the catalogue holds, the editor for the one it names, and the
// button that draws that definition's flow (public/pipeline-flow.js + public/pipeline-modal.js, in edit mode). The
// list of rows this replaces was a second way to say "which pipeline"; a dropdown says it once, and the summary above
// still carries the counts and the file the catalogue was read from.
//
// A definition the loader dropped is named under the dropdown with its reason, not hidden: a pipeline missing from a
// select must say why it is missing. The dropped row is still a settings row, so the tab's own search finds it.
function pipelineDroppedHtml(def) {
  const why = String(def.why || "");
  return `<div class="settings-row pipeline-row bad" data-pipeline-row="${esc(def.id)}" title="${esc(why)}"><span>dropped: <span class="mono">${esc(def.id)}</span></span><span class="settings-unit mono">${esc(why)}</span></div>`;
}

function pipelineOptionLabel(def) {
  const stages = Array.isArray(def.stages) ? def.stages.length : 0;
  return `${def.id} — ${def.title || def.id} (${def.kind || "?"}, ${stages} stage${stages === 1 ? "" : "s"})`;
}

// The pipelines a TASK runs on: the PDL bundle's list, carried by this same route as `pdl` and read by
// lib/pipeline-source.js - the module the queue's task pipeline window and the queue picker read. It is drawn here,
// beside the ladder, because the two are one click apart in the reader's mind and were two different sets of
// "pipelines" on two different tabs. The list is the ROUTE's, never a second parse: a bundle that is missing or
// refused is printed with the loader's own code and locator, and the ladder above is never blamed for it.
function pdlPipelineRowHtml(pipeline) {
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages.length : 0;
  const isolation = pipeline.isolation === "per-stage" ? "one tree per stage" : "one tree";
  const title = `${pipeline.title || pipeline.id} — ${stages} stage${stages === 1 ? "" : "s"}, ${isolation}. This is the pipeline a task is put on: open a queue task's pipeline window to see its stages in order and choose one.`;
  return `<div class="settings-row" data-pdl-pipeline="${esc(pipeline.id)}" title="${esc(title)}">
      <span><strong>${esc(pipeline.title || pipeline.id)}</strong> <span class="mono">${esc(pipeline.id)}</span></span>
      <span class="settings-unit mono">${stages} stage${stages === 1 ? "" : "s"}</span>
    </div>`;
}

function paintPdlPipelines(pdl, error = null) {
  const summary = document.getElementById("pipeline-pdl-summary");
  const source = document.getElementById("pipeline-pdl-source");
  const list = document.getElementById("pipeline-pdl-list");
  if (!summary || !list) return;
  summary.classList.remove("bad");
  if (source) source.classList.remove("bad");
  const answer = !error && pdl && typeof pdl === "object" ? pdl : null;
  if (!answer) {
    summary.textContent = error ? `could not read the PDL bundle — ${error}` : "no PDL bundle was read by this answer";
    summary.classList.add("bad");
    if (source) {
      source.textContent = "nothing was read, so this tab cannot say which pipelines a task can be put on";
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = "";
    return;
  }
  const pipelines = Array.isArray(answer.pipelines) ? answer.pipelines : [];
  if (answer.ok !== true) {
    summary.textContent = `refused — ${answer.code || "the bundle was refused"}`;
    summary.classList.add("bad");
    if (source) {
      source.textContent = `${answer.file || "the PDL bundle"} — ${answer.reason || "the loader refused it"}`;
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = "";
    return;
  }
  const total = pipelines.reduce((n, p) => n + (Array.isArray(p.stages) ? p.stages.length : 0), 0);
  summary.textContent = `${pipelines.length} pipeline${pipelines.length === 1 ? "" : "s"} · ${total} stage${total === 1 ? "" : "s"}${answer.name ? ` · ${answer.name}` : ""}`;
  if (source) {
    source.textContent = `${answer.file || "the PDL bundle"} · the list the queue's pipeline window offers`;
    source.title = source.textContent;
  }
  list.innerHTML = pipelines.length
    ? pipelines.map(pdlPipelineRowHtml).join("")
    : `<div class="settings-row"><span>this bundle holds no pipeline — a task can only be put on the assistant's default path</span></div>`;
}

function paintPipelines(error = null) {
  const summary = document.getElementById("pipeline-summary");
  const source = document.getElementById("pipeline-source");
  const list = document.getElementById("pipeline-list");
  const pick = document.getElementById("pipeline-select");
  if (!summary || !list) return;
  const data = pipelinesIndex;
  if (error || !data) {
    summary.textContent = `could not read the pipelines — ${error || "no answer"}`;
    summary.classList.add("bad");
    if (source) {
      source.textContent = "nothing was read, so this tab knows nothing about the catalogue";
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = "";
    if (pick) {
      pick.innerHTML = `<option value="">(no catalogue)</option>`;
      pick.disabled = true;
    }
    // The PDL list has nothing to draw from a failed read either, and saying so is better than leaving the last
    // paint's rows on screen beside a refusal.
    paintPdlPipelines(null, error || "no answer");
    return;
  }
  summary.classList.remove("bad");
  const pipelines = data.pipelines || {};
  const ids = Object.keys(pipelines);
  const bits = [`${ids.length} definition${ids.length === 1 ? "" : "s"}`];
  if (data.readOnly) bits.push("read-only");
  if (data.refused) bits.push("refused whole");
  if (Array.isArray(data.dropped) && data.dropped.length) bits.push(`${data.dropped.length} dropped`);
  summary.textContent = bits.join(" · ");
  if (source) {
    source.textContent = data.refused
      ? `${data.file || "pipelines.json"} refused — ${data.refused.why || "the seed is in force read-only"}`
      : `${data.file || "pipelines.json"} over ${data.seedFile || "pipelines.seed.json"} · version ${data.version ?? "?"} (this panel reads ${data.supported})`;
    source.title = source.textContent;
    source.classList.toggle("bad", Boolean(data.refused));
  }
  pipelineExitChecks = Array.isArray(data.exitChecks) ? data.exitChecks : pipelineExitChecks;
  // The other half of "the pipelines this panel holds": the PDL bundle, drawn from this route's own `pdl` block.
  paintPdlPipelines(data.pdl);
  // The dropdown, and the definition it names. The open one is kept while it is still in the catalogue; when nothing
  // is open (or what was open was dropped) the first definition is selected, because the tab's job is to edit ONE.
  // The dropdown is ONE control over two lists: the PDL pipelines a task runs on, tagged PDL and first, then the
  // built-in ladders this tab edits. A PDL pipeline the bundle no longer holds is dropped from the selection, so the
  // control can never name a pipeline the file does not carry.
  const pdlList = pdlPipelines();
  if (pipelinePdlId && !pdlList.some((p) => p.id === pipelinePdlId)) pipelinePdlId = null;
  const wanted = pipelineOpenId && pipelines[pipelineOpenId] ? pipelineOpenId : ids[0] || "";
  if (pick) {
    const pdlOptions = pdlList.length
      ? `<optgroup label="PDL pipelines">${pdlList.map((p) => `<option value="pdl:${esc(p.id)}"${p.id === pipelinePdlId ? " selected" : ""}>${esc(pdlOptionLabel(p))}</option>`).join("")}</optgroup>`
      : "";
    const ladderOptions = ids.length
      ? `<optgroup label="built-in ladders">${ids.map((id) => `<option value="${esc(id)}"${!pipelinePdlId && id === wanted ? " selected" : ""}>${esc(pipelineOptionLabel(pipelines[id]))}</option>`).join("")}</optgroup>`
      : "";
    pick.innerHTML = pdlOptions + ladderOptions || `<option value="">(no pipeline is in force)</option>`;
    pick.disabled = !pdlList.length && !ids.length;
    const value = pipelinePdlId ? `pdl:${pipelinePdlId}` : wanted;
    if (pick.value !== value) pick.value = value;
  }
  const flowBtn = document.getElementById("pipeline-flow-open");
  if (flowBtn) {
    flowBtn.disabled = !(pipelinePdlId || wanted);
    flowBtn.title = pipelinePdlId
      ? "open the flow — this PDL pipeline's stages left to right, with its gates on the connectors and its handoffs as the dashed loops. Read-only: nothing here runs a stage."
      : "open the flow — every stage of this definition left to right, with its exit checks as notches on the connectors. A definition has no position, so every stage is drawn not reached.";
  }
  paintPipelineMapLink();
  list.innerHTML = (data.dropped || []).map(pipelineDroppedHtml).join("") || (ids.length ? "" : `<div class="settings-row"><span>no pipeline is in force — the catalogue is empty</span></div>`);
  // A dirty draft is never replaced: the list may repaint as often as it likes, and the form keeps the reader's text.
  if (!pipelineDraftDirty) {
    if (pipelinePdlId) {
      // A PDL pipeline is not a ladder: the editor edits ladders, so it is closed and the status says what is drawn.
      if (pipelineOpenId) closePipelineEditor();
    } else if (wanted && (pipelineOpenId !== wanted || !pipelineDraft)) {
      pipelineOpenId = wanted;
      pipelineDraft = JSON.parse(JSON.stringify(pipelines[wanted]));
      paintPipelineEditor();
    } else if (wanted && pipelineDraft) {
      pipelineDraft = JSON.parse(JSON.stringify(pipelines[wanted]));
      paintPipelineEditor();
    } else if (!wanted) {
      closePipelineEditor();
    }
  }
  // The PDL selection's note follows the selection, including across a repaint that kept it.
  setPipelinePdlNote(pipelinePdlId ? pdlPickNote(selectedPdlPipeline() || { id: pipelinePdlId }) : "");
  const box = document.getElementById("settings-search");
  if (box && box.value) paintSettingsSearch();
}

// The dropdown's press: select a definition and edit it. A dirty draft is the one thing that can refuse the change,
// and the select snaps back to the definition the form is still holding — a dropdown that stayed on "b" while the form
// showed "a" would be a control that lies about what Save will write.
function selectPipelineTab(value) {
  const pipelines = (pipelinesIndex && pipelinesIndex.pipelines) || {};
  const pick = document.getElementById("pipeline-select");
  const raw = String(value || "");
  // The dropdown's two lists share one control, so the value says which list it came from: `pdl:<id>` is a pipeline a
  // task runs on, anything else is a ladder definition this tab edits.
  const pdlId = raw.startsWith("pdl:") ? raw.slice(4) : "";
  const snapBack = () => {
    if (pick) pick.value = pipelinePdlId ? `pdl:${pipelinePdlId}` : pipelineOpenId || "";
  };
  // A dirty ladder draft is the one thing that can refuse the change, whichever list the press came from.
  if (pipelineDraftDirty && pipelineOpenId) {
    setPipelineStatus(`"${pipelineOpenId}" has unsaved changes — save or reload it before switching`, true);
    snapBack();
    return;
  }
  if (pdlId) {
    const pdl = pdlPipelines().find((p) => p.id === pdlId);
    if (!pdl) {
      snapBack();
      return;
    }
    pipelinePdlId = pdlId;
    // A PDL pipeline is not a ladder: the editor edits ladders, so it is closed rather than left showing another
    // document's stages under this pipeline's name.
    closePipelineEditor();
    setPipelinePdlNote(pdlPickNote(pdl));
    paintPipelineMapLink();
    return;
  }
  if (!pipelines[raw]) {
    snapBack();
    return;
  }
  pipelinePdlId = null;
  setPipelinePdlNote("");
  paintPipelineMapLink();
  openPipelineEditor(raw);
}

// The control that opens the modal, in edit mode. The DRAFT is what is drawn (so a half-made edit is drawn as it
// stands), and the flow's marks are all "not reached": a definition has no position — a task carries the position.
function openPipelineFlow() {
  // A PDL pipeline is drawn from its own document, not from a ladder draft: the two are different objects and the
  // dialog says which one it is showing.
  const pdl = selectedPdlPipeline();
  if (pdl) {
    openPdlFlow(pdl);
    return;
  }
  const pipelines = (pipelinesIndex && pipelinesIndex.pipelines) || {};
  const id = pipelineOpenId || (document.getElementById("pipeline-select") || {}).value || "";
  const def = pipelineDraft || pipelines[id];
  if (!def || typeof PipelineFlow === "undefined" || typeof PipelineModal === "undefined") return;
  const flow = PipelineFlow.fromDefinition(def);
  const stages = flow.stages.length;
  PipelineModal.open({
    mode: "edit",
    title: def.title || def.id || id,
    subtitle: pipelineDraftDirty ? "unsaved changes" : "",
    pipeline: flow,
    // The DRAWER's model: the preview builds the map page's card from the definition itself (ordinals, roles, exit
    // labels), and it is the DRAFT, so an unsaved edit is what the chart shows. The flow above still drives the edit
    // view, which is why both are handed over.
    definition: def,
    position: null,
    preview: false,
    facts: [
      { label: "pipeline", value: id || "—" },
      { label: "kind", value: def.kind || "?" },
      { label: "stages", value: String(stages) },
      { label: "next", value: def.next || "end of the chain" },
    ],
    // No caption here: the drawing's own legend says "not reached 13" once when a definition has no position, and an
    // empty definition draws its own "no stage" box. A sentence repeating either was the dialog apologising for the
    // picture instead of letting it speak.
    opener: document.getElementById("pipeline-flow-open"),
  });
}

// A PDL pipeline's flow: the map page's card, built from the document's own stages, gates and handoffs
// (public/core/pipeline-mermaid.js `fromPdl`). There is no edit drawing and no position — this dialog draws the
// document, and the tab that edits ladders is not editing this one.
function openPdlFlow(pdl) {
  if (typeof PipelineModal === "undefined") return;
  const stages = Array.isArray(pdl.stages) ? pdl.stages.length : 0;
  const gates = Array.isArray(pdl.gates) ? pdl.gates.length : 0;
  const handoffs = Array.isArray(pdl.handoffs) ? pdl.handoffs.length : 0;
  PipelineModal.open({
    mode: "edit",
    pdl: true,
    title: pdl.title || pdl.id,
    subtitle: "PDL · read-only",
    pipeline: null,
    definition: pdl,
    position: null,
    preview: true,
    facts: [
      { label: "pipeline", value: pdl.id || "—" },
      { label: "kind", value: "PDL" },
      { label: "stages", value: String(stages) },
      { label: "gates", value: String(gates) },
      { label: "handoffs", value: String(handoffs) },
    ],
    opener: document.getElementById("pipeline-flow-open"),
  });
}

// Wired once, at load: the two controls are static markup (index.html), and the editor they drive is rebuilt under
// them on every read. `pipeline-select`'s `change` is the press; a keyboard user never has to open the dropdown twice.
document.getElementById("pipeline-select")?.addEventListener("change", (e) => selectPipelineTab(e.target.value));
document.getElementById("pipeline-flow-open")?.addEventListener("click", (e) => {
  e.preventDefault();
  openPipelineFlow();
});

function openPipelineEditor(id) {
  const pipelines = (pipelinesIndex && pipelinesIndex.pipelines) || {};
  const def = pipelines[id];
  if (!def) return;
  if (pipelineDraftDirty && pipelineOpenId && pipelineOpenId !== id) {
    setPipelineStatus(`"${pipelineOpenId}" has unsaved changes — save or reload it before opening another`, true);
    return;
  }
  pipelineOpenId = id;
  pipelineDraft = JSON.parse(JSON.stringify(def));
  pipelineDraftDirty = false;
  pipelineFindings = [];
  paintPipelineEditor();
}

function closePipelineEditor() {
  pipelineOpenId = null;
  pipelineDraft = null;
  pipelineDraftDirty = false;
  pipelineFindings = [];
  const editor = document.getElementById("pipeline-editor");
  if (editor) {
    editor.hidden = true;
    editor.innerHTML = "";
  }
}

function setPipelineStatus(text, bad = false) {
  const el = document.getElementById("pipeline-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", Boolean(bad));
}

function paintPipelineFindings() {
  const el = document.getElementById("pipeline-findings");
  if (!el) return;
  if (!pipelineFindings.length) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML =
    `<div class="pipeline-finding-head">${pipelineFindings.length} finding${pipelineFindings.length === 1 ? "" : "s"} — nothing was saved</div>` +
    pipelineFindings.map((f) => `<div class="pipeline-finding mono">${esc(f)}</div>`).join("");
}

function pipelineStageHtml(stage, index) {
  const exit = stage.exit && typeof stage.exit === "object" ? stage.exit : {};
  const check = exit.check || "clean";
  const params = Object.fromEntries(Object.entries(exit).filter(([k]) => k !== "check"));
  const options = pipelineExitChecks.map((c) => `<option value="${esc(c)}"${c === check ? " selected" : ""}>${esc(c)}</option>`).join("");
  return `<div class="pipeline-stage" data-stage-index="${index}">
      <div class="settings-row">
        <span class="mono">stage ${index + 1}</span>
        <input type="text" class="stage-id" value="${esc(stage.id || "")}" placeholder="id" aria-label="stage ${index + 1} id" />
        <input type="text" class="stage-title" value="${esc(stage.title || "")}" placeholder="title" aria-label="stage ${index + 1} title" />
        <button type="button" class="stage-remove" title="remove this stage">remove</button>
      </div>
      <div class="settings-row">
        <textarea class="stage-prompt" rows="3" placeholder="the stage's whole instruction to the worker" aria-label="stage ${index + 1} prompt">${esc(stage.prompt || "")}</textarea>
      </div>
      <div class="settings-row">
        <span>exit</span>
        <select class="stage-exit-check" aria-label="stage ${index + 1} exit check">${options}</select>
        <input type="text" class="stage-exit-params mono" value="${esc(JSON.stringify(params))}" placeholder="{}" aria-label="stage ${index + 1} exit parameters" title="the check's parameters as JSON, without the check name" />
      </div>
    </div>`;
}

function paintPipelineEditor() {
  const editor = document.getElementById("pipeline-editor");
  if (!editor) return;
  if (!pipelineOpenId || !pipelineDraft) {
    editor.hidden = true;
    editor.innerHTML = "";
    return;
  }
  editor.hidden = false;
  if (pipelineDraftDirty) {
    paintPipelineFindings();
    return;
  }
  const kinds = Array.isArray(pipelinesIndex?.kinds) ? pipelinesIndex.kinds : ["local", "investigation", "turnover"];
  const ids = Object.keys((pipelinesIndex && pipelinesIndex.pipelines) || {}).filter((id) => id !== pipelineOpenId);
  const nextOptions = [`<option value=""${!pipelineDraft.next ? " selected" : ""}>(none)</option>`]
    .concat(ids.map((id) => `<option value="${esc(id)}"${pipelineDraft.next === id ? " selected" : ""}>${esc(id)}</option>`))
    .join("");
  editor.innerHTML = `<div class="settings-row pipeline-editor-head">
      <span>editing <strong class="mono">${esc(pipelineOpenId)}</strong></span>
      <button type="button" id="pipeline-editor-close" title="close this definition">close</button>
    </div>
    <div class="settings-row"><span>title</span><input type="text" id="pipeline-title" value="${esc(pipelineDraft.title || "")}" aria-label="pipeline title" /></div>
    <div class="settings-row"><span>kind</span><select id="pipeline-kind" aria-label="pipeline kind">${kinds.map((k) => `<option value="${esc(k)}"${pipelineDraft.kind === k ? " selected" : ""}>${esc(k)}</option>`).join("")}</select></div>
    <div class="settings-row"><span>description</span><input type="text" id="pipeline-description" value="${esc(pipelineDraft.description || "")}" aria-label="pipeline description" /></div>
    <div class="settings-row"><span>next</span><select id="pipeline-next" aria-label="pipeline next">${nextOptions}</select></div>
    <div id="pipeline-stages">${(pipelineDraft.stages || []).map((s, i) => pipelineStageHtml(s, i)).join("")}</div>
    <div class="settings-row pipeline-editor-actions">
      <button type="button" id="pipeline-add-stage" title="append a stage">add stage</button>
      <span class="settings-unit" id="pipeline-status"></span>
      <button type="button" id="pipeline-reload" title="discard the unsaved edit and read the definition again">reload</button>
      <button type="button" id="pipeline-save" class="primary" title="validate and save this definition">save</button>
    </div>
    <div id="pipeline-findings" class="pipeline-findings" aria-live="polite" hidden></div>`;
  wirePipelineEditor();
  paintPipelineFindings();
  setPipelineStatus("no unsaved changes");
}

function markPipelineDraftDirty() {
  pipelineDraftDirty = true;
  setPipelineStatus("unsaved changes");
}

// The stage rows are wired on every paint that REPLACES them — the full paint and paintPipelineStages — because the
// rows are new nodes each time. A listener left on the discarded node would watch a field the reader can no longer
// see, so a keystroke in the row that replaced it would never reach the draft.
function wirePipelineStages(editor) {
  for (const stageEl of editor.querySelectorAll(".pipeline-stage")) {
    for (const el of stageEl.querySelectorAll("input, textarea, select")) {
      el.addEventListener("input", () => {
        markPipelineDraftDirty();
        updateDraftFromForm();
      });
      el.addEventListener("change", () => {
        markPipelineDraftDirty();
        updateDraftFromForm();
      });
    }
    stageEl.querySelector(".stage-remove")?.addEventListener("click", () => removePipelineStage(Number(stageEl.dataset.stageIndex)));
  }
}

// What a repaint of the stage rows has to put back: which stage the reader is in, which field of it holds the caret,
// and where the selection and the scroll were. A press on a row's own remove button is not a caret — the button goes
// with the row — so it is reported with no field and the repaint hands focus to the editor's add press.
function pipelineFocusBeforeRepaint() {
  const editor = document.getElementById("pipeline-editor");
  const host = editor && editor.querySelector("#pipeline-stages");
  const active = document.activeElement;
  if (!host || !active || active === document.body) return null;
  let stageEl = null;
  for (let el = active; el && el !== host; el = el.parentElement) {
    if (String(el.className || "").split(/\s+/).includes("pipeline-stage")) {
      stageEl = el;
      break;
    }
  }
  if (!stageEl) return null;
  const cls = String(active.className || "")
    .split(/\s+/)
    .find((c) => c.startsWith("stage-") && c !== "stage-remove");
  const caret =
    typeof active.selectionStart === "number"
      ? { start: active.selectionStart, end: active.selectionEnd, scrollTop: Number(active.scrollTop) || 0 }
      : null;
  return { index: Number(stageEl.dataset.stageIndex), cls: cls || null, caret };
}

function restorePipelineFocus(was) {
  const editor = document.getElementById("pipeline-editor");
  if (!was || !editor) return;
  if (was.cls) {
    const field = editor.querySelector(`.pipeline-stage[data-stage-index="${was.index}"] .${was.cls}`);
    if (field) {
      field.focus({ preventScroll: true });
      if (was.caret && typeof field.setSelectionRange === "function") {
        field.setSelectionRange(was.caret.start, was.caret.end);
        field.scrollTop = was.caret.scrollTop;
      }
      return;
    }
  }
  // The row the press was on is the row that went away (a remove), and leaving focus on a detached node drops the
  // reader at the top of the page. The editor's own add press is the nearest thing to where they were.
  editor.querySelector("#pipeline-add-stage")?.focus({ preventScroll: true });
}

// The stage rows, rebuilt from the draft — the one part of a dirty form that is painted rather than left alone.
function paintPipelineStages() {
  const editor = document.getElementById("pipeline-editor");
  const host = editor && editor.querySelector("#pipeline-stages");
  if (!host || !pipelineDraft) return;
  const was = pipelineFocusBeforeRepaint();
  host.innerHTML = (pipelineDraft.stages || []).map((s, i) => pipelineStageHtml(s, i)).join("");
  wirePipelineStages(editor);
  restorePipelineFocus(was);
}

function wirePipelineEditor() {
  const editor = document.getElementById("pipeline-editor");
  if (!editor) return;
  for (const el of editor.querySelectorAll("#pipeline-title, #pipeline-kind, #pipeline-description, #pipeline-next")) {
    el.addEventListener("input", () => {
      markPipelineDraftDirty();
      updateDraftFromForm();
    });
    el.addEventListener("change", () => {
      markPipelineDraftDirty();
      updateDraftFromForm();
    });
  }
  wirePipelineStages(editor);
  editor.querySelector("#pipeline-editor-close")?.addEventListener("click", () => {
    if (pipelineDraftDirty && !confirm(`discard the unsaved changes to "${pipelineOpenId}"?`)) return;
    closePipelineEditor();
  });
  editor.querySelector("#pipeline-add-stage")?.addEventListener("click", addPipelineStage);
  editor.querySelector("#pipeline-reload")?.addEventListener("click", () => {
    if (pipelineDraftDirty && !confirm(`discard the unsaved changes to "${pipelineOpenId}"?`)) return;
    const def = ((pipelinesIndex && pipelinesIndex.pipelines) || {})[pipelineOpenId];
    if (!def) return closePipelineEditor();
    pipelineDraft = JSON.parse(JSON.stringify(def));
    pipelineDraftDirty = false;
    pipelineFindings = [];
    paintPipelineEditor();
  });
  editor.querySelector("#pipeline-save")?.addEventListener("click", savePipelineEditor);
}

function updateDraftFromForm() {
  const editor = document.getElementById("pipeline-editor");
  if (!editor || !pipelineDraft) return;
  pipelineDraft.title = editor.querySelector("#pipeline-title")?.value ?? pipelineDraft.title;
  pipelineDraft.kind = editor.querySelector("#pipeline-kind")?.value ?? pipelineDraft.kind;
  pipelineDraft.description = editor.querySelector("#pipeline-description")?.value ?? pipelineDraft.description;
  const next = (editor.querySelector("#pipeline-next")?.value || "").trim();
  pipelineDraft.next = next || null;
  pipelineDraft.stages = [...editor.querySelectorAll(".pipeline-stage")].map((stageEl) => {
    let params = {};
    try {
      params = JSON.parse(stageEl.querySelector(".stage-exit-params")?.value || "{}");
    } catch {
      params = {};
    }
    return {
      id: (stageEl.querySelector(".stage-id")?.value || "").trim(),
      title: stageEl.querySelector(".stage-title")?.value || "",
      prompt: stageEl.querySelector(".stage-prompt")?.value || "",
      exit: { check: stageEl.querySelector(".stage-exit-check")?.value || "clean", ...(params && typeof params === "object" && !Array.isArray(params) ? params : {}) },
    };
  });
}

function addPipelineStage() {
  if (!pipelineDraft) return;
  updateDraftFromForm();
  pipelineDraft.stages = [...(pipelineDraft.stages || []), { id: "", title: "", prompt: "", exit: { check: "clean" } }];
  pipelineDraftDirty = true;
  // The rows, not the whole editor: the title, kind, description and next fields keep the reader's text, and the
  // new row is drawn from the draft that Save will write.
  paintPipelineStages();
  setPipelineStatus("unsaved changes — a new stage has no id or prompt yet", false);
}

function removePipelineStage(index) {
  if (!pipelineDraft || !Number.isInteger(index)) return;
  updateDraftFromForm();
  pipelineDraft.stages = (pipelineDraft.stages || []).filter((_, i) => i !== index);
  pipelineDraftDirty = true;
  paintPipelineStages();
  setPipelineStatus("unsaved changes");
}

async function savePipelineEditor() {
  if (!pipelineDraft) return;
  updateDraftFromForm();
  const id = pipelineOpenId;
  const body = { version: pipelinesIndex?.version ?? 1, pipelines: { [id]: pipelineDraft } };
  try {
    const r = await apiFetch("/api/pipelines", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      pipelineFindings = Array.isArray(data.findings) ? data.findings : [data.error || `HTTP ${r.status}`];
      paintPipelineFindings();
      setPipelineStatus(`refused — ${data.error || "the panel refused the document"}`, true);
      return;
    }
    pipelinesIndex = { ...(data.state || pipelinesIndex) };
    pipelineDraft = JSON.parse(JSON.stringify((pipelinesIndex.pipelines || {})[id] || pipelineDraft));
    pipelineDraftDirty = false;
    pipelineFindings = [];
    paintPipelines();
    paintPipelineEditor();
    setPipelineStatus(`saved "${id}"`);
  } catch (e) {
    pipelineFindings = [e.message || String(e)];
    paintPipelineFindings();
    setPipelineStatus("not saved — the panel did not answer", true);
  }
}

// The Pipeline panel's own filter. The list is rebuilt markup, so the global search walks the rows here and returns
// the same per-tab count. The editor is not a settings row: it is the thing being edited, and filtering a form is
// not filtering settings.
function paintPipelineSearch(query, matched) {
  const panel = document.getElementById(PIPELINE_PANEL_ID);
  if (!panel) return 0;
  const flat = [...panel.children].filter((node) => node.id !== "pipeline-list" && node.id !== "pipeline-pdl-list" && node.id !== "pipeline-editor");
  let hits = paintSettingsRows(flat, query, matched);
  // The two LISTS are containers of rows, not rows: each of their rows is walked here so a search finds a pipeline by
  // the name on it. Both lists are rebuilt markup, so this is the only place their rows meet the filter.
  for (const row of panel.querySelectorAll("[data-pipeline-row], [data-pdl-pipeline]")) {
    const hit = !query || settingsRowText(row).includes(query);
    row.classList.toggle("search-hidden", !hit);
    if (hit) {
      hits += 1;
      if (query) matched.push(row);
    }
  }
  return hits;
}

// ---- end settings > pipeline

// ---- settings > bundles ---------------------------------------------------------------------------
// The studio pipeline bundle this panel reads — one exported file per install (config.pipelineBundleFile, default
// state/pipeline-bundle.json) — its pipelines in order, and the queue tasks that sit on them. The tab is a READ of two
// answers that already exist: GET /api/assistant/pipeline-catalogue (lib/pipeline-bundle.js's readBundle, carried as a
// value with its own refusal code and locator) and GET /api/assistant/queue (every assistant's queue, decorated).
//
// It adds no third answer and no second pipeline drawing. Four rules decide its shape:
//
//   1. A refusal is the LOADER's. The catalogue route already answers ok:false with the bundle's code, its reason and
//      the locator in the exported file; this tab prints that code and sentence. "could not read the pipelines" over a
//      bundle that is there and broken sends the reader looking for a missing file.
//   2. The stages are the WINDOW's. A pipeline row names its title, id and stage count and stops there; the stage
//      sequence, the gate and the time in stage are drawn by the task pipeline window the Queue pane opens. A second
//      stage list here would be a second representation of one pipeline, and the two would drift.
//   3. A task with no pipeline is ON the default path. `pipelineRun: null` reads as "assistant decides" — the
//      contract's own words (lib/task-pipeline.js) — never "unassigned", which would read as a row that lost its
//      assignment. A record the bundle cannot resolve keeps its own sentence.
//   4. The press opens the WINDOW. A task row opens the same task pipeline window the Queue pane opens (it is
//      exposed as window.__openTaskPipelineWindow), so a task is put on a pipeline from the catalogue the window
//      already offers, with the same write, the same stamp and the same refusal. Nothing here posts anything.
const BUNDLES_PANEL_ID = "settings-panel-bundles";
let bundlesIndex = null;
let bundlesLoadedAt = 0;
let bundlesLoading = null;
let bundleQueues = null;
let bundleQueuesAt = 0;
// The queue read's own refusal, kept apart from the catalogue's: a refused bundle must not be blamed on the queues,
// and a failed queue read must not erase a pipeline list that is still true.
let bundleQueuesError = null;

// A task's place, in the words the contract uses: the pipeline and stage when the record resolves to both, the default
// path when there is no assignment, and the record's own shape when it is neither. The Queue pane's chip says the same
// three things; the sentence lives in lib/task-pipeline.js's vocabulary (assistant-decides / pipeline / unresolved).
function bundleTaskPlace(t) {
  const run = t?.pipelineRun;
  const object = run && typeof run === "object" && !Array.isArray(run) ? run : null;
  const pipeline = object && typeof object.pipeline === "string" ? object.pipeline.trim() : "";
  const stage = object && typeof object.stage === "string" ? object.stage.trim() : "";
  if (pipeline) return `pipeline ${pipeline}${stage ? ` · ${stage}` : ""}`;
  if (run == null) return "assistant decides";
  return object ? "pipeline: unresolved — no pipeline named" : "pipeline: unresolved — unreadable record";
}

function bundlePipelineRowHtml(pipeline) {
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages.length : 0;
  const title = `${pipeline.title || pipeline.id} — ${stages} stage${stages === 1 ? "" : "s"} in the imported bundle. The stages themselves are drawn by the task pipeline window, not here: open a queue task's window to see them in order.`;
  return `<div class="settings-row" data-bundle-pipeline="${esc(pipeline.id)}" title="${esc(title)}">
      <span><strong>${esc(pipeline.title || pipeline.id)}</strong> <span class="mono">${esc(pipeline.id)}</span></span>
      <span class="settings-unit mono">${stages} stage${stages === 1 ? "" : "s"}</span>
    </div>`;
}

// One row per task the panel can see. The unit carries the task's PLACE and its lane, because a row that only said the
// pipeline would hide a parked task behind a running one. The row is a press: it opens the window that owns the stages
// and the assignment.
function bundleTaskRowHtml(queue, t) {
  const where = bundleTaskPlace(t);
  const lane = String(t.state || "").trim();
  const unit = [where, lane].filter(Boolean).join(" · ");
  const title = `#${t.id} ${t.title || ""} — ${where}${lane ? ` (${lane})` : ""}. Press to open this task's pipeline window: every stage in order, where this task sits, and the control that puts it on a pipeline.`.trim();
  const own = queue?.assistantId || t.owner || "";
  return `<div class="settings-row" data-bundle-task="${esc(own)}" data-bundle-task-id="${esc(String(t.id))}" title="${esc(title)}">
      <span><strong>#${esc(String(t.id))} ${esc(t.title || "")}</strong> <span class="mono">${esc(queue?.name || own)}</span></span>
      <span class="settings-unit mono">${esc(unit)}</span>
    </div>`;
}

// The summary row, the source line and the two lists. Painted from one answer so a refusal cannot leave the summary
// saying "12 pipelines" beside a list saying "none" — the route's own `ok` decides both.
function paintBundles(error = null) {
  const summary = document.getElementById("bundle-summary");
  const source = document.getElementById("bundle-source");
  const list = document.getElementById("bundle-list");
  if (!summary || !list) return;
  summary.classList.remove("bad");
  if (source) source.classList.remove("bad");
  if (error) {
    summary.textContent = `could not read the pipeline catalogue — ${error}`;
    summary.classList.add("bad");
    if (source) {
      source.textContent = "nothing was read, so this tab knows nothing about the bundle";
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = "";
    paintBundleTasks(bundleQueuesError);
    return;
  }
  const data = bundlesIndex;
  if (!data) {
    summary.textContent = "reading…";
    if (source) source.textContent = "…";
    return;
  }
  if (data.ok !== true) {
    // The loader's own refusal: its code first (a reader can quote it), then its sentence and its locator. A generic
    // "no pipelines" here would erase the one fact that fixes it — whether the file is missing or broken.
    summary.textContent = `refused — ${data.code || "pipeline-bundle"}`;
    summary.classList.add("bad");
    if (source) {
      source.textContent = `${data.reason || "the bundle was refused"}${data.where ? ` (at ${data.where})` : ""}`;
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = `<div class="settings-row" title="the bundle was refused whole, so no pipeline from it can be listed — the sentence above names the file and the place in it"><span>no pipeline can be listed — the bundle was refused whole</span><span class="settings-unit mono">${esc(data.code || "pipeline-bundle")}</span></div>`;
    paintBundleTasks(bundleQueuesError);
    return;
  }
  const pipelines = Array.isArray(data.pipelines) ? data.pipelines : [];
  const bits = [`${pipelines.length} pipeline${pipelines.length === 1 ? "" : "s"}`];
  if (data.name) bits.push(data.name);
  summary.textContent = bits.join(" · ");
  if (source) {
    source.textContent = `${data.file || "the pipeline bundle"}${data.name ? ` · ${data.name}` : ""} — this panel imports whatever the studio's export saved there; the task pipeline window draws each pipeline's stages.`;
    source.title = source.textContent;
  }
  list.innerHTML =
    pipelines.map((pipeline) => bundlePipelineRowHtml(pipeline)).join("") ||
    `<div class="settings-row"><span>the bundle holds no pipeline — the file was read and is empty</span></div>`;
  paintBundleTasks(bundleQueuesError);
}

// The queue half. A read failure is named on its own row — the pipelines above are still true, and a failed queue read
// must not blank them. A task row is a press into the window, so this list carries no assignment control of its own.
function paintBundleTasks(error = null) {
  const summary = document.getElementById("bundle-tasks-summary");
  const list = document.getElementById("bundle-tasks");
  if (!summary || !list) return;
  summary.classList.remove("bad");
  if (error) {
    bundleQueuesError = error;
    summary.textContent = `could not read the queues — ${error}`;
    summary.classList.add("bad");
    list.innerHTML = "";
    return;
  }
  const data = bundleQueues;
  if (!data) {
    summary.textContent = "reading…";
    list.innerHTML = "";
    return;
  }
  const queues = Array.isArray(data.queues) ? data.queues : [];
  const rows = [];
  let active = 0;
  let done = 0;
  for (const queue of queues) {
    for (const t of queue.tasks || []) {
      if (String(t.state || "") === "done") {
        done += 1;
        continue;
      }
      active += 1;
      rows.push(bundleTaskRowHtml(queue, t));
    }
  }
  const failed = queues.filter((q) => q.error);
  const bits = [`${active} active task${active === 1 ? "" : "s"}`];
  if (done) bits.push(`${done} done`);
  if (failed.length) bits.push(`${failed.length} queue file${failed.length === 1 ? "" : "s"} unreadable`);
  summary.textContent = bits.join(" · ");
  if (failed.length) summary.classList.add("bad");
  list.innerHTML =
    rows.join("") ||
    `<div class="settings-row" title="every assistant's queue reads empty — there is no task to put on a pipeline yet"><span>no active queue task — nothing to put on a pipeline</span></div>`;
  // A re-read can land while the settings search is filtering this tab: the rebuilt rows are filtered by the same pass
  // the reader's next keystroke would run, so a match does not blink out of the list after a refresh.
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  if (box && box.value) paintSettingsSearch();
}

// The tab's own filter: the flat rows outside the two lists, then each list's rows. The window's card is not part of
// this panel (it is appended to the document by the task window), so a search never hides a form the reader opened.
function paintBundlesSearch(query, matched) {
  const panel = document.getElementById(BUNDLES_PANEL_ID);
  if (!panel) return 0;
  const flat = [...panel.children].filter((node) => node.id !== "bundle-list" && node.id !== "bundle-tasks");
  let hits = paintSettingsRows(flat, query, matched);
  for (const row of panel.querySelectorAll("[data-bundle-pipeline], [data-bundle-task]")) {
    const hit = !query || settingsRowText(row).includes(query);
    row.classList.toggle("search-hidden", !hit);
    if (hit) {
      hits += 1;
      if (query) matched.push(row);
    }
  }
  return hits;
}

// Two reads in parallel: the bundle's pipelines and every assistant's queue. Either can fail without taking the other
// with it — a refused bundle still lists its refusal beside whatever the queues say, and a failed queue read leaves
// the pipelines standing.
async function loadBundles() {
  if (bundlesLoading) return bundlesLoading;
  bundlesLoading = (async () => {
    let error = null;
    try {
      const [catalogue, queues] = await Promise.allSettled([
        apiFetch("/api/assistant/pipeline-catalogue").then(async (r) => {
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error((body && body.error) || `the catalogue answered ${r.status}`);
          return body;
        }),
        apiFetch("/api/assistant/queue").then(async (r) => {
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error((body && body.error) || `the queues answered ${r.status}`);
          return body;
        }),
      ]);
      if (catalogue.status === "fulfilled") {
        bundlesIndex = catalogue.value;
        bundlesLoadedAt = Date.now();
      } else {
        error = String((catalogue.reason && catalogue.reason.message) || catalogue.reason);
      }
      if (queues.status === "fulfilled") {
        bundleQueues = queues.value;
        bundleQueuesAt = Date.now();
        bundleQueuesError = null;
      } else {
        bundleQueuesError = String((queues.reason && queues.reason.message) || queues.reason);
      }
      paintBundles(error);
    } catch (e) {
      paintBundles(e.message || String(e));
    } finally {
      bundlesLoading = null;
    }
  })();
  return bundlesLoading;
}

// A chosen studio export, appended to the bundle this panel already reads.
//
// The bundle is a LIST, and the route appends by pipeline id: today's live file is one studio document, so before this
// a second import could only replace the first and the dropdown kept one entry. The page reads the file the reader
// chose, posts its TEXT (the server parses it with the same loader the panel reads with), and prints the route's own
// sentence — the added pipelines and their stage counts, or the refusal's code and the id it names.
async function bundleImportChosen(input) {
  const note = document.getElementById("bundle-import-note");
  const file = input && input.files && input.files[0] ? input.files[0] : null;
  if (!file) return null;
  const say = (message, bad = false) => {
    if (!note) return;
    note.textContent = message;
    note.classList.toggle("bad", bad);
  };
  say(`importing ${file.name}…`);
  let text;
  try {
    text = await file.text();
  } catch (e) {
    say(`${file.name} could not be read — ${(e && e.message) || e}`, true);
    return null;
  }
  try {
    const r = await apiFetch("/api/assistant/pipeline-bundle/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, name: file.name }),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.ok !== true) {
      // The route's refusal, in its own words: `code` first (a reader can quote it), then the sentence that names the
      // pipeline id the bundle already holds.
      const code = body && body.code ? ` (${body.code})` : "";
      say(`${file.name}: ${(body && body.error) || `the panel answered ${r.status}`}${code}`, true);
      return null;
    }
    say(body.reason || `imported ${file.name}`);
    // The Pipeline tab draws this same list (its `pdl` block), so its cached answer is stale the moment the write lands:
    // clearing the stamp makes that tab's next press re-read instead of waiting out the freshness window.
    pipelinesLoadedAt = 0;
    // The list above is a read of the file the write just changed, so it is re-read before the note is trusted.
    await loadBundles();
    return body;
  } catch (e) {
    say(`${file.name}: ${(e && e.message) || e}`, true);
    return null;
  } finally {
    // The same file may be chosen twice in a row (a corrected export with the same name): a file input that kept its
    // value would fire no `change` the second time and the press would look dead.
    if (input) input.value = "";
  }
}

// A task row's press: the SAME window the Queue pane opens. The window reads its own model and catalogue, so this
// handler carries two ids and the row the caret came from — nothing else, and no assignment logic of its own.
function initBundlesPanel() {
  const panel = document.getElementById(BUNDLES_PANEL_ID);
  if (!panel) return;
  // The task pipeline window's assignment press writes the QUEUE (the record's one door), and this tab's rows are a
  // read of that queue. So the window's own event is what tells this tab its rows are stale — without it a row keeps
  // saying "assistant decides" after the reader put the task on a pipeline. The refresh runs whether or not this tab
  // is on screen: the settings window CLOSES while the task window is up (the window opens over it), so gating on
  // "visible" would drop the one notice that the data moved, and the next open would read it as too recent to reload.
  // Two reads behind a closed window are cheaper than a row that contradicts the queue on the next open.
  document.addEventListener("wtgui:task-pipeline-assigned", () => {
    void loadBundles();
  });
  // The import's file picker: the button is the affordance, the hidden input is what a browser will open. Reading
  // happens on `change` (the reader may cancel the dialog, which fires nothing), so a cancelled pick leaves no note.
  panel.addEventListener("change", (e) => {
    if (e.target?.id !== "bundle-import-file") return;
    void bundleImportChosen(e.target);
  });
  panel.addEventListener("click", (e) => {
    const refresh = e.target?.closest?.("[data-bundle-refresh]");
    if (refresh) {
      e.preventDefault();
      void loadBundles();
      return;
    }
    const importer = e.target?.closest?.("[data-bundle-import]");
    if (importer) {
      e.preventDefault();
      document.getElementById("bundle-import-file")?.click?.();
      return;
    }
    const row = e.target?.closest?.("[data-bundle-task]");
    if (!row) return;
    e.preventDefault();
    const opener = typeof window.__openTaskPipelineWindow === "function" ? window.__openTaskPipelineWindow : null;
    if (!opener) {
      paintBundleTasks("this build does not expose the task pipeline window — reload the panel");
      return;
    }
    void opener(row.dataset.bundleTask, row.dataset.bundleTaskId, row);
  });
}

// ---- end settings > bundles

// ---- settings window: move it, size it ------------------------------------------------------------
// The panel used to be a popover pinned under the top bar: `position: fixed; right: 16px; top: 74px` and no way to
// move it off what it was covering, nor to see more of a long group than the height it opened at. It is a window
// now — a press on its head drags it, its corner grip sizes it — and the rect the reader leaves it at is remembered
// in this browser. The gestures follow the assistant's floating pane (`public/assistant.js`: `placeFloat` and the
// `float-move` / `float-size` cases of `onDown`), because the two are the same problem: a fixed node measured in
// CLIENT px and written back in LAYOUT px.
const SETTINGS_RECT_KEY = "wtgui.settingsRect";
const SETTINGS_MIN_W = 320;
const SETTINGS_MIN_H = 240;
const SETTINGS_EDGE = 8;
const SETTINGS_SLOP = 3;

// A client length as a layout one: `getBoundingClientRect` and `clientX` are VISUAL px while a length written to
// `style.left`/`style.width` is LAYOUT px, and Settings > Display's zoom scales the page (`applyZoom`).
function settingsZoom() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// The box a clamp is measured against: the LAYOUT viewport (`documentElement.clientWidth` is layout px while the
// page is zoomed), the same box the assistant's float places itself in.
function settingsViewport() {
  const doc = document.documentElement;
  return { vw: doc.clientWidth || window.innerWidth, vh: doc.clientHeight || window.innerHeight };
}

// A stored rect, or nothing: a value that is not four finite numbers is no record at all, so a half-written store
// opens the panel where the stylesheet puts it rather than at `NaNpx`.
function readSettingsRect() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_RECT_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const rect = { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h) };
    return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ? rect : null;
  } catch {
    return null;
  }
}

function writeSettingsRect(rect) {
  try {
    localStorage.setItem(SETTINGS_RECT_KEY, JSON.stringify(rect));
  } catch {
    /* a browser that refuses storage still drags; it just forgets between loads */
  }
}

let settingsRect = readSettingsRect();

// The remembered rect inside the window it is being opened on: a rect saved on a bigger screen must not put half the
// panel outside a smaller one, and neither dimension goes under the panel's floor. Both edges are clamped, so a rect
// left hanging off one side comes back whole rather than half-visible.
function clampSettingsRect(r) {
  const { vw, vh } = settingsViewport();
  const maxW = Math.max(SETTINGS_MIN_W, vw - 2 * SETTINGS_EDGE);
  const maxH = Math.max(SETTINGS_MIN_H, vh - 2 * SETTINGS_EDGE);
  const w = Math.max(SETTINGS_MIN_W, Math.min(Number(r.w) || SETTINGS_MIN_W, maxW));
  const h = Math.max(SETTINGS_MIN_H, Math.min(Number(r.h) || SETTINGS_MIN_H, maxH));
  const x = Math.max(SETTINGS_EDGE, Math.min(Number(r.x) || 0, Math.max(SETTINGS_EDGE, vw - w - SETTINGS_EDGE)));
  const y = Math.max(SETTINGS_EDGE, Math.min(Number(r.y) || 0, Math.max(SETTINGS_EDGE, vh - h - SETTINGS_EDGE)));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// Put the panel where the reader left it. A panel that was never moved keeps the stylesheet's anchored rule, so
// there is no rect to place and this does nothing at all.
function placeSettingsWindow() {
  const panel = $("settings");
  if (!panel || !settingsRect) return;
  const rect = clampSettingsRect(settingsRect);
  panel.style.left = `${rect.x}px`;
  panel.style.top = `${rect.y}px`;
  panel.style.width = `${rect.w}px`;
  panel.style.height = `${rect.h}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  // The remembered height IS the window's height: the stylesheet's `max-height: calc(100vh - 90px)` would otherwise
  // cap it wherever the top edge has been dragged to.
  panel.style.maxHeight = "none";
}

function initSettingsWindow() {
  const panel = $("settings");
  if (!panel) return;
  const head = panel.querySelector(":scope > .settings-head");
  const grip = document.getElementById("settings-grip");
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let press = null;

  // `kind` is the gesture: the head moves the window, the grip sizes it from its bottom-right corner. Every length
  // starts as a CLIENT measurement — the unit a pointer arrives in — and is divided by the zoom once, so the rect
  // that is written and the rect that is remembered are both LAYOUT px.
  const onDown = (e, kind, captureEl) => {
    if (e.button !== 0) return;
    // The head is a row of CONTROLS as well as the window's bar: a press on the search box or a button is that
    // control's, or the box could never be clicked into and every ✕ press would start a drag first.
    if (kind === "move" && e.target.closest("button,input,select,textarea,a,label")) return;
    const z = settingsZoom();
    const r = panel.getBoundingClientRect();
    press = { kind, px: e.clientX, py: e.clientY, moved: false, z, box: { x: r.left / z, y: r.top / z, w: r.width / z, h: r.height / z } };
    // Hold the pointer for the length of the gesture: without capture it leaves the panel (and the window) and the
    // moves stop arriving, so a release out there never ends the drag started in here.
    try {
      captureEl.setPointerCapture(e.pointerId);
    } catch {
      /* older pointer stacks: the window listeners below still carry the gesture */
    }
    e.preventDefault();
  };

  // The anchored rule becomes explicit edges on the FIRST real movement, never on the press: a click on the head
  // must leave the panel exactly as the stylesheet drew it (auto height and all), and only a drag freezes a rect.
  const pin = (d) => {
    panel.style.left = `${d.box.x}px`;
    panel.style.top = `${d.box.y}px`;
    panel.style.width = `${d.box.w}px`;
    panel.style.height = `${d.box.h}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.maxHeight = "none";
  };

  const onMove = (e) => {
    if (!press) return;
    const d = press;
    const rawX = e.clientX - d.px;
    const rawY = e.clientY - d.py;
    if (!d.moved) {
      if (Math.hypot(rawX, rawY) < SETTINGS_SLOP) return;
      d.moved = true;
      panel.classList.add(d.kind === "move" ? "is-moving" : "is-sizing");
      pin(d);
    }
    const { vw, vh } = settingsViewport();
    if (d.kind === "move") {
      // The whole window stays inside the viewport: no edge of it is ever left off the screen.
      const x = clamp(d.box.x + rawX / d.z, SETTINGS_EDGE, Math.max(SETTINGS_EDGE, vw - d.box.w - SETTINGS_EDGE));
      const y = clamp(d.box.y + rawY / d.z, SETTINGS_EDGE, Math.max(SETTINGS_EDGE, vh - d.box.h - SETTINGS_EDGE));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      return;
    }
    // The corner: the left and top edges stay put, the floor is the panel's own minimum, and neither dimension is
    // ever asked for LESS than the window already has (a panel taller than the room left would snap on the first
    // pixel of the drag).
    const w = clamp(d.box.w + rawX / d.z, SETTINGS_MIN_W, Math.max(d.box.w, vw - SETTINGS_EDGE - d.box.x));
    const h = clamp(d.box.h + rawY / d.z, SETTINGS_MIN_H, Math.max(d.box.h, vh - SETTINGS_EDGE - d.box.y));
    panel.style.width = `${w}px`;
    panel.style.height = `${h}px`;
  };

  const onUp = () => {
    if (!press) return;
    const d = press;
    press = null;
    panel.classList.remove("is-moving", "is-sizing");
    if (!d.moved) return; // a click: nothing was dragged, so nothing is remembered
    // Store what the clamp actually drew, measured back: a drag past an edge must not remember a rect the window can
    // never have.
    const z = settingsZoom();
    const r = panel.getBoundingClientRect();
    settingsRect = { x: Math.round(r.left / z), y: Math.round(r.top / z), w: Math.round(r.width / z), h: Math.round(r.height / z) };
    writeSettingsRect(settingsRect);
  };

  if (head) head.addEventListener("pointerdown", (e) => onDown(e, "move", head));
  if (grip) grip.addEventListener("pointerdown", (e) => onDown(e, "size", grip));
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  // A window that shrinks under a placed panel must not leave it outside: the clamp that opens it re-runs.
  window.addEventListener("resize", () => placeSettingsWindow());
}

// ---- end settings window

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
  // The window goes back where the reader left it — and inside a window that may have shrunk since — before the
  // focus lands in it, so a restored rect never scrolls the body under the caret.
  placeSettingsWindow();
  // The tab the reader chose is read again on every open (another browser tab can have moved it), so the window
  // opens on the panel they left, not on the one this tab last painted.
  paintSettingsTab(settingsTabKey(), { save: false });
  // The search box is the first control the fixed head keeps on screen and the way to a row on any tab — including
  // the tabs the reader is not on — so it takes the focus. (The font select it used to focus is now inside the
  // Display panel, which is not necessarily the visible one.)
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
  // The reset control names WHICH assistant it acts on, and the roster can have grown since the last snapshot was
  // painted (another tab creates one), so it is read again on every visit — keeping the assistant already chosen.
  paintResetRow();
  // Read the gateway's window every time the panel opens: it can be changed from a CLI, and the
  // panel is not the owner of that value.
  void loadApprovalSetting();
  void loadSessionSetting();
  void loadProviderSetting();
  void loadProviderProfiles();
  void loadModelsSetting();
  // The bridge's own process state, read on the same visit as the rows above: the pid may have died while the tab
  // was closed, and "stopped" must be what the reader sees, not last visit's "running".
  void loadMatrixStatus();
  // The skills inventory is a filesystem walk plus a gateway call, so it is read at boot and then only re-read when
  // the answer is old: a reader opening Settings twice in a minute is not asking the disk the same question again.
  if (Date.now() - skillsLoadedAt > 15000) void loadSkills();
  // The permissions inventory reads config.yaml and asks the gateway, so it gets the same treatment:
  // read once when Settings opens, and again only when the answer is old.
  if (Date.now() - permissionsLoadedAt > 15000) void loadPermissions();
  // The catalogue is a read of two small files, so it gets the same treatment: read once when Settings opens, and
  // again only when the answer is old. A dirty draft in its editor is never replaced by that read.
  if (Date.now() - pipelinesLoadedAt > 15000) void loadPipelines();
  // The bundle and every assistant's queue are two more reads the reader may open this window to see: refresh them
  // when their answer is old, so the tab is current on the first press after a re-export or a task moved elsewhere.
  if (Date.now() - bundlesLoadedAt > 15000) void loadBundles();
  // The push controls are read again on every visit: the project list is the snapshot's, and the resolved pair may
  // have moved since this tab last painted it.
  paintPushPermissions();
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

// ---- saved provider profiles -------------------------------------------------------------------
// A profile is a named (model.base_url, model.api_key) pair the rows above can apply with one press. What
// comes back from the server is the name, the URL and the LAST FOUR of each key: the key itself is read by
// the panel when Apply runs, so it never enters this page. Apply is deliberately not "fill the boxes and
// save": the key would have to come back here to do that, and a second Save with a stale box would then
// write the wrong one.
let providerProfilesCache = null;
// Which option is chosen, kept here rather than read off the <select>: the list is rebuilt on every paint,
// and a rebuilt select would forget the choice made a moment earlier.
let providerProfileChosen = "";

function providerProfiles() {
  return providerProfilesCache?.profiles || [];
}

function selectedProfile() {
  return providerProfiles().find((p) => p.id === providerProfileChosen) || null;
}

function paintProviderProfiles(error = null) {
  const select = $("provider-profile");
  const preview = $("provider-profile-preview");
  const save = $("btn-provider-profile-save");
  const edit = $("btn-provider-profile-edit");
  const drop = $("btn-provider-profile-delete");
  const apply = $("btn-provider-profile-apply");
  const nameBox = $("provider-profile-name");
  if (!select || !preview) return;
  const list = providerProfiles();
  if (providerProfileChosen && !list.some((p) => p.id === providerProfileChosen)) providerProfileChosen = "";
  const editable = Boolean(providerStateCache?.editable);
  select.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = list.length === 0 ? "(none saved yet)" : `(${list.length} saved — pick one)`;
  select.append(blank);
  for (const p of list) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} — ${p.baseUrl}${p.key.set ? ` · ${p.key.masked}` : " · no key"}`;
    select.append(opt);
  }
  select.value = providerProfileChosen;
  const chosen = selectedProfile();
  if (save) save.disabled = !editable;
  if (edit) edit.disabled = !editable || !chosen;
  if (drop) drop.disabled = !chosen;
  if (apply) apply.disabled = !editable || !chosen;
  if (nameBox && chosen && document.activeElement !== nameBox) nameBox.value = chosen.name;
  const where = providerProfilesCache?.file ? ` in ${providerProfilesCache.file}` : "";
  if (error) {
    preview.textContent = `NOT SAVED — ${error}`;
    preview.classList.add("bad");
  } else {
    preview.classList.remove("bad");
    preview.textContent = chosen
      ? `${chosen.name} · ${chosen.baseUrl} · key ${chosen.key.set ? chosen.key.masked : "none"}${where}`
      : list.length
        ? `${list.length} profile${list.length === 1 ? "" : "s"} saved${where} — pick one to Apply, or name the pair above and press Save as`
        : `no profiles saved yet — type a name above and press Save as; keys are kept${where || " in the panel's own state folder"}, never in the repository`;
  }
  preview.title = providerProfilesCache?.file || "";
}

async function loadProviderProfiles() {
  try {
    const r = await apiFetch("/api/settings/provider/profiles");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    providerProfilesCache = d;
    paintProviderProfiles();
  } catch (e) {
    providerProfilesCache = null;
    paintProviderProfiles(e.message);
  }
}

// Save as creates, Edit replaces the chosen record. Both send the boxes exactly as they are, and the server
// treats an empty key box on an Edit as "keep the key already stored" — the reason an Edit that only renames
// a profile cannot silently strip its credential.
async function saveProviderProfile(mode) {
  const chosen = selectedProfile();
  if (mode === "edit" && !chosen) return;
  const nameBox = $("provider-profile-name");
  const preview = $("provider-profile-preview");
  if (!providerStateCache?.editable) return;
  const body = {
    name: (nameBox?.value || "").trim() || (mode === "edit" ? chosen.name : ""),
    baseUrl: $("provider-url")?.value || "",
    apiKey: $("provider-key")?.value || "",
  };
  if (mode === "edit") body.id = chosen.id;
  if (preview) {
    preview.textContent = mode === "edit" ? "updating the profile…" : "saving the profile…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/provider/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      paintProviderProfiles(d.error || `HTTP ${r.status}`);
      return;
    }
    providerProfilesCache = d;
    providerProfileChosen = d.saved?.id || providerProfileChosen;
    if (nameBox && d.saved) nameBox.value = d.saved.name;
    paintProviderProfiles();
    showBanner(d.note || "profile saved");
  } catch (e) {
    paintProviderProfiles(e.message);
  }
}

// Two clicks, like clear key: a profile's key goes with the record, so a stray press must not take it out.
async function deleteProviderProfile(btn) {
  const chosen = selectedProfile();
  if (!btn || !chosen) return;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "delete?";
    btn.classList.add("dirty");
    clearTimeout(btn._disarm);
    btn._disarm = setTimeout(() => {
      btn.dataset.armed = "";
      btn.textContent = "Delete";
      btn.classList.remove("dirty");
    }, 4000);
    return;
  }
  clearTimeout(btn._disarm);
  btn.dataset.armed = "";
  btn.textContent = "Delete";
  btn.classList.remove("dirty");
  try {
    const r = await apiFetch("/api/settings/provider/profiles/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: chosen.id }),
    });
    const d = await r.json();
    if (!r.ok) {
      paintProviderProfiles(d.error || `HTTP ${r.status}`);
      return;
    }
    providerProfilesCache = d;
    providerProfileChosen = "";
    const nameBox = $("provider-profile-name");
    if (nameBox) nameBox.value = "";
    paintProviderProfiles();
    showBanner(d.note || "profile deleted");
  } catch (e) {
    paintProviderProfiles(e.message);
  }
}

// ---- the two restarts: one press, one target, never chained --------------------------------------
// "Restart gateway" and "Restart panel" are separate controls because they are separate operations: each
// queues exactly one restart with its own target and answers at once, and the panel refuses a second
// request while one is still queued rather than folding them together. A press only disables ITSELF for
// the length of its own request, so the other button stays pressable and this page stays up through both.
async function restartFromSettings(target, btn) {
  const preview = $("restart-preview");
  if (btn) btn.disabled = true;
  if (preview) {
    preview.textContent = `queueing a ${target} restart…`;
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        reason: `reader pressed "Restart ${target}" in Settings → Gateway`,
        // No thread of its own: the panel's own default decides which turn has to end first, which is the
        // whole reason the request returns before the restart runs.
        waitFor: null,
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      if (preview) {
        preview.textContent = `${target} restart NOT queued — ${d.error || `HTTP ${r.status}`}`;
        preview.classList.add("bad");
      }
      return;
    }
    const rec = d.restart || {};
    if (preview) {
      preview.classList.remove("bad");
      preview.textContent =
        `${target} restart queued${rec.id ? ` (${rec.id})` : ""} — it runs once ${rec.thread || "the current turn"} has no turn running. ` +
        (target === "panel"
          ? "The gateway keeps running; this page reconnects when the panel is back — reload the tab if it does not."
          : "The panel and this page keep running; runs in flight are interrupted and reported as such.");
    }
    showBanner(`restart queued: ${target}`);
  } catch (e) {
    if (preview) {
      preview.textContent = `${target} restart NOT queued — ${e.message}`;
      preview.classList.add("bad");
    }
  } finally {
    if (btn) btn.disabled = false;
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

// ---- the assistant reset: a dry run, then one real clear ---------------------------------------
// The third control in the Settings gateway restart row (POST /api/assistants/:id/reset, lib/assistant/reset.js).
// It is a control-plane repair, not a chat action: it settles the unknown admission that fences ONE assistant's
// session through the gateway, then drops that assistant's queued wakes and the watches it owns. It keeps the queue,
// the scratchpad, the charter and the thread — and it never starts a run.
//
// Two presses, the same shape `clearProviderKey` uses: the FIRST reads a dry run and paints every row it would
// clear, the SECOND sends the real call. The dry run is the confirmation — a window.confirm cannot show rows — and
// it stays armed for ten seconds rather than four because there is a list to read, not one word. A REFUSAL disarms
// the button: a 409 assistant_live / fence_unclearable refuses before it mutates anything, so a second press could
// only get the same answer.
//
// Five copy states, each painted from the route's own answer (no sentence is composed before a request):
//   dry run   200, ok, dryRun true            — one line per admission, watch and wake, then the keeps line
//   blocked   409 assistant_live              — a run of this assistant's is still executing
//   refused   409 fence_unclearable           — every unknown row is unnameable; nothing local is cleared
//   success   200, ok, dryRun false           — the receipt's outcome, then the resume path
//   incomplete 200, ok false, verdict incomplete — the store is still fenced; the resume path again
// The last two name `hermes --resume <thread>` with the real thread id: a fence the panel cannot move can only be
// entered from a terminal, and the copy has to say so where the reader is standing.
let resetArmTimer = null;
let resetBusy = false;

const resetPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const resetSpan = (ms) => {
  const m = Math.max(0, Math.round(Number(ms) / 60_000));
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

// The roster the select is drawn from, with Assistant #1 as the fallback the float itself uses before the first
// /api/assistant answer lands — the control never says "reset" without saying whose.
function resetRoster() {
  const list = state.assistant?.assistants;
  if (Array.isArray(list) && list.length) return list;
  return [{ id: "assistant-1", name: "Assistant #1", threadId: state.assistantThread || "panel-assistant" }];
}

function resetChosen() {
  const sel = $("reset-assistant");
  const roster = resetRoster();
  const id = String(sel?.value || "");
  return roster.find((a) => String(a.id) === id) || roster[0] || null;
}

function resetDisarm() {
  clearTimeout(resetArmTimer);
  resetArmTimer = null;
  const btn = $("btn-reset-assistant");
  if (!btn) return;
  btn.dataset.armed = "";
  btn.textContent = "Reset assistant";
  btn.classList.remove("dirty");
}

// The select, its options and the button's title. The select is HIDDEN while there is one assistant — the button's
// title and the preview still name it, so nothing is lost — and the chosen id survives a repaint of the roster.
//
// The options are rebuilt only when the ROSTER itself changed: a snapshot arrives every few seconds, and replacing a
// <select>'s children under the reader closes the dropdown they have open. A new title is safe to write every time.
let resetRosterSig = "";
function paintResetRow() {
  const sel = $("reset-assistant");
  const btn = $("btn-reset-assistant");
  if (!sel || !btn) return;
  const roster = resetRoster();
  const sig = roster.map((a) => `${a.id}:${a.name}:${a.threadId}`).join("|");
  if (sig !== resetRosterSig) {
    resetRosterSig = sig;
    const wanted = String(sel.value || "");
    sel.textContent = "";
    for (const a of roster) {
      const opt = document.createElement("option");
      opt.value = String(a.id);
      opt.textContent = String(a.name || a.id);
      opt.title = `${a.name || a.id} · ${a.threadId || ""}`;
      sel.appendChild(opt);
    }
    sel.value = roster.some((a) => String(a.id) === wanted) ? wanted : String(roster[0].id);
  }
  sel.hidden = roster.length < 2;
  const rec = roster.find((a) => String(a.id) === sel.value) || roster[0];
  btn.title =
    `Reset ${rec.name} — settle its gateway turn (the unknown admission that fences ${rec.threadId ?? "its session"}), ` +
    `drop its queued wakes and the watches it owns. Keeps its queue, notes, charter and thread. ` +
    `Two presses: the first shows a dry run, row by row, of exactly what it would clear.`;
  if (btn.dataset.armed !== "1") btn.textContent = "Reset assistant";
}

// The dry run's rows, one per thing it would clear — the whole point of the state is that a count cannot be checked
// against the store. `clear.admissions` names the run, admission, generation, card (or, for a row no card names, the
// store request id the fallback verified) and how long the run has been unknown; `clear.watches` and `clear.wakes`
// are the local half.
function resetDryLines(d, now) {
  const who = `${d.assistant?.name || "this assistant"}${d.assistant?.threadId ? ` · ${d.assistant.threadId}` : ""}`;
  const clear = d.clear || {};
  const admissions = Array.isArray(clear.admissions) ? clear.admissions : [];
  const watches = Array.isArray(clear.watches) ? clear.watches : [];
  const wakes = Array.isArray(clear.wakes) ? clear.wakes : [];
  const unnameable = Array.isArray(d.block?.unnameable) ? d.block.unnameable : [];
  const queued = Array.isArray(d.block?.queued) ? d.block.queued : [];
  const unreadable = Array.isArray(d.block?.unreadable) ? d.block.unreadable : [];
  const keep = d.keep || {};
  const lines = [who];
  if (!admissions.length && !watches.length && !wakes.length) {
    lines.push(d.verdict === "clean" ? "nothing is fenced. Nothing to clear." : "nothing this endpoint can clear.");
  }
  if (admissions.length) {
    lines.push(`would clear ${resetPlural(admissions.length, "admission", "admissions")}:`);
    for (const a of admissions) {
      const bits = [`run ${a.runId}`, `admission ${a.admissionId}`];
      bits.push(a.executionGeneration == null ? "generation null" : `generation ${a.executionGeneration}`);
      if (a.card?.id) bits.push(`card ${a.card.id}${a.card.status ? ` ${a.card.status}` : ""}`);
      if (!a.card?.id && a.evidence?.namedBy === "store-request-id") bits.push("named by its store request id");
      const answers = Array.isArray(a.evidence?.answers) ? a.evidence.answers : [];
      const first = answers.length ? Number(answers[0][0]) : NaN;
      if (Number.isFinite(first)) bits.push(`unknown for ${resetSpan(now - first)}`);
      lines.push(`  · ${bits.join(" · ")}`);
    }
  }
  if (watches.length) {
    const own = watches.filter((w) => w.thread && w.thread === d.assistant?.threadId).length;
    const where = watches.length === 1 ? "" : ` (${own} on its own turn, ${watches.length - own} on workers)`;
    lines.push(`would drop ${resetPlural(watches.length, "watch", "watches")}${where}:`);
    for (const w of watches) lines.push(`  · ${w.thread} — ${w.title}${w.state ? ` (${w.state})` : ""}`);
  }
  if (wakes.length) {
    lines.push(`would drop ${resetPlural(wakes.length, "queued wake", "queued wakes")}:`);
    for (const w of wakes) {
      const age = Number.isFinite(Number(w.ageMs)) ? `, queued ${resetSpan(w.ageMs)} ago` : "";
      lines.push(`  · ${w.reason || "(no reason)"}${w.rule ? ` (rule ${w.rule}${age})` : age ? ` (${age.slice(2)})` : ""}`);
    }
  }
  const q = keep.queue?.rows ?? 0;
  const s = keep.scratchpad || {};
  const c = keep.charter || {};
  lines.push(`keeps: ${resetPlural(q, "queue row", "queue rows")} · ${s.notes ?? 0} notes · ${s.rules ?? 0} rules · charter ${c.chars ?? 0} chars`);
  if (unnameable.length) {
    const rows = unnameable.map((a) => `admission ${a.admissionId} · generation ${a.generation} · seq ${a.seq}`);
    lines.push(
      `blocked: ${resetPlural(unnameable.length, "admission", "admissions")} no card here names (${rows.join("; ")}) — ` +
        `this endpoint can settle an admission only through the run that owns it, so it will clear nothing local and report incomplete.`,
    );
  }
  if (unreadable.length) {
    const rows = unreadable.map((r) => `run ${r.runId}${r.code ? ` (${r.code})` : ""}`);
    lines.push(`unreadable: ${resetPlural(unreadable.length, "card", "cards")} whose run the gateway did not answer — ${rows.join("; ")}`);
  }
  if (queued.length) {
    lines.push(`also: ${resetPlural(queued.length, "turn", "turns")} queued behind the fence will start when it clears (generation ${queued.map((q) => (q.executionGeneration == null ? "null" : q.executionGeneration)).join(", ")}).`);
  }
  // With nothing to clear there is no second press to ask for: the same sentence over an empty list would invite the
  // reader to confirm a reset that clears nothing.
  if (admissions.length || watches.length || wakes.length || unnameable.length) {
    lines.push(
      d.verdict === "blocked"
        ? `press again to reset — it will settle what it can and report incomplete. The rest needs a terminal: hermes --resume ${d.assistant?.threadId || "this session"}`
        : "press again to reset. The settled turn is reported interrupted and is not replayed — resend it if you still want it.",
    );
  }
  return lines;
}

// The five copy states, from the route's answer. `kind` is what a probe asserts on; `bad` is whether the preview
// is painted as a refusal, which is the panel's own class and not a claim about the gateway.
function resetCopyView(body, status, now = Date.now()) {
  const d = body && typeof body === "object" ? body : {};
  const code = String(d.code || "");
  const err = String(d.error || "").trim();
  const who = d.assistant?.name || "the assistant";
  const thread = d.assistant?.threadId || d.thread || "this session";
  const resume = `hermes --resume ${thread}`;

  if (status === 409 && code === "assistant_live") {
    return {
      kind: "blocked",
      bad: true,
      lines: [err || `not reset — ${who} has a run still executing.`, "nothing was cleared — the reset refuses before it mutates anything. Press again once that turn has ended."],
    };
  }
  if (status === 409 && code === "fence_unclearable") {
    const rows = (Array.isArray(d.admissions) ? d.admissions : []).map(
      (a) => `  · admission ${a.admissionId} · generation ${a.generation} · seq ${a.seq} · owner epoch ${a.ownerEpoch}`,
    );
    return { kind: "refused", bad: true, lines: [err || `not reset — the fence on ${thread} is held by an admission no card here names.`, ...(rows.length ? ["the admissions it could not name:", ...rows] : [])] };
  }
  if (status === 200 && d.dryRun === true && d.ok === true) {
    return { kind: "dry", bad: d.verdict === "blocked", lines: resetDryLines(d, now) };
  }
  if (status === 200 && d.ok === true) {
    const cleared = d.cleared || {};
    const admissions = Array.isArray(cleared.admissions) ? cleared.admissions : [];
    const watches = Array.isArray(cleared.watches) ? cleared.watches : [];
    const wakes = Array.isArray(cleared.wakes) ? cleared.wakes : [];
    const receipt = (Array.isArray(d.receipts) ? d.receipts.find((r) => r.ok)?.receipt : null) || {};
    const outcome = receipt.outcome || "interrupted";
    const keep = d.kept || {};
    const q = keep.queue?.rows ?? 0;
    const s = keep.scratchpad || {};
    const c = keep.charter || {};
    return {
      kind: "success",
      bad: false,
      lines: [
        `reset — ${who}: ${resetPlural(admissions.length, "admission", "admissions")} settled (${outcome}; the projection now reads cancelled), ` +
          `${resetPlural(watches.length, "watch", "watches")} dropped, ${resetPlural(wakes.length, "wake", "wakes")} dropped. ` +
          `Kept ${resetPlural(q, "queue row", "queue rows")}, the notes (${s.notes ?? 0} notes, ${s.rules ?? 0} rules) and the charter (${c.chars ?? 0} chars).`,
        "If a panel turn is still refused with 409 permission_denied, the session is the CLI's:",
        `continue it with ${resume}`,
        "the settled turn is reported interrupted and is not replayed — resend it if you still want it.",
      ],
    };
  }
  if (status === 200 && d.ok === false && String(d.verdict || "") === "incomplete") {
    return {
      kind: "incomplete",
      bad: true,
      lines: [
        err || `reset INCOMPLETE — the session ${thread} is still fenced, so nothing local was cleared.`,
        `still fenced — a terminal is the only way into that session now: ${resume}`,
        "resume reopens the conversation; it does not replay the lost turn, so send that prompt again.",
      ],
    };
  }
  return { kind: "error", bad: true, lines: [`reset NOT DONE — ${err || `the panel answered HTTP ${status}`}`] };
}

function paintResetPreview(body, status) {
  const preview = $("reset-preview");
  if (!preview) return null;
  const view = resetCopyView(body, status, Date.now());
  preview.textContent = view.lines.join("\n");
  preview.classList.toggle("bad", view.bad);
  return view;
}

// The press. First: arm, read the dry run, paint it. Second: disarm, send the real call, paint the outcome. Only
// THIS button disables for the length of its own request; the two restart buttons beside it stay pressable.
async function resetAssistant(btn) {
  const rec = resetChosen();
  const preview = $("reset-preview");
  if (!rec || resetBusy) return;
  const armed = btn?.dataset.armed === "1";
  if (!armed) {
    resetDisarm();
    if (btn) {
      btn.dataset.armed = "1";
      btn.textContent = `reset ${rec.name}?`;
      btn.classList.add("dirty");
      btn.disabled = true;
    }
    resetBusy = true;
    resetArmTimer = setTimeout(() => resetDisarm(), 10_000);
    if (preview) {
      preview.textContent = `reading a dry run for ${rec.name}…`;
      preview.classList.remove("bad");
    }
    try {
      const r = await apiFetch(`/api/assistants/${encodeURIComponent(rec.id)}/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true, reason: `reader pressed "Reset ${rec.name}" in Settings → Gateway` }),
      });
      const d = await r.json().catch(() => ({}));
      paintResetPreview(d, r.status);
      // A refusal is final for this arm: the route refuses before it mutates anything, so the second press would
      // ask the same question and get the same answer.
      if (!r.ok || !d.ok) resetDisarm();
    } catch (e) {
      if (preview) {
        preview.textContent = `reset NOT READ — ${e.message}`;
        preview.classList.add("bad");
      }
      resetDisarm();
    } finally {
      resetBusy = false;
      if (btn) btn.disabled = false;
    }
    return;
  }

  resetDisarm();
  resetBusy = true;
  if (btn) btn.disabled = true;
  if (preview) {
    preview.textContent = `resetting ${rec.name}…`;
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(`/api/assistants/${encodeURIComponent(rec.id)}/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: `reader pressed "Reset ${rec.name}" in Settings → Gateway` }),
    });
    const d = await r.json().catch(() => ({}));
    const view = paintResetPreview(d, r.status);
    if (view?.kind === "success") showBanner(`reset: ${rec.name}`);
    else if (view?.kind === "incomplete") showBanner(`reset incomplete: ${rec.name}`);
    else if (view?.kind === "blocked" || view?.kind === "refused") showBanner(`reset refused: ${rec.name}`);
  } catch (e) {
    if (preview) {
      preview.textContent = `reset NOT DONE — ${e.message}`;
      preview.classList.add("bad");
    }
  } finally {
    resetBusy = false;
    if (btn) btn.disabled = false;
    paintResetRow();
  }
}
// ---- end the assistant reset

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

// ---- the Matrix bridge ------------------------------------------------------------------------
// A PROCESS, not a setting. The bridge is a standalone Python program (Matrix + E2EE + the Hermes CLI), and this
// tab starts and stops it without learning anything about the protocol: every fact drawn here came back from
// GET /api/settings/matrix, and the page never sees a credential — `credentialsPresent` is a boolean.
//
// The liveness rule the whole block turns on: a pid FILE is not a process. The server asks the OS about the pid it
// recorded, so a record a crash left behind reads as `stalePid` and never as running; the row says so, and Start is
// offered again.
//
// Polling is on the page's existing 30 s clock (the safety-net resync below), never a timer of this block's own: a
// second interval for one row is exactly the kind of thing that turns a quiet page into a busy one.
let matrixState = null;
let matrixBusy = "";
// The markup's own title, kept once so a disabled control can carry its reason without losing what it does.
const MATRIX_TITLES = {};
function matrixTitle(id) {
  const el = $(id);
  if (!el) return "";
  if (!MATRIX_TITLES[id]) MATRIX_TITLES[id] = el.title;
  return MATRIX_TITLES[id];
}

function matrixSettingsShowing() {
  const panel = $("settings");
  if (!panel || panel.classList.contains("hidden")) return false;
  // The tab strip's own record, not a second selector: `settingsTabPanels` is what the page uses to decide which
  // one is drawn, so this cannot disagree with it about which tab is on screen.
  const gateway = settingsTabPanels().find((p) => p.dataset.settingsGroup === "gateway");
  return Boolean(gateway && !gateway.hidden);
}

function paintMatrix(note = "", bad = false) {
  const s = matrixState;
  if (!s) return;
  const dot = $("matrix-dot");
  if (dot) {
    dot.classList.toggle("ok", Boolean(s.running));
    dot.classList.toggle("bad", !s.running && (!s.scriptPresent || !s.pythonPresent));
    dot.classList.toggle("warn", !s.running && Boolean(s.scriptPresent && s.pythonPresent && s.stalePid));
    dot.title = s.running
      ? `running as pid ${s.pid}`
      : s.stalePid
        ? `not running — pid ${s.stalePid} was left behind and that process is gone`
        : "not running";
  }
  const stateEl = $("matrix-state");
  if (stateEl) {
    stateEl.textContent = matrixBusy || (s.running ? `running · pid ${s.pid}` : s.stalePid ? "stopped · stale pid" : "stopped");
  }
  const roomEl = $("matrix-room");
  if (roomEl) {
    const bits = [
      s.roomId ? `room ${s.roomId}` : "NO ROOM SET — Start and Run self-test refuse until the Room field below has an !id:server address",
      s.credentialsPresent ? "bridge.env present" : "bridge.env missing — the bridge will refuse to log in",
      s.autoStart ? "auto-start with the panel on" : "auto-start with the panel off",
    ];
    if (s.running) bits.push(`pid ${s.pid}`);
    else if (s.stalePid) bits.push(`pid ${s.stalePid} is stale — a stale record is not a running bridge`);
    if (s.boot && s.boot.note) bits.push(`boot: ${s.boot.note}`);
    roomEl.textContent = bits.join(" · ");
    roomEl.title = roomEl.textContent;
  }
  // The four fields the save route owns. A focused input is never overwritten under the reader's cursor, and the
  // save's answer is this same state, so a repaint after a save shows what the server actually stored.
  const fields = { "matrix-script-path": s.scriptPath, "matrix-python-path": s.pythonPath, "matrix-room-id": s.roomId };
  for (const [id, value] of Object.entries(fields)) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = value || "";
  }
  const auto = $("matrix-autostart");
  if (auto) auto.checked = Boolean(s.autoStart);
  const pathsEl = $("matrix-paths");
  if (pathsEl) {
    pathsEl.textContent = `pid file ${s.pidFile || "(not derived)"} · log ${s.logFile || "(not derived)"}`;
    pathsEl.title = "The panel's own pid file and log. The four fields above are the only matrix settings this page writes; these two paths are derived from the panel's state folder.";
  }
  const start = $("btn-matrix-start");
  if (start) {
    const why = s.running
      ? `already running as pid ${s.pid} — press Stop first`
      : !s.scriptPath
        ? "no bridge script configured — set matrix.scriptPath in config.json"
        : !s.scriptPresent
          ? `the script is not at ${s.scriptPath} — set matrix.scriptPath in config.json`
          : !s.pythonPath
            ? "no interpreter configured — set matrix.pythonPath in config.json"
            : !s.pythonPresent
              ? `the interpreter is not at ${s.pythonPath} — set matrix.pythonPath in config.json`
              : !s.roomId
                ? "no room set — put the bridge's room in the Room field below (an !id:server address) and press Save"
                : null;
    start.disabled = Boolean(why) || Boolean(matrixBusy);
    start.title = why ? `${matrixTitle("btn-matrix-start")} — UNAVAILABLE: ${why}` : matrixTitle("btn-matrix-start");
  }
  const stop = $("btn-matrix-stop");
  if (stop) {
    // Never disabled: it is safe with nothing running, and a button that vanishes when a pid file lies is the one
    // the reader needs. A live pid makes the press meaningful.
    stop.disabled = Boolean(matrixBusy);
    stop.title = s.running
      ? `${matrixTitle("btn-matrix-stop")} — now: pid ${s.pid}`
      : `${matrixTitle("btn-matrix-stop")} — nothing is running right now, so the press reports that and clears any stale pid file.`;
  }
  const test = $("btn-matrix-test");
  if (test) {
    test.disabled = Boolean(matrixBusy) || !s.scriptPresent || !s.pythonPresent;
    test.title = !s.scriptPresent || !s.pythonPresent
      ? `${matrixTitle("btn-matrix-test")} — UNAVAILABLE: the script or interpreter is not on disk, so the test could not run`
      : matrixTitle("btn-matrix-test");
  }
  const preview = $("matrix-preview");
  if (preview) {
    const st = s.selfTest || {};
    const summary = st.ok === true
      ? `self-test passed${st.at ? ` (${new Date(st.at).toLocaleTimeString()})` : ""}`
      : st.ok === false
        ? `self-test FAILED${st.exitCode == null ? "" : ` — exit ${st.exitCode}`}`
        : "self-test has not been run in this panel — press Run self-test";
    // A boot spawn that failed is the one line this block must never swallow: it happened before the page was
    // open, so nothing else would ever say it.
    const bootLine = s.boot && s.boot.error ? `AUTO-START FAILED at boot — ${s.boot.error}` : "";
    const head = bad ? `NOT DONE — ${note}` : note ? `${note}\n${summary}` : summary;
    preview.textContent = [bootLine, head].filter(Boolean).join("\n");
    if (st.output) preview.textContent += `\n${st.output}`;
    preview.classList.toggle("bad", Boolean(bad) || st.ok === false || Boolean(s.boot && s.boot.error));
    preview.title = "The last --self-test this panel ran, everything it printed, and a boot spawn that failed.";
  }
  const logEl = $("matrix-log");
  if (logEl) {
    const lines = Array.isArray(s.log) ? s.log : [];
    logEl.textContent = lines.length ? lines.join("\n") : "no output yet — the bridge's stdout and stderr land here once it is started";
    logEl.title = s.logFile ? `the last 40 lines of ${s.logFile}` : "the panel's own log file";
  }
}

async function loadMatrixStatus() {
  try {
    const r = await apiFetch("/api/settings/matrix");
    matrixState = await r.json();
    paintMatrix();
  } catch (e) {
    const preview = $("matrix-preview");
    if (preview) {
      preview.textContent = `could not read the Matrix bridge's state: ${e.message}`;
      preview.classList.add("bad");
    }
  }
}

async function matrixPress(route, busy, timeoutMs = 20000) {
  if (matrixBusy) return;
  matrixBusy = busy;
  paintMatrix();
  let settled = false;
  try {
    const r = await apiFetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, { timeoutMs });
    const d = await r.json().catch(() => ({}));
    matrixBusy = "";
    settled = true;
    // Every answer carries the state, refusals included — a 409 while a live pid exists must leave the row saying
    // exactly what it said before, with the refusal's own words beside it.
    if (typeof d.running === "boolean") matrixState = d;
    if (!r.ok) {
      paintMatrix(d.error || `HTTP ${r.status}`, true);
      return;
    }
    const done = route.endsWith("/start") ? "started" : route.endsWith("/stop") ? d.note || "stopped" : "self-test finished";
    paintMatrix(d.note && !route.endsWith("/start") ? d.note : done);
  } catch (e) {
    matrixBusy = "";
    settled = true;
    paintMatrix(e.message, true);
  } finally {
    // A throw after the busy flag was cleared must not leave the buttons dead.
    if (!settled) matrixBusy = "";
  }
}

// The save the four fields write through. One POST, one answer: the route replies with the GET shape, so the block
// repaints from what the server stored rather than from what was typed. A refusal (a field the route does not
// accept, a config.json another process holds open) keeps the typed values on screen with the reason beside them,
// because silently reverting a field the reader just edited is how a save gets pressed twice.
async function matrixSave() {
  if (matrixBusy) return;
  // Read the four fields BEFORE the busy repaint. paintMatrix() refills every input from the last state the server
  // sent, and pressing this button has already moved the focus off them — reading after that repaint would save what
  // the panel already had and silently drop the edit. (Measured in a browser probe: the room field was cleared, Save
  // was pressed, and the answer came back with the old room.)
  const body = {
    scriptPath: $("matrix-script-path")?.value ?? "",
    pythonPath: $("matrix-python-path")?.value ?? "",
    roomId: $("matrix-room-id")?.value ?? "",
    autoStart: Boolean($("matrix-autostart")?.checked),
  };
  matrixBusy = "saving…";
  paintMatrix();
  try {
    const r = await apiFetch("/api/settings/matrix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    matrixBusy = "";
    if (typeof d.running === "boolean") matrixState = d;
    if (!r.ok) {
      paintMatrix(d.error || `HTTP ${r.status}`, true);
      return;
    }
    paintMatrix(d.note || "saved");
  } catch (e) {
    matrixBusy = "";
    paintMatrix(e.message, true);
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
    retireTextStyleSize(kind);
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
// The tab strip is painted at load, not when the panel opens: the panel the reader chose last time must be the one
// in the DOM before anything can flash the wrong tab. The search box is wired here too, on an empty box, so the
// panel is never filtered by a query left in the DOM.
initSettingsTabs();
initSettingsSearch();
// The skills inventory is filled before the tab is ever opened: the settings search counts the rows on EVERY tab, so
// a Skills tab that only reads when it is selected would answer "no matches" for a skill the reader can plainly see
// after one press. It is a filesystem walk on the server, not a page render.
void loadSkills();
// Same reason for the permissions list: the search counts its rows too, and it must be there before the first press.
void loadPermissions();
// And the pipeline catalogue: its rows are searched and counted on every tab's badge, so it is read before the tab is
// opened rather than when it is selected.
void loadPipelines();
// The Bundles tab's rows are searched and counted too — the bundle's pipelines and the queue tasks — so both reads
// happen at boot. Its task rows open the existing task pipeline window; initBundlesPanel wires that one press.
void loadBundles();
initBundlesPanel();
// And the release notes: CHANGELOG.md at the panel root is the answer to "what changed since my build", and it is
// read before the tab is opened for the same reason the other tabs are — the settings search counts every tab.
void loadChangelog();
// The window's own gestures: the head drags it, the corner grip sizes it, and the rect is remembered in this browser.
initSettingsWindow();
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

// ---- the folders the board scans ---------------------------------------------------------------
// One row per folder the panel walks — the path, whether it is still there, and a ✕ — with an input that adds one.
// The list is this panel's own config.json (`scanRoots`) written through POST /api/settings/scan-roots, which
// re-discovers BEFORE it answers: adding a folder puts its repos on the board without a restart, and the board draws
// one expandable card per folder with that folder's path as the title.
//
// An EMPTY list is legal and is the fallback: the folder this panel's own checkout sits in. The line under the list
// says so and names the folder, because a blank list over a board that still shows projects is otherwise a mystery.
function scanRootsConfigured() {
  const list = state.settings?.scanRootsConfigured;
  return Array.isArray(list) ? list.map((p) => String(p || "")).filter(Boolean) : [];
}

// The sentence for an empty list: which folder is being scanned instead. The server names it (it is the one that
// derived the fallback), and the page only has to say it in the reader's terms.
function scanRootsFallbackSentence() {
  const p = String(state.settings?.scanRootsFallbackPath || "");
  return p
    ? `no folder named — the board scans ${p}, the folder this panel's own checkout sits in`
    : "no folder named — the board scans the folder this panel's own checkout sits in";
}

function paintScanRoots(note = "", bad = false) {
  const list = scanRootsConfigured();
  const holder = $("scan-roots");
  if (holder) {
    holder.innerHTML = list.length
      ? list
          .map((p) => {
            const d = state.scanRootsDetail.get(p.toLowerCase());
            const exists = d ? d.exists : null;
            const chip = exists == null ? "" : `<span class="settings-root-chip${exists ? "" : " bad"}">${exists ? "exists" : "missing"}</span>`;
            return `<div class="settings-root" data-scan-root="${esc(p)}">
              <span class="mono settings-root-path" title="${esc(p)}">${esc(p)}</span>${chip}
              <button type="button" class="settings-root-x" data-scan-root-remove="${esc(p)}" title="stop scanning ${esc(p)} — the projects under it leave the board">\u2715</button>
            </div>`;
          })
          .join("")
      : `<div class="settings-root-empty">no folder named</div>`;
  }
  const count = $("scan-roots-count");
  if (count) count.textContent = list.length ? `${list.length} folder${list.length === 1 ? "" : "s"}` : "fallback";
  const preview = $("scan-roots-preview");
  if (preview) {
    preview.textContent = bad
      ? `NOT SAVED — ${note}`
      : note
        ? note
        : state.settings?.scanRootsFallback
          ? `${scanRootsFallbackSentence()} · set in config.json (scanRoots), so it applies to every browser and survives a restart`
          : `one card per folder on the board · set in config.json (scanRoots), so it applies to every browser and survives a restart`;
    preview.classList.toggle("bad", bad);
  }
}

// A `settings` event (or a snapshot) from another browser can move the list, and whether each folder still exists is
// the server's to stat: one cheap read of /api/config refills both, rather than the tab inferring a folder's state.
async function refreshScanRootsAnswer() {
  try {
    const cfg = await apiFetch("/api/config").then((r) => r.json());
    applyScanRootsAnswer(cfg);
    paintScanRoots();
  } catch {
    /* the list keeps what it had; the next settings event tries again */
  }
}

async function saveScanRoots(next) {
  const preview = $("scan-roots-preview");
  if (preview) {
    preview.textContent = "saving, then re-scanning the folders…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/scan-roots",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roots: next }) },
      { timeoutMs: 60000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    applyScanRootsAnswer(d);
    paintScanRoots();
    const n = Array.isArray(d.scanRootsConfigured) ? d.scanRootsConfigured.length : 0;
    showBanner(
      n
        ? `folders scanned: ${n} — ${d.projects == null ? "re-reading the board" : `${d.projects} project${d.projects === 1 ? "" : "s"} found`}`
        : `folders scanned: none named — ${d.scanRootsFallbackPath || "the panel's own parent folder"}`,
    );
    // The board is drawn from the snapshot the route broadcasts; this repaint is the page that asked for it, so it
    // does not have to wait for the round trip.
    renderAll();
    return true;
  } catch (err) {
    paintScanRoots(String((err && err.message) || err), true);
    return false;
  }
}

async function addScanRootFromInput() {
  const input = $("scan-root-input");
  const typed = String(input?.value || "").trim();
  if (!typed) {
    paintScanRoots("type the path of a folder to add", true);
    return;
  }
  // The server decides whether it is a folder, whether it is absolute and whether it is already listed; the page only
  // sends the list it means and shows the sentence it gets back.
  const ok = await saveScanRoots([...scanRootsConfigured(), typed]);
  if (ok && input) input.value = "";
}

$("btn-scan-root-add")?.addEventListener("click", () => void addScanRootFromInput());
$("scan-root-input")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void addScanRootFromInput();
});
$("scan-roots")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-scan-root-remove]");
  if (!btn) return;
  const gone = String(btn.dataset.scanRootRemove || "").toLowerCase();
  void saveScanRoots(scanRootsConfigured().filter((p) => p.toLowerCase() !== gone));
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

// ---- how long a collapsed parent stays a decision about everything under it -----------------------
// `collapseAfterSeconds` lives in this panel's config.json (POST /api/settings/collapse-after), like the age
// threshold above: one number for every browser, and it survives a restart. The timers themselves are the page's own
// (state.collapseTimers, public/app.js's collapse cascade), so this only decides how long each one waits — and a
// number that moves applies to the NEXT collapse, never to a clock already running.
// ---- Settings → General: what the panel costs, and what a turn costs ---------------------------
// One pane for the two halves of the same bill: the scan numbers decide how many git processes the panel spawns
// while you read it, and the briefing budget decides how much text one assistant turn carries into the provider.
// Painted from the snapshot's settings, which the server sends whole, so a second tab agrees without a reload.
function generalSentence(s = {}) {
  const threads = Number(s.threads);
  const cadence = Number(s.worktreeSeconds);
  const budget = Number(s.briefingBudgetChars) || 0;
  const scan =
    Number.isFinite(threads) && Number.isFinite(cadence)
      ? `${threads} scan worker${threads === 1 ? "" : "s"} re-reading a row every ${cadence}s`
      : "scan settings unknown";
  return `${scan} · ${budget ? `a turn appends at most ${budget} chars` : "a turn is sent whole (budget off)"}`;
}

function paintGeneralSettings(s = state.settings || {}) {
  const put = (id, value) => {
    const el = $(id);
    if (el && String(el.value) !== String(value)) el.value = String(value);
  };
  put("general-threads", Number(s.threads) || 0);
  put("general-worktree", Number(s.worktreeSeconds) || 0);
  put("general-budget", Number(s.briefingBudgetChars) || 0);
  const preview = $("general-preview");
  if (preview) preview.textContent = generalSentence(s);
}

// One POST for one number: the route applies both scan knobs live (the pool is rebuilt, the cadence written into
// the scheduler) and forwards the budget to the assistant's own settings, so nothing here needs a restart.
async function saveGeneralSettings(patch, label) {
  try {
    const r = await apiFetch(
      "/api/settings/general",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
      { timeoutMs: 10000 },
    );
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    state.settings = { ...(state.settings || {}), ...(out.settings || {}) };
    paintGeneralSettings(state.settings);
    const fw = $("f-worktree");
    if (fw && state.settings.worktreeSeconds) fw.textContent = String(state.settings.worktreeSeconds);
    showBanner(`${label}: ${generalSentence(state.settings)}`);
  } catch (e) {
    showBanner(`Cannot save ${label}: ${e.message}.`);
    paintGeneralSettings(state.settings || {});
  }
}

for (const [id, key, label] of [
  ["general-threads", "threads", "scan workers"],
  ["general-worktree", "worktreeSeconds", "row refresh"],
  ["general-budget", "briefingBudgetChars", "turn briefing budget"],
]) {
  $(id)?.addEventListener("change", () => {
    const n = Number($(id).value);
    if (!Number.isFinite(n)) return paintGeneralSettings(state.settings || {});
    void saveGeneralSettings({ [key]: n }, label);
  });
}
for (const b of document.querySelectorAll("[data-general-threads]")) {
  b.addEventListener("click", () => {
    const n = Number(b.getAttribute("data-general-threads"));
    $("general-threads").value = String(n);
    void saveGeneralSettings({ threads: n }, "scan workers");
  });
}
for (const b of document.querySelectorAll("[data-general-worktree]")) {
  b.addEventListener("click", () => {
    const n = Number(b.getAttribute("data-general-worktree"));
    $("general-worktree").value = String(n);
    void saveGeneralSettings({ worktreeSeconds: n }, "row refresh");
  });
}
for (const b of document.querySelectorAll("[data-general-budget]")) {
  b.addEventListener("click", () => {
    const n = Number(b.getAttribute("data-general-budget"));
    $("general-budget").value = String(n);
    void saveGeneralSettings({ briefingBudgetChars: n }, "turn briefing budget");
  });
}

const COLLAPSE_AFTER_MAX_UI = 3600;

function collapseAfterStored() {
  const n = Number(state.settings?.collapseAfterSeconds);
  return Number.isFinite(n) && n >= 0 ? Math.min(COLLAPSE_AFTER_MAX_UI, Math.round(n)) : COLLAPSE_CASCADE_DEFAULT_SECONDS;
}

function collapseAfterSentence(seconds) {
  return seconds > 0
    ? `a parent left collapsed for ${seconds} second${seconds === 1 ? "" : "s"} minimizes every card under it`
    : "a collapsed parent leaves its cards as they are — the cascade is off";
}

function paintCollapseAfterSetting(note = "", bad = false) {
  const stored = collapseAfterStored();
  const input = $("collapse-after");
  // A rejected save leaves what was typed in the box: snapping back to the stored number reads as "it saved that",
  // when the save is exactly what failed.
  if (input && !bad && document.activeElement !== input) input.value = String(stored);
  const preview = $("collapse-after-preview");
  if (!preview) return;
  const live = input && document.activeElement === input ? Math.round(Number(input.value)) : stored;
  const seconds = Number.isFinite(live) && live >= 0 ? Math.min(COLLAPSE_AFTER_MAX_UI, live) : stored;
  const bits = [
    `${collapseAfterSentence(seconds)} · set in config.json, so it applies to every browser and survives a restart`,
    "opening the parent before the time is up cancels its clock, and opening it never un-minimizes a card",
  ];
  preview.textContent = bad
    ? `NOT SAVED - ${note}. config.json still says: ${collapseAfterSentence(stored)}.`
    : note
      ? `${note} - ${bits.join(" · ")}`
      : bits.join(" · ");
  preview.classList.toggle("bad", bad);
}

async function saveCollapseAfterSetting(seconds) {
  const stored = collapseAfterStored();
  const want = Number(seconds);
  const n = Number.isFinite(want) ? Math.max(0, Math.min(COLLAPSE_AFTER_MAX_UI, Math.round(want))) : stored;
  const preview = $("collapse-after-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/collapse-after",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seconds: n }),
      },
      { timeoutMs: 10000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings.collapseAfterSeconds = Number.isFinite(Number(d.seconds)) ? Number(d.seconds) : n;
    paintCollapseAfterSetting(collapseAfterSentence(state.settings.collapseAfterSeconds));
    showBanner(collapseAfterSentence(state.settings.collapseAfterSeconds));
  } catch (err) {
    paintCollapseAfterSetting(String((err && err.message) || err), true);
  }
}

$("collapse-after")?.addEventListener("change", (e) => void saveCollapseAfterSetting(e.target.value));

// ---- the push guard's own state -------------------------------------------------------------------
// The TWO CONTROLS live in Settings → Repo and on each card (see the push-permissions region below); this block is
// the other half of the same panel: whether the pre-push guard is in the path at all, which trees carry it, and how
// many are waiting on you. The old global `remoteBranchPolicy` select is gone — its three values are now one pair of
// four-way controls — but the guard report still says which files the hook reads.
function paintRemotePolicy(note = "", bad = false) {
  const preview = $("remote-policy-preview");
  if (!preview) return;
  const g = state.remoteGuards;
  const last = g?.latest?.[0];
  const block = pushBlock();
  const projects = block?.projects ? Object.values(block.projects) : [];
  const free = projects.filter((p) => p.newBranches !== "always-ask" || p.existingBranches !== "always-ask").length;
  const bits = [
    block ? `push controls: ${free}/${projects.length} project(s) go through without asking something — the pair is on each card, the defaults in Settings → Repo` : "push controls: reading…",
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
    showBanner(`push guard: ${d.installed} worktree(s) now read the project's push controls and act on them${failed ? ` · ${failed} could not be installed` : ""}`);
  } catch (err) {
    paintRemotePolicy(`could not install the push guard: ${String((err && err.message) || err)}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$("btn-guard-install")?.addEventListener("click", (e) => {
  e.preventDefault();
  void installPushGuardNow(e.target);
});

// ---- push permissions: the two controls, drawn on every card and in Settings → Repo -------------------
// Four values, identical for both controls, and one resolver on the server that already decided what every project's
// pair IS: `state.settings.pushPermissions.projects[name]` carries the resolved pair, whether a repo force-override
// is in force, and where each value came from. This half only draws and posts. A page that re-derived precedence
// could disagree with the guard that refuses the push, which is the failure the single resolver exists to prevent.
//
// The card's two selects ride the grey remote-mapping row: between that row's line and its `host` field, so the pair
// is read beside the remote it governs instead of on a band of its own. The row is drawn while the host chip's editor
// is open, so the selects appear with the mapping. When the project's repository carries a force-override they render
// DISABLED with a one-line note naming it: a select that looks editable and is not is a lie, and a note is the only
// honest way to show a control somebody else owns.
const PUSH_FALLBACK = {
  choices: ["allow-all", "allow-name-gate", "always-ask", "never"],
  labels: {
    "allow-all": "allow all — push without asking",
    "allow-name-gate": "allow the name gate — ask for anything else",
    "always-ask": "always ask — park on the box",
    never: "never — refuse, no box",
  },
};

const pushBlock = () => state.settings?.pushPermissions || null;
const pushChoices = () => pushBlock()?.choices || PUSH_FALLBACK.choices;
const pushLabels = () => pushBlock()?.labels || PUSH_FALLBACK.labels;
const pushFor = (name) => pushBlock()?.projects?.[name] || null;

// One <option> list, shared by the card and the Settings tab, so the two can never offer different values.
function pushOptionsHtml(selected) {
  const labels = pushLabels();
  return pushChoices()
    .map((v) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(labels[v] || v)}</option>`)
    .join("");
}

// The card's pair. `p.forced` is the server's answer, not a guess from the repo record: the same resolver that
// writes the guard's files says whether this project is under its repository's force-override.
function pushControlsHtml(name) {
  const p = pushFor(name);
  const forced = p?.forced === true;
  const dis = forced ? " disabled" : "";
  const note = forced
    ? `<span class="push-repo-note" title="${esc(`these two selects are set by ${p.repoLabel || p.repo || "this project's repository"} (force-override is on) — the Settings → Repo tab owns them for every project in that repository`)}">repo setting in force</span>`
    : "";
  return (
    `<span class="push-controls" data-push-controls="${esc(name)}">` +
    `<label class="push-field" title="${esc("a branch that does not exist on the remote yet. allow-name-gate lets one through without asking only when its name is main/master or YYYYMMDD_HHMM_<TICKET>_<desc>.")}">new <select class="push-select" data-push-project="${esc(name)}" data-push-kind="new"${dis}>${pushOptionsHtml(p?.newBranches)}</select></label>` +
    `<label class="push-field" title="${esc("a branch the remote already carries. this is also the control a landing merge's push of the base branch meets.")}">existing <select class="push-select" data-push-project="${esc(name)}" data-push-kind="existing"${dis}>${pushOptionsHtml(p?.existingBranches)}</select></label>` +
    note +
    `</span>`
  );
}

// Re-write the card's pair in place after a settings event, so a value saved in another tab (or by the permission
// box's Always allow) does not need a full board render. Rebuilding only when the markup CHANGED keeps the select
// the reader is on from being replaced under them.
function syncPushControls() {
  for (const strip of document.querySelectorAll("[data-push-controls]")) {
    const name = strip.dataset.pushControls || "";
    if (!name) continue;
    const html = pushControlsHtml(name);
    if (strip._pushHtml !== html) {
      strip.innerHTML = html;
      strip._pushHtml = html;
    }
  }
}

// The Settings → Repo tab: one collapsible section per remote repository, in the order the server names them. Each
// section holds the two defaults and the force-override; the projects it governs are listed so a default is never
// anonymous. `pushRepoFolds` is null until a rebuild has something to read, so the FIRST paint opens every section
// that holds a project and a later repaint keeps the reader's own folds instead of re-opening them.
const PUSH_REPO_ORDER = ["git.sefl.com/IT", "git.sefl.com/SA", "github/JLRoper", "other", "none"];
let pushRepoFolds = null;

function pushRepoFoldsNow() {
  const holder = $("push-repo-sections");
  if (!holder) return null;
  const sections = [...holder.querySelectorAll("details[data-push-repo-section]")];
  if (!sections.length) return null;
  const open = new Set(sections.filter((d) => d.open).map((d) => d.dataset.pushRepoSection || ""));
  open.delete("");
  return open;
}

function pushRepoSectionHtml(key, rec) {
  const label = rec?.label || key;
  const force = rec?.force === true;
  const projects = Array.isArray(rec?.projects) ? rec.projects : [];
  const open = pushRepoFolds ? pushRepoFolds.has(key) : projects.length > 0;
  const projectsLine = projects.length
    ? `${projects.length} project${projects.length === 1 ? "" : "s"}: ${projects.join(" · ")}`
    : key === "none"
      ? "no project on this board has no remote at all — this section exists so one would have somewhere to say so"
      : "no project on this board resolves to this repository yet";
  return (
    `<details class="settings-repo" data-push-repo-section="${esc(key)}"${open ? " open" : ""}>` +
    `<summary class="settings-repo-head" title="${esc(`${label} — ${projectsLine}`)}">` +
    `<span class="settings-repo-name">${esc(label)}</span>` +
    `<span class="settings-repo-count mono">${projects.length} project${projects.length === 1 ? "" : "s"}</span>` +
    `${force ? `<span class="settings-repo-force mono">force-override</span>` : ""}` +
    `</summary>` +
    `<div class="settings-repo-body">` +
    `<label class="settings-row" title="${esc("the default for a NEW branch in this repository: one that does not exist on the remote yet. A project's own answer on its card wins unless the force-override is on.")}">` +
    `<span>New branches</span><select data-push-repo="${esc(key)}" data-push-repo-kind="new">${pushOptionsHtml(rec?.newBranches)}</select></label>` +
    `<label class="settings-row" title="${esc("the default for an EXISTING branch in this repository: one the remote already carries. A landing merge's push of the base branch meets this one.")}">` +
    `<span>Existing branches</span><select data-push-repo="${esc(key)}" data-push-repo-kind="existing">${pushOptionsHtml(rec?.existingBranches)}</select></label>` +
    `<label class="settings-remote settings-repo-force-row" title="${esc("on: this repository's two values are in force for EVERY project in it, and each project's selects render disabled with a note. never still wins over everything, including this toggle.")}">` +
    `<input type="checkbox" data-push-force="${esc(key)}"${force ? " checked" : ""}>` +
    `<span class="settings-remote-name">force these values for every project in this repository</span>` +
    `</label>` +
    `<div class="settings-preview mono settings-repo-list" title="${esc(projectsLine)}">${esc(projectsLine)}</div>` +
    `</div></details>`
  );
}

function paintPushPermissions(note = "", bad = false) {
  const holder = $("push-repo-sections");
  const block = pushBlock();
  const count = $("push-permissions-count");
  const help = $("push-permissions-help");
  if (count) {
    const projects = block?.projects ? Object.values(block.projects) : [];
    const open = projects.filter((p) => p.newBranches !== "always-ask" || p.existingBranches !== "always-ask").length;
    const never = projects.filter((p) => p.newBranches === "never" || p.existingBranches === "never").length;
    count.textContent = block ? `${open}/${projects.length} without asking${never ? ` · ${never} refused outright` : ""}` : "…";
  }
  if (help) {
    help.textContent = bad
      ? `NOT SAVED — ${note}. The server still holds the values below.`
      : `${note ? `${note} · ` : ""}allow-name-gate passes main/master or YYYYMMDD_HHMM_<TICKET>_<desc>; anything else asks. never refuses with no box and beats every other value, force-override included.`;
    help.classList.toggle("bad", Boolean(bad));
  }
  if (!holder) return;
  if (!block) {
    holder.innerHTML = `<div class="settings-remote-empty">reading the push controls…</div>`;
    holder._pushSig = "";
    return;
  }
  // A snapshot carries the settings every few seconds, so the sections are rebuilt only when the DATA moved. A
  // rebuild replaces every select under the reader — the one whose dropdown is open included — and a tab that
  // repaints on a clock is a tab nobody can use.
  const sig = JSON.stringify([block.repos || {}, block.projects || {}]);
  if (holder._pushSig === sig) return;
  holder._pushSig = sig;
  const folds = pushRepoFoldsNow();
  if (folds) pushRepoFolds = folds;
  holder.innerHTML = PUSH_REPO_ORDER.map((key) => pushRepoSectionHtml(key, block.repos?.[key] || { key, label: key })).join("");
  if (bad) paintPushRepoFocus();
}

// The section that failed keeps the reader where they were: a rebuild that drops the focus makes a keyboard reader
// start the tab over on every refusal.
function paintPushRepoFocus() {
  const held = document.activeElement?.dataset || {};
  const key = held.pushRepo || held.pushForce || "";
  if (!key) return;
  const back = document.querySelector(`[data-push-repo="${CSS.escape(key)}"], [data-push-force="${CSS.escape(key)}"]`);
  if (back) back.focus();
}

// The repo sections' own controls. The answer carries the whole settings block back, so both this tab and every card
// repaint from the server's copy rather than from what the page thinks it just saved.
async function savePushRepo(repo, patch) {
  try {
    const r = await apiFetch("/api/settings/push-repo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }, { timeoutMs: 20000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings = { ...(state.settings || {}), ...(d.settings || {}) };
    paintPushPermissions(d.note || "saved");
    syncPushControls();
    showBanner(d.note || `push controls saved for ${repo}`);
  } catch (err) {
    // A failed save is not a setting: the server's copy is what the tab draws again, with the refusal on its own line.
    paintPushPermissions(String((err && err.message) || err), true);
    syncPushControls();
  }
}

async function saveProjectPush(name, kind, value) {
  try {
    const r = await apiFetch(
      "/api/settings/push-project",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: name, kind, value }) },
      { timeoutMs: 20000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings = { ...(state.settings || {}), ...(d.settings || {}) };
    paintPushPermissions(d.note || "saved");
    syncPushControls();
    showBanner(d.note || `${name}: ${kind} branches ${value}`);
  } catch (err) {
    paintPushPermissions(String((err && err.message) || err), true);
    syncPushControls();
  }
}

document.addEventListener("change", (e) => {
  const project = e.target.closest ? e.target.closest("[data-push-project]") : null;
  if (project) {
    void saveProjectPush(project.dataset.pushProject, project.dataset.pushKind, project.value);
    return;
  }
  const repo = e.target.closest ? e.target.closest("[data-push-repo-kind]") : null;
  if (repo) {
    void savePushRepo(repo.dataset.pushRepo, { repo: repo.dataset.pushRepo, kind: repo.dataset.pushRepoKind, value: repo.value });
    return;
  }
  const force = e.target.closest ? e.target.closest("[data-push-force]") : null;
  if (force) void savePushRepo(force.dataset.pushForce, { repo: force.dataset.pushForce, force: force.checked === true });
});

// A fold is a rendering preference, not a setting: it is remembered for this page's lifetime only, and never posted.
// `toggle` does not bubble, so this listens in the capture phase.
$("push-repo-sections")?.addEventListener(
  "toggle",
  (e) => {
    const d = e.target.closest ? e.target.closest("details[data-push-repo-section]") : null;
    if (!d) return;
    const now = pushRepoFoldsNow();
    if (now) pushRepoFolds = now;
  },
  true,
);
// ---- end push permissions

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
// The 🌊 default. Same shape as the 🧠 row above: the switch is the answer for a card that never made one, and the
// per-card button (its own `wtgui.stream.<thread>`) still wins — so only the cards with no key are repainted here.
$("stream-default")?.addEventListener("change", (e) => {
  try {
    localStorage.setItem(STREAM_KEY, e.target.checked ? "1" : "0");
  } catch {
    /* private mode: the default just will not persist */
  }
  for (const c of conversations()) {
    let own = null;
    try {
      own = localStorage.getItem(`${STREAM_KEY}.${c.thread}`);
    } catch {
      /* ignore */
    }
    if (own === null) renderConversation(c.thread);
  }
});
// Whether the card draws the 🌊 at all — its own switch, its own key, saved the same way as the row above. Every card
// is repainted (not just the ones with no per-session answer) because the button's PRESENCE changes, not its state.
$("show-stream-button")?.addEventListener("change", (e) => {
  try {
    localStorage.setItem(SHOW_STREAM_KEY, e.target.checked ? "1" : "0");
  } catch {
    /* private mode: the default just will not persist */
  }
  for (const c of conversations()) renderConversation(c.thread);
});
$("term-weight-select")?.addEventListener("change", (e) => applyTermStyle({ save: true, weight: e.target.value }));

// The approval window. A preset only fills the box and lights Save: one click here rewrites the
// user's global Hermes config, so it takes a deliberate second one.
$("btn-approval-save")?.addEventListener("click", () => void saveApprovalSetting());
// The bridge's three presses. Each posts once and repaints from the answer; Start is the only one the server can
// refuse with a live pid (409), and Stop is deliberately always pressable — nothing running is a sentence, not an error.
$("btn-matrix-start")?.addEventListener("click", () => void matrixPress("/api/settings/matrix/start", "starting…", 30000));
$("btn-matrix-stop")?.addEventListener("click", () => void matrixPress("/api/settings/matrix/stop", "stopping…", 30000));
// The self-test runs a whole Python process whose own budget is 45 s, so the page's deadline is longer than it.
$("btn-matrix-test")?.addEventListener("click", () => void matrixPress("/api/settings/matrix/test", "running self-test…", 60000));
// The four settings fields save through the one route, which answers with the read's own shape so the block
// repaints from what was stored. Enter in any of them saves too: the row is a form in everything but markup.
$("btn-matrix-save")?.addEventListener("click", () => void matrixSave());
for (const id of ["matrix-script-path", "matrix-python-path", "matrix-room-id"]) {
  $(id)?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void matrixSave();
    }
  });
}
$("btn-session-limit-save")?.addEventListener("click", () => void saveSessionSetting());
$("btn-provider-save")?.addEventListener("click", () => void saveProviderSetting());
$("btn-provider-clear")?.addEventListener("click", (e) => void clearProviderKey(e.currentTarget));
$("provider-profile")?.addEventListener("change", (e) => {
  providerProfileChosen = e.target.value || "";
  paintProviderProfiles();
});
$("btn-provider-profile-save")?.addEventListener("click", () => void saveProviderProfile("new"));
$("btn-provider-profile-edit")?.addEventListener("click", () => void saveProviderProfile("edit"));
$("btn-provider-profile-delete")?.addEventListener("click", (e) => void deleteProviderProfile(e.currentTarget));
$("btn-provider-profile-apply")?.addEventListener("click", () => void applyProviderProfile());
$("provider-profile-name")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void saveProviderProfile("new");
});
// Two controls, two handlers, one target each: nothing here reaches both processes in one action.
$("btn-restart-gateway")?.addEventListener("click", (e) => void restartFromSettings("gateway", e.currentTarget));
$("btn-restart-panel")?.addEventListener("click", (e) => void restartFromSettings("panel", e.currentTarget));
// The reset's two presses. Changing the assistant disarms a press armed for the previous one: the confirm copy and
// the armed label belong to the assistant they were produced for.
$("btn-reset-assistant")?.addEventListener("click", (e) => void resetAssistant(e.currentTarget));
$("reset-assistant")?.addEventListener("change", () => {
  resetDisarm();
  paintResetRow();
});
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
if ($("stream-default")) $("stream-default").checked = streamDefault();
if ($("show-stream-button")) $("show-stream-button").checked = showStreamButton();
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
    // The folders list's own half of that answer: what config.json says, the fallback's folder, and whether each
    // listed folder is still on disk.
    applyScanRootsAnswer(cfg);
    $("f-worktree").textContent = cfg.worktreeSeconds;
    paintGeneralSettings(cfg);
    $("f-slow").textContent = cfg.slowSeconds;
    paintConfigLine();
    // Deliberately no seeding of state.projects from cfg.projects here: before discovery has
    // run that list is only the config fallback, and a project seeded that way can never be
    // removed by a later snapshot (heroes-js showed up forever this way on a machine that does
    // not have it). The first snapshot paints the real set.
    await resync();
    // NO promotion on boot. A restored-open section is not a click: this loop used to POST /api/project/open for
    // every project the reader had ever left expanded, and each one promotes an old repo into a full re-probe and a
    // full row read. A boardful of restored sections therefore re-read the whole old fleet on EVERY reload, and
    // because the route answers before the read runs, nothing in the page felt slow while the server drowned. The
    // promotion signal is the reader's own click: toggleProject() reports the section they actually unfold. A
    // restored section keeps the rows it already has until then, which is what it showed before the gate existed.
    connect();
    startAnchorObserver();
    updateColorsRow();
    paintAnchorSettings();
    paintTopSetting();
    paintCollapseAfterSetting();
    paintChartColumns();
    paintScanRoots();
    paintRemotePolicy();
    paintPushPermissions();
    syncPushControls();
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
