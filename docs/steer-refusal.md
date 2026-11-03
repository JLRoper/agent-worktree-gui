# Steer refusals and "zombie" live rows

Design and evidence only: this branch changes no code. Everything below was read from the store the running panel
owns (`C:/Users/roper/.wag/state/jobs.json`), from its own log (`C:/Users/roper/.wag/logs/server.out.log`), from the
running gateway's API (pid 17340, `http://127.0.0.1:8642`), and from this tree's source at `d86ca81` (0.73.8, equal
to `origin/main` at the time of writing). The one probe that drives panel code is out-of-tree, at
`C:/Users/roper/AppData/Local/Temp/wag/dc9b2cdd/probe_approval.mjs`; its output is quoted in §1.6.

Measured clock: `2026-11-03T04:12:37Z` (store `savedAt 2026-11-03T04:12:37.314Z`). The panel process that owns this
store has been up since `03:39:39Z` (listening pid 62204, parent 36420).

Two claims in the brief did not survive measurement, and the correction is the substance of this document:

1. **755d3a97 was not a restart survivor.** It started at `03:48:47Z`, nine minutes *after* the last boot, and no
   `load()` → `reconcileRestored()` → `reattachRestored()` pass ever ran over it. It read `running` because it *was*
   running: the gateway held it at `waiting_for_approval` from `03:56:43Z` to `04:06:43Z`. It settled itself at
   `04:07:02Z`. Nothing about it was unsettleable.
2. **What was actually broken is narrower and worse:** the card drew a *Steer turn* button for a run the gateway could
   not accept a steer for, and drew *no approval box* for the approval that was holding it. Both come from one stale
   field: `approvalDone` from the turn's **first** approval survived into its **second**, and every predicate that
   reads it (`approvalPending`, `approvalPrompt`, the "awaiting approval" badges) then answers "nothing is parked"
   about a run that is parked.

---

## 1. Job 755d3a97: what actually happened

### 1.1 The row as the brief describes it

```json
{"id": "755d3a97", "thread": "panel-assistant-2", "assistant": true, "reply": true, "turn": 9,
 "status": "running", "startedAt": "2026-11-03T03:48:47.776Z", "endedAt": null,
 "runId": "run_6780fbfbc16e4c539aa38287c1f5e6b9", "lastSeq": 5, "sessionId": "panel-assistant-2"}
```

Every word of that is true of the persisted row, and two of the brief's inferences from it are not. `live` is not a
persisted field at all — `schedulePersist()` writes an explicit field list and `live` is not on it
(`lib/jobs.js:679-738`); the block is rebuilt per emit by `summary()` → `liveOf()` (`lib/jobs.js:939`, `948-962`). So
*no* row in `jobs.json` "carries a live block", live or dead. At `04:08Z` the running panel's `/api/jobs` answered for
this row:

```json
"live": {"events": 10, "seq": 9, "stream": "open", "streaming": false, "tool": null,
         "lastEventAt": 1793678817500}
```

The stream was open and the run was live. What the card did **not show** was an `approval` box, which is the block the
reader needed — `summary()` carried it, the renderer dropped it (§1.4).

### 1.2 The restarts, and why none of them is this row's parent

`lib/restart.js` records one restart at a time (`restart.json` holds the last: `96e4f646`, resumed
`03:39:47.341Z`), so the restarts have to be counted from the panel's own log. Since local midnight:

| local | restart id | what its resume reported |
|---|---|---|
| 01:45:22 | `8484883d` | proof turn only |
| 01:47:45 | `045d0b48` | proof turn only |
| 03:12:05 | `52fa4c3e` | re-attached 842d604e, 7d75bc6b, 1bcbdb48 |
| 03:13:58 | `bca57107` | re-attached c40f5631, 7d75bc6b |
| 03:39:05 | `518a7bcb` | re-attached aa24ec79, 5b480b31, af262976 |
| 03:39:37 | `96e4f646` | re-attached the same three |

Six restarts tonight (four after 03:00; the brief says three), and the last one *ended* at `03:39:41Z` with
`restored 80 job(s)`. Run 755d3a97 was created at `03:48:47Z` — 9 min 6 s later — so it was never in a `load()` set,
never stamped `restoredLive` (`lib/jobs.js:647`), never probed by `reconcileRestored()` (`lib/jobs.js:2774-2783`), and
never re-attached by `reattachRestored()` (`lib/jobs.js:2840-2868`). Its console carries no `⇢ the panel restarted …`
line because no restart touched it.

