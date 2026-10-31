# The console lag: a clamp that only the live board produces

A console that follows its newest line can sit **behind** it — not at the top, a few dozen to a few hundred pixels short —
for a fraction of a second, and then be back. It was measured on the live panel and it was **not** reproduced in any
sandbox this repo can drive, including the one that fires `placeRow` directly. The candidate the report blamed is
therefore **excluded by its own injections**, and the mechanism is **unproven**.

Status: measured 2026-10-31 on `6ca7964` (0.34.0), no product change. Every number below is a read-back from a run of
`tools/measure-console-lag.mjs`; the raw records are named with each row.

## 1. What is measured

Per painted frame, for every overflowing `pre.job-out`:

```
lag = scrollHeight - scrollTop - clientHeight
```

i.e. the px between the bottom of the box and its newest line, which is what a reader sees as "the console is behind".
A frame with `lag > --thresh` (8 px) opens an **excursion**; it closes on the first frame back within the threshold. For
each one the recorder keeps:

- the lag it started at and the worst lag in it, and its duration in ms;
- its **shape**, from two consecutive frames: `clamped` (the box's top *fell*), `frozen` (the top held while the content
  grew), `grown-with-top`, `other`, or `new` (a console node the sampler had not seen before, i.e. a replacement);
- the page events within 220 ms before it — the wrapped page functions, every DOM move that carried a console, every
  `setScroll` with the value **asked for** (so a write the browser clamped is visible), and every pin change;
- the page events inside it, i.e. what repaired it.

`tools/measure-console-lag.mjs` runs in two modes: a **sandbox** (its own panel, its own stub Runs API, one injected
trigger on a 3 s beat on a quiet board) and `--url`, which opens **one tab** of a panel that is already running, opens the
rows of the runs that are live at that moment, and posts nothing, clicks nothing and writes nothing.

## 2. The live board is the only reproduction

`--url http://127.0.0.1:7331 --rows 2 --seconds 75` against the reader's own panel while four runs were streaming
(`live-1.json`):

| | |
| --- | --- |
| consoles on the page / rows opened | 13 / 2 |
| frames / console-frames sampled | 4447 / 49349 |
| console-frames above 8 px | **712** |
| excursions | **97** in 75 s, at **50 distinct instants** |
| excursions that start at the bottom (`prevTop == prevMax`) | **97 of 97** |
| excursions whose content height was unchanged at the fall (`max0 == prevMax`) | **97 of 97** — shape `clamped` |
| how far the top fell | 5 values only: **34, 35, 69, 138, 190 px** |
| lag px (per excursion, p50 / p90 / max) | 190 / 190 / 190; the worst single frame **339 px** |
| duration ms (p50 / p90 / max) | **18.4 / 318.4 / 399.3** |
| duration buckets | ≤ 33 ms: **50**, 34–99 ms: **5**, **100–370 ms: 36**, > 370 ms: **6** |
| gap between instants | median **1117 ms** (min 33, max 3211) |
| what repaired it (last page function before it closed) | `stickConsole` **78**, `paintTypedLines` 5, `reorderProjects` 4, `placeRow` 4, `reorderAgentCards` 4, `drawJobLine` 2 |

Two things in that table are the whole finding:

1. **The content did not change.** In all 97 the scroll height was the same before and during the fall, and the box
   started on its newest line. Nothing was appended and nothing was hidden: the browser **clamped `scrollTop` down**
   against a scrollable height that was smaller for an instant, and when the height came back the position stayed where
   the clamp left it. That is why it is a lag and not a jump — the top never reached 0.
2. **It happens in pairs.** 45 of the 50 instants carry **two** consoles, the two of them in the same row detail, one
   frame, one task. One operation moved both boxes and neither was put back before the frame was painted.

The durations are the page's own repair rhythm, not a stream rate: 78 of 97 were ended by `stickConsole` — the **400 ms
sweep** (`public/app.js:15005-15015`) — which is why the tail of the distribution is 186–399 ms and nothing is longer
than 400.

This board was busier than the reader's report (four agents streaming, 348 `placeRow`, 311 `reorderProjects` and 1560
`reorderAgentCards` calls in the 75 s window), so 97 excursions is not a contradiction of "4–10 times per 75 s": it is
the same fault at a higher rate. Four later captures of the same panel (`live-2/3/4.json`, 60–75 s each, 12–13 consoles)
read **0 excursions** and a worst frame of 118–212 px, because by then the board had gone quiet — the reproduction is
real but intermittent, and it needs a board that is actually churning.

## 3. Every sandbox reads 0 — including the shapes that were blamed

60 s windows, `--rate 12 --burst 600` (the stub writes at a real burst rate, not one word per 75 ms), two consoles
overflowing, all in `C:/Users/roper/AppData/Local/Temp/wag/8cbefc6e/`:

