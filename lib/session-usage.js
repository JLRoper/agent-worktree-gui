// The card's readout, read from the store instead of from the run stream.
//
// The gateway only publishes a `run.usage` event from the path where it owns an agent object; on this
// box runs execute through the durable-admission path, which has no agent, so those events never
// arrive and the strip stayed empty. The numbers are written anyway — the agent records them on its
// session row — so they are read back here:
//
//   cache hit   cache_read_tokens / (input + cache_read + cache_write)   exact, the CLI's formula
//   context     _usage_anchor.prompt_tokens of the LAST api call         exact
//   context max context_length for the model from the OpenRouter catalog  exact, when the model is there
//   compactions a message flagged _compressed_summary=1 IS a compaction summary       exact
//               (messages.compacted is a different thing: it marks absorbed MESSAGES, 927 in one session
//               here, so it is never used for this figure)
//   t/s         the turn's output tokens over its generation time        ESTIMATED (see below)
//
// A figure with nothing behind it is omitted, never defaulted to 0: a 0% that was never measured reads
// as a measurement.
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Two small caches: the catalog is a 1.4k-entry JSON, and a snapshot asks for every card at once.
let catalog = { path: null, mtimeMs: 0, byModel: new Map() };
let rowCache = new Map(); // sessionId -> { at, row }

export function modelContextLength(model, catalogPath) {
  if (!model || !catalogPath || !existsSync(catalogPath)) return null;
  try {
    const st = statSync(catalogPath);
    if (catalog.path !== catalogPath || catalog.mtimeMs !== st.mtimeMs) {
      const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
      const byModel = new Map();
      for (const [id, meta] of Object.entries(raw || {})) {
        const len = meta && meta.context_length;
        if (typeof len === "number" && len > 0) byModel.set(id.toLowerCase(), len);
      }
      catalog = { path: catalogPath, mtimeMs: st.mtimeMs, byModel };
    }
    const key = String(model).toLowerCase();
    return catalog.byModel.get(key) ?? catalog.byModel.get(key.replace(/^[^/]+\//, "")) ?? null;
  } catch {
    return null;
  }
}

// id -> { title, at } for every session. `title` is the name Hermes gave it (auto-named from the first
// prompt, or set with /title); `at` is when it was last used, in ms - `last_activity_at` is null for one-shot
// `hermes chat -q` sessions on this build, so it falls back to the newest message. Read in one query and
// cached, because a job summary asks for it on every event.
let indexCache = { at: 0, byId: new Map() };
export function sessionIndex({ dbPath, maxAgeMs = 60_000 } = {}) {
  if (!dbPath || !existsSync(dbPath)) return new Map();
  if (indexCache.byId.size && Date.now() - indexCache.at < maxAgeMs) return indexCache.byId;
  const byId = new Map();
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const sql =
        "select s.id, s.title, coalesce(s.last_activity_at, " +
        "(select max(m.timestamp) from messages m where m.session_id = s.id)) as at from sessions s";
      for (const r of db.prepare(sql).all()) {
        const at = Number(r.at) * 1000;
        byId.set(r.id, { title: r.title || null, at: Number.isFinite(at) && at > 0 ? at : null });
      }
    } finally {
      db.close();
    }
  } catch {
    return indexCache.byId;
  }
  indexCache = { at: Date.now(), byId };
  return byId;
}

// One session's usage, straight from the store. Returns null when the session is not there (a card
// rebuilt from a run the panel watched but whose session row the gateway has since rolled away).
export function sessionUsage(sessionId, { dbPath, catalogPath, maxAgeMs = 3000, now = Date.now() } = {}) {
  if (!sessionId || !dbPath || !existsSync(dbPath)) return null;
  const hit = rowCache.get(sessionId);
  if (hit && now - hit.at < maxAgeMs) return hit.row;
  let row = null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const s = db
        .prepare(
          "select input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, api_call_count, model, model_config, message_count from sessions where id = ?",
        )
        .get(sessionId);
      if (s) {
        let anchor = null;
        try {
          anchor = JSON.parse(s.model_config || "{}")?._usage_anchor?.prompt_tokens ?? null;
        } catch {
          /* a model_config the gateway wrote in another shape: fall back to the counters */
        }
        let compactions = null;
        try {
          // Each compaction writes exactly one summary message and flags it. Counting flagged messages
          // counts events; counting messages.compacted would count what those events absorbed.
          compactions = db
            .prepare("select count(*) as n from messages where session_id = ? and _compressed_summary = 1")
            .get(sessionId)?.n ?? 0;
        } catch {
          /* older store without the column: the figure is omitted, not guessed */
        }
        row = {
          input_tokens: num(s.input_tokens),
          output_tokens: num(s.output_tokens),
          cache_read_tokens: num(s.cache_read_tokens),
          cache_write_tokens: num(s.cache_write_tokens),
          api_call_count: num(s.api_call_count),
          message_count: num(s.message_count),
          model: s.model || null,
          anchor_prompt_tokens: num(anchor),
          compactions: num(compactions),
        };
      }
    } finally {
      db.close();
    }
  } catch {
    row = null;
  }
  // A miss is cached briefly, not for the full window: the row is written while a turn is still going,
  // and a miss remembered for three seconds blanked the strip on a card that had numbers a moment later.
  rowCache.set(sessionId, { at: row ? now : now - maxAgeMs + 400, row });
  return row;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

