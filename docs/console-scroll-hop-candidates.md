# The console scroll hop: every shared write that could do it, ranked

The report: every open console jumps to the top of its own scroll box and is back at the bottom inside a split second,
all of them on the same instant, in different projects. Per-card churn cannot do that — one write moves them all.

Read at `e1bdb0e` (0.32.6) without a browser: `public/app.js`, `public/core/*.js`, `public/assistant.js`, `server.js`,
and the `lib/` clocks that make the page repaint. Every claim below is a line in that tree, not a measurement; §7 is
the measurement that separates the candidates, and it is the one thing this note does not decide.

> **Status (0.34.0).** The table below is the tree at `e1bdb0e`, as read. The measurement it asked for was taken
> (`docs/console-scroll-hop.md`): every one of the 94 painted hops in its before-the-fix runs was candidate 1,
> `reorderProjects`. Candidates 1, 5 (`sweepStaleBoard`) and 6 (`reorder`, `reorderAgentCards`) are now closed the same
> way - each moves only the elements that are out of place and holds its scroll boxes across the move
> (`placeInOrder`, `holdScrolls`/`releaseScrolls`) - and `tools/verify-console-independence.mjs` and
> `test/console-independence.test.js` fail if one of them stops.

## 0. What the symptom already rules out

**No code writes `0` to a console.** `pre.job-out` is written in exactly one place, `setScroll` (`public/app.js:6907`),
and every call passes either `el.scrollHeight` (follow the newest line) or a remembered `top` (put the reader back).
There is no `setScroll(out, 0)` anywhere, and the 400 ms sweep (`public/app.js:14798-14809`) only ever asks for
`pre.scrollHeight`. So the top of the box is the browser's own clamp — a node that lost its layout, either because it
was **replaced** (fresh node at 0) or because it was **detached and re-attached** (a *move*).

**Only two restores land in a later frame than the paint that showed 0.** Everything else restores in the same task,
so no frame is ever painted off the bottom:

| restore | line | when it lands |
| --- | --- | --- |
| `settleScrolls` | `public/app.js:6925-6936` | two `requestAnimationFrame`s after a rebuild |
| the console-stick sweep | `public/app.js:14798-14809` | up to 400 ms later, and only for **pinned** boxes |

That second row is the shape of the reported hop: a box clamped to 0 by a move, painted that way, and put back on the
newest line by the next 400 ms tick — "top, and back, within a split second". A box the reader had scrolled up
(unpinned, `state.outPinned[id] === false`, `public/app.js:6891`) is *not* put back by that sweep, so it stays at the
top until something else moves it. That asymmetry is the sharpest fingerprint in this note.

**The box cannot collapse to 0 px.** `.job-out` carries `min-height: 34px`, `max-height: 230px`, `overflow: auto` and
`overflow-anchor: none` (`public/style.css:958-970`). A measurement wants the console's `scrollHeight` (content) and
`scrollTop`, never the box height.

So the candidates split three ways: (a) replaces the console node, (b) moves a subtree containing it, (c) writes
`scrollTop` on many boxes at once. (c) is ruled out by the grep above except for the sweep, which cannot move a box to
the top.

## 1. Every write that can move more than one console at once

