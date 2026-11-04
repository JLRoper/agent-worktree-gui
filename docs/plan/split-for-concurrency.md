# Splitting for concurrency — the implementation plan

**Measured at `origin/main` `f0b52a3` (`package.json` 1.6.0), 2026-11-04.** This branch is cut from that tip.
Every number below was re-read in this worktree; §1 marks the cells I could not reproduce, and no stage is ordered
by an unconfirmed number. Line numbers drift with every landing, so each anchor is given with the text to search
for, and Stage 0 re-reads them before a stage edits anything.

**The branch carries the bump this PR lands as 1.6.2.** v1.6.1 is already anchored by a live sibling branch
(`wtgui/give-pr-369-s-landed-fea-72dc53`), and a version is anchored once.

**This is the plan the review asks for.** `docs/reviews/split-for-concurrency.md` (364 lines at this tip) aggregates
`split-server.md`, `split-public-app.md` and `split-lib.md` into three cuts and the collisions they leave. This
document turns those cuts into **ten landable stages**, names each stage's files, the **one shared file** it must
rebase around, the proof it owes before it may land and where it stops, and states plainly which stages may be in
flight together. It is the order a crew starts from, not a second map of the tree.

**Docs only.** This landing touches this document, `CHANGELOG.md` and `package.json` (the version the landing
carries); nothing under `server.js`, `lib/`, `public/` or `test/`. Those are other rows' lane today (§9).

**The shape.** Stage 0 is the rebase check every stage begins with. Stage 1 is the client console extraction — the
one cut that unlocks eight parallel authors and shares no file with the library. Stages 2–8 are the seven `lib/`
cluster moves in the review's order: PIPELINES → SERVER → INSTALL → WATCH → LANDING → RUNS → ASSISTANT. Stages
9–10 are `server.js`'s two parallel route waves, 2 and 4. **Landing concurrency is 1 on every surface**:
`package.json` is the gate (§5.4). Authoring concurrency is what §6 allows.

---

## 0. The stages at a glance

| # | Stage | What it produces | The ONE shared file | Entry condition |
|---:|---|---|---|---|
| **0** | Rebase check | no diff — a re-based branch and re-read anchors | none | every stage begins here |
| **1** | Client console | `public/board/console.js` + the deletions in `app.js` | `public/app.js` | Stage 0 only |
| **2** | PIPELINES | `lib/pipelines/` (6 files) | `server.js` | Stage 0 |
| **3** | SERVER | `lib/server/` (10 files) | `server.js` | Stage 0; S2 lands first if both are in flight |
| **4** | INSTALL | `lib/install/` (6 files) | `server.js` | Stage 0; S2 lands first if both are in flight |
| **5** | WATCH | `lib/watch/` (11 files) | `server.js` | Stage 0 |
| **6** | LANDING | `lib/landing/` (15 files) | `server.js` | Stage 0; S5 lands first if both are in flight |
| **7** | RUNS | `lib/runs/` (18 files) | `server.js` | Stage 0; after S6, never beside S8 |
| **8** | ASSISTANT | `lib/assistant/` (6 root files move in) | `server.js` | Stage 0; after S7, never beside S7 |
| **9** | Server wave 2 | `lib/routes/{pipelines,todos,approvals}.js` | `server.js` | wave 0 (the route seam) is on `main`; after S8 |
| **10** | Server wave 4 | `lib/routes/{panel-io,projects}.js` | `server.js` | Stage 0; after S9 |

Nine of the ten stages rebase around the same file, `server.js`. That is the plan's central fact: the order below is
a queue for one file, and the only parallelism is around it, not inside it.

---

## 1. What was re-measured, and what was not

Main moved 1.4.2 → 1.6.0 today, and moved again while this plan was being written: `server.js` and
`public/app.js` were unchanged between the review's tip `92d5fcc` (1.5.5) and `75ec220` (1.5.6), and then the
1.6.0 landing grew `server.js` by **103** lines and `public/app.js` by **62**. The review's headline sizes are
therefore 103 and 62 lines short at this tip, and its line-region table is the 1.4.0 page's, 198–201 lines short.
§1.1.

| Number | The review / pages say | At `f0b52a3` | Status |
|---|---|---|---|
| version | 1.5.6 | **1.6.0** | confirmed |
| `server.js` | 5,968 lines; `createServer` at 2,465; 469 `return sendJson(`; 54 static `lib/` specifiers | **6,071 / 2,528 / 476 / 54** (+2 `await import()`) | confirmed |
| dispatch | 137 conditions (136 `===`, 1 prefix); 138 path mentions; 125 distinct paths | **137 blocks** (136 `===`, 1 `startsWith`), **138 mentions**, **125 distinct**; the two-path block is `/api/state`+`/api/audit` at 3,521; the prefix is `/api/stream` at 5,809; span 2,546–5,809 | confirmed |
| routes | 132 routes + 5 spine; 141 API paths | **132 group blocks + 5 spine = 137 blocks**; 138 inline mentions + 3 mounted adapters = **141 paths** | confirmed — the 132 counts blocks, not paths |
| `public/app.js` | 22,818 lines; 1,151 top-level names (790 `function`, 89 `async function`, 199 `const`, 73 `let`); 879 on `window` | **22,880 content lines** (`wc -l` 22,879); **1,154 names (792/90/199/73); 882 on `window`** | confirmed |
| `public/style.css` | 4,155 lines; 917 classes; 448 only in `app.js`, 154 only in `assistant.js` | **4,181 content lines** (`wc -l` 4,180); my selector parse: **920** classes, **378 / 153** by my name match | line count confirmed; the 917/448/154 split **unconfirmed** — not used below |
| `lib/` | 88 files that are not the test; 36,449 lines; 143 import edges | **88** (87 ESM + `panel-restart.cjs`); **36,468 content lines** (`wc -l` 36,467 — `restart.js` has no trailing newline); **143 relative edges under `lib/`** (142 module→module + `jobs.test.js`) **+ 1** to `public/core/steerable.js` = 144 relative specifiers | confirmed |
| co-change window | 259 commits touching `lib/`; the 28-pair matrix | **260**; every cell reproduced — ASSISTANT+RUNS **17**, `assistant.js`+`jobs.js` **16**, `assistant.js`+`assistant/config.js` **17**, PIPELINES **0** with SERVER/WATCH/INSTALL/LANDING, WATCH+LANDING **4**, RUNS+WATCH **10**, RUNS+SERVER **9**, RUNS+LANDING **9** | confirmed cell for cell |
| admission | 8 `jobs.create` calls across four clusters, "four routes, four option sets" | **8 calls**: 2 ASSISTANT (`assistant.js:3,733`, `:5,778`), 2 LANDING (`features/spawn.js:236`, `:270`), **3** SERVER routes (`server.js:4,459` `/api/agents`; `:5,468` merge; `:5,600` verify-landed) + **1** in `startThreadReply` (`server.js:1,270`) — a helper shared by the reply route and the stage-timer wake, **not a route**; the definition is `lib/jobs.js:2,375` | count confirmed; "four routes" corrected |
| `index.html` script block | 782–828 | **789–835**, 17 `<script src>` lines; `/app.js` at **829** | corrected (the review repeated the 1.4.2 range) |
| server wave 2 regions | 2,476–2,563; 3,895–3,921; 3,928–3,966 | **2,674–2,689 + 2,701–2,761** (pipelines); **4,096–4,122** (approvals); **4,129–4,167** (todos) | corrected, +198/+201 |
| server wave 4 regions | 3,331–3,412 vs 3,419–3,522; 3,887–3,889 vs 3,864–3,867 | **3,529–3,610** vs **3,617–3,690**; **4,085–4,090** vs **4,062–4,065** | corrected, +198 |
| console region | 166 units, 2,263 lines; spans 1,521–2,360 / 4,076–4,493 / 7,389–9,648 | spans **unchanged** — the 185 added `app.js` lines since `1e1c595` are all in Settings (19,004, 21,773) and the deliverable list (18,025–18,477); the unit and line counts were **not re-counted** | spans confirmed; counts **unconfirmed** |
| console harnesses | "two tests cut its markers, four more read its helpers, one imports a module" | **16** test files read a console region out of `public/app.js` (§3.1) | corrected |
| test suite | 168 files | **169** `test/*.test.js` | confirmed |
| `jobs.test.js` | 449 lines beside `jobs.js` | **449**, its one import at line **29** | confirmed |

