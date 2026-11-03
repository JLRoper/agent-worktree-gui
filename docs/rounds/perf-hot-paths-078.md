# The four paths the reader waits on at 0.78.1 — where a 201-row board spends its time

- **Version:** v0.78.1 (`package.json`), this worktree `wtgui/profile-the-four-paths-t-0a27af` cut from `origin/main` `fd36130`. **Nothing was fixed and no product code moved** — this is the measurement, the probe that makes it repeatable, and the record of what the four paths cost. The branch is rebased onto main's `0.78.2` (a docs-only landing: `git diff --stat fd36130 origin/main -- public lib server.js tools` is empty), so the numbers and every `file:line` below describe the same product code.
- **Run:** the panel's own `server.js` from this checkout on a free port (55432 in the run quoted below; 58973/59466/55432 across the four repetitions), its own `PANEL_CONFIG` / `dataDir` / `scratchDir` / job store under `C:/Users/roper/AppData/Local/Temp/wag/9e207b2a`, one project (`perf-repo`) holding 200 real linked worktrees plus its own checkout = **201 rows**, a stub Runs API playing a scripted turn over real SSE, Chromium (Playwright) at 1440×1000. Nothing shared with the reader's 7331 board: no other store, no other log, no other port.
- **Harness:** `tools/measure-perf-paths.mjs` (this branch). **Raw numbers:** `C:/Users/roper/AppData/Local/Temp/wag/9e207b2a/perf-200b.json` and `perf-200.json` (the two runs quoted), `perf-200.log` beside them.
- **Clock:** four repetitions at 12:04, 12:09, 12:27 and 12:31 (local, 2026-11-03). The host was also running other agents' `npm test` suites, so every figure below is quoted as the **range over those four runs**, with the 12:09 run (least contention) as the low end.

## The answer in one paragraph

At 201 rows a refresh tick costs **126–205 ms**, split almost exactly in half: the `/api/state` call is **59–110 ms** of server time (187–192 KB of gzipped JSON, ~0.5 ms to download on loopback) and the render pass is **66–94 ms**, with JSON parse at **0.6 ms** — so **neither dominates; both are linear in the row count**. A streamed console line is cheap and constant: **0.4–0.6 ms per row** (p90 **0.8–1.1 ms**), **no whole-console repaint per row** (3–4 of 290 draws replaced the console, and those were snapshot repaints), and a markdown marker arriving mid-line costs the same as plain text (**0.4–0.6 ms** vs **0.3–0.6 ms**) because it re-parses one row, not the console. The expensive event in a long turn is **not the stream**: a single **437 KB** `snapshot` frame — the description harvest broadcasting when it first names a tree (`lib/features/descriptions.js:75`) — lands **108–415 ms** in `applySnapshot` plus **343–538 ms** in `renderProjectRows`, inside one **316–490 ms** long task. A drag-reorder across 50 queued cards is the most expensive gesture per interaction: **85–93 `getBoundingClientRect` calls per pointer move** (25.2 k over the gesture), median frame **16.6 ms**, longest long task **85–227 ms**, while the SSE stream itself is cheap in steady state (**8.0–9.2 events/s, 2.3–2.8 KB/s**). Idle work is real but small and **grows with rows**: one DOM node per row per second (2 010 nodes churned per 10 s at 201 rows) from the 1 s age clock, about **4–5 ms of script per second**.

## Method

| What | How |
| --- | --- |
| Instance | `server.js` of this checkout, free port, own config/store/scratch, one project of 200 linked worktrees; `worktreeSeconds`/`liveSeconds`/`midSeconds`/`slowSeconds`/`registrySeconds` set to 3600 and `fetchSeconds: -1` **after boot**, so no git runs during a window and a tick measures the request and the render only. 201 rows present in the first second. |
| The turn | A stub Runs API (real `POST /v1/runs` + SSE `/events`) playing 8 paragraphs, 4 fenced blocks (36 fence rows), 12 tool calls, 290 console lines over ~35 s; the panel's own `lib/jobs.js` translates it, so everything between the stub and the browser is the shipped code. |
| The browser | Chromium via `tools/browser.mjs`, 1440×1000, a fresh context per run. Wrappers on the page's own globals (`drawJobLine`, `drawRowText`, `appendProseLine`, `renderProjectRows`, `applySnapshot`, `queueRow`, `placeRow`, `reorder`, …), a `MutationObserver` on `#projects`/`#jobs`/`#as-queue` counting added and removed subtrees, a `PerformanceObserver('longtask')` and a rAF heartbeat for the longest blocked frame, and a wrapped `setInterval` that names each timer by its own function name. |
| The drag | 50 queued cards seeded through the assistant's own `queue.json`; a real Chromium pointer drag from card #50 to the top, letting the pane's own edge crawl (14 px/frame) bring #1 into reach; `getBoundingClientRect` and `insertBefore` patched to counters for the length of the gesture. |
| The SSE window | One raw `fetch('/api/stream')` reader on the side for 10 s while a second turn is writing, counting frames and bytes by event type; the page's own reader counted at the same time. |

