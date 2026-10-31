# The console's scroll hop: one re-append of every project section, on the reorder clock

The symptom: every open console's scrollbar snaps to the top of its box and is back within a split second, on every
open card at the same instant, across projects. The cause is shared, and this note names it from a measurement rather
than from the source.

**The answer.** `reorderProjects()` re-appends **every** `section.project` of a folder whenever the ranked order of that
folder has moved:

```js
for (const el of want) body.appendChild(el);        // public/app.js:11576, inside reorderProjects()
```

Appending a node that is already in the document is a remove-then-insert. The section — and with it every card, every
`pre.job-out` and every `.think-body` inside it — leaves the layout tree and comes back as a fresh scroll area at
`scrollTop = 0`. The loop re-appends the sections the reader has **open** as well as the closed ones, in one synchronous
task, so every open console is reset in the same frame. Nothing in `reorderProjects()` restores a console's scroll
position (it restores the caret, the inline add-agent field and the text selection, and nothing else); the box is put
back by whichever of three existing "stay at the bottom" paths fires first:

- `drawJobLine()` (`public/app.js:7550`, its `setScroll` at `:7642`) — the next line the run appends, 4–138 ms later;
- `paintTypedLines()` (`public/app.js:6315`, the `setScroll` at `:6334`) — the next paced word, 6–35 ms later;
- `stickConsole()` (`public/app.js:6951`, called by the 400 ms sweep registered at `public/app.js:14798`) — the only
  repair for a card that is not writing; measured **184–376 ms** at the top, which is the "split second" the reader
  sees.

Of the 17 hops in §3, 8 were repaired by `paintTypedLines`, 6 by `drawJobLine`, 2 by `stickConsole`, and 1 (at the end
of the window) had no repair inside the 600 ms the capture looked ahead.

**What fires on the beat.** `tickLivenessRanks()` (`public/app.js:10126`, the `reorderProjects()` call is `:10136`), on
the reorder clock:

```js
state.reorderTimer = every > 0 ? setInterval(() => { … tickLivenessRanks(); }, every * 1000) : null;   // public/app.js:14997
```

`every` is `wm.reorderSeconds`, default **5** (`REORDER_DEFAULT`, `public/app.js:14981`; the reader can set 0–600 s in
Settings > Board). The hop therefore lands on the clock tick at which a section actually moves, not on every tick: the
measured intervals between hops are whole multiples of the clock (5, 10, 15, 20, 27 s), averaging **9.5 s** — the
"every 7–15 seconds" the reader reported. On their board it is whichever of their `wm.reorderSeconds` ticks the ranking
crosses on.

Measured 2026-10-31 on `e1bdb0e` (0.32.6), two cards in two different projects streaming at once, sandbox panel of its
own on a spare port. The panel on 7331 was never restarted, written to, or driven by this run.

## 1. What was instrumented

`tools/measure-console-scroll-hop.mjs` starts its own panel (`tools/panel-testkit.mjs`: spare port, own
`PANEL_CONFIG`/`HERMES_HOME`/caches, `API_SERVER_KEY` empty), makes six projects, spawns a run in **two** of them
(`alpha` and `beta`) with `existing: true` so each card is owned by its own project's main row, and opens **both**
projects and **both** rows. The four other projects stay closed; a 4 s driver touches a file in one of them so their
liveness — and therefore the folder's ranking — keeps moving, which is the ordinary condition on a board of a hundred
repos.

Both runs stream one fixed reply over a stub Runs API (two words every 75 ms), so both consoles are growing and
overflowing their 318 px box for the whole window.

Recorded page-side, all on one `performance.now()` origin:

| what | how |
| --- | --- |
| every `scrollTop` write | `setScroll` wrapped: from, asked, landed, `scrollHeight`/`clientHeight` at that instant, caller stack |
| every scroll event on a console | capture listener: `top`, `max`, `scrollHeight`, `clientHeight`, node id |
| what a frame can paint | a `requestAnimationFrame` sampler: each `pre.job-out` / `.think-body`'s `top`/`max`, recorded when either changes |
| every DOM move that carries a console | `insertBefore`/`appendChild`/`after`/`before`/`append`/`replaceWith`/`replaceChildren`/`remove` wrapped, filtered to a subtree containing a `pre.job-out`, with the caller stack; plus a MutationObserver for `innerHTML` rebuilds, which call none of those |
| the page's own entry points | `placeRow`, `renderProjectRows`, `renderJobs`, `renderConversation`, `applySnapshot`, `renderAll`, `reorder`, `reorderProjects` (with the section order before/after), `tickLivenessRanks`, `sweepStaleBoard`, `settleScrolls`, `restoreScrolls`, `applyStoredScrolls`, `stickConsole`, `updateJob`, `appendJobLine`, `drawJobLine`, `paintTypedLines`, `paintThink`, `loadThinking`, `captureScrolls` (with its result) |
| every timer | `setInterval`/`setTimeout` shadowed before `app.js` parses: the delay, the scheduling stack, and every firing |

