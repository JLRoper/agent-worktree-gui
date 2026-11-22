# Landing: the collision count is about live pairs, keyed by the trees it names (1.155.3)

The Human button carried collisions the reader could not clear. Three shapes were measured on the live panel on
2026-11-22, all of them from the collision book rather than from the board: a pair that came back under a second key
after the panel renamed its two trees, so the ruling on the first record cleared nothing; a pair whose only "shared
file" was a parent directory both trees had written different subtrees under; and records left on the button after
every tree they named had been removed from disk.

## One physical pair is one record, whatever its directories are called

The key was the two worktree DIRECTORY names, sorted (`pairKey`). The panel renames a worktree directory and branch
when its run settles on a title (`lib/worktree-naming.js`), and the only part of either name a rename keeps is the
six-hex tag (`lib/tree-names.js` `tagOf`, whose `treeKey` is the naming ledger's own identity). So one pair of trees
produced two records - the reader measured `research-round-a-for-the-initiatives-tab-e85acb` against
`...-b-...-1d1d2c`, and then the same two trees under the run slugs - the ruling stored on the first key was not the
record the second was asking about, and the pair escalated twice.

The key is now the tree's IDENTITY: `tagOf(path) || tagOf(branch)`, and the normalised path only for a tree that
carries no tag (one the panel did not cut), which is exactly what every key was before (`treeIdentityOf`,
`lib/collisions.js:126`; `pairKey`, line 132). The sides are ordered by identity too (`detectCollisions`, line 429),
so a rename cannot swap them either.

A ruling, a stand-down and a supersession all say "this SIDE", and the identity order can disagree with the old path
order about which side is `a`. They move with their trees instead of staying on a letter: `reorderSides`
(`lib/collisions.js:151`) flips `ruling.pick`, `stoodDown.a/b`, `superseded.side` and the informational side of a
filing whenever a record's stored sides are not in identity order, and `upsertDetected` runs it before it renames the
ruling's own sentence to the tree's current spelling.

The book on disk already held the two older records, so the key alone would have left both phantoms beside a fresh
record for the live pair. `normalizeKeys` (`lib/collisions.js:1031`) re-keys every record on load and folds the older
spellings into one: a record with a ruling is the one that speaks (`speaksToday`), the other's notes and filings are
merged into it (`foldRecord`), and its reader hand-over does not survive the answer. This is the persisted form of the
same defect, and it is what makes the fix land on the panel the reader is looking at rather than only on the next pair.

## A shared parent directory is not a shared file

`git status --porcelain=v2` collapses an untracked tree to ONE entry ending in `/`, so two trees that each wrote their
own subtree under `docs/assets/initiatives-redesign/` were reported as sharing that directory: one had written 39 files
under `a/`, the other 18 under `b/`, and no tracked file was modified in either. The pair was in the book on the
strength of a directory name.

`touchedOf` (`lib/collisions.js:357`) now expands an untracked directory to the real files beneath it (`filesUnder`,
line 328): bounded at `TOUCHED_DIR_CAP = 500` (line 312), never following a symlink, never walking `.git`, and empty -
no evidence - when the directory cannot be read, because a listing the panel does not have is not evidence. A pair
still forms when both sides really do write one file inside the directory, and the directory itself is never listed as
the shared path.

## A record whose every side is gone is over

`closeUndetected` keeps a record that is waiting on the reader, and nothing detects a pair whose trees have been
removed, so the badge outlived the work it was about. A reported note whose reporting tree was gone had the same
shape and could only be dropped by an explicit `op:forget`.

The sweep now asks the disk (`lib/collision-flow.js:393`, step 3b): a record in the reader state whose EVERY side is
absent - no tree at that path, or a row the scan marked released - becomes a verdict through `markAbsent`
(`lib/collisions.js:1448`), `stateOf` reads it as `absent`, the reader hand-over is cleared, and the record is kept for
reading rather than deleted, so the reason nobody is asked stays in the book. A record with one side still standing is
untouched, and a pair detected again clears the verdict (`upsertDetected`). The question travels through a probe
(`treeExists`, wired to `existsSync` at `server.js:3166`), so a sweep that cannot read the disk claims no absence. The
marker says which verdict it is (`public/core/review-lane.js:227`): "every tree it names is gone from disk" for the
pair, "no row on this board and no live agent answers to it" for the note that never had a counterpart.

## The run

`test/collision-count.test.js` holds the four cases: one for each defect, plus the older book's fold, which is defect
1 in the shape the reader actually had. Each names the measured trees and the measured file counts rather than a
simplified shape, and none of them imports a helper the fix added: the assertions are about behaviour, so the build
that shipped the defects runs them and fails on its own answer.

Failing-first, proved rather than asserted: the same test file copied into a `git archive` of `ac327faf`, the tree
that shipped the defects, reads 0 of 4 passing (each case fails on its own answer, not at import); on this tip it reads
4 of 4.

The suites that name or import the changed modules were run on the REBASED tip - `test/collisions.test.js`,
`test/collision-settle.test.js`, `test/collision-card.test.js`, `test/collision-count.test.js` and
`test/review-lane.test.js`: 78 tests, 78 pass, 0 fail. That includes every escalation case the sweep already had.

The full suite, `npm test` (`node --test --test-concurrency=4 test/*.test.js`, 412 files), was run once on this
branch's commit: exit 0, no failing test. The base then moved six commits, so the collision suites above were re-run
on the rebased tip rather than quoting the pre-rebase reading as current.

## The version and the base

1.155.3, a patch: fixes in what the collision book counts, no new capability. The branch was cut from `f3f08550`, six
commits behind `origin/main`; it was rebased onto `17c78060` (1.155.2) before the pull request was opened, so the bump
sits above the number the base carries. The sweep's own answer (`routes/collisions.js:70`) now says when it closed
records whose trees are gone, so a reader of the log sees the verdict rather than only the pairs it swept.
