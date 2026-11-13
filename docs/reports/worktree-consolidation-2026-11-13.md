# Worktree consolidation audit - 2026-11-13


**Provenance:** measured 2026-11-13T02:00Z in the repository root against `origin/main` read fresh, at `5b773c49cff1a5ec5cb1593bc48d284fa37dff1b` (`docs: render the changelog - 573 releases`). The task record names `d33a6ef5`; that sha is stale and every number below is quoted against `5b773c49`.


**Counts at the start:** 49 `git worktree list` entries = the primary checkout plus **48 worktrees**; 52 directories under `.worktrees/` = 48 registered trees plus **4 empty orphan directories** (no `.git`, no files). Seven runs are live on this host, three of them in this repo: this run, `make-highlighting-part-of-a-worktree-db6c92` (run_b4d414728ab641b884063f45075296fc) and `make-focus-mode-show-every-worktree-with-a9627a` (run_d0c7b0f4a0084e6fb07a8d522bae2f4a).


| class | trees |
| --- | --- |
| already-in-main | 19 |
| empty | 13 |
| superseded | 7 |
| worth-keeping | 8 |
| this-run | 1 |

## Method


Read-only for the audit: `git fetch origin main`, `git worktree list --porcelain`, `git ls-remote --heads origin` (377 heads), `gh pr list --state all --limit 400` (391 MERGED, 7 CLOSED, 2 OPEN), `curl /api/jobs`, and per tree:


```
git -C <tree> status --porcelain | wc -l                       # dirty count
git -C <tree> rev-list --left-right --count origin/main...<head>  # behind<TAB>ahead
git cherry origin/main <head>                                  # patch-id: '-' means that commit is already upstream
git merge-tree --write-tree --name-only origin/main <head>      # equality test, no working file moved
python line-presence.py <tree> <merge-base> <head> origin/main  # added-line containment, per file
```

A class is only claimed with one of those proofs behind it. `git cherry` printing `-` for every own commit is the patch-id proof; where main landed the same change and then reworded a comment, extended a signature or bumped `package.json`, the line-presence read names the exact lines that differ and they are quoted in the proof column.


## The 48 worktrees


`ahead`/`behind` are against `origin/main` at `5b773c49`. `absent` is the count of lines this branch adds that are absent from `origin/main` (line-presence total), `n/a` when the tree has no own commits. `action` is what phase 2 does.


