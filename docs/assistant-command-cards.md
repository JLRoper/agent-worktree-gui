# The assistant's command cards

A reply ends with lines in the panel's own vocabulary, and the reader met them as monospace prose:

```
QUEUE assistant-3 | [Playwright test] corner resize the rail's card and capture it folded
QUEUE assistant-3 | corner resize
MESSAGE assistant-3 | the deploy moved
SPAWN IN #12 agent-worktree-gui | card the transcript
TODO ADD [Playwright test] corner resize
RULE: [Never PROD] deploy to QA only
```

**Every readable one of those lines is now a card**, titled or not, in every place a reader meets it: the board's
turn tail (`public/turns.js`), the Messages pane (`public/assistant.js`), and the agent card's own transcript, whose
turn body is drawn by `public/render-jobs.js`. It is drawn in the *same* frame a tool's result is drawn in -
`core/console-format.js`'s `.code-box` - with the kind's emoji and the recipient on the head, the title appended only
when one parses, and the body folded to two lines behind a click:

```
[▸] 🧾 assistant-3 | Playwright test          click to read
    corner resize the rail's card and capture it

[▸] ✉️ assistant-3                            click to read
    the deploy moved
```

## Every readable line, titled or not

The title is a display nicety on the head, never the reason a line is drawn. A line the module can read gets the
card; a line it cannot read, or one with nothing to show, is exactly the line it has always been.

| line                                    | head                            | body                     |
| --------------------------------------- | ------------------------------- | ------------------------ |
| `QUEUE assistant-3 \| [Playwright test] go` | `🧾 assistant-3 \| Playwright test` | `go`                |
| `QUEUE assistant-3 \| corner resize`    | `🧾 assistant-3`                | `corner resize`          |
| `QUEUE assistant-3 \| [never closed`    | `🧾 assistant-3`                | `[never closed`          |
| `MESSAGE assistant-3 \| the deploy moved` | `✉️ assistant-3`              | `the deploy moved`       |
| `SPAWN IN #12 agent-worktree-gui \| card it` | `🌱 IN #12 agent-worktree-gui` | `card it`            |
| `TODO ADD [Playwright test] corner resize` | `☑️ Playwright test`         | `corner resize`          |
| `RULE: deploy to QA only`               | `📏 RULE`                       | `deploy to QA only`      |
| `TODO DONE 3`                           | (not a card)                    | the prose line it has always been |
| `see above`                             | (not a card)                    | the prose line it has always been |

Three of those deserve a word:

- a kind that addresses nobody *and* carries no title draws its emoji and its own kind name (`📏 RULE`, `📝 NOTE`),
  so a head is never a bare glyph;
- an id op (`TODO DONE 3`, `TODO DOING 2`) carries an id and no text, so there is nothing a body could show: the
  prose line IS the whole command, and the card builder answers `""` for it. The same is true of a command with an
  empty payload (`TODO ADD`), which is what the panel would refuse anyway;
- the shapes are the grammar's own (`lib/assistant/actions.js`, and `lib/todos.js` for TODO): `NOTE: text`,
  `WATCH <thread>: <sentence>`, `RULE [Never PROD] text`, `RESTART gateway | text`. A line the executing grammar
  would not read as a command is not a card, because a card must never invent a reading the panel does not have.

## Where it is drawn, and the one card that draws it

