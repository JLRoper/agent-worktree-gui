# Round 70: the ping-pong pipeline walked local only

**What this is.** Task row 70 of `agent-worktree-gui`, run as written and local only: one `ping-pong` round through draft, critique, a loop back to draft, and a closing verdict. No push, no pull request, no remote write of any kind. Every number below is in `walk-evidence.json`, produced by the repository's own modules, and every stage commit is in its own tree on `wtgui/run-row-70-exactly-as-written-local-only-stage-*`.

**The row as written.** "Local pipeline walk: ping-pong with one loop round and a closing verdict." Acceptance: the panel's pipeline drives draft to critique, the critique opens exactly one note, H-02 loops back and the second draft run rewrites the artifact against that note, the closing critique passes G1 with no note open, and the round assembles onto its parent tree with one entry that verifies.

## The round

| | |
|---|---|
| pipeline | `ping-pong` (13 pipelines in the panel's bundle) |
| bundle | `C:/Users/roper/.wag/state/pipeline-bundle.json`, sha256 `3c2c16b7dac43fd5` |
| round slug / tag | `run-row-70-exactly-as-written-local-only` / `19d782` |
| parent branch | `wtgui/run-row-70-exactly-as-written-local-only-19d782` (this tree) |
| frozen base | `1c5c53c7` (`origin/main`, "1.80.11 - the version this landing carries") |
| stages | 1 `draft` -> 2 `critique`, handoffs `H-01` (sequence) and `H-02` (loop, cap 3 rounds) |
| gate | `G1` "Verdict", after `critique`, artifact `critique-notes` |

## The four visits, one commit each

| visit | tree | commit | artifact | blob | words |
|---|---|---|---|---|---|
| draft 1 | `...-stage-1-draft-1de511` | `d27bfc8d` | `ledger/ping-pong/draft.md` | `2ebed22e` | 494 |
| critique 1 | `...-stage-2-critique-6635d7` | `9888b9bc` | `ledger/ping-pong/critique.md` (+ `verdict-r1.json`) | `52cbe921` | 410 |
| draft 2 | `...-stage-1-draft-676235` | `2af8c11b` | `ledger/ping-pong/draft.md` | `b0e00f40` | 623 |
| critique 2 | `...-stage-2-critique-59a317` | `966b3f5b` | `ledger/ping-pong/critique.md` (+ `verdict-r2.json`) | `7b5a1e0f` | 294 |

Each stage run made exactly one commit. The two loop visits sit on their own stage's previous visit (`2af8c11b` on `d27bfc8d`, `966b3f5b` on `9888b9bc`), which is the repair described under "The assembly" below; the first two are cut at the frozen base.

## What each gate read

The four answers are `nextStageOf(pipeline, pipelineRun, { worktree })` from `lib/task-pipeline-drive.js`, asked with the record the driver would hold at that step. Nothing here is a narration of the walk; it is the driver's own answer, written to `walk-evidence.json` as `reads`.

| after | the driver answered |
|---|---|
| draft 1 | `ok`, not done, next stage `critique` via `H-01` |
| critique 1 | `ok`, not done, next stage `draft` via `H-02`, with the verdict read from `verdict-r1.json`: `revise`, `ended: false` |
| draft 2 | `ok`, not done, next stage `critique` via `H-01` |
| critique 2 | `ok`, **done**, with the verdict read from `verdict-r2.json`: `accept`, `ended: true` |

## The record G1 declares, and the check it applies first

The bundle declares the decision record exactly: `id: ping-pong-verdict`, path `ledger/ping-pong/verdict-r{{round}}.json`, schema `verdict/1`, writer `critic`, outcomes `accept` and `revise`, routes `accept: null` (nowhere) and `revise: H-02`. Both critique visits wrote it: round 1 wrote `verdict-r1.json` (`outcome: revise`, one note open, routing to the loop), round 2 wrote `verdict-r2.json` (`outcome: accept`, no note open, routing nowhere). Path resolution is per round: round 1 resolves to `verdict-r1.json` (found), round 2 to `verdict-r2.json` (found), round 3 does not resolve at all (`found: false`), so a round can never borrow another's record.

**Which check applied first.** The code applies the record's ABSENCE before anything else, and that is the first check, not the revise route:

1. **The record must exist.** If it does not, the row parks on `DRIVE_FAULTS.GATE` - `pipeline-gate` - with the sentence, quoted verbatim from `lib/task-pipeline-drive.js`: `the code does not decide it, and the record has not been written`. Asked of a tree that holds `critique.md` and no record, the driver answers `ok: false`, `code: "pipeline-gate"`, and the reason grounds on `ledger/ping-pong/verdict-r1.json` (`walk-evidence.json`, `gate.firstCheck`). This is the check row 71 died on.
2. **The record's outcome must route.** Only once the record is read does the driver look up `routes[outcome]`, and a word the gate does not hold parks on `pipeline-verdict` with `the panel does not route a verdict the gate does not hold`. Round 1's `revise` routed to `H-02`, round 2's `accept` routed nowhere and ended the pipeline.
3. **The cap is applied after both.** The code says so in as many words - "Read here, before the cap" - and the reason is that a verdict which routes nowhere ends the pipeline and must not be charged a crossing on the way out.

The gate's note-open condition is **not** one of the driver's checks. The bundle document writes it as `refuses_when` on G1, "a note is open and the draft was not rewritten against it", but the loader does not keep the field: `gate.fields.droppedByLoader` is `["refuses_when", "verified_by"]` against the document's own key list, and no code in `lib/` reads `refuses_when` or an open-note count. It is the critic's condition, applied when the critic decides which outcome to write, which is why this round checks it against the artifacts rather than against the driver (`g1-check.mjs`, below).

`Open notes: 1`, and the verdict recorded `outcome: revise`, `accepted: false`, `draftRewritten: false` - the gate refused the draft as written.

## The note critique 1 opened

One note, blocking, in `ledger/ping-pong/critique.md` (`52cbe921`), against the draft's sentence that a fourth draft visit would be refused:

> The cap counts crossings of `H-02`, not the drafter's visits. `enterStage` charges the edge every time it is taken (`lib/task-pipeline.js:534-537`, from `moveTo` at `lib/task-pipeline-drive.js:1094-1101`), and the comparison is `used + 1 > cap.limit` against `run.crossings[leaving.id]` (`:1050-1051`, `:1073-1085`). Fix: say three crossings of `H-02`, and that the fourth draft visit is made.

`Open notes: 1`, and the verdict recorded `outcome: revise`, `accepted: false`, `draftRewritten: false` - the gate refused the draft as written.

## The rewrite that answers it

Draft visit 2 (`2af8c11b`) rewrote the cap section to the note's reading: the counter is `pipelineRun.crossings["H-02"]`, the charge and the comparison are quoted with their line numbers, and the walk the shipped cap allows is stated plainly - draft visits 1, 2, 3 and 4 are made, and the row parks when a fourth `revise` arrives with three crossings already charged. `draft.md` moved from blob `2ebed22e` to `b0e00f40` (494 to 623 words), and its closing line records that note 1 is answered.

## The loop counter

`H-02` was crossed **once**, against a cap of **3 rounds** (`capOf` gives `limit: 3`). `H-01` was crossed twice. The run's visit counts are `draft: 2`, `critique: 2`, and the crossings are `{ "H-01": 2, "H-02": 1 }` - the counter the cap compares is the crossing count, and the visits are reported beside it, which is exactly what the note said.

## G1 on the closing critique

`Open notes: 0` in `critique.md` (`7b5a1e0f`), and `verdict-r2.json` records `outcome: accept`, `accepted: true`, `draftRewritten: true`, `round: 2`. The driver's answer for the closing visit is `done: true`, so the pipeline ends at the accept and nothing routes on.

`g1-check.mjs` is G1's sentence made runnable, and it was run twice so the gate is shown to bite, not just to pass:

- on round 1's state (one note open, draft not rewritten): `pass: false`, `refused: true`, "a note is open (1) and the draft was not rewritten against it (blob 2ebed22e5611 at both visits), so G1 refuses" - exit 1 (`g1-round-1.json`)
- on the closing critique (no note open, draft rewritten `2ebed22e5611` -> `b0e00f40fa4d`): `pass: true` - exit 0 (`g1-round-2.json`)

## The assembly

The plan the driver offered for this round is all four visits, in visit order. Attempt 1 picked them the way the driver cuts every stage tree - each cut at the round's frozen parent - and the assembly **refused**:

> `code: pipeline-assembly-conflict` - "stage draft changes the path `ledger/ping-pong/draft.md`, and so did a stage before it (draft, critique) on the same lines - git cannot apply the later stage on top of the earlier one, so the branch was discarded"

That refusal is the finding of this round, and it is not an accident of this note's content: a loop visit rewrites the path the earlier visit wrote, and both diffs are measured from the same frozen base, so a cherry-pick of the second version onto the first always conflicts. The same-lines rule can only resolve a later stage that touched lines the earlier one did not. Verbatim record: `assembly-attempt-1.json`, including the two superseded commits (`722877c1`, `1fd2dc19`).

Attempt 2 is a person's resolution of that conflict, in favour of the later visit, as rule 3 says a shared path is resolved: the two loop visits were re-cut from their own stage's previous visit, so each commit's diff is that visit's own work and the branch can take it. The assembly then verified:

- `commit: cf3cd11c`, `base: 1c5c53c7`, **`verified: true`**, `mismatches: []`
- picks: `draft 1 d27bfc8d -> 9a959800`, `critique 1 9888b9bc -> e769574e`, `draft 2 2af8c11b -> 068e06eb`, `critique 2 966b3f5b -> cf3cd11c`
- for every path a picked stage changed (`draft.md`, `critique.md`, `verdict-r1.json`, `verdict-r2.json`) the branch carries that stage's blob

The parent branch's log is then: `cf3cd11c` (the assembly), `068e06eb`, `e769574e`, `9a959800`, over `1c5c53c7`.

## What the round found

1. **A ping-pong loop cannot assemble as cut.** Every stage tree is cut at the round's frozen parent, so a loop visit's commit is a full rewrite of a path an earlier visit wrote, and `assembleStages` refuses it. The driver would park the row `pipeline-assembly-conflict` on any real ping-pong round with a revise verdict.
2. Two ways out, for whoever owns the shape: cut a loop visit from its own stage's previous visit (what attempt 2 did, and what a revise verdict is asking for), or give the assembly a documented later-visit-wins pick for a path the same stage rewrote. The first is a one-line change to where a loop visit's tree is cut; the second changes a rule the assembly deliberately does not bend.
3. Smaller, already right: the cap counts crossings (the draft's second visit says so), G1's record is per round and cannot be answered by r1 twice, and an `accept` routes nowhere.
4. **The gate's refusal sentence is dead document.** `refuses_when` is written on G1 in the bundle and dropped by `normaliseGates`, so the driver never applies the note-open condition: the only thing that stops a bad draft is the critic writing `revise` in the record. A gate that means to refuse a state, rather than to accept a word, needs the field carried and a code path that reads it.
5. The first check is the record's presence, and it is a park, not a refusal: a critique stage that settles without writing `verdict-r<n>.json` dies on `pipeline-gate` with "the record has not been written" (row 71). Writing the record is not optional bookkeeping; it is the gate.

## Local only

No push, no pull request, no remote write. The round's branch `wtgui/run-row-70-exactly-as-written-local-only-19d782` has no upstream, and the stage branches were never pushed. The work is `cf3cd11c` plus this record in the parent tree, and `git status` in every tree is clean.

## State of the trees at the close

`git status` is clean in this tree and in the two loop-visit trees. The draft 1 tree is clean too, but its branch has moved: row 74 ("the decision record in place, and which check the gate runs first") was cut on top of this round's `d27bfc8d` and its own three commits now sit above it. `d27bfc8d` is still that chain's base and its blob `2ebed22e` is still readable, and the round's own record does not depend on the branch head: the four picks on this branch (`9a959800`, `e769574e`, `068e06eb`, `cf3cd11c`) carry the round, and the assembly at `cf3cd11c` is the branch that lands. No commit of this round was rewritten to make room for another row.

## Files here

- `walk.md` - this record
- `walk.html` - the same record as a page
- `walk-evidence.json` - the round, the four visits, the four driver reads, the gate, the cap, the assembly plan
- `assembly-result.json` - attempt 2's own result, `verified: true`
- `assembly-attempt-1.json` - attempt 1's refusal, verbatim
- `g1-round-1.json`, `g1-round-2.json` - the gate check's two runs
- `g1-check.mjs` - G1's sentence, runnable
