# The assistant reset — design

Status: **built.** The route is `lib/assistant/reset.js` + `lib/assistant/reset-store.js` (version 1.12.0), and the
control this document designs in §4 — the third control in Settings → Gateway, the dry-run rows and the five copy
states — landed with the same feature. §6's prerequisites are built as written except `j.admissionId` on the card:
the route takes a fresh `GET /v1/runs/{id}` per candidate instead, which is the cost §1.1 already accepted.

> Historical note, kept because it dates the measurements below: when this document was first written there was no
> reset route in the tree (`grep -rn "/reset"` over `server.js`, `lib/assistant.js` and `lib/assistant/` found none),
> and nothing in it had been sent to a gateway. §7 separates what was measured then from what was designed.

Scope: one control, `POST /api/assistants/:id/reset`, that makes a fenced assistant answerable again. It is a
**control-plane** reset, not a memory wipe. It clears the unknown admission that fences the assistant's session, the
wakes queued against it, and the watches it owns. It keeps the queue, the scratchpad and the charter.

Built from two committed research docs and the code they measure:

- `docs/research/gateway-fence-endpoints.md` (`bb7fdb5`) — the measured endpoint table. The fence is
  cleared only by `POST /v1/runs/{run_id}/resolve-unknown` with **both** `admission_id` and
  `execution_generation`. `POST /v1/runs/{id}/stop` answers `409 unknown_execution` and clears
  nothing.
- `docs/research/assistant-session-fence.md` (`d0bef37`) — the id map (session / run / panel job),
  the `revived` mismatch, and the reproduction.
- Code read on `main` at `f19b615`: `lib/jobs.js` (`sweepOrphanedRuns`, `noteUnknownAnswer`,
  `writeOffUnknownRun`, `markInterruptedByRestart`, `stopInterruptedRuns`), `lib/assistant.js`
  (`assistantLive`, `wake`, `flushWake`, `checkWatches`, `addWatch`, `wakeAfterRestart`),
  `lib/jobs/console-lines.js` (`runRefusal`), `public/app.js` (`restartFromSettings`,
  `clearProviderKey`), `public/index.html` (the restart row), `lib/session-usage.js` (the panel's
  read-only `state.db` access).

## The shape, in one table

| | |
|---|---|
| **clears** | the unknown admission(s) on this assistant's session, settled through the gateway with both ids; the wakes queued and routed to it; the watches it owns |
| **keeps** | the queue and its spawn debts; the scratchpad (notes, rules, journal, alerts, harvested, command audits, dedupe sets); the charter; the thread id and the transcript |
| **never does** | start a run; write to a working directory; clear another assistant's watches or wakes; write to the gateway's store; restart a process; re-home a session |

The name is "full reset" because it clears every clearable admission, every wake routed to the
assistant and every watch it owns. It is not a fresh mind: the conversation is untouched, so the
model still has the transcript and the charter is not re-sent. A reader who wants a fresh mind wants
a new thread, which is a different feature (and, per §7.3 of the fence doc, a product decision).

## 1. What a full reset clears, and what it keeps

### 1.1 The unknown admission — and why the panel's ack is not one

The panel already has a path that looks like it settles an unknown run. It does not, and the
difference is the whole reason this control exists.

The path today, in order:

1. `sweepOrphanedRuns` (`lib/jobs.js:3669`) polls every card with a run id. A run the gateway answers
   `unknown` for is counted by `noteUnknownAnswer` (`:3458`): two answers at least
   `UNKNOWN_CONFIRM_MS` = 15 s apart, or one answer on a card already past its wall-clock cap, is
   evidence.
2. With evidence, `writeOffUnknownRun` (`:3484`) calls `markInterruptedByRestart` (`:3502`) — a
   **local** change. The card becomes `interrupted`, `runGone: true`, clocks stopped, notice pushed.
