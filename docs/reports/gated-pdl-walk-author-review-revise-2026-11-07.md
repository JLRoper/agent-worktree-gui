# A gated PDL pipeline, walked end to end

A single throwaway queue task was driven through `author-review-revise` - its three stages, its sequence handoff, its
capped reject edge and its gate - by a sandbox panel booted from a copy of the reader's own state, with
`settings.spawn` set to `auto`. The panel was left to its own clock: no stage was started by hand, no sweep was called
from the harness, and the only write the harness made during the walk was the gate's decision record, which is a
reviewer's output and never the panel's.

**Result. The gate stops the row, and it is the only thing that does.** On both bundles the row parks at `G1` after
`review#1` with `waitingFor.kind: gate`, and leaves the park on the sweep after the record lands - no press, no
requeue. What differs is where the record sends it. The bundle the reader's panel actually holds has no `routes` map on
`G1`, so a `reject` verdict is not read at all: the driver falls back to its edge kind order and takes the `sequence`
edge, sending the manuscript forward to `revise`. The reject loop (`H-02`, cap `2 rejects`) is never entered and its
cap never charges. The same task on the shipped seed, whose `G1` does declare `{"accept": "H-03", "reject": "H-02"}`,
walks the documented loop: reject -> author #2, reject -> author #3, accept -> revise, pipeline over. The row then
stays `running` in both runs, because the last settle finishes a row on the landing rule and the sandbox tree's verdict
is never `MERGED`.

Measured 2026-11-07 on this landing tree at `91752da`, panel version `1.53.3`.

| | |
|---|---|
| bundle under test, walk A | the copied `~/.wag/state/pipeline-bundle.json`, sha256 `aa5915f00d35bdb982790a21c925731c5606ed3a35a7fe243623bfb385c56f2b` |
| bundle under test, walk B | the shipped `pipeline-bundle.seed.json`, sha256 `74cabf10916b9e7fb7f5c21d35e10e6d5627b11f9dfad593ee6a10aef97c9bb0` |
| the one variable between A and B | `gates[G1].decision.routes` - `absent` in A, `{"accept": "H-03", "reject": "H-02"}` in B |
| switch | `settings.spawn = auto` on the assistant that owns the row, written through `POST /api/assistant/settings` |
| stage sequence, walk A | `author#1 -> review#1 -> revise#1` |
| stage sequence, walk B | `author#1 -> review#1 -> author#2 -> review#2 -> author#3 -> review#3 -> revise#1` |
| wall clock, the switch to the last settle | A 201.8s, B 439.0s (one stage boundary costs up to the 60s wait ticker, see finding 5) |

## 1. The sandbox

The panel was started by `tools/panel-testkit.mjs` (the real `server.js`, its own port, its own config, its own
`HERMES_HOME`) against a **copy** of the reader's state, not the state itself:

| | |
|---|---|
| copied | `~/.wag/state` in full, 10.8 MB - the bundle, `assistant.json`, `assistants.json`, every assistant's charter, settings and queue |
| blanked in the COPY | `jobs.json` (80 cards, any of which can re-run an action line on boot), and in `assistant.json`: alerts 80, watches 40, spawnIntents 60, terminalWakes 100, restartWakes 25, harvested 50, journal 300. A spawn card with auto-start on would have started a run of its own |
| switched off in the copy | `enabled: false` on every assistant, so no sentry turn is sent; the queue sweep runs either way |
| clock | `seconds: 2` on Assistant #1, written through `POST /api/assistant/settings` and read back |
| project | a throwaway git repo in the sandbox, registered as the only project; the tree is cut by the panel's own `git worktree add` |
| gateway | a scripted Runs API (`seat-gateway.mjs`, in the scratch dir): it answers `POST /v1/runs`, writes the stage's declared artifact into the `cwd` it was handed, commits it, and - for `review` - writes the gate's decision record |
| model | none. The seat is the stand-in for the model, so this proves the PANEL's driving, not a model's work |

