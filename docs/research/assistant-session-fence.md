# The assistant session fence

**Status:** research note, landed as one doc set. Two things are measured and reproduced below: the
`unknown` run status the panel has no word for (§5), and the revived-flag mismatch that makes the
panel word a fence wrongly (§6). The endpoint-by-endpoint measurement of the call that lifts the
fence is in [`gateway-fence-endpoints.md`](gateway-fence-endpoints.md) — that file is the raw request
evidence, this one is the account.

Scope: the panel's `lib/jobs.js` at `main` (`c341613`, unchanged since `f19b615`) — lines 75, 125,
162, 174, 2380-2660, 2750-2800, 3220-3235, 3539-3574, 4134-4252 — and the session-authority gateway
at `%LOCALAPPDATA%\hermes\hermes-agent` @ `bf0203a794`. Nothing here is a change to the panel.

A **fence** here is the value the session-authority gateway checks before it will read a control call
or claim a queued turn. It is not authentication: the caller is already trusted. It is the gateway's
way of asking *which turn of which session* a stop, an approval, a clarify answer or a steer is
about, so that a control aimed at a turn that has already moved on is refused instead of landing on
its successor.

There are three fences, and they are not interchangeable:

1. **Admission — on the session.** `session_api_turn.py` refuses an API turn in a session whose
   source is not `api_server`/`bot_room`; the wire answer is 409 `permission_denied`. This happens
   before a run id exists. A revived CLI session is exactly this case.
2. **Control — on the run.** Steer, stop, approval and clarify address `runId` in the path, and an
   approval/clarify body also carries that run's `execution_generation`. The generation is the
   actual fence; the run id is only the address.
3. **Panel bookkeeping — on the job.** A job with no `runId` is not steerable or stoppable; a job
   whose status is not live is refused before any round trip (`steerable`, 3791+). The assistant
   adds one more: its own runs are marked `assistant: true` (2405) and recognised by thread
   (`isOwnRun`, `lib/assistant.js:3112`), so a settle on the assistant's own turn never wakes the
   assistant into another turn.

The finding is in fences 1 and 3: the gateway gates a session on a status the panel has no word for
and no call to lift, and the panel words the admission refusal from a flag its posting card does not
carry. The panel can post, be refused, and in the `unknown` case keep posting forever — with nothing
on the card naming either reason.

## 1. Two identities, one turn

A panel turn is one row in `jobs.json` and one HTTP request. Those two things have different names:

- **`j.id`** — eight hex characters from `randomUUID()`, created at `lib/jobs.js:2397`. It is the
  panel's handle: routes take it (`/api/jobs/steer`), logs print it, and `stop(j.id)` accepts it at
  line 2801. It is never serialized into a gateway request.
- **`j.thread` / `j.sessionId`** — the Hermes session. It is chosen once per conversation
  (`opts.thread || makeThreadName(prompt)`, line 2380), copied to `sessionId` at 2433, and sent as
  the `session_id` field of the POST body at 2630. Every later turn on the card carries the same
  string.
- **`j.runId`** — the gateway's handle on one execution. It does not exist until the POST is answered
  (2766-2767). A reply is a *new* run on the *same* session.

So a card with three turns is one `thread`, three `id`s, and three `runId`s. Nothing in the registry
promotes a run id to a session id or the reverse; the two are joined only by the job record that
carries both.

## 2. Control flow of one panel turn, in order

**2.1 The request is built from the session, not from a run** (`create()`, 2378-2660). `create()`
picks the thread, counts the existing jobs on it (`siblings`, 2381) to number the turn, and posts:

```js
const body = { input: ..., session_id: thread, cwd };   // 2630
```

`model`, `model_options`, `max_turns` and `run_budget` may ride along; no run id ever does. The POST
is logged on the card as `POST <url>/v1/runs · session <thread> · cwd <cwd>` (2645), which is the
first place a reader can see that the body is session-scoped. The gateway admits the input durably
and answers with a run id (`run_…`).

