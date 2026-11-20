# Landing: the reviewed chip is a switch (1.132.0)

PR #805 merged into `main`; the rebase merge re-created the branch's eight commits on top of `ed9d3aeb` and the tip
they left was `dcd7960b`. The `reviewed` chip is no longer an unconditional part of the chart: it is one more entry
in Settings > Board > Chart columns, last after the thirteen columns, in the same holder with the same checkbox and
the same stored list (`config.json` `hiddenColumns`). Switched off, the row emits no mark, no press and no amber
edge; switched on it is byte-for-byte what it was.

## What landed

- `public/charts.js` (76 lines) - `CHART_CHIPS` (one entry, `reviewed`), `chartChipShown(id)` as the one answer the
  row renderer reads, `chartToggleIds()` as the columns' ids followed by the chips', and the Settings holder built
  from the same two arrays, so the chip cannot be drawn last in one place and missing from the other. The counter
  beside the holder stays a count of columns (`13/13` with the chip off) and the sentence beside it names the chip
  instead.
- `lib/chart-columns.js` (22 lines) - `CHART_CHIP_IDS = ["reviewed"]` and `CHART_TOGGLE_IDS`, which
  `chartColumnsFrom` filters against, so `POST /api/settings/columns` accepts a chip id and stores it beside the
  columns' ids. A chip is not a column: `shownChartColumns`, the `<th>` list, the colspan and the column widths stay
  column arithmetic.
- `public/render-projects.js` (21 lines) - `reviewRowMarkHtml` returns `""` before it builds any element when
  `chartChipShown("reviewed")` is false, and `rowHtml`'s `has-review` class is gated on the same predicate, so the
  name line closes up with no gap and no empty holder. The result card, the header count, the table filter and the
  `H` rotation are untouched.
- `public/index.html`, `docs/using-the-board.md` - the drawer's rows and the note that says where the switch lives.
- `test/chart-columns.test.js` (114 lines) - the page's switch list and the server's are one list in one order; the
  chip's box is built into the columns' own holder; switching it off stores its own id and leaves every column's
  state alone; the id survives a restart beside a column's; the counter stays a count of columns.
- `test/review-lane.test.js` (30 lines) - with the switch off the row emits `""`; with it on the mark, its sentence
  and its press are the strings they were, and the amber edge is gated on the same predicate.
- `tools/verify-reviewed-chip.mjs` (new, 393 lines, declared `HARNESS: LIVE GATE`) and `package.json`'s
  `verify:reviewed-chip` entry - a panel of its own over a sandbox repo with two worktrees and a review record,
  driven headless at 1440x900, with five shots under `docs/reports/assets/reviewed-chip-toggle/`.

## What proves it

- `node --test test/chart-columns.test.js test/review-lane.test.js` - **36 tests, 36 pass, 0 fail**.
- The branch's own gate, `npm run verify:reviewed-chip`, recorded in the PR body at **32 checks, 0 failed**: the
  control open (thirteen columns then Reviewed last, `13/13`), the chip on, the chip off with the name line
  27px narrower and no placeholder, the state after a reload, the chip ticked again, the box keyboard-reachable and
  Escape closing the drawer with the stored list unchanged. Its five shots are the ones in the PR.
- `npm run changelog:check` - `CHANGELOG.md is current - 647 releases`.
- `npm test`, the full suite, once, in a clean `git archive` export of the landed `main` (`182a223`): **3293 tests,
  3278 pass, 15 fail** in 18.1 minutes. None of the fifteen names the chip, the chart's columns, or any file this
  landing touched, and the two files this landing adds tests to pass 36/36 when named directly. Seven are the
  findings the 1.131.0 landing note recorded against `31dfb2d4` (`assistant-profile:165`,
  `assistant-search-scroll:180`, `child-route:17`, `gateway-permissions:1`, `header-controls:73`, `paths:221`,
  `paths-http:150`). The others are `absolute-paths:241` and `:252`, `child-tree:79`, `job-store-atomic:51`,
  `queue-sweep:175` and `:258`, `release-sweep:113`, and `scan-roots:51`, which passes 2/2 when the file is run
  alone and fails only under `--test-concurrency=4`.

## The landing

The branch was cut from `31dfb2d4` (the 1.129.0 landing note). The cache landing merged first, so `origin/main` was
`ed9d3aeb` at `1.131.0` and the branch was seven ahead and eleven behind. `git cherry origin/main HEAD` printed
seven lines, every one a `+` - nothing already-landed travelled.

The rebase dropped the branch's own bump commit and its changelog render, so `package.json` resolved on main's
`1.131.0` and the scripts entry this branch adds stayed. `node tools/version.mjs apply minor` then stepped the bump
to `1.132.0`, committed it as `cef6d6a1bc` and claimed `v1.132.0` on origin. The old bump declared `1.130.0` and
`v1.130.0` was anchored at it, so `1.130.0` was spent and the tool moved past it.

The first push was refused by `.githooks/pre-push`: `tools/verify-reviewed-chip.mjs`'s header named a folder on this
machine. The path came out of the line, the fix went in as its own commit, and the branch's eight commits were
rebased onto `main`:

| branch | on `main` | commit |
| --- | --- | --- |
| `229e7417` | `de33a82a` | feat: the reviewed chip is one more switch in the chart's column control |
| `9aa5d299` | `825f0cae` | test: a live gate drives the chip's switch at 1440x900 |
| `295f76f3` | `4db3b66d` | docs(board): the reviewed chip is switched in Chart columns, last in the list |
| `d198aa72` | `6e7afea1` | test: the chip gate's shots are taken on the landed build |
| `38cd1198` | `1566f534` | docs(chart): the switch's own words use plain hyphens, not em dashes |
| `cef6d6a1` | `7b4bcdc2` | chore: 1.132.0 - the version this landing carries |
| `b2480c64` | `199b4f18` | docs: render the changelog - 647 releases |
| `5f041eeb` | `dcd7960b` | fix: the gate's header names the npm root without a machine path |

`npm run land:pr -- 805` merged it with `--rebase --admin`. The same command fast-forwarded the primary checkout
`ed9d3ae -> dcd7960`, moved `v1.132.0` from `cef6d6a1bc` onto `7b4bcdc2`, rendered the changelog at the merged tip as
`182a223` (`docs: render the changelog - 647 releases`) and pushed `main` to it. `npm run land:check` reads
`CHANGELOG.md is current - 647 releases`.

## The anchor

`v1.132.0` is an annotated tag at `7b4bcdc2`, the commit that first declared the number. `npm run verify:version-tags
-- --ref origin/main` counts **647 bumps in `package.json`'s history, 642 tagged and annotated at the commit that
first declared them**, and its 7 findings name no version this landing touched: two backwards steps at `f4cdd0d7`
and `bf4b57b0`, four `wrong-commit` anchors from `v1.76.22` to `v1.92.4`, and `v1.82.2` untagged. They are main's,
older than this work, and were left alone. The 31 tags held on branches still include the stray `v1.126.1` at
`a4dc4a6b`; it was not moved.