### 1.1 The wave regions are 198–201 lines stale, and not uniformly

The review's §3.1 table gives `2,476–2,563; 3,928–3,966; 3,895–3,921` for wave 2 and `3,331–3,412 vs 3,419–3,522;
3,887–3,889 vs 3,864–3,867` for wave 4. Those are `split-server.md`'s numbers at `e2358c5` (1.4.0), where
`server.js` was 5,833 lines. This tip is 6,071: the 1.4.0 → 1.5.6 landings added **135**, and the 1.5.5 → 1.6.0
landing added **103** — 63 lines of helpers before `createServer`, 3 in `/api/deliverables`, and 37 in
`/api/deliverables/open`. So the offset is **+198** before `/api/deliverables` and **+201** after its three added
lines. The blocks are still contiguous and disjoint, so the review's conclusion ("wave 2 is three parallel groups,
wave 4 two") survives; its numbers do not, and a crew that adds one constant to every region lands a boundary in the
wrong place. Stage 0 re-reads each block by its path, not by a remembered number.

### 1.2 The console's spans survived; its counts did not

`public/app.js` grew by 185 lines since `1e1c595`: 123 in Settings (19,004–19,121 and 21,773–21,775) and 62 in the
deliverable list (18,025–18,477). The console's markers are still where the public page left them (`// ---- tool
group key` at 2,225, `// ---- reasoning first` at 7,389, `// ---- console row text` at 7,586, `// ---- console
writers` at 7,820, `// ---- copy buttons` at 8,361, `// ---- the reader's own input` at 8,578), so the region's shape
is confirmed. Its **166 units / 2,263 lines** were not re-counted and are marked unconfirmed; the plan never uses
them as a denominator.

### 1.3 The admission map's fourth "route" is a helper

`server.js:1,270` is inside `startThreadReply` (opens at 1,245), which the reply route and the stage-timer's wake
both call — it is not a dispatch block and not a route. The other three server calls are route blocks. This changes
nothing about the count (8 call sites, four clusters) or about §5.2, but a plan that schedules "four routes" would
go looking for a fourth block that does not exist.

### 1.4 The per-cluster cost column reproduces exactly

Re-measured with the lib page's own definition — the cluster's own outbound edges, its outside importer files, and
`server.js`'s specifiers — every number in `split-lib.md`'s §7 cost column reproduces at this tip:

| Step | Cluster | Own outbound | Outside importers | `server.js` specifiers | Total (the page's number) |
|---:|---|---:|---:|---:|---:|
| 1 | PIPELINES | 1 | 2 | 3 | **6** |
| 2 | SERVER | 2 | 0 | 9 | **11** |
| 3 | INSTALL | 3 | 5 | 5 | **13** |
| 4 | WATCH | 4 | 8 | 9 | **21** |
| 5 | LANDING | 10 | 4 | 13 | **27** |
| 6 | RUNS | 5 | 9 | 10 | **24** |
| 7 | ASSISTANT | 7 | 1 | 3 | **11** |

The RUNS "9 outside importers" includes `lib/jobs.test.js`, which imports `./jobs.js` but is not a cluster member.
The ASSISTANT "1 importer" is `lib/task-pipeline-drive.js`, which imports `lib/assistant/queue.js` — a file that
does **not** move in step 7.

---

## 2. Stage 0 — the rebase check every stage begins with

Main will have moved by the time anyone starts. Every stage runs this **before it edits a file**, and its result is
recorded in the stage's PR body: the base SHA it rebased onto, and the three anchors it re-read.

```sh
git fetch origin --prune
git rev-parse --short HEAD origin/main
git merge-base --is-ancestor origin/main HEAD || git rebase origin/main
node tools/version.mjs check
git status --porcelain
```

**Pass** means all five: `HEAD` contains the current `origin/main` tip; the branch is not a merge of main (rebase,
never merge — this is a landing branch); `tools/version.mjs check` says the branch's number is above main's;
`git status --porcelain` is empty before the first edit; and the stage's own anchors are re-read (each stage section
gives the marker to grep and the number to re-count).

**Then the lane check.** The stage's one shared file must not be held by an unlanded branch:

```sh
git worktree list
git for-each-ref --format='%(refname:short)' refs/remotes/origin/wtgui |
  while read b; do n=$(git rev-list --count origin/main.."$b" -- server.js); [ "${n:-0}" -gt 0 ] && echo "$b $n"; done
```

