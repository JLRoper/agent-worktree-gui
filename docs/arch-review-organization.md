# Architectural review — how this repo is organised

**Lens: organization.** Where the code lives, what owns what, which rules exist twice, what nothing runs,
and what a maintainer meeting this tree cold would hit first. No code was changed, no server was booted,
no push and no PR: every claim below is read out of this working tree or measured with a read-only
command, a Node one-liner or a test run against the tree as it stands.

- Snapshot: `main` at **b64642d** ("Previous turn on send is a three-way setting, not one fold").
- Line numbers are from that snapshot. The tree is edited continuously; a number that is off by a few
  lines still points at the named function.
- **`[measured]`** means I ran something and quote its output. **`[read]`** means the claim is a
  structural argument from the cited lines and I did not execute it.
- Sibling reviews were written from other worktrees at the same snapshot and cover the other two
  lenses: `C:/CodeReviews/agent-worktree-gui/arch-review-functional.md` (the panel's state machine) and
  `arch-review-efficiency.md` (timers and cost). This one does not re-argue their findings; where a
  structural point touches a functional one, it is named and left to them.

---

## The verdict in one paragraph

The server side is modular by intent — 67 modules in `lib/`, each with a header that explains what it
owns — but the composition root kept the verbs: `server.js` is a 4,260-line file whose HTTP layer is a
single 2,271-line `if` chain, ten of whose branches are 40–147-line services, and 32 of whose 71
state-changing routes are named by no test, tool or module in the tree. The client is where the entropy
is: `public/app.js` grew from 3,375 to 16,643 lines in nine days, carries 640 top-level functions, five
document-level click listeners (one of them 1,113 lines), 54 `localStorage` keys under two prefixes, and
five different module conventions at once — and nine of its tests assert by slicing its source text
between comment markers, so its internal layout is now an API. The tests and tools are the largest body
of code in the repo (44,971 lines against 27,748 of product and 22,514 of client) but they are not a
gate: there is no CI, the only pre-push hook checks a version bump, and the three failing tests on `main`
are exactly the state-path ones. The version number stopped identifying a build long before this
snapshot: 495 landings on `main` carry 50 version numbers, `0.1.0` covers 341 of them, and the last two
landings both read `0.32.4`. The repo is not badly factored so much as **unindexed**: almost every rule
has a home, several rules have two homes, and nothing in the tree says which is canonical.

---

## 1. The shape, measured

| Part | Files | Lines | What it is |
|---|---:|---:|---|
| `server.js` | 1 | **4,260** | composition root + HTTP + 102 route branches |
| `lib/` | **67** modules (+1 test) | **23,488** | 54 at `lib/*.js`, 13 under `lib/assistant`, `lib/features`, `lib/http`, `lib/jobs` |
| `public/` | **15** | **26,191** | `app.js` 16,643 · `assistant.js` 2,156 · `core/`+`board/` 3,715 (11 files) · `style.css` 3,079 · `index.html` 598 |
| `test/` | **65** | **11,753** | 468 test declarations |
| `tools/` | **77** (74 `.mjs` + 3 `.py`) | **33,218** | 61 `verify-*.mjs`, 1 nested under `harness/` |
| `docs/` | 20 `.md` + 2 `.diff` + 6 under `cleanup/` | 3,320 (`.md`) | plus `README.md`, 1,099 lines / **101,810 bytes** |

Totals: product (server + lib) **27,748**; client (public JS) **22,514**; verification (test + tools)
**44,971**. There is more verification code than product code, by 1.6×.

The brief's "55 lib modules at 21,534 lines" is the root of `lib/` only (54 `.js` + `panel-restart.cjs`).
The module count is **67** once the four subfolders are counted, and that matters for every statement
below: the subfolders are where the assistant's own machinery lives (`assistant/actions.js`,
`assistant/read.js`, `assistant/store-file.js` …), and they are exactly the modules tests reach least.

**How it got this shape.** The previous review in this repo (`docs/code-review-2026-10-21.md`, snapshot
`fff7a3c`) proposed seven structural moves (A–G). Two of them were started; the file sizes went up
anyway:

| Date | Commit | `public/app.js` | `server.js` | `lib/` modules |
|---|---|---:|---:|---:|
| 2026-10-21 | fff7a3c | 3,375 | 659 | 11 |
| 2026-10-25 | ae528c7 | 12,467 | 2,509 | 28 |
| 2026-10-30 | b64642d | **16,643** | **4,260** | **67** |

`[measured]` `git show <commit>:<file> | wc -l`. In nine days `app.js` grew 4.9×, `server.js` 6.5×, and
`lib/` 6×. Move A (split `app.js` into modules) was executed in part — five modules now cite the plan
and their source line ranges (`core/dom-format.js`, `core/sse.js`, `core/transport.js`,
`board/attachments.js`, `board/hot.js`) — and `app.js` still gained 4,176 lines over the same window.
Move B (a route table for `server.js`) was not started, and the route chain grew from 22 branches to 102.

The lesson in that table is the reason §8 ranks "make the suite deterministic" above every refactor: the
extraction did not fail because it was wrong, it failed because it was outrun. A structural move that
lands without a gate that measures the file afterwards is one more thing the next feature flows over.

---

## 2. Module overlap: one rule, two homes

