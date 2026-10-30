# Efficiency review — agent-worktree-gui

A read-only review of what the panel actually does on a timer, what it costs, and where the cost
lands. No code was changed and no behaviour was altered by this review; the only commit is this
document. Every number below is either **measured** on the live panel (the one serving
`http://0.0.0.0:7331`, pid 23448) or **derived** from `file:line` and labelled as such. Numbers I could
not measure are listed in §9 rather than guessed.

- Snapshot: `wtgui/deep-architectural-revie-4141e9` cut from `main` at **b64642d**.
- Fleet at review time: **105 projects, 172 worktree rows**, `scanMode: "all"` (so the whole fleet is
  read, not only what a page can see), pool **5 workers** (`threads: 5`).
- Config as given: `worktreeSeconds 5`, `midSeconds 45`, `dormantSeconds 90`, `liveSeconds 5`,
  `slowSeconds 300`, `fetchSeconds 1800`, `refreshSeconds 30`.
- **Caveat on absolute milliseconds.** The box was running four other agent sessions while these were
  taken, so wall-clock per git call is inflated (~300 ms for `git --version`, where a quiet Windows box
  is ~40-60 ms). The *ratios*, the *counts* and the *CPU seconds* are the load-independent part and are
  what this review ranks on. Where a figure is load-sensitive it is marked.

---

## 1. The measured baseline

| Quantity | Measured | How |
|---|---|---|
| Row scans demanded by cadence | **4.38 /s = 15,760 /h** | `Σ 1/pollSeconds` over the 172 rows the server published (6 rows @5 s, 120 @45 s, 46 @90 s) |
| Row scans actually completed | **3.78 – 4.96 /s** | `scheduler.stats.rowScans` deltas over 59 s and 26 s heartbeat windows |
| Pool queue depth | **37 – 104**, `inFlight` pinned at **5** | `pool` in every heartbeat; 5 == `threads`, so the pool is saturated, not idle |
| Liveness pass wall time | **1,243 ms** per pass, every 5 s | `stats.lastLiveMs` |
| Full project pass wall time | **39,739 ms** | `stats.lastFullMs` (stable across heartbeats) |
| Full passes completed | **0 – 2 per minute** | `stats.fullPasses` deltas |
| git.exe launches | **828 / 903 / 1,102 per 60 s** | three 60 s windows, counting distinct `(pid, StartTime)` per process name |
| netstat + tasklist launches | **41 /min** (21 + 20) | same windows |
| Peak concurrent git.exe | **23** | sampled every 40-50 ms |
| Panel process CPU | **20.4 / 30.8 / 34.4 CPU-s per 60 s** → **1,224-2,062 CPU-s/h** = **20-34 CPU-min per hour** = **34-57 % of one core** | `Get-Process -Id 23448).CPU` deltas |
| CPU per git launch | **≈ 25-34 ms** | CPU-s ÷ launches, three windows agree |
| Panel RSS | **422 MB** | `WorkingSet64` |
| `/api/state` payload | **1.96 MB**, TTFB **135-150 ms** warm, **2.18 s** cold | `curl -w`; composition: `jobs` 1,027 KB (54 %), `projects` 696 KB (36 %), `assistant` 125 KB |
| SSE to one client | **4.56 row events/s, 21.6 KB/s = 77.7 MB/h**; jobs 402 KB/62 s (**23 MB/h**), jobline 1.9 MB/h → **≈ 103 MB/h per open tab** | 62 s capture of `/api/stream`, summed per event type |
| One snapshot event | **1,908,836 bytes** | same capture |
| Average row event | **4,728 bytes** (a row with a todo list: 15,780) | same capture; `todo` is **32 %** of a row's bytes |
| Consecutive row events that differ only in bookkeeping | **31 of 132 (23 %)** — 15 of them are `nextReadAt` alone | diffed field-by-field across the capture |
| Client main thread, idle tab, all projects collapsed | **2,331 ms of task time per 30 s** (7.8 %), **127 layouts**, **879 style recalculations**, 356 ms script, 101 ms layout, 140 ms style | CDP `Performance.getMetrics` deltas, observers disconnected |
| Cost of parsing `public/app.js` (868,665 bytes, 16,643 lines) | **9.5 ms first compile, 1.1 ms warm** | `new Function(source)` in the page; fresh-load `ScriptDuration` = 78 ms for all 13 scripts |

