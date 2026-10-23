// Subagents a run has started, read from the Hermes store.
//
// The gateway does not stream a child's work to the parent's run events: the parent's `delegate_task` call is one
// long tool call, and everything the children do happens on their own sessions. But those children ARE recorded:
// a subagent is a `sessions` row with `source='subagent'`, `parent_session_id` set to the conversation that
// delegated it, and `model_config._delegate_from` carrying the same id (the field survives even when
// parent_session_id is null on older rows). Their messages are in `messages` like any other session.
//
// So the panel can show, per card: how many children exist and which are still open (ended_at IS NULL). Their
// output is not needed for that - the run's own start/complete events carry the status, and this lookup covers
// the case where a card was adopted after those events had already gone by.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const TTL_MS = 2000;
const cache = new Map(); // parent thread -> { at, rows }

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
          `select id, title, started_at, ended_at, last_activity_at, message_count, tool_call_count
             from sessions
            where parent_session_id = ? or json_extract(model_config, '$._delegate_from') = ?
            order by started_at asc
            limit 12`,
        )
        .all(parentThread, parentThread);
      rows = kids.map((k) => ({
        id: k.id,
        title: (String(k.title || "").replace(/^Subagent:\s*/i, "").replace(/\s+/g, " ").trim() || k.id).slice(0, 120),
        running: k.ended_at == null,
        startedAt: Number(k.started_at) * 1000 || null,
        at: Number(k.last_activity_at) * 1000 || null,
        msgs: Number(k.message_count) || 0,
        tools: Number(k.tool_call_count) || 0,
      }));
    } finally {
      db.close();
    }
  } catch (err) {
    // A vanished or locked store is not an error worth a card; a broken query is. Say which.
    console.error(`subagents: ${parentThread}: ${err?.message || err}`);
    return hit?.rows || [];
  }
  cache.set(parentThread, { at: Date.now(), rows });
  return rows;
}
// The whole board in one query: every child that started in the last few hours, grouped by the thread that
// delegated it. One poll for all cards beats a lookup per card, and it answers the case that matters most - a
// child still working after the turn that started it has already finished.
const ROSTER_TTL_MS = 2000;
let rosterCache = { at: 0, value: {} };

export function subagentRoster({ dbPath, windowSeconds = 7200 } = {}) {
  if (!dbPath || !existsSync(dbPath)) return {};
  if (Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.value;
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const roster = {};
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const kids = db
        .prepare(
          `select id, coalesce(parent_session_id, json_extract(model_config, '$._delegate_from')) as parent,
                  title, started_at, ended_at
             from sessions
            where source = 'subagent' and started_at > ?
            order by started_at asc
            limit 200`,
        )
        .all(since);
      for (const k of kids) {
        if (!k.parent) continue;
        const key = String(k.parent);
        (roster[key] ||= []).push({
          id: k.id,
          title: (String(k.title || "").replace(/^Subagent:\s*/i, "").replace(/\s+/g, " ").trim() || k.id).slice(0, 120),
          running: k.ended_at == null,
          startedAt: Math.round(Number(k.started_at) * 1000) || null,
        });
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`subagents roster: ${err?.message || err}`);
    return rosterCache.value;
  }
  rosterCache = { at: Date.now(), value: roster };
  return roster;
}
