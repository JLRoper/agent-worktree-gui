# The gateway's `unknown_execution` fence — measured endpoints

Measured 2026-11-04 20:02–20:03 EST (2026-11-05T01:02–01:03Z) against the running gateway
(pid 41492, api_server on `http://127.0.0.1:8642`), `state.db` runtime epoch **19**, worktree cut at
`f19b615` (main). Every row below is one request this run sent, not a reading of the handler source.
The account of what these rows mean, and the two reproductions that drive the panel side, are in
[`assistant-session-fence.md`](assistant-session-fence.md). The receipt's `profile_id` is elided to
`<hermes profile>`; every other field in every row is as returned.

Throwaway probe session only: `probe-fence-30894de6-c`, run `run_3ea61cf919c545ef84aa70d80ac5bae8`,
admission `a1209a5fc2e246d5a456d0718d011ffd`, generation 1. It was seeded by the predecessor run
with `POST /v1/runs` and left `unknown`. No `panel-assistant-*` row was read or written, and the
gateway was not restarted.

## The table

| # | method | path | status | body |
|---|--------|------|--------|------|
| 1 | GET | `/v1/runs/run_3ea61cf919c545ef84aa70d80ac5bae8` | 200 | `{"object":"hermes.run","pending_controls":[],"run_id":"run_3ea61…c5bae8","status":"unknown","session_id":"probe-fence-30894de6-c","admission_id":"a1209a5f…011ffd","execution_generation":1,"output":"","usage":{}}` |
| 2 | POST | `/v1/runs/{id}/resolve-unknown` body `{"admission_id":"a1209a5f…011ffd"}` (no generation) | 400 | `{"error":{"message":"invalid_params","type":"invalid_request_error","param":null,"code":"invalid_params"}}` |
| 3 | POST | `/v1/runs/{id}/resolve-unknown` body `{"admission_id":"a1209a5f…011ffd","execution_generation":1,"extra":true}` | 400 | same `invalid_params` envelope |
| 4 | POST | `/v1/runs/{id}/resolve-unknown` body `{"admission_id":"a1209a5f…011ffd","execution_generation":2}` | 409 | `{"error":{"message":"stale_generation","type":"invalid_request_error","param":null,"code":"stale_generation"}}` |
| 5 | POST | `/v1/runs/{id}/resolve-unknown` body `{"admission_id":"deadbeef","execution_generation":1}` | 409 | `{"error":{"message":"not_found","type":"invalid_request_error","param":null,"code":"not_found"}}` |
| 6 | POST | `/v1/runs/run_0000000000000000000000000000/resolve-unknown` (valid body) | 404 | `{"error":{"message":"Run not found: run_0000000000000000000000000000","type":"invalid_request_error","param":null,"code":"run_not_found"}}` |
| 7 | POST | `/v1/runs/{id}/stop` | 409 | see below — the fence body |
| 8 | POST | `/v1/runs` `{"input":"…","session_id":"probe-fence-30894de6-c","max_turns":1}` | 202 | `{"run_id":"run_51ea12dfa92c4f339a8fc4b9af0e9e23","status":"started","replayed":false}` — then the run fails server-side |
| 9 | GET | `/v1/runs/run_51ea12dfa92c4f339a8fc4b9af0e9e23` (3 s after #8) | 200 | `{"object":"hermes.run","model":"hermes-agent","created_at":1793840551.6869333,"pending_controls":[],"run_id":"run_51ea…e9e23","status":"queued","session_id":"probe-fence-30894de6-c","admission_id":"a8c41642…1ec534","execution_generation":null,"output":"","usage":{}}` |
| 10 | POST | `/api/sessions/probe-fence-30894de6-c/chat` `{"input":"…"}` | 500 | `500 Internal Server Error` / `Server got itself in trouble` — aiohttp's bare page, no JSON envelope |
| 11 | POST | `/v1/runs/{id}/resolve-unknown` body `{"admission_id":"a1209a5f…011ffd","execution_generation":1}` | 200 | `{"run_id":"run_3ea6…c5bae8","admission_id":"a1209a5f…011ffd","ref":{"profile_id":"<hermes profile>","session_id":"probe-fence-30894de6-c"},"sequence":5887,"status":"terminal","outcome":"interrupted","authority_epoch":19,"execution_generation":1}` |
| 12 | POST | the same body again | 200 | the identical receipt — an exact retry replays, it does not 409 |
| 13 | GET | `/v1/runs/run_3ea6…c5bae8` after #11 | 200 | `{"object":"hermes.run","pending_controls":[],"run_id":"run_3ea6…c5bae8","status":"cancelled","session_id":"probe-fence-30894de6-c","admission_id":"a1209a5f…011ffd","execution_generation":1,"output":"FENCE-SEED-C","usage":{"input_tokens":17012,"output_tokens":8,"total_tokens":17020}}` |
| 14 | POST | `/v1/runs/probe-fence-30894de6-c/resolve-unknown` — the **session** id in the run-id slot, valid body | 404 | `{"error":{"message":"Run not found: probe-fence-30894de6-c","type":"invalid_request_error","param":null,"code":"run_not_found"}}` |
| 15 | GET | `/v1/runs/run_51ea…e9e23` (the run #8 left `queued`) after #11 | 200 | `{"object":"hermes.run",…,"run_id":"run_51ea…e9e23","status":"completed","session_id":"probe-fence-30894de6-c","admission_id":"a8c41642…1ec534","execution_generation":2,"output":"OK","usage":{"input_tokens":17036,"output_tokens":3,"total_tokens":17039}}` |
| 16 | POST | `/v1/runs` fresh turn on the same session after #11 | 202, then GET 200 | `{"run_id":"run_92022…b31470","status":"started","replayed":false}` → `{…,"run_id":"run_92022…b31470","status":"completed","execution_generation":4,"output":"DONE","usage":{"input_tokens":17075,"output_tokens":4,"total_tokens":17079}}` |

## The exact 409 `unknown_execution` body

`POST /v1/runs/{id}/stop` on a run whose admission is `unknown` answers **409**, without a
`Retry-After` header, with exactly:

```json
{"error": {"message": "unknown_execution", "type": "invalid_request_error", "param": null, "code": "unknown_execution"}}
```

The same envelope (message and code both `unknown_execution`) is the store's refusal reason
everywhere else it surfaces; `store_error_response` maps any reason outside
`{invalid_params, runtime_draining, storage_unavailable, chain_moved}` to 409
(`gateway/platforms/api_server_authority_runs.py:18-34`), which is why #5's `not_found` is a 409
too.

## What the fence actually is

- The refusal is a **store** read, not in-memory state: `claim_session_input` refuses to claim the
  FIFO head while any row for the session is `status IN ('started','unknown')` and raises
  `unknown_execution` on an `unknown` one (`hermes_state_runtime.py:211-213`). That is why the
  pause survives a restart and why a fresh `POST /v1/runs` (#8) is accepted and then fails.
- The pause is per session (`Session probe-fence-30894de6-c paused: unknown_execution` twice in
  `logs/gateway.log` at 20:02:31), and the drain that hit it stops; the admitted-but-unclaimed run
  stays `queued` (#9, `execution_generation: null`).
- `POST /v1/runs` is asynchronous, so the caller sees **202 `started`** and the fence only in the
  run's later record — `POST /v1/runs/{id}/stop` (#7) is the synchronous way to see the 409 body.
- `/api/sessions/{sid}/chat` does **not** map the refusal: the pause reaches the handler as an
  unhandled `RuntimeStoreError` and aiohttp answers its bare 500 page (#10). A caller keying on
  the JSON envelope must use the `/v1/runs` control routes, not this one.

## What the resolve endpoint requires

- The **run id in the path is required** and must be an owned run naming the admission: an
  unknown id is 404 `run_not_found` (#6), and the run's own `admission_id` is compared with the
  body's (#5). There is no session-keyed resolve on this route.
- A **session** id in the run-id slot is not a substitute (#14): the route is run-keyed, and the
  only way to name the admission is through the run that owns it (#5 compares the body's
  `admission_id` with the run's own).

## What actually clears the pause

One call, and it is the same endpoint — `POST /v1/runs/{run_id}/resolve-unknown` with the exact
body (row #11):

```json
{"admission_id": "a1209a5fc2e246d5a456d0718d011ffd", "execution_generation": 1}
```

It answered **200** with a receipt rather than a projection:

```json
{"run_id": "run_3ea61cf919c545ef84aa70d80ac5bae8", "admission_id": "a1209a5fc2e246d5a456d0718d011ffd", "ref": {"profile_id": "<hermes profile>", "session_id": "probe-fence-30894de6-c"}, "sequence": 5887, "status": "terminal", "outcome": "interrupted", "authority_epoch": 19, "execution_generation": 1}
```

and in `state.db` the unknown row left `unknown` for `terminal`/`interrupted`:

| admission_id | before | after | generation |
|---|---|---|---|
| `a1209a5fc2e246d5a456d0718d011ffd` | unknown | terminal / interrupted | 1 |
| `a8c416424994486ba4dd72a5ad1ec534` (the run #8 admitted behind the fence) | queued | terminal / completed | 2 |
| `8d46b519e3234e728d0804700735886e` (the admission `/api/sessions/{sid}/chat` made before its 500) | queued | terminal / completed | 3 |
| `db1b5a590fa043399682554718cee905` (the fresh turn, #16) | — | terminal / completed | 4 |

So the resolve does two distinct things:

1. **It settles the lost turn without re-running it** — `outcome: interrupted`, not a requeue. A
   client that wanted that input resends it.
2. **It resumes the session's FIFO.** The two rows already admitted behind the fence were drained
   and completed on their own (#15 `output: "OK"`, generation 2), the session's
   `runtime_generation` advanced 1 → 3, and a new `POST /v1/runs` was accepted and completed
   (#16, generation 4, `output: "DONE"`). There is no separate "unpause" call: clearing the
   `unknown` row is the unpause, because the fence is that read.

Two reader-facing details worth carrying:

- The resolved run's **projection reads `status: "cancelled"`** (`GET /v1/runs/{id}`, #13), not
  `interrupted` — the receipt is the only place the word `interrupted` appears. The output and
  usage the predecessor's seed produced (`FENCE-SEED-C`, 17012/8 tokens) stay on the record.
- The resolve is **idempotent on the exact body** (#12: the same 200 receipt again), so a client
  retrying a lost acknowledgement is not told 409.

No gateway restart was involved, and no `panel-assistant-*` session was touched.
