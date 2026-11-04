# Lanes and modules — what owns what, and who else is in the file

A module map with a lane column: every top-level module under `lib/`, `server.js`, every file in
`public/`, and every script in `tools/` — what it owns, what it imports and what it exports to — plus
the part the board cannot answer today: **which lane a change sits in when two agents want the same
file**, and what a row must declare to avoid colliding with the other one.

- Snapshot: **`1b8b795`** (`package.json` `1.2.0`) is the commit this map was measured at, with
  `git ls-tree -r`, `git show <ref>:<path> | wc -l`, one scrape of every `from`/`import()` in
  `server.js` and `lib/`, and `public/index.html`'s own script order. Main moved twice while the page
  was in review (`1.3.0`, `1.4.0`), so every number below was re-measured at **`db8dc06`**
  (`1.4.0`), the tip it lands on. The two trees are identical for the whole server half — the same 88
  `lib/` modules, lines, edges and `server.js` — and for the 17-script client order; what moved is
  `public/assistant.js`, the shell, the stylesheet, four harnesses and the tests, and those cells carry
  the tip's numbers. Nothing here is quoted from either older report; §10 says where those reports
  disagree with this tree.
- This is a map, not a review. No cut is proposed and no seam is ranked; the signed, costed cut list
  is [`architecture-modules.html`](architecture-modules.html).
