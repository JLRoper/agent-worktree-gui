# A card a rebuild BUILDS: which line does its console open on?

Asked of this tree (0.44.1, `93a7357`): when a row's detail is rebuilt, the consoles of the cards it CARRIES are put
back where the reader had them, in the same task. What happens to a console the rebuild **builds** - a card that was
not on the page before it, because the reader has just opened the row or an agent arrived since the last paint?

**Its console opened at its first line, for one or two painted frames.** It is a fresh scroll area with the whole
history in it - a log the run has been writing all along - and nothing in the rebuild had a place to put it back to:

- `restoreScrolls(root, map)` puts back what the caller captured from the OLD nodes. A card built in this rebuild has no
  old node, so it has no entry, and the loop `continue`s past it.
- `applyStoredScrolls(root)` puts back what the reader's own scroll events remembered (`state.outScrolls`). A card whose
  consoles have never been wheeled has no entry either, and a pinned console needs none - it follows its newest line.
- `settleScrolls(root)` is the repair: two `requestAnimationFrame`s, then `stickConsole` on each pinned box. Two frames
  is a paint. At 457-474 px of scrollback that is a visible flash of the top of the log.

A carried console had the same fate until `89d896c` gave `fillAgentSlots` a `holdScrolls`/`releaseScrolls` pair; a
BUILT one has no node to hold, which is why it was the one clamp the write log could not name.

## 1. The measurement

Two instruments, because the two halves of the claim need different ones.

`tools/verify-console-independence.mjs --only rebuild` is the frame sampler: its own throwaway panel and stub Runs API,
two live cards in one worktree row, a file written into that row's OWN worktree every 3 s (so `placeRow` sees a field it
draws change and rebuilds the detail - the reader's board doing it), and a third agent in a second row whose row stays
shut until the window is open, so one rebuild has to BUILD a card with 40 s of output behind it. The reader parks one
console with a real wheel first, and the sampler records every frame of every `pre.job-out` against the box's
`scrollHeight`/`clientHeight`: `scrollTop <= 2` on a box with > 20 px of scrollback is a hop, one frame or a thousand.

```
# the base (an export of the commit under test, so the harness serves that file and not the working tree)
git archive 93a7357 | tar -x -C <export>
node tools/verify-console-independence.mjs --only rebuild --seconds 40 --root <export>

FAIL         rebuild   TWO live consoles in a row whose own detail a new file rebuilds
             2 console(s); 3 section move(s), 0 folder move(s) in 154 reorderProjects call(s); 0 card swap(s) in 84 reorderAgentCards call(s); 0 of 14 strip repaint(s) replaced a sub-console; 11 detail rebuild(s) moved cards through fillAgentSlots, 1 console(s) built by one; 1 painted hop(s)
             - 1 painted hop(s)
             1 distinct frame(s), 0 with more than one console at the top
             per console: b52ed525 1
               1x  fillAgentSlots | replaceWith | div.agent-slot
             t=42851ms console b52ed525 at 0 (max 457), 1 frame(s)
             sensitivity: raw re-append took a console from 90 to 0 (hop test says hop)
             the reader's park: console 26d796c0 at 90 of 302 (max), pin false, atBottom false
             fill t=42848ms reuse 2 fresh 0 by renderProjectRows
             fill t=42848ms reuse 0 fresh 1 by renderProjectRows
```

- **1 hop, 457 px of scrollback, cause `fillAgentSlots | replaceWith | div.agent-slot`** - the card the rebuild
  built, not a card it moved: the hop's `t` is 3 ms after the `fill` that reported `reuse 0 fresh 1`, the same
  rebuild. Every other console in those 11 rebuilds stayed where it was. The frame count varies between runs (2
  frames at 474 px on the first run of this export, 1 frame at 457 px on the re-run above); the cause does not.
- **The park held** (90 of 302, `pin false`, never painted at 0), so the carried path was already right and this was
  not "the reader's console moved": it is the one nobody had a place for.
- **The recorder can see the fault in this browser**: a raw re-append of an open section took a console from 90 to 0,
  which is the sensitivity check - a clean run on a browser that cannot reset a box would be exit 2, not a pass.

The write-logging instrument is the other half. `tools/measure-console-writes.mjs --only busy --stream --seconds 60` on
the same base reports **0 silent moves**: 3,253 writes, 0 up, every change of `scrollTop` explained by a logged write.
That is the `keepDetail` guard from `89d896c` doing its job - the busy window does not rebuild a detail at all, so the
95-102 detach-to-0 clamps a minute that `docs/console-combined-first-line.md` counted on 0.35.1 are gone from that
layout. The defect that remained is the one this note names, and only a rebuild that BUILDS a card can show it.

## 2. The fix

Two changes in `public/app.js`, both about a console that no remembered place covers.

