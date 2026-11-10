# github-force-merge stage 3 of 6: push

Stage: `push` (visit 1), pipeline `github-force-merge`, row #58 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/github-landing-sanity-0bbdd3`.
Branch: `wtgui/github-landing-sanity-0bbdd3`.
Artifact: `pushed-branch`, schema `pushed-branch/1`, kind `pr`, written to `ledger/github-force-merge/push.md`.
The path already carries the earlier walk's record on `origin/main`; the ladder writes one fixed path per stage, so
this walk's record replaces it, and that replacement is one of the conflicts named below.
Base and HEAD at the final push: `origin/main` at 1.80.0 (`10c13658`) and HEAD `0362b82c`.
Working tree before this stage: clean, 0 uncommitted files.

This stage is the third rung of the shipped `github-force-merge` ladder, walked once in order:
`commit -> version -> push -> pr -> merge -> main`. H-02 hands stage 2's `version-bump` in and H-03 hands this
stage's `pushed-branch` to `pr`. It pushes the branch and nothing else: stage 4 owns the pull request, and no pull
request was opened here.

## The ladder so far

| # | stage | artifact | path | stamp | sha256 |
|---|-------|----------|------|-------|--------|
| 1 | `commit` | `commit-record` | `ledger/github-force-merge/commit.md` | run 22:29:40.098Z, settled 22:33:42.633Z | `a7d6b07a...` |
| 2 | `version` | `version-bump` | `ledger/github-force-merge/version.md` | run 22:33:42.633Z, settled 22:58:43.152Z | `b1cd02cd...` |
| 3 | `push` | `pushed-branch` | `ledger/github-force-merge/push.md` | run 22:58:43.152Z, this attempt 00:28:43.565Z | this file |

Stages 4 to 6 (`pr`, `merge`, `main`) have not run. Their stamps belong to the panel when each of those stages
starts and settles; this stage cannot measure a clock it never held.

## The input read

`ledger/github-force-merge/version.md`, handed on as `version-bump` read-only at `e197b799ed4c`, pinned at sha256
`b1cd02cd4e31`. In this tree the file's blob still hashes to that value at HEAD:

    git cat-file blob HEAD:ledger/github-force-merge/version.md | sha256sum
    b1cd02cd4e31fdac518861461d787f2969962b7eed4f792fb3f0949d7095f4d1

Stage 1's `commit.md` was checked the same way and still reads `a7d6b07ab125...`. Both records rode the rebases that
follow byte for byte, so the content the panel handed on is the content this branch carries.

## The base moved twice under the stage

`origin/main` advanced twice while the ladder waited, and neither move was this branch's:

| read | origin/main | version |
|------|-------------|---------|
| stage 2's read, 22:55Z | `621ff6c6` | 1.76.27 |
| this stage's first fetch, 00:29Z | `47ee919b` | 1.79.0 |
| the first rebase's target, 00:35Z | `4b06bbec` | 1.79.0 |
| the fetch that forced the second rebase, 00:44Z | `10c13658` | 1.80.0 |

The version gate refuses a branch that declares a number at or below the base's current tip, so the branch could not
be pushed at stage 2's 1.76.29. The bump commit was rebased and re-taken twice:

1. Onto `4b06bbec` (1.79.0), with `package.json` conflicted and resolved to 1.79.1. That is the number the first
   push carried.
2. Onto `10c13658` (1.80.0), after main landed `548f8a6e` (`chore: 1.80.0`) at 00:40:54Z and its render at 00:41:49Z.
   `package.json` was conflicted again and resolved to 1.80.1, one patch above the new base. `v1.79.2` was already
   claimed on origin by another lane and was stepped past, so the number taken is 1.80.1.

The conflicts were only where earlier walks and main's own records meet:
`ledger/github-force-merge/commit.md` and `ledger/github-force-merge/version.md` are add/add against the records of
the earlier walk that main already carries, and were resolved by keeping this walk's handed-on records;
`tools/absolute-paths.allow` merged cleanly with this branch's one line appended; `package.json` was resolved by hand
to 1.80.1 both times. The bump commit's subject and body were amended to the number it now declares, and the
annotated tag follows that commit.

The push stage did not rewrite stage 2's number: `version.md` is the artifact the panel handed on pinned, so it keeps
the number it judged (1.76.29) and this record carries both base moves instead.

## The permission

The panel's remote-write answer, read at 00:38:36Z:

    permission allow, ask false, denied false
    repo github/JLRoper, branch wtgui/github-landing-sanity-0bbdd3
    newSource project, existingSource project

The push was not asked about. The permission box is the only thing that grants a write, and it granted it.

## The push

All stamps UTC.

    git push -u origin HEAD                       # 00:43:28Z
    * [new branch]  HEAD -> wtgui/github-landing-sanity-0bbdd3
    branch 'wtgui/github-landing-sanity-0bbdd3' set up to track 'origin/wtgui/github-landing-sanity-0bbdd3'
    exit 0

