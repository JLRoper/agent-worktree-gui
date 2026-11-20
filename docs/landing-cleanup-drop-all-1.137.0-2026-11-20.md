# Landing: a drop-all-suggested button that drops only the rows labelled drop (1.137.0)

The cleanup chip reads a project and prints one row per worktree with a keep-or-drop call on it. This landing adds
the one control the row asked for: `drop all 41 suggested`, beside the chip, which removes exactly the rows labelled
`drop` and never a merge, keep, left-alone or unlabelled row. The count is read from the plan, the confirm names the
count and what it will not touch, and the run re-reads the plan before its first removal, so a tree that changed
between the plan and the press is refused by the planner's own rule rather than forced.

## What landed

- `public/core/cleanup-drop-all.js` - the whole selection, as functions with names: the predicate
  (`isDropSuggested`, line 66), the count and label on the button (`dropAllCount`, `dropAllLabel`, line 113), the
  disabled rule (`dropAllDisabled`, line 132), the confirm's sentence (`dropAllConfirmText`, line 143), the plan
  re-checked at press time (`confirmAgainstFresh`, line 172) and the loop (`runDropAll`, line 221). No DOM and no
  network, so the page and `test/cleanup-drop-all.test.js` run the same file.
- `public/board-scaffold.js:1095` - the drop-all region: the button renderer (line 1127, drawn in the head line and
  in the bar from one function), `refreshCleanupUi` (line 1155, the chip and the button repainted together),
  the confirm and failure list (line 1161), the single-row drop as one call (line 1210), the plan read
  (line 1224) and the run (line 1235). The chip gained a `dropping` phase in the same file.
- `public/app.js:10845` - the three routes: the button opens the confirm, the confirm's own button runs the drops,
  cancel writes nothing; Escape closes an open confirm before any other Escape gesture reads it.
- `public/render-projects.js:387` - the button in the head line, immediately before the cleanup chip, which stays
  the last pill of the line.
- `public/index.html:1447`, `public/style.css:3851` - the script tag before `board-scaffold.js`, and the pill, the
  confirm and the failure list's own rules.
- `docs/using-the-board.md:355` - the page's own words for the control.
- `test/cleanup-drop-all.test.js` and `test/e2e/cleanup-drop-all.spec.mjs`, with
  `package.json:153` naming the gate as a script.

## The selection is a predicate, not a selector

A row is acted on only when it carries the label `drop` **and** the plan's verdict is `remove`
(`public/core/cleanup-drop-all.js:66`). Both, because the label is what the reader sees and the verdict is what the
plan meant: a row where the two disagree is a row nothing should act on. The unit tests ask that function by name
for every class, including the disagreements (`a drop call over a merge verdict is not a drop`, `a remove verdict
with no drop label is not acted on either`), and one test asserts that no hand-rolled `=== "drop"` appears anywhere
in the drop-all region or in the click router, so the guard cannot drift into the handler.

The button's number is that predicate's count, which is why `drop all 4 suggested` in the gate is a claim the gate
checks against the plan's own four drop rows. At zero the label is `nothing to drop` and the button is disabled; it
is disabled too while a read, an apply or another drop-all runs (`public/board-scaffold.js:1131`).

## The confirm, and its arithmetic

The confirm states the count and every class it will not touch, built from the same rows:

    4 worktrees will be removed; 1 merge row, 1 keep row and 1 left-alone row are not touched.

A unit test asserts `dropAllCount + merge + keep + skip + unlabelled === rows.length` for four different plans, so
the sentence cannot drop a class or count one twice. Its own `drop 4` button is focused the moment it opens, which
is what makes the whole gesture reachable from the keyboard; Escape cancels it and removes nothing (the gate presses
Escape, checks the disk, then presses the button again).

## The press is the existing single-row drop, one row at a time

`cleanupDropOne` (`public/board-scaffold.js:1210`) posts `POST /api/worktree/delete` with the project, the path and
the branch, which is the same route the row's `x` and the bar's per-row `drop` use: the same locks, the same
live-job guards, the same history entry, and no forced removal anywhere. The bar's line reads
`dropping 12 of 41 - <tree>` while it runs, and the chip reads `cleanup: dropping 12 of 41`.

## The guard: the plan is read again before the first drop

