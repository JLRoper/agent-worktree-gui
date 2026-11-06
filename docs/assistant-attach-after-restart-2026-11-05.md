# The session fence: why some assistants fail every turn after a gateway restart

**Status:** measured on this box, 2026-11-06 (all times UTC; the gateway log writes local, UTC−5, and
is quoted as `local → UTC` where it matters). The question was why Assistant #3's turns 24–28 all died
in 3 s with `unknown_execution` while its siblings kept working.

The answer is not about the assistant. It is about one row in one table.

## 1. The answer

A gateway restart that cannot drain fences every turn that was **executing** at that instant: the row
stays `started` under the dead owner epoch, and the next boot rewrites it `unknown`. An `unknown` row
pauses that **session's** FIFO — the store refuses to claim the head, and every later turn on the same
session is admitted, given a run id, and then released with `unknown_execution` about three seconds
later. That state survives the restart because it is a store read, not memory. It survives every later
restart too, until someone calls `POST /v1/runs/{run_id}/resolve-unknown` for the row that owns it.

So the set that "keeps working" is exactly the set of sessions with **no `unknown` row**, and the only
thing that decided membership on 2026-11-06 01:49:51Z was whether that session happened to have a run
in flight when the gateway was killed. Assistant #1 and Assistant #3 were both on the wrong side of it.
Assistant #1 came back at 02:04:36Z because the panel's **Reset assistant** control was run for it.
Assistant #3 never was, so it has failed every turn since 01:51:00Z — 8 cards, 10 admitted turns, still
fenced at 02:39Z while #1, #2, #4 and #5 answer normally.

The panel already has the call. What it does not have is any way for the failing card to say so.

## 2. The gateway's side: one row, one fence

### 2.1 The restart that creates it

The gateway log for the restart that did this (local `20:49:51` → `01:49:51Z`):

```
20:49:20  Shutdown drain: 0 in-flight cron job(s), 17 api_server run(s) — waiting up to 30s
20:49:51  Shutdown phase: drain done at +34.16s (timed_out=True, active_at_start=17, active_now=17)
20:49:51  Gateway drain timed out after 30.0s with 17 active agent(s) ...; interrupting remaining work.
20:50:29  Previous gateway life (pid=58444) exited UNCLEANLY (no exit path ran — SIGKILL / OOM / VM
          death, or a process kill issued by the agent or one of its descendants ...)
20:50:30  Starting Hermes Gateway...
```

`restart_drain_timeout=0s` in that line: the panel's restart asks for a restart, the gateway waits 30 s
for live runs, gives up, and the process dies without an exit path. The 17 runs it said it was
"interrupting" are the ones that become `unknown`: their `session_admissions` rows never reach a
terminal outcome, so they still read `started` with `owner_epoch = 22`.

The next boot's cursor over the same table (current epoch 25, 02:39Z):

```
unknown rows by owner epoch:  3→9, 5→1, 9→1, 17→5, 18→1, 22→16
```

Sixteen rows from that one restart. Thirty-three sessions in total carry an `unknown` row on this box;
the rest are the residue of earlier restarts. (One of the sixteen is a `generation 114` row on
`panel-assistant-3`; the other fifteen are worker sessions.)

### 2.2 What `unknown` does

`session_authority.py:1010-1011` — the drain's claim refuses while **any** row for the session is
`unknown`, before it looks at the head:

```python
pending = list_session_admissions(self.db, session_id=ref.session_id)
if any(row['status'] == 'unknown' for row in pending):
    raise RuntimeStoreError('unknown_execution')
```

`hermes_state_runtime.py:211-217` is the same refusal one layer down, and `cancel_session_input`
(`:265-278`) refuses an `unknown` row the same way — so **stop cannot clear it**; it answers 409
`unknown_execution`.

The FIFO is paused, not destroyed. Rows admitted after the fence stay `queued` forever. That is why a
card can be "accepted" (202, a real run id) and still never run a single token.

