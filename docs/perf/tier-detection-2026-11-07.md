# Which cheap signal should promote a row, and what does it miss?

A read-only measurement of three ways to answer "did this repo move since the last read?" for the
board's tier split: a bounded mtime pass, a stat of `.git/index` and `.git/HEAD`, and the six or
seven git calls the panel makes today. No product file was changed; nothing under the scanned
projects was written.

## Provenance

| item | value |
| --- | --- |
| code | this worktree at `05ddada` (1.43.7), the same commit as `origin/main`; docs only |
| board | live panel on port 7331: 177 projects, 377 rows in tiers 4 live / 311 mid / 61 dormant; cadences 5 / 45 / 90 s (`config.example.json:3-5`), `fetchSeconds` 1800, `scanMode` all |
| host | Intel Core Ultra 7 265H, 16 logical CPUs, Windows 11, git 2.53.0.windows.3 |
| spawn floor | `git --version`, 10 samples: 599 / 884 / 2266 ms (min / median / max) |
| measured | 2026-11-07 02:20 to 03:02Z (local 2026-11-06 21:20 to 22:02) |
| sample | 155 top-level folders under the board's projects root (`ProjectDevelopment`), 111 of them git checkouts, 377 board rows |
| scratch | `%TEMP%/wag/ebdb20fc`: `measure-tier-signals-v2.mjs`, `measure-watch.mjs`, `time-gate.mjs`, `fixtures-tier-signals.mjs`, `tier-signals-v2.json`, `watch.json`, `fixtures-signals.json`, `gate-times.json` |

## The answer in one paragraph

The promotion decision costs a full git read today: 3 spawns on the fast tick and 7 on a full read
(9 for the 157 rows that report UNMERGED, which adds `log -20` and `diff --shortstat`). On this host
a git spawn alone is 0.6 to 2.3 s, median 0.88 s, so seven calls are 3.70 s median per repo and 639 s
for the 155 folders measured; the same median over the board's 377 rows is 23 minutes serial, about
6 minutes across the pool's four workers, against a mid cadence of 45 s. A stat-only gate answers the
same question in 10.6 ms per row, 4.8 s for all 377 rows, 349 times cheaper. But only one of the two
cheap signals is sound for promotion. `.git/index` plus `.git/HEAD` misses unstaged edits: 27 of the
53 dirty repos have worktree files newer than their index, and on 201 of 377 rows `.git` is a file,
so those two paths do not exist where the row would look. A depth-bounded mtime pass misses edits
below its bound: the fixtures show a depth-5 edit invisible at depths 1, 2 and 3, and 93 of 266 dirty
paths on the fleet sit below depth 3. The split should use the unbounded worktree mtime walk with the
heavy directories pruned (`node_modules`, `.worktrees`, build output), plus a narrow git watch set
(`index`, `HEAD`, `logs/HEAD`, `packed-refs`, `refs/heads/**`) compared against the scan's start
watermark. It must never watch `FETCH_HEAD` or the `refs/remotes` directories: the panel's own
30-minute fetch pass rewrites them, and `FETCH_HEAD` alone was the newest entry in 78 of 110 project
roots and on 193 rows.

## Method

| read | how |
| --- | --- |
| mtime pass | one `lstat` per entry, no symlink following, `node_modules` and `.git/objects` pruned as the brief specifies; four bounds measured (depth 1, 2, 3, and unbounded), plus an unbounded walk that also skips `.git`, `.worktrees` and build output |
| index / HEAD | `stat` of `<repo>/.git/index` and `<repo>/.git/HEAD`, plus `refs`, `packed-refs`, `FETCH_HEAD` as context |
| current scan | the panel's own calls in its own shapes: `status --porcelain=v2 --branch`, `log -1 --format=%cI`, `rev-list --left-right --count origin/main...HEAD` in parallel; then `merge-base --is-ancestor`, `cherry`, `reflog` in parallel; then `diff --stat` (mirrors `lib/scan.js:142-146`, `237-241`, `302`), serial per repo |
| signal matrix | 11 fixture repos built under the scratch dir, each given one event and read before and after, with the row's git state (`status`, branch, head, ahead/behind, last commit) as the ground truth |