## The four paths, side by side

| Path | Wall | Longest single task | DOM nodes added |
| --- | --- | --- | --- |
| (1) refresh tick, 201 rows | 126–205 ms per tick (5 ticks); `renderAll` 142–209 ms | 134–139 ms frame gap | 10.7 k–13.4 k per tick (the whole tbody is replaced) |
| (2) long turn, 290 console lines | 35.4–35.7 s | 316–490 ms — one full-board snapshot repaint, not a line | 43.3 k–43.7 k over the turn (≈ 591 of them are the console) |
| (3) drag-reorder across 50 rows | 14.1–15.4 s of gesture (harness-paced; the app crawls 14 px/frame) | 85–227 ms | 33 k–47.5 k (the moved card plus the pane rebuild) |
| (4) SSE, live job, 10 s | 10.0 s window | 85–163 ms | 11.3 k in the window |

## (1) A refresh tick with 201 rows: the call and the render are the same size

Five `resync()` ticks, each timed as `fetch` → `JSON.parse` → `applySnapshot`, with the browser's own Resource Timing splitting the call into server wait and download:

| Phase | 12:09 run | Range over 4 runs |
| --- | --- | --- |
| `/api/state` total | 62 ms | 62–113 ms |
| … of which server wait | 59 ms | 59–110 ms |
| … of which download (loopback, gzip) | 0.5 ms | 0.4–0.5 ms |
| `JSON.parse` of 187–192 KB | 0.5 ms | 0.5–0.6 ms |
| `applySnapshot` → render | 65.6 ms | 66–94 ms |
| **tick total** | **126 ms** | **126–205 ms** |
| `renderAll()` (project set changed) | 142 ms | 142–209 ms |

- **The server half is `snapshot()` serializing every row** (`lib/store.js:207-218`) into 187–192 KB of JSON, gzipped on the way out (`lib/http/transport.js:33-46`). It is O(rows) and it is on the main thread of the panel process.
- **The render half is a wholesale row rebuild**, not a patch: `applySnapshot` keeps the same project set and calls `renderProjectRows` per project (`public/app.js:15209-15217`), which builds one HTML string per row, parses it through a detached `<tbody>`, and swaps the whole tbody in one `replaceChildren` (`public/app.js:14854`, row loop `14907-14922`, swap `14926`), then re-measures every column (`fitColumns`, `14969`) and rebuilds the chip strip (`refreshChips`, `13934`).
- **The board holds 7 509 DOM nodes (27 per row for the project-root row) and a tick adds 10.7 k–13.4 k** — more than it holds, because the tbody and the chips are replaced rather than patched.
- The 0.6 ms parse is the one genuinely cheap part: 190 KB of JSON parses faster than one row is built.

## (2) A long turn: half a millisecond a line, and one snapshot that costs half a second

The scripted turn wrote 290 console lines in 35.6 s (22 console rows, 591 nodes, 36 fenced rows, 32 tool rows at the end).

| Measure | 12:31 run | Range |
| --- | --- | --- |
| `drawJobLine` per row (median / p90 / max) | 0.6 / 1.1 / 67.6 ms | 0.4–0.6 / 0.8–1.1 / 2.2–67.6 ms |
| growing paragraph, no marker (mode `set`) | 0.6 ms (27 frames, 57 chars) | 0.3–0.6 ms |
| same row, a markdown marker in the arriving delta | 0.6 ms (14 frames) | 0.4–0.6 ms |
| draws that replaced the console (of 290) | 4 | 3–4 |
| longest frame gap in the window | 321.6 ms | 321.6–490.6 ms |
| DOM added over the turn | 43 488 | 43.3 k–43.7 k |
| `applySnapshot` calls in the window | 1 — **189 ms** | 108–415 ms |

