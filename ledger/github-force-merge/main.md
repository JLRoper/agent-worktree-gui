# github-force-merge stage 6 of 6: main

Stage: `main` (visit 1), pipeline `github-force-merge`, row #1 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/pipeline-row-rung-2-6f9dd4`, in the agent-worktree-gui clone.
Branch: `wtgui/pipeline-row-rung-2-6f9dd4`.
Artifact: `main-moved`, schema `main-moved/1`, kind `pr`, written to `ledger/github-force-merge/main.md`.
Baseline the ladder entered at: `origin/main` `23fbe197` ("docs: render the changelog - 529 releases").
Head at this stage's start: `20f6afcf`, the merge record stage 5 committed.
Working tree before this stage: clean, 0 uncommitted files.

This stage is the sixth and last rung of the shipped `github-force-merge` ladder, walked once in order:
`commit -> version -> push -> pr -> merge -> main`. H-05 hands stage 5's `merge-record` in; this stage ends the
ladder and hands nothing on. It fetches `origin`, reads the main ref and proves the merged commit is reachable from
it. It edits no file the branch's change commits carry.

## The input read

`ledger/github-force-merge/merge.md`, handed on as `merge-record` read-only at `20f6afcf`. The panel pinned this file
as the stage run's input with `blob 102f46640f1c` and `sha256 4499e96695d9`; both reproduce:

    git rev-parse 20f6afcf:ledger/github-force-merge/merge.md
    102f46640f1c5f81e6295c3cb06c69737b647871

    git cat-file blob 20f6afcf:ledger/github-force-merge/merge.md | sha256sum
    4499e96695d9fcb794ee660f2f118ab2e0863a2a9896a149643b292572a656c8

    sha256sum ledger/github-force-merge/merge.md
    4499e96695d9fcb794ee660f2f118ab2e0863a2a9896a149643b292572a656c8

The working copy hashes to the same value as the committed blob, so this path carries no CRLF split and the panel's
`sha256` and `blobSha256` agree.

The input names three reads this stage owes: the merge commit `2fceb7e0`, the tip after the landing's changelog
render `00d94108`, and the fact that `git merge-base --is-ancestor 2fceb7e0 origin/main` already exited 0 when stage
5 read it after its own commit. Each is re-read below rather than taken from the input.

## The fetch

The stage's first fetch, at its start. A second fetch followed when main moved under the stage; it is the next
section. Nothing was written to the remote by either:

    git fetch origin            # exit 0, no output

`git fetch origin` prints nothing when the remote's refs have not moved since the last read, and the ref read below
is the evidence it ran: the read of `refs/heads/main` through the same remote comes back with the sha the fetch
wrote into `origin/main`.

    git rev-parse origin/main
    00d94108c43cb4a0e923f0d45bb9ee03bf027719

    git ls-remote origin refs/heads/main
    00d94108c43cb4a0e923f0d45bb9ee03bf027719    refs/heads/main

The two agree, so the fetch is not reporting a local ref from an older read: the remote's main is `00d94108`, and
the ladder's baseline `23fbe197` is five commits behind it.

    git rev-list --left-right --count origin/main...HEAD
    5       5

The branch is 5 behind and 5 ahead of `origin/main` by sha, because its four change commits are the pre-rebase ones
the merge replaced. The merge base is the ladder's baseline, which is what makes the ahead count five and not one:

    git merge-base origin/main HEAD
    23fbe1974b89420c3357add805760673b2754959

## The re-read, after main moved under this stage

Main moved again while this stage was running, by work that is not this ladder's. The first fetch read `00d94108`;
a second fetch, its output read back the same way, finds three more commits on top of it:

    git fetch origin            # exit 0, no output
    date -u
    2026-11-10T04:26:05Z
    git rev-parse origin/main
    6c619dcda8756555fd63150e136608192a366ed0

