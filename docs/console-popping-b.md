# Console popping, slot B: the main console hops, the reasoning box does not

The reader's report: a live agent's **main output console** jumps up and down its scrollbar every few seconds, while
the **reasoning console**, when it is its own box, is much more stable — with reasoning combined and alone, and worse
as more agents write, minimised or not. This is slot B's independent measurement of that, on its own panel instance,
with its own config, port and scratch. Nothing here is a fix and no product file was touched.

**The answer in one line.** The main output console does hop — 10 to 28 times per 75 s window, always upward, 52–552 px,
each one repaired inside a frame — and its longest run pinned at the tail while output arrived was **26.6 s**, never
60 s. The reasoning box, measured in its own scroller in five windows, never hopped once and was pinned for the **whole
75 s** of every one of them.

## The instance

| | |
| --- | --- |
| port | **7333** (`127.0.0.1:7333`), its own `PANEL_CONFIG`, `WAG_HOME`, `WAG_SCRATCH` |
| panel version | **0.34.0** (`/api/config`) |
| commit | **`6ca7964`** — `fix: re-ordering a row's cards no longer resets their consoles`, branch `wtgui/slot-b-of-the-console-po-c51ceb` |
| static build | `edb28636c009` (`/api/build`) |
| config | `C:/Users/roper/AppData/Local/Temp/wag/pop-b/config.json` |
| scratch / state | `C:/Users/roper/AppData/Local/Temp/wag/pop-b/` (`wag-home/`, `scratch/`, `logs/`) |
| board | one project (`pop-b-probe`) over `…/pop-b/work/repo`, a throwaway git repo the agents were told to work in |
| gateway | `http://127.0.0.1:8642`, reachable and keyed (`/api/jobs` → `transport.reachable: true`); `run_cwd` is **not** advertised, so the agents were told to `cd` into the scratch copy themselves |
| evidence | `C:/Users/roper/AppData/Local/Temp/wag/pop-b/report/pop-b-<condition>.json` (+ `…-trace.json`, screenshots) |

Reproduce, from **this worktree** (`node server.js` here, so `logs/` and the jobs store land in this tree):

```bash
cd "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/slot-b-of-the-console-po-c51ceb"
export PANEL_CONFIG="C:/Users/roper/AppData/Local/Temp/wag/pop-b/config.json"
export WAG_HOME="C:/Users/roper/AppData/Local/Temp/wag/pop-b/wag-home"
export WAG_SCRATCH="C:/Users/roper/AppData/Local/Temp/wag/pop-b/scratch"
export API_SERVER_KEY=…        # the Hermes gateway key, from the environment only
node server.js

# then, in a second shell, the measurement: it starts the three agents through POST /api/agents,
# sets each session's renderer, records every animation frame and prints the numbers
node tools/pop-b.mjs --base http://127.0.0.1:7333 --seconds 75
node tools/pop-b.mjs --base http://127.0.0.1:7333 --seconds 75 --only one-combined --only three-ownbox-min
node tools/pop-b.mjs --base http://127.0.0.1:7333 --seconds 40 --only one-combined --trace   # who moved it
```

Before driving anything, `GET /api/config` answered `{"version":"0.34.0",…}` and `GET /api/jobs` read this instance's
own empty store with `transport.reachable: true`. Both were checked on 7333, never on the reader's 7331.

## The agents

Three threads, all started through the panel's own create-run path (`POST /api/agents`, `existing: true`, `cwd` the
scratch repo, `project: pop-b-probe`), each told in its prompt to stay inside `…/pop-b/work/repo`, make no commits, push
nothing, and keep looping for 25 minutes: **A** a `node -e` / `node --test` / read-`math.js` loop, **B** an
append/read/grep/patch loop on `notes-b.md`, **C** long reasoning with one command between each bout. `GET /api/jobs`
on 7333 showed them `running` throughout; when a turn ended early the tool started a new turn **on the same thread**
between conditions, so every window below has output arriving for its whole length.

## Method

