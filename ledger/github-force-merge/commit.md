# github-force-merge stage 1 of 6: commit

Stage: `commit` (visit 1), pipeline `github-force-merge`, row #1 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/pipeline-row-rung-2-6f9dd4`, in the agent-worktree-gui clone.
Branch: `wtgui/pipeline-row-rung-2-6f9dd4`.
Base and HEAD before this commit: `23fbe197` ("docs: render the changelog - 529 releases"), which is also `origin/main`
at the read, so the branch was 0 commits behind and 0 ahead.
Working tree before this commit: one modified file, `docs/pipelines.md` (3 insertions, 0 deletions).
`package.json` reads 1.80.8, and this commit does not move it.

This row is the ladder walked as a queue row: six stages once, in order, `commit -> version -> push -> pr -> merge
-> main`. This stage is the first rung, and H-01 is the only edge out of `commit`, handing its `commit-record` to
`version`.

## The symptom this commit names

The `github-force-merge` section of `docs/pipelines.md` gives the six stages and what each one does, but it never
says what kind the five handoffs between them are. A reader of that table can hold either model: a straight rail
that visits each stage once, or a graph with a back edge, because the seed's handoffs carry a `kind` the prose did
not mention. The shipped `pipeline-bundle.seed.json` has had five `sequence` handoffs since the ladder landed, so the
document was understating a property the panel already depends on: a row that enters at `commit` visits all six
stages once, in the table's order, and there is no loop to cross. The change is one paragraph stating that next to
the table it describes. No seed edit and no product code: the document already had this shape, and the prose now
says it.

## The change

`docs/pipelines.md`, immediately after the ladder table:

```text
All five handoffs are `sequence`: a row that enters at `commit` visits the six stages once each, in this table's
order, and there is no loop to cross.
```

"Five" is the count of the edges, not the stages: six stages chained end to end carry five handoffs, which is the
number of rows in the table minus one.

## The ladder walk, recorded from the shipped document

Read through the panel's own loader (`readBundle` in `lib/pipeline-bundle.js`), not from the raw JSON, so this is
the document the panel resolves from `pipeline-bundle.seed.json`. The probe was a scratch file outside the tree and
is not committed. Its output on the seed as committed:

    stages: commit -> version -> push -> pr -> merge -> main
    handoffs: 5 kinds: sequence,sequence,sequence,sequence,sequence
    all sequence: true
    walk: commit -> version -> push -> pr -> merge -> main
    visited 6 of 6 stages; revisions: 0
    edges: H-01,H-02,H-03,H-04,H-05
    edge artifacts: H-01 commit->version commit-record; H-02 version->push version-bump;
    H-03 push->pr pushed-branch; H-04 pr->merge pull-request; H-05 merge->main merge-record
    walk matches the doc table's order: true
    WALK OK
    exit 0

The probe refused a revisit, a branch (a stage with more than one outgoing handoff), any handoff whose `kind` is not
`sequence`, and a walk that does not land on all six stages. It exited 0 on the seed as committed, which is the
sentence the new paragraph adds to the document.

Order and artifacts, one row per stage, read from the same bundle:

| # | stage | title | artifact | schema | kind | path written | handoff in |
|---|-------|-------|----------|--------|------|--------------|------------|
| 1 | `commit` | Commit | `commit-record` | `commit-record/1` | `file` | `ledger/github-force-merge/commit.md` | none (entry) |
| 2 | `version` | Version | `version-bump` | `version-bump/1` | `file` | `ledger/github-force-merge/version.md` | H-01 |
| 3 | `push` | Push the branch | `pushed-branch` | `pushed-branch/1` | `pr` | `ledger/github-force-merge/push.md` | H-02 |
| 4 | `pr` | Open the pull request | `pull-request` | `pull-request/1` | `pr` | `ledger/github-force-merge/pr.md` | H-03 |
| 5 | `merge` | Merge | `merge-record` | `merge-record/1` | `pr` | `ledger/github-force-merge/merge.md` | H-04 |
| 6 | `main` | Confirm main moved | `main-moved` | `main-moved/1` | `pr` | `ledger/github-force-merge/main.md` | H-05 |

This record replaces the earlier walk's `commit.md` at the same path, because the ladder writes one fixed path per
stage. The file it replaced named a machine folder, and this one does not: everything above is repo-relative, so
`tools/absolute-paths.mjs` has nothing new to refuse. The allowlist line that existed only because that earlier
record named a machine folder is removed in the same commit, so the permission does not outlive the path it was
granted for; a line left at count 2 over a file that holds none would let a later edit quietly name two again.

## The landing is local-only by this stage's instruction