- **`placeBuiltConsoles(root)`** (beside `applyStoredScrolls`): every `pre.job-out` in a subtree that a rebuild just
  built is placed in the same task as the insert - the reader's remembered line when they had taken the box over, its
  newest line otherwise. It skips a box that already carries a `_selfTop` in this task, so a console the caller has
  already positioned is not written twice. `fillAgentSlots` calls it on each card it BUILDS, which covers every path
  that fills a detail: `placeRow`, `renderProjectRows`, and the reader opening a row. A child's console in the same card
  is placed by `applySubConsoleScrolls`.
- **`placeRow` gives up the old detail's cards before it gives up the detail.** The rebuilt detail is attached, the
  cards move into it while the old one is still on the page, and only then does the old one go (`cardOut`). Why it
  matters: `fillAgentSlots` reads each carried console's place off the node it is about to move, and a node that has
  already left the page reports 0 - the top of the log, which is the wrong answer for a reader who parked it. The
  browser cannot help here: measured in Chromium, a scroll container that is re-parented **inside** the document is
  reset to 0 exactly like one that left it, so there is no "move the node and keep the position" to be had. The read
  has to happen while the old detail is still on screen, and the write has to happen in the same task.

Same instrument, same layout, on this branch (served `public/app.js` sha256 `5e208065bd4860ec99e2fe4b5a2827ee85549497543dbcb5377b718c52e52d00`,
static build `e2ce9800b088`):

```
PASS         rebuild   TWO live consoles in a row whose own detail a new file rebuilds
             2 console(s); 2 section move(s), 0 folder move(s) in 162 reorderProjects call(s); 0 card swap(s) in 84 reorderAgentCards call(s); 0 of 14 strip repaint(s) replaced a sub-console; 11 detail rebuild(s) moved cards through fillAgentSlots, 1 console(s) built by one; 0 painted hop(s)
             sensitivity: raw re-append took a console from 90 to 0 (hop test says hop)
             the reader's park: console cb798522 at 90 of 302 (max), pin false, atBottom false
             fill t=42378ms reuse 2 fresh 0 by renderProjectRows
             fill t=42379ms reuse 0 fresh 1 by renderProjectRows
```

- **0 painted hops** across 11 rebuilds, one of which built a card (`reuse 0 fresh 1` at t=42379 ms - the same
  rebuild that hopped on the base), with the reader parked at 90 px the whole window.
- The unit half is `test/console-independence.test.js`: a console a rebuild builds is on its newest line in the same
  task (and stamped `_selfTop`, so the page knows the position is its own), a console the reader had taken over goes
  back to their line, and `placeRow` removes the old detail only after `fillAgentSlots` has taken its cards out.
- The suite is 642 tests, 0 failures.
- The whole gate, all seven layouts at a 45 s window on this branch: `PASS 7 layout(s)`, exit 0 - `one`, `siblings`,
  `projects`, `folders`, `cards`, `subs` and `rebuild`, each with its own sensitivity check and no page error
  (`C:/Users/roper/AppData/Local/Temp/wag/fd1a5022/sweep-1.log` on the machine that measured it). The six older
  layouts are unchanged by this fix: the rebuild layout is the only new one, and it is the only one whose numbers
  move.

## 3. What this does not say

- One browser, one machine, one layout, headless Chromium, a stub gateway: the counts are what this board did, not a
  census of every board. The rule is what the code now enforces; the numbers are the proof that the rule is exercised.
- A rebuilt detail still detaches every card it carries, so a carried console's `scrollTop` still reaches 0 and is
  written back in the same task. That is invisible to a frame sampler (0 hops, before and after) and is what the
  write-log note already documents; this change does not make the detach go away, it makes the one console with no
  remembered place survive it.
- `--only busy --stream` cannot exercise this fix: with the detail kept, it never rebuilds one. A clean run of that
  window is not a proof of this change - the `rebuild` layout is.

## 4. Reproduce

```
node tools/verify-console-independence.mjs --only rebuild --seconds 40            # this tree
node tools/verify-console-independence.mjs --only rebuild --seconds 40 --root <export of the base>
node tools/measure-console-writes.mjs --only busy --stream --seconds 60 --json out.json
node --test test/console-independence.test.js
```

Served-page identity for the two runs above, both from a panel of this tree's own (`PANEL_CONFIG` + `HERMES_HOME` under
a scratch dir, `API_SERVER_KEY` empty, port 7383 - never the reader's 7331):

| | base `93a7357` | this branch |
| --- | --- | --- |
| `public/app.js` | 942,953 B | 945,772 B |
| sha256 | `0b4d9075b8382241755dd76263bd90934812de7807371b8eb189bd559635a54f` | `5e208065bd4860ec99e2fe4b5a2827ee85549497543dbcb5377b718c52e52d00` |
| static build | `f33f5bfd7704` | `e2ce9800b088` |
| `/api/health`, `/` | 200, 65,626 B | 200, 65,626 B |
| served `/app.js` = `public/app.js` | yes, byte-identical | yes, byte-identical |
