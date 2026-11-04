# Split `lib/` — eight ownership clusters, measured at 1.4.2

The lanes map ([`lanes-and-modules.md`](lanes-and-modules.md)) says which file a row must claim.
This page answers the next question: **which files one worker should own together**, in what order to
move them apart, what must not move at all, and which two clusters cannot be started at the same time.

- Snapshot: **`1e1c595`** (`package.json` `1.4.2`), the tip this branch stands on. The repository has
  908 commits, the first dated 2026-10-20; **259 of them touch `lib/`**.
- Measured, not quoted: every `from` and `import()` in `lib/` and `server.js`, every file's `wc -l`, and
  the co-change of every pair of `lib/` files over those 259 commits. Nothing here is taken from an
  older report.
- **The 88 modules** the map counts are 87 importable ESM modules plus `lib/panel-restart.cjs`, the
  helper `restart.js` spawns. The 89th file is `lib/jobs.test.js` (449 lines), a test that lives beside
  its module. The cluster table in §3 covers all 88; the test is called out in §8.
- Companions: [`lanes-and-modules.md`](lanes-and-modules.md) (the lane per file),
  [`architecture-modules.html`](architecture-modules.html) (the seam review of the six oversized files),
  [`../architecture.md`](../architecture.md) (processes, loops, data model).

**Contents**

