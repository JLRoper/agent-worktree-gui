# gui-improve after — Settings → General, the applied change

Stage 2 of `gui-improve` (visit 1, implement). This is the verification capture of
`ledger/gui-improve/change-set.patch` applied in this tree — same protocol, viewports, states and
asserts as `../baseline/`, run by a copy of the baseline's own `capture.mjs` against a second instance
of this checkout (`PANEL_BASE=http://127.0.0.1:7391/`, its own `PANEL_CONFIG`), so nothing here was
measured against the live panel.

Served `public/style.css` sha256 `53e11ef9…7f94d`, byte-identical to the tree
(`environment.servedFiles["public/style.css"].matchesTree: true`); `public/app.js` and
`public/index.html` still hash the baseline's values, because the change is CSS only.

`incomplete: []`; every one of the 3 viewports × 2 states has both shots and both inventories.

## What moved, measured the same way the baseline measured it (1440x900, `open`; same at every viewport)

| metric | baseline | after |
|---|---|---|
| pills: Scan workers | widths 23.78 ×4 — spread **0** | widths 73.00 ×4 — spread **0** |
| pills: Row refresh | 35.33, 41.09, 41.09, 46.88 — spread **11.55** | 73.00 ×4 — spread **0** |
| pills: Turn briefing budget | 35.33, 29.55, 35.33, 35.33 — spread **5.78** | 73.00 ×4 — spread **0** |
| gap above / below a strip | 8 / 0 | 2 / 6 (last strip 2 / 10) |
| last strip vs the body's visible bottom | 598.28 vs 593 — clipped 5.28 px | 592.28 vs 593 — inside |
| General panel content | 453.06 | 447.06 |
| body / panel scroll height | 471 / 453 | 465 / 447 |
| `search` panel content | 133 | 126.63, one row and its strip only |

The compare stage owns the final after set and the comparison page; it may overwrite this directory.
