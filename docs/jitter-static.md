# The two consoles, measured at rest

The reasoning block has `docs/thinking-block-live-observation.md`, the console has `docs/console-live-observation.md`,
and both of those watch a turn that is *moving*. This is the other case: content painted, nothing streaming, and no
input at all. What still moves, by how much, and how often.

Two measurements sit beside this one: `C:/CodeReviews/agent-worktree-gui/jitter-streaming.md` counts the seconds while
tokens flow and while the stream is paused, and `jitter-sources.md` maps which function repaints each surface. This is
the case beyond both — no turn is ever started, the card is painted once and left alone.

Measured 2026-10-30 on this tree (`b64642d`), with a throwaway probe of its own. Every number below is a read-back
from `C:/CodeReviews/agent-worktree-gui/jitter-static.json`; the before/after captures are the
`jitter-static-<surface>-{1-before,2-after}.png` files beside it.

## What was measured

One real finished run, drawn read-only from its own record and its own lines, in a sandbox panel of its own — a spare
port from `tools/panel-testkit.mjs` `startPanel` (own dataDir, own config/jobs/projects cache, assistant off, gateway
aimed at a closed port), served from this tree, in a headed Chromium with a profile of its own. The reading panel on
7331 was not touched, no turn was started, and nothing was posted.

- **run** `b9de8b34` · thread `wtgui-right-now-when-i-am-going-ba-c3b795` · turn 1 · 120 lines (111 tool), ended
  2026-10-30T19:46:54Z. The turn is finished, so the card is `done` in the `settled` windows.
- **reasoning** 60 blocks / 103,352 chars, the thread's own, through `lib/thinking.js` with the store opened
  read-only. The pacer was handed that text before the card was drawn (as a live card's pacer already holds what it
  typed), so a first draw cannot type it out: the block is static, which is the case under test.
- **the card** 8 console rows (2 folded burst groups, 11,067 chars on the finished card and 11,179 on the running one,
  in a 230 px box whose content is 533 px) and, with 🧠 on, a 283.4 px `<details.think>` whose body is 260 px of a
  26,860 px block, scrolled to its end (26,600).

Two states, because they are different pages:

| state | what the panel is doing |
| --- | --- |
| `settled` | the turn is done. Nothing polls it; the card is rebuilt only if an event arrives. |
| `open` | the turn is still running and **nothing is arriving** (a long call, a stalled model). The 1.2 s thinking sweep keeps re-reading and re-painting the block on that clock, and the turn head's own clock ticks. |

Surfaces: the normal turn-output console (`console`), the 🧠 block above it (`thinking`), and the 🌊 one-stream
console where the reasoning is rows of the console itself (`stream`, 68 rows / 112,436 chars).

Per window, for 10 s at 100 ms, with no scrollIntoView, no click and no key (the probe's own
wheel/pointerdown/keydown/mousedown/touchstart counters read **0** in every window below):

- `getBoundingClientRect()` for the card, `#jobs`, the topbar, the console, every console row, the block, all 60 of
  its rows, and the reply box — plus `scrollTop`/`scrollHeight`/`clientHeight` for the scroll boxes;
- `<MutationObserver>` over the whole body, bucketed per second and split into **inside the card** and outside it;
- `<PerformanceObserver 'layout-shift'>`, keyed on `entry.startTime` so a buffered entry from before the window is
  dropped;
- every `scrollTop` write (the setter is wrapped, with the JS stack that caused it) and every `scroll` event;
- computed styles at both ends of the window, and `getAnimations()`;
- every call to `paintThink` / `paintStreamConsole` / `renderConversation`, with the console's and the block's numbers
  before and after, the time it took, and whether the node was replaced.

## The answer: nothing in either pane moves

Ten seconds, no input. `0 px` means no tracked element of any kind changed its top, height or width by more than a
quarter of a pixel across the window's 100 samples.

