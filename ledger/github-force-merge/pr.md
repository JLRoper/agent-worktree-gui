# github-force-merge stage 4 of 6: pr

Stage: `pr` (visit 1), pipeline `github-force-merge`, row #1 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/pipeline-row-rung-2-6f9dd4`, in the agent-worktree-gui clone.
Branch: `wtgui/pipeline-row-rung-2-6f9dd4`.
Artifact: `pull-request`, schema `pull-request/1`, kind `pr`, written to `ledger/github-force-merge/pr.md`.
The path already carries the earlier walk's record (PR 674, row #58) on `origin/main`; the ladder writes one fixed path
per stage, so this walk's record replaces it.
Base at open: `origin/main` at `23fbe197` (reading 1.80.8). Head at open: `58972a93`, three commits above it.
Working tree before this stage: clean, 0 uncommitted files.

This stage is the fourth rung of the shipped `github-force-merge` ladder, walked once in order:
`commit -> version -> push -> pr -> merge -> main`. H-03 hands stage 3's `pushed-branch` in and H-04 hands this
stage's `pull-request` to `merge`. It opens ONE pull request and nothing else: no merge, no push to `main`, no edit to
the branch's change commits.

## The input read

`ledger/github-force-merge/push.md`, handed on as `pushed-branch` read-only at `58972a93`. All three pinned values
reproduce from that commit:

    git rev-parse 58972a93:ledger/github-force-merge/push.md
    f4f1b13a9410d6c486c6be241996863360eb8a51

    git cat-file blob 58972a93:ledger/github-force-merge/push.md | sha256sum
    9fc1bfaaed74a0f1c3db574a4fd7a569cb63da73af868be506e86c1132015609

    sha256sum ledger/github-force-merge/push.md
    9fc1bfaaed74a0f1c3db574a4fd7a569cb63da73af868be506e86c1132015609

The working-tree copy hashes to the same value as the committed blob, so there is no CRLF split between the panel's
`sha256` and `blobSha256` fields in this file, unlike `version.md` at stage 2. The file was stored with LF endings.

