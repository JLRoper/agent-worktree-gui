# r1-a — architectural review, top-down by responsibility

Draft A. Read-only: no source file under the worktree was modified. Everything below was measured in this
checkout at `cc61bb9` on `wtgui/architectural-review-top-e7ef6d`. Method is stated per section; where I quote a
number I say how I got it. Section 5 lists what I did **not** measure.

Repo shape at this commit, measured with `wc -l` and a file walk:

| | files | lines |
|---|---:|---:|
| `server.js` | 1 | 5,343 |
| `lib/` | 84 | 32,947 |
| `public/app.js` | 1 | 21,367 |
| `public/assistant.js` | 1 | 4,177 |
| `public/core/` + `public/board/` | 14 | 4,511 |
| `public/style.css` | 1 | 3,761 |
| **JS total** | **101** | **68,345** |
| `test/*.test.js` | 143 | 30,789 |
| `tools/verify-*.mjs` | 120 | — |

Five of the brief's six numbers reproduce exactly (`server.js` 5,343, `lib/assistant.js` 5,192, `public/app.js`
21,367, `public/assistant.js` 4,177, `public/style.css` 3,761); the sixth does not: **`lib/jobs.js` is 3,829
lines, not 3,964.** `lib/` is 84 files, but 73 are top-level and 11 live in `lib/assistant/`, `lib/features/`,
`lib/http/`, `lib/jobs/` — `ls lib | wc -l` reports 73.

---

## 1. The existing modules, as they are today

### 1.1 The process

One Node process, `"type": "module"` (`package.json:5`), **zero runtime dependencies** (`package.json:50`),
no bundler, no build step, no CI. `server.js` is the composition root *and* the HTTP server; `lib/` is a
server-private library; `public/` is a set of classic `<script>` tags with no module system at all.

### 1.2 The server library: 84 files, 32,947 lines, by responsibility

Grouped by what the files do, not by directory (the directories are `assistant/`, `features/`, `http/`,
`jobs/` and are not a taxonomy — `lib/features/` holds two unrelated things). Sizes are `wc -l`.

**STATE / PERSISTENCE — 16 files, 4,734 L.** One versioned JSON document each, one writer each.
`paths.js` 598 (where every file lives — a leaf, imports nothing), `todos.js` 724, `hosts.js` 523,
`locks.js` 383, `parents.js` 367, `projects.js` 345, `model-prices.js` 312, `tree-names.js` 275,
`descriptions.js` 235, `store.js` 219 (in-memory rows + change events), `worktree-naming.js` 207,
`build-version.js` 206, `features/descriptions.js` 117, `sync-state.js` 104, `base-ref.js` 79,
`chart-columns.js` 40.

**ASSISTANT — 18 files, 9,862 L (30% of `lib/`).** The largest single responsibility.
`assistant.js` 5,192 + `lib/assistant/` 11 files 3,389 (`queue.js` 1,259, `messages.js` 515, `config.js` 343,
`read.js` 262, `store-file.js` 187, `audit.js` 182, `actions.js` 151, `landed.js` 143, `charter-file.js` 140,
`profile.js` 131, `match.js` 76) + `charter.js` 265, `roles.js` 222, `task-pipeline.js` 192,
`task-pipeline-assign.js` 189, `assistants.js` 163, `pipeline-window.js` 250.

**RUN PLANE — 15 files, 7,522 L.** Supervising agents on the Hermes Runs API.
`jobs.js` 3,829 + `jobs/console-lines.js` 228 + `jobs.test.js` 449 (a test living inside `lib/`, not `test/`),
`subagents.js` 367, `completion.js` 384, `session-usage.js` 485, `features/spawn.js` 294, `spawn-target.js` 169,
`tool-text.js` 110, `tool-calls.js` 102, `thinking.js` 68, `tool-results.js` 60, `clarify.js` 119,
`approvals.js` 87, `worktrees.js` 771 (the `RELEASE` line a worker writes).

**GIT / SCAN / SCHEDULE — 12 files, 3,622 L.** `scheduler.js` 922, `scan.js` 395 (runs in a worker thread),
`project.js` 395, `pool.js` 131, `scan-worker.js` 12, `activity.js` 535 (four liveness sources),
`rebase.js` 287, `name-from-work.js` 267, `refresh-row.js` 225, `worktree-remove.js` 180, `own-tree.js` 176,
`child-worktree.js` 97.

**PIPELINES / VERIFY — 6 files, 2,149 L.** `pipelines.js` 782 (the definition catalogue),
`steward.js` 470, `pipeline-bundle.js` 391, `merge-prompt.js` 240, `verify-prompt.js` 203,
`verify-landed.js` 63.

**PERMISSIONS / REMOTE — 4 files, 1,679 L.** `gateway-permissions.js` 585, `push-guard.js` 573,
`remote-writes.js` 460, `branch-policy.js` 61.

**HTTP / TRANSPORT — 7 files, 1,751 L.** `restart.js` 1,196 (the third-largest file in `lib/`, after
`assistant.js` and `jobs.js` — a gateway/panel restart controller with a health wait, not transport at all),
`attachments.js` 174,
`http/transport.js` 169, `http/static.js` 76, `port-guard.js` 71, `open-url.js` 46, `errors.js` 19.

**HERMES GATEWAY CLIENT — 6 files, 1,628 L.** `skills.js` 531, `hermes-config.js` 452, `hermes-models.js` 286,
`hermes-worktrees.js` 214, `hermes-runtime.js` 120, `reasoning.js` 25.

What this grouping shows: `lib/` is **not** a flat pile of helpers, it is eight responsibilities with a
reasonable spread — except that the assistant (30%) and the run plane (23%) are more than half of it, and both
are single-class monoliths (`Assistant` 4,968 L in one class, `Jobs` 3,414 L in one class) surrounded by a
correctly-factored halo of small modules. `lib/assistant/*` is a clean DAG with `read.js` and `config.js` as
leaves; the extraction into it worked. The class did not shrink.

