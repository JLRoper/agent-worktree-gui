# Where the console's jitter comes from

The sources, measured — not a fix and not a proposal. Every number below was read back from a page counter in a
sandbox panel booted by `tools/panel-testkit.mjs` (`startPanel`, its own free port: 65446, 57819, 56768, 64237, 54119
across five passes; never the reader's 7331). No repo file was touched to take a measurement: the instrumentation
lives entirely in the page (an `innerHTML` setter, wrappers on the DOM primitives, `requestAnimationFrame`, the
`ResizeObserver` constructor, the `scrollTop` accessor, `window.scrollBy/scrollTo`, the CSS transition/animation events,
and wrappers around the page's own top-level render functions, which are window properties in a classic script).

One card, six things can repaint it: the console's rows, the burst (`.tgrp`) that groups tool calls, the stored result
bodies inside that burst, the reasoning block above the console, the reasoning drawn *inside* the console as one
stream, and the card/list that contains all of them. They do not share a repaint path, and the five mechanisms in the
brief do not apply to them equally.

## The surfaces, and the one function + line that repaints each

| surface | element | repaint entry point (public/app.js) | what it does | trigger |
| --- | --- | --- | --- | --- |
| normal output | `pre.job-out[data-out]`, rows `.jl` | `drawJobLine` **7427** → `existing.innerHTML` **7505** (`mode:"set"`) / `div.innerHTML` **7515** + `appendChild` **7516** | one row, in place | every SSE `jobline` frame (`core/sse.js` 129 → `appendJobLine` **7393**) |
| normal output, typed | same row | `paintTypedLines` **6312** → `el.innerHTML` **6327**, `setScroll` **6331** | the pacer's next prefix of one growing row | the pacer's own clock (`core/type-stream.js` `tick`, called back as `onPaint` at **6221**) |
| normal output, rebuilt | the whole `<pre>` | `renderConversation` **7272** → `holder.innerHTML = conversationHtml(conv)` **7306** → `el.replaceWith(fresh)` **7309**, then `setScroll` **7320** / restore **7321** | a brand-new console node | a `job` event whose `conversationSignature` moved (`updateJob` **7016** → **7035**) |
| normal output, list rebuilt | every console in `#jobs` | `renderJobs` **6912** → `$("jobs").innerHTML = …` **6949**, `restoreScrolls` **6960/6982** | every card on the unattached list | `applySnapshot` **12686** → **12723-12729**, ownership change, `renderAll` |
| normal output, row rebuilt | every console in a row detail | `renderProjectRows` **12448** → `tbody.replaceChildren(frag)` **12517**, `detailHtml` **12508**, `fillAgentSlots` **10743** (`holder.innerHTML = conversationHtml`) + **10747** (`slot.replaceWith`) | every card in that worktree row | a project/row event, `placeRow` **12282** |
| thinking / reasoning block | `details.think[data-think-turn]` > `.think-body`, blocks `.think-block[data-lid="think:*"]` | `paintThink` **6557** → `holder.innerHTML = thinkHtml` **6568** → `el.replaceWith(fresh)` **6571** | the whole block node | `loadThinking` **6394** ends at `paintThink` **6425**, and `sweepThinking` **3816** runs every **1200 ms** (**3839**) |
| reasoning inside one stream | `.jl-think` row in the console | `lineHtml` **1207** (kind `think`), patched by `syncStreamConsole` (below) | a row of the stream | the merge in `streamBodyHtml` **2185**, re-read on each poll |
| tool-result bodies | `.tgrp-body` rows (`.jl-store`), `.call-body`, code/diff boxes | `toolGroupHtml` **1917** (`storedHtml` **1978**, `consoleBodyHtml`) → `rebuildToolGroup` **1733** → `holder.innerHTML` **1754** → `grp.replaceWith(fresh)` **1758** | the whole group, with its result boxes | a click on a burst row (14126/14149/14340); the **3 s** store sweep **1680-1690** → `ensureToolStore` **1404** → `repaintToolGroup` **1380/1393** (repaint only when the read changed, **1447**); the fold's own click (1665); a batch's `+N commands` (1730) |
| tool groups (bursts) | `.tgrp[data-tgrp]` (head rows + body) | `drawJobLine` **7494** → `openGroup.replaceWith(fresh)` **7498**, or `out.appendChild(fresh)` **7499** | **a new group node for every arriving tool line** | every `jobline` of kind `tool`/`tool-out` |
| tool groups, rendered | `.tgrp` built by the card | `toolGroupHtml` **1917** from `turnBody` **2219** (**2244**) or `streamBodyHtml` **2185** (**2209**) | groups as part of a card render | any card rebuild above |
| tool groups, stream mode | `.tgrp.tgrp-flat` rows in the console | `syncStreamConsole` **6474**: `replaceChildren` **6502**, `insertBefore` **6517**, `replaceWith` **6519**, `insertBefore` **6523**, `remove` **6533** | a patch of keyed rows | `paintStreamConsole` **6546/6551** ← `paintThink` **6560** ← `loadThinking` **6425** |
| the card (container) | `.job[data-thread]` | `renderConversation` **7309** | detaches the console with it | a `job` event with a changed signature |

`conversationSignature` is what keeps the last row of that table from firing on every event: a console-node replacement
was measured **once per `job` event whose signature moved**, never on the per-line path.

## The five candidates, surface by surface

`F` = fires (with the counter that proves it); `—` = cannot affect that surface.

| candidate | normal output | tool groups / result bodies | thinking block | page / board (the container) |
| --- | --- | --- | --- | --- |
| **innerHTML of the whole console** | **—** as an `innerHTML` write. Measured: **0** writes on `pre.job-out` in every pass. The console is replaced as a *node* one level up (7309 / 6949) | **—** on `.tgrp`/`.tgrp-body` (0 writes; node replaced at 1758/7498). **F** per row: 7515/7505 | **—** on `details.think`/`.think-body` (0; node replaced at 6571). **F** per block: 6327 | **F**: `#jobs` innerHTML **1** write per list rebuild (6949) |
| **requestAnimationFrame batching** | **—**: 0 RAF callbacks in a 29-line append | **—** | **—**: `paintThink` runs synchronously inside the read | **F**: 3 RAFs per `#jobs` rebuild (stacks `settleScrolls` ×2, `scheduleBoardSweep`); 2 per card rebuild; `scheduleRenderJobs` 6903 coalesces |
| **scroll anchoring** | **F**, but only the console's own `scrollTop` (6802), not the page | same (one `setScroll` per written row) | same (`stickThinkBody` 6447) | **F**: native anchoring is off (`overflow-anchor:none` on `html`, `.job`, `.job-out`) and `compensateAnchor` **10456** does the work |
| **ResizeObserver** | **—**: the observer does not watch a console | **—** | **—** | **F**: `anchorObserver` **10536** observes `main/projects/jobs/newagent/agents/approvals` |
| **CSS transitions on height or opacity** | **—**: computed `transition-duration: 0s`, `animation-name: none` on `pre.job-out` and `.jl` | **—**: 0s on `.tgrp` | **—**: 0s on `.think-body` | only overlay chrome (`.to-bottom`, `.copy-block`, `.pulse-dot`) — see below |

### 1. `innerHTML` replacement of the whole console

The console itself is never written with `innerHTML` anywhere in `public/app.js` — the element is created inside a
template string (2255) and only ever gets rows appended, patched, or is **replaced as a node**. Measured, with a setter
hook on `Element.prototype.innerHTML` that tags the element:

- writes on `pre.job-out`: **0** (five passes: 30 and 25 line streams, a card rebuild, two `#jobs` rebuilds)
- writes on `details.think` / `.think-body`: **0**
- writes on `.tgrp` / `.tgrp-body`: **0**
- writes on `.jl` (a row): **50 for 25 streamed frames** (one from `drawJobLine` 7505, one from `paintTypedLines` 6327 —
  2 per frame), **60** for the 30-frame pass
- writes on `.think-block`: **60 in 2.7 s** (the pacer typing the block)
- writes on `#jobs`: **1** per `renderJobs` (6949)

So "a whole-console innerHTML replacement" is not a mechanism this code has. What it has instead is a whole *card*
replacement that takes the console with it: `el.replaceWith(fresh)` at **7309**, one per changed signature, measured as
the console node's identity changing (uid 1 → 2) while `#jobs` innerHTML fired once. The reader's place survives both:
pinned console, 16 sampled frames, `scrollTop` constant; unpinned console at 60 px, restored to exactly 60 px after
`#jobs` was rewritten (`0 → 60`, then two `60 → 60` writes; `restoreScrolls` ran twice, `applyStoredScrolls` once).

### 2. requestAnimationFrame batching

Three places batch on a frame:

- `scheduleRenderJobs` (**6903**) — coalesces `renderJobs` to one per frame.
- `settleScrolls` (**6820**) — `requestAnimationFrame(() => requestAnimationFrame(run))` (**6829**), i.e. a scroll
  correction two frames after a rebuild.
- `scheduleBoardSweep` (**10641**) — the board sweep is queued on a frame.

Measured: **0** RAF callbacks during a 29-line append (the append path is synchronous), **2** per card rebuild (one being
`settleScrolls`'s nested pair; counted by wrapping `requestAnimationFrame` and reading the stack), and **3** per `#jobs`
rebuild, with the stacks `settleScrolls`, `scheduleBoardSweep`. The second frame matters because it is the only path
that can move a console *after* the frame the rebuild painted; in the measured rebuilds it found nothing to correct
(the console was already where `renderConversation` had put it: `stickConsole` ran in `settleScrolls`, wrote once and
then no-oped), so no two-stage move was observed.

### 3. Scroll anchoring

Native scroll anchoring is switched off in three places — `html` (**style.css 81**), `.job` (**646**), and the console
itself (**954**) — and the panel replaces it with its own compensator: `anchorObserver` (**10536**) →
`scheduleAnchorCompensation` (**10446**) → `compensateAnchor` (**10456**) → `window.scrollBy(0, delta)` (**10491**).

Measured with an anchor card under the topbar and a second card's console grown from **52.5 px to 230 px**:
`compensateAnchor` ran **11 times**, each a real `scrollBy` (18, 17, 17, 17, 18, 17, 17, 17, 18, 17, then 5 px — 178 px
in total), and the anchor card's top stayed at **64 px** while the page scroll moved 914 → 1092. That is the mechanism
working as designed: it moves the *page*, never a console's rows. It only earns its keep while the growing thing can
still change the document's height.

The console's own scroll is a different thing entirely: `setScroll` (**6802**) is the one writer, and it was measured
**54 times for 29 arriving lines** (29 from `drawJobLine` 7519, one per line, plus 25 from `paintTypedLines` 6331) with
**0 backwards moves** — every write goes toward `scrollHeight`, and the box is pinned unless the reader takes it
(`state.outPinned`, 6786-6792). The 400 ms interval (**14675-14685**) calls `stickConsole` (**6846**) on every console and
wrote nothing once the box was at its bottom.

### 4. ResizeObserver

`anchorObserver` (**10536**) observes only `main`, `projects`, `jobs`, `newagent`, `agents`, `approvals` — never a
console, a `.tgrp` or a think body. Measured:

- a console growing from 52.5 → 230 px: **11 entries on `#jobs` and 11 on `#agents`** (heights 1484 → 1587), which is
  what drove the 11 compensations above;
- a console **already at its 230 px cap**, receiving 25 more lines: **0 entries**. The card's height did not change, so
  neither did `#jobs`.

That second reading is the important one for "the console jitters": past the cap the console is a fixed-size scroll
box, so no observer, no anchor and no page layout can be moved by its output at all. Earlier in the same session, a
console that was still growing (33 → 172 px) produced **5 entries** on `#jobs` — the count tracks the card's height, not
the row count.

### 5. CSS transitions on height or opacity

There are none on any console surface. Computed values read from the live sandbox: `pre.job-out` — `transition-duration
0s`, `transition-property all`, `animation-name none`, `max-height 230px`, `overflow-anchor none`; `.jl` — `0s`, none;
`.tgrp` — `0s`, none; `.think-body` — `0s`, none, `max-height 260px`. Height changes (the console reaching its cap, a
group opening, a block growing) are therefore instant, not animated — a height change is a layout jump, not a smooth
one.

The transition/animation events the page does emit were captured with document-level listeners on
`transitionrun/start/end` and `animationstart/iteration`: **0 on any console surface**, and only:
`animationiteration` on `.pulse-dot` (`livepulse`, 5-7 in a 10 s pass — the card's live dot), one
`transitionrun/start/end` of `opacity` on `.to-bottom` (the jump-to-newest chip, `style.css` 882) and one on
`.copy-block` (`style.css` 917). Both are absolutely-positioned overlay chrome drawn *over* the console; neither changes
a row's height or the console's box.

## What is actually repainting the console, ranked by frequency

With the mechanisms classified, the repaint budget reads like this (all measured):

| frequency | what runs | measured |
| --- | --- | --- |
| per streamed text frame (~40 ms) | `drawJobLine` 7505 + `paintTypedLines` 6327, plus 2 `setScroll` | 50 innerHTML writes and 54 scroll writes for 25 frames; 0 backwards |
| per arriving tool line | **the whole `.tgrp` node is replaced** (7498), not appended to | 3 `replaceWith:tgrp` for 3 call/result pairs; 2 for 2 |
| per store read of the reasoning (~2.4 s while live: 1200 ms sweep, 2000 ms freshness) | `paintThink` 6571 replaces the whole `details.think` | 1 `replaceWith:think` per read; node uid 2 → 3 |
| per 3 s | `ensureToolStore` 1404 → `repaintToolGroup` 1380 → `rebuildToolGroup` 1758 (only when the read changed) | 4 store calls in 3.6 s, 1 group replacement |
| per 1 s | `tickLiveClocks` 1180 writes `textContent` on each `[data-live-from]` | 3 writes in 3 s ("running 8s" → "10s"); `.tgrp-row` height 18 px, unchanged |
| per status change | card node replaced (7309) | 1 per `job` event; console uid changes; scroll restored exactly |
| per snapshot | `#jobs` innerHTML (6949) | 1 write; every card new; the reader's console position restored |

The one place where a *whole* console-adjacent surface is rebuilt on a per-line cadence is the burst: `drawJobLine`
builds `toolGroupHtml` and `replaceWith`s the group for every call and every result (7494-7498). That is the mechanism
the panel's own documentation already points at — a row that leaves one box and appears in the next is the append and the
poll cutting the transcript two ways — and these counters put a number on the cadence: one group-node replacement per
tool line, against one per ~2.4 s for the thinking block and one per changed status for the card.

## What was driven, and what was not

- **Driven:** a sandbox panel per pass from `tools/panel-testkit.mjs` `startPanel()` (own free port, own config, empty
  `API_SERVER_KEY`), a page-side recorder only, and the page's own entry points: the real `EventSource` handler
  (`jobline`, `job`, `snapshot` dispatched on the captured stream), `renderConversation`/`renderJobs` through those
  handlers, `paintThink` through `sweepThinking` (the 1200 ms interval's own body), `rebuildToolGroup` through a real
  click and through the 3 s store sweep, and `compensateAnchor` through a real `ResizeObserver` entry.
- **Stubbed, and named so:** the two server reads a sandbox cannot answer — `/api/thinking` and `/api/tool-results` —
  were fulfilled by a Playwright route that returns two blocks / one result row, because the sandbox has no session
  store. The handlers, the throttles and the repaint decisions they feed are the shipped ones.
- **Not driven:** a real gateway turn. The sandbox has no API key on purpose, so no claim here is about the wire's own
  cadence (`lib/jobs.js` TEXT_FLUSH_MS) — lines were dispatched at a measured 40-45 ms to imitate it.
- Rows and cards were seeded through a `snapshot` payload, not through a spawn, so nothing here is about spawn timing.

The instrumentation (the innerHTML setter that tags `pre.job-out` / `.jl` / `.tgrp` / `details.think` / `.think-block`,
the DOM-primitive wrappers, the `requestAnimationFrame`/`ResizeObserver`/`scrollTop` hooks and the function wrappers) was
injected with `page.addInitScript` and lives in the scratch directory used for this investigation
(`C:/Users/roper/AppData/Local/Temp/wag/d0c9edea/probe*.mjs`). It changes nothing it measures: no fix is proposed here.
