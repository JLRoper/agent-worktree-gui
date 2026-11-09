# gui-improve compare - Settings -> Board

Stage 3 of `gui-improve` (visit 2). This is the after set re-shot for the compare stage, the diff of every
surface pair against the baseline, and the verdict. Visit 2 re-ran the capture and the diff on the same
change-set and the same baseline as visit 1; nothing else in the tree moved.

**Verdict: improved.** The "Folders the board scans" block now reads as one control group at every recorded
viewport: each root's path, `exists` chip and remove control are separated by 8 px (before: 0 px between the
path and the chip, 3.84 px between the chip and the remove control), and the add-folder field takes the width
its row has left, so its hint paints whole (before: `an absolute folder pat` clipped in a 154 px field with
74 px of the row unused). The change is confined to that block: 0 elements added or removed, 0 controls
changed except the intended placeholder shortening, 13 CSS rules added and none removed, no new overflow,
the smallest painted font stays 10 px, and both test runs are green (21/21 on the after tree, 22/22 on the
stage tree with the patch applied).

The artifact is `comparison.json` (`comparison/1`); `comparison.html` is the same comparison as a page with
before, after and diff for every pair.

## Visit 2 - the re-shoot

The change-set did not change: `change-set.patch` is still the implement stage's blob, sha256 `d4c8fe93…`
(`318d2032…` for the CRLF working file the patch tool reads), and the before set is still the `44b4278`
baseline under `before/` (`SOURCE.json` hashes unchanged). The after set was rebuilt from those two with
`git archive 44b4278` plus the patch and served on `127.0.0.1:7493`; its new capture is sha256
`0c722e36…`. Six of the nine surface shots are byte-identical to visit 1's; the other three (both
`presets` at 1440x900 and 1280x800, and `search` at 1280x800) differ only in the panel's anti-aliased
gradient, 12 to 154 px at a maximum channel delta of 2, which is the capture's own noise rather than a
surface change. Every geometry, DOM, CSS, pixel and test number in `comparison.json` reproduces visit 1's:
98,317 of 1,591,200 surface pixels moved (6.179%), 181 elements and 53 controls on both sides, 13 CSS
rules added and 0 removed, 0 regressions. The two correction notes this stage can carry are in the
artifact: the comparison's surface brief and URL are taken from the after capture (7493, with the
change-set applied), and the `tests` block carries each run's verbatim TAP tail (`tapTail`), with the two
logs committed beside `tests.json`.

## The surface and the change

`Settings -> Board` - the `#settings-panel-board` tab of the Settings window (`#settings`). The change is
`change-set.patch` (a byte-identical copy of `93febcc98da2:ledger/gui-improve/change-set.patch`): 13 rules
in `public/style.css`, all scoped to `#settings-panel-board` and kept at class weight with `:where()`, plus
two attributes on `#scan-root-input` in `public/index.html` (a shorter placeholder, the full sentence in
`title`). `public/app.js`, `lib/` and `server.js` are untouched.

The after tree is `44b4278` (the baseline commit) plus those two public/ hunks. It is built by `run.mjs` with
`git archive`, not by editing this checkout, so the only difference between the before and after checkouts
is the change-set. This matters: this stage tree is `a770d074`, which carries a later Prompt tab and other
public/ changes the baseline never saw; shooting that tree would have put those unrelated changes into the
diff.

## Protocol - the baseline's, unchanged

Same three viewports (`1440x900`, `1280x800`, `1024x768`), same three states (`open`, `presets`, `search`
with the filter `flash`), same steps and asserts. `capture.mjs` is the baseline's script with only its
output paths and stage name changed. A fresh browser context per viewport (no localStorage, so the Settings
window and tab start at their defaults), Playwright Chromium 156.0.8078.4, deviceScaleFactor 1,
`animations: "disabled"`, `caret: "hide"`.

The after set was shot against a throwaway panel on `127.0.0.1:7493` with its own `PANEL_CONFIG` (the same
two scan roots the baseline used: `C:/CodeReviews` and `C:/sefl-mvn-local`, `projects: []`). It served
`public/style.css` sha256 `e32526b4...` and `public/app.js` `6ab9451b...`, both byte-identical to the after
tree; the served `index.html` differs only by the panel's cache-busting stamp and the two changed
attributes. The baseline's before set is a copy of `44b4278`'s `ledger/gui-improve/baseline/` under
`before/`, with `SOURCE.json` recording the source commit and every file hash. The JSON inventories are
normalised to LF so their hashes match the baseline manifest; the 18 shot hashes match byte for byte.