| surface | console settled | thinking settled | console open | thinking open | stream open |
| --- | --- | --- | --- | --- | --- |
| DOM mutations, total | 10 | 10 | 20 | 32 | 20 |
| … **inside the card** | **0** | **0** | 10 | 22 | 10 |
| … per second | 1,1,1,1,1,1,1,1,1,1 | 1,1,… | 2,2,… | 5,2,2,5,2,5,2,5,2,2 | 2,2,… |
| layout shifts | 0 | 0 | 0 | 0 | 0 |
| `scrollTop` writes | 0 | 0 | 0 | **4** | **4** |
| `scroll` events | 0 | 0 | 0 | 4 | 0 |
| repaints (`paintThink`/`paintStreamConsole`) | 0 | 0 | 0 | **4** | **8** |
| console node replaced | 0 | 0 | 0 | 0 | 0 |
| block node replaced | – | 0 | – | **4** | n/a |
| largest rect delta, any element | **0 px** | **0 px** | **0 px** | **0 px** | **0 px** |
| computed-style changes | 0 | 0 | 0 | 0 | 0 |
| drawn text, start → end | 11,067 → 11,067 | 103,352 → 103,352 | 11,179 → 11,179 | 103,352 → 103,352 | 112,436 → 112,436 |

The 10 mutations outside the card are the same in every window: the topbar's `#stream-rate` readout ("10 events ·
1.0/s") writing itself once a second. In `console-open` the 10 inside the card are `div.turn-head .turn-text` —
"turn 1 · running 2m04s" — ticking once a second: text only, no rect moves, and it is not in the console. The other 12
in `thinking-open` are the 4 rebuilds of the block (4 × childList on `.turn`, 4 × the copy button on `summary`, 4 ×
the `class` toggle on `.out-wrap`).

So on a still page the panes are still: **`pre.job-out[data-out="b9de8b34"]`, its 8 `.jl` rows and 2 `.tgrp` groups,
`details.think`, `.think-body`, all 60 `.think-block` rows, the reply box and the card itself each hold their exact
position for 10 s** — in the settled card and in the running one, with 🧠 off, on, and in the 🌊 renderer.

## What is not still: the block is thrown away and rebuilt on every poll

`paintThink` replaces the whole `<details>` (`el.replaceWith(fresh)`). At rest on a running card that is one rebuild
every ~2.4 s:

| measured | thinking open, 10 s | thinking open, 40 s |
| --- | --- | --- |
| `paintThink` calls | 4 (at 0.75, 3.15, 5.54, 7.93 s) | 17 (every 2.40 s ± 0.01) |
| `.think-body` node replaced | **4** | **17** |
| cost of one rebuild | 9.9 – 16.6 ms | 8.7 – 19.1 ms, median 13.2 |
| `scrollTop` writes | 4, every one `0 → 26,600` | 20, every one `0 → 26,600` |
| `scroll` events | 4 | 19 |
| rect delta / layout shift | 0 px / 0 | 0 px / 0 |

Every write's stack is the same one — a fresh node starts at its first line, and the panel puts it back:

```
setScroll <- stickThinkBody <- paintThink <- loadThinking
```

The geometry survives it because the text is identical on both sides of the swap. Three things do not:

- **a selection in the block does not survive a poll.** 1,465 characters selected across three of its rows on the
  running card: **0 characters** at the first poll, 0.75 s into the window, and still 0 at every 100 ms sample for
  the remaining 9.2 s.
- **the copy button is remounted** each time: 4 `childList` records on `summary` adding `button.copy-block` in 10 s,
  and 3 more in the console's wrapper and burst groups when the board rebuilt the card (below).
- **~13 ms of main thread, 0.43 times a second**, on a card that is not doing anything.

A reader parked in the block keeps their place: scrolled up to 5,000 with the block unpinned, it is at 5,000 after
every one of the 4 polls in the window (`0 px`, 0 layout shifts) — the position is restored, not followed.

The 🌊 console is the counter-example, and it is the one that was fixed: 8 paints in 10 s (4 polls × the poll's own
`paintStreamConsole` and `paintThink`) produced **0 mutations inside the console** — the rows are patched, not
replaced, nothing is remounted, and `scrollTop` is written back to the value it already had (28,215 → 28,215, no
scroll event). One paint of 68 rows / 112,436 chars costs 3.5 – 5.8 ms.

## The console at rest, and the panel's own clocks

A 10 s window is shorter than the panel's own cadence, so three windows were run for 40 s. The card is rebuilt once at
**24.92 s** by the panel itself — `resync → applySnapshot → renderJobs` — and that is the only thing that touches the
console at rest:

| 40 s window | console, running | console, reader parked at 100 px | thinking, running |
| --- | --- | --- | --- |
| console node replaced | 1 (at 24.92 s) | 1 (at 24.95 s) | 1 |
| `scrollTop` writes | 2: `0 → 533`, `304 → 533` | 3: `0 → 100`, `100 → 100`, `100 → 100` | 17 + 3 |
| where it ended | 304 (unchanged, clamped) | **100 (unchanged)** | 26,600 (unchanged) |
| scroll events | 1 | 1 | 19 |
| rect delta / layout shifts | 0 px / 0 | 0 px / 0 | 0 px / 0 |
| block node replaced | – | – | 17 |

For a console that was at its end the write target is `o.scrollHeight` (533) rather than the last `scrollTop` (304);
the browser clamps it, so nothing moves. A reader who was scrolled up comes back to exactly 100 px, because the
remembered position is restored first (`restoreScrolls`, `applyStoredScrolls`). The 40 s console window's one busy
second is 42 mutations, 37 of them outside the card (the settings panel's data-dir sizes, the approval dock, the
project chips) and 5 inside it: a rebuilt card, not a moving one.

## The one thing that did move the panes: the board settling after load

Captured in all four windows of the first pass, which opened the sampling window ~2.5 s after the card was drawn. The
same instant in every one of them is the topbar's **first** `#stream-rate` write (509.9 ms):

- at 0.51 – 0.71 s into the window the page's client width goes **1440 → 1429** (a window scrollbar appears) while the
  document grows 1150 → 1169 px, and `header.topbar` goes 1440 → 1429.33 px;
- `#agents` goes **y 344 → 363 (+19 px)** and 1408 → 1397 px wide; everything below it follows, once: `.job` top
  390.4 → 409.4 (**+19 px, one change**), `pre.job-out` top 771.7 → 790.7 (+19), `.reply-box` top 1042.4 → 1061.4
  (+19), `details.think` and `.think-body` +19;
- `.think-block` rows get **18 px taller each** as their mono text re-wraps into the 11 px narrower column — three of
  them on the settled card (126 → 144, 1638 → 1656, 90 → 108) and eight on the running one; `.think-body` content
  26,716 → 26,770 px (+54) with its `scrollTop` 26,456 → 26,510 to stay at the end, so the reader's last lines do not
  move and the text above them re-wraps;
- 2 `layout-shift` entries in that window — 0.5223 and 0.5511 for the main one, then 0.0006 for the topbar buttons
  moving 72 px in the same row — both `hadRecentInput: false`, and 0 for the rest of the window.

It is a one-shot settle, not a steady state: the same surfaces measured again with the window opened 0.3 s and 4.2 s
after the draw — ten windows in all — recorded **0 shifts and 0 px**. The 1 Hz `#stream-rate` text is the only thing
still writing on every page, and it stops re-wrapping the topbar after its second update.

## What this does and does not cover

- **Driven:** a sandbox panel from this tree and one card drawn client-side from a real run's record and lines; a real
  thread's reasoning, read read-only; the panel's own 1.2 s thinking sweep, its 400 ms stick, and its 30 s-ish
  `resync` — all running on their own clocks. No input of any kind.
- **Not driven:** a real turn, the live wire, a resize, or a theme change. `settled` is a finished run presented as
  finished; `open` is the same finished run presented as running so its poll clock runs, which is the at-rest case
  with a live card — the transcript is the run's own, the status is not.
- **Skipped:** a store with no finished run of 40+ lines, or a thread that recorded no reasoning.
- The condensed console draws a **window** (`windowLines`), 8 rows and 2 folded groups here; that window, at the
  reader's default position (the end) and parked at 100 px, is what was measured. A reader with a burst group opened,
  or a console mid-transcript in a longer window, is a different set of rows but the same renderer.

The short version: the consoles are still — no rect delta, no layout shift, no computed-style change, and no scroll
outside the panel's own restored positions, across 40 s — and the reasoning block is not still underneath: 0.43 node
rebuilds a second, each 9 – 19 ms, each taking a selection with it, on a card that is not moving.
