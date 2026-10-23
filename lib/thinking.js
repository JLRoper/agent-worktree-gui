// What an agent thought before it acted, read from the Hermes store.
//
// The runs API does carry a `reasoning.available` progress event, but it is a preview (the first 500 chars of a
// block, sent once) and on the durable-admission path it is not relayed at all. The store has the whole thing:
// `messages.reasoning_content` (older rows: `reasoning`) holds each block on the assistant message it belongs to,
// timestamped, for every surface including subagents.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const MAX_BLOCK_CHARS = 8000;
const MAX_BLOCKS = 60;

export function thinkingFor(sessionId, { dbPath, from = null, to = null } = {}) {
  if (!sessionId || !dbPath || !existsSync(dbPath)) return [];
  const blocks = [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // Timestamps in the store are epoch seconds; the caller passes milliseconds (a turn's bounds).
      const since = Number.isFinite(from) ? from / 1000 : 0;
      const until = Number.isFinite(to) ? to / 1000 : Number.MAX_SAFE_INTEGER;
      const rows = db
        .prepare(
          `select timestamp, coalesce(reasoning_content, reasoning, '') as text
             from messages
            where session_id = ?
              and length(coalesce(reasoning_content, reasoning, '')) > 20
              and timestamp >= ? and timestamp <= ?
            order by timestamp asc
            limit ${MAX_BLOCKS}`,
        )
        .all(sessionId, since, until);
      for (const r of rows) {
        const text = String(r.text || "").trim();
        if (!text) continue;
        blocks.push({
          at: Math.round(Number(r.timestamp) * 1000) || null,
          text: text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS - 1)}…` : text,
        });
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`thinking ${sessionId}: ${err?.message || err}`);
    return [];
  }
  return blocks;
}