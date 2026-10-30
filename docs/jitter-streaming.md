# The streaming card, watched per second

The console and the reasoning pane have each been measured after the fact — `docs/console-live-observation.md` watches
one repaint and one line, `docs/thinking-block-live-observation.md` watches a real turn's block. This is the case in
between: the seconds while tokens are actually arriving, counted per second, and the same seconds with the stream
stopped. Both card modes are here, because they draw the reasoning in two different places: the 🌊 one-stream console,
where reasoning is rows of the console, and the 🧠 block above a condensed console.

Measured 2026-10-30 on this tree (`b64642d`), with `tools/measure-stream-jitter.mjs`, on a synthetic stream the tool
owns from end to end. Every number below is a read-back from `C:/CodeReviews/agent-worktree-gui/jitter-streaming-*.json`.

## The instance

A sandbox panel of its own (`tools/panel-testkit.mjs`: free port, own `PANEL_CONFIG`, jobs/projects cache and
`HERMES_HOME`, assistant off, `API_SERVER_KEY` empty), so the panel on 7331 is never touched. Two things feed it:

- **the wire** — a stub Runs API that plays one generated reply over real SSE: one to three words every ~75 ms, a
  paragraph break every 55 words. `lib/jobs.js` coalesces them at 120 ms into one growing line, exactly as it does for
  a real gateway. Nothing is invented inside the page.
- **the store** — `<sandbox>/hermes/state.db`, the same `messages.reasoning_content` column `lib/thinking.js` reads. A
  new reasoning row is written every 2 s while the stream flows and not at all while it is paused, so "paused" is a
  stalled model on the wire *and* a still store.

The run is 30 s flowing, 15 s paused (no event at all; the reasoning writer stops 3.5 s early so the last block has
finished typing), 20 s flowing again, then the turn ends. Headed Chromium (`headless: false`) in a profile of its own,
1280×1000, one card, no input of any kind sent after the spawn.

## What is counted

Per second, from a MutationObserver on the document, a rAF loop, and wrappers around the page's own entry points:

- **a row replaced** — an element carrying `data-lid` left the page (`!isConnected`) and another element with the same
  lid took its place. The reader keeps the words, and loses the node: the selection inside it, and anything hanging off
  it. A node that is merely *moved* (the board re-placing a card in its slot) is not a replacement and is not counted.
- **a row rewritten in place** — a mutation inside a row that is still connected: `el.innerHTML = …` by the pacer, or
  the live append of a growing paragraph. The row survives; its text nodes do not.
- **kept per poll** — before `syncStreamConsole` / `paintThink` runs, every row it is about to draw is tagged, and on
  return the tags still inside the box are counted. That is the repaint measured from the repaint's own point of view,
  independent of the observer.

## 🌊 one console: the rows keep their nodes, the words inside them do not

Reasoning is on as well, so the reasoning is rows of the same console. The console held 2 rows / 51 px of content at
the first poll and 48 rows / 1,638 px at the last, in a 229 px box.

| window | s | console rows replaced /s | console rows rewritten /s | reasoning rows replaced /s | reasoning rows rewritten /s | DOM mutations /s | polls | rows kept per poll | selection held: growing / reasoning | scrollTop up / follow per s | fps (p95) | frames >50 ms | long tasks | board resyncs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flowing | 30 | 0.5 | 23.5 | 0.5 | 12.4 | 46.6 | 13 | all of 2→29 | 83 ms / 50 ms | 0 / 1.5 | 59.4 (17.2) | 3 | 0 | 1 |
| paused | 15 | 0 | 0.2 | 0 | 0 | 4.1 | 6 | all of 30→30 | — / — | 0 / 0 | 58.7 (17.4) | 4 | 0 | 0 |
| flowing again | 20 | 2.4 | 22 | 2.3 | 13 | 46.5 | 8 | all of 30→48 | 23 ms / 45 ms | 0 / 1.8 | 57.9 (18.6) | 13 | 0 | 1 |
| settling | 9 | 0 | 0 | 0 | 0 | 1 | 0 | — | — / — | 0 / 0 | 61.4 (17.2) | 2 | 0 | 0 |