// The strip's fields. `turn` is the run's own usage ({output}) and `seconds` its wall clock, because
// throughput is a property of THIS turn while cache and context are properties of the session.
export function usageStats(sessionId, { turn, seconds, toolSeconds = 0, dbPath, catalogPath, maxAgeMs = 3000 } = {}) {
  const s = sessionUsage(sessionId, { dbPath, catalogPath, maxAgeMs });
  if (!s) return null;
  const out = {};
  const prompt = (s.input_tokens || 0) + (s.cache_read_tokens || 0) + (s.cache_write_tokens || 0);
  if (prompt > 0 && (s.cache_read_tokens || 0) > 0) {
    out.cache_hit_pct = Math.round(Math.min(100, ((s.cache_read_tokens || 0) / prompt) * 100) * 10) / 10;
  }
  const used = s.anchor_prompt_tokens || (prompt > 0 ? prompt : null);
  if (s.compactions !== null) out.compressions = s.compactions;
  if (used) {
    out.context_used = used;
    const max = modelContextLength(s.model, catalogPath);
    if (max) {
      out.context_max = max;
      out.context_percent = Math.round((used / max) * 1000) / 10;
    }
  }
  // Throughput and latency are the one pair the store does not record: there is no per-call duration
  // in it. They are computed over the turn's wall clock minus the time its tools were running, and
  // flagged so the card can say they are an estimate rather than a measurement.
  const output = num(turn && turn.output);
  const wall = num(seconds);
  if (output !== null && wall !== null && wall > 0) {
    const generating = Math.max(0.2, wall - Math.max(0, num(toolSeconds) || 0));
    if (output > 0) {
      out.avg_tps = Math.round((output / generating) * 10) / 10;
      out.tps_estimated = true;
    }
    if (s.api_call_count) {
      out.avg_latency_s = Math.round((generating / s.api_call_count) * 10) / 10;
      out.latency_estimated = true;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Tool time from the console lines: the only record of how long the model was NOT generating.
//
// Three shapes have to be handled, because none of them is complete on its own:
//   "  ↳ terminal · 1.40s"   a printed duration (older streams)
//   kind "tool" / "tool-out" a start and an end with timestamps but no duration
//   kind "tool" with no end  a tool still running
//
// A running tool used to count as generation time: a turn parked in `sleep 120` looked like a model
// that had been thinking for two minutes, throughput decayed toward 1 t/s and latency climbed past a
// minute. And once it finished, its time vanished instead, so the settled card disagreed with the live
// one. Both are handled here: completed tools count end-minus-start, the in-flight one counts to `now`.
export function toolSecondsFromLines(lines, { now = Date.now() } = {}) {
  let total = 0;
  const starts = [];
  for (const l of lines || []) {
    const text = String(l && l.text ? l.text : "");
    const printed = /↳\s+\S+\s+·\s+([\d.]+)s/.exec(text);
    if (l && l.kind === "tool") {
      starts.push(Number(l.at) || 0);
      continue;
    }
    if (l && l.kind === "tool-out") {
      const begin = starts.shift() || 0;
      if (printed) total += Number(printed[1]) || 0;
      else if (begin) total += Math.max(0, ((Number(l.at) || begin) - begin) / 1000);
      continue;
    }
    // A duration printed on a line that is not a tool-out: the stream's own measurement, take it as-is.
    if (printed && !(l && l.kind === "tool")) total += Number(printed[1]) || 0;
  }
  for (const begin of starts) if (begin) total += Math.max(0, (now - begin) / 1000);
  return total;
}

export function clearUsageCache() {
  rowCache = new Map();
  catalog = { path: null, mtimeMs: 0, byModel: new Map() };
}
