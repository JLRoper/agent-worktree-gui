# gui-improve baseline — Settings → Board

Stage 1 of `gui-improve` (visit 1). This is the before state; nothing in `public/`, `lib/` or `server.js`
was edited to make it. The only writes are this directory.

## The surface

`Settings → Board`, i.e. the `#settings-panel-board` tab (`data-settings-tab="board"`) inside the Settings
window (`#settings`).

The target recorded for the implement stage: **the "Folders the board scans" block must read as one control
group — a visible gap between each root's path, its state chip and its remove control, and the add-folder
field given the width its row has left so its hint is readable.** `public/style.css` has no rule for
`.settings-root`, `.settings-root-path`, `.settings-root-chip`, `.settings-root-x`, `.settings-roots` or
`.settings-roots-add` at all: the markup `public/app.js:15814-15821` writes is unstyled, so the parts sit on
the inline baseline with no gap and the input keeps its default width.

| item | value |
|---|---|
| server | `http://127.0.0.1:7491/` — a sandbox instance of this worktree, panel 1.71.0, build `191ceb6064ef` |
| sandbox config | `PANEL_CONFIG` pointing at a scratch `config.json`; `scanRoots` `C:/CodeReviews` and `C:/sefl-mvn-local`, `projects: []` |
| served `public/app.js` | sha256 `6ab9451b…` — byte-identical to this tree |
| served `public/style.css` | sha256 `c9031470…` — byte-identical to this tree |
| served `public/index.html` | differs from the tree only by the panel's cache-busting stamp (`?v=191ceb6064ef`, `<meta name="panel-build">`) |

The two scan roots are the config's, not the surface's: two rows of different path lengths are what makes the
gap measurable.

## Protocol

Headless Playwright Chromium 156.0.8078.4, device scale factor 1, a fresh browser context per viewport (no
localStorage, so the Settings window and tab start at their defaults).

Viewports: `1440x900`, `1280x800`, `1024x768`. The Settings window is 340 × 520 at every one of them.

States:

| state | steps |
|---|---|
| `open` | goto the panel; wait for `#btn-settings` and 2.5 s of `/api/state` paint; click `#btn-settings`; click `#settings-tab-board`; scroll `#settings .settings-body` to 0; wait two animation frames. |
| `presets` | reach `open`, then `scrollIntoView({block:'center'})` on the first `.settings-presets` (the Board reorder pills); wait two frames and 250 ms. `bodyScrollTop` 90 at every viewport. |
| `search` | reach `open`, then fill `#settings-search` with `flash` (the Board rows that answer it: Flash time, Grey flash, Flash on events); wait 900 ms; scroll the body to 0; wait two frames. |

Every state is asserted before capture: `#settings` visible, `#settings-panel-board` the only visible
`[data-settings-group]`, the Board tab `aria-selected="true"`, and (in `search`) three Board rows painted
with the badge reading 3.

The board repaints its subtrees wholesale, so a read that lands mid-repaint sees the roots list empty. The
capture reads until two consecutive reads agree on the block (`stableInventory`), and the `open` state fails
rather than recording an empty roots list.

## Files

| file | what it is |
|---|---|
| `capture.json` | the manifest: viewports, states with their steps, every shot's file/sha256/pixels, the inventories, the environment, `incomplete: []` |
| `dom.json` | DOM inventory per viewport × state: every painted element in `#settings` (plus the two `<option>`s of a visible select) with tag, id/class, role, accessible name and its source, text, box, values; plus rows, preset groups, the scan-roots parts and the add row, overflow and the panel/body scroll heights |
| `css.json` | CSS inventory: the three stylesheets and all 2,087 style rules (`selector` + `style`), the at-rules, the `:root` custom properties, and for every painted element its 75 computed properties, matched-rule indices and `::before`/`::after` styles |
| `style.css` | the served `public/style.css` this baseline was measured against |
| `shots/<viewport>-<state>.png` | the full-page shot: the whole document at that viewport, Settings window included |
| `shots/<viewport>-<state>-surface.png` | the Settings window alone (340×520) — the stable before/after pair |
| `capture.mjs` | the capture script, rerunnable against any panel serving this build (`PANEL_BASE` overrides the URL) |

