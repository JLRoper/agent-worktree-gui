# Landing: the Hot Agent search in the floating header, behind a hand and a pen (1.124.0)

PR #798 merged into `main` as `1026bbf1` (rebase, two commits: `620b8ace` the move, `1026bbf1` the bump). The button
that searches the turns you wrote to worker agents - `Ctrl+Shift+Q` - is now a control in the floating header, icon
only, between `✧ Assistant` and `🙋 Human`. It wears a drawn hand holding a pen. The bolt is gone.

## The claim that was not true

The 1.117.0 landing note said this button had moved to the header beside Human. It had not. `git log -S ha-search-open`
showed one commit, the original feature, and the button was still at `public/index.html:1051`, inside the assistant
panel's title row, a bolt among the panel's own controls. A reader who followed that note looked in the header and
found a different bolt - `#btn-hot`, the Hot Agents marker, which ships hidden and is drawn only while an agent works.
Two bolts, one of them a search, and the note pointing at the wrong one. This landing is the move the note described,
made in code.

## What moved, and what did not

The opener `#ha-search-open` is now a child of `.topbar .controls`, between `#btn-assistant` and `#btn-human`. `#btn-hot`
still sits in that row and still ships hidden, so the visible order is assistant search, this one, Human - as asked.

What did not move is the thing it opens. `#ha-search-pop` is still in the assistant's aside, still built by
`public/core/search-popover.js` - the same popover, the same list, the same scroller the turn search uses - and the
handler in `public/assistant.js` still lands in the same place. The assistant's own search box was not touched: its
input, its scope chips, its buttons and its handlers are the ones that were there. What is there is a comment in that
file naming the new location, and nothing else.

## The glyph

An inline `<svg>` on a 16-unit grid, drawn at 16px in `currentColor`: three fingers, a palm, a thumb, and a pen whose
shaft is as heavy as the fingers and whose nib emerges from under the palm. 16px because that is the line box the emoji
labels beside it render at, and the button keeps the family's 28px height, 6px radius and 1px border - the row does not
grow. Its `title` and `aria-label` still name `Ctrl+Shift+Q` and still say the corpus: the turns you wrote to worker
agents, across every project tree.

Four fingers and a 1.2-wide pen were what landed first; at 16px the fingers read as a comb and the pen as a stick
laid across it. Three fingers and a 1.5 shaft were tried beside the first, in the header's own CSS at 1x and 2x, and
won.

## What proves it

- `test/hot-agent-header.test.js` - 4 of 4. The DOM order (assistant search, this control, Human), the drawn glyph and
  its labels, and both halves of the untouched assistant bar: `as-search-q` and `as-search-scope` still inside it, and
  no opener anywhere in the assistant's subtree.
- `tools/verify-hot-agent-header.mjs`, `npm run verify:hot-agent-header` - 25 of 25 checks in headless Chromium at
  1440x900. The order on screen with nothing visible between the three; the glyph drawn (7 shapes, 2 stroked) at the
  emoji's own height; all seven header buttons at one height, radius and border; a click opening the rail and hanging
  the popover under THIS button (right edges within 6px, first row 3px below the button); Escape closing it and
  returning focus; `Ctrl+Shift+Q` opening it from the board with the rail closed; and `Ctrl+Q` still landing in the
  assistant's turn search.
- Five pictures and the run's own record in `docs/assets/hot-agent-header/`: the header with the three controls, the
  glyph close-up (that one at 2x on a page of its own - a 16px glyph needs the enlargement; every other shot is
  exactly 1440x900), the panel opened from the header, the chord from the board, and the assistant bar intact.

## The version, the tag, the changelog

1.124.0, bumped after the move, before the sweep. Tag `v1.124.0` at `1026bbf1` - the commit that declares the version -
moved there by `npm run land` after the merge, as the tag on the branch pointed at a commit the rebase replaced.
`CHANGELOG.md` rendered at `d740371`: 640 releases.

## What is not in this landing

- The full suite, run once at the branch tip: 1355 passing, 7 failing in 6 files. All seven are red on `main` already
  and none of them is this landing's: `test/paths.test.js` twice (the allowlist, and a commit's own allowlist),
  `test/header-controls.test.js` (the Pause control's `connect()` - `main` has `connect({ waitForSnapshot: true })`),
  `test/assistant-search-scroll.test.js` (`if (!keepList) {` - `main` has `if (pop && !keepList) {`),
  `test/assistant-profile.test.js`, `test/child-route.test.js`, `test/child-tree.test.js`,
  `test/gateway-permissions.test.js`. Every one of those files is byte-identical to `main`'s, and the assertions that
  fail quote `main`'s code, not this branch's.
- `tools/absolute-paths.allow` gained one line for the 1.123.1 landing note, which quotes the command that wrote the
  primary's uncommitted patch out of reach. Without it the pre-push hook refused every push carrying `main`, including
  this branch's. The note is a record of what ran, so the line is the allowlist entry and not a rewrite.