| on `origin/main` | committer date | subject | whose |
|---|---|---|---|
| `f64a4f7c` | 2026-11-09T23:20:18-05:00 | docs: probe evidence for rung 7 - the round row, its stage indent, and the fields behind them | another row |
| `e7f51f57` | 2026-11-09T23:20:18-05:00 | docs: conclude round 7 - the indent is row.parent joined by branch, not the round record | another row |
| `6c619dcd` | 2026-11-09T23:20:18-05:00 | test: an approval gates approve only at the PR's current head | another row |

They are three commits by a different row on the same project, not a rewrite of this ladder's landing: `2fceb7e0` is
still an ancestor, re-read rather than assumed:

    git merge-base --is-ancestor 2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c origin/main    # exit 0

    git rev-list --left-right --count origin/main...HEAD
    8       5

The ahead count is unchanged at five, because no commit of this branch moved; the behind count grew from five to
eight with the other row's work. A tip that moves under a confirmation stage is why the gate is asked as "is the
merged commit reachable", and not as "is main at the sha I read a minute ago": the ancestor read answers yes against
both `00d94108` and `6c619dcd`.

## The merge is on main

    git merge-base --is-ancestor 2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c origin/main    # exit 0

Exit 0 is the answer to the stage's prompt: the commit the ladder merged is reachable from `origin/main`. Two
independent reads say the same thing, from opposite directions:

    git branch -r --contains 2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c
      origin/HEAD -> origin/main
      origin/main

    git rev-list --count 2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c..00d94108
    1

`2fceb7e0` is the fourth of the branch's commits, and it sits on `origin/main` with exactly one commit above it at
the stage's read:

    git rev-list --parents -1 00d94108
    00d94108c43cb4a0e923f0d45bb9ee03bf027719 2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c

One parent, so the tip this stage read does not carry a merge commit of its own, and the commit stage 5 merged is its
direct predecessor. The whole landing, from the ladder's baseline to the tip this stage's first fetch read:

| on `origin/main` | subject | what it is |
|---|---|---|
| `76df7441` | docs: the GitHub ladder has no loop to cross - all five handoffs are sequence | stage 1's commit, re-created by the rebase |
| `780df958` | chore: 1.80.9 - the version this landing carries | stage 2's bump, re-created by the rebase |
| `c0777e89` | docs: record the ladder's push stage | stage 3's record, re-created by the rebase |
| `2fceb7e0` | docs: record the ladder's pr stage | stage 4's record, and PR 684's merge commit |
| `00d94108` | docs: render the changelog - 530 releases | the render stage 5 ran after the merge |

    git rev-list --merges 23fbe197..origin/main    # 0 lines

The ruleset's `required_linear_history` still holds: eight commits at the re-read, no merge commit, one parent each.

The annotated tag still names the bump commit, and it moved when the rebase re-created it:

    git ls-remote --tags origin 'refs/tags/v1.80.9*'
    b29e21d640c0db01a61cfa327a268ae9a32438a1    refs/tags/v1.80.9
    780df95854783d7e6efd2b2245b1525cc8876ac4    refs/tags/v1.80.9^{}

`780df958` is the commit on `main` that first declares 1.80.9, so the anchor is on the merged bump commit and not on
the orphaned `fefe4001`.

The pull request that carried the merge, read after the fetch:

    gh pr view 684 --json number,state,mergedAt,mergedBy,mergeCommit,baseRefOid,headRefOid,baseRefName
    {"baseRefOid":"23fbe197...","baseRefName":"main",
     "headRefOid":"005d4d9b...",
     "mergeCommit":{"oid":"2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c"},
     "mergedAt":"2026-11-10T04:04:55Z","mergedBy":{"login":"JLRoper"},"number":684,"state":"MERGED"}

`state` is `MERGED`, the merge commit is the `2fceb7e0` this stage proved reachable, and the base it merged into was
the ladder's baseline `23fbe197`. Main moved by exactly this landing: baseline `23fbe197` -> merge `2fceb7e0` ->
render `00d94108`.