The full-page shots are tall because the board renders every project; the board is live, so those pages
differ between any two captures. `surfaceFile` is the pair the compare stage should diff; `file` is the
literal full-page record and `win` gives the Settings window's absolute rect inside it.

## What the baseline measures (1440×900, `open`; identical at the other viewports)

| metric | value |
|---|---|
| Settings window | 340 × 520 at x 1084, y 74 (right 16 px, top 74 px) |
| `.settings-body` viewport | 338 × 387 |
| Board panel | 18 `.settings-row`s, scrollHeight 1599; body scrollHeight 1617 |
| painted elements | 1266 in the DOM inventory, 1236 in the CSS inventory, 2,087 rules |

### The target, as numbers

| part | before |
|---|---|
| root row height | 28 px each (2 roots) |
| gap path → `exists` chip | **0 px** — the path's right edge *is* the chip's left edge, so the row paints `C:/CodeReviews` `exists` as `C:/CodeReviewsexists` |
| gap chip → remove ✕ | **3.84 px** |
| remove ✕ | 31.8 × 28, `title` names the folder, no `aria-label` |
| add row | 310 px wide; input 154 × 20 (client 150), Add folder button 78.375 × 28 |
| add field's hint | `an absolute folder path — e.g. the parent of your projects` measures **382.66 px**, the field has **146 px** of room: it paints as `an absolute folder pat` |
| width left unused in the add row | **73.78 px** to the right of the button |

### Also measured (not this target)

- Board reorder pills: 35.3, 35.3, 41.1, 41.1, 46.9 px — a 11.6 px spread; 8 px above, 10 px below.
- Top worktrees per chart pills: 35.3, 23.8, 23.8, 29.5, 29.5 px — a 11.5 px spread.
- `search` collapses the panel to three rows and hides the scan-roots block entirely (the block has no
  `.settings-row`, so the filter removes it); recorded as it is, not as a defect to fix here.

## Round and stage trees

This row's round is frozen at `main` `f0b80c7d74480a389fcce38f39cf2b5471a03d1e` — the commit this
worktree was cut from at 06:07:53.284Z, before any stage ran. That is `pipelineRun.round`, and every later
stage's tree is cut at it and recorded under its stage id (`trees.implement`, `trees.compare`, …).

The record's `round` and `trees.baseline` were written by hand on 2026-11-09, because this row's first cut
happened on the spawn path rather than through `cutPipelineTree` (`lib/assistant.js:1641`). Without a round,
`stageTreeLookup` falls back to `treeLookup` and every stage of the pipeline reuses this one tree — the defect
the per-stage model exists to remove. The values written are the cut's own: `startSha` `f0b80c7…`, parent
`main`, `cutAt` 06:07:53.284Z, `by` panel. With the round in place, `driveTaskPipelines` answers the baseline
settle with `ensureTree {stage: implement, base: f0b80c7…, parent: main, role: stage}` (run against this row's
record before the settle, not inferred).

## Landing

The accepted change must land as code on main: the stage tree whose change the reviewer accepted commits it on
its own branch, pushes that branch and opens the PR against `main`, with the comparison page linked from the PR
body. A later `correct` visit that changes the accepted change-set must push the corrected commit to the same
branch (or open a superseding PR and close the first), so the branch the PR names is the branch whose HEAD the
review accepted.

## Reproducing the after state

Serve the stage's own tree on a free port with its own `PANEL_CONFIG` whose `scanRoots` are the same two
folders, then:

```bash
PANEL_BASE=http://127.0.0.1:<port>/ PLAYWRIGHT_BROWSERS_PATH=C:/Users/roper/AppData/Local/ms-playwright \
  NODE_PATH=C:/Users/roper/AppData/Roaming/npm/node_modules node ledger/gui-improve/baseline/capture.mjs
```

`public/` is read per request; a change under `lib/` needs the server restarted. The 340×520 surface pair
depends only on the public files and the two scan roots, not on the live board behind the window.