## What moved

Numbers at `1440x900`, `open`; identical at `1280x800` and `1024x768` (read from the inventories, not copied
from the change-set):

| metric | before | after |
| --- | --- | --- |
| root row height | 28 px | 28 px |
| gap path -> chip | **0 px** | **8 px** |
| gap chip -> remove | **3.84 px** | **8 px** |
| remove control | 31.8 x 28, UA button | 24 x 24, transparent until hover |
| `C:/CodeReviews` path width | 92.38 px | 219.88 px (ellipsizes when longer) |
| `exists` chip | 33.77 x 19, 14 px | 38.13 x 19, 10 px pill |
| add-folder input | 154 x 20 px (client 150) | 223.52 x 26 px (client 222) |
| add-folder button | 78.38 x 28 px | 80.48 x 26 px |
| width left unused in the add row | **73.78 px** | **0 px** |
| hint width / room in the field | 382.66 px / 146 px | 145.42 px / 208 px |
| hint fits | **no** (`an absolute folder pat`) | **yes** (`an absolute folder path`) |
| Board panel content height | 1598.92 px | 1612.92 px |
| Board panel scrollHeight | 1599 px | 1613 px (the +14 px the change-set predicted) |

The path's `font-size: 11.5px` declaration is beaten by `.mono`'s 12 px at equal specificity, so the path
paints at 12 px, not 11.5 px. This is recorded as an observation, not a regression: the row's gaps, width and
ellipsis are unaffected.

## Diff results

Nine surface pairs (340 x 520 each, 176,800 px per pair), 1,591,200 px compared:

| viewport | state | px changed | % of shot | mean delta | max delta |
| --- | --- | --- | --- | --- | --- |
| 1440x900 | open | 27,243 | 15.41% | 15.57 | 236 |
| 1440x900 | presets | 5,536 | 3.13% | 3.97 | 236 |
| 1440x900 | search | 6 | 0.003% | 0.0007 | 17 |
| 1280x800 | open | 27,235 | 15.40% | 15.57 | 236 |
| 1280x800 | presets | 5,530 | 3.13% | 3.97 | 236 |
| 1280x800 | search | 0 | 0% | 0.00 | 2 |
| 1024x768 | open | 27,237 | 15.41% | 15.57 | 236 |
| 1024x768 | presets | 5,530 | 3.13% | 3.97 | 236 |
| 1024x768 | search | 0 | 0% | 0.00 | 7 |

Total: 98,317 of 1,591,200 px (6.179%). The `open` diff is the block and the 14 px shift of every row below
it; the `presets` diff is the block where the scrolled window shows it. The 6 px at 1440x900 `search` are a
1 x 6 sliver at the window's bottom-right corner (max delta 17); the other two search pairs are 0, so it is a
sub-pixel corner artifact, not a surface change. The search state hides the block and its filter still
works: 3 rows paint, the Board badge reads 3, and the panel is 100 px tall on both sides.

