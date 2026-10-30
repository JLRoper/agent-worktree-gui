# Architectural review — the panel's own state machine

**Lens: functional correctness.** Where the panel's record of a run can lose, double-count or invent
state. No code was changed, no push, no server started; every claim below was read out of this
working tree or measured with a read-only Node probe against the real modules (see *How the evidence
was produced* at the end).

- Snapshot: `main` at **b64642d** ("Previous turn on send is a three-way setting, not one fold").
- Line numbers are from that snapshot. This tree is edited continuously; a number that is off by a few
  lines still points at the named function.
- **`[measured]`** means I drove the shipped code and quote its output. **`[read]`** means the claim is
  a control-flow argument from the cited lines and I did not execute it.

---

## The verdict in one paragraph

The panel has **four terminal paths for a run** (`settle`, `adoptRun`, `markInterruptedByRestart`,
`markRunGone`) and **three ways to end one** (`settle` on a stream event, `poll` on the status
endpoint, a restart's `interruptRunning`). They do not share a guard, an idempotence key or a
"who ended this" rule, so they disagree in ways that are individually small and collectively
expensive: a turn the panel watched to the end can be re-written as a restart loss, a stop that never
left the process can be recorded as the cause of death, and a clear-finished press can delete the card
of a run that is still being admitted. Two of the paths also write control calls — approval and
clarify answers — whose target prompt is picked by **string-matching a redacted command**, falling
back to "the first pending control of this kind" when the match fails. That fallback is the worst
finding in the file: it can deliver an approval to a command the reader never saw.

The admission path is the good half. `create()` is careful, records what only the panel can know
(base sha, gateway pid, the cut point of the tree), and refuses to guess. The settle path is where
the rigour stops.

---

## 1. The lifecycle as it actually runs

One row per transition, with the code that performs it. `L` = live (`running` / `starting` /
`waiting`, `LIVE_JOB_STATUS` at `lib/jobs.js:135`), `T` = terminal.

| # | From → to | Who performs it | Notes |
|---|---|---|---|
| 1 | (none) → `starting` | `create()` `lib/jobs.js:1787`, inserted into the map at `:1829` | The card exists before any worktree does. |
| 2 | `starting` → `failed` | `create()` worktree cut fails, `:1887-1896` | `finalise` runs, so the notice can say it never started. |
| 3 | `starting` → `waiting` | 429 from the POST, `:2055` | Held with `j.waiting`; the only L→L transition. |
| 4 | `waiting` → `cancelled` | `giveUpHeld()`, `:2020-2029` | Read via `j.cancelRequested` only inside the hold loop (`:2053`, `:2072`). |
| 5 | `waiting|starting` → `failed` | transport error `:2077-2085`; non-2xx `:2087-2107`; no `run_id` `:2119-2126` | Each calls `finalise` + `emit`. |
| 6 | `waiting|starting` → `running` | accepted POST, `:2110-2134` | `runId`, `gatewayPid`/`gatewayStart` (`:2114-2118`), wall-clock cap (`:2138`), poller (`:2149`), stream (`:2161`). |
| 7 | `running` → `T` (run's own word) | `settle()` `:2488`, from the terminal stream event (`:2463-2472`) or from `poll()` (`:2562-2566`) | The only path that clears the approval **and** the clarify box. |
| 8 | `running` → `T` (gateway's word, panel did not watch) | `adoptRun()` `:2707` — from `settleRestoredRun` `:2599-2601`, `sweepOrphanedRuns` `:2995-3002`, `restart.interruptRunning` `lib/restart.js:487-489` | **No status guard.** |
| 9 | `running|starting` → `interrupted` | `markInterruptedByRestart()` `:2827` — 404 from `sweepOrphanedRuns` `:2991`, `writeOffUnknownRun` `:2809`, `restart.interruptRunning` `:494` | Guarded at `:2829`. Records `terminate()`, stops the clocks, leaves the control boxes up. |
| 10 | `interrupted` → `interrupted` + wording | `markRunGone()` `:2684` — a 404 on a restored card `:2611`, or the NOT-RUNNABLE chip `:2620` | Idempotent by comparing `j.error` (`:2690`). |
| 11 | `interrupted` → `running` | `reattachRestored()` `:2645` — from `settleRestoredRun` `:2606` | Clears `error`/`completion`/`outcome`, re-arms the 15s poller, **does not** re-arm the cap. |
| 12 | `L` → `interrupted` (panel restart) | `load()` `:629-643` | `endedAt = lastSeenIso(j)` `:638`, `restoredLive` `:641`. |
| 13 | any → gone | `clearFinished()` `:3490-3493`, `clearThread()` `:3498` | `clearFinished` uses `!== "running"`, `clearThread` uses `isLiveJobStatus`. They disagree. |

Who asks the gateway about a card afterwards:

| Question | Caller | Where |
|---|---|---|
| "what does the gateway say about this run?" | `runProbe` | `:2762` |
| boot reconcile of every `interrupted` card | `reconcileRestored` | `:2579`, called from **two** places: `server.js:4210` and `lib/restart.js:820` |
| every 15 s sweep of every live run | `sweepOrphanedRuns` | `:2981`, timer at `server.js:709-727` |
| the runs an inherited card points at | `stopStaleRuns` | `:2937`, `server.js:4221` |
| control calls | `controlContext` | `:3097` |
| approval expiry | `sweepApprovals` | `:484`, timer at `:456-459`, every 5 s |
| clarify expiry | *nothing* | — |

### How a killed run is resolved

`stop()` `:3316` records `terminate(j, "reader")` **before** the request (`:3321`), posts to
`/v1/runs/{id}/stop` and prints "stop requested" without checking the response. The run is then
expected to end through its own terminal event, which lands in `settle` and becomes `cancelled`; the
`termination` record makes `outcomeFrom` call it `interrupted` / "stopped from the panel"
(`lib/completion.js:104-109`). The wall-clock cap takes the same route (`:2138-2146`) with
`terminate(j, "cap")`. `terminate` is first-wins (`:1543`) — the right rule, and the one thing in this
area that is exactly right.

The gap: `stop()` never checks `res.ok` and never journals (`:3325-3331`), while the *other* stop
helper `stopRunAtGateway` (`:2864`) journals every ask and treats 404/409 as success. So the two
stops disagree about whether a refused stop is recorded at all — and `stop()`'s `terminate()` is not
rolled back when the request fails.

---

## 2. Findings, ranked by the damage they do when they fire

### F1 — An approval can be granted to a different command than the reader saw `[measured]`

`controlContext()` reads the run's `pending_controls`, filters by kind, then:

```js
const want = kind === "clarify" ? String(j.question?.question || "") : String(j.approval?.command || "");
const pick = mine.find((c) => want && String(...) === want) || mine[0];   // :3117-3118
```

The `|| mine[0]` fallback is unconditional. `approve()` then uses `ctx.promptId` as the request id
(`:3174-3180`). So when the card's `command` string does not byte-match any pending control — a
redacted command, a truncated one, a re-worded `description`, or a card that was drawn for an
approval that has since been replaced by another — **the answer goes to the first pending approval of
that run.**

Measured, two approvals parked (`git push --force` first, `rm -rf build` second), the card showing the
second but its command text not matching:

```
G.matching_command  → request_id "prompt-SECOND"  (correct)
H.unmatched_command → request_id "prompt-FIRST"   (the reader approved git push --force)
```

The approval event usually names no request id (`:2383-2386` says so), so this fallback is not a rare
corner — it is the normal resolution path for any card whose command string drifted. Damage: an
approval the reader did not give. It is the highest-ranked item because the consequence is authority,
not display.

The self-heal retry makes it worse rather than better: on `invalid_params`/`stale_generation` the
panel re-reads `controlContext` and **substitutes whatever prompt id it now finds** before re-sending
the same answer (`:3199-3215`). Measured — the same "once" was re-sent from `prompt-OLD` to
`prompt-NEW`:

```
I.self_heal_retry → [{request_id:"prompt-OLD", generation:4}, {request_id:"prompt-NEW", generation:5}]
```

### F2 — A stale clarify answer is delivered to another question `[measured]`

`answerQuestion()` (`:3248`) has **no** "is there still a question on this card" guard, no choice
validation and no deadline check — unlike `approve()`, which checks all three (`:3144-3170`). It falls
through to the same `mine[0]` pick. A page holding a question the card no longer has (answered on
another surface, cleared by `settle`, cleared by an `error` event at `:2481-2485`, or a reload) posts
its answer to the run's first parked clarify.

```
L.stale_clarify_answer → {"answer":"yes, delete it","request_id":"q-OLD"}   // q-OLD = "Which environment?"
M.matched_clarify_answer → {"answer":"yes","request_id":"q-NEW"}            // control
```

The route's comment (`server.js:3079-3081`) says "the gateway re-validates the prompt id … so a stale
card cannot answer a question that has already been settled". That is true of an id the gateway no
longer holds, and false of this path: the panel replaces the id with a live one before it posts.

### F3 — `adoptRun` has no status guard: a run the panel watched to the end is re-written as a restart loss `[measured]`

`adoptRun` (`:2707-2734`) sets `j.status`, clears `j.error` (`:2710`), pushes "run … in the gateway ·
this panel lost the stream at a restart" (`:2718-2721`), pushes `run.output` **again as a text line**
(`:2722-2726`) and re-runs `finalise` (`:2730`), which rebuilds `outcome`/`durationMs`/`completion`.
No `isLiveJobStatus` check.

Both of its callers hold a snapshot taken before an `await`:

- `sweepOrphanedRuns`: `watching = this.runningJobs()` at `:2982`, then `await this.probe(...)` (`:2986`)
  and one `await this.runProbe(j)` per card (`:2990`) — up to 8 s each, sequentially.
- `restart.interruptRunning`: `running = this.jobs.runningJobs()` at `lib/restart.js:478`, then
  `await this.jobs.runProbe(j)` at `:483`.

A run that settles through its own stream inside that window is adopted on top of its own settle:

```
A.settled_then_adopted → textLines: ["PROBE ANSWER","PROBE ANSWER"]
                         resultLines: ["run completed in the gateway · this panel lost the stream at …"]
B2.adopt_twice        → texts: ["TWICE","TWICE"], results: 2 identical "lost the stream at a restart" lines
```

Three separate harms: the answer is printed twice; the card claims a provenance that is false (the
panel watched it end); and `j.error = ""` erases the reason a failed or capped run carried. The same
window produces the duplicate re-attach line when the run is still live (`B.two_reconcile_passes`).

### F4 — A stop that never left the process is recorded as the cause of death `[measured]`

`stop()` writes `terminate(j, "reader")` at `:3321`, before the request, and never reverses it.
`outcomeFrom` consults `termination` **before** the run's own word (`lib/completion.js:104-109`). So
after a stop the gateway refused, a run that later fails on its own is reported as
`interrupted — "stopped from the panel"`, not `failed`.

```
stop_unreachable → {returned:false, lines:[], journal:0, status:"running", terminated:"reader"}
stop_HTTP_500    → {returned:true,  lines:["stop requested — the turn ends at its next safe point"], journal:0}
```

Two lies in one path: the card says the stop was requested when the gateway answered 500, and it
keeps a termination record for a request that threw before leaving the box. Because `terminate` is
first-wins, the *wrong* cause also wins over a later, true one (a cap kill or a gateway interruption).

### F5 — `clearFinished()` deletes the card of a run that is still being admitted `[measured]`

`:3491` filters `j.status !== "running"`; the panel's own definition of live includes `starting` and
`waiting` (`:135`). A "clear finished" press during the worktree cut (`create()` `:1844-1898`, which
runs `git worktree add`, the naming ledger and the push guard before the POST) or during a 429 hold
removes the card from `this.jobs`.

```
K.clear_finished → {startingKept:false, waitingKept:false, doneKept:false}
```

`create()`'s continuation then works on an orphaned object: the POST is accepted, `j.status = "running"`
(`:2127`), a stream and a poller are attached to a job no map holds — and every sweep, the busy-thread
refusal (`busyFor` `:2960`) and the row's agent chips (`agentPaths` `:3390`) read the map. The run is
real, holds a concurrency slot and edits a tree, and the board has no card for it.

`clearThread()` gets this right (`:3500`), which is what makes the other one a bug rather than a
policy.

### F6 — A completion the persist debounce swallowed never reaches the assistant `[measured]`

`settle()` emits and `emit()` schedules the store write 700 ms later (`:665-735`). If the process dies
inside that window, the store still has the card `running`; on boot `load()` stamps it `interrupted`
with `endedAt = lastSeenIso(j)` (`:638`) — a time from the *previous* process — the reconcile then
recovers the truth via `adoptRun`, and `adoptRun` sets `j.endedAt = j.endedAt || lastSeenIso(j)`
(`:2717`). So the finished card keeps an `endedAt` that predates this boot, and `noteSettle` refuses
anything that ended before `bootedAt` (`lib/assistant.js:1269-1270`). The interrupted rule only fires
for cards still reading `interrupted` (`:1106`), and this one now reads `done`.

```
J.wake_after_adoption → {cardStatus:"done", endedAt: 21:27:08, bootedAt: 21:27:13,
                         terminalKey:null, queuedSettles:0}
```

Damage: work lands, the branch is ready, and nobody is told. The card is correct; the sentry is deaf.
This is the panel-side answer to "what happens if the gateway restarts mid-settle": the *run* is
recovered and the *notice* is not.

### F7 — `tree.pending` freezes forever if the process dies during the measurement `[measured]`

`settle()` starts `measureTree(j)` fire-and-forget (`:2533`). `measureTree` writes
`j.tree = {pending:true, …}` first (`:1583`) and only clears it at `:1679`. The store persists
`tree` (`:705`). `load()` re-measures only the jobs it restored as **live** (`:658`), and a settled
card is not one of them (`:622-643`). Nothing else ever calls `measureTree` for a settled card.

```
E.frozen_tree_after_reload → {status:"done", treePending:true, completionCommits:null}
```

The card therefore says "commits not measured" for the rest of its life, and every later notice for it
— `flushSettles` (`lib/assistant.js:1310`), `checkWatches` (`:1187`), the interrupted rule (`:1108`) —
quotes that. The 30 s grace in those rules is what makes it *file* the notice instead of waiting: the
one fact the landing decision needs is permanently missing.

### F8 — Two boot reconciles race over the same cards `[measured]`

`server.js:4210` calls `jobs.reconcileRestored()` inside the listen callback, and
`lib/restart.js:820` calls it again from `resumePending()`, which `server.js:699-701` starts 3 s after
boot. (`resumePending` only runs when a panel restart left a record — but that is exactly the boot
where every card is `interrupted`.) The filter is `j.status === "interrupted" && j.runId && !j.reconciled`
(`:2580`); `j.reconciled` is set *after* the `await` in `adoptRun` (`:2709`), so both passes probe and
both apply.

```
B.two_reconcile_passes → a:["job-1"], b:["job-1"], 2 identical "re-attached" lines
B2.adopt_twice        → the final answer printed twice
```

There is no in-flight claim on the card, while `follow()` has one (`j.following`, `:2175`) — the
pattern exists in this file and is not used here.

### F9 — The control boxes outlive the run, and only one of the four terminal paths takes them down `[measured]`

`settle()` clears `j.approval` (`:2507`) and `j.question` (`:2509-2510`).
`markInterruptedByRestart` (`:2827-2852`) and `adoptRun` (`:2707-2734`) clear **neither**:

```
settle                          → approval:null, question:null
markInterruptedByRestart        → approvalStillUp:true, questionStillUp:true
adoptRun                        → approvalStillUp:true, questionStillUp:true
```

An interrupted or adopted card therefore still offers "approve" / "answer" for a run this panel can no
longer address. The approval box self-heals within its window, because `sweepApprovals` (`:484-494`)
runs every 5 s. **The clarify box has no sweep at all** — `sweepApprovals` reads only `j.approval`
(`:487`) — so a question whose `timeout_s` window closed keeps its countdown and its buttons for the
life of the process. Measured after expiry: `{swept:1, approval:false, questionStillUp:true}`.

`settle()` also clears `j.approval` **without** writing `approvalDone` (measured: `approvalDone:false`),
so a run that ended with an approval parked leaves no record that a person was asked and never
answered — while the clarify box does get `questionDone` (`:2509`).

### F10 — The two writers of `approvalDone` disagree, and the later one loses the word `[measured]`

`approve()` writes the optimistic record with the choice the reader pressed (`:3234`). The stream's
`approval.responded` then overwrites it with `String(evt.choice || "")` (`:2446-2453`). When the event
carries no choice — which the panel's own comment at `:2383-2386` says this gateway often does not —
the record is blanked:

```
after_panel_approve      → {"choice":"once","command":"git push --force"}
after_stream_responded   → {"choice":"",    "command":"git push --force"}
```

The collapsed line then says an approval happened and cannot say what was approved, which is the one
thing `:2444-2452` exists to preserve.

### F11 — `approve` throws a raw TypeError when the 5 s sweep expires the box mid-answer `[measured]`

`approve()` reads `j.approval` at `:3144`, then `await this.controlContext(j)` at `:3174`, then writes
`j.approval.requestId = rid` at `:3177` without a re-check. `sweepApprovals` can run in that `await`.

```
approve_raced_by_sweep → {"ok":false,"error":"Cannot set properties of null (setting 'requestId')"}
```

The box is correctly gone (the sweep expired it), but the reader gets a JavaScript message and the
route answers 400 with no `code` (`server.js:3076`), so the page cannot tell it from a malformed
request. The deadline branch above it (`:3160-3170`) is the wording that should have been returned.

### F12 — A `LANDED: YES` is spent before the row lookup, so the "next tick" path is dead `[read]`

`server.js:4128` adds the job id to `checkedAnswers` before anything is checked. When the project is
known but the row is not on the board yet (`:4146-4154`), the code says "Do not spend the answer:
leave it for the next tick" — but the id is already in `acted`, and `answeredChecks` filters on
`acted.has(job.id)` (`lib/verify-landed.js:35`), so the next tick skips it forever. The tree stays and
the delete never happens.

Damage is one missed delete, not a wrong one — which is why it is this far down. It is on the list
because a comment states the opposite of what the code does, so a reader will trust it.

### F13 — `cancel()` cannot stop a run that is still being admitted `[measured]`

`cancel()` handles `waiting` with a flag and `running` with `stop()`, and returns `false` for
everything else (`:3334-3346`). `starting` is everything else — the worktree cut and the POST, which
are seconds. `create()` also never re-reads `j.cancelRequested` after acceptance (`:2127-2161`); the
flag is consulted only inside the 429 loop (`:2053`, `:2072`).

```
D.cancel_starting → {cancel:false, cancelRequested:false, stop:false, status:"starting"}
```

So the reader's stop is a no-op for the whole admission window, and the worktree the panel is cutting
for a run nobody wants is left behind as well.

### F14 — The row verdict is carried over from a commit *count* `[measured]`

`Store.putRow` in fast mode keeps the previous verdict when `incoming.ahead === prev.fullAhead`
(`lib/store.js:108-114`) and marks the row not stale. A branch that was rebased or amended in place
has the same number of commits off main and entirely different content:

```
N.verdict_carried_by_count → afterFull:"MERGED (by patch-id)", afterFast:"MERGED (by patch-id)",
                             verdictStale:false, headSeen:"ccccccc"
```

`mergeable` is then true for it (`:127-129`), so the board's "safe to remove" count includes a branch
whose work was never classified. The delete itself does not gate on `mergeable`
(`lib/worktree-remove.js`), so this is a display and decision-support defect, not a data-loss one.

---

## 3. State inferred from a side effect rather than recorded

Each of these is a place where the panel decides a fact from something it can observe, instead of
from a record it wrote. Judged: **sound**, **sound-but-leaky**, or **wrong**.

| Fact | Inferred from | Where | Judgement |
|---|---|---|---|
| A row's verdict is still valid | the count of commits off main being unchanged | `lib/store.js:108-114` | **Wrong.** A count is not an identity — see F14. `[measured]` |
| A worktree is live | *some* process on the box is listening on a port the tree's `.env` declares | `lib/activity.js:68-79` (port numbers only, no pid), `:468`, `:504`, `:516` | **Sound-but-leaky.** Any listener on that port makes the tree live — a leftover server, or another tree that declares the same port. It feeds `intervalFor` (5 s cadence) *and* `mergeable` (`lib/store.js:127-129`), so a stray listener keeps a row out of "safe to remove". `[read]` |
| A coordination-board claim is alive | a pid in `.agentboard/*.json` is in `tasklist` | `lib/activity.js:465` | **Sound-but-leaky.** No start time is compared, so a recycled pid reads as alive. `[read]` |
| A run belongs to a dead gateway | `gateway_state.json`'s pid + start fingerprint vs the card's stamp | `:2918-2931` | **Sound.** Explicitly refuses to compare on Linux clock ticks (`gatewayStartMs`, `:202-224`). The action it authorises is a stop whose 404 is tolerated, so a false positive costs one request. `[read]` |
| The gateway "no longer has" a run | one 404 | `:2769`, acted on at `:2611`, `:2692-2696` | **Sound-but-leaky.** A 404 from a *different* gateway process looks identical to a run that ended. The wording is careful ("no record of run X any more … never saw its outcome"), and `runGone` is not persisted as a verdict on the work — only on the card. `[read]` |
| A tree's parent branch | the branch reflog's `Created from` line | `lib/parents.js:61-76`, `:131-136` | **Sound.** The panel records the cut itself (`:1449-1459`, `rememberParent`), so the reflog is a fallback, and `parentBranchFor` (`:1502-1530`) prefers the record. Leak: a parent resolved later from the reflog never reaches `j.parentSource`, which stays `"unknown"` on the card. `[read]` |
| What a turn produced | `git rev-list --count <base>..HEAD` against the `baseSha` recorded at create | `:1650`, base at `:1903` | **Sound.** The base is recorded, not guessed; the note distinguishes "counted zero" from "could not count" (`:1653`). `[read]` |
| A check agent's answer | a model's `LANDED: YES` line | `lib/verify-landed.js:41`, acted on at `server.js:4156` | **Sound-but-leaky** *by design*: the answer is prose, and the panel bounds it (15 min age, explicit word) and re-reads lock/dirty/live at delete time. Worth keeping the re-reads; they are the only thing between a hallucinated YES and a worktree. `[read]` |

---

## 4. Paths that cannot fire, and errors that are swallowed

1. **`server.js:4146-4154`, the "leave it for the next tick" branch — dead.** See F12; the id is
   already in `acted` at `:4128`. `[read]`
2. **`approve`'s retry, when the generation did not move (`:3204`), is unreachable for the error it
   was written for.** The comment at `:3196-3198` says `invalid_params` means "a body the authority
   will not read without a generation". If the gateway refused the *shape*, re-reading the run cannot
   change anything, `moved` is false, and the reader gets the raw code. `[read]`
3. **`stopRunAtGateway`'s `skipped` return (`:2869`) can only be reached from `restart.interruptRunning`**
   with a `starting` card; every other caller filters on `j.runId`. That is by design, but it means the
   journal's "nothing in the gateway to stop" case is never exercised by the sweep. `[read]`
4. **`poll()` treats every non-2xx as "still running" (`:2555`).** A 401 from a rotated key, or a 500,
   is indistinguishable from a healthy quiet run: the backstop that exists so "a card cannot stay
   running forever" stops asking, silently, for as long as the condition lasts. `[read]`
5. **`stop()` never inspects the response (`:3325-3327`).** A 404, a 500 and a 200 all produce the same
   "stop requested" line and the same `true`. This is the unreachable-error case that matters most,
   because it is the path with no journal — see F4. `[measured]`
6. **`markInterruptedByRestart` refuses a card that has already settled (`:2829`), and that is the one
   guard `adoptRun` is missing.** Its callers read the return only to decide whether the card joins the
   `lost`/`interrupted` list (`:2992`, `lib/restart.js:494`) and never re-check the status afterwards;
   the `:2829` test is the whole reason a late 404 cannot overwrite a settled card the way F3 shows a
   late adopt doing.

---

## 5. Two writers on one fact

| Fact | Writer A | Writer B | What the reader sees |
|---|---|---|---|
| A card's terminal status | `settle` `:2488` (stream) | `adoptRun` `:2707` (probe) | A watched completion re-stamped as a restart loss; the answer printed twice (F3, measured) |
| What ended the turn | `terminate(j,"reader")` before the stop `:3321` | the run's own terminal status | "stopped from the panel" for a stop that failed, and for a later failure of another cause (F4, measured) |
| `approvalDone.choice` | `approve()` `:3234` | the stream's `approval.responded` `:2446` | The choice is blanked when the event carries none (F10, measured) |
| A restored card's reconciliation | `server.js:4210` | `lib/restart.js:820` | Double probe, double line, double adopt (F8, measured) |
| A row's `nextReadAt` | `scanOne` `lib/scheduler.js:584-585` | `dueAfter` `:412-421`, at the end of a full pass `:677` | The countdown ring can be sized for a cadence that no longer applies. Display only. `[read]` |
| A row's `live`/`lastEdit`/`signals` | `Store.putRow` (scan) | `Store.touch` (liveness pass, `lib/scheduler.js:329-338`) | `touch` is a merge, not a replace, but it can write a `lastEdit` older than the scan's. Both derive from the same sources, so the disagreement is bounded. `[read]` |
| The store file | this process's 700 ms debounce `:665` | the replacement panel | `lib/panel-restart.cjs:56-59` waits for the outgoing pid before launching, so overlap needs the 60 s escape hatch *and* a port bind failure. Low. `[read]` |
| The TODO list | the panel (single writer) | — | Correctly single-writer by construction (`lib/todos.js:9-11`); the harvest is guarded by `j.todoHarvested` (`:1690`), which is **not persisted**, but `measureTree` is never re-run for a settled card after a restart, so the guard does not need to survive. `[read]` |

---

## 6. A restart at each of the four bad moments

| The process dies… | Outcome today | Where |
|---|---|---|
| after the POST is accepted, before any event | `load()` → `interrupted`; the reconcile asks the gateway and adopts, re-attaches, or writes the run off | `:629-643`, `:2594-2615` — correct, and the best-handled case |
| **during `settle()`**, after the status and before the 700 ms persist | the run is recovered by the reconcile (F6) and the **assistant is never told** | `:665-735`, `:2717`, `lib/assistant.js:1270` `[measured]` |
| **during `measureTree`**, after `tree.pending = true` | the card keeps "commits not measured" for its whole life; nothing re-measures a settled card | `:1583`, `:1679`, `:658` `[measured]` |
| **during the 5 s approval sweep**, while an approval is being answered | the sweep expires the box, `approve` then dereferences `null` and the client gets a TypeError | `:484`, `:3177` `[measured]` |

And the gateway's own restart: `sweepOrphanedRuns` (`:2981`) is the only thing that notices, it runs
every 15 s, it requires `/v1/capabilities` to answer before it judges anything (correct), and it
handles 404 / terminal / `unknown` / live-in-the-gateway in that order. The one hole there is that a
run which is live in a *replaced* gateway answers 404 to the new one, which is indistinguishable from
"finished and collected" — so the panel writes it off as interrupted while the old process may still
be executing it (the same limitation `runPredatesGateway` documents at `:2915-2917`). The stop that
follows (`:3029`) is the right response even though the wording is a guess.

---

## 7. Tests that would pin each finding

Each of these is a small case against the existing harness style (`test/gateway-unknown.test.js`
stubs `globalThis.fetch` and builds a real `Jobs`; `node lib/jobs.test.js` drives a real panel over
HTTP). None of them needs a browser.

1. **F1**: two `pending_controls`, a card whose command matches neither → assert the POST's
   `request_id` is not the other control's, and that the call refuses instead.
2. **F2**: `answerQuestion` with `j.question === null` → assert no POST.
3. **F3**: settle a card, then call `adoptRun` with the same terminal result → assert the status,
   `endedAt`, `error` and line count are unchanged.
4. **F4**: `stop()` against a 500 and against a throw → assert no `termination`, no "stop requested"
   line; then a later failure still reads `failed`.
5. **F5**: `clearFinished()` with a `starting` and a `waiting` card → assert both are kept.
6. **F6**: `load()` a store whose card is `done` with an old `endedAt`, run the reconcile, then
   `noteSettle` → assert a settle is offered.
7. **F7**: `load()` a store carrying `tree:{pending:true}` on a `done` card → assert the tree is
   measured (or the payload says why it cannot be).
8. **F8**: call `reconcileRestored()` twice concurrently → assert one probe per card and one line.
9. **F9**: `markInterruptedByRestart` / `adoptRun` on a card with a question and an approval → assert
   both are cleared and recorded, as `settle` does.
10. **F10**: `approve` then `consume({event:"approval.responded"})` with no choice → assert the
    recorded choice survives.
11. **F11**: hold the `controlContext` fetch, expire the box, release → assert the response is the
    deadline verdict, not a TypeError.
12. **F12**: a check answer whose row is not yet in the store → assert the next sweep still acts on it.
13. **F13**: `cancel()` on a `starting` card → assert the card ends `cancelled` and the POST is never
    sent.
14. **F14**: a full row then a fast row with the same `ahead` but a different head → assert the
    verdict is not carried.

---

## How the evidence was produced

Seven throwaway Node ES-module probes under `C:/Users/roper/AppData/Local/Temp/wag/31ace94d/`
(scratch — deliberately not committed), each importing the real `lib/jobs.js`, `lib/store.js` or
`lib/assistant.js` from this worktree, stubbing only `globalThis.fetch` and constructing real `Jobs` /
`Store` / `Assistant` instances. They are the same seam the repo's own tests use. Nothing in the
working tree was modified, no server was started, and no gateway was contacted: every "gateway" in the
output is a stub.

The probes that back a claim:

| Probe | Finding |
|---|---|
| `probe.mjs` A, B, B2, C, D, E, F | F3, F7, F8, F13, and the idempotence control |
| `probe2.mjs` G, H, I, J, K | F1, F6, F5, plus the matching-command control |
| `probe3.mjs` L, M, N | F2, F14, plus the matched-question control |
| `probe4.mjs` | F9 |
| `probe5.mjs` | F10, and the missing `approvalDone` at settle |
| `probe6.mjs` | F11 |
| `probe7.mjs` | F4 |

Everything in sections 3, 4 and 5 that is not marked `[measured]` is a control-flow argument from the
cited lines; I have marked those `[read]` rather than dressing them as observations.