**2.2 One POST, held on backpressure only** (2663-2698). A 429 means "no concurrent slot", so the
same request is re-sent after a delay (the 429 loop at 2699-2740); every other status is a verdict on
the first try. The loop is deliberately not a retry of a turn: `held` is one job, one thread, one
turn and one POST in flight.

**2.3 A refusal before a run exists** (2750-2764). A non-OK response is worded here. The 429 case
says how long it held. Everything else goes through:

```js
runRefusal(res.status, detail, { thread, revived: Boolean(j.revived) })
```

Both arguments are **session** facts: the thread, and whether this job was revived from the CLI.
There is no `runId` to pass, because the gateway refused the request that would have created one.

**2.4 The run id enters** (2766-2767). `accepted.run_id` is read once. If it is missing, the turn
fails with "gateway accepted the request but returned no run_id" (2776-2783); a created job with no
run is a card with nothing to watch.

**2.5 The process stamp** (2768-2775). With a run id in hand, the panel records the gateway's pid and
start time from `gatewayIdentity()`. A run lives in one gateway process's memory, so this pair is
what `stopStaleRuns` uses later to decide whether the gateway that owns this run is still the gateway
that is running.

**2.6 Running, and what "output" means** (2784-2791). The card is set `running`; the init line prints
both names (`run <runId> · session <thread> · turn <n> · cwd <cwd>`). Then:

```js
j.baseOutput = this.sessionOutput(j.thread);
```

Usage is read from the **session** (`state.db`, `sessionUsage`), and those counters are cumulative.
The job records where they stood, so the card can subtract the baseline and show *this turn's*
tokens. The 4-second stats timer reads the same session id.

**2.7 The wall-clock cap** (2793-2803). A `setTimeout` for `maxRuntimeSeconds` calls
`terminate(j, "cap")` and `stop(j.id)`. The id handed to `stop` is the panel job id;
`stopRunAtGateway` (3539) resolves `j.runId` and only then builds `POST /v1/runs/<runId>/stop`. If
there is no run id, it journals a skip rather than pretending a stop went out.

**2.8 The poll backstop** (2805-2806). Every 15 seconds `poll(j)` calls `GET /v1/runs/{j.runId}`
(3220). That response is also where `execution_generation` is learned (3229-3232), and it is the
only place a stream that never opened can still settle the card.

**2.9 The stream** (2808-2818). `probe()` asks `/v1/capabilities`; if the gateway advertises no
`run_events_sse`, the card stays on polling and says so. Otherwise `follow(j)` starts a resumable SSE
loop. `streamOnce` (2860) opens `GET /v1/runs/{j.runId}/events` and sends `Last-Event-ID: <j.lastSeq>`
when it already has a sequence number. That header is a **sequence**, not an identity: it says "resume
after this event", not "this is my run".

**2.10 Settle and restart** (3344, 3220-3235, 823-900). A terminal event settles the card
(`lib/completion.js:outcomeFrom`) and the store is written (`schedulePersist`). On boot, `loadStore`
reads the store, every card that was live comes back `interrupted`, and `reconcileRestored` asks
`GET /v1/runs/{run_id}` and either adopts the terminal run, re-attaches to a live one, or writes it
off as gone.

## 3. Which id each call carries

Verified against the requests in the first reproduction (§7):

| operation | path / body | identity |
|---|---|---|
| start a turn | `POST /v1/runs`, body `{input, session_id: thread, cwd, ...}` | **session** |
| get status, generation, pending controls | `GET /v1/runs/{runId}` | **run** |
| subscribe / resume events | `GET /v1/runs/{runId}/events`, `Last-Event-ID: seq` | **run** (+ seq) |
| steer | `POST /v1/runs/{runId}/steer`, body `{input}` | **run** |
| stop | `POST /v1/runs/{runId}/stop` | **run** |
| answer an approval | `POST /v1/runs/{runId}/approval`, body `{request_id, execution_generation, choice}` | **run + control** |
| answer a clarify | `POST /v1/runs/{runId}/clarify`, body `{request_id, execution_generation, answer}` | **run + control** |
| lift an unknown admission | `POST /v1/runs/{runId}/resolve-unknown`, body `{admission_id, execution_generation}` | **run + admission** |
| usage, titles, labels, turn count, siblings | local calls keyed by `thread` | **session** |
| panel routes | `/api/jobs/steer` etc. take `j.id`; resolved to `runId` inside `Jobs` | **panel job** |

