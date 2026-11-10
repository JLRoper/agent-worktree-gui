# Rung 7: a live round beside main - stage 1 probe

Worktree: .worktrees/rung-7-round-a-live-round-beside-main-stage-1-probe-5000ca (repo-relative)
Branch: wtgui/rung-7-round-a-live-round-beside-main-stage-1-probe-5000ca
HEAD at probe time: 23fbe197 (docs: render the changelog - 529 releases)
Working tree: clean (git status --porcelain printed nothing)

Queue task #62 "Rung 7 round: a live round beside main", pipeline investigate, stage probe,
state running. The board process answering /api/state is the live panel at 127.0.0.1:7331.

## What was asked

Read `roundOf` in lib/task-pipeline-drive.js and the row builder plus the child indent in
public/render-projects.js, list the `pipelineRun.round` fields and the DOM attributes
(`data-parent-key`, `data-depth`) that make a round a top-level row with its stage trees one
indent under it, and say where each is written. No source edit, no push, no pull request.

## Commands run and exact output

### Command 1 - the tree this probe runs in

    git rev-parse --abbrev-ref HEAD && git rev-parse --short HEAD && git status --porcelain && git log --oneline -1

Output:

    wtgui/rung-7-round-a-live-round-beside-main-stage-1-probe-5000ca
    23fbe197
    23fbe197 docs: render the changelog - 529 releases

(`git status --porcelain` printed nothing between the short sha and the log line.)

### Command 2 - the live record the queue holds for the round

    node -e 'read queue.json for task 62 and print pipelineRun.round and pipelineRun.trees'

The queue file is C:/Users/roper/.wag/state/assistants/assistant-3/queue.json. Output:

    == queue task 62 ==
    id 62 state running pipeline investigate stage probe
    pipelineRun.round:
      parentPath = C:/ProjectDevelopment/agent-worktree-gui/.worktrees/rung-7-round-a-live-round-beside-main-8a6f35
      parent = wtgui/rung-7-round-a-live-round-beside-main-8a6f35
      slug = rung-7-round-a-live-round-beside-main
      tag = 8a6f35
      base = origin/main
      sha = 23fbe1974b89420c3357add805760673b2754959
      display = Rung 7 round: a live round beside main
      at = 2026-11-10T03:10:33.397Z
      by = panel
    pipelineRun.trees:
      probe = path C:/ProjectDevelopment/agent-worktree-gui/.worktrees/rung-7-round-a-live-round-beside-main-stage-1-probe-5000ca | branch wtgui/rung-7-round-a-live-round-beside-main-stage-1-probe-5000ca | parent wtgui/rung-7-round-a-live-round-beside-main-8a6f35

### Command 3 - the grouping the page computes from the live rows

A script at C:/Users/roper/AppData/Local/Temp/wag/df5b258c/probe-round.mjs fetches
http://127.0.0.1:7331/api/state and applies the same three steps as `childTreeOf` and
`groupCtxOf` (byBranch over rows with a branch, parentOf from `row.parent`, then depth up the
parentOf chain), printing what `paintRowGroup` would write. Output:

    == /api/state ==
    generatedAt 2026-11-10T03:14:46.445Z | project agent-worktree-gui | rows 86 | parent links 17
    row rung-7-round-a-live-round-beside-main-8a6f35
      branch wtgui/rung-7-round-a-live-round-beside-main-8a6f35 | row.parent null | parentSource unknown
      groupCtxOf -> parentKey null, depth 0 -> no data-parent-key, no data-depth (top-level)
    row rung-7-round-a-live-round-beside-main-stage-1-probe-5000ca
      branch wtgui/rung-7-round-a-live-round-beside-main-stage-1-probe-5000ca | row.parent wtgui/rung-7-round-a-live-round-beside-main-8a6f35 | parentSource cut
      groupCtxOf -> parentKey "agent-worktree-gui::C:/ProjectDevelopment/agent-worktree-gui/.worktrees/rung-7-round-a-live-round-beside-main-8a6f35", depth 1 -> data-depth="1", --child-depth 1

The same script run at 2026-11-10T03:13:31.021Z, about a minute after the round's parent tree
was cut, found the round's row already in the list but with no branch yet (`branch undefined`,
a row added before its first scan) and therefore no parent link: the stage row printed as
top-level. By 03:14:05 the row had been scanned, its branch was the round's branch, and the
stage row resolved to `data-depth="1"`. The two snapshots bracket the first scan of the round's
own row: the indent appears when that row's branch is read, not when the stage tree is cut.

### Command 4 - the repo's own proof of both halves

    node --test test/chart-nesting.test.js

