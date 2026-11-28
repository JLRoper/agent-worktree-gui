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
// turnAttachmentsHtml, turnPeekLine, compactHtml, peekHtml, refreshTurnPeek), and the display switch
// (thinkingOn, setThinking and its default). That is step 4 of
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
  originHtml, originAttributionHtml, isWatchdogTurn, watchdogHtml, watchdogPromptText, messageHtml, messagePromptText, sessionReplacedHtml,
  turnHead, inlinePrompt, displayPrompt, turnAttachmentsHtml, turnPeekLine, firstSentence, compactHtml, peekHtml,
  refreshTurnPeek,
  THINK_KEY, thinkDefault, thinkingOn, setThinking,
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
  RING_C, noteScan, eventLifeAt, lifeAtFor, ringState, ringOffset, ringStroke, lifeCellHtml, paintLifeCell,
  nextReadLabel, nextReadCellHtml, paintNextReadCell,
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

// ---- the board's shared scaffolding lives in public/board-scaffold.js, and is re-exported here ----------------
//
// The board's element builders and the panel wiring every remaining surface shares were cut out of this file into
// public/board-scaffold.js: the panel map and the liveness reads (panelMap, agentsFor, knownThreads, turnLive,
// approvalLive, convLive, panelFor, isRowLive), the row's chip strip and its badge (hermesTitle, sigChips,
// paintRowChips, livenessLines, agentBadgeHtml, repaintAgentState), the project header's counts and its host strip
// (headTitle, chipsHtml, hostChipHtml, hostPanelHtml, repaintHostPanel, proposeHostMapping, saveHostMapping), the
// row's detail block and the TODO strip inside it (gitSubHtml, descLines, todoBlockHtml and the painters), and the
// card the row's own refresh opens (refreshOfferHtml, paintRefreshOffer, paintRefreshOffers, clearRefreshOffer).
// That is item 2 of "The remaining lane" in docs/reports/module-map-2026-11-08.html, and it was a move, not a
// rewrite: nothing was renamed and no call site changed. public/board-scaffold.js is a classic script the shell
// loads after render-jobs.js and before this one, so its top-level declarations are page-wide and every bare name
// here is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for any
// module that would rather reach it than a page global.
window.WMApp.scaffold = {
  panelMapCache, panelMap, invalidatePanelMap, agentsByPathCache, threadRowKeyCache, agentsByPath, agentsFor,
  knownThreads, LIVE_STATUS, TERMINAL_STATUS, turnLive, approvalLive, convLive, agentsRunning, isAgentRunning, panelFor, isRowLive,
  hermesTitle, sigChips, paintRowChips, livenessLines, agentBadgeHtml, repaintAgentState,
  headTitle, chipsHtml, hostChipHtml, hostPanelHtml, repaintHostPanel, proposeHostMapping, saveHostMapping,
  RULES_FALLBACK_CAPS, rulesCaps, rulesFor, rulesBarOpen, rulesChipSig, rulesChipHtml, refreshRulesChip,
  TURNOVER_FALLBACK_MAX, turnoverMaxChars, turnoverFor, turnoverBarOpen, turnoverChipSig, turnoverChipHtml,
  refreshTurnoverChip, turnoverLine, turnoverBarHtml, toggleTurnoverBar, closeTurnoverBar, saveProjectTurnover,
  turnoverKinds, turnoverKindLabel, turnoverKindShort, turnoverKindSentence, turnoverPolicySentence,
  turnoverPolicies, turnoverPolicyFor, turnoverPolicyLabel, turnoverPolicyLine, saveProjectTurnoverPolicy,
  boardOf, boardBarOpen, boardChipSig, boardChipHtml, refreshBoardChip, boardLine, boardBarHtml,
  toggleBoardBar, closeBoardBar,
  cleanupOf, cleanupRuns, cleanupChipSig, cleanupChipHtml, refreshCleanupChip, refreshCleanupUi, cleanupBarHtml,
  cleanupRowHtml, cleanupTreeName, runCleanupChip, answerCleanupCall, closeCleanupBar,
  cleanupDropAllBusy, cleanupDropAllSig, cleanupDropAllButtonHtml, refreshCleanupDropAll, cleanupDropAllBlockHtml,
  openCleanupDropAllConfirm, closeCleanupDropAllConfirm, runCleanupDropAll,
  barsOf, setBarOrder, openBar, closeBar, barHtml, barSelector, projectBarsHtml, repaintBars, repaintBar,
  ruleRowHtml, rulesLine, rulesBarHtml, toggleRulesBar, closeRulesBar, setRules, saveProjectRules,
  addRule, editRule, moveRule, deleteRule,
  gitSubHtml, DESC_SENTENCE_BREAK, descLines, TODO_GLYPH, todoAge, todoOldest, todoLine, todoPeekFor,
  repaintTodoBlock, todoBlockHtml, refreshClock, detailHtml,
  refreshOfferHtml, paintRefreshOffer, paintRefreshOffers, clearRefreshOffer,
};

// ---- the approval dock and the permission box live in public/board/approvals.js, and are re-exported here --------
//
// The approval surface was cut out of this file into public/board/approvals.js: the permission box every parked
// question is drawn in and its choices table, the one-flight answer per request, a run's own question and its
// answer path, the dock's list with the gestures that walk the reader to the agent that asked, and the panel's own
// remote-write permission with its receipts, its review and its clock. That is cut 1 of the eight in
// docs/reports/module-separation-2026-11-28.html's card for this file, and it was a move, not a rewrite: nothing
// was renamed and no call site changed. public/board/approvals.js is a classic script the shell loads before this
// one, so its top-level declarations are page-wide and every bare name here is the same binding it was before the
// move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for the files
// that already reach for them (public/render-jobs.js reads approvalPrompt and approvalDecided, public/settings.js
// and public/core/sse.js read renderApprovals, public/core/permissions-history.js reads the two choice tables).
window.WMApp.approvals = {
  APPROVAL_CHOICE_LABEL, approvalFlights, approvalFlightKey, approvalInFlight, approvalCardsFor, paintApprovalFlight,
  permissionBoxHtml, APPROVAL_CLOSED_HEAD, approvalClosedNote, approvalUnanswerableNote, approvalPrompt, approvalDecided,
  answerRunApproval, closeApprovalCard, APPROVAL_LABEL, APPROVALS_FOLDED_KEY, approvalThreadsShown, approvalsFolded,
  approvalAgentName, approvalCard, DECIDED_TTL_MS, DECIDED_SHOWN, remoteWriteBoxHtml, remoteWriteDecidedHtml,
  reviewAgentName, remoteWriteReviewHtml, rwGroupHtml, renderApprovals, revealAgentHome, rwAgentFor, rwUnresolved,
  dockNote, dockGoto, keepReview, unwindReview, tickApprovals, approvalSent, approvalKey, approvalAlreadySent,
  noteApprovalSent, answerApproval, answerRemoteWrite,
};

// ---- the reply box's queue and its send and steer paths live in public/board/replies.js, and are re-exported here ----
//
// The reply queue was cut out of this file into public/board/replies.js: the one place a sent draft is cleared from
// all three stores, the session's own prompts that Up steps back through, the held reply and its write-through, the
// queue's offers and waits, the ghost editor and the click-away that can only revert it, and sendReply and steerTurn.
// That is cut 2 of the eight in docs/reports/module-separation-2026-11-28.html's card for this file, and it was a
// move, not a rewrite: nothing was renamed and no call site changed. public/board/replies.js is a classic script the
// shell loads before this one, so its top-level declarations are page-wide and every bare name here is the same
// binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for the files
// that already reach for them (public/render-jobs.js reads the queue's wait phrases and the ghost card,
// public/render-projects.js, public/assistant.js and public/core/sse.js read captureTyping, and core/sse.js reads
// the held-reply loaders too).
window.WMApp.replies = {
  clearSentDraft, captureTyping, turnPrompts, queueReply, postHeldReply, cancelHeldReply, retryHeldReply,
  heldRepliesLoaded, loadHeldReplies, acceptHeldReply, applyHeldReplies, queueReplyFromBox, queuePressInFlight,
  queueWaitingOn, queueWaitPhrase, pressSettled, paintQueueWait, queueOfferedFor, steerOfferedFor, steerFromBox,
  replyQueued, queuedEditFor, ghostTurnHtml, openQueuedEdit, saveQueuedEdit, cancelQueuedEdit, takeQueuedReply,
  revertEditOnClickAway, heldReplyBlocked, markReplySent, replyTakenByDrain, cancelQueuedReply, childrenOut,
  threadBusy, drainReplyQueue, heldIdFor, sendReply, steerTurn,
};

// ---- the add-agent bar, the model picker and the spawn recovery live in public/board/spawn.js, re-exported here ----
//
// The spawn surface was cut out of this file into public/board/spawn.js: the name a tree is called on the board, the
// shell-style history both composers recall, a settled card's Continue / re-attach / ask-complete controls, the inline
// add-agent bar, the one model list every model field is built from, and the recovery that lands the reader on the
// card a spawn has just made. That is cut 3 of the eight in docs/reports/module-separation-2026-11-28.html's card for
// this file, and it was a move, not a rewrite: nothing was renamed and no call site changed. public/board/spawn.js is a
// classic script the shell loads before this one, so its top-level declarations are page-wide and every bare name here
// is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for the files
// that already reach for them (public/board-scaffold.js reads addAgentBarHtml and panelAgentsByPath,
// public/assistant.js reads modelOptionHtml and jumpToAgent, public/settings.js reads syncProjectPicker,
// public/render-projects.js reads isProjectRootRow and treeTitleOf, and public/render-jobs.js reads CONTINUE_TEXT).
window.WMApp.spawn = {
  loadTreeNames, saveTreeNames, isProjectRootRow, treeTitleOf, loadSpawnHistory, saveSpawnHistory,
  rememberSpawnPrompt, recallSpawnPrompt, recallReply, CONTINUE_TEXT, continueThread, reattachCard, askComplete,
  markChipAsked, probeWorktreeAgents, addAgentBarHtml, swapAddAgentBox, openAddAgent, closeAddAgent, submitAddAgent,
  modelsState, modelOptionHtml, renderModelPicker, loadModels, syncProjectPicker, selectedProject, updateSpawnNote,
  focusSpawn, formValues, panelAgentsByPath, rowsInBoardOrder, topAgentOf, jumpToPanelAgent, jumpToAgent, findTurnStar,
  landOnSpawnedCard, revealSpawnedAgent, reviveSession,
};

// ---- the tree list, its delete and rename, and the child tree's cut live in public/board/worktrees.js ----------------
//
// The worktree surface was cut out of this file into public/board/worktrees.js: what the server says about the tree list
// this snapshot carries, the row's own lookups and the two homeless-card kinds, the delete and its confirm, the reader's
// lock, the rename by hand, the + that cuts a child from the ROW's branch with the dialog that asks which kind and where
// it starts, and the R or I that lifts a local-only kind. That is cut 4 of the eight in
// docs/reports/module-separation-2026-11-28.html's card for this file, and it was a move, not a rewrite: nothing was
// renamed and no call site changed. public/board/worktrees.js is a classic script the shell loads before this one, so
// its top-level declarations are page-wide and every bare name here is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for the files that
// already reach for them (public/render-projects.js reads applyTreeList and deletableWithoutAsking, public/render-jobs.js
// reads the homeless-card helpers, public/settings.js and public/core/sse.js read applyTreeList too).
window.WMApp.worktrees = {
  TREE_LIST_ORDER_HOLD_MS, TREE_LIST_ORDER_SETTLE_MS, rowOrderHold, paintTreeListChips,
  applyTreeList, treeListComplete, rowForOwner, isPendingScanConv, isHomelessConv, homelessConversations,
  pendingScanConversations, worktreeOptionsHtml, startTurnoverContainer, deletableWithoutAsking, showWorktreeConfirm, scanTick, waitForScanPass,
  confirmDeleteWorktree, toggleWorktreeLock, rowConfirmSent, answerRowConfirm, renameWorktreePrompt, childPresses,
  cutDialog, closeCutDialog, cutDialogHtml, openCutDialog, cutSubmit, cutChildTree, kindConfirmEls, kindConfirmOf,
  closeKindConfirm, showKindConfirm, confirmKindLift,
};

// ---- the merge control, its chooser and the row's own cells live in public/board/merge.js, and are re-exported here ---
//
// The merge surface and the row cells were cut out of this file into public/board/merge.js: the UNMERGED chip with the
// label that says a merge agent already works that tree, the base a rebase lands on, the verdict badge, the chooser that
// picks between a rebase and a merge into the parent, start-merge, and the row's branch, base, ahead/behind, PR and owner
// cells with the note that says how a PR was matched. That is cut 5 of the eight in
// docs/reports/module-separation-2026-11-28.html's card for this file, and it was a move, not a rewrite: nothing was
// renamed and no call site changed. public/board/merge.js is a classic script the shell loads before this one, so its
// top-level declarations are page-wide and every bare name here is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for the files that
// already reach for them (public/render-projects.js reads the five cells, public/board-scaffold.js reads ownerDetailHtml,
// public/core/branch-link.js reads branchCellHtml and public/core/waves-lane.js reads ownerTagOf).
window.WMApp.merge = {
  mergeInFlight, mergePress, mergeAgentLabel, checkAgentLabel, baseBranchOf, rebaseTargetOf, verdictHtml,
  mergeParentOf, mergeChooserTitle, mergeChooser, closeMergeChooser, openMergeChooser, chooseMergeOutcome, startMerge,
  prMatchNote, baseChipHtml, branchCellHtml, vsMainLine, aheadBehindCellHtml, prCellHtml, ownerNameOf, ownerLabelOf,
  ownerRoleOf, ownerTagOf, ownerCellHtml, ownerDetailHtml,
};

// ---- the liveness ranking, the reading anchor and the board's hygiene live in public/board/anchor.js ---------------
//
// The ranking and the anchor were cut out of this file into public/board/anchor.js: the sliding average every "life"
// figure is built on and the windows it prunes, the one ranked sequence advanced a tick at a time, the contexts each
// scope ranks on, the seeding that makes the first paint the smoothed order, the ticks that move the order, the project
// hue, the anchor flag and its seconds, the flash durations, the compensation that keeps a repaint from jumping, and the
// board sweep that holds the reader's place. That is cut 6 of the eight in
// docs/reports/module-separation-2026-11-28.html's card for this file, and it was a move, not a rewrite: nothing was
// renamed and no call site changed. public/board/anchor.js is a classic script the shell loads before this one, so its
// top-level declarations are page-wide and every bare name here is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for the files that
// already reach for them (public/render-projects.js ranks rows with orderedByRank and seeds with seedRankWindows,
// public/charts.js and public/core/sse.js report events through noteEventLife, public/core/theme-hue.js reads and writes
// the project hue, and public/board/spawn.js reads the flash and the anchor baseline).
window.WMApp.anchor = {
  lifeRowKey, lifeProjKey, lifeAgentKey, rankWindowMs, pushEventLife, rankWindowCount, rankScore, pruneRankWindows,
  rankIdealOrder, tickRankedOrder, orderedByRank, rowRankCtx, projectRankCtx, folderRankCtx, agentRankCtx,
  seedRankWindows, seedProjectRank, tickRowScope, tickAgentScopes, tickProjectScopes, tickLivenessRanks,
  reorderAgentCards, noteEventLife,
  loadProjectHues, saveProjectHues, rollProjectHue, updateColorsRow, loadAnchorFlag, saveAnchorFlag, loadAnchorSeconds,
  loadRankSeconds, saveAnchorSeconds, loadAnchorThread, saveAnchorThread, setAnchorThread, toggleAnchorPin, readingTop,
  nearestReadingLine, anchorVisible, anchorCardFor, loadFlashSeconds, saveFlashSeconds, FLASH_BASE_SECONDS, flashScale,
  flashRowMs, flashProjectMs, flashRingMs, anchorHoverMs, anchorTouchMs, anchorNodeFor, boardTargetOf, sameAnchorTarget,
  projectBarVisible, intentAnchorNode, readingAnchor, anchorState, anchorScrollY, lastAnchorScrollAt, anchorRepickTimer,
  anchorMuteUntil, refreshAnchorBaseline, anchorBusy, scheduleAnchorCompensation, compensateAnchor, anchorObserver,
  trackAnchorIntent, startAnchorObserver, boardSweepQueued, boardAnchor, captureBoardAnchor, holdAnchor,
  scheduleBoardSweep, sweepStaleBoard,
};

// ---- the chart's column widths, the fit and the grips live in public/board/columns.js, and are re-exported here -----
//
// The column machinery was cut out of this file into public/board/columns.js: what this browser remembers about the
// chart's columns, the header cells, the natural width of each column, the plan that fits them into the room the page
// has, the signatures that keep a fit from running twice, and the grip on each header edge. That is cut 7 of the eight
// in docs/reports/module-separation-2026-11-28.html's card for this file, and it was a move, not a rewrite: nothing was
// renamed and no call site changed. public/board/columns.js is a classic script the shell loads before this one, so its
// top-level declarations are page-wide and every bare name here is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for the files that
// already reach for them (public/charts.js reads columnPlan, public/render-projects.js reads fitColumns and
// scheduleColumnFit, and public/settings.js reads fitAllColumns).
window.WMApp.columns = {
  COL_WIDTHS_KEY, COL_WIDTHS_INSERTIONS, loadColWidths, colWidths, saveColWidths, headerCells, naturalColumnWidths,
  columnPlan, WT_SCROLL, fitTarget, columnSigs, columnSignature, fitColumns, pendingFits, fitScheduled,
  scheduleColumnFit, fitAllColumns, colDrag, installColumnGrips,
};

