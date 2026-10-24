# Claude Code agents in the panel — phase 2 handoff

Status: in progress
Version line: 0.2.x

Repo: `Millerfly91/agent-worktree-gui` (a fork of `JLRoper/agent-worktree-gui`). Work happens and is reviewed
here: `origin` is the fork, `upstream` is the original, and PRs are opened inside the fork. The version check's
default base, `origin/main`, is therefore the fork's `main`.

Phase 1 (PR #1 in the fork, v0.2.0) made the panel *see* Claude Code sessions. Phase 2 makes it *run* them:
spawn, reply, steer, approve and stop, the way it already does for Hermes. This file is the handoff: what is
proven, what is planned, and the one rule every step has to follow.

## The version rule

The version is declared once, in `package.json`; the page header reads it from there. It moves **only when code
changes**:

- **Code** is `server.js`, `lib/` and `public/`. A PR that changes any of them bumps the patch number — the third
  number of `version` — and stays on the line named above (`0.2`) while this plan is in progress
  (`Status: in progress`). One bump per PR; it must be strictly higher than the base branch's.
- **Everything else does not bump**: `docs/` (handoffs included), `tools/`, `README.md`, `SETUP.md`. A docs-only or
  handoff-only PR leaves `version` exactly as it is.

    node tools/verify-version-bump.mjs --base <ref>      # default ref: origin/main

The check looks at what changed against the base: it fails if code changed and the version did not go up (or left
the `Version line` mid-plan), and it fails if the version moved when no code changed.

When the last milestone lands, that PR sets `Status: complete` and takes the minor bump (`0.3.0`). From then on a
code change only has to make the version go up.

## Spike 2a — what is proven (claude 2.1.310, Windows, haiku)

Driven from `tools/spike-claude-stream.mjs`: `claude -p --input-format stream-json --output-format
stream-json --verbose`, one process per run, cwd = the worktree.

| question | answer |
|---|---|
| Event stream | `system/init` → `assistant` (`tool_use` / `text` / `thinking`) → `user` (`tool_result`) → `result` (`subtype`, `is_error`, `total_cost_usd`, `usage`, `num_turns`, `permission_denials`, `session_id`). `system` hook events and `rate_limit_event` are noise. |
| Approvals | Needs **`--permission-prompt-tool stdio`** (plus an `initialize` control request first, as the SDK sends). A tool that needs permission then arrives as `control_request` / `can_use_tool` (`tool_name`, `input`, `tool_use_id`, `permission_suggestions`). Answer with `control_response` `{behavior: "allow", updatedInput}` (or `deny`). Without the flag the tool is **auto-denied** and only shows up in `result.permission_denials`. |
| Steer | A `user` message written to stdin mid-turn is read at the next tool boundary and folded into the same turn (the agent answered the steer, `turns=3`, one `result`). |
| Interrupt | `control_request` `{subtype: "interrupt"}` → `control_response` success → `result` `error_during_execution`, `is_error: true`, process exits **1**. That is a cancel, not a failure. |
| Resume | `--resume <session_id>` continues the conversation and remembers earlier tool work. It also worked when started from a **different** cwd; the new `init` reports the cwd it was given. |
| Per-run cwd | The process cwd *is* the agent's cwd, so there is no prompt-anchoring hack (the stock Hermes gateway needs one). |

Things that will bite:

- **One process can produce more than one `result`.** A background task that finishes after the first
  `result` wakes the session: a second `init` + `result` arrived ~25 s later on the same process. A job is
  not "done at the first `result`"; it is done when the process exits or stdin is closed.
- Claude may refuse a bare `Start-Sleep` and re-run it in the background — expect `run_in_background` tool inputs.
- User hooks and plugins run in headless sessions (`hook_started` / `hook_response` events). `--bare` skips them
  but also changes auth and memory behaviour, so it is a decision, not a default.
- Spend is real: pass `--max-budget-usd` on every run.

## Design

1. Split the transport out of `Jobs` (`lib/jobs.js`: `create` / `follow` / `steer` / `approve` / `stop` / `poll`
   are Hermes HTTP today). Hermes code moves unchanged behind an interface; a `claudeCli` transport joins it.
   Each job gets `agent: "hermes" | "claude"`. `consume()` and the cards stay shared.
2. `claudeCli` translates Claude events to the panel's vocabulary:
   `init` → `init`, `tool_use` → `tool.started`, `tool_result` → `tool.completed`, `text` → `message.delta`,
   `can_use_tool` → `approval.request`, `result` → `run.completed` / `run.failed` (+ stats, cost).
3. The prompt goes on stdin, never in argv. Thread names (`wtgui-…`) map to Claude session UUIDs, persisted.
4. Reply = a new process with `--resume`. Steer = a stdin `user` message. Stop = interrupt, then
   `taskkill /T` as the fallback.
5. `claudeSessionRoots` takes an `exclude` set of panel-owned session ids, so a panel agent is not also drawn as
   an external `⧉ claude`.
6. Config: `claudeBin`, default model, per-run budget cap. Permission mode defaults to panel-prompted; `yolo`
   is the only route to `bypassPermissions`. Localhost binding stays.
7. UI: Hermes / Claude picker on the New-agent card, Claude model list, a cost readout, a "claude found" chip.

## Milestones — one PR each; a patch bump only where code changes

| milestone | what | version |
|---|---|---|
| 2a | spike + this handoff + the version check (docs and tools only) | 0.2.0 (no bump) |
| 2b | transport split, no behaviour change (verify with a real Hermes run) | 0.2.1 |
| 2c | Claude spawn, stream, stop | 0.2.2 |
| 2d | reply (resume) and steer | 0.2.3 |
| 2e | approvals | 0.2.4 |
| 2f | dedup, UI picker, docs, `tools/verify-claude-transport.mjs` | 0.2.5 |
| done | `Status: complete` | 0.3.0 |

If a milestone splits and both halves change code, the second takes the next patch number; the table is a
forecast, the rule is the contract.

## Open decisions

1. Scope: all of 2b–2f, or stop after 2d and defer approvals?
2. Base: stack on PR #1, or wait for it to merge. 2b rewrites `lib/jobs.js`, which `upstream` also edits, so
   merge `upstream/main` into the fork regularly (it moves fast) and keep the transport split a small, early PR.
3. Default permission behaviour (panel-prompted is the recommendation) and whether to use `--bare`.
4. Tests: a stub `claude` that replays recorded streams. Record and sanitise fixtures in 2c; the hook events
   carry local plugin output, so do not commit a raw capture.
