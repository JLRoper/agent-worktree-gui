# gui-improve compare — Settings → General

Stage 3 of `gui-improve` (visit 1). This is the after set re-shot for the compare stage, the diff of every pair
against `../baseline/`, and the verdict.

**Verdict: improved.** The preset strips now hug their own field (gap above/below 8/0 → 2/6, 2/10 on the last
strip), every pill in a strip is the same width (73.00 px each, spread 0.00 in all three strips at all three
viewports, where Row refresh was 11.55 apart and Turn briefing budget 5.78), the last strip is no longer clipped
(592.28 inside the 593 px body where it was 598.28), and the change is confined to those strips: 0 control
role/name/text changes, 0 elements added or removed, :root variables untouched, the surface's own tests 24 pass /
0 fail / exit 0.

The artifact is `comparison.json` (`comparison/1`); `comparison.html` is the same comparison as a page with
before, after and diff for every pair.

## The surface and the change

`Settings → General` — the `#settings-panel-general` tab of the Settings window (`#settings`). The change is
`../change-set.patch`, applied in this tree at `c065c4f` (two rules in `public/style.css`, scoped to
`#settings-panel-general`; no markup change, app.js unchanged).

## Protocol — the baseline's, unchanged

Same three viewports (`1440x900`, `1280x800`, `1024x768`), same two states (`open`, `search` with the filter
`budget`), same steps and asserts; `capture.mjs` here is the baseline's script with only its output paths and
stage name changed. A fresh browser context per viewport (no localStorage), Playwright Chromium 156.0.8078.4,
deviceScaleFactor 1, scrolled to 0, two animation frames.

The after set was shot against a throwaway second instance of THIS checkout (`tools/panel-testkit.mjs`,
port 7393, own `PANEL_CONFIG` and store, no projects, assistant/gateway off). It served `public/style.css`
sha256 `53e11ef9…7f94d` and `public/app.js` `b9c1e132…3724ab`, both byte-identical to the tree; the served
`index.html` differs only by the panel's cache-busting stamp. The live panel on 7331 (a different build,
1.70.1) was not touched.

The sandbox has no board behind the window, so the full-page shots are not pixel-comparable with the baseline's
(which captured a live, 15,000 px board). The 340×520 Settings window is: its shot is the pair, and the page
also diffs the same window region cut out of each full-page shot using each shot's recorded `win` rect.

## How to reproduce

```
PLAYWRIGHT_BROWSERS_PATH=C:/Users/roper/AppData/Local/ms-playwright NODE_PATH=C:/Users/roper/AppData/Roaming/npm/node_modules node ledger/gui-improve/compare/run.mjs
```

`run.mjs` boots the sandbox, runs `capture.mjs` into `after/`, then runs `diff.mjs`, which writes
`comparison.json`, `comparison.html`, `verdict.json`, `diff/*.png` and `tests.log`. Only `ledger/` and the
scratch dir are written.

## What moved

Metrics at `1440x900`, `open`; identical at `1280x800` and `1024x768` (the numbers below are read from the
inventories, not copied from the implement stage):

| metric | baseline | after |
|---|---|---|
| Scan workers pills | 23.78 ×4 — spread **0** | 73.00 ×4 — spread **0** |
| Row refresh pills | 35.33 / 41.09 / 41.09 / 46.88 — spread **11.55** | 73.00 ×4 — spread **0** |
| Turn briefing budget pills | 35.33 / 29.55 / 35.33 / 35.33 — spread **5.78** | 73.00 ×4 — spread **0** |
| strip gap above / below | 8 / 0 (last strip 8 / 10) | 2 / 6 (last strip 2 / 10) |
| last strip bottom vs body bottom | 598.28 vs 593 — **clipped 5.28** | 592.28 vs 593 — inside |
| General panel content | 453.06 | 447.06 |
| body / panel scroll height | 471 / 453 | 465 / 447 |
| `search` panel content | 132.63 (scroll 133) | 126.63 (scroll 127) |

Nothing above the strips moved: the four row labels sit at the same y (222 / 430.75 / 486.59 / 542.44) with
the same control right edges (1409 / 1270.81 / 1263.38 / 1312.88).

## Diff results

Pixel diff of the six surface pairs (340×520, 176,800 px each):

| viewport | state | px changed | % of shot | mean Δ | max Δ |
|---|---|---|---|---|---|
| 1440x900 | open | 3,560 | 2.01% | 1.16 | 147 |
| 1440x900 | search | 5,277 | 2.98% | 3.15 | 207 |
| 1280x800 | open | 3,554 | 2.01% | 1.16 | 147 |
| 1280x800 | search | 5,271 | 2.98% | 3.15 | 207 |
| 1024x768 | open | 3,579 | 2.02% | 1.16 | 147 |
| 1024x768 | search | 5,296 | 3.00% | 3.15 | 207 |

Full-page window-crop diff: 3,561 / 5,277 / 3,555 / 5,271 / 3,580 / 5,296 px (same region, ±1 px from crop
rounding). Total across the six surface pairs: 26,537 of 1,060,800 px (2.502%).

The diff images show changes only in the three preset strips and the six px of panel below the last strip;
tabs, search box, select, paragraph and the preview are untouched.

DOM inventory (per pair, 72 elements `open` / 58 `search`, 20 controls):
0 elements added, 0 removed, 0 role/name/text changes on a control, all 20 controls' inventories identical
(including values 3 / 15 / 0 and `docked`). Geometry moved on 17 elements at `open` — the three strips, their
twelve buttons, the panel container (height) and the preview (both −6 px) — and on 7 in `search`. Every strip
button's `y` moved −6 and its width to 73; no row or control input moved.

CSS inventory: 2,068 → 2,070 rules (+2, the scoped `:where(#settings-panel-general) .settings-presets` rules,
0 removed); 52 `:root` custom properties unchanged; 16 painted elements changed computed style at `open`
(the panel's height, three strips' display/margins/grid columns, twelve buttons' width/min-width/white-space/
text-overflow/overflow) and 6 in `search`. No other element's computed style changed.

Overflow: the baseline recorded one `presets-clipped-by-body` per viewport at `open`; the after set records
none. No new overflow entry appears.

## Tests

`node --test test/settings-tabs.test.js test/assistant-dock-setting.test.js` (the two the change-set names):
**exit 0, 24 pass, 0 fail, 24 total**. TAP log in `tests.log`.

## Files

| file | what it is |
|---|---|
| `comparison.json` | the artifact: protocol, every pair's before/after/diff, DOM and CSS diffs, tests, verdict |
| `comparison.html` | the same comparison as a page: before, after and diff for every pair, with the metric tables |
| `verdict.json` | the G2 word (`improved`) and its evidence |
| `capture.mjs` | the baseline capture script, retargeted at `after/` (only paths and the stage name differ) |
| `run.mjs` | boots the sandbox panel, runs `capture.mjs`, then `diff.mjs`, then stops it |
| `diff.mjs` | pixel + inventory diff, test run, writes the comparison, page and verdict |
| `after/capture.json` | the after manifest, same viewports/states/steps and `incomplete: []` |
| `after/dom.json`, `after/css.json` | the after inventories (same schema as the baseline's) |
| `after/shots/*.png` | 6 surface shots and 6 full-page records |
| `after/style.css` | the shipped stylesheet this after set was measured against |
| `diff/*.png` | 12 diff images (surface pair and full-page window crop, per viewport × state) |
| `tests.log` | the TAP output of the surface's tests |

`../after/` (the implement stage's verification capture) is left as committed; this stage's after set is
`compare/after/`, and `comparison.json` reads only that.
