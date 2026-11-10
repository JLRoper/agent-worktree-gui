# The critique: one note, and the cap is what it is about

**Status:** critique, ping-pong round 70, stage 2 of 2 (critique, visit 1). Reads `ledger/ping-pong/draft.md` (494 words) at `d27bfc8d`, against `lib/task-pipeline-drive.js` and `lib/task-pipeline.js` at `1c5c53c7`. One note, blocking. The verdict is last. I have not touched the draft.

Open notes: 1

## Blocking

**1. The cap counts crossings of H-02, not the drafter's visits.**
*Sentence:* "H-02 carries `cap: \"3 rounds\"`. The cap counts the drafter's visits: a fourth draft visit is refused, and the row parks at the edge with the notes standing as the verdict."

The counter is `pipelineRun.crossings[<edge id>]`, and it is charged by `enterStage` every time an edge is taken: `next.crossings = { ...crossings, [edge]: (Number(crossings[edge]) || 0) + 1 }` (`lib/task-pipeline.js:534-537`, called from `moveTo` at `lib/task-pipeline-drive.js:1094-1101`). The cap itself is read from the edge's own sentence and compared against that count: `const used = Number(run.crossings?.[leaving.id]) || 0` and `if (used + 1 > cap.limit)` (`lib/task-pipeline-drive.js:1050-1051`, `:1073-1085`).

So three rounds means three CROSSINGS of H-02, and a crossing is what a `revise` verdict asks for. With the shipped cap of 3 the walk reaches draft visits 1, 2, 3 and 4 - the fourth draft visit is made, not refused - and the row parks only when a fourth `revise` verdict asks for a fourth crossing. The note's own sentence would park the row one visit early, and it borrows the word "visits" for a counter the code keeps in crossings, which is exactly the confusion the cap park's sentence has to avoid (`:1084` prints "used of limit" for that reason).

*Fix:* say the cap is three crossings of H-02, that each `revise` verdict asks for one, and that the park happens when a fourth `revise` arrives with three already charged (`used 3 of 3`, `used + 1 > 3`). Keep the visits as a separate fact, read from `visits`, because a cap park names both.

## Verdict

**Not accepted in this round.** One note is open, and the draft has not been rewritten against it. The rest of the note survives contact with the code: the two artifacts, the two handoffs, G1's two outcomes and its per-round record, and the assembly's verification are described the way the modules implement them. The cap paragraph is the one sentence a reader would act on and get wrong.

The record for this round is `ledger/ping-pong/verdict-r1.json`, outcome `revise`, which routes to H-02 and is the next round's brief.
