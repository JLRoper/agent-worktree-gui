// What an agent thought before it acted, read from the Hermes store.
//
// The runs API does carry a `reasoning.available` progress event, but it is a preview (the first 500 chars of a
// block, sent once) and on the durable-admission path it is not relayed at all. The store has the whole thing:
// `messages.reasoning_content` (older rows: `reasoning`) holds each block on the assistant message it belongs to,
// timestamped, for every surface including subagents.
//
// A read that FAILED and a turn that recorded NOTHING are two different facts, and the caller has to be able to tell
// them apart: this is the only pane on a card that is polled from a store (`/api/thinking` every ~2.4 s while a turn
// runs) instead of appended from the run's own line stream, so an answer the panel cannot trust must not be allowed to
// overwrite what the reasoning block is already showing. Hence `{ blocks, error }` rather than a bare array.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const MAX_BLOCK_CHARS = 8000;
const MAX_BLOCKS = 60;

/**
 * One turn's reasoning blocks, oldest first.
 * @returns {{ blocks: Array<{at: number|null, text: string}>, error: string|null }}
 *          `error` is set when the store could not be read at all, and `blocks` is then empty — which is why the
 *          caller must not read an empty array as "nothing was thought".
 */
export function thinkingFor(sessionId, { dbPath, from = null, to = null } = {}) {
  const out = { blocks: [], error: null };
  if (!sessionId || !dbPath || !existsSync(dbPath)) return out;
  const blocks = out.blocks;
  // Two rows with the same timestamp and the same text are ONE thought stored twice (measured on this box: 494 such
  // pairs, always identical). Drawn as two blocks it is the same paragraph repeated, and both would carry the same
  // `think:<at>` lid — the one identity the pacer keeps a single visible prefix for, so the two would paint each
  // other's words. Deduplicated here, at the read, so no renderer has to know.
  const seen = new Set();
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
        const capped = text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS - 1)}…` : text;
        const dedupe = `${r.timestamp}|${capped.length}|${capped.slice(0, 64)}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        blocks.push({ at: Math.round(Number(r.timestamp) * 1000) || null, text: capped });
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`thinking ${sessionId}: ${err?.message || err}`);
    out.error = String(err?.message || err);
    blocks.length = 0;
  }
  return out;
}
