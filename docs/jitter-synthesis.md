# The console's jitter, reconciled: one ranking and one test

Three investigations finished the same question from three angles: `jitter-sources.md` mapped which function repaints
each surface (commit `e769e0a`), `jitter-streaming.md` counted the seconds while tokens flow and while the wire is
paused (`602d210`), and `jitter-static.md` measured both consoles at rest (`f4144a3`). Each is right about what it
measured, and they were never read against each other. This note does that, then turns the result into one number
table and one command.

The short answer. All three agree on the load-bearing fact: **the console's row nodes are never replaced by the
streaming path** — what churns is the text inside a row, and what replaces rows is `paintThink`'s block rebuild (every
~2.4 s, flowing or not) and the board's 30 s resync (the whole card at once). Ranked by how much of the reported
jitter each explains: the pacer's in-place rewrite first (77% of the DOM mutations a live stream produces), the
thinking block second (100% of the churn that survives a pause), the resync third (every row, twice a minute, because
`jobline` frames never stamp the liveness clock). `tools/verify-console-jitter.mjs` measures those three plus the
scroll, prints the four numbers, and exits non-zero only on the thresholds argued below.

Measured 2026-10-30 on `b64642d` with `tools/verify-console-jitter.mjs` (one pass per card mode, headed Chromium,
sandbox panels of its own). The three source reports were measured on the same tree and commit.

## 1. Where the three agree

| claim | `jitter-sources` | `jitter-streaming` | `jitter-static` | shared mechanism |
| --- | --- | --- | --- | --- |
| the console's own repaint patches; a row keeps its node | 0 `innerHTML` writes on `pre.job-out`; rows patched one at a time (7505 / 6327); the console is only replaced as a *node* by `renderConversation` 7309 / `#jobs` innerHTML 6949 | 27 polls, `kept == stamped` on 27 of 27 (2 → 48 rows); 208 appends = 193 in place + 15 new + **0 replaced** | 0 mutations inside the console in 10 s, settled and running; 0 node replacements except the resync at 24.92 s | `drawJobLine`'s `mode:"set"` branch and `syncStreamConsole`'s keyed patch. The console element is created in a template and never written with `innerHTML`. |
| the text inside a row is rewritten on the pacer's clock | 50 `innerHTML` writes on `.jl` for 25 frames (2 per frame: 7505 + 6327), 54 `setScroll`, 0 backwards | 23.5 prose rewrites/s + 12.4 reasoning rewrites/s; 566 pacer paints and 208 live appends in 29 s; selection median 50 ms | 0 rewrites at rest (the control) | `core/type-stream.js` tick (≈25/s at the 40 words/s default) → `paintTypedLines` 6327, plus the 120 ms live append (7505). The row survives; its text nodes do not. |
| the thinking block is replaced whole on every store poll | 1 `replaceWith:think` per read (node uid 2 → 3) | `detailsReplaced = 1` on **28 of 28** polls; **0 of 1..24** blocks kept; 3.4 block nodes/s flowing, **5.6/s paused** | 4 rebuilds in 10 s, 17 in 40 s = **0.43/s**, 8.7–19.1 ms each, a 1,465-char selection → 0 chars | `sweepThinking` 3816 (1200 ms) + the 2000 ms freshness gate → `loadThinking` → `paintThink` 6557: `holder.innerHTML = thinkHtml`, `el.replaceWith(fresh)`, then `stickThinkBody` writes the scroll back. |
| the scroll is the panel's, not the fault | 54 `setScroll` for 29 lines, 0 backwards; the 400 ms stick no-ops at the bottom | 167 movements, **0 with user input, 0 upward**, 0 px from the bottom at every frame sampled | 0 writes settled; open block 4 writes/10 s, every one `0 → 26,600` (a restore), 0 px rect delta | `setScroll` 6802 is the only writer; native anchoring is off (`html`/`.job`/`.job-out`) and `compensateAnchor` moves the *page* only. |
| it is not frames, and not animation | `transition-duration: 0s` / `animation-name: none` on `pre.job-out`, `.jl`, `.tgrp`, `.think-body`; 0 transition/animation events on any console surface | 57.9–61.4 fps, p95 17–19 ms, **0 long tasks** | 0 layout shifts, 0 computed-style changes, 0 px rect delta, across 10 s and 40 s windows | no transitions on a console surface at all; the only animations are overlay chrome (`.pulse-dot`, `.to-bottom`, `.copy-block`). |

