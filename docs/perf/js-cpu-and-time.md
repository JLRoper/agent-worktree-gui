# Front-end CPU and wall-clock waste: `public/app.js` and `public/assistant.js`

Audit of the browser-side JavaScript for work that burns CPU or wall-clock time.
Read-only: no product file was changed. Every finding carries a `file:line`, a cost
that is either measured here or derived from the code, a proposed fix, and the honest
risk the fix carries.

Measurements were taken against the live panel at `http://127.0.0.1:7331` on
2026-11-05. The one thing this audit could **not** do is time the render functions in
a real browser; see "What could not be measured" at the end, and the per-finding
notes on which numbers are measured and which are derived.

---

## Method and raw measurements

### The `/api/jobs` response (measured)

`curl -s http://127.0.0.1:7331/api/jobs` returned:

| quantity | value |
| --- | --- |
| bytes | **965,084** |
| jobs | **116** |
| average bytes per job | 8,883 |
| largest job | 20,012 (`a057bebb`) |
| `lines` field total | 476,444 bytes (**46% of the payload**) |
| `completion` field total | 218,172 bytes |
| `transport` object | 652 bytes |

The payload is dominated by `lines` — nearly half the response is console text for
jobs the client already has. `defaultCwd` is one scalar; `transport` is tiny.

### The SSE stream (measured, 60-second capture)

`curl -N --max-time 60 http://127.0.0.1:7331/api/stream` captured **5,319,964 bytes in
60 seconds across 205 events**. By type:

| event | count/min | total bytes/min | avg bytes | distinct payloads |
| --- | --- | --- | --- | --- |
| `snapshot` | 1 | 3,305,934 | 3,305,934 | 1/1 |
| `assistant` | 4 | 1,011,152 | 252,788 | 4/4 (0% duplicate) |
| `row` | 135 | 828,487 | 6,136 | 135/135 (0% duplicate) |
| `job` | 16 | 150,378 | 9,399 | 16/16 |
| `jobline` | 34 | 14,014 | 412 | 34/34 |
| `heartbeat` | 8 | 3,198 | 399 | 8/8 |
| `project` | 6 | 5,565 | 927 | **3/6 — 3 duplicates (50%)** |
| `remote-write-review` | 1 | 1,032 | 1,032 | 1/1 |

Steady state, excluding the one-time initial `snapshot`: **2,013,036 bytes/min**
(33.6 KB/s, ~121 MB/hour) for one connected client. That is the number the page
actually pays for sitting open.

The `snapshot` is a full state dump: `projects` 2,025,626 bytes (of which
`worktrees` alone is **1,885,272 bytes** across 176 projects), `jobs` 1,062,710 bytes
(118 jobs), `assistant` 265,449, `settings` 71,363, `hosts` 71,155, `spawn` 27,527.

The `assistant` event's 265 KB payload breaks down as: `alerts` 99,219,
`assistants` 97,973, `rules` 19,004, `watches` 13,062, `journal` 10,103, `notes`
8,251, `digest` 5,788, `ruleDefs` 3,630 (static), `assistantSettings` 3,394,
`aggressive` 1,197, `roles` 1,070, `settings` 827, `settingScope` 724 (static).

### Parse and loop costs in V8 (measured)

Node v26.3.0 uses the same V8 engine as Chrome. Benchmarks over 20 runs on the real
965,084-byte payload:

| operation | average |
| --- | --- |
| `JSON.parse` of the 965 KB payload | **5.16 ms** (187 MB/s) |
| `map+join` over 116 job strings | 0.974 ms |
| `find`-in-loop over 116 items (the `sweepThinking` shape) | 0.045 ms |

So parsing 5.3 MB/min costs roughly **28 ms/min** of engine time, and 2.0 MB/min
steady-state costs ~11 ms/min. Parsing is **not** the bottleneck. The cost is what the
code does after parsing: DOM rebuilds, document-wide queries, and forced layouts.

