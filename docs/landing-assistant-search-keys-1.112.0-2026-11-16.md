# Landing: the assistant search runs on the keyboard alone (1.112.0)

PR #775 lands a search you can drive without reaching for the mouse: `Ctrl+Q` puts the caret in the assistant panel's
turn search box with the filter selected, Up and Down step the current match one whole turn per press, the count
beside the box reads `n of N` over the matching items, Enter opens the current match, and `Esc` clears the filter and
hands the caret back.

Merge `41b6bd7`, tag `v1.112.0` at `59784ba`, `origin/main` at `74d1be5` (the render), `changelog --check` reads
current - 618 releases. What a reader can open: `docs/assistant-search-keys.md`, and the run's own pictures under
`docs/assets/assistant-search-keys/`.

## What was wrong with the old box

The box searched the right thing - the assistant's whole transcript, on the server, past the five turns a card
holds - but it was a mouse surface with a keyboard afterthought:

1. **Nothing could reach it.** `Ctrl+Q` was not bound to anything, so a reader with both hands on the keys had to Tab
   through the rail to find a 96 px input, and the filter it already held had to be deleted by hand.
2. **Down meant a row, not a message.** The list held one row per matching FIELD - the prompt, the reply, each console
   line - so `Enter` walked `openSearchHit((searchAt + 1) % searchHits.length)` through twelve rows of four messages.
   Four presses to leave one turn is not a step; it is a scroll with extra words.
3. **The count said `12/10`** - hits matched over rows displayed - which is a fact about the cap, not about where the
   reader stands. There was no current item at all: the list had no notion of one.
4. **`Esc` blurred the box** and left the caret nowhere in particular, and `Down` handed focus to the first result row,
   so the box and the list took turns owning the caret.

## The fix

`public/core/search-items.js` (new) is the hit-to-item map: hits are grouped by thread and turn id, the walk keeps the
order each item's first hit appears in, and `step()` wraps at both ends. It is published on `globalThis` as
`wtSearchItems`, loaded by `public/index.html` before `assistant.js` - the same contract `public/core/turn-search.js`
has - and unit-tested by `test/assistant-search-items.test.js` (7 tests: one turn's four rows are one item, one press
per item, the wrap in both directions, the same turn id on two threads staying two items, a hit with no thread or no
id not becoming an item).

`public/assistant.js` holds the rest: `Ctrl+Q` on the window handler, guarded on the panel being open and on the
caret not sitting in a textarea or the composer; `focusSearch()` remembering where the caret came from so
`escapeSearch()` can hand it back; `stepSearch()` clearing the debounce and landing on the first item rather than the
second when a press beats the answer; `revealSearchItem()` doing the reveal, the unfold, the mark, the scroll and the
ring for ONE item; and `paintSearchCurrent()` drawing the three surfaces that must agree - the turn's ring, the bright
mark inside it, and the `aria-current` rows of that item in the list. A repaint re-applies the ring without moving the
scroll, so a streamed line cannot drop the reader's place.

The count in `index.html` is unchanged markup whose text is now `n of N`, with `searchMatched`, `searchDisplayed`,
`searchItems`, `searchItemTotal` and `searchCurrent` on the element; the cap keeps its amber and says so in the title
rather than pretending ten rows are the whole answer.

`docs/assistant-search-keys.md` states the contract, including the wrap, which is the behaviour chosen over clamping
because `Enter` already wrapped.

## The proof

`node tools/verify-assistant-search-keys.mjs` boots this checkout's server on a free port with its own state directory
and a synthesized store - four turns whose prompt, reply and console line all match one filter, twelve rows in four
items - then drives the panel with key presses only in headless Chromium at 1440x900. **47/47 checks pass**, and each
one is a fact a reader can re-read in the pictures:

- the panel opens on `a`; `Shift+Tab` puts the caret on a control inside the rail;
- a cancelable synthetic `keydown` for `Ctrl+Q` answers `defaultPrevented: true` (the key is reported handled) and the
  box has the caret; a real press does the same, and a second one selects 0..6 of `zephyr`;
- typing over that selection leaves `zephyr`, not `zephyrzephyr`;
- the count reads `1 of 4`, `searchItemTotal` is 4 while 12 hits matched and 10 rows are displayed, and the rows carry
  items 0..3 with the current item's three rows marked;
- one `Down` per press gives `2 of 4`, `3 of 4`, `4 of 4`, each landing on the next turn id, inside the card body,
  with exactly one ring and the match bright inside it;
- `Down` on the last item gives `1 of 4` and `Up` from the first gives `4 of 4` (the wrap);
- with the current turn folded by `Ctrl+[`, `Enter` unfolds it, marks the match and leaves the count at `4 of 4`;
- `Esc` empties the box, hides the count and the list, drops every ring and mark, leaves the panel open, and puts the
  caret back on the control it took;
- `Ctrl+Q` is ignored in the reply composer and in the Pad pane's textarea;
- no page error was raised.

The screenshots are committed under `docs/assets/assistant-search-keys/` with `assistant-search-keys.json`, the run's
record of the filter, the viewport, the four turn ids and the item each press landed on.

`npm test` on the branch: **2950 tests, 2939 pass, 11 fail**. All eleven reproduce on `origin/main` from a `git
archive` of it, so none of them is this change's; they are `paths`, `paths-http`, `assistant-profile`,
`header-controls`, `child-route`, `gateway-permissions`, `reasoning-runs`, `scan-roots`, `windows-hide` and the
absolute-paths gate twice.

## The gate this landing had to clear first

The first `git push` of this branch was refused - not by the version check, by `tools/absolute-paths.mjs`: `main` was
carrying two drive-letter paths that the 1.111.0 landing added, one quoted in its own report
(`docs/reports/held-reply-restart-2026-11-16.html`) and one a placeholder in `tools/verify-held-reply-restart.mjs`.
Every push from every branch was refused until they were recorded, so this PR adds two `tools/absolute-paths.allow`
lines with their reasons rather than rewriting a landed record. Two of the eleven full-suite failures above were that
gate; they pass now (17/17).

The push itself then went through the hook. Nothing was pushed with `--no-verify`: the refusal was reported before any
bypass was considered, and the fix was made in the tree. The one `--no-verify` push in this landing's record is
`tools/land.mjs` sending the changelog render commit, which is the tool's documented path - every commit it sent
touches only `CHANGELOG.md`, and a render spends no version.

## Where it stands

- PR #775: MERGED, merge commit `41b6bd7`.
- `origin/main`: `74d1be5` (the render), `changelog --check` current at 618 releases.
- `v1.112.0`: annotated, on `origin`, peeled to `59784ba` - the commit that first declared the number.
- The worktree that did the work is clean and can be released.
