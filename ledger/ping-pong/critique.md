# The critique: a parked stage run, on its pipeline row

**Status:** critique, ping-pong round 5, stage 2 of 2. Reads `ledger/ping-pong/draft.md` (693 words) at `42656fa`, against the code at `9f94a11`. `lib/task-pipeline-drive.js` and `lib/task-pipeline.js` are unchanged between that commit and `main`'s tip `504a842`, so every line number below is the draft's tree and main's. Nine notes, five blocking. The verdict is last.

Each note names the sentence, what it gets wrong against the code, and the fix it needs. I have not touched the draft.

## Blocking

**1. `parkRow` does not write the decision.**
*Sentence:* "`parkRow` changes the row's state and writes the decision; it does not advance the stage (`lib/task-pipeline-drive.js:1304-1313`)."
`parkRow` takes an already-rendered `reason` string and hands it to `setTaskState` with `state: "parked"` and `hold: { kind: "manual" }` (`:1304-1306`); it never builds or writes a decision. The decision is written one level up, in `stop`: `recordStageDecision` at `:1474`, or the `settleStageRun` call at `:1465-1473` when the park carries a settle. The cited range is the row write only, which is exactly why it shows no decision.
*Fix:* say `parkRow` changes the row's state and stamps the decision's rendered sentence as the row's `reason`; name `stop` (`:1459-1478`) as the writer of the decision on the stage run. The distinction matters later, where the invariant says "the same write" as if the row's park and the entry's settle were one write.

**2. The row's `reason` does not name the pipeline and the stage.**
*Sentence:* "**`reason`** is the sentence `renderDecision(fact)` renders from the decision's fact (`:618-626`). It names the pipeline, stage and why the row waits: the row's one sentence."
`:618-626` stops inside the `run-status` case of a switch that runs to `:711`. That case does print `pipeline · stage`; most others do not. A tree-gone park reads `the tree <path> this row ran in is gone ...` (`:677-682`); a gate park names the gate and the stage, not the pipeline (`:645-651`); a cap park names the edge and its endpoints (`:668-673`); the `record` and default cases return the fact's own reason, which may name neither (`:683-685`, `:707-710`). The row's one sentence is still one sentence, but it is not a sentence that names the pipeline and stage.
*Fix:* cite `:618-711`, and say what the sentence is for: it is the rendered why, and which names it carries depends on the fact's `kind`. Do not promise pipeline and stage for every park.

**3. Only a gate park releases on its world-state; a cap and a route are the reader's.**
*Sentence:* "A park carrying **`waitingFor`** (a gate's path, a cap's edge, or a moved route's fingerprint, `:1714-1718`) is released by its world-state: a gate's record does, and `releaseCapPark`/`restampRoutePark` release a cap or moved route."
The two halves contradict each other, and the code says the second is right. `waitingFor` records the release condition, and only `kind: "gate"` is re-read by the driver (`:1484-1561`); the pass skips every other kind with the comment that a cap or fingerprint park "has no world-state that could release it: its release is a queue action" (`:1490-1491`). `releaseCapPark` zeroes the crossing count and `restampRoutePark` re-stamps the route, both with `by: "reader"` (`:1374-1412`). The citation is also short: `:1714-1718` covers the gate/verdict and cap waits only; the route wait is written at `:1638` and `:1797`.
*Fix:* split the sentence. A `gate` wait releases on the record, and the driver re-reads it every pass. A `cap` or `route` wait has no world-state release: a reader runs `releaseCapPark` or `restampRoutePark`, and that action also writes a decision. Cite `:1638` and `:1714-1718` for the writes, `:1374-1412` and `:1484-1561` for the releases. Say `waitingFor` lives on `pipelineRun` (`:1311`), not on the row.

**4. The invariant defines "names the run" twice, then quotes a sentence that supports the second definition against the first.**
*Sentence:* "**A parked row still names the run it parked on.** ... The entry stays, with its `id`, `thread` and `job`. ... a park that writes only the decision leaves `status: null`, which reads as a run that never ended and, in the code's words, "cannot say which run it parked on" (`:1455-1458`, `:1603-1606`)."
By the draft's own account the run is named by the position and the entry's `id`, `thread` and `job`; a null `status` cannot lose that name. The quoted clause says the opposite, that status null means the entry "cannot say which run it parked on". The comment it comes from is about the ending: it says status null "reads as a run that never ended" (`:1603-1606`), and the draft says the same one clause earlier. The paragraph is therefore asking the reader to accept both "the entry names the run" and "without status it cannot name the run".
*Fix:* define the name once. The stage run is named by `stage`, `visits[stage]` and the entry's `id`, with `thread` and `job` when a worker was cut. State the ending as a second requirement in its own sentence: `status` and `settledAt` are what make the entry read as a finished run rather than an open attempt. Quote only "reads as a run that never ended"; if the note wants to argue that a finished run's name includes its ending, say that in its own words instead of borrowing the comment.

