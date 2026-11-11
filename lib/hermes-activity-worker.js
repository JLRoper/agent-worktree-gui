// Hermes' SQLite API is synchronous. Never execute these reads on the panel's HTTP event loop.
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const originalTouched =
  "select session_id, tool_calls, timestamp from messages " +
  "where timestamp > ? and tool_calls is not null and length(tool_calls) > 16 " +
  "order by timestamp desc limit 250";

// The existing (session_id, timestamp) index can read each session's newest messages without
// scanning the large message bodies. Keep the GLOBAL newest 250, including closed and orphan
// sessions: limiting to only open sessions changes which messages the original query admitted.
// On an older Hermes schema without a usable index, preserve the original query in this worker.
export function readTouchedRows(db, cutoff) {
  const indexes = db.prepare("select name from pragma_index_list('messages') where partial = 0").all();
  const indexed = indexes.some(({ name }) => {
    const columns = db.prepare("select name from pragma_index_info(?) order by seqno").all(name);
    return columns[0]?.name === "session_id" && columns[1]?.name === "timestamp";
  });
  if (!indexed) return db.prepare(originalTouched).all(cutoff);

  const ids = db.prepare("select distinct session_id from messages").all();
  const recent = db.prepare(
    "select id, timestamp from messages where session_id is ? and timestamp > ? " +
      "and tool_calls is not null and length(tool_calls) > 16 order by timestamp desc, id asc limit 250",
  );
  let best = [];
  for (const { session_id } of ids) {
    best.push(...recent.all(session_id, cutoff));
    best.sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || Number(a.id) - Number(b.id));
    if (best.length > 250) best.length = 250;
  }
  const row = db.prepare("select session_id, tool_calls, timestamp from messages where id = ?");
  return best.map(({ id }) => row.get(id)).filter(Boolean);
}

export function readSessionRows(db, now) {
  const activity = "coalesce(s.last_activity_at, (select max(m.timestamp) from messages m where m.session_id = s.id))";
  return db.prepare(
    "select s.id, s.title, s.cwd, " + activity + " as last_activity_at, s.ended_at, " +
      "exists(select 1 from session_turn_leases l where l.conversation_id = s.id and l.expires_at > ?) as leased " +
      "from sessions s order by " + activity + " desc limit 300",
  ).all(now);
}

if (!isMainThread) {
  let db;
  try {
    try {
      db = new DatabaseSync(workerData.dbPath, { readOnly: true });
    } catch (error) {
      parentPort.postMessage({ error: String(error?.message || error), phase: "open" });
    }
    if (db) {
      const rows = workerData.kind === "sessions"
        ? readSessionRows(db, workerData.now)
        : readTouchedRows(db, workerData.now - 20 * 60);
      parentPort.postMessage({ rows });
    }
  } catch (error) {
    parentPort.postMessage({ error: String(error?.message || error), phase: "query" });
  } finally {
    db?.close();
  }
}
