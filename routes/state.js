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

export function createStateRoutes({ snapshot, sendJson } = {}) {
  if (typeof snapshot !== "function") {
    throw new Error("createStateRoutes needs snapshot from the composition root");
  }
  if (typeof sendJson !== "function") {
    throw new Error("createStateRoutes needs sendJson from the server's transport");
  }
  return async function stateRoutes(req, res, route) {
    if (route !== STATE_PATH && route !== AUDIT_PATH) return false;
    // The lifted block's own answer: one snapshot, status 200, sendJson's headers and gzip threshold. What used to
    // be `return sendJson(...)` is `sendJson(...); return true` because `true` is the mount table's contract: this
    // row answered, so the chain stops here. The bytes on the wire are the same either way.
    sendJson(res, 200, snapshot());
    return true;
  };
}
