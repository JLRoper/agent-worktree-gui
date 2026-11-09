# gui-improve baseline — Settings → General

Stage 1 of `gui-improve` (visit 1). This is the before state; nothing in `public/`, `lib/` or `server.js`
was edited to make it. The only writes are this directory.

## The surface

`Settings → General`, i.e. the `#settings-panel-general` tab inside the Settings window (`#settings`) on
`http://127.0.0.1:7331/`.

The target recorded for the implement stage: **each preset row must read as part of the control above it, and
its pills must share one width.** That is the same target the first gui-improve run measured; the style here is
still the unmodified one (`.settings-presets` at `public/style.css:438-441`), so that run's change never landed.

| item | value |
|---|---|
| server | `http://127.0.0.1:7331/` — the panel, version 1.69.1, build `b37067dcade5` |
| served `public/app.js` | sha256 `b9c1e132…3724ab` — byte-identical to this tree |
| served `public/style.css` | sha256 `90c7a887…d53850d` — byte-identical to this tree |
| served `public/index.html` | differs from the tree only by the panel's cache-busting stamp (`?v=b37067dcade5`, `<meta name="panel-build">`) |

## Protocol

Headless Playwright Chromium 156.0.8078.4, device scale factor 1, a fresh browser context per viewport (no
localStorage, so the Settings window and tab start at their defaults).

Viewports: `1440x900`, `1280x800`, `1024x768`.

States:

| state | steps |
|---|---|
| `open` | goto the panel; wait for `#btn-settings` and 2.5 s of `/api/state` paint; click `#btn-settings`; click `#settings-tab-general`; scroll `#settings .settings-body` to 0; wait two animation frames. |
| `search` | reach `open`, then fill `#settings-search` with `budget` (the one General row that answers it: Turn briefing budget); wait 900 ms; scroll the body to 0; wait two frames. |

Every state was asserted before capture: `#settings` visible, `#settings-panel-general` the only visible
`[data-settings-group]`, the General tab `aria-selected="true"`; in `search` exactly one `.settings-row` paints.

## Files

| file | what it is |
|---|---|
| `capture.json` | the manifest: viewports, states with their steps, every shot's file/sha256/pixels, the inventories, the environment, `incomplete: []` |
| `dom.json` | DOM inventory per viewport × state: every painted element in `#settings` (plus the two `<option>`s of the visible select) with tag, id/class, role, accessible name and its source, text, box, values; plus rows, preset groups, overflow and the panel/body scroll heights |
| `css.json` | CSS inventory: the three stylesheets and all 2,068 style rules (`selector` + `style`), 27 at-rules, the 52 `:root` custom properties, and for every painted element its 75 computed properties, matched-rule indices and `::before`/`::after` styles |
| `style.css` | the served `public/style.css` this baseline was measured against |
| `shots/<viewport>-<state>.png` | the full-page shot: the whole document at that viewport, Settings window included |
| `shots/<viewport>-<state>-surface.png` | the Settings window alone (340×520) — the stable before/after pair |
| `capture.mjs` | the capture script, rerunnable against any panel serving this build (`PANEL_BASE` overrides the URL) |

The full-page shots are tall (15,000–17,000 px) because the board renders every project and card; the board is
live, so those pages differ between any two captures. `surfaceFile` is the pair the compare stage should diff;
`file` is the literal full-page record and `win` gives the Settings window's absolute rect inside it.

## What the baseline measures (1440×900, `open`; identical at the other viewports)

| metric | value |
|---|---|
| Settings window | 340 × 520 at x 1084, y 74 (right 16 px, top 74 px) |
| `.settings-body` viewport | 338 × 387 (top 206, bottom 593) |
| General panel content | 310 × 453.06 (bottom 663.06) — the tab is 66 px taller than its body |
| body / panel scroll height | 471 / 453 |
| Assistant pane row | 310 × 28 at y 222; select 204.92 wide, right edge 1409 |
| Scan workers row | y 430.75, h 26; input right 1270.81 |
| Row refresh row | y 486.59, h 26; input right 1263.38 |
| Turn briefing budget row | y 542.44, h 26; input right 1312.88 |
| pills: Scan workers | widths 23.78, 23.78, 23.78, 23.78 — spread **0**; gap above 8, below 0 |
| pills: Row refresh | widths 35.33, 41.09, 41.09, 46.88 — spread **11.55**; gap above 8, below 0 |
| pills: Turn briefing budget | widths 35.33, 29.55, 35.33, 35.33 — spread **5.78**; gap above 8, below 10 |
| last pill row vs the body's visible bottom | bottom 598.28 vs 593 — **clipped by 5.28 px** at open |
| smallest painted font | 10 px |

`search` has one visible row (Turn briefing budget, y 222) and a panel content height of 133 px; the search
badge on the General tab reads 1 and every other tab reads 0.

## Completeness

Every one of the 3 viewports × 2 states has both shots (sha256 verified) and a non-empty DOM and CSS inventory.
`capture.json` carries `incomplete: []`; had any pair been missing, it would name the viewport and the missing
piece there instead.
