# Landing: the auto-allowed review card is one summary line (1.148.0)

The card an auto-allowed write comes back as is the only record that the panel let a write through without asking.
At 1440 it measured 320px tall and 599 visible characters while stating the branch four times as a ref: in the
command block, in the allow-policy line, in the Unwind button's label (`Unwind - delete remote branch origin/...`)
and in the unwind prose under it. A fifth time rode in as the bare slug, inside the command's own `from <tree>`
tail. The parts a reader scans for - the action, the sha, the time - were the hardest things on the card.

It is now a summary line and two controls, 141px tall with 124 visible characters: the action (`pushed`, `merge
started`, `unwound`), the branch, the repo, the short sha and when. Keep is the full-width green bar and Unwind the
red bar under it, and the branch is stated exactly once. The command, the worktree the write ran from, the
allow-policy and the exact inverse Unwind would run sit behind one muted `details` line, in the record's own words.

## What landed

- `public/app.js` - `remoteWriteReviewHtml()` rebuilds the card: `.rw-review-head` carries the action and the
  branch (`.rw-review-line`) with the repo, sha and age as a muted second line (`.rw-review-meta`), and the head's
  `title` keeps the untruncated line plus the exact clock. The record moves into a closed `<details>` with one
  labelled row per fact - `worktree`, `allowed`, `unwind` - and the unwound state's receipt sentence lives there
  too. The dock's click handler now skips `summary` and `details` beside the other controls, because the jump
  path's `preventDefault()` would otherwise swallow the toggle.
- `public/style.css` - the head as a wrapping flex line, the branch as the only item allowed to shrink
  (`direction: rtl` keeps its tail, the identifying part), the disclosure's summary and its labelled rows, and the
  command block's height cap inside the disclosure.
- `tools/verify-rw-review-compact.mjs` - the gate (below), a new browser harness.
- `tools/verify-approvals-dock.mjs` - the existing dock gate asserts the compact card beside the jump path it
  already covered, and its Unwind check reads the label and the Details body instead of the old prose.
- `package.json` - the gate's `verify:rw-review-compact` script.

## What proves it

- `node tools/verify-rw-review-compact.mjs --shots <dir>` at 1440 - **32 checks, 0 failed**, 0 page errors: the
  summary is one line naming the action, branch, repo, sha and when; the branch is stated exactly once; Keep and
  Unwind are drawn and hit-testable with the label alone; Details starts closed, opens on a press without jumping
  to an agent, carries the command, tree, policy and exact delete on three labelled rows, and closes again; Tab
  from Unwind reaches the Details line with a focus ring, Enter opens it and Space closes it; Keep still posts its
  decision. Screenshots: `01-before-1440.png` (the main build), `02-after-1440-closed.png`, `03-after-1440-open.png`
  in this folder.
- The same gate against `git archive origin/main` in a scratch export - **7 of 22 checks passed**, which is the
  before reading: card 320.0px tall and 599 visible characters, the branch four times as a ref, no Details
  element, the Unwind label repeating the branch, and the old prose element still there.
- `node tools/verify-approvals-dock.mjs` - **43 checks, 0 failed**; `node tools/verify-rw-keep-bar.mjs` - **42
  checks, 0 failed** (the Keep bar and the dismissed Dismiss control are unchanged by this card).
- `node --test test/remote-writes-review.test.js` - **8 tests, 8 pass, 0 fail**.
- `npm test`, once, before the rebase - **3390 tests, 3381 pass, 9 fail**. None is this branch's: `git diff --stat
  origin/main HEAD -- lib/ test/` is empty, and the three red files that read the page are red on the base too -
  `header-controls` fails the same pause-handler assertion on a `git archive origin/main` export, and
  `assistant-search-scroll` reads 10 pass 1 fail there, while `scan-roots` passes alone in the export (2 tests, 2
  pass) and only failed under the parallel suite. The other six (assistant-profile, child-route,
  junctioned-node-modules, paths-http, paths, reasoning-runs) touch lib modules this branch does not change.

## The version and the tag

`main` read 1.147.0 from the #629 accordion landing when this branch was rebased onto it, so the branch carries
1.148.0 - a minor, because the card gains a reader-facing affordance (the Details disclosure, with its keyboard
path pinned) and a new gate that can fail a landing. `v1.148.0` is an annotated tag on the commit `main` carries
that first declares the number.

## The landing

Squash merge, per the brief, and the changelog rendered at the merged tip afterwards. The review round on the
rebased branch resolved nothing: `public/style.css` and `package.json` both auto-merged, so the three public files
the brief expected to stop the rebase never did.

<the record is appended on main after the merge: PR, merge sha, main's tip>

## The clock

Nothing here starts a timer. The card is redrawn from the snapshot and from the `remote-write-review` frame, and
the age it prints is `fmtAgo(r.at)` on the same clock as the rest of the dock.
