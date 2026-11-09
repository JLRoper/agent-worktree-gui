# github-force-merge stage 1 of 6: commit

Stage: `commit` (visit 1), pipeline `github-force-merge`, row #58 in assistant-3's queue.
Tree: `C:/ProjectDevelopment/agent-worktree-gui/.worktrees/github-landing-sanity-0bbdd3` (repo-relative `.worktrees/github-landing-sanity-0bbdd3`).
Branch: `wtgui/github-landing-sanity-0bbdd3`.
Base and HEAD before this commit: `b1226087` ("chore: 1.76.25 - the version this landing carries"), 0 commits behind `origin/main` at the read.
Working tree before this commit: one modified file, `test/pipeline-bundle-seed.test.js` (9 insertions, 0 deletions).

## The symptom this commit names

The shipped `github-force-merge` ladder is the panel's GitHub turnover rail: six stages that must be walked once,
in order. Nothing in the seed test pinned the shape of its handoffs, so a later edit could turn one hop into a loop
(or add a branch) and the seed test would still pass, while a live walk from `commit` would re-enter a stage it had
already run, re-pushing or re-merging. The change is one assertion pinning that every handoff in the ladder is a
`sequence`, which is the same statement as "a walk from `commit` visits all six stages once and there is no loop to
cross".

## The change

`test/pipeline-bundle-seed.test.js`, in "the seed's three small pipelines are complete: 2-3 stages each, with the
capped loops their names promise", immediately after the ladder's artifact-kind pin:

```js
const github = byId.get("github-force-merge");
assert.deepEqual(
  github.handoffs.map((entry) => entry.kind),
  ["sequence", "sequence", "sequence", "sequence", "sequence"],
  "the GitHub ladder has no loop: every handoff is a sequence",
);
```

No product code, no seed edit: the document already has this shape, and the assertion is the pin that keeps it.

## The ladder walk, recorded from the shipped document

The walk was read through the panel's own loader (`readBundle` in `lib/pipeline-bundle.js`), not from the raw JSON,
so the graph below is the document the panel resolves from `pipeline-bundle.seed.json`.

Order and artifacts, one row per stage:

| # | stage | title | artifact | schema | kind | path written | handoff in |
|---|-------|-------|----------|--------|------|--------------|------------|
| 1 | `commit` | Commit | `commit-record` | `commit-record/1` | `file` | `ledger/github-force-merge/commit.md` | none (entry) |
| 2 | `version` | Version | `version-bump` | `version-bump/1` | `file` | `ledger/github-force-merge/version.md` | H-01 |
| 3 | `push` | Push the branch | `pushed-branch` | `pushed-branch/1` | `pr` | `ledger/github-force-merge/push.md` | H-02 |
| 4 | `pr` | Open the pull request | `pull-request` | `pull-request/1` | `pr` | `ledger/github-force-merge/pr.md` | H-03 |
| 5 | `merge` | Merge | `merge-record` | `merge-record/1` | `pr` | `ledger/github-force-merge/merge.md` | H-04 |
| 6 | `main` | Confirm main moved | `main-moved` | `main-moved/1` | `pr` | `ledger/github-force-merge/main.md` | H-05 |

The five handoffs, all `sequence`, chained H-01 `commit` to `version`, H-02 `version` to `push`, H-03 `push` to `pr`,
H-04 `pr` to `merge`, H-05 `merge` to `main`. The walk script's output on the seed as committed:

    stages visited: 6 of 6
    handoffs: 5 all sequence: true
    revisits: 0
    1. commit - commit-record (file/commit-record/1) -> ledger/github-force-merge/commit.md
    2. version - version-bump (file/version-bump/1) -> ledger/github-force-merge/version.md
    3. push - pushed-branch (pr/pushed-branch/1) -> ledger/github-force-merge/push.md
    4. pr - pull-request (pr/pull-request/1) -> ledger/github-force-merge/pr.md
    5. merge - merge-record (pr/merge-record/1) -> ledger/github-force-merge/merge.md
    6. main - main-moved (pr/main-moved/1) -> ledger/github-force-merge/main.md
    order: commit -> version -> push -> pr -> merge -> main
    WALK OK