The same identities, by who mints them:

| id | who mints it | where it appears | what it fences |
| --- | --- | --- | --- |
| panel job id (`j.id`) | the panel | the store, the UI, the card's URL | nothing at the gateway — it never crosses the wire |
| thread / `session_id` | the panel names it; the gateway names it back | `POST /v1/runs` body only | the conversation (the FIFO lane) |
| run id (`run_…`) | the gateway, on admission | the path of every run-scoped call | which run |
| admission id | the gateway, on durable admission | `resolve-unknown` body | which queued input |
| `execution_generation` | the gateway, per run | every control body | whether the turn is still the turn the caller thinks |
| `request_id` / `prompt_id` | the gateway, per parked control | `approval` / `clarify` body | which parked prompt |

Two facts about the table are load-bearing and easy to miss:

- **The run id is the admission's `request_id`.** `run_admission()` looks a run up by `request_id`
  (or by `admission_id` for a streaming alias), so the run id and the admission id are two names for
  one row in `session_admissions` (`api_server_authority_runs.py:52-66`). Neither is the fence.
- **Only the generation is checked against the row.** `respond_run` refuses a body that is not
  exactly the three keys, and refuses a generation that is not the row's current one, as
  `invalid_params` / `stale_generation`. The panel heals that by re-reading the run and retrying
  once (lib/jobs.js:3900-3975).

`execution_generation` is the third fence. It belongs to the run, not the session; the gateway
rejects an approval/clarify body without it as `invalid_params`, and the panel learns it from the
run's own status or `pending_controls` (`controlContext`, 3876-3910).

The fences are not interchangeable. A run id cannot answer "which conversation is this", and a
session id cannot answer "which execution do I stop".

## 4. The status the panel has no word for: `unknown`

`run_projection()` maps the admission's status to the run's:

```
'queued': 'queued', 'started': 'running', 'unknown': 'unknown', 'terminal': row['outcome']
```

with the comment that says why it is not folded into `interrupted`: *"`unknown` is not terminal:
later turns wait for POST /v1/runs/{id}/resolve-unknown, and `interrupted` is in
TERMINAL_STATUSES, so a poller would stop at a paused head"*
(`api_server_authority_runs.py:66-97`).

An `unknown` row is created when a gateway lost ownership of a turn it had started — its owner epoch
died with the process, and the store cannot say whether the turn ran. From then on:

- **The session's FIFO is paused.** The store refuses to claim the head while any row for the
  session is `started` or `unknown`, and raises `unknown_execution` on an `unknown` one
  (`hermes_state_runtime.py:211-213`). The authority wraps that as `unknown_execution`
  (`session_authority.py:1005-1012`) and calls `self._pause(ref, 'unknown_execution')`
  (`:1105-1120`), which `_claim_with_retry` catches. Turns admitted after the unknown head stay
  `queued` and are never claimed. They are accepted, not refused.
- **Stop cannot clear it.** `stop_run` on an `unknown` row raises `unknown_execution`
  (`api_server_authority_runs.py:146-166`), which `store_error_response` maps to HTTP 409 (the
  `_STORE_ERROR_STATUS` default, `:18-34`).
- **Only one call lifts it**, and it must carry exactly the pair: `POST
  /v1/runs/{run_id}/resolve-unknown` with `{admission_id, execution_generation}`
  (`api_server_authority_runs.py:169-190`), resolved in the store by
  `resolve_unknown_session_input` (`hermes_state_runtime.py:651-690`). A mismatched admission is
  `not_found`; a mismatched generation is `stale_generation`. The exact measured bodies are in §6.