A branch with commits in the shared file is not a blocker by itself — the panel's queue decides the landing — but
two authors in the same file whose work is not yet pushed is a conflict to resolve before the first edit, not after.

**Stop.** If the rebase conflicts in the stage's shared file, stop and re-cut the branch from the new tip. Resolving
a rebase conflict inside `server.js` means two decisions are being merged by hand, which is exactly what the queue
exists to prevent. A rebase conflict in a file the stage does not touch is resolved normally.

Stage 0 produces no diff and lands nothing. It is the first line of every stage's PR body.

---

## 3. The stages

Each stage is **one landing**: one branch, one squash-merge, one `package.json` bump. **Every stage below begins with
Stage 0**; the entry-condition column in §0 names only what is additional to it. It stops at the boundary named under
**Stop**. A stage that finds itself editing a file outside its **Edit set** has drifted; stop and re-cut.

### 3.1 S1 — the client console, `public/board/console.js`

**Produces.** `public/board/console.js`: the console's declarations — tool-burst bookkeeping, the tool call as a
row, the sub-console, reasoning pacing, the console row text and markdown, the console writers, copy and motion,
the reader's input and scroll, `appendJobLine`/`drawJobLine`. The public page's unit and line counts (166 / 2,263)
are unconfirmed (§1.2); the spans are confirmed by the markers named there.

**Edit set.**
- `public/board/console.js` — new.
- `public/app.js` — delete those declarations. **Keep** the five `state.*` blocks: `state.collecting` at 4,224; the
  sub-console fields at 4,440–4,448; `state.thinkCache`… at 7,201–7,206; `state.typePacer`/`state.typeGate` at
  7,373–7,376; `state.outPinned` at 8,577. They are top-level statements that read `state` and call app.js's
  `typeWordSpeed`/`typeLineRate` at load, and `console.js` is evaluated **before** `app.js`. They are wiring for
  this landing, not declarations.
- `public/index.html` — one line, `<script src="/board/console.js"></script>`, at **829**, immediately before
  `/app.js` and after `/pipeline-modal.js`.

**The ONE shared file.** `public/app.js`. A second worker cannot delete from it at the same time; S1 holds it.

**Hot files.** `public/app.js` claimed. `public/style.css` **not** claimed (no class changes). `server.js` and
`lib/jobs.js` not claimed.

**Why the script order, and what it forbids.** A classic script's top-level `function` is a `window` property and a
top-level `const`/`let` is a lexical binding a later script can read by bare name; a second top-level `const` of one
name in a later script is a `SyntaxError` that kills that script alone. `app.js`'s boot IIFE at 22,848 calls the
console's renderers, so `console.js` must be evaluated first — and because it is first, it **may not call an app.js
name at top level**, and the five `state` initialisations stay behind. Moving declarations only is what makes this
safe; the page's §6 rule ("a listener that calls a bare name does not care which file declares it") is the licence.

**Proof.**
1. **No duplicate declaration.** The top-level census of `public/board/console.js` and of `public/app.js` must be
   disjoint, in both directions:

   ```sh
   names() { grep -oE '^(async )?function [A-Za-z_$][A-Za-z0-9_$]*|^(const|let) [A-Za-z_$][A-Za-z0-9_$]*' "$1" | awk '{print $NF}' | sort -u; }
   comm -12 <(names public/app.js) <(names public/board/console.js)   # must print nothing
   ```

2. **The console's free names resolve.** Every name `console.js` reads but does not declare must exist in
   `app.js` or a `core/` script; the six page-facing console names (`programmaticScroll`, `restoreThinkBodies`,
   `settleScrolls`, `applyStoredScrolls`, `restoreScrolls`, `captureScrolls`) must still resolve after the cut.
3. **The harnesses re-point in the same commit.** 16 test files read a console region out of `public/app.js`:
   `console-row-text`, `result-row-head`, `console-typed-line` (marker slices through `readSource`/`sliceRegion`,
   which **throws** on a missing marker), and `console-call-note`, `console-column-fit`, `console-fold-hold`,
   `console-height-store`, `console-independence`, `console-input-scope`, `console-tail-pin`, `tool-call-rows`,
   `tool-group-key`, `tool-output-expand`, `tool-usage-group`, `placed-nodes`, `reasoning-hold` (their own
   `readFileSync` + `indexOf` slices). `console-independence` reads **both** the console region and the shell's
   `reorderProjects`/`sweepStaleBoard`; it re-points only the console half. A missed re-point is red, not green.
4. `npm test` — 169 files.
5. **Boot the page.** No `SyntaxError` in the browser console; `typeof captureScrolls`, `typeof lineHtml`,
   `typeof burstGroups`, `typeof thinkHtml` are `"function"` on the page.

**Stop.** At the declarations. `cards` is the next cut and cannot start until this lands (13 alternations between
the two regions); it is not in this stage. All wiring stays in `app.js`. No CSS. The optional `normPath`/`fmtBytes`
move into `core/dom-format.js` is a separate two-name landing and does not affect the parallelism measure.

### 3.2 S2 — PIPELINES → `lib/pipelines/`

**Moves.** 6 files, 2,604 lines: `pipeline-bundle.js`, `pipeline-window.js`, `pipelines.js`,
`task-pipeline-assign.js`, `task-pipeline-drive.js`, `task-pipeline.js`.

**Edit set** (4 files): `server.js` at **38, 79, 81**; `lib/assistant.js` at **165, 168, 170**; `lib/jobs.js` at
**44**; `lib/task-pipeline-drive.js` — its one outbound edge to `assistant/queue.js` becomes `../assistant/queue.js`.
The page's cost is **6** = 1 own outbound + 2 outside importers + 3 server specifiers.

**Harness re-point.** 10 test files and 3 tools import a moved module; every specifier changes in this commit
(§7.9).

**The ONE shared file.** `server.js`.

**Hot files.** `lib/jobs.js:44` claimed — one line, and the reason this stage cannot be in flight with anything that
edits `jobs.js`'s import block. `server.js` claimed.

**Proof.** The common gate (§7) plus: the old path has no importer outside the folder — `git grep -n 'pipelines.js"' --
server.js lib test tools` shows only files inside `lib/pipelines/` pointing at each other; the specifier checker
(§7.2) resolves `lib/pipelines/` to 0 unresolved; boot answers `GET /api/pipelines` and `GET /api/state`.