```
node tools/measure-console-scroll-hop.mjs --seconds 150 --json <path>                     # clock on (the page's default)
node tools/measure-console-scroll-hop.mjs --seconds 150 --json <path> --reorder-seconds 0 # the control: clock stopped
```

## 2. One hop, to the millisecond

The quoted run's second hop (the two cards are `5632f8db` and `547f914e`; both consoles are in row details, in `alpha`
and `beta`):

```
80241.6  reorderProjects()                       <- tickLivenessRanks (app.js:10136), the 5 s clock
80242.1  appendChild  <section class="project">  carrying console 5632f8db  (app.js:11576)
80242.4  appendChild  <section class="project">  carrying console 547f914e  (app.js:11576)
80249.7  reorderProjects: moved=2, order alpha,beta,zeta,gamma,epsilon,delta, consoles in the moved sections: 2
80251.8  FRAME  5632f8db  top=0  (max 6909)     <- the hop, painted
80251.8  FRAME  547f914e  top=0  (max 5718)     <- both cards, the same frame
80284.2  setScroll(5632f8db)  from 0 -> 6926    <- paintTypedLines (app.js:6334)
80284.2  setScroll(547f914e)  from 0 -> 5736
80285.3  FRAME  5632f8db  top=6926  (max 6926)  <- back at the bottom, 33.5 ms after the top
```

The `appendChild` is the whole cause: the console is the same node before and after (node id 1/2 in the frame record,
`conn=true` the whole time), but it is detached and re-inserted, so its scroll offset is gone. Nothing writes 0 — the
browser's re-layout of the re-inserted box does. That is why an audit of `setScroll` alone finds nothing.

The 400 ms sweep is the second half of the pair, and on a card with no stream behind it, it is the only half:

```
100260  reorderProjects() → 2 sections re-appended (moved=2)
100269.1  FRAME 5632f8db top=0 (max 11325), 547f914e top=0 (max 10117)
100644.7  setScroll(5632f8db) 0 -> 11325, setScroll(547f914e) 0 -> 10117   <- stickConsole (app.js:6955, from the 400 ms sweep)
100650.4  FRAME 5632f8db top=11325, 547f914e top=10117                     <- 381.3 ms at the top
```

## 3. The beat

The capture runs 205 s; the 17 hops fall between 52.7 s and 205.3 s (152.5 s), once both consoles are overflowing and the
folder's ranking has started moving. Both cards' consoles are at the top in the **same frame** at every one of them (the
frame record is one row per changed box, and the two rows carry the identical timestamp):

| instant (ms) | boxes at the top, their `max` | back at (px) | back after |
| --- | --- | --- | --- |
| 52762 | 768 | 664 | +5.3 ms |
| 80252 | 6909 / 5718 | 6926 / 5736 | +33.6 ms |
| 85252 | 7978 / 6805 | 7978 / 6805 | +200.7 ms |
| 95251 | 10221 / 8996 | 10221 / 8996 | +17.2 ms |
| 100269 | 11325 / 10117 | 11325 / 10117 | +381.3 ms |
| 120259 | 15654 / 14637 | 15672 / 14637 | +25.3 ms |
| 125251 | 16689 / 15689 | 16707 / 15706 | +17.5 ms |
| 140252 | 19035 | 19053 | +31.0 ms |
| 145251 | 20743 / 19708 | 20743 / 19708 | +15.4 ms |
| 150257 | 21916 / 21192 | 21916 / 21192 | +42.9 ms |
| 160256 | 24159 / 23434 | 24159 / 23451 | +26.1 ms |
| 165251 | 25176 / 24452 | 25194 / 24452 | +14.3 ms |
| 170253 | 26298 / 25573 | 26315 / 25590 | +28.5 ms |
| 175266 | 27384 / 26643 | 27384 / 26643 | +182.2 ms |
| 195265 | 31300 | 31300 | +198.2 ms |
| 200263 | 31300 / 32180 | 31300 / 32197 | +384.1 ms |
| 205266 | 31300 / 32594 | (window ended) | — |

