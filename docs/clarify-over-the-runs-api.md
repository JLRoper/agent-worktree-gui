# An agent's question over the Runs API — what is missing, and where

Two investigations (threads `wtgui-find-out-why-the-board-assis-9f5ba2`, finished, and
`wtgui-why-can-i-not-use-the-clarif-5f1d89`, live) asked the same question from both ends: an
agent calls `clarify` and gets

```
Clarify tool is not available in this execution context.
```

That sentence is the tool's own, it is not a permission verdict, and it is not the panel refusing
anything. This file is the answer both investigations converged on, with the code that decides it,
the one thing that has to change, and what the panel does until it does.

**Short version.** The panel's half of the contract ships in this repo and is complete. The
gateway's half is *code*, and the build installed here does not have it: there is no
`POST /v1/runs/{run_id}/clarify` on this build and no clarify callback on an API run's agent, so the
tool is offered to the model and refuses at dispatch. No `hermes config set` can supply a route.
`lib/clarify.js` therefore records the refusal from the run's own stream and tells the next turn to
ask in prose, which is what the reader sees on the board today.

## The two gates, and which one is shut

| gate | decided by | state on this box |
| --- | --- | --- |
| 1. the tool is in the run's toolset | `platform_toolsets.api_server` in `<HERMES_HOME>/config.yaml` | **open** — the line is present and the tool is in the pinned schema |
| 2. the build can deliver a question | gateway source: a clarify callback on an API run's agent + `POST /v1/runs/{run_id}/clarify` | **shut** — neither exists in the installed build |

Gate 1 alone is a trap: it puts `clarify` in the schema, so the model calls it, and then gate 2
refuses every call. That is exactly the observed refusal, and it is why the panel's own docs used to
promise a box the gateway could not draw.

## What the installed build actually contains (read, not inferred)

Installed checkout: `C:/Users/Jacob/AppData/Local/hermes/hermes-agent`, `HEAD` = `d923a5eb48`
("Release 0.22.2"), which is the tree the gateway on `:8642` runs
(`gateway-service/Hermes_Gateway.cmd` sets `PYTHONPATH` at that directory and runs
`python -m hermes_cli.main gateway run`).

```
git show d923a5eb48:gateway/platforms/api_server.py | grep -c -i clarify        -> 0
grep -c -i clarify  gateway/platforms/api_server_runs.py                        -> 0
git ls-tree --name-only d923a5eb48 gateway/platforms/ | grep -i author          -> (nothing:
                                                                                    api_server_authority_runs.py does not exist)
```

Its Runs API route table — `gateway/platforms/api_server_runs.py:236-240` — has exactly one
interactive route, the approval:

```python
("POST", "/v1/runs", self._handle_runs), ("GET", "/v1/runs/{run_id}", self._handle_get_run),
("GET", "/v1/runs/{run_id}/events", self._handle_run_events),
("POST", "/v1/runs/{run_id}/approval", self._handle_run_approval),
("POST", "/v1/runs/{run_id}/steer", self._handle_steer_run),
("POST", "/v1/runs/{run_id}/stop", self._handle_stop_run)]
```

There is no `/v1/runs/{run_id}/clarify` anywhere in this build, so even a callback that *did* ask
would have no way to receive an answer.

The callback is the other half, and it explains the tool's wording. `tools/clarify_tool.py` returns
that message from one branch:

```python
_UNAVAILABLE = "Clarify tool is not available in this execution context."
…
    if callback is None:
        return tool_error(_UNAVAILABLE)
```

The callback is set by the turn runner — `gateway/run_turn_runner.py:1296` does
`agent.clarify_callback = self._clarify_callback_sync`, with the implementation at line 1348 — but
the Runs API does not go through a turn runner at all: `api_server_runs.py:825` says
`/v1/runs` "owns its agent lifecycle (no TurnRunner)". The agent `agent_init.py` builds defaults
that attribute to `None`, the Runs API path never rebinds it, and the tool refuses. That is the whole
mechanism, and it is a missing feature rather than a locked door.

## What upstream has (the build that fixes it)

Upstream `origin/main` (`22063fc099`, 1692 commits ahead of the installed `HEAD`) carries the
contract:

```
origin/main:gateway/platforms/api_server.py:4394   _handle_run_clarify = _run_route_delegate("_handle_run_clarify")
origin/main:gateway/platforms/api_server.py:4603   async def send_clarify(self, chat_id, question, choices,
                                                       clarify_id, session_key, metadata=None)
origin/main:gateway/platforms/api_server_runs.py:246   ("POST", "/v1/runs/{run_id}/clarify", self._handle_run_clarify)
origin/main:gateway/platforms/api_server_runs.py:1372  async def _handle_run_clarify(self, request, *, _api_server)
origin/main:gateway/platforms/api_server_authority_runs.py:100  async def send_clarify(adapter, *, chat_id, **kwargs)
origin/main:gateway/run_turn_runner.py:475         agent.clarify_callback = self._clarify_callback_sync
```