The confirm may sit on screen for a minute, and a tree that was clean and landed when the plan was printed can pick
up a commit or an uncommitted file. That is precisely what `lib/cleanup-plan.js` refuses to call drop, so the run
reads the project again and acts only where both reads agree (`public/core/cleanup-drop-all.js:172`). A planned drop
row the fresh read no longer calls drop is refused with the fresh plan's own sentence and listed; a row that only
the fresh read calls drop is **not** acted on, because the confirm named a count and removing a tree nobody confirmed
is the worse outcome. A refusal from the remover is collected the same way, and a refusal never stops the loop.

The gate proves this with a real race rather than a mock: one of the four drop trees is given an uncommitted file
after the plan is printed, and the run must refuse it by name.

## The gate

`test/e2e/cleanup-drop-all.spec.mjs`, headless at 1440x900, on a throwaway panel (`tools/panel-testkit.mjs`) and a
real fixture: four trees whose branches are ancestors of main (drop), one tree with a commit main lacks (merge), one
turnover branch (keep) and the primary checkout (skip). What it asserted:

- the button is in the head line immediately to the left of the cleanup chip, reads `drop all 4 suggested`, is the
  chip's own pill height, and the chip is still the last pill of the line;
- the confirm's sentence is exactly the one above, and `document.activeElement` is the confirm's own button;
- after the run, `dropped 3 of 4; 1 row was refused`, with one failure line naming `late` and quoting
  `its commits are in main but its tree holds uncommitted work (1 file)`;
- on disk: the three drop trees are gone and their branches are still there; the refused tree, its uncommitted file,
  the merge tree, the turnover tree and the primary checkout are all still there; no branch was merged
  (`refs/heads/cleanup/` is empty);
- on the board: the three rows are gone, the four remaining rows are there, and every non-drop row's badge reads what
  it read before the run (a comparison against the pre-run capture, not a re-reading);
- the bar's plan rows for the non-drop trees read the same verdict, the same call and the same reason as before;
- the button now reads `nothing to drop` and is disabled, and the chip reads `cleanup: 1 to merge · apply`;
- the page the post-run read wrote no longer lists the removed trees and its counts are the state after the run;
- nothing opened a window: the drop-all itself never posts to `/api/open-file` (the chip's own dry run does, and the
  count is recorded before the drop-all press so the assertion is about the button).

Screenshots at 1440x900, committed beside this note in `docs/reports/cleanup-drop-all-1.137.0/`:
`1-armed-1440x900.png` (the chip's plan printed, the button reading `drop all 4 suggested`),
`1b-head-line-with-button.png` (the head line, the button immediately left of the chip, the chip still the last pill),
`2-confirm-1440x900.png` (the confirm, its sentence and its focused `drop 4`) and
`3-after-1440x900.png` (after the run: `nothing to drop`, the refusal line naming `late`, the four rows still there).

## Tests

- `test/cleanup-drop-all.test.js` 9 of 9 - the predicate per class, the count and the disabled states, the confirm's
  arithmetic, the fresh check, the failure collection, the wiring, and no em or en dash in what the row ships.
- `test/cleanup-chip.test.js` 12 of 12 and `test/board-lookups.test.js` - the chip's own pinning, with the harnesses
  extended for the button beside it (the bar draws it, the strip repaints it through `refreshCleanupUi`).
- `test/absolute-paths.test.js` 17 of 17, and `node tools/absolute-paths.mjs` clean: the unit fixtures originally
  spelled their trees with a drive letter, which this repo refuses in a landing, and now use a drive-free shape.
- `test/e2e/cleanup-drop-all.spec.mjs` 2 of 2.
- `npm test` once, on the branch: the only failures were the two absolute-path tests above (mine, fixed before the
  push) and `test/assistant-carry-key.test.js` / `test/assistant-director.test.js`, which fail only when run in one
  invocation (a different test each time, each green alone, untouched by this change). The sweep did not finish
  inside the command budget; the four files it named were re-run on their own afterwards.

## Version and the release record

`1.137.0`, minor: a new user-facing control, nothing removed or renamed, and no behaviour change to the existing
chip, the per-row drop or the apply. `v1.134.0` was taken by another lane before this branch was landed, so the
rebase step minted the number above `origin/main` and the tag went with it. Node one on the commit that first
declares the number.

## Known limits, stated rather than hidden

- The confirm lives in the bar the chip opens, not in a modal: it is a question in the place the plan is printed,
  and it is closed by Escape, by cancel, or by its own answer.
- The count on the confirm can be older than the disk, which is what the re-read exists for; the reader sees the
  difference as a refusal line naming the tree and the planner's sentence, never as a silent removal.
- A tree that only the newer read calls drop waits for the next press, and the button's number after the run is the
  new plan's count, so that press is one more click, not a guess.