- Companions: [`../architecture.md`](../architecture.md) (processes, loops, data model),
  [`architecture-modules.html`](architecture-modules.html) (the seam review of the six oversized
  files), `../arch-review-organization.md` (where code lives), `../arch-review-efficiency.md` (what
  the timers cost), `../arch-review-functional.md` (the board's state machine).

**Contents**

1. [What a lane is, in this repo's own words](#1-what-a-lane-is-in-this-repos-own-words)
2. [The tree in numbers at 1.2.0](#2-the-tree-in-numbers-at-120)
3. [The lanes](#3-the-lanes)
4. [lib/ — 88 modules, lane by lane](#4-lib--88-modules-lane-by-lane)
5. [server.js — the composition root](#5-serverjs--the-composition-root)
6. [public/ — 17 classic scripts](#6-public--17-classic-scripts)
7. [public/style.css — the one stylesheet](#7-publicstylecss--the-one-stylesheet)
8. [tools/ — 166 scripts](#8-tools--166-scripts)
9. [What a row must declare](#9-what-a-row-must-declare)
10. [Where the two reports disagree with this tree](#10-where-the-two-reports-disagree-with-this-tree)
11. [Where to add a new thing](#11-where-to-add-a-new-thing)
12. [What this page did not measure](#12-what-this-page-did-not-measure)
13. [Ownership clusters](#13-ownership-clusters)
- [Appendix A — every tools script](#appendix-a--every-tools-script)
- [Appendix B — re-measuring this page](#appendix-b--re-measuring-this-page)

---

## 1. What a lane is, in this repo's own words

A lane is not a folder and not a team. It is a **file two queued rows both claim**, derived at read
time by the Queue tab and by the assistant's digest. The rule is one function and its docblock, in
`lib/assistant/queue.js` (1,296 lines):

> Two rows that claim the same file are in one LANE, named by that file: `lib/assistant.js`. A lane is
> ordered by id, and its first row is the lane head — the one that goes first when somebody starts
> work. A row behind a head that is LIVE reads "waiting on #N": starting it now would put two workers
> in that file, which is the same rule the conflict flag already states, said as an order rather than
> as a warning.

The mechanics, as the code states them (`laneInfo`, `filesIntersect`, `intersectingFiles` in that
file):

- **Derived, not stored.** A row may carry its own `lane`, but an absent one is computed from the
  `files[]` it claims, so a queue file written before lanes existed still orders.
- **Only queued and running rows take part.** A parked row is waiting for a person, so it neither
  heads a lane nor sits behind one.
- **Two files intersect when they are equal, or when one names a directory the other lives in**
  (`filesIntersect`). `lib/assistant.js` and `lib/assistant` are one claim; `lib/a.js` and `lib/ab.js`
  are not.
- **A claim is capped at 40 files, 300 characters each** (`TASK_FILES_MAX`, `TASK_FILE_MAX`), and the
  paths are normalised — `/` separators, no leading `./`, no trailing `/`, case-folded.
- **A row with no files has no lane.** The assistant's own reply says so in as many words: "no file
  claimed, so no lane" (`lib/assistant.js`, in the `SUBMIT` handler).

That mechanism is sound and narrow: it orders rows that already named the same file. What it cannot
do is tell the submitter **which file to name**, because that is a fact about the tree. That is what
this page adds. A module's lane here is the file whose change its work cannot avoid — the file another
row will also be holding when it lands. Two lanes can be in one change; when they are, both files go
in `files[]` and the row waits behind whichever head is live.

One direction of travel is worth stating because it decides most of the table in §4: `server.js`
imports 54 internal modules, and **33 of the 88 modules under `lib/` are imported by nothing else**.
For those 33, a change that is visible outside the module is a change to `server.js` too — a route,
a payload field, or a boot wiring line. The lane is named by the file that has to move with it.

---

## 2. The tree in numbers at 1.2.0

One Node process, ESM, `"dependencies": {}`, no bundler, no build step, no CI. Measured at `1b8b795`:

| Part | Files | Lines | What it is |
|---|---|---|---|
| `server.js` | 1 | 5,833 | composition root and the whole HTTP API |
| `lib/` | 88 modules (+ `jobs.test.js`) | 36,450 (+ 449) | the server-private library |
| `public/` JS | 17 classic scripts | 32,645 | the page, no module system |
| `public/index.html` | 1 | 922 | the shell: 17 `<script>` tags in a fixed order |
| `public/style.css` | 1 | 4,133 | 917 class names, 2 `!important`, 0 `@layer` |
| `tools/` | 166 scripts (+ 1 vendored lib) | 78,604 (+ 2,314) | harnesses and probes |
| `test/` | 168 `*.test.js` | 37,090 | the Node suite |
| `harness/` | playwright lanes | — | outside this map (§12) |

The server graph, from the import scrape (`from` and `import()` in `server.js` + all 88 modules):

| Fact | Value | What it means |
|---|---|---|
| Nodes / edges | 89 nodes (88 modules + `server.js`), 198 edges | the library points downward |
| Import cycles | 0 strongly-connected components | nothing to untangle on this side |
| Modules with in-degree 1 | 48 of 88 | half the library has exactly one consumer |
| Imported by `server.js` and nothing else | 33 | a route is the only way in |
| Modules that import nothing internal | 28 | pure leaves |
| Highest in-degree | `lib/scan.js`, 12 | it defines the row shape the SSE payload carries |
| Second highest | `lib/assistant/read.js`, 10 | every assistant rule reads a turn through it |
| Then | `lib/tree-names.js` 9, `lib/jobs.js` 9, `lib/hermes-config.js` 8 | the shared stores |
| Then | `lib/paths.js` 7, `lib/own-tree.js` 7, `lib/hermes-runtime.js` 7 | the substrate |

`server.js` itself: `createServer` opens at line 2,378, the first branch (`/api/health`) is at 2,396,
the last at 5,571, and there are **135 `if (route === …)` branches plus one `route.startsWith`
prefix branch** — 136 dispatch conditions over 5,833 lines. All 54 `from` imports are `lib/` modules.
One more import binds no name: `import "./public/core/steerable.js"` (line 98) — the same 82-line
file is imported for its `wtSteerable` side effect by `lib/jobs.js` (line 60) and loaded as a classic
script by the page. That is the one deliberate server→client edge in the tree.

---

## 3. The lanes

Ten server-side lanes, four client lanes, and the files that are shared by every landing. A lane is
named by the file a row claims; the module totals are the ones in §4.

| Lane (named by) | Server modules | Lines | What it is | The shared file a row usually also declares |
|---|---|---|---|---|
| `server.js` | 10 | 2,224 (+ 5,833) | composition root, HTTP framing, store, boot | `server.js` itself |
| `lib/scan.js` | 11 | 3,933 | watching: git reads, scheduling, projects, liveness | `server.js` (the row shape becomes the SSE payload) |
| `lib/jobs.js` | 18 | 7,697 | agent runs: transport, console, usage, approvals | `public/app.js` when a card field is added |
| `lib/hermes-config.js` | 6 | 2,203 | the Hermes install contract: config, models, permissions | `server.js` (every reader is a route) |
| `lib/assistant.js` | 20 | 11,818 | the assistant vertical: queue, charter, roles, messages | `lib/assistant.js` itself |
| `lib/pipelines.js` | 6 | 2,604 | pipelines: catalogue, bundles, task position, window | `public/pipeline-flow.js` when a mark changes |
| `lib/worktrees.js` | 13 | 4,840 | worktree lifecycle and landing: cut, rebase, lock, remove, verify, push | `server.js` |
| `lib/paths.js` | 1 | 616 | where every durable file lives | every lane — it is the path vocabulary |
| `lib/tree-names.js` | 1 | 275 | which tree is named what, by whom, when | `server.js`, `lib/jobs.js`, `lib/worktrees.js` |
| `lib/own-tree.js` | 1 | 176 | is this directory still a tree? | `lib/scan.js`, `lib/jobs.js` |
| `public/app.js` | — | 22,695 | the board: rows, cards, console, chart, every handler | `public/style.css` when a class is added |
| `public/assistant.js` | — | 4,666 | the assistant's client half: the float, alerts, watchlist, scratchpad and settings | `public/style.css` (`as-*`) |
| `public/pipeline-flow.js` (+ `pipeline-modal.js`) | — | 990 | the pipeline drawing and its dialog | `public/style.css` (`pipe-*`) |
| `public/style.css` | — | 4,133 | the one stylesheet | `public/app.js`, `public/assistant.js`, `public/index.html` |
| `tools/verify-<name>.mjs` | — | 166 scripts | one harness per claim; found by name, not registered | `package.json` when it becomes an npm script |
| `package.json` | — | — | the landing lock: every landing bumps it | nothing — it *is* the shared file |

### 3.1 The four hot files, measured

These are the files two rows collide on most often, and each collides for a different reason.

| File | Lines | Why two rows meet there | Measured |
|---|---|---|---|
| `server.js` | 5,833 | every route, payload field and boot wiring is a line in it; 33 modules have no other caller | 54 internal imports, 136 dispatch conditions |
| `lib/jobs.js` | 4,289 | the run state machine: every event's shape passes through the class, and 9 files import it (8 modules plus its own test) | importers: `assistant.js`, `restart.js`, `subagents.js`, `verify-landed.js`, `worktree-naming.js`, `worktree-remove.js`, `worktrees.js`, `jobs.test.js`, `server.js` |
| `public/app.js` | 22,695 | one file holds every renderer and handler; a client module is a cut through its names, not a dependency edge | 874 function declarations + 266 `const`/`let`, 148 `// ----` markers, 448 CSS classes appear only in it |
| `public/style.css` | 4,133 | one sheet for the board, the assistant and the pipeline dialog | 917 classes; 154 used only by `assistant.js`, 448 only by `app.js`, 52 by `app.js` + `index.html`, 36 only by the pipeline scripts, 101 by none of them |

Two more files are shared by every landing and are not modules:

- **`package.json`** — the version gate. The pre-push hook refuses a branch that carries commits
  without a bump, so every landing edits this one file. It is why the landing concurrency is 1 and
  why the panel serialises on the bump; `architecture-modules.html` §7 measured it at 124 of 200
  commits.
- **`public/index.html`** — the script order is the load contract. A new client file is a new
  `<script>` tag here, and a change to the order is a change to every phase-1 module's guarantees.

### 3.2 The wide modules

A module with many importers behaves like a shared file even when nobody names it in `files[]`. In
descending in-degree, the ones worth declaring whenever you touch them:

| Module | Lines | Importers | Note |
|---|---|---|---|
| `lib/scan.js` | 410 | 12 | defines the row shape; a field added here reaches the SSE payload |
| `lib/assistant/read.js` | 262 | 10 | every assistant rule reads a turn through it |
| `lib/tree-names.js` | 275 | 9 | the naming store, read by jobs, queues, locks, deliverables |
| `lib/jobs.js` | 4,289 | 8 (+ `jobs.test.js`) | the run class |
| `lib/hermes-config.js` | 454 | 8 | gateway config readers |
| `lib/paths.js` | 616 | 7 | data and scratch directories |
| `lib/own-tree.js` | 176 | 7 | the tree-on-disk predicate |
| `lib/hermes-runtime.js` | 120 | 7 | where Hermes is |
| `lib/project.js` | 395 | 5 | project-level git helpers |
| `lib/todos.js` | 724 | 5 | the worktree TODO list |

---

## 4. `lib/` — 88 modules, lane by lane

Columns: **Module** (full path), **L** (lines at `1b8b795`), **Owns** (what the file's own
header says it is, in one line), **Imports** and **Imported by** (internal edges only, `lib/`
prefix dropped; `server` means `server.js`). A dash means none.

### 4.1 Lane `server.js` — the request surface (10 modules, 2,224 lines)

The composition root is not in this table; §5 covers it. These are the modules that only a route or
the server's own wiring reaches.

| Module | L | Owns | Imports | Imported by |
|---|---|---|---|---|
| `lib/http/transport.js` | 169 | JSON responses, body reads, gzip, auth and the SSE stream — HTTP framing and nothing else | errors | http/static, server |
| `lib/http/static.js` | 76 | serves `public/` from disk per request, with the `..` containment check | transport, build-version | server |
| `lib/errors.js` | 19 | `HttpError` and the status a failed request answers with; anything else is a 500 | — | transport, jobs, reasoning, server |
| `lib/build-version.js` | 206 | the served client bundle and its version: hashes `public/`, rewrites the shell's marker | — | http/static, server |
| `lib/store.js` | 219 | in-memory rows per project + worktree, with the change events forwarded over SSE | sync-state | server |
| `lib/sync-state.js` | 104 | a branch against its own copy on the remote — the ahead/behind comparison | — | store, server |
| `lib/port-guard.js` | 71 | one panel per port: who holds it, and the refusal line | — | server |
| `lib/open-url.js` | 87 | opens a URL or folder in the OS browser without a command interpreter seeing it | — | server |
| `lib/chart-columns.js` | 40 | which chart columns the page draws, persisted in `config.json` | — | server |
| `lib/restart.js` | 1,233 | restarting the gateway or this panel from the board, including the turn that asked | hermes-config, hermes-runtime, jobs, paths | server |

**A row in this lane must declare** the module and `server.js`. If the change is a new route, it also
claims `test/` (a route test) and `README.md` (the Endpoints table). `errors.js` and
`http/transport.js` are the two files every other route-touching lane meets; declare them explicitly
when you edit them, because nothing else will.

### 4.2 Lane `lib/scan.js` — watching (11 modules, 3,933 lines)

Named by the hub: `lib/scan.js` is the most-imported module in the tree (12 importers) because it
defines the row shape the SSE payload carries.

| Module | L | Owns | Imports | Imported by |
|---|---|---|---|---|
| `lib/scan.js` | 410 | per-worktree git inspection, read-only, run inside a worker thread | own-tree | assistant, base-ref, child-worktree, features/spawn, parents, project, projects, rebase, scan-worker, scheduler, steward, server |
| `lib/scan-worker.js` | 12 | the worker-thread entry: one scan per message, off the main thread | scan | — |
| `lib/pool.js` | 131 | fixed-size `worker_threads` pool, keyed and deduped, one scan per worktree at a time | — | server |
| `lib/scheduler.js` | 922 | the one ticker, per-worktree due times and the three cadences | project, base-ref, hosts, scan, activity | server |
| `lib/project.js` | 395 | main-thread project-level git helpers (few calls per project) | base-ref, hosts, scan, tree-names | scheduler, spawn-target, worktree-remove, worktrees, server |
| `lib/projects.js` | 345 | project discovery: every git repo under `scanRoots` becomes a monitored project | scan, hermes-worktrees | server |
| `lib/base-ref.js` | 79 | which remote the base ref is built from — one answer for header and rows | scan | project, scheduler |
| `lib/activity.js` | 535 | liveness evidence: files, Hermes sessions, board, ports — cached per signal | hermes-runtime | scheduler, server |
| `lib/hosts.js` | 523 | where a project's branches and pull requests live (host records, mapping) | — | project, scheduler, server |
| `lib/parents.js` | 367 | the branch a worktree was cut from, and the sha that ref held at the cut | scan | child-worktree, steward, server |
| `lib/hermes-worktrees.js` | 214 | `hermes worktree list --json`: the audit Hermes already ships | own-tree | projects, server |

**A row in this lane must declare** the module and `lib/scan.js` when the row shape moves. A cadence
change claims `scheduler.js` only; a new liveness signal claims `activity.js` + `server.js` (the
snapshot assembles it) + `public/app.js` (the chip renders it) + `public/style.css` (the chip is
styled) — four lanes for one chip.

### 4.3 Lane `lib/jobs.js` — agent runs (18 modules, 7,697 lines)

| Module | L | Owns | Imports | Imported by |
|---|---|---|---|---|
| `lib/jobs.js` | 4,289 | agent supervision over the Hermes HTTP Runs API: the run state machine, console lines, artifacts, control verbs | branch-policy, clarify, completion, errors, hermes-config, hermes-runtime, jobs/console-lines, own-tree, paths, pipelines, reasoning, session-usage, todos, tool-text, tree-names | assistant, restart, subagents, verify-landed, worktree-naming, worktree-remove, worktrees, jobs.test, server |
| `lib/jobs/console-lines.js` | 228 | one gateway event and its tool preview become the console lines the page draws | tool-text | jobs |
| `lib/tool-text.js` | 110 | a tool result is JSON on the wire and prose in the console: the unwrap | — | jobs, jobs/console-lines, subagents, tool-results |
| `lib/tool-results.js` | 60 | tool output the live stream does not carry, read from the session store | tool-text | server |
| `lib/tool-calls.js` | 102 | the calls behind a collapsed "+ N commands" batch | — | server |
| `lib/thinking.js` | 68 | what an agent thought before it acted, read from the Hermes store | — | server |
| `lib/subagents.js` | 367 | subagents a run started, read from the Hermes store | jobs, tool-text | server |
| `lib/session-usage.js` | 485 | the card's token/duration readout, read from the store | model-prices | hermes-models, jobs |
| `lib/model-prices.js` | 312 | what each model costs per million tokens, as this panel cached it | — | hermes-models, session-usage |
| `lib/reasoning.js` | 25 | the reasoning-effort vocabulary and the model options per turn | errors | hermes-runtime, jobs |
| `lib/clarify.js` | 119 | what the panel knows about the gateway's `clarify` tool, and the two gates | — | jobs |
| `lib/approvals.js` | 102 | pending human-approval requests from the Hermes approval transport | hermes-config | server |
| `lib/completion.js` | 384 | the completion notice: what a spawned worker actually produced | todos | assistant, assistant/messages, jobs |
| `lib/branch-policy.js` | 61 | the paragraph a worker is handed about where its branch goes | — | jobs |
| `lib/deliverables.js` | 479 | the DELIVERABLES list: every agent's handed-back file, link or image | tree-names | server |
| `lib/verify-prompt.js` | 203 | the prompt a CHECKING agent runs on, and the one line it answers with | — | verify-landed, server |
| `lib/verify-landed.js` | 63 | the panel's side of that answer: which settled runs have one, and what it deletes | verify-prompt, jobs | server |
| `lib/merge-prompt.js` | 240 | the prompt a MERGING agent runs on, and the label its card carries | — | server |

**A row in this lane must declare** `lib/jobs.js` plus the module it changes, because the class is the
only caller of 7 of these and the shape of every console line crosses it. A card-visible field also
claims `public/app.js` (renderer) and often `public/style.css`. A new control verb claims `server.js`
(route) + `docs/using-the-board.md`.

### 4.4 Lane `lib/hermes-config.js` — the Hermes install contract (6 modules, 2,203 lines)

| Module | L | Owns | Imports | Imported by |
|---|---|---|---|---|
| `lib/hermes-config.js` | 454 | the Hermes settings this panel reads (and the ones it does not own) | hermes-runtime | approvals, gateway-permissions, hermes-models, jobs, provider-profiles, restart, skills, server |
| `lib/hermes-runtime.js` | 120 | where Hermes is and what its gateway wants: home, gateway state, identity | reasoning | activity, features/spawn, gateway-permissions, hermes-config, hermes-models, jobs, restart |
| `lib/hermes-models.js` | 286 | the models a run can actually ask for, priced from the cached table | hermes-config, hermes-runtime, model-prices, session-usage | server |
| `lib/gateway-permissions.js` | 585 | the permissions actually in force and where each one comes from | hermes-config, hermes-runtime, paths, remote-writes | server |
| `lib/skills.js` | 531 | where skills are absorbed from, and what they are (four sources, one index) | hermes-config | server |
| `lib/provider-profiles.js` | 227 | OpenRouter profiles: one (base URL, key) pair under a name | hermes-config | server |

**A row in this lane must declare** the module and `server.js`; a settings-tab change also claims
`public/app.js` (the Settings window lives there) and `docs/using-the-board.md`. `hermes-config.js` is
the widest: 8 importers, so editing it alone is a lane every other lane waits on.

### 4.5 Lane `lib/assistant.js` — the assistant vertical (20 modules, 11,818 lines)

| Module | L | Owns | Imports | Imported by |
|---|---|---|---|---|
| `lib/assistant.js` | 6,596 | the board's assistant: the sentry clock, the turn, the actions it can take | 12 `assistant/*` submodules, assistants, attachments, charter, completion, jobs, matrix-bridge, own-tree, paths, pipeline-bundle, roles, scan, task-pipeline-assign, task-pipeline-drive | server |
| `lib/assistant/config.js` | 371 | the assistant's contract with the reader: every knob, the rule table, the validator | — | assistant, assistant/notes-file, assistant/profile, assistant/store-file |
| `lib/assistant/read.js` | 262 | reading a turn: what a run's console says, and the facts every rule asks | — | assistant, actions, audit, charter-file, match, notes-file, profile, queue, assistants, roles |
| `lib/assistant/queue.js` | 1,296 | one assistant's task queue: the store, the lane derivation, the digest | assistant/read, tree-names | assistant, task-pipeline-drive, server |
| `lib/assistant/messages.js` | 534 | the message board between assistant and agents — a derived view, not a log | completion | assistant |
| `lib/assistant/actions.js` | 151 | the action-line grammar the model is told to write, read back in one place | assistant/read, todos | assistant, assistant/audit |
| `lib/assistant/audit.js` | 182 | the per-turn command audit: what a turn wrote vs what the panel did | actions, read | assistant, assistant/store-file |
| `lib/assistant/charter-file.js` | 140 | the charter file: the long tier of memory, and its three writers | charter, read | assistant |
| `lib/assistant/landed.js` | 143 | is a brief's work already on main? patch-id/tree equality, never "ahead by N" | own-tree | assistant |
| `lib/assistant/match.js` | 76 | prose → alert: is it a question, work that produced nothing, a standing rule | read | assistant |
| `lib/assistant/notes-file.js` | 78 | one assistant's scratchpad, a file per assistant | config, read | assistant |
| `lib/assistant/profile.js` | 131 | one assistant's own settings file: knobs, rule levels, role prompt, escalations | config, read | assistant |
| `lib/assistant/store-file.js` | 187 | `assistant.json`: the one file the assistant remembers across restarts with | audit, config | assistant |
| `lib/assistants.js` | 166 | one record per assistant the float can show; #1 is deliberately different | assistant/read, roles | assistant |
| `lib/roles.js` | 222 | the board's library of assistant jobs, and the charter each carries | assistant/read, charter | assistant, assistants |
| `lib/charter.js` | 265 | the charter's pure text: seed, one dated entry, the prune | — | assistant, assistant/charter-file, roles |
| `lib/descriptions.js` | 235 | what each branch was STARTED to do, in the words of the run that started it | tree-names | features/descriptions |
| `lib/features/descriptions.js` | 117 | the half of descriptions that sees both stores: a harvest needs a row | descriptions | server |
| `lib/attachments.js` | 174 | the one convention for a file attached to a prompt (stored, absolute path in text) | paths | assistant, server |
| `lib/matrix-bridge.js` | 492 | the Matrix bridge from the panel's side: start, tail, config patch | paths | assistant, server |

**A row in this lane must declare** `lib/assistant.js` and the submodule, and the queue row is the
worst case: `lib/assistant/queue.js` is imported by `lib/assistant.js`, `lib/task-pipeline-drive.js`
and `server.js`, so a queue-field change claims all three plus `public/assistant.js` (the queue tab
renders it), eleven test files that import the queue module, and the four that pin the tab's markers.

### 4.6 Lane `lib/pipelines.js` — pipelines (6 modules, 2,604 lines)

| Module | L | Owns | Imports | Imported by |
|---|---|---|---|---|
| `lib/pipelines.js` | 1,070 | what a worktree is FOR: the catalogue, the exit-check vocabulary, the ladder | — | jobs, server |
| `lib/pipeline-bundle.js` | 391 | the pipeline import contract: what a studio bundle carries, and its refusals | — | assistant, pipeline-window, task-pipeline, task-pipeline-assign, task-pipeline-drive |
| `lib/task-pipeline.js` | 202 | where a task is on a pipeline — the read side of the task record | pipeline-bundle | pipeline-window, task-pipeline-assign, task-pipeline-drive |
| `lib/task-pipeline-assign.js` | 194 | putting a task ON a pipeline — the write side, and the catalogue it offers | pipeline-bundle, task-pipeline | assistant, server |
| `lib/task-pipeline-drive.js` | 497 | driving a task THROUGH its pipeline, one stage at a time | assistant/queue, pipeline-bundle, task-pipeline | assistant |
| `lib/pipeline-window.js` | 250 | the task pipeline window's one answer: every stage, the current one, how long | pipeline-bundle, task-pipeline | server |

**A row in this lane must declare** the module and `public/pipeline-flow.js` when a stage mark,
notch or arc changes (the renderer reads `MARK`, `marksFor`, `fromWindowModel`), and
`public/pipeline-modal.js` when the shell's behaviour changes. A new bundle field claims
`lib/pipeline-bundle.js` + `test/` (six fixtures under `test/fixtures/bundles/`).

### 4.7 Lane `lib/worktrees.js` — worktree lifecycle and landing (13 modules, 4,840 lines)

| Module | L | Owns | Imports | Imported by |
|---|---|---|---|---|
| `lib/worktrees.js` | 771 | a worker asking the panel to remove the tree it can never remove itself | jobs, project, tree-names | server |
| `lib/worktree-remove.js` | 180 | taking a worktree off disk, in the one place that does it | project, jobs | server |
| `lib/worktree-naming.js` | 207 | the automatic half of naming a tree: the thread's title becomes its name | jobs, tree-names | server |
| `lib/rebase.js` | 287 | rebasing one worktree onto the newest commit of its parent, deterministically | scan | server |
| `lib/locks.js` | 383 | a reader's lock on a worktree or a branch — the one thing that is the reader's | tree-names | steward, server |
| `lib/steward.js` | 470 | the project steward: what every local branch and worktree is, and one plan | scan, parents, locks | server |
| `lib/child-worktree.js` | 97 | a child worktree cut from a row's branch — the missing half of the roll-up | scan, parents | server |
| `lib/push-guard.js` | 573 | the pre-push guard a worktree installs: the half "local only" a shell cannot ignore | — | server |
| `lib/remote-writes.js` | 460 | who is allowed to put a branch on a remote, and the permission box | — | features/spawn, gateway-permissions, server |
| `lib/todos.js` | 724 | the TODO list of a worktree, one list per worktree | — | assistant/actions, completion, jobs, refresh-row, server |
| `lib/refresh-row.js` | 225 | what ONE row's own re-read found, and the agent it can start from it | todos | server |
| `lib/features/spawn.js` | 294 | from "an agent should run here" to a job on the board — one path, three call sites | scan, spawn-target, hermes-runtime, remote-writes | server |
| `lib/spawn-target.js` | 169 | resolving a SPAWN line's path after the panel renamed the tree | project, own-tree | features/spawn |

**A row in this lane must declare** the module and `server.js`; a landing change also claims
`lib/jobs.js` (the job it starts) and `docs/pushing-to-a-remote.md` or `docs/child-worktrees-and-rollups.md`
when the rule text moves. The TODO list is the exception that proves the rule: it is read and written
by the assistant, by jobs and by the row's own refresh, so a change to `lib/todos.js` is claimed by
those three lanes at once.

### 4.8 The three substrate lanes — one module each

Each of these is its own lane, named by itself, because nothing else names it and everything uses it.

| Module | L | Owns | Imports | Imported by |
|---|---|---|---|---|
| `lib/paths.js` | 616 | where the panel keeps things: `dataDir`, scratch, state, migration journal | — | assistant, attachments, gateway-permissions, jobs, matrix-bridge, restart, server |
| `lib/tree-names.js` | 275 | which trees have already been named, by whom and when | — | assistant/queue, deliverables, descriptions, jobs, locks, project, worktree-naming, worktrees, server |
| `lib/own-tree.js` | 176 | is this directory a TREE, or only a directory that still exists? | — | assistant, assistant/landed, hermes-worktrees, jobs, scan, spawn-target, server |

**A row in one of these must declare it and say so in the title**, because a claim on `lib/paths.js` or
`lib/tree-names.js` sits in front of seven to nine other lanes' rows. They are small files with a
wide blast radius; they are the clearest case for the assistant's own rule that a shared file makes an
order, not a warning.

### 4.9 The two files in `lib/` that are not modules

| File | L | What it is | Lane |
|---|---|---|---|
| `lib/panel-restart.cjs` | 64 | the detached helper a panel restart leaves behind: waits for the old port, starts the successor | `lib/restart.js` |
| `lib/jobs.test.js` | 449 | a unit test that lives beside its module; the suite also runs it from `test/` | `lib/jobs.js` — declare it with a jobs change that touches re-attach |

---

## 5. `server.js` — the composition root

5,833 lines, 54 internal imports, `createServer` at 2,378, 135 `if (route === …)` branches plus one
`route.startsWith("/api/approvals/")` prefix branch. Three bands, by measured anchor:

| Band | Lines | What lives there | Who it collides with |
|---|---|---|---|
| header: imports, config, the object graph | 1–2,378 | `VERSION` read at 135, `new Store()` at 428, `new Jobs(` at 546, `broadcast`, the boot-pass promise, the helper functions | every lane that adds a module or a setting |
| route chain, inside the request callback | 2,396–5,571 | 136 dispatch conditions, each a call into a `lib/` module then a broadcast | every route-touching lane |
| tail | 5,571–5,833 | post-chain helpers, static + SSE entry, shutdown | none, usually |

The review's churn split — 51 of 92 hunks above the dispatcher — is its measurement at `cc61bb9`,
not re-derived here; what this tree adds is the three anchors above.

**Lane:** `server.js`. A row that edits it must declare it, and the assistant's own queue will then
serialise that row behind whoever else is in `server.js`. The doc's two older reports both treat this
file as the guaranteed cross-workstream collision; the count that matters at 1.2.0 is 136 conditions,
not the 123 or 127 they quote (§10).

The route-by-route cut of this file — every block's span, the seam it closes over, the thirteen files
and the order they can be cut in — is [`split-server.md`](split-server.md).

---

## 6. `public/` — 17 classic scripts

No imports, no module system: `index.html` loads them in this order, and every file's top-level
declarations are page globals. The order is the load contract — a phase-1 file may declare, not
execute; `app.js` is the pivot; the two files after it (`update-check.js`, `assistant.js`) execute.

| # | File | L | Owns | Publishes | Reads at load |
|---|---|---|---|---|---|
| 1 | `public/core/dom-format.js` | 183 | pure value→string and value→value helpers | `WMApp.core.domFormat` | nothing (safest first) |
| 2 | `public/core/model-menu.js` | 412 | one model picker for the whole page | `ModelMenu` | nothing |
| 3 | `public/core/console-format.js` | 754 | one folded box per tool result, framed diffs | `WMApp.core.consoleFormat` | `wtType` at call time |
| 4 | `public/core/console-markdown.js` | 457 | the console's prose, drawn as markdown | `WMApp.core.consoleMarkdown` | nothing |
| 5 | `public/core/stream-merge.js` | 196 | the order of one stream: thought, said, called, got back | `wtStream` | nothing |
| 6 | `public/core/liveness.js` | 37 | "is the live path still delivering?", asked once | `wtLive` | nothing |
| 7 | `public/core/steerable.js` | 82 | "may this run take a steer?", asked by the card and the route | `wtSteerable` | nothing |
| 8 | `public/core/type-stream.js` | 537 | how fast a run's output reaches the reader's eyes | `wtType` | nothing |
| 9 | `public/board/attachments.js` | 152 | documents pasted or dropped into a prompt | `WMApp.board.attachments` | nothing |
| 10 | `public/board/paste-chips.js` | 795 | a big paste collapses into one inline chip at the caret | `WMApp.board.pasteChips` | nothing |
| 11 | `public/core/transport.js` | 119 | every HTTP call the page makes, and the panel token | `WMApp.core.transport` | nothing |
| 12 | `public/core/sse.js` | 253 | the panel's own EventSource and every server frame | `WMApp.core.sse` | app.js names, inside `connect()` |
| 13 | `public/pipeline-flow.js` | 540 | a pipeline drawn as a left-to-right sequence: data in, markup out | `PipelineFlow` | nothing |
| 14 | `public/pipeline-modal.js` | 450 | the dialog shell for the two places a pipeline is looked at | `PipelineModal` | `PipelineFlow` at call time |
| 15 | `public/app.js` | 22,695 | the board: every row, card, console, chart, handler and renderer | nothing by assignment — 1,140 top-level names, 874 of them `window` properties (see §6.1) | eleven of the other sixteen scripts' globals: `consoleFormat`, `wtLive`, `wtStream`, `wtType`, `ModelMenu`, `attachments`, `pasteChips`, `transport`, `sse`, `PipelineFlow`, `PipelineModal` |
| 16 | `public/core/update-check.js` | 317 | the build this tab runs vs the one the panel serves | `wtUpdateCheck` | the shell's version meta, at call time (phase 3) |
| 17 | `public/assistant.js` | 4,666 | the assistant's client half: the float, alerts, watchlist, scratchpad and settings — one IIFE, five window functions | `applyAssistant`, `__assistantRenderChat`, `__assistantToggle`, `__assistantShowThread`, `__openTaskPipelineWindow` | app.js renderers (phase 3) |

Plus `index.html` (922 lines, the shell) and `style.css` (4,133 lines, §7). `app.js` is the lane named
by file for every client module: 448 of the stylesheet's 917 classes appear only in its strings, and a
module extracted out of it still needs the section of `app.js` that calls it. The page reads the
`WMApp` namespace exactly once in `app.js` (`consoleFormat`); the other published globals are read by
bare name.

**A row in this lane must declare** `public/app.js` when it adds a renderer, a handler or a section
marker, `public/index.html` when it adds a file, and `public/style.css` when it adds a class. A script
moved between positions in the list is a load-contract change: declare `index.html` and say why.

### 6.1 `public/app.js` — the panel cut, and what it does to the lane

Measured at `1e1c595` (`1.4.2`): 22,695 lines and **1,140 top-level declarations** — 786 `function`,
88 `async function`, 196 `const`, 70 `let`. The map's earlier count of 1,052 counted only the
synchronous functions. The file writes **no `window.*` name at all**: 874 declarations become `window`
properties, 266 are global lexical bindings, and **65 names are read by the other sixteen scripts**
(`state` by nine of them, `showBanner` by three); three `window.__*` functions come back from
`assistant.js`.

[`split-public-app.md`](split-public-app.md) cuts it into ten files. The cut keeps every `<script>`
position, and it names the 44 names the page reads back, so no HTML changes:

| Proposed file | Units | Lines | Page-facing names it must keep |
|---|---:|---:|---:|
| `board/board.js` — shell: `state`, boot, render engine, folders/collapse, banner | 222 | 3,065 | 13 |
| `board/rows.js` — the worktree table, cells, detail, TODO | 98 | 1,856 | 6 |
| `board/cards.js` — turns, conversation, question box, approvals dock | 188 | 3,218 | 15 |
| `board/jobs.js` — the jobs board, spawn bar, prompt history | 47 | 740 | 3 |
| `board/console.js` — tool bursts, console writers, markdown, scroll | 166 | 2,263 | 6 |
| `board/charts.js` — ranking, top-N, anchor, columns | 131 | 1,277 | 1 |
| `board/deliverables.js` — the DELIVERABLES button and list | 20 | 411 | 0 |
| `board/settings.js` — every settings tab but Pipeline/Bundles | 210 | 2,558 | 0 |
| `board/pipeline.js` — the chip, the Pipeline and Bundles tabs | 43 | 602 | 0 |
| `board/human.js` — the HUMAN rotation | 15 | 315 | 0 |

Two consequences for this map's lane rule:

- **The lane does not move until the first cut lands.** Any client row still claims `public/app.js`,
  because the block it edits is still there. The cut's first extraction is `board/console.js`: it is
  the only pair in the file that alternates line-by-line with another panel (13 flips against
  `cards.js`), so nothing else can be cut in parallel while it stays. The `state` block is the *last*
  thing to move, not the first — its literal calls 19 loaders that live in three panels.
- **Once a panel's file exists, the row names that file.** Two rows in different panel files are in
  different lanes even though both call `state` and `showBanner`, because a lane is a claimed file, not
  a read name. The shared claims that remain are `index.html` (one `<script>` line per file) and
  `package.json` (the version gate).

---

## 7. `public/style.css` — the one stylesheet

4,133 lines, 917 class names, two `!important`, zero `@layer`. Ownership is measurable from which
script's strings carry each class name:

| Classes used by | Count | What it means |
|---|---|---|
| `app.js` only | 448 | board chrome — the lane that collides on any board CSS change |
| `assistant.js` only | 154 | all `as-`-prefixed, the assistant's own block |
| `index.html` only | 16 | shell-only |
| pipeline scripts only | 36 | the drawing and the dialog |
| `app.js` + `index.html` | 52 | shared chrome |
| `app.js` + `assistant.js` | 26 | two verticals in one sheet |
| all three / all four | 32 / 25 | the shared vocabulary |
| none of the four scripts | 101 | an upper bound on dead CSS, not a count (class-name composition defeats a literal scan) |

**Lane:** `public/style.css`. Declaring it is the honest choice for any change that adds a class,
because two rows that both add rules cannot both be right about the cascade: 48 selectors are declared
more than once (1,840 distinct selectors in the sheet) and it has no `@layer`, so order is
load-bearing. The `as-*` block (305 selectors at line start) is the only prefix that is already a
written contract.

---

## 8. `tools/` — 166 scripts

No registry: `tools/verify.mjs` (the runner) discovers harnesses **by filename** —
`verify-<subject>.mjs` beside it, or under `harness/<lane>/` — and reads each file's own
`// HARNESS: LIVE GATE` or `// HARNESS: FROZEN EVIDENCE` line to decide whether it is a gate or
evidence. `--list`, `--all`, `--only <text>` are the three questions it answers; each harness keeps
its own sandbox, port and exit code.

| Family | Count | Lines | What it is | Lane |
|---|---|---|---|---|
| `verify-*.mjs` | 129 | — | one claim per file, driven through a real panel or a shipped class | one lane per script, named by the file |
| `verify.mjs` | 1 | — | the runner: discovery, selection, timeouts, `--json` | `tools/verify.mjs` — shared by every harness that is added |
| `verify_cli_session_limit.py` | 1 | — | the Hermes CLI session-limit patch's proof | itself |
| `measure-*.mjs` | 16 | — | timing and cost probes (console lag, drift, writes, perf paths) | one per script |
| `pop-a/b/c.mjs` | 3 | — | the console-popping campaign's three slots | one per script |
| `browser.mjs` | 1 | 235 | one Playwright bootstrap for every browser harness | shared by all browser harnesses |
| `panel-testkit.mjs` | 1 | 375 | boots the real `server.js` against a throwaway config | shared by route harnesses |
| `dogfood-chat.mjs`, `e2e-aggressive-http.mjs` | 2 | — | end-to-end acceptance scripts | one per script |
| `perf-075-vs-078.mjs` | 1 | — | the one two-version comparison | itself |
| `changelog.mjs`, `release-history.mjs`, `version.mjs`, `merged-branches.mjs` | 4 | — | release tooling: render, history, bump, merged-branch list | each is its own lane; `version.mjs` also gates a push |
| `render-pipelines.mjs`, `seed-pipeline-bundle.mjs`, `where.mjs` | 3 | — | pipeline rendering and seeding; the one path lookup | one per script |
| `check-gateway-clarify.mjs`, `child-process-audit.mjs` | 2 | — | two CI-shaped audits (gateway contract, `windowsHide`) | one per script |
| `openrouter-prices.py`, `probe_run_stats.py` | 2 | — | the price-table fetch and a run-stats probe | one per script |
| `tools/vendor/mermaid.min.js` | 1 | 2,314 | vendored, not ours; used by the pipeline page | do not edit |

**A row in this lane must declare** the script file plus `package.json` if it becomes an npm script
(47 of the 53 entries in `scripts` invoke a `tools/` file). A new harness also declares `tools/verify.mjs` **only
if** it changes the runner; discovery is by name, so the runner needs no edit for a new file. A harness
that boots a panel claims `tools/browser.mjs` or `tools/panel-testkit.mjs` when it uses them.

Appendix A lists every one of the 166 with its line count and its own first line.

---

## 9. What a row must declare

The panel's rule is mechanical (§1). These are the declarations that keep it honest, in the order a
submitter needs them.

1. **The files you will edit, not the module you will touch.** `filesIntersect` is exact-or-parent:
   `lib/assistant` covers `lib/assistant/queue.js`, and `lib/` covers all 88 modules. A directory
   claim is legal and is the widest claim you can make — do not claim `lib/` or `public/` unless the
   change really is repo-wide, because it puts your row in every lane at once.
2. **Both files of a two-lane change.** A route that returns a new row field is `lib/scan.js` (the
   shape), `lib/store.js` or `lib/jobs.js` (the judgement), `server.js` (the payload) and
   `public/app.js` (the renderer). Declare all four; a row that names only `scan.js` lets a `server.js`
   row start on top of it.
3. **The shared file, even when the diff in it is small.** `package.json` is the landing lock and is
   excluded from no landing; `public/style.css` is one sheet for three surfaces; `public/app.js` is
   the only place a renderer can live.
4. **The test file, when the suite is the proof.** 25 test files reference `lib/jobs.js` and 11
   import `lib/assistant/queue.js`. A row that leaves its test out will collide with the row that
   changes the test.
5. **Nothing is inferred for you.** A row with an empty `files[]` has no lane and will never be
   ordered behind anyone; the assistant's digest says so in as many words (the `SUBMIT` handler).

Three worked examples, each against a real collision:

| The work | Files to declare | Why each |
|---|---|---|
| add a liveness chip to a row | `lib/activity.js`, `lib/scheduler.js`, `server.js`, `public/app.js`, `public/style.css`, `test/` | signal, cadence, snapshot field, chip, class, suite — six files, four lanes |
| add a stage mark to the pipeline drawing | `public/pipeline-flow.js`, `public/style.css`, `lib/pipeline-window.js`, `test/` | renderer, class, the window's position model, the mark test |
| change the queue's lane rule | `lib/assistant/queue.js`, `lib/assistant.js`, `server.js`, `public/assistant.js`, `test/` | store, class call sites, the route, the queue tab, the queue tests |

The counter-example matters too: `lib/paths.js` is 616 lines and is imported by seven modules. A row
that claims it is not being wide — it is claiming the file every state path is derived from, and the
queue will make every other row wait on it. That is the correct behaviour, and it is the reason the
lane column exists.

---

## 10. Where the two reports disagree with this tree

Both older documents are honest about their snapshots — `../architecture.md` at `e4cb244` `0.99.0`,
`architecture-modules.html` at `cc61bb9`/`0.102.0`. Their numbers are stale, not wrong for the tree
they describe. This table is the reconciliation. The measured column is `db8dc06` (`1.4.0`), the tip
this page lands on; the server half is byte-identical at `1b8b795`, where the map was first measured:

| Claim, and where it is made | Its snapshot | Measured for this landing | Direction |
|---|---|---|---|
| `server.js` 5,491 lines, 126 route branches (`architecture.md` §1) | 0.99.0 | **5,833 lines, 135 `if (route === …)` + 1 prefix = 136** | +342 lines, +10 conditions |
| `lib/` 85 modules, 33,484 lines (`architecture.md` §1) | 0.99.0 | **88 modules, 36,450 lines** (89 files, 36,899 with `jobs.test.js`) | +3 modules, +2,966 lines |
| client 30,325 lines in 15 classic scripts (`architecture.md` §1) | 0.99.0 | **32,645 lines in 17 classic scripts** | +2,320 lines, +2 scripts (`pipeline-flow.js`, `pipeline-modal.js`) |
| `public/style.css` 3,770 lines (`architecture.md` §1) | 0.99.0 | **4,133 lines, 917 classes** | +363 lines |
| `test/` 153 files, 1,239 tests (`architecture.md` §1) | 0.99.0 | **168 files** (tests not re-run here, §12) | +15 files |
| `tools/` 156 `.mjs`, 122 `verify-*` (`architecture.md` §1) | 0.99.0 | **166 scripts, 131 `verify*`** | +10 scripts, +9 harnesses |
| `public/app.js` 21,367 @cc61bb9, 22,055 @0.102.0 (`architecture-modules.html` §2, §10) | cc61bb9 / 0.102.0 | **22,695 lines, 1,140 top-level names (874 `window`), 148 markers** | +640 since 0.102.0 |
| `public/assistant.js` 4,177 / 4,268 (`architecture-modules.html` §2, §10) | cc61bb9 / 0.102.0 | **4,666 lines, five window functions** | +398 since 0.102.0 |
| `lib/assistant.js` 5,192 lines, 147 methods (`architecture-modules.html` §5.3) | cc61bb9 | **6,596 lines** | +1,404 |
| `lib/jobs.js` 3,829 lines (`architecture-modules.html` §2, §5.4) | cc61bb9 | **4,289 lines** | +460 |
| `server.js` 5,343 / 5,652, 123 / 127 branches (`architecture-modules.html` §2, §10) | cc61bb9 / 0.102.0 | **5,833, 136 conditions** | +181 since 0.102.0, +9 conditions |
| server graph 187 edges over 85 modules (`architecture-modules.html` §3, §10) | cc61bb9 | **198 edges over 88 modules** (89 nodes with `server.js`), 0 SCCs | +11 edges, +3 modules |
| `lib/` 85 modules / 34,030 lines (`architecture-modules.html` §10) | 0.102.0 | **88 / 36,450** | +3 modules, +2,420 lines |
| `test/` 154 files, 1,252 tests (`architecture-modules.html` §10) | 0.102.0 | **168 files** | +14 files |
| `tools/verify-*.mjs` 123 (`architecture-modules.html` §10) | 0.102.0 | **131** | +8 |
| `public/style.css` 3,781, 1,615 blocks, 835 classes (`architecture-modules.html` §2, §10) | 0.102.0 | **4,133 lines, 917 classes** | +352 lines, +82 classes |

Two of these deserve a sentence rather than a row:

- **The route count moved unevenly.** `architecture.md` says 126 at 0.99.0, the review says 123 at
  `cc61bb9` and 127 at `0.87.1`, and the gate at `1b8b795` is 136. None of those is a typo; each is a
  different tree. The count to use for this tree is 135 `===` branches plus the one prefix branch.
- **The review's own anchor rule is the reason this page uses paths and line counts.** Its Appendix A
  re-located 26 anchors at 0.102.0 and all resolved; five had moved, by up to 280 lines, across two
  landings. The same drift is why no line number in this page is offered as a location: a `// ----`
  marker, a function name and a file path survive; `app.js:9,722` does not.

---

## 11. Where to add a new thing

| If you are adding… | The files, in dependency order | The lane that orders it |
|---|---|---|
| an HTTP endpoint | the module the route calls → `server.js` → `README.md` Endpoints table → `test/` | `server.js` |
| a field on the row | `lib/scan.js` (shape) → `lib/store.js` (judgement) → `server.js` (payload) → `public/app.js` (render) | `lib/scan.js` and `public/app.js` — two lanes, no single file orders them |
| a liveness signal | `lib/activity.js` → `lib/scheduler.js` (cadence) → `server.js` → `public/app.js` + `public/style.css` | `lib/scan.js` |
| a control verb on a run | `lib/jobs.js` → `server.js` → `lib/jobs/console-lines.js` if it prints → `public/app.js` | `lib/jobs.js` |
| an assistant action | `lib/assistant/actions.js` (grammar) → `lib/assistant/config.js` (the rule table) → `lib/assistant.js` | `lib/assistant.js` |
| a task-pipeline field | `lib/pipeline-bundle.js` (contract) → `lib/task-pipeline.js` (read) → `lib/pipeline-window.js` → `public/pipeline-flow.js` | `lib/pipelines.js` |
| a worktree-landing rule | `lib/worktrees.js` or `lib/push-guard.js` → `server.js` → `docs/pushing-to-a-remote.md` | `lib/worktrees.js` |
| a new client file | the panel file under `public/board/` ([`split-public-app.md`](split-public-app.md) §4) → `public/index.html` (script tag in phase 1 or 3, at its phase boundary) → `public/app.js` only while that block still lives there → `public/style.css` for its classes | `public/app.js` until the panel's file exists; that file afterwards |
| a new harness | `tools/verify-<name>.mjs` with a `// HARNESS:` header; `package.json` only if it becomes an npm script | `tools/verify.mjs` is not edited for a new file |
| a new state file | `lib/paths.js` (the path helper) → the owning module → `server.js` only if it is boot-loaded | `lib/paths.js` |

---

## 12. What this page did not measure

- **The test count.** 168 test files and 37,090 lines are counted; the number of tests and their
  colour are not re-run here. `npm test` is the gate.
- **The harnesses.** 166 scripts are counted and their headers quoted; none was run for this page.
- **Runtime.** No profile, frame timing or memory reading. That is `../arch-review-efficiency.md`'s
  subject.
- **`harness/`** (the Playwright lanes, e.g. `harness/playwright-lane-c/`) and `test/fixtures/` are
  outside this map's four areas and are not mapped.
- **Which lane a given row SHOULD be in.** This page says which file a module's work must claim. The
  panel decides the order, and the assistant decides what to start; neither judgement is measured
  here.

---

## 13. Ownership clusters

A lane is named by one claimed file; a **cluster** is the wider unit — the files one worker owns
together, measured from the same import edges this map counts. [`split-lib.md`](split-lib.md) carries
the full table (module, cluster, importers, who must touch it), the move order and the collisions, all
measured at `1e1c595` (`1.4.2`). The summary, over the same 88 modules:

| Cluster | Modules | Lines | Owns | Hot file (commits touching `lib/`) |
|---|---:|---:|---|---|
| **SUBSTRATE** | 4 | 1,086 | paths, tree names, is-this-a-tree, `HttpError` — the floor | `paths.js` (9 of 259) |
| **SERVER** | 10 | 2,268 | HTTP framing, static, the store, boot, restart | `restart.js` (11) |
| **WATCH** | 11 | 3,933 | git reads, the worker pool, the ticker, projects, hosts, liveness | `scheduler.js` (34) |
| **RUNS** | 18 | 7,697 | the run state machine, console, usage, approvals, admission | `jobs.js` (89) |
| **ASSISTANT** | 18 | 11,466 | the assistant vertical: turn, queue, charter, messages, settings | `assistant.js` (78) |
| **INSTALL** | 6 | 2,203 | the Hermes contract: config, models, permissions, skills | `hermes-config.js` (7) |
| **PIPELINES** | 6 | 2,604 | catalogue, bundle contract, task position, window | `pipelines.js` (5) |
| **LANDING** | 15 | 5,192 | worktree lifecycle and landing: cut, rebase, lock, remove, verify, push | `features/spawn.js` (8) |
| **total** | **88** | **36,449** | | 259 commits touch `lib/` |

Four things in that page are not in this one:

- **The collision answer.** ASSISTANT and RUNS cannot be started at once: 17 commits touch both, and
  `assistant.js` + `jobs.js` is the tree's hottest module pair at 16. PIPELINES is the safe neighbour —
  zero co-change commits with SERVER, WATCH, INSTALL or LANDING.
- **The move order.** PIPELINES → SERVER → INSTALL → WATCH → LANDING → RUNS → ASSISTANT, with SUBSTRATE
  frozen. `server.js` is edited at every step because all 54 of its specifiers live in one block.
- **The pure/plumbing splits.** `jobs.js` can shed ≈370 lines of 429 policy and briefs; `scan.js` its
  row signature; `assistant/queue.js` its admission decision; `todos.js` its formatters. Three hot modules
  are already pure (`assistant/read.js`, `assistant/config.js`, `tool-text.js`).
- **The three route adapters that live in domain modules** — `createQueueRoutes` in `queue.js`,
  `createPipelineWindowRoutes` in `pipeline-window.js`, `createPipelineCatalogueRoutes` in
  `task-pipeline-assign.js` — which is why "SERVER" is framing and boot, not "the routes".

---

## Appendix A — every tools script

One row per script, in family order. **L** is lines at `1b8b795`; the purpose is the file's own first
header line, clipped. 166 scripts in five tables — 129 `verify-*`, 16 `measure-*`, the runner and two
kits, 18 others, and one vendored file.

### A.1 The runner and the shared kits (3)

| Script | L | Purpose |
|---|---|---|
| `verify.mjs` | 258 | one runner for this repo's verification harnesses: discovery by name, --list, --all, --only |
| `browser.mjs` | 235 | one Playwright bootstrap for every browser harness in this repo |
| `panel-testkit.mjs` | 375 | boots the real server.js against a throwaway config, so a test can assert what a route does |


### A.2 `verify-*.mjs` — one claim per file (129)

| Script | L | Purpose |
|---|---|---|
| `verify-429-hold.mjs` | 818 | A 429 is backpressure, not failure — proved by driving the SHIPPED `Jobs` (and a panel of this checkout plus a real browser over… |
| `verify-action-harvest.mjs` | 396 | a finished assistant turn's actions are read from the WHOLE reply, and each one is carried out on its own |
| `verify-agent-card-chrome.mjs` | 284 | A card names the PROJECT its tree belongs to — not the bare word "worktree" — and the run id rides the cwd line beside the path… |
| `verify-aggressive.mjs` | 171 | Exercises the header's aggressive-mode toggle against the real Assistant class and a real assistant.json: what the profile writes,… |
| `verify-ahead-behind.mjs` | 344 | The Ahead / Behind column, driven end to end: a branch counted against its OWN copy on the remote, in every state |
| `verify-approval-expiry.mjs` | 269 | An approval nobody answers must not stay on the board as a button |
| `verify-approvals-dock.mjs` | 450 | The approvals dock: a head that counts PENDING requests, records that can be cleared and age out, a click that takes the reader to… |
| `verify-artifact-scope.mjs` | 66 | A deliverable belongs to the turn that wrote it |
| `verify-assistant-2-chat.mjs` | 453 | ASSISTANT #2'S OWN CHAT, DRIVEN IN A REAL BROWSER |
| `verify-assistant-dock-overlap.mjs` | 355 | The assistant chat's last message, proved readable above the composer — in BOTH frames, at two widths |
| `verify-assistant-dock.mjs` | 308 | The assistant's docked rail, proved by driving a panel of its own — and a real browser over it |
| `verify-assistant-hotkey.mjs` | 400 | The assistant's bare-A hotkey, proved by driving a panel of its own — and a real browser over it |
| `verify-assistant-queue-e2e.mjs` | 772 | The per-assistant queue, end to end: several tasks at once, driven queued → running → done against the REAL job store, two of them… |
| `verify-assistant-queue-ui.mjs` | 550 | The Queue sub-tab's redesigned row, proved on the REAL page: the fold, the hover text, the row order, and that a press still writes |
| `verify-assistant-queue.mjs` | 501 | The Queue sub-tab, proved by a real browser over a panel of its own |
| `verify-assistant-subtabs.mjs` | 820 | The assistant float's two tab rows, proved by driving a panel of its own — and a real browser over it |
| `verify-assistant.mjs` | 894 | Exercises the assistant's sentry and action gating without a gateway, a browser or a git repo |
| `verify-attachment-spawn.mjs` | 258 | An attached file on a reader's message must reach the worker the assistant SPAWNs |
| `verify-banner-float.mjs` | 258 | The red banner FLOATS under the sticky topbar: it is pinned there, it moves nothing on the board, and it never covers the docked… |
| `verify-banner-timeout.mjs` | 306 | The red banner's clock: a failure hides ITSELF after the seconds in Settings → Board (5 s by default, 0 = never), the clock pauses… |
| `verify-base-ref.mjs` | 230 | The gate for "every row on this project reads NO BASE REF": a configured remote that the checkout does not have must degrade to the… |
| `verify-board-fit.mjs` | 255 | The worktree chart FITS the board when the assistant rail opens — proved by driving a panel of its own, in a real browser, with the… |
| `verify-branch-links-local-only.mjs` | 740 | The branch column as a link, and "local only" as a default that actually holds |
| `verify-branch-unknown-chip.mjs` | 216 | The branch cell when the panel could NOT get an answer about the remote: one word — `unverified` — and the project's own fetch note… |
| `verify-bundles-tab.mjs` | 341 | Settings > Bundles in a real browser: the imported bundle's pipelines listed, the loader's own refusal code when the bundle is… |
| `verify-cancel-queued-reply.mjs` | 787 | The x on a queued reply — proved by driving a panel of this checkout and a real browser over it, with real clicks, real keys and a… |
| `verify-card-header-layout.mjs` | 329 | The agent card's header reads the same folded and open: the six controls (pin, think, stream, rename, max, clear) fill the head's… |
| `verify-chart-columns.mjs` | 443 | The worktree chart's column switches, proved by driving a panel of its own — and a real browser over it |
| `verify-chart-top-count.mjs` | 518 | The chart's top-N collapse, proved by driving a panel of its own — and a real browser over it |
| `verify-charter.mjs` | 384 | The assistant's charter — the continuity file, and the tab that reads it |
| `verify-child-button.mjs` | 102 | The row's child-cut control, proved from the shipped page — no browser, no panel |
| `verify-clarify.mjs` | 198 | A gateway build that has the `clarify` toolset but not the Runs API half of the contract offers the tool to the model and then… |
| `verify-collapse-cascade.mjs` | 320 | The collapse cascade, proved by driving a panel of its own — and a real browser over it |
| `verify-collapsed-row.mjs` | 282 | A minimized card's identity line: the cwd path (and its run/row chips) read from the left margin, and the session's name is the… |
| `verify-complete-chip.mjs` | 762 | The green COMPLETE chip on a finished card, and what its press does — proved against two panels of its own (the change, and the… |
| `verify-completion.mjs` | 518 | The completion notice: what a worker this panel spawned actually produced |
| `verify-composer-top.mjs` | 364 | The composer block at the TOP of the card when every turn is folded, and back at the foot the moment one is open |
| `verify-console-boxes.mjs` | 809 | The console's boxes, proved in a real browser against THIS checkout's public/**: the frame's body is the changed file's own lines… |
| `verify-console-column-fit.mjs` | 542 | Does measuring the worktree table's columns move the consoles inside it? |
| `verify-console-diff.mjs` | 347 | The console's file renderer: a unified diff becomes framed windows, any other file dump a folded code box |
| `verify-console-flicker.mjs` | 1,068 | The console flicker, caught in a browser against a REAL run's output |
| `verify-console-fold-hold.mjs` | 499 | A folded tool output the reader opens does not carry the console with it: the box unfolds under the header that was pressed, and… |
| `verify-console-height.mjs` | 606 | A console height the reader DRAGGED must survive every rebuild that replaces or builds the box - not come back on its cap, and not… |
| `verify-console-independence.mjs` | 806 | Is a live console independent of everything else on the board? |
| `verify-console-jitter.mjs` | 1,082 | Does a card still jitter while a turn streams? |
| `verify-console-lost-text.mjs` | 236 | A paragraph the reader was watching when they switched away is drawn WHOLE when they come back |
| `verify-console-render.mjs` | 372 | The console's prose, proved in a real browser against THIS checkout's public/**: the agent's markdown arrives as shapes (a), a… |
| `verify-console-resize.mjs` | 252 | The console's resize handle must stay under the pointer the reader grabbed it with, from the first pixel |
| `verify-console-zoom.mjs` | 483 | Does ONE font size drive the console's normal output, its reasoning and a tool's output — and does Ctrl+wheel move all three… |
| `verify-copy-buttons.mjs` | 837 | Hover copy buttons on console output and thinking blocks, proved in a real browser against THIS checkout's public/**: the button… |
| `verify-deliverables-ui.mjs` | 401 | The DELIVERABLES button and list, proved by driving a real panel — the REAL backend, and no interception |
| `verify-description.mjs` | 739 | What each branch was STARTED to do, proved by driving a panel of its own — and a real browser over it |
| `verify-digest-cost.mjs` | 147 | What the board digest costs per turn, measured against the four turn kinds that decide it |
| `verify-fold-note-parity.mjs` | 596 | One result, one header: every render path fetches the header's own full row into the original output box |
| `verify-hermes-home.mjs` | 171 | One Hermes home, for every reader |
| `verify-human-button.mjs` | 1,042 | The HUMAN button: every open permission and clarify question on the board, in one rotation |
| `verify-lane-a-burst.mjs` | 854 | Lane A: a long turn's burst survives the console window, and the reader's fold survives the turn growing |
| `verify-leftover-holder.mjs` | 430 | A leftover alert must not fire on a tree a live run holds — proved end to end, in a sandbox of its own |
| `verify-matrix-bridge.mjs` | 429 | verify-matrix-bridge.mjs — the Gateway tab's Matrix bridge, driven end to end against a FAKE bridge |
| `verify-merge-chip.mjs` | 229 | The UNMERGED chip is the merge control, and "only when the tree is clean" is the rule the whole feature rests on: an agent that… |
| `verify-merge-state.mjs` | 652 | MERGE STATE, unfolded: every commit off remote main on its own line, and the file lists behind their own folds |
| `verify-messages-tab.mjs` | 698 | The Messages tab: the message board between the assistant and the agents |
| `verify-model-prices.mjs` | 568 | The model menu's price and rating columns, and the one control that regenerates them |
| `verify-named-tree.mjs` | 752 | The naming ledger, proved by driving a panel of its own — and not by reading the code |
| `verify-new-project.mjs` | 295 | The folder header's "+" row, second action: NEW LOCAL PROJECT |
| `verify-output-boxes.mjs` | 532 | Every tool output is one folded box, and the lines of a skill type out like prose do — proved in a real browser against THIS… |
| `verify-paste-chips.mjs` | 960 | Paste-collapse chips: a paste of 300+ characters (or 5+ lines) into any box the reader writes a prompt in collapses, in place at… |
| `verify-pipeline-chip.mjs` | 365 | The agent card's head draws a `pipeline: <id>` chip — the id and its stage — and draws NOTHING when the tree has no pipeline record |
| `verify-pipeline-flow-visible.mjs` | 745 | Playwright round 5A — BOTH routes into the pipeline flow chart, judged on whether everything is VISIBLE and whether it looks CLEAN |
| `verify-pipeline-flow.mjs` | 376 | The PIPELINE FLOW and its modal, in a real browser — the gate for `public/pipeline-flow.js` and `public/pipeline-modal.js` and for… |
| `verify-pipelines-tab.mjs` | 176 | Settings > Pipeline in a real browser: the catalogue in a dropdown, one definition opened for editing, a keystroke that survives a… |
| `verify-pipelines-viz.mjs` | 283 | Prove the catalogue's drawn page, tools/render-pipelines.mjs, against the thing it claims to be: ONE self-contained HTML file whose… |
| `verify-pr-attribution.mjs` | 420 | Which PR a row shows, when the branch it shows is not the branch the PR was opened from |
| `verify-preamble-cost.mjs` | 114 | What the assistant's preamble costs per turn, measured on a sandbox panel of THIS tree |
| `verify-provider-profiles.mjs` | 143 | verify-provider-profiles.mjs — the Gateway tab's saved (URL, key) pairs: where the secret lives, what the routes answer, and… |
| `verify-queue-cards.mjs` | 436 | The Queue sub-tab as a column of CARDS, and the "unowned" label gone |
| `verify-queue-drag-ui.mjs` | 484 | The queue pane's drag, the way a PERSON does it: a real mouse press, travel and release on a card, in the rail and in the float,… |
| `verify-queue-drag.mjs` | 446 | The queue pane's drag: a card moved to a new place PERSISTS, a held card snaps back with one line, and a plain click still opens… |
| `verify-queue-holds.mjs` | 362 | Does a park carry a release condition the PANEL can test — and does a lane order two rows that share a file? |
| `verify-queue-question-chip.mjs` | 657 | A row whose agent is parked on a QUESTION says so — and the press lands where the question can be read and answered |
| `verify-queued-reply-edit.mjs` | 782 | Click a held reply to edit it: the queued entry's own text turns into a textarea in place, and what the panel later SENDS is the… |
| `verify-ranking-scopes.mjs` | 466 | The sliding-average liveness ranking, proved for the TWO scopes the row script does not cover: the projects inside a folder and the… |
| `verify-reasoning-first.mjs` | 403 | Does a tool's output wait for the thought in front of it? |
| `verify-reattach-chip.mjs` | 626 | The NOT-RUNNABLE chip on an interrupted card whose run may still exist, proved against a panel of its own and a real browser |
| `verify-released-row.mjs` | 173 | A released worktree's leftover folder must not report the primary checkout's branch and dirt — proved on real git |
| `verify-reply-queue-keys.mjs` | 657 | The reply box's two gestures — Enter holds the reply, Ctrl/Cmd+Enter steers the live turn — proved by driving a panel of its own,… |
| `verify-restart-idempotence.mjs` | 658 | The restart storm, gated on its own port and state dir |
| `verify-restart-line-harvest.mjs` | 441 | a RESTART line written under a paragraph that quotes it must still be READ, and the panel must really replace itself |
| `verify-restart-once.mjs` | 270 | The one-bounce rule, gated on a seeded restart ledger |
| `verify-restart.mjs` | 533 | The restart action, proved without touching the live gateway or the live panel |
| `verify-restored-live-run.mjs` | 423 | The sticky "cannot steer it" card, proved against a panel of its own |
| `verify-restored-turns.mjs` | 255 | What a restarted panel says about the turn it lost — and what it does with the run that outlived it |
| `verify-row-rank-smoothing.mjs` | 569 | The row ranking, averaged over a sliding window of liveness events instead of keyed on the newest one, proved by driving a panel of… |
| `verify-row-reconcile.mjs` | 103 | The row's ⟳, proved from the shipped page rather than a copy of it — the same technique as tools/verify-merge-chip.mjs, and for the… |
| `verify-rw-keep-bar.mjs` | 352 | The auto-allowed write review card: Keep is a full-width bar ABOVE Unwind, not a small chip beside it |
| `verify-settings-data.mjs` | 130 | Settings > Data in a real browser: the two folders, their sizes, the migration sentence, and the two-press Clean scratch |
| `verify-settings-permissions.mjs` | 605 | Settings > Permissions: the permissions actually in force, read-only, with the file:line (or endpoint) each one came from — and a… |
| `verify-settings-skills.mjs` | 662 | Settings > Skills: every place an agent's skills are absorbed from, organised by source and then by category, and every skill those… |
| `verify-settings-tabs.mjs` | 431 | Settings is a TAB STRIP: one tab per group, one panel on screen, the reader's tab remembered — and a search that stays global… |
| `verify-settings-window.mjs` | 326 | The ⚙ Settings window moves and sizes: a drag on its head carries it, the corner grip resizes it, the rect is remembered in this… |
| `verify-spawn-links-queue.mjs` | 215 | A SPAWN that names a queue row writes that row at the cut — and one that names a row it cannot have cuts nothing |
| `verify-spawn-refusal.mjs` | 248 | No spawn starts a turn in a repository that cannot host one — through the card OR through the assistant |
| `verify-spawn-target.mjs` | 165 | A SPAWN IN line used to be taken on trust: the path had to BE a directory, and the spawn was refused with "<path> does not exist or… |
| `verify-stats.mjs` | 49 | Prove the run.usage path through the panel's own registry class (no server, no browser): a live snapshot arrives at a tool… |
| `verify-steer-turn.mjs` | 460 | Steer turn, end to end: a steer the gateway accepts actually steers, and a steer it refuses is HELD as a queued reply and said so —… |
| `verify-steerable.mjs` | 491 | Does the card offer a Steer control the gateway would refuse? |
| `verify-steward.mjs` | 250 | The steward, end to end, on a REAL panel: a throwaway config, a real git repository with real worktrees, and the routes the page… |
| `verify-stream-default.mjs` | 433 | Does Settings → Agent cards → **Combined output** decide a NEW card's console — and does a card's own 🌊 still win? |
| `verify-stream-mode.mjs` | 918 | Does the 🌊 toggle repaint a card that is already on the board? |
| `verify-stream-separation.mjs` | 504 | Is every piece of the 🌊 stream set apart from the piece above it — and does the console keep its pin while the blank lines are… |
| `verify-subagent-turns.mjs` | 87 | Which turn owns which subagent chip |
| `verify-task-pipeline-window.mjs` | 517 | The task pipeline WINDOW, in a real browser: a Queue row's press opens a dialog that lists every stage of the task's pipeline in… |
| `verify-text-styles.mjs` | 425 | Do the three text styles reach the console, and does the empty line stand where it should? |
| `verify-thinking-flicker.mjs` | 542 | The thinking block's flicker, caught in a browser against the shipped page |
| `verify-tiered-collapse.mjs` | 312 | Ctrl+[ folds ONE tier per press, proved by five real keydowns against a real page |
| `verify-todo-section.mjs` | 824 | The TODO list on a worktree: one list per tree, written by the assistant, kept current by every agent in it, read by the row |
| `verify-token-costs.mjs` | 782 | Tokens in and out on a card's readout, and what the session has cost |
| `verify-tool-call-rows.mjs` | 421 | Does ONE tool call read as ONE line, unexpanded, when the tally is off — and does the Settings switch put the tallied group back? |
| `verify-tool-glyphs.mjs` | 84 | Every tool call in an agent's console leads with the tool's glyph, the way the Hermes CLI prints it |
| `verify-tool-output.mjs` | 101 | A tool result reaches the console as TEXT, never as the JSON envelope it travelled in |
| `verify-tool-usage-group.mjs` | 558 | Does the 🌊 stream draw a run of tool calls the way the reader asked for it — ONE row per call, bracketed by a rule above and a rule… |
| `verify-turn-pager.mjs` | 265 | The turn pager's count holds one line in the docked rail, and the pager keeps its own width there |
| `verify-two-assistants-e2e.mjs` | 577 | TWO ASSISTANTS, AT THE SAME TIME, END TO END |
| `verify-verdicts.mjs` | 88 | Independent check of the panel's merge verdicts: recomputes the expected verdict straight from git (branch reflog, rev-list, cherry… |
| `verify-version-bump.mjs` | 214 | Prove the version-bump pipeline end to end, in a throwaway repo of its own: the advice (suggest), the gate (check), the write… |
| `verify-version-tags.mjs` | 176 | a version bump with no tag fails this gate |
| `verify-wake-ladder.mjs` | 211 | THE WAKE LADDER — every assistant is on it, and a wake addressed to a failed one moves to a healthy one |
| `verify-whole-tool-stream.mjs` | 570 | The whole tool result: opening its original box fetches the full row in place, exactly once |
| `verify-worktree-row-actions.mjs` | 319 | The worktree row's name-cell controls, proved on the real page: play, name (✎), lock — in that order — and no ✦ |

### A.3 `measure-*.mjs` — probes, not gates (16)

| Script | L | Purpose |
|---|---|---|
| `measure-console-cross-talk.mjs` | 1,213 | Does one card's console move because ANOTHER card's agent wrote? |
| `measure-console-drift.mjs` | 1,155 | Does a console keep moving after the reader stops scrolling? |
| `measure-console-expand-frames.mjs` | 577 | Every frame a console paints, across the rebuilds a reader actually causes: a card a rebuild BUILDS (a second agent arrives), a… |
| `measure-console-grab.mjs` | 580 | What does the console's bottom-right grab do to the box, in pixels? |
| `measure-console-height-tick.mjs` | 549 | Two console-height cases the shipped gate does not drive: a height BELOW the cap, and the REAL 30 s resync net |
| `measure-console-lag.mjs` | 1,037 | How far behind its newest line does a live console sit, for how long, and what put it there? |
| `measure-console-live.mjs` | 651 | What a console does when the card is repainted and ONE more line arrives — in the condensed renderer and in the one-stream (🌊) one |
| `measure-console-pin.mjs` | 1,599 | Does a combined console that is PINNED stay on its tail while FOUR agents write, and does one the reader parked 80 px up hold its… |
| `measure-console-routing.mjs` | 757 | Where a combined (🌊) console's lines land when four runs append at once |
| `measure-console-scroll-hop.mjs` | 588 | Which single shared thing resets every open console's scrollTop, and on what beat? |
| `measure-console-soak.mjs` | 861 | Does a long session leak, or slow down? |
| `measure-console-writes.mjs` | 1,349 | What WRITES a console's scrollTop, and which of those writes the layout had already moved past |
| `measure-perf-paths.mjs` | 1,194 | The four paths a reader actually waits on, timed one at a time, on a seeded store of its own |
| `measure-thinking-live.mjs` | 449 | What a live 🧠 block does when ONE store read comes back empty |
| `measure-tool-output-cap.mjs` | 174 | How much of a tool result actually reaches a consumer of this box's agent transports? |
| `measure-whole-tool-stream.mjs` | 164 | What a REAL tool result costs the panel's card — before and after the two caps are lifted |

### A.4 everything else (18 scripts)

| Script | L | Purpose |
|---|---|---|
| `changelog.mjs` | 246 | render CHANGELOG.md from the commits between consecutive version tags |
| `check-gateway-clarify.mjs` | 182 | Does the gateway this panel is pointed at carry the Runs API half of the `clarify` contract? |
| `child-process-audit.mjs` | 300 | No child_process call in the panel may start a child without `windowsHide: true` |
| `dogfood-chat.mjs` | 951 | DOGFOOD THE ASSISTANT CHAT PANE, on a panel of its own |
| `e2e-aggressive-http.mjs` | 275 | End-to-end acceptance for the aggressive assistant toggle, over real HTTP against a real server |
| `merged-branches.mjs` | 185 | branches.mjs Which local branches are safe to prune — decided from PULL REQUEST state, never from git ancestry |
| `openrouter-prices.py` | 424 | looks up OpenRouter model prices and the 0–10 rating, then writes the JSON the model picker reads |
| `perf-075-vs-078.mjs` | 741 | Is 0.78.1 actually slower than 0.75.0 on the SAME board? |
| `pop-a.mjs` | 819 | Slot A of the console-popping campaign: drive a REAL panel instance (its own port, config, data dir and scratch) through three live… |
| `pop-b.mjs` | 606 | Slot B of the console-popping campaign: does a live console's scrollbar jump, and does its tail hold? |
| `pop-c.mjs` | 700 | Slot C of the console-popping campaign: does a live agent's console pop while it writes, and does its tail hold? |
| `probe_run_stats.py` | 134 | offline proof of the gateway's run-usage projection — no gateway, no restart |
| `release-history.mjs` | 142 | the one derivation of "which commit first declared each version" |
| `render-pipelines.mjs` | 713 | the pipeline catalogue, DRAWN: one self-contained HTML page |
| `seed-pipeline-bundle.mjs` | 67 | Seed the panel's pipeline bundle from the studio's own export, so a fresh install has one true pipeline to show |
| `verify_cli_session_limit.py` | 58 | offline proof of the CLI's sessions.list_limit resolver (local patch) |
| `version.mjs` | 685 | advice, gate and the write, for the panel's one version number |
| `where.mjs` | 37 | Where does this panel keep its files? |

### A.5 the vendored file

| File | L | Purpose |
|---|---|---|
| `tools/vendor/mermaid.min.js` | 2,314 | vendored Mermaid, not ours; the pipeline pages draw with it. Do not edit. |

## Appendix B — re-measuring this page

Every number in §2–§8 comes from these commands, run at the commit named in the masthead. They are
read-only and work under git-bash with a native `C:/...` path.

```sh
# the refs this page is measured at: 1b8b795 first, db8dc06 for the numbers it quotes
REF=1b8b795
TIP=db8dc06
git cat-file -t $REF && git cat-file -t $TIP

# a module count and a per-file line count
git ls-tree -r --name-only $REF -- lib | wc -l                     # 89 files: 88 modules + jobs.test.js
git ls-tree -r --name-only $REF -- lib | while read f; do
  printf '%6d %s
' "$(git show $REF:$f | wc -l)" "$f"
done | sort -rn

# the route surface
grep -c 'if (route === "' server.js                               # 135
grep -c 'route.startsWith' server.js                              # 1
grep -n 'const server = createServer' server.js                   # 2378

# the client: script order, and the page's own size
grep -n '<script src' public/index.html
wc -l public/app.js public/assistant.js public/style.css public/index.html

# a class's owners: which script actually names it
for f in public/app.js public/assistant.js public/index.html public/pipeline-flow.js; do
  printf '%-28s %s
' "$f" "$(grep -c 'the-class-name' $f)"
done

# the harnesses: how many, and what the runner would see
git ls-tree -r --name-only $REF -- tools | wc -l
node tools/verify.mjs --list | head -5

# the import graph's two headline numbers (in-degree 1, and server-only)
grep -o 'from "\./[^"]*"' server.js | wc -l                       # 54
```

Two cautions, both learned from the reports in §10: `wc -l` on the working tree and on
`git show $REF:<path>` give the same number for these files, but the committed blob is the one to
quote; and `grep -c` counts lines, not occurrences, so a one-line `if` with two route comparisons
counts once.

