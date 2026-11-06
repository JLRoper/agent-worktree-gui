# Landing: the gateway's `unknown_execution` replaces the session (1.43.1)

Six turns on three assistant sessions failed with `unknown_execution` between 19:18 and 19:40 on 2026-11-06, every
one of them `queued` with `execution_generation: null`. Nothing had run. The panel wrote each card off, and the
turn after it re-posted to the same session id - so the fence was inherited, not stepped out of.

Both halves of that are fixed: the sweep now REPLACES the session on that answer and re-posts the same request,
and a thread's session is picked from its newest card on the clock instead of from the highest `turn` (a number
the store re-uses).

## The six turns, from this box's own store

`~/.wag/state/jobs.json`, the cards' own fields. The line on each is the one the panel wrote: *the gateway admitted
run … but never claimed it (queued with no execution generation) — this session is fenced*.

| session | turn | started | run | context |
|---|---|---|---|---|
| `panel-assistant-3` | 12 | 19:18:04 | `run_0d761663` | 45.5% |
| `panel-assistant-3` | 13 | 19:23:14 | `run_8e34c1e2` | 46.8% |
| `panel-assistant` | 28 | 19:30:53 | `run_cad05c38` | 28.7% |
| `panel-assistant-3` | 14 | 19:33:18 | `run_4e32c61c` | 46.8% |
| `panel-assistant-4` | 12 | 19:34:45 | `run_370a1aec` | 6.8% |
| `panel-assistant-4` | 13 | 19:36:52 | `run_a0bc39fe` | 8.3% |

Four more cards on the same two sessions failed the same way after 19:40 (`panel-assistant` turns 29, 30 and 31,
`panel-assistant-3` turn 16): ten in all, and not one of them carried a `sessionReplaced`.

## Mechanism 1: the write-off ended a turn that never started

`noteUnclaimedRun()` -> `writeOffUnclaimedRun()` marked the card `failed` and kept the gateway's word for the next
repair turn to key on. That is correct for a run the gateway STARTED and then lost (`status: unknown` - it may
have executed, so re-running it would duplicate work). It is wrong for `queued` with no generation: nothing was
ever claimed, so re-posting the same request duplicates nothing.

`lib/jobs.js:3877` `replaceLostSession()` now does that, and the sweep calls it before any write-off
(`lib/jobs.js:4227`). The card keeps its thread, prompt and tree; it gains `sessionReplaced` (the chip the page
already draws), the new session id and the run id the re-post was given. `lib/jobs.js:2922` keeps the request body
on the card so there is something to re-post (`create()` already builds it); it is memory only, never persisted,
so a card the store restored after a restart still falls back to the write-off, as does a card that has already
replaced its session once.

`lib/jobs.js:3072` `armAcceptedRun()` is `create()`'s accepted-run path lifted out, so the replaced turn gets the
same cap, poller, stream and stats strip as a fresh one. `create()` now ends with a call to it.

## Mechanism 2: a turn number repeats, and the repair read the wrong card

The turn after a failure asks `lostSessionOf()` whether the thread's session is lost. That predicate picked the
"newest" settled card by `turn` - but a turn is `siblings.length + 1` (`create()`) and the store prunes to
`KEEP_JOBS`, so the numbers restart and then repeat. On the live cards:

- `panel-assistant-3` held a turn **16** from 19:01 (cancelled) beside the turn 13 that failed at 19:23;
- `panel-assistant-4` held a turn **23** from 18:10 beside the turn 12 that failed at 19:34.

So the predicate read a card that had ended fine, found nothing lost, and the next turn continued the fenced
session. `newestCard()` (`lib/jobs.js:4757`) orders by `startedAt` (then `endedAt`), and both `sessionFor()` and
`lostSessionOf()` use it (`lib/jobs.js:4777`, `:4800`). This half also decides which session a turn after a
replacement continues, so a reused number could have walked a repaired thread straight back into the fence.

## Proof

`prove-unknown.mjs` (in this run's scratch, quoted below) drives the shipped `Jobs` class over the three
sessions' own cards - thread, turn, run id, status, error and clocks copied from the store - against a stub
gateway that answers the fence and `run_not_found` for every older run. Two halves per session: the turn that came
next, and the failing card under the sweep. Same file against an archive of the base commit and against this
branch:

    base (git archive of 047ad82, the rebased base):   0/18 checks passed
    this branch:                                      18/18 checks passed

Per session, the five checks are: the next turn opens a NEW session; the card says so; the sweep does not write the
turn off; it replaces the session and re-posts once, to the session the card records; and the reader is told on
the card.

Committed tests: `test/session-replace-on-unknown.test.js`, 8 cases named for the three sessions' shapes, plus the
ordering contract, the restored-card fallback, the one-replacement-per-card guard, a refused re-post, and the
`status: unknown` run that must NOT be re-run.

    node --test test/session-replace-on-unknown.test.js test/repair-turn-session.test.js test/session-replaced-ui.test.js
    tests 19   pass 19   fail 0

`npm test` on this branch, rebased onto `047ad82`: **1776 pass / 4 fail** of 1780. None of the four is in a file
this branch touches. Two are the missing gitignored `config.json` (a worktree has none; the primary checkout does),
and they fail with the same `ENOENT` on an archive of the base commit (`git archive 047ad82`):

1. `test/gateway-permissions.test.js` - throws `ENOENT … config.json` at module load. Red on the base archive at
   the same line.
2. `config.json carries the two defaults beside remoteBranchPolicy…` (`test/pipelines.test.js`) - the same missing
   file, red on the base archive at the same line.

The other two are this box's measured timing races, judged against a window rather than an assertion:
`POST /api/settings/push-project round-trips one kind through config.json and /api/config` at 75.8 s against its
60 s `waitForRepo` window, and `under a policy of allow the hook reports the write and asks nobody` at 34.4 s
against the harness's 30 s kill. Neither failed in this branch's earlier full-suite run on the `7e0c5b7` base
(which read 1775 pass / 3 fail of 1778, the same two `config.json` failures plus one stub-answer assertion), and
`docs/landing-stage-hold-1.41.0-2026-11-06.md` records the same timing pair for this box.

## Version

**1.43.1**, a patch over `main`'s 1.43.0 (`047ad82`). `main` was 1.41.0 when this branch was cut and 1.43.0 by the
rebase: four landings took 1.41.1 (`db8a9bf`, whose tag already exists), 1.41.2 (`a2217fd`), 1.42.1 (`181456c`) and
1.43.0 (`d80c1e4`, whose tag exists) while this was being written, so the number is the next patch above the base's
own tip, not above the tree's.

It is a patch because this is the repair of a landed facility (`d570692` opened a new session on the NEXT turn;
this one does it on the answer itself), and it earns no new level - the level `d570692` itself took for the same
repair (1.36.2).

The branch was rebased twice while it was being written (onto `7e0c5b7`, then onto `047ad82` when 1.43.0 landed),
and the suite, the touched tests and the probe were all re-run on the final tip: 1776/1780, 19/19 and 18/18.

    node tools/version.mjs check

## After the merge

`CHANGELOG.md` is rendered once at the merged tip, which is `docs/versioning.md`'s order and is not done on the
branch: a rebase merge re-creates these commits with new shas, and a section written here would name commits the
reader cannot follow.
