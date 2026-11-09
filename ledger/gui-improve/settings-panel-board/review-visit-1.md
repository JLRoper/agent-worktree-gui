# gui-improve, visit 1 - rejected

Rejected at visit 1. The Board scan-roots change itself measures as improved: 9 pairs and 18 shots at the recorded viewports and states, root gaps 0/3.84 -> 8/8 px on both roots at every viewport, the add field 154 -> 223.52 px, its hint 382.66 px in 146 -> 145.42 px in 208, 181/181 elements and 53/53 controls with none added or removed, and 13 CSS rules added with none removed. But the comparison does not carry its own test result, and the run did not cut and record one stage tree per stage, so G3 does not accept it.

## Note 1 - surface: the comparison artifact's tests block

Defect: both test runs in `ledger/gui-improve/compare/tests.json` cite TAP log files that are not in the compare commit, so the "tests green" reason has nothing a reader can check.

Evidence: at a770d074a715, `git ls-tree -r --name-only a770d074a715 ledger/gui-improve/compare` lists `compare/tests.json` but neither `compare/tests-after.log` nor `compare/tests-current.log`; tests.json names both paths in `runs[0].log` and `runs[1].log`. I applied the change-set to this tree and ran `node --test --test-reporter=tap test/scan-roots.test.js test/settings-tabs.test.js test/header-controls.test.js`: exit 0, 22 pass, 0 fail, so the counts are true - the artifact just does not carry the output.

Fix: commit both TAP logs beside tests.json at the compare tree, or paste each run's verbatim TAP tail into tests.json and the comparison's tests block, then re-pin the comparison artifact.

## Note 2 - surface: the implement stage's stage-tree record

Defect: the implement stage's tree record names a branch that does not hold its commit, and the row's per-stage tree map has no implement entry, so the implement tree is not attached in the chart.

Evidence: task #260's pipelineRun.stageRuns for gui-improve/implement#1 name the path `.../.worktrees/write-the-draft-the-brief-asks-for-in-94df79` with branch `wtgui/run-gui-improve-again-this-time-on-the-5ab4e1` at heads 49278be and 93febcc. That worktree is on `wtgui/write-the-draft-the-brief-asks-for-in-94df79` at 93febcc; `wtgui/run-gui-improve-again-this-time-on-the-5ab4e1` is at 99f2bd7 and 93febcc is not an ancestor of it. `pipelineRun.trees` has only baseline, compare and review.

Fix: cut the implement stage its own tree from the round parent, or record the branch the reused tree is actually on; write `pipelineRun.trees.implement` with that path, branch and head, and re-settle the stage so its tree is attached.

## Note 3 - surface: the round's parent tree and the stage trees cut from it

Defect: the round records no parent tree and its parent is main, so the compare and review trees are children of main's later tip rather than of the frozen round sha; the stage trees do not share one frozen parent.

Evidence: task #260 `pipelineRun.round` is `{"parent": "main", "sha": "f0b80c7d74480a389fcce38f39cf2b5471a03d1e"}` with no `parentPath`; a770d07 (compare) and 479bc0d (review) both have parent 99f2bd7, and branch-parents records "main" as their parent.

Fix: cut the round's parent tree at the start sha, record `round.parentPath`, cut every stage tree from that branch, and re-run the walk so all stage trees start at the one frozen commit.

## Note 4 - surface: the comparison artifact's surface and protocol URL

Defect: the comparison's `surface.url` and protocol steps name the before server for a protocol the after shots did not run on, so the artifact disagrees with its own after capture about which panel served the after surface.

Evidence: comparison.json `surface.url` is `http://127.0.0.1:7491/` and every `protocol.states[].steps` entry 2 says goto `http://127.0.0.1:7491/`; `after/capture.json` environment.serverUrl is `http://127.0.0.1:7493/` and every after shot's step 2 says goto `http://127.0.0.1:7493/` (the before capture is the 7491 side).

Fix: set the comparison's `surface.url` and protocol steps to 7493, or record both sides (before 7491, after 7493), and re-pin.

## Checked and not counted

The 18 pair shot hashes match the files at a770d074a715, the comparison page embeds all 9 before/after/diff sets, the change-set applies cleanly to 44b4278, its 13 rules are what the after capture measures, and the 22/22 test count reproduces on this tree with the change-set applied.
