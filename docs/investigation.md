# Rung 7: a live round beside main - stage 2 conclusion

Worktree: .worktrees/rung-7-round-a-live-round-beside-main-stage-2-conclude-841df7 (repo-relative)
Branch: wtgui/rung-7-round-a-live-round-beside-main-stage-2-conclude-841df7
HEAD at conclusion time: 23fbe197 (docs: render the changelog - 529 releases)
Working tree before this file: clean (git status --porcelain printed nothing)

This stage reads stage 1's handoff, ledger/investigate/probe.md at commit a47b8e0890b1, blob
4676a4f00ff0. The working file has moved off that pin, so the blob was read with
`git cat-file -p 4676a4f00ff0` and not from the checkout. The probe's line citations were then
re-checked against this tree's source; one of its claims needed narrowing (see "What I ruled
out", last item).

## The one paragraph

The chart never joins a round to its stage trees through `pipelineRun.round`; it joins rows by
branch, and the indent is a DOM attribute pair written on the page. `pipelineRun.round` holds
nine fields, all written once at lib/assistant.js:1693 from the parent-tree cut at :1687 -
`parentPath` (the directory the assembly lands in), `parent` (the branch every stage tree is cut
from and the landing step pushes), `slug`, `tag`, `base` (the ref, `origin/main`), `sha` (the
commit that ref resolved to at the cut), `display`, `at`, `by` - and it is re-read only by
`roundOf` (lib/task-pipeline-drive.js:1195-1205, shape documented at :1182), which normalises
each field to text or null and is called by the driver for the cut, the tree lookup and the
assembly (:1227, :1321, :2359), never by the renderer's nesting code; the round is a top-level
row because `Jobs.makeWorktree` is called with `round: true` and `remote: "main"`
(lib/assistant.js:1687), so lib/jobs.js:2667 sets `named = branchNameOf(parent) || (round ? null
: branchNameOf(start.ref))` to null, and `ParentBook.record` (lib/parents.js:281, :289) therefore
stores `parent: null` with `parentSource: "unknown"` (a remote-tracking ref is recorded as
`parentRef`, never as a chart parent); each stage tree is cut with `from`/`parent` set to
`round.parent` (lib/assistant.js:1705-1711), so the same book stores `parent: <round branch>`
with `parentSource: "cut"`, `lib/scan.js:186-194` copies that record onto the row as `row.parent`,
`row.parentSha` and `row.parentSource`, and the page's `childTreeOf` (public/render-projects.js:411)
builds `byBranch` from every row carrying a `branch` and `parentOf` from every row carrying a
`parent`, keyed by `keyOf(project, path)` = `` `${project}::${path}` `` (public/core/dom-format.js:31);
`groupCtxOf` (:451) turns that into `parentKey: null, depth: 0` for the round and
`parentKey: <round row key>, depth: 1` for each stage, and `paintRowGroup` (:531-566) is the sole
writer of `data-parent-key` and `data-depth` - it removes both from the round row (:543-546) and
sets them on a child as `tr.dataset.parentKey` (:539), `tr.dataset.depth` (:541) and the CSS
variable `--child-depth` (:542), which is what public/chart.css:186 reads for the visible indent;
`rowHtml` (:703) emits only `data-key`, and `paintUnder` (:570) copies `data-parent-key` onto a
row's detail, question and offer nodes so one selector hides a whole group.

## The round's fields and where each is written

All nine are written together at lib/assistant.js:1693 from the cut at :1687
(`makeWorktree(..., { name: named, remote: "main", round: true })`) and kept unchanged on every
later cut of the same run (`keptRound`, :1746).

| field | meaning | source at the cut |
| --- | --- | --- |
| `parentPath` | the round's parent worktree, `.worktrees/<slug>-<tag>`; where the assembly lands | `root.path` |
| `parent` | the round's branch, `wtgui/<slug>-<tag>`; every stage tree is cut from it, the landing pushes it | `root.branch` |
| `slug` | task slug the names are built from | `roundNameOf` |
| `tag` | six-character tag that keeps directory and branch unique | `roundNameOf` |
| `base` | the ref it was cut from, `origin/main` | `root.startRef` |
| `sha` | the commit that ref resolved to at the cut, frozen so a later landing cannot reach this round | `root.startSha` or the tree's HEAD |
| `display` | the row title, "Rung 7 round: a live round beside main" | `roundNameOf` |
| `at` | cut time | `at()` |
| `by` | who cut it, `panel` | literal |

`pipelineRun.trees[stage].parent` records the same branch at lib/assistant.js:1723, but nothing
in the chart reads it; it exists so a later pass can see which round a stage tree belongs to.

## What makes the row top level, and what makes the stage rows one indent under it

1. The round is cut with no `parent` and `remote: "main"` (lib/assistant.js:1687). lib/jobs.js:2667
   nulls `named` for a `round: true` cut, so the cut records no chart parent.
2. lib/parents.js:281 computes `parent` as `named` when named, else the ref only when
   `refNamesLocalBranch` is true and the ref is not a main name; for a round both fail, so
   `parent` is null and `parentSource` is `"unknown"` (:289). The intent is stated at :275-277:
   the round's parent tree draws BESIDE the checkout's main row.
3. lib/scan.js:186-194 matches the book record to the row by path then branch (`parentFor`) and
   writes `row.parent`, `row.parentSha`, `row.parentSource`.
4. A stage tree is cut with `from: round.parent, parent: round.parent` (lib/assistant.js:1705-1711),
   so its record stores the round's branch with `parentSource: "cut"`, and every stage row carries
   that branch in `row.parent`.
5. public/render-projects.js:411-446 (`childTreeOf`) builds `byBranch` and `parentOf`; :451-468
   (`groupCtxOf`) yields `parentKey`/`depth`; :473 (`nestRowKeys`) only fixes drawing order.
