# Phase 1 — the panel runs agents through the Runs API

The panel no longer spawns `hermes chat -q --format stream-json`. A job is now an HTTP run on the
gateway's api_server, which is what buys the three things the CLI transport could never give: a
handle on a live turn (steering), a transcript that does not die with the panel, and one process
serving every agent instead of one Python process each.

What moved, and what did not:

| | before | now |
|---|---|---|
| transport | child process, JSONL on stdout | `POST /v1/runs` + SSE `GET /v1/runs/{id}/events` |
| cancel | `taskkill /PID /T /F` | `POST /v1/runs/{id}/stop` (cooperative) |
| steer | not possible | `POST /v1/runs/{id}/steer`, read at the next tool boundary |
| thread | `-c <name>` | `session_id` (the same `wtgui-…` names, unchanged) |
| worktree | `hermes -w` made it | the panel runs `git worktree add -b wtgui/<slug>-<tag>` |
| cwd | `--in DIR` | `cwd` in the run body (needs the gateway patch below) |
| registry, ownership, labels, persistence, browser SSE | — | unchanged |

## Verified end to end (live gateway, real UI, throwaway repo)

1. **Spawn from the form** → the panel made
   `.worktrees/run-the-terminal-command-d55b49` on branch `wtgui/run-the-terminal-command-d55b49`,
   posted the run, and streamed the turn:
   `▸ terminal · sleep 10` → `↳ terminal · 12.22s` → `run completed · tokens 31282`.
2. **Steer a running turn** → typed into the card's reply box and pressed *Steer turn*:
   `⇢ steer sent: …` → `⇢ steer delivered to the live turn` → the agent skipped the second `sleep`
   and answered `STEER-OK-PANEL`. The run was told to `sleep 10`, `sleep 10`, then reply
   `DONE-PHASE1`; it finished with the steered answer instead.
3. **Continue the thread** → a reply on the same thread produced turn 2 and the agent quoted
   `STEER-OK-PANEL` back, so `session_id` continuation works exactly where `-c <name>` did.
4. **Agents land under their row** → `panelAgent` appears on the worktree row, so the card is filed
   under the tree the run is working in, not in the unattached panel.

## The gateway patch this needs

The stock Runs API accepts `input`, `session_id`, `instructions`, `conversation_history`,
`previous_response_id` and `model` — and no working directory. Without one, every run executes in
the gateway's own directory, which defeats a panel whose whole model is one agent per worktree.

`hermes-runs-api-knobs.diff` (kept beside this doc, taken from the live source tree) adds three fields to a run body:

| field | what it does | how it is applied |
|---|---|---|
| `cwd` | the run's directory; must be an existing absolute dir (400 `invalid_cwd` otherwise) | `AIAgent(cwd=…)` for the prompt/context side **and** `register_task_env_overrides(task_id, {"cwd": …})` for the tool layer — the same hook ACP and the TUI gateway use; released in the run's `finally` |
| `max_turns` | per-run tool-iteration cap (→ `max_iterations`) | same agent kwargs |
| `run_budget` | per-run wall-clock seconds (→ `run_budget_seconds`) | same agent kwargs |

The patch also advertises `run_cwd`, `max_turns` and `run_budget` in `/v1/capabilities`, so the
panel can tell a patched gateway from a stock one: the `127.0.0.1:8642` chip in the New-agent header
says `gateway ignores per-run cwd` when the patch is missing, instead of silently running agents in
the wrong directory.

The agent's own `cwd=` kwarg is not enough on its own: the terminal tool resolves a directory per
**task**, through `tools.terminal_tool`, so binding the task is the part that makes `pwd` agree with
the prompt. Measured before/after — the same run reported `C:\Users\roper` first, then the worktree.

Re-apply after `hermes update` (it replaces `gateway/platforms/api_server.py` and
`api_server_runs.py`); `.orig-runs-api-knobs` backups sit next to both files.

## Operational notes

- The panel needs the gateway's api_server up. `POST /api/agents` now probes it and answers **503**
  with the reason instead of creating a card that says "starting" forever.
- The key is read from `API_SERVER_KEY` in `$HERMES_HOME/.env` (or `apiServer.key` in the panel
  config). It is never logged.
- A panel restart marks in-flight cards `interrupted` with the run id, because the run itself may
  still be live in the gateway — the panel just no longer has a stream to steer through.
- Tool output is now the gateway's redacted, 500-character `tool.completed` preview rather than the
  full JSONL payload. The first 40 lines are still rendered per call.
- `--yolo` is not a Runs API field. Approvals are wired below.

## Approvals — wired, not yet observed

The panel side is built against the documented contract: `approval.request` carries a redacted
`command`, the host's `choices` and the run parks at `waiting_for_approval`; the card renders those
buttons and `POST /api/jobs/approve` → `POST /v1/runs/{id}/approval` answers it. The choice list is
never widened by the panel — it renders exactly what the host offered.

**What has not been demonstrated:** a live card. Three probes against this gateway all ran without
an `approval.request`:

| probe | rule it should match | what happened |
|---|---|---|
| `git reset --hard` | `DANGEROUS_PATTERNS` → "git reset --hard (destroys uncommitted changes)" | ran, exit 128 (not a repo in that shell), no approval |
| `rm -rf /nonexistent-hermes-approval-probe` | "delete in root path" | ran, exit 0, no approval |
| `bash -c "echo hi"` | "script execution via -c flag" (per `security` notes) | ran, exit 0, no approval |
| `mkfs -t ext4 /dev/sda1` | hardline | the model refused to call the tool, so nothing to gate |

So either the api_server turn resolves as "no surface can answer" and takes an allow path, or this
gateway process is not in `HERMES_EXEC_ASK`. Next step is to confirm which, inside a run:
`_presence()` in `tools/approval.py` returns `(callback, is_cli, is_gateway, is_ask)`, and
`is_ask` is what keeps the gate from resolving unattended. If `is_ask` is false, nothing in the
panel can fix it — the gateway has to be started by a path that sets it (`start_gateway()` does;
`hermes gateway restart` should reach it).

Until that is answered, panel-spawned agents behave like unattended agents and run flagged commands
without asking. That is the one remaining correctness gap in this phase.
