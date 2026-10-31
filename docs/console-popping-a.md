# Console popping — slot A

Measured on its own panel instance, with three real agents writing through the panel's own create-run route, recording
both console boxes on every animation frame. No product change.

## The instance

| | |
| --- | --- |
| port | `7332`, host `127.0.0.1` |
| version | **0.34.0** (`package.json`) |
| commit | **6ca7964** — this worktree's `HEAD` on `wtgui/slot-a-of-the-console-po-ddc2a2`, cut from `main` |
| static build | `edb28636c009` (the panel's own boot line) |
| config | `C:/Users/roper/AppData/Local/Temp/wag/pop-a/config.json` (`PANEL_CONFIG`) |
| data dir | `C:/Users/roper/AppData/Local/Temp/wag/pop-a/data` |
| scratch dir | `C:/Users/roper/AppData/Local/Temp/wag/pop-a/scratch` |
| jobs file | `<data>/state/jobs.json` — this instance's own store, empty at boot |
| panel log | `C:/Users/roper/AppData/Local/Temp/wag/pop-a/panel.log` |
| raw frames | `C:/Users/roper/AppData/Local/Temp/wag/pop-a/out/scenario-*.json` |

The config names `dataDir` and `scratchDir` explicitly. That is not a preference in this build: `lib/paths.js`
(`resolveDirs`) deliberately **ignores `WAG_HOME`/`WAG_SCRATCH` for a `PANEL_CONFIG` instance** unless the config
names `dataDir`; a second instance otherwise keeps its state in `<dir of its config>/logs`. `WAG_HOME` and
`WAG_SCRATCH` were exported for this instance too, so both spellings point at the same two folders, and the panel's
boot line proves which one won: `data directory: …\pop-a\data (config) · scratch directory: …\pop-a\scratch (config)`.
`HERMES_HOME` was deliberately **left unset**, so the panel reads the reader's real `state.db` (which is what
`/api/thinking` and the 🧠 block are drawn from) and finds the gateway key in the Hermes `.env`.

### Reproduce it

```bash
# 1. scratch repo the agents poke at (never the panel's own checkout)
mkdir -p C:/Users/roper/AppData/Local/Temp/wag/pop-a/{data,scratch,empty-root,work,out}
cd C:/Users/roper/AppData/Local/Temp/wag/pop-a/work && git init -q -b main && git commit -q --allow-empty -m "main: first"

# 2. the instance (config.json in the scratch dir, as above)
powershell -NoProfile -c "\$env:PANEL_CONFIG='C:\Users\roper\AppData\Local\Temp\wag\pop-a\config.json'; \$env:WAG_HOME='C:\Users\roper\AppData\Local\Temp\wag\pop-a\data'; \$env:WAG_SCRATCH='C:\Users\roper\AppData\Local\Temp\wag\pop-a\scratch'; Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.js' -WorkingDirectory 'C:\ProjectDevelopment\agent-worktree-gui\.worktrees\slot-a-of-the-console-po-ddc2a2' -WindowStyle Hidden -RedirectStandardOutput 'C:\Users\roper\AppData\Local\Temp\wag\pop-a\panel.log' -RedirectStandardError 'C:\Users\roper\AppData\Local\Temp\wag\pop-a\panel.err.log'"

# 3. prove the port is this instance before driving anything
curl -s http://127.0.0.1:7332/api/jobs          # {"jobs":[], …} — its own empty store
curl -s http://127.0.0.1:7332/api/config        # version 0.34.0, projects: ["pop-a"]

# 4. three real runs, through the panel's own create-run route (POST /api/agents, existing:true)
node tools/pop-a.mjs spawn --agents 3 --cycles 25

# 5. one recording per condition (80 s each) — then the table
node tools/pop-a.mjs record --scenario one-own       --mode own      --seconds 80 --threads <t1>
node tools/pop-a.mjs record --scenario one-combined  --mode combined --seconds 80 --threads <t1>
node tools/pop-a.mjs record --scenario three-own     --mode own      --seconds 80 --threads <t1,t2,t3>
node tools/pop-a.mjs record --scenario three-combined --mode combined --seconds 80 --threads <t1,t2,t3>
node tools/pop-a.mjs record --scenario three-minimised --mode own --seconds 80 --threads <t1,t2,t3> --minimise <t2,t3>
node tools/pop-a.mjs report
```