That push carried `62ae1283` (the 1.79.1 bump) and `1c5cd72b` (the test and stage 1's record). Main had already
moved to 1.80.0 at 00:40:54Z, three minutes before it, so the branch was rebuilt on the new base as described above
and sent again:

    git push --force-with-lease origin HEAD       # 00:46:59Z
     + 62ae1283...0362b82c HEAD -> wtgui/github-landing-sanity-0bbdd3 (forced update)
    exit 0

The force is the branch being rewritten by design, before any pull request exists: same change, new base, and no
reviewer holding a diff of `62ae1283`.

The claim on the number went with the push. `node tools/version.mjs claim` printed:

    version claim: v1.80.1 claimed on origin at 0362b82ccc (attempt 1)

and `git ls-remote --tags origin refs/tags/v1.80.1` carries it (tag object `dd086b3b`), so a lane that asks for
1.80.1 is refused. The tag names the bump commit `0362b82c`; a rebase merge re-creates that commit, and moving the
anchor onto main's copy is the merge stage's post-merge step, not this stage's.

## Gate G3

`verified_by: pushed`. The read that answers it, taken after the force push:

    git ls-remote --heads origin refs/heads/wtgui/github-landing-sanity-0bbdd3
    0362b82ccc3165aeb96f59012ce6728d53f4a521
    git rev-parse HEAD
    0362b82ccc3165aeb96f59012ce6728d53f4a521

The two 40-character shas are the same, so the branch is on origin at this tree's HEAD. That is the whole of G3: the
pull request stage reads this head, and the record commit that follows adds one more commit above it.

## The gates that should have run

No pre-push hook is installed in this clone: `git config --get core.hooksPath` is unset and the hooks directory
holds only `*.sample` files, so `.githooks/pre-push` (and the panel's chained copy named in
`.git/wtgui-hooks/chain`) never ran on either push. The two gates were run by hand on the pushed commit and are
quoted as the check that should have stopped an unbumped or machine-pathed push, not as one that stopped anything:

    node tools/version.mjs check
    version check: ok - the branch's number is above origin/main's
      branch  1.80.1  (HEAD's package.json)
      base    origin/main  1.80.0  (10c13658)
      2 commits to land on top of origin/main
    exit 0

    node tools/absolute-paths.mjs --rev HEAD
    absolute-paths: clean - 1455 files at HEAD, 1311 paths in 250 allowlisted files, none new
    exit 0

The first push went out with the version check green against `4b06bbec` (1.79.0) and main landing 1.80.0 while the
focused suite ran. The branch was not left in that state: the second rebase and the 1.80.1 bump are what the force
push sent.

## What the focused tests answered

    npm run test:module test/pipeline-bundle-seed.test.js
    tests 6, pass 6, fail 0, exit 0

    npm run test:changed
    5 changed files against origin/main, 23 test files name or import the diff
    179 tests, pass 178, fail 1, 252.6s, exit 1

The one failure is `test/harness.test.js`, "every declared harness is wired the way its own header says": it says
`tools/verify-round-tree-names.mjs` is a LIVE GATE and no `package.json` script runs it. It fails on `origin/main` as
well (`git show origin/main:package.json` has no `verify-round-tree-names` script while the tool's header reads LIVE
GATE), so it is pre-existing and not this branch's. The seed test itself is green with the pin in place, which is its
own statement that the ladder has no loop. The full suite is the pull request stage's single final sweep.

## Timing

All stamps UTC. The panel is the clock for the row and job rows; the rest are this stage's own, with the rebase
stamps read from the reflog.

| event | stamp | source |
|-------|-------|--------|
| row #58 entered `push` visit 1 | 2026-11-09T22:58:43.152Z | `~/.wag/state/assistants/assistant-3/queue.json`, `pipelineRun.enteredAt` |
| attempt 1 job `a03bebb7` started | 2026-11-09T22:58:45.888Z | `~/.wag/state/jobs.json` |
| attempt 1 ended failed, no final message | 2026-11-09T22:59:15.490Z | same file, `completion.at`, `durationMs` 29602 |
| panel recorded `pipeline-run-failed` | 2026-11-09T22:59:20.453Z | queue.json, `stageRuns[2].decision` |
| attempt 2 stage run `push#1.2` stamped | 2026-11-10T00:28:43.565Z | queue.json, `stageRuns[3].at` |
| attempt 2 job `ecaff67c` started | 2026-11-10T00:28:45.409Z | jobs.json |
| first rebase start / finish | 00:35:26Z / 00:36:29Z | `git reflog --date=iso` |
| bump amended to 1.79.1 | 00:36:54Z | reflog |
| first push | 00:43:28Z | this run |
| second rebase start / finish | 00:44:38Z / 00:45:52Z | reflog |
| bump amended to 1.80.1 | 00:45:53Z | reflog |
| `v1.80.1` claimed on origin | 00:46:30Z | this run, `version.mjs claim` |
| force push of the rebuilt branch | 00:46:59Z | this run |
| remote head read equal to HEAD | 00:47:02Z | this run |

Attempt 1 failed 30 seconds in with no final message and wrote no artifact: it is the reason this stage shows two
attempts, and the panel's own decision record says it waits for a decision rather than re-running the stage. Attempt
2 is this file. From attempt 2's stage stamp (00:28:43.565Z) to the final pushed head (00:46:59Z) is 18 minutes 15
seconds, of which the two rebases, the focused suite (252.6s) and the wait for main to settle account for the bulk.
The stage entered at 22:58:43.152Z; the whole visit, across both attempts and the failed one's gap, is 1 hour 48
minutes 16 seconds.

## What this commit holds, and what the next stage reads

This record is committed on the branch above `0362b82c` and sent by a second `git push -u origin HEAD` in this same
stage, which is a fast-forward from the forced head and rewrites nothing. The commit's own sha is not printed here:
this file is inside it. The panel stamps it on the stage run as the artifact's commit, and
`git log --oneline 10c13658..HEAD` answers it in the tree.

`pr` reads this file as the `pushed-branch` input and opens ONE pull request from this branch into main. The head it
opens from is the branch's head after this record's commit; the number to state in the body is 1.80.1, claimed on
origin as `v1.80.1`, and both base moves are in the bump commit's body so main's history accounts for the number it
ends on.