## Wall time per method

155 folders, one serial pass each:

| method | work per repo | total | per repo | git spawns |
| --- | --- | --- | --- | --- |
| mtime, depth 1 | readdir + lstat of top-level entries | 107 ms | 0.7 ms | 0 |
| mtime, depth 2 | + one level down | 968 ms | 6.2 ms | 0 |
| mtime, depth 3 | + two levels down | 1,746 ms | 11.3 ms | 0 |
| mtime, unbounded, `.git` included | every entry, `objects` pruned | 15,499 ms | 100 ms | 0 |
| mtime, unbounded, worktree only | `.git`, `.worktrees`, build output pruned | 3,453 ms | 22 ms | 0 |
| `.git/index` + `.git/HEAD` | 2 stats | 9 ms | 0.06 ms | 0 |
| current scan, fast shape | status, log, rev-list (parallel) | 255.8 s | 1.24 s median | 3 |
| current scan, full shape | + merge-base, cherry, reflog, diff | 639.0 s | 3.70 s median | 7 |

The full-shape pass is the number the tier split pays for on a scheduled read: median 3.70 s, p90
6.90 s, worst 12.05 s. Per call, the medians are status 821 ms, log 585, rev-list 551, merge-base
856, cherry 578, reflog 614, diff 642, against a spawn floor of 884 ms: the repo's size barely
matters, the process is the cost. The three parallel groups overlap their spawns, which is why the
seven calls cost 3.70 s and not the 6.2 s their medians add up to.

The brief's "~0.8 s" is a per-call figure, not a per-repo one: seven calls at 0.55 to 0.86 s each
cannot fit in 0.8 s. Read as a per-repo number it matches the three-spawn fast shape on a cooler
host; read as per call it matches this run exactly. The comparison below does not depend on which
reading was meant, because the gate and the scan are measured on the same host in the same window.

The board's 377 rows, same shapes, priced from the measured medians: 1,395 s serial (23.3 min), 349 s
across the pool's four workers (5.8 min). The gate over all 377 rows is 4.8 s (median 10.6 ms, p90
23 ms, worst 322 ms; mid tier 4.2 s, dormant tier 0.5 s, live tier 0.05 s).

## The signal matrix

Each fixture is a small repo on `main`; the event is applied after the baseline, and "state moved"
means the row's own git state changed (`status`, branch, head, ahead/behind or last commit).

| event | state moved | mtime d1 | mtime d2 | mtime d3 | worktree d3 | index | HEAD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| c0 nothing | no | no | no | no | no | no | no |
| c1 append to a root file | yes | yes | yes | yes | yes | no | no |
| c2 edit a file at depth 5 | yes | no | no | no | no | no | no |
| c3 create a file at depth 5 | yes | no | no | no | no | no | no |
| c4 `git add` a root file | yes | yes | yes | yes | no | yes | no |
| c5 commit on the branch | yes | yes | yes | yes | no | yes | no |
| c6 switch to a new branch | yes | yes | yes | yes | no | no | yes |
| c7 fetch a new upstream commit | yes | yes | yes | yes | no | no | no |
| c8 commit in a sibling worktree | no (this row) | yes | yes | yes | no | no | no |
| c9 `git status`, optional locks off | no | no | no | no | no | no | no |
| c10 edit under `node_modules` | no | no | no | no | no | no | no |
| c11 bare `git status`, stale stat data | no | no | no | no | no | no | no |

Two results are corrections to the usual assumptions. A bare `git status` over stale stat data did
not rewrite `.git/index` in either form, so the index is not self-churning and a stat of it does not
need to discount the panel's own reads. And `HEAD` does not move on a commit (c5): it is a symbolic
ref whose contents do not change, so a HEAD-only gate can never see a commit, only a checkout.

## Each signal's blind spot

### The bounded mtime pass