**Stop.** At the path move. No split of `pipeline-bundle.js`; no touch of `public/pipeline-flow.js` or
`public/pipeline-modal.js`; no renamed export.

### 3.3 S3 — SERVER → `lib/server/`

**Moves.** 10 files, 2,267 lines (`wc -l`; 2,268 content lines): `build-version.js`, `http/transport.js`,
`http/static.js`, `sync-state.js`, `chart-columns.js`, `open-url.js`, `panel-restart.cjs`, `port-guard.js`,
`restart.js`, `store.js`. `http/` stays a subfolder (`lib/server/http/…`). `panel-restart.cjs` moves **with**
`restart.js` in the same commit: `restart.js:1119` resolves it as `path.join(here, "panel-restart.cjs")`, so a split
move breaks panel restart at the worst moment.

**Edit set** (3 files): `server.js` (9 specifiers); `lib/http/transport.js` and `lib/restart.js` (2 own outbound
edges). No module outside the cluster imports into it — its only consumer is `server.js`.

**Harness re-point.** 16 test files and 4 tools import a moved module (§7.9).

**The ONE shared file.** `server.js`.

**Hot files.** `server.js` only.

**Proof.** The common gate, plus: `lib/server/http/` resolves; `node --check lib/server/panel-restart.cjs`; boot
`GET /api/health` and `GET /api/build`.

**Stop.** At the path move. The three `create*Routes` adapters (`assistant/queue.js:1,233`,
`pipeline-window.js:212`, `task-pipeline-assign.js:186`, mounted at `server.js:954/958/961`) stay where they are — a
cluster move is not the landing for a design change. No store or restart behaviour.

**If the route seam (wave 0) landed before this stage**, S3's edit set grows by every `lib/routes/*.js` file that
imports a moved SERVER module (`grep -l 'lib/http/transport' lib/routes/*.js`). If wave 0 has not landed, S3 is
unchanged and wave 0 must import `lib/server/http/transport.js` from the start.

### 3.4 S4 — INSTALL → `lib/install/`

**Moves.** 6 files, 2,203 lines: `hermes-config.js`, `hermes-runtime.js`, `gateway-permissions.js`,
`hermes-models.js`, `provider-profiles.js`, `skills.js`.

**Edit set** (9 files): `server.js` (5 specifiers); the 5 outside importers — `lib/activity.js`,
`lib/approvals.js`, `lib/features/spawn.js`, `lib/jobs.js` (**47**), `lib/restart.js`; the 3 own outbound —
`lib/gateway-permissions.js`, `lib/hermes-models.js`, `lib/hermes-runtime.js`.
The page's cost is **13** = 3 own + 5 importers + 5 server.

**Harness re-point.** 5 test files and 2 tools import a moved module (§7.9).

**The ONE shared file.** `server.js`.

**Hot files.** `lib/jobs.js:47` claimed — three lines from S2's line 44 (§6.2). `server.js` claimed.

**Proof.** The common gate, plus: `GET /api/settings/skills`, `GET /api/settings/permissions`,
`GET /api/models` answer as before; `lib/install/hermes-config.js` loads with its seven importers resolved.

**Stop.** At the path move. No settings-tab change, no `public/app.js`, no hermes-config behaviour.

### 3.5 S5 — WATCH → `lib/watch/`

**Moves.** 11 files, 3,933 lines: `scan.js`, `project.js`, `base-ref.js`, `hosts.js`, `parents.js`, `activity.js`,
`hermes-worktrees.js`, `pool.js`, `projects.js`, `scan-worker.js`, `scheduler.js`. `scan-worker.js` moves **with**
`pool.js`: `pool.js:15` resolves `path.join(HERE, "scan-worker.js")`.

**Edit set** (13 files): `server.js` (9 specifiers); the 8 outside importers — `lib/assistant.js` (`scan.js` at 34),
`lib/child-worktree.js`, `lib/features/spawn.js`, `lib/rebase.js`, `lib/spawn-target.js`, `lib/steward.js`,
`lib/worktree-remove.js`, `lib/worktrees.js`; the 4 own outbound — `lib/activity.js`, `lib/hermes-worktrees.js`,
`lib/project.js`, `lib/scan.js`. The page's cost is **21** = 4 + 8 + 9.

**Harness re-point.** 12 test files and 2 tools import a moved module (§7.9).

**The ONE shared file.** `server.js`.

**Hot files.** `server.js` only. (`lib/assistant.js` is touched at line 34 but is not one of the four.)

**Proof.** The common gate, plus: `GET /api/hosts`, `GET /api/steward`, `GET /api/scan` (`/api/state` carries the
scan) answer; no `lib/scan.js` specifier remains.

**Stop.** At the path move. `scan.js` stays one 410-line file; no pure-part split; no cadence or liveness behaviour.

### 3.6 S6 — LANDING → `lib/landing/`

**Moves.** 15 files, 5,192 lines: `todos.js`, `remote-writes.js`, `descriptions.js`, `locks.js`, `spawn-target.js`,
`child-worktree.js`, `features/descriptions.js`, `features/spawn.js`, `push-guard.js`, `rebase.js`, `refresh-row.js`,
`steward.js`, `worktree-naming.js`, `worktree-remove.js`, `worktrees.js`. `features/` stays a subfolder
(`lib/landing/features/…`).

**Edit set** (15 files): `server.js` (13 specifiers); the 4 outside importers — `lib/assistant/actions.js`,
`lib/completion.js`, `lib/gateway-permissions.js`, `lib/jobs.js` (**29**); the 10 own outbound — `child-worktree`,
`descriptions`, `features/spawn`, `locks`, `rebase`, `spawn-target`, `steward`, `worktree-naming`,
`worktree-remove`, `worktrees`. The page's cost is **27** = 10 + 4 + 13.

**Harness re-point.** 20 test files and 2 tools import a moved module (§7.9).

**The ONE shared file.** `server.js`.

**Hot files.** `lib/jobs.js:29` claimed. `server.js` claimed.

**Proof.** The common gate, plus: `GET /api/todos`, `GET /api/remote-write/state`, `GET /api/steward` answer;
`lib/jobs.test.js` is **not** run here (it moves in S7) but `npm test`'s `test/todos*.test.js` and
`test/worktree-*.test.js` are.

**Stop.** At the path move. `worktrees.js` stays one 771-line file; no landing behaviour, no push-guard change.

### 3.7 S7 — RUNS → `lib/runs/`

