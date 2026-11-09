# Landing: the board digest is an append-only tail

The digest was the biggest fixed cost of an assistant turn: on a busy board, every live run and the five most recent,
each with its prompt, its tree and its last tool calls, plus the panel's notices - about 8 KB, rewritten on every turn
it was due. A block that is rewritten cannot say what MOVED; it only says what IS, and a sweep that found the board
exactly as it left it sent the same 8 KB again (on a marker gate that existed only because the block was expensive).

It is a tail now. Every turn appends exactly ONE small message to the assistant's digest transcript and hands that
message to the run. A row carries the item's stable id, a state token over the facts an assistant acts on, the moment
that state began, and a pointer at the sending turn. A row's text rides only when its token is new: the message that
first carried the token is still above it in the transcript. The words behind a row are not in the digest at all -
`readTurn(pointer)` answers a pointer with that turn's final message and its last few tool calls.

## The message

`lib/assistant/digest-tail.js` owns the shape; `lib/assistant.js` owns which items and when the message is appended.

```
Board tail 11-09T09:12:09Z | 1 changed, 0 same | prev 11-09T09:12:09Z
LIVE RUNS - one run per thread, one worker per tree. Do NOT write a TO line to one: a reply starts a SECOND run on the same files. Write nothing and let each finish.
= #6f092a51 tok=db12b6c3 at=11-09T09:12 send=assistant-1/panel-assistant/065afb5b
```

A changed row, one turn later:

```
+ #6f092a51 tok=4057a6c5 at=11-09T09:12 send=assistant-1/panel-assistant/065afb5b | land the digest tail · done · .worktrees/make-the-board-digest-…
```

- `#id` is the run's stable id, the same id the job store, the cards and the queue rows use.
- `tok` is the first 8 hex of a sha256 over the state projection (`itemStateOf`: status, end, exit code, branch, tree,
  completion word, outcome, termination, question, approval, error, fatal, runGone). Console lines, prompts and token
  counters are deliberately outside it: a row whose text is stable must not look changed because its clock ticked.
- `at` is when that state began. An unchanged row keeps the timestamp the previous message carried, so it is the age
  of the state and not of the message.
- `send` is the sending turn - assistant, thread, turn - and it is what `readTurn` takes. The harvest stamps
  `origin.turnId` / `origin.turnThread` on a run the assistant's SPAWN cut; a run the reader started points at itself.
- `+` carries the row's one-line text; `=` carries none. That is the whole economy of the change.

## The read tool

`GET /api/assistant/read?pointer=<assistant>/<thread>/<turn>` (`routes/assistant-digest.js`), backed by
`readTurn` in the module and `Assistant.readTurn`. It returns
`{ok, pointer, turn: {id, thread, assistantId, title, status, startedAt, endedAt}, finalMessage, calls[]}` where
`calls` is the turn's last three tool calls (tool, input, at), parsed from the run's own console lines.

It answers the turn the pointer NAMES, never the newest turn of that thread, and it refuses a pointer whose thread is
not the turn's own. That refusal is the point: a digest message can name a turn three turns ago, and "the latest" is a
different answer.

`GET /api/assistant/digest?assistantId=` returns the transcript itself, oldest first, for a reader or a page.

## One message a turn, and the transcript

`Assistant.say` builds the message, creates the run, and appends the message only after the create returns - a refused
turn appends nothing. `Assistant.boardForTurn` is the same two steps for a caller that is itself a turn (a test, a
tool). The transcript is `state/assistants/<id>/digest.jsonl`, one JSON object per line, so a torn write costs one
message and never the file; it keeps its newest 200 messages and trims from the front, so no message a turn was handed
is edited.

The comparison cursor is per assistant and is re-read from the file at boot, so a panel restart continues the tail it
left. A role restart and a hard restart DELETE the cursor: a new thread has no transcript above it, so its first
message carries every row's text again, which is what "sent in full again" meant to say all along.

## The gate is retired

