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
