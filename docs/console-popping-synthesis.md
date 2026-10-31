# The console's pops: the writes, the callers, and what is still unknown

Consolidation of the console popping/flicker campaign. This note is written from a measurement taken on this tree
(`6ca7964`, 0.34.0) and it says plainly what that measurement settles and what it does not. **No fix is proposed and no
product file was changed.** The instrument is `tools/measure-console-writes.mjs`; the numbers below are its output.

The one thing to take from this note if you read nothing else:

> On 0.34.0 the console's `scrollTop` is never written to a value the layout has already moved past. What the ledger
> *does* find, in every run, is a `scrollTop` that changes with **no write at all** - `placeRow`'s same-task move of a
> card, 78-1,285 px at a time, with `scrollHeight` unchanged - and on this tree that move is always repaired inside the
> same task, before any frame can paint it. So the question is not "which caller writes a bad top". It is **which path on
> the reader's board lets the in-task repair miss**, and the instrument that answers that is this one, pointed at a build
> and a drive that reproduce it.

---

## 0. What this turn did, and did not, produce

| | |
| --- | --- |
| produced | `tools/measure-console-writes.mjs` - an instrument that records every `scrollTop` write on a console with its caller, every geometry read it could have used, every DOM move that carried the console, every change of `scrollTop` that no write explains, and the per-frame painted series to join all of it to |
| produced | four driven runs on this tree, plus a control run and a self-test in each |
| did not produce | a reproduction of the reader's 97 excursions. In 4,693 writes over 60 s with four consoles streaming and the reader typing, **no console was painted off its bottom in any frame** |
| did not touch | `public/**`, `lib/**`, `server.js`, `package.json`. Nothing here is a fix |
| waiting on | the three slot documents (`docs/console-popping-a.md`, `-b.md`, `-c.md`). They had not landed when this was written, so §5 states what the *existing* notes prove and §6 is the question list each slot result has to answer |

---

## 1. Why every harness before this one was blind, by construction

live-1 recorded 97 excursions on the real board in which `scrollTop` fell **34-190 px while `scrollHeight` grew 0 px**,
85 repaired by the 400 ms `stickConsole` sweep and 12 by the next streamed line, 54 of them lasting under 50 ms.

Three consequences follow from those four numbers, and they are arithmetic rather than opinion:

1. **A jump that is undone inside 50 ms cannot be sampled.** At 60 Hz that is three frames; at the ~250 ms polling rate
   several harnesses in `tools/` use, it is usually zero frames. A sampler that screenshots on a schedule sees nothing at
   all. The defect is in the interval between two samples, so the only instrument that can see it records the *events*.
2. **`scrollHeight` grew 0 px, so the content did not change.** Every "follow the newest line" write in `public/app.js`
   writes `scrollHeight` (`paintTypedLines` `:6417`, `drawJobLine` `:7800`, `stickConsole` `:7050`,
   `restoreScrolls` `:7072`, `applyStoredScrolls` `:7083`, `releaseScrolls` `:7142`) and every one of them reads it in
   the same task it writes, so a write of that shape cannot land 34-190 px short unless the box grew *after* the read. A
   fall with the height unchanged is therefore either a write of a **remembered** top, or a move of the box that **no
   write** explains. Those are different bugs and only a write log can tell them apart.
3. **85 of 97 were repaired by the sweep.** The 400 ms sweep only touches boxes `consolePinned()` calls pinned
   (`:7047`), so the box was pinned the whole time - the fall did not unpin it. A pinned box that is off its bottom is
   exactly the state `restoreScrolls`' pinned branch (`o.scrollHeight`) and `drawJobLine`'s `stick` test (`:7724`) exist
   to prevent, so whatever moved it did so **outside** those paths.

Nothing in `tools/` before this records the writes. `tools/measure-console-scroll-hop.mjs` wraps `setScroll` - the one
function - so it cannot see a write that goes around it, and it cannot see the browser's own clamp at all.
`tools/verify-console-independence.mjs` samples painted frames. Both are the right instrument for the hop that #132
fixed and both are blind to a sub-frame jump by construction.