- **Per row the console is append-only.** `drawJobLine` appends to the block the line belongs to (`appendProseLine`, `public/app.js:7656`); a growing paragraph appends to the row's own text node (`drawRowText`, `7591`); a marker in the arriving part re-parses **that row** (`7598`) — the reason marker and plain frames measure the same. Fenced rows are appended into the fence body one row at a time (`appendFenceRow`, `7630`). Of 290 draws only 3–4 replaced the console's first child, and those coincide with the snapshot repaints below.
- **What actually cost the half second was a `snapshot` frame, not a line.** The caller stack of the one `applySnapshot` in the window is `core/sse.js:65` — the SSE `snapshot` handler. The panel broadcasts a whole snapshot when the description harvest first names a tree (`lib/features/descriptions.js:69-75`), and that harvest is the only routine `snapshot` broadcast on the job-event path (server.js's `onEvent` fan-out: broadcast, adopt, naming, harvest, release sweep, assistant). On a board whose tree had no description yet, the first turn therefore ends in a whole-board snapshot — `applySnapshot` **108–415 ms** + `renderProjectRows` **343–538 ms** (2 calls) in one **316–490 ms** long task. This is a per-new-tree event, not a per-line one, and its cost is entirely row-count-shaped.
- **Tool rows are the one place a line does more than append.** A tool call joins the burst at the tail by rebuilding that burst's markup (`toolGroupHtml` → `openGroup.replaceWith(fresh)`, `public/app.js:9535-9539`), so a tool row inside a burst of n rows costs O(n) — it is why 32 tool rows carry more script than 36 fence rows.

## (3) A drag across 50 rows: ~86 box reads per pointer move

50 queued cards occupy 5 489 px of list in an 810 px pane, so the drag is a real one: press #50, travel to the pane's top edge, let the crawl scroll the list to the top, drop above #1. The order landed (`50,1,2,…`) and the server holds it.

| Measure | 12:31 run | Range |
| --- | --- | --- |
| gesture wall (harness-paced) | 14.1 s | 14.1–15.4 s |
| crawl (app's own 14 px/frame) | 13.9 s | 13.7–15.0 s |
| pointer moves | 298 | 266–298 |
| `getBoundingClientRect` calls | 25 258 (**84.8 per move**) | 24.7 k–25.7 k, 84.8–92.7 per move |
| `insertBefore` calls (real re-placements) | 44 | 44 |
| frames | 875, median **16.6 ms**, max 60.3 ms | median 16.5–16.8, max 42.7–81.8 ms |
| longest long task | 163 ms | 85–227 ms |
| DOM added / removed | 47 480 / 46 516 | 33.0 k–47.5 k |

- **Per pointer move the pane is re-measured.** `queueDragPaint` (`public/assistant.js:2547-2566`) re-queries every card in the pane (`queueCardsIn`, `2132`), then `.find()`s the first queued card whose midpoint the pointer has passed — one `getBoundingClientRect` per card until it does (`2551-2553`) — inserts the dragged card, and reads its box again for the transform (`2563`). That is a forced reflow per move, and the number of boxes read grows with how far the pointer still has to travel (≈25 in the middle of the list, 50 at either end).
- **The crawl is a rAF loop that repeats the same work while the pointer is still** (`queueDragFrame`, `2567-2585`): a scroller box read per frame, and a full `queueDragPaint` on every frame that scrolled.
- The DOM does not grow here; it churns. 47 480 added against 46 516 removed over the gesture is the card being moved (remove + insert) and the pane repainting on the drop; the list itself is ~50 cards.

## (4) The SSE stream with a live job: cheap steady state, expensive connect

A raw reader on `/api/stream` for 10.06 s while a second turn was writing (94 frames):

| Measure | 12:31 run | Range |
| --- | --- | --- |
| frames | 94 (90 `jobline`, 2 `heartbeat`, 1 `snapshot`, 1 `row`) | 81–94 |
| events/s (excluding the connect snapshot) | 9.2 | 8.0–9.2 |
| bytes/s (excluding the connect snapshot) | 2 835 | 2 310–2 835 |
| biggest frame | **437 028 B** — the `snapshot` on connect | 436 943–437 028 B |
| page's own lines drawn in the window | 91 | 78–91 |
| longest frame gap on the page | 175.6 ms | 91.4–175.6 ms |

- **Steady state is one small frame per console line.** `emitLine` (`lib/jobs.js:1229`) writes one `jobline` frame; growing paragraphs are coalesced on a 120 ms clock (`TEXT_FLUSH_MS`, `lib/jobs.js:80`), so a fast model's 30–60 tokens/s arrive as ~8 frames/s. 28 644 non-snapshot bytes over 93 frames is ~308 B a frame.
- **There is no batching on the wire**: `broadcast()` (`server.js:410-419`) writes one frame per event to every connected client.
- **Connect is the expensive frame**: `handleStream` sends a full `snapshot()` before anything else (`lib/http/transport.js:104-110`), which at 201 rows is 437 KB — about **2.2 KB per row**. The page parses and applies it through the same `applySnapshot` → `renderProjectRows` path as a tick (67–131 ms of render measured in the window on a quiet board, far more when the board is busy).
- The 30 s safety net did **not** fire in this window (`lastEventAt` is stamped by every `jobline`, `public/core/sse.js:133`), and in a separate 70 s quiet-page probe the stream did not reconnect at all: one connect, one disconnect at teardown.

## What repeats on a timer when nothing it depends on changed

A 10 s window with the board idle (store's own `stats.rowEvents` = **0** across the window, so no row was re-scanned and nothing on the data path moved):

| Timer | Fires in 10 s | Script |
| --- | --- | --- |
| 1 s age / watch clock (`public/app.js:17530`) | 10 | 37–44 ms total, 4.4–8 ms a tick |
| `tickLiveClocks` (`1615`) | 10 | 4.4–5.3 ms total |
| `sweepThinking` (`4509`) | 8–9 | 2.1–4.7 ms total |
| `tickApprovals` (`7080`) | 10 | 1.3–2.4 ms total |
| `tickQuestionClocks` (`20527`) | 10 | 0.1–0.2 ms |
| `paintWatchClocks` (`17442`) | 10–11 | ≈0 ms |
| `applyPendingFocus` (`9385`) | 40–41 | ≈0.2 ms |
| `refreshSubagentRoster` (`4482`) | 2 | 0.5–1 ms |
| 5 s re-rank (`17639` → `tickLivenessRanks`, `12165`) | 2 | 3.9–19.1 ms total (`reorder` 1.4–14.6 ms) |

- **One DOM node per row per second**: `+2 010 / −2 010` nodes over the 10 s at 201 rows. The 1 s clock walks every visible row (`paintAgeCell`, `public/app.js:11727`) and writes `textContent` for `.age-num` and `title` for the cell (`11758`) — each `textContent` write replaces a text node, so the churn is exactly one node per row per second, and it scales with the row count.
- **Nothing else is awake**: no row frames from the server, no long tasks (longest blocked frame 24.7–50.2 ms), and the 5 s rank pass produced no DOM change (its `reorder` calls returned early because the order held).
- The 30 s safety-net resync (`17609`) fired once and decided the board was not quiet.

## What scales with what

| Driver | Costs |
| --- | --- |
| **Row count** | The whole of path (1): the server's `snapshot()` JSON + gzip and the client's tbody rebuild, both ~0.3–0.5 ms a row each way. The connect frame (2.2 KB a row). A `snapshot` broadcast landing mid-turn (the harvest's, `427–950 ms` at 201 rows). The idle age clock (1 node + ~0.02 ms a row a second). |
| **Turn length** | Per line the append is constant (~0.5 ms), but `recordJobLine` looks a line up by `lid` with `buf.findIndex` (`public/app.js:9437`) so a `set` frame is O(lines already in the turn), capped at 1 000 (`9440`); a tool row rebuilds its whole burst (`9535-9539`); the console's DOM grows ~2 nodes a line (591 nodes for 290 lines). Frames/s are capped by the 120 ms text coalescing, not by the model. |
| **Queue length** | The drag's per-move cost: one box read per queued card until the drop point is crossed, plus one reflow. 50 rows → 85–93 reads a move. |
| **Event rate** | SSE bytes and frames only (2.3–2.8 KB/s at ~8 events/s); the per-line page cost stays constant. |
| **Constant (does not scale)** | JSON parse (0.6 ms), the per-line markdown re-parse (one row), the `insertBefore` count on the drop (44 for 50 rows), and the per-frame overhead of the drag's rAF crawl. |

## Caveats

- **A shared host.** Four repetitions between 12:04 and 12:31 ran beside other agents' full test suites; the same figure moved by up to 45 % between runs (server wait 59 → 110 ms). Every number above is a range, and the low end is the least contended run.
- **Uniform rows.** The 200 worktrees are real linked worktrees, all branches at the same commit (verdict `NO COMMITS`), so cell text is shorter than a mixed board's. The per-row DOM build is the same; the string work is a floor, not a ceiling.
- **One project, 201 rows.** Chip strips and column fitting are paid once per project per render, so a fleet of 200 one-row projects would pay them 200 times — not measured here.
- **The turn is scripted**, not a model: the content is a fixture, the frame rate and coalescing are the panel's own. Tool results are synthetic strings.
- **The drag's 14 s wall is the harness's pointer pacing** (16 ms a move plus a protocol round-trip); the app's own crawl is 14 px a frame (~840 px/s). The per-move and per-frame numbers are the app's; the wall is not.
- **The 437 KB connect frame** is 201 rows at ~2.2 KB a row; a 1 000-row board would be ~2 MB per connect and per harvest snapshot.
- `PerformanceObserver('longtask')` returned no entries in this headless Chromium for most windows, so "longest single task" is reported as the longest gap between animation frames (a frame the page could not paint); where a Long Task entry existed it agreed within a few ms.

## Reproduce

```
node tools/measure-perf-paths.mjs --rows 200 --json C:/Users/roper/AppData/Local/Temp/wag/9e207b2a/perf-200.json
```

The harness builds its own fixture (200 linked worktrees, ~2 min the first time and cached after — `--workdir` moves it), starts a stub Runs API and the panel on free ports with a store of its own, and prints the table above. `--rows`, `--workdir`, `--json`, `--keep` are the knobs; it asserts nothing and exits 0, so it is a measurement, not a gate.

## Who owns each cost — last word

| Cost | Owner | file:line |
| --- | --- | --- |
| `/api/state` payload: every row serialized, then gzipped | `Store.snapshot()`; `sendJson()` | `lib/store.js:207-218`; `lib/http/transport.js:33-46` |
| A refresh tick's render: one project's rows rebuilt wholesale, columns re-measured, chips rebuilt | `resync()` → `applySnapshot()` → `renderProjectRows()` (`rowHtml`, `fitColumns`, `refreshChips`) | `public/core/transport.js:90-100`; `public/app.js:15111`, `15209-15217`, `14854` (row build `14907-14922`, swap `14926`, fit `14969`), `11433`, `13934` |
| A full board render (project set changed) | `renderAll()` | `public/app.js:15006` (`#projects` innerHTML at `15044`) |
| One console line appended | `appendJobLine()` → `drawJobLine()` → `appendProseLine()` → `drawRowText()` | `public/app.js:9410`, `9447`, `7656`, `7591` |
| A markdown marker re-parsing its row | `drawRowText()`'s marker branch (`MD_MARK_RE`) | `public/app.js:7598-7602` |
| A fenced block growing one row | `appendFenceRow()` / `finishFence()` | `public/app.js:7630`, `7641` |
| A tool row rebuilding its burst | `toolGroupHtml()` → `openGroup.replaceWith(fresh)` | `public/app.js:9535-9539` |
| A `set` frame scanning the turn's lines | `recordJobLine()`'s `buf.findIndex` (cap 1 000) | `public/app.js:9432-9441` |
| Line frames coalesced on a clock | `TEXT_FLUSH_MS` / `queueText()` / `emitLine()` | `lib/jobs.js:80`, `1282-1306`, `1229` |
| The full snapshot on connect (437 KB at 201 rows) | `handleStream()` | `lib/http/transport.js:104-110` |
| A whole-board snapshot when a tree is first described (the mid-turn 316–490 ms task) | description `harvest()` → `broadcast({type:"snapshot"})` | `lib/features/descriptions.js:69-75` |
| One write per SSE frame per client | `broadcast()` | `server.js:410-419` |
| The drag's per-move cost: re-query the pane, box-read each queued card, insert, re-read the inserted card, write the transform | `queueDragPaint()` (`queueCardsIn`, `.find(...getBoundingClientRect)`, `insertBefore`, second `getBoundingClientRect`) | `public/assistant.js:2547-2566`, `2132-2135` |
| The drag's per-frame crawl repeating that paint | `queueDragFrame()` | `public/assistant.js:2567-2585` |
| The drop sending the whole list | `queueIdsIn()` → `queueAct(...,"reorder",{ids})` | `public/assistant.js:2137`, `2672` |
| One DOM node per row per second while idle | 1 s age clock → `paintAgeCell()` (`.age-num` `textContent`, cell `title`) | `public/app.js:17530-17560`, `11727`, `11758` |
| The other 1 s clocks' per-row sweeps | `tickLiveClocks()`; `tickApprovals()`; `sweepThinking()`; `applyPendingFocus()` | `public/app.js:1605/1615`, `7035/7080`, `4486/4509`, `9354/9385` |
| The 5 s re-rank that can move every row | `startReorderClock()` → `tickLivenessRanks()` → `reorder()` (`placeInOrder`) | `public/app.js:17639-17651`, `12165-12180`, `14502-14560`, `8804` |