Gaps between instants: `27490, 5000, 9999, 5018, 19990, 4992, 15001, 4999, 5006, 9999, 4995, 5002, 5013, 19999, 4998,
5003` ms — every one a multiple of the 5 s clock, **mean 9532 ms**.

Attribution, per hop: a `reorderProjects()` that re-appended a section 6–10 ms before the frame, from `tickLivenessRanks`
on 24 of the 26 section-moving calls; the other two came from an owner change in `updateJob` and from `applySnapshot`. No
hop coincides with a `placeRow`, `renderProjectRows`, `renderJobs`, `applySnapshot` or `renderAll`; see §5.

**The control.** The same command with the reorder clock stopped (`--reorder-seconds 0`) leaves 7 instants in 173 s
(mean gap 25 s, gaps `1.8, 3.6, 8.3, 23, 34, 46 s`), and its 16 section-moving calls all come from
`queueReorderProjects()`'s flush — the row-event path — instead of the clock. So the *line* is the reset in both runs, and
the clock is what turns it into a regular beat.

Every interval that fired in the 205 s window, so the beat can be read against the page's own clocks:

| period | fires | source |
| --- | --- | --- |
| 250 ms | 820 | `applyPendingFocus`, app.js:7491 |
| 400 ms | 512 | the sticky sweep, app.js:14798 |
| 1000 ms | 205 each (5 intervals) | live clocks 1193, approvals 6022, page furniture 14884, question clocks 16784, assistant.js:1857 |
| 1200 ms | 170 | `sweepThinking`, app.js:3842 |
| 3000 ms | 68 (2 intervals) | tool-store sweep 1683, visibility 16881 |
| **5000 ms** | **41** | **the reorder clock, app.js:14997** (and subagent roster 3815, visibility force 16882) |
| 15000 ms | 13 | the assistant's message board, assistant.js:1864 |
| 30000 ms | 6 (2 intervals) | the liveness safety net 14963, update check |

There is no timer with a 7–15 s period. The only 5 s timer that touches the DOM's structure is the reorder clock, and the
hop's gaps are that clock's ticks.

## 4. Why it hits every open card at once, across projects

`reorderProjects()` works on whole sections. Its guard is "did the order change at all":

```js
if (want.every((el, i) => el === sections[i])) continue;   // public/app.js:11575
for (const el of want) body.appendChild(el);               // public/app.js:11576
```

When one *closed* project changes rank — a scan finds an edit in it, an agent finishes in another folder, a worktree
comes alive — `want` differs from `sections` at that one index, and the loop re-appends **all** of them, open sections
included. One call therefore detaches every card on the board that is in that folder, in one task: the same frame paints
every open console at 0. That is the "all open cards at the same time, across different projects" in the report — it is
one loop, not one per card.

The folder loop two dozen lines below is the same shape one level up (`public/app.js:11603`,
`for (const g of wantGroups) host.appendChild(g)`), and `pinOpenProjects()` (`public/app.js:11496`, its `appendChild` at `:11514`) has it inside
`renderAll`. On the sandbox the section loop is the one that fired; on a board with several scan roots both can.

`overflow-anchor: none` on `.job` and `.job-out` (`public/style.css:660`, `:968`) means the browser is explicitly not
allowed to absorb the move by adjusting the scroll position, so the clamp is the position the next frame paints.

## 5. What was ruled out, with the same capture

- **`setScroll` is not the resetter.** 7498 `setScroll` writes in the window, **0** of them backwards (from > to). The
  writes near a hop go `0 -> max`, i.e. they are the *repair*. An audit of the writers alone sees a healthy console.
- **`renderJobs` / `applySnapshot` are not on this beat.** `renderJobs` ran 6 times, `applySnapshot` twice (both from
  the SSE `snapshot` frame at 43.8 s and 47.5 s, neither coincident with a hop), `renderAll` once (the setup). The hop
  instants line up with `reorderProjects`, not with these.
- **`placeRow` / `renderProjectRows` are not it either.** 299 `placeRow` and 21 `renderProjectRows` calls in the same
  window replace row details and re-place cards (95 `replaceWith` of a card node), and each one restores the console in
  the same task (`restoreScrolls` -> `applyStoredScrolls` -> `settleScrolls`, 95 of each) — none of them left a box at 0
  for a frame. They are the *quiet* rebuild: the card leaves and comes back at its own position before the next paint.
  They are not the repair path for a hop either; the three writers named at the top are.