The headline: **an idle panel that nobody is looking at spawns ~900-1,100 processes a minute and holds
a third to a half of a core doing it.** The bytes it moves to a single idle tab are ~100 MB/hour.

---

## 2. Every timer, server side

One 1 s ticker drives the scans (`lib/scheduler.js:168`); everything else is a small independent clock.
"Cost" is measured where noted, otherwise derived from the loop body and the fleet size.

| Timer | Interval | What it does | Measured / derived cost |
|---|---|---|---|
| `Scheduler.tick` — `lib/scheduler.js:241` | **1 s** | registry refresh check, liveness pass check, `enqueueDue` for **every** project, up to 2 full passes | `enqueueDue` over 105 projects = **1.78 ms/tick** (benchmarked against the real class) → 6.4 CPU-s/h. The scans it starts are the real cost |
| `Scheduler.livenessPass` — `:296` | **5 s** | for every project, for every row: `outsideNestedWorktrees`, `newestEditMs` (≤40 `stat`), `signalsFor` (5 shared readers), then `store.touch` when anything moved | **1,243 ms/pass** measured, i.e. a pass is in flight 25 % of the time; **304 `stat` + 344 fs reads per pass** (§4) |
| `Scheduler` full pass — `:629` | `slowSeconds 300` **intended** | `projectMeta` (5 git), board summary, `reconcile` (`worktree list`), then a full scan of **every row**, then `dueAfter` re-stamps all of them | **39.7 s per project**, 2 lanes → **≈ 35 min per full cycle** for 105 projects. `slowSeconds 300` is never honoured; the pool backlog sets the real cadence |
| `Scheduler.maybeFetch` — `:854` | `fetchSeconds 1800` **never fires** | `git fetch` per project | **No caller passes `fetch: true` except the button** (`server.js:4012`). `fetchPass` runs once at boot (`scheduler.js:174`). `fetchSeconds` is dead config — see §10 |
| `Assistant.tick` — `lib/assistant.js:508` | `max(2, seconds)*1000` (5 s default) | sentry pass over watches/queues | in-process bookkeeping; no subprocess |
| `Jobs.sweepTitles` — `lib/jobs.js:453` | 10 s | title refresh over the job map | in-process; `JSON.stringify` per changed job |
| `Jobs.sweepApprovals` — `lib/jobs.js:458` | 5 s | expiry sweep | in-process map walk |
| `Jobs.refreshStats(j)` — `lib/jobs.js:2132` | **4 s, per running job** | `usageStats()` → **opens `state.db`** and queries it (3 s cache) | one sqlite open+query per running job per 4 s. 95 jobs on the board, so this is N+1 over *live* jobs only |
| `Jobs.poll(j)` — `lib/jobs.js:2149, 2669` | **15 s, per running job** | HTTP status backstop against the gateway | one HTTP round trip per running job per 15 s |
| `Approvals.sweep` — `lib/approvals.js:16` | 5 s | expire pending approvals | map walk |
| `RemoteWrites.sweep` — `lib/remote-writes.js:75` | 5 s | expire parked pushes | map walk |
| `heartbeat` — `server.js:1684` | 5 s | writes a ~400 B `heartbeat` frame to **every** SSE client | 4 KB/min/client, trivial |
| assistant watchdog — `server.js:686` | 10 s | `assistant.supervise()` | in-process |
| orphan sweep — `server.js:709` | 15 s | `jobs.sweepOrphanedRuns()` | in-process |
| checked landings — `server.js:4174` | 10 s | re-verifies landings it started; each success **broadcasts a full 1.9 MB snapshot** (`:4164`) | 1.9 MB per landing, × clients |
| `warmParents` — `server.js:4178` | `max(30 s, stewardRefreshSeconds*500)` | parent book refresh | git reads (see `lib/parents.js`) |
| release sweep — `server.js:4186` | 60 s | pending release requests | map walk, no subprocess when empty |

