# Landing: a wave's lanes, and one commit that joins them (1.154.0)

Step 1 landed the wave record, the explicit membership and the state folded on every read. Step 2 made the gates read
live evidence. This row, step 3, adds the thing the design's section 6 was waiting for: a wave may hold LANES -
disjoint sets of its members that run side by side - and when a wave closes, its lanes are joined in ONE commit.

Three modules already knew how to do the hard half, and none of them is forked here:

- `lib/pipeline-fanout.js` carries the isolation rules: one lane, one tree, one base, one merge at the end.
- `lib/pipeline-aggregate.js` carries the one-commit join: pre-flight over the object database, then a single commit
  with one parent per lane.
- `lib/stage-pin.js` carries the pin: a commit AND a blob, because this repo squashes and rewrites the sha.

The wave side adds only what those three cannot know: which members belong to which lane, that the lane set is DERIVED
from the members' own records so a lane is never stored twice, and that the join's message names the lane set.

No scheduler, no automatic advance, no auto switch (those stay row 195), no write route, no new check name, and no new
field on the wave record.

## The lane set is derived on every read

`waveLanes` (`lib/waves.js:684`) answers `{lanes, count, implicit, joinOwed, isolation, refused}` and is called by the
fold on every read. Three rules decide a member's lane:

**A member that names a lane keeps it.** `waveLaneNamed` (`lib/waves.js:556`) reads the row's own `lane` field - the
same field the queue's `laneInfo` honours when a row carries one. The lane is therefore written ONCE, on the member,
and a wave cannot hold a second copy of it.

**A member that names none is grouped by the queue's file rule.** `intersectingFiles` (`lib/assistant/queue.js:132`)
is imported, not re-implemented: two rows that claim a common file are one lane, because one of them waits for the
other, and a directory claim intersects the files under it. `waveFileLanes` (`lib/waves.js:608`) adds only the
GROUPING - a disjoint set per lane, named by the lowest path the group shares - so the panel cannot end up with two
ideas of which rows touch one file. The members that share a file with nobody are the `unlaned` lane
(`WAVE_LANE_UNLANED`, `lib/waves.js:537`), which is the panel's own word for "none of these named a lane".

**When every member lands in that one lane, the wave holds ONE IMPLICIT LANE.** `implicit: true`, `joinOwed: false`, and
the wave folds and draws exactly as it did before lanes existed: no record field, no lane block, no join. That is the
backwards-compatibility clause, and `test/waves-lanes-join.test.js` asserts the `done` sentence is byte-for-byte the
one the fold produced before this row.

Nothing is stored. `pickWave` (`lib/waves.js:153`) builds the record from named fields only, so a `lanes` list written
into `waves.json` by hand is dropped, and the test loads such a file and reads the record back to prove no field
exists. A lane's state (`waveLaneStateOf`) is folded from its members - running holds the lane, a park that nobody
abandoned parks it, all closed makes it done - and is never written anywhere.

**A lane set that shares a tree is refused, not isolated.** `waveLaneClash` (`lib/waves.js:648`) reads the trees the
members name and refuses a set where two lanes hold one tree, naming both lanes and the tree. Two lanes in one tree can
read each other's files, which is the one thing a lane exists to prevent, and no amount of merging makes that
isolation true.

## The close is the aggregate's, and its message names the lane set

`joinWaveLanes` (`lib/waves.js:757`) takes a wave, the lanes a read derived, the tree to merge into and its base - a
wave owns no tree, so the caller names one - and hands the lanes' PINNED commits to `aggregateBranches`
(`lib/pipeline-aggregate.js:137`). That merge pre-flights every lane pairwise with `git merge-tree --write-tree`, so a
conflict is a value with the paths in it, and then builds ONE commit with `commit-tree`: the pre-flight's tree plus one
parent per lane. The result is verified by comparing the pre-flight tree with the commit's own tree, and a conflict is a
refusal that names the paths rather than a half-made merge.

