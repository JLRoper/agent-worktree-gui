# The console's expanded size is not held, because it was never a size

An expanded agent console does not hold its expanded size. This note reproduces that on this tree and names the
causes. **No product file was changed** — `public/app.js` was read, not edited (two other workers hold it), and the
measurements come from a sandbox panel serving this worktree.

| | |
| --- | --- |
| base | `f56691a` (`0.34.3`), `wtgui/find-the-bugs-behind-one-543347` |
| produced | this note; a sandbox probe and its raw numbers (`measurements.json`) kept outside the repo |
| reproduced | all five triggers named in the brief, plus the gesture itself, on Chromium at 1600x1000 |
| did not touch | `public/app.js`, `public/style.css`, `lib/*`, `server.js` — only `package.json` moves, for this PR's version |
| waiting on | whoever holds `public/app.js`: the file:line lists in §1.2 and §3 are the work |

The one thing to take from this note if you read nothing else:

> The console's expanded size lives **only** in the DOM node's `style` attribute — and on this tree the gesture that
> is supposed to create it usually creates no size at all, just `max-height: none` on a box that then grows to its
> whole 90-line transcript. Every render path that *moves* the card node keeps it (the board's re-sort, a row
> rebuild, a snapshot, the poll — measured); every path that *rebuilds* the card throws it away (a repaint, a turn
> ending, a new turn, the unattached list, a reload — measured). There is no entry in `state` for it, so nothing
> restores it, and the three places that already restore the reader's scroll, caret and selection never get the
> chance to restore this one.

---

## 1. How the size is stored and restored

### 1.1 What the gesture actually writes

`public/style.css:967-975` gives the console a cap and a native resize handle:

```
.job-out { max-height: 230px; min-height: 34px; resize: vertical; overflow: auto; … }
```

`public/app.js:13397-13408` is the only code that touches that cap: a capture-phase `pointerdown` anywhere inside
`pre.job-out` whose pointer is in the bottom-right 16px corner clears `max-height` inline.

```
13397  // The console resizes like the reply box, but its max-height is what stops it eating the card — and a
13398  // max-height also stops the drag dead. The handle lives in the bottom-right 16px corner, so grabbing
13399  // there lifts the cap first; the height the drag then writes is an inline style and wins over both.
13406      if (e.clientX >= r.right - 16 && e.clientY >= r.bottom - 16) out.style.maxHeight = "none";
```

Measured on a 90-line console in a worktree row (the reader's gesture, ten 26px steps, inline `style` read after
every step):

| step | height | computed cap | inline style |
| --- | --- | --- | --- |
| as drawn | 320px | `320px` | *(none)* |
| `pointerdown` in the corner, before any move | **1053px** | `none` | `max-height: none;` |
| after 26 / 130 / 260px of drag | 1053px | `none` | `max-height: none;` |
| after `pointerup` | 1053px | `none` | `max-height: none;` |

Three things fall out of that table, and they are the premise of everything below:

1. **The box resizes at `pointerdown`, not at `mousemove`.** The cap comes off and the console jumps from 320px to
   its full content height (1053px for 90 lines) before the pointer has moved. The corner the reader grabbed is now
   ~730px above the pointer, so the native resize has nothing left to track: **the drag is inert**, and in a real
   browser session the same drag selects text across the console instead (seen in the screenshot taken for this
   run).
2. **The gesture writes no height.** The only declaration it leaves behind is `max-height: none`. The "expanded
   size" is therefore *auto height*: the console shows the entire transcript and keeps growing with it — one more
   line took it from 1053px to 1070px in the same run.
3. **A pixel height only appears in the case it is not needed.** When the content is *shorter* than the cap (a
   fresh, empty turn: 35px), the cap lift does not move the box, the drag does track, and the console ends at
   `max-height: none; height: 295px;`. That is the one case where the reader had no reason to resize.

`public/style.css:970` calls this "agent-worktree-gui: **liftConsoleCap**". No such function exists anywhere in the
tree (`grep -rn liftConsoleCap public/` → the CSS comment only). The comment describes a resize handler that was
never written; the `pointerdown` above is what shipped, and it implements the cap lift and nothing else.

### 1.2 Every place that sets or re-applies a size

