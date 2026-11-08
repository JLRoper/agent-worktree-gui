# The two pipeline definitions this panel reads

Recon for "the Settings pipeline tab and the queue's task-pipeline picker read different pipeline
definitions". Both are called "pipelines" on screen and neither is the other. This document records
what each side reads today, in what shape, through which validator, and the one source they are
being moved onto. It was written before any code changed so a cut turn keeps the finding.

## What the reader sees

Read live from the running panel (port 7331, data folder `~/.wag`):

| where | route | file | what it holds |
| --- | --- | --- | --- |
| Settings > Pipeline | `GET /api/pipelines` | `<dataDir>/state/pipelines.json` over the shipped `pipelines.seed.json` | 7 definitions: `local`, `investigate`, `turnover`, `github-investigate`, `sefl-investigate`, `github-force-merge`, `sefl-review-loop` |
| Queue > a task's pipeline window, and Settings > Pipeline bundles | `GET /api/assistant/pipeline-catalogue` | `<dataDir>/state/pipeline-bundle.json` (`config.pipelineBundleFile`) | 4 pipelines: `poc-to-uat` (13 stages), `ping-pong` (2), `probe-fix` (2), `author-review-revise` (3) |

Zero ids are shared. A reader who imports a PDL document sees it in one place and not the other, and
the task pipeline window's `pipeline` select only ever offers the second list.

## The two shapes

The Settings catalogue (`lib/pipelines.js`) is the TREE LADDER, not a runnable sequence:

```json
{ "version": 1, "pipelines": { "turnover": {
  "id": "turnover", "title": "Turnover", "kind": "turnover", "next": null,
  "stages": [ { "id": "cut", "title": "...", "prompt": "...", "exit": { "check": "clean" } } ] } } }
```

`kind` (`local` / `investigation` / `turnover`) and `next` are the document's own words for what a
TREE may do with a branch (`docs/pipelines.md`). Its stages carry a prompt and an exit check and
nothing else: no gates, no handoffs, no artifacts, no isolation.

The task bundle (`lib/pipeline-bundle.js`) is a PDL document set:

```json
{ "bundleVersion": 1, "name": "POC to UAT", "pipelines": [ {
  "project": { "id": "poc-to-uat", "name": "POC to UAT" },
  "stages": [ { "id": "S0", "title": "...", "artifact": { "id": "charter", "path": "..." }, "owner": { "role": "..." } } ],
  "gates": [ { "id": "G4", "after": "S3", "artifact": "...", "decider": "..." } ],
  "handoffs": [ { "id": "H-1", "from": "S0", "to": "S1", "kind": "sequence" } ],
  "external_inputs": [ ] } ] }
```

Stages carry an artifact and a role, gates end stages, handoffs join them, `external_inputs` names
what the document does not write. `isolation` (`shared` / `per-stage`) rides the pipeline record.

## The two validators, and why they cannot agree

`lib/pipelines.js` (`validatePipeline`) DROPS a bad definition BY ID and keeps the rest, because the
reader hand-edits that file: one typo must not empty the board.

`lib/pipeline-bundle.js` (`parseBundle`) REFUSES a bad bundle WHOLE with a code and a locator
(`pipelines[0].stages[2]`), because a bundle is one authored artefact and half of it is a stage order
that disagrees with its own gates.

Neither module can validate the other's document: a ladder definition has no `gates`/`handoffs` and
would be refused as an incomplete pipeline, and a PDL document has no `kind`/`next` and would be
dropped as an unknown definition. That is the divergence, and it is a shape difference, not a bug in
either validator.

## Where ai-pipeline-factory fits

The factory's store is a directory of PDL documents (`pipelines/*.json`, one per pipeline, e.g.
`poc-breaking-suite.json`: 9 stages, 8 handoffs, 2 gates, 7 roles, 5 external inputs) read once at
boot. Its `GET /api/pipelines` serves SUMMARIES only:

```json
[{ "id": "poc-breaking-suite", "title": "POC-breaking suite - six layer questions, two answered", "stageCount": 9 }]
```

It never serves a stage's id, order or artifact, and it has no per-document route. So the factory's
index cannot drive the queue picker on its own: a picker needs a stage to start a task at, and an
index row has none. The panel's `pipeline-bundle.json` is the wrapper that carries those same PDL
documents whole, and `POST /api/assistant/pipeline-bundle/import` (`lib/pipeline-bundle-import.js`)
is how one gets in, appending by pipeline id and never replacing what is held — with one exception, the repair: a
live file the loader refuses WHOLE (or cannot parse at all) is REPLACED by the document being imported, and the
answer says it is a repair and names the fault of the file it replaces. A bundle that loads is never replaced.

Both readers already stand on `parseBundle` for the bundle, and on nothing shared for anything else:
`lib/pipeline-window.js` and `lib/task-pipeline-assign.js` each call `readBundle(config.pipelineBundleFile)`
themselves, and the Settings catalogue never reads the bundle at all. There are three reads of one
file and no single answer that says "these are the panel's pipelines".

## Where the two lists meet

`GET /api/pipelines` carries the PDL catalogue as `pdl` beside the ladder (both from the reads above), and the
Settings tab's one dropdown draws both lists from that answer: an **PDL pipelines** group first, each option tagged
`PDL · <id>` with its stage count, then the **built-in ladders** group. The option value namespaces the two
(`pdl:<id>` vs a ladder id), so one control can carry both without a second selector.

Selecting a PDL pipeline is a read, not an edit: it closes the ladder editor (that form edits a different object) and
`open the flow` draws the pipeline with `public/core/pipeline-mermaid.js` from the catalogue's own stages, gates and
handoffs — a node per stage, an arrow per `sequence` handoff labelled with the gate that ends the stage it leaves, a
dashed arc per `loop` handoff with its cap, and the gates list beside it. `open the map` follows the selection too:
with a PDL pipeline selected it opens `/pipeline-map.html?doc=/api/assistant/pipeline-catalogue`, so the page draws
the pipelines this install actually holds instead of the shipped seed.

No execution path changes: a task's pipeline run is still the queue's assignment (`lib/task-pipeline-assign.js`),
and the ladder editor still edits `pipelines.json`.

## The finding

1. The two lists come from two files with two formats and two validators, so "the pipelines" means
   two different sets depending on which control the reader pressed.
2. The picker is not wrong, it is answering a different question: it lists the PDL bundle, which is
   the only source that can resolve a stage for a task.
3. The Settings tab is not wrong either: it lists the ladder, which is the only source that names a
   tree's rung.
4. What is missing is ONE reading both sides can quote: one module that resolves the PDL bundle, one
   validation path through `parseBundle`, and one place that says which pipelines the panel holds and
   why a file was refused.

## The change this recon justifies

- `lib/pipeline-source.js`: the panel's ONE read of the PDL bundle. It resolves
  `config.pipelineBundleFile`, validates with `parseBundle`, and returns the catalogue
  (`{ok, code, reason, where, file, name, pipelines[]}`) that both the queue picker and the Settings
  tab quote. The window route and the import route read through it as well, so no route calls
  `readBundle` on its own.
- `GET /api/pipelines` carries that same catalogue as `pdl` beside the ladder, so the Settings
  pipeline tab can list the pipelines the queue picker offers, with the bundle's own refusal when
  there is one, from the same answer the picker gets.
- The Settings pipeline tab draws those PDL pipelines beside the ladder definitions, labelled as the
  list a task can be put on. The ladder editor is untouched: it edits a different object.
- PDL format unchanged. No document is rewritten, no field renamed, no new bundle version. A factory
  export is still imported as it is and still read by `parseBundle`.

Non-goals: no change to the factory's routes or its store; no change to `pipelines.json` /
`pipelines.seed.json` or to the ladder editor; no change to a task's stored `pipelineRun`.
