# Landing: one Enter, one queued chip (1.153.2)

A reply is held behind a live turn, and one press of Enter drew it twice: two chips with the same words and the same
age, the Queue reply button reading `2 queued`, the x clearing both, and typing the same message again bringing the
pair straight back. Nothing was ever sent twice - the panel's own store will not start one hold twice - so this was a
card defect, not a delivery one. This landing removes the second chip and changes nothing else about the queue.

## The cause

A press writes the same entry to two places, and both of them draw:

**The page's own copy is pushed first.** `queueReply()` (`public/app.js:4029`) puts the entry into
`state.replyQueue` with `at` as its identity, then calls `postHeldReply()` (`public/app.js:4041`) to write it to the
panel. The POST's answer is what stamps `heldId` onto that entry (`public/app.js:4057`), and it is a round trip: for a
moment the page holds an entry with no id.

**The panel's view of it can arrive inside that moment.** The store keeps the record with the page's own `at`
(`lib/held-replies.js:254`), and the drain broadcasts the `held-replies` view whenever a hold arrives, starts or is
released (`server.js:2689`; the page's listener hands it to `applyHeldReplies()` at `public/core/sse.js:285`). The
press and that broadcast are independent requests, so their order is not promised.

`applyHeldReplies()` asked "do I already hold this record?" by `heldId` alone (`public/app.js:4138` before this
change). With the id still in flight the answer was no, the record read as one the page did not hold, and the function
pushed a second entry for the same words: one press, two chips, `2 queued`.

## The fix

An entry now answers that question by **identity before the id lands** (`public/app.js:4150`): its `heldId` when the
answer has been read, otherwise its own `at` - the identity the x and the drain already work in, which the panel
stores and echoes back - **with its text**, so a same-millisecond press in another tab cannot claim the record.

In the add loop (`public/app.js:4179-4189`) a record that matches an entry this way is that entry: it takes the
panel's id and `continue`s, so nothing is pushed. The chip already on the card stays the only chip, and it now carries
the id that the x's cancel and the drain's send both need. A record the page genuinely does not hold - a reloaded tab,
a hold the panel kept while it was down - still goes back into its thread's queue, which is the whole reason this
function exists.

Nothing else moved. The press guard still refuses a second press inside the first press's flight, so `queueReply()`
is still called once per press. The drain, the panel's store (`lib/held-replies.js`), the reply route and the send
path are untouched. The x still removes one entry by its `at` and cancels the record it names, and a re-queue is a new
press with a new identity.

One deliberate boundary: the settled-record loop still removes a page entry **by its id only**. Matching a settled
record by `at` there would take a re-queued entry with it when a cancel and a re-queue land in the same millisecond,
which is a worse defect than the one it would tidy. A settled record whose answer never landed therefore leaves its
chip until the next broadcast after the id does land; the POST's answer always sets it.

## What proves it

**The unit path.** `test/queue-held-snapshot-race.test.js` runs the page's own `queueReply()` and
`applyHeldReplies()` over a state model whose POST answer is held open, which is the race made deterministic: one
press plus the panel's view of that same press is one entry with the panel's id; the answer landing afterwards adds
nothing; the x clears it and cancels that id; a re-queue is one chip again; a record the page does not hold is still
restored; two presses in one millisecond are still two entries. `7 of 7` pass on this branch; against the base
`public/app.js` the same file answers `5 of 7` failed, the first with `2 !== 1` and the pair press with `4 !== 2`.

**The card a reader sees.** `tools/verify-queue-held-snapshot-race.mjs` drives the shipped renderer at 1440 x 1000 on
a sandbox panel from this tree, with the page's own `held-replies` listener (a recording EventSource) and a fetch that
holds the POST's answer open. On the base build it fails (a) with two chips and `2 queued` - the reader's report - and
on this branch it answers `21 of 21` passed, including the x cancelling the adopted id and the re-queue drawing one
chip. The pair of captures is the harness's own `--shots` output: `npm run verify:queue-held-snapshot-race` writes it
again, on demand, against this tree or against a `git archive` of any build.

**The suite.** `npm run test:changed` (110 files, the changed set for `public/app.js`) selected the reply and queue
tests among the rest. The reply/queue/held subset ran `254` passing with one failure in `test/queue-sweep.test.js`,
which passes alone in this tree and in a `git archive` of the base: it is a concurrency-sensitive neighbour, not this
change. The full `npm test` sweep answered `FULL_SWEEP_RESULT`.

## The number

Patch, 1.153.1 to 1.153.2: one defect in behaviour the panel already promised, no new surface, no module, no route
and no option added.