- The depth bound is a coverage loss, not a cost knob. An edit changes the file's mtime and nothing
  else: the parent directories' mtimes do not move, so a file below the bound is invisible (c2, c3).
  On the fleet, 93 of the 266 dirty or untracked paths (35%) sit below depth 3, across 23 of the 53
  dirty repos; the Java layouts under `src/main/java/...` start at depth 4. Depth 1 sees only 2,497
  entries across 155 folders and is blind to essentially all source work; depth 3 sees 41,699 and is
  still blind to the deepest 35%.
- `node_modules` is pruned on purpose, so a dependency edit is invisible (c10); that is the right
  trade, but it means the signal answers "did the worktree's own source move", not "did anything".
- mtime is metadata. An edit that preserves the timestamp is invisible: c9 writes new content and
  restores the old mtime, and every mtime column stays quiet. Network shares with coarse clocks have
  the same effect. This is rare locally and worth naming because no stat-based gate can close it.
- The `.git` side of the pass is noisy unless the watched set is defined. Taking the newest entry
  anywhere under `.git` made the panel's own fetch pass the winner on 78 of 110 project roots
  (`FETCH_HEAD`), and the `refs/remotes/origin` directory mtime was the newest entry on 147 rows
  because git writes a lock file and renames it even when the ref's content is unchanged. Include
  `.git` as a defined watch set, never as "newest anything".
- False positives are cheap. A build that writes outside the prune list, or a file touched and
  reverted, costs one scan (3.7 s) and no wrong verdict.

### `.git/index` and `.git/HEAD`

- Unstaged work is invisible. An edit moves neither file (c1, c2, c3), and this is the common case
  on the board: 27 of the 53 dirty repos (51%) have worktree files newer than their index. A gate on
  these two stats would keep a row dormant while an agent edits it.
