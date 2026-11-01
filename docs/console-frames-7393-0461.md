# A reader's frame test on 7393: 0.46.1 paints no unparked console at 0 in the row being read

Asked on `main` at **b499c61** (0.46.1): run the board as the reader, park a console mid-scrollback, create a second
agent so a rebuild lands while it is being read, sample **every frame**, and report any frame that paints an
**unparked** (still following its run) console at `scrollTop = 0`, with the rebuild that caused it.

**The row being read stayed clean.** Across 8,952 frames over 150 s (59.7 fps), with a console parked 521 px above its
newest line and a second agent created under it, no frame painted an unparked console at 0. Collapse -> expand was
run five times: all 20 rebuilt console nodes had their bottom on their **first** sampled frame, so #165's
`placeBuiltConsoles` does cover the expand case on 0.46.1. The same probe on the pre-#165 build (0.44.1, `93a7357`)
painted the console with no remembered position at 0 for **2 frames** (33 ms) on every expand - that is the control.

Two consoles elsewhere on the same board *did* paint at 0, and they are reported below with their frames.

## What was stood up

- `git archive b499c61` into a scratch export; `server.js` started from it on **7393**, `PANEL_CONFIG` with its own
  `dataDir` / `scratchDir` / `hostsFile`, the reader's `scanRoots` (`C:/ProjectDevelopment`) so the board is the
  reader's own, and a **copy** of the reader's job store (80 cards, 7 running) so the cards are real and live.
- Served bytes proved against the export: `/app.js` sha256 `90c7badf67a32ee8b3e0b347b521b04b3b8e2b3749717ccad211b32cc384b5b8`
  (= the file on disk), `/api/build` `a43f39bb2609`, `/api/state` version `0.46.1`.
- The row read was this worktree's own (`.worktrees/reproduce-console-scroll-jump-on-port-73-24ca82`), opened with the
  project head and the row's ⧉ chip; one console parked with a **real wheel** (top 38 of 559, `consolePinned` false,
  gap 521); a **second agent** created through the panel's own `POST /api/agents` (`existing: true`, cwd = that row,
  prompt "90 numbered lines"), which built a card in the same detail while the parked console was being read.

## The instrument

`tools/measure-console-expand-frames.mjs` (added here) is the cleaned-up form of the probe that produced every number
below; its own run is `frames-7393-final.json` (90 s, parked console, second agent, one expand cycle). `addInitScript`,
before `app.js` parses: a `requestAnimationFrame` loop that re-queries every `pre.job-out` and records
`{scrollTop, scrollHeight, clientHeight, pin, node uid, thread}` per frame, where **pin is the page's own answer**
(`consolePinned(id)`, i.e. `state.outPinned[id] !== false`), never an inference from distance; DOM-primitive wrappers
(`appendChild`/`insertBefore`/`after`/`before`/`append`/`replaceWith`/`replaceChildren`/`remove`, `innerHTML`,
`outerHTML`) filtered to subtrees carrying a console, with caller stacks; and the page's `EventSource`, tagged by event
name. A **hop** is one frame where `pin === 1`, `scrollHeight - clientHeight > 20` and `scrollTop <= 2`. A console the
reader parked (`pin === 0`) is never counted, wherever they put it.

The sampler is proved per run, after the window: a planted `scrollTop = 0` reads `[0,0,0,0,0]` on the following
frames (2 of 3 attempts; the third is repaired inside the frame by the 400 ms sweep) and a raw re-append of the
console's own section reads `[0,0,0]`. A zero from this tool is a zero it has been shown to see.

## The reading window (150 s, 8,952 frames, 13 console boxes)

| console | max scrollback | frames at 0 | at 0 **while unparked** | off-tail while pinned |
| --- | --- | --- | --- | --- |
| `ecc7b7eb` (**parked**, pin 0) | 559 px | 0 | 0 | - |
| `f55b2a2d` | 391 px | 0 | 0 | 2 |
| `03626084` | 556 px | 0 | 0 | 216 |
| `667e79d9` (second agent) | 1268 px | 0 | 0 | 20 |
| 6 cards in the Agents panel | 436-960 px | 0 | 0 | 0 |

