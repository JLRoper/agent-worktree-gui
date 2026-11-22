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
  // One read, on a handle kept for the worker's life. A read-only open of the store is the expensive part of
  // this worker; the panel used to pay it on every liveness tick, which is where 66 worker CPU profiles in 2.5
  // minutes came from. The host keeps one worker per kind alive (lib/activity.js) and sends ids; the one-shot
  // workerData shape stays for a direct caller and its tests.
  const handles = new Map(); // dbPath -> DatabaseSync

  function readOn(kind, dbPath, now) {
    let db = handles.get(dbPath);
    if (!db) {
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
      } catch (error) {
        error.phase = "open";
        throw error;
      }
      handles.set(dbPath, db);
    }
    return kind === "sessions" ? readSessionRows(db, now) : readTouchedRows(db, now - 20 * 60);
  }

  function dropHandle(dbPath) {
    const db = handles.get(dbPath);
    if (!db) return;
    handles.delete(dbPath);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  if (workerData?.kind) {
    try {
      parentPort.postMessage({ rows: readOn(workerData.kind, workerData.dbPath, workerData.now) });
    } catch (error) {
      parentPort.postMessage({ error: String(error?.message || error), phase: error.phase || "query" });
    } finally {
      for (const dbPath of [...handles.keys()]) dropHandle(dbPath);
    }
  } else {
    parentPort.on("message", (message) => {
      if (!message || message.id === undefined) return;
      try {
        parentPort.postMessage({ id: message.id, rows: readOn(message.kind, message.dbPath, message.now) });
      } catch (error) {
        dropHandle(message.dbPath);
        parentPort.postMessage({ id: message.id, error: String(error?.message || error), phase: error.phase || "query" });
      }
    });
  }
}
