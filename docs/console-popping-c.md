# The console pops under one agent, in both renderers — and its tail never holds a minute

The reader's report: a live agent's **main output console** jumps up its scrollbar every few seconds as text is
written to it, with the reasoning **combined** into that console and with the reasoning **in its own box**, and the
reasoning box is much more stable. This is slot C's measurement of exactly that: one agent at a time, on its own
panel instance, a real run writing for minutes, every frame recorded.

**The answer.** Yes, it pops, in both renderers, at **10–14 painted jumps per 75 s**; and no, the tail **never holds
60 s** — the longest continuous pin while the run was appending was **15.1 s**, and three of the four windows peaked
at 7.9–9.4 s. In the same runs the reasoning box, in its own box, popped **zero** times, including a run where it grew
648 px over 31 appends. Nothing about the board caused any of it: one project, no section moved, no page error.

## 1. The instance

| | |
| --- | --- |
| port | **7334** (`host` 127.0.0.1, its own `PANEL_CONFIG`) |
| version | **0.34.0** (`package.json`) |
| commit | **6ca7964** (`6ca79644b7cfe3d59ad1b0bcd546f305d7738b1d`) |
| build hash | `edb28636c009` (`GET /api/build`) |
| data / scratch | `C:/Users/roper/AppData/Local/Temp/wag/pop-c/home` · `…/pop-c/scratch` — not the reader's `~/.wag` |
| agent | real run through the gateway at `127.0.0.1:8642`, `deepseek/deepseek-v4.1-flash-1017`, reasoning `medium` (`high` for `pop-c-separated-6`) |
| job store | its own (`GET /api/jobs` was empty at boot; 102 jobs on the reader's 7331 were never read or written) |

The instance's config, written in the slot's own scratch and handed over with `PANEL_CONFIG` (the documented second
instance, `server.js:109-111`); `dataDir`/`scratchDir` make it keep its state rather than fall back to `~/.wag`:

```json
{ "port": 7334, "host": "127.0.0.1",
  "scanRoots": ["C:/Users/roper/AppData/Local/Temp/wag/pop-c/fixture"],
  "projects": [], "threads": 3, "liveSeconds": 3, "refreshSeconds": 30,
  "dataDir": "C:/Users/roper/AppData/Local/Temp/wag/pop-c/home",
  "scratchDir": "C:/Users/roper/AppData/Local/Temp/wag/pop-c/scratch/dir",
  "defaultCwd": "C:/Users/roper/AppData/Local/Temp/wag/pop-c/fixture/pop-c-fixture" }
```

```sh
cd C:/ProjectDevelopment/agent-worktree-gui/.worktrees/slot-c-of-the-console-po-fd7f60
PANEL_CONFIG=C:/Users/roper/AppData/Local/Temp/wag/pop-c/config.json \
WAG_HOME=C:/Users/roper/AppData/Local/Temp/wag/pop-c/home \
WAG_SCRATCH=C:/Users/roper/AppData/Local/Temp/wag/pop-c/scratch/dir node server.js
```

Before driving anything: `GET /api/config` answers `0.34.0` with the one scan root above, and `GET /api/jobs` reads
that instance's own store. The run is spawned through the panel's own create-run path (`POST /api/agents`) against a
throwaway git repo with one commit (`…/pop-c/fixture/pop-c-fixture`); the fixture prompt is embedded in the tool and
tells the agent to stay inside `…/pop-c/agentbox`, make no commits and no pushes. It ran its 30 cycles to completion
every time (60 lines per job).

## 2. What is measured, per frame

`tools/pop-c.mjs` attaches Chromium to the instance, turns thinking on and stream mode to the condition, expands the
job's project and row, and samples **one frame per animation frame, after that frame has been painted** (the `rAF`
callback schedules a `setTimeout(0)`, which runs once the frame's paint is done — a dip the page repairs inside the
same frame is therefore *not* counted, so these numbers are a lower bound). Per overflowing box it records
`scrollTop`, `scrollHeight`, `clientHeight`, distance from the bottom, pinned (`distance ≤ 8`), the box's own rect and
the timestamps. It also wraps `scrollTop`'s setter and the scroll APIs to see every write **on** the box, observes the
box's child/text/attribute mutations and its scroll events, and tracks element identity, so a hop is attributed
rather than merely counted.

| box | selector | appears in |
| --- | --- | --- |
| `output` | `pre.job-out` (`data-out`) | both renderers |
| `reason` | `details.think .think-body` (`data-think-turn`) | separated only — in 🌊 the reasoning is rows **of the console** (`pre.job-out .jl-think`: up to 37 of them in a combined run, 0 in a separated one) |

* **hop** — a frame whose `scrollTop` dropped by more than 20 px while the previous frame was pinned (distance ≤ 8 px).
  The reader is a reader who never scrolled: the tool never scrolls a measured box, only the page, to keep the box on
  screen (it was on screen in 4,355–4,391 of ~4,380 frames per box).
* **tail retention** — the longest run of consecutive pinned frames inside an append episode; an append is a frame
  whose `scrollHeight` grew, and a gap of more than 2 s between appends ends the episode (that is streaming stopping,
  not the box moving).
