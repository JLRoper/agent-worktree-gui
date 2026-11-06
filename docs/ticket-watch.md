# The ticket watch

A per-assistant list of Jira keys, a poll that reads each one and reports what moved, and one route that wakes the
assistant that owns the list. The assistant reads the ticket, decides whether the reader has a decision to make, and
raises a clarify card only when there is one.

    node tools/ticket-watch.mjs list
    node tools/ticket-watch.mjs check              # one poll, every assistant's list
    node tools/ticket-watch.mjs show SR-242996     # the ticket, for the judgement below

Nothing here writes to Jira. Every request this watch makes is a `GET` of the issue (and, for a ticket with more
comments than one page returns, of its comment page). No comment, no transition, no link, no worklog.

## The poller reports movement. It does not judge it.

This is the whole contract, and it was arrived at twice. The first build carried an "addressed to the reader" test:
a comment mentioning `[~Roper]`, the reader's display name in the body, a non-reader author on a Waiting for Customer
ticket, or a ticket assigned to the reader. A comment that failed the test was still raised, but stamped "not
addressed to you", and the card carried that stamp to the reader.

That made the poller a second, worse judge of a ticket it had not read. Relevance is not in a REST payload: it
depends on what the comment asks, what the thread has already settled, and what the reader is doing this week. The
addressed test is gone, and so is the card the poller used to write. What is left is the split this document
describes:

- **the poller** detects movement and says which ticket moved and what moved on it. It has no opinion on whether
  the movement matters, and it puts nothing in front of the reader;
- **the assistant** reads the ticket, judges it, and raises a clarify card only when the movement leaves the reader
  a decision to make.

