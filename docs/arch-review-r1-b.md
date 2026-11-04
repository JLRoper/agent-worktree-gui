# R1-B — architectural review, bottom-up by coupling and churn

**Snapshot:** `cc61bb9` on `wtgui/architectural-review-bot-2fb127`, `package.json` 0.84.0, 786 commits total.
`origin/main` is `bf41b2f` — **6 commits ahead** of this tree (0.85.0; `public/app.js` +274 lines, `server.js` +81,
one new `lib/` module). Counts below are at `cc61bb9`; line numbers drift by up to ~274 in `app.js` against main.

**What this document is.** A second, deliberately different lens: structure derived from measurement rather than
responsibility. Three measurements only — the static import graph, the co-change history, and where inside a file the
hunks land. Nothing was edited; this is read-only, no source file was modified.

**Method, in one line each** (commands in §8):

- **Import graph.** 88 nodes — `server.js`, every one of the 85 files under `lib/`, and the two browser files — 184 static edges, scraped
  from `import … from` / `export … from` / dynamic `import()`. 19 external specifiers, all `node:` builtins —
  `dependencies: {}`, so there is no third-party graph to consider.
- **Client coupling.** The 16 browser files are classic scripts with **zero static imports in 30,071 lines**. Their
  graph is therefore the global namespace: which top-level name of one file appears in another. That is a weaker
  measure than an import (a mention is not necessarily a call), so every client number below is framed as
  *references*, not edges.
- **Co-change.** `git log --numstat` over the last 200 **non-merge** commits (merges excluded, which is what the window is), co-change counted per commit,
  Jaccard = shared / (A + B − shared), confidence = shared / min(A, B).
- **Hunk geography.** `git log -p --unified=0` over the same 200 commits, each hunk's `+` line bucketed into a
  500-line region of the file at the commit's own revision. Positions drift over 42 commits in a 21k-line file, so
  region buckets are approximate; the *count of distinct regions a commit touches* is stable and is what I use.

---

## 1. The coupling table

`in` = number of modules that statically import this file. `in−srv` = the same count excluding `server.js`, which
imports 53 of the 83 modules and so inflates almost every row by one. `out` = modules it imports. `tests` = number of
`test/**` files that import it directly.

The two client files have no static imports at all, so their ESM degrees are 0/0 by construction and are marked `—`.
Their real coupling is in §1.2.

