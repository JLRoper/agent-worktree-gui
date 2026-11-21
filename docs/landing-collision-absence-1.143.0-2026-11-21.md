# Landing: a collision whose counterpart answers to nothing (1.143.0)

A worker can write a COLLISION line naming a tree the board does not have: a tree cut by hand, a name typed wrong, a
row the reader archived while the run kept going. The note was still filed, and because no row answered to the target
there was no other assistant to put it to, so the panel handed it straight to the reader. That hand-over was the defect:
it put a count on the Human button and an H stop on a card whose only sentence was "no row matches", for a pair with no
second side and no order any person could choose. The reader was being asked for a ruling that does not exist.

The verdict is now the panel's, and it is recorded rather than asked.

## The state

`lib/collisions.js` carries five states now, `COLLISION_STATES` at line 90:

| state | what it is | counts on the Human button |
| --- | --- | --- |
| `assistants` | the panel's own rows in both queues, waiting on the pass | no |
| `reader` | a pair whose order is the reader's | **yes** |
| `ruled` | an order is stored against the pair | no |
| `superseded` | a landing carried one side into main after the report | no |
| `absent` | a note whose target names no row and no live agent | no |

`stateOf` (line 568) reads `superseded` first, then `ruling`, then `absent`, then `readerAt`. A verdict is checked
before the hand-over because the two are one answer: a record is either a question for the reader or settled without
one. `countStates` (line 1383) counts `absent` with the rest, and `routes/collisions.js` serves it on `GET
/api/collisions` beside the four it already served. `count` is unchanged and still counts `reader` only, which is what
the badge is drawn from.

## Who decides, and on what evidence

The question "is anything there?" is answered by two lists, never by one:

- **the queue rows**, which is how a note naming another tree becomes a pair (`resolveCounterpart`, unchanged);
- **the trees a live run is standing in**, from the job store itself. `lib/jobs.js` line 3604 adds
  `liveAgentTrees({ exceptId })`, built on the same `isLiveJobStatus` and `jobTreePath` the spawner refuses a second
  cut with, so "a live agent stands in that tree" has one meaning in one place. `harvestCollisions` reads it once per
  message (line 3659) and passes it to `recordNote`.

`recordNote` (line 936 onward) settles the note only when the caller actually looked (an ARRAY of live agents) and the
target matched none of them (`targetNamesLiveAgent`, line 541, which matches the path, the path suffix, the branch and
the directory slug, the same spellings `resolveCounterpart` reads). Then it stores `absent` with the words the worker
wrote and the answer the board gave, and leaves `readerAt` null.

A caller that could not read its store passes `null`, not `[]`, and settles nothing: "I did not look" and "there was
nobody there" are different answers, and only the second one closes a report.

A target that names a LIVE agent's tree keeps the reader hand-over it always had. That is the one case where a person
still sees something the board does not: the tree exists, a run is in it, and the scanner has not written its row yet.

## What the reader meets

- the Human badge does not count it, and H never steps into it (`lib/collisions.js` `canAsk` and `stateOf`; the
  rotation in `public/core/review-lane.js` only takes `state === "reader"`);
- the row chip counts it resolved, so the row is not painted as a live alarm (`public/core/row-chips.js`
  `pairResolved`);
- the marker is quiet violet, `is-absent` (`public/style.css`), and its title says "resolved by absence - no row on
  this board and no live agent answers to it" (`public/core/review-lane.js`);
- the card prints the verdict as the answer it is: "resolved by absence: no row on this board and no live agent answers
  to <name> - settled, nothing to rule on", the peer line saying there is no second side, the worker's own sentence,
  and a verdict line with the reason, the age and "not waiting on you". There is no ruling press and no "bring it to
  me" press on it (`public/board-scaffold.js` `collisionBlockHtml`).

## An old board stops asking too

Before this change the same case was written as `readerAt` set at the moment of filing, with a resolution of `none`.
`oldAbsence` (`lib/collisions.js` line 733) reads that shape back as a verdict on load and folds the old hand-over into
it, so a board that already carries one of these stops asking without anybody editing `logs/collisions.json`. The
upgrade is deliberately narrow: a note escalated LATER (a live agent was named, or the reader pressed "bring it to me")
has a `readerAt` after its `reportedAt` and is left exactly as it was.

## Evidence

- `test/collision-card.test.js`, three cases under "the absence verdict":
  - a note naming nothing alive is `absent`, `waiting: false`, `canRule: false`, `canAsk: false`, no item in
    `wtReviewLane.collisions([row])`, `wtRowChips.tally` `{open: 0, resolved: 1}`, and a pair on the same book still
    counts open;
  - a target that names a live agent's tree is still the reader's, a caller that passed `null` settles nothing, the
    matching reads path, suffix, branch and slug, and a re-report against a live agent reopens the note;
  - a record in the old shape reads back `absent` (`upgraded: true`, `readerAt` folded away), a note escalated later
    stays `reader`, and the verdict survives a save and a reload.
- `npm run verify:collision-absence` (`tools/verify-collision-absence.mjs`), a real panel against a real git fixture:
  one pair the reader can rule on plus one absent note. 27/27: the record is `absent` on the endpoint, the states list
  names it, `count` is 1 and `counts.absent` is 1, the card carries the verdict with 0 ruling presses and 0 ask
  presses while the pair's card carries 2, the badge reads "1" and the title "1 collision", the rotation holds one
  collision item and it is not the absent one, and a pass later the record is still `absent` and the badge still reads
  "1".
- `node --test test/collision-card.test.js test/collisions.test.js test/collision-settle.test.js test/review-lane.test.js
  test/row-chips.test.js`: 82 pass, 0 fail.

## A gate defect this run found, and did not fix

`tools/verify-collisions.mjs` fails at its ruling press on this host, and it fails the same way against a `git archive`
of `origin/main` with none of this branch's code in it: after the harness calls `renderAll()`, the collision popup is
gone (`[data-collision-block]` count 0), so the press it looks for is not in the document. The panel's own behaviour -
a card opened by H is a popup the store says is open, and a repaint is supposed to re-anchor it
(`paintRowChipPops`) - is where the cause is, not in this landing. It is a separate defect with its own risk and is
reported rather than folded in here.

`tools/browser.mjs` was changed for this run's evidence only: when the host has the full chromium build and not the
`chrome-headless-shell` binary Playwright prefers, the launch falls back once to `channel: "chromium"` and says so,
instead of failing every gate on the machine with "Executable doesn't exist". It is a harness fix, not panel behaviour.
