# Rung 1: the GitHub gate test, recovered from a dangling commit

Status: recovered and verified. Rung 1 was already on `origin/main` before this run, landed by
PR #683 as `7bbe7876`; nothing was pushed for it and no second PR was opened.

## What the run found

The run that produced the test ended with `8e50394a94390fe9b3d0b22551d4f854ec02d944` ("test: the
GitHub gate walks as a barrier and a router, not a pause") and then had its worktree removed. No
branch and no pull request named it, so the commit was reachable only from the object store.

The object is a pre-merge copy of a change that DID land. `origin/main` carries the same file at
the same blob id, added by `7bbe78769268d95e97115281c7c5dcc7ed448715`:

| read | recovered `8e50394a` | landed `7bbe7876` |
| --- | --- | --- |
| `test/pipeline-github-gate.test.js` blob | `4b1bf74a9f8179d700368aaaeb3cabf7fb99ab79` | `4b1bf74a9f8179d700368aaaeb3cabf7fb99ab79` |
| `git patch-id --stable` | `38154e5cac86db8fdfbeca8b184c36ad501e772a` | `38154e5cac86db8fdfbeca8b184c36ad501e772a` |
| `package.json` version | 1.80.8 | 1.80.8 |

PR #683 merged at 2026-11-10T03:07:08Z. The release tag `v1.80.8` is anchored at `7bbe7876`.

## The ref came first

`refs/heads/recovered/rung-1-gate` was created at `8e50394a` before any rebase, so a garbage
collection cannot prune the object this record describes:

    git branch recovered/rung-1-gate 8e50394a

Its parent is `5c786f2fb7348bba58460c2c199ad67f5dc02f6d`, which is an ancestor of `origin/main`.

## The rebase onto main had nothing to replay

`git rebase origin/main recovered/rung-1-gate` answers:

    warning: skipped previously applied commit 8e50394a
    Successfully rebased and updated refs/heads/recovered/rung-1-gate.

The branch now sits on `23fbe197` with no commits of its own. Nothing was re-bumped and no
duplicate PR was opened. The next number above main's would have been 1.80.9, but there is no
change left for it to carry.

## The six acceptance points

All six are asserted in `test/pipeline-github-gate.test.js`; none was missing, so nothing was added.

1. With no record before the gate, `nextStageOf` answers `ok: false` with `code: "pipeline-gate"`
   (lines 142-144).
2. The gate is named: `step.gate.id` is `"G3"` (line 145), with `gate.name` `"Pushed"`.
3. The record path is expanded onto the tree: `step.path` is `<tree>/ledger/gates/G3-{{run_id}}.json`
   (line 149).
4. `outcome: refused` ends the walk: no stage is entered, `done` is true, and the row's own sentence
   names the refused verdict (lines 155-173).
5. `outcome: pushed` routes by `H-03`: the walk enters `pr` exactly once and finishes `pr`, `merge`,
   `main` (lines 175-192).
6. The shipped seed keeps six null decisions, and the same decision with its `path` removed is
   refused at load with `incomplete-gate` (lines 194-222).

## What was run

On `origin/main` at `23fbe197`, in the primary checkout:

    node --test test/pipeline-github-gate.test.js test/task-pipeline-drive.test.js test/task-pipeline-verdict.test.js

58 tests, 58 pass, 0 fail. The gate file alone is 4 of those.

## The local merge

The brief asks for this tree's branch to be merged into
`wtgui/round-c-how-a-round-names-its-trees-5b3b85` locally and not pushed, because that base has
not landed and a remote branch of this tree would be one nobody asked for. The merge is `--no-ff`
from the base's own worktree, and this record rides it. Its first parent is `2b1d728a`, the base's
tip at the time; its second parent is this branch's tip.

Nothing was pushed. The base is left where it is, and the number on it moves when the base itself
lands, so this record carries no version bump of its own.
