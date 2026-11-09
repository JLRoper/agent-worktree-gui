# Focused testing: the replay before the change, and what it decided

The selector (`tools/test-changed.mjs`) chooses the test files a change touches. Before extending its mapping, it was
replayed against the last ten merged landings on `origin/main`: for each landing, the selector as it stood was run
against that landing's own tree and its set was recorded. Then each set was compared against the tests the landing's
modules reach by import, and each difference was read by hand. The misses decided the change; the set sizes decided
how the change is worded in the worker brief.

## Method, so the numbers can be checked

Ten landings, newest first, each a PR's own commit range on `origin/main` (a feat/fix plus its version bump and its
changelog render; release-only and docs-only landings were skipped because a change to markdown cannot be missed by a
test). For each landing:

1. `git archive <base>` into a scratch directory, then `git init`, commit that tree as the base, apply
   `git diff --binary <base> <tip>` and commit again. The second commit's tree IS the landing's tree.
2. Run the selector's own `--list` inside that directory against `HEAD~1`, so the set is the tool's answer on the
   landing's own test files, not on today's.
3. Compare that set with the import graph of the same tree: for each changed module, walk the modules that import it,
   and collect the `test/*.test.js` files the walk reaches. Anything reached and not picked is a miss.
4. Read each miss and ask whether the change plausibly moves that test's subject. A test that imports a hub and tests
   an unrelated behaviour is reached without being affected; a test that drives the changed row, brief or stage is
   affected.

Nothing was run from the suite: this is about which files the selector chooses, not about whether they pass. Every
count below is a file count in a tree of 262 to 264 `test/*.test.js` files.

## The ten sets, as the selector stood

| landing | subject | files changed | of them code | set size | empty |
| --- | --- | --- | --- | --- | --- |
| `aa92d63` | the cut's end asks for the stage | 5 | 2 | 92 | no |
| `061cda4` | a cap park wakes the reader with one line | 7 | 5 | 118 | no |
| `4a77988` | a row can be filed onto a stage in one write | 7 | 5 | 97 | no |
| `307a8c0` | a pipeline row has its own clock, read from createdAt | 7 | 5 | 98 | no |
| `254599d` | the brief's own word budget governs | 6 | 3 | 40 | no |
| `4f16074` | a stage's artifact path is visit-scoped | 8 | 5 | 40 | no |
| `f1e69c9` | every shipped stage states what its artifact is | 6 | 3 | 49 | no |
| `b6e5dfa` | a manual park is not open work for the queue-idle sweep | 5 | 3 | 97 | no |
| `f388e13` | round-6 review, the stage's land, the settings prefix | 28 | 20 | 160 | no |
| `f4664de` | the order test pins the four-step landing | 3 | 1 | 20 | no |

Two things the table already says, and neither was assumed:

- **No set was empty.** Ten of ten landings came back with tests, so the selector never failed to answer. The empty
  sentence the tool prints is a fallback, not the common case.
- **The set is broad, not narrow.** 20 to 160 of 262 to 264 files, which is 8 to 61 per cent of the suite. The cause is
  the basename half of the text rule: a change to `package.json` pulls in every test that reads it (10 or 11 files), a
  change to `lib/assistant.js` pulls in 73 tests that write `assistant.js` or `lib/assistant.js`, and `config.js`,
  `queue.js` and `settings.js` behave the same way. This replay measures the mapping as it is; it does not repair that
  breadth, and the change below does not either. What makes a single cut cheap is the new per-file command.

## The misses, and what each one means

| landing | missed tests | read by hand |
| --- | --- | --- |
| `aa92d63` | `pipeline-bench.test.js` | affected: it builds a real Assistant and calls `sweepQueues()`, the method the change added its hand-off to |
| `061cda4` | `pipeline-bench.test.js`, `ticket-watch.test.js` | affected: the bench drives the same turn path; ticket-watch reads `lib/assistant/config.js` through the Assistant |
| `4a77988` | `pipeline-bench.test.js` | affected, same bench |
| `307a8c0` | `pipeline-artifacts.test.js`, `pipeline-bench.test.js`, `pipeline-truth.test.js`, `task-pipeline-fanout.test.js`, `task-pipeline-pins.test.js`, `word-budget.test.js` | affected: four of them import `lib/task-pipeline-drive.js` and call `driveTaskPipelines`, whose row clock is what changed |
| `254599d` | 52 files, headed by the `assistant-*.test.js` set and `pipeline-bench.test.js` | partly affected: the pipeline and brief tests drive the changed code; the rest reach it only through `lib/assistant.js` and test other behaviours |
| `4f16074` | 51 files, the same assistant set | partly affected, same reason |
| `f1e69c9` | 50 files, the same assistant set | partly affected, same reason |
| `b6e5dfa` | `pipeline-bench.test.js`, `pipeline-truth.test.js`, `task-pipeline-fanout.test.js`, `task-pipeline-inputs.test.js`, `task-pipeline-pins.test.js` | affected: the row tests import `lib/task-pipeline-drive.js`, which imports the changed `lib/assistant/queue.js` |
| `f388e13` | `agent-cleanup.test.js`, `pipeline-bench.test.js`, `verify-landed.test.js`, `worktree-release.test.js` | one affected (the bench); three reached only through `lib/worktrees.js` and do not exercise the changed lines. They are the price of the rule, not a win |
| `f4664de` | none | a change to one test file whose own text names it: nothing else can be affected |