// ---- the Settings window lives in public/settings-window.js, and is re-exported here --------------------------------
//
// The window was cut out of this file into public/settings-window.js: the tab strip, the release notes, the settings
// search, the Skills tab, Permissions, pipeline, bundles, the window's own place and size, the provider endpoint and its
// saved profiles, the two restarts, the model prices and ratings, the assistant reset, the approval window, the Matrix
// bridge, the small rows (reorder clock, rank window, session list, fonts, the question box's look), the folders the
// board scans, the agent-cleanup switch and the initiative tier. That is cut 8 of the eight in
// docs/reports/module-separation-2026-11-28.html's card for this file, and it was a move, not a rewrite: nothing was
// renamed and no call site changed. public/settings-window.js is a classic script the shell loads before this one, so
// its top-level declarations are page-wide and every bare name here is the same binding it was before the move.
//
// This object is the re-export, under the same names: one door for the later steps of the split, and for the files that
// already reach for them (public/assistant.js reads selectSettingsTab and toggleSettings, and public/settings.js reads
// the provider and reset painters).
window.WMApp.settingsWindow = {
  SETTINGS_TAB_KEY, SETTINGS_TABS_ID, settingsTabButtons, settingsTabPanels,
  settingsTabKey, saveSettingsTab, paintSettingsTab, selectSettingsTab,
  paintSettingsTabCounts, initSettingsTabs, RELEASE_NOTES_ID, RELEASE_NOTES_SOURCE_ID,
  RELEASE_NOTES_ROW_ID, changelogIndex, changelogLoadedAt, changelogLoading,
  changelogWhen, changelogBytes, releaseNotesSectionHtml, releaseNotesList,
  paintChangelog, loadChangelog, SETTINGS_SEARCH_ID, SETTINGS_SEARCH_CLEAR_ID,
  SETTINGS_SEARCH_HIGHLIGHT, settingsRowText, paintSettingsRows, paintSkillsSearchState,
  paintSettingsSearch, paintSettingsSearchHighlight, clearSettingsSearch, initSettingsSearch,
  SKILLS_PANEL_ID, SKILLS_SEARCH_ID, SKILLS_SEARCH_CLEAR_ID, SKILLS_GROUPS_KEY,
  SKILLS_OPEN_CATEGORIES, SKILLS_KIND_LABEL, skillsIndex, skillsLoadedAt,
  skillsLoading, skillsKind, skillsMany, readSkillsFolds,
  saveSkillsFolds, skillsFoldRecord, skillsSourceOpen, skillsCategoryOpen,
  setSkillsFold, skillsFoldTitle, skillsByName, skillsCategories,
  skillsRowHtml, skillsCategoryHtml, skillsSourceHtml, initSkillsGroups,
  skillsSetCount, paintSkillsSearch, paintSkillsNoHits, focusSkillsSearch,
  initSkillsSearch, paintSkills, loadSkills, PERMISSIONS_PANEL_ID,
  permissionsIndex, permissionsLoadedAt, permissionsLoading, permissionsRows,
  permissionsBad, permissionStatusText, permissionsGroupHtml, paintPermissions,
  paintPermissionsSearch, loadPermissions, PIPELINE_PANEL_ID, pipelinesIndex,
  pipelinesLoadedAt, pipelinesLoading, pipelineOpenId, pipelineDraft,
  pipelineDraftDirty, pipelineFindings, pipelineExitChecks, pipelinePdlId,
  pdlPipelines, selectedPdlPipeline, setPipelinePdlNote, pdlPickNote,
  paintPipelineMapLink, pdlOptionLabel, loadPipelines, pipelineDroppedHtml,
  pipelineOptionLabel, pdlPipelineRowHtml, paintPdlPipelines, repairPipelineBundle,
  paintPipelines, selectPipelineTab, openPipelineFlow, openPdlFlow,
  openPipelineEditor, closePipelineEditor, setPipelineStatus, paintPipelineFindings,
  pipelineStageHtml, paintPipelineEditor, markPipelineDraftDirty, wirePipelineStages,
  pipelineFocusBeforeRepaint, restorePipelineFocus, paintPipelineStages, wirePipelineEditor,
  updateDraftFromForm, addPipelineStage, removePipelineStage, savePipelineEditor,
  paintPipelineSearch, BUNDLES_PANEL_ID, bundlesIndex, bundlesLoadedAt,
  bundlesLoading, bundleQueues, bundleQueuesAt, bundleQueuesError,
  bundleTaskPlace, bundlePipelineRowHtml, bundleTaskRowHtml, paintBundles,
  paintBundleTasks, paintBundlesSearch, loadBundles, bundleImportChosen,
  initBundlesPanel, SETTINGS_RECT_KEY, SETTINGS_MIN_W, SETTINGS_MIN_H,
  SETTINGS_EDGE, SETTINGS_SLOP, settingsZoom, settingsViewport,
  readSettingsRect, writeSettingsRect, settingsRect, clampSettingsRect,
  placeSettingsWindow, initSettingsWindow, toggleSettings, providerStateCache,
  paintProviderSetting, loadProviderSetting, saveProviderSetting, clearProviderKey,
  providerProfilesCache, providerProfileChosen, providerProfiles, selectedProfile,
  paintProviderProfiles, loadProviderProfiles, saveProviderProfile, deleteProviderProfile,
  restartFromSettings, modelsSetting, modelListAgeText, snapshotDate,
  modelAgeText, paintModelsSetting, loadModelsSetting, refreshModels,
  resetArmTimer, resetBusy, resetPlural, resetSpan,
  resetRoster, resetChosen, resetDisarm, resetRosterSig,
  paintResetRow, resetDryLines, resetCopyView, paintResetPreview,
  resetAssistant, approvalState, humanWindow, paintApprovalSetting,
  loadApprovalSetting, saveApprovalSetting, matrixState, matrixBusy,
  MATRIX_TITLES, matrixTitle, matrixSettingsShowing, paintMatrix,
  loadMatrixStatus, matrixPress, matrixSave, paintReorderSetting,
  saveReorderSetting, paintRankWindow, saveRankWindow, sessionsState,
  paintSessionSetting, loadSessionSetting, saveSessionSetting, initFonts,
  initQLook, scanRootsConfigured, scanRootsFallbackSentence, paintScanRoots,
  refreshScanRootsAnswer, saveScanRoots, addScanRootFromInput, agentCleanupStored,
  paintAgentCleanup, initiativeTierStored, paintInitiativeTier,
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
  // The Active bolt's amber ring on a card: held here, not only on the DOM node, because opening a project or a
  // row repaints the card and a class added to the old element dies with it. The renderer re-applies it until the
  // window closes.
  hotFlash: { thread: null, until: 0 },
  hotFlashTimer: null,
  // The Hot Agent search's ring on ONE TURN: `{thread, id, until}`, held in state for the same reason hotFlash is -
  // opening the row or a repaint rebuilds the card, and a class put on the old element dies with it (the renderer's
  // `turnBlock` re-applies this one until the window closes). flashHotCard says WHICH CARD; this says WHICH TURN.
  haHit: { thread: null, id: null, until: 0 },
  haHitTimer: null,
  // The HOT AGENTS marker's rotation: the agent the last press landed on, and the list signature that press last
  // painted. The list itself is sampled on every paint (it is `state.jobs`, which the snapshot and every job frame
  // keep current), so a turn that ends between two presses can never leave a stale entry behind - only the key is
  // remembered.
  hot: { key: null, sig: "", on: null },
  projects: new Map(),
  // Handle for the board-reorder clock, which the settings row can re-arm at another cadence.
  reorderTimer: null,
  // The card a jump just landed on, so the highlight survives the repaint a running card gets on every
  // job event (a class added to the node is gone the moment the node is replaced).
  jumpThread: null,
  rows: new Map(),
  // The tree list this page is drawing, and whether it is the CACHED one (lib/tree-cache.js): `cached` while any row is
  // still a placeholder from the file, `completedAt` the moment a scan enumerated every project's tree list. Both the
  // row rule (isHomelessConv) and the cached chip read this one object, which the server sends with every snapshot, so
  // the page's claim and the rows can never disagree.
  treeList: null,
  // The row order is HELD across the cached first paint and the scan that replaces it: a board that re-ranks under the
  // reader mid-scan is the jump this cache exists to remove. `rowOrderHoldUntil` is the deadline, `settled` stops the
  // hold being extended forever by later snapshots (see applyTreeList).
  rowOrderHoldUntil: 0,
  rowOrderHoldSettled: false,
  expanded: new Set(),
  // Focus mode: a double-click on the top header bar narrows the board to the worktrees a live panel is working in
  // (see the focus-mode section below the listeners). `focusSig` is the kept tree set as it was last painted, so a
  // job starting or finishing repaints the board once rather than once per event.
  focusMode: false,
  focusSig: "",
  // The REVIEW lane's filter: true while the table is narrowed to the rows awaiting a review (the header's review
  // count is what toggles it). It is a second narrowing beside focus mode and the chart's top N, and it overrides
  // both - see tableHidesRow in the focus-mode section.
  reviewMode: false,
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
  // The grey strip under a project's head is a STACK of bars now, and the host bar is one of them. `bars` holds each
  // project's open bar kinds in the order they were opened (rendered newest first); `rulesBar` is the rules bar's own
  // edit state, and `ruleCaps` the two limits `/api/project-rules` answered with (null until the first read).
  // `turnoverBar` is the same editor state for the turnover branch, `turnoverCaps` its one cap, and
  // `turnoverPolicies` / `turnoverPolicyLabels` the policy select's ids and words (both null until the first read),
  // with `turnoverKinds` / `turnoverKindLabels` the kind select's ids and the words lib/base-ref-kind.js gives them.
  bars: new Map(),
  rulesBar: null,
  ruleCaps: null,
  turnoverBar: null,
  turnoverCaps: null,
  turnoverPolicies: null,
  turnoverPolicyLabels: null,
  turnoverKinds: null,
  turnoverKindLabels: null,
  spawn: {},
  paused: false,
  es: null,
  events: 0,
  eventsAt: 0,
  lastEventAt: null,
  lastTransportAt: null,
  lastSnapshotAt: null,
  snapshotGeneration: 0,
  awaitingStreamSnapshot: true,
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
  // The threads a Queue reply press is still IN FLIGHT on: set when the press takes the text and cleared when it
  // settles, whatever the outcome. Only this closes the card - a reply being held does not, because the reader
  // may hold several separate messages and the box has to stay open for the next one.
  replyPress: new Map(),
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
  // The fixed cards the reader has folded or unfolded themselves (localStorage, `wm.fixedChosen`). A card that
  // is not in this set has no choice recorded, so it keeps its shipped default (see FIXED_DEFAULT_COLLAPSED)
  // rather than whatever class the last paint left in the DOM.
  fixedChosen: loadFixedChosen(),
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
  // Which host each folder's clone row last chose, by scan root. Kept on state because a snapshot repaint rebuilds
  // every folder section; the dropdown is drawn from this, and the list itself comes from state.hosts (lib/hosts.js).
  cloneHost: {},
  // Roots where the reader has picked a host themselves. A typed coordinate may only move the dropdown while this is
  // false: an explicit pick is the reader's ruling, and a default that overruled it would be a correction.
  cloneHostTouched: {},
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
    // A turn that just went back to its record's 60-line tail draws a different window: a stream repaint that was
    // skipped for a live turn must not now be skipped for this one.
    if (state.jobLineVersion) state.jobLineVersion.set(id, (state.jobLineVersion.get(id) || 0) + 1);
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

// ---- the fixed cards' default fold -------------------------------------------------------------
// The Unattached agents card starts MINIMIZED (row 416). A fresh tab that opened it threw the reader off the
// board every time, because the store records only COLLAPSED ids: an absent "agents" entry meant expanded, and
// the page therefore painted it open for everyone who had never folded it. The default now comes from the
// page's state, not from the class the previous paint (or the parsed markup) left behind: an untouched card
// takes FIXED_DEFAULT_COLLAPSED, and a card the reader has folded or unfolded takes their choice.
//
// `wm.fixedChosen` is that choice. It is written on a click of the card's own head (toggleFixed) only - the
// global Expand all is a moment's gesture, not a fold decision, so it leaves the shipped default in place. The
// New agent card is absent from FIXED_DEFAULT_COLLAPSED on purpose: its default stays expanded.
const FIXED_DEFAULT_COLLAPSED = ["agents"];

function loadFixedChosen() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.fixedChosen") || "[]"));
  } catch {
    return new Set();
  }
}

function saveFixedChosen() {
  try {
    localStorage.setItem("wm.fixedChosen", JSON.stringify([...state.fixedChosen]));
  } catch {
    /* no storage: the choice simply will not persist */
  }
}

// Pure: the reader's bookkeeping is the whole input, so the same store always starts a card the same way.
// A stored collapse is honored first - the store only ever records COLLAPSED ids, so a card that is in it has been
// folded by the reader (or by an older build) and must stay folded. A card the reader has chosen and left out of
// the set is open. Only a card with nothing recorded takes the shipped default, which is what makes the Unattached
// agents card start minimized without reopening a card somebody had already folded.
function fixedCardStartsCollapsed(id, collapsedFixed, fixedChosen) {
  if (collapsedFixed.has(id)) return true;
  if (fixedChosen.has(id)) return false;
  return FIXED_DEFAULT_COLLAPSED.includes(id);
}

// Write each untouched fixed card's default into the fold state the painter reads, before the first paint of
// the two cards. A card the reader has chosen is never overridden: minimized stays minimized, expanded stays
// expanded. Returns whether the state changed.
function defaultFixedCollapse() {
  let changed = false;
  for (const id of FIXED_CARDS) {
    const collapse = fixedCardStartsCollapsed(id, state.collapsedFixed, state.fixedChosen);
    if (state.collapsedFixed.has(id) === collapse) continue;
    if (collapse) state.collapsedFixed.add(id);
    else state.collapsedFixed.delete(id);
    changed = true;
  }
  if (changed) saveCollapsedFixed();
  return changed;
}
// ---- end the fixed cards' default fold

