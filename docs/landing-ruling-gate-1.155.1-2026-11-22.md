# Landing: the collision ruling gate re-opens the card a press closed (1.155.1)

`tools/verify-collisions.mjs` failed its ruling press, and had failed it on `origin/main` as well: 23 of 25 checks,
with the card's ruling control gone by the time the step looked for it. The follow-up row named the cause as the
repaint removing the card while the chip store still said it was open. That is not what happens. Measured on the tip
this note lands, the remover is the gate's own press.

## What the gate does, in order

1. H steps into the pair and the card opens: `setRowChipOpen("collision", key, true)` and `openRowChipPop` at
   `public/app.js:14084-14090`, the store written at `14087` and the popup created at `14089`
   (`public/board-scaffold.js:2492` and `2643`), the ruling press taking the caret.
2. The screenshot block then presses the other row open: `hotOpenPath` clicks `tr.row` for a row that is not
   expanded yet (`tools/verify-collisions.mjs:343-348`).
3. That press is outside the open card, and a press outside the open card is the reader leaving it
   (`public/board-scaffold.js:2838-2846`): every popup is closed and `setRowChipOpen(..., false)` forgets it in
   `wm.openRowChips` (`2843`).
4. The ruling step then queries `[data-collision-rule=...]` and finds nothing, because the card, the control and the
   store entry all went with that press.

## The measurement, on the branch

One fixture, one panel, one browser, reading the popup, its anchor and `wm.openRowChips` after each step:

| step | popups | anchor connected | store entries | ruling presses |
| --- | --- | --- | --- | --- |
| after H | 1 | yes | 1 | 2 |
| after `renderAll()` | 1 | yes | 1 | 2 |
| after `placeRow()` (a scan's per-row paint) | 1 | yes | 1 | 2 |
| after a press on the other row | 0 | - | 0 | 0 |

The repaint paths keep an open card because `paintRowChipPops` is called on both of them, not only from a function
nobody calls: `public/render-projects.js:414` (inside `refreshChips`, which every row paint ends with) and
`public/render-projects.js:1818` (the end of `renderProjectRows`). `paintRowChipPops`
(`public/board-scaffold.js:2774`, its contract at `2459-2461`) re-anchors the popup onto the row's new chip and
repaints its body only when the record moved. A card whose anchor leaves the page for good is removed by the
scroll/resize re-measure (`public/board-scaffold.js:2881-2893`), and the store is only ever cleared by a close - the
outside press, Escape, the close button, or that re-measure.

## The change

In `tools/verify-collisions.mjs`:

- the card H opened is read off the DOM as its chip key (`line 340`), so the section can talk about the same card
  rather than any card;
- the close the screenshot step causes is PINNED as the measured behaviour (`lines 361-363`), and the card is then
  re-opened by the reader's own press on the row's collision chip (`lines 364-370`) before the ruling runs. The ruling
  section is about the press writing to the pair; it no longer depends on a card surviving a press somewhere else;
- the closing "no console error" check gains the failed-request list its sibling
  `tools/verify-collision-absence.mjs` already uses (`line 256`, asserted at `429`). A failed load's console text
  carries no URL, so the favicon 404 a fresh browser profile always makes was the one entry the old filter could never
  drop.

Nothing in the panel changed. The card survives the repaints, the outside press closes it by design, and the gate now
proves both instead of tripping over the second.

## The run

On the rebased tip, `node tools/verify-collisions.mjs` reads 41 of 41 checks, exit 0 (it read 23 of 25, exit 1, on
`origin/main`). The sibling absence gate, `node tools/verify-collision-absence.mjs`, reads 27 of 27, exit 0.

The full suite was NOT swept on this tip. The earlier reading, taken on `c2bd55f0`, named five pre-existing failures
(`test/gateway-permissions.test.js` reading an untracked `config.json`, and one assertion each in
`test/assistant-profile.test.js`, `test/assistant-search-scroll.test.js`, `test/child-route.test.js` and
`test/header-controls.test.js`); the base has moved twelve releases since, so those counts are not re-quoted as
current. The collision and row-chip test files, which are the ones this change can reach, were run on the tip.

## The version and the base

1.155.1, a patch: a gate and its check, no panel behaviour. The branch was cut from `158d0f69`; `origin/main` was at
`1d202ffc` (1.155.0) when this was rebased onto it, and the branch's earlier round (the absence verdict, its UI and
its test) had already landed as `d069636e` (#817), which the rebase dropped as content already upstream.

`1d202ffc` carries a drive-letter cwd in `test/hermes-activity-worker-multi.test.js`, and `tools/absolute-paths.mjs`
reads the TREE of every commit a push sends, so that one fixture refused every push from the base, this branch's
included. Nothing in the worker keys on the shape of the path, so the fixture now holds a repo-relative placeholder
and the gate reads clean; that repair is the branch's base-most commit, kept out of the fix's own commit so the diff
still reads as the gate and its note.
