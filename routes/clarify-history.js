// The header's Clarify popup, one read: every clarify question this panel has asked the reader, newest first, with the
// honest total beside the page of rows. The store is lib/clarify-history.js; this adapter owns only the wire shape.
//
//   GET /api/clarify/history?limit=50   -> { entries, items, total, attempts, outstanding, kept, cap }
//
// `entries` is the store's own records (one per ASK, the shape this route answered before the popup learned to
// collapse). `items` is what the popup draws: one per QUESTION, with its attempts folded inside it and any answer in
// any attempt winning over a later card's closed word. `total` counts items, `attempts` counts the asks behind them,
// and `outstanding` is the number of items still waiting - the header button's count, read without opening the popup
// (`?limit=1` makes that read a single row).
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

import { readerReplies } from "../lib/clarify-history.js";

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
      sendJson(res, 200, { entries: [], items: [], total: 0, attempts: 0, outstanding: 0, kept: 0, cap: 0 });
      return true;
    }
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;
    const raw = Number(params.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
    // The reader's own replies are evidence that a card which closed unanswered was in fact answered in the reply box.
    // They come from the JOB store, because that is where a reply turn is recorded.
    const replies = typeof jobs.list === "function" ? readerReplies(jobs.list()) : [];
    const out = store.items({ limit, replies });
    const entries = store.list({ limit }).entries;
    // An assistant renamed since the ask shows its CURRENT name; the stored one is the fallback for a deleted one.
    const rename = (row) => {
      const live = row.assistantId ? nameFor(row.assistantId) : null;
      return live && live !== row.assistantName ? { ...row, assistantName: String(live) } : row;
    };
    sendJson(res, 200, {
      entries: entries.map(rename),
      items: out.items.map(rename),
      total: out.total,
      attempts: out.attempts,
      outstanding: out.outstanding,
      kept: out.kept,
      cap: out.cap,
    });
    return true;
  };
}
