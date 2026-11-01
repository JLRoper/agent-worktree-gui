# A read-only 60 s window on b499c61: no arrival at 0, and the reader's park is thrown to the tail

Measured **2026-11-01**, manual pass, read-only. Nothing in `public/` or `lib/` was touched; the branch carries this
document and a patch bump only.

- **Commit measured:** `b499c61` (`console: follow the newest line, or the reader — never a 40 px band between them`),
  `package.json` **0.46.1** — the commit the brief named. Main has since moved to `dac78f1` (0.46.3, `public/app.js`
  differs by one line in `a0b0026`); every `file:line` below is **b499c61's** line, not main's.
- **Served page:** `public/app.js` 948,116 B on disk, sha256
  `90c7badf67a32ee8b3e0b347b521b04b3b8e2b3749717ccad211b32cc384b5b8`; the panel's `/app.js` hashed to the same value
  before the window opened, and the recorded stacks carry build `app.js?v=a43f39bb2609`.
- **Panel:** `127.0.0.1:7391`, the run's own `PANEL_CONFIG` (`dataSource: PANEL_CONFIG`, `dataLayout: flat`,
  `dataDir` under `%TEMP%/wtgui-writes-*`), its own `HERMES_HOME` / `jobs.json` / projects cache, `/api/health` 200.
  Never the reader's board (7331 / 7473 are refused by the tool's own port guard).
- **Detector:** `node tools/measure-console-writes.mjs --port 7391 --only busy --stream --seconds 60 --json <scratch>`
  — three windows (two detector-only, one with the reader's page attached), all exit 0, `notMeasured` empty, 0 page
  errors, 0 dropped writes.

## What was on the board

`--only busy --stream` builds four rows (two projects × two worktrees), spawns four cards through the panel's own
`POST /api/agents`, feeds them a stub gateway's plain text over real SSE (one word per 75 ms), and paints every card
in 🌊 mode. Nothing synthetic reached the page as far as the panel is concerned: the stream, the rows and the repaint
are the panel's own.

The manual part: the panel was opened in a **second browser page of its own** (the reader's client) while the detector
drove its page. The reader opened the rows, waited for scrollback, and parked the deepest console with one real wheel
(`page.mouse.wheel(0, -112)`), after `scrollIntoView({block:"center"})` — a genuine gesture, not a dispatched event and
not a hand-written `scrollTop`.

## Arrivals at 0, per caller

Counters are defined here because three of them are not the tool's vocabulary. Per write:
`from, asked, landed, max, short = max - asked, landedShort = max - landed`.

- **writes** — every `scrollTop` write on a `pre.job-out`, attributed to the frame above `setScroll` (`app.js:7424`).
- **upward** — `from - asked > 2`: the caller asked for a position at least 3 px above the box.
- **landed-at-0** — `landed === 0`.
- **arrival at 0 / zero-reach (the brief's reading)** — `from > 2 && landed === 0`: a write carried the box from
  above to exactly 0. The tool prints this line itself as `zero-reaches: N arrival(s) at 0, M of them with no write`,
  and it also counts the silent ones; both are quoted below.
- **asked-above-bottom** — `short > 2`; **on tail** — `landedShort === 0`.
- **zero-movement write** — `landed === from` (the write moved nothing). This is the other reading of "zero-reach" and
  it is 95% of the window: it is the repaint cadence, not a bounce.

Window 1, detector alone (`--json` ledger reduced per caller):

| caller (site the instrument reported) | writes | upward | landed-at-0 | asked-above-bottom | arrival at 0 | zero-movement | on tail |
|---|---:|---:|---:|---:|---:|---:|---:|
| `<anon>` `app.js:6765` (rAF flush of the pinned boxes) | 3363 | 0 | 0 | 0 | **0** | 3204 (95.3%) | 3363 |
| `releaseScrolls` `app.js:7603` | 40 | 0 | 10 | 10 | **0** | 40 | 30 |
| `stickConsole` `app.js:7467` | 2 | 0 | 0 | 0 | **0** | 0 | 2 |
| **total** | **3405** | **0** | **10** | **10** | **0** | 3244 (95.3%) | 3395 |

`zero-reaches: 10 arrival(s) at 0 in the window, 0 of them with no write at all` — and every one of those 10 is
`from 0 → asked 0 → landed 0` from `releaseScrolls`: a no-op on a box that was **already** at 0. The other two windows
read the same shape (`10` and `12` land-at-0 writes, all `releaseScrolls`, all `from 0`; 0 upward; 0 silent moves;
0 writes into a box with no layout).

So on b499c61, in a read-only window: **no write and no silent move carried any console from above to 0.** The
arrivals the tool counts are restores of a position that was already 0.

## The instrument's own two blind spots in this window

- **`ops` is empty while rows are plainly rebuilding.** The tool logged **0 console-carrying DOM operations** in all
  three windows, which by the usual reading means "nothing rebuilt, nothing to reset". That reading is wrong here: the
  5 s row pass called `releaseScrolls <- fillAgentSlots <- placeRow <- flush` **12 times per console** (48 writes /
  4 boxes in window 3). The row rebuild builds its new `<tbody>` with `h2.innerHTML = detailHtml(row)`
  (`app.js:13260`) and moves the existing cards across, so the console **node** is never replaced — its `data-reader*`
  marker survives the whole window — and the only wrapped primitive that fires is a content replacement on a node that
  is not itself a console, which `carries()` does not count. A window with `ops: 0` is not evidence that nothing
  rebuilt.
- **The tool's own park is a top-park, not a mid-scrollback park.** Every window armed as soon as each console
  overflowed by 40 px and then parked `pre.job-out[0]` with `page.mouse.wheel(0, -420)`; the wheel did not take, and
  the fallback (`via: "dispatched"`, plus a direct `scrollTop` write) left the box at
  `{"dist":60,"max":60}` / `{"dist":95,"max":95}` — the **top of a short console**. That box then stayed at 0 for the
  whole window, which is where the 10–12 `releaseScrolls` no-ops come from. The reader's park had to be made in the
  reader's own page to be a real one.

## What my own scrolling did

Reader's page, window 3. The parked console was `8ecc7fcc`, the deepest on the board (336 px of scrollback, pinned at
its tail). One real wheel of 112 px:

| at | scrollTop | dist | `state.outPinned` | `state.outScrolls` record | `_selfTop` | `justPlaced` | `selfScrolled` |
|---|---:|---:|---|---|---:|---|---|
| before | 336 | 0 | pinned | `{top:336, atBottom:true}` | 654 | false | **true** |
| +80 ms | 224 | 112 | **unpinned** | `{top:336, atBottom:true}` | 654 | false | false |
| +400 ms | 224 | 112 | unpinned | `{top:336, atBottom:true}` | 654 | false | false |
| +1600 ms | 224 | 130 | unpinned | `{top:336, atBottom:true}` | 654 | false | false |

The wheel unpinned the console (`app.js:15672` sets `state.outPinned[id] = false` on a wheel up) and left the reader
112 px up. But `state.outScrolls[id]` — the record every rebuild restores from — was **never updated**: the box's own
`scroll` event was consumed by the handler's "the panel did this" guard (`selfScrolled.has(pre) || justPlaced(pre)`,
`app.js:15643`), because a no-op `setScroll` had left the element in `selfScrolled` and a write to the value it already
holds fires no scroll event to clear it. The record kept saying "the reader was at the bottom".

At **t = 1,760 ms** the row pass rebuilt that card, and all three writes landed in the same task:

```
t=1760 from 0   asked 224 landed 224 max 388  releaseScrolls   <- fillAgentSlots <- placeRow <- flush   (my line, restored)
t=1760 from 224 asked 224 landed 224 max 388  restoreScrolls   <- placeRow <- flush                    (agrees)
t=1760 from 224 asked 706 landed 388 max 388  applyStoredScrolls <- placeRow <- flush                  (the stale record wins)
```

`restoreScrolls` (`app.js:7489`) uses the capture taken before the swap and put my line back; `applyStoredScrolls`
(`app.js:7500`), two lines later in the same rebuild, read `atBottom: true` and wrote the tail. From then to the end of
the window the rAF flush at `app.js:6765` held the console there — **894 of my box's 897 writes** (3,376 across the
four consoles) and `state.outScrolls` still read `{top:336, atBottom:true}` at 61 s.

