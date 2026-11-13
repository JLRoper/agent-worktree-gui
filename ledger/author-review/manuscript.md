# The author-review-revise round, and the field that proves each of its six claims

**Status:** manuscript/1, `author-review-revise` author stage, visit 2, written in this tree on top of visit 1 at
`9fd2e0f5`, answering the six notes in the rejection at `785aa4cb` (`ledger/author-review/review.md`). Section 8 answers
each note in one line; nothing the notes do not name is rewritten. Every line reference is this tree's. **Local only:**
nothing here is pushed and no pull request is opened, and this tree has no upstream
(`git config --get branch.<branch>.remote` answers nothing).

**The question.** The brief asks for one local round of this document: a rejection that returns the manuscript to the
author with the notes, then an acceptance that hands the notes to the reviser. What must the record show, field by
field, if that happened - and what would it show if it did not?

## 1. The document

| stage | artifact | kind | writer | way out |
|---|---|---|---|---|
| `author` | `manuscript` at `ledger/author-review/manuscript.md` | `file` in the seed; unstated in the live bundle | author | `H-01`, sequence, to `review` |
| `review` | `review-notes` at `ledger/author-review/review.md` | `file` in the seed; unstated in the live bundle | reviewer | `H-02`, loop, to `author`, cap `2 rejects`; `H-03`, sequence, to `revise` |
| `revise` | `revision` at `ledger/author-review/revision.md` | `file` in the seed; unstated in the live bundle | reviser | none, this is the last stage |

`kind` is the one field the two documents disagree on: `pipeline-bundle.seed.json` states `file` on all three
artifacts, and the live bundle at `~/.wag/state/pipeline-bundle.json` states none, so the panel's own cards for this
round read "kind unstated". Claim 6 says why the ending is the same either way.

`G1` sits after `review` and declares a decision record at `ledger/author-review/verdict.json` (schema `verdict/1`,
writer reviewer, outcomes `accept` and `reject`). Its routes are the whole reason a rejection can go backwards:

```json
"routes": { "accept": "H-03", "reject": "H-02" }
```

Two things about that map are worth stating before the walk, because the round is worthless without them.

- **The reader's live bundle carries it.** Read today, `~/.wag/state/pipeline-bundle.json`, pipeline
  `author-review-revise`, gate `G1`: `routes` is present and names `accept -> H-03`, `reject -> H-02`. The 2026-11-07
  walk found a copy that lacked the map, and a rejection on it advanced the manuscript to `revise` instead of returning
  it. That state is gone here.
- **The loader now refuses the document that caused it.** `lib/pipeline-bundle.js:202-214`: a gate that declares
  outcomes, carries no `routes`, and follows a stage with more than one way out is refused with the ways out named.
  The old drift cannot load silently again.

## 2. The round, as five stage runs

| run | enters by | what makes it that entry |
|---|---|---|
| `author#1` | the assignment | `pipelineRun.via` is null; nothing has been produced yet |
| `review#1` | `H-01` | the sequence edge out of `author` |
| `author#2` | `H-02` | a routed `reject`; `crossings["H-02"]` becomes 1 |
| `review#2` | `H-01` | the sequence edge out of the second author visit |
| `revise#1` | `H-03` | a routed `accept`; `crossings["H-02"]` stays 1 |

Crossings for the round: `H-01 2, H-02 1, H-03 1`. Visits: `{"author": 2, "review": 2, "revise": 1}`.

Measured today by walking the SHIPPED document through the real `nextStageOf`, one call per step, with `visits` and
`crossings` kept on the record as the driver keeps them - every handoff taken is charged, not only the loop - and the
verdict file written into a scratch tree between the review steps:

```
author -> review H-01
review -> author H-02 [reject]
author -> review H-01
review -> revise H-03 [accept]
done
visits {"author":2,"review":2,"revise":1}  crossings {"H-01":2,"H-02":1,"H-03":1}
```

## 3. Six claims, and the field that proves each

**1. The reject path is a second author visit carrying `review-notes` as its input.**
The proof is the `inputs` manifest on `pipelineRun.stageRuns[]` entry `author-review-revise/author#2`: one entry with
`artifact: "review-notes"`, `edge: "H-02"`, `via: "handoff"`.
The mechanism is worth knowing, because the author stage declares no reads at all (`inputs.read` is `[]` in the seed), so
nothing in the document asks for the notes: the arriving edge's artifact is manifest entry 1 whether the stage declared
it or not (`lib/task-pipeline-drive.js:545-562`). The arriving edge is read from the RECORD's `via` and never guessed
from the graph (`:528-531`), which is why visit 1's manifest is empty instead of carrying a handoff nobody had produced.
`via` is written by `moveTo` when the row moves (`:1105-1107`).
Measured: `inputManifest` with stage `author`, visit 2, `via: "H-02"` answers `[{artifact: "review-notes", edge: "H-02",
via: "handoff", present: true}, {artifact: "manuscript", edge: null, via: "earlier", present: true}]`; the same call at
visit 1 answers `[]`. The second entry is the earlier visit's own artifact, added only for a visit above 1
(`:582-600`).

