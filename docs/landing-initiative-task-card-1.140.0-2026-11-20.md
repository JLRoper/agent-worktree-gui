# Landing: the Initiatives tab draws the assistant's tasks with the queue's own card (1.140.0)

The Assistants section of the Initiatives tab listed each queue row as a plain two-line block: its state, its id and
its title in one line, and the brief underneath. It was a second rendering of a thing the panel already draws well,
and the brief made every fold tall. This landing removes that listing and calls the queue's own renderer instead, in
a compact read-only mode: the card a reader knows from the queue pane, with its head, its state word, its id and its
title, its facts line, and none of its controls.

## What landed

- `public/queue-cards.js:694` - `taskCardHtml` takes a second argument, `mode`, defaulting to `"full"` so the queue
  pane's call is unchanged. `public/queue-cards.js:695` is the one flag the function branches on, `public/queue-cards.js:722`
  is the compact body, and `public/queue-cards.js:735` the compact element itself: `as-task is-compact`, the same
  `data-as-qrow` / `data-as-qstate` / `data-as-qown` / `data-as-qthread` the queue's row carries, plus
  `data-init-task-card` as the Initiatives pane's own press target. `public/queue-cards.js:267` is `queueStateTitle`,
  which now takes the mode: the queue's card promises a drag, the compact one points at the queue that can move it.
- `public/core/task-card.css` (new, 51 lines) - only what a compact card adds: the tighter box (`:25`), the title cut
  to one line with the whole of it still in `title=` (`:33`), the facts line laid out where the queue pane's scoped
  `.as-qpane .as-task-facts` rule does not reach (`:40`), and the fold's "show more" line (`:48`). Everything that
  makes the thing a card - the marker, the state word and its tones, the dimming of a done row, the flash - stays in
  `public/style.css` under `.as-task`, so the two modes are the same card by construction rather than by resemblance.
- `public/assistant.js:3592` - `paintInitTaskLists`, the fold's painter. It asks for the card at
  `public/assistant.js:3611` (a new node) and `public/assistant.js:3618` (a refreshed one), and `refreshInitTaskCard`
  keeps the SAME element when the row has not moved, so a live state change does not rebuild the fold beneath the
  pointer. `public/assistant.js:3631` is the fold's window line: how many of how many, and the one press that draws
  more.
- `public/core/initiative-fold.js:188` - `TASK_CARD_FIRST = 6` and `:190` `TASK_CARD_MORE = 50`: six cards before the
  window line, fifty more per press, the queue pane's own slice size. `:214` `taskCardWindow` orders the states being
  acted on first and reports `visible`, `hidden`, `more` and `total`.
- `public/index.html:17` - the new stylesheet, after `public/style.css`.
- `test/initiative-tasks.test.js:233` - the identity test: the compact card's HEAD is the queue card's head, one
  piece of markup, with only the queued state's hover sentence differing. `:281` is the compact card inventing
  nothing; `:335` the same node across a refresh; `:349` the fold's count line; `:357` the press reaching the real
  queue. The queue's own UI tests follow the mode argument (`test/assistant-queue-ui.test.js`,
  `test/queue-drag-ui.test.js`, `test/task-pipeline-window-ui.test.js`, `test/assistant-queue-reattach.test.js`).
- `tools/verify-initiative-tasks.mjs` - the gate, extended to the card rather than the old listing; it is
  `package.json:68`'s `verify:initiative-tasks`.

## One head, and no controls

The compact card is not a look-alike. `test/initiative-tasks.test.js:233` strips `title=` from both heads and asserts
the strings are EQUAL, so marker, id, state word and title are one piece of markup drawn by both modes. The one
divergence is deliberate and held to its own assertion: the queue's queued state says "drag the card to change its
place", and a read-only card says "its queue is where it is started".

Read-only is a property of the markup, not of a disabled attribute: the compact card carries no `<button>`, no
`<a>`, no `<details>`, no `data-as-qact`, no `data-as-qmove` and no draggable attribute. A press on one of the old
listing's rows went nowhere useful; a press on a compact card opens the task in its REAL queue - the queue sub-tab,
the assistant selected, the row inside the pane and flashed - which is where the actions live
(`public/assistant.js:4167` routes `data-init-task-card` to `queueOpenTask`). The gate walks that press and compares
the head it lands on element for element.

The title is cut by the stylesheet to one line, never by the renderer: the whole title stays in `title=`, so the
hover and a copy both give the title the queue holds. The brief a worker is handed is not on the card at all; the
gate checks the short title on the card and the long detail absent from it.

