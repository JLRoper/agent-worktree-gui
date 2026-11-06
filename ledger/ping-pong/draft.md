# A failed stage run, on its pipeline row

**Status:** design note, ping-pong round stage 1 of 2. Read at 1.41.0 (`28f57a0`). It proposes; it changes no product code.

**The question.** A stage's worker ends `failed`, `interrupted`, `stopped`, `cancelled` or `timeout`. The row is parked. What should its pipeline row say, and what must stay true while it says it?

## What the record has today

Each entry into a stage is a stage run on `pipelineRun.stageRuns[]`: `{id, stage, visit, at, thread, job, status, decision}`, id `<pipeline>/<stage>#<visit>` (`lib/task-pipeline.js:256`, `:287`). The driver reads the last run on the row's thread; a terminal word in `FAILED_STATUS` (`lib/task-pipeline-drive.js:132`) parks the row as `pipeline-run-failed` (`:1505`) with `hold: {kind: "manual"}`, and `stop()` writes the decision on the stage run (`:1382-1387`).

The row then tells the event three ways: the task state says `parked` (`lib/assistant/queue.js:1195`); the agent line says `exited` for `failed` and `not-running` for every other terminal word (`public/assistant.js:2982`); the note says `stage ping-pong · draft ended failed: <last words> - the pipeline waits for a decision rather than re-running the stage` (`renderDecision`, `lib/task-pipeline-drive.js:568-572`). The pipeline chip says only `pipeline ping-pong · draft` (`public/assistant.js:3111`).

The stage run itself still says `status: null`. The failed branch parks without `settleStageRun` and its status; the done branch settles (`lib/task-pipeline-drive.js:1561`). So `settledAt` is absent and the death lives only in `decision.fact.status` and the clipped row sentence. The window's `ran` read counts a decision as evidence the stage ran (`lib/pipeline-window.js:169-183`), and the flow marks it `current` (`public/pipeline-flow.js:373-390`), the same blue as a live worker. Blue claims work is happening. Nothing is.

## The row this note specifies

One event, one reading, in the pipeline's own words. Four statements, in this order:

1. **Where.** The stage and the visit, the visit only when greater than 1: `ping-pong · draft, visit 2`.
2. **What ended.** The run's own terminal word, quoted, not flattened to `error`.
3. **Why.** The run's last message, clipped, or `no final message`. Never the panel's summary.
4. **What happens next.** Nothing until a person requeues it.

The row as it should read:

```
#211  parked   Ping-pong round 4: run a small two-agent hand-off ...
      o exited  wtgui-stage-1-of-2-the-drafter-in-f13797  project agent-worktree-gui
      pipeline ping-pong · draft (visit 2) · run failed   ->
      parked - stage ping-pong · draft ended failed: the worker exited 1 before writing the draft - the pipeline waits for a decision rather than re-running the stage
```

The chip is where the failure belongs: it is the row's one pipeline feature. `pipeline <id> · <stage>` gains ` (visit <n>)` when n > 1 and ` · run failed` for a terminal failure. The note carries the exact word and the last message; the chip is the scan word.

The window's run list shows the entry's `status`, `settledAt`, `job`, `thread`, `detail` and decision code, so the attempt is readable without the row's prose. The flow node keeps `data-mark="current"` (the row is still in the stage; the position is true) and gains `data-run="failed"`, painted red and named in the legend. The four-mark vocabulary stays four; the outcome is the same kind of second attribute as the gate's `data-state` (`public/pipeline-flow.js:18`, `:42-57`).

## Invariants the row must keep

1. **The stage does not move.** `stage`, `enteredAt`, `visits` and `crossings` are unchanged. A failure is not an edge and charges no cap crossing.
2. **The row is not live.** `state` is `parked`; no marker paints it running. A dead run must not match the live set in `queueAgentChip` (`public/assistant.js:2968`).
3. **The park is the reader's.** `hold: {kind: "manual"}`; no sweep, timer or start releases it. Requeue, reassign or delete does, recorded as the reader's.
4. **One write, one fact.** The entry's `status`, `settledAt`, `job`, `thread` and `detail` are written in the same queue write as the park; the sentence is `renderDecision(fact)` everywhere.
5. **The failure survives the retry.** A requeue increments `attempts` and opens a new attempt; the failed entry is never overwritten, and a trim is counted in `runsDropped`.
6. **The identity stays unique.** Two entries never share `<pipeline>/<stage>#<visit>`. `beginStageRun` reuses an entry only when `thread` and `status` are both empty (`lib/task-pipeline.js:262-264`), and a linked failure has a thread, so a retry would mint a second entry with the old id. A retry needs an attempt ordinal in the id, or `attempts[]` on one entry.
7. **The tree is kept.** No recut, no reset, no clean. The retry runs in the same tree; a missing tree is `pipeline-tree-gone`, a different fact.
8. **Nothing is handed on.** A failed stage produces no artifact pin, no commit handoff and no gate read. The next stage does not start.
9. **It stays distinguishable.** `pipeline-run-failed` is not `pipeline-start-refused` (nothing ran), not `pipeline-unresolved` (the record cannot be read) and not `pipeline-artifact` (a done stage wrote nothing). Each keeps its own code, word and mark.
10. **The row is not finished.** The settle does not close it, no PR is claimed and no `done` is written. The reader is its only exit.

## What I am unsure of

- `data-run` on the flow node or a fifth mark. I chose the second attribute: the four-mark vocabulary is a deliberate contract, and the gate already uses a second attribute on the same node.
- Whether a retry keeps the visit (an attempt) or increments it (a new visit). The cap counts crossings, not visits, so an attempt ordinal is smaller, but still a schema change.
- Whether the chip should say `run failed` or the exact terminal word; and how much of the last message the row can hold (its reason is clipped to 600, `lib/assistant/queue.js:50`).
