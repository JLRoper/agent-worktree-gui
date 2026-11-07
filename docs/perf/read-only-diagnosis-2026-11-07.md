# The panel's seconds are its own child processes

Read-only diagnosis of the live board on this host: every node process on the machine mapped, the
panel's event loop measured from inside it, `/api/health`, `/api/state` and `/api/jobs` timed, and the
cause named with a ranked mitigation. No product file was changed; the only file this worktree adds is
this report.

## Provenance

| item | value |
| --- | --- |
| code | this worktree on `wtgui/read-only-diagnosis-of-t-0b803b` at `73def4f` (1.43.8), cut from `main` at the same sha |
| live panel (1) | `http://127.0.0.1:7331`, pid 41116, booted 20:00:42 local, 329 to 354 MB, endpoint of every sample in sections 3 and 4 |
| live panel (2) | `http://127.0.0.1:7331`, pid 44072, booted 03:42:58Z (22:42:58 local), 264 to 307 MB, the control and the 200 s window in section 3 |
| live checkout | the repo's main working tree at `daa0012` — 200 lines ahead of this tree in `lib/scheduler.js` and `server.js` (the tier gate), so section 7 is read against the live file, not this one |
| live board | 177 projects, `/api/state` 3,730,099 bytes, `/api/jobs` 1,322,476 bytes, `/api/health` 71,881 bytes |
| host | Windows 11, 16 logical cores, node v26.3.0; observed processor load 31 % |
| measured | 2026-11-07 02:50 to 04:12Z (21:50 to 23:12 EST) |
| scratch | the run's own `%TEMP%/wag/d6e3c1e7` (`latency-probe.mjs`, `inspect-panel.mjs`, `spawn-census2.mjs`, `observe.mjs`, `spawn-block.mjs`, `process-map.ps1`, `observe.json`, `cpu-samples*.csv`) |
| concurrent load | another worktree's full `node --test` suite at 22:20-22:34 and again from 23:03 (4 workers plus two to four panels of its own) |

## Method

| what | how |
| --- | --- |
| the process map | `Get-CimInstance Win32_Process` for pid, parent, start, command line; `Get-NetTCPConnection` for the port owner; `Get-Process` for CPU seconds, working set, thread count |
| CPU per process | `TotalProcessorTime` sampled every 2 s for 250 s, divided by the interval and by 16 cores |
| event-loop delay | `perf_hooks.monitorEventLoopDelay({resolution: 10})` installed **inside the live process** over the inspector (`process._debugProcess(pid)`, `Runtime.evaluate`) |
| CPU profile | `Profiler.start` at a 500 µs sampling interval, self samples aggregated per function, 70 s window |
| child-process census | `async_hooks.createHook({init})` filtering `PROCESSWRAP`, recording the JS stack of every creation |
| blocking stacks | `Debugger.enable` then `Debugger.pause` 12 times, one per second, each captured and resumed at once |
| route latency | serial `fetch` with `accept-encoding: gzip`, 30 samples of `/api/health`, 8 each of `/api/state` and `/api/jobs` |
| per-spawn cost | a scratch node process timing the blocking part of `spawn()` and the whole of `execFile`/`execFileSync` against `git` |
| the panel's own counters | `GET /api/stats` (scheduler ticks, full passes, pool depth) |

The inspector attach is a read of the running process, not a change to it: it printed
`Debugger listening` into `~/.wag/logs/server.err.log` and was closed when each probe ended. It does
add sampling overhead while attached, which is why every CPU figure below is a lower bound and the
route figures are ranges.

## The answer in one paragraph

A fresh panel answers `/api/health` in **5 ms** and `/api/jobs` in **28 ms**; on the older process (pid
41116) the same routes were observed at **0.31 to 5.99 s** and **0.62 to 13.12 s**. The routes are not
the difference. The panel's main thread creates a child process **3.4 to 4.1 times a second** — almost
all of them `git`, from the full-pass sweeps that run on the main thread (`projectMeta`, `remotesOf`,
`ParentBook.refresh`/`reflogCut`) — and **83.5 % of its sampled CPU is inside `spawn`**. On this box a
single `CreateProcess` costs a median of 23 ms and a p90 of 1.6 s: the median would be survivable, the
tail is not, and four a second of that tail holds the loop shut — the panel's own `/api/stats` shows
**23 ticks in the first 28 minutes** of a scheduler that asks for one per second. The stall then feeds itself: every helper has a 120 s deadline,
its `close` event is late because the loop is blocked, the deadline fires on a child that has already
exited, and the expiry handler runs `taskkill` **synchronously** — 810 such expiries in three hours.
At 04:06Z that cascade stopped the board serving entirely for about four minutes (228 sockets in
`CLOSE_WAIT`, no accept). The fix is not in the routes: the main thread must stop creating the
processes, and the expiry path must stop creating one to kill one.

