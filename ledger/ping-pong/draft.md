# One ping-pong round, from the draft to the verdict

**Status:** design note, ping-pong round 70, stage 1 of 2 (draft, visit 2). Rewritten against the critic's round 1 note at `ledger/ping-pong/critique.md` (`9888b9bc`), which was read as this visit's brief. Code read at `1c5c53c7`.

**The question.** Two stages hand one piece of work back and forth. What exactly does each stage owe the next one, what does the gate between them decide, and what stops the back-and-forth before it circles for ever?

## The two stages and what each writes

The drafter writes `ledger/ping-pong/draft.md`: the piece itself, in one pass, with a closing line naming what the drafter is unsure of. The artifact is declared by the stage, so a draft that is not in the tree is a park (`pipeline-artifact`), not a stage that quietly moved on.

The critic reads that file and writes `ledger/ping-pong/critique.md`: one note per defect, each naming the sentence, the defect and the fix it needs. The critic does not rewrite the draft; its notes ARE the next round's brief. That is the whole point of the shape: the notes travel as an artifact, so a later draft visit is handed a file with a hash, not a memory of a conversation.

## The two handoffs

- **H-01, draft to critique, sequence.** The draft is the critic's only input. On the first visit the critic is handed nothing else.
- **H-02, critique to draft, loop, capped at 3 rounds.** The notes are the next round's brief. A second draft visit is a rewrite against those notes, and a note the drafter disagrees with is answered in the draft, not ignored.

## The gate

**G1, after critique, artifact `critique-notes`.** It refuses when "a note is open and the draft was not rewritten against it". The critic writes the decision record the gate declares, `ledger/ping-pong/verdict-r<round>.json`, with one of two outcomes: `revise` routes to H-02, `accept` routes to nothing and the pipeline ends. The round is the visit the gate is asked in, so round 2's record is `verdict-r2.json` and round 1's record can never answer round 2.

## The cap (rewritten against note 1)

H-02 carries `cap: "3 rounds"`, and the counter it bounds is `pipelineRun.crossings["H-02"]`, not the drafter's visits. `enterStage` charges the edge every time it is taken (`lib/task-pipeline.js:534-537`, reached from `moveTo` at `lib/task-pipeline-drive.js:1094-1101`), and the cap is compared against that count: `const used = Number(run.crossings?.[leaving.id]) || 0`, then `if (used + 1 > cap.limit)` (`lib/task-pipeline-drive.js:1050-1051`, `:1073-1085`).

So three rounds is three CROSSINGS of H-02, and each `revise` verdict asks for one. With the shipped cap the walk makes draft visits 1, 2, 3 and 4 - the fourth draft visit is made, not refused - and the row parks when a fourth `revise` arrives with three crossings already charged (`used 3 of 3`, `used + 1 > 3`). The park's sentence prints both numbers, which is why the count is kept in crossings and the visits are reported beside it (`:1084`).

## The assembly

Each stage of a round commits in its own tree, cut at the round's frozen parent. When the pipeline is over, the stage commits are picked in visit order onto the round's parent branch, and the assembly is verified: for every path a picked stage changed, the branch carries that stage's blob.

## Unsure

Nothing is left open from round 1: note 1 is answered in the cap section above. What this note still does not decide is whether a cap park should also carry the verdict that asked for the refused crossing; the driver writes `visits` and `verdict` onto the cap fact (`:2194-2199`), so the fact is already there, and the question is only whether the note should promise it to the reader.
