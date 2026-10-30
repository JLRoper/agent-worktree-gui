# The reasoning block, watched live

Two real agent turns on a real gateway, one card with 🧠 on and one standard, sampled every painted frame. The
question was whether the flicker is visible at all in a browser, and where it lives.

Measured 2026-10-29 on this tree at `7c3d8cc` (before the redraw fix), and again on an export of `dd80631` (after it).
Every number below is a read-back from `C:/CodeReviews/agent-worktree-gui/thinking-live-*.json`.

## The instance

A sandbox panel of its own on a spare port, started from the tree under test, with its own `PANEL_CONFIG`,
`jobsFile`, projects cache and assistant off — so the reading panel's port and data are untouched. It talked to the
real Hermes gateway on `127.0.0.1:8642`, and the two turns ran in a throwaway git repo.

- **reasoning card** — thread `probe-think2`, 🧠 on, deepseek v4.1 flash: 10 `read_file` calls one at a time, then
  `git status --short`, `git log --oneline -3`, `ls -la src`, then two paragraphs. 84 s live.
- **standard card** — thread `probe-plain2`, same gateway and repo: `ls`, `date`, `git status --short`, `ls -la src`,
  one sentence. Finished in about 30 s.

The page recorded, per painted change and on both cards: the console's child count, `.jl` rows, `.jl-tool` rows, group
count, `scrollHeight`/`clientHeight`/`scrollTop`; the thinking body's drawn text length, its blocks by `data-lid`, its
scroll position; the card's own rect; `scrollY` and the document height. It also wrapped `paintThink`,
`renderConversation`, `paintStreamConsole`, `drawJobLine`, `renderProjectRows`, `renderAll`, `renderJobs`, and every
`/api/thinking` response.

## What the console did: nothing

Over 84 s and 33 card rebuilds the console only grew, and the card never moved on its own.

| | reasoning card | standard card |
| --- | --- | --- |
| painted states | 133 | 41 |
| console rows | 1 → 53 | 1 → 13 |
| tool rows | 0 → 13 | 0 → 3 |
| console height changes | 28, all growth (median +20 px, largest +190 px = one result box opening) | 5, all growth |
| card top changes with `scrollY` unchanged | 0 | 0 |
| wholesale writes to `pre.job-out` in the live path | 0 | 0 |

The one apparent 39 px move at 17.39 s is the probe's own `scrollIntoView`: `scrollY` went 2047 → 2008 in the same
frame pair, so the card held its screen position. The console is append-only; a turn's tool calls join existing burst
groups and nothing rewrites the pane.

## What the reasoning block did: moved on its own, one frame at a time

The 🧠 block is the only pane on a card that is polled and redrawn: in a 61 s stretch of one live turn `/api/thinking`
was called 26 times — once every 2.4 s — and each answer replaces the whole `<details>`. Three things are visible in
the captures:

1. **The block types.** A newly drawn block is fed to the pacer at the reader's words/s, so its text length grows
   between polls: 76,525 → 105,250 → 129,678 characters across the three reads of the fixed run, monotonic.
2. **A new block is drawn empty for one frame.** `paceThinkBlock` returns the pacer's prefix, which is `""` the first
   time a block is fed. Measured on both builds: at 2,498 ms (this tree) and 2,567 ms (fixed) the body held 60 blocks
   and 0 characters — `scrollHeight 8`. The block's pane collapses to nothing and grows back as the words arrive.
   This is one frame of an empty div, which is why it is easy to miss. It is the same on both builds and is the
   typing reveal, not a redraw fault.
3. **An empty read blanks the block.** This is the one a reader sees.

## The flicker, measured

The panel reads the turn's thoughts from the session store. A read that fails and a turn that thought nothing are
the same bytes to the page (`200 { blocks: [] }`) unless the answer carries its own error.

One injected `{ blocks: [] }` answer, on a live block holding 76,306 characters of real reasoning:

| | this tree (`7c3d8cc`) | export of `dd80631` |
| --- | --- | --- |
| drawn before the read | 76,306 chars / 60 blocks | 76,525 chars / 60 blocks |
| the frame after it | **53 chars / 0 blocks** (`scrollTop 0`, `scrollHeight 18`) | 76,525 chars / 60 blocks |
| the next poll (2.4 s later) | 105,250 chars / 60 blocks | 105,250 chars / 60 blocks |

So on the pre-fix build a single empty answer takes the whole block away — a 260 px pane of 60 blocks collapsing to
one line — and the next poll puts it back, about 2.4 s later. That is the see-saw, and it is why it looks like the
reasoning "flickers" while the console beside it streams steadily.

`tools/measure-thinking-live.mjs` reproduces exactly this, read-only: it draws one card from a real session id (no
turn is started, nothing is posted, the store is opened read-only) and injects one empty read.

```
node tools/measure-thinking-live.mjs                                 # this checkout — 4/5, the fall to 53 chars
node tools/measure-thinking-live.mjs --root <export of dd80631>      # the fixed build — 5/5, no fall
```

The failing check on the pre-fix tree is `one empty read does not take the block's text away`; the other four
(the block drew real reasoning, the injected read reached the page, the text and its place survive, no page errors)
pass on both. The gate skips itself when the store has no session with two or more reasoning blocks, because a
fixture would measure the fixture.

## Not the console

Two independent things look like "the console flickers", and neither is the console: the burst group is re-cut on
each append (the node is replaced, nothing else moves), and the thinking block is redrawn on the store's clock. The
console is appended to and only grows. When a report says the output jumps, measure both panes before naming one:
the block's `scrollHeight` moves on its own, the console's does not.