- **The park held for the whole 150 s**, through 852 `row` SSE frames, 126 `project` frames and 25
  `fillAgentSlots | replaceWith` slot swaps (`app.js:11540`), 80 `placeInOrder` section moves and 18
  `rebuildToolGroup` group rebuilds: 0 frames at 0, 0 frames off its stored line.
- **The second agent's card was built while the console was parked** (`job 667e79d9`, thread
  `wtgui-reply-with-exactly-90-number-14f2a5`): its console node's first paint was `top 0 / max 0` while it was empty,
  then `top 1268 / max 1268` from the first frame it had anything to scroll - 0 frames at 0 with scrollback.
- **Collapse -> expand** (the same window): collapse at t+60.0 s (4 boxes -> 0), expand at t+63.8 s (0 -> 4 boxes,
  2 of them with **no** stored position). Every rebuilt console's first sampled frame: `303/303`, `38/559` (the park),
  `537/537`, `1268/1268`. 0 frames at 0.

## The expand case, five cycles (100 s, 5,972 frames)

Five collapse -> expand cycles, no park (every console pinned). On every expand, two of the four consoles had **no**
entry in `state.outScrolls` - the case #165's `placeBuiltConsoles` exists for:

```
expand #1 t+15388ms  rebuilt 4: 667e79d9 +16.6ms top 1268/1268   f55b2a2d +16.6ms top 303/303
                                  ecc7b7eb +16.6ms top 559/559    03626084 +16.6ms top 537/537
expand #2 t+32258ms  rebuilt 4: 1268/1268 · 303/303 · 559/559 · 537/537
expand #3 t+49079ms  rebuilt 4: 1268/1268 · 303/303 · 559/559 · 537/537
expand #4 t+65966ms  rebuilt 4: 1268/1268 · 303/303 · 559/559 · 537/537
expand #5 t+82913ms  rebuilt 4: 1268/1268 · 303/303 · 559/559 · 537/537
```

**20 rebuilt console nodes, every one already on its newest line on its first sampled frame, 0 frames at 0** - so yes,
`placeBuiltConsoles` covers the expand case on 0.46.1, including the consoles with no remembered position (which is
exactly the class it was written for).

The control is the same probe, same row, same store, on `93a7357` (0.44.1, pre-#165) served on 7396 (build
`f33f5bfd7704`, `/app.js` `0b4d9075b8382241755dd76263bd90934812de7807371b8eb189bd559635a54f`), 3 cycles:

```
expand #1 t+15434ms  f55b2a2d rebuilt 8->11: first frame +46.7ms top 0 / max 354  <- 2 frames at 0 (33.4 ms)
                     ecc7b7eb 559/559        03626084 537/537
expand #2 t+32307ms  f55b2a2d first frame +23.1ms top 0 / max 354  <- 2 frames at 0
expand #3 t+49156ms  f55b2a2d first frame +23.4ms top 0 / max 354  <- 2 frames at 0
```

`f55b2a2d` is the console with no stored position; the two with a remembered line came back correctly even on 0.44.1.
That is the defect #165 closed, seen by the same sampler.

## The frames that did paint an unparked console at 0

Two, both found by putting every console of the project's rows on the page rather than only the row being read. They
are different classes and neither is the expand path.

1. **`60f6a219`** (thread `wtgui-bounce-trend-slot-c-own-pane-33a0cc`, row `bounce-trend-slot-c-own-4f165c`): a
   6-line console, 77 px of scrollback, pinned. **12 hops in 35 s, 112-131 frames at 0 in total** (3-22 frames each,
   50-370 ms), then `stickConsole` puts it back. Every drop is `77 -> 0` with, in the 60-400 ms before it: **no
   `scrollTop` write** (the setter is wrapped on the prototype), **no scroll API call** (`scrollIntoView`,
   `el.scrollTo/scrollBy`, `window.scrollTo/scrollBy`, `focus` all wrapped), **no DOM primitive that carries the
   console**, and **no mutation of the console's own subtree** (`MutationObserver`, childList+subtree+attributes:
   0 mutations in the window). `_selfTop` was still 77, `isConnected` true, `scrollHeight`/`clientHeight` unchanged
   (395/318) on the frames either side, and a `scroll` event fires with `top 0`. The nearest activity is a burst of
   row rebuilds 40-120 ms earlier (`fillAgentSlots | replaceWith` from `placeRow`, `renderConversation | replaceWith
   div.job` from a `job` frame, `rebuildToolGroup`), but none of them writes this box, so naming one of them as *the*
   cause would be a guess. A `display:none` round-trip was measured and does **not** reset a console here (960 -> 0
   while hidden -> 960 back), so the hide/show explanation is out. Mechanically this is the no-writer class the repo
   already documents (a layout/clamp inside the scroll container, not a restore); it needs a move/anchor instrument,
   not another write log, and it is *not* what #165 addressed.
