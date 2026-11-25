# Landing: the four-direction shape check, the card's one line, and the popup's count (1.169.2)

The rule from `docs/clarify-juggling-design-2026-11-24.md` section 1 is that a card ends a piece of work with four
directions in a closed vocabulary - `Finish:`, `Deeper:`, `Route:`, `Ask:` - recommended first. Until this landing the
rule was prose: nothing could say whether a card offered them, and nothing could count how often a card did. Now the
panel classifies every arriving card's SHAPE, draws one line on the card saying what it offered, records the verdict
with the question, and prints the week's count in the Clarify popup.

This is section 6's `Deeper:` row, and only that row. The answer-to-row bridge (`Route:`) is not in this landing.

## The hard constraint, and why this row is safe

A clarify card IS a parked run. The panel cannot refuse one: if it dropped the card, the turn waiting on that prompt
would be stranded with no way for the reader to release it. So the check never blocks, refuses or delays a card:

- `lib/clarify-shape.js` is pure and total. It reads strings and returns a verdict; no branch throws, and a value that
  is not a list of choices is zero choices, not an error.
- `lib/jobs.js` calls it in a `try` anyway, inside the same object literal that copies the choices verbatim. A throw
  there would be the card that never reaches the reader, so the physical guarantee is in the call site as well as the
  module.
- Nothing downstream reads `shape.ok` to decide whether to raise, answer, close or draw a control. The card's disabled
  states still come only from the in-flight answer and the gateway's window. A two-choice card raises, answers and
  settles exactly as it did at 1.169.1, and so does an out-of-order four-choice card.

The design's own line stands: this validates SHAPE and cannot validate substance. Four labels reading `Route: rename
it`, `Route: move it`, `Route: delete it`, `Ask: ...` repeat a kind and are caught; four clever labels that all mean
"do the next small thing" pass. `ok` is a floor, not a judgement.

## What landed

- `lib/clarify-shape.js` (new) - `CLARIFY_KINDS` (`["finish", "deeper", "route", "ask"]`), `CLARIFY_KIND_LABELS`,
  `KIND_PREFIX`, `RECOMMENDED_TAIL`, `isRecommended`, `kindOf`, `shapeLine`, `checkChoices`, `normalizeShape`.
  `checkChoices(choices)` returns `{ok, count, kinds, missing, repeated, recommendedIndex, ordered, why, line}`. `ok`
  is four choices, four distinct kinds, each prefix once, and the recommended choice first (or no marker at all to
  contradict it). `ordered` is false only when a recommendation is marked and it is not the first choice - a card with
  no marker cannot be proved out of order, so it is not accused of one.
- `lib/jobs.js` - the `clarify.request` seam stores `shape: checkChoices(evt.choices)` beside the choices copy. The
  local `RECOMMENDED_TAIL` regex moved into `lib/clarify-shape.js` and is imported here, so the room's lettered
  choices and the shape check read one definition of "marked recommended". `noteQuestionAsked` passes `shape` to the
  history store.
- `lib/clarify-history.js` - every record carries `shape` (normalized on write and on load), a re-ask of an open
  question updates it, and `fourDirectionsOf(items, { now, days })` counts the ITEMS whose own ask fell in the last
  seven days. `items()` returns `fourDirections: { week, weekCards, all, allCards, days }`, counted over every kept
  item before the popup's page cap.
- `routes/clarify-history.js` - `GET /api/clarify/history` answers `fourDirections` in its body (and a zero summary
  when the panel keeps no history).
- `public/app.js` - `questionShape(q)` draws ONE line under the question from `question.shape.line`, complete cards in
  the accent colour and short ones in the note colour. A card with no choices draws no strip: it offers no directions
  to be short of.
- `public/style.css` - `.tq-shape` (the card's one line) and `.ch-pop .ch-shapes` (the popup's count strip).
- `public/core/clarify-history.js` - `fourDirectionsText(summary)`: "four directions: 2 of 3 cards this week", or "no
  card asked this week" rather than "0 of 0".
- `public/clarify-history.js` - the popup draws `#ch-shapes` under its head from the route's summary, with the week's
  numbers and the all-kept-cards record in its tooltip. It hides while there is no summary to print.
