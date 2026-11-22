# A version-only overlap is a land order, and a leftover tree is absent

Two defects in the collision evidence, both measured on the live panel on 2026-11-22, and the accounting PR 845 fixed
left exactly as it was.

## 1. The badge counted the version line as a file fight

Every landing in this repo claims the next patch above main (`package.json`, written by `tools/version.mjs apply`), so
three live trees hold three different numbers at once and every pair of them "shares" package.json. PR 845 fixed the
ACCOUNTING of those pairs. It did not touch what they MEANT, so the badge came straight back: read from
`GET /api/collisions` at 03:11 on 2026-11-22, `count` was 3 with every one of the three reader records sharing exactly
one path, `package.json`.

That is not a file fight. The only differing hunk is the version line, and it is settled at LAND time: the land step
rebases onto the then-current origin/main and keeps the higher version. The order is already decided, so the pair is a
LAND ORDER: real, named, one record, and not a question for the reader.

`lib/collisions.js` now answers that classification (`VERSION_CARRIERS`, `versionInText`, `textWithoutVersion`,
`classifyVersionOnly`), and only answers it when EVERY shared path is a manifest version carrier and every one of them
differs in its version line alone:

| path | what counts as its version line |
|---|---|
| `package.json` | `"version": "..."` |
| `pom.xml` | the FIRST `<version>` element, the project's own |
| `version`, `version.txt` | the whole line, with or without a leading `v` |
| `lib/version.{js,mjs,cjs,ts}` | a `VERSION = "..."` constant |

The carriers are named by PATH, never by content: a `version: "1"` inside a source file is not a manifest version
field, and a content-only rule would read one as such. Anything else that differs anywhere in the file survives the
blanking and makes the answer `false`. The side with the LOWER number goes first, because the higher number is the one
that rebases on top of it.

The reading is a file read, not a merge: `lib/collision-merge.js` `probeVersionOnly` reads each side's working copy
first and the tip's blob when the file is not on disk in that tree. `lib/collision-flow.js` step 0a takes it every
sweep and writes it through `CollisionBook.rememberVersionCheck`, which only rewrites the record when the answer
changes, so an unchanged board stays an unchanged file. A positive answer becomes a ruling with
`basis: "version"` (`CollisionBook.markLandOrder`) and the record carries `landOrder` with both numbers.

### What is NOT weakened

- A gone pair still leaves the count: `markAbsent` on `trees-gone` is untouched, and the every-side-gone rule is
  unchanged (test/collision-count.test.js, case 4, still green).
- One live pair is still one record, keyed by tree identity, so a rename cannot re-key it.
- An untracked directory still expands to the real files under it.
- A shared source file, test or doc that both sides edited is still a collision and still reaches the reader. A pair
  that shares package.json AND a source file is classified by inspection without a single file read: if any shared path
  is not a carrier, the pair is an ordinary collision (`lib/collision-flow.js` step 0a, the `carriers` test).
- A land order that stops being one is WITHDRAWN, not kept: `CollisionBook.withdrawLandOrder` drops the answer and the
  pair runs the ordinary path in the same sweep, so a source file joining the overlap puts the pair back in front of
  the reader. It is deliberately not `autoWithheld`, which means the reader overruled a pick; nothing here was
  overruled.

## 2. A leftover directory kept two pairs asking

`git worktree remove` can refuse on a tree whose branch is gone, because a dead run's child still holds a file:
"Permission denied", and the folder survives with nothing behind it. The old absence rule asked the disk, and the
folder IS on disk, so the record stayed in the reader count forever. On the measured board this was the whole remaining
problem: of the three reader records, every one stands on at least one tree `git worktree list` does not list. The
round-b tree named in two of them is exactly the one that could not be deleted.

`lib/collision-merge.js` `registeredWorktrees` reads `git worktree list --porcelain`, and `lib/collision-flow.js` step
3b now asks it beside the disk probe: ONE side that git no longer registers is enough to settle the pair, because a
leftover directory has no branch to land and no worker to stand down. Only an explicit `false` counts; a repository
that could not be read is `null` and proves nothing. Nothing is deleted: the sweep reads the registration and marks the
record, and the folder is left exactly where it is.

On the measured board the three reader records therefore close by absence on the first sweep after this lands, and the
count goes from 3 to 0. Measured against the same data with the new code:

```
pair                                             sides registered   reading
fix-the-cleanup-...  vs research-round-b-...     false / true       package.json unreadable on the dead side
fix-the-cleanup-...  vs give-the-to-line-...     false / false      package.json unreadable on the dead side
give-the-to-line-... vs research-round-b-...     false / true       package.json unreadable on the dead side
```

The same three pairs also show why BOTH parts of this change are needed: a dead tree's manifest cannot be read at all,
so the version reading answers `ok: false` and the pair would be left asking without the registration rule.

## What the reader sees

- The row marker reads `land order with <tree> - 1 shared file - package.json - <tree> #12 vs <tree> #13 - land order:
  <lower> 1.155.5 goes first and <higher> 1.156.0 lands on top - a version line alone, not a file fight`
  (`public/core/review-lane.js` `landOrderOf`, `collisionTitle`).
- The card's heading, pill and History section say land order, with both numbers and the rule
  (`public/board-scaffold.js`), and the withdraw press says what it does.
- `GET /api/collisions` gains `landOrders` (a count) and each record gains `landOrder` and `versionCheck`
  (additive; the old shape still answers). The sweep's `say` names how many pairs it settled as a land order and how
  many orders it withdrew (`routes/collisions.js`).
- Nothing is filed into either queue for a land order and no ruling row is broadcast: the order is derivable by each
  worker from its own number, and a queue row would be a second, contradictory notice.

## Proof

```
node --test test/collision-version.test.js                 8 tests, 8 pass
node --test test/collision-count.test.js test/collisions.test.js \
  test/collision-card.test.js test/collision-settle.test.js  63 tests, 63 pass
node --test test/review-lane.test.js                       15 tests, 15 pass
npm run verify:collision-absence                           OK 27/27 checks
npm run verify:collision-pairs                             OK 110/110 checks
npm run verify:collisions                                  38/41, the same three as main
```

`test/collision-version.test.js` is the new file: package.json alone (no reader record, a land order naming both
numbers, no notice, and it survives a restart), package.json plus a source file (still a reader record, its title
naming `lib/shared.js`), a land order withdrawn when a source file joins the overlap, an unregistered tree (absent,
not asked) beside two registered trees (still the reader's), the classifier over each carrier and each way of saying
no, and the probe reading a working copy and a tip against a real repository.

The three `verify:collisions` checks that fail are PRE-EXISTING and unrelated: measured by stashing this branch's
changes and re-running the harness, `38/41` fails the same three checks ("the evidence is the one shared file", "each
diamond says the state and the count in words", "no digit is drawn in it") on the base tree. They are about the
measured evidence replacing a dirty-file overlap with an empty git diff, which is a separate defect and not this one.