* **lag** — excursions with distance > 8 px: count, duration p50/p90/max, depth p50/p90/max.

The window is **75 s** counted from the first frame in which every expected box overflows; the capture runs 125 s (or
until the run stops writing) so the tail can also be followed past the window.

## 3. The numbers

Four runs, two per condition, each a fresh real run; all four windows 75 s from overflow, each capture ≈122–126 s.

| condition | job | box | appends | hops | hops/min | longest tail retention | lag n | lag p50/p90/max ms | excursion depth p50/p90/max px | up/down | pinned frames | on screen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| combined (🌊) | `cad09e7c` | output | 212 | **18** | 14.4 | **7.9 s** | 18 | 7/8/12 | 535/759/862 | 18/109 | 4,359/4,378 | 4,377 |
| combined (🌊) | `aa8c6e8d` | output | 176 | **13** | 10.4 | **15.1 s** | 14 | 7/10/12 | 638/862/914 | 13/74 | 4,377/4,392 | 4,391 |
| separated | `852d9ed5` | output | 131 | **17** | 13.6 | **9.4 s** | 17 | 8/13/17 | 604/931/1,070 | 17/71 | 4,341/4,359 | 4,358 |
| separated | `852d9ed5` | reason | 2 | **0** | 0 | **2.0 s** | 0 | – | – | 0/0 | 4,358/4,359 | 4,358 |
| separated | `24eeccbe` | output | 88 | **17** | 13.6 | **8.1 s** | 17 | 8/10/16 | 638/811/845 | 17/46 | 4,338/4,356 | 4,355 |
| separated | `24eeccbe` | reason | 31 | **0** | 0 | **3.3 s** | 0 | – | – | 0/5 | 4,355/4,356 | 4,355 |

* **65 upward pops in 300 s of output console, 13/min.** Per window: 18, 13, 17, 17 — combined mean 15.5, separated
  mean 17.0. The cadence is **4–5 s** between pops (intervals 0–12 s), which is the reader's "every few seconds".
* **Every pop is one painted frame.** The lag p50/p90 are 7–8/8–13 ms — a single frame at 59 fps — and the box is back
  on its tail on the next sample. That is what "flicker" means here: not a parked position, one frame at a time.
* **The pop and the distance it leaves are the same number**: in **61 of 65** hops the distance from the bottom after
  the hop equals the size of the drop. The box is moved to a position that is exactly its own drop short of the tail.
* **The downward catch-up is the same fault from the other side**: 46–109 frames per window jump the box *down* by
  more than 20 px — the panel pulling it back. Pinned share is 99.3–99.7% of frames, which is why it reads as a
  blink rather than a scroll.
* Whole capture (≈122–126 s, not just the 75 s window): 22–34 pops on the output console; longest retention anywhere
  in the capture **15.1 s** for the output console, **25.4 s** for a reasoning box (`pop-c-separated-6`), both short
  of a minute.

## 4. The two plain answers

**Does it flicker?** Yes. The main output console leaves its tail **13–18 times per 75 s** (13/min across the four
windows), each time 0.1–1.1 k px up, painted for one frame (~17 ms) and back on the next or second frame. It happens
with the reasoning combined into the console (18 and 13 pops) and with the reasoning in its own box (17 and 17 pops),
which is the reader's "with reasoning combined *and* alone".

**Does the tail hold for 60 s?** No. The longest unbroken pin while the run was appending was **15.1 s** (combined,
`aa8c6e8d`); the other three windows peaked at 7.9 s, 9.4 s and 8.1 s. Across the whole 122–126 s captures the longest
seen anywhere was 25.4 s, and that was the reasoning box of a separated run, not the output console. A tail that is
being appended to on this build holds for single-digit seconds between pops.

## 5. The two boxes in the same run

This is slot C's separate job: one agent, reasoning combined, then reasoning in its own box, 75 s each, and whether
the hop count differs between the two boxes **in the same run**.

| run | output console | reasoning box | output hops per 100 appends | reason hops per 100 appends |
| --- | --- | --- | --- | --- |
| `852d9ed5` (separated) | 17 hops / 4,359 frames / 131 appends | **0** hops / 4,359 frames / 2 appends | 13.0 | **0** |
| `24eeccbe` (separated) | 17 hops / 4,356 frames / 88 appends | **0** hops / 4,356 frames / 31 appends | 19.3 | **0** |

Yes, the counts differ, and not only because the reasoning box writes less: `24eeccbe`'s reasoning box got 31 appends
and grew 648 px in the same window, and still never left its tail once (99.99% pinned), while the console beside it,
in the same card, in the same frames, popped 17 times. The two boxes are drawn by different code paths and behave
differently in the same run — which is the reader's report, reproduced.

## 6. What else the series shows

* **The console is rebuilt row by row while it streams.** 2,082–3,034 `innerHTML` writes on console rows per capture
  (~17–25/s), against 88–212 appends: most re-renders of a row add no line.
