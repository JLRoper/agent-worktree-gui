// What the fleet's token spend actually did, read from Hermes' own agent.log.
//
// WHY: the daily question — "why did the bill land where it landed" — has three answers the log already
// carries, per call. In this install on 2026-11-09: 2,264 calls, 350.9M input tokens, 94.5% served from
// the prompt cache — but ~16% of calls ran under 95% and a hundred were near-cold reads of 100-500k
// contexts. The cost is calls x context; the cache rate is what turns 350M tokens into ~$25 instead of
// five times that; and the cache is per-UPSTREAM while OpenRouter routes one model across a dozen
// upstreams (Wafer, Relace, Together, DeepInfra, ...), so a routing switch is what a near-cold read
// almost always is. This module turns the log into that picture — per day: calls, fresh vs cached input,
// the cache-bucket spread, the upstream distribution with each upstream's cold reads, the top sessions by
// input, and every compression fold (its aux prompt and reclaimed tokens) — so any later change (a pinned
// upstream, a lower fold threshold) has a before and an after that are the same measurement.
//
// One line per call, as `agent.conversation_loop` writes it:
//   2026-11-09 07:06:13,385 INFO [session] agent.conversation_loop: API call #4: model=... in=431144
//   out=1985 total=433129 latency=15.2s cache=429039/431144 (100%) id=gen-... upstream=OpenInference
// `upstream=` arrived after `cache=` did; an absent one parses as unknown, never as a guess.

const CALL_MARK = "agent.conversation_loop: API call #";
const FOLD_MARK = "context compression attempt telemetry: ";

// A call's own numbers, or null for any line that is not one. Field-by-field regexes rather than one
// master pattern on purpose: the log's tail (id=..., upstream=...) is provider-shaped and grew over time,
// and a parser that hard-codes today's tail stops reading tomorrow's lines entirely.
function parseCall(line) {
  if (!line.includes(CALL_MARK)) return null;
  const ts = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):/.exec(line);
  const sess = /\[([^\]]+)\] agent\.conversation_loop/.exec(line);
  const tok = /in=(\d+) out=(\d+) total=(\d+)/.exec(line);
  const cache = /cache=(\d+)\/(\d+)/.exec(line);
  if (!ts || !tok || !cache) return null;
  const up = /upstream=(\S+)/.exec(line);
  return {
    day: ts[1],
    hourMinute: `${ts[1]} ${ts[2]}`,
    session: sess ? sess[1] : "(unknown)",
    inTokens: Number(tok[1]),
    outTokens: Number(tok[2]),
    cachedTokens: Number(cache[1]),
    upstream: up ? up[1] : "(unknown)",
  };
}

function parseFold(line) {
  const at = line.indexOf(FOLD_MARK);
  if (at < 0) return null;
  const ts = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):/.exec(line);
  try {
    const j = JSON.parse(line.slice(at + FOLD_MARK.length));
    return {
      day: ts ? ts[1] : "(unknown)",
      hourMinute: ts ? `${ts[1]} ${ts[2]}` : "(unknown)",
      session: String(j.session_id || "(unknown)"),
      auxPromptTokens: Number(j.aux_prompt_tokens) || 0,
      auxMs: Number(j.aux_call_duration_ms) || 0,
      tokensBefore: Number(j.tokens_before) || 0,
      tokensAfter: Number(j.tokens_after) || 0,
      reclaimed: Number(j.tokens_reclaimed) || 0,
    };
  } catch {
    return null; // a half-written tail is not a fold
  }
}

// Every call and fold the text carries, in file order. Pure: no IO, no clock.
export function parseAgentLog(text) {
  const calls = [];
  const folds = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.includes(CALL_MARK)) {
      const c = parseCall(line);
      if (c) calls.push(c);
      continue;
    }
    if (line.includes(FOLD_MARK)) {
      const f = parseFold(line);
      if (f) folds.push(f);
    }
  }
  return { calls, folds };
}

const bucketOf = (ratio) => (ratio >= 0.99 ? ">=99" : ratio >= 0.95 ? "95-99" : ratio >= 0.9 ? "90-95" : ratio >= 0.5 ? "50-90" : "<50");
export const BUCKETS = [">=99", "95-99", "90-95", "50-90", "<50"];