- `test/clarify-shape.test.js` (new) - 13 cases, listed under the proofs.
- `tools/verify-clarify-shape.mjs` (new) - the live gate: a real panel, a real page, a stub gateway that raises one
  `clarify.request` per run, and three cards answered through their own buttons. `npm run verify:clarify-shape`.
- `package.json` - the `verify:clarify-shape` script, and the 1.169.2 bump.
- `docs/using-the-board.md` - not touched; the popup's count is self-describing on the card.

## The proofs, as run

The whole file's own run: `node --test test/clarify-shape.test.js` - 13 tests, 13 pass, 0 fail. It proves, in the
brief's order:

| the brief's proof | what the test does | what it read |
| --- | --- | --- |
| four kinds reads complete, in order | `checkChoices(FOUR)` and the shipped `questionPrompt` slice | `four directions, in order: Finish, Deeper, Route, Ask`, one `.tq-shape`, four live choices |
| two plain choices reads short and names what is missing | `checkChoices(["the turn", "the agent"])` on a card | `short: none of the 4 directions in 2 choices · missing Finish, Deeper, Route, Ask`, two live choices |
| a first choice that is not the recommended one is flagged, not blocked | a card whose marker is on choice 2 | `four directions, out of order: Deeper, Finish, Route, Ask · the recommended choice is not first`, four choices, none disabled, and the same record answers and settles through `noteAnswered` |
| the shape reaches the history record | a real `Jobs.consume(j, {event: "clarify.request"})` over a temp store | `jobs.clarifyHistory.list().entries[0].shape.ok === true` and the same `line` the card drew |
| the popup count moves one per card | the real `GET /api/clarify/history` route over that store | `week` 0 -> 1 -> 2 with one four-direction card each, `weekCards` 3 after a two-choice card, and `limit=1` still reporting `week: 2` |
| a two-choice card still works end to end | raise, answer, settle through the seam | `j.question` null, `questionDone.answer` the chosen label, the history row `answered` and still carrying `shape.ok: false` |

The clarify family was run as one set (`test/clarify-*.test.js`, 96 tests) at the change: 96 pass, 0 fail.

The live gate (`node tools/verify-clarify-shape.mjs`) ran the same three shapes through a real panel, a real page and a
stub gateway, one worker run per card, and answered each card through its own button: 36 checks, 36 pass, 0 fail.

| what the gate read | result |
| --- | --- |
| the seam's record on a real run | `shape` present, `ok: true`, one strip on the card, four enabled choices |
| the popup after one card | `four directions: 1 of 1 card this week` |
| the two-choice card | `short: none of the 4 directions in 2 choices · missing Finish, Deeper, Route, Ask`, both choices live, answered (`the turn, and its tree`), history row `answered` and still short |
| the popup after two and three cards | `1 of 2` then `1 of 3 cards this week` |
| the out-of-order card | `four directions, out of order: ...`, four choices, none disabled, answered, history keeps the verdict |
| the page | no page error while drawing or answering any of the three |

The cards themselves are captured at `docs/reports/assets/clarify-shape/card-strip.png` (the four-direction strip) and
`docs/reports/assets/clarify-shape/popup-count.png` (the popup's count).

The full suite (`npm test`) was started once and cancelled at about 22 minutes, still running, under the standing rule
that a suite run past 20 minutes is cancelled. What was run instead, and passed: the 13 new cases, the 96-test clarify
family, and the 36-check live gate above.

## What was not done, on purpose

- Nothing in the gateway's window, the card's countdown, or the settle path changed. The strip adds one element to the
  card's markup and one field to the question record.
- The design's `Route:` row (the answer-to-row bridge, the wave `ask`, the grammar's `QUEUE` widening) is not here.

## Verifying it by hand

Open the Clarify popup on the board: under its head there is one violet line, `four directions: N of M cards this
week`. Ask any agent a question with four kinds of choice and the card carries one line naming them in order; ask one
with plain choices and the line says which kinds are missing. In both cases every choice is still clickable, and the
answer still settles the turn.
