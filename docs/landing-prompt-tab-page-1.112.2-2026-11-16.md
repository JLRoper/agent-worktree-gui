# Landing: the Prompt tab is written as a page a reader can open cold (1.112.2)

PR #777 takes the General Settings Prompt tab from three diagrams with no words attached to a page that opens with a
key, defines its vocabulary in alphabetical order, keeps the charts beside the sentences that explain them, and gives
the worker briefs a section of their own.

Merge `d93265c`, tag `v1.112.2` at `bed1111`, `origin/main` at `e791f8a` (the render), `changelog --check` reads
current - 620 releases. What a reader can open: `docs/assets/prompt-tab/prompt-tab-key.png`,
`prompt-tab-definition.png`, `prompt-tab-briefs-1.png` and `prompt-tab-briefs-2.png`, and the tab itself on the next
panel start (`Settings > Prompt`).

## What the tab says now

1. **A key.** System text is the standing half of the prompt, sent as the run's `instructions` and so the part a
   provider's prefix cache can reuse. Turn text is the half that moves every turn: the board tail, the queue digest
   when its gate is due, the charter when it rides along. Then why the split exists, in the cache's own terms - while
   the board's and the charter's markers sat at the head, the first call of a turn read 1,536 of 326,319 prompt tokens
   from cache (0.5%), the number the comment at `Assistant.briefingParts` carries - and what follows: nothing that
   moves may ride in the system half, and a block that changes at the head costs the cache for the whole thread behind
   it. The measurement is pointed at (`docs/design/prompt-tiers-2026-11-08.md`) rather than restated.
2. **The tab's own words, A to Z.** Board digest, budget, charter, over-cap behaviour, queue digest, resend every N,
   section and its order, standing briefing - a sentence each, and a chip naming the box it describes (`turn text ·
   Board tail`, `system text`, ...) so a definition can be carried to the diagram. The order entry says why the order
   is load-bearing: an over-cap cut keeps the head and drops the tail.
3. **The three charts kept**, each beside the note that explains it. The ordinary-turn sentence reads the queue gate
   from the model (`gates.queueLabel`), so a panel set to every 3rd wake does not read "every 2nd" over its own
   diagram.
4. **A worker-briefs section.** RELEASE, DELIVER, CLARIFY_LINKS, REPORT, TERMINAL, GIT, PAGE, TESTING - what each
   asks for, when it attaches (every tree turn, or only where the project or the tree's `package.json` allows it), the
   `lib/jobs.js` constant it comes from, and REPORT marked as the paragraph that landed in 1.111.1. Each points at its
   own doc - the git-remotes note, the report cards, the terminal-call report - and the harness reads every `docs/...`
   path back off the page and checks it exists in the tree, because a pointer to a missing file is worse than none.

## One constraint worth carrying forward

The panel keeps `class="settings-group"` and nothing else, because `test/settings-tabs.test.js` matches that exact
string to discover the thirteen panels. The documentation styling therefore hangs off the attribute the panel already
carries, `[data-settings-group="prompt"]`, and the doc rows keep `.settings-row` so the settings search still finds
them (`:where()` plus `:not(.search-hidden)` puts the display override at the search rule's own specificity instead of
above it). A future editor who adds a second class there silently drops the tab out of that test's panel list.

## The proof

- `node tools/verify-prompt-tab.mjs`, rewritten for the page: **68 of 68 checks at 1440x900**, pane at 960 so the
  two-column layouts engage. It presses each of the four anchors and asserts the pane moved, reads the definitions
  back in alphabetical order with a chip on every one, checks the diagrams' fifteen boxes in builder order and their
  route totals, the ordinary turn's closed queue gate, the board's tail and the charter's full and marker forms, the
  eight briefs with their constants, that no pointer names a file the tree lacks, that the page does not scroll
  sideways, and that the key fits one 900px frame. It wrote the four shots above.
- `node tools/verify-settings-tabs.mjs`: 69 of 69 - the strip, the panels, the search and the 640px cases still pass.
- The focused set over the files this diff names - `settings-tabs`, `prompt-budget`, `settings-general-route`,
  `settings-permissions-layout`, `settings-enter-key`, `absolute-paths`, `assistant-settings-split`: **59 tests, 59
  pass, 0 fail**.

## Two failures `origin/main` already carried

Both were re-proved against a pristine `git archive origin/main` export with a junction to this tree's
`node_modules`, so neither is this diff's:

1. `test/windows-hide.test.js`: `lib/child-tree.js:74` calls `execFile` without `windowsHide`. The test and the source
   it audits are byte-identical to `origin/main`, and the export fails the same way.
2. `test/scan-roots.test.js` line 83, "the repo under the new folder is on the board without a restart": the export
   fails identically, and the `rootOf()` slice that test extracts from `public/app.js` is byte-identical to main's
   (912 chars, compared directly). It is not reachable from this change.

`npm test` (one full sweep) surfaced the first; `npm run test:changed` (133 files, 176.6s) surfaced the second and
nothing else. `npm run verify:version-tags` reads 7 findings, all pre-existing (28 branch-held tags and a backwards
`package.json` at `f4cdd0d`); `v1.112.2` is not among them.

## Where it stands

- PR #777: MERGED, merge commit `d93265c`.
- `origin/main`: `e791f8a` (the render), `changelog --check` current at 620 releases.
- `v1.112.2`: annotated, on `origin`, peeled to `bed1111` - the commit that first declared the number.
- The push went through the hook. The one `--no-verify` push in this landing's record is `tools/land.mjs` sending the
  changelog render commit, which is the tool's documented path: every commit it sends touches only `CHANGELOG.md`, and
  a render spends no version.
- The worktree that did the work is clean and can be released.
