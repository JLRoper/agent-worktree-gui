// The assistant queue's prefix: /api/assistant/queue, both of its methods and its 405.
//
// Step 8 of docs/reports/module-map-2026-11-07.html cuts one route prefix at a time into routes/, mounted from a table
// in server.js. The report names no prefix first, so the queue went first: its handlers were already the most cohesive
// set, and the only thing server.js still held for this prefix was the mount itself. The handler below is lifted
// verbatim from lib/assistant/queue.js, which keeps the schema, the transitions and the file; the transport helpers
// still travel in from the composition root, so this file knows no HTTP layer and a test can drive the handler with
// stub sendJson/readBody/authorised helpers and a real Assistant over a temp directory.
//
//   GET  /api/assistant/queue?assistantId=<id>   one assistant's queue, decorated and counted. With no id, every
//                                                assistant's, in one read.
//   POST /api/assistant/queue                     {assistantId?, action, ...} - add | edit | state | reassign |
//                                                reorder | pipeline | pipeline-release | delete. `add` and `edit` take
//                                                an optional `project` (the panel writes it at a cut, a script may post
//                                                a path), and `pipeline` puts a task on a stage or clears it back to
//                                                assistant-decides.
//
// `assistant.queueView`/`queueMutate` own the file path and the read-modify-write; this adapter owns the status codes
// and the wire shape. A refusal carries the same sentence the Assistant would have thrown, so a failed write in the
// page and a failed write in a script read the same way.

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const QUEUE_PATH = "/api/assistant/queue";

export function createQueueRoutes({ assistant, config = {}, sendJson, readBody, authorised } = {}) {
  if (!assistant) throw new Error("createQueueRoutes needs the Assistant instance");
  // The transport helpers travel in from the composition root rather than being imported here: this module then owns
  // no HTTP knowledge at all, and a test can drive the handler with stubs and a real Assistant over a temp directory.
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createQueueRoutes needs sendJson, readBody and authorised from the server's transport");
  }
  return async function queueRoutes(req, res, route, url) {
    if (route !== QUEUE_PATH) return false;
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;
    const id = params.get("assistantId") || undefined;

    if (req.method === "GET") {
      try {
        if (id) {
          sendJson(res, 200, { queue: assistant.queueView(id), assistant: assistant.state() });
        } else {
          // The list form: one view per assistant, the same shape a single read returns. The digest is computed here
          // rather than in the page so the preamble and the tab cannot disagree about what "top of the queue" means.
          const queues = (assistant.assistants || []).map((rec) => assistant.queueView(rec.id));
          sendJson(res, 200, { queues, assistant: assistant.state() });
        }
      } catch (err) {
        const code = err && err.code === "assistant-unknown" ? 404 : 500;
        sendJson(res, code, { error: String((err && err.message) || err) });
      }
      return true;
    }

    if (req.method === "POST") {
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
      const action = String(payload.action || "").trim();
      if (!action) {
        sendJson(res, 400, { error: "an action is required: add, edit, state, reassign, reorder, pipeline, pipeline-release or delete" });
        return true;
      }
      try {
        const out = assistant.queueMutate(payload.assistantId || id, action, payload, { by: payload.by || "reader" });
        if (!out || out.ok === false) {
          sendJson(res, 400, { error: (out && out.error) || "the queue change was refused" });
          return true;
        }
        sendJson(res, 200, { ...out, assistant: assistant.state() });
      } catch (err) {
        const code =
          err && err.code === "assistant-unknown"
            ? 404
            : err && err.code === "queue-write-failed"
              ? 500
              : err && /^(queue-state|queue-title|queue-owner|queue-hold|queue-order|pipeline-bundle|pipeline-id|pipeline-stage|pipeline-clock)$/.test(String(err.code || ""))
                ? 400
                : 500;
        sendJson(res, code, { error: String((err && err.message) || err) });
      }
      return true;
    }

    sendJson(res, 405, { error: `${req.method} is not allowed on ${QUEUE_PATH}` });
    return true;
  };
}
