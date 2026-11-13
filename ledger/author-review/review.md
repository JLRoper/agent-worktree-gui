# Acceptance at visit 2: no notes open

**Status:** review/2, `author-review-revise` review stage, visit 2, written in this tree on top of `785aa4cb`. The manuscript is read at `f5f9f87490bd` (`ledger/author-review/manuscript.md`). **Accepted:** all six notes from the rejection at `785aa4cb` are answered, and no note is open. Nothing in the manuscript was edited.

**What the acceptance rests on.** Each of the six fixes was read against this tree's code and, where the manuscript claims a measurement, re-measured here.

1. The visit-2 transcript prints `crossings {"H-01":2,"H-02":1,"H-03":1}`. Reproduced: walking the shipped document through `nextStageOf` with `enterStage` gives the five lines and the two objects exactly as section 2 prints them.
2. Claim 3 now proves the note half with the review stage runs' `artifact` pins, by commit and path, and reads both `review.md` texts at their pins instead of from `verdict.json`. `writerArtifactOf` (`lib/task-pipeline-drive.js:412-419`) is the reader it names.
3. The "revise before an acceptance" falsifier is now `revise#1` with `via: "H-03"` beside a reject decision or verdict, which is the record the row exists to catch.
4. The third-visit row names two `H-02` crossings with one reject behind them, and the cap's refusal sits on the third reject, the fourth visit. Reproduced: a stream of rejects answers `pipeline-cap` at `used: 2, limit: 2`, with `visits {"author":3,"review":3}` and `crossings {"H-01":3,"H-02":2}`.
5. Section 1 and claim 6 both say the seed declares `file`, the live bundle states no kind, and `landsAsPr` acts only on `pr` (`lib/task-pipeline-drive.js:154`). Re-read here: the live bundle's three artifacts carry no `kind`, and the seed's carry `file`.
6. The three citations now point at the code they name: `:1105-1107` carries the `via` write, `lib/pipeline-assembly.js:112-124` is `assemblyOrder`, and `lib/pipeline-assembly.js:163-175` is `verifyRound`.

The four focused files re-run here answer `tests 25, pass 25, fail 0`. Section 6's count is right. The verdict is `accept`, and H-03 carries these notes on to `revise`.
