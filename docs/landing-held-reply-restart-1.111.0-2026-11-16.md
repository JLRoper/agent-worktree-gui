# Landing: a reply queued behind a live turn survives the panel (1.111.0)

PR #773 lands one guarantee the board only appeared to have: a message the reader queues while its agent is
still turning is held by the PANEL, not by one browser tab, and the panel starts it when the thread is free -
after a reload, after a panel bounce, and after the death of the node process that was holding it.

Merge `d7ac312`, tag `v1.111.0` at `c82657d`, `origin/main` at `f891968` (the render), `changelog --check`
reads current - 616 releases. Report: `docs/reports/held-reply-restart-2026-11-16.html`.

## The three defects, traced before anything was changed

The queue was `state.replyQueue` in `public/app.js`: a `Map` of thread to `{text, at, attachments}` entries,
filled by `queueReply`, drained by `drainReplyQueue` on every job event for that thread. Nothing on the server
knew it existed.

1. **A restart dropped it.** No route, no file: `POST /api/held-replies` answered 404 on main, and the
   attachment paths the entry carried were files under the panel's `attachmentsDir` that nothing else named.
   A panel bounce, a reloaded tab or a dead node process lost the words and stranded the files.
2. **A refused send lost it.** `drainReplyQueue` spliced the entry out of the queue BEFORE awaiting the send
   and swallowed the failure (`catch { /* sendReply reports its own errors */ }`). A 409 - `tree_busy`,
   `tree_released`, the gateway declining - removed the reader's message from the board and said so in a line
   beside the box.
3. **A thread could stay busy for ever.** A restored card whose job carries a `runId` comes back live and
   pending (`lib/jobs.js:1262`), so `threadBusy(thread)` stays true and the drain returned on its first line.
   The entry kept promising "queued 4m ago" and nothing was ever going to send it; the same job also keeps the
   other threads in its tree out, because `jobs.busyFor` checks the thread and then the tree.

## The fix

`lib/held-replies.js` (new) owns the record at `state/held-replies.json`: a synchronous atomic write before any
turn is accepted, `seq` for the order the replay walks, an id that a retried POST cannot duplicate, one
`claim()` so exactly one caller can turn a record into a turn, `held`/`sending`/`sent`/`cancelled`, a boot
repair for the one window a crash can leave (a claim whose process died: a job carrying the id means the turn
was accepted, no job means the record goes back to `held`), and caps that never drop a record still owed a
turn. A file that cannot be parsed is left untouched and nothing is replayed out of it.

`server.js` adds `GET`/`POST /api/held-replies` (add, edit, cancel, send) and the drain: on a settle, on a 2s
clock that exists only while something is open, and once at boot AFTER `reconcileRestored` and `stopStaleRuns`.
A replayed hold goes through `startThreadReply` - the reply route's own acceptance - with its id in
`origin.heldId` on the job, so a replay cannot reach a tree by a second path and a job that carries the id is
what stops a second run.

`public/app.js` and `public/core/sse.js`: the press, the edit and the x write through to the record; the drain
removes an entry only when a turn exists, or when the panel answers `gone` (the record was already settled);
`applyHeldReplies` reconciles the page's queue with the panel's once after the first snapshot and on each
`held-replies` event, so a tab that was away does not keep promising a message the panel already sent.

The live-run re-attach path is untouched. The replay runs after it and only starts a record whose thread
`jobs.busyFor` already calls free.

## What proves it

`tools/verify-held-reply-restart.mjs` boots the real `server.js` over a throwaway state directory against a stub
gateway and kills the node process with `taskkill /F` in the middle of a run.

- **After, port 55129: 42/42 checks.** A hold written behind a live turn (on disk before a turn existed, not
  submitted while the turn was live, started by the settle when it ended). Then two holds behind a long run,
  each with an attachment uploaded through `POST /api/attachments`, the process killed, the gateway told the run
  finished while the panel was down, and the panel restarted: both holds start in arrival order, each prompt
  carries its own attachment path exactly once, each message is in exactly one submitted run and in exactly one
  job (`origin.heldId`), and the store ends with nothing open.
- **Before, port 53138: 7/9 and it stops.** The same gate against a `git archive` of `12443a06` fails at the
  first held write - `POST /api/held-replies` 404, no `held-replies.json`.
- Neither run used 7331 or 18083, and the live board's 7331 listener count was 1 before and 1 after each.
- Unit: `test/held-replies-store.test.js`, 10 tests. The queue and attachment suites still pass - 138 tests
  across store, queue, jobs, assistant-queue and steer.

## The bug this work found in itself

The first draft of `drainHeldReplies` never started anything after a settle, and the kill test found it in one
run. A pass that ends SYNCHRONOUSLY (every thread busy, which is the normal case behind a live turn) cleared the
in-flight flag inside its own body, and the assignment that stored the promise then put the settled promise
back: every later pass returned that stale promise and did nothing. Nothing threw and nothing logged; the clock
ticked every two seconds into an empty function. The flag is now cleared from the promise's own `.finally`,
scheduled after the assignment, and the reason is written in the code.

## One pre-existing failure, not from this change

`test/child-route.test.js` fails identically on this branch and on a `git archive` of main (`409` where the test
expects `200`, in the child-worktree cut). It is not in the files this change touches.

## Version

`minor`: 1.110.0 -> 1.111.0. A new route, a new store and a new user-visible guarantee, not a fix inside an
existing behaviour. Main was 1.110.0 at `12443a06` when the number was taken.
