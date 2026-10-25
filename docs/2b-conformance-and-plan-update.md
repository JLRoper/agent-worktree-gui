# Phase 2b conformance and plan update

Checked against `docs/remaining-phases-handoff-general-purpose-sonnet-5-5.md` (PR #3, `remainingPhases`), section "Phase 2b — transport split".

## What changed in code (v0.2.3)

- `lib/jobs.js`: every per-job delegation (`createRun`, `follow`, `poll`, `steer`, `controlContext`, `approve`, `clarify`, `stop`) now goes through `transportFor(j)`, which reads `job.agent`. `probe` stays on `this.hermes`.
- `job.agent` is set to `"hermes"` on create, written in the store, shown in `summary()`, and defaulted to `"hermes"` on load for old records.
- `this.transports = { hermes: this.hermes }` is the agent-keyed map the spec asks for.
- `lib/hermes-transport.js`: added `info()` returning `{ agent, url, keyed }`.

Nothing in `consume`, `settle`, `push`, `emit`, `linesForEvent` or `public/` changed.

## Verdicts against the 2b spec

| Spec item | Verdict | Where |
|---|---|---|
| `lib/transports/hermes.js` exists | deviates in structure | code is in `lib/transport.js` (base) and `lib/hermes-transport.js`. Kept. Moving the file is churn with no behaviour gain. |
| Class methods `probe, start, follow, status, steer, approve, answer, stop, info` | deviates in names | `createRun` (start), `poll` (status), `clarify` (answer). `info()` added. Kept the existing names; callers rely on them. |
| `Jobs` map keyed by agent; `job.agent` default `"hermes"`, persisted; old entries read as Hermes | matches (after v0.2.3) | `lib/jobs.js` |
| `jobs.api.url`, `jobs.probe()`, `jobs.transportInfo()` keep working | matches | unchanged |
| `consume`, `settle`, UI diff empty | matches | `public/` 0 lines changed by 2b; consume/settle untouched |
| `node --check` clean | matches | all `lib/*.js` and `server.js` |
| `verify-verdicts` and `verify-assistant` pass | assistant passes; verdicts exits 1 | verdicts shows one mismatch on the `forked_fallowsElysian` row. Same result before any 2b edit. Not caused by 2b; not investigated. |
| Live: PONG spawns, streams, finishes | matches | run in throwaway repo, `done`, PONG present |
| Live: second run steered | matches | steer accepted, run finished with STEERED |
| Live: stop | matches | stop returned true, status `cancelled` |
| Version: 2b is 0.2.1 | deviates | landed as 0.2.2; the follow-up is 0.2.3 |

## Revised version table

The 2b commit (097d5aa) landed at 0.2.2, so the plan's numbers from 2c onward move up by one.

| phase | what | version |
|---|---|---|
| 2a | spike, handoff | 0.2.0 (no bump) |
| 2b | transport split | 0.2.2 (landed) |
| 2b follow-up | `job.agent`, transport map, `info()` | 0.2.3 |
| 2c | Claude spawn, stream, stop | 0.2.4 |
| 2d | reply (resume) and steer | 0.2.5 |
| 2e | approvals | 0.2.6 |
| 2f | dedup, UI picker, docs, verify script | 0.2.7 |
| close-out | minor bump | 0.3.0 |

## Rules for 2c that follow from this

- 2c must create Claude jobs with `agent: "claude"` and register a `claude` transport in `this.transports`. `transportFor` already routes by that field, so per-job calls need no further edits.
- Method names in the spec's checklist (`start`, `status`, `answer`) are not used. New transports should use the names already in `lib/transport.js` (`create`, `poll`, `clarify`), so `Jobs` can call them without adapters.
- Re-run the live PONG, steer and stop check after 2c, as the spec requires.