DOM inventory (per pair, 181 elements `open`/`presets` and 60 `search`):
0 added, 0 removed, 53 controls on both sides. The only role/name/text change is the intended one:
`#scan-root-input`'s accessible name (its placeholder) goes from `an absolute folder path - e.g. the parent
of your projects` to `an absolute folder path`, at all three viewports in `open` and `presets`; the full
sentence moves to `title` (`an absolute folder path, e.g. the parent of your projects. Enter adds it`). 0
unexpected control changes. The remove control's title still names its folder and its text stays the ✕.
468 element boxes changed across the nine pairs, all from the block's new geometry and the 14 px shift; no
row or control above the block moved.

CSS inventory: 2,087 -> 2,100 rules (+13, -0). All 13 added rules are the `:where(#settings-panel-board)`
block; `:root` is unchanged (52 custom properties, 0 changed after normalising line endings). 13 painted
elements changed computed style at `1440x900` `open`: the Board panel (height), the roots container, the two
root cards, their paths, chips and ✕ buttons, the add row, the input and the button. No other element's
computed style changed.

Overflow: the baseline records one `presets-clipped-by-body` per `open`/`presets` pair (the presets strip
below the visible body when the panel is scrolled to the top); the after set records the same one kind,
14 px lower. No new overflow entry appears, and the block itself stays inside the panel.

## Tests

```
node --test --test-reporter=tap test/scan-roots.test.js test/settings-tabs.test.js test/header-controls.test.js
```

- After tree (`44b4278` + the change-set), archived to a scratch dir for the run: **exit 0, 21 pass, 0
  fail, 21 total** (11.8 s). Log: `tests-after.log`.
- Stage tree (`a770d074`) with the change-set applied for the run, then reverted: **exit 0, 22 pass, 0
  fail, 22 total** (42.0 s). Log: `tests-current.log`.

The second run is the compatibility check: the current suite has one more test than the baseline-era tree.
Both are green, so the change does not break the surface's own tests on either base. `tests.json` carries
each run's verbatim TAP tail from `1..N` to `# duration_ms`, and the two logs are committed beside it.

The repo-wide focused selector (`npm run test:changed`) was also run over this branch's diff. It is not the
surface's gate and it is red in this cut for three pre-existing reasons: `test/absolute-paths.test.js`
refuses the compare ledger's drive-letter paths because this stage tree predates main's
`tools/absolute-paths.allow` commit (the tool's draft counts for all 11 compare files match the 11 compare
entries among main's 18 allowlist lines: `comparison.json` 156, `README.md` 7, `run.mjs` 9, each
`capture.json` 36, each `dom.json` 126, the others 1 to 6); `test/paths.test.js` fails on
`pipelineBundleSeedFile` named at `lib/pipeline-bundle-import.js:321` and absent from `statePaths()`; and
the two `assistant-attachment-spawn.test.js` cases timed out while the selector ran four files at once.
None of the three reads the Board tab or this change-set.

## Files

| file | what it is |
| --- | --- |
| `comparison.json` | the artifact: protocol, every pair's before/after/diff, DOM and CSS diffs, tests, verdict |
| `comparison.html` | the same comparison as a page: before, after and diff for every pair, with the tables |
| `verdict.json` | the G2 word (`improved`) and its evidence |
| `capture.mjs` | the baseline capture script, retargeted at `after/` (only paths and stage name differ) |
| `run.mjs` | builds the after tree (`git archive 44b4278` + the change-set), boots the sandbox, runs the capture |
| `diff.mjs` | pixel + inventory diff, page and verdict writer |
| `change-set.patch` | byte-identical copy of the implement stage's change-set (`93febcc98da2`) |
| `after/capture.json` | the after manifest, same viewports/states/steps, `incomplete: []` |
| `after/dom.json`, `after/css.json` | the after inventories (same schema as the baseline's) |
| `after/shots/*.png` | 9 surface shots and 9 full-page records |
| `after/style.css` | the shipped stylesheet the after set was measured against |
| `before/` | byte-identical copy of `44b4278`'s baseline set; `SOURCE.json` records every hash |
| `diff/*.png` | 9 surface diff images (before vs after, per viewport x state) |
| `tests-after.log`, `tests-current.log` | the two TAP runs |
| `tests.json` | the test runs' exit status and counts |

The full-page shots are recorded in both manifests with their hashes but are not diffed: the baseline's own
README says the board behind the Settings window is live, so those pages differ between any two captures,
and its instruction is to diff `surfaceFile`.

## Reproduce

```
PLAYWRIGHT_BROWSERS_PATH=C:/Users/roper/AppData/Local/ms-playwright NODE_PATH=C:/Users/roper/AppData/Roaming/npm/node_modules node ledger/gui-improve/settings-panel-board/compare/run.mjs
PLAYWRIGHT_BROWSERS_PATH=C:/Users/roper/AppData/Local/ms-playwright NODE_PATH=C:/Users/roper/AppData/Roaming/npm/node_modules node ledger/gui-improve/settings-panel-board/compare/diff.mjs
```

`run.mjs` builds the after tree in a temp dir, serves it on 7493 with the baseline's two scan roots, runs
`capture.mjs`, and refreshes `after/`. `diff.mjs` reads `before/` and `after/`, writes the diff images,
`comparison.json`, `comparison.html` and `verdict.json`. Only `ledger/` and the temp dir are written.