The overlap is not widespread copy-paste — a regex-level scan finds only two long literals shared
between `app.js` and `lib/`, and three identical function bodies in the whole tree (two of them
cross-module: `foldNoteText` and the `saveAnchorFlag`/`writeFlag` flag writer). It is a small number of
**load-bearing rules** duplicated across the client/server line, where each copy is a rule a reader
sees. In order of how much damage a drift does:

| # | Rule | Home A | Home B | Kept in step by |
|---|---|---|---|---|
| 1 | The fold note a folded tool result ends with | `lib/jobs/console-lines.js:36` | `public/core/console-format.js:127` | `tools/verify-fold-note-parity.mjs` — a manual harness, not `npm test` |
| 2 | A per-million price as money | `lib/model-prices.js:114` | `public/core/model-menu.js:109` | a comment that says "mirrors" (`model-menu.js:107`); nothing tests parity |
| 3 | A byte count as text | `public/core/dom-format.js:170` | `public/app.js:16209` | nothing — and they **disagree** (see below) |
| 4 | TODO statuses and glyphs | `lib/todos.js:33` / `:111` | `public/app.js:10793` / `:10812` | nothing; lib's `TODO_GLYPH` is exported and imported by nobody, the client's copy is the live one |
| 5 | The 40-line head kept of a tool result | `lib/jobs/console-lines.js:16` (`MAX_TOOL_LINES`) | `public/app.js:1493` (`HEAD_LINES`) | a comment naming the other constant |
| 6 | The chart's ten column ids | `lib/chart-columns.js:9` | `public/app.js:11731` | `test/chart-columns.test.js` — the one pair a unit test pins |
| 7 | "Which project owns this path" | `server.js:503` (`projectOfTree`) | `lib/features/spawn.js:32`, `lib/todos.js:440`, plus inline `registry.projects.find(normPathKey(...))` at `server.js:2501`, `:3680`, `:3827` | nothing; four answers, one question |
| 8 | A tree path as a comparable key | 22+ copies across `lib/` and `public/` | — | each copy's own comment, with three different rules |
| 9 | The slug in a worktree directory name | `server.js:1093` (`worktreeDirName`) | `lib/child-worktree.js:31` (`childSlug`) | nothing |
| 10 | "Can this tree be merged" (clean, ahead, not on base) | `server.js:3697-3708` (409s) | `public/app.js:8901-8912` (chip disabled, sentence) | deliberately both, documented as defence in depth (`app.js:8838-8839`) |

Two of these are worth their own paragraph because they are not just tidiness:

**`fmtBytes` has forked.** `public/core/dom-format.js:170` returns `"1 KB"` for 0 bytes and never prints
a value under 1 KB (`Math.max(1, Math.round(bytes / 1024))`). `public/app.js:16209` returns `"0 B"` for
0 and prints `"512 B"` below 1 KB. Both are reachable in the same panel: attachments and the assistant
hint use the `dom-format` one (`board/attachments.js:72`, `assistant.js:1152`), the Settings > Data row
uses the `app.js` one (`app.js:16235`, `:16263`, `:16303`). So the panel formats the same number two
ways depending on which screen you are on, and the extraction header at `board/attachments.js:11` says
`fmtBytes` *moved* to `core/` — it moved and stayed.

