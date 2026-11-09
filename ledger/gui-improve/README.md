# gui-improve — the task pipeline window's current-stage block

Row #260, gui-improve, stage 1 `baseline` live. The block that names the stage, the visit, the clock and the
artifact drew the visit line and the clock sentence **over each other**:

```
visin this stage 41m49s since 11/9/2026, 1:30:25 AM
1
.
gui-
improve/baseline#1
```

`visit 1 · gui-improve/baseline#1` is a grid child the row's placement rule never named
(`public/style.css`: `.pipew-phase, .pipew-live, .pipew-artifact, .pipew-gate { grid-column: 2 / -1 }`). The
auto-placement cursor therefore drops it into the row's **18 px ordinal column**, where it is 18 px wide and
paints outside its own box: the first three letters read over the elapsed line (`vis` + `in this stage` →
"visin this stage") and the remainder wraps one fragment per line. The decision line had the same omission.

## The change

```diff
-.pipew-phase, .pipew-live, .pipew-artifact, .pipew-gate { grid-column: 2 / -1; font-size: 10px; color: var(--dim); }
+.pipew-phase, .pipew-live, .pipew-visit, .pipew-decision, .pipew-artifact, .pipew-gate { grid-column: 2 / -1; font-size: 10px; color: var(--dim); }
```

One rule in the popup's own stylesheet; no render code was touched (`public/assistant.js` is unchanged — a live run
was working in it). `test/task-pipeline-window-ui.test.js` gains a test that reads the row the renderer actually
emits and fails on the **base** stylesheet with "a child the grid rule does not name is auto-placed into the ordinal
column". `grid-column` is the whole fix; the visit line also stops inheriting `.mono`'s 12 px (the shared rule names
it), so it now reads at the block's 10 px, in line with the artifact line beside it.

## What is here

| path | what it is |
| --- | --- |
| `baseline/capture.json` | `capture/1` — 4 viewports × 1 state, shot hashes, per-line boxes, DOM inventory, the surface's CSS rules, the served-file proof (`matchesTree`) |
| `baseline/verdict.json` | G1: `recorded` (1 interleaved line on every viewport — the defect, measured) |
| `compare/capture.json` | the SAME protocol re-shot after the change |
| `compare/comparison.json` | `comparison/1` — pairs, pixel diffs, DOM diff, CSS diff, tests, verdict |
| `compare/comparison.html` | the page to open: the block at 2×, the window, the diff and the line tables, per viewport |
| `compare/verdict.json` | `improved` |

## The measurement

Same fixture on both sides (row #260's record: `gui-improve`, stage `baseline`, visit 1, stage run
`gui-improve/baseline#1`, entered `2026-11-09T05:49:19Z` — the stamp the defect report quotes). Viewports
`1440x900`, `1280x900`, `1024x900`, `1600x900`: height held so the width is the only variable. The popup is a
`min(780px, 100%)` card, so its own width is 780 at all four — the block is measured inside it.

| viewport | children on the visit's line, before | after | visit paints outside its box, before → after | card height |
| --- | --- | --- | --- | --- |
| 1440x900 | `pipew-visit` + `pipew-live` | visit alone | yes → no | 693.72 → 639.2 |
| 1280x900 | `pipew-visit` + `pipew-live` | visit alone | yes → no | 693.72 → 639.2 |
| 1024x900 | `pipew-visit` + `pipew-live` | visit alone | yes → no | 693.72 → 639.2 |
| 1600x900 | `pipew-visit` + `pipew-live` | visit alone | yes → no | 693.72 → 639.2 |

The block loses 54.52 px because the visit line stops wrapping into four painted lines. Guards: 0 elements
added/removed, no control's role or name changed, the only text that differs is the live elapsed number, the block
and the window body do not overflow, `test/task-pipeline-window-ui.test.js` 19/19 and
`tools/verify-task-pipeline-window.mjs` 66/66.

## Reproduce

The capture and compare scripts live outside the tree (a scratch path, not committed); both drive a throwaway panel
of this checkout through `tools/panel-testkit.mjs`, open row #260's window from the assistant rail's Queue pane and
shoot `#pipew-card`. `capture.json`'s `surface.steps` is the exact step list; the served `style.css`/`assistant.js`
hashes in `environment.servedFiles` prove the shots are of this checkout (`matchesTree: true`).
