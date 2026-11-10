# github-force-merge stage 5 of 6: merge

Stage: `merge` (visit 1), pipeline `github-force-merge`, row #1 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/pipeline-row-rung-2-6f9dd4`, in the agent-worktree-gui clone.
Branch: `wtgui/pipeline-row-rung-2-6f9dd4`.
Artifact: `merge-record`, schema `merge-record/1`, kind `pr`, written to `ledger/github-force-merge/merge.md`.
Base before the merge: `origin/main` at `23fbe197`. Head before the merge: `005d4d9b`, the commit stage 4 pushed.
Working tree before this stage: clean, 0 uncommitted files.

This stage is the fifth rung of the shipped `github-force-merge` ladder, walked once in order:
`commit -> version -> push -> pr -> merge -> main`. H-04 hands stage 4's `pull-request` in; H-05 hands this stage's
`merge-record` to `main`. It merges the one pull request and edits no file the branch's change commits carry.

## The input read

`ledger/github-force-merge/pr.md`, handed on as `pull-request` read-only at `005d4d9b`. Both pinned values reproduce:

    git rev-parse 005d4d9b:ledger/github-force-merge/pr.md
    6870d2dec168100a1b5a71635c5c28a7d5f59eea

    git cat-file blob 005d4d9b:ledger/github-force-merge/pr.md | sha256sum
    c920a398bd818cfa25f5463681bf1dc5025e52a019ac54eea7ce992ff95e688c

    sha256sum ledger/github-force-merge/pr.md
    c920a398bd818cfa25f5463681bf1dc5025e52a019ac54eea7ce992ff95e688c

The working copy hashes to the same value as the committed blob, so there is no CRLF split on this path: the file
was stored with LF endings.

The input names the pull request to merge (684), the base it was opened against (`main` at `23fbe197`), and two
post-merge facts this stage owes: a rebase merge re-creates `fefe4001` with a new sha and orphans the annotated tag
`v1.80.9`, and the changelog render belongs at the merged tip. Both are quoted and acted on below.

## Before the merge

    git fetch origin
    git rev-parse origin/main                                23fbe1974b89420c3357add805760673b2754959
    git rev-parse HEAD                                       005d4d9befa09c5e4f18fe6f805c794300d614d1
    git rev-list --left-right --count origin/main...HEAD     0       4
    git merge-tree --write-tree origin/main HEAD             a9b11c7e92f606a09c34a55cb49bc9da6cc6aae7   # exit 0

The branch is 0 commits behind `main`, and the merge of the branch into main's tip computes a tree with no CONFLICT
line, so the merge had no content to resolve and no rebase was needed to make it mergeable.

The pull request, read before the merge:

    gh pr view 684 --json number,url,state,headRefOid,baseRefOid,baseRefName,mergeable,mergeStateStatus,isDraft
    {"baseRefOid":"23fbe197...","baseRefName":"main","headRefOid":"005d4d9b...","isDraft":false,
     "mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","number":684,"state":"OPEN",
     "url":"https://github.com/JLRoper/agent-worktree-gui/pull/684"}

`mergeable` is `MERGEABLE` and `mergeStateStatus` is `BLOCKED`. The block is the repository ruleset, not a second
branch: the "Owner only" ruleset (id 25783530, `docs/pushing-to-a-remote.md` gate 8) targets `~DEFAULT_BRANCH` with
`deletion`, `non_fast_forward`, `creation`, `update` and `required_linear_history`, and it carries the account's
bypass:

    gh api repos/JLRoper/agent-worktree-gui/rulesets/25783530 --jq '{rules,bypass_actors,current_user_can_bypass}'
    {"rules":["deletion","non_fast_forward","creation","update","required_linear_history"],
     "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
     "current_user_can_bypass":"always"}

`current_user_can_bypass` is `always`, so `--admin` is the bypass the ladder names and not a preference.
`--rebase` is what `required_linear_history` requires; `--merge` would have been refused.

## The merge

One command, and no other merge was attempted:

    gh pr merge 684 --rebase --admin          # exit 0, no output

Read back, which is the answer to gate G5:

    gh pr view 684 --json number,state,mergedAt,mergedBy,mergeCommit,baseRefOid,headRefOid,baseRefName
    {"baseRefOid":"23fbe1974b89420c3357add805760673b2754959","baseRefName":"main",
     "headRefOid":"005d4d9befa09c5e4f18fe6f805c794300d614d1",
     "mergeCommit":{"oid":"2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c"},
     "mergedAt":"2026-11-10T04:04:55Z","mergedBy":{"login":"JLRoper"},"number":684,"state":"MERGED"}

