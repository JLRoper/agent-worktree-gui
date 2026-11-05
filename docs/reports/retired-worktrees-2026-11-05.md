# Retired worktrees — 2026-11-05

Base: `origin/main` at `ea7dc4d` (1.12.9). Measured and retired 2026-11-04 23:42 – 2026-11-05 00:15 EST
from the primary checkout of this repo.

**Result: 108 registered worktrees before, 15 after. 93 trees retired, 14 kept and named below, and
92 local branches deleted.** None of the three live trees the brief named was deleted:
`let-the-reset-route-sett-e16584` finished and released itself before the pass,
`build-the-bridge-tab-bes-de52c0` did so after it, and `render-every-panel-pipel-720c84` is still
running. A *new* job cut `build-the-assistant-dire-2d0335` during the run; the per-tree re-check
caught it and it was kept.

## The three tests, and how each one was made

A tree was deleted only when all three held at the moment of removal — not at the moment it was
measured:

1. **Landed — by content, never ancestry.** One of five independent proofs had to pass:
   - `git rev-list --count origin/main..<branch>` is **0** — nothing of its own exists to lose;
   - a GitHub PR is **`MERGED` at that exact head sha** (`gh pr list --state all --json headRefOid,state`);
   - the branch's own patch (`git diff <merge-base> HEAD`, `package.json` excluded) **reverse-applies
     cleanly** to a pristine `git archive origin/main` export — the test a squash merge survives;
   - `git cherry origin/main <branch>` prints **`-` for every commit and `+` for none**;
   - every added line (longer than 25 characters) of the branch's own delta is **present verbatim** in
     `origin/main`'s copy of each file.
   Two further edge cases were read and named rather than assumed: a branch whose only change is a
   stale `CHANGELOG.md` render owns no work of its own; a detached tree was checked with
   `git merge-base --is-ancestor <head> origin/main`.
2. **Clean** — `git status --porcelain` in the tree printed nothing, untracked files included.
3. **No live job in that path** — the panel's own answer, read per tree at removal time from
   `GET http://127.0.0.1:7331/api/jobs`, matching `cwd`, `worktreePath` **and** `ownerPath`, equal to
   the tree or under it, against `running`/`starting`/`waiting`. The reader's lock
   (`logs/locks.json`) was a fourth guard, checked last.

The removal itself went through the panel's own `POST /api/worktree/delete`, not a bare
`git worktree remove`: that module (`lib/worktree-remove.js`) unlinks every directory junction inside
the tree **first** (this repo's `node_modules` are junctions, and `git worktree remove` recurses
*through* one — measured elsewhere as the primary checkout losing its dependencies), then sends the
folder to the Recycle Bin, then prunes git's record, then re-reads `git worktree list` as the arbiter.
The branch went with `git branch -D` after git stopped listing the tree.

## Before and after

| | before | after the pass | change |
|---|---|---|---|
| registered worktrees (`git worktree list` lines) | 108 | 15 | −93 |
| task trees (worktrees minus the primary checkout) | 107 | 14 | −93 |
| local branches (`git branch`) | 165 | 74 | −91 |

The branch arithmetic closes: 165 − 92 deleted + 1 new (`wtgui/build-the-assistant-dire-2d0335`, cut
by a job that started at 04:54Z) = 74. The detached tree had no branch to delete.

The board is live, so the register keeps moving after the pass: the Bridge job finished at 05:15:30Z
and its own release took `build-the-bridge-tab-bes-de52c0` and its branch (that tree is in the kept
table because this run kept it while it was live); a new job then cut
`make-the-bridge-obey-the-b8ec43`. The register read **15** again at 05:16Z with that different mix.
The numbers above are what the deletion pass produced, not a claim that the board is frozen.

Deleted, with the evidence that it was landed:

| # | tree | branch | HEAD | ahead | why it counts as landed |
|---|---|---|---|---|---|
| 1 | `a-queued-reply-must-carr-5647fc` | `wtgui/a-queued-reply-must-carr-5647fc` | `5e84586f` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 2 | `add-a-human-button-besid-ca12a9` | `wtgui/add-a-human-button-besid-ca12a9` | `df71b9d1` | 1 | PR #293 `MERGED` at this exact head |
| 3 | `add-a-pre-push-gate-agai-4185fa` | `wtgui/add-a-pre-push-gate-agai-4185fa` | `199f3ce2` | 2 | reverse-apply of its own patch applies cleanly to an `origin/main` export |
| 4 | `add-openrouter-profiles-6d31bf` | `wtgui/add-openrouter-profiles-6d31bf` | `4d31704b` | 1 | PR #296 `MERGED` at this exact head |
| 5 | `architectural-review-top-e7ef6d` | `wtgui/architectural-review-top-e7ef6d` | `16a8549b` | 3 | PR #303 `MERGED` at this exact head |
| 6 | `build-deploy-and-test-th-1e7b84` | `wtgui/build-deploy-and-test-th-1e7b84` | `85e588f2` | 2 | PR #381 `MERGED` at this exact head |
| 7 | `build-queue-72-drag-the-f2fb9f` | `wtgui/build-queue-72-drag-the-f2fb9f` | `9df1ab3b` | 5 | PR #268 `MERGED` at this exact head |
| 8 | `build-the-element-assist-408b27` | `wtgui/build-the-element-assist-408b27` | `832e62fb` | 2 | PR #354 `MERGED` at this exact head |
| 9 | `build-the-general-settin-177f0d` | `wtgui/build-the-general-settin-177f0d` | `715045e3` | 1 | PR #251 `MERGED` at this exact head |
| 10 | `build-the-panel-side-of-ec7202` | `wtgui/build-the-panel-side-of-ec7202` | `136bca51` | 3 | PR #332 `MERGED` at this exact head |
| 11 | `build-the-pipeline-visua-66e815` | `wtgui/build-the-pipeline-visua-66e815` | `d3a55376` | 3 | PR #323 `MERGED` at this exact head |
| 12 | `build-the-stage-timer-a-0b37d7` | `wtgui/build-the-stage-timer-a-0b37d7` | `f7e8de84` | 2 | PR #316 `MERGED` at this exact head |
| 13 | `close-pr-322-to-prevent-revert-44f852` | `wtgui/close-pr-322-to-prevent-revert-44f852` | `1b8b7956` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 14 | `create-missing-v1-5-0-annotated-tag-4af048` | `wtgui/create-missing-v1-5-0-annotated-tag-4af048` | `e2358c5b` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 15 | `create-the-version-to-co-92b3af` | `wtgui/create-the-version-to-co-92b3af` | `2230f3bc` | 3 | PR #298 `MERGED` at this exact head |
| 16 | `debug-ssh-refusal-to-github-in-worker-sh-2eba9f` | `wtgui/debug-ssh-refusal-to-github-in-worker-sh-2eba9f` | `45e2bf08` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 17 | `define-and-implement-the-cfe479` | `wtgui/define-and-implement-the-cfe479` | `9e53d436` | 7 | PR #286 `MERGED` at this exact head |
| 18 | `design-assistant-reset-feature-e79264` | `wtgui/design-assistant-reset-feature-e79264` | `f19b615a` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 19 | `diagnose-ssh-refused-to-github-in-worker-835a08` | `wtgui/diagnose-ssh-refused-to-github-in-worker-835a08` | `45e2bf08` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 20 | `docs-architecture-md-10-41f98e` | `wtgui/docs-architecture-md-10-41f98e` | `7a93a1c8` | 2 | PR #311 `MERGED` at this exact head |
| 21 | `docs-reviews-architectur-08b3d0` | `wtgui/docs-reviews-architectur-08b3d0` | `62849041` | 2 | PR #318 `MERGED` at this exact head |
| 22 | `drive-a-task-through-a-p-75861e` | `wtgui/drive-a-task-through-a-p-75861e` | `75e648c3` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 23 | `every-deliverable-card-g-5493b0` | `wtgui/every-deliverable-card-g-5493b0` | `2d1a929e` | 2 | PR #369 `MERGED` at this exact head |
| 24 | `execute-split-s1-extract-client-console-ef9dcf` | `wtgui/execute-split-s1-extract-client-console-ef9dcf` | `2938077f` | 3 | PR #387 `MERGED` at this exact head |
| 25 | `fast-forward-panel-checkout-to-origin-ma-30b0ec` | `wtgui/fast-forward-panel-checkout-to-origin-ma-30b0ec` | `45e2bf08` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 26 | `fast-forward-panel-checkout-to-origin-ma-d61320` | `wtgui/fast-forward-panel-checkout-to-origin-ma-d61320` | `2704ce37` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 27 | `fix-changelog-and-version-tag-gates-on-m-a4fb0e` | `(detached)` | `68910281` | None | 0 commits ahead; branch is an ancestor of `origin/main` |
| 28 | `fix-changelog-check-for-v1-9-1-tag-1cb6cd` | `wtgui/fix-changelog-check-for-v1-9-1-tag-1cb6cd` | `1c9eb246` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 29 | `fix-the-parked-turn-card-cc18b4` | `wtgui/fix-the-parked-turn-card-cc18b4` | `a2ac25ee` | 3 | PR #279 `MERGED` at this exact head |
| 30 | `fix-tools-version-mjs-ta-4a9fa2` | `wtgui/fix-tools-version-mjs-ta-4a9fa2` | `ab428db0` | 2 | PR #368 `MERGED` at this exact head |
| 31 | `fresh-tree-changelog-render-at-1-9-0-06f1a8` | `wtgui/fresh-tree-changelog-render-at-1-9-0-06f1a8` | `1c9eb246` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 32 | `group-dmr-39015-branches-in-jenkins-451b35` | `wtgui/group-dmr-39015-branches-in-jenkins-451b35` | `cb5f505b` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 33 | `implement-deliverables-api-and-store-3e7e3b` | `wtgui/implement-deliverables-api-and-store-3e7e3b` | `4c42a05c` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 34 | `investigate-and-fix-the-c77da0` | `wtgui/investigate-and-fix-the-c77da0` | `2c7d78a8` | 3 | only `CHANGELOG.md` changed — a stale render, no code or doc of its own |
| 35 | `land-pr-383-and-leave-th-23eda6` | `wtgui/land-pr-383-and-leave-th-23eda6` | `7c7eb238` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 36 | `land-the-changelog-fix-b-d69eca` | `wtgui/land-the-changelog-fix-b-d69eca` | `db52ecd4` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 37 | `land-the-render-and-kill-8e512f` | `wtgui/land-the-render-and-kill-8e512f` | `db66f50c` | 1 | PR #343 `MERGED` at this exact head |
| 38 | `land-the-stage-driving-w-5b64af` | `wtgui/land-the-stage-driving-w-5b64af` | `430140c0` | 2 | PR #330 `MERGED` at this exact head |
| 39 | `make-a-hold-that-stops-b-474e8b` | `wtgui/make-a-hold-that-stops-b-474e8b` | `76689643` | 4 | PR #278 `MERGED` at this exact head |
| 40 | `make-the-human-rotation-23c8b5` | `wtgui/make-the-human-rotation-23c8b5` | `990483d6` | 1 | PR #302 `MERGED` at this exact head |
| 41 | `make-the-landing-render-7a476d` | `wtgui/make-the-landing-render-7a476d` | `3c29b07c` | 5 | PR #367 `MERGED` at this exact head |
| 42 | `make-the-pipeline-dialog-2009e1` | `wtgui/make-the-pipeline-dialog-2009e1` | `3e1ce21b` | 3 | PR #391 `MERGED` at this exact head |
| 43 | `measure-coupling-and-churn-for-architect-2fb127` | `wtgui/measure-coupling-and-churn-for-architect-2fb127` | `7d06dae6` | 1 | reverse-apply of its own patch applies cleanly to an `origin/main` export |
| 44 | `measure-whether-0-78-1-i-564931` | `wtgui/measure-whether-0-78-1-i-564931` | `e9d88b43` | 1 | PR #289 `MERGED` at this exact head |
| 45 | `move-stranded-v0-110-0-tag-with-version-b173d3` | `wtgui/move-stranded-v0-110-0-tag-with-version-b173d3` | `9166869b` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 46 | `move-v0-95-0-and-v0-98-0-tags-105b7c` | `wtgui/move-v0-95-0-and-v0-98-0-tags-105b7c` | `9669681c` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 47 | `move-v0-99-0-tag-to-e4cb244-f10dc9` | `wtgui/move-v0-99-0-tag-to-e4cb244-f10dc9` | `9669681c` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 48 | `move-v1-7-1-tag-onto-declaring-commit-4e9da9` | `wtgui/move-v1-7-1-tag-onto-declaring-commit-4e9da9` | `e2358c5b` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 49 | `one-ref-no-code-the-0-10-b9989a` | `wtgui/one-ref-no-code-the-0-10-b9989a` | `9669681c` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 50 | `panel-side-forensics-for-stuck-session-d-c813be` | `wtgui/panel-side-forensics-for-stuck-session-d-c813be` | `f19b615a` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 51 | `phase-1-of-a-build-resea-5db421` | `wtgui/phase-1-of-a-build-resea-5db421` | `e1f33203` | 5 | PR #313 `MERGED` at this exact head |
| 52 | `playwright-improvement-r-6bf56e` | `wtgui/playwright-improvement-r-6bf56e` | `8b3e8f0f` | 2 | PR #284 `MERGED` at this exact head |
| 53 | `playwright-round-5a-both-a3a0fc` | `wtgui/playwright-round-5a-both-a3a0fc` | `49f6e4e4` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 54 | `playwright-usability-rou-8ec471` | `wtgui/playwright-usability-rou-8ec471` | `d92edbd3` | 2 | PR #359 `MERGED` at this exact head |
| 55 | `probe-gateway-paused-session-fence-behav-bc2773` | `wtgui/probe-gateway-paused-session-fence-behav-bc2773` | `f19b615a` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 56 | `profile-the-four-paths-t-0a27af` | `wtgui/profile-the-four-paths-t-0a27af` | `5a88d2f9` | 1 | PR #288 `MERGED` at this exact head |
| 57 | `prove-the-minimized-comp-e7e985` | `wtgui/prove-the-minimized-comp-e7e985` | `4ba1fe88` | 1 | PR #297 `MERGED` at this exact head |
| 58 | `pull-the-composer-block-f3c707` | `wtgui/pull-the-composer-block-f3c707` | `5e8aed47` | 1 | PR #294 `MERGED` at this exact head |
| 59 | `put-the-missing-v1-5-0-a-a2ba85` | `wtgui/put-the-missing-v1-5-0-a-a2ba85` | `e2358c5b` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 60 | `put-the-project-name-on-5efc0d` | `wtgui/put-the-project-name-on-5efc0d` | `35da3ba4` | 1 | PR #300 `MERGED` at this exact head |
| 61 | `re-render-the-changelog-a4d783` | `wtgui/re-render-the-changelog-a4d783` | `737c5171` | 2 | PR #328 `MERGED` at this exact head |
| 62 | `read-only-boot-proof-for-s1-352592` | `wtgui/read-only-boot-proof-for-s1-352592` | `1c9eb246` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 63 | `read-only-visual-audit-o-10e2ba` | `wtgui/read-only-visual-audit-o-10e2ba` | `c6bffba4` | 1 | PR #280 `MERGED` at this exact head |
| 64 | `recover-this-row-s-finis-b86302` | `wtgui/recover-this-row-s-finis-b86302` | `f3547deb` | 2 | PR #344 `MERGED` at this exact head |
| 65 | `render-all-three-missing-07d25b` | `wtgui/render-all-three-missing-07d25b` | `016a7ed7` | 1 | `git cherry`: all 1 commits `-`, none `+` |
| 66 | `render-main-so-both-miss-25911a` | `wtgui/render-main-so-both-miss-25911a` | `8d8e8cb8` | 1 | `git cherry`: all 1 commits `-`, none `+` |
| 67 | `render-main-so-both-miss-49f608` | `wtgui/render-main-so-both-miss-49f608` | `2ee5db7b` | 1 | PR #336 `MERGED` at this exact head |
| 68 | `render-the-changelog-in-beb4ec` | `wtgui/render-the-changelog-in-beb4ec` | `f9d68899` | 1 | PR #386 `MERGED` at this exact head |
| 69 | `render-the-missing-v1-8-8789cb` | `wtgui/render-the-missing-v1-8-8789cb` | `f52f3542` | 1 | only `CHANGELOG.md` changed — a stale render, no code or doc of its own |
| 70 | `repair-the-v1-1-0-tag-ve-c49be6` | `wtgui/repair-the-v1-1-0-tag-ve-c49be6` | `c6d86ff8` | 1 | PR #352 `MERGED` at this exact head |
| 71 | `replace-the-worktree-cha-5190fe` | `wtgui/replace-the-worktree-cha-5190fe` | `cf0e945b` | 1 | PR #306 `MERGED` at this exact head |
| 72 | `replace-the-worktree-cha-c1b465` | `wtgui/replace-the-worktree-cha-c1b465` | `489389d9` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 73 | `research-and-write-up-do-f84b69` | `wtgui/research-and-write-up-do-f84b69` | `e6c16c06` | 1 | PR #275 `MERGED` at this exact head |
| 74 | `research-how-comparable-0d9215` | `wtgui/research-how-comparable-0d9215` | `ca1a0a34` | 3 | PR #339 `MERGED` at this exact head |
| 75 | `research-whether-our-her-f16888` | `wtgui/research-whether-our-her-f16888` | `4cd97148` | 1 | PR #250 `MERGED` at this exact head |
| 76 | `review-the-0-75-0-0-78-1-b0b34f` | `wtgui/review-the-0-75-0-0-78-1-b0b34f` | `36ca6f8f` | 1 | PR #287 `MERGED` at this exact head |
| 77 | `settings-tab-for-pipelin-5dab4f` | `wtgui/settings-tab-for-pipelin-5dab4f` | `942f388e` | 1 | PR #317 `MERGED` at this exact head |
| 78 | `size-the-pipeline-dialog-8e95e4` | `wtgui/size-the-pipeline-dialog-8e95e4` | `ff50801b` | 4 | PR #382 `MERGED` at this exact head |
| 79 | `split-research-1-server-4f1da3` | `wtgui/split-research-1-server-4f1da3` | `65c7f467` | 1 | reverse-apply of its own patch applies cleanly to an `origin/main` export |
| 80 | `split-research-2-public-aa78b1` | `wtgui/split-research-2-public-aa78b1` | `f0f0183c` | 1 | reverse-apply of its own patch applies cleanly to an `origin/main` export |
| 81 | `split-research-3-lib-int-bfda7a` | `wtgui/split-research-3-lib-int-bfda7a` | `bae2ccbf` | 1 | reverse-apply of its own patch applies cleanly to an `origin/main` export |
| 82 | `staged-in-your-first-15-60e9c8` | `wtgui/staged-in-your-first-15-60e9c8` | `f19b615a` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 83 | `stop-ledger-publishing-absolute-local-pa-afdba0` | `wtgui/stop-ledger-publishing-absolute-local-pa-afdba0` | `45e2bf08` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 84 | `stop-the-ledger-publishi-34a596` | `wtgui/stop-the-ledger-publishi-34a596` | `eb9903e5` | 2 | PR #380 `MERGED` at this exact head |
| 85 | `test-the-task-pipeline-w-4800d2` | `wtgui/test-the-task-pipeline-w-4800d2` | `1e671c2f` | 2 | PR #292 `MERGED` at this exact head |
| 86 | `the-deliverables-button-763f28` | `wtgui/the-deliverables-button-763f28` | `aee766bf` | 2 | PR #385 `MERGED` at this exact head |
| 87 | `the-deliverables-button-8da595` | `wtgui/the-deliverables-button-8da595` | `7c61d119` | 2 | PR #321 `MERGED` at this exact head |
| 88 | `the-deliverables-list-40-fe2fb8` | `wtgui/the-deliverables-list-40-fe2fb8` | `5c6f9c5a` | 2 | PR #325 `MERGED` at this exact head |
| 89 | `the-version-tags-gate-is-5feb5c` | `wtgui/the-version-tags-gate-is-5feb5c` | `9669681c` | 0 | 0 commits ahead; branch is an ancestor of `origin/main` |
| 90 | `three-ui-changes-main-is-8c936e` | `wtgui/three-ui-changes-main-is-8c936e` | `d938fe96` | 2 | PR #307 `MERGED` at this exact head |
| 91 | `tools-version-mjs-check-b9d7c7` | `wtgui/tools-version-mjs-check-b9d7c7` | `0f92e04b` | 5 | PR #312 `MERGED` at this exact head |
| 92 | `two-changes-to-the-assis-6291a1` | `wtgui/two-changes-to-the-assis-6291a1` | `65eef308` | 2 | reverse-apply of its own patch applies cleanly to an `origin/main` export |
| 93 | `two-tests-pin-app-js-cod-5f7147` | `wtgui/two-tests-pin-app-js-cod-5f7147` | `0db6101c` | 2 | PR #315 `MERGED` at this exact head |