### 2.3 The three-second failure a card shows

Every turn posted into a fenced session walks this path, which is why the card dies fast and with no
answer:

1. `POST /v1/runs` admits durably and answers a `run_id`. The card prints the id — **a queued row
   exists at this point**, so "the gateway accepted it" is true.
2. The drain is scheduled, tries to claim, and raises `unknown_execution` at
   `session_authority.py:1011`.
3. `_claim_with_retry` (`:1115-1123`) first offers the row to `settle_unattended_unknown` — which
   applies only to a cron/automation/webhook/Kanban principal (`gateway/session_unattended_unknown.py`,
   `is_unattended`). A panel turn is `principal_id='api'`, so it is **not** unattended and is not
   settled.
4. It calls `self._pause(ref, 'unknown_execution')` (`:444-460`), which pops **every waiter registered
   on that session** and sets the exception on each.
5. The run's own task was awaiting exactly that waiter (`session_api_turn.py:406`,
   `await asyncio.shield(waiter)`); the exception propagates out of `_execute_run`
   (`api_server_runs.py:1088`) into the catch-all at `:1132-1141`, which finishes the in-memory run
   `failed` with the exception's text:

```
21:14:02,356 WARNING gateway.session_authority: Session panel-assistant-3 paused: unknown_execution
21:14:02,359 ERROR gateway.platforms.api_server: [api_server] run run_67a850c9ed6449c98931a8248a91a4a0 failed
  File ".../api_server_runs.py", line 1088, in _execute_run
    result, usage = await observe_api_turn(...)
  File ".../session_api_turn.py", line 406, in observe_api_turn
    await asyncio.shield(waiter)
hermes_state_runtime.RuntimeStoreError: unknown_execution
```

6. The run.failed event reaches the panel, which copies the string onto the card
   (`lib/jobs.js:3331`, `if (run.error) j.error = j.error || String(run.error)`) and prints the only
   line it has (`lib/jobs/console-lines.js:209-212`): `run failed`.

The **admission row is still `queued`** after all of this. The failure is the delivery, not the work.
That is the whole trap: the panel believes the turn is over, the gateway believes the input is still
owed, and neither says so.

## 3. The panel's side: a card that cannot name it

- `settle()` maps the failure to `status: "failed"` and keeps `error: "unknown_execution"`. No code
  path anywhere in `lib/jobs.js` reads that string; the card renders the same `run failed` it would
  render for a model error or a `429`.
- The wake ladder does read it, but only as a health bit: `lib/assistant.js:2076` writes
  `Assistant #1 took the wake — skipped as failed: Assistant #3 (unknown_execution)` into the journal
  and routes the wake to a sibling. So the fenced assistant is not merely idle — **the panel
  deliberately stops giving it work**, and the only trace is a journal line the reader never opens.
- The one call that clears it lives in `lib/assistant/reset.js` (`POST /api/assistants/:id/reset`),
  surfaced as **Reset assistant** in Settings → Gateway (`public/index.html:481`). It is the only
  caller of `resolve-unknown` in this repo. Assistant #1 proves it works:

```
02:04:36Z  reset  Assistant #1 reset: 1 admission(s) settled (interrupted; the projection now reads
                  cancelled), 20 watch(es) dropped, 0 wake(s) dropped — reader: assistant 1 is not
                  responding; every run for its session queues with a null execution_generation and
                  dies as unknown_execution
02:05:24Z  said   panel-assistant  Continue if you can, exit if you are done   → completed 02:10:02Z
```

Six cards on `panel-assistant` had already failed the same way between 01:55:18Z and 02:03:26Z. After
the 02:04:36Z reset they were not retried by the panel and not abandoned by the gateway: the store's
rows for their six run ids are now `terminal / completed` (generations 2068–2072 and 2074), i.e. the
queued backlog drained and *ran* once the head was cleared. The cards had been written off minutes
earlier.

So both halves already exist, one call apart. Nothing connects them.