The queue line for this row ends "Land by PR against main", and the LANDING line this stage was started with
overrides it for this tree: the artifact is not a pull request, so the tree is local-only, and this stage commits
here and reports the commit. Nothing was pushed, no pull request was opened, and no tag or remote ref moved. The
ladder's later stages own any push, pull request and merge, and this stage did not pre-empt them. The remote agrees:
the branch is 1 commit ahead of `origin/main` and `git ls-remote --heads origin` prints nothing for it.

## The timing

All stamps are UTC. The panel is the clock for the first three rows; the rest are this stage's own.

| event | stamp | source |
|-------|-------|--------|
| row #1 entered `commit` visit 1 | 2026-11-10T03:24:23.727Z | the panel's queue file, `pipelineRun.enteredAt` |
| stage run `github-force-merge/commit#1` stamped | 2026-11-10T03:24:25.112Z | same file, `pipelineRun.stageRuns[0].at` / `startingAt` |
| job `b24d0e2c` started | 2026-11-10T03:24:26.218Z | the panel's `jobs.json` |
| clock read in this tree | 2026-11-10T03:24:58Z | this run |
| ladder walk green | 2026-11-10T03:28:42Z | this run |
| this commit created | 2026-11-10T03:32:46Z | the commit's own author stamp, `git log -1 --format=%aI`, preserved through the amend that wrote these last lines |

The remaining five stages' timings are not in this file: each is stamped by the panel when that stage's own run
starts and settles, and stage 1 cannot measure a clock it never held. Nothing after this stage was hand-started for
this record: the walk above is the document's graph, read and checked, not five stages run for real.

## Commands run, and their exact result

    git status --short                          # M docs/pipelines.md, one modified file
    git rev-parse HEAD                          # 23fbe1974b89420c3357add805760673b2754959
    git rev-parse origin/main                   # 23fbe1974b89420c3357add805760673b2754959
    git rev-list --left-right --count origin/main...HEAD   # 0 0

    node <scratch>/walk-github-ladder.mjs       # quoted above; WALK OK, exit 0

    npm run test:changed
    test:changed - 3 changed files against origin/main:
      docs/pipelines.md
      ledger/github-force-merge/commit.md
      tools/absolute-paths.allow
    test:changed - 4 test files name or import the diff (4 by name, 0 by import):
      test/absolute-paths.test.js  (names tools/absolute-paths.allow)
      test/pipeline-chip.test.js  (names docs/pipelines.md)
      test/pipeline-wait.test.js  (names docs/pipelines.md)
      test/pipelines.test.js  (names docs/pipelines.md)
    tests 65, pass 65, fail 0, duration_ms 14777.9394
    test:changed - 4 file(s), 14.9s, exit 0

    node tools/absolute-paths.mjs
    absolute-paths: clean - 1461 tracked files, 1309 paths in 249 allowlisted files, none new
    exit 0

    node tools/absolute-paths.mjs --rev HEAD
    absolute-paths: clean - 1461 files at HEAD, 1309 paths in 249 allowlisted files, none new
    exit 0

    git ls-remote --heads origin refs/heads/wtgui/pipeline-row-rung-2-6f9dd4
    (prints nothing, exit 0: the branch is not on origin, so nothing was pushed)
    git rev-list --left-right --count origin/main...HEAD
    0 1

The focused set is green, 65 tests and no failure. `test/absolute-paths.test.js` is in the set only because the
allowlist line was removed, and it is the test that proves this repository's own tree still passes with it gone.

## What this commit holds

One commit on top of `23fbe197`, subject naming the symptom:

    docs: the GitHub ladder has no loop to cross - all five handoffs are sequence

Three files. `docs/pipelines.md` carries the one paragraph (3 insertions). This record is the stage's artifact.
`tools/absolute-paths.allow` loses one line, the permission the earlier walk's `commit.md` needed and this record
does not. It is one revertable commit; a revert restores the paragraph, the earlier record and the allowlist line,
and no product code depends on any of them.

The number is not bumped here: this stage's ladder puts the bump in stage 2 (`version`), which reads this record and
applies the level in its own commit. The expected level for this landing is `patch`, 1.80.8 to 1.80.9, and the tree
still reads 1.80.8 so that stage can take it.

The commit's own sha is not written here: this file is inside the commit, so a hash written in it could only be the
hash of some other commit. The panel stamps it on the stage run when the stage settles, and
`git log --oneline 23fbe197..HEAD` answers it in the tree.

## What the next stage reads

`version` reads this artifact as its declared input (`commit-record`, schema `commit-record/1`, read-only) and
writes `ledger/github-force-merge/version.md`. The level is judged against this commit: one paragraph of prose under
`docs/`, which `docs/versioning.md` sets at patch ("a doc - anything under `docs/`"), so the level is a patch and not
a minor. A minor would need a new gate or a new capability; this paragraph states a property the seed already had.
