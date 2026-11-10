# How a pipelined task actually runs: one agent per stage, one tree per row, and a decision a person can read

**Status:** design, not built. Nothing in this document has been implemented; every claim about *today* is a
`file:line` read at `3295fce` (`package.json` 1.15.0, 2026-11-05), and every claim about *the design* is a decision
with its cost stated beside it.

**The question.** A queue row can carry `pipelineRun`, the driver moves it stage by stage, and each stage is started
as one worker. Three things are not answered anywhere yet: what a *stage run* is as a record, whose *tree* a stage
runs in when the pipeline comes back round, and what a person can read afterwards to see why the panel started or
parked at that stage rather than the other. This document answers those, in that order, and then lists what the
answer cannot do.

**The answer in one paragraph.** A pipeline is carried by one row, one tree and one artifact chain. The row's tree
is cut once — before any worker runs at all — and every later stage, including every pass round a loop, starts a
*new* agent in that *same* tree. Each entry into a stage is a *stage run* with an identity (`<pipeline>/<stage>#<visit>`)
and a small record on the queue row, so a second visit is distinguishable from the first, and so the drawing and the
driver read the same facts instead of inferring one from the other. A stage is handed the previous stage's artifact by
path and hash, never by summary, and the panel's park-or-start decision is written on the record as a named code plus a
structured fact — not only as a sentence in a log.

The current reader is [`docs/task-pipeline.md`](../task-pipeline.md), which describes what shipped. This is the next
document in that chain: it does not replace that file, and where it changes a rule that file states, it says so.

---

## 1. Where a row sits today, and how it got there

### 1.1 The field, and the second meaning it avoided

`lib/task-pipeline.js:30` fixes the field as `pipelineRun`, on purpose: the job record already has a `pipeline` key
meaning the *tree's* rung on the local → investigation → turnover ladder (`lib/pipelines.js`, `docs/pipelines.md` §1.2),
and two meanings on one key is how a card says "turnover" while a chip says "stage 4 of 13" about the same record
(`lib/task-pipeline.js:1-11`).

The record is three fields:

```json
{ "pipelineRun": { "pipeline": "poc-to-uat", "stage": "S3", "enteredAt": "2026-11-03T15:00:00.000Z" } }
```

and the driver has since added four more keys to it (`crossings`, `startingAt`, `waitingFor`, and the start marker's
companion), all for one reason: the queue file is the only durable place a pass can leave a fact for the next pass
(`lib/task-pipeline-drive.js:77-87`).

### 1.2 Three answers, and the one that must never be folded into another

`resolveTaskPipeline` (`lib/task-pipeline.js:107-170`) returns exactly one of:

| mode | when | what a card reads |
|---|---|---|
| `assistant-decides` | `pipelineRun` is null | no stage; the assistant chooses what the row does |
| `pipeline` | pipeline and stage both held by the bundle, `enteredAt` a UTC instant | title, stage, `position of count`, elapsed from the stamp |
| `unresolved` | a pipeline or stage the bundle does not hold, a record that is not an assignment, no bundle, or a bad stamp | the reason, and the sentence that this is *not* the default path |

The distinction that matters for execution: **`unresolved` is a fact about a written record, not an empty state.**
Falling back to `assistant-decides` on a broken assignment would drop the pipeline a reader chose while the card looked
normal (`lib/task-pipeline.js:15-18`). Time is stored, never timed: `elapsedInStage` is a function of `enteredAt` and a
`now` the caller passes (`lib/task-pipeline.js:53-70`), so a test can fix the clock.

### 1.3 How a row gets there

`lib/task-pipeline-assign.js` is the write side, and it has three operations:

- `pipelineCatalogue(source)` (`:68-100`) — what a control may offer, from the same bundle the window resolves against,
  including each pipeline's gates and handoffs so a reader drawing the sequence reads one answer, not two.
- `assignTaskPipeline(tasks, id, {pipeline, stage, source, at})` (`:104-157`) — one record, one stamp. Two rules bite:
  a blank pipeline or stage is refused rather than defaulted (`:121-142`), and **only movement stamps**: pressing apply
  twice on an unchanged, readable record is `changed: false` and leaves `enteredAt` alone (`:144-151`). The exception is
  a stamp that does not compute — that is the repair path, and it is rewritten.
- `clearTaskPipeline(tasks, id)` (`:162-171`) — `pipelineRun: null`, written rather than deleted, so a reader of the
  file can see the choice was cleared rather than never made.

Every refusal is named (`ASSIGN_FAULTS`, `:30-36`) and names what the bundle does hold, so the control prints a
sentence instead of a 500.

### 1.4 What the driver already does

`driveTaskPipelines(tasks, {bundle, jobs, isLive, at, unattended})` (`lib/task-pipeline-drive.js:346-497`) is one pass
over one queue, in three ordered steps. It returns new rows, the transitions it made, the stage starts it wants, and the
notes it could not act on — and it writes nothing (`:52-54`, `:344-345`).

**Step 1 — a parked row whose gate record arrived** (`:358-394`). The record's path is resolved against the row's tree,
`{{hole}}` segments matching one path segment, so `ledger/gates/G60-{{finding_id}}.json` is whichever file the seat
wrote (`:140-182`). Found → the row goes back to `queued` and moves to the next stage in the same write; not found →
nothing happens, which is the barrier.

**Step 2 — a row whose stage settled** (`:398-442`). Settled means: the row's current thread is not live
(`isLive`), and the job store's last run for that thread says `done` (`:404-408`). A failed run parks the row
(`:409-421`); a non-live thread with no job at all is left alone, because the facts do not support any move. The pass
never starts anything. Since §7.10 the pass also reads a row left `queued` over a stage whose run already settled
(`unreadSettle`): the same code, the same parks, and the one shape that would otherwise re-run a stage instead of
advancing the graph.

**Step 3 — the front of the queue starts a stage** (`:447-494`), only when the reader's switch is `auto`. "Front" is
`byQueueOrder` over the queued and running rows (`:56-58`), so a pipeline row waits behind a row with no pipeline
instead of jumping the queue it was filed in. The start it wants is a spec:

```js
{ taskId, pipeline, stage, position, count, title, prompt, target: tree || project, existing: Boolean(tree), project }
```

(`:475-486`) — and `stagePrompt` (`:278-287`) is the stage's own instruction, a provenance line naming the stage and
the row, and the row's detail. The panel adds no second instruction; a stage prompt the driver appended to would be two
briefs in one turn.