2. **`8db8429a`** (a second agent created during the 90 s window): **1 frame**, `max 26 px` (about two lines), on a
   console that had been built empty (`max 0`) and whose content had just crossed the detector's 20 px floor while the
   box was still at its first line. `prevTop 0`, the next frame at its bottom. This is the detector's threshold edge
   on a brand-new console, not a reset of a reader's place - quoted for completeness, not as a jump.

Both live outside the row the brief asked to read, and both are on rows the board was rebuilding (`row` frames at
~6/s). The parked row's consoles never showed either.

## What still leaves the tail without reaching 0

Two pinned consoles in the read row fell **87 px** off their newest line 15-18 times per 100 s (1-20 frames each, then
back), and one **46 frames** off the tail in one 90 s window. Every one is a partial version of the same
no-writer/clamp shape, never 0; `state.outScrolls` for them holds a stale `{top: 421, atBottom: false}` /
`{top: 469, ...}`, i.e. the position they were at when the fall was measured, so the restore then re-applies it and the
400 ms `stickConsole` sweep pulls them down again. That is the "console drifts off its tail" family, distinct from
this brief's question; it is measured here so the next reader does not have to re-derive it.

## Bases, ports, artifacts

| commit | version | build id (`/api/build`) | served `/app.js` sha256 | port |
| --- | --- | --- | --- | --- |
| `b499c61` (main when briefed) | 0.46.1 | `a43f39bb2609` | `90c7badf67a32ee8b3e0b347b521b04b3b8e2b3749717ccad211b32cc384b5b8` | 7393 |
| `5d29a95` | 0.46.0 | `e57a03da53e7` | `b04cc7a5bf541169ca96fa0733409abe092034f9e20368e2fd94ab30889e826e` | 7397 |
| `93a7357` (control) | 0.44.1 | `f33f5bfd7704` | `0b4d9075b8382241755dd76263bd90934812de7807371b8eb189bd559635a54f` | 7396 |

`origin/main` has since moved to `dac78f1` (0.46.3); the only `public/app.js` change in between is `a0b0026`'s note
string inside `toolGroupHtml` (one expression, no scroll path). Every number here was read on `b499c61`, as asked.

Raw dumps: `C:/Users/roper/AppData/Local/Temp/wag/f55b2a2d/` - `frames-7393-a.json` (park + second agent),
`frames-7393-b.json` (5 expand cycles), `frames-93a7357-control.json` (0.44.1 control), `frames-7393-final.json`
(the committed tool's own run), `writes-7393*.json` / `watch-7393.json` (the `60f6a219` probes).

## Reproduce

```
git archive b499c61 | tar -x -C <export>
PANEL_CONFIG=<own config with dataDir/scratchDir and port 7393> node <export>/server.js   # from <export>
node tools/measure-console-expand-frames.mjs --base http://127.0.0.1:7393 \
     --row <the row to read> --seconds 90 --spawn-at 20 --toggle-at 52 --cycles 1 --json frames.json
node tools/measure-console-expand-frames.mjs --base http://127.0.0.1:7393 \
     --row <the row> --seconds 100 --toggle-at 12 --cycles 5 --toggle-every 16000 --no-park --json expand.json
```

Exit 0 = measured and no frame painted an unparked console at 0; 1 = one did (printed with its preceding DOM op and
SSE frame); 2 = nothing measured (no console overflowed, or the self-test never saw a planted jump).
