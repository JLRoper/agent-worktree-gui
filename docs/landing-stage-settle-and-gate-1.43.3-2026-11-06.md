# Landing: a stage run settles on its own thread, and a gate is asked again (1.43.3)

PR #489 lands the two driver defects the 24-stage run recorded and #197 did not fix. #197's artifact fix
(`1f4be17`, "a round's artifact is the file that round wrote") is on `main` and was not redone: the round is
filled by the same `artifactValues` helper, and nothing in the artifact matcher moved.

## The two defects, with the number that proves each

Both come from the recorded 24-stage run (`poc-breaking-rounds.yaml`: 3,074 lines, 24 stages, 42 handoffs, 4 gates,
one capped loop), driven by `Assistant.sweepQueues` with a real worker per stage. The run's own report is
`docs/reviews/poc-rounds-execution-2026-11-05.html`; these are its third and fourth defects.

1. **The settle read the 20th thread.** `TASK_THREADS_MAX = 20` refused every thread after the twentieth, so
   `currentThread(task)` — the LAST entry, documented as "the run carrying the task NOW" — froze on `loop-20` for the
   rest of the row's life. The loop route started **38 workers**, the record named **20**, and **19 of the 30
   surviving stage runs** named `loop-20`: the last 18 of those are stages that ran AFTER it, each settled on that
   finished job while its own worker was still running.

2. **The gate was asked once.** G51 declares `ledger/gates/G51-{{run_id}}-r{{round}}.json`. Once
   `G51-run-1-r1.json` existed, the matcher filled no round, took the first name that sorts, and found r1's file in
   every later round: G51 was **crossed 11 times and parked 1 time, on round 1's decision**.

## The fix

`lib/assistant/queue.js` — the cap keeps the **newest** twenty. The legacy first entry (`thread`) stays first for
older readers; the entry dropped is the oldest of the later ones. A row already at the cap takes the next run and
still names it.

`lib/task-pipeline-drive.js` — the settle reads the stage run's **own** thread, the one `linkSpawnTask` wrote on the
ledger entry when the worker was cut, with `currentThread` as the fallback for an entry that is already settled or
never got one. The ledger already names the attempt, so the settle does not depend on a capped list.

The same file fills the round at all three gate asks — the settle's presence check, `verdictOf`'s outcome read, and
the parked row's re-ask. A round with no record yet parks on the **declaration**, so the next pass fills that round
again; only that round's own file releases it. A hole the driver cannot fill (`{{run_id}}`, `{{finding}}`) keeps the
one-segment match, which is the per-finding record the studio writes.

## Tests that fail on the old shape

Reverting `lib/` and running the three new tests reproduces both defects exactly:

    ✖ the threads cap keeps the newest run: `currentThread` is the last agent, never the twentieth
        actual: 'loop-20'      expected: 'loop-24'
    ✖ a stage run settles on its own thread, never on the twentieth the list kept
        actual: 'queued'       expected: 'running'      (the row advanced while its own worker was live)
    ✖ a gate asks for its round's own record: round 1's file never answers round 2
        actual: 'queued'       expected: 'parked'       (it crossed on r1's file and moved the row to S1)

With the fix, `test/assistant-queue.test.js` and `test/task-pipeline-drive.test.js` are **70 / 70**, and the whole
pipeline-and-queue set on the rebased tree — `task-pipeline*`, `pipeline-*`, `queue-sweep`, `assistant-queue*` — is
**349 / 349**.

## The version

`main` moved twice while this ran. The branch was cut at 1.42.1, rebased onto `origin/main` at `047ad82` (1.43.0),
and `main` then landed 1.43.1 and 1.43.2 before the push, so the base is `99bae7e` (**1.43.2**) and the number is
**1.43.3**: two defects fixed in a driver the panel already runs, no contract field added.
`node tools/version.mjs apply patch` wrote it against the base's own tip, and the annotated `v1.43.3` tag anchors
the commit that first declared it.

## The gates

- `node tools/version.mjs check` — ok, 1.43.3 above `origin/main`'s 1.43.2 (`99bae7e`).
- `node --test test/task-pipeline*.test.js test/pipeline-*.test.js test/queue-sweep.test.js test/assistant-queue*.test.js`
  on the rebased tree — **349 / 349**.
- `npm test` — **1773 tests, 1767 pass, 6 fail**, none in a file this diff touches:
  - `gateway-permissions.test.js` and `config.json carries the two defaults beside remoteBranchPolicy`
    (`pipelines.test.js`) read the reader's gitignored `config.json` from the checkout root. A clean
    `git archive origin/main` export fails both with the same `ENOENT`, so this is the worktree, not the diff.
  - `POST /api/settings/push-project` (70.3 s) and `POST /api/settings/push-repo` (80.6 s) are the push-settings
    timeout pair the 1.41.0 landing already names.
  - `the reply route briefs a worker…` and `the first session in a new tree names it once…` pass when run alone
    (2.4 s and 0.8 s against 45 s and 37 ms in the 4-way run): load races on this box, not assertions.
- `npm run land` at the merged tip — the render is this landing's last step, and `npm run land:check` proves it.

## The record

- branch `wtgui/a-stage-run-must-not-be-436070`, cut from `main` at `7e0c5b7`, rebased onto `origin/main` before
  the push, PR #489.
- the changelog is rendered at the **merged** tip, in the landing's own last step, so every section links shas the
  base carries.