That triangulation is the strongest result the three have: three different instruments (page counters on the shipped
functions, a per-second MutationObserver over a real SSE stream, a 100 ms rect/scroll sampler on a finished run) agree
that the streaming path does not replace a console row. "The console jitters" is therefore not a row-replacement
fault. What a reader sees while tokens flow is a *text* rewrite inside rows that stay put.

## 2. Where they disagree, and which number wins

These are not contradictions of fact. They are different denominators, different windows and, in two places, different
objects with the same name. The rule used below: trust each report only inside what it actually drove.

**a. The denominator itself.** `jitter-sources` counts writes and calls per trigger (50 writes / 25 frames), streaming
counts rows per second (23.5 rewrites/s), static counts mutation records per second inside the card (0 settled, 10–22
open). The numbers cannot be added or compared directly; only the streaming numbers are per-second *rates*, and only
static's are strictly at rest. **Trust:** streaming for rates, static for at-rest, sources for mechanism.

**b. The block's rebuild rate: 0.42/s vs 3.4–8.3/s vs "one per 2.4 s".** All three are right about different objects.
`detailsReplaced` is the `<details class="think">` node (one per poll, 0.42/s); "blocks replaced/s" is the
`.think-block` children carried away by that replacement (one to twenty-two per poll, so 3.4/s while the set is small
and 8.3/s as it grows). **Trust:** static's 0.42/s for the whole-block cadence (17 builds in a 40 s window,
stack-attributed) and streaming's 3.4–8.3/s for block-row churn. Sources' "1 per ~2.4 s" is the poll, not a rate.

**c. The 30 s rebuild: seen by two, named by one.** Streaming caught it at 30.1 s and 60.6 s mid-stream (29 then 43
rows at once) and proved the cause: `jobline` never stamps `state.lastEventAt` (`public/core/sse.js:129`), so the
liveness clock read 29 s, 44 s and 64 s stale while ~7 lines a second arrived, and the 30 s safety net
(`public/app.js:14843`) called `resync()`. Static saw one card rebuild at 24.92 s in its 40 s window. Sources saw the
console node replaced "once per changed signature" but never a resync, because its passes were shorter than the net's
first tick. **Trust:** streaming's causal account; static's 24.92 s is the same mechanism at a different page-load
phase, not a different rate.

**d. Whether the block's scroll moves.** Static counts 4 `scrollTop` writes and 4 scroll events per 10 s on a running
card, every write `0 → 26,600`. Streaming finds `top0 == top1` on 12 of 28 polls and a `+4..8 px` step on the rest,
i.e. no movement. Both are true: the setter is called on a fresh node that starts at 0 and is put back inside the same
task, so no frame is ever painted in between. **Trust:** static for what the restore does to the box, streaming for
what a frame can show. Neither is a visible jump.

**e. `jitter-sources`' "past the cap nothing can be moved by its output".** True for growth — a console at its 230 px
cap produced 0 `ResizeObserver` entries for 25 more lines. It is not true for replacement: the card rebuild is a
different path, and both other reports measured it moving rows (static: 29 rows at 24.92 s; streaming: 29 and 43 rows
at 30.1 s and 60.6 s). **Trust:** sources for the observer, streaming/static for the rebuild.

**f. The one-shot settle.** Static's first-load measurement (client width 1440 → 1429, `#agents` +19 px, reasoning rows
18 px taller as they re-wrap, 2 layout shifts of 0.52 and 0.55) appears in no other report: sources' passes began after
the settle and streaming recorded no rects. **Trust:** static (ten windows, 0 shifts and 0 px when the window opens
0.3 s and 4.2 s after the draw). It is a page-load event, not a steady state.

