---
name: pipeline-run
description: Read a pipeline row's run, trees and the step it owes.
version: 1.0.0
author: Jacob Roper (JLRoper), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [agent-worktree-gui, pipeline, queue, worktree]
---

# Pipeline run: reading a row and handing its stages forward

The panel drives a queue row through a pipeline one stage at a time, and since 1.75.0 every stage runs in its own
worktree cut from the round's parent tree (`62b0a71`). `pipelineRun` on the row is the whole record of where that
round stands. This skill is how to read it, what each stage owes, who starts the next one, and what to do when the
record and the disk disagree.

A row with `pipelineRun: null` is **assistant-decides**: the assistant chooses its next turn and there is no stage
state to read. That is a different path, not an empty one.

## When to use

- A queue row carries a `pipelineRun` and you are asked to work, check, recover or land its current stage.
- A row is parked and its reason names a stage, artifact, gate, tree, verdict or record.
- A stage advanced but has no tree of its own (the #260 stall).
- A round's pipeline is over and something is about to be pushed or landed.

Do not use for a row with no `pipelineRun`, or for the **tree ladder** (a worktree's own `pipeline` field in
`docs/pipelines.md`). The ladder says what a tree may do with a branch; `pipelineRun` says which stage of a studio
document a task is being carried through. Two fields, two meanings.

## Read it first

```
node tools/pipeline-state.mjs <task id>
node tools/pipeline-state.mjs <task id> --json
node tools/pipeline-state.mjs <task id> --assistant assistant-1
```

It reads the queue, the bundle beside it and the job store, prints the row, the run, the round, every tree, the
stage ledger, what the current stage owes, and the one next step. It writes nothing, so it is safe to run on a live
row. `--assistant` is only needed when the id appears in more than one queue.

The record itself lives at `state/assistants/<assistant>/queue.json` on the row's `pipelineRun`; the document it is
resolved against is `pipeline-bundle.json` in the same state directory.

### The fields that matter

| field | what it means |
|---|---|
| `pipeline`, `stage`, `enteredAt` | where the row is. `enteredAt` is the only clock: time in stage is `now - enteredAt`, never a counter |
| `visits` | entries per stage. A stage run's id is `<pipeline>/<stage>#<visit>`, so a loop's second pass is `#2` |
| `stageRuns[]` | the ledger: `at`, `thread`, `job`, `status`, `settledAt`, `commit`, `tree`, `artifact`, `inputs`, `decision` |
| `trees[<stage>]` | the stage's own child tree, written AT THE CUT. Its presence is the proof the cut happened |
| `tree` | the round's landing tree (the parent tree's branch). On a record older than rounds, the row's one tree |
| `round` | `{parentPath, parent, slug, tag, base, sha}`: the parent tree, its branch, and the commit it was cut from |
| `crossings` | loop edge to count. The cap is compared as `used + 1 > limit` |
| `route` | routing fingerprint at entry. A change parks `pipeline-changed` rather than driving a graph the row did not enter under |
| `via` | the handoff this visit arrived by. Absent on a first visit |
| `waitingFor` | what a park waits for: a gate record, a cap, a route |
| `startingAt` | the last start ask. It stops a second start for three minutes while the spawner is still working |
| `assembly` | `{commit, base, branch, path, verified, stages[], skipped[]}`: the ONE branch a finished round lands |

Reading rules:

- The ledger is capped at 30 entries by its writer; `runsDropped` counts what the cap lost. A short ledger is not a
  short run.
- The queue carries the record verbatim. A malformed record reads `unresolved`; it must never be normalised by hand
  into assistant-decides.
- A stage run is created when the start is ASKED FOR, so an entry with no `status` is an attempt, not a run that
  never happened.
- `commit` on a stage run is the tree's full HEAD at settle. That commit, never the branch name, is what the next
  stage is handed.

## What a stage owes

Every stage owes up to two files, and each has exactly one writer.