function toggleFixed(name) {
  if (!name) return;
  if (state.collapsedFixed.has(name)) state.collapsedFixed.delete(name);
  else state.collapsedFixed.add(name);
  // A click on the card's own head IS the reader's fold decision, either direction.
  state.fixedChosen.add(name);
  saveCollapsedFixed();
  saveFixedChosen();
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
  // Focus mode draws every project that holds a live row expanded, so a fold here would be undone by the next paint
  // while still moving `expandedProjects` - the reader's layout, which is what the mode promises to give back when it
  // goes off. Refuse it and name the way out. Every open and close of a project funnels through here (the header
  // click, and the reveals that unfold a project to reach a card), so one guard covers them all.
  if (focusModeOn()) {
    showBanner("focus mode draws every project with a live panel expanded - double-click the header bar to fold projects again");
    return;
  }
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
  const pick = form.querySelector("[data-clone-host]");
  const btn = form.querySelector("[data-clone-go]");
  const name = String(input?.value || "").trim();
  // The host travels with the name: the route builds the URL from THAT record, so a SEFL repo clones from
  // git.sefl.com and a GitHub one from github.com without this page knowing either URL.
  const host = String(pick?.value || "").trim();

  const setStatus = (text, kind = "busy") => setCloneStatus(form, root, text, kind);

  if (!name) {
    input?.focus();
    return;
  }
  btn.disabled = true;
  setStatus("cloning over ssh...");
  try {
    const res = await apiFetch("/api/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, name, host }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(j.error || `HTTP ${res.status}`, "err");
      return;
    }
    setStatus(`cloned to ${j.dest} from ${j.hostName || j.host} (${Math.round((j.tookMs || 0) / 1000)}s, ${j.url})`, "ok");
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

// Which host a typed coordinate names, when it names exactly one. The first segment of the name is compared against
// the host records' own coordinates (github's owner, Bitbucket's project key) AND the coordinates of the projects
// already mapped to each host, because the key in `citdev/java-ruleset` is a project's ruling rather than the host's
// default. Anything ambiguous, or no match, leaves the dropdown where the reader put it: this is a default, never a
// correction. Both sources are the store the page already has, so no host name is written into this function.
function hostMatchingTypedName(text) {
  const first = String(text || "").trim().split("/")[0].toLowerCase();
  if (!first) return null;
  const doc = state.hosts || {};
  const matches = [];
  for (const [id, rec] of Object.entries(doc.hosts || {})) {
    const own = [rec.coordinates?.owner, rec.coordinates?.projectKey];
    const mapped = Object.values(doc.projects || {})
      .filter((p) => p?.host === id)
      .flatMap((p) => [p.coordinates?.owner, p.coordinates?.projectKey]);
    if ([...own, ...mapped].some((v) => String(v || "").toLowerCase() === first)) matches.push(id);
  }
  return matches.length === 1 ? matches[0] : null;
}

// A pick is the reader's, and it survives the snapshot repaints that rebuild every folder section. It also stops the
// typed-name default below: once a host has been chosen by hand, typing must not move it out from under them.
document.addEventListener("change", (e) => {
  const pick = e.target?.closest?.("[data-clone-host]");
  if (!pick) return;
  state.cloneHost[pick.dataset.cloneHost] = pick.value;
  state.cloneHostTouched[pick.dataset.cloneHost] = true;
});

// Typing a coordinate that belongs to exactly one host moves the dropdown to it, so `JLRoper/...` and `citdev/...`
// arrive at the right route without the reader hunting for the name. A bare repo name matches nothing and leaves the
// choice alone, and a host the reader picked by hand is never moved.
document.addEventListener("input", (e) => {
  const input = e.target?.closest?.("[data-clone-input]");
  if (!input) return;
  const root = input.dataset.cloneInput;
  if (state.cloneHostTouched[root]) return;
  const form = input.closest("[data-clone-form]");
  const pick = form?.querySelector("[data-clone-host]");
  const id = hostMatchingTypedName(input.value);
  if (!pick || !id || pick.value === id) return;
  pick.value = id;
  state.cloneHost[root] = id;
});

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
      text: "polled · every 2s",
      title: "this gateway does not advertise run_events_sse, so the card is polled every 2s instead of streamed - a quiet moment here is the poll, not a stuck model",
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
  // The gateway's own status frame, when it is the newest thing this run said: `hermes.status` is how a turn
  // explains a silence it is about to have (compaction runs before the first model call). The text is the
  // gateway's; the pulse shortens it to its first clause and keeps the whole sentence in the title.
  const status = j.live.status;
  if (status && (!last || status.at >= last)) {
    return {
      cls: "is-status",
      text: `${statusPulseText(status.text)} · ${ago}`,
      title: `${status.text} - the gateway's own status frame for this run, ${ago} ago. A compacting turn is silent until its first model call`,
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

// The status frame's first clause is what names the work ("📦 Preflight compression: ~203,774 tokens >= 200,000
// threshold." -> "📦 Preflight compression"); the whole sentence stays in the title. Never re-worded.
function statusPulseText(text) {
  const whole = String(text || "").replace(/\s+/g, " ").trim();
  const first = whole.split(/[:.]\s/)[0].trim() || whole;
  return first.length > 44 ? `${first.slice(0, 43)}…` : first;
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

// Redraws the clocks in place — never a repaint, so a scrolled console stays put while it ticks. One clock slot per
// tool row (public/board/console.js toolGroupHtml/flatRowHtml), written as TEXT on the node that is already there:
// the swap from "running" to a duration is the same slot with a different string, so the row's geometry never moves
// when the digit count changes.
function tickLiveClocks() {
  for (const el of document.querySelectorAll("[data-live-from]")) {
    const from = Number(el.dataset.liveFrom) || Date.now();
    const secs = (Date.now() - from) / 1000;
    // A row's slot is the span the row was built with; the placeholder and the card head carry the attribute on
    // themselves, and are written the way they always were.
    const slot = el.matches("[data-tgrp-clock]") ? el : el.querySelector("[data-tgrp-clock]");
    const target = slot || el;
    target.textContent = liveLabel(secs);
    // Past a minute it is the only moving part on the card, so it stops being quiet.
    target.classList.toggle("is-long", secs >= 60);
  }
  // The gateway wait line (public/board/console.js waitLineHtml): a live run whose stream has sent nothing yet says
  // so in the console BODY with an age, and the age is the only part that moves. Two slots, not one string: the words
  // change ONCE at PULSE_SILENT_SECONDS and the age is rewritten every second, so the sentence never reflows for a
  // digit. The row is not repainted: the same nodes are written, which is what keeps a scrolled console still.
  for (const el of document.querySelectorAll("[data-gwait]")) {
    const at = Number(el.dataset.gwait) || 0;
    if (!at) continue;
    const secs = Math.max(0, (Date.now() - at) / 1000);
    el.classList.toggle("is-silent", secs >= PULSE_SILENT_SECONDS);
    const label = el.querySelector("[data-gwait-label]");
    if (label) label.textContent = waitLineWords(secs);
    const age = el.querySelector("[data-gwait-age]");
    if (age) age.textContent = fmtSeconds(secs);
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

// ---- the agent's own question (the `clarify` tool) ---------------------------------------
// Same place as an approval — under the console of the turn that is parked on it — but a different
// thing: there is no command to judge, the prompt is a sentence to read, and the answers are full
// sentences. Light purple, not amber, so "answer me" and "allow this" never read as one interruption.
//
// A URL in the question is a LINK, not text: a question that names a report is answered by reading it,
// and a reader who has to copy a path out of a card has already lost the point. `linkifyText` escapes
// first and then wraps the http(s) URLs (public/core/dom-format.js), so the anchor carries the panel's
// one link affordance and `data-open-url`, which the page's own click handler turns into a POST
// /api/open-url - the OS browser opens the page instead of this tab navigating away from the board.
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

// The browser a FILE link opens in: the machine's registered default, behind lib/open-url.js's ladder, asked once per
// page load (GET /api/open-file) and named on the card. `null` until the answer lands, and "your browser" is what the
// card says then - the honest label for a fact the page has not been told yet, and the same label on a machine whose
// registry names no browser at all (the ladder then falls through rundll32 and explorer.exe).
let questionBrowser = null;

const browserName = () => questionBrowser || "your browser";

// The tree a question's relative file targets belong to. lib/jobs.js writes the asking turn's own cwd/worktree onto
// the question record as `base` when the prompt arrives; this is the only place the page reads it, and the click sends
// it back so the route resolves against that tree rather than guessing a project root. It sits beside `browserName`
// because both are the two facts a file anchor needs, and both live outside the card's own repaint.
function questionBase(q) {
  const base = String(q?.base || "").trim();
  return base ? base.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

// The browser's own name, written into every card already on the page when the answer arrives. In place, like
// paintQLook: the card is not rebuilt for a label, and a reader typing into one keeps the caret.
function paintBrowserName() {
  for (const el of document.querySelectorAll("[data-browser-name]")) el.textContent = browserName();
}

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

// The Links section: a RESERVED block on every question card that came with links, one anchor per link, between the
// question and its choices. Reserved means the same place on every card and the same head, so a reader learns where to
// look - and nothing at all when a question carries none, which is why the plain-text card reads exactly as before.
//
// A URL is opened by the panel (data-open-url, POST /api/open-url) and a file by the panel's own ladder
// (data-open-file, POST /api/open-file, lib/open-url.js), never by this page navigating: the panel is what knows the
// reader's registered browser, and a `file:` navigation inside the page would be blocked by the browser anyway.
function questionLinks(q) {
  const links = (Array.isArray(q?.links) ? q.links : []).filter((l) => l && l.target);
  if (!links.length) return "";
  const base = questionBase(q);
  const rows = links
    .map((l) => {
      if (l.kind === "url") {
        return `<a class="tq-link" href="${esc(l.target)}" target="_blank" rel="noreferrer noopener" data-open-url="${esc(l.target)}" title="open ${esc(l.target)} in your browser">${esc(l.label || l.target)}<span class="tq-link-where mono">${esc(l.target)}</span></a>`;
      }
      // Same rule as the question row (public/core/dom-format.js `fileAnchor`): a relative target with no base is not
      // an anchor. The row keeps the label and says why, instead of offering a click that answers "no such file".
      if (!absoluteFileTarget(l.target) && !base) {
        return `<div class="tq-link is-relative"><span class="tq-link-relative">${esc(l.label || l.target)}</span><span class="tq-link-where mono">${esc(l.target)} · relative path, not a link</span></div>`;
      }
      return `<a class="tq-link" href="#" data-open-file="${esc(l.target)}"${fileBaseAttr(l.target, base)} title="open ${esc(l.target)} in ${esc(browserName())}">${esc(l.label || l.target)}<span class="tq-link-where mono">${esc(l.target)}</span></a>`;
    })
    .join("");
  // The browser is named once, in the head: every file anchor in this section goes to the same one, and repeating it
  // on four rows would be four times the noise for one fact.
  return `<div class="tq-links">
    <div class="tq-links-head mono">Links <span class="tq-links-browser">· file links open in <span data-browser-name>${esc(browserName())}</span></span></div>
    ${rows}
  </div>`;
}

// The four-direction strip: ONE line under the question, on every card that offers choices, saying what shape the
// card has. It is a MEASUREMENT, never a gate: a card whose choices are missing a direction (or whose recommended
// choice is not first) still raises, answers and settles exactly as before. The sentence is built server-side by
// lib/clarify-shape.js and travels on `question.shape.line`, so the card, the history and a test read one wording;
// this function only draws it. A card with no choices draws nothing: it offers no directions to be short of.
function questionShape(q) {
  const shape = q && typeof q.shape === "object" ? q.shape : null;
  const line = String(shape?.line || "").trim();
  if (!line || !(Number(shape?.count) > 0)) return "";
  const why = String(shape?.why || "").trim();
  return `<div class="tq-shape${shape.ok ? " is-complete" : ""}" data-q-shape title="${esc(why || line)}">${esc(line)}</div>`;
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
  // WHEN THIS CARD DIES, from the window the gateway is enforcing (lib/jobs.js writes both numbers from the
  // gateway's own timeout_s or the one resolution of its config; no constant lives here). The deadline is counted
  // from arrival, which is a second or two after the gateway began waiting, so the clock runs that much late and is
  // drawn with a tilde; past it the card stops offering an answer rather than letting a press land on a wait that is
  // already gone.
  const deadline = Number(q.deadline) || 0;
  const windowMs = (Number(q.timeoutSeconds) || 0) * 1000;
  const leftMs = deadline - Date.now();
  const spent = Boolean(deadline) && leftMs <= 0;
  const shut = sending || spent;
  const rows = choices
    .map((c, i) =>
      multi
        ? `<label class="tq-choice is-multi${picks.has(i) ? " on" : ""}" data-qvalue="${esc(c)}" title="tick the answers you want, then send them">
      <input type="checkbox" data-qpick="1" data-qturn="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qindex="${i}"${picks.has(i) ? " checked" : ""}${shut ? " disabled" : ""}>
      <span class="tq-box" aria-hidden="true"></span>${questionHead(c)}</label>`
        : `<button type="button" class="tq-choice" data-qanswer="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qrequest="${esc(q.requestId || "")}" data-qvalue="${esc(c)}"${shut ? " disabled" : ""} title="send this answer — the agent carries on with it">
      <span class="tq-box" aria-hidden="true"></span>${questionHead(c)}</button>`,
    )
    .join("");
  // A question with no choices has nothing to answer with except words, so the typed box always stays for
  // it; with choices, Settings can take the box away, and a multi-select question then keeps a bare Send
  // button (it would otherwise be unanswerable).
  const showTyped = qLookState.typed || choices.length === 0;
  const note = spent
    ? WINDOW_OVER_NOTE
    : !showTyped
      ? multi
        ? "tick any that apply, then Send answer"
        : "click a choice above"
      : multi
        ? "tick any that apply, then Send answer · a typed answer replaces the ticks"
        : choices.length
          ? "click a choice above, or type your own answer · Enter sends"
          : "type your answer · Enter sends, Shift+Enter adds a line";
  const sendBtn = `<button type="button" class="tq-send" data-qsend="${esc(turn.id)}" data-qcopy="${esc(copy)}" data-qrequest="${esc(q.requestId || "")}"${shut ? " disabled" : ""}>Send answer</button>`;
  const answerRow = showTyped
    ? `<div class="tq-other-row">
      <textarea class="tq-other" data-qother="${esc(turn.id)}" data-qcopy="${esc(copy)}" rows="2" placeholder="or type your own answer" title="anything you type here is sent as your answer, in your own words"${shut ? " disabled" : ""}>${esc(draft)}</textarea>
      ${sendBtn}
    </div>`
    : multi
      ? `<div class="tq-other-row is-send-only">${sendBtn}</div>`
      : "";
  // The countdown: the gateway stops waiting for this answer when the window it is enforcing runs out.
  // Rendered with its current width so the first paint is right, then driven by the page's one clock tick - and
  // both read `clockLabel`, so the first paint and the tick can never describe the same moment differently.
  const pct = deadline && windowMs ? Math.max(0, Math.min(100, (leftMs / windowMs) * 100)).toFixed(2) : null;
  const clock = pct === null
    ? ""
    : `<div class="tq-foot${leftMs <= 0 ? " is-over" : pct <= 12 ? " is-low" : ""}" data-q-clock data-q-deadline="${deadline}" data-q-window="${windowMs}" title="time left before the gateway stops waiting for this answer - measured from when the question reached the panel, so it is a second or two optimistic">
      <div class="tq-timer"><span style="width:${pct}%"></span></div>
      <span class="tq-left mono">${clockLabel(leftMs)}</span>
    </div>`;
  // How many times the panel has asked the reader again about this same question (lib/assistant.js
  // re-asks an hour after it parked, then hourly). It is a count on THIS box, not a second box: the
  // question never changed, only the number of times nobody answered it.
  const reasks = Math.max(0, Number(q.reasks) || 0);
  const again = reasks
    ? `<span class="tq-again" title="the panel asks again once an hour while this stays unanswered — nothing else about the question has changed">↻ asked again ${reasks}× · still unanswered</span>`
    : "";
  // The question's own text, with its links. `linkifyCardParts` also hands back the relative targets it refused to
  // anchor, so the sentence below the text can say why they are not clickable - a path a reader cannot open is still
  // a path they need to know about, and the reason belongs on the card rather than in a 404 banner after the click.
  const parts = linkifyCardParts(q.question || "(no question text)", { base: questionBase(q) });
  const relativeNote = parts.relative.length
    ? `<div class="tq-relnote mono" title="a relative path is resolved against the asking turn's tree, and this question carries none">relative path, not a link: ${esc(parts.relative.join(", "))} - the card has no tree to resolve it against</div>`
    : "";
  return `<div class="turn-question${sending ? " is-sending" : ""}" data-question-for="${esc(turn.id)}${esc(copy)}"${sending ? ' aria-busy="true"' : ""}>
    <div class="tq-head mono">${sending ? "⏳ sending your answer — the agent is being released" : "❓ waiting on you — the agent is parked until you answer"}</div>
    ${again}
    <div class="tq-question">${parts.html}</div>
    ${questionShape(q)}
    ${relativeNote}
    ${questionLinks(q)}
    ${rows ? `<div class="tq-choices${multi ? " is-multi" : ""}">${rows}</div>` : ""}
    <div class="tq-note mono${sending ? " is-sending" : ""}" data-qnote="${esc(note)}">${esc(sending ? "sending your answer, one moment..." : note)}</div>
    ${answerRow}
    ${clock}
    <div class="tq-warn mono" data-qwarn="${esc(turn.id)}${esc(copy)}"></div>
  </div>`;
}

// The one sentence a spent window says, and the two things every surface has to agree on: when the card is over
// (its own record's deadline, never a clock of its own) and what it says so. `questionPrompt` draws it dead, the
// page's tick kills it at the second, and `paintQuestionFlight` must not bring it back to life when an in-flight
// answer ends badly - a live button on a dead wait is the whole defect this card exists to stop.
const WINDOW_OVER_NOTE = "the gateway's window has run out - this answer can no longer be delivered";
function cardWindowOver(card) {
  const clock = card && card.querySelector("[data-q-clock]");
  const deadline = Number(clock && clock.dataset.qDeadline) || 0;
  return Boolean(deadline) && deadline - Date.now() <= 0;
}

// What a countdown says at a given moment. ONE function, read by the card's first paint and by the page's tick
// below, so the two cannot word the same instant differently ("~0s left" against "time is up" was the drift that
// makes a reader stop believing the number). It lives beside the card that reads it, and the card's own tests slice
// from `questionPrompt` to the comment below, so both halves run the shipped helper rather than a copy.
function clockLabel(leftMs) {
  return leftMs <= 0 ? "time is up" : `~${fmtLeft(leftMs)} left`;
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
//
// When a clock reaches zero the card STOPS OFFERING AN ANSWER, here and not only at the next repaint: the
// gateway has given up on that wait by then, so a press could only come back refused. The controls are the ones
// `questionPrompt` greys while an answer is in flight, so the two states cannot look different to a reader.
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
    if (label) label.textContent = clockLabel(left);
    el.classList.toggle("is-low", pct <= 12);
    el.classList.toggle("is-over", left <= 0);
    if (left <= 0) {
      const card = el.closest(".turn-question");
      if (!card) continue;
      for (const ctl of card.querySelectorAll("input[data-qpick], button.tq-choice, textarea.tq-other, button.tq-send")) {
        ctl.disabled = true;
      }
      const note = card.querySelector("[data-qnote]");
      if (note && !note.dataset.qnoteOver) {
        note.dataset.qnoteOver = "1";
        note.textContent = WINDOW_OVER_NOTE;
      }
    }
  }
}

// Once answered the box becomes one line: what the reader said. A question that closed WITHOUT this panel answering
// it used to become one dim line - "question closed without an answer here" - with no question, no choices and no
// reason: a vanish with a shrug, which is what a reader who never saw the card (queue rows #267 and #254 timed out
// that way) found in its place. A closed record that still carries what was asked (lib/jobs.js `closeQuestion`) keeps
// the question and its choices on the card, dead, with the reason and the clock: a trace the reader can act on later.
function questionAnswered(turn) {
  const done = turn.questionDone;
  if (!done || turn.question) return "";
  const text = String(done.answer || "").trim();
  if (!text && done.closed && String(done.question || "").trim()) {
    const choices = Array.isArray(done.choices) ? done.choices.map(String).filter((c) => c.trim()) : [];
    const why = String(done.why || "").trim();
    const head = why === "timed out"
      ? "✕ the gateway's window ran out before this was answered - nothing was sent"
      : why && why !== "closed unanswered"
        ? `✕ closed unanswered - ${why}`
        : "✕ closed unanswered - nothing was sent";
    const asked = done.askedAt ? ` · asked ${fmtClock(done.askedAt)}` : "";
    const closed = done.at ? ` · closed ${fmtClock(done.at)}` : "";
    return `<div class="turn-question-done is-closed" title="${esc(`${why || "closed unanswered"}${asked}${closed}`)}">
    <div class="tqd-head mono">${esc(head)}</div>
    <div class="tqd-question">${esc(String(done.question))}</div>
    ${choices.length ? `<div class="tqd-choices">${choices.map((c) => `<span class="tqd-choice" title="this choice was offered and is no longer open">${esc(c.replace(RECOMMENDED_RE, "$1"))}</span>`).join("")}</div>` : ""}
    <div class="tqd-when mono">${esc(`${asked}${closed}`.replace(/^ · /, ""))}</div>
  </div>`;
  }
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
    // A card whose window is spent stays shut: re-enabling it here would put a live button back on a wait the
    // gateway has already given up on, which is exactly what the countdown exists to prevent.
    const over = cardWindowOver(card);
    for (const el of card.querySelectorAll("button, textarea, input")) el.disabled = sending || over;
    // The note is where "sending" is SAID, and it is set here as well as at render time: a press repaints nothing,
    // so a card waiting for the next snapshot would otherwise show dead controls with no reason for them.
    const note = card.querySelector("[data-qnote]");
    if (note) note.textContent = sending ? "sending your answer, one moment..." : over ? WINDOW_OVER_NOTE : note.dataset.qnote || "";
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

// "21:03" - the clock a closed question's two stamps are read against. Local time, because the reader was there.
function fmtClock(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A question that has just parked is brought to the reader: the card may be pages down a long board, the reader may
// be reading another row, and a badge changing in the header is not the question arriving. ONE landing per prompt
// (by the gateway's own request id), and only when the box is not already on screen - a landing that re-fires on every
// frame would fight the reader's scroll for as long as the question stays open.
//
// BOTH PARKS LAND THE SAME WAY. An approval is the same interruption as a question - the agent is stopped until the
// reader answers - and it used to arrive below the fold with only the dock (a corner of the screen) showing it: row
// #286's second finding. So the one-shot record, the on-screen test and the scroll live here, and each park supplies
// the boxes it draws.
const parkLanded = new Set();
function landParkBlock(key, cards) {
  if (parkLanded.has(key)) return false;
  parkLanded.add(key);
  const boxes = [...(cards || [])].filter((el) => el && el.isConnected);
  if (!boxes.length) return false;
  const onScreen = boxes.some((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
  });
  if (onScreen) return false; // already where the reader is looking
  const box = boxes[0];
  if (typeof programmaticScroll === "function") programmaticScroll();
  box.scrollIntoView({ block: "center", behavior: "smooth" });
  box.classList.add("jump");
  setTimeout(() => box.classList.remove("jump"), 1600);
  return true;
}
function landClarifyQuestion(turnId, requestId) {
  return landParkBlock(`question:${questionFlightKey(turnId, requestId)}`, questionCardsFor(turnId, requestId));
}
// The approval's boxes carry the turn they belong to, not just the run: `data-approval-for` is `<turn id>` on the
// page copy and `<turn id>@pin` on the pinned one, so both are found here and the one that is off screen is the one
// scrolled to. A box with no buttons at all (an unanswerable request) is still landed on - it is a record the reader
// must see, which is why this does not go through approvalCardsFor (that walks `[data-approve]`).
function landApprovalBlock(turnId, requestId) {
  const id = String(turnId || "");
  if (!id) return false;
  const key = `approval:${String(requestId || "").trim() || id}`;
  const cards = document.querySelectorAll(
    `.turn-approval[data-approval-for="${CSS.escape(id)}"], .turn-approval[data-approval-for="${CSS.escape(`${id}${wtTurnFold.PIN}`)}"]`,
  );
  return landParkBlock(key, cards);
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

async function openQuestionFile(target, base = "") {
  try {
    const r = await apiFetch("/api/open-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The base rides WITH the path: a relative target is resolved against the asking turn's tree and never against
      // the panel's own cwd, and the route refuses to guess when the base is missing.
      body: JSON.stringify(base ? { path: target, base } : { path: target }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      showBanner(`open ${target}: ${d.error || `HTTP ${r.status}`}`);
      return;
    }
    // A REUSE is the one success worth a word. The panel opened this file inside the last five minutes, so this click
    // started nothing; without the line the missing second window reads as a control that did nothing. It says
    // "already open" and never "opened": the panel cannot raise the window it opened before, and it does not pretend
    // to. Everything else stays silent - the tab that appears IS the answer, and a banner for every link is noise.
    if (d.reused) {
      const s = Math.max(1, Math.round((Number(d.ageMs) || 0) / 1000));
      const age = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
      showBanner(`already open in ${d.opener || "your browser"} ${age} ago - not opened again, this click started nothing`);
    }
  } catch (e) {
    showBanner(`open ${target}: ${e.message}`);
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
// A settled turn that still carries preview blocks is read ONCE more: that read is what replaces the live rows with
// the store's recorded blocks, so each thought keeps one copy in the console.
function sweepThinking() {
  for (const card of document.querySelectorAll(".job[data-thread]")) {
    const thread = card.dataset.thread;
    if (!thread || !thinkingOn(thread)) continue;
    const conv = conversations().find((c) => c.thread === thread);
    if (!conv) continue;
    for (const turn of conv.turns) {
      const entry = state.thinkCache.get(turn.id);
      const live = turnLive(turn);
      const staleLive = live && (!entry || Date.now() - (entry.at || 0) > 1000);
      const needsSettle = !live && entry && (entry.blocks || []).some((b) => b && b.preview);
      if (!entry || staleLive || needsSettle) void loadThinking(turn);
    }
  }
}
setInterval(sweepThinking, 500);

// A thinking row is a button: Enter and Space open and close it exactly like a press on it.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target && e.target.closest ? e.target.closest(".jl-think[data-think-row]") : null;
  if (!row) return;
  e.preventDefault();
  row.click();
});

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
  // The clarify card's answer box: the card is rebuilt from the draft map (so the words come back), and the focus and
  // the selection are put back here. A box that already holds the snapshot is the reader's OWN node - the row path
  // MOVES the card instead of rebuilding it, and a move keeps the value and the selection but drops the focus - so the
  // value is only written when it differs, and the caret is re-asserted either way.
  if (typing.qbox !== undefined) {
    const box = root.querySelector(
      `.tq-other[data-qother="${CSS.escape(typing.qbox)}"][data-qcopy="${CSS.escape(typing.qcopy)}"]`,
    );
    if (!box) return;
    if (box.value !== typing.value) box.value = typing.value;
    // preventScroll for the same reason as the reply box: this runs on every repaint, and a plain focus() would pull
    // the page back to the caret while the reader was reading something lower on the board.
    box.focus({ preventScroll: true });
    try {
      box.setSelectionRange(typing.start, typing.end);
    } catch {
      /* a box that is no longer a text field: nothing to restore */
    }
    return;
  }
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
// Each entry is `{ text, at }`: the words, and the moment they were said. The clock is what lets this list be
// MERGED with the session's turns instead of appended after them. A bare string is what an older build wrote and
// is read as an entry with no clock.
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

// One stored list as `{ text, at }` entries, in the order the store keeps them. `at` is null for an entry an older
// build wrote with no clock: nothing says when it was said, so it cannot be placed among the timed entries.
function replyHistoryEntries(raw) {
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const text = String(entry && typeof entry === "object" ? entry.text : entry ?? "").trim();
    if (!text) continue;
    const at = entry && typeof entry === "object" ? Number(entry.at) : NaN;
    out.push({ text, at: Number.isFinite(at) && at > 0 ? at : null });
  }
  return out;
}

function rememberReply(thread, text, at = Date.now()) {
  const s = String(text || "").trim();
  if (!thread || !s) return;
  try {
    const all = replyHistoryStore();
    // The same words said again MOVE their entry to the newest place instead of adding a second one: Up walks what
    // the reader said most recently, so a repeat is the newest thing they said, not the first time they said it.
    const list = replyHistoryEntries(all[thread]).filter((e) => e.text !== s);
    list.push({ text: s, at: Number(at) || Date.now() });
    all[thread] = list.slice(-REPLY_HISTORY_MAX);
    localStorage.setItem(REPLY_HISTORY_KEY, JSON.stringify(all));
  } catch {
    /* private mode: history is a convenience, not state the panel needs */
  }
}

// The clock a turn prompt sorts on: when that turn started. `startedAt` is written by the panel's own create(), so
// it is the same clock the browser stamps its history with, and the two records merge into one timeline.
function promptClock(j) {
  for (const raw of [j.startedAt, j.endedAt]) {
    const at = Date.parse(raw || "");
    if (Number.isFinite(at) && at > 0) return at;
  }
  return null;
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

// ---- New-agent prompt history ---------------------------------------------------------
// Shell-style recall for the spawn box: Up walks back through what you have spawned, Down walks
// forward, and whatever you were part-way through typing is kept as the "draft" at the end (back 0).
// Persisted, because the prompt worth reusing is usually from a previous session, not this one.
// (SPAWN_HISTORY_KEY / SPAWN_HISTORY_MAX live at the top of the file, above `state`.)

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

// ---- job tree filing: the worktree a card's directory belongs to
// The worktree a path names when it sits inside a `.worktrees` folder: `<checkout>/.worktrees/<name>`. This is the
// panel's own layout, and it is the one place a path's TREE is knowable without asking the server.
function worktreeRootOf(dir) {
  const m = /^(.*?)\/\.worktrees\/([^/]+)(?:\/|$)/i.exec(normPath(dir).replace(/\\/g, "/"));
  return m ? `${m[1]}/.worktrees/${m[2]}` : null;
}

// The worktree an agent's directory belongs to: an exact match on the row path, or the deepest row
// containing it (an agent started in a subdirectory still belongs to that worktree).
//
// A `.worktrees/<name>` directory is the exception that matters: only the row AT that tree may claim it. The
// checkout that CONTAINS the tree is a path prefix, and taking it as the match is what filed job 24695761 on the
// main row — a card for a run one directory down was silently attached to the reader's own checkout with no picker
// and no question. No row at the tree means NO match: the press opens the picker, and the server refuses or
// redirects rather than accepting the parent.
function matchWorktree(dir) {
  const d = normPath(dir).toLowerCase();
  if (!d) return null;
  const root = worktreeRootOf(d);
  if (root) {
    return [...state.rows.values()].find((r) => normPath(r.path).toLowerCase() === root) || null;
  }
  let best = null;
  for (const r of state.rows.values()) {
    const p = normPath(r.path).toLowerCase();
    if (d !== p && !d.startsWith(`${p}/`)) continue;
    if (!best || p.length > best.path.length) best = r;
  }
  return best;
}
// ---- end job tree filing

// Attach an unattached agent to a worktree: it then lives under that row, owned like any other.
async function attachAgent(thread, pathOverride = null) {
  const sel = document.querySelector(`[data-attach-path="${CSS.escape(thread)}"]`);
  // A picker showing the "row is missing" placeholder (`disabled`, value "") must never post that value as a path:
  // the message it carries is the answer, and the server is not asked to file the card anywhere.
  const chosen = sel && sel.selectedOptions ? sel.selectedOptions[0] : null;
  const path = pathOverride || (chosen && !chosen.disabled ? chosen.value : "");
  if (!path) {
    showBanner(`attach ${thread}: ${sel?.dataset?.attachMissing || "choose a worktree first"}`);
    return false;
  }
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
    // The server may have ANSWERED with a different tree than the press named: the run is in `.worktrees/<name>`
    // and the press named the checkout containing it. Say so — the reader's intent was a row, not that parent.
    if (d.redirectedFrom) {
      showNote(`that run is in ${String(path).split("/").pop()}, not ${String(d.redirectedFrom).split("/").pop()} — the card is filed on its own worktree`);
    }
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

// The remote-write stores the dock paints. They live on `state` and are initialised here, beside the
// literal they hang off (the way the thinking books are); the code that paints them is
// public/board/approvals.js, a classic script the shell loads before this one.
state.rwPending = state.rwPending || new Map(); // id -> request still waiting for an answer
state.rwDecided = state.rwDecided || new Map(); // id -> what was decided, shown as the collapsed line
state.rwReviews = state.rwReviews || new Map(); // id -> an auto-allowed write, drawn as a Keep / Unwind review
state.rwPolicy = state.rwPolicy || "local-only";

// Every output pane's position, so a rebuild can put the reader back where they were instead of
// dropping them at the first line of an hour-old transcript.
// ---- thinking -----------------------------------------------------------------------------
// The books the two display switches read. The switches themselves - the reader's per-session answer, the
// global default, and the press that flips it - live in public/turns.js with the turn head that draws them;
// these hang off `state`, so they stay with the state it is built in.
state.thinkCache = state.thinkCache || new Map(); // turn key -> { blocks, at }
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
//   * Stream display speed — WORDS a second across EVERYTHING the console reveals. One queue in
//     core/type-stream.js carries the answer's paragraphs, its reasoning blocks and the tool records in the order
//     the server stamped them, and one budget releases the words in that order; what is drawn is always an exact
//     prefix of the text the run sent, so a copy of a half-typed line is what is on screen.
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

// One drawn stream and one gate for the whole board: this is a reading preference, not a per-card one.
state.typeStream = globalThis.wtType?.createDrawStream
  ? globalThis.wtType.createDrawStream({ rate: typeWordSpeed(), onPaint: (keys) => paintTypedLines(keys) })
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
// The reasoning blocks the stream has already been given: a block seen for the first time while its turn is LIVE is
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
  state.typeStream?.releaseAll();
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
  // The consoles (pre.job-out, .sub-console: the 400 ms sweep, the stream, every line, every stream repaint), plus
  // the other nodes a clock walked the page for: tr.detail (sweepStaleBoard, ~44 a minute), .tgrp (the 3 s tool-store
  // refresh), .queue-ago (the 1 s queue clock, 49 ms a minute of native search on its own) and [data-q-clock] (the
  // question clocks).
  const kinds = ["pre.job-out", ".sub-console", "tr.detail", ".tgrp", ".queue-ago", "[data-q-clock]"];
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
      // A folded thought row in the rebuilt card carries its source until it is measured (the cut is a measurement):
      // fit it before anything reads the card's heights - the console placement below and the caller's scroll map
      // both measure, and a row that folds after they have read it would move the reader's line.
      fitThinkRows(fresh);
      // No card was carried into this slot: the rebuild BUILT one, so its consoles have no old node to read and no
      // entry in the caller's scroll map, and the same-task restores below skip them. Place them here, before the
      // frame the insert is in is painted - the top of a log the run has been writing is not where the reader was.
      placeBuiltConsoles(fresh);
    } else slot.remove();
  }
  if (heldSelection && heldSelection.length) restoreCardSelection(heldSelection);
}

// ---- the row's face is drawn in public/board-scaffold.js; this file keeps the write -----------------------------
// The row's detail block with its merge state, description and TODO strip (gitSubHtml, descLines, todoBlockHtml,
// detailHtml), the project header's chips and its host strip (headTitle, chipsHtml, hostChipHtml, hostPanelHtml and
// the proposal that writes one) were cut into public/board-scaffold.js. What stays here is the write: todoPost() is
// a POST that resyncs the board, not an element builder. The table's own column fit follows it, which is layout.
//
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
  // A live corner gesture holds a console somewhere on this board: this rebuild replaces every card on it, so the node
  // the pointer is on would go with the old markup. The gesture asks for one repaint on its release instead.
  if (outGripLive()) {
    outGripDefer();
    return;
  }
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
  // The kind's lift question is NOT thrown away by a repaint: the reader asked it, and a board that answers a press
  // by removing the question mid-read is the silent no-op this control exists to avoid. Put the same <tr> back under
  // its row in the new table, and give the keyboard back to Cancel when the question had it.
  for (const [key, el] of [...kindConfirmEls]) {
    const row = $("projects").querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
    if (!row) {
      el.remove();
      kindConfirmEls.delete(key);
      continue;
    }
    const hadFocus = el.dataset.focused === "1";
    row.after(el);
    markUnder(el, key);
    if (hadFocus) el.querySelector("[data-kind-lift-no]")?.focus();
  }
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

// The size in force on this card, read from the one variable rather than from whichever element the wheel was over.
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
// The zones are one selector's worth: `.job-out` holds the agent's words, a tool's output and its reasoning.
// Any of them sizes the whole card, the same single step.
const onConsoleWheel = (e) => {
  if (!e.ctrlKey) return;
  const target = e.target && e.target.closest ? e.target : null;
  const zone = target ? target.closest(".job-out") : null;
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
      const zone = e.target && e.target.closest ? e.target.closest(".job-out") : null;
      if (!zone) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    },
    { passive: false, capture: true },
  );
}

// The console's corner grip now lives in public/core/console-grip.js: the press, the move, the release, the step and
// the ONE limit, and the one band that answers the floor and the room in layout px from the pane's own bottom and the
// viewport's. This file keeps the wiring - the page's writers and recorders the gesture calls, and the four predicates
// the rest of the page asks by name - so a console rewrite still cannot invent a second geometry.
const consoleGrip = wtConsoleGrip.install({
  setHeight: (out, px) => setOutHeight(out, px),
  clearHeight: (out) => clearOutHeight(out),
  floor: (cs) => outFloor(cs),
  remember: (id, h) => rememberOutHeight(id, h),
  noteScroll: (body, tailPx) => noteCardBodyScroll(body, tailPx),
  setScroll: (el, top) => setScroll(el, top),
  flush: () => renderAll(),
});

// The names the page's writers and rebuild paths ask by bare name (public/board/console.js consoleHeld,
// public/render-jobs.js, public/assistant.js, public/render-projects.js). One question, answered by the gesture itself.
function outDragging(out) {
  return consoleGrip.holds(out);
}

function outGripHoldsCard(el) {
  return consoleGrip.holdsCard(el);
}

function outGripLive() {
  return consoleGrip.live();
}

function outGripDefer(flush) {
  consoleGrip.defer(flush);
}

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
    const initial = connect({ waitForSnapshot: true });
    const stream = state.es;
    void initial.then((received) => {
      if (!received && !state.paused && state.es === stream && state.awaitingStreamSnapshot) void resync({ automatic: true });
    });
  }
});
paintPauseButton();

// The project head's single-click fold, and the one press it must refuse: a click that landed inside the TOP BAR.
// The header carries its own gesture now (a double-click toggles focus mode, see the focus-mode section below), and
// the guard is stated here rather than left to event order or a timer, so the two clicks a double-click produces can
// never be read as a fold behind the header. Everything else about the press is unchanged, Ctrl+click's hue included.
function foldProjectFromClick(e) {
  if (!e?.target?.closest) return false;
  if (e.target.closest(".topbar")) return false;
  const phead = e.target.closest(".project-head[data-toggle-project]");
  if (!phead) return false;
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
    return true;
  }
  keepInPlace(() => document.querySelector(`.project-head[data-toggle-project="${CSS.escape(name)}"]`), () => toggleProject(name));
  return true;
}

// WHICH `code-head` A PRESS BELONGS TO, when the press did not land on a head. The whole `.code-box` frame is the
// handle (the branch below): a press on its body, its bullets or its chrome folds or unfolds the card. Three
// presses are NOT a fold, because the card contains things a reader means to use and text a reader means to keep:
//   * one on a LINK or any other control inside the box - the copy button the console's copy walker adds to every
//     `[data-copy]` block is a `<button>`, so it and every other button, input and summary answer for themselves;
//   * one that finishes a TEXT SELECTION - dragging across the output and letting go fires a click on the box, and
//     folding what was just selected would be the panel undoing the reader's own gesture;
//   * one on the head itself, which the branch that calls this has already matched (a button is a control: the head
//     would otherwise toggle once here and once through its own press, which cancels out).
// Returns null for all three, so the caller's `if (codeFold)` skips them and their own handlers run.
//
// A SELECTION IS MEASURED AT MOUSEDOWN, not at the click. The browser collapses the selection when the button goes
// down, so a click handler that asks `getSelection()` after a drag always sees nothing selected: the guard would pass
// every press it was written to stop. So the press is recorded as it starts - where the pointer went down, and
// whether a selection was already open inside the box - and a click that moved more than a few pixels (a drag) or
// landed while text was selected is not a fold, whatever the selection reads by then.
let codePress = null;
document.addEventListener(
  "mousedown",
  (e) => {
    const target = e.target;
    const box = target && target.closest ? target.closest(".code-box") : null;
    if (!box) {
      codePress = null;
      return;
    }
    const picked = document.getSelection ? document.getSelection() : null;
    const inside = (n) => Boolean(n) && (n === box || box.contains(n));
    codePress = {
      x: e.clientX,
      y: e.clientY,
      selected: Boolean(picked && !picked.isCollapsed && (inside(picked.anchorNode) || inside(picked.focusNode))),
    };
  },
  true,
);

function codeBoxHit(e) {
  const target = e.target;
  if (!target || typeof target.closest !== "function") return null;
  const box = target.closest(".code-box");
  if (!box) return null;
  if (target.closest("a, button, input, textarea, select, summary, label, [data-copy-btn]")) return null;
  if (codePress) {
    const moved = Math.abs(Number(e.clientX) - codePress.x) > 4 || Math.abs(Number(e.clientY) - codePress.y) > 4;
    if (codePress.selected || moved) return null;
  }
  const picked = document.getSelection ? document.getSelection() : null;
  if (picked && !picked.isCollapsed && picked.rangeCount > 0) {
    const inside = (n) => Boolean(n) && (n === box || box.contains(n));
    if (inside(picked.anchorNode) || inside(picked.focusNode)) return null;
  }
  return box.querySelector(":scope > .code-head[data-code-fold]");
}

// The turnover bar's POLICY select saves on its change, unlike the kind select beside it: a policy is one word the
// reader has already chosen, so there is nothing for a save button to confirm. The value comes off the control that
// changed (a repaint rebuilds the select, so a later lookup would read the wrong node); the bar then draws what the
// route ANSWERED. The handler lives here, beside the chip's click, because the two are the one bar's whole input.
document.addEventListener("change", (e) => {
  const policy = e.target.closest && e.target.closest("[data-turnover-policy]");
  if (!policy) return;
  void saveProjectTurnoverPolicy(policy.dataset.turnoverPolicy, policy.value);
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
  // The row's kind mark: R on a research tree opens the inline lift confirm under THIS row (the board's table and the
  // assistant's Worktrees tab both draw it, so the press names the row it came from). T is a statement and has no
  // handler; a lifted R stops being a button at all.
  const kindLift = e.target.closest("[data-kind-lift]");
  if (kindLift) {
    e.preventDefault();
    e.stopPropagation();
    showKindConfirm(kindLift.dataset.kindLift, kindLift);
    return;
  }
  const kindLiftYes = e.target.closest("[data-kind-lift-yes]");
  if (kindLiftYes) {
    e.preventDefault();
    e.stopPropagation();
    void confirmKindLift(kindLiftYes.dataset.kindLiftYes, kindLiftYes);
    return;
  }
  const kindLiftNo = e.target.closest("[data-kind-lift-no]");
  if (kindLiftNo) {
    e.preventDefault();
    e.stopPropagation();
    closeKindConfirm(kindLiftNo.dataset.kindLiftNo, { focusTrigger: true });
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
  // A clarify card's FILE link: the panel's own opener (POST /api/open-file -> lib/open-url.js's ladder), which is
  // what knows the reader's registered browser. `#` in the href is prevented here - there is no page to go to.
  const openFileBtn = e.target.closest("[data-open-file]");
  if (openFileBtn) {
    e.preventDefault();
    e.stopPropagation();
    void openQuestionFile(openFileBtn.dataset.openFile, openFileBtn.dataset.openFileBase || "");
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
    closeBar(rhcancel.dataset.hostCancel, "host");
    repaintHostPanel(rhcancel.dataset.hostCancel);
    return;
  }
  // The rules chip, and the editor in the bar it opens. The chip sits in the same header line as the host chip, so it
  // stops propagation for the same reason: pressing "rules: 3" must not also collapse the project. The editor's four
  // gestures are one line each here and one save each in board-scaffold.js (`saveProjectRules`).
  const rrules = e.target.closest("[data-rules-project]");
  if (rrules) {
    e.stopPropagation();
    e.preventDefault();
    void toggleRulesBar(rrules.dataset.rulesProject);
    return;
  }
  // The board chip and the claim list it opens: the third chip of the same head line, so it stops propagation for
  // the same reason. The close button carries only its own attribute - the chip's `data-board-project` is what
  // toggles, and the two must not both answer one press.
  const rboard = e.target.closest("[data-board-project]");
  if (rboard) {
    e.stopPropagation();
    e.preventDefault();
    toggleBoardBar(rboard.dataset.boardProject);
    return;
  }
  const rboardClose = e.target.closest("[data-board-close]");
  if (rboardClose) {
    e.stopPropagation();
    e.preventDefault();
    closeBoardBar(rboardClose.dataset.boardClose);
    return;
  }
  // The cleanup chip, and the keep-or-drop calls in the bar it opens. A fifth chip of the same head line, so it stops
  // propagation for the same reason: pressing "cleanup" must not also collapse the project. The chip's press is the
  // dry run or, once it is armed, the apply (`runCleanupChip`); a row's button is one call (`answerCleanupCall`),
  // where `drop` posts the panel's own delete route and `keep` writes nothing.
  const rcleanup = e.target.closest("[data-cleanup-chip]");
  if (rcleanup) {
    e.stopPropagation();
    e.preventDefault();
    void runCleanupChip(rcleanup.dataset.cleanupChip);
    return;
  }
  const rcleanupCall = e.target.closest("[data-cleanup-call]");
  if (rcleanupCall) {
    e.stopPropagation();
    e.preventDefault();
    void answerCleanupCall(rcleanupCall.dataset.cleanupCall, rcleanupCall);
    return;
  }
  // The drop-all button and the confirm it opens. The button itself opens the confirm (nothing is removed by that
  // press), the confirm's own button runs the drops through the panel's single-row delete, and cancel closes the
  // confirm without writing anything. All three stop propagation for the same reason the chip does.
  const rdropAll = e.target.closest("[data-cleanup-drop-all]");
  if (rdropAll) {
    e.stopPropagation();
    e.preventDefault();
    openCleanupDropAllConfirm(rdropAll.dataset.cleanupDropAll);
    return;
  }
  const rdropGo = e.target.closest("[data-cleanup-confirm-go]");
  if (rdropGo) {
    e.stopPropagation();
    e.preventDefault();
    void runCleanupDropAll(rdropGo.dataset.cleanupConfirmGo);
    return;
  }
  const rdropCancel = e.target.closest("[data-cleanup-confirm-cancel]");
  if (rdropCancel) {
    e.stopPropagation();
    e.preventDefault();
    closeCleanupDropAllConfirm(rdropCancel.dataset.cleanupConfirmCancel);
    return;
  }
  const rcleanupOpen = e.target.closest("[data-cleanup-open]");
  if (rcleanupOpen) {
    e.stopPropagation();
    e.preventDefault();
    const c = cleanupOf(rcleanupOpen.dataset.cleanupOpen);
    const target = c?.report?.absPath || c?.report?.path;
    if (target) void openQuestionFile(target);
    else showBanner("cleanup: this run wrote no report page to open");
    return;
  }
  const rcleanupClose = e.target.closest("[data-cleanup-close]");
  if (rcleanupClose) {
    e.stopPropagation();
    e.preventDefault();
    closeCleanupBar(rcleanupClose.dataset.cleanupClose);
    return;
  }
  const rmove = e.target.closest("[data-rule-move]");
  if (rmove) {
    e.stopPropagation();
    e.preventDefault();
    moveRule(rmove.dataset.ruleProject, rmove.dataset.ruleIndex, rmove.dataset.ruleMove);
    return;
  }
  const rdel = e.target.closest("[data-rule-delete]");
  if (rdel) {
    e.stopPropagation();
    e.preventDefault();
    deleteRule(rdel.dataset.ruleProject, rdel.dataset.ruleDelete);
    return;
  }
  const radd = e.target.closest("[data-rules-add]");
  if (radd) {
    e.stopPropagation();
    e.preventDefault();
    addRule(radd.dataset.rulesAdd);
    return;
  }
  const rclose = e.target.closest("[data-rules-close]");
  if (rclose) {
    e.stopPropagation();
    e.preventDefault();
    closeRulesBar(rclose.dataset.rulesClose);
    return;
  }
  // The turnover chip and the one field it opens: the fourth chip of the same head line, so it stops propagation for
  // the same reason. Save and close carry their own attributes - the chip's `data-turnover-project` is what toggles,
  // and the three must not answer one press between them.
  const rturnover = e.target.closest("[data-turnover-project]");
  if (rturnover) {
    e.stopPropagation();
    e.preventDefault();
    void toggleTurnoverBar(rturnover.dataset.turnoverProject);
    return;
  }
  const rtSave = e.target.closest("[data-turnover-save]");
  if (rtSave) {
    e.stopPropagation();
    e.preventDefault();
    void saveProjectTurnover(rtSave.dataset.turnoverSave);
    return;
  }
  const rtClose = e.target.closest("[data-turnover-close]");
  if (rtClose) {
    e.stopPropagation();
    e.preventDefault();
    closeTurnoverBar(rtClose.dataset.turnoverClose);
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
  // The project head's fold, with its own guard: a press inside the top bar is the header's double-click gesture,
  // never a fold. `foldProjectFromClick` returns whether it took the press.
  if (foldProjectFromClick(e)) return;
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
  // The container row's START press: put a worktree on a turnover branch that has none, so its children can be rolled
  // into it and the row reconciled. Nothing is pushed, landed or opened as a PR; the route says which gate refused.
  const startTurnover = e.target.closest(".btn-start-turnover");
  if (startTurnover) {
    e.stopPropagation();
    e.preventDefault();
    void startTurnoverContainer(startTurnover);
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
    // control this function does not know) must not turn into a jump. `summary` and `details` are here for the
    // review card's disclosure: the jump path calls preventDefault(), which would swallow the toggle itself.
    if (e.target.closest("button, a, input, select, textarea, label, summary, details")) return;
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
        const root = worktreeRootOf(cwd);
        if (sel && !sel.options.length) sel.innerHTML = worktreeOptionsHtml();
        // The picker's first answer is the tree the card is ALREADY in. When the board has no row for that tree,
        // it is still the tree the attach is about, so offer it by name (project · tree) at the top of the list
        // and select it, instead of opening on a disabled placeholder that names only the last path segment and
        // leaving every other tree as the only thing the reader can press. The option value is the real tree
        // path, so the press asks the server for that tree and the server's own refusal, if any, names it.
        if (
          sel &&
          root &&
          ![...sel.options].some((o) => o.value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === root.toLowerCase())
        ) {
          const own = document.createElement("option");
          own.value = root;
          own.textContent = `${projectOfTree(root) || "worktree"} · ${root.split("/").pop()} (not read)`;
          sel.insertBefore(own, sel.firstChild);
        }
        // Start from the tree the run is ACTUALLY in — its own `.worktrees/<name>` directory — and only then from the
        // agent's recorded owner. Never from "whatever the list happens to start with": the first option is the
        // project's own checkout, and a card for a run one directory down landed there with one press (job
        // 24695761).
        const want = matchWorktree(cwd)?.path || null;
        const owner = conv && (conv.latest.ownerPath || conv.first.ownerPath);
        const pick = (value) =>
          value ? [...sel.options].find((o) => !o.disabled && o.value.toLowerCase() === String(value).toLowerCase()) || null : null;
        const hit = pick(want) || (!root ? pick(owner) : null) || (root ? pick(root) : null);
        const go = fresh.querySelector("[data-attach-go]");
        if (sel) {
          if (hit) sel.value = hit.value;
          go?.removeAttribute("disabled");
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
  // The Retry on a parked entry: ask the panel to revive that one record, then let the drain try it once more.
  const queueRetry = e.target.closest("[data-queue-retry]");
  if (queueRetry) {
    e.preventDefault();
    e.stopPropagation();
    const thread = queueRetry.dataset.queueRetry;
    const at = Number(queueRetry.dataset.queueRetryAt) || 0;
    const entry = replyQueued(thread).find((x) => x && x.at === at);
    void retryHeldReply(entry, thread);
    return;
  }
  // Queue reply: hold the text (do not send) because a turn is running on this thread.
  const queueBtn = e.target.closest("[data-queue-reply]");
  if (queueBtn) {
    e.preventDefault();
    e.stopPropagation();
    // The same press Ctrl/Cmd+Enter makes: one function, so the button and the keystroke cannot drift apart.
    void queueReplyFromBox(queueBtn.dataset.queueReply);
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
  // A thinking row: clipped to a few lines in the console, a press opens the whole thought in place. A press that
  // was the end of a drag-select is a selection, not a fold, exactly like the call rows below.
  const thinkRow = e.target.closest?.(".jl-think[data-think-row]");
  if (thinkRow) {
    const picked = document.getSelection ? document.getSelection() : null;
    if (picked && !picked.isCollapsed && picked.containsNode && picked.containsNode(thinkRow, true)) return;
    e.preventDefault();
    e.stopPropagation();
    const lid = String(thinkRow.dataset.lid || "");
    if (!lid) return;
    const open = !thinkRow.classList.contains("is-open");
    if (open) holdConsoleFor(thinkRow);
    thinkRow.classList.toggle("is-open", open);
    thinkRow.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) thinkOpenRows.add(lid);
    else thinkOpenRows.delete(lid);
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
        // The row IS its box's opener. What sits behind a row is a console box like any other - open, with its head
        // still able to fold it - because the box is the same one the condensed view draws, and a reader who opened
        // the row asked to see what the call returned, not for a second thing to click. So the box's own book is
        // written here as if its head had been pressed: one action, one box, and the box still folds on any press.
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
  // A result box inside a burst: a tool's output, and every command card in a reply. THE WHOLE BOX IS THE HANDLE -
  // a press anywhere inside it folds or unfolds it, because the frame no longer tells the reader to click its head
  // (core/console-format.js) and a two-row body with a 20px strip of buttons above it is a card that reads as inert.
  // The head is still a real button: Tab reaches it, Enter and Space press it, and it carries aria-expanded, which
  // the one branch below keeps honest for either kind of press. The fold is remembered by key (the burst plus the
  // segment), because every rebuild replaces this markup and a box that snapped shut under the cursor would read as
  // the panel losing the click. Which book it is written in depends on the box: every box starts folded and the book
  // holds the ones that were opened; the one drawn open because the reader asked for it (data-code-inverted - the
  // whole stored text a fold note reads) is the other way round.
  const codeFold = e.target.closest("[data-code-fold]") || codeBoxHit(e);
  if (codeFold) {
    e.preventDefault();
    e.stopPropagation();
    const box = codeFold.closest(".code-box");
    const body = box && box.querySelector(".code-body");
    if (body) {
      // A clamped card (`data-code-clamp`) shows its body folded to N lines rather than shut, so its own state is
      // the class and never `hidden`: folding it back re-clamps it and the body stays on the page. Every other box
      // is the shut one it has always been, and asks `hidden` as it always did.
      const clamp = Number(box.dataset.codeClamp) || 0;
      const open = clamp ? !box.classList.contains("is-open") : body.hidden;
      // Opening this result hands the console over: the view stays on the line the reader was reading, instead of
      // sliding to the bottom of the output that just unfolded (Settings > Agent cards, off by default).
      if (open) holdConsoleFor(codeFold);
      if (clamp) {
        body.hidden = false;
        box.classList.toggle("is-clamped", !open);
      } else {
        body.hidden = !open;
      }
      box.classList.toggle("is-open", open);
      // The folded card's last preview row ends with three ASCII dots and no earlier row does: opening the card puts
      // the whole prompt back, folding it measures and marks it again (public/board/console.js holds the painter, and
      // the same one runs for every card a render path places).
      if (clamp && typeof clearCommandFoldMark === "function") {
        if (open) clearCommandFoldMark(box);
        else paintCommandFoldMark(box);
      }
      codeFold.setAttribute("aria-expanded", open ? "true" : "false");
      const caret = codeFold.querySelector(".code-caret");
      if (caret) caret.textContent = open ? "▾" : "▸";
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
    const box = toBottom.closest(".out-wrap")?.querySelector("pre.job-out");
    if (box) {
      // Ask for the tail explicitly: the jump is the reader's, so the console must stop holding its old
      // position and follow the newest line again.
      pinConsole(box.dataset.out);
      setScroll(box, box.scrollHeight);
      // In the docked Chat pane (and a maximized card) the console cannot scroll: the card's session scroller does,
      // and the chip is drawn on the newest console for exactly this press. The reader's own jump re-pins it, so the
      // next streamed line follows again.
      const body = cardBodyOf(box);
      if (body) {
        body._atBottom = true;
        setScroll(body, body.scrollHeight);
      }
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
    // The card the press came from travels with the choice, so the repaint lands under the pointer even when the same
    // thread is drawn somewhere else as well.
    setThinking(thread, !thinkingOn(thread), thinkBtn.closest(".job[data-thread]"));
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
    await steerFromBox(steerBtn.closest(".job")?.dataset.thread || "", steerBtn.dataset.steer, steerBtn);
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

// ---- focus mode: the trees a live panel is working in ------------------------------------------
//
// A double-click on the TOP HEADER BAR toggles a narrowed board: only the worktree rows whose tree has at least one
// live panel are drawn, each one under its own project, and a project with no such row is hidden. The evidence is the
// job list the page already polls - `state.jobs`, filled by the snapshot and every job frame (GET /api/jobs serves
// the same records) - so the mode adds no flag to a row, no second endpoint and no clock of its own. It is a VIEW:
// the answer moves when a turn starts or stops, which is exactly when the page already repaints.
//
// The tree is read from the job's OWN `worktreePath`, never from `cwd` or `ownerPath`: a card attached by the old
// fallback carries the checkout that CONTAINS its tree, and believing that would keep a parent's row alive for a run
// in a child. Paths are compared whole, after slash and case normalisation, so `/a/b-c` never matches `/a/b`.
//
// A run in a project's own checkout carries no `worktreePath` at all - nothing was cut for it - and the checkout row
// is exactly the row it is working in, so dropping it hid the very project a live turn was running in. It is resolved
// by `focusCheckoutTreesOfJob` instead, and the row kept is that project's CHECKOUT row, never a tree cut from it.

// The tree a job is in, normalised for comparison, or "" when the record carries none. A job with no worktree path
// carries no tree of its own: the caller resolves it to a checkout (`focusCheckoutTreesOfJob`) or keeps nothing.
function focusTreeOfJob(job) {
  const p = job?.worktreePath;
  return typeof p === "string" && p.trim() ? normPath(p).toLowerCase() : "";
}

// Every project's checkout, normalised ONCE per repaint. The resolution below is asked per pathless job, and a board
// this size carries 300 of them against 177 projects: normalising a project path inside that loop would be 53,000
// regex replaces per job event, on a stream that fires per token.
function focusCheckouts() {
  const out = [];
  for (const [project, record] of state.projects) {
    const root = normPath(record?.path || "");
    if (!root) continue;
    out.push({
      at: root.toLowerCase(),
      dir: (root.split("/").filter(Boolean).pop() || "").toLowerCase(),
      name: String(project).trim().toLowerCase(),
    });
  }
  return out;
}

// The CHECKOUT a pathless job is working in, as a list of normalised tree paths, empty when the record names none.
//
// Two shapes of pathless record are answered for, and both resolve to a PROJECT'S CHECKOUT ROW, never to a tree cut
// from one:
//
//   1. the record's own `worktree` - the base name of the directory the run was handed (lib/jobs.js sets it when the
//      panel cuts a tree), which for a run in a checkout is the project's own folder. It is matched against the
//      PROJECTS and never against the rows, so a tree cut from a checkout, whose directory has a name of its own, can
//      never answer for a run in the parent.
//   2. the path the record does carry - `ownerPath` and `cwd` - but only where one of them IS a project's checkout,
//      whole and exact. This is the shape the store actually writes for a run it cut nothing for: `worktree` is null
//      on every one of them (measured on a live board: 301 pathless jobs, none carrying a name), so rule 1 alone
//      would leave the defect in place for the very runs it is about. Two guards keep it safe. Exact equality, not a
//      prefix, so no subdirectory of a checkout is ever taken for one; and a run whose own `cwd` or `ownerPath` sits
//      under `.worktrees` is a tree run whose path went missing, so it keeps nothing rather than the parent.
//
// Every project matching is answered for - two checkouts called `menu` cannot be told apart - and a record that names
// and points at nothing keeps nothing.
function focusCheckoutTreesOfJob(job, checkouts = null) {
  const named = String(job?.worktree || "").trim().toLowerCase();
  const filed = normPath(job?.ownerPath || "").toLowerCase();
  const ran = normPath(job?.cwd || "").toLowerCase();
  const trees = [];
  for (const { at, dir, name } of checkouts || focusCheckouts()) {
    if (named && (dir === named || name === named)) {
      trees.push(at);
      continue;
    }
    const inCutTree = `${at}/.worktrees/`;
    const atCheckout = filed === at || ran === at;
    if (atCheckout && !filed.startsWith(inCutTree) && !ran.startsWith(inCutTree)) trees.push(at);
  }
  return trees;
}

// The trees the narrowed board keeps: one live turn is a live panel. `turnLive` is the page's own status answer
// (running, starting, waiting, waiting_for_approval, queued - and a turn still parked on an approval).
function liveFocusTrees(jobs = null) {
  const trees = new Set();
  let checkouts = null;
  for (const job of jobs || state.jobs.values()) {
    if (!turnLive(job)) continue;
    const tree = focusTreeOfJob(job);
    if (tree) {
      trees.add(tree);
      continue;
    }
    checkouts = checkouts || focusCheckouts();
    for (const checkout of focusCheckoutTreesOfJob(job, checkouts)) trees.add(checkout);
  }
  return trees;
}

// Is this row one of them? Exact path equality, both sides through the same normaliser. `trees` is the kept set when
// the caller already holds one: a project asks for it once and answers every row from it.
function focusKeepsRow(row, trees = null) {
  const tree = normPath(row?.path || "").toLowerCase();
  return Boolean(tree) && (trees || liveFocusTrees()).has(tree);
}

function focusModeOn() {
  return Boolean(state.focusMode);
}

// A row the mode does not draw leaves the document the way a row the chart holds below its top N does: state, chips
// and agents still know it, only the drawing is narrowed.
function focusHidesRow(row) {
  return focusModeOn() && !focusKeepsRow(row);
}

// A project belongs to the narrowed board while at least one of its rows does. Counted from state.rows rather than
// from the document, so a collapsed project (which has no row nodes) answers exactly like an open one.
function projectHasFocusRow(name, trees = null) {
  const set = trees || liveFocusTrees();
  for (const row of state.rows.values()) if (row.project === name && focusKeepsRow(row, set)) return true;
  return false;
}

// A project the board DRAWS open. Focus mode force-expands every section that holds a live row: the mode is a list of
// the trees a live panel is working in, and a project left folded would hide the very rows the list exists to show.
// This reads the two records and writes neither, so `expandedProjects` keeps the reader's own folds for the way out.
function projectDrawsOpen(name) {
  return state.expandedProjects.has(name) || (focusModeOn() && projectHasFocusRow(name)) || (reviewModeOn() && projectHasReviewRow(name));
}

// ---- the review lane's filter --------------------------------------------------------------------------------
// The header count filters the table to exactly the rows it counted. It is a second narrowing beside focus mode and
// the chart's top N, and it OVERRIDES both: the lane's promise is "these rows, all of them", so an awaiting row that
// the chart held back or focus mode hid is still drawn while the filter is on. Everything else is narrowed away.
function reviewModeOn() {
  return Boolean(state.reviewMode);
}

// A row the filter hides: any row that is not awaiting a check. When the filter is off nothing is hidden by it.
function reviewHidesRow(row) {
  return reviewModeOn() && !wtReviewLane.awaiting(row);
}

// A project belongs to the filtered table while at least one of its rows is awaiting, counted from state.rows rather
// than from the document, so a folded project answers exactly like an open one.
function projectHasReviewRow(name) {
  for (const row of state.rows.values()) if (row.project === name && wtReviewLane.awaiting(row)) return true;
  return false;
}

// THE ONE ANSWER to "does the table draw this row". Two narrowings, in a fixed order: the review filter wins when it
// is on (and overrides the chart's hold and focus mode), and otherwise the chart's top N and focus mode decide. Both
// places that build rows - placeRow and renderProjectRows - ask this, so an incremental paint and a full rebuild
// cannot disagree about which rows are on screen.
function tableHidesRow(row) {
  if (reviewModeOn()) return !wtReviewLane.awaiting(row);
  return rowTopHidden(row) || focusHidesRow(row);
}

// Is this row DRAWN open? While the mode is on no row is: the narrowed board is one line per live tree, and the
// reader's own open rows come back when the mode goes off, because the mode never touches `state.expanded`.
function rowDrawsOpen(key) {
  return !focusModeOn() && state.expanded.has(key);
}

function paintFocusSection(name) {
  const sec = projectNode("data-project", name);
  if (!sec) return;
  sec.classList.toggle("is-focus-out", focusModeOn() && !projectHasFocusRow(name));
}

function paintFocusSections() {
  for (const name of state.projects.keys()) paintFocusSection(name);
}

// The kept set as one string: a turn starting or stopping moves it, a card's progress inside a turn does not.
function focusSignature(trees = null) {
  return [...(trees || liveFocusTrees())].sort().join("|");
}

// A turn starting or stopping changes which trees the narrowed board draws, and no row is rebuilt for it. Repaint
// only when the SET moved: repainting every project on every event would cost a full board rebuild per token.
function repaintFocus() {
  if (!focusModeOn()) return;
  const sig = focusSignature();
  if (sig === state.focusSig) return;
  state.focusSig = sig;
  for (const name of state.projects.keys()) {
    renderProjectRows(name);
    paintFocusSection(name);
    // A project that has just gained or lost its last live row changes the fold the board draws it with, and the
    // section's own class is what shows or hides the rows: repaint it from the same answer the rows were built on.
    applyProjectCollapse(name);
    refreshChips(name);
  }
  reorderProjects();
}

// Every open worktree row folds on the way in: the mode is a list of live trees, and an open row would otherwise keep
// a console (and the rebuild that goes with it) inside the narrowed board. Only the NODES come down here - the record
// (`state.expanded`) is the reader's own layout and the way back out redraws it, so the mode never clears it.
function foldOpenRowNodes() {
  clearEveryCollapseCascade();
  for (const key of [...state.expanded]) {
    state.detailEls.get(key)?.remove();
    state.detailEls.delete(key);
    state.rowEls.get(key)?.classList.remove("expanded");
  }
}

function setFocusMode(on, { announce = true } = {}) {
  const want = Boolean(on);
  if (want === focusModeOn()) return;
  state.focusMode = want;
  state.focusSig = "";
  if (want) foldOpenRowNodes();
  document.body?.classList.toggle("focus-mode", want);
  const bar = document.querySelector(".topbar");
  if (bar) {
    bar.title = want
      ? "focus mode: only the worktrees with a live panel are drawn - every project holding one is expanded, with its rows listed minimized - double-click this bar to show every worktree again"
      : "double-click this bar to show only the worktrees with a live panel (focus mode)";
  }
  for (const name of state.projects.keys()) {
    renderProjectRows(name);
    paintFocusSection(name);
    // The section template is not rebuilt here, so its `collapsed` class is applied from the same answer the rows
    // were built on: a project the mode force-expands has to lose the class that hides its chart.
    applyProjectCollapse(name);
  }
  reorderProjects();
  if (announce) {
    showBanner(
      want
        ? "focus mode: only worktrees with a live panel are drawn - every project holding one is expanded, with its rows listed minimized - double-click the header bar to show every worktree"
        : "focus mode off: every worktree is drawn again",
    );
  }
}

function toggleFocusMode() {
  setFocusMode(!focusModeOn());
}

// The header's double-click, registered after the model readout's own listener above. It returns for anything that is
// not the top bar, so the readout keeps its event and a single click on it stays a single click; inside the bar it
// also leaves the bar's own controls alone, so Assistant/Settings keep their double-clicks too.
function onHeaderDoubleClick(e) {
  if (!e?.target?.closest) return;
  if (!e.target.closest(".topbar")) return;
  if (e.target.closest("button, a, input, select, textarea, label, #title-settings")) return;
  e.preventDefault();
  e.stopPropagation();
  toggleFocusMode();
}
document.addEventListener("dblclick", onHeaderDoubleClick);
// ---- end focus mode

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
  // Esc closes an open drop-all confirm before any other Escape gesture reads it: the confirm is a question, and a
  // question that Escape walked past would leave the page asking it behind whatever closed instead.
  if (e.key === "Escape") {
    const asking = document.querySelector("[data-cleanup-confirm]");
    if (asking) {
      e.preventDefault();
      closeCleanupDropAllConfirm(asking.dataset.cleanupConfirm);
      return;
    }
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
  // A box with a press IN FLIGHT is closed, and no key here is a gesture on it: the guard is the same one
  // queueReplyFromBox asks, so the keyboard cannot reach a state the button refuses. A HELD reply no longer closes
  // the box - the next message is typed there and held as its own entry - so only the press's own flight can put a
  // keystroke out of reach.
  if (queuePressInFlight(box.dataset.reply)) return;
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
    void steerFromBox(box.dataset.reply, null, box);
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
      void queueReplyFromBox(thread);
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
        await steerTurn(thread, running.id, text, box);
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
    // see it the moment they take the console over. A scroll the panel itself caused (a stick to the tail, a
    // restore) is skipped below - the chip is already off for it, and measuring there would put a box read back on
    // the per-line path that this report's cause 3 is about.
    if (pre && pre.classList && pre.classList.contains("job-out")) {
      // The panel's own stick scroll is not the reader taking the box over: the chip is already off (paintAtEnd said
      // so), and measuring the box here is what made every streamed line read geometry. A reader's scroll is still
      // answered the moment it happens, which is why this is not left to the 400 ms pass.
      if (!selfScrolled.has(pre) && !justPlaced(pre)) paintToBottom(pre);
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
    // The card's session scroller: the docked Chat pane and a maximized card, where `.job-body` is the only box that
    // scrolls. It is not a console - nothing is appended to it directly, but everything inside it grows - so all it
    // has to answer is whether the reader is still at its foot, which is the answer `stickCardBodySoon` reads before
    // it moves anything. A write the panel made itself is not the reader leaving the bottom (the same two exclusions
    // every box above uses), and the pane's chip is repainted here so it appears the moment the reader takes over.
    if (pre && pre.classList && pre.classList.contains("job-body")) {
      if (selfScrolled.has(pre) || justPlaced(pre)) {
        selfScrolled.delete(pre);
        return;
      }
      if (readerInputHere(pre)) noteCardBodyScroll(pre);
      const chip = cardTailConsole(pre);
      if (chip) paintToBottom(chip);
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
// And only boxes that GREW since this pass last looked: one that did not cannot have left its reader behind, so a
// still page pays a comparison per box and no layout at all. The measured 60 calls and 44.7 ms a streaming window
// spent here were this pass measuring boxes that had not moved.
setInterval(() => {
  for (const pre of placedNodes("pre.job-out")) {
    const grewSince = pre._sweepGrow !== pre._grow;
    pre._sweepGrow = pre._grow;
    if (grewSince) {
      // A console under the reader's own corner gesture is not re-pinned: the box belongs to the pointer for the
      // length of the drag, and a scroll that lands mid-gesture is one of the things that made the corner feel
      // unsteady.
      if (outDragging(pre)) continue;
      stickConsole(pre);
      // Stuck to the tail by the page itself, so the chip is off: said, not measured (see paintAtEnd).
      paintAtEnd(pre);
      continue;
    }
    // The one case the paint path cannot answer: a console the reader took over. Its chip is told the truth here -
    // at most twice a second, and only while somebody is actually reading back through a streaming turn.
    if (pre._chipDirty) paintToBottom(pre);
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
  },
  { capture: true, passive: true },
);

// The owner column's chip is the way INTO that assistant's chat. It is delegated from the document because the same
// cell is drawn by two tables - the board's chart and the assistant's own Worktrees tab, which reuses this row
// builder - and neither table owns the chat: public/assistant.js does, and publishes the opener. The press starts the
// reader's sentence from the row's own project, worktree and branch, puts the caret at the end, focuses the box, and
// sends nothing (window.__assistantRegarding says the same in its own comment).
document.addEventListener("click", (e) => {
  const chip = e.target.closest?.("[data-owner-assistant]");
  if (!chip) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof window.__assistantRegarding !== "function") return;
  window.__assistantRegarding({
    assistantId: chip.dataset.ownerAssistant,
    project: chip.dataset.ownerProject,
    worktree: chip.dataset.ownerWorktree,
    branch: chip.dataset.ownerBranch,
  });
});

// THE INITIATIVE CHIP IS THE WAY INTO THE INITIATIVES MAP. render-projects.js draws one chip per initiative in the
// chart's initiative column (and the assistant's Worktrees tab reuses that row builder); the map itself belongs to
// public/assistant.js, so that file publishes the opener. A press opens the float if it is shut, brings the
// Initiatives tab on screen, unfolds THAT initiative's card, scrolls it into view and flashes it once
// (window.__assistantOpenInitiative says the same in its own comment).
//
// IT IS A CHIP, NOT A BUTTON, so the keyboard is wired by hand: the span carries role="button" and a tabindex, and
// Enter or Space make the same press a click makes - Space with preventDefault, or the page scrolls out from under
// the card the press just opened. The click listener is in the CAPTURE phase because the chip sits inside a chart row
// whose own delegated press (on #projects, below) folds the row: a bubbling listener here would run after that fold
// and take the press second.
const initiativeChipOf = (e) => (e.target?.closest ? e.target.closest(".initiative-chip[data-initiative-id]") : null);
function pressInitiativeChip(chip) {
  // A page whose assistant half has not parsed yet still folds nothing and throws nothing: the chip is a plain span
  // until the opener exists, and the next press works.
  if (typeof window.__assistantOpenInitiative !== "function") return;
  window.__assistantOpenInitiative(chip.dataset.initiativeId);
}
document.addEventListener(
  "click",
  (e) => {
    const chip = initiativeChipOf(e);
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    pressInitiativeChip(chip);
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    if (e.repeat) return;
    const chip = initiativeChipOf(e);
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    pressInitiativeChip(chip);
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
  // A press that was the end of a drag-select is a selection, not a fold - the same rule a call block's caret keeps
  // (`[data-call-fold]` above). The name and branch cells are the only selectable cells in a row (chart.css line 38),
  // and public/core/copy-full-value.js answers a highlight there with the whole value, so folding on the release
  // would open a detail block every time a reader takes a name. Only the FIRST click of a sequence is skipped: a
  // double-click's second click still folds, so its net effect is what it always was, and a plain click (whose
  // mousedown collapsed the selection) still expands.
  if (e.detail === 1 && document.getSelection) {
    const picked = document.getSelection();
    if (picked && !picked.isCollapsed && picked.containsNode && picked.containsNode(tr, true)) return;
  }
  const key = tr.dataset.key;
  const row = state.rows.get(key);
  if (!row) return;
  // A container row is a BRANCH, not a worktree: its detail would be a Merge state and an agents block for a directory
  // that does not exist. Say what the row is for instead of opening an empty one.
  if (row.placeholder) {
    showBanner(`${row.branch} is a turnover branch with no worktree yet - press start to make the container tree; there is nothing to read until then`);
    return;
  }
  keepInPlace(
    () => document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`),
    () => {
      // Focus mode lists one line per live tree and keeps every row minimized. A toggle here would open a detail the
      // mode does not draw, and closing one would delete a row from the reader's own layout - which is the layout the
      // mode promises to give back. Say which gesture does what instead of writing a state the picture cannot show.
      if (focusModeOn()) {
        showBanner("focus mode keeps every worktree row minimized - double-click the header bar to show the board and open this row");
        return;
      }
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
  for (const cell of document.querySelectorAll("td.age, td.nextread")) {
    const row = state.rows.get(cell.dataset.key);
    if (!row) continue;
    if (cell.classList.contains("nextread")) paintNextReadCell(cell, row);
    else paintLifeCell(cell, row);
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
    // The console's marching tail wears the same pill (console.js marchRowHtml) and keeps its OWN clock: this loop is
    // the card's heartbeat, and rewriting the tail from it took the march's classes and dots away every second.
    for (const el of card?.querySelectorAll(".live-pulse:not([data-march])") || []) {
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
  // A heartbeat proves transport health, not data completeness. Even a busy stream needs periodic anti-entropy;
  // an unhealthy stream retries on this 30s clock, and overlapping automatic reads share one request.
  const shouldResync = globalThis.wtLive?.shouldResync ? globalThis.wtLive.shouldResync({
    lastTransportAt: state.lastTransportAt,
    lastSnapshotAt: state.lastSnapshotAt,
    streamOpen: state.es?.readyState === 1,
    awaitingStreamSnapshot: state.awaitingStreamSnapshot,
    paused: state.paused,
  }) : state.awaitingStreamSnapshot || state.es?.readyState !== 1 ||
    !state.lastTransportAt || Date.now() - state.lastTransportAt > 20000 ||
    !state.lastSnapshotAt || Date.now() - state.lastSnapshotAt >= 120000;
  // A live turn is exactly when the reader is waiting for the first reasoning line: a whole
  // /api/state read here rebuilds every card and replaces the node the thinking pane is
  // painting into. While a turn is running and the stream is OPEN, the line stream and the
  // faster thinking poll are already carrying the fresh state, so anti-entropy can wait
  // until the turn settles.
  const liveTurn = [...state.jobs.values()].some((j) => turnLive(j));
  if (shouldResync && !(liveTurn && state.es?.readyState === 1)) void resync({ automatic: true });
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
  if (!document.hidden && !state.paused) void resync({ automatic: true });
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

// ---- the header's landing helpers --------------------------------------------------------------
// These three were board/hot.js. Every header popover that lands on a card uses them: open the path (hotOpenPath),
// find the row a thread lives in (hotRowFor) and ring the card amber (flashHotCard, kept in state.hotFlash so a
// repaint re-applies it).
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
  // STATE FIRST, THE NODE SECOND. The renderer stamps `hot-flash` from state.hotFlash on every pass (render-jobs.js
  // jobHtml), so a card the board has not placed yet - or has just replaced under the reader - still flashes when it
  // is drawn. Setting the state only after finding the node made the flash depend on that lookup winning a race with
  // a repaint, and the losing case was a landing that rang the turn with no flash at all.
  const until = Date.now() + 1300;
  state.hotFlash = { thread, until };
  clearTimeout(state.hotFlashTimer);
  state.hotFlashTimer = setTimeout(() => {
    state.hotFlash = { thread: null, until: 0 };
    document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)?.classList.remove("hot-flash");
  }, 1300);
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return;
  card.classList.remove("hot-flash");
  void card.offsetWidth; // restart it even when the last flash is still fading
  card.classList.add("hot-flash");
}

// ---- the header's REVIEW control ----------------------------------------------------------------------------
// One count of the rows awaiting review, and the filter that shows exactly those rows. The count is read from
// state.rows through public/core/review-lane.js, the same list the table draws, so the number and the rows it filters
// to are the same number by construction: a delivery whose tree was archived or deleted is not a row, and is not
// counted here whatever the store still holds.
//
// ZERO IS QUIET, the same rule every header count follows: no badge, no amber, and a button that says the lane is
// empty
// rather than one that looks broken.
function paintReviewChip() {
  const btn = $("btn-review");
  if (!btn) return;
  const n = wtReviewLane.count(state.rows.values());
  const badge = $("review-badge");
  const label = $("review-label");
  const all = $("btn-review-all");
  const on = reviewModeOn();
  if (badge) {
    badge.hidden = n === 0;
    badge.textContent = String(n);
  }
  if (label) label.textContent = on ? `▣ Review ${n}` : "▣ Review";
  btn.classList.toggle("has-review", n > 0);
  btn.classList.toggle("is-on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = n
    ? `Review — ${n} finished row${n === 1 ? "" : "s"} whose result you have not checked yet. This is the header's one count of results to read. ${on ? "The table is filtered to them now: click to show everything again." : "Click to filter the table to exactly these rows."} Each row carries an amber ▣ — not the yellow lock and not the blue turnover mark — with ✓ Reviewed beside it, and a one-line result chip: the first clause of the run's summary, its age and whether it has been checked. The chip opens the card behind it — the whole summary, the report as a real link, and its next steps as chips — without adding a line to the row. Mark all reviewed clears the batch in one press.`
    : `Review — nothing is waiting for a check: no finished row on this board has a result you have not seen. This is the header's one count of results to read${on ? "; the filter is on, so the table is showing nothing - click to show every row again" : ""}. A row lands here when a run ends with something to read, and leaves when you press ✓ Reviewed.`;
  if (all) {
    all.hidden = !(on && n > 0);
    all.textContent = `Mark all ${n} reviewed`;
  }
}

// The filter's own repaint: a STRUCTURAL rebuild, because the narrowing is a property of each section too - a project
// that holds none of the lane's rows goes quiet, and one the lane forces open has to be drawn open (its class comes
// from projectDrawsOpen). An incremental row paint cannot change a fold, so this is the one path that rebuilds the
// sections.
function paintReviewTable() {
  paintReviewChip();
  renderAll();
  reorderProjects();
  renderJobs();
}

function toggleReviewFilter() {
  state.reviewMode = !state.reviewMode;
  paintReviewTable();
  const n = wtReviewLane.count(state.rows.values());
  showBanner(
    state.reviewMode
      ? n
        ? `Review: showing the ${n} row${n === 1 ? "" : "s"} awaiting a check — press H to step into one, or ✓ Reviewed to clear it`
        : "Review: nothing is awaiting a check — the table is empty while the filter is on; click Review again for every row"
      : "Review: every row is shown again",
  );
}

$("btn-review")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleReviewFilter();
});

$("btn-review-all")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  await reviewPress({ op: "review-all" });
});

// One press, one route. `reviewed` clears the row it names; `review-all` clears the batch. Both answer with the new
// count and the row itself, so a page whose socket is asleep still paints the truth from the answer.
async function reviewPress({ op, path = null, project = null, key = null }) {
  const body = { op };
  if (path) body.path = path;
  if (project) body.project = project;
  try {
    const r = await apiFetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) {
      showBanner(`${op === "review-all" ? "Mark all reviewed" : "Reviewed"}: ${d.error || `HTTP ${r.status}`}`);
      return false;
    }
    // THE ANSWER IS PAINTED AS WELL AS THE SNAPSHOT. The route sends the full snapshot to every page and this one
    // also holds the row it just changed; painting both means a reader never sees the amber mark a second after
    // pressing it, however the socket is behaving.
    if (d.row && key) placeRow(project, { ...d.row, project, path: d.row.path || path });
    else if (key) {
      const row = state.rows.get(key);
      if (row) {
        // The row's own record is the delivery's home: stamp it here so the marker, the card and the count agree even
        // before the snapshot arrives.
        row.review = d.row || (row.review ? { ...row.review, reviewedAt: new Date().toISOString(), awaiting: false } : row.review);
        placeRow(row.project, row);
      }
    }
    paintReviewTable();
    showBanner(d.message || (op === "review-all" ? "Marked reviewed" : "Reviewed"));
    return true;
  } catch (err) {
    showBanner(`${op === "review-all" ? "Mark all reviewed" : "Reviewed"}: ${err.message || err}`);
    return false;
  }
}

document.addEventListener("click", async (e) => {
  const done = e.target.closest("[data-review-done]");
  if (!done) return;
  e.preventDefault();
  e.stopPropagation();
  const key = done.dataset.reviewDone;
  const project = done.dataset.reviewProject || null;
  const path = done.dataset.reviewPath || state.rows.get(key)?.path || null;
  if (!path) return;
  done.disabled = true;
  const ok = await reviewPress({ op: "reviewed", path, project, key });
  // A refused press must leave the button pressable: the row is still awaiting and the reader has to be able to ask
  // again (the answer may have been a lock on the store, not a decision).
  if (!ok && done.isConnected) done.disabled = false;
});

// THE RULING PRESSES. A collision card carries its own controls (`data-collision-rule` with a pick of a/b/clear, and
// `data-collision-ask`), drawn under BOTH rows. One route, `/api/collisions`, answers with the pair's new state; the
// page paints it onto every row that carries the pair and repaints the board and the button, so a reader who presses
// "coll-two goes first" sees the second row's card say the same thing in the same frame, without waiting for a socket.
async function collisionPress({ op, key, pick = null }) {
  if (!key) return false;
  try {
    const r = await apiFetch("/api/collisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, key, pick }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) {
      showBanner(`Collision: ${d.error || `HTTP ${r.status}`}`);
      return false;
    }
    if (d.record) applyCollisionRecord(d.record);
    renderAll();
    showBanner(d.say || (pick === "clear" ? "Ruling withdrawn - the pair goes back to the assistants" : "Ruled"));
    return true;
  } catch (err) {
    showBanner(`Collision: ${err.message || err}`);
    return false;
  }
}

// One record, every row that carries it. The route answers with the pair as the store now holds it; each row's copy
// also knows which side it is (`other`, `role`), so only the fields the ruling owns are overwritten - a row is never
// handed the other row's counterpart.
function applyCollisionRecord(rec) {
  if (!rec || !rec.key) return;
  for (const row of state.rows.values()) {
    const list = Array.isArray(row.collisions) ? row.collisions : [];
    const i = list.findIndex((c) => c && c.key === rec.key);
    if (i < 0) continue;
    list[i] = {
      ...list[i],
      state: rec.state,
      ruling: rec.ruling || null,
      canAsk: !!rec.canAsk,
      // git's own answer travels with the press too: the card says WHY this one is the reader's.
      merge: rec.merge || list[i].merge || null,
      // Both sides travel with the answer, so the card on this row can still name the counterpart (and its task)
      // after a press: a pair is ONE record and both rows draw it.
      a: rec.a || list[i].a || null,
      b: rec.b || list[i].b || null,
      files: Array.isArray(rec.files) ? rec.files : list[i].files,
      relations: Array.isArray(rec.relations) ? rec.relations : list[i].relations,
      stoodDown: Array.isArray(rec.stoodDown) ? rec.stoodDown : list[i].stoodDown,
      readerAt: rec.readerAt || list[i].readerAt,
    };
  }
}

document.addEventListener("click", async (e) => {
  const rule = e.target.closest("[data-collision-rule]");
  const ask = rule ? null : e.target.closest("[data-collision-ask]");
  if (!rule && !ask) return;
  e.preventDefault();
  e.stopPropagation();
  const el = rule || ask;
  el.disabled = true;
  const ok = rule
    ? await collisionPress({ op: "rule", key: rule.dataset.collisionRule, pick: rule.dataset.collisionPick })
    : await collisionPress({ op: "ask", key: ask.dataset.collisionAsk });
  if (!ok && el.isConnected) el.disabled = false;
});

/**
 * ONE PAINTING CODE for the header's counting buttons. Every one of them says the same thing the same way: the badge
 * carries the number and is hidden at ZERO (a quiet button, never a broken-looking one), and a class is the highlight
 * that says something is waiting. Only the colour is the caller's - purple for Clarify, violet for Collisions, amber
 * for Permissions - because the
 * colour is the meaning and the shape is not. Returns the number painted, so a caller can word its title from the same
 * count it just drew.
 */
function paintCountBadge(btn, badge, count, cls = "has-waiting") {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (badge) {
    badge.hidden = n === 0;
    badge.textContent = String(n);
  }
  if (btn && cls) btn.classList.toggle(cls, n > 0);
  return n;
}

// The prose the markup ships on the button, captured once: every repaint prefixes the count to the SAME sentence, so a
// title does not grow a new prefix each time the number changes.
const CLARIFY_PROSE = String(document.getElementById("btn-clarify")?.title || "").trim();

// The header button's count: how many CLARIFY ITEMS are still waiting on an answer. The number comes from
// public/clarify-history.js (`clarifyPendingCount`), which reads `outstanding` off the history route - items whose
// state is "open", so three asks of one question count one and an answered, cancelled or timed-out item counts
// nothing. Painted by `paintCountBadge`, in the button's own purple.
let clarifyBadgeSig = "";
function paintClarifyButton() {
  const btn = $("btn-clarify");
  if (!btn) return;
  const n = typeof clarifyPendingCount === "function" ? clarifyPendingCount() : 0;
  paintCountBadge(btn, $("clarify-badge"), n, "has-unanswered");
  // The count is the only thing in this button that changes, so the same count must not rewrite the title every tick.
  const sig = String(n);
  if (sig === clarifyBadgeSig) return;
  clarifyBadgeSig = sig;
  btn.setAttribute(
    "aria-label",
    n
      ? `Clarify - ${n} question${n === 1 ? "" : "s"} waiting on you. ${CLARIFY_PROSE}`.trim()
      : `Clarify - nothing is waiting on you: every question this panel asked has an answer, a reason or a reply. ${CLARIFY_PROSE}`.trim(),
  );
  // WHAT A PRESS DOES, with the count in front of it so a reader who hovers the button can tell "nothing waiting" from
  // "I have not looked yet" without opening it.
  btn.title = n
    ? `Clarify - ${n} question${n === 1 ? "" : "s"} waiting on you. ${CLARIFY_PROSE}`.trim()
    : `Clarify - nothing is waiting on you. ${CLARIFY_PROSE}`.trim();
}

// The Collisions button's count: how many PAIRS are waiting on a person. The number comes from
// public/collision-history.js (`collisionPendingCount`), which reads `waiting` off /api/collisions/history - the store's
// own predicate (`lib/collisions.js` `waitingOf`: state reader, no finished side). An auto-ruled pair, a land order, a
// superseded pair and a verdict all count ZERO: that is the whole point of this button, and the reason it is not the
// count. Painted by `paintCountBadge`, as Clarify's and Permissions' are, in the collision violet.
const COLLISIONS_PROSE = String(document.getElementById("btn-collisions")?.title || "").trim();

let collisionsBadgeSig = "";
function paintCollisionsButton() {
  const btn = $("btn-collisions");
  if (!btn) return;
  const n = typeof collisionPendingCount === "function" ? collisionPendingCount() : 0;
  paintCountBadge(btn, $("collisions-badge"), n, "has-waiting");
  // The count is the only thing in this button that changes, so the same count must not rewrite the title every tick.
  const sig = String(n);
  if (sig === collisionsBadgeSig) return;
  collisionsBadgeSig = sig;
  const line = n
    ? `Collisions - ${n} pair${n === 1 ? "" : "s"} waiting on you: two live trees touching the same work, which nothing has stopped yet but which will cost one of them its edits if nobody rules.`
    : `Collisions - nothing is waiting on you: every pair this panel has seen is settled by a rule, a landing or a verdict. Auto-ruled pairs are in the history, never in this count.`;
  btn.setAttribute("aria-label", `${line} ${COLLISIONS_PROSE}`.trim());
  btn.title = `${line} ${COLLISIONS_PROSE}`.trim();
}

// The Permissions button's count: how many permission requests are WAITING on a person. The number comes from
// public/permissions-history.js (`permissionsPendingCount`), which counts the live requests /api/state carries in
// `approvals` - the same map the approval dock counts - so a request that was answered or whose window closed
// counts nothing. Painted by `paintCountBadge`, as Clarify's and Collisions' are, in the permission box's own amber.
const PERMISSIONS_PROSE = String(document.getElementById("btn-permissions")?.title || "").trim();

let permissionsBadgeSig = "";
function paintPermissionsButton() {
  const btn = $("btn-permissions");
  if (!btn) return;
  const n = typeof permissionsPendingCount === "function" ? permissionsPendingCount() : 0;
  paintCountBadge(btn, $("permissions-badge"), n, "has-waiting");
  // The count is the only thing in this button that changes, so the same count must not rewrite the title every tick.
  const sig = String(n);
  if (sig === permissionsBadgeSig) return;
  permissionsBadgeSig = sig;
  const line = n
    ? `Permissions - ${n} request${n === 1 ? "" : "s"} waiting on you.`
    : `Permissions - nothing is waiting on you: every request this panel held has an answer or a reason.`;
  btn.setAttribute("aria-label", `${line} ${PERMISSIONS_PROSE}`.trim());
  btn.title = `${line} ${PERMISSIONS_PROSE}`.trim();
}

// ---- the header's ACTIVE AGENTS marker ------------------------------------------------------------------------
// One amber bolt that is DRAWN ONLY WHILE AN AGENT IS WORKING, and the press that lands on one. It is the other half
// of the counts beside it: a permission or a clarify question is a run stopped until the reader answers, and this is
// everything
// burning right now. The evidence is the page's own job list - `state.jobs`, filled by the snapshot and every job
// frame, the same records the cards draw - read through public/core/hot-mark.js, so the button's existence, its
// count, its tooltip and the press cannot disagree about which agent is working.
//
// THE WORD IS ACTIVE; THE WIRE IS `hot`. The control read "Hot" before the rename, and its id (#btn-hot), its label
// and badge spans (#hot-label, #hot-badge), the module and the browser key kept those names on purpose: that is the
// stored key and the wire name the row said not to move, so existing state keeps reading. Only what a person sees
// changed.
//
// AND IT IS A SETTING. Whether the button is in the header at all is Settings > General > "Show the Active agents
// button in the floating header", which ships OFF: public/core/active-button.js owns that default and the one
// decision the paint asks (switched on AND an agent working). With it off the control is absent, never a grey or
// zero-badge placeholder.
//
// NOT A LOCK, NOT A TURNOVER MARK, NOT A SECOND REVIEW MARK. The row's yellow lock is a tree the reader pinned, the
// blue turnover mark is a branch relationship, the amber ▣ is a result to read; this is none of them - it is a
// control in the header, and its amber is the panel's own (#d29922), not the lock's #ffb454. A turn parked on a
// permission or a question is deliberately NOT active: that agent is waiting on the reader, and the header's
// Permissions or Clarify count is where it is counted. One question never shows up in two places.
// The name the reader knows an agent by: an assistant's own name, else the card's title, else the label, else the
// thread id. The Active agents bolt lands on an agent the reader has to recognise by the name the board shows, and
// `assistantSessionFor` is the one lookup that already knows that name.
function agentNameOf(thread) {
  const session = assistantSessionFor(thread);
  if (session) return session.name || thread;
  const job = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread);
  return (job && (job.title || job.label)) || thread || "an agent";
}

function hotAgents() {
  // A board agent, not the panel's own assistant: an assistant's turn has no worktree row and no card on this board,
  // and the board's agents are who a button in the header is about (the same line the Hot Agent search draws).
  const convs = conversations().filter((c) => !assistantSessionFor(c.thread));
  return wtHotMark.agents(convs).map((a) => ({
    ...a,
    name: agentNameOf(a.thread),
    // The tree it is working in, when the run was handed one: a run in a project's own checkout has no tree of its
    // own, and naming the checkout would claim a worktree that was never cut.
    where: baseNameOf(a.turn?.worktreePath || ""),
  }));
}

// The switch as this page holds it: read from the browser once, and moved by the Settings row's own change handler.
// Asked on every paint, so a row that writes it is honoured without a reload.
function activeButtonOn() {
  if (typeof state.hot.on !== "boolean") state.hot.on = wtActiveButton.read(localStorage);
  return state.hot.on;
}

function paintHotButton() {
  const btn = $("btn-hot");
  if (!btn) return;
  const on = activeButtonOn();
  const list = hotAgents();
  const at = state.hot.key ? list.findIndex((a) => a.key === state.hot.key) : -1;
  const sig = `${on ? "1" : "0"}|${list.map((a) => a.key).join(",")}|${at}`;
  if (sig === state.hot.sig) return;
  state.hot.sig = sig;
  // ZERO IS ABSENT, and so is a switched-off button. Every other header count is quiet at zero - a badge with no
  // number, a button that says the lane is empty - but this control IS the fact that an agent is working: with none
  // there is nothing to mark, and a grey bolt would be a claim about the board that is not true. The Settings row
  // says the same thing about the reader's own choice: off means the header does not carry it, not that it carries an
  // inert one. So the button comes and goes with the work and with that switch.
  btn.hidden = !wtActiveButton.show(list, on);
  const label = $("hot-label");
  // The rotation counter reads `⚡ Active 2/3`, and only while the press is inside the list.
  if (label) label.textContent = at >= 0 ? `⚡ Active ${at + 1}/${list.length}` : "⚡ Active";
  const badge = $("hot-badge");
  if (badge) {
    badge.hidden = list.length === 0;
    badge.textContent = String(list.length);
  }
  btn.classList.toggle("is-hot", list.length > 0);
  btn.setAttribute("aria-label", list.length ? `Active agents - ${list.length} working right now` : "Active agents - nothing is working right now");
  btn.title = wtHotMark.title(list);
}

// One press: the next working agent, wrapping past the last one, landed on the way the dock's own cards are - unfold
// the row, then jump to the card and flash it (public/app.js `revealAgentHome` -> `jumpToAgent`). The list is sampled
// here and not kept: the key and the list are re-read on every press, so an agent that finished between two presses
// hands the press to the one after it instead of opening a card that has stopped.
function hotStep() {
  // A switched-off button has no press: the row decides whether the control exists at all, so a press that arrives
  // while it is off (a queued click, or a chord a host shell replayed) lands on nothing rather than on a hidden
  // rotation the reader cannot see.
  if (!activeButtonOn()) return;
  const list = hotAgents();
  if (!list.length) {
    state.hot.key = null;
    state.hot.sig = "";
    paintHotButton();
    showBanner("Active agents: no agent is working right now");
    return;
  }
  const next = wtHotMark.step(list, state.hot.key);
  if (!next) return;
  state.hot.key = next.key;
  state.hot.sig = "";
  paintHotButton();
  revealAgentHome(next.thread);
  showBanner(
    `Active agents: ${list.length === 1 ? "1 agent is" : `${list.length} agents are`} working - landing on ${next.name}${next.where ? ` in ${next.where}` : ""}`,
  );
}

$("btn-hot")?.addEventListener("click", (e) => {
  e.stopPropagation();
  hotStep();
});

// ---- the ACTIVE AGENTS button's own settings row (Settings > General) -------------------------------------------
// The switch that decides whether the header draws the control at all. It is a BROWSER setting - the same store and
// the same one-key save path the Board tab's rows use (public/core/active-button.js holds the key and the default),
// so a reader who never opens it gets it off, and a browser that refuses storage still applies the press for this
// page. It is INDEPENDENT of the Hot Agent pen search beside the control: that search keeps its name, its glyph and
// Ctrl+Shift+Q whatever this says.
function paintActiveButtonSetting() {
  const box = $("general-active-button");
  if (box) box.checked = activeButtonOn();
}

$("general-active-button")?.addEventListener("change", (e) => {
  state.hot.on = wtActiveButton.write(localStorage, e.target.checked);
  // The paint is signature-guarded and the signature carries the switch, so the header changes on this press rather
  // than on the next job frame. A rotation pointing at an agent the reader has just hidden is dropped with it.
  if (!state.hot.on) state.hot.key = null;
  state.hot.sig = "";
  paintHotButton();
  showBanner(
    state.hot.on
      ? "Active agents: the button is in the header again, drawn while an agent is working"
      : "Active agents: the button is switched off and drawn nowhere in the header",
  );
});

// The row is drawn from the stored value at load, so a setting saved in an earlier session is visible rather than
// something the reader has to discover by pressing the header.
try {
  paintActiveButtonSetting();
} catch {
  /* a page with no Settings drawer still paints the header from the same default */
}

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

// Is the caret in something the reader is typing into? One guard for every bare-key shortcut on this page: a letter
// typed into a reply box, a Settings search or an answer box must never jump the page.
function textEntryFocused(el) {
  if (!el) return false;
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) return true;
  return Boolean(el.closest?.('[contenteditable]:not([contenteditable="false"])'));
}

// D is the list's key: no modifiers, no e.repeat (holding the key must not race the toggle), and a caret in ANY
// text field owns the keystroke.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== "d" && e.key !== "D") return;
  if (e.repeat) return;
  if (textEntryFocused(document.activeElement)) return;
  e.preventDefault();
  toggleDeliverPop();
});

window.addEventListener("resize", deliverPosition);
// ---- end deliverables wiring

// ---- clarify history wiring: the page's half, which calls public/clarify-history.js --------------------
// The popup itself (the panel, the rows, the read, the keyboard and the remembered size) is in
// public/clarify-history.js, a classic script the shell loads before this one. What stays here is only the wiring
// that must run at THIS file's load, after `state` exists: the button's press and its `data-wired` mark (the shell's
// stale-page guard reads it), the outside press, Escape, and the resize that puts a remembered panel back inside a
// window that changed size. The button toggles; a row press inside the popup opens the question itself.
const clarifyBtn = $("btn-clarify");
clarifyBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  try {
    clarifyHistoryToggle();
  } catch (err) {
    // Same rule as the deliverables button: a control that can be pressed must never be a silent no-op. A page whose
    // app.js is older than the shell that loaded it is exactly this case, and the guard offers the reload.
    const why = String((err && err.message) || err);
    console.error(`[panel] CLARIFY HISTORY could not open on this page: ${why}`);
    window.__panelStaleBuild?.report?.(`Opening the clarify history threw: ${why}.`);
  }
});
if (clarifyBtn) clarifyBtn.dataset.wired = "1";

// The button's count starts here, not when the popup opens: the whole point is that a reader can see something is
// waiting without opening the history. It reads the route once, ticks slowly, and re-reads shortly after any job frame.
clarifyHistoryCountStart();
paintClarifyButton();

// An outside press closes it, mousedown so the reader's next click lands where they aimed. The button's own press is
// left to the click handler above, which toggles.
document.addEventListener("mousedown", (e) => {
  if (!clarifyHist.open) return;
  if (clarifyHist.el?.contains(e.target)) return;
  if (e.target.closest?.("#btn-clarify")) return;
  clarifyHistoryClose();
});

// Escape from anywhere closes it and hands the caret back to the button. The popup's own keydown handles it first and
// stops the event, so this is the path for a caret that wandered outside the panel (a repaint can take it).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !clarifyHist.open) return;
  e.preventDefault();
  clarifyHistoryClose({ focus: true });
});

window.addEventListener("resize", clarifyHistoryReposition);
// ---- end clarify history wiring

// ---- collisions wiring: the page's half, which calls public/collision-history.js --------------------------
// The popup itself (the panel, the rows, both sides' links, the ruling presses, the filter, the read and the remembered
// size) is in public/collision-history.js, a classic script the shell loads before this one. What stays here is only the
// wiring that must run at THIS file's load, after `state` exists: the button's press and its `data-wired` mark (the
// shell's stale-page guard reads it), the outside press, Escape, and the resize that puts a remembered panel back
// inside a window that changed size. A ruling is pressed INSIDE the popup and goes through POST /api/collisions; nothing
// here answers anything.
const collisionsBtn = $("btn-collisions");
collisionsBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  try {
    collisionHistoryToggle();
  } catch (err) {
    // Same rule as Clarify: a control that can be pressed must never be a silent no-op.
    const why = String((err && err.message) || err);
    console.error(`[panel] COLLISIONS could not open on this page: ${why}`);
    window.__panelStaleBuild?.report?.(`Opening the collisions history threw: ${why}.`);
  }
});
if (collisionsBtn) collisionsBtn.dataset.wired = "1";

// The button's count starts here, not when the popup opens: the whole point is that a reader can see whether any pair
// is actually theirs to rule without opening anything. Same slow tick and same read-after-frame as the Clarify button.
collisionHistoryCountStart();
paintCollisionsButton();

// An outside press closes it, mousedown so the reader's next click lands where they aimed.
document.addEventListener("mousedown", (e) => {
  if (!collisionHist.open) return;
  if (collisionHist.el?.contains(e.target)) return;
  if (e.target.closest?.("#btn-collisions")) return;
  collisionHistoryClose();
});

// Escape from anywhere closes it and hands the caret back to the button. The popup's own keydown handles it first and
// stops the event, so this is the path for a caret that wandered outside the panel (a repaint can take it).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !collisionHist.open) return;
  e.preventDefault();
  collisionHistoryClose({ focus: true });
});

window.addEventListener("resize", collisionHistoryReposition);
// ---- end collisions wiring

// ---- permissions wiring: the page's half, which calls public/permissions-history.js ---------------------
// The popup itself (the panel, the rows, the answer press, the read, the keyboard and the remembered size) is in
// public/permissions-history.js, a classic script the shell loads before this one. What stays here is only the wiring
// that must run at THIS file's load, after `state` exists: the button's press and its `data-wired` mark (the shell's
// stale-page guard reads it), the outside press, Escape, and the resize that puts a remembered panel back inside a
// window that changed size. The button toggles; a choice button inside the popup answers, and a row press lands on the
// agent. Nothing here answers anything.
const permissionsBtn = $("btn-permissions");
permissionsBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  try {
    permissionsHistoryToggle();
  } catch (err) {
    // Same rule as Clarify and the deliverables: a control that can be pressed must never be a silent no-op.
    const why = String((err && err.message) || err);
    console.error(`[panel] PERMISSIONS could not open on this page: ${why}`);
    window.__panelStaleBuild?.report?.(`Opening the permissions list threw: ${why}.`);
  }
});
if (permissionsBtn) permissionsBtn.dataset.wired = "1";