The script refused a revisit, a branch (more than one outgoing handoff), a non-`sequence` edge and a handoff whose
artifact is not the one the stage writes; it exited 0. `push` declares its artifact's kind as `pr` even though the
stage itself is a push: the kind describes the landing, and the seed's own pin in the same test already asserts it.

## The timing

All stamps are UTC. The panel is the clock: these two are read from its own books, and the rest are this stage's.

| event | stamp | source |
|-------|-------|--------|
| row #58 entered `commit` visit 1 | 2026-11-09T22:29:38.384Z | `~/.wag/state/assistants/assistant-3/queue.json`, `pipelineRun.enteredAt` |
| stage run `github-force-merge/commit#1` stamped | 2026-11-09T22:29:40.098Z | same file, `pipelineRun.stageRuns[0].at` / `startingAt` |
| job `3615f3f1` started | 2026-11-09T22:29:41.037Z | `~/.wag/state/jobs.json` |
| first command in this tree (HEAD, status, origin/main read) | 2026-11-09T22:31:54Z | this run |
| this commit created | 2026-11-09T22:32:44Z | the commit's own committer stamp, `git log -1 --format=%cI` |

Span: 3 minutes 4 seconds from the stage run's stamp to the commit, 3 minutes 3 seconds from the job's start.
The remaining five stages' timings are not in this file: each is stamped by the panel when that stage's own run
starts and settles (`stageRuns[].at` and the entry's settle), and stage 1 cannot measure a clock it never held.
Nothing after this stage was hand-started: the walk above is the document's graph, read and checked, not five stages
run for real. Running `push`, `pr`, `merge` and `main` for real is what the panel's driver does, with the permission
boxes that only the reader can grant.

## Commands run, and their exact result

    node -e '...'            # stage/handoff read from pipeline-bundle.seed.json: 6 stages, 5 sequence handoffs

    npm run test:module test/pipeline-bundle-seed.test.js
    > agent-worktree-gui@1.76.25 test:module
    > node tools/test-module.mjs test/pipeline-bundle-seed.test.js
    test:module - test/pipeline-bundle-seed.test.js: 1 test file name or import it.
      test/pipeline-bundle-seed.test.js  (named itself)
      seed-pipeline-bundle: C:\Users\roper\AppData\Local\Temp\wtgui-seed-UUphUZ\pipeline-bundle.json already exists
      - leave it alone, or pass --force to replace it with the shipped seed
    pass 6, fail 0, duration_ms 456.0761
    test:module - 1 file(s), 0.5s, exit 0

    node walk-github-force-merge.mjs   # the walk quoted above; exit 0

    npm run test:changed -- --list
    test:changed - 1 changed file against origin/main:
      test/pipeline-bundle-seed.test.js
    test:changed - no test names or imports any of them. That is a sentence, not a pass: run npm test if the
    change is broad.

The last line is why the focused run was `test:module` on the file itself rather than `test:changed`: the only
changed file is the test, so the module run is the whole of what the diff can break, and it is green. The full suite
is stage 1's to run only if the reader asks for it; this stage changed one assertion inside one test file.

## What this commit holds

One commit on top of `b1226087`, subject naming the symptom:

    test: the GitHub ladder has no loop to cross - every handoff is a sequence

Two files: `test/pipeline-bundle-seed.test.js` (the assertion, 9 insertions) and this record. It is one revertable
commit; a revert removes only the pin and this file, and no product code depends on either.

The commit's own sha is not written here: this file is inside the commit, so a hash written in it could only be the
hash of some other commit. The panel stamps it on the stage run (`pipelineRun.stageRuns[0].commit`) when the stage
settles, and `git log --oneline b1226087..HEAD` answers it in the tree.

## What the next stage reads

`version` reads this artifact as its declared input (`commit-record`, schema `commit-record/1`, read-only) and
writes `ledger/github-force-merge/version.md`. The version level is judged against this commit: one assertion in a
test file, no product code, so the level is a patch, not a minor.
