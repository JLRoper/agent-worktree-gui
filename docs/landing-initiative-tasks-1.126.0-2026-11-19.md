# Landing: an assistant on an initiative, expanded to its exact tasks (1.126.0)

PR #800 merged into `main` as `cb0bc37a`, and the render that followed is `6d25db7c`. The Initiatives tab already
named the assistants that had worked an initiative and counted their rows; it could not say WHICH rows. Each
assistant row now carries its own fold - a real button with the tab's own caret, the count of rows it opens and
`aria-expanded` - and a press opens every queue row tied to that initiative's trees: its id, its title, its state
(queued, running, parked, done), its thread, its run while the row is live, its PR when it has one, and when it
last moved, newest activity first.

## What landed

- `routes/initiatives.js` - every assistant entry on `GET /api/initiatives` grows `taskRows`: the same list its
  counts were taken from, so the fold cannot disagree with the chips beside it. Each row is the queue row and its
  decoration read once (id, title, state, the thread it is on now, the run only while it is running, the PR number
  and state with the board row's own `prUrl`, last-touched), sorted newest first with the running row leading
  because it is working now.
- `public/core/initiative-fold.js` - `taskChip` (the reader's four states in the panel's existing tones, an unknown
  state drawn as itself rather than dropped) and `taskFoldKey` (initiative AND assistant), beside the four-state
  table the chips share.
- `public/assistant.js` - the fold button next to the assistant's name, the reconciling painter
  (`paintInitTaskLists` / `patchInitTaskRow`), the press-handler branch, and the honest "no task is filed on this
  initiative's worktrees for this assistant right now" line. The fold's open state lives in the pane per initiative
  and assistant (`initTaskOpen`), so a repaint cannot shut a list a reader is reading; rows are reconciled by task
  id and patched in place, so a live row updates where it stands instead of being rebuilt under the cursor.
- `public/style.css` - the fold handle sized for the assistant row. The row reads name, fold and when-it-worked on
  one line, the four counts on the next, and the task list indented under it: four chips plus a fold beside a name
  is wider than the rail, and letting them fall where they fit left "working now" alone on a line of its own.
- `test/initiative-tasks.test.js` (11 cases) - the grouping and its order, the task with no initiative link, the
  tree on two initiatives, the run id only while live, the PR from the board row's own `prUrl`, the fold key, the
  state chips, and the pane's source contract for the button, the press branch and the patch-in-place painter.
  `test/initiative-fold.test.js` grows the new control in its press-selector pin.
- `tools/verify-initiative-tasks.mjs` - the live gate, wired as `npm run verify:initiative-tasks`.

Membership is the queue row's own `worktree` against the initiative's tree keys: never a branch name, never a tree
scan. A task with no initiative link cannot appear, and a tree attached to two initiatives shows the same rows
under both, once in each.

## What proves it

- `node --test test/initiative-fold.test.js test/initiative-tasks.test.js test/initiatives-route.test.js
  test/initiatives-store.test.js` - 53 tests, 53 pass. `test/initiative-history.test.js
  test/initiative-permissions.test.js test/initiative-tier-route.test.js test/text-styles.test.js` - 35 tests, 35
  pass. 88 tests, 88 pass, 0 fail.
- `npm run verify:initiative-tasks` - **61/61 checks passed**, 0 page errors, 0 console errors, 1440x900. The gate
  walks the fold end to end: collapsed (a button, the tab's caret, `aria-expanded=false`, no rows in the DOM);
  expanded (the exact rows with their states, threads, run and clock, newest first); a running row moved to done
  through the queue API and updated **in place** (the element the harness marked before the change survives it, its
  chip now reads done and its run line is gone); Enter and Space on the fold from the keyboard; Escape closing the
  rail with the fold still open behind it and the card still open; a press on the title still folding the card; two
  assistants under one initiative each showing only its own rows; one tree under two initiatives showing the same
  task once in each; a task on an unattached tree appearing nowhere; an initiative with no rows saying so in words.
- A PR with a page is not exercised in that sandbox, where no remote resolves one: the fixture test covers the board
  row's own `prUrl`, and the gate proves the honest absence - no dead link when there is no PR.
- `npm test` - 3240 tests, 3231 pass, 9 fail. The nine fail on the base too: a `git archive 7a374c59` export run
  over the same nine files answered **71 tests, 62 pass, the same 9 failures** (`assistant-profile`,
  `assistant-search-scroll`, `child-route`, `gateway-permissions` - the gitignored `config.json` it reads at module
  load - `header-controls`, `paths`, `paths-http`, `reasoning-runs`, `scan-roots`). The branch's own tests pass in
  the full run.

## The landing

The branch was cut from `7a374c59` (the 1.125.0 landing note), which was `origin/main` at the time, and carried one
commit, `d932a563`: 8 files, +1015/-14. It was one commit because of the push gate - the first push was refused by
`.githooks/pre-push` for four drive-letter fixture paths in the new test, and that scan reads the TREE of every sha
being sent, so the repair has to be in the same commit as the fixture. `git reset --soft origin/main` folded the
repair into the landing commit, the claim's tag was re-created with `version.mjs tag` and force-pushed over the
unpublished one, and `node tools/absolute-paths.mjs --rev HEAD` then read `clean - 1819 files at HEAD`.

`gh pr create --fill` opened **PR #800** against `main` with that commit and `mergeable: MERGEABLE`; the PR's own
`gh` needs the token this box keeps in `GITHUB_PAT_JLR`, so every `gh` call ran with `GH_TOKEN` set to it. The body
is the commit message verbatim (one commit, so `--fill` copies it), and it is ASCII with no long dashes.

`npm run land:pr -- 800` merged it `--rebase --admin` and did the rest in one command:

- the PR read `MERGED - merge commit cb0bc37`, which on a `--rebase` merge is the re-created landing commit, not a
  merge object;
- the primary checkout fast-forwarded `7a374c5 -> cb0bc37`;
- `version.mjs tag --ref` moved `v1.126.0` `d932a56365 -> cb0bc37ab8 on origin (--force)` - the commit that first
  declared the number - and read it back;
- `land: committed 6d25db7 - docs: render the changelog - 642 releases` and pushed `main` with `--no-verify`, the
  documented exception for a render that spends no version.

The branch was then rebased onto the merged tip (`git rebase origin/main` answered `skipped previously applied
commit d932a563`), so it sits at `origin/main` with no diff of its own.

`node tools/verify-version-tags.mjs --ref origin/main` - 642 version bumps, 637 tagged and annotated at the commit
that first declared them, and the same 7 findings among older releases that `main` already carried (1.126.0 is not
among them). `node tools/changelog.mjs --check` - `CHANGELOG.md is current - 642 releases`, whose `## v1.126.0`
section is anchored at `cb0bc37a`.

## This note's push

A docs commit on `main` that spends no version, so the pre-push version gate would refuse it: it is pushed with
`git push origin main --no-verify` for that reason, one commit above the render.