### 1.3 The import direction that exists

Parsed every `import ... from` / `export ... from` / `import()` in `server.js` + all 84 `lib/` files and resolved
every specifier to a file: **187 edges land on a module in the tree, 0 fail to resolve, and every remaining
specifier is a `node:` builtin.** (Two import lines carry two statements each — `server.js:45`, `lib/jobs.js:52` —
which a line-anchored parser silently drops; the first of those is a real internal edge, so the count is 187 and
not 186.)

- **85 modules, 187 internal edges, 0 import cycles, longest chain 6** (`server.js` → 6 deep).
- **29 modules are leaves** — they import nothing internal, 7,558 lines between them, including
  `paths.js` 598, `pipelines.js` 782, `todos.js` 724, `push-guard.js` 573, `hosts.js` 523, `remote-writes.js` 460,
  `pipeline-bundle.js` 391, `tree-names.js` 275, `read.js` 262.
- The graph is narrow at the top, wide at the bottom. Highest in-degree: `scan.js` 12 importers,
  `assistant/read.js` 9, `tree-names.js` 8, `jobs.js` 8, `hermes-runtime.js` 7, `own-tree.js` 7, `paths.js` 6,
  `hermes-config.js` 6. Highest fan-out: `server.js` 54, `assistant.js` 21, `jobs.js` 16, `hermes-models.js` 5,
  `restart.js` 5, `scheduler.js` 5.

So the *server-side* direction today is already correct and disciplined: dependencies point down into a leaf
layer, there is no cycle to break, and the only module with a wide fan-out is the composition root, which is
where a wide fan-out belongs.

**Two edges violate the direction, deliberately.** `server.js:92` and `lib/jobs.js:60` both do
`import "../public/core/steerable.js"` — server code importing a **browser** file for its `globalThis.wtSteerable`
side effect, then destructuring it (`server.js:94`):

```js
// The steer refusal's own vocabulary: the page draws its control from this same file, so the route's status split
// and the card's button can never disagree about which of the three refusals happened.
import "./public/core/steerable.js";
const { PARKED: STEER_PARKED, PAST_BOUNDARY: STEER_PAST_BOUNDARY, GONE: STEER_GONE } = globalThis.wtSteerable;
```

That is the only `lib/` → `public/` edge in the repo, it is two lines, and the comment says why (one vocabulary,
two processes). Any "clean" layering rule has to either allow this one file or move `steerable.js` into a
shared directory — it is 82 lines (`public/core/steerable.js`) and is loaded by `index.html:717` as a classic
script as well, so moving it is a 3-line change in 3 places, not a refactor.

### 1.4 The client: 16 classic scripts, 30,055 lines, and a boundary that does not exist

`public/index.html:689-694` states the constraint in the file:

> The client is a set of classic scripts, not modules: there is no bundler in this repo, and
> `public/assistant.js` reads app.js's own globals by name (`esc`, `conversations`, `conversationHtml`), so an
> ES-module split is not available to us. Order therefore matters and is read bottom-up …

Measured:

- 16 `<script src>` tags in a fixed order (`public/index.html:695-736`), 13 of them before `app.js`, exactly two
  after it (`core/update-check.js:733`, `assistant.js:736`).
- `public/app.js` declares **1,080 top-level names** — 829 `function`, 251 `const`/`let` — and publishes
  **none** of them: there is not one `window.X =` or `globalThis.X =` in the file. Every name is a page global
  by virtue of being a top-level declaration in a classic script.
- The other direction is just as wide: `public/assistant.js` reads **34** of app.js's names, `core/sse.js` reads
  **22**, `board/hot.js` 9, `core/update-check.js` 5, `board/paste-chips.js` 4, `core/dom-format.js` 4,
  `core/transport.js` 3, `board/attachments.js` 2.
- `public/assistant.js` is a single **IIFE** (`(() => {` at line 10) with exactly **three** globals:
  `window.applyAssistant` (`:4167`), `window.__assistantRenderChat` (`:4169`), `window.__assistantToggle`
  (`:4173`). Two of the three are test hooks. app.js calls `applyAssistant` from two places (`:6275`, `:15187`).

**The namespace convention exists and is not used.** Eight modules publish an additive object —
`window.WMApp.core.<name>` / `window.WMApp.board.<name>` (`dom-format.js:176`, `console-format.js:734`,
`console-markdown.js:442`, `sse.js:250`, `transport.js:116`, `attachments.js:146`, `hot.js:214`,
`paste-chips.js:760`) — and six publish a single global (`wtLive`, `wtStream`, `wtType`, `wtSteerable`,
`wtUpdateCheck`, `ModelMenu`). But the binding surface is still the bare name, and the file says so itself:

```js
// Published for the later steps of the split, which reach a module through this object instead of
// through a new global. Nothing reads it yet: app.js still calls the bare names above.
window.WMApp.core.domFormat = { $, keyOf, esc, … };            // public/core/dom-format.js:177-179
```

The count backs it: **913 bare `esc(` call sites** (627 in `app.js`, 286 in `assistant.js`) against
**one** reader of `WMApp.core.domFormat` in the whole tree. The namespace is a promise the code has not kept.
That matters for planning: the seam already exists as a *convention*, and adopting it is a mechanical change to
call sites, not a redesign.

### 1.5 The test surface is a real architectural constraint, not a footnote

- `npm test` at this commit: **1,165 tests, 1,165 pass, 0 fail, 148 s.** I ran it. (The suite grew from the
  "70 files, 524 declarations" in `docs/architecture.md:625` to 143 files and 1,165 tests.)
