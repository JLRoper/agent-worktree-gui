# Adopting the stage contract: what it costs, and what order the work lands in

**Analysis C of 3 for task #50.** Docs-only. No code, no plan, no effort estimate beyond S/M/L.

**Measured against:** `main` at 0.68.4 (`b4ee813`), 2 November 2026. All six P0 findings in `docs/pipelines-audit.md` are fixed at this commit: P0-1..P0-4 landed as `e0ae8a4` (the brief's `0195d75` is the same commit before the rebase merge — same tree `a6d7f28`, and `0195d75` is not an ancestor of `main`), P0-5/P0-6 as `b4ee813`. The guide is the SEFL AI Development Factory's *A stage is a contract* (its own reference commit `ae431e5`); it is not vendored in this repository — the untracked HTML copy this analysis was drafted against was deleted rather than committed.

**Sources:** the guide §02 (the twelve fields), §05 (the YAML and the prompt projection), §06 (the verifier example), §08 (rule citation); `docs/pipelines.md`; `pipelines.seed.json`; `lib/pipelines.js`; `server.js`'s pipeline routes; `config.json`; `docs/pipelines-audit.md`; `tools/render-pipelines.mjs`.

## 0. The answer

The guide is a **stage** contract, not a pipeline engine. The board already has the engine's skeleton — a catalogue loaded from `pipelines.seed.json` over `pipelines.json`, a tree-keyed record, a switch route, and a closed vocabulary of 14 exit checks (`lib/pipelines.js:43-58`). Adoption has two costs that are easy to confuse:

| the cost | what it is | size |
|---|---|---|
| **The shape** | a v2 stage with the twelve fields; the 23-stage seed; the loader and its v1→v2 migration; one read route; two settings write routes; the catalogue renderer | **M** (the settings write and the turn start are **L** each) |
| **The readers** | the chip (#38), the tab (#39), the timer (#40), and the exit-check evaluator they all need | **L** |

The shape is cheap because it is data and validation. The readers are expensive because the evaluator and four host readers do not exist: `main-moved` has no baseline, `pr-comments` has no activities reader, `pr-approved` has no `lastReviewedCommit`, and `reviewers-exact` has no reviewer field — `normalisePr` returns `{number, state, mergedAt, headRefName, headRefOid, title}` only (`lib/project.js:251-265`). The full semantics the guide assumes — one roster role per stage, hashed input artifacts, a `P-*`/`SEFL-*` rule corpus, a ledger, a control plane acting on stop codes — are **L/XL** and mostly outside this repository.

The six P0 fixes change what the three surfaces are waiting for, and that is this document's main correction to the draft. The record now survives a corrupt book and a failed write (P0-1/P0-2), the child cut writes its rung (P0-5), and the local prompt and the hole scanner are coherent (P0-3/P0-6). What remains is **shape and data**, not durability: the read payload (P1-1), a migration that cannot invent eight fields, the loop's missing edges (P1-5), and the evaluator's four missing host readers. The chip is the cheapest reader; the timer is the long pole.

## 1. The delta in numbers

The seed ships **seven definitions and 23 stages**. A stage today carries four fields — `id`, `title`, `prompt`, `exit` — so the catalogue holds 92 field-values. The guide's stage carries twelve: a full migration is 276 field-values, a net **184** new ones. Of those, 23 are `binds: []` (the guide's own "say none when it is none"), so the seed authors **161 substantive values plus 23 empty lists**. Most of the 161 are prose — `purpose`, `method`, `stops`, `forbidden` — not booleans. The count is the cost driver: the seed migration is an editorial job, not a rename.

The draft's "207" counted `method` as a wholly new field; it is a transcription of the stage's `prompt`, so the source exists and the field is not invented. The draft's "184 if every binds is empty" mixed the net delta with the binds subtraction: 184 is eight new fields × 23; 161 is what is left after the 23 empty `binds`.

| pipeline | kind | stages |
|---|---|---|
| local | local | 1 — work |
| investigate | investigation | 2 — probe, conclude |
| turnover | turnover | 3 — commit, push, pr |
| github-investigate | investigation | 2 — probe, conclude |
| sefl-investigate | investigation | 2 — probe, conclude |
| github-force-merge | turnover | 6 — commit, version, push, pr, merge, main |
| sefl-review-loop | turnover | 7 — branch, push, pr, wait, address, approve, merge |
| **7** | | **23** |

The seed uses **10 of the 14** exit checks: `commits` (6 stages), `pushed` (4), `pr-open` (3), `file-exists` (3), `pr-merged` (2), and one each of `command`, `main-moved`, `branch-name`, `pr-comments`, `pr-approved`. The four unused — `clean`, `branch-exists`, `pr-head`, `reviewers-exact` — are exactly the checks P1-9 says the turnover seeds drop.

Two more counts decide F01/F02. The 23 instances carry **13 distinct stage ids**: `probe`/`conclude` recur in the three investigation pipelines, and `push`/`pr`/`merge` recur across the turnover ones. The guide's global `S<n>` is therefore a new key (`guide_id`/`spine`), not a rename of the existing slug. And 22 of 23 titles already satisfy the ≤4-word `name` rule; `Wait for the approval at the head` (`pipelines.seed.json:197`) is the one that must shorten.

## 2. The seed catalogue

### 2.1 What each field gains

| guide field | today | v2 seed | what it gains / how it maps |
|---|---|---|---|
| F01 `id` | `stage.id` (slug) | `stage.id` (slug) + optional `guide_id` | The guide wants `S<n>`, permanent. The board's ids are slugs the record, the loop and the seed already use; renaming them would break the `branch` stage's parameters and every history entry. Keep the slug; carry `S<n>` in `guide_id` if a ledger must cite it. |
| F02 `name` | `stage.title` | `stage.name`, `title` aliased | The guide's verb phrase ≤ 4 words; the seed's titles are already close (`Work in this tree`, `Probe`, `Push the branch`). The loader accepts `title` as a v1 alias and normalises to `name`. |
| F03 `purpose` | — | `stage.purpose` | One sentence naming the artifact. 23 new sentences; the only source is the stage's prompt. |
| F04 `owner` | — | `{role, kind}` | Exactly one role + kind. The board has no roster; the one actor is `{role: "board-worker", kind: "agent"}`. A SEFL roster row would be a lie about who works the stage. |
| F05 `inputs` | — | `{read: [...], non: [...]}` | Schema/location/hash/mutability per artifact. The board's inputs are `{{tree}}`, `{{branch}}`, `{{sha}}`, `{{pr}}`; the hashes are git object ids, not sha256. The hard stages are `wait`/`address`/`approve` (the PR and its comments) and `merge` (the PR's version). |
| F06 `trigger` | — | `{fires, when}` | Firer + a predicate over the input hashes. The board's firer is the panel; the predicate is "the tree record enters this stage and the tree's HEAD resolves". |
| F07 `binds` | — | `stage.binds: []` | Rule ids in `P-*`/`SEFL-*`/`R-*`. This repo holds no rule corpus and the seed's stages cite none. The guide's "say none when it is none" is the legal answer; a non-empty binds needs an imported corpus. |
| F08 `method` | `stage.prompt` (prose) | `stage.method` | `deterministic[]`, `judgement[]`, `on_ambiguity`. The seed's prompt is the method; transcribing it is the editorial work. Keeping the prompt as an optional override is the cheaper legal path (§3.1). |
| F09 `artifact` | — | `stage.artifact` | One artifact with id/path/schema/hash/writer. The seed's stages produce a commit, a branch, a PR or a file; `wait`/`approve` produce a poll record, not an artifact — the wait record is the honest artifact there. |
| F10 `done` | `stage.exit` | `stage.done[]` | A list of `check_id`/`command`/`pass_when`/`evidence`. Each `exit` maps to one line; the missing checks from P1-9 (`pr-head`, `reviewers-exact`, `clean`) become extra lines. This is the contract's one clear win: the list replaces the board's no-composite rule. |
| F11 `stops` | — | `stage.stops[]` | Seven codes + destination + cap. The seed can use `REFUSE-INPUT`, `ESCALATE-AMBIGUITY` and `STOP-BUDGET`; the other four have no destination in this panel. |
| F12 `forbidden` | — | `stage.forbidden[]` | Each line `Enforced by` or `Judged`. The push guard, the merge route and the remote-write policy are the only enforcement the board has; the rest is `Judged`. |