---

## 2. The instrument

`tools/measure-console-writes.mjs`. Runs are one command each; see §8.

### 2.1 What it wraps, and why on the prototype

An init script runs **before `public/app.js` is parsed** and redefines, on `Element.prototype`:

| property | wrapped | what is recorded |
| --- | --- | --- |
| `scrollTop` setter | yes | `t`, `domSeq`, box, `from` (the value before the write), `asked`, `landed` (read back after), `sh`/`ch`/`max` at write time, `isConnected`, `dead`, the read the target came from, the caller stack |
| `scrollTop` / `scrollHeight` / `clientHeight` getters | yes | a ring of 3,000 reads per box: `t`, `domSeq`, which property, its value, and all three numbers at that instant |
| `scrollTo` / `scrollBy` | yes | the same record, so "nothing in the page uses them on a console" is a measurement, not an assumption |
| `focus` / `scrollIntoView` / `setSelectionRange` / `select` | yes | every call that lands inside a console box, with its caller - focusing an element scrolls its nearest scrollable ancestor to reveal the caret, which moves a console's `scrollTop` with no write |
| `insertBefore` `appendChild` `after` `before` `append` `replaceWith` `replaceChildren` `remove` | yes | every operation whose subtree carries a console: the operation, the node, whether it was attached, which console keys it carried, and the caller. **No geometry is read inside these** - a layout read in a detached subtree manufactures the clamp it would be measuring |

It is filtered to the four console boxes (`pre.job-out`, `.think-body`, `.sub-console`, `.job-body`) with a memoised
class test, so every other element on the page - including `document.scrollingElement` and the reply boxes - is answered
by the native accessor and nothing is written down. Prototype-level is deliberate: `setScroll` is not the only writer
(`public/assistant.js:247`, `:756`, `:1249` write directly), and wrapping the function would have inherited exactly the
blind spot the earlier audit had.

### 2.2 Joining a write to the read it came from

A write's `top` argument is computed by its caller from reads the caller took. `domSeq` is a counter bumped by every
console-carrying DOM operation, so "the layout moved between the read and the write" is a number rather than a
timestamp guess:

```
read  sh=1180 ch=318 top=862   at domSeq=41, t=22880.1
op    replaceWith div.agent-slot   by fillAgentSlots < placeRow < flush     domSeq=42
write asked=862 (=== that read's top)  at domSeq=42, t=22880.4
      src = { what: "top", ageMs: 0.3, domAge: 1, shThen: 1180 }
```

Every write record carries `src`: which of the three numbers the target was (`sh`, `max` = `sh - ch`, or `top`), how old
that read was in ms, **how many console-carrying DOM operations happened since** (`domAge`), and the geometry then and
now. A write is judged only on what the writer could have known:

| field | meaning |
| --- | --- |
| `short = max - asked` | positive: the caller asked for a top above the newest line |
| `landedShort = max - landed` | positive: the box was **still** off its bottom after the write |
| `dead` | the box had no layout at all (detached, or inside `display:none`), so the write went nowhere and `setScroll` still stamped `_selfTop` |
| `src.domAge > 0` with `short > 0` | the target came from a read taken before the layout moved - the literal "a top the layout has already moved past" |

### 2.3 The silent-move ledger

This is the part that does not exist anywhere else in the repo. Between write *i* (which landed on `L`) and write
*i+1* (which read `F`), the box went from `L` to `F`. When `|F - L| > 2` the change has **no writer**, and the ledger
names what was in the gap: a DOM operation that carried the console, a focus/`scrollIntoView` inside it, or nothing at
all. This is the only place the live-1 signature - a fall with `scrollHeight` unchanged - can appear as a row with a
cause attached.

### 2.4 The self-test, and why a green run cannot be a pass on nothing

After the measured window closes (so nothing the tool writes can reach the ranking) the page is driven twice:

1. **the sub-frame jump**: `setScroll(box, 0)`, then 40 ms later `setScroll(box, box.scrollHeight)`. Both writes must
   appear in the log with their caller, and the frames in between must show the box off its bottom.
2. **the browser's clamp**: a raw `appendChild` of the section the console lives in, with no write at all. The op log
   must hold the append and the frames must show `scrollTop 0`.

If either step fails the run says so. All four runs pass both. Two of the numbers from the self-test are worth keeping:

```
self-test OK  write to 0, repaired 40 ms later through setScroll: {"before":1302,"jumped":0,"repaired":1302,"gapMs":40.7}
self-test OK  raw re-append of the console's section, no write: {"before":1302,"after":0,"max":1302}
self-test frames around the jump: 3, 2 of them off the bottom (first top 0, max 1302)
```

And the app repaired the tool's jump **1.6 ms, 27 ms and 40 ms** after it in three different runs - `paintTypedLines` at
`app.js:6417`, not the sweep. That is live-1's "54 of them lasting under 50 ms", reproduced deliberately: a jump that is
gone before the next sample.

### 2.5 The control

`--control` turns read logging off and leaves everything else identical. Same layout, same 45 s window:

| | reads logged | writes | silent moves | excursions |
| --- | --- | --- | --- | --- |
| `busy`, reads on | 12,541 | 3,625 | **72** | 0 |
| `busy`, `--control` | 0 | 3,474 | **72** | 0 |

The instrument does not create the thing it measures.

---

## 3. What it measured

Four consoles streaming plain text at 75 ms/word over the panel's real SSE path, four closed projects churning a file
every 4 s so the ranking really moves, on this tree. "Reader typing" is a real click into a card's reply box and a real
keypress every 400 ms (`--type`), which keeps `lastInputAt` inside its 1,200 ms window for the whole run - the condition
under which `public/app.js:14997` lets a scroll event be read as the reader's.

| run | consoles | writes | reads | frames | writes off bottom | excursions | silent moves | silent, DOWN | `|px|` p50/p90/max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `one` 20 s | 1 | 410 | 1,870 | 3,135 | 0 | 0 | - | - | - |
| `busy` 45 s | 4 | 3,625 | 12,541 | 4,480 | 0 | 0 | 72 | 72 | 509/854/957 |
| `busy` 45 s `--control` | 4 | 3,474 | 0 | 4,221 | 0 | 0 | 72 | 72 | 509/871/888 |
| `busy` 60 s `--type` | 4 | 4,693 | 15,876 | 3,612 | 0 | 0 | 112 | 112 | 647/1,164/1,285 |
| `siblings` 45 s `--type` | 2 | 1,934 | 6,604 | 4,310 | 0 | 0 | 38 | 38 | 526/888/957 |

Three facts, in order of importance:

1. **No write in any run left a console off its bottom.** `landedShort > 2` never happened, `dead` never happened, and no
   write ever moved a box up (`from - asked > 2` never happened). On this tree, in this drive, the write path is clean.
2. **Every silent move is DOWN, every one has `scrollHeight` unchanged, and every one is the same operation.**
   `replaceWith div.agent-slot` by `fillAgentSlots|app.js:11030 < placeRow|app.js:12702 < flush|app.js:12590`. The small
   ones are 43-112 px (a card whose console was 78 px down being replaced); the big ones are the whole box (509-1,285 px,
   i.e. to 0). The p50 is dominated by the big ones.
3. **None of them was painted.** `placeRow` reads the scroll map off `oldDetail` at `app.js:12676-12683` *before*
   `oldDetail.remove()` at `:12687`, and restores it at `:12710-12712` in the same task, so no frame ever shows the box at
   0. The 112 silent moves and the 0 excursions are the same events: the ledger sees them **between writes**, where the
   painted sampler cannot.

That third point is the load-bearing one. The shape live-1 recorded - 34-190 px down, `scrollHeight` unchanged, undone
before the next sample - is **exactly** the shape of `placeRow`'s move in the ledger. On the reader's board the same
move is not being repaired in-task; on this tree it always is.

---

## 4. The caller ranking

