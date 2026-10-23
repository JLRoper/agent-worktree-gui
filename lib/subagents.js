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
const HUNG_MS = 5 * 60 * 1000; // five minutes of silence from a running child
let rosterCache = { at: 0, value: {} };

export function subagentRoster({ dbPath, windowSeconds = 86400 } = {}) {
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
                  title, started_at, ended_at, last_activity_at, message_count
             from sessions
            where source = 'subagent' and started_at > ?
            order by started_at asc
            limit 200`,
        )
        .all(since);
      for (const k of kids) {
        if (!k.parent) continue;
        const key = String(k.parent);
        const startedAt = Math.round(Number(k.started_at) * 1000) || null;
        const lastSeen = Math.round(Number(k.last_activity_at || k.started_at) * 1000) || startedAt;
        const running = k.ended_at == null;
        (roster[key] ||= []).push({
          id: k.id,
          title: (String(k.title || "").replace(/^Subagent:\s*/i, "").replace(/\s+/g, " ").trim() || k.id).slice(0, 120),
          running,
          startedAt,
          endedAt: k.ended_at == null ? null : Math.round(Number(k.ended_at) * 1000) || null,
          lastSeen,
          // A child that has written nothing for this long is not "working quietly": it is worth flagging.
          hung: running && Date.now() - lastSeen > HUNG_MS,
          msgs: Number(k.message_count) || 0,
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

// A child's console: its own messages, in the same shape the card's transcript uses - prompts, assistant text, the
// tool calls it made and what they returned. This is what makes a delegated agent readable instead of a name.
const TRANSCRIPT_LIMIT = 240;
const OUTPUT_LINES = 6;

function clipLine(text, n = 400) {
  const s = String(text ?? "").replace(/\r/g, "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function childTranscript(sessionId, { dbPath, limit = TRANSCRIPT_LIMIT } = {}) {
  if (!sessionId || !dbPath || !existsSync(dbPath)) return null;
  const lines = [];
  let title = null;
  let running = false;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("select title, ended_at from sessions where id = ?").get(sessionId);
      if (!row) return null;
      title = String(row.title || "").replace(/^Subagent:\s*/i, "");
      running = row.ended_at == null;
      const msgs = db
        .prepare("select role, content, tool_calls from messages where session_id = ? order by id asc")
        .all(sessionId);
      for (const m of msgs) {
        const role = String(m.role || "");
        const content = typeof m.content === "string" ? m.content : "";
        if (role === "user") {
          // The child's first user message is the delegated task; later ones are steers or tool noise.
          lines.push({ kind: "prompt", text: clipLine(content) });
        } else if (role === "assistant") {
          if (content.trim()) lines.push({ kind: "text", text: clipLine(content) });
          if (m.tool_calls) {
            try {
              const calls = JSON.parse(m.tool_calls);
              for (const call of Array.isArray(calls) ? calls : []) {
                const fn = call && call.function;
                if (!fn || !fn.name) continue;
                let args = "";
                try {
                  const parsed = JSON.parse(fn.arguments || "{}");
                  const first = ["command", "path", "file_path", "pattern", "query", "url", "prompt", "goal"].find(
                    (k) => typeof parsed[k] === "string" && parsed[k],
                  );
                  if (first) args = ` · ${clipLine(parsed[first], 160)}`;
                } catch {
                  /* arguments the model wrote as plain text: the tool name is still worth a line */
                }
                lines.push({ kind: "tool", text: `${fn.name}${args}` });
              }
            } catch {
              /* not JSON: nothing to show for this call */
            }
          }
        } else if (role === "tool") {
          const body = content.split("\n").slice(0, OUTPUT_LINES).map((l) => l.slice(0, 300));
          for (const l of body) if (l.trim()) lines.push({ kind: "tool-out", text: `  ${l}` });
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`subagent transcript ${sessionId}: ${err?.message || err}`);
    return null;
  }
  return { session: sessionId, title, running, lines: lines.slice(-limit) };
}

// The message a parent should have got. Hermes joins a delegation and re-enters the parent with the results, but that
// only happens while the parent session is live: a one-shot run ends with its turn, and the children finish into a
// void. This builds the same thing from the store, so the panel can hand it to the parent as its next turn.
const RESULT_CHARS = 1200;

function lastAnswer(db, childId) {
  try {
    const rows = db
      .prepare(
        "select role, content from messages where session_id = ? and role = 'assistant' order by id desc limit 6",
      )
      .all(childId);
    for (const r of rows) {
      const text = String(r.content || "").trim();
      if (text) return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS - 1)}…` : text;
    }
  } catch {
    /* no readable transcript */
  }
  return "";
}

export function collectPrompt(thread, { dbPath, from = 0, to = 0 } = {}) {
  if (!thread || !dbPath || !existsSync(dbPath)) return null;
  const items = [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const since = Number.isFinite(from) && from > 0 ? from / 1000 : 0;
      const until = Number.isFinite(to) && to > 0 ? to / 1000 : Number.MAX_SAFE_INTEGER;
      const kids = db
        .prepare(
          `select id, title, started_at, ended_at, last_activity_at
             from sessions
            where source = 'subagent'
              and coalesce(parent_session_id, json_extract(model_config, '$._delegate_from')) = ?
              and started_at >= ? and started_at <= ?
            order by started_at asc
            limit 40`,
        )
        .all(thread, since, until);
      for (const k of kids) {
        const running = k.ended_at == null;
        const lastSeen = Number(k.last_activity_at || k.started_at) * 1000;
        const answer = lastAnswer(db, k.id);
        items.push({
          id: k.id,
          goal: String(k.title || "").replace(/^Subagent:\s*/i, "").replace(/\s+/g, " ").trim(),
          running,
          hung: running && Date.now() - lastSeen > HUNG_MS,
          silentFor: running ? Math.round((Date.now() - lastSeen) / 1000) : 0,
          durationSeconds: k.ended_at ? Math.round(Number(k.ended_at) - Number(k.started_at)) : null,
          result: answer,
        });
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`collect ${thread}: ${err?.message || err}`);
    return null;
  }
  if (!items.length) return { prompt: "", items };
  const lines = [
    `The ${items.length} subagent${items.length === 1 ? "" : "s"} you delegated ${items.length === 1 ? "has" : "have"} finished.`,
    "Aggregate their results into one answer, and say plainly if any of them produced nothing usable.",
    "",
  ];
  items.forEach((it, i) => {
    const state = it.running
      ? `STILL RUNNING${it.hung ? ` — no activity for ${Math.round(it.silentFor / 60)} min, possibly hung` : ""}`
      : it.durationSeconds != null
        ? `finished in ${it.durationSeconds}s`
        : "finished";
    lines.push(`${i + 1}. ${it.goal || "(no goal recorded)"}`);
    lines.push(`   status: ${state}`);
    lines.push(
      it.result
        ? `   result: ${it.result.replace(/\r?\n/g, "\n   ")}`
        : "   result: nothing — it recorded no answer",
    );
    lines.push("");
  });
  return { prompt: lines.join("\n").trim(), items };
}
