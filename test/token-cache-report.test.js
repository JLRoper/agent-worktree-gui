// The token-cache report's parser and arithmetic, driven on a log a fixture wrote — every number the tool
// prints is recomputed here by hand so a changed line format fails loudly instead of quietly reading zero.
import assert from "node:assert/strict";
import test from "node:test";
import { BUCKETS, formatReport, parseAgentLog, summarize } from "../lib/token-cache-report.js";

// Two days of calls: one 99% hit, one near-cold on another upstream, one 100% on the first upstream, and
// one previous-day call that only a 2-day window may count. One fold, with its own telemetry JSON.
const FIXTURE = [
  "2026-11-09 07:06:13,385 INFO [sess-a] agent.conversation_loop: API call #4: model=deepseek/deepseek-v4.1-flash-1017 provider=openrouter in=100000 out=100 total=100100 latency=5.0s cache=99000/100000 (99%) id=gen-aaa upstream=Wafer",
  "2026-11-09 07:45:00,000 INFO [sess-a] agent.conversation_loop: API call #5: model=deepseek/deepseek-v4.1-flash-1017 provider=openrouter in=200000 out=50 total=200050 latency=6.0s cache=10000/200000 (5%) id=gen-bbb upstream=Relace",
  "2026-11-09 08:00:00,000 INFO [sess-b] agent.conversation_loop: API call #1: model=deepseek/deepseek-v4.1-flash-1017 provider=openrouter in=50000 out=200 total=50200 latency=2.0s cache=50000/50000 (100%) id=gen-ccc upstream=Wafer",
  "2026-11-08 23:00:00,000 INFO [sess-c] agent.conversation_loop: API call #1: model=deepseek/deepseek-v4.1-flash-1017 provider=openrouter in=10000 out=10 total=10010 latency=1.0s cache=0/10000 (0%) id=gen-ddd upstream=DeepInfra",
  '2026-11-09 08:53:25,765 INFO agent.conversation_compression: context compression attempt telemetry: {"session_id":"sess-a","aux_prompt_tokens":62904,"aux_call_duration_ms":190164,"tokens_before":482145,"tokens_after":59803,"tokens_reclaimed":422342}',
  "2026-11-09 08:53:25,765 INFO agent.conversation_compression: context compression attempt telemetry: {broken",
].join("\n");

test("the parser reads every call and only complete folds", () => {
  const r = parseAgentLog(FIXTURE);
  assert.equal(r.calls.length, 4, "four call lines");
  assert.equal(r.folds.length, 1, "the half-written fold line is not a fold");
  assert.equal(r.calls[0].session, "sess-a");
  assert.equal(r.calls[0].upstream, "Wafer");
  assert.equal(r.calls[3].day, "2026-11-08");
  assert.equal(r.folds[0].reclaimed, 422342);
});

test("one day's window: totals, buckets, upstream cold attribution, top sessions", () => {
  const report = summarize(parseAgentLog(FIXTURE), { days: 1 });
  assert.deepEqual(report.days, ["2026-11-09"], "newest day only");
  const d = report.perDay[0];
  assert.equal(d.calls, 3);
  assert.equal(d.inTokens, 350000);
  assert.equal(d.cachedTokens, 159000);
  assert.equal(d.freshTokens, 191000, "fresh = input - cached");
  assert.equal(d.outTokens, 350);

  assert.deepEqual(Object.keys(report.buckets), BUCKETS);
  assert.equal(report.buckets[">=99"].calls, 2, "99% and 100% both land in the top bucket");
  assert.equal(report.buckets[">=99"].inTokens, 150000);
  assert.equal(report.buckets["<50"].calls, 1);
  assert.equal(report.buckets["<50"].inTokens, 200000, "the near-cold read carries its full input");

  assert.equal(report.upstreams.Wafer.calls, 2);
  assert.equal(report.upstreams.Wafer.coldCalls, 0);
  assert.equal(report.upstreams.Relace.coldCalls, 1, "the 5% call is Relace's cold read");
  assert.equal(report.upstreams.Relace.coldInTokens, 200000);
  assert.equal(report.upstreams.DeepInfra, undefined, "the previous-day upstream is out of a 1-day window");

  assert.equal(report.top[0].session, "sess-a");
  assert.equal(report.top[0].inTokens, 300000);

  assert.equal(report.foldTotals.count, 1);
  assert.equal(report.foldTotals.auxPromptTokens, 62904);
  assert.equal(report.foldTotals.reclaimed, 422342);
});

test("a two-day window counts the older day's call and its upstream", () => {
  const report = summarize(parseAgentLog(FIXTURE), { days: 2 });
  assert.deepEqual(report.days, ["2026-11-09", "2026-11-08"]);
  assert.equal(report.upstreams.DeepInfra.calls, 1);
  assert.equal(report.upstreams.DeepInfra.coldCalls, 1);
  assert.equal(report.perDay[1].day, "2026-11-08");
  assert.equal(report.perDay[1].calls, 1);
});

test("the printed report carries the same facts a reader acts on", () => {
  const text = formatReport(summarize(parseAgentLog(FIXTURE), { days: 1 }));
  assert.match(text, /2026-11-09\s+calls=3/);
  assert.match(text, /Relace\s+calls=1.*cold=1 calls \/ 200,000 in/);
  assert.match(text, /compression folds \(window\): 1/);
  assert.match(text, /sess-a\s+calls=2\s+in=300,000/);
});
