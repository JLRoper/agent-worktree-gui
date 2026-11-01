# An open console in the combined layout: does it still land on its first line?

Asked of this tree (0.35.1): in the **combined** layout - the reasoning drawn as rows **inside** the console (🌊), so a
card has one scroll box instead of two - does an open console still land on its first line while other agents are running
on the same board?

**No frame paints it there. But `scrollTop` does reach 0, and no writer asks for it.**

> 5,083 `scrollTop` writes on four combined consoles in 60 s with three other agents streaming: **0** left a pinned box
> off its newest line, **0** landed a box on its first line while asking for anything else, and **0** of 4,419 frames
> read `scrollTop 0` on a box the panel believed was pinned. The **110** times the value reached 0 in the same window it
> was the browser, not the page: `fillAgentSlots`'s `replaceWith` of the agent slot (`public/app.js:11112`) takes the
> card out of the page, and a scroll box inside a removed subtree comes back at 0. `restoreScrolls` (`:7109`) and
> `applyStoredScrolls` (`:7120`) hand the place back **in the same task**, which is the whole reason none of those 110
> clamps was ever painted.

This is the **write-logging** route, not frame sampling: `tools/measure-console-writes.mjs` wraps `scrollTop`'s setter and
the `scrollTop` / `scrollHeight` / `clientHeight` getters on `Element.prototype` before `public/app.js` parses, so every
write is logged with its value before, its target, the value it landed on, the geometry at that instant, whether the box
had a layout at all, and the page callers' `file:line` - and every change of `scrollTop` that **no** write explains is a
row in its own ledger with the DOM operation that sat in the gap. No product file was changed by this note.

Line numbers here are the **statement that ran**, as the instrument reported it on this tree - `fillAgentSlots:11112` is
the `slot.replaceWith(card)` line, `placeRow:12788` is its `fillAgentSlots(dEl, oldCards)` call, `restoreScrolls:7109` is
its `setScroll`. `main` moves them; `grep -n` for the function, not for the number.

---

## 1. The condition that was driven

