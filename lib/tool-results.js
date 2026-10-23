// Tool output the live stream does not carry.
//
// The runs API sends `tool.completed` with a PREVIEW of the result, and on this gateway that preview is often
// empty (write_file's routinely is) - so the console shows "↳ write_file" and nothing else, even though the tool
// did return something. The session store keeps the whole result: a `role='tool'` message with the tool's name, its
// call id and the full content. This reads them back for one turn's time window, so a console line can show the
// stream on demand.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// content is usually a JSON envelope ({"output": "..."}) and sometimes plain text; both have to survive.
function unwrapContent(raw) {
  const s = String(raw ?? "");
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") {
      for (const k of ["output", "text", "stdout", "result", "content"]) {
        if (typeof parsed[k] === "string") return parsed[k];
      }
      return JSON.stringify(parsed, null, 0);
    }
    if (typeof parsed === "string") return parsed;
  } catch {
    /* plain text */
  }
  return s;
}

export function toolResults({ dbPath, sessionId, tool, from = 0, to = 0, limit = 8, maxChars = 6000 } = {}) {
  if (!sessionId || !tool || !dbPath || !existsSync(dbPath)) return [];
  const fromSec = from > 0 ? from / 1000 : 0;
  const toSec = to > 0 ? to / 1000 : Math.floor(Date.now() / 1000) + 60;
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
            limit ?`,
        )
        .all(sessionId, tool, fromSec, toSec, Math.max(1, limit));
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`tool results: ${sessionId}/${tool}: ${err?.message || err}`);
    return [];
  }
  return rows.map((r) => {
    const full = unwrapContent(r.content).replace(ANSI, "").replace(/\r/g, "");
    return {
      id: r.id,
      callId: r.tool_call_id || null,
      at: Math.round(Number(r.timestamp) * 1000) || null,
      text: full.length > maxChars ? `${full.slice(0, maxChars)}\n… ${full.length - maxChars} characters not shown` : full,
      truncated: full.length > maxChars,
    };
  });
}