| # | site | what it does | when |
| --- | --- | --- | --- |
| 1 | `public/style.css:971` | base cap `max-height: 230px`, `min-height: 34px`, `resize: vertical` | every console |
| 2 | `public/style.css:470` | `.agents-block .job-out { max-height: 320px }` — the cap for a card under a worktree row | every row card |
| 3 | `public/style.css:2088` | `.job.maximized .job-out { max-height: none }` — a maximized card has no cap | ⤢ pressed |
| 4 | `public/style.css:3056`, `3062` | `#as-chat … .job-out { max-height: none }` — the assistant float never caps | the float |
| 5 | `public/app.js:13406` | `out.style.maxHeight = "none"` — lifts the cap on pointerdown, the only write | the corner gesture |
| 6 | the browser | writes `style.height` on a native `resize: vertical` drag | only when #5 did **not** resize the box |
| 7 | `public/app.js:2258` | the console is drawn as a bare `<pre class="job-out" data-out=…>` — no inline size, ever | every rebuild |

Nothing else touches it. There is no `state` entry, no `localStorage` key, and no re-apply step — which is the
whole bug in one sentence, because the panel *does* keep every other piece of per-console reader state:

| console state | where it lives | re-applied by |
| --- | --- | --- |
| scroll position | `state.outScrolls` (`app.js:150-152`), written at `13015-13019` | `applyStoredScrolls` (`7107-7114`), `restoreScrolls` (`7096`), `renderConversation` (`7656-7661`) |
| text zoom (Ctrl+wheel) | `state.consoleZoom` (`app.js:56`), written as the card's `--term-size` | re-emitted in the card's `style` attribute by the renderer |
| open tool bursts, calls, result boxes | `state.toolGroupOpen`, `callFolded`, `codeBoxOpen` (`188-211`) | the console renderer reads them |
| caret and selection | `captureTyping` / `captureCardSelection` | `renderConversation` (`7649-7651`), `renderJobs` (`7283-7286`) |
| **the expanded size** | **the `style` attribute of one DOM node** | **nothing** |

---

## 2. The trigger matrix

Sandbox panel (`tools/panel-testkit.mjs`, own port/config/`jobs.json`), one 90-line card under a real worktree row
and two unattached 90-line cards. Each trigger was driven through the panel's own entry point (`appendJobLine`,
`updateJob`, `applySnapshot`, `renderAll`, `renderProjectRows`, `reorderProjects`, `page.reload`) — the functions
its SSE handlers and its poll call. "node" is a probe attribute: `same` = the element survived and was moved,
`NEW` = the element was replaced (so its inline style went with it).

| trigger | driven by | before | after | node | size |
| --- | --- | --- | --- | --- | --- |
| the reader expands (content > cap) | corner drag | 320px, cap 320 | 1053px, cap none, `max-height: none` | same | **created, no height** |
| T0 a live line arrives | `appendJobLine` | 1053 | 1070 | same | **holds** (and grows) |
| T1 the card repaints | `updateJob` with a changed label | 1053 | 320, cap 320 | NEW | **lost, 733px** |
| T2 the turn ends (`running`→`done`) | `updateJob` | 1070 | 320, cap 320 | NEW | **lost, 750px** |
| T3 another turn starts | `updateJob`, new turn on the same thread | 320 | turn 1's console is **not on the page** (folded); turn 2's is new at 35px | GONE | **lost with the turn** |
| T4a the board re-sorts | `reorderProjects()` | 295 | 295 | same | **holds** (an open section is pinned — last part of §3) |
| T4b the row is rebuilt | `renderProjectRows(name)` | 555 | 555 | same | **holds** |
| T4c a snapshot repaints the board | `renderAll()` | 815 | 815 | same | **holds** |
| T4d the poll applies `/api/state` | `applySnapshot(d)` | 1075 | 1075 | same | **holds** |
| T5c/T5d two unattached agents: agent 1's turn changes | `applySnapshot` | 1053 each | 230 each, cap 230 | NEW for **both** | **lost on the untouched card too** |
| T6 the panel reloads | `page.reload()` | 1070 (set on this card earlier) | 320, cap 320 | — | **lost, 750px** |
| T7 a click in the corner, no drag | `mousedown`+`mouseup` | 230 | 1053, cap none | same | **spurious expansion** |

