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
| `local` | work in this tree and stop. The panel's behaviour today. | commit; report. No push, no PR. Its prompt is the existing LANDING paragraph (`lib/branch-policy.js` `branchLandingLine`) and nothing else. |
| `investigation` | find out something and write it down, in this tree. | read, probe, run things, commit notes and scripts, open a draft PR if the project allows it. Ends by concluding. |
| `turnover` | this work is going to land. | push, open the PR, answer review, merge when the host's rule says it is merged. |

The ladder is `local → investigation → turnover` and it only climbs (§3). The point of naming three and not five is
that each rung changes one thing — whether a remote branch exists, and whether a human has to answer before main
moves — and a reader can hold three in their head while judging a card.

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
The rule is not cosmetic: the three kinds have different landing rules — `turnover` may push and merge, `local` may
not push at all — so a silent downgrade is a tree whose brief stops matching what the panel will let it do.

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
nothing is written.

### 4.2 The Pipeline tab is the catalogue editor, never the switch

Settings gains a ninth panel, `data-settings-group="pipeline"`, in the existing tab strip. It is where definitions
are created and edited: the stage list, each stage's prompt, each stage's exit check and its parameters, `next`, and
the per-project `defaultTurnover` / `defaultInvestigation` — written to `pipelines.json` and `config.json` by routes
of their own (`POST /api/settings/pipelines`, `POST /api/settings/pipeline-defaults`), following
`POST /api/settings/remote-branches`' shape: validate, write, return the whole settings object back.

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

**Why, in the panel's own numbers.** `jobMaxRuntimeSeconds` is 3600 and the README states the rule plainly: *"anything
still running after `jobMaxRuntimeSeconds` is stopped and marked failed"* (README, the run's hard cap). A reviewer
who takes an hour and ten minutes therefore turns a healthy review into a **failed card** — a red row on work that is
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

---

## 7. What exists to plug into

| the pipeline needs | what already does it | where |
|---|---|---|
| a per-project override, resolved the same way everywhere | `policyForProject` — project's own value, then global, then the closed default; unreadable falls back rather than inventing | `lib/remote-writes.js` |
| the permission a push needs | `remoteWrites.decision(worktree, policyForProject(project, config.remoteBranchPolicy))` — a pipeline never grants itself a write; `local-only` parks the stage's push on the permission box | `lib/remote-writes.js`, `lib/push-guard.js`, `<git-common-dir>/wtgui-hooks/pre-push` |
| a merge flow that re-reads every fact before a run exists | `POST /api/worktree/merge`: refuses a dirty tree, refuses a base-branch tree, refuses a second merge agent in the same tree, parks on the box under `local-only` | `server.js` (the `/api/worktree/merge` route), `lib/merge-prompt.js` |
| the paragraph a worker is handed about where its branch goes | `branchLandingLine` — the `local` pipeline's prompt is this, and a pipeline composes with it rather than replacing it | `lib/branch-policy.js` |
| the host's own landing steps, per host | `hosts.landing(project)` — the PR title, reviewer group and description sections are already data | `lib/hosts.js`, `hosts.seed.json` |
| a settings panel and its tab | `data-settings-group` panels; `test/settings-tabs.test.js` already asserts one tab per group in the markup's order | `public/index.html`, `public/app.js`, `test/settings-tabs.test.js` |
| a settings write route's shape | validate → write → return the whole `settings` object; `POST /api/settings/remote-branches` is the model | `server.js` |
| a turn in an existing tree on an existing thread | `firstOfThread` + `replyTree` + `reply: true` — the reply route's own path, including its 409 when the tree is gone | `server.js` `/api/agents/reply`, `lib/jobs.js`, `lib/own-tree.js` |
| a durable record that survives the job ring and a restart | `schedulePersist` / `load` for the job copy; a tree-keyed state file for the durable one, beside `push-guard.json` | `lib/jobs.js`, `lib/paths.js` |
| one ticker instead of one timer per tree | the scheduler's due-time loop and its per-tree serialisation | `lib/scheduler.js`, `lib/pool.js` |
| a wake that cannot be issued twice | `terminalClaim` / the once-only journal entry | `lib/assistant.js` |

---

## 8. UNBUILT

Nothing in this page runs today. Explicitly missing:

- **No catalogue.** There is no `pipelines.json`, no `pipelines.seed.json`, no `PIPELINES_VERSION` and no loader;
  `lib/paths.js` `statePaths()` has no `pipelinesFile`.
- **No record.** No `pipeline` field on a job or on a tree; `logs/jobs.json` carries none, and `lib/jobs.js`
  `makeWorktree` writes nothing of the kind.
- **No route.** There is no `POST /api/worktree/pipeline` and no `POST /api/settings/pipelines` /
  `/api/settings/pipeline-defaults`.
- **No chip.** `hostChipHtml` is the only chip of that shape; there is no `pipeline: … ▾` anywhere in `public/`.
- **No tab.** Settings has eight panels (`display`, `cards`, `board`, `branches`, `data`, `gateway`, `skills`,
  `updates`); there is no `pipeline` group, and `test/settings-tabs.test.js` would fail the moment the markup and the
  tab strip disagreed about one.
- **No config keys.** `config.json` has `remoteBranchPolicy` and no `defaultTurnover` / `defaultInvestigation`, and
  `policyForProject` has no sibling resolver.
- **No exit-check evaluator.** Nothing in the panel can answer "is this PR approved at this head" — `lib/project.js`
  reads PR state for the board's link and verdict, not `lastReviewedCommit`.
- **No re-check ticker.** `jobMaxRuntimeSeconds` is the only clock a waiting stage has today, and it is the one that
  kills it.
- **No chaining.** `lib/child-worktree.js` cuts a CHILD tree, which is the opposite of the in-place hand-off §5
  describes; nothing can move a tree from one definition to another.
- **No tests.** There is no `test/pipelines*.test.js` and no `tools/verify-*` harness for any of the above.