## 3. Every timer, client side

Thirteen classic `<script>` files (`public/index.html:565-592`), `app.js` last. There is **no 30 s
poll**: `refreshSeconds` appears nowhere in `public/` — the board is SSE-driven, and the only periodic
fetch is the safety net at `app.js:14840-14844` that calls `resync()` **when the stream has been quiet
for 20 s**. The "30 s" on screen is cosmetic.

| Timer | Interval | Work | Measured cost |
|---|---|---|---|
| `tickLiveClocks` `app.js:1190` | 1 s | `querySelectorAll("[data-live-from]")`, writes `textContent` + `classList.toggle` | queries the document every second even with nothing live |
| age/queue/pulse clocks `app.js:14761` | 1 s | walks `.queue-ago`, `td.age`, `[data-sub-elapsed]`, and every running job card | it is the biggest single source of the 879 style recalculations/30 s |
| `tickApprovals` `app.js:6019` | 1 s | countdown over pending approvals | cheap, but always armed |
| `tickQuestionClocks` `app.js:16511` | 1 s | same for clarify questions | cheap |
| `applyPendingFocus` `app.js:7368` | **250 ms** | focus fixups | 4 executions/s, each a document query |
| `stickConsole` sweep `app.js:14675` | **400 ms** | every `pre.job-out`, `.think-body`, `.sub-console` in the page: `scrollHeight`/`scrollTop` (**forced layout**) + write | 2.5 executions/s × open consoles; a forced layout each |
| `sweepThinking` `app.js:3839` | 1.2 s | thinking-block redraw | |
| tool-store refresh `app.js:1680` | 3 s | for every open `.tgrp`: `groupLines` + `ensureToolStore` | N+1 over open tool groups, each an HTTP fetch |
| `refreshSubagentRoster` `app.js:3812` | 5 s | roster rebuild | |
| `tickLivenessRanks` `app.js:14868` (via `reorderSeconds`, default 5 s) | 5 s | **re-ranks every row of every project, every agent card, every project**, then `reorderProjects()` | `reorderProjects` = 0.95 ms × 27 calls/30 s; `reorder` per project |
| `reportVisibility` `app.js:16608-16609` | 3 s and 5 s | returns immediately unless `scanMode === "visible"` (it is `"all"`) — so two timers do nothing all day | 0 (dead in this config) |
| stream-rate line `app.js:14830-14838` | 1 s | `textContent` write + recompute | |
| `assistant.js:1857, 1864` | 1 s | watch clocks / assistant card | |
| update-check `core/update-check.js:192, 270` | watch / poll | GitHub release check | network, rare |
| row batch `queueRow` `app.js:12263` | **per animation frame** | drains the pending row map (`:12260`) into `placeRow` | see §7 |
| project reorder `queueReorderProjects` `app.js:11407` | **per animation frame** | full sort of 105 sections, re-appends only what moved | 0.95 ms/call measured |

## 4. Subprocess spawns: per row, per project pass, per sweep

**Per row — measured**, by patching `child_process.execFile` before importing `lib/scan.js` and
counting (`lib/scan.js:102-106`, `:196-267`):

| Path | Spawns | Calls |
|---|---|---|
| Fast scan (`depth "fast"`) | **3.00** (9 iterations, exact every time) | `status --porcelain=v2 --branch`, `log -1 --format=%cI`, `rev-list --left-right --count <remote>/<main>...HEAD` |
| Full scan, merged/ahead-0 branch | **6.00** | the 3 above + `merge-base --is-ancestor`, `cherry`, `reflog show` |
| Full scan, squash/rebase branch | **6.00** | same 6 (the `cherry` counts decide without a diff) |
| Full scan, unmerged branch | **9.00** | + `diff --stat`, then `log --oneline -20` and `diff --shortstat` (`lib/scan.js:250-258`) |

