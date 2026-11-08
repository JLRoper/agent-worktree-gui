# What a turn costs, and what the panel costs

Measured on the live panel and the gateway's own log before any of this was written, so the numbers below are what
the change is answering rather than a claim about the change.

## The measurements

| what | number | where it came from |
| --- | --- | --- |
| provider call latency | p50 2.9 s · p90 9.3 s · p99 28.9 s · max 109 s | 3,068 `API call` lines in `agent.log` |
| input tokens per call | p50 123,786 · p90 253,442 · max 523,851 | the same lines |
| tool errors | 203, the five slowest terminal calls at 403 s · 309 s · 307 s · 306 s · 305 s | the 300 s terminal timeout, then a retry |
| panel's own stream | 2.43 events/s total, 0.57 `jobline`/s across 9 live runs | 30 s of `/api/stream` |
| panel CPU | 87-89 % idle on all five threads | V8 CPU profile |
| gateway rejections | 3,748 `invalid API key` — capabilities 1,862 · skills 999 · model options 812 · runs 18 | `gateway.log` |

Two conclusions follow, and both are about the same disease. The panel is not the limiter: its only throttle is the
120 ms line coalescing in `lib/jobs.js`, and measured traffic is a fifth of a second per line. What costs wall time is
per-call input (the model re-reads the whole request) and process creation (0.6-4.7 s per `CreateProcess` on this
machine, paid by every git scan and every agent tool call alike).

## What this landing changes

1. **`tools/test-changed.mjs` (`npm run test:changed`).** The full suite is 226 processes; the tool picks the test
   files that NAME the changed files and runs only those, with `--list` to show the set and `--all` for the old
   command. This is the bounded validation a turn should run before a push — the 300 s stalls above were turns
   running the whole suite.
2. **A turn briefing budget.** `briefingBudgetChars` (assistant setting, 0 = off) caps the text one turn appends:
   the queue digest stays (it is written first and is what a turn acts on), the board's tail and the charter are cut
   at a line boundary, and the cut says so in its own words. A turn inside the budget is byte-identical to today's.
3. **Scan knobs in Settings → General.** `threads` and `worktreeSeconds` were config.json-only; both are now editable
   and applied LIVE (the scan pool is rebuilt, the cadence written into the scheduler). No restart.
4. **One gateway key.** `apiConfig()` now falls through to `<HERMES_HOME>/.env`, which is where the key actually
   lives on a normal install. `lib/jobs.js` used to do that read itself; `lib/hermes-models.js` and
   `lib/gateway-permissions.js` did not, and every capabilities/skills/model-options probe went out unauthenticated —
   the 3,748 rejections. One resolver fixes every caller.

## What is deliberately not here

Endpoint-agent exclusions (Cortex/Defender) would make each spawn ~40× cheaper and dwarf everything above, but they
are an infrastructure change outside this repo, so nothing here assumes them.

## The numbers to watch afterwards

`grep "API call #" agent.log` for the latency percentiles and the input p50, the tool-error durations, and
`/api/stream` frames/s. The target is lower p90 latency and fewer multi-minute tool stalls — not a higher event rate,
which is bursty by design.