- On this board the paths often do not exist. `.git` is a file on 201 of the 377 rows (worktrees,
  whose index and HEAD live in the main checkout's `.git/worktrees/<name>/`). A literal
  `<row>/.git/index` stat answers ENOENT for more than half the rows; the gate has to read the
  gitfile first, which is one extra read per row and is not part of the 9 ms measured here.
- `HEAD` is the weaker half: it moves on a checkout (c6) and not on a commit (c5). The index moves
  on a commit and on staging, but not on a branch switch that lands on the same tree (c6). Neither
  alone is a change signal; both together still miss every unstaged edit.
- Remote movement is invisible to both. A fetch that brings a new upstream commit leaves the index,
  HEAD and the worktree untouched (c7); the row's behind count and verdict move anyway.
- A commit in a sibling worktree leaves the project root's index and HEAD alone (c8), while the
  branch ref moves. The root row does not need a re-read; the sibling row's own index does.

### The current six or seven calls

- It is the ground truth: every case in the matrix is visible to it, because `status`, `log`,
  `rev-list` and `cherry` read the repository rather than its metadata.
- Its cost is the spawn, not the repo. `status` medians 821 ms against a 599 ms `git --version`
  floor; the largest checkout (70,314 walk entries) took 2.99 s for status while a small one took
  1.3 s. Nothing about a quiet repo makes the call cheap.
- At 3.70 s per row the board cannot honour its own cadence: 377 rows need 349 s across four
  workers against a 45 s mid cadence, and the 311 mid rows alone need 288 s. The rings drain over
  minutes, not seconds, which is the symptom the tier split exists to prevent.
- It already reads the same mtimes, too late to gate on: `lib/scan.js:333-350` stats up to 40 dirty
  or untracked files after the git calls to compute `lastEdit`. The gate moves that read ahead of
  the spawns instead of adding a new source of truth.

## Which signal the tier split should use

Use the unbounded worktree mtime walk plus the narrow git watch set, compared against the row's
scan-start watermark. Concretely:

1. Walk the row's worktree at any depth, skipping `node_modules`, `.worktrees`, and build output
   (`target`, `build`, `dist`, `out`, `.next`, `.venv`, `__pycache__`, `.gradle`, `bin`, `obj`).
   Take the newest mtime. The unbounded walk with those prunes is 3,453 ms for 155 folders and
   4.8 s for all 377 rows, against 639 s and 1,395 s for the git shapes.
2. Add the git watch set: `<gitdir>/index`, `<gitdir>/HEAD`, `<gitdir>/logs/HEAD`,
   `<gitdir>/packed-refs`, and the files under `<gitdir>/refs/heads`. Read `<gitdir>` from the
   `.git` file when it is a file, which is 201 of the rows. Do not watch `FETCH_HEAD`, the
   `refs/remotes` directories, `objects` or `wtgui-hooks`: they move for reasons that are not the
   row's state, and the fetch pass is already the authority for remote movement.
3. Compare the gate's newest mtime with the time the row's last git read STARTED, not finished. A
   read that starts at T and ends at T+4 s has not seen an edit made at T+1 s; using the finish time
   loses it forever.
4. Quiet gate: keep the row's last full verdict and its cadence, spend no spawn. Moved gate: full
   read. Cap the skip (a full read every few minutes, or every Nth due tick) so a blind spot in the
   gate cannot hide a row indefinitely. mtime-preserving edits and pruned dependency trees are the
   two known holes, and the cap is what bounds them.
5. Do not use `index` + `HEAD` as the promotion signal. Keep it as the 9 ms secondary hint: when the
   worktree is quiet but the index or HEAD moved, the row changed git state without an edit (a
   commit, a stage, a checkout) and is worth a read at the mid cadence.
6. Liveness decay is not a git question and should not wait for a scan. `live` lapses after
   `liveMinutes` with no file change, and `pollSeconds` follows from it (`lib/scheduler.js:404-411`);
   both can be recomputed from `lastEdit` on a tick with no spawn at all.

At these costs the mid tier's 311 rows cost 4.2 s of gate per pass instead of 288 s of git (at the
pool's four workers), and the dormant tier's 61 rows cost 0.5 s instead of 56 s. The tier split then
measures changes instead of measuring the fleet.

## Reproduction

Run from the scratch dir, with the board live or not; the JSON files are the run's own record.

    node measure-tier-signals-v2.mjs tier-signals-v2.json
    node analyze-tier-signals.mjs tier-signals-v2.json
    node measure-watch.mjs tier-signals-v2.json state.json watch.json
    node time-gate.mjs state.json gate-times.json
    node fixtures-tier-signals.mjs fixtures-signals.json

`state.json` is the board's own snapshot (`/api/state`), read at the start of the run. The fixtures
create and remove their repos under `%TEMP%/wag/ebdb20fc/fixtures`; nothing outside the scratch dir
is written.

## Caveats

- Single run, wall clock, on a loaded host: the spawn floor itself moved between 0.6 and 2.3 s during
  the run, and the panel and other agents were working the same repos. The ratios are the finding;
  the absolute seconds are this host at this hour.
- The 155 folders include 44 that are not git checkouts; their scan calls fail fast but still cost a
  spawn, which is why the full-shape pass is quoted over all 155 while the per-repo medians are taken
  over the 110 that answered. One checkout (`email-handler-openvms`) has a `.git` that its status
  call refused.
- The per-row scan cost on the 377-row board is extrapolated from the 155-folder median, not measured
  row by row; the gate's 4.8 s is measured row by row.
- The 7-call full shape measured here is the minimum: a row whose verdict is UNMERGED adds
  `log --oneline -20` and `diff --shortstat` (`lib/scan.js:310-313`), two more spawns, and 157 of
  the 377 rows carry that verdict.
- The signal matrix is synthetic and small: one event per repo, no concurrency, no build output
  beyond the pruned names. It proves which signal sees which kind of change, not how often each kind
  occurs on the board; the fleet numbers above are what covers that.

## Version

No version number is spent by this landing. The change is one document under `docs/perf/` and the
brief forbids both a product edit and a `package.json` bump; a docs-only commit is the case
`docs/versioning.md` says leaves the number alone, so the push carries the reason instead of a bump.
