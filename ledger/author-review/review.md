# Rejection at visit 1: six notes

**Status:** review/1, `author-review-revise` review stage, visit 1, written in this tree at `e458cc44`. The manuscript is read at `9fd2e0f5` (`ledger/author-review/manuscript.md`). **Rejected:** six defects, each with its sentence, its defect and the fix it needs. Nothing in the manuscript was edited.

**What the rejection rests on.** The four focused files re-run here answer `tests 25, pass 25, fail 0`, so section 6's count is right. The notes below are about sentences this tree's code or the live record contradicts. I read `~/.wag/state/pipeline-bundle.json` (the bundle the panel is driving this round on) beside `pipeline-bundle.seed.json`, and I walked `enterStage` with the round's four edges to check the record's counters.

## Note 1 - the crossings transcript contradicts the count two lines above it

**Sentence.** "Measured today by walking the SHIPPED document through the real `nextStageOf`, one call per step, with `visits` and `crossings` kept on the record as the driver keeps them, and the verdict file written into a scratch tree between the review steps:" and the block's last line, "visits {"author":2,"review":2,"revise":1}  crossings {"H-02":1}".

**Defect.** The driver charges a crossing for every handoff it takes, not only the loop: `moveTo` hands the edge to `enterStage` (`lib/task-pipeline-drive.js:1098`, and the write at `:1107`), and `enterStage` increments `crossings[edge]` for any edge with a `via` (`lib/task-pipeline.js:533-537`). The record after this walk therefore reads `{"H-01":2,"H-02":1,"H-03":1}`, which is what section 2 states two lines above the block. The transcript's H-02-only object is a loop-only count, so "as the driver keeps them" is false of the line it introduces. Entering review, author, review and revise with `via` H-01, H-02, H-01 and H-03 on a fresh record gives exactly the three-key object.

**Fix.** Print `crossings {"H-01":2,"H-02":1,"H-03":1}` in the transcript; or, if the script really counted loop crossings only, say that and drop "as the driver keeps them".

## Note 2 - claim 3 leaves the note half of G1 with no field

**Sentence.** "**One caveat the acceptance has to accept.** The decision path is ONE fixed path, so the accept overwrites the reject; the two records never coexist on disk. What preserves the reject is its stage run's decision and `review#1`'s commit, which is also what the assembly picks. "On the round before" is therefore read off the ledger and the commit graph, not off `verdict.json`." and, in section 5, "Whether that is enough for an acceptance that says G1 records the notes is the one question this manuscript does not settle: a machine check would need the review artifact to be read for an open note, and nothing in this tree does that."

**Defect.** The acceptance item has two halves, and the second one is the note: the reject carries a note, the accept leaves none open. The claim proves only the outcome word and the path. The record does carry the note half: each review stage run's `artifact` pin (`stageRuns[].artifact.id/path/commit/blob/sha256`, read by `writerArtifactOf`, `lib/task-pipeline-drive.js:412-419`) fixes the exact `review.md` that was rejected and the exact one that was accepted; `review#1`'s pin resolves to the text carrying the rejection note, `review#2`'s to one acceptance line with no note. Section 5 is right that `refuses_when` is prose nothing reads, but that makes the artifact pin the field that answers the question, not a reason to leave it unsettled.

**Fix.** Add the review stage run's `artifact` pin, by commit and path, to claim 3 as the proof of "the reject with its note" and "the accept with no note open", and say the two review.md texts are read at their pins rather than from `verdict.json`.

## Note 3 - the "revise before an acceptance" lookalike is a record the document cannot produce

**Sentence.** "| revise before an acceptance | `revise#1` with `via: "H-02"`, or a `revise` entry after a reject | ..."

**Defect.** H-02 runs from `review` to `author`, so no revise entry can carry `via: "H-02"`. The defect the row exists to catch is the one its own why cell describes: a document without `routes` takes the kind order, so the sequence edge H-03 is taken and a reject lands on `revise`. The record to look for is `revise#1` with `via: "H-03"` beside a review decision or a verdict reading reject - not H-02.

**Fix.** Replace the lookalike with `revise#1` carrying `via: "H-03"` while the review stage run's decision (or `verdict.json`) reads reject.

## Note 4 - the third-visit row's why answers a different record than its falsifier

**Sentence.** "| a third author visit | `visits.author: 3` in a round that recorded one rejection | `cap: "2 rejects"` reads as 2 (`:164-172`), and the third crossing is refused as `pipeline-cap` with `used: 2, limit: 2` (`:1073-1086`). The arithmetic matters: a cap of two crossings permits author visits 1, 2 and 3, so the cap alone does not bound this round to two - the round's own one rejection does. |"

**Defect.** A third author visit is the second crossing of H-02, so it sits inside a cap of two and the cap does not refuse it; the refusal named (`used: 2, limit: 2`) is the third reject, which is a fourth author visit. The row's falsifier and its why are therefore two different records, and the last sentence's "the round's own one rejection does" never says what the record would look like: two H-02 crossings with one reject behind them.

**Fix.** Put the third visit's evidence in the row (crossings.H-02 2 beside a single reject decision, a crossing with no verdict behind it), and put the cap's refusal on the third reject, the fourth visit, at `used: 2, limit: 2`.

## Note 5 - "declares kind file" is true of the seed, false of the live bundle

**Sentence.** "The mechanism is the artifact kind: every stage of this document declares kind `file`, and a stage that does not land as a pull request is finished by the driver itself..." and the section 1 table's "kind `file`" on all three rows.

**Defect.** `pipeline-bundle.seed.json` states `kind: "file"` on the three artifacts, but the reader's live bundle - `~/.wag/state/pipeline-bundle.json`, the same file section 1 reads for `G1.routes`, and the one the panel is driving this round on - states no kind on any of them. The panel's stage card for this round reads "kind unstated" for review-notes, and the author's own card read the same for the manuscript. The claim's conclusion survives, because `landsAsPr` acts on exactly one word, `pr` (`lib/task-pipeline-drive.js:154`), so an unstated kind takes the same local finish; but the manuscript reads the seed for the kind and the live bundle for the routes without saying the two differ.

**Fix.** Say both: the seed declares `file`; the live bundle states none; and `landsAsPr` treats anything but `pr`, unstated included, as the local finish the claim describes.

## Note 6 - three citations do not point at the code they name

**Sentence.** "`via` is written by `moveTo` when the row moves (`:1094-1100`)." "The plan is the settled runs that carry a commit, in visit order and then by stage position (`assemblyPlanOf`)..." "`verifyRound` requires every path a picked stage changed to be at HEAD with that stage's blob, or absent when the stage deleted it (`lib/pipeline-assembly.js:287-298`)."

**Defect.** The `via` write is at `lib/task-pipeline-drive.js:1107`; `:1094-1100` is `moveTo`'s signature and its `enterStage` call, and `enterStage` does not store `via`. The visit-then-position sort is `assemblyOrder`'s (`lib/pipeline-assembly.js:112-124`); `assemblyPlanOf` (`lib/task-pipeline-drive.js:1263-1300`) builds its plan in ledger order and leaves the sort to the assembler. And `verifyRound`'s rule is at `lib/pipeline-assembly.js:163-175`; `:287-298` is the call and the `verified: checked.ok` record it writes.

**Fix.** Cite `:1105-1107` for the `via` write, `lib/pipeline-assembly.js:112-124` for the order with `assemblyPlanOf` named only as the plan's builder, and `lib/pipeline-assembly.js:163-175` for `verifyRound`.

Accepted: nothing. This is the whole count: six defects. The verdict is `reject`, and H-02 carries these notes back to the author.