Output (tail):

    ✔ a live round's parent draws beside main, and its two stage trees hang under the round (2483.6444ms)
    ✔ an empty treenames map still paints a round's own names, not the directory (0.3789ms)
    ...
    ℹ tests 5
    ℹ pass 5
    ℹ fail 0

That file cuts a real round from a real `origin/main` through `Assistant.cutPipelineTree` and
`Jobs.makeWorktree`, reads `ParentBook` records, then runs the page's own `childTreeOf`,
`groupCtxOf` and `nestRowKeys` (sliced out of public/render-projects.js) over those rows. Its
assertions are the ones this probe was asked to name: `tree.parentOf.get(roundKey)` is
undefined ("the round is a top-level row, BESIDE main"), `childrenOf` of main is empty, both
stage keys map to `roundKey`, `groupCtxOf(roundKey)` is `{ parentKey: null, depth: 0,
childCount: 2 }`, and `groupCtxOf(d1Key)` is `{ parentKey: roundKey, depth: 1 }`.

### Command 5 - the round record's own module

    node --test test/task-pipeline-drive.test.js

Output (tail):

    ✔ a finished round asks for ONE assembly, in visit order, and is not finished on that pass (134.6195ms)
    ✔ once the assembly is recorded the round finishes, and a second assembly is never asked for (200.2843ms)
    ✔ a stage in its OWN tree never lands by itself: its branch is assembled, not pushed (125.6318ms)
    ℹ tests 47
    ℹ pass 47
    ℹ fail 0

## `pipelineRun.round` fields and where each is written

The record's shape is documented at lib/task-pipeline-drive.js:1182 and returned by `roundOf`
(lib/task-pipeline-drive.js:1195-1205), which normalises every field to text or null and returns
null unless at least one of `parent`, `sha`, `parentPath` is present:

| field | meaning | written at |
| --- | --- | --- |
| `parentPath` | the round's parent worktree, `.worktrees/<slug>-<tag>`; the directory the assembly lands in | lib/assistant.js:1693, from `root.path` of the cut at :1687 |
| `parent` | the round's branch, `wtgui/<slug>-<tag>`; the branch every stage tree is cut from and the branch the landing step pushes | lib/assistant.js:1693, from `root.branch` |
| `slug` | the task slug the names are built from | lib/assistant.js:1693, from `roundNameOf` |
| `tag` | the six-character tag that makes the directory and branch unique | lib/assistant.js:1693 |
| `base` | the ref the parent tree was cut from (`origin/main`) | lib/assistant.js:1693, from `root.startRef` (the `remote: "main"` passed at :1687) |
| `sha` | the COMMIT that ref resolved to at the cut; frozen so a later landing on origin/main cannot reach this round | lib/assistant.js:1693, from `root.startSha` or the tree's HEAD |
| `display` | the row title, "Rung 7 round: a live round beside main" | lib/assistant.js:1693 |
| `at` | the cut time | lib/assistant.js:1693 |
| `by` | who cut it (`panel`) | lib/assistant.js:1693 |

The record is written once, at the round's first cut, and kept on every later cut:
lib/assistant.js:1738-1746 (`keptRound` keeps `freshRun.round` and only falls back to
`legacyRound`). `roundOf` is read by the driver for the cut and the assembly (for example
lib/task-pipeline-drive.js:1227, :1321, :2359), not by the renderer.

## What makes the row top-level, and what makes the stage rows one indent under it

The renderer never reads `pipelineRun.round`. It draws from three row fields: `branch`,
`parent` and `parentSource`, plus the row key `${project}::${path}`.

1. The round's parent tree is cut with `round: true` and `remote: "main"`
   (lib/assistant.js:1687). In `Jobs.makeWorktree` that nulls the chart parent:
   lib/jobs.js:2667 `const named = branchNameOf(parent) || (round ? null : branchNameOf(start.ref))`,
   so `named` is null for a round. lib/jobs.js:2731 then records it with `parentName: null` and
   `refNamesLocalBranch: !start.remote` (false, because the ref is origin/main).
2. `ParentBook.record` (lib/parents.js:278-291) sets
   `parent = named && !sha ? named : refNamesLocalBranch && ref && !isMainName(ref) ? ref : null`
   (line 281). With no `named`, a remote ref and `refNamesLocalBranch: false`, `parent` is null
   and `parentSource` is "unknown" - a remote-tracking ref is never a roll-up target. The
   comment at lib/parents.js:275-277 states the intent: the round's parent tree draws BESIDE
   the checkout's main row. `rowsFor` (:322-331) hands that record to the scan worker.
