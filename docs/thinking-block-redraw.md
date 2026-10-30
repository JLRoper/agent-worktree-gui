# Why the reasoning block collapsed and reopened

The 🧠 panel is the only pane on a card that is **polled and then redrawn**, and it is the only one that flickered.
Everything else a run produces is appended to `pre.job-out` from the run's own line stream and never rebuilt; the
reasoning is read back from the session store every ~2.4 s (`/api/thinking` → `loadThinking` → `paintThink` →
`el.replaceWith(fresh)`), because the runs API carries only a 500-char preview of a thought. So the bug had to be in
that redraw path, and it was: three separate ways for the block to draw less than it was drawing a moment ago.

## What the reader saw

The reasoning block collapsing to its summary line (or back to a few words) and filling again, in a split second,
while the run was going. Measured on this box: a live turn's window holds **58 blocks / 183 kB** of reasoning, so the
difference between "the whole text" and "the prefix the clock had reached" is the difference between a page of thought
and a sentence — nothing subtle about it.

## The three faults, each measured before it was changed

1. **A store read that failed was taken as "this turn thought nothing".** `thinkingFor` caught its own error and
   returned `[]`, the route answered `{ blocks: [] }` with a 200, and `loadThinking` replaced the cache with the empty
   list — blanking a live block that had text, and refilling it on the next poll. `lib/thinking.js` now answers
   `{ blocks, error }`, and the card keeps what it has when `error` is set, when the read throws, or when a read comes
   back empty for a turn that is still running (a live turn's block list only ever grows; past `MAX_BLOCKS` the oldest
   block legitimately drops out, which is why a shorter non-empty answer is still taken).
2. **Every repaint's own `<details open>` was read as the reader opening the block.** An inserted open details fires a
   `toggle` of its own, queued as a task, and the panel's `toggle` listener cannot tell it from a press. So each
   re-read added the turn to `state.thinkOpen`: a finished turn's reasoning never folded again, and the set grew a key
   per turn repainted while live (`sweepThinking`'s auto-fold is gated on `!thinkOpenFor`). Nodes that arrive open are
   now armed as the panel's own by the observer that already hooks inserted `[data-copy]` blocks
   (`armPlacedThink`), which runs as a microtask — before that queued toggle — and the swallowed toggle is dropped
   from the set so the reader's next press on that node is theirs again.
3. **The drawn text could rewind.** `paceThinkBlock` had two branches that disagreed: a block the pacer held drew its
   **prefix**, and the same block drew its **whole text** whenever the turn was not live or the tab was hidden. When
   the branches swapped — a settled turn that comes back (a revived run, a re-adopted card), a tab returning to the
   foreground — the block collapsed to the few words the clock had reached minutes earlier and typed them out again.
   One rule now: a block the pacer holds always draws its prefix, and the moment there is no flow (settled, hidden)
   the rest is released through `P.flush`, so the block ends on the wire's whole text and never goes backwards.

Two smaller defects in the same read were fixed with them: the store can hold the **same message twice at one
timestamp** (494 such pairs on this box, always identical text), which drew one thought as two blocks sharing one
`think:<at>` lid — the single identity the pacer keeps one visible prefix for — so `thinkingFor` now deduplicates; and
`lib/thinking.js`'s empty answer for a thread with no store is still an empty list with no error, which is a different
fact from a failed read and now reads as one.

## Proved where it happens

`tools/verify-thinking-flicker.mjs` drives the shipped page in Chromium against a sandbox panel (own port, own
`PANEL_CONFIG`/`HERMES_HOME`, `API_SERVER_KEY` empty) with a live turn fabricated in the page's own `state` and
`/api/thinking` fulfilled from the probe, so the sweep's real 1.2 s clock, `loadThinking`, `paintThink` and the pacer
all run. It records every state the block is left in (open, height, block count, each block's text length, the summary
line) from the mutation batches plus a timer, and asserts the block never closes under a live turn, never loses
height, never loses text, never paints another block's words, and never blanks on an empty read.

`--blocks <file>` replays a real turn's blocks (dumped from the live route: `curl /api/thinking?...`), which is how
the numbers above were taken. Against the base commit the same run fails three checks — the empty read blanks the
block, the settled-then-live turn shrinks blocks from 7,391 → 4,760 chars, 6,465 → 4,514 and 5,096 → 4,662, and the
settled turn never folds (`thinkOpen` holding the turn key). Against this branch it passes 9/9.

```
node tools/verify-thinking-flicker.mjs                       # this checkout, 9 checks
node tools/verify-thinking-flicker.mjs --blocks <dump.json>  # replay a real turn's reasoning
node tools/verify-thinking-flicker.mjs --only store          # one phase: live | store | flap | settle
```

The store half is covered without a browser in `test/thinking.test.js` (dedupe of one thought stored twice, the
window in ms against the store's seconds, the cap, and "a failed read says so").