A real Chromium (`tools/browser.mjs`, the repo's own Playwright bootstrap) over the running instance, not a fixture. On
**every animation frame** the page records, for every **overflowing** console box:

- `pre.job-out` — the main output console, its own scroll container (`max-height: 320px`, `overflow: auto`);
- `details.think .think-body` — the reasoning box when it is its own box (`max-height: 260px`, `overflow: auto`).

per box: `scrollTop`, `scrollHeight`, `clientHeight`, `distance = scrollHeight − scrollTop − clientHeight`,
`pinned = distance ≤ 8 px`, row count and the timestamp, plus which node it is. The two renderers are set **before**
the page's own scripts run (`wtgui.think.<thread>` = 1 in both, `wtgui.stream.<thread>` = 1 for *combined* — the 🌊
card where reasoning is rows of the console — and 0 for *own box*), so each condition measures a card built in that
shape rather than toggled into it.

From the series, per box:

- **hop** — `scrollTop` drops by more than 20 px between two frames, the previous frame was pinned, and nothing the
  reader did scrolled the box (no wheel / mousedown / pointerdown / keydown / touchstart on it in the preceding 400 ms);
- **tail retention** — the longest continuous run of frames at the tail (distance ≤ 8 px) that contains at least one
  frame in which the box **grew**. "Grew" is `scrollHeight` up by > 0.5 px or a new row: a streamed block types text
  into a row without adding one, and a row counter alone reports "nothing arrived" through a whole window (measured:
  0 new rows against 55–211 growing frames);
- **lag** — every stretch off the tail (distance > 8 px): how many, how many frames, how long, how deep;
- **direction** — whether `scrollTop` ever moved up or down while output was being appended.

Each condition ran **75 s** of continuous streaming, in one browser context of its own, with the card expanded and its
reasoning block open. A 75 s window is 4,451–4,501 frames at 59–60 fps.

## The numbers

`frames` = frames the box existed and was sampled; `ovf` = of those, the frames it was actually overflowing (a box
with no scrollbar cannot hop); `+rows` = rows added over the window; **tail** = longest pinned run while growing, in
seconds; `lag` = excursions / frames off the tail; `depth` = deepest excursion; `dur` = excursion duration p50/p90/max
in ms.

| condition | run | box | frames | ovf | +rows | hops | tail (s) | lag | depth (px) | dur (ms) | dir |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| one agent, combined | popb-a | main `pre.job-out` | 4451 | 4451 | 0 | **19** | **19.2** | 19 / 19 | 552 | 0/0/0 | down |
| one agent, own box | popb-a | main `pre.job-out` | 4489 | 4489 | 2 | **0** | **75.0** | 0 / 0 | – | – | down |
| one agent, own box | popb-a | reasoning `.think-body` | 4489 | 4489 | 1 | **0** | **75.0** | 0 / 0 | – | – | down |
| three, combined | popb-a | main `pre.job-out` | 4476 | 4476 | 22 | **21** | **10.1** | 20 / 20 | 552 | 0/0/0 | down |
| three, combined | popb-b | main `pre.job-out` | 4476 | 3452 | 86 | **10** | **26.6** | 11 / 11 | 52 | 0/0/0 | down |
| three, combined | popb-c | main `pre.job-out` | 4476 | 4413 | 196 | **16** | **10.7** | 17 / 18 | 328 | 0/0/14 | down |
| three, own box | popb-a | main `pre.job-out` | 4464 | 4464 | 4 | **1** | **75.0** | 0 / 0 | – | – | down |
| three, own box | popb-a | reasoning `.think-body` | 4464 | 4464 | 1 | **0** | **75.0** | 0 / 0 | – | – | down |
| three, own box | popb-b | main `pre.job-out` | 4464 | **0** | 4 | **0** | 75.0 | 0 / 0 | – | – | neither |
| three, own box | popb-b | reasoning `.think-body` | 4464 | 4464 | 1 | **0** | **75.0** | 0 / 0 | – | – | down |
| three, own box | popb-c | main `pre.job-out` | 4464 | 4464 | 17 | **28** | **5.7** | 28 / 28 | 379 | 0/0/0 | down |
| three, own box | popb-c | reasoning `.think-body` | 4464 | 4464 | 4 | **0** | **75.0** | 0 / 0 | – | – | down |
| three + two minimised, combined | popb-a | main `pre.job-out` | 4501 | 4501 | 20 | **25** | **5.4** | 25 / 25 | 552 | 0/0/0 | down |
| three + two minimised, own box | popb-a | main `pre.job-out` | 4500 | 4500 | 1 | **0** | **75.0** | 0 / 0 | – | – | down |
| three + two minimised, own box | popb-a | reasoning `.think-body` | 4500 | 4500 | 0 | **0** | **75.0** | 0 / 0 | – | – | down |

