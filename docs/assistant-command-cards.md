# The assistant's command cards

A reply ends with lines in the panel's own vocabulary, and the reader met them as prose:

```
QUEUE assistant-3 | [Playwright test] corner resize the rail's card and capture it folded
TODO ADD [Playwright test] corner resize
RULE: [Never PROD] deploy to QA only
```

The first of those is now a **card** in the two places a reader meets a command after the fact: the board's turn
tail (`public/turns.js`) and the transcript's messages (`public/assistant.js`). It is drawn in the *same* frame a
tool's result is drawn in - `core/console-format.js`'s `.code-box` - with one emoji for the kind, the recipient and
the title on the head, and the body folded to two lines behind a click:

```
[▸] [0] assistant-3 | Playwright test          click to read
    corner resize the rail's card and capture it
    folded
```

## Display only, and that is the whole rule

`lib/assistant/actions.js` parses the line the panel executes. It is untouched, and **the title is not stripped from
what runs**: `QUEUE assistant-3 | [Playwright test] corner resize` still queues the text
`[Playwright test] corner resize`, byte for byte. The card is a second, display-only reading of the same string, so:

- a line the module cannot read renders exactly as it did before the module existed;
- a page that has not loaded the module (`public/core/assistant-command.js`) renders the plain line, because every
  call site asks `globalThis.wtAssistantCommand` at paint time and keeps its old branch when the answer is missing;
- a malformed or absent title can never change what the panel does, because nothing that executes reads the title.

`test/assistant-command-card.test.js` asserts the first and third of those directly: it parses the four proof lines
through the *executing* grammar as well as through the card, and compares the rows.

## The title, and the 80-character rule

A payload may lead with `[Title]`. The title counts only when its closing bracket arrives within
`COMMAND_TITLE_MAX` characters (80) of the payload:

| payload                  | title            | card |
| ------------------------ | ---------------- | ---- |
| `[Playwright test] fix`  | `Playwright test`| yes  |
| `[Playwright test fix`   | none - unclosed  | no   |
| `[xxxx…80…xxxx] fix`     | 80 characters    | yes  |
| `[xxxx…81…xxxx] fix`     | none - too long  | no   |
| `see [Playwright] below` | none - not leading | no |

A bracket that never closes, one that does not lead, and one longer than the rule are all "not a title", and a line
with no title is the line it has always been. The rule lives in one place (`readTitle`) and is exported
(`COMMAND_TITLE_MAX`) so the tests call it rather than restate it.

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
| NOTE    | 📝    | `📝 the rail's width`                       |
| WATCH   | 👀    | `👀 panel-assistant \| the deploy finishes` |
| CHARTER | 📜    | `📜 SSO cut over`                           |
| RESTART | ♻️    | `♻️ panel \| serve 1.95.0`                  |

`TO` is deliberately not in the list: it addresses a worker thread and is not the panel's own command, so it keeps
its prose line. The recipient is the field the kind addresses (the assistant for QUEUE/MESSAGE, the tree for SPAWN,
the thread for WATCH, `gateway`/`panel` for RESTART); a kind that addresses nobody draws the emoji and the title
alone.

## The fold

The body is folded to **two lines**, not shut: `data-code-clamp="2"` and one stylesheet rule
(`.code-box.is-cmd.is-clamped > .code-body { max-height: 3em }`) keep the start of the line on the page for a reader
who never clicks. The head is a real `<button>` carrying `aria-expanded`, so Tab reaches it and Enter or Space presses
it - the same control the tool cards use, not a div pretending to be one. `public/app.js`'s press handler reads
`data-code-clamp` and toggles `is-clamped`, so a clamped card is never `hidden` and a second press folds it back to
two lines.

The open state is kept by key in the page's `state.codeBoxOpen` book: `cmd|<scope>|<line>`, where the scope is the
turn (`peek|…`, `compact|…`) or the message (`msg|…`). A repaint therefore does not fold a card the reader opened,
and `refreshTurnPeek` only redraws the card when the line behind it changed - a redraw would take the reader's focus
off the head they just pressed.

## Proof

- `test/assistant-command-card.test.js` - the emoji map, the 80-character rule, the three not-a-title forms, the
  four proof lines through the executing grammar, the queue row's byte-for-byte text, the frame coming from
  `core/console-format.js`, the clamp and the button head, the compact snippet (`public/turns.js` loaded as the
  classic script it is), and where the module sits in `public/index.html`.
- `tools/verify-assistant-command-card.mjs` - a real browser on a throwaway panel: a seeded thread whose turns end
  on each of the proof lines, the card folded (36px at an 18px line, 62px of body), a click that opens it
  (`aria-expanded` true, the whole body on the page), a second click that folds it back, the TODO card, the three
  non-cards, the turn head still opening its own turn, the Messages pane drawing the same card, and no page error.
  Captures: `01-malformed-and-absent.png`, `02-queue-card-folded.png`, `03-queue-card-expanded.png`,
  `04-queue-card-folded-again.png`, `05-transcript-card.png`.
