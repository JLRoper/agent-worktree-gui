// Tool output the live stream does not carry.
//
// The runs API sends `tool.completed` with a PREVIEW of the result, and on this gateway that preview is often
// empty (write_file's and patch's routinely are) - so the console shows "↳ patch" and nothing else, even though
// the tool did return something. The session store keeps the whole result: a `role='tool'` message with the
// tool's name, its call id and the full content. This reads them back for one turn's time window, so a console
// line can show the stream on demand.
//
// The content is the same JSON envelope the preview carries - `{"output": "..."}`, `{"success": true,
// "diff": "..."}`, `{"status": "ok", ...}` - and it is unwrapped by the SAME function the live preview uses
// (lib/tool-text.js). Printing it raw is what put a backslash-escaped diff in the console.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { unwrapToolText } from "./tool-text.js";

// A fold in the console sends the reader here for the rest of a result: the run stream carried the whole
// thing, the card kept only its head, and this is the store's own copy of it. `index` is which of the turn's
// results for that tool (the order the console paired them in), so one click reads ONE row instead of the
// whole array; `maxChars: 0` means the row comes back exactly as it was stored (the console's fold is a
// display cap, and the reader asked to see past it).
export function toolResults({ dbPath, sessionId, tool, from = 0, to = 0, limit = 20, index = null, maxChars = 6000 } = {}) {
  if (!sessionId || !tool || !dbPath || !existsSync(dbPath)) return [];
  const fromSec = from > 0 ? from / 1000 : 0;
  // A turn's clock is stamped by the panel; the last tool row of that turn can be written a moment later, and the
  // comparison is at second precision, so the window keeps two seconds of slack at the end.
  const toSec = to > 0 ? (to + 2000) / 1000 : Math.floor(Date.now() / 1000) + 60;
  const one = Number.isInteger(index) && index >= 0;
  let rows = [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db
        .prepare(
          `select id, tool_call_id, content, timestamp
             from messages
            where session_id = ? and role = 'tool' and tool_name = ?
              and timestamp >= ? and timestamp <= ?
            order by timestamp asc, id asc
            limit ?${one ? " offset ?" : ""}`,
        )
        .all(sessionId, tool, fromSec, toSec, one ? 1 : Math.max(1, limit), ...(one ? [index] : []));
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`tool results: ${sessionId}/${tool}: ${err?.message || err}`);
    return [];
  }
  return rows.map((r) => {
    const unwrapped = unwrapToolText(r.content);
    const full = [unwrapped.text, unwrapped.notes.length ? `(${unwrapped.notes.join(" · ")})` : ""].filter(Boolean).join("\n");
    const cut = maxChars > 0 && full.length > maxChars;
    return {
      id: r.id,
      at: Math.round(Number(r.timestamp) * 1000) || null,
      text: cut ? `${full.slice(0, maxChars)}\n… ${full.length - maxChars} characters not shown` : full,
      truncated: unwrapped.truncated || cut,
    };
  });
}
