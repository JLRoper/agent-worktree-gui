# Landing: the first slice of waves of work (1.152.0)

`docs/reports/waves-of-work.html` landed on main as a design and said so plainly: "The first slice in section 6 is a
plan; nothing in this page was produced by wave code, because none exists." This branch is that slice. It adds the
record, the explicit membership on a task, the derived state, and one lane in the Initiatives tab. It adds no
scheduler, no automatic advance, no fan-out and no auto behaviour: those are rows 193, 194 and 195, and nothing here
moves a row.

The four decisions were the reader's, accepted 2026-11-21, and are implemented rather than argued with: a wave names a
TEMPLATE pipeline its tasks inherit and a task may name its own; membership is EXPLICIT, a task carries `waveId`, so a
wave can span projects; the next wave opens only on a green live read-back with a per-wave auto switch defaulting off;
and the surface is a LANE IN THE INITIATIVES TAB, not a separate Waves tab.

## The record, in its own file

`lib/waves.js` holds `{id, initiativeId, position, title, entryGate, exitGate, template, auto}` and nothing else the
design forbids: no `state`, no `done`, no `doneAt`, no `percent`, no `blockedBy`, no trees. The store is
`waves.json`, keyed by initiative id, beside `initiatives.json` (`lib/paths.js` `wavesFile`, derived the way
`initiativesFile` is, and listed on `STATE_FILE_NAMES`). One document per concern: an initiative write never rewrites
a wave and a wave write never rewrites the initiative document.

The read copies the initiative store's one write rule even though this slice has no writer: a file that exists and
cannot be read is REFUSED with its path and its parse error (`readable: false`, HTTP 409 on the route), and the bytes
are left alone. A missing file is the ordinary first run: zero waves, not an error. One bad record is one record the
lane does not draw, with its sentence in `skipped`, rather than the whole file refused: a wave list is something a
reader edits by hand, one record at a time.

A template is a NAME, never a copy. An id the bundle no longer holds stays on the record and the lane reads it
`unresolved`; it is never silently nulled, because the next bundle may bring the id back.

## Membership: the task's own field

`lib/assistant/queue.js` `pickTask` now carries `waveId`, the way it already carries `pipelineRun`: verbatim, with a
cap and no normalisation. A task that names a wave the store does not hold keeps the name and reads unresolved from the
one module that reads the store; this module is not that reader, and rewriting an unknown id to null here would
silently put the task back in no wave. Absent, null and empty all mean no wave. Nothing is backfilled and nothing gets
a default wave, which is the design's explicit refusal.

That field is the only link. `waveLane` buckets every assistant's rows by their own `waveId`, so a wave with a member
in project A and a member in project B draws both; nothing filters members by the initiative's tree keys, which would
have dropped the cross-project case the decision exists for.

## The state, derived on every read

`waveView` folds the members and one live gate read into `empty`, `unentered`, `unknown`, `ready`, `running`,
`blocked` or `done`. The wave record on disk has no state field to disagree with the fold, and the tests read the file
back to prove no read wrote one.

The order is the design's, with one clause the acceptance adds: a RUNNING member is settled before a met exit gate, so
a wave can never read done or closed while a member is still running. The design's own row for `done` is kept - "a
wave can exit on a merged PR while one member is still queued for a follow-up" - so a met exit with a queued member
still reads done; what it cannot do is close over a live run. `blocked` also needs "none running", which is the
design's own definition, so running is tested first.

Which wave is current is derived too: the lowest-position running wave, else the lowest-position ready one, else the
lowest-position unentered one. A display rule with a stated order, not a field somebody forgets to update.

## Gates: the same vocabulary, validated and not evaluated

An entry or exit gate is `{check, ...params}` against the closed 14-name list in `lib/pipelines.js` and the parameters
in `EXIT_PARAM_SPEC`. A check outside the list, a parameter the spec does not describe, or a missing required
parameter refuses the record AT LOAD, with the sentence a reader can act on. No third dialect: no `blockedBy`, no
status word, no `completed` boolean.

`readWaveGate` answers met / unmet / cannot tell, and "cannot tell" blocks. Four checks have a reader this slice can
honestly run against the board's row facts - `clean`, `commits`, `pr-open`, `pr-merged` - and every other name reads
`cannot tell` with the reason "no evaluator reads it yet", because the panel validates those names and has no
evaluator for them. A gate never passes because a member said so.

