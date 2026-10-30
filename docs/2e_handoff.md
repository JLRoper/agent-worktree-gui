# Phase 2e handoff: Claude approvals (`can_use_tool`)

Written so a new agent can start 2e from scratch on a fresh branch cut from `origin/main`. It does not assume
any earlier session. Read sections 0 and 1 before touching code: section 0 is a version-rule blocker that will
make the version check fail if it is not resolved first.

Last verified against `origin/main` at `0cc9bcd` (package version `0.3.1`), CLI `2.1.310`.

---

## 0. Blocker: version line vs. package version (decide first)

- `docs/claude-phase2-handoff.md` says `Status: in progress` and `Version line: 0.2.x`. While that holds,
  `tools/verify-version-bump.mjs` requires every code change to keep `major.minor` at `0.2`.
- `origin/main` is at `0.3.1`. Those versions came from unrelated work, not from the Claude plan.
- So a 2e code PR cannot pass the check as written:
  - bump to `0.3.2`: fails "while the Claude plan is in progress the version stays on 0.2.x";
  - bump to `0.2.6` (the plan's forecast): fails "must go up from 0.3.1".
- Decide one of these before writing code, and record the decision in the 2e PR:
  1. Re-set the plan's line to `0.3.x` in `docs/claude-phase2-handoff.md` (a docs-only PR; check first that no
     other plan is in progress on `0.3`), then 2e takes `0.3.2`, and the close-out's `0.3.0` is void and must
     be re-stated.
  2. Keep `0.2.x` and get the user to say whether 2e should be shipped as `0.3.2` with an explicit
     exception in the check.
- Do not hand-edit `verify-version-bump.mjs` to get past this without the user's decision.

## 1. Where things stand (on `main`)

Landed and verified on `main`:

| milestone | version | what it gave 2e |
|---|---|---|
| 2b / 2b follow-up | 0.2.2 / 0.2.3 | `lib/hermes-transport.js` split; `this.transports = { hermes, claude }`; `transportFor(j)` routes by `j.agent` |
| 2c (`a1c11c5`) | 0.2.4 | `lib/claude-transport.js` (spawn/stream/stop); `lib/claude-stream.js` (translator); `tools/stub-claude.mjs`; `tools/verify-claude-spawn.mjs`, `tools/verify-claude-transport.mjs`, `tools/fixtures/claude-stream-basic.jsonl` |
| 2d (`3d6adc2`) | 0.2.5 | `--resume` replies; steer as a stdin `user` line; `tools/verify-claude-reply.mjs` |

Offline checks on `main` (run via `git archive origin/main`, not in a worktree): `verify-claude-transport`,
`verify-claude-spawn`, `verify-claude-reply` all pass.

What 2c/2d deliberately left for 2e (grep for these on `main`):

- `lib/claude-transport.js` header: `--permission-prompt-tool stdio` is **not** passed; "Approvals are 2e".
- `ClaudeTransport.approve()` and `clarify()` return `NOT_IN_2C(...)` (code `not_in_2c`).
- Translator (`lib/claude-stream.js`): a `control_request` of any subtype returns
  `{ event: "claude.unparsed", text: "control_request <subtype> (not handled in this build)", control: obj }`.
  The transport prints it as a raw card line. Nothing answers it.
- `finish()` prints "(approvals are not wired for Claude jobs yet)" next to the denied-count.

## 2. What the Claude side does and does not look like (facts)

Proven live in the 2a spike (`tools/spike-claude-stream.mjs`, scenario `approval`, haiku):

- Spawn args must include `--session-id <uuid>` (or `--resume` in a reply), `--permission-mode default`,
  and `--permission-prompt-tool stdio`. With the flag, a tool needing permission sends a request on stdout
  and waits for an answer on stdin. Without it, the tool is auto-denied and the run goes on.
- The host must send `control_request` `initialize` first, as the SDK does (`initializeRequest()` in the translator).
- The request arrives as:
  `{"type":"control_request","request_id":"<id>","request":{"subtype":"can_use_tool","tool_name":"Write","input":{...},"tool_use_id":"...","permission_suggestions":[...]}}`
- **Allow once, proven**: write to stdin
  `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow","updatedInput":<original input>}}}`
  The file was written and the turn finished.

**Not proven. Verify live before coding (section 4, step 1):**

- **deny** — expected `{"behavior":"deny","message":"..."}` inside the same envelope. Unknown whether the
  message is required and what the agent says afterwards.
