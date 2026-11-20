# Landing: the tree list is cached (1.131.0)

PR #804 merged into `main` as `08ab8093`. The board's first paint is now the tree list its last successful scan
read, served from `state/tree-cache.json` on the first `/api/state`, then replaced row for row in place as the scan
re-reads each tree. An agent is called unattached only after a scan has completed, and a tree that has vanished from
disk is drawn stale with its reason instead of falling into the unattached bucket.

## What landed

- `lib/tree-cache.js` (new, 336 lines) - one entry per tree (`path`, `branch`, `project`, `parentBranch`, `sha`,
  `readAt`, `name`) keyed by the store's own `${project}::${path}`. `readTreeCache()` drops an entry older than
  `TREE_CACHE_MAX_AGE_MS` (7 days) or past `TREE_CACHE_MAX_TREES` (400) on read and on write; `writeTreeCache()` is
  the atomic rename; `reconcileCached()` is the kept/gone/new split; the `TreeCache` class is the debounced
  `schedule(store)` every row read calls, so a row dropped from the board leaves the file on the next write. A row
  that failed its read, is `RELEASED`, or is already stale is never cached.
- `lib/paths.js` - `treeCacheFile: config.treeCacheFile || file("tree-cache.json")`, beside `jobs.json` in the
  state directory, never inside a worktree.
- `lib/store.js` - `seedCached(entry)` writes a cached row through `putRow` with `cached: true`, verdict `…`, and the
  branch, parent and sha the entry carries, so it is the same key the scan will write. `markStale()` keeps a
  vanished tree's row as `STALE` with `{ reason, lastSeenAt, path, line }`. The next successful read of the path
  clears both.
- `lib/scheduler.js` - `onRowRead` fires after each stored row; `markScanComplete()` stamps `lastScanCompleteAt` and
  pushes it through `onScanComplete`, only for a pass that enumerated every project's tree list; `agentCountFor()`
  reads the panel's agent map so a vanished tree is kept while a card stands on it.
- `server.js` - reads the cache before anything can ask for the list and seeds the store at boot
  (`tree cache: N tree(s) ready from the last successful scan ...`). `treeListInfo()` answers
  `{ cached, cachedTrees, count, at, maxAgeSeconds, completedAt }` on `/api/state` and on the new `treelist` frame;
  `noteCachedRowsRead()` broadcasts the frame that clears the flag the moment the last cached row is read.
- `public/app.js` - `state.treeList` and `applyTreeList()`; the header chip `tree list cached - read <age> ago`; the
  order hold (`TREE_LIST_ORDER_HOLD_MS` 30 s while the list is still cached, `TREE_LIST_ORDER_SETTLE_MS` 5 min after
  the last cached row is read, never extended once settled, so the board ranks by activity again).
- `public/render-jobs.js` - the cards whose tree the list has not named yet are drawn in their own
  "Waiting for the first scan" group with a `N waiting for the scan` chip, counted apart from unattached.
- `public/render-projects.js` - the hold keeps the painted SET as well as the sequence, so the chart's top N does
  not swap rows mid-scan; a cached row replaced by its own read gets no flash and no rank move; `N gone` is the
  STALE count, never folded into unmerged.
- `public/core/sse.js`, `public/board-scaffold.js`, `public/index.html`, `public/chart.css`, `public/settings.js`,
  `public/core/dom-format.js` - the frame, the chip, the group and their styling.
- `test/tree-cache.test.js`, `test/tree-cache-reconcile.test.js`, `test/tree-list-row-rule.test.js` (all new) - the
  cache read and write with its caps and its don't-cache list, the reconciliation by identity, and the row rule.

## What proves it

- `node --test test/tree-cache.test.js test/tree-cache-reconcile.test.js test/tree-list-row-rule.test.js` -
  **26 tests, 26 pass, 0 fail**.
- `node --test` over 16 store / paths / scan / chart / project files - **125 tests, 122 pass, 3 fail**. All three
  reproduce on a pristine `git archive origin/main` export: `paths.test.js:221` (`pipelineBundleSeedFile` is not
  derived by `lib/paths.js`), `paths-http.test.js:150` (the Settings scratch row) and `scan-roots.test.js:51` (the
  new folder is not on the board). They are main's, not this branch's.
- `npm test`, the full suite, once: **3288 tests, 3280 pass, 8 fail**. The same eight fail on `main` at `31dfb2d4`:
  running those eight files in a clone of that tip gives **69 tests, 61 pass, 8 fail** with the identical `test at`
  lines (`assistant-profile.test.js:165`, `assistant-search-scroll.test.js:180`, `child-route.test.js:17`,
  `gateway-permissions.test.js:1`, `header-controls.test.js:73`, `paths.test.js:221`, `paths-http.test.js:150`,
  `reasoning-runs.test.js:70`).
- `npm run test:changed` cannot run its whole selection on this machine: the diff reaches 278 test files and the
  runner's `spawnSync` with 278 absolute paths returns `ENAMETOOLONG`, printed as `0.0s, exit ?`. The focused runs
  above name their files directly.

## The landing

The branch was cut from `31dfb2d4` (the 1.129.0 landing note) and carried nine commits over it plus the bump. The
rebase onto `origin/main` took main's `1.129.0` in the `package.json` conflict; `v1.130.0` was already anchored on
origin at `fbb5d57b`, so `tools/version.mjs apply minor` skipped it and claimed `1.131.0`. `git cherry origin/main
HEAD` showed all nine commits new (none already landed). `gh pr create --fill` opened **PR #804** against `main`
with `mergeable: MERGEABLE`, and `npm run land:pr -- 804` merged it with `--rebase --admin`. The merge re-created
the commits on `main`:

| branch | on `main` | commit |
| --- | --- | --- |
| `ff9a80c8` | `2715ad05` | feat: the last successful tree scan is cached, so a boot paints placed rows |
| `8f107829` | `7dbb36db` | feat: the board waits for the scan instead of calling agents unattached |
| `39c000e7` | `575ffc65` | fix: a fast pass does not claim the tree list was enumerated |
| `37e88247` | `df9f40ec` | fix: the held order holds the SET as well as the sequence |
| `84b8ebea` | `e26150fa` | fix: the painted order holds through a slow first pass |
| `a45229e0` | `488ecfde` | fix: the hold is the cached flag, not a deadline |
| `7512f62a` | `44bceade` | test: a stale row survives the pass after the one that marked it |
| `257614dc` | `8a0e6873` | test: the cache tests name no folder on this machine |
| `a1ca9ad7` | `08ab8093` | chore: 1.131.0 - the version this landing carries |

The same command fast-forwarded the primary checkout `31dfb2d4 -> 08ab8093`, moved `v1.131.0` onto
`08ab8093cd`, rendered the changelog at the merged tip as `45ebbc32` (`docs: render the changelog - 646 releases`)
and pushed `main` to it. `npm run land:check` reads `CHANGELOG.md is current - 646 releases`.

`v1.126.1` still names `a4dc4a6b`, this branch's pre-rebase tip. The rebase dropped that bump commit (main's number
was taken) and the landing declares `1.131.0` instead; the stale tag was left in place, and the version it names is
not in the history `main` carries.

## The anchor

`v1.131.0` is an annotated tag at `08ab8093cd`, the commit that first declared the number.
`npm run verify:version-tags -- --ref origin/main` reports no finding naming `1.131.0`.
