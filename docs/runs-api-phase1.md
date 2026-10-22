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

Placement is deliberate: the prompt is rendered **inside the parked turn, directly under that turn's
console output** (`approvalPrompt()` in `public/app.js`), not in a panel at the bottom of the card
or a floating modal — the question belongs where the reading stopped, and a modal would cover the
output it is about. Once answered, the box collapses to a single line under the same turn
(`✓ approved once: rm -rf build`, red `✕` for a denial), which is also persisted as
`approvalDone` so a reload keeps the record.

Both states were verified twice: first in a sandbox on `:7332` with seeded records (parked card
renders the amber box with the host's choices under the console; answered card renders the collapsed
line), then live once the three causes below were fixed — a real run parked, the card raised the
question, the answer resumed it, and the line replaced the box.

Also fixed while closing this: the collapsed line used to lose the command when the panel was the
surface that answered (the prompt is cleared on acceptance), and a steer that arrived after the
agent's last tool boundary was dropped instead of becoming the next turn — it is now replayed as the
next turn on the same thread, in the same directory.

## Why the prompt did not appear at first (and what fixed it)

Three separate causes, each measured:

1. **`run_in_executor` does not inherit contextvars.** A `/v1/runs` turn executes on a worker
   thread, so the approval gate's `_presence()` looked up the notify callback under the fallback
   session key ("default"), found nothing registered under the run's key, decided the run was
   unattended, and the guard took its bare `return _approved()`. The fix is in the gateway patch:
   `contextvars.copy_context()` around the worker submission. Instrumented before/after —
   `key='default', notify=False, is_ask=False` became
   `key='run_…', notify=True, is_ask=True`. The same propagation is what keeps the tool layer's
   per-task cwd key stable (see below), so the two bugs shared one root.
2. **The selected approval transport was `worktree-panel`.** That plugin posts a request to the
   panel's legacy `/api/approvals` and polls it — fine for the old `hermes chat -q` spawns, but for
   a run it means the question goes to a separate page instead of the run's stream. Measured: the
   pending request for `git reset --hard` sat on the *other* panel instance while the run's own job
   showed `approval: null`. `security.approval.transport: builtin` is what routes it to the run.
3. **`approvals.mode: smart`** judges these commands safe and waves them through. With
   `mode: manual` the same command parks and asks.

With all three addressed, verified end to end on a live run: `approval.request` reached the card
(`{requestId, command: "cd … && git reset --hard; echo \"EXIT=$?\"", choices: [once, session,
always, deny]}`), `POST /api/jobs/approve {"choice":"once"}` returned `{"ok":true,"resolved":1}`, the
parked run resumed and completed, and the card collapsed to the one-line record.

## The run's directory

`cwd` binds twice — the agent's own scope (`AIAgent(cwd=…)`, which drives the prompt and
context-file discovery) and the *tool* layer, via `register_task_env_overrides(task_id, {"cwd": …})`,
because the terminal tool resolves a directory per task, not per agent. The tool-layer key is only
stable if the worker thread sees the turn's context; without the contextvars fix, a run could start
in the gateway's own directory and stay there. Verified after the fix with three concurrent runs:
each one's `pwd` returned its own worktree.

`--yolo` is still not a Runs API field.

## Open defect: a gated first tool call can use the gateway's directory

Reproduction (2026-10-22, live on `:7331`, gateway with the patch):

| run shape | result |
|---|---|
| first tool call plain (`pwd`, `sleep`) | correct — the run's own worktree, three concurrent runs included |
| `pwd` first, gated second (`git reset --hard`) | both correct |
| first tool call gated (parks for approval) | command built as `cd ~ && …` (or `cd "C:/Users/roper"`), so it would act on the gateway home |

Two occurrences, both with a gated first call, so the pattern is consistent rather than random — but it
is not diagnosed. What is known:

- `register_task_env_overrides(task_id, {"cwd": …})` is applied before `run_conversation` and its key
  matches the task key the tools resolve (`qual == raw`, no profile prefix) — verified by probe.
- The wrapper `cd <cwd>` comes from the terminal Env's `cwd`, so on the failing path that Env was
  built with `config["cwd"]` (the gateway's directory) instead of the per-task override.
- The next thing to instrument is `_run_approval_guards()` / the approval-present path in
  `tools/terminal_tool.py`: it appears to materialise the command (and possibly the Env) before the
  per-task override is consulted, which would explain why only a gated *first* call is affected.

Until this is fixed, an agent whose very first action is a flagged command may run it in the gateway's
working directory. Plain commands are unaffected.
