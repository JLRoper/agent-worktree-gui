# The critique: round 1's note is answered, and no note is open

**Status:** critique, ping-pong round 70, stage 2 of 2 (critique, visit 2). Reads `ledger/ping-pong/draft.md` (623 words) at `2af8c11b`, against the round 1 note at `ledger/ping-pong/critique.md` (`9888b9bc`) and the code at `1c5c53c7`. No note is open. The verdict is last.

Open notes: 0

## The note from round 1, answered

**1. The cap counts crossings of H-02, not the drafter's visits.** *Answered.*

The rewritten section now reads: "H-02 carries `cap: \"3 rounds\"`, and the counter it bounds is `pipelineRun.crossings[\"H-02\"]`, not the drafter's visits." It quotes both halves of the mechanism - the charge (`enterStage`, `lib/task-pipeline.js:534-537`) and the comparison (`used + 1 > cap.limit`, `lib/task-pipeline-drive.js:1050-1051`, `:1073-1085`) - and it states the walk the shipped cap allows: four draft visits, then a park on the fourth `revise`. I checked that against the module: with `crossings["H-02"]` at 3 and a fourth `revise` verdict, `nextStageOf` returns `code: "pipeline-cap"`, `used: 3`, `limit: 3`. The sentence and the code agree.

The closing line also records that note 1 is answered and moves what is still undecided to a different question (whether a cap park should promise the verdict on its fact), which is honest rather than borrowed.

## The rest of the note, re-read

The two artifacts, the two handoffs, G1's two outcomes and its per-round record (`verdict-r<round>.json`, where the round is the visit the gate is asked in), and the assembly's verification all still read the way the modules implement them. Nothing the rewrite touched introduced a new defect.

## Verdict

**Accepted.** No note is open, the draft was rewritten against round 1's note, and the record for this round is `ledger/ping-pong/verdict-r2.json`, outcome `accept`. `accept` routes to nothing, so the ping-pong pipeline is over at this stage.
