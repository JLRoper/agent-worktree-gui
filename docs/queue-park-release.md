# Queue #67 — a parked row must hold a machine-readable reason, and release the moment it stops being true

Design only: this branch changes no code. Everything below was read out of the running 0.67.1 panel or timed against
its own modules, and every claim carries the file and line it was read from or the record it came out of. The store
paths are the live ones on this machine, not a fixture: `C:/Users/roper/.wag/state/assistant.json`,
`C:/Users/roper/.wag/state/assistants/assistant-1/queue.json`, `C:/Users/roper/.wag/state/jobs.json`.

## The row this is about

Task #45 in Assistant #1's queue, read at 2026-11-03T00:56Z and unchanged at 01:00Z:

```json
{"id": 45, "state": "parked", "thread": null, "threads": [], "worktree": null,
 "files": [".gitignore", "tickets.local.html"], "attempts": 0,
 "createdAt": "2026-11-02T21:53:33.052Z", "startedAt": null, "doneAt": null, "doneBy": null,
 "reason": "blocked: the live resume run (wtgui-pick-up-the-turnover-branch-396ea9) is working in the
            event-multi checkout, and one worker per tree forbids a second; starts when it settles"}
```

The run it names ended at **2026-11-02T22:43:01.664Z**. At 01:00Z — 2 h 17 m later — the row still reads `parked`,
and the record carries **no** reference to the thread: `thread: null`, `threads: []`, `worktree: null`. The only
binding between the row and the condition it is waiting on is 176 characters of English. Nothing in the panel can
read it, so nothing in the panel can act on it.

This is not one row. At read time there were **10 parked rows and every one of them had `thread: null`**:

```
38, 39, 40  blocked: needs the pipeline field on the job record from the data-model task
43          blocked: #44 is live in server.js (and lib/pipelines.js) …
45          blocked: the live resume run (wtgui-pick-up-the-turnover-branch-396ea9) … starts when it settles
60, 66      serial lane: lib/assistant.js is held by #55 / #57 …
61, 65      public/app.js is held by #58 … start when those land
63          needs a decision plus an offline gradle run
```

(Had 11 a few minutes earlier; #64 left the set at 00:57:09Z with `doneBy: "reader"` after its PR merged — a manual
`state` write, not a release. Nothing in the panel moved it.)

And the sweep never looks at them. `settleTasks` returns the task untouched for any state that is not `running`
(`lib/assistant/queue.js:614`: `if (t.state !== "running" || !thread) return t;`), and the parked branch of
`setTaskState` writes only `reason` (`lib/assistant/queue.js:359-362`). A parked row is, by construction, a row that
will still be parked at the end of the process.

## 1. Did a settle wake for 396ea9 fire, and was it refused?

**No settle wake fired, and no wake for 396ea9 was refused.** A *watch* fired, took the terminal claim for that turn,
and its notice went out 93 s later as the third item of a coalesced batch whose headline was a different thread's loop
alert. The refusals the panel did record are 82 minutes later and belong to other threads — and they are the more
important finding, because a refused wake still spends the terminal claim.

**(a) What the alerts say.** Which `assistant.json` matters: the one the running panel writes is
`C:/Users/roper/.wag/state/assistant.json` (`savedAt 2026-11-03T00:57:15Z` at read time). The copy under the repo's
`logs/` is a **five-day-old snapshot** (`savedAt 2026-10-28T18:29:56.558Z`, no `2026-11-` timestamps at all) and
contains no 396ea9 record — a reader who greps `logs/assistant.json` will find nothing and conclude the alert never
fired.

The live file holds 80 alert records (`ALERT_CAP`, `lib/assistant/config.js:220`). Three name 396ea9 — a `quiet`, a
`loop` and a `watch`. There is **no `[settle]` alert for it**. The finish is this record, verbatim:

```json
{"id": "54869a9f", "key": "watch|08a5dc83|finished", "rule": "watch", "severity": "info",
 "thread": "wtgui-pick-up-the-turnover-branch-396ea9", "turnId": "aa2e8815",
 "title": "watch finished: spawned: Pick up the turnover branch 20260928_2105_jvmMemoryLogging where it was left off…",
 "detail": "Resume turnover branch 20260928_2105_jvmMemoryLogging ended normal",
 "evidence": [{"label": "watching", "value": "spawned: Pick up the turnover branch 20260928_2105_jvmMemoryLogging …"},
              {"label": "outcome", "value": "normal"}, {"label": "exit", "value": "0"},
              {"label": "duration", "value": "50m 42s"}, {"label": "branch", "value": "20260928_2105_jvmMemoryLogging"}],
 "at": "2026-11-02T22:43:04.777Z", "status": "open", "level": "wake", "parked": false}
```

**(b) Why there was no settle.** The settle rule refuses to speak for a thread the reader already has a watch on —
`flushSettles`, `lib/assistant.js:2367-2368`:

```js
if (this.watches.some((w) => w.thread === job.thread && w.state !== "done")) {
  this.journalAdd("settle-watch", job.thread || null, `${nameOf(job)} settled — a watch covers this thread, so its notice is the watch's and this one stays unsent`);
```

The watch's own alert is the proof that a watch covered the thread at 22:43:04 — the `watching: spawned: Pick up the
turnover branch …` evidence chip cannot be produced by any other rule. So the finish produced exactly one notice, and
it was the watch's.

**(c) The claim was taken.** `terminalWakes` entry 70:

```
["wtgui-pick-up-the-turnover-branch-396ea9",
 "wtgui-pick-up-the-turnover-branch-396ea9|aa2e8815|2026-11-02T22:43:01.664Z"]
```

One terminal claim per thread per finish, taken at `fired` where the wake is decided (`lib/assistant.js:1728`), and
persisted across restarts (`lib/assistant/store-file.js:128`). It records that this finish was handed over.

**(d) The wake did go out — as item 3 of 3.** `jobs.json` job `df09538b`, thread `panel-assistant`:

```
startedAt 2026-11-02T22:44:34.438Z   status done
origin   {"kind": "assistant-wake",
          "reason": "[loop] patch called 12× with the same input — Resume turnover branch 20260928_2105_jvmMemoryLogging: patch · C:/ProjectDevelopment/event-multi/docs/turnover-state-2026-11-02.md · [loop] patch called 12× with the same input — Write semantic layer reference HTML page: patch · C:/ProjectDevelopment/ai…",
          "alerts": ["349c5374", "d25e07e6", "54869a9f"]}
