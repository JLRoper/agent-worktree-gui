# The chart under the assistant rail — 0.56.3

The reader's report: at a 1954px window with the assistant rail open, the ASSISTANT column and every column after it
were clipped exactly at the rail's left edge. The table kept its full width and painted under the dock instead of
reflowing.

Two defects made that, and both are fixed here.

**The owner cell carried the rail's class.** The cell was `<td class="assistant nowrap">`, and `public/style.css`'s rail
rule was `.assistant { position: sticky; flex: 0 0 auto; width: 480px; display: flex; flex-direction: column; … }`. Every
owner `<td>` inherited all of it — a 480px sticky flex column, the rail's left border and the rail's background, in the
middle of the chart. Measured on the sandbox: `assistantTh.w = 480`, `assistantTd.position = sticky`,
`display = flex`, `width = 480px`. The cell's class is now `owner` and the rail's rule is scoped to `#assistant`.

**Opening the rail was not a `resize`.** The rail is a flex item beside `main`, so opening it takes 340-640px from every
table — without a window resize, so `fitColumns` never re-ran. The column split stayed at the closed widths (sum 1839)
inside a 1359px wrapper; a `table-layout: fixed` table is never narrower than the sum of its columns, so it ran 480px
past the card and the card's `overflow: hidden` cut it at the rail's left edge, with no scrollbar to reach it. A
`ResizeObserver` on `main` now re-plans the split (coalesced on the same 140ms timer as a window resize), which also
covers the rail's drag.

The layout authority moved with it: `main` is the page's only horizontal scroll container, `.wt-scroll` no longer
scrolls or carries a floor `min-width`, `columnPlan` normalises the column widths to the card exactly, and the two
wrapper cards (`.project`, `.root-group`) no longer clip horizontally — their heads carry the top corners the clip used
to cut. Cells ellipsize (and headers with them) instead of being cut off.

The owner column is also compact now: `M1` for Manager 1, `M2` for the second Manager, `A1` for a row the server could
not label, with the assistant's name and role in the cell's tooltip. It hides itself while every row is on Assistant #1
and no second assistant exists — a column of identical tags — and comes back on its own for a reassigned tree or a
second assistant. The reader's switch still turns it off for good, and the Settings row says why a ticked switch can
draw nothing.

## The snapshots

All six are Chromium screenshots of `tools/verify-board-fit.mjs`'s own sandbox panel (its own repo, port, config and
`HERMES_HOME`), taken at the requested widths with the rail open and closed.

| file | what it shows |
| --- | --- |
| `1954-rail-closed.png` | 1954px, rail closed, second assistant on the board: 11 columns, table 1839 in wrapper 1839, `M1` tags |
| `1954-rail-open.png` | 1954px, rail open: the chart re-planned to 1359, every column — actions included — inside the card, a gap before the rail |
| `1954-rail-open-idle.png` | 1954px, rail open, one assistant: the owner column has hidden itself; ten columns |
| `1954-rail-dragged.png` | after dragging the rail 80px wider: table 1279 in wrapper 1279, still inside the card |
| `1280-rail-closed.png` | 1280px, rail closed: 11 columns, table 1165 |
| `1280-rail-open.png` | 1280px, rail open: the chart squeezed to 685px rather than clipped — headers and cells ellipsize, nothing crosses the card edge |

## What proves it

`node tools/verify-board-fit.mjs --shots <dir>` → **42 checks, 0 failed** (`BOARD-FIT-OK`). Every number below is read
from the DOM at that moment: table width vs wrapper width, the sum of the columns vs the table width, the table's right
edge vs its card's and main's, `main`'s `overflowX`/`scrollWidth`, the wrapper's `overflowX` and `is-scroll`, the
table's inline `min-width`, the drawn column ids, the owner tag and cell class — at 1954 and 1280, rail open and closed,
plus the drag.

- 1954, rail closed → open: chart 1839 → 1359px; columns `711,370,62,70,61,62,62,65,120,172,84` →
  `375,226,62,70,61,62,62,65,120,172,84`; table 1359 = wrapper 1359; `main` scroll 1474 of 1474.
- 1280, rail closed → open: chart 1165 → 685px; table 685 = wrapper 685; `main` scroll 800 of 800.
- Drag: 1359 → 1279px, table 1279 = wrapper 1279.
- `npm test`: 806 tests, 806 pass, 0 fail.
- `node tools/verify-chart-columns.mjs`: 44 checks, 0 failed (the owner column's self-hide, the `M1` tag, and the
  second assistant bringing it back).
- `node tools/verify-assistant-dock.mjs`: 45 checks, 0 failed (`ASSISTANT-DOCK-OK`).