- **allow for the session** — expected `{"behavior":"allow","updatedInput":...,"updatedPermissions":[...]}`, with
  `updatedPermissions` copied from the chosen `permission_suggestions` entry. The suggestion's exact shape is
  also unrecorded. Do not guess it.
- Whether `permission_suggestions` is empty for some tools (then `session` must not be offered).
- What a steer does while a permission request is parked (the CLI is blocked on stdin, not at a tool boundary).

## 3. What the panel already has that 2e reuses (on `main`)

- `Jobs.approve(id, choice, requestId)` (`lib/jobs.js`): checks `j.approval.choices`, the deadline, then calls
  `transportFor(j).approve(j, pick, requestId)`. Nothing to change there for Claude.
- `Jobs.consume` handles `approval.request` (reads `request_id`, `command`, `choices`, `timeout_seconds`,
  `timestamp`; sets `j.approval` with a deadline and the window from `approvalWindowSeconds()`). The translator
  just has to emit that event shape.
- `approval.responded` in `consume` sets `j.approvalDone` and clears `j.approval`. Emit it from the Claude transport
  after the answer is written; do not write the UI state yourself.
- `Jobs.sweepApprovals` / `expireApproval`: removes the card's box at the deadline and records `approvalDone` with
  `expired: true`. **It does not tell the transport.** See section 4 step 3.
- Front end: `public/app.js` already draws `choices` (`once`/`session`/`always`/`deny`) and the collapsed
  "approved once" line from `approvalDone`. Do not change the UI in 2e.

## 4. The work, in order

### Step 1 — verify the unproven shapes live (before any code)
- Extend `tools/spike-claude-stream.mjs` with scenarios `deny` and `session`. Same haiku, `--max-budget-usd 0.10`,
  a throwaway git repo (`mkdir` under `C:/Users/james/AppData/Local/Temp/...`, `git init`).
  - `deny`: answer with the deny shape; the prompt asks for a file write; expect the file absent and the agent
    saying so.
  - `session`: answer with allow-for-session using the first `permission_suggestions` entry copied into
    `updatedPermissions`; expect a second write in the same session to go without a prompt.
- Run each once. Record the exact request and the accepted response in `docs/claude-phase2-handoff.md`
  (a "2e shapes" section). Spend is a few cents per run; log it.
- If `session` is refused by the CLI, drop it from `choices` and say so in the PR. Do not send a guessed shape.

### Step 2 — translator (`lib/claude-stream.js`)
- `control_request` with `subtype === "can_use_tool"` → `{ event: "approval.request", request_id, command, choices,
  timestamp, timeout_seconds?, tool_use_id, tool_name, input, permission_suggestions }`.
  - `command`: a readable rendering, e.g. `Write · <file_path>` (reuse `previewFor(name, input)`).
  - `choices`: `["once","deny"]`, plus `"session"` only when `permission_suggestions` is non-empty and the step-1
    session shape is proven.
  - `timestamp`: epoch **seconds** (Jobs multiplies by 1000). Use the arrival time.
  - Keep `control` (the raw object) on the event so the transport can answer it.
- Other `control_request` subtypes stay `claude.unparsed`.
- Extend `tools/verify-claude-transport.mjs` with the new translation (no network).

### Step 3 — transport (`lib/claude-transport.js`)
- Add `"--permission-prompt-tool", "stdio"` to the spawn args, always (the 2c "not passed" rule is lifted in 2e).
  Keep `--permission-mode` as it is (`bypassPermissions` only for `yolo`). Add a comment saying why the flag now
  matters.
- Keep `p.pending = Map<request_id, { toolUseId, input, suggestions, timer }>`, filled from `onLine` when the
  translator emits `approval.request`. Then `jobs.consume(j, evt)` so the card shows the box.
- `approve(j, choice, requestId)`:
  - Find the pending request (by `requestId`, or the single pending one). Missing → `{ ok:false, gone:true,
    code:"approval_expired" }` in the same shape `Jobs` expects.
  - `once` → allow with `updatedInput: input`. `session` → allow with `updatedInput` and `updatedPermissions`
    copied from the chosen suggestion. `deny` → deny with a short message.
  - Write the `control_response` with `this.write(p, …)`. If the write fails, return an error; do not emit
    `approval.responded`.
  - On success: delete from `p.pending`, clear its timer, emit `consume(j, { event:"approval.responded", choice, ... })`,
    and return `{ ok:true, choice, resolved:null }`.
- **Never auto-allow.** Nothing in 2e answers a request except the reader's `approve` call or the deny paths below.
- **Fail closed on expiry.** Each pending request gets a timer at its `deadline` (from `j.approval.deadline` or the
  window). When it fires, write a deny, remove the request, and let `Jobs.expireApproval` do the UI. Without this
  the CLI waits forever on a request the panel no longer shows.