### Static counts from the source (measured by grep)

| file | `addEventListener` | `removeEventListener` | `.innerHTML` | `setInterval` |
| --- | --- | --- | --- | --- |
| `public/app.js` | 232 | 1 | 75 | 16 |
| `public/assistant.js` | 36 | 0 | 24 | 4 |
| `public/core/sse.js` | 18 | 0 | 0 | 0 |
| `public/board/console.js` | 1 | 0 | 14 | 0 |
| `public/core/update-check.js` | — | — | — | 2 |

### Timer arithmetic (derived from the interval registrations)

| timer | interval | callbacks/min |
| --- | --- | --- |
| `tickLiveClocks` (`app.js:1600`) | 1000 ms | 60 |
| tool-store sweep (`app.js:1604`) | 3000 ms | 20 |
| `refreshSubagentRoster` (`app.js:3321`) | 5000 ms | 12 |
| `sweepThinking` (`app.js:3348`) | 1200 ms | 50 |
| `tickApprovals` (`app.js:5958`) | 1000 ms | 60 |
| `applyPendingFocus` (`app.js:6878`) | 250 ms | 240 |
| `deliverPollTick` (`app.js:15925`) | 60,000 ms | 1 |
| `humanTick` (`app.js:15229`) | 250 ms | 240 |
| `tickQuestionClocks` (`app.js:21363`) | 1000 ms | 60 |
| `reportVisibility` (`app.js:21464`) | 3000 ms | 20 |
| `reportVisibility` force (`app.js:21465`) | 5000 ms | 12 |
| `paintDeliverAges` (`app.js:15863`) | 30,000 ms | 2 |
| `paintWatchClocks` (`assistant.js:5409`) | 1000 ms | 60 |
| message-board refresh (`assistant.js:5416`) | 15,000 ms | 4 |
| bridge poll (`assistant.js:5614`) | 15,000 ms | 4 |
| `update-check` poll (`core/update-check.js:270`) | 30,000 ms | 2 |
| **total** | | **≈ 847/min (~14/s)** |

Of those, the ones that do real DOM work on every tick rather than returning early:
`tickLiveClocks` 60, `sweepThinking` 50, `tickApprovals` 60, `tickQuestionClocks` 60,
`reportVisibility` 20+12, `paintDeliverAges` 2 — **≈ 264 callbacks/min** that query or
write the DOM. The rest (`applyPendingFocus`, `humanTick`) return immediately unless a
pending focus exists.

### Client-issued HTTP requests (derived from the code, not measured live)

| route | cadence | requests/min |
| --- | --- | --- |
| `/api/subagents` (`app.js:3321`) | 5 s, skipped while hidden | 12 |
| `/api/deliverables` (`app.js:15925`) | 60 s, skipped while hidden | 1 |
| `/api/visible` (`app.js:21464/21465`) | 15 s heartbeat + on change | ≤ 4 |
| `/api/assistant/messages` (`assistant.js:5416`) | 15 s, only while the Messages tab is visible | 4 |
| `/api/assistant/bridge` (`assistant.js:5614`) | 15 s, only while the Bridge tab is visible | 4 |
| `update-check` (`core/update-check.js:270`) | 30 s | 2 |
| `/api/jobs` for the queue pane (`assistant.js:3347`) | guarded to 5 s, only when the pane repaints | ≤ 12 |

Steady state is **≈ 23–39 requests/min**, plus the persistent `EventSource` carrying
205 events/min. The routes do not overlap in what they fetch: the message board is a
separate dataset from the SSE assistant state (`state()` carries no `messages` key), so
the 15 s message poll is not redundant with the stream.

### Prior measurements already recorded in the source (quoted, not re-measured)

These are the code's own notes from earlier profiling. They are the most reliable
wall-clock numbers available, and this audit did not re-run them:

- `public/core/sse.js:49-52` — the `project` handler was "the most expensive path on the
  page (**350 ms of main thread a minute**, 0.48.1)", and "68 of 68 repeat events in
  100 s were byte-identical".
- `public/app.js:10795-10800` — `reorderProjects` "ran **393 times a minute** on the
  reader's board; its four such searches a call were **160 ms a minute** of native
  search".
- `public/app.js` placedNodes comment — the 1 s queue clock costs "**49 ms a minute** of
  native search on its own"; `tr.detail` under `sweepStaleBoard` runs "**~44 a minute**".
- `public/board/console.js:2205-2215` — an off-screen pulse dot "held **4.5 points of a
  core** (9.3% animated against 4.8% still)".

---

## Findings, worst first

### 1. Wholesale `innerHTML` rebuilds, multiplied by two document-wide MutationObservers

**Where**
- `public/app.js:6432` — `renderJobs()` writes the entire board list:
  `$("jobs").innerHTML = convs.length ? convs.map(conversationHtml).join("") : ...`
- `public/app.js:6806` — `renderConversation()` writes one whole card:
  `holder.innerHTML = conversationHtml(conv)` then `el.replaceWith(fresh)`.
- `public/assistant.js:982` — `renderAssistantChat()` writes one whole chat:
  `host.innerHTML = conversationHtml(conv)`.
- `public/board/console.js:2247` — `copyObserver`, a `MutationObserver` with
  `{childList: true, subtree: true}` on `document.documentElement`
  (registered at `public/app.js:6293`). For **every added element node** it runs
  `mountCopyButtons(node)`, `armPlacedThink(node)` and `watchMotion(node)`, each of which
  does at least one `querySelectorAll` over that node's subtree.
- `public/app.js:6296+` — `placedNodes.watch` is a **second** `MutationObserver` on the
  same `document.documentElement` subtree, adding every node to per-kind `Set`s.

**Cost (measured/derived)**
- String build: measured 0.974 ms for 116 items via `map+join` in V8. The DOM parse and
  insertion that follow are not measured (see limitations), but each added node feeds
  both observers, so a wholesale rebuild is roughly *O(nodes)* query calls on top of the
  insertion itself. A 116-card rebuild inserts hundreds to thousands of elements; each
  one is an `addedNode` record whose subtree is queried 2–4 times.
- Frequency: `renderJobs` is gated by a list signature (`app.js:6426`), so it only fires
  when the card set or a card signature changes. `renderConversation` fires once per
  `job` event (**16/min measured**) plus per `row`/approval path; `renderAssistantChat`
  fires once per session per `assistant` event (**4/min measured × sessions**).

**Fix**
Scope the observers to the containers that can produce copyable/thinking/motion nodes
(`#jobs`, `#projects`, the assistant host) instead of `document.documentElement`, and
process `addedNodes` once per callback rather than per node. For the renderers, keep the
existing signature guards and replace wholesale `innerHTML` with an append/patch path
for the common case (a new line or a changed status), falling back to a full rebuild
only when the structure changes.

**Risk**
High. The rebuild-and-restore machinery is load-bearing: `renderJobs` deliberately
rebuilds wholesale and then restores scroll positions, card selection and the caret
(`app.js:6427-6470`); `renderConversation` restores console scroll, selection and typing
(`app.js:6790-6830`). A patch path has to reproduce all of that or the reader loses
their place mid-stream. The copy-button observer also arms the thinking block's open
state *before* the `toggle` event fires (`console.js` comment at 2200), so delaying it
to a batched callback risks mis-recording a reader's open/closed choice. Scoping the
observers to containers risks missing nodes inserted outside them.

### 2. The 3.29 MB initial snapshot, applied synchronously on connect

**Where** `public/core/sse.js:62-66` parses the first frame and calls `applySnapshot`
(`public/app.js:12310`). The frame is a full state dump; `projects` alone is 2.03 MB
(`worktrees` 1.88 MB over 176 projects), `jobs` is 1.06 MB over 118 jobs.

