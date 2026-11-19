# Landing: a collision - two live runs on one file, both rows marked, the reader rules the pair (1.123.0)

PR #796 merged into `main` as `6810969d`. Two live worktrees of one project that are touching the same work are now a
thing the board names, on both rows, with the evidence - and the pair is settled before either run finds out at the
merge.

## What landed

- `lib/collisions.js` (new) - the detector and the book. `detectCollisions(rows)` pairs live rows of one project by
  three relations, never a bare flag: the same touched file (`shared-file`, uncommitted or committed on either side,
  normalised so `a//b` and `./a` cannot slip past), one branch's merge target being the other's branch
  (`merge-target`), and two children of one turnover branch (`sibling-turnover`, with the sibling's committed paths
  subtracted so the same path is not reported twice). `CollisionBook` keeps the records in `collisions.json`,
  `recordNote` files a worker's note, `rule` stores a ruling against the PAIR, and `forget` only removes a reported
  note - a detected pair comes back on the next sweep and has to be ruled on.
- `lib/scan.js` - `row.commitFiles` and `row.commitSource`: `git diff --name-only <ref>...HEAD` on the merge base, so
  a branch that merged its parent does not claim the parent's commits, with `baseRef` as the fallback.
- `lib/collision-flow.js` (new) - the sweep, separate from detection because filing and escalating are workflow
  decisions: both assistants' queues get a row with the evidence, and the reader is only asked on the named
  conditions (two sweeps more than `COLLISION_PASS_MS` apart with nobody standing down).
- `lib/jobs.js` - the `COLLISION <target> | <sentence>` line, taught in the brief and parsed like `QUEUE` and
  `MESSAGE`, filed against the REPORTING tree; a malformed line is said aloud rather than swallowed.
- `routes/collisions.js` (new) - `GET`/`POST /api/collisions`: `sweep`, `ask`, `rule`, `forget`, authorised before the
  body is read.
- `server.js` - the book, the per-row overlay (`withCollisions` and `rowExtras`, because SSE row frames replace the
  row wholesale), the filing helper and the sweep.
- `public/core/review-lane.js` - collisions as the fourth Human kind: rank 3, `awaitingCollisions`, `collisions(rows)`
  deduped by pair, the badge tally, the split and the title clause, `collisionTitle`.
- `public/app.js`, `public/index.html` - the fourth switch in Settings > Human, the rotation item, `H` centring the
  card with the ruling press under the caret, and the press that writes the ruling.
- `public/board-scaffold.js`, `public/render-projects.js`, `public/style.css` - the violet diamond on both rows (the
  only mark about a relationship between two rows) and the card: state sentence, evidence chips, the counterpart's
  path and branch, the worker's own words, and the ruling presses.

## The two defects the fourth kind exposed

- `kindKey` read the switch off `rank()`, which answers 3 ("steps last") for a kind it does not know - so with
  collision in rank 3 an unknown kind answered to the collision switch. It reads the rank table now.
- `badge` counted every entry into `total`, giving a number no clause of the sentence accounted for. It counts only
  the kinds it can name. And `title` read an empty split as "every kind is switched off", which is also just a clear
  board - it asks the switches now.

## What proves it

- `node --test test/human-kinds.test.js test/review-lane.test.js test/collisions.test.js` - 46 tests, 46 pass.
- `node tools/verify-collisions.mjs` - 35/35 at 1440x900 against real git: two worktrees of one project with the same
  file dirty, both markers naming the other tree and the one shared file, the badge counting the pair once, `H` on the
  card, a worker's `COLLISION` line filed against its own tree and read back off the card, the ruling re-rendering both
  cards as "already ruled", and a re-detected pair still reading as ruled.
- `node tools/verify-human-kinds.mjs` - 46/46 with the four switches.
- `npm test` - 3195 tests, 3185 pass; the 10 failures reproduce identically on the exported `origin/main` tree (eight
  files) or were the absolute-paths gate, which now reads clean.

`origin/main` is at the render above `6810969d`; `git diff --stat 6810969d origin/main` lists only `CHANGELOG.md`, and
the tag `v1.123.0` sits at `80262a7a`, the commit that first declares the number.
