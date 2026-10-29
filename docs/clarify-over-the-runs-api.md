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
gateway's half is *code*, and the stock build installed here does not have it: there is no
`POST /v1/runs/{run_id}/clarify` and no clarify callback on an API run's agent, so the tool is offered
to the model and refuses at dispatch. No `hermes config set` can supply a route — but the missing half
is four edits, and this box carries them as a local patch
(`%LOCALAPPDATA%\hermes\patches\clarify-runs-api.patch`). Measured 2026-10-26 on a second
gateway: an agent's question parks the run, `clarify.request` arrives with its choices and prompt id,
the answer is posted to the route, and the turn ends holding it. The earlier conclusion — that this
needed an upstream install and could not be an edit — was wrong. `lib/clarify.js` still records what it
OBSERVES (a refusal on a run's stream means the build cannot deliver a question, a `clarify.request`
means it can), so a build without the patch keeps telling agents to ask in prose.

## The two gates, and which one is shut

| gate | decided by | state on this box |
| --- | --- | --- |
| 1. the tool is in the run's toolset | `platform_toolsets.api_server` in `<HERMES_HOME>/config.yaml` | **open** — the line is present and the tool is in the pinned schema |
| 2. the build can deliver a question | gateway source: a clarify callback on an API run's agent + `POST /v1/runs/{run_id}/clarify` | **open on this box since 2026-10-26** — neither exists in the stock 0.22.2 build; the local patch supplies both, and a gateway running it advertises `run_clarify_response` |

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

Upstream is not the only route to it: the local patch below gives this build the same contract, which is
what this box runs.

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

## What the reader has to do (a patch, then a restart)

The gateway change is code, and it does not have to be 1692 commits of upstream work: the contract the
panel already speaks is four edits, mirroring the approval plumbing that works on this build today.
The patch, its re-runnable generator and the proof live outside the repo:

```
%LOCALAPPDATA%\hermes\patches\clarify-runs-api.patch      patch -p1, applies to pristine 0.22.2 files
%LOCALAPPDATA%\hermes\patches\clarify-runs-api.apply.py   exact-anchor surgery; asserts every anchor
%LOCALAPPDATA%\hermes\patches\clarify-runs-api.demo.py    the end-to-end driver (second gateway, spare port)
%LOCALAPPDATA%\hermes\patches\clarify-runs-api.demo-patched.txt / -demo-unpatched.txt   both transcripts
```

What it changes, and why each piece is needed:

- `gateway/platforms/api_server_runs.py` — `_make_clarify_callback(run, *, _api_server)`: register a
  waiter in the shipped `tools/clarify_gateway.py`, park the run's status with `clarify=<prompt>`, publish
  `clarify.request`, block the agent thread on `wait_for_response`, publish `clarify.settled`.
  `_run_agent_sync(..., clarify_callback=None, ...)` sets `agent.clarify_callback` before
  `run_conversation` and clears it afterwards. `_handle_run_clarify` answers
  `POST /v1/runs/{run_id}/clarify` with the same fence as `/approval`. Plus the route row, `/clarify` →
  `"approve"` in `_room_permission_for`, `_run_clarify_prompts`, `_pending_controls_for()` and
  `pending_controls` on `GET /v1/runs/{id}`, and `clarify` in the `_set_run_status` persist/clear sets.
- `gateway/platforms/api_server.py` — `run_clarify_response` + `clarify_events` in
  `_STATIC_FEATURE_FLAGS`, `run_clarify` in `_CAPABILITY_ENDPOINTS`, **and the adapter binding
  `_handle_run_clarify = _run_route_delegate("_handle_run_clarify")`**. That binding is not optional:
  without it the route table raises `'APIServerAdapter' object has no attribute '_handle_run_clarify'` and
  the API server fails to start at all — the whole platform, not just the new route.
- `toolsets.py` — `hermes-api-server` no longer drops `clarify`, so a stock install offers the tool and the
  `platform_toolsets` line becomes belt-and-braces.

Apply it to BOTH copies (`hermes-agent/` — the checkout `gateway-service/Hermes_Gateway.cmd` puts on
`PYTHONPATH` — and `installs/*/environments/*/workspace/`), delete the stale
`__pycache__/api_server_runs*.pyc`, then restart the gateway: a running Python process keeps the modules it
loaded at boot, so nothing changes until it is restarted. There is no restart button in the page — the
assistant's `RESTART gateway` line, or `POST /api/restart {"target":"gateway","waitFor":"<thread>"}`,
which queues it until the asking turn has ended (a synchronous restart would kill the reply that asked for
it). `hermes update` installs a build with the contract too, and it is the heavier path: it bounces the
gateway and every run in flight dies with it.

The panel needs no restart — `public/**` is read from disk per request, and nothing under `lib/**` changed.

## Verifying this without a gateway

```bash
node tools/verify-clarify.mjs          # 30 checks, all offline, against a stub Runs API
node tools/check-gateway-clarify.mjs   # read-only: one GET, and with --probe one OPTIONS per route
```

`check-gateway-clarify.mjs` reads `features.run_clarify_response` first: a patched gateway answers
`VERDICT the clarify route is present` (exit 0) on one GET, and a stock one still reads ABSENT (exit 1).
Its `--probe` half is a cross-check only. Measured on this box, `OPTIONS` answers **403 for the clarify
route and for its own approval control** — an auth layer answers before the router — so the probe settles
nothing there, and the script now says exactly that instead of a bare "undecided".

`verify-clarify.mjs` drives the shipped `lib/clarify.js` and `lib/jobs.js` against a stub Runs API on
an ephemeral loopback port — no real gateway, no worker started — and checks the whole chain in
order: nothing claimed before anything is observed; a refusal on a run's stream flips the record and
says so on the card; the *next* run's body carries the instruction; a `clarify.request` on a later
run flips it back; and the hint then stops appearing. The positive control is in the same script, so
"the hint is gone" cannot be explained by the mechanism never running.