prompt   watch: [loop] patch called 12× with the same input — Resume turnover branch 20260928_2105_jvmMemoryLogging: patch · C:/ProjectDevelopment/event-multi/docs/turno…
```

So: delivered 93 s after the run ended, third of three, under a headline about repeated `patch` calls. The delay is
`flushWake` holding the batch while the assistant has a turn running (`lib/assistant.js:2848`): `panel-assistant`'s
22:40:20 turn (`17e0af2f`) ended at **22:44:34.021Z**, and the wake turn (`df09538b`) started at **22:44:34.438Z** —
417 ms later, in the same turn of the event loop that saw the previous one end. Nothing was lost, but nothing named the
row either: the wake carried an alert about a *run*, and #45 is a *queue row* that no wake mentioned.

**(e) What was in fact refused.** Five `wake-suppressed` journal entries in 37 minutes, every one of them `[watch]`,
none of them 396ea9:

```
00:05:09.377Z  rate limit reached (6/h): [watch] watch finished: … Merge canvas design study into main ended normal …
00:14:05.457Z  rate limit reached (6/h): [watch] watch finished: … Verify and land three-architect pipeline definitions …
00:22:54.748Z  rate limit reached (6/h): [watch] watch finished: … Propose rules and skills allocation matrix per stage …
00:29:58.212Z  rate limit reached (6/h): [watch] watch finished: … Write POC-to-UAT factory next-steps plan …
00:42:51.364Z  rate limit reached (6/h): [watch] watch finished: … Merge three finished branches into main …
```

with the watchdog's own summary at 00:36:25.706Z: `Watchdog: WAKE SUPPRESSED x1 — a settle was refused by the wake
budget; latest: rate limit reached (6/h): [watch] watch…`. The budget was **6/h** at the time (`maxWakesPerHour: 6` in
the settings the suppressions were refused under; the file now reads `30`, raised after 00:42).

**(f) What the wake accounting can and cannot say.** The counter itself is memory-only — `this.wakes` is pruned and
pushed in `wake`/`flushWake` (`lib/assistant.js:2813`, `:2852`) and is **not** in the persisted snapshot. The durable
records are `terminalWakes` (what was claimed) and `restartWakes` (what was re-sent), plus the journal. The journal is
capped at 300 (`JOURNAL_CAP`, `lib/assistant/config.js:225`); at read time its oldest entry was
`2026-11-02T23:44:30.580Z` and its newest `2026-11-03T00:57:15.833Z` — **72 m 45 s of history**. The budget's window is
60 minutes, so at this board's rate the journal cannot outlive a single budget window. The 22:43 entries are gone, and
a `wake-suppressed` line written now will be gone before the hour that refused it has rolled over.

**(g) The defect under all of it: a refused wake still spends the claim.** `fired` writes `terminalClaim` at
`lib/assistant.js:1728` *before* calling `wake`, and `wake` is what checks the budget (`:2817`). Two measured cases:

```
wtgui-task-10-propose-how-rules-an-d00a88     claim …|f03c2487|2026-11-03T00:22:50.655Z   refused 00:22:54.748Z
wtgui-write-the-next-steps-plan-fo-d257b0     claim …|cc25081d|2026-11-03T00:29:54.619Z   refused 00:29:58.212Z
```

Neither thread got a turn: `panel-assistant` ran at 00:25:25 and then not again until 00:35:49. The claim says "handed
over"; nothing was handed over. Any later rule that sees the same finish logs `wake-once` — *"that finish had already
been handed over, so this alert is not another wake"* (`lib/assistant.js:1731`) — and the finish is never reported at
all. **A hold that releases on a settle notice would inherit exactly this failure**, which is why §7 specifies that
the release is written by the sweep and the wake is only a notification of a release that has already happened.

## 2. Where the panel already knows `isLive(thread)` for a queue row

One place derives it; three call sites hold it per read; one of them already writes.

| site | what it already has in hand | reads / writes |
| --- | --- | --- |
| `lib/assistant.js:651` `queueContext().isLive` | the job list, and `jobs.some(j => j.thread === thread && isLive(j))` — the one derivation | read |
| `lib/assistant.js:671` `queueView` → `decorateTasks` | `ctx.isLive` + `ctx.rowFor`, for the tab GET, the digest and the preamble | read |
| `lib/assistant.js:682` `queueView` → `queueDigest` | same two, a second decoration of the same task list | read |
| `lib/assistant.js:737` `sweepQueues` → `settleTasks` | `ctx.jobs`, `ctx.rowFor`, `ctx.isLive`; the queue file already read at `:733`, already written at `:743` when something changed | **write** |
| `lib/assistant/queue.js:456` `decorateTasks` → `:508` `runningFlag` | one `isLive(thread)` per *running* row | pure |
| `lib/assistant/queue.js:559` `queueDigest` → `:560` | `decorateTasks` again | pure |
| `lib/assistant/queue.js:607` `settleTasks` → `:615` | `isLive(thread)` per running row, `:616-619` the thread's runs | pure |
| `lib/refresh-row.js:134` `liveRunIn(jobs, target, {isLive})` | **the path-shaped twin**: the live run whose `cwd`/`ownerPath` is that tree | pure |

Three things follow.

- **`sweepQueues` (`lib/assistant.js:727`) is the free call site.** It runs on the sentry's own 5 s clock —
  `start()` sets `setInterval(..., Math.max(2, seconds) * 1000)` (`:1477`), `tick` calls `sweepQueues` outside the
  `enabled` block (`:1664`) — it already holds the job list, already reads every assistant's queue file, and already
  writes the file when a task changed. A parked-row pass added there costs **no extra read, no extra `list()`, no git**.
- **`queueView` is the free read site** and must stay read-only: it backs the tab GET and the preamble, so it can
  *render* a released hold but must not *write* the release. One writer, as `sweepQueues` already is.
- `liveRunIn` has been exported since the delete/refresh guard and is already called with the job store at
  `server.js:1992` and `server.js:4344`. The queue has never called it; a `path` hold is one call to it.

## 3. What a release check costs per sweep at ~13 rows

Measured, not estimated. Probe: `C:/Users/roper/AppData/Local/Temp/wag/81f40caa/cost-probe2.mjs`, run with
`command node cost-probe2.mjs`; it imports the tree's own `lib/assistant/queue.js` over `file:///`, feeds it the live
`jobs.json` (80 cards) and the live 67-task queue file, holds the 10 parked rows on their own threads
(`hold: {kind: "thread", value: <the thread the reason names>}`), and times 20 000 iterations per pass.

