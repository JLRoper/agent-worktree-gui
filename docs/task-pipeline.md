# A task's pipeline: the record, the window, and the control that puts a task on one

A queue task is either on a pipeline or it is not. "Not" is not an empty state — it is **assistant-decides**, the
default the panel has always had, and every existing task is on it. This document is the panel side of that choice: the
field, the three answers a record can give, the one write that changes it, the driver that carries a row from one stage
to the next, and the bundle the answers are read against.

The tree ladder in [`docs/pipelines.md`](pipelines.md) is a DIFFERENT object. A tree's `pipeline` says which rung of
local → investigation → turnover it stands on and what it may do with a branch. A task's `pipelineRun` says which
studio-authored sequence of stages the work is being carried through. Two meanings, two fields — a card that says
"turnover" and a chip that says "stage 4 of 13" are talking about different records on purpose.

## The field

`state/assistants/<id>/queue.json` carries one optional field per task:

```json
{ "id": 7, "title": "carry the contract", "pipelineRun": { "pipeline": "poc-to-uat", "stage": "S3", "enteredAt": "2026-11-03T15:00:00.000Z" } }
```

`pipelineRun: null` (or no field at all) is the default path. `enteredAt` is a UTC instant — `Date#toISOString()` — and
it is the ONLY clock: time in stage is `now − enteredAt`, computed on every read, never counted by a timer.

The queue's schema carries the record **verbatim** (`pickTask`, `lib/assistant/queue.js`), including a broken one. A
malformed assignment must reach the window as `unresolved`; normalising it away in the queue would silently put the task
back on the default path.

### The record grows a stage run and a tree

A row that is being driven carries more than the three fields. Each entry into a stage is a **stage run**, and the
record keeps the ledger of them:

```json
{
  "pipeline": "poc-to-uat", "stage": "S8", "enteredAt": "2026-11-05T12:00:00.000Z",
  "visits": { "S3": 1, "S4": 1, "S8": 2 },
  "round": { "parentPath": "<repo>/.worktrees/carry-the-contract-a1b2c3", "parent": "wtgui/carry-the-contract-a1b2c3",
             "slug": "carry-the-contract", "tag": "a1b2c3", "base": "origin/main", "sha": "9f3c1a2…",
             "at": "2026-11-05T11:02:44.100Z", "by": "panel" },
  "tree": { "path": "<repo>/.worktrees/carry-the-contract-a1b2c3", "branch": "wtgui/carry-the-contract-a1b2c3",
            "startSha": "9f3c1a2", "cutAt": "2026-11-05T11:02:44.100Z", "by": "panel" },
  "route": "sha256:6b1f…",
  "stageRuns": [
    { "id": "poc-to-uat/S8#1", "stage": "S8", "visit": 1, "at": "…", "thread": "carry the form", "job": "job-4f2a",
      "status": "done", "settledAt": "…", "commit": "1c9f0aa4f3e2…",
      "tree": { "path": "…", "branch": "…", "head": "1c9f0aa", "commit": "1c9f0aa4f3e2…", "dirty": 0 },
      "artifact": { "id": "finding", "path": "ledger/G58.json", "present": true, "sha256": "3d0e91…",
                    "commit": "1c9f0aa4f3e2…", "blob": "42dbd25dd307…", "blobSha256": "3d0e91…" },
      "inputs": [
        { "artifact": "review", "path": "ledger/G58.review.json", "sha256": "8ac1f0…", "present": true,
          "writer": "review-agent", "edge": "H-10", "via": "handoff", "commit": "3f9c1a2b7d4e…", "blob": "4b825dc642…", "blobSha256": "8ac1f0…" },
        { "artifact": "finding", "path": "ledger/G58.json", "sha256": "3d0e91…", "present": true,
          "writer": "fixer", "edge": null, "via": "earlier", "commit": "1c9f0aa4f3e2…", "blob": "42dbd25dd307…", "blobSha256": "3d0e91…" }
      ],
      "decision": { "by": "panel", "trigger": "stage-settled", "code": null, "fact": { "kind": "run-status", "status": "done" }, "reason": "stage S8 of poc-to-uat settled — the run finished" } }
  ]
}
```