- **The gateway tells a chat user to send `/discard`** (`session_ingress.py:200-206`), which is the
  same resolution through the chat surface. An API client has no `/discard`; the counterpart it must
  use is the resolve-unknown call.

The reason the pause survives a restart is that it is a **store** read, not in-memory state: no
session object has to be rebuilt for the fence to hold. That is also why a fresh `POST /v1/runs` is
accepted and then fails — the input is durably admitted and the claim is what refuses.

### The panel's half: no word, no call

- `TERMINAL_RUN` is `completed, failed, cancelled, interrupted` (lib/jobs.js:125);
  `TERMINAL_STATUS` maps the same four (lib/jobs.js:162); `LIVE_JOB_STATUS` is `running, starting,
  waiting` (lib/jobs.js:174). **`unknown` is in none of them.**
- `poll()` fetches the status, records `execution_generation`, and settles only on
  `TERMINAL_RUN.has(run.status)` (lib/jobs.js:3220-3235). A run the gateway answers `unknown` is
  therefore read, discarded, and polled again 15 seconds later, forever.
- The panel never calls `resolve-unknown` and has no `/discard`: zero hits in `lib/`, `public/` and
  `server.js` for either.
- A stop on an unknown run gets HTTP 409, and `stopRunAtGateway` treats **409 as success** —
  `entry.ok = true; entry.already = true` — so the journal says *"stop sent — HTTP 409 — already
  gone"* for a run that is not gone (lib/jobs.js:3539-3574). The gateway's body code is
  `unknown_execution`; the panel does not read it.
- The store keeps `runId` but neither `executionGeneration` nor `admissionId` (the persist list,
  lib/jobs.js:823-895), and prunes to `KEEP_JOBS = 80` by `startedAt` with no exemption for a live
  admission (lib/jobs.js:75, 828-830).

So the asymmetry is exact: the gateway's fence survives its own restart in the durable store, and
the panel's knowledge of it does not survive the panel's.

### What this box's store said

Driven against the gateway store on this machine
(`%LOCALAPPDATA%\hermes\state.db`, 2026-11-04):

```
session_admissions by status: terminal 5864, queued 6, started 5, unknown 19

19 sessions have an unknown row.
 4 of those also have a queued row — a turn parked behind the fence:
   wtgui-land-every-piece-of-unlanded-d7a12d   unknown seq 1720, queued seq 1773
   wtgui-create-a-new-option-on-the-w-4b5067   unknown seq 2452, queued seq 2456, 2457
   panel-assistant-3                           unknown seq 5851, queued seq 5886
   probe-fence-30894de6-c...                   unknown seq 5887, queued seq 5899, 5900
```

The `probe-fence` session is the cleanest specimen: one turn was lost at generation 1, and the two
turns submitted after it — both literally *"Reply with the single word OK. Do not use tools."* — were
still `queued` and had never been claimed.

A re-read after the endpoint measurement in §6 resolved that specimen (`resolve-unknown` on
`probe-fence`, row 11 of `gateway-fence-endpoints.md`) shows the count moving exactly as the model
predicts: **18 sessions** with an unknown row, and **3** of those with a queued row — `probe-fence`
left the set because the call was made, not because anything else changed. The four names above are
the measurement as taken; the re-read is the same table 40 minutes later.

And the panel has no card for any of them: the store holds 80 jobs (its cap), and every one of the
19 fenced sessions is absent from it. The panel cannot see the fence, cannot lift it, and cannot name
the session it is holding.

## 5. The mismatch: a session fact stored on a card that cannot post

`runRefusal` (`lib/jobs/console-lines.js:221`) has two sentences:

- `revived: true` → "this session is the CLI's … Continue it in a terminal: `hermes --resume <thread>`"
- otherwise  → "… it will not write into a session owned by another surface. Continue that session
  where it lives, or start a new panel session."

