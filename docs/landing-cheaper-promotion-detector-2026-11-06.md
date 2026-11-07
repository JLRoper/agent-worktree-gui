# The cheaper promotion detector

The tier gate answers one question an hour per old repository: *did this move since the last read?* It used to
answer it with four `.git` stats, which is as cheap as a read gets and blind to the thing the board actually
sees: an agent editing files. On this fleet that gate missed **35 of the 101 dirty repos** — the row was being
worked on, and nothing promoted it.

This landing compared the two candidates `docs/perf/tier-detection-2026-11-07.md` had measured — a bounded
mtime pass and `.git/index` + `.git/HEAD` — plus the worktree walk that document recommended, against the fleet's
own dirty state and against the three events the gate exists for: a commit, a new branch, a dirty tree. Only the
walk plus the narrow git watch set hits all three, and it costs **~10.7 ms a repo** against **3.5–10.9 s** for the
scan shapes it stands in for. `statSignal()` is that detector now; `signalMoved`, `tierOf` and the tier book are
unchanged in shape.

## Provenance

| item | value |
| --- | --- |
| code | this worktree, `lib/tiers.js` at the tip of `wtgui/swap-in-the-cheaper-prom-eca5b3`, rebased onto `main` `549187e` (1.45.4) |
| board | the live panel's own projects cache: **177 projects** over the board's two scan roots (109 and 68), 176 answered `git`, **101 dirty**, 876 uncommitted paths |
| host | Intel Core Ultra 7 265H, 16 logical CPUs, Windows 11, git 2.53.0.windows.3 |
| measured | 2026-11-06 23:00–23:40 local (2026-11-07 04:00–04:40Z), panel and other agents live on the same repos |
| harness | `node tools/measure-tier-signal.mjs --passes 2 --sample 6 --json <file>` (new in this landing) |
| scratch | `%TEMP%/wag/<run>`: the harness record, a per-repo profile of `statSignal`, and the fixtures it builds |

## Cost, one pass over the fleet

Each detector is timed over all 177 project roots, best of two passes; the git shapes are timed per repo over a
6-repo sample (one spawn per shape, the way the panel groups them).

| detector | work per repo | per repo | 177 repos |
| --- | --- | --- | --- |
| four `.git` stats (what the gate ran) | 4 `lstat` | 0.06 ms | 11 ms |
| `.git/index` + `.git/HEAD` | 2 `lstat` | 0.03 ms | 5 ms |
| mtime pass, depth 1 | `readdir` + `lstat` of top-level entries | 0.32 ms | 57 ms |
| mtime pass, depth 3 | + two levels down | 2.36 ms | 418 ms |
| worktree walk, heavy dirs pruned | every entry, any depth, `.worktrees` entries only | 10.8 ms | 1,907 ms |
| **`statSignal()` (shipped)** | that walk + `index`, `HEAD`, `logs/HEAD`, `packed-refs`, `refs/heads` | **8.8 ms** | **1,557 ms** |
| scan, fast shape | `status`, `log -1`, `rev-list` (3 spawns) | 2,117 ms median | ~6 min across four workers |
| scan, full shape | + `merge-base`, `cherry`, `reflog`, `diff` (7 spawns) | 6,837 ms median | ~20 min across four workers |

The shipped detector and the bare walk land in the same place (8.8 vs 10.8 ms in one pass, 11 vs 12 in another):
the walk is the cost, and the five `.git` stats on top of it are noise. That is **~240× cheaper than the fast
shape and ~760× cheaper than the full one**, on a host where a single `git` spawn is 0.6–4.7 s.

The mean hides the distribution, so it is worth saying: median **5 ms**, p90 **20–26 ms**, worst repo **0.33 s**
(a 8,526-entry worktree after pruning, `kafka`). One repo an hour at a third of a second is not a stall; the
scheduler awaits these one at a time inside a slice that holds ~3 repos.

## Hit rate on this fleet

The gate's job on a dirty repo is to notice the newest uncommitted path. For every dirty repo the harness takes
the newest changed path, then asks each detector whether it watches anything at least that new. A bounded pass
can only see a change inside its bound — an edit moves the file and **not** its parent directory's mtime.

