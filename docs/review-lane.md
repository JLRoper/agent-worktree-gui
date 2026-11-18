# The review lane: a finished row cannot be forgotten

A run that ends with something to read leaves a **delivery** on its row. The row then carries an amber `▣` - distinct
from the yellow lock and the blue turnover mark - with `✓ Reviewed` beside it, a card under the row holding the run's
one-line summary, the report it named as a real link and its next steps as chips, a count in the header that filters
the table to exactly those rows, and a place in the Human rotation as a third kind beside permissions and clarify
questions. It leaves all of those when the reader presses Reviewed, Mark all reviewed, or when the row itself stops
being a row.

## Where the delivery comes from

The delivery is **inferred at the settle seam**, not declared by the agent: `lib/jobs.js harvestReview` reads the run's
last assistant message and the row's close reason through `lib/review-inbox.js parseDelivery`, which takes

- the **summary** from the first line of prose that is not a panel marker line (`TODO`, `DELIVER`, `RELEASE`, a path on
  its own), trimmed to one line;
- the **report** from the first `docs/reports/*.html` path it names;
- the **next steps** from the lines under a "Next steps" heading (or a numbered list at the end when there is no
  heading), capped at four, so a long list cannot push the agents below the fold.

Nothing to read means nothing is recorded: a run that ends with no summary, no report and no steps leaves no entry,
because a lane that counts empty runs is a lane nobody empties. This route was chosen over a new agent verb or a new
close-action field because the panel already holds both inputs at the moment it settles a run, and asking every worker
to declare something it does not currently declare is a change to every worker brief for no gain.

## Where the record lives

`reviewsFile` in `lib/paths.js` (default `logs/reviews.json`), beside the panel's other per-row state - never inside a
worktree, where it would be git noise, a merge-conflict source and would not outlive the tree's branch. The key is the
**tree path alone** (`lib/review-inbox.js reviewKey`), lowercased with forward slashes: a job record carries no project
field, so a key that needed one would never be written. `project` rides along as a display hint only.

A record is removed by one verb, `forget`, called from the store's own `drop` event - the only complete statement that
a row has stopped being a row. There is deliberately no sweep over "the rows visible now": a scan emits partial sets
while it walks, and deleting against one of those throws away the delivery the reader is coming back for.

## The surfaces

| Surface | Where | What it says |
| --- | --- | --- |
| the row mark | `public/render-projects.js reviewRowMarkHtml` | amber `▣` with its own class, colour and aria-label; drawn after the lock and the turnover mark |
| the row's press | same | `✓ Reviewed` on the row itself, not inside the card: a control that costs a click to reveal is a control the reader skips |
| the result card | `public/board-scaffold.js reviewBlockHtml` | drawn by the PANEL every time the row's detail is painted, from the stored record - nothing waits, times out or reports back to a run, so an unanswered card is free |
| the report anchor | same | a real anchor through the panel's own open-file route (`data-open-file`), with the TREE as its base, because a report path is relative to the worktree the run worked in |
| the header count | `public/app.js paintReviewChip` | reads `state.rows`, never the store, so a stale entry cannot inflate it; hidden at zero; clicking it filters the table |
| the filter | `public/app.js tableHidesRow`, `render-projects.js laneOrder` | narrows to exactly the rows the count counted, overrides focus mode and the chart's top N, and draws their projects open |
| the Human rotation | `public/app.js humanQuestions` + `public/core/review-lane.js` | the third kind, after permissions and clarify questions, oldest first inside each kind; `H` opens the row, centres and flashes the card and puts `✓ Reviewed` under the caret |

The arithmetic lives in one pure module, `public/core/review-lane.js`, read by all five surfaces, so the mark, the
card, the count, the filter and the rotation cannot disagree about the same row.

## Routes

- `GET /api/review` - the whole record (`{ count, total, entries }`), or one row's answer with `?path=`.
- `POST /api/review` - `{ op: "reviewed", path, project? }` for one row, `{ op: "review-all" }` for the batch. Writes
  need the panel's token like every other write.

## Proof

- `node --test test/review-inbox.test.js` - the parse (report found, absent, several), the state machine, the count,
  the store, the settle seam.
- `node --test test/review-lane.test.js` - the client arithmetic and the wiring of all four surfaces.
- `npm run verify:review-lane` - a throwaway panel over a real git fixture with three worktrees, seeded through the
  real settle seam, driven in headless Chromium at 1440x900: the mark on exactly the awaiting rows, the filter, the
  card, the open-file POST with the tree as its base, `H` landing on the oldest with the caret on Reviewed, the bulk
  press, and a reload that finds the stamp on disk.