* **The card's console node is replaced while streaming.** 2–4 element swaps per capture (0–1 inside a window): a
  fresh `pre` with its own scroll position, after which the old node's series simply ends. The recorder treats each
  element as its own box; the table follows the node that lives through the window. This is a rebuild under the
  reader that no scroll write explains, and it deserves its own look.
* **No page errors** in any of the four captures, and **no board re-ranking**: zero DOM operations on `section`/
  `project` nodes in any capture. With one project on this instance the ranking cannot move, so the campaign's other
  hop (the section re-append, `docs/console-scroll-hop.md`) is not available here — every pop above has to come from
  the card's own render path.
* **The box stays put on the page**: in all 65 hops the box's own rect moved 0 px; the page scroll changes only when
  the tool re-centres it, and no attribute mutations were seen in any hop frame.

## 7. The mechanism, and what the series rules out

What the series proves, per hop: the pop is **painted**; in that frame the box's `scrollHeight` is unchanged (net),
its height is unchanged, its element is unchanged, it did not move on the page, and the page did not scroll. Every one
of the 65 hops carries exactly one scroll event on the box.

Ruled out, by number, across the 65 hops:

| candidate | how it would show | measured |
| --- | --- | --- |
| a script write on the box in the hop frame | a wrapped `scrollTop=`/`scrollTo` on the box | **7/18, 8/13, 16/17, 4/17** hops — present in some, absent in **11/18, 5/13, 1/17, 13/17**, so writes are neither necessary nor sufficient |
| content growth in the hop frame | `scrollHeight` grew that frame | **1, 2, 0, 1** hops — the rest grew 0 px |
| the box resized | its rect height changed | **0 of 65** |
| the console element swapped | element identity changed | **0 of 65** |
| the page scrolling under it | the box's rect moved | **0 of 65** (box moved 0 px; `docScroll` only changes on the tool's own re-centre) |
| browser scroll anchoring | — | not available: `html`, `.job` and `.job-out` all set `overflow-anchor: none` (`public/style.css:81`, `:666`, `:967`) |
| a shrink of the content | `scrollHeight` fell that frame | **0–1** frames per window, none in a hop frame |
| a board re-rank moving the card | an op on `section.project` | **0** in every capture |
| the reader scrolling | — | the only browser in this instance is the tool's, and it never scrolls a box |

What it does **not** isolate. In the hop frames that carry a write, that write is the panel's own stick —
`stickConsole` / `restoreScrolls` / `applyStoredScrolls` / `paintTypedLines` — and the value it writes is
`scrollHeight` of the box *as it is at that instant*. Those frames also carry a row replacement (`innerHTML` of one
`.jl-text`/`.jl-think` row, +1/−1 nodes). The shape is consistent with the stick landing against a box that is
transiently **shorter** while its row is being swapped (the write is clamped to the shorter height, the row comes
back, and the frame paints `drop` px above the tail until the next stick), but the series cannot isolate it: proving
a transient height needs a `scrollHeight` read inside the frame, and that read forces the very layout the measurement
is trying to observe. In the other hops (no write, no mutation, one scroll event, `distance after = drop`) the mover
is not named at all. So: **the pop is established and its shape is established; the mover is a leading candidate, not
a proven cause** — and it is not growth, not a resize, not a swap, not the board, not anchoring, and only sometimes a
script write.

## 8. What this instance could not produce

* **Three agents writing at once**, and the same with two rows minimised — the reader's worst case. This slot's brief
  is the one-agent cases; the three-agent and minimised conditions belong to slots A and B, and nothing here should be
  read as evidence about them.
* **The "worse with more agents" half of the report**: untested here, by construction.
* **A board whose ranking moves**: one project on this instance, so the re-rank path cannot fire (0 section ops —
  which is a result in itself: the pops happen with no re-rank at all).

## 9. Reproducing it

```sh
# a throwaway repo for the run to poke at (own scratch, never the project checkout)
mkdir -p C:/Users/roper/AppData/Local/Temp/wag/pop-c/fixture/pop-c-fixture
cd C:/Users/roper/AppData/Local/Temp/wag/pop-c/fixture/pop-c-fixture
git init -q -b main .
git -c user.name=PopC -c user.email=popc@localhost -c commit.gpgsign=false commit -q --allow-empty -m "fixture"

# the instance (section 1's config + env), then:
node tools/pop-c.mjs --spawn --thread pop-c-combined-5
node tools/pop-c.mjs --measure --thread pop-c-combined-5 --mode combined --seconds 125 --window 75

node tools/pop-c.mjs --spawn --thread pop-c-separated-6 --effort high
node tools/pop-c.mjs --measure --thread pop-c-separated-6 --mode separated --seconds 125 --window 75
```

Each `--measure` writes its raw per-frame series and a metrics JSON to
`C:/Users/roper/AppData/Local/Temp/wag/pop-c/reports/` (`pop-c-<mode>-<stamp>.json`, `…-metrics.json`) and prints the
table above. Exit code 2 means the run did not produce the condition (no live job, a box that never overflowed, no
Playwright) — a clean number over an empty window proves nothing.
