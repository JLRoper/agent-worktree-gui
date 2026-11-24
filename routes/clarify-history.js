// The header's Clarify popup and its one write, over the store in lib/clarify-history.js. This adapter owns only the
// wire shape and the ORDER the refusals are decided in; the store owns the records.
//
//   GET  /api/clarify/history?limit=50   -> { entries, items, total, attempts, outstanding, kept, cap }
//   POST /api/clarify/reask              { seq }            -> { ok, thread, job, reask, text }
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
// ---- the RE-ASK, and the order its guards are decided in ---------------------------------------------------------
//
// A question the reader MISSED (its card timed out or went away with no answer) carries one button. Pressing it sends
// ONE message into the SAME thread the question was asked in - the reader's line and the question quoted in full from
// the STORED record, never from the popup's 400-character display line - and records that it happened. The guards are
// separate refusals with their own sentences, in this order:
//
//   1. the record exists           404 - the question fell off the store's cap, so there is nothing to quote.
//   2. it has a question           400 - a row from a build that kept no text cannot be quoted.
//   3. its item is still MISSED    400 - answered, still open or answered in a reply is not a miss, and the button is
//                                  not drawn on those either; the route refuses what the page never offers.
//   4. it was not already re-asked 409 - the durable record, and the in-flight claim for two presses that arrive
//                                  together. This is the one-send-per-item rule.
//   5. the thread is still here    404 - a deleted agent (or a thread the panel no longer holds) is NAMED, never sent
//                                  into nothing.
//   6. the thread is free          409 - a live run on that thread (or in its tree) is the standing two-runs-in-one-
//                                  thread failure; the refusal names the run.
//   7. the body quotes the record  500 - `reaskQuoteCheck` before the send: a body that lost the question's bytes (a
//                                  truncated display line, a newline folded to a space) is never sent.
//
// Only after all seven does the injected `sendReask` run - the composition root's own thread-send path
// (`startThreadReply`, or the assistant's route for its thread), so this module starts no turn by a second route.
// Nothing here invents a pending mechanism: the re-asked card arrives the way every card does, from the run's own
// `clarify.request` into `j.question`.

import { clarifyItems, collapseKey, readerReplies, reaskQuoteCheck, reaskText } from "../lib/clarify-history.js";

/** The read the popup makes, and the prefix the mount table in server.js matches on. */
export const CLARIFY_HISTORY_PATH = "/api/clarify/history";
export const CLARIFY_REASK_PATH = "/api/clarify/reask";
export const CLARIFY_PATH = "/api/clarify";

const ageOf = (iso, now = Date.now()) => {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return "";
  const ms = Math.max(0, now - at);
  const min = 60_000;
  if (ms < min) return "moments ago";
  if (ms < 60 * min) return `${Math.max(1, Math.round(ms / min))}m ago`;
  if (ms < 24 * 60 * min) return `${Math.round(ms / (60 * min))}h ago`;
  return `${Math.round(ms / (24 * 60 * min))}d ago`;
};