There is one reader of these lines (`public/core/assistant-command.js`), one frame (`core/console-format.js`'s `box`),
and one card. Each surface asks the module at paint time by name:

| pane | drawn by | how it asks |
| ---- | -------- | ----------- |
| the board's turn tail | `public/turns.js` | `commandCardHtml(peek.text)` and `commandCardsHtml(answer)` |
| the Messages pane | `public/assistant.js` | `msgCommandCards(text, scope)` |
| the agent card's transcript | `public/render-jobs.js` | the turn's prose run goes to `core/console-markdown.js`, which asks `consoleFormat.commandCard` |
| the copy walker | `public/board/console.js` | copies a `.code-box[data-ltext]` as the line it was drawn from |

The transcript is the interesting row. Its turn body draws the agent's own words through
`core/console-markdown.js` (the same prose renderer the console uses), so teaching *that* renderer to hand a command
line over is what covers the turn body and the console's own transcript at once. `public/render-jobs.js` hands its
run to the renderer with the turn's scope and the page's open book
(`mdRunHtml(lines, sep, { scope: turn.id, open: state.codeBoxOpen })`) and holds no card builder of its own. A caller
that does not ask (the console's live append, a harness) keeps the paragraph it always drew, which is why the
renderer asks `opts.cards` before it builds anything.

## Display only, and that is the whole rule

`lib/assistant/actions.js` parses the line the panel executes. It is untouched, and **the title is not stripped from
what runs**: `QUEUE assistant-3 | [Playwright test] corner resize` still queues the text
`[Playwright test] corner resize`, byte for byte. The card is a second, display-only reading of the same string, so:

- a line the module cannot read renders exactly as it did before the module existed;
- a page that has not loaded the module (`public/core/assistant-command.js`) renders the plain line, because every
  call site asks `globalThis.wtAssistantCommand` at paint time and keeps its old branch when the answer is missing;
- a malformed or absent title can never change what the panel does, because nothing that executes reads the title;
- drawing a card changes neither the panel's store nor what the console's copy lifts. The card carries the line it
  was drawn from in `data-ltext` - the same attribute every console row keeps its source text in - so a copied
  console is still the turn's own text, and the browser proof reads the store's hash (and the turn's stored value)
  before and after every card has been opened and folded.

`test/assistant-command-card.test.js` asserts those directly: it parses the proof lines through the *executing*
grammar as well as through the card, and compares the rows.

## The title, and the 80-character rule

A payload may lead with `[Title]`. The title counts only when its closing bracket arrives within
`COMMAND_TITLE_MAX` characters (80) of the payload:

| payload                  | title              | card | head                                |
| ------------------------ | ------------------ | ---- | ----------------------------------- |
| `[Playwright test] fix`  | `Playwright test`  | yes  | `🧾 assistant-3 \| Playwright test` |
| `[Playwright test fix`   | none - unclosed    | yes  | `🧾 assistant-3`                    |
| `[xxxx…80…xxxx] fix`     | 80 characters      | yes  | `🧾 assistant-3 \| xxxx…80…xxxx`    |
| `[xxxx…81…xxxx] fix`     | none - too long    | yes  | `🧾 assistant-3`                    |
| `see [Playwright] below` | none - not leading | yes  | `🧾 assistant-3`                    |

A bracket that never closes, one that does not lead, and one longer than the rule are all "not a title": the line is
still a card, and the bracket stays in the body as the payload it is. The rule lives in one place (`readTitle`) and is
exported (`COMMAND_TITLE_MAX`) so the tests call it rather than restate it.

## The emoji map

One emoji per kind, and one only - a kind without a glyph is a bug, not a card drawn without one
(`COMMAND_EMOJI`, exported):

| kind    | emoji | head reads                                  |
| ------- | ----- | ------------------------------------------- |
| QUEUE   | 🧾    | `🧾 assistant-3 \| Playwright test`         |
| MESSAGE | ✉️    | `✉️ assistant-2 \| the deploy moved`        |
| SPAWN   | 🌱    | `🌱 IN #12 agent-worktree-gui \| Card`      |
| TODO    | ☑️    | `☑️ Playwright test`                        |
| RULE    | 📏    | `📏 Never PROD`                             |
| NOTE    | 📝    | `📝 NOTE`                                   |
| WATCH   | 👀    | `👀 panel-assistant`                        |
| CHARTER | 📜    | `📜 SSO cut over`                           |
| RESTART | ♻️    | `♻️ panel \| serve 1.95.0`                  |

`TO` is deliberately not in the list: it addresses a worker thread and is not the panel's own command, so it keeps
its prose line. The recipient is the field the kind addresses (the assistant for QUEUE/MESSAGE, the tree for SPAWN,
the thread for WATCH, `gateway`/`panel` for RESTART); a kind that addresses nobody draws the emoji and the title
alone, or the emoji and the kind's own name when it has no title either.

## The fold

The body is folded to **two lines**, not shut: `data-code-clamp="2"` and one stylesheet rule
(`.code-box.is-cmd.is-clamped > .code-body { max-height: 3em }`) keep the start of the line on the page for a reader
who never clicks. The head is a real `<button>` carrying `aria-expanded`, so Tab reaches it and Enter or Space presses
it - the same control the tool cards use, not a div pretending to be one. `public/app.js`'s press handler reads
`data-code-clamp` and toggles `is-clamped`, so a clamped card is never `hidden` and a second press folds it back to
two lines.

The open state is kept by key in the page's `state.codeBoxOpen` book: `cmd|<scope>|<line>`, where the scope is the
turn (`<turn id>`), the message (`msg|…`), the peek (`peek|…`), the compact card (`compact|…`), and the line is the
console line's own id when it has one - so a repaint, or a window that drops the lines above it, does not fold a card
the reader opened - its index in the run when it does not. `refreshTurnPeek` only redraws the card when the line
behind it changed: a redraw would take the reader's focus off the head they just pressed.

A transcript card waits for its whole line. While the stream is still releasing the last characters the line is the
plain row it was being written as, and the card appears when the line is complete.

## Proof

- `test/assistant-command-card.test.js` - the emoji map (nine kinds), the 80-character rule (80 is a title, 81 is
  not, and both are cards), untitled QUEUE/MESSAGE/SPAWN plus a titled one, the id op that is not a card, the four
  proof lines through the executing grammar, the queue row's byte-for-byte text, the frame coming from
  `core/console-format.js`, the clamp and the button head, the transcript route through `core/console-markdown.js`
  (four cards when asked, none when not, keyed by the line's id, each carrying `data-ltext`), the copy walker's rule,
  the compact snippet (`public/turns.js` loaded as the classic script it is), and where the module sits in
  `public/index.html`.
- `tools/verify-assistant-command-card.mjs` - a real browser on a throwaway panel: a seeded thread of six turns, a
  card folded (36px at an 18px line, 62px of body), a click that opens it (`aria-expanded` true, the whole body on the
  page), a second click that folds it back, the TODO card, the three untitled lines drawn as cards with a head of the
  kind and the recipient, the turn head still opening its own turn, the Messages pane drawing the same cards, and:
  - **the agent card's transcript** - the open turn's console body draws four cards (untitled MESSAGE, untitled
    QUEUE, untitled SPAWN, titled QUEUE), each folded to two lines, each opening on a real press, the prose above them
    still prose, and the console's own copy of that body still exactly the text the turn stored;
  - the panel's store hash, and the turn's own stored value, unchanged after every press;
  - no page error.

  Captures: `01-agent-card-transcript.png`, `02-agent-card-transcript-open.png`, `01-malformed-and-absent.png`,
  `02-queue-card-folded.png`, `03-queue-card-expanded.png`, `04-queue-card-folded-again.png`,
  `05-transcript-card.png`.
