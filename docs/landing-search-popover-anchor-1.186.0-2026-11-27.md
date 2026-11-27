# Landing: the search popover opens under its box, and the reader can move it (1.186.0)

The reader's report: the transcript search popover opens at the pane's left edge, roughly 700px away from the search
box, and it should be moveable and resizable with a reset on reopen. The code agreed with the report: the shared
popover module aligned its RIGHT edge with the whole `.as-search` span, not the input, and a popover wider than the
box grows leftwards. On the turn search that put a 250px list 140px left of a 55.6px input; on the Hot Agent bar it
put a 330px list 296px left of a 34px opener button.

This cut changes the anchor, adds the reader's controls and clears them on every close. The report with the
screenshots inline is `docs/reports/search-popover-anchor-2026-11-27.html`.

## Rule 1: the box's own left edge, and the list grows rightwards

`placeGeometry` (`public/core/search-popover.js:88`) now takes the box's rectangle and answers `left = box.left`
(clamped inside the window), `top = round(box.bottom + 6)`, and a width from the box's own width. A tight window
SQUEEZES the list down to 160px rather than sliding it back under the pane; the assistant's bar leaves 248.5px when
its count is showing, and the measured width at the input's left edge is 248.5px.

The turn search passes `anchor: input` (`public/assistant.js:708`). The Hot Agent bar passes its opener button
(`:1392`) because its input lives INSIDE the popover: the rule lands the popover's left edge at the button's left
edge, and the popover's own head box 6px inside that span.

## Rule 2: a drag strip, a grip and a close x, drawn once for both bars

The module grows the chrome itself (`ensureChrome`, `search-popover.js:184`): a sticky 14px drag strip across the
top with the close x at its right, and a 16x16 bottom-right grip whose visual is a `::after` triangle so the whole
box is the drag target. The skin is one new scoped section at `public/style.css:7715`, every selector under
`.as-search-pop` or `.ha-search-pop`.

- A move keeps the list's natural height under its cap; a grip drag keeps the top-left and sets an explicit height.
  The floors are 250px wide and 120px tall, the ceiling is the window (`dragGeometry`, `:114`; `applyMoved`, `:227`).
- The x calls the bar's own close: `escapeSearch` for the turn search (clear the filter, caret back in the box) and
  `hotEscape` for the Hot Agent bar (clear, focus back on the opener).
- The strip's mousedown is preventative, so the caret stays in the box and the arrow walk, the count and the
  scroller follow keep working while the popover is somewhere else.

## Rule 3: every close forgets the rectangle

`hide()` (`search-popover.js:340`) and `resetPlacement()` (`:326`) clear the moved rectangle and the explicit size.
Escape, the x, an outside press and a row press all pass through `hide()`, so a reopen draws the anchored default
again. The turn search's scope chip calls `resetPlacement()` (`public/assistant.js:1337`) so a new scope is drawn at
the default while the list stays open.

## Measurements, same probe on both trees (1760 x 1000)

| bar | box left | popover left BEFORE | off the box | popover left AFTER |
|---|---:|---:|---:|---:|
| turn search `#as-search-q` | 1503.5 | 1363.5 | 140.0 left | 1503.5 |
| Hot Agent `#ha-search-open` | 1035.2 | 739.2 | 296.0 left | 1035.2 |

The before column is the turnover tip `609dfff7` exported with `git archive` and driven by the same probe; the after
column is this tree. The gate's own anchored read is `pop.top 122` against `input.bottom 115.7 + 6` and
`pop.left 1497.6` against `input.left 1497.6`.

## The gate

`node tools/verify-search-popover.mjs` (package script `verify:search-popover`), 52 checks, 7 screenshots:

```
52/52 checks passed  (7 screenshots in docs/assets/search-popover)
```

What it asserts, in one line each: the top edge is the box's bottom within 1.5px and the left edge is the input's
own; a drag moves it by the pointer's travel and a new answer keeps the moved rectangle; a grip drag resizes it and
stops at 250 x 120; Escape, the x and an outside press each close it, and every reopen is 1497.6 / 122 / 250 / 420;
a scope change resets it to the same four numbers while the list stays open; the Hot Agent bar repeats all of that
under its opener, 1035.2 / 82 / 330 / 420 after every reopen, with six presses stepping the moved and shortened list
to row 7 of 20 and the scroller following. The seven screenshots and every measured rectangle are under
`docs/assets/search-popover/` (`run.json`).

## Tests

`test/search-popover.test.js` is the module's unit file: 19 tests, all passing, including the new left-anchored
arithmetic, the drag and grip arithmetic (floor and ceiling), the chrome's three controls, and `hide()` clearing a
resized height before the reopen. The search's own suite - `assistant-search*`, `hot-agent-search`, `turn-search`,
`absolute-paths` - is 132 tests, 131 passing. The one red is `test/harness.test.js` naming
`tools/verify-queue-agents.mjs` (LIVE GATE with no package script), which arrives with `3bd8a0c6` on the turnover
base and is not touched here.

## The style.css overlap

The live `#373` work also edits `public/style.css`. The reader allowed the overlap, and this cut keeps its rules in
one new section at the end (`:7715`); it does not edit any existing rule, so a landing rebase has to move only this
block.

## Landing shape

The work rolls up into `20261127_1422_TASK-371_build-the-initiative-tag` locally, with no remote branch and no pull
request - the LANDING block's own rule, and the one that decides the push here.