3. `lib/scan.js:187-194` matches the record to the row by path then branch (`parentFor`) and
   writes `row.parent`, `row.parentSha`, `row.parentSource`. The live row shows exactly that:
   `row.parent null | parentSource unknown`.
4. The stage tree is cut with `from: round.parent` and `parent: round.parent`
   (lib/assistant.js:1705-1711), so `named` is the round's branch (a local branch), and
   `ParentBook.record` writes `parent: "wtgui/...-8a6f35"`, `parentSource: "cut"`. Every stage
   row therefore carries the round's branch in `row.parent`. The same fact is also recorded on
   `pipelineRun.trees[stage].parent` (lib/assistant.js:1723), but the chart does not read that
   field.
5. On the page, `childTreeOf` (public/render-projects.js:411-446) builds `byBranch` from every
   row with a branch and `parentOf` from every row with a `parent` whose branch is another row's
   `branch`. `groupCtxOf` (:451-468) turns that into `parentKey` (the parent row's key, only
   while that row is drawn) and `depth` (one per level up). `nestRowKeys` (:470-494) puts the
   children directly under their parent in drawing order.
6. `rowHtml` (:615-706) builds the row as
   `<tr class="row" data-key="${project}::${path}">` (:703) and leaves `data-parent-key`,
   `data-depth` alone. `paintRowGroup` (:531-566) is the only writer of the two: for a child it
   sets `tr.dataset.parentKey` (:539), `tr.dataset.depth` (:541) and the CSS variable
   `--child-depth` (:542), plus the `is-child` class and the leading tick (:533, :551-553); for a
   top-level row it REMOVES `data-parent-key`, deletes `data-depth` and removes `--child-depth`
   (:543-546). `paintUnder` (:570-575) copies `data-parent-key` onto the row's detail, question
   and offer nodes so one selector can hide a whole group.
7. The indent itself is CSS: public/chart.css:186
   `#projects tbody tr.row.is-child > td.name { padding-left: calc(12px + 16px * var(--child-depth, 1)); }`,
   with :187 removing the rail glyph on a child and :191 hiding a folded group.

So the attribute pair is the output of a two-step join, not a field the server sends: the round
has `row.parent: null` and therefore no `data-parent-key` and no `data-depth` (top-level, beside
main), and each stage tree has `row.parent = <round branch>` and therefore
`data-parent-key = "agent-worktree-gui::<round parent path>"` and `data-depth = "1"`.

## The one paragraph

The chart reads `pipelineRun.round` only to know a round exists and what it was cut from -
`parentPath`, `parent`, `slug`, `tag`, `base`, `sha`, `display`, `at`, `by`, all nine written
together at lib/assistant.js:1693 from the parent-tree cut at :1687 and kept unchanged at
:1738-1746 - but the picture it draws comes from the row's `branch` and `parent` fields:
`Jobs.makeWorktree` nulls the chart parent for a `round: true` cut (lib/jobs.js:2667), so
`ParentBook.record` stores `parent: null`, `parentSource: "unknown"`, `parentRef: "origin/main"`
for the round (lib/parents.js:281), while each stage cut names the round's branch as its
`parentName` (lib/assistant.js:1705-1711), which the same book stores as `parent: <round
branch>`, `parentSource: "cut"`; `lib/scan.js:187-194` copies that onto each row, and
`childTreeOf` / `groupCtxOf` in public/render-projects.js (:411-468) join child to parent by
branch, so the round row gets `parentKey: null, depth: 0` and its stage rows get
`parentKey: <round row key>, depth: 1`; `paintRowGroup` (:531-546) is the sole writer of
`data-parent-key` and `data-depth`, which it removes from the top-level round and sets from
`ctx.parentKey` / `ctx.depth` on each stage row, with the visible indent coming from
`--child-depth` (:542) read by public/chart.css:186.

## State observed, and one thing that matters for the next stage

At 03:12:26Z the round's parent row was not yet in /api/state; at 03:13:31 it was present but
unscanned (`branch undefined`), and by 03:14:05 it had a branch and the stage row nested. Nothing adopts the round's parent tree when
it is cut: `adoptWorktree` (lib/scheduler.js:1094-1125) is called for a JOB's tree
(server.js:797-814), and the round's parent tree runs no job, so its row arrives only with the
next discovery/reconcile pass (lib/scheduler.js:1050-1055). For that window the stage rows draw
top-level because `byBranch` has no row carrying the round's branch. The code path the stage
was asked about is correct - test/chart-nesting.test.js proves it end to end and passes - but
the live board shows the round beside main only after that pass.

No source file was edited by this stage. The only change is this evidence file, committed as
one revertable commit on this branch; nothing was pushed and no pull request was opened.
