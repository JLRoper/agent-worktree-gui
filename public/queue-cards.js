// queue-cards.js - the ENTRY POINT for one assistant's task queue as a column of cards, and nothing else. The queue
// was cut out of public/assistant.js into this file (step 5 of docs/reports/module-map-2026-11-07.html's order of
// work); entry 8 of docs/reports/module-separation-2026-11-28.html then split the queue itself, and this is the file
// that is left:
//
//   public/board/queue-row.js     the pane's state, the row and its head, the chips, the agents and the reader's order
//   public/board/queue-drag.js    the pointer gesture that reorders the cards
//   public/board/queue-detail.js  the stopped chip and the full card, the paint, the two reads and the one write path
//
// WHY IT STILL EXISTS. public/assistant.js is an IIFE, so the queue's code cannot reach that file's helpers by name:
// the panel calls ONE factory, hands it hostFor, sessionById, asPost, setErr and the rest, and gets the queue's names
// back under exactly the spellings its call sites already use. That factory is this file. It also owns the order the
// three cuts are built in and the three names a cut calls but does not own: the row cut asks for the paint, the read
// and the pane's scroller, and the card cut asks the drag whether a gesture is live. Those travel as thunks over one
// record this file fills as each cut is built, so no cut has to know which of the others was built first.
//
// WHAT IT REACHES OUT FOR: nothing of its own. Every helper a cut needs is handed straight through from `deps`.
//
// THE LOAD CONTRACT. public/index.html loads /board/queue-row.js, /board/queue-drag.js, /board/queue-detail.js and
// then this file, all before assistant.js; each cut file declares one factory and no page names, so only this file's
// position (before assistant.js, after the cuts) matters. The cuts keep the queue sub-tab marker pair
// the test harnesses slice on, and this file no longer carries a region of its own.


window.WMApp = window.WMApp || {};
window.WMApp.queueCards = function queueCards(deps) {
  "use strict";
  // THE CUTS, built in the order their bodies allow: the row holds the state the other two read, the card cut
  // reads the row and asks the drag one question, and the drag reads both. `live` is the record the thunks
  // below read through, filled as each cut is built - so a name can be handed over before the cut that owns it
  // exists, and every body keeps the spelling it had inside the one closure.
  const live = {};
  const later = {
    renderAssistantQueue: (...a) => live.renderAssistantQueue(...a),
    loadQueue: (...a) => live.loadQueue(...a),
    queueScrollerOf: (...a) => live.queueScrollerOf(...a),
    dragLive: () => live.dragLive(),
  };
  const row = window.WMApp.queueRow({ ...deps, later });
  const detail = window.WMApp.queueDetail({ ...deps, later, row });
  const drag = window.WMApp.queueDrag({ ...deps, row, detail });
  Object.assign(live, {
    renderAssistantQueue: detail.renderAssistantQueue,
    loadQueue: detail.loadQueue,
    queueScrollerOf: drag.queueScrollerOf,
    dragLive: drag.dragLive,
  });

  // The names the panel keeps reading after the move: the paint and its two reads, the one write path, the
  // re-attach press, the order's own constants, the picker's record, the drag's functions, the one line of drag
  // state a fresh press clears, the task id's own two answers (whose row it is, and the press that finds it),
  // and THE ONE CARD (taskCardHtml), which the Initiatives tab calls in its compact mode.
  const {
    QUEUE_LIVE, queueDropNotes, queueShown, queueWindowOf, QUEUE_MORE,
    taskOwnerOf, taskIndexRev, ensureTaskIndex, queueOpenTask,
  } = row;
  const {
    renderAssistantQueue, loadQueue, queueAct, queueReattach,
    qmoveOpen, closeQueueMove, toggleQueueMove, taskCardHtml,
  } = detail;
  const { queueCardDown, queueCardMove, queueCardUp, queueCardClickGuard, queueDragReset } = drag;

  return {
    renderAssistantQueue, loadQueue, queueAct, queueReattach,
    QUEUE_LIVE, qmoveOpen, closeQueueMove, toggleQueueMove,
    queueDropNotes, queueShown, queueWindowOf, QUEUE_MORE,
    queueCardDown, queueCardMove, queueCardUp, queueCardClickGuard,
    taskOwnerOf, taskIndexRev, ensureTaskIndex, queueOpenTask, taskCardHtml,
    queueDragReset,
  };
};
