# Landing: a collision is one card per pair, on both rows, and siblings are compared against each other (1.128.0)

PR #802 merged into `main` as `9f5d59c`. The changelog render followed it at `34a87ef`. A collision was a card per row that each side had to reconcile by
hand; it is now one record per PAIR, drawn on both rows it involves, with the counterpart named on each. And two
branches cut from one parent that touch the same file are caught as a pair instead of being filed twice against the
parent.

## What landed

- `lib/collisions.js` - `detectCollisions(rows)` pairs live rows of one project in PATH ORDER, so the same pair is the
  same key whichever row the sweep starts from, and `sideOf(row)` carries the queue task id the board knows
  (`row.taskId`). `forTree(treePath)` answers BOTH sides (`a`, `b`, `role`, `other`, `otherTarget`), which is what lets
  a row draw the pair once and name the counterpart instead of a card that only knew its own half. `standDown(key,
  side, {taskId, state})` keeps the reason a side yielded, and `closeUndetected` keeps a stood-down record for
  `COLLISION_RESOLVED_KEEP_MS` after the detector stops seeing it, so the reason can be read on both rows before the
  record becomes history. `relationSentence` reads the merge-target relation from the landing side's own branch, so the
  sentence is the same on either row.
- The evidence rule is kept and tightened: a pair EXISTS only when the two trees touch a shared path. `merge-target` is
  context on a pair that already has evidence - filed alone it is noise, which is how four rows were filed in one night
  against the primary checkout on `main`. Two branches cut from ANY shared parent that each COMMITTED a change to the
  same path are `sibling` pairs (`turnover: true` under a turnover branch, and the committed paths are subtracted from
  the ordinary shared-file evidence so the same path is not reported twice).
- `lib/collision-flow.js` - `sweepCollisions` stamps each side's queue task through `taskIdFor(row)` before detection;
  the pair record therefore holds both task ids, and a re-detection with no resolver cannot wipe an id the record
  already has. The stopped notice's id and state travel into the stand-down.
- `server.js` - `collisionTaskFor(row)` reads the newest OPEN queue row standing in that tree from the owning
  assistant's queue, so the card says `#12` when the board knows one and says nothing when it does not.
- `public/board-scaffold.js`, `public/style.css` - the card draws the pair once: a head naming the counterpart, and a
  sides strip with THIS ROW and COUNTERPART, each with branch and task id. The shared files stay as chips, and a
  stand-down prints its reason on both cards.
- `public/app.js` - a ruling press carries both sides back into the row, so the card can still name the counterpart
  after the answer arrives.
- `tools/verify-collision-pairs.mjs` (new), `npm run verify:collision-pairs` - the four cases headless at 1440x900:
  one pair on both rows with the counterpart named; a real shared-file pair filed and stood down with its reason on
  both; a sibling pair; and the merge-target-only case filing nothing. Plus the ruled-and-re-detected read, the badge
  counted once, H stepping in, and the Settings switch off and on.

## The proof it landed with

- `npm run verify:collision-pairs` - 55/55 checks, five screenshots at 1440x900.
- `npm run verify:collisions` (the 1.123.0 harness) - 35/35.
- `test/collisions.test.js` - 28 tests: pair identity from either side, the ruling memory, the sibling comparison, the
  stand-down reason on both rows, and the merge-target-only pair filing nothing.
- `npm test` once before the PR: two failures, both pre-existing on `main` (`scan-roots`' settings folder,
  `reasoning-runs`' restart, reproduced 3/3 on `main` before this branch existed).

## Version

minor: 1.127.0 -> 1.128.0. A new capability that breaks nothing - the pair record gains `taskId` on its sides and a
reason on a stand-down, both additive, and an existing `collisions.json` still loads (a legacy bare-timestamp
stand-down is normalised). `GET /api/collisions` answers the same shape with richer records.