## 1. Every node process on the box, mapped

Snapshot 2026-11-07 04:09Z, 22 node/python processes. "Parent" is whether the parent pid still exists.

| pid | role | parent | started | ws | threads | CPU s | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **44072** | **the panel** | 52892 (gone) | 22:42:58 | 264 MB | 17 | 463 | `agent-worktree-gui\server.js`, owns `0.0.0.0:7331` (the inspector on 9229 was this diagnosis's attach) |
| 28644 | **leaked child** | 27196 (gone) | 18:05 | 46 MB | 12 | **17,311** | `%TEMP%\kilo\watch-probe15.mjs` — a scratch probe left by an earlier bundle-scan investigation, at ~0.93 of a core for 4.8 h |
| 18056 | **gateway** (not node) | 32204 (gone) | 18:11 | 514 MB | 98 | 2,708 | `python -m hermes_cli.main gateway run`, `127.0.0.1:8642` — the panel's Runs API |
| 60804 | matrix bridge (python) | 41860 | 18:08 | 42 MB | 3 | 3.5 | `hermes_matrix_bridge.py` |
| 39168, 33288 | browser harness daemons (python) | gone | 20:50, 20:57 | 16 MB | 1 | 0.5 | two `browser_harness.daemon` instances, one per past probe |
| 43716 | CLI agent | 53956 | 08:58 | 16 MB | 9 | 0 | `@kilocode/cli` — an editor-side agent, not the panel's |
| 44048 | LSP | 48556 | 23:03 | 64 MB | 16 | 0.7 | `typescript-language-server --stdio` |
| 38828, 60360 | LSP workers | 44048 | 23:03 | 212/449 MB | 11/16 | 2.7/25.5 | `tsserver` |
| 27588 | LSP helper | 60360 | 23:03 | 76 MB | 11 | 0.3 | `typingsInstaller` |
| 42344 | test suite (npm) | 53080 | 23:03 | 70 MB | 15 | 0.2 | `npm test` |
| 43264 | test suite (runner) | 17756 | 23:03 | 69 MB | 11 | 5 | `node --test --test-concurrency=4 test/*.test.js` |
| 60912, 51668, 26092, 54604 | test workers | 43264 | 23:06-23:09 | 73-85 MB | 13-18 | 0.3-3.8 | the 4 concurrent test workers |
| 51500, 32220 | **panel instances under test** | 60912, 51668 | 23:09 | 110/107 MB | 18 | 1.7/0.5 | `node server.js` on `127.0.0.1:56238` and `:62497`, synthetic boards in the suite |
| 43560, 46960 | test tools | 62004, 23232 | 23:09 | 0-68 MB | 0-10 | 0-5.7 | `tools/version.mjs check`, `tools/land.mjs --check` |

What the map says:

- **One panel, and it is not a worker host.** No node process is a live agent run: the panel starts
  its assistants through the Hermes CLI (`hermes_runtime.json` -> `hermes`), which is a **python**
  process, and none was running at the snapshot. The only panel-owned processes at any instant were
  0 to 5 `git.exe` children.
- **The gateway is python, not node** (pid 18056, 514 MB, 98 threads). It is not in the node budget and
  was not the slow party: `/api/health` never waits on it, while `/api/jobs` can wait up to the 4 s
  probe (`lib/jobs.js:862`, 4 s abort at `:871`).
- **The rest is other agents' work**: a full test suite (4 workers, 2 panels of its own) and the LSP
  servers this session's editor keeps. The test suite is a *spawn multiplier*: each worker boots a
  panel that scans a synthetic board, so the box gets two more `server.js` processes and their git.
- **One genuine leak**: pid 28644, orphaned at 18:05, still burning ~0.93 of a core 4.8 hours later.
  Its source is a probe that "waits for natural exit" after a `createBuild` scan — the same memoised
  scan the 2026-11-06 backend audit named. It is unrelated to the panel's own loop (it is a separate
  process) but it takes a full core from every measurement on this box.

## 2. CPU: the box is not the bottleneck

250 s window, every 2 s, 16 cores:

| process | mean, all cores | mean, one core | peak |
| --- | --- | --- | --- |
| panel 44072 | 2.21 % | 0.35 | 12.06 % (1.9 cores) |
| leaked probe 28644 | 5.84 % | 0.93 | 7.30 % |
| test runner 43264 + workers | < 0.6 % each | — | — |
| LSP 60360 | 0.01 % | — | — |

Total node CPU was **9.4 % of 16 cores** (about 1.5 cores), and the machine reported 31 % load. The
panel is not starved of CPU: it is a process that is *blocked*, not a process that is *busy*. Its mean
is one third of a core, and its peak (1.9 cores) is the burst where the event loop is doing the
`spawn`/`taskkill` work — the same work that keeps it from answering.

## 3. Event-loop delay, measured inside the panel

`monitorEventLoopDelay`, resolution 10 ms, installed in the live process:

| panel | window | samples | mean | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 41116 (2 h 40 m uptime) | ~70 s | 44 | **334.2 ms** | 10.1 ms | 1,161.8 ms | 3,886 ms | **3,886 ms** |
| 44072 (fresh boot) | 200 s | 1,413 | **142.9 ms** | 15.4 ms | 410.5 ms | 2,550 ms | **4,865 ms** |

The sample count is itself a reading: at a 10 ms resolution a free loop produces ~100 samples a second;
44 in 70 s means the loop was given control about once every 1.6 s. The second panel, sampled from
minute one, produced 1,413 samples in 200 s — better, and still a mean lateness of 143 ms.

The panel's own scheduler counter agrees, and it is the single cleanest number in this report. The live
code asks for a tick **every 1,000 ms** (`setInterval(() => void this.tick(), 1000)`). At 04:11Z,
1,730 s after boot, `/api/stats` reported **`ticks: 41`** — one tick per 42 seconds, a 97 % loss. The
tick itself is fast (`lastTickMs: 14` to `22`); the gaps are the loop being unavailable.

## 4. The three routes, timed

Serial samples against the live panel, gzip accepted:

| route | bytes | n | min | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/health` | 71,881 | 30 | **306.5 ms** | 2,150.8 ms | 5,826.6 ms | 5,986.2 ms |
| `/api/state` | 3,730,099 | 8 | 1,700.7 ms | 3,148.4 ms | 5,417.6 ms | 5,417.6 ms |
| `/api/jobs` | 1,322,476 | 8 | 619.1 ms | 2,893.6 ms | 13,118.2 ms | **13,118.2 ms** |

The same routes on the fresh process, 62 s after boot:

| route | sample |
| --- | --- |
| `/api/health` | **5.2 ms** (and 43 ms once the first full pass had begun) |
| `/api/jobs` | **28.2 ms** (minimum of the eight samples, taken between passes) |
| `/api/state` | 1,196.9 ms (minimum; 3.7 MB is not free to assemble) |

So `/api/health` has a floor of about 5 ms and a ceiling of about 6 s on the same build, same board,
same box. The gap is queueing behind the loop, not handler work: the route has five keys and one of
them is a 177-entry list of project names (71,881 bytes), and the handler runs no git. The board's own size sets the floor for `/api/state`
(3.7 MB assembled per request) but not the spread; `/api/jobs`' 13 s outlier is the loop, since its
own work (list + stringify + gzip of 1.3 MB) is a few tens of milliseconds.

## 5. The cause: `spawn` on the main thread

The CPU profile of the old panel, 70 s, self time by function:

| share | function |
| --- | --- |
| **83.5 %** | `spawn` (`node:internal/child_process`) |
| 9.1 % | `all` |
| 1.7 % | `existsSync` |
| 0.9 % | `get` |
| 0.9 % | `rowsFor` (`lib/store.js:61`) |
| 0.3 % | `(idle)` |

The blocking stacks, taken by pausing the process 12 times in 12 s, were the same frame ten times out
of twelve:

```
get hasSubscribers <- spawn <- spawn <- execFile <- (anon) <- exec
```

`spawn()` is where `CreateProcess` happens, and on Windows it is **synchronous inside the caller**: the
JavaScript thread is blocked for the whole of the call. What it costs here, measured from a scratch
process while the test suite was running:

| operation | n | min | p50 | p90 | max |
| --- | --- | --- | --- | --- | --- |
| `spawn()` blocking part only | 20 | 17.0 ms | **23.2 ms** | 1,619.3 ms | 1,676.1 ms |
| `execFileSync("git", ["--version"])` | 10 | 65.5 ms | 115.1 ms | 858.9 ms | 858.9 ms |
| `execFile("git", ["--version"])` whole call | 12 | 65.6 ms | 416.4 ms | 1,011.3 ms | 1,387.7 ms |
| `execFile("git", ["-C", <repo>, "rev-parse", ...])` | 12 | 78.0 ms | 437.5 ms | 1,827.6 ms | 2,197.7 ms |

The distribution is the point: a **median of 23 ms** would be survivable at four a second (9 % of the
loop), but the **p90 of 1.6 s** is not. Process creation on this host is dominated by the kernel and by
whatever filter driver is watching `git.exe` start, and it is worst exactly when the box is busiest —
which is when the panel is busiest too.

### Where the children come from

`async_hooks` census, 41 s on the old panel (138 children) and 47 s on the new one (116):

| caller | old panel | new panel |
| --- | --- | --- |
| `reflogCut` (`lib/parents.js:62`), from `ParentBook.refresh` and `backfillCandidates` | 91 | 26 |
| `ParentBook.refresh` (`lib/parents.js:328`) — `git for-each-ref` | 30 | 11 |
| `remotesOf` (`lib/base-ref.js:36`) — `git remote`, 60 s TTL per project | 13 | 9 |
| `projectMeta` (`lib/project.js:85` to `:89`) — five git calls per project | — | 45 |
| `branchUpstreams` (`lib/project.js:326`) | — | 7 |

Rates: **3.4 children/s** (138/41 s) on the old panel and **4.06/s** (812/200 s) on the fresh one. The
new panel's 200 s window gives a rough shape, not a clean correlation: buckets with 63 to 82 creations
had medians from 139 to 2,341 ms, while the quietest bucket (28 creations) still read 2,062 ms because
the stalls it inherited had not drained. The loop's delay is sticky across buckets, so the bucket is a
direction, not a proof; the proof is the profile and the census in the rows above.

Every one of those call sites is on the **main thread**:

- `projectMeta` (`lib/project.js:74`) does five `gitIn` calls in a `Promise.all` — `rev-parse`,
  two `log -1`, `rev-parse`, `rev-list --left-right --count` — per project, per full pass.
- `ParentBook.refresh` (`lib/parents.js:327`) one `git for-each-ref` and then `reflogCut`
  (`lib/parents.js:61`) one `git reflog show` **per unresolved branch**.
- `remotesOf` (`lib/base-ref.js:31`) one `git remote` per project with a configured remote, cached 60 s.

The scan pool (`lib/pool.js`) already exists for exactly this reason — five worker threads on the live
panel (the class default is 4), each with its own git children — and none of the three sweeps above uses
it. The rows are scanned off-thread; the project headers and the parent book are not.

## 6. The 120 s deadline that keeps the panel down

Every helper is registered with a hard ceiling (`HELPER_LIMITS.git = 120_000`,
`lib/child-tree.js:30`), and the expiry handler kills it with `execFileSync("taskkill", ...)` and a
15 s timeout (`lib/child-tree.js:64`, `:69`):

```
child 3376 (git -C .../web-bill-of-lading-multi-review-..., panel) taskkill (already gone)
```

**810 of those lines** are in `~/.wag/logs/server.out.log`, from 01:09Z to 04:10Z, one every ~13 s. The
text is the diagnosis: *already gone*. The git had finished; its `close` event was queued behind the
blocked loop; the 120 s timer fired first; the handler then created **another process** to kill a
process that no longer existed, and that creation blocked the loop again.

That is a positive feedback loop, and it is what the terminal state looks like. At 04:06Z the panel had
**228 sockets in `CLOSE_WAIT` and 228 in `FIN_WAIT_2`**, `netstat` still showed it listening on 7331,
`curl` could not connect at all (Windows was dropping SYNs into a full accept queue), and the process
kept logging expiries — a loop that was alive enough to log but not to accept. It recovered on its own
at 04:11Z (`/api/health` 43 ms) once the sweep drained; the panel had not restarted (same pid 44072,
same `server.pid`).

## 7. Why the storm does not stop

The live code's own counters (`/api/stats`, 04:11:48Z, 1,730 s after boot):

| counter | value | what it means |
| --- | --- | --- |
| `fullPasses` | 177 | one full pass per project, over the 177 projects, in the first 29 minutes |
| `lastFullMs` | 21,337 | the last full pass took 21 s of wall time |
| `pool.queued` | 375 | 375 scans waiting behind 5 in flight |
| `pool.completed` | 472 | scans that did finish |
| `ticks` | 41 | a 1 s timer that ran 41 times in 1,730 s |

`fullPassProject` (`lib/scheduler.js:636`) does `projectMeta` (`:643`, five git calls), a board summary,
a `git worktree list --porcelain` reconcile, and the remote/PR answers — about eight to ten child
creations per project. At 177 projects that is ~1,500 creations for one pass; at 4/s that is six
minutes of continuous spawning, which cannot fit inside the 60 s `slowSeconds` window. The pass never
catches up, so the panel is always inside one.

`warmParents` (`server.js:6480`, armed at `:6588` every `stewardRefreshSeconds * 500` = 150 s, guarded
to one pass per 300 s) adds a second sweep over **every project**, and it calls `parents.refresh` with no
`branches`, so `refresh()` resolves the whole repository rather than the rows the board is showing — one
`for-each-ref` plus one `reflog show` per unresolved branch, per project. Its own log line ("parents: 27
branch(es) resolved ...") appears every 2.8 to 5.5 minutes, i.e. it is essentially continuous.

And `remotesOf` is cached for only `REMOTES_TTL_MS = 60_000` per project — one `git remote` per project
per minute, on the main thread, for as long as the board is up.

## 8. What to fix, ranked

1. **Take the three main-thread git sweeps off the loop.** `projectMeta`, `remotesOf` and
   `ParentBook.refresh`/`reflogCut` are the whole of the measured spawn traffic. The scan pool
   (`lib/pool.js`, 5 workers) already owns child processes off-thread; give it a project-shaped task or
   a second pool, and await the answer in the scheduler. Measured basis: 83.5 % of sampled CPU in
   `spawn`, 4 children/s, `spawn()` p90 1.6 s. Risk: medium — the pool's task shape is scan-shaped, and
   the parent book is written by the main thread today, so the write needs to stay there.
2. **Cut `projectMeta` from five git calls to one or two, and cache it.** `rev-parse` + `log -1
   --format=%s%n%cI` + `rev-list --left-right --count` can be answered by one `git log -1` plus one
   `git rev-list`, and a project header does not change between two full passes unless the branch moved.
   Measured basis: 45 of 116 children in the 47 s census were this function's five calls over 9 projects
   — 39 % of the panel's spawn traffic for the cheapest data on the board. Risk: low.
3. **Make `warmParents` resolve the board, not the repository.** Pass the rows' branches
   (`branches` is already a parameter of `refresh`), skip projects whose rows all have an exact record,
   and put a child budget on one pass (stop at N spawns and continue on the next tick) so a pass cannot
   monopolise the loop. Measured basis: 91 of 138 children in the 41 s census were `reflogCut`. Risk:
   low — a guess is already allowed to be absent.
4. **Stop spawning `taskkill` for a pid that is already gone, and never synchronously.** `expire()`
   (`lib/child-tree.js:334`) can check `pidAlive(pid)` first (a syscall, not a process) and treat a
   dead pid as the outcome it wanted; the kill itself should be an async `execFile` with its own cap,
   not `execFileSync`. Measured basis: 810 expiries, nearly all "already gone", each one a full
   CreateProcess on the blocked loop. Risk: low.
5. **Do not run the panel's own full test suite on the box that hosts the live board.** It boots two to
   four more panels, each scanning a synthetic board, and it is the multiplier that turns a 23 ms
   `CreateProcess` into a 1.6 s one. This is not the panel's bug; it is why the same code is fast at
   05:00 and unusable at 23:00. Risk: none — it is a scheduling convention.
6. **Not a cause, but worth thinning: `/api/health` is 71,881 bytes** (a list of 177 project names) for a
   route whose handler does no work. A 200-byte version would make the canary cheap; it will not fix
   the seconds.

Two things the measurements say *not* to do: do not replace the snapshot assembly (3.7 MB `/api/state`
is a 1.2 s floor, not the 6 s ceiling) and do not add CPU — the panel uses a third of a core; the
problem is that it is never scheduled.

## 9. Caveats

- **The host was shared.** Another worktree's full `node --test` suite ran 22:20-22:34, and again from
  23:03; it boots two to four panels of its own and spawns git in every test. The per-spawn p90 of 1.6 s
  was measured under that load and is the *environment*, not the panel's own cost. On a quiet box the
  same code would be far less bad — the storm would still be there, but each child would cost ~20 ms.
- **The panel restarted during the measurement, by its own assistant.** At 03:41:58Z the log says
  `restart: panel restart queued ... by assistant: load 1.43.8 from the pulled checkout`; the old pid
  41116 was replaced by 44072 at 03:42:58Z. Every "old panel" figure is 41116, every "fresh panel"
  figure is 44072. The restart was not caused by this diagnosis.
- **The inspector attach is a probe, not a change.** It enables the inspector on a running process
  (`process._debugProcess`), which prints a line into `server.err.log` and adds sampling overhead while
  attached. The CPU share is therefore a lower bound; the route times are ranges.
- **My own GETs filled the socket table.** Every request that timed out (the 30 s and 60 s ceilings)
  left a connection the panel had accepted but never finished; by 04:06Z there were 228 `CLOSE_WAIT`
  sockets and 228 `FIN_WAIT_2`. That the panel does not close responses it has given up on is a real
  finding, but the count is partly the measurement's own footprint.
- **The live code is not this tree.** The panel runs the main checkout at `daa0012`, which is 200 lines
  ahead in `lib/scheduler.js` and `server.js` (the two-tier gate). The three hot call sites this report
  names — `projectMeta`, `ParentBook.refresh`/`reflogCut`, `remotesOf` — are byte-identical between
  `73def4f` and `daa0012`; the pass *count* is not, because the live code parks old projects in an
  "old" tier. Section 7 uses the live process's own counters, not this tree's arithmetic.
- **One window, one board.** 177 projects, 3.7 MB of snapshot, 95 jobs. A board with ten projects would
  not show the same severity; the mechanism is per-project, so it scales with the board.

## 10. Reproduce

```bash
# the routes, serial, with a body size (the numbers in section 4)
for u in /api/health /api/state /api/jobs; do
  for i in 1 2 3 4 5; do curl -s -o body.tmp -w "%{time_total} %{size_download}\n" --max-time 60 "http://127.0.0.1:7331$u"; done
