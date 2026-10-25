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

1. **[2b DONE]** Split the transport out of `Jobs` (`lib/jobs.js`). Hermes code moves unchanged behind an interface in `lib/hermes-transport.js`; 
   a `claudeCli` transport will join it in `lib/claude-cli-transport.js`. Each job gets `agent: "hermes" | "claude"`. 
   `consume()` and the cards stay shared.
   
2. **[2c DONE]** `lib/claude-stream.js` translates Claude events to the panel's vocabulary:
   `init` → `init`, `tool_use` → `tool.started`, `tool_result` → `tool.completed`, `text` → `message.delta`,
   `can_use_tool` → `approval.request` (2e; surfaced raw until then), `result` → `run.completed` / `run.failed` (+ stats, cost).
   
3. **[2c DONE, mapping 2d]** The prompt goes on stdin, never in argv. Thread names (`wtgui-…`) map to Claude session UUIDs, persisted.
   
4. **[2d TODO]** Reply = a new process with `--resume`. Steer = a stdin `user` message. Stop = interrupt, then
   `taskkill /T` as the fallback.
   
5. **[2f TODO]** `claudeSessionRoots` takes an `exclude` set of panel-owned session ids, so a panel agent is not also drawn as
   an external `⧉ claude`.
   
6. **[2f TODO]** Config: `claudeBin`, default model, per-run budget cap. Permission mode defaults to panel-prompted; `yolo`
   is the only route to `bypassPermissions`. Localhost binding stays.
   
7. **[2f TODO]** UI: Hermes / Claude picker on the New-agent card, Claude model list, a cost readout, a "claude found" chip.

## Milestones — one PR each; a patch bump only where code changes

| milestone | what | version | status |
|---|---|---|---|
| 2a | spike + this handoff + the version check | 0.2.1 | ✓ done |
| 2b | transport split, no behaviour change (verify with a real Hermes run) | 0.2.2 | ✓ done |
| 2b follow-up | `job.agent`, `transportFor(job)`, `info()` | 0.2.3 | ✓ done (re-landed in 2c, see below) |
| 2c | Claude spawn, stream, stop | 0.2.4 | ✓ done |
| 2d | reply (resume) and steer | 0.2.5 | |
| 2e | approvals | 0.2.6 | |
| 2f | dedup, UI picker, docs | 0.2.7 | |
| done | `Status: complete` | 0.3.0 | |

If a milestone splits and both halves change code, the second takes the next patch number; the table is a
forecast, the rule is the contract.

## Milestone 2b Delivery (v0.2.2)

**Created:**
- `lib/transport.js`: abstract `Transport` base class defining the interface for agent backends
- `lib/hermes-transport.js`: Hermes HTTP Runs API implementation of Transport

**Changes to lib/jobs.js:**
- Initialize `this.hermes` (HermesTransport instance) in constructor
- Rename `this.transport` state object to `this.transportState`
- Delegate all HTTP operations to transport: `probe()`, `create()` → `createRun()`, `follow()`, `steer()`, 
  `approve()`, `answerQuestion()` → `clarify()`, `stop()`, `poll()`, `controlContext()`
- Exported `runResultLine()` for potential external use

**Behavior verification:**
- No behavior changes (pure refactoring)
- Jobs class instantiation works correctly
- Transport interface is ready for Claude CLI backend (2c)
- Version bump 0.2.1 → 0.2.2 verified

## Milestone 2c Delivery (v0.2.4)

**2b re-landed first.** The merge that landed PR #6 kept the pre-split `lib/jobs.js`: `main` had the Hermes HTTP
calls inline and `lib/hermes-transport.js` was dead code. 2c re-ported the split by hand from `main`'s current
inline code (not the stale 2b copy), as its own commit with no behaviour change. `Jobs` now holds
`this.transports = { hermes, claude }` and routes every per-job call through `transportFor(j)` (keyed by `j.agent`,
default `"hermes"` on create and load). Request validation stays in `Jobs`; the backend calls live in the transport.

**Claude transport** (`lib/claude-transport.js`): one `claude -p --input-format stream-json --output-format stream-json
--verbose --session-id <uuid> [--model m] --max-budget-usd <n> --permission-mode <mode>` per turn, spawned in the
job's worktree with `shell: false`. `initialize` then the prompt go on stdin. stdout → `lineSplitter` →
`translateLine` → `Jobs.consume`. The `result` is held and stdin closed; the job settles when the process exits.
`j.sessionId` is the Claude session uuid, `j.runId` is `claude-<uuid>`. Stop = `interrupt` control_request, then
`taskkill /T /F` after 5 s; a stopped job ends `cancelled`. A panel/gateway restart sweep never asks the gateway
about a Claude job; a panel restart marks it interrupted and kills its process.

**Deviations and decisions:**
- `--permission-prompt-tool stdio` is **not** passed in 2c: nothing answers `can_use_tool` until 2e, so the job would
  hang. In `-p` mode a tool that needs permission is denied and counted on the card. Add it back in 2e.
- `--bare` is not passed (it changes auth and memory); the translator drops hook events.
- `bypassPermissions` only when the job has `yolo`. Otherwise `claudePermissionMode` (default `default`).
- No `--max-turns` on CLI 2.1.310: a Claude job says so on its card and relies on the budget cap.
- A reply to a Claude thread is refused until 2d (a fresh process would silently start a new conversation).
- steer / approve / clarify answer `{ ok: false, code: "not_in_2c" }`.
- No UI change: `POST /api/agents` takes `agent` (`hermes` default, `claude`) and `model`; the picker is 2f.

**Config** (`config.json`, all optional): `claudeBin` (`"claude"`), `claudeBudgetUsd` (`0.5`),
`claudePermissionMode` (`"default"`).

**Tests:** `tools/verify-claude-transport.mjs` (translator) and `tools/verify-claude-spawn.mjs` (process path through
`Jobs`, against `tools/stub-claude.mjs`: spawn, argv/stdin protocol, settle on exit, cooperative and forced stop,
crash, yolo, routing). Both offline.

Protocol pinned to Claude Code CLI **2.1.310**.

## Open Decisions

1. Scope: all of 2c–2f, or stop after 2d and defer approvals?
2. Default permission behaviour (panel-prompted is the recommendation) and whether to use `--bare`.
3. ~~Tests~~ done in 2c: `tools/stub-claude.mjs` replays the sanitised fixture.
4. How to handle per-run budget tracking and cost display for Claude runs.