| detector | dirty repos it sees | what it misses |
| --- | --- | --- |
| four `.git` stats | 66 / 101 — **65%** | every unstaged edit: the file, not `.git`, moved |
| `.git/index` + `.git/HEAD` | 64 / 101 — **63%** | the same, and a branch switch that lands on the same tree |
| mtime pass, depth 1 | 53 / 101 — **52%** | anything below the root: 57 of the 101 repos have a changed path below depth 1 |
| mtime pass, depth 3 | 88 / 101 — **87%** | the Java layouts (`src/main/java/...` starts at depth 4): 24 of the 101 |
| worktree walk, `.worktrees` skipped | 94 / 101 — **93%** | a nested worktree git reports as one dirty path — 7 repos here |
| **`statSignal()` (shipped)** | **101 / 101 — 100%** | nothing in this set; see *Known limits* for what no stat can see |

The 35 repos the old gate missed are the reason for the change: they are the ones with work in the tree and no
git command run, which is exactly the row an agent leaves behind between turns.

## The event matrix

Eleven fixture repos, each given one event and read before and after, with the row's own git state
(`status`, `HEAD`, branch) as the ground truth. "moved" is the detector's own answer.

| event | row state moved | 4 `.git` stats | `index`+`HEAD` | depth 1 | depth 3 | walk | walk + `.worktrees` | `statSignal()` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nothing | no | no | no | no | no | no | no | no |
| append to a root file | yes | no | no | yes | yes | yes | yes | **yes** |
| edit a file at depth 5 | yes | no | no | no | no | yes | yes | **yes** |
| create a file at depth 5 | yes | no | no | no | no | yes | yes | **yes** |
| `git add` a root file | yes | yes | yes | yes | yes | yes | yes | **yes** |
| commit on the branch | yes | yes | yes | no | no | no | no | **yes** |
| switch to a new branch | yes | yes | yes | no | no | no | no | **yes** |
| fetch a new upstream commit | no (this row) | no | no | no | no | no | no | **no** |
| commit in a sibling worktree | no (this row) | yes | no | no | no | no | no | **yes** |
| bare `git status` | no | no | no | no | no | no | no | **no** |
| edit under `node_modules` | no | no | no | no | no | no | no | **no** |
| edit preserving the mtime | yes | no | no | no | no | no | no | **no** |

Read down the three events the gate exists for: **dirty tree** (rows 2–4) is the walk's job and only the walk
sees it; **commit** (row 6) and **new branch** (row 7) are the git watch set's job, and the walk alone cannot see
either — a commit writes `.git`, not the tree. Neither candidate from the measurement is sufficient on its own,
which is why the swap is the union of them behind the same function rather than one of them replacing the other.

The false-positive rows are the other half of the contract: the panel's own fetch (row 8) rewrites `FETCH_HEAD`
and `refs/remotes`, and those are deliberately not watched; a bare `git status` over stale stat data (row 10)
does not rewrite the index, so the gate does not churn on its own reads; `node_modules` (row 11) is pruned on
purpose. Row 12 is the honest hole: an edit that restores the timestamp is invisible to any stat-based gate.

## What shipped

`lib/tiers.js`, behind the same `statSignal(repoPath)`:

- **the worktree walk** — `newestInTree()`, every entry at any depth, pruning `.git`, `node_modules`, `target`,
  `build`, `dist`, `out`, `.next`, `.venv`, `__pycache__`, `.gradle`, `bin`, `obj` (`TIER_PRUNE`). Symlinks and
  junctions are read, never followed.