1. **Its declared artifact** at `stage.artifact.path`. The path is workspace-relative and a `{{hole}}` segment
   matches one path segment; `stage.artifact.schema`, `kind` and `writer` are the document's own words. The stage
   must leave the file **committed in its own stage tree**. At settle the driver resolves the path and records
   `artifact {id, path, present, sha256, commit, blob, blobSha256}` on the stage run. Absent means the row parks
   `pipeline-artifact`, naming the path and the handoff that now has nothing to pass. Files over 1 MiB record
   presence only. A loop visit whose artifact hash matches the earlier visit records `unchanged: true`; that is a
   visible fact, not a pass.
2. **A gate's verdict, only when a gate sits after the stage.** A gate with `gate.after === stage.id` and a
   `decision` is a barrier: the seat writes JSON `{"outcome": "<one of decision.outcomes>"}` at `decision.path`,
   and the `decision.writer` is the role that owns it. When `decision.routes` exists the outcome picks the edge,
   and `null` means the pipeline ends there. The panel never writes this file and never decides the gate. Missing
   parks `pipeline-gate`; a record that is not JSON, names no outcome, or names one the gate does not declare
   parks `pipeline-verdict`.

The `decision` object on a stage run is the panel's own transition record (code, fact, rendered reason). It is not
the gate's verdict; the verdict is the file.

## Who starts the next stage

**The panel does, never the worker and never a reader by hand.**

- A settled run is read by `driveTaskPipelines` on the queue tick, or by `sweepPipelineWaits` when the stage run is
  held in the tree's `pipelineWait`. Both call the same advance seam.
- With the assistant's `spawn` switch on `auto`, the panel starts the stage at once. On `ask` or `off` the row still
  advances but waits for a person. The switch is read per queue.
- A stage that has no tree yet is not started: the pass asks for `ensureTree`, the panel cuts the child tree and
  writes `trees[stage]`, and the NEXT pass starts the stage in it with `existing: true`.
- Do not "help" by starting the next stage, by requeueing a row whose settle has not been read, or by writing
  `pipelineRun` by hand. The panel's one write moves the row and starts the next stage in the same pass; a second
  writer is the double advance the hold exists to prevent.

## The #260 stall: a stage advanced with no tree cut

Symptom: `pipelineRun.stage` names a stage, the stage run's entry carries a `tree`, but `pipelineRun.trees[stage]`
is absent, so the stage stood in a directory the round never cut for it: another row's tree, the round's landing
tree, or the checkout. `node tools/pipeline-state.mjs <id>` prints an `uncut` line for exactly this shape.

Queue row 260 is the worked example. Its `implement` worker ran in
`write-the-draft-the-brief-asks-for-in-94df79` on the round's branch and committed `49278be` there;
`ledger/gui-improve/change-set.patch` was not in the tree the settle read, so the row parked `pipeline-artifact`.
The record looked like a missing artifact; the real defect was a missing cut.

What to do:

1. Run the printer and read `uncut` and `tree`. `uncut` names the directory the stage actually used.
2. Do not keep working there, do not commit a fix there, and **do not cut a worktree by hand**. Tree names come from
   `stageTreeName`, and the cut is the panel's `cutPipelineTree`.
3. Re-enter the stage (requeue the parked row, or assign the same stage again) so the panel cuts the child tree from
   the round's parent and records it under `trees[stage]`. Redo the stage there, not in the old directory.
4. If the work already exists in the wrong directory, copy it into the new stage tree, commit it at the declared
   path, then requeue. A park is released by fixing the fact, not by pressing a release.
5. A recorded tree that is GONE parks `pipeline-tree-gone`; never cut a replacement for a recorded path. A tree
   claimed by another open row parks `pipeline-tree-claimed`; one tree belongs to one row.

## A round's trees are slices: landing waits for the assembly

- Every stage tree holds only that stage's commits. It is a work branch
  (`wtgui/<task-slug>-stage-<n>-<stage-slug>-<tag>`), never the landing branch. Do not push a stage branch, open a
  PR from it, or merge stage branches by hand.
- The landing branch is the round's parent tree: `round.parentPath` on branch `round.parent`, cut from `origin/main`
  before the first stage at `round.sha`. A commit that lands on main after the round began is in no tree of it.