Between the passes, the pipeline's own limits decide (`:21-46`, `:239-270`): the rail wins over a back edge
(`EDGE_ORDER` = `sequence`, then `return`, then `loop`, `:124-138`); a `loop` is taken only when it is a stage's only
way out; a cap is a count of crossings compared against the whole number that opens the cap sentence, with `n of m`
refused outright because a progress label is not a bound (`:109-117`); and a gate that declares a `decision` is a
barrier the code cannot cross by itself (`:187-191`, `:224-237`).

### 1.5 What the panel does with the answer

`Assistant.sweepQueues` (`lib/assistant.js:1051-1132`) is the only caller, and its order is part of the contract:

1. one `readBundle(config.pipelineBundleFile)` for the whole pass (`:1056`) — a re-exported bundle is read on the next
   tick, and a refused one is passed as null so the driver reports `unresolved` rather than "the assistant decides";
2. `driveTaskPipelines` (`:1065-1073`);
3. `settleTasks` on the driver's rows (`:1074-1080`) — **after** the driver, which is why a failed pipeline run parks
   instead of being requeued by the settle (`lib/assistant/queue.js:1191-1195`);
4. one `writeQueueFile` when anything changed or a start was asked for (`:1084-1098`), journalled line by line;
5. the starts, after the write (`:1099-1122`), through `startSpawn`, whose refusal parks the row via
   `parkPipelineStart` (`:1375-1396`) because a stage that cannot be started is a decision, not a retry.

The cut itself is `Jobs.makeWorktree` (`lib/jobs.js:1984-2041`): slug from the prompt, six-hex tag, branch
`wtgui/<slug>-<tag>`, directory `<repo>/.worktrees/<slug>-<tag>`, the naming ledger written *before* the directory
exists, `git worktree add -b <branch> <path> <startRef>`, and the parent recorded. The row is linked at the cut:
`linkSpawnTask` writes `thread`, `worktree`, `project`, `running` and `startedAt` in one record
(`lib/assistant.js:1330-1365`), and `linkTaskRun` accumulates `threads[]` while `thread` stays the first one
(`lib/assistant/queue.js:722-746`).

### 1.6 The gap, in one table

| question | answered today | by what | gap |
|---|---|---|---|
| which stage is the row in | yes | `pipelineRun.stage` | — |
| how long it has been there | yes | `enteredAt` + `elapsedInStage` | — |
| which agent ran *this* stage | no | `threads[]` on the row, in order | a list of threads with no stage attached; a loop's second visit is indistinguishable from the first |
| how many times we have been in this stage | no | `crossings[edgeId]` | counts *edges*, not entries; a stage reachable by two loops cannot be counted |
| which tree this stage ran in | implicitly | `task.worktree`, one per row | nothing records that the tree was the same one, or that it changed |
| what the stage was handed | no | `stagePrompt` = instruction + provenance | the handoff's artifact is never resolved, so "one artifact, one writer" is a drawing, not a fact |
| why the panel parked/started here | partly | `task.reason` (600-char clip), a journal line, the panel log | no structured fact, so nothing can be queried or re-rendered; the sentence is the only record |

---

## 2. The stage run: identity, and what is stored rather than derived

### 2.1 The identity

A stage run is **one entry into one stage, by one agent**. Its id is

```
<pipeline>/<stage>#<visit>      e.g.  poc-to-uat/S8#2
```

`visit` comes from a new counter on the record, `pipelineRun.visits[stageId]`, incremented by the same write that sets
`enteredAt`. It is never reused: after a loop back to S8, S8's second entry is `#2` and the first is still `#1`.

Property this buys, and the reason the id is a string rather than an index: a journal line, a park's reason, a test's
assertion and a person's question all name the same thing, and a bundle re-export that inserts a stage in the middle
does not renumber anything.

### 2.2 The record

`pipelineRun` grows three keys and one nested list:

```json
{
  "pipeline": "poc-to-uat", "stage": "S8", "enteredAt": "2026-11-05T12:00:00.000Z",
  "visits": { "S3": 1, "S4": 1, "S8": 2, "S9": 1 },
  "tree": { "path": "<repo>/.worktrees/carry-the-contract-a1b2c3", "branch": "wtgui/carry-the-contract-a1b2c3",
            "startSha": "9f3c1a2", "cutAt": "2026-11-05T11:02:44.100Z", "by": "panel" },
  "route": "sha256:6b1f…",
  "stageRuns": [
    { "id": "poc-to-uat/S8#1", "stage": "S8", "visit": 1, "at": "2026-11-05T11:40:00.000Z",
      "thread": "carry the form", "job": "job-4f2a", "status": "done", "settledAt": "2026-11-05T12:01:10.000Z",
      "tree": { "path": "<repo>/.worktrees/carry-the-form-a1b2c3", "branch": "wtgui/carry-the-form-a1b2c3",
                "head": "1c9f0aa", "dirty": 0 },
      "artifact": { "id": "finding", "path": "ledger/G58.json", "present": true, "sha256": "3d0e91…" },
      "decision": { "by": "panel", "trigger": "stage-settled", "code": null,
                    "fact": { "kind": "run-status", "thread": "carry the form", "job": "job-4f2a", "status": "done" } } },
    { "id": "poc-to-uat/S9#1", "stage": "S9", "visit": 1, "at": "2026-11-05T11:52:00.000Z",
      "thread": "carry the form 2", "job": "job-91bc", "status": "done",
      "decision": { "by": "panel", "trigger": "gate", "code": "pipeline-gate",
                    "fact": { "kind": "gate", "gate": "G-10", "path": "decisions/G-10.json", "present": true } } },
    { "id": "poc-to-uat/S8#2", "stage": "S8", "visit": 2, "at": "2026-11-05T12:04:00.000Z",
      "thread": null, "job": null, "status": null, "decision": null }
  ]
}
```

An entry is created **when the start is asked for**, not when it settles: a stage that never started still has to name
the attempt, and a stage whose start was refused has to leave the refusal somewhere that survives a restart. The entry's
`thread` and `job` are filled at the link (the panel knows them only then), and its `decision` is written whenever the
driver makes one about that entry.

**A stage run settles on ITS thread.** The entry's own `thread` — written at the link, when the worker was cut — is the
run whose status settles the stage; `currentThread` is the fallback for an entry that is already settled or never got a
thread. Reading the row's newest thread alone was the 24-stage run's third defect: the row's `threads[]` is capped
(`TASK_THREADS_MAX`), the cap used to drop the newest one, and `currentThread` froze on `loop-20` — so 19 stage runs
settled on a finished job while their own workers were still running. The cap keeps the newest twenty now, but the
settle does not depend on that: the ledger already names the attempt.