| tree | branch | HEAD | behind | ahead | dirty | cherry -/+ | absent | PR | class | action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| add-generic-gui-pipeline-to-bundle-4c4680 | wtgui/add-generic-gui-pipeline-to-bundle-4c4680 | c3dd589c | 389 | 0 | 1 | 0/0 | n/a | - | empty | keep-dirty |
| add-per-project-landing-rules-the-carry-4cc45c | wtgui/add-per-project-landing-rules-the-carry-4cc45c | 4829d3cf | 475 | 0 | 7 | 0/0 | n/a | - | empty | keep-dirty |
| async-pipeline-driver-refactor | wtgui/async-pipeline-driver-refactor | b7394d4c | 256 | 0 | 22 | 0/0 | n/a | - | empty | keep-dirty |
| fix-the-refusal-that-parked-52-6974b3 | wtgui/fix-the-refusal-that-parked-52-6974b3 | b7971137 | 271 | 0 | 3 | 0/0 | n/a | - | empty | keep-dirty |
| make-baidu-ernie-light-dt-1-0-intl-884b06 | wtgui/make-baidu-ernie-light-dt-1-0-intl-884b06 | c0188ebb | 87 | 0 | 0 | 0/0 | n/a | - | empty | delete |
| mark-the-turnover-branch-at-a-glance-in-ccdfb1 | wtgui/mark-the-turnover-branch-at-a-glance-in-ccdfb1 | a5e4a1a9 | 45 | 0 | 0 | 0/0 | n/a | #720 MERGED | empty | delete |
| open-jira-report-in-edge-desktop-session-a29cc7 | wtgui/open-jira-report-in-edge-desktop-session-a29cc7 | a459f458 | 24 | 0 | 0 | 0/0 | n/a | - | empty | delete |
| panel-responsiveness-fixes | wtgui/panel-responsiveness-fixes | a8c88bfb | 108 | 0 | 0 | 0/0 | n/a | #702 MERGED | empty | delete |
| retry-settings-write-on-slow-panel-48eeb8 | wtgui/retry-settings-write-on-slow-panel-48eeb8 | b7394d4c | 256 | 0 | 2 | 0/0 | n/a | - | empty | keep-dirty |
| revert-baidu-ernie-light-model-catalog-d1f5ac | wtgui/revert-baidu-ernie-light-model-catalog-d1f5ac | c0188ebb | 87 | 0 | 0 | 0/0 | n/a | - | empty | delete |
| round-c-how-a-round-names-its-trees-5b3b85 | wtgui/round-c-how-a-round-names-its-trees-5b3b85 | ccb100cc | 88 | 0 | 0 | 0/0 | n/a | #707 MERGED,#691 MERGED | empty | delete |
| round-c-how-a-round-names-its-trees-stage-2-conclude-7ace4b | wtgui/rung-2-row-starts-in-its-tree | 0ca789b0 | 169 | 0 | 1 | 0/0 | n/a | #687 MERGED | empty | keep-dirty |
| run-github-landing-sanity-test-write-0472b0 | wtgui/run-github-landing-sanity-test-write-0472b0 | b1226087 | 221 | 0 | 1 | 0/0 | n/a | - | empty | keep-dirty |
| fix-the-docked-console-so-it-renders-7c9ac4 | wtgui/fix-the-docked-console-so-it-renders-7c9ac4 | 3e796ff3 | 39 | 1 | 0 | 1/0 | 1 | #724 MERGED | already-in-main | delete |
| fix-the-scan-defect-that-leaves-rows-e624cd | wtgui/fix-the-scan-defect-that-leaves-rows-e624cd | e83ec642 | 24 | 3 | 0 | 3/0 | 1 | #727 MERGED | already-in-main | delete |
| implement-the-row-in-this-tree-only-and-02f181 | wtgui/implement-the-row-in-this-tree-only-and-02f181 | 60a39616 | 86 | 2 | 0 | 0/2 | 2 | #710 MERGED | already-in-main | delete |
| input-lag-flame-2026-11-12 | wtgui/input-lag-flame-2026-11-12 | c6a37f5c | 63 | 2 | 0 | 2/0 | 1 | #717 MERGED | already-in-main | delete |
| main-thread-stalls-2026-11-12 | wtgui/main-thread-stalls-2026-11-12 | 649cc2b7 | 51 | 2 | 0 | 2/0 | 1 | #721 MERGED | already-in-main | delete |
| make-highlighting-part-of-a-worktree-db6c92 | wtgui/make-highlighting-part-of-a-worktree-db6c92 | 006e093c | 5 | 4 | 0 | 4/0 | 0 | #732 MERGED | already-in-main | skip-live |
| make-the-turnover-branch-a-first-class-df6ca4 | wtgui/make-the-turnover-branch-a-first-class-df6ca4 | 2061db26 | 73 | 9 | 0 | 9/0 | 10 | #715 MERGED | already-in-main | delete |
| run-gui-improve-again-this-time-on-the-5ab4e1 | wtgui/run-gui-improve-again-this-time-on-the-5ab4e1 | da9f87a6 | 293 | 1 | 0 | 0/1 | 0 | - | already-in-main | delete |
| run-row-70-exactly-as-written-local-only-19d782 | wtgui/run-row-70-exactly-as-written-local-only-19d782 | 50d503ca | 34 | 9 | 0 | 9/0 | 1 | #725 MERGED | already-in-main | delete |
| run-row-70-exactly-as-written-local-only-stage-2-critique-59a317 | wtgui/run-row-70-exactly-as-written-local-only-stage-2-critique-59a317 | 966b3f5b | 167 | 2 | 0 | 2/0 | 0 | - | already-in-main | delete |
| run-row-70-exactly-as-written-local-only-stage-2-critique-6635d7 | wtgui/run-row-70-exactly-as-written-local-only-stage-2-critique-6635d7 | 9888b9bc | 167 | 1 | 0 | 1/0 | 10 | - | already-in-main | delete |
| scan-queue-backoff-2026-11-12 | wtgui/scan-queue-backoff-2026-11-12 | 16dd8224 | 76 | 2 | 0 | 2/0 | 3 | #714 MERGED | already-in-main | delete |
| scan-queue-latency-2026-11-11 | wtgui/scan-queue-latency-2026-11-11 | 738334e8 | 79 | 2 | 0 | 2/0 | 11 | #713 MERGED | already-in-main | delete |
| the-implement-stage-of-the-unattached-61851d | wtgui/the-implement-stage-of-the-unattached-61851d | a0a7bc9c | 293 | 2 | 0 | 0/2 | 103 | - | already-in-main | keep-superseded |
| the-review-stage-of-the-unattached-fae8c5 | wtgui/the-review-stage-of-the-unattached-fae8c5 | 5966b855 | 274 | 1 | 0 | 0/1 | 0 | - | already-in-main | delete |
| thinking-latency-2026-11-12 | wtgui/thinking-latency-2026-11-12 | 09b3a168 | 45 | 2 | 0 | 2/0 | 1 | #723 MERGED | already-in-main | delete |
| two-changes-to-the-clarify-card-one-pr-33f806 | wtgui/two-changes-to-the-clarify-card-one-pr-33f806 | 1cd6d5b1 | 103 | 5 | 2 | 5/0 | 44 | #704 MERGED | already-in-main | keep-dirty |
| write-the-draft-the-brief-asks-for-in-94df79 | wtgui/write-the-draft-the-brief-asks-for-in-94df79 | 93febcc9 | 402 | 8 | 0 | 2/6 | 126 | - | already-in-main | keep-superseded |
| write-the-draft-the-brief-asks-for-in-970633 | wtgui/write-the-draft-the-brief-asks-for-in-970633 | 99933086 | 312 | 1 | 0 | 0/1 | 2 | #607 CLOSED | already-in-main | delete |
| github-landing-sanity-0bbdd3 | wtgui/github-landing-sanity-0bbdd3 | de5f30cf | 197 | 7 | 0 | 5/2 | 855 | #679 MERGED | superseded | keep-superseded |
| round-b-what-the-state-printer-says-01cc86 | wtgui/round-b-what-the-state-printer-says-01cc86 | 6214af31 | 293 | 2 | 0 | 0/2 | 128 | - | superseded | keep-superseded |
| round-b-what-the-state-printer-says-stage-1-probe-112593 | wtgui/round-b-what-the-state-printer-says-stage-1-probe-112593 | d104dbf2 | 293 | 1 | 0 | 0/1 | 45 | - | superseded | keep-superseded |
| round-b-what-the-state-printer-says-stage-2-conclude-530d9e | wtgui/round-b-what-the-state-printer-says-stage-2-conclude-530d9e | 848cf120 | 293 | 1 | 0 | 0/1 | 83 | - | superseded | keep-superseded |
| run-gui-improve-again-this-time-on-the-2ae88d | wtgui/run-gui-improve-again-this-time-on-the-2ae88d | 38ef1d28 | 293 | 2 | 0 | 0/2 | 371318 | - | superseded | keep-superseded |
| run-row-70-exactly-as-written-local-only-stage-1-draft-1de511 | wtgui/run-row-70-exactly-as-written-local-only-stage-1-draft-1de511 | 5082d019 | 167 | 4 | 0 | 1/3 | 392 | - | superseded | keep-superseded |
| run-row-71-exactly-as-written-local-only-0cc905 | wtgui/run-row-71-exactly-as-written-local-only-0cc905 | 608b0e02 | 167 | 3 | 0 | 0/3 | 144 | - | superseded | keep-superseded |
| deep-dive-why-some-assis-e8cb2e | wtgui/deep-dive-why-some-assis-e8cb2e | bdf198b6 | 756 | 3 | 0 | 0/3 | 487 | #468 OPEN | worth-keeping | roll-up |
| local-pipeline-walk-author-review-revise-stage-1-author-da66f8 | wtgui/local-pipeline-walk-author-review-revise-stage-1-author-da66f8 | f5f9f874 | 159 | 2 | 0 | 0/2 | 155 | - | worth-keeping | roll-up |
| local-pipeline-walk-author-review-revise-stage-2-review-29f215 | wtgui/local-pipeline-walk-author-review-revise-stage-2-review-29f215 | ae3d444e | 159 | 2 | 0 | 0/2 | 11 | - | worth-keeping | roll-up |
| local-pipeline-walk-author-review-revise-stage-3-revise-9e5bdc | wtgui/local-pipeline-walk-author-review-revise-stage-3-revise-9e5bdc | c0644290 | 159 | 1 | 0 | 0/1 | 196 | - | worth-keeping | roll-up |
| make-focus-mode-show-every-worktree-with-a9627a | wtgui/make-focus-mode-show-every-worktree-with-a9627a | 9be7cb59 | 8 | 1 | 0 | 0/1 | 108 | - | worth-keeping | skip-live |
| make-optym-integration-m-b580a2 | wtgui/make-optym-integration-m-b580a2 | ea15bb1d | 764 | 2 | 0 | 0/2 | 5 | #462 OPEN | worth-keeping | roll-up |
| read-docs-reports-gui-improve-experience-28a3ec | wtgui/read-docs-reports-gui-improve-experience-28a3ec | 12307d9c | 245 | 1 | 0 | 0/1 | 69 | - | worth-keeping | roll-up |
| read-the-settled-transcript-of-thread-31a9f8 | wtgui/read-the-settled-transcript-of-thread-31a9f8 | e670a95b | 245 | 1 | 0 | 0/1 | 390 | - | worth-keeping | roll-up |
| consolidate-this-repo-s-worktrees-in-two-cee22f | wtgui/consolidate-this-repo-s-worktrees-in-two-cee22f | 5b773c49 | 0 | 0 | 0 | 0/0 | n/a | - | this-run | protected |

