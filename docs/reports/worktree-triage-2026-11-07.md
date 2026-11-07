# Worktree triage - 2026-11-07

Base: `origin/main` at `c665d7c729` (1.50.5). Measured 2026-11-07 13:45 EST / 18:45Z from the
primary checkout of this repo and from this landing tree, against the panel's own 84-row board.

**Result: 84 rows (83 registered worktrees plus the primary checkout). 77 released. 7 kept, each
named with the reason below. Two features that were still needed were sitting uncommitted in trees
whose branch tips were already on main; both were committed on their branches, rebased, landed as
PR #529 and PR #531, and their trees released. One research-only document existed nowhere on main and
was consolidated into `docs/reports/`. One tree's uncommitted residue was a superseded duplicate of
landed #513, and it was recorded as such rather than landed twice.**

## How each verdict was reached

Landed is a CONTENT test, never an ahead count. Four proofs were used, strongest first, and the
proof used is named in the table:

1. **Ancestor** - `git merge-base --is-ancestor <head> origin/main` is true: the tree's own tip is in
   main's history, so nothing it carries exists only here. 24 of the 77 releases.
2. **A MERGED PR at that exact head** - `gh pr list --state all --limit 600 --json headRefOid,state`
   matched the tree's HEAD, so GitHub's own record says the content landed. 52 of the 77.
3. **Tree equality** - `git rev-parse <head>^{tree}` equals `git rev-parse origin/main^{tree}`: the
   two commits carry byte-identical trees.
4. **Patch equality** - `git cherry origin/main <head>` prints `-` for every commit and `+` for none.

A tree whose added lines were NOT on main was not landed, whatever its ahead count said. That test is
`git diff -U0 <merge-base> <head>`, keeping added lines longer than 25 characters, then looking for
each verbatim in `git show origin/main:<path>`; the table's "on main" column quotes the ratio when it
is not a clean landed verdict. `package.json` and `CHANGELOG.md` are excluded from that delta: a
version line and a changelog render are not evidence either way, and both are rewritten by every
landing.

**Dirty** is `git status --porcelain | wc -l` in the tree at measurement time, untracked files
included. **Live** is the panel's own `/api/jobs`, matching `cwd` against the tree, with status in
`running | starting | waiting | waiting_for_approval | queued`. Four rows were live during the pass:
this tree, `when-a-queue-line-lands-1b1ef5`, `read-only-measured-inves-c0c3bf` and
`the-settings-pipeline-ta-792759`.

The measurement is one row per registered worktree from `git worktree list --porcelain`, joined to the
PR list by HEAD sha and branch name, and re-checked per tree at the moment its row was acted on. It is
not a scan of folder names: 119 directories exist under `.worktrees`, 36 of them unregistered husks
with no `.git` file, no HEAD and nothing to lose, and those are not worktree rows and were not touched.

## The table

