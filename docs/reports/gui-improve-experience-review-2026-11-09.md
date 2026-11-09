# The gui-improve recommendations, judged against main

`docs/reports/gui-improve-experience-2026-11-09.html` (last touched at `d4f8217e`) ranks seven improvements to the `gui-improve` pipeline, all measured on row #256. This review reads those seven against the tree at `5ed7f604` and against the ledger the walk left on main, and keeps what still describes a gap. It changes no code, runs no test, and pushes nothing.

## Verdict

All seven still name something. Four survive as written (report items 2, 3, 5 and 6). Two survive in reduced form: the implement stage no longer asks for a capture (item 4), and the stage-run ledger now has an attempt slot (item 7). One keeps only its mechanism half: the change item 1 said never landed is on main, so what remains is the document's missing terminal stage.

The report's number 1 loses its first place on evidence, not on argument. `public/style.css:502` carries the accepted `:where(#settings-panel-general) .settings-presets` rule, and commit `7bc1cb56`, which carries the walk's ledger and the two CSS rules, is an ancestor of main through PR #660 (merge `d9c561bd`, 2026-11-09T16:29:12Z), on the same branch the walk ran in. The report's `main:public/style.css:438 is still the flex rule` was true at 06:05:52; by 16:29 it was not.

| report # | improvement | status | the fact that decides it |
| --- | --- | --- | --- |
| 1 | Land in the pipeline | survives, evidence expired | the walk's change is on main; the document still has no stage that lands |
| 2 | Script the objective half of G3 | survives | `verified_by` is parsed and drawn, never executed |
| 3 | Capture for the diff, not the archive | survives | the baseline prompt still asks for a full-page shot |
| 4 | Let compare own the only after set | half survives | no prompt asks for a capture, but two after sets are committed |
| 5 | Settle on the decision file | survives | a running row is skipped while its thread is live |
| 6 | Put the reviewer's invariants into G2 | survives | the compare record holds the numbers; the gate holds no check |
| 7 | Record the attempt, not just the commit | survives, reduced | an attempt id exists for a restart, not for a retry inside one run |

## What changed in main since the report

| the report said | main at `5ed7f604` holds |
| --- | --- |
| `main:public/style.css:438` is still the flex rule | line 438 now sits inside the board's settings block; the base flex rule is line 494 and the accepted grid override is line 502 |
| `git branch --contains d38413d` lists only the wtgui branch | `7bc1cb56`, the commit that carries the change-set and its ledger, is contained by main |
| two accepted walks, zero lines on main | one accepted walk has landed; both rounds' ledgers are committed |
| the ledger is 24.4 MB, 75 files | `ledger/gui-improve` is 34,238,720 bytes across 145 files, because the second round's ledger joined the first |
| `{baseline:1, implement:1, compare:1, review:1}` cannot see rework | `stageRunId` mints `<pipeline>/<stage>#<visit>.<attempt>` for a second start of a visit (`lib/task-pipeline.js:232-258`) |

## The survivors, ranked

Ranked by value per unit of work: the waste the walk measured first, then the defect class the gates let through, then record fidelity. The report ranked by raw saving alone; this order moves item 6 up because the data it needs is already recorded and the change is two booleans, and moves item 1 down because its evidence expired.

| rank | report # | improvement | size | evidence in this tree | what it buys now |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | Preflight the objective half of G3 | M | `verified_by` is parsed at `lib/pipeline-bundle.js:363-364` and drawn at `tools/render-pipeline-map.mjs:139`; nothing executes it | 10m43.6s and 2,289,845 tokens per accepted walk, less the reading the reviewer still has to do |
| 2 | 1 | A terminal stage that lands | S-M | G3's `accept` routes to `null`; no stage declares `kind: "pr"`; the driver understands it (`lib/task-pipeline-drive.js:144,153,2377`) and the seed ships `push` and `pr` stages (`pipeline-bundle.seed.json:3839-3880`) | no accepted walk ends in a hand landing, and the row stops closing `done` with the work unlanded |
| 3 | 3 | Capture the surface, not the archive | S | the baseline prompt still says "record a full-page shot"; the committed baseline is 14,680,400 bytes, of which six full-page PNGs are 11,910,949 and six surface PNGs are 141,245 | about 11.9 MB per baseline, and part of the baseline's 22m14.2s |
| 4 | 6 | Height and clip as G2 invariants | S | `comparison.json` records `panel.h` 453.0625 to 447.0625 and the strip/body numbers; `summary.integrity` has no height or clip boolean | a reject round trip (three stage visits), and the defect class G2 passed in the proof run |
| 5 | 4 | One after set | S | the implement prompt asks for no capture, but main carries two: `after/` 18 files, 4,106,785 bytes, and `compare/after/` 16 files, 3,480,174, with `css.json` identical at 1,850,262 in both | about 4.1 MB per run, and part of the implement stage's 13m48.4s |
| 6 | 5 | Settle on the decision file | M-L | a running row is skipped while its thread is live (`lib/task-pipeline-drive.js:1973`); a decision file is read only for a parked row | 3m18.9s per walk, 4.6% of it |
| 7 | 7 | Record the attempt | M | the id slot exists (`lib/task-pipeline.js:232-258`), but `visits` still counts stage entries (`:470`, `:501`) | record fidelity: "right first time" becomes distinguishable from "fixed before anyone looked" |