## Proof per tree


### already-in-main (19)


- **fix-the-docked-console-so-it-renders-7c9ac4** `3e796ff3` on `wtgui/fix-the-docked-console-so-it-renders-7c9ac4`: PR #724 MERGED at this head; git cherry origin/main prints - for 1/1 commit; only the package.json version line differs.
- **fix-the-scan-defect-that-leaves-rows-e624cd** `e83ec642` on `wtgui/fix-the-scan-defect-that-leaves-rows-e624cd`: PR #727 MERGED at this head; git cherry - for 3/3; only the package.json version line differs.
- **implement-the-row-in-this-tree-only-and-02f181** `60a39616` on `wtgui/implement-the-row-in-this-tree-only-and-02f181`: PR #710 MERGED at this head (60a39616); 466/468 lines on main, the 2 absent are the version line and one prompt line main reworded.
- **input-lag-flame-2026-11-12** `c6a37f5c` on `wtgui/input-lag-flame-2026-11-12`: PR #717 MERGED at this head; git cherry - for 2/2; only the version line differs.
- **main-thread-stalls-2026-11-12** `649cc2b7` on `wtgui/main-thread-stalls-2026-11-12`: PR #721 MERGED at this head; git cherry - for 2/2; only the version line differs.
- **make-highlighting-part-of-a-worktree-db6c92** `006e093c` on `wtgui/make-highlighting-part-of-a-worktree-db6c92`: git merge-tree origin/main HEAD == origin/main's tree; 884/884 lines on main; PR #732 MERGED. (live run run_b4d414728ab641b884063f45075296fc)
- **make-the-turnover-branch-a-first-class-df6ca4** `2061db26` on `wtgui/make-the-turnover-branch-a-first-class-df6ca4`: PR #715 MERGED at this head; git cherry - for 9/9; 2686/2696 lines on main, the 9 absent are lib/jobs.js comments main reworded.
- **run-gui-improve-again-this-time-on-the-5ab4e1** `da9f87a6` on `wtgui/run-gui-improve-again-this-time-on-the-5ab4e1`: git merge-tree origin/main HEAD == origin/main's tree; 39880/39880 lines on main.
- **run-row-70-exactly-as-written-local-only-19d782** `50d503ca` on `wtgui/run-row-70-exactly-as-written-local-only-19d782`: PR #725 MERGED at this head; git cherry - for 9/9; 1610/1611 lines on main (only the version line absent).
- **run-row-70-exactly-as-written-local-only-stage-2-critique-59a317** `966b3f5b` on `wtgui/run-row-70-exactly-as-written-local-only-stage-2-critique-59a317`: 47/47 added lines on main; main's ledger/ping-pong holds the later round that absorbed them.
- **run-row-70-exactly-as-written-local-only-stage-2-critique-6635d7** `9888b9bc` on `wtgui/run-row-70-exactly-as-written-local-only-stage-2-critique-6635d7`: git merge-tree origin/main HEAD == origin/main's tree; 47/47 lines on main.
- **scan-queue-backoff-2026-11-12** `16dd8224` on `wtgui/scan-queue-backoff-2026-11-12`: PR #714 MERGED at this head; git cherry - for 2/2; 75/78 added lines on main, the 2 absent are scheduler lines main reworked later (lib/scheduler.js has deferUntil at :704).
- **scan-queue-latency-2026-11-11** `738334e8` on `wtgui/scan-queue-latency-2026-11-11`: PR #713 MERGED at this head; git cherry - for 2/2; its own lib/scan-queue.js, lib/pool.js, lib/loop-lag.js and tests are 100% on main (784/795 lines); 10 absent are scheduler lines main reworked.
- **the-implement-stage-of-the-unattached-61851d** `a0a7bc9c` on `wtgui/the-implement-stage-of-the-unattached-61851d`: its code is on main in full: lib/job-trees.js 17/17, public/app.js 19/19, public/render-jobs.js 16/16, landed by 2f1948e1 'feat: an unattached card names its worktree'; only its ledger report is absent. (ledger/gui-improve/implement-report.md (103 lines) is not on main; branch is on no remote)
- **the-review-stage-of-the-unattached-fae8c5** `5966b855` on `wtgui/the-review-stage-of-the-unattached-fae8c5`: git merge-tree origin/main HEAD == origin/main's tree; 1/1 line on main.
- **thinking-latency-2026-11-12** `09b3a168` on `wtgui/thinking-latency-2026-11-12`: PR #723 MERGED at this head; git cherry - for 2/2; only the version line differs.
- **two-changes-to-the-clarify-card-one-pr-33f806** `1cd6d5b1` on `wtgui/two-changes-to-the-clarify-card-one-pr-33f806`: PR #704 MERGED at this head; git cherry - for 5/5; main carries later forms of the same functions (public/app.js openQuestionFile(target, base), lib/clarify-links.js on main). (2 uncommitted files)
- **write-the-draft-the-brief-asks-for-in-94df79** `93febcc9` on `wtgui/write-the-draft-the-brief-asks-for-in-94df79`: its code is on main: public/style.css 19/19 (settings-roots rules) and public/index.html 1/1; the 126 absent lines are its ledger records (change-set.patch, ping-pong). (ledger change-set.patch and ping-pong notes are not on main; branch is on no remote)
- **write-the-draft-the-brief-asks-for-in-970633** `99933086` on `wtgui/write-the-draft-the-brief-asks-for-in-970633`: PR #607 was CLOSED, but its work is on main: test/pipeline-artifacts.test.js 186/186 lines and the nextStageOf call at lib/task-pipeline-drive.js:2350 carries main's later form (extra review: argument).