- **The browser's own anchoring is off.** `.job`/`.job-out` carry `overflow-anchor: none`, so a move cannot be silently
  compensated; this is why the clamp is visible rather than absorbed.
- **CSS is not involved.** No transition or animation on a console surface (the same reading as
  `docs/jitter-synthesis.md` §1); the frame record shows the position change between two adjacent frames with no
  intermediate value.

**One observation from the live panel (read-only).** A separate probe of `http://127.0.0.1:7331` with two rows open,
80 s, recorded `restoreScrolls` writing 0 to the sales-service card's console at 52326 ms, 28 ms after a
`reorderProjects()` had re-appended that section at 52298 ms, with `applyStoredScrolls` putting it back 1 ms later. The
live panel produces the same capture-after-move signature; the sandbox is where it can be driven to a painted frame on
demand.

## 6. What this does not prove

- The sandbox has six projects and one folder; the reader's board has 105 across several scan roots. The mechanism is
  per-folder, and the *rate* of section moves grows with the number of projects whose liveness crosses, which is why
  their beat is 7–15 s and the sandbox's mean is 9.5 s.
- `wm.reorderSeconds` is per browser. The measurement used the page's default (5 s) and the reader's own value was not
  readable from this run; a reader at 10 s would see the same hop on a 10 s grid.
- Frames were sampled by `requestAnimationFrame`, which is the paint clock of the tab under test (headless Chromium
  here). The console was never at 0 and back within one frame in any capture — every hop is a value a frame actually
  painted, and each one is a full frame at the top, not a transient read inside a rebuild.
- The diagnosis in §1–§6 was made without changing any file; the fix in §7 changed `public/app.js` only.

## 7. The fix, and what it measures

The line had two properties that made the hop: it re-appended sections that did **not** move, and it left the scroll
position of the boxes inside them to the next repair. Both are gone:

1. **`placeInOrder(parent, want)`** (`public/app.js`) walks the ranked list backwards and only calls `insertBefore` for
   an element whose next sibling is not already the one the order asks for. An element that is in its slot is never
   touched, so the whole remove-then-insert disappears for the common case. `reorderProjects()` uses it for the sections
   *and* the folders (a folder move was the same fault one level up), and `reorder()` uses it for a project's rows.
   Because `order()` pins an open project into its own index, an open section is never out of place — the console inside
   it is no longer detached by a re-rank it did not take part in, which is exactly the "two consoles that are being
   written to at the same time" report: the move was about a closed third project's rank.
2. **`holdScrolls(root)` / `releaseScrolls(held)`** read every `pre.job-out`, `.think-body` and `.sub-console` in the
   subtree *before* the first move and put each one back in the same task, so the cases where something genuinely has to
   move (a section appearing or going away, a detail following its re-ranked row in `sweepStaleBoard()`, a project whose
   `wm.stabilize` is off) no longer wait 4–376 ms for the next line or the 400 ms sweep. Reading after the move was the
   other half of the bug: a capture taken after a move reads 0 and becomes a real write to 0.
3. **`renderAll()` no longer clears `state.detailEls`** before it rebuilds the board. That map is what `renderProjectRows()`
   hands to `fillAgentSlots()` so a rebuild reuses the cards (a *move* of the node, scroll included) instead of building
   new ones; clearing it made a snapshot that changed the project set rebuild every card from scratch, which was the one
   remaining painted hop.

Measured on this tree with `tools/measure-console-scroll-hop.mjs --seconds 80` (two cards in two projects streaming at
once, six projects, four of them moving on the file-touch clock):

| build | painted hop instants | consoles at 0 on an instant | reorderProjects calls that changed an order |
| --- | --- | --- | --- |
| before (`72c3b93^`) | **9** in 80 s | 2 (both) on 8 of them | 12 (10 `tickLivenessRanks`, 2 `applySnapshot`) |
| after | **0** | — | 15–16 (the ranking still moves; the sections it moves are the closed ones) |
| after (second run) | **0** | — | 15 |

The tool now exits non-zero when it sees a painted hop, so a regression is a red run rather than a number in a report:

```
node tools/measure-console-scroll-hop.mjs --seconds 80
```

## 8. The gate across layouts, and what the layouts say about "only with two consoles"

`tools/measure-console-scroll-hop.mjs` draws one layout (two projects). `tools/verify-console-independence.mjs` asks the
same question in the five layouts a board really has, and refuses to pass a run that measured nothing:

| layout | what it draws |
| --- | --- |
| `one` | a single streaming console |
| `siblings` | two consoles in two sibling worktree rows of ONE project - the reader's board (four sessions, one repo) |
| `projects` | two consoles in two projects of one folder |
| `folders` | two consoles in one project while two OTHER folders swap rank (the folder loop of `reorderProjects()`) |
| `cards` | two live cards in ONE worktree row that swap places, with Stabilize reordering off - the one setting under which the panel may move an OPEN card |

Each plays plain text into the consoles over a stub Runs API, drives the churn (a file touched in a closed project every
4 s, so the ranking really moves), samples every frame with `requestAnimationFrame` and asserts zero painted hops. It
also needs every console to overflow, the ranking to move a section or a folder at least three times in the window, and
a raw re-append of an open section to reset a console in THIS browser - otherwise it exits 2, because a clean run on a
browser that cannot show the fault proves nothing. On an export of `e965d65` (before the fix) it is red in all four
(6, 11, 16 and 10 painted hops in its 40-45 s windows, every one a `reorderProjects | appendChild` on a
`section.project` or `section.root-group`); on `918b44c` (the fix as it landed) those four are green with the ranking
moving 9-13 sections and 8 folders in the window.

The fifth layout found what the landed fix had not reached. `cards` forces the swap (the page's stored order of a row's
cards is flipped every 4 s and its own `reorderAgentCards()` acts on it, because a stub pair never crosses the ranking's
margin and a real pair does) and was **red on `918b44c`: 6 painted hops in 40 s, 2 of its 4 hop frames with both
consoles at the top, every one `reorderAgentCards | insertBefore | div.job`** over 10 card swaps. With Stabilize
reordering off the row's cards are re-ranked on every clock tick, and it re-inserted every card before the first
non-card child, which detaches ALL of them even when only one swapped - the one mover that was still a raw loop. It now
orders with `placeInOrder()` and holds and releases the boxes like the others: 0 hops over 9 swaps, same window, same
sensitivity check (a raw re-append took a console from 785 to 0).

```
node tools/verify-console-independence.mjs                              # this checkout: five layouts, ~9 min
node tools/verify-console-independence.mjs --root <export of e965d65>   # the build before the fix: red
node tools/verify-console-independence.mjs --only siblings --seconds 90 # one layout, a longer window
```

**One console against two.** The same recorder, 75 s windows from the moment every console overflowed, the same churn,
on `e965d65` before the fix:

| layout | churn | painted hops | hop frames carrying both consoles |
| --- | --- | --- | --- |
| one console | on | 12 | - |
| two consoles, two projects | on | 19 | 9 of 10 |
| two consoles, two sibling worktree rows of one project | on | 24 | 11 of 13 |
| two cards in one worktree row | on | 24 | 11 of 13 |
| two sibling rows, the page's reorder clock stopped (`wm.reorderSeconds` 0) | on | 15 | 6 of 9 |
| one console | off | 0 | - |
| two sibling rows | off | 0 | - |

All 94 of those hops are the same `reorderProjects | appendChild | section.project`; with the churn off (the ranking never
moves) neither one console nor two ever hopped, and with the page's own reorder clock stopped the hops continued on the
row-event path (`queueReorderProjects`), so it is the re-rank, not the clock. The same runs on the fix: 0 in every row.

`test/console-independence.test.js` is the part that needs no browser. It reads `placeInOrder()`, `holdScrolls()` and
`releaseScrolls()` out of `public/app.js` and runs them over a small model that has the one browser rule behind the
fault (an attached node that is inserted is removed first, and every scroll box inside it comes back at 0): a list
already in order detaches nothing, two items that trade places detach one, any permutation ends in the wanted order, a
moved console comes back on its newest line (or on the reader's line) in the same task and, without the release, at 0.
It also fails when `reorderProjects()`, `reorder()`, `sweepStaleBoard()` or `reorderAgentCards()` stops holding and
releasing the boxes it moves, or goes back to a raw `appendChild`/`insertBefore`.

A single console hops as often as each of two does (12 in the one-console run, 12 per console in the sibling-row runs),
so the cause does not depend on how many consoles are open: it depends on the folder's ranking moving. What a second
console changes is what the reader SEES. One `appendChild` of the sections resets every open console in the same frame
(11 of the 13 hop frames carried both), so the two boxes jump together and come back together, which reads as something
switching between them, not as one box blinking. The cause was never two consoles competing for a writer: it was one
shared write that did not look at the consoles at all.