- **The id is a string, `<pipeline>/<stage>#<visit>`, and a later attempt of that visit is
  `<pipeline>/<stage>#<visit>.<attempt>`.** `visit` comes from `visits[stage]`, incremented by the same
  write that sets `enteredAt` - so a loop back into S8 is `#2`, the first entry is still `#1`, and a bundle re-export
  that inserts a stage renumbers nothing. Every user of the id (a journal line, a park's sentence, a test) names the
  same thing. The attempt suffix exists because ONE VISIT CAN BE STARTED MORE THAN ONCE - a spawn that failed before
  the link, a retry after a start that had already linked a thread, **and a start in a different tree** - and two
  entries sharing `#<visit>` let a settle stamp whichever one the stage/visit match reached. The first attempt keeps
  the bare id, so every stored record and every journal line naming `p/s1#1` still names one run, and no two entries in
  one ledger share an id.
- **A stage run's identity is its visit AND its tree.** `beginStageRun` takes the tree (a path or the record) as well
  as the thread, and two starts that name different trees are two attempts: a stage re-cut into a second tree - the
  first was in use, the row moved, the round re-cut it - names no thread yet either, so a start that matched on stage
  and visit alone reused the first tree's entry, the second settle overwrote its facts, and two runs answered one id.
  A settle is held to the same rule: it fills an entry that names no tree, and never stamps one that names a
  different tree.
- **An entry is created when the START is asked for**, not when it settles: a stage that never started still names the
  attempt, and a start that was refused leaves its refusal on the record. `thread` and `job` are filled at the link.
  A retry of the SAME attempt reuses its entry (the same thread, or a start that names no thread onto an entry that
  names none either) - a retry is an attempt, not a visit. A start whose thread is already on an open entry is the
  NEXT attempt: it gets its own id rather than overwriting the run that already linked.
- **A settle never invents the start.** `at` is the run's start, and the settle's clock is not it: an entry the
  settle has to create is written with `at: null` unless the caller hands `startedAt` in, because stamping the settle
  clock there made every run the ledger had not seen begin claim a zero length - `settledAt - at` read 0 and an
  `interrupted` run was drawn as one that never worked. `settledAt` is the settle's own clock and is always written; a
  null `at` is a fact a reader can draw (the start is unknown) rather than a stamp that is false.
- **A settle names its own run, in order**: the entry on that thread, then the entry on that job, then the newest
  open entry for the visit, and only then a new attempt (created on the spot, because the settle is the moment the
  panel learned those facts). A settle never rewrites an entry whose non-empty thread or job is a different one. The
  view's `stageRunId` is the id of the attempt the row is IN - the newest entry for the visit - and falls back to
  `#<visit>` for a record written before the ledger existed.
- **`stageRuns` is capped at 30, newest last, and the cap is the WRITER's** (`lib/task-pipeline.js`), because
  `pickTask` carries the record verbatim. A dropped entry increments `runsDropped`, the one number the cap must not lose.
- **A record written before this existed reads as one visit of its stage**, an empty ledger and `route: null`. Nothing
  is written back on a read; `route: null` means "entered before the fingerprint existed" and is never a mismatch.
- **`tree` is written at the cut** (see below) and **`route` is the routing fingerprint at entry**: a sha256 over the
  stage ids in order, each handoff's ends/kind/cap, and each gate's anchor/artifact/kind and its `routes` map. Editing
  a prompt or a title does not move it; editing the graph — or re-pointing a verdict's route — does, and the row parks
  `pipeline-changed` rather than being driven against a graph it did not enter under.
- **`inputs` is the manifest of what the stage was handed**: one entry per artifact the document says it reads, with
  the id, the document's path, the sha256 the file had when the stage started, whether it was there, the writer the
  document names, the edge it arrived by (`H-10` for a handoff, `null` for a read and for the earlier visit's own
  artifact), and the **pin** — the `commit`, the `blob` object id and the `blobSha256` the input is read at. It is
  written with the entry when the START is asked for — the moment the INPUTS block is resolved — because that is what
  the stage started with, and a later reading of the tree cannot reconstruct it.
- **`commit` on the stage run is the tree's HEAD at settle, full-length.** It is the pin the stage's handoff carries;
  an abbreviated sha would be a display form two commits could share.
- **`assembly` is the ONE branch a finished round lands** (`{ commit, base, branch, path, verified, stages[], skipped[] }`).
  A per-stage round's stages each commit on their own branch, so when the pipeline is over the driver asks for one
  branch and the Assistant cherry-picks every stage run's `commit` onto the round's PARENT tree, in visit order (see
  "The assembly" below). Written with `tree` and the row's `worktree` pointing at that branch: that is what leaves the
  landing step a single branch, never the first stage's tree plus siblings nothing merges.

### The input manifest, read back

`stageInputsOf(task, { stage, visit, worktree })` (`lib/task-pipeline-drive.js`) reads one stage run's manifest.
Two rules make it useful after the fact:

- **the stored hash stays.** `sha256` is what the stage was handed; re-hashing the file on a read would answer a
  different question, and would lose the only number that says *what* the stage started with.
- **`present` is re-resolved against the tree.** A file deleted after the stage started reads `present: false` beside
  the stored hash, and its id appears in `missing`. `present: null` means the document gave the artifact no path (an
  external input) — unknown, never a zero-length file and never "missing".

A stage run written before this field existed answers `entries: []` — nothing recorded — and a record with no stage
run at all answers `null`. The manifest is capped at 24 entries per run; `inputsDropped` counts what the cap refused
so a short manifest does not read as a complete one.

### The pin: a handoff is a commit, never a branch

A branch is a moving name. `wtgui/carry-the-contract-a1b2c3` resolved when S3 settled and the same name resolved when
S4 started can be two different trees, and an artifact read through it is a different artifact wearing the same path.
So every artifact a stage settles with is pinned in `lib/stage-pin.js`:

| field | what it is |
|---|---|
| `commit` | the tree's full HEAD at settle — the commit the input is read at |
| `blob` | the artifact's git blob object id at `commit:path` |
| `blobSha256` | the sha256 of the BLOB's bytes (not of the checkout — with `core.autocrlf` on the two differ on identical content) |
| `file` | the tree-relative path the pin names, when a `{{hole}}` in the declaration resolved to a real file |
| `uncommitted` | present when the artifact exists in the tree but **not in the commit**: it has no blob to pin |

The writer's record wins over a fresh reading of the file: `stagePrompt` prints the commit, the blob and
`read it at <commit>:<path>`, and never identifies the handoff by a branch. A start whose recorded commit this tree
cannot resolve — a rebase, a reset, a re-cut — **parks `pipeline-refuse-input`** rather than reading whatever the
branch says now; a blob at that commit that is not the one recorded is refused for the same reason. A run written
before the pin existed carries no commit and is not parked: a record that could not have carried the fact is not a
refusal. A stage that writes an artifact and leaves it uncommitted records `uncommitted: true`; the next stage is told
there is no blob at the pin, which is a fact a reader can fix by committing, not a silent substitution.

The manifest is also where a MISSING input is caught. Every entry the document declares is resolved before the start:
an artifact with a declared path, which no settled run of the pipeline has produced and which the stage's own tree does
not hold, refuses the start (`pipeline-refuse-input`) and settles that stage run `refused`. That is the shape a fork
leaves behind when its second lane is never walked: the terminal stage would otherwise be handed half its inputs, run
anyway, and let the row read `done` over work it was never given. "Settled" is the writer's own record, so a record from
before pins existed (`present: true`, no commit) is still a claim about the artifact and is not a refusal.

## Three answers, and no fourth

`lib/task-pipeline.js` resolves a record against a loaded bundle:

| mode | when | what the window says |
|---|---|---|
| `assistant-decides` | `pipelineRun` is null | the default path in words; no stage list |
| `pipeline` | pipeline and stage both held, `enteredAt` a UTC instant | every stage in order, the current one marked, its `position of N`, the gate that ended the stage before, elapsed from the stamp |
| `unresolved` | a pipeline or stage the bundle does not hold, a record that is not an assignment, no bundle, or a bad stamp | the reason, no stage marked current, and the sentence that this is NOT the default path |

`lib/pipeline-window.js` adds the sequence and the gate; `GET /api/assistant/task-pipeline?assistantId=…&task=…` is its
HTTP adapter. A refusal is a value at 200 so the dialog draws the reason instead of a 500.

## Putting a task on a pipeline

Two reads and one write:

- `GET /api/assistant/pipeline-catalogue` — every pipeline in the bundle, its stages in order with their 1-based
  position, or the loader's own refusal (`missing`, `not-a-bundle`, …) with its file and locator. The window's
  assignment control draws from this; it never offers a stage the window would then call unresolved.
- `POST /api/assistant/queue` with `{ action: "pipeline", id, pipeline, stage }` — put the task on that stage, stamping
  `enteredAt` from this write's clock.
- `POST /api/assistant/queue` with `{ action: "pipeline", id, clear: true }` — back to assistant-decides.

The transition lives in `lib/task-pipeline-assign.js`; the Assistant's `queueMutate` owns the file, the journal and the
repaint, exactly as it does for `state` and `reassign`. Three rules decide its shape:

1. **Only movement stamps.** Assigning the same pipeline and stage twice is `changed: false` and leaves `enteredAt`
   alone: a second press is not a re-entry, and restarting the clock on work that did not move is the one historical
   fact this field exists to keep. A different stage (or pipeline) is a new entry and gets a new stamp.
2. **Clearing is explicit.** `pipelineRun: null` is written, not deleted to a missing key — a reader of the file can
   see the choice was cleared rather than never made.
3. **Nothing is retro-assigned.** Adding a pipeline to one task never touches another; a queue file written before this
   pass reads as a queue of tasks on the default path.

Every refusal is named (`pipeline-bundle`, `pipeline-id`, `pipeline-stage`) and says what the bundle does hold, so the
control prints the sentence rather than guessing.

## Driving it: one stage, then the next

Assigning a pipeline is not a label any more: a row that carries one is **driven**. `Assistant.sweepQueues` — the
queue's own tick — asks `lib/task-pipeline-drive.js` three questions about every queue, and acts on the answers:

- **what starts.** The row at the FRONT of the queue (`byQueueOrder` over the queued and running rows), when it
  carries a pipeline that resolves. Its tree is **cut first**, as its own step (§ below): the assistant's `ensureTree`
  cuts it and writes `pipelineRun.tree` on the row, and the NEXT pass starts the stage in that tree — so every stage
  start is the `existing: true` path, whether it is the first stage or the tenth. The stage's prompt is the turn, plus
  the INPUTS block: the handoff's artifact by path, COMMIT and blob hash, the gate it came back through, the earlier
  visit's artifact on a loop back, and the tree's branch/HEAD/dirty count. A handoff is never named by a branch: the
  panel stores the commit the writer settled at and hands that to the next stage. Two short blocks ride the same
  prompt and are not briefs: **GATE** tells the stage that OWNS a gate's verdict where the record goes, the words it
  may hold and where the document routes each of them (the panel never writes it, so a seat that is never told leaves
  the row parked on the gate); **TOOLS** names the tools an unattended run can use and the one the platform refuses
  (`execute_code`), so a worker does not spend its first turn discovering that. **An arrival is named only when the
  RECORD names the edge** (`pipelineRun.via`): a first visit has crossed nothing, so it is handed nothing, and the block
  does not reconstruct an edge from the graph — deriving "the last handoff whose `to` is this stage" is how a loop into
  a pipeline's first stage used to be announced before its first crossing. A row with NO pipeline is not
  started here and has no stage invented for it — that row is the assistant's to start, exactly as it was before this
  driver existed.
- **what moves.** A `running` row whose current thread is not live and whose last run reads `done` has settled its
  STAGE. The row is written forward to the next stage in one write — `queued`, a fresh `enteredAt`, the visit counted,
  and the edge it crossed counted in `crossings` — and the settle does not see it again until that stage has a run of
  its own.
- **what reads it live.** A row on a pipeline is read from its ROUND, not from the run its `runId` names alone:
  `lib/assistant/queue.js` `roundLiveness` walks `stageRuns[]` newest first (each entry's `job` and `thread`), then the
  row's `threads[]`, and the first run the store says is still going is the row's live job. A row whose named run has
  ended therefore reads `running` while a later stage thread is working, and reads `settled` only when nothing the round
  names is going. A round that names no thread of its own falls back to the row's own thread, and a row with no
  `pipelineRun` keeps exactly the answer it had before the ledger existed.
- **what stops it.** A capped loop at its cap, a gate that declares a decision record, a verdict the document cannot
  route, a failed run, a declared artifact that is not in the tree, a tree that is gone or claimed by another row, a
  routing change, or an assignment the bundle cannot resolve. Each is a named code and a structured decision on the
  stage run; the row parks on the rendered sentence. `unresolved` **parks** — it is a fact about a written record, not
  an empty state, and leaving the row sitting still was the old behaviour.

### The hold: the row's live stage, in the panel's own wait book

A stage that has a worker is a row waiting on that run, and the panel says so in the book it already keeps for the
reviewer's wait (`docs/pipelines.md` §6): the tree's pipeline record carries

```json
"pipelineWait": { "kind": "run", "pipeline": "poc-to-uat", "stage": "S8", "visit": 2, "job": "job-4f2a", "thread": "carry the form", "at": "…" }
```

written at the CUT (`lib/assistant.js` `linkSpawnTask` → `lib/jobs.js` `holdPipelineStageRun`) — the same write that
links the worker to the row, so the row's condition is durable from the first instant of the run rather than inferred
from a thread nobody wrote down.

- **The panel owns the advance; the driver is the fallback.** `sweepPipelineWaits` is the panel's own ticker: it reads
  the run's status from the job store (no host call, no run held open) and, once the run is no longer live, clears the
  hold and calls the one advance seam — `Assistant.advancePipelineTree`, which runs the SAME `driveTaskPipelines` pass
  the queue tick runs. Every rule below still stops the walk, because the driver is what decides: a cap, a gate's
  refusal to route, a missing artifact, a tree claimed by another row, a failed run.
- **Why the hold exists at all.** `driveTaskPipelines` leaves a row alone while the book holds it (`heldByBook`): two
  passes moving one stage is the double-advance this rule prevents. A hold is a clock, not a lock — past
  `HOLD_OWNER_MS` (3 minutes) from the settle the driver takes the row back, so a panel whose ticker died cannot
  strand a settled row.
- **A restart resumes the wait.** The hold is on the tree's durable record and the sweep reads the book itself; the
  advance is a conditional clear, so two panels, two ticks, or a restart between the settle and the tick start the
  stage once. A card the 80-job ring no longer has is not a live run: the seam reads the row's own ledger and decides.
- **Nothing is parked by the hold.** The row still reads `running` while its stage works — the hold is the durable
  fact behind that word, not a second state a reader has to learn. A settled stage moves the row exactly as it did
  before: `queued` at the next stage, with the start asked for when the reader's `spawn` switch is `auto`.

Proved end to end on the shipped `ping-pong` document by `node tools/verify-pipeline-walk.mjs`: its `ping-pong:timer`
walk starts the row once through the ordinary queue tick, then crosses every later boundary on `sweepPipelineWaits`
alone — three loop rounds, the cap park, and a restart mid-wait that starts no stage twice.

Unattended starts are the assistant's own switch (`spawn`, in Settings → Assistant): **`auto`** is "start it at once"
and is the only value the driver starts a stage under. `ask` and `off` still let a settled row advance — the work is
not lost, it simply waits for a person, which is what those two settings say.

### The limits the pipeline itself declares

**A cap is a count of crossings.** `cap: "3 rounds"` on a loop edge allows three crossings of that edge; the fourth
parks the row ("… is at its cap of 3 rounds"). The count lives on the record, `pipelineRun.crossings["H-62-60"]`,
because a panel restart between two passes is exactly what a loop must survive. A loop whose cap is missing, or is not
a whole number, is **not crossed at all**: the panel does not read "no cap" as "unlimited", the same fail-closed rule
the tree ladder applies to an exit check it cannot evaluate.

**A gate with a decision is a barrier.** When a gate sits `after` the settled stage and declares a `decision`, the
driver looks for that decision's own file in the row's tree and does nothing until it is there. `{{hole}}` segments
match one path segment, so `ledger/gates/G60-{{finding_id}}.json` is whichever record the seat actually wrote. The row
parks naming the path, the wait is kept on the record (`pipelineRun.waitingFor`), and **the record's arrival is what
moves it** — the panel never writes that file and never decides the gate by finishing the stage before it.

**A decision that declares `routes` is also read — one field, `outcome`.** The gate's document may map its outcomes to
edges:

```json
"decision": {
  "path": "out/verdict.json", "outcomes": ["fail", "pass"], "writer": "verify-seat",
  "routes": { "fail": "H-3", "pass": null }
}
```

The seat writes `{"outcome": "pass"}` in that file, and the DOCUMENT says where that word goes: `"fail": "H-3"` takes
the loop, `"pass": null` means **the pipeline ends here**. The driver reads the verdict **before** it charges the loop's
cap, so a pipeline that has converged stops at its verdict instead of spending a crossing it does not need — while a
loop that keeps failing is routed back into itself and its cap still applies. A `routes` map is checked whole at load:
every key must be a declared outcome, every declared outcome must be routed, and every non-null target must be a handoff
leaving the gate's own stage. A record that is not JSON, names no `outcome`, or names one the gate does not declare
parks `pipeline-verdict` — the panel obeys a route the document declared and refuses to guess one.

A verdict that ends the pipeline writes its own decision on the settled stage run (`trigger: "verdict"`,
`fact: { kind: "verdict", outcome, edge, ended: true }`), so a reader can see WHICH word ended the loop. The row is then
finished by the settle, on the landing rule it has always had.

### The tree: a parent tree per round, and one child per stage

**A round cuts ONE parent tree first, then one child tree per stage.** A round is one run of a pipeline, from its
first stage to its last. Before its first stage it cuts a real worktree on `.worktrees/<task-slug>-<tag>` (branch
`wtgui/<task-slug>-<tag>`) **from `origin/main`**, and records that tree on the row:

```json
"round": {
  "parentPath": "<repo>/.worktrees/carry-the-form-a1b2c3",
  "parent": "wtgui/carry-the-form-a1b2c3",
  "slug": "carry-the-form", "tag": "a1b2c3", "display": "carry the form",
  "base": "origin/main", "sha": "9f3c1a2d4e5f…", "at": "…", "by": "panel"
}
```

- `parentPath` is the parent tree's directory, `parent` is its branch, and `sha` is the COMMIT `origin/main` resolved
  to at the cut. A project with no `origin/main` (a fixture, a clone whose remote has not been fetched) falls back to
  the checkout's own ref, and `base` says which ref was used, so a reader can tell the two cases apart.
- **Every stage child is cut from that branch tip**, never from `origin/main` as it stands now. A commit that lands on
  main after the round began is **not** in any tree of the round, which is the defect this model exists to remove: with
  one shared tree and a re-resolved branch, a stage cut mid-round started at whatever main was THEN.
- The parent tree is the round's landing branch: `pipelineRun.tree` and the row's `worktree` name it from the first cut,
  and the assembly lands on it (below). A stage child is a work branch, never the landing branch.
- **A round's parent tree is a row BESIDE main, never under it.** Its cut is written into the panel's parent book as
  `parentRef: "origin/main"` with **no local parent name**: `parent` is null, so the worktree chart draws the round at
  the top level, beside the checkout's `main` row, and a roll-up has no local branch to offer (`parentSource:
  "unknown"` with the ref in `why`). A round is cut from a remote-tracking ref, and a ref that names no local branch
  is not a chart parent. **Every stage child records the round's branch as its parent**, so the stage trees of one
  round hang under the round's own row, one indent in: one group per round, with the round's fold covering it, and
  `main` never drawing as a container of a round's work. `main` stays the branch a round's commit came from, recorded
  as `base` on the round (`origin/main`) - a fact, not a chart parent.
- The lookup answers the stage's OWN tree, from `stageRuns[].tree.path` and then `pipelineRun.trees[stage]`. A stage
  with no tree yet is `needed` (the cut is the next step), and a tree that was recorded and is gone is
  `pipeline-tree-gone`, **never** a second cut and never the project checkout.
- **The panel cuts every tree a round works in; a row's `worktree` never names one before that cut - except on a
  `shared` ladder, which runs in the tree it was filed with.** A queue row can carry a `worktree` when it is FILED
  (the old model's advice, "a queue row names a real tree"), and a stage that ran there is how row 50 of the
  2026-11-09 round report committed into the project checkout. `treeLookup` therefore honours `worktree` only once the
  record shows the row has STARTED - a stage run entry, a `startingAt` request, or a state only a link writes
  (`running`) - because all three are the panel's own writes. A queued pipeline row with no tree of its own answers
  `needed` whatever the field says: its first cut cuts the round's parent tree, and the field is a filing hint, not
  evidence of a tree the panel cut.
  **One exception, and it is the landing ladders.** A `shared` pipeline reuses ONE tree for every stage, so a row
  filed with a real work branch may run there instead of cutting a round it does not need (`filedTreeOf` in
  `lib/task-pipeline-drive.js`). The field is not taken at its word: the directory must exist, the panel's own git
  read (`treeOf`) must answer a branch for it, and that branch must not be a trunk - row 50's checkout on `main` is
  still refused, and a `per-stage` pipeline still cuts its children because one filed tree cannot stand in for them.
- A row written before rounds existed has no `round` and keeps the model it was cut under: one tree, reused by every
  stage (`treeLookup`). A deploy therefore never re-cuts a row already in flight.
- A tree path is claimed by every OPEN row whose run tree, `worktree`, round `parentPath` or **any stage tree on the
  record** normalises to it (case-insensitively, across every assistant's queue). A start whose tree is claimed by a
  DIFFERENT open row parks `pipeline-tree-claimed`, naming the other row: two stages in one tree is the one collision
  that corrupts work silently.

#### `stageTreeName(round, stage, visit)`: one pure function names all of it

`lib/stage-tree-name.js` exports **`stageTreeName(round, stage, visit)`**, which returns `{ display, dir, branch }`
for any tree of a round. It is pure: no clock, no random tag, no counter, the same three strings in every process from
the round's own `slug` and `tag`.

| what | `display` | `dir` (under `.worktrees/`) | `branch` |
|---|---|---|---|
| the parent (`stage` is null) | the task's title | `<task-slug>-<tag>` | `wtgui/<task-slug>-<tag>` |
| a stage child | `Stage <n>: <stageName>` | `<task-slug>-stage-<n>-<stage-slug>-<tag>` | `wtgui/<same dir>` |

`<n>` is the stage's POSITION in the document (1-based), not a count of cuts, so a re-export that inserts a stage
renumbers the directories honestly. A child's six-hex `<tag>` is **derived** from the round's tag, the stage id, its
position and the visit (`stageTagOf`), never drawn at random: the tag is a tree's identity in the naming ledger and in
the parent book, both of which key on the last six hex of a name, so two trees must never share one.

**A re-run at the same visit reuses that name, with no `-2` suffix.** The cut takes a name rather than generating one
(`Jobs.makeWorktree`'s `name` option), and a named directory that is already there and already on that branch is
adopted as this cut's tree (`reused: true`); a directory holding anything else is refused by name. A later VISIT of
the same stage derives a different tag, so a loop's second attempt is a second tree rather than a second name for one.

The driver returns `ensureTree = { taskId, project, prompt, stage, base, parent, role, stageName, position, visit }`.
For a chain stage `role` is `stage`, `base` is `round.parent` (the parent tree's branch) and `parent` is the same
branch; `stageName`, `position` and `visit` are what the name is derived from. The Assistant's `cutPipelineTree` cuts
the parent tree on the round's first cut and the stage's child tree on that cut and every later one, writes both under
`pipelineRun.trees[stage]` / `pipelineRun.round`, and journals it. Nothing is started by that step: a cut with no start
is a row with a tree and no thread: visible, named, re-startable. A cut that fails parks the row with the cut's own
sentence.

A block (a per-stage fan-out) keeps its own model: its lanes are cut from the block's one base and its join tree is the
landing branch, so no round parent tree is cut for it.

### The handoff: a stage reads what the document says it reads

Because the stages no longer share a directory, an artifact is handed FORWARD by its declared input, not found beside
the stage that wants it. `inputs.read[]` and the handoff edge both name artifacts; `inputManifest` resolves each one at
the WRITER's commit (the pin: commit, blob, blob sha256), and `artifactOf` reads the blob from that commit when the
file is not in the stage's own tree. The INPUTS block then says so plainly — the artifact is not in this stage's tree,
and `git show <commit>:<path>` is where to read it.

The cost, stated plainly: a stage cannot see the previous stage's uncommitted work, and any file an earlier stage left
behind by accident is invisible to it. That is the point — the document, not the directory, decides what a stage is
handed.

### The fan-out: a per-stage block, and the one merge

The model above is every pipeline's: one tree per stage, cut at the round's frozen parent. A pipeline may ALSO draw a
CONCURRENT part of its graph (a stage with two or more successors that converge on a later stage), and that part is
walked as a BLOCK: the lanes start from ONE base instead of a chain's per-stage order, and the aggregator merges them in
one commit. The block is not what gives a stage its own directory, which every stage has - with one exception, the stage
whose artifact IS the pull request: it acts in the round's parent tree, the branch that lands, and is never cut a stage
child (see "Stage branches are local only", below).

The walk is decided by the GRAPH, not by a flag. `isolation: "per-stage"` used to be the only way into a block, while one
tree per row was every pipeline's default; under a round every stage already has its own tree, so a document that draws
a fork and says nothing else is walked as a block too. What still decides it is the row's workspace model: a row that
runs one tree per stage (a round) walks the block it draws, and a record written BEFORE rounds keeps the row's one tree,
where the lanes would share a directory. There the block is not walked, and the lane a later stage reads is refused by
name (see `pipeline-refuse-input`) instead of being silently left out. `per-stage` keeps its own meaning for a row with
no round: it is what lets that row walk a block on trees it does not otherwise have.

- **The block.** A stage with two or more non-loop successors is the fork; the lanes are its successors, and the join is
  the earliest stage, in reading order, that every lane can reach. No fork stage and two or more roots is the same block
  with the pipeline's start as the fork. One stage = one lane = one tree: a lane that forks again, a lane that reaches
  the join through another stage, a lane that is another lane's ancestor, or lanes with no common join are refused **by
  name** and the row runs `shared` — the panel does not guess a graph the document did not draw.
- **One base.** Every lane tree and the aggregate tree are cut from the SAME commit: the fork's settled commit, or — at
  a pipeline start — the first lane's cut, which supplies it. The row stores it as `pipelineRun.fanout.base`; it is the
  one thing about a block that cannot be derived from the bundle.
- **`pipelineRun.trees[<stage>]`** is the tree each lane and the join ran in, written at the cut beside the block's
  `{ base, fork, lanes, join }`. The row's own `tree` is **never** a lane's: it is the aggregate's, because the branch
  that lands is the merge's.
- **The join reads the merge, not an edge.** Its tree is cut at the base and every lane branch is merged into it in ONE
  commit — `git merge-tree --write-tree` pre-flights every lane over the object database (so a conflict is a list of
  paths before a merge starts), then one commit is built from that tree with a parent per lane and proved against it.
  The result is written on the join's stage run as `merge { commit, base, verified, branches[] }` **before** the
  aggregator's worker exists; the driver will not start that worker while a merge is owed. Its INPUTS block names each
  lane's artifact, path, commit, blob and hash — the lanes are pinned by commit, never by a moving branch name.
- **A conflict parks.** Two lanes that wrote the same path are refused `pipeline-conflict` naming the paths and the
  lanes; nothing is merged, HEAD does not move, and no working file is written. A person chooses which lane is right.
  That refusal is the check behind "each stage writes only files nobody else writes" — the panel cannot know what an
  agent will write, so the aggregate proves it.
- **Lane branches are local only.** They exist on this disk to be merged and are never pushed. The branch that leaves
  the machine is the row's — the aggregate's — under the ordinary landing rule.
- **The routing fingerprint includes the isolation**, so flipping it under a live row parks `pipeline-changed` rather
  than driving a row against a workspace model it did not enter under.

Proved end to end, on real trees, by `node tools/verify-pipeline-fanout.mjs`: a 3-stage fan-out (two lanes and an
aggregator), one tree per stage, the base each was cut from, the one aggregate commit and its parents, a byte-for-byte
comparison of each lane's report (sha256 and the blob object id), and a deliberate conflict that is refused by path.
`node tools/verify-pipeline-fork.mjs` proves the other half on the four-stage POC's document, which declares no
`isolation` at all: the drive visits S220, S221 and S222 before S223, both lanes are cut from the fork's settled commit,
and a row that cannot walk the block has its terminal stage refused rather than settled `done`.


### The assembly: every stage's commits onto the round's parent tree, and land from it

A round gives every stage its own tree, so a finished chain leaves N commits on N local branches, and the row's
landing branch is the round's PARENT tree - cut from origin/main before the first stage, and the one branch every stage
was cut from. The ASSEMBLY closes the round: when the pipeline is over, or before a `pr` stage starts, whichever comes
first, the driver asks for one branch, and the Assistant cherry-picks every stage run's commit onto that parent tree,
in visit order (`lib/pipeline-assembly.js`). The parent tree's own branch is then the branch that lands.

- **The plan is the driver's** (`assemblyPlanOf`): the settled stage runs that carry a commit, in VISIT order and then
  by the stage's position in the document - baseline first, then implement, compare and correct. A loop's second visit
  of the baseline comes after the first visit's last stage, because that is the order the round actually ran. A stage
  that settled without a commit is named in `skipped`, never invented into the branch. The plan carries `parentPath`
  so the Assistant picks into the round's own tree rather than cutting a second one. A round WITH a parent tree is
  assembled from one committed stage too - that stage's branch is not the landing branch, so its commit is picked
  onto the parent tree like any other; a record with no parent tree keeps the older rule, where a single stage's own
  tree already was the branch that lands.
- **One branch, and it is the round's own.** The picks happen IN `round.parentPath`, which is still at `round.sha` -
  no second cut, and no branch that starts anywhere but origin/main as the round found it. A tree that is not at that
  commit (somebody committed in it, or it was reset) is refused (`pipeline-assembly-input`) rather than picked into; a
  tree that is gone parks the row naming the path instead of cutting a replacement. A record written before the parent
  tree existed (`round.parentPath` absent) keeps the old behaviour: one tree cut at `round.sha` for the assembly.
- **The later stage wins a shared path.** A chain's later stage applies ON TOP of the earlier one, so for a path two
  stages both wrote, the assembled branch carries the LATER stage's version - that is what "each stage finishes what
  the last started" means, and it is the difference from a fan-out, where two lanes writing one path is a conflict by
  definition. Where the later stage changed the SAME LINES the earlier one changed, git cannot apply it: the pick is
  aborted, the conflicting stage is not committed, the parent tree is left at `round.sha` (never removed - it is the
  landing branch), and the row parks `pipeline-assembly-conflict` naming the path and the stages. A person decides
  which stage is right; the panel never resolves a hunk by choosing a side.
- **The record is the proof it happened.** `pipelineRun.assembly = { commit, base, branch, path, verified, stages[],
  skipped[] }` is written with `pipelineRun.tree` (the assembly's) and the row's `worktree`, so the landing step has ONE
  branch to push and merge. `verified` is the check that every path a picked stage changed is at HEAD with that
  stage's blob - or absent, when the stage deleted it. A second assembly for the same frozen parent is refused.
- **Stage branches are local only.** A stage tree's run is never handed the landing paragraph, whatever its artifact
  declares: the PR a mid-round stage would open holds that stage alone. The branch that lands is the assembly's, by
  the ordinary landing rule - the same rule a fan-out's lanes follow.
- **The one exception is the stage whose artifact IS the pull request.** A stage declaring `kind: "pr"` has no work of
  its own to keep local: its work is to push and open the PR. Under a chain it is handed the round's PARENT tree, on
  the round's own branch (`stageTreeLookup` answers `round.parentPath` and `round.parent`, and never cuts it a stage
  child), and the driver asks for the assembly BEFORE that stage starts when the round still owes it, so the push
  publishes the branch that holds the round's work. Every `pr` stage of one round therefore acts on ONE branch, and
  the row opens ONE pull request from it, with the head the push stage pushed. A work stage in its own tree and a
  fan-out's lane are unchanged: local only, always.

Proved end to end by `node tools/verify-pipeline-assembly.mjs`: a four-stage round driven through the Assistant and the
driver on real trees, with a real `origin` whose main the checkout is AHEAD of - the parent tree is at `origin/main`'s
commit and holds none of the unpushed work, every stage child is named by `stageTreeName` and hangs under it, the
assembly happens IN that tree and its history reads in the round's order with every stage's file byte-identical, a
landing that happened after the freeze and a second round are both absent from the branch, a two-stage round assembles
the same way, and a deliberate same-lines conflict parks the row with the path and leaves the parent tree where it was.


### The artifact: one new hard gate

Every bundle stage declares an artifact with an id, a path and a writer. When a stage settles `done`, the driver resolves
that path against the tree with the same `{{hole}}` matcher a gate's decision path uses, and records
`artifact { id, path, present, sha256, commit, blob, blobSha256 }` on the stage run. **Absent → the row parks
`pipeline-artifact`**, naming the path and the handoff that now has nothing to pass. Files over 1 MiB record `present`
only (hashing a huge log in a sweep is a stall). A loop-back visit whose artifact hash is identical to the earlier
visit's is recorded `unchanged: true` — a visible fact, not a park. The check is made when the row has a tree; a row
with nowhere to resolve records that it could not check rather than inventing a park.

### Park or start: the decision a person can read

Every park and every move writes a `decision` on the stage run it is about:

```json
"decision": { "by": "panel", "trigger": "stage-settled", "code": "pipeline-artifact", "at": "…",
  "fact": { "kind": "artifact", "id": "finding", "path": "ledger/G58.json", "present": false, "handoff": "H-9" },
  "reason": "stage S7 settled — its artifact finding (ledger/G58.json) is not in the tree, so handoff H-9 has nothing to pass" }
```

`reason` is RENDERED from `fact` by one function (`renderDecision`), so the row's reason, the journal line and the
window cannot drift apart. `by` is who performed the transition (`panel`, `reader`, `assistant`); `trigger` is what made
it legitimate; `fact` is structured and small.

| code | when | the row reads |
|---|---|---|
| `pipeline-gate` | the gate after the settled stage has no decision record | the gate, the path, and that the code does not decide it |
| `pipeline-verdict` | the gate's record is there, and it names no outcome or one the decision's `routes` does not hold | the gate, the path, the outcomes it declares, and that the panel does not route a verdict the document does not hold |
| `pipeline-artifact` | the stage's declared artifact is not in the tree | the artifact id, the path, the handoff |
| `pipeline-run-failed` | the stage's run ended failed/interrupted/stopped | the status and the run's last words |
| `pipeline-cap` | a loop at or past its cap, or a cap that cannot be read | the edge, `used of limit`, or why the cap is unreadable |
| `pipeline-tree-gone` | the row had a tree and it is no longer there | the path, and the visit that last used it |
| `pipeline-tree-claimed` | another open row claims the same tree | the other row's id and title |
| `pipeline-unresolved` | the record names a pipeline or stage the bundle does not hold | the contract's own sentence |
| `pipeline-changed` | the routing fingerprint moved since the row entered | both fingerprints |
| `pipeline-refuse-input` | the handed-on artifact's recorded commit is not in this tree, or its blob is not the one recorded, or an input the document declares was settled by no run and is not in this tree either | the artifact, the commit it is pinned to and that the branch moved, or the artifact and that nothing has settled it; the stage run settles `refused` |
| `pipeline-start-refused` | the spawner or the cut refused | the refusal, and that nothing was started |
| `pipeline-starting` | a start is in flight inside the grace | a note only, never a park |

### Releasing a park

A park is a `manual` hold, and the panel never releases one on its own. Two parks need a named release, and both are
queue actions:

- `POST /api/assistant/queue` with `{ action: "pipeline-release", id, release: "cap" }` — **resets that edge's
  `crossings` to 0** and writes a `reader` decision with `fact: {kind: "cap-release", edge, from, to, was}`. Without the
  reset a requeue re-parks on the very next settle, because the count is compared as `used + 1 > limit` and a requeue
  never resets it. That is the cap-release defect the design names: a cap park is unreleasable by requeue alone.
- `{ action: "pipeline-release", id, release: "route" }` — re-stamps `pipelineRun.route` at the current stage and moves
  nothing else, so a deliberate re-export can be acknowledged row by row.

Every other park is released by fixing the fact: write the decision record, repair the tree, fix the record or the
bundle, start the worker by hand.

A park is a CONDITION (the hold) plus EVIDENCE (its `reason` and the row's `detail`), and the two are edited by
different doors. Correcting the evidence never moves the condition:

- `{ action: "state", id, state: "parked", reason: "…", detail: "…" }` on a row that is ALREADY parked writes the new
  prose and keeps the hold, including the `since` it was parked on - the row has been held since then, not since now.
  It used to answer "already parked" and drop both fields, so the sentence a parked row is judged by could not be
  rewritten without re-parking it (row 79).
- `{ action: "note", id, reason: "…", detail: "…" }` is the door for prose with no state move at all, and
  `{ action: "note", id, detail: "…", append: true }` adds a line to the detail instead of replacing it.
- A `link` fills facts and is not an advance: a row parked on a hold keeps its state, its hold and its prose when the
  next link reaches it.

### What the last stage does, and what stays open



The settle's landing rule is unchanged. At the last stage the driver has nothing to advance to, so the queue's own
settle finishes the row: a row with a tree is `done` when that tree's PR reads **MERGED**, and a row with no tree is
done when its run settles. That is what keeps a pipeline row open through every stage and closed only when the work
has actually landed — the same bar every other row has.

**While a round is live the driver owns the row's state.** A round with a parent tree lands from ONE assembled branch,
and until that branch is on the record the row holds N stage branches and no branch a landing step could push. So the
two writers that are not the driver test `roundOwesAssembly` (lib/task-pipeline.js) before they close anything:
`POST /api/assistant/queue` answers a `done` with a 400 naming the round and its unassembled branches, and
`settleTasks` leaves the row `running` even when a stage tree's PR reads MERGED. Row 51 of the 2026-11-09 round report
is the defect: an assistant's own turn closed a one-stage round whose only commit was on the stage tree, and the round
never assembled. The driver asks for the assembly first and settles the row itself; a round that has to stop is
**parked**, not closed, and the park is the record a person releases.

### The keys the driver keeps on the record

| key | written when | cleared |
|---|---|---|
| `pipelineRun.visits` | a stage is entered (assign, move, loop) | never within the same pipeline; a new pipeline starts a new record |
| `pipelineRun.stageRuns` | a start is asked for; filled at the link and at the settle | trimmed to 30 by the writer, `runsDropped` counts the loss |
| `pipelineRun.stageRuns[].inputs` | the start is asked for (the INPUTS block's own resolution) | trimmed with its stage run |
| `pipelineRun.stageRuns[].commit` | the stage settles (the tree's full HEAD) | trimmed with its stage run |
| `pipelineRun.stageRuns[].artifact.commit/blob/blobSha256` | the stage settles with a resolvable artifact | trimmed with its stage run |
| `pipelineRun.stageRuns[].inputsDropped` | only when the 24-entry cap refused one | trimmed with its stage run |
| `pipelineRun.tree` | the tree is cut | never by the pipeline — the reader deletes the tree, the record keeps the path |
| `pipelineRun.route` | a stage is entered | re-stamped by the reader's `route` release |
| `pipelineRun.crossings` | an edge is crossed | reset by the reader's `cap` release; a new pipeline starts a new record |
| `pipelineRun.startingAt` | the stage's worker is asked for | when the row moves to another stage, or on a `cap` release |
| `pipelineRun.waitingFor` | a gate, a cap or a routing change stops the row | when the record arrives (gate), on the release (cap, route) |

`startingAt` exists because the tick is faster than a spawn: the sweep asks for a stage's worker, the spawner takes
longer than one tick (a gateway probe, a `git worktree add`, the start), and without the marker the next pass would
start the same stage twice. It is written with the row BEFORE the start is attempted, and a start still unlinked after
three minutes is asked for again. A start the spawner refuses parks the row with the refusal instead: a stage that
cannot be started is a decision, not a retry.

## The artifact view on the flow

The flow the modal draws (`public/pipeline-flow.js`) puts the document's artifacts BETWEEN the stages: one node per
artifact the document already names as an input — a handoff's `artifact`, a stage's `inputs.read[]`, the document's
`external_inputs` — placed on the boundary after the column that writes it, or on the document's left edge when it
comes from outside. Nothing is added to the bundle to say so; the view is derived, and the three edge kinds the
document already distinguishes are the three marks:

| what the document says | the mark |
|---|---|
| a handoff carries an artifact from one stage to the next | the connector is **thick** |
| a stage's `inputs.read[]` names an artifact written further back | a **thin** line from the node to the column that reads it |
| the artifact is in `external_inputs` — this document does not write it | the node and its line are **dashed**, on the document's own boundary |

A read naming an artifact no stage writes and `external_inputs` does not declare is drawn as a node marked **missing**
(the word is painted, and the key names it) rather than dropped: a drawing that loses a read certifies a graph the
document does not have. A pipeline with no artifacts draws no layer and no key — the same rule the marks' legend
follows.

The node count and every position come from the document's own fields, in the track's own `calc()` (no measurement, no
`ResizeObserver`), so the picture agrees with the sequence it is drawn against at every width. `flow.artifacts` is the
list the markup is built from, which is what the tests read; `data-artifacts` on the root says how many the drawing
holds.

## The bundle, and the seed

`config.pipelineBundleFile` (default `state/pipeline-bundle.json`, beside the job store) is a file exported from the
pipeline studio. The loader (`lib/pipeline-bundle.js`) accepts the studio's own export shapes and refuses a bad bundle
WHOLE, with a code and a locator.

That file is read through ONE module, `lib/pipeline-source.js`, and its list is the one the queue picker offers and
the Settings pipeline tab draws (the `pdl` block of `GET /api/pipelines`). Settings also holds a tree ladder
(`pipelines.json` over `pipelines.seed.json`, `docs/pipelines.md`) which is a different object: a ladder rung says what
a TREE may do with a branch, a PDL pipeline says which stages a TASK runs. The two were once two different sets of
"pipelines" on two tabs; `docs/pipeline-sources.md` records that recon and the one reading they now share.

The panel ships `pipeline-bundle.seed.json` at the repo root: the studio's own export of its 13-stage POC-to-UAT
project (`exportBundle(pipeline.seed.json).files.pipeline`), not a fixture assembled to suit the loader. Install it
beside the queue with:

```bash
node tools/seed-pipeline-bundle.mjs           # refuses to replace an existing bundle
node tools/seed-pipeline-bundle.mjs --force   # replace it with the shipped seed
```

**There is no fallback.** With no `pipeline-bundle.json` beside the job store, an assigned task reads
`unresolved` with a reason naming the file — never `assistant-decides`, and never a 500. Absence of a bundle is a fact
the reader can fix; pretending the assignment was the default path would silently drop the pipeline the task was put on.

## Trying it

1. `node tools/seed-pipeline-bundle.mjs`
2. open the panel, Assistant → Queue, press a row's pipeline chip (a task with no assignment says **assistant decides**)
3. choose the pipeline and a starting stage, then press **put it on this pipeline**
4. the row's chip updates; reopen the window to see the stage marked `position of 13`, the moment it began, and the
   elapsed span — recomputed on open, and ticked while the window is open
5. **clear** sends it back to the default path
6. with the assistant's `spawn` switch on **auto**, the row at the front of the queue has its tree cut first, then is
   started by the panel at its stage; each stage that settles writes the row forward to the next one in the same tree,
   and a stage that cannot start, cannot find its artifact, or finds a tree claimed by another row parks with a named
   reason. On **ask** or **off** the row advances the same way but waits for you to start it, and no tree is cut.

## The bench: four shapes, one real task each

`tools/verify-pipeline-walk.mjs` walks the SHIPPED documents, which are large enough that a reader cannot check the
graph by eye. `tools/bench-pipeline.mjs` is the other half: four definitions small enough to hold in one's head, one
per shape a walk can take, checked in under `tools/pipeline-bench/` as a single bundle.

| document | the shape | the scenario |
|---|---|---|
| `bench-handoff` | `draft → stage`, one sequence edge | `handoff` |
| `bench-gate` | `draft → review → publish`, G1 routing `accept → H-02`, `reject → H-03` | `gate-accept`, `gate-reject` |
| `bench-queue` | `queue-a → queue-b`, filed behind a live row | `queue-behind-live` |
| `bench-ping-pong` | `ping ⇄ pong`, both edges capped loops | `ping-pong` |

Every scenario is attached to a real queue task and walked by `Assistant.sweepQueues()`, the panel's clock; the gate's
decider writes the record only after the row has parked, so the barrier is observed rather than crossed early. The
report (`docs/reviews/pipeline-bench/report.html`, ledger beside it) answers per pipeline and per stage whether the
assistant staged, gated, queued and bounced, and names the row, the stage run, the job and the thread. A failure names
the step where the walk left the document: a start out of order, an entry with no edge, a gate crossed without a park,
a reject that went forward, a loop past its cap, or a queued row with a start owed.

```
node tools/bench-pipeline.mjs                 # walk all five, write the report
node tools/bench-pipeline.mjs --only ping-pong
node tools/bench-pipeline.mjs --no-write       # print only
```

The tool reads `tools/pipeline-bench/bundle.json` and `scenarios.json` on every run and rebuilds neither, so an edited
definition is the definition the next run walks. The four documents are independent of the live catalogue: repairing
or replacing the install's bundle does not change what the bench walks, which is what lets it keep running after a
catalogue repair.