### 4.1 Measured, by write count (60 s, four consoles, reader typing)

| caller | site | writes | up | off bottom | asked above bottom | grew inside the write | stale (`domAge > 0`) | dead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `paintTypedLines` | `app.js:6417` | 2,821 | 0 | 0 | 0 | 0 | 0 | 0 |
| `drawJobLine` | `app.js:7800` | 1,712 | 0 | 0 | 0 | 0 | 0 | 0 |
| `restoreScrolls` | `app.js:7072` | 112 | 0 | 0 | 0 | 0 | 0 | 0 |
| `releaseScrolls` | `app.js:7142` | 48 | 0 | 0 | 0 | 0 | 0 | 0 |
| everything else | - | 0 | - | - | - | - | - | - |

`paintTypedLines` and `drawJobLine` are 96% of the traffic and are also the repair for a jump (see §2.4). The two
`restore*` writers only run when a detail is rebuilt: 112 + 48 calls in 60 s, i.e. one rebuild every ~380 ms across four
rows, which is what four live rows on a 5 s liveness pass look like.

**Ranked by "wrote a top the layout had already moved past", the measured answer is: none.** That is a result, not a
gap: it means the defect the reader sees is not reachable from the write path on 0.34.0 under this drive, and the
remaining candidates are (a) a build/drive that is not this one, or (b) a *read* of a polluted store rather than a
computation from a fresh layout.

### 4.2 Ranked by risk, from the code (not measured)

Every writer is safe for a reason. Ranked by how easily that reason breaks:

**1. `applyStoredScrolls` (`app.js:7083`) - the only writer whose input is polluted by the browser.**
It writes `Math.min(was.top, max)` for a box that is not pinned and was not at the bottom, from
`state.outScrolls[o.dataset.out]` - a store filled by the **scroll handler** (`app.js:14998`) on every scroll event that
is not the panel's own. The handler's test for "the panel's own" is `selfScrolled.has(pre) || justPlaced(pre)`
(`app.js:14990`), and `justPlaced` (`app.js:6999`) is `Math.abs(el.scrollTop - el._selfTop) <= 1`. After a browser clamp
that no same-task restore covers, `scrollTop` is not `_selfTop`, so the clamp is recorded as the reader's position; and
because `lastInputAt` is set by a keydown **anywhere on the page** (`app.js:6979-6983`), a reader who is typing has
`state.outPinned[id] = false` written for them (`app.js:14997`). From that point every rebuild re-applies the clamped top.
This is the only path on this tree where a stale top can be written, and it needs two things to be true at once: a clamp
the in-task restore missed, and a keypress in the preceding 1,200 ms. **It is the first thing a reproduction should
target.**

**2. `restoreScrolls` (`app.js:7072`) - safe, but only because `placeRow` captures before the move.**
`placeRow` reads the map off `oldDetail` at `app.js:12676-12683`, before `oldDetail.remove()` at `:12687`. A capture taken
after the move would read 0 and write 0 - the bug #132 fixed in `reorderProjects` and the one the comment at
`app.js:7110-7111` exists to prevent. Any new caller of `restoreScrolls` must hold the same order.

**3. `releaseScrolls` (`app.js:7142`) - safe on both branches.**
`max` is read at release time; the pinned branch writes it, the parked branch writes `Math.min(h.top, max)` from
`holdScrolls`, which runs before the move (`app.js:7112`).

**4. `paintTypedLines` (`app.js:6417`) and `drawJobLine` (`app.js:7800`) - structurally safe.**
Both read `scrollHeight` **after** the growth and write it in the same task, and reading `scrollHeight` forces layout, so
the value cannot be stale. Note the one subtlety in `paintTypedLines`: the *pin test* is deliberately taken once per
paint before anything grows (`app.js:6401-6403, 6412`), and the *target* is taken after. That asymmetry is what makes it
correct; a future change that caches the target in the same map would break it.