Each agent's prompt is a loop of five *small, sequential* tool calls (`node -e`, a 12-line `write`, `grep -c`, `wc -l`,
`sha256sum`) with three to five sentences of reasoning before every call, in its own folder under the scratch dir, and
"make no git commits anywhere". That produces a continuous stream of short tool rows plus long reasoning, which is the
state the reader reported. `record` attaches Chromium through `tools/browser.mjs` (the repo's Playwright bootstrap) and
adds no other browser stack.

## What was measured, per frame

On every animation frame, for every **overflowing, on-screen** box:

| box | element | note |
| --- | --- | --- |
| main output console | `pre.job-out` (the `<pre>` is the scroller) | `clientHeight` 318 px in this layout |
| reasoning console, own box | `details.think .think-body` | `max-height: 260px; overflow:auto` |
| reasoning in one stream (🌊) | lines **inside** `pre.job-out` | there is no second box; the field is empty by construction |

Per frame and box: `scrollTop`, `scrollHeight`, `clientHeight`, distance from the bottom
(`scrollHeight - scrollTop - clientHeight`), pinned (`distance ≤ 8`), the box's child count, and the number of
`scrollTop` writes that reached that node since the previous frame (a hook on `Element.prototype.scrollTop`). Boxes are
keyed **per node** (`out:<turn>#<uid>`), not per turn: the board can hold two copies of a conversation for a frame, and
merging them attributes one copy's writes to the other's scroll.

Two extra probes were needed to answer the reader's two questions honestly:

* **a paint probe** — after each frame's sample, a `setTimeout(0)` read of the same distance. A rAF sample is taken
  *before* the frame's layout and before the panel's own later callbacks, so it can catch a displacement that never
  reaches the screen. The probe reads what the frame actually painted.
* **a mutation + resize observer** on the console's subtree, to name the row that changed, if any.

Definitions used below, all computed by `tools/pop-a.mjs` from the stored frames (`node tools/pop-a.mjs resummarise`
re-derives them from the raw frames without re-running anything):

* **hops** — a frame where `scrollTop` dropped > 20 px, the previous frame was pinned, and **no scrollTop write** reached
  that node in the frame.
* **longest tail** — the longest run of frames at distance ≤ 8 px, computed over the union of a box's nodes in time
  order (a card rebuild replaces the node, not the console). "While appending" = the same run restricted to runs where
  the content actually changed (child count or `scrollHeight` moved) at least twice.
* **lag** — runs of frames above 8 px: how many, how long (ms), how deep (px), as p50/p90/max.
* **direction** — up-only / down-only / both, from unexplained drops and unexplained rises > 20 px.

Each recording is 80 s of continuous streaming (the brief asks ≥ 75 s), 60 fps, 0 hidden frames, 0 page errors.

## The numbers

"Painted off tail" is the paint probe: frames in which the box **was** off its newest line when the frame was painted.
That column is the reader's claim; the hop column is the mechanism.

| condition | box | frames | hops | longest tail | tail while appending | lag count | lag p50 / p90 / max | painted off tail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 agent, reasoning own box | `pre.job-out` | 4869 | **0** | 81 s | 81 s | 1 | 5 / 5 / 5 ms | **0** |
| | `details.think` | 4869 | **0** | 83 s | 83 s | 0 | – | **0** |
| 1 agent, reasoning combined (🌊) | `pre.job-out` | 4876 | **27** | **5 s** | 5 s | 29 | 16 / 17 / 51 ms | **34** |
| 3 agents, reasoning own box | `pre.job-out` (a) | 4845 | **28** | 8 s | 8 s | 29 | 16 / 17 / 18 ms | **30** |
| | `pre.job-out` (b) | 4845 | **25** | 7 s | 7 s | 26 | 16 / 17 / 18 ms | **30** |
| | `pre.job-out` (c) | 4845 | **0** | 81 s | 81 s | 1 | 16 / 16 / 16 ms | 1 |
| | `details.think` ×3 | 4845 each | **0** | 83 s | 83 s | 0 | – | **0** |
| 3 agents, reasoning combined (🌊) | `pre.job-out` (a) | 4836 | **25** | 7 s | 7 s | 26 | 13 / 20 / 69 ms | **30** |
| | `pre.job-out` (b) | 4836 | **22** | 9 s | 9 s | 23 | 13 / 20 / 47 ms | **28** |
| | `pre.job-out` (c) | 4836 | **23** | 10 s | 10 s | 24 | 13 / 16 / 29 ms | **28** |
| 3 agents, other two minimised | `pre.job-out` (the one on screen) | 4873 | **7** | 16 s | 16 s | 27 | 16 / 17 / 18 ms | **27** |
| | `details.think` | 4873 | **0** | 83 s | 83 s | 0 | – | **0** |

Notes that keep the table honest:

* **The minimised cards render no console at all** (`display:none`, `clientHeight 0`), so they are not measurable boxes
  and are not in the table; the row that is left is the expanded card, which is what the reader is looking at. Its
  console behaves like the expanded ones above (7 hops, 27 painted frames) — minimising the other two changed nothing
  for it.
* **In the combined (🌊) mode there is no second box.** The reasoning is drawn as `.jl-think` rows inside
  `pre.job-out`; the run has three output boxes and zero reasoning boxes. The hops there are the ones with the largest
  gaps (up to 104 px in the one-agent run, 1 233 px on a rebuild).
* **"a" vs "c" above are the same condition.** In the three-agent *own-box* run two consoles hop (28 and 25 times) and
  one does not (0); in the three-agent *combined* run all three do (25, 22, 23). The one that stays put is the console
  whose `scrollHeight` was constant for the whole 80 s — nothing was being laid out in it when the restore landed.
  Which card that is is not a property of the agent: it changed between runs.
* A repeat of the one-agent own-box condition (the same command, 5 minutes earlier) measured **1 hop, 0 painted, 82 s
  tail**. The one-agent own-box result is therefore 0–1 pin losses in 80 s; the reasoning box was 0/0 in both.
* A **card is replaced 5–6 times per 80 s**: `nodes` in the raw summary is 6 for the one-agent and three-agent
  own-box runs, 6 for the three-agent combined run and 7 for the minimised one — one replacement every ~13–16 s. Each
  replacement installs a fresh console at `scrollTop 0` and the panel restores it; that restore is a separate event
  from a hop (it produces a 1 100–1 300 px jump to the top, not a one-to-six-row gap — see "other problems" below).

## Does it flicker?

**Yes — the main output console does, and the reasoning box does not.**

In plain numbers, on this instance, per 80 s of continuous streaming:

* main output console: **22–30 pin losses per 80 s** (about one every 3 s), each of **51–104 px** (three to six rows
  of the console's 17.3 px line height), and **28–34 of the recorded frames were painted with the box off its newest
  line** — i.e. the reader sees it, roughly once every 2.4 s. In the one-agent combined run that is 34 painted frames
  out of 4 876 (the box's frames across its six nodes).
* reasoning box (`details.think`): **0 pin losses, 0 painted frames, 100 % of frames pinned, in all five conditions.**

It is not the reader's own scroll (no input of any kind was sent to the page), not a general instability of the console
(99.4–100 % of frames are pinned), and not the box being dragged around: the console's `clientWidth` was 1293 px in
**every** frame of **every** node of the one-agent combined run (0 width changes in 4 876 frames; the only 1 404 px
frames are the first three of the page, before the board's own scrollbar appeared), so it is not a re-wrap.

The flicker is therefore **a repeated sag of the scrollbar thumb that lasts one frame** (lag p50 16 ms, p90 17 ms,
max 51 ms — one to three frames), not the "jump to the top and stay" that `docs/console-scroll-hop.md` chased.

Two parts of the reader's report reproduce and one does not. It does **not** get worse with more agents on this
instance: one agent alone measured 27 hops, three agents measured 22–28 on each console that hopped. It does **not**
get better when the other rows are minimised: the single card left on screen measured 7 hops and 27 painted frames in
80 s. What reproduces is the thing that matters — the main console leaves its newest line, visibly, every few seconds,
and the reasoning box never does.

## Does the tail hold for 60 s?

**No — not on the main console. Yes — on the reasoning box.**

| box | longest continuous run at the tail (80 s window) |
| --- | --- |
| main output console, one agent, combined | **5 s** |
| main output console, three agents (either setting) | **7–10 s** |
| main output console, two rows minimised | **16 s** |
| main output console, one agent, own box (quiet card) | 81 s |
| reasoning box, every condition | **82–83 s** (the whole window) |

The main console never held 60 s in any condition where the run was writing; its longest run was 16 s. It is *pinned
99.4 % of the time* — it loses the pin about every 3 s and gets it back within one frame — so the honest statement is
"it is almost always at the bottom, and it visibly leaves and returns every few seconds", not "it holds the tail".
The reasoning box held the tail for the entire window in every condition, including the one where two agents were
writing beside it.

## The mechanism, as the series shows it

I can prove the **shape** and the **writer**, not yet the last hop of causality inside Blink. The evidence, from the
one-agent combined run (node `out:17849630#5`, 1 130 frames — that card was rebuilt five times in the 80 s):

```
t=64715.3  sample   st 5005  sh 5323  ch 318  d   0   rows 101  writes-since-last-frame 2  clientWidth 1293
t=64715.4  paint    d 104          ← THE FRAME THAT WAS PAINTED, 104 px short
           (no scrollTop write, no mutation under the console, no width change, no resize of any row)
t=64732.8  sample   st 4901  sh 5323  ch 318  d 104
t=64733.2  write    setScroll < stickConsole < run   4901 -> 5005     (the panel's own settle pass)
t=64733.1  paint    d   0
```

and the restore that lands **0.2–0.6 ms after the sample** is, in 27 of 27 hops, this stack:

```
setScroll < stickConsole < run
```

`run` is `settleScrolls`'s own rAF callback (`public/app.js`, `settleScrolls` → `requestAnimationFrame(() =>
requestAnimationFrame(run))`). `settleScrolls` is called **only** from the repaint paths: `placeRow`,
`renderProjectRows`, `renderJobs`, and the card path. So every hop is a repaint that re-sticks the console and lands
one frame late:

1. a repaint rebuilds/re-sticks the console and writes `scrollTop = scrollHeight`;
2. the write is taken against a `scrollHeight` that is **not final** (a `pre` that has just been re-inserted, or a row
   that is about to be painted one line taller), so the browser clamps the scroll offset down to the height it sees;
3. the content then comes back to its real height, leaving the box exactly `scrollHeight_before - scrollHeight_at_clamp`
   short of the newest line — 51–104 px, i.e. three to six rows;
4. the *next* frame's `settleScrolls` re-sticks it (0.4 ms after the sample that saw it), and the frame in between is
   the one the reader sees.

That the drop is always an exact whole number of rows (51, 52, 69, 104 px against a 17.3 px line height) and that
`scrollHeight` is identical in the samples either side of it is what says "clamped against a momentarily shorter
layout", not "the box was scrolled".

**Candidates ruled out, each by number:**

1. **The reader scrolling** — 0 wheel/pointer/key events were delivered, and every `scroll` event on the box carries
   `isTrusted: true` from the browser with no input window open; a drop with a reader behind it would also set
   `state.outPinned[out] = false`, and the console was still pinned afterwards in 100 % of hops.
2. **A `scrollTop` write moving the box up** — 0 of the 27 hops had a write in the frame that dropped (`w = 0`); the
   writes next to a hop are all *restores* (`from 4901 → to 5005`), which is the fix, not the cause.
3. **The content shrinking and staying shrunk** — 0 of the hits are `shrank: true`: `scrollHeight` is identical in the
   frame before and the frame after. If a row had been removed and stayed removed the box would have been at the
   bottom of a shorter document, not short of the bottom.
4. **A re-wrap from a width change** — `clientWidth` was 1293 px in every frame of every node; 0 changes in 4 876
   frames (one node's first three frames carry 1 404 px, before the board's scrollbar appeared).
5. **A whole-console wipe** (`innerHTML` on `pre.job-out`) — 0 console-level mutations at the hop frames. When the
   console *is* replaced it is replaced as a **node**, which is a different, much larger event (see below), and it
   shows up in the series as a new `#uid` with `scrollTop 0`.
6. **The 400 ms `setInterval` stick** — 0 restores came from it; all 27 name `settleScrolls`'s `run`.
7. **The type pacer as the mover** — the pacer's write (`setScroll < paintTypedLines < onPaint < tick`) is the most
   frequent writer on the console (43–302 writes per run), and it always writes *downward*; it appears in 0 hop frames.
8. **A duplicated card's writes being read as one box's** — ruled out by measuring one node per series; the hop counts
   per node (3–12 inside a single node) are the same shape as the aggregate.

The one thing I could not settle from the series is *which* layout step leaves the `scrollHeight` non-final for that
one frame — a fresh `pre` that has not finished laying out its rows, or a row that is one line taller on the next
layout pass. Both produce the same signature, and both are fixed by the same thing: re-sticking after the layout
settles, not once but on the frame after.

## Other problems seen, with evidence

* **A card is rebuilt 5–6 times per 80 s, and each rebuild is a 1 100–1 300 px jump to the top.** `nodes: 6` in three
  of the four multi-box runs (7 in the minimised one). The rebuild writes `scrollTop = scrollHeight` on a node that was
  at `scrollTop 0` (the write log shows `from 0 → 6339`, `from 0 → 5323`), and the painted depth reaches
  **1 233–1 302 px** in the three-agent combined run — a full jump, not a sag. It is a different defect from the one
  the reader described, but it is the same class: the console is replaced rather than patched, and the restore is
  written before the new node is laid out.
* **One agent's turn failed on its own**, `48e68246` (thread `…9cdf16`), on a continuation turn. The card reads
  `failed` and kept its last 60 stored lines; not a console-rendering fault, but the card stops streaming, so a
  condition recorded afterwards measures a quiet console. Every per-condition window in this document was checked for
  that: the recorded runs had 2–3 live, writing runs and 0 page errors.
* **A console that is not writing does not hop.** In the 23:11 three-own run one console's `scrollHeight` was constant
  for the whole 80 s and it measured **0 hops**, beside two consoles at 25 and 28 hops in the same page, at the same
  time, on the same repaint clock. So the repaint is necessary but not sufficient: the hop needs the console's content
  to be moving when the restore lands, which is consistent with the reader seeing it "every few seconds" while a run
  writes, rather than on every line.
* **In the minimised condition the two collapsed cards have no box at all** — `display:none`, `clientHeight 0`. Any
  future measurement that counts `pre.job-out` elements will over-count boxes that cannot be seen; this tool skips
  `clientHeight === 0` and says so.
* **Nothing moved in the reasoning box, in any condition, ever**: 0 hops, 0 painted frames, 100 % pinned, `clientWidth`
  constant. If the reader's reasoning box ever moves, it is not this panel's repaint path and should be reported
  separately.

## What is not reproducible here

* A **60 s tail hold on the main console** — no condition produced one; the longest was 16 s, and that was the single
  expanded card with two agents minimised.
* **A visible jump caused by the type pacer** — the pacer writes on every tick and always downward; it never leaves
  the box off its tail in the series.
* **Any movement at all in the reasoning box** — the separate block and the one-stream rows were both rock-steady.
