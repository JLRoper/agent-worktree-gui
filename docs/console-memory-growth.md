# A long-lived tab keeps every turn's console

Status: read-only investigation, no product change. Measured 2026-11-07 on `wtgui/read-only-measured-inves-c0c3bf`, cut
from `main` at `461acb4` (1.50.5). Every number below is a read-back from a real Chromium page driving the panel's own
routes; the harness was a throwaway in the session's SCRATCH directory, outside the repo, and is not committed.

The short answer: nothing in the page is keyed to "how many turns exist". `state.jobLines` holds one array per turn,
appends every console line into it, caps that array at 1,000 lines and never drops the array: not on a snapshot, not
when the server forgets the turn, not on anything but the per-thread clear or a reload. Measured over 121 driven turns in
12 sessions, the page retained **44 KB of console data per driven turn** (5.33 MB in total), and the per-turn rate was
flat in both halves of the run (43.96 KB/turn to turn 60, 44.17 KB/turn after it).

## 1. What a turn leaves behind

The board lives in one `state` object (`public/app.js:60`). Per turn, the page keeps:

| what | key | grows with | cap or eviction | evidence |
| --- | --- | --- | --- | --- |
| job record | `state.jobs` | one entry per turn the server still lists | replaced wholesale on each snapshot; bounded only by what `/api/jobs` returns | `public/app.js:111`, `12882-12890`, `6747-6762` |
| console buffer | `state.jobLines` | every `jobline` frame, one array per turn | **1,000 lines per turn**; no global cap; deleted only by the per-thread clear | `public/app.js:112`, `public/board/console.js:2690-2699`, `public/app.js:5643` |
| reasoning blocks | `state.thinkCache` | one entry per turn whose reasoning was read | 60 blocks per read from the route; no client eviction | `public/app.js:6315`, `public/board/console.js:1888`, `lib/thinking.js:16` |
| opened tool results | `state.toolStore` | results for an open tool block, refreshed while its turn runs | **300 entries**, oldest evicted (`public/board/console.js:330`) | `public/app.js:210` |
| opened fold rows | `state.foldRows` | reader-opened full results | none (a result can be 100 kB, the comment trades the ring buffer for it) | `public/app.js:244` |
| expanded batch calls | `state.batchCalls` | expanded "+N commands" rows | **300 entries**, oldest evicted (`public/board/console.js:608`) | `public/app.js:218` |
| fold books | `state.toolGroupOpen`, `codeBoxOpen`, `callOpen`, `callFolded` | one key per opened box | **500 entries each**, oldest evicted (`public/board/console.js:714`, `506`; `public/app.js:14470`, `14532`, `14589`) | `public/app.js:215`, `224`, `232`, `238` |
| turn books | `state.turnOpen`, `turnCompact`, `turnPage`, `pinnedTurns` | one key per turn or pin | pruned to the turns the board still lists (`public/core/turn-fold.js:196-206`; `public/app.js:14081`) | `public/app.js:308-318` |
| thinking books | `state.thinkOpen`, `thinkPinned`, `thinkScroll`, `thinkClosed` | one key per turn or block | none | `public/app.js:6316-6319` |

Bounded structures, for contrast: `state.eventWindows` is capped at 400 timestamps per row (`public/app.js:54`, trimmed
at `9535`), `state.spawnHistory` is trimmed at `4893`, `state.replySent` keeps the last 8 (`public/app.js:4710`). The
result and fold books in the table are bounded too, at 300 and 500 entries; `jobLines` is the one with no global cap.

### The one with no ceiling

`state.jobLines` is the structure that grows with the length of the session. It is written in one place:

- `recordJobLine` (`public/board/console.js:2690-2699`) takes the turn's array, pushes the line (or grows it in place
  when `mode: "set"`), then `if (buf.length > 1000) buf.splice(0, buf.length - 1000)` at line 2698.
- The only `state.jobLines.delete` in the tree is `clearThread` (`public/app.js:5643`), which runs on
  `POST /api/jobs/clear` for one thread.
- `applySnapshot` clears `state.jobs` and refills it (`public/app.js:12882-12890`), and does nothing to `jobLines`:
  line `12886` only ever ADDS (`if (!state.jobLines.has(j.id))`). A turn the server has forgotten keeps its buffer.
