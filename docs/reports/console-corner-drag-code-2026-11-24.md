# The console corner, read as code

## What this page is

The code half of queue row 315, run beside the Playwright measurement row. The reader's report is that the session output console's bottom-right drag is glitchy, and the ask is to name the class of problem so it stops coming back every few turnovers.

This page reads the resize path and names each defect as a mechanism with a file and a line. It does not measure a drag in a browser, and it changes nothing: `public/` and `lib/` were read only, because the measurement row holds those files. The one experiment here is a minimal page built from the sheet's own rules, in section 3, to test the layout physics the gesture's arithmetic assumes.

Read at version 1.169.1, branch `wtgui/read-queue-row-315-first-c03227`, cut from `main` at `0d6e9441`. The landing carries version 1.169.4 on top of `origin/main` at `6a6da6b7`; the reading below is of the code at the read commit.

### What was run

- `npm run test:changed -- --list` answered with this tree's two changed files (`docs/reports/console-corner-drag-code-2026-11-24.md`, `tools/render-report-notes.mjs`) and "no test names or imports any of them". Nothing under `public/`, `lib/` or `routes/` changed, so there is no code path for a focused test to cover.
- The full sweep (`npm test`) was run in this worktree and did not converge: one run ended after 515 passing cases with no summary, and a second, with `--test-timeout=180000` to bound a hung file, reached 3508 passing cases before the 20 minute limit, where it was cancelled. Every failure names a file this branch does not touch, and the five that were opened belong to this worktree's environment or to `origin/main`:
  - `test/gateway-permissions.test.js:373` dies on `ENOENT: config.json`, which is gitignored (`.gitignore:26`) and absent in a fresh worktree; the main checkout is the one that has one.
  - `test/assistant-queue-reattach.test.js:412` throws `TypeError: Cannot read properties of undefined (reading 'find')`, and the same file fails the same way against a clean `git archive` of `origin/main` at `0d6e9441`.
  - `test/initiative-tier-route.test.js` fails three assertions at 3 against 4 on the same clean export.
  - `test/harness.test.js` fails on `tools/verify-wave-file-exists.mjs` declaring a LIVE GATE with no `package.json` script; that file is in `origin/main` and the script is absent there too.
  - `test/assistant-hard-restart.test.js` passes 6/6 in isolation, so its one suite-time failure is load.
  The rest are in the same families (the config routes, the panel's paths, and its git routes) and were not opened one by one.
- The probe in section 3 is a scratch file, `corner-scroll-probe2.mjs`, run under Chromium via Playwright 1.64.1 on Node 26.3.0, headless at 900x700. It is not in the tree: it is a reproduction of the sheet's rules, and its page and loop are printed above so it can be rebuilt from this page.

## 1. One drag, end to end

### 1.1 The markup and the hit band

The console is a `<pre class="job-out">` inside a `.out-box` that holds nothing else, and the grip is a span in that box's bottom-right corner:

- `public/board/console.js:1421` `outGripHtml()` draws `<span class="out-grip" data-out-grip="1">`, and `public/render-jobs.js:243` places it inside the same `.out-box` as the `<pre>`. The marching tail and the tail chips are siblings of the box, so a row arriving under the console cannot move the corner (`public/style.css:1521`).
- `public/style.css:1531` is the band: 18x18, `position: absolute`, `touch-action: none`, no border radius so the corner-most pixels are not clipped out of the hit area.
- `public/style.css:1685` gives the console one height source, `height: var(--out-h, auto)`, one cap (`max-height: 230px`) and one floor (`min-height: 34px`). In the docked Chat pane the pane rules take over: `max-height: none`, `flex: 0 0 auto`, so the height variable is honoured exactly (`public/style.css:6439`). In a maximized card the console is a block inside `.out-box` with `max-height: none` (`public/style.css:3794`); its `flex: 1` there is inert because `.out-box` is not a flex container.

### 1.2 The press

`public/app.js:10598` listens for `pointerdown` on the document in capture, so the gesture survives the console node being replaced. It refuses a second gesture (`public/app.js:10601`), finds the console under the grip (`10602` to `10606`), and writes down the whole gesture in one record (`public/app.js:10614` to `10638`):

- `top: r.top` and `grab: r.bottom - e.clientY`. These two numbers are the gesture. Every move is `pointer + grab - top`, so nothing accumulates from one move to the next (`public/app.js:10561`).
- `min` and `cap`, read off the box at the press: `parseFloat(cs.minHeight)` and `parseFloat(cs.maxHeight)` (`public/app.js:10630` to `10631`).
- `hadVar`, `styleMax`, `styleMin`, the inline values as they were, so a press that never moves can put the box back exactly (`public/app.js:10632` to `10634`).
- `body` and `following`: the transcript, and whether it was on its foot at the press (`public/app.js:10612` to `10613`, `10635` to `10636`).
- `setPointerCapture` (`10642`), then the first write: the drawn height pinned through `setOutHeight`, the cap and the floor lifted to `none` and `0`, the body class on (`public/app.js:10651` to `10655`).

### 1.3 The move

`public/app.js:10661` is one expression per move: `outGripStep(d.top, d.grab, e.clientY)`, then `setOutHeight(d.out, h)` and `max-height: none` (`10675` to `10676`). There is no measurement in this handler and no clamp: it writes a pixel height derived from an edge frozen at the press, and the corner lands on the pointer by construction as long as that edge has not moved.

`setOutHeight` is the one writer (`public/board/console.js:3753`): it rounds the number and sets `--out-h`. The sheet reads it (`public/style.css:1691`).

### 1.4 The release

`public/app.js:10681` `endOutGrip`, on `pointerup` and `pointercancel` on the window (`public/app.js:10731` to `10732`), and it does four things in one task:

1. If the press never moved (less than 1px, `public/app.js:10671`), put the inline values back and stop (`10693` to `10699`).
2. Otherwise clamp once: `room` is the room under the box's LIVE top edge, `h = outGripRelease(d.h, d.min, room)` (`public/app.js:10705` to `10707`), and the result is written through `setOutHeight` (`10708`).
3. Decide the cap, and remember the number in the store (`public/app.js:10715` to `10716`).
4. If the transcript was following at the press, put it back on its foot: `setScroll(d.body, d.body.scrollHeight)` (`public/app.js:10721` to `10724`).

Then, if any repaint path deferred itself during the gesture, a full `renderAll()` runs inside the same pointerup (`public/app.js:10728`).

### 1.5 The store

The number lives outside the DOM, because a rebuild replaces the node and everything inline with it (`public/app.js:660` to `670`):

- `state.outHeights` is loaded from `localStorage["wm.outHeights"]` at boot (`public/app.js:423`, `671` to `683`), keyed by `pre.dataset.out` (the turn id, `@pin` on a pinned copy).
- `rememberOutHeight` writes it on a release that moved (`public/app.js:695` to `700`), `pruneOutHeights` drops entries for turns that left the board (`public/app.js:705` to `714`, called from `public/render-jobs.js:768`).
- `applyStoredHeight` puts it back on a node that is not the one the reader dragged (`public/board/console.js:3778`), lifting the sheet's cap when the stored number is above it (`3786` to `3787`).

### 1.6 Every other writer of the same number

The console's HEIGHT has one writer, which is real and is held by `test/console-grip.test.js:135`. What the reader sees as "the size" is not only the height: it is `top + height`, and the top edge is written by everything that scrolls the transcript. This is the full list of writers of the box's size or position, and the guard each one asks.

| Writer | What it writes | When | The guard it asks |
| --- | --- | --- | --- |
| the gesture, press | `--out-h` = drawn height, cap `none`, floor `0`, body class | pointerdown | none, it is the gesture |
| the gesture, move | `--out-h` = pointer + grab - frozen top, cap `none` | pointermove | none |
| the gesture, release | `--out-h` clamped, cap, floor, the store, the transcript's scrollTop | pointerup | none |
| the remembered height | `--out-h`, and `max-height: none` when above the cap | any rebuild that builds a node | `consoleHeld` (console.js:3782) |
| the float's slack drag | `--out-h` and `max-height` of the open turn's console | a float corner resize | none, it is a different gesture (assistant.js:8162, 8165) |
| the page's tail pin | `body.scrollTop = max` | every appended line, once per frame | `cardBodyHeld` (console.js:3674, 3685; 3700) |
| the console's own tail | `console.scrollTop = max` | every appended line, the 400ms sweep | `consoleHeld` (console.js:2396, 4218, 4339) |
| the 400ms sweep | `console.scrollTop = max`, the chip | every 400ms | `outDragging` (app.js:13131) |
| the browser's scroll anchor | `body.scrollTop` | content grows above the viewport | not stood down, on purpose (style.css:1559) |
| the browser's own clamp | `body.scrollTop` when `scrollHeight` shrinks under it | a shrink inside a scrollport | none, it is a layout consequence, not a write |
| the page's anchor compensation | `window.scrollTo` | any DOM change | `body.is-out-gripping` (app.js:9340) |
| `localStorage` | `wm.outHeights` | a release that moved | none |

The first line of that table and the last five are the whole story. The gesture writes a height and treats the top edge as a constant; the transcript's scroll is a writer of the top edge; and none of the three guards that exist (`consoleHeld`, `cardBodyHeld`, `outDragging`) covers the browser's clamp or the release's own foot write.

### 1.7 The poll, and the fold

Two of the brief's writers deserve their own paragraph because they are the ones that look most dangerous and are the ones that hold.

**The poll.** Every server event and every periodic read lands in one of four node-replacing rebuilds: `renderAll` (`public/app.js:10033`), `renderJobs` (`public/render-jobs.js:735`), `renderConversation` (`public/render-jobs.js:1071`), `renderProjectRows` (`public/render-projects.js:1637`). Each one asks the gesture before it touches the DOM, and each one defers rather than racing it: `public/app.js:10036`, `public/render-jobs.js:740`, `public/render-jobs.js:1093`, `public/render-projects.js:1642`. The 400ms repair pass asks too, and skips the console the hand is on (`public/app.js:13131`). So a poll cannot replace the node under the pointer today, and cannot re-pin the console or the transcript it is inside. What survives a gesture is the 400ms chip paint, which draws the tail chip and no size at all.

**The fold.** There are two folds and only one of them is a writer of the size. A turn's fold takes the console off the page; the number is not lost with the node because it is in `state.outHeights`, and unfolding builds the card again from `conversationHtml` and puts the number back through `applyStoredHeight` (`public/board/console.js:3818` to `3823`). A command card's fold is the other one: it rewrites a text node inside the console (4.4), and the gesture's own height writes are what schedule it, through the ResizeObserver at `public/board/console.js:3369`.

## 2. Where they disagree

`cardBodyHeld` stands the page's tail pin down for the length of the gesture, so no appended line can scroll the transcript while the hand is down. That is the fix from row 281 and it holds: `tools/verify-console-corner-slow-drag.mjs` measures 0px of top-edge movement across 40 steps in three shapes.

But the pin is not the coupling. In a scrollport that is at its foot, the maximum scroll offset IS a function of the console's height:

```text
max        = scrollHeight - clientHeight
scrollHeight includes the console's height
at the foot: scrollTop = max
```

So while the transcript is on its foot, changing the console's height changes `max`, and therefore changes where the top edge can be. Nothing has to write for that to happen:

- Grow the console by N. `max` grows by N. `scrollTop` stays where it is, so the top edge stays, and the corner follows the pointer. This is the down-drag, and it is why the gate passes.
- Shrink the console by N. `max` shrinks by N, `scrollTop` is now past it, and the browser's layout clamp moves `scrollTop` by -N. The content moves DOWN by N, the box's top moves DOWN by N, and the box's bottom, `top + height`, does not move at all. This is the up-drag, and no gate covers it.
- Then the release does the same thing in the other direction on purpose: `setScroll(body, scrollHeight)` after the size write scrolls the transcript to its foot, which moves the top edge UP by the drag's own travel, and the corner the gesture just put under the pointer goes back with it.

## 3. The physics, reproduced

The page below is the sheet's own chain of rules for the docked Chat pane, with no panel code and no gesture: a column flex scrollport (`public/style.css:6406`), a turn that is `flex: 0 0 auto` (`6436`), a console at `height: var(--out-h)` with `flex: 0 0 auto` (`6439`), and the sticky composer that sits below it (`6429`). The sheet's `* { box-sizing: border-box }` (`public/style.css:43`) travels with it, so a height written from a rect is the height drawn. A fixed 380px block above the console makes the transcript overflow, as a live conversation does.

```html
<div class="job"><div class="job-body" id="body">
  <div class="above"></div>
  <div class="turn"><div class="out-wrap"><div class="out-box"><pre class="job-out" id="out">...</pre></div></div></div>
  <div class="reply"></div>
</div></div>
```

The loop is the gesture's own arithmetic, then the release:

```js
const want = clientY + 2 - press.top;                 // outGripStep, app.js:10561
out.style.setProperty("--out-h", Math.round(want) + "px");   // setOutHeight, console.js:3753
// release, app.js:10722
body.scrollTop = body.scrollHeight;
```

Down, 40 steps of +3px, measured after each write. `corner` is the console's bottom edge minus where the drag put it:

```text
PRESS  scrollTop 117 of max 117  top -117  bottom 441  h 558

 step    pointer       h      top   bottom  scrollTop  corner
    1      442.0   561.0   -117.0    444.0        117    0.00
   10      469.0   588.0   -117.0    471.0        117    0.00
   20      499.0   618.0   -117.0    501.0        117    0.00
   30      529.0   648.0   -117.0    531.0        117    0.00
   40      559.0   678.0   -117.0    561.0        117    0.00

RELEASE (body.scrollTop = body.scrollHeight)
  scrollTop 237   top -237   bottom 441   h 678
```

The drag itself is exact: the pointer moves 117px (442 to 559), the height grows the same 117px (561 to 678), the top edge holds at -117, and the corner column is 0.00 at every one of the 40 steps. Then the release writes 120px of scroll: the top edge goes from -117 to -237, and the box's bottom from 561 to 441, which is the position it had at the press. The grip's bottom edge ends 0.00px from where the drag started, for 120.00px of travel. The size the reader chose is kept; the place they put it is not.

Up, from the same foot, 40 steps of -3px:

```text
 step    pointer       h      top   bottom  scrollTop  corner
    1      436.0   675.0   -234.0    441.0        234    3.00
   10      409.0   648.0   -207.0    441.0        207   30.00
   20      379.0   618.0   -177.0    441.0        177   60.00
   30      349.0   588.0   -147.0    441.0        147   90.00
   40      319.0   558.0   -117.0    441.0        117  120.00
```

The height follows the pointer, but the bottom edge pins at 441 on the very first step and never moves again: the box shrinks from the top while the pointer walks away from it. After 120px of travel the corner is 120px from the hand - the whole gesture, gone.

That is the same defect in both directions, and it is not a timing bug: it is arithmetic on an edge that is not free.

## 4. The seven candidates, one at a time

### 4.1 Two owners writing one size - PRESENT, ranked first

**The mechanism.** The console's height has one writer; the console's POSITION does not. At the foot, `scrollTop`'s maximum is a function of the console's height (section 2), so the scrollport is a second writer of the top edge the gesture froze at `public/app.js:10623`. During a gesture that writer appears twice: the browser's clamp on a shrink, on every move, and the release's own foot restore at `public/app.js:10721` to `10724`, after the size write at `10708`. `cardBodyHeld` (`public/board/console.js:3661`) stands down the page's tail pin and nothing else, and a clamp is not a pin.

**What proves it.** The probe in section 3, with the sheet's own rules: 0.00px of corner error across 40 steps of a down drag, then 120px of travel undone in the release's single write (the grip's bottom edge ends 0.00px from where the drag started), and a frozen bottom edge for the whole of an up drag. The prior measurement report contains the same number and reads it as a feature: `docs/reports/console-corner-slow-drag-2026-11-23.html` records the transcript's scrollTop held at 3036 for all 40 steps of a 120px drag and then "the release then puts the transcript back on its foot (3036 to 3156)", which is a 120px write after a 120px drag. The box's top was 443.7 during the drag and the grip's bottom 863.7; after that write the top is 323.7 and the grip is back at 743.7, the position it had at the press.

**What fixes it.** The gesture takes ownership of the scrollport's offset for the length of the drag, by delta, and the release stops forcing the foot. Option 1 in section 6 is the full form.

**How a test holds it.** The gate already collects the grip's rect at every step; it does not read it after the release. `tools/verify-console-corner-slow-drag.mjs:480` to `489` checks the transcript's foot and the height variable after the release, never the corner. Add the corner's position in the frame after `pointerup`, and add an up-drag shape (40 steps of -3px) with the same assertion. Today the down shape fails that assertion by the travel and the up shape fails it by the travel too.

### 4.2 A clamp in one place only - PRESENT, ranked third

**The mechanism.** Two paths decide the size and only one clamps. The release clamps to the sheet's floor and the room under the box (`public/app.js:10707`, `public/app.js:10568`). `applyStoredHeight` (`public/board/console.js:3778`) applies whatever positive number the store holds, with no floor and no room, and then LIFTS the sheet's cap to match the number (`public/board/console.js:3786` to `3787`). A 600px height chosen in a maximized card is therefore restored into a board row at 600px with `max-height: none`, in a pane whose sheet says 230 or 320. The restore removes the protection instead of clamping to it. There are three different floors in the code as well: the sheet's `min-height` read at the press, `FLOAT_OUT_MIN` for the float's own drag (`public/assistant.js:46`, `561` to `574`), and no floor at all on a restore.

**What proves it.** Reading the two paths side by side; and a stored number against a stub box whose computed cap is 320, which comes out of `applyStoredHeight` uncapped.

**What fixes it.** One clamp function, called by both paths: the release computes the room and the floor, the restore does the same against the pane it is landing in and never lifts the cap past that pane's room.

**How a test holds it.** A unit test over `applyStoredHeight` with a stubbed computed style: a 600px store into a 320px pane must land at or under the pane's room, and must not write `max-height: none` outside it. `test/console-height-store.test.js` already drives the store this way.

### 4.3 An invariant from a stale measurement - PRESENT, ranked fourth

**The mechanism.** Three numbers are frozen at the press and spent at the release: `d.min`, `d.cap` (`public/app.js:10630` to `10631`) and `d.top`. The release then measures `room` from the box's LIVE top edge (`public/app.js:10705` to `10706`) while the height it clamps was expressed from the FROZEN one (`public/app.js:10668`). When anything legitimately moved the top in between, the clamp and the arithmetic are talking about two different edges. The measured size of that drift is 0.75px in the ordinary "a row lands above" case and 86.25px when the browser's anchor is disabled (`docs/reports/console-corner-slow-drag-2026-11-23.html`, the "above" case), so this is a small error today and a large one in any body where the anchor is off.

There is a second, stickier half. Once a box has been dragged past the cap, its inline `max-height` is `none`, so the next press reads `parseFloat("none")` as NaN (`public/app.js:10631`) and the release takes the `"none"` branch at `public/app.js:10715` for every later drag: the sheet's cap is never re-applied to that node, even after the reader drags it back under the cap. The invariant is not just read stale, it is destroyed by one use.

**What proves it.** The two branches at `public/app.js:10715`, read in sequence; and a two-drag case on one box, the second one back under the cap.

**What fixes it.** Read the clamps at the release, once, and derive the cap from the sheet rule rather than from the inline value the last gesture left (`getComputedStyle` after removing the inline cap, or a class the gesture adds and removes).

**How a test holds it.** A two-drag case in the gate: over the cap, then back under it, asserting the computed cap is the sheet's again and the box is drawn at the height chosen.

### 4.4 A write in the wrong frame - PARTLY PRESENT, ranked fifth

**The mechanism.** The repaint guards hold. `renderAll` defers (`public/app.js:10033` to `10039`), `renderJobs` defers (`public/render-jobs.js:735` to `743`), `renderConversation` defers for the card that holds the console (`public/render-jobs.js:1091` to `1096`), `renderProjectRows` defers (`public/render-projects.js:1637` to `1645`), the 400ms sweep skips the box (`public/app.js:13131`), and the text writers ask `consoleHeld` (`public/board/console.js:2990`, `3091`, `4218`, `4339`). A poll cannot snap the box back mid-drag today.

What is not covered is one observer. `cmdFoldResize` (`public/board/console.js:3369`) watches every console (`public/board/console.js:2218` to `2220`), so every height write of the gesture fires it, and its callback schedules a flush (`public/board/console.js:3401`) that rewrites the text nodes of every command card inside the box being dragged (`public/board/console.js:3281`). That is the exact "text rebuilt under the pointer" the invariant forbids, in the frame after the write, and the flush asks nobody whether a gesture is live.

The residual of the same family is the deferred flush: when any repaint was pending, the release runs a full `renderAll()` inside the pointerup (`public/app.js:10728`), in the same task as the foot write. Two writes that can move the box, in the same frame, after the hand has let go.

**What proves it.** The observer's callback has no `consoleHeld` or `outGripLive` ask, and it is scheduled by the size change the gesture makes.

**What fixes it.** Ask `outGripLive()` in the fold flush and in `paintCommandFoldMark`, and run the deferred `renderAll` in the next frame rather than inside the pointerup.

**How a test holds it.** A source test that the flush names the gesture, beside `test/console-grip.test.js:146`; and a measurement that counts DOM writes under the pointer, which is the shape the slow-drag harness already wraps for `scrollTop`.

### 4.5 Rounding drift per move event - REJECTED

**The mechanism.** There is none, and that is worth saying plainly because it is the candidate most often guessed at. The height of a move is not accumulated: `outGripStep` is a pure function of the pointer, the grab and the frozen top (`public/app.js:10561` to `10564`), and `setOutHeight` rounds only the value it writes (`public/board/console.js:3755`). The error is bounded at half a pixel per frame and cannot accumulate, and the store receives the same rounded value the box draws (`public/app.js:10708` to `10716`). The probe shows it: the corner is at 0.00 for all 40 steps of the down drag. A drift would need an accumulator of the form `h += dy`, and there is none.

**What proves it.** `outGripStep` has no state; `test/console-grip.test.js:44` to `59` drives it with fractional inputs.

**What fixes it.** Nothing. What a future rewrite must not do is reintroduce an accumulator.

**How a test holds it.** Extend the existing arithmetic test with a 40-step loop over a fractional top and assert the corner's offset stays constant.

### 4.6 A gesture that outlives the pointer - PRESENT, ranked second

**The mechanism.** The gesture has no way to end itself when the console it holds is detached. `public/app.js:10665` returns from the move when `!d.out.isConnected` without clearing `outGripDrag`; the press refuses every new gesture while it is set (`public/app.js:10601`); `outGripLive()` stays true (`public/app.js:10586`), so every rebuild path keeps deferring (`public/app.js:10036`, `public/render-jobs.js:740`, `public/render-projects.js:1642`) and the board stops repainting. Nothing listens for `lostpointercapture` (`public/app.js:10731` to `10732`) even though the capture at `10642` is the only reason a release outside the window arrives at all. So a node replacement the guards miss, a capture lost to a window blur or an alt-tab, or a release outside the window after a capture that failed, leaves the grip dead and the board frozen until some later pointerup, which may never come.

**What proves it.** The source: the early return with no cleanup, and the missing listener. A bench can detach `d.out` and dispatch one move, then assert `outGripLive()` is false; today it is true.

**What fixes it.** End the gesture when the console it holds is gone (`if (!d.out.isConnected) return endOutGrip(e)`), and listen for `lostpointercapture` and `blur` to end it as well.

**How a test holds it.** A source assertion that the move's `isConnected` branch calls `endOutGrip`, plus the bench above. The gate's `pointercancel` shape covers the tidy half only.

### 4.7 A height restored before the layout that makes it valid - LATENT, ranked sixth

**The mechanism.** The height variable does not depend on layout, so the write order is not the problem. The cap does: `applyStoredHeight` lifts the cap from a measurement, `parseFloat(getComputedStyle(o).maxHeight)` (`public/board/console.js:3786`). A detached node has no computed `max-height` (the value is the empty string, so `parseFloat` is NaN), the lift is skipped, and nothing re-runs when the layout appears. Every current caller inserts before it restores - `public/render-jobs.js:1116` then `1127`, `public/app.js:9641` then `9645`, `public/assistant.js:2318` then `2325`, and `public/render-projects.js:1799` after the comment that says the rows are in the document - so there is no live path today. But the helper takes any root, and the line just above one of those callers builds exactly the detached holder that would break it (`public/render-jobs.js:1113`). The next render path that restores into a held fragment loses the reader's height silently, which is the same report as 2026-11-23's case 7: 420px dragged, 320px after the rebuild.

**What proves it.** The order in each caller, and an `applyStoredHeight` against a node with no layout.

**What fixes it.** Do not depend on the measurement: when a height is set from the store, the cap it needs is the pane's, and a `max-height: none` written with the height is honest whatever the pane's cap was measured as. Or store the above-cap flag with the number.

**How a test holds it.** A unit test that `applyStoredHeight` on a detached node still lifts the cap, beside `test/console-height-store.test.js`.

## 5. The ranking

The question is which ONE best explains a drag that is glitchy rather than slow, so the ranking is by how much a reader sees in the ordinary gesture, not by how bad the worst case is.

1. **Two owners writing one size (4.1).** It fires on every drag in the two panes the reader uses, in both directions: in the docked Chat pane and a maximized card the transcript is normally on its foot, and the release then puts the box back where it started, by the travel, in one step. The prior fix removed the same cancellation from the 40 steps of the gesture and left it in the release. That is the jump a hand feels.
2. **A gesture that outlives the pointer (4.6).** Rare, but when it fires the grip is dead and the whole board stops repainting, which reads as the panel being broken rather than the corner being jumpy. It is second because it is a one-directional trap: no amount of dragging fixes it.
3. **A clamp in one place only (4.2).** A stored height is restored without the clamp the release used, and the cap is lifted to match, so the same number is legal in one pane and illegal in another. The reader sees the box change size without touching it.
4. **An invariant from a stale measurement (4.3).** A few pixels in the ordinary case, and the cap is destroyed after one over-cap drag, which is what makes the second drag on a box feel different from the first.
5. **A write in the wrong frame (4.4).** The fold-mark flush under the pointer and the rebuild inside the release. Visible as a flicker in the text, or as a second move at the end of the gesture, not as a wrong size.
6. **A height restored before its layout (4.7).** Latent. No caller hits it today.
7. **Rounding drift per move (4.5).** Not present. The arithmetic is pure and the error is bounded.

The reason the same corner has come back three times is in this list: every fix re-derived the height, and the thing that keeps moving is the top edge. `docs/reports/console-corner-slow-drag-2026-11-23.html` says it plainly in its own section 4, then fixes the pin for the 40 steps of the drag and restores it in the release.

## 6. Four options for the fix

The measurement row owns the numbers these options should be judged by; this section is the shape of each change and what it costs.

### Option 1 (recommended): the gesture owns the offset by delta, and the foot is given up for the resize

Two changes, both in `public/app.js`, and no change to `public/board/console.js`:

- Track the transcript's offset in the drag record. At the press, `d.bodyTop = d.body.scrollTop` (the press already forces a layout for the rect, so this is free). On a move where the height SHRINKS, write the same delta back: `d.body.scrollTop = Math.max(0, d.bodyTop + (h - d.written))`, and keep `d.bodyTop` in step. The browser's clamp then cannot lower the top edge, because the write lands exactly on the new maximum. On a grow, nothing is written, because nothing clamps.
- At the release, do not write the foot. Replace `setScroll(d.body, d.body.scrollHeight)` (`public/app.js:10722`) with `noteCardBodyScroll(d.body)`, so the panel records the truth: the resize took this transcript off its foot. The console's own tail keeps the newest line in view (`public/board/console.js:4339`), and following resumes the moment the reader is back on the foot.

The corner cannot be cancelled by construction, because the only scroll write the gesture makes is the same delta the height moved by. The cost is a visible behaviour change: after a resize in a following transcript, the transcript sits a few pixels short of its foot and the composer sits with it, until the reader scrolls back. That is the honest state of a transcript whose console the reader has just made taller.

The gate holds it: a corner assertion in the frame after `pointerup`, plus an up-drag shape and a shrink-past-the-foot shape.

### Option 2: keep the corner, drop the foot entirely for a resized turn

The same release change as Option 1, and instead of a per-move write, the console is taken out of the transcript's arithmetic for the length of the gesture by holding the body's scroll at the press value with `overflow: hidden` on the scrollport and its `scrollTop` preserved. A scrollport that cannot scroll cannot clamp, so the top edge is genuinely frozen and the corner follows in both directions. The release restores `overflow` and the offset, which lands wherever the content puts it: the box moves once, at the end, by the whole travel.

Cheaper in code than Option 1 and worse for the reader: it moves the jump from "at release, always" to "at release, still", and a hidden scrollbar mid-gesture is its own tell.

### Option 3: track the edge instead of freezing it

One `getBoundingClientRect` per move, and the frozen top is corrected by the drawn one: `d.top += (r.top - d.drawnTop)`, with `d.drawnTop` updated after each write. This absorbs the clamp, the anchor's drift, and anything else that moves the edge inside one frame, and it needs no change to the release's scroll behaviour.

The cost is the thing this file was written to avoid: a forced layout per pointermove, at the pointer's own rate (which is several times the frame rate on a good mouse), on a page the console work has measured at 55k nodes (`public/board/console.js:2196` to `2200`). It also leaves the release jump, because the release's foot write happens after the last correction.

### Option 4: take the console out of the transcript's scroll

The structural answer: in the docked pane and a maximized card, draw the open turn's console in a region of its own below a scrolling history, so the console's height is not part of the transcript's `scrollHeight` at all. Then the height and the offset are independent by construction, and no gesture arithmetic can be cancelled by a pin, an anchor or a clamp.

This is the only option that removes the class rather than the instance. It is a layout change to the two panes with the most follow and fold behaviour in the page, so it is a design of its own, not a landing for this row.

### And three small ones that ride along, whichever option lands

- The lostpointercapture and detached-node ends for the gesture (4.6), which are a handful of lines and stop the board freezing.
- The `outGripLive()` ask in the fold flush (4.4), one line.
- The clamp on restore and the cap that is not destroyed by one use (4.2, 4.3), which belong with whichever row next touches `applyStoredHeight`.
