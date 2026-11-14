# Leftover branches, 2026-11-14 - two refs with no worktree, judged and retired

Base: `origin/main` `5cf42a255ea946fdc88905c63f0fd9df83fcced4`, declaring `1.100.1`. Read at the cut of
`wtgui/judge-and-retire-the-two-leftover-2a5691`, at the clock this document was written: `date` 2026-11-14
00:51 EST, `date -u` 05:51 UTC.

Neither branch was in the sweep's brief (`docs/reports/worktree-cleanup-2026-11-14.md`), and neither held a
registered worktree: `git worktree list --porcelain` printed four entries (the primary checkout and three
`.worktrees/` trees: `console-row-spacing-setting-and-a-font-fd9124`, `console-streaming-lag-measure-and-name-ad41c8`,
this run's own `judge-and-retire-the-two-leftover-2a5691`), and no tree named either branch.

| branch | tip | ahead / behind `origin/main` | verdict | disposition |
|---|---|---|---|---|
| `wtgui/cut-branch-wtgui-aggregate-remainder-5650d5` | `2de5c778` | 0 / 55 | STALE NAME, nothing of its own | deleted at once |
| `wtgui/github-landing-sanity-0bbdd3` | `de5f30cf` | 7 / 0 (merge base `a868b9d4`) | SUPERSEDED - seven of seven already on main | deleted after the verdicts below were committed |

## 1. `wtgui/cut-branch-wtgui-aggregate-remainder-5650d5` - 0 ahead, a duplicate of the aggregate-remainder name

The whole case is four reads:

    git rev-list --left-right --count origin/main...wtgui/cut-branch-wtgui-aggregate-remainder-5650d5
    55      0                       # 55 behind, 0 ahead: the branch carries no commit of its own
    git merge-base --is-ancestor wtgui/cut-branch-wtgui-aggregate-remainder-5650d5 origin/main
    exit 0                          # it is an ancestor of main, not a divergent point
    git log -1 --format='%h %ad %s' --date=short 2de5c778
    2de5c778 2026-11-13 docs: render the changelog - 584 releases
    git ls-remote --heads origin refs/heads/wtgui/cut-branch-wtgui-aggregate-remainder-5650d5
    (no output - there is no such ref on origin)

`2de5c778` is a main commit from two days ago: main has since rendered the changelog to 597 releases
(`5cf42a25`), so the ref is a stale point on main's own history, and it has no remote counterpart to keep in step.

The name duplicates the aggregate-remainder branch. That branch is `wtgui/aggregate-remainder-2026-11-13`, still on
origin at `dbd627a4`, and PR #742 is `MERGED` at exactly that head (`headRefOid`
`dbd627a44daa5b3a3728313206be92f2cbde7f8a`, merge commit `e1f8edb8`). The sweep's own report already says which
branch that tree held: its row for the tree reads `cut-branch-wtgui-aggregate-remainder-5650d5 |
wtgui/aggregate-remainder-2026-11-13 | dbd627a4 | 9 | 0 | SUPERSEDED - PR #742 MERGED at this exact head`. So the
leftover local ref is the tree's DIRECTORY name spent as a branch name, at an older main tip, with nothing behind
it. A duplicate name pointing at main history is a trap for the next reader who greps the slug and finds two refs.

Deleted at once, the tip already being an ancestor of main:

    git branch -D wtgui/cut-branch-wtgui-aggregate-remainder-5650d5
    Deleted branch wtgui/cut-branch-wtgui-aggregate-remainder-5650d5 (was 2de5c778).
    git rev-parse --verify --quiet refs/heads/wtgui/cut-branch-wtgui-aggregate-remainder-5650d5
    (no output - absent)

## 2. `wtgui/github-landing-sanity-0bbdd3` - seven commits, each judged against main

Tip `de5f30cf`, merge base `a868b9d4` (`1.80.4`, the base the round was cut from). Main has walked the same ladder
twice since, at `1.80.9`; that later walk is what most of these seven meet.

The measurement is `git cherry -v origin/main wtgui/github-landing-sanity-0bbdd3`, which prints `-` for a commit
whose patch main already carries and `+` for one it does not:

    - 345252f5 test: the GitHub ladder has no loop to cross - every handoff is a sequence
    - 8326c59b chore: 1.80.1 - the version this landing carries
    - 602de7c2 docs: record the ladder's push stage
    - 253c7f08 docs: record the ladder's pr stage
    - 2b72e8e1 chore: 1.80.5 - the version this landing carries
    + a318d3f2 docs: record the ladder's merge stage
    + de5f30cf docs: record the ladder's main stage

Five carry straight across. The two `+` commits are the two stage records whose paths main has since rewritten from a
later visit, and each is judged below on the file main holds now, not on the patch.

