# Two tiers for discovery and the scan

A repository that has not taken a commit in seven days no longer pays the board's polling cost. It moves to an
OLD tier: one `stat(2)` of four `.git` paths an hour, staggered across the hour by a bucket hashed from its path,
so a minute's slice is a couple of repos and never a burst. Any mtime change on those four paths - or the reader
opening the project - promotes it for ONE full discovery probe and one read of its rows. A repo whose commit is
then inside the window stays on today's treatment; one that is still old returns to the gate with a fresh
baseline. The RECENT tier (a commit inside 7 days) is unchanged, byte for byte.

On this machine 160 of the 177 projects under its two configured scan roots are old, so the steady-state scan
queue for the fleet drops from every row to the rows of the 17 recent repos.

## The rule, in one place

`lib/tiers.js` owns all of it:

| Decision | Rule |
|---|---|
| recent / old | the project's `activityAt` (its last commit; a repo with no commits uses its `.git` mtime) is inside `tierDays`, default 7 |
| an old repo's cadence | four stats of `.git/HEAD`, `.git/index`, `.git/refs/heads`, `.git/logs/HEAD`, once per rotation of `tierBuckets` (60) slices of `tierCheckSeconds` (60 s) |
| which slice | `sha256(normalised path) % tierBuckets`, so a repo's minute does not move when its neighbours come and go |
| movement | ANY mtime change on one of the four, compared with the signature the last check recorded |
| promotion | one `probe()` (the full discovery probe) plus one `fullPassProject`; the probe re-derives the tier |
| demotion | the probe finds a commit still outside the window, so the repo returns to the gate; the baseline is re-seeded from the post-probe state |
| the reader opening it | `POST /api/project/open` from `toggleProject()` (and for sections restored open at boot) runs the same promotion |

The stat gate itself is `statSignal()`: four filesystem stats, no git. The tier book (`TierBook`) persists each
repo's tier and last signature to `tiers.json` beside `projects.json`, so a restart resumes the hour instead of
re-probing the old fleet; the first check after a restart only re-seeds a baseline, it does not promote.

Three details that are easy to get wrong, and are pinned by tests:

- a record with NO activity date is RECENT, not old: "not probed yet" is not "nothing happened in seven days";
- a moved baseline is NOT recorded until the promotion re-seeds it, so a promotion that fails is retried on the
  repo's next slice instead of being remembered as handled;
- the bucket is a hash of the PATH, not the project's position in the list - discovery re-sorts by activity, and a
  positional slot would move a repo's hour every time another repo changed.

## What did not change

- **Discovery still reuses every known record and probes only an unknown directory.** Classification reads
  `activityAt` off the record that was already there: no git, no stats. `test/tiers.test.js` counts the `git`
  seam and gets 0 calls for a steady-state pass over four repos, then >0 for the one new directory, then 0 again
  on the pass after it.
- **The boot pass still maps every project.** The gate governs the background loop, not the map: the board opens
  whole, with rows, as it did before. Its rows for old repos are then "parked": `pollSeconds` is the hour, the
  next-read ring points at the repo's next slice, and the live chips are cleared, because no scan will refresh
  them until movement promotes the repo.
- **Explicit actions still act.** "Refresh now", the per-row refresh, "Fetch remotes" and a forced fetch cover
  every project, old tier included - the gate is about the automatic cadence.
- **The page holds no tier decision.** `shownInRoot()` filters on `project.tier`, the server's answer. The old
  client-side "touched" rule (commit, file edit, or any liveness evidence, with its own cutoff) is gone, and
  `test/root-7d-view.test.js` pins both halves: an old project stays hidden however recent its own timestamps
  look, and the client carries no cutoff arithmetic. The button's label quotes `settings.tierDays`, so a config
  that moves the window moves the text with it.

## Measurement

The harness is `tools/measure-discovery-tiers.mjs`. It builds the brief's shape (177 projects over two roots,
58 non-repo directories, one in ten recent) or walks the machine's real roots with a copy of the panel's projects
cache, times N full discovery passes, and counts what a steady-state tick would queue for the fleet's rows. It
imports a checkout by `--root`, so the same fixture measures a `git archive` export of the base and the working
tree in one run.

```
mkdir -p <scratch>/base && git archive <base-sha> | tar -x -C <scratch>/base
node tools/measure-discovery-tiers.mjs --base <scratch>/base --roots "<root-a>;<root-b>" \
  --cache "<data-dir>/state/projects.json" --passes 8
node tools/measure-discovery-tiers.mjs --base <scratch>/base --repos 177 --dirs 58 --passes 8
```

