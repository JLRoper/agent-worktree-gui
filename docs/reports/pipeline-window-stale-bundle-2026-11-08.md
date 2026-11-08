# The pipeline window cannot offer a pipeline: one stale state bundle

Read-only diagnosis. Written 2026-11-08 00:01 EST (2026-11-08T05:01Z). No code changed and no state
written: the panel's bundle file has the same sha256 before and after this work.

**Verdict: confirmed stale.** The live bundle `~/.wag/state/pipeline-bundle.json` predates the shipped
seed by two days and is missing the `routes` map on gate G1 of `author-review-revise`. Since PR #552 the
loader refuses exactly that shape, and it refuses the bundle WHOLE, so the pipeline window cannot offer a
pipeline to any task. **The one action that fixes it is
`node tools/seed-pipeline-bundle.mjs --force`, run from the repo root.**

Paths in this report are written relative, or as `<dataDir>` for the panel's data directory (this host:
the `.wag` folder under the user's home, the same directory the job store lives in). Where a sentence is
quoted from the panel, the resolved file path it printed has been shortened to `<dataDir>`; nothing else
in the quotes is changed.

## 1. What the window shows

Measured in the running panel at http://127.0.0.1:7331, by pressing a queue row's pipeline chip. Task
#241, which carries no pipeline record, opens in mode `assistant-decides` with two notes: the default-path
sentence, then this, in the error style:

```
no pipeline can be chosen — gate G1 of pipeline author-review-revise declares outcomes accept, reject and
no "routes" map, and the stage it follows (review) has 2 ways out (H-02, H-03) — the driver would fall
back to its edge kind order and take the sequence edge, ignoring the verdict. Route each outcome to the
handoff it should take, or to null for "the pipeline ends here" (at
pipelines[3].gates[0].decision.routes) (incomplete-gate) <dataDir>\state\pipeline-bundle.json
```

That is the whole of the assignment control: the pipeline select, the starting-stage select and the
"put it on this pipeline" button are not drawn at all (measured on the open window: 0 `[data-pipew-pipe]`,
0 `[data-pipew-stage]`, 0 `[data-pipew-apply]`, and the note carries `pipew-note is-bad`). The window is
not empty and not broken - it says, in full, why it cannot offer a choice.

The same refusal is drawn on every row, because the catalogue is one read (`GET
/api/assistant/pipeline-catalogue`) that answers `ok:false` with `pipelines: []`; a row's own record only
changes the body above the note.

