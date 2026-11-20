# Landing: a TO line is delivered once, and its thread is claimed before the send (1.137.1)

A panel restart re-delivers old TO lines. The delivery path had no replay key, and it asked the live-run guard
before the run existed in the store, so two old replies re-read in one pass could each start a run on one thread.
This landing closes both halves: a TO now carries the same kind of key QUEUE and MESSAGE have, and the thread is
claimed synchronously before anything is sent.

## The defect, as reproduced

The listener PID 58580 booted at 05:25:55Z. At 05:26:25Z the panel woke
`wtgui-read-row-169-in-c-users-rope-d2c545` with two old replies at once: the 03:50 TO and the 03:55 landing TO.
Two run rows appeared on that thread together, and the journal records the duplicate at 05:28:30. The replayed
landing instruction would have re-landed PR #806, which had merged at 03:55:40Z; it only stopped at a 401. The same
defect re-pushed a branch the reader had ordered deleted on 2026-11-19 at 21:30:12.

## The reading, confirmed in the code before the change

- QUEUE and MESSAGE each compute `carryKeyFor(job, kind, index)` and refuse a second carry with
  `queue-replay-refused` / `message-replay-refused` (`lib/assistant.js:6196`, and the key call sites at 6415 and
  6493, the refusals at 6440 and 6517 before this landing).
- The TO block had no key and no content check at all. It checked `this.jobs.busyFor(to.thread)` inside a promise
  chain, and `carry` invokes that chain immediately for every line in the harvest.
- `Jobs.busyFor` is correct in itself (`lib/jobs.js:5454`): it reads live statuses off the store. The store is what
  is early, not the guard. `Jobs.create` (`lib/jobs.js:3656`) is `async` and awaits a lost-session read and a
  gateway probe before the run is in `this.jobs`, so two TOs released together both read "free" and both start.

## What landed

- `lib/assistant.js:6359` - the TO loop is indexed and keyed: `carryKeyFor(job, "to", ti)`, so `<turn>|to|<index>`
  is the line's identity. The refusal is `to-replay-refused`, naming the thread, the turn that wrote the line and
  the delivery that already happened (its time and job id): `lib/assistant.js:6853`.
- `lib/assistant.js:6853` `deliverTo` - the whole delivery in one named place, in this order: the key, the thread
  on the board, the claim, the live-run guard, the ledger record before the send, the send, the ledger record
  settled with the job id.
- `lib/assistant.js:487` - `this.toSends`, a per-process `thread -> { turn, at }` claim. It is taken before
  `busyFor` is asked anything and held until the send settles, so the second TO to that thread is refused with
  `to-skipped` naming the turn that holds it (`lib/assistant.js:6873`). The claim is released in a `finally`, so a
  refused or failed send cannot wedge it.
- The ledger record is written BEFORE the send (`lib/assistant.js:6930`), as MESSAGE's is: a crash between the two
  leaves "this line was carried" rather than an instruction the next boot delivers again.
- A TO refused because the thread was busy is recorded as `refused` (`lib/assistant.js:6894`). A re-read of that
  turn after a restart is not a retry, so a held TO does not become a later delivery either.

## What was not touched

- `Jobs.busyFor` is unchanged: the defect was the moment it was asked, not what it answers.
- SPAWN, QUEUE and MESSAGE keep their own guards and their own refusals. The SPAWN card, the QUEUE row's
  `carriedKey` and the MESSAGE ledger are byte-identical to 1.137.0.
- `answerThread`'s own busy check is unchanged, so the reader's Send button and the assistant's TO still go through
  the same backstop they did.

## Tests

`test/assistant-to-replay.test.js` (new, 4 of 4) drives the shipped `Assistant` against a store whose `create` is
asynchronous like `Jobs.create`, in a real git tree, so the window that let the second run through is the real one:

- a TO is delivered, its job is marked done, the state directory is re-read by a second panel with no remembered
  turn ids, and the identical turn is harvested again: zero new runs and one `to-replay-refused` line naming the
  thread, `turn-old` and `job-1`;
- two TO lines to one thread in one harvest: one run, one `to-skipped`, no `to-replay-refused`;
- a TO to a thread whose run is live: no run, one `to-skipped`, no `to-replay-refused`;
- the same instruction from a new turn is delivered again: two runs, two ledger keys, `turn-a|to|0` and
  `turn-b|to|0`.

Before the change, three of the four failed (the replay started a second run; two TOs started two runs; no `to`
key was ever written) and the live-thread case passed, which is the guard this landing must not weaken.

The existing suites that own the neighbouring guards were re-run unchanged: `test/assistant-carry-key.test.js` 6 of
6, `test/command-audit.test.js` 6 of 6, `test/assistant-director.test.js` and `test/spawn-busy.test.js`.

## Known limits, stated rather than hidden

- The claim is per process. Two panels pointed at one state directory do not share it; what they do share is the
  ledger, which is written to disk before the send, so the durable half still refuses the replay.
- A send that never settles holds its claim until it does. `jobs.create` carries its own probe timeouts, so the
  claim is released on a bounded clock; the alternative was leaking a second run.

## Version

`1.137.1`, patch: a defect fix with no new control and no change to the grammar. Node one on the commit that first
declares the number.