## The lane

`public/core/waves-lane.js` builds the lane's markup as pure strings (`test/waves-lane.test.js` imports it), and
`public/assistant.js` draws it inside the open initiative card. It shows position (`W1`), title, the derived state
word, a `current` mark, the template with its resolution, both gate chips with the check's name and the live answer,
an `auto off` chip, and one row per member with the task's own state and its project.

The four gate words are kept apart on purpose: `met`, `not met`, `cannot tell`, `no gate`. A chip that drew only the
check name would make an unknown gate look passed; a chip that drew "failed" for a gate nobody can read would claim a
fact about the work that is really a fact about the reader.

Two captures from the live gate are kept with this note: `docs/assets/waves-lane/lane-1440.png` and
`docs/assets/waves-lane/lane-768.png`, the whole wave element at both widths, drawn from the sandbox panel the gate
builds (three members, two projects, one wave).

An initiative with NO waves draws no lane at all: the section appears when there is a wave, a refused record or an
unreadable store to show, and an empty "Waves 0" box on every card would be a box a reader learns to skip - this slice
has no write route to put anything in it. That is also what keeps the Initiatives pane's scroll proof green: the
neighbouring gate `tools/verify-initiatives-scroll.mjs` still answers 33/33, and it measures card heights.

The same fold rides `GET /api/initiatives`, so the card and `GET /api/waves?initiative=<id>` cannot tell a reader two
different states about one wave. The route is READ only: no write route, no tier question, no history.

## What landed

- `lib/waves.js` (new) - schema, `WAVES_VERSION`, `pickWaveGate`, the refuse-not-repair `Waves` store, `wavesFor`,
  `waveView`, `readWaveGate`, `deriveWaveState`, `waveLane`, `currentWaveId`.
- `lib/paths.js` - `wavesFile`, derived beside `initiativesFile`, and `"waves.json"` on `STATE_FILE_NAMES`.
- `lib/assistant/queue.js` - `waveId` on the task record, `TASK_WAVE_MAX`, `normWaveId`.
- `routes/waves.js` (new) - `GET /api/waves?initiative=<id>`, 400 without an initiative, 405 on a write, 404 on an
  unknown path, 409 on an unreadable store.
- `routes/initiatives.js` - `waves`, `waveSkipped`, `waveCurrentId` per initiative and `waveStatus` once, from the
  same `waveLane`.
- `server.js` - the store, the bundle-stamp template read, and the mount row.
- `public/core/waves-lane.js` (new), `public/index.html`, `public/assistant.js`, `public/style.css` - the lane and its
  sheet, including a `waves` grid area in the wide card.
- `tools/verify-waves-lane.mjs` (new) - the live gate.

## What proves it

Unit and route tests, 57 of them:

- `test/waves-store.test.js` (17) - positions sort, key/field mismatch refused with its siblings still loading, a
  duplicate position refused rather than renumbered, a duplicate id refused, a check outside the vocabulary and a bad
  parameter each refused at load, `auto` true only for a real boolean, an unresolved template kept, an unreadable file
  refused with its bytes unchanged, one initiative's waves not another's.
- `test/waves-derive.test.js` (12) - three members queued/running/done read running from the members alone; the same
  record reads done once the members close and the exit is met; a met exit cannot read done or closed while a member
  runs (also with a stubbed always-met gate, beside each of the four member states); blocked means parked and none
  running; entry met/not-met/unreadable read ready/unentered/unknown; every unevaluated check reads cannot tell;
  a queued follow-up does not stop a met exit; a hand-written `state` on disk is not read as state.
- `test/waves-lane.test.js` (15) - the member rows carry the task's own state, an unknown state reads queued, the
  state word is the read's, the four gate words are four chips, both gates are drawn, auto off by default, a template
  unresolved says so, a wave with no member says so, the current mark names one wave, an unreadable store is said as
  unreadable rather than "no waves", a refused record is drawn with its sentence, and every id and title is escaped.
- `test/queue-wave-id.test.js` (6) - a valid id round-trips through the queue file, an unknown id is kept as written,
  absent/null/empty mean no wave, an over-long value is clipped, a hand-edited file reads, and a settle preserves the
  field.