### 2.2 Worked example: `local/work` as v2

Current (`pipelines.seed.json:11-16`), prompt abbreviated at the ellipsis:

```json
{
  "id": "work",
  "title": "Work in this tree",
  "prompt": "Do the work in this tree and stop there. {{desc}}\n\nCommit what you changed in one revertable commit on {{branch}}, … Where this prompt carries a LANDING paragraph, that paragraph is the only instruction about pushing and opening a pull request: follow it exactly.",
  "exit": { "check": "commits", "min": 1 }
}
```

v2, all twelve fields (plus the two local extensions named in §3.1 — `schema` and, on the loop only, `on`):

```json
{
  "id": "work",
  "schema": 2,
  "name": "Work in this tree",
  "purpose": "Produce one revertable commit on the tree's branch, so the panel can read what changed and the LANDING paragraph can decide whether it lands.",
  "owner": { "role": "board-worker", "kind": "agent" },
  "inputs": {
    "read": [
      { "artifact": "tree", "schema": "git-tree/1", "location": "{{tree}}", "sha256": "{{sha}}", "mutability": "read-write" }
    ],
    "non": ["the fixer's transcript", "the reviewer's confidence"]
  },
  "trigger": { "fires": "control-plane", "when": "the tree record enters stage work and the tree's HEAD resolves" },
  "binds": [],
  "method": {
    "deterministic": ["read the brief", "make the change", "run the checks", "commit once"],
    "judgement": ["decide what the change is", "decide which checks are relevant"],
    "on_ambiguity": "ESCALATE-AMBIGUITY"
  },
  "artifact": { "id": "commit", "path": "git:{{branch}}", "schema": "git-commit/1", "sha256": "{{sha}}", "writer": "board-worker" },
  "done": [
    { "check_id": "WORK-EXIT-01", "command": "panel:commits", "pass_when": "git rev-list --count <base>..HEAD >= 1", "evidence": "the commit sha and the diff stat" }
  ],
  "stops": [
    { "code": "REFUSE-INPUT", "when": "the tree is not a worktree or its branch does not resolve", "to": "control-plane" },
    { "code": "ESCALATE-AMBIGUITY", "when": "the brief has two readings and neither is the work", "to": "the reader" },
    { "code": "STOP-BUDGET", "when": "the run reaches jobMaxRuntimeSeconds", "to": "control-plane" }
  ],
  "forbidden": [
    { "line": "push the branch or open a pull request except as the LANDING paragraph says", "enforced_by": "the push guard and the project's remoteBranchPolicy" },
    { "line": "commit to main", "enforced_by": "the push guard and the base-branch refusal" },
    { "line": "invent a check the definition did not name", "judged": "the evaluator reads the done list, not the prompt" }
  ]
}
```

What it takes to stay legal:

- The loader must accept `name` in place of `title` and `done` in place of `exit`, and keep the v1 aliases in memory (`title`←`name`, `exit`←`done[0]`) so `tools/render-pipelines.mjs` and the current tests read the same definition. Without that shim the seed change breaks the renderer and its gate in the same commit (§3.5).
- `command: "panel:commits"` is a panel check, not a shell line. The validator must refuse a `done.command` that is neither `panel:<known check>` nor a single argv list — the board's `command` exit check is the only literal command (`lib/pipelines.js:78`, `:153-157`).
- `sha256: "{{sha}}"` is a git object id, not a sha256. Either rename the slot to `hash` (a divergence from the guide) or accept a git oid in `sha256`; the closed placeholder list already has `sha` (`lib/pipelines.js:83`). This is the one schema lie in the example, and it should be named, not hidden.
- `path: "git:{{branch}}"` is a URI, not a ledger path; the validator must accept a scheme or the artifact must be a ledger record.
- `owner: "board-worker"` is not a guide roster row; the guide's A1–A5 rubric cannot score it. It is the honest local role, and the cost of a real roster is outside this repository.
- `stops[].to` must name a destination the panel has: `control-plane` (the panel itself) or `the reader` (a card/approval box). The other five stop codes have no destination here, which is why the seed uses only three.

### 2.3 All seven definitions stay legal

The brief's "three existing pipelines" are the three built-in **definitions** — `local`, `investigate`, `turnover` — the closed defaults (`BUILTIN_IDS`, `lib/pipelines.js:34`). The catalogue ships four more named definitions, and all seven are in the table, because a seed edit that keeps three and breaks four is not a migration.

| pipeline | stages | what changes | legal? |
|---|---|---|---|
| `local` | 1 — `work` | The worked example above. It is the closed default; if it is dropped, every tree loses its default. | **Yes**, once the loader accepts the v2 fields. |
| `investigate` | 2 — `probe`, `conclude` | `probe.done = commits`; `conclude.done = file-exists docs/investigation.md`; `next: null`. | **Yes.** |
| `turnover` | 3 — `commit`, `push`, `pr` | `commit.done = commits`; `push.done = pushed`; `pr.done = pr-open` + `pr-head` (the extra line P1-9 says the table requires). | **Yes**; the `done` list is what lets `pr-head` in without a composite. |
| `github-investigate` | 2 — `probe`, `conclude` | Same as `investigate`; `next: "github-force-merge"` (investigation → turnover, allowed by `lib/pipelines.js:209-214`). | **Yes.** |
| `sefl-investigate` | 2 — `probe`, `conclude` | Same; `next: "sefl-review-loop"`. | **Yes.** |
| `github-force-merge` | 6 — `commit`, `version`, `push`, `pr`, `merge`, `main` | `commit.done = commits` + `clean`; `version.done = command`; `push.done = pushed`; `pr.done = pr-open` + `pr-head`; `merge.done = pr-merged`; `main.done = main-moved`. | **Yes**, but `main-moved` is unevaluable until the record carries a `baseline` (P1-6). |
| `sefl-review-loop` | 7 — `branch`, `push`, `pr`, `wait`, `address`, `approve`, `merge` | `branch.done = branch-name` (drop the ambiguous `branch` parameter, P1-8); `pr.done` adds `pr-head` + `reviewers-exact`; `wait`/`address`/`approve` need edges. | **Only with `on`.** The 12 fields add no stage edges: `wait` still falls through to `address` on an approval, and `approve` has no edge back to `address` (P1-5). The map is `{"wait": {"pr-comments": "address", "pr-approved": "approve"}, "address": {"pushed": "wait"}, "approve": {"pr-comments": "address", "pr-approved": "merge"}}`. |

### 2.4 Seed size

**M.** The 23 stages need 184 new field-values, 161 of them substantive, most of them prose. The three built-ins are the must-pass; the four named ones are the same two shapes. The loop's `on` map is a schema addition, not a seed edit, and it is the only place the seed edit and the schema edit are coupled.

## 3. The schema and its migration

### 3.1 The v2 stage, and the v1 stage that cannot be migrated

The v2 stage is the guide's twelve keys plus two local extensions:

- **`schema: 2`** — whether the stage has been authored against the twelve fields. Without it a mixed file cannot tell a contract stage from a compatibility one.
- **`on`** — a stage-level map of exit check → next stage id, for the review loop. It is a closed map, never an expression, so §1.3's no-composite rule survives.

The migration's central choice is what a v1 stage becomes. A v1→v2 migration can rename `title`→`name` and wrap `exit` as `done[0]`, because those two fields have a source. It **cannot manufacture** `purpose`, `owner`, `inputs`, `trigger`, `binds`, `method`, `artifact`, `stops` or `forbidden` — inventing them would produce a stage that looks compliant and is not, which is the exact failure the guide's §02 is written against ("A stage that cannot fill all twelve has not been designed. It has been described."). So:

- a stage with the twelve fields and `schema: 2` is a **contract stage**;
- a v1 stage is legal as a **compatibility shape**: it keeps `title`/`prompt`/`exit`, the loader aliases `name`/`done` for readers, and the tab shows it as unauthored with the eight fields blank;
- the seed's 23 stages are all contract stages; a reader's live v1 definition keeps running until they edit it.

The alternative — defaulting the eight fields — is the shape-only lie this document exists to cost, not commit.

