# Unmerged work in this repo's worktrees — 2026-11-04

Base: `origin/main` at `79e735b` (the 1.12.x tip). Measured 2026-11-04 from the primary
checkout of this repo (paths below are relative to the repo root).
Read-only: no audited tree was edited, committed to, merged, rebased, reset or removed.

Base drift: `origin/main` reached `9eee525` while this report was being written (PRs #399 and
#400 landed). Every read below was taken against `79e735b`; the two later landings touched no
audited worktree, so the per-tree verdicts stand.

## Scope

`git worktree list --porcelain` printed **105 registered worktrees**: the primary checkout, this
audit's own tree, and 103 task trees. 102 of those were audited and one is listed as **SKIPPED**
because a live job holds its cwd. A second job named in the brief,
`.worktrees/test-the-poc-breaking-to-a83375`, is **not a worktree of this repo** — the jobs API
reports its cwd as another project's worktree directory (`ai-development-factory/.worktrees/…`),
so there is nothing
here to read; it is listed below by job id.

`ls -1 .worktrees` counts **139 directories** against 104 registered trees, so 35 are unregistered
leftover directories. They are not worktrees, they have no branch or HEAD, and this audit did not
read them.

### Skipped trees

| tree | job id | why |
|---|---|---|
| `.worktrees/the-endpoint-is-on-main-24cabc` | `222ed919` | job status `running`; its cwd is that tree |
| `.worktrees/test-the-poc-breaking-to-a83375` | `7314b755` | job status `running`; its cwd is under another project's worktree directory (`ai-development-factory`), so no tree of this name exists in this repo |

## How each verdict was reached

Because this repo lands by squash and rebase, nothing here is judged by ancestry, `--merged` or
`git cherry`. Per tree:

    git -C <tree> rev-list --count origin/main..HEAD          # own commits
    git -C <tree> merge-base origin/main HEAD                 # the branch's own base
    git -C <tree> diff --name-only <base> HEAD                # the paths the branch itself changed
    git -C <tree> diff --quiet origin/main HEAD -- <path>     # empty = main carries that path byte for byte
    git -C <tree> status --porcelain                          # uncommitted work

The `diff --quiet` read alone is not enough here, because main moved after most of these branches
were cut: a path can differ while main still carries the work. So a path that differs was checked
one step further — the lines the branch's own delta adds were looked for in `origin/main`'s copy
of the file (`git show origin/main:<path>`), and a tree whose PR is `MERGED` at exactly its HEAD
(`gh pr list --state all --json headRefOid,state`) counts as landed because a squash or rebase
merge lands that head's tree. A `package.json` difference that is only the `"version"` line is
counted as a bump artifact, not as work.

Verdicts: **LANDED** (main has everything this tree changed), **PARTIAL** (some of it is on main),
**UNLANDED** (none of it is), **DIRTY-ONLY** (no own commits, only uncommitted work), **EMPTY**
(no own commits, clean).

## Summary

| verdict | trees |
|---|---|
| LANDED | 58 |
| PARTIAL | 12 |
| UNLANDED | 2 |
| DIRTY-ONLY | 1 |
| EMPTY | 29 |
| SKIPPED (live) | 1 |

**Genuinely at risk**: 6 trees hold content that exists nowhere on main and is worth
recovering:

- `build-the-pipeline-visua-66e815` — `wtgui/build-the-pipeline-visua-66e815` at `d3a5537`; 8 paths differ; recover by cherry-picking `d3a5537`.
- `critique-a-plan-before-a-93004d` — `wtgui/critique-a-plan-before-a-93004d` at `92fd740`; 1 file absent; recover by cherry-picking `92fd740`.
- `hey-get-me-some-screensh-b7a6e6` — `wtgui/hey-get-me-some-screensh-b7a6e6` at `5274039`; 7 files absent; recover by cherry-picking `95ddb2e`.
- `staged-and-begin-where-y-856177` — `wtgui/staged-and-begin-where-y-856177` at `61e9194`; 1 file absent, 1 path differs; recover by cherry-picking `61e9194`.
- `staged-in-your-first-15-b741a0` — `wtgui/staged-in-your-first-15-b741a0` at `d0bef37`; 1 path differs; recover by cherry-picking `d0bef37`.
- `the-facts-to-design-agai-97bed3` — `wtgui/the-facts-to-design-agai-97bed3` at `1796d1e`; 1 path differs; recover by cherry-picking `1796d1e`.

Another 5 carry only a stale render of a file main has since regenerated (`CHANGELOG.md`),
and 3 keep a small residue of a document main carries a later version of. Everything else is on
main already, empty, or a bump-only difference.

## Every tree

| # | tree | branch | HEAD | ahead | paths on main | on origin | verdict | what main is missing | recommendation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `add-a-human-button-besid-ca12a9` | `wtgui/add-a-human-button-besid-ca12a9` | `df71b9d` | 1 | 0/5 | yes | **LANDED** | nothing | safe to delete |
| 2 | `add-a-pre-push-gate-agai-4185fa` | `wtgui/add-a-pre-push-gate-agai-4185fa` | `199f3ce` | 2 | 5/7 | yes | **LANDED** | nothing | safe to delete |
| 3 | `add-openrouter-profiles-6d31bf` | `wtgui/add-openrouter-profiles-6d31bf` | `4d31704` | 1 | 4/11 | yes | **LANDED** | nothing | safe to delete |
| 4 | `architectural-review-top-e7ef6d` | `wtgui/architectural-review-top-e7ef6d` | `16a8549` | 3 | 4/6 | yes | **LANDED** | nothing | safe to delete |
| 5 | `both-research-docs-are-c-e5b018` | `wtgui/both-research-docs-are-c-e5b018` | `7b0d6c5` | 2 | 0/1 | no | **PARTIAL** | 1 path differs | keep (small residue) |
| 6 | `build-deploy-and-test-th-1e7b84` | `wtgui/build-deploy-and-test-th-1e7b84` | `85e588f` | 2 | 1/2 | yes | **LANDED** | nothing | safe to delete |
| 7 | `build-queue-72-drag-the-f2fb9f` | `wtgui/build-queue-72-drag-the-f2fb9f` | `9df1ab3` | 5 | 3/8 | yes | **LANDED** | nothing | safe to delete |
| 8 | `build-the-element-assist-408b27` | `wtgui/build-the-element-assist-408b27` | `832e62f` | 2 | 2/6 | yes | **LANDED** | nothing | safe to delete |
| 9 | `build-the-general-settin-177f0d` | `wtgui/build-the-general-settin-177f0d` | `715045e` | 1 | 1/11 | yes | **LANDED** | nothing | safe to delete |
| 10 | `build-the-panel-side-of-ec7202` | `wtgui/build-the-panel-side-of-ec7202` | `136bca5` | 3 | 5/11 | yes | **LANDED** | nothing | safe to delete |
| 11 | `build-the-pipeline-visua-66e815` | `wtgui/build-the-pipeline-visua-66e815` | `d3a5537` | 3 | 4/15 | yes | **PARTIAL** | 8 paths differ | recover by cherry-pick of d3a5537 |
| 12 | `build-the-stage-timer-a-0b37d7` | `wtgui/build-the-stage-timer-a-0b37d7` | `f7e8de8` | 2 | 2/5 | yes | **LANDED** | nothing | safe to delete |
| 13 | `close-pr-322-to-prevent-revert-44f852` | `wtgui/close-pr-322-to-prevent-revert-44f852` | `1b8b795` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 14 | `create-missing-v1-5-0-annotated-tag-4af048` | `wtgui/create-missing-v1-5-0-annotated-tag-4af048` | `e2358c5` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 15 | `create-the-version-to-co-92b3af` | `wtgui/create-the-version-to-co-92b3af` | `2230f3b` | 3 | 2/7 | yes | **LANDED** | nothing | safe to delete |
| 16 | `critique-a-plan-before-a-93004d` | `wtgui/critique-a-plan-before-a-93004d` | `92fd740` | 1 | 0/1 | no | **UNLANDED** | 1 file absent | recover by cherry-pick of 92fd740 |
| 17 | `debug-ssh-refusal-to-github-in-worker-sh-2eba9f` | `wtgui/debug-ssh-refusal-to-github-in-worker-sh-2eba9f` | `45e2bf0` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 18 | `define-and-implement-the-cfe479` | `wtgui/define-and-implement-the-cfe479` | `9e53d43` | 7 | 12/24 | yes | **LANDED** | nothing | safe to delete |
| 19 | `design-assistant-reset-feature-e79264` | `wtgui/design-assistant-reset-feature-e79264` | `f19b615` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 20 | `diagnose-ssh-refused-to-github-in-worker-835a08` | `wtgui/diagnose-ssh-refused-to-github-in-worker-835a08` | `45e2bf0` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 21 | `docs-architecture-md-10-41f98e` | `wtgui/docs-architecture-md-10-41f98e` | `7a93a1c` | 2 | 0/2 | yes | **LANDED** | nothing | safe to delete |
| 22 | `docs-reviews-architectur-08b3d0` | `wtgui/docs-reviews-architectur-08b3d0` | `6284904` | 2 | 1/2 | yes | **LANDED** | nothing | safe to delete |
| 23 | `drive-a-task-through-a-p-75861e` | `wtgui/drive-a-task-through-a-p-75861e` | `75e648c` | 0 | 0/0 | yes | **EMPTY** | nothing | safe to delete |
| 24 | `every-deliverable-card-g-5493b0` | `wtgui/every-deliverable-card-g-5493b0` | `2d1a929` | 2 | 0/5 | yes | **LANDED** | nothing | safe to delete |
| 25 | `execute-split-s1-extract-client-console-ef9dcf` | `wtgui/execute-split-s1-extract-client-console-ef9dcf` | `2938077` | 3 | 19/22 | yes | **LANDED** | nothing | safe to delete |
| 26 | `fast-forward-panel-checkout-to-origin-ma-30b0ec` | `wtgui/fast-forward-panel-checkout-to-origin-ma-30b0ec` | `45e2bf0` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 27 | `fast-forward-panel-checkout-to-origin-ma-d61320` | `wtgui/fast-forward-panel-checkout-to-origin-ma-d61320` | `2704ce3` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 28 | `fix-changelog-and-version-tag-gates-on-m-a4fb0e` | `(detached)` | `6891028` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 29 | `fix-changelog-check-for-v1-9-1-tag-1cb6cd` | `wtgui/fix-changelog-check-for-v1-9-1-tag-1cb6cd` | `1c9eb24` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 30 | `fix-the-parked-turn-card-cc18b4` | `wtgui/fix-the-parked-turn-card-cc18b4` | `a2ac25e` | 3 | 5/10 | yes | **LANDED** | nothing | safe to delete |
| 31 | `fix-tools-version-mjs-ta-4a9fa2` | `wtgui/fix-tools-version-mjs-ta-4a9fa2` | `ab428db` | 2 | 3/4 | yes | **LANDED** | nothing | safe to delete |
| 32 | `fresh-tree-changelog-render-at-1-9-0-06f1a8` | `wtgui/fresh-tree-changelog-render-at-1-9-0-06f1a8` | `1c9eb24` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 33 | `group-dmr-39015-branches-in-jenkins-451b35` | `wtgui/group-dmr-39015-branches-in-jenkins-451b35` | `cb5f505` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 34 | `hey-get-me-some-screensh-b7a6e6` | `wtgui/hey-get-me-some-screensh-b7a6e6` | `5274039` | 3 | 0/8 | yes | **UNLANDED** | 7 files absent | recover by cherry-pick of 95ddb2e |
| 35 | `implement-deliverables-api-and-store-3e7e3b` | `wtgui/implement-deliverables-api-and-store-3e7e3b` | `4c42a05` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 36 | `investigate-and-fix-the-c77da0` | `wtgui/investigate-and-fix-the-c77da0` | `2c7d78a` | 3 | 0/1 | no | **PARTIAL** | CHANGELOG stale render (2 lines) | safe to delete (stale render) |
| 37 | `land-pr-359-and-render-t-0e6a57` | `wtgui/land-pr-359-and-render-t-0e6a57` | `3ece481` | 1 | 0/1 | yes | **PARTIAL** | 1 path differs | keep (small residue) |
| 38 | `land-pr-383-and-leave-th-23eda6` | `wtgui/land-pr-383-and-leave-th-23eda6` | `7c7eb23` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 39 | `land-the-changelog-fix-b-d69eca` | `wtgui/land-the-changelog-fix-b-d69eca` | `db52ecd` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 40 | `land-the-render-and-kill-8e512f` | `wtgui/land-the-render-and-kill-8e512f` | `db66f50` | 1 | 1/1 | yes | **LANDED** | nothing | safe to delete |
| 41 | `land-the-stage-driving-w-5b64af` | `wtgui/land-the-stage-driving-w-5b64af` | `430140c` | 2 | 4/7 | yes | **LANDED** | nothing | safe to delete |
| 42 | `make-a-hold-that-stops-b-474e8b` | `wtgui/make-a-hold-that-stops-b-474e8b` | `7668964` | 4 | 2/5 | yes | **LANDED** | nothing | safe to delete |
| 43 | `make-the-human-rotation-23c8b5` | `wtgui/make-the-human-rotation-23c8b5` | `990483d` | 1 | 0/4 | yes | **LANDED** | nothing | safe to delete |
| 44 | `make-the-landing-render-7a476d` | `wtgui/make-the-landing-render-7a476d` | `3c29b07` | 5 | 5/10 | yes | **LANDED** | nothing | safe to delete |
| 45 | `make-the-pipeline-dialog-2009e1` | `wtgui/make-the-pipeline-dialog-2009e1` | `3e1ce21` | 3 | 28/30 | yes | **LANDED** | nothing | safe to delete |
| 46 | `measure-coupling-and-churn-for-architect-2fb127` | `wtgui/measure-coupling-and-churn-for-architect-2fb127` | `7d06dae` | 1 | 1/1 | no | **LANDED** | nothing | safe to delete |
| 47 | `measure-whether-0-78-1-i-564931` | `wtgui/measure-whether-0-78-1-i-564931` | `e9d88b4` | 1 | 2/2 | yes | **LANDED** | nothing | safe to delete |
| 48 | `move-stranded-v0-110-0-tag-with-version-b173d3` | `wtgui/move-stranded-v0-110-0-tag-with-version-b173d3` | `9166869` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 49 | `move-v0-95-0-and-v0-98-0-tags-105b7c` | `wtgui/move-v0-95-0-and-v0-98-0-tags-105b7c` | `9669681` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 50 | `move-v0-99-0-tag-to-e4cb244-f10dc9` | `wtgui/move-v0-99-0-tag-to-e4cb244-f10dc9` | `9669681` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 51 | `move-v1-7-1-tag-onto-declaring-commit-4e9da9` | `wtgui/move-v1-7-1-tag-onto-declaring-commit-4e9da9` | `e2358c5` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 52 | `one-ref-no-code-the-0-10-b9989a` | `wtgui/one-ref-no-code-the-0-10-b9989a` | `9669681` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 53 | `panel-side-forensics-for-stuck-session-d-c813be` | `wtgui/panel-side-forensics-for-stuck-session-d-c813be` | `f19b615` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 54 | `phase-1-of-a-build-resea-5db421` | `wtgui/phase-1-of-a-build-resea-5db421` | `e1f3320` | 5 | 2/3 | yes | **LANDED** | nothing | safe to delete |
| 55 | `playwright-improvement-r-6bf56e` | `wtgui/playwright-improvement-r-6bf56e` | `8b3e8f0` | 2 | 4/4 | yes | **LANDED** | nothing | safe to delete |
| 56 | `playwright-round-5a-both-a3a0fc` | `wtgui/playwright-round-5a-both-a3a0fc` | `49f6e4e` | 0 | 0/0 | yes | **EMPTY** | nothing | safe to delete |
| 57 | `playwright-usability-rou-8ec471` | `wtgui/playwright-usability-rou-8ec471` | `d92edbd` | 2 | 17/20 | yes | **LANDED** | nothing | safe to delete |
| 58 | `probe-gateway-paused-session-fence-behav-bc2773` | `wtgui/probe-gateway-paused-session-fence-behav-bc2773` | `f19b615` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 59 | `profile-the-four-paths-t-0a27af` | `wtgui/profile-the-four-paths-t-0a27af` | `5a88d2f` | 1 | 1/3 | yes | **LANDED** | nothing | safe to delete |
| 60 | `prove-the-minimized-comp-e7e985` | `wtgui/prove-the-minimized-comp-e7e985` | `4ba1fe8` | 1 | 1/2 | yes | **LANDED** | nothing | safe to delete |
| 61 | `pull-the-composer-block-f3c707` | `wtgui/pull-the-composer-block-f3c707` | `5e8aed4` | 1 | 2/4 | yes | **LANDED** | nothing | safe to delete |
| 62 | `put-the-missing-v1-5-0-a-a2ba85` | `wtgui/put-the-missing-v1-5-0-a-a2ba85` | `e2358c5` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 63 | `put-the-primary-checkout-0c0f9b` | `wtgui/put-the-primary-checkout-0c0f9b` | `2addd87` | 2 | 0/1 | no | **PARTIAL** | CHANGELOG stale render (2 lines) | safe to delete (stale render) |
| 64 | `put-the-project-name-on-5efc0d` | `wtgui/put-the-project-name-on-5efc0d` | `35da3ba` | 1 | 3/8 | yes | **LANDED** | nothing | safe to delete |
| 65 | `re-render-the-changelog-a4d783` | `wtgui/re-render-the-changelog-a4d783` | `737c517` | 2 | 0/2 | yes | **LANDED** | nothing | safe to delete |
| 66 | `read-only-boot-proof-for-s1-352592` | `wtgui/read-only-boot-proof-for-s1-352592` | `1c9eb24` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 67 | `read-only-visual-audit-o-10e2ba` | `wtgui/read-only-visual-audit-o-10e2ba` | `c6bffba` | 1 | 11/11 | yes | **LANDED** | nothing | safe to delete |
| 68 | `recover-this-row-s-finis-b86302` | `wtgui/recover-this-row-s-finis-b86302` | `f3547de` | 2 | 2/5 | yes | **LANDED** | nothing | safe to delete |
| 69 | `render-all-three-missing-07d25b` | `wtgui/render-all-three-missing-07d25b` | `016a7ed` | 1 | 0/1 | yes | **PARTIAL** | CHANGELOG stale render (2 lines) | safe to delete (stale render) |
| 70 | `render-main-so-both-miss-25911a` | `wtgui/render-main-so-both-miss-25911a` | `8d8e8cb` | 1 | 0/1 | yes | **PARTIAL** | CHANGELOG stale render (2 lines) | safe to delete (stale render) |
| 71 | `render-main-so-both-miss-49f608` | `wtgui/render-main-so-both-miss-49f608` | `2ee5db7` | 1 | 0/1 | yes | **LANDED** | nothing | safe to delete |
| 72 | `render-the-changelog-in-beb4ec` | `wtgui/render-the-changelog-in-beb4ec` | `f9d6889` | 1 | 0/1 | yes | **LANDED** | nothing | safe to delete |
| 73 | `render-the-missing-v1-8-8789cb` | `wtgui/render-the-missing-v1-8-8789cb` | `f52f354` | 1 | 0/1 | no | **PARTIAL** | CHANGELOG stale render (2 lines) | safe to delete (stale render) |
| 74 | `repair-the-v1-1-0-tag-ve-c49be6` | `wtgui/repair-the-v1-1-0-tag-ve-c49be6` | `c6d86ff` | 1 | 1/1 | yes | **LANDED** | nothing | safe to delete |
| 75 | `replace-the-worktree-cha-5190fe` | `wtgui/replace-the-worktree-cha-5190fe` | `cf0e945` | 1 | 15/25 | yes | **LANDED** | nothing | safe to delete |
| 76 | `replace-the-worktree-cha-c1b465` | `wtgui/replace-the-worktree-cha-c1b465` | `489389d` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 77 | `research-and-write-up-do-f84b69` | `wtgui/research-and-write-up-do-f84b69` | `e6c16c0` | 1 | 0/2 | yes | **LANDED** | nothing | safe to delete |
| 78 | `research-how-comparable-0d9215` | `wtgui/research-how-comparable-0d9215` | `ca1a0a3` | 3 | 1/2 | yes | **LANDED** | nothing | safe to delete |
| 79 | `research-whether-our-her-f16888` | `wtgui/research-whether-our-her-f16888` | `4cd9714` | 1 | 1/2 | yes | **LANDED** | nothing | safe to delete |
| 80 | `review-the-0-75-0-0-78-1-b0b34f` | `wtgui/review-the-0-75-0-0-78-1-b0b34f` | `36ca6f8` | 1 | 1/2 | yes | **LANDED** | nothing | safe to delete |
| 81 | `settings-tab-for-pipelin-5dab4f` | `wtgui/settings-tab-for-pipelin-5dab4f` | `942f388` | 1 | 9/16 | yes | **LANDED** | nothing | safe to delete |
| 82 | `size-the-pipeline-dialog-8e95e4` | `wtgui/size-the-pipeline-dialog-8e95e4` | `ff50801` | 4 | 10/20 | yes | **LANDED** | nothing | safe to delete |
| 83 | `split-research-1-server-4f1da3` | `wtgui/split-research-1-server-4f1da3` | `65c7f46` | 1 | 1/1 | no | **LANDED** | nothing | safe to delete |
| 84 | `split-research-2-public-aa78b1` | `wtgui/split-research-2-public-aa78b1` | `f0f0183` | 1 | 1/2 | no | **LANDED** | nothing | safe to delete |
| 85 | `split-research-3-lib-int-bfda7a` | `wtgui/split-research-3-lib-int-bfda7a` | `bae2ccb` | 1 | 1/2 | no | **LANDED** | nothing | safe to delete |
| 86 | `staged-and-begin-where-y-856177` | `wtgui/staged-and-begin-where-y-856177` | `61e9194` | 2 | 0/2 | no | **PARTIAL** | 1 file absent, 1 path differs | recover by cherry-pick of 61e9194 |
| 87 | `staged-and-use-your-pred-6e0df2` | `wtgui/staged-and-use-your-pred-6e0df2` | `bb7fdb5` | 2 | 0/2 | no | **PARTIAL** | 1 path differs | keep (small residue) |
| 88 | `staged-in-your-first-15-60e9c8` | `wtgui/staged-in-your-first-15-60e9c8` | `f19b615` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 89 | `staged-in-your-first-15-b741a0` | `wtgui/staged-in-your-first-15-b741a0` | `d0bef37` | 2 | 1/2 | no | **PARTIAL** | 1 path differs | recover by cherry-pick of d0bef37 |
| 90 | `stop-ledger-publishing-absolute-local-pa-afdba0` | `wtgui/stop-ledger-publishing-absolute-local-pa-afdba0` | `45e2bf0` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 91 | `stop-the-ledger-publishi-34a596` | `wtgui/stop-the-ledger-publishi-34a596` | `eb9903e` | 2 | 2/3 | yes | **LANDED** | nothing | safe to delete |
| 92 | `test-the-task-pipeline-w-4800d2` | `wtgui/test-the-task-pipeline-w-4800d2` | `1e671c2` | 2 | 1/3 | yes | **LANDED** | nothing | safe to delete |
| 93 | `the-approval-card-expire-224646` | `wtgui/fix-approval-card-expiry-default-to-600s-224646` | `4f660d2` | 0 | 0/0 | no | **DIRTY-ONLY** | 1 uncommitted | keep (copy the file out) |
| 94 | `the-deliverables-button-763f28` | `wtgui/the-deliverables-button-763f28` | `aee766b` | 2 | 4/10 | yes | **LANDED** | nothing | safe to delete |
| 95 | `the-deliverables-button-8da595` | `wtgui/the-deliverables-button-8da595` | `7c61d11` | 2 | 1/5 | yes | **LANDED** | nothing | safe to delete |
| 96 | `the-deliverables-list-40-fe2fb8` | `wtgui/the-deliverables-list-40-fe2fb8` | `5c6f9c5` | 2 | 1/8 | yes | **LANDED** | nothing | safe to delete |
| 97 | `the-endpoint-is-on-main-24cabc` | `wtgui/the-endpoint-is-on-main-24cabc` | `d38de7a` | - | - | - | **SKIPPED** | live job 222ed919 | skip (live) |
| 98 | `the-facts-to-design-agai-97bed3` | `wtgui/the-facts-to-design-agai-97bed3` | `1796d1e` | 1 | 0/1 | no | **PARTIAL** | 1 path differs | recover by cherry-pick of 1796d1e |
| 99 | `the-version-tags-gate-is-5feb5c` | `wtgui/the-version-tags-gate-is-5feb5c` | `9669681` | 0 | 0/0 | no | **EMPTY** | nothing | safe to delete |
| 100 | `three-ui-changes-main-is-8c936e` | `wtgui/three-ui-changes-main-is-8c936e` | `d938fe9` | 2 | 3/12 | yes | **LANDED** | nothing | safe to delete |
| 101 | `tools-version-mjs-check-b9d7c7` | `wtgui/tools-version-mjs-check-b9d7c7` | `0f92e04` | 5 | 3/9 | yes | **LANDED** | nothing | safe to delete |
| 102 | `two-changes-to-the-assis-6291a1` | `wtgui/two-changes-to-the-assis-6291a1` | `65eef30` | 2 | 2/5 | no | **LANDED** | nothing | safe to delete |
| 103 | `two-tests-pin-app-js-cod-5f7147` | `wtgui/two-tests-pin-app-js-cod-5f7147` | `0db6101` | 2 | 1/2 | yes | **LANDED** | nothing | safe to delete |

## Per-tree detail

### add-a-human-button-besid-ca12a9 — LANDED

`wtgui/add-a-human-button-besid-ca12a9` at `df71b9d10b`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-28 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3330/-2521 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +34/-234 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +68/-565 |
| `tools/verify-human-button.mjs` | differs (main's copy moved on; PR merged this head) | +23/-364 |


### add-a-pre-push-gate-agai-4185fa — LANDED

`wtgui/add-a-pre-push-gate-agai-4185fa` at `199f3ce277`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `.githooks/pre-push` | empty (identical) | — |
| `README.md` | differs (every added line is on main) | +0/-16 |
| `docs/architecture.md` | empty (identical) | — |
| `package.json` | differs (version line only) | +1/-4 |
| `test/absolute-paths.test.js` | empty (identical) | — |
| `tools/absolute-paths.allow` | empty (identical) | — |
| `tools/absolute-paths.mjs` | empty (identical) | — |


### add-openrouter-profiles-6d31bf — LANDED

`wtgui/add-openrouter-profiles-6d31bf` at `4d31704ba4`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `README.md` | differs (main's copy moved on; PR merged this head) | +30/-85 |
| `lib/hermes-config.js` | empty (identical) | — |
| `lib/paths.js` | differs (main's copy moved on; PR merged this head) | +1/-13 |
| `lib/provider-profiles.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-27 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3205/-2134 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +34/-214 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +64/-553 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +133/-819 |
| `test/provider-profiles.test.js` | empty (identical) | — |
| `tools/verify-provider-profiles.mjs` | empty (identical) | — |


### architectural-review-top-e7ef6d — LANDED

`wtgui/architectural-review-top-e7ef6d` at `16a8549bfa`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/arch-review-r1-a.md` | empty (identical) | — |
| `docs/arch-review-r1-b.md` | empty (identical) | — |
| `docs/arch-review-r2-a.md` | empty (identical) | — |
| `docs/arch-review-r2-b.md` | empty (identical) | — |
| `docs/reviews/architecture-modules.html` | differs (main's copy moved on; PR merged this head) | +30/-50 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-20 |


### both-research-docs-are-c-e5b018 — PARTIAL

`wtgui/both-research-docs-are-c-e5b018` at `7b0d6c576e`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/research/assistant-reset-design.md` | differs (13 of 448 added lines absent) | +19/-34 |


### build-deploy-and-test-th-1e7b84 — LANDED

`wtgui/build-deploy-and-test-th-1e7b84` at `85e588f2f8`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/landing-pictureviewer-pmw-sso-deploy-2026-11-04.html` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-7 |


### build-queue-72-drag-the-f2fb9f — LANDED

`wtgui/build-queue-72-drag-the-f2fb9f` at `9df1ab3b92`, **5** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `lib/assistant.js` | differs (main's copy moved on; PR merged this head) | +72/-1680 |
| `lib/assistant/queue.js` | differs (main's copy moved on; PR merged this head) | +11/-91 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-38 |
| `public/assistant.js` | differs (main's copy moved on; PR merged this head) | +232/-1581 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +72/-866 |
| `test/queue-drag-ui.test.js` | empty (identical) | — |
| `test/queue-order.test.js` | empty (identical) | — |
| `tools/verify-queue-drag.mjs` | empty (identical) | — |


### build-the-element-assist-408b27 — LANDED

`wtgui/build-the-element-assist-408b27` at `832e62fb70`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `lib/assistant.js` | differs (main's copy moved on; PR merged this head) | +2/-20 |
| `lib/jobs.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-11 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +20/-43 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +39/-317 |
| `test/element-assist.test.js` | empty (identical) | — |


### build-the-general-settin-177f0d — LANDED

`wtgui/build-the-general-settin-177f0d` at `715045e33e`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `lib/gateway-permissions.js` | differs (main's copy moved on; PR merged this head) | +22/-79 |
| `lib/remote-writes.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-44 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3051/-3694 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +35/-273 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +83/-907 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +142/-1082 |
| `test/gateway-permissions.test.js` | differs (main's copy moved on; PR merged this head) | +0/-124 |
| `test/settings-tabs.test.js` | differs (main's copy moved on; PR merged this head) | +5/-5 |
| `tools/verify-settings-permissions.mjs` | differs (main's copy moved on; PR merged this head) | +5/-174 |
| `tools/verify-settings-tabs.mjs` | differs (main's copy moved on; PR merged this head) | +18/-18 |


### build-the-panel-side-of-ec7202 — LANDED

`wtgui/build-the-panel-side-of-ec7202` at `136bca5105`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `README.md` | differs (main's copy moved on; PR merged this head) | +14/-51 |
| `config.json` | empty (identical) | — |
| `lib/matrix-bridge.js` | empty (identical) | — |
| `lib/paths.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-12 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3032/-696 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +20/-139 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +74/-238 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +93/-384 |
| `test/matrix-bridge.test.js` | empty (identical) | — |
| `tools/verify-matrix-bridge.mjs` | empty (identical) | — |


### build-the-pipeline-visua-66e815 — PARTIAL

`wtgui/build-the-pipeline-visua-66e815` at `d3a55376f9`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/pipelines.md` | empty (identical) | — |
| `docs/using-the-board.md` | differs (every added line is on main) | +7/-23 |
| `lib/task-pipeline-assign.js` | empty (identical) | — |
| `package.json` | differs (version line only) | +1/-15 |
| `public/app.js` | differs (3 of 79 added lines absent) | +3060/-964 |
| `public/assistant.js` | differs (1 of 89 added lines absent) | +202/-751 |
| `public/index.html` | differs (every added line is on main) | +20/-176 |
| `public/pipeline-flow.js` | differs (40 of 243 added lines absent) | +50/-321 |
| `public/pipeline-modal.js` | differs (12 of 302 added lines absent) | +15/-126 |
| `public/style.css` | differs (33 of 107 added lines absent) | +69/-304 |
| `test/pipeline-assign-route.test.js` | empty (identical) | — |
| `test/pipeline-flow.test.js` | differs (3 of 148 added lines absent) | +3/-92 |
| `test/pipeline-modal.test.js` | differs (2 of 88 added lines absent) | +2/-58 |
| `tools/verify-pipeline-flow.mjs` | differs (3 of 316 added lines absent) | +3/-3 |
| `tools/verify-pipelines-tab.mjs` | empty (identical) | — |


### build-the-stage-timer-a-0b37d7 — LANDED

`wtgui/build-the-stage-timer-a-0b37d7` at `f7e8de8464`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `lib/jobs.js` | differs (main's copy moved on; PR merged this head) | +1/-203 |
| `lib/pipelines.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-17 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +60/-519 |
| `test/pipeline-wait.test.js` | empty (identical) | — |


### close-pr-322-to-prevent-revert-44f852 — EMPTY

`wtgui/close-pr-322-to-prevent-revert-44f852` at `1b8b795682`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### create-missing-v1-5-0-annotated-tag-4af048 — EMPTY

`wtgui/create-missing-v1-5-0-annotated-tag-4af048` at `e2358c5b28`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### create-the-version-to-co-92b3af — LANDED

`wtgui/create-the-version-to-co-92b3af` at `2230f3bc6d`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (main's copy moved on; PR merged this head) | +2/-910 |
| `docs/versioning.md` | differs (main's copy moved on; PR merged this head) | +10/-63 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-22 |
| `test/release-tags.test.js` | empty (identical) | — |
| `tools/changelog.mjs` | differs (main's copy moved on; PR merged this head) | +14/-113 |
| `tools/release-history.mjs` | differs (main's copy moved on; PR merged this head) | +0/-21 |
| `tools/verify-version-tags.mjs` | empty (identical) | — |


### critique-a-plan-before-a-93004d — UNLANDED

`wtgui/critique-a-plan-before-a-93004d` at `92fd740992`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/pipeline-modal-plan-review.md` | differs (absent on main) | +107/-0 |


### debug-ssh-refusal-to-github-in-worker-sh-2eba9f — EMPTY

`wtgui/debug-ssh-refusal-to-github-in-worker-sh-2eba9f` at `45e2bf082d`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### define-and-implement-the-cfe479 — LANDED

`wtgui/define-and-implement-the-cfe479` at `9e53d43647`, **7** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/task-pipeline.md` | differs (main's copy moved on; PR merged this head) | +1/-60 |
| `lib/assistant.js` | differs (main's copy moved on; PR merged this head) | +44/-1466 |
| `lib/assistant/queue.js` | differs (main's copy moved on; PR merged this head) | +6/-43 |
| `lib/paths.js` | differs (main's copy moved on; PR merged this head) | +1/-19 |
| `lib/pipeline-bundle.js` | empty (identical) | — |
| `lib/pipeline-window.js` | empty (identical) | — |
| `lib/task-pipeline-assign.js` | differs (main's copy moved on; PR merged this head) | +0/-5 |
| `lib/task-pipeline.js` | differs (main's copy moved on; PR merged this head) | +2/-12 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-31 |
| `pipeline-bundle.seed.json` | empty (identical) | — |
| `public/assistant.js` | differs (main's copy moved on; PR merged this head) | +218/-967 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +34/-246 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +63/-605 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +133/-996 |
| `test/pipeline-assign-route.test.js` | differs (main's copy moved on; PR merged this head) | +0/-11 |
| `test/pipeline-bundle-seed.test.js` | empty (identical) | — |
| `test/pipeline-bundle.test.js` | empty (identical) | — |
| `test/pipeline-window-route.test.js` | empty (identical) | — |
| `test/pipeline-window.test.js` | empty (identical) | — |
| `test/task-pipeline-assign.test.js` | empty (identical) | — |
| `test/task-pipeline-window-ui.test.js` | empty (identical) | — |
| `test/task-pipeline.test.js` | empty (identical) | — |
| `tools/seed-pipeline-bundle.mjs` | empty (identical) | — |
| `tools/verify-task-pipeline-window.mjs` | empty (identical) | — |


### design-assistant-reset-feature-e79264 — EMPTY

`wtgui/design-assistant-reset-feature-e79264` at `f19b615a2d`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### diagnose-ssh-refused-to-github-in-worker-835a08 — EMPTY

`wtgui/diagnose-ssh-refused-to-github-in-worker-835a08` at `45e2bf082d`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### docs-architecture-md-10-41f98e — LANDED

`wtgui/docs-architecture-md-10-41f98e` at `7a93a1c898`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/architecture.md` | differs (main's copy moved on; PR merged this head) | +3/-10 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-17 |


### docs-reviews-architectur-08b3d0 — LANDED

`wtgui/docs-reviews-architectur-08b3d0` at `6284904123`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/architecture-modules.html` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-16 |


### drive-a-task-through-a-p-75861e — EMPTY

`wtgui/drive-a-task-through-a-p-75861e` at `75e648c370`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### every-deliverable-card-g-5493b0 — LANDED

`wtgui/every-deliverable-card-g-5493b0` at `2d1a929e28`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-10 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +2864/-543 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +2/-15 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +45/-115 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +3/-43 |


### execute-split-s1-extract-client-console-ef9dcf — LANDED

`wtgui/execute-split-s1-extract-client-console-ef9dcf` at `2938077fc5`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-4 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +0/-326 |
| `public/board/console.js` | empty (identical) | — |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +1/-4 |
| `test/board-lookups.test.js` | empty (identical) | — |
| `test/console-call-note.test.js` | empty (identical) | — |
| `test/console-column-fit.test.js` | empty (identical) | — |
| `test/console-fold-hold.test.js` | empty (identical) | — |
| `test/console-height-store.test.js` | empty (identical) | — |
| `test/console-independence.test.js` | empty (identical) | — |
| `test/console-input-scope.test.js` | empty (identical) | — |
| `test/console-row-text.test.js` | empty (identical) | — |
| `test/console-tail-pin.test.js` | empty (identical) | — |
| `test/console-typed-line.test.js` | empty (identical) | — |
| `test/placed-nodes.test.js` | empty (identical) | — |
| `test/reasoning-hold.test.js` | empty (identical) | — |
| `test/result-row-head.test.js` | empty (identical) | — |
| `test/tail-chip-shared-rule.test.js` | empty (identical) | — |
| `test/tool-call-rows.test.js` | empty (identical) | — |
| `test/tool-group-key.test.js` | empty (identical) | — |
| `test/tool-output-expand.test.js` | empty (identical) | — |
| `test/tool-usage-group.test.js` | empty (identical) | — |


### fast-forward-panel-checkout-to-origin-ma-30b0ec — EMPTY

`wtgui/fast-forward-panel-checkout-to-origin-ma-30b0ec` at `45e2bf082d`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### fast-forward-panel-checkout-to-origin-ma-d61320 — EMPTY

`wtgui/fast-forward-panel-checkout-to-origin-ma-d61320` at `2704ce3775`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### fix-changelog-and-version-tag-gates-on-m-a4fb0e — EMPTY

`(detached)` at `68910281de`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### fix-changelog-check-for-v1-9-1-tag-1cb6cd — EMPTY

`wtgui/fix-changelog-check-for-v1-9-1-tag-1cb6cd` at `1c9eb24691`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### fix-the-parked-turn-card-cc18b4 — LANDED

`wtgui/fix-the-parked-turn-card-cc18b4` at `a2ac25eed6`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/steer-refusal.md` | empty (identical) | — |
| `lib/jobs.js` | differs (main's copy moved on; PR merged this head) | +2/-462 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-36 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3009/-3209 |
| `public/core/steerable.js` | empty (identical) | — |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +34/-260 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +134/-1021 |
| `test/steerable.test.js` | empty (identical) | — |
| `tools/verify-steer-turn.mjs` | empty (identical) | — |
| `tools/verify-steerable.mjs` | empty (identical) | — |


### fix-tools-version-mjs-ta-4a9fa2 — LANDED

`wtgui/fix-tools-version-mjs-ta-4a9fa2` at `ab428db0b3`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-10 |
| `test/version-tags.test.js` | empty (identical) | — |
| `tools/release-history.mjs` | empty (identical) | — |
| `tools/version.mjs` | empty (identical) | — |


### fresh-tree-changelog-render-at-1-9-0-06f1a8 — EMPTY

`wtgui/fresh-tree-changelog-render-at-1-9-0-06f1a8` at `1c9eb24691`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### group-dmr-39015-branches-in-jenkins-451b35 — EMPTY

`wtgui/group-dmr-39015-branches-in-jenkins-451b35` at `cb5f505bd9`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### hey-get-me-some-screensh-b7a6e6 — UNLANDED

`wtgui/hey-get-me-some-screensh-b7a6e6` at `5274039ddd`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/assets/pipeline-tabs/bundles-tab.png` | differs (absent on main) | binary |
| `docs/assets/pipeline-tabs/capture.json` | differs (absent on main) | +223/-0 |
| `docs/assets/pipeline-tabs/pipeline-flow.png` | differs (absent on main) | binary |
| `docs/assets/pipeline-tabs/pipeline-stages.png` | differs (absent on main) | binary |
| `docs/assets/pipeline-tabs/pipeline-tab.png` | differs (absent on main) | binary |
| `docs/pipeline-tabs.html` | differs (absent on main) | +150/-0 |
| `package.json` | differs (version line only) | +2/-7 |
| `tools/capture-settings-pipeline.mjs` | differs (absent on main) | +437/-0 |


### implement-deliverables-api-and-store-3e7e3b — EMPTY

`wtgui/implement-deliverables-api-and-store-3e7e3b` at `4c42a05c29`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### investigate-and-fix-the-c77da0 — PARTIAL

`wtgui/investigate-and-fix-the-c77da0` at `2c7d78a8bc`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (2 of 10 added lines absent) | +2/-64 |


### land-pr-359-and-render-t-0e6a57 — PARTIAL

`wtgui/land-pr-359-and-render-t-0e6a57` at `3ece481058`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/pipeline-flow-usability-ledger.md` | differs (5 of 65 added lines absent) | +5/-6 |


### land-pr-383-and-leave-th-23eda6 — EMPTY

`wtgui/land-pr-383-and-leave-th-23eda6` at `7c7eb238d7`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### land-the-changelog-fix-b-d69eca — EMPTY

`wtgui/land-the-changelog-fix-b-d69eca` at `db52ecd451`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### land-the-render-and-kill-8e512f — LANDED

`wtgui/land-the-render-and-kill-8e512f` at `db66f50c36`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/landing-changelog-render-2026-11-04.md` | empty (identical) | — |


### land-the-stage-driving-w-5b64af — LANDED

`wtgui/land-the-stage-driving-w-5b64af` at `430140c0d1`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/task-pipeline.md` | empty (identical) | — |
| `lib/assistant.js` | differs (main's copy moved on; PR merged this head) | +20/-1144 |
| `lib/task-pipeline-drive.js` | differs (main's copy moved on; PR merged this head) | +17/-62 |
| `lib/task-pipeline.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-13 |
| `test/task-pipeline-drive.test.js` | empty (identical) | — |
| `test/task-pipeline-sweep.test.js` | empty (identical) | — |


### make-a-hold-that-stops-b-474e8b — LANDED

`wtgui/make-a-hold-that-stops-b-474e8b` at `766896431c`, **4** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `lib/assistant.js` | differs (main's copy moved on; PR merged this head) | +44/-1501 |
| `lib/assistant/queue.js` | differs (main's copy moved on; PR merged this head) | +8/-53 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-36 |
| `test/queue-holds.test.js` | empty (identical) | — |
| `tools/verify-queue-holds.mjs` | empty (identical) | — |


### make-the-human-rotation-23c8b5 — LANDED

`wtgui/make-the-human-rotation-23c8b5` at `990483d616`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-20 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3194/-2070 |
| `public/assistant.js` | differs (main's copy moved on; PR merged this head) | +215/-943 |
| `tools/verify-human-button.mjs` | differs (main's copy moved on; PR merged this head) | +7/-27 |


### make-the-landing-render-7a476d — LANDED

`wtgui/make-the-landing-render-7a476d` at `3c29b07c87`, **5** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `.githooks/pre-push` | differs (main's copy moved on; PR merged this head) | +4/-38 |
| `README.md` | differs (main's copy moved on; PR merged this head) | +0/-30 |
| `docs/landing-render-in-the-landing-path-2026-11-04.md` | empty (identical) | — |
| `docs/versioning.md` | empty (identical) | — |
| `lib/merge-prompt.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-8 |
| `test/land.test.js` | differs (main's copy moved on; PR merged this head) | +0/-24 |
| `test/merge-prompt.test.js` | empty (identical) | — |
| `tools/changelog.mjs` | differs (main's copy moved on; PR merged this head) | +14/-104 |
| `tools/land.mjs` | empty (identical) | — |


### make-the-pipeline-dialog-2009e1 — LANDED

`wtgui/make-the-pipeline-dialog-2009e1` at `3e1ce21bf9`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/pipeline-dialog-density-round.html` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1280x800-1-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1280x800-13-stages-fit.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1280x800-13-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1280x800-2-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1280x800-7-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1824x900-1-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1824x900-13-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1824x900-2-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/1824x900-7-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1280x800-1-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1280x800-13-stages-fit.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1280x800-13-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1280x800-2-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1280x800-7-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1824x900-1-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1824x900-13-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1824x900-2-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/before-1824x900-7-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/ledger-before.json` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-density-round/ledger.json` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-3 |
| `public/pipeline-flow.js` | empty (identical) | — |
| `public/pipeline-modal.js` | empty (identical) | — |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +0/-13 |
| `test/pipeline-flow.test.js` | empty (identical) | — |
| `test/pipeline-modal.test.js` | empty (identical) | — |
| `tools/verify-pipeline-dialog-size.mjs` | empty (identical) | — |
| `tools/verify-pipeline-flow-visible.mjs` | empty (identical) | — |
| `tools/verify-pipeline-flow.mjs` | empty (identical) | — |


### measure-coupling-and-churn-for-architect-2fb127 — LANDED

`wtgui/measure-coupling-and-churn-for-architect-2fb127` at `7d06dae66e`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/arch-review-r2-b.md` | empty (identical) | — |


### measure-whether-0-78-1-i-564931 — LANDED

`wtgui/measure-whether-0-78-1-i-564931` at `e9d88b43a9`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/rounds/perf-075-vs-078.md` | empty (identical) | — |
| `tools/perf-075-vs-078.mjs` | empty (identical) | — |


### move-stranded-v0-110-0-tag-with-version-b173d3 — EMPTY

`wtgui/move-stranded-v0-110-0-tag-with-version-b173d3` at `9166869b5f`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### move-v0-95-0-and-v0-98-0-tags-105b7c — EMPTY

`wtgui/move-v0-95-0-and-v0-98-0-tags-105b7c` at `9669681c62`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### move-v0-99-0-tag-to-e4cb244-f10dc9 — EMPTY

`wtgui/move-v0-99-0-tag-to-e4cb244-f10dc9` at `9669681c62`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### move-v1-7-1-tag-onto-declaring-commit-4e9da9 — EMPTY

`wtgui/move-v1-7-1-tag-onto-declaring-commit-4e9da9` at `e2358c5b28`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### one-ref-no-code-the-0-10-b9989a — EMPTY

`wtgui/one-ref-no-code-the-0-10-b9989a` at `9669681c62`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### panel-side-forensics-for-stuck-session-d-c813be — EMPTY

`wtgui/panel-side-forensics-for-stuck-session-d-c813be` at `f19b615a2d`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### phase-1-of-a-build-resea-5db421 — LANDED

`wtgui/phase-1-of-a-build-resea-5db421` at `e1f3320382`, **5** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/plan/deliverables-handback-review.md` | empty (identical) | — |
| `docs/plan/deliverables-handback.md` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-17 |


### playwright-improvement-r-6bf56e — LANDED

`wtgui/playwright-improvement-r-6bf56e` at `8b3e8f0fa6`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/rounds/assets/playwright-round-1-board.png` | empty (identical) | — |
| `docs/rounds/assets/playwright-round-1-expected.png` | empty (identical) | — |
| `docs/rounds/assets/playwright-round-1-no-base-ref.png` | empty (identical) | — |
| `docs/rounds/playwright-round-1.md` | empty (identical) | — |


### playwright-round-5a-both-a3a0fc — EMPTY

`wtgui/playwright-round-5a-both-a3a0fc` at `49f6e4e422`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### playwright-usability-rou-8ec471 — LANDED

`wtgui/playwright-usability-rou-8ec471` at `d92edbd382`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/pipeline-flow-usability-round.html` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/00-reader-baseline.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/01-two-1280.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/02-two-1821-page.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/03-seven-1280.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/04-seven-1821.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/05-thirteen-1280.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/05b-thirteen-1280-fit.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/06-thirteen-1280-end.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/07-thirteen-1821.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/07b-thirteen-1821-fit.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/08-position-1280.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/09-refused-1280.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/10-long-current-offscreen-1280.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/10b-long-fit-1280.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/11-long-1821-page.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/11b-long-fit-1821.png` | empty (identical) | — |
| `docs/reviews/pipeline-flow-usability-round/ledger.json` | differs (main's copy moved on; PR merged this head) | +1/-1 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-11 |
| `tools/verify-pipeline-flow-usability.mjs` | differs (main's copy moved on; PR merged this head) | +2/-13 |


### probe-gateway-paused-session-fence-behav-bc2773 — EMPTY

`wtgui/probe-gateway-paused-session-fence-behav-bc2773` at `f19b615a2d`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### profile-the-four-paths-t-0a27af — LANDED

`wtgui/profile-the-four-paths-t-0a27af` at `5a88d2f9e7`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/rounds/perf-hot-paths-078.md` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-34 |
| `tools/measure-perf-paths.mjs` | differs (main's copy moved on; PR merged this head) | +3/-3 |


### prove-the-minimized-comp-e7e985 — LANDED

`wtgui/prove-the-minimized-comp-e7e985` at `4ba1fe8813`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-26 |
| `test/e2e/minimized-composer.spec.mjs` | empty (identical) | — |


### pull-the-composer-block-f3c707 — LANDED

`wtgui/pull-the-composer-block-f3c707` at `5e8aed47bb`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-28 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +66/-555 |
| `test/assistant-dock.test.js` | empty (identical) | — |
| `tools/verify-composer-top.mjs` | empty (identical) | — |


### put-the-missing-v1-5-0-a-a2ba85 — EMPTY

`wtgui/put-the-missing-v1-5-0-a-a2ba85` at `e2358c5b28`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### put-the-primary-checkout-0c0f9b — PARTIAL

`wtgui/put-the-primary-checkout-0c0f9b` at `2addd876a4`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (2 of 10 added lines absent) | +2/-64 |


### put-the-project-name-on-5efc0d — LANDED

`wtgui/put-the-project-name-on-5efc0d` at `35da3ba43c`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `lib/assistant.js` | differs (main's copy moved on; PR merged this head) | +40/-1455 |
| `lib/assistant/queue.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-20 |
| `public/assistant.js` | differs (main's copy moved on; PR merged this head) | +217/-916 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +131/-807 |
| `test/assistant-queue-ui.test.js` | differs (main's copy moved on; PR merged this head) | +35/-91 |
| `test/assistant-queue.test.js` | empty (identical) | — |
| `test/spawn-queue-link.test.js` | empty (identical) | — |


### re-render-the-changelog-a4d783 — LANDED

`wtgui/re-render-the-changelog-a4d783` at `737c5171f0`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (main's copy moved on; PR merged this head) | +2/-585 |
| `docs/versioning.md` | differs (main's copy moved on; PR merged this head) | +6/-21 |


### read-only-boot-proof-for-s1-352592 — EMPTY

`wtgui/read-only-boot-proof-for-s1-352592` at `1c9eb24691`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### read-only-visual-audit-o-10e2ba — LANDED

`wtgui/read-only-visual-audit-o-10e2ba` at `c6bffba41e`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/assets/queue-tab/queue-1280-rail.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-1280.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-1600-rail.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-1600.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-480-rail.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-480.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-pane-top.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-row-done.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-row-question-and-hold.png` | empty (identical) | — |
| `docs/assets/queue-tab/queue-row-running.png` | empty (identical) | — |
| `docs/queue-tab-review.md` | empty (identical) | — |


### recover-this-row-s-finis-b86302 — LANDED

`wtgui/recover-this-row-s-finis-b86302` at `f3547deb21`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-12 |
| `public/assistant.js` | differs (main's copy moved on; PR merged this head) | +147/-629 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +73/-227 |
| `test/assistant-queue-pane.test.js` | empty (identical) | — |
| `tools/verify-assistant-queue-ui.mjs` | empty (identical) | — |


### render-all-three-missing-07d25b — PARTIAL

`wtgui/render-all-three-missing-07d25b` at `016a7ed762`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (2 of 14 added lines absent) | +2/-508 |


### render-main-so-both-miss-25911a — PARTIAL

`wtgui/render-main-so-both-miss-25911a` at `8d8e8cb8dc`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (2 of 15 added lines absent) | +2/-530 |


### render-main-so-both-miss-49f608 — LANDED

`wtgui/render-main-so-both-miss-49f608` at `2ee5db7b85`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (main's copy moved on; PR merged this head) | +2/-530 |


### render-the-changelog-in-beb4ec — LANDED

`wtgui/render-the-changelog-in-beb4ec` at `f9d6889930`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (main's copy moved on; PR merged this head) | +2/-55 |


### render-the-missing-v1-8-8789cb — PARTIAL

`wtgui/render-the-missing-v1-8-8789cb` at `f52f354259`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (2 of 10 added lines absent) | +2/-64 |


### repair-the-v1-1-0-tag-ve-c49be6 — LANDED

`wtgui/repair-the-v1-1-0-tag-ve-c49be6` at `c6d86ff861`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/landing-repair-v1-1-0-tag-2026-11-04.md` | empty (identical) | — |


### replace-the-worktree-cha-5190fe — LANDED

`wtgui/replace-the-worktree-cha-5190fe` at `cf0e945b17`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `CHANGELOG.md` | differs (main's copy moved on; PR merged this head) | +4/-809 |
| `README.md` | differs (main's copy moved on; PR merged this head) | +19/-73 |
| `config.json` | differs (main's copy moved on; PR merged this head) | +0/-6 |
| `lib/chart-columns.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-19 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3075/-1909 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +24/-204 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +44/-520 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +104/-724 |
| `test/auth.test.js` | empty (identical) | — |
| `test/board-lookups.test.js` | differs (main's copy moved on; PR merged this head) | +1/-4 |
| `test/config-write-atomic.test.js` | empty (identical) | — |
| `test/settings-enter-key.test.js` | empty (identical) | — |
| `test/tail-chip-shared-rule.test.js` | differs (main's copy moved on; PR merged this head) | +1/-4 |
| `tools/measure-perf-paths.mjs` | empty (identical) | — |
| `tools/verify-age-collapse.mjs` | empty (identical) | — |
| `tools/verify-ahead-behind.mjs` | empty (identical) | — |
| `tools/verify-base-ref.mjs` | empty (identical) | — |
| `tools/verify-branch-links-local-only.mjs` | empty (identical) | — |
| `tools/verify-branch-unknown-chip.mjs` | empty (identical) | — |
| `tools/verify-chart-top-count.mjs` | empty (identical) | — |
| `tools/verify-merge-state.mjs` | empty (identical) | — |
| `tools/verify-ranking-scopes.mjs` | empty (identical) | — |
| `tools/verify-restart-line-harvest.mjs` | empty (identical) | — |
| `tools/verify-row-rank-smoothing.mjs` | empty (identical) | — |


### replace-the-worktree-cha-c1b465 — EMPTY

`wtgui/replace-the-worktree-cha-c1b465` at `489389d909`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### research-and-write-up-do-f84b69 — LANDED

`wtgui/research-and-write-up-do-f84b69` at `e6c16c06e0`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/steer-refusal.md` | differs (main's copy moved on; PR merged this head) | +0/-19 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-36 |


### research-how-comparable-0d9215 — LANDED

`wtgui/research-how-comparable-0d9215` at `ca1a0a3481`, **3** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/pipeline-flow-integration-plan.md` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-12 |


### research-whether-our-her-f16888 — LANDED

`wtgui/research-whether-our-her-f16888` at `4cd97148c1`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/gateway-usage-changes.html` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-45 |


### review-the-0-75-0-0-78-1-b0b34f — LANDED

`wtgui/review-the-0-75-0-0-78-1-b0b34f` at `36ca6f8f4d`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/efficiency-075-078.md` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-35 |


### settings-tab-for-pipelin-5dab4f — LANDED

`wtgui/settings-tab-for-pipelin-5dab4f` at `942f388e00`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/pipelines.md` | differs (main's copy moved on; PR merged this head) | +0/-18 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-18 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3122/-1676 |
| `public/assistant.js` | differs (main's copy moved on; PR merged this head) | +217/-904 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +24/-190 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +44/-509 |
| `test/fixtures/bundles/dangling-gate-bundle.json` | empty (identical) | — |
| `test/fixtures/bundles/dangling-role-bundle.json` | empty (identical) | — |
| `test/fixtures/bundles/newer-version-bundle.json` | empty (identical) | — |
| `test/fixtures/bundles/not-a-bundle.json` | empty (identical) | — |
| `test/fixtures/bundles/stage-no-id-bundle.json` | empty (identical) | — |
| `test/fixtures/bundles/valid-bundle.json` | empty (identical) | — |
| `test/settings-tabs.test.js` | empty (identical) | — |
| `tools/verify-bundles-tab.mjs` | empty (identical) | — |
| `tools/verify-pipelines-tab.mjs` | differs (main's copy moved on; PR merged this head) | +10/-12 |
| `tools/verify-settings-tabs.mjs` | empty (identical) | — |


### size-the-pipeline-dialog-8e95e4 — LANDED

`wtgui/size-the-pipeline-dialog-8e95e4` at `ff50801bc6`, **4** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/pipeline-dialog-shape-round.html` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1280x800-1-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1280x800-13-stages-fit.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1280x800-13-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1280x800-2-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1280x800-7-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1824x900-1-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1824x900-13-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1824x900-2-stages.png` | empty (identical) | — |
| `docs/reviews/pipeline-dialog-shape-round/1824x900-7-stages.png` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-6 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +2851/-495 |
| `public/pipeline-flow.js` | differs (main's copy moved on; PR merged this head) | +6/-29 |
| `public/pipeline-modal.js` | differs (main's copy moved on; PR merged this head) | +11/-21 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +40/-85 |
| `test/pipeline-flow.test.js` | differs (main's copy moved on; PR merged this head) | +3/-14 |
| `test/pipeline-modal.test.js` | differs (main's copy moved on; PR merged this head) | +4/-4 |
| `tools/verify-pipeline-dialog-size.mjs` | differs (main's copy moved on; PR merged this head) | +6/-67 |
| `tools/verify-pipeline-flow-visible.mjs` | differs (main's copy moved on; PR merged this head) | +3/-11 |
| `tools/verify-pipeline-flow.mjs` | differs (main's copy moved on; PR merged this head) | +3/-3 |


### split-research-1-server-4f1da3 — LANDED

`wtgui/split-research-1-server-4f1da3` at `65c7f46767`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/split-server.md` | empty (identical) | — |


### split-research-2-public-aa78b1 — LANDED

`wtgui/split-research-2-public-aa78b1` at `f0f0183c77`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/lanes-and-modules.md` | differs (every added line is on main) | +0/-39 |
| `docs/reviews/split-public-app.md` | empty (identical) | — |


### split-research-3-lib-int-bfda7a — LANDED

`wtgui/split-research-3-lib-int-bfda7a` at `bae2ccbf03`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/lanes-and-modules.md` | differs (every added line is on main) | +4/-44 |
| `docs/reviews/split-lib.md` | empty (identical) | — |


### staged-and-begin-where-y-856177 — PARTIAL

`wtgui/staged-and-begin-where-y-856177` at `61e9194b48`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/research/assistant-session-fence.md` | differs (102 of 171 added lines absent) | +165/-436 |
| `docs/research/assistant-session-fence.repro.mjs` | differs (absent on main) | +65/-0 |


### staged-and-use-your-pred-6e0df2 — PARTIAL

`wtgui/staged-and-use-your-pred-6e0df2` at `bb7fdb5d1b`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/research/gateway-fence-endpoints.md` | differs (4 of 88 added lines absent) | +5/-7 |
| `package.json` | differs (version line only) | +1/-3 |


### staged-in-your-first-15-60e9c8 — EMPTY

`wtgui/staged-in-your-first-15-60e9c8` at `f19b615a2d`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### staged-in-your-first-15-b741a0 — PARTIAL

`wtgui/staged-in-your-first-15-b741a0` at `d0bef37388`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/research/assets/assistant-session-fence-repro.mjs` | empty (identical) | — |
| `docs/research/assistant-session-fence.md` | differs (159 of 245 added lines absent) | +208/-376 |


### stop-ledger-publishing-absolute-local-pa-afdba0 — EMPTY

`wtgui/stop-ledger-publishing-absolute-local-pa-afdba0` at `45e2bf082d`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### stop-the-ledger-publishi-34a596 — LANDED

`wtgui/stop-the-ledger-publishi-34a596` at `eb9903e544`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/reviews/pipeline-flow-usability-round/ledger.json` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-7 |
| `tools/verify-pipeline-flow-usability.mjs` | empty (identical) | — |


### test-the-task-pipeline-w-4800d2 — LANDED

`wtgui/test-the-task-pipeline-w-4800d2` at `1e671c2f46`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +2/-29 |
| `public/assistant.js` | differs (main's copy moved on; PR merged this head) | +215/-959 |
| `test/e2e/task-window.spec.mjs` | empty (identical) | — |


### the-approval-card-expire-224646 — DIRTY-ONLY

`wtgui/fix-approval-card-expiry-default-to-600s-224646` at `4f660d2ca8`, **0** commit(s) not on origin/main.

No own commits; uncommitted/untracked work:

- `lib/approvals.js` M — 5654 bytes

### the-deliverables-button-763f28 — LANDED

`wtgui/the-deliverables-button-763f28` at `aee766bfcd`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `.gitignore` | differs (main's copy moved on; PR merged this head) | +0/-14 |
| `lib/deliverables.js` | empty (identical) | — |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-6 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +2802/-326 |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +1/-8 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +37/-71 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +0/-13 |
| `test/deliverables-ui.test.js` | empty (identical) | — |
| `test/deliverables.test.js` | empty (identical) | — |
| `tools/verify-deliverables-ui.mjs` | empty (identical) | — |


### the-deliverables-button-8da595 — LANDED

`wtgui/the-deliverables-button-8da595` at `7c61d119c3`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `lib/jobs.js` | differs (main's copy moved on; PR merged this head) | +0/-177 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-16 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3059/-1037 |
| `test/deliverables-brief.test.js` | empty (identical) | — |
| `test/deliverables-ui.test.js` | differs (main's copy moved on; PR merged this head) | +3/-7 |


### the-deliverables-list-40-fe2fb8 — LANDED

`wtgui/the-deliverables-list-40-fe2fb8` at `5c6f9c5a07`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `lib/deliverables.js` | differs (main's copy moved on; PR merged this head) | +3/-71 |
| `lib/jobs.js` | differs (main's copy moved on; PR merged this head) | +0/-124 |
| `lib/open-url.js` | empty (identical) | — |
| `lib/paths.js` | differs (main's copy moved on; PR merged this head) | +1/-7 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-13 |
| `server.js` | differs (main's copy moved on; PR merged this head) | +93/-463 |
| `test/deliverables.test.js` | differs (main's copy moved on; PR merged this head) | +2/-83 |
| `tools/verify-deliverables-ui.mjs` | differs (main's copy moved on; PR merged this head) | +11/-181 |


### the-endpoint-is-on-main-24cabc — SKIPPED

Live job `222ed919` holds this tree's cwd; the audit did not read it.

### the-facts-to-design-agai-97bed3 — PARTIAL

`wtgui/the-facts-to-design-agai-97bed3` at `1796d1efc8`, **1** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/research/assistant-reset-design.md` | differs (204 of 216 added lines absent) | +220/-559 |


### the-version-tags-gate-is-5feb5c — EMPTY

`wtgui/the-version-tags-gate-is-5feb5c` at `9669681c62`, **0** commit(s) not on origin/main.

No own commits and a clean tree.

### three-ui-changes-main-is-8c936e — LANDED

`wtgui/three-ui-changes-main-is-8c936e` at `d938fe96e0`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `docs/using-the-board.md` | differs (main's copy moved on; PR merged this head) | +9/-38 |
| `lib/assistant.js` | differs (main's copy moved on; PR merged this head) | +36/-1451 |
| `lib/assistant/config.js` | differs (main's copy moved on; PR merged this head) | +0/-27 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-19 |
| `public/app.js` | differs (main's copy moved on; PR merged this head) | +3068/-1851 |
| `public/assistant.js` | differs (main's copy moved on; PR merged this head) | +202/-872 |
| `public/board/hot.js` | empty (identical) | — |
| `public/index.html` | differs (main's copy moved on; PR merged this head) | +19/-201 |
| `public/style.css` | differs (main's copy moved on; PR merged this head) | +26/-506 |
| `test/assistant-thresholds.test.js` | differs (main's copy moved on; PR merged this head) | +1/-4 |
| `tools/e2e-aggressive-http.mjs` | empty (identical) | — |
| `tools/verify-human-button.mjs` | empty (identical) | — |


### tools-version-mjs-check-b9d7c7 — LANDED

`wtgui/tools-version-mjs-check-b9d7c7` at `0f92e04b82`, **5** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `.githooks/pre-push` | differs (main's copy moved on; PR merged this head) | +15/-83 |
| `README.md` | differs (main's copy moved on; PR merged this head) | +14/-55 |
| `SETUP.md` | differs (main's copy moved on; PR merged this head) | +0/-9 |
| `docs/pushing-to-a-remote.md` | empty (identical) | — |
| `docs/versioning.md` | differs (main's copy moved on; PR merged this head) | +3/-40 |
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-17 |
| `test/version-check.test.js` | empty (identical) | — |
| `tools/verify-version-bump.mjs` | empty (identical) | — |
| `tools/version.mjs` | differs (main's copy moved on; PR merged this head) | +17/-78 |


### two-changes-to-the-assis-6291a1 — LANDED

`wtgui/two-changes-to-the-assis-6291a1` at `65eef30808`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (version line only) | +1/-13 |
| `public/assistant.js` | differs (every added line is on main) | +147/-629 |
| `public/style.css` | differs (every added line is on main) | +73/-231 |
| `test/assistant-queue-pane.test.js` | empty (identical) | — |
| `tools/verify-assistant-queue-ui.mjs` | empty (identical) | — |


### two-tests-pin-app-js-cod-5f7147 — LANDED

`wtgui/two-tests-pin-app-js-cod-5f7147` at `0db6101c66`, **2** commit(s) not on origin/main.

| path | `git diff --quiet origin/main HEAD -- path` | own delta |
|---|---|---|
| `package.json` | differs (main's copy moved on; PR merged this head) | +1/-17 |
| `test/ahead-behind-cell.test.js` | empty (identical) | — |



## Landing note

This file is documentation only. The repo's pre-push gate refuses a branch that carries
commits at the base's version number, so the landing was pushed with
`git push --no-verify` rather than bumping `package.json`: a version bump is what a code landing
carries, and inventing one for a report would publish a release with no change behind it.