| module | in | in−srv | out | lines | direct tests |
|---|---:|---:|---:|---:|---:|
| `lib/scan.js` | 12 | 11 | 1 | 396 | 3 |
| `lib/assistant/read.js` | 9 | 9 | 0 | 263 | 0 |
| `lib/jobs.js` | 8 | 7 | 15 | 3830 | 15 |
| `lib/tree-names.js` | 8 | 7 | 0 | 276 | 2 |
| `lib/hermes-runtime.js` | 7 | 7 | 1 | 121 | 1 |
| `lib/own-tree.js` | 7 | 6 | 0 | 177 | 1 |
| `lib/hermes-config.js` | 6 | 5 | 1 | 453 | 0 |
| `lib/paths.js` | 6 | 5 | 0 | 599 | 2 |
| `lib/project.js` | 5 | 4 | 4 | 396 | 2 |
| `lib/todos.js` | 5 | 4 | 0 | 725 | 3 |
| `lib/errors.js` | 4 | 3 | 0 | 20 | 3 |
| `lib/pipeline-bundle.js` | 4 | 4 | 0 | 392 | 6 |
| `lib/tool-text.js` | 4 | 4 | 0 | 111 | 0 |
| `lib/completion.js` | 3 | 3 | 1 | 385 | 3 |
| `lib/parents.js` | 3 | 2 | 1 | 368 | 2 |
| `lib/assistant/config.js` | 3 | 3 | 0 | 344 | 6 |
| `lib/charter.js` | 3 | 3 | 0 | 266 | 1 |
| `lib/hosts.js` | 3 | 2 | 0 | 524 | 2 |
| `lib/remote-writes.js` | 3 | 2 | 0 | 461 | 3 |
| `lib/assistant.js` | 2 | 1 | 21 | 5193 | 25 |
| `lib/assistant/actions.js` | 2 | 2 | 2 | 152 | 2 |
| `lib/assistant/audit.js` | 2 | 2 | 2 | 183 | 1 |
| `lib/assistant/queue.js` | 2 | 1 | 2 | 1260 | 7 |
| `lib/roles.js` | 2 | 2 | 2 | 223 | 1 |
| `lib/task-pipeline-assign.js` | 2 | 1 | 2 | 190 | 2 |
| `lib/activity.js` | 2 | 1 | 1 | 536 | 1 |
| `lib/base-ref.js` | 2 | 2 | 1 | 80 | 1 |
| `lib/http/transport.js` | 2 | 1 | 1 | 170 | 0 |
| `lib/locks.js` | 2 | 1 | 1 | 384 | 3 |
| `lib/reasoning.js` | 2 | 2 | 1 | 26 | 2 |
| `lib/session-usage.js` | 2 | 2 | 1 | 486 | 0 |
| `lib/task-pipeline.js` | 2 | 2 | 1 | 193 | 4 |
| `lib/build-version.js` | 2 | 1 | 0 | 207 | 1 |
| `lib/model-prices.js` | 2 | 2 | 0 | 313 | 0 |
| `lib/pipelines.js` | 2 | 1 | 0 | 783 | 1 |
| `lib/sync-state.js` | 2 | 1 | 0 | 105 | 2 |
| `lib/verify-prompt.js` | 2 | 1 | 0 | 204 | 1 |
| `lib/restart.js` | 1 | 0 | 5 | 1197 | 2 |
| `lib/scheduler.js` | 1 | 0 | 5 | 923 | 2 |
| `lib/features/spawn.js` | 1 | 0 | 4 | 295 | 1 |
| `lib/gateway-permissions.js` | 1 | 0 | 4 | 586 | 1 |
| `lib/hermes-models.js` | 1 | 0 | 4 | 287 | 0 |
| `lib/steward.js` | 1 | 0 | 3 | 471 | 1 |
| `lib/worktrees.js` | 1 | 0 | 3 | 772 | 3 |
| `lib/assistant/charter-file.js` | 1 | 1 | 2 | 141 | 0 |
| `lib/assistant/profile.js` | 1 | 1 | 2 | 132 | 2 |
| `lib/assistant/store-file.js` | 1 | 1 | 2 | 188 | 0 |
| `lib/assistants.js` | 1 | 1 | 2 | 164 | 8 |
| `lib/child-worktree.js` | 1 | 0 | 2 | 98 | 1 |
| `lib/http/static.js` | 1 | 0 | 2 | 77 | 0 |
| `lib/pipeline-window.js` | 1 | 0 | 2 | 251 | 2 |
| `lib/projects.js` | 1 | 0 | 2 | 346 | 0 |
| `lib/spawn-target.js` | 1 | 1 | 2 | 170 | 1 |
| `lib/subagents.js` | 1 | 0 | 2 | 368 | 0 |
| `lib/verify-landed.js` | 1 | 0 | 2 | 64 | 1 |
| `lib/worktree-naming.js` | 1 | 0 | 2 | 208 | 1 |
| `lib/worktree-remove.js` | 1 | 0 | 2 | 181 | 1 |
| `lib/assistant/landed.js` | 1 | 1 | 1 | 144 | 1 |
| `lib/assistant/match.js` | 1 | 1 | 1 | 77 | 0 |
| `lib/assistant/messages.js` | 1 | 1 | 1 | 516 | 0 |
| `lib/attachments.js` | 1 | 1 | 1 | 175 | 1 |
| `lib/descriptions.js` | 1 | 1 | 1 | 236 | 1 |
| `lib/features/descriptions.js` | 1 | 0 | 1 | 118 | 0 |
| `lib/hermes-worktrees.js` | 1 | 1 | 1 | 215 | 1 |
| `lib/jobs/console-lines.js` | 1 | 1 | 1 | 229 | 1 |
| `lib/rebase.js` | 1 | 0 | 1 | 288 | 1 |
| `lib/refresh-row.js` | 1 | 0 | 1 | 226 | 1 |
| `lib/skills.js` | 1 | 0 | 1 | 532 | 1 |
| `lib/store.js` | 1 | 0 | 1 | 220 | 5 |
| `lib/tool-results.js` | 1 | 0 | 1 | 61 | 0 |
| `lib/approvals.js` | 1 | 0 | 0 | 88 | 0 |
| `lib/branch-policy.js` | 1 | 1 | 0 | 62 | 1 |
| `lib/chart-columns.js` | 1 | 0 | 0 | 41 | 1 |
| `lib/clarify.js` | 1 | 1 | 0 | 120 | 0 |
| `lib/merge-prompt.js` | 1 | 0 | 0 | 241 | 2 |
| `lib/name-from-work.js` | 1 | 0 | 0 | 268 | 0 |
| `lib/open-url.js` | 1 | 0 | 0 | 47 | 1 |
| `lib/pool.js` | 1 | 0 | 0 | 132 | 0 |
| `lib/port-guard.js` | 1 | 0 | 0 | 72 | 1 |
| `lib/push-guard.js` | 1 | 0 | 0 | 574 | 3 |
| `lib/thinking.js` | 1 | 0 | 0 | 69 | 0 |
| `lib/tool-calls.js` | 1 | 0 | 0 | 103 | 0 |
| `server.js` (composition root) | 0 | 0 | 53 | 5344 | 0 |
| `lib/scan-worker.js` | 0 | 0 | 1 | 13 | 0 |
| `lib/panel-restart.cjs` | 0 | 0 | 0 | 64 | 0 |
| `public/app.js` (classic script, no static imports) | — | — | — | 21368 | 0 |
| `public/assistant.js` (classic script, no static imports) | — | — | — | 4178 | 0 |

### 1.1 What the import graph actually says

Six facts, in the order they change a decision:

1. **`server.js` is not a module, and the graph refuses to treat it as one.** Out-degree 53, in-degree 0. It is the
   composition root, the HTTP router *and* a service layer: 2,057 lines of top-level functions and constants precede
   the request handler (`server.js:2058`), and 47 top-level functions plus 57 top-level constants live in the file. **32 of the 83 `lib/`
   modules are imported by nothing but `server.js`.** So "lib/ is the library" is half true: there is a shared spine,
   and there is a long tail of single-consumer helpers that exist only because `server.js` is one file.