**Moves.** 18 files, 7,716 lines: `jobs.js`, `tool-text.js`, `completion.js`, `model-prices.js`, `reasoning.js`,
`session-usage.js`, `branch-policy.js`, `clarify.js`, `jobs/console-lines.js`, `verify-prompt.js`, `approvals.js`,
`deliverables.js`, `merge-prompt.js`, `subagents.js`, `thinking.js`, `tool-calls.js`, `tool-results.js`,
`verify-landed.js`. `jobs/` stays a subfolder (`lib/runs/jobs/console-lines.js`).

**Edit set** (15 files): `server.js` (10 specifiers); the 9 outside importers — `lib/assistant.js`,
`lib/assistant/messages.js`, `lib/hermes-models.js`, `lib/hermes-runtime.js`, `lib/restart.js`,
`lib/worktree-naming.js`, `lib/worktree-remove.js`, `lib/worktrees.js`, and **`lib/jobs.test.js`**; the 5 own
outbound — `approvals`, `completion`, `deliverables`, `jobs`, `reasoning`. The page's cost is **24** = 5 + 9 + 10.

**Harness re-point.** 31 test files and 21 tools import a moved module (§7.9) — the widest harness surface in the
plan, and the reason `tools/` must be grepped here as well as `npm test` run.

**Two path rules that are part of the move.**
- `lib/jobs.js:60` imports `../public/core/steerable.js` — the tree's one deliberate server→client edge. From
  `lib/runs/jobs.js` it becomes `../../public/core/steerable.js`: **rewrite it, never copy the file** and never add
  a second copy under `lib/`.
- `lib/jobs.test.js` **stays at its path** — the file's own header and six docs carry `node lib/jobs.test.js` as the
  command. Its one import at line 29 (`./jobs.js`) becomes `./runs/jobs.js` in this commit. Moving the file would
  change the command everywhere and drop it from readers' habits; leaving it and re-pointing its import keeps the
  harness running.

**The ONE shared file.** `server.js` — and `lib/jobs.js` is the file *moving*, which is why this stage is alone.

**Hot files.** `lib/jobs.js` (moves). `server.js` claimed.

**Proof.** The common gate, plus the harness the suite does not run: **`node lib/jobs.test.js`** (449 lines, a real
panel against a throwaway `PANEL_CONFIG`); `npm test` (169 files); boot answers `GET /api/jobs` and `/api/state`.

**Stop.** At the folder move. `jobs.js` stays one 4,289-line file; **no admission cap**, no `retry429` extraction, no
renamed export.

### 3.8 S8 — ASSISTANT → `lib/assistant/`

**Moves.** 6 root files into the existing folder: `assistant.js` (6,596 lines), `assistants.js`, `attachments.js`,
`charter.js`, `roles.js`, `matrix-bridge.js`. The 12 files already under `lib/assistant/` do **not** move.

**Edit set** (8 files): the 6 movers; `lib/assistant/charter-file.js` — its one `../charter.js` becomes `./charter.js`;
`server.js` (3 specifiers). Inside `assistant.js`, its 12 `./assistant/*.js` imports become `./*.js` and its 7
outbound specifiers gain a level. `lib/task-pipeline-drive.js` imports `assistant/queue.js`, which does not move, so
it is untouched. The page's cost is **11** = 7 own + 1 importer + 3 server.

**Harness re-point.** 33 test files and 12 tools import a moved module (§7.9) — the second-widest, and it overlaps
S7's set in six files (§5.1).

**The ONE shared file.** `server.js`.

**Hot files.** `server.js` only.

**Proof.** The common gate, plus: `GET /api/assistant`, `GET /api/assistant/queue` and `POST /api/assistant/say`
answer; `git grep -n 'lib/assistant.js'` outside `docs/` is empty; `node lib/jobs.test.js` still passes (it drives
the turn path through the moved module).

**Stop.** At the folder move — the last cluster. `assistant.js` stays one 6,596-line file; no turn/queue split; no
behaviour.

### 3.9 S9 — `server.js` wave 2: pipelines, todos, approvals

**Produces.** `lib/routes/pipelines.js` (2 routes, 77 body lines), `lib/routes/todos.js` (2 / 38),
`lib/routes/approvals.js` (4 / 24).

**Edit set.** `server.js`: delete the 8 blocks at **2,674–2,689** (`/api/pipelines` GET) + **2,701–2,761**
(`/api/pipelines` PUT), **4,096–4,122** (approvals), **4,129–4,167** (todos); add 3 entries to the mount table.
No moved helper — this wave has none.

**Entry condition.** The route **seam (wave 0)** is on `origin/main`: `lib/routes/index.js`, the `reply` convention,
the three getters and the one mount are what a group's factory plugs into. If wave 0 is not there, **S9 is
blocked** and the server row lands wave 0 first; wave 1 (assistant) is not required for wave 2.

**The ONE shared file.** `server.js` — the mount table is one hunk every group inserts at.

**Hot files.** `server.js` only.

**Proof.** The server page's §8, in this order: the move is byte-identical with `return sendJson(` → `return reply(`
(grep the new module for `return sendJson(` = **0**); auth counts match the old block (`authorised(req, getConfig()
.token)`); `node --check` each module; `npm test`; boot and request every path the group claims with its method plus
one wrong method; the router's registered paths equal the deleted paths; the boot-time duplicate-claim assertion
does not throw. The three groups may be authored at once and land one at a time.

**Stop.** After the three groups land. Wave 3 (settings) is not started; the seam's `reply` convention is not
revisited.

### 3.10 S10 — `server.js` wave 4: panel-io, projects

**Produces.** `lib/routes/panel-io.js` (7 routes, 164 body lines), `lib/routes/projects.js` (11 / 232).

**Edit set.** `server.js`: panel-io's four regions (seven blocks) — **3,529–3,554** (`/api/paths/open`), **3,561–3,589**
(`/api/scratch/clean`), **3,595–3,610** (`/api/cleanup`), **4,085–4,090** (`/api/deliverables`),
**5,028–5,139** (`/api/open-url`, `/api/deliverables/open`), **5,190–5,210** (`/api/open-path`) — and projects' four
regions — **3,617–3,720** (hosts/steward), **4,062–4,065** (`/api/parents`), **4,466–4,500**
(`/api/repo/first-commit`), **5,633–5,738** (`/api/clone`, `/api/project/new`, `/api/fetch`). Each group moves
exactly **one** route-only helper: `editorFor` (`server.js:107`, one call at 5,196) with panel-io;
`stewardProject` (`:2,371`, two calls at 3,685 and 3,698) with projects.