```
open rows                          13
parked rows                        10
jobs in the store                  80
tasks in the file (all states)     67
decorateTasks                 us 1.50 – 1.59
decorate + release check      us 7.90 – 12.33
release check marginal        us 6.31 – 10.83      (four runs)
settleTasks (already runs)    us 1.11 – 1.31
readQueueFile (already runs)  us 651 – 855
release / file read           %  0.97 – 1.28
isLive comparisons, decorate      24
isLive comparisons, +release     824                 (+800 = 10 parked rows × 80 cards)
```

The exact part is the work, not the microseconds: **one `isLive` per parked row that carries a hold**, and that call
scans the job list once (`jobs.some`) — 10 × 80 = 800 string comparisons today, 1 040 if all 13 open rows were parked.
The dead-thread case is the worst case, because `isLive` has to reach the end of the list to answer false.

So: **6–11 µs per sweep at 10 parked rows, ~11 µs at 13**, against a 5 s tick — 0.0002 % of the interval, and
0.9–1.3 % of the queue-file read the sweep already pays for (651–855 µs). No fs, no git, no new allocation worth
naming. Cost is not the reason this is not done today; the absent field is.

## 4. What should happen instead of parking when the block is a live worker in the same tree

Today the assistant does the only thing the charter lets it do — *"Never leave a queued task you could be doing. If it
is blocked, park it with the reason; if it can be started, start it."* (`lib/assistant.js:194`) — and when the row is
finally started it starts as a fresh run, which cuts a fresh tree: every non-reply, non-existing run goes through
`makeWorktree` (`lib/jobs.js:2020`, `if (!opts.reply && !opts.existing && opts.worktree !== false)`). So the row that
was waiting *because a tree was busy* ends up getting a **second** tree for the same branch — the exact thing the park
was avoiding.

The row's own words already describe the correct behaviour — *"starts when it settles"* — and nothing implements it.
What should happen:

1. **Park it holding the thread, not a description of the thread.** `hold: {kind: "thread", value:
   "wtgui-pick-up-the-turnover-branch-396ea9", since: "2026-11-02T21:53:33.052Z"}`.
2. **When the thread settles, release the row and hand the work into that thread.** The released row does not become a
   spawn candidate that cuts a tree; the release wake names the settled thread and tells the assistant to reply into
   it. The thread already has the checkout, the branch, the work in progress and its own console row — and its run
   record is the history the queue's `threads[]` field exists to keep (`lib/assistant/queue.js:10-11`, `:108-127`).