| scenario | what it fires | calls that prove it fired | excursions | worst lag |
| --- | --- | --- | --- | --- |
| `stream` ×2 | the natural board: the panel's scan clock, the 5 s reorder clock, a closed project touched every 4 s | `placeRow` 182/184, `reorderProjects` 124/126, `holdScrolls` 14/11 | **0, 0** | 0 px |
| `placeRow` ×2 | only `placeRow`'s detail swap, 19 beats a minute | `placeRow` 114/116, `restoreScrolls` 44/47, `applyStoredScrolls` 44/47, `settleScrolls` 44/47 | **0, 0** | 0 px |
| `cards` ×2 | the same, on a row that holds **two** cards (one rebuild moves two consoles) | `placeRow` 103/101, `restoreScrolls` 33/33, `fillAgentSlots` 33/33 | **0, 0** | 0 px |
| `cardsIdle` ×2 | that two-card row, nothing injected (control) | `placeRow` 80/82 | **0, 0** | 0 px |
| `rankOnly` ×2 | only the page's 5 s reorder clock | `reorderProjects` 39/35, `holdScrolls` 2/7 | **0, 0** | 0 px |
| `renderAll` ×2 | only `renderAll()`, 19 beats a minute | `renderAll` 20, `renderProjectRows` 130, `restoreScrolls` 47 | **0, 0** | 0 px |
| `sseProject` ×2 | only the `project` SSE frame (dispatched on the page's own EventSource with the server's own payload) | `renderProjectRows` 42, `restoreScrolls` 46, `placeRow` 97 | **0, 0** | 0 px |
| `all7d` | only the folder All/7d toggle (`renderRoot`), 19 beats a minute | `renderRoot` 19, `renderProjectRows` 138, `restoreScrolls` 47 | **27** — see below | 7150 px, 14–31 ms |

`all7d` is the one scenario that is not zero, and it is a different fault: all 27 excursions have shape **`new`** — the
toggle replaces the section, so the console is a **fresh node** that appears at its first line and is put back 13.7–31.3
ms later by `captureScrolls`/`restoreScrolls`. That is the hop of `docs/console-scroll-hop.md` (a jump to the top, one or
two frames), not this lag: 7150 px is the whole console, where this defect is 34–190 px with the content unchanged, and
its repair is a rebuild rather than the 400 ms sweep.

So: the sandbox can produce `placeRow` 116 times a minute, in a row that holds one card or two, with the ranking and the
stream both live, and **no console ever leaves the bottom**.

## 4. The candidates, each by its own measurement

### (1) The page-global `lastInputAt` in the scroll listener — **not guilty**

Claim: a clamp on one console is read as the reader scrolling away whenever any keypress happened anywhere on the page in
the previous 1200 ms (`public/app.js:14994-14997`, `lastInputAt` written at `:6978-6984`), which sets
`state.outPinned[id] = false`; `drawJobLine` then stops sticking it (`consolePinned(id) || lag < 40`) and the 400 ms sweep
skips it (`stickConsole` returns early for an unpinned console, `:7047`).

A/B, 60 s each, two consoles in **two different projects** so a clamp on one cannot touch the other; every 3 s one
section is raw re-appended (a real full clamp), and in the `input` arm a keydown is dispatched anywhere on the page every
800 ms:

| run | clamps fired | excursions | lag px (p50/p90/max) | duration ms (p50/p90/max) | pins at the end |
| --- | --- | --- | --- | --- | --- |
| `input-1` | 19 | 16 | 3735 / 6702 / 7116 | 19.7 / 36.3 / 50.3 | both `true` |
| `input-2` | 19 | 13 | 4149 / 6736 / 7116 | 19.4 / 34.1 / 35.1 | both `true` |
| `clamp-1` (nobody typing) | 19 | 14 | 4149 / 6408 / 6736 | 21 / 33.8 / 46 | both `true` |
| `clamp-2` (nobody typing) | 19 | 14 | 3735 / 6702 / 7116 | 18.9 / 34.2 / 47.1 | both `true` |

- **No pin was ever lost.** All four runs end with both consoles pinned, and no `pin` event appears in any excursion's
  record. The keypresses change nothing: 16/13 excursions with them, 14/14 without, the same durations inside a frame or
  two.
- A full clamp in the sandbox costs **3735–7116 px** (most of the console, p50 ≈ 4000) and is repaired in **18–50 ms** — the settled layout
  is there 2 rAFs later, so `settleScrolls` fixes it. Nothing like a 34–190 px, 100–370 ms lag.
- Structurally the candidate cannot produce a *transient* anyway: an unpinned console stays unpinned. Only two things
  re-pin one — sending a turn (`scrollThreadToBottom`, `public/app.js:893-899`) and the reader clicking the "to the
  newest line" chip (`:14494-14500`) — so a lost pin is a console that sits at the top until something else moves it, for
  minutes, not 100–370 ms.

### (2) A missing same-task restore in `renderAll`, the project SSE frame and the All/7d toggle — **not guilty as measured**

