// The Hot Agent search's prefix: /api/hot-agent/search, its one method and its 405.
//
//   GET /api/hot-agent/search?q=<query>&limit=<n>
//
// Answers the second header search: the turns the READER wrote to worker agents across every tree, newest first,
// each with the agent, its thread and the project tree. `lib/hot-agent/search.js` owns what is eligible, the
// matching and the order; this adapter owns the status codes and the wire shape, exactly as
// routes/assistant-search.js does for the assistant's own search.
//
//   q      optional. An EMPTY box is a real read here - "the most recent turns" - so a missing q is not a 400.
//   limit  how many turns to show; absent is the shared default (public/core/hot-agent-list.js, 20), and anything
//          outside 1..100 is clamped by that same module rather than refused. A non-integer is a 400: a typo must
//          not answer a different question than it looks like.
//
// A read: no token, like the assistant search's GET and /api/jobs. The transport helper travels in from the
// composition root, so this module imports no HTTP layer and a test can drive the handler with a stub sendJson and
// a plain `{ searchHotAgents }` object.

import { HOT_AGENT_DEFAULT_LIMIT, HOT_AGENT_LIMIT_MAX, searchHotAgents } from "../lib/hot-agent/search.js";

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const HOT_AGENT_SEARCH_PATH = "/api/hot-agent/search";

export function createHotAgentSearchRoutes({ jobs, assistant = null, sendJson } = {}) {
  if (!jobs || typeof jobs.list !== "function") throw new Error("createHotAgentSearchRoutes needs the Jobs store");
  if (typeof sendJson !== "function") throw new Error("createHotAgentSearchRoutes needs sendJson from the server's transport");
  // The manager's own thread set: a reader turn typed on the board assistant's card was written to the MANAGER, so
  // it is not a worker turn. The Assistant instance is where those threads live (lib/assistants.js `threadId`), and
  // it is optional so a test can drive this route with a store alone.
  const assistantThreads = () => {
    const list = Array.isArray(assistant?.assistants) ? assistant.assistants : [];
    return list.map((record) => String(record?.threadId || "")).filter(Boolean);
  };
  return async function hotAgentSearchRoutes(req, res, route, url) {
    if (route !== HOT_AGENT_SEARCH_PATH) return false;
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;

    if (req.method === "GET") {
      const q = String(params.get("q") == null ? "" : params.get("q"));
      const rawLimit = params.get("limit");
      let limit = HOT_AGENT_DEFAULT_LIMIT;
      if (rawLimit != null && String(rawLimit).trim() !== "") {
        const n = Number(rawLimit);
        if (!Number.isInteger(n) || n < 1 || n > HOT_AGENT_LIMIT_MAX) {
          sendJson(res, 400, { error: `limit is how many turns to show - an integer from 1 to ${HOT_AGENT_LIMIT_MAX}, not ${JSON.stringify(String(rawLimit))}` });
          return true;
        }
        limit = n;
      }
      try {
        const records = (id) => (typeof jobs.get === "function" ? jobs.get(id) : null);
        const out = searchHotAgents({ summaries: jobs.list(), records, query: q, limit, assistantThreads: assistantThreads() });
        sendJson(res, 200, { ok: true, ...out });
      } catch (err) {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      }
      return true;
    }

    sendJson(res, 405, { error: `${req.method} is not allowed on ${HOT_AGENT_SEARCH_PATH}` });
    return true;
  };
}