- `test/waves-route.test.js` (7) - a real sandbox panel with two projects: the wave reads running while a member runs,
  three members across two projects and the task that names no wave is not one, the Initiatives read carries the
  identical lane, the wave never reads green on an exit nobody can read, no wave-state field was written, the route's
  400/405/404, and an unreadable store is a 409 with its bytes unchanged.

The live gate, `node tools/verify-waves-lane.mjs --shots <dir>`, answers 40/40 on a sandbox panel:

- at 1440 and at 768 the document is no wider with the lane open than with the card folded (1440 vs 1440, 768 vs 768),
  the pane and the card have zero horizontal overflow, and every wave row, head, gate strip and member strip reads
  scrollWidth minus clientWidth of 0;
- the lane is drawn inside an initiative card, one wave at `W1`, state `running`, marked current, entry `clean - met`,
  exit `pr-merged - cannot tell`, `auto off`, template `poc-to-uat` unresolved;
- the three member chips read queued, running and done, across two projects, and the task that names no wave is not
  drawn.

`test/harness.test.js` caught the one failure this branch introduced on its first pass: a live gate with no
`package.json` script is "a rumour", and `verify:waves-lane` is the registration. That is the gate working, and it is
worth recording that the wiring was added because a test refused the branch without it.

Those are the brief's four acceptance lines, each with its own proof above: three members drawing queued/running/closed
from the members alone with no wave-state field anywhere (store and derive tests, and the route's read-back of the
file); a test that the derived state cannot read green or closed while a member runs (the stubbed always-met gate);
the lane at 1440 and 768 with no horizontal scroll and each member's state and the gate chip (the live gate); and a
task with no `waveId` not silently counted as a member (the route test and the live gate).

## What is deliberately not here

- No scheduler, no automatic advance, no fan-out, no auto behaviour: the `auto` field is read and drawn, and nothing
  acts on it. Rows 193, 194 and 195.
- No write route for a wave. The tier question a write would need is not built because nothing writes.
- No reorder control: create appends at the end, and reordering is a later slice with a history and a question about a
  running wave.
- No gate evaluator for the ten checks the panel validates and does not run. They read `cannot tell`, which is the
  honest answer and the fail-closed one.

## Drift notes, for the next reader

- "Wave" already means two other things in this repo: a batch of route moves (`docs/plan/split-for-concurrency.md`)
  and a console display switch (`public/render-jobs.js`). The only server-side occurrence before this branch,
  `lib/remote-backoff.js` "wave of memos", is unrelated. The lane, the route and the store all say "waves of work".
- The gate vocabulary is VALIDATED, not evaluated. The design says so and this slice keeps it: a validated name with
  no reader is `cannot tell`, never a pass.
- The design's numbers were read against `1aad736b` on 2026-11-21. The line numbers this note cites are this branch's.

## The landing

- Base: cut from `origin/main` `e27192a6` (1.150.0), rebased onto `6ff31874` (1.151.0) before the push, so the branch
  is not behind the tip it will land on. That rebase is also why the number is 1.152.0 and not 1.151.0: the
  branch-kind column landing (PR #828) took 1.151.0 first, and a number is claimed by its tag.
- Branch: `wtgui/build-the-first-slice-of-waves-of-work-c86bf5`.
- Version: 1.152.0 (minor: a new route, a new store and a new lane, and nothing existing moves).
- PR: #829, open and left OPEN for the panel to land. The release tag `v1.152.0` is anchored on the bump commit and
  pushed; a rebase merge re-creates that commit, and the landing moves the tag onto the commit main carries.
- The full suite, one run on this branch at `f33e9ddc`: 3454 tests, 3445 passed, 9 failed. Eight of the nine reproduce
  on a `git archive` of `origin/main` unchanged (`paths.test.js`'s `pipelineBundleSeedFile`, `assistant-profile`,
  `assistant-search-scroll`, `paths-http`, `header-controls`, `junctioned-node-modules`, `child-route`,
  `gateway-permissions`), and the ninth, `reasoning-runs`' level-survives-a-restart, passes alone on this branch and on
  `origin/main` and failed only under the full sweep's load. `test/harness.test.js`, which DID fail on the first pass,
  is the one this branch caused and the one this branch fixed.