**5. `stickConsole` (`app.js:7050`), `settleScrolls` (`app.js:7023`), `stickThinkBody` (`:6551`), `stickSubConsole`
(`:6542`) - fresh `max` every call.** They are also the repair path, which is why live-1 saw 85/97 fixed by the sweep.

**6. `syncStreamConsole` (`app.js:6638`) - the one relative write, and unexercised here.**
`setScroll(out, out.scrollTop + (off - keep.off))` only runs for a box that is not sticky, and only in 🌊 stream mode.
The stub plays plain text, so it never ran: **0 occurrences in 4,693 writes**. If the reader's board has 🌊 cards on, this
is the only writer whose target is neither `scrollHeight` nor a remembered top, and it is the one writer this campaign
has not measured. A row that shrinks above the reader's line makes `off - keep.off` negative and moves the box **up** by
exactly the shrink - which is a fall with `scrollHeight` unchanged at the moment it lands.

### 4.3 What the silent-move ledger says about the ranking

All 112 silent moves are `dom move`; **0** are `focus/scrollIntoView`; **0** are `nothing logged`. So on this tree:

- the focus path is real but not firing in a driven board (no `focus()` lands inside a console box during the run), so
  the "a focus scrolls the console" candidate is **unmeasured, not ruled out** - it needs a card whose reply box is
  inside a scrolling console, or a click on a console row;
- there is no case of a bare layout clamp with nothing in the gap, which means every unexplained move has a caller.

---

## 5. What the existing documents already prove

Written down so the three slot documents can be read against it rather than re-deriving it.

| claim | status | where |
| --- | --- | --- |
| `appendChild` on an attached node is a remove-then-insert, and every scroll box inside it comes back at 0 | **proved** by measurement, and by the self-test in this tool (raw re-append: 1,302 -> 0) | `docs/console-scroll-hop.md` §2, §7 |
| `reorderProjects` re-appending every section of a folder was the 94 painted hops of 0.32.6, all of them | **proved** | `docs/console-scroll-hop.md` §3, §5 |
| `setScroll` is not the resetter: 7,498 writes, 0 backwards | **proved** for 0.32.6; re-proved here for 0.34.0 (4,693 writes, 0 moved a box up) | `docs/console-scroll-hop.md` §5, §4.1 above |
| no code writes `0` to a console; the top of the box is the browser's clamp | **proved** by grep and by this log (no `asked: 0` from any page caller in any run) | `docs/console-scroll-hop-candidates.md` §0 |
| the fix (`placeInOrder` + `holdScrolls`/`releaseScrolls`) takes the five layouts to 0 painted hops | **proved** on the landed tree | `docs/console-scroll-hop.md` §7-8 |
| a console can lag 70-380 px behind its newest line for 100-370 ms, 4-10 times per 75 s, following `placeRow` swapping a detail | **reported, not reproduced here** (0 excursions in four runs) | `console-independence-followups.md` (B) |
| subagent consoles still hop: ~40 in 40 s, 30 from `placeRow`, 10 from the strip repaint | **reported on a `subs` harness that is red on purpose**, not reproduced here | `console-independence-followups.md` (A) |
| `state.subConsoleVersion` is a page-global counter, so one child's read rebuilds every session's strip | **code-read** | `app.js:3698, 3785, 3793, 3805` |
| the console is a fixed-height box with `overflow-anchor: none`, so the browser cannot absorb a move | **proved** | `public/style.css:967-970`, `:704` |

Two claims that the campaign has been treating as proved and that this instrument does **not** support:

- **"Something writes a bad top."** Nothing does, in 4,693 writes across four consoles. Every wrong position in the
  window is a *move*, not a write.
- **"The 400 ms sweep is the repair, so the fault is a missing write."** The sweep is a repair, but so is
  `paintTypedLines`, and it is 27-40 ms behind, not 400 ms. On this tree the pacer beats the sweep to every jump the
  tool creates.

---

## 6. What is still unknown, and the question each slot result has to answer

Ordered by how much a single answer would move the campaign.