`state` is `MERGED`, `mergedAt` is stamped, `mergeCommit` is `2fceb7e0`, and `baseRefOid` is the same `23fbe197`
this stage read before it merged, so `main` did not move under the merge.

The rebase re-created the branch's four commits on `main`, one at a time, with new shas:

| branch (pre-merge) | main (post-merge) | subject |
|---|---|---|
| `f3612b12` | `76df7441` | docs: the GitHub ladder has no loop to cross - all five handoffs are sequence |
| `fefe4001` | `780df958` | chore: 1.80.9 - the version this landing carries |
| `58972a93` | `c0777e89` | docs: record the ladder's push stage |
| `005d4d9b` | `2fceb7e0` | docs: record the ladder's pr stage |

`main` carries no merge commit, so the ruleset's `required_linear_history` is satisfied:

    git rev-list --merges 23fbe197..origin/main       # 0 lines
    git rev-list --parents -1 origin/main             2fceb7e0... c0777e89...   # one parent

All four re-created commits carry the committer date 2026-11-09T23:04:54-05:00, which is 04:04:54Z, one second
before the merge stamp.

## The landing's last step, which the input handed here

Gate G5 reads `pr-merged` and the pull request reads `MERGED`, so the merge this stage owes is done. The input also
named what a bare `gh pr merge` leaves behind, and `docs/versioning.md` says the same: a rebase merge orphans the
tag the bump commit carried, and the changelog render belongs at the merged tip, not on the branch. Both were run
here, in the primary checkout, after the merge:

    git -C <primary> merge --ff-only origin/main     # 23fbe197 -> 2fceb7e0, fast-forward, no conflict
    node tools/land.mjs --check                      # land: CHANGELOG.md is stale - it would add v1.80.9
    node tools/land.mjs                              # exit 0
      land: committed 00d9410 - docs: render the changelog - 530 releases (CHANGELOG.md)
      land: 9 untracked files left alone - the commit is still CHANGELOG.md and nothing else
      land: pushed main to origin with --no-verify - every commit sent touches only CHANGELOG.md, and a render
            spends no version (docs/versioning.md)
      land: origin/main is at 00d9410
      land: moved fefe40018c -> 780df95854 on origin (--force) - the commit that first declared 1.80.9
      changelog: CHANGELOG.md is current - 530 releases

The render committed one file and spent no version, and the anchor moved onto the merged bump commit:

    git rev-parse origin/main                       00d94108c43cb4a0e923f0d45bb9ee03bf027719
    git ls-remote --tags origin 'refs/tags/v1.80.9*'
    b29e21d640c0db01a61cfa327a268ae9a32438a1    refs/tags/v1.80.9
    780df95854783d7e6efd2b2245b1525cc8876ac4    refs/tags/v1.80.9^{}

`v1.80.9` is an annotated tag (`b29e21d6` is the tag object) peeling to `780df958`, the commit on `main` that first
declares 1.80.9. Before the move it named `fefe4001`, which the rebase left off `main`.

The anchor gate and the changelog gate, read on the merged tip:

    node tools/verify-version-tags.mjs
    version-tags: 530 version bumps in package.json's history (v0.1.0 .. v1.80.9), 528 tagged and annotated at
    the commit that first declared them as origin publishes them
      ... wrong-commit v1.76.22 ... wrong-commit v1.76.23 ...
    FAIL - 4 findings across 530 version bumps

    npm run changelog:check
    changelog: CHANGELOG.md is current - 530 releases

The four `verify-version-tags` findings are the ones `main` carried before this landing: `v1.76.22` and `v1.76.23`
on wrong commits, and two `package.json` backwards jumps at `f4cdd0d7` and `bf4b57b0`. None of them names 1.80.9,
and the finding set is identical to the one this stage read before it merged, so the landing neither added nor
repaired a finding.

## Gate G5

`verified_by: pr-merged`, artifact `merge-record`. The read above answers it: `gh pr view 684` returns
`"state":"MERGED"` with `mergedAt` `2026-11-10T04:04:55Z`, `mergedBy` `JLRoper`, and `mergeCommit` `2fceb7e0`.
The merged commit is an ancestor of `origin/main`:

    git merge-base --is-ancestor 2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c origin/main    # exit 0

## The ladder so far