**The poll replaces nothing.** 27 polls on a live console, and every one of them handed back every row it was given:
`kept == stamped` on 27 of 27, from 2 rows at the first poll to 48 at the last. `syncStreamConsole` compares each row
with the one it would draw and only swaps it when the words moved, and the words do not move between a poll and the
pacer's own paint of that row — so the patch is a patch. (The 0.5 rows replaced a second in the table are the 30 s board
resync of the last section, not the stream: 15 rows in one second out of 30.)

**The pacer rewrites the text inside them about 23 times a second.** 566 pacer paints and 208 live appends in 29 s:
6.7 appends a second rewrite the growing paragraph in place (`drawJobLine`'s `mode: "set"` branch), and the pacer's
`paintTypedLines` rewrites the same row another ~17 times a second, plus the growing reasoning row ~12 times a second.
35.9 of the 46.6 mutations a second are those in-place text rewrites. Row nodes: 193 of 208 appends were in place, 15
were new paragraphs, **0 were replacements**.

**So a selection dies at the next write, not at the next poll.** 24 characters selected at the start of the row:

- a row being written: 16–100 ms in 13 of 14 samples (median 50 ms) — one to six frames;
- the samples that lasted 0.8–1.9 s were rows the writers had stopped touching;
- a settled row nothing repaints: 4 s, the probe's cap, in 7 of 9 arms.

The observer records what was writing into the row at the moment of loss: a `childList` mutation inside that same row
(14 times in this run). That is the `innerHTML` assignment: the row keeps its element and loses every text node under
it, and the caret goes with them.

**The paused seconds are the control.** 0 rows replaced, 0.2 rewrites a second, 4.1 mutations a second (the page's own
furniture), and no selection lost in 4 arms (all four reached the 4 s cap). The poll kept running at the same 0.4/s
throughout and handed back all 30 rows every time: a poll of a console that is not growing draws nothing.

## 🧠 the block: every block is replaced on every poll

Same stream, same store, thinking on, stream mode off. Console: 25 rows / 861 px of content by the end, and the block
24 blocks / 1,048 px at its last poll. The reasoning is a `<details class="think">` above the console, and `paintThink`
rebuilds it: `holder.innerHTML = thinkHtml(...)` then `el.replaceWith(fresh)`.

| window | s | console rows replaced /s | console rows rewritten /s | reasoning blocks replaced /s | reasoning blocks rewritten /s | DOM mutations /s | polls | blocks kept per poll | selection held: growing / reasoning | scrollTop up / follow per s | fps (p95) | frames >50 ms | long tasks | board resyncs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flowing | 30 | 0.5 | 23.2 | 3.4 | 12.3 | 47.2 | 13 | none (0 of 1→14) | 50 ms / 634 ms | 0 / 1.3 | 59.8 (17) | 0 | 0 | 1 |
| paused | 15 | 0 | 0.2 | 5.6 | 0 | 5.4 | 6 | none (0 of 14→14) | — / 1584 ms | 0 / 0 | 60.1 (17) | 0 | 0 | 0 |
| flowing again | 20 | 1.1 | 23.9 | 8.3 | 12.8 | 48.8 | 8 | none (0 of 14→22) | 1950 ms / 1234 ms | 0 / 2.3 | 60.7 (17) | 0 | 0 | 1 |
| settling | 9 | 2.8 | 0.1 | 5.3 | 3.1 | 6.2 | 1 | none (0 of 24→24) | — / 1953 ms | 0 / 0.3 | 62.2 (16.9) | 0 | 0 | 0 |

**0 of N blocks survive a poll, and `detailsReplaced` is 1 on every one of the 28 polls.** The block is not patched
like the console is; it is thrown away and drawn again, as `docs/thinking-block-redraw.md` describes, and the numbers
say what that costs: 3.4 block nodes a second while flowing (13 polls × 1–14 blocks in 30 s), 8.3 in the second window
as the block set grows (up to 22 blocks), and **5.6 a second while the stream is paused**. Every poll replaces its
14 blocks whether or not a word arrived.

**Nothing in the paused window stops it.** Console mutations go to zero, the pacer stops (0.2 rewrites a second), and
the block still loses and regains 14 nodes every 2.4 s. That is the clean separation of the two panes: the console's
churn belongs to the tokens, the block's belongs to the poll.

**A selection in the block therefore lasts at most until the next poll.** Median 634 ms while flowing (where the pacer
is also rewriting each block ~12/s, and 6 of 12 samples died in 17–84 ms), 1,584 ms while paused, 1,234–1,953 ms in the
second window. The body's scroll is measured back to where it was by `paintThink` — `top0 == top1` on 12 of 28 polls
and a `+4` to `+8 px` step (one line of new words) on the rest — so the pane does not visibly jump, but what is standing
in it is new nodes.

## Not the scroll, and not the frames

Over both runs, 167 scroll movements and **0 with user input** (the probe sends none) and **0 upward**. 167 of them
came from the page's own `setScroll`: the console following its newest line, 4–44 px at a time (median 17–18 px, one
wrapped line), 1.3–2.4 follows a second. At every frame boundary sampled, the console's distance from the bottom was
**0 px**: growth and the stick that follows it land in the same task, so no frame is ever painted with the box off its
bottom. A poll moves `scrollTop` on 0 of 27 console polls and never shrinks the box.

