# Landing: the floating header's fourth control, every clarify question answered and greyed (1.127.0)

PR #801 merged into `main` as `f28675b4`, and the render that followed is `e8912b16`. The header carried three
controls - the assistant search, the Hot Agent pen and Human - and the clarify history had no door: once a
question's card settled, the question left the page. A purple Clarify button now sits fourth, after the pen and
before Human, and opens the persisted history of every question: unanswered rows in full colour with their
choices and an unanswered marker, answered rows greyed with the answer the reader chose as the row's strongest
element, and a cancelled or timed-out card saying so in words rather than greying as answered.

## What landed

- `public/index.html` and `public/style.css` - the fourth control (the header's own violet, `rgb(163, 113, 247)`,
  with a purple border rather than the grey the other controls use), the popup's markup, and the stale-page guard
  that names the build when a control is not wired.
- `public/clarify-history.js` and `public/core/clarify-history.js` - newest first, one row per re-asked prompt, the
  three states, the cap said honestly ("showing 50 of 60" with show-all), resize and drag with the rectangle
  remembered in the same localStorage store the deliverables popup uses, Escape, a press outside, arrow stepping
  and Enter, and no clipping at 768.
- `lib/clarify-history.js` and `routes/clarify-history.js` - the store behind it (`clarify-history.json` beside
  `jobs.json`, cap 400) and `GET /api/clarify/history`, so a restart does not empty the history and a settled
  question does not lose its text.
- `lib/jobs.js` - the ask recorded when it arrives, the answer, who and when as it settles, and a cancelled or
  timed-out question recording why.
- `public/app.js` - a row press opens the agent that asked, pages the asking turn in as the current context when
  it is not the one on screen, centres and rings the question with the first answer control under the caret, and
  washes the agent's row with the worktree links' own flash in the header's violet.
- `test/clarify-history.test.js` (11 tests) and `test/hot-agent-header.test.js` (its order test now names four
  controls); `tools/verify-clarify-history.mjs`, wired as `npm run verify:clarify-history`.
- 22 files, +2482/-40 across the two commits.

## The version and the tag

The version moved in the commit that carries the feature: `08768a53` wrote 1.127.0, and the rebase merge
re-created it as `16ef0f9a`. No separate bump commit was owed - `node tools/version.mjs check` read `1.127.0`
against `origin/main`'s `1.126.0` with `2 commits to land on top of origin/main`, and the pre-push gate accepted
the branch.

`v1.127.0` did not exist before the landing, on this checkout or on origin. The landing created it as an annotated
tag at `16ef0f9a`, the commit whose `package.json` first declares the number (its parent reads 1.126.0), and
pushed it: tag object `4a4eee82c9b79fb791bea241b0b9574fbaf26b58` peels to
`16ef0f9af13baaf6f95151e59be033a0ef836a0a`.

## What proves it

- `node --test --test-concurrency=4 test/clarify-history.test.js test/hot-agent-header.test.js` - 15 tests, 15
  pass, 0 fail.
- `npm run verify:clarify-history` - **50/50 checks passed**, 0 page errors, 0 console errors, at 1440x900 and
  768x900. The gate walks the order and colour, the answered/unanswered pair, a press landing on the asking turn,
  the remembered rectangle, the keyboard, the 768 width, and a restart that does not empty the history.
- `node tools/verify-version-tags.mjs --ref origin/main` - 643 version bumps, 638 tagged and annotated at the
  commit that first declared them, and 1.127.0 is absent from the findings. The 7 findings it still prints are the
  ones `main` already carried before this landing (the same 7 at 642 bumps, 637 tagged): two backwards moves at
  1.76.13 and 1.79.0, wrong-commit for 1.76.22, 1.76.23, 1.91.2 and 1.92.4, and `missing v1.82.2`.
- `node tools/changelog.mjs --check` - `CHANGELOG.md is current - 643 releases`.

## The landing

- `git fetch`: `origin/main` was `cc538d39` (1.126.0) and the branch was 0 behind, 2 ahead, so no rebase was
  needed and nothing was pushed before the merge.
- `npm run land:pr -- 801 --check` read `would proceed`; the real run printed `PR #801 is MERGED - merge commit
  f28675b`, fast-forwarded the primary `cc538d3 -> f28675b`, created the tag at `16ef0f9af1`, and rendered
  `e8912b1 - docs: render the changelog - 643 releases`.
- This note is the second half of the docs pair and was committed on `main` after the merge, the changelog render
  being the first. It names no machine path: the pre-push absolute-path gate reads the pushed tree, and a relative
  path is the only one a reader can open anyway.

## This note's push

A docs commit that spends no version. The version gate exits 0 for a base push whose number equals the base's, and
`land.mjs --check` reads the changelog current, so this note went to `main` through the hook, with no
`--no-verify`.

## Where it stands

- PR #801 is **MERGED** (2026-11-19T23:32:34Z); merge commit `f28675b4ae6a370f9418358790456809b6aeba04`.
- `origin/main` is at the render, `e8912b16`; this note is one commit above it, which is the established shape.
- `v1.127.0` is annotated and peels to `16ef0f9af13baaf6f95151e59be033a0ef836a0a`, the commit that first declared
  the number.
- `changelog --check` reads current at 643 releases.
- The landing worktree is clean at `b10bb969`; the merge re-created its two commits on `main` as `16ef0f9a` and
  `f28675b4`, so that sha names history only the branch has.
