# Three open docs/harness PRs landed in order: 0.46.4 → 0.46.7

Landed **2026-11-01**, one endpoint each, in the order the brief named: **#170**, then **#171**, then **#169**. None of
the three touches `public/` or `lib/`: each carries a document and/or a measuring tool plus its own patch bump. This
branch carries this record and a patch bump only — the landing itself is the three merges below.

| # | branch | what it lands | version | merge commit |
|---|---|---|---|---|
| 170 | `wtgui/write-read-only-bounce-count-slot-b-repo-01e39b` | `tools/measure-console-writes.mjs`: closes the typed window at `--seconds`, records what the gesture did | 0.46.5 | `788a7a8f72cd40c7849334e5a881b3cbc41a7e9f` |
| 171 | `wtgui/reproduce-console-scroll-jump-on-port-73-24ca82` | `docs/console-frames-7393-0461.md` + `tools/measure-console-expand-frames.mjs` | 0.46.6 | `4ea03f7d617b40ffb72576169b0ff576c6f6e399` |
| 169 | `wtgui/measure-read-only-bounce-count-for-slot-1c2c38` | `docs/console-bounce-manual-7391.md`: a read-only 60 s window on `b499c61` | 0.46.7 | `b1c5bd294a6a804a540722ae31dd345d76805175` |

## How each rebase resolved

All three branches were cut from `dac78f1` (0.46.3) and bumped themselves to **0.46.4** — the same number main's own
`21aa536` took. So the version line was the only thing that could conflict, and it behaved differently per branch:

- **#170** — `git rebase origin/main` finished with **no conflict at all**: both sides wrote `0.46.4`, so the bump was
  the same change and git dropped it silently. The rebased commit carried `tools/measure-console-writes.mjs` only,
  and `package.json` read main's number. The branch was re-bumped on main's number (`node tools/version.mjs apply
  patch`, 0.46.4 → 0.46.5) and folded into the same commit, which is why its tip is `cc46488` rather than the
  rebase's own hash. The silent drop is the documented trap: a dropped bump leaves a branch the pre-push gate refuses
  as unbumped while `git log` shows the bump subject.
- **#171** — one `UU package.json` block (main `0.46.5`, branch `0.46.4`), resolved to **0.46.6** (`67bfb9e`).
- **#169** — one `UU package.json` block (main `0.46.6`, branch `0.46.4`), resolved to **0.46.7** (`223d5f7`).

**No conflict outside `package.json` in any of the three**, so nothing stopped for the brief's report rule. Each branch
was pushed with `--force-with-lease` (a rebase rewrites the published tip) and merged with `gh pr merge --rebase
--admin`; each PR reads `MERGED` naming the commit above.

## Checks

`npm test` (`node --test --test-concurrency=4 test/*.test.js`) was run on each **rebased** tree, before its push:

| tree | tests | pass | fail | duration |
|---|---|---|---|---|
| #170 (0.46.5) | 661 | 661 | 0 | 52.6 s |
| #171 (0.46.6) | 661 | 661 | 0 | 57.1 s |
| #169 (0.46.7) | 661 | 661 | 0 | 54.1 s |

`node tools/version.mjs check` exits 0 in each tree, and each branch tip is byte-identical to its own merge commit
(`git diff <tip> <merge-commit>` empty), so the tree the suite passed is the tree that landed.

## The three trees removed afterwards

From the primary checkout, after each branch was proven identical to its merge commit and that merge commit proven an
ancestor of `origin/main`:

- `.worktrees/write-read-only-bounce-count-slot-b-repo-01e39b` — branch tip `cc46488`
- `.worktrees/reproduce-console-scroll-jump-on-port-73-24ca82` — branch tip `67bfb9e`
- `.worktrees/measure-read-only-bounce-count-for-slot-1c2c38` — branch tip `223d5f7`

`git worktree remove` (no `--force`; all three were clean) then `git branch -D` on each local branch:
`git worktree list` went from 13 entries to 10, and all three branch refs are gone. Their **remote** refs were left in
place — the brief scoped the cleanup to the primary checkout. Four directories under `.worktrees/` that carry no
`.git` file (`add-a-watchdog-rule-that-ae99fd`, `rename-the-assistant-flo-9956b3`, `research-whether-a-long-cdb279`,
`restructure-the-assistan-317839`) were left untouched: they were not registered worktrees before this run and are not
part of it.

PRs **#115** and **#18** were not touched.

## Re-verification, same day — a second landing tree

A second landing brief, cut from `main` after #173 merged, asked for the same four steps again: rebase #170 → 0.46.5,
#171 → 0.46.6, #169 → 0.46.7, then remove the three trees and branches. Nothing was left to do. All three PRs already
read `MERGED` and both the worktrees and the local branches were already gone, so this tree re-checked each claim
against the remote and the checkout instead of re-landing anything. No PR was reopened, re-pushed or edited.

Read from `origin/main` `8e7c01e` (0.48.3) on 2026-11-01 at 18:20 EST:

| # | `state` | merged | merge commit | `package.json` at that merge | ancestor of `origin/main` |
|---|---|---|---|---|---|
| 170 | MERGED | 16:02:06Z | `788a7a8f72cd40c7849334e5a881b3cbc41a7e9f` | 0.46.5 | yes |
| 171 | MERGED | 16:03:49Z | `4ea03f7d617b40ffb72576169b0ff576c6f6e399` | 0.46.6 | yes |
| 169 | MERGED | 16:05:20Z | `b1c5bd294a6a804a540722ae31dd345d76805175` | 0.46.7 | yes |

- `gh pr view <n> --json state,mergeCommit` reports MERGED with the same oid for each of the three, so the versions in
  the table are the numbers each branch carried into main, not main's current number.
- `git merge-base --is-ancestor <merge> origin/main` is true for all three: the work is on main, and later landings
  (0.46.8 through 0.48.3) sit on top of it.
- `git worktree list` holds 7 entries and none of them is one of the three trees; `.worktrees/` has no directory
  ending `01e39b`, `24ca82` or `1c2c38`, registered or orphan.
- `git rev-parse --verify --quiet refs/heads/<branch>` is empty for all three local branches.
- The three **remote** refs were left in place, because the first brief scoped the cleanup to the primary checkout.

This branch therefore carries this re-verification and a patch bump only. The three merges and the three removals
recorded above belong to the earlier landing (#173); repeating them would have meant re-pushing already-merged
branches. The suite below was run on **this** tree, so the record's own commit is covered by a green run.

### Checks

`npm test` (`node --test --test-concurrency=4 test/*.test.js`) on this tree at 0.48.4, before the push:

| tests | pass | fail | skipped | duration |
|---|---|---|---|---|
| 706 | 706 | 0 | 0 | 59.4 s |

The three trees of the first landing each ran 661 tests; main has gained 45 since, which is why this number is higher.
