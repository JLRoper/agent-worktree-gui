// The state read's prefix: /api/state, and /api/audit, the same read under its older name.
//
// Step 8 of docs/reports/module-map-2026-11-08.html (the 2026-11-07 page, re-rendered) moves one route prefix at a
// time out of server.js and mounts it from the PREFIX_MOUNTS table. routes/assistant-queue.js and
// routes/assistant-delete.js are the two rows already there; this is the third, and the first lifted out of
// server.js's own if-chain rather than out of a lib/ module.
//
// The block this file replaces was:
//
//   if (route === "/api/state" || route === "/api/audit") {
//     return sendJson(res, 200, snapshot());
//   }
//
// ...and the handler below is that block, verbatim. It tests no method, so every method on either path answers the
// same 200 with the same snapshot: the 405 that the queue's route carries is deliberately NOT introduced here,
// because the route answered every method before this cut and has to keep answering every method after it.
//
// The seam is `snapshot`, which closes over the store, the registry, the jobs, the assistants and the settings, so
// it stays in the composition root and travels in as a function. `sendJson` travels in beside it, exactly as the
// queue's and the delete control's handlers get theirs: this file defines no transport helper and imports no HTTP
// layer, so a test can drive the handler with a recorder.
//
// `/api/audit` shares no prefix with `/api/state`, so the mount table carries a row for each; both rows are handed
// this one handler instance, and the paths below are the only place the pair is spelled.

/** The path the board polls, and the row the mount table in server.js matches on. */
export const STATE_PATH = "/api/state";

/** The read's older name. Its own row in the mount table, because it shares no prefix with STATE_PATH. */
export const AUDIT_PATH = "/api/audit";

// The board's own read: the projects, their rows, the settings the page draws them with, the tree list and the hosts
// - everything a section and a row need, and none of the panes (jobs, assistant, approvals, todos, collisions) the
// full snapshot carries. It is what the stream sends first and what the page can paint while the rest is built.
export const BOARD_PATH = "/api/board";

export function createStateRoutes({ snapshotText, boardText, sendJsonText, fullReady = null } = {}) {
  if (typeof snapshotText !== "function") {
    throw new Error("createStateRoutes needs snapshotText from the composition root");
  }
  if (typeof boardText !== "function") {
    throw new Error("createStateRoutes needs boardText from the composition root");
  }
  if (typeof sendJsonText !== "function") {
    throw new Error("createStateRoutes needs sendJsonText from the server's transport");
  }
  return async function stateRoutes(req, res, route) {
    // The compact board read. Same headers and gzip path as the state read; the body is the smaller projection.
    if (route === BOARD_PATH) {
      sendJsonText(res, 200, boardText());
      return true;
    }
    if (route !== STATE_PATH && route !== AUDIT_PATH) return false;
    // The lifted block's own answer: one snapshot, status 200, sendJson's headers and gzip threshold. What used to
    // be `return sendJson(...)` is `sendJson(...); return true` because `true` is the mount table's contract: this
    // row answered, so the chain stops here. The bytes on the wire are the same either way - the string itself now
    // comes from the snapshot cache, so a poll of an unchanged board reuses the one built for the last reader.
    //
    // While the boot pass is still walking the fleet the answer is the BOARD frame, not the full snapshot: the boot
    // suppresses every row frame until it finishes (see the store's gate), so a reader mid-boot can use the board
    // and nothing else, and building the panes here cost 1.2-2.5s per poll on this loop. The boot's own
    // broadcastSnapshot() delivers the full read to every client the moment it finishes.
    const ready = typeof fullReady === "function" ? fullReady() : true;
    sendJsonText(res, 200, ready ? snapshotText() : boardText());
    return true;
  };
}