3. **Cut a tree only for a row with no thread to inherit.** A queued row that never had a thread, or one whose hold
   was on a `path` that is now free, is a normal start.

Three reasons this is the right shape and not merely cheaper: the tree is the one the block was about; `one worker per
tree` is a rule about files, and a second tree on the same branch does not make the files disjoint; and the settled
thread is the only place the in-flight context survives — a fresh tree re-derives it from git and loses it.

## 5. The hold field

```js
hold: { kind: "thread" | "path" | "job", value: string, since: ISO-8601 string } | null
```

| kind | `value` | "still true" test | cost |
| --- | --- | --- | --- |
| `thread` | the thread name as the job store spells it (`wtgui-pick-up-the-turnover-branch-396ea9`) | a live run on that thread, matched by full name **or** by its six-hex tag (`lib/tree-names.js:35`) so a rename does not release it | 1 `isLive`, +1 pass over jobs if the name missed |
| `path` | a tree directory, normalised (`C:/ProjectDevelopment/event-multi`) | `liveRunIn(jobs, value, {isLive})` returns null (`lib/refresh-row.js:134`) | 1 pass over jobs |
| `job` | a job id (`df09538b`) | no live job with that id | 1 pass over jobs |

Rules for the field itself:

- **Written only by a park.** `setTaskState(tasks, id, "parked", {hold, reason})` stores it (`lib/assistant/queue.js:359`);
  every transition out of `parked` clears it to `null`. `pickTask` normalises it (`:134-175`): unknown `kind`, empty
  `value`, or a `since` that is not a parseable ISO string drops the whole hold to `null` — a half-valid hold is a
  release that fires for the wrong reason.
- **`reason` stays.** The human sentence remains the explanation; `hold` is the machine-readable half. The panel never
  parses `reason` to invent a hold: 10 rows today carry a thread name or a row id inside English prose (`#44`, `#58`,
  `396ea9`) and none of them gets one retro-fitted.
- **No hold is a legitimate, permanent value.** That is the manual park (§6).
- **It is on the task, not in a side table.** It is written with the row, read with the row, exported by `queueView`
  for free, and a hand-edited queue file can set it.

## 6. The release rule

One pass, in `sweepQueues` (`lib/assistant.js:727`), after `settleTasks` and before the single `writeQueueFile`:

```
for each task in the assistant's queue:
  if task.state !== "parked"        -> skip
  if !task.hold                     -> skip            // the manual park: never released by the panel
  if holdTrue(task.hold, ctx)       -> skip            // still true; nothing to say
  -> setTaskState(…, "queued", {by: "panel", at: now,
       reason: `hold cleared: ${describe(hold)}`})
  -> journal one "queue" line, and queue ONE wake line (§7)
```

`holdTrue`:

- `thread` — `ctx.isLive(hold.value)`, falling back to a tag match over `ctx.jobs` when the exact name has no live run.
- `path` — `liveRunIn(ctx.jobs, hold.value, {isLive})` is not null.
- `job` — some job with `id === hold.value` is live.

Properties the rule must keep:

- **Released the moment it stops being true, within one tick.** The sweep is 5 s (`lib/assistant.js:1477`), which is
  the panel's own definition of "now" everywhere else (`settleTasks` runs on the same clock).
- **The release is a write, not a wake.** The row goes back to `queued` and is journalled whether or not the wake is
  delivered. A refused wake can make a release *quiet*; it can never make it *late* or lost.
- **Parked-without-a-hold never releases.** Not after 1 000 sweeps, not when every thread settles, not when the
  assistant is idle. Only a reader's or assistant's explicit `state` action moves it. This is the manual-park
  exception, and it is the reason the field is not inferred: "needs a decision" is not a condition that becomes false.