// The report a reader (or a later comparison) wants, from parsed records.
//   days      per-day totals, newest first
//   buckets   call counts by cache-hit ratio, over every parsed call (or a day when `day` is set)
//   upstreams per upstream: calls, input, cached, and the cold reads it carried (<50% hit)
//   top       the biggest sessions by input, over the same window
//   folds     compression folds in the window, with aux prompt tokens and reclaimed context
export function summarize(records, { days = 2, topSessions = 10 } = {}) {
  const calls = records.calls || [];
  const folds = records.folds || [];
  const dayList = [...new Set(calls.map((c) => c.day))].sort().reverse().slice(0, days);
  const inWindow = (d) => dayList.includes(d);
  const window = calls.filter((c) => inWindow(c.day));

  const perDay = dayList.map((day) => {
    const dayCalls = calls.filter((c) => c.day === day);
    const sum = (fn) => dayCalls.reduce((n, c) => n + fn(c), 0);
    const fresh = sum((c) => c.inTokens - c.cachedTokens);
    return {
      day,
      calls: dayCalls.length,
      inTokens: sum((c) => c.inTokens),
      outTokens: sum((c) => c.outTokens),
      cachedTokens: sum((c) => c.cachedTokens),
      freshTokens: fresh,
      freshShare: sum((c) => c.inTokens) ? fresh / sum((c) => c.inTokens) : 0,
    };
  });

  const buckets = {};
  for (const b of BUCKETS) buckets[b] = { calls: 0, inTokens: 0 };
  for (const c of window) {
    const b = buckets[bucketOf(c.inTokens ? c.cachedTokens / c.inTokens : 0)];
    b.calls += 1;
    b.inTokens += c.inTokens;
  }

  const upstreams = {};
  for (const c of window) {
    const u = (upstreams[c.upstream] ||= { calls: 0, inTokens: 0, cachedTokens: 0, coldCalls: 0, coldInTokens: 0 });
    u.calls += 1;
    u.inTokens += c.inTokens;
    u.cachedTokens += c.cachedTokens;
    if (c.inTokens && c.cachedTokens / c.inTokens < 0.5) {
      u.coldCalls += 1;
      u.coldInTokens += c.inTokens;
    }
  }

  const sessions = {};
  for (const c of window) {
    const s = (sessions[c.session] ||= { calls: 0, inTokens: 0, outTokens: 0, cachedTokens: 0 });
    s.calls += 1;
    s.inTokens += c.inTokens;
    s.outTokens += c.outTokens;
    s.cachedTokens += c.cachedTokens;
  }
  const top = Object.entries(sessions)
    .sort((a, b) => b[1].inTokens - a[1].inTokens)
    .slice(0, topSessions)
    .map(([session, s]) => ({ session, ...s }));

  const foldsInWindow = folds.filter((f) => inWindow(f.day));
  return {
    days: dayList,
    perDay,
    buckets,
    upstreams,
    top,
    folds: foldsInWindow,
    foldTotals: {
      count: foldsInWindow.length,
      auxPromptTokens: foldsInWindow.reduce((n, f) => n + f.auxPromptTokens, 0),
      reclaimed: foldsInWindow.reduce((n, f) => n + f.reclaimed, 0),
    },
  };
}

const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (x) => `${Math.round(100 * x)}%`;

// The human report, as plain lines. Kept here rather than in the CLI so the test drives the same text a
// reader sees.
export function formatReport(report) {
  const out = [];
  out.push(`days: ${report.days.join(", ") || "(none)"}`);
  for (const d of report.perDay) {
    out.push(`  ${d.day}  calls=${fmt(d.calls)}  in=${fmt(d.inTokens)}  fresh=${fmt(d.freshTokens)} (${pct(d.freshShare)})  out=${fmt(d.outTokens)}`);
  }
  out.push("cache buckets (window):");
  for (const b of BUCKETS) {
    const v = report.buckets[b];
    out.push(`  ${b.padEnd(6)} calls=${fmt(v.calls)}  in=${fmt(v.inTokens)}`);
  }
  out.push("upstreams (window):");
  for (const [name, u] of Object.entries(report.upstreams).sort((a, b) => b[1].calls - a[1].calls)) {
    out.push(`  ${name.padEnd(16)} calls=${fmt(u.calls)}  in=${fmt(u.inTokens)}  cached=${fmt(u.cachedTokens)}  cold=${fmt(u.coldCalls)} calls / ${fmt(u.coldInTokens)} in`);
  }
  out.push("top sessions by input (window):");
  for (const s of report.top) {
    out.push(`  ${s.session.slice(0, 46).padEnd(46)} calls=${fmt(s.calls)}  in=${fmt(s.inTokens)}  out=${fmt(s.outTokens)}`);
  }
  out.push(`compression folds (window): ${fmt(report.foldTotals.count)} — auxPrompt=${fmt(report.foldTotals.auxPromptTokens)} reclaimed=${fmt(report.foldTotals.reclaimed)}`);
  for (const f of report.folds) {
    out.push(`  ${f.hourMinute}  ${f.session.slice(0, 40).padEnd(40)} aux=${fmt(f.auxPromptTokens)} reclaimed=${fmt(f.reclaimed)} (${fmt(f.tokensBefore)} → ${fmt(f.tokensAfter)})`);
  }
  return out.join("\n");
}
