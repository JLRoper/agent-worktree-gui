# The 279 lines this tree carried, and where each one went

**Answer: nothing in this tree was missing from `main`, so there was no follow-up to land.** The
release gate compared the tree against PR #526's own merge commit instead of against `main`, so it
counted the two commits this branch made AFTER that merge as unlanded work - and both of those commits
are ancestors of `origin/main`. The pipeline-source unification itself is on main whole: 541 of the 541
lines its four commits add, across 12 files. The 279 lines resolve to 3 paths, and each one is a
superseded iteration of something main already carries in a newer form. This commit is therefore the
record of that finding, with a patch bump; no product, test or tool file is touched.

**Provenance.** Tree `the-settings-pipeline-ta-792759`, branch `wtgui/the-settings-pipeline-ta-792759`,
tip `5ad18dc` (v1.50.7) before the catch-up to main and `c458e4a` after it. PR #526 merged at `11b7d61`
(v1.50.6); `origin/main` at `c458e4a` (v1.53.4, 395 changelog releases). Read 2026-11-07, node v26.3.0.

## 1. What the gate counted, reproduced

The refusal on this tree's row reads:

    refused: the tree carries work PR #526 did not land (3 paths of its own, 279 lines still differing
    from the merge commit)

"That merge commit" is `11b7d61`, the tip PR #526 landed as. Diffing the tree against it:

    $ git diff --numstat 11b7d61 5ad18dc
    20      2       CHANGELOG.md
    224     0       docs/console-memory-growth.md
    1       1       package.json

Three paths, 245 insertions and 3 deletions - 248 changed lines. The gate's "279" is its own count over
this same diff (the patch reads 284 lines once headers and context are included); it is not the
insertion/deletion sum. The paths, and what they are made of, are not in doubt:

- `b699291 docs: render the changelog - 381 releases` - 20 insertions, 2 deletions in `CHANGELOG.md`.
- `5ad18dc docs: measure what a long-lived tab retains per turn` - the 224-line
  `docs/console-memory-growth.md`, plus the v1.50.7 bump in `package.json`.

Both commits are in main:

    $ git merge-base --is-ancestor b699291 origin/main && echo in-main     # in-main
    $ git merge-base --is-ancestor 5ad18dc origin/main && echo in-main     # in-main

So the delta is not the tree carrying work; it is the branch having continued after its own PR merged,
with commits main later received. The panel's own row for this tree agrees at the same moment: verdict
`MERGED (4 commits)`, `ownCommits 4`, `mergedCount 4`, `unmergedCommits []`, `isAncestor true`,
`dirty 0`.

The fix to the gate's measure, if a later pass wants it: compare against `origin/main`, not against the
PR's merge commit, when the tree's tip is an ancestor of main.

## 2. The pipeline-source unification is on main whole

PR #526's four commits (`c665d7c..6981d89`) add 541 non-blank lines across 12 content files. Every one
of those lines is present on `origin/main`: 541 of 541, none missing. Eight of the 12 files are
byte-identical between the tree's tip and main:

- `lib/pipeline-source.js` - the one reading of `config.pipelineBundleFile`
- `lib/pipeline-window.js`, `lib/task-pipeline-assign.js` - the two callers moved onto it
- `docs/task-pipeline.md`
- `test/pipeline-source.test.js`, `test/pipeline-catalogue-route.test.js`
- `tools/verify-pipeline-catalogue.mjs`, `tools/absolute-paths.allow`

The other four differ only by main's later work, never by missing tree work. The next table is the
per-hunk ledger of that difference (`git diff 5ad18dc c458e4a -- <file>`), where "tree-only" means a
line main replaced or removed:

| file | hunks | tree-only | main-only | verdict |
|---|---|---|---|---|
| `docs/pipeline-sources.md` | 1 | 0 | 17 | main added "Where the two lists meet" (the PDL dropdown section). The tree lacks it; nothing of the tree's is missing. |
| `public/app.js` | 25 | 25 | 244 | see the per-region rows below |
| `public/index.html` | 6 | 5 | 6 | 5 lines are the scratchpad -> notes rename (four titles and one comment); main's 6 are that rename plus the new `#pipeline-pdl-pick` row |
| `server.js` | 1 | 0 | 20 | main's `POST /api/assistant/hard-restart` route |

`public/app.js`, the only file where the pipeline work itself differs:

| region (tree tip) | tree-only | main-only | what main holds instead |
|---|---|---|---|
| `paintPipelines` dropdown | 7 | 28 | the "PDL pipelines" optgroup above "built-in ladders", the `pdl:<id>` value and its note row (`d5872be`); the tree kept the ladder-only list under the PDL note #526 added |
| `selectPipelineTab` / `openPdlFlow` | 7 | 67 | the `pdl:`-aware selection, which closes the ladder editor, and `openPdlFlow` |
| PDL globals block (`pipelinePdlId`, `pdlPipelines`, `pdlPickNote`) | 0 | 54 | the helpers the newer dropdown and flow press are built on |
| `assistantSessionFor`, `jobLines` | 2 | 34 | the hard-restart thread lookup (`previousThreads`) and the console-buffer bounds |
| `applySnapshot`, `updateJob` | 6 | 31 | `applyJobSnapshot` and the no-second-copy rule (`d8c45cb`) |
| turn origin, `displayPrompt` | 1 | 28 | the watchdog chip and the prompt prefix it strips |
| reset copy | 2 | 2 | the scratchpad -> notes rename |
| **total** | **25** | **244** | |

Every tree-only line there is either the earlier version of a block main has since rewritten
(`d5872be`, the same feature one iteration on) or copy an unrelated rename changed. None of it is work
that stopped on the branch.

The unification is also healthy at main's tip - the targeted set passes, 36 of 36:

    $ command node --test test/pipeline-source.test.js test/pipeline-catalogue-route.test.js \
        test/pipeline-pdl-map.test.js test/pipeline-modal.test.js
    tests 36 / pass 36 / fail 0 / duration_ms 5907

That set includes `both routes quote one list, and a refused bundle is refused once` and the four PDL
dropdown tests, so "one definition, one validation path" is proved on main rather than taken on trust.

## 3. Discard ledger

Each row below is recorded as discarded: it is not re-landed, because main already carries a newer form
of it, and re-landing would be the superseded iteration overwriting the newer one.

| path | what the tree holds | what main holds | why it is discarded |
|---|---|---|---|
| `CHANGELOG.md` | the v1.50.7 render: "381 releases ... to v1.50.6" | the v1.53.4 render: "395 releases", with its own `v1.50.7` section at `CHANGELOG.md:178` | the changelog is generated; a render is never hand-carried across a base. 10 of the 12 non-blank lines it adds are on main, and the 2 that are not are the release-count header main re-rendered. |
| `docs/console-memory-growth.md` | the 224-line draft (v1.50.7) | 265 lines, corrected by `8531de7 docs: correct the console memory note against the code` and extended by `d8c45cb` (the bounded buffers) | the draft is the pre-correction revision. 18 of the 172 non-blank lines it adds are not on main, and they are its `file:line` anchors and per-turn numbers, which `8531de7` corrected against the code - stale citations, not lost findings. |
| `package.json` | `1.50.7` | `1.53.4` | the version line is superseded by main's own later releases; this landing takes `1.53.5`. |
| `docs/pipeline-sources.md`, `public/app.js`, `public/index.html`, `server.js` (from #526 itself) | the #526 iteration | main's newer iteration (section 2's tables) | #526's content is present (541/541 lines); main then extended it, and its later text is what should stand. |

## 4. What was looked for as a possible follow-up, and found absent

- **A file only the tree has.** None: all 12 content files PR #526 added or changed exist on main, and
  no file the tree's tip adds is missing from main.
- **A behaviour only the tree has.** None: the 25 tree-only lines in `public/app.js` are the dropdown
  and `selectPipelineTab` blocks main rewrote in `d5872be`, which offers a superset (PDL optgroup,
  `pdl:` value, the flow dialog and the map link).
- **A test or gate only the tree has.** None: `test/pipeline-source.test.js`,
  `test/pipeline-catalogue-route.test.js` and `tools/verify-pipeline-catalogue.mjs` are byte-identical
  to main's, and main adds `test/pipeline-pdl-map.test.js` on top.
- **A doc claim main contradicts.** Only the console-memory draft's anchors, and main's own correction
  commit is the later, verified reading.

## 5. What this commit is

`docs/reports/settings-pipeline-unlanded-2026-11-07.md`, this file, plus the patch bump
`1.53.4 -> 1.53.5`. It changes no product code, no test and no tool, because the measurement says
there is nothing to land.

## Reproduce

Run in the tree, with `origin/main` fetched:

    git rev-list --count origin/main..5ad18dc                                   # 0
    git diff --numstat 11b7d61 5ad18dc                                          # 3 paths, 245/3
    git log --oneline 11b7d61..5ad18dc                                          # the two post-merge commits
    for c in b699291 5ad18dc; do git merge-base --is-ancestor $c origin/main && echo "$c in main"; done
    git diff --name-only c665d7c..6981d89                                       # PR #526's 12 content files
    git diff --stat 5ad18dc c458e4a -- docs/pipeline-sources.md public/app.js public/index.html server.js
    command node --test test/pipeline-source.test.js test/pipeline-catalogue-route.test.js \
        test/pipeline-pdl-map.test.js test/pipeline-modal.test.js               # 36/36