2. **The shared spine is small and it is all reads.** In-degree ≥ 4 without `server.js`: `scan` (11), `assistant/read`
   (9), `jobs` (7), `tree-names` (7), `hermes-runtime` (7), `own-tree` (6), `hermes-config` (5), `paths` (5),
   `project` (4), `todos` (4), `pipeline-bundle` (4), `tool-text` (4). Twelve modules, 7,739 lines. Everything else is
   a leaf. A change to any of those twelve is a change to the whole server half — `lib/scan.js` most of all, because it
   also defines the row shape the SSE payload carries.
3. **`lib/assistant.js` is an application wearing a library's clothes.** Out-degree 21 and 136 imported *names* — four
   times the next-largest consumer (`lib/jobs.js`, 15 modules / 40 names) — against an in-degree of 2 (only
   `server.js` and `lib/restart.js`). It consumes the most and is consumed by almost nobody. It is the top of a stack,
   not the middle.
4. **Leaves are the majority and they are already isolated.** 45 of 83 modules have in-degree 1 — exactly one
   consumer, no dependents — and **32 are imported by nothing but `server.js`**. They are individually replaceable —
   the opposite of the problem the reader is complaining about.
5. **There are no cycles in the ESM half, and the graph is shallow.** A Tarjan sweep finds **0 strongly-connected
   components larger than one node**, and the deepest import chain from `server.js` is **6 hops**. Nothing imports
   `server.js`, so the server half can be cut along any edge without untangling a knot; the only constraint is the
   composition root's own wiring.
6. **Test coverage follows the graph, not the churn.** 60 of 83 modules have a direct test importer; the twelve-module
   spine is nearly all covered (`scan` 3, `jobs` 15, `tree-names` 2, `paths` 2, `todos` 3, `pipeline-bundle` 6). The
   *large* modules are the ones tests avoid touching directly: `server.js` has **0** direct tests, `public/app.js` and
   `public/assistant.js` have 0 node tests (they are covered by 74 browser-driven verify tools and by 32 test files
   that read their source text, §6.1).

### 1.2 The client's real graph: one namespace, one cycle, 78 names

The client has no imports, so its coupling is name visibility. Measured by counting identifiers defined in one file
and mentioned in another (script load order from `index.html`: `dom-format`, `model-menu`, `console-format`,
`console-markdown`, `stream-merge`, `liveness`, `steerable`, `type-stream`, `board/*`, `transport`, `sse`, `app`,
`update-check`, `assistant`).

| reads from → | refs | distinct names |
|---|---:|---:|
| `public/app.js` → `public/core/dom-format.js` | 728 | 13 |
| `public/assistant.js` → `public/core/dom-format.js` | 317 | 6 |
| `public/assistant.js` → `public/app.js` | 230 | 37 |
| `public/app.js` → `public/core/transport.js` | 115 | 3 |
| `public/core/sse.js` → `public/app.js` | 89 | 23 |
| `public/app.js` → `public/board/paste-chips.js` | 85 | 11 |
| `public/board/hot.js` → `public/app.js` | 41 | 9 |
| `public/board/paste-chips.js` → `public/app.js` | 34 | 6 |
| `public/core/update-check.js` → `public/app.js` | 23 | 5 |
| `public/app.js` → `public/core/console-markdown.js` | 17 | 9 |
| `public/core/console-format.js` → `public/app.js` | 16 | 6 |
| `public/core/model-menu.js` → `public/core/dom-format.js` | 16 | 2 |
| `public/app.js` → `public/core/console-format.js` | 14 | 6 |
| `public/app.js` → `public/board/attachments.js` | 14 | 6 |
| `public/core/dom-format.js` → `public/app.js` | 11 | 5 |
| `public/core/transport.js` → `public/app.js` | 11 | 6 |
| `public/core/console-format.js` → `public/core/dom-format.js` | 9 | 3 |
| `public/board/attachments.js` → `public/app.js` | 9 | 2 |
| `public/assistant.js` → `public/core/transport.js` | 8 | 1 |
| `public/app.js` → `public/board/hot.js` | 7 | 5 |
| `public/board/attachments.js` → `public/core/dom-format.js` | 6 | 1 |
| `public/app.js` → `public/core/sse.js` | 5 | 2 |
| `public/core/console-markdown.js` → `public/core/console-format.js` | 5 | 1 |
| `public/core/dom-format.js` → `public/core/console-format.js` | 5 | 1 |
| `public/core/model-menu.js` → `public/app.js` | 5 | 3 |
| `public/core/sse.js` → `public/core/console-format.js` | 5 | 1 |
| `public/core/transport.js` → `public/core/console-format.js` | 5 | 1 |
| `public/board/attachments.js` → `public/core/console-format.js` | 5 | 1 |
| `public/board/hot.js` → `public/core/console-format.js` | 5 | 1 |
| `public/board/paste-chips.js` → `public/core/console-format.js` | 5 | 1 |

Reading it:

- **`public/core/dom-format.js` is the only genuine leaf.** 728 references from `app.js`, 317 from `assistant.js`, 16
  from `model-menu`, 9 from `console-format`, 6 from `attachments`, 2 from `hot` — and it reads back only 5 names
  (`state`, `normPath`, `panelFor`, `isRowLive`, `fmtBytes`). 18 declarations, 183 lines. Nothing else in the client is
  shaped like this.
- **The rest is a cycle, not a layer.** `sse.js` reads 23 `app.js` names, `hot.js` 9, `paste-chips.js` 6,
  `update-check.js` 5, `dom-format.js` 5, `transport.js` 6, `console-format.js` 6, `model-menu.js` 3, `liveness.js` 2,
  `steerable.js` 1, `console-markdown.js` 1, `attachments.js` 2 — **78 distinct `app.js` top-level names are read from
  outside the file.** `app.js` in turn reads `dom-format` (13 names), `transport` (3), `paste-chips` (11),
  `console-markdown` (9), `console-format` (6), `hot` (5), `sse` (2), `attachments` (6). Every "core" module is
  therefore both above and below `app.js`.
- **The shared thing is `state`, and it is mutable.** `state.` property reads: `app.js` 1,141; `assistant.js` 108;
  `sse.js` 33; `paste-chips.js` 22; `hot.js` 18; `update-check.js` 9; `attachments.js` 4; `dom-format.js` 2;
  `liveness.js` 1 — **197 external property reads against one mutable object**. Only 7 client files read no `state` at
  all (`console-format`, `console-markdown`, `model-menu`, `steerable`, `stream-merge`, `transport`, `type-stream`,
  2,557 lines = 8.5% of the client). "Pure core, impure shell" is true of those seven files and of nothing else.

---

## 2. Co-change clusters

200 non-merge commits, `2026-11-01 14:37` → `2026-11-03 16:23` — 37 releases (`0.47.0` → `0.84.0`) in 49 hours.
Of those 200, **101 touch a source file**; 99 touch docs, tests, tools or `package.json` only.

| file | commits |
|---|---:|
| `package.json` | 120 |
| `public/app.js` | 42 |
| `public/style.css` | 36 |
| `server.js` | 30 |
| `lib/assistant.js` | 28 |
| `public/index.html` | 23 |
| `public/assistant.js` | 21 |
| `docs/using-the-board.md` | 16 |
| `lib/assistant/queue.js` | 11 |
| `docs/pipelines.md` | 8 |
| `tools/verify-assistant-queue.mjs` | 8 |
| `lib/jobs.js` | 7 |
| `README.md` | 6 |
| `test/assistant-queue.test.js` | 6 |
| `lib/assistant/config.js` | 6 |
| `test/assistant-settings-split.test.js` | 6 |
| *200 non-merge commits total; 257 distinct paths* | |

### 2.1 The clusters that exist

Named by what moves together, sized by commit appearances (per-file commit counts summed within the cluster; the columns overlap where a file belongs to two clusters):

| Cluster | Files | Commit appearances | Best pairs (support, Jaccard) |
|---|---|---|---|
| **A. Board chrome** | `public/app.js`, `public/style.css`, `public/index.html` | 42 + 36 + 23 = 101 | app+style 21 (.37), app+index 17 (.35), index+style 15 (.34) |
| **B. Assistant vertical** | `lib/assistant.js`, `public/assistant.js`, `lib/assistant/{queue,config,profile,actions,store-file,landed}.js`, `lib/jobs.js`, `server.js` | 28 + 21 + 11 + 6 + 4 + 3 + 2 + 2 + 7 + 30 = 114 | libA+server 12 (.26), libA+client 10 (.26), libA+queue 6 (.18), libA+config 6 (.21) |
| **C. Job lifecycle** | `lib/jobs.js`, `lib/pipelines.js`, `lib/features/spawn.js` | 7 + 4 + 2 | jobs+pipelines 2 (.22), jobs+spawn 2 (.29) — thin, support 2 |
| **D. The substrate** | 50 of 83 `lib/` modules untouched; 24 more touched once or twice | 0–2 | **no partner at support ≥ 2** |
| **E. Release machinery** | `package.json` (+ `tools/version.mjs`, `CHANGELOG.md`) | 120 | 120/200 commits touch `package.json`; not a cluster, a constant |

Two things follow, and they are the load-bearing findings of this lens:

- **A and B are the only real clusters, and they barely talk to each other.** `lib/assistant.js` + `public/app.js`
  share 4 commits (Jaccard .06); `public/assistant.js` + `public/app.js` share 2 (.03). The two workstreams are
  *already* separable by history.
- **The two clusters both have to pass through `server.js`.** 12 of `lib/assistant.js`'s 28 commits and 12 of
  `app.js`'s 42 also touch `server.js`. That is the collision the reader feels: not "the file is big", but
  "the two verticals meet in one file".

Cluster D is worth stating plainly because it is the good news the churn table hides: **50 of the 83 `lib/` modules
were not touched at all in 49 hours, and 24 more moved once or twice.** All the churn in `lib/` is nine files —
`assistant.js` (28), `assistant/queue` (11), `jobs` (7), `assistant/config` (6), `pipelines` (4), `restart` (4),
`own-tree` (4), `assistant/profile` (4), `assistant/actions` (3). The substrate is not where parallel work collides, and
any proposal that starts by reorganising it is solving a problem the history does not show.