Frame pacing is the least interesting number here, and it is healthy: 57.9–61.4 frames a second, p95 17–19 ms, **0 long
tasks** in either mode. The 🌊 console did drop 3 / 4 / 13 frames over 50 ms in its three windows (max 134 ms, 205 ms,
132 ms) while the 🧠 card dropped none — and with no long task behind any of them, the page's own work is not what is
slow there.

## The rebuild every thirty seconds

The largest single replacement of rows in either run is not in either table's per-second floors — it is a spike. At
30.1 s and 60.6 s the whole live card is rebuilt from the transcript: 29 rows, then 43 rows in the 🌊 run; 15 console
rows + 14 reasoning rows, then 22 + 21 in the 🧠 run, all replaced at once, in the middle of the stream.

The page does that itself. `public/core/sse.js:129` handles `jobline` without stamping `state.lastEventAt`, so a turn
that is only streaming lines never advances the liveness clock; the panel's safety net at `public/app.js:14843-14845`
reads `quiet` (`Date.now() - state.lastEventAt > 20000`) and calls `resync()` every 30 s; `resync()` → `applySnapshot()`
(`public/app.js:12686`) rebuilds every section, and a live card comes back as a new node with new rows. The clock read
29 s, 44 s and 64 s stale at the ends of the three windows while ~7 lines a second were arriving, and the tool recorded
the snapshot at 30.1 s and 60.6 s in both runs.

So on a streaming card there are three separate reasons a row can be replaced, and they are not the same fault:

1. the board's 30 s resync — every row at once, every 30 s, caused by the tokens failing to stamp the clock;
2. `paintThink`'s full replace — every reasoning block, every 2.4 s, caused by the poll (🧠 only);
3. nothing else. The console's own repaint (🌊, 27 polls) and the live append (208 lines) replaced **no row at all**.

## What is driven, and what is not

- **Driven:** a sandbox panel of its own, a stub Runs API over real SSE, the panel's own `lib/jobs.js` coalescing and
  line stream, a real `state.db` read through `/api/thinking`, the page's own pacer, sweep, `syncStreamConsole`,
  `paintThink`, `drawJobLine` and `setScroll`, all at their shipped rates (40 words/s, 1.2 s sweep, 120 ms text
  coalescing). Headed Chromium in its own profile, so "what the screen does" is measurable.
- **Not driven:** a real model, a real gateway, and a reader's own mouse. No input is sent, so every scroll counted is
  the page's; the selection is the probe's, placed and re-placed on a clock so each kind of row gets sampled.
- **Skipped:** nothing in the run itself. A box with no Playwright skips the whole tool, the way the other measurement
  tools do.
- One limit worth naming: the per-second counts are medians of 15–30 one-second buckets per window, and a spike like the
  30 s rebuild shows up in its second only. The `jitter-streaming-*.json` captures carry every poll, every scroll and
  every second, which is where the spikes are read from.

```
node tools/measure-stream-jitter.mjs --mode stream        # 🌊 one-stream console
node tools/measure-stream-jitter.mjs --mode think         # 🧠 block above a condensed console
node tools/measure-stream-jitter.mjs --mode stream --flow1 60000 --pause 30000 --flow2 30000
```

Both captures used for this note: `jitter-streaming-stream.json` and `jitter-streaming-think.json` in
`C:/CodeReviews/agent-worktree-gui`.
