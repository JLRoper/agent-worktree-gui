# Landing: the Element pick parser reads the glued shorthand and a numbered pick's own words (1.123.1)

PR #797 merged into `main` as `a3cbc8af`. 81 uncommitted lines that had been sitting in the primary checkout on no
branch are now a landed fix, with the tests that pin it.

## What landed

- `lib/assistant.js` (`ElementChannel`, around line 9045) - the pick parser took a letter, or a wait number and a
  letter, but only with a separator between them: the form the wait message itself tells the reader to send (`4A`) was
  the one reply it dropped, and the message said so. It also wanted the whole message to be the pick, so a NUMBERED
  reply carrying a sentence after the letter (`530B. use javaorcl_two instead`) was filed as prose and the wait expired
  unanswered. Both are read now. A numbered pick's own words travel WITH the option's value, on a copy of the choice so
  a reask still offers the card's own wording, and an unnumbered one-letter opening (`I think ...`) stays prose - the
  number is what makes a short reply unambiguous.
- `test/element-assist.test.js` - three cases: the documented glued shorthand answers its wait, a numbered pick with
  the reader's sentence appends that sentence to the value, and prose that merely opens with a one-letter word is not
  a choice and leaves the wait open.

## Where it came from, and how it got here

The primary checkout carried those two edited files at 14:33 today, on `main`, committed to nothing. The first act was
to write them out of reach of any pull, checkout or landing:

    git -C C:/ProjectDevelopment/agent-worktree-gui diff \
      > C:/Users/roper/AppData/Local/Temp/wag/7f8cba35/primary-uncommitted.patch

sha256 `35a61c6b1b85590cc414b3713113c6bee1a2f166a813389246ddfef036f74c84`. A landing tree was cut from `main`
(`467fe21d`), the patch applied there cleanly (2 files, 81 insertions, 11 deletions), and this PR is that change. The
primary's two files were then reverted with `git checkout --`, the tree fast-forwarded to `a3cbc8af`, and
`git apply -R --check` of the saved patch against the merged `main` exits 0: the landed files ARE the uncommitted
edits, and the patch is the record of what the primary carried.

## Why it is not a duplicate

`main` carried the separator-only regex at `lib/assistant.js:9049` (`[\s.:-]+`, with a `$` that forbids trailing
words), none of the three tests, and `git log -S"const noted = pick" main` came back empty.

## What proves it

- `node --test test/element-assist.test.js` on the branch - 13 tests, 13 pass, the three new ones included.
- The same test file against `main`'s `lib/assistant.js`, exported with `git archive` and nothing else changed - 13
  tests, 11 pass, 2 fail, both new parser cases reading `actual: []`: the reply produced no answer at all.
- `node --test test/element-assist.test.js test/clarify-accept-path.test.js test/clarify-answer-reuse.test.js
  test/clarify-reask.test.js` - 35 tests, 35 pass.
- `npm test` - run once before the PR and it did NOT answer: it was still running at 26 minutes on a host carrying
  several other agents' suites, so it was killed at the standing 20 minute cap with no counters printed. The bounded
  sets above are what answered, and `test/element-assist.test.js` is the only test file in the repo that names
  `ElementChannel`, `createBridgeChannel` or the bridge at all.

The version is `1.123.1` (patch: a fix to behaviour the panel already promised, no new surface and nothing moved). The
annotated tag `v1.123.1` sits at `a3cbc8af`, the commit that first declares the number; `origin/main` is at the render
`14c1ff5` above it, and `git diff --stat a3cbc8af origin/main` lists only `CHANGELOG.md`.