**Per project full pass** (`lib/scheduler.js:629-687`): `projectMeta` **5** (`lib/project.js:79-85`),
`worktree list --porcelain` **1** (`:728`), `branchUpstreams` **1** (`lib/project.js:321-334`, *not*
memoised), plus the memoised remote answers (`ls-remote`, `gh pr list`, `for-each-ref refs/remotes`) when
their 1800 s TTL has expired — then **one row scan per row** (`:661-674`). For `agent-worktree-gui`
(14 rows) that is **91-133 spawns per pass**.

**Per sweep:**

| Sweep | Spawns | Derivation |
|---|---|---|
| "Refresh now" (`fastPass`, `:597-609`) | **516** | 172 rows × 3 |
| One fleet full sweep (`fullPass`) | **1,767 – 2,283** | 105 × 7 overhead + 172 × (6…9) |
| Registry refresh (`lib/projects.js:200`, every 900 s) | **≈ 640 per pass** | 107 repos under `scanRoots` × ~6 calls (`for-each-ref`, `remote`, `symbolic-ref`, `rev-parse`, `log -1`, `remote get-url`) |
| Liveness pass | **0** subprocesses attributable to rows | `netstat -ano` + `tasklist` are shared, one each per 4 s TTL |
| Remote answers | 210 `ls-remote` + 210 `for-each-ref` + ~202 `gh pr list` per hour | one per project per 1800 s cache |

**Reconciling the measured 900-1,100/min** (derived, calibrated against the measurement):

| Source | /min | Share |
|---|---|---|
| Fast row scans (4.38/s × 3) | **788** | 83 % |
| Full-pass row scans (172 × 6 ÷ 35 min) | 29 | 3 % |
| Full-pass project overhead (105 × 7 ÷ 35 min) | 21 | 2 % |
| Registry refresh (640 ÷ 15 min) | 43 | 5 % |
| `netstat` + `tasklist` | 30 | 3 % |
| Remote reads (`ls-remote`, refs, `gh`) | 10 | 1 % |
| **Total** | **≈ 921** | vs **903-1,102 measured** |

So: **83 % of every process the panel starts is the per-row fast scan**, and two thirds of *that* is
the 120 rows on the 45 s tier (160 scans/min = 480 spawns/min), not the handful of live rows.

## 5. N+1 and repeated-work patterns (file:line)

1. **`store.rowsFor` is a prefix scan of the whole row map** (`lib/store.js:61-67`): it walks every row
   of every project and does a `startsWith`. **Measured 19.2 µs** per call at 172 rows. It is called
   from ~15 places, several of them inside per-row loops:
   - `lib/scheduler.js:506` — `scanOne` does `rowsFor(project).find(...)` to get `prevRow`: one full map
     walk per row scan.
   - `lib/scheduler.js:149,152` — `ctxFor` materialises `nested` and `parents` from `rowsFor` **twice per
     row scan** (measured **15.9 µs**), i.e. two whole-map walks per scan.
   - `lib/scheduler.js:311-313` — inside `livenessPass`, `rowsFor(project).map(...)` is rebuilt **for
     every row** of that project: O(rows²) per project per pass.
   - `lib/scheduler.js:773` — `reconcile` calls `rowsFor` once per listed worktree to answer "do we know
     this path", and again in the drop loop at `:781`.
   - `lib/scheduler.js:427` (`enqueueDue`) calls it once per project **per second** (105 calls/s), and
     `:412-422` (`dueAfter`) once per project pass; both then sort the tier with `tierSlots` (`:36-49`)
     every time, per project, per tick.
2. **`branchUpstreams` is the one remote answer that is not memoised** (`lib/project.js:321`), and
   `remoteAnswers` (`lib/scheduler.js:460-468`) calls it on every `fullScan` and every project pass: one
   extra `for-each-ref` git spawn per stale row per pass, for an answer that changes when a branch is
   pushed.
3. **`projectMeta` re-reads five facts per project per pass unconditionally** (`lib/project.js:72-98`) —
   tip, subject, date, local main, ahead/behind — even when the remote tip has not moved since the last
   pass. 105 projects × 5 = 525 spawns per full cycle, ~12 % of the full-pass cost.
