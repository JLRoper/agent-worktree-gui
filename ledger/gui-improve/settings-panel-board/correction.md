# gui-improve, correct, visit 1

Landed under the round's own dir: this record and the compare artifacts it names sit at `ledger/gui-improve/settings-panel-board/`, because later rounds reused `ledger/gui-improve/{baseline,compare}` at main's tip. The paths below are rewritten to that dir; the stage pins (`c1801f6f` for this record, `38ef1d28` for the compare re-pin, `d39a6e12` and `803a7405` for the two reviews) are the stage trees' commits.

The review's notes were read at `d39a6e1203a4:ledger/gui-improve/review.md` (blob `387ac258ff3b7c90b3fc182f167d8925896149c8`, sha256 `9251a4b5fad50e705464551f68011c64ffc2929393a46c9385b74d500ff1467d`), and the gate's verdict at `d39a6e1203a4:ledger/gui-improve/review-verdict.json` (`{"outcome": "reject"}`). The checkout's review.md and review-verdict.json have moved off the pin to the accepted round's text, so this record follows the pin. The reviewer's decision stands; the four notes are answered here, one at a time.

## Note 1 - the comparison artifact's tests block

Applied. `ledger/gui-improve/settings-panel-board/compare/tests.json`'s two runs now carry the verbatim TAP tail of the run each cites, from the `1..21` and `1..22` plan lines through the `# duration_ms` line, and the comparison's `tests` block carries the same two tails, so the "tests green" reason is checkable from the artifact itself. Both TAP logs are also committed beside tests.json at the two paths the runs name, force-added past the repository's `*.log` ignore rule, so the citations resolve as well. `diff.mjs` copies the `tests` block verbatim into the comparison, so the tails survive the next re-pin. Re-run on this tree: `node --test --test-reporter=tap test/scan-roots.test.js test/settings-tabs.test.js test/header-controls.test.js` gave exit 0, 22 pass, 0 fail.

## Note 2 - the implement stage's stage-tree record

Cannot apply: `pipelineRun` is the panel's record, written by its cut and settle passes, and a stage worker writing it by hand is the second writer the design's single-writer rule forbids; the panel's repair pass must attach the tree. The facts it needs: the reused tree is `.worktrees/write-the-draft-the-brief-asks-for-in-94df79` on branch `wtgui/write-the-draft-the-brief-asks-for-in-94df79` at `93febcc`, while the record's branch field names `wtgui/run-gui-improve-again-this-time-on-the-5ab4e1`; `trees.implement` is still absent.

## Note 3 - the round's parent tree and the stage trees cut from it

Cannot apply: cutting or re-cutting a stage tree and re-running the walk is the panel's `cutPipelineTree`, not a file a stage can commit, and `round.parentPath` is written by the panel at the cut. The facts: the parent tree is already recorded on `pipelineRun.tree` as `.worktrees/run-gui-improve-again-this-time-on-the-5ab4e1` on `wtgui/run-gui-improve-again-this-time-on-the-5ab4e1`, cut at `f0b80c7d`; `round.parentPath` is absent and the compare, review and correct trees were cut from main's later tip instead of that branch.

## Note 4 - the comparison artifact's surface and protocol URL

Applied. `ledger/gui-improve/settings-panel-board/compare/comparison.json`'s `surface.brief` and `surface.url` now name `http://127.0.0.1:7493/`, the after capture's server, matching `environment.serverUrl` and the after shots' goto step. The protocol's open state already named 7493 in the pinned blob, so no protocol step needed a change. `diff.mjs` now takes the comparison's surface brief and URL from the after capture and keeps the before capture's change and changeSource, so the next re-pin cannot put 7491 back.

## The change-set

The change-set is unchanged: no note asks for a change to the patch. `ledger/gui-improve/settings-panel-board/change-set.patch` is byte-identical to the artifact the implement stage settled at `93febcc`, so its new sha256 is the one the artifact already carried: `318d2032c6eb7e243e0139e9ebcb53b721c499b89893bd00ffec8db95c3288af` as the CRLF working file reads. The committed blob at `93febcc` is `d4c8fe93af4e7316bcf1f4fd5d95372e121b45d9db9a3583e2bcb2d73e253df4`, which is the change-set the next compare reads.

## In this correction commit

- `ledger/gui-improve/settings-panel-board/compare/tests.json` - the two verbatim TAP tails.
- `ledger/gui-improve/settings-panel-board/compare/comparison.json` - the same tails in its tests block, and surface.brief plus surface.url set to 7493.
- `ledger/gui-improve/settings-panel-board/compare/tests-after.log` and `tests-current.log` - the two runs' TAP output, force-added past `.gitignore`.
- `ledger/gui-improve/settings-panel-board/compare/diff.mjs` - the surface brief and URL taken from the after capture.
- `ledger/gui-improve/correction.md` - this record.
