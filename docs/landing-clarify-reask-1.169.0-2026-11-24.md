# Landing: re-ask a clarify question you missed, from the header popup (1.169.0)

The header's Clarify popup listed every question the panel had asked, and a question whose card timed out was a dead
row: the reader could see they had missed it and had no way to get it asked again. Now a MISSED row carries one
button. One press sends the reader's line and the question quoted IN FULL into the thread that asked it, and lands
the reader on the new turn where the answer will appear.

## The defect this closes

The popup draws a question through `oneLine(question, 400)` (`public/core/clarify-history.js` `questionLine`, and the
store's own `collapseKey`): the display line is cut at 400 characters and every newline is folded to a space. A quote
built from that line is a mutilated question, and the obvious implementation - send what the row says - would have
asked the agent to re-ask something the reader never saw. The body is therefore built from the STORED record
(`entry.question`, `entry.choices`), and `reaskQuoteCheck` refuses any body that lost a byte before it is sent.

A second, quieter defect: the re-ask is a reader-authored reply turn, so `readerReplies` counted it as evidence that
the question was answered - the missed row turned into "answered in a reply" the moment the button was used, pointing
at the very turn that re-asked it. That turn is now skipped by kind (`origin.kind === "clarify-reask"`), so a re-asked
question stays honestly missed until an answer exists.

## What landed

- `lib/clarify-history.js` - `REASK_LINE`, `reaskText(rec)` (the line, a fence longer than any run of backticks in the
  question, the question verbatim, then the choices), `reaskQuoteCheck(rec, text)` (the guard: the question byte for
  byte, the reader's line, every choice) and `reaskDigest(text)`. Records gained `reask: { at, by, jobId, thread, key,
  chars, sha256 }`; `ClarifyHistory.beginReask` claims synchronously, `finishReask` writes the durable record,
  `abandonReask` releases a claim for a refused send. `collapseItems` carries the record onto the item, `normalizeLoaded`
  reads it back, `save()` never writes the in-flight claim, and `readerReplies` skips a re-ask turn.
- `routes/clarify-history.js` - `POST /api/clarify/reask { seq }`, with the guards decided in one documented order: the
  record exists (404), it has a question (400), its item is still closed (400 answered / open / replied), it was not
  already re-asked (409, the in-flight claim or the durable record), the thread is still on the board (404, named), the
  thread is free (409, naming the run), the body quotes the record (500, never sent). The send is an injected
  `sendReask`, so the module starts no turn by a route of its own. The mount prefix moved to `/api/clarify` so both
  paths reach one module.
- `server.js` - `sendClarifyReask` is the send: `startThreadReply` (the panel's own reply path, with its tree guard and
  its `tree_busy` fence) for a worker, `assistant.say` for an assistant's thread. No fresh session, no second path.
- `public/clarify-history.js` - the closed row draws `↻ Re-ask this question` (or `↻ re-asked 2m ago · turn <id>` once
  the record exists), `clarifyHistoryReask` posts on the press with a page-level in-flight set, and
  `clarifyHistoryReaskLand` opens the asking agent and puts the NEW turn on screen (focus once, ring once). The button
  is skipped by the popup's keydown so Enter activates the button rather than the row; `clarifyHist.reasking` keeps a
  5 s repaint from putting an enabled button back under the press.
- `public/style.css` - the amber re-ask button and the violet `re-ask` record line.
- `test/clarify-history-reask.test.js` - the quote (the display line is NOT contained in the body, the stored question
  and every choice ARE), the fence, the claim and its durability across a restart, the record on the item, and the
  route's refusals (answered, live thread, dead session, gone record, a sender's own refusal, two concurrent presses).
- `tools/verify-clarify-reask.mjs` - the live gate: a real panel, a real page, a stub gateway. 38 checks at 1440x980.
- `docs/using-the-board.md` - the popup, the button and its four refusals, in the reader's own words.

## The proofs

- `npm run verify:clarify-reask` - 38/38: the button on four missed rows and none on the answered one; the press's
  `POST /v1/runs` body carries the 673-character, 13-line question byte for byte (fence and blank lines included) and
  all three choices into `session_id: th-reask`; the popup closes, the new turn is the open one and is on screen; the
  stub's `clarify.request` becomes the job's own `question` and the box is painted on that turn; the row then draws the
  record, a direct second POST answers 409 `already_reasked` and starts no run; two concurrent POSTs on another item
  start one run; a live thread and a dead session are refused by name.
- `node --test test/clarify-history-reask.test.js` - 14 tests, the guards and the byte-for-byte quote among them.
- `npm test` - the full suite, once, before the PR.