Row height changed as noted where the probe re-expanded the console between triggers (295/555/815/1075 are the
heights the reader's own drag had just written; each survived the trigger that followed it).

---

## 3. The causes, ranked by how often the reader hits them

Ranked by the number of the reader's own actions that land on each path, not by a sampled rate. Causes 1 and 3 are
the same mechanism (a size that lives only in a node) at two code sites that fire on different gestures; cause 2 is
why that node usually has no size in it to begin with, and cause 5 is why the height it comes back at is not even the
one it left with.

### 1. Any card rebuild — `renderConversation`, `app.js:7648` (by far the most often)

```js
7646  const holder = document.createElement("div");
7647  holder.innerHTML = conversationHtml(conv);
7648  el.replaceWith(fresh);
```

The card is rebuilt from markup whenever `conversationSignature(conv)` (`app.js:7401-7460`) differs from the node's
`data-sig`. The signature carries, among much else, every turn's `status` (`7403`), `state.turnOpen` (`7421`),
whether the reader pinned a turn (`7430`), `state.collapsedJobs` and `state.maximized` (`7450-7451`), the label and
the session title. So the console is rebuilt:

- **when a turn ends** (`running`→`done`) — once per turn, so the console the reader expanded *during* the run
  collapses at the moment the run finishes. This is the report's "it will not hold its size", almost always.
- **when a turn starts** (T3) — and the previous turn folds away with it, so there is not even a console left to
  hold a size.
- **when a turn is opened or closed** — including the newest turn's default, so folding a turn elsewhere on the
  card rebuilds the console under the reader.
- **when the card is maximized** (⤢, `7451`) — the reader's most likely moment to want the big console.
- **when a title, a label, an approval, a question, a queued reply or a page change lands** (`7437-7451`).

After the swap the code deliberately puts back the three things a rebuild destroys — the reader's scroll
(`7656-7661`), their caret (`restoreTyping`, `7650`), their selection (`7651`) — and nothing puts back the size. The console is
drawn from `app.js:2258`, a bare `<pre class="job-out" data-out=…>` with no inline size, so the fresh node returns
under whatever cap its container has.

Measured: 1053 → 320 (T1), 1070 → 320 (T2). **Lost: 733-750px, every time.**

### 2. The gesture never records a size, so there is none to hold — `app.js:13401-13408`

See §1.1. Because `max-height: none` is the whole result, (a) there is no number that *could* be remembered, and
(b) the "expanded" console is an uncapped auto-height box that shows the entire transcript and grows with every
line — so the card's reply box is pushed more than a screen down the page, which is the second half of the reader's
complaint. The drag that was supposed to choose a size selects text instead.

This is also *why* causes 1 and 3 have nothing to restore: the panel never had a size to record, only a lifted cap.

### 3. The unattached list is rebuilt for *any* card's change — `renderJobs`, `app.js:7270-7299`

```js
7270  const listSig = `${convs.map((c) => `${c.thread}:${conversationSignature(c)}`).join("|")}#${convs.length}`;
7271  const sameList = listSig === state.jobsListSig && $("jobs").querySelectorAll(":scope > .job[data-thread]").length === convs.length;
…
7287  $("jobs").innerHTML = convs.length
7288    ? convs.map(conversationHtml).join("")
…
```

The guard is a *list-wide* signature (`7270-7273`), and the rebuild it guards is `innerHTML` over the whole panel (`7287-7289`): one unattached card's status, label, title, approval or fold
state changes and **every** unattached card is re-created from markup. `applySnapshot` calls `renderJobs()`
unconditionally (`13128-13134`), so this is the poll's own path, not a rare one.

This is the "two agents writing at once" trigger, and it is not a race in the writer: `drawJobLine` appends into its
own `pre` and touches nothing else (measured — T0). It is a **shared container**: agent 1's turn ending replaces
agent 2's console node while agent 2 is still streaming and the reader is reading it.

Measured: T5d — agent 2's console, untouched by the event, 1053 → 230, new node. Note it comes back at **230**
(the `#jobs` cap) while the same console under a worktree row comes back at **320** (see cause 5).

### 4. A plain click in the corner expands the console — `app.js:13406`

The `pointerdown` handler does not wait for a drag and does not check the button. A press-and-release in the
bottom-right 16px — which overlaps the bottom end of the console's own scrollbar and the end of its last text line
— takes a capped 230px console to its full content height (measured: 230 → 1053, no movement at all). Reachable by
aiming at the scrollbar; it looks like the console "opened itself".

### 5. Three different baselines for one console — `style.css:470`, `971`, `2088`/`3056`

A console under a worktree row is capped at 320px, the same console in the unattached panel at 230px, in a
maximized card and in the assistant float at none. So even a rebuild that is otherwise faithful returns the console
at a *different* height than the reader left it: an agent that is attached to a row (or detached from one) changes
the console's size without the reader doing anything, and the same bug reads as "sometimes it shrinks, sometimes it
jumps". One console should have one baseline; the caps should differ only where the *layout* does (the maximized
card, the float), and those are already `none` on purpose.

### 6. Nothing is persisted — no `localStorage` key and no `state` entry

The two maps that hold console reader state are in memory alone (`app.js:58`, `152`), and the size has no store at
all, so a reload always returns the cap (measured T6: 1070 → 320). Lower priority than the above because the same is
true of the card's `--term-size` (the Ctrl+wheel zoom, which one variable now drives for the console's words, a
tool's output and the reasoning), which is deliberate for a zoom; but a reader who drags a console open and comes back after a
page reload will report this one, so it belongs in the same fix.