The roots and cache are the machine's own `scanRoots` and discovery cache; naming them in a document would pin
the document to one box, so the placeholders above are the two fields to fill in.

| Build | Fixture | Settled discovery | First pass | Rows queued for a scan | Tier split |
|---|---|---|---|---|---|
| before | live roots, 177 cached records, 57 skipped dirs | 13 ms (11-15) | 15 ms | 177 | no tier field |
| after | same | 14 ms (14-15) | 65 ms | 17 | 17 recent / 160 old |
| before | synthetic 177 repos + 58 dirs | 12 ms (10-17) | 17 ms | 177 | no tier field |
| after | same | 12 ms (12-15) | 27 ms | 18 | 18 recent / 159 old |

- The walk itself is untouched: both builds stat the same 235 directories and reuse the same 177 records, so a
  settled pass is the same 12-14 ms. The first pass after the change is the one-time cost of writing the tier
  book (160 signatures, ~23 KB), and the harness reports it separately rather than folding it into the median.
- The number that moves is the scan queue: 177 -> 17 rows in steady state, 90% fewer, which is the git the board
  stops spawning.
- The brief's "steady state 47 to 163 ms" did NOT reproduce as a steady state here. The live panel's own log
  line for a warm pass reads 20 ms; cold passes read 823-881 ms, and two passes during this landing's own test
  load read 42 s and 132 s. Those are filesystem contention on 235 stats, not code, and they hit both builds
  equally. The harness numbers above are the same fixture measured back to back.
- **Promotion proof, on a real repository** (the last section of the harness and `test/discovery-tiers.test.js`):
  a repo whose only commit is 20 days old classifies as `old`; the first gate pass records a baseline and
  promotes 0; staging a file rewrites `.git/index`; the NEXT pass promotes 1, runs one full probe and one row
  scan; the pass after it promotes 0; the tier after is still `old`, with the baseline re-seeded to the
  post-promotion state. `PASS - a touched old repo promotes within ONE pass`.

## Verification

```
node --test test/tiers.test.js test/discovery-tiers.test.js test/root-7d-view.test.js test/project-open-route.test.js
node --test test/paths.test.js test/pr-cell.test.js test/worktree-board.test.js test/scan-released-row.test.js
```
All 15 new checks pass: 13 rule and client-view tests plus the 2 route checks.
`test/project-open-route.test.js` boots a real sandbox panel, discovers one old and one recent repo, opens the
old one over HTTP, and waits for the scheduler's own `tierPromotions` counter - the route, the scheduler and the
tier book are the shipped ones. The existing scheduler, path and scan suites (55 checks) are unaffected.

The full suite is run at the final tip and its counts are quoted in the pull request; the two known worktree
failures (`gateway-permissions.test.js`, `pipelines.test.js`'s config default) are environmental, as every
worktree landing on this repo records.

## Files

| File | What |
|---|---|
| `lib/tiers.js` | the rule, the bucket, the four-path signal, the persisted tier book |
| `lib/projects.js` | classification in `discover()`, `refreshProject()`, `parkOldRows()`, the `git` seam |
| `lib/scheduler.js` | `projectTier`, `tierPass`, `promoteProject`, `openProject`; recent-only row scans, full passes and fetches |
| `server.js` | `POST /api/project/open`, the three config keys, the snapshot fields |
| `public/app.js` | `shownInRoot` filters on `project.tier`; `recentDays()` labels it; `noteProjectOpen()` reports an opened section |
| `lib/paths.js`, `config.example.json`, `docs/` | `tiers.json`, the keys, the map and the user guide |
| `test/tiers.test.js`, `test/discovery-tiers.test.js`, `test/root-7d-view.test.js`, `test/project-open-route.test.js` | the rules, the no-git pass, the promotion, the client view, the route |
| `tools/measure-discovery-tiers.mjs` | the before/after harness and the promotion proof |

## Known limits

- An old repo's rows are a snapshot until something moves. A file edit that stages nothing changes no watched
  path, so it is read when the repo's next `.git` change promotes it, or when the reader opens the section.
- Worktree additions in an old repo are noticed by the next promotion (a `git worktree add -b` writes
  `refs/heads`, so its own branch create promotes it), not by the minute.
- `scanMode: "visible"` keeps its contract: an old project the page cannot see is not stat-checked either.