### empty (13)


- **add-generic-gui-pipeline-to-bundle-4c4680** `c3dd589c` on `wtgui/add-generic-gui-pipeline-to-bundle-4c4680`: branch tip is an ancestor of origin/main (0 own commits). (1 uncommitted file)
- **add-per-project-landing-rules-the-carry-4cc45c** `4829d3cf` on `wtgui/add-per-project-landing-rules-the-carry-4cc45c`: branch tip is an ancestor of origin/main (0 own commits). (7 uncommitted files)
- **async-pipeline-driver-refactor** `b7394d4c` on `wtgui/async-pipeline-driver-refactor`: branch tip is an ancestor of origin/main (0 own commits). (22 uncommitted files)
- **fix-the-refusal-that-parked-52-6974b3** `b7971137` on `wtgui/fix-the-refusal-that-parked-52-6974b3`: branch tip is an ancestor of origin/main (0 own commits). (3 uncommitted files)
- **make-baidu-ernie-light-dt-1-0-intl-884b06** `c0188ebb` on `wtgui/make-baidu-ernie-light-dt-1-0-intl-884b06`: branch tip is an ancestor of origin/main (0 own commits).
- **mark-the-turnover-branch-at-a-glance-in-ccdfb1** `a5e4a1a9` on `wtgui/mark-the-turnover-branch-at-a-glance-in-ccdfb1`: branch tip is an ancestor of origin/main (0 own commits).
- **open-jira-report-in-edge-desktop-session-a29cc7** `a459f458` on `wtgui/open-jira-report-in-edge-desktop-session-a29cc7`: branch tip is an ancestor of origin/main (0 own commits).
- **panel-responsiveness-fixes** `a8c88bfb` on `wtgui/panel-responsiveness-fixes`: branch tip is an ancestor of origin/main; its PR #712 merged at this head.
- **retry-settings-write-on-slow-panel-48eeb8** `b7394d4c` on `wtgui/retry-settings-write-on-slow-panel-48eeb8`: branch tip is an ancestor of origin/main (0 own commits). (2 uncommitted files)
- **revert-baidu-ernie-light-model-catalog-d1f5ac** `c0188ebb` on `wtgui/revert-baidu-ernie-light-model-catalog-d1f5ac`: branch tip is an ancestor of origin/main (0 own commits).
- **round-c-how-a-round-names-its-trees-5b3b85** `ccb100cc` on `wtgui/round-c-how-a-round-names-its-trees-5b3b85`: branch tip is an ancestor of origin/main (0 own commits).
- **round-c-how-a-round-names-its-trees-stage-2-conclude-7ace4b** `0ca789b0` on `wtgui/rung-2-row-starts-in-its-tree`: branch tip is an ancestor of origin/main (0 own commits). (1 uncommitted file)
- **run-github-landing-sanity-test-write-0472b0** `b1226087` on `wtgui/run-github-landing-sanity-test-write-0472b0`: branch tip is an ancestor of origin/main (0 own commits). (1 uncommitted file)

