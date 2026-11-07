# A parked stage run, on its pipeline row

**Status:** design note, ping-pong round 5, stage 1 of 2. Read at `9f94a11` (main); line numbers are this tree's. It states the contract and names a gap.

**The question.** A stage's run has ended and the row is parked. Which fields does it keep, what is each for, and what must never break?

A park is not a move. `parkRow` changes the row's state and writes the decision; it does not advance the stage (`lib/task-pipeline-drive.js:1304-1313`). The row keeps its position and the ledger entry that names the run. Its write is small: `state: "parked"`, the decision's sentence as the row's `reason`, and `hold: {kind: "manual"}`. A world-state park also writes `waitingFor`.

## The row's own fields

- **`state`** is `parked`: neither live nor queued. The driver starts only a queued row and skips a parked one (`:1574`, `:1770-1772`), so nothing starts the stage again without a person.
- **`reason`** is the sentence `renderDecision(fact)` renders from the decision's fact (`:618-626`). It names the pipeline, stage and why the row waits: the row's one sentence.
- **`hold`** has `kind: "manual"`; no clock expires it. A park carrying **`waitingFor`** (a gate's path, a cap's edge, or a moved route's fingerprint, `:1714-1718`) is released by its world-state: a gate's record does, and `releaseCapPark`/`restampRoutePark` release a cap or moved route. A failed run carries none and waits for a requeue.

## The position the row keeps

Every position field stays where the run left it. `pipeline` and `stage` are the two halves of the run id. `enteredAt` is the clock `elapsedInStage` measures from. `visits` is the ordinal that makes the id unique per visit; `assignPipeline`/`enterStage` increment it, a park does not. `crossings` is the loop cap's count; only `enterStage` charges it, on an edge. `route` is the fingerprint the row entered under. `tree` is the row's tree; a park neither recuts nor clears it. `via` is the edge the row arrived by. A failed run is not an edge and charges no crossing. `moveTo` deletes `waitingFor` and `startingAt`; a park does not move it (`:928-948`).

## The run's entry

`pipelineRun.stageRuns[]` is the ledger, newest last, capped at 30 with the dropped count in `runsDropped` (`lib/task-pipeline.js:235-249`). The current entry is the run's name:

- **`id`** is `<pipeline>/<stage>#<visit>` (`stageRunId`, `:198-204`).
- **`stage`, `visit`, `at`** say where and when the start was asked (`beginStageRun`, `:268-291`).
- **`thread`, `job`** name the agent and job that carried it.
- **`status`, `settledAt`** say how it ended and when the panel read it (`settleStageRun`, `:299-355`).
- **`decision`** is the park's structured why: `by`, `trigger`, `code`, `at`, `fact`, `reason` (`decisionOf`, `:715-718`).
- **`commit`, `inputs`** are the starting point, written at the ask (`:1900-1909`); a park leaves them. `artifact`/`merge` are the handoff; a failed run has neither.

When the park's fact is a finished run, the failed branch passes `settle: {status, thread, job, at}` to `stop`, which calls `settleStageRun` with those and the decision in one call (`:1459-1478`, `:1599-1607`). The entry's `status`, `settledAt`, `thread`, `job` and `decision` land together. Every other park passes no settle: its fact is not the run's end.

## The invariant

**A parked row still names the run it parked on.** The position does not move: `stage` and `visits[stage]` are the same as when the run ended. The entry stays, with its `id`, `thread` and `job`. Break either and the row names a stage, not a run: an advanced stage or a bumped visit would name another run; a dropped entry would lose the name. For a park whose fact is a finished run, the same write must also say how it ended: a park that writes only the decision leaves `status: null`, which reads as a run that never ended and, in the code's words, "cannot say which run it parked on" (`:1455-1458`, `:1603-1606`). A park whose fact is not a run (an unresolved record, a refused start, a missing tree) says that fact; its entry names the attempt.

**Unsure:** three done-run parks stop before the done-settle (`:1614-1640`): their entries name the run but leave `status` null. Whether the invariant should also require the ending there is not settled by these two modules.
