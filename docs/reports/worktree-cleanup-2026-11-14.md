# Worktree sweep, 2026-11-14 - every tree, every unlanded commit, every dirty path

Base: `origin/main` `ee91431e61ccfdb307933995406b033bdca1c318`, read at the cut of
`wtgui/sweep-the-worktrees-judge-land-what-4a707d`. Twelve registered worktrees beside the primary checkout (the
project root, one level above `.worktrees/`), two empty directories under `.worktrees/` with no git entry at all, and no
live run in any of the twelve (`GET /api/jobs`, 89 jobs, four `running`, all four in other projects or in this run's
own tree). The counts in this document are the ones measured at that clock: `git worktree list --porcelain` plus one
`git rev-list --left-right --count origin/main...<tip>` and one `git status --porcelain` per tree.

Columns: **ahead** is commits not on `origin/main` (the right-hand number of the left-right count); **dirty** is
`git status --porcelain` entries, tracked modifications and untracked paths together.

## Every tree

| tree | branch | tip | ahead | dirty | verdict |
|---|---|---|---|---|---|
| add-generic-gui-pipeline-to-bundle-4c4680 | `wtgui/add-generic-gui-pipeline-to-bundle-4c4680` | `c3dd589c` | 0 | 1 | LANDED, tip on main (PR #733). Its one dirty path is a pre-landing capture ledger main already carries in its landed place - discard, remove the tree |
| add-per-project-landing-rules-the-carry-4cc45c | `wtgui/add-per-project-landing-rules-the-carry-4cc45c` | `4829d3cf` | 0 | 7 | LANDED tip (PR #733) but the seven dirty paths are per-project landing rules, absent from main - SALVAGE, lands in this PR |
| cut-branch-wtgui-aggregate-remainder-5650d5 | `wtgui/aggregate-remainder-2026-11-13` | `dbd627a4` | 9 | 0 | SUPERSEDED - PR #742 MERGED at this exact head, all nine commits patch-present on main |
| execute-aggregate-report-local-ref-87d11c | `wtgui/execute-aggregate-report-local-ref-87d11c` | `f025fa2c` | 0 | 0 | LANDED - the tip is itself a main commit (`f025fa2c` was `origin/main` when the leftovers report was measured). Remove |
| finish-the-two-leftovers-the-executed-227d97 | `wtgui/finish-the-two-leftovers-the-executed-227d97` | `193838bd` | 1 | 0 | ONE COMMIT MISSING - `docs/reports/local-refs-leftovers-2026-11-13.html` is absent from main. Lands in this PR |
| fix-the-refusal-that-parked-52-6974b3 | `wtgui/fix-the-refusal-that-parked-52-6974b3` | `b7971137` | 0 | 3 | LANDED tip (PR #733); the three dirty paths are SUPERSEDED - main landed the plan-side minimum and picks a single stage onto the parent tree by design (quoted below) |
| quiet-the-boot-stalls-2026-11-13 | `wtgui/quiet-the-boot-stalls-2026-11-13` | `bdeff6de` | 2 | 0 | SUPERSEDED - PR #747 MERGED at this exact head, both commits patch-present on main |
| retry-settings-write-on-slow-panel-48eeb8 | `wtgui/retry-settings-write-on-slow-panel-48eeb8` | `b7394d4c` | 0 | 2 | LANDED tip (PR #733); both dirty paths are SUPERSEDED by main's own `3b33c85c` (quoted below) |
| round-c-how-a-round-names-its-trees-stage-2-conclude-7ace4b | `wtgui/rung-2-row-starts-in-its-tree` | `0ca789b0` | 0 | 1 | LANDED - the tip is PR #687's merge commit, on main. Its one dirty path is a 618 KB PictureViewer document from another project - discard, remove the tree |
| run-github-landing-sanity-test-write-0472b0 | `wtgui/run-github-landing-sanity-test-write-0472b0` | `b1226087` | 0 | 1 | LANDED tip (PR #733). Its one dirty path is an older revision of a document main carries newer - discard, remove the tree |
| sweep-the-worktrees-judge-land-what-4a707d | `wtgui/sweep-the-worktrees-judge-land-what-4a707d` | `ee91431e` | 0 | 0 | this run's own tree - lands this sweep |
| two-changes-to-the-clarify-card-one-pr-33f806 | `wtgui/two-changes-to-the-clarify-card-one-pr-33f806` | `1cd6d5b1` | 5 | 2 | SUPERSEDED - PR #704 MERGED at this exact head, all five commits patch-present on main. Its two dirty paths are re-captured PNGs - discard, remove the tree |

Two directories are not worktrees and hold no commit: `.worktrees/draw-a-spawn-s-todos-as-category-bullets-e5adea` and
`.worktrees/pin-the-agent-card-s-conversation-a80b28`. Both are empty (`ls -a` prints nothing but `.` and `..`), carry
no `.git` file, and have no admin entry in `git worktree list`. They are half-removals left by an earlier sweep and are
deleted with `rmdir`, not `git worktree remove`.

## The four trees that hold commits not on main

`git cherry origin/main <branch>` prints `-` for a commit whose patch main already carries, so a `-` per commit is the
measurement; the main commit named beside each one is the landing that carries it.

### `wtgui/aggregate-remainder-2026-11-13` (`dbd627a4`, 9 ahead) - SUPERSEDED

PR #742 MERGED with `headRefOid` `dbd627a44daa5b3a3728313206be92f2cbde7f8a`, the tree's own tip, and its merge commit
is `e1f8edb8`. Nine of nine commits read `-` (patch-present). Each has a main commit that says the same thing:

| branch commit | main commit that carries it |
|---|---|
| `dbd627a4` docs: the worktree table names a superseding line on every row | `e1f8edb8` docs: the worktree table names a superseding line on every row |
| `bcfc244c` docs: every row of the remainder report carries a superseding line | `51ed0a03` docs: every row of the remainder report carries a superseding line |
| `6bb24385` docs: the remainder report corrects the patch-apply count | `49eec3ac` docs: the remainder report corrects the patch-apply count |
| `3f0e2a50` docs: the remainder report carries the final commit list | `6fb1cc7f` docs: the remainder report carries the final commit list |
| `58fe69d8` fix: the jitter tool names no absolute path | `7dd49afd` fix: the jitter tool names no absolute path |
| `a48623fd` docs: the remainder report records the suite comparison | `7a1c73e4` docs: the remainder report records the suite comparison |
| `be20c0f0` chore: 1.94.0 - the version this landing carries | `670463df` chore: 1.94.0 - the version this landing carries |
| `1f16137b` docs: the remainder report - 167 branches and 33 worktrees judged by content | `59635bfd` docs: the remainder report - 167 branches and 33 worktrees judged by content |
| `e3e67edb` Count the console's row churn per second while a stream is flowing | `d5c7fe24` Count the console's row churn per second while a stream is flowing |

### `wtgui/finish-the-two-leftovers-the-executed-227d97` (`193838bd`, 1 ahead) - MISSING

`git cherry` prints `+` for it and no PR names that head. `git cat-file -e origin/main:docs/reports/local-refs-leftovers-2026-11-13.html`
answers `fatal: path ... does not exist in 'origin/main'`. The document records a destructive pass that is otherwise
undocumented: one tree removed after `git worktree unlock`, ten orphan branch refs deleted after each tip tested as an
ancestor of `origin/main`, 88 local branches before and after, 13 to 12 registered worktrees, 382 origin heads before
and after. Main carries the two other reports in that family (`worktree-board-cleanup-2026-11-11.html`,
`worktree-aggregate-2026-11-13.html`) and not this one. It lands here, verbatim from `193838bd`.

### `wtgui/quiet-the-boot-stalls-2026-11-13` (`bdeff6de`, 2 ahead) - SUPERSEDED

PR #747 MERGED with `headRefOid` `bdeff6dec459a56118ea35a3d65209753bf89bf5` and merge commit `b2371013`. Both commits
read `-`: `bdeff6de` chore: 1.96.2 -> `b2371013`, and `a7cb0779` fix: yield to the loop while a pass boards a project's
trees -> `88e7a599` with the same subject. `lib/scheduler.js` on main carries the yield.

### `wtgui/two-changes-to-the-clarify-card-one-pr-33f806` (`1cd6d5b1`, 5 ahead) - SUPERSEDED

PR #704 MERGED with `headRefOid` `1cd6d5b147be9a39a108ae8a583ae2d25b1f8f78` and merge commit `29615610`. Five of five
commits read `-`:

| branch commit | main commit that carries it |
|---|---|
| `1cd6d5b1` chore: take the machine's paths out of the lines the gate refused | `29615610` chore: take the machine's paths out of the lines the gate refused |
| `c85e8a57` chore: 1.82.0 - the version this landing carries | `a4f6494e` chore: 1.82.0 - the version this landing carries |
| `5dbc79be` docs: the two clarify-card changes, with the captures | `295df2de` docs: the two clarify-card changes, with the captures |
| `fd85050c` feat(clarify): give a question links, and link the paths in its text | `f4624377` feat(clarify): give a question links, and link the paths in its text |
| `9a7b2f5f` fix(clarify): keep the caret and the selection across a card repaint | `6d79eb6c` fix(clarify): keep the caret and the selection across a card repaint |

## The dirt in the landed trees, path by path

| tree | path | main's state | decision |
|---|---|---|---|
| add-generic-gui-pipeline-to-bundle-4c4680 | `ledger/gui-improve/` (38 untracked files) | main carries the same run's evidence as `ledger/gui-improve/general-presets/` (75 files), and its `change-set.patch` is the corrected, longer version of this one | DISCARD - a pre-landing staging copy whose landed form is on main. The four text files are copied to `<tmp>/wag/77395884/salvage/add-generic-gui-pipeline-to-bundle-4c4680/` as insurance |
| add-per-project-landing-rules-the-carry-4cc45c | `lib/project-rules.js` (new, 119 lines), `test/project-landing-rules.test.js` (new), `lib/jobs.js` +15/-1, `lib/assistant.js` +11, `README.md` +1, `config.example.json` +4/-2 | `git grep landingRules origin/main` returns two hits, both prose in `docs/design/prompt-tiers-2026-11-08.md`; no code reads the field. That document says at line 623: "`projects[].landingRules` **in flight, uncommitted**: `lib/project-rules.js` in the sibling tree `add-per-project-landing-rules-the-carry-4cc45c` ... `git grep landingRules` on main returns 0" | SALVAGE - re-implemented on main's structure in this PR as `lib/project-landing-rules.js` (main's `lib/project-rules.js` is a different feature, `projects[].rules`) |
| add-per-project-landing-rules-the-carry-4cc45c | `package.json` 1.59.3 -> 1.60.0 | main is at 1.100.0 | DISCARD - the tree's own bump; this PR carries its own number |
| fix-the-refusal-that-parked-52-6974b3 | `lib/pipeline-assembly.js` +81 (a single stage fast-forwarded instead of cherry-picked), `lib/assistant.js` +21/-6, `test/pipeline-assembly.test.js` +133 | main landed the plan-side half in `62b0a715` (`const minimum = round.parentPath ? 1 : 2;`, `lib/task-pipeline-drive.js:1419`) and `lib/assistant.js:2009` reads the same minimum. For the fast-forward half main chose the other design and pinned it: `test/pipeline-assembly.test.js:177` - "A round with a PARENT TREE is the exception ... the branch that lands is the round's own, not the single stage's, so that one commit must be picked onto it", and `docs/task-pipeline.md:464` - "that stage's branch is not the landing branch, so its commit is picked onto the parent tree like any other" | DISCARD - SUPERSEDED, not missing: the refusal that parked #52 is fixed on main, and the remaining hunk contradicts a landed test |
| retry-settings-write-on-slow-panel-48eeb8 | `public/charts.js` +106/-22, `test/chart-columns.test.js` +164 | main carries `COLUMN_WRITE_TIMEOUT_MS`, `COLUMN_WRITE_BUDGET_MS`, `COLUMN_WRITE_WAITS_MS` and `state.chartColsPending` in `public/charts.js`, added by `3b33c85c` "fix: a settings write survives a slow panel instead of being called unsaved" (`git log -S COLUMN_WRITE_WAITS_MS origin/main -- public/charts.js`) | DISCARD - SUPERSEDED by `3b33c85c` |
| round-c-how-a-round-names-its-trees-stage-2-conclude-7ace4b | `docs/landing-pictureviewer-pmw-sso-deploy-2026-11-04.html` (618 KB, untracked) | absent from main; the subject is another project's SSO deploy, and main's newer cross-project documents (`docs/reports/dmr-39015-standalone-login-review-2026-11-10.html`, `docs/reports/pipeline-execution-rung4-live-2026-11-10.html`) are the live record | DISCARD - a cross-project artifact that landed nowhere; copied to `<tmp>/wag/77395884/salvage/round-c.../` |
| run-github-landing-sanity-test-write-0472b0 | `docs/reports/pipeline-next-moves-2026-11-09.html` (untracked) | main carries the same path with a later revision: 54411 bytes against this copy's 43549, and main's subtitle reads "the live landing that carries this page ... Measured against `4dd79438` (1.76.28)" where this one reads "the sanity landing at 1.76.26" | DISCARD - an earlier revision of a document main has newer |
| two-changes-to-the-clarify-card-one-pr-33f806 | `docs/reports/assets/clarify-card-caret-2026-11-11/after.png` and `before.png` | the index blob of both files equals main's (`a59bc24e`, `2ddd1e4a`); the files on disk are 323618/323097 bytes against main's 323148/320735, written 2026-11-11 06:10 by `tools/verify-clarify-card-caret.mjs` | DISCARD - re-captured artifacts; the tool regenerates them and main holds the bytes PR #704 landed |

## What this PR lands

1. `docs/reports/local-refs-leftovers-2026-11-13.html`, verbatim from `193838bd` - the only commit in the four trees
   that main does not carry.
2. Per-project landing rules, re-implemented on main's structure: `lib/project-landing-rules.js` (the field, the
   project resolution by name or tree, the brief paragraph, the preamble lines), the carry into `lib/jobs.js`'s brief,
   the assistant preamble section and its prompt-budget row, `README.md`, `config.example.json`, and
   `test/project-landing-rules.test.js`.

Everything else - the aggregate remainder's nine commits, the boot-stall fix, the clarify-card pair, the #52
fast-forward, the settings-write retry, and all seven judged dirty artifacts - is recorded above as superseded, with
the main commit that carries it or the reason it is an artifact.

## Removals

Every tree in the table above is removed after this PR merges, from the primary checkout, with
`git worktree remove --force` and `git branch -D`, each one re-checked against `GET /api/jobs` immediately before the
removal and none of them the primary checkout. The two empty orphan directories go with `rmdir`. This tree is released
to the panel with a `RELEASE` line once its pull request reads MERGED.
