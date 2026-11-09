# github-force-merge stage 2 of 6: version

Stage: `version` (visit 1), pipeline `github-force-merge`, row #58 in assistant-3's queue.
Tree: the repo-relative worktree `.worktrees/github-landing-sanity-0bbdd3`, in the agent-worktree-gui clone. The
machine path is in the panel's own row, not in this file: a drive-letter path exists on one machine only, and
`tools/absolute-paths.mjs` refuses one that a record adds.
Branch: `wtgui/github-landing-sanity-0bbdd3`.
Base and HEAD before this stage: `origin/main` at 1.76.25 (`b1226087`, whose `v1.76.25` tag is on it) and HEAD `67a5d5b7`, one commit above it.
Working tree before this stage: clean, 0 uncommitted files.

This stage is the second rung of the shipped `github-force-merge` ladder: six stages walked once, in order,
`commit -> version -> push -> pr -> merge -> main`, with H-01 `commit` to `version` and H-02 `version` to `push`.
The pin stage 1 landed asserts every handoff in that ladder is a `sequence`, so the walk that arrives here can only
leave for `push`: there is no branch to take and no hop back to `commit`.

## The level: patch

`node tools/version.mjs suggest` read the one commit this branch adds against `origin/main`:

    version suggest - 1 commit on this branch since origin/main
      patch 67a5d5b7  test: the GitHub ladder has no loop to cross - every handoff ...
            test: is a fix, a doc, a refactor or a test-only change
      (the PR's title and body were not read: no gh, or no PR for this branch)

    suggested level: patch

The advice is the floor, not the answer, so the level is judged against what changed. The change is one assertion
inside `test/pipeline-bundle-seed.test.js`: it pins that every handoff in the GitHub ladder is a `sequence`. That is
a test-only change, which `docs/versioning.md` sets at patch ("a test-only change - adjusting, extending or
repairing a harness"). It is not a minor: a NEW gate would be a minor, and this only tightens a test that already
existed and already ran, over a document shape the seed already had. It is not a major: no store, route, action
grammar, config key or gesture moves, and nothing outside this branch reads the assertion. So the level is `patch`.

The number moved while the stage ran. `apply` first wrote 1.76.26, above the 1.76.25 the branch was cut at; then
`origin/main` landed 1.76.27 and a sibling lane claimed `v1.76.28` on origin, so the final number is 1.76.29, above
main's current tip and above every claim the remote carries. The base move is recorded under The write, because a
number that skipped rungs has to say which claims it stepped past.

The read of stage 1's record, the input this stage is handed:

    sha256sum ledger/github-force-merge/commit.md
    a7d6b07ab12510e9614b0abcba935994dcc438bdba2612ec7dc8eb61a1bc44b1  ledger/github-force-merge/commit.md

which is the `sha256` the panel pinned on `commit-record` at `67a5d5b7edd0` (blob `86d0c0b9fb22`), so the record
read is the file the panel handed on.

## The write

`node tools/version.mjs apply patch` ran on a tree that already carried this record, which is the tool's
dirty-tree path: it writes the number and stops, with no commit, no tag and no claim. That is the shape this
landing needs, because it is local-only - nothing this stage does may reach origin. Its own output:

    version apply: patch
      package.json  1.76.25 -> 1.76.26
      no commit and no tag: the tree carried 1 other change before the bump, and a tag belongs to a commit
      that carries the bump and nothing else:
        ?? ledger/github-force-merge/version.md
      the number is written but UNCLAIMED; commit the change, then anchor and claim it:
        node tools/version.mjs tag && node tools/version.mjs claim

Then `origin/main` moved under the stage. At 22:53Z it read 1.76.27 (`621ff6c6`, a changelog render over
`3c0d4d88`, the `feat:` commit that declared the number), so a branch declaring 1.76.26 was behind it and `check`
refused: "this branch's version is behind origin/main's". The number was re-taken on the same dirty-tree path,
which reads the base's tip and steps past any number this clone already anchors:

    version apply: patch
      package.json  1.76.26 -> 1.76.29
      base          origin/main reads 1.76.27, so the number was taken above the base, not above this branch
      skipped       v1.76.28 is already anchored at 235a1f39b9 - taken, so this branch takes 1.76.29
      no commit and no tag: the tree carried 1 other change before the bump, and a tag belongs to a commit
      that carries the bump and nothing else:
        M ledger/github-force-merge/version.md

`v1.76.28` peels to `235a1f39b977`, a commit this branch never fetched: the claim belongs to another lane, and the
tool stepped over it. So the final number is 1.76.29, one patch above main's 1.76.27 and above every claim this
clone carries.

The branch was not rebased or merged onto the moved main. `67a5d5b7` is stage 1's commit and the panel handed its
record on pinned at `a7d6b07ab125`; rewriting it to put this branch on main would orphan the handoff this ladder
exists to walk, and a merge commit would split this stage's bump from its record. `check` compares the two numbers,
not ancestry, and 1.76.29 is strictly above main's 1.76.27.

Its "then anchor and claim it" advice is followed only as far as the anchor: this landing is local-only, so the tag
is created here and never pushed, and the claim (`git push origin refs/tags/v1.76.29`) is not taken. The number is
therefore unclaimed on origin, which is the honest state for a branch nobody is pushing. The 1.76.26 anchor this
stage first made was removed with `git tag -d v1.76.26` when the number moved: no commit on this branch declares
1.76.26 any more, and a local tag on a sha nobody can reach is a dead number.

The bump is not its own commit: it is staged with this record and lands as one commit, which is what "apply it in
the same commit" asks and what stage 1's `non` input ("a version bump in a second commit") forbids this ladder
from doing.

## The gate

`node tools/version.mjs check` at HEAD exited 0. Its first line is `version check: ok`, and the lines it printed to
prove what it compared:

      branch  1.76.26  (HEAD's package.json)
      base    origin/main  1.76.25  (b1226087)
      2 commits to land on top of origin/main

The base's number is read out of `origin/main`'s own tree at its current tip, never this checkout's file, and the
branch's out of HEAD's `package.json`: 1.76.26 is strictly above 1.76.25, so the gate passes with the two commits
this branch adds (stage 1's and this stage's). The check was run again after the record's last edit and printed
the same three lines, so the reading above is the final tree's.

## The anchor

`v1.76.26` is an annotated tag on this commit, created by `node tools/version.mjs tag` and never pushed. This file
cannot print the commit's sha - it is inside that commit - so the anchor is proven from the tree instead:

    git tag --points-at HEAD          # v1.76.26
    git rev-parse 'v1.76.26^{}'       # equals git rev-parse HEAD

Both were read after the record's final edit and the tag's final move (`node tools/version.mjs tag --force`), so
the tag names the commit this file is in and nothing older. On origin the tag does not exist:
`git ls-remote --tags origin 'refs/tags/v1.76.26'` prints nothing, which is the local-only state this landing
orders and the reason no number is claimed. Whoever lands this branch moves the anchor onto the commit main
carries; the panel's later stages own that, and this stage neither pushes nor claims.

## The timing

All stamps are UTC. The panel is the clock for the first three rows; the rest are this stage's own.

| event | stamp | source |
|-------|-------|--------|
| row #58 entered `version` visit 1 | 2026-11-09T22:33:42.633Z | `~/.wag/state/assistants/assistant-3/queue.json`, `pipelineRun.enteredAt` / `stageRuns[1].at` |
| row #58's `startedAt` | 2026-11-09T22:33:44.587Z | same file, the row |
| job `c68536c9` started | 2026-11-09T22:33:44.368Z | `~/.wag/state/jobs.json` |
| `node tools/version.mjs suggest` read | 2026-11-09T22:34:33Z | this run |
| focused test re-run green | 2026-11-09T22:36:08Z | this run |
| first commit of this stage created | 2026-11-09T22:37:57Z | the commit's author stamp, `%aI`, preserved through the amends |
| `origin/main` read 1.76.27 (`621ff6c6`) | 2026-11-09T22:53:08Z, read here at 22:55:23Z | the commit's own stamp; this run's fetch |
| the number moved to 1.76.29 | 2026-11-09T22:56:26Z | `package.json`'s mtime after the second `apply` |

Span: 4 minutes 14 seconds from the stage run's stamp (22:33:42.633Z) to the first commit (22:37:57Z), and
22 minutes 43 seconds to the number the record finally carries (22:56:26Z) - the difference is the base move, not
work: the stage sat idle between those stamps while `origin/main` landed 1.76.27 and the number was re-taken. The
commit's own `%cI` and the stage's settle are the panel's to read, not this file's: a stamp written inside the
commit would describe the commit before it existed.

Stage 1 settled at 2026-11-09T22:33:42.633Z (`stageRuns[0].settledAt`), so the handoff from `commit` to `version`
was the same stamp the stage entered on: the panel moved from one stage to the next in one settle, with no idle
gap of its own. The remaining four stages' timings are not in this file: each is stamped by the panel when that
stage's own run starts and settles, and this stage cannot measure a clock it never held.

## Commands run, and their exact result

    node tools/version.mjs suggest                 # patch, quoted above; writes nothing
    sha256sum ledger/github-force-merge/commit.md  # a7d6b07ab125..., the panel's pin

    npm run test:module test/pipeline-bundle-seed.test.js
    > agent-worktree-gui@1.76.25 test:module
    > node tools/test-module.mjs test/pipeline-bundle-seed.test.js
    tests 6, pass 6, fail 0, duration_ms 432.7628
    test:module - 1 file(s), 0.5s, exit 0

    npm run test:changed
    test:changed - 4 changed files against origin/main
    test:changed - 22 test files name or import the diff (22 by name, 0 by import)
    test:changed - 22 file(s), 234.8s, exit 1

That run answered four failing tests, and they split three ways. Two were `test/absolute-paths.test.js` refusing
records that name a machine folder: stage 1's `commit.md` (2 paths) and this record (1 path, its tree line). This
record's line is relative now, and stage 1's is settled the way the gate documents for a record that already
happened and must not be rewritten - an allowlist line, because the panel handed that file on pinned at
`a7d6b07ab125`. The same file re-run after both: 17 tests, 17 pass, 0 fail.

The other two fail on `origin/main` as well, in an export of that tree, so they are pre-existing and not this
branch's: `test/harness.test.js` ("every declared harness is wired the way its own header says":
`tools/verify-round-tree-names.mjs` says LIVE GATE and no package.json script runs it) and
`test/land-subject-dashes.test.js`, whose sandbox copies three tools while `tools/land.mjs` imports a fourth,
`tools/release-tag.mjs`, so the copied tree dies `ERR_MODULE_NOT_FOUND`.

A second `npm run test:changed` on this commit's tree, after the absolute-paths repair, read
`5 changed files`, `22 test files`, `22 file(s), 118.8s, exit 1`: the same two pre-existing failures, with
`test/absolute-paths.test.js` no longer among them.

The module run is the one that covers the change: stage 1 edited one test file and one record, and no test names
or imports them. The seed test is green with the pin in place, which is its own statement that the ladder has no
loop.

## What this commit holds

One commit on top of `67a5d5b7`, subject naming the version:

    chore: 1.76.29 - the version this landing carries

Three files. `package.json` carries the one number: 1.76.25, where this branch was cut, to 1.76.29, above
`origin/main`'s 1.76.27 and past the 1.76.28 another lane claimed. This record is the stage's artifact.
`tools/absolute-paths.allow` gains one line for stage 1's `commit.md`, which is the panel's handed-on input at a
pinned sha256 and therefore is not rewritten to scrub the tree path it records; the gate's own header names the
allowlist as the route for exactly that case. The commit body carries the level (`patch`) and the reason for it,
which `docs/versioning.md` requires of the commit the change lands with. It is one revertable commit: a revert
removes the number, this record and the allowlist line, and no product code depends on any of them.

The commit's own sha is not written here: this file is inside the commit, so a hash written in it could only be
the hash of some other commit. The panel stamps it on the stage run when the stage settles, and
`git log --oneline 67a5d5b7..HEAD` answers it in the tree.

## What the next stage reads

`push` reads this artifact as its declared input (`version-bump`, schema `version-bump/1`, read-only) and writes
`ledger/github-force-merge/push.md`. The number it will push is 1.76.29, above `origin/main`'s 1.76.27 and past the
1.76.28 another lane claimed, so the pre-push version gate has nothing to refuse. This stage pushed nothing and
claimed nothing: the branch, the tag and its record are local, which is what this landing's LANDING line orders,
and the push decision is `push`'s own stage to take or refuse.
