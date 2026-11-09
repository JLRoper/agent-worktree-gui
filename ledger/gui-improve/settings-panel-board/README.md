# The Board scan-roots round: the corrected ledger

This is the `gui-improve` round for the Settings > Board scan-roots row (`surface: settings-panel-board`), as
its correct stage settled it and its compare stage re-pinned it, with the two review verdicts that asked for
the correction.

## Why its own dir

The round first landed at the shared ledger paths (`ledger/gui-improve/{baseline,compare,change-set.patch,review.md,review-verdict.json}`,
commit `97e0390a`). Later rounds reused those exact paths: the unattached-agents round rewrote `baseline/`
and `compare/` at `2f1948e1`, and the General preset-strip round then moved its own ledger into
`general-presets/`. Main's tip no longer carries this round's compare artifacts, and patching
`ledger/gui-improve/compare/comparison.json` in place would overwrite another round's record. The correct
stage's commit lands here instead, under the round's own dir, the way `general-presets/` does.

## What is here

- `correction.md` - the correct stage's answer to the four review notes (stage pin `c1801f6f`, path fix
  `520a45c8`), with its path citations rewritten to this dir.
- `review-visit-1.md` and `review-visit-1-verdict.json` - the review that rejected at visit 1 with four notes
  (`d39a6e12`).
- `review.md` and `review-verdict.json` - the visit-2 review (`803a7405`): the artifacts are sound and the two
  remaining defects are the panel's stage-tree record. Outcome: reject.
- `change-set.patch` - the implement stage's patch, sha256
  `d4c8fe93af4e7316bcf1f4fd5d95372e121b45d9db9a3583e2bcb2d73e253df4`, byte-identical to the copy the compare
  read.
- `compare/` - the compare stage's visit-2 re-pin (`38ef1d28`): `comparison.json`, `comparison.html` (every
  after shot paired with its before and the diff, images inline), `diff.mjs`, `tests.json`,
  `tests-after.log`, `tests-current.log`, `verdict.json`, and `before/`, `after/` and `diff/` with the shots,
  the captures and the inventories. Every repo path these artifacts cite resolves inside this dir (128
  citations checked at landing).

## The four notes and where they stand

1. Tests block and TAP logs (visit 1, note 1): applied. `compare/tests.json` carries the verbatim TAP tail of
   each run, both logs are committed beside it, and `comparison.json`'s tests block carries the same two
   tails. Runs: 21/21 and 22/22, exit 0.
2. `pipelineRun.trees.implement` (visit 1 note 2, visit 2 note 1): cannot be applied by a stage worker;
   `pipelineRun` is the panel's record and the single-writer rule forbids a second writer. Facts for the
   panel's repair pass: the reused tree is `.worktrees/write-the-draft-the-brief-asks-for-in-94df79`, on
   branch `wtgui/write-the-draft-the-brief-asks-for-in-94df79`, head `93febcc`; the record names branch
   `wtgui/run-gui-improve-again-this-time-on-the-5ab4e1` (at `da9f87a6`, which does not contain `93febcc`);
   `trees.implement` is absent.
3. `round.parentPath` and the stage trees (visit 1 note 3, visit 2 note 2): cannot be applied by a stage
   worker; cutting trees is the panel's `cutPipelineTree`. Facts: the round parent is `main` at `f0b80c7d`,
   recorded on `pipelineRun.tree` as `.worktrees/run-gui-improve-again-this-time-on-the-5ab4e1` on branch
   `wtgui/run-gui-improve-again-this-time-on-the-5ab4e1`; `round.parentPath` is absent; the compare, review
   and correct trees were cut from main's later tip.
4. Surface and protocol URL (visit 1 note 4): applied. `comparison.json`'s `surface.brief`, `surface.url` and
   `environment.serverUrl` all name `http://127.0.0.1:7493/`; `diff.mjs` now takes them from the after
   capture, so a re-pin cannot put 7491 back.

## The verdict on the change itself

Both reviews agree the change measures as improved and needs no edit: 9 pairs, 18 shots at 1440x900,
1280x800 and 1024x768 x open, presets and search; root gaps 0/3.84 -> 8/8 px on both roots at every viewport;
the add field 154 -> 223.52 px and its hint 382.66 px in 146 -> 145.42 px in 208; 181/181 elements and 53/53
controls with none added or removed; 13 CSS rules added and 0 removed; 98,317 of 1,591,200 surface pixels
moved (6.179%).

## Checking it

From the repo root:

    node tools/absolute-paths.mjs
    node --test --test-reporter=tap test/scan-roots.test.js test/settings-tabs.test.js test/header-controls.test.js
    open ledger/gui-improve/settings-panel-board/compare/comparison.html

## Provenance

- The comparison's before side is the baseline stage's own capture: 23 of `compare/before/`'s 24 files are
  byte-identical to the round's baseline capture, and the 24th is `before/SOURCE.json`, the compare's note.
- The change-set is byte-identical to `93febcc:ledger/gui-improve/change-set.patch`.
- The stage pins named above are commits in the stage trees. What this dir carries is what rides on main's
  history.