- **`.worktrees` gets its own rule** — the walk does not descend into a sibling worktree (it is a row of its own
  and its tree is not this repository's work) but it does read the mtime of each entry directly inside it. A
  worktree created, removed or touched is movement for the parent, and git reports a nested worktree as a single
  dirty path, so those entries are exactly what `status` would name. That rule is what takes the walk from 93% to
  100% on this fleet, for 0.03 ms.
- **the narrow git watch set** — `index`, `HEAD`, `logs/HEAD` from the real git dir, `packed-refs` and
  `refs/heads` (the directory and its immediate entries) from the common dir. `FETCH_HEAD`, `refs/remotes`,
  `objects` and `wtgui-hooks` are absent on purpose.
- **`gitDirs()`** — a `.git` FILE (a linked worktree) names its git dir, whose `commondir` names the shared one;
  a literal `<repo>/.git/index` reads 0 on such a row, which is how a worktree row would never move.
- **one upgrade rule** — a baseline written by the old four-key signal cannot answer for the new one (its missing
  `worktree` key would read 0 against a real mtime and promote every old repo on its first slice). `TierBook.known()`
  treats a signature with a key missing as no signature: the first check re-seeds it and promotes nothing, exactly
  as a first check does.

The signal is still a flat object of numbers, so `signalMoved` and the tier book read it unchanged; `tierOf`, the
bucket, the slice and the promotion path are untouched.

## What it costs now

160 old repos on this machine, once an hour: **~1.4 s of stats per hour**, spread over 60 slices, so a minute's
slice is ~3 repos and ~25 ms. The row scan the gate stands in for is 2.1–6.8 s per repo, i.e. the gate buys back
minutes of git per hour for about a second of filesystem reads.

## Verification

```
node --test test/tiers.test.js test/discovery-tiers.test.js test/project-open-route.test.js test/root-7d-view.test.js
node tools/measure-tier-signal.mjs --passes 2 --sample 6
```

`test/tiers.test.js` pins the three events and the four silences on a real repository: a commit moves the signal,
a new branch moves it, a checkout moves it, an unstaged edit **at depth 5** moves it, an untracked file moves it,
and an edit under `node_modules`, a fetch's own writes (`FETCH_HEAD`, `refs/remotes`) and a missing repo do not.
A second test builds a linked worktree and pins that its commit moves its own signal while a deep edit inside a
sibling worktree is the sibling's business. A third pins the upgrade rule: a four-key baseline re-seeds instead
of promoting.

The full suite is run at the final tip and its counts are quoted in the pull request.

## Files

| File | What |
| --- | --- |
| `lib/tiers.js` | the detector: `gitDirs`, `newestInTree`, `headsSignal`, `statSignal`; `TIER_PRUNE`, `TIER_GIT_PATHS`, `SIGNAL_KEYS`; `TierBook.known` |
| `test/tiers.test.js` | the three events, the four silences, the linked worktree, the upgrade rule |
| `tools/measure-tier-signal.mjs` | the harness: cost per detector on the fleet, hit rate on its dirty repos, the event matrix |
| `package.json` | `npm run measure:tier-signal` |
| `lib/scheduler.js`, `server.js`, `lib/paths.js`, `lib/projects.js`, `docs/architecture.md`, `docs/using-the-board.md`, `test/discovery-tiers.test.js` | comments and prose that said "four `.git` stats" |

## Known limits

- **`node_modules` and build output are pruned.** A dependency edit does not promote the row; that is the trade
  the measurement recommended and the test pins it.
- **An mtime-preserving edit is invisible.** No stat-based gate can close it; the reader opening the section and
  the row's own scan cadence are what bound it.
- **A deep edit inside a sibling worktree is that row's business.** The parent watches the worktree's entry, not
  its tree; the sibling row is promoted by its own gate when it is old, and by its own scan when it is recent.
- **The walk is unbounded in depth on purpose.** A depth bound is a coverage loss, not a cost knob: the bounded
  passes were slower *and* blind (2.36 ms for depth 3 at 87% against 10.8 ms for the walk at 93%).
- **A very large checkout costs more than the mean.** The worst repo here is 0.33 s; it is one repo, once an hour.

## Version

Patch: `1.45.6`. No contract, no config key and no state file shape changes; the one durable shape that does
change — a baseline in `tiers.json` — is handled by `TierBook.known()`, which re-seeds an old-shape baseline
instead of promoting it. `1.45.5` is held by another branch in flight, so this landing takes the next free patch
number.