`00d94108` changes one file above the merge commit, the changelog render stage 5 ran:

    git diff --stat 2fceb7e0 00d94108
     CHANGELOG.md | 17 +++++++++++++++--
     1 file changed, 15 insertions(+), 2 deletions(-)

## Gate G6

`verified_by: main-moved`, artifact `main-moved`. The documented truth condition is that the main ref's sha differs
from the one recorded when the stage began, and the prompt's is that the merged commit is reachable from it. This
stage answers the second directly and carries the numbers the first needs, because the durable pipeline record has
no `baseline` field yet (`docs/pipelines-audit.md` P1-6 records that gap):

    baseline, the ladder's entry read:  23fbe1974b89420c3357add805760673b2754959
    merged, PR 684's merge commit:      2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c
    tip, read after this stage's fetch: 00d94108c43cb4a0e923f0d45bb9ee03bf027719

The baseline is the sha recorded before the landing moved anything; the merged commit lies between it and both tips,
and the tip differs from the baseline by five commits at this stage's read and by eight after the re-read. A
re-check after a restart re-reads `origin/main` and still finds `2fceb7e0` an ancestor, so this record cannot pass
on a comparison against the wrong commit.

The command line that answers the gate, kept as one line so a reader can run it without this file:

    git fetch origin && git merge-base --is-ancestor 2fceb7e0d5032e1e2c44ff7939d3ad4c0a4d8a4c origin/main && git rev-parse origin/main

## The ladder, complete

Six stages, one visit each, in document order, with no loop crossed:

| # | stage | artifact | path | commit | on `main` as |
|---|-------|----------|------|--------|--------------|
| 1 | `commit` | `commit-record` | `ledger/github-force-merge/commit.md` | `f3612b12` | `76df7441` |
| 2 | `version` | `version-bump` | `ledger/github-force-merge/version.md` | `fefe4001` | `780df958` |
| 3 | `push` | `pushed-branch` | `ledger/github-force-merge/push.md` | `58972a93` | `c0777e89` |
| 4 | `pr` | `pull-request` | `ledger/github-force-merge/pr.md` | `005d4d9b` | `2fceb7e0` |
| 5 | `merge` | `merge-record` | `ledger/github-force-merge/merge.md` | `20f6afcf` | with PR 686 |
| 6 | `main` | `main-moved` | `ledger/github-force-merge/main.md` | this record | with PR 686 |

The row's own record agrees with the walk rather than with its own prose: `visits` reads one for each of the six
stages, `crossings` reads `H-01: 1` through `H-05: 1`, and `route` is a single digest
`sha256:e87c4512aa792cb3ff31b66b1ab57f73ee7e788154fc4fe10b1d7ccbc18acc6a`, which is the six-stage rail and not a
loop. Stage 1 landed the sentence this walk proves, in `docs/pipelines.md`: all five handoffs are `sequence`, so a
row that enters at `commit` visits the six stages once each and there is no loop to cross.

The two post-merge records, `merge.md` and this one, are the only stage records not already on `main`. They are
carried by PR 686, the one pull request opened from this branch for stage 6, which is why the table names it for
them.

## What this commit holds

One file, this record, committed on top of `20f6afcf` in this tree. Against the tip this stage's fetch read
(`00d94108`), the branch's tree differs only by the changelog render and by `merge.md`:

    git diff --stat HEAD 00d94108
     CHANGELOG.md                       |  17 ++-
     ledger/github-force-merge/merge.md | 234 -------------------------------------
     2 files changed, 15 insertions(+), 236 deletions(-)

`CHANGELOG.md` is main's render of 1.80.9, which the branch does not carry because the render ran in the primary
checkout after the merge; the ledger deletion is `merge.md`, which exists only on this branch until PR 686 lands.
Nothing else differs, which is the by-content proof that the four pre-rebase commits carry exactly what the rebase
put on `main`:

    git cherry -v origin/main HEAD
    - f3612b12 docs: the GitHub ladder has no loop to cross - all five handoffs are sequence
    - fefe4001 chore: 1.80.9 - the version this landing carries
    - 58972a93 docs: record the ladder's push stage
    - 005d4d9b docs: record the ladder's pr stage
    + 20f6afcf docs: record the ladder's merge stage

