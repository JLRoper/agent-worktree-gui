# The console's draw order: one queue, one clock, one writer

A fast run's console jumped, reset and arrived out of order. The reason was not the rate. Three roads fed the same
drawer - `reasoning.delta` as a cumulative preview, the answer as `text`/`set` blocks grown in place, tool output and
results as whole records - and each road had its own word clock, its own idea of when to start, and no stamp the other
two shared. Five fixes each mended one road and left the number of clocks alone, so the defect they were all chasing
was still there afterwards.

## 1. What each earlier fix did, and why the ordering survived it

| commit | what it fixed | why the ordering defect survived |
| --- | --- | --- |
| `478fb6d9` | A store poll re-typed live reasoning from word 0: a rebuild drew the block from its first word instead of the prefix already on screen. | It compared the block's text with what was drawn and kept the prefix; the pacer still held ONE entry per line with its own clock, and the three roads still had no order between them. |
| `33ad603f` | Reasoning arrived live at all: `reasoning.delta` was streamed into the thinking pane with a live placeholder, instead of the thought appearing whole when the turn ended. | It added a third source with its own timing and no shared stamp, so the thought could now race the answer's blocks as well as the tool lines. More sources, same number of clocks. |
| `85acc74e` | A line could stop at its own top: when the pacer answered `null` (the record had moved past the wire) the row kept the prefix it was built with, and `flushJob` only returned lines that still had words queued. The record is now drawn when the stream stops answering, and a settle repaints every line of the turn. | It changed what is drawn when the clock says nothing. It did not change who owns the clock, so a settle still released N lines that had each been typing in parallel. |
| `9d5a857f` | Latency: reasoning was pushed to the pane immediately and the poll and resync delays were cut, so the thought did not wait seconds for a poll to find it. | A shorter delay means more interleavings of the three roads, and nothing carried an order between them: the frames arrived sooner and still arrived out of order. |
| `088a4ede` (PR 736) | One store line carrying several markdown blocks drew only its first block: the block loop paired STORE lines with PHYSICAL lines and dropped the rest (86 characters drawn of 4,446). | Completeness inside one line, not order between lines. It is kept, and its test stays green. |

## 2. The design: the drawer owns the order, not the wires

`public/core/type-stream.js` now has one queue, `createDrawStream`, and everything a console reveals joins it. A
SEGMENT is one paragraph of the agent's words, one reasoning block, one tool line, or one line of a skill's result -
whatever the wire's unit happened to be.

- **Sequence numbers and a stamp.** Each segment carries the server stamp of the thing it draws (`line.at`, a
  reasoning block's `at`, a tool record's `at`) and a client-side arrival sequence. The queue's order is `(at, seq)`:
  the stamp decides where a segment belongs, the sequence only breaks a tie, and a segment with no stamp takes the
  newest stamp its card has so it stays where it arrived. Insertion is by that key, so a frame that reaches the page
  late with an earlier stamp (a reply's reasoning arrives from the store after the tool call it made is already on the
  wire) takes its ordered place. `stats().late` counts the one case an order cannot undo - text already emitted for a
  segment that now stands after the newcomer - rather than hiding it.
- **One clock.** One budget of `rate` words a second is spent in transcript order: the earliest segment with words
  left takes them, and the next one gets what is left over once it has caught up. Before, N live lines each received
  the reader's full words-a-second, so a fast run typed at `rate x N` and the line fed last could finish first. Now
  the reader's setting is the rate of the whole drawer, not of each line in it.
- **One writer, append only.** `shown` is the stream's own watermark per segment, and it only ever grows. The writer
  asks `shownFor(key, record)` for a prefix of the record, never for a number derived from the DOM, and `drawRowText`
  appends the tail to the row's own text node. A segment that is rewritten (a trim moved the line, a replayed frame
  changed it) is replaced in one paint and counted (`rewrites`, `replaced`) instead of being typed out again.