**The ONE shared file.** `server.js`.

**Hot files.** `server.js` only.

**Proof.** S9's proof, per group, plus: the helper moved with its group has no other caller
(`grep -c 'editorFor(' server.js` = 2 before the move, the definition and the one route; `stewardProject(` = 3).

**Stop.** After the two groups. Wave 5 (worktrees) is not started. `remote-writes` and `landing` keep the five guard
helpers in the spine until their own waves decide otherwise.

---

## 4. The client wave S1 unlocks — eight landings, not numbered

After S1 lands, the remaining nine panel cuts have a worst-case alternation of **6**, and all six belong to the
shell's own blocks. Eight of the nine (everything but `board/board.js`, the shell) can be authored against
different bases, and each touches `public/` only — so they run beside S2–S8 without sharing a file with the library.
They are not numbered stages here because they do not constrain the `server.js` queue; they are the capacity S1
buys.

| New file | Owns (public page §4) | Hot files | Proof | Stop |
|---|---|---|---|---|
| `board/rows.js` | worktrees, remove/lock/rename, child tree, merge control, the six cells, TODO/detail/chips | `public/app.js` | its harnesses + `npm test` + page boot | declarations only |
| `board/cards.js` | conversations/turns, clarify, question box, turn rendering, subagents, approvals dock | `public/app.js` | same | declarations only; **after S1** (13 alternations) |
| `board/jobs.js` | add-agent bar, naming, prompt history, spawn form, `renderJobs`, badges | `public/app.js`, `public/style.css` if a class is renamed | same | declarations only |
| `board/charts.js` | top-N, sliding average, ranked sequence, contexts, ticks, anchor, columns | `public/app.js` | same | declarations only |
| `board/deliverables.js` | the DELIVERABLES button and list | `public/app.js` | same | declarations only; the one panel that needs no counterpart |
| `board/settings.js` | every settings tab but Pipeline/Bundles | `public/app.js` | same | declarations only; the tab wiring stays |
| `board/pipeline.js` | pipeline chip, Settings > Pipeline, Bundles | `public/app.js` | same | declarations only |
| `board/human.js` | HUMAN's landing helpers and rotation | `public/app.js` | same | declarations only |

**Two rules for all eight.**
- Each adds **one** `<script>` line to the 789–835 block, before `/app.js`, in an order the crew agrees **before the
  first one lands**; the block is one hunk and two insertions at the same line conflict.
- Each loads before `app.js` for the same reason as S1: declarations only, no top-level call into `app.js`, the
  `state.*` blocks stay in `app.js`. `board/board.js` — the shell — moves **last**, after all eight, because its
  state literal calls 19 loaders that live in three panels; moving it first is 19 hunks in three panels' regions.

`public/style.css` is claimed by this wave only when a panel **renames** a class; a pure move does not edit it. The
review's class split (917 / 448 / 154) is unconfirmed (§1), so no stage uses it as a denominator.

---

## 5. The collisions that decide the order

### 5.1 ASSISTANT + RUNS, 17 and 16

| Measure | ASSISTANT + RUNS | Next worst |
|---|---:|---|
| Commits touching both clusters | **17** | RUNS + WATCH 10; RUNS + SERVER 9; LANDING + RUNS 9 |
| Hottest module pair across clusters | **`assistant.js` + `jobs.js`, 16** | `project.js` + `scheduler.js` 9; `activity.js` + `scheduler.js` 8 |
| Import edges | 3 (ASSISTANT → RUNS) | LANDING → WATCH 9 |
| Shared seam | job admission: `queue.js` and `assistant.js` (ASSISTANT), `jobs.js` (RUNS), `server.js` (SERVER) | — |

Re-read at this tip: the window is still 260 commits, and the 28-pair matrix is identical cell for cell. **16 is the
hottest pair that crosses a cluster boundary; 17 is the tree's hottest pair, and both its files are inside
ASSISTANT** (`assistant.js` + `assistant/config.js`). The conclusion does not change: S7 and S8 are one change
wearing two names, and **they are never in flight together**. S7 lands first; S8 cuts its branch from the tip S7
landed on, so `assistant.js`'s specifiers to `../runs/jobs.js` are final before it edits.

The harness trees collide too: **31** test files import a RUNS mover and **33** import an ASSISTANT mover, and six
import both — `assistant-attachment-spawn`, `assistant-event-wakes`, `element-assist`, `exited-wake`, `queue-sweep`,
`settle-wake`. A parallel S7/S8 would meet in those six files even if the modules never touched.

### 5.2 Eight `jobs.create` calls across four clusters

| Cluster | Where | What it does |
|---|---|---|
| ASSISTANT | `lib/assistant.js:3,733`, `:5,778` | the press path: the queue's gate again, then create |
| LANDING | `lib/features/spawn.js:236`, `:270` | the row's own spawn path calls `create` directly |
| SERVER | `server.js:4,459` (`/api/agents`), `:5,468` (merge), `:5,600` (verify-landed) | three route blocks, three option sets |
| SERVER (helper) | `server.js:1,270` in `startThreadReply` | the reply route and the stage-timer wake share one create |
| RUNS | `lib/jobs.js:2,375` `async create(opts = {})` | accepts the turn — **no panel-side concurrency cap** |

The only admission limit in force is the gateway's concurrent-run cap, observed as a 429 and held. So a change to
"who may start" is a four-cluster landing today. **No stage in this plan changes admission.** S7 moves the
definition; S8 and S6 move two call sites each as part of a file move (path only); the three server route call sites
move in waves 7–8, which are not staged here. An admission cap is its **own row after S8**, and it is the one change
that must rebase around all four clusters at once.

### 5.3 The four hot files

| Stage | `server.js` | `public/app.js` | `public/style.css` | `lib/jobs.js` |
|---|:--:|:--:|:--:|:--:|
| S1 console | — | **deletes** | — | — |
| S2 PIPELINES | 3 specifiers | — | — | **1 line (44)** |
| S3 SERVER | 9 specifiers | — | — | — |
| S4 INSTALL | 5 specifiers | — | — | **1 line (47)** |
| S5 WATCH | 9 specifiers | — | — | — |
| S6 LANDING | 13 specifiers | — | — | **1 line (29)** |
| S7 RUNS | 10 specifiers | — | — | **moves** |
| S8 ASSISTANT | 3 specifiers | — | — | — |
| S9 wave 2 | **blocks + mount** | — | — | — |
| S10 wave 4 | **blocks + mount** | — | — | — |

