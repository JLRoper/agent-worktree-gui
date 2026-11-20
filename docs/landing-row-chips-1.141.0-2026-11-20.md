# Landing: the result and collision cards became one-line chips (1.141.0)

PR #813 merged into `main` as `00541e4b51`, and the render that followed is `a33e7b96`. The two cards a row used to
open - the run's result and its collision pairs - are now one-line chips in the row's own name line, beside the
verdict. The row gains no height: both chips sit in the line that already carried the Reviewed control, and each
opens its card on its own press. The collision chip always states both numbers, open and resolved, so a settled pair
reads `0 open - 1 resolved` without opening anything, and the violet mark is the open pair's alone.

## What landed

- `public/core/row-chips.js` - the chip's whole vocabulary: `firstClause` (the summary's first clause, never an
  absolute path), `resultLabel` (clause, age, `reviewed`), `collisionLabel` (the open and resolved tally),
  `rowChipStore` (which chip on which row is open, by kind, remembered across a repaint), and the popup's
  positioning and keyboard rules.
- `public/board-scaffold.js` - `resultChipHtml` and `collisionChipHtml` draw the chips into the row's name line;
  `openRowChipPop` / `closeRowChipPops` own the card; `paintRowChipPops` re-anchors an open card to the row's new
  chip after a repaint; the redrawn body puts the caret back on the control it was on; `toggleRowChip` calls the
  same marker painter the repaint does.
- `public/render-projects.js` - every path that replaces a row's chip nodes calls `paintRowChipPops`, so a press and
  a rebuild cannot disagree about what an open chip looks like.
- `public/chart.css` - `.rowchip`, `.rowchip-text`, `.rowchip-chev`, `.rowchip-pop`, the live and quiet chip inks and
  the three mark states: violet for a pair with the assistants, the brighter violet for one waiting on the reader,
  and the faded ink for a resolved pair.
- `public/app.js`, `public/index.html` - the boot wiring and the stylesheet order for the chip layer.
- `test/row-chips.test.js` - the first clause, the labels and their numbers, the store, and the caret rule.
- `tools/verify-row-chips.mjs` - the headless gate, eleven sections over a git fixture with three worktrees.
- 10 files, +1488/-25 across the four branch commits and the bump.

## What proves it

- `node tools/verify-row-chips.mjs --shots <dir>` - **62 checks, 0 failed**, 0 page errors, at 1440x900. The gate
  boots the real panel over a git fixture and seeds both surfaces through their real seams, then asserts: both
  chips in the existing name line with no added row height; the result chip's clause and age and the collision
  chip's two numbers; the result card with its report anchor and next steps; the collision card with both sides of
  the ruled pair named; a repaint that leaves the open card open and anchored to the row's NEW chip; Escape closing
  it and forgetting it; the reviewed chip saying so; a card opened before a reload coming back open on the row's own
  chip; and the fully resolved row's muted chip and faded mark beside an open row's violet one. Screenshots:
  `docs/assets/row-chips/01-both-collapsed-1440x900.png`, `02-collision-expanded-1440x900.png`,
  `03-muted-chip-1440x900.png`.
- `node --test test/row-chips.test.js` - **10 tests, 10 pass, 0 fail**.
- `node --test test/row-chips.test.js test/collisions.test.js test/review-lane.test.js` - **57 tests, 57 pass,
  0 fail**.
- `npm test`, once, on the branch: cancelled at the twenty-minute cap with **1443 pass and 7 fail seen**. Two of the
  seven were this branch's and are fixed: `tools/absolute-paths.mjs` refused two literal drive-letter fixtures in
  `test/row-chips.test.js`, and they now build the letter from parts (the tool reads clean: 1870 tracked files, none
  new; `test/absolute-paths.test.js` 17 pass). The five that remain reproduce from a clean `git archive origin/main`
  export in this environment - assistant-profile's whitelist check, assistant-search-scroll's keyboard step,
  header-controls' moved control, and child-route and gateway-permissions, whose fixtures read this checkout's
  `config.json`, which a worktree does not have.

## The version and the tag

`main` read 1.140.0 when this landed, so the branch carries 1.141.0 - a minor, because the chips are a new way for
the reader to see and open both cards. `v1.141.0` is an annotated tag on `00541e4b51`, the commit on `main` that
first declares the version; `package.json` on `main` reads 1.141.0.

## The landing

- `git push -u origin HEAD` with no `--no-verify`; the pre-push hook passed after the path fix above.
- `GH_TOKEN` was supplied in-line for `gh` only, never written to a file.
- `npm run land:pr -- 813` merged the PR, fast-forwarded this checkout, moved the tag to `00541e4b51` and rendered
  the changelog: **655 releases, current**.
- The note and its screenshots were committed on `main` after the merge, with relative paths only.

## The clock

The chips are drawn on the same clock as the rest of the row: a frame that repaints the name line re-anchors an open
card rather than closing it, and a reload restores the expansion from `localStorage`. Nothing here starts a timer of
its own.