**Cost (measured/derived)** Measured: 3,305,934 bytes in one event. At the measured
187 MB/s V8 rate that is **~17.7 ms of pure `JSON.parse`** before `applySnapshot` runs.
`applySnapshot` then clears and re-sets `state.jobs` for 118 jobs and repaints the board
(`renderAll`); the DOM build for 1.88 MB of worktree JSON is not measured, but it is the
page's single largest synchronous block.

**Fix** Send a lighter first frame: drop `worktrees[].rows`/per-row detail from the
snapshot and let the row events fill them in, or page the projects. The client already
treats `project` events as incremental, so a snapshot that carried project shells only
would land much smaller.

**Risk** Medium-high. `applySnapshot`'s readers expect the full object: `data.paths`,
`data.hosts`, `data.scanRoots`, `data.spawn`, `data.skipped`, and the `jobs` array all
have consumers in the same function. Removing fields means auditing every consumer and
guaranteeing a follow-up event fills each one; a missed field renders an empty board
until the next event.

### 3. Timers that query the whole document every second — several unguarded while hidden

**Where**
- `public/app.js:1600` `setInterval(tickLiveClocks, 1000)` — the function at `1591`
  runs `document.querySelectorAll("[data-live-from]")` and writes `textContent` plus a
  `classList.toggle` per match. **No `document.hidden` guard.**
- `public/app.js:3348` `setInterval(sweepThinking, 1200)` — `3336` runs
  `document.querySelectorAll(".job[data-thread]")`, then per card a
  `conversations().find(...)`, then per turn a `document.querySelector` for the thinking
  block. **No `document.hidden` guard.**
- `public/app.js:5958` `setInterval(tickApprovals, 1000)` — `5941` iterates
  `state.approvals` and runs a `document.querySelector` per approval. No hidden guard.
- `public/app.js:21363` `setInterval(tickQuestionClocks, 1000)` — `2089` iterates the
  `placedNodes("[data-q-clock]")` cache and writes inline styles. No hidden guard.
- Guarded for comparison: `refreshSubagentRoster` (`3252`), `deliverPollTick` (`15916`),
  `pipeWindowStartClock` (`assistant.js:4058`), the message refresh (`5418`).

**Cost (derived)** ≈ 264 DOM-touching callbacks/min, of which `tickLiveClocks` (60) and
`sweepThinking` (50) do a **full-document** query each time. The source already measured
one 1 s clock's native search at 49 ms/min; `tickLiveClocks` and `sweepThinking` are not
in the `placedNodes` cache list, so they still walk the whole document. In a hidden tab
Chrome throttles timers to roughly once a minute only after ~5 minutes, so the first
five hidden minutes keep paying full cost.

**Fix** Register `[data-live-from]` and the card list in `placedNodes` the way
`.queue-ago`, `.tgrp` and `[data-q-clock]` already are, so each tick walks a cached `Set`
instead of the document. Add `if (document.hidden) return;` to the five unguarded
timers. Consider one shared 1 s ticker that walks each cache once and updates all clocks.

**Risk** Medium. Clocks that stop while hidden must resync on `visibilitychange`, or the
first visible frame shows a stale elapsed time. The thinking sweep also folds finished
blocks; skipping it while hidden means a block stays open until the tab is shown again —
visually harmless but a behavioural change.

### 3b. `reportVisibility` forces a synchronous layout 20 times a minute

**Where** `public/app.js:21438` `reportVisibility()` calls `visibleProjects()` (`21430`),
which runs `document.querySelectorAll("#projects section.project[data-project]")` and
then `getBoundingClientRect()` on **every** section. It is scheduled at `21464` (3 s) and
`21465` (5 s), and also runs on scroll/resize via `startVisibilityReporting` (`21455`).
It returns early only when `scanMode !== "visible"`.