| pair | shared commits | Jaccard | A / B commits |
|---|---:|---:|---|
| `lib/assistant.js` + `server.js` | 12 | 0.261 | 28 / 30 |
| `public/app.js` + `server.js` | 12 | 0.2 | 42 / 30 |
| `lib/assistant.js` + `public/assistant.js` | 10 | 0.256 | 28 / 21 |
| `lib/assistant.js` + `lib/assistant/config.js` | 6 | 0.214 | 28 / 6 |
| `lib/assistant.js` + `lib/assistant/queue.js` | 6 | 0.182 | 28 / 11 |
| `public/assistant.js` + `server.js` | 6 | 0.133 | 21 / 30 |
| `lib/assistant/config.js` + `public/assistant.js` | 5 | 0.227 | 6 / 21 |
| `lib/jobs.js` + `server.js` | 5 | 0.156 | 7 / 30 |
| `lib/assistant/profile.js` + `public/assistant.js` | 4 | 0.19 | 4 / 21 |
| `lib/assistant/queue.js` + `public/assistant.js` | 4 | 0.143 | 11 / 21 |
| `lib/assistant.js` + `lib/assistant/profile.js` | 4 | 0.143 | 28 / 4 |
| `lib/pipelines.js` + `server.js` | 4 | 0.133 | 4 / 30 |
| `lib/assistant/profile.js` + `server.js` | 4 | 0.133 | 4 / 30 |
| `lib/assistant/config.js` + `server.js` | 4 | 0.125 | 6 / 30 |
| `lib/assistant/queue.js` + `server.js` | 4 | 0.108 | 11 / 30 |
| `lib/assistant.js` + `public/app.js` | 4 | 0.061 | 28 / 42 |
| `lib/assistant/config.js` + `lib/assistant/profile.js` | 3 | 0.429 | 6 / 4 |
| `lib/assistant.js` + `lib/own-tree.js` | 3 | 0.103 | 28 / 4 |
| `lib/restart.js` + `server.js` | 3 | 0.097 | 4 / 30 |

### 2.2 Commit shape

- 101 source-touching commits, **262 source file-touches** → mean 2.6 files per commit.
- **86 of 101 (85%) touch at least one of four files** (`public/app.js`, `server.js`, `lib/assistant.js`,
  `public/assistant.js`); those four are **121 of the 262 source touches (46%)** and **36,083 of 68,060 source lines
  (53%)**.
- 37 commits touch exactly one source file — and 11 of those are a lone `public/app.js` commit, 6 a lone
  `public/assistant.js`, 6 a lone `lib/assistant.js`. **A single file is already the unit of work for a third of the
  source work; the file just happens to be one of four enormous ones.**

---

## 3. The seams these two measurements support

Each seam below is stated with the measurement that makes it a seam, and with what would be true if it were merely a
preference (so a reader can check me).

### S1 — `server.js` → per-group route modules. **Strongest seam in the tree.**

- It is the file both clusters must edit: 12 shared commits with `lib/assistant.js`, 12 with `public/app.js`.
- The route chain is already an enumeration: **122 `if (route === …)` statements naming 123 paths**, plus one
  `route.startsWith("/api/approvals/")` prefix branch, covering **3,017 of 5,344 lines (56%)**.
- **The pattern already exists and is proven**: `createQueueRoutes`, `createPipelineWindowRoutes`,
  `createPipelineCatalogueRoutes` (`lib/assistant/queue.js:1188`, `lib/pipeline-window.js:207`,
  `lib/task-pipeline-assign.js:178`), each taking its deps as named arguments and returning `false` to fall through
  (`server.js:2068–2074`). Three modules, one interface. Nothing has to be invented.
- The groups are large enough to be worth a file and small enough to move: worktree 13 branches / 820 lines, assistant
  23 / 293, settings 14 / 274, remote-write 8 / 243, jobs 11 / 184, refresh 3 / 172, pipelines 2 / 89.
  **The top five groups are 1,814 lines and 69 of the 122 branches.**

| group | branches | lines | span in `server.js` |
|---|---:|---:|---|
| `/api/worktree` | 13 | 820 | 2662–4915 |
| `/api/assistant` | 23 | 293 | 2369–2661 |
| `/api/settings` | 14 | 274 | 2105–4356 |
| `/api/remote-write` | 8 | 243 | 3469–3737 |
| `/api/jobs` | 11 | 184 | 3385–4401 |
| `/api/refresh` | 3 | 172 | 4228–4613 |
| `/api/pipelines` | 2 | 89 | 2156–2244 |
| `/api/agents` | 3 | 85 | 3738–3910 |
| `/api/steward` | 3 | 59 | 2982–3040 |
| `/api/hosts` | 3 | 57 | 2925–2981 |
| `/api/project` | 1 | 56 | 4955–5010 |
| `/api/sessions` | 2 | 55 | 4109–4163 |

