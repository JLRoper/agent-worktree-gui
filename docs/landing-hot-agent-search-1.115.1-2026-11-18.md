# Landing: the Hot Agent search, and the landing it had to hold (1.115.0 and 1.115.1)

Two releases, one note. PR #785 carried the Hot Agent search and merged as `ef815ebe`, but the run that landed it
hit its turn cap before it wrote its own record, so this is the single note for both: #785 (1.115.0) and #786
(1.115.1), the fix the first release's proof found afterwards.

`Ctrl+Shift+Q` opens a list of the turns you wrote to workers, beside the assistant search entry in the header, and
pressing a row lands you on that turn with the board and the transcript both where the ring is.

## 1.115.0: the list (PR #785, merge `ef815ebe`)

**The binding.** The chord is proven free across every handler in `public/` and `lib/`. The plain chord is already
taken at `public/assistant.js:6354` (`Ctrl+Q` without the shift), and no handler claimed the shifted form, which is
why the shifted arm sits at `:6344` and the plain one is untouched. The header button
sits beside the assistant search entry with a tooltip naming the shortcut.

**The popover.** It is the assistant search's own look, not a second design: the same count header and footer, the
same row shape, `Up` and `Down` to walk, `Enter` to open, `Escape` to close and to clear the filter, and the list
reopens at the newest turns. Only human turns enter the list - a worker's streamed output is not a reply you wrote -
and it opens on the last twenty.

**The reuse.** The popover, the keyboard walk and the scroller came out of the 1.114.3 fix rather than being copied
beside it, so the selected row stays visible in both bars: `public/core/hot-agent-list.js` and
`lib/hot-agent/search.js` sit under `routes/hot-agent-search.js`, with `test/hot-agent-search.test.js` and
`test/hot-agent-binding.test.js` pinning the shape. The assistant search's own proofs stayed green through the
extraction, and still do: `verify:assistant-search-scroll` 117 of 117, `verify:assistant-search-keys` 54 of 54,
`verify:assistant-search-order` 44 of 44.

`docs/hot-agent-search-keys.md` is the behaviour, and `package.json` gained `verify:hot-agent-search`.

## 1.115.1: the landing holds (PR #786, merge `bc08c36e`)

The proof the first release shipped with found two defects, and both were a class on the wrong thing: a node the
board replaces, and a race the lookup could lose.

**The landing gave up on a missing card.** `revealHotTurn`'s re-aim loop returned early when its card lookup came
back empty, and the board repaints on its poll while opening the row repaints the card, so a miss in that window
ended the loop before it ever scrolled. `Enter` then closed the list, rang the turn and left the reader at the top
of a page with the ringed turn a screenful away. One run in ten. The loop now looks again on every sample and runs
for the ring's own window, and `public/render-jobs.js` re-aims it in the render pass itself (`reaimHotHit()` after
`settleScrolls`), so a repaint that moves the card by a screenful is corrected in the same pass instead of at the
next tick. A reader who wheels, touches or presses a navigation key owns the page: the loop stops rather than
pulling it back under them.

**The flash could be setting nothing.** `flashHotCard` looked the card up first and returned when it was not there,
so a repaint between the lookup and the call left `state.hotFlash` untouched and the card arrived unmarked. It now
sets state before it looks for the node, the way the ring already did, and `jobHtml` draws the flash on whatever
card is there.

**The flaky proof this closed.** `tools/verify-hot-agent-search.mjs` failed one run in three on the branch's work,
and the landing inside it failed one run in ten, because the Enter step read the flash and the turn's geometry at
once and raced one of them. Each assertion is now judged at the moment it is due - the flash with the ring it is
drawn with, the geometry after the landing's own window - with the same assertions. This landing ran it five times
and reads 77 of 77 on four consecutive runs after the first; `test/hot-agent-landing.test.js` pins all of it from
the source: the card is re-read every sample, a miss is not an answer, the loop runs for the ring's deadline, the
renderer's anchor calls back, the reader's own input stops it, and the flash sets state before it looks for the
node.

## What proves it

`test/hot-agent-landing.test.js` 6 of 6. `verify:hot-agent-search` 77 of 77, 5 screenshots under
`docs/assets/hot-agent-search/`, keyboard only at 1440x900: open with the last twenty and the box focused, a typed
filter narrowing it, `Down` past the fold with the row visible, `Enter` with the turn highlighted and the flash
drawn, `Escape` closed with focus back on the button.

`npm test`, once, on the rebased branch: 3047 tests, 3034 pass, 13 fail. A clean `git archive` of `origin/main`
before the merge reproduces all 13 of those failures on the same files - and two more, which fail only because an
archive export carries no `.git` - so they are pre-existing and not this branch's. The four that `test:changed`
names on this diff (the paths gate, the scan-roots folder, the moved header control and the profile whitelists) fail
identically on that export.

## The landing

The branch held four commits over `origin/main` when this run started, and two of them (`a290181e`, `466d2e0d`) were
pre-rebase copies of work `main` already carried as `d3a4a2e4` and `ef815ebe` - byte-identical trees. Rebasing onto
`origin/main` dropped them by cherry-pick and left the fix, which landed as `f3273c95`, and the bump, `bc08c36e`.

`land:check` reads stale on the branch by design - every section links the base's shas, so the render is post-merge
and `tools/land.mjs` refuses to fold it into a bump commit. `gh pr merge 786 --rebase --admin` merged at `bc08c36e`.
`v1.115.0` was already at `ef815ebe`; `v1.115.1` still named the pre-rebase tip `151bb6d1`, and
`version.mjs tag --ref origin/main --force --fetch --push` moved it onto `bc08c36e` and pushed it, where
`refs/tags/v1.115.1^{}` peels to that commit. `CHANGELOG.md` was rendered at the merged tip as `bf66fb81` (629
releases) and this note follows it.

The primary checkout (the repository root this worktree hangs off, on `main`) fast-forwarded `286b5bfd` ->
`bc08c36e` before the render. It carried two modified files (`lib/assistant.js`, `test/element-assist.test.js`, the element-assist
worker's shortened-separator fix and its test) that are not this landing's and are still there, uncommitted; the
`tools/version.mjs` tag step was therefore run from the worktree, which is clean, rather than forcing a stash over
someone's live work. The stash `stash@{0}` from the PR 716 landing is untouched.

The PR was opened with the token in the user environment (`GITHUB_PAT_JLR`) because `gh` itself holds no token on
this box. Its title and body were repaired with `gh pr edit` before the merge, so the history reads
`fix(search): the Hot Agent landing holds while the board repaints - 1.115.1` rather than the branch slug, and the
body carries the proof.