Three of the four are claimed by this plan: `server.js` by nine stages, `lib/jobs.js` by four (three one-line
specifier rewrites and one move), `public/app.js` by S1. **`public/style.css` is not claimed by any staged stage** —
a pure move renames no class. It is the client wave's file (§4), and a panel that renames a class claims it by hand.
A hot file is claimed for the **whole landing**, not the edit: a stage that holds `lib/jobs.js` for one line still
serialises against every other stage that touches it.

### 5.4 The hunks no move removes

- **`server.js`'s mount table.** Every extraction inserts at the same place. The deletions merge; that hunk does not,
  which is why the server surface lands one group at a time.
- **`public/index.html`'s 789–835 script block.** Every panel file adds one line in the same block.
- **`package.json`.** Every landing, of any surface, bumps it. The pre-push hook refuses a branch whose number is not
  above `origin/main`'s, so **landing concurrency is 1** and the queue is the real schedule.
- **cards ↔ console's 13 alternations.** Until S1 lands, those two cuts conflict line-by-line even though they are
  different files.
- **`lib/jobs.js`'s import block at 29, 44, 47.** Three cluster stages rewrite three lines of one block, 15 and 3
  lines apart. That is why `jobs.js` is hot even though only S7 moves it.

---

## 6. What can run at the same time

"Together" means **authored in separate worktrees at the same time** without one worker's decision changing the
other's signature. It never means landed together: the version gate serialises every landing (§5.4).

### 6.1 The pair table

| Pair | Together? | What decides it |
|---|---|---|
| **S1 + any of S2–S10** | **yes** | `public/` vs `lib/` + `server.js`; no shared file. The best cross-surface pair available. |
| **S2 + S3** | **yes** | 0 co-change; both touch `server.js`'s import block at disjoint lines. S3 lands after S2, rebased. |
| **S2 + S4** | **yes, with a rebase** | 0 co-change, but both edit `lib/jobs.js` at **44** and **47** — three lines apart inside one import block. S4's branch is likely to conflict there; land S2 first. |
| **S2 + S5** | **yes** | 0 co-change; `server.js` and `lib/assistant.js` at different lines. |
| **S2 + S6** | **yes** | 0 co-change; `lib/jobs.js` 44 vs 29. |
| S3 + S4 | **no** | Both rewrite `server.js`'s import block; the only blessed neighbour is PIPELINES' zero co-change. |
| S3 + S5 | **no** | SERVER + WATCH **8** co-change commits. |
| S4 + S5 | **no** | INSTALL + WATCH 1, but both rewrite the same import block. |
| **S5 + S6** | **yes, LANDING second** | 4 co-change commits, 9 import edges. S6 cuts its branch after S5 has pushed its move, so the nine WATCH specifiers are already final. |
| S6 + S7 | **no** | LANDING + RUNS **9**; S7's `jobs.js` imports LANDING's modules. |
| **S7 + S8** | **NO** | **17** commits across the clusters, **16** on `assistant.js` + `jobs.js`; one change wearing two names. |
| Any of S2–S8 + S9/S10 | **no** | Both edit `server.js` — the import block vs block deletions + the mount table. |
| S9 + S10 | **no** | Same mount table, and wave 4 assumes wave 2's convention has landed. |
| Three groups inside S9 | **yes** | 8 routes, 139 body lines, disjoint regions, no moved helper. |
| Two groups inside S10 | **yes** | One route-only helper each, disjoint regions. |
| Any two landings, any stages | **no** | `package.json` — the version gate. |

### 6.2 The largest start

**S1 + S2 + one of S3 / S4 / S5 / S6 = three authors**, four queued landings. The best second partner is **S3**
(import block only, disjoint lines) or **S5** (different files); S4 is the pair most likely to conflict in
`jobs.js`. Nothing else joins that set: every other `lib/` stage edits the same `server.js` block, and S9/S10 are
blocked on the route seam and on `server.js` itself.

Once **S1** lands, the eight client panels (§4) can all be authored, one file each, alongside S2–S8 — but their
landings queue behind the library sequence for `package.json` and share `public/app.js` with each other, so the
**authoring** cap becomes ten (two library stages plus the eight panels) and the **landing** cap stays one. That is
the whole return on doing the console first.

### 6.3 What can never run together

- **S7 and S8** — 17/16. One worker, one order.
- **S9 or S10 with any `lib/` stage** — `server.js` on both sides.
- **S9 and S10** — the mount table and the wave order.
- **Any two landings** — `package.json`.
- **cards before console** — 13 alternations, not a file-sharing rule but a line-sharing one.

---

## 7. The proof every stage owes

Every stage runs this gate before it pushes. Stage-specific proofs in §3 are **additional**, not alternatives.

**7.1 The move is pure.** Paste this beside the branch and run it per moved file; it drops top-level `import …;`
statements from the base version and the new one and compares the rest byte for byte.

```js
// node pure-move.mjs <base-rev> <old-path> <new-path>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const [base, oldPath, newPath] = process.argv.slice(2);
function stripImports(src) {
  const out = []; let skipping = false;
  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (!skipping && /^[ \t]*import\b/.test(line)) { if (/;[ \t]*$/.test(line)) continue; skipping = true; continue; }
    if (skipping) { if (/;[ \t]*$/.test(line)) skipping = false; continue; }
    out.push(line);
  }
  return out.join("\n");
}
const a = stripImports(execFileSync("git", ["show", `${base}:${oldPath}`], { encoding: "utf8" }));
const b = stripImports(readFileSync(newPath, "utf8"));
if (a !== b) {
  const al = a.split("\n"), bl = b.split("\n"), i = al.findIndex((l, n) => l !== bl[n]);
  console.log(`DIFFERS at body line ${i + 1}: ${JSON.stringify(al[i])} vs ${JSON.stringify(bl[i])}`);
  process.exit(1);
}
console.log(`same body: ${oldPath} -> ${newPath} (${a.split("\n").length} lines)`);
```

`git diff -M --color-moved=blocks` is the human check beside it: every moved file is a rename, and no hunk outside an
import line.

**7.2 Every relative specifier resolves.** Static, no execution, no side effects:

```js
// node specifiers.mjs lib
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p); else if (/\.(js|cjs|mjs)$/.test(e)) files.push(p.replace(/\\/g, "/"));
  }
})(process.argv[2] ?? "lib");
const pat = /import\s+(?:[^;"']*?\bfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
let bad = 0, edges = 0;
for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(pat)) {
  const spec = m[1] ?? m[2];
  if (!spec.startsWith(".")) continue;
  edges++;
  let t = normalize(join(dirname(f), spec));
  if (existsSync(t) && statSync(t).isDirectory()) t = join(t, "index.js");
  if (!existsSync(t)) { bad++; console.log(`${f}: ${spec} -> MISSING`); }
}
console.log(`${files.length} files, ${edges} relative specifiers, ${bad} unresolved`);
process.exit(bad ? 1 : 0);
```

At the base it prints `89 files, 144 relative specifiers, 0 unresolved`. A move that leaves one behind prints it.

**7.3 No old path remains.** `git grep -n '<old-path>' -- ':!docs'` is empty for every moved file (docs are history,
not code; do not rewrite review pages).

**7.4 The suite.** `npm test` — 169 files, `node --test --test-concurrency=4 test/*.test.js`. A red test in a
pure-move stage is a move error, not a design question.

**7.5 Boot and smoke.** `tools/panel-testkit.mjs`'s `startPanel({ root })` is the ready-made sandbox (its own port,
own `PANEL_CONFIG`, own `jobsFile`); boot the panel and request the stage's paths with their methods plus one wrong
method. Every moved path answers with its old status; none 404s or hits `serveStatic`.

**7.6 The harness the suite does not run.** `lib/jobs.test.js` (`node lib/jobs.test.js`) is outside `npm test`'s
glob; S7 runs it, and S8 runs it again because it drives the turn path through the moved module. A stage that skips
it leaves the re-attach path unproven.

**7.7 The version gate.** The bump belongs in the same PR as the change (`docs/versioning.md`). `node
tools/version.mjs check` before the push; the pre-push hook runs it again.

**7.8 The docs that name a path.** A stage that moves a file updates every **current** doc that names the old path —
not the review pages under `docs/reviews/`, which are snapshots. S7's `lib/jobs.test.js` command is the named case.

**7.9 The harnesses that import a moved module.** The suite catches test imports: a stale specifier is
`ERR_MODULE_NOT_FOUND`, not a skip. `tools/` is **not** in `npm test`, so it is grepped separately and re-pointed in
the move commit. Count per stage with §7.2's checker pointed at `test/` and at `tools/`:

| Stage | Test files importing a mover | Tools importing a mover |
|---|---:|---:|
| S2 PIPELINES | 10 | 3 |
| S3 SERVER | 16 | 4 |
| S4 INSTALL | 5 | 2 |
| S5 WATCH | 12 | 2 |
| S6 LANDING | 20 | 2 |
| S7 RUNS | 31 | 21 |
| S8 ASSISTANT | 33 | 12 |

A stage whose harness count moves because another stage landed first re-counts it under Stage 0; the table is the
base's number, not a promise.

---

## 8. Rollback

Each stage is one landing, so its rollback is **revert its squash-merge commit**. Because every stage is a pure
move — same bodies, same exports, different specifiers — a revert restores the old paths and the old import lines
with no behavioural residue. Two exceptions:
- **S1** also deletes from `public/app.js`; the revert restores the declarations, and the `index.html` line goes with
  it.
- **S7** also re-points `lib/jobs.test.js`; the revert restores `./jobs.js`.

A stage that cannot be reverted alone (because a later stage already landed on its paths) is not rolled back; the
later stage is reverted first. That is the reason the order is a queue.

---

## 9. Execution order

| # | Task | Commit? | Depends on | Acceptance |
|---:|---|---|---|---|
| 1 | Stage 0 rebase on the current tip | no | — | branch contains `origin/main`; anchors re-read; shared file unclaimed |
| 2 | S1 console → `public/board/console.js` | yes | 1 | no duplicate names; 16 harnesses re-pointed; page boots clean; `npm test` |
| 3 | S2 PIPELINES | yes | 1 | pure-move check; specifiers resolve; `npm test`; boot |
| 4 | S3 SERVER | yes | 3 | same + `node --check` the `.cjs`; `GET /api/build` |
| 5 | S4 INSTALL | yes | 1 | same + `GET /api/models` |
| 6 | S5 WATCH | yes | 1 (or 5 for S6) | same + `GET /api/hosts` |
| 7 | S6 LANDING | yes | 6 | same + `GET /api/todos` |
| 8 | S7 RUNS | yes | 7 | same + `node lib/jobs.test.js` |
| 9 | S8 ASSISTANT | yes | 8 | same + `GET /api/assistant/queue` |
| 10 | S9 wave 2 | yes | wave 0 on main; 9 | 8 routes answer; zero `return sendJson(`; duplicate-claim boot |
| 11 | S10 wave 4 | yes | 10 | 18 routes answer; one helper per group |

Rows 3–9 are the **landing order**, not the authoring order: a worker may author ahead of its row when §6 allows it,
but it lands in this sequence. The **Depends on** column names a mechanism, never the queue.

**The client wave (§4)** may start once task 2 has landed, and runs beside tasks 3–9; its eight landings queue behind
the library sequence.

**Not staged here, and why.** The server's waves **0, 1, 3, 5–9** are single-worker waves: each installs a
convention, moves a helper, or edits the largest block, and a second worker in the same wave would be guessing at the
first worker's signature. Wave 0 is **S9's entry condition**; if it is absent when S9 starts, S9 stops. The
client's shell (`board/board.js`) moves after the eight panels (§4). A panel-side admission cap is its own
four-cluster row after S8 (§5.2).

---

## 10. What this plan did not do

- **No code moved.** Every number is at `f0b52a3`; this landing touches the plan, the changelog and `package.json`.
- **No trial merge.** "Together" is co-change commits plus import edges, not a simulated merge. The one line-level
  check that goes beyond the review is `lib/jobs.js`'s 29/44/47 spacing (§5.4), and it was read, not merged.
- **No test run, no boot** for this document. `npm test` is each stage's gate, not this page's.
- **No re-count of the client panel unit/line table**, and no reproduction of the stylesheet's 917/448/154 split;
  both are marked unconfirmed in §1 and neither orders a stage.
- **No owner, ticket or date.** Stage 0's PR-body line is the handoff; the panel's queue decides who runs next.