What the replay establishes, in one line each:

1. **Every DIRECT importer was already caught.** Across the ten landings the text rule missed 0 files that import a
   changed module directly, because a direct import spells the path out. The extension cannot be justified by those.
2. **The misses are second-order.** 9 of the 10 landings missed at least one test whose import chain reaches a changed
   module through one more module. The count per landing runs 1, 2, 1, 6, 52, 51, 50, 5, 4, 0.
3. **Some of those are behaviourally real.** `pipeline-bench.test.js` is missed by 8 landings and calls the changed
   method; `task-pipeline-fanout.test.js` and `task-pipeline-pins.test.js` drive the row whose clock changed. A
   selector that leaves them out is answering "which tests name this" and calling it "which tests this reaches".

## The decision: follow imports

The replay shows misses, so the mapping was extended rather than kept. A test is now in the set when its text names a
changed path (unchanged, including the basename match and its six-character floor) OR when its import chain reaches a
changed module. The import walk is transitive, reads relative specifiers only, and skips `node_modules`, `.git`,
`.worktrees`, `data` and `logs`.

The cost is bounded by the graph rather than by the rule. Re-run on the same ten trees, the extended selector answers:

| landing | set before | set after | added by imports |
| --- | --- | --- | --- |
| `aa92d63` | 92 | 93 | 1 |
| `061cda4` | 118 | 120 | 2 |
| `4a77988` | 97 | 98 | 1 |
| `307a8c0` | 98 | 104 | 6 |
| `254599d` | 40 | 92 | 52 |
| `4f16074` | 40 | 91 | 51 |
| `f1e69c9` | 49 | 99 | 50 |
| `b6e5dfa` | 97 | 102 | 5 |
| `f388e13` | 160 | 164 | 4 |
| `f4664de` | 20 | 20 | 0 |

The widest-reaching module on today's tree (`tools/panel-testkit.mjs`, `lib/tree-names.js`) reaches 114 of 264 test
files, so even the worst case leaves two thirds of the suite out. A change to a hub stays broad, and the brief still
tells the worker to sweep the whole suite before the pull request; a change to a leaf stays small.

## What a single file's set looks like now

`npm run test:module <path>` answers the same question about ONE file. Over the 378 modules in this tree (tests and
`docs/` excluded), the set size is:

| set size | modules |
| --- | --- |
| 0 | 174 |
| 1 to 5 | 118 |
| 6 to 15 | 27 |
| 16 to 40 | 5 |
| 41 to 80 | 33 |
| more than 80 | 21 |

319 of 378 modules (84 per cent) name or reach 15 test files or fewer; 174 name none at all. The 21 above 80 are the
hubs (`lib/jobs.js`, `lib/tree-names.js`, `lib/child-tree.js`, `lib/errors.js`), where the whole suite really is the
honest answer.

## What changed in the tree

| file | change |
| --- | --- |
| `tools/test-select.mjs` | new: the one mapping, text mention plus import reach, and the target resolver |
| `tools/test-changed.mjs` | uses that mapping; header states both rules and cites this replay |
| `tools/test-module.mjs` | new: `npm run test:module <path>`, one file's tests, `--list` to print them |
| `package.json` | `test:module` script |
| `lib/jobs.js` | `TESTING_BRIEF`: run the focused set while you work, sweep the suite once before the PR; gated on the tree's own package.json carrying both scripts |
| `test/test-select.test.js` | the mapping: text hit, import hit one and two hops out, empty set, non-module changed file, resolver |
| `test/test-module.test.js` | the command: a hit that runs, a miss that says so, a named test file, an absent path, and one real module |
| `test/testing-brief.test.js` | the brief: the paragraph, its order, its gate, and the assistant turn without it |

## Limits, stated rather than hidden

- The replay reads a landing's whole commit range, including its version bump and changelog render. A selector run by a
  worker mid-turn sees only what is committed, staged and dirty at that moment; the ranges here are the closest
  reproducible stand-in for "what a landing's push would have carried".
- "Plausibly affected" is a judgement. The counts are mechanical; the per-landing verdicts in the table are readings of
  each test's subject against the diff, and the ones marked "partly" are named so a reader can disagree with a name.
- The import walk follows static `import`/`require`/`import()` specifiers. A module loaded by a path built at run time,
  or a classic script pulled in by an HTML page, is only caught by the text rule. That is why the text rule is kept.
