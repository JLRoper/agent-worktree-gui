# The 5.8 s discovery, the 1200 ms bundle scan, and a settings write that survives a slow panel

Three numbers from one row, measured rather than guessed: project discovery taking 5.8 s across 177
projects, the static bundle scan missing its 1200 ms deadline every 20 to 30 seconds, and a chart
column switch that was called NOT SAVED while its write was still queued. The first two are wall
clock, not work: the panel's own event loop is the cost, and the passes are its victims. The third
was the page giving up too early, and it is fixed.

## Provenance

| item | value |
| --- | --- |
| code | this worktree, branch `wtgui/re-issue-this-row-in-a-fresh-tree-after-16e59c` at `b4b3dcb3` plus the discovery and harness changes below |
| board | the live panel's own cache: 177 projects, 531 rows, roots `C:/ProjectDevelopment` and `C:/CodeReviews` |
| host | Intel Core Ultra 7 265H, 16 logical CPUs, Windows 11, ~4 GB free during the runs |
| measured | 2026-11-09 17:18 to 17:45Z (local 12:18 to 12:45) |
| scratch | `C:/Users/roper/AppData/Local/Temp/wag/d80c337e`: `discovery.json`, `discovery-after.json`, `bundle.json`, `log.json`, `settings-retry-out2.json` |
| tools | `tools/measure-slow-panel.mjs` (new), `tools/verify-settings-retry.mjs` (new) |

## The answer in one paragraph

Discovery's own work is 18 to 51 ms across 177 projects. The 5.8 s pass was a chain of 369 `stat`
awaits, one per folder, each re-entering a loop that was busy with the scan pool; the pass now
issues those stats as one batch, and the run that caught a 2 s stall went from 3719 ms to 22 ms.
The bundle scan's own work is 11 to 25 ms against its 1200 ms budget. It misses only when the loop
has stalled for 0.6 to 2.6 s underneath it, and when it does the module serves the last good bundle,
which is exactly what the deadline is for. The chart column write now retries with backoff for a
minute, holds the pending value in the switch, and reconciles to the server's answer: a real browser
wrote a column through two attempts that were held past its 8 s deadline, and `config.json` ended
holding it.

## 1. Discovery: 5.8 s of waiting, 30 ms of work

`ProjectRegistry.discover()` already reused known records and started no git, so the only disk work
is a `readdir` per root, a `stat` of `<folder>/.git` per folder, a read of the store's rows per
project, and the cache write. Before this change, the pass measured:

| pass | total | readdir | stat | rows | ensure | save |
| --- | --- | --- | --- | --- | --- | --- |
| idle-1 | 51.5 ms | 3.1 | 19.8 | 8.9 | 0.2 | 0.9 |
| idle-2 | 29.2 ms | 0.6 | 11.1 | 6.5 | 0.3 | 0.7 |
| idle-3 | 32.5 ms | 0.6 | 12.9 | 8.5 | 0.3 | 0.7 |
| loaded-1 | 3719.2 ms | 0.6 | 3699.4 | 8.1 | 0.3 | 0.6 |
| loaded-2 | 176.9 ms | 0.6 | 142.5 | 9.3 | 0.3 | 0.6 |

