# Landing: the verdict cell is the badge alone, and the kind gets a column (1.151.0)

PR #821 put the kind mark in front of the badge inside the verdict cell, `verdict: <td class="verdict">${kindMarkHtml(row)}${badge}</td>`.
The mark is a 22px button, so on the landed tree's row the cell's text read `RMERGED (1 commit)` and the ellipsis took
the end of it - the screenshot showed an R chip where `ON MAIN` and `MERGED` used to be - and at 768 the cell's 52px
had to hold the mark before it held a single word of the badge.

The verdict cell renders `${badge}` alone again and nothing else, so the branch status reads as it did before #821.
The mark moved to a Kind column immediately left of it, drawn by the same `kindMarkHtml`, so the R/T letter, the
`aria-label`, the `title`, the click-to-lift button on an unlifted research tree and the ✓ tick on a lifted one are
the ones #821 shipped, only in a cell of their own.

## What landed

- `public/render-projects.js` - the cells map: `verdict: <td class="verdict">${badge}</td>` at 859 and
  `kind: <td class="kind">${kindMarkHtml(row)}</td>` at 864, with the why in the comment between them ("in the verdict
  cell it clipped the words the reader needs"). `kindMarkHtml` itself (896) is untouched, and the legend (393) now
  decodes T and R under "the kind column", naming the lift and the tick.
- `public/charts.js` - the `kind` entry (288) with `min: 46` and `give: 1.2`, its long `title`, and the floors the
  column is paid for out of (below). The `verdict` entry keeps `min: 104` and its `give: 0.5`.
- `lib/chart-columns.js` - `CHART_COLUMN_IDS` carries `kind` between `nextread` and `verdict`, so the column is in
  the chart's own order and in every count derived from it.
- `public/app.js` - `COL_WIDTHS_INSERTIONS` (9447) replaces the single stored-width insertion index: a reader whose
  `config.json` was written before `reviewedExtra` and before `kind` has its 13 old widths carried past both, in
  order, instead of landing on the wrong columns. The comment at 7617 that pointed at "the R in the Verdict cell"
  now points at the Kind column.
- `public/chart.css` - `td.kind` (117) takes the mark's own box and no ellipsis of its own; `td.verdict .badge` (82)
  keeps the ellipsis it always had.
- `test/chart-columns.test.js` - the `expected` list names `kind` on purpose, so a column added or dropped without
  the list moving is a red test.
- `tools/verify-branch-kind.mjs` - rewritten around the split (below).
- `tools/verify-chart-columns.mjs` - the switch counts moved to fifteen columns and a driven Kind block was added.
- `tools/kind-fixture.mjs` and `tools/capture-kind-column.mjs` - the shared five-row git fixture and the camera.
- `docs/assets/branch-kind-column/*.png` - the before and after sets, 16 shots.
- `package.json` - 1.151.0.

## The width the column had to be paid for

At 1440 the chart's floors already filled the card's 1324px. A 46px floor for the new column on its own tipped
`columnPlan` (`public/app.js:9528`) into its proportional-scale branch, which shaves about 4% off every column: the
verdict measured 101px and clipped `MERGED (1 commit)` to `MERGED (1...` - the regression again, one column to the
left. `initiative`, `life` and `nextread` give up 16px of floor each (92 to 76) to pay for the 46, which puts the
verdict back at the width it had before #821: **105px at 1440 and 52px at 768**, against 105 and 51 in a pre-#821
capture. The gate now asserts the verdict cell's 104px floor, so the scale branch cannot come back unnoticed.

## What proves it

- `node tools/verify-branch-kind.mjs` - **77 checks, 0 failed**, 0 page errors: the verdict cell holds 0 marks and its
  text is exactly the badge's own text; `td.kind` carries R on the research tree, T on the turnover child and the ✓
  on the lifted one; the `Kind` header sits immediately left of `Verdict` (`indexOf("verdict") - indexOf("kind") === 1`);
  the mark's box is inside a cell wide enough for it, the badge owns the cell it is in, and the verdict cell keeps its
  104px floor; the lift is pressed from the new column and the record on disk gains `lifted: true`; the column hides
  and shows from the panel's switch with the counter reading `15/15` when it is back; a new cut still draws its T
  without a reload; the cut dialog still offers exactly `turnover` and `research`.
- `node tools/verify-chart-columns.mjs` - **74 checks, 0 failed**: fifteen columns, fourteen drawn at rest, the one
  chip beside them, the Kind switch starting on, fifteen headers and cells with it and fourteen without, the stored
  list naming it in the chart's own order, and the twelve-column round trip after Cherry and Tip are unchecked.
- `node --test test/chart-columns.test.js` - **22 tests, 22 pass, 0 fail**; `node --test test/branch-kind.test.js` -
  **5 tests, 5 pass, 0 fail**.
- The before and after pair, same fixture on both sides (`tools/kind-fixture.mjs` builds it for the gate and the
  camera alike): on the 1.148.0 page the landed row's `td.verdict` innerHTML begins
  `<button class="kind-mark kind-research" ...>R</button><span class="badge merged">MERGED (1 commit)</span>` and its
  text reads `RMERGED (1 commit)`, with no `td.kind` on the page at all; on this branch `td.verdict` is
  `<span class="badge merged" title="Against main: 0 ahead, 1 behind.">MERGED (1 commit)</span>` and the R is in
  `td.kind`. Badge 83px in a 105px cell at 1440, 30px in a 52px cell at 768; before, 83px in a 106px cell at 1440
  because the mark shared it. At 1440 the 83px badge renders `MERGED (1...`: the count elides, exactly as it elides on
  the pre-#821 page at the same width (the badge's `title` carries the sentence), and what #821 took away was the
  word, not the count. The pre-#821 row is in the report beside this one for the comparison. The shots are
  `docs/assets/branch-kind-column/before-0*.png`, `after-0*.png` and `pre-821-0*.png`:
  research, turnover, landed MERGED and lifted, each at 1440x900 and 768x900.
- `npm test`, once, on this branch - **3392 tests, 3381 pass, 11 fail**. None is this branch's: the eleven files were
  run in isolation against a `git archive origin/main` export (1.150.0 when the sweep ran) and against this branch, 91 tests each time -
  main answers 80 pass and 11 fail, this branch 82 pass and 9 fail, so every file that went red under the full suite
  here is red on the base as well. The eleven: `assistant-profile`, `assistant-search-scroll`, `assistant-to-replay`,
  `child-route`, `gateway-permissions`, `header-controls`, `junctioned-node-modules`, `paths`, `paths-http`,
  `reasoning-runs`, `settle-wake`. Two others that went red in an earlier full run (`build-version-deadline` and the
  `dataDir` case in `paths-http`) pass alone in both trees, which is the parallel-suite flake the previous landing
  note recorded too.

## The version and the tag

`main` moved three times while this branch was cut: `1aad736b` read 1.148.0, `e8341c63` read 1.149.0, `e27192a6`
read 1.150.0, and `3a32f5db` reads 1.150.1 - the last of those landed as PR #827 while this branch was in review, so
the branch was rebased again onto it. The only conflict was `package.json`'s version line, kept at the branch's own
number. With `v1.149.0`, `v1.150.0` and `v1.150.1` all on the remote, a new column with its own switch is a
reader-facing affordance, so the branch carries **1.151.0** - the next minor above the taken number.
`node tools/version.mjs check` reads "the branch's number is above origin/main's", and the tag is the landing's: the
merge commit moves `v1.151.0` onto the commit `main` first declares the number at.

## The landing

Squash merge, not done here: the brief hands this branch to the manager. The changelog render is the base's last step
(`npm run land`, per `docs/versioning.md`), so this branch does not touch `CHANGELOG.md` and reads red under
`npm run changelog:check` until the merge - which is the documented state of any branch that carries a bump.

## What this branch did not fix

`test/header-controls.test.js:75` fails the same assertion on `origin/main` and on this branch: the pause handler
calls `connect({ waitForSnapshot: true })` and the test still asserts `/connect\(\)/`. It is red on a `git archive
origin/main` export, it reads `public/app.js` source rather than this branch's behaviour, and this branch did not
change that handler. The rest of the red files are the base's too - see the suite line above for the counts and the
files.
