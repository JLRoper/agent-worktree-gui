# Approvals from the panel

The panel can be the place where a flagged command gets approved or denied, instead of a
terminal prompt. Two halves:

- **Panel (this repo)** — `lib/approvals.js`, `GET/POST /api/approvals`,
  `POST /api/approvals/answer`, `GET /api/approvals/<id>`, and an **Approvals** section in the UI
  with the command, its description, the allowed choices and a countdown.
- **Hermes plugin** — `~/.hermes/plugins/worktree-panel/` registers an approval transport named
  `worktree-panel`: it presents the host's redacted request to the panel over HTTP and polls for the
  answer. It never decides anything; a timeout, an unreachable panel or a late answer is a denial.

Hermes owns the policy: the request carries `request_id` + `digest` that bind an answer to exactly
one request, `allowed_choices` that the panel may not widen, and the timeout.

## Enable

```
hermes plugins enable worktree-panel
hermes config set security.approval.transport worktree-panel
hermes config set security.approval.transport_fallback builtin   # panel down -> normal terminal prompt
hermes config set approvals.timeout 120                          # how long a card may sit unanswered
```

`transport_fallback: builtin` matters: if the panel is not running the plugin raises (it does not
answer "deny"), and the host falls back to the built-in prompt — so an interactive terminal still
asks you. Without the fallback, an unreachable panel would be treated as a transport failure and the
command would be refused.

## The Hermes patch this needs

Out of the box `hermes chat -q` resolves a flagged command from `approvals.single_query_mode`
(deny/approve) and **never** consults a transport — the code comment says so: a `-q` run "runs
without a user present to approve it". That is why the panel-spawned agents could not ask anything.
Two small additions to `tools/approval.py` (kept local; re-apply after `hermes update`):

1. `check_all_command_guards()` — in the `not is_cli and not is_gateway and not is_ask` branch,
   before the `_unattended_contexts()` loop: if the context is single-query **and**
   `security.approval.transport` is not `builtin`/`config-error`, detect the dangerous command and
   present it through `_present_with_selected_transport(...)`, mapping the result with
   `_transport_choice(...)`; `once`/`session`/`always` → `_persist_choice` + `_user_approved`,
   `deny` → `_record_denial` + `_denied(...)`.
2. `_run_approval_gate()` — the same block at the top of its unattended branch, so plugin-rule and
   file-write gates behave identically under `-q`.

With `transport: builtin` (the default) neither branch runs and behaviour is unchanged.

A backup of the unpatched file is at `tools/approval.py.orig-worktree-panel`; the patch is ~50 lines
across those two functions. `hermes update` replaces `tools/approval.py`, so re-apply after updating.

## Security

The Approvals UI is the authority to run a command. It is only reachable on loopback (the panel binds
`127.0.0.1`), and the write endpoints honour `token` if you set one. Every decision is logged by the
panel (`approval requested (id): command`) and by Hermes (`pre_approval_request` /
`post_approval_response` hooks). The panel's `--yolo` spawn checkbox bypasses all of this — the card
never appears for a yolo run, by design.
