# The 1.4.2 ledger: what `ledger.json` is, and what it costs

The usability round landed two things a reader can weigh: the report
(`pipeline-flow-usability-round.html`, 49,094 bytes) and, beside it, a 358,012-byte
`pipeline-flow-usability-round/ledger.json` — 16,956 lines, no trailing newline, CRLF.
This note is the accounting the landing asked for: whether that file is evidence or an
accident, and how big the page is with it.

## Verdict: evidence, not an accident

It is the raw measurement dump, and it was written deliberately:

- the harness takes `--json <file>` as a documented flag
  (`node tools/verify-pipeline-flow-usability.mjs --shots <dir> --json <file>`) and writes
  the ledger beside the shots;
- the report cites it by path twice — once as "the raw ledger is in …"
  (§2, the measurement method) and once in §10 Reproduce;
- the numbers the report argues from are in it, field by field. `stageWords` against
  `totalWords` reads 4 of 104 (`investigate`), 32 of 415 (`sefl-review-loop`) and 68 of 450
  (`acceptance-thirteen`) — the three pairs §1 quotes. Nothing in the report is asserted
  without a row here that can be checked against it.

What it holds: 18 records — 9 measured scenarios × 2 viewports (1280×800, 1821×700). The
scenarios are `investigate`, `sefl-review-loop`, the three `acceptance-thirteen` states
(default, end, fit), and the studio bundle's `A-position`, `A-refused`, `A-long`,
`A-long-fit`. Each record carries the card rect, the scroller's box and `scrollLeft`, the
track height, every drawn node's rect, the notches with their `aria-label`/`title`
lengths, the links and arcs, the printed `drawingText`, the per-stage word counts, the
count sentence and fit state, the marks rule, the current stage's visibility, and the
visible ink area against the card's area. `pageErrors`, `consoleErrors` and `errors` are
all empty — the page stayed clean across all 18 runs, which is the harness's own exit
condition.

## Where the bytes go

The file is not dominated by prose; it is dominated by rectangles.

| field | share of the 358 KB |
|---|---|
| `nodes` (every stage node's rect, per case) | 36.0% |
| `notches` (rect + label lengths) | 10.1% |
| `links` | 2.7% |
| `drawingText` | 1.4% |
| `keys` | 1.0% |
| everything else (card, body, scroll, status, arcs, fit, …) | ~49% |

Roughly 165 KB — `nodes` plus `notches` — is per-element geometry, and the report quotes
only a handful of aggregates derived from it. Dropping just those two fields would leave
about 193 KB (54% of the file), and trimming to only the fields the report cites would be
smaller still — but it would also delete the audit trail. It is kept whole on purpose:
the aggregate is the claim, and the per-node rect is the thing a reader can re-check when
they doubt it.

## How big the page is with it

The page does not get bigger. `pipeline-flow-usability-round.html` is 49,094 bytes and
*links* the ledger in two places; it does not embed it, fetch it, or inline it. Opening
the report costs 49 KB plus the 12 images the markup references. The ledger is a second
request that happens only when a reader clicks it.

The folder is where the weight is: 2.0 MB total — 1.6 MB of 16 PNGs at DPR 2, plus the
358 KB ledger. Four of those 16 shots are not shown inline (`04-seven-1821`,
`07b-thirteen-1821-fit`, `11-long-1821-page`, `11b-long-fit-1821`), 493,905 bytes between
them; three are linked from the prose and `07b-thirteen-1821-fit` is referenced nowhere —
kept as the measurement's own record of the second width rather than shown inline.
Nothing under `public/` is affected; this is a review artifact, not a page the panel
serves.

## One defect worth naming

`ledger.json`'s top-level `tree` field records the author's absolute Windows path:
`C:\ProjectDevelopment\agent-worktree-gui\.worktrees\playwright-usability-rou-8ec471`.
It is metadata, not measurement, and it has two consequences: a local path ships in a
committed artifact, and re-running the harness on any other machine produces a different
`tree` value, so the file cannot be byte-reproduced even though every measurement in it
can be. A relative path or the measured commit's sha would carry the same provenance
without either problem.

The file is not deleted here — this landing only reports on it. Trimming the `tree` field
(and, if the size is judged a cost, the unfiltered `nodes`) belongs to the round that next
touches the harness.