### 1. Preflight the objective half of G3 (report item 2)

The review stage cost 10m43.6s, 2,289,845 tokens and 22,192 output for two files and 16 inserted lines. Five of its eight checked items restate values `comparison.json` already carries, one checks the comparison page's own sections, one re-runs compare's test command, and one, the patch round trip, is genuinely new. The panel cannot run the machine half today: `verified_by` is a string the bundle parser keeps and the pipeline map draws, and a gate is crossed only by the decision record its seat writes. This is new machinery, not a prompt change: a preflight that reads the stage's declared artifact, evaluates the checks the gate lists, and refuses to spawn the reviewer on a failure.

Keep the reviewer. The proof run is the case where the seat beat the machine: G2 passed 44 of 44 checks and G3 rejected the same change for growing the panel 20 px.

First move: add a `checks` list to the gate schema and a runner in the drive that writes the machine half of `review-verdict.json`; the reviewer reads that record and decides.

### 2. A terminal stage that lands (report item 1)

The report's facts are expired, its mechanism gap is not. G3's `accept` routes to `null`; none of the five stages declares `kind: "pr"`; and the driver already knows what that kind means. `PR_ARTIFACT_KIND` is `"pr"` (`lib/task-pipeline-drive.js:144`), `landsAsPr` reads it (`:153`), and a stage that declares it is handed the landing paragraph and pushes (`:2377`). The seed's `turnover` and `github-force-merge` documents already ship `push` and `pr` stages whose artifacts are `kind: "pr"` (`pipeline-bundle.seed.json:3839-3880`), so the edit is two shipped prompts plus one route.

The conservative shape is a `push` stage and a `pr` stage that open the PR and do not merge. The row then waits on the landing rule, which requires the PR to read MERGED (`lib/assistant/queue.js:1504-1510`), so the merge stays a person's act and the row reads running/STALE until it happens. The alternative, a final stage that runs `node tools/land-pr.mjs`, closes the row by itself and merges without a person. This plan does not recommend it; one-off landings of named branches are #263's job, not the document's.

First move: add the two stages to the document, route `accept` to the push stage, import it, and walk one change to see the row end on MERGED rather than on the review verdict.

### 3. Capture the surface, not the archive (report item 3)

The baseline prompt still asks for "a full-page shot" for every viewport and state. On main that costs 14,680,400 bytes for the committed baseline: six full-page PNGs at 1.93 to 2.04 MB each, 11,910,949 bytes together, against 141,245 bytes for the six 340x520 surface shots. The comparison also shows why the archive cannot be diffed: `pairs[0].before.fullPage` is 1440x15859 while `pairs[0].after.fullPage` is 1440x900, and `comparison.json` says the full-page record "is not pixel-comparable" while the surface file is "the stable pair to diff".

First move: change the baseline prompt to name the surface shot as the required pair, and allow a full-page shot only at a fixed content height, or drop it. The capture script is written per round by the worker, so the prompt is the lever.

### 4. Height and clip as G2 invariants (report item 6)

The compare stage already records the arithmetic a height budget needs. `pairs[0].before.panel.h` is 453.0625 and `pairs[0].after.panel.h` is 447.0625; the verdict reasons already say "General panel content height 453.06 -> 447.06 px" and "last strip bottom vs the body's visible bottom: 598...". `summary.integrity` holds `controlsIntact`, `noNewOverflow`, `minFontNotSmaller` and four counts, and G2's `verified_by` is prose. Nothing checks the two numbers, so the defect class the proof run rejected would pass again.

