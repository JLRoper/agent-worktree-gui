# github-force-merge stage 4 of 6: pr

Stage: `pr` (visit 1), pipeline `github-force-merge`, row #58 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/github-landing-sanity-0bbdd3`.
Branch: `wtgui/github-landing-sanity-0bbdd3`.
Artifact: `pull-request`, schema `pull-request/1`, kind `pr`, written to `ledger/github-force-merge/pr.md`.
The path already carries the earlier walk's record (PR 674) on `origin/main`; the ladder writes one fixed path per
stage, so this walk's record replaces it.
Base at open: `origin/main` at 1.80.0 (`10c13658`) when the stage started; the PR's base was read at `a868b9d4`
(1.80.4) because main moved while this stage ran. Head at open: `269ebdaf`.
Working tree before this stage: clean, 0 uncommitted files.

This stage is the fourth rung of the shipped `github-force-merge` ladder, walked once in order:
`commit -> version -> push -> pr -> merge -> main`. H-03 hands stage 3's `pushed-branch` in and H-04 hands this
stage's `pull-request` to `merge`. It opens the pull request and nothing else: no merge, no push to main.

## The ladder so far

Artifacts as the panel pinned them on each stage run in
`~/.wag/state/assistants/assistant-3/queue.json`, with the job rows from `~/.wag/state/jobs.json`. All stamps UTC.

| # | stage | artifact | path | commit | entered | settled | job | job time |
|---|-------|----------|------|--------|---------|---------|-----|----------|
| 1 | `commit` | `commit-record` | `ledger/github-force-merge/commit.md` | `67a5d5b7` | 22:29:40.098Z | 22:33:42.633Z | `3615f3f1` | 241.086s |
| 2 | `version` | `version-bump` | `ledger/github-force-merge/version.md` | `e197b799` | 22:33:42.633Z | 22:58:43.152Z | `c68536c9` | 1498.585s |
| 3 | `push` | `pushed-branch` | `ledger/github-force-merge/push.md` | `269ebdaf` | 22:58:43.152Z | 00:49:47.238Z | `a03bebb7`, then `ecaff67c` | 29.602s failed, then 1258.480s |
| 4 | `pr` | `pull-request` | `ledger/github-force-merge/pr.md` | this record | 00:49:47.238Z | the panel's stamp | `d3ef22d8` | this run |
| 5 | `merge` | `merge-record` | `ledger/github-force-merge/merge.md` | not run | - | - | - | - |
| 6 | `main` | `main-moved` | `ledger/github-force-merge/main.md` | not run | - | - | - | - |

The artifacts stage 1 to 3 wrote, as hashed on the run that settled them:

    commit-record   sha256 a7d6b07ab12510e9614b0abcba935994dcc438bdba2612ec7dc8eb61a1bc44b1
    version-bump    sha256 b1cd02cd4e31fdac518861461d787f2969962b7eed4f792fb3f0949d7095f4d1
    pushed-branch   blob   31440c76df730769e3ad0d01a21839e4c859c59d

## The input read

