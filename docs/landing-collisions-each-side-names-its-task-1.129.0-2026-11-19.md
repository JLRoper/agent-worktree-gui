# Landing: each collision side names the task it is working (1.129.0)

PR #803 merged into `main` as `763c88e`. The changelog render followed it. A collision card said which TREE and which
BRANCH each side was on, which cannot tell two agents on one piece of work from two agents merely both landing into
`main` - one night that cost four rows of pure noise (a tree landing into `main` against the primary checkout on `main`,
no shared file) while one real pair (both trees editing `lib/paths.js`) looked exactly the same. Each side now names the
queue row that owns its tree, beside the tree and branch it already showed.

## What landed

- `lib/collisions.js` - `owningTaskFor(tree, queues)` is the resolution: every assistant's queue is searched for a row
  whose OWN `worktree` field is the tree, and the newest OPEN row wins over an older finished one in the same tree. The
  branch name is never the association - a row keeps its worktree through a branch rename, and two trees can carry the
  same branch text. `sideTaskOf(row, queue)` carries the number, the row's title, its state and the assistant whose
  queue holds it; `sideOf` puts it on the side as `task` (and keeps `taskId` for the older id-only seam). A row that is
  the panel's own collision notice or a ruling's priority row is skipped, because those name the same worktree and would
  otherwise be the newest row in that tree - answering "the task here is the collision notice", which says nothing
  about the work. `finishedSides(rec)` names the sides whose own task is done or parked; `forTree` answers it as
  `stoodByTask`, and `waiting` is false when any side has one. It is derived on every read and never written, so work
  that starts again in that tree brings the pair back as a live one.
- `lib/collision-flow.js` - `sweepCollisions` takes `taskFor(row)` (the composition root's resolver) and stamps both
  sides before detection. A finished side appends to `report.finished` and the pair is skipped before it can be handed
  to the reader: a collision with finished work is not a decision anyone has to arbitrate. The notice filed into each
  queue now names the other side's task number, title and state, not just its number.
- `server.js` - `collisionQueues()` reads the whole roster's queues ONCE per sweep and `owningTaskFor` resolves each
  side against them; the resolver is not limited to the lock-owner's assistant, because a tree's row can sit in any
  queue.
- `public/board-scaffold.js`, `public/style.css` - `collisionSideHtml` prints the task line under the branch: `#7`,
  the row's title, the assistant, and a state chip. A tree no row owns says "no task row on this tree" in those words
  rather than leaving a blank; a side whose task is done or parked is drawn dotted and its state chip reads "already
  stood down: sib-one (Compare the two siblings) is done", with the same sentence spelled out under the evidence. The
  task line wraps rather than ellipsising - the title is the reason the card exists.
- `public/core/review-lane.js` - the badge and the H rotation skip a pair with a finished side, and a collision marker's
  title names both sides' tasks, so a hover says whether two rows are on the same work.
- Pair identity, the ruling memory, the shared-files evidence and the "never file on the merge-target relation alone"
  rule are untouched: no record key, no ruling field and no detection rule changed.

## The proof it landed with

- `node tools/verify-collision-pairs.mjs` - 78/78 checks, nine screenshots at 1440x900, including the three new ones:
  `collision-pairs-tasks` (both cards naming `#7 Land the collision card on both rows` Assistant #1 running and
  `#8 Show each side's task beside its tree` Assistant #2 queued), `collision-pairs-no-row` (a side reading "no task
  row on this tree" beside a side naming `#71`), and `collision-pairs-done-side` (a done side reading as already
  stood down on both rows, with the pair out of the reader's rotation).
- `test/collisions.test.js` - 32 tests, including the three resolution cases (open row, no row, done row), the notice
  row never answering for the work, `finishedSides` on both sides, and the sweep stand-down on both rows.
- `npm test` once before the PR: two failures, both pre-existing on `main` and reproduced there
  (`paths.test.js` naming `pipelineBundleSeedFile`, `reasoning-runs`' restart), neither in this diff.

## Version

minor: 1.128.0 -> 1.129.0. Additive only - a collision record's sides gain `task` and `stoodByTask` and `GET
/api/collisions` answers the same shape with richer records; an existing `collisions.json` still loads.

## The branch this came from

The tree already carried three commits from the 1.128.0 landing (`c293223d`, `734e2b97`, `aa250a0e`), all reading `-`
against `origin/main` in `git cherry` - cherry-equivalents of work already landed and rebased. They were dropped by
rebasing onto `origin/main` and the branch was force-pushed, so the PR carried exactly three commits of its own:
the feature, the proof, and the version.