1. **Which build and which drive actually reproduce the reader's 97 excursions?** No run in §3 has a single one. If a
   slot measured excursions on 0.34.0, the doc has to say what its drive had that these four do not: 🌊 stream mode, a
   real roster/subagent poll, reasoning in the same box, a parked console, a page with 100 projects, or a real
   `wm.reorderSeconds` other than 5.
2. **`syncStreamConsole`'s relative write (`app.js:6638`) is the one writer never exercised.** If the reader's cards are
   🌊, this is the first candidate: it is the only write whose target is neither a fresh `scrollHeight` nor a remembered
   top, and a shrinking row above the reader's line moves the box up with `scrollHeight` unchanged. Measure it with
   `--only` on a stream-mode card, or read the ledger for `asked` values that are neither.
3. **Is the in-task repair ever missed on the reader's board?** The ledger's 112 moves are all repaired in-task here. What
   has to be shown is a `silent move` whose following write is NOT a restore in the same `domSeq` window - i.e. a move
   whose `domSeq` delta to the next write is > 0. The tool prints `gapMs` and the op in the gap; a slot doc with a
   `domAge > 0` silent move is the proof.
4. **Does the `lastInputAt` window ever let a clamp unpin a console?** The code allows it (`app.js:14997`); this run could
   not produce it because the clamp is always repaired before the scroll event fires. It needs a clamp the restore
   misses, plus a keypress - so it is downstream of (3), not independent.
5. **Does a focus inside a console move it?** 0 focus-driven moves in 112. Unmeasured, not ruled out: it needs a click on
   a console row or a reply box inside one. `--type` clicks the reply box, which is *not* inside the console, so this run
   does not answer it.
6. **The subagent strip (A) was not measured here at all.** The four layouts have no subagent. `state.subConsoleVersion`
   is a page-global counter and that is a code-read; whether it produces a painted hop on this build is open, and it is a
   different fault from this one.
7. **Does the sweep's 400 ms matter at all?** On this tree it is the *third* repair behind the pacer (1.6-40 ms) and the
   next line. If a slot measured 85/97 repaired by the sweep, that build's pacer was not running for those boxes - which
   would point at `paintTypedLines`' `stuck` map (`app.js:6412`) not containing the box, i.e. a console whose growing
   row is not in `lids`.

---

## 7. What I would run next (one line each, in this order)

1. `node tools/measure-console-writes.mjs --only busy --seconds 90 --type --json out.json` on the reader's own build, and
   diff the ranking against §4.1. If the ranking is still empty, the drive is the problem, not the build.
2. A stream-mode variant (🌊 on) with the same window, to put `syncStreamConsole:6638` in the log for the first time.
3. The `cards` layout from `tools/verify-console-independence.mjs` with Stabilize off, ported to this tool, because that
   is the one setting under which the panel may move an OPEN card and it is the only layout where a *card* move and a
   *row* move can be told apart in the same window.
4. A `subs` variant (the sixth layout `console-independence-followups.md` (A) describes) with this instrument, which
   would settle `state.subConsoleVersion` as a move source rather than a code-read.
5. Only after a reproduction: the fix. Not this turn, and not before the ledger shows a silent move that outlives its
   task.

---

## 8. Reproduce

```
node tools/measure-console-writes.mjs --only busy --seconds 60 --type --json out.json
node tools/measure-console-writes.mjs --only busy --seconds 45 --control        # read logging off
node tools/measure-console-writes.mjs --only siblings --seconds 45
node tools/measure-console-writes.mjs --only one --seconds 20                   # the smallest case
node tools/measure-console-writes.mjs --headed                                  # watch it
```

Each run stands up its own panel (`tools/panel-testkit.mjs`: spare port, own `PANEL_CONFIG` / `HERMES_HOME` /
`jobs.json` / projects cache, `API_SERVER_KEY` empty), its own stub Runs API, its own scratch tree under `os.tmpdir()`,
and tears all of it down. The reader's panel on 7331 is never touched. Exit 0 = measured; exit 2 = the run measured
nothing (no console overflowed, or no write was logged) and a pass would be a pass on an empty log.