`prompt` is retained as an optional authoring override. The guide says the prompt is generated from the definition; the board's seed prompts are hand-written and often carry the landing doctrine's wording. The cheapest legal path is: `prompt` wins when present, otherwise the renderer projects the twelve fields (the guide's §05 skeleton). Without that divergence, the 23 prompts must be rewritten as projections, which is the largest single editorial cost.

### 3.2 `PIPELINES_VERSION` 1 → 2

`PIPELINES_VERSION` is 1 (`lib/pipelines.js:24`). The migration:

1. Bump it to 2.
2. `readPipelinesFile` accepts 1 or 2: a 1 file's stages are normalised in memory (aliases only, `authored: false`), a 2 file is read as is; a file newer than 2 is refused whole (the existing rule, `lib/pipelines.js:247-256`).
3. A versionless file is refused whole (P2-5). Today `Number(undefined)` is `NaN`, the newer-than refusal is skipped, and the file loads with `doc.version = null` (`lib/pipelines.js:247-257`). A migration cannot be trusted on a file that does not say what it is.
4. A live id that fails validation must **shadow** the seed id, not fall back to it (P1-4). Today `mergeDocs` spreads `{...seed, ...live}` (`lib/pipelines.js:336`) and a dropped live id resurrects the seed's copy.
5. A deleted definition needs a tombstone — `deleted: ["id"]` in the live document, honoured after the spread (P1-3). Without it, a delete is a no-op that silently reinstates the shipped definition.
6. `next` must refuse itself, a same-kind target and a cycle (P2-2); the existing lower-kind rule (`lib/pipelines.js:209-214`) stays.
7. **The rollback hazard:** `mergeDocs` copies `live.refused` but not `seed.refused` (`lib/pipelines.js:329`), so a v2 seed read by v1 code has its refusal discarded — the seven seed pipelines vanish while the log says "the seed is in force read-only". Ship the seed and the code in one commit; a v2 seed with a v1 binary is an empty catalogue, not a read-only one.

The order of the two files matters: the **seed** is code — it ships with the panel and moves with `PIPELINES_VERSION` — while the **live** file is the reader's and is migrated on read, never rewritten by the loader. The next save writes v2.

### 3.3 The record

The record today is `{id, stage, since, history[]}` (`lib/pipelines.js:464-534`). It gains:

- `baseline` — the sha written when a stage is entered, read by `main-moved` (P1-6) and by `commits` (which needs a base).
- `pipelineWait` — `{stage, at, every, lastSeen, attempts, claimedAt}` for the timer (P1-7/P2-6).
- `lastSeen` — the `pr-comments` baseline; it can live inside `pipelineWait`. The seed's `wait` stage omits it today, and the check is accepted without it.
- `history[].stage` must be validated against the definition (P2-4).

The book stays `{version: 1, trees}`. The additions are optional fields; a v1 book reads fine and an older panel ignores them. The caveat is the other direction: an older panel's `changePipeline` rebuilds `{id, stage, since, history}` and **drops** `baseline`/`pipelineWait` on the next switch. If a downgrade must preserve the wait state, the book needs its own version gate — refuse a newer book whole, the way the catalogue does. That is **S** and optional; this analysis does not require it for the shape.

The guide's `schema_version` (its handoff envelope) is a third version, not either of these; the document must say so or a reader will conflate them.

### 3.4 What the validator must refuse

- A stage with no `done`, or a `done` line with no `check_id`/`pass_when` (F10).
- A `done` line whose `command` is neither `panel:<known check>` nor a single argv list.
- An `owner` with two roles, no `kind`, or a role the local roster does not have (the validator can only check the shape, since the roster is local).
- An `inputs.read` entry with a location but no hash, or a `non` entry that is also in `read`.
- A `binds` id outside the three namespaces, or an id with no check; an empty `binds` is legal.
- A `stops` code outside the seven, or a stop with no destination.
- A `forbidden` line with neither `enforced_by` nor `judged`.
- A `next` that names itself, a same-kind target or a cycle (P2-2), and an `on` target that is not a stage in the same definition.
- A placeholder outside the closed list — in the prompt **and** in the new fields (`inputs[].location`, `done[].command`, `artifact.path`), including the non-identifier holes `{{ticket-id}}` and `{{}}` that the current regex still cannot see (P2-8; P0-6 fixed the spaced hole only, `lib/pipelines.js:89`).

### 3.5 The fourth reader: the catalogue renderer

`npm run render:pipelines` writes `docs/pipelines/viz/pipelines-<version>.html` from the same loader (`tools/render-pipelines.mjs:123-129`). It reads `stage.title`, `stage.prompt` and `stage.exit`, and labels every arrow with the exit check and its parameters (`tools/render-pipelines.mjs:148-164`, `:364-372`). `tools/verify-pipelines-viz.mjs` asserts every exit check appears as an edge label (`:175-190`) and its fixtures are v1-shaped. A seed that drops `exit` breaks both — the gate fails on a page that is otherwise correct.

The cheapest fix is the loader shim from §3.1: normalise `name`→`title` and `done[0]`→`exit` in memory, so the renderer and the gate keep working through the seed migration. Teach the renderer `done` only when it starts drawing the list (a later **S**). This is why the seed change is not a one-file edit: it has a second reader, and that reader has a gate.

### 3.6 Size

**M.** The validator is the single largest code change: twelve field shapes, nested arrays/objects, the v1/v2 split, the tombstone, the drop-shadow rule, the record fields and the tests. The seed edit is separate (**M**). The record fields are **S** each; the evaluator is the **L**.

## 4. The HTTP surface

| route | method | today | after | new/changed | serves | size |
|---|---|---|---|---|---|---|
| `/api/pipelines` | GET | absent | `{catalogue, definitions: {id: fullDef}, defaults: {project: ...}, warnings, dropped, refused}` — full v2 stages, every prompt/exit/12 fields | new | chip, tab, evaluator | **S** (~13 KB) |
| `/api/settings/pipelines` | POST | absent | validate → write `pipelines.json` → return the whole settings object; tombstone delete; kind-edit refusal; cross-check | new; no writer exists | tab | **L** |
| `/api/settings/pipeline-defaults` | POST | absent | write `defaultTurnover`/`defaultInvestigation` on the project or config; return settings | new | tab | **S** global / **M** per project |
| `/api/worktree/pipeline` | POST | switch, 501 because `PIPELINE_SWITCH_STARTS_TURN=false` (`server.js:361`) | the same payload; first stage from `def.stages[0].id`; start the turn (`firstOfThread`/`replyTree`/`reply:true`); flip the gate | changed | chip | **L** (the turn start) |
| `/api/worktree/pipeline/advance` (provisional name) | POST | absent | the evaluator/timer enters the next stage: validate the stage against the definition, append history, start the turn | new | timer/evaluator | M |
| `/api/state` | GET | snapshot carries the tree's `pipeline` record via `pipelineForJob` (`lib/jobs.js:856`) | unchanged — the full catalogue does not belong in the polled snapshot | unchanged | chip | — |

The two **L** entries are the reason the shape is not uniformly M: `POST /api/settings/pipelines` has no writer (`ensurePipelinesFile` only creates an empty file, `lib/pipelines.js:374-398`), and the switch needs the 14-slot renderer (`PROMPT_PLACEHOLDERS` is a validator only, `lib/pipelines.js:87-102`) plus `firstOfThread`/`replyTree`/`reply: true`.

The read route is the first one to build: it is the chip's and the tab's shared prerequisite, and it is the audit's P1-1 "smallest fix". `Pipelines.state()` today maps each definition to `{id, kind, title, description, stages: [ids], next}` (`lib/pipelines.js:699-714`); it drops every prompt and exit, so the tab cannot edit them. The new route must return the full stages (and the v2 fields), plus the resolved defaults (`defaultsForProject`, `lib/pipelines.js:453-458`), which has no caller in `server.js` today.

The write routes follow `POST /api/settings/remote-branches`' shape (`server.js:3500`): authorised, validate, write, return `settings: settingsOut()`. They are the tab's backend and are not needed by the chip or the timer. The per-project defaults live inside `projects[]`, so a project-level write must rebuild the whole array and update the live `config` object — `patchPanelConfig` (`server.js:277-283`) only assigns top-level keys, and passing it a `projects` array replaces every project record.

The switch route's missing half is the turn start. `PIPELINE_SWITCH_STARTS_TURN` is a constant `false` (`server.js:361`), so every valid switch returns 501 and writes nothing (P0-4's fix, deliberately — a rung with no run behind it spends the ladder's one-way move). The chip cannot work until the gate flips; that is a server change (the prompt renderer plus `firstOfThread`/`replyTree`/`reply:true`), not a schema change.

## 5. The three parked surfaces

All three are unbuilt. `grep -n "pipeline" public/app.js public/index.html` returns nothing; `public/index.html` carries eight `data-settings-group` panels and no ninth; `hostChipHtml` (`public/app.js:13130`) is the only chip of that shape. The P0 fixes did not build them — they changed what each is waiting for.

### 5.1 #38 — the card chip

The chip is `pipeline: <id> · <stage> ▾` beside the host chip (`hostChipHtml`, `public/app.js:13130`; `docs/pipelines.md` §4.1). It reads the card's `pipeline` record and the menu's options from the resolved defaults.

**Placement is not a slot that exists.** `hostChipHtml` (`public/app.js:13130-13139`) and `chipsHtml` (`:12763-12976`) are per **project** and drawn in the project head (`:13269`, `:13273`); the record is per **tree** (`lib/pipelines.js:594-599`). A per-tree chip needs a row cell (`rowHtml`, `public/app.js:10783`) or an aggregate. The document's "same chip row" is a project-level strip, not a per-row cell. `public/app.js` has no occurrence of "pipeline": the placement and the payload are both new.

**What 0.68.4 removed from its wait list:**

- P0-1/P0-2 — the record it draws is durable, and a failed write is a 500 with no record, not a 200 with one. The chip cannot show a rung that is not stored.
- P0-4 — a switch that cannot start a turn is refused *before* the ladder is spent, so a read-only chip is safe to ship now.
- P0-5 — a child-cut tree has a `by: "cut"` record, so the chip is not blank for the panel's own cuts.
- P0-3 — the local definition's prompt now defers to the LANDING paragraph, so the chip's local row is coherent.

**What remains:**

- `GET /api/pipelines` (P1-1) for the defaults and the catalogue's ids/titles; `defaultsForProject` has no caller today.
- The turn start and `PIPELINE_SWITCH_STARTS_TURN = true` — the working switch. The gate is not a P0 defect; the P0 fix is the refusal.
- P1-11 — the ladder grants nothing; no run path reads the kind. Until a run reads it, the chip's label is a permission the panel does not enforce.
- P1-12 — the card reports `null` where the route says `local`, so a pre-pipeline tree shows no pipeline.
- P1-2 — a project with no turnover default offers none; without it the menu offers a turnover that cannot chain.

**Size:** **S** for the id/stage label and a read-only menu; **M** with the working switch and P1-11's run-path read. The contract does not change the chip's shape; it changes the label (`id` → `name`) and the defaults payload.

### 5.2 #39 — the Settings Pipeline tab

The tab is the ninth settings group (`data-settings-group="pipeline"`). It edits the stage list, each stage's twelve fields, the prompt override, `done`, `on`/`next`, the per-project defaults and delete.

**The contract's sharpest change: `prompt` stops being a field.** The guide makes it a projection of fourteen slots over the twelve fields, generated and never written beside the definition (`guide.txt:596-603`, `:671-711`, `:746-750`). The tab's central control today is exactly that hand-written prompt (`docs/pipelines.md:314-320`; required at `lib/pipelines.js:197`). It becomes read-only output and the editable surface becomes a nested form with a projection preview — the whole of the tab's **L**.

**What 0.68.4 removed from its wait list:**

- P0-3 — the local prompt it edits is settled, so the editor does not start from a contradiction.
- P0-6 — `{{ nope }}` is refused and `{{ ticket }}` resolves, so the editor's hole validation is honest.
- P0-1/P0-2 — the book it reads for "a live tree is on this id" is durable; a delete/kind check cannot be fooled by a wiped book.
- P0-4 — the switch is refused, so a delete or kind edit cannot race a switch that never started a run.

**What remains:**

- `GET /api/pipelines` with full definitions (P1-1), or it has no prompts/exits to edit.
- The v2 validator and seed, or the form has no schema to render.
- P1-3 tombstone delete, P1-10 kind-edit refusal, P2-4 cross-check, the two write routes.
- `test/settings-tabs.test.js:75-76` hard-codes eight tabs and eight panels; the ninth tab updates both counts and the "seven other panels" wording at `:97`.

**Size:** **L.** The twelve-field editor — nested arrays/objects (`inputs.read[]`, `binds[]`, `method{}`, `artifact{}`, `done[]`, `stops[]`, `forbidden[]`) plus validation messages — is the largest UI surface.

### 5.3 #40 — the stage timer

The timer is `docs/pipelines.md` §6's re-check ticker: one interval, due records, `pipelineWait`, a host read for `pr-comments`, a wake on the same thread, backoff (1h → 2h → 4h), one status wake after 6h, a claim before a wake, and no assistant wake.

**What 0.68.4 removed from its wait list:**

- P0-1/P0-2 — the book it rests on survives a corrupt read and a failed write; a multi-day wait is no longer built on a file a restart can empty.
- P0-5 — every cut tree has a `by: "cut"` history, so the timer can trust where the record started.
- P0-6 — prompts are validated, so a wake's prompt is not a literal hole.

The draft listed the book and the cut record as blockers; both are fixed.

**What remains:**

- The exit-check evaluator and four host readers — `pr-comments` (Bitbucket activities / GitHub reviews+comments), `pr-approved` (`lastReviewedCommit`), `reviewers-exact` (no reviewer field in `normalisePr`), `main-moved` (baseline). **L.**
- `baseline` on the record (P1-6) for `main-moved` and `commits`.
- `pipelineWait`/`lastSeen` (P1-7) and `claimedAt` (P2-6) for the wait and the claim.
- P1-5's edges so the timer can enter the right stage; P2-2's cycle refusal if the chain runs.
- P2-1 record validation on read; P2-3's cut stage.

**Size:** **L** overall; the timer is **M** once the evaluator exists. The storage is no longer the blocker; the evaluator and the host reads are.

### 5.4 The surface dependency table

| surface | blocked by (audit) | state at 0.68.4 | can start after | files | size |
|---|---|---|---|---|---|
| #38 chip | P1-1, the turn start/gate, P1-11, P1-12, P1-2 | P0-1/P0-2/P0-4/P0-5/P0-3 fixed | the read route + the turn start | `public/app.js`, `lib/jobs.js`, `lib/pipelines.js`, `server.js` | S/M |
| #39 tab | P1-1, the v2 validator/seed, P1-3, P1-10, P2-4, the two write routes | P0-1/P0-2/P0-3/P0-4/P0-6 fixed | the read route + the write routes | `public/index.html`, `public/features/pipeline-settings.js` (or `app.js`), `test/settings-tabs.test.js` | L |
| #40 timer | the evaluator + four host readers, P1-6, P1-7, P2-6, P1-5, P2-2, P2-1, P2-3 | P0-1/P0-2/P0-5/P0-6 fixed | the evaluator + the record fields | new `lib/pipeline-wait.js`, `lib/scheduler.js`, `lib/pipelines.js`, `server.js`, `lib/project.js` | L |

### 5.5 What the contract changes in each

The chip's stage label moves from the stage id to `name`, and the menu reads a fuller defaults payload — its shape does not change. The tab's editor grows from four fields to twelve, which is the whole of its **L**. The timer's exit grows from one check to a `done` list, but its blocker is the evaluator, not the list. None of the three is blocked by the twelve fields alone; each is blocked by the audit's preconditions, and the P0 fixes removed the durability ones.

## 6. The audit backlog: urgent versus left alone

All six P0s are fixed at 0.68.4. The P1/P2 list is what remains, and the integration does not make all of it urgent. Three classes:

- **Before the seed v2** — the findings without which the migration is not honest: P2-5, P2-8, P1-3, P1-4, P1-5, P1-8, P1-9. P1-1 is the read route rather than the seed, but it is the same release.
- **With the surface they feed** — P1-2/P1-10/P1-11/P1-12 (the chip and tab), P1-6/P1-7/P2-1/P2-3/P2-4/P2-2/P2-6 (the evaluator, timer and chain).
- **Left alone** — P2-7. The contract does not touch the route's path validation or pruning, and a fix there is a separate piece of work on a route this integration only reads.

P1-13 (the stale design doc) is urgent first, not because of the contract but because it is the map the next task reads: `docs/pipelines.md:7-9` says "the pipeline machinery itself does not exist yet", and §8 (`:455-477`) lists the catalogue, the seed, the loader, the record, the route, the config keys and the tests as missing when all of them exist.

| finding | one-line | verdict | why | size |
|---|---|---|---|---|
| P1-1 | no HTTP shape for the catalogue; `state()` drops prompts/exits | **before the read route** | The v2 definitions cannot be read by the tab or chip; the twelve fields make the payload bigger. | M |
| P1-2 | "no turnover default" cannot be expressed | with #38/#39 | The chip's menu and the chain; the seed v2 does not change the resolver. | S |
| P1-3 | a definition cannot be deleted | **before the seed v2** | The v2 catalogue needs a tombstone; the tab's delete is a core action. | S |
| P1-4 | a broken live id resurrects the seed | **before the seed v2** | The migration's drop semantics; a v2 id that fails must shadow the seed. | S |
| P1-5 | the review loop has no transition edges | **before the seed v2** | `sefl-review-loop` is unrepresentable; the v2 stage needs `on`. | M |
| P1-6 | `main-moved` has no baseline | with the evaluator | The `done` line cannot be evaluated; the record needs `baseline`. | S |
| P1-7 | `pr-comments` has no `lastSeen`; no `pipelineWait` | with the timer | The `wait` stage's exit and the timer's record. | S/M |
| P1-8 | `branch-name`'s `branch` parameter is dead or poisonous | **before the seed v2** | The loop's first stage must decide whether the parameter is an input; drop it. | S |
| P1-9 | the turnover seeds drop `pr-head`/`reviewers-exact`/`clean` | **before the seed v2** | The `done` list is what lets the missing checks in; the seed should add them. | S/M |
| P1-10 | a definition's `kind` can be edited with no ladder consequence | with the tab | The tab's `kind` field; a live tree can be silently downgraded. | S |
| P1-11 | the ladder grants nothing; no run path reads the kind | with the chip | The chip's label is a permission the run path ignores; a run-path change. | M |
| P1-12 | the card reports `null` where the route says `local` | with the chip | The chip's label for pre-pipeline trees. | S |
| P1-13 | §8 and the opening are false after the catalogue landed | **first (docs)** | The design doc is what the next task reads. | S |
| P2-1 | the record is trusted exactly as read | with the evaluator | The v2 record has more fields; validate on read. | S |
| P2-2 | `next` may name itself/same-kind/cycle | with the chain | A cycle loops forever once the chain reads `next`. | S |
| P2-3 | `cutPipeline` hard-codes `stage: "work"` | **before the seed v2** | The v2 `local` may name another first stage; the record must name it. | S |
| P2-4 | `changePipeline`/`advanceStage` do not cross-check id/kind/stage | with the evaluator | The evaluator's writer must validate the stage against the definition. | S/M |
| P2-5 | a versionless live file is parsed and merged | **before the seed v2** | The migration must refuse it; otherwise a v2 file is half-parsed. | S |
| P2-6 | the book is whole-file read-modify-write with no lock/claim | with the timer | The timer's `claimedAt` and the second-panel race. | M |
| P2-7 | the route writes a record for any path; released trees are never pruned | **left alone** | The contract does not touch the route's path validation; a separate fix on a route this integration only reads. | S |
| P2-8 | the placeholder scanner misses non-identifier holes | **before the seed v2** | P0-6 fixed the spaced hole; `{{ticket-id}}` and `{{}}` still pass, and the v2 fields carry more holes. | S |

**Top five before the seed v2 can ship:** P2-5 (versioned migration), P2-8 (the remaining hole forms), P1-3 (tombstone), P1-4 (a dropped live id must shadow), P1-5 (the loop's edges). P1-1 is the read route rather than the seed; P1-9 is the seed's own content and lands with it.

## 7. Dependency order

| # | work | size | depends on | parallel with (no file collision) | files |
|---|---|---|---|---|---|
| 0 | Correct `docs/pipelines.md`'s opening and §8 to the built/unbuilt list (P1-13) | S | — | everything | `docs/pipelines.md` |
| 1 | v2 stage schema, validator, v1/v2 migration, tombstone, drop-shadow, `on` edges, record fields (`baseline`, `pipelineWait`, `lastSeen`, `claimedAt`) | M | 0 | — (critical path) | `lib/pipelines.js`, `test/pipelines.test.js` |
| 2 | Seed v2: 23 stages × 12 fields; the three built-ins first | M | 1 | 3, 11 (different files) | `pipelines.seed.json` |
| 3 | `GET /api/pipelines`: full definitions + defaults + warnings | S/M | 1 | 2, 11 | `lib/pipelines.js`, `server.js`, `test/pipelines.test.js` |
| 4 | `POST /api/settings/pipelines` + `pipeline-defaults`: validate/write/tombstone/kind refusal/cross-check | **L** settings / **S-M** defaults | 1, 3 | 11 (different files) | `server.js`, `lib/pipelines.js`, `test/pipelines.test.js` |
| 5 | Prompt renderer + turn start + flip `PIPELINE_SWITCH_STARTS_TURN` | **L** | 1 | 2, 11 (different files) | new `lib/prompt.js`, `lib/jobs.js`, `server.js`, `test/` |
| 6 | Exit-check evaluator + four host readers (`pr-comments`, `pr-approved`, `reviewers-exact`, `main-moved`) + advance route | L | 1, 5 | — (shares `server.js`) | new `lib/pipeline-exit.js`, `lib/project.js`, `lib/hosts.js`, `server.js`, `test/` |
| 7 | #38 chip: label/menu/switch; P1-11's run-path kind; P1-12's presumed local; P1-2's no-default | S/M | 3, 5 | 8 only if the tab is a module | `public/app.js`, `lib/jobs.js`, `lib/pipelines.js`, `server.js`, `test/` |
| 8 | #39 tab: ninth settings group, 12-field editor, defaults, delete | L | 3, 4 | 7 only if split | `public/index.html`, `public/features/pipeline-settings.js` (or `app.js`), `test/settings-tabs.test.js` |
| 9 | #40 timer: `pipelineWait` ticker, claim, backoff, same-thread wake, status wake | M | 6, 1 | 10 only if chained in another file | new `lib/pipeline-wait.js`, `lib/scheduler.js`, `lib/pipelines.js`, `server.js` |
| 10 | Chain: read `next` on `conclude`, resolve `defaultTurnover`, rewrite the record, start the turnover | S | 5, 6 | 9 only if separate file | `lib/pipelines.js`, `server.js`, `test/` |
| 11 | Catalogue renderer: teach `done`/`name` drawing, re-render a version page | S/M | 1, 2 | buildable beside 2; run after it | `tools/render-pipelines.mjs`, `tools/verify-pipelines-viz.mjs`, `docs/pipelines/viz/` |
| 12 | P2-7 path validation/pruning (left alone by this integration) | S | 1 | after the route work | `lib/pipelines.js`, `server.js` |

**Critical path:** 0 → 1 → 2/3 → 5 → 6 → 9. The chip's shortest useful path is 0 → 1 → 3 → 5 → 7; the tab's is 0 → 1 → 3 → 4 → 8; the renderer's is 1 → 2 → 11. The chip and tab are side branches off 3/4 and do not block the timer.

**File collision map.** `lib/pipelines.js` is touched by 1, 3, 4, 9, 10, 12 — one owner at a time. `server.js` by 3, 4, 5, 6, 7, 9, 10, 12 — one owner at a time. `public/app.js` by 7 and 8 — one owner unless the tab is a new module and `app.js` only wires it. `test/pipelines.test.js` by 1, 3, 4, 6 — split the additions by file (`test/pipeline-seed.test.js`, `test/pipeline-routes.test.js`, `test/pipeline-exit.test.js`) or sequence them. `test/settings-tabs.test.js` by 8 only. `lib/jobs.js` by 5 and 7. `lib/project.js`/`lib/hosts.js` by 6 only. `lib/scheduler.js` by 9 only. `pipelines.seed.json` by 2 only. `tools/render-pipelines.mjs` and `tools/verify-pipelines-viz.mjs` by 11 only.

**What can genuinely run in parallel** is narrower than the draft's table:

- **Docs/tools lane** — 0 and 11 touch `docs/` and `tools/` only; they never collide with the panel.
- **Seed lane** — 2 touches `pipelines.seed.json` only, so it can run beside 3, 4 and 5 once 1 has landed.
- **New-module lane** — `lib/pipeline-exit.js` (6) and `lib/pipeline-wait.js` (9) can be written and unit-tested against fixtures before their routes are wired; the wiring commit is where they collide with `server.js`.
- **UI lane** — `public/features/pipeline-settings.js` (8) can be built against the read route's fixture while 7 edits `public/app.js`; only the final wiring hunk collides.

Everything that edits `server.js` or `lib/pipelines.js` is one lane, one owner. The draft's pairs "4∥5", "6∥7" and "8∥9" each share `server.js` (and 6/7 share `app.js`), so they are not collision-free as written; only the module splits above are.

## 8. What this analysis does not claim

- The guide's thresholds (12/16 on the stage, 8/10 on the agent) are its proposals, not this repo's. This document costs the **shape**; it does not claim the seed would score 12/16 or 8/10, and it does not score the existing stages.
- The full semantics — a roster with one role per stage, hashed input artifacts, a `P-*`/`SEFL-*` rule corpus, a ledger, a control plane acting on stop codes — are **L/XL** and mostly outside this repository. The shape-only adoption is the only one that fits the existing catalogue.
- The `owner`/`binds`/`sha256` mappings above are the honest local approximations, not the guide's semantics. A `binds: []` stage is legal; it is not a stage that cites a rule. A `board-worker` owner is legal by shape; it is not a roster row. A git oid in `sha256` is a hash; it is not a sha256. These are the three places the adoption is a shape, not a contract.
- The 23-stage count and the 184/161 value counts are from `pipelines.seed.json` at `b4ee813`; a later seed edit changes them.
- The ordering assumes the three surfaces are the goal. If only the chip is wanted, the shortest path is steps 0-1, 3, 5 and 7; the evaluator, the tab and the timer are not on it.

## Appendix: what changed from the draft

The draft was measured at 0.68.2 (`e0ae8a4`) and said P0-5/P0-6 remained. Both are fixed at 0.68.4, so every surface's wait list in §5 has been re-derived rather than copied.

Corrections to the draft's claims:

- **The catalogue is seven definitions, not three.** The brief's "three existing pipelines" are the three built-in definitions (`local`, `investigate`, `turnover`); the four named definitions are the same two shapes, and all seven stay legal (§2.3).
- **184 new field-values, 161 substantive** — not 207/184. The draft's 207 counted `method` as wholly new; it is a transcription of the stage's prompt, so the source exists.
- **The record book stays `version: 1`.** The new fields are optional; a separate book version is only needed if a downgrade must preserve them (§3.3).
- **The catalogue renderer is a fourth reader** (`tools/render-pipelines.mjs` + `tools/verify-pipelines-viz.mjs`), and the seed change breaks its exit-label gate without the loader's alias shim (§3.5).
- **A v1→v2 migration cannot manufacture eight fields.** The draft's "the validator must accept a v1 stage by migrating it" is half true: `title`/`exit` migrate, the other eight do not. A v1 stage stays legal as a compatibility shape and is marked unauthored (§3.1).
- **P2-8 survives P0-6.** The spaced hole is fixed; `{{ticket-id}}` and `{{}}` still pass the scanner, and the v2 fields carry more holes to scan (§3.4, §6).
- **The commit the brief names for the first four P0s is not on main.** `0195d75` is the pre-rebase twin of `e0ae8a4` (same tree); `e0ae8a4` is the one in `main`'s history.

The four analysis subagents are named below; their findings were re-verified against the code at 0.68.4.

## Appendix: the four analysis subagents

- **seed** — read the guide §02/§05, `pipelines.seed.json`, `docs/pipelines.md` §1, and `lib/pipelines.js`; produced the field mapping, the `local/work` and `branch` worked examples, the 7-definition legality table, and the 184/161 value counts. It also found the 13 distinct stage ids, the 22-of-23 `name` compliance, and the `mergeDocs` rollback hazard (a v2 seed under v1 code discards the seed's refusal).
- **schema+routes** — read `lib/pipelines.js`, `server.js`'s pipeline/settings routes, and the guide's YAML; produced the v1→v2 schema/migration, the required-vs-optional validator rule, the record fields, and the HTTP route table (including the `GET /api/pipelines` ~13 KB, the L for `POST /api/settings/pipelines`, the M per-project defaults, and the L turn start).
- **surfaces** — read `docs/pipelines.md` §4/§6, the audit's P1/P2 and verdict, `public/app.js`/`public/index.html`; produced the #38/#39/#40 preconditions, the per-project-vs-per-tree chip placement finding, the `prompt`-deletion finding, and the surface dependency table.
- **audit backlog** — read `docs/pipelines-audit.md` in full and the guide §02/§07; produced the urgent/left-alone categorization, the top-five list, and the P1-5 "design decision, not a fix" verdict.

All four produced usable findings; none was empty. The seed subagent's transcript shows one failed scratch-file write (it tried to overwrite an existing `analysis-c.md`); its final answer is complete. The surfaces subagent read from a sibling worktree because the assigned one was removed mid-run; the content is at the same commit, and the P0 fixes in `b4ee813` do not change its P1/P2 conclusions.