export function createClarifyHistoryRoutes({
  jobs,
  nameForAssistant = null,
  sendJson,
  readBody = null,
  authorised = null,
  config = {},
  sendReask = null,
  now = () => Date.now(),
} = {}) {
  if (!jobs) throw new Error("createClarifyHistoryRoutes needs the Jobs instance");
  if (typeof sendJson !== "function") throw new Error("createClarifyHistoryRoutes needs sendJson from the server's transport");
  const nameFor = typeof nameForAssistant === "function" ? nameForAssistant : () => null;

  // One line per press for the panel's log: named by the question's own key and the turn the re-asked card will be
  // asked in, so a reader can find the send after the popup has moved on.
  const journal = (line) => {
    try {
      if (typeof jobs.onLog === "function") jobs.onLog(`clarify re-ask: ${line}`);
    } catch {
      /* a log that refuses must not fail the press it describes */
    }
  };

  async function reask(req, res) {
    if (typeof authorised !== "function" || typeof readBody !== "function" || typeof sendReask !== "function") {
      sendJson(res, 501, { error: "this build has no clarify re-ask sender wired, so nothing was sent" });
      return true;
    }
    if (!authorised(req, config.token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    const body = await readBody(req).catch(() => ({}));
    const seq = Number(body?.seq);
    const store = jobs.clarifyHistory;
    if (!store) {
      sendJson(res, 404, { error: "this panel keeps no clarify history, so there is nothing to re-ask", code: "no_history" });
      return true;
    }
    // ---- 1. the record -----------------------------------------------------------------------------------------
    const all = store.list().entries;
    let entry = Number.isFinite(seq) && seq > 0 ? all.find((e) => Number(e.seq) === seq) || null : null;
    if (!entry && body?.key) entry = store.find(String(body.key));
    if (!entry) {
      sendJson(res, 404, {
        error: "that question is no longer in the clarify history, so there is nothing to quote and nothing was sent",
        code: "clarify_gone",
      });
      return true;
    }
    // ---- 2. it has a question to quote -------------------------------------------------------------------------
    const question = String(entry.question ?? "");
    if (!question.trim()) {
      sendJson(res, 400, {
        error: "that question was stored without its text, so it cannot be quoted and nothing was sent",
        code: "no_question",
      });
      return true;
    }
    // ---- 3. it is still a MISS ---------------------------------------------------------------------------------
    const items = clarifyItems(all, { replies: typeof jobs.list === "function" ? readerReplies(jobs.list()) : [] });
    const item = items.find((i) => i.group === collapseKey(entry)) || null;
    const state = String(item?.state || entry.status || "").trim();
    if (state === "answered") {
      sendJson(res, 400, {
        error: "that question was answered, so there is nothing to re-ask",
        code: "answered",
      });
      return true;
    }
    if (state === "open") {
      sendJson(res, 400, {
        error: "that question is still waiting on the card, so there is nothing to re-ask",
        code: "open",
      });
      return true;
    }
    if (state === "replied") {
      sendJson(res, 400, {
        error: "you answered that question in a reply, so there is nothing to re-ask",
        code: "replied",
      });
      return true;
    }
    // ---- 4. one send per item ----------------------------------------------------------------------------------
    const claim = store.beginReask(entry);
    if (!claim.ok) {
      const when = claim.reask?.at ? ` ${ageOf(claim.reask.at, now())}` : "";
      sendJson(res, 409, {
        ok: false,
        already: true,
        code: "already_reasked",
        error: claim.reask
          ? `that question was already re-asked${when}${claim.reask.jobId ? ` (in turn ${claim.reask.jobId})` : ""}, so nothing was sent again`
          : String(claim.why || "a re-ask of that question is already being sent"),
        reask: claim.reask || null,
      });
      return true;
    }
    // From here every exit releases the claim: nothing may leave a question looking permanently "being sent".
    const thread = String(entry.thread || "").trim();
    // ---- 5. the thread is still here ---------------------------------------------------------------------------
    if (!thread || (typeof jobs.firstOfThread !== "function" ? false : !jobs.firstOfThread(thread))) {
      store.abandonReask(entry);
      sendJson(res, 404, {
        error: thread
          ? `the session that asked "${thread}" is no longer on this board, so the re-ask was not sent`
          : "that question names no thread, so there is no session to send the re-ask to",
        code: "unknown_thread",
        thread: thread || null,
      });
      return true;
    }
    // ---- 6. the thread is free ---------------------------------------------------------------------------------
    const hold = typeof jobs.busyFor === "function" ? jobs.busyFor(thread) : { held: false };
    if (hold.held) {
      store.abandonReask(entry);
      const who = (hold.by || []).map((b) => `${b.id} ${b.status}`).join(", ");
      sendJson(res, 409, {
        ok: false,
        code: "thread_busy",
        error: `${hold.where === "tree" ? `the worktree of ${thread}` : thread} already has a live run${who ? ` (${who})` : ""} - a re-ask would start a second run on the same files, so nothing was sent. Wait for it to end, or steer the running turn.`,
        thread,
        running: hold.by || [],
      });
      return true;
    }
    // ---- 7. the body quotes the record -------------------------------------------------------------------------
    const text = reaskText(entry);
    const quote = reaskQuoteCheck(entry, text);
    if (!text || !quote.ok) {
      store.abandonReask(entry);
      sendJson(res, 500, {
        error: `the re-ask body did not carry the stored question${quote.missing.length ? ` (missing ${quote.missing.join(", ")})` : ""}, so nothing was sent`,
        code: "quote_lost",
      });
      return true;
    }
    // ---- the send ----------------------------------------------------------------------------------------------
    let out;
    try {
      out = await sendReask({ entry, text, thread });
    } catch (e) {
      out = { ok: false, error: String((e && e.message) || e), code: (e && e.code) || null };
    }
    if (!out || out.ok !== true) {
      store.abandonReask(entry);
      const code = String(out?.code || "");
      const status =
        Number(out?.status) >= 400
          ? Number(out.status)
          : ["thread_busy", "tree_busy", "tree_released"].includes(code)
            ? 409
            : code === "unknown_thread"
              ? 404
              : 502;
      sendJson(res, status, {
        ok: false,
        code: code || null,
        thread,
        error: String(out?.error || "the panel could not send the re-ask"),
      });
      return true;
    }
    const reask = store.finishReask(entry, {
      at: out.at || null,
      by: "reader",
      jobId: out.job?.id || null,
      thread,
      text,
    });
    journal(`${thread}: re-asked "${String(question).slice(0, 80).replace(/\s+/g, " ")}" in turn ${out.job?.id || "?"}`);
    sendJson(res, 202, { ok: true, thread, job: out.job || null, reask, text });
    return true;
  }

  return async function clarifyHistoryRoutes(req, res, route, url) {
    if (route === CLARIFY_REASK_PATH) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "only POST" });
        return true;
      }
      return reask(req, res);
    }
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
