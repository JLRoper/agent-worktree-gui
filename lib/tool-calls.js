// The calls behind a collapsed "+ N commands" batch.
//
// The run stream carries the gateway's summary of a parallel batch - one line, "first command + 3 commands" - and
// nothing else: the other calls are not separate events. They are, however, in the session's own transcript, one
// `messages` row per assistant turn with a `tool_calls` array holding every call and its arguments. So the panel
// can answer "what were the other three" by reading them back, which is what this does.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const MAX_SUMMARY = 220;

function safeJson(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {
    return {};
  }
}

const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY);

// How the CLI would name a call in one line: a command for terminal, a path for file work, the question for a
// clarify, and so on. Unknown tools get their first argument rather than a wall of JSON.
export function summariseCall(name, rawArgs) {
  const a = safeJson(rawArgs);
  const tool = String(name || "tool");
  if (a.command) return `$ ${oneLine(a.command)}`;
  if (Array.isArray(a.commands)) return `$ ${oneLine(a.commands.join(" && "))}`;
  if (a.path) return `${tool}: ${oneLine(a.path)}`;
  if (a.url) return `${tool}: ${oneLine(a.url)}`;
  if (a.query) return `${tool}: ${oneLine(a.query)}`;
  if (a.prompt) return `${tool}: ${oneLine(a.prompt)}`;
  if (a.question) return `${tool}: ${oneLine(a.question)}`;
  const keys = Object.keys(a);
  if (!keys.length) return `${tool}: (no arguments)`;
  return `${tool}: ${oneLine(JSON.stringify(a))}`;
}

// The calls behind a batch: the newest assistant message that holds 2+ calls to `tool`, preferring one with exactly
// `want` calls - the summary line says how many ran ("+ 3 commands" is four calls), so the count is the best handle
// on which batch the reader is looking at. Oldest first, so they read in the order they ran.
export function recentToolCalls({ dbPath, sessionId, tool, limit = 8, want = 0, since = 0, first = "" } = {}) {
  if (!dbPath || !sessionId || !tool || !existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // `since` (epoch seconds) scopes the search to the turn whose console line the reader clicked. Without it the
    // newest batch in the whole session would answer for a burst that happened ten turns ago.
    const sql = since
      ? "select id, tool_calls from messages where session_id = ? and tool_calls is not null and timestamp >= ? order by id asc limit 120"
      : "select id, tool_calls from messages where session_id = ? and tool_calls is not null order by id desc limit 120";
    const rows = since ? db.prepare(sql).all(sessionId, since) : db.prepare(sql).all(sessionId).reverse();
    const batches = [];
    const flat = [];
    let lone = [];
    for (const r of rows) {
      let calls = [];
      try {
        calls = JSON.parse(r.tool_calls);
      } catch {
        continue;
      }
      const mine = (Array.isArray(calls) ? calls : [])
        .map((c) => c.function || c)
        .filter((fn) => fn && String(fn.name || "") === tool)
        .map((fn) => ({ name: fn.name, summary: summariseCall(fn.name, fn.arguments), msgId: r.id }));
      flat.push(...mine);
      if (mine.length > 1) batches.push(mine);
      else if (mine.length === 1 && !lone.length) lone = mine;
    }
    // The summary line names the call it printed ("cmd one + 3 commands"), so finding that call in the turn and
    // taking the ones that follow it lands on the exact batch - across message boundaries, which is where the
    // gateway's collapse can straddle two assistant messages.
    if (first) {
      const needle = String(first).trim().slice(0, 90);
      const at = flat.findIndex((c) => {
        const shown = String(c.summary).replace(/^\$ /, "");
        return shown.startsWith(needle) || shown.includes(needle);
      });
      if (at >= 0) {
        const count = Math.max(2, want || 2);
        return flat.slice(at, at + count);
      }
    }
    if (!batches.length) return lone;
    if (!want) return (batches.at(-1) || []).slice(-limit);
    const exact = batches.find((b) => b.length === want);
    if (exact) return exact.slice(-limit);
    // No exact count (the batch may have run more calls than the summary printed): the closest one.
    const best = batches.reduce((a, b) => (Math.abs(b.length - want) < Math.abs(a.length - want) ? b : a), batches[0]);
    return best.slice(-limit);
  } finally {
    db.close();
  }
}