First move: add `panelHeightNotGrown` and `stripWithinWindow` to `summary.integrity`, computed from fields already in each pair, and require both in G2. This is two booleans and one prompt line once rank 1's runner exists; without the runner it is a document requirement that nothing enforces.

### 5. One after set (report item 4)

The document no longer asks the implement stage for a capture, so the doc-level fault is gone. The waste is still committed: `general-presets/after/` has 18 files and 4,106,785 bytes, `general-presets/compare/after/` has 16 files and 3,480,174 bytes, and `css.json` is identical at 1,850,262 bytes in both. No later stage reads the first set; the compare record's `inputs.after` points at its own.

First move: one sentence in the implement prompt ("do not commit a capture; compare owns the after set") and delete the duplicate from the ledger. If the implement worker still wants a smoke check, let it assert that the panel opens with no console error and write no shots.

### 6. Settle on the decision file (report item 5)

The driver advances a running row only after its thread is no longer live: `if (!thread || isLive(thread)) continue;` (`lib/task-pipeline-drive.js:1973`). A gate's decision file is read for a parked row, never for a running one, so review's verdict at 06:03:39 waited for the job to end at 06:05:52, and compare's at 05:54:03 waited until 05:55:08.

First move: watch the current stage run's decision path while the stage is running and settle it when a valid record appears. The risk is real: a worker can write its verdict before its last commit, and settling then would pin the handoff to a commit that is about to move. The settle must read the tree's commit at the decision, and a commit after it must be refused or recorded as a second attempt.

### 7. Record the attempt (report item 7)

The report's claim was that visits count commits, not attempts. That is still true of `visits` (`lib/task-pipeline.js:470`, `:501`), but the ledger now has an attempt slot: `stageRunId` mints `<pipeline>/<stage>#<visit>.<attempt>` for a second start of the same visit (`:232-258`), and `beginStageRun` uses it. What is still invisible is a retry inside one run, like the implement stage finding and fixing the search-filter paint bug before committing. That is not a second start, so no attempt is minted.

First move: have the stage artifact carry an `attempts` count or a retry log, and show it beside the visit count. This is a worker contract plus a render, not a new table.

## Judged and not carried

Two observations in the report's section 5 are not ranked above. The 27m53.9s before the first stage has no recorded cause and no recommendation attached, so there is nothing to plan. The `APPLIED in this tree` status line in `change-set.patch` is still there, but `.gitattributes:22` now keeps `ledger/**/*.patch` untranslated so the patch applies from a checkout. The 24.4 MB of evidence is covered by ranks 3 and 5.

## Dedupe: #262 and #263

#262 is parked on #260's thread and asks for `docs/reports/gui-improve-board-2026-11-09.html`: the rounds' measured changes, the pros and cons, a ranked improvement list for #260, and a judgement of the per-stage worktree model with #256 as the control. This file is not that page. It ranks the recommendations of the #256 report against main, re-measures no round, and does not judge the worktree model. If #262 wants the #256 items in its ranking, this file is the input; #262 still owns #260's evidence and its own deliverable.

#263 is parked on the same thread and lands named unlanded branches through `land:pr`: #256's two commits, #257's five, #339's PR #625, #340's three, and #260's when it exists. Rank 2 is a document change, not a landing run: it pushes no branch and opens no PR. #263's list is also shorter than when it was written, because #256's branch is merged in PR #660, so its first item is already done.

## Before rank 1: the document is not in this repo

`pipeline-bundle.seed.json` holds 11 pipelines and none of them is `gui-improve`. The live bundle at `~/.wag/state/pipeline-bundle.json` holds 12 and includes it. The document is written through the import route (`server.js:144`, `lib/pipeline-bundle-import.js`); `tools/repair-pipeline-bundle.mjs` can also write the file, but only to copy gate routes from the seed. Every item that edits the document (ranks 1, 2, 3, 4, 5 and 7) is therefore a state edit that no test or review in this repository sees.

First move: put the edited document in the seed, or commit it as a document file, before the first change. Otherwise the plan's main lever lives outside version control and a state reset erases it.

## What this plan does not claim

- Costs are #256's own record at `d38413d`, not re-measured here. Line numbers are from `5ed7f604`.
- The rank 1 saving is an upper bound. The record cannot separate the reviewer's reading from its re-derivation; scripting five checks removes the re-derivation, not the reading.
- Rank 2 adds a stage turn to every walk. What it buys is the end of the hand landing, not a shorter walk.
- The merge question is not decided. Rank 2 recommends push and PR only; a pipeline that merges its own PR is a doctrine change, not an implementation detail.
