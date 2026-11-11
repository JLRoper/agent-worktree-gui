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
gateway's half is *code*: a clarify callback on an API run's agent, and a route to answer the prompt
(`POST /v1/runs/{run_id}/clarify`). Which of the two a build has is a fact about the BUILD, and it is
not the same on every box:

- the **stock 0.22.2 build** carries neither. The tool is offered to the model and refuses at
  dispatch with the sentence above. No `hermes config set` can supply a route — but the missing half
  is four edits, and a box that needs it carries them as a local patch
  (`%LOCALAPPDATA%\hermes\patches\clarify-runs-api.patch`).
- the **build the gateway on this box runs** (measured 2026-11-05 — see "Measured on the gateway this
  panel runs" below) carries both. A real run parked on a question, the answer POSTed to the route
  returned `{"status": "resolved"}`, and the turn finished holding it. It still advertises **no**
  clarify feature in `/v1/capabilities`, which is why the panel probes the ROUTE rather than reading
  the flag.
- a build with the route and **no** callback is the trap: the endpoint answers, the tool still
  refuses. A refusal observed on a run's stream outranks a present route, and the panel goes back to
  the prose path.

`lib/clarify.js` therefore records what is PROVED — a `clarify.request` on a run's stream, the tool's
refusal, or the route's own answer to a probe — and the sentence a run's input carries is conditional
on it: call the tool and stay parked when the build can deliver a question, ask in prose and end the
turn when it cannot, say nothing at all when the build is unknown.

## The two gates, and which one is shut

| gate | decided by | state on this box |
| --- | --- | --- |
| 1. the tool is in the run's toolset | `platform_toolsets.api_server` in `<HERMES_HOME>/config.yaml` | **open** — the line is present and the tool is in the pinned schema |
| 2. the build can deliver a question | gateway source: a clarify callback on an API run's agent + `POST /v1/runs/{run_id}/clarify` | **open on this box since 2026-10-26** — neither exists in the stock 0.22.2 build; the local patch supplies both, and a gateway running it advertises `run_clarify_response` |

Gate 1 alone is a trap: it puts `clarify` in the schema, so the model calls it, and then gate 2
refuses every call. That is exactly the observed refusal, and it is why the panel's own docs used to
promise a box the gateway could not draw.

## Measured on the gateway this panel runs (2026-11-05)

Not inferred from a commit, and not from the capabilities flag — from the routes, with a real run. The
gateway was the one the panel is pointed at (`127.0.0.1:8642`), authenticated with its own key, and
every step below is a call the panel itself makes.

| step | what was sent | what came back |
| --- | --- | --- |
| is it advertised? | `GET /v1/capabilities` | 200, and **no** `clarify` key at all — the flag says nothing about this build |
| start a run | `POST /v1/runs` with an input that asks the agent to call `clarify` once | `202 {"run_id": "run_b75c…", "status": "started"}` |
| the question | `GET /v1/runs/{id}/events` | `tool.started clarify`, then `clarify.request` with `prompt_id: "baa5c75f8d"`, `execution_generation: 1`, the choices, and the question |
| answer it | `POST /v1/runs/{id}/clarify` with `{"request_id": "baa5c75f8d", "execution_generation": 1, "answer": "blue"}` | `200 {"run_id": …, "status": "resolved", "prompt_id": "baa5c75f8d"}` |
| the turn held it | `GET /v1/runs/{id}` | `{"status": "completed", "output": "The answer I was given was \"blue\"."}` |

Two facts from that transcript are worth keeping:

- **The body is exactly three fields.** `respond_run` refuses anything else with
  `400 invalid_params`: a POST carrying only `{"answer": …}` — which is what a hand-written probe is
  likely to send — is rejected even when the prompt id is right. The panel sends all three
  (`lib/jobs.js` `answerQuestion`, from the prompt's own `execution_generation`).
- **The route can be probed without starting anything.** POSTing `{}` to
  `/v1/runs/<a-made-up-id>/clarify` answers `404` with the gateway's own envelope —
  `{"error": {"message": "Run not found: …", "code": "run_not_found"}}` — while a path that is not a
  route answers `404: Not Found` as plain text. That difference is the whole probe, and it is what
  `lib/clarify.js` reads (`probeClarifyRoute`): one request, no run created, no prompt answered.

## Asking again, and one entry per question

A run parked on a question emits nothing at all, so a question nobody answers would otherwise sit on
the board looking exactly as it did an hour earlier. The panel re-asks on its own clock — the first
repeat an hour after the question parked, then once an hour (`CLARIFY_REASK_AFTER_MS` /
`CLARIFY_REASK_EVERY_MS`, `lib/assistant/config.js`) — and every surface keeps ONE entry:

- `Jobs.reaskQuestion` bumps `reasks` and `lastAskedAt` on the question record and writes one dim line
  on the card. Nothing is posted to the gateway: the run is still parked on that prompt, and posting
  the question again would be a second question.
- the alert is found by its existing key and edited in place (`asks`, `at`, `detail`), never re-fired
  — `fired()` would return `null` for an open key anyway, which is why the count lives on the record.
- `waitsOf` is keyed on the question's own `key` (`j.question.key`, written when the prompt arrived),
  so the room's message stays one message; the Element channel copies the count onto it and sends
  nothing.
- the page's HUMAN rotation keys a question on `(kind, turn, request id)`, and the count is not part
  of that key — so a re-ask updates the row the reader already has.

The reader-facing description is in `docs/using-the-board.md` ("A question nobody answers is asked
again — hourly, as one entry").

## What a stock build actually contains (read, not inferred)

The checkout read for this section is the 0.22.2 box this doc was first written against
(`<HERMES_HOME>/hermes-agent`, `HEAD` `d923a5eb48`, "Release 0.22.2"). The build the panel on THIS box
runs is a later tree that carries the route — measured above.

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

Upstream is not the only route to it: the local patch below gives a stock build the same contract.

## What the panel does about it (this repo's half)

Shipped here, and all of it observable on the board:

- `lib/clarify.js` — records what the gateway has actually *proved*, in two records that answer two
  different questions:
  - `available` — the ROUND TRIP: a `clarify.request` event means the callback is bound and the route
    answers; the refusal text in a `clarify` tool result means the callback is not.
  - `route` — the ENDPOINT, settled by `probeClarifyRoute`: one POST to
    `/v1/runs/<made-up id>/clarify`, whose `run_not_found` envelope means the route is there and
    whose bare 404 means it is not. It creates nothing and answers nothing.
  - `instruction()` is the conditional sentence a run's input carries: call the tool and stay parked
    when either proof says the build can deliver a question (and no refusal has been seen), ask in
    prose and end the turn when it cannot, and nothing at all when the build is unknown. A refusal
    outranks a present route, because an endpoint with no callback delivers nothing.
  - the record is keyed to the gateway version, so an upgrade clears both without a panel restart.
- `lib/jobs.js` —
  - `create()` proves the route *before* it composes the body (`proveClarifyRoute`, memoised for
    `CLARIFY_PROBE_MS` per gateway build), so the very first turn of a fresh build already carries the
    right sentence. This covers the board assistant's own turn and every worker alike — they post
    through this one body;
  - `consume()` detects the refusal on the run's stream, writes one dim line on that turn's card
    ("this gateway build cannot deliver a clarify question…"), logs it once, and marks the job;
  - `reaskQuestion()` bumps the count on a question nobody answered (see "Asking again" above);
  - `previewRequest()` shows the same input in a dry run, so a preview is a preview;
  - `probe()`/`transportInfo()` carry `capabilities.clarify` and the whole `clarify` record, and the
    job summary carries `clarifyUnavailable` so it survives a restart.
- `lib/assistant.js` — journals the fact once (it owns the journal), exposes `clarify` in its
  `state()`, re-asks a parked question on the hourly clock, and keeps the room's message count in
  step. The `question` rule's alert is the entry the reader answers from the assistant panel.
- `public/app.js` — the question box says how often the panel has asked again (`↻ asked again N×`),
  and the HUMAN rotation keys a question so a re-ask can never add a row.

So a question reaches the reader either way. On a build with the route it is the *parked* question —
the box, the choices as buttons, and the turn waiting for the answer. On a build without it, it is a
prose question at the end of a turn, which the board's `question` rule escalates with the choices it
can read, and the run has stopped by then: that is the difference the instruction exists to make.

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
node tools/verify-clarify.mjs          # 52 checks, all offline, against a stub Runs API
node tools/check-gateway-clarify.mjs   # read-only: one GET, and with --probe one OPTIONS per route
```

`check-gateway-clarify.mjs` reads `features.run_clarify_response` first: a gateway that advertises it
answers `VERDICT the clarify route is present` (exit 0) on one GET, and one that does not still reads
ABSENT (exit 1). Its `--probe` half is a cross-check only. Measured on this box, `OPTIONS` answers
**403 for the clarify route and for its own approval control** — an auth layer answers before the
router — so `--probe` settles nothing there, and the script says exactly that instead of a bare
"undecided". That is the limit of the READ-ONLY check: it can only read the flag, and the build
measured below has the route while advertising nothing. The panel's own probe is the one that asks
the route (`lib/clarify.js` `probeClarifyRoute`), and it is the answer the instruction uses.

`verify-clarify.mjs` drives the shipped `lib/clarify.js` and `lib/jobs.js` against a stub Runs API on
an ephemeral loopback port — no real gateway, no worker started — and checks the whole chain in
order: nothing claimed before anything is observed or probed; a probe settles the route and the very
first body carries the matching sentence; a refusal on a run's stream flips the record to prose and
says so on the card; a `clarify.request` on a later run flips it back; and a second panel instance
against the same stub WITH the route added tells its first run to call the tool instead. The positive
control is in the same script, so "the sentence is gone" cannot be explained by the mechanism never
running.

`node --test test/clarify-reask.test.js` is the other half: a real parked run (stub gateway, the
stream parsed by `lib/jobs.js`), the hour driven by a rewritten timestamp rather than a sleep, and the
assertions that the count rises on ONE alert and ONE wait while the key never moves.

## What the question can carry: `links`

A question often needs the reader to LOOK at something  -  the report it just wrote, the run page, the
screenshot. The card draws those as anchors rather than as text the reader copies out of the pane.

The field rides the same `clarify.request` envelope and is normalized once, by `lib/clarify-links.js`:

```
clarify(question: "The report at docs/reports/x.html is ready - should it ship?",
        choices: ["Ship it (Recommended)", "Hold"],
        links: [
          { label: "the report", path: "docs/reports/x.html" },   // a local file, absolute or tree-relative
          { label: "the run",    url: "https://example.test/run/7" }
        ])
```

What the normalizer guarantees, because the envelope is somebody else's:

- an ABSENT or unusable field is `[]`, and the card then draws no Links section at all  -  the plain-text
  card is exactly what it was;
- the target is read from `url`, `href`, `path`, `file` or `target`, so a shape change does not silently
  empty the section;
- only `http(s)` URLs are kept. `javascript:`, `data:` and the rest are DROPPED (not thrown), and the
  entries after them still draw;
- a `file:///C:/x/y.html` URL becomes the path `C:/x/y.html`  -  a worker that read these docs tends to
  send a file URL, and the opener wants a path;
- at most `MAX_LINKS` (8) survive.

The CARD (`public/app.js` `questionLinks`) reserves a block between the question text and the choices,
one anchor per link: class `tq-link`, the label as the anchor's text and the target under it. A URL
carries `data-open-url` (the page's `POST /api/open-url`); a file carries `data-open-file`
(`POST /api/open-file`). The block's head NAMES the browser a file link will open in, from
`GET /api/open-file`.

A bare URL or file path already sitting in the question TEXT is linked too (`linkifyCardText` in
`public/core/dom-format.js`), so a worker that knows nothing about the field still yields a clickable
card.

`POST /api/open-file` walks lib/open-url.js's ladder  -  the HKCU UrlAssociations default browser, then
`rundll32 url.dll,FileProtocolHandler`, then `explorer.exe`  -  and answers with the step that actually
started (`via`, `progId`, the `file:///` URL). It opens a file only inside an open project or this
panel's own checkout, refuses anything else with 403, and a missing file with 404  -  the same boundary a
deliverable passes through. Relative paths are resolved against each open project root in turn, which
is what a worker's tree-relative link needs.

Proof, end to end, on a real card: `npm run verify:clarify-card-links` (a stub gateway parks a real
worker run with a two-link question, the card is read and clicked, and the answer names the launcher);
unit half: `node --test test/clarify-links.test.js test/clarify-question-links.test.js`.