**Cost (derived)** A `getBoundingClientRect()` per project section is a forced style +
layout recalculation. At 20 samples/min over N sections, that is `20 × N` forced layouts
per minute. The board's snapshot lists 176 projects; even a fraction rendered is a real
cost. This runs whether or not the tab is visible.

**Fix** Cache the section rectangles and invalidate on `ResizeObserver`/mutation/resize
instead of re-measuring every 3 s; skip the sample while `document.hidden`.

**Risk** Medium. The server uses this list to decide which projects to scan in "visible"
mode. A stale list means the wrong projects get scanned — or stop being scanned — which
is a functional regression, not a cosmetic one.

### 4. Row events: 135/min, no dedupe, each one a DOM replacement plus a re-rank

**Where** `public/core/sse.js:67-73` — the `row` handler calls `queueRow(...)` with no
comparison against the row already in `state.rows` (contrast the `project` handler,
which has `projectEventIsNew` at `sse.js:53`). `queueRow` (`app.js:11826`) batches to
`requestAnimationFrame` and flushes through `placeRow`, which reads `window.scrollY`,
calls `captureBoardAnchor()`, replaces the row's markup, and queues
`queueReorderProjects()` → `reorderProjects()` (`app.js:10815`).

**Cost (measured/derived)** Measured: **135 row events/min**, 828,487 bytes/min, all
135 payloads distinct. Of those, 85 carry `livenessOnly: true` (63%) — activity signals,
not state changes. Each flush does at least one scroll read (forced layout) and a row
replacement. The source's own measurement for the re-rank alone is 393 calls/min at
160 ms/min of native search.

**Fix** Add a `rowEventIsNew` guard mirroring `projectEventIsNew`: compare only the
fields the row draws and skip `queueRow` when nothing changed. Separately, consider not
repainting a row for `livenessOnly` events when the only drawn field is the pulse dot.

**Risk** Medium. Liveness fields change often and drive the "alive" appearance; a naive
deep compare would drop genuine updates or cost more than the repaint it avoids. The
compare must be over the drawn projection only. The server sends a row event on every
patch, so the client guard is the only cheap place to stop this.

### 5. `updateJob` calls a full `renderConversation` on every job event

**Where** `public/app.js:6500` `updateJob()` — after merging state, it unconditionally
calls `renderConversation(j.thread || j.id, { scroll })` at `6521`, on **every** `job`
event (measured 16/min).

**Cost (derived)** `renderConversation` first does `conversations().find(...)`, a
`document.querySelector` for the card, then computes `conversationSignature(conv)` — a
string built from the conversation state — and only rebuilds when the signature
differs. So the rebuild is guarded, but the *lookup plus signature build* runs 16 times
a minute for a job whose change may not affect the drawn card at all (e.g. a stats or
liveness field). The signature build cost scales with the conversation size.

**Fix** Compare the drawn fields of the incoming job against the stored one inside
`updateJob` and call `renderConversation` only when something the card draws changed.
The function already computes `statusChanged`, `approvalChanged` and `ownerChanged`;
extend that gate to the render call.

**Risk** Medium. The card draws more than status/approval/ownership — title, model,
live numbers, stats — so the gate must include every field the card reads or the card
goes stale. A missed field is a silent UI bug that only shows on a specific event type.

### 6. The `assistant` event: 265 KB × 4/min, ~50% of steady-state traffic, static config re-sent

**Where** `public/core/sse.js:239-243` — every `assistant` frame parses the whole state
and calls `applyAssistant` (`public/assistant.js:551`), which runs
`paintAssistantBadge()` (filters and reduces over `alerts`, ~99 KB), `paintSpawnStrip()`,
`paintAggressive()`, `syncSessionTabs()`, then
`for (const rec of sessionRecords()) renderAssistantChat(rec.id)`, plus
`renderAssistant()` when the panel is open.