The flag it branches on, `j.revived`, is set in exactly one place: `revive()` (4250). A revived card
is created `done`, with `runId: null` (4206-4252). It cannot post. The turn that *does* post is a
**new job** made by `create()`, and `create()` never copies `revived` from the thread's first job:

- `create()` builds `j` at 2396-2463 and has no `revived` field;
- `firstOfThread(thread)` (4134) is the record that holds it — the reply path already uses that
  helper for `cwd`, `model` and ownership (2169, 3643), but not here;
- so `Boolean(j.revived)` is `false` on every reply, including the first reply to a revived CLI
  session.

**Consequence:** the specific, actionable sentence is unreachable for the only turn that can hit the
fence. The reader who revives a CLI session and replies gets the generic "start a new panel session"
advice, even though the panel is holding `revived: true` three lines away on the same thread. For an
assistant the advice is worse than generic: an assistant's pane is bound to `rec.threadId`
(`lib/assistant.js:3740`), so "start a new panel session" is not a thing the reader can do without
losing the assistant's identity.

Two smaller breaks in the same diagnostic path:

- `readDetail` (2666-2671) keeps only `error.message` (or the raw text). If a gateway puts
  `permission_denied` in `error.code` and a plain message, `runRefusal`'s `/permission_denied/` test
  never fires and the panel falls back to "gateway refused the run (HTTP 409): <message>". The
  translation is keyed on prose, not on the code.
- The revive card's `thread` is the session id, and `runRefusal`'s CLI sentence embeds it — correct —
  but nothing checks that the *posting* job and the revive card are the same conversation beyond the
  string. If the thread was renamed or re-homed, the sentence would name a session the reader did not
  revive.

## 6. The call that clears it

One call lifts the fence, and it takes the two values the status endpoint already returned. The
measured request (full row set and every response body in
[`gateway-fence-endpoints.md`](gateway-fence-endpoints.md), rows 1-16):

```http
POST /v1/runs/run_3ea61cf919c545ef84aa70d80ac5bae8/resolve-unknown
{"admission_id": "a1209a5fc2e246d5a456d0718d011ffd", "execution_generation": 1}
```