So the honest answer to "what did your own scrolling do" is not a bounce to the top: **there were 0 frames painted at
0** (3,470 sampled frames, all unpinned, min top 224) and 0 arrivals at 0 from above. What my scroll did was get
discarded: the reader's line survived 1.76 s, one rebuild restored it correctly and the next line of the same rebuild
put it back on the tail, where a per-frame no-op write kept it.

## What this window does and does not prove

- It **does** prove that on b499c61 a read-only 60 s window has no upward move, no silent reset, and no arrival at 0
  from above, on four streaming consoles in four rows — the 0.46.1 rule ("follow the newest line, or the reader")
  holds for the write path.
- It **does not** prove the park is respected. The park is lost to a stale `atBottom` record 1.8 s after the wheel,
  silently: no write to 0, no painted frame off the bottom, nothing a frame sampler or the `arrivals at 0` counter can
  see. The visible symptom is the opposite of a bounce — the reader is carried to the newest line.
- The stale record has one cause and it is reachable in ordinary use: a panel write whose value is already held
  leaves `selfScrolled` set, and the reader's next real scroll is then mistaken for the panel's own and never
  recorded. `setScroll` (`app.js:7419`) adds to `selfScrolled` unconditionally.
- Two windows are not a trend. The 5 s row pass is the only rebuild path these windows reached; the project-wide
  rebuild (`renderProjectRows` / `renderAll`) with a park in place is a different trigger and is not measured here.

## Repro

```
node tools/measure-console-writes.mjs --port 7391 --only busy --stream --seconds 60 --json <scratch>/writes.json
node <skill>/scripts/writes-counters.mjs <scratch>/writes.json busy      # per-caller arrival/zero-movement table
```

The reader's page is a second Playwright client on the same `127.0.0.1:7391`: expand the rows, wait for a console
with ≥320 px of scrollback, `scrollIntoView({block:"center"})`, one `page.mouse.wheel(0, -clamp(max/3,40,140))`, then
require `state.outPinned[id] === false` before the window opens. Read `state.outScrolls[id]` at +80 ms: if it still
says `atBottom: true`, the park is not recorded and the next rebuild will throw it to the tail.