`send_clarify` publishes the prompt into the run's `pending_controls` and waits; the route resolves
it by kind (`respond_run(..., kind='clarify')`). The panel's client half already speaks exactly that
contract — `clarify.request` on the stream, ids from the run's `pending_controls[]`, the answer
posted to `POST /v1/runs/{id}/clarify` — so a gateway with those lines needs no panel change at all.

The commit that introduced the route is `f35358a60f` ("fix: resolve API prompts through canonical
pending controls", 2026-09-08): `+7` lines in `api_server.py`, `+26` in `api_server_runs.py`, `+44`
in `api_server_authority_runs.py`. One honest wrinkle: `git merge-base --is-ancestor f35358a60f
d923a5eb48` reports **yes**, while the shipped tree at `d923a5eb48` carries none of its lines and not
the new module. The lines were dropped somewhere between that commit and the release. The removal
could not be traced here — this checkout is a partial clone whose promisor remote was unreachable, so
`git log -S` on the deleted file cannot fetch the objects it needs. **Ancestry is not a guide for
this; the tree is.** Check a build by what it contains, which is what
`tools/check-gateway-clarify.mjs` does.

## What the panel does about it (this repo's half)

Shipped here, and all of it observable on the board:

- `lib/clarify.js` — records what the gateway has actually *proved*: a `clarify.request` event means
  the round trip works, the refusal text in a `clarify` tool result means it does not. An unknown
  build claims nothing. The record is keyed to the gateway version, so installing a build with the
  route clears it without a panel restart.
- `lib/jobs.js` —
  - `consume()` detects the refusal on the run's stream, writes one dim line on that turn's card
    ("this gateway build cannot deliver a clarify question…"), logs it once, and marks the job;
  - `create()` appends one sentence to the run's own input once the refusal has been observed: ask
    in prose and end the turn. This covers the board assistant's own turn and every worker alike —
    they post through this one body;
  - `previewRequest()` shows the same input in a dry run, so a preview is a preview;
  - `probe()`/`transportInfo()` carry `capabilities.clarify`, and the job summary carries
    `clarifyUnavailable` so it survives a restart.
- `lib/assistant.js` — journals the fact once (it owns the journal) and exposes `clarify` in its
  `state()`, so the page can say *why* agents ask in prose instead of drawing a box that can never
  appear.
- `public/app.js` and the question box are unchanged: when a `clarify.request` does arrive, the box
  works exactly as documented in the README.

So a question still reaches the reader on this build — as a prose question at the end of a turn,
which the board's `question` rule already escalates with the choices it can read. What is lost is the
*parked* question: the box, the choices as buttons, and the turn waiting for the answer.

## What the reader has to do (one command, and a restart)

The gateway change is an install, not an edit — 1692 commits of upstream work, not a one-line patch
this repo could carry:

```bash
hermes update          # installs a build with the Runs API clarify contract
node tools/check-gateway-clarify.mjs --probe   # 0 = the route is there, 1 = it is not
```

Two caveats, both real:

- **`hermes update` restarts the gateway.** Do it while the board is idle: an update bounces the
  gateway and every run in flight dies with it. (This is not hypothetical — a run on this box was
  killed mid-investigation by an update that was asked not to restart anything and restarted anyway.)
- **The panel needs a restart afterwards and the gateway does not.** `lib/**` is loaded at boot, so
  the new module and the new body composition only take effect once the panel is restarted:

      stop-background.cmd
      start-background.cmd

  The gateway reads `platform_toolsets` per run, so the config line needs no restart — but the
  *route* does need the new build, which the update installs.

Nothing in this repo has to change for the box to appear once the gateway has the route.

## Verifying this without a gateway

```bash
node tools/verify-clarify.mjs          # 30 checks, all offline, against a stub Runs API
node tools/check-gateway-clarify.mjs   # read-only: one GET, and with --probe one OPTIONS per route
```

`verify-clarify.mjs` drives the shipped `lib/clarify.js` and `lib/jobs.js` against a stub Runs API on
an ephemeral loopback port — no real gateway, no worker started — and checks the whole chain in
order: nothing claimed before anything is observed; a refusal on a run's stream flips the record and
says so on the card; the *next* run's body carries the instruction; a `clarify.request` on a later
run flips it back; and the hint then stops appearing. The positive control is in the same script, so
"the hint is gone" cannot be explained by the mechanism never running.