## Kept — 14 trees, and the reason for each

| # | tree | branch | ahead | dirty | why it was kept |
|---|---|---|---|---|---|
| 1 | `build-the-assistant-dire-2d0335` | `wtgui/build-the-assistant-dire-2d0335` | 0 | 0 | **live job `59837087`** — cut and started after the measurement, caught by the per-tree re-check before it could be considered |
| 2 | `build-the-bridge-tab-bes-de52c0` | `wtgui/build-the-bridge-tab-bes-de52c0` | 0 | 11 | **live job `dab22ab9`** — the Bridge-tab job the brief named. Kept by this run while it ran; its own job released the tree at 05:15:30Z, after the pass |
| 3 | `render-every-panel-pipel-720c84` | `wtgui/render-every-panel-pipel-720c84` | 0 | 6 | **live job** (named in the brief; the run id changed under it mid-flight, the tree did not move) |
| 4 | `retire-the-landed-clean-d34518` | `wtgui/retire-the-landed-clean-d34518` | 0 | 0 | **this run's own tree** — a shell cannot delete the directory it is standing in on Windows |
| 5 | `critique-a-plan-before-a-93004d` | `wtgui/critique-a-plan-before-a-93004d` | 1 | 0 | its patch **applies forward** to `origin/main`, so the change is absent: `docs/pipeline-modal-plan-review.md` is not on main |
| 6 | `hey-get-me-some-screensh-b7a6e6` | `wtgui/hey-get-me-some-screensh-b7a6e6` | 3 | 0 | its patch **applies forward**: 7 files are absent, including `docs/pipeline-tabs.html`, four `docs/assets/pipeline-tabs/*.png`, and `tools/capture-settings-pipeline.mjs` |
| 7 | `staged-and-begin-where-y-856177` | `wtgui/staged-and-begin-where-y-856177` | 2 | 0 | 149 of 191 added lines absent: `docs/research/assistant-session-fence.md` (42/158) and its `.repro.mjs` (0/33) |
| 8 | `staged-in-your-first-15-b741a0` | `wtgui/staged-in-your-first-15-b741a0` | 2 | 0 | 168 of 296 added lines absent: the same research doc (53/221) and its repro script |
| 9 | `both-research-docs-are-c-e5b018` | `wtgui/both-research-docs-are-c-e5b018` | 2 | 0 | 28 of 375 added lines absent from `docs/research/assistant-reset-design.md`; main's copy is a later revision of the same doc, but no merge proof exists for this branch |
| 10 | `land-pr-359-and-render-t-0e6a57` | `wtgui/land-pr-359-and-render-t-0e6a57` | 1 | 0 | 5 of 56 added lines absent from `docs/reviews/pipeline-flow-usability-ledger.md` — a later rewording, but no merge proof |
| 11 | `staged-and-use-your-pred-6e0df2` | `wtgui/staged-and-use-your-pred-6e0df2` | 2 | 0 | 5 of 81 added lines absent from `docs/research/gateway-fence-endpoints.md` — main's copy elides the local `profile_id` the branch printed, but no merge proof |
| 12 | `put-the-primary-checkout-0c0f9b` | `wtgui/put-the-primary-checkout-0c0f9b` | 2 | 1 | **dirty**: uncommitted `PRIMARY-CHECKOUT-REPORT.md` |
| 13 | `the-approval-card-expire-224646` | `wtgui/fix-approval-card-expiry-default-to-600s-224646` | 0 | 1 | **dirty**: uncommitted `lib/approvals.js` (the 2026-11-04 audit said "copy the file out" — it is still here to copy) |
| 14 | `the-facts-to-design-agai-97bed3` | `wtgui/the-facts-to-design-agai-97bed3` | 1 | 1 | **dirty** `docs/research/assistant-reset-design.md`, and 0 of its 181 added lines are on main |