- **14 test files slice `public/app.js` by its `// ---- name` markers**, through
  `tools/panel-testkit.mjs:301` `sliceRegion(src, name, endName)` — `src.indexOf("// ---- " + name)` … to
  `// ---- end <name>`. Seven more slice `public/assistant.js` the same way (one file does both), so 21 files
  slice source text overall, and one `tools/*.mjs` does it too.
- 40 test files use `vm`, `new Function` or `eval` to run a browser file in a sandbox; the browser modules are
  loaded by `await import("../public/core/liveness.js")` (`test/liveness.test.js:16`) because the file's only
  effect is to hang an object on `globalThis`.

Consequence: **the section markers are an API.** They are read as text ranges by 21 files (14 for `app.js`, 7 for
`assistant.js`). A section may be
moved to another file only if its marker text travels with it, and a marker that is a `// ---- end` closer is
*not* a boundary — 26 of `app.js`'s 141 markers are closers, and several are followed by more code of the same
concern. Treating a closer as an end is how a slice silently loses code.

---

## 2. The six oversized files: where they can be cut

For each seam I name **what moves**, **what stays**, and **the new boundary's public surface** (the names that
must remain reachable). "Surface" is measured: the count of names *defined in the range and read outside it*
(static scan of top-level declarations against every identifier use, `app.js` only).

### 2.1 `public/app.js` — 21,367 L, 1,080 top-level names, 141 markers, 54 `addEventListener("click"` sites, 8 of them on `document`, 56 `localStorage` keys

There are **no natural seams to discover**: I built the symbol reference graph (2,682 symbol→symbol edges) and
the whole file is **one weakly-connected component** — 1,079 of 1,080 top-level declarations are mutually
reachable from every other. Nothing is orphaned and nothing is isolated. Every boundary is therefore a *cut
through references*, and only its price differs.

The price has two components, and the second one is the one that bites:

1. **Surface width** — how many of the moved names are read from outside.
2. **Load-time executability** — classic scripts run their top level at load. A region that reads `state`, calls
   `$()`, or starts a timer *at top level* cannot be moved **before** `app.js`, because `app.js` declares
   `state` at `:55` and every region after it assumes that. The file writes its top-level code at column 0, so
   this is countable and checkable by eye: **222 top-level statements** outside any function body across all
   21,367 lines. This is why the head of the file carries its TDZ warnings:

   > Declared BEFORE `state`: it is read while the state literal below is built, and a `const` further down the
   > file would still be in its temporal dead zone at that moment … (`public/app.js:6-8`)
   > … the try/catch in the loader swallowed the error and every reload came back with the agent's title
   > instead of the name that was typed. (`public/app.js:28-30`)

   So the client has a **two-phase** load contract, and `index.html` only has two "after" slots. A region with
   load-time `state` writes must move *after* `app.js` (a fourth phase) or take `state` as an argument.

Measured candidate cuts, in order of **lines moved per exported name** (higher is a cheaper boundary). The last
two columns are the load-time question — they separate *cannot* move from *should not* move:

| # | Range (`app.js`) | What the region is | Lines | Decls | Surface | Lines/surface | Top-level stmts at load | of which `state` writes |
|---|---|---|---:|---:|---:|---:|---:|---:|
| A1 | 18320–21283 | settings surfaces + fold state | 2,964 | 169 | **9** | **329** | 96 | **0** |
| A2 | 11551–15260 | chart cells, age column, ranking, anchor | 3,710 | 197 | 58 | 64 | **3** | 0 |
| A3 | 1517–5084 | conversations, turn body, question box | 3,568 | 177 | 69 | 52 | 12 | 7 |
| A4 | 7190–8355 | console render + writers + copy | 1,166 | 80 | 35 | 33 | 14 | **12** |
| A5 | 6622–7190 | dock: approvals + remote writes | 569 | 29 | 14 | 41 | 5 | 4 |
| A6 | 9716–9975 | model picker | 260 | 15 | 11 | 24 | **0** | 0 |

Read the table down the last two columns: **A1 is cheap to export and expensive to load** (9 names, but 96
top-level statements at `:20,357-21,278` wiring every settings control to a handler at boot); **A4 and A5 are the
opposite** (35 and 14 names, but 12 and 4 of their few top-level statements *write* `state` — they are
initializers disguised as renderers); **A2 is nearly pure at load** (3 statements, 0 state writes) and is still
the worst cut, because its problem is dependencies, not load order; **A6 is the only region with neither
problem**, and it is 1.2% of the file.

**A1 — settings surfaces (18,320–21,283), the cheap one.** Moves: the `paint*` and `apply*` pairs for fonts,
text styles, panel contrast, settings tabs, settings search, the Skills tab, Permissions tab, Settings > Pipeline,
the settings window, provider endpoint, model-menu prices, approval window, reorder cadence, chart columns,
agent cleanup, age cutoff, collapse cascade, chart columns, remote-branch policy, the panel's two folders, and the
anchor's two signals. **Public surface is 9 names**: `paintAgeSetting`, `paintAgentCleanup`, `paintAnchorSettings`,
`paintChartColumns`, `paintCollapseAfterSetting`, `paintPaths`, `paintRemotePolicy`, `refreshRemoteGuards`,
`toggleSettings`. **What stays:** the **96** top-level statements at `:20,357-21,278` — `$("…")?.addEventListener(…)`
for every control, `initSettingsTabs()`, `initSettingsSearch()`, `initSettingsWindow()`, `void loadSkills()`,
`void loadPermissions()`, `void loadPipelines()` — they are boot wiring that must run after `app.js` and after the
DOM exists, and the `state` keys the painters read. **Caveat:** the region
reads **73** outer names (`state`×69, `showBanner`×17, `reorder`×8, `applyQLook`×7, `CHART_COLUMNS`×7, …), so the
module's header would be the longest "what it reaches out for" list in `public/`. That is a documentation cost,
not a correctness cost — and it is exactly the pattern `core/dom-format.js:20-26` already established.

