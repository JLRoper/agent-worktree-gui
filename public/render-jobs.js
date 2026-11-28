// render-jobs.js - the job card and its turns: the body a turn draws, the block a turn sits in, the card itself,
// and the render and update path that keeps them on the page. Cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 18,502 lines and one file was one lane: every streamed line, every
// card repaint and every turn fold landed in it. This is step 7 of the order of work in
// docs/reports/module-map-2026-11-07.html, the second of the two big cuts ("render-jobs.js ... job and turn cards:
// updateJob, appendJobLine, turn folding, the tool-call lines"), and it takes 861 lines line for line. Not one
// body was rewritten and not one call site was touched. The report names appendJobLine and drawJobLine under this
// row; both left app.js with the console in an earlier cut and live in public/board/console.js today.
//
// WHAT IS HERE
//
//   the turn's body        streamBodyHtml, mdRunHtml, condensedBodyHtml and turnBody: one flow of the panel's
//                          console lines, the reasoning blocks and each run of tool calls, drawn piece by piece so
//                          a live line only redraws the piece it belongs to
//   the turn's block       turnBlock: where one turn sits in its card, its head, its rail and the open or folded
//                          body
//   the card               conversationHtml, the card a thread draws: the head, its meta slots, the turns and the
//                          reply box; and jobHtml, the same card around one homeless run
//   the list and the       queueJobsRefresh and scheduleRenderJobs (the two coalesced repaints), renderJobs (the
//   update path            unattached list, its chips and its fold), paintAgentBadges (the row badge a job event
//                          moves), updateJob (one card replaced or repainted in place), conversationSignature (the
//                          signature that decides), paintCardMeta (the two slots that move without a rebuild) and
//                          renderConversation (one thread's card, rebuilt where it stands)
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state, esc               the page's state literal and the escaper
//   the turn land            turnHead, conversations, turnKey and turnIsOpen (public/turns.js), turnLive,
//                            turnStateText, turnSubagentsHtml, turnAttachmentsHtml, approvalPrompt, questionPrompt,
//                            questionAnswered, approvalDecided, pipelineChipHtml, artifactRowsHtml
//   the console land         captureScrolls, restoreScrolls, applyStoredScrolls, settleScrolls,
//                            ensureToolStore, applyStoredHeight and the move bracket in
//                            public/board/console.js; captureCardSelection, restoreCardSelection and selectionIn in
//                            public/dom.js
//   the card's own wiring    statsRowHtml, subagentsHtml, ghostTurnHtml, addAgentBarHtml, restoreReplyDraft,
//                            captureTyping, restoreTyping, applyPendingFocus (public/settings.js),
//                            reorderProjects (public/render-projects.js), fmtAgo, relTime
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare name.
// This file DECLARES ONLY: no top-level statement, no listener and no read of an app.js binding while it loads
// (jobsRefreshQueued and renderJobsQueued are literal initialisers), so being loaded before app.js costs nothing.
// public/app.js re-exports these names on window.WMApp.jobs.

// ---- THE CUT: this file's two modules -----------------------------------------------------------
// Cut 1 of 2: the body a turn draws and the block it sits in moved to public/board/stream-body.js,
// this file's lines 46-300, line for line.
// Cut 2 of 2: the stuck-turn chip, the card (conversationHtml and jobHtml), the unattached list, the
// delta's batch and the render and update path moved to public/board/conversation.js, this file's
// lines 302-1,282, line for line.
// Nothing but this header and the script tag is left, and the file declares nothing: both modules are
// classic scripts public/index.html loads immediately before this one, so every name the file used to
// declare is the page-wide binding it was. public/app.js's window.WMApp.jobs door still lists 17 of the
// 26 by name and every other bare-name caller still reads the same binding.
