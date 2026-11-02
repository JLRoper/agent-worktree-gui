# One console size for normal, reasoning and tool text was already landed — record of the re-check

The brief asked for one font size driving a card's normal output, its reasoning and a tool's output,
and for Ctrl+wheel over any of that text to zoom all three together instead of only the console's
words — plus a unit test pinning the three selectors to the same computed size, a browser gate, a
minor bump and a PR. All of that is already on `main`, landed by PR #186; this tree was cut from
`main` after the landing and carried no commits of its own, so nothing was re-landed and no product
code moved here.

## What is on main, and where it came from

PR #186 (`wtgui/unify-console-text-sizin-c095c1`, "feat: one console size drives normal, reasoning
and tool text") is one commit, `8237843`, landed as a rebase merge (`mergedAt` 2026-11-02T00:48:34Z).
`git merge-base --is-ancestor 8237843 origin/main` is true. `git show 8237843:package.json` reads
`0.50.0` and its parent `c063405` reads `0.49.3`, so the minor the brief asks for travelled with the
commit that carries the change. Later landings took `main` to `0.50.1` (`cea6dfe`, #187), `0.50.2`
(`2d80df0`, #188), `0.51.0` (`65f1e8e`, #189) and `0.51.1` (`14c27c3`, #190) before this record
was written.

Nine files, +728/−158: `public/style.css`, `public/app.js`, `public/index.html`,
`test/text-styles.test.js`, `tools/verify-console-zoom.mjs`, `docs/using-the-board.md`,
`docs/console-expand.md`, `tools/verify-text-styles.mjs`, `package.json`.

## The shape it has, against the brief's list

- **One variable.** `--term-size` is declared once on `:root` at `public/style.css:39`, under a
  comment saying it is the ONE console size and that a card overrides it in its own inline style.
  Settings' Console size writes it through `applyTermStyle` (`public/app.js:16451`, the
  `setProperty("--term-size", …)` at `:16454`).
- **Every kind resolves to it.** `.job-out` `font-size: var(--term-size)` (`style.css:992`),
  `.think-block` (`:707`), `.think-block.mono` (`:711` — two classes, because the blocks also carry
  `.mono` and a single-class rule would lose to its 12px), `.jl-think` (`:1020`) and `.jl-tool-out`
  (`:1125`, which used to set no size at all and inherit its wrapper). No `--out-size`,
  `--think-size` or `--think-font-size` survives in the sheet.
- **One wheel handler, one write.** `onConsoleWheel` (`app.js:14228`) is a single capture-phase
  `window` listener for `wheel`/`gesturestart`/`gesturechange` (`{ passive: false, capture: true }`,
  `:14237`) that guards `ctrlKey`, matches `.job-out, .think-body`, cancels and stops the event, then
  steps once through `zoomConsole` (`:14210`). The step starts from `cardConsoleSize` (`:14205`),
  which reads the CARD's computed `--term-size` — not the element under the pointer, since a
  `.think-body` carries no size of its own — and writes `card.style.setProperty("--term-size", …)`.
  Half-pixel steps, clamped 7–24 (`:14200-14202`).
- **Per-card, and it survives a repaint.** The zoom lives in `state.consoleZoom` (`app.js:56`), and
  the card renderer re-emits it as an inline var (`const sizeVars = zoom ? \`--term-size:${zoom}px\`
  : ""`, `:4263`), so `renderConversation`'s replace does not lose it.
- **The Thinking row has no second knob.** `public/index.html:129` is the row: its tooltip says the
  SIZE is the console's own and that Ctrl+wheel moves all three, and the only control it carries is
  `id="think-color"` (`:131`) — there is no `think-size-select` anywhere in the page.
  `retireTextStyleSize` (`app.js:16497`) removes the retired `wtgui.thinkSize` key at start-up
  (`:17456`) rather than leaving a key that nothing reads.
- **Docs.** `docs/using-the-board.md:655-670` says the console has ONE size for all of its text and
  that a size chosen in Thinking text before this version now follows Console size; the shortcuts
  table at `:887` and the zoom row at `:817` describe the scoped Ctrl+wheel. `docs/console-expand.md:93`
  and `:215` carry the store and the reload rule (a zoom is in memory; the size that persists is the
  one Settings keeps).

## Re-checked on this tree, at `origin/main` `65f1e8e` (0.51.0), re-read on `14c27c3` (0.51.1)

Run 2026-11-01 between 21:50 and 21:57 EST (`date` read `21:56:41 EST`, `date -u`
`2026-11-02 02:56:41Z`) from
`C:/ProjectDevelopment/agent-worktree-gui/.worktrees/unify-console-text-sizin-15bd0c`:

- `git rev-list --left-right --count origin/main...HEAD` → `0 1` on this commit, and `0 0` before it:
  the tree was cut on `main`'s tip and had nothing of its own to land, so this record is its only
  commit.
- `node --test test/text-styles.test.js` → **12 tests, 12 pass, 0 fail**. The case at `:131` ("the
  three kinds of console text compute the SAME font-size, at the default and at a card's zoom") reads
  the shipped declarations for `.job-out`, `.jl-think` and `.jl-tool-out` plus the 🧠 block's two
  rules, asserts each asks for `var(--term-size)`, then resolves them the way a browser would over
  `11.5px` and over a card's `14px` and deep-equals the set to one size. `:128` asserts no retired
  size variable survives, and `:143` that Ctrl+wheel writes that one variable on the card.
- `npm test` → **742 tests, 742 pass, 0 fail, 0 cancelled, 0 skipped** in 84.2 s.
  `node tools/version.mjs check` exits 0 against `origin/main`.
- `node tools/verify-console-zoom.mjs` → **14/14 checks per mode, both modes, exit 0**
  (`OK one size drives the console's words, a tool's output and the reasoning, and Ctrl+wheel moves
  all three per card`). Measured computed sizes, 🌊 stream and 🧠 block alike:

  | step | normal | reasoning | tool |
  | --- | --- | --- | --- |
  | default, card A and card B | 11.5 | 11.5 | 11.5 |
  | Ctrl+wheel up over the console (card A) | 11.5 → 12.5 | 11.5 → 12.5 | 11.5 → 12.5 |
  | …over the reasoning | 12.5 → 13.5 | 12.5 → 13.5 | 12.5 → 13.5 |
  | …over a tool's output | 13.5 → 14.5 | 13.5 → 14.5 | 13.5 → 14.5 |
  | wheel down over the reasoning | 14.5 → 13.5 | 14.5 → 13.5 | 14.5 → 13.5 |

  Card B read `11.5 → 11.5` at every step (per-card independence); a repainted card re-emitted
  `card var 13.5px` and kept all three; Console size set to 13 moved the never-zoomed card to
  `13 · 13 · 13` while the zoomed card stayed at 13.5; the Thinking row reported
  `hasThinkSize: false` with all three previews at 13px; after a reload every card and every kind
  read the stored 13; the page threw nothing.

## The red proof, at the parent commit

`git archive 8237843^` (that is `c063405`, version `0.49.3`) extracted to a scratch export, with
this branch's `tools/verify-console-zoom.mjs` copied into it and `git init` run so the tool's own
`rev-parse` works: **13 FAIL + 1 PASS per mode, exit 1**. Measured there:

| step | normal | reasoning | tool |
| --- | --- | --- | --- |
| default | 11.5 | **12** | 11.5 |
| wheel over the console | 12.5 | **12** | 12.5 |
| wheel over the reasoning | 13.5 | **12** | 13.5 |
| wheel over a tool's output | 14.5 | **12** | 14.5 |
| repainted card | 13.5 | **12** | 13.5 (`card var null`) |

Reasoning was pinned at 12px by `.mono` while the console and tool output moved, the card carried no
`--term-size` at all, and the Thinking row still offered a size of its own — which is exactly the
defect the brief describes, and the gate is red on it.

## Version

`0.51.2`. Patch, not minor: this commit adds a document and moves no product code, which
`docs/versioning.md` files under patch. The minor the brief's list asks for was already spent by the
landing that carries the feature — `8237843` took `0.49.3` → `0.50.0` — so a fresh minor here would
only inflate `main`'s number for a record. The first cut of this record bumped to `0.51.1`; while the
PR was open the console-grab record (#190) landed `0.51.1` too (`14c27c3`), so the branch was rebased
onto that tip and re-bumped one patch above it. Nothing under `public/`, `test/` or `tools/` differs
between the two tips (`git diff --stat 65f1e8e 14c27c3 -- public test tools` is empty), so the
measurements above describe the code this commit lands. `node tools/version.mjs check` passes against
`origin/main` (`14c27c3`, `0.51.1`).