1. [The method, and why the count is 88](#1-the-method-and-why-the-count-is-88)
2. [The clusters at a glance](#2-the-clusters-at-a-glance)
3. [The cluster table — 88 modules](#3-the-cluster-table--88-modules)
4. [The hot zone](#4-the-hot-zone)
5. [Every worker's files — fan-in 4 and above](#5-every-workers-files--fan-in-4-and-above)
6. [Pure part plus plumbing part](#6-pure-part-plus-plumbing-part)
7. [Move order](#7-move-order)
8. [What must stay put](#8-what-must-stay-put)
9. [The two clusters that collide](#9-the-two-clusters-that-collide)
10. [What this page did not measure](#10-what-this-page-did-not-measure)
- [Appendix A — re-measuring this page](#appendix-a--re-measuring-this-page)
- [Appendix B — the 28-pair co-change matrix](#appendix-b--the-28-pair-co-change-matrix)

---

## 1. The method, and why the count is 88

**What was measured.** A scrape of every static `import … from "…"` and every `import("…")` in the 88
modules and in `server.js`, resolved to a file under `lib/`. At this tip:

| Fact | Value |
|---|---|
| Modules (the map's count) | **88** — 87 ESM modules + `panel-restart.cjs` |
| Lines | **36,449** (87 ESM modules plus the 63-line helper; `jobs.test.js` adds 449 and is not counted) |
| Import edges between `lib/` files | **143** (one of them originates in `jobs.test.js`) |
| Static `server.js` → `lib/` specifiers | **54** |
| Distinct modules `server.js` reaches | **56** — the two `await import()` calls in the route chain reach `tool-results` and `tool-calls`, which no static line names |
| Import cycles | **0** strongly-connected components |
| In-degree 0 / 1 / 2+ | **34 / 25 / 28** modules. Of the 34, 33 are imported by `server.js` and nothing else; the 34th is `scan-worker.js`, spawned by `pool.js` |

The count needs one sentence because the map itself carries two: its §2 says "88 modules (+
`jobs.test.js`)", while its §4 tables add up to 87 because they exclude the helper and the test. The
helper is a real file with a lane (`restart.js`). This page uses the map's own total: **88 files that
are not the test**.

**How the clusters were chosen.** Not by folder and not by filename. The import graph was partitioned
with greedy modularity (edge weight 1, plus `0.5 × min(co-change, 4)` per pair), which produced **16
raw communities**, three of them singletons. Sixteen is too many owners for 88 files and the singletons
were accidental (a module whose only importer sits in another community). The raw partition was merged
into **8 ownership clusters**, every module assigned exactly once, no module left out. The names are a
judgement; the edges and the co-change counts are not.

**The placement rule used where the graph was ambiguous.** A module lives with the cluster that owns
the *decision it serves*, not with the folder it sits in:

- `lib/todos.js` is in LANDING even though the assistant writes it: its four importers are spread over
  ASSISTANT (actions), RUNS (jobs, completion) and LANDING (refresh-row), and the document it owns is
  the worktree's TODO list — a landing artefact.
- `lib/deliverables.js` is in RUNS although `server.js` is its only importer: it is the DELIVERABLES
  list a run hands back, written by the run harvest.
- `lib/descriptions.js` and `lib/features/descriptions.js` are in LANDING: they record what a branch
  was started to do, at the cut.
- `lib/attachments.js` is in ASSISTANT: the assistant is its only module importer; `server.js` reads it
  for the upload route.

**Co-change, and what it is not.** Co-change is a count of commits that touched two files. It is
evidence that work moves together, not proof that it must. A commit that bumps a version and edits
`jobs.js` counts only for `jobs.js` (only `lib/` paths are counted), and a large refactor can touch ten
files in one commit and never touch them together again. §9 uses it only to compare pairs of clusters
that are otherwise close on import edges.

---

## 2. The clusters at a glance

Eight clusters. **Internal** counts edges with both ends inside the cluster; **out** and **in** count
edges that leave or enter it (lib-only; the server's imports are the last column). A cluster with a high
`out` and a low `in` is a consumer; the reverse is a provider.

| Cluster | Modules | Lines | Internal | Edges out | Edges in | Server imports | What it owns |
|---|---:|---:|---:|---:|---:|---:|---|
| **SUBSTRATE** | 4 | 1,086 | 0 | 0 | 23 | 4 | where state lives, which tree is which, is this a tree — the floor |
| **SERVER** | 10 | 2,268 | 3 | 5 | 0 | 9 | HTTP framing, static files, the store, boot and restart |
| **WATCH** | 11 | 3,933 | 13 | 4 | 10 | 9 | reading git: scans, scheduling, projects, hosts, liveness |
| **RUNS** | 18 | 7,697 | 14 | 12 | 11 | 10 | agent runs: transport, console, usage, approvals, admission |
| **ASSISTANT** | 18 | 11,466 | 34 | 14 | 1 | 3 | the assistant vertical: turn, queue, charter, messages, settings |
| **INSTALL** | 6 | 2,203 | 7 | 5 | 7 | 5 | the Hermes install contract: config, models, permissions, skills |
| **PIPELINES** | 6 | 2,604 | 7 | 1 | 4 | 3 | the catalogue, the bundle contract, the task position and window |
| **LANDING** | 15 | 5,192 | 5 | 18 | 4 | 13 | worktree lifecycle and landing: cut, rebase, lock, remove, verify, push |
| **total** | **88** | **36,449** | **83** | **59** | **60** | **56** | |

Read the table in three directions:

- **ASSISTANT is the largest and the most cohesive** — 34 of its 48 edges stay inside it. Only one
  module outside it imports into it (`task-pipeline-drive.js`, through the queue), and `server.js`
  mounts three of its files directly. That is what a vertical looks like.
- **LANDING is the widest consumer** — 18 edges leave it for WATCH (9), RUNS (3), SUBSTRATE (5) and
  INSTALL (1); it is the cluster most likely to be blocked by another cluster's landing.
- **SUBSTRATE has no internal edges by construction.** It is four modules that import nothing but the
  standard library and are imported by everyone: 23 edges in from 19 files, plus four server imports.

The 60 "edges in" are 59 from modules plus one from `jobs.test.js` (which is not inside a cluster).

---

## 3. The cluster table — 88 modules

Columns: **Module** (full path), **Cluster** (repeated so a row survives being copied out of its
section), **L** (lines at `1e1c595`), **Imported by** (internal edges only, `lib/` prefix dropped;
`server` means `server.js`), **Who must touch it** (the cluster of every importer, plus SERVER when
`server.js` imports it — these are the workers who must be in the same landing as a change to that
module).

### 3.1 SUBSTRATE — 4 modules, 1,086 lines

The floor. Nothing here imports another `lib/` module; everything imports it.

| Module | Cluster | L | Imported by | Who must touch it |
|---|---|---:|---|---|
| `lib/tree-names.js` | SUBSTRATE | 275 | assistant/queue.js, deliverables.js, descriptions.js, jobs.js, locks.js, project.js, worktree-naming.js, worktrees.js, server | ASSISTANT, RUNS, LANDING, WATCH, SERVER |
| `lib/own-tree.js` | SUBSTRATE | 176 | assistant.js, assistant/landed.js, hermes-worktrees.js, jobs.js, scan.js, spawn-target.js, server | ASSISTANT, WATCH, RUNS, LANDING, SERVER |
| `lib/paths.js` | SUBSTRATE | 616 | assistant.js, attachments.js, gateway-permissions.js, jobs.js, matrix-bridge.js, restart.js, server | ASSISTANT, INSTALL, RUNS, SERVER |
| `lib/errors.js` | SUBSTRATE | 19 | http/transport.js, jobs.js, reasoning.js, server | SERVER, RUNS |

**A row in this cluster must declare the module and name the landing "repo-wide".** A change to any of
these four is felt by five clusters through 23 edges; the queue will make every other row wait, and it
should. This is the one cluster where a directory claim on `lib/paths` is honest rather than lazy.

### 3.2 SERVER — 10 modules, 2,268 lines

The composition root's own library: framing, static, the row store, boot, restart.

| Module | Cluster | L | Imported by | Who must touch it |
|---|---|---:|---|---|
| `lib/build-version.js` | SERVER | 206 | http/static.js, server | SERVER |
| `lib/http/transport.js` | SERVER | 169 | http/static.js, server | SERVER |
| `lib/sync-state.js` | SERVER | 104 | store.js, server | SERVER |
| `lib/chart-columns.js` | SERVER | 40 | server only | SERVER (server.js) |
| `lib/http/static.js` | SERVER | 76 | server only | SERVER (server.js) |
| `lib/open-url.js` | SERVER | 87 | server only | SERVER (server.js) |
| `lib/panel-restart.cjs` | SERVER | 63 | spawned by `restart.js` | SERVER (`restart.js` spawns it) |
| `lib/port-guard.js` | SERVER | 71 | server only | SERVER (server.js) |
| `lib/restart.js` | SERVER | 1,233 | server only | SERVER (server.js) |
| `lib/store.js` | SERVER | 219 | server only | SERVER (server.js) |

**A row in this cluster must declare the module and `server.js`.** A payload change also claims the
module that judges the field (`lib/store.js`, `lib/jobs.js` or `lib/scan.js`) and `public/app.js` when
the page draws it. Nine of its ten modules are imported by `server.js`, whose 54-specifier import block
is edited at every step of §7.

### 3.3 WATCH — 11 modules, 3,933 lines

Reading git, off the request path: the worker pool, the ticker, projects, hosts, liveness.

| Module | Cluster | L | Imported by | Who must touch it |
|---|---|---:|---|---|
| `lib/scan.js` | WATCH | 410 | assistant.js, base-ref.js, child-worktree.js, features/spawn.js, parents.js, project.js, projects.js, rebase.js, scan-worker.js, scheduler.js, steward.js, server | ASSISTANT, WATCH, LANDING, SERVER |
| `lib/project.js` | WATCH | 395 | scheduler.js, spawn-target.js, worktree-remove.js, worktrees.js, server | WATCH, LANDING, SERVER |
| `lib/base-ref.js` | WATCH | 79 | project.js, scheduler.js | WATCH |
| `lib/hosts.js` | WATCH | 523 | project.js, scheduler.js, server | WATCH, SERVER |
| `lib/parents.js` | WATCH | 367 | child-worktree.js, steward.js, server | LANDING, SERVER |
| `lib/activity.js` | WATCH | 535 | scheduler.js, server | WATCH, SERVER |
| `lib/hermes-worktrees.js` | WATCH | 214 | projects.js, server | WATCH, SERVER |
| `lib/pool.js` | WATCH | 131 | server only | SERVER (server.js) |
| `lib/projects.js` | WATCH | 345 | server only | SERVER (server.js) |
| `lib/scan-worker.js` | WATCH | 12 | spawned by `pool.js` | WATCH (`pool.js` spawns it) |
| `lib/scheduler.js` | WATCH | 922 | server only | SERVER (server.js) |

**A row in this cluster must declare the module and `lib/scan.js` when the row shape moves.** A cadence
change claims `scheduler.js` only; a new liveness signal claims `activity.js` + `server.js` +
`public/app.js` + `public/style.css` — four lanes for one chip, as the map's §4.2 already says.

### 3.4 RUNS — 18 modules, 7,697 lines

The run state machine and everything a card reads from it.

| Module | Cluster | L | Imported by | Who must touch it |
|---|---|---:|---|---|
| `lib/jobs.js` | RUNS | 4,289 | assistant.js, jobs.test.js, restart.js, subagents.js, verify-landed.js, worktree-naming.js, worktree-remove.js, worktrees.js, server | ASSISTANT, SERVER, RUNS, LANDING |
| `lib/tool-text.js` | RUNS | 110 | jobs.js, jobs/console-lines.js, subagents.js, tool-results.js | RUNS |
| `lib/completion.js` | RUNS | 384 | assistant.js, assistant/messages.js, jobs.js | ASSISTANT, RUNS |
| `lib/model-prices.js` | RUNS | 312 | hermes-models.js, session-usage.js | INSTALL, RUNS |
| `lib/reasoning.js` | RUNS | 25 | hermes-runtime.js, jobs.js | INSTALL, RUNS |
| `lib/session-usage.js` | RUNS | 485 | hermes-models.js, jobs.js | INSTALL, RUNS |
| `lib/branch-policy.js` | RUNS | 61 | jobs.js | RUNS |
| `lib/clarify.js` | RUNS | 119 | jobs.js | RUNS |
| `lib/jobs/console-lines.js` | RUNS | 228 | jobs.js | RUNS |
| `lib/verify-prompt.js` | RUNS | 203 | verify-landed.js, server | RUNS, SERVER |
| `lib/approvals.js` | RUNS | 102 | server only | SERVER (server.js) |
| `lib/deliverables.js` | RUNS | 479 | server only | SERVER (server.js) |
| `lib/merge-prompt.js` | RUNS | 240 | server only | SERVER (server.js) |
| `lib/subagents.js` | RUNS | 367 | server only | SERVER (server.js) |
| `lib/thinking.js` | RUNS | 68 | server only | SERVER (server.js) |
| `lib/tool-calls.js` | RUNS | 102 | server only | SERVER (server.js) |
| `lib/tool-results.js` | RUNS | 60 | server only | SERVER (server.js) |
| `lib/verify-landed.js` | RUNS | 63 | server only | SERVER (server.js) |

**A row in this cluster must declare `lib/jobs.js` plus the module it changes.** Three of these have
`jobs.js` as their only importer (`branch-policy.js`, `clarify.js`, `jobs/console-lines.js`), and every
console line crosses the class. A card-visible field also claims `public/app.js`; a new control verb
claims `server.js` and `docs/using-the-board.md`.

### 3.5 ASSISTANT — 18 modules, 11,466 lines

The largest cluster: one root module doing the turn (`assistant.js`, 6,596 lines) and seventeen files it
owns.

| Module | Cluster | L | Imported by | Who must touch it |
|---|---|---:|---|---|
| `lib/assistant/read.js` | ASSISTANT | 262 | assistant.js, assistant/actions.js, assistant/audit.js, assistant/charter-file.js, assistant/match.js, assistant/notes-file.js, assistant/profile.js, assistant/queue.js, assistants.js, roles.js | ASSISTANT |
| `lib/assistant/config.js` | ASSISTANT | 371 | assistant.js, assistant/notes-file.js, assistant/profile.js, assistant/store-file.js | ASSISTANT |
| `lib/charter.js` | ASSISTANT | 265 | assistant.js, assistant/charter-file.js, roles.js | ASSISTANT |
| `lib/assistant/actions.js` | ASSISTANT | 151 | assistant.js, assistant/audit.js | ASSISTANT |
| `lib/assistant/audit.js` | ASSISTANT | 182 | assistant.js, assistant/store-file.js | ASSISTANT |
| `lib/assistant/queue.js` | ASSISTANT | 1,296 | assistant.js, task-pipeline-drive.js, server | ASSISTANT, PIPELINES, SERVER |
| `lib/roles.js` | ASSISTANT | 222 | assistant.js, assistants.js | ASSISTANT |
| `lib/assistant/charter-file.js` | ASSISTANT | 140 | assistant.js | ASSISTANT |
| `lib/assistant/landed.js` | ASSISTANT | 143 | assistant.js | ASSISTANT |
| `lib/assistant/match.js` | ASSISTANT | 76 | assistant.js | ASSISTANT |
| `lib/assistant/messages.js` | ASSISTANT | 534 | assistant.js | ASSISTANT |
| `lib/assistant/notes-file.js` | ASSISTANT | 78 | assistant.js | ASSISTANT |
| `lib/assistant/profile.js` | ASSISTANT | 131 | assistant.js | ASSISTANT |
| `lib/assistant/store-file.js` | ASSISTANT | 187 | assistant.js | ASSISTANT |
| `lib/assistants.js` | ASSISTANT | 166 | assistant.js | ASSISTANT |
| `lib/attachments.js` | ASSISTANT | 174 | assistant.js | ASSISTANT |
| `lib/matrix-bridge.js` | ASSISTANT | 492 | assistant.js, server | ASSISTANT, SERVER |
| `lib/assistant.js` | ASSISTANT | 6,596 | server only | SERVER (server.js) |

**A row in this cluster must declare `lib/assistant.js` and the submodule.** The queue row is the worst
case: `lib/assistant/queue.js` is imported by `assistant.js`, `task-pipeline-drive.js` and `server.js`,
and eleven test files import it — a queue-field change claims all three modules, the Queue tab in
`public/assistant.js`, and those eleven tests.

### 3.6 INSTALL — 6 modules, 2,203 lines

What this panel knows about the Hermes install it is driving.

| Module | Cluster | L | Imported by | Who must touch it |
|---|---|---:|---|---|
| `lib/hermes-config.js` | INSTALL | 454 | approvals.js, gateway-permissions.js, hermes-models.js, jobs.js, provider-profiles.js, restart.js, skills.js, server | RUNS, INSTALL, SERVER |
| `lib/hermes-runtime.js` | INSTALL | 120 | activity.js, features/spawn.js, gateway-permissions.js, hermes-config.js, hermes-models.js, jobs.js, restart.js | WATCH, LANDING, INSTALL, RUNS, SERVER |
| `lib/gateway-permissions.js` | INSTALL | 585 | server only | SERVER (server.js) |
| `lib/hermes-models.js` | INSTALL | 286 | server only | SERVER (server.js) |
| `lib/provider-profiles.js` | INSTALL | 227 | server only | SERVER (server.js) |
| `lib/skills.js` | INSTALL | 531 | server only | SERVER (server.js) |

**A row in this cluster must declare the module and `server.js`**; a settings-tab change also claims
`public/app.js` (the Settings window lives there) and `docs/using-the-board.md`. `hermes-config.js` is
the widest: seven module importers, so editing it alone is a lane four clusters wait on.

### 3.7 PIPELINES — 6 modules, 2,604 lines

The catalogue, the import contract, and where a task sits on a pipeline.

| Module | Cluster | L | Imported by | Who must touch it |
|---|---|---:|---|---|
| `lib/pipeline-bundle.js` | PIPELINES | 391 | assistant.js, pipeline-window.js, task-pipeline-assign.js, task-pipeline-drive.js, task-pipeline.js | ASSISTANT, PIPELINES |
| `lib/task-pipeline.js` | PIPELINES | 202 | pipeline-window.js, task-pipeline-assign.js, task-pipeline-drive.js | PIPELINES |
| `lib/pipelines.js` | PIPELINES | 1,070 | jobs.js, server | RUNS, SERVER |
| `lib/task-pipeline-assign.js` | PIPELINES | 194 | assistant.js, server | ASSISTANT, SERVER |
| `lib/task-pipeline-drive.js` | PIPELINES | 497 | assistant.js | ASSISTANT |
| `lib/pipeline-window.js` | PIPELINES | 250 | server only | SERVER (server.js) |

**A row in this cluster must declare the module and `public/pipeline-flow.js` when a stage mark, notch
or arc changes**, and `public/pipeline-modal.js` when the dialog's behaviour changes. A new bundle
field claims `lib/pipeline-bundle.js` plus the six fixtures under `test/fixtures/bundles/` and the eight
test files that import it.

### 3.8 LANDING — 15 modules, 5,192 lines

Worktree lifecycle, landing, naming, locks and the TODO list.

| Module | Cluster | L | Imported by | Who must touch it |
|---|---|---:|---|---|
| `lib/todos.js` | LANDING | 724 | assistant/actions.js, completion.js, jobs.js, refresh-row.js, server | ASSISTANT, RUNS, LANDING, SERVER |
| `lib/remote-writes.js` | LANDING | 460 | features/spawn.js, gateway-permissions.js, server | LANDING, INSTALL, SERVER |
| `lib/descriptions.js` | LANDING | 235 | features/descriptions.js | LANDING |
| `lib/locks.js` | LANDING | 383 | steward.js, server | LANDING, SERVER |
| `lib/spawn-target.js` | LANDING | 169 | features/spawn.js | LANDING |
| `lib/child-worktree.js` | LANDING | 97 | server only | SERVER (server.js) |
| `lib/features/descriptions.js` | LANDING | 117 | server only | SERVER (server.js) |
| `lib/features/spawn.js` | LANDING | 294 | server only | SERVER (server.js) |
| `lib/push-guard.js` | LANDING | 573 | server only | SERVER (server.js) |
| `lib/rebase.js` | LANDING | 287 | server only | SERVER (server.js) |
| `lib/refresh-row.js` | LANDING | 225 | server only | SERVER (server.js) |
| `lib/steward.js` | LANDING | 470 | server only | SERVER (server.js) |
| `lib/worktree-naming.js` | LANDING | 207 | server only | SERVER (server.js) |
| `lib/worktree-remove.js` | LANDING | 180 | server only | SERVER (server.js) |
| `lib/worktrees.js` | LANDING | 771 | server only | SERVER (server.js) |

**A row in this cluster must declare the module and `server.js`**; a landing change also claims
`lib/jobs.js` (the job it starts) and `docs/pushing-to-a-remote.md` or
`docs/child-worktrees-and-rollups.md` when the rule text moves. Ten of these fifteen have `server.js`
as their only importer — a landing change is a route change more often than not.

---

## 4. The hot zone

### 4.1 The files that actually move

Churn over the 259 commits that touch `lib/` (percentages are of those 259):

| Module | Commits | Share | Cluster | In-degree |
|---|---:|---:|---|---:|
| `lib/jobs.js` | 89 | 34.4% | RUNS | 8 |
| `lib/assistant.js` | 78 | 30.1% | ASSISTANT | 0 |
| `lib/scheduler.js` | 34 | 13.1% | WATCH | 0 |
| `lib/assistant/config.js` | 18 | 6.9% | ASSISTANT | 4 |
| `lib/assistant/queue.js` | 12 | 4.6% | ASSISTANT | 2 |
| `lib/activity.js` | 12 | 4.6% | WATCH | 1 |
| `lib/restart.js` | 11 | 4.2% | SERVER | 0 |
| `lib/scan.js` | 10 | 3.9% | WATCH | 11 |
| `lib/paths.js` | 9 | 3.5% | SUBSTRATE | 6 |
| `lib/project.js` | 9 | 3.5% | WATCH | 4 |

Two rows carry the whole story:

- **`jobs.js` changes in one commit out of three.** It is the run supervisor, the console's line
  factory, the approval window, the 429 hold, the pipeline waiter and the artifact harvester in one
  4,289-line class. No cluster boundary survives contact with a file that hot; the split in §6 is the
  only thing that gives it a chance.
- **`assistant.js` changes in three commits out of ten and has no internal importer at all.** Its only
  consumer is `server.js`, but **34 test files** import it. It is a vertical with a 6,596-line root —
  the heat is internal calls, not fan-in.

`scheduler.js` is the counter-example that makes the point: the third hottest file in the tree, with
**zero** internal importers. Heat is not fan-in, and neither one alone picks the order in §7.

### 4.2 Job admission — the seam with no owner

"Admission" is not a module in this tree. It is the path from *a task may start* to *the gateway accepted
a turn*, and it is spread over four clusters:

| Where | What it decides |
|---|---|
| `lib/assistant/queue.js:260` `holdState` | may this task start, or is its thread / tree / task / path / manual hold live? |
| `lib/assistant/queue.js:381` `pickTask` | which queued task is first — the lane head, ordered by id |
| `lib/assistant/queue.js:1158` `settleTasks` | a finished turn parks its task, re-queues it, or marks it done |
| `lib/assistant.js:4936` `startSpawn` | runs the same gate again on the press, then calls `jobs.create` (3,733 and 5,778) |
| `lib/features/spawn.js:236,270` | the row's own spawn path calls `jobs.create` directly |
| `lib/jobs.js:2375` `create()` | accepts the turn — **there is no panel-side concurrency cap here** |
| `lib/jobs.js:2656–2760` | the gateway's HTTP 429 is *held*, not failed: `RETRY_429_DEFAULTS` = 6 attempts, 1.5 s base, 30 s cap, 25% jitter |
| `server.js:1183, 4258, 5230, 5362` | four routes call `jobs.create` with their own option sets |

That is **eight `jobs.create` calls in three files, plus the definition in a fourth** (ASSISTANT, LANDING,
SERVER, RUNS). The only admission limit in force is the gateway's concurrent-run cap, observed as a 429;
the panel has no queue of its own for runs — it has a queue of *tasks* whose holds it evaluates. A change
to "who may start" is therefore a four-cluster landing today. The cleanest cut is to move the three
decision functions (`holdState`, `pickTask`, `staleReason`) into RUNS and leave the queue document and
its HTTP adapter in ASSISTANT; that puts the rule in one cluster and leaves ASSISTANT importing it, the
same direction it already imports `jobs.js`.

### 4.3 The assistant submodules

`lib/assistant/read.js` is the model the rest of the tree should copy: **10 importers, 0 imports.** It is
a pure reading of a turn — prose, tool lines, failure cycles, the last line — and every assistant rule
goes through it. `lib/assistant/config.js` is the same shape (4 importers, 0 imports). The cluster table
shows the rest: nine submodules with exactly one importer (`assistant.js`), which is why the cluster is
cohesive and why a change inside it rarely blocks anyone outside it.

The exception is `lib/assistant/queue.js`: 1,296 lines, two module importers plus the server, **eleven
test files**, and an HTTP adapter in the same file (§6.1). It is the one assistant module that behaves
like a hub.

---

## 5. Every worker's files — fan-in 4 and above

Thirteen modules are imported by four or more other modules. These are the files a worker must expect to
edit even when their own change is elsewhere; the "Tests" column is how many files under `test/` name the
module in an import specifier.

| Module | Cluster | In | Importer clusters | Tests | Why it stops you |
|---|---|---:|---|---:|---|
| `lib/scan.js` | WATCH | 11 | WATCH 6, LANDING 4, ASSISTANT 1, +server | 4 | defines the row shape the SSE payload carries; 410 lines, but every reader of a row imports it |
| `lib/assistant/read.js` | ASSISTANT | 10 | ASSISTANT 10 | 0 | every assistant rule reads a turn through it — and it has no imports, so it never drags anything in |
| `lib/jobs.js` | RUNS | 8 | RUNS 3, LANDING 3, SERVER 1, ASSISTANT 1, +server | 20 | the run class; a console-line or status change is felt by worktrees, naming, restart and the assistant |
| `lib/tree-names.js` | SUBSTRATE | 8 | LANDING 4, RUNS 2, WATCH 1, ASSISTANT 1, +server | 2 | the naming ledger; read by jobs, locks, deliverables, queues, project |
| `lib/hermes-config.js` | INSTALL | 7 | INSTALL 4, RUNS 2, SERVER 1, +server | 2 | the gateway's config file, read by approvals, permissions, models, skills, restart |
| `lib/hermes-runtime.js` | INSTALL | 7 | INSTALL 3, LANDING 1, RUNS 1, WATCH 1, SERVER 1 | 1 | where Hermes is; the 120-line module that broke the tree's one import cycle |
| `lib/own-tree.js` | SUBSTRATE | 6 | WATCH 2, ASSISTANT 2, LANDING 1, RUNS 1, +server | 1 | the tree-on-disk predicate; a wrong answer moved a replay into the primary checkout once |
| `lib/paths.js` | SUBSTRATE | 6 | SERVER 2, ASSISTANT 2, INSTALL 1, RUNS 1, +server | 2 | every durable path is derived here; 616 lines and the widest blast radius per line |
| `lib/pipeline-bundle.js` | PIPELINES | 5 | PIPELINES 4, ASSISTANT 1 | 8 | the import contract: one refusal rule changes what the studio's bundle may carry |
| `lib/assistant/config.js` | ASSISTANT | 4 | ASSISTANT 4 | 8 | the assistant's rule table and validator; every knob and escalation |
| `lib/project.js` | WATCH | 4 | WATCH 1, LANDING 3, +server | 2 | project-level git helpers; `worktrees`, `rebase`, `spawn-target` all call it |
| `lib/todos.js` | LANDING | 4 | RUNS 2, LANDING 1, ASSISTANT 1, +server | 4 | the one TODO list, written by the assistant, jobs, completion and the row's own refresh |
| `lib/tool-text.js` | RUNS | 4 | RUNS 4 | 0 | the tool-result unwrap; all four callers are in RUNS, which is why it is cheap to own |

The distribution behind the table: **34 modules have no internal importer** (33 are server-only and
`scan-worker.js` is spawned by `pool.js`), **25 have exactly one**, and **28 have two or more**. More
than a third of the library is a leaf; the thirteen above are the part that is not.

---

## 6. Pure part plus plumbing part

A "pure" part here means: no `fs`, no `net`, no `child_process`, no clock, no module-level singleton —
given the same inputs it returns the same output, so a test can drive it without a sandbox. "Plumbing" is
everything that makes the test need a panel, a temp dir or a port. The verdict column says whether the
split is worth a landing now.

| Module | L | In | Pure part (proposed file) | Plumbing part (stays) | Verdict |
|---|---:|---:|---|---|---|
| `lib/jobs.js` | 4,289 | 8 | `lib/runs/policy.js` — **≈370 lines**: `RELEASE_BRIEF`, `DELIVER_BRIEF`, `LIVE_JOB_STATUS`, `RETRY_429_DEFAULTS`, `retry429Settings`, `retryAfterMs`, `retry429DelayMs`, `fmtWait`, `remoteWriteLine`, `treeOfJob`, `runGonePointerLines`, `APPROVAL_CHOICE_LABEL`, `WAIT_LETTERS`, `isDestructiveAsk`, `waitsOf` (lines 97–470) | the `Jobs` class: transport, poll, persist, timers | **SPLIT FIRST** — the admission policy becomes testable without a gateway |
| `lib/scan.js` | 410 | 11 | `lib/watch/row-shape.js` — **≈70 lines**: `rowSignature`, `boardSignature`, `outsideNestedWorktrees`, `parentFor` | `gitIn` + `scanWorktree` (≈300 lines of git orchestration) | **SPLIT** — the signature is what `store`/`scheduler` compare; it should not pull `child_process` |
| `lib/assistant/queue.js` | 1,296 | 2 | `lib/assistant/queue-decision.js` — **≈230 lines**: `filesIntersect`, `intersectingFiles`, `orderOf`, `byQueueOrder`, `holdState`, `staleReason`, `pickTask` (moves to `lib/runs/admission.js` with §4.2's cut) | `readQueueFile`/`writeQueueFile` (≈70 lines) + `createQueueRoutes` (≈70 lines) | **SPLIT** — and move the decision half to RUNS (§4.2) |
| `lib/todos.js` | 724 | 4 | `lib/landing/todo-format.js` — **≈220 lines**: `parseTodoLines`, `todoBlock`, `todoCounts`, `todoSummary`, `proposeClosed`, `words`, `itemAge`, `TODO_GLYPH` | the `TodoLists` store (≈470 lines) | **SPLIT** — `jobs.js` imports four pure formatters today and gets the store with them |
| `lib/hermes-config.js` | 454 | 7 | `lib/install/config-text.js` — **≈140 lines**: `blockRange`, `readBlockValue`, `setBlockValueText`, `deleteBlockValueText`, `readApprovalSettings`, `setApprovalTimeoutText`, `isLocalGatewayUrl`, `maskKey` | `hermesConfigPath`, the read/write wrappers and state readers | **SPLIT** — the YAML-block edit is the risky part and is pure text |
| `lib/project.js` | 395 | 4 | `lib/watch/pr-index.js` — **≈125 lines**: `isInsideProject`, `projectWorktrees`, `buildPrIndex`, `prFor` | `execFile`, `remoteHeads`, `prIndex`, `branchUpstreams` | **SPLIT** — the PR index is a pure transform of a listing |
| `lib/tree-names.js` | 275 | 8 | `lib/tree-names-rules.js` — **≈90 lines**: `tagOf`, `treeKey`, `namingState`, `autoNameRefusal`, `renameRefusal`, `describeNaming` | the `TreeNames` store (≈157 lines) | **LATER** — substrate; do it behind a re-export, after the clusters land |
| `lib/paths.js` | 616 | 6 | a pure derivation module (≈250 lines): `expandHome`, `resolveDirs`, `resolveConfigPath`, `statePaths`, `resolveLayout`, `pathKey`, `insideDir`, `scratchLine`, `humanBytes` | `ensureDirs`, size/`walkSize`, `migrateState`, journal, `cleanScratch` | **LATER** — same reason: 23 edges in, and every cluster's PR would conflict |
| `lib/assistant/read.js` | 262 | 10 | already pure — **0 imports** | — | **NO SPLIT** — this is the model, not a target |
| `lib/assistant/config.js` | 371 | 4 | already pure — **0 imports** | — | **NO SPLIT** |
| `lib/pipeline-bundle.js` | 391 | 5 | already pure except `readBundle` (17 lines, `readFileSync`); `parseBundle`, `pipelineById`, `stageById`, `positionOf` are pure | — | **NO SPLIT** — the only plumbing is one 17-line file read |
| `lib/tool-text.js` | 110 | 4 | already pure — **0 imports** | — | **NO SPLIT** |
| `lib/own-tree.js` | 176 | 6 | the rule is three exports; the fs/git probe *is* the module | — | **NO SPLIT** — 176 lines, and a split would add a file every cluster imports |
| `lib/hermes-runtime.js` | 120 | 7 | location plumbing end to end | — | **NO SPLIT** — too small to divide |

Three observations that decide the table:

1. **The pure parts are where the tests are.** `lib/jobs.js` is named in 20 test files and
   `lib/jobs.test.js` boots a real panel to test re-attach. Moving `retry429*` out gives the admission
   policy the one thing it lacks: a test with no gateway.
2. **The pure parts are small.** `jobs.js` is 4,289 lines and only ≈370 are pure; `scan.js` is 410 and
   ≈70 are pure. The split is worth it for the import weight and the testability, not for line count.
3. **The queue is the reverse case.** 1,296 lines, of which ≈1,100 are pure functions over arrays and
   ≈140 are the file store plus the HTTP adapter. Its problem is not purity; it is that the decision
   half and the transport half live in the same file and are owned by different clusters.

### 6.1 The HTTP surface is not all in SERVER

Three domain modules export their own route adapters, mounted from `server.js` at lines 867, 871 and 874:

| Module | Adapter | Mounted for |
|---|---|---|
| `lib/assistant/queue.js:1225` | `createQueueRoutes` | `GET/POST /api/assistant/queue` |
| `lib/pipeline-window.js:207` | `createPipelineWindowRoutes` | the task pipeline window |
| `lib/task-pipeline-assign.js:183` | `createPipelineCatalogueRoutes` | the pipeline catalogue |

Their docblocks say why: the transport helpers are handed in, so the module owns no HTTP knowledge and a
test can drive it with stubs. That is a good rule, and it means **the SERVER cluster is not "the routes"**
— it is framing, static files, the store and boot. Any split that moves these three adapters into
`lib/server/` would add an import back into the modules that deliberately avoid one.

---

## 7. Move order

The cluster graph has cycles (RUNS↔LANDING, RUNS↔INSTALL, ASSISTANT↔RUNS, ASSISTANT↔PIPELINES), so
there is no topological order. The order below is chosen by two rules: **move the clusters that
`jobs.js` imports from before `jobs.js` itself**, and **break the remaining cycles in favour of the
consumer that is cheaper to edit twice**.

| Step | Cluster | New home | Files whose specifiers change | Why here |
|---:|---|---|---:|---|
| 0 | SUBSTRATE | stays at `lib/` | 0 | freeze it; §8 |
| 1 | PIPELINES | `lib/pipelines/` | **6** — 1 outside import, 2 outside importers, 3 server | the most independent cluster: 0 co-change commits with SERVER, WATCH, INSTALL or LANDING; `pipeline-bundle.js` is already pure |
| 2 | SERVER | `lib/server/` (`http/` stays a subfolder) | **11** — 2 outside imports, 0 outside importers, 9 server | `http/` is already a folder; the only consumer is `server.js`; INSTALL and WATCH do not import into it |
| 3 | INSTALL | `lib/install/` | **13** — 3 outside imports, 5 outside importers, 5 server | must precede RUNS: RUNS imports `reasoning`, `session-usage` and `model-prices` from it |
| 4 | WATCH | `lib/watch/` | **21** — 4 outside imports, 8 outside importers, 9 server | `scan.js` is the hub; moving it before LANDING lets LANDING's nine imports of scan/project settle in one edit |
| 5 | LANDING | `lib/landing/` | **27** — 10 outside imports, 4 outside importers, 13 server | the widest consumer (18 edges out); it imports WATCH (done), RUNS (not yet) and INSTALL (done) |
| 6 | RUNS | `lib/runs/` | **24** — 5 outside imports, 9 outside importers, 10 server | `jobs.js` moves once; its own `todos.js` import is the only pointer left to LANDING |
| 7 | ASSISTANT | `lib/assistant/` (already a folder; move `assistant.js` in) | **11** — 7 outside imports, 1 outside importer, 3 server | last: it imports RUNS, PIPELINES, WATCH, LANDING and SUBSTRATE, all final by now |

Three things to know about the cost column:

- **`server.js` is edited at every step.** It has 54 static specifiers into `lib/`; seven landings means
  seven edits to its import block. That is the real reason the landing concurrency is 1, and it is why
  each step should be a path-only landing: no behaviour, no renamed exports, no re-export shims.
- **`jobs.js` gets the same treatment from the other side.** Every cluster it imports from (PIPELINES,
  INSTALL, LANDING) moves before it, so its import block is final at step 6. The price is the three
  LANDING modules that import `jobs.js`: they point at `lib/jobs.js` after step 5 and at
  `lib/runs/jobs.js` after step 6.
- **The lane rule already understands cluster directories.** `filesIntersect` treats `lib/pipelines.js`
  and `lib/pipelines` as one claim (`lib/assistant.js` and `lib/assistant` are its own example), so a
  cluster directory is a lane the moment the first file moves — a row that claims the old file still
  intersects the new folder. Nothing in `lib/assistant/queue.js` needs to change for that.
- **`lib/assistant/` is already a directory.** Step 7 is the only step that moves a root file into an
  existing folder, which makes it the one step where the old file and the new folder collide in a
  reviewer's diff. Do it alone.

**The proof for each step** is `npm test` plus a boot of `server.js`; the suite's import graph is the
check that nothing was left pointing at the old path. Step 6 additionally runs `node lib/jobs.test.js`,
which is the re-attach harness and is not in `npm test` (the test script globs `test/*.test.js`).

---

## 8. What must stay put

Five things cannot move with their cluster, or can move only with a companion file in the same landing:

1. **The four SUBSTRATE modules.** 19 modules plus `server.js` import into them (23 edges in). Moving
   any of the four is a 20-file path rewrite (19 modules plus `server.js`) and a conflict with every
   other cluster's open PR. They are the floor; the split's job is to make them small and boring, not
   to move them. The `paths.js` and `tree-names.js` pure splits in §6 are deliberately "later" for this
   reason.
2. **`lib/jobs.test.js` stays beside `jobs.js`.** 449 lines, run by hand (`node lib/jobs.test.js`), and
   it boots `server.js` against a throwaway panel config. `npm test` does not run it — the script is
   `node --test --test-concurrency=4 test/*.test.js` — so moving it would silently drop it from every
   reader's habit and every doc that names the command.
3. **`lib/panel-restart.cjs` moves only with `restart.js`.** `restart.js:1119` resolves it as
   `path.join(here, "panel-restart.cjs")`. If `restart.js` moves to `lib/server/`, the helper moves with
   it; if only one moves, a panel restart fails at the worst moment.
4. **`lib/scan-worker.js` moves only with `pool.js`.** `pool.js:15` is
   `const WORKER = path.join(HERE, "scan-worker.js")`, and `pool.js` constructs `new Worker(WORKER)`. Two
   files, one landing.
5. **`jobs.js`'s `import "../public/core/steerable.js"` (line 60) must be rewritten, not moved.** It is
   the tree's one deliberate server→client edge: the same 82-line file is a classic script in
   `public/index.html` and a bare import in `jobs.js`. Moving `jobs.js` to `lib/runs/jobs.js` makes the
   specifier `../../public/core/steerable.js`. Do not "fix" it by copying the file or by adding a second
   copy under `lib/`; the two copies would drift and the page would run a different predicate from the
   route.

Two more things are API, not layout, and a move must not rename them:

- `lib/assistant/queue.js`'s exported names (`holdState`, `pickTask`, `filesIntersect`, `queueDigest`,
  `TASK_FILES_MAX` = 40, `TASK_FILE_MAX` = 300). Eleven test files and the assistant's preamble read them.
- The three `create*Routes` adapters (§6.1). Moving a route adapter out of its domain module is a
  design change; a cluster move is not the landing for it.

---

## 9. The two clusters that collide

**ASSISTANT and RUNS, if both start at once.** The evidence, in order of strength:

| Measure | ASSISTANT + RUNS | Next worst pair |
|---|---:|---|
| Commits touching both clusters | **17** | RUNS + WATCH 10; SERVER + RUNS 9; SERVER + ASSISTANT 9 |
| Hottest module pair | **`assistant.js` + `jobs.js`, 16 commits** | `project.js` + `scheduler.js`, 9; `activity.js` + `scheduler.js`, 8 |
| Import edges between them | **3** (ASSISTANT → RUNS) | LANDING → WATCH 9 (but only 4 co-change commits) |
| Shared seam | job admission: `queue.js` (ASSISTANT), `assistant.js` (ASSISTANT), `jobs.js` (RUNS), `server.js` (SERVER) | — |

`assistant.js` + `jobs.js` is the highest co-change pair in the whole tree, and the two modules are the
two hottest files. A worker on the assistant vertical and a worker on runs will both need `jobs.js` or
its call sites on day one: the queue decides *whether* a task may start, and `jobs.js` decides *what
happens when it does*. The three import edges are only the visible part; the 17 co-change commits are
the part that would turn into conflicts.

**The second collision is RUNS with anything.** RUNS + WATCH is 10 commits (`jobs.js` + `scheduler.js` 7);
RUNS + SERVER is 9 (`jobs.js` + `restart.js` 6); RUNS + LANDING is 9 (`features/spawn.js` + `jobs.js` 5).
RUNS is the cluster to start alone.

**What can start together.** PIPELINES has **0** co-change commits with SERVER, WATCH, INSTALL and
LANDING; LANDING + WATCH share 9 import edges but only 4 co-change commits. If two workers start on the
same day, the safe pair is **PIPELINES + any of SERVER / INSTALL / LANDING**, or **LANDING + WATCH** with
the understanding that LANDING moves second (it is the consumer).

The full 28-pair matrix is Appendix B.

---

## 10. What this page did not measure

- **No merge simulation.** The collision claim is co-change plus import edges, not a trial merge of two
  branches. A real trial would be a better number and is not in this page.
- **No runtime.** No profile, no frame timing, no memory. That is `../arch-review-efficiency.md`.
- **No test run.** The suite is counted (`test/*.test.js`, 168 files) and its import fan-in is measured;
  its colour at this tip is not claimed here.
- **No rename has landed.** The eight names are a proposal; the tree still has the old paths. §7 is an
  order, not a record.
- **`public/` and `tools/` are outside this page.** The map covers them; this page only counts the
  client files a server-side move would touch (`public/app.js`, `public/assistant.js`,
  `public/style.css`) where a cluster note needs it.

---

## Appendix A — re-measuring this page

The numbers come from four commands, run at `1e1c595`:

```bash
# 1. the file set and line counts (88 files: 87 .js modules + the .cjs helper)
find lib -name '*.js' | wc -l          # 88, including jobs.test.js
find lib -type f | wc -l               # 89, including panel-restart.cjs
find lib -name '*.js' ! -name 'jobs.test.js' | xargs wc -l | tail -1

# 2. the server's static import block
grep -o 'from "\./lib/[^"]*"' server.js | sort -u | wc -l    # 54

# 3. the co-change window
git log --pretty=format:__C__ --name-only -- lib | grep -c '^__C__'   # 259

# 4. the churn of one module
git log --oneline -- lib/jobs.js | wc -l                               # 89
```

The scrape is 20 lines of Python: `os.walk("lib")`, a regex over each file for

```python
import re
pat = re.compile(r'import\s+(?:[^;"\']*?\bfrom\s+)?["\']([^"\']+)["\']|import\(\s*["\']([^"\']+)["\']\s*\)')
```

then `os.path.normpath` against the module set and a `collections.Counter` over commits for co-change. It
is deliberately the same method as the map's Appendix B, so the two pages can be compared.

**Counting rules that matter.** Static and dynamic imports are counted separately; a directory import
(`import "./x/"`) resolves to `x/index.js` if one exists; an import of a file outside `lib/` (the
`public/core/steerable.js` edge) is not counted; `jobs.test.js` is counted as an importer but not as a
cluster member; `server.js` is a node but not a module.

---

## Appendix B — the 28-pair co-change matrix

Commits touching at least one module in both clusters, over the 259 commits that touch `lib/`.

| | SERVER | WATCH | RUNS | ASSISTANT | INSTALL | PIPELINES | LANDING |
|---|---:|---:|---:|---:|---:|---:|---:|
| **SUBSTRATE** | 5 | 6 | 6 | 8 | 2 | 2 | 5 |
| **SERVER** | — | 8 | 9 | 9 | 1 | 0 | 2 |
| **WATCH** | | — | 10 | 4 | 1 | 0 | 4 |
| **RUNS** | | | — | **17** | 8 | 3 | 9 |
| **ASSISTANT** | | | | — | 1 | 3 | 8 |
| **INSTALL** | | | | | — | 0 | 2 |
| **PIPELINES** | | | | | | — | 0 |

Read the zeros: PIPELINES is the only cluster that has never moved in the same commit as SERVER, WATCH,
INSTALL or LANDING. Read the 17: ASSISTANT and RUNS are one change wearing two names.