That matters for the repair: the three restart paths the brief points at are not the mechanism here, and a fix aimed
at them would not have touched this row.

### 1.3 The timeline the store itself carries

From the row's own `lines` (local clock in the store is UTC-5; times below are UTC):

| time | line |
|---|---|
| 03:48:47 | run created, `session panel-assistant-2`, `cwd .wag/state/assistant-cwd` |
| 03:48:58 | `💻 terminal · B=wtgui/playwright-round-1b-find-217c0d + 5 commands` |
| 03:48:59 | `⚠ approval requested: cd … && git log …` (approval **#1**) |
| 03:56:34 | `⇢ approval answered from the panel: session` |
| 03:56:41 | `💻 terminal · cmd //c "taskkill /F /PID 15920 …" + 5 commands` |
| 03:56:43 | `⚠ approval requested: cmd //c "taskkill …"` (approval **#2**) |
| 04:06:43 | `⇢ no answer within the gateway's 600s window — the gateway denied it and the agent carried on` |
| 04:07:00 | final text ("Round 1B finished …"), naming the kill it could not do |
| 04:07:02 | `run completed · tokens 1992569`; row `status: done`, `approvalDone.expired: true`, `waitedSeconds: 600` |

The screenshot attached to the brief is timestamped `04:03:57Z` — inside the second park, 2 min 46 s before the
window closed. The steer it shows being refused was refused because the run was parked, not because it was gone.

### 1.4 Why the row read `running`, `endedAt: null`, and no approval box

`running`/`endedAt: null` were correct: `create()` sets `status = "running"` (`lib/jobs.js:2322`) and `endedAt` is
written only on the way out — `settle` (`lib/jobs.js:2701`), `adoptRun` (`2912`), `markInterruptedByRestart` (`3027`,
where `lastSeenIso` stops the clock at the last line the panel saw), the create-path failures (`2072`, `2219`, `2275`,
`2297`, `2317`) and `load()`'s restart verdict (`644`). Nothing writes `endedAt` while a turn is going, which is why
`null` here means "no exit seen", not "nobody wrote one". The gateway's own run status at that moment was
`waiting_for_approval`, which Hermes sets when it emits `approval.request` (`hermes-agent/gateway/platforms/api_server.py:3724`,
`api_server_runs.py:965`); the panel's job status deliberately stays `running` through a park — the park lives in
`j.approval`, not in the status.

The approval box is drawn from `turn.approval` but suppressed when `turn.approvalDone` is truthy:

```js
// public/app.js:2871-2879
function approvalPrompt(turn, copy = "") {
  const approval = turn.approval;
  if (!approval) return "";
  const live = turnLive(turn);
  if (!live || turn.approvalDone) return "";      // ← hides approval #2 behind approval #1's answer
```

And `j.approvalDone` is never cleared when a *new* approval request arrives:

```js
// lib/jobs.js:2566-2592 — approval.request sets j.approval, leaves j.approvalDone alone
if (evt.event === "approval.request") {
  …
  j.approval = { requestId: …, command: …, choices: …, timeoutSeconds: seconds, at: …, deadline: … };
  this.emit(j);
}
```

Compare the clarify path twenty lines below, which does clear its sibling at `lib/jobs.js:2624`
(`j.questionDone = null;`). The asymmetry is the bug: the first approval's `approvalDone` (`choice: "session"`, set by
`approval.responded` at `lib/jobs.js:2641-2649`) is still on the row when #2 arrives, so the card hides #2's box. The
console still prints the `⚠ approval requested:` line, which is exactly the half-state in the screenshot: the request
is visible, the answer is not.

The same stale field defeats the panel's own pre-check:

```js
// lib/jobs.js:3273-3277
approvalPending(j) {
  if (!j?.approval || j.approvalDone) return false;   // ← false for a genuinely parked second approval
  const deadline = Number(j.approval.deadline);
  return !Number.isFinite(deadline) || Date.now() < deadline;
}
```

so `steer()` (`lib/jobs.js:3279-3326`) skips its `run_parked_on_approval` answer at `3289-3295` and posts to the
gateway, which refuses with `run_not_accepting_steer` because its steer gate accepts only `status == "running"`
(`hermes-agent/gateway/platforms/api_server_runs.py:1413-1414`, `_steer_refused` at `1393-1395`).

The same `!approvalDone` test also hides the two "awaiting approval" signals that would have told the reader a human
was needed: the worktree row badge (`public/app.js:10039`) and the project chip (`public/app.js:13134`) both read
`approvalLive(t.approval) && !t.approvalDone && turnLive(t)`.

### 1.4b The other route to the same card: a restart while parked

`approval` is not persisted either (`lib/jobs.js:679-738`). A panel restart while a run is parked therefore loses the
park: `load()` marks the row `interrupted` (`lib/jobs.js:635-648`), `reattachRestored()` puts it back to `running`
because the gateway still holds the run (`lib/jobs.js:2801`, `2847`), and `j.approval` comes back `null` — so the card
shows no box, `approvalPending()` is false, and the steer goes to the gateway to be refused, with no stale
`approvalDone` anywhere in the chain.

No row in this store demonstrates that route — the nearest, `c40f5631`, raised its request at `03:15:33`, *after* the
restart that re-attached it (`03:14:04`), and was cancelled 31 s later, which is why it carries neither an answer nor
an expiry line. The route is reachable rather than observed: nothing after `reattachRestored` re-reads the run's
`pending_controls`, so the first restart that lands on a parked run produces a card with no box and a live Steer
button — the same symptom as §1.4, from a different cause.

The repair belongs in the re-attach, not in a second store field: the run document the gateway returns already carries
`pending_controls` (kind, command, `prompt_id`, `execution_generation`), and `controlContext()` already reads exactly
that (`lib/jobs.js:3347-3361`). `reattachRestored(j, run)` should rebuild `j.approval` (or `j.question`) from
`run.pending_controls[0]` when one is open, so a re-attached card says what the run is waiting for. That is the same
rule as "re-attach the gateway run when one exists" — re-attaching the run but not its park is a card that is wrong
about what the run needs.

### 1.5 Census: how many rows are in that state right now

Read at `2026-11-03T04:12:37Z` with a probe that loads the persisted store, cross-reads `/api/jobs` for the in-memory
half, and asks the gateway `GET /v1/runs/{id}` for every live row (`probe_live_rows2.py`, output
`live-rows-final.json`):

| count | what |
|---|---|
| 80 | rows persisted in `~/.wag/state/jobs.json` |
| 6 | rows whose `status` is live (`running`) with `endedAt: null` |
| 0 | of those, rows that carry a `live` key on disk — the field is never persisted (`lib/jobs.js:679-738`) |
| 6 | of those, rows the gateway answers `200` + `status: "running"` for |
| 0 | of those, rows whose run the gateway calls terminal (`completed`/`failed`/`cancelled`/`interrupted`) |
| 0 | of those, rows whose run the gateway answers `404` for |
| 0 | of those, rows parked on an approval (`waiting_for_approval`) |
| **0** | **rows in the brief's zombie state: `running`, `endedAt: null`, and no run the gateway can settle** |

The six, named as read at `04:12:37Z` (all `running`, `endedAt: null`, no `live` on disk, and each with a live gateway
run):

| job | thread | startedAt |
|---|---|---|
| `fbe9734a` | wtgui-fix-the-eight-studio-defects-52b37e | 2026-11-03T04:07:32.703Z |
| `29e26fff` | wtgui-fix-the-five-defects-playwri-e1ab1e | 2026-11-03T04:07:11.839Z |
| `dc9b2cdd` | wtgui-research-and-write-up-docs-o-0063d5 | 2026-11-03T04:06:01.819Z |
| `9c3d3762` | wtgui-a-task-parked-on-a-question-e36b65 | 2026-11-03T04:04:17.616Z |
| `e8c0c526` | wtgui-put-the-pipeline-chip-on-the-7322a3 | 2026-11-03T04:01:20.544Z |
| `daad7fc0` | wtgui-the-watchdog-must-watch-ever-d9ac35 | 2026-11-03T04:01:20.525Z |

So the answer to "how many other rows are in the same state right now" is **none**, and the brief's own test does not
discriminate: by its definition all 6 live rows qualify (every persisted row lacks `live`), including the run writing
this document. The discriminating question is not "is there a `live` block" but "does the gateway still have the run,
and will it take a steer" — `runProbe()` (`lib/jobs.js:2957-2970`) plus the run's `status`.

At the brief's own moment the count was **one** (755d3a97 itself), and it was parked rather than orphaned. The
population that is genuinely at risk is the multi-approval turn, and that *is* measurable:

| count | what |
|---|---|
| 4 / 80 | stored turns that raised any approval at all |
| 6 | approval requests across those turns: 3 carry an "answered from the panel" line, 1 an expiry line, and 2 neither (aa24ec79's second park ended with the turn; c40f5631's turn was cancelled 31 s after the request) |
| 2 / 2 | turns that raised a **second** approval — and in both, the second box was hidden by the first's `approvalDone` |
| 9 | approvals that expired unanswered in the panel's log (8 runs) — each a ~600 s window in which the row read `running`, so the card drew a Steer button the gateway would have refused |

The two multi-approval turns are 755d3a97 (`03:56:43`, expired) and aa24ec79 (`03:38:08`, never answered; the run
finished at `03:48:42` after the window closed). 2 of 2 is the defect's hit rate, not an edge case.

### 1.6 The defect, isolated

A probe against this tree's `Jobs` class, driving the same `consume()` the SSE stream drives:

```
1. first approval request              { pending: true,  approval: {command:'cd /repo && git log -1', deadlineIn:'600s'},
                                         approvalDone: null, cardShowsApprovalBox: true }
2. first approval answered 'session'   { pending: false, approval: null,
                                         approvalDone: {choice:'session', ...}, cardShowsApprovalBox: false }
3. SECOND approval request (open)      { pending: false, approval: {command:'taskkill /F /PID 15920', deadlineIn:'600s'},
                                         approvalDone: {choice:'session', ...}, cardShowsApprovalBox: true }
4. jobs.steer() on the second park      { code: 'run_not_found', gatewayWasAsked: true, error: 'Run not found: run_probe' }
```

Step 3 is the defect in one line: the second approval is open (`approval` present, 600 s left) and `approvalPending()`
says no. Step 4 shows `steer()` therefore went to the gateway — against a fake run id it came back `run_not_found`,
against 755d3a97's real run id it came back `run_not_accepting_steer`, which is the screenshot.

Step 3's `cardShowsApprovalBox: true` is `summary().approval` being non-null; the box is then hidden in the renderer
by `approvalPrompt`'s `turn.approvalDone` test (§1.4). The summary is honest; the page is not.

### 1.7 The correct repair

**(a) Re-attach when the run exists, settle it when it does not.** The decision already exists and should stay the one
implementation: `settleRestoredRun()` (`lib/jobs.js:2789-2810`) — terminal → `adoptRun` (`2794`, `2902`), still held →
`reattachRestored` (`2801`, `2840-2868`: `status = "running"`, `endedAt = null`, `runGone = false`, poller re-armed,
stream re-subscribed), 404 → `markRunGone` (`2806`, `2879-2897`: `status` stays `interrupted`, `runGone = true`,
finalised). Two gaps keep that from being airtight:

- `reconcileRestored()` is one pass at boot and is skipped entirely when the gateway is unreachable at that moment
  (`server.js:5133-5137` returns early), with no retry: those rows sit `interrupted` behind a manual re-attach chip
  until somebody presses it. Run the same reconcile from the 15 s watchdog that already sweeps orphans
  (`server.js:819-838`), over `interrupted && runId && !reconciled` rows, and let it settle them.
- `markRunGone()` refuses any card that is not `interrupted` (`lib/jobs.js:2880`). A steer that gets a 404 starts from
  `running`, so that path has to go through `markInterruptedByRestart({ gone: true })` (`lib/jobs.js:3022-3047`, which
  requires `running|starting`) — what `sweepOrphanedRuns` already does on a 404 (`3186-3188`). Factor that into one
  helper both callers use, so a proven-gone run settles the row in the same request that refused the steer.
- and `reattachRestored` has to restore the *park* as well as the run (§1.4b): `approval` is not persisted, so a
  re-attached card loses the very thing the run is waiting on unless it is rebuilt from `run.pending_controls`.

**(b) Never draw a steer button the gateway cannot answer.** One predicate, read by both the button and the route:

```js
// summary(): the client stops deriving the button from `status` alone
steerable: this.steerable(j)   // { ok, why: null | "parked" | "gone" | "not_running" }
```

with `steerable(j)` returning false for `status !== "running"`, for `approvalPending(j)`, and for `runGone`. The page
draws `data-steer` only when `turnLive(t) && t.steerable?.ok` (`public/app.js:4716`), and the route's 409 carries the
same `why` so the two can never disagree. That is the structural answer to "never leave a row that presents a steer
button the gateway cannot answer": today the button is drawn from `turnLive()` (`public/app.js:9887-9891`), which
knows only the status word.

**(c) The root cause, in two lines and two deletions.** Clear the stale flag when a new request arrives, and stop
gating a *later* request on an *earlier* answer:

- `lib/jobs.js:2566-2592`: `j.approvalDone = null;` on `approval.request` (the mirror of `2624`).
- `lib/jobs.js:3273-3274`: `approvalPending()` keeps only `if (!j?.approval) return false;` — `approval.responded`
  (`2649`) and `settle` (`2702`) already clear `j.approval`, so `approvalDone` is a record of what was decided, not a
  gate.
- `public/app.js:2879`, `10039`, `13134`: drop the `!approvalDone` terms; the presence of `approval` plus
  `approvalLive()`'s deadline is the whole test.

---

## 2. The steer refusal: three cases behind one sentence

### 2.1 Where the 409s come from

The gateway has exactly two 409 bodies on `POST /v1/runs/{id}/steer`, and one 404:

| gateway answer | when | source |
|---|---|---|
| `409 run_not_accepting_steer` — "Run is not currently accepting steer input" | the run's status is not `running`, **or** the run has no steerable agent | `api_server_runs.py:1393-1395`, gate at `1413-1414`, second refusal at `1437` |
| `409 steer_not_accepted` — "Run did not accept steer text" | the run *is* `running` and `agent.steer(text)` returned false — the turn has crossed its last tool boundary | `api_server_runs.py:1447-1449` |
| `404 run_not_found` — "Run not found" | the gateway holds no such run | `api_server_runs.py:208`, `_load_owned_run` at `1194` |

`run_not_accepting_steer` is therefore **not** a synonym for "crossed the last tool boundary". It covers both of the
first two cases below, and a parked run is the common one: Hermes sets the run's status to `waiting_for_approval` the
moment it emits `approval.request` (`api_server.py:3724`), and the gate at `1413` rejects anything that is not exactly
`running`.

### 2.2 The three cases

| | A — live, past its last tool boundary | B — live, parked on an approval | C — run gone, stale row |
|---|---|---|---|
| gateway answer | `409 steer_not_accepted` | run status `waiting_for_approval` → `409 run_not_accepting_steer` | `404 run_not_found` |
| what the panel knows | `status: running`, no `approval`, `runGone: false` | `approval` set with a live deadline (but see §1.4) | `runProbe()` → `known: false` (`lib/jobs.js:2964`) |
| panel path today | `steer()` posts, `lib/jobs.js:3310-3319` returns the body verbatim, `server.js:3813` → 409 | the same, because `approvalPending()` said no; when it fires, `lib/jobs.js:3289-3295` → `run_parked_on_approval` with no round trip | the same; `server.js:3813` does **not** list `run_not_found` and the status is not 409, so the route answers **400** |
| what the reader is told | "steer refused — Run did not accept steer text: run_x. Nothing was queued; press Queue reply to hold this text." (`public/app.js:6202`) | the identical sentence, naming the run, with the same advice | "steer refused — Run not found: run_x … press Queue reply", from a 400 |
| is the advice right? | **yes** — the turn is ending; a queued reply is the next turn, which is what the reader wants | **no** — the run is alive and held; Queue reply turns the text into a second turn on a session that never finished (the screenshot's `1 queued · 6m35s` is exactly this) | **no** — there is no turn to steer and nothing to queue behind; the row is stale and should settle |

Today all three arrive as one sentence with one instruction, because the panel never classifies them: `steer()`
forwards `body.error.code` and `body.error.message` untouched (`lib/jobs.js:3314-3319`), `server.js:3812-3814` collapses
everything that is not one of three codes or a 409 into 400, and `public/app.js:6200-6202` prints the gateway's own
sentence plus "press Queue reply". The comment at `lib/jobs.js:3311-3313` already admits the ambiguity — "the turn
crossed its last tool boundary before this arrived (or it is parked)" — and then does nothing with it.

### 2.3 What the panel should do with the text, per case

**A — past the last tool boundary.** Keep the text in the box (it already does: the failure branch returns before the
draft is cleared, `public/app.js:6195-6204`), and keep the advice. Say the turn is already finishing and that Queue
reply sends it as the next turn on the same thread. Do not claim anything was held.

**B — parked on an approval.** Keep the text in the box, and point at the approval: "this turn is parked on an
approval — answer it and Steer works again; nothing was queued". Do **not** offer Queue reply as the remedy: the run
is live, and a queued reply becomes a second turn the moment the parked turn ends. The stronger fix is that the button
is not drawn at all while parked (§1.7b), so this sentence is the one the route returns if a stale page asks anyway.

**C — run gone.** Treat the refusal as a fact about the row, not about the text: settle the row in the same request
(`markInterruptedByRestart({ gone: true })`, §1.7a), return the settled card, and tell the reader the run is gone and
the text is unsent. "Queue reply" is wrong here — there is no live turn to queue behind; the truthful action is
*Send reply*, which is what the card offers once the row is no longer `running`.

### 2.4 Fix shape

1. **One classifier, in `jobs.steer()`** (`lib/jobs.js:3279-3326`): before posting, return
   `{ ok: false, reason: "parked" }` from `approvalPending` (fixed by §1.7c) and `{ reason: "gone" }` when `runGone`.
   After a non-ok response, map `run_not_accepting_steer`/`steer_not_accepted` to `past_boundary` **only** when a
   one-shot `runProbe()` says the run is still `running`; a `404` maps to `gone`; a `waiting_for_approval` status maps
   to `parked`. Carry `runStatus` back with the answer so the caller never has to guess.
2. **`server.js:3801-3815`**: keep 409 for every "the run exists and will not take it" refusal (all three reasons),
   and reserve 400 for a request the route cannot act on (unknown card, empty text, card not running). The browser
   already branches on `out.ok`, not on the status, so the status is a contract for other clients only — make it say
   "refused", and let `reason` say why. On `reason === "gone"`, settle the row before responding and return the card
   the way `/api/jobs/reattach` already does (`server.js:3821-3830`).
3. **`public/app.js:6200-6204`**: one sentence per `reason`, and the right next action in each:
   - `parked` → "this turn is parked on an approval — answer it above and Steer works again. Nothing was queued."
   - `past_boundary` → the current sentence ("press Queue reply to hold this text"), which is correct here.
   - `gone` → "run <id> is no longer in the gateway — this card has been settled; nothing was queued. Send reply
     starts a new turn."
   Repaint from the returned card so the Steer button disappears in the same round trip.

---

## 3. Gates this needs

- `test/steer-refusal.test.js` (new): a `Jobs` with an injected `fetch` that records every call. Two approvals on one
  turn → `approvalPending()` true, `steer()` returns `reason: "parked"`, and the gateway was **never called**. A run
  reported `completed` → `past_boundary`. A `404` → `gone` **and** the row transitions to `interrupted` with
  `runGone: true`.
- `test/approval-park.test.js` (new): `summary()` of a turn carrying a second approval has `approval` set,
  `steerable.ok === false`; after `approval.responded` for the second, `approval` is null again.
- A driven page gate (the `tools/verify-*.mjs` shape): a card parked on an approval renders the approval box and **no**
  `[data-steer]`; once answered, the box goes and Steer returns.
- Why this survived: the shipped gate `tools/verify-approval-expiry.mjs` drives `approval.request` through the real
  `Jobs` class, but it parks **one** approval per run and its stub status endpoint answers `status: "running"` for a
  parked run (`tools/verify-approval-expiry.mjs:39`, `108`). Both shortcuts hide this defect: a second request
  never arrives, and the stub never reports the `waiting_for_approval` that makes the gateway refuse a steer. No test
  in `test/` asserts `approvalPending()` or drives two approvals on one turn.

## 4. Limits of this document

- The census is a snapshot at `04:12:37Z`; the six live rows it counts are real runs whose status will have moved by
  the time this lands. The method (`probe_live_rows2.py`) is the durable part, and the numbers should be re-read
  rather than quoted later.
- The 755d3a97 timeline is reconstructed from the store's own `lines` and the panel log; the panel keeps no separate
  event journal for a job, so a line that was trimmed from the 120-line tail is not recoverable.
- The gateway source quoted here is the installed `hermes-agent` (0.22.5) at
  `C:/Users/roper/AppData/Local/hermes/hermes-agent`; the steer gate is the same shape in the authority path
  (`api_server_authority_runs.py:94` reports `waiting_for_approval`), but only the legacy handler at `1413` was read
  line by line.
- The brief's `lib/jobs.js:3421-3460` is the **running checkout's working copy** (dirty; `approvalPending` at `3408`),
  not this branch or main, where the same code is at `3273-3326`. Line numbers here are this tree's, at `d86ca81`.