- *If this were a preference rather than a seam:* the route bodies would be thin adapters over the same helpers. They
  are not — the worktree group alone carries 820 lines of merge/rebase/transfer/child-pipeline logic (largest single
  branch: `POST /api/worktree/merge`, 147 lines).

**The catch the churn measurement adds:** the groups are **interleaved, not contiguous**. Worktree branches span lines
2662–4915; assistant branches sit at 2369–2661 *inside* that span; settings at 2105 and again at 4356. The chain is
ordered by arrival, not by subject. So each extraction is a gather across the whole chain — see §5.3.

### S2 — The board-chrome trio is one workstream, not three files.

`app.js` + `style.css` + `index.html` co-change 21/17/15 — the three strongest pairs in the repo. `style.css` has
**36 commits, more than `server.js`'s 30**; `index.html` 23. Any plan that splits `app.js` into 30 modules and leaves
`style.css` as one 3,762-line file has moved the collision, not removed it: a UI change still writes CSS for the same
feature in one shared stylesheet. *If this were a preference:* the pairs would be incidental (two files touched by the
same reformat). They are not: they are the same feature landed in markup, script and style, 21 times.

### S3 — The assistant is one vertical and should be one owner, not a split.

It is the only dense cluster (9 files, 114 commit appearances) and its internals are already partitioned the right way:
`lib/assistant/` is the only real subpackage in `lib/` — 11 of the 16 modules that live in subdirectories — and
`lib/assistant/read.js` is a perfect leaf:
**in-degree 9, out-degree 0**, imported by `actions`, `audit`, `charter-file`, `match`, `profile`, `queue`,
`lib/assistant.js`, `assistants.js`, `roles.js`. What remains in `lib/assistant.js` is **one 5,193-line class with 21
imports and 136 imported names**. *If this were a preference:* the client half would not track it — but
`lib/assistant.js` + `public/assistant.js` co-change 10 times, and the client file is a single 4,178-line IIFE with
zero top-level declarations, i.e. the same shape.

### S4 — `public/core/dom-format.js` is a real cut point; the other `public/core/*` files are not yet.

dom-format is the only client file that is depended on heavily and depends on almost nothing (§1.2). The other
"core" files are value→value *in intent* but still reach back into `app.js` for `state` and render helpers. *If this
were a preference:* dom-format's header would not already declare exactly what it reaches for at call time — it does,
and the list is 5 names.

### S5 — The `lib/` substrate is an already-working seam — leave it.

50 of 83 modules were not touched at all in 49 hours and 24 more moved once or twice (§2.1, cluster D); in-degree is
≤ 2 for all but twelve, and 60 modules have a direct test. This is the part of the tree that several agents can
already work in simultaneously, today, with nothing to change. The exception is `lib/scan.js` (in-degree 11, row
shape, read path) — the one place where "just add a field" ripples to 11 importers and the SSE payload.

---

## 4. Which split lets several agents work without touching the same file

The reader's complaint is a contention problem, so I measured contention directly rather than arguing from file size.

**Today, the guaranteed shared file is not the one anyone expects.** `package.json` is touched by **120 of 200 commits
(60%)** and cannot be avoided: `.githooks/pre-push` runs `tools/version.mjs check`, which refuses a push whose branch
carries commits without a version bump. Two agents landing at once *will* edit the same three lines of
`package.json`. No module split can fix that; it has to be serialized at landing (which is what the landing-turnover
model already does). **This is the first thing to state in any parallel-work proposal, and a pure responsibility view
misses it entirely because the file is not source.**

### 4.1 Measured contention

| | commits (of 200) | share of source touches | notes |
|---|---:|---:|---|
| `package.json` | 120 | — (not source) | enforced by the pre-push gate |
| `public/app.js` | 42 | 16% of 262 | 11 of them touch nothing else |
| `public/style.css` | 36 | — | UI changes, with app.js 21 times |
| `server.js` | 30 | 11% | both verticals pass through it |
| `lib/assistant.js` | 28 | 11% | 5,193 lines, one class |
| `public/index.html` | 23 | — | 17 with app.js |
| `public/assistant.js` | 21 | 8% | one 4,178-line IIFE |

### 4.2 The split that buys the most, in order

**R1 — `server.js` route factories (do this first, once, by one agent).** It removes the *cross-workstream* collision:
after it, an assistant route and a worktree route are different files. Evidence: 69 of 122 branches in five groups;
pattern already present in three modules; both clusters currently meet here. Extraction is a gather (§5.3), so it is
the one step that must be serialized — and after it, the two verticals stop sharing any file but `package.json`.

**R2 — Board chrome as one workstream (`app.js` + `style.css` + `index.html`), assistant as the other.** Evidence:
21/17/15 co-change within A, 4/2 co-change between A and B. This is the only two-way partition the history supports,
and it is the cheapest parallelism available: it requires *no code move at all*, only an ownership rule.

**R3 — `app.js` split by feature vertical, not by layer.** Here the measurement contradicts the intuitive plan. I cut
`app.js` into N equal-line modules *at its existing 143 marker boundaries* and asked what fraction of pairs of its 42
commits would still share a module:

| K | pair-collision | commits in one module |
|---:|---:|---:|
| 1 | 100% | 100% |
| 2 | 86% | 52% |
| 4 | 59% | 50% |
| 8 | 42% | 43% |
| 12 | 37% | 33% |
| 16 | 31% | 31% |
| 24 | 31% | 31% |

**A positional split of `app.js` caps out at roughly a 3× reduction and stops improving past 16 files.** The reason is
in the hunk data: a median `app.js` commit lands in **2 of 43** 500-line regions but **3 of 143** sections, and its 42
commits touch **37 of 43 regions**. It edits a helper near the top, a renderer in the middle and a handler near the
bottom — the classic vertical slice through a horizontal file. So the split that works is the one that moves the
helper, the renderer *and* the handler for one feature into one file; a layer split (`core/` vs `features/`) reduces
imports but leaves each feature commit touching 2–3 files. Same curve for the other three mega-files, and it is worse:
`lib/assistant.js` 74% collision at K=12, `public/assistant.js` 72%, `server.js` 48% (its 30 commits concentrate 51
of 92 hunks in the 2,057-line header, not the routes).

**R4 — `lib/assistant.js` (the class) → the concern boundaries already present in `lib/assistant/`.** Not a win on
collision (its 28 commits touch 10 of 11 regions, mean 2.93), but a win on ownership: the vertical's server half is one
file, and the submodules it already exports to are the seams the history recognises.

**What remains shared after R1–R4:** `package.json` (serialized at landing), `public/index.html` (script order — every
move edits one line), `lib/scan.js` (row shape), and the 78-name client surface. That is a plan an agent can work
inside: two workstreams, one landing gate, one row-shape contract.

---

## 5. What breaks first if this is done naively

Ordered by how soon it bites, with the number that makes it concrete.

### 5.1 The marker comments are a test API, not comments — and the split breaks the suite first

**32 test files read `public/app.js` as raw source text; 7 read `public/assistant.js`; 19 `tools/*.mjs` read
`app.js`.** Most assert on a *slice*: `test/agent-cleanup.test.js:25,97` does
`src.indexOf("// ---- whether an agent may clean up after itself")` … `src.indexOf("// ---- end agent cleanup")` and
then executes the slice; `tools/panel-testkit.mjs` exposes `sliceRegion`/`sliceBetween` with the same contract. Move a
section to another file without carrying *both* markers and the test fails with "the region is in public/app.js" —
a failure with zero behavioural content. First breakage after a naive split is the test suite, before the page is
ever loaded. Mitigation is mechanical: the slice's marker pair travels with the code and only the path changes (the
existing plan says this too, and it is right).

### 5.2 Load order is the import graph, and the first 330 lines are a TDZ minefield

`index.html` loads 16 classic scripts; nothing declares a dependency. Two failure modes, both already observed in this
file's own history (its header comments record them):

- **TDZ at boot.** `const` declarations read while the `state` literal is being built throw, and the loader's
  `try/catch` swallows the `ReferenceError` — the panel then boots with an empty setting. The file's own comments name
  three casualties (`SPAWN_HISTORY_KEY`, `PROJECT_HUE_KEY`, `TREENAMES_KEY`). A module split that moves any of the
  first 330 lines must move them with `state`'s construction, not with their concept.
- **Silent duplicate implementations.** `fmtBytes` is declared **twice at top level**: `public/core/dom-format.js:171`
  (KB/MB only, `Math.max(1, round(bytes/1024))`) and `public/app.js:20903` (B/KB/MB/GB/TB, 1024-based, `"0 B"` for
  zero). Both are function declarations in classic scripts, so the later one wins for the bare name and the difference
  is invisible — `fmtBytes(500)` is `"1 KB"` through one name and `"500 B"` through the other. `dom-format` publishes
  its copy on `WMApp.core.domFormat` and its comment says "Nothing reads it yet: app.js still calls the bare names".
  The moment a split makes a call site use the namespace object instead of the bare name, every byte figure in the UI
  silently changes format. **This is the single most likely quiet regression in a client split, and a text-based move
  is exactly what triggers it.**

### 5.3 `server.js` handlers close over module-level singletons, and the groups are interleaved

- The route bodies are inside `createServer(async (req, res) => …)` and read module-scope singletons declared
  hundreds of lines above them: `store` (:357), `hosts` (:365), `registry` (:391), `scheduler` (:400), `jobs` (:475),
  `approvals` (:543), `remoteWrites` (:709), `locks` (:754), `questions` (:996), `todos` (:1039), `releases` (:1076),
  plus `config`. A copy-paste extraction produces `undefined` at *request* time for one route, not an import-time
  error — the failure is a 500 on a specific method+path.
- The groups are interleaved (worktree spans 2662–4915 with assistant and settings branches inside it), so the first
  extraction rewrites the whole chain. Done as several concurrent PRs, every one of them conflicts with every other.
  **Do the route extraction as one serialized change, or not at all.**

### 5.4 The client's API is 78 names plus one mutable object

Any split must publish exactly those 78 names (they are the de-facto export list) and pass `state` — 197 external
property reads across 8 files. A module that takes `state` as a parameter rather than a global is already a different
program for every one of those call sites; a module split that keeps `state` global has not decoupled anything. The
honest sequence is: split, keep `state` global (no call-site change), *then* narrow each module's declared inputs —
otherwise you are rewriting 1,141 internal property reads at the same time as moving 21,000 lines.

