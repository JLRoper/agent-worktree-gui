# The console, watched while the card is rebuilt

The reasoning block has `docs/thinking-block-live-observation.md`. This is the other pane on the same card: the
normal console, the one that carries the agent's tool calls and their output. Its failure mode is not a poll — it is
a repaint followed by a live line.

Measured 2026-10-30 with `tools/measure-console-live.mjs`, on this tree (0.29.0, based on main's `4916b6e`) and on a
`git archive` export of `d63971f^` — the commit before the console fix landed. Every number below is a read-back from
`C:/CodeReviews/agent-worktree-gui/console-live-*.json`.

## What it is

`drawJobLine` decides whether an arriving line replaces the console or joins it. It used to ask whether the console's
first **child** was a `.jl-dim` row, which is right for the "waiting for output…" placeholder and wrong for a real dim
note — and every worker turn starts with one ("⇢ asked to work in …", "⇢ seeded this tree's TODO list…", "cut from
…", "push guard: …"). Any full repaint (the thinking sweep, a new deliverable, an approval) puts that note back on top,
so the next live line wiped everything the reader had and drew only itself, until the following repaint put it back.

## The measurement

One real finished run, drawn read-only from its own record and its own lines in a sandbox panel of its own; then the
panel's own `renderConversation` (a repaint) and its own `appendJobLine` (one more line), with the console sampled on
every painted frame and the reply box under it measured by its top edge.

| | export of `d63971f^` | this tree |
| --- | --- | --- |
| console rows before the repaint | 107 | 107 |
| after a full repaint | 107 | 107 |
| after ONE live line | **1** | 108 |
| console content height | 571 → 571 → **64 px** | 571 → 571 → 619 px |
| reply box top (unchanged window scroll) | 789 → 789 → **625** (164 px up) | 789 → 789 → 789 |
| checks | **4/6** — the wipe and the jump | 6/6 |

So on the pre-fix build a repaint plus one line took a 107-row console to a single row, its content from 571 px to
64 px, and pulled everything under it 164 px up the page — that is the see-saw, and it is not the reasoning block. On
this tree the same repaint and the same line leave every row in place and append the new one.

```
node tools/measure-console-live.mjs                                  # this checkout — 6/6
node tools/measure-console-live.mjs --root <export of d63971f^>       # the pre-fix build — 4/6, rows 107 → 1
```

The console is a fixed-height scroll box (230 px, content 571 px here), so on a healthy build the reply box does not
move at all when a line arrives; the check is that it is never pulled **up**.

## What is driven, and what is not

- **Driven:** a sandbox panel of its own (free port, own config/jobs/projects cache, assistant off, gateway aimed at a
  closed port), one card drawn client-side from a REAL run's record and lines read read-only out of the panel's job
  store, one full repaint, one live line through the panel's own entry point. No turn is started and no line is
  invented.
- **Not driven:** the live wire itself. A live console needs a turn, and this tool refuses to start one.
  `tools/verify-console-flicker.mjs` is the harness that plays a scripted turn through a stub Runs API and gates the
  same claims on the wire (plus the parked-reader and deliverable scenarios). This tool is the real-content
  counterpart: a gate that fails if the wipe comes back.
- **Skipped:** a store with no run carrying 20+ console lines and 5+ tool lines, one whose consoles all open on a tool
  call rather than a dim note (the wipe path would not be armed, and a green run would measure nothing), or a box with
  no Playwright.

One deliberate limit: the runs it draws are finished, so the card is presented as running to keep its console live —
the transcript is the run's own, the status is not.

## The same console, drawn as ONE stream

A 🌊 card keeps the same transcript, with the reasoning interleaved as rows of that console instead of a block above
it (`public/core/stream-merge.js` decides where each block goes). That console is the only one on the card that is
**polled**: `loadThinking` reads the reasoning back every ~1.2 s while a turn runs and `paintThink` → `paintStreamConsole`
redraws the console. The redraw was one `innerHTML` assignment, so the fault `686bac4` cured one level up — a console
node replaced under the reader, several times a second — was still open one renderer down: every poll threw away every
row, the reader's selection with it, and a shorter read collapsed the pane.

`--stream` measures it on the same real run, with the reasoning that run's own thread recorded read back out of the
session store (`<HERMES_HOME>/state.db`, the read the route does — 60 blocks / 102,847 chars here):

| | export of `dad67fc` | this tree |
| --- | --- | --- |
| rows before the poll / after it | 167 → 167 | 167 → 167 |
| row NODES still the same after the poll | **0 of 101** | **101 of 101** |
| a selection standing in the console, after the poll | **lost** (`"I'll start by getting…"` → `""`) | kept |
| a poll whose body drops the reasoning rows | **167 → 107 rows, 10,073 → 2,207 px, scrollTop 9,845 → 1,979** (pulled up 7,866 px) | draws nothing: 167 rows, content never shrinks |
| one live line after a poll | 108 rows (into the collapsed pane) | 168 rows, height 8,503 → 12,609 |
| checks | **6/10** | 10/10 |

The fix is `syncStreamConsole` in `public/app.js`: a poll patches the console instead of replacing it. A row whose
words did not move keeps its **node** (so a selection inside it is still the reader's), a new row is inserted where it
belongs, rows the turn's window has dropped are removed from the top, and the reader's first visible row is put back
where it was. A body that would drop rows from the middle or the tail — a failed store read, a shorter answer
mid-turn — draws nothing at all, the same rule `loadThinking` follows for the blocks it already has. A trimmed window
still draws: it loses rows off the **top**, which is the only shrink a live turn produces on its own.

```
node tools/measure-console-live.mjs --stream                         # this checkout — 10/10
node tools/measure-console-live.mjs --stream --root <export of dad67fc>   # the pre-fix build — 6/10, 0/101 nodes
node tools/measure-console-live.mjs                                  # the condensed console — 6/6
```

`--stream` needs a turn that actually reasoned: a thread with no blocks in the store is a SKIP, not an empty console
measured as if it were a stream. `--blocks <file>` replays a dump of the route's own answer instead.

The same rule is gated on the wire: `node tools/verify-console-flicker.mjs --only stream` plays a scripted turn through
a stub Runs API and now asserts, per sweep, that the transcript above the console's newest rows keeps its own nodes
(`every sweep patches the console`). It reads 0 of them on an export of `dad67fc` and all of them here; the tool's
other 27 checks are unchanged, and `repainters: an approval arriving mid-turn is one of those rebuilds` fails on both
builds (the harness's park is re-stuck before the approval lands), which is older than this patch.