`renderAll` 0/0 (`renderAll` 20 calls a run, `renderProjectRows` 130), `sseProject` 0/0 (`renderProjectRows` 42), `all7d`
27 excursions of the *other* shape (a replaced node, 14–31 ms, §3). None of the three leaves a box 34–190 px short for
100–370 ms in the sandbox.

### (3) `placeRow`'s own detail swap — **excluded by its own injections**

`placeRow` 0/0 with 114/116 calls and every restore running (`restoreScrolls` 44/47, `applyStoredScrolls` 44/47,
`settleScrolls` 44/47); `cards` 0/0 with 101/103 calls into a row holding two consoles, which is the live shape; `cardsIdle`
0/0 as the control. The drawer that the report blamed, fired on its own, on this page, in this browser, leaves the
console exactly where it was.

### (4) The page's own 5 s ranking pass — **not guilty as measured**

`rankOnly` 0 excursions with `reorderProjects` 39 and `holdScrolls`/`releaseScrolls` 2 (it moved a node twice); `stream`
0/0 with `reorderProjects` 124/126 and `holdScrolls` 14/11, i.e. the ranking really did move sections and cards and no
console left the bottom.

## 5. What the live numbers do say about the mechanism (leading, **unproven**)

The shape is unambiguous and it is not in any code path the sandbox exercises:

- 97 of 97 start on the newest line and fall with the content height unchanged, by one of five discrete amounts. A top
  that falls while the content stays the same can only be the browser's own overflow clamp: the element's scrollable
  height was **smaller at that instant** than it is a frame later.
- They come in pairs in the same detail, one frame, one task — so one rebuild produced the transient for both boxes.
- They are repaired by the first writer that reads a **settled** layout: `stickConsole` from the 400 ms sweep, 78 of 97,
  which is why the tail is 186–399 ms.

That points at the one thing this page does that the sandbox does not: a rebuild whose inserted subtree is **re-laid out
after** the same-task restores have already read it. The three writers on that path all read the transitional box and
therefore write a position that is already "correct" for a height that is about to change:

| write | file:line | what it does |
| --- | --- | --- |
| `restoreScrolls` | `public/app.js:7067-7076` | writes `el.scrollHeight` for a pinned console — the same read the clamp came from |
| `applyStoredScrolls` | `public/app.js:7078-7086` | the same, from `state.outScrolls` |
| `settleScrolls` → `stickConsole` | `public/app.js:7020-7030` → `:7046-7051` | two rAFs later, `stickConsole` **returns early** when `Math.abs(scrollTop - max) <= 1` (`:7049`) — which is exactly the state the clamp leaves it in, so the one late check that exists is a no-op |
| the 400 ms sweep → `stickConsole` | `public/app.js:15005-15015` | the first call that sees the settled height, and the repair in 78 of 97 |

**What is not proven.** This capture never saw the transitional read itself: the recorder only records geometry for a
console it has already flagged as lagging, and at the moment of the restore the box is not yet lagging (it is at the
*bottom* of the short layout). So the sequence "restore reads 145/145 → layout settles to 335 → nothing re-asserts" is the
only explanation consistent with all 97 records, and it is still an inference. Two things would settle it, in this order:

1. `--deep` records the geometry of **every** `stickConsole`/`setScroll`, lagging or not. A live capture during a storm
   should show `stickConsole(<id>) SAW top 145 max 145` right after a rebuild — that is the no-op, caught in the act.
2. A sandbox scenario that can produce a *partial* clamp: every clamp this harness can drive is a full one (a re-appended
   section takes the console to 0, and it recovers in 18–50 ms), so the harness needs a rebuild whose inserted console is
   briefly shorter, not one that removes it.

Until one of those runs, this document says what was measured and refuses to name a cause.

## 6. Reproducing

```
node tools/measure-console-lag.mjs --url http://127.0.0.1:7331 --rows 2 --seconds 75 --json live.json   # the reproduction
node tools/measure-console-lag.mjs --url http://127.0.0.1:7331 --rows 4 --seconds 240 --deep            # the proof attempt
node tools/measure-console-lag.mjs --scenario placeRow --seconds 60 --rate 12 --burst 600              # 0: the exclusion
node tools/measure-console-lag.mjs --scenario cards --seconds 60 --rate 12 --burst 600                 # 0: two consoles, one rebuild
node tools/measure-console-lag.mjs --scenario input --seconds 60 --rate 12 --burst 600                 # the lastInputAt A/B
node tools/measure-console-lag.mjs --scenario clamp --seconds 60 --rate 12 --burst 600                 # ... its control
```

Exit codes: `0` the run measured something, `2` it did not (no Playwright, the consoles never overflowed, the injected
trigger never fired), `1` the page raised an error. A run that reads **0 excursions** is a result, not a failure — it is
what says the sandbox cannot produce this fault.

The live mode is read-only: it opens its own tab, opens the rows of the runs that are live, and posts nothing. The panel
on 7331 was never restarted, written to or clicked by any run in this document.