## The gate

`tools/verify-initiative-tasks.mjs`, headless at 1440x900, on a throwaway panel (`tools/panel-testkit.mjs`) with
hand-cut worktrees and an apiServer pointed at a dead port. It ran 81 checks and all 81 passed:

- an assistant's row arrives collapsed, with a real button, the tab's chevron, a count and `aria-expanded="false"`,
  and no cards in the DOM;
- a press opens it, and the cards drawn are the queue's card in its compact mode - the same classes, the agent's
  thread and the clock on one facts line;
- the brief is not the title: the card's text and its `title=` are the short title, and the row's long detail appears
  nowhere on the card;
- the compact card carries zero buttons, links, disclosures and `data-as-qact` presses, read out of the live DOM,
  while the queue's own card for the same task carries them;
- a running task moved to done through the queue API is picked up by the pane's own read, and the same node is
  refreshed (the marker the harness put on it before the change is still there after it);
- the press opens the task in its real queue, centred and flashing, on the same head;
- Enter and Space open and shut the fold, Escape still closes the rail, the fold survives the rail's return, and a
  press on the compact card's title still folds the card;
- two assistants under one initiative draw two folds, each its own; one tree on two initiatives shows its task once
  under each; a task on a tree no initiative carries appears nowhere; an initiative with no rows says
  "no assistant has worked on these worktrees yet";
- with ten rows the fold draws six, says "6 of 10 shown - 4 not shown" beside one "Show 4 more", and the press draws
  the rest and retires the line;
- no page error, no console error, and the wire's ten rows are the ten cards on screen.

Screenshots at 1440x900, beside this note in `docs/reports/initiative-task-card-1.140.0/`:
`initiative-task-card-1-compact-1440x900.png` (the fold open on the compact card),
`initiative-task-card-2-queue-press-1440x900.png` (the same task opened in its real queue from the card) and
`initiative-task-card-3-window-1440x900.png` (the fold's window: six of ten, and the press naming its own step).

## Tests

- `test/initiative-tasks.test.js` 18 of 18 - the one head, the compact card's honest blanks, the fold's order and
  window, the kept node, the count line, the press, and the empty line.
- The queue's own UI tests, by name: `test/assistant-queue-ui.test.js`, `test/assistant-queue-reattach.test.js`,
  `test/queue-drag-ui.test.js`, `test/task-pipeline-window-ui.test.js` and `test/initiative-tasks.test.js`, 80 of 80
  together.
- `tools/verify-initiative-tasks.mjs` 81 of 81 at 1440x900.
- `npm test` once on the branch: 3345 tests, 3336 passing, 9 failing. All nine reproduce on a `git archive` of
  untouched `origin/main` - `test/assistant-profile.test.js`, `test/assistant-search-scroll.test.js`,
  `test/child-route.test.js`, `test/gateway-permissions.test.js`, `test/header-controls.test.js`,
  `test/paths-http.test.js`, `test/paths.test.js`, `test/reasoning-runs.test.js` and `test/scan-roots.test.js` - so
  they are main's own red, not this change's.

## Version and the release record

`1.140.0`, minor: a new reader-facing rendering of the assistant's tasks, nothing removed or renamed on the wire.
`origin/main` read `1.139.0` when this branch was rebased, so the bump commit is the one that first declares
`1.140.0` and carries `v1.140.0`; the landing moved the tag onto the commit the merged `main` carries
(`a39d4e1b`), and the render commit above it reads 654 releases.

The note and its screenshots are a docs commit pushed to `main` deliberately with `--no-verify`: a docs-only base
push spends no version, the same bypass `tools/land.mjs` prints for its own `CHANGELOG.md` commit. The code push
itself was a normal push; the first attempt was refused by `tools/absolute-paths.mjs` over a drive-letter path in
this landing's own test fixture, which is fixed in the second commit rather than bypassed.

## Known limits, stated rather than hidden

- The compact card changes nothing about the queue: the pane's card keeps every control, every drag and every
  press. The two modes share the head, and only the head is held to identity by the test.
- The fold's window keeps the six most active rows; a reader who wants row seven presses once. The order is the
  queue's own - states being acted on first - not a second sort the tab invented.
- The card is the press, so a text selection inside the title is hard: a press anywhere on the card opens the queue.
  The whole title is still in `title=` for the hover and for a copy.