- **Stop** (`stop(j)`): deny all pending requests (write deny for each) before the interrupt. The plan requires it.
- **Process exit** with pending requests: clear the timers, drop them. Nothing to answer; the process is gone.
- `steer` while a request is parked: check live (step 1). Until proven, keep the 2d behaviour (refuse with
  `run_not_accepting_steer` when `p.pending.size > 0`) and say so in the PR.
- `clarify`: stays `not_in_2c`. Not part of 2e.

### Step 4 — stub and offline test
- `tools/stub-claude.mjs`: add mode `approval`. Write one `control_request` with `can_use_tool` (tool `Write`,
  a `file_path` and `content`), wait for a `control_response` on stdin, then:
  - allow → write the tool_result, then a `result` saying the file was written; exit 0 on stdin close;
  - deny → write a `result` with text that says the file was not written; exit 0 on stdin close.
  - Record the received response in `STUB_CLAUDE_LOG` (the shape is what the test asserts).
- New `tools/verify-claude-approval.mjs` (offline) covering: the request becomes an `approval.request` with
  `choices` as specified; `approve once` writes the exact allow shape and the card gets `approval.responded`;
  `deny` writes the deny shape; `session` only when offered; an answer after expiry is refused with
  `approval_expired`; the deadline writes a deny with no reader action; stop denies pending requests and ends
  `cancelled`; an unknown `request_id` is refused; no request is answered without a reader action.
- Keep `verify-claude-transport`, `verify-claude-spawn`, `verify-claude-reply` passing unchanged.

### Step 5 — live check (sandbox panel, small, billed)
- Throwaway git repo, sandbox panel on a free port with `PANEL_CONFIG=<file>` (see `SETUP.md`, "A sandbox").
  `claudeBudgetUsd: 0.10`.
- Prompt: write a file named `approved.txt` with the word `APPROVAL-TEST`, then reply `DONE`.
  - Card shows an approval box with allow/deny → allow → file exists, reply `DONE`.
  - Repeat with deny → file absent, the agent says so.
  - Reload the page: the collapsed "approved once" line is still there (from `approvalDone`).
- Hermes `PONG` agent on the same panel must still complete.
- Record the Claude spend. Kill the sandbox panel by PID when done.

### Step 6 — docs and version
- `docs/claude-phase2-handoff.md`: 2e row ticked, "2e shapes" section (step 1), deviations, the live check.
- Version per section 0 (after the decision). Code changed (`lib/`, `server.js` if touched) → bump; `tools/` and
  `docs/` alone do not bump.
- `node --check` on every touched JS file; `node tools/verify-version-bump.mjs --base origin/main` passes.

## 5. Done when

- A haiku run that writes a file parks on the card with allow/deny. Allow writes the file. Deny leaves it unwritten
  and the agent says so. The collapsed line survives a reload.
- No request is ever answered without the reader (or the deadline's deny).
- Stop denies pending requests and ends `cancelled`.
- Offline verify scripts pass; one Hermes `PONG` completes; version check passes.

## 6. Traps

- `--permission-prompt-tool stdio` without a responder hangs the job. Adding the flag and the answer path must be one
  change; do not ship the flag alone.
- `Jobs.expireApproval` does not notify the transport; the transport's own deadline timer is what prevents the hang.
- `approval.request` needs `request_id` for `approve` to find the pending request. Missing it breaks the approve path.
- `permission_suggestions` may be empty; a `session` button with no suggestion has nothing to write.
- Do not pass `yolo`-style bypass as a fallback for a failed approval.
- The 2a spike's `steer` scenario uses `--permission-mode acceptEdits`; 2e uses `default`. Do not mix them.
- Windows: `taskkill /T /F` for a stuck process; do not use `shell: true`.
- The translator's `control` field carries the raw request. Do not print it to the card.

## 7. Files

- `lib/claude-stream.js` (translator; `control_request` branch)
- `lib/claude-transport.js` (spawn args, pending map, approve/stop/expiry)
- `lib/jobs.js` (no change expected; `approve`, `consume`, `expireApproval` already exist)
- `tools/stub-claude.mjs` (mode `approval`)
- `tools/spike-claude-stream.mjs` (scenarios `deny`, `session`)
- `tools/verify-claude-approval.mjs` (new)
- `docs/claude-phase2-handoff.md` (2e shapes section, status)
- `docs/2e_handoff.md` (this file)