- **Old rows keep their state.** The 10 parked rows on disk today have `hold: null` after the field lands. They are
  manual parks by definition and will not auto-release; re-parking one with a hold is a deliberate act. A migration
  that guessed holds from the reasons was considered and rejected — the reasons name threads (`#44`, `#58`) and paths
  that are already ambiguous, and a wrong hold releases work someone is still holding.
- **A release is a transition, not a loop.** The row leaves `parked` on the first pass, so the next sweep has nothing
  to do: one journal line, one wake, one state change.

## 7. The one-line wake

The wake is built as `- ${reason}` per batch item (`lib/assistant.js:2858`), so a release notice **must be one line**.
For #45 released after 396ea9 settled:

```
#45 event-multi: ignore *.local.* and build tickets.local.html from the Jira tickets related t — hold cleared:
wtgui-pick-up-the-turnover-branch-396ea9 ended 22:43 normal. Reply into that thread
(TO wtgui-pick-up-the-turnover-branch-396ea9: #45) instead of cutting a new tree.
```

(three lines here only for the page's width; the string itself is one line. The title is `clip(title, 90)`, so it ends
mid-word exactly as the digest's does.)

That is the shape for all three kinds — the row (`#45` + its title, title clipped to the digest's 90), the hold target,
and the instruction:

- `thread` — `… — hold cleared: <thread> ended <HH:MM> <word>. Reply into that thread (TO <thread>: #<id>) instead of
  cutting a new tree.`
- `path` — `… — hold cleared: no live run in <path>. Start #<id> in that tree (it already has it); do not cut a new
  one.`
- `job` — `… — hold cleared: job <id> ended <HH:MM>. Reply into <thread> (TO <thread>: #<id>) instead of cutting a new
  tree.`

Sent as `this.wake(line, null, "hold", { force: true, assistantId: rec.id })`. `force: true` for the reason a settle
has it (`lib/assistant.js:2814-2816`): it is a single event with no second chance and no sibling rule that carries it.
Unlike `settle`, it does not touch `terminalClaim` at all — the claim is per thread-finish and this is per row, and
sharing that key is how the 00:29 settle was swallowed by the 00:29 suppression (§1g).

The case worth naming: if the wake *is* refused (budget spent by other rules), the row is already `queued` and
the digest already shows it — the next turn reads the queue, not the alert list. That is the whole point of writing
the release before announcing it.

## 8. How the digest renders a held row

Today (`lib/assistant/queue.js:582-584`) every parked row renders its free text:

```
- ⏸ #45 parked · event-multi: ignore *.local.* and build tickets.local.html from the Jira tickets related t ·
  thread (none) · tree (none) · PR none · PARKED: blocked: the live resume run
  (wtgui-pick-up-the-turnover-branch-396ea9) is working in the event-mult
```
(that is the real line — 258 characters to the end — produced by `queueDigest` over the live queue file; the title is
clipped at 90 and the reason at 100, mid-word, which is the existing contract.)

After, three forms, chosen by the hold and the fact it names:

| state | line tail |
| --- | --- |
| held, target still live | `· PARKED: parked on 396ea9, live` |
| held, target settled — the tick before the sweep releases it | `· PARKED: parked on 396ea9, ended 22:43` |
| no hold | `· PARKED: <reason, clipped to 100>` (unchanged) |

`396ea9` is `tagOf(hold.value)` — the six hex a rename keeps (`lib/tree-names.js:35`), not a 42-character thread name.
`22:43` is `endedAt` as `HH:MM` on the panel's journal clock (UTC), the same clock every timestamp in this document is
quoted on; it is `22:43:01.664Z` for 396ea9. If the run record is already gone from the job store (the store keeps 80
cards and this one has aged out), the `ended 22:43` half is omitted rather than guessed: `parked on 396ea9, settled`.

Why the middle form matters even though it lasts at most one tick: the digest is what a *turn* is handed
(`queueBriefing` → `queueView`, `lib/assistant.js:691`, `:682`), and a turn that wakes for any other reason in that
window should read "this is over, start it" rather than "blocked". After the sweep writes the release, the row is
`queued` and its `reason` carries the same fact — `hold cleared: wtgui-pick-up-the-turnover-branch-396ea9 ended 22:43`
— so nothing is lost by the transition.

The test asserts the phrase `parked on 396ea9, ended 22:43`, not the `PARKED:` prefix, so the prefix can move without
editing the assertion.

## 9. The four tests

New file `test/queue-hold.test.js`, driven the way `test/settle-wake.test.js` already drives the panel: a real
`Assistant` over a `mkdtemp` directory with a stub `jobs.list()`, and `assistant.say` replaced by a recorder.

1. **The field round-trips and a bad one is dropped.** `pickTask` keeps `{kind, value, since}` for all three kinds; an
   unknown `kind`, an empty `value` or an unparseable `since` reads back `hold: null`; a task written without one reads
   `hold: null`. `setTaskState(…, "parked", {hold})` writes it, and `queued|running|done` clears it.
2. **A thread hold releases on the first sweep after the run ends, once.** One parked row holding
   `wtgui-pick-up-the-turnover-branch-396ea9`, the job store returning that run live → sweep, still `parked`, no
   journal line. Flip the run to `done`/`exited` → sweep, state `queued`, exactly one `queue` journal line, exactly one
   `say` whose text contains `#45`, the thread name and `TO wtgui-pick-up-the-turnover-branch-396ea9`; that text
   contains no newline. A second sweep changes nothing and says nothing.
3. **A parked row with no hold never releases.** 1 000 sweeps with every job terminal, and every row in the file
   `parked` with `hold: null` → state still `parked`, no journal `queue` line, no `say`, digest still
   `PARKED: <reason>`.
4. **A refused wake loses neither the release nor the claim.** Spend the budget the way `test/settle-wake.test.js`
   does (`assistant.wakes.push(...)` × `maxWakesPerHour`), release a held row → the row is `queued` on that same
   sweep and journalled, the wake is refused and the journal carries `wake-suppressed`; and the settled thread's
   `terminalWakes` entry is untouched by the refusal, so a later `fired` with the same terminal key queues a wake once
   the budget allows. (This is the 00:29 defect, pinned.)

## 10. What this does not fix

- **The 10 parked rows already on disk.** They carry no hold, so they will never auto-release. Each needs a re-park
  with a hold; there is no migration, and none should be inferred from the English.
- **The wake budget itself.** 6/h refused five finishes in 37 minutes; the file now says 30/h, which is a knob, not a
  fix. The release is written before the wake, so a spent budget costs silence, not the release — but it still costs
  silence.
- **A coalesced batch burying a notice.** 396ea9's finish was item 3 of 3 under a `[loop] …` headline. The release
  wake can be batched the same way; nothing here orders a batch by what it is about.
- **`terminalClaim` being spent by a refused wake** (§1g). It is the companion defect; test 4 pins the release's half
  of it, but the claim/wake ordering in `fired` (`lib/assistant.js:1728-1731`) is a separate change.
- **A stale hold whose thread was renamed and whose tag no longer resolves.** The tag match covers the rename the
  panel itself performs; a hand-renamed thread that keeps neither name nor tag reads as settled and releases — correct
  by the only rule available, wrong for a worker still running.
- **Work in another checkout.** A `path` hold is about a directory; two checkouts of the same branch are still two
  directories and still get two workers.
- **Starting the work.** A released row is `queued`. Somebody still has to start it, and a release wake is a request,
  not a spawn.
- **The other assistants' queues.** Each sweep is per assistant (`sweepQueues` loops `this.assistants`, `:731`); a
  hold is read and released by the queue that carries it.
- **The reason text.** It stays free prose. Nothing parses it, and a reason that lies is still a lie — the hold is what
  the panel acts on.
- **The digest's 100-character clip** on a no-hold reason. A long reason still truncates mid-word.