- `updateJob` (`public/app.js:6747-6762`) has the same one-way copy at line 6762.

The per-turn cap is real and was reached in the cap probe below (exactly 1,000 lines), but there is no per-tab cap: 12
sessions with 10 turns each is 120 driven turn arrays (240 with the assistant's wake turns, measured below), and each
one keeps up to its last 1,000 lines.

### What a console line costs

A line is `{ kind, text, lid, at }` plus `mode` while it is streaming and `fold` on a folded result
(`public/board/console.js:2695-2699`). Each line is retained twice:

1. in `state.jobLines`, up to 1,000 lines for that turn;
2. in the job record itself, because every `/api/jobs` summary carries `lines: j.lines.slice(-TAIL)` with `TAIL = 60`
   (`lib/jobs.js:76`, `1376`). `state.jobs` therefore holds 60 more line objects per turn, replaced with fresh ones on
   every snapshot.

Only the painted copy is bounded: a rebuild draws the last `TURN_WINDOW = 300` lines per console
(`public/board/console.js:669`, `2014`), and a card pages 5 turns at a time (`public/core/turn-fold.js:44`).

## 2. What `/api/jobs` returns per poll

`GET /api/jobs` (`server.js:4655-4658`) answers `{ jobs: jobs.list(), transport, defaultCwd }`. `list()`
(`lib/jobs.js:1399-1403`) maps every job in the store through `summary()` (`lib/jobs.js:1255-1377`), which carries about
50 fields per turn: identity (`id`, `thread`, `turn`, `runId`, `sessionId`), state (`status`, `startedAt`, `endedAt`,
`exitCode`, `error`, `waiting`, `runGone`), the place (`cwd`, `ownerPath`, `worktreePath`, `branch`, `projectPath`,
`pipeline`, `tree`), the card's controls (`approval`, `approvalDone`, `question`, `questionDone`, `steerable`), the
subagent list, `artifacts`, `attachments`, `tokens`, `stats`, `live`, and `lines` (the last 60).

Two consequences the page pays for on every poll:

- **Nothing is retired.** The store keeps every non-running job until `/api/jobs/clear` or a restart, so `list()` is O(all
  turns ever). At the end of the run below, 241 jobs produced **2,278,911 bytes** of JSON, 9,456 bytes per turn.
- **The same array rides `/api/state`.** `snapshot()` includes `jobs: jobs.list()` (`server.js:2809`), and the page's
  main poll is `/api/state` (`public/core/transport.js:90-100`, on the 30 s quiet-stream safety net at
  `public/app.js:15357-15360`). So every snapshot parses that same multi-megabyte job list, and `applySnapshot` replaces
  all 241 records with fresh copies. The retired objects are garbage, but the allocation is per poll, not per change.
  The assistant's Queue pane also reads `/api/jobs` directly (`public/assistant.js:3688`).

## 3. How the numbers were taken

- **Panel**: this worktree's own `server.js`, booted through `tools/panel-testkit.mjs` on **127.0.0.1:7481**, with its own
  sandbox config, `HERMES_HOME` and jobs store, serving the real `public/app.js`.
- **Load**: a stub Runs API on **127.0.0.1:7482** answering `/v1/capabilities`, `POST /v1/runs` and
  `/v1/runs/<id>/events` (SSE, honouring `Last-Event-ID` so a reconnect never replays a line). Each turn POSTs
  `/api/agents` with `{ prompt, thread, cwd, existing: true }` against one throwaway git repo, so no worktree is cut and
  the turn runs in an existing tree. A normal turn streams 4 tool calls x (1 `tool.started` + 1 result header + 15
  preview lines) + 4 prose lines + `run.completed`, plus the panel's own `cmd` and init lines (and a workspace line on a
  thread's first turn): **76 console lines at most**. The cap probe streams 30 calls x 40 shown preview lines, plus each
  call's `tool.started`, result header and fold note: **1,290 lines**.
- **Sessions and turns**: 12 sessions (`load-s01` ... `load-s12`), 10 turns each, then one cap-probe turn on `load-s01`:
  **121 driven turns**. The board's assistant was left on (its default), and it starts one wake turn per settled turn
  (`lib/assistant.js:3810`), so the server ended the run holding **241 job records in 13 threads**: 121 driven turns and
  120 assistant wake turns.
- **Browser**: Playwright Chromium, one tab at 1400x900, CDP `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage` at
  every session boundary, and full `HeapProfiler.takeHeapSnapshot` at 0, 60 and 121 turns. Each snapshot was parsed for
  its per-type self sizes and then deleted.
- **Ports**: each was proved free before use (a connect that must be refused, then a bind that must succeed) and both
  were proved closed after teardown.
- **Hard limit**: a 10 minute watchdog; the run finished in **8 min 37 s** (18:15:45Z to 18:24:22Z), so it never fired.
- **No product code**: the only file this run adds is this document; the version bump is the landing gate's, not the
  change.

## 4. The numbers

### Heap after GC (`Runtime.getHeapUsage.usedSize`)

| turns | 0 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100 | 110 | 120 | 121 (cap) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MB | 2.41 | 4.17 | 5.62 | 5.20 | 5.61 | 6.13 | 6.54 | 6.89 | 7.34 | 7.76 | 8.20 | 8.57 | 9.30 | 9.39 |

The 20 -> 30 step goes down by 0.42 MB: that is one collection landing later than the sample, not a release. From 30
turns on the curve is monotonic, and the last six sessions move by 0.35, 0.45, 0.42, 0.44, 0.37 and 0.73 MB.

### Heap snapshots: total self size, split into retained data and code

`data` = string + object + array + number + closure + object shape + concatenated string. `code` and `native` are the
JIT and embedder sides and are not console retention.

| snapshot | turns | total self | data | code | native | nodes |
| --- | --- | --- | --- | --- | --- | --- |
| t000 | 0 | 8,831,527 | 1,156,752 | 861,916 | 6,811,651 | 92,138 |
| t060 | 60 | 16,443,109 | 3,794,540 | 2,276,132 | 10,371,229 | 244,396 |
| t121 | 121 | 20,319,874 | 6,488,968 | 2,352,900 | 11,476,798 | 368,234 |

- data growth from 0 to 121 turns: **5,332,216 bytes**
- per driven turn: **44,068 bytes**, and it is flat: 43,963 B/turn over the first 60 turns, 44,171 B/turn over the next 61
- the biggest named contributors between t000 and t121: `object Object` 38,804 -> 1,199,208, string 614,752 ->
  3,983,216, `number heap number` 600 -> 447,552, `native Text` 163,408 -> 563,344, `blink::ShareableElementData`
  0 -> 497,776

### What the page held

| turns | job records | jobLines arrays | lines in jobLines | chars in jobLines | lines in the records' 60-line tails | cards | console nodes | DOM nodes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 120 | 238 | 238 | 17,982 | 1,036,150 | 14,280 | 13 | 13 | 4,001 |
| 121 (cap) | 240 | 240 | 19,982 | 1,152,792 | 14,400 | 13 | 13 | 4,548 |

At the end the page held **34,382 console-line slots** (19,982 in `jobLines` + 14,400 in the job records' tails), and
5,332,216 bytes of data growth over them: **155 bytes per line slot**. Nothing was ever evicted: the arrays at 120 turns
are the arrays created at turn 1, plus one per turn since.

The DOM stayed small on purpose: 13 cards (one per thread, 12 sessions plus the assistant), 13 consoles, 4,548 nodes.
A card paints one open turn at a time and pages the rest 5 at a time (`public/core/turn-fold.js:44`), and a console
paints 300 lines (`public/board/console.js:669`). The growth is in the JS arrays, not in the DOM.

### The cap, and the two caps that disagree

The cap probe's turn streamed 1,290 lines. Its `jobLines` array stopped at exactly **1,000** (`clientLines`), so 290
lines were dropped from the top. The same turn's record in `/api/jobs` carried 60 lines (`serverLines`), because the
summary's tail is 60. The panel's own array is trimmed at 600 (`lib/jobs.js:75`), so between the two caps there is a
window where **the page holds lines the server has already dropped** (up to 1,000 client-side against 600 server-side),
and it never learns they are gone: `jobLines.has()` keeps the client copy and the next snapshot only adds.

### The buffer outlives the job

Two smaller runs tested what "the turns are gone" does to the page. Each ran 10 turns (19 job records including the
assistant wakes), and each left the same tab open across the removal.

**The reader's own "Clear finished"** (`public/index.html:723` -> `post("/api/jobs/clear")` at `public/app.js:13263`,
which reaches `clearFinished()` in `lib/jobs.js:5209`):

| | server jobs | page `state.jobs` | page `state.jobLines` | lines held | cards |
| --- | --- | --- | --- | --- | --- |
| before the press | 19 | 19 | 19 | 752 | 3 |
| after the press | 1 (one record already back) | 0 | **19** | **752** | 0 |

Every card left the page and the job map emptied; not one console buffer was released.

**The panel forgetting them on its own.** The panel was stopped and replaced with a fresh one on the same port, with an
empty jobs store, while the same tab stayed open:

| | server jobs | page `state.jobs` | page `state.jobLines` | lines held |
| --- | --- | --- | --- | --- |
| before the swap | 19 | 19 | 19 | 752 |
| after the swap, page reconnected (`live`) | 0 | 0 | **19** | **752** |

The page reconnected to the new panel and its job map emptied, and all 19 console buffers and all 752 lines stayed.
The only paths that release them are a reload (`state` is rebuilt) and the per-thread X, which is the one caller that
reaches `state.jobLines.delete` (`public/app.js:5643`).

## 5. Teardown

The run started two processes: the harness (`node measure.mjs`, background session `proc_6fbe31b1530d`) and the panel it
spawned (`node server.js`, **pid 37960**), plus the stub gateway inside the harness on **127.0.0.1:7482**. The panel
listened on **127.0.0.1:7481**.

The harness stops the browser, the panel and the stub, then re-probes both ports and the pid. Its own read-back, quoted
from the run's last line:

```
TEARDOWN {"panelPid":37960,"panelListeningAfter":false,"gatewayListeningAfter":false,"pidAliveAfter":false}
EXIT=0
```

After the run, from this shell: `netstat -ano | grep LISTENING` holds no `:7481` or `:7482` entry,
`Get-Process -Id 37960` answers nothing, and no `node.exe` command line mentions `measure.mjs` or `run-measure`. The
panel sandbox, the throwaway repo and the run directories were removed after the run, and each heap snapshot file was
parsed and deleted as it was taken. What is left in this session's SCRATCH directory is the harness scripts and
`measure-results.json`, the raw record of the numbers above; nothing service-like, no log, and no directory the harness
created. Nothing was added to the repo except this document, plus the version bump this repo's landing gate requires of
every commit.

## 6. What the numbers imply

The growth is not a bug in a renderer; it is the shape of two stores that only ever add. Three facts decide it:

1. **Per turn**: one `jobLines` array (up to 1,000 lines, measured 76 for a normal turn) plus one job record with a
   60-line tail. The arrays are never dropped, so a tab's retained data grows with every turn it has ever seen, at
   about 44 KB per driven turn (measured; about 22 KB per turn across all 241 turns, because each driven turn also
   caused one assistant wake turn), regardless of whether the reader ever opens the card again. "Clear finished" does
   not release them either: measured, 19 buffers and 752 lines stayed after the press that emptied the board.
2. **Per line**: about 155 bytes per retained line slot across both books, and a line is kept in both: the `jobLines`
   copy is capped at 1,000 while the record's 60-line copy is re-created from every snapshot. The client keeps a longer
   history (1,000) than the server does (600), and a snapshot never shrinks it.
3. **Per poll**: the whole job list is re-serialised on every `/api/state` snapshot (2.28 MB at 241 turns, 9.5 KB per
   turn), and the page re-creates every record from it. That is churn rather than retention, but it scales with the same
   number, and it is what makes a long-lived tab feel heavier than its retained bytes alone would suggest.

What would bound it, none of which this read-only run changed: a global cap or age-out on `jobLines` keyed by turn (the
per-turn 1,000 already exists at `public/board/console.js:2698`), dropping a turn's buffer when the server no longer
lists the job (the snapshot loop at `public/app.js:12882-12890` is the place), and not copying `lines` into `jobLines`
at all when the record already carries the tail the card starts from (`public/app.js:12886`, `6762`).

The two amplifiers worth naming: the assistant's wake turn (`lib/assistant.js:3810`) doubled the number of records and
buffers in this run, one per settled turn; and `state.thinkCache` was empty throughout because reasoning is off by
default (`public/app.js:6315`, `thinkDefault`), so a reader who turns thinking on adds one more entry per live turn.
