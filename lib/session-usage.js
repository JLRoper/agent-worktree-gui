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
//   tokens in/out  the session row's cumulative counters                 exact, and CUMULATIVE - see below
//   dollars     the store's own recorded cost per model, or the panel's cached per-million prices when the
//               store recorded none                                          measured, or ESTIMATED (see below)
//
// A figure with nothing behind it is omitted, never defaulted to 0: a 0% that was never measured reads
// as a measurement.
//
// WHY THE TOKEN COUNTS ARE THE SESSION'S OWN ROW AND NOT THE CONTEXT FIGURE. A compaction replaces the
// transcript with a summary, so context occupancy legitimately falls off a cliff mid-session — and a figure
// derived from it would read as "less spent", or reset outright. `sessions.input_tokens` / `output_tokens`
// are cumulative counters for the session (the agent adds every API call's share to them and never rewinds
// them for a compaction), so they keep rising across compaction and are re-read from the store after a panel
// restart. They are NOT how full the context is; that is the `context` figure above, and the two disagree on
// purpose. `_usage_anchor.prompt_tokens` is the per-call occupancy; `input_tokens` is every uncached prompt
// token this session has ever spent, with cache reads counted separately in `cache_read_tokens`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { formatRate, priceEntry, readPricingCache } from "./model-prices.js";

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