- When the pipeline is over, the assembly cherry-picks every settled stage run's `commit` in visit order onto the
  parent tree and writes `pipelineRun.assembly`. That branch is the one to push and land (`npm run land:pr -- <n>`
  in this repo, as `docs/versioning.md` describes). If an assembly is owed but not offered, read `assemblyPlan.why`:
  no round, a fan-out block, no commits, or a single stage without a parent tree.
- Do not hand-roll the round's merge. A manual merge produces no `assembly` record, so the landing step has nothing
  to verify. A same-lines pick conflict parks `pipeline-assembly-conflict` naming the path and the stages; a person
  decides which stage is right, and the panel never picks a side.

## Parks and releases

A park is a manual hold, and the panel never releases one on its own. Two codes have a named release; every other
park is released by fixing the fact.

| code | release |
|---|---|
| `pipeline-cap` | `POST /api/assistant/queue {"action":"pipeline-release","id":<id>,"release":"cap"}` resets that edge's crossings. A plain requeue re-parks on the next settle |
| `pipeline-changed` | `... "release":"route"` re-stamps the fingerprint and moves nothing else |
| `pipeline-artifact` | write and commit the artifact, then requeue |
| `pipeline-gate` | the gate's writer writes the verdict at `decision.path`, then requeue |
| `pipeline-verdict` | correct the verdict to one of the declared outcomes, then requeue |
| `pipeline-refuse-input` | the writer's commit or blob is not in this tree; restore the pin or re-run the earlier stage |
| `pipeline-run-failed` | read the run's last words, fix what failed, requeue |
| `pipeline-tree-gone` / `pipeline-tree-claimed` | repair the tree or the claim; never cut a replacement for a recorded path |
| `pipeline-unresolved` / `pipeline-changed` | fix the record or the bundle; do not invent a stage |

Requeue with `POST /api/assistant/queue {"action":"state","id":<id>,"state":"queued"}`.

## The trust setting the Skills tab needs

This skill is `.agents/skills/pipeline-run/SKILL.md` in this project. Hermes only absorbs a project's
`.hermes/skills` or `.agents/skills` when the project root is listed in **`skills.trusted_project_dirs`** in the
Hermes `config.yaml`, and project discovery is on (`skills.project_discovery`, which defaults to true). Without it
the panel's Skills tab lists the source as `ignored`, with the reason "this checkout is not in
skills.trusted_project_dirs, so Hermes does not load these skills": the file exists, but no run is served it.

```yaml
skills:
  project_discovery: true
  trusted_project_dirs:
    - <the project's primary checkout, absolute>
```

The entry must be the root the panel SCANS (the project's configured checkout, not a worktree path under
`.worktrees/`), because Hermes compares the project root it was handed against that list, character for character
apart from case.

Restart the gateway after the edit. The Skills tab and `GET /v1/skills` are the resolved answer; a row marked
`served` is what a run actually loads.

## Pitfalls

- `pipelineRun.tree` is not "the tree this stage runs in". Under the parent-tree model it is the round's landing
  branch. Read `trees[stage]`, then the stage run's own `tree`.
- Do not infer the next stage from the document by eye. The driver takes edges in kind order (sequence, return,
  loop) and a gate's `routes` can override it. Read `pipelineRun.stage` after the panel has moved the row.
- `startedAt` is not the row's age and not the stage clock; a pipeline row clears it at every move. Use `enteredAt`
  and `createdAt`.
- A record written before rounds has no `round` and keeps one tree for every stage. That is the model it was cut
  under, not a stall.
- An `unresolved` record is not the default path. Fix the record; do not clear it back to assistant-decides.
- A stage tree is local only. The only branch that leaves the machine is the assembly's.

## Verification

- `node tools/pipeline-state.mjs <id>` exits 0 for a found row, and its `next step` block names an owner for every
  line.
- `node --test test/pipeline-state.test.js` covers the printer: assistant-decides, an uncut stage, an artifact park,
  the gate's verdict, the assembly, a done row, and the CLI.
- On a live round, `pipelineRun.trees[<stage>]` and `pipelineRun.assembly` are the two fields that prove the cut and
  the landing branch; the report prints both.