4. **`signalsFor` does per-row filesystem work with no cross-row sharing** (`lib/activity.js:435-448`):
   `boardEntries(row.path)` (`readdir .agentboard`) and `declaredPorts(row.path)` (`readFile .env`) run
   **per row, per 5 s**. Only `netstat`/`tasklist`/sqlite are shared (their `memo` at `:32-52`).
5. **Liveness re-stats files the scan just stat'd.** `scanWorktree` stats up to 40 dirty/untracked files
   (`lib/scan.js:280-295`) and `livenessPass` does the same list again through `newestEditMs`
   (`lib/scheduler.js:315` → `lib/scan.js:327-339`) — **304 `stat` calls per pass, 3,648/min** on this
   fleet (derived from the rows, not instrumented).
6. **`/api/state` is one big composed snapshot** (`server.js:1643-1680` → `sendJson(res,200,snapshot())`
   at `:2164`): 1.96 MB, of which `jobs` is 54 %. Every reload and every `resync()` pays it.
7. **Full passes queue a whole project's rows at once** (`lib/scheduler.js:661`): `Promise.all` over all
   rows, so a 16-row project adds 16 scans to a 5-worker queue behind whatever the per-row cadence is
   already demanding. This is why the queue sits at 37-104 and `lastFullMs` is 39.7 s instead of the
   ~1 s a single project of 14 rows should take.

## 6. Whole-store rewrites instead of patches

**Server — the store itself is patched correctly**, but three things around it are not:

1. **`patchProject` always emits** (`lib/store.js:49-55`), with no before/after comparison, and every emit
   rebuilds `publicProject()` → `summaryFor()` → `rowsFor()` over the project's rows (`:163-183`). A full
   pass patches a project **three times** (`projectMeta`, board summary, `reconcile` at
   `lib/scheduler.js:636/642/809`), so every project, every cycle, forces three client-side section
   rebuilds whether or not one visible field moved.
2. **`putRow`'s change detection is defeated by `nextReadAt`.** `lib/store.js:138-143` compares the row
   with `scannedAt` masked out — but `scanOne` recomputes `nextReadAt = claim time + pollSeconds` on
   every scan (`lib/scheduler.js:584-585`), so the field always differs and `changed` is always `true`.
   Measured consequence: **15 of 132 consecutive row-event pairs differ *only* in `nextReadAt`**, 31 of
   132 in bookkeeping fields only. Every one of those is a full ~4.7 KB row event to every client and a
   full `<tr>` rebuild on the client.
3. **`/api/state` and the 15 `broadcast({type:"snapshot"})` sites** (`server.js:1011, 1068, 2154, 2230,
   2356, 2430, 2476, 2566, 3366, 3385, 3475, 3662, 4002, 4027, 4164`) push the **entire** 1.9 MB store
   to every tab. Deleting one worktree (`:4164`) sends jobs + projects + assistant + hosts again.

**Wire — one row event is the whole row**, including `dirtyFiles`, `untrackedFiles`, `signals`, `sync`,
`unmergedCommits`, `todo` and `description`. Measured: 4,728 B average, 32 % of it the todo list text,
15,780 B for a row that carries a long todo.

**Client — a `project` event replaces the whole section.** `public/core/sse.js:84-107` builds
`projectSection(name)` into a detached div, swaps the `<section>` in, moves the old row nodes back and
then calls `renderProjectRows(name)`, which at `app.js:12526/12557` calls `fitColumns()` — a **forced
layout** — for every project in the section. `applySnapshot` does the same walk for all 105 projects
(`app.js:12788-12790`) even though its own comment says a collapsed project "no-ops".

## 7. The client: what is rebuilt per poll, per frame, and what it costs

**Parse cost of `public/app.js` is not the problem.** 868,665 bytes / 16,643 lines compiles in
**9.5 ms cold, 1.1 ms warm**; the whole 13-script load costs **78 ms of `ScriptDuration`** and the page
is interactive at DCL **418 ms**. Whatever 16,643 lines come to, they are not a poll cost — the file is
parsed once.