## 4. The evidence

### 4.1 Assistant #3, the eight cards

From `.wag/state/jobs.json` (cards are pruned to 80 jobs, so this is all that survives of its history):

| turn | card | started (UTC) | dur | run id | end |
|---|---|---|---|---|---|
| 21 | `8566daf4` | 02:13:59.620 | 4.5 s | `run_67a850c9ed64…` | failed · `unknown_execution` |
| 22 | `25a82bb9` | 02:16:40.538 | 2.5 s | `run_44812a298ca9…` | failed · `unknown_execution` |
| 23 | `86530fb4` | 02:16:46.408 | 2.9 s | `run_4f2e49dc0885…` | failed · `unknown_execution` |
| 24 | `200fae35` | 02:17:02.666 | 2.6 s | `run_c3dbaf9aaeeb…` | failed · `unknown_execution` |
| 25 | `66f8718e` | 02:18:38.230 | 3.0 s | `run_b21a64fb72e9…` | failed · `unknown_execution` |
| 26 | `0a454067` | 02:21:06.099 | 2.9 s | `run_81eb743da0e0…` | failed · `unknown_execution` |
| 27 | `65df03d1` | 02:23:07.428 | 8.3 s | `run_751a8aecb05d…` | failed · `unknown_execution` |
| 28 | `78aaaeef` | 02:25:22.660 | 3.1 s | `run_ad00e39e4d03…` | failed · `unknown_execution` |

No final message on any of them. Each run id has exactly one row in `session_admissions`, and every
one of those rows is still `queued`:

```
panel-assistant-3:  unknown=1  queued=10
  6556  unknown  gen 114  epoch 22   run_ad29c07fc4564433b50366e05cd50745   (the head)
  6580  queued   gen null epoch 23   run_762a7b447b…   ← first turn after the restart, 01:51:00Z
  6592, 6630, 6647, 6648, 6651, 6657, 6663, 6665, 6670  …   ← one per failed card and two pruned
```

Ten queued rows, eight surviving cards: the two missing cards were pruned by `KEEP_JOBS` while their
gateway rows live on. Nothing on the board names the head — that is why the reset route's dry run
reports it as `namedBy: "store-request-id"`.

### 4.2 The contrast

