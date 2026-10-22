// Prove the run.usage path through the panel's own registry class (no server, no browser):
// a live snapshot arrives at a tool boundary, then the terminal run.completed usage merges in.
import { Jobs } from "../lib/jobs.js";

const events = [];
const reg = new Jobs({ jobsFile: null, onEvent: (e) => events.push(e.type) });
const j = {
  id: "stats1", thread: "stats-thread", turn: 1, status: "running", runId: "run_probe",
  lines: [], tokens: null, stats: null, startedAt: new Date().toISOString(), approval: null,
};
reg.jobs.set(j.id, j);

// 1) mid-turn snapshot (gateway pushes this after each tool.completed)
reg.consume(j, {
  event: "run.usage",
  usage: { context_used: 357000, context_max: 1000000, context_percent: 36, context_estimated: true,
           cache_hit_pct: 99.0, avg_latency_s: 4.2, avg_tps: 231 },
});
const live = reg.summary(j).stats;

// 2) terminal usage: token counters + the same stats, plus a field the live event omitted
reg.settle(j, "completed", {
  usage: { total_tokens: 132400, input_tokens: 120000, output_tokens: 12400, cache_read_tokens: 118800,
           context_used: 358000, context_max: 1000000, context_percent: 36, context_estimated: false,
           cache_hit_pct: 99.2, avg_latency_s: 4.3, avg_tps: 240 },
});
const done = reg.summary(j);

// 3) a usage payload with nothing numeric must not invent zeros
const empty = reg.summary({
  ...j, stats: null, lines: [], thread: "empty-thread",
});
reg.consume(j, { event: "run.usage", usage: { input_tokens: 0 } });

const out = {
  live,
  done: { stats: done.stats, tokens: done.tokens, status: done.status },
  // what the card must NOT render: no stats object at all
  noStatsInvents: empty.stats,
  emitted: events.filter((t) => t === "job").length,
  // a second, non-numeric payload leaves the last real reading alone
  afterJunk: reg.summary(j).stats,
};
console.log(JSON.stringify(out, null, 2));
const ok = live?.context_used === 357000 && live.avg_tps === 231 &&
  done.stats.context_percent === 36 && done.stats.cache_hit_pct === 99.2 && done.tokens.total === 132400 &&
  empty.stats === null && out.afterJunk.avg_tps === 240;
console.log(ok ? "VERIFY-STATS-OK" : "VERIFY-STATS-FAILED");
process.exit(ok ? 0 : 1);