Only the volatile stores were blanked in the copy, and nothing else was: the bundle, the assistant records and every profile are
the reader's own bytes, and `pipeline-bundle.json` keeps its hash `aa5915f00d35bdb982790a21c925731c5606ed3a35a7fe243623bfb385c56f2b` before and after the copy.

The switch is load-bearing, and it was measured before it was flipped: the task was filed and put on
`author-review-revise` while the copied profile still read `spawn: "off"`, and for six seconds (three 2s sweeps) the row
sat `queued` at `author` with **zero** stage runs. `spawn: auto` was then written through the settings route and the
walk began.

## 2. The document the panel actually holds

The two bundles differ in exactly one field. On the copy, `G1` declares its record and its two outcomes and no routes:

```json
"decision": { "id": "review-verdict", "path": "ledger/author-review/verdict.json", "schema": "verdict/1",
              "writer": "reviewer", "outcomes": ["accept", "reject"] }
```

The shipped seed declares the map as well:

```json
"routes": { "accept": "H-03", "reject": "H-02" }
```

This is drift, not a typo, and it is dated. The copy's file was last written 2026-11-05 14:58; the commit that added
`routes` to the seed is `b469dd9` ("fix: a first visit is handed nothing, and a converged loop ends at its verdict"),
committed 2026-11-05 16:58 - two hours later. A panel keeps the bundle it was given: a change to the seed does not
reach the reader's copy.

Nothing in the loader objects. `lib/pipeline-bundle.js` normalises `routes` only when it is present
(`if (raw.routes != null)`, line 158) and `validateRoutes` returns immediately without it, so a decision that declares
outcomes and routes none of them loads clean - although the same file's own comment says an outcome with no route "is
the state this field exists to remove".

## 3. Walk A - the copied bundle

| t | task state | stage | visits | stage runs | last run | waiting | decision code |
|---|---|---|---|---|---|---|---|
| 0.4s | queued | author | author 1 | 0 | - | - | - |
| 15.2s | queued | author | author 1 | 1 | - | - | - |
| 40.3s | running | author | author 1 | 1 | - | - | - |
| 77.5s | queued | review | author 1, review 1 | 2 | - | - | - |
| 95.7s | running | review | author 1, review 1 | 2 | - | - | - |
| 134.1s | parked | review | author 1, review 1 | 2 | done | gate | pipeline-gate |
| 141.6s | queued | revise | author 1, review 1, revise 1 | 3 | - | - | - |
| 151.9s | running | revise | author 1, review 1, revise 1 | 3 | - | - | - |
| 196.0s | running | revise | author 1, review 1, revise 1 | 3 | done | - | - |

The gate stop, verbatim from the row (paths scrubbed):

```
gate G1 (Accept or reject) follows review and declares a decision record at <path>/ledger/author-review/verdict.json
- the code does not decide it, and the record has not been written
```

Three stage runs, and the second one is the decisive one:

| stage run | status | thread | commit | artifact present | artifact sha256 | decision |
|---|---|---|---|---|---|---|
| `author-review-revise/author#1` | done | `wtgui-write-the-manuscript-the-bri-1a8` | `7461d6362d` | True | `e24085620f` | stage-settled |
| `author-review-revise/review#1` | done | `wtgui-read-the-manuscript-against-b9f2` | `0950241bc3` | True | `c6866c1d77` | gate-record |
| `author-review-revise/revise#1` | done | `wtgui-apply-the-reviewer-s-accepte-72b` | `24abfa7fef` | True | `9a2b1e31bf` | stage-settled |

The gate's record was written by the harness at the park (a reviewer's second write, after its run had ended), and the
very next sweep released the row - into `revise`, not `author`. The crossings say it plainly: `H-01 1, H-03 1`. `H-01`
(author -> review) was crossed once, `H-03` (review -> revise) once, and `H-02` - the capped back edge - never. The
`reject` in the record was not read, because there was no `routes` map to read it against; `edgeOutOf` ordered the two
edges leaving `review` as `sequence` before `loop` and the sequence won.

