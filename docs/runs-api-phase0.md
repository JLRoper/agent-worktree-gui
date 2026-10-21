# Phase 0 — the Runs API, probed live

Goal: decide whether the panel's agent transport can move from `hermes chat -q --format stream-json`
(one process per run) to Hermes' HTTP Runs API, which is the only surface that offers a live handle on
a running agent. Phase 0 is configuration plus probing: no panel code changed.

Result: all four properties the panel needs were verified against a real gateway on this box —
fire-and-forget submission, live progress events, mid-run steering, and named-session continuation.

## What was enabled

In `$HERMES_HOME/.env` (names only — the key is a local bearer token, never committed):

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<32-byte urlsafe token>
```

Then:

```
hermes gateway restart
```

On Windows the restart prints `Gateway service is not installed` and starts the gateway by direct
spawn anyway (`✓ Gateway started via direct spawn (PID …)`); that line is not an error. The server
binds loopback only:

```
TCP    127.0.0.1:8642    LISTENING    <gateway pid>
GET /health  ->  {"status": "ok", "platform": "hermes-agent", "version": "0.22.2"}
```

`GET /v1/capabilities` confirms the features this plan depends on:

```
run_submission: true, run_status: true, run_events_sse: true,
run_stop: true, run_steer: true, run_approval_response: true,
tool_progress_events: true, approval_events: true
```

## The verified loop

Submission is immediate and detached (`201`/`202` shape, caller may walk away):

```
curl -s -X POST http://127.0.0.1:8642/v1/runs \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"input":"…","session_id":"phase0-runs-api"}'
-> {"run_id": "run_695c…", "status": "started", "replayed": false}
```

Steering, while it runs:

```
curl -s -X POST http://127.0.0.1:8642/v1/runs/$RID/steer \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"input":"Change of plan: do not run the remaining sleep commands. Reply exactly STEER-OK."}'
-> {"object": "hermes.run.steer", "run_id": "run_695c…", "accepted": true}
```

The probe run was told to `sleep 8`, `sleep 8`, then reply `DONE-PHASE0`. The steer landed at t+4s and
the run finished with `output: "STEER-OK"` — the second `sleep` never ran. Steering is a real
course correction inside the live turn, not a queued follow-up turn.

`GET /v1/runs/{id}/events` replays the whole lifecycle to a late subscriber (buffer is ~5 minutes, so
a panel that reconnects after a restart still gets the story):

```
 seq  event               detail
   0  tool.started        {"tool":"terminal","preview":"sleep 8"}
   1  run.steered         {"accepted":true}
   2  tool.completed      {"tool":"terminal","duration":10.317,"error":false,"preview":"{\"output\":\"\",\"exit_code\":0,…}"}
   3  message.delta       (assistant text, streamed)
   4  reasoning.available {"text":"STEER-OK"}
   5  run.completed       (output, usage, runtime, pending_steer)
```

Continuation maps straight onto the panel's thread model: a second run with the same `session_id`
and no history loaded the prior transcript and answered correctly about the previous reply
(`thread` here = `wtgui-<slug>-<rand>`, which is path-safe as a session id).

`POST /v1/runs/{id}/approval` resolves a parked approval, and the stream carries `approval.request`
— so the local `tools/approval.py` patch and the `worktree-panel` plugin described in
`hermes-approval-transport.md` become redundant once the transport moves.

## What the Runs API does not accept (the real work)

Verified against `gateway/platforms/api_server_runs.py` (`_handle_runs`) and
`gateway/platforms/api_server.py` (`_api_server_agent_kwargs`): the run body carries `input`,
`session_id`, `instructions`, `conversation_history`, `previous_response_id`, `model` — and nothing
below. There is no `cwd`, `worktree`, `max_turns`, `run_budget` or `skills`, and no per-run working
directory anywhere in the adapter (zero `cwd`/`chdir` matches in `api_server*.py`).

| CLI flag the panel uses today | Runs API today | Cheapest route |
|---|---|---|
| `--in DIR` (existing worktree) | absent | patch body → `agent_kwargs["cwd"]`; `AIAgent(cwd=…)` already sets `agent.session_cwd` → `scope_terminal_cwd()` (per agent, not a process chdir) |
| `-w` (new worktree) | absent | panel creates it (`git worktree add`; `lib/hermes-worktrees.js` already audits these) and passes the path as `cwd` |
| `--max-turns N` | config only (`_current_max_iterations`) | same patch block |
| `--run-budget SECONDS` | absent | same patch block |
| `-s skills` | absent (skills endpoint is discovery only) | same patch block |

All five are the same shape and land in one place, which is why the patch is small rather than
structural.

## Operational notes

- Concurrency ceiling is `gateway.api_server.max_concurrent_runs` (default 10, `0` disables). The
  panel's "non-batched" agents hit this, not `delegate_task`'s in-process limit.
- The panel now depends on a live gateway. If it is down, `POST /v1/runs` fails fast at connect;
  the panel should say so rather than report a spawned agent.
- A gateway restart settles in-flight runs as `interrupted` (event `run.interrupted`) instead of the
  panel's current "the panel restarted while this was running" — restarts get better, not worse.
- Tool output fidelity drops: SSE `tool.completed` carries a preview truncated to 500 characters
  (full payloads stay in the session transcript at `GET /api/sessions/{id}/messages`).
- `run.steer` is only accepted while status is `running`; a steer that outlives the last tool
  boundary comes back as `pending_steer` on the terminal event, so the panel can replay it as the
  next turn instead of losing it.
