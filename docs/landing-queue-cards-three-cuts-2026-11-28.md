# Landing: the queue cards cut three ways (public/queue-cards.js, entry 8 of the module-separation plan)

`public/queue-cards.js` was one 1,254-line closure with 73 internal bindings: the row, the full card, the drag, the
paint, the two reads and the one write path all shared one scope, so a row that changed a chip and a row that changed
the drag opened the same file. Row 532 is entry 8 of `docs/reports/module-separation-2026-11-28.html`'s split plan,
and this landing makes the three cuts the report names, one commit each, with no body rewritten and no call site
touched. The file is now the entry point and nothing else.

## What landed

- **Cut 1, `57334958`** - `public/board/queue-row.js` (new, 586 lines) and `public/queue-cards.js` 1,339 -> 840.
  `public/board/queue-row.js:52` is the factory; `:57` its marker; `:66` the read cache; `:488` `queueProjectName`,
  which came with the cut although the report puts it further down, because the agent row is one of its two callers
  and it is the row's own fact. `public/board/queue-row.js:508` is `queueAgentHtml`, `:574` the return the entry
  point composes from. The moved block is sha256 `5876158d...`, 510 lines, 41 declarations, the same set both sides.
- **Cut 2, `69309b6f`** - `public/board/queue-drag.js` (new, 265 lines) and `public/queue-cards.js` 840 -> 652.
  `public/board/queue-drag.js:41` is the factory, `:53` the drag record's two `let`s, `:104` `queueDragPaint`, `:151`
  `queueCardDown`, `:250` the one accessor `dragLive` the card cut asks. The moved block is sha256 `fc364eac...`, 197
  lines, all 16 of its declarations.
- **Cut 3, `5d6b482b`** - `public/board/queue-detail.js` (new, 634 lines) and `public/queue-cards.js` 652 -> 71.
  `public/board/queue-detail.js:54` is the factory, `:95` `queueReattach` (the stopped chip's press), `:230`
  `taskCardHtml` in its two modes, `:422` `renderAssistantQueue` (the paint), `:603` `queueAct` (the one write path).
  The moved block is sha256 `b5051208...`, 557 lines, all 20 of its declarations, and not one body line changed.
- **`public/queue-cards.js:26`** - the entry point. It builds the three cuts in the order their bodies allow
  (`:39` row, `:40` card, `:41` drag) and returns exactly the 22 names `public/assistant.js:7225-7232` destructures.
  The three names a cut calls but does not own (the paint, the read and the pane's scroller) travel through a `later`
  record of thunks, so every moved body keeps the spelling it had inside the one closure; the drag record's `let`
  could not be handed over, which is why the card cut's one drag guard reads `dragLive()` - the only moved line whose
  text changed, and it changed in cut 2, not in cut 3.
- **`public/index.html:1698-1701`** - the three new tags before `/queue-cards.js`, in the house comment style.
  `lib/build-version.js` derives the hashed bundle from the shell's tags, so there is no second list to update.

## The harnesses moved with it

A slice test used to read one file and slice one region. The region now spans three files, each of which keeps the
marker pair, so `tools/panel-testkit.mjs:311` gains `sliceRegions` (every region with one name, in page order) and
`:332` `queueCardsSource` (the queue's four files as `public/index.html` loads them). The nine unit tests and
`tools/verify-queue-agents.mjs` call those two; each test still names `public/queue-cards.js`, so
`npm run test:module public/queue-cards.js` still selects all ten files.

## Verification

- `node --check` on every touched file: `public/queue-cards.js`, `public/board/queue-row.js`,
  `public/board/queue-drag.js`, `public/board/queue-detail.js`, `tools/panel-testkit.mjs`,
  `tools/verify-queue-agents.mjs` and the nine test files - clean.
- `npm run test:module public/queue-cards.js` - 10 files, 135 tests, 134 pass, 1 fail. That failure is the base tip's
  own: `test/assistant-queue-reattach.test.js:346`, "a press naming the checkout is REFUSED when git does not know
  the run's tree", `TypeError: Cannot read properties of undefined (reading 'find')`. The untouched base prints the
  same 135 / 134 / 1 with the same test and the same error.
- `node tools/verify-queue-cards.mjs` (the Queue tab drawn by a real headless Chromium over a seeded queue, at 1280 px
  and 340 px): base 47 PASS and `RESULT: PASS QUEUE-CARDS-OK`; at this tip 47 PASS and `RESULT: PASS
  QUEUE-CARDS-OK`. 44 of the 47 PASS lines are byte-identical, and the three that differ are the run's own identity
  (the throwaway sandbox port 65242 / 62010, and the temp directory the seeded `queue.json` is named under) - not a
  card.
- `node tools/verify-queue-drag.mjs` (a pointer drag of a queued card, a blocked drop, and the click that must still
  open its agent): 37 PASS, `RESULT: QUEUE-DRAG-OK`.
- `node tools/verify-queue-agents.mjs` (the agent rows, sliced from the page's own source as one region): 71/71 checks
  passed, no page errors, no console errors.

## What did not change

No name was renamed, no call site in `public/assistant.js` or `public/core/initiative-fold.js` was touched, no
stylesheet rule moved, and no version was bumped: this row lands locally on the turnover branch and is not pushed.

## Line counts, with the command that measured them

    git show 20261127_2134_TASK-405_row-405-is-the-complete:public/queue-cards.js | wc -l   -> 1339
    wc -l public/queue-cards.js public/board/queue-row.js public/board/queue-drag.js public/board/queue-detail.js
                                                                  -> 71, 586, 265, 634

The base file was 1,339 lines rather than the report's 1,307 (it measured `3bb43694`); the report's own caution is
why every range was re-measured on this base before a line moved.
