// The header's Clarify popup, one read: every clarify question this panel has asked the reader, newest first, with the
// honest total beside the page of rows. The store is lib/clarify-history.js; this adapter owns only the wire shape.
//
//   GET /api/clarify/history?limit=50   -> { entries, total, kept, cap }
//
// `limit` is the RENDER cap the page asks for, never a filter on the total: `total` always counts what the store holds,
// so "showing 50 of 137" cannot become a silent truncation. With no limit every kept row is returned (the store's own
// CLARIFY_HISTORY_KEEP is the only bound).
//
// The read is deliberately outside the state snapshot: the snapshot is polled every tick by every open page, and the
// history changes only when a prompt arrives or settles, so the popup fetches this when it opens (and on a slow tick
// while it is open) rather than making every board poll carry a growing list.
//
// Names are refreshed at READ time where the panel can still resolve them: an assistant renamed since the question was
// asked shows its current name, while the stored one is the fallback for an assistant that has been deleted.

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const CLARIFY_HISTORY_PATH = "/api/clarify/history";

export function createClarifyHistoryRoutes({ jobs, nameForAssistant = null, sendJson } = {}) {
  if (!jobs) throw new Error("createClarifyHistoryRoutes needs the Jobs instance");
  if (typeof sendJson !== "function") throw new Error("createClarifyHistoryRoutes needs sendJson from the server's transport");
  const nameFor = typeof nameForAssistant === "function" ? nameForAssistant : () => null;
  return async function clarifyHistoryRoutes(req, res, route, url) {
    if (route !== CLARIFY_HISTORY_PATH) return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "only GET" });
      return true;
    }
    const store = jobs.clarifyHistory;
    if (!store) {
      sendJson(res, 200, { entries: [], total: 0, kept: 0, cap: 0 });
      return true;
    }
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;
    const raw = Number(params.get("limit"));
    const out = store.list({ limit: Number.isFinite(raw) && raw > 0 ? raw : null });
    const entries = out.entries.map((e) => {
      const live = e.assistantId ? nameFor(e.assistantId) : null;
      return live && live !== e.assistantName ? { ...e, assistantName: String(live) } : e;
    });
    sendJson(res, 200, { ...out, entries });
    return true;
  };
}