It answers **200** with a receipt rather than a projection (`profile_id` is elided — it is the
measuring box's profile directory; every other field is as returned):

```json
{"run_id": "run_3ea61cf919c545ef84aa70d80ac5bae8", "admission_id": "a1209a5fc2e246d5a456d0718d011ffd", "ref": {"profile_id": "<hermes profile>", "session_id": "probe-fence-30894de6-c"}, "sequence": 5887, "status": "terminal", "outcome": "interrupted", "authority_epoch": 19, "execution_generation": 1}
```

Both ids are required and they must belong together. The measured refusals:

| what was sent | answer |
|---|---|
| `{admission_id}` only | 400 `invalid_params` |
| the pair plus an extra key | 400 `invalid_params` |
| the pair with `execution_generation: 2` | 409 `stale_generation` |
| `{admission_id: "deadbeef", execution_generation: 1}` | 409 `not_found` |
| a run id that does not exist | 404 `run_not_found` |
| the **session** id in the run-id slot | 404 `run_not_found` |

So there is no session-keyed resolve on this route: the only way to name the admission is through
the run that owns it, and the body's `admission_id` is compared with that run's own.

What the 200 does, measured in `state.db`:

1. **It settles the lost turn without re-running it** — `outcome: interrupted`, not a requeue. A
   client that wanted that input resends it.
2. **It resumes the session's FIFO.** The rows already admitted behind the fence were drained and
   completed on their own (the queued run's later `GET` answered `status: completed`, `output: "OK"`,
   generation 2), the session's `runtime_generation` advanced 1 → 3, and a new `POST /v1/runs` was
   accepted and completed (generation 4, `output: "DONE"`). There is no separate "unpause" call:
   clearing the `unknown` row is the unpause, because the fence is that read.

Three reader-facing details worth carrying:

- The resolved run's **projection reads `status: "cancelled"`** (`GET /v1/runs/{id}`), not
  `interrupted` — `run_projection` maps a terminal `interrupted` outcome to `cancelled`, so the
  receipt is the only place the word `interrupted` appears. The output and usage the predecessor's
  seed produced (`FENCE-SEED-C`, 17012/8 tokens) stay on the record.
- The resolve is **idempotent on the exact body**: the same request again returns the identical 200
  receipt, not a 409. A client retrying a lost acknowledgement is not told it is stale.
- `POST /v1/runs` is asynchronous, so the caller sees **202 `started`** and the fence only in the
  run's later record; `POST /v1/runs/{id}/stop` is the synchronous way to see the 409
  `unknown_execution` body. `/api/sessions/{sid}/chat` does **not** map the refusal: the pause
  reaches the handler as an unhandled `RuntimeStoreError` and aiohttp answers its bare 500 page.

## 7. The reproductions, and what each proves

Both are plain `node` scripts. Neither needs a gateway, a Hermes session store, or a worktree; each
starts its own loopback stub and builds a real `Jobs` over a temp store.

### 7.1 The id map and the revived mismatch

`docs/research/assets/assistant-session-fence-repro.mjs` — one stub Runs API, one `Jobs`, two
threads: an ordinary thread with two turns, and a session revived from the CLI that is then replied
to (the stub answers `409 permission_denied` on that session).

```
$ node docs/research/assets/assistant-session-fence-repro.mjs
calls:
  POST /v1/runs  body.session_id=wtgui-ordinary-thread-0001
  GET /v1/capabilities
  GET /v1/runs/run_1/events
  POST /v1/runs  body.session_id=wtgui-ordinary-thread-0001
  GET /v1/runs/run_2/events
  POST /v1/runs/run_1/steer
  POST /v1/runs/run_1/stop
  POST /v1/runs  body.session_id=cli-owned-session-0001

A: thread=wtgui-ordinary-thread-0001 runs=run_1,run_2; steer/stop used run_1
B: revived card 4634ea4a has revived=true and runId=null
B: the reply card 745007af has revived=false and says:
   the gateway refused the turn (409 permission_denied): it will not write into a session owned by another surface. Continue that session where it lives, or start a new panel session.

B expected the CLI wording ("this session is the CLI's ... hermes --resume cli-owned-session-0001")
B got the generic wording: YES
```

(the two card ids are random per run; the wording is not)

It asserts: (1) two turns on one thread post the same `session_id` and receive different run ids;
(2) no POST body carries a run id; (3) steer and stop address the **first turn's** run id, and no
wire path contains the session id; (4) a card revived from the CLI has `revived: true` and
`runId: null`; (5) a reply on that same thread has `revived: false`, and the 409 it provokes produces
the generic sentence, not the `hermes --resume` one. The last line is the defect in §5.

### 7.2 The card the gateway answers `unknown`

`docs/research/assets/assistant-session-fence-unknown-repro.mjs` — a stub gateway that answers the
poll the way `run_projection` does for an `unknown` admission (`status: "unknown"`, plus the
`admission_id` / `execution_generation` pair that would lift it), and the panel's own `Jobs.poll()`
driven against it.

```
$ node docs/research/assets/assistant-session-fence-unknown-repro.mjs
after poll(status=unknown):
  card status      : running
  settle called     : false
  requests made     : [
  "GET /v1/runs/run_unknown"
]

the repair, driven by hand:
  POST resolve-unknown -> 200 {"run_id":"run_unknown","status":"terminal","outcome":"interrupted"}
  requests total      : 3
```

The poll asks once, learns `status: "unknown"` and the pair `admission_id` /
`execution_generation`, settles nothing, and makes no further call. The repair — the same GET's two
values posted to `resolve-unknown` — is accepted, and the stub answers terminal. `requests total: 3`
is the evidence that the panel's own path made one request and the hand-driven repair made two.

Both scripts clean up their stub, temp store and intervals in a `finally` block, so neither leaves a
listener or a file behind.

## 8. The shape of the fix (not built here)

The fence itself is right. The gateway cannot know whether a turn that ran under a dead owner
finished; making the caller say so is the correct design. What is missing is the panel's half of the
conversation — and the panel already holds both values it needs on any answer that names an unknown
run (the poll's status body, or the boot reconcile's probe):

- `POST /v1/runs/{run_id}/resolve-unknown` with exactly
  `{admission_id, execution_generation}` from that same body;
- settle the card on the receipt's outcome (`interrupted`) and say on the console that the turn was
  lost with its gateway, so the reader knows the answer is not coming rather than late;
- keep `stopRunAtGateway`'s 409 rule only for a 409 whose body is *not* `unknown_execution`, since
  that one is a refusal, not an ending.

Persisting `admission_id` and `execution_generation` is optional: the status body always carries
them, and the panel asks the status endpoint before any control call anyway. What cannot be optional
is the call.

For the admission fence, the cheap fix is to word the refusal from
`Boolean(j.revived || this.firstOfThread(thread)?.revived)`. That changes no admission behaviour and
needs no gateway read; it only makes the sentence match the session the panel already knows. It does
not answer whether a reply should be *allowed* to try again — it just stops the panel from
mis-describing why it failed.

Preflighting the session source from `state.db` before the POST is not worth it: the store is a cache
of the gateway's state, not the authority, so a stale row would turn a working turn into a disabled
control and the gateway would still be the one to decide. The honest default is to post and report,
which is what the code does.

For the assistant the remaining question is a product decision, not a bug fix: its thread id is
fixed in its record (`rec.threadId`), so a CLI-owned assistant session has no "start a new panel
session" path that preserves the assistant. Either (a) re-home the assistant to a fresh API-source
thread, accepting that the old conversation stays in the terminal, or (b) keep the thread and surface
the `hermes --resume` command as the only way to continue it. That needs the reader's answer, not a
default.

## 9. Still open

- **Is auto-resolving the panel's decision to make?** Resolving is an acknowledgement that the turn
  will not finish; it does not re-run, re-order or replay anything, and the gateway's own chat
  surface offers the same one-press resolution as `/discard`. That reads like a panel responsibility
  rather than a reader decision — but a card that silently declares a turn lost is also a card that
  hides a choice the reader might have made differently.
- **Should `KEEP_JOBS` exempt a session with an unknown head?** A card is the only surface that could
  offer the resolution, and the prune can remove it. The current cap has already removed all 19.
  Either the prune learns about fences, or resolution must work without a card at all — which the
  poll-based fix above does, since it needs only the run id the poll is already using.

## 10. What this does not claim

- The reproductions prove the **panel's** choice of ids, its refusal wording and its poll behaviour
  against a stub. They do not prove the real gateway's bodies; those are measured separately in
  `gateway-fence-endpoints.md`, one request per row.
- The store counts in §4 are a snapshot of this box on 2026-11-04, not a claim about any other
  machine, and the set moved when the probe was resolved by hand — both readings are given.
- No live gateway was contacted by either reproduction, and no panel behaviour was changed.
- The 429 hold path and the stream's resume behaviour are described from the code and the existing
  tests, not re-measured here.

## References

- Panel: `lib/jobs.js` @ `c341613` — 75, 125, 162, 174, 2380-2463, 2630, 2645, 2666-2671,
  2750-2800, 3220-3235, 3539-3574, 3791+, 3876-3975, 4134, 4206-4252.
  `lib/jobs/console-lines.js:221-227`; `lib/assistant.js:3112, 3740`.
- Gateway: `%LOCALAPPDATA%\hermes\hermes-agent` @ `bf0203a794` —
  `gateway/platforms/api_server_authority_runs.py` 18-34, 52-97, 146-190;
  `gateway/session_authority.py` 628-629, 1005-1012, 1105-1120; `gateway/session_ingress.py`
  200-206; `hermes_state_runtime.py` 211-213, 651-690.