**A2 — chart / ranking (11,551–15,260).** The **worst** cut despite being the second-cheapest by ratio: 58
exported names and **76** outer dependencies, including the whole DOM-move protocol (`endDomMove`×8,
`releaseScrolls`×8, `restoreTyping`×7, `beginDomMove`×7, `captureTyping`×6, `restoreAddAgent`×6, `holdScrolls`×6,
`captureCardSelection`×6, `restoreCardSelection`×6). Nine of the ten heaviest dependencies are the scroll/caret
preservation dance. A chart module that must call nine scroll functions is not a module; it is the same file with
a longer relative path. **Do not cut this first.** If it is cut at all, cut it *after* the scroll protocol itself
(`beginDomMove`/`endDomMove`/`captureTyping`/`restoreTyping`/`holdScrolls`/`releaseScrolls`, today spread across
`app.js:8808-8877` and used from everywhere) has been extracted as one unit with one public surface.

**A3 — conversations (1,517–5,084).** 69 names out, 37 in, and the heaviest single outer dependency in the file:
`state` at **130** references. Moves: `conversationHtml` (287 L), the turn body, `groupLines` (77 L),
`toolGroupHtml` (338 L), the tool-group key, the subagent roster, the 429 held-turn block, the `clarify` question
box and its look. Public surface includes `conversationHtml`, `conversations`, `captureTyping`, `expandToolFold`,
`collectThread`, `answerRunQuestion`, plus 7 constants that are read by `lib/`-facing code paths
(`REPLY_MAX_LINES`, `SPAWN_MAX_LINES`, `TURNS_PER_PAGE`, `AUTO_COLLECT_KEY`, …). This is the region
`public/assistant.js` reaches into most (34 names, most of them here), so cutting it changes the assistant's
contract too.

**A4 — console (7,190–8,355).** 35 surface names, 17 dependencies, and **12 top-level `state` writes out of 14
statements** — six `state.think*` initializers at `:7195-7200`, then the pacer wiring itself:
`state.typePacer = globalThis.wtType…` at `:7367`, `state.typeGate` at `:7370`, `state.typeHold` at `:7451`.
That is the clearest evidence in the file that this region and `core/type-stream.js` are one unit at load time.
It owns the type pacer and the line gate,
which `core/type-stream.js` already provides (`wtType`), so the seam is real: the renderer would call
`wtType` and `core/console-format.js` instead of reaching backwards. But it is the most-observed surface in the
product and the thing 14 test files slice.

**A5 — dock (6,622–7,190).** 14 names, 5 load-time statements — of which four are `state.rw* = state.rw … || new Map()`
at `:6682-6685`, i.e. it mutates `state` at load. It is small and coherent (approvals + remote-write permission
box share one dock), and `lib/approvals.js` + `lib/remote-writes.js` already own the server half. Good third or
fourth cut: cheap, and the public surface is a genuine vocabulary (`approvalKey`, `answerApproval`,
`applyApprovalsFold`, `applyRemoteWrites`) rather than a grab-bag of helpers.

**A6 — model picker (9,716–9,975).** The only region with **zero** load-time execution: it is 260 lines of pure
declarations, movable before `app.js` with no TDZ risk at all. 11 names, 5 dependencies. It is also the smallest
and the least valuable — which is the trap: it is the *safest* cut in the file and it removes 1.2% of it.

### 2.2 `public/assistant.js` — 4,177 L, 32 sections, one IIFE, 3 globals

This is the **cheapest real boundary on the client**, for one structural reason: the whole file is already
private. A split cannot leak a new global unless you make one, and only three names have to survive
(`applyAssistant`, `__assistantRenderChat`, `__assistantToggle`, `:4167-4173`).

Sections, measured by their own `  // ---- ` markers:

| Range | Section | Lines |
|---|---|---:|
| 21–539 | the float, its two rows, the dock width, which frame is on screen | 519 |
| 540–631 | what arrives from the server | 92 |
| 632–854 | the spawn strip | 223 |
| 855–945 | chat: the assistant as one of the agents | 91 |
| 946–1,147 | alerts | 202 |
| 1,148–1,273 | watches + scratchpad | 126 |
| 1,274–1,470 | the message board | 197 |
| 1,471–1,623 | the role and its charter | 153 |
| 1,624–1,982 | settings | 359 |
| 1,983–2,714 | the queue sub-tab (row order, the hold, the ask, one agent per task, drag, edge scroll) | 732 |
| 2,717–3,174 | the task pipeline window | 458 |
| 3,177–3,234 | talking to the server | 58 |
| 3,235–3,845 | **wiring** | 611 |
| 3,846–3,965 | the queue's controls and drag | 120 |
| 3,966–4,149 | the frame's gestures, keys | 184 |
| 4,150–4,178 | boot | 29 |

**Seams, best first.** (1) *The task pipeline window* 2,717–3,174, 458 L — a self-contained renderer whose only
server route is `createPipelineWindowRoutes`; it is the single most separable block in the file. (2) *The queue
sub-tab* 1,983–2,714, 732 L — one responsibility, one route family (`/api/assistant/queue*`), already backed by
`lib/assistant/queue.js`. (3) *The message board* 1,274–1,470, 197 L, backed by `lib/assistant/messages.js`.
(4) *Alerts + watches + scratchpad* 946–1,273, 328 L. (5) *The settings block* 1,624–1,982, 359 L.

**What stays:** the frame (float vs dock, 21–539), the boot sequence, and the wiring at 3,235–3,845 — that block
is 611 lines of `$("...").addEventListener(...)` and `applyAssistant` fan-out, it is the file's composition root,
and it is the last thing that should move. **Public surface:** the three globals plus an internal seam object —
if the sections are split without a namespace, each becomes a new page global, which raises the count of names
`app.js` can accidentally depend on. The honest boundary is one internal object,
`window.WMApp.board.assistant = { … }`, which is exactly the convention `board/hot.js:214-217` already uses.