| # | worktree | branch | dirty | on main | action |
|---|---|---|---|---|---|
| 1 | `a-probe-timeout-must-not-fa31f1` | `wtgui/a-probe-timeout-must-not-fa31f1` | 0 | landed (PR #505 MERGED at head) | release |
| 2 | `a-repair-turn-must-not-c-aa2953` | `wtgui/a-repair-turn-must-not-c-aa2953` | 0 | landed (PR #473 MERGED at head) | release |
| 3 | `a-stage-run-must-not-be-436070` | `wtgui/a-stage-run-must-not-be-436070` | 0 | landed (ancestor of origin/main) | release |
| 4 | `agent-worktree-gui` | `main` | 5 | landed (tree = origin/main) | keep - base checkout (5 untracked files, not a worktree row) |
| 5 | `audit-the-panel-s-token-4e0755` | `wtgui/audit-the-panel-s-token-4e0755` | 0 | landed (ancestor of origin/main) | release |
| 6 | `auto-fold-turns-when-the-206e6d` | `wtgui/auto-fold-turns-when-the-206e6d` | 0 | landed (ancestor of origin/main) | release |
| 7 | `both-research-docs-are-c-e5b018` | `wtgui/both-research-docs-are-c-e5b018` | 0 | landed (ancestor of origin/main) | release |
| 8 | `build-a-per-remote-allow-fb5a95` | `wtgui/build-a-per-remote-allow-fb5a95` | 0 | landed (PR #439 MERGED at head) | release |
| 9 | `build-hard-restart-control-in-assistant-fb353f` | `wtgui/build-hard-restart-control-in-assistant-fb353f` | 10 | landed (ancestor of origin/main) | landed as PR #531, then released |
| 10 | `build-the-fan-out-model-4bb90b` | `wtgui/build-the-fan-out-model-4bb90b` | 0 | landed (PR #442 MERGED at head) | release |
| 11 | `critique-a-plan-before-a-93004d` | `wtgui/critique-a-plan-before-a-93004d` | 0 | landed (ancestor of origin/main) | release |
| 12 | `cut-the-append-tax-in-li-90bfcf` | `wtgui/cut-the-append-tax-in-li-90bfcf` | 5 | landed (content: 29/29 added lines on main; #513) | WIP-committed, then released |
| 13 | `deep-dive-why-some-assis-e8cb2e` | `wtgui/deep-dive-why-some-assis-e8cb2e` | 0 | not landed (21/409 added lines on main) | keep - PR #468 open and CONFLICTING |
| 14 | `design-how-a-pipelined-t-0a90d5` | `wtgui/design-how-a-pipelined-t-0a90d5` | 0 | landed (ancestor of origin/main) | release |
| 15 | `fix-orphan-version-tags-after-landing-077934` | `wtgui/fix-orphan-version-tags-after-landing-077934` | 0 | landed (ancestor of origin/main) | release |
| 16 | `fix-the-older-assistant-5583f9` | `wtgui/fix-the-older-assistant-5583f9` | 0 | landed (PR #487 MERGED at head) | release |
| 17 | `fix-the-push-settings-wr-161f16` | `wtgui/fix-the-push-settings-wr-161f16` | 0 | landed (PR #472 MERGED at head) | release |
| 18 | `fix-the-two-driver-defec-72dda4` | `wtgui/fix-the-two-driver-defec-72dda4` | 0 | landed (PR #444 MERGED at head) | release |
| 19 | `fix-thinking-toggle-replaying-history-in-6572d2` | `wtgui/fix-thinking-toggle-replaying-history-in-6572d2` | 0 | landed (PR #516 MERGED at head) | release |
| 20 | `front-end-cpu-and-time-w-cd92cd` | `wtgui/front-end-cpu-and-time-w-cd92cd` | 0 | landed (PR #476 MERGED at head) | release |
| 21 | `front-end-memory-and-lay-8087e5` | `wtgui/audit-dom-and-css-front-end-memory-8087e5` | 0 | landed (ancestor of origin/main) | release |
| 22 | `gate-the-old-tier-so-it-f280f8` | `wtgui/gate-the-old-tier-so-it-f280f8` | 0 | landed (PR #515 MERGED at head) | release |
| 23 | `group-the-assistant-floa-a626f2` | `wtgui/group-the-assistant-floa-a626f2` | 0 | landed (PR #446 MERGED at head) | release |
| 24 | `hey-get-me-some-screensh-b7a6e6` | `wtgui/hey-get-me-some-screensh-b7a6e6` | 0 | landed (PR #379 MERGED at head) | release |
| 25 | `hold-a-pipeline-row-on-i-04c7d1` | `wtgui/hold-a-pipeline-row-on-i-04c7d1` | 0 | landed (PR #461 MERGED at head) | release |
| 26 | `in-public-index-html-giv-f01e4b` | `wtgui/in-public-index-html-giv-f01e4b` | 0 | landed (PR #502 MERGED at head) | release |
| 27 | `investigate-why-the-vers-b490d8` | `wtgui/investigate-why-the-vers-b490d8` | 0 | landed (PR #448 MERGED at head) | release |
| 28 | `land-pr-359-and-render-t-0e6a57` | `wtgui/land-pr-359-and-render-t-0e6a57` | 0 | landed (ancestor of origin/main) | release |
| 29 | `lane-a-the-version-numbe-505c4c` | `wtgui/lane-a-the-version-numbe-505c4c` | 0 | landed (PR #471 MERGED at head) | release |
| 30 | `lane-b-tags-hyper-deep-r-061613` | `wtgui/lane-b-tags-hyper-deep-r-061613` | 1 | landed (ancestor of origin/main) | consolidated into docs/reports/, then released |
| 31 | `lane-c-the-changelog-and-9b0017` | `wtgui/lane-c-the-changelog-and-9b0017` | 0 | landed (PR #467 MERGED at head) | release |
| 32 | `lane-d-forensics-mine-th-79d3e5` | `wtgui/lane-d-forensics-mine-th-79d3e5` | 0 | landed (PR #474 MERGED at head) | release |
| 33 | `lane-e-our-own-automatio-264523` | `wtgui/lane-e-our-own-automatio-264523` | 0 | landed (PR #464 MERGED at head) | release |
| 34 | `lane-f-the-gates-what-th-148f76` | `wtgui/lane-f-the-gates-what-th-148f76` | 0 | landed (PR #469 MERGED at head) | release |
| 35 | `lane-g-outside-designs-h-e062a6` | `wtgui/lane-g-outside-designs-h-e062a6` | 0 | landed (PR #466 MERGED at head) | release |
| 36 | `lane-h-the-instructions-382eb3` | `wtgui/lane-h-the-instructions-382eb3` | 0 | landed (PR #465 MERGED at head) | release |
| 37 | `let-each-assistant-be-re-b279a4` | `wtgui/let-each-assistant-be-re-b279a4` | 0 | landed (PR #470 MERGED at head) | release |
| 38 | `let-the-panel-import-an-925c4b` | `wtgui/let-the-panel-import-an-925c4b` | 0 | landed (PR #413 MERGED at head) | release |
| 39 | `let-the-settings-name-th-bc17b2` | `wtgui/let-the-settings-name-th-bc17b2` | 0 | landed (PR #418 MERGED at head) | release |
| 40 | `link-the-mermaid-pipelin-e2fc16` | `wtgui/link-the-mermaid-pipelin-e2fc16` | 0 | landed (PR #458 MERGED at head) | release |
| 41 | `make-a-clarify-answer-to-64120f` | `wtgui/make-a-clarify-answer-to-64120f` | 0 | landed (PR #443 MERGED at head) | release |
| 42 | `make-a-settled-stage-adv-909918` | `wtgui/make-a-settled-stage-adv-909918` | 0 | landed (PR #451 MERGED at head) | release |
| 43 | `make-a-stopped-worker-as-97a3b4` | `wtgui/make-a-stopped-worker-as-97a3b4` | 0 | landed (PR #431 MERGED at head) | release |
| 44 | `make-optym-integration-m-b580a2` | `wtgui/make-optym-integration-m-b580a2` | 0 | not landed (0/4 added lines on main) | keep - PR #462 open |
| 45 | `make-the-deliverables-po-6815d2` | `wtgui/make-the-deliverables-po-6815d2` | 0 | landed (PR #438 MERGED at head) | release |
| 46 | `make-the-exited-chip-re-abc44e` | `wtgui/make-the-exited-chip-re-abc44e` | 0 | landed (PR #475 MERGED at head) | release |
| 47 | `move-the-two-per-project-9ccc15` | `wtgui/move-the-two-per-project-9ccc15` | 0 | landed (PR #455 MERGED at head) | release |
| 48 | `no-boot-promotion` | `wtgui/no-boot-promotion` | 0 | landed (PR #522 MERGED at head) | release |
| 49 | `on-a-200-open-handler-an-8f730c` | `wtgui/on-a-200-open-handler-an-8f730c` | 0 | landed (ancestor of origin/main) | release |
| 50 | `parked-counts-fleet` | `wtgui/parked-counts-fleet` | 0 | landed (PR #524 MERGED at head) | release |
| 51 | `pin-each-stage-s-handoff-1ff446` | `wtgui/pin-each-stage-s-handoff-1ff446` | 0 | landed (PR #436 MERGED at head) | release |
| 52 | `ping-pong-round-5-draft-9f2c41` | `wtgui/ping-pong-round-5-draft-9f2c41` | 0 | landed (PR #504 MERGED at head) | release |
| 53 | `put-the-primary-checkout-0c0f9b` | `wtgui/put-the-primary-checkout-0c0f9b` | 0 | landed (ancestor of origin/main) | release |
| 54 | `raise-the-matrix-bridge-3b5d6b` | `wtgui/raise-the-matrix-bridge-3b5d6b` | 0 | landed (ancestor of origin/main) | release |
| 55 | `re-render-the-pipeline-m-3d0771` | `wtgui/re-render-the-pipeline-m-3d0771` | 0 | landed (PR #453 MERGED at head) | release |
| 56 | `read-only-deep-performan-337338` | `wtgui/clarify-accept-path` | 0 | landed (PR #488 MERGED at head) | release |
| 57 | `read-only-diagnosis-of-t-0b803b` | `wtgui/read-only-diagnosis-of-t-0b803b` | 0 | landed (PR #503 MERGED at head) | release |
| 58 | `read-only-measured-inves-c0c3bf` | `wtgui/read-only-measured-inves-c0c3bf` | 1 | landed (ancestor of origin/main) | keep - live job, one uncommitted report |
| 59 | `render-every-panel-pipel-720c84` | `wtgui/render-every-panel-pipel-720c84` | 0 | landed (PR #409 MERGED at head) | release |
| 60 | `replace-the-push-permiss-588511` | `wtgui/replace-the-push-permiss-588511` | 0 | landed (PR #445 MERGED at head) | release |
| 61 | `research-how-to-stop-par-fa30aa` | `wtgui/research-how-to-stop-par-fa30aa` | 2 | landed (ancestor of origin/main) | landed as PR #529, then released |
| 62 | `restore-the-primary-chec-83b67e` | `wtgui/restore-the-primary-chec-83b67e` | 0 | landed (ancestor of origin/main) | release |
| 63 | `retire-the-landed-clean-d34518` | `wtgui/retire-the-landed-clean-d34518` | 0 | landed (PR #411 MERGED at head) | release |
| 64 | `root-scan-chip` | `wtgui/root-scan-chip` | 0 | landed (PR #523 MERGED at head) | release |
| 65 | `route-the-24-stage-poc-b-245d89` | `wtgui/route-the-24-stage-poc-b-245d89` | 0 | landed (PR #450 MERGED at head) | release |
| 66 | `settle-v1-14-0-orphan-tag-94bbb4` | `wtgui/settle-v1-14-0-orphan-tag-94bbb4` | 0 | landed (ancestor of origin/main) | release |
| 67 | `show-the-newest-20-tasks-36faa6` | `wtgui/show-the-newest-20-tasks-36faa6` | 0 | landed (PR #486 MERGED at head) | release |
| 68 | `stage-1-of-2-the-drafter-8b0b20` | `wtgui/stage-1-of-2-the-drafter-8b0b20` | 0 | landed (PR #483 MERGED at head) | release |
| 69 | `staged-and-begin-where-y-856177` | `wtgui/staged-and-begin-where-y-856177` | 0 | landed (ancestor of origin/main) | release |
| 70 | `staged-and-use-your-pred-6e0df2` | `wtgui/staged-and-use-your-pred-6e0df2` | 0 | landed (ancestor of origin/main) | release |
| 71 | `staged-in-your-first-15-b741a0` | `wtgui/staged-in-your-first-15-b741a0` | 0 | landed (ancestor of origin/main) | release |
| 72 | `stop-the-panel-writing-i-8a9acc` | `wtgui/stop-the-panel-writing-i-8a9acc` | 0 | landed (PR #452 MERGED at head) | release |
| 73 | `swap-in-cheaper-promotion-detector-2-c96524` | `wtgui/swap-in-cheaper-promotion-detector-2-c96524` | 0 | landed (ancestor of origin/main) | release |
| 74 | `test-pipeline-driven-exe-4b4bd2` | `wtgui/land-pipeline-execution-round-4b4bd2` | 0 | landed (PR #429 MERGED at head) | release |
| 75 | `the-approval-card-expire-224646` | `wtgui/fix-approval-card-expiry-default-to-600s-224646` | 0 | landed (ancestor of origin/main) | release |
| 76 | `the-facts-to-design-agai-97bed3` | `wtgui/the-facts-to-design-agai-97bed3` | 0 | landed (ancestor of origin/main) | release |
| 77 | `the-panel-s-restart-spaw-d11d4c` | `wtgui/the-panel-s-restart-spaw-d11d4c` | 0 | landed (PR #506 MERGED at head) | release |
| 78 | `the-settings-pipeline-ta-792759` | `wtgui/the-settings-pipeline-ta-792759` | 0 | not landed (4 commits, 14/400 lines on main) | keep - live job, 4 unlanded commits in progress |
| 79 | `triage-and-land-the-unla-761334` | `wtgui/triage-and-land-the-unla-761334` | 0 | landed (PR #447 MERGED at head) | release |
| 80 | `triage-every-worktree-in-69d3ab` | `wtgui/triage-every-worktree-in-69d3ab` | 0 | landed (tree = origin/main) | land - this report |
| 81 | `unify-settings-and-queue-pipeline-source-a86e58` | `wtgui/unify-settings-and-queue-pipeline-source-a86e58` | 0 | landed (ancestor of origin/main) | release |
| 82 | `untrack-config-json-land-8e3f5a` | `wtgui/untrack-config-json-land-8e3f5a` | 0 | landed (PR #460 MERGED at head) | release |
| 83 | `watch-sr-and-dmr-tickets-6bd8ed` | `wtgui/watch-sr-and-dmr-tickets-6bd8ed` | 0 | landed (PR #478 MERGED at head) | release |
| 84 | `when-a-queue-line-lands-1b1ef5` | `wtgui/when-a-queue-line-lands-1b1ef5` | 0 | landed (tree = origin/main) | keep - live job |
## Kept - 7 rows, and the reason for each

- `agent-worktree-gui` - `main` - landed (tree = origin/main). keep - base checkout (5 untracked files, not a worktree row)
- `deep-dive-why-some-assis-e8cb2e` - `wtgui/deep-dive-why-some-assis-e8cb2e` - not landed (21/409 added lines on main). keep - PR #468 open and CONFLICTING
- `make-optym-integration-m-b580a2` - `wtgui/make-optym-integration-m-b580a2` - not landed (0/4 added lines on main). keep - PR #462 open
- `read-only-measured-inves-c0c3bf` - `wtgui/read-only-measured-inves-c0c3bf` - landed (ancestor of origin/main). keep - live job, one uncommitted report
- `the-settings-pipeline-ta-792759` - `wtgui/the-settings-pipeline-ta-792759` - not landed (4 commits, 14/400 lines on main). keep - live job, 4 unlanded commits in progress
- `triage-every-worktree-in-69d3ab` - `wtgui/triage-every-worktree-in-69d3ab` - landed (tree = origin/main). land - this report
- `when-a-queue-line-lands-1b1ef5` - `wtgui/when-a-queue-line-lands-1b1ef5` - landed (tree = origin/main). keep - live job

## The dirty trees, one by one

Four trees were known dirty before this pass and two more were found dirty during it. Each was read
before anything was moved; none was discarded without its content being named.

- **`build-hard-restart-control-in-assistant-fb353f`** (10 dirty files): 291 insertions and 17 deletions
  across 8 tracked files, plus two new files, `test/assistant-hard-restart.test.js` and
  `tools/verify-assistant-hard-restart.mjs`. It is a per-assistant **Hard restart** control: the first
  press only arms, the second moves that one assistant to a fresh Hermes thread (the old thread is kept
  in `previousThreads` so its turns stay attributed to it), and the route answers 409 while a turn is
  running. Nothing else is cleared, and the panel and gateway are not restarted. main carried none of
  it - `git grep -i "hard restart" origin/main -- lib public test tools` printed nothing - so the feature
  was still needed. It was committed on its branch, rebased onto main (two conflicts: the import line
  and the docs section next to `Renaming an assistant`, both resolved by keeping both sides), and landed
  as **PR #531**, merge `82794b0`, version **1.52.0**. Then the tree was released.
- **`research-how-to-stop-par-fa30aa`** (2 dirty files): `tools/version.mjs` +377/-37 and a new
  `test/version-claim.test.js`, implementing the claim the design doc on main recommends
  (`docs/research/version-integrity/parallel-lanes-and-one-version.md`, landed by PR #463): `apply`
  pushes `refs/tags/v<version>`, and a rejected push means the number is taken, so the tool re-derives
  the next free one and re-bumps. `tools/version.mjs` had **zero** drift between that tree's HEAD and
  `origin/main`, so the work belonged on current main rather than on its 156-commits-behind base. It was
  committed on its branch and landed as **PR #529**, merge `cef36be`, version **1.51.0**. Then the tree
  was released.
- **`cut-the-append-tax-in-li-90bfcf`** (5 dirty files): its committed commit `8aace69` is a duplicate
  of **landed #513** - 29 of its 29 added lines are on main. The 5 dirty files are a second, superseded
  iteration of the same feature (91 of 99 added lines were absent from main). WIP-committed on its
  branch so the iteration survives with a commit that says it is superseded, then the tree was
  released. It was not landed a second time.
- **`lane-b-tags-hyper-deep-r-061613`** (1 dirty file): an untracked 44,629-byte research document,
  `docs/research/version-integrity/B-tags.md`, absent from main - main's version-integrity sweep
  carries lanes A and C through H, not B. Consolidated verbatim into
  `docs/reports/version-integrity-B-tags-2026-11-06.md`, proved with `cmp -s` against the source, then
  the tree was released.
- **`agent-worktree-gui`** (the primary checkout, 5 dirty files): all untracked - `.kilo/`,
  `CODE_REVIEW.md`, `config.7330.json`, `docs/architecture.html` and
  `docs/reviews/settings-pipeline-flow-2026-11-05.local-keep.html`. They are another run's artifacts and
  a machine-local config; the base checkout is not a worktree row this pass may remove, so it is kept
  and its files are untouched.
- **`read-only-measured-inves-c0c3bf`** (1 dirty file): `docs/console-memory-growth.md`, uncommitted,
  with a **live job** in the tree. Left alone.

## Released - 77 rows

Each row below was landed by one of the four proofs above and had `git status --porcelain` print
nothing at the moment it was removed, with no live job and no reader lock. Removal went through the
panel's own `POST /api/worktree/delete`, which unlinks the tree's junctions before sending the folder to
the Recycle Bin and then prunes git's record; a bare `git worktree remove` recurses through this repo's
`node_modules` junctions and is how a checkout loses its dependencies. Local branches are deliberately
left in place: this pass releases TREES, and a `wtgui/*` branch costs nothing while its PR record is
still the only thing that can explain it.

- `a-probe-timeout-must-not-fa31f1`
- `a-repair-turn-must-not-c-aa2953`
- `a-stage-run-must-not-be-436070`
- `audit-the-panel-s-token-4e0755`
- `auto-fold-turns-when-the-206e6d`
- `both-research-docs-are-c-e5b018`
- `build-a-per-remote-allow-fb5a95`
- `build-hard-restart-control-in-assistant-fb353f`
- `build-the-fan-out-model-4bb90b`
- `critique-a-plan-before-a-93004d`
- `cut-the-append-tax-in-li-90bfcf`
- `design-how-a-pipelined-t-0a90d5`
- `fix-orphan-version-tags-after-landing-077934`
- `fix-the-older-assistant-5583f9`
- `fix-the-push-settings-wr-161f16`
- `fix-the-two-driver-defec-72dda4`
- `fix-thinking-toggle-replaying-history-in-6572d2`
- `front-end-cpu-and-time-w-cd92cd`
- `front-end-memory-and-lay-8087e5`
- `gate-the-old-tier-so-it-f280f8`
- `group-the-assistant-floa-a626f2`
- `hey-get-me-some-screensh-b7a6e6`
- `hold-a-pipeline-row-on-i-04c7d1`
- `in-public-index-html-giv-f01e4b`
- `investigate-why-the-vers-b490d8`
- `land-pr-359-and-render-t-0e6a57`
- `lane-a-the-version-numbe-505c4c`
- `lane-b-tags-hyper-deep-r-061613`
- `lane-c-the-changelog-and-9b0017`
- `lane-d-forensics-mine-th-79d3e5`
- `lane-e-our-own-automatio-264523`
- `lane-f-the-gates-what-th-148f76`
- `lane-g-outside-designs-h-e062a6`
- `lane-h-the-instructions-382eb3`
- `let-each-assistant-be-re-b279a4`
- `let-the-panel-import-an-925c4b`
- `let-the-settings-name-th-bc17b2`
- `link-the-mermaid-pipelin-e2fc16`
- `make-a-clarify-answer-to-64120f`
- `make-a-settled-stage-adv-909918`
- `make-a-stopped-worker-as-97a3b4`
- `make-the-deliverables-po-6815d2`
- `make-the-exited-chip-re-abc44e`
- `move-the-two-per-project-9ccc15`
- `no-boot-promotion`
- `on-a-200-open-handler-an-8f730c`
- `parked-counts-fleet`
- `pin-each-stage-s-handoff-1ff446`
- `ping-pong-round-5-draft-9f2c41`
- `put-the-primary-checkout-0c0f9b`
- `raise-the-matrix-bridge-3b5d6b`
- `re-render-the-pipeline-m-3d0771`
- `read-only-deep-performan-337338`
- `read-only-diagnosis-of-t-0b803b`
- `render-every-panel-pipel-720c84`
- `replace-the-push-permiss-588511`
- `research-how-to-stop-par-fa30aa`
- `restore-the-primary-chec-83b67e`
- `retire-the-landed-clean-d34518`
- `root-scan-chip`
- `route-the-24-stage-poc-b-245d89`
- `settle-v1-14-0-orphan-tag-94bbb4`
- `show-the-newest-20-tasks-36faa6`
- `stage-1-of-2-the-drafter-8b0b20`
- `staged-and-begin-where-y-856177`
- `staged-and-use-your-pred-6e0df2`
- `staged-in-your-first-15-b741a0`
- `stop-the-panel-writing-i-8a9acc`
- `swap-in-cheaper-promotion-detector-2-c96524`
- `test-pipeline-driven-exe-4b4bd2`
- `the-approval-card-expire-224646`
- `the-facts-to-design-agai-97bed3`
- `the-panel-s-restart-spaw-d11d4c`
- `triage-and-land-the-unla-761334`
- `unify-settings-and-queue-pipeline-source-a86e58`
- `untrack-config-json-land-8e3f5a`
- `watch-sr-and-dmr-tickets-6bd8ed`

## The two feature landings

Both trees carried their feature as UNCOMMITTED work on a branch whose tip was already an ancestor of
main, so the branch said "landed" and the working tree held the feature. Each was committed on its own
branch, rebased onto main, pushed, and merged with `gh pr merge --rebase --admin`; each version tag was
then moved onto the merge commit main carries, because a rebase merge re-creates the bump commit.

| tree | branch | PR | merge commit | version | proof |
|---|---|---|---|---|---|
| `build-hard-restart-control-in-assistant-fb353f` | `wtgui/build-hard-restart-control-in-assistant-fb353f` | #531 | `82794b0` | 1.52.0 | 6/6 unit cases; 40/40 browser-gate checks |
| `research-how-to-stop-par-fa30aa` | `wtgui/research-how-to-stop-par-fa30aa` | #529 | `cef36be` | 1.51.0 | 4/4 claim-race cases |

Two things had to move for #531 beyond the rebase's two conflicts, and both are in the branch's own
history: `main` now splits a turn's briefing into a standing half sent as the run's SYSTEM text (the
charter, the rules, the board) and a turn half (`preamble`) that carries only the queue digest, so the
one assertion that read the charter off `preamble` reads `system`; and the fixture's own number is
anchored the way a real repository anchors it.

#529 needed three fixture corrections for the same reason - it was written against a base 156 commits
behind - and they are in their own commit: the sandbox seed tags the number it declares, the render case
compares the remote's tag set before and after instead of asserting a repository has none, and the
held-claim count is asserted by name rather than as a bare `2`.

## Verification

Measured with the commands the table's columns name, run from the primary checkout:

```
$ git worktree list | wc -l                       # 84
$ ls -d .worktrees/*/ | wc -l                     # 119 (36 unregistered husks, no .git file)
$ gh pr list --state all --limit 600 --json headRefOid,state,number
$ git merge-base --is-ancestor <head> origin/main  # per tree, the ancestor proof
$ git cherry origin/main <head>                    # patch equality, per tree
$ git status --porcelain                            # per tree, dirty count and names
$ curl -s http://127.0.0.1:7331/api/jobs            # live cwd, per tree
```

The proof each row rests on is written in its "on main" cell, so a reader can re-run one row without
re-running the pass. Every `release` row was re-checked at the moment of removal - `git status
--porcelain` empty, no live job whose `cwd` is that tree, no reader lock - because a tree can gain a
file or a job between the measurement and the removal, and the per-row re-check is what catches it.

### The board after the pass

`git worktree list` read **7** lines once the removals finished: the primary checkout and six task
trees - this one, `lane-b-tags-hyper-deep-r-061613` (released after its document was on origin),
`deep-dive-why-some-assis-e8cb2e` and `make-optym-integration-m-b580a2` (open PRs #468 and #462),
`the-settings-pipeline-ta-792759` (a live job with four unlanded commits) and
`on-main-there-is-no-cach-462a35` (cut during the pass, live). The board is live, so the register keeps
moving after the pass: two rows this pass had kept for live jobs
(`when-a-queue-line-lands-1b1ef5` and `read-only-measured-inves-c0c3bf`) were released by their OWN jobs
when those runs finished, and `when-a-queue-line-lands` landed as PR #527 on the way through.

## Landing note

This is a documentation-only land: one new report and one consolidated research document under `docs/`.
The pre-push version gate refuses a branch that carries commits at the base's number, so the patch
level moves in the same commit and main's number is not moved backwards. Nothing under `lib/`,
`public/`, `server.js` or `test/` changes in this PR. The two feature landings are separate PRs from
their own trees, and their numbers and merge oids are recorded above rather than in this branch's
product code.