**5. The three done-run parks are left undecided, and the "status null" premise is only true on one of the two paths into them.**
*Sentence:* "**Unsure:** three done-run parks stop before the done-settle (`:1614-1640`): their entries name the run but leave `status` null. Whether the invariant should also require the ending there is not settled by these two modules."
(a) The brief asks for one invariant, and this leaves three cases outside it. By the note's own argument, a park whose fact is a finished run must say how it ended; the answer is yes, not unsure. The three stops (`:1615-1617`, `:1625-1629`, `:1634-1640`) all run after `status === "done"` (`:1596`, `:1610`) and, on the running path, have `thread` and `last.id` in hand, so the settle is available.
(b) "leave `status` null" is true only for a `running` row. The same block is entered for a `queued` leftover (`:1573`), whose entry already carries `status: "done"` and a `settledAt` from its earlier settle (`:1596`, `:1659-1669`). A blanket settle there would rewrite both, and would stamp the row's current thread onto the old run: with `own.status` already set, the `thread` at `:1589` falls back to `currentThread`, and `settleStageRun` writes it and a fresh `settledAt` (`lib/task-pipeline.js:319-326`).
*Fix:* decide yes. Pass `settle: { status, thread, job: text(last && last.id) || null, at: isoOf(at) }` for the three, guarded so the leftover path keeps its entry: `settle: text(own.status) ? null : {...}`, using `own` from `:1588`. Rewrite line 30's "every other park passes no settle", which stops being true. If the stage prompt still wants an unsure section, it cannot contain this question.

## Not blocking

**6. `merge` is not a settle-only field, so a failed run can carry one.**
*Sentence:* "`artifact`/`merge` are the handoff; a failed run has neither."
`settleStageRun` writes `merge` when it is given one and never clears it when it is not (`lib/task-pipeline.js:341`). The aggregate writes the join's `merge` before the join's agent starts (`lib/assistant.js:1494`), which is how the driver knows the aggregate is no longer owed. A join that then fails keeps its `merge` on the parked entry. The `artifact` half is true: it is written by the done settle (`:1659-1669`), which a failed run never reaches.
*Fix:* say `artifact` is the done run's handoff and `merge` is the aggregate's, written on the join before its run; a failed run has no `artifact`, and a failed join still has its `merge`. If the sentence must stay inside the two modules, drop "a failed run has neither": `settleStageRun` never clears either field, so the module does not support it.

**7. "Its entry names the attempt" puts the done-run parks on the wrong side.**
*Sentence:* "A park whose fact is not a run (an unresolved record, a refused start, a missing tree) says that fact; its entry names the attempt."
Two of the three examples are parks that happen after the run finished: the unresolved-record park at `:1615-1617` and the tree-gone park at `:1625-1629` are inside the `status === "done"` branch, and their entries name the run, not an attempt. The start-path parks are different calls: `:1781` (unresolved), `:1800` (tree gone) and `:1807` (no target). Those are the ones whose entry is an attempt only. The note classifies by the fact's kind, but the distinction it needs is whether a worker ever linked.
*Fix:* classify by the entry. A park that stops a start has an attempt-only entry, with `thread` and `job` null, created by the settle fallback when there is no entry (`lib/task-pipeline.js:312-317`). A park on a finished run has an entry with `thread` and `job` and needs the ending. List the calls for each side; the current parenthetical lists both sides as if they were one.

**8. The field list mixes stored fields with fields that are read from a default.**
*Sentences:* "**`visits`** is the ordinal that makes the id unique per visit ..." and "**`status`, `settledAt`** say how it ended and when the panel read it".
`visits` can be absent on a record written before the counter: `visitsOf` reads it as one visit for the stage the row is in and writes nothing back (`lib/task-pipeline.js:206-219`). `settledAt` is not created with the entry: `beginStageRun` writes `status: null` and no `settledAt` (`:278-287`), and `settleStageRun` writes `settledAt` only when it writes a status (`:321-326`). A parked row that has not settled therefore has no `settledAt`, and an old row may have no stored `visits`, even though the draft's list presents both as fields the row keeps.
*Fix:* say which fields are stored and which are read. `visits` is stored once a row has entered under this ledger and reads as `1` when absent; `settledAt` exists only with a settled `status`. That is the honest version of "which fields the row keeps", and it is the one a reader can check against the two modules.

**9. "No clock expires it" is proved outside the two modules.**
*Sentence:* "**`hold`** has `kind: "manual"`; no clock expires it."
The driver never releases a manual hold, and that part is in these two modules. The negative ("no clock") is enforced by the board's sweep, which returns early on a missing or `manual` hold (`lib/assistant/queue.js:1165-1170`). A reader limited to the two cited modules can see that the driver does not release it, not that nothing does.
*Fix:* either scope the claim to the driver ("the driver never releases it") or cite the sweep that skips a manual hold. Do not leave a negative whose only proof is outside the two files the brief names.

## Verdict

**Not accepted in this round.** The shape is right, and three findings survive contact with the code: a park and a move are different writes, the failed branch settles the entry in the same call as the decision (`:1599-1608`), and the invariant is about position and the entry rather than the row's state. The question the note isolates, whether a park on a finished run must also record the ending, is the right question and the reason the note is worth writing.

But the contract it states is not the contract the code keeps. `parkRow` does not write the decision (1); the row's `reason` does not name the pipeline and stage for most parks (2); only a gate park releases on its world-state, while cap and route are reader actions (3); and the invariant defines "names the run" twice, then quotes a comment that supports the second definition against the first (4). The one decision the brief asks for is left "Unsure", and its premise is only true on one of the two paths into those parks (5). Notes 6 to 9 are corrections of claims that can be folded in without reopening the shape.

Minimum for acceptance: notes 1 to 5 fixed, with the three done-run parks settled rather than left open; 6 to 9 folded in. Then the note can be read as a contract rather than a first pass at one.