done

# the panel's own counters: ticks vs uptime, full passes, pool depth
curl -s http://127.0.0.1:7331/api/stats

# event-loop delay inside the live process (attach, histogram, close)
node "%TEMP%/wag/d6e3c1e7/observe.mjs" 200 <pid>

# the child-process census, by caller, 45 s
node "%TEMP%/wag/d6e3c1e7/spawn-census2.mjs" 45

# what one CreateProcess costs on this host
node "%TEMP%/wag/d6e3c1e7/spawn-block.mjs"

# the process map
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%/wag/d6e3c1e7/process-map.ps1"
```

## 11. Owning function and `file:line` for every cost

Line numbers are on this tree at `73def4f`; the live checkout at `daa0012` keeps these functions but
moves some of the scheduler's lines.

| cost | owner | line |
| --- | --- | --- |
| five git calls per project, main thread | `projectMeta` | `lib/project.js:74`, calls at `:85`-`:89` |
| project meta on every full pass | `fullPassProject` | `lib/scheduler.js:636`, `:643` |
| `git remote` per project, 60 s TTL, main thread | `remotesOf` | `lib/base-ref.js:31`, TTL at `:21` |
| `for-each-ref` per project, main thread | `ParentBook.refresh` | `lib/parents.js:327`, `:328` |
| `git reflog show` per unresolved branch | `reflogCut` | `lib/parents.js:61`, `:62` |
| the whole-repo parent sweep, every 300 s | `warmParents` / its timer | `server.js:6480`, `:6588` |
| one `git for-each-ref` per project for upstreams | `branchUpstreams` | `lib/project.js:326` |
| child creation is synchronous on the caller | `spawn` in `ChildTree.exec` | `lib/child-tree.js:170`, `:185` |
| synchronous `taskkill` per expiry | `killTree` | `lib/child-tree.js:64`, `:69` |
| the 120 s git ceiling | `HELPER_LIMITS.git` | `lib/child-tree.js:30` |
| the expiry that fires on an already-dead child | `expire` | `lib/child-tree.js:334`, `:340` |
| the off-thread pool that could own all of it | `Pool` | `lib/pool.js:22`, `:28` |
| `/api/health` (71,881 bytes, 5 ms to 6 s) | route | `server.js:2947` |
| `/api/state` (3.7 MB) | `snapshot()` | `server.js:2775`, route `:4041` |
| `/api/jobs` (1.3 MB) | route | `server.js:4597` |
| `/api/stats` (ticks, full passes, pool depth) | route | live checkout only (`daa0012`) |