### What survives, and why that makes the bug feel arbitrary

Every board path that *moves* the card instead of rebuilding it kept the size, in the same run: `reorderProjects`
(T4a), `renderProjectRows` (T4b), `renderAll` (T4c) and `applySnapshot` (T4d) all left the node intact —
`fillAgentSlots` hands the existing card element to the rebuilt detail (`app.js:11088-11095`,
`slot.replaceWith(card)`), a move, so the inline style rides along. A board re-sort cannot even move an open
project's section: `reorderProjects` keeps the slot of every open project and sorts the closed ones into the gaps
around it (`app.js:11787-11806`). So the reader's board is stable for minutes and then loses the size on an event
they did not connect to anything (a turn ending), on a card that was simply repainted.

---

## 4. What the numbers say the fix has to do (shape, not code)

1. **Give the size a place in `state`, keyed like `outScrolls` and `consoleZoom` are** — `pre[data-out]` is already
   the console's identity, and both of those maps are keyed by it. The value has to be able to say "uncapped" as
   well as a pixel height, because that is what the reader's own gesture produces today.
2. **Re-apply it where the scroll is re-applied**: `renderConversation` (`7656`), `renderJobs` (`7299`) and
   `fillAgentSlots` (`11094`). Those three are the only places a console node is created or carried, and each is
   already the tail of the corresponding rebuild.
3. **Make the gesture write a height, not lift a cap** — and lift the cap *before* measuring, in the same
   `pointerdown`, so the corner stays under the pointer. A `resize` that only removes a max-height cannot be
   remembered and cannot be aimed.
4. **One baseline, not three** (`style.css:470` vs `971`). Pick the cap for a console and let the two layout
   exceptions (maximized card, assistant float) keep their `none`.
5. **Do not fire on a bare click** (`app.js:13401-13408`): the gesture needs movement, and the press should not
   resize the box.

## 5. What this note does not settle

- **How often, in real time.** The ranking is by which of the reader's gestures land on which path, not a sampled
  rate on a live board; a `renderConversation` counter on the reader's own panel for an hour would settle it.
- **The pinned copy.** A pinned turn renders a second console (`data-out="<id>@pin"` — `turnBlock(…, "@pin")` at `app.js:4017-4019`, the id built at `2258`) whose node
  is also thrown away by a repaint; it was not measured here, and it needs the same entry in `state` keyed by the
  copy's own id.
- **The stream renderer.** `paintStreamConsole` (`6673-6682`) patches the console's children in place rather than
  replacing the node, so it holds the size today; nothing in the fix may turn it into a rebuild.
- **Whether `max-height: 320px` under a row is even the right number.** It was not measured against how much of a
  card a console should be allowed to eat — only that it is not the same number as `#jobs`'.

## 6. How these numbers were taken

Scratch probe, not committed: a `startPanel()` sandbox (`tools/panel-testkit.mjs`) over a throwaway
`scan-root`/`board-repo` with one real `git worktree` at `.worktrees/console-size`, and a `logs/jobs.json` seeded
*before* the panel boots (a running panel rewrites its store every ~700ms) with three finished jobs of 90 `out`
lines each — one owned by the worktree (`ownerPath`), two unattached. Chromium at 1600x1000, one fresh context.

The drive, per trigger, is the page's own function — never a synthetic click:

```js
appendJobLine({ id, line: { kind: "out", lid, at, text } })     // a live line
updateJob({ ...state.jobs.get(id), label: "x" })                // a repaint (signature change)
updateJob({ ...state.jobs.get(id), status: "running" })         // a turn's status moving
updateJob({ id: "a1-t2", thread, turn: 2, status: "running", … })// another turn starting
reorderProjects(); renderProjectRows("board-repo"); renderAll() // the board re-sorting / repainting
applySnapshot(await (await fetch("/api/state")).json())         // the poll
page.reload()                                                   // the panel reloading
```

After each, the console is read by `data-out` and three numbers are compared: `getBoundingClientRect().height`,
`getComputedStyle().maxHeight`, and the node's own `style` attribute — plus a `data-probe-node` attribute written
before the trigger, which is how "same node, moved" is told from "new node". The drag is `mouse.move` to
`(r.right - 6, r.bottom - 6)`, `mouse.down`, ten `mouse.move` steps of 26px, `mouse.up`, with the style read at each
step (that is the §1.1 table).

Two things the probe pinned down that are easy to get wrong from the source alone: the first `pointerdown` in the
corner already resizes the box (so a probe that reads only after the drag sees "no change" and calls it a pass), and
a console whose content is *shorter* than the cap does get a real inline `height` from the same gesture — measure
both shapes or the gesture looks entirely dead.