| # | write | file:line | runs when | consoles touched | what it does to them | restore on that path |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | `reorderProjects` re-appends sections and folders | `public/app.js:11540`, section loop `:11571-11578` (append `:11576`), folders `:11592-11604` (append `:11603`) | the reorder clock (`:14993-15004`), every row batch (`queueReorderProjects` `:11530-11536`, called from `queueRow`'s flush `:12399`), every snapshot (`:12916`), every agent state change (`repaintAgentState` `:8440`), an ownership change (`:7179`) | every open project in any folder whose project order moved, **and** every folder | `body.appendChild(el)` / `host.appendChild(g)` on a list that includes the open sections: each one is detached and re-attached | **none** — it restores typing and the card selection only (`:11605-11607`) |
| S2 | `renderAll` | `public/app.js:12717`; `$("projects").innerHTML` `:12746`; clears `state.rowEls`/`state.detailEls` at `:12777-12779`; per-project loop `:12781-12786` | a snapshot whose **set** of projects changed, or a board with no project section yet (`:12901`); a hidden-column change (`:16612`); `applyStabilize` (`:12234`) | every console in every project | whole board replaced; and because `detailEls` is cleared before the loop, `fillAgentSlots` gets an empty reuse map — every card, and so every console, is a **new node** | `settleScrolls` two rAFs later (`:12694`), plus `applyStoredScrolls` from `state.outScrolls` (`:12693`) |
| S3 | `renderJobs` rewrites `#jobs` | `public/app.js:7017`; signature guard `:7054-7056`; `innerHTML` `:7071` | a snapshot carrying jobs (`:12852`), a `jobs` frame, a new unattached card | only the unattached cards in `#jobs` (never a row's card) | every card replaced | same-task `restoreScrolls` twice (`:7082`, `:7092`), then `settleScrolls` (`:7099`) |
| S4 | `applySnapshot` → `renderProjectRows` per project | `public/app.js:12910-12914`; `renderProjectRows` `:12571`; `tbody.replaceChildren(frag)` `:12640`; `fillAgentSlots` `:12662`; `restoreScrolls` `:12692` | every `snapshot` frame (`public/core/sse.js:48-51`) and every `resync()` | every console in every **expanded** project | rows replaced, but the live cards are **moved** into the new detail (`public/app.js:10857`) | same-task `restoreScrolls` from the pre-swap capture (`:6958`, restored at `:12692`), `applyStoredScrolls` (`:12693`), `settleScrolls` (`:12694`) |
| S5 | `sweepStaleBoard` re-attaches details | `public/app.js:10777`; the move `:10807` | after **any** render (`scheduleBoardSweep` `:10764-10775`) | every open row whose detail no longer follows its `<tr>` | `ownRow.after(d)` — the detail, its cards and their consoles are detached and re-attached | **none** (typing, add-agent field and selection only, `:10846-10848`) |
| S6 | `reorder` re-appends rows **and details** | `public/app.js:12278`; append loop `:12327` | the reorder clock (`:10132`), `placeRow` (`:12531`) | every row of one project, and every open row's consoles | same move, whole tbody | **none** — typing and selection only (`:12329-12330`, `:12344`) |
| S7 | `reorderAgentCards` moves cards inside a detail | `public/app.js:10160` (guard), `:10167` (move) | the reorder clock (`:10133`) | every card in every open detail of one project | `block.insertBefore(el, anchor)` — cards, and their consoles, moved | **none** |
| S8 | `renderConversation` replaces a card | `public/app.js:7395`; signature check `:7408-7411`; `el.replaceWith(fresh)` `:7432` | one card whose `conversationSignature` moved (`:7185`), a `job` frame, a live-flip in the subagent roster (`:3746`) | one console | new card, new console node | same-task `setScroll` per console (`:7440-7445`) + `settleScrolls` (`:7450`) |
| S9 | the `project` SSE frame | `public/core/sse.js:61-121`; `sec.replaceWith(freshHolder)` `:96`; `renderProjectRows` `:107` | a project summary changed on the server | every console in that project | section replaced, then rows rebuilt with the old row nodes put straight back (`:101`) | same-task, inside `renderProjectRows` |
| S10 | `placeRow` rebuilds a row's detail | `public/app.js:12405`; `oldDetail.remove()` `:12493`; `newTr.after(dEl)` `:12504`; `fillAgentSlots` `:12508`; `restoreScrolls` `:12516` | every `row` frame, batched to one rAF (`:12390-12400`) | every console in one row | detail replaced, cards moved | same-task `restoreScrolls` from the pre-move capture (`:12516`), `applyStoredScrolls` (`:12517`), `settleScrolls` (`:12518`) |
| S11 | `renderRoot` / `pinOpenProjects` | `public/app.js:633` (section `replaceWith` `:643`), `:11495` (append `:11514`) | the folder's All/7d toggle, a folder re-render | every console in one folder | section replaced with fresh rows; cards rebuilt | `renderProjectRows`' own restore |
| S12 | the assistant's chat rebuild | `public/assistant.js:714`; `host.innerHTML` `:743` | the assistant thread's signature moved | the float only — no board console | new card | `restoreScrolls`/`settleScrolls` (`:745-751`), `pinChatToBottom` (`:242-252`) |

## 2. Every writer of `scrollTop`

One writer for the board's consoles, `setScroll` (`public/app.js:6907-6913`), plus the assistant's own three direct
writes (`public/assistant.js:247`, `:756`, `:1249`). Its callers, and what they can and cannot do:

| caller | line | boxes | value |
| --- | --- | --- | --- |
| `stickConsole` | `:6951` | pinned only, and only when off the bottom | `scrollHeight` |
| `restoreScrolls` | `:6972` | the ones in the map | `scrollHeight` if pinned/at-bottom, else `min(was.top, max)` |
| `applyStoredScrolls` | `:6983` | the ones in `state.outScrolls` | same rule |
| `stickThinkBody` / `stickSubConsole` | `:6450` / `:6441` | one block / one child console | bottom |
| `restoreThinkBody` | `:6938` | one block | remembered top |
| `paintTypedLines` | `:6334` | consoles holding a line the pacer grew | `scrollHeight` if pinned |
| `paintStreamConsole` | `:6555` | one console | `scrollHeight` if pinned |
| `drawJobLine` | `:7642` | every pane carrying the line | `scrollHeight` if pinned |
| `syncStreamConsole`'s keep-the-reader-line correction | `:6543` | one console | `scrollTop + (off - keep.off)` |
| the 400 ms sweep | `:14798-14809` | **every** `pre.job-out`, `.think-body`, `.sub-console` | `scrollHeight` if pinned, else no write |
| `pinChatToBottom` | `public/assistant.js:242-252` | the float's body | `scrollHeight` |

Nothing here can move a box to 0. A sweep pass costs three layout reads per console (`scrollHeight`, `clientHeight`,
`scrollTop`), so its cost grows with the number of boxes on screen — worth knowing for the "does the hop's rate or
cost scale with the number of open consoles" question in §5, but it is not the fault.

## 3. Every timer, with its period

**Client (`public/app.js`, `public/assistant.js`, `public/core/*.js`).** The 5-20 s band is marked ◆.

| period | line | what it touches |
| --- | --- | --- |
| 250 ms | `public/app.js:7491` | `applyPendingFocus` — caret/one-shot scroll of a just-spawned card's page |
| 400 ms | `public/app.js:14798` | the console-stick sweep: `scrollTop` on every pinned box (§2) |
| 1 s | `:1193`, `:6022`, `:16784` | live clocks, approval clocks, question clocks — text only |
| 1.2 s | `:3842` | `sweepThinking` → `loadThinking` → `paintThink` (in place since 0.32.6) |
| 2 s | `public/core/update-check.js:47` | build watcher |
| ◆ 3 s | `public/app.js:1683` | `ensureToolStore` for every open tool group — replaces `.tgrp` rows inside a console, never the console |
| ◆ 3 s | `public/app.js:16881` | visibility sample — returns at once unless `scanMode === "visible"` (`:16852`), and `config.json` does not set it |
| ◆ 4 s | `lib/jobs.js:2132` | per-run stats refresh → a `job` frame when the numbers move → `paintCardMeta` only (the numbers are not in the signature) |
| ◆ 5 s | `public/app.js:3815` | `refreshSubagentRoster` → `paintSubagents`; on a live-flip it calls `renderConversation(thread)` (S8), and it re-reads every live sub-console |
| ◆ 5 s | `public/app.js:16882` | visibility heartbeat — same early return as above |
| ◆ 5 s | `server.js:1684` | `heartbeat` frame — `state.pool` only |
| ◆ 5 s | `lib/scheduler.js:168` | the liveness pass (`liveSeconds`, 5 in `config.json`; `lib/scheduler.js:296-345`): `store.touch` for **every live row**, which emits a `row` frame (`lib/store.js:149-160`) — the one global, recurring write on this list |
| ◆ 5 s | `lib/approvals.js:16`, `lib/remote-writes.js:75` | parked-approval and remote-write sweeps — frames only when one expires |
| ◆ 10 s | `lib/jobs.js:453` | title sweep → a `job` frame when a title lands (the title **is** in the signature, `:7224`) → S8 for that card |
| ◆ 10 s | `server.js:4174` | `sweepCheckedLandings` → a `snapshot` broadcast only when a check answer deletes a tree |
| ◆ 15 s | `public/assistant.js:1062`, `:1864-1870` | the message board, and only while that tab is open |
| ◆ 15 s | `lib/jobs.js:2149`, `:2669` | the per-run poller (the backstop for a dead event stream) |
| 30 s | `public/app.js:14963` | the `resync()` safety net, gated by `public/core/liveness.js` |
| 30 s | `public/core/update-check.js:46` | build poll |
| 0-600 s (default 5) | `public/app.js:14993-15004` | **the reorder clock**, `reorderSeconds()` (`wm.reorderSeconds`, `:14981`) → `tickLivenessRanks`; 0 switches it off |
| 30 s / 60 s / 12 s / 6 s / 20 s (once) | `server.js:4178`, `:4186`, `:4187`, `:4176`, `:4181` | parent warm-up, release sweep and their boot passes |

**There is no 7-15 s scheduler in this tree.** The periods are 1, 1.2, 2, 3, 4, 5, 10, 15, 30 and 60 s. So whatever
beats every 7-15 s is a 5 s clock that *sometimes does the visible thing* (S1 does nothing on a tick whose order did
not change) or a 10/15 s one (S8's title flip, the poller). That distinction is worth keeping: a candidate that needs
an order change, a signature change or a title landing will read as 7-15 s to a reader counting hops.

**Server clocks that make the client repaint at all** (`server.js:355`, `store.onEvent(broadcast)`): the scheduler tick
(1 s → liveness pass 5 s, per-row due times 5/45/90 s per `config.json`), `jobs.emit` (`lib/jobs.js:961-968`, which
sends both a `job` and a full `jobs` frame), `touch` (`lib/store.js:159`), and the assistant sentry
(`lib/assistant.js:508`, `settings.seconds` default 5).

## 4. Ranked

Ranked by whether the candidate explains **both** halves of the report: one write moving every console at the same
instant, on a 7-15 s beat.

### 1. `reorderProjects` re-appending every open section (S1) — top candidate

`public/app.js:11540`. `reorderProjects` pins an open project's *slot* and a folder's *slot*, then re-appends every
element of the list anyway:

```js
for (const el of want) body.appendChild(el);          // :11576 — sections, including the pinned open one
...
if (!wantGroups.every((g, i) => g === groups[i])) for (const g of wantGroups) host.appendChild(g);  // :11603
```

`appendChild` on a node that is already in the tree is a move: the section leaves the document and comes back, and
every card, every `<pre class="job-out">` and every `<pre class="think-body">` inside it goes with it. It is the only
write on this list that is **global** (one call per folder in one synchronous tick, from one place) and has **no
scroll restore at all** on its path — unlike `renderProjectRows`, `placeRow` and `renderConversation`, which all put
the reader back in the same task.

The comment that promises otherwise is wrong, and that is the finding:

```js
// Folders holding an open project are skipped inside reorderProjects(), so this never moves a card being read.
//                                                                      public/app.js:14976-14979
```

A folder is not skipped; its position is pinned, and then every section in it is re-appended. Measured against the
code, the only thing an open project is protected from is *its own rank change*, not from the re-append that a
neighbour's rank change triggers.

- **Period.** The clock is `reorderSeconds()`, default 5 s (`:14981`, `:14997`) and reader-settable 0-600. The *hop*
  needs a folder whose project order actually moved; the ranking is a smoothed sliding average that moves a place at a
  time, so the visible event lands on some ticks and not others — a 5 s clock read as a 7-15 s beat. It also fires off
  the clock, from `queueReorderProjects` (`:12399`) after every row batch, which the 5 s liveness pass produces.
- **Fingerprint.** Every open console in every *expanded* project at once, in different folders, whether or not its
  own rank moved. The console nodes survive — a MutationObserver on the console itself sees nothing, because the move
  happens at `section.project` / `section.root-group`. Content height does not change. A **pinned** box is back on its
  newest line within one 400 ms tick; a box the reader had scrolled up **stays at the top**. A section that moved also
  flashes (`flashMoved`, `:11577`), which is the cheapest external evidence there is; a folder that moved (`:11603`)
  does not flash, so the flash may or may not be there — its presence only tells you which list moved.
- **What kills it.** A board where nothing re-ranks (one project per folder, or reorder set to 0) should stop hopping.

### 2. `renderAll` rebuilding the whole board with no card reuse (S2)

`public/app.js:12717-12746`, and the reason it is a *replacement* and not a move: `state.detailEls.clear()` at
`:12779` runs before `renderProjectRows` at `:12783`, so `fillAgentSlots`' reuse map is empty and every card is built
from `conversationHtml` — new console nodes, all at 0. `settleScrolls` (`:12694`) is the only thing that follows, two
frames later.

- **Period.** None. `applySnapshot` only takes this branch when the *set* of projects changed or no section exists
  (`:12901`); otherwise it takes the per-project path (S4). So it is the best explanation for a one-off "whole board
  jumped" and cannot explain a beat.
- **Fingerprint.** All consoles at once, **new nodes** (each card's `data-sig` is re-stamped, every copy button is
  remounted, any selection inside a readout is lost even though it is restored). Every card's `_selfTop` resets to
  null. Parked consoles come back to their remembered line *if* `state.outScrolls` has one for them — i.e. if the
  reader had scrolled that box themselves since load (`public/app.js:14791`) — and stay at the top if not.
- **Separates from #1 by:** node identity, and by the fact that it fires with `section.project` nodes **new**, not the
  same ones re-inserted.

### 3. `renderJobs` rewriting `#jobs` (S3)

`public/app.js:7071`. Guarded since 0.32.6 by the list signature (`:7054-7056`), so a snapshot that changes nothing a
card draws no longer replaces the node the run's own stream is writing into. Still replaces every unattached card when
a signature does move.

- **Period.** A `jobs`/`job` frame that moves one of `conversationSignature`'s terms (`:7185-7260`: status, run id,
  title, approvals, questions, pinned, page, collapsed, …). Not a clock.
- **Fingerprint.** Only the cards in the Agents panel — never a worktree row's card, and never "different projects".
  New nodes, all at once, restored same-task (`:7082`, `:7092`). If the report were really about `#jobs` the reader would
  be describing one panel, not cards in different projects.

### 4. `applySnapshot` → per-project `renderProjectRows` (S4)

`public/app.js:12910-12914`. One snapshot, every project's tbody rebuilt in one synchronous loop. But the live cards
are **moved** into the new detail (`fillAgentSlots`, `:12662`, `:10857`) and the scroll is put back in the same task
from the pre-swap capture (`:12692`), so a frame is never painted at 0 unless the capture or a reuse miss leaves a
console out. Parked positions *are* captured (`captureScrolls` reads every `pre.job-out`, `:6958-6969`).

- **Period.** Snapshot frames: `/api/state` on `resync()` (30 s net, `:14963`, now quiet while frames arrive), and the
  server's writes that broadcast one. Not 7-15 s.
- **Fingerprint.** All consoles in all expanded projects, node identity **kept** (cards moved), content height
  unchanged, no visible hop; if a hop *is* visible, look for a console missing from `prevScrolls` (a card whose
  `data-out` changed, or one that was rebuilt by another path in the same tick).

### 5. `sweepStaleBoard` re-attaching details (S5)

`public/app.js:10777`, move at `:10807`. Runs after every render that asks for it, and moves every detail that no
longer follows its row — with no scroll restore.

- **Fingerprint.** Only details whose row moved (a re-rank, a row that arrived, a stray copy removed); the console
  nodes survive; content height unchanged; a parked console stuck at the top, pinned recovered in ≤400 ms. It is the
  same *class* as #1 but scoped to the rows that actually moved. Because `reorder` and `placeRow` re-insert a detail
  directly after its row, this pass usually finds nothing to move.
- **Separates from #1 by:** which sections are involved — one project's re-ranked rows, not every open project.

### 6. `reorder` and `reorderAgentCards` (S6, S7)

`public/app.js:12278` (append `:12327`) and `:10167`. Both re-append/move whole subtrees full of consoles and restore
nothing but typing and selection. Both are guarded by Stabilize-while-reading, **on by default** (`:12214-12220`):
`reorder` returns when the project has any expanded row (`:12282`, `projectHasOpenRow`), and `reorderAgentCards`
returns when any card in the row is not minimized (`:10160`, `rowHasOpenCard` = "a card that is not in
`collapsedJobs`"). With a console on screen, both are inert.

- **Fingerprint.** Only with Stabilize switched off: one project's rows (all of them) or one detail's cards, no
  restore, order visibly changes, parked consoles stuck at the top.
- **Separates from #1 by:** the Stabilize setting. Turn it off and this gets worse; #1 does not care.

### 7. `renderConversation` (S8)

`public/app.js:7395-7450`. One card, when its signature moved; the restore is in the same task and `settleScrolls`
follows. This is the path `tools/verify-console-flicker.mjs` check 6 already drives with a parked console, and it
holds: an approval arriving mid-turn rebuilds the card and hands the reader the same line at the same place.

- **Fingerprint.** One card, new node, selection lost then restored, parked line kept. Never the whole board.
- **The one 5-15 s route into it:** a subagent live-flip at `:3746` (5 s roster) or a title landing at
  `:7224` (10 s sweep) — both per card, both rare per card.

### 8. The `project` SSE frame (S9)

`public/core/sse.js:61-121`. Replaces one project's section outright (`:96`) and then rebuilds its rows with the old
row nodes put straight back (`:101`) before anything measures. One project at a time, as its summary changes.

- **Fingerprint.** One project's consoles; the section is a new node; the rows are the old ones; a hop would show as a
  missing capture, not as a global event.

### 9. `placeRow` (S10)

`public/app.js:12405-12518`. Every `row` frame, batched to one rAF, rebuilds one detail and moves its cards, restoring
in the same task from the pre-move capture. This is the path the 5 s liveness pass pushes through, and it is the
reason the pass is worth listing at all — but it is also the best-protected path in the file.

- **Fingerprint.** One row's consoles; nodes kept; no visible hop; the row may flash (only when `flash` is set, never
  for `livenessOnly`, `public/core/sse.js:59`).

### 10. `renderRoot` / `pinOpenProjects` (S11)

`public/app.js:633-656`, `:11495-11515`. A folder's All/7d toggle or a re-rank rebuilds the whole folder with new
rows (cards rebuilt, not reused). One folder, on a click or a filter change.

### 11. The assistant float (S12)

`public/assistant.js:714-751`. Its own card, its own body; `pinChatToBottom` (`:242-252`) writes the body's
`scrollTop` directly. Not a board console, and it cannot be "in different projects".

### 12. `syncStreamConsole` / `paintStreamConsole` (inside one console)

`public/app.js:6477-6547` (keyed patch, `out.replaceChildren(...next)` only when the box had no children at all,
`:6505`) and `:6549-6558`. This is the one console the reader is watching, patched row by row; `0` replacements was
measured in `docs/jitter-synthesis.md`. It cannot move a box above it, let alone another project's.

### 13. `paintThink` (in place since 0.32.6)

`public/app.js:6655`, with `el.replaceWith(fresh)` at `:6668` kept only as the fallback for a shape it cannot patch.
Per card, per poll, and it restores its own body (`restoreThinkBody`, `:6938`). The 1.2 s thinking sweep no longer
replaces a block, so it no longer has a scroll to lose.

## 5. Fingerprints, side by side

| candidate | which boxes | console node identity | content height | pinned box | parked box | correlates with |
| --- | --- | --- | --- | --- | --- | --- |
| 1 `reorderProjects` | all open, all folders | **kept** (moved with the section) | unchanged | back in ≤400 ms | **stuck at top** | a green/grey flash on rows or project bars |
| 2 `renderAll` | all open, all projects | **new** | unchanged-to-short | back in ~2 frames | back to `outScrolls`, else stuck | a snapshot that changed the project set |
| 3 `renderJobs` | `#jobs` only | new | unchanged | same-task (invisible) | same-task (invisible) | a card signature moving |
| 4 `renderProjectRows` | all expanded projects | kept | unchanged | same-task | same-task | a `snapshot` frame |
| 5 `sweepStaleBoard` | details that moved | kept | unchanged | ≤400 ms | stuck | a row that changed place |
| 6 `reorder`/`reorderAgentCards` | one project / one detail | kept | unchanged | ≤400 ms | stuck | Stabilize **off** |
| 7 `renderConversation` | one card | new | unchanged | same-task | same-task | that card's status/approval/title |
| 8 `project` frame | one project | new section, old rows | unchanged | same-task | same-task | a project summary change |
| 9 `placeRow` | one row | kept | unchanged | same-task | same-task | a `row` frame |
| 12/pacer | one console, inside | kept | grows | follows | untouched | tokens arriving |

Two numbers make the table decisive and neither is in the app today:

1. **`scrollTop` against `_selfTop`** (`public/app.js:6903`, `:6907-6913`). The panel stamps every write it makes. A
   frame in which many boxes read `scrollTop === 0` while `_selfTop` is still the old value is proof the browser did
   it, not the code — and then the question is only *which node moved*.
2. **Node identity per frame.** A page-level `MutationObserver` over `#projects` and `#jobs` that records, for
   `section.project`, `section.root-group`, `tr.row`, `tr.detail`, `.job` and `pre.job-out`, whether the removed node
   *came back* (a move) or a different node arrived (a replacement). #1 and #5 read "the section came back, the console
   never left"; #2 and #3 read "the card is new"; #4 and #9 read "the detail is new, the card came back".

## 6. What 0.32.6 already changed (`e1bdb0e`, `docs/jitter-synthesis.md` §7)

- `paintThink` patches the `<details>` it already has, keyed by `data-lid`; a poll rewrites the summary count and the
  text that moved and nothing else. The block no longer loses its node (or its scroll) every 1.2 s, so mechanism #2 of
  the jitter note is gone and #13 above is a per-card fallback only.
- `jobline` stamps `state.lastEventAt` (`public/core/sse.js:129-137`). Before that, a card writing seven lines a second
  read stale to the 30 s net, which then called `resync()` → `applySnapshot` → every card rebuilt on a live stream
  (measured: 29 then 43 rows at once, twice a minute). That is the mechanism that *looked* like this report, and it is
  now closed unless the board is genuinely silent for 20 s.
- The rule behind that net lives in `public/core/liveness.js` (20 s quiet, plus a closed socket), so both halves are
  testable (`test/liveness.test.js`).
- `renderJobs` refuses to rewrite `#jobs` when neither the set of cards nor any card's signature moved
  (`public/app.js:7054-7056`) — so a snapshot that changes nothing a card draws can no longer replace the node the
  stream is writing into.

What is **left** after those four: every path in §1 that *moves* a subtree full of consoles without restoring them
(S1, S5, S6, S7), and the one path that rebuilds the board without reusing a card (S2). The 30 s rebuild is no longer
part of the answer at default settings — which is exactly why the report's period went from "twice a minute" to
"7-15 s".

## 7. The measurement that separates them

`tools/verify-console-flicker.mjs` already samples, per painted change, `Math.round(out.scrollTop)`, the room below it
and `consolePinned(...)` (`:432`), and it already runs a MutationObserver over the console (`:417`). Two additions make
it answer this note:

1. Observe `#projects` and `#jobs` (not the console) with `{ childList: true, subtree: true }`, and for every
   `removedNodes` record keep the node; when the same node reappears in `addedNodes` in the same or the next batch,
   count a **move** of that selector; a `addedNodes` node with a different identity is a **replacement**.
2. `setScroll` already stamps `el._selfTop = v` (`public/app.js:6907-6913`). Record, per frame, every `pre.job-out`
   whose `scrollTop` is 0 while `_selfTop` is not. The count of those boxes in one frame *is* the hop.

The decision, in order:

| what the capture shows | candidate |
| --- | --- |
| the hop's frame carries a move of `section.project` / `section.root-group`, console nodes kept, every open project at once | **1** |
| the hop's frame carries a replacement of every `.job`, `section.project` new, `_selfTop` cleared on all of them | 2 |
| only `#jobs` cards are new | 3 |
| the detail is new but the `.job` nodes came back, and one console is missing from the restore | 4 / 9 |
| the detail is new and the move is scoped to the rows that re-ranked | 5 |
| the hop stops when `wm.reorderSeconds` is 0 | the reorder family (1, 5, 6); Stabilize then decides between 1 and 6 |
| turning Stabilize **off** makes it worse, or leaves it unchanged | worse → 6 is in play; unchanged → 1 |
| the hop survives a board with one project per folder and reorder at 0 | none of 1/5/6 — go to 2/3/4 |

Two read-only experiments settle most of it before any instrumentation:

- **Set the reorder clock to 0** (Settings → the reorder seconds field, `wm.reorderSeconds`). If the hop stops, the
  answer is in the reorder family (1, 5, 6) and not in a snapshot path (2, 3, 4).
- **Leave one console parked** (scrolled up, no input for >1.2 s, so it is unpinned at `:14790`). If it jumps to the
  top and **stays** there, the path that did it has no restore — 1, 5 or 6. If it comes back to the parked line, it was
  2, 4, 7 or 9, all of which restore.

## 8. Open, and honestly unresolved here

- **Whether a detach/attach actually drops `scrollTop`.** The three candidates 1, 5 and 6 rest on it, and the tree's
  own behaviour is the best evidence for it: `renderProjectRows` restores every console after `fillAgentSlots`
  (`:12692`), `placeRow` captures before the move and restores after (`:12516`), and `reorder`'s comment says
  "Re-appending a detail takes its cards out of the DOM on the way" (`:12283`) — three separate paths pay for a restore
  after a move, and none of them is a no-op. If the browser instead keeps the offset across a same-task move, 1, 5 and
  6 collapse to zero and the ranking becomes 2 → 4 → 3, and this note's top candidate is wrong.
- **Why 7-15 s and not 5 s.** The reorder clock is 5 s; the hop needs an order change, which a smoothed ranking does
  not produce every tick. That is an explanation, not a measurement — the capture in §7 timestamps the hop, and the
  gap between two hops is the number to compare against the clock.
- **Whether the reader had Stabilize on.** If they turned it off, 6 is back in play for every project, and 1's
  section-level re-append is no longer the only candidate in the reorder family.