**Per animation frame:** `queueRow` (`app.js:12274`) batches pending row events into one rAF flush, and
`queueReorderProjects` (`:11413`) batches the re-sort. Batching is correct.

**Per row event** (`placeRow`, `app.js:12282`, measured **0.98 ms/call**):
- `rowHtml(row)` — **0.07 ms**, 2,668 B — then `holder.innerHTML = rowHtml(row)` at **`:12324`**
  (**0.4 ms**, 28 nodes) … and only *then* the collapsed check at **`:12344`** returns early when the
  project is closed. With all 105 projects collapsed the board holds **0 row elements**, yet every row
  event still builds and parses a full `<tr>` and throws it away: **55 builds / 30 s** measured, 0 rows
  in the DOM, and the node count grew **+11,643 in one 30 s window** — that is allocation churn from the
  discarded builds plus the section swaps, not a leak (the heap stayed at 9.8 MB and GC reclaims it).
- `refreshChips(project)` — **0.38 ms**, 56 calls/30 s.
- then `queueReorderProjects` → `reorderProjects` — **0.95 ms**, 27 calls/30 s.

**Per project event:** whole section rebuild + `renderProjectRows` + `fitColumns` (forced layout).
Measured `renderProjectRows` at **0.2 ms** and `fitColumns` at **0.2 ms** for a collapsed project — cheap
each, but 3 per project per cycle × 105 projects = ~315 section rebuilds per full cycle.

**Idle tab totals, measured, 30 s, everything collapsed:** 127 layouts, 879 style recalculations,
2,331 ms task time, 356 ms script, 101 ms layout, 140 ms style, 5 long tasks in the earlier window.

**Per hour a single idle tab costs:** ≈ **280 s of main-thread task time**, **15,240 forced layouts**,
**105,480 style recalculations**, 43 s script, 12 s layout, 17 s style — plus ~103 MB of SSE.

**V8 profile of 30 s idle** (self time): 96.6 % idle, 778 ms `(program)` (HTML parse + compile + IC —
the discarded `rowHtml` builds and the section swaps), 70 ms `querySelector`, 44 ms `renderJobs`,
33 ms `placeRow`. So the client's cost is **DOM churn**, not JavaScript logic.

## 8. Ranking

### 8.1 By cost per hour of an idle panel (nothing running, nobody looking)

1. **Per-row fast scans — ~47,000 git launches/hour, ~83 % of the process load, ~17-28 CPU-min/hour.**
   4.38 scans/s × 3 spawns × 60 min. The 45 s tier (120 rows) is 61 % of it; the 5 s tier (6 rows) is
   27 %. With `scanMode: "all"` every one of 172 rows is read whether or not any page can see it — the
   `visible` mode that would skip the other ~100 projects exists (`lib/scheduler.js:221-227`) and is off.
2. **The full-pass cycle — ~50 launches/min (~5 %) but it is what the queue is stuck behind.** Every row
   is scanned a second time per cycle on top of its cadence (`:661-674`), the cycle takes ~35 min not
   300 s, and each project pass holds pool slots for 39.7 s. This is the item that turns a 5 s cadence
   into an unmeetable one: demand 4.38/s against a 5-worker pool that also has to absorb 172 extra
   scans every 35 min.
3. **Registry refresh — ~43 launches/min in a 640-spawn burst every 15 min** for an answer that changes
   when a repo is created.
4. **`netstat -ano` + `tasklist /FO CSV` — 30 launches/min**, each parsed with regex over up to an 8 MB
   buffer, for a signal whose TTL is 4 s.
5. **Liveness filesystem work — 3,648 `stat`/min + 344 reads/min**, re-statting files the scan just
   stat'd, and re-reading `.agentboard`/`.env` per row per pass.
6. **`/api/state` — 1.96 MB and 135-150 ms of server time per read**, 2.18 s if the caches are cold;
   plus 1.9 MB per snapshot broadcast at 15 sites.
7. **SSE — ~103 MB/hour per open tab**, 4.56 row events/s, 23 % of them carrying no information beyond
   the server's own next-poll timestamp.
