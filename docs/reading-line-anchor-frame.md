# The reading line is held in the frame that moved it

`compensateAnchor` keeps the reader's element at its screen position while things above it grow. What it cannot do is
undo a layout change after that change has been painted: the correction has to land in the same frame as the growth,
or the reader sees the card they are reading jump and come straight back.

## What it was doing

`scheduleAnchorCompensation` — the only caller is the `ResizeObserver` on `main` / `projects` / `jobs` / the two fixed
cards / the approvals dock — deferred the correction to `requestAnimationFrame`. A `ResizeObserver` callback runs
after layout and before paint, so the frame it is called in is still the frame that can be corrected; the
`requestAnimationFrame` it queued runs at the *start of the next* frame, which is one paint too late. The page
therefore drew one frame with the anchored element displaced and then scrolled it back.

Measured on a card pinned with `📌` (so the anchor is that card, not whatever sits at the reading line), with a card
above it grown one console row at a time — the same thing three streaming turns do:

| | the question | before | this tree |
| --- | --- | --- | --- |
| post-layout deliveries with the card displaced | read from a `ResizeObserver` registered after the panel's own, so it runs later in the same delivery | **11 of 14**, up to **18 px** | **0 of 14** |
| frames drawn away from the pinned position | sampled per `requestAnimationFrame` | **22 of 262** (2 per growth) | **11 of 263** (1 per growth, and that one is read *before* the same frame's correction) |
| a live board, reader parked on a streaming card | `tools/`-style probe over `http://127.0.0.1:7481` | card top swung 199-252 px, 37 single-frame jumps in 45 s | correction lands in the growth's own frame |

The fix is `compensateAnchor()` called straight from the observer (`anchorBusy` keeps it out of itself), which is the
standard scroll-anchoring pattern: the observer callback is delivered after layout and before paint, so a `scrollBy`
there is part of the frame that grew.

## What it does not change

The decisions are untouched: `pendingFocus` still owns the scroll, `anchorMuteUntil` still stands the observer down
while a click's own `keepInPlace` pass runs, growth **inside** the anchor is still never compensated, a correction
larger than ~75% of the viewport is still a stale baseline, and the page-scroll listener still re-baselines on the
reader's own scroll. Only the moment of the correction moved.

## The console it was measured on

Three agents were started from a sandbox panel on a fixture repo (`api/agents`, `reasoningEffort: medium`), each card
put in one-stream mode (`🌊`) with reasoning on (`🧠`), and their consoles sampled per frame for ~130 s of real tool
output. The console itself is solid on this tree: **no row drops, no height collapse**, a text selection standing in
the console survived the ~1.2 s reasoning poll, and the newest line was at worst one line (18 px) behind for ≤184 ms
after an append before the next stick put it back — the appends, not a rebuild, are what leave that gap.