`digestSweepEveryNWakes` and `boardForTurn`'s four-case gate (event, reader, signature changed, Nth sweep) and
`markerDigest` are gone. A gate existed to avoid resending a block that had not moved; a tail answers a board that has
not moved with rows that carry no text, so there is nothing left for it to save. Every turn appends one message.

- `lib/assistant/config.js`: the key, its scope row and its bounds are gone.
- `lib/assistant/prompt-budget.js`: the board section is the same block in all three pictures; its cap is
  `DIGEST_SCREEN.lines * DIGEST_SCREEN.cols` (one screen), not 8,000 characters, and the Prompt tab says the tail
  rides every turn instead of drawing a marker no build sends.
- `lib/assistant.js`: `digest()` is a read-only preview of the next message (`state()` and the Prompt tab ask it);
  `boardForTurn` appends.

## One screen, measured

`DIGEST_SCREEN` is the assistant float's default text box, from the page's own geometry: `placeFloat()` gives 605 x
720 px on the panel's standard 1440 x 900 window. With the panel's real stylesheet and the console's own type in
Chromium, the text box measures 567 px wide, 11.5 px monospace at 6.32 px a character (89 columns) and 17.25 px a
line, and the chat pane leaves 607 px of height for the block.

`node tools/verify-digest-cost.mjs` builds the busiest board this panel carries (10 live runs, 5 recent, long prompts)
and measures three messages, then renders the first in that box:

| message | bytes | chars | display lines |
|---|---|---|---|
| first turn, every row new | 2,516 | 2,516 | 33 |
| next turn, nothing changed | 1,466 | 1,466 | 18 |
| next turn, one row changed | 1,538 | 1,533 | 19 |

The block it replaces was about 7.8 KB on this board. The first tail message renders 587 px tall in a 607 px box, so
it fits one screen; a quiet turn's message is 1.4 KB and needs no text at all.

## Tests

`test/assistant-digest.test.js` is the contract, and it pins the four facts the item names plus the screen:

1. a turn appends exactly one message - through `say()` (and a create that throws appends none), and `boardForTurn`
   appends one per call;
2. an unchanged item does not re-send its text - the second message's row is `=`, empty text, same token, same `at`,
   and the prompt it was asked is nowhere in the message;
3. a changed item's state token differs from the previous one and its text rides again - while appending a console
   line does not move the token;
4. the read tool returns the pointed-at turn rather than the latest - two turns on two threads, the older one's
   pointer answers the older final message and its two tool calls, and a pointer with a foreign thread is refused;
5. the busiest realistic board fits one screen by `displayLines` at `DIGEST_SCREEN.cols`, and the first message is far
   under the 8 KB it replaces.

Also in the file: the pointer names the sending turn when a run has one, the transcript is append-only and trims whole
messages at its cap, and a message is JSON on one line.

The suites that carried the old gate were rewritten to the new contract: `test/assistant-system-briefing.test.js` (the
tail rides every turn; the settings cannot gate it away), `test/prompt-budget.test.js` (no `boardWakes`; the board is
the same block in all three pictures), `test/briefing-budget.test.js`, `test/assistant-queue-directive.test.js`,
`test/assistant-settings-split.test.js` (the retired key). `tools/verify-digest-cost.mjs` is the measurement above;
`tools/verify-append-tax.mjs` and `tools/verify-prompt-tab.mjs` were updated to the tail's words.

## Files

- `lib/assistant/digest-tail.js` - the message, the state token, the pointer, the transcript file and `readTurn`.
- `lib/assistant.js` - `buildBoardTail` / `appendBoardTail` / `boardForTurn` / `digest` / `digestItems` /
  `digestHead` / `digestNotices` / `readTurn` / `digestTail`; `say` appends one message per turn.
- `lib/features/spawn.js` - the run's origin records the sending turn (`turnId`, `turnThread`).
- `routes/assistant-digest.js` - `GET /api/assistant/digest` and `GET /api/assistant/read`.
- `lib/assistant/config.js`, `lib/assistant/prompt-budget.js`, `public/app.js`, `public/index.html` - the gate's
  retirement and the Prompt tab's words.