Every line but the merge record starts with `-`, which is `git cherry` saying the commit's patch is already upstream.

The version check refuses on this branch, for the reason stage 5 recorded and not a new one: `node tools/version.mjs
check` reads branch 1.80.9 against base 1.80.9 at `6c619dcd` and counts five commits with no bump, because `fefe4001`
is the pre-rebase copy of the `780df958` that is already on `main`. This stage spends no version, and `main`'s own
read reports `ok`, because a checkout with no commits above `origin/main` has nothing to bump. No pre-push hook is
installed in this clone (`git config --get core.hooksPath` exits 1), so the push is not gated by that check.

## What the focused tests answered

This stage changes one file, this record, and nothing a test names or imports. The focused set the tree selects:

    npm run test:changed -- --list
    test:changed - 9 changed files against origin/main:
      docs/pipelines.md
      ledger/github-force-merge/commit.md
      ledger/github-force-merge/main.md
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
`tools/verify-round-tree-names.mjs` says LIVE GATE but no `package.json` script runs it. It is not this branch's, and
that is proved rather than asserted: the same file, run against a `git archive` of `origin/main` (`00d94108`) in this
run's scratch folder, answers the same title and the same count:

    node --test test/harness.test.js          # in the origin/main archive
    tests 5, pass 4, fail 1, same title

The full suite, one sweep on this commit before the pull request:

    npm test
    tests 2361, pass 2353, fail 8, exit 1

Five of the eight are failures main itself carries, and stage 4 proved the same five on a `git archive` of
`origin/main`: the assistant-profile whitelists test, the harness LIVE GATE wiring, the paths config-key rule, the
`windowsHide` child-process rule, and the worktree assistant's owner bullet. `gateway-permissions` fails alone in
this tree because a worktree has no `config.json` (that file is ignored, not tracked), which is the same reason it
failed at stage 4. The remaining two, `project-open-route` and `release-sweep`, were file-level crashes in the
parallel run and pass on their own in this tree (the two together answer 5 tests, 5 pass), so they are contention
rather than content. Nothing here reads a ledger file: this stage changes one markdown record and no code.

## Timing

All stamps UTC. The panel is the clock for the stage's entry; the rest are this run's own.

| event | stamp | source |
|-------|-------|--------|
| the `main` stage entered | 2026-11-10T04:14:52.484Z | the panel's stage run |
| input read, `merge.md` at `20f6afcf` | 2026-11-10T04:16Z | this run |
| first `git fetch origin` | 2026-11-10T04:17Z | this run |
| `origin/main` read at `00d94108` | 2026-11-10T04:18:14Z | `date -u` beside the read |
| `merge-base --is-ancestor 2fceb7e0 origin/main` | 2026-11-10T04:18Z | exit 0 |
| second `git fetch origin`, main had moved | 2026-11-10T04:26:05Z | `date -u` beside the read |
| `origin/main` re-read at `6c619dcd` | 2026-11-10T04:26:05Z | `git rev-parse origin/main` |
| ancestry re-checked against `6c619dcd` | 2026-11-10T04:26Z | exit 0 |

## What the next reader sees

At this stage's last read, `main` is `6c619dcd`, eight commits above the ladder's baseline, and the merged commit
`2fceb7e0` is on it. Three of those eight are another row's work that landed while this stage ran, so a reader who
fetches later will see a longer log; the ancestor relation against `2fceb7e0` is what holds, not the tip's sha.

The branch's tree is eight commits behind that main by sha and carries two records main does not have yet. PR 686,
opened from this head, lands both, rebased onto main's tip and linear, and its merge commit is the sha that makes
the row's tree read `MERGED` at six stages of six.