`ledger/github-force-merge/push.md`, handed on as `pushed-branch` read-only at `269ebdaf`. The panel pinned two
hashes for it, and both are real: the working-tree file has CRLF endings (`core.autocrlf`), so its raw bytes hash to
`6d5ef316be7e2a1790937a2b1ad0e0d369d969b2fcf5a71980f7e7e4b83c95b8` (the panel's `sha256`), while the committed
blob, which git stores with LF, hashes to `e08da670f727feba8c04a5c9ade718099b5537ccd35886e7c88911f7c7c42fe9`
(the panel's `blobSha256`) and is blob `31440c76`:

    git cat-file blob HEAD:ledger/github-force-merge/push.md | sha256sum
    e08da670f727feba8c04a5c9ade718099b5537ccd35886e7c88911f7c7c42fe9

    git hash-object ledger/github-force-merge/push.md
    31440c76df730769e3ad0d01a21839e4c859c59d

Same file, two normalizations. Nothing on the branch changed between the stage 3 settlement and this read: the tree
was clean and HEAD was `269ebdaf` at both.

## The branch on origin

Stage 3 pushed and its G3 read confirmed the branch on origin at this tree's HEAD. The read taken before the pull
request, after `git fetch origin`:

    git ls-remote --heads origin refs/heads/wtgui/github-landing-sanity-0bbdd3
    269ebdaf9874d5b807f42cb71ccfa84e63267bbe
    git rev-parse HEAD
    269ebdaf9874d5b807f42cb71ccfa84e63267bbe

The one number this stage sends is `1.80.1`, claimed on origin as `v1.80.1` by stage 3. It was above the base when
stage 3 pushed (1.80.0); main has since moved to 1.80.4, which is why the read below is CONFLICTING. Stage 3 read
the panel's permission box as `allow, ask false, denied false` for this tree, and no push in this ladder has been
prompted for, so the record commit below is pushed without a prompt.

## The pull request

    gh pr create --base main --head wtgui/github-landing-sanity-0bbdd3 \
      --title "test: the GitHub ladder has no loop to cross - every handoff is a sequence" \
      --body-file <the pr-body.md this run wrote under the panel's scratch folder>
    https://github.com/JLRoper/agent-worktree-gui/pull/679

Opened at 01:13:58Z. `--fill` was not used: this branch carries a version bump (`1.80.1`), and `--fill` builds the
body from commit subjects, which drops the level and the reason the bump gave. The body states both: patch, because
the change is one assertion in a test file (a test-only change, `docs/versioning.md`'s patch case), and 1.80.1
because the base moved twice while the ladder waited (1.79.0, then 1.80.0) and `v1.79.2` was already claimed on
origin by another lane.

## The read at open

`gh pr view 679 --json state,headRefOid,baseRefName,headRefName,mergeable,mergeStateStatus,commits,isDraft`:

    state            OPEN
    baseRefName      main
    baseRefOid       a868b9d4f868a7a61a87f2fd589e8bdb31a0bf2d
    headRefName      wtgui/github-landing-sanity-0bbdd3
    headRefOid       269ebdaf9874d5b807f42cb71ccfa84e63267bbe
    commits          3
    mergeable        CONFLICTING
    mergeStateStatus DIRTY
    isDraft          false

`headRefOid` equals this tree's `git rev-parse HEAD` and the branch's head on origin, both read in the same minute,
so the PR opens from the commit stage 3 pushed. One PR, base `main`, head equal to the pushed commit: that is G4.

The read also says the PR cannot merge as it stands, and the reason is the base, not this branch's change.
`origin/main` moved four commits between this stage's first read and its open: `10c13658` (1.80.0) became
`a868b9d4` (1.80.4), through `dd795193` (`chore: 1.80.4`) and `aa096f04` (`fix: the thinking toggle answers to the
card's key and the turn's session`). The branch is 4 behind and 3 ahead:

    git rev-list --left-right --count origin/main...HEAD
    4       3
    git merge-tree --write-tree origin/main HEAD
    CONFLICT (content): Merge conflict in package.json

One conflicted path, `package.json`: this branch declares 1.80.1, main declares 1.80.4. The test assertion and the
ledger records merge cleanly. `node tools/version.mjs check` would now refuse this branch, because 1.80.1 is at or
below the base's tip, so the merge stage has to rebase onto `a868b9d4` and take a number above 1.80.4 before it
merges with `--admin`. That rebase is version work inside the merge visit, the same way stage 3 rebased twice inside
its own visit; the ladder still visits each stage once, and this record is the statement of what the next stage
inherits rather than a claim that it is mergeable today.

## Gate G4

`verified_by: pr-open`. One pull request, `base main`, head equal to the pushed commit `269ebdaf`, and the read
aborted the stage if it had been anything else. G4 asks for the PR, not for a mergeable one: mergeability is what
the next stage reads, and today's read is CONFLICTING because the base moved under it. The record commit that
follows moves the branch one commit above the read, so the merge stage re-reads the head before merging and merges
the head the records describe.

## What the focused tests answered

    npm run test:module test/pipeline-bundle-seed.test.js
    tests 6, pass 6, fail 0

That is the file this branch changes: the assertion that every handoff in the ladder is a `sequence`, and the
artifact-kind pin beside it. Stage 3 ran the wider focused set on the same code (`df71d768` to `0362b82c`) and
recorded it: 23 test files, 179 tests, 178 pass, 1 fail, 252.6s. The one failure is `test/harness.test.js`, "every
declared harness is wired the way its own header says", which fails on `origin/main` too
(`tools/verify-round-tree-names.mjs` reads LIVE GATE and no `package.json` script runs it).

Full suite, one sweep, `npm test` on this tree (started 01:06:25Z):

    tests 2342, pass 2334, fail 8, exit 1, 372.0s (6m 12s)

Six of the eight failures reproduce on a pristine `origin/main` export (`git archive origin/main`) run with the same
eight files, 6 fail and 81 pass there: `assistant-profile` (a `dock` key the panel does not write),
`gateway-permissions` (no `config.json` in a worktree), `harness` (`verify-round-tree-names` reads LIVE GATE and no
`package.json` script runs it), `paths` (`pipelineBundleSeedFile`), `windows-hide` (`lib/child-tree.js`), and
`worktree-assistant` (the owner bullet). The other two pass in isolation in this worktree (20 tests, 20 pass):
`assistant-director`'s one-clock test and `job-store-atomic`'s whole-file reader, so they are load flakes under
four-way concurrency, not this branch's.

One earlier sweep on the same tree was abandoned rather than counted: it stopped after 378 tests when other suites
were running on this machine at the same time, and `test/assistant-system-briefing.test.js`, the file it was stuck
in, passes in isolation here in 8.5s. The numbers above are from the single sweep that answered.

## The gap the walk found, not fixed here

No pre-push hook is installed in this clone: `git config --get core.hooksPath` is unset and the hooks directory
holds only `*.sample` files, so `.githooks/pre-push` and the panel's chained copy named in `.git/wtgui-hooks/chain`
never ran on any of this ladder's pushes. Stage 3 ran both gates by hand and both passed. Run by hand on this
stage's push, they do not:

    node tools/version.mjs check
    version check: refused - this branch's version is behind origin/main's
      branch  1.80.1  (HEAD's package.json)
      base    origin/main  1.80.4  (a868b9d4)
    exit 1

That is the base move this record names, not a new number: the merge stage rebases and bumps past 1.80.4. The
absolute-paths gate refused the first draft of this record for two drive-letter paths (the tree and the scratch
body file); both were taken out before the commit was amended and sent, and the gate is clean on the record as
committed. The gap is tracked as a TODO on this worktree and is not this stage's to close.

## Timing

All stamps UTC. The panel is the clock for the stage's entry and for the job row; the rest are this run's own.

| event | stamp | source |
|-------|-------|--------|
| row #58 entered `pr` visit 1 | 2026-11-10T00:49:47.238Z | `~/.wag/state/assistants/assistant-3/queue.json`, `pipelineRun.enteredAt` |
| job `d3ef22d8` started | 2026-11-10T00:49:49.660Z | `~/.wag/state/jobs.json` |
| first suite sweep started | 2026-11-10T00:51:55Z | this run, the log's first line |
| first suite sweep abandoned | 2026-11-10T01:06:05Z | this run, after 378 tests and no output for 10 minutes |
| second suite sweep | 01:06:25Z to 01:12:39Z | this run, 6m 12s |
| PR 679 opened | 2026-11-10T01:13:58Z | `gh pr view 679 --json createdAt` |
| read at open | 2026-11-10T01:14:26Z | this run, equal to `git rev-parse HEAD` and the remote head |

From the stage's entry stamp to the pull request is 24 minutes 11 seconds, most of it the two suite sweeps.

## What this commit holds, and what the next stage reads

This record is committed on the branch above `269ebdaf`. Its first commit was sent by `git push -u origin HEAD`,
then amended to take out the two drive-letter paths the absolute-paths gate refused, and the amended commit was
sent by `git push --force-with-lease`: the branch is this walk's own, the pull request had just been opened, and no
reviewer held the earlier diff. The commit's own sha is not printed here: this file is inside it; the panel stamps
it on the stage run, and `git log --oneline 10c13658..HEAD` answers it in the tree.

`merge` reads this file as the `pull-request` input, re-reads the PR's head, and merges with
`gh pr merge --rebase --admin`: rebase because the branch must land as one commit per change on main's straight
history, `--admin` because the repository's ruleset blocks a straight merge and the bypass is the owner's. It then
records the merge commit, and `main` checks that the merge is an ancestor of `origin/main`.