The message is `aggregateMessage` (`lib/pipeline-fanout.js:210`) with the wave's id in the join slot, so a reader of
`git log` sees:

    stage wave_01: aggregate 2 stage branches (lib/left.js #1, lib/right.js #2) from base 4a1c0d2f9e77

Every lane is named, every member that contributed a branch is named with its lane, and the base is named. Forking the
builder to say "wave" instead of "stage" would have been a second sentence for one idea, so the wave keeps the
aggregate's noun.

**The pin is a commit AND a blob.** `readMemberPin` (`lib/wave-evidence.js:235`) reads a member's commit
(`commitOf`, `lib/stage-pin.js:59`) and, for every file it claims, the blob id that commit holds (`pinOf`,
`lib/stage-pin.js:85`). `readWaveLanePins` (`lib/wave-evidence.js:278`) reads one lane's pins and answers `ok: false`
with a sentence when a member that RAN names no tree. The join refuses a pin that answered `ok: false`: its commit may
resolve while the file it claimed does not, and merging it would land a lane whose content the panel could not name. A
member that never ran and names no tree owes the join nothing, because the design lets a wave close with a member still
queued for a follow-up.

## The fold gained exactly two clauses

`deriveWaveState` (`lib/waves.js:878`) keeps its order - empty, running, parked, exit gate, entry gate - and gains:

1. **A refused lane set is `blocked`,** read before the exit gate. That is a fact about the record (two lanes hold one
   tree), not the reader's blindness, so it is blocked rather than cannot tell.
2. **A wave of two or more lanes whose exit gate reads met but cannot name a lane is `unknown`.** The sentence is the
   lane's own ("#2 has run but names no tree, so lane lib/b.js cannot be pinned to what it produced"), followed by the
   reason it matters: a wave that holds lanes joins them in one commit, so it cannot close on a lane set it cannot name.

A wave of one lane takes neither clause. A wave whose exit gate is not met takes neither either: a lane the panel cannot
name only blocks a CLOSE, and a wave that is not closing is not made blind by a lane it will not join.

## The view and the payload

`waveView` (`lib/waves.js:986`) reads the lane set once and hands it to the fold, so the lanes drawn beside a state are
the lanes that state was folded from. The view carries `lanes`, `laneCount`, `laneImplicit`, `laneJoinOwed`,
`laneIsolation` (the fan-out's own `per-stage` word) and `laneRefused`. `routes/waves.js` needed no new code and no new
read: the lanes ride on the same `GET /api/waves`, and the route test measures it.

`public/core/waves-lane.js` draws lanes only when there are two or more (`lanesHtml`, line 93, and `laneRowHtml`, line
73). A lane carries its name, its folded state, the trees it names and the read that says whether it can be pinned; a
lane that cannot be read says why, and never reads as "no trees". A refused lane set is a `role="alert"` above the
lanes. A wave with one lane draws the markup it always drew, which a test asserts by matching the absence of
`wave-lanes` and the presence of the flat `data-wave-member` rows.

## Proof, as tests

`test/waves-lanes-join.test.js` (10 tests) builds REAL repositories for everything that is a git reading, because a
fixture that answers a pin without a commit proves nothing about a pin:

1. **Derived, never stored.** Two members on one file and one on its own are two lanes; a member's own `lane` wins; a
   wave nobody gave lanes holds one implicit lane and owes no join; a hand-written `lanes` list on disk is not read.
2. **Isolation, measured on disk.** Neither lane's tree carries the other's file, neither reports it as a change, and a
   write in one lane leaves the other's checkout byte-identical. Then one lane's pin fails (a claimed file its commit
   does not hold): the join refuses the set by name, the join tree is still at the base (no commit was made), and the
   lane that could be read is exactly where it was, with its file untouched.
3. **Exactly ONE commit, naming every lane.** The join reports `parents: 3`, `verified: true`, and the repository
   answers `rev-list --count --first-parent <base>..HEAD` = 1 and exactly one commit with two or more parents. Both
   lanes' files are in the joined tree with the content their lane committed, and the subject carries `lib/left.js #1`
   and `lib/right.js #2`.
4. **The pin and the squash.** The test measures the premise before it measures the fix: `merge-base --is-ancestor
   <recorded> HEAD` exits 1 after the squash, so the sha really was rewritten - and the pin's blob is still `origin`'s
   (here, main's) copy of the file. `pinCheck` passes on the pin and refuses a blob that is not the recorded one.
5. **A wave with no lanes is untouched.** `laneCount` 1, `laneImplicit` true, `laneJoinOwed` false, the fold's `done`
   sentence identical to the one it produced before this row, and nothing written onto the wave object.
6. **Cannot tell does not close.** A lane whose member ran and names no tree makes the wave `unknown` with the lane's
   sentence; naming the tree makes it `done`; a queued member with no tree owes nothing.
7. **A shared tree is refused.** Two lanes in one tree answer `blocked`, with both lane names and the tree.
8. **Every shape the join refuses** is refused with its own sentence: no wave, one lane, no tree, an unpinned member,
   a lane with nothing that ran, an aggregate that throws; and a conflict is reported with its paths, its code and NO
   record of a merge that did not happen.
9. **The payload survives JSON**, because the route's answer is JSON.
10. **The markup**, including the unchanged one-lane wave and the alert for a refused set.

`test/waves-route.test.js` (7) now stamps two lanes on the members themselves and pins that `GET /api/waves` carries
two lanes in two disjoint trees with `laneJoinOwed: true`, that the empty wave holds none, and that the existing
fail-closed case (an exit nobody can see reads unknown, never green) still holds.

The focused runs on this branch, all passing: `test/waves-lanes-join.test.js` 10, `test/waves-derive.test.js` 22,
`test/waves-lane.test.js` 17, `test/waves-store.test.js` 17, `test/wave-evidence.test.js` 13,
`test/queue-wave-id.test.js` 8, `test/pipeline-fanout.test.js` 12, `test/waves-route.test.js` 7 - 106 tests, 106
pass.

The full sweep, `npm test` (`node --test --test-concurrency=4` over 402 files, about 11 minutes): **3,491 tests, 3,481
pass, 10 fail.** None of the ten is in the wave, pipeline, pin or evidence machinery, and nine of them are pre-existing
at the base commit: the same ten files run at `f2dcdb81` answer 80 tests, 71 pass, 9 fail, with the same nine names
(`assistant-profile`'s `dock` field, `gateway-permissions`, `paths`, `paths-http`, `header-controls`,
`assistant-search-scroll`, `child-route`, `junctioned-node-modules`, `reasoning-runs`). The tenth,
`assistant-message-attachments`' "an image on the Director's turn reaches the assistant it messages" - a 28 s assertion
that a real worker was spawned - passes alone on this branch (5 tests, 5 pass) and passed at the base, so it is a load
flake under four concurrent files rather than a regression. The suite was run twice: the first run was still going when
it hit this project's 20-minute cap and was killed with nothing readable from its pipe, which is why the second run
writes its output to a file and its own measured duration is the one quoted above.

## What this row does not do

- **Nothing calls the join yet.** `joinWaveLanes` is a call with a tree, a base and a lane set; no route and no drive
  invokes it, because who advances a wave is row 195's subject. This row proves the join can be made and that a wave
  cannot close on a lane set it cannot name.
- **The fold does not read git.** The lane read is structural: which trees the members name. The pins are read live by
  the caller (`readWaveLanePins`) at the moment of a join, so a `done` wave promises that no lane is nameless - it does
  not promise the merge will succeed. A lane whose file moved after the fold still refuses the join, with its sentence.
- **No CSS module.** The lane block reuses the wave module's existing classes (`.wave-members`, `.chip wave-mstate`,
  `.as-hint`), so a lane renders as a chip, its read, and its member chips inside the existing wrapper. A column layout
  for lanes would be a `public/style.css` change and is not in this row.
- **No new gate name and no new parameter.** `EXIT_CHECKS` is still the closed 14.
