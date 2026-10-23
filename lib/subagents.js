// Subagents a run has started, read from the Hermes store.
//
// The gateway does not stream a child's work to the parent's run events: the parent's `delegate_task` call is one
// long tool call, and everything the children do happens on their own sessions. But those children ARE recorded:
// a subagent is a `sessions` row with `source='subagent'`, `parent_session_id` set to the conversation that
// delegated it, and `model_config._delegate_from` carrying the same id (the field survives even when
// parent_session_id is null on older rows). Their messages are in `messages` like any other session.
//
// So the panel can show, per card: how many children exist, which are still open (ended_at IS NULL), when each
// last did something, how much it has done, and the newest thing it said or called.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const TTL_MS = 2000;
const cache = new Map(); // parent thread -> { at, rows }

const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "prompt", "text"];

function clip(text, n = 90) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// The newest thing a child did, in the order a reader would look for it: the tool it last called, else what it
// last said. Tool results are skipped - they are the library, not the story.
function peekOf(db, sessionId) {
  let rows = [];
  try {
    rows = db
      .prepare("select role, content, tool_calls, timestamp from messages where session_id = ? order by id desc limit 12")
      .all(sessionId);
  } catch {
    return null;
  }
  for (const m of rows) {
    if (m.role === "assistant" && m.tool_calls) {
      try {
        const calls = JSON.parse(m.tool_calls);
        const call = Array.isArray(calls) ? calls[calls.length - 1] : null;
        const fn = call && call.function;
        if (fn && fn.name) {
          let args = {};
          try {
            args = JSON.parse(fn.arguments || "{}");
          } catch {
            /* the model sometimes emits a non-JSON argument string */
          }
          const key = ARG_KEYS.find((k) => typeof args[k] === "string" && args[k]);
          return `${fn.name}${key ? ` · ${clip(args[key])}` : ""}`;
        }
      } catch {
        /* not a tool-call message after all */
      }
    }
    if (m.role === "assistant" && m.content && String(m.content).trim()) {
      return clip(String(m.content));
    }
  }
  return null;
}

export function subagentsFor(parentThread, { dbPath } = {}) {
  if (!parentThread || !dbPath || !existsSync(dbPath)) return [];
  const hit = cache.get(parentThread);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  let rows = [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const kids = db
        .prepare(
          `select id, title, started_at, ended_at, last_activity_at, last_activity_description,
                  message_count, tool_call_count
             from sessions
            where parent_session_id = ? or json_extract(model_config, '$._delegate_from') = ?
            order by started_at asc
            limit 12`,
        )
        .all(parentThread, parentThread);
      rows = kids.map((k) => ({
        id: k.id,
        title: clip(String(k.title || "").replace(/^Subagent:\s*/i, "") || k.id, 120),
        running: k.ended_at == null,
        startedAt: Number(k.started_at) * 1000 || null,
        at: Number(k.last_activity_at) * 1000 || null,
        msgs: Number(k.message_count) || 0,
        tools: Number(k.tool_call_count) || 0,
        peek: null,
      }));
      // Peeks cost a query each, so only for the children still working: those are the ones being watched.
      for (const row of rows) {
        if (!row.running) continue;
        row.peek = peekOf(db, row.id) || String(kids.find((k) => k.id === row.id)?.last_activity_description || "") || null;
      }
    } finally {
      db.close();
    }
  } catch {
    return hit?.rows || [];
  }
  cache.set(parentThread, { at: Date.now(), rows });
  return rows;
}