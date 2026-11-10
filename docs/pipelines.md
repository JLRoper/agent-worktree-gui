# Per-project pipelines

A pipeline is what a worktree is FOR, written down: the stages a tree goes through, the prompt each stage hands a
worker, the condition that ends a stage without asking anybody's opinion, and — when the work turns out to be more
than research — what it chains into.

This page is a **design**, not a description. Every claim about today's code is checkable and names its file; the
pipeline machinery itself does not exist yet, and §8 lists exactly what is missing. The order is the order the
feature has to be built in: the data model first, because everything else is a reader of it.

**Contents**

1. [The data model](#1-the-data-model)
2. [Per-project defaults, beside `remoteBranchPolicy`](#2-per-project-defaults-beside-remotebranchpolicy)
3. [The worktree/job record](#3-the-worktreejob-record)
4. [The switching surface](#4-the-switching-surface)
5. [Chaining](#5-chaining)
6. [The wait mechanic](#6-the-wait-mechanic-that-must-not-be-a-sleeping-worker)
7. [What exists to plug into](#7-what-exists-to-plug-into)
8. [UNBUILT](#8-unbuilt)

---

## 1. The data model

### 1.1 A pipeline is a named definition

```json
{
  "id": "sefl-review-loop",
  "kind": "turnover",
  "title": "SEFL review loop",
  "description": "Cut a correctly named turnover branch, open a PR for code_review_java, answer what arrives, merge when approved.",
  "stages": [
    {
      "id": "branch",
      "title": "Name the branch",
      "prompt": "Rename this tree's branch to {{branchName}} and nothing else…",
      "exit": { "check": "branch-name", "pattern": "^\\d{8}_\\d{4}_[A-Z][A-Z0-9]+-\\d+_[a-z0-9._-]+$", "branch": "{{branch}}" }
    }
  ],
  "next": null
}
```

Four things carry the meaning:

- **`id`** is what a config default, a job record and a chip all name. It is a slug, never a title, and it is
  stable across edits to everything else.
- **`kind`** is `local`, `investigation` or `turnover`. It is a rung on a ladder (§1.2), not a category label.
- **`stages[]`** is an ordered list, each stage carrying a `title`, a `prompt` template and an `exit` condition
  (§1.3, §1.4). A stage without an exit is refused at save time: a stage that ends when a model says it is done is
  a stage nobody can resume, re-check or audit.
- **`next`** optionally names the definition to chain into when the last stage exits (§5).

The panel reads pipelines; it does not hard-code them. What the CODE knows is the small closed vocabulary of exit
checks and the three kinds. What the DATA knows is every stage, every prompt and every ordering. That split is the
same rule `lib/hosts.js` already enforces for links and landing doctrine: nothing in this codebase names github or
bitbucket outside the seed file, so a third host's landing style is a definition added to `pipelines.json`, never a
patch to `server.js`.

### 1.2 `kind` is a ladder

| kind | what it means | what it may do |
|---|---|---|
| `local` | work in this tree and stop. The panel's default. | commit; report. Whether that includes a push and a pull request is decided by the LANDING paragraph (`branchLandingLine`) — see "One landing instruction" below. |
| `investigation` | find out something and write it down, in this tree. | read, probe, run things, commit notes and scripts, open a draft PR if the project allows it. Ends by concluding. |
| `turnover` | this work is going to land. | push, open the PR, answer review, merge when the host's rule says it is merged. |

The ladder is `local → investigation → turnover` and it only climbs (§3). The point of naming three and not five is
that each rung changes one thing — whether a remote branch exists, and whether a human has to answer before main
moves — and a reader can hold three in their head while judging a card.

**One landing instruction.** The paragraph `lib/branch-policy.js` `branchLandingLine` renders is the authoritative
instruction about where a run's branch goes, and `lib/jobs.js` composes it ahead of every worker's prompt. It is not
silent about pushing: for a tree cut from `main` it says "commit on …, push it and open a pull request", and for a
tree cut from a turnover branch it says "merge into … locally and do not push". A THIRD case is the stage's own and
wins over both: a pipeline stage whose declared artifact kind is not `pr` has nothing to land, so its worker is told
to commit on the stage branch and report the commit — no push and no pull request. The driver says which case it is
(`remoteWrite: "local"` on the start, `pr` for a stage whose artifact IS the pull request), and `lib/jobs.js` renders
the one paragraph. Before that, a document stage was handed the parent's paragraph and opened a PR for a file in the
ledger. The seed's landing ladders (`turnover`, `github-force-merge`, `sefl-review-loop`) therefore declare
`kind: "pr"` on the stages that act on the remote — a push stage told "do not push" is a pipeline that cannot do its
own job — and declare nothing on their commit stages, which are local commits and are told to stop there.
A pipeline's prompt carries the WORK and defers to that paragraph; it never restates the landing rule.
`local`'s seed prompt used to end "do not push, do not open a pull request", which contradicted the paragraph every
landing-parent run actually receives, so it now names the LANDING paragraph as the only instruction about pushing and
a PR. When no paragraph can be rendered (the tree's parent is unknown), the panel's blanket local-only line stands.

### 1.3 An exit condition is machine-checkable, or it is not an exit

The exit is a small object: a `check` name from a closed vocabulary plus that check's parameters. The panel
evaluates it, from git or from the host's API, with no model in the loop.

| check | reads | exits when |
|---|---|---|
| `clean` | `git status --porcelain` in the tree | there is no output |
| `commits` | `git rev-list --count <base>..HEAD` | the count is at least the stage's `min` (default 1) |
| `branch-exists` | `git rev-parse --verify <branch>` | the ref resolves |
| `branch-name` | the tree's current branch | it matches `pattern` (a regex the tab validates) |
| `pushed` | `git ls-remote <remote> refs/heads/<branch>` | the remote ref's sha equals the tree's HEAD |
| `main-moved` | `git ls-remote <remote> refs/heads/<main>` | the sha differs from the one recorded when the stage began |
| `pr-open` | the host's `listOpenPrs` (`lib/project.js` `prIndex`) | exactly one open PR is found whose source branch is this branch |
| `pr-head` | the same PR record | its head sha equals the tree's HEAD |
| `reviewers-exact` | the PR record | the reviewer set equals `who` (a list), no more and no fewer |
| `pr-comments` | the host's activities / review comments | there is an event newer than `lastSeen` |
| `pr-approved` | the PR record | an approval exists AND its `lastReviewedCommit` equals the PR's head |
| `pr-merged` | the PR record | the state is `MERGED` |
| `file-exists` | the tree | the path exists (a note, a script, a report) |
| `command` | the tree | the named command exits 0 (e.g. `node tools/version.mjs check`) |

Three rules hold the table together:

- **Fail-closed.** A check that cannot be read — the host API is down, `ls-remote` timed out — does NOT exit the
  stage. It reports "cannot tell" and the stage stays where it is, the same rule `lib/remote-writes.js` applies to
  a permission nobody answered.
- **The model's claim is never the exit.** A prompt may say "say DONE when the PR is open"; that sentence is for the
  reader's console, not for the panel. `pr-open` is what moves the stage.
- **No composite checks.** Two conditions are two stages, or one check with a `min`. An `and`/`or` expression in
  this vocabulary is the beginning of a programming language in a config file, and the tab would have to become an
  editor for it.

### 1.4 Prompt templates: text with a closed set of placeholders

A stage's `prompt` is prose with holes. The holes are resolved from the tree record and the project, and the list is
closed:

`{{tree}} {{branch}} {{main}} {{project}} {{remote}} {{host}} {{ticket}} {{desc}} {{pr}} {{sha}} {{lastSeen}}`

- **Whitespace inside the braces is the same hole.** A person writes `{{ ticket }}`; it is read as `{{ticket}}` and
  judged by the bare name, so the padded unknown hole `{{ nope }}` is refused exactly as `{{nope}}` is. The name is
  still the closed name: `{{TICKET}}` and `{{ticketId}}` are not in the list above and are refused.
- **An unknown placeholder is refused when the definition is saved.** Not rendered empty at run time: a prompt with
  a silently missing `{{ticket}}` is the brief that produces a branch called `_`.
- **A placeholder that resolves to nothing at render time refuses to start the stage**, and the card says which hole
  was empty. `{{pr}}` before a PR exists is a hole, and it is why the stage that opens the PR is before the stage
  that reads it.
- **The prompt is the stage's whole instruction.** It is handed to the worker as the turn's text, in the same tree
  and on the same thread (§5), and the panel does not append a second paragraph of its own — the LANDING line
  belongs to the `local` definition, not to every pipeline.

### 1.5 Where definitions live

`pipelines.json` in the panel's state folder (`lib/paths.js` `statePaths()`, beside `hosts.json`), seeded from
`pipelines.seed.json` at the repo root and merged per id exactly the way `hosts.seed.json` → `hosts.json` works: a
seed record reaches an existing install without the reader merging anything, and the reader's own edit to an id wins.

- `PIPELINES_VERSION` is stamped into the file, the way `ROLES_VERSION` is stamped into `roles.json`. A file whose
  version is newer than the code's is refused whole, with a line in the log and the seed loaded read-only — never
  half-parsed into a catalogue that looks complete.
- A definition that fails validation (unknown check, bad regex, empty stage, duplicate id) is dropped **by id**, and
  the panel says which one and why. The rest of the catalogue loads: one bad pipeline must not take the board's
  switching surface with it.

### 1.6 The catalogue, drawn

`npm run render:pipelines` writes the whole catalogue as ONE self-contained page per release —
`docs/pipelines/viz/pipelines-<version>.html` — with mermaid inlined, so it opens with no network at all. Every
definition is drawn from the same loader the panel runs (`readPipelinesFile` + `mergeDocs`, §1.5): the stages in
order, each exit check and its parameters on the arrow that leaves its stage, the holes a prompt may have, the
chain a definition ends on, and the ladder a tree climbs. The page names every file it read with its sha256, its
own version and the moment it was generated; `docs/pipelines/viz/index.html` lists every render in the folder
newest first, so the folder itself is the history and a render whose hash no longer matches the file is visibly
stale. `node tools/verify-pipelines-viz.mjs` re-renders into a temp file and asserts the picture still matches the
JSON.

### 1.7 The library at a glance

`public/pipeline-map.html` puts the whole library on one page: the seven catalogue definitions and the four pipelines
the bundle file carries (the thirteen-stage studio export among them), each stage a node whose first line is its
ordinal and title and whose second line names who runs it, with the exit check or gate on the arrow that leaves it.
It is built from both seed files by `node tools/render-pipeline-map.mjs`, which inlines
`tools/vendor/mermaid.min.js` — the page opens with no network at all. `node tools/verify-pipeline-map.mjs`
re-checks the committed page: 11 cards, 43 stage nodes, the bundle's carried loops and `sefl-review-loop`'s one
inferred edge, both layouts, 11 px labels and no console errors.

The panel names that page in the two places a reader is already looking at a pipeline: the **Pipeline map** row under
**Settings → Pipeline**, and the `map ↗` control in the pipeline flow dialog's header — in BOTH of the dialog's
modes, because it draws one pipeline of the library the map draws whole. Both are anchors carrying
`target="_blank" rel="noopener"`, so following one opens its own tab and the panel (and the Settings tab a reader is
editing in) stays where it was: a link that navigated the panel away would lose the draft behind the dialog.
`test/pipeline-map-link.test.js` pins the two doors, their scoping and the page's own title, and
`tools/verify-pipeline-flow.mjs` follows one of them in a browser to that title and its eleven cards.

A catalogue stage has no role field, so its second line is **derived** from the stage's own prompt by a closed rule
table in the renderer; every derived line carries the rule id and the exact phrase, which the page's inspector
shows and the verifier re-checks against the prompt. A bundle stage is not derived: it prints the name and kind of
its own `owner.role`, plus the count of the bundle's other roles on that stage. The two layouts are the
horizontal one (one mermaid flowchart per definition, at its natural 1:1 size, scrolling rather than shrinking) and
book mode (the same chain cut into rows of 2, 3 or 4 stages, with the row break drawn as a carriage return and
cross-row loop-backs in the left margin). Both keep every painted label at 11 px or more.

### 1.8 A document the page did not build

The page is generated, so drawing anything else is an **import**, and there are two ways in: `open a document`
reads a JSON file from disk, and `?doc=<url|path>` draws one the page can reach. Both hand the bytes to
`public/core/pipeline-import.js`, which turns them into the same `{meta, pipelines[], bundle}` model the renderer
already draws — no regeneration, no second page.

Three shapes arrive in practice and each is drawn as what it is:

| the document | what is drawn |
| --- | --- |
| an exported studio document (`project` + `stages[]`, `roles[]`, `handoffs[]`, `gates[]`) | one card: a stage's `owner.role` looked up in `roles[]`, a `sequence` handoff as an arrow, a `loop` handoff as the dashed one, a gate on the arrow that leaves its stage |
| the panel's catalogue (`{pipelines: {...}}` or `[definition, …]`) | one card per definition; its stages carry no role field, so the second line says `role: not stated` |
| the factory's `GET /api/pipelines` (`[{id, title, stageCount}]`) | one card per pipeline with `stageCount` nodes, each labelled `counted only` — an index counts stages and does not name them, and the page says so rather than inventing names |

**Every drawing names its source and the sha256 of the exact bytes above the cards.** A drawing that does not say
where it came from is indistinguishable from the catalogue it was built from, so the line is part of the page and
not of a report about it: the built-in drawing names its two seed files and their hashes, an imported one names the
file or URL and the full hash, plus its byte count, stage count and the moment it was read.

**A document that does not parse is a visible refusal.** The page draws the built-in catalogue first, always; a
`?doc=` or a file that is not JSON (or is JSON of none of the three shapes) prints one red sentence naming the
document and the reason, and leaves the drawing it already had exactly as it was. The alternative — an empty
canvas — is indistinguishable from a document with no stages in it, which is a document the reader would then
trust.

An `http(s)` URL is read through the panel's own `GET /api/pipeline-doc?url=`, because a page served on
`127.0.0.1:<panel port>` cannot fetch the factory on `:8090` itself: the factory sends no CORS header and the
browser is right to refuse. The route (`lib/pipeline-doc.js`) reads **loopback only**, follows redirects by hand so
a loopback URL cannot 302 to a public host, caps the body at 4 MiB and answers the bytes, their length and their
sha256. `node tools/verify-pipeline-import.mjs` drives the committed page: `?doc=` against a service (the factory's
index by default is a fixture; `--live` points it at `http://127.0.0.1:8090/api/pipelines`), the same JSON through
the file input, a malformed document by both routes with the built-in drawing still standing, and `--document`
for a full studio file and its named stages. `test/pipeline-import.test.js` drives the importer itself.


---

## 2. Per-project defaults, beside `remoteBranchPolicy`

The project already carries a per-project override for the one fact that differs between repositories here:
`projects[].remoteBranchPolicy`, resolved by `policyForProject` (project's own value → global → closed default).
The pipeline defaults are the same kind of fact and sit beside it:

```json
{
  "name": "Menu",
  "path": "C:/ProjectDevelopment/Menu",
  "remote": "sefl-bitbucket",
  "mainBranch": "main",
  "remoteBranchPolicy": "allow",
  "defaultTurnover": "sefl-review-loop",
  "defaultInvestigation": "sefl-investigate"
}
```

```json
{
  "name": "agent-worktree-gui",
  "remote": "github",
  "remoteBranchPolicy": "allow",
  "defaultTurnover": "github-force-merge",
  "defaultInvestigation": "github-investigate"
}
```

Resolution mirrors `policyForProject` exactly, because two resolvers that disagree is how a tree ends up on one
project's pipeline and another project's policy:

1. the project's own `defaultTurnover` / `defaultInvestigation`;
2. the global `defaultTurnover` / `defaultInvestigation` in `config.json`;
3. the built-in definition of that kind (`local`, `investigate`, `turnover` shipped in the seed).

An id that names nothing, or names a definition of the wrong kind, falls back to the built-in and the card says so —
never a guessed pipeline, for the same reason an unreadable `remoteBranchPolicy` falls back to `local-only` rather
than inventing a grant.

**Why per project, and why two defaults.** The two hosts this board actually has land in opposite ways, and one
default for both would be wrong in one of them every time. GitHub here is a repository with a protected main and a
ruleset; SEFL Bitbucket is a repository where a human reviewer is the gate and the PR's reviewer group is filtered
on. A single "turnover" pipeline would either merge where a human should have looked, or wait for a human who is
never asked. Two defaults, because "the work is going to land" and "the work is a question" are chosen at different
moments and by different evidence: a ticket-shaped piece of work is turnover, a probe is investigation.

### 2.1 `github-force-merge` — the turnover pipeline for a GitHub project

The reader named this default, so the pipeline may merge. That is a deliberate departure from the host's own
landing doctrine (`hosts.seed.json`, github: "Report the PR URL and leave it OPEN. The reader merges it"), and the
departure is exactly why the pipeline lives in config rather than in the doctrine: the doctrine is what a worker may
do on its own, the pipeline is the standing instruction the reader gave this project.

| # | stage | the prompt says | the exit |
|---|---|---|---|
| 1 | `commit` | commit everything in the tree on `{{branch}}`, one revertable commit, subject names the symptom | `clean` + `commits` |
| 2 | `version` | run `node tools/version.mjs suggest`, judge the level, apply it in the same commit, put the reason in the body | `command`: `node tools/version.mjs check` exits 0 |
| 3 | `push` | `git push -u origin HEAD` | `pushed` |
| 4 | `pr` | `gh pr create --fill` (and when the branch carries a bump, `--title` + `--body-file` so the level and its reason survive `--fill`) | `pr-open` + `pr-head` |
| 5 | `merge` | `gh pr merge --rebase --admin` | `pr-merged` |
| 6 | `main` | `git fetch origin {{main}}` and confirm the merge is on it | `main-moved` |

All five handoffs are `sequence`: a row that enters at `commit` visits the six stages once each, in this table's
order, and there is no loop to cross.

Two details are load-bearing and belong in the stage's own prompt, not in a general one:

- **`--admin` is the ruleset's bypass, not a preference.** The repo's ruleset (`Owner only`, id `25783530`, per
  `docs/pushing-to-a-remote.md` gate 8) refuses an update to the default branch except through a bypass. A merge
  without `--admin` fails at the host, and the stage would sit on `pr-merged` forever without saying why — so the
  prompt says which failure means "this account has no bypass" and to report instead of retrying.
- **`--rebase` keeps main linear**, which is the same property the ruleset requires. `--merge` would be refused.

### 2.2 `sefl-review-loop` — the turnover pipeline for a SEFL Bitbucket project

| # | stage | the prompt says | the exit |
|---|---|---|---|
| 1 | `branch` | rename the tree's branch to `YYYYMMDD_HHMM_<TICKET>_<desc>` — the cut's own local time, the ticket id from the work, `<desc>` lowercase words joined by `_` | `branch-name` with the pattern in §1.1 |
| 2 | `push` | `git push origin {{branch}}` (never `{{main}}`) | `pushed` |
| 3 | `pr` | `POST {base}/rest/api/1.0/projects/{{projectKey}}/repos/{{repoSlug}}/pull-requests`, `fromRef` `refs/heads/{{branch}}`, `toRef` `refs/heads/{{main}}`, title `Java Code Review for <repo> <branch>`, reviewers exactly `[Code Review - Java]`, four-section description | `pr-open` + `pr-head` + `reviewers-exact` |
| 4 | `wait` | read the activities; answer what is there, otherwise say nothing has arrived and end the turn (§6) | `pr-comments` or `pr-approved` |
| 5 | `address` | the smallest change that answers each comment, commit on `{{branch}}`, push, reply on that comment naming the commit | `pushed` + `pr-head` |
| 6 | `approve` | nothing to say — wait for the head to be reviewed | `pr-approved` |
| 7 | `merge` | `POST …/pull-requests/{id}/merge?version={version}` with the PR's current `version` | `pr-merged` + `main-moved` |

The reviewer group is the whole review queue's filter, so it is an EXIT and not a sentence: **"Code Review - Java"
and nothing else — no individuals, no DAL group on a non-DAL change** (`hosts.seed.json`, sefl-bitbucket, step 2,
which calls the same group `code_review_java` in REST). `reviewers-exact` fails a PR that carries a second reviewer,
and the `pr` stage re-opens the reviewer list rather than adding to it.

`address` and `approve` both return to `wait` after any push, because an approval at an older commit is not an
approval of the head: the loop is `wait → address → wait → approve`, and it is the exit check `pr-approved`
(approval whose `lastReviewedCommit` equals the head) that ends it, never a count of comments answered.

---

## 3. The worktree/job record

```json
{
  "pipeline": {
    "id": "sefl-review-loop",
    "stage": "wait",
    "since": "2026-11-02T14:31:07.412Z",
    "history": [
      { "from": "local", "to": "local", "stage": "work", "at": "2026-11-02T13:02:11.004Z", "by": "cut", "why": "every tree is cut local" },
      { "from": "local", "to": "turnover", "stage": "branch", "at": "2026-11-02T14:28:40.119Z", "by": "reader", "why": "the chip: this is a turnover" },
      { "from": "turnover", "to": "turnover", "stage": "push", "at": "2026-11-02T14:29:55.870Z", "by": "stage", "why": "branch-name matched" }
    ]
  }
}
```

- **`id`** is the definition in force. **`stage`** is where the tree is in it. **`since`** is when that stage began,
  and it is the clock the wait mechanic reads (§6) — not `startedAt`, which belongs to a turn.
- **`history[]`** is append-only, one entry per change, and it records the transition as well as the position:
  `from`/`to` are kinds, `stage` is the stage entered, `by` is `cut` | `reader` | `stage` | `assistant`, and `why`
  is the sentence the panel can show. A stage that loops (`wait → address → wait`) appends every hop; the history is
  a path, not a set.

**Always `local` at cut time.** `lib/jobs.js` `makeWorktree` writes `{id: "local", stage: "work", since: <cut>, history: [one entry]}` before the first turn exists. Nothing else is possible at that moment: a tree is cut before
anybody knows whether the work is a probe or a turnover, and a pipeline chosen at cut would be a promise about work
nobody has done yet. The project's `defaultTurnover` is not applied at cut — it is applied when the reader says the
work is turnover, or when an investigation's last stage chains into it (§5).

**Upgrade-only.** The kinds are ranked `local: 0, investigation: 1, turnover: 2`, and a change is applied only when
`rank(to) > rank(from)`. A downgrade request is refused with a 409 and the reason ("this tree is already a
turnover; a turnover branch reported as an investigation would be reported as not landing"), never applied quietly.
The rule is not cosmetic: the rungs have different landing rules — `turnover` may push and merge — and the landing
paragraph is what decides a `local` or investigation run's push; a silent downgrade is a tree whose brief stops
matching what the panel will let it do. §1.2's "One landing instruction" says which paragraph is authoritative.

**Where it lives, and why not only on the job.** The job store keeps 80 conversations (`KEEP_JOBS`) and marks
in-flight runs `interrupted` on restart (`lib/jobs.js` `load()`). A review loop runs for days. So the durable record
is on the TREE, keyed by its path, in the panel's state folder beside `push-guard.json`; each job carries a copy at
start for the card to draw. A wake, a restart or a second panel reads the tree record, and a card whose job has
fallen out of the ring still says which pipeline the tree is on.

---

## 4. The switching surface

### 4.1 The chip

A `pipeline: <id> ▾` chip in the same chip row as the existing `host: github` chip — `hostChipHtml`
(`public/app.js`), which is drawn in the project header the agent card sits under. It shows the id and the stage:
`pipeline: sefl-review-loop · wait ▾`, because "which pipeline" and "where in it" are one question when the reader
is judging a card.

**What is drawn today (0.74.0) — the chip, without the ▾.** `public/app.js` `pipelineChipHtml` draws the record the
card already holds (`row.pipeline`, from `/api/jobs`) in the agent card's HEAD, one gap beside its state pill, not in
the project header: the record is per TREE and one project header can hold several trees. Three states and no
fourth — a record with a stage draws `pipeline: <id> · <stage>`, a record with no stage draws the id alone, and a card
with no record draws nothing at all (never a `local` stand-in, never an empty pill). It is a `span` carrying the
record and its own tooltip: the `▾`, the upward-only options below and the switch under them stay parked until
`POST /api/worktree/pipeline` can start the new pipeline's first stage as a turn, because a menu whose every choice
would be refused is a promise the panel cannot keep. It takes `button.btn-host`'s pill height, type scale and gap,
the head stays one row at 1280, 1600 and in the 480px docked rail, and `tools/verify-pipeline-chip.mjs` proves all of
it (red on 0.73.3, where `public/` had no chip at all).

The menu offers **only what the project allows, and only upwards**:

| the tree is on | the menu offers |
|---|---|
| `local` | `investigation` (the project's `defaultInvestigation`), `turnover` (the project's `defaultTurnover`) |
| `investigation` | `turnover` (the project's `defaultTurnover`), and nothing below it |
| `turnover` | nothing — one disabled row saying turnover is final |

"What the project allows" is read from the resolved defaults, not from the whole catalogue: a definition a project
does not name is not offered there, and a project with no turnover default offers no turnover at all. The menu lists
ids and titles; it never edits a prompt — that is the tab's job, and mixing them is how a switch becomes a form.

Choosing posts `POST /api/worktree/pipeline` with `{path, id}`. The route re-reads the tree's record from disk (a
chip's menu is a claim, not a fact), validates the ladder, appends the history entry with `by: "reader"`, and starts
the new pipeline's first stage as a turn in the SAME tree on the SAME thread — the shape `POST /api/agents/reply`
already uses (`lib/jobs.js` `firstOfThread`, `replyTree`, `reply: true`). A downgrade is a 409 with the sentence, and
nothing is written. Until that turn start exists the route refuses every switch it would otherwise store — `501`
with "the pipeline switch is not yet wired to a turn start" — because a rung written without a run behind it spends
the ladder's one-way move on a stage that never began; `lib/pipelines.js` `storeSwitch` holds that gate. A switch
whose record cannot be written is a `500`, never a `200` with a record.

### 4.2 The Pipeline tab is the catalogue editor, never the switch

Settings gains a tenth panel, `data-settings-group="pipeline"`, in the existing tab strip. It is where definitions
are edited: the stage list, each stage's prompt, each stage's exit check and its parameters, and `next` — read with
`GET /api/pipelines` (the merged catalogue, its provenance and the loader's refusals) and written with
`PUT /api/pipelines`, which validates the whole document with `validatePipeline` and answers 422 with the findings
un-altered when anything is refused. The per-project `defaultTurnover` / `defaultInvestigation` are not edited here
yet: `POST /api/settings/pipeline-defaults` is still unbuilt, and the tab never writes `config.json`.

**One definition is selected, and the dropdown is what selects it.** The tab used to draw one row per definition with
its own `edit` press; a dropdown saying `id — title (kind, N stages)` says the same thing once, and the editor below
is always the definition it names — so the form and the selector cannot disagree about what Save will write. A
definition the loader dropped is still named under it, with its reason: a pipeline missing from a select has to say
why it is missing. A dirty draft is the one thing that refuses a change of selection (the select springs back and the
status says why), because replacing the form would take the half-typed sentence with it.

**Add and remove repaint the stage rows, and only those.** The dirty-draft rule is about the reader's TEXT — title,
kind, description, `next` and each stage's fields are never replaced under the caret. A stage sequence is not text:
`add stage` and `remove` change how many stages exist, and a form still drawing the old rows would disagree with the
draft Save writes. Worse, the next keystroke's `updateDraftFromForm()` reads the rows back, so the stale form would
resurrect a removed stage or drop a new one. Those two presses therefore repaint `#pipeline-stages` alone, from the
draft, and the paint is caret-safe: the focused field's stage, class, selection and scroll are captured before the
rows are replaced and restored after, and a press on a removed row's own `remove` hands focus to `add stage` rather
than leaving it on a detached button.

**The flow is the definition, drawn.** `open the flow` opens the same dialog a queue row opens (the task pipeline
window's own answer, `docs/task-pipeline.md`), in edit mode (`public/pipeline-flow.js` renders,
`public/pipeline-modal.js` is the shell): stages left to right in document order,
each stage's `exit.check` as a notch on the connector after it (the last stage's as a stub, because the gate that ends
the pipeline has no next stage), and a capped loop as an arc labelled with its cap and nothing else. A definition has
no position, so every stage is drawn **not reached** — the marks are `data-mark` (`not-reached`, `current`, `done`,
`refused`) and only a task carries a position to set them. The dialog mounts outside `#settings` and above it
(z-index 140 over 120), takes the caret, traps Tab, closes on Escape or a backdrop press, and hands focus back; the
Settings window's own bubble-phase Escape never sees the key. It reads `pipelines[id]` from the answer this tab already
holds — no second endpoint, and no write.

It is not where a tree is switched, and that is a design decision rather than an omission. A switch is a decision
about ONE piece of work, made while looking at that tree's evidence, and it belongs on the card beside the tree it
applies to. A catalogue edit is a decision about every tree that will ever use the definition. Putting the switch in
Settings would mean leaving the card — and the evidence the decision is based on — to make it, and it would let one
reader switch a tree somebody else is watching with no trace on the board.

The tab refuses, at save time, with the reason:

- a stage with no `exit`, or a `check` name that is not in §1.3's vocabulary;
- a `pattern` that does not compile, or a `command` that is not a single argv list;
- a placeholder in a prompt that is not in §1.4's list;
- a `next` that names a definition of a LOWER kind (a chain may not go backwards, §5);
- deleting a definition a project's default names, or one a live tree is on — 409, naming the projects or the trees.

---

## 5. Chaining

An investigation ends by concluding, and the conclusion is usually the reason the work has to land. So an
investigation pipeline's final stage (`conclude`) may carry `next`, and the chain hands **the same tree and the same
branch** to the project's `defaultTurnover`, in place, with no new worktree:

1. the `conclude` stage exits (`file-exists` on the report, `commits`);
2. the panel reads `next` from the definition, then resolves the project's `defaultTurnover` (§2) — `next` names
   the definition, and the project default is what it must agree with; a disagreement is refused with both ids
   named rather than picked silently;
3. the tree record is rewritten in one append: `{from: "investigation", to: "turnover", stage: <first turnover
   stage>, by: "stage", why: "the investigation concluded"}`;
4. the turnover's first stage starts as a new turn on the same thread, in the same `cwd`.

**No new worktree, for two reasons that are not conveniences.** The investigation's evidence — the capture, the
script, the notes — IS the turnover's context, and a second tree would either lose it or need it copied, which is a
second copy of the truth. And the branch name is already the one the investigation pushed; a new tree would be a new
branch, and the PR would then be opened against a branch nobody reviewed.

If the project has no `defaultTurnover`, the chain does not happen and the card says so in one line: the
investigation stays concluded, the tree stays where it is, and the reader decides. Inventing a turnover — or
falling back to another project's — would be the panel landing work nobody asked it to land.

---

## 6. The wait mechanic that must not be a sleeping worker

The `wait` stage is the one place a pipeline has to be patient, and the obvious implementation — the worker runs
`sleep 1800` and then asks again — is the one that must not be built.

**Why, in the panel's own numbers.** `jobMaxRuntimeSeconds` is 7200 and the README states the rule plainly: *"anything
still running after `jobMaxRuntimeSeconds` is stopped and marked failed"* (README, the run's hard cap). A reviewer
who takes two hours and ten minutes therefore turns a healthy review into a **failed card** — a red row on work that is
open, approved an hour later, and merged. A parked run also holds one of the gateway's run slots for the whole wait
(`max_concurrent_runs`, default 10, per `docs/runs-api-phase0.md`), so a fleet of waiting trees is a gateway at its
cap with nothing being worked on. And it is not even durable: a panel restart marks every in-flight run
`interrupted` (`lib/jobs.js` `load()`), so the sleep dies with the process and nothing wakes it — the wait is lost,
and the record says interrupted for doing nothing wrong.

**What replaces it.** The `wait` stage's turn reads the host once, reports what it found, and **ends**. Before it
ends, the panel records a re-check on the tree:

```json
{
  "pipelineWait": {
    "stage": "wait",
    "at": "2026-11-02T15:31:07.412Z",
    "every": "1h",
    "lastSeen": "2026-11-02T14:29:55.870Z",
    "attempts": 0,
    "claimedAt": null
  }
}
```

- **Where the fact comes from: the document the stage is on.** A ladder definition states the review exit on the
  stage (`stage.exit.check`); a PDL document states it on the GATE after the stage (`verified_by`), because a PDL
  stage declares an artifact and not an exit. `lib/pipelines.js` `reviewExitOf` reads both, so the wait, the rail edge
  and the 3-crossing cap are the same for a tree record's rung and a queue row's PDL document. The wait carries the
  document's id (`pipeline`) because a PDL row's tree is cut `local` and never moves; without it the timer would look
  for the stage on `local` and register nothing.
- **One ticker, not one timer per tree**, the way `lib/scheduler.js` drives the scans: a single interval asks which
  records are due, and each due record is one host read — `pr-comments` against `lastSeen` (Bitbucket
  `…/pull-requests/{id}/activities`, GitHub the PR's reviews and comments). That read is panel code and costs no
  run at all.
- **The wake is a turn on the same thread**, not a new conversation: `firstOfThread(thread)` → `replyTree(first)` →
  `reply: true`, exactly `POST /api/agents/reply`'s shape, with a one-line reason and the digest of what arrived.
  The thread is what makes it the same agent with the same context; the tree is what makes it the same branch.
- **Nothing arrived: no run.** `lastSeen` is unchanged, `attempts` climbs, and `every` backs off (1h → 2h → 4h,
  capped at the host's own advice — `hosts.seed.json` says poll the Bitbucket PR **hourly, not more often**). The
  cost of a 30-minute wait is a tick; the cost of an hour is one host GET.
- **A comment arrived: one short turn**, which is the `address` stage — read the comment, make the smallest change,
  commit, push, reply naming the commit — and then a new re-check at the new head. An approval at an older commit
  does not end the loop; `pr-approved` compares `lastReviewedCommit` to the head.
- **A long silence gets one status wake.** After `quietWakeAfter` (6h) with nothing at all, the ticker wakes the
  thread once to say "nothing from the reviewer in six hours" so the card does not look dead and the reader can
  decide whether to nudge. One wake, then the same backoff continues — not a heartbeat.
- **Idempotent by claim, not by hope.** A due record is claimed (`claimedAt`) before a wake is started, the way
  `lib/assistant.js` `terminalClaim` stops a second settle wake; a second panel, a restart between the read and the
  run, or two ticks in the same second cannot double-wake. A record whose claim is older than the run's own start
  is reclaimed, because a crash between the two is the one failure this has to survive.
- **It is not the assistant's wake.** The re-check wakes the WORKER's thread; the board assistant's rules
  (`lib/assistant.js` `wake`, `isOwnRun`) are about a card, not a stage, and the re-check must never be answered by
  a wake of the assistant's own.

The result, in one line: **a 30-minute wait costs wakes and not a parked run** — nothing at all if the reviewer is
quiet, one short turn when they answer, and never a run that has to stay alive to remember what it was waiting for.

### The second kind of wait: the stage's own run

A stage can be waiting on one other thing, and it is not the reviewer: its own worker. The record carries both kinds,
and `kind` is what tells them apart (`lib/pipelines.js` `waitKind`; a record written before the kinds existed reads as
the reviewer's, because that is the only wait the panel could write then).

```json
{
  "pipelineWait": {
    "kind": "run", "pipeline": "ping-pong", "stage": "draft", "visit": 2,
    "job": "job-7", "thread": "wtgui/hold-a-pipeline-row-…", "branch": "wtgui/hold-a-pipeline-row-…",
    "at": "2026-11-05T18:20:04.115Z", "settledAt": null
  }
}
```

- **The CUT writes it, keyed to the run.** `linkSpawnTask` links the worker to the queue row and then writes the hold
  (`lib/jobs.js` `holdPipelineStageRun`): the stage the row stands on, and the job and thread working it. A hold that
  names neither a job nor a thread is not written at all — there would be nothing to wait on.
- **It is a clock, not a lock.** A hold is due on every tick; the tick's answer is one job-store read
  (`this.get(wait.job)`), not a host call. A live card keeps the hold (`held` in the sweep's summary). A card that has
  ended — or one the 80-job ring no longer has — makes the hold due, and the sweep does exactly one thing with it.
- **One owner for the advance.** `sweepPipelineWaits` clears the hold with a compare-and-set and hands the row to the
  `advance` seam, which the server wires to `Assistant.advancePipelineTree` — the same `driveTaskPipelines` pass the
  queue tick runs. So the graph rules are never re-implemented here: a **cap**, a **gate-REVISE park**, a **missing
  artifact** and a **refusal** all still stop the walk, and the sweep reports the driver's own sentence.
- **The run's END asks the sweep, the ticker is the fallback.** The settle stamps the hold and then fires
  `Jobs.onStageSettled`, which `server.js` wires to one `tickPipelineWaits()` on the next event-loop turn. The run's
  own end is the event the hold was written for, so the row is advanced at the settle's instant instead of at the
  next minute tick (measured before the hook: 52.2 s of lag on a nine-minute stage, most of a short one). The ticker
  stays for the hold whose run the store never saw end — a restart, a dropped stream — and both doors meet the same
  compare-and-set, so the advance cannot happen twice.
- **The driver is the fallback, never the second owner.** `driveTaskPipelines` leaves a row alone while the book holds
  it on that stage and visit (`heldByBook`), because two passes moving one stage is the double-advance this exists to
  prevent. Past `HOLD_OWNER_MS` (3 minutes) from the settle, the driver takes the row back: a panel whose ticker died
  must not leave a settled row waiting for a clock nobody restarts.
- **It survives a restart by construction.** The hold is on the tree's durable record, and the sweep reads the book
  itself, so a panel restarted between the settle and the tick resumes the wait instead of starting the stage twice —
  the update is a conditional clear, and the hold is the claim.

The two kinds are one ticker and one function: `sweepPipelineWaits` branches on `kind`, and a run hold never reaches
`readReviewExit`, `renderPrompt` or `wake`. Proved on the shipped `ping-pong` document by
`node tools/verify-pipeline-walk.mjs` (the `ping-pong:timer` walk: eight starts, seven stage moves and the cap park,
every boundary after the first start crossed by the timer alone, and a restart mid-wait that starts nothing twice).

---

## 7. What exists to plug into

| the pipeline needs | what already does it | where |
|---|---|---|
| a per-project override, resolved the same way everywhere | `policyForProject` — project's own value, then global, then the closed default; unreadable falls back rather than inventing | `lib/remote-writes.js` |
| the permission a push needs | `remoteWrites.decision(worktree, policyForProject(project, config.remoteBranchPolicy))` — a pipeline never grants itself a write; `local-only` parks the stage's push on the permission box | `lib/remote-writes.js`, `lib/push-guard.js`, `<git-common-dir>/wtgui-hooks/pre-push` |
| a merge flow that re-reads every fact before a run exists | `POST /api/worktree/merge`: refuses a dirty tree, refuses a base-branch tree, refuses a second merge agent in the same tree, parks on the box under `local-only` | `server.js` (the `/api/worktree/merge` route), `lib/merge-prompt.js` |
| the paragraph a worker is handed about where its branch goes | `branchLandingLine` — the one landing instruction, composed ahead of every run's prompt and authoritative for a `local` run too; a pipeline's prompt defers to it rather than restating it | `lib/branch-policy.js`, `lib/jobs.js` |
| the host's own landing steps, per host | `hosts.landing(project)` — the PR title, reviewer group and description sections are already data | `lib/hosts.js`, `hosts.seed.json` |
| a settings panel and its tab | `data-settings-group` panels; `test/settings-tabs.test.js` already asserts one tab per group in the markup's order | `public/index.html`, `public/app.js`, `test/settings-tabs.test.js` |
| a settings write route's shape | validate → write → return the whole `settings` object; `POST /api/settings/remote-branches` is the model | `server.js` |
| a turn in an existing tree on an existing thread | `firstOfThread` + `replyTree` + `reply: true` — the reply route's own path, including its 409 when the tree is gone | `server.js` `/api/agents/reply`, `lib/jobs.js`, `lib/own-tree.js` |
| a durable record that survives the job ring and a restart | `schedulePersist` / `load` for the job copy; a tree-keyed state file for the durable one, beside `push-guard.json` | `lib/jobs.js`, `lib/paths.js` |
| one ticker instead of one timer per tree | the scheduler's due-time loop and its per-tree serialisation | `lib/scheduler.js`, `lib/pool.js` |
| a wake that cannot be issued twice | `terminalClaim` / the once-only journal entry | `lib/assistant.js` |

---

## 8. UNBUILT

The catalogue, the record, the switch route and the Pipeline tab run today. Explicitly missing:

- **No catalogue.** There is no `pipelines.json`, no `pipelines.seed.json`, no `PIPELINES_VERSION` and no loader;
  `lib/paths.js` `statePaths()` has no `pipelinesFile`.
- **No record.** No `pipeline` field on a job or on a tree; `logs/jobs.json` carries none, and `lib/jobs.js`
  `makeWorktree` writes nothing of the kind.
- **No defaults route.** `POST /api/settings/pipeline-defaults` does not exist, so a project's `defaultTurnover` /
  `defaultInvestigation` are read by `defaultForProject` but not edited from the tab. `POST /api/worktree/pipeline`
  exists, and so do the catalogue's own `GET` / `PUT /api/pipelines` (§4.2).
- **No chip menu.** The card's chip is drawn (`public/app.js` `pipelineChipHtml`, §4.1): `pipeline: <id> · <stage>`
  from the job row, beside the card's state pill. It is a `span` and carries no `▾` — there is nothing to press until
  `POST /api/worktree/pipeline` can start the first stage as a turn, and no menu is drawn before then.
- **The tab exists, without a defaults editor.** Settings has eleven panels (`display`, `cards`, `board`, `branches`,
  `data`, `gateway`, `skills`, `updates`, `permissions`, `pipeline`, `bundles`); the `pipeline` group lists the merged catalogue
  and edits one definition's title, kind, description, `next`, stages and exit checks. It does not edit a project's
  defaults.
- **No config keys.** `config.json` has `remoteBranchPolicy` and no `defaultTurnover` / `defaultInvestigation`, and
  `policyForProject` has no sibling resolver.
- **No exit-check evaluator.** Nothing in the panel can answer "is this PR approved at this head" — `lib/project.js`
  reads PR state for the board's link and verdict, not `lastReviewedCommit`.
- **No re-check ticker.** `jobMaxRuntimeSeconds` is the only clock a waiting stage has today, and it is the one that
  kills it.
- **No chaining.** `lib/child-worktree.js` cuts a CHILD tree, which is the opposite of the in-place hand-off §5
  describes; nothing can move a tree from one definition to another.
- **No tests.** There is no `test/pipelines*.test.js` and no `tools/verify-*` harness for any of the above.