| # | stage | artifact | path | commit | settled |
|---|-------|----------|------|--------|---------|
| 1 | `commit` | `commit-record` | `ledger/github-force-merge/commit.md` | `f3612b12`, on `main` as `76df7441` | 03:35:45.317Z (panel) |
| 2 | `version` | `version-bump` | `ledger/github-force-merge/version.md` | `fefe4001`, on `main` as `780df958` | 03:43:50.825Z (panel) |
| 3 | `push` | `pushed-branch` | `ledger/github-force-merge/push.md` | `58972a93`, on `main` as `c0777e89` | `58972a93` committed 03:48:47Z |
| 4 | `pr` | `pull-request` | `ledger/github-force-merge/pr.md` | `005d4d9b`, on `main` as `2fceb7e0` | PR 684 opened 03:59:29Z |
| 5 | `merge` | `merge-record` | `ledger/github-force-merge/merge.md` | this record | PR 684 merged 04:04:55Z |
| 6 | `main` | `main-moved` | `ledger/github-force-merge/main.md` | not run | - |

Row #1's `pipelineRun` read `visits` `commit: 1, version: 1, push: 1, pr: 1` before this stage. This stage adds
`merge: 1` and `H-04: 1` and crosses nothing twice: all five handoffs in the shipped seed are `sequence`, which is
the sentence stage 1 landed in `docs/pipelines.md`. One visit per stage, in document order, with no loop.

## What the focused tests answered

This stage changes one file, this record, and nothing a test names or imports. The focused set the tree selects:

    npm run test:changed -- --list
    test:changed - 8 changed files against origin/main:
      docs/pipelines.md
      ledger/github-force-merge/commit.md
      ledger/github-force-merge/merge.md
      ledger/github-force-merge/pr.md
      ledger/github-force-merge/push.md
      ledger/github-force-merge/version.md
      package.json
      tools/absolute-paths.allow
    test:changed - 27 test files name or import the diff (27 by name, 0 by import)

    npm run test:changed
    tests 230, pass 229, fail 1, exit 1

The one failure is `test/harness.test.js`, "every declared harness is wired the way its own header says":
`tools/verify-round-tree-names.mjs` says LIVE GATE but no `package.json` script runs it. It is not this branch's,
and that is proved rather than asserted: the same file, run against a `git archive` of `origin/main` (`00d9410`) in
this run's scratch folder, answers the same:

    node --test test/harness.test.js          # in the origin/main archive
    tests 5, pass 4, fail 1, same title

Stage 4 ran the full suite at `005d4d9b`: 2360 tests, 2353 pass, 7 fail, with all seven reproduced on `origin/main`
at the open. This stage changes one ledger file and does not re-run it.

## Timing

All stamps UTC. The panel is the clock for stages 1 to 4; the rest are this run's own.

| event | stamp | source |
|-------|-------|--------|
| merge command issued | 2026-11-10T04:04:49Z | `date -u` immediately before it |
| rebase re-created the four commits | 2026-11-10T04:04:54Z | their committer dates |
| PR reads `MERGED` | 2026-11-10T04:04:55Z | `gh pr view 684 --json mergedAt` |
| changelog render committed as `00d9410` | 2026-11-10T04:07:21Z | that commit's committer date |
| anchor moved to `780df958` | between the render and the read back | `node tools/land.mjs` output |
| origin/main read at `00d94108` | 2026-11-10T04:08Z | this run |

## What this commit holds

This record is committed on top of `005d4d9b` in this tree, after the merge landed, and pushed to
`wtgui/pipeline-row-rung-2-6f9dd4`. One file changes, this record, and it is revertable on its own.

The branch now reads 5 behind and 4 ahead of `origin/main` by sha, because its four commits are the pre-rebase ones
the rebase replaced. By content the only difference is the render commit:

    git diff --stat HEAD origin/main
     CHANGELOG.md | 17 +++++++++++++++--
     1 file changed, 15 insertions(+), 2 deletions(-)

`node tools/version.mjs check` on this branch now refuses, because the branch and `origin/main` both read 1.80.9
and the branch's four pre-rebase shas are not on `main`. That is the state of a branch whose pull request has
merged, not a regression: the bump landed once, as `780df958`, and `main` carries it.

## What the next stage reads

`main` reads this file as the `merge-record` input (schema `merge-record/1`, kind `pr`) and runs `git fetch origin`
to confirm the merge is reachable from origin's main. Three reads it needs:

- the merge commit, `2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c`;
- the tip after the landing's render, `00d94108c43cb4a0e923f0d45bb9ee03bf027719`, with `v1.80.9` anchored at
  `780df958` on it;
- `git merge-base --is-ancestor 2fceb7e0 origin/main` exits 0 at this read, so the merged commit is already
  reachable and that stage has nothing to repair.