// The panel's own price cache (`model-prices.json`, beside the job store), read the same way and for the
// same reason as the catalog above: the readout prices a session the store recorded no cost for, it asks
// once per card per snapshot, and it may never wait on a network call. Keyed by path+mtime, so the Settings
// refresh (which rewrites the file) is picked up on the next read without a restart.
let priceCache = { path: null, mtimeMs: 0, cache: { providers: {} } };
export function modelPrices(pricingPath) {
  if (!pricingPath || !existsSync(pricingPath)) return { providers: {} };
  try {
    const st = statSync(pricingPath);
    if (priceCache.path !== pricingPath || priceCache.mtimeMs !== st.mtimeMs) {
      priceCache = { path: pricingPath, mtimeMs: st.mtimeMs, cache: readPricingCache(pricingPath) };
    }
    return priceCache.cache;
  } catch {
    return { providers: {} };
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
          "select input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, api_call_count, model, model_config, message_count, " +
            "billing_provider, estimated_cost_usd, actual_cost_usd, cost_status, cost_source from sessions where id = ?",
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
        // The same counters, split the way the gateway splits them: one row per model per task. Only the
        // session's OWN task ("") is used, because that is exactly the set of rows the session's counters are
        // made of — verified against this store, where sum(rows where task='') equals the session row's
        // input/output/cache_read counters for every one of the 203 sessions that have any, to the token.
        // The other tasks (background_review, compression, approval, title_generation) are real spend, but it
        // is spend the counters beside them do not include, so folding it into the dollar figure would make
        // the two disagree on the same line. Their recorded cost is carried separately (see `other_cost_usd`).
        let models = [];
        let otherCost = null;
        try {
          const rows = db
            .prepare(
              "select model, billing_provider, task, api_call_count, input_tokens, output_tokens, cache_read_tokens, " +
                "cache_write_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source " +
                "from session_model_usage where session_id = ? order by model, task",
            )
            .all(sessionId);
          for (const r of rows) {
            if (r.task === "") {
              models.push({
                model: r.model || null,
                provider: r.billing_provider || null,
                api_call_count: num(r.api_call_count),
                input_tokens: num(r.input_tokens),
                output_tokens: num(r.output_tokens),
                cache_read_tokens: num(r.cache_read_tokens),
                cache_write_tokens: num(r.cache_write_tokens),
                estimated_cost_usd: num(r.estimated_cost_usd),
                actual_cost_usd: num(r.actual_cost_usd),
                cost_status: r.cost_status || null,
                cost_source: r.cost_source || null,
              });
              continue;
            }
            const recorded = recordedCost(r);
            if (recorded) otherCost = Math.round(((otherCost || 0) + recorded.usd) * 1e9) / 1e9;
          }
        } catch {
          /* a store without the per-model table: the readout still has the session's own counters */
        }
        row = {
          input_tokens: num(s.input_tokens),
          output_tokens: num(s.output_tokens),
          cache_read_tokens: num(s.cache_read_tokens),
          cache_write_tokens: num(s.cache_write_tokens),
          api_call_count: num(s.api_call_count),
          message_count: num(s.message_count),
          model: s.model || null,
          billing_provider: s.billing_provider || null,
          anchor_prompt_tokens: num(anchor),
          compactions: num(compactions),
          // What the store itself says this session cost. Kept whole (not folded into a number) so the
          // readout can say whose figure it is showing and on what the model was billed.
          cost: {
            estimated_cost_usd: num(s.estimated_cost_usd),
            actual_cost_usd: num(s.actual_cost_usd),
            cost_status: s.cost_status || null,
            cost_source: s.cost_source || null,
          },
          models,
          other_cost_usd: otherCost,
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

// ---- what the session has cost ---------------------------------------------------------------
// Two prices exist for a session and they are not interchangeable:
//
//   the store's own   `estimated_cost_usd` / `actual_cost_usd` with `cost_status` and `cost_source`, written
//                     per session AND per session+model+task row. What the provider's billing model says,
//                     which is the only figure that knows about cache-read rates and any discount.
//   the panel's copy  "$x.xx" per Mtok in and out, from the model inventory the Settings refresh caches.
//                     A fallback, and an estimate: it has no cache-read rate at all.
//
// So the recorded figure wins wherever it exists, and the arithmetic is only used where it does not. Which one
// is on screen is never left to the reader to guess: `basis` names it and `note` spells it out for the tooltip.
//
// `measured` distinguishes a figure that is not an estimate (billed, or a real recorded price) from one that
// is, because the readout prints `~` in front of the second kind and nothing in front of the first.
function centsRounded(v) {
  return Math.round(v * 1e6) / 1e6; // a millionth of a dollar: enough to keep 7.5802M × $0.02/M exact
}

function recordedCost(r) {
  if (!r) return null;
  const actual = num(r.actual_cost_usd);
  const estimated = num(r.estimated_cost_usd);
  const status = String(r.cost_status || "").trim().toLowerCase();
  if (actual !== null && actual > 0) {
    return { usd: actual, measured: true, kind: "record", status: status || "actual", source: r.cost_source || null };
  }
  if (estimated !== null && estimated > 0) {
    return { usd: estimated, measured: false, kind: "record", status: status || "estimated", source: r.cost_source || null };
  }
  // A recorded ZERO is a price only when the gateway says it priced the row — a model that is genuinely free.
  // cost_status "unknown" is the gateway saying it could not price it, and the row must then fall through to
  // the panel's copy rather than claim the session cost nothing.
  if (estimated === 0 && (status === "estimated" || status === "actual")) {
    return { usd: 0, measured: status === "actual", kind: "record", status, source: r.cost_source || null };
  }
  return null;
}

// The arithmetic half: counts × the panel's cached per-million prices. The copy the panel keeps has an input
// and an output rate and nothing else, so cache-read (and cache-write) tokens are priced at the INPUT rate —
// which overstates a session that reads a lot from the cache, and is exactly why the figure is marked as an
// estimate and why the note says so. A side whose tokens are non-zero but has no price makes the whole
// figure null rather than a partial sum: half a bill presented as the bill is worse than no bill.
function panelCost(counts, price) {
  if (!price) return null;
  const input = counts.input_tokens || 0;
  const cacheRead = counts.cache_read_tokens || 0;
  const cacheWrite = counts.cache_write_tokens || 0;
  const output = counts.output_tokens || 0;
  if ((input || cacheRead || cacheWrite) && price.input === null) return null;
  if (output && price.output === null) return null;
  if (!input && !cacheRead && !cacheWrite && !output) return null;
  const inUsd = ((input + cacheRead + cacheWrite) * price.input) / 1e6;
  const outUsd = (output * price.output) / 1e6;
  return {
    usd: centsRounded(inUsd + outUsd),
    measured: false,
    kind: "panel",
    cache_read_at_input: cacheRead > 0 || cacheWrite > 0,
    input_usd: centsRounded(inUsd),
    output_usd: centsRounded(outUsd),
    price,
  };
}

function tokensOf(r) {
  return (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
}

const modelList = (names) => [...new Set(names.filter(Boolean))].join(", ");

// How the tooltip describes a figure computed from the panel's copy: the rates it used, and the one guess it
// had to make (cache reads have no rate of their own in that copy).
function priceNote(what, price, cacheReadAtInput) {
  return (
    `${what} (${formatRate(price.input)} in / ${formatRate(price.output)} out per Mtok` +
    `${cacheReadAtInput ? ", cache reads priced as input" : ""})`
  );
}

// What this session has cost, and whose figure it is. Pure: the caller hands it the session's row as read
// above plus the panel's parsed price cache, so the arithmetic can be checked without a store.
//
// Order, and why:
//   1. one row per model for the session's own turns — the counters the card prints ARE these rows summed,
//      so the dollars and the counts are two readings of one thing, and a session that changed models
//      mid-way is priced by each model's own recorded cost (or, failing that, its own price) instead of
//      being approximated at whatever model it happens to be on now.
//   2. the session row's own recorded cost, when some model row had no record to use.
//   3. the panel's cached prices over the session's counters, when the store recorded nothing anywhere.
// Nothing priced at all -> `usd: null` and a note saying which model, so the readout prints the counts and no
// dollar figure rather than a zero.
export function sessionCost(s, pricing) {
  if (!s) return null;
  const rows = (s.models || []).filter((r) => tokensOf(r) > 0);
  const unpriced = [];
  if (rows.length) {
    const parts = rows.map((r) => ({ model: r.model, cost: recordedCost(r) || panelCost(r, priceEntry(pricing, r.model, r.provider)) }));
    for (const p of parts) if (!p.cost) unpriced.push(p.model);
    if (!unpriced.length) {
      const usd = centsRounded(parts.reduce((n, p) => n + p.cost.usd, 0));
      const multi = new Set(rows.map((r) => r.model)).size > 1;
      const fromPanel = parts.filter((p) => p.cost.kind === "panel");
      const estimatedParts = parts.filter((p) => p.cost.kind === "record" && !p.cost.measured);
      const billedParts = parts.filter((p) => p.cost.kind === "record" && p.cost.measured);
      const measured = parts.every((p) => p.cost.measured);
      const bits = [];
      if (fromPanel.length) {
        bits.push(priceNote(`the panel's cached prices for ${modelList(fromPanel.map((p) => p.model))}`, fromPanel[0].cost.price, fromPanel[0].cost.cache_read_at_input));
      }
      if (billedParts.length) {
        const sources = modelList(billedParts.map((p) => p.cost.source));
        bits.push(`what was actually billed for ${modelList(billedParts.map((p) => p.model))}${sources ? ` (${sources})` : ""}`);
      }
      if (estimatedParts.length) {
        const sources = modelList(estimatedParts.map((p) => p.cost.source));
        bits.push(`the gateway's own recorded estimate${sources ? ` (${sources})` : ""}`);
      }
      return {
        usd,
        measured,
        basis: fromPanel.length && !estimatedParts.length && !billedParts.length ? "panel-models" : multi ? "per-model" : "record",
        models: rows.length,
        note: (multi ? `each of this session's ${rows.length} models priced on its own — ` : "") + (bits.length ? bits.join(" and ") : "this session's model-by-model record"),
        multi,
      };
    }
  }
  const rec = recordedCost(s.cost);
  if (rec) {
    return {
      usd: rec.usd,
      measured: rec.measured,
      basis: "record",
      models: rows.length,
      note:
        (rec.status === "actual" ? "what was actually billed for this session" : "the gateway's own recorded estimate for this session") +
        `${rec.source ? ` (${rec.source})` : ""}`,
      multi: false,
    };
  }
  if (!rows.length) {
    const price = priceEntry(pricing, s.model, s.billing_provider);
    const cost = panelCost(s, price);
    if (cost) {
      return {
        usd: cost.usd,
        measured: false,
        basis: "panel",
        models: 0,
        note:
          priceNote(`the panel's cached price for ${modelList([s.model])}`, price, cost.cache_read_at_input),
        multi: false,
      };
    }
  }
  return {
    usd: null,
    measured: false,
    basis: "none",
    models: rows.length,
    multi: new Set(rows.map((r) => r.model)).size > 1,
    note: unpriced.length
      ? `no dollar figure: ${modelList(unpriced)} ${unpriced.length === 1 ? "has" : "have"} no price in the panel's copy — Settings → Gateway → Models & prices rebuilds it`
      : `no dollar figure: the store recorded no cost for this session and ${modelList([s.model]) || "its model"} has no price in the panel's copy`,
  };
}

// The strip's fields. `turn` is the run's own usage ({output}) and `seconds` its wall clock, because
// throughput is a property of THIS turn while cache and context are properties of the session.
export function usageStats(sessionId, { turn, seconds, toolSeconds = 0, dbPath, catalogPath, pricingPath = null, maxAgeMs = 3000 } = {}) {
  const s = sessionUsage(sessionId, { dbPath, catalogPath, maxAgeMs });
  if (!s) return null;
  const out = {};
  const prompt = (s.input_tokens || 0) + (s.cache_read_tokens || 0) + (s.cache_write_tokens || 0);
  if (prompt > 0 && (s.cache_read_tokens || 0) > 0) {
    out.cache_hit_pct = Math.round(Math.min(100, ((s.cache_read_tokens || 0) / prompt) * 100) * 10) / 10;
  }
  const used = s.anchor_prompt_tokens || (prompt > 0 ? prompt : null);
  if (s.compactions !== null) out.compressions = s.compactions;
  // What this session has spent, in tokens and in dollars. Both are cumulative for the session (the store's
  // own counters, summed from the session's per-model rows), which is the whole point: the context figure
  // beside them falls when the transcript is compacted, and these two must not. They live in the job summary
  // the server builds, so they also come back the same after a panel restart — the page holds nothing but
  // what the server last read out of the store.
  if (s.input_tokens !== null || s.output_tokens !== null) {
    out.input_tokens = s.input_tokens || 0;
    out.output_tokens = s.output_tokens || 0;
    if (s.cache_read_tokens) out.cache_read_tokens = s.cache_read_tokens;
    if (s.cache_write_tokens) out.cache_write_tokens = s.cache_write_tokens;
  }
  const cost = sessionCost(s, modelPrices(pricingPath));
  if (cost) {
    out.cost_usd = cost.usd; // null = nothing could price it: the readout then prints no figure at all
    out.cost_estimated = !cost.measured; // the `~` on the readout, and the only difference between the two
    out.cost_basis = cost.basis; // 'per-model' | 'record' | 'panel' | 'panel-models' | 'none'
    out.cost_note = cost.note; // the tooltip's sentence: which figure the reader is looking at
    out.cost_models = cost.models;
    if (cost.multi) out.cost_multi = true;
    // Spend the session's own counters do not include (background review, compaction, approvals), recorded
    // by the store and reported separately so the dollars never silently disagree with the counts above.
    if (s.other_cost_usd) out.cost_other_usd = s.other_cost_usd;
  }
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
  priceCache = { path: null, mtimeMs: 0, cache: { providers: {} } };
}