**Cost (measured/derived)** Measured: 4 events/min, 1,011,152 bytes/min (50% of the
2.01 MB steady state), payload 265,790 bytes max. `ruleDefs` (3,630 B), `settingScope`
(724 B) and `settings` (827 B) are static tables re-sent on every frame — ~5.2 KB × 4 =
21 KB/min of unchanging config. The per-session `renderAssistantChat` calls are guarded
by a signature (`assistant.js:977`), so they only rebuild when the chat changed, but the
loop, the badge filters and the `conversations().find` run every frame regardless.

**Fix** Send deltas: alerts added/removed, assistant settings changed, and omit
`ruleDefs`/`settingScope` after the first frame. On the client, keep a last-applied
payload hash and skip `applyAssistant` entirely when the frame is identical to the last.

**Risk** Medium-high. `applyAssistant` replaces `state.assistant` wholesale and every
reader in `assistant.js` reads it; a delta path needs a merge function and a story for
removals (an alert that disappeared must be deleted, not just not-added). The static
tables are read by the Settings/roles UI, so they must survive the first frame.

### 7. `renderJobs()` also rebuilds the chip row and runs a prune pass on every call

**Where** `public/app.js:6432` rewrites `$("jobs").innerHTML`; `6466` rewrites
`$("agents-chips").innerHTML` on every call even when `sameList` is true (the chips are
outside the `if (!sameList)` block); `6391-6405` prunes `collapsedJobs`, `turnOpen`,
`turnCompact`, `turnPage` and calls `pruneOutHeights` each time.

**Cost (derived)** The chip row is small, but it is rebuilt on every `renderJobs` call
(every batch where the list signature changed). The prune passes iterate the state maps
and call `conversations()` repeatedly — `conversations().some(...)` inside a loop over
`state.collapsedJobs` is another `O(n²)` shape. On a 116-card board the measured cost is
small (the find-in-loop benchmark was 0.045 ms), but it runs on every list render.

**Fix** Move the chip repaint inside the `sameList` guard or diff the chip text; build
`conversations()` once into a `Set` of threads and use it for the prune instead of
calling `.some()` per id.

**Risk** Low. The chip row only reflects counts; rebuilding it less often cannot break
behaviour as long as the counts still update when the list changes.

### 8. Event-listener imbalance: 232 added, 1 removed in `app.js`

**Where** grep counts: `app.js` 232 `addEventListener` / 1 `removeEventListener`;
`assistant.js` 36 / 0; `sse.js` 18 / 0; `console.js` 1 / 0.

**Cost (measured by count, not by runtime)** Most of these are page-lifetime listeners
on `document`, `window` and static buttons — intended to live as long as the page. The
ratio is not proof of a leak. The risk is the listeners attached to *dynamically created*
nodes: per-card handlers, popover handlers, drag handlers. Those are the ones that leak
when a card is rebuilt by `innerHTML`, because the old node's listener goes with the node
but the new node's handler is added again — and if anything holds a reference to the old
node (a `Map`, a `Set`, a closure), the listener and its captured state stay alive.

**Fix** Audit the `addEventListener` sites attached to elements created by a render path
(`renderConversation`, `renderAssistantChat`, `renderJobs`, the popovers) and remove the
listener in the same path that removes the node. The one existing `removeEventListener`
shows the pattern is known.

**Risk** Medium. Removing a listener that a later render path relies on breaks the
control silently. This needs a per-site audit, not a blanket sweep. The honest position:
the ratio is suspicious but **not measured as a leak**.

### 9. Redundant `project` broadcasts: 3 of 6 events byte-identical

**Where** measured from the stream: 6 `project` events/min, 3 distinct — 50% redundant.
The client's `projectEventIsNew` (`sse.js:53`) already drops them without a repaint, so
the client cost is only the parse (927 B each, trivial). The waste is bandwidth and
server work.