// The count starts here, not when the popup opens: the whole point is that a reader can see that a run is stopped
// without opening anything. Same slow tick and same read-after-frame as the Clarify button.
permissionsHistoryCountStart();
paintPermissionsButton();

// An outside press closes it, mousedown so the reader's next click lands where they aimed.
document.addEventListener("mousedown", (e) => {
  if (!permissionsHist.open) return;
  if (permissionsHist.el?.contains(e.target)) return;
  if (e.target.closest?.("#btn-permissions")) return;
  permissionsHistoryClose();
});

// Escape from anywhere closes it and hands the caret back to the button.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !permissionsHist.open) return;
  e.preventDefault();
  permissionsHistoryClose({ focus: true });
});

window.addEventListener("resize", permissionsHistoryReposition);
// ---- end permissions wiring

// ---- fonts: two settings, not one ----------------------------------------------
// Panel font: the page's own labels, headings and buttons (--ui).
// Terminal font: the text inside an agent card — transcript, prompt, reply box, command preview
// (--term). They are separate on purpose: a readable serif UI with a monospace transcript is a
// normal preference, and so is the other way round.
//
// EVERY ENTRY HERE IS A FACE THIS BOX CAN PAINT, and each one names it. The list used to be written from memory of
// what a developer machine might have: of sixteen console entries ten drew Consolas - eight of them under another name
// ("JetBrains Mono", "Fira Code", "IBM Plex Mono" and five more, none of them installed here) and one an entry that
// was already called Consolas - so sixteen console choices came to nine pictures. Two panel entries drew a face
// another entry already offered. tools/verify-console-fonts.mjs now drives every entry in a real browser and asks
// CSS.getPlatformFontsForNode which family painted the glyphs, and these lists are what that readback says: ten console
// entries drawing ten different pictures, fourteen panel entries drawing fourteen, the duplicates gone.
//
// Stacks, not families: the first face the machine actually has wins, so the stack still reads correctly on a Mac
// (where ui-monospace is SF Mono) even though `resolves` names THIS box's face. `resolves` is that readback, and the
// picker prints it after an arrow wherever the label does not already name it - "Default (system UI) -> Segoe UI" -
// so a hopeful name can never sit in the list unmeasured again.
const UI_FONTS = [
  { id: "default", label: "Default (system UI)", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', resolves: "Segoe UI" },
  { id: "calibri", label: "Calibri", stack: 'Calibri, "Segoe UI", sans-serif', resolves: "Calibri" },
  { id: "candara", label: "Candara", stack: 'Candara, "Segoe UI", sans-serif', resolves: "Candara" },
  { id: "tahoma", label: "Tahoma", stack: 'Tahoma, Verdana, sans-serif', resolves: "Tahoma" },
  { id: "verdana", label: "Verdana", stack: 'Verdana, Geneva, sans-serif', resolves: "Verdana" },
  { id: "trebuchet", label: "Trebuchet MS", stack: '"Trebuchet MS", "Segoe UI", sans-serif', resolves: "Trebuchet MS" },
  { id: "arial", label: "Arial", stack: 'Arial, "Segoe UI", sans-serif', resolves: "Arial" },
  { id: "roboto", label: "Roboto", stack: 'Roboto, "Segoe UI", sans-serif', resolves: "Roboto" },
  { id: "bahnschrift", label: "Bahnschrift (condensed)", stack: 'Bahnschrift, "Segoe UI", sans-serif', resolves: "Bahnschrift" },
  { id: "georgia", label: "Georgia (serif)", stack: 'Georgia, "Times New Roman", serif', resolves: "Georgia" },
  { id: "cambria", label: "Cambria (serif)", stack: 'Cambria, Georgia, serif', resolves: "Cambria" },
  { id: "palatino", label: "Palatino Linotype (serif)", stack: '"Palatino Linotype", "Book Antiqua", Georgia, serif', resolves: "Palatino Linotype" },
  { id: "consolas", label: "Consolas (monospace)", stack: 'Consolas, "Cascadia Mono", monospace', resolves: "Consolas" },
  { id: "cascadia", label: "Cascadia Code (monospace)", stack: '"Cascadia Code", Consolas, monospace', resolves: "Cascadia Code" },
];

const TERM_FONTS = [
  { id: "default", label: "Default (system monospace)", stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace', resolves: "Consolas" },
  { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", Consolas, monospace', resolves: "Cascadia Code" },
  { id: "cascadia-mono", label: "Cascadia Mono", stack: '"Cascadia Mono", Consolas, monospace', resolves: "Cascadia Mono" },
  { id: "ubuntu-mono", label: "Ubuntu Mono", stack: '"Ubuntu Mono", Consolas, monospace', resolves: "Ubuntu Mono" },
  { id: "lucida", label: "Lucida Console", stack: '"Lucida Console", Consolas, monospace', resolves: "Lucida Console" },
  { id: "lucida-typewriter", label: "Lucida Sans Typewriter", stack: '"Lucida Sans Typewriter", "Lucida Console", monospace', resolves: "Lucida Sans Typewriter" },
  { id: "courier", label: "Courier New", stack: '"Courier New", monospace', resolves: "Courier New" },
  { id: "rocket", label: "Rocket Mono", stack: '"Rocket Mono", Consolas, monospace', resolves: "Rocket Mono" },
  { id: "ms-gothic", label: "MS Gothic", stack: '"MS Gothic", Consolas, monospace', resolves: "MS Gothic" },
  { id: "panel", label: "Same as the panel font", stack: "var(--ui)", resolves: "" },
];

// The ids these lists RETIRED, and the entry that draws what they drew. Every one of them resolved to a face another
// entry still offers - the nine console names were all Consolas - so a reader whose stored choice was one of them keeps
// exactly the picture they had instead of being silently moved to a different typeface.
const FONT_RETIRED = {
  ui: { segoe: "default", jetbrains: "consolas" },
  term: { consolas: "default", jetbrains: "default", fira: "default", "source-code": "default", "ibm-plex": "default", inconsolata: "default", victor: "default", hack: "default", menlo: "default" },
};

// What the picker prints for one entry: its label, and - where the label is a description rather than the family this
// box draws ("Default (system UI)") - the measured face after an arrow. An entry that follows another setting (the
// console's "same as the panel font") names no face of its own and gets no arrow.
function fontOptionLabel(font) {
  const resolves = String(font.resolves || "").trim();
  const head = String(font.label || "").split(" (")[0].trim().toLowerCase();
  if (!resolves || head === resolves.toLowerCase()) return font.label;
  return `${font.label} -> ${resolves}`;
}

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
  // A retired id falls FORWARD to the entry that draws what it drew, so a reader who chose "Fira Code" (Consolas on
  // this box) keeps Consolas rather than being moved to the panel's default serif.
  const want = (FONT_RETIRED[kind] || {})[id] || id;
  return set.list.some((f) => f.id === want) ? want : "default";
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

// ---- console row spacing: ONE number between two lines of console text ---------------------------------------
// The vertical gap between two lines of a card's console - its own words, a tool's call and the output under it, the
// reasoning lines of the stream and the reasoning block above the console. NOT the prompt box's padding (the command
// card's own rows own that) and not the console's text size: this is the leading, and nothing else.
//
// It is a MULTIPLIER on the console's line-height, written as ONE CSS variable that the stylesheet reads with the
// console's own 1.5 as its fallback, so an unset key draws exactly what this panel drew before the row existed. A
// multiplier rather than a pixel count is what keeps it honest beside the two things that already move this text:
// Console size (--term-size) and a card's Ctrl+wheel zoom, which writes that same variable on the card. A px value
// would have to be recomputed by whichever of the three moved last; a multiplier is simply multiplied by each of them.
const CON_ROW_KEY = "wtgui.conRowSpace";
const CON_ROW_DEFAULT = 1.5;
// 1.2 is tight but legible over a long transcript, 2.4 is airy, and 1.5 is the number the console has always used.
const CON_ROW_LIMITS = Object.freeze([1.2, 2.4]);
const CON_ROW_VAR = "--con-row-space";

// The stored multiplier, clamped to the range this panel offers: a hand-edited key cannot set a line-height of 0.
function conRowSpace() {
  let n = CON_ROW_DEFAULT;
  try {
    const raw = localStorage.getItem(CON_ROW_KEY);
    if (raw !== null && Number.isFinite(Number(raw))) n = Number(raw);
  } catch {
    /* private mode: the default holds */
  }
  return clampConRow(n);
}

function clampConRow(n) {
  const [lo, hi] = CON_ROW_LIMITS;
  const v = Number(n);
  return Math.min(hi, Math.max(lo, Math.round((Number.isFinite(v) ? v : CON_ROW_DEFAULT) * 100) / 100));
}

// Write the variable on :root and repaint the row. `value` left out reads the store; a change is saved only when the
// caller says so, so the drag that previews the gap does not write a key per pixel of travel.
function applyConRowSpace(value = null, { save = false } = {}) {
  const n = value === null ? conRowSpace() : clampConRow(value);
  document.documentElement.style.setProperty(CON_ROW_VAR, String(n));
  paintConRowSpace(n);
  if (save) {
    try {
      localStorage.setItem(CON_ROW_KEY, String(n));
    } catch {
      /* private mode: the spacing applies to this tab only */
    }
  }
  return n;
}

// The row's own readout: the slider, and what that multiplier is worth in pixels at the console's CURRENT size, so
// "1.6" reads as a number a reader can check against the text beside it. Console size repaints it (applyTermStyle).
function paintConRowSpace(n = conRowSpace()) {
  const input = $("con-row-space");
  if (input && document.activeElement !== input && input.value !== String(n)) input.value = String(n);
  const px = $("con-row-space-px");
  if (px) px.textContent = `${(n * termSize()).toFixed(1)}px`;
}

// "use defaults" is the console's own 1.5: the same number an unset key draws, written back so the slider shows it.
function resetConRowSpace() {
  applyConRowSpace(CON_ROW_DEFAULT, { save: true });
}

// Paint the saved row spacing before the first console is drawn.
function initConRowSpace() {
  applyConRowSpace(null, { save: false });
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

// ---- the assistant console command card's look (Settings > Display) -----------------------------------------
// Seven numbers, all display only and all saved in this browser like every other Display row: the preview rows a
// folded command card shows, the card's side margin, the padding of the text inside it - its sides, and its top and
// bottom - the blank lines above and below it, and the side margin the rest of the console's text keeps. Each is
// written as a CSS variable the stylesheet reads WITH today's look as its fallback (style.css, `--cmd-*` and
// `--con-side`), so an unset setting draws exactly what this panel drew before the rows existed - and the defaults
// are those fallbacks, not a second set of numbers that could drift away from them.
//
// The inside padding is three numbers, not one, because a box has four sides: `pad` is the sides, `padTop` the air
// between the card's top edge and the prompt's first row, `padBottom` the same at the foot. The blank lines are the
// OUTSIDE spacing - the card's own margin in the console, on top of the 4px frame margin every box carries - and
// they are a different row on purpose, so "more air around the card" and "more air inside it" cannot be confused.
const CMD_LOOK_KEY = "wtgui.cmdLook";
// `rows` and `blank` are counted in the card's own line (18px: a 12px body at 1.5), the rest in px.
// The unit travels WITH the value into the CSS variable - a bare `8` in `padding: var(--cmd-pad-top) var(--cmd-pad)`
// is an invalid declaration, and the whole property would fall back to the initial `0` instead of today's number.
const CMD_LOOK_DEFAULTS = Object.freeze({ rows: 2, side: 0, pad: 8, padTop: 0, padBottom: 0, blank: 0, con: 10 });
const CMD_LOOK_UNITS = Object.freeze({ rows: "", side: "px", pad: "px", padTop: "px", padBottom: "px", blank: "", con: "px" });
const CMD_LOOK_LIMITS = Object.freeze({
  rows: [1, 8],
  side: [0, 60],
  pad: [0, 32],
  padTop: [0, 32],
  padBottom: [0, 32],
  blank: [0, 4],
  con: [0, 60],
});
const CMD_LOOK_VARS = Object.freeze({
  rows: "--cmd-rows",
  side: "--cmd-side",
  pad: "--cmd-pad",
  padTop: "--cmd-pad-top",
  padBottom: "--cmd-pad-bottom",
  blank: "--cmd-blank",
  con: "--con-side",
});
// The input each row is: the name and the element's id are not always the same word (`padTop` is `cmd-pad-top`),
// and one table keeps the variable, the row and the readout from having to guess.
const CMD_LOOK_IDS = Object.freeze({
  rows: "cmd-rows",
  side: "cmd-side",
  pad: "cmd-pad",
  padTop: "cmd-pad-top",
  padBottom: "cmd-pad-bottom",
  blank: "cmd-blank",
  con: "cmd-con",
});

function cmdLook() {
  const out = { ...CMD_LOOK_DEFAULTS };
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(CMD_LOOK_KEY) || "null");
  } catch {
    raw = null;
  }
  if (raw && typeof raw === "object") {
    for (const name of Object.keys(out)) {
      const n = Number(raw[name]);
      if (Number.isFinite(n)) out[name] = n; // clamped in applyCommandCardLook, the one place that decides
    }
  }
  return out;
}

// Read once, so a card drawn before anyone opens Settings already follows the saved look.
let cmdLookState = cmdLook();

// Write the seven variables on :root, hand the row count to the card module (which writes `data-code-clamp`), and
// re-measure the cards already on the page: a fold that got taller or narrower moved the marker's own row with it.
function applyCommandCardLook(patch = null, { save = false } = {}) {
  if (patch && typeof patch === "object") cmdLookState = { ...cmdLookState, ...patch };
  const root = document.documentElement;
  for (const name of Object.keys(CMD_LOOK_VARS)) {
    const [lo, hi] = CMD_LOOK_LIMITS[name];
    const n = Number(cmdLookState[name]);
    const v = Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : CMD_LOOK_DEFAULTS[name];
    cmdLookState[name] = v;
    root.style.setProperty(CMD_LOOK_VARS[name], `${v}${CMD_LOOK_UNITS[name]}`);
  }
  // The card module reads this for `data-code-clamp`: one number, so the attribute and the stylesheet's fold agree.
  globalThis.wtCommandPreviewRows = cmdLookState.rows;
  if (save) {
    try {
      localStorage.setItem(CMD_LOOK_KEY, JSON.stringify(cmdLookState));
    } catch {
      /* private mode: the look applies to this tab only */
    }
  }
  paintCommandCardLook();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(repaintCommandFolds);
  return cmdLookState;
}

// The rows' own values. Never rewrite the box the reader is typing into: a clamp lands on `change`, not on a
// keystroke.
function paintCommandCardLook(look = cmdLookState) {
  for (const name of Object.keys(CMD_LOOK_VARS)) {
    const el = $(CMD_LOOK_IDS[name]);
    if (!el || document.activeElement === el) continue;
    if (String(el.value) !== String(look[name])) el.value = String(look[name]);
  }
}

// Every folded card on the page: the attribute the card says it is folded to, then its marker. The attribute is
// written here as well as at render time, because a reader who changes the row count is looking at cards that were
// drawn at the old one - the stylesheet's fold moves with the variable, and the card's own number has to agree with
// it or the DOM would read one fold and the page draw another.
function repaintCommandFolds() {
  if (typeof paintCommandFoldMark !== "function") return;
  for (const box of document.querySelectorAll(".code-box.is-cmd")) {
    box.setAttribute("data-code-clamp", String(cmdLookState.rows));
    paintCommandFoldMark(box);
  }
}

// "use defaults" is the seven fallbacks: the same numbers an unset key draws, written back so the inputs can show them.
function resetCommandCardLook() {
  applyCommandCardLook({ ...CMD_LOOK_DEFAULTS }, { save: true });
}

// Paint the command card's look before the first card is drawn.
function initCommandCardLook() {
  applyCommandCardLook(null, { save: false });
}

// public/assistant.js's keydown calls this by name on window.
window.__openSkillsSearch = focusSkillsSearch;

// Wired once, at load: the two controls are static markup (index.html), and the editor they drive is rebuilt under
// them on every read. `pipeline-select`'s `change` is the press; a keyboard user never has to open the dropdown twice.
document.getElementById("pipeline-select")?.addEventListener("change", (e) => selectPipelineTab(e.target.value));
document.getElementById("pipeline-flow-open")?.addEventListener("click", (e) => {
  e.preventDefault();
  openPipelineFlow();
});
// The refused bundle's repair. Offered only while the loader refuses the file (paintPdlPipelines hides it otherwise),
// and the press is the import with this checkout's seed — never a file the page would have to read or name.
document.getElementById("pipeline-pdl-repair")?.addEventListener("click", (e) => {
  e.preventDefault();
  void repairPipelineBundle();
});

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
// The Skills tab's own bar: wired here, with the rest of the window, so the caret Ctrl+Shift+S promises can be typed
// into on the very first press - the bar is static markup and its one listener set costs nothing at boot.
initSkillsSearch();
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
// And the Prompt tab: it is a read of the briefing the panel would build, so it is measured once at boot beside the
// others rather than left blank until the reader presses the tab.
void loadPromptBudget();
// The window's own gestures: the head drags it, the corner grip sizes it, and the rect is remembered in this browser.
initSettingsWindow();
// The Prompt tab's table of contents: four anchors into a page long enough to need them.
initPromptDocToc();
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
// The console's row spacing follows the slider while it is dragged (a live preview) and is saved when it settles, the
// way the contrast slider behaves: one key per gesture, not one per pixel of travel.
$("con-row-space")?.addEventListener("input", (e) => applyConRowSpace(e.target.value));
$("con-row-space")?.addEventListener("change", (e) => applyConRowSpace(e.target.value, { save: true }));
$("con-row-reset")?.addEventListener("click", () => resetConRowSpace());

// ---- the command card's seven rows: each applies at once, saved in this browser like the rest of Display ----
// The input is `CMD_LOOK_IDS[name]`, one per variable, so a row can only ever write the variable that names it.
const CMD_LOOK_ROWS = ["rows", "side", "pad", "padTop", "padBottom", "blank", "con"];
for (const name of CMD_LOOK_ROWS) {
  const el = $(CMD_LOOK_IDS[name]);
  if (!el) continue;
  el.addEventListener("change", () => {
    const n = Number(el.value);
    const look = applyCommandCardLook({ [name]: Number.isFinite(n) ? n : CMD_LOOK_DEFAULTS[name] }, { save: true });
    // The box shows the number that was APPLIED, not the one that was typed: a value over the ceiling lands on the
    // ceiling, and the reader has to see that rather than a box that disagrees with the card.
    el.value = String(look[name]);
  });
}
$("cmd-look-reset")?.addEventListener("click", () => {
  resetCommandCardLook();
  showBanner("command card: back to the defaults - 2 preview rows, no side margin, 8px side padding, no inside padding at the top or bottom, no blank lines, a 10px console text inset");
});

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

// ---- end agent cleanup (the row's readers and painters live in public/settings-window.js)

$("initiative-tier")?.addEventListener("change", async (e) => {
  const want = String(e.target.value || "");
  const before = initiativeTierStored();
  const preview = $("initiative-tier-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/initiative-tier",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier: want }) },
      { timeoutMs: 10000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings = { ...(state.settings || {}), ...(d.settings || {}) };
    paintInitiativeTier();
    showBanner(`initiative changes: ${d.tier?.label || want}`);
  } catch (err) {
    e.target.value = before;
    paintInitiativeTier(`could not change it: ${err.message}`, true);
    showBanner(`could not change the initiative tier: ${err.message}`);
  }
});