6. `paintRowGroup` (:531-566) writes `data-parent-key`, `data-depth` and `--child-depth` on a child
   and removes all three on a top-level row; `paintUnder` (:570) propagates `data-parent-key` to
   the nodes painted under the row.
7. The indent is CSS: public/chart.css:186
   `#projects tbody tr.row.is-child > td.name { padding-left: calc(12px + 16px * var(--child-depth, 1)); }`.

## Live evidence on this board

Read from the running panel at 127.0.0.1:7331 (`/api/state`, generatedAt 2026-11-10T03:16:33.208Z,
project agent-worktree-gui, 87 rows). The three rows, and what `childTreeOf`/`groupCtxOf` compute
for them:

    wtgui/rung-7-round-a-live-round-beside-main-8a6f35
      row.parent=null | parentSource=unknown | parentSha=23fbe1974b89420c3357add805760673b2754959
      -> no data-parent-key, no data-depth (top-level, beside main)
    wtgui/...-stage-1-probe-5000ca
      row.parent="wtgui/rung-7-round-a-live-round-beside-main-8a6f35" | parentSource=cut
      -> data-parent-key="agent-worktree-gui::C:/ProjectDevelopment/agent-worktree-gui/.worktrees/rung-7-round-a-live-round-beside-main-8a6f35", data-depth="1"
    wtgui/...-stage-2-conclude-841df7
      row.parent="wtgui/rung-7-round-a-live-round-beside-main-8a6f35" | parentSource=cut
      -> same data-parent-key, data-depth="1"

The queue record for task 62 carries the matching `pipelineRun.round` (parentPath, parent, slug
`rung-7-round-a-live-round-beside-main`, tag `8a6f35`, base `origin/main`, sha `23fbe197...`,
display "Rung 7 round: a live round beside main", at 2026-11-10T03:10:33.397Z, by `panel`) and one
`pipelineRun.trees` entry per stage. The repo's own end-to-end proof also passes on this tree:

    node --test test/chart-nesting.test.js
    ℹ tests 5  ℹ pass 5  ℹ fail 0

That test cuts a real round from a real `origin/main`, reads the ParentBook records, and runs the
page's own `childTreeOf`, `groupCtxOf` and `nestRowKeys` over the rows; it asserts the round's
`parentOf` is undefined, main's `childrenOf` is empty, both stage keys map to the round, and
`groupCtxOf(roundKey)` is `{ parentKey: null, depth: 0, childCount: 2 }`.

## What I ruled out

- Ruled out a server-sent indent. `grep` over lib/ and server.js finds no writer of
  `data-parent-key`, `data-depth` or `--child-depth`; the only `parentKey` on the server side is
  lib/parents.js:32, a book key of `project::branch`, a different value from the page's row key.
- Ruled out `rowHtml` setting the pair. public/render-projects.js:703 emits `class`, `data-key`
  and cells only; `paintRowGroup` is the single writer, and it also removes the pair from a row
  that has become top level, which is how a re-ranked or freshly scanned row stops being a child.
- Ruled out the round being cut from local `main`. The cut passes `remote: "main"`, so
  `refNamesLocalBranch` is false and `isMainName` refuses the ref anyway; naming `main` there is
  what used to nest every round under the checkout's row (lib/jobs.js:2661-2666).
- Ruled out `nestRowKeys` as a cause of the indent. It reorders only; a row whose parent is not
  drawn keeps its own place, which is why the top-N case draws a child at the top level rather
  than dropping it.
- Ruled out that `pipelineRun.trees[stage].parent` drives the picture. It is written at
  lib/assistant.js:1723 but no renderer code reads it.
- Narrowed one probe claim: the page is not entirely blind to the round record. `row.round` is
  stamped onto the row server-side by `withRoundNames` (server.js:3072) from
  `assistant.roundNames()` (lib/round-tree-names.js), and public/app.js:4151 `treeTitleOf` reads
  `row.round.display` for the TITLE. What the nesting never reads is the round record: the indent
  comes only from `row.branch`, `row.parent` and `row.parentSource`.
- Ruled out any need to touch source for this row. Nothing was edited except this file.

## What should happen next

The mechanism is correct and is proved twice: by the repo's own test, and by this live board,
where the round draws top level and both stage trees compute one indent under it. No fix is owed
and no follow-up defect arises from this conclusion.

Two things a later round could pick up, neither required by this task:

1. The window the probe observed, 03:12:26Z to 03:14:05Z, is real: a round's parent tree is cut
   by `makeWorktree` and adopted by nothing, because `adoptWorktree` is driven by a job's tree
   (server.js:814) and the round's parent tree runs no worker. Its row arrives with the next
   discovery pass (lib/scheduler.js:1050-1055), and until its branch is scanned `byBranch` has no
   entry for it, so stage rows draw top level for a minute or two. If that flicker matters, the
   round's cut is the place to adopt it; it is a display latency, not a nesting defect.
2. docs/task-pipeline.md describes the round model but does not name this attribute pair
   (`data-parent-key`, `data-depth`, `--child-depth`), so a reader of the doc alone cannot tell
   how the indent is produced. If that doc is edited next, one sentence naming
   public/render-projects.js `paintRowGroup` and public/chart.css:186 would close the gap.

Handoff note, not a defect: this brief's INPUTS block names branch
`wtgui/rung-7-round-a-live-round-beside-main-8a6f35`, which is the round's PARENT branch; this
tree is on `wtgui/rung-7-round-a-live-round-beside-main-stage-2-conclude-841df7`, and that is the
branch the commit for this stage went to, as the landing note declares.

No push and no pull request: the artifact a later stage reads is this file in this tree, committed
as one revertable commit on the stage's own branch.
