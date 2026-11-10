# One ping-pong round, from the draft to the verdict

**Status:** design note, ping-pong round 70, stage 1 of 2 (draft, visit 1). Written against `lib/task-pipeline-drive.js` and `lib/task-pipeline.js` at `1c5c53c7`. It states what one round hands forward and where the round stops.

**The question.** Two stages hand one piece of work back and forth. What exactly does each stage owe the next one, what does the gate between them decide, and what stops the back-and-forth before it circles for ever?

## The two stages and what each writes

The drafter writes `ledger/ping-pong/draft.md`: the piece itself, in one pass, with a closing line naming what the drafter is unsure of. The artifact is declared by the stage, so a draft that is not in the tree is a park (`pipeline-artifact`), not a stage that quietly moved on.

The critic reads that file and writes `ledger/ping-pong/critique.md`: one note per defect, each naming the sentence, the defect and the fix it needs. The critic does not rewrite the draft; its notes ARE the next round's brief. That is the whole point of the shape: the notes travel as an artifact, so a later draft visit is handed a file with a hash, not a memory of a conversation.

## The two handoffs

- **H-01, draft to critique, sequence.** The draft is the critic's only input. On the first visit the critic is handed nothing else.
- **H-02, critique to draft, loop, capped at 3 rounds.** The notes are the next round's brief. A second draft visit is a rewrite against those notes, and a note the drafter disagrees with is answered in the draft, not ignored.

## The gate

**G1, after critique, artifact `critique-notes`.** It refuses when "a note is open and the draft was not rewritten against it". The critic writes the decision record the gate declares, `ledger/ping-pong/verdict-r<round>.json`, with one of two outcomes: `revise` routes to H-02, `accept` routes to nothing and the pipeline ends. The round is the visit the gate is asked in, so round 2's record is `verdict-r2.json` and round 1's record can never answer round 2.

## The cap

H-02 carries `cap: "3 rounds"`. The cap counts the drafter's visits: a fourth draft visit is refused, and the row parks at the edge with the notes standing as the verdict. That is what keeps a round from circling for ever: three draft visits, then a person decides.

## The assembly

Each stage of a round commits in its own tree, cut at the round's frozen parent. When the pipeline is over, the stage commits are picked in visit order onto the round's parent branch, and the assembly is verified: for every path a picked stage changed, the branch carries that stage's blob.

## Unsure

Whether the cap should be read as three draft visits or as three crossings of H-02 is the one thing in this note I have not checked against the code; the sentence above reads the cap as visits.
