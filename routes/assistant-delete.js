// The delete control's route: POST /api/assistant/delete, dry or real.
//
// The module behind it (lib/assistant/remove.js) owns the refusals, the archive and the roster write.
// This file owns the path match, the body, the status codes and the envelope, in the same shape as the
// queue's route (routes/assistant-queue.js) and the reset's (lib/assistant/reset.js): the transport
// helpers travel in from the composition root, so a test can drive the handler with stubs and a real
// Assistant over a temp directory.
//
//   POST /api/assistant/delete  {assistantId, dryRun?}
//
// The dry run is the confirmation's own read: it returns the archive folder and the four files the
// second press will remove, and it throws the SAME refusal the real press would, so the pane can show
// "stop job X first" or "row #12 is still open" before arming anything.
import { deleteAssistant } from "../lib/assistant/remove.js";

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const DELETE_PATH = "/api/assistant/delete";

const STATUS_FOR = {
  "assistant-unknown": 404,
  "assistant-primary": 409,
  "assistant-busy": 409,
  "archive-failed": 500,
  "assistants-write-failed": 500,
};

export function createDeleteRoutes({ assistant, config = {}, sendJson, readBody, authorised } = {}) {
  if (!assistant) throw new Error("createDeleteRoutes needs the Assistant instance");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createDeleteRoutes needs sendJson, readBody and authorised from the server's transport");
  }
  return async function deleteRoutes(req, res, route, url) {
    if (route !== DELETE_PATH) return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${DELETE_PATH}` });
      return true;
    }
    if (!authorised(req, config.token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
      return true;
    }
    const payload = body && typeof body === "object" ? body : {};
    try {
      const out = deleteAssistant(assistant, payload.assistantId, {
        dryRun: payload.dryRun === true,
        by: payload.by ? String(payload.by) : "reader",
      });
      // The whole state rides back on a real delete so the page's roster and tab row repaint from one
      // answer; the dry run carries the plan alone and moves nothing.
      sendJson(res, 200, { ...out, assistant: assistant.state() });
    } catch (err) {
      const code = String((err && err.code) || "");
      sendJson(res, STATUS_FOR[code] || 400, {
        error: String((err && err.message) || err),
        ...(err && err.blockers ? { blockers: err.blockers } : {}),
      });
    }
    return true;
  };
}