8. **Client main thread — ~280 s/hour, 15,240 layouts, 105,480 style recalcs**, with the largest single
   chunk being row HTML built and discarded for collapsed projects.
9. **Per-frame discarded row builds — ~110 min/hour × 0.98 ms ≈ 6.5 s/hour** of client time spent
   producing nothing visible (the node allocation is the expensive part, not the 0.98 ms).

### 8.2 By cost while runs are live

1. **A live row's cadence drops 45 s → 5 s (9×)**: +12 scans/min and **+36 spawns/min per live row**.
   A row is "live" when a session, a board claim, a listening port or a fresh file edit says so — and a
   live row **always writes** (`lib/scheduler.js:327-338`), so it also emits a row event every 5 s even
   when the only field that moved is `lastAliveAt` (measured: one such event's diff was exactly
   `lastAliveAt`).
2. **The job stream is the second-largest byte cost**: 44 `job` events in 62 s at **9.1 KB each**
   (23 MB/h) + 98 `jobline`/62 s. Every `job` event re-sends the whole job record — prompt, lines,
   stats — and on the client `renderJobs` was the third-largest JS consumer in the idle profile.
3. **Per running job: a sqlite open+query every 4 s** (`lib/jobs.js:2132` → `usageStats`) **and an HTTP
   poll every 15 s** (`:2149`). With N agents running that is N × (15 + 4) reads/minute against a
   database the liveness pass is also opening every 5 s.
4. **Each landed worktree broadcasts a fresh 1.9 MB snapshot** (`server.js:4164`), so a landing sweep
   is the one time the panel pushes whole-store bytes per *event* rather than per connection.
5. **Client, per open card**: the 400 ms console-stick sweep does a forced layout per `pre.job-out`, the
   1 s clocks walk every card, the 3 s tool-store timer fetches per open tool group — all of it scales
   with the number of open transcripts, and all of it runs while an agent streams lines into them.

---

## 9. What I could not measure

- **Split of CPU between git.exe children and the panel process.** `Get-Process .CPU` is per-process, so
  the 25-34 ms per launch is *parent-side* CPU (CreateProcess + pipes + reading) plus the panel's own
  bookkeeping; the child's CPU was not isolated.
- **A quiet-box baseline.** Every wall-clock figure was taken with four other agent sessions running and
  the panel's own queue at 37-104. The 300 ms `git --version` floor is an upper bound, not a floor.
- **`gh pr list` cost.** Every 60 s window showed `gh = 0` launches: the 1800 s PR cache was warm
  throughout. The 202 calls/hour figure is arithmetic from the cache TTL, not an observation.
- **A genuinely 300 s full cycle.** `slowSeconds` was never observed to be honoured — the cycle is
  backlog-bound at ~35 min — so the intended cadence's cost could not be measured, only its overshoot.
- **GPU/compositor cost on the client**, and the cost of a *second* open tab (all client numbers are one
  tab).
- **`descriptions.withDescriptions` / `withTodos`** inside `snapshot()`: the whole snapshot TTFB was
  measured (135-150 ms warm), the per-wrapper split was not.

## 10. Two knobs that are not doing what their name says

- **`fetchSeconds: 1800` never triggers a fetch.** `maybeFetch` is only reached with `fetch: true` from
  `server.js:4012` (the button) and `fetchPass` runs once at boot (`lib/scheduler.js:174`). Nothing
  re-arms it, so `lastFetch` ages forever and `fetchNote` is only ever written by a manual press.
- **`refreshSeconds: 30` is not a poll.** It is sent to the page (`server.js:741`) and painted; `public/`
  contains no reference to it. The real safety net is the 20 s-of-quiet `resync()` at `app.js:14837`.

Neither is an efficiency defect on its own, but both make the cost model in this review read wrong to
anyone tuning the panel from `config.json`.

---

*Measured on `wtgui/deep-architectural-revie-4141e9` @ b64642d, 2026-10-30, against the live panel on
port 7331 (105 projects / 172 rows). Read-only review: no code was changed.*