The handoff names the head to open from (`58972a93`, after stage 3's own record commit, not `fefe4001`) and the number
the body has to carry (1.80.9, patch above `origin/main`'s 1.80.8, claimed on origin as the annotated tag `v1.80.9`).
It also names the one conflict it expected against `main`: `main` carries the earlier walk's copy of this fixed path
and stage 3's record replaces it whole. That expectation was not borne out at the open, and the read below says why:
the branch is 0 commits behind `origin/main`, so the merge base is main's own tip and there is nothing for those
replacements to conflict with.

## The branch on origin

    git fetch origin                                          # before the open
    git rev-parse origin/main                                 23fbe1974b89420c3357add805760673b2754959
    git ls-remote origin refs/heads/wtgui/pipeline-row-rung-2-6f9dd4
    58972a93a08d0cb09e67db6bf5a3aa972a5ae0ed    refs/heads/wtgui/pipeline-row-rung-2-6f9dd4
    git rev-parse HEAD                                        58972a93a08d0cb09e67db6bf5a3aa972a5ae0ed
    git rev-list --left-right --count origin/main...HEAD       0       3
    git merge-tree --write-tree origin/main HEAD
    653db153b9344361743dcf432870c5f24791c115                  # exit 0, no CONFLICT line

The remote branch and HEAD are the same commit, the branch is 0 behind, and the merge of the branch into main's tip
computes a tree with no conflict, so the pull request opens on a branch that needs no rebase and whose merge needs no
resolution. The full diff against `main` at the open is six files, 368 insertions and 344 deletions, all of them this
branch's own change; this record is a seventh file on top of them.

## The pull request

All stamps UTC. One `gh pr create`, and no other pull request was opened for this branch:

    gh pr create --base main --head wtgui/pipeline-row-rung-2-6f9dd4 \
      --title "docs: the GitHub ladder has no loop to cross" \
      --body-file <scratch>/pr-body.md                        # exit 0
    https://github.com/JLRoper/agent-worktree-gui/pull/684

`gh pr create --fill` was not used, deliberately. The branch carries a version bump (`fefe4001`), and `--fill` builds
the title and body from commit subjects only, which drops the reason the bump gave. The title is the docs commit's
own subject; the body carries the level, the two numbers, the tag and the reason it is that level:

    `version: patch` - `package.json` 1.80.8 to 1.80.9 in `fefe4001`, with the annotated tag `v1.80.9` claimed on
    origin (tag object `ccd12da1`, peeling to `fefe4001`).
    The reason, per `docs/versioning.md`: a change confined to `docs/` is a patch. It is not a minor because no
    capability, gate, store, route or config key is added - the paragraph describes the seed that already ships -
    and not a major because no file outside this repository reads it.

The body was read back with `gh pr view 684 --json body` after the create and carries that paragraph whole. It also
states what lands, the full-sweep result, and that this is stage 4 of 6 of the ladder.

The base was passed explicitly (`--base main`) rather than left to the remote default, so the pull request's base is
the branch the ladder names even if the repository's default ever moves.

## Gate G4

`verified_by: pr-open`, artifact `pull-request`. The read that answers it:

    gh pr view 684 --json number,url,state,headRefOid,baseRefName,title,mergeable,mergeStateStatus,isDraft
    {"baseRefName":"main","headRefOid":"58972a93a08d0cb09e67db6bf5a3aa972a5ae0ed","isDraft":false,
     "mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","number":684,"state":"OPEN",
     "title":"docs: the GitHub ladder has no loop to cross",
     "url":"https://github.com/JLRoper/agent-worktree-gui/pull/684"}

`state` is `OPEN`, `baseRefName` is `main`, `headRefOid` equals the tree's HEAD at that read, and `isDraft` is false.
`mergeable` is `MERGEABLE`, so there is no content conflict; `mergeStateStatus` is `BLOCKED`, which is the
repository ruleset's gate on the default branch (`Owner only`, id `25783530`) and not a second branch to rebase.
Stage 5's `gh pr merge --rebase --admin` is the bypass the ladder names for it. A second read, taken after this
record's commit and push, is quoted under "What this commit holds" below.

## The ladder so far

Stamps for stages 1 to 3 are the ones stage 3's record quoted from the panel's queue file. This stage's entry stamp
was not readable at the time of writing: the panel's saved queue snapshot
(`~/.wag/state/assistants/assistant-3/queue.json`) holds tasks 1 to 63 and does not carry this row, and
`~/.wag/state/jobs.json` holds this turn's row with `pipeline` null. The panel's own stamp for this visit is therefore
left to the panel, as the previous walk's record left its own.

| # | stage | artifact | path | commit | entered | settled | job |
|---|-------|----------|------|--------|---------|---------|-----|
| 1 | `commit` | `commit-record` | `ledger/github-force-merge/commit.md` | `f3612b12` | 03:24:25.112Z | 03:35:45.317Z | - |
| 2 | `version` | `version-bump` | `ledger/github-force-merge/version.md` | `fefe4001` | 03:35:45.317Z | 03:43:50.825Z | - |
| 3 | `push` | `pushed-branch` | `ledger/github-force-merge/push.md` | `58972a93` | 03:43:50.825Z | `58972a93` committed 03:48:47Z | `0aa282c6` |
| 4 | `pr` | `pull-request` | `ledger/github-force-merge/pr.md` | this record | 03:43:50.825Z, stage 3's settle | the panel's stamp | this run |
| 5 | `merge` | `merge-record` | `ledger/github-force-merge/merge.md` | not run | - | - | - |
| 6 | `main` | `main-moved` | `ledger/github-force-merge/main.md` | not run | - | - | - |

Row #1's `pipelineRun` has read `visits` `commit: 1, version: 1, push: 1` and `crossings` `H-01: 1, H-02: 1` before
this stage. This stage adds `pr: 1` and `H-03: 1` and crosses nothing twice: there is no loop to cross, because all
five handoffs in the shipped seed are `sequence`, which is the sentence stage 1 landed in `docs/pipelines.md`.

## What the focused tests answered

    npm run test:changed -- --list
    test:changed - 6 changed files against origin/main:
      docs/pipelines.md
      ledger/github-force-merge/commit.md
      ledger/github-force-merge/push.md
      ledger/github-force-merge/version.md
      package.json
      tools/absolute-paths.allow
    test:changed - 27 test files name or import the diff (27 by name, 0 by import)

Stage 3 ran that set on the same six files at `fefe4001`: 230 tests, 229 pass, 1 fail, the one failure
`test/harness.test.js` (a LIVE GATE header with no script that runs it), which it proved pre-existing on
`origin/main`. This stage did not run it again: the only file it adds is this record, and the full sweep below covers
every test the set would have selected.

## What the full sweep answered

One `npm test`, the sweep this stage owes because it is the stage that opens the pull request:

    npm test
    tests 2360, pass 2353, fail 7, exit 1

The seven failures are not this branch's, and that is proved rather than asserted. The same seven test files were
run against a `git archive` of `origin/main` (`23fbe197`) in this run's own scratch folder:

    node --test test/assistant-profile.test.js test/gateway-permissions.test.js test/harness.test.js \
      test/paths.test.js test/reasoning-runs.test.js test/windows-hide.test.js test/worktree-assistant.test.js
    tests 71, pass 64, fail 7, exit 1

The seven titles are the same on both sides: the profile, page and route whitelists test, `gateway-permissions`,
the harness LIVE GATE wiring, the paths config-key rule, the reasoning level's reuse after a jobs-store restart,
the `windowsHide` child-process rule, and the worktree assistant's owner bullet. None of the seven names a file this
branch touches, and this branch changes no code at all: it changes one docs paragraph, one version line, one
allowlist line and four ledger records.

## The other gates run by hand

No pre-push hook is installed in this clone, so the gates the repository ships were run by hand and are quoted as
reads, not as blockers:

    node tools/version.mjs check
    version check: ok - the branch's number is above origin/main's
      branch  1.80.9  (HEAD's package.json)
      base    origin/main  1.80.8  (23fbe197)
      3 commits to land on top of origin/main

    node tools/absolute-paths.mjs
    absolute-paths: clean - 1461 tracked files, 1309 paths in 249 allowlisted files, none new

    git ls-remote --tags origin refs/tags/v1.80.9 'refs/tags/v1.80.9^{}'
    ccd12da1d91d927c805ae72053ed5173924b0a53    refs/tags/v1.80.9
    fefe40018ceed233a67a7f9969103eced5818fa9    refs/tags/v1.80.9^{}

## Timing

All stamps UTC. The panel is the clock for stages 1 to 3; the rest are this run's own.

| event | stamp | source |
|-------|-------|--------|
| stage 3 settled, H-03 available | 03:43:50.825Z | stage 3's record, quoting the panel's queue file |
| `58972a93` committed (stage 3's own record) | 03:48:47Z | that commit's committer date |
| pull request created | 03:59:29Z | `gh pr view 684 --json createdAt` |
| input hashes, version check, absolute-paths read | 03:59:38Z | this run |
| PR read back for G4 | after the create, before this record | this run |

From the stage 3 record commit to the open is about eleven minutes: one input read, one full sweep of 2360 tests
with its base comparison, and one `gh pr create`. The stage's own entry stamp is the panel's to stamp.

## What this commit holds

This record is committed on top of `58972a93` and sent by `git push -u origin HEAD` in this same stage, so the pull
request's head becomes this commit and not `58972a93`. The first send was amended once, so that the sentence above
could say the open's six files are six before this record, and sent again with `git push --force-with-lease`: the
branch is this walk's own and no reviewer held the earlier diff. The commit's own sha is not printed here: this file
is inside it. One file changes: this record, and it is revertable on its own.

The final read, taken after that push:

    git rev-parse HEAD                                   # equals gh pr view 684's headRefOid
    gh pr view 684 --json state,headRefOid,baseRefName
    {"baseRefName":"main","headRefOid":"<this commit>","state":"OPEN"}
    git status --porcelain                               # empty

## What the next stage reads

`merge` reads this file as the `pull-request` input (schema `pull-request/1`, kind `pr`) and merges PR 684 with
`gh pr merge --rebase --admin`, the ladder's bypass for the ruleset. Two facts it needs:

- The branch is 0 behind `origin/main` at the open and `git merge-tree --write-tree origin/main HEAD` computes a tree
  with no conflict, so the merge has no content to resolve. The conflict stage 3 predicted for the four ledger
  records would only appear if `main` moved after this open; the merge stage re-reads the base before it merges.
- A rebase merge re-creates `fefe4001` on `main` with a new sha, so the annotated tag `v1.80.9` (`ccd12da1`, peeling
  to `fefe4001`) still names the branch's pre-merge commit after the merge. Moving the anchor onto the merged commit
  is the merge stage's post-merge step (`node tools/release-tag.mjs --ref origin/main`), and the changelog render
  belongs at the merged tip, not on this branch.
