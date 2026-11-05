// The read-only half of the assistant reset: what the durable store says is still fencing one session.
//
// The fence lives in `session_admissions` (`hermes_state_runtime.py:211-213`), not in a run's memory and not in this
// panel's job store. A row is `unknown` when a gateway lost ownership of a turn it had started; while any row for a
// session is `started` or `unknown`, the store refuses to claim that session's FIFO head. That is why a gateway
// restart does not clear it, and why the panel cannot answer the question from its own cards.
//
// This module reads exactly one question — the `unknown` rows for one session — with `DatabaseSync` opened
// `readOnly`, the same pattern `lib/session-usage.js` uses against the same file. It writes nothing: the resolve is
// the gateway's call, and the reset route never edits the store behind the gateway's back.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** One `unknown` admission, as the store holds it. `generation` is what the store recorded; the resolve body uses the
 * generation a fresh `GET /v1/runs/{id}` returns, never this one, so this value is evidence rather than the body. */
export function unknownAdmissions(dbPath, threadId) {
  const file = String(dbPath || "");
  const session = String(threadId || "").trim();
  if (!file || !session) {
    return { ok: false, rows: [], error: "no session store path or session id was given" };
  }
  if (!existsSync(file)) {
    return { ok: false, rows: [], error: `the session store is not there: ${file}` };
  }
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT seq, admission_id, request_id, target_session_id, status, outcome, owner_epoch, generation " +
          "FROM session_admissions WHERE target_session_id = ? AND status = 'unknown' ORDER BY seq",
      )
      .all(session);
    return {
      ok: true,
      rows: rows.map((row) => ({
        seq: Number(row.seq),
        admissionId: String(row.admission_id || ""),
        requestId: String(row.request_id || ""),
        threadId: String(row.target_session_id || ""),
        status: String(row.status || ""),
        ownerEpoch: row.owner_epoch == null ? null : Number(row.owner_epoch),
        generation: row.generation == null ? null : Number(row.generation),
      })),
      error: null,
    };
  } catch (err) {
    return { ok: false, rows: [], error: String((err && err.message) || err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* a read-only handle that cannot close has nothing this caller can repair */
    }
  }
}