**2. The accept path is `revise` visited exactly once, with `review-notes` as its input.**
The proof is `stageRuns[]` entry `revise#1` with the record's `via` at `H-03` and an inputs manifest of
`{artifact: "review-notes", edge: "H-03", via: "handoff"}`, plus `visits.revise === 1`.
The mechanism is the ordering: a routed verdict REPLACES the edge the driver would have taken, and it is read before the
loop's cap (`:999-1042`). An accepted round therefore does not spend a crossing, and `H-03` - not the kind-order
sequence - is the edge the row crosses.

**3. G1 records the reject with its note on the round before, and the accept with no note open.**
The proof, per park, is the review stage run's `decision`: `trigger: "gate-record"`, `fact: {kind: "gate", gate: "G1",
path: ..., present: true, stage: "review"}` (`:2048-2057`), together with the commit that carried the file.
The note half is the review stage run's `artifact` pin, not `verdict.json`. Every settle records `stageRuns[].artifact`
as `{id, path, commit, blob, blobSha256, sha256, present}`, and `writerArtifactOf` (`lib/task-pipeline-drive.js:412-419`)
is the reader a handoff is resolved from. `review#1`'s pin names the `review.md` at `785aa4cb` that carries the six
rejection notes; `review#2`'s pin names the one acceptance line with no note open. The two texts are read at their pins
(`git show <pin.commit>:ledger/author-review/review.md`), because `verdict.json` is ONE fixed path: the accept overwrites
the reject there, and the file after the round carries only `{"outcome": "accept"}`. "On the round before" is therefore
read off the two artifact pins and the commit graph, not off `verdict.json`.

**4. Every stage run holds one commit in its own tree.**
The proof is `stageRuns[].commit`, the tree's full HEAD at settle, and `stageRuns[].tree.path`. Every stage child is cut
from the round's branch tip, never from `origin/main` as it stands now (`docs/task-pipeline.md:303-307`), so one stage's
commit is reachable from the round's parent by exactly the picks. The check is mechanical:
`git log --oneline <round.sha>..<stage tree>` answers one commit for each of the five runs.

**5. The round assembles: one entry, `verified: true`.**
The proof is `pipelineRun.assembly = {commit, base, branch, path, verified, stages[], skipped[]}`. The plan is the
settled runs that carry a commit, built in ledger order by `assemblyPlanOf` (`lib/task-pipeline-drive.js:1263-1300`);
the visit-then-position order is the assembler's `assemblyOrder` (`lib/pipeline-assembly.js:112-124`). The picks happen
in `round.parentPath`, which is still at `round.sha`; and `verified` is not a claim but a re-read - `verifyRound`
requires every path a picked stage changed to be at HEAD with that stage's blob, or absent when the stage deleted it
(`lib/pipeline-assembly.js:163-175`). One entry, not two: a second assembly for the same frozen parent is refused
(`lib/task-pipeline-drive.js:1306-1316`).

**6. The row settles done.**
The proof is `state: "done"` with `waitingFor` cleared and the ending decision on the settled run. The mechanism is the
artifact kind, read as ONE word: the seed declares `file` on all three artifacts, the live bundle states none, and
`landsAsPr` treats anything but `pr` - `file`, a document, unstated - as the local finish (`lib/task-pipeline-drive.js:154`,
`:141-145`). So a local-only round reaches `done` with no PR, finished by the driver itself after the assembly pass
(`:2319`), never by the landing rule - which is what a `pr` stage is left to (`:2320`). That is the one place this
document's end differs from a pipeline whose last stage declares `pr`.

## 4. What must not be there

| falsifier | what it would look like | why the document forbids it |
|---|---|---|
| a reject with no note | a `reject` record and no note in `review.md` | `G1.refuses_when` says "a rejection carries no note, or an acceptance leaves a note open" - and nothing enforces that field. See section 5. |
| revise before an acceptance | `revise#1` with `via: "H-03"` while the review stage run's decision (or `verdict.json`) reads reject | `revise` is reachable only through a routed accept (`:1016-1041`). A gate with no `routes` takes the kind order, so the sequence edge `H-03` is crossed with no acceptance behind it and a reject lands on `revise`, which is the 2026-11-07 measurement; the loader now refuses that document. |
| a third author visit | `visits.author: 3` with `crossings["H-02"]: 2` and only ONE reject decision behind the two | the cap bounds rejections, not visits. Two `H-02` crossings sit inside `cap: "2 rejects"`, so the record to catch is the second crossing with no reject behind it: a round with one rejection permits author visits 1 and 2 only. |
| a fourth author visit, the third reject | `pipeline-cap` with `used: 2, limit: 2` on `H-02` | `cap: "2 rejects"` reads as 2 (`:171-179`), and the third crossing is refused (`:1073-1086`). The record stops at `visits {"author": 3, "review": 3}`: the refusal is the third reject, so the fourth author visit is the one never entered. |
| an assembly entry that does not verify | `verified: false` beside `mismatches[]` | `verified` is `verifyRound`'s answer; a false one names the paths that did not match, and the row's landing branch is then not the round. |
| any remote write | a pushed branch, a PR, an `origin` entry in the tree | this tree has no upstream; the round is local by the brief and nothing in it pushes. |