- **No ancestor repaint can reset it.** The pane, the card rebuild, the docked rail and the raw view all read the
  same watermark, which lives in the stream, not in the DOM. A board poll, a rail resize or a focus-mode toggle
  repaints the ancestor and draws exactly the characters that were already emitted: it cannot draw less (the row is
  rebuilt with the watermark) and it cannot reorder (the watermark is per segment, and the segment's position is the
  queue's). Nothing in the typed path reads a box - no `offsetWidth`, no `clientWidth`, no `getBoundingClientRect`,
  no `matchMedia` - so width is CSS and never a clock.

The line gate and the reasoning hold stay, with narrower jobs: the gate decides ADMISSION (how many whole lines may
join at once), the hold keeps a tool's lines behind the thought in front of them. Neither decides how fast words
appear any more.

## 3. What is pinned

- `test/type-stream.test.js` - the queue's order across the three kinds, one budget spent in order, a watermark that
  only grows, a rewritten segment replaced rather than retyped, a late earlier stamp taking its place and being
  counted, a settle releasing one card's segments only.
- `test/console-ordered-stream.test.js` - a long run (20 thoughts, 20 paragraphs, 20 tool records, fed scrambled and
  grown in three frames each) drawn through the shipped renderer: the rendered characters equal the stored ones, the
  segments sit where the store puts them, the stream emitted each character once (`rewrites: 0`, `replaced: 0`,
  `emitted` equal to the transcript's length), a full repaint at every tick only ever extends what was drawn, the
  writer appends each character once, and a narrow rail and a wide pane draw the same string.
- `test/console-multi-block-line.test.js` - `088a4ede`'s fix: one store line carrying several markdown blocks draws
  every block, and the rows read back character for character.

## 4. Restart caveat

The page is served from `public/`, but the panel process caches its module list and the browser holds the old
scripts: a running panel keeps drawing with the pacer until the panel process is restarted and the page reloaded.

## 5. The marching tail: outside the queue by construction

A live turn's console carries one more thing - a trailing decoration under its last line drawing `. . . . `, one dot
every 500 ms, four dots to the cycle, cleared back to a single dot whenever output arrives, and gone the instant the
turn reads done. It is worth saying exactly where it stands, because the honest way to add it is to put it somewhere
the ordered stream cannot reach.

- **It is not a segment, and no rule can make it one.** The row is a sibling of the `pre`, emitted by
  `public/render-jobs.js` `turnBody` between the console and its own tools (`public/board/console.js`
  `marchRowHtml`). `createDrawStream` is never called for it, it carries no `lid`, no `data-ltext` and no `.jl`, and
  nothing orders it against anything. A test can therefore hold the queue's own books: the stream's `enqueued` does
  not move while the row marches.
- **The record is never touched.** `pre.textContent` is the turn's text with no dot in it at any moment of the march,
  not only after the turn ends - the row is not inside the node a repaint replaces, so a board poll, a rail resize or
  a focus-mode toggle redraws the card and leaves the row where it was.
- **The feed's height and scroll are the console's own.** The row is one fixed line *under* the box and its dot slot
  is exactly `. . . . ` wide (`.march-dots { width: 8ch }`), so a step can neither wrap the row nor reflow the feed.
- **One clock, one text node.** A single 500 ms timer writes `nodeValue` on the row's own `.march-dots` text node -
  `nodeValue` and not `textContent`, because a replaced text node is a childList mutation the page's copy observer
  wakes for. There is no per-frame loop and nothing in the march reads a box. The dot count is a function of the
  clock (`marchDotsAt`: 1 at the burst, 2 at 500 ms, 3 at 1000, 4 at 1500, 1 again at 2000), so a timer that fires
  late cannot make the march skip or double a dot, and a repaint draws the count the march had reached rather than
  starting again.
- **The panel's one motion idiom, and its one reduced-motion rule.** The row is `.live-pulse` with a `.pulse-dot`, so
  it gets the `@keyframes livepulse` breath (1.4 s), the `.is-offscreen` pause and - under
  `prefers-reduced-motion: reduce` - the *existing* stylesheet rule that sets `animation: none`. No second media query
  is added: with motion held still the row does not march at all, and shows a static single dot with the word the dots
  stood for.

### Proving it

`test/march-row.test.js` holds the rule without a browser: the 500 ms step and the 2 s cycle, the eight-character
slot, the region's refusal to name the stream at all (`createDrawStream`, `feed(`, `shownFor`, `drawRowText` and
`requestAnimationFrame` never appear in it), `createDrawStream`'s own `enqueued`/`pendingWords` staying at zero while
the row marches, the clear-to-one on a burst, the wrap, the removal on done, the same text node written every step,
and the stylesheet reusing the one media query rather than adding a second.

`node tools/verify-march-row.mjs` is the browser half, and it is the one the numbers come from: a panel of its own on
a spare port, a stub Runs API playing three bursts of five lines with a five-second quiet gap between them, the card
spawned through `POST /api/agents`, then a 50 ms sampler for the whole turn. On this host, on the tree this section
landed with, it measured a median of **500 ms** between rendered steps (21 intervals, 487 to 513 ms), **5 wraps**, and
a quiet window of 4762 ms holding **2 full cycles** in which `scrollHeight` 148 -> 148, `clientHeight` 148 -> 148,
`scrollTop` 0 -> 0, the console box 150 -> 150 px and the row 17 px in every one of the 97 samples. After the settle it read 21 rendered rows against the
turn's 15 stored lines of its own text, in the store's order, with none missing and nothing on screen the store does
not hold, and the record ending on the turn's last line character for character. The same harness runs a second turn
in a context that asks for reduced motion and finds the row `is-still`, the dot slot not shown, the label shown, and
`animation-name: none` - the existing rule, not a new one.

The captures it leaves behind are `march-mid-cycle.png` (the row at ". . . " under the console), `march-after-done.png`
(the row gone, the console ending on the turn's own last line) and `march-reduced-motion.png` (one dot, the word
`working`), plus a JSON of every sample. `--root <checkout>` serves another checkout, so the same harness can be run
against a `git archive` of the commit before this one.

### Restarting to see it

The page is served from `public/`, and a running panel keeps drawing with the scripts the browser already holds: the
row appears after the panel process is restarted and the page reloaded (`docs/console-draw-order.md`, section 4). The
shipped step is 500 ms with a 2 s cycle - the number the report quotes is the number in `public/board/console.js`'s
`MARCH_STEP_MS`, not a second copy of it anywhere else.
