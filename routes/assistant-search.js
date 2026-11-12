// The assistant search's prefix: /api/assistant/search, its one method and its 405.
//
//   GET /api/assistant/search?q=<query>&scope=all|input&limit=<n>&assistantId=<id>
//
// Answers the assistant pane's header search over the PERSISTED turns - not over the card on screen, which holds
// five turns and a 60-line console tail. `lib/assistant/search.js` owns the matching (the `*`/`?` wildcards, the
// substring rule, the metacharacter escaping) and the cap's preference; this adapter owns the status codes and the
// wire shape, exactly as routes/assistant-queue.js does for the queue.
//
//   q            required; a blank query is a 400, because "search for nothing" is the box being empty, not a read.
//   scope        `all` (default, every field) or `input` (the reader's own input only). Anything else is a 400
//                rather than a silent coercion: a typo must not answer a different question than it looks like.
//   limit        how many hits to show; absent is DEFAULT_SEARCH_LIMIT, a ceiling of SEARCH_LIMIT_MAX. The answer
//                always carries `matched` (everything that matched) beside `displayed` (what it holds).
//   assistantId  optional; one assistant's own turns (its current thread and any thread a hard restart left
//                behind). Absent searches every assistant's.
//
// The transport helpers travel in from the composition root, so this module imports no HTTP layer and a test can
// drive the handler with a stub sendJson and a plain `{ searchTurns }` object. A read: no token, like the queue's
// GET and /api/jobs.

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const SEARCH_PATH = "/api/assistant/search";

export function createSearchRoutes({ assistant, sendJson } = {}) {
  if (!assistant || typeof assistant.searchTurns !== "function") throw new Error("createSearchRoutes needs the Assistant instance");
  if (typeof sendJson !== "function") throw new Error("createSearchRoutes needs sendJson from the server's transport");
  return async function searchRoutes(req, res, route, url) {
    if (route !== SEARCH_PATH) return false;
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;

    if (req.method === "GET") {
      const q = String(params.get("q") == null ? "" : params.get("q")).trim();
      if (!q) {
        sendJson(res, 400, { error: "a query (q) is required - the search box does not call with an empty one" });
        return true;
      }
      const rawScope = params.get("scope");
      const scope = rawScope == null || String(rawScope).trim() === "" ? undefined : String(rawScope).trim().toLowerCase();
      if (scope !== undefined && scope !== "all" && scope !== "input") {
        sendJson(res, 400, { error: `scope is "all" or "input" - ${scope || "(blank)"} is neither` });
        return true;
      }
      const rawLimit = params.get("limit");
      let limit;
      if (rawLimit != null && String(rawLimit).trim() !== "") {
        const n = Number(rawLimit);
        if (!Number.isInteger(n) || n < 1) {
          sendJson(res, 400, { error: `limit is how many hits to show - a positive integer, not ${JSON.stringify(String(rawLimit))}` });
          return true;
        }
        limit = n;
      }
      const assistantId = String(params.get("assistantId") || "").trim() || null;
      try {
        const out = assistant.searchTurns({ query: q, scope, limit, assistantId });
        sendJson(res, 200, { ok: true, ...out });
      } catch (err) {
        const code = err && err.code === "assistant-unknown" ? 404 : 500;
        sendJson(res, code, { error: String((err && err.message) || err) });
      }
      return true;
    }

    sendJson(res, 405, { error: `${req.method} is not allowed on ${SEARCH_PATH}` });
    return true;
  };
}