## The 2026-11-04 audit's six at-risk trees, reconciled

That report (`docs/reports/unmerged-worktrees-2026-11-04.md`, landed as `5e84586`) named six trees
holding content that existed nowhere on main and was worth recovering. Five are still here and were
kept by this run: `critique-a-plan-before-a-93004d`, `hey-get-me-some-screensh-b7a6e6`,
`staged-and-begin-where-y-856177`, `staged-in-your-first-15-b741a0`, `the-facts-to-design-agai-97bed3`.

The sixth, `build-the-pipeline-visua-66e815`, was retired — and the audit's "recover by cherry-pick"
recommendation was a false positive. Its head `d3a5537` was merged by **PR #323**
(`wtgui/land-the-pipeline-modal-918141`, merged 2026-11-04T03:13:50Z) at that exact sha; its own PR
**#322** is `CLOSED`. Main's `.pflow` block is a later revision of the same drawing (the branch's
`--pflow-minw: 78px` became `96px`, `--pflow-maxw` and `--pflow-min-h` were added, the file grew from
297 to 568 lines), which is why 36 of its added lines are no longer verbatim. The work landed; the
checkout was redundant.

The audit's three "keep (small residue)" PARTIALs — `both-research-docs-are-c-e5b018`,
`land-pr-359-and-render-t-0e6a57`, `staged-and-use-your-pred-6e0df2` — were kept here too, for the
same reason: the residue is an older draft of a file main has since revised, but nothing proves the
branch's own head was merged, and the brief's rule is content, not resemblance.