### 2.3 `lib/assistant.js` — 5,192 L, one `class Assistant`, 147 methods, 4,968 L

The class spans `:225` to the end of the file. Its own 19 section markers are **not a reliable map**: the section
labelled `// ---- one assistant's task queue` (`:685`) is 1,018 lines and holds the queue *and* the assistant
registry, the ownership resolution (`ownerOfTree` `:1186`, `assistantIdForJob` `:1214`), the roster, the per-
assistant settings, the charter accessors and `createAssistant`. A reader trusting the banner will mis-plan.
`lib/assistant/queue.js` already owns the queue's schema, caps and transitions (1,259 L) — so the 1,018-line
section is the *host* half, not a second implementation.

Seams, with the `this.` fields each depends on (counted, not guessed):

**S1 — the rule engine. `evaluate` (`:2170-2622`, 453 L) + `fired` (73) + `checkWatches` (91) + `checkExit` (57)
= 674 L.** It reads 12 fields (`settings, rules, fired, alerts, jobs, journalAdd, persist, emit, getRows,
getChildren, isAssistantThread, checkExit`) and is a pure decision over *(live jobs, settings, rules) → alerts*.
`lib/assistant/config.js` already owns the rule table, `lib/assistant/match.js` (76 L) the matching,
`lib/assistant/read.js` (262 L) the facts. **Moves:** the decision. **Stays:** the timer that calls it, the
journal, the emit. **Surface:** one function `evaluate(list, now, ctx)`. This is the highest-value cut in
`lib/` because it is the only place the assistant *decides* anything, and it is 100% testable without a clock,
a file or a gateway.

**S2 — the spawn machinery. `:3,987-4,698` = 712 L** (`spawn debt` 67, `replay a boot must NOT make` 154,
`the files a SPAWN line hands on` 268, `spawn watchdog` 223) plus `startSpawn` (123) and `checkSpawns` (105).
Fields: `spawnIntents, spawnTimers, spawner, alerts, attachmentsDir, locks, resolveProject, persist, emit`.
**Moves:** everything that turns a `SPAWN` line into a job. **Stays:** the turn loop that produced the line.
**Surface:** `startSpawn(origin, spec)`, `checkSpawns(now)`, `spawnInheritance(files)`, and the intent record.
`lib/features/spawn.js` (294 L) and `lib/spawn-target.js` (169 L) already own the two halves of this — the class
holds the third.