| | |
| --- | --- |
| tree | `C:/ProjectDevelopment/agent-worktree-gui/.worktrees/find-out-whether-an-open-7ea054`, this branch on `main` @ `ac2ea8a`, 0.35.1 |
| tool | `tools/measure-console-writes.mjs` (its own throwaway panel on a spare port, its own `PANEL_CONFIG` / `HERMES_HOME` / `jobs.json`; the reader's panel is never touched) |
| layout | `busy` - **four** live consoles in four rows of two projects, so three agents are writing while a fourth is read |
| mode | `--stream` - every card drawn as ONE console with the reasoning combined into it (`paintStreamConsole` / `syncStreamConsole`, the 🌊 renderer) |
| window | 60 s of writes per run, after all four consoles overflow their box |
| card bodies | `/api/thinking` answered by the stub: the first block grows on every 1.2 s poll and a new one appears every 4th, so the console's **first** row keeps extending above a reader who is parked (`streamRows: {rows: 2, keyed: 2}`) |
| gesture | the page's own: a real wheel over the first console (the fallback dispatches the same `wheel` event the page listens for when the box is off the viewport), and in the second run a real click plus a keypress into a reply box every 400 ms |

```bash
node tools/measure-console-writes.mjs --only busy --stream --seconds 60 --json <out>.json
node tools/measure-console-writes.mjs --only busy --stream --type --seconds 60 --json <out>.json
```

Each run ends with the tool's own self-test, which is what makes a clean window mean something: it drives a write to 0
repaired 40 ms later (both writes must appear with their callers, and the frames between them must be off the bottom) and
a raw re-append of a section carrying a console (**no** write at all, and the recorder must call it a hop). Both steps
passed in both runs below. The tool needed one fix first: the self-test used to pick the console with the most room,
which on a `--stream` run is the box the reader parked at the top - "before 0, jumped 0" makes step (1) vacuous. It now
prefers a box that is off its bottom (see §5).

## 2. The numbers

| | run 1 (reader parked) | run 2 (reader typing) |
| --- | --- | --- |
| consoles / window | 4 combined, 62 s | 4 combined, 66 s |
| frames sampled | 3,589 | 4,419 |
| `scrollTop` writes with a target | 4,604 | 5,083 |
| …that moved a box **up** | 0 | 0 |
| …that left a **pinned** box off the bottom | 0 | 0 |
| …into a box with **no layout** | 0 | 0 |
| …that **landed** a box on its first line (`scrollTop 0`) | **1** | **1** |
| …of those, the writer **asked for 0** | 1 | 1 |
| …of those, the writer asked for more and the browser landed 0 | 0 | 0 |
| changes of `scrollTop` with **no write at all** | **95** | **110** |
| …all DOWN to 0 | 95 | 110 |
| …`scrollHeight` unchanged (nothing arrived to explain it) | 95 | 110 |
| frames reading `scrollTop 0` on a **pinned** box | **0** | **0** |
| frames reading `scrollTop 0` on the box the reader parked | 23 | 27 |
| painted excursions off the bottom | **0** | **0** |
| self-test step 1 / step 2 | OK / OK | OK / OK |

Per caller, every write in the window (run 2; run 1 is the same shape):

| caller | site | writes | landed at 0 | asked above the bottom |
| --- | --- | --- | --- | --- |
| `paintTypedLines` | `app.js:6454` | 3,008 | 0 | 0 |
| `drawJobLine` | `app.js:7882` | 1,697 | 0 | 0 |
| `restoreScrolls` | `app.js:7109` | 111 | 1 | 0 |
| `applyStoredScrolls` | `app.js:7120` | 111 | 0 | 0 |
| `paintStreamConsole` | `app.js:6687` | 108 | 0 | 0 |
| `releaseScrolls` | `app.js:7200` | 48 | 0 | 0 |

The one write that landed a box on its first line is the parked box, put back where the reader left it: the park gesture
on a short console takes the box to the **very top** (`parkState: {dist: 95, max: 95}` - a box with 95 px of scroll, all
of it scrolled away), so its remembered line *is* 0 and `restoreScrolls` writing 0 is the restore working, not a defect.
The instrument judges that correctly because it records the panel's own pin state per box per frame: a write that leaves a
box above its bottom is only a defect on a box the panel believed was **pinned**, and none of these were.

## 3. Every clamp, with its caller

Two shapes in run 2, one in run 1 - all of them through the same `replaceWith`, with `scrollHeight` unchanged:

```
scrollTop changed with no write: <box> 129 -> 0 (-129 px, height +0, max +0)
  in the gap: replaceWith div.agent-slot
              by fillAgentSlots|app.js:11112 < placeRow|app.js:12788 < flush|app.js:12672    104x (run 2), 95x (run 1)
              by fillAgentSlots|app.js:11112 < renderProjectRows|app.js:12946 < sse.js:107      6x (run 2 only)
```

- `fillAgentSlots` replaces the detail's `.agent-slot` with a fresh one and moves the live card into it
  (`public/app.js:11112`). The card leaves the page, and the browser gives every scroll box inside it `scrollTop 0`.
- Two entry points, one move: the 5 s `row` pass rebuilds a row's detail (`placeRow`), and a `project` SSE frame rebuilds
  the project's rows (`renderProjectRows`) - 104 and 6 in run 2. Run 1's window carried no project frame.
- Evenly across the four consoles: 26 / 30 / 29 / 25 in run 2 - so this is not one row being rebuilt more than its
  neighbours, it is every row's card being carried on the same pass.
- The ledger's gap (the previous write on that box, the clamp, then this write) is 4-92 ms in run 2: one task, not one
  frame, and nothing to paint in between.
- The repair is the same task's `restoreScrolls` / `applyStoredScrolls` (`public/app.js:12796-12797` in `placeRow`), plus
  `releaseScrolls` (`:7200`) for the rows a re-rank moves.
- `placeRow` captures every console's top **before** the card leaves (the `outs` map at `public/app.js:12761`) and
  restores it after `fillAgentSlots` - the order that keeps the clamp off the screen. `test/console-independence.test.js`
  now reads that order, and models the swap with the page's own `captureScrolls` / `restoreScrolls`.

So the answer to "does it land on its first line" is: **the value does, about twice a second, and the frame never does.**
The clamp is a card move, and the code that survives it is the same-task restore - the one thing this note cannot prove is
what happens on a path where that restore lands in a **later** task (see §4).

## 4. What this settles, and what it does not

Settles:

- Nothing about the **other three agents** puts an open combined console on its first line. Zero writes moved a box up,
  zero landed a pinned box anywhere but its newest line, zero frames painted a pinned console at 0 - across two 60 s
  windows with four consoles streaming, a re-rank clock, the 400 ms stick sweep, the 1.2 s thinking poll and (run 2) a
  reader typing into a reply box the whole time.
- The combined console's own repaint is not the cause and cannot be: `syncStreamConsole` patches keyed rows inside the
  box and never replaces the box (`paintStreamConsole` wrote 108 times in run 2, every one of them landing on the
  bottom). A repaint that replaced the console node instead would be a fresh scroll area at 0, which is why the model
  test states that rule (`test/console-independence.test.js`, "the 🌊 repaint patches the console's rows").
- The one mechanism that does put the value at 0 is a card carried into a fresh agent slot, and it is repaired inside the
  task - by `placeRow` for a row pass, and by `renderProjectRows` for a project frame.

Does not settle:

- **A real combined stream.** The stub's console body is two keyed rows; a real turn has dozens of `.jl-think` rows and
  tool groups. `syncStreamConsole`'s relative correction (`public/app.js:6675`) needs a row above the reader's line whose
  height moves, and this drive has one - but the *patch* path over a long body is not what was measured here.
- **A restore that misses.** The failure this note's numbers cannot exclude is a clamp whose `restoreScrolls` runs in a
  later task (a path that reads layout between the move and the restore), or a card missing from the `outs` map. The write
  log would show it as a silent move to 0 with no repair before the next frame, and the painted series would show the
  excursion. Neither appeared here; neither is excluded elsewhere.
- **The separated layout's own count.** All six layouts in `tools/verify-console-independence.mjs` are separated (two
  boxes per card); `--stream` is the only browser drive of the combined console, and it is in the write tool. A combined
  layout in the frame-sampling gate is not built.

## 5. The tool change this needed

`tools/measure-console-writes.mjs`'s self-test picked the console with the most room. On a `--stream` run that is the box
the reader parked at the top, so step (1) reported `before 0, jumped 0` - a FAIL that was vacuous rather than a finding
(one run hit it before the fix). It now sorts a box that is off its bottom ahead of one with more room, so the jump is
always driven on a box that has somewhere to fall from. The measured numbers are unchanged by this: it only chooses which
box the self-test drives, after the window has closed.