`stageRuns` is capped at 30 entries, newest last; the cap is applied by the **writer** (`lib/task-pipeline.js`), not by
the queue's schema, because `pickTask` carries `pipelineRun` verbatim (`lib/assistant/queue.js:436-438`) and will not
clip inside it. A dropped entry increments `pipelineRun.runsDropped`, which is the one number the cap must not lose.

**Why the ledger is on the row rather than in a second store.** The driver's entire restart-safety story is "the queue
file is the only durable place a pass can leave a fact for the next pass" (`lib/task-pipeline-drive.js:77-87`), and the
queue has exactly one writer (`lib/assistant.js:1084-1098`). A second store would mean two files with no transaction
between them, and the failure mode of a half-write is a row that reads as running with no stage, or a stage with no row.
The cost is the cap above, and the loss of a very old visit's detail — acceptable because the tree is one per row (§3),
so the one fact an old visit uniquely proved (which tree it was in) is the row's own field.

### 2.3 Stored versus derived

The line is drawn by *who owns the fact*:

| fact | stored or derived | owner | why |
|---|---|---|---|
| current stage, `enteredAt`, `visits`, `crossings` | **stored** | the row | only the row's history can answer them |
| `stageRuns[]` (ids, threads, the tree each ran in, the artifact each settled with, the decision) | **stored** | the row | a restart must not forget which visit is which |
| `tree` (path, branch, start sha) | **stored at the cut** | the row | the cut is the only moment the path is knowable (§3.2) |
| `route` (routing fingerprint) | **stored at entry** | the row | it dates the graph the row entered under (§7.5) |
| a stage's liveness | derived | the job store | `isLive(thread)`; writing it would be a snapshot believed after the run was gone (`lib/assistant/queue.js:14-18`) |
| a run's status / final message | derived | the job store | same rule; `lastRunFor` reads it the way the settle does (`lib/task-pipeline-drive.js:292-298`) |
| whether an artifact exists *now* | derived | the filesystem | the file is the fact |
| whether it existed *when the stage settled* | **stored** (`present`, `sha256`) | the row | the tree changes afterwards; a later reader must see the state the driver acted on |
| the cap's limit, the next stage, the gate list | derived | the bundle | a copy on the row would outlive the bundle that owns it |
| the drawing's marks | derived | `stageRuns` first, `crossings`/`via` for old rows | one reader, no second truth (`public/pipeline-flow.js:193-215`) |
| the PR verdict that finishes a row | derived | the scanned row | unchanged (`lib/assistant/queue.js:1182-1189`) |

**Counts are stored; limits are derived.** That single sentence decides the table above, and it is why `visits` and
`crossings` live on the record while `cap.limit` and `pipeline.order` never do.

### 2.4 Migration

A record written before this design has no `visits` and no `stageRuns`. It is read as **one visit of the stage it is in**
— `visits = { [stage]: 1 }`, `stageRuns = []`, `route = null` — and nothing is written back on a read. A `route` of null
means "entered before the fingerprint existed", which is not a mismatch; the driver stamps it on the next move and never
parks a row for a fact it could not have recorded.

---

## 3. The tree: one per row, cut once, reused by every stage

### 3.1 The decision

> **SUPERSEDED for the default model.** Every stage of a round now gets its OWN tree, all cut from one frozen parent:
> the first cut resolves the parent branch to a commit and stores it (`pipelineRun.round`), and every later stage tree
> is cut at that commit (`lib/task-pipeline-drive.js` `roundOf` / `stageTreeLookup`, `lib/assistant.js`
> `cutPipelineTree`). The reasoning below is kept as the record of why one tree was right for a CHAIN before rounds
> existed — and the two defects that changed the answer are named in `docs/task-pipeline.md`, "The tree: one per
> stage": a mid-round cut saw commits that landed after the round began, and a critique read its draft because the draft
> happened to sit beside it, not because the document said so. A row written before rounds existed still runs as
> described here.

**One tree per row. Cut once, by the first stage that needs one. Every later stage — including a loop back into a stage
that already ran — starts its own agent in that same tree. The pipeline never cuts a second tree and never retires one.**

The alternative — a tree per stage, stacked child branches — was considered and rejected: the stages are one continuous
piece of work on one branch, the artifact chain is written into one workspace by one writer per artifact, and a
per-stage tree would make every handoff a cross-tree path resolution (which tree does `ledger/G58.json` live in?) and
make the loop-back's "the tree from last time" a *stack* rather than a fact. The panel already has a child-worktree
mechanism for a genuinely separate piece of work (`lib/child-worktree.js`); a pipeline stage is not that.

The cost, stated plainly: **a stage cannot be isolated from the previous stage's mess.** A stage that leaves the tree
half-edited hands that state to the next stage. That is the right default for a review-fix loop (the fix belongs on top
of the failure) and the wrong one for a stage that wants a clean base — which is why it is an open question, not a
hidden assumption (§8, Q1).

**The exception, and its boundary: a fan-out block.** This decision is about a CHAIN — stages that each finish what the
last one started. It does not reach a graph's concurrent part: two stages that are siblings, neither reading the
other's files, should not take turns in one tree. A pipeline that DRAWS such a block gets one tree per lane, all cut
from the same base, and one merge in the aggregator's tree. The walk follows the graph: `isolation: "per-stage"` used to
be the only way in, but under a round every stage already has its own tree, so a drawn block is walked without the flag.
The block is refused by name (running `shared`) when the graph is not one flat fork/join, and a record written before
rounds keeps its one tree, where the block is not walked and the lane it never ran is REFUSED at the stage that reads
it. `lib/pipeline-fanout.js` is the rule, `lib/pipeline-aggregate.js` the merge, and
[`docs/task-pipeline.md`](../task-pipeline.md) the record's fields.

### 3.2 When a tree is created, and why it is created *before* the start

Today the cut and the start are one call: `startSpawn` passes `existing: false` and the spawner cuts
(`lib/assistant.js:4979-5004`), and the row learns the path only afterwards, at the link (`:1330-1365`). That is the
orphan-tree window in §7.1: a cut that fails to produce a thread leaves a directory nobody's record names.

The design splits the step:

```
sweepQueues
  └─ driver asks for a tree            ensureTree = { taskId, project, prompt }   (no worker)
       └─ Assistant cuts it            Jobs.makeWorktree → path, branch, startSha
            └─ row written             pipelineRun.tree = { path, branch, startSha, cutAt, by }
  └─ driver asks for a start           start = { …, target: tree.path, existing: true }
```