// ---- end initiative tier (the row's readers and painters live in public/settings-window.js)

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
    // A repaint is also driven by snapshots now (the pane's frame rides them), so it must never take a box the
    // reader is TYPING in: a number half-entered would be replaced by the stored one mid-keystroke. A select is not
    // typed into, so it is always repainted from the stored value — including by the catch that follows a refused save.
    if (!el) return;
    if (el.tagName === "INPUT" && document.activeElement === el) return;
    if (String(el.value) !== String(value)) el.value = String(value);
  };
  put("general-threads", Number(s.threads) || 0);
  put("general-worktree", Number(s.worktreeSeconds) || 0);
  put("general-budget", Number(s.briefingBudgetChars) || 0);
  // The pane's frame is one value for the whole panel. A panel that has never chosen (`dockMode: null`) shows the
  // rail it draws; the page's migration writes the value it adopted into config.json on the same boot.
  put("general-dock", s.dockMode === "floating" ? "floating" : "docked");
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
    // The frame is drawn by public/assistant.js from `dockMode`, so a pick lands on the open pane NOW rather than on
    // the next repaint: no reload, and the same painter a settings event from another tab reaches.
    if (typeof window.__assistantFrame === "function") window.__assistantFrame();
    const fw = $("f-worktree");
    if (fw && state.settings.worktreeSeconds) fw.textContent = String(state.settings.worktreeSeconds);
    // A frame pick is not a scan number: the banner says what changed on screen instead of restating the scan
    // sentence the other three rows share.
    showBanner(`${label}: ${patch && patch.dockMode ? `every assistant's pane is ${patch.dockMode} — applied at once, saved in config.json` : generalSentence(state.settings)}`);
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

// The assistant pane's frame: a select, not a number, so it does not ride the loop above. One value for the whole
// panel; the server writes it into config.json and public/assistant.js re-frames the open pane from the answer.
$("general-dock")?.addEventListener("change", () => {
  const value = String($("general-dock").value || "");
  if (value !== "docked" && value !== "floating") return paintGeneralSettings(state.settings || {});
  void saveGeneralSettings({ dockMode: value }, "assistant pane");
});

// ---- settings > storage & cleanup ------------------------------------------------------------
// Two reads of one route. GET /api/maintenance answers with the three disposable folders this panel writes, the size
// each holds now and a read-only census of the processes the panel started; POST /api/maintenance/clean removes one
// target, or with `dryRun: true` only counts what it would remove. A bounded clean is a real possibility, so an
// answer that leaves entries behind is SAID rather than drawn as a success: the row offers the next press.
//
// Every field is read defensively: this tab is the whole General pane, and a section that throws over a missing
// `bytes` would take the scan rows above it down with it. The last good answer is kept, the way the release notes
// keep theirs — a failed Refresh is a notice over the list, not a blank box.
const MAINTENANCE_TARGETS_ID = "maintenance-targets";
const MAINTENANCE_PROCESSES_ID = "maintenance-processes";
const MAINTENANCE_PROCESSES_SUMMARY_ID = "maintenance-processes-summary";
const MAINTENANCE_REFRESH_ID = "btn-maintenance-refresh";
const MAINTENANCE_RESULT_ID = (target) => `maintenance-result-${target}`;
const MAINTENANCE_WINDOW_ID = (target) => `maintenance-window-${target}`;
let maintenanceIndex = null;
let maintenanceLoadedAt = 0;
let maintenanceLoading = null;
const MAINTENANCE_RESULTS = new Map();

function maintenanceMb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "size unknown";
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function maintenanceSize(bytes, files) {
  const f = Number(files);
  const fileText = Number.isFinite(f) ? `${f.toLocaleString("en-US")} file${f === 1 ? "" : "s"}` : "file count unknown";
  return `${maintenanceMb(bytes)} · ${fileText}`;
}

function maintenanceDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return "unknown age";
  const whole = Math.round(s);
  if (whole < 60) return `${whole}s`;
  const m = Math.floor(whole / 60);
  if (m < 60) return `${m}m ${whole % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// The census line: counts only, because the route hands over arrays and the reader is owed a sentence, not a kill
// button. A field the answer omits reads "unknown", never "0" — zero is a fact and an absent array is not.
function maintenanceProcessLine(processes) {
  if (!processes || typeof processes !== "object") return "process census not answered";
  const sandbox = Array.isArray(processes.sandboxPanels) ? processes.sandboxPanels : null;
  const tests = Array.isArray(processes.testRunners) ? processes.testRunners.length : null;
  const orphans = Array.isArray(processes.orphanPids) ? processes.orphanPids.length : null;
  let oldest = null;
  if (sandbox) {
    for (const p of sandbox) {
      const age = Number(p && p.ageSeconds);
      if (Number.isFinite(age) && (oldest === null || age > oldest)) oldest = age;
    }
  }
  const sandboxText = sandbox
    ? `${sandbox.length} sandbox panel${sandbox.length === 1 ? "" : "s"}${oldest === null ? "" : ` · oldest ${maintenanceDuration(oldest)}`}`
    : "sandbox panels unknown";
  const testText = tests === null ? "test runners unknown" : `${tests} test runner${tests === 1 ? "" : "s"}`;
  const orphanText = orphans === null ? "orphan panels unknown" : `${orphans} orphan panel${orphans === 1 ? "" : "s"}`;
  return `${sandboxText} · ${testText} · ${orphanText}`;
}

// The Processes heading's unit is the census in three numbers; the sentence beneath it is the full one
// (`maintenanceProcessLine`). An absent array reads "not read", never 0 — zero is a fact and silence is not.
function maintenanceProcessHeadline(processes) {
  if (!processes || typeof processes !== "object") return "not read";
  const count = (value) => (Array.isArray(value) ? value.length : null);
  const parts = [
    [count(processes.sandboxPanels), "panel", "panels"],
    [count(processes.testRunners), "runner", "runners"],
    [count(processes.orphanPids), "orphan", "orphans"],
  ].map(([n, one, many]) => (n === null ? null : `${n} ${n === 1 ? one : many}`));
  return parts.filter(Boolean).join(" · ") || "not read";
}

function maintenanceResultHtml(target) {
  const held = MAINTENANCE_RESULTS.get(target);
  return held
    ? `<div class="maintenance-result mono${held.bad ? " bad" : ""}" id="${esc(MAINTENANCE_RESULT_ID(target))}">${esc(held.text)}</div>`
    : `<div class="maintenance-result mono" id="${esc(MAINTENANCE_RESULT_ID(target))}"></div>`;
}

function maintenanceTargetHtml(t) {
  const target = String((t && t.id) || "");
  const name = String((t && t.label) || target || "target");
  const detail = t && t.detail ? `<div class="maintenance-detail">${esc(String(t.detail))}</div>` : "";
  const blocked = t && t.blockedReason ? `<div class="maintenance-detail bad">${esc(String(t.blockedReason))}</div>` : "";
  const canClean = !t || t.removable !== false;
  const cleanTitle = canClean
    ? `remove what ${name} holds — a bounded run removes a slice and says how many entries remain`
    : `${name} is not removable right now`;
  return (
    `<div class="maintenance-target" data-maintenance-target="${esc(target)}">` +
    `<div class="maintenance-head">` +
    `<span class="maintenance-label">${esc(name)}</span>` +
    `<span class="maintenance-size mono">${esc(maintenanceSize(t && t.bytes, t && t.files))}</span>` +
    `</div>` +
    detail +
    blocked +
    `<div class="maintenance-actions">` +
    // The session store is the one target whose "unused for" window the reader chooses: 24 hours is the default, a
    // week or a month reach further back. Every other target cleans what it holds, whole.
    (target === "hermes-sessions"
      ? `<label class="maintenance-window">unused for <select id="${esc(MAINTENANCE_WINDOW_ID(target))}">` +
        `<option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option>` +
        `</select></label>`
      : "") +
    `<button type="button" data-maintenance-preview="${esc(target)}" title="${esc(`dry run: count what a clean of ${name} would remove, and remove nothing`)}">Preview</button>` +
    `<button type="button" data-maintenance-clean="${esc(target)}" title="${esc(cleanTitle)}"${canClean ? "" : " disabled"}>Clean</button>` +
    `</div>` +
    maintenanceResultHtml(target) +
    `</div>`
  );
}

// Paint from the last good answer, keeping any per-row result already on screen. `error` is the notice a failed
// Refresh adds ABOVE the list the reader already had, never instead of it.
function paintMaintenance(error = null) {
  const box = document.getElementById(MAINTENANCE_TARGETS_ID);
  const census = document.getElementById(MAINTENANCE_PROCESSES_ID);
  const summary = document.getElementById(MAINTENANCE_PROCESSES_SUMMARY_ID);
  if (!box) return;
  const data = maintenanceIndex;
  const targets = data && Array.isArray(data.targets) ? data.targets : [];
  const notice = error ? `<div class="maintenance-state bad">${esc(`the panel could not answer for storage sizes — ${error}`)}</div>` : "";
  if (!data) {
    box.innerHTML = error ? notice : `<div class="maintenance-state">reading storage sizes…</div>`;
  } else {
    const rows = targets.length
      ? targets.map(maintenanceTargetHtml).join("")
      : `<div class="maintenance-state">the panel answered with no cleanup targets</div>`;
    box.innerHTML = notice + rows;
  }
  if (census) {
    census.textContent = error && !data ? "process census not read" : maintenanceProcessLine(data && data.processes);
  }
  // The unit in the Processes heading carries that row's own census — the heading used to read "Processes" over the
  // TARGET count ("3 targets"), which belonged to no row in particular.
  if (summary) summary.textContent = data ? maintenanceProcessHeadline(data.processes) : "not read";
}

async function loadMaintenance() {
  if (maintenanceLoading) return maintenanceLoading;
  maintenanceLoading = (async () => {
    try {
      const r = await apiFetch("/api/maintenance", {}, { timeoutMs: 20000 });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
      if (d && d.ok === false) throw new Error(d.error || "the panel refused the read");
      maintenanceIndex = d && typeof d === "object" ? d : {};
      maintenanceLoadedAt = Date.now();
      paintMaintenance();
    } catch (e) {
      paintMaintenance(e.message || String(e));
    } finally {
      maintenanceLoading = null;
    }
  })();
  return maintenanceLoading;
}

function paintMaintenanceResult(target, text, bad) {
  if (text) MAINTENANCE_RESULTS.set(target, { text: String(text), bad: Boolean(bad) });
  else MAINTENANCE_RESULTS.delete(target);
  const node = document.getElementById(MAINTENANCE_RESULT_ID(target));
  if (!node) return;
  node.textContent = text ? String(text) : "";
  node.classList.toggle("bad", Boolean(bad));
}

function maintenanceResultText(d, dryRun) {
  if (d && d.refused) return `refused: ${d.refused}`;
  const files = Number(d && d.removedFiles) || 0;
  const bytes = Number(d && d.removedBytes) || 0;
  const remaining = Number(d && d.remaining) || 0;
  const verb = dryRun ? "would remove" : "removed";
  const head = `${verb} ${files} file${files === 1 ? "" : "s"} · ${maintenanceMb(bytes)}`;
  return remaining > 0 ? `${head} · ${remaining} entries remain — run Clean again` : head;
}

async function runMaintenance(target, dryRun) {
  if (!target || MAINTENANCE_RESULTS.get(target)?.busy) return;
  MAINTENANCE_RESULTS.set(target, { text: dryRun ? "counting what a clean would remove…" : "cleaning…", bad: false, busy: true });
  const node = document.getElementById(MAINTENANCE_RESULT_ID(target));
  if (node) node.textContent = dryRun ? "counting what a clean would remove…" : "cleaning…";
  try {
    // Only the session target takes a window; it rides the same one clean (/api/maintenance/clean) as an extra field,
    // read from the select the card drew — an absent or broken control falls back to the server's own default.
    const windowEl = target === "hermes-sessions" ? document.getElementById(MAINTENANCE_WINDOW_ID(target)) : null;
    const olderThanHours = windowEl ? Number(windowEl.value) || 24 : null;
    const payload = olderThanHours ? { target, dryRun, olderThanHours } : { target, dryRun };
    // A Hermes store prune is followed by a VACUUM and can outlive a minute on a multi-GB state.db; the server keeps
    // going after a client abort, so the client waits longer than its own patience rather than reporting a failure.
    const slow = target === "hermes-sessions" || target === "hermes-checkpoints";
    const r = await apiFetch(
      "/api/maintenance/clean",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      { timeoutMs: slow ? 600000 : 60000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
    if (d && d.ok === false && !d.refused) throw new Error(d.error || "the clean was refused");
    MAINTENANCE_RESULTS.delete(target);
    paintMaintenanceResult(target, maintenanceResultText(d, dryRun), Boolean(d && d.refused));
    // A clean moved real bytes, so the sizes above are stale by definition: ask again and keep the row's result.
    if (!dryRun) {
      maintenanceLoadedAt = 0;
      void loadMaintenance();
    }
  } catch (e) {
    MAINTENANCE_RESULTS.delete(target);
    paintMaintenanceResult(target, `could not ${dryRun ? "preview" : "clean"} ${target}: ${e.message}`, true);
  }
}

document.getElementById(MAINTENANCE_REFRESH_ID)?.addEventListener("click", () => void loadMaintenance());
document.getElementById(MAINTENANCE_TARGETS_ID)?.addEventListener("click", (e) => {
  const preview = e.target.closest?.("[data-maintenance-preview]");
  const clean = e.target.closest?.("[data-maintenance-clean]");
  if (preview) void runMaintenance(preview.getAttribute("data-maintenance-preview"), true);
  else if (clean) void runMaintenance(clean.getAttribute("data-maintenance-clean"), false);
});
// Nothing is read at boot: the census is a process-table walk (2-3 s on Windows) and this section is opened rarely.
// The first Settings -> General select starts the read (selectSettingsTab), Refresh re-reads, and the static "not
// read" lines stand until then.

// ---- end settings > storage & cleanup

// ---- Settings → Prompt: what one turn's prompt is built from, section by section ----------------
// The Prompt tab is a PICTURE of the briefing the panel builds, not a second budget written here: the server measures
// the sections with the same builder a turn uses (lib/assistant.js `promptBudget`) and hands over one model, so the
// diagram and the prompt cannot disagree. Three turns are drawn because the same standing text sits under different
// gates: the first turn of a session (the charter whole), an ordinary turn (a charter marker and no queue digest) and
// the fourth wake (the queue digest due). The board is the same tail message in all three, which is the point of it.
let promptBudgetLoadedAt = 0;

const promptNumber = (n) => Number(n || 0).toLocaleString("en-US");
const promptPercent = (share) => `${(Math.max(0, Number(share) || 0) * 100).toFixed(1)}%`;

// One section: its name and its share on the head line, and a bar whose width IS the share. A section whose gate is
// closed is drawn as the gate - named, with the size it would take when due - and contributes nothing to the total.
function promptSectionHtml(section) {
  const gated = Boolean(section.gated) && !section.chars;
  const name = gated ? `${section.label} · gate closed` : section.label;
  const value = gated
    ? `gate closed${section.whenDue ? ` · ${promptNumber(section.whenDue)} when due` : ""}`
    : `${promptNumber(section.chars)} · ${promptPercent(section.share)}`;
  const width = Math.max(0, Math.min(100, (Number(section.share) || 0) * 100));
  const title = `${section.label} — ${promptNumber(section.chars)} chars (${promptPercent(section.share)})${section.cap ? `; reserved against ${promptNumber(section.cap)}` : ""}${section.basis ? `; ${section.basis}` : ""}`;
  return `<div class="prompt-section${gated ? " is-gated" : ""}" data-prompt-section="${esc(section.key)}" title="${esc(title)}">
          <div class="prompt-section-head"><span class="prompt-section-name">${esc(name)}</span><span class="prompt-section-share mono">${esc(value)}</span></div>
          <div class="prompt-track"><span class="prompt-fill" style="width:${width.toFixed(2)}%"></span></div>
        </div>`;
}

// Why a turn is the size it is, beside its picture: the numbers are the model's, this sentence names the gate
// that moved and what the turn is for. `queueLabel` is THIS assistant's queue cadence, so the fourth wake's
// sentence stays true on a panel set to every 3rd wake as well as the default every 2nd.
function promptTurnWhy(turn, gates = {}) {
  if (turn.key === "first") return "A session's first turn: the charter is sent whole and the queue digest is carried, so this is the one turn that pays for the long tier.";
  if (turn.key === "ordinary") return "What most wakes cost: the charter is a one-line marker and the queue digest is not due, so the turn is the board's tail and that marker.";
  if (turn.key === "fourth") return `The queue gate is due again (${gates.queueLabel || "every 2nd wake"}) while the charter is still a marker, so this is the largest of the ordinary turns.`;
  return "";
}

function promptDiagramHtml(turn, gates) {
  // One turn: the prompt box, its two carriers inside it, and the sections inside those. Box-in-box is the
  // reading: the outer box is the whole prompt, each half is a carrier (system text / turn text) and each
  // section is a box in it.
  const half = (name, label) => {
    const sections = (turn.sections || []).filter((s) => s.half === name);
    const total = Number(name === "system" ? turn.system : turn.turn) || 0;
    return `<div class="prompt-half" data-prompt-half="${name}">
            <div class="prompt-half-head"><span>${label}</span><span class="mono">${promptNumber(total)} chars · ${promptPercent(turn.total ? total / turn.total : 0)}</span></div>
            ${sections.map(promptSectionHtml).join("")}
          </div>`;
  };
  return `<article class="prompt-diagram" data-prompt-turn="${esc(turn.key)}">
        <div class="prompt-diagram-head">
          <span class="prompt-diagram-title">${esc(turn.label)}</span>
          <span class="prompt-diagram-total mono">${promptNumber(turn.total)} chars</span>
        </div>
        <div class="prompt-diagram-body">
          <div class="prompt-box">
            <div class="prompt-box-head"><span>the prompt</span><span class="mono">${promptNumber(turn.total)} chars · 100%</span></div>
            ${half("system", "system text")}
            ${half("turn", "turn text")}
          </div>
          <aside class="prompt-diagram-side">
            <p class="prompt-diagram-note">${esc(turn.note || "")}</p>
            <p class="prompt-diagram-why">${esc(promptTurnWhy(turn, gates))}</p>
          </aside>
        </div>
      </article>`;
}

// The page's own table of contents: a press scrolls the section into the settings pane's scroll box. The links
// are real hrefs, so a browser running this page without the script still jumps; this only keeps the jump inside
// the pane (and off the URL, where a hash would outlive the tab).
function initPromptDocToc() {
  const nav = document.getElementById("prompt-toc");
  if (!nav || nav.dataset.bound === "1") return;
  nav.dataset.bound = "1";
  const jump = (ev) => {
    const link = ev.target.closest ? ev.target.closest("a[href^='#']") : null;
    if (!link) return;
    const target = document.getElementById(link.getAttribute("href").slice(1));
    if (!target) return;
    ev.preventDefault();
    target.scrollIntoView({ block: "start" });
  };
  nav.addEventListener("click", jump);
}

function paintPromptBudget(model) {
  const box = $("prompt-diagrams");
  const summary = $("prompt-budget-summary");
  const legend = $("prompt-budget-legend");
  if (!box) return;
  const turns = Array.isArray(model?.turns) ? model.turns : [];
  if (!turns.length) {
    if (summary) summary.textContent = "the panel returned no prompt sections";
    box.innerHTML = "";
    return;
  }
  box.innerHTML = turns.map((turn) => promptDiagramHtml(turn, model.gates || {})).join("");
  const at = (key) => turns.find((t) => t.key === key) || null;
  const first = at("first") || turns[0];
  const ordinary = at("ordinary");
  const fourth = at("fourth");
  if (summary) {
    const parts = [`The first turn of a session carries ${promptNumber(first.total)} characters in ${first.sections.length} sections`];
    if (ordinary) parts.push(`an ordinary turn ${promptNumber(ordinary.total)}`);
    if (fourth) parts.push(`the fourth wake ${promptNumber(fourth.total)}`);
    parts.push("The standing text is the same bytes in all three and the board is the same tail message; only the charter and the queue digest change shape.");
    summary.textContent = parts.join("; ").replace("; The standing", ". The standing");
    summary.classList.remove("bad");
  }
  if (legend) {
    const b = model.budget || {};
    const g = model.gates || {};
    const bits = [];
    if (b.charter !== undefined) bits.push(`charter ${promptNumber(b.charter)}`);
    if (b.prompt !== undefined) bits.push(`role prompt ${promptNumber(b.prompt)}`);
    if (b.board !== undefined) bits.push(`board ${promptNumber(b.board)}`);
    if (b.projects !== undefined) bits.push(`projects ${promptNumber(b.projects)}`);
    if (b.rules !== undefined) bits.push(`rules ${promptNumber(b.rules)}`);
    if (b.notes !== undefined) bits.push(`notes ${promptNumber(b.notes)}`);
    if (b.watches !== undefined) bits.push(`watches ${promptNumber(b.watches)}`);
    if (b.queue !== undefined) bits.push(`queue ${promptNumber(b.queue)} (${g.queueRows || 5} rows)`);
    const gates = [g.queueLabel ? `the queue digest is due ${g.queueLabel}` : "", "the board tail rides every turn"].filter(Boolean).join("; ");
    legend.textContent = `${bits.length ? `Caps the boxes are reserved against: ${bits.join(" · ")}. ` : ""}${gates ? `${gates[0].toUpperCase()}${gates.slice(1)}.` : ""} Sizes are characters; shares are of that turn's total.`;
    legend.hidden = false;
  }
}

