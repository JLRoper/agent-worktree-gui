# The board's watchdog sweep

`tools/panel-watch.mjs` is the watch that runs on a clock instead of inside a panel turn: it looks at the board
from outside, and when something needs a person or the assistant it hands one block of news to
`POST /api/assistant/watchdog`. The decision it makes is `lib/panel-watch.js`, and `test/panel-watch.test.js` is
its contract. The delivery is the panel's: `test/watchdog-owner-routing.test.js` is that half's contract.

    node tools/panel-watch.mjs check                 # one pass, announce what is news
    node tools/panel-watch.mjs check --dry-run       # say what it would report, write nothing, announce nothing
    node tools/panel-watch.mjs check --json          # the pass as data, for a cron log
    node tools/panel-watch.mjs state                 # what the saved one-shot set holds

## Whose run it is, and where the alert goes

Every line names the run's OWNER: `LONG RUN 7a9f9a57 - ... has been running 64 min (owner: assistant-3)`. The
owner is resolved from the board, in this order, and never guessed:

1. the QUEUE ROW the run carried (the queue file's directory is the owner);
2. the run's THREAD, when it is an assistant's own turn;
3. the TREE's recorded owner (a tree the reader handed to another assistant);
4. the run's own `assistantId` stamp.

Nothing answers, and the line says `(owner unknown)` - never `assistant-1` by default. The old line named nobody,
and a reader filled the gap with Assistant #1, which is how another assistant's row was reported as #1's own work.

Delivery, all from ONE stored record, with the same alert id on every copy:

- the sentry's own page (Assistant #1) gets the ledger turn, `Watchdog: <line> | <line>`, exactly as before;
- the OWNER gets the alert row on its own Alerts page and a wake carrying the same id, so the assistant whose
  queue holds the row sees it and can act;
- the owner's `escalateTo` list is an EXTRA set of wake recipients, never a replacement.

The sweep labels its lines from the panel's owner map (`GET /api/assistant/watchdog/owners`), and the panel
re-resolves each owner before it delivers anything, so a caller's map can never decide where an alert goes. One
record per run: a long run is a live condition said on every pass with the same id, and the sentry pass that sees
the run stop closes it - the owner's row goes with it, and the ledger turn stays in the transcript as history.

## What one pass reads

Two lists that are not the same list:

- **the feed**, `GET /api/jobs`: every run the panel is showing, which includes runs it resurrected from the
  gateway after its own store let them go;
- **the store**, `jobs.json` under the panel's state directory (`--store` overrides it): the runs the board has
  a record for. A run the store does not hold has no row, no queue entry and no repair on the board.

## The two classes, and why they differ

| the run | the rule |
| --- | --- |
| failed, the store holds it, no `endedAt` | **LIVE** - it is failing now, so every pass reports it until it ends or a repair replaces it |
| failed, `endedAt` stamped | **HISTORY** - one report, then never again |
| failed, the store no longer holds it | **HISTORY** - one report, then never again |
| still marked running past `--long-run-minutes` (default 55) | a live condition: reported while it is true |

An ended run is a fact about the past. It does not become true again, and a run the board cannot see cannot be
acted on: naming either one on every pass is noise that buries a real failure. A live failure is the opposite -
silence there is the bug that lets an agent stay stuck for an hour.

## The state file

`panel-watch.json` beside the panel's other state files (`--state` overrides it):

```json
{ "version": 1, "reported": { "<run id>": "<first reported ISO>" }, "suppressed": 0, "downAt": 0 }
```

- `reported` is keyed by run id and pruned by **recency**. An id the feed still names is never pruned; the rest
  are kept for a seven day retention window and then dropped oldest first. Order is time, never the id.
- It is written **only after the announce landed**. A refused announce (409 while the assistant already has a
  turn running) leaves the file untouched, so the next pass retries the report instead of losing it.
- `suppressed` is the `wake-suppressed` journal count this sweep last saw, so a new suppression is news and a
  journal that simply rotated (which makes the count drop) is not. `downAt` is when the panel was last reported
  down, so an outage is news once an hour rather than every pass.

## The defect it fixes

The watch used to live outside this repo and keep its one-shot set as a list that was sorted (the ids are hex,
so sorted is alphabetical) and then cut to the newest 200 **by that order**. Every id that sorts low was dropped
on each save, so the next pass called it new: two runs that had ended hours earlier and had long since left the
job store were named in a fresh `Watchdog: FAILED ...` turn every ten minutes. Nothing on the board could act on
them. The set is now a time-keyed record, the prune is by recency, and the two classes above are decided before
anything is reported.

## Wiring it to a clock

A cron (or a Hermes job) runs one pass and does nothing else:

    node tools/panel-watch.mjs check --quiet

`--quiet` prints nothing on a quiet board. Set `PANEL_TOKEN` when the panel is not on loopback (writes need
`x-panel-token`); `PANEL_URL` or `--panel` names a panel on another port. A panel that cannot be read is
reported as `PANEL DOWN` once an hour and exits 1, so the cron log keeps one line per outage rather than one per
pass.