The seat's own runs (what the panel asked for, and what came back):

| run | bundle provenance | the seat did | commit |
|---|---|---|---|
| `run_seat_0001` | author-review-revise/author visit 1 | manuscript written | `7461d6362d` |
| `run_seat_0002` | author-review-revise/review visit 1 | review written, verdict held back (the barrier under test) | `0950241bc3` |
| `run_seat_0003` | author-review-revise/revise visit 1 | revision written | `24abfa7fef` |

The tree the panel cut carries one commit per stage run, and a clean status:

| commit | subject |
|---|---|
| `28959df` | main: fixture start |
| `7461d63` | author: manuscript visit 1 |
| `0950241` | review: review.md visit 1 (reject) |
| `4d3f8a9` | review: verdict reject (written after the run ended) |
| `24abfa7` | revise: revision visit 1 |

End state: `running` at `revise` after 3 stage runs, visits {"author": 1, "review": 1, "revise": 1}, crossings H-01 1, H-03 1, 201.8s from the switch to the last settle. Board row for the tree at the end: none - only the project checkout was listed.

## 4. Walk B - the shipped seed, same task and same switch

The only change is the bundle in the sandbox: `pipeline-bundle.seed.json` was copied over the sandbox's
`pipeline-bundle.json` before the panel booted. Everything else - the state copy, the fixture, the seat, the switch -
is identical.

| t | task state | stage | visits | stage runs | last run | waiting | decision code |
|---|---|---|---|---|---|---|---|
| 0.0s | queued | author | author 1 | 0 | - | - | - |
| 16.3s | queued | author | author 2 | 1 | - | - | - |
| 32.3s | running | author | author 3 | 1 | - | - | - |
| 88.3s | queued | review | author 3, review 1 | 2 | - | - | - |
| 104.1s | running | review | author 3, review 2 | 2 | - | - | - |
| 133.4s | parked | review | author 3, review 3 | 2 | done | gate | pipeline-gate |
| 141.3s | queued | author | author 4, review 3 | 3 | - | - | - |
| 156.8s | running | author | author 5, review 3 | 3 | - | - | - |
| 195.2s | queued | review | author 5, review 4 | 4 | - | - | - |
| 207.7s | running | review | author 5, review 5 | 4 | - | - | - |
| 258.2s | queued | author | author 6, review 5 | 5 | - | - | - |
| 263.7s | running | author | author 7, review 5 | 5 | - | - | - |
| 314.7s | queued | review | author 7, review 6 | 6 | - | - | - |
| 325.3s | running | review | author 7, review 7 | 6 | - | - | - |
| 377.0s | queued | revise | author 7, review 7, revise 1 | 7 | - | - | - |
| 388.1s | running | revise | author 7, review 7, revise 2 | 7 | - | - | - |
| 433.0s | running | revise | author 7, review 7, revise 3 | 7 | done | - | - |

Seven stage runs, both reject crossings and the accept:

| stage run | status | thread | commit | artifact present | artifact sha256 | decision |
|---|---|---|---|---|---|---|
| `author-review-revise/author#1` | done | `wtgui-write-the-manuscript-the-bri-539` | `632f971579` | True | `e24085620f` | stage-settled |
| `author-review-revise/review#1` | done | `wtgui-read-the-manuscript-against-8959` | `508284a652` | True | `c6866c1d77` | gate-record |
| `author-review-revise/author#2` | done | `wtgui-write-the-manuscript-the-bri-f07` | `a1d5543c95` | True | `0e7ebbbab0` | stage-settled |
| `author-review-revise/review#2` | done | `wtgui-read-the-manuscript-against-7688` | `6233034157` | True | `7e9b83cc4a` | stage-settled |
| `author-review-revise/author#3` | done | `wtgui-write-the-manuscript-the-bri-8a6` | `33295ab8cb` | True | `d37c12e7e2` | stage-settled |
| `author-review-revise/review#3` | done | `wtgui-read-the-manuscript-against-22fb` | `e616e03bfc` | True | `23cff2f992` | stage-settled |
| `author-review-revise/revise#1` | done | `wtgui-apply-the-reviewer-s-accepte-ce3` | `959afd7a69` | True | `9a2b1e31bf` | stage-settled |