async function loadPromptBudget() {
  const box = $("prompt-diagrams");
  const summary = $("prompt-budget-summary");
  if (!box) return;
  if (!box.childElementCount && summary) {
    summary.textContent = "reading the prompt…";
    summary.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/prompt-budget", { timeoutMs: 10000 });
    const model = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(model.error || `HTTP ${r.status}`);
    paintPromptBudget(model);
    promptBudgetLoadedAt = Date.now();
  } catch (e) {
    if (summary) {
      summary.textContent = `the prompt budget could not be read: ${e.message}`;
      summary.classList.add("bad");
    }
  }
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

// A project's rules: the two events the editor needs. The clicks are in the board's own delegated handler (beside the
// host chip's, because they are the same header line); these are the input's `change` - a rule is saved when its row
// loses the caret or the reader presses Enter - and Enter in the "new rule" box, which adds rather than does nothing.
document.addEventListener("change", (e) => {
  const box = e.target.closest ? e.target.closest("[data-rule-text]") : null;
  if (!box) return;
  editRule(box.dataset.ruleProject, box.dataset.ruleText, box.value);
});

document.addEventListener("keydown", (e) => {
  const box = e.target.closest ? e.target.closest("[data-rules-new]") : null;
  if (!box || e.key !== "Enter") return;
  e.preventDefault();
  addRule(box.dataset.rulesNew);
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
// The 🌊 default is gone with the separate thinking pane: the one stream is the console, in every card.
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
// The console's row spacing, on :root, before the first console is drawn.
initConRowSpace();
// The command card's seven numbers, on :root, before the first console is drawn.
initCommandCardLook();
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

// ---- how many turns the Hot Agent search lists ----------------------------------------------
// The number the bar sends with every read, the server's fallback (lib/hot-agent/search.js) and the Settings row all
// come from public/core/hot-agent-list.js: one default (20), one range (1..100) and one browser key, so the three
// cannot disagree. This row is the only place the reader edits it.
function paintHotAgentListSetting() {
  const mod = globalThis.wtHotAgentList;
  const n = mod && typeof mod.read === "function" ? mod.read(localStorage) : 20;
  const input = $("hot-agent-list");
  if (input && document.activeElement !== input) input.value = String(n);
  const preview = $("hot-agent-list-preview");
  if (preview) preview.textContent = `Ctrl+Shift+Q opens on the newest ${n} ${n === 1 ? "turn" : "turns"} you wrote to worker agents`;
}

function saveHotAgentListSetting(value) {
  const mod = globalThis.wtHotAgentList;
  if (!mod || typeof mod.write !== "function") return;
  const saved = mod.write(localStorage, value);
  paintHotAgentListSetting();
  showNote(`Hot agent list ${saved} ${saved === 1 ? "turn" : "turns"} - the next Ctrl+Shift+Q lists that many`);
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
$("hot-agent-list")?.addEventListener("change", (e) => saveHotAgentListSetting(e.target.value));
$("hot-agent-list")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveHotAgentListSetting(e.target.value);
    e.target.blur();
  }
});
for (const btn of document.querySelectorAll("[data-hot-agent-list-set]")) {
  btn.addEventListener("click", () => saveHotAgentListSetting(btn.dataset.hotAgentListSet));
}
paintHotAgentListSetting();
startReorderClock();
paintReorderSetting();

// Reflect the remembered collapse state of the two fixed cards before the first paint of them. The fold a card
// nobody has chosen comes from the page's state (FIXED_DEFAULT_COLLAPSED, row 416), never from the class the
// shipped markup or a previous paint left behind; a card the reader has folded or unfolded keeps their choice.
defaultFixedCollapse();
for (const id of FIXED_CARDS) applyFixedCollapse(id);

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
    // The browser the clarify card names on a file link. Its own request, fired here and not awaited: the board must
    // paint from the stream without waiting on a registry read, and the label is rewritten in place when it lands.
    void apiFetch("/api/open-file")
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.browser) return;
        questionBrowser = String(d.browser);
        paintBrowserName();
      })
      .catch(() => {});
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
    // The stream's first frame is already a full snapshot; only issue a second read if it fails or stalls.
    if (!(await connect({ waitForSnapshot: true })) && !state.paused && state.awaitingStreamSnapshot) await resync({ automatic: true });
    // NO promotion on boot. A restored-open section is not a click: this loop used to POST /api/project/open for
    // every project the reader had ever left expanded, and each one promotes an old repo into a full re-probe and a
    // full row read. A boardful of restored sections therefore re-read the whole old fleet on EVERY reload, and
    // because the route answers before the read runs, nothing in the page felt slow while the server drowned. The
    // promotion signal is the reader's own click: toggleProject() reports the section they actually unfold. A
    // restored section keeps the rows it already has until then, which is what it showed before the gate existed.
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
