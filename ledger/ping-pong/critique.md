# The critique: a failed stage run, on its pipeline row

**Status:** design note, ping-pong round stage 2 of 2. Reads `ledger/ping-pong/draft.md` (928 words) at `cdf0ea4`, against the code at the same commit (`28f57a0` plus two docs-only commits, so the draft's citations are testable). Ten notes, five of them blocking. The verdict is the last section.

Each note names the sentence, what it gets wrong against the code, and the fix it needs. I have not touched the draft.

## Blocking

**1. The parked state is cited to a line that returns `queued`.**
*Sentence:* "the task state says `parked` (`lib/assistant/queue.js:1195`)".
`queue.js:1195` is inside `settleTasks`, and it returns `state: "queued"`, `startedAt: null`, `attempts: t.attempts + 1` for a failed run: a retry, not a park. `queue.js` has no `parkRow` at all. The park is `parkRow` in `lib/task-pipeline-drive.js:1238-1240`, which calls `setTaskState(..., "parked", { by: "panel", reason, at, hold: { kind: "manual" } })`.
*Fix:* cite `lib/task-pipeline-drive.js:1240` for the state and `:1235-1237` for the manual hold, and drop `queue.js:1195` from the sentence entirely.

**2. A second writer reacts to the same failure and the note never names it.**
*Sentence:* invariant 3, "The park is the reader's. `hold: {kind: "manual"}`; no sweep, timer or start releases it."
`settleTasks` (`lib/assistant/queue.js:1158`) reacts to the same terminal status one function later in the same pass: a `running` row whose last job failed comes back `queued` with `attempts + 1` (`:1191-1195`), no reader involved. It leaves the parked row alone for two reasons, neither of them in the draft: it is called after the driver (`lib/assistant.js:1181` then `:1196`), and it returns early on a row whose hold is missing or `manual` (`:1162-1163`). So invariant 3 is true today by pass order, not by construction. If the order flips, or the driver `continue`s on a row it cannot park (`lib/task-pipeline-drive.js:1496`, `:1501`), the row requeues itself and invariants 3, 5 and 10 all stop holding.
*Fix:* name `settleTasks` as the second reactor, state driver-then-sweep as a precondition of the design, and add the rule that the sweep skips any row carrying a `pipelineRun`. Then the invariant is enforced rather than incidental.

**3. Invariant 4 writes a field the stage run does not have.**
*Sentence:* "The entry's `status`, `settledAt`, `job`, `thread` and `detail` are written in the same queue write as the park".
There is no `detail` on the entry. `beginStageRun` creates `{id, stage, visit, at, thread, job, status, decision}` (`lib/task-pipeline.js:266-275`) and `settleStageRun` takes no `detail` parameter (`:287`); the last message rides inside `decision.fact.detail`.
*Fix:* say `decision.fact.detail`, and say the failed branch makes ONE `settleStageRun` call carrying `status`, `at` and the park decision together. Not a settle followed by `recordStageDecision`, which is itself `settleStageRun(task, { decision })` (`:346`) and would write the same slot twice.

**4. The quoted sentence is not the sentence the code renders.**
*Sentence:* "the note says `stage ping-pong · draft ended failed: <last words> - the pipeline waits for a decision rather than re-running the stage`", repeated in the row block at line 30.
`renderDecision` joins pipeline and stage with `" · "` and prefixes nothing (`lib/task-pipeline-drive.js:566`), so the string begins `ping-pong · draft`. `:572` puts an em dash (U+2014) before "the pipeline waits", not the hyphen shown. A note whose invariant 4 says "the sentence is `renderDecision(fact)` everywhere" cannot misquote it twice.
*Fix:* quote the string exactly as `:572` builds it, or quote the intended new wording and say `renderDecision` changes to produce it.

**5. Invariants 5 and 6 offer two remedies, one of which invariant 5 forbids.**
*Sentence:* "A retry needs an attempt ordinal in the id, or `attempts[]` on one entry."
Invariant 5 already says "the failed entry is never overwritten", which rules out `attempts[]` on one entry. Meanwhile `lib/task-pipeline.js:253-255` states the file's contract, "A retry of the same visit reuses the entry rather than minting a second one - a retry is an attempt, not a visit", and the guard at `:264` defeats it by demanding `!thread && !status`. So the note offers two options with one already dead, and never says the guard contradicts its own comment.
*Fix:* state one rule - a retry is a new entry whose id carries the attempt, `<pipeline>/<stage>#<visit>.<attempt>`, leaving the filed one intact - and name the guard at `:264` as the code the rule replaces, because reuse cannot satisfy "never overwritten".

## Not blocking

**6. The mark's claim is overstated, and the fix contradicts the sentence.**
*Sentence:* "the flow marks it `current` ... the same blue as a live worker. Blue claims work is happening. Nothing is."
`current` is position, not liveness: `MARK_WORDS.current` is "current" (`public/pipeline-flow.js:51`) and `marksFor` returns `CURRENT` for the row's stage before it ever consults `ran` (`:384`, `:386`). The next paragraph keeps `data-mark="current"` because "the position is true", so the draft calls the mark a lie and then keeps it.
*Fix:* say what the mark claims - the row is in this stage - and that nothing on the node speaks for the run. That is exactly the gap `data-run="failed"` fills, and then the two paragraphs agree.

**7. The chip flattens what the note forbids flattening.**
*Sentence:* "`pipeline <id> · <stage>` gains ` (visit <n>)` when n > 1 and ` · run failed` for a terminal failure."
Line 20 requires the run's own word, "quoted, not flattened to `error`"; the chip flattens all eight words in `FAILED_STATUS` (`lib/task-pipeline-drive.js:132`, which also carries `error`, `canceled` and `exited`) to one phrase. The uncertainty section admits this, which is not the same as deciding it.
*Fix:* keep `run failed` as the scan word, argue it in the body, and say which of the eight statuses the row block's `o exited` is portraying. Only the literal `failed` produces that word and the `.is-failed` pill (`public/assistant.js:2982`); the other seven read `not-running`.

**8. The chip's two new facts have no named source, and one of them does not exist yet.**
*Sentence:* the same chip sentence.
`queuePipelineChip` builds its words from `t.pipelineRun.pipeline` and `.stage` only (`public/assistant.js:3111-3117`). ` (visit <n>)` needs `visits[stage]` (`lib/task-pipeline.js:210-214`); ` · run failed` needs the last entry's `status`, which the draft's own line 13 says is null today and only becomes readable after the settle the draft proposes.
*Fix:* name the read for each addition - `visits[stage]` for the visit, `decision.fact.status` (or the settled `status`) for the word - and say the chip is right both before and after the settle lands.

**9. The 600-char clip eats the half of the sentence the park depends on.**
*Sentence:* "how much of the last message the row can hold (its reason is clipped to 600, `lib/assistant/queue.js:50`)".
600 (`TASK_REASON_MAX`) is the clip on the composed sentence, and `clip` cuts the tail (`:70-73`); `setTaskState` applies it (`:687-692`). The fixed parts come to 101 characters, so 499 of message fits; a longer message silently removes "the pipeline waits for a decision rather than re-running the stage", which is the clause the row's own claim rests on. The note files this as an open question; it is a defect.
*Fix:* clip the detail before composing, to a named constant such as `RUN_DETAIL_MAX`, and state that the tail is never clipped.

**10. "The last run" is the job store, not the ledger.**
*Sentence:* "The driver reads the last run on the row's thread".
`lastRunFor(thread, jobs)` reads the job store's runs for the thread (`lib/task-pipeline-drive.js:1186-1192`), not `stageRuns[]`. In a note about the ledger, "the last run" reads as the entry, and the two disagree exactly in the case under discussion, where the entry's `status` is null.
*Fix:* say "the last job on the row's thread".

## Verdict

**Not accepted in this round.** The structure is right and the central finding is correct and worth the note: the failed branch parks without settling, so `status` stays null and `settledAt` is absent while the done branch settles (`lib/task-pipeline-drive.js:1505` against `:1561`), and the chip cannot say what happened. That is real, and invariant 2's citation of `QUEUE_LIVE` is right.

But four of the citations a reader would lean on do not survive contact with the code: the park's state is cited to a line that requeues, the quoted sentence is not the one `renderDecision` renders, constant `detail` is named on a record that has no such field, and a retry's remedy is chosen from two options one of which the note's own invariant 5 rules out. Worse than any single citation, the model is missing an actor: `settleTasks` already retries a failed `running` row automatically, and the note's third invariant is true only because the driver happens to run first.

Minimum for acceptance: notes 1 to 5 fixed in the text, invariant 3 rewarranted on the pass order plus a sweep rule, and one decision on the retry's id. Notes 6 to 10 are corrections of claims, not of design, and can be folded in without reopening the shape. The draft's last section should then keep only what is still genuinely open: `data-run` against a fifth mark, and the chip's word.