The cap was measured with the same walk: a third `reject` written at `review#3`, with `crossings {"H-01": 3, "H-02": 2}`
behind it, makes `nextStageOf` answer `code: "pipeline-cap", used: 2, limit: 2` and the record stops at
`visits {"author": 3, "review": 3}`. That refused entry is the fourth author visit; the two `H-02` crossings already
taken are author visits 2 and 3.

## 5. Convention, not code: the one thing this manuscript leaves open

The note-carrying half of `G1` is a reviewer's discipline, not a panel check.

- `refuses_when` is prose carried by the bundle, and it is drawn rather than read: `tools/render-pipeline-map.mjs:140`
  carries it onto the pipeline map as `refusesWhen`, and nothing in `lib/`, `routes/` or `server.js` consults it.
  `lib/pipeline-bundle.js` maps only `verified_by` (`:364`), and the driver's machine check is the record's presence
  plus a routable outcome (`:987-1015`). A rejection that named no note would still route.
- The verdict is committed by the reviewer. Nothing requires a stage tree to be clean at settle - the driver is pure and
  takes `dirty` from the assistant's facts (`:640-658`, `:1676-1678`). A reviewer that writes `verdict.json` after its
  run ends and does not commit it leaves the routing record in no stage's commit, so the assembly cannot carry it and
  claim 3's "on the round before" survives only on the stage run - its decision and its artifact pin.

The round's instructions require every stage to commit, so the walk satisfies both by convention and the ledger reads
correctly. The note half is still answered by the record, not by `refuses_when`: the review stage run's `artifact` pin
fixes the `review.md` each decision was made on (claim 3), so an accepted review whose pin carries an open note is
visible to a reader even though no check refuses it. What remains open is enforcement: a rejection that named no note
would still route, and nothing in this tree reads the review artifact for one.

## 6. What was measured here, and what was read

Measured in this tree today:

- `node --test test/task-pipeline-inputs.test.js test/pipeline-assembly.test.js test/task-pipeline-verdict.test.js test/task-pipeline-walk.test.js`
  answered `tests 25, pass 25, fail 0` in 26.9s, including `author-review-revise crosses a sequence, a gate-routed loop
  and a finish, with no hand-start` (4.7s), which walks two rejects inside the cap, the accept onto `revise`, the
  `revise` start and a `done` row (`test/task-pipeline-walk.test.js:276-332`).
- The document walk in section 2 and the manifests in section 3, re-measured at visit 2 from a throwaway script against
  this tree's `lib/task-pipeline-drive.js` and the shipped `pipeline-bundle.seed.json`.
- The reader's live bundle's `G1.routes` and its missing `kind` fields, read from `~/.wag/state/pipeline-bundle.json`.

Read from code, not observed: the cherry-pick and the assembly record (claim 5) and the ordering of assembly ahead of
`finish` (claim 6). No panel ran in this stage, so those are the code's word plus `test/pipeline-assembly.test.js`, not
a round this author watched.

## 7. Reproduce

```bash
git -C <tree> rev-parse --short HEAD
node --test test/task-pipeline-inputs.test.js test/pipeline-assembly.test.js test/task-pipeline-verdict.test.js test/task-pipeline-walk.test.js
node -e "const os=require('os'),path=require('path'),p=require(path.join(os.homedir(),'.wag/state/pipeline-bundle.json')).pipelines.find(x=>x.id==='author-review-revise');console.log(JSON.stringify(p.gates[0].decision.routes))"
```

The walk and the manifests are reproducible from `nextStageOf` and `inputManifest` alone: no tree, no panel and no
network are needed beyond a scratch directory holding `ledger/author-review/verdict.json` and the two artifact files.

## 8. The six notes, answered at visit 2

1. The transcript now prints `crossings {"H-01":2,"H-02":1,"H-03":1}`, re-measured with the driver's own `enterStage`, which charges every handoff taken.
2. Claim 3 is proved by the review stage runs' `artifact` pins, by commit and path, and reads both `review.md` texts at their pins instead of from `verdict.json`.
3. The "revise before an acceptance" lookalike is `revise#1` with `via: "H-03"` beside a reject decision, never `H-02`.
4. The third-visit row now names a second `H-02` crossing with one reject behind it; the cap's refusal sits on the third reject, the fourth visit, at `used: 2, limit: 2`.
5. Section 1 and claim 6 say both: the seed declares `file`, the live bundle states no kind, and `landsAsPr` acts only on `pr`.
6. The three citations are corrected to `:1105-1107`, `lib/pipeline-assembly.js:112-124` and `lib/pipeline-assembly.js:163-175`.