Minimised means the other two cards were collapsed (`wm.collapsedJobs`, the panel's own per-browser fold list,
verified `collapsed: true` on both at the start of the window); those threads were still writing, which is the point of
the condition, but only the visible card's boxes were measured.

**The console's hop rate per window:** 19, 21, 10, 16, 28, 25 hops — one every 2.7–7.5 s — and 0 or 1 in the four
windows whose card appended little or not at all (one of those consoles never overflowed, so it had no scrollbar to
hop). Gaps between consecutive hops are not one clock: the measured sequence for popb-a in the one-agent combined
window is 19.3, 0.9, 4.2, 1.6, 3.5, 0.9, 4.2, 5.0, 1.3, 4.7, 4.1, 0.9, 4.2, 1.3 s — pairs 0.9–1.6 s apart, then hops
3.5–5.1 s apart.

## The two questions

**Does it flicker?** **Yes** — the main output console does. In 6 of the 7 windows where its console was overflowing it
left the tail 10–28 times per 75 s, always upward, by 52–552 px, and came back inside a frame (19–28 frames off the
tail in 4,464–4,501: 0.4–0.6 % of frames). It does it with reasoning **combined** *and* with reasoning in its **own
box** (popb-c: 28 hops, 5.7 s tail in the own-box window), with one agent writing and with three (10–28 hops in the
combined three-agent window), and with the other two cards minimised (25 hops). The reasoning box never hopped in any
window.

**Does the tail hold for over 60 s?** **No for the console.** Its longest continuous run pinned at the tail *while
output was arriving* was 26.6 s (popb-b, three agents, combined); the other console windows gave 19.2, 10.1, 10.7, 5.7
and 5.4 s. None reached 60 s, and the hops are why: every hop ends the run. **Yes for the reasoning box**: it was
pinned for the full 75.0 s of every one of the five windows it was measured in, with 0 hops — the window ended while it
was still pinned, so 75 s is a floor, not a limit.

## The mechanism: what the series proves, and what it does not

Proven from the series (`--trace`, a 45 s one-agent combined window of 2,676 frames; every hop checked against the
page's own calls):

1. **It is an upward move of the same element.** The console node never changes — 0 node swaps across the 2,676 frames,
   and `swapped: false` on all 9 hops. `scrollTop` goes from the bottom to bottom − 276…707 px with `scrollHeight` and
   `clientHeight` **identical on both sides of the hop**, and it is back at the old position (within 0–20 px) within
   250 ms (`backTo` in the trace).
2. **No scroll call of the page's moves it up.** The tracer records every `scrollTop` assignment, `scrollTo`, `scrollBy`,
   `scroll` and `scrollIntoView` that would take a console **up** by more than 20 px; it recorded **none in the whole
   window**, so none of the 9 hops lands within 120 ms of one. Every hop (9 of 9), by contrast, carries a scroll event
   the browser raised by itself. (A downward write is deliberately not in that list — the pull-back *is* the panel's
   stick, and it is what ends the excursion.) The panel's scroll writes are instrumented at the prototype level, so a
   write from any of its paths, `setScroll` (`public/app.js:7005`) included, would have been caught.
3. **It is not the reader.** Excluded by construction: no wheel, mousedown, pointerdown, keydown or touchstart on the
   box in the 400 ms before the hop.
4. **It is not native scroll anchoring.** The box and the card both opt out (`public/style.css:977`
   `.job-out { overflow-anchor: none }`, `:666` `.job { overflow-anchor: none }`, `:81` `html`).
5. **It is not content disappearing from the tail.** `scrollHeight` after the hop equals what it was before, and the
   window counted 1 shrink in total, none of them at a hop.

What the series shows happening instead: in the same 45 s the cards under the row were **moved in the DOM 162 times**
(`MutationObserver`: 72 × “1 removed, 0 added” plus 72 × “1 removed, 1 added” on `.agents-block`, 18 card additions to
the `TBODY`), and **8 of the 9 hops sat within 120 ms of one of those moves** (the ninth fell outside that window). A
move re-appends a node that is already in the page, which takes the scroll areas inside it out of the layout tree and
back — the family `docs/console-scroll-hop.md` already names for `reorderProjects()`. That document's repair path
(`drawJobLine` / `paintTypedLines` / `stickConsole`, 4–376 ms) matches the `backTo` figures here.

**What is not proven**, and why I am not naming it as the cause: a card move alone cannot explain the split inside one
card — the console and the reasoning box live in the **same moved card**, yet in every own-box window the reasoning box
was pinned for 75 s with 0 hops while the console hopped up to 28 times. The remaining candidates, each with its number:

- **A stale "bottom" across the move.** The move is repaired with a position computed before the console's last growth,
  so the box comes back that much above the new bottom and the next stick pulls it down. That predicts a hop size that
  tracks growth between capture and repair; the hop sizes here are 52 px (a card appending slowly, popb-b) to 552 px (a
  card appending continuously, popb-a), which fits, but the reasoning box grew in the same windows (59–60 growing
  frames) and did not hop, so this does not explain the split on its own.
- **The console's own growth/stick race** inside a single frame (`appendJobLine`/`drawJobLine`, and in the 🌊 card
  `paintStreamConsole` → `syncStreamConsole`, `public/app.js:6644/6572`), where the browser clamps the box for the one
  frame between a row growing and the stick that follows. It fits every number (one frame off the tail, no JS write,
  height constant either side) and it is console-only by construction — the reasoning box's `stickThinkBody` path is
  separate — but a single frame is under the sampler's resolution, so the series cannot separate it from the move.