A row that still carries a pipeline record opens UNRESOLVED instead, with no stage sequence and no
count. Five rows in this state are on `ping-pong` (all on Assistant #2, tasks #190, #191, #211, #214,
#235). The model for #235:

```
mode: unresolved
reason: the bundle <dataDir>\state\pipeline-bundle.json is refused — incomplete-gate (at
pipelines[3].gates[0].decision.routes): gate G1 of pipeline author-review-revise declares outcomes
accept, reject and no "routes" map, and the stage it follows (review) has 2 ways out (H-02, H-03) — the
driver would fall back to its edge kind order and take the sequence edge, ignoring the verdict. Route
each outcome to the handoff it should take, or to null for "the pipeline ends here"
stages: 0, count: null
```

So the visible damage is two-shaped: no task can be put on a pipeline, and the five tasks that were on
one no longer show where they sit in it.

## 2. The two files

| | live state bundle | shipped seed |
|---|---|---|
| path | `~/.wag/state/pipeline-bundle.json` (`config.pipelineBundleFile`) | `pipeline-bundle.seed.json` (repo root) |
| bytes | 171,744 | 173,151 |
| sha256 | `aa5915f00d35bdb982790a21c925731c5606ed3a35a7fe243623bfb385c56f2b` | `6fac7bedb197a36ca2cfc61434dc49f7acc16ebead9f59695029d359bf445cf6` |
| file mtime | 2026-11-05 14:58:02 -0500 | 2026-11-07 23:53:26 -0500 (worktree checkout) |
| bytes committed at | state, never committed | `cdc0d00`, 2026-11-07 18:54:09 -0500 |

The seed's mtime is when this worktree was checked out, not an edit; its bytes are the ones commit
`cdc0d00` carries (the tree was clean). The live file's hash is the one the 2026-11-07 gated-walk report
recorded for its bundle under test, so nothing has rewritten it since 2026-11-05 14:58 - two days before
`cdc0d00`, and before the PR #552 merge on 2026-11-08.

Both files are read by the panel's own loader, `lib/pipeline-bundle.js`, in the same command:

| file | loader answer |
|---|---|
| live state bundle | `ok:false`, `code:incomplete-gate`, `where:pipelines[3].gates[0].decision.routes` |
| seed | `ok:true`, 11 pipelines: `poc-to-uat`, `ping-pong`, `probe-fix`, `author-review-revise`, `local`, `investigate`, `turnover`, `github-investigate`, `sefl-investigate`, `github-force-merge`, `sefl-review-loop` |

## 3. The diff between the two bundles

A structural walk of both JSON documents finds four differences and nothing else:

1. `pipelines[3].gates[0].decision.routes` is present only in the seed. This is the one that refuses.
2. `pipelines` holds 4 entries in the live file and 11 in the seed.
3. The live file carries a top-level `roles` list of 28; the seed carries none.
4. The bundle `name` is "POC to UAT" live and "SEFL pipelines" in the seed.

Gate G1 of `author-review-revise`, side by side (only `routes` differs):

```json
// live state bundle
{"id": "review-verdict", "path": "ledger/author-review/verdict.json", "schema": "verdict/1",
 "writer": "reviewer", "outcomes": ["accept", "reject"]}

// pipeline-bundle.seed.json
{"id": "review-verdict", "path": "ledger/author-review/verdict.json", "schema": "verdict/1",
 "writer": "reviewer", "outcomes": ["accept", "reject"],
 "routes": {"accept": "H-03", "reject": "H-02"}}
```

The seven pipelines the seed adds, with their stage counts: `local` 1, `investigate` 2, `turnover` 3,
`github-investigate` 2, `sefl-investigate` 2, `github-force-merge` 6, `sefl-review-loop` 7. The four
the live file holds are all in the seed under the same ids, so a replacement loses no pipeline.

The two other differences are cosmetic for the window: the bundle name is a label, and the live
file's bundle-level 28 roles are identical to the `poc-to-uat` pipeline's own 28-role list, while every
pipeline in both files carries its own `roles` array - so dropping the bundle-level copy changes no
role any stage resolves.

**On the null-id pipeline.** The first pipeline in both files has no top-level `id`: its id lives only
under `project.id` (`poc-to-uat`), and the loader falls back to it (`text(rec.id) || text(project.id)`,
`lib/pipeline-bundle.js`). So the live file does carry a pipeline whose top-level id is null, but the seed
carries the same shape and loads, and this is not what refuses the live file. The missing `routes` map is
the whole of it: a scratch copy of the live file with exactly `"routes": {"accept": "H-03", "reject":
"H-02"}` added to G1 loads clean, with its 4 pipelines.

## 4. Why it refuses now

PR #552, "fix: a route-less gate refuses to load, and a row with no PR settles on its verdict": commit
`ca6e027` (2026-11-07 20:47:22 -0500), merge commit `8232ede`, merged 2026-11-08T01:53:19Z into `main`.
It added the no-map branch to `validateRoutes` in `lib/pipeline-bundle.js`: a gate that declares outcomes,
carries no `routes` map, and follows a stage with more than one handoff leaving it fails at load with
`BUNDLE_FAULTS.GATE`.

The stage after the gate is `review`, and it has two ways out:

- `H-02`: `review` -> `author`, kind `loop`, cap "2 rejects" (the rejection edge),
- `H-03`: `review` -> `revise`, kind `sequence` (acceptance, on to revision).

The seed routes `accept` to `H-03` and `reject` to `H-02`, which is the capped reject edge the pipeline's
own description names. Without the map the driver took the edges by kind order (sequence before loop),
so a `reject` would have read as progress into `revise`.

The check runs in the LOADER, so the answer is a refusal for the file and not for one pipeline.
`pdlCatalogue` (`lib/pipeline-source.js`) returns `ok:false` with `pipelines: []`, which is why the other
three pipelines disappear from the window with `author-review-revise`. The catalogue payload, measured
live:

```json
{"ok": false, "code": "incomplete-gate",
 "reason": "gate G1 of pipeline author-review-revise declares outcomes accept, reject and no \"routes\" map, and the stage it follows (review) has 2 ways out (H-02, H-03) — the driver would fall back to its edge kind order and take the sequence edge, ignoring the verdict. Route each outcome to the handoff it should take, or to null for \"the pipeline ends here\" (at pipelines[3].gates[0].decision.routes)",
 "where": "pipelines[3].gates[0].decision.routes",
 "file": "<dataDir>\\state\\pipeline-bundle.json",
 "name": null, "pipelines": []}
```

## 5. What does not fix it

Importing the seed from Settings > Pipeline bundles. An import merges into the bundle already on disk and
refuses to start from one this panel cannot read (`lib/pipeline-bundle-import.js`, rules 1 and 2). Measured
with the two live documents, `planImport(live, seed)` answers:

```
ok:false, code:live-bundle-unreadable
reason: the bundle already on disk cannot be read at pipelines[3].gates[0].decision.routes — gate G1 of
pipeline author-review-revise declares outcomes accept, reject and no "routes" map, ... (the same sentence)
```

So the reader cannot import the shipped seed over the stale file from the UI. The stale file has to be
replaced, not merged into.

PR #552's own body names "re-importing the seed" as the reader's fix. That sentence is not what the
import does: it merges into the bundle already on disk, and this file is one it cannot read, so the
import refuses with the same G1 sentence. The seed tool replaces the file instead, which is the action
in section 6.

## 6. The one action that fixes it

From the repo root:

```bash
node tools/seed-pipeline-bundle.mjs --force
```

It validates the seed with the panel's own loader before writing, then copies it over the target that
`lib/paths.js` resolves (`~/.wag/state/pipeline-bundle.json` here). It refuses without `--force` - measured:
`seed-pipeline-bundle: <dataDir>\state\pipeline-bundle.json already exists — leave it alone, or pass
--force to replace it with the shipped seed`, exit 1 - so the flag is the deliberate replacement and not a
default. No merge and no restart: the panel reads the bundle once per request (`lib/pipeline-source.js`,
`readPipelineSource`), so the next window open reads the new file.

What the reader gets: the bundle named "SEFL pipelines" with 11 pipelines; the four ids the state file
holds today are all in it, and the seven ladders arrive with it. The catalogue then answers `ok:true` and
the assign form (pipeline select, starting stage, apply) is drawn again.

## 7. Reproduction

Read-only, and enough to re-run this diagnosis without changing anything:

```bash
# the loader's answer on both files (refused / ok, 11 pipelines)
node --input-type=module -e "import { readBundle } from './lib/pipeline-bundle.js'; for (const f of ['<dataDir>/state/pipeline-bundle.json','pipeline-bundle.seed.json']) { const r = readBundle(f); console.log(f, r.ok, r.code, r.where, r.ok ? r.bundle.pipelines.length : ''); }"

# the catalogue exactly as the window reads it (port from config.json)
curl -s "http://127.0.0.1:7331/api/assistant/pipeline-catalogue"

# the import refusal: the UI route cannot be the fix
node --input-type=module -e "import fs from 'node:fs'; import { planImport } from './lib/pipeline-bundle-import.js'; const live=JSON.parse(fs.readFileSync('<dataDir>/state/pipeline-bundle.json','utf8')); const seed=JSON.parse(fs.readFileSync('pipeline-bundle.seed.json','utf8')); const p=planImport(live, seed); console.log(p.ok, p.code, p.where);"
```

The window's own text is the DOM of the open dialog: `#pipew-card` holds the two notes, and its
`data-pipew-mode` reads `assistant-decides` (rows with no record) or `unresolved` (the five ping-pong
rows).

## 8. Scope

No code change, and no state change: the live bundle still hashes
`aa5915f00d35bdb982790a21c925731c5606ed3a35a7fe243623bfb385c56f2b` after this diagnosis. The single write
is the one in section 6, and it is the reader's to make. The diagnosis is also not a claim that the stale
file was wrong when it was written: it loaded before #552, and the route it was missing is exactly the
ambiguity #552 was merged to refuse.
