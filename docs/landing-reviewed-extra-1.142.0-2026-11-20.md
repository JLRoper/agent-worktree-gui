# Landing: the row's two review chips, one per cell (1.142.0)

A worktree row can carry two review chips, and both of them used to live in the row's name line: the amber mark and
its "✓ Reviewed" press, and the result chip that prints the delivery's first clause, its age and the word reviewed.
On a row with both, the name was the thing that gave way. The amber chip stays exactly as it was. The result chip
moved into a column of its own, `reviewedExtra`, immediately to the right of the name, with its own checkbox in
Settings -> Display -> Chart columns and its id in the same `config.json` `hiddenColumns` list as every other switch.

## The two chips, named

- **the amber chip** - `reviewRowMarkHtml` in `public/render-projects.js`, declared as `CHART_CHIPS` id `reviewed` in
  `public/charts.js`, drawn with its "✓ Reviewed" press and the row's amber left edge. It draws while the row is
  waiting to be checked. **Untouched** by this landing: same mark, same press, same switch, same place in the list.
- **the result chip** - `resultChipHtml` in `public/board-scaffold.js` (its text from `public/core/row-chips.js`
  `resultLabel`), printing `first clause · 12m ago`. This is the one that moved.

The element moved is one member of the name line's markup, `${resultChipHtml(row, delKey)}`, out of the
`name: <td class="name">` template and into a new sibling cell in the same `cells` object. The collision chip, the
turnover mark, the collision mark, the rename and lock buttons and the agent badge all stay where they were: the
collision chip is this row's own tag, not a second review control.

## Why a column, and not a second chip

A chip is a mark inside a cell somebody else sized: it has no `<th>`, no `<td>` and no width to give back, so a
switch that turns it off cannot take a cell with it - it would leave an empty cell in every row. The result chip's
switch has to remove the header and the cells together, so it is a real column:

- `lib/chart-columns.js` - `CHART_COLUMN_IDS` carries `reviewedExtra` second, right after `name`; `CHART_CHIP_IDS`
  still carries only `reviewed`. `CHART_TOGGLE_IDS` is the two joined in that order, which is the order the stored
  list is normalised to. `toggleKey` compares ids without case, because `reviewedExtra` is a compound name while every
  id stored before it was lowercased.
- `public/charts.js` - the `CHART_COLUMNS` entry (`Reviewed (extra)`, min 90, give 0.6) and the chip comment that now
  says which of the two review chips this list still describes.
- `public/render-projects.js` - the moved element, and `reviewedExtra: <td class="reviewed-extra">`, which draws the
  chart's usual dash on a row with no delivery rather than a blank.
- `public/chart.css` - one line, one cell: `td.reviewed-extra` clips, and the chip is capped by the cell instead of by
  its own 210px.
- `public/app.js` - `columnPlan` finds the name and branch columns by ID, not by position (`cols.indexOf(1)` would have
  handed the branch's share of the spare room to the new column), and `loadColWidths` splices an empty slot into a
  width list saved before the column existed, so a hand-set width stays on the column the reader gave it to.
- `public/index.html` - the switch's own description: fourteen columns, what the extra one is, and that the two
  review switches are independent.
- `package.json` - `verify:reviewed-extra`.

## What proves it

- `node tools/verify-reviewed-extra.mjs` - **31 checks, 0 failed**, 0 page errors, at 2400x1000 (the width of the
  reader's own panel window), against a **second panel instance on an OS-chosen free port** with its own config and
  scan root. Nothing touches a panel already running on this machine. It asserts, in one browser session: the control
  draws `Reviewed (extra)` as a column box immediately after Worktree and ticked at rest, with the amber chip still the
  last switch and `14/14` still a count of columns; the row draws the amber mark and its press in the name line and the
  result chip inside `td.reviewed-extra` and **not** inside `td.name`, with the name drawn whole beside both; the
  header is `th[data-col-id="reviewedExtra"]` immediately right of Worktree; unticking it stores exactly
  `["reviewedExtra"]` in `config.json`, removes the header and **every** row's cell (one cell fewer, no `td` left
  empty), and leaves the amber mark, its press and the amber edge untouched; a reload keeps it off and ticking it back
  brings the cell back; and unticking the amber chip instead leaves the extra cell and its chip drawn, so neither
  switch reads the other's state.
- Screenshots, from that run, in `docs/assets/reviewed-extra/`:
  - `01-control-both-switches-2400x1000.png` - Settings -> Display -> Chart columns: `14/14`, Worktree, then
    Reviewed (extra), then the columns, with the amber chip's Reviewed last.
  - `02-row-both-chips-on-2400x1000.png` - the row with both chips: the amber mark and its press in the name cell, the
    result chip in the Reviewed (extra) cell beside it, the name drawn whole.
  - `04-row-reviewed-extra-off-2400x1000.png` - the same row with Reviewed (extra) off: the cell is gone, the amber
    press is still there, and the branch column sits against the name.
  - `05-row-amber-off-extra-on-2400x1000.png` - the other way round, for the independence claim.
- `node --test test/chart-columns.test.js test/row-chips.test.js` - **32 tests, 32 pass, 0 fail**.
- `npm test -- --test-timeout=180000`, once, on the branch - **3356 tests, 3343 pass, 13 fail, 0 cancelled**. Every one
  of the 13 reproduces on a clean `git archive main` export in this environment, so none is this branch's:
  `assistant-profile` (the whitelists), `assistant-search-scroll` (the keyboard step), `child-route`, `gateway-permissions`
  (the file itself), `header-controls` (the moved control), `paths` (the `*File`/`*Dir` key at line 221),
  `turnover-row-marker` (all four - it evals `rowHtml` with no `collisionChipHtml` in scope, stale since the row-chips
  landing), `paths-http` (Clean scratch over HTTP) and `scan-roots` (flaky: 1 pass, 1 fail on both trees). One more,
  `reasoning-runs`, failed in the sweep and passes when the file is run alone - timing, not content.
- `test/reply-actions-container.test.js` passes here, on the branch and on the export; the brief expected it red, so
  that is reported rather than fixed.
- Also driven green: `node tools/verify-row-chips.mjs` **67 checks, 0 failed** (the gate re-pointed at the moved chip)
  and `node tools/verify-reviewed-chip.mjs` **32 checks, 0 failed** (the amber chip's own gate, untouched by the move).
- `node tools/absolute-paths.mjs` - clean, 1891 tracked files, none new.

## The version and the tag

`main` read 1.141.0 when this branch was cut, so the branch carries 1.142.0 - a minor, because a new column and a new
switch are a new way for the reader to see the chart. `v1.142.0` is annotated on the bump commit; the landing moves it
onto the commit `main` carries.

## The landing

Not pushed, and no pull request: `gh`'s token is invalid in this environment, so the branch is local and the landing
stops at the commit. The work stands on
`wtgui/the-worktree-row-name-carries-two-review-4c9db3`, one feature commit plus the bump.
