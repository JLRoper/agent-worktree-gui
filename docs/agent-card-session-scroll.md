# The agent card's own scroller

The card's conversation pane has two scroll bars in it: the turn console's own, and the card's. Only one of them was
ever followed.

## The symptom

In the agent card, a long streaming turn was appended **below the fold**. The reader watched the pane fill up and then
stop: the new lines went past the bottom edge, the text never moved up, and the only way to see the newest line was to
drag the session scroll bar down by hand. The turn console's own scroll bar followed correctly the whole time, which is
what made it look like the stream had stopped.

## The seam

Two boxes can scroll a card's conversation, and the stylesheet decides which:

| where | the scrollport | the console inside it |
| --- | --- | --- |
| the docked Chat pane - `.as-subpane[data-subpane="chat"] > .job > .job-body` | `.job-body` (`overflow: auto`, public/style.css:4176) | `max-height: none`: drawn at its content height, so it never overflows |
| a maximized card - `.job.maximized .job-body` | `.job-body` | the same |
| a card on the board | the `pre.job-out` (a size the reader can grip) | the console |

So in the pane and in a maximized card the console reports `scrollHeight === clientHeight` and every follow path in
the page returned without moving anything: `stickConsole` (the per-console pin), `stickSoon` (the append path),
`drawJobLine`, and the 400 ms sweep all ask the CONSOLE. The card body grew and nothing asked it to follow.

The body has never been written by the panel: `setScroll` was only ever given consoles, and the reader's scroll events
were only read for `pre.sub-console`, `pre.job-out` and `.think-body`. That is the whole defect: a scrollport with no
owner.

## The rule

`public/board/console.js`, the section headed "the card's session scroller":

- `isCardScrollport(body)` names the two bodies the sheet makes `overflow: auto`, from the markup rather than from
  `getComputedStyle` - this is asked once per appended line per console, and a style read there is the cost the rest of
  this section exists to avoid. Anywhere else `.job-body` is `overflow: visible`, a `scrollTop` write on it moves
  nothing, and it is never armed.
- `noteCardBodyScroll(body)` is the body's own answer, measured on its scroll event: within `CARD_TAIL_PX` (8 px) of
  its foot. It lives on the node (`_atBottom`), exactly like a console's, so the per-line path never reads layout.
- `stickCardBodySoon(el)` is called by every path that grows a turn - `stickSoon` (streamed and typed lines),
  `stickSubConsole` (a docked child console), `stickThinkBody` (a reasoning block) - and batches at most one write per
  body per animation frame. It asks the body first and returns if the reader is not at its foot.
- `stickCardBody(body)` is the one-shot form for a pass that runs after layout settles (`settleScrolls`, two frames
  after a rebuild), because a "go to the bottom" written before the paint is clamped short of the height the card ends
  up with.

The reader's own scroll is what sets `_atBottom`, in `public/app.js`'s one scroll listener: a `job-body` branch next to
the sub-console branch, behind the same `selfScrolled` / `justPlaced` / `readerInputHere` gates every other box uses, so
a write the panel made itself can never be read as the reader leaving the foot and a wheel in another card cannot
decide this one.

The panel's own pins write through `setScroll`, so the box remembers where it was put: `pinChatToBottom` in
`public/assistant.js`, and the pane rebuild in `renderAssistantChat` (which restores a scrolled-up reader's offset and
re-measures `_atBottom` from the box it just placed, so the next streamed line cannot drag them down).

## The way back

`paintToBottom(box)` used to answer only for a console. A console in the pane cannot scroll, so its chip could never be
shown and could never move anything - measured on `main`, **0 of 2** wraps in the pane offered the chip. Now the newest
console in a card body speaks for the body and carries the pane's one chip, and pressing it re-pins the body and jumps
it, the same way it re-pins a console.

The chip also had to be reachable. It was `position: absolute; bottom: 9px` of the turn's wrap, and in the pane a turn is
taller than the viewport, so it sat below the fold. In the two card-scrollport layouts it is `position: sticky` at the
scroller's foot instead (public/style.css, "the chip in a pane that scrolls its card"). In the pane the foot is not the
scroller's edge: the composer is itself `position: sticky; bottom: 0` inside the same body (public/style.css:4199), so
the chip rides above it on `--reply-h`, the composer's height, written once per size change by `watchPaneFoot`
(public/assistant.js) - a ResizeObserver, not a read per line.

## The gates

- `test/agent-card-scroll-pin.test.js` - the shipped functions read out of the page and driven with the browser's own
  two rules (`scrollTop` is clamped to `scrollHeight - clientHeight`; assigning it is a write). It asserts that the body
  moves when the console cannot, that 4 px off the foot still follows and 40 px does not, that forty streamed lines move
  a scrolled-up reader by nothing at all, that an `overflow: visible` body is never armed, that a maximized card is, and
  that the newest console is the one carrying the chip.
- `tools/verify-agent-card-pin.mjs` - headless Chromium at 1440x900, the assistant attached as the side panel, a
  throwaway panel and a stub Runs API streaming a long turn (a reasoning stream, then a long answer), and samples taken
  in the page every 60 ms: `scrollTop`, `clientHeight`, `scrollHeight` of the pane.

  On this branch, twice, 26 checks held each run, 253 and 254 samples:

  ```
  PASS  PINNED: every sample is on the pane's foot - worst gap 0 px over 75 samples
        pane 584 px tall, content 825 -> 2292 px
  PASS  A READER WHO SCROLLED UP IS NOT MOVED: scrollTop does not shift - moved 0 px over 71 samples
  PASS  a reader can hit the chip where it is drawn - button.tail-chip at 1217,762
  PASS  THE WAY BACK: gap 2124 px -> scrollTop 1257 -> 3450
  PASS  and it is pinned again - worst gap 0 px
  ```

  Against `main`, same harness, same stub, `--root` at a `git archive` of it: **5 of 25 checks fail**, and the first of
  them is the report itself - `worst gap 1765 px over 76 samples` while the pane grew 1484 px (content 865 -> 2349 px),
  and `0 of 2` wraps offering a chip.

  ```
  node tools/verify-agent-card-pin.mjs --root <dir>   # <dir>: a git archive of the build to compare
  ```

## What this does not change

The console's own pin, the sub-console strips, the reasoning bodies, the rebuild bookkeeping and the 400 ms sweep are
untouched. A card on the board keeps exactly the behaviour it had: its `.job-body` is not a scrollport, `cardBodyOf`
answers null, and nothing is read or written for it.