The gate stops the row at `review#1` exactly as in A (`pipeline-gate`, `waitingFor.kind: gate`), and the record
releases it to `author` - `H-02`, crossing 1 of a cap of 2. The second review rejects again (crossing 2 of 2), the
third accepts, and `H-03` carries the notes to `revise`. Crossings: `H-01 3, H-02 2, H-03 1`. The cap was never reached, so the
row never parks on it. The last stage settles, the pipeline is over, and the row is left to the landing rule.

| run | bundle provenance | the seat did | commit |
|---|---|---|---|
| `run_seat_0001` | author-review-revise/author visit 1 | manuscript written | `632f971579` |
| `run_seat_0002` | author-review-revise/review visit 1 | review written, verdict held back (the barrier under test) | `508284a652` |
| `run_seat_0003` | author-review-revise/author visit 2 | manuscript written | `a1d5543c95` |
| `run_seat_0004` | author-review-revise/review visit 2 | review and verdict written | `6233034157` |
| `run_seat_0005` | author-review-revise/author visit 3 | manuscript written | `33295ab8cb` |
| `run_seat_0006` | author-review-revise/review visit 3 | review and verdict written | `e616e03bfc` |
| `run_seat_0007` | author-review-revise/revise visit 1 | revision written | `959afd7a69` |

| commit | subject |
|---|---|
| `4ffcf1a` | main: fixture start |
| `632f971` | author: manuscript visit 1 |
| `508284a` | review: review.md visit 1 (reject) |
| `bf42df2` | review: verdict reject (written after the run ended) |
| `a1d5543` | author: manuscript visit 2 |
| `42ebcad` | review: review.md visit 2 (reject) |
| `6233034` | review: verdict reject visit 2 |
| `33295ab` | author: manuscript visit 3 |
| `3eb6cad` | review: review.md visit 3 (accept) |
| `e616e03` | review: verdict accept visit 3 |
| `959afd7` | revise: revision visit 1 |

End state: `running` at `revise` after 7 stage runs, visits {"author": 3, "review": 3, "revise": 1}, crossings H-01 3, H-02 2, H-03 1, 439.0s from the switch to the last settle. Board row for the tree at the end: none - only the project checkout was listed.

## 5. Where it stops, exactly

1. **The gate is a real barrier.** In both walks the row parks the moment `review#1` settles, with
   `waitingFor.kind: gate` and the record's path on the row. Nothing is started while it is parked. This is the
   barrier working, not a fault.
2. **The record is the release.** In both walks the row leaves the park on the first sweep after the file appears,
   moved by the panel with no press and no requeue. A gate whose record never arrives would stay parked; that is the
   designed end state.
3. **The route is the document's, and the reader's document has none.** With no `routes`, a verdict cannot decide the
   edge: `reject` is ignored and the driver's kind order takes `sequence` (`H-03`) before `loop` (`H-02`). The reject
   path, and the `2 rejects` cap that bounds it, are unreachable on the reader's bundle. The walk still "finishes" -
   which is what makes it dangerous: a rejection that cannot be sent back reads on the board as progress.
4. **The row does not close.** After the last stage settles the pipeline is over, but `settleTasks` finishes a row on
   its landing rule: a row with a tree is `done` only when that tree's PR reads `MERGED`. The sandbox tree has no
   remote and no PR, so the row stays `running` at `revise` in both walks. Board row for the tree at the end: none - only the project checkout was listed. A pipeline that ends without a
   landing PR therefore leaves its row open by design, and nothing on the row says the pipeline is over.
