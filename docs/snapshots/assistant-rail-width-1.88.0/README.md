# The assistant rail opens to half the window - 1.88.0

The reader's report: the docked assistant rail stopped at 640px, and on a narrow window the board beside it was the
part that paid for it. On a 1600px window 640px is 40% of the row, so the reader on the wider screen was the one who
could not give the transcript half of it. On a 900px window the rail's old 60% cap drew it 540px wide and left the
board 360px, with the chart's table 280px inside a 245px wrapper, cut at the rail's left edge.

Both of those are the same clamp, and it now reads the window rather than a pixel number.

## What changed

**The cap was a pixel number.** `public/assistant.js` carried `const DOCK_MAX = 640;` beside `const DOCK_SHARE = 0.6;`,
and the one authority for the width was:

```js
const cap = Math.min(DOCK_MAX, Math.floor((vw / (z || 1)) * DOCK_SHARE));
```

640 is half of a 1280px window and 40% of a 1600px one, so the rail's ceiling moved with the monitor instead of with
the window. `clampDockWidth` now reads:

```js
const cap = Math.max(DOCK_HARD_MIN, Math.min(Math.floor(layout * DOCK_SHARE), layout - BOARD_MIN));
```

with `DOCK_SHARE = 0.5`, `BOARD_MIN = 420` and `DOCK_HARD_MIN = 240`. Half the window is the cap. The board's own
420px floor is the second stop, so the two meet at an 840px window and below it the board keeps its 420 while the rail
takes what is left. `DOCK_HARD_MIN` is the one bound that beats the board's floor, because a rail narrower than that
is not a rail. The 340px floor is unchanged, and the width is still stored in the layout px the cap is measured in,
so a zoomed page cannot hand the rail more of the window than it would at 100%.

**The board had no floor.** It has one now, and it is the reason the cap is a pair of bounds rather than a share: the
rail cannot take width the board needs. At 900px the rail's cap is 450 (half) because 900 - 420 is 480, so the board
keeps 450; at 800px the cap is 380 and the board keeps 420.

**The grab handle and the record were already right.** `#as-split` is the 6px band on the rail's left edge
(`cursor: ew-resize`), `attachSplit` drives it, `paintDock` writes the width, and the number is remembered with
`writeFlag(DOCK_KEY, ...)` under `wm.assistantWidth`, beside `wm.assistantOpen` and `wtgui.zoom`. The gesture and the
record are untouched; what moved is the band they clamp to, and the tooltip that described it. The title said
"340-640 px, at most 60% of the window" in `public/index.html` and again in `applyFrame`; both now say "340 px minimum,
half the window at most".

## What it measures

Same sandbox, same six-worktree board, same fixture in every row; base is `471ce9cb` (`origin/main` at the cut).

| state | base `471ce9cb` | this build |
| --- | --- | --- |
| 900px window, remembered 900 | rail 540, main 360, table 280 in a 245 wrapper | rail 450, main 450, table 341 in a 335 wrapper |
| 900px window, remembered 200 | rail 340, main 560 | rail 340, main 560 |
| 1600px window, drag 520px left from 480 | rail 640 (the old cap), main 960 | rail 800 (half the window), main 800, table 685 in a 685 wrapper |
| 1600px window, remembered 900 | rail 640, main 960 | rail 800, main 800 |
| 1600px window, reload after that drag | 640 came back | 800 came back |

`main`'s right edge and the rail's left edge are the same number in every row: the rail is drawn beside the board,
never over it.

| image | what it shows |
| --- | --- |
| `before-narrow-900.png` | base build, 900px window: the rail takes 540 and the board 360, its chart cut at the rail's edge |
| `after-narrow-900.png` | this build, 900px window: the rail takes 450 and the board 450, both floors holding |
| `after-dragged-1600.png` | this build, 1600px window after dragging the edge 520px: the rail stopped at 800, half the window, with the board's 685px chart beside it |

## What proves it

- `node --test test/e2e/assistant-rail-width.spec.mjs` → 4 tests, 4 pass, 0 fail. Each of the four failed on the base
  build first: the drag stopped at 640 where the test wants 760, the cap read 640 where it wants half of 1600, the
  900px window drew the rail at 540 with the board at 360 (under its 420 floor), and the reload came back at 640
  instead of the dragged 760.
- `node tools/verify-assistant-dock.mjs` → 47 checks, 1 failed, and the failure is the same one the base build has:
  "the rail's own row: the session and the panel's two panes, with the four lists inside the session now" expects
  three panes and the build draws four (`assistant-1`, `role`, `watchdog`, `bridge`). Everything in the width band
  passes, including a 1600px window opening past the old 640px ceiling and a 900px window capped at 450 with a 420px
  board.
- `node tools/verify-board-fit.mjs` → 42 checks, 0 failed: the chart still fits the card it is given at 1954 and 1280,
  rail open, and after an 80px drag.
- `test/assistant-dock.test.js` pins the band read out of the source: the 340 floor, the half-window cap, the 420 board
  floor and the 240 hard floor, at 1600, 1247, 900, 840, 800, 700, 600 and 400, and at 1.3 zoom.
- `npm run test:changed` was run three times and never finished on this host, which was carrying three other agents'
  suites at once: the runs stalled at 1152, 648 and 128 results, and no failure appeared in any file this diff
  touches. Each of the nine failures that did appear was separated against a `git archive` export of the cut base:
  `test/paths.test.js`, `test/board-lookups.test.js`, `test/assistant-profile.test.js` and
  `test/header-controls.test.js` fail identically there, and `test/assistant-attachment-spawn.test.js` is
  worker-spawn flakiness that passes and fails different tests run to run.

The console, the composer and the worktree row rendering are untouched: no file under `public/` other than
`assistant.js`, `index.html` and `style.css`, and in those only the clamp, its constants, the two tooltip strings and
the comment above the rule.