Two things I do **not** trust: any *rate* from `jitter-sources` (its `/api/thinking` and `/api/tool-results` were
route-stubbed, so the poll's real cadence never ran), any absolute geometry from streaming (it recorded no rects), and
anything about the token path from static (it drove no stream). That is why the test below drives a real SSE stub, a
real `state.db` and the shipped clocks, and reads rects only where it needs them.

## 3. Ranked by share of the reported jitter

The budget is streaming's flowing window: 46.6 DOM mutations a second on a live card. The percentages below are shares
of that, or of the paused window where noted.

| # | mechanism | measured share | what it explains | what it costs the reader |
| --- | --- | --- | --- | --- |
| 1 | **the pacer + the live append rewrite a growing row in place** (`paintTypedLines` 6327, `drawJobLine` 7505) | 35.9 of 46.6 mutations/s = **77%** while flowing; **0** in the paused control | every second tokens arrive. 23.5 prose + 12.4 reasoning rewrites a second; 2 writes and 2 `setScroll` per streamed frame (sources: 50 writes for 25 frames) | the selection and the caret inside the row: median 50 ms (33–50 ms in my run). No row is lost, so no layout moves. |
| 2 | **`paintThink` replaces the whole block on every poll** | 0.42 `<details>`/s; 3.4–8.3 block rows/s flowing, **5.6/s paused**; 9–19 ms CPU each | **100%** of the churn that survives a stalled model, and of the at-rest churn; ~7% of the flowing churn | the block's selection (1,465 chars → 0 at the first poll), the copy button (remounted every poll), and ~13 ms of main thread 0.43 times a second on a card doing nothing. |
| 3 | **the 30 s board resync rebuilds the live card** (`resync` → `applySnapshot` 12686, because `jobline` does not stamp `lastEventAt`) | 29 then 43 rows at once, twice a minute; 100% of whole-console replacements; ≈1 row/s averaged | the "whole console jumped" class: every row new at once, mid-stream, on a card that is demonstrably alive (clock 29–64 s stale at 7 lines/s) | the place the reader was reading is restored exactly, but every node under it is new — selection, group-open state, copy buttons. |
| 4 | **a tool line replaces its whole `.tgrp`** (`drawJobLine` 7494–7498) | one group node per call and per result (sources: 3 `replaceWith:tgrp` for 3 call/result pairs) | the burst re-cut: a row that leaves one box and appears in the next. Unmeasured on a tool-heavy stream by the other two (both drove prose) | the result bodies inside the group are rebuilt with it. On the real run static used, **111 of 120 lines were tool lines** — the largest unmeasured reach in this ranking. |
| 5 | **the console follows its own growth** (`setScroll` 6802) | 1.3–2.4 follows/s, 4–44 px (median 17–18), **0 upward, 0 with input, 0 px gap** | 100% of the scroll movement and **0% of the fault** — it is the panel doing what a pinned reader asked for | nothing, while pinned; the risk is only an upward move or a frame painted off the bottom, and neither was measured. |
| 6 | **the board settles once after load** | one shot: +19 px down, −11 px wide, 3–8 reasoning rows 18 px taller, 2 layout shifts (0.52, 0.55) | the largest single layout shift in any of the three reports | one re-wrap and one 19 px slide, on load only; 0 shifts and 0 px in every window opened 0.3 s or later. |
| — | **ruled out, 0%** | whole-console `innerHTML`: 0 writes. rAF batching on the console: 0 callbacks per line. `ResizeObserver` on a console: none (it observes `main`/`projects`/`jobs`/`newagent`/`agents`/`approvals`, 0 entries past the cap). CSS transitions/animations: `0s`/`none` on every console surface. | | |

Why this order and not another. #1 is first because it is the only mechanism present in every flowing second, and it
carries three quarters of the mutations. #2 is second because it is the only mechanism that keeps going when the model
stops: pause the wire and the console goes to 0.2 rewrites/s while the block still loses and regains every node 5.6
times a second. #3 is third by frequency but first by blast radius: it is the only thing that replaces rows the stream
itself keeps, and it does so on a card whose console is healthy. #4 is fourth only because nobody has driven a
tool-heavy stream with a per-second counter — its per-event cost is the same as #3's, one whole subtree, and the one
real run any of the three examined was 92% tool lines.

## 4. One repeatable test: `tools/verify-console-jitter.mjs`

It starts its own panel (`tools/panel-testkit.mjs` `startPanel`, spare port, own config/caches/`HERMES_HOME`,
`API_SERVER_KEY` empty), plays a **fixed** reply over real SSE (two words every 75 ms, a paragraph every 55 words, a
7 s hole with no event at all, then more words), grows a real `state.db` reasoning row every 2 s while the wire flows
and not while it is paused, and lets the panel's own clocks run. It measures four things in both card modes:

1. **row churn per second** — console rows *replaced* (a row that came back as a new node, counted by same-`data-lid`
   remove+add in one mutation batch) against rows *rewritten in place* (a mutation inside a row that stayed connected).
2. **surviving rows across a repaint** — every row the repaint is about to draw is stamped, and the tags still in the
   box are counted when it returns. In 🌊 that is `syncStreamConsole` (console rows); in 🧠 it is `paintThink`
   (`.think-block` rows). A once-a-second identity walk reads the same question a second way.
3. **scrollTop movement with no input** — sampled every frame for both scroll boxes: direction, whether growth
   explains it, whether the panel's own `setScroll` asked for it, and the largest distance from the bottom.
4. **thinking-block replacement rate** — `details.think` nodes thrown away per second, block rows replaced per poll,
   and the share of blocks that survive a poll.

```
node tools/verify-console-jitter.mjs                  # both card modes, headed, ~60 s
node tools/verify-console-jitter.mjs --mode stream    # 🌊 one-stream console only
node tools/verify-console-jitter.mjs --mode think     # 🧠 block above a condensed console
node tools/verify-console-jitter.mjs --headless       # no window; works, rAF is unthrottled here (59.9 fps)
node tools/verify-console-jitter.mjs --resync-check   # 34 s of flow, looking for the 30 s rebuild
node tools/verify-console-jitter.mjs --json <path>    # keep the raw capture beside the printed table
node tools/verify-console-jitter.mjs --keep           # leave the sandbox behind
```

Exit codes: **0** every threshold held; **1** a jitter threshold was crossed; **2** the run did not drive what it
measures (too few appends/rewrites/polls, no console rows, a page error) — a pass on a run that measured nothing would
be worse than a failure. Without Playwright it prints `SKIP` and exits 0, like the other measurement tools.

Two consequences worth knowing before you wire it into a habit:

- `node tools/verify.mjs --all` discovers this harness like the others, so it will report it red on any tree where
  `paintThink` still replaces the block. That is the intended reading (the harness states a claim and the claim is
  false there), and `--mode stream` is the console-only gate, which is green today.
- It starts its own panel on a free port and never touches the panel on 7331. It takes ~30 s per card mode.

### What it printed on this tree

```
$ node tools/verify-console-jitter.mjs
-- stream: 14000 ms flow / 7000 ms pause / 3000 ms flow
window    | s  | rows repl/s | rows repl | board rows | prose rw/s | reason rw/s | appends/s | polls | kept/stamped | kept % | scroll chg | up | follow | setScroll | gap max | fps  | p95
flowing   | 13 | 0           | 0         | 0          | 24.3       | 10.8        | 6.8       | 6     | 40/40        | 100    | 13         | 0  | 13     | 348       | 0       | 59.9 | 17
paused    | 5  | 0           | 0         | 0          | 0          | 0           | 0         | 2     | 28/28        | 100    | 0          | 0  | 0      | 2         | 0       | 60   | 17
flowing 2 | 4  | 0           | 0         | 16         | 19.3       | 6.7         | 4.5       | 2     | 30/30        | 100    | 5          | 0  | 5      | 75        | 0       | 60   | 17
   console: 13 rows at its fullest, 465/229px of content in a scroll box
   selection while flowing: 9 armed, 5 lost (median held: 33.3 / 50.1 / 49 ms)

-- think: 14000 ms flow / 7000 ms pause / 3000 ms flow
window    | s  | rows repl/s | board rows | prose rw/s | appends/s | polls | block kept/stamped | block kept % | block polls | details repl | scroll chg | up | setScroll | gap max
flowing   | 13 | 0           | 0          | 25         | 7.1       | 6     | 0/16               | 0            | 6           | 5            | 2          | 0  | 325       | 0
paused    | 5  | 0           | 0          | 0          | 0         | 2     | 0/6                | 0            | 2           | 1            | 0          | 0  | 0         | 0
flowing 2 | 4  | 0           | 9          | 26         | 4.8       | 1     | 0/6                | 0            | 1           | 1            | 5          | 0  | 71        | 0
   block: 16 rows at the last poll, 1.2 replaced/s, 11.5 rewritten/s

PASS  stream: every console poll hands back every row it drew: 100% (40/40)
FAIL  think: the thinking block hands back every row it drew
        got  0% (0/16)
        want 100% (16/16)
FAIL  19/20 checks  (stream 29s, think 31s)
```

(The columns this note argues about; the tool prints the rest. Two runs of the same commit differ by a poll or a
tenth — the thresholds sit well clear of that.)

**The one failure is the finding, not a flake.** `paintThink` replaces the block on every poll, so no block row ever
survives one; that is mechanism #2, measured on a card that is otherwise still. A tree that patches the block reads
`100% (16/16)` and the same command exits 0. The console checks are strict zeros and are green: the streaming path
replaced **0** rows across 6 polls and 13 s (40 rows handed back, 40 kept), and the paused control rewrites nothing.

`--resync-check` is the third mode, for mechanism #3. It drives 34 s of flow so the panel's 30 s safety net fires on a
card that is provably alive:

```
$ node tools/verify-console-jitter.mjs --resync-check
flowing | 33s | rows repl/s 0 | board rows 29 | board snapshots 1 | prose rw/s 24.8 | appends/s 7.1 | polls 14 | kept 232/232
FAIL  resync: a streaming card is not rebuilt by the board (1 rebuilds while 7.1 lines/s arrived)
FAIL  9/10 checks
```

29 console rows replaced in one second, by `applySnapshot`, while 7.1 lines a second were arriving and the liveness
clock read 33 s stale. The per-second floors exclude that second and count it on its own `board rows` line, so the
resync cannot be mistaken for the stream's churn — and the resync check is the one that fails.

## 5. The thresholds, and why each one

All are one-sided: a correct patch reads lower (or, for survivors, higher) and still passes; a regression reads over
the line. The tolerance is argued from the three reports, not from taste.

| check | threshold | why |
| --- | --- | --- |
| the stream replaces no console row | **0/s** outside a board-rebuild second | measured 0 in all three: 27/27 polls and 208 appends (streaming), 0 writes on `pre.job-out` (sources), 0 replacements at rest (static). Every replacement is a node the reader loses; there is no acceptable rate. |
| every console poll hands back every row it drew | **100%**, at least 3 polls | measured 40/40, 30/30, 232/232 in my passes, 27/27 in streaming. A fractional rate means a fractional regression, so no tolerance. |
| the thinking block hands back every row it drew | **100%**, at least 2 polls | 0 of 1..24 (streaming), and at rest every one of the block's 60 rows is inside the `<details>` that static measured being replaced 17 times. Wanted 100% because that is what a patch does; the shipped build fails this line. |
| no scrollTop moves up | **0** | 167 movements, 0 upward, no input (streaming); 0 at rest (static). An upward move on a page nobody touched is the panel pulling the reader, whatever its size. |
| a paused box does not move | **0 changes** | 0 in streaming's paused window; 0 at rest. The paused window starts 1.5 s after the wire stops, because the last line is still being typed — a control that starts inside that tail measures the flow it excludes (one change was measured there before the settle). |
| the console is never painted off its bottom | **≤ 4 px** | 0 px at every frame boundary (streaming). Rows are 17–35 px, so a frame painted with a line of growth reads ≥ 17 and fails; 4 px is under a quarter of a row of slack. |
| the paused console rewrites nothing | **≤ 1/s** | 0.2 rewrites/s of page furniture in streaming's paused window, 0 here. 1/s allows one stray write and fails a pacer that is still typing. |
| the block is rebuilt at most once per poll, and ≤ 0.7/s | **1/poll; 0.7/s** | the shipped poll is one per ~2.4 s = 0.42/s; a 13–14 s window holds 5–6 polls (0.38–0.46/s). 0.7 clears the sampling noise and is still below a doubled cadence (1.2 s → 0.83/s), which is what a second repaint path would produce. |
| the stream really drove the card | **≥ 2 appends/s, ≥ 5 rewrites/s, ≥ 3 console rows, 3 polls (🌊) / 2 (🧠)** | a precondition, not a jitter threshold: at the fixed 2-words/75 ms stream the measured floors are 5.3 appends/s and 24 rewrites/s, so a run below these did not happen. It exits 2, not 0. |

## 6. What this test does not cover

- **Tool lines.** The fixed stream is prose and reasoning only, so the `.tgrp` replacement (mechanism #4) is not
  driven. It is the largest known gap in this test, and the reason #4 ranks fourth on reach rather than on evidence.
- **A real gateway and a real model.** The wire is a stub over real SSE; `lib/jobs.js`'s 120 ms coalescing, the
  pacer, the sweep, the 2 s freshness gate and every renderer are the shipped ones. No claim here is about the
  gateway's own frame cadence.
- **Rects and layout shift.** The tool reads `scrollTop`/`scrollHeight`/`clientHeight`, not `getBoundingClientRect`, so
  it would not catch a 0-px-delta re-wrap; `jitter-static.md` is the instrument for that.
- **The reader's own input.** None is sent, on purpose, and the tool counts input events to prove it. A scroll the
  reader causes is out of scope.
- **Anything past 30 s.** The default windows end before the panel's first safety-net tick so a scheduled rebuild
  cannot pollute a per-second floor. `--resync-check` is the mode that goes looking for it, and it failed on the tree
  this note measured by design, until `jobline` stamped `state.lastEventAt` — see §7.
- It is not wired into `test/*.test.js` and changes nothing the page does: every recorder is a wrapper, a
  MutationObserver, a rAF loop or a property read.

```
node tools/verify-console-jitter.mjs --json C:/CodeReviews/agent-worktree-gui/jitter-synthesis-baseline.json
```

The capture behind the table above was taken with the same command into a scratch path; the printed table is the
read-back, and every number in it is recomputable from the capture's `buckets`, `polls` and `scrolls` arrays.

## 7. #2 and #3 are fixed (0.32.6)

Everything above is the record of one tree (`b64642d`) and stays as it was read. Two of its three mechanisms have
since been patched rather than rebuilt, and the commands that failed here now pass on the same tool:

- **#2, `paintThink`.** A poll patches the `<details>` it already has: the summary's count is rewritten, every
  `.think-block` keeps its node (keyed by `data-lid`), and only the text that moved is written — so the reader's
  selection, the block's `open` and its copy button survive the read, and the "nothing yet" row becomes the first
  thought instead of being swapped for it. `--mode think` reads **`block kept 100% (18/18)`** with `details repl 0`,
  where this file measured `0% (0/16)` and one replacement per poll. What churn is left in the block is the pacer's
  own in-place rewrite (~11 rewritten/s), which is mechanism #1 and untouched.
- **#3, the 30 s rebuild.** `jobline` now stamps `state.lastEventAt` — it was the only frame kind that did not — and
  the safety net's rule lives in `public/core/liveness.js`, so both halves are one testable function: a frame
  arriving is liveness, silence past 20 s **or** a socket that is not open still resyncs. `--resync-check` reads
  **`0 rebuilds while 6.9 lines/s arrived`**, where this file measured 1 rebuild at 7.1 lines/s. `renderJobs` also
  refuses to rewrite `#jobs` when neither the set of cards nor any card's signature has moved, so a snapshot that
  changes nothing a card draws cannot replace the node the run's own stream is writing into either.
- **#1, the pacer**, is deliberately unchanged: 77% of the flowing churn is a growing row rewritten in place, and
  that is the panel doing what a pinned reader asked for, one node the whole time.

`node --test test/liveness.test.js` pins the two halves of #3 (a frame is liveness; silence and a closed socket are
the resync), and `node tools/verify-console-jitter.mjs` measures the rest — `--mode stream` stays green, so the
console's own path did not regress while the block was patched.