### superseded (7)


- **github-landing-sanity-0bbdd3** `de5f30cf` on `wtgui/github-landing-sanity-0bbdd3`: PR #679 MERGED at 2b72e8e1; its two later docs commits write ledger/github-force-merge/main.md and merge.md, and main's copies were re-recorded later at 7fdc96ac (2026-11-09 23:38, after the tree's 20:37). (branch is on no remote)
- **round-b-what-the-state-printer-says-01cc86** `6214af31` on `wtgui/round-b-what-the-state-printer-says-01cc86`: docs/investigation.md and ledger/investigate/probe.md are on main at round 7 (e7f51f57, 2026-11-09 23:20), later than this tree's 06:39 and the same paths. (branch is on no remote)
- **round-b-what-the-state-printer-says-stage-1-probe-112593** `d104dbf2` on `wtgui/round-b-what-the-state-printer-says-stage-1-probe-112593`: ledger/investigate/probe.md on main is round 7's later probe (f64a4f7c). (branch is on no remote)
- **round-b-what-the-state-printer-says-stage-2-conclude-530d9e** `848cf120` on `wtgui/round-b-what-the-state-printer-says-stage-2-conclude-530d9e`: docs/investigation.md on main is round 7's later conclusion (e7f51f57). (branch is on no remote)
- **run-gui-improve-again-this-time-on-the-2ae88d** `38ef1d28` on `wtgui/run-gui-improve-again-this-time-on-the-2ae88d`: its ledger/gui-improve/compare/** was re-shot and landed at 2f1948e1 (2026-11-09 09:30), six minutes after this tree's tip; main's copies differ. (branch is on no remote)
- **run-row-70-exactly-as-written-local-only-stage-1-draft-1de511** `5082d019` on `wtgui/run-row-70-exactly-as-written-local-only-stage-1-draft-1de511`: ledger/ping-pong/draft.md, critique.md and verdicts on main are the later round that closed at ef6c2484 (2026-11-12 05:47). (branch is on no remote)
- **run-row-71-exactly-as-written-local-only-0cc905** `608b0e02` on `wtgui/run-row-71-exactly-as-written-local-only-0cc905`: ledger/ping-pong/draft.md and critique.md on main are the later round that closed at ef6c2484. (branch is on no remote)

### worth-keeping (8)


- **deep-dive-why-some-assis-e8cb2e** `bdf198b6` on `wtgui/deep-dive-why-some-assis-e8cb2e`: 487/528 added lines absent from main; test/unknown-fence.test.js is not on main at all; PR #468 is OPEN. (also has an open PR)
- **local-pipeline-walk-author-review-revise-stage-1-author-da66f8** `f5f9f874` on `wtgui/local-pipeline-walk-author-review-revise-stage-1-author-da66f8`: ledger/author-review/manuscript.md is not on main (155/155 lines absent).
- **local-pipeline-walk-author-review-revise-stage-2-review-29f215** `ae3d444e` on `wtgui/local-pipeline-walk-author-review-revise-stage-2-review-29f215`: ledger/author-review/review.md and verdict.json are not on main (11/11 lines absent).
- **local-pipeline-walk-author-review-revise-stage-3-revise-9e5bdc** `c0644290` on `wtgui/local-pipeline-walk-author-review-revise-stage-3-revise-9e5bdc`: ledger/author-review/revision.md is not on main (196/196 lines absent).
- **make-focus-mode-show-every-worktree-with-a9627a** `9be7cb59` on `wtgui/make-focus-mode-show-every-worktree-with-a9627a`: git merge-tree origin/main HEAD keeps HEAD's tree (main lacks the change); 108/125 added lines absent. (live run run_d0c7b0f4a0084e6fb07a8d522bae2f4a)
- **make-optym-integration-m-b580a2** `ea15bb1d` on `wtgui/make-optym-integration-m-b580a2`: its 5-line fix is absent: main still says config.json is 'tracked by git' in README.md, SETUP.md and server.js; PR #462 is OPEN. (branch is on origin)
- **read-docs-reports-gui-improve-experience-28a3ec** `12307d9c` on `wtgui/read-docs-reports-gui-improve-experience-28a3ec`: docs/reports/gui-improve-experience-review-2026-11-09.md is not on main (69/69 lines absent).
- **read-the-settled-transcript-of-thread-31a9f8** `e670a95b` on `wtgui/read-the-settled-transcript-of-thread-31a9f8`: docs/reports/email-multi-272-session-review-2026-11-09.html is not on main (390/390 lines absent).

### this-run (1)


- **consolidate-this-repo-s-worktrees-in-two-cee22f** `5b773c49` on `wtgui/consolidate-this-repo-s-worktrees-in-two-cee22f`: the tree this run works in; its branch is the landing branch, 0 ahead of origin/main until the report commit. (own tree)

## Phase 2 plan, written before anything was removed


Delete (21): every `empty` tree whose branch tip is an ancestor of `origin/main` and whose working tree is clean, plus every `already-in-main` tree whose content is proven on main. Nothing in that set holds a commit whose content main lacks.


Leave in place, with the reason:


- 8 dirty trees (uncommitted work is the only copy in git): add-generic-gui-pipeline-to-bundle-4c4680, add-per-project-landing-rules-the-carry-4cc45c, async-pipeline-driver-refactor, fix-the-refusal-that-parked-52-6974b3, retry-settings-write-on-slow-panel-48eeb8, round-c-how-a-round-names-its-trees-stage-2-conclude-7ace4b, run-github-landing-sanity-test-write-0472b0, two-changes-to-the-clarify-card-one-pr-33f806.
- 2 trees a live run holds: `make-highlighting-part-of-a-worktree-db6c92` (already in main, but run_b4d414728ab641b884063f45075296fc is live) and `make-focus-mode-show-every-worktree-with-a9627a` (worth keeping, run_d0c7b0f4a0084e6fb07a8d522bae2f4a is live).
- 9 trees whose commits are on no remote and not on main (the rule that cost two commits earlier tonight): github-landing-sanity-0bbdd3, round-b-what-the-state-printer-says-01cc86, round-b-what-the-state-printer-says-stage-1-probe-112593, round-b-what-the-state-printer-says-stage-2-conclude-530d9e, run-gui-improve-again-this-time-on-the-2ae88d, run-row-70-exactly-as-written-local-only-stage-1-draft-1de511, run-row-71-exactly-as-written-local-only-0cc905, the-implement-stage-of-the-unattached-61851d, write-the-draft-the-brief-asks-for-in-94df79.
- My own tree and the primary checkout.


Each removal re-reads `/api/jobs` first and skips a tree a live run holds. The removal route is the panel's own `POST /api/worktree/delete`, because this repo's trees carry `node_modules` junctions and a plain `git worktree remove` recurses through a junction into the primary checkout's dependencies.


## Phase 2 result

**Resumed 2026-11-13T02:20Z** in `.worktrees/consolidate-this-repo-s-worktrees-in-two-cee22f` on `wtgui/roll-up-2026-11-13`, from the verdicts above and not from a fresh audit. Nothing was re-cut and nothing was re-measured: the shas and proofs below are the ones in the tables above.

**Counts:** 48 worktrees audited, **26 kept** (25 other trees plus this run's own tree) and **22 dropped**. `git worktree list` now reads 27 entries (the primary checkout plus 26 trees) and `.worktrees/` holds 26 directories; the 4 empty orphan directories the audit counted are gone too. `/api/jobs` was read before every removal and at the resume: 3 live runs at resume, none of them holding a tree in the drop set.

### Dropped (22)

Every one of these was `empty` (branch tip an ancestor of `origin/main`, 0 own commits) or `already-in-main` (PR merged at this head, `git cherry` printing `-` for every own commit, or `git merge-tree origin/main <head>` returning origin/main's own tree). Nothing in this set holds content main lacks.

| tree | branch | tip | one line |
| --- | --- | --- | --- |
| fix-the-docked-console-so-it-renders-7c9ac4 | wtgui/fix-the-docked-console-so-it-renders-7c9ac4 | `3e796ff3f4cdf2f4613abcc1959ad44b62ccda0a` | docked console render fix, PR #724 merged at this head |
| fix-the-scan-defect-that-leaves-rows-e624cd | wtgui/fix-the-scan-defect-that-leaves-rows-e624cd | `e83ec642b6219cd47761a716db8b4e7fe1e50913` | scan defect that left rows behind, PR #727 |
| implement-the-row-in-this-tree-only-and-02f181 | wtgui/implement-the-row-in-this-tree-only-and-02f181 | `60a3961616cbd7c3decd8730d6c457224fb49310` | row implemented in its tree, PR #710 |
| input-lag-flame-2026-11-12 | wtgui/input-lag-flame-2026-11-12 | `c6a37f5c705fff3125b44c8afc473ac0e27b7ea1` | input lag flame profile, PR #717 |
| main-thread-stalls-2026-11-12 | wtgui/main-thread-stalls-2026-11-12 | `649cc2b73d3acd5254e7a64b3ee087d975f1b1ff` | main thread stall fixes, PR #721 |
| make-the-turnover-branch-a-first-class-df6ca4 | wtgui/make-the-turnover-branch-a-first-class-df6ca4 | `2061db2613fde7c931f6dab2b5a0abcecedeadd5` | turnover branch as a first-class row, PR #715 |
| run-gui-improve-again-this-time-on-the-5ab4e1 | wtgui/run-gui-improve-again-this-time-on-the-5ab4e1 | `da9f87a6036b0c7a9303d18ab7ce5f2f1d902b43` | gui improve round; merge-tree equals origin/main's tree |
| run-row-70-exactly-as-written-local-only-19d782 | wtgui/run-row-70-exactly-as-written-local-only-19d782 | `50d503ca7b9dfa2283283a9acf8a1a959d60fcb5` | row 70 walked local-only, PR #725 |
| run-row-70-exactly-as-written-local-only-stage-2-critique-59a317 | wtgui/run-row-70-exactly-as-written-local-only-stage-2-critique-59a317 | `966b3f5b1da2b4b36e4a078f9620e71e6c60af62` | row 70 stage 2 critique absorbed by main's later round |
| run-row-70-exactly-as-written-local-only-stage-2-critique-6635d7 | wtgui/run-row-70-exactly-as-written-local-only-stage-2-critique-6635d7 | `9888b9bc142df790247df251551ec416a1e07d75` | row 70 stage 2 critique; merge-tree equals main's tree |
| scan-queue-backoff-2026-11-12 | wtgui/scan-queue-backoff-2026-11-12 | `16dd82244eaff6089aa6129ddf2288c4ab69a78a` | scan queue backoff, PR #714 |
| scan-queue-latency-2026-11-11 | wtgui/scan-queue-latency-2026-11-11 | `738334e88acb230f09d50ab893a3eaa0f83f9d27` | scan queue latency, PR #713 |
| the-review-stage-of-the-unattached-fae8c5 | wtgui/the-review-stage-of-the-unattached-fae8c5 | `5966b8557f2145881e9af14fd917024e8677b4b9` | unattached review stage; merge-tree equals main's tree |
| thinking-latency-2026-11-12 | wtgui/thinking-latency-2026-11-12 | `09b3a1687e0c8909191a19490d325823947a1d6c` | thinking latency, PR #723 |
| write-the-draft-the-brief-asks-for-in-970633 | wtgui/write-the-draft-the-brief-asks-for-in-970633 | `9993308614c87ac8e02108824f73d5838eafdc42` | draft doc; PR #607 closed but its code is on main |
| make-baidu-ernie-light-dt-1-0-intl-884b06 | wtgui/make-baidu-ernie-light-dt-1-0-intl-884b06 | `c0188ebb7b0fbb83d87c68e911edf8f38803c0b4` | empty: tip is an ancestor of origin/main |
| mark-the-turnover-branch-at-a-glance-in-ccdfb1 | wtgui/mark-the-turnover-branch-at-a-glance-in-ccdfb1 | `a5e4a1a93b9068c646849b4e79af1f5efccf3a08` | empty: tip is an ancestor; PR #720 merged |
| open-jira-report-in-edge-desktop-session-a29cc7 | wtgui/open-jira-report-in-edge-desktop-session-a29cc7 | `a459f458b6a05ae963f1627558dcf45cc8ebddd1` | empty: tip is an ancestor of origin/main |
| panel-responsiveness-fixes | wtgui/panel-responsiveness-fixes | `a8c88bfb7b441e8ee9bd64ccaf8552025d0eab46` | empty: tip is an ancestor; PR #712 merged at this head |
| revert-baidu-ernie-light-model-catalog-d1f5ac | wtgui/revert-baidu-ernie-light-model-catalog-d1f5ac | `c0188ebb7b0fbb83d87c68e911edf8f38803c0b4` | empty: tip is an ancestor of origin/main |
| round-c-how-a-round-names-its-trees-5b3b85 | wtgui/round-c-how-a-round-names-its-trees-5b3b85 | `ccb100cca4b81593161157d777c02bfd5574ceb0` | empty: tip is an ancestor; PR #707 and #691 merged |
| make-highlighting-part-of-a-worktree-db6c92 | wtgui/make-highlighting-part-of-a-worktree-db6c92 | `006e093c1d5523f0696e8880eb523f61d196211b` | worktree highlighting, PR #732; skipped at audit while its run was live, removed after that run left /api/jobs |

**One honest caveat.** Five of these tips - `da9f87a6` (run-gui-improve-again-5ab4e1), `966b3f5b` and `9888b9bc` (the two row-70 stage-2 critiques), `5966b855` (review stage of the unattached) and `99933086` (write-the-draft-970633) - are not reachable from any branch on `origin` and are not ancestors of `main`. Their *content* is on main and that is the proof the audit recorded (merge-tree equality for four of them, 186/186 and a later `nextStageOf` form for `99933086`), and the commit objects are still in the local object store (`git cat-file -t` returns `commit` for all five), but the shas themselves are local-only. "Already in main" here means the change, not the sha.

**Remote heads were left alone.** 15 of the 22 branches still exist on `origin`; this sweep removed local branches and worktrees only.

### Kept (26, nothing removed)

- **8 dirty trees**, because uncommitted work is the only copy in git: add-generic-gui-pipeline-to-bundle-4c4680 (1 file), add-per-project-landing-rules-the-carry-4cc45c (7), async-pipeline-driver-refactor (22), fix-the-refusal-that-parked-52-6974b3 (3), retry-settings-write-on-slow-panel-48eeb8 (2), round-c-how-a-round-names-its-trees-stage-2-conclude-7ace4b (1, on `wtgui/rung-2-row-starts-in-its-tree`), run-github-landing-sanity-test-write-0472b0 (1), two-changes-to-the-clarify-card-one-pr-33f806 (2).
- **9 trees whose commits are on no remote and not on main**, the rule that cost two commits earlier: github-landing-sanity-0bbdd3 `de5f30cf`, round-b-what-the-state-printer-says-01cc86 `6214af31`, round-b-what-the-state-printer-says-stage-1-probe-112593 `d104dbf2`, round-b-what-the-state-printer-says-stage-2-conclude-530d9e `848cf120`, run-gui-improve-again-this-time-on-the-2ae88d `38ef1d28`, run-row-70-exactly-as-written-local-only-stage-1-draft-1de511 `5082d019`, run-row-71-exactly-as-written-local-only-0cc905 `608b0e02`, the-implement-stage-of-the-unattached-61851d `a0a7bc9c`, write-the-draft-the-brief-asks-for-in-94df79 `93febcc9`. Their code or ledger is on main, but their ledger records are not, and the branch is the only copy.
- **8 keepers**, merged below.
- **This run's tree** and **the primary checkout** (the repository root, on `main`), never touched.

### Keepers merged (8, 13 commits)

| keeper | tip | commits | merge |
| --- | --- | --- | --- |
| wtgui/local-pipeline-walk-author-review-revise-stage-1-author-da66f8 | `f5f9f874` | 2 | `7e64a884` |
| wtgui/local-pipeline-walk-author-review-revise-stage-2-review-29f215 | `ae3d444e` | 2 | `9caadef8` |
| wtgui/local-pipeline-walk-author-review-revise-stage-3-revise-9e5bdc | `c0644290` | 1 | `76d97b07` |
| wtgui/read-docs-reports-gui-improve-experience-28a3ec | `12307d9c` | 1 | `6b10cd7f` |
| wtgui/read-the-settled-transcript-of-thread-31a9f8 | `e670a95b` | 1 | `d6e22309` |
| wtgui/make-optym-integration-m-b580a2 | `ea15bb1d` | 2 | `5a7a5dc1` |
| wtgui/deep-dive-why-some-assis-e8cb2e | `bdf198b6` | 3 | `df4af5a8` |
| wtgui/make-focus-mode-show-every-worktree-with-a9627a | `9be7cb59` | 1 | `d5eb6f1d` |

**No keeper was dropped for regressing main.** Every merge was made with `--no-ff`; `git merge-tree --write-tree HEAD <keeper>` printed a tree and no conflict for the last one, and the seven before it merged with no conflict. The roll-up's diff against `origin/main` is 16 files, +1803/-15; the deletions are the README, SETUP and `server.js` lines that claim `config.json` is tracked by git - the exact wording the optym keeper exists to fix - and the reworded `lib/jobs.js` comments of the unknown-fence work. No main behaviour is removed.

The focus-mode keeper was held back at audit time because `run_d0c7b0f4a0084e6fb07a8d522bae2f4a` held its tree. `/api/jobs` at resume no longer lists that run, so the keeper was merged as the eighth.

### Tests

- `npm run test:changed` on the roll-up: 23 changed files against `origin/main`, 225 test files selected (222 by name, 3 by import), 325.1s, exit 1 with 17 failing test names. 16 of the 17 also fail in a clean `git archive origin/main` at `5b773c49`; the 17th, "every spawn prompt states the scratch path, and the card still shows only what the reader wrote", is load-dependent and passes on both trees when `test/paths.test.js` is run alone.
- `npm test` on the roll-up: exit 1 with 20 distinct failing test names. `npm test` on the clean archive failed 20 distinct names too; 19 are the same names. The roll-up-only name, "scan roots: a folder added from the settings is written, re-scanned, and drawn under its own card", fails identically in `test/scan-roots.test.js` run alone on both trees (same assertion, same 1.6s), so it is pre-existing. The archive-only name, "a job's settle kills what its turn started, grandchild included", is the flaky side of the same comparison.
- The union of the failing files was then run on both trees in one command: 19 names shared, and the two differences reproduce on the archive or pass in isolation.

No failure is attributable to this roll-up. The suite is red on `origin/main` itself.

### Landing

_Recorded after the pull request was opened._