5. **A stage boundary is priced by the jobs ticker, not the assistant sweep.** The stage's run is held in the tree's
   pipeline record, and the 60s `PIPELINE_WAIT_TICK_MS` sweep in `server.js` is what advances it; the assistant's 2s
   sweep is only the fallback after the 3-minute hold owner window. Measured boundaries (the moment the row was read at the next stage): A
   author -> review at 77.5s; review -> revise at 141.6s; B author -> review at 88.3s; review -> author at 141.3s; author -> review at 195.2s; review -> author at 258.2s; author -> review at 314.7s; review -> revise at 377.0s. A three-stage walk costs minutes, not seconds, and a long pipeline costs one
   tick per boundary.

## 6. Teardown

Both runs were stopped by the harness itself, and the harness checked the stop rather than assuming it:

- Walk A: panel port closed: **True** (pid None); seat gateway port closed: **True** (pid None); sandbox directory exists after the run: **False**.
- Walk B: panel port closed: **True** (pid None); seat gateway port closed: **True** (pid None); sandbox directory exists after the run: **False**.
- After both: the scratch root was listed for survivors (`netstat` for the two ports, `ps` for a `node` whose cwd is
  inside either sandbox, and a directory check), and the scratch tree under the task's scratch directory was removed
  at the end of this run. The ledgers those tables were read from lived in that scratch tree and went with it; the tables
  above, and the file paths they name, are what remains of the evidence.

No worktree was created in the panel's own repo to build the sandbox, and the reader's `~/.wag/state` was only read:
the copy is the thing that was written, and it was deleted with the sandbox.

## 7. Reproduce

The harness is throwaway (it lives in the task's scratch dir and is not committed, because it writes a fixture repo
and a copied state and is not part of the panel's product surface). Its shape:

1. Copy `~/.wag/state` to `<sandbox>/state`; blank `jobs.json` and the assistant's `alerts`, `watches`, `spawnIntents`,
   `terminalWakes`, `restartWakes`, `harvested` and `journal` in the COPY; set `enabled: false` on every assistant.
2. Optionally copy `pipeline-bundle.seed.json` over `<sandbox>/state/pipeline-bundle.json` (walk B).
3. `git init -b main` a fixture repo with one commit, and register it as the only project (`scanRoots` an empty dir).
4. Start the scripted seat on a free port; boot the panel with `apiServer.url` at that port, `dataDir` at the copied
   state, `slowSeconds`/`worktreeSeconds` at 5, `fetchSeconds` `-1`.
5. `POST /api/assistant/settings {assistantId, seconds: 2}`, then `POST /api/assistant/queue {action: add}`, then
   `{action: pipeline, pipeline: "author-review-revise", stage: "author"}`; observe the row without `spawn: auto`, then
   write `spawn: auto` and stop touching it.
6. Poll `GET /api/assistant/queue?assistantId=<id>` and record every transition; when the row parks with
   `pipeline-gate` at `review`, write `ledger/author-review/verdict.json` with `{"outcome": "reject"}` in the tree.

## 8. What this says to fix

1. **The bundle the panel holds is stale.** Re-import the current seed (or re-export from the studio) so `G1` carries
   its `routes`. Until then, every rejection on this pipeline advances the manuscript, and the loop's cap is dead
   letter. This report does not touch the reader's state; the fix is an import, on the reader's side.
2. **The loader should refuse, or at least warn, a decision that declares outcomes and no routes.** Its own comment
   states the rule; `normaliseDecision` and `validateRoutes` only enforce it when `routes` is present. One `warn` at
   load time - "declares accept, reject and routes neither" - is what would have caught this before a task was driven.
3. **A pipeline row's end is invisible.** The last stage settling leaves the row `running` with no field saying the
   pipeline is over; the landing rule is the only thing that finishes it, and a tree with no PR never satisfies it. A
   row at the last stage whose run has settled should say so, even when the landing rule keeps it open.
