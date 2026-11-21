# Landing: the kind a cut recorded, on the row, with the lift it never had (1.146.0)

This branch opens a PR against `main`; the manager lands it. It answers one stall in the one-diamond landing: a
research tree's push meets a refusal, the refusal is answered by lifting the record, and the page had no control that
could show or lift anything.

## The two kinds, as the code defines them

`lib/branch-kind.js` closes the vocabulary at two values and nothing else:

| kind | what it is | its push |
| --- | --- | --- |
| `turnover` | a child cut from a turnover branch, with a destination on the remote | meets the ordinary controls |
| `research` | cut from the project's main parent, local only | meets the research refusal until the record says `lifted: true` |

The record is written once, at the cut, into `~/.wag/state/branch-parents.json` keyed by the tree's six-hex tag
(`lib/jobs.js` `rememberParent` / `treeParentKey`): `{ parent, branch, tree, at, kind, lifted? }`. The cut dialog reads
`GET /api/branch-kinds` and offers the two choices with neither pre-selected (`public/app.js`, the cut dialog); when
the reader does not choose, the server decides from the parent's name (`planCut`), and neither applying raises the
clarify card rather than guessing. `POST /api/worktree/kind-lift` writes `lifted: true` on the record and leaves the
kind alone.

## What was missing, and what this adds

Nothing on the page said what kind a row was, and the lift had no control at all: finishing a landing on a research
tree meant opening that JSON file or hand-calling the route. Now:

- `server.js` - `applyTreeKind` / `withTreeKinds` stamp four fields on every row, in the snapshot and in every `row`
  frame: `branchKind`, `branchKindLabel` (from `KIND_LABELS`, not a second vocabulary), `branchKindLifted`,
  `branchKindParent`. The lookup is `jobs.treeKindFor`, the same matcher the push rule and the lift route use, so a row
  cannot disagree with the gate. A row with no record carries none of the fields: absence is not a third kind.
  `POST /api/worktree/kind-lift` now returns the same fact and broadcasts a snapshot, so a second tab's row turns over
  without a reload. The cut awaits its record write, so the row it answers with already has a kind.
- `public/render-projects.js` - `kindMarkHtml` draws ONE letter in the verdict cell: `T` for a turnover child (a
  `span` with `role="img"` and an accessible name), `R` for an unlifted research tree (a real `button`), `R` with a
  tick once lifted. The name line is untouched. The chart's legend decodes the pair.
- `public/app.js` - `showKindConfirm` / `confirmKindLift`: the inline question under the pressed row, the tree bound
  when the question opens, `Cancel` and `Lift`, Escape back to `R`, and the server's refusal drawn in the question and
  the banner when the branch has no record. The question survives a board repaint.
- `public/chart.css`, `public/style.css` - the chip and the question's ink.

## Why one letter

The landing before this one moved a review chip out of the name line because two chips squeezed the name out, and the
one before that removed a wide counts chip. This answers with the smallest readable thing: the mark measured 13.8px
wide unlifted and 22.1px lifted in the gate, and on the same row the name was drawn whole at 143px of a 353px cell.
A sentence-long chip was not an option, and a mark in the name line would repeat the defect.

## The Worktrees tab

The assistant's Worktrees pane draws its rows through the same `rowHtml`, so the same `T` and `R` appear in its
verdict column, and the pane's `R` opens the question under the pane's own row. The gate reads the pane's own nodes to
prove both. There is no photograph of the pane: at 1440 it is a docked 450px column carrying the board's
fourteen-column table, so a picture of it would prove the table is narrow rather than that the kind is on the row.

## The cut dialog is unchanged

The gate opens the dialog on the turnover parent and reads the two choices from the route, both unchecked, then cuts a
turnover child through the dialog and reads the new record back from the file on disk: `kind: "turnover"` with the
parent it was cut from, `lifted` absent. The page draws `T` on the new row without a reload.

## What proves it

```
PANEL_SHOTS_DIR=docs/assets/branch-kind node tools/verify-branch-kind.mjs
  second panel instance on a free port, a git fixture with a turnover parent, a research tree and a turnover child
  57 checks, 0 failed
```

The gate drives: the record through `/api/state`; `R` as a button in `td.verdict` and never in `td.name`; the name
drawn whole; the mark under 24px; `Tab` reaching it with a 2px focus ring; Enter opening the question with the
keyboard on Cancel; Escape returning to `R`; a branch with no record refused by the real route with its sentence in
the question and the banner; `Lift` writing `lifted: true` to the file on disk and turning the row into `R` with a
tick and a green note; the Worktrees pane's own `R` and `T` and its question; the cut dialog's two choices and its
record; no page errors.

Screenshots in `docs/assets/branch-kind/`:

- `01-research-row-1440x900.png` - the research row, amber `R`, name whole
- `02-turnover-row-1440x900.png` - the turnover child row, blue `T`
- `03-lift-confirm-1440x900.png` - the question open under the row, with its sentence and the two answers
- `04-lifted-row-1440x900.png` - the same row after the lift: `R` with a tick, green
- `05-cut-dialog-1440x900.png` - the cut dialog, two kinds, neither pre-selected

`npm test` on this tree, once: 3373 tests, 3358 passed, 15 failed. One of the 15 was this branch's own pin:
`test/chart-columns.test.js` counted four `colspan="${wtColspan()}"` rows and the lift question makes five, so the
count is updated and that file passes 22/22. The other 14 are not this branch's: the nine reds the 1.140.0 note
already names (`assistant-profile`, `assistant-search-scroll`, `child-route`, `gateway-permissions`,
`header-controls`, `paths-http`, `paths`, `reasoning-runs`, `scan-roots`), four host reds that also fail on `main`
extracted with `git archive` (three `placed-nodes` lookups that want the Playwright headless shell this host does not
carry, and `junctioned-node-modules`), and one timing flake (`child-tree` sleeper pid) that passed twice when run
alone. No new failure remains.

## Files

`lib/jobs.js`, `public/app.js`, `public/chart.css`, `public/render-projects.js`, `public/style.css`, `server.js`,
`package.json` (1.146.0), `test/chart-columns.test.js`, `tools/verify-branch-kind.mjs`, and the five screenshots.