**Path keys disagree by rule, not by accident.** `lib/push-guard.js:47` lowercases **and** rewrites
MSYS `/c/x` to `c:/x`; `lib/worktrees.js:85` does `path.resolve` and does **not** fold case (folding is a
separate `pathKey`); `lib/locks.js:24-27` deliberately refuses to reuse `tree-names.normTreePath` "for one
string function"; `server.js` has two of its own, `guardPathKey` (`:491`) and `normPathKey` (`:773`),
277 lines apart in the same file. Each has a comment explaining why it is not shared. That is a coherent
local choice and an incoherent global one: the panel has one identity question ("is this the same
tree?") answered by at least three string rules, and the only place they meet is a comparison site
someone has to remember to normalise on both sides.

---

## 3. Dead code and dead interfaces

### 3.1 Confirmed dead or forked

- **`public/assistant.js:1338` and `:1348`** — `assistantModelExtra` is defined twice, back to back, with
  the same body and the same leading comment. Function hoisting means the second wins; the first eight
  lines are unreachable. `[measured]` a normalised function-body hash finds the two as identical; the only
  caller is `assistant.js:1446`.
- **`public/app.js:16209` `fmtBytes`** — live but superseded by `public/core/dom-format.js:170`, and
  divergent (§2). This is the residue the extraction header claims it removed.
- **`lib/tool-calls.js`** — *not* dead, and it looks it: the module is imported nowhere at the top level,
  but `server.js:3181` does `await import("./lib/tool-calls.js")` inside the `/api/tool-calls` route
  `[read]`. The same is true of `lib/tool-results.js` (`server.js:3127`), `lib/scan-worker.js` (worker
  path in `lib/pool.js:15`) and `lib/panel-restart.cjs` (`lib/restart.js:796`). Four modules a naive
  import graph reports as orphans are load-bearing, which is its own maintenance cost: liveness is
  documented in prose, not in a graph.

### 3.2 Exported for a reader who is not there

`[measured]` 68 exported symbols in `lib/` are imported by no file in the repo (imports were resolved
statically **and** through `await import(...)`, so this is not the `tool-calls` false positive).

- **5 are referenced only at their definition**: `lib/todos.js:111` `TODO_GLYPH`, `lib/model-prices.js:122`
  `formatPrice`, `lib/session-usage.js:481` `clearUsageCache`, `lib/hermes-worktrees.js:107`
  `clearAuditCache`, `lib/paths.js:375` `forgetSizes`.
- **63 more are used exactly once inside their own file and imported by nobody** — an interface surface
  wider than the system: `lib/rebase.js:137` `planRebase`, `lib/refresh-row.js:96` `proposeFromFiles`,
  `lib/worktree-remove.js:66` `removeWorktreeDir`, `lib/locks.js:49` `lockReason`,
  `lib/descriptions.js:90` `descriptionStale`, `lib/verify-landed.js:18` `isCheckJob`, and so on.

Exported-but-unimported is not a bug by itself; it is a signal that these modules were written to be
consumed by a caller that never arrived — usually the page, which reimplements the rule instead (§4.2).

### 3.3 Seven store versions written and never read

`docs/versioning.md` calls a store-shape change a **major**, on the grounds that "an old file that no
longer loads, or loads as something else, is a broken contract". The stores all carry a version field.
Seven of the eight are never read back:

| Constant | Written at | Read at |
|---|---|---|
| `LOCKS_VERSION` (`lib/locks.js:22`) | `locks.js:216` | — |
| `TREE_NAMES_VERSION` (`lib/tree-names.js:25`) | `tree-names.js:239` | — |
| `RELEASES_VERSION` (`lib/worktrees.js:70`) | `worktrees.js:253` | — |
| `REFRESH_VERSION` (`lib/refresh-row.js:14`) | `refresh-row.js:210` | — |
| `PARENT_FILE_VERSION` (`lib/parents.js:26`) | `parents.js:254` | — |
| `TODOS_VERSION` (`lib/todos.js:32`) | `todos.js:701` | — |
| `DESCRIPTIONS_VERSION` (`lib/descriptions.js:22`) | `descriptions.js:222` | — |
| `STORE_VERSION` (`lib/assistant/store-file.js:18`) | `store-file.js:152` | **`store-file.js:83`** |

`[measured]` each of the seven has exactly one occurrence in its file — the write. `STORE_VERSION` is the
exception and the model: `store-file.js:80-85` reads `Number(raw.version || 1) < 2` and moves a v1 file's
`watch` default to v2, once. (`lib/clarify.js:82` also compares a `version`, but it is the gateway's
runs-API capability, not a stored file.) So the repo contains exactly one store migration and seven
store-version fields that advertise the same safety without it: a store written by an older build loads
into the new one with no detection at all. Either check the other seven or stop writing them — a version
field nobody reads is worse than none, because it tells the next reader the migration question is
already handled.

### 3.4 The god modules

| Module | Size | Evidence of compression |
|---|---:|---|
| `lib/jobs.js` | 3,506 | **108 methods** on one `Jobs` class; `create()` alone is **421 lines** (`:1742`), `consume()` 178 (`:2308`), `measureTree()` 148 (`:1576`) |
| `lib/assistant.js` | 3,171 | **82 methods** on one `Assistant` class; `applyActions()` **264 lines** (`:1725`), `checkSpawns()` 81, `digest()` 79 |
| `lib/scheduler.js` | 908 | 28 methods, `scanOne()` 90, `reconcile()` 87 |
| `public/app.js` | 16,643 | 640 top-level functions; `conversationHtml()` 246, `toolGroupHtml()` 244, `detailHtml()` 222, and a **1,113-line delegated click handler** (§4.2) |
| `server.js` | 4,260 | 41 top-level functions; `renameWorktree()` **324 lines** (`:1113`) |

Both god classes have section comments at the seams where they should split (`lib/jobs.js` marks
gateway, persistence, artifacts, worktree, turn-end, run lifecycle, restart, stop, steering, conversation;
`lib/assistant.js` marks storage, charter, clock, rules, settle, thread, audit, spawn, watchdog,
aggressive, actions). The seams are real. What is missing is a reason to cut them, which is why §8 puts
this last despite its payoff.

---

## 4. Where the boundaries leak

### 4.1 `server.js` keeps the verbs

**It is a route monolith.** `[measured]` `server.js:1777` opens `const server = createServer(async (req, res) => {` and the last route branch is at `:4052`: **102 branches, 2,271 lines inside one callback**. 65 of those branches are under 20 lines (thin, fine). Ten are 40 lines or more, and they are not thin:

| Route | Lines | What it actually does |
|---|---:|---|
| `POST /api/worktree/merge` (`:3670`) | 147 | resolves the project (two ways), reads the tree, four refusals, git log, lock, builds the merge prompt, probes the gateway, parks the write, starts the job |
| `POST /api/refresh/row` (`:3511`) | 132 | orchestrates four lib subsystems: `mergeDelta`, `todoProposals`, `descriptions.refreshTree`, `startRowRefreshAgent` |
| `POST /api/worktree/verify-landed` (`:3817`) | 87 | the same shape as merge, with `verifyPrompt` |
| `POST /api/worktree/rebase` (`:2487`) | 87 | resolve, refuse, plan, start |
| `POST /api/worktree/child` (`:2372`) | 71 | resolve, refuse, cut |
| `POST /api/worktree/suggest-name` (`:3921`) | 51 | reads the tree's commits and files, asks the model |

**Merge and verify are copies of each other.** `[read]` compare `:3670-3725` with `:3817-3859`: the same
project resolution (including the same fallback through `spawnFeature.projectForPath` and the same
inline `registry.projects.find`), the same `baseRef` derivation, the same `scanWorktree(..., "fast")`,
the same four refusals with the same sentences modulo one word, the same `git log --oneline -20`, the
same `root` selection, the same `stamp`, the same `locks.check`. The differences are `mergeLabel` vs
`verifyLabel`, the `"MERGING into "` vs `"CHECKING "` label prefix, and which prompt builder is called.
Two state machines, one implementation, written twice — and the functional review's F12/F14 land in
this code.

**It re-implements primitives lib already owns.** `server.js:491` `guardPathKey` and `:773`
`normPathKey` are the same function twice in one file; `:503` `projectOfTree` is a fourth project
resolver; `:1093` `worktreeDirName` is a second slug rule; `:1106` `isMainCheckout` runs git in the
composition root. `:1113` `renameWorktree` is 324 lines of naming and lifecycle logic — preconditions,
`git mv`, ledger rewrite, lock repoint, jobs repoint, broadcast — in a file whose `tree-names` and
`worktree-naming` modules exist to own exactly that. And the file's own second line says *"The HTTP layer
never runs git"* (`server.js:2`), while `[measured]` there are **15 `gitIn(...)` calls in route bodies**
(clone `:3995`, merge `:3715`/`:3754`, verify `:3855`/`:3886`, reattach `:3282`/`:3283`, first-commit
`:2887-2903`). The comment is a design intent that the route code has walked past.

**Auth is a per-handler convention.** `[measured]` all 71 POST branches contain their own
`if (!authorised(req, config.token))` (an improvement on the previous review, which found 12 of 14), and
7 GETs do too. That is 78 hand-copied guard lines. The only test that names routes is
`test/auth.test.js` and it names five (`:10-12`). A new POST that forgets the line is caught by nothing
between the author and `main`.

### 4.2 `public/app.js` reimplements what lib computes

`[read]` `app.js` carries **29 comments that name a `lib/` module as the owner** of a fact it is drawing
(`lib/jobs.js` for the held turn, `lib/sync-state.js` for `row.sync`, `lib/locks.js` for the lock glyph,
`lib/tool-results.js` for result identity, `lib/tree-names.js` for the naming ledger …). Those comments are
good writing and they are also the coupling: the client stays in step with the server by knowing its
internals, because it cannot import them.

It then reimplements several of them anyway: the fold note and the 40-line head (§2), price formatting
(§2), byte formatting (§2), TODO glyphs and statuses (§2), chart column ids (§2), path keys
(`app.js:509` `normPath`, `:7907` a second local `norm`), and the merge cleanliness rule (§2). Each one is
a candidate for the server simply sending the rendered value, which is how `row.sync` and `row.verdict`
already work.

**Its own cadence is a second scheduler.** `[measured]` 15 `setInterval` calls: thinking 1.2 s
(`app.js:3839`), subagents 5 s (`:3812`), approvals 1 s (`:6019`), live clocks 1 s (`:1190`), question
clocks 1 s (`:16511`), focus 250 ms (`:7368`), visibility 3 s and 5 s (`:16608-16609`), plus
`update-check.js:192`/`:270`. The server has `lib/scheduler.js` with its own cadence, and the SSE stream
is a third path. Nothing in the tree says which clock owns which fact.

**Five module conventions in one page.** `[read]`:

1. **bare globals** — `core/dom-format.js:30-172` declares `$`, `esc`, `relTime`, `fmtBytes`, … at top
   level, and `app.js` calls them by bare name (315 `esc(` calls);
2. **`window.WMApp.core.<name>`** — `console-format.js:727`, `dom-format.js:179`, `sse.js:203`,
   `transport.js:119`;
3. **`globalThis.wtStream`** — `stream-merge.js:179`, read at `app.js:2186`, `:7458`;
4. **`window.ModelMenu`** — `model-menu.js:411`;
5. **`app.js`'s own 181 top-level `const`s**, none exported.

`dom-format.js:178` is explicit that the namespace is a promise: *"Nothing reads it yet: app.js still
calls the bare names above."* Two of the five conventions are therefore decorative, and a maintainer
cannot tell from a call site which kind of binding they are looking at.

**The persistence schema is scattered.** `[measured]` **54 distinct `localStorage` keys**, 27 under
`wm.*` and 27 under `wtgui.*`, declared inline from `app.js:9` (`wm.spawnHistory`) to `:15266`
(`wtgui.settingsFolded`) and in `assistant.js`. No registry, no version, no migration — two renames are
recorded only as comments (`app.js:21-22`, "was wm.anchorFollow"). Every key is a contract with the
reader's browser that nothing enumerates.

**The click surface is five handlers, one of them a thousand lines.** `[measured]` document/element
click listeners at `app.js:5434`, `:12901`, `:13015`, `:13047`, `:13124` (1,113 lines, **88 distinct
`data-*` actions**), `:14704` (56 lines, on `#projects`) and `:15305` (523 lines). Three action keys —
`data-open-row`, `data-agent-thread`, `data-open-path` — are handled in **two** of them; the
`#projects` handler survives that by calling `stopPropagation()` (`:14708`), so which listener wins is a
runtime convention in a 56-line function, not a structure.

### 4.3 The tests reach into the source text

Nine test files read `public/app.js`, slice it between marker comments and `new Function(...)` the
result: `test/branch-cell.test.js:13-20`, and the same trick in `ahead-behind-cell`, `chart-columns`,
`prev-turn-mode`, `settings-groups`, `tool-group-key`, `tool-output-expand`, `stream-button-title`,
`new-agent-reasoning`. `[measured]` `app.js` has **89 section comments and only 10 `// ---- end …`
markers** — those ten are a test API. A section comment moved or reworded breaks tests; a function that
closes over page state cannot be tested this way at all, which is why the tested ones are written to take
everything as arguments.

It is the cheapest way to test a classic script without a bundler, and it is the reason the file cannot
be reorganised casually: the layout is load-bearing.

### 4.4 `lib/` is a server-private library with a client shadow

`[measured]` **9 modules are imported only by `server.js`** (`lib/approvals.js`,
`lib/features/descriptions.js`, `lib/features/spawn.js`, `lib/hermes-models.js`, `lib/http/static.js`,
`lib/pool.js`, `lib/projects.js`, `lib/subagents.js`, `lib/thinking.js`), and **16 cannot be reached by
any test import at all**, directly or transitively (`lib/http/*`, `lib/pool.js`, `lib/projects.js`,
`lib/subagents.js`, `lib/thinking.js`, `lib/tool-calls.js`, `lib/tool-results.js`, `lib/scan-worker.js`
…). The client reimplements rules from this library because nothing exposes them across the wire.

---

## 5. Tests, tools, and neither

### 5.1 What is a test

`[measured]` 65 files, 11,753 lines, **468 test declarations**, in five shapes:

| Shape | Files | Declarations | What it does |
|---|---:|---:|---|
| **lib unit** | 26 | 188 | imports a `lib/` module; no server, no page |
| **route / integration** | 23 | 133 | boots the real panel through `tools/panel-testkit.mjs` and drives HTTP |
| **page slice** | 10 | 66 | reads `app.js` between comment markers and evals the slice |
| **page module unit** | 4 | 72 | imports `public/core/*.js` as a module (`stream-merge`, `type-stream`, `update-check`, `console-format`) |
| **meta / tooling** | 2 | 9 | tests the runner (`verify-runner`) and a page script (`assistant-resize`) |

The distribution is the good news: 23 integration files is a real investment in the panel's own
behaviour, and `test/worktree-release.test.js` alone is 31 state-path tests.

### 5.2 What is a tool

`[measured]` 77 files, 33,218 lines. The runner discovers **62 harnesses** — 61 `tools/verify-*.mjs`
plus `harness/playwright-lane-c/verify.mjs` — and 59 of them carry explicit pass/fail accounting (the
other two fail by throwing an assert). Of the 77:

| Kind | Count | Runs under `verify.mjs`? |
|---|---:|---|
| `verify-*.mjs` (browser or no-gateway proofs) | 61 | yes |
| `harness/**/verify.mjs` | 1 | yes |
| `measure-*.mjs` (prints numbers; 2 also assert) | 4 | **no** — name does not match |
| `verify-*.py`, `probe_*.py`, `openrouter-prices.py` | 3 | **no** — runner is `.mjs` only |
| `e2e-aggressive-http.mjs`, `check-gateway-clarify.mjs` | 2 | **no** |
| infrastructure (`panel-testkit.mjs`, `browser.mjs`) | 2 | no — they are imported |
| dev utilities (`version.mjs`, `where.mjs`, `merged-branches.mjs`, `child-process-audit.mjs`) | 4 | no |

The runner's own header is already behind: `tools/verify.mjs:5` says "a fleet of 28" and `:41` says
"the 51 real harnesses", while `[measured]` the fleet is 62. `[measured]` 42 of the 77 tool files are
named in no README, doc, package script or other tool; the only catalogue is `verify.mjs --list`, which
reads each file's first prose comment at runtime.

### 5.3 What is neither

- **`lib/jobs.test.js`** — 449 lines, a real integration test ("a real panel process … over real HTTP
  against a stub Runs API"), and **no script runs it**: `npm test` globs `test/*.test.js`, and the
  verify runner only discovers `verify-*.mjs`. `[measured]` `node --test lib/jobs.test.js` → **ALL PASS
  (59 checks)** in 11.5 s. It is the best test in the repo that nobody runs.
- **`tools/panel-testkit.mjs`, `tools/browser.mjs`** — infrastructure, correctly not harnesses.
- **Three `.py` files** — `openrouter-prices.py` (a 425-line price scraper), `probe_run_stats.py`,
  `verify_cli_session_limit.py`; no header, no runner, no doc reference.
- **`docs/*.diff`** (2 files, 324 lines) — patch text checked in as documentation.
- **`docs/cleanup/`** (6 files) — a phase plan for a cleanup that the tree has since outgrown.
- **`MERGE-LOG.md`** — a 59-line record of one integration branch from 2026-10-27; historical, in the
  repo root, and (see §6) the clearest evidence for the version problem.

### 5.4 The state paths versus the happy ones

**The suite is red on `main`, and the red is all state paths.** `[measured]` `node --test
test/*.test.js` on b64642d: **468 tests, 465 pass, 3 fail, 393.7 s**:

| Failing test | Time | What it drives |
|---|---:|---|
| `push-guard: an env-granted push neither asks the panel nor parks` | 30 s | a permission decision (ask/allow/expire) |
| `rebase-route: … plans on a dry run and rewrites only on the press` | 154 s (timeout) | plan → press → rewrite |
| `verify-sweep: a settled LANDED: YES card deletes its worktree` | 128 s (timeout) | a landing answer → a deleted tree |

Run alone, `[measured]`: `rebase-route` **passes** in 50 s (it is load-sensitive: 154 s under the parallel
suite), and `verify-sweep` **still fails**, in 84 s — so the commit message in #113 ("passes when run
alone") no longer holds on this box. The shape of the failures is the finding: every one is a
`waitFor(... , { timeout: 60_000 })` over a wall clock (`verify-sweep.test.js:21-31`,
`rebase-route.test.js:40-47`) while the suite runs test files in parallel, each spawning a real panel
and real git. State paths are covered, but they are covered *by timing*, so the tests most worth running
are the ones a loaded machine fails.

**Coverage by route string.** `[measured]` 95 distinct route paths; **22 are named in a test file**.
**32 POST routes (state-changing) are named by no test, tool or lib file at all**:

```
/api/settings/sessions   /api/settings/approvals  /api/settings/provider  /api/assistant/alert
/api/assistant/answer-question  /api/assistant/watch  /api/assistant/watch/remove
/api/assistant/rule  /api/assistant/rule/remove  /api/assistant/notes  /api/assistant/check
/api/hosts/propose  /api/hosts/mapping  /api/approvals  /api/approvals/answer
/api/remote-write/request  /api/remote-write/guard  /api/agents/preview  /api/repo/first-commit
/api/threads/context  /api/jobs/cancel  /api/jobs/approve  /api/jobs/answer  /api/sessions/revive
/api/jobs/attach  /api/jobs/label  /api/jobs/clear  /api/settings/scan  /api/jobs/artifact/delete
/api/refresh/row/agent  /api/clone  /api/restart
```

That list is the state-path gap in one place: the approval answer, the clarify answer, the remote-write
request, the reattach/revive path, the assistant's rule set, and the merge-adjacent delete. Some are
exercised without naming the literal (the restart tool imports `RestartController` directly), but the
count is the honest measure of what a route-level regression would slip through.

### 5.5 Nothing runs any of it as a gate

- **No CI.** `[measured]` no `.github/`; `.githooks/commit-msg` says so in as many words: *"This repo
  has no CI, so nothing refuses a bad subject at PR time either."*
- **The pre-push hook checks one thing**: `tools/version.mjs check`, i.e. that the branch bumped
  `package.json` (`.githooks/pre-push`). It does not run `npm test`, `node --check`, or any harness.
- **`npm test` is 6.5 minutes and red**, so it is a thing you run when you remember, not a gate.
- 44,971 lines of verification exist and no step in the landing path invokes them.

---

## 6. The build identity problem

**The number is per landing, not per build, and it has been reused for whole integrations.**

`[measured]` `main` has **495 landings (first-parent commits) and 50 distinct versions**. Twenty of those
numbers are carried by more than one landing:

| Version | Landings |
|---|---:|
| `0.1.0` | **341** |
| `0.2.0` | **68** |
| `0.7.1` | **13** |
| `0.31.0`, `0.27.0`, `0.15.1`, `0.14.0`, `0.11.1`, `0.8.1`, `0.3.0` | 3 each |
| `0.32.4`, `0.21.0`, `0.17.0`, `0.13.0`, `0.11.0`, `0.10.2`, `0.10.1`, `0.10.0`, `0.9.0`, `0.8.0`, `0.7.0`, `0.6.0` | 2 each |

The current number is one of the two-landings cases: `5528137` (#113) bumped `package.json` to
`0.32.4`, and `b64642d` (#114) landed with `[measured]` **no `package.json` change at all**
(`git show b64642d -- package.json` is empty). So the last two landings, and every worktree cut from
`main` since, all read `0.32.4`.

This is not only forgetfulness. `MERGE-LOG.md:41` records the policy for an integration branch:

> `package.json` was held at main's 0.11.2 through every merge (branch bumps 0.11.3 → 0.14.1 were all
> dropped). The single bump is the last commit on the branch: 0.12.0 …

Sixteen merges, one number, by design — because resolving a version conflict on every merge is noise
while integrating. The cost is that the number on `main` after that integration names nothing that was
in it.

**The gate that exists is newer than most of the damage and fails open.** `tools/version.mjs` landed
2026-10-26 (`320dd59`); the 341-landing `0.1.0` stretch predates it. When it cannot resolve a base ref it
prints a note and **returns 0** (`tools/version.mjs:229-232`) — a check that cannot find what to compare
passes. And it is a local hook, which the tool's own output notes "only ever binds its own author"
(`:264`), with `git push --no-verify` as a documented bypass.

**There are two identities in the tree and neither is complete.** `lib/build-version.js` computes a
12-hex hash over every byte the shell loads (`versionOf`, `readBundle`), serves it at `GET /api/build`,
puts it in the page's `<meta name="panel-build">`, and `public/core/update-check.js` compares the tab's
hash with the server's to offer a reload. That hash **is** a build identity: it changes with any byte.
But it is not in git, not in the commit, and not on the board. The semver is in git and on the board's
config line (`app.js:12591` prints `v${cfg.version}`), but it is a human judgement that does not change
with bytes.

So the answer to "which build is this?" is: *the page can tell you which bundle it is running, git can
tell you which number a human claimed, and nothing can tell you which bytes a number stands for.*

**What would make the number identify a build** (small, and it fits the existing pipeline): compose the
displayed/served version as `${semver}+${bundleHash}` at boot from `lib/build-version.js`, have
`tools/version.mjs check` refuse a branch whose resulting number already exists on `main`, and have the
landing commit body record the hash the branch was verified at. The semver stays the landing agent's
judgement (`docs/versioning.md` is right that it is a judgement); the hash makes it falsifiable.

---

## 7. What a maintainer meeting this repo cold trips on first

In the order they hit it, each with the first ten minutes:

1. **The documentation is three manuals and no index.** `README.md` is 101,810 bytes and six `##`
   sections — "Two halves" alone runs from line 173 to 976. `docs/using-the-board.md` is another 80 KB.
   Twenty docs sit beside them, two of them `.diff` files. There is no README for the docs.
2. **`server.js` is one callback.** "Where is the route for X?" has one answer — grep `route ===` — and
   the file's own comment (`server.js:2`, "the HTTP layer never runs git") is untrue fifteen times.
3. **`public/app.js` has no exports.** To learn what a name is you grep 16,643 lines; the split into
   `core/` and `board/` is half-finished and uses five conventions (§4.2), two of them decorative.
4. **The comment markers are a test API.** Move a section comment, break a test (§4.3). Nothing says so
   except the tests themselves.
5. **The refactor plan the split follows does not exist.** Six files cite
   `.agentboard/refactor-research/frontend-app-js.md` (`core/dom-format.js:3`, `core/sse.js:4`,
   `core/transport.js:3`, `board/attachments.js:3`, `board/hot.js:3`, `index.html:564`) with module ids
   and line ranges at `ae528c7`. `[measured]` `git log --all -- .agentboard` is empty: the document was
   never committed. A maintainer is told to read the plan for every extracted module and cannot.
6. **"Which tree is this?" has four answers.** `projectOfTree` vs `spawn.projectForPath` vs
   `todos.projectForPath` vs inline `registry.projects.find`; and three path-string rules underneath
   them (§2).
7. **Seven of eight stores advertise a version and never check it** (§3.3) — the migration safety a
   reader would assume is not there, with one module showing what the check should look like.
8. **`npm test` is six minutes and red on `main`**, and the failures are the state paths (§5.4). A new
   contributor's first full run fails on arrival, for reasons unrelated to their change.
9. **The version on `main` is shared** with the previous landing and with every worktree cut since (§6),
   so "what changed since 0.32.4" has no answer.
10. **The docs disagree with the tree.** `docs/code-review-2026-10-21.md:234` says *"There is no
    `npm test`"*; `package.json` has had one since. `tools/verify.mjs:5` says 28 harnesses, `:41` says 51;
    the runner lists 62.

---

## 8. Reorganisations, ranked by payoff over risk

Payoff = what it buys a maintainer (1–5). Risk = the chance it breaks behaviour that has no test (1–5).
Order is payoff/risk, then effort. Nothing here is a work order; it is what I would do, in what order,
and why.

| # | Move | Payoff | Risk | Effort | Ratio | Why this rank |
|---|---|---:|---:|---|---:|---|
| 1 | **Give the build one identity** — `${semver}+${bundleHash}` from `lib/build-version.js`; `version.mjs check` refuses a duplicate number on `main` | 4 | 1 | S | 4.0 | Pure addition to data already computed; nothing behavioural changes; it makes every later "what is deployed?" question answerable |
| 2 | **Make the verification fleet one catalogue** — classify the 77 files, register the 4 `measure-*` + 3 `.py` + 2 `e2e-*`, delete or absorb the 42 that no doc names, fix the runner's own counts | 3 | 1 | M | 3.0 | Cheap, and it is the precondition for anyone trusting the 33k lines |
| 3 | **Pin the state paths** — run the panel-spawning tests serially (`--test-concurrency=1`) or on fake clocks; add the 32 unnamed POST routes to a shape test. Then make `npm test` green | 5 | 2 | M | 2.5 | The tests that matter are the ones that fail; fixing that is worth more than any file move, and it is what makes #5/#6/#9 safe |
| 4 | **Extract the route table** — `server.js`'s 102 branches to a `routes` map with one auth wrapper | 5 | 2 | M | 2.5 | Mechanical, and it shrinks the file a reader must hold; auth becomes structural instead of 78 hand copies. Test coverage of routes is thin, which is why it is not #1 |
| 5 | **Delete the dead and forked code** — `assistantModelExtra` duplicate, `app.js` `fmtBytes`, the 5 definition-only exports, and either check or drop the 7 unread store versions | 2 | 1 | S | 2.0 | Small, safe, and the store-version half is a real correctness fix disguised as cleanup |
| 6 | **One identity module** (`lib/identity.js`) for path keys and project ownership: 22 normalisers and 4 resolvers to one each | 4 | 2 | M | 2.0 | The rules already agree except on case/MSYS; the risk is a caller that relied on the unfolded spelling |
| 7 | **Finish or revert the client split** — one namespace, real exports, so the 9 marker-slicing tests can import instead of `new Function` | 4 | 2 | L | 2.0 | High payoff for testability and for `app.js`'s size; medium risk because the marker tests are load-bearing today |
| 8 | **One docs index** — README → a map; archive `MERGE-LOG.md`, the `.diff` files and `docs/cleanup/`; fix the stale counts | 2 | 1 | S | 2.0 | Cheap; the payoff is a maintainer's first hour, not the code |
| 9 | **Move route orchestration into lib** — `services/refresh-row`, `services/merge`, `services/verify-landed`; kills the 147/132/87-line handlers and the merge↔verify copy | 5 | 3 | L | 1.7 | Highest structural payoff after the god classes, but it moves state-machine code, so it needs #3 first |
| 10 | **Split `lib/jobs.js` (108 methods) and `lib/assistant.js` (82)** along the section seams already in them | 5 | 4 | XL | 1.3 | The largest comprehension win and the largest risk: 421-line `create()` and 264-line `applyActions()` are exactly where the functional review found bugs. Do it last, with #3 in place |

**Sequence I would actually run**, which is not the same as the ratio order: **1 → 5 → 3 → 4 → 6 → 7 →
9 → 10**, with 2 and 8 done alongside 3 (they are the kind of work that fits between test runs). The
reason #1 goes first despite #3 having a higher payoff is that it is a day's work with no behavioural
surface, and it answers the question a maintainer asks on day one; the reason #3 is third rather than
first is that it needs the fleet catalogue (#2) to know what "green" means.

### What I would not do

- **Do not add a bundler or a dependency.** The repo's zero-dependency, no-build-step invariant
  (`package.json` has no `dependencies`; scripts are classic `<script>` tags) is why the panel can be
  edited while it runs and why `lib/build-version.js` can hash what is served. Every move above is
  compatible with it; a bundler is not.
- **Do not rewrite `app.js`.** 9 marker tests and 65 test files assume today's layout; a rewrite trades a
  known cost for an unknown one. Split it module by module, behind the namespace, with the tests
  converted in the same landing.
- **Do not merge the three reviews' fixes into one branch.** The functional review's findings are in
  `lib/jobs.js`/`lib/assistant.js`, which is where #10 lands; doing both at once makes the diff
  unreviewable.

---

## 9. What I could not measure

- I did not run the 62 verify harnesses (several need Playwright and a gateway), and I did not boot the
  panel or open a browser. Claims about what a harness proves are `[read]` from its header and code.
- Route coverage is measured by the literal route string appearing in `test/`, `tools/` or `lib/`. A test
  can exercise a route without naming it; the 32 is an upper bound on "untested", not a proof.
- The unused-export scan resolves static and dynamic relative imports. A specifier built at runtime
  (none found, but possible) would read as unused.
- Line counts are text lines (`wc -l`), not statements; a file with long comment blocks reads bigger
  than its code.
- The test run is one machine under load (four other agent sessions). The three failures' timings are
  indicative; `verify-sweep` failing alone is the one I would act on, `rebase-route`'s timeout is load.
- Proof that `b64642d`'s branch carried no bump is the empty `git show b64642d -- package.json`; *why*
  (bypass, a lost conflict resolution, a rebase over a parallel bump) is not recoverable from the tree.

---

## How the evidence was produced

All read-only; nothing was written outside `docs/` and `C:/CodeReviews/`.

- **Shape and growth**: `wc -l`, `git ls-tree -r --name-only <commit> lib`, `git show <commit>:<file> |
  wc -l` for fff7a3c / ae528c7 / b64642d.
- **Routes**: a Node/Python pass over `server.js` cutting each `if (route === …)` branch at the next one —
  102 branches, 2,271 lines, per-branch sizes, and an `authorised(` check per POST branch.
- **Imports and exports**: a Python resolver over all 223 `.js/.mjs/.cjs` files, handling both
  `import { x } from "./y.js"` and `await import("./y.js")` destructuring, then matching each `export`
  against every importer. 0 unresolved relative imports in the tree.
- **Duplication**: normalised function-body hashing across `lib/`, `public/`, `server.js`, plus a
  regex-literal diff between `app.js` and `lib/`.
- **Tests**: `node --test test/*.test.js` on b64642d → 468 tests, 465 pass, 3 fail, 393.7 s (full log
  kept under `C:/Users/roper/AppData/Local/Temp/wag/493c2684/testrun.txt`); `node --test
  test/verify-sweep.test.js` alone → fail, 84 s; `node --test test/rebase-route.test.js` alone → pass,
  50 s; `node --test lib/jobs.test.js` → ALL PASS (59 checks), 11.5 s.
- **Tools**: `node tools/verify.mjs --list` (62 harnesses), per-file import/assert/Playwright scan.
- **Versions**: `git rev-list --first-parent main` + `git cat-file --batch` over every
  `<rev>:package.json`, grouping consecutive landings by version; `git log --format=%h -- package.json`
  for the bump history; `MERGE-LOG.md` for the integration policy.
- **Counts quoted**: 89 section comments / 10 end markers (`grep -c '^// ---- '`), 640–647 top-level
  functions in `app.js`, 5 document click listeners and 1,113 lines in the largest (brace-matched),
  54 `localStorage` keys (`grep -ho '"\(wm\|wtgui\)\.[a-zA-Z]*"' | sort -u`).