3. Every path that marks a run interrupted then asks for a stop, so `stopInterruptedRuns` (`:3581`)
   sends `POST /v1/runs/{runId}/stop` through `stopRunAtGateway` (`:3539`). On an unknown admission
   that request is the measured 409: `{"error":{"message":"unknown_execution",...}}`, no
   `Retry-After` (fence doc, row #7). The journal records `stop FAILED — unknown_execution`.

So the panel's acknowledgement of the fence is a request the fence refuses. The card is settled; the
gateway's admission row is still `unknown`; `claim_session_input` still refuses the session's FIFO
head (`hermes_state_runtime.py:211-213`). The next `POST /v1/runs` is accepted with 202 and then
fails or sits queued (fence doc, rows #8 and #9).

That is also why the panel can report **0 lost turns**. The restart wake's only count is `list.length`
in `wakeAfterRestart` (`lib/assistant.js:2318`) — the runs still live at boot that the restart cut
off. A turn already written off by the unknown sweep is `interrupted` before the boot, so it is not
in that list; the wake says "nothing was interrupted: no run was still going when it stopped." The
panel's store agrees with itself. The gateway disagrees, and the gateway is the one holding the
fence.

**The clear** is one call, with both ids (fence doc, row #11):

```http
POST /v1/runs/run_3ea61cf919c545ef84aa70d80ac5bae8/resolve-unknown
{"admission_id": "a1209a5fc2e246d5a456d0718d011ffd", "execution_generation": 1}
```

It answers 200 with a receipt — `status: "terminal"`, `outcome: "interrupted"`, `authority_epoch: 19`
— and does two distinct things:

- it settles the lost turn **without re-running it**, as `interrupted`;
- it resumes the session's FIFO. Admissions already queued behind the fence drain and run on their
  own (row #15), and a new `POST /v1/runs` is accepted and completes (row #16). There is no separate
  unpause.

Each of the three fields is load-bearing:

- **the run id in the path** names the execution. It must be a run, never a session id — a session
  id in that slot is 404 `run_not_found` (row #14), and there is no session-keyed resolve.
- **`admission_id`** names the FIFO row the run belongs to; the gateway compares it with the run's
  own admission and answers 409 `not_found` on a mismatch (row #5).
- **`execution_generation`** proves the caller is settling the execution the gateway is actually on.
  Omitting it, or adding any other field, is 400 `invalid_params` (rows #2 and #3); a stale
  generation is 409 `stale_generation` (row #4).

Two consequences the route has to live with:

- The resolve is **idempotent on the exact body**: the same call again returns the same 200 receipt
  (row #12). A retried acknowledgement is not punished, so the reset can retry a transport failure.
- The receipt is the only place the word `interrupted` appears; the projection (`GET /v1/runs/{id}`)
  afterwards reads `status: "cancelled"` (row #13). The reset's verification must therefore accept
  `cancelled` on the projection while reporting `interrupted` from the receipt, and must not treat
  the two words as a contradiction.

**Where the pair comes from.** Not from the card's memory. `GET /v1/runs/{runId}` returns
`admission_id`, `execution_generation` and `status` in one body (row #1), and the panel already
parses the generation from it (`lib/jobs.js:3231`). The reset does that GET inside the same request
and builds the body from *that* answer — never from `j.executionGeneration`, which is a cache and can
be behind (the generation in the fence doc moved 1 → 3 → 4 across one session).

`admission_id` is **not stored on the card today** (`grep admission lib/jobs.js` finds only
comments). The design needs it recorded at `adoptRun`/`poll` time, from the same GET that already
yields the generation. Until that lands, every reset clear costs one extra GET per candidate — which
is fine, and is what the dry run does anyway.

**What reset cannot name.** The endpoint can settle an admission only through the run that owns it.
The panel's cards are the only place run ids exist: the durable store's `session_admissions` has
`admission_id`, `target_session_id` and `generation`, but no run id (there is no runs table — a run
lives in one gateway process's memory, which is why `stopStaleRuns` stamps the pid). An admission
with no card naming a run cannot be resolved from here at all, and the store's own row is enough to
keep the session fenced.

This is not hypothetical. Reading the live store read-only on this box at design time:

```
status='unknown' : 18 rows, 18 distinct sessions, generation 1…63, owner_epoch 3…18
runtime_epoch    : 19  (current)
one of them      : panel-assistant-3 · admission 16e7a6a7… · generation 63 · owner_epoch 18
```

One of the fenced sessions is an assistant's own, and its row belongs to the **previous** runtime
epoch while the current epoch is 19 — the direct proof that a gateway restart does not clear this
fence, because the fence is a store read. Whether a card names a run for that row is exactly what the
dry run decides; if none does, the reset must say so rather than clear the watches around a fence
that is still standing.

### 1.2 The stale queued wakes

A wake is a queued thought, not a run. `wake()` (`lib/assistant.js`, around `:3800`) appends
`{reason, alertId, rule, assistantId}` to `pendingWake` and arms one 150 ms `wakeTimer` to coalesce a
sentry pass into one turn. `flushWake` batches per assistant, and if that assistant is live it pushes
the whole batch back:

```js
if (this.assistantLive(who)) { this.pendingWake.push(...batch); continue; }
```

So a batch can sit through an entire assistant turn and describe an event from an hour ago. That is
the stale wake: already routed, never flushed, and about to become a turn the moment the thread is
free. Reset must drop it, or the first thing the assistant does after being reset is discuss
yesterday.

What is cleared, precisely:

- every `pendingWake` entry whose `assistantId` is this assistant (entries are routed at enqueue, so
  the filter is exact and another assistant's batch survives);
- `wakeTimer`, **only** if no entries remain after the filter. One global timer serves every
  assistant; clearing it with another assistant's entries still queued would silently park that
  assistant's wake until something else armed a timer.

What is **not** cleared, and why:

- `this.wakes` — the timestamps that spend the hourly sweep budget. It is a rate ledger, not a
  queue; clearing it would let a reset hand the assistant an extra hour of sweeps.
- `terminalWakes` / `restartWakes` — dedupe keys. `restartWakes` is what stops one restart being
  reported twice; clearing it is how a reset would create a duplicate restart wake.
- `spawnIntents` — those are debts (owed `SPAWN` lines), not wakes. See §1.4.

Each dropped wake is journalled as `wake-dropped` with its `reason`, `rule` and age, so the ledger
says what the reset threw away. The first sentry pass after a reset runs `force: true`, so any
condition that is still true is re-raised from the board rather than from a stale sentence — a sweep
is re-derivable, and that is what makes dropping it safe.

One small prerequisite: `pendingWake` entries carry no timestamp. Add `at: Date.now()` at enqueue so
the dry run can age a wake and the word "stale" is checkable rather than rhetorical. One field.

### 1.3 The watches

A watch is `{id, thread, title, doneWhen, minutes, at, by, state, assistantId?}`
(`lib/assistant.js:5552`), owned by `watchOwnerOf`; an unstamped legacy watch resolves to
Assistant #1. `checkWatches` (`:3014`) turns a finished turn on the watched thread into a notice, and
the watch stays `watching` until that notice fires.

Reset drops **every watch whose owner is this assistant**, on whatever thread it was placed. A watch
the assistant set on a worker's thread is still the assistant's promise; the thread is not the
ownership key.

They are cleared because a reset is a statement about what this assistant is still promising. A watch
left open over a thread whose run the reset just settled as `interrupted` will fire a "watch
finished" notice about work the reader has just written off — a notification that contradicts the
reset. And a watch that can no longer fire (its thread's card is `interrupted`, `runGone`) sits at
"watching" forever, which is the failure the comment inside `checkWatches` already describes for
restarts.

Journal one line: `reset`, count and ids.

### 1.4 What it keeps, and why each keep is a keep

| kept | why |
|---|---|
| queue rows (`assistant/queue.js`) | they are the reader's asks. A reset that emptied the queue would delete the only record of what was wanted, and "losing queued work" is the first failure mode in §5. |
| `spawnIntents` (owed SPAWN lines) | debts, not state. A `lost` debt is how the next turn is told a spawn never landed; dropping them makes the same request silently disappear. |
| scratchpad: `notes`, `rules`, `journal`, `alerts`, `harvested`, `commandAudits` | memory and evidence. `alerts` especially: clearing them lets the same condition re-alert as if it were new. The `journal` is where the reset's own entry goes. |
| the charter (`CHARTER_FILE`, ~20 KB) | a file, not a field. Kept and **not re-seeded**: the session is the same, so the long tier is not re-sent as if the model had lost its context. |
| the thread id (`rec.threadId`) and its transcript | identity and continuity. Reset must not re-home; §7.3 of the fence doc is a product decision, not something a repair control may do silently. |
| the execution generation of an executing run | reset never touches a running turn (§5.2); it has no business reading or writing that run's control ids. |
| every other assistant's watches, wakes and admissions | the route is scoped by `:id`; §5.4 makes that an invariant, not an intention. |

## 2. The resume path the reader is actually given

### 2.1 What the copy says today

`runRefusal` (`lib/jobs/console-lines.js`) has two sentences:

- `revived: true` → "this session is the CLI's, not the panel's — the gateway will not take a panel
  turn in it (409 permission_denied). Continue it in a terminal: `hermes --resume ${thread}`" (`:225`)
- otherwise → "…it will not write into a session owned by another surface. Continue that session
  where it lives, or **start a new panel session**." (`:227`)

The fence doc (§5) already proved the specific sentence is unreachable for the turn that hits the
fence: `j.revived` is set only on the revive card, and `create()` never copies it, so the reply posts
with `revived: false` and takes the generic branch. For an assistant the generic branch is worse than
generic: its pane is bound to `rec.threadId` (`lib/assistant.js:3740`), so "start a new panel session"
is not an action that keeps the assistant — it is advice to abandon it.

### 2.2 The honest copy

One sentence, with the real id substituted, printed wherever a panel turn is refused for a reason a
terminal can fix:

```
This session is the CLI's; the panel cannot write into it.
Continue it in a terminal: hermes --resume panel-assistant-3
```

Three rules for it:

1. **It names the command, not a workaround.** `hermes --resume <thread>` is the string the code
   already owns (`console-lines.js:225`); the reset path reuses it rather than inventing prose.
2. **It says what resume does not do.** Resume reopens the conversation; it does not replay the lost
   turn. The resolve settles that turn `interrupted` and the admission's payload is not re-sent, so
   the reader resumes and sends the prompt again. The confirmation copy in §4.3 says exactly that.
3. **It never says "start a new panel session"** anywhere in the reset path — not in the refusal, not
   in the success line, not in the dry run.

### 2.3 Two fences, named separately

The reset must not blur them, because it can only move one:

| fence | wire answer | who owns it | what clears it |
|---|---|---|---|
| unknown admission (`unknown_execution`) | 409 on stop/resolve mismatch; 202-then-stall on `POST /v1/runs` | the durable store, per session | `resolve-unknown` with both ids — **this reset** |
| session admission (`permission_denied`) | 409 `permission_denied` on `POST /v1/runs` | `session_api_turn.py`, before a run exists | nothing this panel can send: `hermes --resume <thread>`, or a re-home (out of scope) |

So the success copy says "fence cleared", not "answerable". If the session is the CLI's, the reset
succeeds and the next panel turn is still refused — for a different reason, with a different remedy,
and the copy must have already named it. A reset that promised "answerable" would be the third
misleading sentence in this path.

### 2.4 What the panel must not do to get there

- It does not preflight the session's source before posting. The store is a cache of the gateway's
  state, not the authority (fence doc §7.2): a stale row would grey out a working reply box. The
  honest default stays "post, read the 409, name the remedy".
- It does not disable the reply box after a reset on a guess. If the thread is API-owned the next
  post works; if it is not, the 409 arrives and the copy is already right.
- It does not offer "re-home" as a reset option. That changes `rec.threadId`, splits the transcript
  and is a decision for the reader, not a repair.

## 3. The API shape

### 3.1 The route

```
POST /api/assistants/:id/reset
```

This is the first path-param route in the server (every existing route is an exact string, or a
query parameter — `lib/assistant/queue.js:1233`). It follows the same shape as
`createQueueRoutes`: a factory that takes `{ assistant, config, sendJson, readBody, authorised }`,
returns `false` when the route is not its own, and is called from the dispatcher beside the queue,
pipeline-window and catalogue routes (`server.js:2541-2549`). Matching is explicit:

```js
const m = /^\/api\/assistants\/([^/]+)\/reset$/.exec(route);
if (!m) return false;
```

`GET` on the path is 405 (the dry run is a POST with a body, not a GET, so the read never depends on
query-string parsing of a path id). Writes require `authorised(req, config.token)`, like every other
POST.

### 3.2 The request

```json
{"dryRun": true, "reason": "reader pressed \"Reset Assistant #2\" in Settings → Gateway"}
```

- `dryRun` defaults to `false`. It is the only thing that decides whether the gateway is asked to
  settle anything.
- `reason` is optional; it is journalled, and a missing one becomes the UI's own sentence.
- No confirm token. A script's confirmation *is* the dry run: it can read the rows, decide, and send
  the real call. The UI's two-press (§4.2) is a second, human confirmation, not a wire requirement.

### 3.3 What the dry run does

The dry run is the real enumeration with the mutating call removed:

1. read the roster (`assistant.state()` → `assistants[]`), resolve `:id` → `rec` (`threadId`, `name`);
2. read `session_admissions` for `target_session_id = rec.threadId AND status = 'unknown'`
   (read-only `node:sqlite`, the pattern `lib/session-usage.js` already uses against the same file);
3. list this assistant's cards: `jobs` where `j.thread === rec.threadId`, `j.runId`, and the card is
   not executing (§3.5) — including `interrupted`/`runGone` cards, because those are exactly the
   written-off ones;
4. `GET /v1/runs/{runId}` for each candidate, to learn `status`, `admission_id`,
   `execution_generation` — from the gateway, never from the card's cache;
5. cross-reference (2) and (4): a store row with a card that still answers `unknown` is **clearable**;
   a card whose run answers something terminal is **already settled**; a store row with no card is
   **unnameable**;
6. list `pendingWake` entries for this assistant, and `watches` it owns;
7. count what is kept (queue rows, notes/rules lengths, charter chars/sha).

No POST is sent. A GET has no side effect, so a dry run cannot clear anything.

### 3.4 The response — one envelope, two tenses

The dry run and the real call share a shape, so the UI renders both with one painter. Ids are
abbreviated here; every value is the row the endpoint actually read:

```json
{
  "ok": true,
  "dryRun": true,
  "assistant": {"id": "assistant-2", "name": "Assistant #2", "threadId": "panel-assistant-2"},
  "clear": {
    "admissions": [
      {"runId": "run_3ea61cf9…", "admissionId": "a1209a5f…", "executionGeneration": 1,
       "card": {"id": "3f9a1c02", "status": "interrupted", "startedAt": "2026-11-04T01:02:11Z"},
       "evidence": {"runStatus": "unknown", "answers": [[1793840401, "unknown"], [1793840431, "unknown"]]},
       "action": "resolve-unknown"}
    ],
    "wakes": [{"reason": "watch finished: land the queue fix", "rule": "watch", "assistantId": "assistant-2", "at": 1793841000}],
    "watches": [{"id": "9c2d1e77", "thread": "wtgui-land-the-queue-fix-1a2b3c", "title": "the queue fix is pushed", "at": "2026-11-04T00:40:00Z", "state": "watching"}]
  },
  "keep": {
    "queue": {"rows": 6},
    "scratchpad": {"notes": 1184, "rules": 12, "journal": 340, "alerts": 4},
    "charter": {"chars": 20431, "sha": "6f1c…"}
  },
  "block": {
    "unnameable": [],
    "queued": [{"runId": "run_51ea12df…", "executionGeneration": null, "card": "0b7e4411"}]
  },
  "verdict": "clearable",
  "stillFenced": true
}
```

Rules for the payload:

- Every row is a row, not a count. The dry run's whole job is "exactly what would be cleared", and a
  count cannot be checked against the store.
- `verdict` is one of `clearable` (every unknown row has a run), `blocked` (at least one row has
  none), `clean` (nothing is fenced). A blocked dry run is the same envelope with the unnameable rows
  filled and `clear.admissions` still naming what it can (see the blocked copy in §4.3): the reset
  will resolve those rows, will not clear anything local, and will report `incomplete`.
- `stillFenced` is computed from the **store re-read**, not from the cards and not from the receipt.
  On a dry run it is today's truth; on a real call it is the truth after the resolves.
- The real call answers with `cleared` and `kept` instead of `clear` and `keep`, plus `receipts`:
  one row per resolve with the gateway's 200 body (or its error code), so the UI can print
  `interrupted` from the receipt and `cancelled` from the projection without conflating them.

### 3.5 The live-run refusal

`409 assistant_live` while this assistant has a run **executing**. The check is per run, from the
gateway's answer:

- refuse on `status` `started` or `running`, or a non-empty `pending_controls`;
- do **not** refuse on `queued`. A queued run is admitted work behind the fence: the reset is the
  only thing that can drain it, and `assistantLive()` (`lib/assistant.js:3500`) counts `starting` and
  `waiting` (via `LIVE_JOB_STATUS`, `lib/jobs.js:174`), which is how a card sitting at `queued` would
  make the reset permanently refused by the very fence it exists to clear. That deadlock is a design
  bug, not a conservative choice.
- a queued run is named in `block.queued` and in the confirmation copy: clearing the fence lets it
  start (fence doc, row #15 — the queued admission drained and completed by itself).

```json
{"error": "not reset — Assistant #2 has a run still executing (run_51ea… · started 12m ago). Wait for it or stop it on its card; a reset never touches an executing turn.",
 "code": "assistant_live",
 "runId": "run_51ea12dfa92c4f339a8fc4b9af0e9e23", "thread": "panel-assistant-2"}
```

### 3.6 Status codes

| status | code | when |
|---|---|---|
| 200 | — | dry run, or a real call that settled everything it named (including "nothing to do") |
| 200 | — | real call, `ok: false`, `verdict: "incomplete"` — a resolve failed; nothing local was cleared |
| 400 | `invalid_params` | `dryRun` not a boolean, or an unknown field that would change meaning |
| 403 | — | missing/bad `x-panel-token` |
| 404 | `assistant-unknown` | `:id` is not in the roster (the same code the queue routes use) |
| 405 | — | any method but POST |
| 409 | `assistant_live` | a run is executing |
| 409 | `fence_unclearable` | every unknown row on the session is unnameable — there is nothing this endpoint can do, and clearing the watches would be a lie |
| 409 | `reset_in_progress` | a second reset for the same assistant is already running (single-flight; the gateway resolve is idempotent, the local clearing is not) |

`fence_unclearable` is the honest refusal that keeps §5.3's invariant. It carries the admission ids
and generations it could not name, so the reader (or a future gateway route) has the rows.

### 3.7 Order of operations

1. single-flight guard;
2. enumerate (the dry-run steps 1-7);
3. refuse (`assistant_live`, `fence_unclearable`) before any mutation;
4. resolve every clearable admission, sequentially, each body built from its own GET;
5. re-read the store; any row still `unknown` ⇒ `verdict: "incomplete"`, **stop** — do not touch
   wakes or watches;
6. only when no row remains unknown: drop the wakes (§1.2), drop the watches (§1.3), journal one
   `reset` entry, persist;
7. respond with receipts and the post-state.

Gateway first, local second. A half-reset that has deleted the evidence of a fence it did not clear
is the failure mode this order exists to prevent.

## 4. Where the control sits

### 4.1 The row

Settings → Gateway, in the existing restart row (`public/index.html:471-476`), as the third control:

```html
<button id="btn-restart-gateway" …>Restart gateway</button>
<button id="btn-restart-panel" …>Restart panel</button>
<select id="reset-assistant" title="which assistant this resets">…</select>
<button id="btn-reset-assistant" type="button"
        title="Reset Assistant #2 — settle its gateway turn, drop its watches and queued wakes. Keeps its queue, scratchpad and charter.">Reset assistant</button>
<div class="settings-preview mono" id="reset-preview">…</div>
```

Why beside the restarts: it is a control-plane operation, not a chat action. It does not write to the
conversation, it repairs the same kind of thing the two restarts repair, and that row's existing
copy already teaches the reader that these presses answer at once and touch nothing else. It gets its
**own** `#reset-preview` line so a reset outcome never overwrites the restart line's last answer.

The `<select>` is drawn from `assistant.state().assistants` and hidden when there is one; the label
is the assistant's name, the option title carries `threadId`. With one assistant the button's title
and the preview still name it, so the control never says "reset" without saying whose.

### 4.2 The press

Two presses, following the pattern the panel already uses for a destructive settings write
(`clearProviderKey`, `public/app.js:18259`: `dataset.armed`, a label that changes, a timed disarm):

1. **first press** sends `{dryRun: true}` and paints `#reset-preview` with the rows from §3.4. The
   button becomes `reset Assistant #2?` and stays armed for 10 s — longer than the existing 4 s
   because this confirmation has a list to read, not one word.
2. **second press** sends the real call.

Only this button disables for the length of its own request; the two restart buttons stay pressable,
matching the row's existing rule that a press disables itself and nothing else. No modal: a
`window.confirm` cannot show the dry run's rows, and the rows *are* the confirmation.

### 4.3 The confirmation copy, verbatim

Ids below are placeholders except where they name the live `panel-assistant-3` row from §1.1; the
dry run substitutes the real ones.

Dry run, nothing fenced:

```
Assistant #2 · panel-assistant-2 — nothing is fenced. Nothing to clear.
keeps: 6 queue rows · 1184 notes · 12 rules · charter 20431 chars
```

Dry run, clearable:

```
Assistant #2 · panel-assistant-2
would clear: 1 unknown admission (run run_3ea61cf9… · generation 1, unknown for 4m)
           · 3 watches (2 on workers, 1 on its own turn)
           · 1 queued wake (watch finished, queued 6m ago)
keeps: 6 queue rows · 1184 notes · 12 rules · charter 20431 chars
also: 1 turn queued behind the fence will start when it clears (generation null)
press again to reset. The settled turn is reported interrupted and is not replayed — resend it if you still want it.
```

Dry run, blocked (Assistant #3, the live row from §1.1):

```
not reset — the fence on panel-assistant-3 is held by an admission no card here names
(admission 16e7a6a7… · generation 63). This endpoint can only settle an admission through the run
that owns it; there is no session-keyed resolve. Nothing would be cleared, including the watches.
Continue that session in a terminal: hermes --resume panel-assistant-3
```

Refused, live run:

```
not reset — Assistant #2 has a run still executing (run_51ea… · started 12m ago).
Wait for it or stop it on its card; a reset never touches an executing turn.
```

Success:

```
reset — Assistant #2: 1 admission settled (interrupted; the projection now reads cancelled),
3 watches dropped, 1 wake dropped. Kept 6 queue rows, the scratchpad and the charter.
If a panel turn is still refused with 409 permission_denied, the session is the CLI's:
continue it with hermes --resume panel-assistant-2
```

Incomplete:

```
reset INCOMPLETE — 1 of 2 admissions cleared; the session is still fenced, so nothing local was
cleared (3 watches and 1 wake kept). Re-run to retry the remaining row.
```

The last two lines of the success copy are the resume path from §2, delivered where the reader will
actually be standing when they need it.

### 4.4 After the press

- Success or incomplete: the preview keeps the outcome until the next press; a banner says
  `reset: Assistant #2` (or `reset incomplete`).
- Refusal: the preview goes `.bad` and names the run or the admission.
- The page does not reload, does not restart anything, and does not disable the reply box. If the
  reset cleared the fence, the next message posts; if the session is the CLI's, the 409 and its copy
  arrive as they do today.

## 5. Failure modes it must not create

### 5.1 Losing queued work

Invariants:

- queue rows and `spawnIntents` are read for the `kept` counts and never written;
- queued admissions and their cards are left live; the reset settles nothing about a turn that has
  not executed;
- only `pendingWake` entries routed to this assistant are dropped, and each is journalled;
- `terminalWakes`, `restartWakes` and the hourly `wakes` ledger are untouched.

Acceptance: a reset with 6 queue rows leaves 6; a card at `queued` behind the fence still completes
after the reset and its result lands on its card; a wake belonging to Assistant #3 is still in
`pendingWake` afterwards.

### 5.2 Two runs in one cwd

Invariants:

- **the reset posts no run.** Its code path contains no `POST /v1/runs`; a test can assert zero run
  creations and zero requests to `/v1/runs` other than `resolve-unknown`;
- it does not settle the queued card, so `busyFor(thread)` (`lib/jobs.js:3635`) still sees it and
  still refuses a reply in that thread or tree — the same guard `/api/assistant/answer` relies on;
- it never writes to `assistant-cwd` or any worktree.

Acceptance: with a queued card on the assistant's thread, a reply is refused with the busy-thread
sentence both before and after a reset; the queued run completes once, and no second run exists in
the assistant's cwd.

### 5.3 A fence left standing

Invariants:

- the resolve body is built from a GET in the same request (both ids current);
- a 409 `stale_generation` / `not_found`, a 404 `run_not_found`, or a transport failure is a failed
  row, not a cleared one;
- local clearing happens only after the store re-read shows no `unknown` row for the session;
- `stillFenced` is in every response and the UI never paints the success copy while it is true;
- the exact body is retried once on a transport error (idempotent) and never on a 409;
- the gate is the store and a post-reset `POST /v1/runs`, not the card's status. A reset that flips a
  card but leaves the row is precisely today's bug with a new button on it.

Acceptance, on a throwaway session seeded with an unknown admission (the fence doc's probe is the
recipe): resolve through the route → `GET /v1/runs/{id}` reads `cancelled` → a fresh
`POST /v1/runs` on that session is accepted and completes. Then the same for `panel-assistant-*`,
which is the only proof that matters for this feature.

### 5.4 Three more it must not create

- **Clearing another assistant's state.** Watches are filtered by `watchOwnerOf`, wakes by
  `assistantId`, admissions by `target_session_id = threadOf(id)`. Never `ASSISTANT_THREAD`, which is
  only Assistant #1's id (`lib/assistants.js:23`).
- **A duplicate restart wake.** Do not clear `restartWakes`; a reset is not a restart and must not
  make one report twice.
- **A "successful" reset that only changed the panel.** By design: the store re-read is the verdict,
  and the endpoint is allowed to say `incomplete`.

## 6. Prerequisites

Four small changes this design needed before the route could be honest. All four are in the tree: 2, 3 and 4 as
written below, and 1 is deliberately NOT built — the route does a fresh `GET /v1/runs/{id}` per candidate instead, so
the card's cache cannot reach the wire (the cost §1.1 accepted).

1. `lib/jobs.js`: store `j.admissionId` at `adoptRun`/`poll` from the same GET that already yields
   `execution_generation` (`:3231`, `:3321`). **Not built, by choice:** the reset reads the pair from its own GET.
2. `lib/assistant.js`: add `at` to `pendingWake` entries at enqueue (`:3817`). **Built.**
3. `lib/assistant/reset.js`: the route factory, the enumeration, the resolve loop, the clearing,
   following `createQueueRoutes`'s shape. **Built.**
4. `lib/assistant/reset-store.js` (or a function in the factory): the read-only `session_admissions`
   query, `DatabaseSync`, no writes — the same pattern as `lib/session-usage.js`. **Built.**

## 7. What is measured, and what is designed

Measured, and cited above:

- the endpoint table in `bb7fdb5` — every status and body in §1.1 is a row from that run;
- the live store at design time: 18 `unknown` admissions across 18 sessions, generations 1…63,
  `owner_epoch` 3…18 against a current `runtime_epoch` of 19, one of them `panel-assistant-3`
  (`16e7a6a7…`, generation 63, epoch 18). Read-only; no row written;
- the code paths named by file and line.

Designed here, and built and measured since — each with a proof the reader can re-run:

- the route, the payloads and the placement: `node tools/verify-assistant-reset.mjs` drives a real panel over HTTP
  with a stub gateway per run, one request per state (dry run, `409 assistant_live`, `409 fence_unclearable`,
  success, incomplete), and asserts the resolve body is `{admission_id, execution_generation}` from a fresh GET, that
  `/stop` is never called, that the store re-read is the verdict, and that the local half runs only after it;
- the copy and the control: `node tools/verify-assistant-reset-ui.mjs` drives the five states in Chromium against the
  same real route, including that a dry run sends no POST, that a refusal disarms the button, and that the success and
  incomplete copy name `hermes --resume <thread>` with the real thread id;
- the measurement this document said a build must make before landing — an unknown admission resolved through the
  route, the store row settled and the projection then reading `cancelled` — is the success section of the first
  gate, against the sandbox's own store and a stub gateway. What neither gate proves is the part that needs a REAL
  gateway: the live `panel-assistant-*` session, and a queued turn behind the fence draining afterwards. Both settle
  a real turn as `interrupted` on a real store, which is a reader decision and not something a gate should do
  unasked. The route's order is what makes that safe to try: gateway first, local second, and `incomplete` when the
  store is still fenced.