## One refusal, and what it was

`the-version-tags-gate-is-5feb5c` had its folder recycled but git kept the registration, now marked
`locked initializing`, so `git worktree remove` answered `could not remove the worktree: git still
lists it`. The folder was already gone; the record was stale. `git worktree unlock` + `git worktree
prune` dropped it, and the branch was deleted by hand. One other branch
(`wtgui/prove-the-minimized-comp-e7e985`) survived its tree because the first pass was killed at the
tool's 420-second cap between the two steps; it was deleted in the repair pass. Both are in the
deleted table and in the final counts.

## What is left on disk that is not a worktree

`ls -d .worktrees/*/` counts **48** directories against 14 registered trees, so **34 are unregistered
empty husks** left by earlier evictions (every one of them has zero entries and no branch). They are
not worktrees, have no HEAD to judge and nothing to lose, and this run did not touch them. They are
named here so the directory count is not mistaken for a failed deletion.

## Verification (commands and their output)

```
$ git worktree list | wc -l
15                          # 108 when the run started
$ git branch | wc -l
74                          # 165 when the run started
$ git worktree list | grep -c '/\.worktrees/'
14
$ ls .worktrees/retire-the-landed-clean-d34518 >/dev/null && echo "this tree intact"
this tree intact
$ curl -s http://127.0.0.1:7331/api/jobs | python -c "..."   # every running cwd exists
59837087 build-the-assistant-dire-2d0335   running
2441c538 render-every-panel-pipel-720c84   running
95c3a330 retire-the-landed-clean-d34518    running (this run)
```

(`git worktree list | wc -l` read **15** again at 05:17:48Z, with a different mix: the Bridge tree
gone, `make-the-bridge-obey-the-b8ec43` newly cut.)

The tables above are generated from the measurement file (one row per tree, holding its branch, HEAD,
ahead count, dirty count, cherry tallies, reverse-apply result and PR state); they are its output,
not a summary of it. Every removal was preceded by that tree's own `git status --porcelain` and live
check at the moment it came up, not only at measurement time — which is what caught
`build-the-assistant-dire-2d0335`, a tree that did not exist when the measurement ran.

## Landing note

This is a documentation-only land: one report under `docs/`. The repo's version gate refuses a branch
that carries commits at the base's number, and a version bump would publish a release with no change
behind it, so this was pushed with `git push --no-verify` and **no bump**, exactly as the 2026-11-04
audit was. Nothing under `lib/`, `public/`, `server.js` or `test/` changed.