| session | unknown rows | outcome |
|---|---|---|
| `panel-assistant` (#1) | 1, from the same restart | failed 6 turns 01:55–02:03Z, **cleared 02:04:36Z**, working since |
| `panel-assistant-2` | 0 | working throughout |
| `panel-assistant-3` (#3) | **1, gen 114** | failed every turn since 01:51:00Z, still fenced |
| `panel-assistant-4` | 0 | working throughout |
| `panel-assistant-5` | 0 | working throughout |

The difference between #1 and #3 is not the assistant, the model, the settings or the tab: it is that
someone pressed Reset on #1.

### 4.3 The live dry run (read-only, no side effects)

Run against the panel at 02:35Z to confirm the panel can still name #3's fence:

```
$ curl -s -X POST http://127.0.0.1:7331/api/assistants/assistant-3/reset \
       -H 'content-type: application/json' \
       -d '{"dryRun":true,"reason":"deep-dive probe: name the fence only, no side effects"}'
HTTP 200
{
  "ok": true, "dryRun": true,
  "assistant": {"id":"assistant-3","name":"Assistant #3","threadId":"panel-assistant-3"},
  "verdict": "clearable",
  "stillFenced": true,
  "block": {
    "unnameable": [], "unreadable": [],
    "queued": [ 8 rows, every one with "executionGeneration": null ]
  },
  "clear": {
    "admissions": [{
      "runId": "run_ad29c07fc4564433b50366e05cd50745",
      "admissionId": "5f7d266cf15e4588a228e0471f2c0a1b",
      "executionGeneration": 114,
      "namedBy": "store-request-id", "action": "resolve-unknown"
    }],
    "wakes": [], "watches": [ 9 ]
  },
  "keep": {"queue":{"rows":25},"scratchpad":{"notes":8000,"rules":40,"journal":300,"alerts":18},
           "charter":{"chars":19773,"sha":"e106606f618a"}}
}
```

`verdict: "clearable"` is the panel's own word for "the gateway will accept the resolve". The gate is
one row, one admission id, one generation.

## 5. Clearing one without a restart

A restart does **not** clear it — the fence is a store row, and the row is only ever settled by a
caller. The panel's Reset assistant is that caller; these are the same three calls by hand, in the
order that does not fire the backlog.

1. **Look, do not touch** — dry run, as in §4.3. It names every admission and every queued run behind
   it, and writes nothing.

2. **Cancel the backlog first.** The queued rows are turns the panel asked for before it knew the
   session was dead; on #3 they are ten copies of *"Continue if you can, exit if you are done"*, up to
   48 minutes old. Clearing the head resumes the FIFO and every one of them runs (§3: #1's backlog ran
   as six completed turns). Cancel each by its run id — a queued row **is** cancellable, only an
   `unknown` one is not (`cancel_session_input`, `hermes_state_runtime.py:265-278`):

```bash
python - <<'PY'
import os, sqlite3, urllib.request, urllib.error
home = os.path.expandvars(r"%LOCALAPPDATA%\hermes")
key = next(l.split("=", 1)[1].strip() for l in open(home + r"\.env", encoding="utf-8", errors="replace")
           if l.startswith("API_SERVER_KEY="))
db = sqlite3.connect(home + r"\state.db")
rows = db.execute("select request_id from session_admissions "
                  "where target_session_id='panel-assistant-3' and status='queued'").fetchall()
for (rid,) in rows:
    req = urllib.request.Request(f"http://127.0.0.1:8642/v1/runs/{rid}/stop", method="POST",
                                 headers={"authorization": "Bearer " + key})
    try:
        print(rid, urllib.request.urlopen(req, timeout=10).status)
    except urllib.error.HTTPError as e:
        print(rid, e.code, e.read()[:120])
PY
```

Expected: ten `200`s and a session whose `queued` count is 0, with the `unknown` head untouched by all
of them. This step was not executed here — the clear of #3 was left for the reader (§7).

3. **Resolve the head** with both values from the dry run, and nothing else (a third key is 400):

```bash
curl -s -X POST http://127.0.0.1:8642/v1/runs/run_ad29c07fc4564433b50366e05cd50745/resolve-unknown \
  -H "authorization: Bearer $API_SERVER_KEY" -H 'content-type: application/json' \
  -d '{"admission_id":"5f7d266cf15e4588a228e0471f2c0a1b","execution_generation":114}'
```

A 200 receipt reads `status: terminal, outcome: interrupted` — the lost turn is *acknowledged*, not
replayed. `409 stale_generation` means the generation moved; re-read the run and use the new value.
`409 not_found` means the admission id does not belong to that run.

4. **Prove it** — the next turn must complete, and the store must read zero:

```bash
python -c "import sqlite3,os;c=sqlite3.connect(os.path.expandvars(r'%LOCALAPPDATA%\hermes\state.db'));print(c.execute(\"select status,count(*) from session_admissions where target_session_id='panel-assistant-3' and status in ('unknown','queued') group by status\").fetchall())"
```

In the panel, the same thing is one press: **Settings → Gateway → Reset assistant**, select the
assistant, first press reads the dry run, second press sends it. It also drops that assistant's queued
wakes and the watches it owns (9 watches for #3) and keeps its queue, scratchpad, charter and thread.

**Do not use stop on the head.** `POST /v1/runs/{id}/stop` answers 409 `unknown_execution` on an
`unknown` row and changes nothing; the panel's `stopRunAtGateway` currently treats *any* 409 as
"already gone" (`lib/jobs.js:3539-3574`), so a stop on a fenced turn journals a success that did not
happen.

## 6. What a repair would touch

The fence itself is right: the gateway genuinely cannot know whether a turn that ran under a dead owner
finished, and making the caller acknowledge it is the correct design. What is missing is the panel's
half of that conversation.

1. **Name it on the card.** In `settle()` (`lib/jobs.js:3310-3352`) a run whose error is
   `unknown_execution` is not a failed turn — it is a fenced session, and it will fail identically
   forever. The console should say so, with the one control that clears it, instead of `run failed`.
   That is a copy/UX change and needs no gateway read: the string is already on the card.
2. **Clear the backlog before the head.** `runReset` (`lib/assistant/reset.js:423-583`) resolves the
   `unknown` rows and then immediately resumes the FIFO. It already enumerates the queued runs
   (`block.queued`) and deliberately never refuses on them; it should cancel them before resolving, or
   the clear fires every stale wake (measured: 10 on #3, 6 completed turns after #1's clear). One loop
   over `enumerated.queued` with the same `gateway.getRun` → `POST …/stop` shape the rest of the module
   already uses, and a line per cancellation in the receipt.
3. **Stop calling a 409 success.** `stopRunAtGateway` (`lib/jobs.js:3539-3574`) marks `entry.ok = true;
   entry.already = true` on every 409. It should read the body: `unknown_execution` is a refusal, not an
   ending, and the journal currently says *"stop sent — HTTP 409 — already gone"* for a run that is not
   gone (`docs/research/assistant-session-fence.md` §4).
4. **Do not wake a fenced assistant.** `lib/assistant.js:2076` already computes the failure and routes
   around it; the wake it drops should be *refused at enqueue* while the session is fenced (the same
   `unknownAdmissions` read the reset already does), so the queue does not accumulate work that cannot
   run — and the tab can carry a "fenced" chip instead of `EXITED`.
5. **Gateway side (not this repo):** `settle_recovered_unattended` settles a lost *automation* turn
   because no person can be asked to resend it. A panel API turn is a person's turn, so it is
   deliberately left standing — correct, but it means the client **must** implement the resolve. If the
   panel ever wanted the gateway to do it, the admission payload would need to say the submitting client
   is not coming back; that is a Hermes change and a product decision, not a panel fix.

## 7. What this does not claim

- The 2026-11-06 01:49:51Z restart is the one that fenced **this** box's assistant sessions; the 33-row
  total includes older restarts and is a snapshot at 02:39Z, not a property of the design.
- The claim that #1's backlog ran after its 02:04:36Z clear rests on the generation order of its rows
  (2068–2074 sit below 2076, the turn that started 02:05:24Z) and on the fact that a card which had
  received a *result* could not have carried `unknown_execution`. It was not observed live.
- The clear procedure in §5 was dry-run only. Nothing was resolved on `panel-assistant-3`, so its ten
  queued rows are still there, waiting.
- Line numbers are the gateway at `bf0203a794` (`%LOCALAPPDATA%\hermes\hermes-agent`) and the panel at
  `f6f0c2f`.

## References

- Gateway: `gateway/session_authority.py` 444-460, 1010-1011, 1115-1123 · `gateway/session_api_turn.py`
  385, 406, 430 · `gateway/platforms/api_server_runs.py` 1088, 1132-1141 ·
  `gateway/platforms/api_server_authority_runs.py` 66-97 · `gateway/session_unattended_unknown.py` ·
  `hermes_state_runtime.py` 211-217, 236-278.
- Panel: `lib/jobs.js` 3331, 3539-3574 · `lib/jobs/console-lines.js` 209-212 · `lib/assistant.js` 2076,
  2816-2835 · `lib/assistant/reset.js` (whole) · `lib/assistant/reset-store.js` ·
  `public/index.html:481`.
- Prior work this stands on: `docs/research/assistant-session-fence.md` (the id map, the `unknown`
  status, the store census), `docs/research/gateway-fence-endpoints.md` (the measured endpoint table),
  `docs/research/assistant-reset-design.md` (the reset's order).