The wake text says exactly that, every time:

    Ticket watch: SR-242996 moved - Firewall outgoing - k3s DEV nodes to Optym Azure Event Hubs TCP 5671.
    What moved:
    - new comment #4225070 from Greene, Ernest at 2026-11-06 08:17:20, 83 characters
    Read the ticket: node tools/ticket-watch.mjs show SR-242996   (https://jira.sefl.com/browse/SR-242996)
    Reported as movement only - this poller has no opinion on whether it matters, and it has put nothing in front of the reader.
    Judge it yourself: read the ticket, then raise a clarify card only if the movement leaves the reader a decision to make. The procedure is docs/ticket-watch.md.
    Nothing has been written to Jira and nothing should be - reading is all this watch does.

## The three movements, and no fourth

| class | what it is | the id a retry recognises |
| --- | --- | --- |
| `comment` | a comment whose Jira id is greater than the last one seen. Jira ids increase, so "new" is a number, not a time. | the comment id |
| `status` | `status.name` differs from the one last seen | `from->to` |
| `assignee` | `assignee.displayName` differs from the one last seen. "Unassigned" is a value, not an absence: a ticket that loses its assignee moved. | `from->to` or `none->to` |

A fourth class needs a name in `MOVEMENT_KINDS` and a paragraph here saying what the assistant is expected to do with
it. Nothing else is tracked, and Jira's `updated` stamp alone is not a movement: an edit this watch does not follow
(a description, a link) must not rewrite the list and must never wake anybody.

`lastSeen` is the four facts the next poll diffs against, and a `lastSeen` of all nulls is the **baseline**: a key
added a minute ago and never checked. A baseline raises nothing, so adding a ticket is never a burst of wakes about
history the reader has already read.

## Where the list lives

    state/assistants/<assistantId>/tickets.json

beside that assistant's `queue.json`, its charter and its settings, so a reader who opens `assistant-3/` sees
everything that assistant watches in one place. Each entry is exactly:

    { "key": "SR-242996", "note": "why it is watched", "addedAt": "...", "lastSeen": { "commentId": "4217187", "status": "Waiting for Customer", "assignee": "Greene, Ernest", "updated": "..." } }

The state directory resolves through `lib/paths.js`, the same function the panel boots with, so `WAG_HOME`,
`--state-dir` and the default `~/.wag` mean here what they mean there.

The four Optym SRs are seeded from `ticket-watch.seed.json` at the repo root:

    node tools/ticket-watch.mjs seed --assistant assistant-3

`seed` is idempotent: a key already on the list keeps its `addedAt` and its `lastSeen`, and only a changed note is
written. Re-running it over an unchanged list writes nothing.

## How the assistant judges a movement

Read the ticket first (`show <KEY>`), not the wake: the wake tells you what moved, and the ticket tells you what it
means. Then ask four questions in this order, and stop at the first yes.

1. **Does the movement ask the reader something?** A question put to the reader, a request for a test, a "can you
   try now", a mention that expects an answer. A question from someone else to someone else is not this.
2. **Does it put work on the reader?** The ticket has been assigned to the reader, or a status moved to one that
   needs the reader's action (a rejection back to them, a blocked state they own).
3. **Does it leave a choice only the reader can make?** Close or keep open, accept the fix or push back, change the
   scope, spend the time.
4. **Otherwise: no card.** Someone else's bookkeeping, a colleague's own progress note, an internal move between two
   other people's queues, the reader's own record of what they already did, an FYI with nothing asked.

A card that survives question 3 is one paragraph: what moved, what the reader is being asked, and the choices. It is
raised through the assistant's own clarify tool. The assistant does not answer the ticket, does not comment on it,
and does not write anything to Jira; if the decision is "reply to Greene", the card says so and the reader sends it.

## The worked example: two movements, one card and one not

Both movements below are real, and both were delivered by a live `check` against `https://jira.sefl.com` on
2026-11-06, through a pass-through proxy that recorded every request method. The list was a scratch copy of the
four SRs, and the ticket's comment mark was rewound to the comment before the one being delivered, so a comment
that had already happened was reported as a movement. Jira was only read: all 18 requests the run made were GETs.

### A movement that leaves the reader a decision

SR-242996, comment 4225070 from Greene, Ernest, 83 characters:

> [~Roper] I have made additional changes for this. Are you able to connect properly?

Question 1 fires: Greene is asking the reader whether the connection works now. That is a decision and a test the
reader has to make, and nothing in the ticket can settle it. **Card raised.** The card names the question and offers
the choices: test and reply, ask which change he made, or close as working.

### A movement that correctly produced no card

SR-243583, comment 4224463 from Roper, Jacob, 984 characters. The wake the poller sent was, in full, the same shape
as the one above:

    Ticket watch: SR-243583 moved - Firewall outgoing - k3s QA nodes to Optym Azure Event Hubs TCP 5671.
    What moved:
    - new comment #4224463 from Roper, Jacob at 2026-11-05 18:39:58, 984 characters
    Read the ticket: node tools/ticket-watch.mjs show SR-243583   (https://jira.sefl.com/browse/SR-243583)
    ...

The ticket, as `show SR-243583` printed it, is Waiting for Customer and assigned to Roth, Chris. The comment is the
reader's own record of the test he ran from the QA cluster: two pods, `PASS - CONNECTED`, `Verify return code: 0
(ok)`, with the control on 443 and the DNS resolution. Nothing in it asks the reader anything and nothing has been
left for him to decide: he wrote it, he already knows the answer, and the ticket is waiting on Chris.

Questions 1 to 3 all fail, question 4 applies. **No card.** The poller still woke the assistant, because waking on
movement is the poller's job; the judgement that this movement needed nothing from the reader is the assistant's,
made from the ticket rather than from a keyword. The assistant's queue stayed empty (`tasks: 0`).

This pair is the point of the split: a mention (`[~Roper]`, in the SR-242996 comment) and a non-mention both produce
the same wake, and the poller is not the thing that decides between them.

## What one poll does

    node tools/ticket-watch.mjs check [--assistant <id>] [--dry-run] [--fixture <file>] [--json]

1. `GET /rest/api/2/issue/<KEY>?fields=summary,description,status,assignee,updated,comment`, with
   `Authorization: Bearer $JIRA_API_TOKEN`. The token comes from the environment: never a file, never a flag, because
   a token in argv is a token in the process list.
2. Diff the four facts against `lastSeen`. A baseline writes the snapshot and says nothing.
3. On a movement, `POST /api/ticket-watch/wake` with the ticket key and every movement, in the same neutral words.
   That route is the panel's own `assistant.wake(text, null, "ticket", {assistantId})` behind a door: the ladder
   `tools/verify-wake-ladder.mjs` drives, with the assistant's own settings and wake budget applied and a refusal
   returned as a value. `"ticket"` is an event rule, not a sweep rule, so a busy hour cannot silently drop the wake.
   The poller starts no turn itself and knows nothing about the gateway.
4. Write `lastSeen` only after the wake landed. A failed wake leaves the snapshot alone, so the next poll reports the
   same movement again instead of forgetting it.

`--dry-run` prints what moved and writes nothing. `--json` prints the per-ticket verdicts for a cron log.

A second `check` with nothing moved on Jira classifies zero movements, makes no HTTP call at all, and leaves the list
file byte for byte as it was.

## The CLI

| command | what it does |
| --- | --- |
| `add <KEY> [--note "why"] [--assistant <id>]` | put a key on one assistant's list. Re-adding edits the note and keeps the baseline. |
| `list [--assistant <id>] [--json]` | every watched key, with its last seen status, assignee and comment id. |
| `remove <KEY> [--assistant <id>]` | stop watching one key. |
| `seed [--assistant <id>] [--file <seed.json>]` | load `ticket-watch.seed.json` (the four Optym SRs) idempotently. |
| `show <KEY> [--comments <n>] [--json]` | the ticket for the judgement: fields, description and the last n comments. |
| `check [...]` | one poll, as above. |

`add`, `remove`, `list` and `seed` default to `assistant-1`; `check` covers every assistant's list unless `--assistant`
narrows it.

## Scheduling the poll

The poll is a script, not a server: it can run from cron, a scheduler, or by hand, and it needs `JIRA_API_TOKEN` in
its environment and a panel that is up for the wake.

    */15 * * * * JIRA_API_TOKEN=... node /path/to/tools/ticket-watch.mjs check --assistant assistant-3 --json >> /var/log/ticket-watch.log 2>&1

A panel that is down is a failed wake, not a lost movement: nothing is written to the list and the next poll reports
the same movement again.

## Verification

Three proofs, all run from this worktree on 2026-11-06:

- `test/ticket-watch.test.js` (part of `npm test`): 15 tests, no server and no Jira. Pins the list, the baseline, the
  three classes, the identical event shape for a comment that names the reader and one that does not, the wake's
  words, idempotence, the route's refusals, and the seed.
- a probe against the real panel (`tools/panel-testkit.mjs` boots `server.js`) with a stub Jira that records every
  request method and refuses anything but GET: 18/18 checks. The baseline writes four snapshots and wakes nobody;
  one poll then reports a comment, a status change and an assignee change on one ticket (`movements=3 wakes=1`), the
  assistant is woken once, and the reader's queue stays empty (`tasks: 0`); a second, unchanged check reads
  `movements=0 wakes=0 writes=0` with the list's sha256 unchanged, makes no panel call at all (it is pointed at a
  dead panel URL and still exits 0), and every one of the 17 Jira requests it made was a GET.
- a live probe against `https://jira.sefl.com` with the four real SRs through a pass-through proxy that recorded the
  method of every request: 14/14 checks. The four baselines write and wake nobody, the second check is silent with
  identical bytes and no panel call, all 18 requests are GETs, the reader's own QA note on SR-243583 (comment
  4224463) is reported and correctly produces no card (`tasks: 0`), and Greene's question on SR-242996 (comment
  4225070) is reported in exactly the same words for the assistant to judge.