To settle it, the next measurement needs a sample inside the frame (a `ResizeObserver` on the box, or `beginFrame`
tracing through CDP), not another animation-frame series.

## Other problems seen

- **A turn failed with no reason.** `popb-c` turn `ab312183` ended `status: failed` with `error: null` and
  `exitCode: null` (`GET /api/jobs`, 23:04:25) — nothing on the card or in the store says why.
- **A minimised card came back expanded when its agent started a new turn.** In a `three-ownbox-min` run at 23:17 the
  card for a thread that had just been given a new turn would not stay collapsed through three clicks (reported
  `collapsed: false` after the retries); the same code in the next run collapsed it on the first pass. In that window
  the more it wrote, the more it reopened, which is the reader's "whether or not they were minimised".
- **A console that is not full cannot hop.** popb-b's console was overflowing for 0 of 4,464 frames in one window and
  hopped 0 times: a short console is measured, not excused.
- **Nested agents stop early.** Several turns ended at 60 lines although told to work for 25 minutes; the windows were
  kept streaming by starting a new turn on the same thread between conditions, so a card's console in a later window is
  that thread's newest turn.
- **Measurement note, not a bug:** a streamed row grows without adding a row. Detecting appends by row count reports
  "0 rows" through a window that was writing the whole time (55–211 growing frames); the tool counts `scrollHeight`
  growth as well.

## What I could not reproduce

- **"Worse with three agents."** The hop count per card did not grow with the number of writers: one agent gave 19
  hops/75 s, three agents gave 21 (a), 10 (b), 16 (c), and the minimised case 25 — inside one card's own window-to-window
  variance, not a trend. The spread is explained by how much the card appended in that window, not by how many agents
  were live (the console of a card that appended 196 rows hopped 16 times; the one that appended 17 hopped 28).
- **"Much more stable reasoning console" as a console claim** — it is true of the reasoning **box** (0 hops, 75 s pinned,
  five windows) but not of the main console in the same setting: in own-box mode the console still hopped 28 times.
- **A hop that leaves the tail for longer than a frame.** In 7 windows every excursion was one sampled frame
  (p50/p90 0 ms, max 14 ms): the box is never *seen* away from the tail for long, it is the scrollbar thumb that moves.

## Files

- `tools/pop-b.mjs` — the measurement tool (this document's numbers come from it, `--seconds`, `--only`, `--trace`).
- `C:/Users/roper/AppData/Local/Temp/wag/pop-b/report/pop-b-*.json` — every frame count and statistic per condition;
  `…-trace.json` holds the scroll assignments, DOM moves and scroll events of the traced window.
