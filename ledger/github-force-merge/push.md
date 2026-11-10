# github-force-merge stage 3 of 6: push

Stage: `push` (visit 1), pipeline `github-force-merge`, row #1 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/pipeline-row-rung-2-6f9dd4`, in the agent-worktree-gui clone.
Branch: `wtgui/pipeline-row-rung-2-6f9dd4`.
Artifact: `pushed-branch`, schema `pushed-branch/1`, kind `pr`, written to `ledger/github-force-merge/push.md`.
The path already carries the earlier walk's record on `origin/main` (row #58, branch
`wtgui/github-landing-sanity-0bbdd3`, committed as `3edc1bf5`); the ladder writes one fixed path per stage, so this
walk's record replaces it, and that replacement is a conflict this branch's pull request will show against main's
copy of this file.
Base and HEAD at the push: `origin/main` at `23fbe197` (reading 1.80.8) and HEAD `fefe4001`, two commits above it.
Working tree before this stage: clean, 0 uncommitted files.

This stage is the third rung of the shipped `github-force-merge` ladder, walked once in order:
`commit -> version -> push -> pr -> merge -> main`. H-02 hands stage 2's `version-bump` in and H-03 hands this
stage's `pushed-branch` to `pr`. It pushes the branch and the version's claim, and nothing else: stage 4 owns the
pull request, so no pull request was opened here and `gh pr create` was not run.

## The ladder so far

| # | stage | artifact | path | entered / settled | artifact sha256 |
|---|-------|----------|------|-------------------|-----------------|
| 1 | `commit` | `commit-record` | `ledger/github-force-merge/commit.md` | 03:24:25.112Z / 03:35:45.317Z | `860a928d...` |
| 2 | `version` | `version-bump` | `ledger/github-force-merge/version.md` | 03:35:45.317Z / 03:43:50.825Z | `bebde57f...` |
| 3 | `push` | `pushed-branch` | `ledger/github-force-merge/push.md` | 03:43:50.825Z / this visit, job `0aa282c6` started 03:43:52.005Z | this file |

Row #1's `pipelineRun` reads `visits` `commit: 1, version: 1, push: 1` and `crossings` `H-01: 1, H-02: 1`, which is
the no-loop statement this ladder is being walked to prove: three stages entered once each, two handoffs crossed
once each, no re-entry.

Stages 4 to 6 (`pr`, `merge`, `main`) have not run. Their stamps belong to the panel when each of those stages
starts and settles; this stage cannot measure a clock it never held.

## The input read

`ledger/github-force-merge/version.md`, handed on as `version-bump` read-only at `fefe40018cee`, pinned at sha256
`cfbe492932b2` and blob `d57bf7307d1c`. Both pinned values reproduce from that commit:

    git cat-file blob fefe40018cee:ledger/github-force-merge/version.md | sha256sum
    cfbe492932b28d2cc62e5c4cb94e7c3fab5abe52d9e364f699f3e4402e418c0b

    git rev-parse fefe40018cee:ledger/github-force-merge/version.md
    d57bf7307d1ce3313f6314cd1f839b74da9ed441

The checked-out copy hashes to a third value, and that is the panel's third field, not drift:

    sha256sum ledger/github-force-merge/version.md
    bebde57fc05b335aff695048295ee5b2580b0beb31a603cbe50061b126fc06c8

`bebde57f` is the `sha256` the panel pinned on the `version` stage run, because this clone checks out CRLF
(`core.autocrlf`) while git stores LF; the LF form is the `cfbe4929` blob hash the brief names. All three agreed
with the panel before this stage wrote anything.

## The permission

