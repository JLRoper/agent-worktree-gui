# Splitting this panel for concurrency — one entry point

Three research pages measured three surfaces of this tree: the request dispatcher, the client script,
and `lib/`. This page is the one a crew reads first. It does not repeat their measurements; it states
**the cut each one makes, the one parallel-safe wave each one has, the collisions that survive the
three cuts, and which two agents can be started on the same day**. Every number below is cited with the
tree it was taken from, and §6 lists every number the three pages disagree on and which one wins.

- [`split-server.md`](split-server.md) — `server.js`, measured at **`e2358c5`** (`1.4.0`), the tip of
  `wtgui/split-research-1-server-4f1da3` (`65c7f46`). 13 route modules.
- [`split-public-app.md`](split-public-app.md) — `public/app.js`, measured at **`1e1c595`** (`1.4.2`),
  the tip of `wtgui/split-research-2-public-aa78b1` (`f0f0183`). 10 panel files.
- [`split-lib.md`](split-lib.md) — `lib/`, measured at **`1e1c595`** (`1.4.2`), the tip of
  `wtgui/split-research-3-lib-int-bfda7a` (`bae2ccb`). 8 ownership clusters.
- [`lanes-and-modules.md`](lanes-and-modules.md) — the map all three extend. Its §6.1 is the client
  cut's effect on the lane rule (from the public page) and its §13 is the cluster summary (from the lib
  page); both were reconciled into this tree by hand, and every pointer from the three pages resolves.
- **This page's tip: `92d5fcc` (`1.5.5`).** Where a page's headline number has moved since its own
  snapshot, §6 carries the reading at this tip and names both trees. Re-measuring here changed no
  conclusion: the co-change matrix in §4.1 is byte-for-byte the lib page's, and the dispatcher gained
  exactly one route.

This is research. Nothing under `server.js`, `lib/`, `public/` or `test/` is changed.

**Contents**

