# github-force-merge stage 2 of 6: version

Stage: `version` (visit 1), pipeline `github-force-merge`, row #1 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/pipeline-row-rung-2-6f9dd4`, in the agent-worktree-gui clone. The
machine path is in the panel's own row, not in this file: a drive-letter path exists on one machine only, and
`tools/absolute-paths.mjs` refuses one that a record adds.
Branch: `wtgui/pipeline-row-rung-2-6f9dd4`.
Base and HEAD before this stage: `origin/main` at `23fbe197` (reading 1.80.8) and HEAD `f3612b12`, one commit above
it and also reading 1.80.8.
Working tree before this stage: clean, 0 uncommitted files.

This stage is the second rung of the shipped `github-force-merge` ladder: six stages walked once, in order,
`commit -> version -> push -> pr -> merge -> main`, with H-01 `commit` to `version` and H-02 `version` to `push`.
Stage 1 landed the paragraph that says every handoff in this ladder is a `sequence`, so the walk that arrives here
can only leave for `push`: there is no branch to take and no hop back to `commit`.

## The level: patch

`node tools/version.mjs suggest` read the one commit this branch adds against `origin/main`:

    version suggest - 1 commit on this branch since origin/main
      patch f3612b12  docs: the GitHub ladder has no loop to cross - all five hando...
            docs: is a fix, a doc, a refactor or a test-only change
      (the PR's title and body were not read: no gh, or no PR for this branch)

    suggested level: patch
      The judgement is the landing agent's, and the bump belongs in this PR. See docs/versioning.md.
      Advice only - nothing was written.

The advice is the floor, not the answer, so the level is judged against what changed. Stage 1's commit adds one
paragraph after the ladder table in `docs/pipelines.md`:

    All five handoffs are `sequence`: a row that enters at `commit` visits the six stages once each, in this table's
    order, and there is no loop to cross.

`docs/versioning.md` sets "a doc - anything under `docs/`" at patch. It is not a minor: a minor is a new capability
or a new gate, and this paragraph states a property the shipped `pipeline-bundle.seed.json` already had, so nothing
can now fail a landing that could not before. It is not a major: no store, route, action grammar, config key or
gesture moves, and no file outside this repository reads the paragraph. So the level is `patch`, 1.80.8 to 1.80.9,
which is the level the queue line for this row expected.

The read of stage 1's record, the input this stage is handed:

    sha256sum ledger/github-force-merge/commit.md
    860a928d11b9ec003edde73ec4392e33d5f69acd66aadf9aa9ad25fa274edb23  ledger/github-force-merge/commit.md

which is the `sha256` the panel pinned on `commit-record` at `f3612b1233f4` (blob `2186b5164537`), so the record
read is the file the panel handed on.

## The write

`node tools/version.mjs apply patch --no-claim` ran on a tree that already carried this record, which is the
tool's dirty-tree path: it writes the number and stops, with no commit, no tag and no claim. That is the shape this
landing needs, because it is local-only - nothing this stage does may reach origin. Its own output:

    version apply: patch
      package.json  1.80.8 -> 1.80.9
      no commit and no tag: the tree carried 1 other change before the bump, and a tag belongs to a commit
      that carries the bump and nothing else:
        M ledger/github-force-merge/version.md
      the number is written but UNCLAIMED; commit the change, then anchor and claim it:
        node tools/version.mjs tag && node tools/version.mjs claim

The number was taken above `origin/main`'s own tree, which reads 1.80.8 at `23fbe197`, and `v1.80.9` was neither
anchored in this clone (`git tag -l 'v1.80.*'` ends at `v1.80.8`, an annotated tag at `7bbe7876`) nor carried by
origin (`git ls-remote --tags origin 'refs/tags/v1.80.9*'` prints nothing). So 1.80.9 is the next free patch above
the base and above every claim this clone can see.

No rebase or merge onto main was made: `f3612b12` is stage 1's commit and the panel handed its record on pinned at
`860a928d11b9`, so rewriting it would orphan the handoff this ladder exists to walk. `check` compares the two
numbers, not ancestry, and 1.80.9 is strictly above main's 1.80.8.

Its "then anchor and claim it" advice is followed only as far as the anchor: this landing is local-only, so the tag
is created here and never pushed, and the claim (`git push origin refs/tags/v1.80.9`) is not taken. The number is
therefore unclaimed on origin, which is the honest state for a branch nobody is pushing.

The bump is not its own commit: it is staged with this record and lands as one commit, which is what "apply it in
the same commit" asks and what stage 1's `non` input ("a version bump in a second commit") forbids this ladder
from doing.

## The gate

`node tools/version.mjs check` was run at HEAD after this commit existed, and again after the amend that wrote
these last lines, and both reads exited 0. The second read's output, which is the final tree's:

    version check: ok - the branch's number is above origin/main's
      branch  1.80.9  (HEAD's package.json)
      base    origin/main  1.80.8  (23fbe197)
      2 commits to land on top of origin/main

## The anchor

`v1.80.9` is an annotated tag on this commit, created by `node tools/version.mjs tag` and never pushed. This file
cannot print the commit's sha - it is inside that commit - so the anchor is proven from the tree instead:

    git tag --points-at HEAD          # v1.80.9
    git rev-parse 'v1.80.9^{}'        # equals git rev-parse HEAD

Both reads were taken after the record's final edit and the tag's final move, so the tag names the commit this file
is in and nothing older. On origin the tag does not exist: `git ls-remote --tags origin 'refs/tags/v1.80.9*'`
prints nothing, which is the local-only state this landing orders and the reason no number is claimed. Whoever
lands this branch moves the anchor onto the commit main carries; the panel's later stages own that, and this stage
neither pushes nor claims.

`npm run verify:version-tags` is red on this tree, and by construction: it judges tags against `origin`, so it
reports `missing v1.80.9 ... this checkout's v1.80.9 is not on origin: git push origin v1.80.9`
while this landing forbids the push that would clear it. It ends `FAIL - 5 findings across 530 version bumps`: the
one missing tag this stage made locally, plus four that are upstream history this branch does not touch (two
versions that go backwards, 1.76.13 to 1.76.12 at `f4cdd0d759` and 1.79.0 to 1.78.0 at `bf4b57b0d7`, and two tags
on origin naming other commits, v1.76.22 and v1.76.23). The stage's gate is `node tools/version.mjs check`, which
exits 0 above; the push stage after this one carries the branch and the tag together and is where origin learns
the number.

## The timing

All stamps are UTC. The panel is the clock for the first four rows; the rest are this stage's own.

| event | stamp | source |
|-------|-------|--------|
| stage 1 settled, H-01 crossed | 2026-11-10T03:35:45.317Z | the panel's queue file, `stageRuns[0].settledAt` |
| row #1 entered `version` visit 1 | 2026-11-10T03:35:45.317Z | same file, `pipelineRun.enteredAt` / `stageRuns[1].at` |
| row #1's `startedAt` | 2026-11-10T03:35:47.254Z | same file, the row |
| job `e8f29b04` started | 2026-11-10T03:35:46.960Z | the panel's `jobs.json` |
| `node tools/version.mjs suggest` read | 2026-11-10T03:36:38Z | a clock read immediately after it |
| `node tools/version.mjs apply patch` wrote the number | 2026-11-10T03:37:14Z | `package.json`'s mtime after the write |
| this commit created | 2026-11-10T03:40:06Z | the commit's own author stamp, `%aI`, preserved through the amend |

The remaining four stages' timings are not in this file: each is stamped by the panel when that stage's own run
starts and settles, and this stage cannot measure a clock it never held.

## Commands run, and their exact result

    node tools/version.mjs suggest                 # patch, quoted above; writes nothing
    sha256sum ledger/github-force-merge/commit.md  # 860a928d11b9..., the panel's pin
    node tools/version.mjs apply patch --no-claim  # 1.80.8 -> 1.80.9, quoted above

    npm run test:changed -- --list
    test:changed - 5 changed files against origin/main:
      docs/pipelines.md
      ledger/github-force-merge/commit.md
      ledger/github-force-merge/version.md
      package.json
      tools/absolute-paths.allow
    test:changed - 27 test files name or import the diff (27 by name, 0 by import)

    npm run test:changed
    tests 230, pass 229, fail 1, duration_ms 105001.9
    test:changed - 27 file(s), 105.0s, exit 1

The one failure is `test/harness.test.js` "every declared harness is wired the way its own header says":
`tools/verify-round-tree-names.mjs` says LIVE GATE and no `package.json` script runs it. It is pre-existing and not
this branch's: the only change this branch makes to `package.json` is the version line, and the harness test reads
the script names and the tools' headers, neither of which this diff moves. The same failure is recorded on
`origin/main` by stage 1's tree, which ran the set before this stage existed.

    node tools/absolute-paths.mjs
    absolute-paths: clean - 1461 tracked files, 1309 paths in 249 allowlisted files, none new
    exit 0

## What this commit holds

One commit on top of `f3612b12`, subject naming the version:

    chore: 1.80.9 - the version this landing carries

Two files. `package.json` carries the one number: 1.80.8, where this branch was cut and where `origin/main` still
stands, to 1.80.9. This record is the stage's artifact. The commit body carries the level (`patch`) and the reason
for it, which `docs/versioning.md` requires of the commit the change lands with. It is one revertable commit: a
revert removes the number and this record, and no product code depends on either.

The commit's own sha is not written here: this file is inside the commit, so a hash written in it could only be
the hash of some other commit. The panel stamps it on the stage run when the stage settles, and
`git log --oneline f3612b12..HEAD` answers it in the tree.

## What the next stage reads

`push` reads this artifact as its declared input (`version-bump`, schema `version-bump/1`, read-only) and writes
`ledger/github-force-merge/push.md`. The number it will push is 1.80.9, above `origin/main`'s 1.80.8, so the
pre-push version gate has nothing to refuse. This stage pushed nothing and claimed nothing: the branch, the tag and
its record are local, which is what this landing's LANDING line orders, and the push decision is `push`'s own stage
to take or refuse.
