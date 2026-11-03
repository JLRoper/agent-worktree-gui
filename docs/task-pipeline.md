# A task's pipeline: the record, the window, and the control that puts a task on one

A queue task is either on a pipeline or it is not. "Not" is not an empty state — it is **assistant-decides**, the
default the panel has always had, and every existing task is on it. This document is the panel side of that choice: the
field, the three answers a record can give, the one write that changes it, and the bundle the answers are read against.

The tree ladder in [`docs/pipelines.md`](pipelines.md) is a DIFFERENT object. A tree's `pipeline` says which rung of
local → investigation → turnover it stands on and what it may do with a branch. A task's `pipelineRun` says which
studio-authored sequence of stages the work is being carried through. Two meanings, two fields — a card that says
"turnover" and a chip that says "stage 4 of 13" are talking about different records on purpose.

## The field

`state/assistants/<id>/queue.json` carries one optional field per task:

```json
{ "id": 7, "title": "carry the contract", "pipelineRun": { "pipeline": "poc-to-uat", "stage": "S3", "enteredAt": "2026-11-03T15:00:00.000Z" } }
```

`pipelineRun: null` (or no field at all) is the default path. `enteredAt` is a UTC instant — `Date#toISOString()` — and
it is the ONLY clock: time in stage is `now − enteredAt`, computed on every read, never counted by a timer.

The queue's schema carries the record **verbatim** (`pickTask`, `lib/assistant/queue.js`), including a broken one. A
malformed assignment must reach the window as `unresolved`; normalising it away in the queue would silently put the task
back on the default path.

## Three answers, and no fourth

`lib/task-pipeline.js` resolves a record against a loaded bundle:

| mode | when | what the window says |
|---|---|---|
| `assistant-decides` | `pipelineRun` is null | the default path in words; no stage list |
| `pipeline` | pipeline and stage both held, `enteredAt` a UTC instant | every stage in order, the current one marked, its `position of N`, the gate that ended the stage before, elapsed from the stamp |
| `unresolved` | a pipeline or stage the bundle does not hold, a record that is not an assignment, no bundle, or a bad stamp | the reason, no stage marked current, and the sentence that this is NOT the default path |

`lib/pipeline-window.js` adds the sequence and the gate; `GET /api/assistant/task-pipeline?assistantId=…&task=…` is its
HTTP adapter. A refusal is a value at 200 so the dialog draws the reason instead of a 500.

## Putting a task on a pipeline

Two reads and one write:

- `GET /api/assistant/pipeline-catalogue` — every pipeline in the bundle, its stages in order with their 1-based
  position, or the loader's own refusal (`missing`, `not-a-bundle`, …) with its file and locator. The window's
  assignment control draws from this; it never offers a stage the window would then call unresolved.
- `POST /api/assistant/queue` with `{ action: "pipeline", id, pipeline, stage }` — put the task on that stage, stamping
  `enteredAt` from this write's clock.
- `POST /api/assistant/queue` with `{ action: "pipeline", id, clear: true }` — back to assistant-decides.

The transition lives in `lib/task-pipeline-assign.js`; the Assistant's `queueMutate` owns the file, the journal and the
repaint, exactly as it does for `state` and `reassign`. Three rules decide its shape:

1. **Only movement stamps.** Assigning the same pipeline and stage twice is `changed: false` and leaves `enteredAt`
   alone: a second press is not a re-entry, and restarting the clock on work that did not move is the one historical
   fact this field exists to keep. A different stage (or pipeline) is a new entry and gets a new stamp.
2. **Clearing is explicit.** `pipelineRun: null` is written, not deleted to a missing key — a reader of the file can
   see the choice was cleared rather than never made.
3. **Nothing is retro-assigned.** Adding a pipeline to one task never touches another; a queue file written before this
   pass reads as a queue of tasks on the default path.

Every refusal is named (`pipeline-bundle`, `pipeline-id`, `pipeline-stage`) and says what the bundle does hold, so the
control prints the sentence rather than guessing.

## The bundle, and the seed

`config.pipelineBundleFile` (default `state/pipeline-bundle.json`, beside the job store) is a file exported from the
pipeline studio. The loader (`lib/pipeline-bundle.js`) accepts the studio's own export shapes and refuses a bad bundle
WHOLE, with a code and a locator.

The panel ships `pipeline-bundle.seed.json` at the repo root: the studio's own export of its 13-stage POC-to-UAT
project (`exportBundle(pipeline.seed.json).files.pipeline`), not a fixture assembled to suit the loader. Install it
beside the queue with:

```bash
node tools/seed-pipeline-bundle.mjs           # refuses to replace an existing bundle
node tools/seed-pipeline-bundle.mjs --force   # replace it with the shipped seed
```

**There is no fallback.** With no `pipeline-bundle.json` beside the job store, an assigned task reads
`unresolved` with a reason naming the file — never `assistant-decides`, and never a 500. Absence of a bundle is a fact
the reader can fix; pretending the assignment was the default path would silently drop the pipeline the task was put on.

## Trying it

1. `node tools/seed-pipeline-bundle.mjs`
2. open the panel, Assistant → Queue, press a row's pipeline chip (a task with no assignment says **assistant decides**)
3. choose the pipeline and a starting stage, then press **put it on this pipeline**
4. the row's chip updates; reopen the window to see the stage marked `position of 13`, the moment it began, and the
   elapsed span — recomputed on open, and ticked while the window is open
5. **clear** sends it back to the default path