1. [The three cuts](#1-the-three-cuts)
2. [What "parallel" means here](#2-what-parallel-means-here)
3. [The one parallel-safe wave from each surface](#3-the-one-parallel-safe-wave-from-each-surface)
4. [The collisions that survive](#4-the-collisions-that-survive)
5. [Which two agents can be started together](#5-which-two-agents-can-be-started-together)
6. [Numbers the three pages disagree on](#6-numbers-the-three-pages-disagree-on)
7. [What this page did not do](#7-what-this-page-did-not-do)

---

## 1. The three cuts

### 1.1 `server.js` — thirteen route files, one router, one spine

At `e2358c5` the file is **5,833 lines**. `createServer` opens at 2,378; the request handler runs to
5,589 and holds **136 dispatch conditions** (135 `route === …` blocks — one carrying two paths — plus
the one `route.startsWith("/api/approvals/")`). Those conditions carry **137 inline paths**, and three
more paths are already mounted from `lib/` factories, so the panel answers **140 API paths**. 465 of
the statements inside the blocks are `return sendJson(`.

The cut is **13 files under `lib/routes/`, each a factory that returns `(req, res, route, url) =>
Promise<boolean>`**, plus `lib/routes/index.js`, which owns the ordering, the one handler and a
boot-time duplicate-claim assertion:

| # | File | Routes | Body lines | Wave |
|---|---|---:|---:|---:|
| 1 | `system.js` | 5 | 25 | 0 |
| 2 | `assistant.js` | 26 | 257 | 1 |
| 3 | `pipelines.js` | 2 | 77 | 2 |
| 4 | `todos.js` | 2 | 38 | 2 |
| 5 | `approvals.js` | 4 | 24 | 2 |
| 6 | `settings.js` | 25 | 318 | 3 |
| 7 | `panel-io.js` | 7 | 164 | 4 |
| 8 | `projects.js` | 11 | 232 | 4 |
| 9 | `worktrees.js` | 7 | 350 | 5 |
| 10 | `remote-writes.js` | 9 | 235 | 6 |
| 11 | `landing.js` | 5 | 335 | 7 |
| 12 | `conversations.js` | 17 | 406 | 8 |
| 13 | `jobs.js` | 11 | 142 | 9 |
| — | **spine** (stays) | 5 | 58 | — |

131 routes and 2,603 body lines move; the spine keeps `/api/reload`, `/api/restart` GET and POST,
`/api/restart/cancel` and `/api/stream`. After all thirteen, `server.js` is **≈2,584 lines** — the
2,377-line composition root minus 112 moved helper lines, plus a ~45-line mount table, the 244-line
tail and a handler of about 30 lines. Six rules make a move provable — exact paths only, `reply` never
`return sendJson`, no module-level `try/catch`, live values as getters, import `lib/` directly, do not
re-indent — and §8 of the server page turns them into a byte-identical diff.

**The one file every extraction still edits is `server.js`**: the blocks are deleted from it and the
factory is added to its mount table. That is a queue rule, not a merge rule, and it is why the server
surface is an order with two parallel waves rather than a fan-out.

### 1.2 `public/app.js` — ten panel files, no HTML change

At `1e1c595` the file is **22,695 lines**, loaded by one `<script>` tag at `index.html:822`, and it
publishes **no `window.*` name by assignment**. It declares **1,140 top-level names** — 786 `function`,
88 `async function`, 196 `const`, 70 `let` — of which **874 are `window` properties** and 266 are global
lexical bindings that a later classic script can still read by bare name. **65 of the 1,140 are read by
the other sixteen scripts**; 44 of them must stay resolvable for the page after the cut.

The cut is **ten files under `public/board/`**, keeping every `<script>` position:

| File | Owns | Units | Lines |
|---|---|---:|---:|
| `board/board.js` | shell: `state`, boot, render engine, folders/collapse, banner | 222 | 3,065 |
| `board/rows.js` | the worktree table, cells, detail, TODO | 98 | 1,856 |
| `board/cards.js` | turns, conversation, question box, approvals dock | 188 | 3,218 |
| `board/jobs.js` | the jobs board, spawn bar, prompt history | 47 | 740 |
| `board/console.js` | tool bursts, console writers, markdown, scroll | 166 | 2,263 |
| `board/charts.js` | ranking, top-N, anchor, columns | 131 | 1,277 |
| `board/deliverables.js` | the DELIVERABLES button and list | 20 | 411 |
| `board/settings.js` | every settings tab but Pipeline/Bundles | 210 | 2,558 |
| `board/pipeline.js` | the chip, the Pipeline and Bundles tabs | 43 | 602 |
| `board/human.js` | the HUMAN rotation | 15 | 315 |
| **total** | | **1,140** | **16,305** |

The remaining 6,390 lines are the load-time spine: **243 top-level statements, 2,570 code lines** of
listeners, timers and late `state.x = state.x || …` fields, 1,770 of them in the shell's one listener
block. A first landing may leave all wiring in `app.js` and move only declarations — a listener that
calls a bare name does not care which file declares it.

**The seam is a name surface, not an import edge.** Two measured facts in a real browser decide it:
a top-level `function` in a classic script is a `window` property while a top-level `const`/`let` is
not (yet both are readable by bare name later), and a second top-level `const` of one name in another
classic script is a `SyntaxError` that kills that script alone. So a moved block must not carry a
`const`/`let` whose name stays behind, and the cut is safe only while the 44 page-facing names and the
cut-internal reads in the public page's §4 tables stay resolvable.

### 1.3 `lib/` — eight ownership clusters, seven moves

At `1e1c595` the library is **88 files that are not the test** — 87 ESM modules plus
`lib/panel-restart.cjs` — totaling **36,449 lines**, with **143 import edges** between them, **54 static
specifiers** from `server.js` (56 modules reached, two through `await import()`), **zero cycles**, and
**259 commits that touch `lib/`**.

The cut is **eight clusters**, each module assigned exactly once, from a greedy-modularity partition of
the import graph (edge weight 1, plus `0.5 × min(co-change, 4)`):

| Cluster | Modules | Lines | Owns |
|---|---:|---:|---|
| SUBSTRATE | 4 | 1,086 | paths, tree names, is-this-a-tree, `HttpError` — the floor |
| SERVER | 10 | 2,268 | HTTP framing, static, the store, boot, restart |
| WATCH | 11 | 3,933 | git reads, the worker pool, the ticker, projects, hosts, liveness |
| RUNS | 18 | 7,697 | the run state machine, console, usage, approvals, admission |
| ASSISTANT | 18 | 11,466 | the assistant vertical: turn, queue, charter, messages, settings |
| INSTALL | 6 | 2,203 | the Hermes contract: config, models, permissions, skills |
| PIPELINES | 6 | 2,604 | catalogue, bundle contract, task position, window |
| LANDING | 15 | 5,192 | worktree lifecycle and landing: cut, rebase, lock, remove, verify, push |

Seven moves, then ASSISTANT last; SUBSTRATE is frozen. **`server.js` is edited at every step** — its 54
specifiers live in one import block — so the library surface lands one cluster at a time even when two
are authored together.

---

## 2. What "parallel" means here

Two agents are parallel here only if **they can be written in separate worktrees at the same time
without one worker's decision changing the other's signature**. It never means they can land together.

**Landing concurrency is 1, on every surface.** `package.json` is the version gate: the pre-push hook
refuses a branch whose number is not above `origin/main`'s, and the map's §3.1 records it as the file
every landing edits. A second landing that starts before the first merges carries the same number and
is refused or, worse, lands a duplicate. So the unit of concurrency in this repo is the *authoring*
wave; landings queue.

The three cuts do not change that, and neither does any code move. What they do change is how much
work can be stacked up behind the queue.

---

## 3. The one parallel-safe wave from each surface

### 3.1 Server: waves 2 and 4, and nothing else

The server page's nine waves are an order, not a fan-out: waves 0, 1, 3 and 5–9 are single-worker,
because each installs a convention, moves a helper, or edits the largest block in the file. **Two
waves are genuinely parallel:**

| Wave | Groups | At once | Why it is safe |
|---|---:|---:|---|
| **2** | pipelines, todos, approvals | **3** | 8 routes and 139 body lines between them; disjoint regions (2,476–2,563; 3,928–3,966; 3,895–3,921); no shared helper; no moved helper at all |
| **4** | panel-io, projects | **2** | each moves exactly one route-only helper (`editorFor`; `stewardProject`) and their regions are adjacent but disjoint (3,331–3,412 vs 3,419–3,522; 3,887–3,889 vs 3,864–3,867) |

Wave 0 is the seam plus `system` — it installs `lib/routes/index.js`, the `reply` convention, the three
getters and the mount, and **nothing else may start until it lands**. Wave 1 (`assistant`) then proves
a large contiguous block moves without touching the header.

Three pairs cannot be parallel even in authoring, and they are named here so no crew pairs them by
size: **remote-writes + landing** (both call the five guard helpers and read `remoteWrites` and
`policyForProject`; keep the five in the spine, or move them in their own landing first),
**conversations + jobs** (both use `jobs`, `assistant` and `broadcast`; jobs lands after conversations),
and **settings + system** (no seam conflict — size, not seam, is why they are in different waves).

### 3.2 Client: the console is the seam that makes the other nine independent

Measured by counting how often two proposed files alternate in line order — a pair that alternates N
times produces N conflicting hunks if both cuts are made from one base:

| Pair | Alternations |
|---|---:|
| **cards / console** | **13** |
| board / cards, board / console, board / rows, console / jobs | 6 each |
| cards / jobs | 5 |
| every other pair | ≤ 4 |

Thirteen is the outlier and it is structural: the turn's own model sits inside the tool-burst
bookkeeping — one section, two panels. **So `board/console.js` is the first extraction**, and until it
lands cards and console cannot be cut in parallel. It is the right first move for four reasons:

1. **It is the provider.** 30 of the 36 names `cards` reads from outside itself come from the console.
2. **Its state fields are already in its own region** — the five late `state.*` additions sit beside its
   own functions, not in the `state` literal, so the move takes them along.
3. **The proofs already slice it out of the file** — two tests cut its markers, four more read its
   helpers by name, and one already imports a console *module*.
4. **It is a contiguous delete** — two big runs plus the sub-console block, with no piece inside another
   panel's run.

After `console.js` lands, the worst-case alternation among the remaining nine is **6**, and all six
belong to the shell's own blocks — so rows, cards, jobs, charts, deliverables, settings, pipeline and
human can be authored against different bases. Two things still serialise them, and neither is
`app.js`: **`index.html`** (one `<script>` line per file, all in the 782–828 block — agree an insertion
order and add each line at its own phase boundary) and **`package.json`**.

The state block is the *last* thing to move, not the first: its literal calls 19 loaders that live in
three panels, so moving it first is 19 hunks in three panels' regions before any panel has moved.

### 3.3 Library: the order, and PIPELINES as the one safe neighbour

The cluster graph has cycles, so there is no topological order. The page's order is chosen by two
rules — move what `jobs.js` imports from before `jobs.js`, and break the remaining cycles in favour of
the consumer that is cheaper to edit twice:

| Step | Cluster | New home | Specifiers that change | Why here |
|---:|---|---|---:|---|
| 0 | SUBSTRATE | stays at `lib/` | 0 | freeze — 23 edges in from 19 files plus `server.js` |
| 1 | PIPELINES | `lib/pipelines/` | 6 | 0 co-change with SERVER, WATCH, INSTALL and LANDING |
| 2 | SERVER | `lib/server/` | 11 | `http/` is already a folder; only `server.js` consumes it |
| 3 | INSTALL | `lib/install/` | 13 | RUNS imports `reasoning`, `session-usage`, `model-prices` from it |
| 4 | WATCH | `lib/watch/` | 21 | `scan.js` is the hub; LANDING's nine imports settle after it |
| 5 | LANDING | `lib/landing/` | 27 | widest consumer; WATCH and INSTALL are done, RUNS is not |
| 6 | RUNS | `lib/runs/` | 24 | `jobs.js` moves once, after every cluster it imports from |
| 7 | ASSISTANT | `lib/assistant/` | 11 | last: it imports RUNS, PIPELINES, WATCH, LANDING and SUBSTRATE |

This is a **serial** surface: each step is a path-only landing, `server.js`'s import block is edited
seven times, and step 7 is the one that moves a root file into an existing folder, so it goes alone.
The one parallelism it offers is at the front: **PIPELINES has zero co-change commits with SERVER,
WATCH, INSTALL and LANDING**, so a PIPELINES move can be authored beside any one of them. The other
near-safe pair is **WATCH + LANDING** — 9 import edges but only 4 co-change commits — with LANDING
second, because it is the consumer.

---

## 4. The collisions that survive

The three cuts remove a great deal of collision surface, and these four facts are what is left.

### 4.1 ASSISTANT + RUNS, 17 and 16

| Measure | ASSISTANT + RUNS | Next worst pair |
|---|---:|---|
| Commits touching both clusters | **17** | RUNS + WATCH 10; SERVER + RUNS 9; SERVER + ASSISTANT 9 |
| Hottest module pair across clusters | **`assistant.js` + `jobs.js`, 16** | `project.js` + `scheduler.js`, 9; `activity.js` + `scheduler.js`, 8 |
| Import edges between them | 3 (ASSISTANT → RUNS) | LANDING → WATCH 9 edges, but 4 co-change commits |
| Shared seam | job admission: `queue.js` and `assistant.js` (ASSISTANT), `jobs.js` (RUNS), `server.js` (SERVER) | — |

Recomputed at `92d5fcc`: the window is still **259 commits touching `lib/`**, and the 28-pair matrix is
identical to the lib page's, cell for cell — 17 for ASSISTANT + RUNS, 16 for `assistant.js` +
`jobs.js`. The conclusion holds at this tip.

One correction to the lib page's prose (its §9, first paragraph): **16 is not the highest co-change
pair in the whole tree — 17 is, for `assistant.js` + `assistant/config.js`.** Both files are inside
ASSISTANT, which is exactly what §2 calls the most cohesive cluster, so the argument does not change:
16 is the hottest pair that *crosses a cluster boundary*, and it is the one two agents would collide
on.

### 4.2 Eight `jobs.create` calls across four clusters

Admission is not a module in this tree. It is a path from "a task may start" to "the gateway accepted a
turn", and at `92d5fcc` it is **eight call sites in three files, plus the definition in a fourth**:

| Cluster | Where | What it does |
|---|---|---|
| ASSISTANT | `lib/assistant.js:3733`, `:5778` | the press path: the same gate again, then create |
| LANDING | `lib/features/spawn.js:236`, `:270` | the row's own spawn path calls `create` directly |
| SERVER | `server.js:1270`, `:4393`, `:5365`, `:5497` | four routes, four option sets |
| RUNS | `lib/jobs.js:2375` `async create(opts)` | accepts the turn — **no panel-side concurrency cap** |

The only admission limit in force is the gateway's concurrent-run cap, observed as a 429 and held
(`RETRY_429_DEFAULTS`: 6 attempts, 1.5 s base, 30 s cap, 25% jitter). So a change to "who may start" is
a four-cluster landing today, and the cleanest cut is to move `holdState`, `pickTask` and `staleReason`
into RUNS and leave the queue document and its HTTP adapter in ASSISTANT — the direction ASSISTANT
already imports `jobs.js` in. The lib page's line numbers for the four server calls are at `1e1c595`
(`1183, 4258, 5230, 5362`); at `92d5fcc` they are the four above, because `server.js` grew by 135 lines
and the count did not change.

### 4.3 The four hot files

| File | At `92d5fcc` (`1.5.5`) | At the page's snapshot | What claims it | Why it never stops being hot |
|---|---:|---:|---|---|
| `server.js` | **5,968 lines** | 5,833 @ `e2358c5` | all 13 route cuts; all 7 cluster moves | 54 `lib/` specifiers in one import block, and every route block lives in it |
| `public/app.js` | **22,818 lines**, 1,151 top-level names (879 `window`) | 22,695, 1,140 (874) @ `1e1c595` | all 10 panel cuts | one file holds every renderer and handler; a client module is a cut through its names |
| `lib/jobs.js` | **4,289 lines** | 4,289 @ `1e1c595` | RUNS, and every cluster that calls `create` | changes in one commit out of three; 8 modules and its test import it |
| `public/style.css` | **4,155 lines** | 4,133 @ `1e1c595` | every panel cut that moves markup | 917 classes; 448 appear only in `app.js`, 154 only in `assistant.js` |

These are the four files a row must claim by hand, and the map's §3.1 is the rule that makes the claim
binding.

### 4.4 The hunks no cut removes

- **`server.js`'s mount table** — every extraction inserts at the same place. The deletions merge; that
  hunk does not, which is why the server surface lands one at a time.
- **`public/index.html`'s 782–828 script block** — every panel file adds one line in the same block.
- **`package.json`** — every landing, of any surface, bumps it.
- **cards ↔ console's 13 alternations** — until `board/console.js` lands, those two cuts conflict
  line-by-line even though they are different files.

---

## 5. Which two agents can be started together

Read "yes" as *author in separate worktrees at the same time*; landing is always one at a time (§2).

| Pair of agents | Together? | What they share | Note |
|---|---|---|---|
| server wave 2: pipelines + todos (+ approvals, all three) | **yes** | nothing — disjoint regions, no helper | the widest parallel wave in the tree: 3 agents |
| server wave 4: panel-io + projects | **yes** | one route-only helper each, disjoint regions | 2 agents |
| any server group + the client console cut | **yes** | nothing — `server.js` vs `public/` | best cross-surface pair available today |
| the client console cut + `cards` | **no** | 13 alternations in one section | console first, cards second |
| any two client panels after the console lands | **yes** | one `<script>` line in `index.html` | agree the insertion order |
| any client panel + any `lib/` cluster move | **yes** | nothing — `public/` vs `lib/` | — |
| `lib/` PIPELINES + one of SERVER / INSTALL / LANDING | **yes** | the `server.js` import block only | 0 co-change commits; land one at a time |
| `lib/` WATCH + LANDING | **yes, LANDING second** | 9 import edges, 4 co-change commits | LANDING is the consumer |
| any server group + any `lib/` cluster move | **no** | `server.js` — deletions vs its import block | both edit the file every time |
| `lib/` ASSISTANT + RUNS | **no** | 17 co-change commits; `assistant.js` + `jobs.js` 16 | one change wearing two names |
| `lib/` RUNS + WATCH / SERVER / LANDING | **no** | 10 / 9 / 9 co-change commits | RUNS starts alone |
| any two landings, any surfaces | **no** | `package.json` | the version gate serialises every landing |

So the surface capacities are: **server 3** (wave 2) or **2** (wave 4), one at a time otherwise;
**client 1 until `board/console.js` lands, then 8**; **library 2 at the front** (PIPELINES beside one
other), one at a time from step 3 on, and never ASSISTANT beside RUNS.

The best three-agent start today is **server wave 2 (pipelines, todos, approvals) with the client
console cut**: four agents, four disjoint file sets, four queued landings. Nothing in `lib/` can join
that set — every cluster move edits `server.js`, which wave 2 is already deleting from.

---

## 6. Numbers the three pages disagree on

Each row names the number that wins and the tree it was read from. "This tip" is `92d5fcc` (`1.5.5`).

| Number | One page says | Another says | What wins, and from which tree |
|---|---|---|---|
| `public/app.js` top-level names | **1,052** (`lanes-and-modules.md` §3.1, §6, §10) | **1,140** (`split-public-app.md` §2) | **1,140 at `1e1c595`**: 786 `function` + 88 `async function` + 196 `const` + 70 `let`. 1,052 = 786 + 266, i.e. it counted the synchronous functions and missed the 88 async ones. At this tip: **1,151** (790 / 89 / 199 / 73). |
| ASSISTANT size | **20 modules, 11,818 lines** (map §4.5, a *lane*) | **18 modules, 11,466 lines** (`split-lib.md` §2, a *cluster*) | Both are right in their own unit: the lane also counts `lib/descriptions.js` (235) and `lib/features/descriptions.js` (117), which the cluster table assigns to LANDING. 11,466 + 352 = 11,818, measured at `1e1c595`. |
| `lib/` module count | **88 modules (+ `jobs.test.js`)** (§2) while its §4 tables add to **87** | **88 files that are not the test** (`split-lib.md` §1) | **88 at `1e1c595`** — 87 ESM modules plus `lib/panel-restart.cjs`; `jobs.test.js` is the 89th file and is not a module. 36,449 lines. |
| `assistant.js` + `jobs.js`, "highest pair in the tree" | **highest pair** (`split-lib.md` §9) | measured **16**, while `assistant.js` + `assistant/config.js` is **17** | **16 is the highest *cross-cluster* pair**; 17 is the tree's highest pair and both its files are inside ASSISTANT. Read at `1e1c595` and re-read at this tip: 259 `lib/` commits, same matrix. |
| `server.js` size | **5,833 lines**, 136 conditions, createServer at 2,378 (`split-server.md` §1) | **5,968 lines**, 137 conditions, createServer at 2,465 (this tip) | The page's numbers are `e2358c5` (`1.4.0`). At `92d5fcc` the dispatcher is **137 conditions** (136 `===`, 1 prefix), **138 inline path mentions** across **125 distinct paths**, 141 API paths with the three mounted ones. The added route is `GET /api/changelog` at 2,498, inside `system`'s first region — so `system` is 6 routes at this tip and the 13-group surface is **132 routes + 5 spine**, unchanged in shape. The dispatcher span is 2,483–5,706 (3,224 lines) and the file holds **469** `return sendJson(` sites, against 465 in the blocks at `e2358c5`. |
| Routes per group / total | **131 routes, 2,603 body lines** (`split-server.md` §4) | 132 / 2,645 at this tip | The 131 is `e2358c5`. The delta is the one `/api/changelog` route — 42 body lines, 2,498–2,539 — in `system`. Waves unchanged. |
| `public/app.js` size | **22,695 lines** (`split-public-app.md` masthead, map §3.1) | **22,818** at this tip | 22,695 is `1e1c595`. `public/style.css` likewise: **4,133 → 4,155**. `lib/jobs.js` (4,289) and `lib/assistant.js` (6,596) did not move. |
| Four server `jobs.create` lines | **1183, 4258, 5230, 5362** (`split-lib.md` §4.2) | **1270, 4393, 5365, 5497** at this tip | The *count* is 8 at both trees; `server.js` grew by 135 lines, so the line numbers are the only drift. |

Two numbers the pages agree on and this page re-verified rather than re-quoted: **54** static `lib/`
specifiers in `server.js`, and **136** `route ===` conditions in the dispatch at `e2358c5` (now 136
`===` plus one prefix, i.e. 137).

---

## 7. What this page did not do

- **No code moved.** Every figure is at the tree named beside it; nothing under `server.js`, `lib/`,
  `public/` or `test/` changed.
- **No trial merge.** The collision table is co-change commits plus import edges, not a simulated merge
  of two branches. The lib page says the same of its own numbers.
- **No test run, no boot.** `npm test` (168 files) is the gate for each extraction, not for this page.
- **No judgement about order between surfaces.** It says which pairs can start together; the panel and
  the assistant decide what actually starts.
