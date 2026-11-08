# The critique: how a row moves, visit 1

**Status:** critique, ping-pong stage 2 of 2, visit 1. Reads `ledger/ping-pong/draft.md` (587 words) at `a943e6d`, against the code at the same commit; every line number below is this tree's. `origin/main` has moved on while this was written (nine commits, `3bcbcf8`), and `98fca28` shifts `lib/assistant.js` by a few lines without touching `sweepQueues`, `cutPipelineTree` or `linkSpawnTask`, so a citation to that file names this tree's line, not main's. This file replaces the round-5 critique of the previous draft (the parked-stage-run note, 693 words at `42656fa`); that critique is in history at `b0a382f` and does not apply here.

Five notes, all blocking. Each names the sentence, what it gets wrong against the code, and the fix it needs. I have not touched the draft.

## Blocking

**1. A gate after the last stage is not a barrier.**
*Sentence:* "A gate that declares a `decision` is a barrier: if the record is absent when the stage settles, the row parks with `waitingFor: {kind: "gate", path}` (`:1768-1772`)."
The gate is never enforced when the stage has no edge out: `nextStageOf` returns `{ ok: true, done: true, closing: gateAfter(pipeline, stageId) }` (`:832`) before the gate branch. Rule 3 says the same in words: a gate anchored after the last stage is named `closing` and is "NOT a barrier when it has no edge out" (`:42-47`). A missing record there changes nothing; the row is finished by the settle. The gate IS a barrier when it sits on an edge out, including a last stage whose only edge out is a loop.
*Fix:* scope the sentence to the edge (for example: "a gate that sits on the edge out and declares a `decision` is a barrier") and add the closing case: after the last stage, with no edge out, the gate is `closing` and never waited on.

**2. A retry stops reusing the entry once a worker has linked.**
*Sentence:* "A retry reuses the open entry, because a retry is an attempt, not a visit (`lib/task-pipeline.js:275-288`)."
The open-entry test is narrower than the sentence: the entry must have no `thread` and no `status` as well as the same stage and visit (`:275-277`). An attempt that was refused before a worker existed has neither, and is reused. An attempt that linked has a `thread`; one that settled has a `status`; a retry after either pushes a SECOND entry under the same id. The draft's own surprise section supplies the case: a failed run that `settleTasks` requeues is started again on the same visit, so it duplicates the id.
*Fix:* name the condition: a start that was refused, with no `thread` and no `status`, reuses the open entry; a retry after a linked or settled run opens a second entry under the same id. `docs/task-pipeline.md:63` states the broad rule too, so the draft may be quoting the document rather than the code.

**3. A present record is not always crossed.**
*Sentence:* "A record already in the tree is crossed without a park."
The record's `outcome` is read only when the gate declares `routes` (`:858`). For a routed gate, a record that is not JSON, names no `outcome`, or names one the gate does not declare is `pipeline-verdict` (`:861-870`), and the row parks on the same record it could not route. A gate with no `routes` is crossed on presence alone, as the sentence says.
*Fix:* split it. A present record is crossed without a park when the gate does not route; when it does, the record must also carry an outcome the gate declares, or the row parks `pipeline-verdict`.

**4. "No tree" is two states and only the first is cut.**
*Sentence:* "A row with no tree gets an `ensureTree` request, not a start (`:1915-1931`)."
`treeLookup` separates the row that has never had a tree (`{ needed: true }`) from the row whose recorded tree is gone (`{ lost: { path, stage } }`, `:988-1009`). The first is the cut request. The second parks `pipeline-tree-gone` and is never cut a second time (`:1856-1861`). A row with no tree and no project parks `pipeline-no-target` (`:1862-1865`). The sentence covers one of the three, and the one it drops is the guarantee the next sentence depends on: one tree serves the row and is not re-cut.
*Fix:* "A row that has never had a tree, and names a project, gets an `ensureTree` request; a row whose recorded tree is gone parks, and is not cut a second time."

**5. The cut and the start are the unattended path, not every pass.**
*Sentence:* "The Assistant cuts it, writes `pipelineRun.tree` on the row, and the next pass starts the stage there with `existing: true` (`lib/assistant.js:1471-1544`)."
Both requests sit inside `if (unattended)` (`:1826`): the `ensureTree` push (`:1930`) and the start (`:1937`). `sweepQueues` sets `unattended` from the assistant's `spawn` setting being `auto` (`lib/assistant.js:1307`), and the default is `ask` (`lib/assistant/config.js:155`). On ask or off the row advances when it settles but no tree is cut and no stage is started; that is the same statement `docs/task-pipeline.md:457-460` makes. Even on `auto`, the driver takes only the front of the queue (`:1827-1828`), so a row behind it is not cut or started until it is first.
*Fix:* say whose path it is: with `spawn` on `auto`, the front queued row has its tree cut, and a later pass starts its stage with `existing: true`; on ask or off, no tree is cut and the row waits for the reader to start it.

## Verdict

**Not accepted in this round.** The brief's five sections are all there, each in its own paragraph, with the module names it asks for and a real surprise at the end: `settleTasks` would requeue a failed run with `attempts + 1`, while the driver parks the row and stamps a manual hold; the driver runs first, so the park is what the queue's settle finds (`lib/assistant.js:1300`, `:1315`). Every other citation in the draft resolves to the line it names; the five defects above are claims the code narrows, not drifted numbers.

But four sentences state a universal the code does not keep (the barrier, the entry reuse, the crossed record, "no tree") and one omits the switch that decides whether the mechanism runs at all. Minimum for acceptance: all five fixed. The draft is 587 words of its 600, so each fix has to be paid for by a cut somewhere else.