### 5.5 The release gate

`package.json` is touched by 60% of commits and the pre-push hook refuses a landing without a bump. Parallel branches
that each bump from the same base conflict on the same three lines at the second landing. This is not a code problem
and it is the most frequent one; it needs an explicit rule (bump at landing, not at branch cut) rather than a tool.

### 5.6 Tools that hash the served file

`tools/measure-console-drift.mjs:732`, `measure-console-grab.mjs:309`, `measure-console-soak.mjs:682`,
`measure-console-writes.mjs:903` compare the *served* `app.js` against the on-disk `app.js` by sha256. A split makes
that comparison meaningless (the served bytes are now N files), so these four measurements would silently start
asserting "identical" on a file that no longer contains the code. They are cheap to fix and easy to forget.

---

## 6. Where my numbers disagree with the tree's own documents

I measured first and read the repo's docs afterwards, so these are deliberate checks rather than inherited claims.

| Document | Its claim | Measured at `cc61bb9` | Drift |
|---|---|---|---|
| `docs/architecture.md:50` | `server.js` 4,304 lines, 104 route branches | **5,344 lines, 122 `route ===` statements / 123 paths** | +24% lines, +18% routes |
| `docs/architecture.md:51` | `lib/` 76 modules, 28,212 lines | **83 modules, 32,581 lines** | +9% modules, +16% lines |
| `docs/architecture.md:52` | `public/` 23,295 lines, 14 classic scripts | **30,071 lines, 16 classic scripts** | +29%, +2 files |
| `docs/architecture.md:666` | `app.js` 17,178 lines, 668 top-level functions | **21,368 lines, 829 functions (1,080 top-level declarations)** | +24%, +24% |
| `docs/split-public-app-plan.md:3` | measured at 0.53.2; `app.js` 18,426 lines, 118 markers, 714 functions | **21,368 / 143 markers / 829** | +16%, +25 markers, +16% |
| `docs/split-public-app-plan.md:32` | "22 of the 31 test files that read `public/app.js`" | **32 test files read it; 38 read it or `public/assistant.js`** | +10 files (definitions differ: any read vs marker-slice) |

The plan's landing order (S1–S7, cheapest blast radius first) is defensible on *its* grounds — pure sections first, and
it puts the marker-slice tests to work as the proof. My hunk measurement argues for one amendment rather than a
rewrite: **its unit of landing is a section, but a median `app.js` commit crosses three sections**, so sections landed
individually will spend most of their diff budget on the glue between them. Landing by *vertical* (a feature's state +
renderer + handler together) matches the commit shape; landing by *section* matches the file's comments. The
difference is measurable in the K-curve above: section-shaped moves give ~3× collision relief, vertical moves give
1-file-per-commit.

---

## 7. Limits of this lens — what I did not measure

- **Name references are not calls.** The client table counts identifiers appearing in another file; a name mentioned
  in a comment or a string counts. The 78-name figure is an upper bound on the API, the `state` count a lower bound on
  the coupling.
- **Hunk regions drift.** Each commit's `+N` line is in that commit's own revision; the *count of distinct regions* is
  the stable statistic, not the region identity.
- **Two days is a short window.** 200 commits is 37 releases, which makes churn and co-change strong; it also means
  any file that changed once looks "stable". I would not read cluster D's silence as proof of health, only as proof
  that it is not where *this week's* contention is.
- **No runtime profiling.** I did not measure time or memory, only structure; `docs/arch-review-efficiency.md` is the
  place for that and I did not re-derive it.
- **The snapshot is 6 commits behind `origin/main`** (0.85.0 adds `lib/provider-profiles.js` +282 lines in `app.js`),
  and those 6 commits are themselves a textbook vertical: `app.js` + `server.js` + `index.html` + `style.css` + one new
  `lib/` module + tests. If anything, the live tip strengthens §4 rather than weakening it.

---

## 8. Reproduction

```sh
# import graph (88 nodes, 184 edges)
node <scratch>/graph.mjs "$PWD"            # prints the table, writes graph.json

# client name coupling + duplicate declarations
node <scratch>/browser-coupling.mjs

# churn, co-change pairs, clusters over the last 200 commits
node <scratch>/cochange.mjs "$PWD" 200

# hunk geography + the K-way split curve
node <scratch>/hunks.mjs
node <scratch>/split-curve.mjs
```

(The scripts live in `C:/Users/roper/AppData/Local/Temp/wag/f5b8f89f/`; they are throwaway probes, not part of the
repo.)

## 9. The three numbers I trust most

1. **121 of 262 source file-touches (46%) land in four files that are 53% of the source lines** — the contention is
   real, and it is concentrated, not diffuse.
2. **86 of 101 source-touching commits (85%) touch at least one of those four** — so no ownership rule short of
   splitting them changes anything.
3. **A positional split of `app.js` reduces pair-collision only to 37% at 12 modules and stops improving at 31%** —
   which is why the seam has to be vertical (feature + its state + its renderer), and why `server.js`'s route groups
   (48% at K=12, with the pattern already in use three times) are the better first move.