**Cost (measured)** 3 × 927 B ≈ 2.8 KB/min. Negligible on the client; a server-side
fix belongs in `lib/store.js patchProject`, which the `sse.js` comment already names as
the sender that broadcasts "on every patch, changed or not".

**Fix** Server-side: compare the patch against the stored project and broadcast only on a
real change. Client-side: nothing needed; the guard already exists.

**Risk** Low. The guard already proves the client does not depend on receiving identical
frames. A server-side compare needs to cover every field the board draws, or a change
goes un-broadcast.

### 10. Honest calibration: `JSON.parse` is *not* the bottleneck

Measured: 5.16 ms for 965 KB. The full 5.3 MB/min costs ~28 ms/min, and steady state
~11 ms/min. Compared with the documented 350 ms/min for the `project` handler and
160 ms/min for `reorderProjects`, parsing is a minor line item. It only becomes
significant on the initial 3.29 MB snapshot (~17.7 ms in one synchronous block) and on
`/api/jobs` if that full payload is fetched repeatedly — which it is not: the GET is
guarded to 5 s and only runs when the queue pane repaints.

---

## What could not be measured, and why

1. **In-browser wall time for any render function.** The automated browser could not
   hold the panel in a measurable state. The first load reached `readyState: "loading"`
   with 702 DOM nodes and stayed there; a `Runtime.evaluate` probe timed out after 5 s.
   A later navigation timed out in `Page.navigate` after 5 s, and a follow-up probe found
   a blank page with 3 nodes. No long-task profile, no `performance.measure`, no
   per-render timing. The 350/160/49 ms figures quoted above are the source's own prior
   measurements, not this audit's.
2. **Runtime event-listener count.** `DOMDebugger.getEventListeners` requires a live
   page object; the same timeouts blocked it. The 232/1 ratio is a static grep count.
3. **CPU percentage of the page and total blocking time.** No trace was obtainable.
4. **Actual DOM cost of a wholesale rebuild.** The string-build half was measured
   (0.974 ms for 116 items); the parse/insert half was not. The observer multiplication
   is structural (two document-wide subtree observers), not measured.
5. **The `jobs` full-list broadcast frequency.** It did not fire during the 60 s capture
   (0 events), so its cadence is unknown. Its payload is inferred from `/api/jobs`
   (965,084 bytes); a real `jobs` event would cost about that much to parse.
6. **Whether the listener ratio is a real leak.** Static counts cannot distinguish
   page-lifetime listeners from per-node listeners; only a runtime count plus heap
   snapshot would.
7. **The `/api/assistant/messages` payload size.** The route was not captured; the
   message-board poll's bandwidth is unknown. It is not redundant with the SSE assistant
   state (`state()` carries no `messages` key), so the poll itself is justified.

---

## What I would fix first

1. **Scope the two document-wide MutationObservers** (`console.js:2247`, `app.js:6296`)
   to containers. This multiplies every render path; it is the cheapest change with the
   widest effect.
2. **Add `document.hidden` guards to the five unguarded timers** (`tickLiveClocks`,
   `sweepThinking`, `tickApprovals`, `tickQuestionClocks`, `reportVisibility`) and move
   `tickLiveClocks`/`sweepThinking` onto the existing `placedNodes` cache. Small, local,
   and removes the hidden-tab cost.
3. **Gate `updateJob`'s `renderConversation` call** on a drawn-field comparison. Removes
   ~16 lookups + signature builds a minute for no visual change.
4. **Add a `rowEventIsNew` guard** for row events (135/min, 63% liveness-only). This is
   the largest event count on the page.
5. **Trim the snapshot and the assistant frame** server-side: project shells on first
   frame, alert/settings deltas afterwards. Biggest bandwidth win; needs a merge path on
   the client, so it is the highest-risk item here.

The wholesale `innerHTML` rebuilds are the structural cause of most of the per-render
cost, but replacing them is the riskiest change in this list: the scroll/selection/caret
restoration machinery is built around replacement. Gate and cache first; diff later.