So **every stage start is `existing: true`** — one code path, whether it is the first stage or the tenth — and a cut with
no start is a row with a tree and no thread: visible on the board, re-startable, and named by `pipelineRun.tree`. The
cut failure parks the row with the cut's own sentence instead of pretending there is a tree.

`ensureTree` is a *request* in the driver's return value, like `starts`, because the driver writes nothing
(`lib/task-pipeline-drive.js:52-54`). The assistant performs it and writes the row before it starts anything, in the same
order the `startingAt` marker already uses (`lib/assistant.js:1084-1099`).

### 3.3 When it is reused

| situation | tree | why |
|---|---|---|
| stage 1 of a row | cut (§3.2) | there is none |
| stage *n* of the same row | reused | one work item, one branch |
| a loop back into an earlier stage | **reused** | the refusal is about work that is in this tree; a new tree would not contain the commits the reviewer refused |
| a requeue of the stage the row is in (failed run, reader's requeue) | reused | the same work item; `attempts` is the counter, not a new tree |
| a row assigned a pipeline *after* it already had a tree (`pipelineRun` cleared and re-set) | reused | the row's `worktree` is the row's, whatever put it there |
| a row that is a different row | never shared | §3.5 |

The lookup is therefore a *sequence of exactly three answers, and then a park*:

1. `pipelineRun.tree.path` — the row's own field, written at the cut;
2. if that is absent (a record from before this design, or a hand-edited row), the most recent `stageRuns[].tree.path`
   that still exists on disk;
3. if that is absent too, `task.worktree` (where the row is already pointed);
4. none of the above → **park** with `pipeline-tree-gone` (§7.6). The panel does not cut a replacement, because a new
   tree would silently discard whatever the earlier visits left on the old branch.

Step 2 is what makes a loop-back find "its previous tree" rather than cutting a second one: the ledger is the record of
which tree the visits ran in, and the row's field is the same answer for the normal case. When the row's field and the
ledger disagree, the ledger wins and the disagreement is journalled — a row whose tree was swapped under it is a fact
worth seeing.

### 3.4 When it is retired

**Never by the pipeline.** The only retirer is the reader's delete (`lib/worktree-remove.js:1-24`), under its own guards:
a live agent in the tree, a reader's lock, and the panel's own checkout are refused (`:1-8`); the folder goes to the
Recycle Bin before git forgets it (`:13-15`). The design adds nothing to that list and removes nothing.

What the design adds is that retirement leaves a readable trace: `pipelineRun.tree` keeps the path, and the stage-runs
keep which visit last used it. A row whose tree was deleted, and that still has stages to run, parks (§7.6) instead of
starting in the primary checkout — the same refusal `replyTree` already makes for a reply ("A resume is not a new tree",
`server.js:1290-1292`).

A `done` row's tree is the reader's to keep or delete; the row no longer drives anything, and the ledger is what still
names the branch if a later row wants to continue it.

### 3.5 Two rows, one tree

The queue allows a row to name any `worktree` (`lib/assistant/queue.js:416`), and a hand-edited file or a moved task
can point two open rows at one directory. Two stages starting in one tree concurrently is the one collision that
corrupts work silently, so the driver refuses it:

- **the claim**: a tree path is claimed by every open row (`queued`, `running`, `parked`) whose `pipelineRun.tree.path`
  or `worktree` normalises to it;
- **the rule**: a start whose tree is claimed by a *different* open row parks with `pipeline-tree-claimed`, naming the
  other row's id and title — the panel does not queue behind it, because "the other row will be done soon" is a guess;
- **normalisation**: `cleanPath().toLowerCase()` on both sides, because Windows resolves two spellings to one directory
  and a case difference is not two trees;
- **scope**: the claim is global across assistants, because the tree is a directory on the disk, not a queue's property.

A parked row holds its claim: releasing it would let a second row start in a tree that is parked precisely because its
work is unfinished.

---

## 4. One agent per stage, and what "one agent" means

**Each stage run is one fresh agent: a new thread, started with the stage's own prompt. A stage never continues the
previous stage's thread.**

Three reasons, in the order they decided it:

1. **A stage boundary that inherits an agent's conclusions is not a boundary.** A resumed thread carries its own plan,
   its own claims about what is done, and its own reading of the last stage's instruction. The next stage's prompt would
   be read as a correction to that, not as the brief.
2. **The panel's cost model is one run per stage.** A stage is the unit a reader budgets, watches and retries; a single
   long thread for thirteen stages makes every one of those a property of the whole conversation.
3. **The tree carries continuity, not the conversation.** Everything a stage needs from the one before it is in the
   workspace (files, commits) and in the artifact chain (paths and hashes, §5). Continuity that lives in a transcript is
   continuity a restart loses.

Consequence, stated because it is the most expensive part of the design: **a stage's agent does not remember the
interview.** Every stage pays for its own preamble and re-reads what it needs. That is the price of the stage boundary,
and it is why §5 puts the inputs on the record rather than leaving the next agent to go looking.

What the start passes today is already the right shape — `stagePrompt` is the stage's instruction plus one provenance
line plus the row's detail (`lib/task-pipeline-drive.js:278-287`), and the panel adds no second instruction. The design
adds inputs (§5) and nothing else.

---

## 5. Inputs: how a stage receives what the earlier stages produced

### 5.1 The chain that exists and is not read

A bundle stage must declare an artifact with an id, a path, a schema and exactly one writer
(`lib/pipeline-bundle.js:117-123`); a handoff must name the artifact it passes (`:247-251`); a gate must name the
artifact it decides on (`:207-215`). So the graph already says, for every edge, *what* is handed on. Nothing in the panel
resolves it: the window draws `stage.artifact` (`lib/pipeline-window.js:95`), and the driver hands the agent a prompt.

### 5.2 The inputs block

`stagePrompt` gains one section, appended after the provenance line, and it is **paths and facts only** — never a
summary, never the panel's opinion of the artifact:

```
— poc-to-uat: stage 5 of 13, Investigate (poc-to-uat/S8), visit 2

INPUTS
  handed on   review    ledger/G58.review.json   commit 3f9c1a2b7d4e   blob 4b825dc642db   sha256 8ac1f0…   writer review-agent
              (S9 → S8, handoff H-10, loop — crossing 1 of a cap of 3; read it at 3f9c1a2b7d4e:ledger/G58.review.json)
  came back   the row arrived by H-10 from S8's next stage, S9; the gate G-10 after S9 declares decisions/G-10.json
              — read it; the panel does not read it for you
  earlier     finding   ledger/G58.json   commit 1c9f0aa4f3e2   blob 42dbd25dd307   sha256 3d0e91…   (this stage, visit 1 — unchanged)
  tree        <repo>/.worktrees/carry-the-contract-a1b2c3   branch wtgui/carry-the-contract-a1b2c3
              HEAD 1c9f0aa   0 uncommitted files
```

Five rules for it:

1. **The panel resolves, the agent reads.** The artifact's path is resolved against the tree with the same matcher the
   gate path uses (`lib/task-pipeline-drive.js:140-182`, generalised to `artifactPathOf`), and its `sha256` is computed
   at settle (§5.3). The agent is told where it is and what it hashed; it is never told what it says.
2. **The gate's decision is named, never read.** Rule 5 of the driver stands for every gate that does not route: the
   panel does not read a decision's value. The block names the file and says whose question it is. The one exception is
   a decision that declares `routes` (§6.1) — then the driver reads the record's single `outcome` field and obeys the
   edge the DOCUMENT mapped it to; it still judges nothing.
3. **On a loop back, the earlier visit's artifact is named as such.** That is the one input a fresh agent cannot
   reconstruct: *this* is the finding that came back, and it is the same file the earlier visit produced, not a new one.
   If it is absent, the loop-back parks (§6.1) rather than starting a stage with nothing to work on.
4. **Tree facts are facts, not cleanups.** HEAD, branch and the dirty count are quoted so the agent knows what it
   inherits. The panel never resets, stashes or cleans a stage tree (§7.3).
5. **The handoff is a commit and a blob, never a branch.** The line names the commit the writer settled at and the
   blob's object id, and says where to read it (`git show <commit>:<path>`). A branch resolves differently tomorrow;
   the commit cannot. A start whose recorded commit is not in this tree parks `pipeline-refuse-input` rather than
   reading whatever the branch says now, and a checkout that has moved off the pin is said so on the line — the agent
   is told to read the blob, not the working file. `lib/stage-pin.js` makes the git reading; the driver only consumes
   it, exactly as it consumes the tree facts.

### 5.3 What is resolved, and when

| resolved | at | recorded on |
|---|---|---|
| the handoff out of the settled stage, and its artifact path | settle, before the move | the settling stage run: `artifact {id, path, file, present, sha256}` |
| the tree's COMMIT, the artifact's blob id and the sha256 of the blob's bytes | settle | the stage run's `commit`, and the artifact's `commit/blob/blobSha256` |
| the artifact's `sha256` (files up to 1 MiB; larger files record `present` only, and say so) | settle | same |
| the gate that ended the stage, and its decision path | settle | the park's `waitingFor`, and the next run's inputs block |
| the tree's HEAD and dirty count | each pass, for the rows being driven | the stage run, at entry and at settle |

A stage whose declared artifact is **absent at settle** does not advance: it parks with `pipeline-artifact` naming the
path (§6.1). This is the design's one new hard gate, and it is what turns "one artifact, one writer" from a drawing into
a check.

**A hole the record can fill is not a match.** A declaration may carry `{{run_id}}` and `{{round}}`; the matcher fills
the holes it knows before it falls back to matching one path segment (`fillHoles`, `artifactValues`). `{{round}}` is
the visit the stage is in, so a loop body's seventh visit resolves `r7/…` and records r7's bytes. Matching instead of
filling is what the 24-stage run exposed: `r{{round}}` matched r1 through r7, the first name that sorts won, seven
visits recorded one hash while seven files sat on disk, and the pin was taken against the declaration - a path git
cannot resolve - so every committed round read as `uncommitted`. The record therefore carries both: `path` is the
declaration, `file` is what it resolved to, and the blob is taken from `file`.

**The same rule makes a gate a question asked again each round.** A gate that declares one record per round
(`ledger/gates/G51-{{run_id}}-r{{round}}.json`) is asked for THIS visit's file, on every pass — the settle's ask, and
the parked row's re-ask alike. Without the round filled in, the first-sorted fallback found r1's file in every later
round: G51 was crossed 11 times on round 1's decision while the document waited for a new one each round. A round with
no record yet parks on the declaration (so the next pass fills that round again); a round's own record is the only
thing that releases it.

---

## 6. The decision: park or start, and what a person can read afterwards

### 6.1 The decision table

Every pass asks one question per row — *what does this stage's fact license?* — and the answer is one of three shapes:
**wait** (no decision), **move** (advance and/or start), **park** (stop, with a reason). The facts and their codes:

| stage fact | decision | code | what the row reads |
|---|---|---|---|
| the stage's thread is live | wait | — | nothing is written |
| run `done`, artifact present, no gate out | move to the next stage, then start it if `auto` | — | "stage S3 settled — moved to S4 (4 of 13)" |
| run `done`, gate out, decision record present | move, and record the crossing | — | "gate G-10 crossed by <path>" |
| run `done`, gate out, record present, decision declares `routes` and the outcome routes to an edge | move down the ROUTED edge (the kind order is not consulted) | — | gate G-3 placed its verdict at `<path>`: fail — the row takes H-3 |
| run `done`, gate out, record present, decision declares `routes` and the outcome routes to `null` | the pipeline is over; the cap is NOT charged, and the settle finishes the row | — | "… that outcome ends the loop H-3 (S3 → S1), so the pipeline is over" |
| run `done`, gate out, record present, decision declares `routes` and the record is unreadable / names no declared outcome | park | `pipeline-verdict` | the gate, the path, the outcomes it declares |
| run `done`, gate out, record absent | park | `pipeline-gate` | the gate, the path, and that the code does not decide it |
| run `done`, declared artifact absent | park | `pipeline-artifact` | the artifact id, the path, the handoff it was to travel on |
| run failed / interrupted / stopped | park | `pipeline-run-failed` | the status and the run's last words |
| a loop at or past its cap, or a cap that cannot be read | park | `pipeline-cap` | the edge, `used of limit`, or why the cap is unreadable |
| the row has no tree and had one before | park | `pipeline-tree-gone` | the path, and the stage run that last used it |
| the row's tree is claimed by another open row | park | `pipeline-tree-claimed` | the other row's id and title |
| the bundle cannot resolve the record | park | `pipeline-unresolved` | the contract's own sentence, and the kind |
| the routing fingerprint moved since the row entered | park | `pipeline-changed` | both fingerprints, and the fields that decide routing |
| the input's pinned commit is not in this tree, or its blob is not the one recorded, or a declared input was settled by no run and is not in this tree either | park | `pipeline-refuse-input` | the artifact, the commit and that the branch moved; or the artifact and that nothing has settled it, and the stage run settles `refused` |
| the start was refused by the spawner | park | `pipeline-start-refused` | the refusal, and that nothing was started |
| the start is in flight (`startingAt` inside the grace) | wait | `pipeline-starting` | a note only, never a park |
| `auto` is off | move, no start | — | the row advances and waits, as it does today |

Two of these are behaviour changes and both need a failing-first test: **`pipeline-unresolved` parks** (today it is a
note and the row sits still, `lib/task-pipeline-drive.js:419-421` and `:457-458`), and **`pipeline-artifact` exists at
all**.

One thing this table does not claim: **a gate's decision does not choose the route unless the document maps it.** The
driver checks that the gate's decision file exists and then takes the stage's edge by kind order — `sequence` first
(`lib/task-pipeline-drive.js:21-31`, `:239-270`) — so a gate whose two outcomes were meant to lead to two different
stages (approve → S10, reject → S8) takes the sequence either way UNLESS its decision declares `routes`. With `routes`
— a map from an outcome to a handoff id, or to `null` for "the pipeline ends here" — the record's `outcome` picks the
edge, and the panel still judges nothing: the seat decided, the graph routed. That is the shipped answer to Q11 below,
and it is what lets a converged loop end at its verdict instead of spending its cap (the 3-stage `probe-fix-loop` round,
`docs/reviews/pipeline-execution-round.html`, finding 2). A gate anchored *after the last stage* with no edge out is
named in the driver's answer as `closing` and is never a barrier — there is no edge out of the last stage for it to
guard (`lib/task-pipeline-drive.js:33-36`, `:216-219`) — so a row that settles there is finished by the settle, not
parked. A last stage whose ONLY edge out is a loop does have an edge: that gate is a barrier, and its verdict is what
ends the loop.

### 6.2 The decision record

Every park and every move whose reason is a stage fact writes, on the stage run it is about:

```json
"decision": {
  "by": "panel",
  "trigger": "stage-settled",
  "code": "pipeline-artifact",
  "at": "2026-11-05T12:01:10.000Z",
  "fact": { "kind": "artifact", "id": "finding", "path": "ledger/G58.json", "present": false, "handoff": "H-9" },
  "reason": "stage S7 settled — its artifact finding (ledger/G58.json) is not in the tree, so handoff H-9 has nothing to pass"
}
```

- **`by`** is the actor that performed the transition: `panel` (the driver acting on a fact), `reader` (assign, clear,
  requeue, release), `assistant` (a SPAWN that named the row).
- **`trigger`** is what made it legitimate: `stage-settled`, `gate-record`, `cap`, `artifact-missing`, `start-asked`,
  `start-refused`, `tree`, `unresolved`, `changed`, `reader`, `assistant`.
- **`fact`** is structured and small — `{kind, …}` where kind is one of `run-status`, `artifact`, `gate`, `cap`, `tree`,
  `claim`, `record`, `bundle`, `spawn`. The sentence is **rendered from the fact** by one function, so the row's reason,
  the journal line and the window cannot drift apart.
- **`reason`** is the sentence, clipped to `TASK_REASON_MAX` (600, `lib/assistant/queue.js:50`) on the row and kept whole
  on the stage run.

### 6.3 Where a person reads it afterwards

Four surfaces, in the order a reader meets them, and each one is the same facts at a different distance:

1. **the row** — `reason`, the 600-char sentence, and the stage chip. What the board shows today, unchanged.
2. **the stage run** — the structured `decision` on `pipelineRun.stageRuns[]`, which is what makes "who decided, on
   which fact" answerable without parsing prose.
3. **the journal** — one line per transition, timestamped, with the same sentence (`lib/assistant.js:1091-1094`).
4. **the queue file** — the durable record, which is also what a restart reads.

The one thing deliberately *not* added is a second history file: the journal already is the append-only log, and the
queue row already is the state. A third store would be a third thing to keep in step.

### 6.4 Releasing a park

A park is a hold with `kind: "manual"` (`lib/task-pipeline-drive.js:319-331`), which is why the settle never releases it
(`lib/assistant/queue.js:1162-1163`) — "needs a decision" is not a condition that becomes false. Two parks need named
releases, and the design adds them as queue actions rather than as a TTL:

- **`pipeline-cap`** — the release resets that edge's count (`crossings[edgeId] = 0`) and writes
  `{by: "reader", trigger: "cap", fact: {kind: "cap-release", edge, from, to, was}}`. Without the reset a requeue
  re-parks on the very next pass, because the count is compared as `used + 1 > limit` (`lib/task-pipeline-drive.js:258`).
  This is the design's sharpest small finding: **a cap park is unreleasable by requeue alone**, and today nothing says so.
- **`pipeline-changed`** — the release re-stamps `pipelineRun.route` at the current stage and moves nothing else, so a
  deliberate re-export can be acknowledged row by row.

Every other park is released by fixing the fact: write the decision record, repair the tree, fix the record or the
bundle, start the worker by hand.

---

## 7. Failure modes, honestly

Each one: the scenario, what happens today, what this design does, what it still cannot do.

### 7.1 Orphan trees

*A cut succeeds and the start does not.* Today the cut and the start are one call, and the row learns its tree only when
a thread comes back (`lib/assistant.js:1330-1365`). A spawner that cuts and then fails — a gateway refusal, a timeout
after `worktree add` — leaves a directory no row names; the next pass cuts a second one, and the first is found later by
`git worktree list`. **Design:** the cut is its own step and the path is written on the row *before* the start (§3.2), so
a failed start leaves a row with a tree and no thread; the next pass reuses it. **Remaining:** a cut that fails
*between* `git worktree add` and the row write is still an orphan, and no design can close that window without a
transaction across git and the queue file. It is named here so a reader who finds such a directory knows what it is.

### 7.2 Two stages wanting one tree

*A loop back to a stage whose earlier worker is still live.* The driver only starts the front row, and only when it is
`queued` (`lib/task-pipeline-drive.js:447-451`), so a second worker for one row cannot start while the row is `running`.
But an old `startingAt` that never linked (a spawner that hung) is retried after three minutes (`:85-87`) while the first
worker may in fact have started and failed to link — two agents in one tree. **Design:** the stage run records the
thread at the link, and the driver treats *a live thread for this stage run* as the stronger fact than the marker; the
marker is only the answer when no thread exists. **Remaining:** the link is written by the assistant after the spawner
returns, so a spawner that never returns leaves both facts unknowable; the grace period is the only backstop.

Two *different* rows in one tree is refused outright (§3.5). The panel has no way to make a reader's hand-edited row
share a tree safely, so it does not try.

### 7.3 A dirty stage tree, and the loop back into it

*A stage that ends with uncommitted work, or a reviewer's refusal that leaves edits behind.* Today the next stage starts
in that tree with no comment at all: `stagePrompt` says where and what, not what state the tree is in
(`lib/task-pipeline-drive.js:278-287`). **Design:** the inputs block quotes branch, HEAD and the dirty count (§5.2); the
panel never resets, stashes or cleans, because the dirty state is the work the next stage was hired to finish. **The
harder half:** the driver cannot read git (it is pure, `lib/task-pipeline-drive.js:1-58`), so the facts are computed by
the assistant per pass and passed in — a cost of one `git status --porcelain` per driven row per pass, which is why the
pass computes it only for rows whose stage is about to start or settle, not for every row.

### 7.4 A cap firing mid-tree

*A loop hits its cap with work in the tree.* Today the row parks with the cap's sentence (`:258-269`) and the tree is
untouched. **Design:** unchanged, plus two additions — the park names the tree and the last stage run, and the release
resets the count (§6.4), because without it a requeue is a one-tick park loop. **Remaining:** the cap is the studio's
bound, and the panel offers no per-row override; raising it means re-exporting the bundle, which parks every live row on
`pipeline-changed` (§7.5). That is honest and inconvenient, and Q3 in §8 asks whether it is the right call.

### 7.5 A pipeline edited under a live row

*The bundle is re-read every pass* (`lib/assistant.js:1056`). A stage id removed, a handoff re-pointed, a gate added
after the stage the row is in, a cap changed — all of it lands on the next tick. Today the row is driven against the new
graph with no comment; a gate added behind a settled stage is a barrier the row did not have when it entered.
**Design:** a routing fingerprint is stored at entry —

```
route = sha256 of { stage ids in order, handoffs (id, from, to, kind, cap), gates (id, after, artifact, kind) }
```

— normalised so prose and position do not move it. A mismatch parks with `pipeline-changed`, naming both fingerprints,
and the release re-stamps (§6.4). Editing a stage's *prompt* or artifact *text* is deliberately not a change: the next
stage simply gets the better brief, which is the repo's own rule for a refusal sentence that is free to improve.
**Remaining:** the fingerprint says *that* routing moved, not *which* field; naming the field needs the old definition,
which is not stored. A per-pipeline history of routing fingerprints would answer it and is out of scope (Q5).

### 7.6 A loop back whose tree was deleted

*The reader deletes the tree* (or the panel released it) *while the row still has stages to run.* Today the row starts
in its project instead — `existing: Boolean(tree)` (`lib/task-pipeline-drive.js:483-484`) with a `worktree` that no
longer exists resolves to the project, and a stage quietly runs in the primary checkout. That is the worst outcome in
this list: the work lands in the checkout the panel is served from. **Design:** the tree lookup (§3.3) ends in a park,
never in a cut and never in the project: `pipeline-tree-gone`, naming the path and the visit that last used it. The
sentence offers the two real options — point the row at another tree, or clear the pipeline and start over — and the
`replyTree` refusal is the precedent that a missing tree is a 409, not a new tree (`server.js:1290-1292`).

### 7.7 A stage that settles `done` having done nothing

A run that ends `done` with no artifact and no change is indistinguishable from one that did the work, because the
driver's only fact is the run's status. With §6.1's artifact check the case is caught *when the stage declares an
artifact*; a stage whose artifact is already present from a previous visit (a loop back) passes the check without having
done anything. **Design:** the stage run records the artifact's `sha256` at settle, and a loop-back visit whose artifact
hash is identical to the previous visit's is recorded as `artifact: {unchanged: true}` — visible on the row and in the
journal, not a park. **Remaining:** the panel does not judge whether unchanged means "failed"; that is the decision of
the gate or the person reading it.

### 7.8 The queue's own caps

`TASK_CAP` 200 and the 600-char `reason` clip (`lib/assistant/queue.js:47-54`) apply to a row that now carries a ledger.
The ledger is capped by its writer (§2.2), because `pickTask` carries `pipelineRun` verbatim. A row evicted at the task
cap takes its stage runs with it — which is correct (the row is gone) and worth knowing before anyone goes looking for
the history of a row that is no longer in the file.

`TASK_THREADS_MAX` 20 caps `threads[]`, and it keeps the **newest** twenty: the last entry is the run carrying the row
(`currentThread`), so the entry the cap drops is the oldest of the later ones, never the current run — the first entry
(the legacy `thread`) stays first. Capping the other way froze `currentThread` on the twentieth for the rest of a long
row's life, which is how 19 stage runs settled on `loop-20` (see §2.2).

### 7.9 A row moved between assistants mid-run

A task can be handed to another assistant (`lib/assistant/queue.js` `reassignTask`, `adoptTask`), and `pipelineRun`
travels with it. The next stage is then started by the *other* assistant's `spawn` switch and, if it is not `auto`, the
row advances and waits. The tree claim (§3.5) is global, so the move does not free the tree. This is the designed
behaviour, not a failure — but it is the reason the switch is read per queue rather than stored on the row.

### 7.10 A row left `queued` over a settled stage

The driver's second pass reads a settle from the row's RUN: a `running` row whose thread is not live and whose last
job says `done`. A row can stand in `queued` over the very same settle — the panel was killed between the queue write
and the start, a requeue landed first, a pass wrote the move but never asked for the next start. Its stage run's entry
already says `status: done`; what it does not carry is a `decision`, because the driver writes that when it READS the
settle (§6.2).

**Design:** the pass reads that row too. `unreadSettle(task)` is the predicate — the entry for the row's CURRENT
stage and visit has `status: done` and no decision — and the rest of the pass is the same code, so a cap, a gate, a
missing artifact and a refusal all still park it. The alternative reading ("the stage has not started, start it") is
wrong for exactly this shape: it runs the stage a second time while the graph never moves, which is the boundary stall
that needed a hand-start. A failed run is deliberately NOT this shape (its entry says `failed`, not `done`), so the
retry path keeps owning a requeued failure.

**Why it is safe against a duplicating run:** the row's stage run is the record of the visit, and a visit is only
entered by `enterStage` (`lib/task-pipeline.js`). Reading the settle writes its decision on that same entry, so a
second pass over the same row finds `decision` and does nothing. `visits[stage]` does not move — reading an order is
not a second visit.

**Measured:** `node tools/verify-pipeline-walk.mjs` walks the shipped small documents through `Assistant.sweepQueues`
with a scripted seat and no hand-start (`docs/reviews/pipeline-walk/report.html`). The fourth walk leaves the row queued
over a settled `probe`: the driver before this rule left it queued with no decision and never advanced; with the rule it
enters `fix` and the row finishes.

---

## 8. Open questions

1. **Does a stage ever legitimately need its own tree?** The design says no (§3.1). The counter-example is a pipeline
   whose stages belong to different projects, or a stage that must run on a clean base. What would settle it: one real
   pipeline from the studio with a stage that edits a different repository, and whether its artifact path still resolves.
2. **Who validates an artifact's schema?** The bundle declares `schema` (`lib/pipeline-bundle.js:117-123`); the panel
   checks existence and hash, never shape. If the schema is a contract, something has to read it — the studio's own tool,
   a gate, or the panel. Deferred, because the panel has no validator and inventing one is a second definition of the
   schema.
3. **Should a cap be releasable without re-exporting the bundle?** §6.4 lets a reader reset the count, which is an
   override in all but name. The alternative — a per-row cap — puts a studio bound on the row, where it can outlive the
   bundle. Neither is obviously right.
4. **Is a requeue a new visit?** The design says yes: a new agent is a new entry, `visits[stage]` increments, and no
   crossing is counted (a requeue is not an edge). The consequence is that `visits` grows on every retry, so a stage
   retried five times reads `#6`; whether that is "the sixth visit" or "five attempts of one visit" is a language
   question the drawing will have to answer.
5. **Can the panel say which routing field moved?** A per-pipeline record of routing fingerprints would, at the cost of a
   store that outlives the bundle it describes. Until then `pipeline-changed` names *that* it moved, not *what*.
6. **Who may release a cap park — the reader only, or the assistant too?** The assistant can already requeue by writing
   the queue; the reset is the part that is a decision. This design gives it to the reader only.
7. **Is a finished stage's thread closed for good?** A reader can reply to a thread (`startThreadReply`), and doing so
   after the stage settled starts a run the driver does not know about. Either replies to a settled stage are refused, or
   they are recorded as an unplanned visit. Not decided.
8. **What happens to the ledger when the bundle's pipeline id is renamed?** `pipelineRun.pipeline` no longer resolves, so
   the row parks `pipeline-unresolved`, and the ledger names stage ids of a pipeline the bundle no longer holds. It is
   readable, not resolvable; a rename map would resolve it and is a bundle-format question, not a driver one.
9. **Does the drawing switch to `stageRuns` for its marks, or keep inferring from `crossings`?** The plan for the flow
   dialog argues for the record (`docs/reviews/pipeline-flow-integration-plan.md`, "State is read, never inferred"). The
   ledger makes that possible; making it true is a UI commit, not this design.
10. **What is the tree's fate after a `done` row?** The panel never retires a tree (§3.4), so a landed pipeline's tree
    stays until a reader deletes it. Whether a `done` pipeline row should offer "delete the tree now that its PR is
    merged" as one press, and whether that is safe for a row whose branch was the base of another, is a cleanup
    question this design leaves open.
11. **Does a gate's outcome ever choose the edge?** Answered in the shipped driver: it does when the DOCUMENT says so.
    A gate's decision may declare `routes`, a map from an outcome name to a handoff leaving that gate's stage (or to
    `null`, "the pipeline ends here"). The record's `outcome` picks the edge; the panel still judges nothing — the seat
    decided, the graph routed. The alternative this question used to offer (a two-outcome gate takes the sequence
    whatever the record says) is the un-routed shape, and it is why a converged loop used to spend its cap: the last
    stage's only edge out was a loop, and the driver had no word to stop it. The remaining gap is the DRAWING: the
    flow dialog prints a gate's outcomes but not where each one routes, so a reader learns the mapping from
    `docs/task-pipeline.md` rather than from the picture.

---

## 9. What this changes, by file

Short, because a design that does not name its seams is not actionable.

| file | change |
|---|---|
| `lib/task-pipeline.js` | `visits` and `stageRuns` written by `enterStage`; `stageRunId()`; the ledger's trim; the migration read (§2.4) |
| `lib/task-pipeline-drive.js` | `artifactPathOf` (the `decisionPathOf` matcher, generalised); `routingFingerprint`; the inputs block in `stagePrompt`; the tree lookup and claim; `ensureTree` in the return value; five new `DRIVE_FAULTS`; the decision record; unresolved parks |
| `lib/stage-pin.js` | the git reading behind a handoff's pin: the tree's commit, the artifact's blob id and the blob's sha256; `pinCheck` for a start that must not read a different tree |
| `lib/assistant.js` | `ensureTree` performed before any start, and `pipelineRun.tree` written before it; tree facts (HEAD, dirty count) computed per driven row; the cap release and the fingerprint re-stamp as queue actions; the start spec is always `existing: true` |
| `lib/assistant/queue.js` | the row's schema carries the new keys verbatim (it already carries `pipelineRun` so); the two release actions |
| `lib/pipeline-window.js` | draw a stage's state from `stageRuns` when it is there, `crossings`/`via` when it is not |
| `public/pipeline-flow.js` | `ranFrom` can finally be handed `position.ran`, instead of reconstructing it |
| `docs/task-pipeline.md` | the record section gains the new keys; the driver section gains the decision table |

### How it would be tested, failing first

1. **A loop back re-enters with `visits` + 1, the same tree, and no second cut.** One `starts` entry whose
   `existing` is `true` and whose `target` equals the first run's tree — the assertion `test/task-pipeline-drive.test.js:258-261`
   already makes for a second stage, extended to a re-entry.
2. **A stage whose artifact is absent parks `pipeline-artifact`** naming path and handoff, and the next pass does not ask
   for the following stage.
3. **`unresolved` parks** — today's tests expect a note and a row left alone; the flip is the test.
4. **A routing change between two passes parks `pipeline-changed`**, and a prompt-only change does not.
5. **A cap release resets the edge's count** and the row starts; a requeue without the release re-parks in one pass.
6. **A failed start leaves `pipelineRun.tree` on the row** and the next pass reuses it — the orphan-tree test: the tree
   step is not called twice.
7. **A second row naming the same tree is refused** with `pipeline-tree-claimed`, compared case-insensitively.
8. **The decision record is rendered, not written twice**: one `renderDecision(fact)` produces the row's sentence, the
   journal line and the window's text, asserted by giving the same fact three readers.

---

## What this document does not decide

- The drawing's palette, geometry or states — those belong to the flow plan
  (`docs/reviews/pipeline-flow-integration-plan.md`), which this design feeds with a record rather than a renderer.
- Whether a pipeline may span projects, or a tree may be shared deliberately (§8 Q1).
- The artifact schema's enforcement (§8 Q2).
- Anything about the studio's authoring side; the loader is the boundary (`lib/pipeline-bundle.js:1-29`).