**S3 — the assistant thread / turn loop. `:2,942-3,777` = 836 L** (preamble 101, digest 86, say 50, the turn
machinery, 250 lines of TODO-line parsing). **Moves:** composing the prompt and parsing what comes back.
**Stays:** the queue drain and the settle notices. **Surface:** `preamble(id, why)`, `digest(id)`, `say(text)`,
`parseTurn(text)` → actions. Note this is the seam with the most cross-talk with S1 (the turn's output is the
rule engine's input), so S1 must land first.

**S4 — the registry + queue host. `:685-1,702` = 1,018 L.** Moves into `lib/assistant/registry.js` +
`lib/assistant/queue-host.js`, constructed with `{file-of, journal, persist, emit, jobs}`. **Surface:** ~40
methods the class currently calls as `this.x(...)`; keeping thin delegating wrappers means the call sites do not
move. This is the mechanical, low-risk cut — and the largest line count in the file.

**S5 — the persistence fields. `load` (45) + `persist` + `aggressive` (165) = ~250 L.** *Not* a duplicate of
`store-file.js`: `load()` already delegates the file shape to `readAssistantFile` and keeps only "apply the
record to the fields" (`:390-398`, and the comment at `:391-393` explains the split). Moving it means moving the
field set, so it is only worth doing *after* S4 has already carved the field set into pieces.

### 2.4 `lib/jobs.js` — 3,829 L, one `class Jobs`, 114 methods, 3,414 L, 11 exported functions/consts + 3 export lists

Same shape as `Assistant`, different responsibility split: it is a **run state machine** with an **HTTP client**
grown through it. Its 20 markers are more honest than `assistant.js`'s.

**J1 — the gateway transport (the biggest win).** `create` (`:1940-2386`, 447 L), `consume` (`:2525-2710`,
186 L), `streamOnce` (41), `stopRunAtGateway` (32), and the 429/backpressure block (`:158-230`, 73 L, exported
as `retry429Settings`/`retryAfterMs`/`retry429DelayMs`/`fmtWait`). Total ~**780 L of method + 73 L of pure
retry policy**. `create` alone touches 28 `this.` fields (`api, headers, config, jobs, modelFor, parentBranchFor,
makeWorktree, probe, poll, follow, stop, terminate, summary, todos, transport, …`) because it does five things:
validate, cut a worktree, POST, absorb 429, register the run. **Moves:** the POST and the 429 absorption, as
`postRun(spec, ctx)`. **Stays:** the state machine that then follows the run. **Surface:** `create(spec)` keeps
its signature; the new module exports `postRun` + the four retry functions (already exported and already tested).

**J2 — persistence. `:637-1,307` = 671 L** (`schedulePersist` 78, `load` 47, the v1→v4 migrations, `KEEP_JOBS`
cap, `revive` 67). **Moves:** the file format, the caps, the debounce. **Stays:** the in-memory `jobs` map.
**Surface:** `load()`, `schedulePersist()`, `writeNow()`. This is the same shape as
`lib/assistant/store-file.js` and should be named the same way — today the repo has five "one JSON doc, one
writer" implementations and only some are named `*-file.js`.

**J3 — artifacts + worktree. `:1,308-1,718` = 411 L** (`measureTree` 156, `repointPath` 62, `sweepArtifacts` 66).
**Moves:** measuring a tree, sweeping a run's produced files, re-pointing a path after a rename. **Stays:** the
job record. **Surface:** `measureTree(job)`, `repointPath(job, path)`, `sweepArtifacts(keep)`.

**J4 — steering / stopping. `:3,286-3,671` = 386 L** (`approve` 108, `steer` 89, `answerQuestion` 60,
`controlContext` 37, `steerable`). **Moves:** the three control verbs. **Stays:** the run's status. **Surface:**
`approve`, `steer`, `answerQuestion`, `controlContext`. Note this is the module that shares a vocabulary with
`public/core/steerable.js` — the very file `lib/jobs.js:60` imports — so extracting it does not add coupling, it
*names* coupling that already exists.

### 2.5 `server.js` — 5,343 L, 113 routes, 123 branches, 3,215 lines of branch bodies in one 3,233-line callback

Measured split: lines **1–2,057** are imports (54 internal edges), config load, the object graph
(`new Store`, `new TreeNames`, `new Hosts`, `new Pipelines`, `new Jobs` `:475`, `new Approvals` `:543`,
`new Assistant` `:759`, `new RestartController`), `broadcast` (`:415`), and **44 helper functions**. Lines
**2,058–5,290** are one `createServer(async (req, res) => {` whose body is 123 sequential
`if (route === "…")` branches — 3,215 of its 3,233 lines are branch bodies. There is no table, no router, no
shared middleware: the dispatcher *is* the application.

**The seam is already proven in this file, three times.** `createQueueRoutes` (`lib/assistant/queue.js:1188`),
`createPipelineWindowRoutes` (`lib/pipeline-window.js`) and `createPipelineCatalogueRoutes` are factories that
take `{ assistant, config, sendJson, readBody, authorised }` and return
`async (req, res, route, url) => boolean`; `server.js:2068-2074` mounts them in three lines. The factory's own
comment states the contract:

> The transport helpers travel in from the composition root rather than being imported here: this module then owns
> no HTTP knowledge at all, and a test can drive the handler with stubs and a real Assistant over a temp directory.
> (`lib/assistant/queue.js:1190-1194`)

So the server seams are not a design question — they are a **migration** of 72 remaining branches onto an idiom
that already exists. Measured groups (branches, branch-body lines; the eight groups below hold 75 of the 123
branches, and 3 of those 75 already run through a factory):

| Seam | Routes | Lines | Notes |
|---|---:|---:|---|
| `lib/routes/worktree.js` | 13 | 820 | merge 147, rebase 87, pipeline 87, verify-landed 87, child 84, transfer 67, lock 57, suggest-name 51, rollup 44 … |
| `lib/routes/settings.js` | 14 | 274 | sessions, skills, permissions, pipelines GET/PUT, approvals, provider, models, models/refresh |
| `lib/routes/remote-write.js` | 8 | 243 | request 55, unwind 55, guard 46 — one vocabulary, one box |
| `lib/routes/jobs.js` | 11 | 184 | the run plane's read surface |
| `lib/routes/assistant.js` | 23 | 293 | the largest group; the queue's own routes are already a factory, so the idiom is proven on this prefix |
| `lib/http/stream.js` | 1 | 199 | **`/api/stream` — the single largest branch.** SSE fan-out, belongs with `http/transport.js`, not with a verb |
| `lib/routes/pipelines.js` | 2 | 89 | |
| `lib/routes/refresh.js` | 3 | 172 | row re-read 132 |
| (left in `server.js`) | 48 | ~940 | `state`, `stream` bootstrap, reload, static, the boot pass, `/api/visible`, `/api/stats`, health |

**What stays in `server.js`:** the process (config load, `loadConfig`/`patchPanelConfig`, the state migration
`migrateState`, `ensureDirs`), the object graph, `broadcast`, the `bootPass` promise, the auth/method guard, the
static/SSE entry, and `shutdown`. That is the composition root — roughly the 2,057 lines it already has, minus
the 44 helpers that belong in `lib/` anyway. **Public surface of each factory:** the boolean-returning handler,
nothing else; deps are named arguments on one line, which is the property that makes the three existing ones
testable.

The one caution: `authorised` is called once (`server.js:2061`) *before* the chain, and the POST guard is
`if (req.method === "POST" && route !== "/api/reload")`. A factory must not re-implement auth; it must receive
`authorised` as it already does, or the 30 POST routes will drift apart.

### 2.6 `public/style.css` — 3,761 L, 1,615 blocks, 835 distinct classes, 61 custom properties

Measured: **0 `@layer`**, **2 `!important`**, **24 selectors declared more than once** (`:root` twice, `td.age`,
`tbody tr.row`, `.turn-head`, `.wt-age-toggle`, `.subagents .sub-row`, `tr.row-confirm .rc-actions`, …). Those 24
are order-dependent overrides, so the cascade is load-bearing and a split that reorders sections silently changes
paint.

**Ownership is measurable**: of the 835 classes, 484 appear only in `app.js`, **152 only in `assistant.js`**
(and they are all `as-*` prefixed), 82 in both, 17 only in `index.html`, and 100 in none of the three. Before
calling those 100 dead: `class="${…}"` composition is used, so a literal-string search under-reports. I
spot-checked seven by hand — `chip-x`, `codelist`, `df-win`, `code-delta`, `fold-read`, `drop-target` appear
nowhere at all (dead), `btn-steer` appears once. So some of the 100 are certainly dead, not all.

Seams:

- **`public/assistant.css`** — the 152 assistant-only classes (all `as-*`). Their rules are already almost
  contiguous: of 248 `as-*` rule lines, **247 sit between `style.css:3,000` and `3,743`** and exactly one is
  elsewhere (`:1,722`, a model trigger inside the assistant group). The block covers the spawn strip
  (3,180–3,545) and the task pipeline window (3,546–3,693) plus their neighbours.
  **Moves:** every rule whose selector is `as-*` only. **Stays:** anything shared (82 classes appear in both
  files — those are the `panel`, `card`, `console`, `chip` primitives the assistant reuses). **Surface:** the
  `as-` prefix, which is already a namespace and which `public/assistant.js` uses exclusively (182 distinct
  `as-` names). This is the cleanest CSS seam in the repo and the only one with a written prefix contract.
- **`public/console.css`** — 1,291–2,027, **737 L** (the console's markdown prose + raw/focus views) plus
  1,178–1,290 (hover copy) and 2,028–2,260 (pasted chips). 737 lines is 20% of the sheet in one coherent block.
- **The chart** — 2,699–3,143, 445 L, is *not* separable: it depends on the 24 duplicated selectors
  (`td.age` is declared at two places) and on the column-width custom properties set from JS.
- **`@layer` is the missing tool.** With 0 layers and 2 `!important`, the only safe split order is "same order,
  different file". Introducing `@layer base, board, console, assistant;` would let the split be order-free, but
  it changes specificity for the 24 duplicate selectors — that is a separate, testable change and should not be
  bundled with a move.

---

## 3. The dependency direction the result must obey

### 3.1 The rule

```
node: builtins
   ↑
lib/<leaf>            paths, pipelines, todos, push-guard, hosts, remote-writes, read, config …
   ↑
lib/<mid>             store, scan, scheduler, tree-names, jobs, assistant
   ↑
server.js             the composition root: builds the object graph, owns the HTTP entry
```

- **`lib/` may import `lib/` downward only.** No `lib/` file may import `server.js` (true today: 0 edges).
- **Exactly one `lib/` → `public/` edge is allowed**, `public/core/steerable.js`, because two processes must
  share one refusal vocabulary (`server.js:90-94`, `lib/jobs.js:60`). If a second one appears, the rule is
  broken; today the count is 2 lines in 2 files and both are the same file.
- **`public/` may never import `lib/` or `server.js`** (true today: 0 edges). The client is a static asset; it
  learns everything through `/api/*` and the SSE stream.
- **A route factory may not import another route factory**, and neither may import `server.js`. It receives
  `sendJson`, `readBody`, `authorised` — never a copy.
- **On the client, "import" is load order**, and the rule is: *a module loaded before `app.js` may read an
  `app.js` name only inside a function that runs after boot.* That is the actual invariant behind the
  "WHAT IT STILL REACHES OUT FOR … at call time" header in every `public/core/` file.

### 3.2 The cycles that exist today

**No import cycle exists on the server.** 187 edges, 0 cycles, verified by DFS colouring, and the two
one-line anomalies (`;import` on `server.js:45` / `lib/jobs.js:52`) are both resolved. That is worth saying
plainly because the brief asks for cycles: on the server there are none, and the extraction work is therefore
*not* a cycle-breaking exercise.

What exists is four **runtime** couplings that no import graph shows:

1. **The client script cycle.** `app.js` ↔ `public/core/*` is a genuine cycle in the only sense the page has:
   `app.js` reads 14 names from `dom-format`, 4 from `console-format`, 9 from `console-markdown`, 11 from
   `paste-chips`, 6 from `attachments`, 5 from `hot`, 3 from `transport`, 2 from `sse`; and those same files read
   names back out of `app.js` (4 in `core/dom-format.js` — `normPath` at `:38`, `panelFor` at `:94`, `isRowLive`
   at `:95`, `state` at `:112`; 22 in `core/sse.js:65-137`; 9 in `board/hot.js:32-129`; 3 in
   `core/transport.js:77-112`; 5 in `core/update-check.js`; 34 in `public/assistant.js`; 2 in
   `board/attachments.js`; 4 in `board/paste-chips.js`). **The load order is the cycle-breaker**, and it works
   only because every back-edge is a call-time read. `core/dom-format.js:20-26` documents exactly this and lists
   its three back-edges by name.
2. **The construction cycle.** `new Jobs({onEvent: broadcast})` (`server.js:475`) → `new Assistant({jobs, onEvent:
   broadcast, onRestart})` (`server.js:759`) → `Assistant` calls `jobs.list()`/`jobs.create()` (11 distinct Jobs
   methods) → `Jobs` calls `onEvent` → `broadcast` → SSE. It is broken by dependency injection at the composition
   root, which is correct and must be preserved: **no `lib/` module may import a `broadcast`.**
3. **The `state` singleton.** One 264-line object literal (`app.js:55-318`) read by all 1,080 declarations and by
   every extracted client module. It is not a cycle, it is the reason every client seam is leaky, and it is why
   `dom-format.js` had to become non-leaf.
4. **The `steerable` vocabulary.** `public/core/steerable.js` is imported by both `server.js` and `lib/jobs.js` and
   loaded by `index.html:717`. It is the one file that lives in both processes, and that is by design.

---

## 4. Extraction order

Ordered by **blast radius × revertability**, not by size. The first four steps are Node modules: a mistake is an
`ERR_MODULE_NOT_FOUND` or a failing test, caught in seconds. The last three are classic scripts, where a mistake
is a runtime `ReferenceError` in a browser that no unit test will see.

| Step | Cut | Lines | Why here | Proof it did not break |
|---|---|---:|---|---|
| 1 | `lib/jobs.js` → `lib/jobs/gateway.js` (J1: `postRun` + the 429 policy) | ~850 | Pure move of already-exported retry policy + one method; no state moves | `test/run-stream.test.js`, `lib/jobs.test.js`, the 1,165-test suite |
| 2 | `lib/assistant.js` → `lib/assistant/rules-engine.js` (S1: `evaluate`/`fired`/`checkWatches`/`checkExit`) | 674 | The decision, made pure. Highest value per line in the repo | the 8 `test/assistant-*.test.js` files (`-profile`, `-digest`, `-preamble`, `-event-wakes`, `-queue`) |
| 3 | `lib/assistant.js` → `lib/assistant/queue-host.js` + `registry.js` (S4) | 1,018 | Biggest single block; delegating wrappers keep call sites | `test/assistant-queue.test.js`, `test/queue-holds.test.js` |
| 4 | `server.js` → `lib/routes/worktree.js` then `remote-write.js`, `settings.js`, `jobs.js`, `assistant.js` (2.5) | 820 → 243 → 274 → 184 → 293 | The idiom exists 3× already; one factory per PR | `test/*-http.test.js`, `tools/panel-testkit.mjs` boots the real server |
| 5 | `public/assistant.js` → `public/features/assistant/pipeline-window.js`, `queue-tab.js`, `messages.js` (2.2) | 458 / 732 / 197 | Already private; only 3 globals must survive | `test/settings-tabs.test.js`, the 7 files that `sliceRegion` this file |
| 6 | `public/style.css` → `public/assistant.css` (the `as-*` block) | ~600 | Prefix contract already exists; 247 of 248 `as-*` rule lines are already adjacent | visual + `test/text-styles.test.js`, `test/console-*.test.js` |
| 7 | `public/app.js` → A1 settings, then A5 dock, then A4 console, then A3 conversations, then A2 chart | 2,964 / 569 / 1,166 / 3,568 / 3,710 | See below | the 14 slice-by-marker tests; each marker must travel |

**Step 0, before any of them:** the section markers must become honest. 141 markers in `app.js`, 26 of them
`// ---- end` closers, and at least ten closers are followed by code of the same concern — so the marker text is
an API (14 test files read it) with no guarantee that "end" means end. A comment-only PR that adds the missing
`sections`/`end` pairs is the cheapest possible first landing and it is what makes step 7 reversible.

### The riskiest first cut, named honestly

**The riskiest cut in this repo is `public/app.js` 7,190–8,355 — the console renderer — and it is the cut a
reasonable person makes first, because it is near the top of the biggest file and it looks like a renderer.**

Why it is the worst one:

- **35 public names** and 17 outer dependencies is a middling surface, but the region *mutates `state` at load*:
  `state.thinkCache/thinkOpen/thinkPinned/thinkScroll/thinkClosed/thinkLoading = … || new Map()` at `:7195-7200`.
  Six top-level writes. Move it before `app.js` and it throws on `state` (TDZ, and `app.js:6-30` documents three
  separate occasions where that exact failure was swallowed by a `try/catch` and shipped as an empty panel).
  Move it after `app.js` and `index.html` needs a third phase, which nothing else uses.
- It owns the **type pacer and the line gate**, i.e. the two settings that decide how fast a run reaches the
  reader's eyes, and it is coupled to `core/type-stream.js` (`wtType`) which already implements them — so the cut
  invites a behaviour change disguised as a move.
- It is **sliced by text** in 14 test files, and it is the one surface a reader stares at all day: a regression
  here is not caught by the suite, it is caught by a person.

By contrast the **riskiest *individual* extraction** — the one with the worst failure mode if it is wrong — is
A2 (the chart/ranking region, 76 outer deps), and the **most expensive to plan** is A1 (73 outer deps for 9
exported names). If you only make one cut to `app.js` and stop, make it **A1**, and take the 73-line header.

### The three things that would make me abandon a step

1. **A section marker that a test slices does not travel cleanly** — if a `sliceRegion` name appears twice, the
   slice silently returns the wrong half. Ten closers are already followed by live code; that is the same failure
   with a different cause.
2. **A load-time read of `state` in the moved range** that cannot be converted to a call-time read. This is
   checkable *before* moving: 222 top-level statements in `app.js`, 0 in the model-picker region.
3. **A CSS move that reorders any of the 24 duplicate selectors.** With 0 `@layer` there is no defence.

---

## 5. What I did not measure

- **No runtime measurement.** No profile, no frame timing, no memory. All numbers here are static (line counts,
  identifier scans, the test suite). `docs/arch-review-efficiency.md` is the place for the cost side and I did
  not re-derive it.
- **The test suite was run once, green** (1,165/1,165, 148 s) — but I did not run the 120 `tools/verify-*.mjs`
  harnesses, which are the only proof of the *browser* behaviour. Several cuts above are only provable there.
- **Dynamic class composition** defeats a literal scan: the "100 classes in no client file" figure is an upper
  bound on dead CSS, not a count. Six are confirmed dead by hand.
- **I did not verify the two `;import` anomalies are the only multi-statement lines** beyond grepping for
  `;import` and `; import`; a smarter parser could find more, though neither changed the graph.
- **`docs/` is stale and I did not resync it.** `docs/architecture.md:666` says `app.js` is 17,178 lines / 668
  functions (today 21,367 / 1,080); `:710` says `server.js` is 4,304 lines / 104 routes (today 5,343 / 113);
  `:625` says 70 test files (today 143); `:627` says 64 harnesses (today 120); `:646` says 14 scripts (today 16).
  `docs/split-public-app-plan.md:3-5` is measured at `622940f`/0.53.2 and explicitly warns that its ranges drift —
  they have: the plan's `app.js` is 18,426 lines, today's is 21,367 (+16%), and its `public/assistant.js` is
  2,897 lines in 22 sections against today's 4,177 in 32. Any plan that quotes those ranges must re-locate every
  section by marker text, never by line.
- **`.agentboard/refactor-research/frontend-app-js.md` does not exist in this tree.** Seven files cite it as the
  source of the M1–M12 numbering — `public/core/dom-format.js:3`, `core/sse.js:4`, `core/transport.js:4`,
  `board/attachments.js:4`, `board/hot.js:4`, plus `docs/architecture.md:656` and
  `docs/arch-review-organization.md:479`. The directory is not in `.gitignore` and `git ls-files` finds nothing,
  so the extraction history is untraceable from a fresh clone. That is a documentation defect independent of any
  refactor: five modules explain themselves by pointing at a document no reader can open.
