// render-projects.js - the board's project structure: a folder's card, a project's section, the worktree rows
// inside it, and the order all three sit in. Cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 19,886 lines and one file was one lane: every row repaint, every
// project re-rank and every scan tick landed in it. This is step 7 of the order of work in
// docs/reports/module-map-2026-11-07.html ("render-projects.js, then render-jobs.js. The two big cuts, last,
// because they are the ones that most want the helper files in place first"), and it takes the project half
// whole: 1,386 lines moved line for line. Not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   a folder's card        rootScanChip and rootChips, the counts on a folder's header, and rootSection, the
//                          accordion one scan root draws: its open state, its recent-only view, and one project
//                          section per project inside it
//   a project's section    projectSection, the whole section.project node: the head and its chips, the
//                          local-main and remote-tip line, the live board PIDs, the split table and the legend;
//                          and refreshChips, the one strip repainted in place instead of rebuilt
//   the worktree row       rowHtml, the template every cell of a row is written into, and the two clock columns
//                          under it: RING_C, noteScan, eventLifeAt, lifeAtFor, ringState, ringOffset, ringStroke,
//                          lifeCellHtml and paintLifeCell (the age number and the chips), nextReadCellHtml and
//                          paintNextReadCell (the ring and its countdown). rowKeyForThread, pulseRow and pulseProject
//                          are the lookups and the two green pulses an event and a scan both use
//   children under a       childTreeOf, groupCtxOf and nestRowKeys (which row hangs under which, and the drawing
//   parent                 order that keeps a child directly under its parent), foldTitle, foldButtonHtml,
//                          paintFoldButton, paintRowGroup, paintUnder, markUnder, syncChildGroups and
//                          toggleChildFold, the one fold that only hides
//   where a folder sits    projectActivity, folderActivity, shownInRoot, projectRanks, sortedProjects,
//                          pinOpenProjects, reorderFrame and queueReorderProjects, plus reorderProjects itself
//                          and the three child reads under it (childrenMatching, boardGroups, groupBody)
//   where a row and its    stabilizeOn and STABILIZE_KEY (a list freezes while something in it is open),
//   cards sit              projectHasOpenRow, rowHasOpenCard, orderedAgents, rememberAgentOrder and
//                          rememberAgentOrders, the row and card re-rank (reorder), the two move flashes
//                          (flashMovedByKey, flashMoved), the SSE batch (pendingRows, rowFrame, queueRow), the
//                          detail signature (DETAIL_VOLATILE, stableStringify, rowDetailSig), placeRow,
//                          removeRow and renderProjectRows
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state                  the page's state literal: projects, rows, expanded, expandedProjects, pollGap,
//                          lastScanAt, eventLife, agentOrder, foldedParents, detailEls and the rest
//   the small formatters   esc, keyOf, relTime and fmtDur (public/core/dom-format.js), and the names app.js
//                          still declares: normPath, rootOf, recentDays, flashRowMs and flashProjectMs
//   the page's helpers     $ and projectNode, rowNode and restartClassAnimation (public/dom.js),
//                          captureCardSelection (public/dom.js), captureTyping and restoreTyping, and the
//                          scroll books in public/board/console.js: holdScrolls, releaseScrolls, placeInOrder
//   the row's own          sigChips, agentBadgeHtml, chipsHtml, headTitle, hostChipHtml, hostPanelHtml,
//   painters               chartHeaderHtml and refreshTopToggle (public/charts.js), paintRefreshOffers,
//                          applyPendingFocus (public/settings.js), saveFoldedParents, saveExpandedProjects
//   the ranking            projectRankCtx and orderedByRank, the sliding average a folder, a project and a
//                          card are all ordered by; panelFor and isRowLive, the two liveness reads
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare
// name. This file DECLARES ONLY: no top-level statement, no listener and no read of an app.js binding while it
// loads (RING_C, reorderFrame, STABILIZE_KEY, pendingRows, rowFrame and DETAIL_VOLATILE are literal
// initialisers), so being loaded before app.js costs nothing. public/app.js re-exports these names on
// window.WMApp.projects.

// ---- the three cuts, and the re-export ------------------------------------------------------------
// Row 530 cut this file into three modules, one commit per cut, and this file keeps the header and the
// record of the surface. Cut 1: the project ordering, a folder's card, the legend and the project
// section are declared in public/board/project-order.js. Cut 2: the turnover containers, the children
// under their parent, the row itself, its kind column and its reviewed chip are declared in
// public/board/project-row.js. Cut 3: the age column, the stabilise hold, the re-rank, placeRow and
// renderProjectRows are declared in public/board/row-order.js. public/index.html loads the three in
// that order before this file and before app.js, and every name moved there is a top-level declaration
// in a classic script, so it is the same page global it was before the move; nothing here declares it
// twice.
