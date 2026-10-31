# Architecture — agent-worktree-gui

A map of how this panel is put together: the processes, the loops, the data that moves between
them, and the design elements that decide its shape. It is a description, not a plan and not a
review — where a boundary is thin it says so, but it does not propose the fix.

- Snapshot: `main` at **e965d65**, `package.json` `0.33.0`.
- Numbers below are read out of this tree (`wc -l`, `git ls-files`, greps). They move; the names
  and the responsibilities do not.
- Companions, for the other lenses: `docs/arch-review-organization.md` (where the code lives),
  `docs/arch-review-efficiency.md` (what the timers cost), `docs/arch-review-functional.md` (the
  board's state machine). `README.md` is the reader's manual; `docs/using-the-board.md` is the
  page, region by region.

**Contents**

1. [What the system is](#1-what-the-system-is)
2. [The shape at a glance](#2-the-shape-at-a-glance)
3. [Two halves, and the loops that feed them](#3-two-halves-and-the-loops-that-feed-them)
4. [The read path](#4-the-read-path-step-by-step)
5. [The write path](#5-the-write-path-step-by-step)
6. [The data model](#6-the-data-model)
7. [Architectural design elements](#7-architectural-design-elements) ← the part the rest of the file serves
8. [The client](#8-the-client)
9. [Configuration and discovery](#9-configuration-and-discovery)
10. [Where the seams are](#10-where-the-seams-are)
11. [Where to start reading](#11-where-to-start-reading)
12. [One-paragraph summary](#12-one-paragraph-summary)

---

## 1. What the system is

One Node process on the developer's machine, serving one page, watching many git worktrees.

The page is a board: one row per worktree across every project under the configured scan roots,
one card per Hermes agent conversation, and a strip of evidence — branch, verdict against main,
ahead/behind, dirty files, PR, liveness — attached to each row. The same process that draws the
board can also **start** agents: it cuts a worktree, posts a run to the Hermes gateway's Runs API,
and then renders that run's tool calls, thinking and output back into the card in real time.

That is the whole product, and it is why the two things the code is most careful about are
**freshness** (a row that is 40 seconds stale is a lie about a machine that is moving) and
**permission** (a process on this box can run `git`, spawn agents and push branches, so every
write is a decision that has to be made somewhere visible).

| | |
|---|---|
| Runtime | Node ≥ 22.5, ESM, **no dependencies** (`"dependencies": {}`), no bundler, no transpiler |
| Server | `server.js` — 4,304 lines, one composition root, 104 `if (route === …)` branches |
| Domain | `lib/` — 68 modules, 23,975 lines, each with a header saying what it owns |
| Client | `public/` — 23,295 lines of JS in 14 classic scripts, plus `style.css` (3,122) |
| Verification | `test/` — 70 files, 524 test declarations; `tools/` — 78 `.mjs` scripts, 64 of them `verify-*.mjs` |
| State | `dataDir` (`~/.wag` by default) — plain JSON files, versioned, written atomically |
| Gates | two git hooks (`.githooks/commit-msg`, `.githooks/pre-push`); **no CI** |

---

## 2. The shape at a glance

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER — one page, no build step                                                │
│   index.html → 14 classic scripts, fixed order:                                  │
│   core/dom-format · core/model-menu · core/console-format · core/stream-merge     │
│   core/liveness · core/type-stream · board/attachments · board/paste-chips        │
│   board/hot · core/transport · core/sse · app.js · core/update-check              │
│   assistant.js                                                                     │
│   reads:  GET /api/stream (SSE)      writes: POST /api/*  (x-panel-token off-box)  │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │  one snapshot, then row / job / assistant deltas
┌───────────────────────────────▼──────────────────────────────────────────────────┐
│ server.js — composition root                                                     │
│   wires: config → paths → Store, Pool, Scheduler, Jobs, Assistant, Registry      │
│   HTTP:  lib/http/transport.js (framing, auth, SSE)  lib/http/static.js (public/)│
│   routes: 104 branches → each one a call into a lib/ module, then broadcast      │
└──────┬──────────────────┬───────────────────┬───────────────────┬────────────────┘
       │                  │                   │                   │
       ▼                  ▼                   ▼                   ▼
   Store             Scheduler             Jobs              Assistant
   Map<key,row>      1 s ticker            Runs API client    sentry (5 s)
   emit → SSE        per-row due times     job cards + SSE    one real thread
       ▲                  │                   │                   │
       │                  ▼                   ▼                   ▼
       │            Pool (threads=5) ──► scan-worker.js ──► git (read-only)
       │            keyed · deduped · worker_threads
       │
       └── dataDir (~/.wag): jobs.json · todos.json · locks.json · tree-names.json ·
           parents.json · descriptions.json · releases.json · hosts.json · assistant.json …
```

Two arrows are deliberately one-way:

- **Nothing on the HTTP read path triggers a scan.** `GET /api/state` returns what the store
  already holds. Freshness is the scheduler's job, not the request's. (`POST /api/refresh` and
  `POST /api/refresh/row` exist precisely because asking for freshness is an explicit act.)
- **Nothing in `lib/` serves a request.** Modules return data or throw `HttpError`; only
  `server.js` writes a response.

---

## 3. Two halves, and the loops that feed them

### 3.1 The monitor half

`Scheduler` is the only thing that decides *when* to look. A single 1-second ticker runs three
kinds of work:

| Loop | Cadence | What it advances |
|---|---|---|
| **Liveness pass** | 5 s (`liveSeconds`) | for every row: `outsideNestedWorktrees`, newest file edit, the five cached signal readers in `lib/activity.js`; a changed row goes through `store.touch()` and paints without flashing |
| **Row scans** | per row, 5 s / 45 s / 90 s | `enqueueDue` asks `intervalFor(row)` for each row; the three tiers are in the table just below |
| **Full pass** | `slowSeconds` (300 s), in practice backlog-bound | `projectMeta` → `worktreeList --porcelain` reconcile → every row at `depth: "full"` → re-stamp `dueAfter` |

Cadence is the interesting part: `Scheduler.intervalFor(row)` is a small policy function with
three tiers, and it is re-read on **every tick**, not frozen into the row when it was stamped —
`enqueueDue` compares `now - lastFast` against the *current* interval, so a tree that turns live
is read on its new cadence immediately instead of waiting out its old dormant window.

| Tier | Interval | Rows in it |
|---|---|---|
| sharp | `worktreeSeconds` (5 s) | a panel agent is running here, or the row is live / idle |
| mid | `midSeconds` (45 s) | dirty, untracked, `verdictStale`, or a verdict of `…` / `UNMERGED` / `ERROR` |
| coast | `dormantSeconds` (90 s) | MERGED, NO COMMITS or ON MAIN, and clean |

Rows are also **staggered inside their tier** (`tierSlots` offsets each row's first due time), so
a hundred rows do not all become due on the same tick — which is what keeps a full fleet from
arriving as one burst of git processes.

This is what replaced the old pair of racing timers (a 5 s fast pass and a 60 s full pass that
scanned the same tree at the same time) — and it is why an idle board costs a fraction of what it
used to.

Row **lifetime** is git's, not the panel's. Every full pass reads `git worktree list --porcelain`
and drops rows git no longer lists — but only when that call succeeded and returned something,
because a transient git hiccup must not blank the table. A row whose folder is gone goes on the
first pass; one that is still a checkout but unlisted gets a second pass, because that is the shape
a hiccup takes.

### 3.2 The agent half

`lib/jobs.js` supervises runs over the Hermes HTTP Runs API rather than a child process. That
choice is stated at the top of the file and it changes the whole model:

```
panel                        gateway (/v1/runs)                 worker
  │ POST /v1/runs                  │                              │
  ├───────────────────────────────►│  {run_id} at once            │
  │ GET  /v1/runs/{id}/events      │                              │
  ├───────────────────────────────►│  SSE: tool.started,          │
  │                                │       tool.completed,        │
  │                                │       message.delta,         │
  │                                │       approval.request,      │
  │                                │       subagent.*, run.*      │
  │ POST /v1/runs/{id}/steer       │                              │
  │ POST /v1/runs/{id}/stop        │                              │
  │ POST /v1/runs/{id}/approval    │                              │
```

Because the run outlives the request, the panel gets three things a `spawn()` never had: a handle
on a turn that is already in flight (`steer`), a cooperative stop, and a status backstop it can
poll when the stream goes quiet. `Jobs` keeps a job per card, a `LIVE_JOB_STATUS` set
(`running`/`starting`/`waiting`), and a store file that survives a restart — a restored live run is
re-attached or marked `interrupted`, never silently forgotten.

The panel also takes over the two jobs the CLI used to do: it runs `git worktree add` itself, and a
panel thread name **is** the gateway session id — so a reply continues the same conversation with
no name mapping.

### 3.3 Every clock

Server side, in one table, because "why did that happen" is usually a clock question:

| Clock | Where | What it does |
|---|---|---|
| 1 s | `Scheduler.tick` | the only scan driver: due rows, liveness, visibility accounting |
| 5 s | `Scheduler.livenessPass` | evidence refresh, no git |
| 5 s | `Assistant.tick` | sentry rules over the job summaries the panel already holds |
| 5 s | `Jobs.sweepApprovals` | expire pending approvals |
| 5 s | `RemoteWrites.sweep` | expire parked pushes |
| 5 s | `heartbeat` (server) | a ~400 B frame to every SSE client with pool depth and stats |
| 10 s | `Jobs.sweepTitles` | title refresh |
| 10 s | assistant supervisor / landing checker | `supervise()`, re-verify a started landing |
| 15 s | `Jobs.poll` per running job | status backstop against the gateway |
| 30 s | `warmParents` | parent-book refresh |
| 60 s | release sweep | pending worktree-release requests |
| 4 s | `Jobs.refreshStats` per running job | card usage, read from the Hermes store (3 s cache) |
| 1800 s | fetch pass | `git fetch` per project — **not** wired to a caller except the button |

Client side there is no poll: the board is SSE-driven, and `refreshSeconds` appears nowhere under
`public/`. The one periodic check is a 30 s safety net that asks one pure question (`wtLive.quiet`)
— has any frame arrived in the last 20 s, and is the socket still open? A closed socket counts
even when the clock looks fresh, because the clock only advances on frames and a dead socket
publishes none. When the answer is "quiet", `resync()` asks for a snapshot.

---

## 4. The read path, step by step

```
config.scanRoots
   │  ProjectRegistry.refresh()        discovers git repos; explicit config entries win
   ▼
Project { name, path, mainBranch, remote, prRepo, activityAt, empty }
   │  Scheduler.fullPassProject()      projectMeta (5 git calls) + worktreeList reconcile
   ▼
Pool.enqueue({ worktree, depth })
   │  • the same (worktree, depth) is never queued twice — a duplicate gets the in-flight promise
   │  • two scans of the SAME worktree never run at once — they queue behind each other
   ▼
scan-worker.js  (worker_threads)
   │  scanWorktree(): rev-parse · status --porcelain=v2 --branch · log · merge-base · cherry · diff
   │  depth "fast"  = branch, head, dirty, ahead/behind, upstream
   │  depth "full"  = + patch-ids, verdict, commit list, diffstat
   ▼
Store.putRow()  — the one place a row is assembled
   │  • preserves the last full verdict when the commit count has not moved
   │  • derives `mergeable` (MERGED or NO COMMITS, and clean, and not live)
   │  • derives `sync` (ahead/behind against its OWN remote copy, lib/sync-state.js)
   │  • JSON-diffs before/after; emits only when something changed
   ▼
broadcast({ type: "row", project, row, changed })
   ▼
EventSource handler (public/core/sse.js) → app.js patches one <tr>, flashes it
```

Four properties fall out of this pipeline, and they are the reason it is shaped this way:

1. **A slow git call can never stall the event loop.** Every scan runs off-thread; the HTTP layer
   and the SSE fan-out stay responsive even when the disk is thrashing.
2. **A row cannot be written by two scanners at once**, so "the cheap scan and the expensive scan
   raced and the last one won" is structurally impossible.
3. **Change detection happens once, at the source.** `store.putRow` compares `JSON.stringify`
   without the timestamp and emits only on a real difference; `touch()` does the same for
   liveness-only updates and marks them `livenessOnly` so the client repaints without flashing.
4. **The client receives a row that is already interpreted.** The store writes the verdict words,
   the `mergeable` boolean and the sync state. The page chooses no word for itself.

---

## 5. The write path, step by step

Every route in `server.js` follows the same five beats, and the consistency is the point:

```
URL + method
  → match one `if (route === … && req.method === …)`
  → authorised(req, config.token)          loopback passes; anything else needs x-panel-token
  → readBody(req) / query params           typed, size-limited (256 KB body, raw body for attachments)
  → call one lib/ service                 (or, for command routes, run git here in the main thread)
  → store.putRow / broadcast / sendJson    then return a status the page can act on
```

Route families, and what each one is allowed to touch:

| Family | Examples | Writes |
|---|---|---|
| **Board reads** | `/api/state`, `/api/health`, `/api/stats`, `/api/build` | nothing |
| **Settings** | `/api/settings/*`, `/api/reload`, `/api/settings/remote-branches` | `config.json` (one key) or `<HERMES_HOME>/config.yaml` (one line) |
| **Worktree commands** | `/api/worktree/{child,rollup,rebase,rename,delete,lock,merge,verify-landed}` | git, and the panel's ledgers |
| **Agent control** | `/api/jobs/{steer,approve,answer,cancel,reattach}`, `/api/agents` | the gateway, never git |
| **Assistant** | `/api/assistant/*` | the scratchpad, the charter, the message board |
| **Permission boxes** | `/api/approvals/*`, `/api/remote-write/*` | in-memory questions + one settings write on `always` |

Two rules hold across the table:

- **The refusal is on the server.** Every write route answers `403` off-loopback without a token;
  the client disabling a button is a courtesy, never the control.
- **The route never invents a state.** It calls a module that already owns the decision
  (`remoteWrites.request()`, `locks.add()`, `todos.apply()`) and broadcasts whatever that module
  reports. A route is a thin adapter, which is why `server.js` can be 4,300 lines of it.

---

## 6. The data model

All identity keys are strings of the form `<project>::<path>` (`Store.rowKey`, mirrored by
`keyOf` in `public/app.js`). That one convention is what lets the server, the stores and the page
agree about which tree a TODO, a lock, a name or a release refers to.

| Noun | Shape | Owner | Lives in |
|---|---|---|---|
| **Project** | `{name, path, mainBranch, remote, prRepo, activityAt, empty}` | `lib/projects.js` (discovery), `Store.ensureProject` | memory + `projects.json` cache |
| **Row** | one worktree: branch, head, ahead/behind, verdict, dirty/untracked, `mergeable`, `sync`, `signals`, `scannedAt` | `lib/scan.js` produces, `Store.putRow` assembles | memory |
| **Job** | one agent run: `{id, thread, status, runId, project, path, prompt, model, usage…}` | `lib/jobs.js` | `jobs.json` |
| **Thread** | a Hermes session id; a panel thread name *is* the session id | `lib/jobs.js`, `lib/subagents.js` | gateway + `jobs.json` |
| **TODO** | `{id, text, status, owner, claimedAt, files, note, at, by}` — monotonic id per list | `lib/todos.js` | `todos.json` |
| **Lock** | worktree scope or branch scope; absence means unlocked | `lib/locks.js` | `locks.json` |
| **Parent / cut** | which branch a tree was cut from, and the sha at the cut | `lib/parents.js` | `parents.json`, `branch-parents.json` |
| **Release request** | `RELEASE <tree> \| <why>` parsed from a settled turn | `lib/worktrees.js` | `releases.json` |
| **Approval** | a gateway `approval.request` waiting on a human | `lib/approvals.js` | memory, expires to deny |
| **Remote write** | a push parked on the permission box | `lib/remote-writes.js` | memory + `push-guard.json` |
| **Host** | link + API templates for one code host | `lib/hosts.js` | `hosts.json` over `hosts.seed.json` |
| **Name** | which tree was named, by whom, when | `lib/tree-names.js` | `tree-names.json` |
| **Description** | what a branch was started to do, in the words of its run | `lib/features/descriptions.js` | `descriptions.json` |

### The row is the centre of gravity

A row is not a database record; it is a **claim with the evidence attached**. Three fields carry
most of the meaning:

- `verdict` — `ON MAIN`, `MERGED (squash/rebase, N commits)`, `MERGED (content identical)`,
  `UNMERGED (N commits)`, `NO COMMITS`, `NO BASE REF`, `EMPTY REPO`. Deliberately opinionated:
  ancestry is not evidence of landing (a squash merge leaves the branch an ancestor of nothing)
  and an ahead-count is not either (a branch can be 40 commits ahead with every patch already in
  main under other shas). So the scan asks twice — identical trees, or `git cherry` with no `+`.
- `mergeable` — the verdict *and* clean *and* not live. This is the field the row's "safe to
  remove" claim is built from, and `Store.putRow` is where it is derived.
- `verdictStale` — set when the commit count moved but no full scan has reclassified the row yet.
  The page can then say "…" instead of asserting a verdict it has not recomputed.

That last one is a small design statement in itself: the panel would rather print an ellipsis than
a wrong word.

---

## 7. Architectural design elements

Fifteen things this codebase does on purpose. The list is not a pattern catalogue — each entry is
something a change here has to keep doing, and each one already has a home in the tree.

| # | Element | Where it shows |
|---|---|---|
| 1 | Composition root, no framework | `server.js` |
| 2 | Read path as a pipeline, not a request | `lib/scheduler.js` → `lib/pool.js` → `lib/store.js` |
| 3 | Keyed concurrency and in-flight dedupe | `lib/pool.js` |
| 4 | Adaptive cadence instead of a global poll | `Scheduler.intervalFor`, `dueAfter` |
| 5 | Snapshot-then-delta over one SSE fan-out | `lib/http/transport.js`, `public/core/sse.js` |
| 6 | Derived state computed once, at the write side | `Store.putRow`, `lib/sync-state.js` |
| 7 | Snapshot composition (decorators, not a god object) | `snapshot()` in `server.js` |
| 8 | Single-writer, versioned, atomically-renamed JSON | `lib/todos.js`, `lib/locks.js`, `lib/paths.js` |
| 9 | State outside the checkout | `lib/paths.js` (`~/.wag`) |
| 10 | Fail-closed policy, as data | `lib/remote-writes.js`, `authorised()` |
| 11 | Defence in depth across a process boundary | `lib/push-guard.js`, `server.js` 409s |
| 12 | Written-line protocols (the panel's grammar) | `lib/todos.js`, `lib/worktrees.js`, `lib/verify-landed.js` |
| 13 | Capability probing instead of assuming | `Jobs.transportInfo`, `/api/agents/preview` |
| 14 | Pure cores, impure shells | `lib/sync-state.js`, `core/stream-merge.js` |
| 15 | Verification as a subsystem, not a folder | `test/`, `tools/panel-testkit.mjs`, `tools/verify.mjs` |

### 7.1 Composition root, no framework, no dependencies

`server.js` builds every object once (`new Store()`, `new Pool(config.threads)`,
`new Scheduler({config, store, pool, registry, hosts})`, `Jobs`, `Assistant`, `Approvals`,
`RemoteWrites`, `Locks`, `TodoLists`, `ParentBook`, `RestartController`) and hands each one its
collaborators through the constructor. Nothing reaches for a global. `package.json` declares
`"dependencies": {}` and means it: the whole panel is Node's standard library.

What it buys: the tree can be read without a build, `node server.js` is the entire deployment, and
a module's collaborators are visible in its constructor signature. What it costs: the composition
root also became the HTTP layer, so `server.js` is 4,304 lines and the wiring is not separately
testable. That trade is named, not hidden — see §10.

### 7.2 The read path is a pipeline, not a request

No GET handler scans. `GET /api/state` reads the store; `GET /api/stream` writes the store's
snapshot and then subscribes. Scans happen because a clock said so, at a cadence the scheduler
owns, and the result lands in the store when it lands.

This decouples three quantities that are usually tangled: number of open tabs, number of
projects, and number of git invocations. Ten tabs do not mean ten times the disk reads — they mean
ten SSE readers on one fan-out. It also makes the panel's freshness a property of one algorithm
(`intervalFor`) instead of a property of whoever called `fetch()`.

### 7.3 Keyed concurrency: a pool with two guarantees

`lib/pool.js` is a fixed-size `worker_threads` pool (`new Pool(config.threads)`; the constructor
defaults to 4 and floors at 1) with two guarantees written into its header:

- the same `(worktree, depth)` scan is **never queued twice** — a duplicate request gets the
  in-flight promise back;
- two scans of the **same worktree never run at the same time** — they queue behind each other.

The second one is the load-bearing one. Without it, a cheap `fast` scan and an expensive `full`
scan of the same tree can interleave their `putRow` calls and the older, poorer row overwrites the
newer, richer one. Serialising per key makes the row monotonic in practice, and the store's "last
full verdict survives unless the commit count moved" rule makes it monotonic in fact.

The pool also bounds a resource the OS cares about: `git.exe` processes. An unbounded fan-out over
100 worktrees is how you make a Windows box unusable; a 5-slot queue with a 90 s per-task timeout
is how you do not.

### 7.4 Adaptive cadence, not one global poll

`Scheduler.intervalFor(row)` answers one question per row: *how much would it cost to be wrong
about this row for another minute?* A merged, clean row is cheap to be wrong about
(`dormantSeconds`, 90 s); unfinished work — dirty, untracked, unclassified — is not, but it is
also not moving on its own (`midSeconds`, 45 s); a live or idle session, or a panel agent working
in the tree, is expensive to be wrong about at all (`worktreeSeconds`, 5 s). `dueAfter` stamps each
row's next read, and the ticker only enqueues what is due.

The same idea appears on the client in miniature: row ranking uses a sliding window with a
hysteresis margin (`RANK_MARGIN_PER_MIN`), so a single console line cannot reorder the board and
a row that goes quiet yields its slot as its events age out.

### 7.5 Snapshot-then-delta over one SSE fan-out

`GET /api/stream` writes one `snapshot` frame — the whole board, about 2 MB on a 100-project fleet —
then a stream of typed frames (`row`, `project`, `drop`, `job`, `jobline`, `jobs`, `approval`,
`approval-answered`, `remote-write`, `remote-write-answered`, `settings`, `heartbeat`). The client
applies the snapshot once and patches individual rows thereafter.

Three details keep it honest:

- **The store emits only on change.** `putRow`/`touch` diff the row without its timestamp, so the
  steady state is silent rather than a 5-second heartbeat of identical rows.
- **The first frame is accepted in both shapes.** `handleStream` writes a bare snapshot; later
  broadcasts wrap it. `core/sse.js` accepts `d.data` or a bare payload because the first frame
  would otherwise break — a documented, load-bearing wart.
- **Silence is a state.** A 5 s heartbeat carries pool depth and stats, and the client treats 20 s
  of silence as a reason to resync. A closed stream and a quiet stream are told apart by a clock,
  not by hope.

### 7.6 Derived state is computed once, on the write side

`Store.putRow` is the only place a row is assembled, and it computes the fields that are
*judgements* rather than *facts*:

```
incoming facts  →  verdict carry-over  →  mergeable  →  sync  →  changed?  →  emit
```

`lib/sync-state.js` is a pure function (`syncState({row, remote, fetchNote})`) with no git and no
I/O, called on **every** put, fast scans included — which is why a push shows up on the next scan
rather than the next full pass. `lib/chart-columns.js` is the same idea for the chart's ten column
ids, and it makes the same kind of choice in the other direction: the stored value is the columns
to **hide**, so a column added to the chart later starts visible for a reader who has already
hidden some, instead of appearing nowhere. The page renders the words it is given.

Why it matters: a rule that lives on both sides of the wire drifts. Two of the repo's own
`arch-review` documents count the places where it already has. Computing at the write side means
there is one place to change and one place to test, and the client cannot disagree with the server
because it never forms the opinion.

### 7.7 The snapshot is composed, not enumerated

```js
function snapshot() {
  return withRefreshJournal(
    withReleases(
      withTodos(
        descriptions.withDescriptions(
          withLocks(
            withTreeNames(
              withLiveAgents({ ...store.snapshot({settings}), paths, jobs, approvals,
                                remoteWrites, assistant, hosts, skipped, scanRoots, spawn }))))));
}
```

Each decorator adds exactly one feature's section and knows nothing about the others. The store's
own `snapshot()` returns projects and rows; everything else is layered on top, in `server.js`.
Adding a feature means adding a `withX`, not editing six sections of one function — and a test can
call `store.snapshot()` alone when it wants the bare board.

This is the same instinct as the `lib/` split, applied one level up: the composition root composes
data shapes the way it composes objects.

### 7.8 Single-writer, versioned, atomically-renamed JSON

Every durable store is a file in `dataDir`, and the stores that have to survive a shape change
follow three rules:

1. **A version field.** `TODOS_VERSION`, `LOCKS_VERSION`, `DESCRIPTIONS_VERSION`,
   `PARENT_FILE_VERSION`, `TREE_NAMES_VERSION`, `RELEASES_VERSION`, `GUARD_VERSION`,
   `STORE_VERSION` (the assistant) — a store that changes shape declares it, so a reader can
   refuse or migrate rather than half-load.
2. **Atomic replacement.** Write to a temp file, `renameSync` over the target. Twelve modules do
   this (`todos`, `locks`, `parents`, `tree-names`, `descriptions`, `steward`, `worktrees`,
   `refresh-row`, `restart`, `hermes-config`, and the assistant's two files); a crash mid-write
   leaves the previous good file, never a truncated one.
3. **One writer.** The panel is the only process that writes these files, so the classic file-race
   problem does not exist — as `lib/todos.js` says out loud: every writer in the fleet (the
   assistant, every worker's harvested final message, the reader's own edits) goes through this one
   Node process, so the module serialises by construction.

The job store is the exception worth naming: `jobs.json` is written directly with a `savedAt`
stamp and carries no version, because a lost job card is recoverable from the gateway (the run is
still there) and a shape change is handled by tolerance at load rather than by refusal. It is the
one file whose loss the panel is designed to survive rather than to prevent.

There is no database, no migration framework, and no lock file. A store that goes wrong can be
debugged with `less`. The cost is that nothing enforces the single-writer invariant if a second
panel instance is pointed at the same `dataDir` — which is why each panel's `dataDir` is
per-install by default.

### 7.9 State lives outside the checkout

`lib/paths.js` is the only module that builds a data path. Two directories, two intents:

| | Default | Contents | Promise |
|---|---|---|---|
| `dataDir` | `~/.wag` | job store, todos, locks, names, descriptions, prices, push-guard record, restart record, attachments, server log | survives re-clone, move, chmod |
| `scratchDir` | `<tmpdir>/wag` | comparisons, exported branches, probe output | the OS may delete it whenever |

Before this module every path was derived from `path.dirname(CONFIG_PATH)` — inside the
repository — which is why a fresh clone opened on an empty board and a deleted checkout took the
job store with it. The invariant now is blunt: **nothing outside `lib/paths.js` derives a data
path**, and `statePaths(config)` is the one function that answers "which file".

The same instinct shows in the client: a worktree's TODO list lives beside the job store, never
inside the worktree, "where it would be git noise and a merge conflict".

### 7.10 Policy as data, and the closed default

`lib/remote-writes.js` holds the reader's rule for whether a branch may exist on a remote:

| Value | Meaning |
|---|---|
| `local-only` *(default)* | every branch stays local; a remote write is refused unless granted through the permission box |
| `allow` | standing grant: writes go through without asking (= "Always allow" in the box) |
| `deny` | never, and do not even ask |

Three details make it a design element rather than a setting:

- **The default is the closed one**, and an unreadable value falls back to it
  (`policyFrom` returns `DEFAULT_POLICY` for anything it cannot parse).
- **A per-project override exists** because the policy is not uniform: this panel and heroes-js
  land by pushing a branch, while every other checkout here is local work
  (`policyForProject`).
- **The setting and the box are the same fact.** "Always allow" writes the setting; the setting
  pushes into every installed guard. There is no second place where "allowed" is remembered.

The same fail-closed shape appears in `authorised()` (no `PANEL_TOKEN` in the environment means
non-loopback writes are off, not on), in approvals (a request that expires answers `deny`), and in
`policyFrom`'s comment: *a permission that is assumed is not a permission.*

### 7.11 Defence in depth, and honesty about its limits

The push guard is the clearest example of a boundary drawn twice:

- **The client** disables a merge chip and prints the reason.
- **The server** answers `409` for the same condition.
- **A git hook** (`lib/push-guard.js`) stands between a worker's shell and the remote, because a
  brief is advice and the panel cannot see inside a shell.

The hook is installed *per worktree* (`git config --worktree core.hooksPath` under
`extensions.worktreeConfig=true`) into `<git-common-dir>/wtgui-hooks/`, with **shims** that run
each hook the tree had before. That detail matters: taking a clone's whole hooks path would
silently switch off this repo's own tracked `.githooks/commit-msg`.

And the module says what it is not: `git push --no-verify`, `git -c core.hooksPath= push`,
`WTGUI_PUSH_GRANT=1` and a push from a tree the panel did not cut all go around it. It is a speed
bump on the default path, not a lock. Writing that down is part of the design — a control whose
bypass is undocumented is one that will be trusted too far.

### 7.12 Written-line protocols: the panel's grammar

A worker's **final message** is not just prose. It is a structured channel, read against a
grammar the panel owns:

```
TODO DONE 3 · TODO DOING 4 · TODO ADD <text> · TODO DROP 7
RELEASE <worktree path or slug> | <why it is finished>
CHECKED <path> | <one word>
```

The grammar has four properties, and together they are the most distinctive architectural
decision in the repo:

1. **It is parsed only from the settled turn's last message**, never from the middle of a
   transcript — so a worker quoting the instruction cannot trigger it.
2. **Ids are monotonic per list and never reused**, so a stale `TODO DONE 3` from months ago
   cannot close a different item.
3. **The panel never invents a state.** `lib/todos.js`: "nothing here marks anything done on its
   own: a wrong auto-completion is worse than an unfinished line." `apply()` applies what a human
   or a worker actually wrote.
4. **Side effects are deferred to the panel.** A worker cannot delete its own worktree (on Windows
   its cwd holds the directory open), so it asks; the panel, whose cwd is outside every tree,
   performs the removal after the run settles. The same split keeps the worker's shell out of the
   gateway's destructive-command gate.

This is a small RPC over a chat channel, and it is the mechanism by which a *stateless* agent can
safely update a *stateful* board.

### 7.13 Capability probing, not assumption

The panel does not assume the gateway it is pointed at has the endpoints it wants.

- `Jobs.transportInfo()` reports the gateway URL, reachability, and a `capabilities` object
  (`runs`, `events`, `steer`, `stop`, `approval`, `runCwd`, `runBudget`, `maxTurns`). The page
  renders what is actually there.
- `POST /api/agents/preview` returns the exact run request that *would* be sent
  (`{transport, request, blocked}`), so a form can be checked without spawning anything.
- `POST /api/agents` answers **503** when the api_server is unreachable or unkeyed, rather than
  failing inside a run.
- `/api/settings/sessions` reports `patched: false` when the installed CLI has no patch for
  `sessions.list_limit` — "a setting that quietly does nothing is worse than no setting".
- `/api/models` reports `pricingSource`, `pricingAge` and `ratedFromSnapshot` so a number from a
  cache is never presented as a number from upstream.

`lib/clarify.js` is the same idea for the `clarify` tool: what this panel knows about the gateway's
capability, in one module.

### 7.14 Pure cores, impure shells

The functions that encode a *rule* are separated from the code that touches the DOM or the disk,
and the pure half is what tests import:

| Rule | Pure module | Shell that calls it |
|---|---|---|
| Ahead/behind against the branch's own remote copy | `lib/sync-state.js` | `Store.putRow` |
| Which chart columns are drawn | `lib/chart-columns.js` | `server.js`, `app.js` |
| Where a reasoning block sits in a stream | `public/core/stream-merge.js` | `app.js` |
| Is the live path still delivering? | `public/core/liveness.js` | `core/sse.js` |
| How fast output reaches the eye | `public/core/type-stream.js` | `app.js` |
| Is this build stale, and may we reload? | `reloadDecision` in `core/update-check.js` | the page half of the same file |
| Parse a git status / diff / log | `lib/scan.js` | `scan-worker.js` |

The client files publish their pure half on `globalThis` (`wtStream`, `wtLive`, `wtType`,
`wtUpdateCheck`) so a `node --test` file can import the same bytes the browser runs. That is how a
17k-line client still has unit-testable logic in it.

### 7.15 Verification as a subsystem

Three tiers, each shaped for a different question:

| Tier | Where | Question it answers |
|---|---|---|
| **Unit** | `test/*.test.js` (70 files, 524 declarations) | does this rule hold in isolation? |
| **Route** | `tools/panel-testkit.mjs`, used by 18 of the 70 test files | does this route do what it says, on a throwaway config? |
| **Harness** | `tools/verify-*.mjs` (64 programs) | is this claim true on a real machine, right now? |

`panel-testkit.mjs` boots the **real** `server.js` against a throwaway config on a free port, with
its own `HERMES_HOME` and no gateway key — so a test asserts behaviour, not source text.
`tools/verify.mjs` is the runner for the harnesses (`--list`, `--all`, `--only <substring>`,
`--dir`, `--json`, `--timeout`), with exit codes `0` all passed, `1` a failure, `2` nothing
selected. A harness is a *program*, not a framework case: it prints what it measured and exits
non-zero when its claim failed.

The gates are git hooks, not a service: `.githooks/commit-msg` refuses a subject that does not
name a symptom (because squash-merge composes main's history from branch subjects), and
`.githooks/pre-push` refuses a bump-worthy branch with no version bump. Both are offline, both are
installed per clone (`npm run hooks:install`), and both document their own bypass. There is no CI —
the README says so, and the pre-push hook is what stands in for it.

---

## 8. The client

`public/` is 14 classic `<script>` tags, in a fixed order, with **no bundler and no modules** —
because `public/assistant.js` reads `app.js`'s own globals by name (`esc`, `conversations`,
`conversationHtml`), so an ES-module split is not available. The order is documented in
`index.html` and is read bottom-up: each script's top-level declarations must exist before the
next one is evaluated.

The extraction pattern is worth naming, because every `public/core/*` and `public/board/*` file
carries its header in the same shape:

```
M<n> in .agentboard/refactor-research/frontend-app-js.md
moved line for line: lines A-B of public/app.js at <sha> — <n> lines
nothing renamed, nothing rewritten, no call site touched
LOADED AS A CLASSIC SCRIPT, BEFORE app.js
WHAT IT STILL REACHES OUT FOR (by name, at call time): state, $, applySnapshot, …
```

That last line is the important one: a module that is not a leaf **declares its edges** instead of
pretending it has none. It is how a globals-based client stays navigable.

`app.js` remains the hub (17,178 lines, 668 top-level functions): board rendering, row patching,
conversation rendering, the spawn card, the reply box, the model picker, the chart, the settings
panel. It is where the entropy is, and §10 says so.

---

## 9. Configuration and discovery

`config.json` is the reader's file and the panel's only input:

```json
{
  "port": 7331, "host": "0.0.0.0",
  "scanRoots": ["C:/ProjectDevelopment"],
  "projects": [{ "name": "agent-worktree-gui", "path": "…", "remote": "github",
                 "mainBranch": "main", "prRepo": "JLRoper/agent-worktree-gui",
                 "remoteBranchPolicy": "allow", "releaseWorktrees": true }],
  "worktreeSeconds": 5, "midSeconds": 45, "dormantSeconds": 90,
  "slowSeconds": 300, "fetchSeconds": 1800, "liveSeconds": 5,
  "threads": 5, "jobMaxRuntimeSeconds": 3600,
  "remoteBranchPolicy": "local-only"
}
```

Two elements of the config shape are architectural rather than incidental:

- **Discovery beats registration.** Every git repo under `scanRoots` becomes a project; an entry
  in `projects[]` only *overrides* what discovery found (it can add a `prRepo`, a
  `remoteBranchPolicy`, a `releaseWorktrees` grant). Adding a repo to the disk is the whole
  onboarding step; non-git directories are reported in `skipped` rather than vanishing.
- **A setting that is not `config.json` is not assumed to be writable.** The gateway's
  `approvals.timeout` and the CLI's `sessions.list_limit` live in `<HERMES_HOME>/config.yaml`, so
  the routes that change them rewrite exactly one line, re-read the file, and refuse if it does
  not say what was asked (`lib/hermes-config.js`). Values the panel cannot own are reported, not
  faked.

---

## 10. Where the seams are

A map that does not name the thin places is a brochure. These are structural, not urgent, and the
repo's own arch reviews argue them at length:

- **`server.js` is 4,304 lines and 104 route branches.** The route chain is a linear `if`
  sequence, not a table, so adding a route means inserting a branch and a reader means scanning.
  Ten of the branches are 35–135-line services that would be at home in `lib/`.
- **`public/app.js` is 17,178 lines with 668 top-level functions** and eight document-level click
  listeners. The extraction into `core/` and `board/` is real but partial, and the file grew by
  more than the extractions removed.
- **A handful of rules have two homes across the client/server line** — the fold-note text, the
  per-million price formatter, the byte formatter (`fmtBytes` disagrees with itself: `1 KB` for 0
  bytes in `core/dom-format.js`, `0 B` in `app.js`), the TODO statuses and glyphs, the head-line
  cap on a tool result. Some pairs are pinned by a test (`chart-columns`), some by a comment, some
  by nothing.
- **"Which tree is this?" has several string rules.** `push-guard.js` lowercases and rewrites
  MSYS paths, `worktrees.js` resolves without folding case, `locks.js` deliberately keeps its own,
  and `server.js` has two of its own 277 lines apart. Each is locally justified; there is no
  single identity function.
- **There is no CI.** `npm test` and `npm run verify:all` are the gate, and they run when someone
  runs them. The pre-push hook only checks the version bump.
- **The bind address and the auth model are two separate decisions.** The code default is
  `127.0.0.1` (`cfg.host = cfg.host || "127.0.0.1"`), but this checkout's `config.json` sets
  `0.0.0.0`, and `authorised()` then refuses off-loopback **writes** without a `PANEL_TOKEN`.
  Reads — including the whole board and the SSE stream — are not challenged. It is the safe half
  of a safe default, and it depends on the token being set rather than on the bind address.
  `docker/PLAN.md` says the same thing more loudly; read it before changing `host`.

---

## 11. Where to start reading

| To understand… | Read |
|---|---|
| the whole request surface | `server.js`'s route chain (grep `if (route ===`) and README's **Endpoints** table |
| why a row says what it says | `lib/scan.js` (facts) → `lib/store.js` `putRow` (judgement) |
| freshness and cost | `lib/scheduler.js`, then `docs/arch-review-efficiency.md` |
| concurrency | `lib/pool.js` — its header is the spec — and `lib/scan-worker.js` |
| agents | `lib/jobs.js` header, `docs/runs-api-phase0.md`, `docs/runs-api-phase1.md` |
| the assistant | `lib/assistant.js` header, `lib/assistant/config.js` (rules + autonomy) |
| the permission model | `lib/remote-writes.js`, `lib/push-guard.js`, `lib/approvals.js`, `docs/pushing-to-a-remote.md` |
| naming, parents, roll-ups | `lib/tree-names.js`, `lib/parents.js`, `lib/child-worktree.js`, `docs/child-worktrees-and-rollups.md` |
| the page | `public/index.html` (script order), `docs/using-the-board.md` |
| how a change is proven | `tools/verify.mjs`, `tools/panel-testkit.mjs`, `docs/versioning.md` |

---

## 12. One-paragraph summary

A single-process, dependency-free Node panel that treats **git as the source of truth and the
store as a cache of judgements about it**: a scheduler turns wall-clock time into scans, a worker
pool turns scans into rows without ever blocking the event loop, a store turns rows into derived
claims, and one SSE fan-out turns those claims into pixels. Agents are a second control plane over
the same process — the Hermes Runs API replaces `spawn()`, the panel owns the worktree and the
thread, and a small written-line grammar (`TODO …`, `RELEASE …`, `CHECKED …`) lets a stateless
worker safely ask a stateful board to change the world. Nearly every durable thing is a versioned
JSON file with one writer and an atomic rename; every permission is closed by default and granted
in the open; and the proof that any of it works is a program in `tools/` rather than a tick in a
CI UI.