The LANDING paragraph this row carries is the grant: this project allows remote writes, so a push is not asked
about, and the paragraph is what decides whether the push happens at all. It ordered the push ("commit on
`wtgui/pipeline-row-rung-2-6f9dd4`, push it and open a pull request"), so the push was taken and no permission box
was reached. Stage 2's record named this stage as the one that carries the branch and the tag together, which is
the claim below.

Nothing was pushed to `main`. The push below names `HEAD`, and `HEAD` is the stage branch.

## The push

All stamps UTC.

    git push -u origin HEAD                       # 03:47:11Z, exit 0
    remote:
    remote: Create a pull request for 'wtgui/pipeline-row-rung-2-6f9dd4' on GitHub by visiting:
    remote:      https://github.com/JLRoper/agent-worktree-gui/pull/new/wtgui/pipeline-row-rung-2-6f9dd4
    remote:
    To github.com:JLRoper/agent-worktree-gui.git
     * [new branch]        HEAD -> wtgui/pipeline-row-rung-2-6f9dd4
    branch 'wtgui/pipeline-row-rung-2-6f9dd4' set up to track 'origin/wtgui/pipeline-row-rung-2-6f9dd4'.

It carried both commits above `origin/main`:

    fefe4001 chore: 1.80.9 - the version this landing carries
    f3612b12 docs: the GitHub ladder has no loop to cross - all five handoffs are sequence

## The claim

A branch's number is reserved by pushing its tag, and stage 2 left `v1.80.9` local and unclaimed by design. This
stage is where origin learns the number:

    node tools/version.mjs claim                  # 03:47:14Z, exit 0
    version claim: v1.80.9 claimed on origin at fefe40018c (attempt 1)
      the claim is the annotated tag: git ls-remote --tags origin carries v1.80.9, so a lane that asks for it is
      refused.

The claim took one attempt and rewrote nothing: the number was free on origin when it was taken (`git ls-remote
--tags origin 'refs/tags/v1.80.9*'` printed nothing at 03:44Z), so the tag was already on the declaring commit and
the push was the whole claim. `HEAD` still read `fefe4001` after it.

    git ls-remote --tags origin refs/tags/v1.80.9 'refs/tags/v1.80.9^{}'
    ccd12da1d91d927c805ae72053ed5173924b0a53    refs/tags/v1.80.9
    fefe40018ceed233a67a7f9969103eced5818fa9    refs/tags/v1.80.9^{}

The annotated tag object is `ccd12da1` and it peels to the bump commit, so the number and the branch agree on
origin. A rebase merge re-creates that commit; moving the anchor onto main's copy is the merge stage's post-merge
step, not this stage's.

## Gate G3

`verified_by: pushed`. The read that answers it, taken at 03:47:33Z, after the push and the claim:

    git ls-remote --heads origin refs/heads/wtgui/pipeline-row-rung-2-6f9dd4
    fefe40018ceed233a67a7f9969103eced5818fa9    refs/heads/wtgui/pipeline-row-rung-2-6f9dd4
    git rev-parse HEAD
    fefe40018ceed233a67a7f9969103eced5818fa9

The two 40-character shas are the same, so at that instant the branch was on origin at this tree's HEAD. This record
is committed on top of that head by design, and the commit is sent by a second `git push -u origin HEAD` in this same
stage, so the head the `pr` stage reads is this record's commit and not `fefe4001`. The same two reads were taken
after the second push and are quoted under "What this commit holds" below.

## The gates that should have run

No pre-push hook is installed in this clone: `git config --get core.hooksPath` is unset (exit 1) and the common
hooks directory holds no file that is not a `*.sample`. The panel's chain file names the repository's hook
(`.githooks/pre-push`), but nothing invokes it, so neither push was guarded by it. The gates were therefore run by
hand, on the pushed commits, and are quoted as the check that would have stopped an unbumped or machine-pathed push,
not as one that stopped anything:

    node tools/version.mjs check
    version check: ok - the branch's number is above origin/main's
      branch  1.80.9  (HEAD's package.json)
      base    origin/main  1.80.8  (23fbe197)
      2 commits to land on top of origin/main
    exit 0

    node tools/absolute-paths.mjs
    absolute-paths: clean - 1461 tracked files, 1309 paths in 249 allowlisted files, none new
    exit 0

The second read is also re-taken at the final HEAD, after this record's commit, and quoted below; this one is the
read on the pushed change commits.

## What the focused tests answered

    npm run test:changed -- --list
    test:changed - 5 changed files against origin/main:
      docs/pipelines.md
      ledger/github-force-merge/commit.md
      ledger/github-force-merge/version.md
      package.json
      tools/absolute-paths.allow
    test:changed - 27 test files name or import the diff (27 by name, 0 by import)

    npm run test:changed
    tests 230, pass 229, fail 1, duration 1m 54s, exit 1

The one failure is `test/harness.test.js`, "every declared harness is wired the way its own header says":
`tools/verify-round-tree-names.mjs` says `HARNESS: LIVE GATE` and no `package.json` script runs it. It is
pre-existing and not this branch's, proved rather than asserted: `origin/main` was exported to the run's own scratch
folder (`git archive origin/main | tar -x -C <scratch>/base`) and the same file run there produced the identical
failure at `test/harness.test.js:88`. The branch cannot have caused it either: the only change it makes to
`package.json` is the version line, `origin/main`'s `package.json` has zero occurrences of
`verify-round-tree-names`, and the tool's header says LIVE GATE on `origin/main` too.

The full suite was not run here. This stage opens no pull request, and the one final sweep the landing owes belongs
to the `pr` stage, which is the stage that opens it.

## Timing

All stamps UTC. The panel is the clock for the row and job rows; the rest are this stage's own.

| event | stamp | source |
|-------|-------|--------|
| stage 1 settled, H-01 crossed | 2026-11-10T03:35:45.317Z | the panel's queue file, `stageRuns[0].settledAt` |
| stage 2 settled, H-02 crossed | 2026-11-10T03:43:50.825Z | same file, `stageRuns[1].settledAt` |
| row #1 entered `push` visit 1 | 2026-11-10T03:43:50.825Z | same file, `pipelineRun.enteredAt` / `stageRuns[2].at` |
| job `0aa282c6` started | 2026-11-10T03:43:52.005Z | the panel's `jobs.json` |
| input hashes read | 03:44:23Z | this run |
| `node tools/version.mjs check` read | 03:44:23Z | this run |
| `git push -u origin HEAD` | 03:47:11Z to 03:47:14Z | this run |
| `node tools/version.mjs claim` | 03:47:14Z to 03:47:28Z | this run |
| remote head read equal to HEAD | 03:47:33Z | this run |

From the stage's entry stamp to the pushed head is 3 minutes 42 seconds: two short reads, one 1m 54s focused suite
run before the push, and the two pushes. The `pr` stage's own stamps are not in this file.

## What this commit holds

This record is committed on top of `fefe4001` and sent by a second `git push -u origin HEAD` in this same stage. The
commit's own sha is not printed here: this file is inside it. The panel stamps it on the stage run as the artifact's
commit, and `git log --oneline origin/main..HEAD` answers it in the tree. One file changes: this record. The commit
is revertable on its own, and reverting it removes the record and nothing else.

The final remote read, taken after that push:

    git ls-remote --heads origin refs/heads/wtgui/pipeline-row-rung-2-6f9dd4   # equals git rev-parse HEAD
    node tools/version.mjs check                                              # ok, 1.80.9 above 1.80.8
    node tools/absolute-paths.mjs                                             # clean, none new
    git status --porcelain                                                    # empty

## What the next stage reads

`pr` reads this file as the `pushed-branch` input (schema `pushed-branch/1`, kind `pr`) and opens ONE pull request
from `wtgui/pipeline-row-rung-2-6f9dd4` into `main`. It reads the branch's head after this record's commit, not
`fefe4001`, so the head it opens from is one commit above the pushed change.

The number to state in the body is 1.80.9, claimed on origin as the annotated tag `v1.80.9` (`ccd12da1`, peeling to
`fefe4001`), which is patch above `origin/main`'s 1.80.8. The body has to carry the level and its reason, because
`gh pr create --fill` builds a body from commit subjects only.

The one conflict to expect against `main` is this file: `main` carries the earlier walk's `push.md`, and this record
replaces it whole. `ledger/github-force-merge/commit.md` and `version.md` conflict the same way, for the same reason,
and are resolved by keeping this walk's copies.