"Loaded" is the panel's own steady state reproduced beside it: two workers running `git status
--porcelain=v2 --branch` back to back over the board's 177 repos. The loaded-1 row is the 5.8 s
pass in miniature. The event-loop sampler beside the pass saw a p50 lag of 1636 ms and a max of
2029 ms, and every one of the 369 stats waited its turn behind that: the stat phase took 3699 ms of
a 3719 ms pass. The work never changed; the number of times the pass asked the loop for a turn did.

The pass now filters the folders, issues all the stats with one `Promise.allSettled`, and reads the
answers by position:

| pass | total | readdir | stat | rows | ensure | save |
| --- | --- | --- | --- | --- | --- | --- |
| idle-1 | 34.1 ms | 1.5 | 4.0 | 9.2 | 0.2 | 0.8 |
| idle-2 | 18.7 ms | 0.8 | 1.8 | 6.8 | 0.3 | 0.8 |
| idle-3 | 17.6 ms | 0.7 | 1.5 | 6.7 | 0.3 | 0.8 |
| loaded-1 | 22.1 ms | 0.6 | 2.5 | 7.2 | 0.4 | 1.0 |
| loaded-2 | 38.7 ms | 0.7 | 1.8 | 9.3 | 0.5 | 1.8 |

The stat phase fell from 11 to 20 ms idle to 1.5 to 4 ms, and from 142 to 3699 ms under load to 1.8
to 2.5 ms. The batch is the same 369 stats; it waits for the loop once instead of 369 times.

The pass also carries its own breakdown now (`registry.lastPass`), and the panel's log line prints
it beside the total. The loaded-1 pass above, in the new line's shape:

```
projects: 177 (probed 0 new, reused 177) | skipped 58 non-repo dir(s) | recent 16 / old 161 |
discovery 3719ms (readdir 0.6, stat 3699.4, rows 8.1, ensure 0.3, save 0.6)
```

That line is the measurement that stays in production. A pass that reads seconds while every phase
reads milliseconds is a loop that was busy, not a pass that did work, and the log now says so
without a profiler.

The production log on this box holds 34 completed passes: min 27 ms, median 3731 ms, 9 at or under
250 ms, and a max of 2193107 ms. The multi-minute rows are the machine suspending, not the walk; the
seconds-long ones are the loop under the scan pool, which is what the batch removes from the pass's
side of the bill.

## 2. The bundle scan: 11 to 25 ms of work against a 1200 ms deadline

`readBundle()` plus the per-file stamps that `scanBundle()` does are 35 files (the shell, `app.js`,
`style.css`, and `core/`). Measured on its own:

| read | result |
| --- | --- |
| one scan, idle, 5 runs | 25.0, 15.3, 16.4, 13.2, 11.0 ms |
| one `refresh()`, idle, 5 runs | 14.6, 12.3, 16.1, 14.1, 12.5 ms |
| one scan under two git readers | 1598.6, 88.2, 120.9, 55.4 ms |
| `refresh()` under the same load, 15 attempts over 38 s | 1 missed the 1200 ms deadline, 83 git spawns |
| event loop beside the loaded scans | p50 5.4 ms, p95 600.3 ms, max 2560.4 ms |

The scan is 50 to 100 times under its budget at idle. When an attempt misses, the scan is not what
took the time: the loop stalled for up to 2.6 s while the pool spawned git, and the scan's own
chain of awaits (a read per file, then a stat per file) rode the stall out. The module's answer is
already the right one - it logs the miss and serves the last good bundle - so the miss is a true
report about the loop, not a defect in the scan. A second run of the same harness missed 3 of 15
attempts; the gap between misses in the panel's own log is median 16 s, p95 42 s, which is the
cadence the row saw.

## 3. The settings write: a real browser, two held attempts, one landed write

`tools/verify-settings-retry.mjs` boots this checkout against a throwaway config, puts a proxy in
front of it that holds the first two `POST /api/settings/columns` past the page's 8 s attempt
deadline and answers them 504 after the page has stopped listening, then forwards the third. A real
browser opened the proxy's URL, turned the Life column off, and was read every second:

| page clock | switch | counter | row says |
| --- | --- | --- | --- |
| 2.2 s | off | 11/12 | `saving… - the switch keeps the value you set; config.json is written when the panel answers` |
| 10.3 s | off | 11/12 | `still trying (attempt 2)… - the switch keeps the value you set; …` |
| 20.4 s | off | 11/12 | `11 of 12 columns on the chart · hidden: life · … set in config.json …` |

The proxy's timeline, in milliseconds from the tool's start:

| attempt | sent | held | answered | status |
| --- | --- | --- | --- | --- |
| 1 | 21823 | yes | 31327 | 504, client already gone |
| 2 | 30839 | yes | 40344 | 504, client already gone |
| 3 | 40851 | no, forwarded | 40851 | 200 |

The gaps are 9016 ms and 10012 ms: the 8 s attempt deadline plus the 1 s and 2 s waits of the
schedule. The write landed 19181 ms after the first attempt, and the file it left is the server's
answer, not the list the page asked for:

```json
{
  "hiddenColumns": [
    "life"
  ]
}
```

Read out of the panel's own `config.json` before the sandbox was removed. The switch never moved
back while the attempts were in flight, and the page reported the write as saved only after the
server answered 200.

## What changed

| file | change |
| --- | --- |
| `lib/projects.js` | every pass records `lastPass` (total, readdir, stat, rows, ensure, save, projects, skipped, probed); the log line prints the phases; the per-folder stats are one batch |
| `test/discovery-tiers.test.js` | the pass's breakdown is pinned; a 24-folder root pins that each batched stat keeps its own answer (8 repos, 15 non-repos, 1 linked worktree) |
| `public/charts.js` | the column PATCH retries with backoff for at least a minute, keeps the pending list in the switches and counter, reconciles to the server's answer, does not retry a 4xx, and a newer press owns the row (commit `b4b3dcb3`) |
| `test/chart-columns.test.js` | the schedule, two timeouts then a landing, the pending value, the server's answer winning, a refusal, a final failure, and the newer-press case, on a fake clock (commit `b4b3dcb3`) |
| `tools/measure-slow-panel.mjs` | discovery with its phase breakdown, idle and under two git readers; the bundle scan and `refresh()` with the module's own deadline; the panel log's discovery totals and miss cadence |
| `tools/verify-settings-retry.mjs` | the end-to-end settings write, with the proxy timeline and the resulting `config.json` |

## Reproduce

```
node tools/measure-slow-panel.mjs --only discovery --repeats 3 --loaded-passes 2 --json
node tools/measure-slow-panel.mjs --only bundle --json
node tools/measure-slow-panel.mjs --only log --json
node tools/verify-settings-retry.mjs --column life --hold-attempts 2 --hold-ms 9500 --ready ready.json --out out.json
```

The verify tool prints `VERIFY {"base":…}` and waits for a browser to open that URL, turn Settings
→ Cards → Chart columns, and switch one column off. It exits 0 when `config.json` holds the column,
and writes the verdict to `--out`.
