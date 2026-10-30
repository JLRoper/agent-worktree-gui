# Claude Code agents in the panel — phase 2 handoff

Status: in progress
Version line: 0.3.x

**Version-line decision (2e, recorded per section 0 of `docs/2e_handoff.md`):** `origin/main` moved to `0.3.1` from
unrelated work while this plan held `Version line: 0.2.x` — a 2e code PR could not pass the check either way (bump
to `0.3.2` fails "stay on 0.2.x while in progress"; bump to `0.2.6`, the old forecast, fails "must go up from
0.3.1"). No other plan is in progress on a `0.3.x` line (checked: `docs/claude-phase2-handoff.md` is the only file
with a `Version line:` field). Chosen: **re-set the line to `0.3.x`** (option 1). Between writing that decision
and landing this code, unrelated work merged into `main` again and took `0.3.2` — so 2e ships as `0.3.3` (one
above `main`'s tip at merge time, re-checked right before landing), 2f will be `0.3.4`, and the close-out's old
`0.3.0` forecast is void; `Status: complete` will take the next minor, `0.4.0`.

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
   `can_use_tool` → `approval.request` (2e DONE), `result` → `run.completed` / `run.failed` (+ stats, cost).
   
3. **[2c DONE, mapping 2d]** The prompt goes on stdin, never in argv. Thread names (`wtgui-…`) map to Claude session UUIDs, persisted.
   
4. **[2d DONE]** Reply = a new process with `--resume`. Steer = a stdin `user` message. Stop = interrupt, then
   `taskkill /T` as the fallback.
   
5. **[2e DONE]** `--permission-prompt-tool stdio`, always; `can_use_tool` becomes `approval.request` (once/session/deny);
   `ClaudeTransport.approve()` answers it on stdin; a per-request deadline timer denies and records "nothing decided
   here" if nobody does; `stop()` denies every pending request first.
   
6. **[2f TODO]** Config: `claudeBin`, default model, per-run budget cap. Permission mode defaults to panel-prompted; `yolo`
   is the only route to `bypassPermissions`. Localhost binding stays.
   
7. **[2f TODO]** UI: Hermes / Claude picker on the New-agent card, Claude model list, a cost readout, a "claude found" chip.

8. **[2f TODO]** `claudeSessionRoots` takes an `exclude` set of panel-owned session ids, so a panel agent is not also
   drawn as an external `⧉ claude`.

## Milestones — one PR each; a patch bump only where code changes

| milestone | what | version | status |
|---|---|---|---|
| 2a | spike + this handoff + the version check | 0.2.1 | ✓ done |
| 2b | transport split, no behaviour change (verify with a real Hermes run) | 0.2.2 | ✓ done |
| 2b follow-up | `job.agent`, `transportFor(job)`, `info()` | 0.2.3 | ✓ done (re-landed in 2c, see below) |
| 2c | Claude spawn, stream, stop | 0.2.4 | ✓ done |
| 2d | reply (resume) and steer | 0.2.5 | ✓ done |
| 2e | approvals | 0.3.3 | ✓ done |
| 2f | dedup, UI picker, docs | 0.3.4 | |
| done | `Status: complete` | 0.4.0 | |

The `2e`/`2f`/`done` versions were re-forecast twice: once when the version line moved to `0.3.x` (see the
version-line decision above), and again just before landing when unrelated work had already taken `0.3.2` on
`main` — the original `0.2.6`/`0.2.7`/`0.3.0` row, and the once-current `0.3.2`/`0.3.3` row, are both void.

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

## Milestone 2d Delivery (v0.2.5)

**Reply** (`Jobs.create` on a Claude thread with siblings): a new `claude -p` process with `--resume <session>`,
where `<session>` is the `sessionId` of the thread's latest turn that actually started (has a `runId`). It runs in
the cwd the reply route already picks (the first turn's worktree while it exists, else the project), and makes no
tree of its own. The new turn's `runId` is `claude-<session>-t<turn>` (the session is shared, the run id must not be).

- **`--resume` does not combine with `--session-id`** on 2.1.310: the CLI exits with "--session-id can only be used
  with --continue or --resume if --fork-session is also specified". So a reply passes `--resume` alone, and
  `j.sessionId` starts as the resumed id and is overwritten by whatever `system/init` reports (`claude.init`). A
  resume keeps the id; if a future CLI forks, the next reply still resumes the right one.
- The mapping is persisted: `sessionId` (and now `resumeSession`, for the record) are in the job store, so a reply
  after a panel restart resumes the same session (tested).
- Refused, with a 409 from `/api/agents/reply`: a reply while a turn of the thread is still running (two processes
  would write one session; steer is the way in), and a reply to a thread whose first turn never started.
- `/api/agents/reply` probes the Claude CLI (`claude --version`, free) for a Claude thread instead of assuming the
  gateway, and answers 503 if it is not usable.
- **Budget bug fixed on the way:** the reply route and the assistant's `answerThread` defaulted `budget` to `1800`
  (the gateway's run budget). For a Claude turn that would have become `--max-budget-usd 1800`. A Claude reply now
  falls through to `claudeBudgetUsd`.

**Steer** (`ClaudeTransport.steer`): a `userTurn(text)` line on the running process's stdin, and a
`⇢ steer sent: …` dim line, as Hermes does. Accepted only while the process is alive, no `result` is held and no stop
was asked; otherwise `{ ok: false, code: "run_not_accepting_steer" }`, which the steer route maps to 409 like Hermes.
After the `result` stdin is closed (that is what lets the process exit), so there is no way in after it: reply instead.

- **One result or two?** A steer that reaches the CLI before the turn's last tool boundary is folded into that turn:
  one `result` (spike 2a, and the live check below). A steer that lands after the last boundary but before the
  `result` reached the panel is read by the CLI as a turn of its own and answered with a second `result` before the
  process sees stdin close. The transport holds the latest `result`, settles on process exit as before, and the card
  says `claude answered N times in this turn` when that happens. Either way the job ends exactly once.
- approve is wired in 2e (see below); clarify still answers `not_in_2c`.

**Tests:** `tools/verify-claude-reply.mjs` (offline): resume argv and cwd, no `--session-id` beside `--resume`, init's
session wins, the mapping survives a restart, both refusals, steer folded into one result, steer after the result
refused with the Hermes code and never written, two results settle on the last, a Hermes reply unchanged.
`tools/stub-claude.mjs` gained `steer` and `twice` modes, `--resume` in its log, `STUB_CLAUDE_SESSION` and
`STUB_CLAUDE_LINGER_MS`, and replays the fixture under the argv session id as the real CLI would.

**Live check** (sandbox panel on 7399, haiku, `claudeBudgetUsd: 0.10`, CLI 2.1.310): "Remember the word KIWI.
Reply OK." → `OK`; the reply "What word did I ask you to remember?" ran `--resume <same uuid>` in the same worktree
with `--max-budget-usd 0.1` and answered `KIWI`; init reported the same session id. Steer sent 10 s into a 30 s shell
command ("reply BANANA instead of APPLE") → one result, `BANANA`, job settled on exit. Hermes `PONG` on the same panel
completed. Claude spend: $0.0196 over four turns.

## Milestone 2e Delivery (v0.3.3)

**2e shapes** (step 1 of `docs/2e_handoff.md`, proven live against CLI 2.1.314, haiku, a throwaway repo under
`tools/spike-claude-stream.mjs deny|session <cwd>`):

- **deny**, proven: answer `{"behavior":"deny","message":"..."}` in the `control_response`. The file was never
  created; the agent's own turn said so without retrying or using another tool. `message` is read back by the
  CLI but its exact wording is not echoed to the user — any short string works.
- **allow for the session**, proven: the CLI offers exactly one `permission_suggestions` entry —
  `{"type":"setMode","mode":"acceptEdits","destination":"session"}` — on every `can_use_tool` request seen so far
  (Write). Copying that single entry verbatim into `updatedPermissions` (`{"behavior":"allow","updatedInput":...,
  "updatedPermissions":[<the suggestion>]}`) suppressed the prompt for a second `Write` call in the same turn: no
  second `can_use_tool` request arrived. `session` is offered on the card only when `permission_suggestions` is
  non-empty (every case observed so far).
- `permission_suggestions` was never empty on the tools exercised (`Write`), so the empty-suggestions / no-`session`
  branch is implemented (`choices` drops `session`) but unexercised live.
- A steer while a request is parked, and `permission_suggestions` for a tool other than `Write`, were not checked
  live — see "Deviations" below.

**Translator** (`lib/claude-stream.js`): `control_request`/`can_use_tool` → `{ event: "approval.request",
request_id, command, choices, timestamp, toolUseId, toolName, input, permissionSuggestions, control }`. `command`
is `"<tool_name> · <previewFor(...)>"` (e.g. `Write · C:\...\approved.txt`), reusing the existing preview table.
`choices` is `["once","deny"]`, or `["once","session","deny"]` when a suggestion was offered. `timestamp` is epoch
seconds (`Jobs.consume` multiplies by 1000) — the translator's own clock, there being no arrival time on the wire.
Every other `control_request` subtype still comes back `claude.unparsed`, unchanged.

**Transport** (`lib/claude-transport.js`):
- `--permission-prompt-tool stdio` is now always in the spawn args (the 2c comment calling it "not passed" is
  gone) — always paired with `approve()`, so the flag never ships without an answer path.
- `p.pending`: `Map<request_id, { toolUseId, input, suggestions, timer }>`, filled in `onLine` the moment the
  translator emits `approval.request` (right after `jobs.consume(j, evt)` sets `j.approval`, so the per-request
  timer reads the card's own deadline).
- `approve(j, choice, requestId)`: `once` → allow with the original `input`; `session` → allow with
  `updatedPermissions: [suggestions[0]]`; anything else (`deny`, or a choice the card should never send) → deny.
  Writes the `control_response`; a failed write is reported as an error and answers nothing. On success: clears
  the request's timer, removes it from `p.pending`, pushes a console line, calls
  `jobs.consume(j, { event: "approval.responded", choice })`, returns `{ ok: true, choice, resolved: null }`. A
  `requestId` that names nothing pending is refused (`approval_expired`) rather than silently falling back to the
  one real pending request — only an *absent* `requestId` (an offline caller) uses the size-1 fallback.
- **Expiry fires on the transport's own clock, not the generic sweep.** Unlike the Hermes gateway (an HTTP service
  the panel can only poll for — `Jobs.sweepApprovals`'s 5s tick), this transport knows the exact instant it is
  about to deny, so `expirePending()` calls `jobs.expireApproval(j, …, "expired")` directly before writing the
  deny. Without this the turn can finish (on the deny) and `settle()` silently clear `j.approval` before the 5s
  sweep ever notices — losing the "nothing was decided here" record in the race. Confirmed by a live run (300s
  default window, nobody answered): the card recorded `approvalDone.expired === true` and the agent said the file
  was not created.
- **Never auto-allow**: nothing answers a request but `approve()`, the deadline timer, or `stop()`'s pre-interrupt
  deny below.
- `stop(j)` denies every entry in `p.pending` (with a short message) before sending the interrupt. `settle()`
  (reached through the `run.cancelled` the interrupt produces) clears `j.approval` for the card; `stop()` does not
  touch it directly.
- Process exit (`finish()`): any surviving `p.pending` timers are cleared and the map dropped — nothing is left to
  answer, and the card's own box is cleared by `settle()`.
- `steer()` now also refuses (`run_not_accepting_steer`) while `p.pending.size > 0` — not proven live (see
  deviations), kept conservative rather than guessed.
- The stale card note "approvals are not wired for Claude jobs yet" next to the denied-count is gone (approvals
  are wired now); the line is just `cost $… · N turn(s) · M tool call(s) denied` when the CLI denied any.
- `clarify()` is unchanged (`not_in_2c`) — not part of 2e.

**Deviations from the plan:**
- `session`'s exact UI gating (offered only when `permission_suggestions` is non-empty) was confirmed for `Write`
  only; other tools were not exercised live, but the gating logic reads the array generically, not by tool name.
- A steer sent while an approval is parked is refused (2d's conservative default), not proven against the live
  CLI — the plan said to verify this before coding; it was not reachable in the sandboxed live check's time
  budget, so the refusal stays and is called out here instead of guessing the CLI's behaviour.

**Tests:** `tools/verify-claude-transport.mjs` extended (`can_use_tool` → `approval.request`, not
`claude.unparsed`; choices with/without a suggestion; command string; epoch-seconds timestamp; other
`control_request` subtypes unaffected). `tools/verify-claude-spawn.mjs`: the flag is now always in argv; an
`approve()` with nothing pending is `approval_expired`, not `not_in_2c`. New `tools/stub-claude.mjs` mode
`approval` (a `Write` `can_use_tool` request with the proven `permission_suggestions` shape; `allow` →
`FILE_WRITTEN`, `deny` → `FILE_NOT_WRITTEN`, driven purely by whatever `control_response` arrives — the host's
timer or `stop()` answer it exactly like a reader would). New `tools/verify-claude-approval.mjs` (26 checks,
offline): approval.request shape and choices, `once`/`deny`/`session` exact wire shapes, an unknown `request_id`
refused without touching the real pending one, an answer after expiry refused `approval_expired`, the deadline
denying with no reader action and recording `expired: true`, `stop()` denying pending requests and ending
`cancelled`. `tools/spike-claude-stream.mjs` gained `deny` and `session` scenarios for the live proof above.
`node --test test/*.test.js`: 307 pass, 2 skipped, 0 failed (unaffected by this change).

**Live check** (sandbox panel on 7399, haiku, `claudeBudgetUsd: 0.15`, CLI 2.1.314, real spend ≈ $0.025 total
across this phase's live runs): a real job asking for a `Write` parked on the card within ~1s of spawn
(`approval.request` with `choices: ["once","session","deny"]`); `POST /api/jobs/approve {choice:"once"}` → file
written, turn replied `DONE-APPROVAL`, and after a reload the browser showed the collapsed `✓ approved once: Write
· <path>` line under the turn. A second run answered `{choice:"deny"}` → the file was never created and the agent
said so, twice (once live against the panel's up-to-date code, confirming the stale "not wired" text is gone from
the console). A third run was left unanswered: the transport's own 300s deadline denied it on its own clock, the
agent said the file did not exist, and `approvalDone` recorded `{choice:"", expired:true, reason:"expired"}` with
no reader action. A Hermes `PONG` job on the same panel still completed (`status: done`). The sandbox panel and
its scratch repos were torn down after the check; nothing was pushed.

## Open Decisions

1. Scope: all of 2c–2f, or stop after 2d and defer approvals?
2. Default permission behaviour (panel-prompted is the recommendation) and whether to use `--bare`.
3. ~~Tests~~ done in 2c: `tools/stub-claude.mjs` replays the sanitised fixture.
4. How to handle per-run budget tracking and cost display for Claude runs.