| # | branch commit | verdict | what main already carries |
|---|---|---|---|
| 1 | `345252f5` test: the GitHub ladder has no loop to cross - every handoff is a sequence | ALREADY ON MAIN | `a5412657`, the same subject, patch-equivalent (`-`). Main's `test/pipeline-bundle-seed.test.js:141-147` holds the identical block, including its message `"the GitHub ladder has no loop: every handoff is a sequence"` |
| 2 | `8326c59b` chore: 1.80.1 - the version this landing carries | SUPERSEDED | `a659e342`, the same subject (`-`); and the number is 20 releases old - main declares `1.100.1`. Its two side effects are on main in later form: `version.md` is the `1.80.9` visit's record (`780df958`) with the same nine sections, and the allow line it added was added by `a659e342` and retired by `76df7441`, the commit that stopped `commit.md` naming a tree path |
| 3 | `602de7c2` docs: record the ladder's push stage | ALREADY ON MAIN | `c0777e89`, the same subject at `1.80.9` (`-`); an earlier copy landed as `3edc1bf5`. Main's `ledger/github-force-merge/push.md` is the later visit, 210 lines against this commit's 195 |
| 4 | `253c7f08` docs: record the ladder's pr stage | ALREADY ON MAIN | `2fceb7e0`, the same subject at `1.80.9` (`-`); an earlier copy landed as `7b0f70fd`. Main's `pr.md` is 215 lines against this commit's 196 |
| 5 | `2b72e8e1` chore: 1.80.5 - the version this landing carries | LANDED, same content | `f063ef82`, the same subject, an ancestor of main: `git merge-base --is-ancestor f063ef82f74ef9f187545bccdc4dff1b5dcf7590 origin/main` exits 0. The release is anchored there: `git ls-remote --tags origin` answers `f063ef82... refs/tags/v1.80.5^{}` |
| 6 | `a318d3f2` docs: record the ladder's merge stage | SUPERSEDED at its path | `d1aec822`, the same subject at `1.80.9`, is main's `ledger/github-force-merge/merge.md`; its header reads Stage `merge` (visit 1), pipeline `github-force-merge`, row #1, with `Base before the merge: `origin/main` at `23fbe197`, and it records PR #684 and merge commit `2fceb7e0` |
| 7 | `de5f30cf` docs: record the ladder's main stage | SUPERSEDED at its path | `7fdc96ac` "docs: record the ladder's main stage - the merge is on main" at `1.80.9` is main's `main.md`; its `## The merge is on main` section proves `git merge-base --is-ancestor 2fceb7e0... origin/main # exit 0`, and it closes with `## The ladder, complete` |

### The two `+` commits, and why they are not a gap

`a318d3f2` and `de5f30cf` record stage 5 and stage 6 of the SAME two paths (`ledger/github-force-merge/merge.md`,
`main.md`) for the EARLIER visit: the `1.80.5` walk, base `a868b9d4` (`1.80.4`), tree
`.worktrees/github-landing-sanity-0bbdd3`, row #58 in the queue, PR #679 merged `2026-11-10T01:20:34Z` at
`f063ef82`.

Main's copies of those two paths are the `1.80.9` visit: base `23fbe197`, tree `.worktrees/pipeline-row-rung-2-6f9dd4`,
row #1, PR #684 at `2fceb7e0`. Each is the same stage, same schema, same proof shape, recorded later. The repo keeps
ONE record per stage path - each walk rewrites its predecessors, which is why the path history reads
`3edc1bf5 -> c0777e89` for `push.md` and `7b0f70fd -> 2fceb7e0` for `pr.md`. Landing the earlier pair would push the
older visit's numbers back over the newer records, which is a revert in a docs commit, not a landing.

Nothing a reader needs is missing from main for it. The landing those two records describe is on main as `f063ef82`,
anchored by `v1.80.5`, and its PR number is in the ledger's own history. So the verdict for all seven is the same:
already carried, in an equal or later form. No product code lands from this branch.

## What this run lands

The two deletions and this document, and nothing else. No file from `wtgui/github-landing-sanity-0bbdd3` is
re-applied: every one of the seven commits meets a main commit that says the same thing or a later visit of the same
record.

## The deletions, and the branch list after them

Both refs are deleted with `git branch -D`, after `git worktree list --porcelain` showed no tree holding either:

    git branch -D wtgui/cut-branch-wtgui-aggregate-remainder-5650d5
    Deleted branch wtgui/cut-branch-wtgui-aggregate-remainder-5650d5 (was 2de5c778).
    git branch -D wtgui/github-landing-sanity-0bbdd3
    Deleted branch wtgui/github-landing-sanity-0bbdd3 (was de5f30cf).

Neither ref resolves afterwards:

    git rev-parse --verify --quiet refs/heads/wtgui/cut-branch-wtgui-aggregate-remainder-5650d5   (no output)
    git rev-parse --verify --quiet refs/heads/wtgui/github-landing-sanity-0bbdd3                (no output)
    git branch --list '*aggregate*'                                                             (no output)

The branch list after both deletions: `git branch --format='%(refname:short)' | wc -l` prints 78 local branches,
`git branch --list '*aggregate*'` prints nothing, and neither deleted ref resolves. No branch in the list is named
after either tree.
